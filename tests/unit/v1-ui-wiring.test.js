'use strict';

/**
 * UI wiring regression tests for the V1 professionalization work.
 *
 * These read the real renderer/preload/HTML files so a missing translation key,
 * a dialog with no matching element, or a preload API that was not exposed fails
 * here without needing Electron.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { translate, LOCALE_VALUES } = require('../../src/shared/i18n');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'preload.js'), 'utf8');

const SITE_HTML = fs.readFileSync(path.join(REPO_ROOT, 'site', 'index.html'), 'utf8');
const SITE_JS = fs.readFileSync(path.join(REPO_ROOT, 'site', 'site.js'), 'utf8');

test('every data-i18n key in index.html resolves in every locale', () => {
  const keys = new Set();
  for (const m of INDEX_HTML.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
  for (const m of INDEX_HTML.matchAll(/data-i18n-attr="[^"]*?:([^"]+)"/g)) keys.add(m[1]);

  assert.ok(keys.size > 0, 'index.html must contain translatable nodes');
  for (const locale of LOCALE_VALUES) {
    for (const key of keys) {
      const value = translate(locale, key);
      assert.notEqual(value, key, `missing ${locale} translation for ${key}`);
      assert.ok(value && value.length, `empty ${locale} translation for ${key}`);
    }
  }
});

test('the new case-header buttons and their dialogs exist in index.html', () => {
  const ids = [
    'btn-search', 'dialog-search', 'case-search-input', 'btn-case-search', 'case-search-results',
    'btn-findings', 'dialog-findings', 'findings-list', 'finding-title', 'finding-observation',
    'finding-at', 'btn-add-finding',
    'report-revisions', 'btn-uyap',
  ];
  for (const id of ids) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
});

test('the renderer binds the new UI entry points', () => {
  for (const binding of ["'#btn-search'", "'#btn-findings'", "'#btn-uyap'", "'#btn-case-search'", "'#btn-add-finding'"]) {
    assert.ok(RENDERER_JS.includes(`bind(${binding}`), `renderer.js must bind ${binding}`);
  }
});

test('the preload exposes the new professionalization APIs', () => {
  for (const namespace of ['findings:', 'searchIndex:', 'ai:', 'uyap:']) {
    assert.ok(PRELOAD_JS.includes(namespace), `preload must expose ${namespace}`);
  }
  for (const method of ['revisions:', 'setRevision:', 'page:']) {
    assert.ok(PRELOAD_JS.includes(method), `preload must expose ${method}`);
  }
});

test('the preload exposes the analysis-layer APIs', () => {
  for (const namespace of ['passages:', 'claims:', 'sources:', 'verifications:', 'analysis:']) {
    assert.ok(PRELOAD_JS.includes(namespace), `preload must expose ${namespace}`);
  }
  for (const method of ['context:', 'create:', 'update:', 'remove:']) {
    assert.ok(PRELOAD_JS.includes(method), `preload must expose ${method}`);
  }
});

test('the analysis view is wired to the analysis IPC APIs', () => {
  for (const id of ['passages-list', 'claims-list', 'sources-list', 'passages-empty', 'claims-empty', 'sources-empty']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
  for (const callExpr of ['api.passages.list', 'api.claims.list', 'api.sources.list', 'api.passages.create', 'api.claims.create', 'api.sources.create']) {
    assert.ok(RENDERER_JS.includes(callExpr), `renderer.js must call ${callExpr}`);
  }
  assert.ok(RENDERER_JS.includes('markPassage'), 'renderer.js must define the mark-critical action');
});

// --------------------------------------------------- technical + operations
test('the technical view lists run records from the real runs API', () => {
  assert.ok(INDEX_HTML.includes('id="technical-runs"'), 'index.html must contain #technical-runs');
  assert.ok(INDEX_HTML.includes('data-i18n="technical.runsHeading"'), 'technical view must label the run section');
  assert.ok(RENDERER_JS.includes('api.cases.runs'), 'renderer.js must read runs via api.cases.runs');
  assert.ok(RENDERER_JS.includes('function renderRuns'), 'renderer.js must define renderRuns');
});

test('the operations centre is wired to real runs and honest cancellation', () => {
  for (const id of ['btn-operations', 'dialog-operations', 'ops-list', 'btn-ops-cancel', 'btn-ops-refresh']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
  assert.ok(RENDERER_JS.includes('function openOperations'), 'renderer.js must define openOperations');
  assert.ok(RENDERER_JS.includes('function renderOperations'), 'renderer.js must define renderOperations');
  // The cancel control must be shown only when a transcription is genuinely busy.
  assert.match(RENDERER_JS, /btn-ops-cancel[\s\S]{0,160}state\.busy/, 'cancel must be gated on real state.busy');
});

test('Ctrl+K opens the case search palette and search hits navigate to the segment', () => {
  assert.match(RENDERER_JS, /key\.toLowerCase\(\) === 'k'[\s\S]{0,120}openCaseSearch/, 'Ctrl+K must open case search');
  assert.ok(RENDERER_JS.includes('function openSearchHit'), 'renderer.js must define openSearchHit');
  assert.match(RENDERER_JS, /openSearchHit[\s\S]{0,600}scrollSegmentIntoView/, 'a search hit must scroll to its segment');
});

// --------------------------------------------------------- AI + delivery
test('the local draft assist is opt-in, offline and never auto-writes the report', () => {
  for (const id of ['chk-ai-assist', 'btn-report-ai-draft', 'report-ai-status', 'report-ai-draft']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
  // Enabling it is an explicit, persisted preference (never on by default).
  assert.ok(RENDERER_JS.includes("api.preferences.set('ai_assist_enabled'"), 'the assist toggle must persist its choice');
  assert.match(RENDERER_JS, /setAiAssist[\s\S]{0,200}ai_assist_enabled/, 'setAiAssist must write the preference');
  // Collecting a draft only displays it; it must not call report.save.
  const collectFn = RENDERER_JS.slice(
    RENDERER_JS.indexOf('async function collectAiDraft'),
    RENDERER_JS.indexOf('async function collectAiDraft') + 1600
  );
  assert.ok(!collectFn.includes('api.report.save'), 'collecting a draft must never save into the report');
});

test('the delivery surface links to the checklist and UYAP-ready output', () => {
  for (const id of ['delivery-checklist', 'delivery-outputs', 'btn-delivery-uyap']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
  assert.ok(RENDERER_JS.includes('function openDelivery'), 'renderer.js must define openDelivery');
  assert.ok(RENDERER_JS.includes('function refreshDelivery'), 'renderer.js must define refreshDelivery');
  assert.ok(RENDERER_JS.includes('api.report.checklist'), 'the delivery checklist must reuse the real checklist API');
});

// --------------------------------------------------------------- public site
test('the public site is Turkish-first with an optional English block', () => {
  assert.match(SITE_HTML, /<html lang="tr">/, 'the site default language must be Turkish');
  assert.match(SITE_HTML, /data-lang-block="tr"/, 'a Turkish content block must exist');
  assert.match(SITE_HTML, /data-lang-block="en"[^>]*hidden/, 'the English block must be hidden by default');
  assert.match(SITE_HTML, /data-set-lang="tr"/, 'a TR toggle must exist');
  assert.match(SITE_HTML, /data-set-lang="en"/, 'an EN toggle must exist');
  assert.ok(/Modeller|Transkripsiyon|Rapor|Gizlilik/.test(SITE_HTML), 'Turkish copy must be present');
});

test('the site never hard-codes a stale release version', () => {
  assert.ok(!/0\.1\.0/.test(SITE_HTML), 'site html must not reference 0.1.0');
  assert.ok(!/0\.1\.0/.test(SITE_JS), 'site.js must not reference 0.1.0');
  // The model-pack link must be resolved from release data, not a fixed name.
  assert.ok(
    !/ModelPack-\d+\.\d+\.\d+/.test(SITE_JS),
    'site.js must not hard-code a ModelPack version'
  );
  assert.match(SITE_JS, /releases\/latest/, 'site.js must use the stable latest/download path');
});

test('the site documents the professionalization scope and download assets', () => {
  for (const topic of ['56.12', '56.11', 'UYAP', 'SHA256SUMS', 'ModelPack', 'SHA-256']) {
    assert.ok(SITE_HTML.includes(topic) || SITE_JS.includes(topic), `site must mention ${topic}`);
  }
  for (const id of ['download-btn', 'download-portable', 'download-modelpack', 'release-version']) {
    assert.ok(SITE_HTML.includes(`id="${id}"`), `site must contain #${id}`);
  }
});


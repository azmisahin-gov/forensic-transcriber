'use strict';

/**
 * Expert studio shell regression tests (P1 professionalization, phase 2).
 *
 * The shell turns the eight-step workflow into an interactive router: each step
 * points at a view and only one view is visible. These read the real markup and
 * renderer so a missing view, an unmapped step, or a dangling id fails here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

const VIEWS = ['assignment', 'studio', 'analysis', 'technical'];

test('the case area exposes every step view inside a single router container', () => {
  assert.ok(INDEX_HTML.includes('id="case-views"'), 'a #case-views router container must exist');
  for (const view of VIEWS) {
    assert.ok(INDEX_HTML.includes(`id="view-${view}"`), `#view-${view} must exist`);
    assert.ok(INDEX_HTML.includes(`class="case-view-page`), `view-${view} must use the case-view-page class`);
  }
});

test('the studio is the default visible view and the others start hidden', () => {
  assert.match(INDEX_HTML, /id="view-studio" class="case-view-page"/, 'studio must not be hidden by default');
  for (const view of ['assignment', 'analysis', 'technical']) {
    assert.match(INDEX_HTML, new RegExp(`id="view-${view}" class="case-view-page hidden"`), `${view} must start hidden`);
  }
});

test('every workflow step maps to a real view', () => {
  const views = [...RENDERER_JS.matchAll(/view: '([a-z]+)'/g)].map((m) => m[1]);
  assert.equal(views.length, 8, 'all eight workflow steps must declare a view');
  for (const v of views) assert.ok(VIEWS.includes(v), `unknown view in workflow step: ${v}`);
});

test('the renderer routes views and keeps the studio as the fallback', () => {
  assert.ok(RENDERER_JS.includes("const known = ['assignment', 'studio', 'analysis', 'technical']"), 'the router must list the known views');
  assert.ok(RENDERER_JS.includes("page.id !== `view-${state.activeView}`"), 'the router must toggle by view id');
  assert.ok(RENDERER_JS.includes("setActiveView('studio')"), 'opening a case must reset to the studio');
});

test('workflow steps are keyboard reachable', () => {
  assert.ok(RENDERER_JS.includes('li.tabIndex = 0'), 'steps must be focusable');
  assert.ok(RENDERER_JS.includes("e.key === 'Enter' || e.key === ' '"), 'steps must respond to Enter/Space');
});

test('analysis and technical pages declare their real containers', () => {
  for (const id of ['passages-list', 'claims-list', 'sources-list', 'technical-body']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `#${id} must exist`);
  }
  assert.ok(RENDERER_JS.includes('function renderAnalysis()'), 'renderAnalysis must exist');
  assert.ok(RENDERER_JS.includes('function renderTechnical()'), 'renderTechnical must exist');
});

test('the technical page states the scope boundary in both locales', () => {
  const i18n = fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'i18n.js'), 'utf8');
  const trKeys = [...i18n.matchAll(/'technical\.lede': '([^']+)'/g)].map((m) => m[1]);
  assert.ok(trKeys.length >= 2, 'technical.lede must be defined in both locales');
  assert.match(trKeys[0], /hukuki nitelendirme/i, 'the TR scope boundary must mention no legal characterization');
});

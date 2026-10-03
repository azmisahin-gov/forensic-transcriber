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

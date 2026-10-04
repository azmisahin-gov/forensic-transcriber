'use strict';

/**
 * Design-system regression tests (P1 professionalization, phase 1).
 *
 * These read the real stylesheet and the real theme lib so a missing theme
 * token, an unvalidated stored value, or a component still hard-coding a dark
 * hex would fail without needing Electron.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STYLES = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
const theme = require(path.join(REPO_ROOT, 'src', 'renderer', 'lib', 'theme.js'));

test('the stylesheet defines a light default and a dark override', () => {
  assert.match(STYLES, /:root\[data-theme="light"\]/, 'a light theme block must exist');
  assert.match(STYLES, /:root\[data-theme="dark"\]/, 'a dark theme block must exist');
  // Light must also be the bare :root default so the first paint is light.
  assert.match(STYLES, /:root,\s*\n:root\[data-theme="light"\]/, 'light must be the default :root');
});

test('the light theme is actually light, not a copy of dark', () => {
  const lightBlock = STYLES.slice(STYLES.indexOf('data-theme="light"'), STYLES.indexOf('data-theme="dark"'));
  const darkBlock = STYLES.slice(STYLES.indexOf('data-theme="dark"'));
  assert.match(lightBlock, /--bg: #f4f6fb/, 'light background must be light');
  assert.match(darkBlock, /--bg: #0d1117/, 'dark background must be dark');
});

test('all three accents are defined for both themes', () => {
  for (const accent of ['blue', 'teal', 'indigo']) {
    assert.match(STYLES, new RegExp(`data-accent="${accent}"`), `accent ${accent} must be defined`);
  }
  assert.match(STYLES, /\[data-theme="dark"\]\[data-accent="teal"\]/, 'teal must have a dark variant');
  assert.match(STYLES, /\[data-theme="dark"\]\[data-accent="indigo"\]/, 'indigo must have a dark variant');
});

test('status colors are tokenized so a theme swap does not leave dark hexes', () => {
  for (const token of ['--green-bg', '--amber-bg', '--red-bg', '--sel-bg', '--mark-bg']) {
    assert.match(STYLES, new RegExp(`${token}:`), `${token} must be defined`);
  }
  // The old dark-only status hexes must not survive in component rules (they are
  // allowed only inside the theme token blocks, where they define the dark set).
  const componentRules = STYLES.slice(STYLES.indexOf('* { box-sizing'));
  for (const stale of ['#12251b', '#2a2110', '#2a1616', '#17293d', '#4a3a00', '#ffb4b4', '#ffcf80', '#9fe8c1', '#7ce0ab', '#3a1d1d', '#101821', '#0e1620', '#0b1219']) {
    assert.equal(componentRules.includes(stale), false, `stale dark hex ${stale} must be replaced by a token in component rules`);
  }
});

test('index.html defaults to the light theme and exposes the switches', () => {
  assert.match(INDEX_HTML, /<html lang="tr" data-theme="light" data-accent="blue">/, 'light/blue must be the default');
  for (const id of ['btn-theme-light', 'btn-theme-dark', 'pref-controls']) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `index.html must contain #${id}`);
  }
  for (const accent of ['blue', 'teal', 'indigo']) {
    assert.ok(INDEX_HTML.includes(`data-accent="${accent}"`), `index.html must expose the ${accent} accent`);
  }
});

test('the renderer binds the theme and accent switches and persists them', () => {
  assert.ok(RENDERER_JS.includes("bind('#btn-theme-light'"), 'light switch must be bound');
  assert.ok(RENDERER_JS.includes("bind('#btn-theme-dark'"), 'dark switch must be bound');
  assert.ok(RENDERER_JS.includes("preferences.set('theme'"), 'theme must be persisted');
  assert.ok(RENDERER_JS.includes("preferences.set('accent'"), 'accent must be persisted');
});

test('theme lib normalizes unknown stored values instead of trusting them', () => {
  assert.equal(theme.normalizeTheme('light'), 'light');
  assert.equal(theme.normalizeTheme('dark'), 'dark');
  assert.equal(theme.normalizeTheme('solarized'), 'light', 'unknown theme falls back to light');
  assert.equal(theme.normalizeTheme(undefined), 'light');
  assert.equal(theme.normalizeAccent('teal'), 'teal');
  assert.equal(theme.normalizeAccent('magenta'), 'blue', 'unknown accent falls back to blue');
});

test('theme lib applies data attributes to the document root', () => {
  const attrs = {};
  const stub = { setAttribute: (k, v) => { attrs[k] = v; } };
  const applied = theme.apply(stub, { theme: 'dark', accent: 'indigo' });
  assert.deepEqual(applied, { theme: 'dark', accent: 'indigo' });
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(attrs['data-accent'], 'indigo');
});

test('theme lib coerces a hostile stored value before writing it', () => {
  const attrs = {};
  const stub = { setAttribute: (k, v) => { attrs[k] = v; } };
  theme.apply(stub, { theme: '"><script>', accent: 'nope' });
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(attrs['data-accent'], 'blue');
});

test('the top bar keeps a dark surface in both themes', () => {
  assert.match(STYLES, /--topbar-bg: linear-gradient\(135deg, #0f172a, #1e293b\)/, 'light theme top bar must stay dark');
  assert.match(STYLES, /--topbar-bg: #131b24/, 'dark theme top bar must be defined');
});

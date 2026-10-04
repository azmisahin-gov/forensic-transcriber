'use strict';

/**
 * Guards against the renderer load-order regression that shipped in v0.1.1:
 * `src/renderer/index.html` never loaded `shared/constants.js`, so the browser
 * global `FT_CONSTANTS` was undefined and `transcript-store.js` threw at load
 * time, leaving the whole renderer dead.
 *
 * These tests read the real `index.html` and evaluate the real UMD wrappers, so
 * a wrong <script> order or a missing global fails here without needing Electron.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML = path.join(REPO_ROOT, 'src', 'renderer', 'index.html');

function scriptSources() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

test('index.html loads the renderer scripts in dependency order', () => {
  const srcs = scriptSources();
  const indexOf = (needle) => srcs.findIndex((s) => s.endsWith(needle));

  const constants = indexOf('constants.js');
  const transcriptStore = indexOf('transcript-store.js');
  const renderer = indexOf('renderer.js');

  assert.ok(constants >= 0, 'index.html must load shared/constants.js (defines FT_CONSTANTS)');
  assert.ok(transcriptStore >= 0, 'index.html must load lib/transcript-store.js');
  assert.ok(renderer >= 0, 'index.html must load renderer.js');

  assert.ok(constants < transcriptStore, 'constants.js must load before transcript-store.js');
  assert.ok(transcriptStore < renderer, 'transcript-store.js must load before renderer.js');
  assert.ok(constants < renderer, 'constants.js must load before renderer.js');
});

test('every file referenced by index.html exists on disk', () => {
  const rendererDir = path.dirname(INDEX_HTML);
  for (const src of scriptSources()) {
    const resolved = path.resolve(rendererDir, src);
    assert.ok(fs.existsSync(resolved), `referenced script is missing: ${src}`);
  }
});

/**
 * Evaluate a renderer lib the way the browser does: as a classic script with no
 * CommonJS `module`, in a fresh context that may or may not define FT_CONSTANTS.
 */
function runAsBrowserScript(file, globals) {
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { ...globals };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return sandbox;
}

test('transcript-store fails with an explicit message when FT_CONSTANTS is missing', () => {
  const file = path.join(REPO_ROOT, 'src', 'renderer', 'lib', 'transcript-store.js');
  assert.throws(
    () => runAsBrowserScript(file, {}),
    (err) => /requires FT_CONSTANTS/.test(err.message),
    'a missing FT_CONSTANTS must produce an explicit load-order error'
  );
});

test('transcript-store loads in the browser when FT_CONSTANTS is present', () => {
  const constantsFile = path.join(REPO_ROOT, 'src', 'shared', 'constants.js');
  const storeFile = path.join(REPO_ROOT, 'src', 'renderer', 'lib', 'transcript-store.js');

  const afterConstants = runAsBrowserScript(constantsFile, {});
  assert.ok(afterConstants.FT_CONSTANTS, 'constants.js must define FT_CONSTANTS');

  const afterStore = runAsBrowserScript(storeFile, { FT_CONSTANTS: afterConstants.FT_CONSTANTS });
  assert.ok(afterStore.FT_TRANSCRIPT_STORE, 'transcript-store.js must define FT_TRANSCRIPT_STORE');
  assert.equal(typeof afterStore.FT_TRANSCRIPT_STORE.TranscriptStore, 'function');

  const store = new afterStore.FT_TRANSCRIPT_STORE.TranscriptStore([]);
  assert.equal(store.segments.length, 0);
});

test('constants.js defines the globals the renderer depends on', () => {
  const constantsFile = path.join(REPO_ROOT, 'src', 'shared', 'constants.js');
  const sandbox = runAsBrowserScript(constantsFile, {});
  const c = sandbox.FT_CONSTANTS;
  assert.ok(c, 'FT_CONSTANTS must be defined');
  for (const key of ['SEGMENT_STATUS', 'UNCLEAR_PLACEHOLDER', 'IPC', 'SUPPORTED_EXTENSIONS', 'THEMES', 'ACCENTS']) {
    assert.ok(c[key], `FT_CONSTANTS.${key} must be present`);
  }
  assert.equal(c.SEGMENT_STATUS.AUTOMATIC, 'AUTOMATIC');
  assert.equal(c.THEMES.LIGHT, 'light');
  assert.equal(c.THEMES.DARK, 'dark');
  assert.deepEqual([...c.ACCENT_VALUES], ['blue', 'teal', 'indigo']);
});

test('the other renderer libs define their globals in the browser', () => {
  const libs = [
    ['lib/format.js', 'FT_FORMAT'],
    ['lib/audio.js', 'FT_AUDIO'],
    ['lib/waveform.js', 'FT_WAVEFORM'],
    ['lib/search.js', 'FT_SEARCH'],
    ['lib/shortcuts.js', 'FT_SHORTCUTS'],
    ['lib/theme.js', 'FT_THEME'],
  ];
  for (const [rel, globalName] of libs) {
    // theme.js validates against FT_CONSTANTS the same way transcript-store.js
    // does; load the real constants first so the UMD wrapper resolves.
    const globals = rel === 'lib/theme.js'
      ? { FT_CONSTANTS: runAsBrowserScript(path.join(REPO_ROOT, 'src', 'shared', 'constants.js'), {}).FT_CONSTANTS }
      : {};
    const sandbox = runAsBrowserScript(path.join(REPO_ROOT, 'src', 'renderer', rel), globals);
    assert.ok(sandbox[globalName], `${rel} must define ${globalName}`);
  }
});

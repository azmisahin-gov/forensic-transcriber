'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES,
  buildUpdaterConfig,
  isUpdaterArtifact,
  isModelArtifact,
  createUpdateController,
} = require('../../src/main/services/updater');

// ---------------------------------------------------------------- configuration

test('updater config is pinned to the intended GitHub repository over HTTPS', () => {
  const c = buildUpdaterConfig({ repository: 'azmisahin-gov/forensic-transcriber' });
  assert.equal(c.provider, 'github');
  assert.equal(c.owner, 'azmisahin-gov');
  assert.equal(c.repo, 'forensic-transcriber');
  assert.equal(c.protocol, 'https');
  assert.equal(c.channel, 'latest');
});

test('updater never downloads or installs without an explicit user action', () => {
  const c = buildUpdaterConfig({ repository: 'a/b' });
  assert.equal(c.autoDownload, false);
  assert.equal(c.autoInstallOnAppQuit, false);
  assert.equal(c.allowPrerelease, false);
});

test('updater config rejects a malformed repository slug', () => {
  for (const bad of [null, '', 'no-slash', 'a/b/c', 'a b/c']) {
    assert.throws(() => buildUpdaterConfig({ repository: bad }), /Invalid GitHub repository slug/);
  }
});

test('only the NSIS installer is an update payload', () => {
  assert.equal(isUpdaterArtifact('ForensicTranscriber-Setup-x64.exe'), true);
  assert.equal(isUpdaterArtifact('ForensicTranscriber-Portable-x64.zip'), false);
  assert.equal(isUpdaterArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), false);
  assert.equal(isUpdaterArtifact('SHA256SUMS.txt'), false);
  assert.equal(isUpdaterArtifact('latest.yml'), false);
});

test('the model package is never an application update payload', () => {
  assert.equal(isModelArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), true);
  assert.equal(isModelArtifact('ForensicTranscriber-Setup-x64.exe'), false);
  // Explicit: a model artifact must not be accepted by the updater.
  assert.equal(isUpdaterArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), false);
});

// ---------------------------------------------------------------- lifecycle

function controller(current = '0.1.0') {
  return createUpdateController({ getCurrentVersion: () => current });
}

test('a newer version is reported as available', () => {
  const c = controller('0.1.0');
  c.checkStart();
  assert.equal(c.state.status, STATES.CHECKING);
  c.checkResultUpdate({ version: '0.1.1', releaseName: 'Release 0.1.1' });
  assert.equal(c.state.status, STATES.AVAILABLE);
  assert.equal(c.state.availableVersion, '0.1.1');
});

test('no newer version leaves the state as not-available', () => {
  const c = controller('0.1.0');
  c.checkResultNoUpdate({ version: '0.1.0' });
  assert.equal(c.state.status, STATES.NOT_AVAILABLE);
  assert.equal(c.state.availableVersion, null);
});

test('an older or equal version is never treated as an update', () => {
  for (const v of ['0.1.0', '0.0.9']) {
    const c = controller('0.1.0');
    c.checkResultUpdate({ version: v });
    assert.equal(c.state.status, STATES.NOT_AVAILABLE, `${v} must not be offered as an update`);
  }
});

test('update metadata with an invalid version is an error, not an offer', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: 'not-a-version' });
  assert.equal(c.state.status, STATES.ERROR);
  assert.equal(c.state.availableVersion, null);
});

test('postponing keeps the version but does not download anything', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.postpone();
  assert.equal(c.state.status, STATES.POSTPONED);
  assert.equal(c.state.availableVersion, '0.1.1');
  assert.equal(c.state.downloadPercent, 0);
});

test('a postponed version stays postponed on the next check', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.postpone();
  c.checkResultUpdate({ version: '0.1.1' });
  assert.equal(c.state.status, STATES.POSTPONED);
});

test('a different newer version after a postpone is offered again', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.postpone();
  c.checkResultUpdate({ version: '0.2.0' });
  assert.equal(c.state.status, STATES.AVAILABLE);
  assert.equal(c.state.availableVersion, '0.2.0');
});

test('download progress is reported as a bounded percentage', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.downloadProgress({ total: 1000, transferred: 250, bytesPerSecond: 500 });
  assert.equal(c.state.status, STATES.DOWNLOADING);
  assert.equal(c.state.downloadPercent, 25);
  c.downloadProgress({ total: 1000, transferred: 999 });
  assert.equal(c.state.downloadPercent, 99);
});

test('progress with unknown total does not divide by zero', () => {
  const c = controller('0.1.0');
  c.downloadProgress({ total: 0, transferred: 10 });
  assert.equal(c.state.downloadPercent, 0);
});

test('a completed download still requires explicit consent to install', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.downloadProgress({ total: 100, transferred: 100 });
  c.downloadComplete();
  assert.equal(c.state.status, STATES.DOWNLOADED);
  assert.equal(c.state.downloadPercent, 100);
  assert.equal(c.requestInstall().ok, true);
});

test('install is refused when nothing has been downloaded', () => {
  const c = controller('0.1.0');
  assert.deepEqual(c.requestInstall(), { ok: false, reason: 'NOT_DOWNLOADED' });
  c.checkResultUpdate({ version: '0.1.1' });
  assert.deepEqual(c.requestInstall(), { ok: false, reason: 'NOT_DOWNLOADED' });
  c.downloadStart();
  assert.deepEqual(c.requestInstall(), { ok: false, reason: 'NOT_DOWNLOADED' });
});

test('a failed update leaves the current version usable and clears progress', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.downloadProgress({ total: 100, transferred: 50 });
  c.fail('network unreachable');
  assert.equal(c.state.status, STATES.ERROR);
  assert.equal(c.state.error, 'network unreachable');
  assert.equal(c.state.downloadPercent, 0);
  // The running version is unchanged and no install can be triggered.
  assert.equal(c.state.currentVersion, '0.1.0');
  assert.equal(c.requestInstall().ok, false);
});

test('subscribers receive every state transition', () => {
  const c = controller('0.1.0');
  const seen = [];
  const off = c.subscribe((s) => seen.push(s.status));
  c.checkStart();
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.downloadComplete();
  off();
  c.fail('boom');
  assert.deepEqual(seen, [STATES.CHECKING, STATES.AVAILABLE, STATES.DOWNLOADING, STATES.DOWNLOADED]);
});

// ---------------------------------------------------------------- data safety

test('the updater state carries no case-data or model fields', () => {
  // A guard against the updater ever being wired to mutate user data or models:
  // its state only describes the application update.
  const c = controller('0.1.0');
  const keys = Object.keys(c.state);
  for (const forbidden of ['cases', 'evidence', 'segments', 'modelPath', 'modelsDir', 'dbPath']) {
    assert.ok(!keys.includes(forbidden), `updater state must not expose ${forbidden}`);
  }
});

test('application updates and model updates are separate concepts', () => {
  const c = controller('0.1.0');
  c.checkResultUpdate({ version: '0.1.1' });
  // The controller exposes only application-update actions; there is no model
  // action, and the model package is not an updater artifact.
  for (const forbidden of ['installModel', 'updateModel', 'downloadModel']) {
    assert.equal(typeof c[forbidden], 'undefined');
  }
  assert.equal(isUpdaterArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), false);
});

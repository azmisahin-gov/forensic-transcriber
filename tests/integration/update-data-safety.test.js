'use strict';

/**
 * Integration test: an application update must never touch user case data.
 *
 * This does not run a real installer (that needs Windows). Instead it proves the
 * structural guarantee: the updater only knows about the application binaries,
 * and the case store lives in a separate directory that no updater action
 * references. It also exercises the real storage layer to show that case data
 * survives independently of anything the updater does.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const updater = require('../../src/main/services/updater');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-upd-'));
}

test('the updater configuration references no user-data paths', () => {
  const config = updater.buildUpdaterConfig({ repository: 'azmisahin-gov/forensic-transcriber' });
  const serialized = JSON.stringify(config);
  for (const forbidden of ['cases', 'userData', 'transcript', 'evidence', 'models']) {
    assert.ok(!serialized.includes(forbidden), `updater config must not reference ${forbidden}`);
  }
});

test('an update lifecycle never mutates case data on disk', async () => {
  const dataDir = tmp();
  const storage = new Storage(dataDir);
  const kase = storage.createCase({ title: 'Preserve me' });
  const evidencePath = path.join(dataDir, 'input.wav');
  fs.writeFileSync(evidencePath, Buffer.from('RIFF....WAVEfake'));
  const ev = await storage.importEvidence(kase.case_id, evidencePath, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ start: 0, end: 1, text: 'korunmalı', status: 'EDITED' }],
  });
  // Capture the on-disk state before the update lifecycle runs.
  const before = fs.readdirSync(dataDir, { recursive: true }).sort();
  storage.close();

  // Drive a full update lifecycle. None of it should touch the data directory.
  const c = updater.createUpdateController({ getCurrentVersion: () => '0.1.0' });
  c.checkStart();
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.downloadProgress({ total: 100, transferred: 50 });
  c.downloadComplete();
  c.requestInstall();
  c.installing();

  const reopened = new Storage(dataDir);
  const cases = reopened.listCases();
  assert.equal(cases.length, 1, 'the case must still exist after an update cycle');
  assert.equal(cases[0].title, 'Preserve me');
  const after = fs.readdirSync(dataDir, { recursive: true }).sort();
  assert.deepEqual(after, before, 'the data directory listing must be unchanged');
  reopened.close();
});

test('a failed update leaves the case data readable', () => {
  const dataDir = tmp();
  const storage = new Storage(dataDir);
  const kase = storage.createCase({ title: 'Survives failure' });
  storage.close();

  const c = updater.createUpdateController({ getCurrentVersion: () => '0.1.0' });
  c.checkResultUpdate({ version: '0.1.1' });
  c.downloadStart();
  c.fail('download interrupted');

  const reopened = new Storage(dataDir);
  assert.equal(reopened.getCase(kase.case_id).title, 'Survives failure');
  reopened.close();
});

test('application updates and model updates use different mechanisms', () => {
  // The updater only ever installs the application artifact; the model is
  // handled entirely by the model manager and is never an updater payload.
  assert.equal(updater.isUpdaterArtifact('ForensicTranscriber-Setup-x64.exe'), true);
  assert.equal(updater.isUpdaterArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), false);
  assert.equal(updater.isModelArtifact('ForensicTranscriber-ModelPack-0.1.0.zip'), true);
  assert.equal(updater.isModelArtifact('ForensicTranscriber-Setup-x64.exe'), false);
});

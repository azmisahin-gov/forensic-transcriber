'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage, sanitizeFileName, normalizeSegments } = require('../../src/main/services/storage');
const { SEGMENT_STATUS } = require('../../src/shared/constants');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-store-'));
  return { storage: new Storage(dir), dir };
}

test('create case builds the folder layout and history', () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Dava 1', notes: 'not' });
  assert.match(kase.case_id, /^CASE-/);
  for (const sub of ['evidence/original', 'evidence/derived', 'transcript', 'exports']) {
    assert.ok(fs.existsSync(path.join(dir, 'cases', kase.case_id, sub)), `missing ${sub}`);
  }
  const history = storage.listHistory(kase.case_id);
  assert.equal(history[0].action, 'CASE_CREATED');
  storage.close();
});

test('case title is required', () => {
  const { storage } = tmpStorage();
  assert.throws(() => storage.createCase({ title: '   ' }), /title is required/i);
  storage.close();
});

test('evidence import copies the file, hashes it and never modifies the original', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Import test' });
  const src = path.join(dir, 'input.wav');
  fs.writeFileSync(src, Buffer.from('RIFF....WAVEfake'));
  const before = fs.readFileSync(src);

  const ev = await storage.importEvidence(kase.case_id, src, { durationSeconds: 1.2, sampleRate: 16000, channels: 1 });
  assert.equal(ev.sha256.length, 64);
  assert.equal(ev.original_name, 'input.wav');
  assert.ok(ev.original_path.includes('evidence'));
  assert.ok(fs.existsSync(ev.original_path));
  assert.deepEqual(fs.readFileSync(src), before);
  storage.close();
});

test('sanitizeFileName neutralises traversal and reserved names', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFileName('con'), '_con');
  assert.equal(sanitizeFileName('normal ad.wav'), 'normal ad.wav');
  assert.equal(sanitizeFileName('a\u0000b.wav'), 'ab.wav');
});

test('saveTranscript normalizes, persists and reloads segments', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'T' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});

  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr',
    modelId: 'large-v3-turbo-q5_0',
    engine: 'whisper.cpp',
    segments: [
      { start: 0, end: 1, text: 'birinci', speaker: 'SPEAKER_01', status: SEGMENT_STATUS.AUTOMATIC },
      { start: 1, end: 2, text: '', status: SEGMENT_STATUS.EDITED },
    ],
  });
  assert.equal(saved.segments.length, 2);
  assert.equal(saved.segments[1].text, '[ANLAŞILAMADI]');
  assert.equal(saved.segments[1].status, SEGMENT_STATUS.EDITED);

  const reloaded = storage.getTranscript(kase.case_id, ev.evidence_id);
  const segs = storage.getSegments(reloaded.transcript_id);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'birinci');
  storage.close();
});

test('saveTranscript rejects out-of-order or inverted segments', () => {
  const bad = [
    [{ start: 5, end: 6 }, { start: 1, end: 2 }],
    [{ start: 3, end: 2 }],
  ];
  for (const segments of bad) {
    assert.throws(() => normalizeSegments(segments), /ordered|precedes/i);
  }
});

test('saving twice updates the same transcript rather than duplicating', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'T2' });
  const src = path.join(dir, 'b.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});
  const first = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [{ start: 0, end: 1, text: 'a' }] });
  const second = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [{ start: 0, end: 1, text: 'b' }] });
  assert.equal(first.transcript.transcript_id, second.transcript.transcript_id);
  assert.equal(second.segments[0].text, 'b');
  storage.close();
});

test('deleting a case removes its directory and cascades', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Delete me' });
  const caseDir = path.join(dir, 'cases', kase.case_id);
  assert.ok(fs.existsSync(caseDir));
  storage.deleteCase(kase.case_id);
  assert.equal(storage.getCase(kase.case_id), null);
  assert.equal(fs.existsSync(caseDir), false);
  storage.close();
});

test('reopening the database preserves cases (persistence contract)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-store-'));
  const s1 = new Storage(dir);
  const kase = s1.createCase({ title: 'Kalıcı dava' });
  s1.close();
  const s2 = new Storage(dir);
  const reopened = s2.getCase(kase.case_id);
  assert.equal(reopened.title, 'Kalıcı dava');
  s2.close();
});

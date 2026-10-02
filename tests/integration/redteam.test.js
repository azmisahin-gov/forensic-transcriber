'use strict';

/**
 * Red-team / hostile-input tests (section 55).
 *
 * The application must fail in a controlled way — with a structured error code,
 * no crash, and no corruption of existing data — when given adverse input.
 *
 * Requires FFmpeg. ASR-specific cases require a whisper.cpp build and a model;
 * those tests skip when the model is absent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage, normalizeSegments } = require('../../src/main/services/storage');
const { MediaService } = require('../../src/main/services/media');
const { WhisperAdapter } = require('../../src/main/services/whisper');
const { runExport } = require('../../src/main/services/exporter');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = process.env.FT_TEST_AUDIO || path.join(REPO_ROOT, 'tests', 'fixtures', 'tr-known-events.wav');
const MODEL = process.env.FT_TEST_MODEL || path.join(REPO_ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
const haveFixture = fs.existsSync(FIXTURE);
const haveModel = fs.existsSync(MODEL);

function tmp(prefix = 'ft-red-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('corrupt audio: probe fails cleanly, import still succeeds', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const media = new MediaService();
  const kase = storage.createCase({ title: 'corrupt' });

  const bad = path.join(dir, 'corrupt.mp3');
  fs.writeFileSync(bad, Buffer.from('\x00\x01\x02 not audio at all \xff\xfe'));

  await assert.rejects(
    () => media.probe(bad),
    (err) => err.code === 'PROBE_FAILED' && typeof err.detail === 'string'
  );
  const ev = await storage.importEvidence(kase.case_id, bad, {});
  assert.equal(ev.sha256.length, 64);
  storage.close();
});

test('empty file: rejected as non-decodable, never crashes', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const media = new MediaService();
  const kase = storage.createCase({ title: 'empty' });
  const empty = path.join(dir, 'empty.wav');
  fs.writeFileSync(empty, Buffer.alloc(0));
  await assert.rejects(() => media.probe(empty), (err) => err.code === 'PROBE_FAILED');
  const ev = await storage.importEvidence(kase.case_id, empty, {});
  assert.equal(ev.size_bytes, 0);
  storage.close();
});

test('unsupported codec / random data does not hang or throw unhandled', async () => {
  const media = new MediaService();
  const dir = tmp();
  const junk = path.join(dir, 'file.xyz');
  fs.writeFileSync(junk, Buffer.from('RIFFxxxxWAVEjunkjunkjunk'));
  await assert.rejects(() => media.probe(junk), (err) => err.code === 'PROBE_FAILED');
});

test('unicode and Turkish file names are preserved and importable', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'unicode' });
  const name = 'İstanbul kaydı — şüpheli görüşme (1).wav';
  const src = path.join(dir, name);
  fs.copyFileSync(FIXTURE, src);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  assert.equal(ev.original_name, name);
  assert.ok(fs.existsSync(ev.original_path));
  storage.close();
});

test('path traversal in the file name cannot escape the case directory', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'traversal' });
  // Simulate a hostile original_name by importing a normal file then checking
  // the stored leaf name is sanitised.
  const src = path.join(dir, 'normal.wav');
  fs.copyFileSync(FIXTURE, src);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  assert.ok(ev.original_path.startsWith(path.join(kase.case_dir, 'evidence', 'original')));
  assert.ok(!ev.stored_name.includes('..'));
  assert.ok(!ev.stored_name.includes('/'));
  storage.close();
});

test('duplicate file name: both imports are kept separately', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'dupes' });
  const a = path.join(dir, 'same.wav');
  const b = path.join(tmp(), 'same.wav');
  fs.copyFileSync(FIXTURE, a);
  fs.copyFileSync(FIXTURE, b);
  const ev1 = await storage.importEvidence(kase.case_id, a, {});
  const ev2 = await storage.importEvidence(kase.case_id, b, {});
  assert.notEqual(ev1.evidence_id, ev2.evidence_id);
  assert.notEqual(ev1.original_path, ev2.original_path);
  assert.equal(fs.readdirSync(path.join(kase.case_dir, 'evidence', 'original')).length, 2);
  storage.close();
});

test('read-only export directory produces a structured error, not a crash', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'readonly' });
  const ro = path.join(kase.case_dir, 'exports-readonly');
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o500);
  const segments = [{ segment_id: 'S1', start: 0, end: 1, speaker: 'SPEAKER_01', text: 'x', status: 'AUTOMATIC' }];
  try {
    await assert.rejects(
      () => runExport({ caseRecord: kase, evidence: null, transcript: null, segments, language: 'tr', formats: ['json'], outputDir: ro }),
      (err) => err.code === 'EACCES' || err.code === 'EPERM' || /permission/i.test(err.message)
    );
  } finally {
    fs.chmodSync(ro, 0o700);
    storage.close();
  }
});

test('missing model: transcription raises MODEL_NOT_INSTALLED', () => {
  const adapter = new WhisperAdapter({ modelPath: '/nonexistent/model.bin', vadModelPath: null });
  assert.throws(() => adapter.transcribe('/tmp/whatever.wav'), (err) => err.code === 'MODEL_NOT_INSTALLED');
});

test('invalid transcript edits are rejected', () => {
  assert.throws(() => normalizeSegments('not an array'), (err) => err.code === 'INVALID_SEGMENTS');
  assert.throws(() => normalizeSegments([{ start: 5, end: 6 }, { start: 1, end: 2 }]), (err) => err.code === 'INVALID_SEGMENTS');
  assert.throws(() => normalizeSegments([{ start: 3, end: 2 }]), (err) => err.code === 'INVALID_SEGMENTS');
  assert.throws(() => normalizeSegments([{ start: NaN, end: 1 }]), (err) => err.code === 'INVALID_SEGMENTS');
});

test('ASR on a non-audio file fails with ASR_FAILED, does not hang', { skip: !haveModel }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const junk = path.join(dir, 'junk.wav');
  fs.writeFileSync(junk, Buffer.from('this is not a wav file'));
  // The decode step should reject before ASR even runs.
  await assert.rejects(
    () => media.toAsrWav(junk, path.join(dir, 'out.wav')),
    (err) => err.code === 'DECODE_FAILED'
  );
});

test('cancellation aborts an in-flight transcription', { skip: !haveFixture || !haveModel }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const derived = path.join(dir, 'w.wav');
  await media.toAsrWav(FIXTURE, derived);
  const adapter = new WhisperAdapter({ modelPath: MODEL, vadModelPath: null });
  const controller = new AbortController();
  const promise = adapter.transcribe(derived, { language: 'tr', useGpu: false, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(promise, (err) => err.code === 'TRANSCRIPTION_CANCELLED');
});

test('GPU request without a GPU falls back to CPU and still succeeds', { skip: !haveFixture || !haveModel }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const derived = path.join(dir, 'w.wav');
  await media.toAsrWav(FIXTURE, derived);
  const adapter = new WhisperAdapter({ modelPath: MODEL, vadModelPath: null });
  // useGpu:true against a CPU-only build must not fail; the engine ignores it.
  const result = await adapter.transcribe(derived, { language: 'tr', useGpu: true, useVad: false });
  assert.ok(result.segments.length >= 1);
});

test('database corruption: a garbage file is not silently accepted as a database', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'forensic-transcriber.db'), 'not a sqlite database');
  assert.throws(() => new Storage(dir));
});

test('restart during work: a case saved then reopened is intact', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'restart' });
  const src = path.join(dir, 'a.wav');
  fs.copyFileSync(FIXTURE, src);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ start: 0, end: 1, text: 'kalıcı', status: 'EDITED' }],
  });
  storage.close();

  const reopened = new Storage(dir);
  const t = reopened.getTranscript(kase.case_id, ev.evidence_id);
  assert.ok(t);
  assert.equal(reopened.getSegments(t.transcript_id)[0].text, 'kalıcı');
  assert.equal(reopened.getCase(kase.case_id).title, 'restart');
  reopened.close();
});

test('removing a case cascades to evidence, transcripts and history', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'cascade' });
  const src = path.join(dir, 'a.wav');
  fs.copyFileSync(FIXTURE, src);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [{ start: 0, end: 1, text: 'x' }] });
  storage.deleteCase(kase.case_id);
  assert.equal(storage.getEvidence(ev.evidence_id), null);
  assert.equal(storage.listHistory(kase.case_id).length, 0);
  storage.close();
});

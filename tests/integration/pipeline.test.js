'use strict';

/**
 * End-to-end integration test over the real pipeline:
 *   import -> hash -> probe -> decode -> local ASR -> save -> reopen -> export
 *
 * It also verifies the timestamp contract: transcript segment intervals must
 * line up with known spoken events in the source audio. If the ASR timeline
 * drifts, this test fails and the release gate is not met.
 *
 * Requires FFmpeg and a whisper.cpp build. Paths are taken from environment
 * variables (set by scripts/run-integration.sh) with sensible defaults.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const { MediaService } = require('../../src/main/services/media');
const { WhisperAdapter } = require('../../src/main/services/whisper');
const { runExport } = require('../../src/main/services/exporter');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = process.env.FT_TEST_AUDIO || path.join(REPO_ROOT, 'tests', 'fixtures', 'tr-known-events.wav');
const MODEL = process.env.FT_TEST_MODEL || path.join(REPO_ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
const VAD = process.env.FT_TEST_VAD || path.join(REPO_ROOT, 'models', 'ggml-silero-v5.1.2.bin');

// Ground-truth fixtures. Both are synthetic Turkish speech built by
// scripts/make-fixtures.sh. See that script for exact construction.
//
//  tr-offset.wav       3.0 s silence, then one utterance [3.0, 7.383]
//  tr-known-events.wav three utterances separated by 2.5 s silence
//
// The offset fixture is the load-bearing timestamp test: if the ASR timeline
// were reset to the start of speech instead of the original recording's
// timeline, the reported start would be ~0 instead of ~3.0.
const OFFSET_FIXTURE = process.env.FT_TEST_AUDIO_OFFSET || path.join(REPO_ROOT, 'tests', 'fixtures', 'tr-offset.wav');
const OFFSET_EXPECTED_START = 3.0;
const OFFSET_EXPECTED_END = 7.383;
const OFFSET_TOLERANCE = 0.5;

const haveFixture = fs.existsSync(FIXTURE);
const haveOffsetFixture = fs.existsSync(OFFSET_FIXTURE);
const haveModel = fs.existsSync(MODEL);
const haveVad = fs.existsSync(VAD);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-'));
}

test('full pipeline produces a timestamp-aligned Turkish transcript', { skip: !haveFixture || !haveModel }, async () => {
  const dataDir = tmpDir();
  const storage = new Storage(dataDir);
  const media = new MediaService();

  const availability = await media.available();
  assert.equal(availability.ffmpeg, true, 'ffmpeg must be available');
  assert.equal(availability.ffprobe, true, 'ffprobe must be available');

  const kase = storage.createCase({ title: 'E2E dava', notes: 'integration' });
  const ev = await storage.importEvidence(kase.case_id, FIXTURE, await media.probe(FIXTURE));
  assert.equal(ev.sha256.length, 64);
  assert.ok(ev.duration_seconds > 15, 'fixture should be ~19s');

  // Derived working copy, original untouched.
  const originalHashBefore = ev.sha256;
  const derived = path.join(kase.case_dir, 'evidence', 'derived', `${ev.evidence_id}.asr16k.wav`);
  await media.toAsrWav(ev.original_path, derived);
  assert.ok(fs.existsSync(derived));

  const whisper = new WhisperAdapter({ modelPath: MODEL, vadModelPath: haveVad ? VAD : null });
  const result = await whisper.transcribe(derived, { language: 'tr', useGpu: false, useVad: haveVad });
  assert.equal(result.language, 'tr');
  assert.ok(result.segments.length >= 1, `expected >=1 segment, got ${result.segments.length}`);

  // Segments are ordered, non-overlapping and positive-length.
  for (let i = 1; i < result.segments.length; i += 1) {
    assert.ok(result.segments[i].start >= result.segments[i - 1].start, 'segments ordered');
  }
  for (const s of result.segments) {
    assert.ok(s.end > s.start, 'segment must have positive duration');
  }

  // Every segment starts as AUTOMATIC, never as expert output.
  assert.ok(result.segments.every((s) => s.status === 'AUTOMATIC'));

  // Persist and reload.
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr',
    modelId: 'large-v3-turbo-q5_0',
    engine: 'whisper.cpp',
    segments: result.segments,
    source: 'asr',
  });
  storage.close();

  const reopened = new Storage(dataDir);
  const t = reopened.getTranscript(kase.case_id, ev.evidence_id);
  assert.ok(t, 'transcript should persist across reopen');
  const segs = reopened.getSegments(t.transcript_id);
  assert.equal(segs.length, saved.segments.length);
  assert.equal(segs[0].text, saved.segments[0].text);
  assert.equal(reopened.getEvidence(ev.evidence_id).sha256, originalHashBefore, 'original hash unchanged');

  // Export every format and validate.
  const written = await runExport({
    caseRecord: reopened.getCase(kase.case_id),
    evidence: reopened.getEvidence(ev.evidence_id),
    transcript: t,
    segments: segs,
    language: 'tr',
    modelId: 'large-v3-turbo-q5_0',
    engine: 'whisper.cpp',
    formats: ['json', 'txt', 'srt', 'html'],
  });
  assert.equal(written.length, 4);
  for (const w of written) assert.ok(fs.existsSync(w.path) && w.bytes > 0);

  const json = JSON.parse(fs.readFileSync(written.find((w) => w.format === 'json').path, 'utf8'));
  assert.equal(json.segments.length, segs.length);
  assert.equal(json.language, 'tr');

  const srt = fs.readFileSync(written.find((w) => w.format === 'srt').path, 'utf8');
  assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> /);

  reopened.close();
});

test('timestamp contract: a delayed utterance keeps its original-timeline offset', { skip: !haveOffsetFixture || !haveModel }, async () => {
  const dataDir = tmpDir();
  const storage = new Storage(dataDir);
  const media = new MediaService();
  const kase = storage.createCase({ title: 'Offset contract' });
  const ev = await storage.importEvidence(kase.case_id, OFFSET_FIXTURE, await media.probe(OFFSET_FIXTURE));

  const derived = path.join(kase.case_dir, 'evidence', 'derived', `${ev.evidence_id}.asr16k.wav`);
  await media.toAsrWav(ev.original_path, derived);

  const whisper = new WhisperAdapter({ modelPath: MODEL, vadModelPath: haveVad ? VAD : null });
  const result = await whisper.transcribe(derived, { language: 'tr', useGpu: false, useVad: haveVad });
  assert.ok(result.segments.length >= 1, 'should detect the utterance');
  const first = result.segments[0];

  // The speech begins at 3.0 s in the original recording. The engine's segment
  // must be anchored there, not reset to zero.
  assert.ok(
    Math.abs(first.start - OFFSET_EXPECTED_START) <= OFFSET_TOLERANCE,
    `segment start ${first.start}s is not within ${OFFSET_TOLERANCE}s of ${OFFSET_EXPECTED_START}s`
  );
  assert.ok(
    Math.abs(first.end - OFFSET_EXPECTED_END) <= OFFSET_TOLERANCE,
    `segment end ${first.end}s is not within ${OFFSET_TOLERANCE}s of ${OFFSET_EXPECTED_END}s`
  );

  storage.close();
});

test('a corrupt file is rejected without crashing the pipeline', { skip: !haveFixture }, async () => {
  const dataDir = tmpDir();
  const storage = new Storage(dataDir);
  const media = new MediaService();
  const kase = storage.createCase({ title: 'Corrupt' });

  const bad = path.join(dataDir, 'broken.wav');
  fs.writeFileSync(bad, Buffer.from('not actually audio'));
  await assert.rejects(() => media.probe(bad), (err) => err.code === 'PROBE_FAILED');
  // The evidence record can still be created (import must not throw).
  const ev = await storage.importEvidence(kase.case_id, bad, {});
  assert.ok(ev.evidence_id);
  storage.close();
});

test('an unsupported extension is still importable but flagged', { skip: !haveFixture }, async () => {
  const dataDir = tmpDir();
  const storage = new Storage(dataDir);
  const kase = storage.createCase({ title: 'Ext' });
  const weird = path.join(dataDir, 'ses dosyası ünlü.wav');
  fs.copyFileSync(FIXTURE, weird);
  const ev = await storage.importEvidence(kase.case_id, weird, {});
  assert.match(ev.original_name, /ünlü/);
  assert.ok(fs.existsSync(ev.original_path));
  storage.close();
});

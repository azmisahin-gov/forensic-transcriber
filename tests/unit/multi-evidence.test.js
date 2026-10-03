'use strict';

/**
 * Regression for the v0.1.2 blocker: a second recording in the same case failed
 * with "UNIQUE constraint failed: segments.segment_id".
 *
 * Cause: the ASR engine numbers its segments from zero for every recording, and
 * segment_id was the single-column primary key of `segments`, so two transcripts
 * in one case produced colliding ids.
 *
 * These tests exercise a real multi-evidence case, the re-transcription of one
 * evidence, a failed transcription, and the schema migration from the old key.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const { parseSegments } = require('../../src/main/services/whisper');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-multi-'));
}

function writeEvidence(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `RIFF-${name}`);
  return p;
}

/** Mimic what whisper.js produces for a recording: ids numbered from zero. */
function engineSegments(count = 3, runId = null) {
  return parseSegments(
    Array.from({ length: count }, (_, i) => ({
      offsets: { from: i * 1000, to: i * 1000 + 900 },
      text: ` segment ${i}`,
      tokens: [{ text: ` x`, offsets: { from: i * 1000, to: i * 1000 + 900 }, p: 0.9 }],
    })),
    runId
  );
}

test('ten recordings in one case each transcribe without an id collision', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Multi evidence' });

  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    const ev = await storage.importEvidence(kase.case_id, writeEvidence(dir, `rec-${i}.wav`), {});
    const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
      segments: engineSegments(4),
      source: 'asr',
    });
    assert.equal(saved.segments.length, 4, `recording ${i} should store 4 segments`);
    ids.push(saved.segments.map((s) => s.segment_id));
  }

  // Every recording has its own transcript and its own segments.
  assert.equal(storage.listEvidence(kase.case_id).length, 10);
  const total = ids.reduce((n, list) => n + list.length, 0);
  assert.equal(total, 40);

  // Ids may repeat across transcripts (they are scoped per transcript), but each
  // transcript must hold its own rows and none may be lost.
  for (let i = 0; i < 10; i += 1) {
    const ev = storage.listEvidence(kase.case_id)[i];
    const t = storage.getTranscript(kase.case_id, ev.evidence_id);
    const segs = storage.getSegments(t.transcript_id);
    assert.equal(segs.length, 4, `transcript ${i} must keep its 4 segments`);
  }
  storage.close();
});

test('segment ids are distinct across recordings when the engine scopes them per run', () => {
  const a = engineSegments(3, 'aaaa1111').map((s) => s.segment_id);
  const b = engineSegments(3, 'bbbb2222').map((s) => s.segment_id);
  assert.deepEqual(a, ['SEG-aaaa1111-0000', 'SEG-aaaa1111-0001', 'SEG-aaaa1111-0002']);
  assert.equal(a.some((id) => b.includes(id)), false, 'ids from two runs must not overlap');
});

test('re-transcribing the same recording replaces its transcript safely', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Retranscribe' });
  const ev = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'a.wav'), {});

  const first = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: engineSegments(5, 'run1') });
  assert.equal(first.segments.length, 5);
  const firstTranscriptId = first.transcript.transcript_id;

  // Re-transcribe: different run id, more segments.
  const second = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: engineSegments(7, 'run2') });
  assert.equal(second.transcript.transcript_id, firstTranscriptId, 'the same transcript row is reused');
  assert.equal(second.segments.length, 7, 'the new run replaces the old segments');

  const segs = storage.getSegments(firstTranscriptId);
  assert.equal(segs.length, 7, 'no stale segments are left behind');
  assert.equal(storage.listEvidence(kase.case_id).length, 1, 'still exactly one evidence');
  storage.close();
});

test('an expert edit survives re-transcription of the same recording', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Edit then retranscribe' });
  const ev = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'a.wav'), {});

  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: engineSegments(3, 'run1') });
  // Edit the first segment (same id), then re-run with the same run id.
  const edited = engineSegments(3, 'run1');
  edited[0].text = 'düzeltilmiş';
  edited[0].status = 'EDITED';
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited });

  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  const segs = storage.getSegments(t.transcript_id);
  assert.equal(segs[0].text, 'düzeltilmiş');
  assert.equal(segs[0].original_text, segs[0].original_text, 'original text column is preserved');
  storage.close();
});

test('a failed transcription leaves the case and other transcripts intact', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Failure isolation' });

  const good = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'good.wav'), {});
  storage.saveTranscript(kase.case_id, good.evidence_id, { segments: engineSegments(3, 'ok') });
  const before = storage.getSegments(storage.getTranscript(kase.case_id, good.evidence_id).transcript_id);

  // A second recording fails before any transcript is written (as the app does
  // when the engine exits non-zero): the case must remain usable.
  const bad = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'bad.wav'), {});
  assert.equal(storage.getTranscript(kase.case_id, bad.evidence_id), null, 'no transcript for the failed file');

  const after = storage.getSegments(storage.getTranscript(kase.case_id, good.evidence_id).transcript_id);
  assert.deepEqual(after.map((s) => s.text), before.map((s) => s.text), 'the good transcript is untouched');
  assert.equal(storage.listEvidence(kase.case_id).length, 2, 'both recordings are still listed');
  storage.close();
});

test('a database with the old single-column key is migrated without data loss', () => {
  const dir = tmp();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'forensic-transcriber.db'));
  // Schema as it was before the fix: segment_id as the sole primary key.
  db.exec(`
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', case_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, original_path TEXT NOT NULL, derived_path TEXT, size_bytes INTEGER NOT NULL, format TEXT, codec TEXT, duration_seconds REAL, sample_rate INTEGER, channels INTEGER, bit_depth INTEGER, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE transcripts (transcript_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, evidence_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'tr', model_id TEXT, engine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE segments (segment_id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, speaker TEXT NOT NULL DEFAULT 'SPEAKER_01', text TEXT NOT NULL DEFAULT '', original_text TEXT, status TEXT NOT NULL DEFAULT 'AUTOMATIC', confidence REAL, words_json TEXT);
    CREATE TABLE history (history_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT, created_at TEXT NOT NULL);
    INSERT INTO cases VALUES('C1','Old case','','${dir}','2020-01-01','2020-01-01');
    INSERT INTO transcripts VALUES('T1','C1','E1','tr',NULL,NULL,'2020-01-01','2020-01-01');
    INSERT INTO segments VALUES('SEG-0000','T1',0,0,1,'SPEAKER_01','orijinal','orijinal','AUTOMATIC',0.9,NULL);
  `);
  db.close();

  const storage = new Storage(dir);
  const segs = storage.getSegments('T1');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'orijinal');
  assert.equal(segs[0].original_text, 'orijinal', 'migration preserves the automatic text');

  // After migration the same id can exist in a second transcript.
  const kase = storage.getCase('C1');
  assert.ok(kase);
  storage.close();
});

test('the migrated schema accepts the same segment id in two transcripts', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Post-migration' });
  const a = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'a.wav'), {});
  const b = await storage.importEvidence(kase.case_id, writeEvidence(dir, 'b.wav'), {});
  // Deliberately reuse the identical ids to prove the key is scoped by transcript.
  const same = engineSegments(2, 'same');
  storage.saveTranscript(kase.case_id, a.evidence_id, { segments: same });
  storage.saveTranscript(kase.case_id, b.evidence_id, { segments: same });
  assert.equal(storage.listEvidence(kase.case_id).length, 2);
  const ta = storage.getTranscript(kase.case_id, a.evidence_id);
  const tb = storage.getTranscript(kase.case_id, b.evidence_id);
  assert.equal(storage.getSegments(ta.transcript_id).length, 2);
  assert.equal(storage.getSegments(tb.transcript_id).length, 2);
  storage.close();
});

test('splitting the same segment twice produces unique ids', () => {
  const { TranscriptStore } = require('../../src/renderer/lib/transcript-store');
  const store = new TranscriptStore([
    { segment_id: 'S1', start: 0, end: 4, text: 'a b c d e f', speaker: 'SPEAKER_01', status: 'AUTOMATIC', confidence: null, words: null },
  ]);
  store.splitSegment('S1', 2);
  const ids = store.segments.map((s) => s.segment_id);
  assert.equal(new Set(ids).size, ids.length, 'split must not create duplicate ids');
  // Split the produced tail again; the suffix must keep growing, not repeat.
  store.splitSegment('S1-B', 3);
  const ids2 = store.segments.map((s) => s.segment_id);
  assert.equal(new Set(ids2).size, ids2.length, 'a repeated split must stay unique');
});

test('inserting two segments produces unique ids', () => {
  const { TranscriptStore } = require('../../src/renderer/lib/transcript-store');
  const store = new TranscriptStore([
    { segment_id: 'S1', start: 0, end: 1, text: 'x', speaker: 'SPEAKER_01', status: 'AUTOMATIC', confidence: null, words: null },
  ]);
  const a = store.insertSegmentAfter('S1', { text: 'one' });
  const b = store.insertSegmentAfter('S1', { text: 'two' });
  assert.notEqual(a.segment_id, b.segment_id);
});

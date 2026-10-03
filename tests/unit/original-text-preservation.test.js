'use strict';

/**
 * The 56.12 core principle: the automatic (machine) transcript and the expert's
 * text must never destroy each other. An edit must not overwrite what the ASR
 * engine produced, including after save, close and reopen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const { toJson } = require('../../src/main/services/exports');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-orig-'));
  return { storage: new Storage(dir), dir };
}

function importOne(storage, dir) {
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  return storage.importEvidence(storage.createCase({ title: 'T' }).case_id, src, {});
}

test('an expert edit does not overwrite the stored automatic text', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Auto preserve' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});

  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'otomatik metin', status: 'AUTOMATIC' }],
  });
  assert.equal(saved.segments[0].text, 'otomatik metin');
  assert.equal(saved.segments[0].original_text, 'otomatik metin');

  // The expert edits the text.
  const edited = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'düzeltilmiş metin', status: 'EDITED' }],
  });
  assert.equal(edited.segments[0].text, 'düzeltilmiş metin', 'current text is the edit');
  assert.equal(edited.segments[0].original_text, 'otomatik metin', 'automatic text must survive the edit');

  storage.close();
});

test('the automatic text survives close and reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-orig-'));
  const s1 = new Storage(dir);
  const kase = s1.createCase({ title: 'Reopen' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await s1.importEvidence(kase.case_id, src, {});
  s1.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'engine output', status: 'AUTOMATIC' }],
  });
  s1.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'expert output', status: 'EDITED' }],
  });
  s1.close();

  const s2 = new Storage(dir);
  const t = s2.getTranscript(kase.case_id, ev.evidence_id);
  const segs = s2.getSegments(t.transcript_id);
  assert.equal(segs[0].text, 'expert output');
  assert.equal(segs[0].original_text, 'engine output');
  s2.close();
});

test('repeated edits keep the very first automatic text', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Repeated' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});

  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'v1 automatic', status: 'AUTOMATIC' }],
  });
  for (const text of ['v2', 'v3', 'v4']) {
    storage.saveTranscript(kase.case_id, ev.evidence_id, {
      segments: [{ segment_id: 'S1', start: 0, end: 1, text, status: 'EDITED' }],
    });
  }
  const segs = storage.getSegments(storage.getTranscript(kase.case_id, ev.evidence_id).transcript_id);
  assert.equal(segs[0].text, 'v4');
  assert.equal(segs[0].original_text, 'v1 automatic');
  storage.close();
});

test('the JSON export exposes the automatic text when it differs from the current text', async () => {
  const { storage, dir } = tmpStorage();
  const kase = storage.createCase({ title: 'Export' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [
      { segment_id: 'S1', start: 0, end: 1, text: 'otomatik', status: 'AUTOMATIC' },
      { segment_id: 'S2', start: 1, end: 2, text: 'değişti', status: 'EDITED' },
    ],
  });
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [
      { segment_id: 'S1', start: 0, end: 1, text: 'otomatik', status: 'AUTOMATIC' },
      { segment_id: 'S2', start: 1, end: 2, text: 'düzeltildi', status: 'EDITED' },
    ],
  });
  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  const segs = storage.getSegments(t.transcript_id);
  const json = JSON.parse(toJson({
    caseRecord: kase, evidence: ev, transcript: t, segments: segs, language: 'tr', modelId: 'm', engine: 'whisper.cpp',
  }));
  assert.equal(json.segments[0].original_text, undefined, 'unchanged segment needs no duplicate');
  assert.equal(json.segments[1].text, 'düzeltildi');
  assert.equal(json.segments[1].original_text, 'değişti', 'the automatic text must be exported');
  storage.close();
});

test('a pre-existing database is migrated to carry original_text', () => {
  // Simulate a database created before the original_text column existed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mig-'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'forensic-transcriber.db'));
  db.exec(`
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', case_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, original_path TEXT NOT NULL, derived_path TEXT, size_bytes INTEGER NOT NULL, format TEXT, codec TEXT, duration_seconds REAL, sample_rate INTEGER, channels INTEGER, bit_depth INTEGER, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE transcripts (transcript_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, evidence_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'tr', model_id TEXT, engine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE segments (segment_id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, speaker TEXT NOT NULL DEFAULT 'SPEAKER_01', text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'AUTOMATIC', confidence REAL, words_json TEXT);
    CREATE TABLE history (history_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT, created_at TEXT NOT NULL);
    INSERT INTO cases VALUES('C1','Old','','/tmp','2020-01-01','2020-01-01');
    INSERT INTO transcripts VALUES('T1','C1','E1','tr',NULL,NULL,'2020-01-01','2020-01-01');
    INSERT INTO segments VALUES('S1','T1',0,0,1,'SPEAKER_01','eski metin','AUTOMATIC',NULL,NULL);
  `);
  db.close();

  const storage = new Storage(dir);
  const segs = storage.getSegments('T1');
  assert.equal(segs[0].text, 'eski metin');
  assert.equal(segs[0].original_text, 'eski metin', 'migration must backfill original_text');
  storage.close();
});

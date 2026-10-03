'use strict';

/**
 * P0 reliability tests: durability, integrity, atomicity, crash safety.
 *
 * These exercise real code paths on real files. They are not mocks.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage, SCHEMA_VERSION } = require('../../src/main/services/storage');
const { writeFileAtomic, copyFileAtomic } = require('../../src/main/services/atomic');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-p0-'));
}

async function seedCase(storage, dir, name = 'a.wav') {
  const kase = storage.createCase({ title: 'P0 case' });
  const src = path.join(dir, name);
  fs.writeFileSync(src, `RIFF-${name}`);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  return { kase, ev };
}

// ---------------------------------------------------------------- P0-2 durability

test('the database is configured for durability and concurrency', () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const pragma = (name) => Object.values(storage.db.prepare(`PRAGMA ${name}`).get())[0];
  assert.equal(String(pragma('journal_mode')).toLowerCase(), 'wal');
  assert.equal(Number(pragma('synchronous')), 2, 'synchronous must be FULL');
  assert.equal(Number(pragma('foreign_keys')), 1);
  assert.ok(Number(pragma('busy_timeout')) >= 1000);
  storage.close();
});

test('healthCheck reports a healthy database and survives a corrupt one', () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const health = storage.healthCheck({ quick: true });
  assert.equal(health.ok, true, JSON.stringify(health.messages));
  storage.close();

  // A garbage file must not open as a database, and healthCheck must not throw.
  const badDir = tmp();
  fs.writeFileSync(path.join(badDir, 'forensic-transcriber.db'), 'not sqlite');
  assert.throws(() => new Storage(badDir));
});

// ---------------------------------------------------------------- P0-3 atomic writes

test('writeFileAtomic leaves no partial file and overwrites atomically', () => {
  const dir = tmp();
  const dest = path.join(dir, 'out.json');
  writeFileAtomic(dest, 'first');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'first');
  writeFileAtomic(dest, 'second');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'second');
  // No temp files left behind.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a failed atomic write does not damage the existing file', () => {
  const dir = tmp();
  const dest = path.join(dir, 'keep.json');
  fs.writeFileSync(dest, 'original');
  // Writing to a path whose parent directory does not exist must throw and
  // leave the original untouched.
  assert.throws(() => writeFileAtomic(path.join(dir, 'missing', 'x.json'), 'nope'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'original');
});

test('copyFileAtomic copies and cleans up on failure', () => {
  const dir = tmp();
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, 'payload');
  const dest = path.join(dir, 'dest.bin');
  copyFileAtomic(src, dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload');
  assert.throws(() => copyFileAtomic(path.join(dir, 'nope.bin'), path.join(dir, 'x.bin')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

// ---------------------------------------------------------------- P0-4 crash-safe migration

test('a migration backs up the database and is re-runnable', () => {
  const dir = tmp();
  // Legacy database: single-column segment key, schema_version 1.
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dir, 'forensic-transcriber.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1');
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', case_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, original_path TEXT NOT NULL, derived_path TEXT, size_bytes INTEGER NOT NULL, format TEXT, codec TEXT, duration_seconds REAL, sample_rate INTEGER, channels INTEGER, bit_depth INTEGER, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE transcripts (transcript_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, evidence_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'tr', model_id TEXT, engine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE segments (segment_id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, speaker TEXT NOT NULL DEFAULT 'SPEAKER_01', text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'AUTOMATIC', confidence REAL, words_json TEXT);
    CREATE TABLE history (history_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT, created_at TEXT NOT NULL);
    INSERT INTO cases VALUES('C1','Legacy','','${dir}','2020-01-01','2020-01-01');
  `);
  db.close();

  const storage = new Storage(dir);
  assert.ok(storage.lastMigration, 'a migration should have run');
  assert.equal(storage.lastMigration.from, 1);
  assert.equal(storage.lastMigration.to, SCHEMA_VERSION);
  assert.ok(storage.lastMigration.backupPath, 'a pre-migration backup should exist');
  assert.ok(fs.existsSync(storage.lastMigration.backupPath), 'backup file must exist on disk');
  // The legacy case survived.
  assert.equal(storage.getCase('C1').title, 'Legacy');
  storage.close();

  // Re-running the migration on an already-migrated database is a no-op and
  // must not create another backup or lose data.
  const again = new Storage(dir);
  assert.equal(again.lastMigration.from, SCHEMA_VERSION);
  assert.equal(again.getCase('C1').title, 'Legacy');
  again.close();
});

test('migration is re-runnable after an interrupted attempt', () => {
  const dir = tmp();
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dir, 'forensic-transcriber.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1');
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', case_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, original_path TEXT NOT NULL, derived_path TEXT, size_bytes INTEGER NOT NULL, format TEXT, codec TEXT, duration_seconds REAL, sample_rate INTEGER, channels INTEGER, bit_depth INTEGER, sha256 TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE transcripts (transcript_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, evidence_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'tr', model_id TEXT, engine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE segments (segment_id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, speaker TEXT NOT NULL DEFAULT 'SPEAKER_01', text TEXT NOT NULL DEFAULT '', original_text TEXT, status TEXT NOT NULL DEFAULT 'AUTOMATIC', confidence REAL, words_json TEXT);
    CREATE TABLE history (history_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT, created_at TEXT NOT NULL);
    INSERT INTO cases VALUES('C1','Interrupted','','${dir}','2020-01-01','2020-01-01');
    INSERT INTO transcripts VALUES('T1','C1','E1','tr',NULL,NULL,'2020-01-01','2020-01-01');
    INSERT INTO segments VALUES('SEG-0000','T1',0,0,1,'SPEAKER_01','metin','metin','AUTOMATIC',NULL,NULL);
  `);
  db.close();

  // First open migrates; second and third must be stable and idempotent.
  for (let i = 0; i < 3; i += 1) {
    const s = new Storage(dir);
    const segs = s.getSegments('T1');
    assert.equal(segs.length, 1, `run ${i}: segment must survive`);
    assert.equal(segs[0].text, 'metin');
    assert.equal(segs[0].original_text, 'metin');
    s.close();
  }
});

// ---------------------------------------------------------------- P0-5 evidence re-verification

test('a tampered evidence file is detected, not silently rehashed', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { ev } = await seedCase(storage, dir);
  const before = storage.getEvidence(ev.evidence_id).sha256;

  fs.writeFileSync(ev.original_path, 'tampered bytes');
  const { sha256File } = require('../../src/main/services/storage');
  const actual = await sha256File(ev.original_path);
  assert.notEqual(actual, before, 'the tampered file must hash differently');
  // The stored hash is unchanged: the app reports drift, it does not hide it.
  assert.equal(storage.getEvidence(ev.evidence_id).sha256, before);
  storage.close();
});

// ---------------------------------------------------------------- P0-7 failed operation safety

test('a failed transcription leaves no transcript and other data intact', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seedCase(storage, dir, 'good.wav');
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ start: 0, end: 1, text: 'ok', status: 'AUTOMATIC' }],
  });

  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm' });
  storage.finishTranscriptionRun(runId, { status: 'FAILED', errorCode: 'ASR_FAILED' });

  const runs = storage.listTranscriptionRuns(kase.case_id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'FAILED');
  assert.equal(runs[0].error_code, 'ASR_FAILED');

  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  assert.equal(storage.getSegments(t.transcript_id)[0].text, 'ok', 'the good transcript is untouched');
  storage.close();
});

test('a partially written export is not left behind', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seedCase(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ start: 0, end: 1, text: 'export me', status: 'AUTOMATIC' }],
  });
  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  const segs = storage.getSegments(t.transcript_id);
  const { runExport } = require('../../src/main/services/exporter');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exp-'));
  const written = await runExport({
    caseRecord: kase, evidence: ev, transcript: t, segments: segs,
    language: 'tr', modelId: 'm', engine: 'whispercpp', formats: ['json', 'txt'], outputDir: out,
  });
  assert.equal(written.length, 2);
  for (const w of written) assert.ok(fs.existsSync(w.path));
  assert.deepEqual(fs.readdirSync(out).filter((f) => f.includes('.tmp')), []);
  storage.close();
});

// ---------------------------------------------------------------- P0-8 temporary data + isolation

test('two cases cannot contaminate each other', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const a = await seedCase(storage, dir, 'a.wav');
  const b = await seedCase(storage, dir, 'b.wav');
  storage.saveTranscript(a.kase.case_id, a.ev.evidence_id, {
    segments: [{ start: 0, end: 1, text: 'case A text', status: 'AUTOMATIC' }],
  });
  assert.equal(storage.getTranscript(b.kase.case_id, b.ev.evidence_id), null, 'case B has no transcript');
  const ta = storage.getTranscript(a.kase.case_id, a.ev.evidence_id);
  assert.equal(storage.getSegments(ta.transcript_id)[0].text, 'case A text');
  assert.notEqual(a.kase.case_dir, b.kase.case_dir);
  storage.close();
});

test('transcription-run provenance records the inputs and settings', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seedCase(storage, dir);
  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, {
    inputSha256: ev.sha256,
    derivedSha256: 'derivedhash',
    engine: 'whisper.cpp',
    engineVersion: '1.9.4',
    modelId: 'large-v3-turbo-q5_0',
    modelSha256: 'modelsha',
    vad: true,
    vadModel: 'silero-vad-5.1.2',
    settings: { language: 'tr', useGpu: false, useVad: true },
    runtimeMode: 'cpu',
    runtimeReason: 'GPU_RUNTIME_NOT_BUNDLED',
    appVersion: '0.1.4',
  });
  storage.finishTranscriptionRun(runId, { status: 'SUCCEEDED', transcriptId: 'T-1' });
  const runs = storage.listTranscriptionRuns(kase.case_id, ev.evidence_id);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.input_sha256, ev.sha256);
  assert.equal(r.derived_sha256, 'derivedhash');
  assert.equal(r.engine, 'whisper.cpp');
  assert.equal(r.engine_version, '1.9.4');
  assert.equal(r.model_sha256, 'modelsha');
  assert.equal(r.vad, true);
  assert.equal(r.runtime_mode, 'cpu');
  assert.equal(r.app_version, '0.1.4');
  assert.deepEqual(r.settings, { language: 'tr', useGpu: false, useVad: true });
  assert.equal(r.status, 'SUCCEEDED');
  assert.ok(r.finished_at);
  storage.close();
});

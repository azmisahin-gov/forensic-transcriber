'use strict';

/**
 * P0 regression coverage for the trust/revision hardening pass:
 *   P0-3 real re-transcription with different run ids
 *   P0-4 case-archive provenance (runs + revisions)
 *   P0-5 atomic evidence import
 *   P0-6 fail-closed migration backup
 *   P0-7 binary-safe waveform on known PCM
 *   P0-8 memory-bounded waveform
 *   P0-9 multi-audio-stream policy
 *
 * Everything exercises real code and real files. FFmpeg-dependent tests skip
 * cleanly when FFmpeg is not installed rather than reporting a fake pass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Storage } = require('../../src/main/services/storage');
const { MediaService } = require('../../src/main/services/media');
const { parseSegments } = require('../../src/main/services/whisper');
const {
  buildCaseArchive,
  restoreCaseArchive,
  verifyCaseArchive,
} = require('../../src/main/services/case-archive');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-p0r-'));
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

async function seed(storage, dir, name = 'a.wav') {
  const kase = storage.createCase({ title: 'P0 case' });
  const src = path.join(dir, name);
  fs.writeFileSync(src, `RIFF-${name}`);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  return { kase, ev };
}

/** A 16-bit mono PCM WAV of constant amplitude, written directly. */
function writeConstantWav(filePath, sampleRate, seconds, value) {
  const samples = Math.round(sampleRate * seconds);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(value, 44 + i * 2);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ------------------------------------------------------ P0-3 real re-transcription

test('real re-transcription with different run ids preserves the human edit', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  // run-1 machine transcript, produced from real whisper-shaped output.
  const run1Segments = parseSegments(
    [{ offsets: { from: 0, to: 900 }, text: ' birinci', tokens: [{ text: ' birinci', offsets: { from: 0, to: 900 }, p: 0.9 }] }],
    'run1aaaa'
  );
  const run1 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm1' });
  const first = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: run1Segments, source: 'asr', runId: run1 });
  assert.deepEqual(first.segments.map((s) => s.segment_id), ['SEG-run1aaaa-0000']);

  // Human edit -> VERIFIED.
  const edited = run1Segments.map((s) => ({ ...s, text: 'insan doğrulaması', status: 'VERIFIED' }));
  const human = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited, source: 'review' });
  assert.equal(human.currentRevision.state, 'VERIFIED');
  const transcriptId = human.transcript.transcript_id;

  // run-2 with a genuinely different run id -> different segment ids.
  const run2Segments = parseSegments(
    [{ offsets: { from: 0, to: 1200 }, text: ' ikinci', tokens: [{ text: ' ikinci', offsets: { from: 0, to: 1200 }, p: 0.8 }] }],
    'run2bbbb'
  );
  assert.notEqual(run2Segments[0].segment_id, run1Segments[0].segment_id);
  const run2 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm2' });
  const second = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: run2Segments,
    source: 'asr',
    runId: run2,
  });

  // The answer to "does a new run silently destroy the previous human work?" is no.
  assert.equal(second.revisionBecameCurrent, false);
  assert.equal(storage.getCurrentRevisionInfo(transcriptId).state, 'VERIFIED');
  assert.equal(storage.getSegments(transcriptId)[0].text, 'insan doğrulaması');

  const revisions = storage.listRevisions(transcriptId);
  assert.equal(revisions.length, 3);
  assert.ok(revisions.some((r) => r.run_id === run1 && r.state === 'MACHINE'));
  assert.ok(revisions.some((r) => r.run_id === run2 && r.state === 'MACHINE'));
  assert.ok(revisions.some((r) => r.state === 'VERIFIED'));
  storage.close();
});

// ------------------------------------------------------ P0-4 archive provenance

test('archive restore preserves runs, revisions and their provenance', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, {
    inputSha256: ev.sha256,
    derivedSha256: 'derived-hash',
    engine: 'whisper.cpp',
    engineVersion: '1.9.4',
    modelId: 'large-v3-turbo-q5_0',
    modelSha256: 'model-hash',
    vad: true,
    vadModel: 'silero',
    settings: { language: 'tr', useVad: true },
    runtimeMode: 'cpu',
    runtimeReason: 'GPU_RUNTIME_NOT_BUNDLED',
    appVersion: '0.1.4',
  });
  const machine = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S-1', start: 0, end: 1, text: 'makine', status: 'AUTOMATIC' }],
    source: 'asr',
    runId,
  });
  storage.finishTranscriptionRun(runId, { status: 'SUCCEEDED', transcriptId: machine.transcript.transcript_id });
  const edited = [{ segment_id: 'S-1', start: 0, end: 1, text: 'insan', status: 'EDITED' }];
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited, source: 'review' });

  const srcRuns = storage.listTranscriptionRuns(kase.case_id);
  const srcRevisions = storage.listRevisions(machine.transcript.transcript_id);
  const srcHistory = storage.listHistory(kase.case_id).length;

  const { buffer, manifest } = await buildCaseArchive({ storage, caseId: kase.case_id });
  assert.equal(manifest.archive_version, 2);
  assert.equal(manifest.counts.transcript_revisions, srcRevisions.length);
  assert.equal(manifest.counts.transcription_runs, srcRuns.length);

  const verified = verifyCaseArchive(buffer);
  assert.equal(verified.ok, true, verified.errors.join('; '));

  const restored = await restoreCaseArchive({ storage, buffer });
  const rEvidence = storage.listEvidence(restored.caseId);
  assert.equal(rEvidence.length, 1);
  const rTranscript = storage.getTranscript(restored.caseId, rEvidence[0].evidence_id);
  const rRevisions = storage.listRevisions(rTranscript.transcript_id);
  const rRuns = storage.listTranscriptionRuns(restored.caseId);

  assert.equal(rRevisions.length, srcRevisions.length, 'revision count preserved');
  assert.equal(rRuns.length, srcRuns.length, 'run count preserved');

  // Revision states, current marker and the run -> revision edge survive.
  assert.equal(rRevisions.filter((r) => r.is_current).length, 1);
  assert.ok(rRevisions.some((r) => r.state === 'EDITED' && r.is_current));
  assert.ok(rRevisions.some((r) => r.run_id), 'restored revision keeps a run link');

  // Run provenance fields survive with fresh ids.
  const rRun = rRuns[0];
  assert.notEqual(rRun.run_id, runId, 'run id is regenerated');
  assert.equal(rRun.status, 'SUCCEEDED');
  assert.equal(rRun.engine, 'whisper.cpp');
  assert.equal(rRun.engine_version, '1.9.4');
  assert.equal(rRun.model_id, 'large-v3-turbo-q5_0');
  assert.equal(rRun.model_sha256, 'model-hash');
  assert.equal(rRun.input_sha256, ev.sha256);
  assert.equal(rRun.vad, true);
  assert.equal(rRun.runtime_mode, 'cpu');
  assert.equal(rRun.app_version, '0.1.4');
  assert.ok(rRun.started_at && rRun.finished_at, 'timestamps preserved');
  assert.equal(rRun.transcript_id, rTranscript.transcript_id, 'run -> transcript link remapped');

  assert.ok(storage.listHistory(restored.caseId).length >= srcHistory, 'history carried over');
  storage.close();
});

test('a v1 archive (no revisions) still restores as a single revision', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'v1 metin', status: 'EDITED' }],
    source: 'review',
  });

  // Build a current-format archive, then strip revisions and downgrade the
  // version to emulate a v1 archive.
  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });
  const zlib = require('node:zlib');
  const { createTar, readTar } = require('../../src/main/services/tar');
  const { sha256Buffer } = require('../../src/main/services/case-archive');
  const entries = readTar(zlib.gunzipSync(buffer));
  const caseEntry = entries.find((e) => e.name === 'database/case.json');
  const data = JSON.parse(caseEntry.data.toString('utf8'));
  data.transcripts = data.transcripts.map((t) => ({ transcript: t.transcript, segments: t.segments }));
  caseEntry.data = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  manifest.archive_version = 1;
  for (const f of manifest.files) {
    if (f.path === 'database/case.json') {
      f.sha256 = sha256Buffer(caseEntry.data);
      f.sizeBytes = caseEntry.data.length;
    }
  }
  manifestEntry.data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  entries.find((e) => e.name === 'manifest.sha256').data = Buffer.from(`${sha256Buffer(manifestEntry.data)}\n`, 'utf8');
  const v1 = zlib.gzipSync(createTar(entries), { level: 9 });

  assert.equal(verifyCaseArchive(v1).ok, true, 'v1 archive should still verify');
  const restored = await restoreCaseArchive({ storage, buffer: v1 });
  const rEv = storage.listEvidence(restored.caseId);
  const rT = storage.getTranscript(restored.caseId, rEv[0].evidence_id);
  const segs = storage.getSegments(rT.transcript_id);
  assert.equal(segs[0].text, 'v1 metin');
  assert.equal(segs[0].status, 'EDITED');
  assert.equal(storage.listRevisions(rT.transcript_id).length, 1, 'v1 segments become one revision');
  storage.close();
});

// ------------------------------------------------------ P0-5 atomic evidence import

test('a failed evidence copy leaves no row, no partial file and no temp file', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('running as root: directory permissions are not enforced');
    return;
  }
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Atomic import' });
  const src = path.join(dir, 'in.wav');
  fs.writeFileSync(src, 'payload');

  const originalDir = path.join(kase.case_dir, 'evidence', 'original');
  fs.chmodSync(originalDir, 0o500); // read + execute only: the copy must fail
  try {
    await assert.rejects(() => storage.importEvidence(kase.case_id, src, {}));
  } finally {
    fs.chmodSync(originalDir, 0o700);
  }

  assert.equal(storage.listEvidence(kase.case_id).length, 0, 'no evidence row for a failed import');
  const leftovers = fs.readdirSync(originalDir);
  assert.deepEqual(leftovers, [], 'a failed copy must leave the destination directory empty');

  // A subsequent import into the restored directory works normally.
  const ev = await storage.importEvidence(kase.case_id, src, {});
  assert.ok(ev.evidence_id);
  assert.equal(storage.listEvidence(kase.case_id).length, 1);
  storage.close();
});

// ------------------------------------------------------ P0-6 fail-closed migration

test('a failed pre-migration backup aborts the migration and keeps the data', () => {
  const dir = tmp();
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dir, 'forensic-transcriber.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1');
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', case_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO cases VALUES('C1','Korunacak','','${dir}','2020-01-01','2020-01-01');
  `);
  db.close();

  // The backup path embeds Date.now(). Pin it so we can occupy that exact path
  // with a directory; copyFileAtomic's final rename then fails, which is a real
  // "backup could not be written" condition.
  const fixedNow = 1700000000000;
  const backupPath = `${dbPath}.pre-migration-v1-${fixedNow}.bak`;
  fs.mkdirSync(backupPath);
  fs.writeFileSync(path.join(backupPath, 'blocker'), 'x'); // non-empty directory

  const realNow = Date.now;
  Date.now = () => fixedNow;
  let error = null;
  try {
    // eslint-disable-next-line no-new
    new Storage(dir);
  } catch (err) {
    error = err;
  } finally {
    Date.now = realNow;
  }

  assert.ok(error, 'opening must fail when the backup cannot be written');
  assert.equal(error.code, 'MIGRATION_BACKUP_FAILED');

  // The original database is intact and still at schema version 1.
  const check = new DatabaseSync(dbPath);
  const version = check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value;
  const title = check.prepare('SELECT title FROM cases WHERE case_id = ?').get('C1').title;
  check.close();
  assert.equal(version, '1', 'the failed migration must not bump the schema version');
  assert.equal(title, 'Korunacak', 'user data is untouched');

  // Remove the obstruction; the migration now proceeds and creates the backup.
  fs.rmSync(backupPath, { recursive: true, force: true });
  const storage = new Storage(dir);
  assert.ok(storage.lastMigration.backupPath);
  assert.equal(storage.getCase('C1').title, 'Korunacak');
  storage.close();
});

// ------------------------------------------------------ P0-7 binary-safe waveform

test('waveform peaks are read from real PCM bytes, not a lossy string', { skip: !hasFfmpeg() }, async () => {
  const dir = tmp();
  const media = new MediaService();
  // Constant full-scale 16-bit samples: bytes are 0xFF 0x7F, which are invalid
  // UTF-8. A string round-trip would corrupt them; binary reads must not.
  const wav = writeConstantWav(path.join(dir, 'const.wav'), 16000, 1, 32767);

  const result = await media.waveformPeaks(wav, 100);
  assert.ok(result.peaks.length > 0, 'peaks must be produced');
  for (const p of result.peaks) {
    assert.ok(p >= 0.99, `expected a near-full-scale peak, got ${p}`);
  }
});

test('waveform peaks reflect known half-scale amplitude', { skip: !hasFfmpeg() }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const wav = writeConstantWav(path.join(dir, 'half.wav'), 16000, 1, 16384); // 0.5 full scale
  const result = await media.waveformPeaks(wav, 64);
  assert.ok(result.peaks.length > 0);
  for (const p of result.peaks) {
    assert.ok(Math.abs(p - 0.5) <= 0.02, `expected ~0.5, got ${p}`);
  }
  // Memory-bounded output: at most the requested bucket count.
  assert.ok(result.buckets <= 64);
});

test('a longer recording yields a deterministic, bounded peak array', { skip: !hasFfmpeg() }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const wav = writeConstantWav(path.join(dir, 'long.wav'), 16000, 30, 8192); // 30 s
  const a = await media.waveformPeaks(wav, 1600);
  const b = await media.waveformPeaks(wav, 1600);
  assert.deepEqual(a, b, 'the same input must yield the same peaks');
  assert.ok(a.buckets <= 1600, 'output is bounded by the requested bucket count');
  assert.ok(a.peaks.every((p) => p >= 0 && p <= 1));
});

test('waveform computation fails cleanly on a non-audio file', { skip: !hasFfmpeg() }, async () => {
  const dir = tmp();
  const media = new MediaService();
  const bad = path.join(dir, 'bad.bin');
  fs.writeFileSync(bad, 'not audio');
  await assert.rejects(() => media.waveformPeaks(bad, 100), (err) => err.code === 'WAVEFORM_FAILED');
});

// ------------------------------------------------------ recovery: save -> restart -> reopen

test('revisions and the current marker survive close and reopen', async () => {
  const dir = tmp();
  const s1 = new Storage(dir);
  const { kase, ev } = await seed(s1, dir);
  const run = s1.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm' });
  s1.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'makine', status: 'AUTOMATIC' }],
    source: 'asr',
    runId: run,
  });
  s1.finishTranscriptionRun(run, { status: 'SUCCEEDED' });
  s1.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'insan', status: 'VERIFIED' }],
    source: 'review',
  });
  const transcriptId = s1.getTranscript(kase.case_id, ev.evidence_id).transcript_id;
  const beforeRevisions = s1.listRevisions(transcriptId);
  s1.close();

  const s2 = new Storage(dir);
  const t = s2.getTranscript(kase.case_id, ev.evidence_id);
  assert.equal(t.transcript_id, transcriptId);
  const afterRevisions = s2.listRevisions(transcriptId);
  assert.equal(afterRevisions.length, beforeRevisions.length);
  assert.equal(afterRevisions.filter((r) => r.is_current).length, 1);
  assert.equal(s2.getCurrentRevisionInfo(transcriptId).state, 'VERIFIED');
  assert.equal(s2.getSegments(transcriptId)[0].text, 'insan');
  assert.equal(s2.getSegments(transcriptId)[0].original_text, 'makine');
  s2.close();
});

// ------------------------------------------------------ export revision linkage

test('an export records the transcript revision it was rendered from', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'metin', status: 'EDITED' }],
    source: 'review',
  });
  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  const revision = storage.getCurrentRevisionInfo(t.transcript_id);
  const { runExport } = require('../../src/main/services/exporter');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-p0exp-'));
  const written = await runExport({
    caseRecord: kase,
    evidence: ev,
    transcript: t,
    segments: storage.getSegments(t.transcript_id),
    revision,
    language: 'tr',
    modelId: 'm',
    engine: 'whisper.cpp',
    formats: ['json', 'txt', 'html'],
    outputDir: out,
  });
  const jsonPath = written.find((w) => w.format === 'json').path;
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(parsed.transcript_revision.revision_id, revision.revision_id);
  assert.equal(parsed.transcript_revision.state, 'EDITED');

  const txt = fs.readFileSync(written.find((w) => w.format === 'txt').path, 'utf8');
  assert.match(txt, new RegExp(`Transcript revision: ${revision.revision_id} \\(EDITED\\)`));
  const html = fs.readFileSync(written.find((w) => w.format === 'html').path, 'utf8');
  assert.match(html, new RegExp(`Transcript revision ${revision.revision_id} \\(EDITED\\)`));
  storage.close();
});

// ------------------------------------------------------ P0-9 multi-audio-stream policy

test('a multi-audio-stream container reports every stream and the chosen order', { skip: !hasFfmpeg() }, async (t) => {
  const dir = tmp();
  const media = new MediaService();
  const wav1 = writeConstantWav(path.join(dir, 's1.wav'), 16000, 1, 8000);
  const wav2 = writeConstantWav(path.join(dir, 's2.wav'), 16000, 1, 16000);
  const multi = path.join(dir, 'multi.mkv');
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav1, '-i', wav2, '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', '-f', 'matroska', multi],
    { stdio: 'ignore' }
  );
  if (run.status !== 0) {
    t.skip('ffmpeg could not build a multi-stream fixture');
    return;
  }

  const probed = await media.probe(multi);
  assert.equal(probed.audioStreamCount, 2, 'both audio streams must be reported');
  assert.equal(probed.audioStreams.length, 2);
  assert.equal(probed.selectedAudioStreamOrder, 0, 'the default selection is order 0');

  // Decoding accepts an explicit order and produces a working copy.
  const out = path.join(dir, 'out.wav');
  await media.toAsrWav(multi, out, { audioStreamOrder: 1 });
  assert.ok(fs.existsSync(out));

  // The selected stream is stored on evidence so the choice is visible.
  const storage = new Storage(tmp());
  const kase = storage.createCase({ title: 'Multi stream' });
  const ev = await storage.importEvidence(kase.case_id, multi, probed);
  assert.equal(storage.getEvidence(ev.evidence_id).audio_stream_count, 2);
  storage.close();
});

'use strict';

/**
 * P0 integration-level reliability checks that touch the real filesystem:
 * log privacy, interrupted model installation, low-disk behaviour, and
 * temporary-file hygiene.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger, redact } = require('../../src/main/services/logger');
const { ModelManager } = require('../../src/main/services/model-manager');
const { writeFileAtomic } = require('../../src/main/services/atomic');
const { Storage } = require('../../src/main/services/storage');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-p0i-'));
}

// ---------------------------------------------------------------- log privacy

test('the logger redacts transcript text and long content', () => {
  const dir = tmp();
  const logger = new Logger(dir);
  logger.info('transcript saved', {
    caseId: 'CASE-1',
    segments: [{ text: 'gizli konuşma metni' }],
    text: 'a very long piece of transcript text'.repeat(20),
  });
  const line = fs.readFileSync(logger.file, 'utf8');
  assert.ok(!line.includes('gizli konuşma metni'), 'segment text must never be logged');
  assert.ok(!line.includes('a very long piece'), 'long free text must be redacted');
  assert.ok(line.includes('CASE-1'), 'non-sensitive identifiers are kept');
});

test('redact collapses the home directory and caps string length', () => {
  const home = os.homedir();
  assert.equal(redact(`${home}/cases/x`), '~/cases/x');
  assert.match(redact('x'.repeat(500)), /redacted 500 chars/);
  assert.equal(redact({ text: 'secret' }).text, '<redacted>');
});

test('application logs contain no evidence content after a real workflow', async () => {
  const dir = tmp();
  const logger = new Logger(dir);
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Log test' });
  const src = path.join(dir, 'gizli-kayit.wav');
  const secretContent = 'GIZLI-SES-ICERIGI-'.repeat(30);
  fs.writeFileSync(src, secretContent);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'gizli transcript', status: 'EDITED' }],
  });
  logger.info('workflow done', { caseId: kase.case_id, evidenceId: ev.evidence_id });
  storage.close();

  const logs = fs.readFileSync(logger.file, 'utf8');
  assert.ok(!logs.includes('gizli transcript'), 'no transcript text in logs');
  assert.ok(!logs.includes('GIZLI-SES-ICERIGI'), 'no audio bytes in logs');
});

// ---------------------------------------------------------------- interrupted model install

test('an interrupted model install leaves no usable model and no partial file trap', async () => {
  const dir = tmp();
  const mm = new ModelManager(dir);
  const target = mm.pathFor('large-v3-turbo-q5_0');
  // Simulate a download that was interrupted: a partial file exists.
  fs.writeFileSync(`${target}.partial`, 'half a model');

  const models = await mm.list();
  const entry = models.find((m) => m.id === 'large-v3-turbo-q5_0');
  assert.equal(entry.installed, false, 'a .partial file must not count as installed');
  assert.equal(mm.resolvePath('large-v3-turbo-q5_0'), null, 'resolvePath must ignore a partial file');
});

test('a model import with the wrong checksum is rejected and the partial is removed', async () => {
  const dir = tmp();
  const mm = new ModelManager(dir);
  const bad = path.join(dir, 'bad-model.bin');
  fs.writeFileSync(bad, 'not the real model');
  await assert.rejects(
    () => mm.importFromFile('large-v3-turbo-q5_0', bad),
    (err) => err.code === 'MODEL_CHECKSUM_MISMATCH'
  );
  assert.equal(fs.existsSync(`${mm.pathFor('large-v3-turbo-q5_0')}.partial`), false, 'partial must be cleaned up');
  assert.equal(mm.resolvePath('large-v3-turbo-q5_0'), null);
});

// ---------------------------------------------------------------- low disk

test('a write that fails for lack of space fails cleanly', (t) => {
  // /dev/full always reports ENOSPC on write, which is a deterministic way to
  // exercise the out-of-space branch without mounting a small filesystem.
  if (!fs.existsSync('/dev/full')) {
    t.skip('/dev/full is not available');
    return;
  }
  assert.throws(
    () => writeFileAtomic('/dev/full', Buffer.from('x')),
    (err) => ['ENOSPC', 'EIO', 'EFBIG', 'EINVAL', 'EACCES'].includes(err.code),
    'writing to a full device must fail with a filesystem error'
  );
});

// ---------------------------------------------------------------- temp hygiene

test('no temporary files remain in a case directory after normal work', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Temp hygiene' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'x');
  const ev = await storage.importEvidence(kase.case_id, src, {});
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'x', status: 'AUTOMATIC' }],
  });
  const { runExport } = require('../../src/main/services/exporter');
  const t = storage.getTranscript(kase.case_id, ev.evidence_id);
  await runExport({
    caseRecord: kase, evidence: ev, transcript: t,
    segments: storage.getSegments(t.transcript_id),
    language: 'tr', modelId: 'm', engine: 'whispercpp', formats: ['json', 'txt', 'srt', 'html'],
  });
  storage.close();

  const found = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.includes('.tmp')) found.push(full);
    }
  };
  walk(kase.case_dir);
  assert.deepEqual(found, [], 'no .tmp files should remain');
});

test('the database, its WAL and its temp files stay inside the data directory', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Isolation' });
  const srcDir = tmp();
  const src = path.join(srcDir, 'a.wav');
  fs.writeFileSync(src, 'x');
  await storage.importEvidence(kase.case_id, src, {});
  storage.close();

  const top = fs.readdirSync(dir).sort();
  // Only expected artefacts: the db, its WAL/SHM sidecars, and cases/.
  for (const name of top) {
    assert.ok(
      name === 'cases' || name.startsWith('forensic-transcriber.db'),
      `unexpected file in the data directory: ${name}`
    );
  }
});

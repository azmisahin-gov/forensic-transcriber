'use strict';

/**
 * P0-1: case archive export / import.
 *
 * Verifies that a case's working products round-trip through a deterministic,
 * versioned archive, that tampering is detected, and that a restore never
 * overwrites an existing case.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { Storage } = require('../../src/main/services/storage');
const {
  buildCaseArchive,
  writeCaseArchive,
  verifyCaseArchive,
  restoreCaseArchive,
  ARCHIVE_VERSION,
} = require('../../src/main/services/case-archive');
const { readTar, createTar } = require('../../src/main/services/tar');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-arc-'));
}

async function seedCase(storage, dir, files = ['a.wav']) {
  const kase = storage.createCase({ title: 'Archive case', notes: 'not' });
  const evidence = [];
  for (const f of files) {
    const src = path.join(dir, f);
    fs.writeFileSync(src, `content-of-${f}`);
    evidence.push(await storage.importEvidence(kase.case_id, src, { sampleRate: 16000, channels: 1 }));
  }
  return { kase, evidence };
}

test('a case archive round-trips case, evidence, transcripts and history', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, evidence } = await seedCase(storage, dir, ['a.wav', 'b.wav']);
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'otomatik', status: 'AUTOMATIC' }],
  });
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ segment_id: 'S1', start: 0, end: 1, text: 'düzeltildi', status: 'EDITED' }],
  });

  const archivePath = path.join(dir, 'case.ftcase.tar.gz');
  const written = await writeCaseArchive({ storage, caseId: kase.case_id, destPath: archivePath });
  assert.ok(fs.existsSync(archivePath));
  assert.equal(written.manifest.archive_version, ARCHIVE_VERSION);
  assert.equal(written.manifest.counts.evidence, 2);

  const buffer = fs.readFileSync(archivePath);
  const verified = verifyCaseArchive(buffer);
  assert.equal(verified.ok, true, verified.errors.join('; '));

  // Restore into the same storage (new case id).
  const restored = await restoreCaseArchive({ storage, buffer });
  assert.notEqual(restored.caseId, kase.case_id, 'restore must create a new case');

  // Case metadata preserved.
  assert.equal(storage.getCase(restored.caseId).title, 'Archive case');
  // Evidence count and hashes preserved.
  const originalEvidence = storage.listEvidence(kase.case_id);
  const restoredEvidence = storage.listEvidence(restored.caseId);
  assert.equal(restoredEvidence.length, originalEvidence.length);
  const origHashes = originalEvidence.map((e) => e.sha256).sort();
  const newHashes = restoredEvidence.map((e) => e.sha256).sort();
  assert.deepEqual(newHashes, origHashes, 'evidence hashes must survive the round trip');

  // Transcript, including automatic text and status, preserved.
  const rt = storage.getTranscript(restored.caseId, restoredEvidence[0].evidence_id);
  const segs = storage.getSegments(rt.transcript_id);
  assert.equal(segs[0].text, 'düzeltildi');
  assert.equal(segs[0].original_text, 'otomatik');
  assert.equal(segs[0].status, 'EDITED');

  // The restore is recorded in history.
  const history = storage.listHistory(restored.caseId);
  assert.ok(history.some((h) => h.action === 'ARCHIVE_RESTORED'));
  storage.close();
});

test('the archive is deterministic: the same case produces identical bytes', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, evidence } = await seedCase(storage, dir, ['a.wav', 'b.wav']);
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ start: 0, end: 1, text: 'x', status: 'AUTOMATIC' }],
  });

  const one = await buildCaseArchive({ storage, caseId: kase.case_id });
  const two = await buildCaseArchive({ storage, caseId: kase.case_id });
  assert.equal(one.buffer.toString('hex'), two.buffer.toString('hex'),
    'archiving the same case twice must yield identical bytes');
  storage.close();
});

test('a tampered archive is rejected with a clear reason', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, evidence } = await seedCase(storage, dir);
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ start: 0, end: 1, text: 'x', status: 'AUTOMATIC' }],
  });
  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });

  // Flip one byte inside the evidence payload by rebuilding the tar with a
  // modified evidence entry.
  const entries = readTar(zlib.gunzipSync(buffer));
  const evEntry = entries.find((e) => e.name.startsWith('evidence/original/'));
  evEntry.data = Buffer.from('tampered');
  const tampered = zlib.gzipSync(createTar(entries), { level: 9 });

  const result = verifyCaseArchive(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /hash mismatch/.test(e)), result.errors.join('; '));

  await assert.rejects(
    () => restoreCaseArchive({ storage, buffer: tampered }),
    (err) => err.code === 'ARCHIVE_INVALID'
  );
  storage.close();
});

test('a truncated archive is rejected, not partially restored', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, evidence } = await seedCase(storage, dir);
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ start: 0, end: 1, text: 'x', status: 'AUTOMATIC' }],
  });
  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });
  const truncated = buffer.subarray(0, Math.floor(buffer.length / 2));
  const before = storage.listCases().length;
  await assert.rejects(() => restoreCaseArchive({ storage, buffer: truncated }));
  assert.equal(storage.listCases().length, before + 0, 'no partial case should be created');
  storage.close();
});

test('restoring never overwrites an existing case', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, evidence } = await seedCase(storage, dir);
  storage.saveTranscript(kase.case_id, evidence[0].evidence_id, {
    segments: [{ start: 0, end: 1, text: 'original', status: 'AUTOMATIC' }],
  });
  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });

  const before = storage.listCases().length;
  await restoreCaseArchive({ storage, buffer });
  await restoreCaseArchive({ storage, buffer });
  assert.equal(storage.listCases().length, before + 2, 'each restore is a new case');

  // The original case is untouched.
  const t = storage.getTranscript(kase.case_id, evidence[0].evidence_id);
  assert.equal(storage.getSegments(t.transcript_id)[0].text, 'original');
  storage.close();
});

test('a 100+ evidence case archives and restores without loss', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const names = Array.from({ length: 120 }, (_, i) => `rec-${String(i).padStart(3, '0')}.wav`);
  const { kase, evidence } = await seedCase(storage, dir, names);
  assert.equal(evidence.length, 120);
  // Give a few of them transcripts so segments are exercised too.
  for (const ev of evidence.slice(0, 5)) {
    storage.saveTranscript(kase.case_id, ev.evidence_id, {
      segments: [{ start: 0, end: 1, text: `t-${ev.evidence_id}`, status: 'AUTOMATIC' }],
    });
  }

  const { buffer, manifest } = await buildCaseArchive({ storage, caseId: kase.case_id });
  assert.equal(manifest.counts.evidence, 120);
  assert.equal(manifest.counts.transcripts, 5);

  const verified = verifyCaseArchive(buffer);
  assert.equal(verified.ok, true, verified.errors.slice(0, 3).join('; '));

  const restored = await restoreCaseArchive({ storage, buffer });
  const restoredEvidence = storage.listEvidence(restored.caseId);
  assert.equal(restoredEvidence.length, 120);
  assert.deepEqual(
    restoredEvidence.map((e) => e.sha256).sort(),
    evidence.map((e) => e.sha256).sort(),
    'all 120 evidence hashes survive'
  );
  storage.close();
});

test('duplicate file names across a case archive stay distinct', async () => {
  const dir = tmp();
  const subA = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dup-a-'));
  const subB = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dup-b-'));
  fs.writeFileSync(path.join(subA, 'same.wav'), 'first');
  fs.writeFileSync(path.join(subB, 'same.wav'), 'second');

  const storage = new Storage(dir);
  const kase = storage.createCase({ title: 'Dup names' });
  await storage.importEvidence(kase.case_id, path.join(subA, 'same.wav'), {});
  await storage.importEvidence(kase.case_id, path.join(subB, 'same.wav'), {});
  assert.equal(storage.listEvidence(kase.case_id).length, 2);

  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });
  const restored = await restoreCaseArchive({ storage, buffer });
  const restoredEvidence = storage.listEvidence(restored.caseId);
  assert.equal(restoredEvidence.length, 2);
  assert.notEqual(restoredEvidence[0].sha256, restoredEvidence[1].sha256);
  storage.close();
});

'use strict';

/**
 * Analysis layer + archive v3 regression coverage (P1 professionalization,
 * phase 4). Everything exercises the real storage/archive code and real files:
 * the passage/claim/source/verification graph, the mandatory context window, the
 * archive round-trip with id remapping, and the additive schema-7 migration.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage, SCHEMA_VERSION } = require('../../src/main/services/storage');
const {
  buildCaseArchive,
  restoreCaseArchive,
  verifyCaseArchive,
  ARCHIVE_VERSION,
} = require('../../src/main/services/case-archive');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-analysis-'));
}

async function seed(storage, dir, name = 'a.wav') {
  const kase = storage.createCase({ title: 'Analysis case' });
  const src = path.join(dir, name);
  fs.writeFileSync(src, `RIFF-${name}`);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  return { kase, ev };
}

test('a passage always carries a context window and a real revision link', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { engine: 'whisper.cpp' });
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S-1', start: 10, end: 14, text: 'söylenen söz', status: 'AUTOMATIC' }],
    source: 'asr',
    runId,
  });
  const revisionId = saved.revision ? saved.revision.revision_id : saved.revision_id;

  const passage = storage.createPassage(kase.case_id, {
    evidenceId: ev.evidence_id,
    transcriptId: saved.transcript.transcript_id,
    revisionId,
    startSeconds: 10,
    endSeconds: 14,
    text: 'söylenen söz',
    speechAct: 'REALITY_CLAIM',
    confidence: 'HIGH',
  });
  assert.equal(passage.revision_id, revisionId, 'the passage records the exact revision it came from');
  assert.ok(passage.context_before_seconds > 0 && passage.context_after_seconds > 0, 'context is mandatory');
});

test('a passage without a context window is refused with a stable code', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  assert.throws(
    () => storage.createPassage(kase.case_id, {
      evidenceId: ev.evidence_id, startSeconds: 1, endSeconds: 2, text: 'x',
      contextBeforeSeconds: 0, contextAfterSeconds: 0,
    }),
    (err) => err.code === 'CONTEXT_REQUIRED'
  );
});

test('a claim separates what was said from the alleged meaning', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  const passage = storage.createPassage(kase.case_id, { evidenceId: ev.evidence_id, startSeconds: 1, endSeconds: 3, text: 'as-stated text' });
  const claim = storage.createClaim(kase.case_id, {
    passageId: passage.passage_id,
    asStated: 'as-stated text',
    allegedMeaning: 'the alleged meaning',
    assertedBy: 'party A',
  });
  assert.equal(claim.as_stated, 'as-stated text');
  assert.equal(claim.alleged_meaning, 'the alleged meaning');
  assert.notEqual(claim.as_stated, claim.alleged_meaning, 'the two fields are never merged');
  assert.equal(claim.verification, 'PENDING');
});

test('an invalid enum is rejected rather than silently stored', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  assert.throws(
    () => storage.createPassage(kase.case_id, { evidenceId: ev.evidence_id, startSeconds: 1, endSeconds: 2, speechAct: 'NOT_A_TYPE' }),
    (err) => err.code === 'INVALID_INPUT'
  );
});

test('the context reader returns only stored transcript segments in the window', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [
      { segment_id: 'S-1', start: 0, end: 5, text: 'uzak', status: 'AUTOMATIC' },
      { segment_id: 'S-2', start: 58, end: 62, text: 'yakın', status: 'AUTOMATIC' },
      { segment_id: 'S-3', start: 200, end: 205, text: 'çok uzak', status: 'AUTOMATIC' },
    ],
    source: 'asr',
  });
  const ctx = storage.getAnalysisContext(ev.evidence_id, 60, 61, 30);
  assert.equal(ctx.window_seconds, 30);
  assert.equal(ctx.from_seconds, 30);
  assert.equal(ctx.to_seconds, 91);
  const ids = ctx.segments.map((s) => s.segment_id);
  assert.deepEqual(ids, ['S-2'], 'only the in-window segment is returned');
});

test('archive v3 round-trips the analysis graph with remapped ids', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { engine: 'whisper.cpp' });
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [{ segment_id: 'S-1', start: 5, end: 9, text: 'metin', status: 'AUTOMATIC' }],
    source: 'asr',
    runId,
  });
  const revisionId = saved.revision ? saved.revision.revision_id : saved.revision_id;
  const passage = storage.createPassage(kase.case_id, {
    evidenceId: ev.evidence_id, revisionId, startSeconds: 5, endSeconds: 9, text: 'metin',
    speechAct: 'QUOTATION', confidence: 'LOW',
  });
  const claim = storage.createClaim(kase.case_id, { passageId: passage.passage_id, asStated: 'a', allegedMeaning: 'b', verification: 'VERIFIED' });
  storage.createSource(kase.case_id, { claimId: claim.claim_id, passageId: passage.passage_id, kind: 'PRIMARY', title: 'belge', citation: 'no:1', verification: 'VERIFIED' });
  storage.createVerification(kase.case_id, { claimId: claim.claim_id, claimText: 'a', status: 'NOT_VERIFIABLE', note: 'kaynak yok' });

  const { buffer, manifest } = await buildCaseArchive({ storage, caseId: kase.case_id });
  assert.equal(manifest.archive_version, ARCHIVE_VERSION);
  assert.equal(manifest.counts.passages, 1);
  assert.equal(manifest.counts.claims, 1);
  assert.equal(manifest.counts.sources, 1);
  assert.equal(manifest.counts.verifications, 1);
  assert.equal(verifyCaseArchive(buffer).ok, true);

  const restored = await restoreCaseArchive({ storage, buffer });
  const rPassages = storage.listPassages(restored.caseId);
  const rClaims = storage.listClaims(restored.caseId);
  const rSources = storage.listSources(restored.caseId);
  const rVerifications = storage.listVerifications(restored.caseId);

  assert.equal(rPassages.length, 1);
  assert.equal(rClaims.length, 1);
  assert.equal(rSources.length, 1);
  assert.equal(rVerifications.length, 1);

  // Ids are regenerated, but the graph edges survive through remapping.
  assert.notEqual(rPassages[0].passage_id, passage.passage_id);
  assert.equal(rClaims[0].passage_id, rPassages[0].passage_id, 'claim -> passage edge preserved');
  assert.equal(rSources[0].claim_id, rClaims[0].claim_id, 'source -> claim edge preserved');
  assert.equal(rVerifications[0].claim_id, rClaims[0].claim_id, 'verification -> claim edge preserved');
  assert.equal(rPassages[0].speech_act, 'QUOTATION');
  assert.equal(rPassages[0].confidence, 'LOW');
  assert.equal(rVerifications[0].status, 'NOT_VERIFIABLE');
});

test('restoring an archive never overwrites the source case', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.createPassage(kase.case_id, { evidenceId: ev.evidence_id, startSeconds: 1, endSeconds: 2, text: 'orijinal' });
  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });
  const restored = await restoreCaseArchive({ storage, buffer });
  assert.notEqual(restored.caseId, kase.case_id);
  assert.equal(storage.listPassages(kase.case_id).length, 1, 'source case is untouched');
  assert.equal(storage.listPassages(restored.caseId).length, 1, 'restored case has its own passage');
});

test('a fresh database reports schema 7 and carries the analysis tables', () => {
  const dir = tmp();
  const storage = new Storage(dir);
  assert.equal(SCHEMA_VERSION, 7);
  assert.equal(storage.stats().schemaVersion, 7);
  const kase = storage.createCase({ title: 'schema' });
  assert.deepEqual(storage.listPassages(kase.case_id), []);
  assert.deepEqual(storage.listClaims(kase.case_id), []);
  assert.deepEqual(storage.listSources(kase.case_id), []);
  assert.deepEqual(storage.listVerifications(kase.case_id), []);
});

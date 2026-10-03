'use strict';

/**
 * P0-1 transcription run lifecycle and P0-2/P0-3 transcript revisions.
 *
 * These run real code: the run/ revision tables in Storage, not mocks. The
 * lifecycle test proves every started run reaches a terminal state with
 * finished_at set; the revision tests prove a new ASR run cannot silently
 * destroy human reviewed/edited/verified work.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const { REVISION_STATE } = require('../../src/shared/constants');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-rev-'));
}

async function seed(storage, dir, name = 'a.wav') {
  const kase = storage.createCase({ title: 'Revision case' });
  const src = path.join(dir, name);
  fs.writeFileSync(src, `RIFF-${name}`);
  const ev = await storage.importEvidence(kase.case_id, src, {});
  return { kase, ev };
}

function machineSegs(runTag, count = 3, text = 'makine metni') {
  return Array.from({ length: count }, (_, i) => ({
    segment_id: `SEG-${runTag}-${String(i).padStart(4, '0')}`,
    start: i,
    end: i + 0.9,
    speaker: 'SPEAKER_01',
    text: `${text} ${i}`,
    status: 'AUTOMATIC',
    confidence: 0.9,
    words: null,
  }));
}

// ---------------------------------------------------------- P0-1 run lifecycle

test('every transcription run reaches a terminal state with finished_at set', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const statuses = [
    ['SUCCEEDED', null],
    ['FAILED', 'ASR_FAILED'],
    ['CANCELLED', 'TRANSCRIPTION_CANCELLED'],
  ];
  for (const [status, errorCode] of statuses) {
    const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm', engine: 'whisper.cpp' });
    const started = storage.listTranscriptionRuns(kase.case_id, ev.evidence_id).find((r) => r.run_id === runId);
    assert.equal(started.status, 'STARTED');
    assert.equal(started.finished_at, null);

    storage.finishTranscriptionRun(runId, { status, errorCode });
    const finished = storage.listTranscriptionRuns(kase.case_id, ev.evidence_id).find((r) => r.run_id === runId);
    assert.equal(finished.status, status);
    assert.ok(finished.finished_at, `${status} run must have finished_at`);
    if (errorCode) assert.equal(finished.error_code, errorCode);
  }

  const all = storage.listTranscriptionRuns(kase.case_id, ev.evidence_id);
  assert.equal(all.filter((r) => r.status === 'STARTED').length, 0, 'no orphan STARTED runs remain');
  storage.close();
});

// ----------------------------------------------- P0-1/2 handler scope guard
// The original bug put `runId` inside the try, so the catch raised a second
// ReferenceError that masked the real error. Guard the structure in source:
// runId must be declared before the try, and the catch must use the safe finisher.
test('transcription handler declares runId before try and closes runs safely', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  const startIdx = source.indexOf('handle(IPC.TRANSCRIBE_START');
  assert.ok(startIdx > 0, 'transcribe handler must exist');
  const endIdx = source.indexOf('handle(IPC.TRANSCRIBE_CANCEL', startIdx);
  const handler = source.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 6000);

  const letRunIdx = handler.indexOf('let runId = null');
  const tryIdx = handler.indexOf('try {');
  assert.ok(letRunIdx > 0, 'runId must be declared with let');
  assert.ok(tryIdx > letRunIdx, 'runId must be declared before the try block');
  assert.ok(!/const runId = storage\.startTranscriptionRun/.test(handler), 'runId must be assigned, not redeclared');
  assert.match(handler, /runId = storage\.startTranscriptionRun/);
  assert.match(handler, /finishRun\(/, 'the catch must close the run through the safe finisher');
});

// ------------------------------------------------------------- P0-2 revisions

test('a first ASR save creates a current MACHINE revision linked to the run', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm' });
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: machineSegs('run1'),
    source: 'asr',
    runId,
  });
  assert.equal(saved.revisionBecameCurrent, true);
  assert.equal(saved.revision.state, REVISION_STATE.MACHINE);
  assert.equal(saved.revision.run_id, runId);

  const revisions = storage.listRevisions(saved.transcript.transcript_id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].is_current, true);
  storage.close();
});

test('a new ASR run does not overwrite verified human work', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  // run1 -> machine transcript -> expert edit -> VERIFIED
  const run1 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm' });
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: machineSegs('run1'), source: 'asr', runId: run1 });
  const edited = machineSegs('run1');
  edited[0].text = 'düzeltilmiş insan metni';
  edited[0].status = 'VERIFIED';
  const human = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited, source: 'review' });
  assert.equal(human.currentRevision.state, REVISION_STATE.VERIFIED);
  const transcriptId = human.transcript.transcript_id;

  // run2 -> new machine transcript
  const run2 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm2' });
  const run2result = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: machineSegs('run2', 5, 'yeni makine'),
    source: 'asr',
    runId: run2,
  });
  assert.equal(run2result.revisionBecameCurrent, false, 'run2 must not become current');
  assert.equal(run2result.revision.state, REVISION_STATE.MACHINE);
  assert.equal(run2result.revision.run_id, run2);

  // The human revision is still current and its text is intact.
  const current = storage.getCurrentRevisionInfo(transcriptId);
  assert.equal(current.state, REVISION_STATE.VERIFIED);
  const live = storage.getSegments(transcriptId);
  assert.equal(live[0].text, 'düzeltilmiş insan metni');

  // Both revisions are readable; nothing was destroyed.
  const revisions = storage.listRevisions(transcriptId);
  assert.equal(revisions.length, 3, 'run1 machine + human VERIFIED + run2 machine');
  assert.equal(revisions.filter((r) => r.is_current).length, 1);
  assert.ok(revisions.some((r) => r.state === REVISION_STATE.MACHINE && r.run_id === run2));
  assert.ok(revisions.some((r) => r.state === REVISION_STATE.VERIFIED));
  storage.close();
});

test('the operator can explicitly accept the new machine revision', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const run1 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm' });
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: machineSegs('run1'), source: 'asr', runId: run1 });
  const edited = machineSegs('run1');
  edited[0].text = 'insan';
  edited[0].status = 'EDITED';
  const human = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited, source: 'review' });

  const run2 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm2' });
  const r2 = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: machineSegs('run2', 4, 'run2'),
    source: 'asr',
    runId: run2,
  });

  // Explicitly promote the run2 machine revision.
  const promoted = storage.setCurrentRevision(r2.revision.revision_id);
  assert.equal(promoted.currentRevision.revision_id, r2.revision.revision_id);
  assert.equal(promoted.currentRevision.state, REVISION_STATE.MACHINE);
  assert.equal(promoted.segments.length, 4);

  // The earlier human revision is still stored and readable.
  const revisions = storage.listRevisions(human.transcript.transcript_id);
  assert.ok(revisions.some((r) => r.state === REVISION_STATE.EDITED));
  storage.close();
});

test('the automatic text survives a human edit across revisions', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: machineSegs('run1', 1, 'otomatik'), source: 'asr' });
  const edited = machineSegs('run1', 1, 'otomatik');
  edited[0].text = 'düzeltilmiş';
  edited[0].status = 'EDITED';
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: edited, source: 'review' });
  assert.equal(saved.segments[0].text, 'düzeltilmiş');
  assert.equal(saved.segments[0].original_text, 'otomatik 0');
  storage.close();
});

test('setting an unknown revision fails with a stable code', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  await seed(storage, dir);
  assert.throws(() => storage.setCurrentRevision('REV-does-not-exist'), (err) => err.code === 'REVISION_NOT_FOUND');
  storage.close();
});

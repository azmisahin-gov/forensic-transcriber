'use strict';

/**
 * V1 professionalization regression tests.
 *
 * These exercise the real services (no mocks): append-only report revisions,
 * structured findings with source links, the FTS5 search index and its LIKE
 * fallback, windowed transcript paging, SQL dashboard aggregates, archive
 * provenance round-tripping and the local UYAP hand-off. The core invariant
 * stays: machine output and expert work never overwrite each other.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const { buildCaseArchive, restoreCaseArchive } = require('../../src/main/services/case-archive');
const { prepareUyapPackage } = require('../../src/main/services/delivery');
const aiAssist = require('../../src/main/services/assist');
const { REPORT_REVISION_STATE } = require('../../src/shared/constants');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-v1-'));
}

function seg(id, start, text, status = 'AUTOMATIC') {
  return { segment_id: id, start, end: start + 1, speaker: 'SPK', text, status, confidence: 0.9 };
}

async function seed(storage, dir) {
  const kase = storage.createCase({ title: 'V1 işi', file_number: '2026/12' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'RIFF-fake-audio');
  const ev = await storage.importEvidence(kase.case_id, src, { durationSeconds: 30, sampleRate: 16000 });
  return { kase, ev };
}

// ------------------------------------------------------- report revisions
test('report saves append immutable revisions and never overwrite a FINAL', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase } = await seed(storage, dir);

  storage.saveReport(kase.case_id, { title: 'Taslak 1', sections: [{ title: "A", body: "bir" }] });
  storage.saveReport(kase.case_id, { title: 'Taslak 2', sections: [{ title: "A", body: "iki" }] });
  let revisions = storage.listReportRevisions(kase.case_id);
  assert.equal(revisions.length, 2, 'each save appends a revision');
  assert.equal(storage.getReport(kase.case_id).title, 'Taslak 2');

  storage.saveReport(kase.case_id, { title: 'Nihai', sections: [{ title: "A", body: "üç" }], state: REPORT_REVISION_STATE.FINAL });
  assert.equal(storage.getCurrentReportRevision(kase.case_id).state, REPORT_REVISION_STATE.FINAL);

  assert.throws(
    () => storage.saveReport(kase.case_id, { title: 'Sessiz düzenleme' }),
    (err) => err.code === 'REPORT_FINAL_LOCKED',
    'a finalized report cannot be silently overwritten'
  );

  // Reopening appends a new draft; the FINAL snapshot stays readable.
  storage.saveReport(kase.case_id, { title: 'Yeniden açıldı', reopen: true });
  revisions = storage.listReportRevisions(kase.case_id);
  assert.equal(revisions.length, 4);
  const final = revisions.find((r) => r.state === REPORT_REVISION_STATE.FINAL);
  assert.ok(final, 'the FINAL revision is still present');
  assert.equal(final.title, 'Nihai');
  assert.equal(storage.getReport(kase.case_id).title, 'Yeniden açıldı');

  // Restoring an earlier revision makes it current without deleting later ones.
  const restored = storage.setCurrentReportRevision(final.revision_id);
  assert.equal(restored.title, 'Nihai');
  assert.equal(storage.listReportRevisions(kase.case_id).length, 4, 'restore does not delete revisions');
  storage.close();
});

// ------------------------------------------------------------- findings
test('findings keep an explicit source link and are searchable', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [seg('S1', 0, 'ilk satır')] });
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [seg('S1', 0, 'ilk satır', 'EDITED')],
  });
  const transcript = storage.getTranscript(kase.case_id, ev.evidence_id);
  const rev = storage.getCurrentRevisionInfo(transcript.transcript_id);

  const finding = storage.createFinding(kase.case_id, {
    title: 'Arka plan gürültüsü',
    observation: 'Kaydın 12. saniyesinde belirgin rüzgâr sesi',
    evidenceId: ev.evidence_id,
    revisionId: rev.revision_id,
    atSeconds: 12.5,
  });
  assert.equal(finding.evidence_id, ev.evidence_id);
  assert.equal(finding.revision_id, rev.revision_id, 'the finding is tied to the exact revision');
  assert.equal(storage.listFindings(kase.case_id).length, 1);

  const hits = storage.searchCase(kase.case_id, 'rüzgâr');
  assert.ok(hits.hits.some((h) => h.type === 'finding' && h.finding_id === finding.finding_id),
    'the finding is found by search');

  storage.updateFinding(finding.finding_id, { observation: 'güncellendi' });
  assert.equal(storage.listFindings(kase.case_id)[0].observation, 'güncellendi');
  storage.deleteFinding(finding.finding_id);
  assert.equal(storage.listFindings(kase.case_id).length, 0);
  storage.close();
});

// ------------------------------------------------------- search / paging
test('search uses FTS5 when available and still finds text with a LIKE fallback', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [seg('S1', 0, 'ses kaydı başlıyor'), seg('S2', 1, 'ikinci cümle')],
  });
  assert.equal(storage.ftsAvailable, true, 'the bundled SQLite exposes FTS5');

  const hit = storage.searchCase(kase.case_id, 'kaydı');
  assert.equal(hit.engine, 'fts5');
  assert.equal(hit.hits.length, 1);
  assert.equal(hit.hits[0].segment_id, 'S1');
  assert.ok(hit.hits[0].revision, 'a segment hit carries its revision');

  // Simulate a build without FTS5: the fallback must return the same hit.
  storage.ftsAvailable = false;
  const fallback = storage.searchCase(kase.case_id, 'kaydı');
  assert.equal(fallback.engine, 'like');
  assert.equal(fallback.hits.length, 1);
  assert.equal(fallback.hits[0].segment_id, 'S1');
  storage.close();
});

test('segment paging returns only the requested window with an accurate total', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  const many = Array.from({ length: 500 }, (_, i) => seg(`S${i}`, i, `satır ${i}`));
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: many });
  const transcript = storage.getTranscript(kase.case_id, ev.evidence_id);

  assert.equal(storage.countSegments(transcript.transcript_id), 500);
  const page = storage.getSegmentPage(transcript.transcript_id, { offset: 100, limit: 50 });
  assert.equal(page.total, 500);
  assert.equal(page.segments.length, 50);
  assert.equal(page.segments[0].ordinal, 100);
  assert.equal(page.segments[0].text, 'satır 100');

  const at = storage.getSegmentAt(transcript.transcript_id, 42.4);
  assert.equal(at.ordinal, 42, 'the containing segment is found by timestamp');
  storage.close();
});

// --------------------------------------------------------- dashboard
test('dashboard counts are computed from SQL and stay correct', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [seg('S1', 0, 'bir'), seg('S2', 1, 'iki')],
  });
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    segments: [seg('S1', 0, 'bir', 'VERIFIED'), seg('S2', 1, 'iki', 'VERIFIED')],
  });
  const dash = storage.caseDashboard(kase.case_id);
  assert.equal(dash.evidence, 1);
  assert.equal(dash.transcribed, 1);
  assert.equal(dash.segments, 2);
  assert.equal(dash.verified, 1, 'a fully verified transcript is counted');
  assert.equal(dash.reviewed, 0);
  storage.close();
});

// ------------------------------------------------- archive provenance
test('archive restore preserves notes, findings and report revisions with remapped links', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [seg('S1', 0, 'otomatik')] });
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [seg('S1', 0, 'düzeltildi', 'EDITED')] });
  const transcript = storage.getTranscript(kase.case_id, ev.evidence_id);
  const rev = storage.getCurrentRevisionInfo(transcript.transcript_id);

  storage.createNote(kase.case_id, { evidenceId: ev.evidence_id, atSeconds: 5, body: 'not metni' });
  storage.createNote(kase.case_id, { evidenceId: ev.evidence_id, atSeconds: 6, kind: 'BOOKMARK', body: 'işaret' });
  const finding = storage.createFinding(kase.case_id, {
    title: 'Bulgu',
    observation: 'gözlem',
    evidenceId: ev.evidence_id,
    revisionId: rev.revision_id,
    atSeconds: 5,
  });
  storage.saveReport(kase.case_id, { title: 'Rapor', sections: [{ title: "A", body: "gövde" }] });
  storage.saveReport(kase.case_id, { title: 'Nihai rapor', state: REPORT_REVISION_STATE.FINAL });

  const before = {
    notes: storage.listNotes(kase.case_id).length,
    findings: storage.listFindings(kase.case_id).length,
    reportRevisions: storage.listReportRevisions(kase.case_id).length,
  };

  const { buffer } = await buildCaseArchive({ storage, caseId: kase.case_id });
  const restored = await restoreCaseArchive({ storage, buffer });
  assert.notEqual(restored.caseId, kase.case_id);

  assert.equal(storage.listNotes(restored.caseId).length, before.notes, 'notes survive restore');
  assert.equal(storage.listFindings(restored.caseId).length, before.findings, 'findings survive restore');
  assert.equal(storage.listReportRevisions(restored.caseId).length, before.reportRevisions, 'report revisions survive restore');

  const newEvidence = storage.listEvidence(restored.caseId)[0];
  const newFinding = storage.listFindings(restored.caseId)[0];
  assert.equal(newFinding.evidence_id, newEvidence.evidence_id, 'finding evidence link is remapped');
  const newTranscript = storage.getTranscript(restored.caseId, newEvidence.evidence_id);
  const newRev = storage.getCurrentRevisionInfo(newTranscript.transcript_id);
  assert.equal(newFinding.revision_id, newRev.revision_id, 'finding revision link is remapped to the restored revision');

  const newReport = storage.getReport(restored.caseId);
  assert.equal(newReport.state, REPORT_REVISION_STATE.FINAL, 'report state survives restore');
  assert.ok(storage.listReportRevisions(restored.caseId).some((r) => r.state === REPORT_REVISION_STATE.FINAL));

  // The expert's edited text is intact and the machine text is still recorded.
  const segs = storage.getSegments(newTranscript.transcript_id);
  assert.equal(segs[0].text, 'düzeltildi');
  assert.equal(segs[0].original_text, 'otomatik');
  storage.close();
});

// ------------------------------------------------------------- UYAP hand-off
test('the UYAP hand-off folder records the transcript revision each file came from', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [seg('S1', 0, 'metin')] });
  storage.saveReport(kase.case_id, { title: 'Rapor', sections: [{ title: "A", body: "gövde" }] });

  const out = path.join(dir, 'uyap-out');
  const result = await prepareUyapPackage({ storage, caseId: kase.case_id, options: { outputDir: out } });
  assert.ok(fs.existsSync(path.join(out, 'rapor', 'rapor.txt')));
  assert.ok(fs.existsSync(path.join(out, 'rapor', 'rapor.docx')));
  assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.case_id, kase.case_id);
  assert.ok(manifest.transcripts[0].revision_id, 'the hand-off records the revision id');
  assert.match(manifest.note, /Not a legal filing/i);
  storage.close();
});

// ------------------------------------------------------------- AI assist
test('local assist is disabled by default, makes no network call, and reports honestly', () => {
  const status = aiAssist.status();
  assert.equal(status.enabled, false);
  assert.equal(status.network, false);
  assert.equal(status.language_model, false);

  const result = aiAssist.generate({ storage: null, caseId: 'C1', action: 'report-draft' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI_DISABLED');
});

test('enabling the local draft collector is explicit and still makes no network call', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, { segments: [seg('S1', 0, 'merhaba')] });
  storage.createFinding(kase.case_id, { title: 'Bulgu A', observation: 'gözlem', evidenceId: ev.evidence_id });

  // Off by default: generate refuses and the draft is not built.
  const off = aiAssist.generate({ storage, caseId: kase.case_id, action: 'report-draft' });
  assert.equal(off.ok, false);
  assert.equal(off.code, 'AI_DISABLED');

  // Enabled explicitly (the persisted preference is read by the main process):
  // the result is the operator's own records, never machine-authored prose.
  const on = aiAssist.generate({ storage, caseId: kase.case_id, action: 'report-draft', state: { enabled: true } });
  assert.equal(on.ok, true);
  assert.equal(on.draft.origin, 'assembled-from-operator-records');
  assert.equal(on.draft.requires_expert_review, true);
  assert.equal(on.draft.network, undefined);
  assert.equal(on.draft.transcripts.length, 1);
  assert.equal(on.draft.findings.length, 1);
  assert.equal(on.draft.findings[0].title, 'Bulgu A');
  storage.close();
});

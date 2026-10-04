'use strict';

/**
 * PR-6 regression tests: the expert (56.12) report template.
 *
 * These run the real report service on real storage rows. The expert template
 * must keep the machine transcript and the expert analysis in separate sections,
 * carry the critical passages with their context window, show the claim-evidence
 * matrix with linked sources, and never drop the legal-scope boundary.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../../src/main/services/storage');
const reports = require('../../src/main/services/reports');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'preload.js'), 'utf8');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-report-'));
}

function seg(id, start, text, status = 'AUTOMATIC') {
  return { segment_id: id, start, end: start + 1, speaker: 'SPK', text, status, confidence: 0.9, words: null };
}

async function seed(storage, dir) {
  const kase = storage.createCase({ title: 'Bilirkişi raporu', file_number: '2026/9', authority: 'Asliye Ceza' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'RIFF-fake-audio');
  const ev = await storage.importEvidence(kase.case_id, src, { duration_seconds: 12, sample_rate: 8000 });
  return { kase, ev };
}

test('the expert template is a ten-section 56.12 skeleton', () => {
  const tpl = reports.TEMPLATES.expert;
  assert.ok(tpl, 'expert template must exist');
  assert.equal(tpl.sections.length, 10);
  assert.deepEqual(tpl.sections, [
    'Görevlendirme ve İnceleme Soruları',
    'İncelenen Materyaller',
    'Dosya Bütünlüğü',
    'Teknik Ses Özellikleri',
    'Yöntem ve Kullanılan Araçlar',
    'Doğrulanmış Transkript',
    'Zaman Çizelgesi',
    'Kritik Pasajlar',
    'İddia–Kanıt Matrisi',
    'Teknik Sonuç ve Belirsizlikler',
  ]);
  const sections = reports.defaultSections('expert');
  assert.equal(sections.length, 10);
  assert.ok(sections.every((s) => s.title && s.id));
});

test('the expert report separates the machine transcript from the analysis', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const runId = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, { modelId: 'm', engine: 'whisper.cpp' });
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr', runId,
    segments: [seg('S1', 0, 'makine metni'), seg('S2', 2, 'ikinci satır')],
  });
  const revisionId = saved.revision.revision_id;

  const passage = storage.createPassage(kase.case_id, {
    evidenceId: ev.evidence_id,
    transcriptId: saved.transcript.transcript_id,
    revisionId,
    startSeconds: 2, endSeconds: 3,
    text: 'ikinci satır',
    contextBeforeSeconds: 30, contextAfterSeconds: 30,
    speechAct: 'LITERAL', confidence: 'HIGH',
  });
  const claim = storage.createClaim(kase.case_id, {
    passageId: passage.passage_id,
    asStated: 'ikinci satır',
    allegedMeaning: 'ileri sürülen anlam',
    assertedBy: 'Taraf',
  });
  storage.createSource(kase.case_id, {
    claimId: claim.claim_id,
    kind: 'PRIMARY',
    title: 'Birincil kayıt',
    citation: 'EK-1',
    verification: 'VERIFIED',
  });

  const evidence = storage.listEvidence(kase.case_id);
  const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });
  const built = reports.buildReport({
    caseRecord: kase,
    evidence,
    transcripts,
    notes: [],
    engineInfo: { engine: 'whisper.cpp', modelId: 'm', runtimeMode: 'cpu' },
    report: { template: 'expert', title: kase.title, sections: reports.defaultSections('expert') },
    integrity: [{ evidence_id: ev.evidence_id, status: 'OK' }],
    dashboard: storage.caseDashboard(kase.case_id),
    analysis: {
      passages: storage.listPassages(kase.case_id),
      claims: storage.listClaims(kase.case_id),
      sources: storage.listSources(kase.case_id),
      verifications: storage.listVerifications(kase.case_id),
    },
  });

  const byTitle = (t) => built.sections.find((s) => s.title === t);
  const transcriptSection = byTitle('Doğrulanmış Transkript');
  const passageSection = byTitle('Kritik Pasajlar');
  const claimSection = byTitle('İddia–Kanıt Matrisi');
  const conclusion = byTitle('Teknik Sonuç ve Belirsizlikler');

  assert.ok(transcriptSection.body.includes('makine metni'), 'the machine transcript stays in its own section');
  assert.ok(passageSection.body.includes('ikinci satır'), 'the passage text is carried');
  assert.ok(passageSection.body.includes('±30s'), 'the context window is shown');
  assert.ok(passageSection.body.includes(revisionId), 'the passage records its transcript revision');
  assert.ok(!passageSection.body.includes('makine metni'), 'the passage section does not absorb the whole transcript');
  assert.ok(claimSection.body.includes('Söylenen: ikinci satır'), 'the claim shows what was said');
  assert.ok(claimSection.body.includes('İleri sürülen anlam: ileri sürülen anlam'), 'the alleged meaning is a separate field');
  assert.ok(claimSection.body.includes('Birincil kayıt'), 'the linked source appears in the matrix');
  assert.ok(conclusion.body.includes('hukuki değerlendirme'), 'the legal-scope boundary is present');
  storage.close();
});

test('the expert checklist adds context, source and uncertainty items', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', source: 'review', segments: [seg('S1', 0, 'onaylı', 'VERIFIED')],
  });
  const passage = storage.createPassage(kase.case_id, {
    evidenceId: ev.evidence_id, startSeconds: 0, endSeconds: 1, text: 'onaylı',
  });
  const claim = storage.createClaim(kase.case_id, { passageId: passage.passage_id, asStated: 'onaylı' });
  const evidence = storage.listEvidence(kase.case_id);
  const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });

  const noSource = reports.buildChecklist({
    caseRecord: kase, evidence, transcripts, integrity: [{ evidence_id: ev.evidence_id, status: 'OK' }],
    notes: [], report: { template: 'expert', sections: reports.defaultSections('expert') },
    dashboard: storage.caseDashboard(kase.case_id),
    analysis: { passages: [passage], claims: [claim], sources: [] },
  });
  assert.equal(noSource.items.find((i) => i.id === 'passages').status, 'ok');
  assert.equal(noSource.items.find((i) => i.id === 'sources').status, 'pending', 'an unsourced claim is pending');

  storage.createSource(kase.case_id, { claimId: claim.claim_id, title: 'kaynak', kind: 'PRIMARY' });
  const withSource = reports.buildChecklist({
    caseRecord: kase, evidence, transcripts, integrity: [{ evidence_id: ev.evidence_id, status: 'OK' }],
    notes: [], report: { template: 'expert', sections: reports.defaultSections('expert') },
    dashboard: storage.caseDashboard(kase.case_id),
    analysis: { passages: [passage], claims: [claim], sources: storage.listSources(kase.case_id) },
  });
  assert.equal(withSource.items.find((i) => i.id === 'sources').status, 'ok');
  assert.equal(withSource.expert, true);
  storage.close();
});

test('a passage with no positive context window is refused', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  assert.throws(
    () => storage.createPassage(kase.case_id, {
      evidenceId: ev.evidence_id, startSeconds: 0, endSeconds: 1, text: 'x',
      contextBeforeSeconds: 0, contextAfterSeconds: 0,
    }),
    (err) => err.code === 'CONTEXT_REQUIRED'
  );
  storage.close();
});

test('the report template UI is wired through preload, renderer and HTML', () => {
  assert.ok(INDEX_HTML.includes('id="report-template"'), 'index.html must contain the template select');
  assert.ok(INDEX_HTML.includes('id="btn-report-apply-template"'), 'index.html must contain the apply button');
  assert.ok(RENDERER_JS.includes("bind('#btn-report-apply-template'"), 'the apply button must be bound');
  assert.ok(RENDERER_JS.includes('api.report.templates'), 'the renderer must list templates');
  assert.ok(RENDERER_JS.includes('api.report.save'), 'the renderer must save the chosen template');
  assert.ok(PRELOAD_JS.includes('templates:'), 'the preload must expose report templates');
});

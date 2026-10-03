'use strict';

/**
 * Productization regression tests for the 56.12 expert work station.
 *
 * These run the real service code on real files. Machine (ASR) output and the
 * expert's reviewed text must never overwrite each other; the archive, delivery
 * package and per-segment review flags must round-trip without loss.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { Storage } = require('../../src/main/services/storage');
const reports = require('../../src/main/services/reports');
const { buildDeliveryPackage } = require('../../src/main/services/delivery');
const { reportToDocx, reportToPdf } = require('../../src/main/services/report-render');
const { buildSupportBundle } = require('../../src/main/services/support');
const { readTar } = require('../../src/main/services/tar');
const SEARCH = require('../../src/renderer/lib/search');
const SHORTCUTS = require('../../src/renderer/lib/shortcuts');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-prod-'));
}

/** Read a single entry from a ZIP buffer (DOCX is a ZIP). */
function readZipEntry(zipBuf, wanted) {
  let off = 0;
  while (off + 30 <= zipBuf.length && zipBuf.readUInt32LE(off) === 0x04034b50) {
    const method = zipBuf.readUInt16LE(off + 8);
    const compSize = zipBuf.readUInt32LE(off + 18);
    const nameLen = zipBuf.readUInt16LE(off + 26);
    const extraLen = zipBuf.readUInt16LE(off + 28);
    const name = zipBuf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataOff = off + 30 + nameLen + extraLen;
    const payload = zipBuf.subarray(dataOff, dataOff + compSize);
    if (name === wanted) return method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    off = dataOff + compSize;
  }
  throw new Error(`zip entry not found: ${wanted}`);
}

function seg(id, start, text, status = 'AUTOMATIC', extra = {}) {
  return { segment_id: id, start, end: start + 1, speaker: 'SPK', text, status, confidence: 0.9, words: null, ...extra };
}

async function seed(storage, dir) {
  const kase = storage.createCase({ title: 'Ürünleştirme', file_number: '2026/7' });
  const src = path.join(dir, 'a.wav');
  fs.writeFileSync(src, 'RIFF-fake-audio');
  const ev = await storage.importEvidence(kase.case_id, src, { duration_seconds: 10, sample_rate: 8000 });
  return { kase, ev };
}

// ------------------------------------------------- per-segment review flags

test('review flags persist through save, reopen and setSegmentFlags', async () => {
  const dir = tmp();
  let storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr',
    segments: [seg('S1', 0, 'bir'), seg('S2', 1, 'iki')],
  });
  const tid = saved.segments[0]
    ? storage.getTranscript(kase.case_id, ev.evidence_id).transcript_id
    : null;
  assert.ok(tid);

  storage.setSegmentFlags(tid, 'S1', ['UNCLEAR', 'REVISIT']);
  storage.close();

  storage = new Storage(dir);
  const reopened = storage.getSegments(tid);
  const s1 = reopened.find((s) => s.segment_id === 'S1');
  assert.deepEqual(s1.flags, ['UNCLEAR', 'REVISIT'], 'flags must survive reopen');
  const s2 = reopened.find((s) => s.segment_id === 'S2');
  assert.deepEqual(s2.flags, [], 'segments without flags read as an empty list');
  storage.close();
});

test('flags are local review state and never change segment status or text', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr',
    segments: [seg('S1', 0, 'makine metni')],
  });
  const tid = storage.getTranscript(kase.case_id, ev.evidence_id).transcript_id;
  storage.setSegmentFlags(tid, 'S1', ['REVISIT']);
  const s = storage.getSegments(tid).find((x) => x.segment_id === 'S1');
  assert.equal(s.text, 'makine metni');
  assert.equal(s.status, 'AUTOMATIC');
  assert.deepEqual(s.flags, ['REVISIT']);
  assert.ok(saved);
  storage.close();
});

// ------------------------------------------------- pure renderer helpers

test('search helpers filter and highlight without a DOM', () => {
  const segments = [
    seg('S1', 0, '[ANLAŞILAMADI]', 'AUTOMATIC'),
    seg('S2', 1, 'net metin', 'AUTOMATIC', { confidence: 0.4 }),
    seg('S3', 2, 'onaylı metin', 'VERIFIED'),
  ];
  assert.deepEqual(
    Array.from(SEARCH.filterSegments(segments, SEARCH.FILTERS.UNCLEAR), (s) => s.segment_id),
    ['S1']
  );
  assert.deepEqual(
    Array.from(SEARCH.filterSegments(segments, SEARCH.FILTERS.UNREVIEWED), (s) => s.segment_id),
    ['S1', 'S2']
  );
  assert.deepEqual(
    Array.from(SEARCH.filterSegments(segments, SEARCH.FILTERS.LOW_CONFIDENCE), (s) => s.segment_id),
    ['S2']
  );
  assert.deepEqual(
    SEARCH.highlightRanges('Ankara ankara', 'ankara'),
    [{ start: 0, end: 6 }, { start: 7, end: 13 }]
  );
  const parts = SEARCH.highlightParts('abcabc', 'bc');
  assert.deepEqual(parts, [
    { text: 'a', match: false },
    { text: 'bc', match: true },
    { text: 'a', match: false },
    { text: 'bc', match: true },
  ]);
});

test('shortcut registry yields consistent bindings and help rows', () => {
  const bindings = SHORTCUTS.buildBindings();
  assert.equal(bindings.get('Ctrl+S'), 'save');
  assert.equal(bindings.get(' '), 'play-pause');
  assert.equal(bindings.get('ArrowLeft'), 'seek-back');
  const help = SHORTCUTS.shortcutHelp();
  assert.ok(help.length === Object.keys(SHORTCUTS.DEFINITIONS).length);
  assert.ok(help.every((r) => r.label && r.binding));
  const overridden = SHORTCUTS.buildBindings({ pedals: { 1: 'F13', 2: 'F14', 3: 'F15' } });
  assert.equal(overridden.get('F13'), 'seek-back');
  assert.equal(overridden.get('F14'), 'play-pause');
});

// ------------------------------------------------- report + checklist

test('report carries the data-integrity verdict and delivery checklist', () => {
  const dir = tmp();
  return (async () => {
    const storage = new Storage(dir);
    const { kase, ev } = await seed(storage, dir);
    storage.saveTranscript(kase.case_id, ev.evidence_id, {
      language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'review',
      segments: [seg('S1', 0, 'onaylı', 'VERIFIED')],
    });
    const evidence = storage.listEvidence(kase.case_id);
    const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });
    const built = reports.buildReport({
      caseRecord: kase, evidence, transcripts, notes: [], engineInfo: { engine: 'whisper.cpp' },
      report: null, integrity: [{ evidence_id: ev.evidence_id, status: 'OK' }],
      dashboard: storage.caseDashboard(kase.case_id),
    });
    assert.ok(Array.isArray(built.checklist.items) && built.checklist.items.length > 0);
    const integrityItem = built.checklist.items.find((i) => i.id === 'integrity');
    assert.equal(integrityItem.status, 'ok');
    const revisionItem = built.checklist.items.find((i) => i.id === 'revision');
    assert.equal(revisionItem.status, 'ok', 'a chosen human revision should satisfy the checklist');
    assert.match(String(built.notice), /teknik bir çalışma ürünüdür/, 'the technical-work-product disclaimer is present');
    storage.close();
  })();
});

test('checklist flags an integrity failure explicitly', async () => {
  const storage = new Storage(tmp());
  const dir = tmp();
  const { kase, ev } = await seed(storage, dir);
  const evidence = storage.listEvidence(kase.case_id);
  const built = reports.buildChecklist({
    caseRecord: kase, evidence, transcripts: [],
    integrity: [{ evidence_id: ev.evidence_id, status: 'MISMATCH' }],
    notes: [], report: null, dashboard: storage.caseDashboard(kase.case_id),
  });
  const item = built.items.find((i) => i.id === 'integrity');
  assert.equal(item.status, 'pending');
  storage.close();
});

test('every export format renders the delivery checklist', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'review',
    segments: [seg('S1', 0, 'onaylı', 'VERIFIED')],
  });
  const evidence = storage.listEvidence(kase.case_id);
  const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });
  const built = reports.buildReport({
    caseRecord: kase, evidence, transcripts, notes: [], engineInfo: { engine: 'whisper.cpp' },
    report: null, integrity: [{ evidence_id: ev.evidence_id, status: 'OK' }],
    dashboard: storage.caseDashboard(kase.case_id),
  });
  const txt = reports.reportToTxt(built);
  const html = reports.reportToHtml(built);
  const docx = reportToDocx(built);
  const pdf = reportToPdf(built);
  assert.match(txt, /TESLİM HAZIRLIĞI KONTROL LİSTESİ/);
  assert.match(html, /Teslim Hazırlığı Kontrol Listesi/);
  // DOCX is a ZIP; the document part must carry the checklist text.
  const docEntry = readZipEntry(docx, 'word/document.xml');
  assert.match(docEntry.toString('utf8'), /Teslim Hazırlığı Kontrol Listesi/);
  assert.ok(pdf.length > 0);
  storage.close();
});

// ------------------------------------------------- delivery package provenance

test('delivery package records the transcript revision for every file', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr',
    segments: [seg('S1', 0, 'makine')],
  });
  const delivery = await buildDeliveryPackage({ storage, caseId: kase.case_id, engineInfo: { engine: 'whisper.cpp' } });
  const entries = readTar(zlib.gunzipSync(delivery.buffer));
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.some((n) => n.startsWith('report/')));
  assert.ok(names.some((n) => n.startsWith('transcript/')), 'transcript files are shipped');

  const technical = JSON.parse(entries.find((e) => e.name === 'metadata/technical.json').data.toString('utf8'));
  assert.equal(technical.transcripts.length, 1);
  assert.ok(technical.transcripts[0].transcript_id, 'technical metadata links to the transcript id');
  assert.ok(technical.transcripts[0].revision, 'technical metadata links to the revision');
  storage.close();
});

test('delivery manifest lists each shipped file with a hash', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr', segments: [seg('S1', 0, 'x')],
  });
  const { manifest } = await buildDeliveryPackage({ storage, caseId: kase.case_id });
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(manifest.counts.transcripts, 1);
  storage.close();
});

// ------------------------------------------------- support bundle

test('support bundle is a self-describing tar.gz with no audio payload', () => {
  const bundle = buildSupportBundle({
    appInfo: { version: '0.1.4', platform: 'linux' },
    engineInfo: { engine: 'whisper.cpp', version: 'x' },
    diagnostics: [{ check: 'db', ok: true }],
    extra: { note: 'destek' },
  });
  const entries = readTar(zlib.gunzipSync(bundle.buffer));
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json') || names.includes('support/manifest.json'));
  const manifest = JSON.parse(entries.find((e) => /manifest\.json$/.test(e.name)).data.toString('utf8'));
  assert.equal(manifest.app_version, '0.1.4');
});

// ------------------------------------------------- realistic re-transcription

test('a second ASR run never destroys the verified human revision (product flow)', async () => {
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const run1 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, {
    engine: 'whisper.cpp', engineVersion: '1', modelId: 'm', settings: {},
    inputSha256: ev.sha256, runtimeMode: 'cpu', runtimeReason: 'test',
  });
  const first = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr', runId: run1,
    segments: [seg('S1', 0, 'makine bir'), seg('S2', 1, 'makine iki')],
  });
  storage.finishTranscriptionRun(run1, { status: 'SUCCEEDED' });
  const tid = storage.getTranscript(kase.case_id, ev.evidence_id).transcript_id;

  // Expert edits and verifies.
  storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'review',
    segments: [
      { ...first.segments[0], text: 'uzman metni bir', status: 'VERIFIED' },
      { ...first.segments[1], text: 'uzman metni iki', status: 'VERIFIED' },
    ],
  });

  // A second, different run arrives.
  const run2 = storage.startTranscriptionRun(kase.case_id, ev.evidence_id, {
    engine: 'whisper.cpp', engineVersion: '1', modelId: 'm', settings: {},
    inputSha256: ev.sha256, runtimeMode: 'cuda', runtimeReason: 'gpu',
  });
  const second = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'asr', runId: run2,
    segments: [seg('R2-1', 0, 'yeni makine bir'), seg('R2-2', 1, 'yeni makine iki')],
  });
  storage.finishTranscriptionRun(run2, { status: 'SUCCEEDED' });
  assert.notEqual(run1, run2);
  assert.equal(second.revisionBecameCurrent, false, 'the machine run must not steal the current revision');

  const live = storage.getSegments(tid);
  assert.equal(live[0].text, 'uzman metni bir');
  assert.equal(live.every((s) => s.status === 'VERIFIED'), true);

  const revisions = storage.listRevisions(tid);
  assert.ok(revisions.length >= 3, 'machine, human and second machine revisions all retained');
  const current = storage.getCurrentRevisionInfo(tid);
  assert.equal(current.state, 'VERIFIED');
  storage.close();
});

test('TranscriptStore.toggleFlag toggles and toPayload carries flags through save/reopen', async () => {
  const { TranscriptStore } = require('../../src/renderer/lib/transcript-store');
  const dir = tmp();
  const storage = new Storage(dir);
  const { kase, ev } = await seed(storage, dir);

  const store = new TranscriptStore([seg('S1', 0, 'makine')]);
  assert.equal(store.toggleFlag('S1', 'REVISIT'), true);
  assert.deepEqual(store.segments[0].flags, ['REVISIT']);
  assert.equal(store.dirty, true);
  // Toggling the same flag removes it; toggling an unknown id is a no-op.
  store.toggleFlag('S1', 'REVISIT');
  assert.deepEqual(store.segments[0].flags, []);
  assert.equal(store.toggleFlag('missing', 'REVISIT'), false);

  store.toggleFlag('S1', 'UNCLEAR');
  const saved = storage.saveTranscript(kase.case_id, ev.evidence_id, {
    language: 'tr', modelId: 'm', engine: 'whisper.cpp', source: 'review',
    segments: store.toPayload(),
  });
  const reopened = storage.getSegments(saved.transcript.transcript_id);
  assert.deepEqual(reopened[0].flags, ['UNCLEAR'], 'flags must round-trip through the store payload');
  storage.close();
});

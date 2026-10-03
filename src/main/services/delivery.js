'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { createTar } = require('./tar');
const { writeFileAtomic } = require('./atomic');
const reports = require('./reports');
const { reportToDocx, reportToPdf } = require('./report-render');

/**
 * Delivery package: one archive that gathers everything the expert hands over,
 * without copying the original evidence unless it is small enough to be useful.
 *
 * Contents:
 *   manifest.json          what is inside and the hash of every entry
 *   manifest.sha256        integrity of the index
 *   case/summary.json      case row + dashboard counts
 *   report/report.docx     the report
 *   report/report.pdf
 *   report/report.html
 *   report/report.txt
 *   transcript/<name>.json transcript of each evidence (current revision)
 *   transcript/<name>.srt
 *   metadata/evidence.json full evidence metadata + hashes
 *   metadata/technical.json engine/model/runtime provenance
 *   attachments/…          operator notes flagged for the report
 *
 * Original evidence is included only when `includeEvidence` is set and the file
 * is below `maxEvidenceBytes`, so a multi-hour recording never gets duplicated
 * by accident.
 */

const DELIVERY_FORMAT = 'forensic-transcriber-delivery-package';
const DELIVERY_VERSION = 1;

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeStem(name) {
  return (
    path
      .basename(String(name || 'transcript'))
      .replace(/\.[^.]+$/, '')
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'transcript'
  );
}

/**
 * Build the delivery package buffer.
 *
 * @returns {Promise<{buffer:Buffer, manifest:object}>}
 */
async function buildDeliveryPackage({
  storage,
  caseId,
  engineInfo = null,
  includeEvidence = false,
  maxEvidenceBytes = 50 * 1024 * 1024,
  onProgress = null,
}) {
  const kase = storage.getCase(caseId);
  if (!kase) {
    const err = new Error(`Case not found: ${caseId}`);
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }
  const evidence = storage.listEvidence(caseId);
  const notes = storage.listNotes(caseId);
  const report = storage.getReport(caseId);
  const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });
  const dashboard = storage.caseDashboard(caseId);

  const entries = [];
  const fileIndex = [];
  const add = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    entries.push({ name, data: buf });
    fileIndex.push({ path: name, sizeBytes: buf.length, sha256: sha256Buffer(buf) });
  };

  if (onProgress) onProgress({ stage: 'report', percent: 10 });
  const built = reports.buildReport({
    caseRecord: kase,
    evidence,
    transcripts,
    notes,
    engineInfo,
    report,
  });

  add('case/summary.json', `${JSON.stringify({ case: kase, dashboard }, null, 2)}\n`);
  add('report/report.txt', reports.reportToTxt(built));
  add('report/report.html', reports.reportToHtml(built));
  add('report/report.docx', reportToDocx(built));
  add('report/report.pdf', reportToPdf(built));

  if (onProgress) onProgress({ stage: 'transcripts', percent: 35 });
  for (const t of transcripts) {
    const stem = `${safeStem(t.evidence_name)}__${t.evidence_id}`;
    add(
      `transcript/${stem}.json`,
      `${JSON.stringify(
        {
          evidence_id: t.evidence_id,
          evidence_name: t.evidence_name,
          transcript_id: t.transcript_id,
          revision: t.revision,
          segments: t.segments,
        },
        null,
        2
      )}\n`
    );
    const srt = t.segments
      .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n[${s.speaker}] ${s.text}\n`)
      .join('\n');
    add(`transcript/${stem}.srt`, `${srt}\n`);
  }

  add('metadata/evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
  add(
    'metadata/technical.json',
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        engine: engineInfo,
        transcripts: transcripts.map((t) => ({
          evidence_id: t.evidence_id,
          transcript_id: t.transcript_id,
          revision: t.revision,
        })),
      },
      null,
      2
    )}\n`
  );

  if (notes.length) {
    add('attachments/notes.json', `${JSON.stringify(notes, null, 2)}\n`);
  }

  if (includeEvidence) {
    let included = 0;
    for (const ev of evidence) {
      if (onProgress) onProgress({ stage: 'evidence', percent: 50 + Math.round((included / Math.max(1, evidence.length)) * 40) });
      if (!ev.original_path || !fs.existsSync(ev.original_path)) continue;
      const stat = fs.statSync(ev.original_path);
      if (stat.size > maxEvidenceBytes) continue;
      const data = fs.readFileSync(ev.original_path);
      if (sha256Buffer(data) !== ev.sha256) continue; // never ship a changed original
      add(`evidence/${safeStem(ev.original_name)}__${ev.evidence_id}${path.extname(ev.original_name)}`, data);
      included += 1;
    }
    add('metadata/evidence_included.json', `${JSON.stringify({ included, policy: 'hash-verified originals below size limit' }, null, 2)}\n`);
  }

  const manifest = {
    format: DELIVERY_FORMAT,
    delivery_version: DELIVERY_VERSION,
    case_id: caseId,
    case_title: kase.title,
    generated_at: new Date().toISOString(),
    counts: {
      evidence: evidence.length,
      transcripts: transcripts.length,
      notes: notes.length,
      files: fileIndex.length,
    },
    evidence: evidence.map((e) => ({
      evidence_id: e.evidence_id,
      original_name: e.original_name,
      sha256: e.sha256,
      size_bytes: e.size_bytes,
    })),
    files: fileIndex,
  };
  const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  entries.push({ name: 'manifest.json', data: manifestJson });
  entries.push({ name: 'manifest.sha256', data: Buffer.from(`${sha256Buffer(manifestJson)}\n`, 'utf8') });

  if (onProgress) onProgress({ stage: 'packaging', percent: 95 });
  const buffer = zlib.gzipSync(createTar(entries), { level: 9 });
  return { buffer, manifest };
}

function srtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((s % 1) * 1000);
  const total = Math.floor(s);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)},${p(ms, 3)}`;
}

/** Write a delivery package atomically and return its hash. */
async function writeDeliveryPackage(args) {
  const { buffer, manifest } = await buildDeliveryPackage(args);
  writeFileAtomic(args.destPath, buffer);
  return { path: args.destPath, sha256: sha256Buffer(buffer), bytes: buffer.length, manifest };
}

/**
 * Prepare a local hand-off folder (report + transcripts) laid out for manual
 * submission through the UYAP workflow. This only writes files to a folder the
 * user picks; nothing is uploaded and the software makes no claim that a filing
 * is legally valid or accepted. A manifest records the transcript revision each
 * transcript file was rendered from, so the hand-off stays traceable.
 *
 * @returns {Promise<{dir:string, files:Array, manifest:object}>}
 */
async function prepareUyapPackage({ storage, caseId, options = {}, engineInfo = null }) {
  const kase = storage.getCase(caseId);
  if (!kase) {
    const err = new Error(`Case not found: ${caseId}`);
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }
  const dir = options.outputDir || path.join(kase.case_dir, 'exports', 'uyap');
  fs.mkdirSync(path.join(dir, 'rapor'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'transkript'), { recursive: true });

  const evidence = storage.listEvidence(caseId);
  const notes = storage.listNotes(caseId);
  const report = storage.getReport(caseId);
  const transcripts = reports.collectTranscripts({ caseRecord: kase, evidence, storage });

  const files = [];
  const write = (rel, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const full = path.join(dir, rel);
    writeFileAtomic(full, buf, { fsync: true });
    files.push({ path: rel, bytes: buf.length, sha256: sha256Buffer(buf) });
  };

  const built = reports.buildReport({ caseRecord: kase, evidence, transcripts, notes, engineInfo, report });
  write('rapor/rapor.txt', reports.reportToTxt(built));
  write('rapor/rapor.html', reports.reportToHtml(built));
  write('rapor/rapor.docx', reportToDocx(built));
  write('rapor/rapor.pdf', reportToPdf(built));

  for (const t of transcripts) {
    const stem = `${safeStem(t.evidence_name)}__${t.evidence_id}`;
    write(`transkript/${stem}.json`, `${JSON.stringify({
      evidence_id: t.evidence_id,
      evidence_name: t.evidence_name,
      transcript_id: t.transcript_id,
      revision: t.revision,
      segments: t.segments,
    }, null, 2)}\n`);
    const srt = t.segments
      .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n[${s.speaker}] ${s.text}\n`)
      .join('\n');
    write(`transkript/${stem}.srt`, `${srt}\n`);
  }

  const manifest = {
    format: 'forensic-transcriber-uyap-handoff',
    version: 1,
    case_id: caseId,
    case_title: kase.title,
    generated_at: new Date().toISOString(),
    // Not a legal claim: this is a local hand-off folder. The expert submits it
    // through their own official workflow.
    note: 'Local hand-off folder prepared for manual submission. Not a legal filing.',
    transcripts: transcripts.map((t) => ({
      evidence_id: t.evidence_id,
      transcript_id: t.transcript_id,
      revision_id: t.revision ? t.revision.revision_id : null,
      revision_state: t.revision ? t.revision.state : null,
    })),
    files,
  };
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  storage.recordHistory(caseId, 'UYAP_PACKAGE', caseId, { dir, fileCount: files.length });
  return { dir, files, manifest };
}

module.exports = {
  DELIVERY_FORMAT,
  DELIVERY_VERSION,
  buildDeliveryPackage,
  writeDeliveryPackage,
  prepareUyapPackage,
  sha256Buffer,
  safeStem,
};

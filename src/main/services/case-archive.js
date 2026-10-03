'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { createTar, readTar } = require('./tar');
const { writeFileAtomic } = require('./atomic');

/**
 * Case archive: export and import all of a case's working products as one
 * deterministic, versioned file.
 *
 * Format: a gzip-compressed ustar archive whose entries are sorted and whose
 * headers carry no timestamps, so archiving the same case twice produces the
 * same bytes. Contents:
 *
 *   manifest.json          archive format version, case metadata, counts
 *   manifest.sha256        SHA-256 of manifest.json (integrity of the index)
 *   database/case.json     the case row and its related rows as JSON
 *   evidence/original/<name>   the imported copies (immutable)
 *   evidence/derived/<name>    the ASR working copies (regenerable)
 *   transcript/<file>      any transcript side files
 *   exports/<file>         prior exports
 *
 * The archive is a software provenance artifact: it makes a case portable and
 * verifiable. It is not claimed to be a legal chain-of-custody mechanism.
 *
 * Restore writes a NEW case (new case id) and verifies every evidence hash, so a
 * mismatched or tampered archive is rejected rather than silently trusted.
 */

const ARCHIVE_FORMAT = 'forensic-transcriber-case-archive';
const ARCHIVE_VERSION = 1;

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkFiles(root, rel = '') {
  const out = [];
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, childRel));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

/**
 * Build the archive buffer for a case.
 *
 * @param {object} args
 * @param {object} args.storage   Storage instance
 * @param {string} args.caseId
 * @returns {Promise<{buffer:Buffer, manifest:object}>}
 */
async function buildCaseArchive({ storage, caseId }) {
  const kase = storage.getCase(caseId);
  if (!kase) {
    const err = new Error(`Case not found: ${caseId}`);
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }
  const evidence = storage.listEvidence(caseId);
  const runs = storage.listTranscriptionRuns(caseId);
  const history = storage.listHistory(caseId);

  const transcripts = [];
  for (const ev of evidence) {
    const t = storage.getTranscript(caseId, ev.evidence_id);
    if (!t) continue;
    transcripts.push({ transcript: t, segments: storage.getSegments(t.transcript_id) });
  }

  const entries = [];
  const fileIndex = [];

  const addFile = (relative, absolute) => {
    if (!fs.existsSync(absolute)) return;
    const data = fs.readFileSync(absolute);
    entries.push({ name: relative, data });
    fileIndex.push({ path: relative, sizeBytes: data.length, sha256: sha256Buffer(data) });
  };

  for (const rel of walkFiles(kase.case_dir, 'evidence')) addFile(rel.split(path.sep).join('/'), path.join(kase.case_dir, rel));
  for (const rel of walkFiles(kase.case_dir, 'transcript')) addFile(rel.split(path.sep).join('/'), path.join(kase.case_dir, rel));
  for (const rel of walkFiles(kase.case_dir, 'exports')) addFile(rel.split(path.sep).join('/'), path.join(kase.case_dir, rel));

  const caseData = { case: kase, evidence, transcripts, runs, history };
  const caseJson = Buffer.from(`${JSON.stringify(caseData, null, 2)}\n`, 'utf8');
  entries.push({ name: 'database/case.json', data: caseJson });
  fileIndex.push({ path: 'database/case.json', sizeBytes: caseJson.length, sha256: sha256Buffer(caseJson) });

  const manifest = {
    format: ARCHIVE_FORMAT,
    archive_version: ARCHIVE_VERSION,
    case_id: kase.case_id,
    case_title: kase.title,
    created_at: kase.created_at,
    updated_at: kase.updated_at,
    counts: {
      evidence: evidence.length,
      transcripts: transcripts.length,
      segments: transcripts.reduce((n, t) => n + t.segments.length, 0),
      transcription_runs: runs.length,
      history: history.length,
      files: fileIndex.length,
    },
    // Each evidence entry records the hash of the imported copy as stored, so a
    // restore can re-verify it against the file bytes in the archive.
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

  const tar = createTar(entries);
  const buffer = zlib.gzipSync(tar, { level: 9 });
  return { buffer, manifest };
}

/** Write a case archive atomically. */
async function writeCaseArchive({ storage, caseId, destPath }) {
  const { buffer, manifest } = await buildCaseArchive({ storage, caseId });
  writeFileAtomic(destPath, buffer);
  const sha256 = sha256Buffer(buffer);
  return { path: destPath, sha256, bytes: buffer.length, manifest };
}

/**
 * Verify an archive buffer without restoring it.
 * @returns {{ok:boolean, errors:string[], manifest:object|null}}
 */
function verifyCaseArchive(buffer) {
  const errors = [];
  let manifest = null;
  let entries;
  try {
    entries = readTar(zlib.gunzipSync(buffer));
  } catch (err) {
    return { ok: false, errors: [`cannot read archive: ${err.message}`], manifest: null };
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) {
    return { ok: false, errors: ['manifest.json missing'], manifest: null };
  }
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    return { ok: false, errors: ['manifest.json is not valid JSON'], manifest: null };
  }
  if (manifest.format !== ARCHIVE_FORMAT) errors.push(`unexpected format: ${manifest.format}`);
  if (manifest.archive_version !== ARCHIVE_VERSION) errors.push(`unexpected archive_version: ${manifest.archive_version}`);

  const manifestSha = byName.get('manifest.sha256');
  if (!manifestSha || manifestSha.data.toString('utf8').trim() !== sha256Buffer(manifestEntry.data)) {
    errors.push('manifest.sha256 does not match manifest.json');
  }

  // Every file listed in the manifest must be present with the recorded hash.
  for (const file of manifest.files || []) {
    const entry = byName.get(file.path);
    if (!entry) {
      errors.push(`missing file: ${file.path}`);
      continue;
    }
    const digest = sha256Buffer(entry.data);
    if (digest !== file.sha256) errors.push(`hash mismatch: ${file.path}`);
  }

  // Every evidence hash must match the archived copy bytes.
  for (const ev of manifest.evidence || []) {
    const match = entries.find((e) => e.name.startsWith('evidence/original/') && e.name.includes(ev.evidence_id));
    if (!match) {
      errors.push(`evidence file missing: ${ev.evidence_id}`);
      continue;
    }
    if (sha256Buffer(match.data) !== ev.sha256) errors.push(`evidence hash mismatch: ${ev.evidence_id}`);
  }

  return { ok: errors.length === 0, errors, manifest };
}

/**
 * Restore an archive into a new case. A fresh case id is always generated so a
 * restore never collides with, or overwrites, an existing case.
 *
 * @returns {Promise<{caseId:string, manifest:object, verified:object}>}
 */
async function restoreCaseArchive({ storage, buffer }) {
  const verified = verifyCaseArchive(buffer);
  if (!verified.ok) {
    const err = new Error(`Archive failed verification: ${verified.errors.join('; ')}`);
    err.code = 'ARCHIVE_INVALID';
    err.errors = verified.errors;
    throw err;
  }
  const manifest = verified.manifest;
  const entries = readTar(zlib.gunzipSync(buffer));
  const byName = new Map(entries.map((e) => [e.name, e]));
  const caseData = JSON.parse(byName.get('database/case.json').data.toString('utf8'));

  const created = storage.createCase({
    title: caseData.case.title,
    notes: caseData.case.notes,
  });
  const caseId = created.case_id;

  // Re-import each evidence from its archived bytes into the new case, then
  // re-verify the hash so a mismatch aborts the restore. Keep a direct map from
  // the archive's evidence id to the new evidence id, so transcripts can be
  // reattached without relying on file names.
  const idMap = new Map();
  for (const ev of caseData.evidence) {
    const entry = entries.find((e) => e.name.startsWith('evidence/original/') && e.name.includes(ev.evidence_id));
    if (!entry) {
      const err = new Error(`Evidence missing in archive: ${ev.evidence_id}`);
      err.code = 'ARCHIVE_INVALID';
      throw err;
    }
    const digest = sha256Buffer(entry.data);
    if (digest !== ev.sha256) {
      const err = new Error(`Evidence hash mismatch on restore: ${ev.evidence_id}`);
      err.code = 'ARCHIVE_INVALID';
      throw err;
    }
    // Import from a temp directory so the archived original file name is
    // preserved (importEvidence derives the name from the path basename).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-restore-'));
    const safeName = path.basename(String(ev.original_name || 'evidence.bin')) || 'evidence.bin';
    const tmp = path.join(tmpDir, safeName);
    fs.writeFileSync(tmp, entry.data);
    try {
      const imported = await storage.importEvidence(caseId, tmp, {
        format: ev.format ?? null,
        codec: ev.codec ?? null,
        durationSeconds: ev.duration_seconds ?? null,
        sampleRate: ev.sample_rate ?? null,
        channels: ev.channels ?? null,
        bitDepth: ev.bit_depth ?? null,
      });
      idMap.set(ev.evidence_id, imported.evidence_id);
      storage.recordHistory(caseId, 'ARCHIVE_RESTORED', imported.evidence_id, {
        from_archive_evidence_id: ev.evidence_id,
        original_name: ev.original_name,
        sha256: ev.sha256,
      });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // Restore transcripts (segments, original_text and status included).
  for (const t of caseData.transcripts || []) {
    const newEvidenceId = idMap.get(t.transcript.evidence_id);
    if (!newEvidenceId) continue;
    storage.saveTranscript(caseId, newEvidenceId, {
      language: t.transcript.language,
      modelId: t.transcript.model_id,
      engine: t.transcript.engine,
      segments: t.segments,
      source: 'archive-restore',
    });
  }

  return { caseId, manifest, verified, evidenceIdMap: Object.fromEntries(idMap) };
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  buildCaseArchive,
  writeCaseArchive,
  verifyCaseArchive,
  restoreCaseArchive,
  sha256Buffer,
  walkFiles,
};

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
// v2 adds transcript revisions and the run -> revision linkage. v3 adds the
// expert analysis layer (passages, claims, sources, verifications). All versions
// remain readable: a v1 archive's segments are restored as a single revision.
const ARCHIVE_VERSION = 3;
const SUPPORTED_ARCHIVE_VERSIONS = [1, 2, 3];

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
  const notes = storage.listNotes(caseId);
  const findings = storage.listFindings(caseId);
  const report = storage.getReport(caseId);
  const reportRevisions = storage.listReportRevisions(caseId);
  const passages = storage.listPassages(caseId);
  const claims = storage.listClaims(caseId);
  const sources = storage.listSources(caseId);
  const verifications = storage.listVerifications(caseId);

  const transcripts = [];
  for (const ev of evidence) {
    const t = storage.getTranscript(caseId, ev.evidence_id);
    if (!t) continue;
    transcripts.push({ transcript: t, revisions: storage.listRevisions(t.transcript_id), segments: storage.getSegments(t.transcript_id) });
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

  const caseData = { case: kase, evidence, transcripts, runs, history, notes, findings, report, report_revisions: reportRevisions, passages, claims, sources, verifications };
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
      transcript_revisions: transcripts.reduce((n, t) => n + (t.revisions ? t.revisions.length : 0), 0),
      transcription_runs: runs.length,
      history: history.length,
      notes: notes.length,
      findings: findings.length,
      report_revisions: reportRevisions.length,
      passages: passages.length,
      claims: claims.length,
      sources: sources.length,
      verifications: verifications.length,
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
  if (!SUPPORTED_ARCHIVE_VERSIONS.includes(manifest.archive_version)) {
    errors.push(`unexpected archive_version: ${manifest.archive_version}`);
  }

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
        audioStreamCount: ev.audio_stream_count ?? null,
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

  // Restore provenance in dependency order so the graph stays intact:
  //   evidence (done above) -> runs -> transcripts+revisions -> run->transcript link
  //
  // IDs are regenerated by design (a restore must never collide with an
  // existing case), so old->new mappings are built explicitly:
  //   idMap            archive evidence id -> new evidence id
  //   transcriptIdMap  archive transcript id -> new transcript id
  //   runIdMap         archive run id -> new run id
  const transcriptIdMap = new Map();
  const runIdMap = new Map();
  const revisionIdMap = new Map();

  // 1. Runs first so their new ids are known when revisions are inserted. The
  //    transcript link is written in step 3 once transcripts exist.
  for (const run of caseData.runs || []) {
    const newEvidenceId = idMap.get(run.evidence_id);
    if (!newEvidenceId) continue;
    const newRunId = storage.restoreTranscriptionRun(caseId, newEvidenceId, run, { transcriptId: null });
    runIdMap.set(run.run_id, newRunId);
  }

  // 2. Transcripts and their revisions. Each revision's run_id is remapped
  //    through runIdMap, preserving the run -> revision provenance edge.
  for (const t of caseData.transcripts || []) {
    const newEvidenceId = idMap.get(t.transcript.evidence_id);
    if (!newEvidenceId) continue;
    let revisions = Array.isArray(t.revisions) ? t.revisions : [];
    if (!revisions.length && Array.isArray(t.segments)) {
      // Archive v1 (or a transcript with no revision rows): treat the stored
      // segments as a single revision of the mapped state.
      revisions = [{
        state: t.segments.some((s) => s.status === 'VERIFIED') ? 'VERIFIED'
          : t.segments.some((s) => s.status === 'EDITED') ? 'EDITED'
          : t.segments.some((s) => s.status === 'REVIEWED') ? 'REVIEWED'
          : 'MACHINE',
        is_current: 1,
        created_at: t.transcript.updated_at || t.transcript.created_at,
        segments: t.segments,
      }];
    }
    const restored = storage.restoreTranscript(caseId, newEvidenceId, t.transcript, revisions, { runIdMap });
    transcriptIdMap.set(t.transcript.transcript_id, restored.transcript_id);
    for (const [oldId, newId] of restored.revisionIdMap) revisionIdMap.set(oldId, newId);
    storage.recordHistory(caseId, 'ARCHIVE_TRANSCRIPT_RESTORED', newEvidenceId, {
      from_archive_evidence_id: t.transcript.evidence_id,
      revision_count: revisions.length,
    });
  }

  // 3. Re-point each restored run at its restored transcript.
  for (const run of caseData.runs || []) {
    const newRunId = runIdMap.get(run.run_id);
    if (!newRunId || !run.transcript_id) continue;
    const newTranscriptId = transcriptIdMap.get(run.transcript_id);
    if (newTranscriptId) storage.linkRunTranscript(newRunId, newTranscriptId);
  }

  // 4. Notes and bookmarks, preserving their timestamps and evidence links.
  for (const note of caseData.notes || []) {
    const newEvidenceId = note.evidence_id ? idMap.get(note.evidence_id) || null : null;
    storage.restoreNote(caseId, note, { evidenceId: newEvidenceId });
  }

  // 5. Structured findings, remapping both the evidence link and the transcript
  //    revision link so a finding stays attached to the exact revision it cited.
  for (const finding of caseData.findings || []) {
    const newEvidenceId = finding.evidence_id ? idMap.get(finding.evidence_id) || null : null;
    const newRevisionId = finding.revision_id ? revisionIdMap.get(finding.revision_id) || null : null;
    storage.restoreFinding(caseId, finding, { evidenceId: newEvidenceId, revisionId: newRevisionId });
  }

  // 6. The report working row and its append-only revisions.
  storage.restoreReport(caseId, caseData.report || null, caseData.report_revisions || []);

  // 7. Expert analysis layer (archive v3). Passages first so claims/sources/
  //    verifications can be re-pointed through the passage and revision maps.
  const passageIdMap = new Map();
  const claimIdMap = new Map();
  for (const passage of caseData.passages || []) {
    const newEvidenceId = idMap.get(passage.evidence_id) || null;
    const newRevisionId = passage.revision_id ? revisionIdMap.get(passage.revision_id) || null : null;
    const newPassageId = storage.restorePassage(caseId, passage, { evidenceId: newEvidenceId, revisionId: newRevisionId });
    passageIdMap.set(passage.passage_id, newPassageId);
  }
  for (const claim of caseData.claims || []) {
    const newPassageId = claim.passage_id ? passageIdMap.get(claim.passage_id) || null : null;
    claimIdMap.set(claim.claim_id, storage.restoreClaim(caseId, claim, { passageId: newPassageId }));
  }
  for (const source of caseData.sources || []) {
    storage.restoreSource(caseId, source, {
      claimId: source.claim_id ? claimIdMap.get(source.claim_id) || null : null,
      passageId: source.passage_id ? passageIdMap.get(source.passage_id) || null : null,
    });
  }
  for (const verification of caseData.verifications || []) {
    storage.restoreVerification(caseId, verification, {
      claimId: verification.claim_id ? claimIdMap.get(verification.claim_id) || null : null,
      passageId: verification.passage_id ? passageIdMap.get(verification.passage_id) || null : null,
    });
  }

  // 8. Replay the archived history with remapped references so the provenance
  //    log points at the restored entities, not at ids that no longer exist.
  for (const entry of caseData.history || []) {
    const remapped = remapHistoryEntry(entry, {
      evidence: idMap, transcript: transcriptIdMap, run: runIdMap,
      revision: revisionIdMap, passage: passageIdMap, claim: claimIdMap,
    });
    storage.restoreHistory(caseId, entry, remapped);
  }

  return { caseId, manifest, verified, evidenceIdMap: Object.fromEntries(idMap) };
}

/**
 * Remap the ids a history row references. A history entry carries an opaque
 * target plus a free-form detail object; the known id-bearing fields are remapped
 * and anything unknown is left as-is rather than guessed.
 */
function remapHistoryEntry(entry, maps) {
  const fieldMap = {
    evidenceId: 'evidence', evidence_id: 'evidence',
    transcriptId: 'transcript', transcript_id: 'transcript',
    runId: 'run', run_id: 'run',
    revisionId: 'revision', revision_id: 'revision',
    passageId: 'passage', passage_id: 'passage',
    claimId: 'claim', claim_id: 'claim',
  };
  const remapValue = (key, value) => {
    const bucket = fieldMap[key];
    if (!bucket || !value) return value;
    const map = maps[bucket];
    return map && map.has(value) ? map.get(value) : value;
  };
  const target = entry.target ? remapValue('evidence_id', entry.target) : null;
  let detail = entry.detail;
  if (detail && typeof detail === 'object') {
    detail = { ...detail };
    for (const key of Object.keys(detail)) detail[key] = remapValue(key, detail[key]);
  }
  return { target, detail };
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

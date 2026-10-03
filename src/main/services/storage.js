'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  HISTORY_ACTIONS,
  SEGMENT_STATUS,
  SEGMENT_STATUS_VALUES,
  UNCLEAR_PLACEHOLDER,
} = require('../../shared/constants');

const SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function randomSuffix(len = 6) {
  return crypto.randomBytes(8).toString('hex').slice(0, len).toUpperCase();
}

function makeId(prefix) {
  const d = new Date();
  const stamp =
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` +
    `-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
  return `${prefix}-${stamp}-${randomSuffix()}`;
}

/**
 * Turn an arbitrary user-supplied file name into a safe on-disk leaf name.
 * Rejects path separators, control characters and reserved Windows names so a
 * crafted import can never escape the case directory.
 */
function sanitizeFileName(name) {
  // Normalise both separators so a Windows-style path is reduced to its leaf
  // regardless of the host platform the code is running on.
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.+$/, '')
    .trim();
  const safe = cleaned.length ? cleaned : 'file';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  return reserved.test(safe) ? `_${safe}` : safe;
}

function sha256File(filePath, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let read = 0;
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      if (onProgress) onProgress(read);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class Storage {
  /**
   * @param {string} baseDir directory that holds the database and case folders
   */
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.casesDir = path.join(baseDir, 'cases');
    fs.mkdirSync(this.casesDir, { recursive: true });
    this.dbPath = path.join(baseDir, 'forensic-transcriber.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const current = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    if (!current) {
      this.db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION));
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        case_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        original_path TEXT NOT NULL,
        derived_path TEXT,
        size_bytes INTEGER NOT NULL,
        format TEXT,
        codec TEXT,
        duration_seconds REAL,
        sample_rate INTEGER,
        channels INTEGER,
        bit_depth INTEGER,
        sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcripts (
        transcript_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
        language TEXT NOT NULL DEFAULT 'tr',
        model_id TEXT,
        engine TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(case_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS segments (
        -- A segment id is only meaningful within its transcript: the ASR engine
        -- numbers segments from zero for every recording. The key is therefore
        -- (transcript_id, segment_id), which keeps two recordings in the same
        -- case from colliding.
        segment_id TEXT NOT NULL,
        transcript_id TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        speaker TEXT NOT NULL DEFAULT 'SPEAKER_01',
        text TEXT NOT NULL DEFAULT '',
        -- The text as the ASR engine produced it. It is written once when the
        -- transcript is created and never overwritten, so an expert edit can
        -- never destroy the automatic output. The text column holds the current
        -- (possibly edited) text.
        original_text TEXT,
        status TEXT NOT NULL DEFAULT 'AUTOMATIC',
        confidence REAL,
        words_json TEXT,
        PRIMARY KEY (transcript_id, segment_id)
      );

      CREATE TABLE IF NOT EXISTS history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        target TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence(case_id);
      CREATE INDEX IF NOT EXISTS idx_segments_transcript ON segments(transcript_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_history_case ON history(case_id, history_id);
    `);

    this._migrateSegmentsOriginalText();
    this._migrateSegmentsCompositeKey();
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  /**
   * Schema migration: rebuild the segments table so its primary key is
   * (transcript_id, segment_id) instead of segment_id alone.
   *
   * The earlier key made a second recording in the same case fail with
   * "UNIQUE constraint failed: segments.segment_id", because every transcript
   * numbers its segments from zero. Rows are copied as-is; nothing is dropped or
   * merged, and the automatic text and provenance columns are preserved.
   */
  _migrateSegmentsCompositeKey() {
    const pkColumns = this.db
      .prepare('PRAGMA table_info(segments)')
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (pkColumns.length === 2 && pkColumns[0] === 'transcript_id' && pkColumns[1] === 'segment_id') {
      return; // already migrated
    }
    // Foreign keys are disabled for the rebuild and restored afterwards.
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE segments_v2 (
          segment_id TEXT NOT NULL,
          transcript_id TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          start_seconds REAL NOT NULL,
          end_seconds REAL NOT NULL,
          speaker TEXT NOT NULL DEFAULT 'SPEAKER_01',
          text TEXT NOT NULL DEFAULT '',
          original_text TEXT,
          status TEXT NOT NULL DEFAULT 'AUTOMATIC',
          confidence REAL,
          words_json TEXT,
          PRIMARY KEY (transcript_id, segment_id)
        );
        INSERT INTO segments_v2 (
          segment_id, transcript_id, ordinal, start_seconds, end_seconds,
          speaker, text, original_text, status, confidence, words_json
        )
        SELECT
          segment_id, transcript_id, ordinal, start_seconds, end_seconds,
          speaker, text, original_text, status, confidence, words_json
        FROM segments;
        DROP TABLE segments;
        ALTER TABLE segments_v2 RENAME TO segments;
        CREATE INDEX IF NOT EXISTS idx_segments_transcript ON segments(transcript_id, ordinal);
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Schema migration: add segments.original_text to databases created before it
   * existed. Existing rows get their current text as the original, which is the
   * best available reconstruction (nothing better was recorded at the time).
   */
  _migrateSegmentsOriginalText() {
    const columns = this.db.prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
    if (columns.includes('original_text')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE segments ADD COLUMN original_text TEXT');
      this.db.exec('UPDATE segments SET original_text = text WHERE original_text IS NULL');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  _caseDir(caseId) {
    return path.join(this.casesDir, caseId);
  }

  _touchCase(caseId) {
    this.db.prepare('UPDATE cases SET updated_at = ? WHERE case_id = ?').run(nowIso(), caseId);
  }

  recordHistory(caseId, action, target = null, detail = null) {
    this.db
      .prepare(
        'INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)'
      )
      .run(caseId, action, target, detail ? JSON.stringify(detail) : null, nowIso());
  }

  createCase({ title, notes = '' }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) {
      const err = new Error('Case title is required.');
      err.code = 'CASE_TITLE_REQUIRED';
      throw err;
    }
    const caseId = makeId('CASE');
    const dir = this._caseDir(caseId);
    for (const sub of ['evidence/original', 'evidence/derived', 'transcript', 'exports']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO cases(case_id, title, notes, case_dir, created_at, updated_at) VALUES(?,?,?,?,?,?)'
      )
      .run(caseId, cleanTitle, String(notes || ''), dir, ts, ts);
    this.recordHistory(caseId, HISTORY_ACTIONS.CASE_CREATED, caseId, { title: cleanTitle });
    return this.getCase(caseId);
  }

  listCases() {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM evidence e WHERE e.case_id = c.case_id) AS evidence_count
         FROM cases c ORDER BY c.updated_at DESC`
      )
      .all();
    return rows.map((r) => ({ ...r, evidence_count: Number(r.evidence_count) }));
  }

  getCase(caseId) {
    const row = this.db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId);
    if (!row) return null;
    return row;
  }

  updateCase(caseId, { title, notes }) {
    const existing = this.getCase(caseId);
    if (!existing) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const nextTitle = title === undefined ? existing.title : String(title).trim();
    if (!nextTitle) {
      const err = new Error('Case title is required.');
      err.code = 'CASE_TITLE_REQUIRED';
      throw err;
    }
    const nextNotes = notes === undefined ? existing.notes : String(notes);
    this.db
      .prepare('UPDATE cases SET title = ?, notes = ?, updated_at = ? WHERE case_id = ?')
      .run(nextTitle, nextNotes, nowIso(), caseId);
    return this.getCase(caseId);
  }

  deleteCase(caseId) {
    const existing = this.getCase(caseId);
    if (!existing) return false;
    this.db.prepare('DELETE FROM cases WHERE case_id = ?').run(caseId);
    const dir = existing.case_dir || this._caseDir(caseId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return true;
  }

  async importEvidence(caseId, sourcePath, metadata = {}) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      const err = new Error('Selected path is not a file.');
      err.code = 'NOT_A_FILE';
      throw err;
    }

    const evidenceId = makeId('EVIDENCE');
    const originalName = path.basename(sourcePath);
    const safeLeaf = sanitizeFileName(originalName);
    const storedName = `${evidenceId}__${safeLeaf}`;
    const dir = path.join(kase.case_dir, 'evidence', 'original');
    fs.mkdirSync(dir, { recursive: true });
    const destPath = path.join(dir, storedName);

    await fs.promises.copyFile(sourcePath, destPath);
    const digest = await sha256File(destPath);
    const finalStat = fs.statSync(destPath);

    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO evidence(
           evidence_id, case_id, original_name, stored_name, original_path, derived_path,
           size_bytes, format, codec, duration_seconds, sample_rate, channels, bit_depth,
           sha256, imported_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        evidenceId,
        caseId,
        originalName,
        storedName,
        destPath,
        null,
        finalStat.size,
        metadata.format ?? null,
        metadata.codec ?? null,
        metadata.durationSeconds ?? null,
        metadata.sampleRate ?? null,
        metadata.channels ?? null,
        metadata.bitDepth ?? null,
        digest,
        ts
      );

    this.recordHistory(caseId, HISTORY_ACTIONS.EVIDENCE_IMPORTED, evidenceId, {
      originalName,
      sizeBytes: finalStat.size,
      sha256: digest,
    });
    this._touchCase(caseId);
    return this.getEvidence(evidenceId);
  }

  getEvidence(evidenceId) {
    return this.db.prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(evidenceId) || null;
  }

  listEvidence(caseId) {
    return this.db
      .prepare('SELECT * FROM evidence WHERE case_id = ? ORDER BY imported_at ASC')
      .all(caseId);
  }

  setDerivedPath(evidenceId, derivedPath) {
    this.db.prepare('UPDATE evidence SET derived_path = ? WHERE evidence_id = ?').run(derivedPath, evidenceId);
    return this.getEvidence(evidenceId);
  }

  deleteEvidence(evidenceId) {
    const ev = this.getEvidence(evidenceId);
    if (!ev) return false;
    this.db.prepare('DELETE FROM evidence WHERE evidence_id = ?').run(evidenceId);
    for (const p of [ev.original_path, ev.derived_path]) {
      if (!p) continue;
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
    this._touchCase(ev.case_id);
    return true;
  }

  getTranscript(caseId, evidenceId) {
    return (
      this.db
        .prepare('SELECT * FROM transcripts WHERE case_id = ? AND evidence_id = ?')
        .get(caseId, evidenceId) || null
    );
  }

  getSegments(transcriptId) {
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE transcript_id = ? ORDER BY ordinal ASC')
      .all(transcriptId);
    return rows.map((r) => ({
      segment_id: r.segment_id,
      ordinal: Number(r.ordinal),
      start: Number(r.start_seconds),
      end: Number(r.end_seconds),
      speaker: r.speaker,
      text: r.text,
      original_text: r.original_text === null || r.original_text === undefined ? r.text : r.original_text,
      status: r.status,
      confidence: r.confidence === null ? null : Number(r.confidence),
      words: r.words_json ? JSON.parse(r.words_json) : null,
    }));
  }

  /**
   * Persist a transcript. Segments are written as a whole (the renderer owns
   * ordering/undo); a diff is recorded to the history table so the software
   * can show what changed without claiming a legal chain of custody.
   */
  saveTranscript(caseId, evidenceId, { language = 'tr', modelId, engine, segments, source = 'import' }) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const ev = this.getEvidence(evidenceId);
    if (!ev || ev.case_id !== caseId) {
      const err = new Error('Evidence does not belong to this case.');
      err.code = 'EVIDENCE_MISMATCH';
      throw err;
    }
    const normalized = normalizeSegments(segments);

    const existing = this.getTranscript(caseId, evidenceId);
    const ts = nowIso();
    const transcriptId = existing ? existing.transcript_id : makeId('TRANSCRIPT');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO transcripts(transcript_id, case_id, evidence_id, language, model_id, engine, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?)`
          )
          .run(transcriptId, caseId, evidenceId, language, modelId ?? null, engine ?? null, ts, ts);
      } else {
        this.db
          .prepare('UPDATE transcripts SET language = ?, model_id = ?, engine = ?, updated_at = ? WHERE transcript_id = ?')
          .run(language, modelId ?? existing.model_id, engine ?? existing.engine, ts, transcriptId);
      }

      // Preserve the text the engine originally produced. A segment that already
      // exists keeps its stored original_text; a brand-new segment (the first
      // transcription, or a manual insert) records the incoming text as the
      // original. This is what stops an expert edit from destroying the
      // automatic output, including across save and reopen.
      // The previous values must be read BEFORE the delete below.
      const previousOriginal = new Map();
      if (existing) {
        for (const row of this.db
          .prepare('SELECT segment_id, original_text FROM segments WHERE transcript_id = ?')
          .all(transcriptId)) {
          previousOriginal.set(row.segment_id, row.original_text);
        }
      }

      this.db.prepare('DELETE FROM segments WHERE transcript_id = ?').run(transcriptId);
      const insert = this.db.prepare(
        `INSERT INTO segments(segment_id, transcript_id, ordinal, start_seconds, end_seconds, speaker, text, original_text, status, confidence, words_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      );
      normalized.forEach((s, i) => {
        const carried = previousOriginal.has(s.segment_id)
          ? previousOriginal.get(s.segment_id)
          : (s.original_text ?? s.text);
        insert.run(
          s.segment_id,
          transcriptId,
          i,
          s.start,
          s.end,
          s.speaker,
          s.text,
          carried === undefined ? s.text : carried,
          s.status,
          s.confidence,
          s.words ? JSON.stringify(s.words) : null
        );
      });

      const action = existing ? HISTORY_ACTIONS.TRANSCRIPT_SAVED : HISTORY_ACTIONS.TRANSCRIPTION_CREATED;
      this.db
        .prepare('INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)')
        .run(
          caseId,
          action,
          transcriptId,
          JSON.stringify({ segmentCount: normalized.length, source, modelId: modelId ?? null }),
          ts
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this._touchCase(caseId);
    return { transcript: this.getTranscript(caseId, evidenceId), segments: this.getSegments(transcriptId) };
  }

  listHistory(caseId) {
    const rows = this.db
      .prepare('SELECT * FROM history WHERE case_id = ? ORDER BY history_id DESC LIMIT 1000')
      .all(caseId);
    return rows.map((r) => ({
      history_id: Number(r.history_id),
      action: r.action,
      target: r.target,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      created_at: r.created_at,
    }));
  }

  stats() {
    const count = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      cases: count('SELECT COUNT(*) AS n FROM cases'),
      evidence: count('SELECT COUNT(*) AS n FROM evidence'),
      segments: count('SELECT COUNT(*) AS n FROM segments'),
      schemaVersion: Number(
        this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value
      ),
    };
  }
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) {
    const err = new Error('segments must be an array.');
    err.code = 'INVALID_SEGMENTS';
    throw err;
  }
  const out = [];
  let previousStart = -Infinity;
  for (const raw of segments) {
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      const err = new Error('Segment start/end must be finite numbers.');
      err.code = 'INVALID_SEGMENTS';
      throw err;
    }
    if (end < start) {
      const err = new Error('Segment end precedes start.');
      err.code = 'INVALID_SEGMENTS';
      throw err;
    }
    if (start < previousStart - 1e-6) {
      const err = new Error('Segments must be ordered by start time.');
      err.code = 'INVALID_SEGMENTS';
      throw err;
    }
    previousStart = start;
    const status = SEGMENT_STATUS_VALUES.includes(raw.status) ? raw.status : SEGMENT_STATUS.AUTOMATIC;
    const text = typeof raw.text === 'string' && raw.text.trim().length ? raw.text : UNCLEAR_PLACEHOLDER;
    out.push({
      segment_id: typeof raw.segment_id === 'string' && raw.segment_id ? raw.segment_id : makeId('SEG'),
      start,
      end,
      speaker: typeof raw.speaker === 'string' && raw.speaker ? raw.speaker : 'SPEAKER_01',
      text,
      status,
      confidence: raw.confidence === null || raw.confidence === undefined ? null : Number(raw.confidence),
      words: Array.isArray(raw.words) ? raw.words : null,
    });
  }
  return out;
}

module.exports = { Storage, sha256File, sanitizeFileName, makeId, normalizeSegments, SCHEMA_VERSION };

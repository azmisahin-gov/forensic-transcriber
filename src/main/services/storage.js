'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { copyFileAtomic, fsyncDir } = require('./atomic');
const {
  HISTORY_ACTIONS,
  SEGMENT_STATUS,
  SEGMENT_STATUS_VALUES,
  REVISION_STATE,
  UNCLEAR_PLACEHOLDER,
} = require('../../shared/constants');

const SCHEMA_VERSION = 5;

// Assignable case metadata (56.12 görevlendirme / intake). Free text, no legal
// interpretation is derived from it. Stored on the case row so a case is
// self-contained; exported in archives and reports.
const CASE_ASSIGNMENT_FIELDS = Object.freeze([
  'file_number',
  'authority',
  'case_type',
  'assignment_date',
  'due_date',
  'assignment_description',
  'requested_questions',
  'scope',
]);

/**
 * Map the most advanced human status in a transcript to the revision state that
 * describes the snapshot. An empty/unedited transcript is MACHINE output.
 */
function statusSetToRevisionState(segments) {
  let state = REVISION_STATE.MACHINE;
  for (const s of segments) {
    if (s.status === SEGMENT_STATUS.VERIFIED) return REVISION_STATE.VERIFIED;
    if (s.status === SEGMENT_STATUS.EDITED) state = REVISION_STATE.EDITED;
    else if (s.status === SEGMENT_STATUS.REVIEWED && state === REVISION_STATE.MACHINE) {
      state = REVISION_STATE.REVIEWED;
    }
  }
  return state;
}

/** A segment set that carries any human action at all. */
function segmentsHaveHumanWork(segments) {
  return segments.some((s) => s.status !== SEGMENT_STATUS.AUTOMATIC);
}

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
    this._configure();
    try {
      this._migrate();
    } catch (err) {
      // A failed migration must not leave a half-open handle behind; close it so
      // the caller can retry (for example after freeing disk space for the
      // backup) without a lock on the database file.
      this.close();
      throw err;
    }
  }

  /**
   * Durability and concurrency pragmas.
   *
   * - `journal_mode = WAL` keeps readers from blocking the writer and survives a
   *   crash without corrupting the database.
   * - `synchronous = FULL` makes a commit durable on disk before it returns, so a
   *   power loss cannot lose an acknowledged write. The extra fsync per commit is
   *   negligible for this workload (a handful of saves per transcription) and is
   *   the correct trade-off for case data.
   * - `busy_timeout` waits instead of failing when another connection holds the
   *   lock, which matters if a second window or a tool ever opens the file.
   * - `foreign_keys = ON` keeps the cascade deletes honest.
   */
  _configure() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA wal_autocheckpoint = 1000;');
  }

  /**
   * Run SQLite's own integrity check. Returns a structured result rather than
   * throwing, so callers can warn without crashing the application.
   */
  healthCheck({ quick = true } = {}) {
    try {
      const rows = this.db.prepare(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all();
      const messages = rows.map((r) => Object.values(r)[0]).filter(Boolean);
      const ok = messages.length === 1 && messages[0] === 'ok';
      return { ok, messages };
    } catch (err) {
      return { ok: false, messages: [err.message] };
    }
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const current = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    const stored = current ? Number(current.value) : 0;
    const needsMigration = stored !== SCHEMA_VERSION;

    // Back up the database before any migration that could rewrite it, so a
    // crash or a bug mid-migration can never destroy the only copy. This is
    // fail-closed: if the backup cannot be written we abort the migration and
    // leave the existing database (and its schema version) untouched, rather
    // than risk rewriting user data with no recovery copy.
    let backupPath = null;
    if (needsMigration && this._databaseHasUserData()) {
      backupPath = `${this.dbPath}.pre-migration-v${stored}-${Date.now()}.bak`;
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        copyFileAtomic(this.dbPath, backupPath);
      } catch (backupErr) {
        const err = new Error(
          `Refusing to migrate: could not back up the database (${backupErr.message}). ` +
            'The existing database was left unchanged.'
        );
        err.code = 'MIGRATION_BACKUP_FAILED';
        err.cause = backupErr;
        throw err;
      }
    }

    this._createSchema();

    this._migrateSegmentsOriginalText();
    this._migrateSegmentsCompositeKey();
    this._migrateSegmentsFlags();
    this._migrateEvidenceAudioStreamCount();
    this._migrateCaseAssignment();
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
    this.lastMigration = { from: stored, to: SCHEMA_VERSION, backupPath };
  }

  /** True when the database already holds user data worth backing up. */
  _databaseHasUserData() {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM cases').get();
      return Number(row.n) > 0;
    } catch {
      // The cases table may not exist yet on a brand-new database.
      return false;
    }
  }

  /** Create the tables, indexes and history table if they do not exist. */
  _createSchema() {
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
        imported_at TEXT NOT NULL,
        -- Number of audio streams in the container. >1 means the pipeline
        -- decodes stream order 0; the UI warns instead of transcribing a
        -- multi-track file silently.
        audio_stream_count INTEGER
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
        -- Operator working flags on a segment (e.g. UNCLEAR, REVISIT, REVIEW).
        -- These are local review state, never a legal finding, and are kept
        -- separate from the status column so they survive a save/reopen.
        flags_json TEXT,
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

      -- One row per transcription attempt (success or failure). It records the
      -- exact inputs and settings used, so a later reviewer can see how a
      -- transcript was produced and with which model and runtime.
      CREATE TABLE IF NOT EXISTS transcription_runs (
        run_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id) ON DELETE CASCADE,
        transcript_id TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        input_sha256 TEXT,
        derived_sha256 TEXT,
        engine TEXT,
        engine_version TEXT,
        model_id TEXT,
        model_sha256 TEXT,
        vad INTEGER,
        vad_model TEXT,
        settings_json TEXT,
        runtime_mode TEXT,
        runtime_reason TEXT,
        app_version TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_case ON transcription_runs(case_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_evidence ON transcription_runs(evidence_id, started_at);

      -- Immutable snapshots of a transcript. A new ASR run, or a save, appends a
      -- revision instead of overwriting the previous one, so reviewed/edited/
      -- verified human work is never silently destroyed. Exactly one revision
      -- per transcript is current (is_current = 1); the rest stay readable.
      CREATE TABLE IF NOT EXISTS transcript_revisions (
        revision_id TEXT PRIMARY KEY,
        transcript_id TEXT NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
        run_id TEXT,
        state TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        segments_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_transcript ON transcript_revisions(transcript_id, created_at);

      -- Working notes / bookmarks anchored to a recording timestamp. Personal
      -- work aids, not legal findings. kind separates a plain note from a
      -- bookmark so the workspace can filter them.
      CREATE TABLE IF NOT EXISTS notes (
        note_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        evidence_id TEXT REFERENCES evidence(evidence_id) ON DELETE CASCADE,
        at_seconds REAL,
        kind TEXT NOT NULL DEFAULT 'NOTE',
        category TEXT,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_case ON notes(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_notes_evidence ON notes(evidence_id, at_seconds);

      -- Structured report document for a case. One row per case; the sections
      -- are stored as JSON so the operator can reorder/rename them, and the
      -- renderer builds DOCX/PDF/HTML/TXT from the same data.
      CREATE TABLE IF NOT EXISTS reports (
        case_id TEXT PRIMARY KEY REFERENCES cases(case_id) ON DELETE CASCADE,
        template TEXT NOT NULL DEFAULT 'generic',
        title TEXT NOT NULL DEFAULT '',
        sections_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Local key/value preferences (panel sizes, playback, defaults). Never
      -- leaves the machine.
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Local support diagnostics ring buffer. Redacted; never contains
      -- transcript text, audio or case content.
      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        code TEXT,
        summary TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostics_created ON diagnostics(created_at);
    `);

    this._migrateSegmentsOriginalText();
    this._migrateSegmentsCompositeKey();
    this._migrateSegmentsFlags();
    this._migrateEvidenceAudioStreamCount();
    this._migrateCaseAssignment();
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  /**
   * Schema migration: add evidence.audio_stream_count for databases created
   * before multi-audio-stream tracking. Existing rows stay NULL (unknown),
   * which reads as "not inspected" rather than "single stream".
   */
  _migrateEvidenceAudioStreamCount() {
    const columns = this.db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name);
    if (columns.includes('audio_stream_count')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE evidence ADD COLUMN audio_stream_count INTEGER');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Schema migration: add the case-assignment (görevlendirme) columns to
   * databases created before case intake existed. Existing cases get empty
   * strings, which the UI treats as "not filled in yet".
   */
  _migrateCaseAssignment() {
    const columns = this.db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name);
    const missing = CASE_ASSIGNMENT_FIELDS.filter((f) => !columns.includes(f));
    if (!missing.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const field of missing) {
        this.db.exec(`ALTER TABLE cases ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
          flags_json TEXT,
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

  /**
   * Schema migration: add segments.flags_json for operator working flags
   * (unclear / revisit / review). Existing rows get NULL (no flags).
   */
  _migrateSegmentsFlags() {
    const columns = this.db.prepare('PRAGMA table_info(segments)').all().map((c) => c.name);
    if (columns.includes('flags_json')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE segments ADD COLUMN flags_json TEXT');
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

  createCase({ title, notes = '', ...assignment }) {
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
    const assign = {};
    for (const field of CASE_ASSIGNMENT_FIELDS) {
      assign[field] = assignment[field] === undefined || assignment[field] === null ? '' : String(assignment[field]);
    }
    const cols = ['case_id', 'title', 'notes', 'case_dir', 'created_at', 'updated_at', ...CASE_ASSIGNMENT_FIELDS];
    const placeholders = cols.map(() => '?').join(',');
    const values = [caseId, cleanTitle, String(notes || ''), dir, ts, ts, ...CASE_ASSIGNMENT_FIELDS.map((f) => assign[f])];
    this.db.prepare(`INSERT INTO cases(${cols.join(',')}) VALUES(${placeholders})`).run(...values);
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

  updateCase(caseId, patch = {}) {
    const existing = this.getCase(caseId);
    if (!existing) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const nextTitle = patch.title === undefined ? existing.title : String(patch.title).trim();
    if (!nextTitle) {
      const err = new Error('Case title is required.');
      err.code = 'CASE_TITLE_REQUIRED';
      throw err;
    }
    const sets = ['title = ?', 'notes = ?', 'updated_at = ?'];
    const values = [nextTitle, patch.notes === undefined ? existing.notes : String(patch.notes), nowIso()];
    for (const field of CASE_ASSIGNMENT_FIELDS) {
      if (patch[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(patch[field] === null ? '' : String(patch[field]));
    }
    values.push(caseId);
    this.db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE case_id = ?`).run(...values);
    return this.getCase(caseId);
  }

  /**
   * Operational summary for the case dashboard. Counts are derived from the
   * live tables so the dashboard can never show a stale snapshot.
   */
  caseDashboard(caseId) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const evidence = this.listEvidence(caseId);
    const one = (sql, ...args) => Number(this.db.prepare(sql).get(...args).n);
    let transcribed = 0;
    let reviewed = 0;
    let verified = 0;
    let unclear = 0;
    let segmentsTotal = 0;
    for (const ev of evidence) {
      const t = this.getTranscript(caseId, ev.evidence_id);
      if (!t) continue;
      transcribed += 1;
      const segs = this.getSegments(t.transcript_id);
      segmentsTotal += segs.length;
      if (segs.length && segs.every((s) => s.status === SEGMENT_STATUS.VERIFIED)) verified += 1;
      else if (segs.some((s) => s.status === SEGMENT_STATUS.REVIEWED || s.status === SEGMENT_STATUS.EDITED || s.status === SEGMENT_STATUS.VERIFIED)) reviewed += 1;
      unclear += segs.filter((s) => s.status === SEGMENT_STATUS.AUTOMATIC && s.text === UNCLEAR_PLACEHOLDER).length;
    }
    const failedRuns = one(
      `SELECT COUNT(*) AS n FROM transcription_runs WHERE case_id = ? AND status = 'FAILED'`,
      caseId
    );
    const missingAssignment = CASE_ASSIGNMENT_FIELDS.filter((f) => !String(kase[f] || '').trim()).length;
    return {
      case_id: caseId,
      title: kase.title,
      due_date: kase.due_date || null,
      updated_at: kase.updated_at,
      evidence: evidence.length,
      transcribed,
      reviewed,
      verified,
      pending: evidence.length - transcribed,
      segments: segmentsTotal,
      unclear_segments: unclear,
      failed_runs: failedRuns,
      notes: one('SELECT COUNT(*) AS n FROM notes WHERE case_id = ?', caseId),
      revisions: one(
        `SELECT COUNT(*) AS n FROM transcript_revisions r
           JOIN transcripts t ON t.transcript_id = r.transcript_id WHERE t.case_id = ?`,
        caseId
      ),
      missing_assignment_fields: missingAssignment,
    };
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

    // Copy into a temp file, verify it, then rename atomically. A crash or a
    // failed copy can therefore never leave a half-written file as this case's
    // evidence, and no evidence row is written until the bytes are complete.
    const tmpPath = path.join(dir, `.${storedName}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.promises.copyFile(sourcePath, tmpPath);
      const finalStat = fs.statSync(tmpPath);
      if (finalStat.size !== stat.size) {
        const err = new Error('Evidence copy is incomplete (size mismatch).');
        err.code = 'EVIDENCE_COPY_INCOMPLETE';
        throw err;
      }
      const digest = await sha256File(tmpPath);
      fs.renameSync(tmpPath, destPath);
      fsyncDir(dir);

      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO evidence(
             evidence_id, case_id, original_name, stored_name, original_path, derived_path,
             size_bytes, format, codec, duration_seconds, sample_rate, channels, bit_depth,
             sha256, imported_at, audio_stream_count
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
          ts,
          Number.isFinite(metadata.audioStreamCount) ? metadata.audioStreamCount : null
        );

      this.recordHistory(caseId, HISTORY_ACTIONS.EVIDENCE_IMPORTED, evidenceId, {
        originalName,
        sizeBytes: finalStat.size,
        sha256: digest,
      });
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }

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
      flags: r.flags_json ? JSON.parse(r.flags_json) : [],
    }));
  }

  /**
   * Set or clear the operator working flags on a single segment. Flags are
   * local review state (unclear / revisit / review). They are stored on the
   * current transcript row; the caller re-saves the transcript so flags travel
   * with the revision. Kept tiny on purpose — this is not a status change.
   */
  setSegmentFlags(transcriptId, segmentId, flags) {
    const list = Array.isArray(flags) ? flags.filter((f) => typeof f === 'string' && f) : [];
    const info = this.db
      .prepare('UPDATE segments SET flags_json = ? WHERE transcript_id = ? AND segment_id = ?')
      .run(list.length ? JSON.stringify(list) : null, transcriptId, segmentId);
    return info.changes > 0;
  }

  /**
   * Persist a transcript as a new immutable revision.
   *
   * A save always appends a revision. Human saves (REVIEWED/EDITED/VERIFIED, or
   * an explicit review save) become the current revision. A machine (ASR) save
   * becomes current only on the first transcription of an evidence file;
   * thereafter it is stored as an additional, non-current revision so a new ASR
   * run can never silently overwrite reviewed/edited/verified human work. The
   * caller opts back in with `forceCurrent` (used when the operator explicitly
   * accepts the new machine transcript).
   */
  saveTranscript(caseId, evidenceId, { language = 'tr', modelId, engine, segments, source = 'import', runId = null, forceCurrent = false }) {
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

    let currentRevision = this.getCurrentRevision(transcriptId);
    // A transcript created before revisions existed has no revision row; capture
    // its current segments as the baseline MACHINE revision before appending.
    if (existing && !currentRevision) {
      const legacySegments = this.getSegments(transcriptId);
      currentRevision = this._createRevision(transcriptId, {
        state: statusSetToRevisionState(legacySegments),
        isCurrent: true,
        runId: null,
        segments: legacySegments,
        createdAt: ts,
      });
    }

    const incomingState = statusSetToRevisionState(normalized);
    const isHumanSave = segmentsHaveHumanWork(normalized) || source !== 'asr';
    let makeCurrent = forceCurrent || !existing || isHumanSave || !currentRevision;
    // Never let a machine save displace a human current revision.
    if (makeCurrent && !isHumanSave && currentRevision && currentRevision.state !== REVISION_STATE.MACHINE) {
      makeCurrent = false;
    }

    // Preserve the text the engine originally produced. A segment that already
    // exists keeps its stored original_text; a brand-new segment records the
    // incoming text as the original. Read the previous values before rewriting.
    const previousOriginal = new Map();
    if (existing) {
      for (const row of this.db
        .prepare('SELECT segment_id, original_text FROM segments WHERE transcript_id = ?')
        .all(transcriptId)) {
        previousOriginal.set(row.segment_id, row.original_text);
      }
    }
    const revisionSegments = normalized.map((s) => {
      const carried = previousOriginal.has(s.segment_id)
        ? previousOriginal.get(s.segment_id)
        : (s.original_text ?? s.text);
      return { ...s, original_text: carried === undefined ? s.text : carried };
    });

    let newRevision;
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

      newRevision = this._createRevision(transcriptId, {
        state: incomingState,
        isCurrent: makeCurrent,
        runId,
        segments: revisionSegments,
        createdAt: ts,
      });

      if (makeCurrent) {
        this.db.prepare('DELETE FROM segments WHERE transcript_id = ?').run(transcriptId);
        const insert = this.db.prepare(
          `INSERT INTO segments(segment_id, transcript_id, ordinal, start_seconds, end_seconds, speaker, text, original_text, status, confidence, words_json, flags_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        revisionSegments.forEach((s, i) => {
          insert.run(
            s.segment_id,
            transcriptId,
            i,
            s.start,
            s.end,
            s.speaker,
            s.text,
            s.original_text,
            s.status,
            s.confidence,
            s.words ? JSON.stringify(s.words) : null,
            s.flags && s.flags.length ? JSON.stringify(s.flags) : null
          );
        });
      }

      const action = existing ? HISTORY_ACTIONS.TRANSCRIPT_SAVED : HISTORY_ACTIONS.TRANSCRIPTION_CREATED;
      this.db
        .prepare('INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)')
        .run(
          caseId,
          action,
          transcriptId,
          JSON.stringify({
            segmentCount: revisionSegments.length,
            source,
            modelId: modelId ?? null,
            revisionId: newRevision.revision_id,
            revisionState: incomingState,
            becameCurrent: makeCurrent,
          }),
          ts
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this._touchCase(caseId);
    const current = this.getCurrentRevision(transcriptId);
    return {
      transcript: this.getTranscript(caseId, evidenceId),
      segments: this.getSegments(transcriptId),
      revision: this._describeRevision(newRevision),
      currentRevision: current ? this._describeRevision(current) : null,
      revisionBecameCurrent: makeCurrent,
    };
  }

  /** Insert a revision row. Caller supplies the surrounding transaction. */
  _createRevision(transcriptId, { state, isCurrent, runId = null, segments, createdAt }) {
    const revisionId = makeId('REV');
    if (isCurrent) {
      this.db.prepare('UPDATE transcript_revisions SET is_current = 0 WHERE transcript_id = ?').run(transcriptId);
    }
    this.db
      .prepare(
        `INSERT INTO transcript_revisions(revision_id, transcript_id, run_id, state, is_current, created_at, segments_json)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(revisionId, transcriptId, runId, state, isCurrent ? 1 : 0, createdAt, JSON.stringify(segments));
    return {
      revision_id: revisionId,
      transcript_id: transcriptId,
      run_id: runId,
      state,
      is_current: isCurrent ? 1 : 0,
      created_at: createdAt,
      segments_json: JSON.stringify(segments),
    };
  }

  getCurrentRevision(transcriptId) {
    return (
      this.db
        .prepare('SELECT * FROM transcript_revisions WHERE transcript_id = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1')
        .get(transcriptId) || null
    );
  }

  /** Current revision, shaped for callers (includes its segments). */
  getCurrentRevisionInfo(transcriptId) {
    return this._describeRevision(this.getCurrentRevision(transcriptId));
  }

  getRevision(revisionId) {
    const row = this.db.prepare('SELECT * FROM transcript_revisions WHERE revision_id = ?').get(revisionId);
    return row ? this._describeRevision(row) : null;
  }

  listRevisions(transcriptId) {
    return this.db
      .prepare('SELECT * FROM transcript_revisions WHERE transcript_id = ? ORDER BY created_at DESC, revision_id DESC')
      .all(transcriptId)
      .map((r) => this._describeRevision(r));
  }

  /**
   * Make an existing revision current and restore its segments into the live
   * transcript table. This is the explicit "use this version" action; it can
   * bring back an older reviewed revision after a new machine run.
   */
  setCurrentRevision(revisionId) {
    const revision = this.db.prepare('SELECT * FROM transcript_revisions WHERE revision_id = ?').get(revisionId);
    if (!revision) {
      const err = new Error('Revision not found.');
      err.code = 'REVISION_NOT_FOUND';
      throw err;
    }
    const transcriptId = revision.transcript_id;
    const segments = JSON.parse(revision.segments_json);
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE transcript_revisions SET is_current = 0 WHERE transcript_id = ?').run(transcriptId);
      this.db.prepare('UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = ?').run(revisionId);
      this.db.prepare('DELETE FROM segments WHERE transcript_id = ?').run(transcriptId);
      const insert = this.db.prepare(
        `INSERT INTO segments(segment_id, transcript_id, ordinal, start_seconds, end_seconds, speaker, text, original_text, status, confidence, words_json, flags_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      segments.forEach((s, i) => {
        insert.run(
          s.segment_id,
          transcriptId,
          i,
          s.start,
          s.end,
          s.speaker || 'SPEAKER_01',
          s.text,
          s.original_text === undefined ? s.text : s.original_text,
          s.status,
          s.confidence === undefined ? null : s.confidence,
          s.words ? JSON.stringify(s.words) : null,
          s.flags && s.flags.length ? JSON.stringify(s.flags) : null
        );
      });
      this.db
        .prepare('UPDATE transcripts SET updated_at = ? WHERE transcript_id = ?')
        .run(ts, transcriptId);
      const transcript = this.db.prepare('SELECT * FROM transcripts WHERE transcript_id = ?').get(transcriptId);
      this.db
        .prepare('INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)')
        .run(
          transcript.case_id,
          'REVISION_SET_CURRENT',
          transcriptId,
          JSON.stringify({ revisionId, state: revision.state, segmentCount: segments.length }),
          ts
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const current = this.getCurrentRevision(transcriptId);
    const transcript = this.db.prepare('SELECT * FROM transcripts WHERE transcript_id = ?').get(transcriptId);
    return {
      transcript,
      segments: this.getSegments(transcriptId),
      currentRevision: this._describeRevision(current),
    };
  }

  /** Shape a revision row for callers; `segments` is included when materialised. */
  _describeRevision(row, { includeSegments = true } = {}) {
    if (!row) return null;
    let segments = null;
    if (includeSegments && row.segments_json !== undefined) {
      try {
        segments = JSON.parse(row.segments_json);
      } catch {
        segments = [];
      }
    }
    return {
      revision_id: row.revision_id,
      transcript_id: row.transcript_id,
      run_id: row.run_id,
      state: row.state,
      is_current: Boolean(row.is_current),
      created_at: row.created_at,
      segment_count: segments ? segments.length : undefined,
      segments,
    };
  }

  /**
   * Record the start of a transcription attempt. Returns a run id the caller
   * uses to complete the record.
   */
  startTranscriptionRun(caseId, evidenceId, info = {}) {
    const runId = makeId('RUN');
    this.db
      .prepare(
        `INSERT INTO transcription_runs(
           run_id, case_id, evidence_id, transcript_id, status, input_sha256, derived_sha256,
           engine, engine_version, model_id, model_sha256, vad, vad_model, settings_json,
           runtime_mode, runtime_reason, app_version, started_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        runId,
        caseId,
        evidenceId,
        info.transcriptId ?? null,
        'STARTED',
        info.inputSha256 ?? null,
        info.derivedSha256 ?? null,
        info.engine ?? null,
        info.engineVersion ?? null,
        info.modelId ?? null,
        info.modelSha256 ?? null,
        info.vad === undefined || info.vad === null ? null : (info.vad ? 1 : 0),
        info.vadModel ?? null,
        info.settings ? JSON.stringify(info.settings) : null,
        info.runtimeMode ?? null,
        info.runtimeReason ?? null,
        info.appVersion ?? null,
        nowIso()
      );
    return runId;
  }

  /** Complete a transcription run (success or failure). */
  finishTranscriptionRun(runId, { status, errorCode = null, transcriptId = null, runtimeMode = null, runtimeReason = null } = {}) {
    this.db
      .prepare(
        `UPDATE transcription_runs
           SET status = ?, error_code = ?, transcript_id = COALESCE(?, transcript_id),
               runtime_mode = COALESCE(?, runtime_mode), runtime_reason = COALESCE(?, runtime_reason),
               finished_at = ?
         WHERE run_id = ?`
      )
      .run(status, errorCode, transcriptId, runtimeMode, runtimeReason, nowIso(), runId);
  }

  listTranscriptionRuns(caseId, evidenceId = null) {
    const rows = evidenceId
      ? this.db.prepare('SELECT * FROM transcription_runs WHERE case_id = ? AND evidence_id = ? ORDER BY started_at DESC').all(caseId, evidenceId)
      : this.db.prepare('SELECT * FROM transcription_runs WHERE case_id = ? ORDER BY started_at DESC').all(caseId);
    return rows.map((r) => ({
      ...r,
      vad: r.vad === null ? null : Boolean(r.vad),
      settings: r.settings_json ? JSON.parse(r.settings_json) : null,
    }));
  }

  /**
   * Restore a transcription run from a case archive. All provenance fields and
   * timestamps are preserved; a fresh run id is generated so restoring the same
   * archive twice can never collide. The caller supplies already-remapped
   * evidence and transcript ids.
   */
  restoreTranscriptionRun(caseId, evidenceId, run, { transcriptId = null, runId = null } = {}) {
    const id = runId || makeId('RUN');
    this.db
      .prepare(
        `INSERT INTO transcription_runs(
           run_id, case_id, evidence_id, transcript_id, status, error_code, input_sha256,
           derived_sha256, engine, engine_version, model_id, model_sha256, vad, vad_model,
           settings_json, runtime_mode, runtime_reason, app_version, started_at, finished_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        caseId,
        evidenceId,
        transcriptId,
        run.status,
        run.error_code ?? null,
        run.input_sha256 ?? null,
        run.derived_sha256 ?? null,
        run.engine ?? null,
        run.engine_version ?? null,
        run.model_id ?? null,
        run.model_sha256 ?? null,
        run.vad === undefined || run.vad === null ? null : run.vad ? 1 : 0,
        run.vad_model ?? null,
        run.settings_json ?? null,
        run.runtime_mode ?? null,
        run.runtime_reason ?? null,
        run.app_version ?? null,
        run.started_at,
        run.finished_at ?? null
      );
    return id;
  }

  /**
   * Replace a transcript's live segments with the supplied set. Used by the
   * save, set-current-revision and archive-restore paths.
   */
  _replaceSegments(transcriptId, segments) {
    this.db.prepare('DELETE FROM segments WHERE transcript_id = ?').run(transcriptId);
    const insert = this.db.prepare(
      `INSERT INTO segments(segment_id, transcript_id, ordinal, start_seconds, end_seconds, speaker, text, original_text, status, confidence, words_json, flags_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    segments.forEach((s, i) => {
      insert.run(
        s.segment_id,
        transcriptId,
        i,
        s.start,
        s.end,
        s.speaker || 'SPEAKER_01',
        s.text,
        s.original_text === undefined || s.original_text === null ? s.text : s.original_text,
        s.status,
        s.confidence === undefined ? null : s.confidence,
        s.words ? JSON.stringify(s.words) : null,
        s.flags && s.flags.length ? JSON.stringify(s.flags) : null
      );
    });
  }

  /**
   * Restore a transcript together with all of its revisions, preserving the
   * revision states, the current marker and the original timestamps. Used by
   * case-archive restore so a round-trip does not lose provenance. Run ids are
   * remapped by the caller through `runIdMap` (old archive run id -> new run id).
   *
   * @returns {{transcript:object, currentRevision:object}}
   */
  restoreTranscript(caseId, evidenceId, transcript, revisions = [], { runIdMap = new Map(), transcriptId = null } = {}) {
    const newTranscriptId = transcriptId || makeId('TRANSCRIPT');
    const createdAt = transcript.created_at || nowIso();
    const updatedAt = transcript.updated_at || createdAt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO transcripts(transcript_id, case_id, evidence_id, language, model_id, engine, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(
          newTranscriptId,
          caseId,
          evidenceId,
          transcript.language || 'tr',
          transcript.model_id ?? null,
          transcript.engine ?? null,
          createdAt,
          updatedAt
        );

      const ordered = [...revisions].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      let current = null;
      for (const rev of ordered) {
        const mappedRun = rev.run_id ? runIdMap.get(rev.run_id) || null : null;
        const row = {
          revision_id: makeId('REV'),
          transcript_id: newTranscriptId,
          run_id: mappedRun,
          state: rev.state,
          is_current: rev.is_current ? 1 : 0,
          created_at: rev.created_at || createdAt,
          segments_json: JSON.stringify(rev.segments || []),
        };
        this.db
          .prepare(
            `INSERT INTO transcript_revisions(revision_id, transcript_id, run_id, state, is_current, created_at, segments_json)
             VALUES(?,?,?,?,?,?,?)`
          )
          .run(
            row.revision_id,
            row.transcript_id,
            row.run_id,
            row.state,
            row.is_current,
            row.created_at,
            row.segments_json
          );
        if (row.is_current) current = row;
      }
      // Guarantee exactly one current revision. A legacy archive without an
      // explicit current marker falls back to the newest revision.
      if (!current && ordered.length) {
        const newest = this.db
          .prepare('SELECT * FROM transcript_revisions WHERE transcript_id = ? ORDER BY created_at DESC, revision_id DESC LIMIT 1')
          .get(newTranscriptId);
        this.db.prepare('UPDATE transcript_revisions SET is_current = 1 WHERE revision_id = ?').run(newest.revision_id);
        current = newest;
      }
      if (current) {
        this._replaceSegments(newTranscriptId, JSON.parse(current.segments_json));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return {
      transcript_id: newTranscriptId,
      transcript: this.db.prepare('SELECT * FROM transcripts WHERE transcript_id = ?').get(newTranscriptId),
      currentRevision: this._describeRevision(
        this.db.prepare('SELECT * FROM transcript_revisions WHERE transcript_id = ? AND is_current = 1 LIMIT 1').get(newTranscriptId)
      ),
    };
  }

  /** Point a restored run at its restored transcript (provenance link). */
  linkRunTranscript(runId, transcriptId) {
    this.db.prepare('UPDATE transcription_runs SET transcript_id = ? WHERE run_id = ?').run(transcriptId, runId);
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

  // ------------------------------------------------------------------- notes
  _describeNote(row) {
    if (!row) return null;
    return {
      note_id: row.note_id,
      case_id: row.case_id,
      evidence_id: row.evidence_id,
      at_seconds: row.at_seconds === null || row.at_seconds === undefined ? null : Number(row.at_seconds),
      kind: row.kind,
      category: row.category,
      body: row.body,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  createNote(caseId, { evidenceId = null, atSeconds = null, kind = 'NOTE', category = null, body = '' } = {}) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    if (evidenceId && !this.getEvidence(evidenceId)) {
      const err = new Error('Evidence not found.');
      err.code = 'EVIDENCE_NOT_FOUND';
      throw err;
    }
    const noteId = makeId('NOTE');
    const ts = nowIso();
    const at = atSeconds === null || atSeconds === undefined ? null : Number(atSeconds);
    this.db
      .prepare(
        `INSERT INTO notes(note_id, case_id, evidence_id, at_seconds, kind, category, body, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        noteId,
        caseId,
        evidenceId,
        Number.isFinite(at) ? at : null,
        String(kind || 'NOTE'),
        category === null || category === undefined ? null : String(category),
        String(body || ''),
        ts,
        ts
      );
    this.recordHistory(caseId, kind === 'BOOKMARK' ? 'BOOKMARK_ADDED' : 'NOTE_ADDED', evidenceId, {
      noteId,
      atSeconds: Number.isFinite(at) ? at : null,
    });
    this._touchCase(caseId);
    return this._describeNote(this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId));
  }

  updateNote(noteId, { body, category, kind } = {}) {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId);
    if (!row) {
      const err = new Error('Note not found.');
      err.code = 'NOTE_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    if (body !== undefined) {
      sets.push('body = ?');
      values.push(String(body));
    }
    if (category !== undefined) {
      sets.push('category = ?');
      values.push(category === null ? null : String(category));
    }
    if (kind !== undefined) {
      sets.push('kind = ?');
      values.push(String(kind));
    }
    values.push(noteId);
    this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE note_id = ?`).run(...values);
    return this._describeNote(this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId));
  }

  deleteNote(noteId) {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId);
    if (!row) return false;
    this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(noteId);
    this.recordHistory(row.case_id, 'NOTE_DELETED', row.evidence_id, { noteId });
    return true;
  }

  listNotes(caseId, { evidenceId = null } = {}) {
    const rows = evidenceId
      ? this.db.prepare('SELECT * FROM notes WHERE case_id = ? AND evidence_id = ? ORDER BY at_seconds ASC, created_at ASC').all(caseId, evidenceId)
      : this.db.prepare('SELECT * FROM notes WHERE case_id = ? ORDER BY created_at ASC').all(caseId);
    return rows.map((r) => this._describeNote(r));
  }

  // ----------------------------------------------------------------- reports
  getReport(caseId) {
    const row = this.db.prepare('SELECT * FROM reports WHERE case_id = ?').get(caseId);
    if (!row) return null;
    return {
      case_id: row.case_id,
      template: row.template,
      title: row.title,
      sections: row.sections_json ? JSON.parse(row.sections_json) : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  saveReport(caseId, { template = 'generic', title = '', sections = [] } = {}) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const existing = this.getReport(caseId);
    const ts = nowIso();
    const payload = JSON.stringify(Array.isArray(sections) ? sections : []);
    if (existing) {
      this.db
        .prepare('UPDATE reports SET template = ?, title = ?, sections_json = ?, updated_at = ? WHERE case_id = ?')
        .run(String(template), String(title || ''), payload, ts, caseId);
    } else {
      this.db
        .prepare(
          'INSERT INTO reports(case_id, template, title, sections_json, created_at, updated_at) VALUES(?,?,?,?,?,?)'
        )
        .run(caseId, String(template), String(title || ''), payload, ts, ts);
    }
    this.recordHistory(caseId, 'REPORT_SAVED', caseId, { template, sectionCount: (Array.isArray(sections) ? sections : []).length });
    this._touchCase(caseId);
    return this.getReport(caseId);
  }

  // ------------------------------------------------------------ preferences
  getPreference(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(String(key));
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setPreference(key, value) {
    this.db
      .prepare(
        `INSERT INTO preferences(key, value, updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(String(key), JSON.stringify(value === undefined ? null : value), nowIso());
    return value;
  }

  allPreferences() {
    const out = {};
    for (const row of this.db.prepare('SELECT key, value FROM preferences').all()) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = null;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ diagnostics
  recordDiagnostic({ level = 'info', category = 'app', code = null, summary = '', detail = null } = {}) {
    this.db
      .prepare(
        'INSERT INTO diagnostics(level, category, code, summary, detail_json, created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(
        String(level),
        String(category),
        code === null ? null : String(code),
        String(summary || '').slice(0, 500),
        detail === null ? null : JSON.stringify(detail),
        nowIso()
      );
    // Keep the ring buffer bounded so it never grows without limit.
    this.db
      .prepare(
        'DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 500)'
      )
      .run();
  }

  listDiagnostics(limit = 200) {
    const rows = this.db
      .prepare('SELECT * FROM diagnostics ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, Number(limit) || 200)));
    return rows.map((r) => ({
      id: Number(r.id),
      level: r.level,
      category: r.category,
      code: r.code,
      summary: r.summary,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
      created_at: r.created_at,
    }));
  }

  // ---------------------------------------------------------------- search
  /**
   * Search a case's transcript segments, speakers, notes/bookmarks and evidence
   * names. Case-insensitive substring match. Returns positioned hits so the UI
   * can jump straight to the recording time.
   */
  searchCase(caseId, query, { limit = 200 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { query: '', hits: [] };
    const max = Math.max(1, Math.min(1000, Number(limit) || 200));
    const hits = [];
    const push = (hit) => {
      if (hits.length < max) hits.push(hit);
    };

    const evidence = this.listEvidence(caseId);
    const evById = new Map(evidence.map((e) => [e.evidence_id, e]));

    for (const ev of evidence) {
      if (String(ev.original_name || '').toLowerCase().includes(q)) {
        push({ type: 'evidence', evidence_id: ev.evidence_id, evidence_name: ev.original_name, text: ev.original_name });
      }
    }

    for (const ev of evidence) {
      const t = this.getTranscript(caseId, ev.evidence_id);
      if (!t) continue;
      for (const s of this.getSegments(t.transcript_id)) {
        if (String(s.text || '').toLowerCase().includes(q) || String(s.speaker || '').toLowerCase().includes(q)) {
          push({
            type: 'segment',
            evidence_id: ev.evidence_id,
            evidence_name: ev.original_name,
            transcript_id: t.transcript_id,
            segment_id: s.segment_id,
            start: s.start,
            end: s.end,
            speaker: s.speaker,
            status: s.status,
            text: s.text,
          });
        }
      }
    }

    for (const n of this.listNotes(caseId)) {
      if (String(n.body || '').toLowerCase().includes(q) || String(n.category || '').toLowerCase().includes(q)) {
        const ev = n.evidence_id ? evById.get(n.evidence_id) : null;
        push({
          type: n.kind === 'BOOKMARK' ? 'bookmark' : 'note',
          note_id: n.note_id,
          evidence_id: n.evidence_id,
          evidence_name: ev ? ev.original_name : null,
          at_seconds: n.at_seconds,
          category: n.category,
          text: n.body,
        });
      }
    }

    return { query: String(query), hits };
  }

  stats() {
    const count = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      cases: count('SELECT COUNT(*) AS n FROM cases'),
      evidence: count('SELECT COUNT(*) AS n FROM evidence'),
      segments: count('SELECT COUNT(*) AS n FROM segments'),
      revisions: count('SELECT COUNT(*) AS n FROM transcript_revisions'),
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
      // Carried through so a caller restoring an archive can preserve the
      // original machine text. The save path still prefers the value already
      // stored for an existing segment.
      original_text: typeof raw.original_text === 'string' ? raw.original_text : undefined,
      status,
      confidence: raw.confidence === null || raw.confidence === undefined ? null : Number(raw.confidence),
      words: Array.isArray(raw.words) ? raw.words : null,
      flags: Array.isArray(raw.flags) ? raw.flags.filter((f) => typeof f === 'string' && f) : [],
    });
  }
  return out;
}

module.exports = {
  Storage,
  sha256File,
  sanitizeFileName,
  makeId,
  normalizeSegments,
  statusSetToRevisionState,
  SCHEMA_VERSION,
  CASE_ASSIGNMENT_FIELDS,
};

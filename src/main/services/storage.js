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
  REPORT_REVISION_STATE,
  UNCLEAR_PLACEHOLDER,
  SPEECH_ACT_VALUES,
  PASSAGE_CONFIDENCE_VALUES,
  VERIFICATION_STATUS_VALUES,
  SOURCE_KIND_VALUES,
} = require('../../shared/constants');

const SCHEMA_VERSION = 7;

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
    this._migrateReportsColumns();
    this._ensureSearchIndex();
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
        questions_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'DRAFT',
        current_revision_id TEXT,
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

      -- Append-only report revisions. The working report row in reports holds
      -- the current draft; each save appends an immutable snapshot here so a
      -- FINAL revision can never be silently overwritten. A report revision also
      -- records the transcript revisions it cites, so an exported report is
      -- traceable to the exact transcript snapshots behind it.
      CREATE TABLE IF NOT EXISTS report_revisions (
        revision_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        template TEXT,
        title TEXT,
        sections_json TEXT NOT NULL DEFAULT '[]',
        questions_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_report_revisions_case ON report_revisions(case_id, created_at);

      -- Structured findings: an observation the operator records with an
      -- explicit source (material, revision, timestamp). A finding can be
      -- promoted into the report, keeping the source link intact. A finding is
      -- the expert's own note, never an automated conclusion.
      CREATE TABLE IF NOT EXISTS findings (
        finding_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        observation TEXT NOT NULL DEFAULT '',
        evidence_id TEXT,
        revision_id TEXT,
        at_seconds REAL,
        speaker TEXT,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_findings_case ON findings(case_id, created_at);

      -- Expert analysis layer (schema 7, additive). A passage is anchored to a
      -- transcript revision (never raw ASR) and always carries a context window,
      -- so an isolated quote cannot be recorded without its surroundings.
      CREATE TABLE IF NOT EXISTS passages (
        passage_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL,
        transcript_id TEXT,
        revision_id TEXT,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        context_before_seconds REAL NOT NULL DEFAULT 30,
        context_after_seconds REAL NOT NULL DEFAULT 30,
        text TEXT NOT NULL DEFAULT '',
        speech_act TEXT NOT NULL DEFAULT 'LITERAL',
        confidence TEXT NOT NULL DEFAULT 'MEDIUM',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_passages_case ON passages(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_passages_evidence ON passages(evidence_id, start_seconds);

      -- A claim separates what was said (as_stated) from the meaning that is
      -- alleged (alleged_meaning). The two are never merged into one field.
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        passage_id TEXT,
        as_stated TEXT NOT NULL DEFAULT '',
        alleged_meaning TEXT NOT NULL DEFAULT '',
        asserted_by TEXT NOT NULL DEFAULT '',
        verification TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claims_case ON claims(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_claims_passage ON claims(passage_id);

      -- External sources used to verify a claim or passage. Never a conclusion;
      -- only a reference the expert can weigh.
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        claim_id TEXT,
        passage_id TEXT,
        kind TEXT NOT NULL DEFAULT 'SECONDARY',
        title TEXT NOT NULL DEFAULT '',
        citation TEXT NOT NULL DEFAULT '',
        supports TEXT NOT NULL DEFAULT '',
        verification TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_case ON sources(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sources_claim ON sources(claim_id);

      -- A reality-claim verification record: "this was asserted, and here is
      -- whether it could be checked". The status is always explicit.
      CREATE TABLE IF NOT EXISTS verifications (
        verification_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        claim_id TEXT,
        passage_id TEXT,
        claim_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PENDING',
        evidence_ref TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verifications_case ON verifications(case_id, created_at);
    `);

    this._migrateSegmentsOriginalText();
    this._migrateSegmentsCompositeKey();
    this._migrateSegmentsFlags();
    this._migrateEvidenceAudioStreamCount();
    this._migrateCaseAssignment();
    this._ensureSearchIndex();
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
   * Schema migration: add the structured-report columns (questions, sources,
   * state, current revision) to databases created before the report workspace
   * existed. Existing reports keep their sections and read as a DRAFT with no
   * revision yet; the next save appends the first revision.
   */
  _migrateReportsColumns() {
    const columns = this.db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
    if (!columns.length) return;
    const wanted = [
      ['questions_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['sources_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['state', "TEXT NOT NULL DEFAULT 'DRAFT'"],
      ['current_revision_id', 'TEXT'],
    ];
    const missing = wanted.filter(([name]) => !columns.includes(name));
    if (!missing.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, type] of missing) {
        this.db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Create the FTS5 search index when the bundled SQLite supports it. The index
   * is optional: if FTS5 is missing, `this.ftsAvailable` stays false and the
   * search path falls back to an indexed LIKE query, so search still works (just
   * without ranked full-text matching). The feature is never allowed to break
   * database creation.
   */
  _ensureSearchIndex() {
    this.ftsAvailable = false;
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        kind UNINDEXED,
        ref_id UNINDEXED,
        case_id UNINDEXED,
        evidence_id UNINDEXED,
        transcript_id UNINDEXED,
        start_seconds UNINDEXED,
        speaker,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );`);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  /** Drop and rebuild the FTS index for one case from the source tables. */
  rebuildSearchIndex(caseId) {
    if (!this.ftsAvailable) return false;
    const evidence = this.listEvidence(caseId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM search_fts WHERE case_id = ?').run(caseId);
      const insert = this.db.prepare(
        `INSERT INTO search_fts(kind, ref_id, case_id, evidence_id, transcript_id, start_seconds, speaker, body)
         VALUES(?,?,?,?,?,?,?,?)`
      );
      for (const ev of evidence) {
        insert.run('evidence', ev.evidence_id, caseId, ev.evidence_id, null, null, '', ev.original_name || '');
        const t = this.getTranscript(caseId, ev.evidence_id);
        if (!t) continue;
        for (const s of this.getSegments(t.transcript_id)) {
          insert.run('segment', s.segment_id, caseId, ev.evidence_id, t.transcript_id, s.start, s.speaker || '', s.text || '');
        }
      }
      for (const n of this.listNotes(caseId)) {
        insert.run(n.kind === 'BOOKMARK' ? 'bookmark' : 'note', n.note_id, caseId, n.evidence_id || null, null, n.at_seconds, '', n.body || '');
      }
      for (const f of this.listFindings(caseId)) {
        insert.run('finding', f.finding_id, caseId, f.evidence_id || null, null, f.at_seconds, f.speaker || '', `${f.title || ''} ${f.description || ''} ${f.observation || ''}`.trim());
      }
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      return false;
    }
  }

  /** Upsert one non-segment document (evidence name, note, bookmark, finding). */
  _indexDoc({ kind, refId, caseId, evidenceId = null, transcriptId = null, start = null, speaker = '', body = '' }) {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
      this.db
        .prepare(
          `INSERT INTO search_fts(kind, ref_id, case_id, evidence_id, transcript_id, start_seconds, speaker, body)
           VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(kind, refId, caseId, evidenceId, transcriptId, start, speaker || '', body || '');
    } catch {
      /* best-effort */
    }
  }

  _unindex(kind, refId) {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
    } catch {
      /* best-effort */
    }
  }

  /** Refresh a single segment's FTS row (kept in sync on transcript save). */
  _indexSegment({ caseId, evidenceId, transcriptId, segment }) {
    if (!this.ftsAvailable) return;
    try {
      this.db
        .prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?')
        .run('segment', segment.segment_id);
      this.db
        .prepare(
          `INSERT INTO search_fts(kind, ref_id, case_id, evidence_id, transcript_id, start_seconds, speaker, body)
           VALUES(?,?,?,?,?,?,?,?)`
        )
        .run('segment', segment.segment_id, caseId, evidenceId, transcriptId, segment.start, segment.speaker || '', segment.text || '');
    } catch {
      /* index is best-effort; search falls back to LIKE */
    }
  }

  /** Replace a whole transcript's FTS rows (used when a transcript is rewritten). */
  _reindexTranscript(caseId, evidenceId, transcriptId) {
    if (!this.ftsAvailable) return;
    try {
      this.db.prepare('DELETE FROM search_fts WHERE transcript_id = ?').run(transcriptId);
      for (const s of this.getSegments(transcriptId)) {
        this._indexSegment({ caseId, evidenceId, transcriptId, segment: s });
      }
    } catch {
      /* best-effort */
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

  /**
   * Restore one archived history row. The action and its original timestamp are
   * preserved verbatim; the caller has already remapped target/detail ids so the
   * log stays truthful about which new entities it refers to.
   */
  restoreHistory(caseId, entry, { target = null, detail = null } = {}) {
    const ts = entry.created_at || nowIso();
    this.db
      .prepare('INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)')
      .run(caseId, String(entry.action), target, detail ? JSON.stringify(detail) : null, ts);
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
    // Every count is computed by SQL aggregate over the case's own rows, so the
    // dashboard is O(1) in renderer memory and stays fast for a case with 100+
    // media files and tens of thousands of segments. No segment objects are
    // loaded here.
    const one = (sql, ...args) => Number(this.db.prepare(sql).get(...args).n);

    const evidence = one('SELECT COUNT(*) AS n FROM evidence WHERE case_id = ?', caseId);
    const transcribed = one(
      `SELECT COUNT(*) AS n FROM transcripts WHERE case_id = ?`,
      caseId
    );
    const segments = one(
      `SELECT COUNT(*) AS n FROM segments s JOIN transcripts t ON t.transcript_id = s.transcript_id WHERE t.case_id = ?`,
      caseId
    );
    const unclear = one(
      `SELECT COUNT(*) AS n FROM segments s JOIN transcripts t ON t.transcript_id = s.transcript_id
        WHERE t.case_id = ? AND s.status = ? AND s.text = ?`,
      caseId,
      SEGMENT_STATUS.AUTOMATIC,
      UNCLEAR_PLACEHOLDER
    );
    // A transcript counts as fully verified when it has at least one segment and
    // none of its segments is below VERIFIED.
    const verified = one(
      `SELECT COUNT(*) AS n FROM (
         SELECT s.transcript_id, COUNT(*) AS total,
                SUM(CASE WHEN s.status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified_count
           FROM segments s JOIN transcripts t ON t.transcript_id = s.transcript_id
          WHERE t.case_id = ?
          GROUP BY s.transcript_id
       ) WHERE total > 0 AND verified_count = total`,
      caseId
    );
    const reviewed = one(
      `SELECT COUNT(*) AS n FROM (
         SELECT s.transcript_id, COUNT(*) AS total,
                SUM(CASE WHEN s.status IN ('REVIEWED','EDITED','VERIFIED') THEN 1 ELSE 0 END) AS human_count,
                SUM(CASE WHEN s.status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified_count
           FROM segments s JOIN transcripts t ON t.transcript_id = s.transcript_id
          WHERE t.case_id = ?
          GROUP BY s.transcript_id
       ) WHERE human_count > 0 AND NOT (total > 0 AND verified_count = total)`,
      caseId
    );

    const failedRuns = one(
      `SELECT COUNT(*) AS n FROM transcription_runs WHERE case_id = ? AND status = 'FAILED'`,
      caseId
    );
    const missingAssignment = CASE_ASSIGNMENT_FIELDS.filter((f) => !String(kase[f] || '').trim()).length;
    const report = this.getReport(caseId);
    const reportHasContent = Boolean(
      report && (String(report.title || '').trim() || (Array.isArray(report.sections) && report.sections.some((s) => String((s && s.body) || '').trim())))
    );
    return {
      case_id: caseId,
      title: kase.title,
      due_date: kase.due_date || null,
      updated_at: kase.updated_at,
      evidence,
      transcribed,
      reviewed,
      verified,
      pending: evidence - transcribed,
      segments,
      unclear_segments: unclear,
      failed_runs: failedRuns,
      notes: one('SELECT COUNT(*) AS n FROM notes WHERE case_id = ?', caseId),
      findings: one('SELECT COUNT(*) AS n FROM findings WHERE case_id = ?', caseId),
      revisions: one(
        `SELECT COUNT(*) AS n FROM transcript_revisions r
           JOIN transcripts t ON t.transcript_id = r.transcript_id WHERE t.case_id = ?`,
        caseId
      ),
      report_revisions: one('SELECT COUNT(*) AS n FROM report_revisions WHERE case_id = ?', caseId),
      deliveries: one(
        `SELECT COUNT(*) AS n FROM history WHERE case_id = ? AND action IN ('DELIVERY_PACKAGE','DELIVERY_CREATED')`,
        caseId
      ),
      has_report: reportHasContent,
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
    this._indexDoc({ kind: 'evidence', refId: evidenceId, caseId, evidenceId, body: originalName });
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
    this._unindex('evidence', evidenceId);
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

  _describeSegment(r) {
    return {
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
    };
  }

  getSegments(transcriptId) {
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE transcript_id = ? ORDER BY ordinal ASC')
      .all(transcriptId);
    return rows.map((r) => this._describeSegment(r));
  }

  /**
   * Total number of segments in a transcript, computed by SQL COUNT so the
   * renderer can size a virtualised list without loading every segment.
   */
  countSegments(transcriptId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM segments WHERE transcript_id = ?').get(transcriptId).n);
  }

  /**
   * Return one window of a transcript for virtualised rendering. The window is
   * fetched by ordinal range so only the visible rows (plus a small buffer) ever
   * leave the database, and scrolling a 10k-segment transcript stays cheap.
   *
   * @param {string} transcriptId
   * @param {{offset?:number, limit?:number}} opts
   * @returns {{total:number, offset:number, limit:number, segments:Array}}
   */
  getSegmentPage(transcriptId, { offset = 0, limit = 200 } = {}) {
    const total = this.countSegments(transcriptId);
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const off = Math.max(0, Math.min(total, Number(offset) || 0));
    const rows = this.db
      .prepare('SELECT * FROM segments WHERE transcript_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?')
      .all(transcriptId, lim, off);
    return { total, offset: off, limit: lim, segments: rows.map((r) => this._describeSegment(r)) };
  }

  /**
   * Return the single segment that contains a given timestamp (the last segment
   * whose start is <= t). Used to locate the transcript from a waveform click
   * without loading the whole transcript.
   */
  getSegmentAt(transcriptId, atSeconds) {
    const t = Number(atSeconds) || 0;
    const row = this.db
      .prepare('SELECT * FROM segments WHERE transcript_id = ? AND start_seconds <= ? ORDER BY start_seconds DESC LIMIT 1')
      .get(transcriptId, t);
    return row ? this._describeSegment(row) : null;
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
    // Keep the full-text index aligned with what is now the visible text.
    if (makeCurrent) this._reindexTranscript(caseId, evidenceId, transcriptId);
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
    const revisionIdMap = new Map();
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
        if (rev.revision_id) revisionIdMap.set(rev.revision_id, row.revision_id);
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
      revisionIdMap,
    };
  }

  /** Point a restored run at its restored transcript (provenance link). */
  linkRunTranscript(runId, transcriptId) {
    this.db.prepare('UPDATE transcription_runs SET transcript_id = ? WHERE run_id = ?').run(transcriptId, runId);
  }

  /**
   * Restore a note/bookmark row preserving its original timestamp. Used by
   * case-archive restore so operator notes survive a round-trip. The evidence
   * id is remapped by the caller (archive evidence id -> new evidence id).
   */
  restoreNote(caseId, note, { evidenceId = null } = {}) {
    const noteId = makeId('NOTE');
    const ts = note.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO notes(note_id, case_id, evidence_id, at_seconds, kind, category, body, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        noteId,
        caseId,
        evidenceId,
        note.at_seconds === null || note.at_seconds === undefined ? null : Number(note.at_seconds),
        String(note.kind || 'NOTE'),
        note.category === null || note.category === undefined ? null : String(note.category),
        String(note.body || ''),
        ts,
        note.updated_at || ts
      );
    this._indexDoc({
      kind: String(note.kind || 'NOTE') === 'BOOKMARK' ? 'bookmark' : 'note',
      refId: noteId,
      caseId,
      evidenceId: evidenceId || null,
      start: note.at_seconds === null || note.at_seconds === undefined ? null : Number(note.at_seconds),
      body: String(note.body || ''),
    });
    return noteId;
  }

  /** Restore a finding row, remapping its evidence link. */
  restoreFinding(caseId, finding, { evidenceId = null, revisionId = null } = {}) {
    const findingId = makeId('FINDING');
    const ts = finding.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO findings(finding_id, case_id, title, description, observation, evidence_id, revision_id, at_seconds, speaker, body, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        findingId,
        caseId,
        String(finding.title || ''),
        String(finding.description || ''),
        String(finding.observation || ''),
        evidenceId || null,
        revisionId || null,
        finding.at_seconds === null || finding.at_seconds === undefined ? null : Number(finding.at_seconds),
        finding.speaker === null || finding.speaker === undefined ? null : String(finding.speaker),
        String(finding.body || ''),
        ts,
        finding.updated_at || ts
      );
    this._indexFinding(findingId);
    return findingId;
  }

  /**
   * Restore the analysis layer from an archive. Ids are regenerated and the
   * caller supplies the evidence/revision remaps; a passage keeps the exact
   * revision it was taken from, and claims/sources/verifications keep their
   * links. Returns the old->new maps so later rows (and history) can be remapped.
   */
  restorePassage(caseId, passage, { evidenceId = null, revisionId = null } = {}) {
    const passageId = makeId('PSG');
    const ts = passage.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO passages(passage_id, case_id, evidence_id, transcript_id, revision_id, start_seconds, end_seconds, context_before_seconds, context_after_seconds, text, speech_act, confidence, note, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        passageId, caseId, evidenceId,
        passage.transcript_id || null, revisionId || null,
        Number(passage.start_seconds) || 0, Number(passage.end_seconds) || 0,
        Number(passage.context_before_seconds) || 30, Number(passage.context_after_seconds) || 30,
        String(passage.text || ''),
        passage.speech_act || 'LITERAL', passage.confidence || 'MEDIUM',
        String(passage.note || ''), ts, passage.updated_at || ts
      );
    return passageId;
  }

  restoreClaim(caseId, claim, { passageId = null } = {}) {
    const claimId = makeId('CLAIM');
    const ts = claim.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO claims(claim_id, case_id, passage_id, as_stated, alleged_meaning, asserted_by, verification, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        claimId, caseId, passageId,
        String(claim.as_stated || ''), String(claim.alleged_meaning || ''),
        String(claim.asserted_by || ''), claim.verification || 'PENDING', ts, claim.updated_at || ts
      );
    return claimId;
  }

  restoreSource(caseId, source, { claimId = null, passageId = null } = {}) {
    const sourceId = makeId('SRC');
    const ts = source.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO sources(source_id, case_id, claim_id, passage_id, kind, title, citation, supports, verification, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        sourceId, caseId, claimId, passageId,
        source.kind || 'SECONDARY', String(source.title || ''), String(source.citation || ''),
        String(source.supports || ''), source.verification || 'PENDING', ts, source.updated_at || ts
      );
    return sourceId;
  }

  restoreVerification(caseId, verification, { claimId = null, passageId = null } = {}) {
    const verificationId = makeId('VER');
    const ts = verification.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO verifications(verification_id, case_id, claim_id, passage_id, claim_text, status, evidence_ref, note, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        verificationId, caseId, claimId, passageId,
        String(verification.claim_text || ''), verification.status || 'PENDING',
        String(verification.evidence_ref || ''), String(verification.note || ''), ts, verification.updated_at || ts
      );
    return verificationId;
  }

  /**
   * Restore the report working row and its append-only revisions, preserving
   * states, ordering and the current marker. Revision ids are regenerated; the
   * caller does not need a mapping because report revisions are not referenced
   * by other rows.
   */
  restoreReport(caseId, report, revisions = []) {
    if (!report && !revisions.length) return null;
    const ordered = [...revisions].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const ts = (report && (report.created_at || report.updated_at)) || nowIso();
    const idByOld = new Map();
    let currentNewId = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const rev of ordered) {
        const newId = makeId('RREV');
        if (rev.revision_id) idByOld.set(rev.revision_id, newId);
        if (rev.is_current) currentNewId = newId;
        this.db
          .prepare(
            `INSERT INTO report_revisions(revision_id, case_id, state, is_current, template, title, sections_json, questions_json, sources_json, created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            newId,
            caseId,
            String(rev.state || REPORT_REVISION_STATE.DRAFT),
            rev.is_current ? 1 : 0,
            rev.template ?? null,
            rev.title ?? null,
            JSON.stringify(rev.sections || []),
            JSON.stringify(rev.questions || []),
            JSON.stringify(rev.sources || []),
            rev.created_at || ts
          );
      }
      if (report) {
        if (!currentNewId && idByOld.has(report.current_revision_id)) {
          currentNewId = idByOld.get(report.current_revision_id);
        }
        if (currentNewId) {
          this.db.prepare('UPDATE report_revisions SET is_current = 0 WHERE case_id = ?').run(caseId);
          this.db.prepare('UPDATE report_revisions SET is_current = 1 WHERE revision_id = ?').run(currentNewId);
        }
        this.db
          .prepare(
            `INSERT INTO reports(case_id, template, title, sections_json, questions_json, sources_json, state, current_revision_id, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(case_id) DO UPDATE SET template = excluded.template, title = excluded.title,
               sections_json = excluded.sections_json, questions_json = excluded.questions_json,
               sources_json = excluded.sources_json, state = excluded.state,
               current_revision_id = excluded.current_revision_id, updated_at = excluded.updated_at`
          )
          .run(
            caseId,
            String(report.template || 'generic'),
            String(report.title || ''),
            JSON.stringify(report.sections || []),
            JSON.stringify(report.questions || []),
            JSON.stringify(report.sources || []),
            String(report.state || REPORT_REVISION_STATE.DRAFT),
            currentNewId,
            report.created_at || ts,
            report.updated_at || ts
          );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getReport(caseId);
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
    this._indexDoc({
      kind: String(kind || 'NOTE') === 'BOOKMARK' ? 'bookmark' : 'note',
      refId: noteId,
      caseId,
      evidenceId: evidenceId || null,
      start: Number.isFinite(at) ? at : null,
      body: String(body || ''),
    });
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
    const updated = this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId);
    this._indexDoc({
      kind: updated.kind === 'BOOKMARK' ? 'bookmark' : 'note',
      refId: noteId,
      caseId: updated.case_id,
      evidenceId: updated.evidence_id || null,
      start: updated.at_seconds === null ? null : Number(updated.at_seconds),
      body: updated.body || '',
    });
    return this._describeNote(updated);
  }

  deleteNote(noteId) {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId);
    if (!row) return false;
    this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(noteId);
    this._unindex('note', noteId);
    this._unindex('bookmark', noteId);
    this.recordHistory(row.case_id, 'NOTE_DELETED', row.evidence_id, { noteId });
    return true;
  }

  listNotes(caseId, { evidenceId = null } = {}) {
    const rows = evidenceId
      ? this.db.prepare('SELECT * FROM notes WHERE case_id = ? AND evidence_id = ? ORDER BY at_seconds ASC, created_at ASC').all(caseId, evidenceId)
      : this.db.prepare('SELECT * FROM notes WHERE case_id = ? ORDER BY created_at ASC').all(caseId);
    return rows.map((r) => this._describeNote(r));
  }

  // ---------------------------------------------------------------- findings
  _describeFinding(row) {
    return {
      finding_id: row.finding_id,
      case_id: row.case_id,
      title: row.title,
      description: row.description,
      observation: row.observation,
      evidence_id: row.evidence_id || null,
      revision_id: row.revision_id || null,
      at_seconds: row.at_seconds === null ? null : Number(row.at_seconds),
      speaker: row.speaker || null,
      body: row.body,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  createFinding(caseId, { title = '', description = '', observation = '', evidenceId = null, revisionId = null, atSeconds = null, speaker = null, body = '' } = {}) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    if (evidenceId && (!this.getEvidence(evidenceId) || this.getEvidence(evidenceId).case_id !== caseId)) {
      const err = new Error('Evidence does not belong to this case.');
      err.code = 'EVIDENCE_MISMATCH';
      throw err;
    }
    const findingId = makeId('FINDING');
    const ts = nowIso();
    const at = atSeconds === null || atSeconds === undefined ? null : Number(atSeconds);
    this.db
      .prepare(
        `INSERT INTO findings(finding_id, case_id, title, description, observation, evidence_id, revision_id, at_seconds, speaker, body, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        findingId,
        caseId,
        String(title || ''),
        String(description || ''),
        String(observation || ''),
        evidenceId || null,
        revisionId || null,
        Number.isFinite(at) ? at : null,
        speaker === null || speaker === undefined ? null : String(speaker),
        String(body || ''),
        ts,
        ts
      );
    this.recordHistory(caseId, 'FINDING_CREATED', evidenceId || caseId, { findingId, revisionId: revisionId || null, atSeconds: Number.isFinite(at) ? at : null });
    this._touchCase(caseId);
    this._indexFinding(findingId);
    return this._describeFinding(this.db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId));
  }

  _indexFinding(findingId) {
    const row = this.db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId);
    if (!row) return;
    this._indexDoc({
      kind: 'finding',
      refId: findingId,
      caseId: row.case_id,
      evidenceId: row.evidence_id || null,
      start: row.at_seconds === null ? null : Number(row.at_seconds),
      speaker: row.speaker || '',
      body: `${row.title || ''} ${row.description || ''} ${row.observation || ''}`.trim(),
    });
  }

  updateFinding(findingId, patch = {}) {
    const row = this.db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId);
    if (!row) {
      const err = new Error('Finding not found.');
      err.code = 'FINDING_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    for (const [field, col] of [['title', 'title'], ['description', 'description'], ['observation', 'observation'], ['body', 'body'], ['speaker', 'speaker']]) {
      if (patch[field] !== undefined) {
        sets.push(`${col} = ?`);
        values.push(patch[field] === null ? null : String(patch[field]));
      }
    }
    if (patch.atSeconds !== undefined) {
      sets.push('at_seconds = ?');
      values.push(patch.atSeconds === null ? null : Number(patch.atSeconds));
    }
    if (patch.evidenceId !== undefined) {
      sets.push('evidence_id = ?');
      values.push(patch.evidenceId === null ? null : String(patch.evidenceId));
    }
    if (patch.revisionId !== undefined) {
      sets.push('revision_id = ?');
      values.push(patch.revisionId === null ? null : String(patch.revisionId));
    }
    values.push(findingId);
    this.db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE finding_id = ?`).run(...values);
    this._indexFinding(findingId);
    return this._describeFinding(this.db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId));
  }

  deleteFinding(findingId) {
    const row = this.db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId);
    if (!row) return false;
    this.db.prepare('DELETE FROM findings WHERE finding_id = ?').run(findingId);
    this._unindex('finding', findingId);
    this.recordHistory(row.case_id, 'FINDING_DELETED', row.evidence_id || row.case_id, { findingId });
    return true;
  }

  listFindings(caseId) {
    const rows = this.db.prepare('SELECT * FROM findings WHERE case_id = ? ORDER BY created_at ASC').all(caseId);
    return rows.map((r) => this._describeFinding(r));
  }

  // -------------------------------------------------------- analysis layer
  _requireCase(caseId) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    return kase;
  }

  _describePassage(row) {
    if (!row) return null;
    return {
      passage_id: row.passage_id,
      case_id: row.case_id,
      evidence_id: row.evidence_id,
      transcript_id: row.transcript_id || null,
      revision_id: row.revision_id || null,
      start_seconds: Number(row.start_seconds),
      end_seconds: Number(row.end_seconds),
      context_before_seconds: Number(row.context_before_seconds),
      context_after_seconds: Number(row.context_after_seconds),
      text: row.text || '',
      speech_act: row.speech_act,
      confidence: row.confidence,
      note: row.note || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _describeClaim(row) {
    if (!row) return null;
    return {
      claim_id: row.claim_id,
      case_id: row.case_id,
      passage_id: row.passage_id || null,
      as_stated: row.as_stated || '',
      alleged_meaning: row.alleged_meaning || '',
      asserted_by: row.asserted_by || '',
      verification: row.verification,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _describeSource(row) {
    if (!row) return null;
    return {
      source_id: row.source_id,
      case_id: row.case_id,
      claim_id: row.claim_id || null,
      passage_id: row.passage_id || null,
      kind: row.kind,
      title: row.title || '',
      citation: row.citation || '',
      supports: row.supports || '',
      verification: row.verification,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _describeVerification(row) {
    if (!row) return null;
    return {
      verification_id: row.verification_id,
      case_id: row.case_id,
      claim_id: row.claim_id || null,
      passage_id: row.passage_id || null,
      claim_text: row.claim_text || '',
      status: row.status,
      evidence_ref: row.evidence_ref || '',
      note: row.note || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  _assertEnum(value, allowed, field, fallback) {
    const v = value === undefined || value === null || value === '' ? fallback : String(value).toUpperCase();
    if (!allowed.includes(v)) {
      const err = new Error(`Invalid ${field}: ${value}`);
      err.code = 'INVALID_INPUT';
      err.field = field;
      throw err;
    }
    return v;
  }

  /** Evidence must belong to the case; a cross-case link is refused, not stored. */
  _assertEvidenceInCase(caseId, evidenceId) {
    if (!evidenceId) return null;
    const ev = this.getEvidence(evidenceId);
    if (!ev || ev.case_id !== caseId) {
      const err = new Error('Evidence does not belong to this case.');
      err.code = 'EVIDENCE_MISMATCH';
      throw err;
    }
    return evidenceId;
  }

  createPassage(caseId, input = {}) {
    this._requireCase(caseId);
    const evidenceId = this._assertEvidenceInCase(caseId, input.evidenceId);
    if (!evidenceId) {
      const err = new Error('A passage requires evidence.');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    const start = Number(input.startSeconds);
    const end = Number(input.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      const err = new Error('A passage requires a valid time range.');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    // Context is mandatory: a passage without surrounding audio is not recorded.
    const before = input.contextBeforeSeconds === undefined || input.contextBeforeSeconds === null
      ? 30
      : Number(input.contextBeforeSeconds);
    const after = input.contextAfterSeconds === undefined || input.contextAfterSeconds === null
      ? 30
      : Number(input.contextAfterSeconds);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0 || after <= 0) {
      const err = new Error('A passage requires a positive context window.');
      err.code = 'CONTEXT_REQUIRED';
      throw err;
    }
    const speechAct = this._assertEnum(input.speechAct, SPEECH_ACT_VALUES, 'speech_act', 'LITERAL');
    const confidence = this._assertEnum(input.confidence, PASSAGE_CONFIDENCE_VALUES, 'confidence', 'MEDIUM');
    const passageId = makeId('PSG');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO passages(passage_id, case_id, evidence_id, transcript_id, revision_id, start_seconds, end_seconds, context_before_seconds, context_after_seconds, text, speech_act, confidence, note, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        passageId, caseId, evidenceId,
        input.transcriptId || null, input.revisionId || null,
        start, end, before, after,
        String(input.text || ''), speechAct, confidence, String(input.note || ''), ts, ts
      );
    this.recordHistory(caseId, 'PASSAGE_CREATED', evidenceId, { passageId, revisionId: input.revisionId || null });
    this._touchCase(caseId);
    return this._describePassage(this.db.prepare('SELECT * FROM passages WHERE passage_id = ?').get(passageId));
  }

  updatePassage(passageId, patch = {}) {
    const row = this.db.prepare('SELECT * FROM passages WHERE passage_id = ?').get(passageId);
    if (!row) {
      const err = new Error('Passage not found.');
      err.code = 'PASSAGE_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    for (const field of ['text', 'note']) {
      if (patch[field] !== undefined) { sets.push(`${field} = ?`); values.push(String(patch[field])); }
    }
    if (patch.speechAct !== undefined) {
      sets.push('speech_act = ?');
      values.push(this._assertEnum(patch.speechAct, SPEECH_ACT_VALUES, 'speech_act', row.speech_act));
    }
    if (patch.confidence !== undefined) {
      sets.push('confidence = ?');
      values.push(this._assertEnum(patch.confidence, PASSAGE_CONFIDENCE_VALUES, 'confidence', row.confidence));
    }
    if (patch.startSeconds !== undefined || patch.endSeconds !== undefined) {
      const start = patch.startSeconds !== undefined ? Number(patch.startSeconds) : Number(row.start_seconds);
      const end = patch.endSeconds !== undefined ? Number(patch.endSeconds) : Number(row.end_seconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        const err = new Error('A passage requires a valid time range.');
        err.code = 'INVALID_INPUT';
        throw err;
      }
      sets.push('start_seconds = ?', 'end_seconds = ?');
      values.push(start, end);
    }
    values.push(passageId);
    this.db.prepare(`UPDATE passages SET ${sets.join(', ')} WHERE passage_id = ?`).run(...values);
    return this._describePassage(this.db.prepare('SELECT * FROM passages WHERE passage_id = ?').get(passageId));
  }

  deletePassage(passageId) {
    const row = this.db.prepare('SELECT * FROM passages WHERE passage_id = ?').get(passageId);
    if (!row) return false;
    this.db.prepare('DELETE FROM passages WHERE passage_id = ?').run(passageId);
    this.db.prepare('UPDATE claims SET passage_id = NULL WHERE passage_id = ?').run(passageId);
    this.db.prepare('UPDATE sources SET passage_id = NULL WHERE passage_id = ?').run(passageId);
    this.db.prepare('UPDATE verifications SET passage_id = NULL WHERE passage_id = ?').run(passageId);
    this.recordHistory(row.case_id, 'PASSAGE_DELETED', row.evidence_id, { passageId });
    return true;
  }

  listPassages(caseId) {
    return this.db
      .prepare('SELECT * FROM passages WHERE case_id = ? ORDER BY start_seconds ASC')
      .all(caseId)
      .map((r) => this._describePassage(r));
  }

  createClaim(caseId, input = {}) {
    this._requireCase(caseId);
    const claimId = makeId('CLAIM');
    const ts = nowIso();
    const verification = this._assertEnum(input.verification, VERIFICATION_STATUS_VALUES, 'verification', 'PENDING');
    this.db
      .prepare(
        `INSERT INTO claims(claim_id, case_id, passage_id, as_stated, alleged_meaning, asserted_by, verification, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        claimId, caseId, input.passageId || null,
        String(input.asStated || ''), String(input.allegedMeaning || ''),
        String(input.assertedBy || ''), verification, ts, ts
      );
    this.recordHistory(caseId, 'CLAIM_CREATED', input.passageId || caseId, { claimId });
    this._touchCase(caseId);
    return this._describeClaim(this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId));
  }

  updateClaim(claimId, patch = {}) {
    const row = this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId);
    if (!row) {
      const err = new Error('Claim not found.');
      err.code = 'CLAIM_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    for (const [field, col] of [['asStated', 'as_stated'], ['allegedMeaning', 'alleged_meaning'], ['assertedBy', 'asserted_by']]) {
      if (patch[field] !== undefined) { sets.push(`${col} = ?`); values.push(String(patch[field])); }
    }
    if (patch.passageId !== undefined) { sets.push('passage_id = ?'); values.push(patch.passageId || null); }
    if (patch.verification !== undefined) {
      sets.push('verification = ?');
      values.push(this._assertEnum(patch.verification, VERIFICATION_STATUS_VALUES, 'verification', row.verification));
    }
    values.push(claimId);
    this.db.prepare(`UPDATE claims SET ${sets.join(', ')} WHERE claim_id = ?`).run(...values);
    return this._describeClaim(this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId));
  }

  deleteClaim(claimId) {
    const row = this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId);
    if (!row) return false;
    this.db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId);
    this.db.prepare('UPDATE sources SET claim_id = NULL WHERE claim_id = ?').run(claimId);
    this.db.prepare('UPDATE verifications SET claim_id = NULL WHERE claim_id = ?').run(claimId);
    this.recordHistory(row.case_id, 'CLAIM_DELETED', row.passage_id || row.case_id, { claimId });
    return true;
  }

  listClaims(caseId) {
    return this.db
      .prepare('SELECT * FROM claims WHERE case_id = ? ORDER BY created_at ASC')
      .all(caseId)
      .map((r) => this._describeClaim(r));
  }

  createSource(caseId, input = {}) {
    this._requireCase(caseId);
    const sourceId = makeId('SRC');
    const ts = nowIso();
    const kind = this._assertEnum(input.kind, SOURCE_KIND_VALUES, 'kind', 'SECONDARY');
    const verification = this._assertEnum(input.verification, VERIFICATION_STATUS_VALUES, 'verification', 'PENDING');
    this.db
      .prepare(
        `INSERT INTO sources(source_id, case_id, claim_id, passage_id, kind, title, citation, supports, verification, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        sourceId, caseId, input.claimId || null, input.passageId || null,
        kind, String(input.title || ''), String(input.citation || ''),
        String(input.supports || ''), verification, ts, ts
      );
    this.recordHistory(caseId, 'SOURCE_CREATED', input.claimId || caseId, { sourceId, kind });
    this._touchCase(caseId);
    return this._describeSource(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId));
  }

  updateSource(sourceId, patch = {}) {
    const row = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId);
    if (!row) {
      const err = new Error('Source not found.');
      err.code = 'SOURCE_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    for (const [field, col] of [['title', 'title'], ['citation', 'citation'], ['supports', 'supports']]) {
      if (patch[field] !== undefined) { sets.push(`${col} = ?`); values.push(String(patch[field])); }
    }
    if (patch.kind !== undefined) {
      sets.push('kind = ?');
      values.push(this._assertEnum(patch.kind, SOURCE_KIND_VALUES, 'kind', row.kind));
    }
    if (patch.verification !== undefined) {
      sets.push('verification = ?');
      values.push(this._assertEnum(patch.verification, VERIFICATION_STATUS_VALUES, 'verification', row.verification));
    }
    if (patch.claimId !== undefined) { sets.push('claim_id = ?'); values.push(patch.claimId || null); }
    if (patch.passageId !== undefined) { sets.push('passage_id = ?'); values.push(patch.passageId || null); }
    values.push(sourceId);
    this.db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE source_id = ?`).run(...values);
    return this._describeSource(this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId));
  }

  deleteSource(sourceId) {
    const row = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId);
    if (!row) return false;
    this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId);
    this.recordHistory(row.case_id, 'SOURCE_DELETED', row.claim_id || row.case_id, { sourceId });
    return true;
  }

  listSources(caseId) {
    return this.db
      .prepare('SELECT * FROM sources WHERE case_id = ? ORDER BY created_at ASC')
      .all(caseId)
      .map((r) => this._describeSource(r));
  }

  createVerification(caseId, input = {}) {
    this._requireCase(caseId);
    const verificationId = makeId('VER');
    const ts = nowIso();
    const status = this._assertEnum(input.status, VERIFICATION_STATUS_VALUES, 'status', 'PENDING');
    this.db
      .prepare(
        `INSERT INTO verifications(verification_id, case_id, claim_id, passage_id, claim_text, status, evidence_ref, note, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        verificationId, caseId, input.claimId || null, input.passageId || null,
        String(input.claimText || ''), status, String(input.evidenceRef || ''), String(input.note || ''), ts, ts
      );
    this.recordHistory(caseId, 'VERIFICATION_RECORDED', input.claimId || caseId, { verificationId, status });
    this._touchCase(caseId);
    return this._describeVerification(this.db.prepare('SELECT * FROM verifications WHERE verification_id = ?').get(verificationId));
  }

  updateVerification(verificationId, patch = {}) {
    const row = this.db.prepare('SELECT * FROM verifications WHERE verification_id = ?').get(verificationId);
    if (!row) {
      const err = new Error('Verification not found.');
      err.code = 'VERIFICATION_NOT_FOUND';
      throw err;
    }
    const sets = ['updated_at = ?'];
    const values = [nowIso()];
    for (const [field, col] of [['claimText', 'claim_text'], ['evidenceRef', 'evidence_ref'], ['note', 'note']]) {
      if (patch[field] !== undefined) { sets.push(`${col} = ?`); values.push(String(patch[field])); }
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(this._assertEnum(patch.status, VERIFICATION_STATUS_VALUES, 'status', row.status));
    }
    if (patch.claimId !== undefined) { sets.push('claim_id = ?'); values.push(patch.claimId || null); }
    if (patch.passageId !== undefined) { sets.push('passage_id = ?'); values.push(patch.passageId || null); }
    values.push(verificationId);
    this.db.prepare(`UPDATE verifications SET ${sets.join(', ')} WHERE verification_id = ?`).run(...values);
    return this._describeVerification(this.db.prepare('SELECT * FROM verifications WHERE verification_id = ?').get(verificationId));
  }

  deleteVerification(verificationId) {
    const row = this.db.prepare('SELECT * FROM verifications WHERE verification_id = ?').get(verificationId);
    if (!row) return false;
    this.db.prepare('DELETE FROM verifications WHERE verification_id = ?').run(verificationId);
    this.recordHistory(row.case_id, 'VERIFICATION_DELETED', row.claim_id || row.case_id, { verificationId });
    return true;
  }

  listVerifications(caseId) {
    return this.db
      .prepare('SELECT * FROM verifications WHERE case_id = ? ORDER BY created_at ASC')
      .all(caseId)
      .map((r) => this._describeVerification(r));
  }

  /**
   * Context window around a time range. This is what lets the UI show a passage
   * with its surroundings; it reads only from the stored transcript and never
   * re-runs ASR.
   */
  getAnalysisContext(evidenceId, startSeconds, endSeconds, windowSeconds = 30) {
    const ev = this.getEvidence(evidenceId);
    if (!ev) {
      const err = new Error('Evidence not found.');
      err.code = 'EVIDENCE_NOT_FOUND';
      throw err;
    }
    const win = Number.isFinite(Number(windowSeconds)) && Number(windowSeconds) > 0 ? Number(windowSeconds) : 30;
    const start = Number(startSeconds);
    const end = Number(endSeconds);
    const from = Math.max(0, (Number.isFinite(start) ? start : 0) - win);
    const to = (Number.isFinite(end) ? end : from) + win;
    const transcript = this.getTranscript(ev.case_id, evidenceId);
    const segments = transcript ? this.getSegments(transcript.transcript_id) : [];
    const inWindow = segments.filter((s) => s.end >= from && s.start <= to);
    return {
      evidence_id: evidenceId,
      from_seconds: from,
      to_seconds: to,
      window_seconds: win,
      segments: inWindow.map((s) => ({
        segment_id: s.segment_id,
        start: s.start,
        end: s.end,
        speaker: s.speaker,
        text: s.text,
        status: s.status,
      })),
    };
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
      questions: row.questions_json ? JSON.parse(row.questions_json) : [],
      sources: row.sources_json ? JSON.parse(row.sources_json) : [],
      state: row.state || REPORT_REVISION_STATE.DRAFT,
      current_revision_id: row.current_revision_id || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Save the report working draft and append an immutable report revision.
   *
   * A finalized report revision is never silently replaced: if the current
   * revision is FINAL and the caller does not explicitly reopen it, the save is
   * refused with REPORT_FINAL_LOCKED. Reopening appends a new DRAFT revision and
   * leaves the FINAL snapshot readable.
   */
  saveReport(caseId, { template = 'generic', title = '', sections = [], questions = [], sources = [], state = REPORT_REVISION_STATE.DRAFT, reopen = false } = {}) {
    const kase = this.getCase(caseId);
    if (!kase) {
      const err = new Error(`Case not found: ${caseId}`);
      err.code = 'CASE_NOT_FOUND';
      throw err;
    }
    const existing = this.getReport(caseId);
    const currentRevision = this.getCurrentReportRevision(caseId);
    if (currentRevision && currentRevision.state === REPORT_REVISION_STATE.FINAL && !reopen && state !== REPORT_REVISION_STATE.FINAL) {
      const err = new Error('The finalized report is locked. Reopen it to make further edits.');
      err.code = 'REPORT_FINAL_LOCKED';
      throw err;
    }
    const ts = nowIso();
    const payload = JSON.stringify(Array.isArray(sections) ? sections : []);
    const questionsJson = JSON.stringify(Array.isArray(questions) ? questions : []);
    const sourcesJson = JSON.stringify(Array.isArray(sources) ? sources : []);
    const revisionId = makeId('RREV');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) {
        this.db
          .prepare(
            `UPDATE reports SET template = ?, title = ?, sections_json = ?, questions_json = ?, sources_json = ?, state = ?, current_revision_id = ?, updated_at = ? WHERE case_id = ?`
          )
          .run(String(template), String(title || ''), payload, questionsJson, sourcesJson, String(state), revisionId, ts, caseId);
      } else {
        this.db
          .prepare(
            `INSERT INTO reports(case_id, template, title, sections_json, questions_json, sources_json, state, current_revision_id, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(caseId, String(template), String(title || ''), payload, questionsJson, sourcesJson, String(state), revisionId, ts, ts);
      }
      this.db.prepare('UPDATE report_revisions SET is_current = 0 WHERE case_id = ?').run(caseId);
      this.db
        .prepare(
          `INSERT INTO report_revisions(revision_id, case_id, state, is_current, template, title, sections_json, questions_json, sources_json, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`
        )
        .run(revisionId, caseId, String(state), 1, String(template), String(title || ''), payload, questionsJson, sourcesJson, ts);
      this.db
        .prepare('INSERT INTO history(case_id, action, target, detail_json, created_at) VALUES(?,?,?,?,?)')
        .run(
          caseId,
          'REPORT_SAVED',
          caseId,
          JSON.stringify({
            template,
            sectionCount: (Array.isArray(sections) ? sections : []).length,
            questionCount: (Array.isArray(questions) ? questions : []).length,
            revisionId,
            state,
          }),
          ts
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this._touchCase(caseId);
    return this.getReport(caseId);
  }

  _describeReportRevision(row) {
    return {
      revision_id: row.revision_id,
      case_id: row.case_id,
      state: row.state,
      is_current: row.is_current ? 1 : 0,
      template: row.template,
      title: row.title,
      sections: row.sections_json ? JSON.parse(row.sections_json) : [],
      questions: row.questions_json ? JSON.parse(row.questions_json) : [],
      sources: row.sources_json ? JSON.parse(row.sources_json) : [],
      created_at: row.created_at,
    };
  }

  getCurrentReportRevision(caseId) {
    return (
      this._describeReportRevision(
        this.db
          .prepare('SELECT * FROM report_revisions WHERE case_id = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1')
          .get(caseId) || {}
      ) || null
    );
  }

  listReportRevisions(caseId) {
    const rows = this.db
      .prepare('SELECT * FROM report_revisions WHERE case_id = ? ORDER BY created_at DESC')
      .all(caseId);
    return rows.map((r) => this._describeReportRevision(r));
  }

  getReportRevision(revisionId) {
    const row = this.db.prepare('SELECT * FROM report_revisions WHERE revision_id = ?').get(revisionId);
    return row ? this._describeReportRevision(row) : null;
  }

  /** Make a prior report revision the current working draft (append-only history). */
  setCurrentReportRevision(revisionId) {
    const rev = this.getReportRevision(revisionId);
    if (!rev) {
      const err = new Error('Report revision not found.');
      err.code = 'REPORT_REVISION_NOT_FOUND';
      throw err;
    }
    const ts = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE report_revisions SET is_current = 0 WHERE case_id = ?').run(rev.case_id);
      this.db.prepare('UPDATE report_revisions SET is_current = 1 WHERE revision_id = ?').run(revisionId);
      this.db
        .prepare(
          'UPDATE reports SET template = ?, title = ?, sections_json = ?, questions_json = ?, sources_json = ?, state = ?, current_revision_id = ?, updated_at = ? WHERE case_id = ?'
        )
        .run(
          rev.template,
          rev.title,
          JSON.stringify(rev.sections),
          JSON.stringify(rev.questions),
          JSON.stringify(rev.sources),
          rev.state,
          revisionId,
          ts,
          rev.case_id
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.recordHistory(rev.case_id, 'REPORT_REVISION_RESTORED', rev.case_id, { revisionId, state: rev.state });
    return this.getReport(rev.case_id);
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
   * Build an FTS5 MATCH expression from free text: every whitespace token
   * becomes a quoted prefix term joined with AND, so "ses kayd" matches "ses
   * kaydı" and punctuation can never break the query.
   */
  _ftsQuery(text) {
    return String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
      .join(' ');
  }

  /**
   * Case-wide search over transcript text, speakers, evidence names and
   * notes/bookmarks/findings.
   *
   * Uses the FTS5 index when the bundled SQLite supports it (ranked, indexed,
   * no full-table scan); otherwise it falls back to an indexed LIKE scan. Every
   * hit is positioned so the UI can jump straight to the recording time, and
   * segment hits carry the revision they came from.
   */
  searchCase(caseId, query, { limit = 200 } = {}) {
    const raw = String(query || '').trim();
    if (!raw) return { query: '', hits: [], engine: this.ftsAvailable ? 'fts5' : 'like' };
    const max = Math.max(1, Math.min(1000, Number(limit) || 200));
    const evidence = this.listEvidence(caseId);
    const evById = new Map(evidence.map((e) => [e.evidence_id, e]));

    if (this.ftsAvailable) {
      const hits = this._searchFts(caseId, raw, max, evById);
      if (hits) return { query: raw, hits, engine: 'fts5' };
      // On an FTS error, fall through to the LIKE scan rather than fail search.
    }
    return { query: raw, hits: this._searchLike(caseId, raw.toLowerCase(), max, evidence, evById), engine: 'like' };
  }

  _searchFts(caseId, raw, max, evById) {
    try {
      const rows = this.db
        .prepare(
          `SELECT kind, ref_id, evidence_id, transcript_id, start_seconds, speaker, body
             FROM search_fts WHERE case_id = ? AND search_fts MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(caseId, this._ftsQuery(raw), max);
      const hits = [];
      const revCache = new Map();
      for (const r of rows) {
        const ev = r.evidence_id ? evById.get(r.evidence_id) : null;
        const hit = {
          type: r.kind,
          evidence_id: r.evidence_id || null,
          evidence_name: ev ? ev.original_name : null,
          text: r.body,
          speaker: r.speaker || null,
        };
        if (r.kind === 'segment') {
          hit.transcript_id = r.transcript_id;
          hit.segment_id = r.ref_id;
          hit.start = r.start_seconds === null ? null : Number(r.start_seconds);
          if (r.transcript_id && !revCache.has(r.transcript_id)) {
            const rev = this.getCurrentRevisionInfo(r.transcript_id);
            revCache.set(r.transcript_id, rev ? { revision_id: rev.revision_id, state: rev.state } : null);
          }
          hit.revision = r.transcript_id ? revCache.get(r.transcript_id) : null;
        } else if (r.kind === 'note' || r.kind === 'bookmark') {
          hit.note_id = r.ref_id;
          hit.at_seconds = r.start_seconds === null ? null : Number(r.start_seconds);
        } else if (r.kind === 'finding') {
          hit.finding_id = r.ref_id;
          hit.at_seconds = r.start_seconds === null ? null : Number(r.start_seconds);
        }
        hits.push(hit);
      }
      return hits;
    } catch {
      return null;
    }
  }

  _searchLike(caseId, q, max, evidence, evById) {
    const hits = [];
    const push = (hit) => {
      if (hits.length < max) hits.push(hit);
    };

    for (const ev of evidence) {
      if (String(ev.original_name || '').toLowerCase().includes(q)) {
        push({ type: 'evidence', evidence_id: ev.evidence_id, evidence_name: ev.original_name, text: ev.original_name });
      }
    }

    for (const ev of evidence) {
      const t = this.getTranscript(caseId, ev.evidence_id);
      if (!t) continue;
      const rev = this.getCurrentRevisionInfo(t.transcript_id);
      const revision = rev ? { revision_id: rev.revision_id, state: rev.state } : null;
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
            revision,
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

    for (const f of this.listFindings(caseId)) {
      const hay = `${f.title || ''} ${f.description || ''} ${f.observation || ''}`.toLowerCase();
      if (hay.includes(q)) {
        const ev = f.evidence_id ? evById.get(f.evidence_id) : null;
        push({
          type: 'finding',
          finding_id: f.finding_id,
          evidence_id: f.evidence_id,
          evidence_name: ev ? ev.original_name : null,
          at_seconds: f.at_seconds,
          text: f.title || f.observation || '',
        });
      }
    }

    return hits;
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

'use strict';

/**
 * Shared constants used by the main process, the renderer and the tests.
 * Written as a UMD wrapper so the same file loads under Node (CommonJS) and in
 * the renderer (browser global `FT_CONSTANTS`).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FT_CONSTANTS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEGMENT_STATUS = Object.freeze({
    AUTOMATIC: 'AUTOMATIC',
    REVIEWED: 'REVIEWED',
    EDITED: 'EDITED',
    VERIFIED: 'VERIFIED',
  });

  const SEGMENT_STATUS_VALUES = Object.freeze(Object.values(SEGMENT_STATUS));

  // Statuses a human has actively confirmed. Automatic output is never treated
  // as expert output; the distinction is preserved throughout storage/export.
  const HUMAN_STATUSES = Object.freeze([
    SEGMENT_STATUS.REVIEWED,
    SEGMENT_STATUS.EDITED,
    SEGMENT_STATUS.VERIFIED,
  ]);

  const UNCLEAR_PLACEHOLDER = '[ANLAŞILAMADI]';

  // A transcript revision is one immutable snapshot of a transcript's segments.
  // It records whether the snapshot is machine output or human-reviewed work, so
  // a new ASR run can never silently erase a reviewed/edited/verified revision.
  const REVISION_STATE = Object.freeze({
    MACHINE: 'MACHINE',
    REVIEWED: 'REVIEWED',
    EDITED: 'EDITED',
    VERIFIED: 'VERIFIED',
  });
  const REVISION_STATE_VALUES = Object.freeze(Object.values(REVISION_STATE));

  // Report revisions are append-only snapshots like transcript revisions. A
  // finalized report revision is never silently overwritten; a further edit
  // appends a new revision instead.
  const REPORT_REVISION_STATE = Object.freeze({
    DRAFT: 'DRAFT',
    EDITED: 'EDITED',
    FINAL_REVIEW: 'FINAL_REVIEW',
    FINAL: 'FINAL',
  });
  const REPORT_REVISION_STATE_VALUES = Object.freeze(Object.values(REPORT_REVISION_STATE));

  // Per-segment operator working flags. Distinct from the transcript status:
  // a flag is a personal reminder, not a status change or a legal finding.
  const REVIEW_FLAGS = Object.freeze({
    UNCLEAR: 'UNCLEAR',
    REVISIT: 'REVISIT',
    REVIEW: 'REVIEW',
  });
  const REVIEW_FLAG_VALUES = Object.freeze(Object.values(REVIEW_FLAGS));

  // Note kinds. BOOKMARK is time-anchored; FINDING is a structured observation
  // the operator may promote into the report with an explicit source link.
  const NOTE_KIND = Object.freeze({
    NOTE: 'NOTE',
    BOOKMARK: 'BOOKMARK',
    FINDING: 'FINDING',
  });

  const TRANSCRIPT_SCHEMA_VERSION = '1.0';
  const CASE_SCHEMA_VERSION = '1.0';

  // Expert analysis layer. It is deliberately separate from the transcript: a
  // passage is anchored to a revision (never raw ASR) and always carries a
  // context window so an isolated quote can never be promoted to a finding.
  const SPEECH_ACT = Object.freeze({
    LITERAL: 'LITERAL',
    HYPOTHETICAL: 'HYPOTHETICAL',
    CHARACTER: 'CHARACTER',
    QUOTATION: 'QUOTATION',
    IRONY: 'IRONY',
    PUNCHLINE: 'PUNCHLINE',
    EVENT: 'EVENT',
    REALITY_CLAIM: 'REALITY_CLAIM',
    ATTRIBUTION: 'ATTRIBUTION',
  });
  const SPEECH_ACT_VALUES = Object.freeze(Object.values(SPEECH_ACT));

  const PASSAGE_CONFIDENCE = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });
  const PASSAGE_CONFIDENCE_VALUES = Object.freeze(Object.values(PASSAGE_CONFIDENCE));

  const VERIFICATION_STATUS = Object.freeze({
    VERIFIED: 'VERIFIED',
    NOT_VERIFIABLE: 'NOT_VERIFIABLE',
    PENDING: 'PENDING',
  });
  const VERIFICATION_STATUS_VALUES = Object.freeze(Object.values(VERIFICATION_STATUS));

  const SOURCE_KIND = Object.freeze({
    PRIMARY: 'PRIMARY',
    REFERENCE: 'REFERENCE',
    SECONDARY: 'SECONDARY',
  });
  const SOURCE_KIND_VALUES = Object.freeze(Object.values(SOURCE_KIND));

  // Default context window (seconds) around a passage. The operator may widen
  // it, but it is never zero: a passage without context is not admissible.
  const PASSAGE_CONTEXT_SECONDS = 30;
  const PASSAGE_CONTEXT_OPTIONS = Object.freeze([30, 60]);

  const HISTORY_ACTIONS = Object.freeze({
    CASE_CREATED: 'CASE_CREATED',
    EVIDENCE_IMPORTED: 'EVIDENCE_IMPORTED',
    TRANSCRIPTION_CREATED: 'TRANSCRIPTION_CREATED',
    TEXT_EDITED: 'TEXT_EDITED',
    SEGMENT_SPLIT: 'SEGMENT_SPLIT',
    SEGMENT_MERGED: 'SEGMENT_MERGED',
    SPEAKER_CHANGED: 'SPEAKER_CHANGED',
    STATUS_CHANGED: 'STATUS_CHANGED',
    TRANSCRIPT_SAVED: 'TRANSCRIPT_SAVED',
    EXPORT_CREATED: 'EXPORT_CREATED',
    TRANSCRIPTION_STARTED: 'TRANSCRIPTION_STARTED',
    TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
    TRANSCRIPTION_CANCELLED: 'TRANSCRIPTION_CANCELLED',
    PASSAGE_CREATED: 'PASSAGE_CREATED',
    PASSAGE_DELETED: 'PASSAGE_DELETED',
    CLAIM_CREATED: 'CLAIM_CREATED',
    CLAIM_DELETED: 'CLAIM_DELETED',
    SOURCE_CREATED: 'SOURCE_CREATED',
    SOURCE_DELETED: 'SOURCE_DELETED',
    VERIFICATION_RECORDED: 'VERIFICATION_RECORDED',
    VERIFICATION_DELETED: 'VERIFICATION_DELETED',
  });

  const SUPPORTED_EXTENSIONS = Object.freeze([
    '.wav', '.mp3', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.mp4', '.mov',
    '.mkv', '.webm', '.aac', '.wma', '.aiff', '.aif', '.amr', '.m4b',
  ]);

  const DEFAULT_SPEAKERS = Object.freeze(['SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03', 'SPEAKER_04']);

  const IPC = Object.freeze({
    APP_INFO: 'app:info',
    APP_ENGINE_PROBE: 'app:engine-probe',
    UPDATE_STATUS: 'update:status',
    UPDATE_STATE: 'update:state',
    UPDATE_CHECK: 'update:check',
    UPDATE_DOWNLOAD: 'update:download',
    UPDATE_POSTPONE: 'update:postpone',
    UPDATE_INSTALL: 'update:install',
    PATHS: 'app:paths',
    CASE_CREATE: 'case:create',
    CASE_LIST: 'case:list',
    CASE_OPEN: 'case:open',
    CASE_UPDATE: 'case:update',
    CASE_DELETE: 'case:delete',
    EVIDENCE_IMPORT: 'evidence:import',
    EVIDENCE_IMPORT_PROGRESS: 'evidence:import-progress',
    EVIDENCE_LIST: 'evidence:list',
    EVIDENCE_DELETE: 'evidence:delete',
    EVIDENCE_REVEAL: 'evidence:reveal',
    APP_REVEAL_DATA_DIR: 'app:reveal-data-dir',
    APP_HEALTH: 'app:health',
    EXPORT_REVEAL: 'export:reveal',
    CASE_ARCHIVE_EXPORT: 'case:archive-export',
    CASE_ARCHIVE_IMPORT: 'case:archive-import',
    EVIDENCE_VERIFY: 'evidence:verify',
    EVIDENCE_WAVEFORM: 'evidence:waveform',
    TRANSCRIBE_START: 'transcribe:start',
    TRANSCRIBE_CANCEL: 'transcribe:cancel',
    TRANSCRIBE_PROGRESS: 'transcribe:progress',
    TRANSCRIPT_GET: 'transcript:get',
    TRANSCRIPT_SAVE: 'transcript:save',
    TRANSCRIPT_REVISIONS: 'transcript:revisions',
    TRANSCRIPT_SET_REVISION: 'transcript:set-revision',
    HISTORY_LIST: 'history:list',
    HISTORY_RUNS: 'history:runs',
    MODEL_LIST: 'model:list',
    MODEL_INSTALL: 'model:install',
    MODEL_IMPORT_FILE: 'model:import-file',
    EXPORT_RUN: 'export:run',
    CASE_DASHBOARD: 'case:dashboard',
    NOTE_CREATE: 'note:create',
    NOTE_UPDATE: 'note:update',
    NOTE_DELETE: 'note:delete',
    NOTE_LIST: 'note:list',
    SEARCH_CASE: 'search:case',
    REPORT_GET: 'report:get',
    REPORT_TEMPLATES: 'report:templates',
    REPORT_SAVE: 'report:save',
    REPORT_BUILD: 'report:build',
    REPORT_EXPORT: 'report:export',
    REPORT_CHECKLIST: 'report:checklist',
    REPORT_REVISIONS: 'report:revisions',
    REPORT_REVISION_SET: 'report:revision-set',
    REPORT_REVISION_GET: 'report:revision-get',
    FINDING_CREATE: 'finding:create',
    FINDING_LIST: 'finding:list',
    FINDING_UPDATE: 'finding:update',
    FINDING_DELETE: 'finding:delete',
    TRANSCRIPT_PAGE: 'transcript:page',
    SEARCH_INDEX: 'search:index',
    DELIVERY_BUILD: 'delivery:build',
    UYAP_PREPARE: 'uyap:prepare',
    AI_STATUS: 'ai:status',
    AI_GENERATE: 'ai:generate',
    PREF_ALL: 'pref:all',
    PREF_SET: 'pref:set',
    PASSAGE_LIST: 'passage:list',
    PASSAGE_CREATE: 'passage:create',
    PASSAGE_UPDATE: 'passage:update',
    PASSAGE_DELETE: 'passage:delete',
    CLAIM_LIST: 'claim:list',
    CLAIM_CREATE: 'claim:create',
    CLAIM_UPDATE: 'claim:update',
    CLAIM_DELETE: 'claim:delete',
    SOURCE_LIST: 'source:list',
    SOURCE_CREATE: 'source:create',
    SOURCE_UPDATE: 'source:update',
    SOURCE_DELETE: 'source:delete',
    VERIFICATION_LIST: 'verification:list',
    VERIFICATION_CREATE: 'verification:create',
    VERIFICATION_UPDATE: 'verification:update',
    VERIFICATION_DELETE: 'verification:delete',
    ANALYSIS_CONTEXT: 'analysis:context',
    DIAGNOSTICS_LIST: 'diagnostics:list',
    DIAGNOSTICS_RECORD: 'diagnostics:record',
    SUPPORT_BUNDLE: 'support:bundle',
    DIALOG_OPEN_FILES: 'dialog:openFiles',
    DIALOG_SAVE_FILE: 'dialog:saveFile',
    DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  });

  // Local UI appearance. Stored as preferences and applied to the document
  // root; light is the default so a first launch is readable in a bright office.
  const THEMES = Object.freeze({ LIGHT: 'light', DARK: 'dark' });
  const THEME_VALUES = Object.freeze(Object.values(THEMES));
  const ACCENTS = Object.freeze({ BLUE: 'blue', TEAL: 'teal', INDIGO: 'indigo' });
  const ACCENT_VALUES = Object.freeze(Object.values(ACCENTS));

  return {
    SEGMENT_STATUS,
    SEGMENT_STATUS_VALUES,
    HUMAN_STATUSES,
    REVISION_STATE,
    REVISION_STATE_VALUES,
    REPORT_REVISION_STATE,
    REPORT_REVISION_STATE_VALUES,
    REVIEW_FLAGS,
    REVIEW_FLAG_VALUES,
    NOTE_KIND,
    SPEECH_ACT,
    SPEECH_ACT_VALUES,
    PASSAGE_CONFIDENCE,
    PASSAGE_CONFIDENCE_VALUES,
    VERIFICATION_STATUS,
    VERIFICATION_STATUS_VALUES,
    SOURCE_KIND,
    SOURCE_KIND_VALUES,
    PASSAGE_CONTEXT_SECONDS,
    PASSAGE_CONTEXT_OPTIONS,
    THEMES,
    THEME_VALUES,
    ACCENTS,
    ACCENT_VALUES,
    UNCLEAR_PLACEHOLDER,
    TRANSCRIPT_SCHEMA_VERSION,
    CASE_SCHEMA_VERSION,
    HISTORY_ACTIONS,
    SUPPORTED_EXTENSIONS,
    DEFAULT_SPEAKERS,
    IPC,
  };
});

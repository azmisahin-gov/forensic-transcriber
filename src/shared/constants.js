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

  const TRANSCRIPT_SCHEMA_VERSION = '1.0';
  const CASE_SCHEMA_VERSION = '1.0';

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
    EVIDENCE_LIST: 'evidence:list',
    EVIDENCE_DELETE: 'evidence:delete',
    EVIDENCE_REVEAL: 'evidence:reveal',
    APP_REVEAL_DATA_DIR: 'app:reveal-data-dir',
    EXPORT_REVEAL: 'export:reveal',
    EVIDENCE_WAVEFORM: 'evidence:waveform',
    TRANSCRIBE_START: 'transcribe:start',
    TRANSCRIBE_CANCEL: 'transcribe:cancel',
    TRANSCRIBE_PROGRESS: 'transcribe:progress',
    TRANSCRIPT_GET: 'transcript:get',
    TRANSCRIPT_SAVE: 'transcript:save',
    HISTORY_LIST: 'history:list',
    MODEL_LIST: 'model:list',
    MODEL_INSTALL: 'model:install',
    MODEL_IMPORT_FILE: 'model:import-file',
    EXPORT_RUN: 'export:run',
    DIALOG_OPEN_FILES: 'dialog:openFiles',
    DIALOG_SAVE_FILE: 'dialog:saveFile',
    DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  });

  return {
    SEGMENT_STATUS,
    SEGMENT_STATUS_VALUES,
    HUMAN_STATUSES,
    UNCLEAR_PLACEHOLDER,
    TRANSCRIPT_SCHEMA_VERSION,
    CASE_SCHEMA_VERSION,
    HISTORY_ACTIONS,
    SUPPORTED_EXTENSIONS,
    DEFAULT_SPEAKERS,
    IPC,
  };
});

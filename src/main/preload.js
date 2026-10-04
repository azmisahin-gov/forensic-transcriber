'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/constants');
const { MODEL_REGISTRY } = require('../shared/model-registry');

/**
 * The renderer receives a narrow, explicit API. It has no direct access to
 * Node, the filesystem, or child processes.
 */
const api = {
  app: {
    info: () => ipcRenderer.invoke(IPC.APP_INFO),
    paths: () => ipcRenderer.invoke(IPC.PATHS),
    probeEngine: () => ipcRenderer.invoke(IPC.APP_ENGINE_PROBE),
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.UPDATE_STATE),
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    download: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
    postpone: () => ipcRenderer.invoke(IPC.UPDATE_POSTPONE),
    install: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onStatus: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on(IPC.UPDATE_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, listener);
    },
  },
  cases: {
    create: (input) => ipcRenderer.invoke(IPC.CASE_CREATE, input),
    list: () => ipcRenderer.invoke(IPC.CASE_LIST),
    open: (caseId) => ipcRenderer.invoke(IPC.CASE_OPEN, caseId),
    update: (caseId, patch) => ipcRenderer.invoke(IPC.CASE_UPDATE, caseId, patch),
    remove: (caseId) => ipcRenderer.invoke(IPC.CASE_DELETE, caseId),
    dashboard: (caseId) => ipcRenderer.invoke(IPC.CASE_DASHBOARD, caseId),
    archiveExport: (caseId) => ipcRenderer.invoke(IPC.CASE_ARCHIVE_EXPORT, caseId),
    archiveImport: () => ipcRenderer.invoke(IPC.CASE_ARCHIVE_IMPORT),
    history: (caseId) => ipcRenderer.invoke(IPC.HISTORY_LIST, caseId),
    runs: (caseId, evidenceId) => ipcRenderer.invoke(IPC.HISTORY_RUNS, caseId, evidenceId),
  },
  notes: {
    list: (caseId, evidenceId) => ipcRenderer.invoke(IPC.NOTE_LIST, caseId, evidenceId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.NOTE_CREATE, caseId, input),
    update: (noteId, patch) => ipcRenderer.invoke(IPC.NOTE_UPDATE, noteId, patch),
    remove: (noteId) => ipcRenderer.invoke(IPC.NOTE_DELETE, noteId),
  },
  search: {
    case: (caseId, query) => ipcRenderer.invoke(IPC.SEARCH_CASE, caseId, query),
  },
  report: {
    get: (caseId) => ipcRenderer.invoke(IPC.REPORT_GET, caseId),
    templates: () => ipcRenderer.invoke(IPC.REPORT_TEMPLATES),
    save: (caseId, payload) => ipcRenderer.invoke(IPC.REPORT_SAVE, caseId, payload),
    build: (caseId) => ipcRenderer.invoke(IPC.REPORT_BUILD, caseId),
    export: (caseId, options) => ipcRenderer.invoke(IPC.REPORT_EXPORT, caseId, options),
    checklist: (caseId) => ipcRenderer.invoke(IPC.REPORT_CHECKLIST, caseId),
    revisions: (caseId) => ipcRenderer.invoke(IPC.REPORT_REVISIONS, caseId),
    revision: (revisionId) => ipcRenderer.invoke(IPC.REPORT_REVISION_GET, revisionId),
    setRevision: (caseId, revisionId) => ipcRenderer.invoke(IPC.REPORT_REVISION_SET, caseId, revisionId),
  },
  findings: {
    list: (caseId) => ipcRenderer.invoke(IPC.FINDING_LIST, caseId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.FINDING_CREATE, caseId, input),
    update: (findingId, patch) => ipcRenderer.invoke(IPC.FINDING_UPDATE, findingId, patch),
    remove: (findingId) => ipcRenderer.invoke(IPC.FINDING_DELETE, findingId),
  },
  passages: {
    list: (caseId) => ipcRenderer.invoke(IPC.PASSAGE_LIST, caseId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.PASSAGE_CREATE, caseId, input),
    update: (passageId, patch) => ipcRenderer.invoke(IPC.PASSAGE_UPDATE, passageId, patch),
    remove: (passageId) => ipcRenderer.invoke(IPC.PASSAGE_DELETE, passageId),
  },
  claims: {
    list: (caseId) => ipcRenderer.invoke(IPC.CLAIM_LIST, caseId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.CLAIM_CREATE, caseId, input),
    update: (claimId, patch) => ipcRenderer.invoke(IPC.CLAIM_UPDATE, claimId, patch),
    remove: (claimId) => ipcRenderer.invoke(IPC.CLAIM_DELETE, claimId),
  },
  sources: {
    list: (caseId) => ipcRenderer.invoke(IPC.SOURCE_LIST, caseId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.SOURCE_CREATE, caseId, input),
    update: (sourceId, patch) => ipcRenderer.invoke(IPC.SOURCE_UPDATE, sourceId, patch),
    remove: (sourceId) => ipcRenderer.invoke(IPC.SOURCE_DELETE, sourceId),
  },
  verifications: {
    list: (caseId) => ipcRenderer.invoke(IPC.VERIFICATION_LIST, caseId),
    create: (caseId, input) => ipcRenderer.invoke(IPC.VERIFICATION_CREATE, caseId, input),
    update: (verificationId, patch) => ipcRenderer.invoke(IPC.VERIFICATION_UPDATE, verificationId, patch),
    remove: (verificationId) => ipcRenderer.invoke(IPC.VERIFICATION_DELETE, verificationId),
  },
  analysis: {
    context: (evidenceId, startSeconds, endSeconds, windowSeconds) =>
      ipcRenderer.invoke(IPC.ANALYSIS_CONTEXT, evidenceId, startSeconds, endSeconds, windowSeconds),
  },
  searchIndex: {
    rebuild: (caseId) => ipcRenderer.invoke(IPC.SEARCH_INDEX, caseId),
  },
  ai: {
    status: () => ipcRenderer.invoke(IPC.AI_STATUS),
    generate: (input) => ipcRenderer.invoke(IPC.AI_GENERATE, input),
  },
  uyap: {
    prepare: (caseId, options) => ipcRenderer.invoke(IPC.UYAP_PREPARE, caseId, options),
  },
  delivery: {
    build: (caseId, options) => ipcRenderer.invoke(IPC.DELIVERY_BUILD, caseId, options),
  },
  preferences: {
    all: () => ipcRenderer.invoke(IPC.PREF_ALL),
    set: (key, value) => ipcRenderer.invoke(IPC.PREF_SET, key, value),
  },
  diagnostics: {
    list: (limit) => ipcRenderer.invoke(IPC.DIAGNOSTICS_LIST, limit),
    record: (entry) => ipcRenderer.invoke(IPC.DIAGNOSTICS_RECORD, entry),
    bundle: (options) => ipcRenderer.invoke(IPC.SUPPORT_BUNDLE, options),
  },
  evidence: {
    importFiles: (caseId, paths) => ipcRenderer.invoke(IPC.EVIDENCE_IMPORT, caseId, paths),
    onImportProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on(IPC.EVIDENCE_IMPORT_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.EVIDENCE_IMPORT_PROGRESS, listener);
    },
    list: (caseId) => ipcRenderer.invoke(IPC.EVIDENCE_LIST, caseId),
    remove: (evidenceId) => ipcRenderer.invoke(IPC.EVIDENCE_DELETE, evidenceId),
    reveal: (evidenceId) => ipcRenderer.invoke(IPC.EVIDENCE_REVEAL, evidenceId),
    verify: (evidenceId) => ipcRenderer.invoke(IPC.EVIDENCE_VERIFY, evidenceId),
    revealDataDir: () => ipcRenderer.invoke(IPC.APP_REVEAL_DATA_DIR),
    health: () => ipcRenderer.invoke(IPC.APP_HEALTH),
    waveform: (evidenceId, buckets) => ipcRenderer.invoke(IPC.EVIDENCE_WAVEFORM, evidenceId, buckets),
    playbackUrl: (evidenceId) => `ft-media://evidence/${encodeURIComponent(evidenceId)}`,
  },
  transcript: {
    get: (caseId, evidenceId) => ipcRenderer.invoke(IPC.TRANSCRIPT_GET, caseId, evidenceId),
    save: (caseId, evidenceId, payload) => ipcRenderer.invoke(IPC.TRANSCRIPT_SAVE, caseId, evidenceId, payload),
    revisions: (caseId, evidenceId) => ipcRenderer.invoke(IPC.TRANSCRIPT_REVISIONS, caseId, evidenceId),
    setRevision: (revisionId) => ipcRenderer.invoke(IPC.TRANSCRIPT_SET_REVISION, revisionId),
    page: (transcriptId, options) => ipcRenderer.invoke(IPC.TRANSCRIPT_PAGE, transcriptId, options),
  },
  transcribe: {
    start: (input) => ipcRenderer.invoke(IPC.TRANSCRIBE_START, input),
    cancel: () => ipcRenderer.invoke(IPC.TRANSCRIBE_CANCEL),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on(IPC.TRANSCRIBE_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.TRANSCRIBE_PROGRESS, listener);
    },
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.MODEL_LIST),
    install: (modelId) => ipcRenderer.invoke(IPC.MODEL_INSTALL, modelId),
    importFile: (modelId) => ipcRenderer.invoke(IPC.MODEL_IMPORT_FILE, modelId),
    registry: MODEL_REGISTRY.map((m) => ({
      id: m.id, label: m.label, kind: m.kind, recommended: m.recommended,
      description: m.description, license: m.license, sizeBytes: m.sizeBytes,
    })),
  },
  exports: {
    run: (caseId, evidenceId, options) => ipcRenderer.invoke(IPC.EXPORT_RUN, caseId, evidenceId, options),
    reveal: (caseId, evidenceId) => ipcRenderer.invoke(IPC.EXPORT_REVEAL, caseId, evidenceId),
  },
  dialog: {
    openFiles: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_FILES),
    openDirectory: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIRECTORY),
    saveFile: (options) => ipcRenderer.invoke(IPC.DIALOG_SAVE_FILE, options),
  },
};

contextBridge.exposeInMainWorld('ft', api);

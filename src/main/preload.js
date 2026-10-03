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
    history: (caseId) => ipcRenderer.invoke(IPC.HISTORY_LIST, caseId),
  },
  evidence: {
    importFiles: (caseId, paths) => ipcRenderer.invoke(IPC.EVIDENCE_IMPORT, caseId, paths),
    list: (caseId) => ipcRenderer.invoke(IPC.EVIDENCE_LIST, caseId),
    remove: (evidenceId) => ipcRenderer.invoke(IPC.EVIDENCE_DELETE, evidenceId),
    reveal: (evidenceId) => ipcRenderer.invoke(IPC.EVIDENCE_REVEAL, evidenceId),
    revealDataDir: () => ipcRenderer.invoke(IPC.APP_REVEAL_DATA_DIR),
    waveform: (evidenceId, buckets) => ipcRenderer.invoke(IPC.EVIDENCE_WAVEFORM, evidenceId, buckets),
    playbackUrl: (evidenceId) => `ft-media://evidence/${encodeURIComponent(evidenceId)}`,
  },
  transcript: {
    get: (caseId, evidenceId) => ipcRenderer.invoke(IPC.TRANSCRIPT_GET, caseId, evidenceId),
    save: (caseId, evidenceId, payload) => ipcRenderer.invoke(IPC.TRANSCRIPT_SAVE, caseId, evidenceId, payload),
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

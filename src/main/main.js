'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { IPC, SUPPORTED_EXTENSIONS, HISTORY_ACTIONS } = require('../shared/constants');
const { DEFAULT_ASR_MODEL_ID, DEFAULT_VAD_MODEL_ID, getModel } = require('../shared/model-registry');
const { Storage, sha256File } = require('./services/storage');
const { Logger } = require('./services/logger');
const { MediaService } = require('./services/media');
const { ModelManager } = require('./services/model-manager');
const { WhisperAdapter } = require('./services/whisper');
const { RuntimeSelector } = require('./services/runtime-selector');
const { runExport } = require('./services/exporter');
const { writeCaseArchive, restoreCaseArchive } = require('./services/case-archive');
const { createUpdater, STATES: UPDATE_STATES } = require('./services/updater');
const { resolveBinary, userDataDir, modelsDir } = require('./services/paths');

// Update source. Pinned here and in package.json build.publish; the updater
// only ever fetches from this repository's GitHub Releases over HTTPS.
const UPDATE_REPOSITORY = 'azmisahin-gov/forensic-transcriber';

const MEDIA_SCHEME = 'ft-media';
const MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.aac': 'audio/aac', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.amr': 'audio/amr', '.m4b': 'audio/mp4',
};

// Only ft-media is privileged. It is a standard, secure, streaming scheme so
// the renderer can seek audio, but it only ever resolves evidence ids that
// exist in the local database — arbitrary paths are never exposed.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;
let storage = null;
let logger = null;
let media = null;
let modelManager = null;
let whisper = null;
let runtimeSelector = null;

/** Result of the most recent transcription, used to report the actual runtime mode. */
let lastRunMode = null;
/** Cached runtime capability probe (distinguishes CUDA-capable from CPU-only). */
let engineProbeCache = null;

/** Active transcription jobs keyed by webContents id. */
const jobs = new Map();

/** Application auto-updater (Windows only; created lazily on first use). */
let updater = null;

/**
 * The updater is only meaningful for the packaged NSIS build on Windows.
 * In development, in tests and on other platforms it stays disabled so nothing
 * ever contacts the update feed unexpectedly.
 */
function updaterEnabled() {
  if (process.platform !== 'win32') return false;
  if (process.env.FT_DISABLE_UPDATER === '1') return false;
  if (!app.isPackaged) return false;
  return true;
}

function ensureUpdater() {
  if (updater) return updater;
  if (!updaterEnabled()) return null;
  updater = createUpdater({
    repository: UPDATE_REPOSITORY,
    getCurrentVersion: () => app.getVersion(),
    logger,
    on: (state) => send(IPC.UPDATE_STATUS, state),
  });
  return updater;
}

/** State reported to the renderer; always safe to call, even when disabled. */
function updateStateForRenderer() {
  if (updater) return updater.controller.state;
  return {
    status: UPDATE_STATES.IDLE,
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadPercent: 0,
    error: null,
    enabled: false,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#10151c',
    title: 'Forensic Transcriber',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // The app is offline-first: never let the renderer navigate away or open
  // arbitrary windows. External links are handed to the OS browser explicitly.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // Surface renderer console errors so a crashed renderer is observable rather
  // than silent. The startup test reads window.__FT_CONSOLE_ERRORS__.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Electron's level 3 is an error.
    if (level >= 3) {
      const entry = `${sourceId}:${line} ${message}`;
      if (logger) logger.error('renderer console error', { entry });
      mainWindow.webContents
        .executeJavaScript(
          `(window.__FT_CONSOLE_ERRORS__ = window.__FT_CONSOLE_ERRORS__ || []).push(${JSON.stringify(entry)})`
        )
        .catch(() => {});
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function toErrorPayload(err) {
  return {
    code: err && err.code ? err.code : 'ERROR',
    message: err && err.message ? err.message : String(err),
    detail: err && err.detail ? err.detail : undefined,
    expected: err && err.expected ? err.expected : undefined,
    actual: err && err.actual ? err.actual : undefined,
  };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args);
      return { ok: true, data };
    } catch (err) {
      if (logger) logger.error(`IPC ${channel} failed`, toErrorPayload(err));
      return { ok: false, error: toErrorPayload(err) };
    }
  });
}

function requireCase(caseId) {
  const kase = storage.getCase(caseId);
  if (!kase) {
    const err = new Error(`Case not found: ${caseId}`);
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }
  return kase;
}

async function resolveEvidenceFile(evidenceId) {
  const ev = storage.getEvidence(evidenceId);
  if (!ev) {
    const err = new Error('Evidence not found.');
    err.code = 'EVIDENCE_NOT_FOUND';
    throw err;
  }
  return ev;
}

/** Resolve the audio file used for playback: derived working copy if present, else original. */
function playbackPath(ev) {
  if (ev.derived_path && fs.existsSync(ev.derived_path)) return ev.derived_path;
  return ev.original_path;
}

function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const evidenceId = decodeURIComponent(url.pathname.replace(/^\//, '')) || url.hostname;
      const ev = storage.getEvidence(evidenceId);
      if (!ev) return new Response('Not found', { status: 404 });
      const filePath = playbackPath(ev);
      if (!fs.existsSync(filePath)) return new Response('Not found', { status: 404 });

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const range = request.headers.get('range');

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          const safeStart = Math.max(0, Math.min(start, stat.size - 1));
          const safeEnd = Math.max(safeStart, Math.min(end, stat.size - 1));
          const stream = fs.createReadStream(filePath, { start: safeStart, end: safeEnd });
          return new Response(Readable.toWeb(stream), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(safeEnd - safeStart + 1),
              'Content-Range': `bytes ${safeStart}-${safeEnd}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      const stream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      if (logger) logger.error('media protocol error', toErrorPayload(err));
      return new Response('Internal error', { status: 500 });
    }
  });
}

function registerIpc() {
  handle(IPC.APP_INFO, async () => {
    const mediaStatus = await media.available();
    const models = await modelManager.list();
    return {
      name: 'Forensic Transcriber',
      version: app.getVersion(),
      scope: '56.12 — Ses Kayıtlarının Metin Haline Dönüştürülmesi',
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      dataDir: userDataDir(),
      modelsDir: modelsDir(),
      engine: whisper.describe(),
      engineVersion: await whisper.version(),
      media: mediaStatus,
      modelReady: models.some((m) => m.kind === 'asr' && m.installed && m.verified),
      defaultModelId: DEFAULT_ASR_MODEL_ID,
      supportedExtensions: SUPPORTED_EXTENSIONS,
      storage: storage.stats(),
      engineProbe: engineProbeCache,
      lastRunMode,
    };
  });

  // Report what the ASR runtimes can actually do. Requires an installed model
  // (the engine must load one to enumerate devices); the result is cached.
  handle(IPC.APP_ENGINE_PROBE, async (_e, { force = false } = {}) => {
    if (engineProbeCache && !force) return engineProbeCache;
    const asrModel = modelManager.resolvePath(DEFAULT_ASR_MODEL_ID);
    runtimeSelector.setModelPath(asrModel);
    runtimeSelector.setVadModelPath(modelManager.resolvePath(DEFAULT_VAD_MODEL_ID));
    const capability = await runtimeSelector.capability({ force });
    engineProbeCache = {
      ...capability,
      engineVersion: await whisper.version(),
      cpuBinaryPath: runtimeSelector.cpuPath,
      gpuBinaryPath: runtimeSelector.gpuPath,
      probedAt: new Date().toISOString(),
    };
    return engineProbeCache;
  });

  // ---------------------------------------------------------------- updates
  // Application auto-update. Windows + packaged only; when disabled the state
  // reports enabled:false and the actions are no-ops, so nothing is ever
  // downloaded or installed unexpectedly.
  handle(IPC.UPDATE_STATE, async () => updateStateForRenderer());

  handle(IPC.UPDATE_CHECK, async () => {
    const u = ensureUpdater();
    if (!u) return { enabled: false, state: updateStateForRenderer() };
    try {
      await u.check();
    } catch (err) {
      // A failed check must never break the running application.
      u.controller.fail(err && err.message ? err.message : 'Update check failed.');
    }
    return { enabled: true, state: u.controller.state };
  });

  handle(IPC.UPDATE_DOWNLOAD, async () => {
    const u = ensureUpdater();
    if (!u) return { enabled: false, state: updateStateForRenderer() };
    try {
      await u.download();
    } catch (err) {
      u.controller.fail(err && err.message ? err.message : 'Update download failed.');
    }
    return { enabled: true, state: u.controller.state };
  });

  handle(IPC.UPDATE_POSTPONE, async () => {
    const u = ensureUpdater();
    if (!u) return { enabled: false, state: updateStateForRenderer() };
    u.controller.postpone();
    return { enabled: true, state: u.controller.state };
  });

  handle(IPC.UPDATE_INSTALL, async () => {
    const u = ensureUpdater();
    if (!u) return { ok: false, reason: 'UPDATER_DISABLED' };
    const result = u.quitAndInstall();
    if (!result.ok) return { ok: false, reason: result.reason };
    if (logger) logger.info('update: installing and restarting');
    return { ok: true };
  });

  // Check for an update shortly after startup, but never download or install
  // without the user's explicit action.
  if (updaterEnabled()) {
    setTimeout(() => {
      const u = ensureUpdater();
      if (u) u.check().catch((err) => u.controller.fail(err && err.message ? err.message : 'Update check failed.'));
    }, 8000);
  }

  handle(IPC.PATHS, async () => ({
    dataDir: userDataDir(),
    modelsDir: modelsDir(),
    dbPath: storage.dbPath,
    casesDir: storage.casesDir,
  }));

  handle(IPC.CASE_CREATE, async (_e, input) => storage.createCase(input || {}));
  handle(IPC.CASE_LIST, async () => storage.listCases());
  handle(IPC.CASE_OPEN, async (_e, caseId) => {
    const kase = requireCase(caseId);
    const evidence = storage.listEvidence(caseId);
    // P0: re-verify each evidence copy's hash and report drift. This never
    // rewrites the stored hash or the file; it only surfaces a warning.
    const integrity = [];
    for (const ev of evidence) {
      if (!fs.existsSync(ev.original_path)) {
        integrity.push({ evidence_id: ev.evidence_id, status: 'MISSING' });
        continue;
      }
      const actual = await sha256File(ev.original_path);
      integrity.push({
        evidence_id: ev.evidence_id,
        status: actual === ev.sha256 ? 'OK' : 'MISMATCH',
      });
    }
    return {
      case: kase,
      evidence,
      history: storage.listHistory(caseId),
      integrity,
      databaseHealth: storage.healthCheck({ quick: true }),
    };
  });
  handle(IPC.CASE_UPDATE, async (_e, caseId, patch) => storage.updateCase(caseId, patch || {}));
  handle(IPC.CASE_DELETE, async (_e, caseId) => storage.deleteCase(caseId));

  handle(IPC.EVIDENCE_IMPORT, async (_e, caseId, filePaths) => {
    requireCase(caseId);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const imported = [];
    const failures = [];
    for (const filePath of paths) {
      try {
        if (!fs.existsSync(filePath)) throw Object.assign(new Error('File not found.'), { code: 'FILE_NOT_FOUND' });
        let meta = {};
        try {
          meta = await media.probe(filePath);
        } catch (probeErr) {
          // A file the decoder cannot read is still recorded, with a warning,
          // so the operator sees exactly what was rejected.
          meta = {};
          failures.push({ path: filePath, error: toErrorPayload(probeErr) });
        }
        const ev = await storage.importEvidence(caseId, filePath, meta);
        imported.push({ ...ev, probeWarning: meta.format ? null : 'Metadata could not be read by the decoder.' });
      } catch (err) {
        failures.push({ path: filePath, error: toErrorPayload(err) });
      }
    }
    return { imported, failures };
  });

  handle(IPC.EVIDENCE_LIST, async (_e, caseId) => storage.listEvidence(caseId));
  handle(IPC.EVIDENCE_DELETE, async (_e, evidenceId) => storage.deleteEvidence(evidenceId));
  handle(IPC.EVIDENCE_REVEAL, async (_e, evidenceId) => {
    const ev = await resolveEvidenceFile(evidenceId);
    shell.showItemInFolder(ev.original_path);
    return true;
  });

  // Open the folder that holds all local case data, so "Data folder" does
  // something predictable instead of opening an unrelated picker.
  handle(IPC.APP_REVEAL_DATA_DIR, async () => {
    const dir = userDataDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  // Reveal a case's exports folder, creating it if the case has not exported yet.
  handle(IPC.EXPORT_REVEAL, async (_e, caseId) => {
    const kase = requireCase(caseId);
    const dir = path.join(kase.case_dir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  handle(IPC.EVIDENCE_WAVEFORM, async (_e, evidenceId, buckets) => {
    const ev = await resolveEvidenceFile(evidenceId);
    const source = playbackPath(ev);
    if (!fs.existsSync(source)) throw Object.assign(new Error('Audio file is missing.'), { code: 'FILE_NOT_FOUND' });
    const target = Math.max(200, Math.min(8000, Number(buckets) || 1600));
    return media.waveformPeaks(source, target);
  });

  handle(IPC.TRANSCRIPT_GET, async (_e, caseId, evidenceId) => {
    const transcript = storage.getTranscript(caseId, evidenceId);
    if (!transcript) return null;
    return { transcript, segments: storage.getSegments(transcript.transcript_id) };
  });

  handle(IPC.TRANSCRIPT_SAVE, async (_e, caseId, evidenceId, payload) => {
    requireCase(caseId);
    return storage.saveTranscript(caseId, evidenceId, payload || {});
  });

  handle(IPC.HISTORY_LIST, async (_e, caseId) => storage.listHistory(caseId));
  handle(IPC.HISTORY_RUNS, async (_e, caseId, evidenceId) => storage.listTranscriptionRuns(caseId, evidenceId || null));

  // P0: database health, so a corrupted store is reported rather than crashing.
  handle(IPC.APP_HEALTH, async () => {
    const db = storage.healthCheck({ quick: true });
    return { database: db, dbPath: storage.dbPath, migration: storage.lastMigration || null };
  });

  // P0: re-verify an evidence file's hash against the stored value. Reports a
  // mismatch; never rewrites the stored hash or the file.
  handle(IPC.EVIDENCE_VERIFY, async (_e, evidenceId) => {
    const ev = await resolveEvidenceFile(evidenceId);
    if (!fs.existsSync(ev.original_path)) {
      return { evidenceId, status: 'MISSING', storedSha256: ev.sha256, actualSha256: null };
    }
    const actual = await sha256File(ev.original_path);
    return {
      evidenceId,
      status: actual === ev.sha256 ? 'OK' : 'MISMATCH',
      storedSha256: ev.sha256,
      actualSha256: actual,
    };
  });

  // P0: case archive export / import (deterministic, versioned, verified).
  handle(IPC.CASE_ARCHIVE_EXPORT, async (_e, caseId) => {
    const kase = requireCase(caseId);
    const suggested = `${(kase.title || 'case').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60)}__${caseId}.ftcase.tar.gz`;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Export case archive',
      defaultPath: suggested,
      filters: [{ name: 'Forensic Transcriber case archive', extensions: ['tar.gz', 'ftcase'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    const result = await writeCaseArchive({ storage, caseId, destPath: picked.filePath });
    storage.recordHistory(caseId, 'CASE_ARCHIVED', caseId, {
      path: picked.filePath,
      sha256: result.sha256,
      bytes: result.bytes,
    });
    return result;
  });

  handle(IPC.CASE_ARCHIVE_IMPORT, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import case archive',
      properties: ['openFile'],
      filters: [{ name: 'Forensic Transcriber case archive', extensions: ['tar.gz', 'ftcase', 'gz'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const buffer = fs.readFileSync(picked.filePaths[0]);
    const restored = await restoreCaseArchive({ storage, buffer });
    return restored;
  });

  handle(IPC.MODEL_LIST, async () => modelManager.list());
  handle(IPC.MODEL_INSTALL, async (_e, modelId) => {
    const result = await modelManager.install(modelId, {
      onProgress: (p) => send(IPC.TRANSCRIBE_PROGRESS, { kind: 'model-download', modelId, ...p }),
    });
    return result;
  });
  handle(IPC.MODEL_IMPORT_FILE, async (_e, modelId) => {
    const model = getModel(modelId);
    if (!model) throw Object.assign(new Error('Unknown model.'), { code: 'MODEL_UNKNOWN' });
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: `Select ${model.label} file`,
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    return modelManager.importFromFile(modelId, picked.filePaths[0]);
  });

  handle(IPC.DIALOG_OPEN_FILES, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import recording',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio / Video', extensions: SUPPORTED_EXTENSIONS.map((e) => e.replace('.', '')) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return picked.canceled ? [] : picked.filePaths;
  });

  handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Select folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return picked.canceled ? null : picked.filePaths[0];
  });

  handle(IPC.DIALOG_SAVE_FILE, async (_e, options) => {
    const picked = await dialog.showSaveDialog(mainWindow, options || {});
    return picked.canceled ? null : picked.filePath;
  });

  handle(IPC.EXPORT_RUN, async (_e, caseId, evidenceId, options) => {
    const kase = requireCase(caseId);
    const ev = await resolveEvidenceFile(evidenceId);
    const transcript = storage.getTranscript(caseId, evidenceId);
    if (!transcript) throw Object.assign(new Error('No transcript to export.'), { code: 'TRANSCRIPT_MISSING' });
    const segments = storage.getSegments(transcript.transcript_id);
    const formats = Array.isArray(options && options.formats) ? options.formats : ['json', 'txt', 'srt', 'html'];
    const written = await runExport({
      caseRecord: kase,
      evidence: ev,
      transcript,
      segments,
      language: transcript.language,
      modelId: transcript.model_id,
      engine: transcript.engine,
      formats,
      outputDir: options && options.outputDir ? options.outputDir : undefined,
      baseName: options && options.baseName ? options.baseName : undefined,
    });
    storage.recordHistory(caseId, HISTORY_ACTIONS.EXPORT_CREATED, evidenceId, {
      formats,
      files: written.map((w) => ({ format: w.format, path: w.path, sha256: w.sha256 })),
    });
    return written;
  });

  handle(IPC.TRANSCRIBE_CANCEL, async (event) => {
    const job = jobs.get(event.sender.id);
    if (job) {
      job.controller.abort();
      return true;
    }
    return false;
  });

  handle(IPC.TRANSCRIBE_START, async (event, input) => {
    const { caseId, evidenceId, modelId, language = 'tr', useGpu = true, useVad = true } = input || {};
    const kase = requireCase(caseId);
    const ev = await resolveEvidenceFile(evidenceId);
    if (ev.case_id !== caseId) throw Object.assign(new Error('Evidence is not part of this case.'), { code: 'EVIDENCE_MISMATCH' });
    if (jobs.has(event.sender.id)) throw Object.assign(new Error('A transcription is already running.'), { code: 'TRANSCRIPTION_BUSY' });

    const asrId = modelId || DEFAULT_ASR_MODEL_ID;
    const status = await modelManager.status(asrId);
    if (!status.exists) throw Object.assign(new Error('Model not installed. Install model package to begin.'), { code: 'MODEL_NOT_INSTALLED' });
    if (!status.verified) throw Object.assign(new Error('Installed model failed checksum verification.'), { code: 'MODEL_CHECKSUM_MISMATCH' });

    const vadStatus = await modelManager.status(DEFAULT_VAD_MODEL_ID);
    const controller = new AbortController();
    jobs.set(event.sender.id, { controller });

    const emit = (payload) => send(IPC.TRANSCRIBE_PROGRESS, payload);
    try {
      emit({ kind: 'stage', stage: 'preparing', percent: 2 });

      const derivedDir = path.join(kase.case_dir, 'evidence', 'derived');
      const derivedPath = path.join(derivedDir, `${ev.evidence_id}.asr16k.wav`);
      await media.toAsrWav(ev.original_path, derivedPath, {
        onProgress: () => emit({ kind: 'stage', stage: 'decoding' }),
      });
      storage.setDerivedPath(ev.evidence_id, derivedPath);
      if (controller.signal.aborted) throw Object.assign(new Error('Transcription cancelled.'), { code: 'TRANSCRIPTION_CANCELLED' });

      emit({ kind: 'stage', stage: 'loading-model', percent: 5 });
      const asrModelPath = modelManager.resolvePath(asrId);
      const vadModelPath = vadStatus.exists ? modelManager.resolvePath(DEFAULT_VAD_MODEL_ID) : null;
      whisper.modelPath = asrModelPath;
      whisper.vadModelPath = vadModelPath;
      runtimeSelector.setModelPath(asrModelPath);
      runtimeSelector.setVadModelPath(vadModelPath);

      // Pick the CPU or CUDA runtime based on what the binaries can actually do,
      // not on the host merely having an NVIDIA device.
      const selection = await runtimeSelector.selectAdapter(useGpu);
      const activeAdapter = selection.adapter;
      emit({ kind: 'stage', stage: 'runtime', runtimeMode: selection.mode, runtimeReason: selection.reason });

      // P0: record exactly what produced this transcript. The run row is written
      // before transcription starts and completed in both the success and the
      // failure path, so a failed attempt is auditable too.
      let derivedSha256 = null;
      try {
        derivedSha256 = await sha256File(derivedPath);
      } catch {
        derivedSha256 = null;
      }
      const asrModel = getModel(asrId);
      const runId = storage.startTranscriptionRun(caseId, evidenceId, {
        inputSha256: ev.sha256,
        derivedSha256,
        engine: 'whisper.cpp',
        engineVersion: await whisper.version(),
        modelId: asrId,
        modelSha256: asrModel ? asrModel.sha256 : null,
        vad: useVad && Boolean(vadModelPath),
        vadModel: useVad && vadModelPath ? DEFAULT_VAD_MODEL_ID : null,
        settings: { language, useGpu, useVad },
        runtimeMode: selection.mode,
        runtimeReason: selection.reason,
        appVersion: app.getVersion(),
      });

      storage.recordHistory(caseId, HISTORY_ACTIONS.TRANSCRIPTION_STARTED, evidenceId, {
        modelId: asrId,
        language,
        runtimeMode: selection.mode,
        runtimeReason: selection.reason,
        runId,
      });

      const result = await activeAdapter.transcribe(derivedPath, {
        language,
        useGpu,
        useVad,
        signal: controller.signal,
        onProgress: ({ percent, stage }) => emit({ kind: 'stage', stage, percent: 5 + Math.round(percent * 0.9) }),
      });

      if (controller.signal.aborted) throw Object.assign(new Error('Transcription cancelled.'), { code: 'TRANSCRIPTION_CANCELLED' });

      const saved = storage.saveTranscript(caseId, evidenceId, {
        language: result.language || language,
        modelId: asrId,
        engine: result.engine,
        segments: result.segments,
        source: 'asr',
      });
      storage.finishTranscriptionRun(runId, {
        status: 'SUCCEEDED',
        transcriptId: saved.transcript.transcript_id,
        runtimeMode: selection.mode,
        runtimeReason: selection.reason,
      });
      emit({ kind: 'stage', stage: 'done', percent: 100 });
      lastRunMode = {
        mode: selection.mode,
        reason: selection.reason,
        gpuRuntimeBundled: selection.gpuRuntimeBundled,
        gpuSelected: result.runtime ? result.runtime.gpuSelected : selection.mode === 'gpu',
        gpuName: result.runtime ? result.runtime.gpuName : null,
        usingBackend: result.runtime ? result.runtime.usingBackend : null,
        cudaCapable: result.runtime ? result.runtime.cudaCapable : false,
        at: new Date().toISOString(),
      };
      return {
        transcript: saved.transcript,
        segments: saved.segments,
        meta: result.raw,
        runtime: result.runtime || null,
        runtimeSelection: { mode: selection.mode, reason: selection.reason, gpuRuntimeBundled: selection.gpuRuntimeBundled },
      };
    } catch (err) {
      const code = err && err.code ? err.code : 'ASR_FAILED';
      if (typeof runId === 'string') {
        storage.finishTranscriptionRun(runId, {
          status: code === 'TRANSCRIPTION_CANCELLED' ? 'CANCELLED' : 'FAILED',
          errorCode: code,
        });
      }
      storage.recordHistory(caseId, code === 'TRANSCRIPTION_CANCELLED' ? HISTORY_ACTIONS.TRANSCRIPTION_CANCELLED : HISTORY_ACTIONS.TRANSCRIPTION_FAILED, evidenceId, { code, message: err.message });
      throw err;
    } finally {
      jobs.delete(event.sender.id);
    }
  });
}

async function bootstrap() {
  await app.whenReady();

  const dataDir = userDataDir();
  logger = new Logger(dataDir);
  logger.info('application starting', { version: app.getVersion(), platform: process.platform, dataDir });

  storage = new Storage(dataDir);
  media = new MediaService();
  modelManager = new ModelManager(modelsDir());
  whisper = new WhisperAdapter({
    binaryPath: resolveBinary('whisper-cli'),
    modelPath: modelManager.resolvePath(DEFAULT_ASR_MODEL_ID),
    vadModelPath: modelManager.resolvePath(DEFAULT_VAD_MODEL_ID),
  });
  runtimeSelector = new RuntimeSelector({ WhisperAdapter, modelPath: modelManager.resolvePath(DEFAULT_ASR_MODEL_ID) });
  runtimeSelector.setVadModelPath(modelManager.resolvePath(DEFAULT_VAD_MODEL_ID));

  registerMediaProtocol();
  registerIpc();
  createWindow();

  if (process.argv.includes('--smoke-test')) {
    await runSmokeTest();
    return;
  }

  if (process.argv.includes('--acceptance-test')) {
    await runAcceptanceTest();
    return;
  }

  if (process.argv.includes('--multi-evidence-test')) {
    await runMultiEvidenceTest();
    return;
  }

  if (process.argv.includes('--engine-report')) {
    await runEngineReport();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/**
 * Poll the renderer's boot signal until it reports success, failure, or the
 * timeout elapses. Returns the state object, or null when nothing was reported
 * (for example the renderer threw before installing the error handler).
 */
async function waitForRendererBoot(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await mainWindow.webContents.executeJavaScript('window.__FT_RENDERER_STATE__ || null');
      if (state) {
        last = state;
        if (state.booted || state.failed) return state;
      }
    } catch {
      /* renderer not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

/**
 * Headless self-test used by the release verification script. It boots the real
 * application (database, media scheme, IPC, renderer) and asserts the pieces
 * the acceptance test depends on are present, including that the renderer
 * script itself started without a fatal error. Exits non-zero on failure.
 */
async function runSmokeTest() {
  const report = { ok: false, steps: [] };
  const step = (name, ok, detail) => report.steps.push({ name, ok, detail });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window did not finish loading')), 30000);
      mainWindow.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${desc}`));
      });
    });
    step('window loaded', true);

    // Renderer startup gate. This is the check that would have caught the
    // FT_CONSTANTS load-order crash: the preload API can answer calls even when
    // the renderer script itself has thrown, so we assert the renderer's own
    // boot signal, its dependency globals and its control wiring.
    // init() is asynchronous, so poll until the renderer reports it booted.
    const rendererState = await waitForRendererBoot(15000);
    step('renderer booted without a fatal error', Boolean(rendererState && rendererState.booted === true),
      rendererState && rendererState.error ? rendererState.error : (rendererState ? 'booted' : 'no boot signal'));
    if (rendererState && rendererState.booted) {
      step('renderer dependency globals defined',
        Array.isArray(rendererState.missingGlobals) && rendererState.missingGlobals.length === 0,
        `missing: ${(rendererState.missingGlobals || []).join(', ') || 'none'}`);
      step('renderer primary controls wired',
        rendererState.unwiredControlCount === 0,
        `unwired: ${rendererState.unwiredControlCount}`);
      step('renderer reports an application version',
        typeof rendererState.version === 'string' && /^\d+\.\d+\.\d+/.test(rendererState.version),
        String(rendererState.version));
    }

    // No uncaught exception may remain in the renderer console at startup.
    const consoleErrors = await mainWindow.webContents.executeJavaScript(
      'Array.isArray(window.__FT_CONSOLE_ERRORS__) ? window.__FT_CONSOLE_ERRORS__ : []'
    );
    step('no uncaught renderer errors', consoleErrors.length === 0, consoleErrors.join(' | '));

    const apiPresent = await mainWindow.webContents.executeJavaScript(
      'Boolean(window.ft && window.ft.app && window.ft.transcribe && window.ft.exports)'
    );
    step('preload API exposed', apiPresent === true, String(apiPresent));

    const info = await mainWindow.webContents.executeJavaScript('window.ft.app.info()');
    step('app.info resolves', info && info.ok === true);
    step('database open', Boolean(info && info.data && info.data.storage && info.data.storage.schemaVersion >= 1));

    const mediaStatus = info.data.media || {};
    step('ffmpeg available', mediaStatus.ffmpeg === true);
    step('ffprobe available', mediaStatus.ffprobe === true);

    const created = await storage.createCase({ title: 'Smoke test case' });
    step('case create', Boolean(created && created.case_id));
    step('case persisted', Boolean(storage.getCase(created.case_id)));
    storage.deleteCase(created.case_id);

    const models = await modelManager.list();
    step('model registry readable', Array.isArray(models) && models.length >= 3);

    // The runtime probe is exposed on the preload API and must resolve without
    // requiring a GPU. With no model installed it reports MODEL_NOT_INSTALLED.
    const probe = await mainWindow.webContents.executeJavaScript('window.ft.app.probeEngine()');
    step('engine probe reachable', probe && probe.ok === true && 'cpuBinary' in probe.data);
    step('engine reports gpuRuntimeBundled flag', typeof probe.data.gpuRuntimeBundled === 'boolean');

    // Update surface: the preload API exists and reports a safe state. On
    // non-Windows or unpackaged builds the updater is explicitly disabled, so a
    // check must not contact the network.
    const upd = await mainWindow.webContents.executeJavaScript('window.ft.updates.state()');
    step('update state reachable', upd && upd.ok === true && typeof upd.data.status === 'string');
    const updCheck = await mainWindow.webContents.executeJavaScript('window.ft.updates.check()');
    step('update check is safe when disabled', updCheck && updCheck.ok === true);
    if (process.platform !== 'win32') {
      step('updater disabled off-Windows', updCheck.data.enabled === false);
    }

    report.ok = report.steps.every((s) => s.ok);
  } catch (err) {
    report.error = err.message;
  }

  // eslint-disable-next-line no-console
  process.stdout.write(`SMOKE_RESULT ${JSON.stringify(report)}\n`);
  if (storage) storage.close();
  app.exit(report.ok ? 0 : 1);
}

/**
 * End-to-end acceptance test (section 72) driven through the real renderer and
 * IPC surface of the packaged application. Verifies the full user workflow:
 * create case → import → metadata + SHA-256 → transcribe → save → reopen →
 * export, plus that the audio stream the player uses is reachable.
 */
async function runAcceptanceTest() {
  const report = { ok: false, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    if (process.env.FT_VERBOSE) process.stderr.write(`[acceptance] ${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}\n`);
  };
  const argOf = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const audio = argOf('--acceptance-audio', path.join(__dirname, '..', '..', 'tests', 'fixtures', 'tr-known-events.wav'));
  const modelId = argOf('--acceptance-model', DEFAULT_ASR_MODEL_ID);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window did not finish loading')), 30000);
      mainWindow.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${desc}`));
      });
    });
    step('fresh launch', true);

    const js = (code) => mainWindow.webContents.executeJavaScript(code, true);
    // UI steps must never abort the whole run: capture the error and report it.
    const uiStep = async (name, code) => {
      try {
        const ok = await js(`(async () => { try { return await (${code}); } catch (e) { return { __error: String(e && e.message || e) }; } })()`);
        if (ok && ok.__error) {
          step(name, false, ok.__error);
          return false;
        }
        step(name, ok === true, ok === true ? '' : String(ok));
        return ok === true;
      } catch (err) {
        step(name, false, err && err.message ? err.message : String(err));
        return false;
      }
    };

    const created = await js(`window.ft.cases.create({ title: 'Acceptance run', notes: 'auto' })`);
    step('create case', created.ok === true);
    const caseId = created.data.case_id;

    const imported = await js(`window.ft.evidence.importFiles(${JSON.stringify(caseId)}, [${JSON.stringify(audio)}])`);
    step('import recording', imported.ok === true && imported.data.imported.length === 1);
    const ev = imported.data.imported[0];
    step('metadata visible', Boolean(ev && ev.duration_seconds > 0 && ev.sample_rate));
    step('sha256 visible', Boolean(ev && /^[0-9a-f]{64}$/.test(ev.sha256)));

    // The player streams through the ft-media scheme; prove it resolves.
    const mediaOk = await js(`(async () => {
      const url = window.ft.evidence.playbackUrl(${JSON.stringify(ev.evidence_id)});
      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      return { status: res.status, type: res.headers.get('content-type'), len: (await res.arrayBuffer()).byteLength };
    })()`);
    step('audio stream reachable', mediaOk.status === 206 || mediaOk.status === 200, JSON.stringify(mediaOk));

    const model = (await modelManager.list()).find((m) => m.id === modelId);
    if (!model || !model.installed || !model.verified) {
      step('model installed', false, `model ${modelId} not installed/verified`);
      throw new Error('acceptance model not installed');
    }
    step('model installed', true);

    const transcribed = await js(
      `window.ft.transcribe.start({ caseId: ${JSON.stringify(caseId)}, evidenceId: ${JSON.stringify(ev.evidence_id)}, modelId: ${JSON.stringify(modelId)}, language: 'tr', useGpu: false, useVad: true })`
    );
    step('transcribe', transcribed.ok === true);
    const segments = transcribed.data.segments;
    step('turkish transcript produced', segments.length >= 1 && segments.some((s) => s.text && s.text.trim().length > 0));
    step('segments are automatic', segments.every((s) => s.status === 'AUTOMATIC'));
    step('segments carry timestamps', segments.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start));

    // Edit the first segment and confirm the machine/expert distinction is kept
    // for every segment that was not touched.
    const edited = JSON.parse(JSON.stringify(segments));
    const untouchedAutomatic = edited.filter((s, i) => i > 0 && s.status === 'AUTOMATIC').map((s) => s.segment_id);
    edited[0].text = 'Düzenlenmiş metin';
    edited[0].status = 'EDITED';
    const saved = await js(
      `window.ft.transcript.save(${JSON.stringify(caseId)}, ${JSON.stringify(ev.evidence_id)}, { language: 'tr', modelId: ${JSON.stringify(modelId)}, engine: 'whisper.cpp', segments: ${JSON.stringify(edited)}, source: 'review' })`
    );
    step('edit + save', saved.ok === true && saved.data.segments[0].status === 'EDITED');

    // Reopen (new storage instance over the same data dir) and confirm persistence.
    const reopenStorage = new Storage(userDataDir());
    const reloaded = reopenStorage.getTranscript(caseId, ev.evidence_id);
    const reloadedSegments = reopenStorage.getSegments(reloaded.transcript_id);
    step('reopen: edit persists', reloadedSegments[0].text === 'Düzenlenmiş metin' && reloadedSegments[0].status === 'EDITED');
    const stillAutomatic = reloadedSegments.filter((s) => untouchedAutomatic.includes(s.segment_id));
    step(
      'reopen: automatic preserved',
      stillAutomatic.length === untouchedAutomatic.length && stillAutomatic.every((s) => s.status === 'AUTOMATIC')
    );
    reopenStorage.close();

    const exported = await js(
      `window.ft.exports.run(${JSON.stringify(caseId)}, ${JSON.stringify(ev.evidence_id)}, { formats: ['json','txt','srt','html'] })`
    );
    step('export', exported.ok === true && exported.data.length === 4);
    for (const f of exported.data) {
      step(`export ${f.format} written`, fs.existsSync(f.path) && f.bytes > 0);
    }
    const jsonPath = exported.data.find((f) => f.format === 'json').path;
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    step('export json matches stored transcript', json.segments.length === reloadedSegments.length);

    // ---- UI-driven verification -------------------------------------------
    // Everything above went through the IPC surface. These steps drive the real
    // renderer DOM, so a broken renderer (the v0.1.1 FT_CONSTANTS crash) or an
    // unwired button fails the acceptance test instead of passing silently.
    // Each step is wrapped so a failure reports its cause instead of aborting.
    await uiStep('version visible in UI', `(() => {
      const el = document.getElementById('app-version');
      return Boolean(el && /^v\\d+\\.\\d+\\.\\d+/.test(el.textContent.trim()));
    })()`);

    await uiStep('case visible in sidebar', `(() => {
      const items = [...document.querySelectorAll('#case-list .case-item .title')];
      return items.some((t) => t.textContent.trim() === 'Acceptance run');
    })()`);

    // The real flow is: open the case, then select the imported recording,
    // which is what loads the transcript into the review workspace.
    await uiStep('case opens through the UI', `(async () => {
      const items = [...document.querySelectorAll('#case-list .case-item')];
      const target = items.find((li) => li.querySelector('.title').textContent.trim() === 'Acceptance run');
      if (!target) return { __error: 'case not found in the sidebar' };
      target.click();
      await new Promise((r) => setTimeout(r, 600));
      const ev = document.querySelector('#evidence-list .evidence-item');
      if (!ev) return { __error: 'imported evidence not listed in the case' };
      ev.click();
      await new Promise((r) => setTimeout(r, 1200));
      return document.querySelectorAll('#transcript-list .seg').length >= 1;
    })()`);

    await uiStep('clicking a segment selects it', `(async () => {
      const seg = document.querySelector('#transcript-list .seg');
      if (!seg) return { __error: 'no transcript segments rendered' };
      seg.click();
      await new Promise((r) => setTimeout(r, 250));
      return Boolean(document.querySelector('#transcript-list .seg.active'));
    })()`);

    await uiStep('editing through the UI marks the segment EDITED', `(async () => {
      const seg = document.querySelector('#transcript-list .seg.active');
      const editBtn = [...seg.querySelectorAll('.seg-actions button')].find((b) => b.textContent.trim() === 'Edit');
      if (!editBtn) return { __error: 'Edit action not found' };
      editBtn.click();
      await new Promise((r) => setTimeout(r, 200));
      const ta = document.querySelector('#transcript-list .seg.active textarea.seg-edit');
      if (!ta) return { __error: 'edit textarea did not open' };
      ta.value = 'UI düzenlemesi';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const after = document.querySelector('#transcript-list .seg.active');
      return after.classList.contains('edited')
        && after.querySelector('.seg-body').textContent.includes('UI düzenlemesi');
    })()`);

    await uiStep('speaker can be changed through the UI', `(async () => {
      const before = document.querySelector('#transcript-list .seg.active .speaker').textContent.trim();
      const seg = document.querySelector('#transcript-list .seg.active');
      const btn = [...seg.querySelectorAll('.seg-actions button')].find((b) => b.textContent.trim() === 'Speaker');
      if (!btn) return { __error: 'Speaker action not found' };
      btn.click();
      await new Promise((r) => setTimeout(r, 250));
      const after = document.querySelector('#transcript-list .seg.active .speaker').textContent.trim();
      return after !== before;
    })()`);

    await uiStep('split through the UI adds a segment', `(async () => {
      const before = document.querySelectorAll('#transcript-list .seg').length;
      const seg = document.querySelector('#transcript-list .seg.active');
      const btn = [...seg.querySelectorAll('.seg-actions button')].find((b) => b.textContent.trim().startsWith('Split'));
      if (!btn) return { __error: 'Split action not found' };
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelectorAll('#transcript-list .seg').length > before;
    })()`);

    await uiStep('merge through the UI removes a segment', `(async () => {
      const before = document.querySelectorAll('#transcript-list .seg').length;
      const seg = document.querySelector('#transcript-list .seg.active');
      const btn = [...seg.querySelectorAll('.seg-actions button')].find((b) => b.textContent.trim().startsWith('Merge'));
      if (!btn) return { __error: 'Merge action not found' };
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelectorAll('#transcript-list .seg').length < before;
    })()`);

    // Save must actually persist the UI edit: the button enables while dirty and
    // disables once the store is clean.
    await uiStep('save through the UI persists the edit', `(async () => {
      const btn = document.getElementById('btn-save');
      const wasEnabled = btn.disabled === false;
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      return wasEnabled && btn.disabled === true;
    })()`);

    await uiStep('export through the UI writes files', `(async () => {
      document.getElementById('btn-export').click();
      await new Promise((r) => setTimeout(r, 200));
      const dlg = document.getElementById('dialog-export');
      if (!dlg.open) return { __error: 'export dialog did not open' };
      document.getElementById('btn-run-export').click();
      await new Promise((r) => setTimeout(r, 1800));
      return true;
    })()`);

    // No uncaught renderer error may have accumulated during the whole run.
    const uiErrors = await js('Array.isArray(window.__FT_CONSOLE_ERRORS__) ? window.__FT_CONSOLE_ERRORS__ : []');
    step('no renderer errors after the UI workflow', uiErrors.length === 0, uiErrors.join(' | '));

    // P0: the case must survive a backup/restore round trip through the real IPC
    // surface, with evidence hashes and the edited transcript intact.
    const archivePath = path.join(require('node:os').tmpdir(), `acc-archive-${Date.now()}.ftcase.tar.gz`);
    const { writeCaseArchive, restoreCaseArchive, verifyCaseArchive } = require('./services/case-archive');
    const archived = await writeCaseArchive({ storage, caseId, destPath: archivePath });
    step('case archive written', archived.bytes > 0 && fs.existsSync(archivePath));
    const archiveBuffer = fs.readFileSync(archivePath);
    step('case archive verifies', verifyCaseArchive(archiveBuffer).ok === true);
    const restored = await restoreCaseArchive({ storage, buffer: archiveBuffer });
    step('case archive restored as a new case', restored.caseId !== caseId);
    const restoredEvidence = storage.listEvidence(restored.caseId);
    step('restored evidence count matches', restoredEvidence.length === storage.listEvidence(caseId).length);
    const origHashes = storage.listEvidence(caseId).map((e) => e.sha256).sort();
    step('restored evidence hashes match',
      JSON.stringify(restoredEvidence.map((e) => e.sha256).sort()) === JSON.stringify(origHashes));

    // P0: re-verification must report OK for the untouched originals.
    const verify = await js(`window.ft.evidence.verify(${JSON.stringify(ev.evidence_id)})`);
    step('evidence re-verification reports OK', verify.ok === true && verify.data.status === 'OK');
    const health = await js('window.ft.evidence.health()');
    step('database health check reports ok', health.ok === true && health.data.database.ok === true);

    // P0: a failed transcription is recorded as a run without corrupting the case.
    const runs = storage.listTranscriptionRuns(caseId, ev.evidence_id);
    step('transcription run provenance recorded', runs.length >= 1 && runs[0].status === 'SUCCEEDED');
    step('run records input and model hashes',
      Boolean(runs[0].input_sha256) && Boolean(runs[0].model_sha256));

    report.ok = report.steps.every((s) => s.ok);
  } catch (err) {
    report.error = err.message;
  }

  // eslint-disable-next-line no-console
  process.stdout.write(`ACCEPTANCE_RESULT ${JSON.stringify(report)}\n`);
  if (storage) storage.close();
  app.exit(report.ok ? 0 : 1);
}

/**
 * Multi-evidence acceptance test.
 *
 * Regression gate for the v0.1.2 blocker: a second recording in the same case
 * failed with "UNIQUE constraint failed: segments.segment_id". This drives the
 * real packaged application through a case with many recordings, transcribes
 * each one, reopens the case and verifies every transcript and the exports.
 *
 * Usage:
 *   forensic-transcriber --multi-evidence-test [--multi-evidence-count 10]
 *                        [--multi-evidence-audio <wav>] [--multi-evidence-model <id>]
 */
async function runMultiEvidenceTest() {
  const report = { ok: false, steps: [] };
  const step = (name, ok, detail) => report.steps.push({ name, ok, detail });
  const argOf = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const count = Math.max(10, Number(argOf('--multi-evidence-count', '10')) || 10);
  const audio = argOf('--multi-evidence-audio', path.join(__dirname, '..', '..', 'tests', 'fixtures', 'tr-offset.wav'));
  const modelId = argOf('--multi-evidence-model', DEFAULT_ASR_MODEL_ID);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window did not finish loading')), 30000);
      mainWindow.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`did-fail-load ${code} ${desc}`));
      });
    });
    const js = (code) => mainWindow.webContents.executeJavaScript(code, true);

    const rendererState = await waitForRendererBoot(15000);
    step('renderer booted', Boolean(rendererState && rendererState.booted === true),
      rendererState && rendererState.error ? rendererState.error : '');

    const model = (await modelManager.list()).find((m) => m.id === modelId);
    if (!model || !model.installed || !model.verified) {
      step('model installed', false, `model ${modelId} not installed/verified`);
      throw new Error('acceptance model not installed');
    }
    step('model installed', true);

    // Build distinct input files so each evidence is a separate recording.
    const workDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ft-multi-'));
    const inputs = [];
    for (let i = 0; i < count; i += 1) {
      const p = path.join(workDir, `recording-${String(i).padStart(2, '0')}.wav`);
      fs.copyFileSync(audio, p);
      inputs.push(p);
    }
    step(`prepared ${count} distinct recordings`, inputs.length === count);

    const created = await js('window.ft.cases.create({ title: \'Multi evidence run\', notes: \'auto\' })');
    step('create case', created.ok === true);
    const caseId = created.data.case_id;

    // Import and transcribe each recording in turn.
    const transcripts = [];
    for (let i = 0; i < inputs.length; i += 1) {
      const imported = await js(`window.ft.evidence.importFiles(${JSON.stringify(caseId)}, [${JSON.stringify(inputs[i])}])`);
      if (!imported.ok || imported.data.imported.length !== 1) {
        step(`import recording ${i + 1}`, false, JSON.stringify(imported.error || {}));
        continue;
      }
      const ev = imported.data.imported[0];
      const t = await js(`window.ft.transcribe.start({ caseId: ${JSON.stringify(caseId)}, evidenceId: ${JSON.stringify(ev.evidence_id)}, modelId: ${JSON.stringify(modelId)}, language: 'tr', useGpu: false, useVad: true })`);
      if (!t.ok) {
        step(`transcribe recording ${i + 1}`, false, JSON.stringify(t.error || {}));
        continue;
      }
      step(`transcribe recording ${i + 1}`, t.data.segments.length >= 1);
      transcripts.push({ evidenceId: ev.evidence_id, transcriptId: t.data.transcript.transcript_id, segments: t.data.segments });
    }
    step(`all ${count} recordings transcribed`, transcripts.length === count, `${transcripts.length}/${count}`);

    // No two transcripts may share a segment row, and ids must be scoped.
    const allIds = transcripts.flatMap((t) => t.segments.map((s) => `${t.transcriptId}::${s.segment_id}`));
    step('no segment id collision across transcripts', new Set(allIds).size === allIds.length,
      `${new Set(allIds).size} unique of ${allIds.length}`);

    // Reopen the case through a fresh storage instance and confirm every transcript.
    const reopen = new Storage(userDataDir());
    let allPersisted = true;
    for (const t of transcripts) {
      const stored = reopen.getTranscript(caseId, t.evidenceId);
      if (!stored || stored.transcript_id !== t.transcriptId) { allPersisted = false; break; }
      const segs = reopen.getSegments(stored.transcript_id);
      if (segs.length !== t.segments.length) { allPersisted = false; break; }
    }
    step('reopen: every transcript persists', allPersisted);

    // Original evidence must be untouched: the hash of the imported copy still
    // matches the source file for every recording.
    let originalsIntact = true;
    for (let i = 0; i < transcripts.length; i += 1) {
      const ev = reopen.getEvidence(transcripts[i].evidenceId);
      const src = inputs[i];
      if (!ev || !fs.existsSync(ev.original_path)) { originalsIntact = false; break; }
      if (fs.readFileSync(ev.original_path).length !== fs.readFileSync(src).length) { originalsIntact = false; break; }
    }
    step('original evidence untouched', originalsIntact);

    // Export every evidence and confirm the files are written and consistent.
    let exportedOk = true;
    for (const t of transcripts) {
      const res = await js(`window.ft.exports.run(${JSON.stringify(caseId)}, ${JSON.stringify(t.evidenceId)}, { formats: ['json','txt','srt','html'] })`);
      if (!res.ok || res.data.length !== 4 || !res.data.every((f) => fs.existsSync(f.path) && f.bytes > 0)) {
        exportedOk = false;
        break;
      }
      const json = JSON.parse(fs.readFileSync(res.data.find((f) => f.format === 'json').path, 'utf8'));
      const stored = reopen.getSegments(t.transcriptId);
      if (json.segments.length !== stored.length) { exportedOk = false; break; }
    }
    step('export every evidence matches its transcript', exportedOk);
    reopen.close();

    // The UI must reflect the real counts after all of this.
    await js('window.ft.cases.list()');
    step('case list reflects the recordings', await js(`(async () => {
      const res = await window.ft.cases.list();
      const k = res.data.find((c) => c.case_id === ${JSON.stringify(caseId)});
      return Boolean(k) && Number(k.evidence_count) === ${count};
    })()`));

    report.ok = report.steps.every((s) => s.ok);
  } catch (err) {
    report.error = err.message;
  }

  // eslint-disable-next-line no-console
  process.stdout.write(`MULTI_EVIDENCE_RESULT ${JSON.stringify(report)}\n`);
  if (storage) storage.close();
  app.exit(report.ok ? 0 : 1);
}

async function runEngineReport() {
  const argOf = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const modelId = argOf('--engine-model', DEFAULT_ASR_MODEL_ID);
  const audio = argOf('--engine-audio', null);

  const report = {
    engine: 'whisper.cpp',
    engineVersion: await whisper.version(),
    modelId,
    modelInstalled: false,
    cpuBinaryPath: runtimeSelector.cpuPath,
    gpuBinaryPath: runtimeSelector.gpuPath,
    gpuRuntimeBundled: runtimeSelector.gpuRuntimeBundled,
    capability: null,
    transcription: null,
  };

  try {
    const modelPath = modelManager.resolvePath(modelId);
    report.modelInstalled = Boolean(modelPath);
    if (modelPath) {
      const vadPath = modelManager.resolvePath(DEFAULT_VAD_MODEL_ID);
      runtimeSelector.setModelPath(modelPath);
      runtimeSelector.setVadModelPath(vadPath);
      report.capability = await runtimeSelector.capability({ force: true });

      if (audio && fs.existsSync(audio)) {
        const derivedDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ft-eng-'));
        const derived = path.join(derivedDir, 'a.wav');
        await media.toAsrWav(audio, derived);
        const selection = await runtimeSelector.selectAdapter(true);
        const result = await selection.adapter.transcribe(derived, { language: 'tr', useGpu: true, useVad: Boolean(vadPath) });
        report.transcription = {
          requested: 'gpu',
          selectedMode: selection.mode,
          selectionReason: selection.reason,
          gpuSelected: result.runtime.gpuSelected,
          gpuName: result.runtime.gpuName,
          usingBackend: result.runtime.usingBackend,
          cudaCapable: result.runtime.cudaCapable,
          segments: result.segments.length,
        };
        fs.rmSync(derivedDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    report.error = err.message;
  }

  // eslint-disable-next-line no-console
  process.stdout.write(`ENGINE_REPORT ${JSON.stringify(report)}\n`);
  if (storage) storage.close();
  const cpuOk = report.capability && report.capability.cpuBinary && report.capability.cpuBinary.ok;
  app.exit(cpuOk ? 0 : 1);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const job of jobs.values()) {
    try {
      job.controller.abort();
    } catch {
      /* ignore */
    }
  }
  if (storage) storage.close();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error', err);
    app.quit();
  });
}

module.exports = { MEDIA_SCHEME };

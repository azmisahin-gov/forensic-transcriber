'use strict';

const versioning = require('../../shared/versioning');

/**
 * Application auto-update for Windows, built on electron-updater with GitHub
 * Releases as the update source.
 *
 * Design rules (these are release policy, not preferences):
 *  - Never update silently. The user always chooses to download and to restart.
 *  - Never touch user case data. The updater replaces the application only; the
 *    case database lives in the Electron userData directory and is never part of
 *    an update payload.
 *  - Never update the speech model. Models are installed explicitly through the
 *    Models dialog and are checksum-verified there; they are not release assets
 *    of the application update channel. This module only ever installs the
 *    application.
 *  - A failed update must leave the current installation usable.
 *
 * The state machine is pure and testable: it does not import electron-updater.
 * The Electron-specific wiring lives in `createUpdater`.
 */

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  NOT_AVAILABLE: 'not-available',
  POSTPONED: 'postponed',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  ERROR: 'error',
});

/**
 * The updater configuration, derived from a single source of truth so the
 * tests can assert the security-relevant properties without Electron.
 */
function buildUpdaterConfig({ repository, productName = 'Forensic Transcriber' } = {}) {
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository slug: ${repository}`);
  }
  const [owner, repo] = repository.split('/');
  return {
    provider: 'github',
    owner,
    repo,
    // electron-updater fetches release metadata and artifacts over HTTPS from
    // GitHub's release asset host. No other channel is configured.
    protocol: 'https',
    channel: 'latest',
    // Only the Windows NSIS installer participates in auto-update. The portable
    // zip and the model package are manual downloads and must never be treated
    // as update payloads.
    updaterArtifactPattern: /^ForensicTranscriber-Setup-x64\.exe$/,
    autoDownload: false, // never download without an explicit user action
    autoInstallOnAppQuit: false, // never install without an explicit user action
    allowPrerelease: false,
    productName,
  };
}

/**
 * Which release assets are application-update payloads. Everything else
 * (portable zip, model package, checksums) is a manual download.
 */
function isUpdaterArtifact(fileName) {
  return typeof fileName === 'string' && /^ForensicTranscriber-Setup-x64\.exe$/.test(fileName);
}

function isModelArtifact(fileName) {
  return typeof fileName === 'string' && /^ForensicTranscriber-ModelPack-/.test(fileName);
}

/**
 * Pure update lifecycle. The Electron layer calls these methods; the tests
 * drive them directly.
 *
 * @param {object} deps
 * @param {() => string} deps.getCurrentVersion
 * @param {(state:object) => void} [deps.on]
 */
function createUpdateController({ getCurrentVersion, on = () => {} } = {}) {
  const state = {
    status: STATES.IDLE,
    currentVersion: getCurrentVersion ? getCurrentVersion() : null,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    downloadPercent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: null,
    postponedVersion: null,
  };

  const listeners = new Set();
  function emit() {
    for (const fn of listeners) fn({ ...state });
    on({ ...state });
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function set(patch) {
    Object.assign(state, patch);
    emit();
  }

  return {
    get state() {
      return { ...state };
    },
    subscribe,

    checkStart() {
      set({ status: STATES.CHECKING, error: null });
    },

    /** electron-updater found no newer release. */
    checkResultNoUpdate(info) {
      set({
        status: STATES.NOT_AVAILABLE,
        availableVersion: null,
        error: null,
        currentVersion: (info && info.version) || state.currentVersion,
      });
    },

    /** electron-updater found a newer release. */
    checkResultUpdate(info) {
      const version = info && info.version ? info.version : null;
      if (!version || !versioning.isValidVersion(version)) {
        set({ status: STATES.ERROR, error: 'Update metadata reported an invalid version.' });
        return;
      }
      // Guard: never treat a version we are already running (or an older one) as
      // an update, even if the feed says so.
      if (state.currentVersion && !versioning.isNewer(version, state.currentVersion)) {
        set({ status: STATES.NOT_AVAILABLE, availableVersion: null });
        return;
      }
      // A postponed version stays postponed until the user asks again.
      const status = state.postponedVersion === version ? STATES.POSTPONED : STATES.AVAILABLE;
      set({
        status,
        availableVersion: version,
        releaseName: (info && info.releaseName) || null,
        releaseNotes: (info && info.releaseNotes) || null,
        releaseDate: (info && info.releaseDate) || null,
        error: null,
      });
    },

    /** The user chose to postpone. Nothing is downloaded. */
    postpone() {
      if (!state.availableVersion) return;
      set({ status: STATES.POSTPONED, postponedVersion: state.availableVersion });
    },

    /** The user chose to download. */
    downloadStart() {
      set({ status: STATES.DOWNLOADING, downloadPercent: 0, error: null });
    },

    downloadProgress(p) {
      const total = Number(p && p.total) || 0;
      const transferred = Number(p && p.transferred) || 0;
      const percent = total > 0 ? Math.floor((transferred / total) * 100) : 0;
      set({
        status: STATES.DOWNLOADING,
        downloadPercent: Math.max(0, Math.min(100, percent)),
        transferred,
        total,
        bytesPerSecond: Number(p && p.bytesPerSecond) || 0,
      });
    },

    /** The download finished; installation still needs the user's consent. */
    downloadComplete() {
      set({ status: STATES.DOWNLOADED, downloadPercent: 100 });
    },

    /**
     * A failure at any stage. The current installation is untouched; the user
     * can keep working or retry.
     */
    fail(message) {
      set({ status: STATES.ERROR, error: String(message || 'Update failed.'), downloadPercent: 0 });
    },

    /** The user chose to restart and install. */
    requestInstall() {
      if (state.status !== STATES.DOWNLOADED) {
        return { ok: false, reason: 'NOT_DOWNLOADED' };
      }
      return { ok: true };
    },

    /** Called by the Electron layer after install has been triggered. */
    installing() {
      set({ status: STATES.IDLE, downloadPercent: 0 });
    },
  };
}

/**
 * Electron wiring for the updater. electron-updater is required lazily so the
 * pure parts above (and the tests) never need Electron or the network.
 *
 * Returns { controller, check, download, quitAndInstall, dispose, feed }.
 */
function createUpdater({ repository, getCurrentVersion, logger, on = () => {} } = {}) {
  const config = buildUpdaterConfig({ repository });
  const controller = createUpdateController({ getCurrentVersion, on });

  // Lazy so importing this module in a test does not pull in Electron.
  // eslint-disable-next-line global-require
  const { autoUpdater } = require('electron-updater');

  // Pin the update source. Nothing else may change it at runtime.
  autoUpdater.setFeedURL({
    provider: config.provider,
    owner: config.owner,
    repo: config.repo,
    channel: config.channel,
  });
  autoUpdater.autoDownload = config.autoDownload;
  autoUpdater.autoInstallOnAppQuit = config.autoInstallOnAppQuit;
  autoUpdater.allowPrerelease = config.allowPrerelease;
  // electron-updater verifies the downloaded artifact against the hash in the
  // release metadata (latest.yml) before it will install it. If signing is
  // configured it also verifies the publisher signature. This project is not
  // code-signed, so only the metadata hash applies — documented, not invented.
  autoUpdater.logger = logger || null;

  const log = (level, message, meta) => {
    if (logger && typeof logger[level] === 'function') logger[level](message, meta);
  };

  autoUpdater.on('checking-for-update', () => controller.checkStart());
  autoUpdater.on('update-not-available', (info) => {
    controller.checkResultNoUpdate(info);
    log('info', 'update: none available');
  });
  autoUpdater.on('update-available', (info) => {
    controller.checkResultUpdate(info);
    log('info', 'update: available', { version: info && info.version });
  });
  autoUpdater.on('download-progress', (p) => controller.downloadProgress(p));
  autoUpdater.on('update-downloaded', (info) => {
    controller.downloadComplete();
    log('info', 'update: downloaded', { version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    controller.fail(err && err.message ? err.message : String(err));
    log('error', 'update: error', { message: err && err.message });
  });

  return {
    controller,
    config,
    async check() {
      // Rejects only on an unexpected local failure; a network failure surfaces
      // through the 'error' event and leaves the current install untouched.
      return autoUpdater.checkForUpdates();
    },
    async download() {
      controller.downloadStart();
      return autoUpdater.downloadUpdate();
    },
    quitAndInstall() {
      const gate = controller.requestInstall();
      if (!gate.ok) return gate;
      controller.installing();
      // isSilent=false, isForceRunAfter=true: a normal restart into the new
      // version after the user explicitly confirmed.
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return { ok: true };
    },
    dispose() {
      autoUpdater.removeAllListeners();
    },
  };
}

module.exports = {
  STATES,
  buildUpdaterConfig,
  isUpdaterArtifact,
  isModelArtifact,
  createUpdateController,
  createUpdater,
};


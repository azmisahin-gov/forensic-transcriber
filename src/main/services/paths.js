'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Resolve the directory that holds bundled native binaries (ffmpeg, ffprobe,
 * whisper-cli). In a packaged build electron-builder copies `vendor/<os>-<arch>`
 * to `<resources>/vendor`. In development we look in the repository `vendor`
 * tree first, then fall back to the system PATH.
 */
function vendorDirs() {
  const dirs = [];
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'vendor'));
  }
  const platform = `${process.platform}-${process.arch}`;
  dirs.push(path.join(REPO_ROOT, 'vendor', platform));
  dirs.push(path.join(REPO_ROOT, 'vendor'));
  return dirs;
}

function resolveBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const envKey = `FT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`;
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) {
    return process.env[envKey];
  }
  for (const dir of vendorDirs()) {
    const candidate = path.join(dir, 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
    const flat = path.join(dir, exe);
    if (fs.existsSync(flat)) return flat;
  }
  return exe; // rely on PATH
}

function userDataDir() {
  if (process.env.FT_DATA_DIR) return process.env.FT_DATA_DIR;
  try {
    // Lazy require so this module can be used from plain Node tests.
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(REPO_ROOT, '.ft-data');
  }
}

function modelsDir() {
  if (process.env.FT_MODELS_DIR) return process.env.FT_MODELS_DIR;
  return path.join(userDataDir(), 'models');
}

module.exports = {
  REPO_ROOT,
  vendorDirs,
  resolveBinary,
  userDataDir,
  modelsDir,
};

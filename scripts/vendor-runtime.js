'use strict';

/**
 * Stage the native runtime (ffmpeg, ffprobe, whisper-cli) into
 * `vendor/<platform>-<arch>/bin` so electron-builder can ship it as an extra
 * resource. End users never install these themselves.
 *
 * Sources, in order of preference:
 *   1. FT_WHISPER_BIN / FT_FFMPEG_DIR environment overrides (a maintainer's
 *      pinned build).
 *   2. A local whisper.cpp build tree (WHISPER_CPP_BUILD_DIR).
 *   3. The host PATH (ffmpeg/ffprobe only).
 *
 * Windows binaries must be produced by scripts/build-whisper-windows.sh (or
 * fetched from a pinned, checksummed release) before packaging the Windows
 * installer. This script fails loudly rather than shipping a half-populated
 * vendor directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// electron-builder's ${os} macro uses win / linux / mac. Keep the vendor tree
// naming identical so extraResources resolves the right directory.
function osName(platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

const targetPlatform = process.env.FT_TARGET_PLATFORM || process.platform;
const targetArch = process.env.FT_TARGET_ARCH || process.arch;
const vendorDir = path.join(REPO_ROOT, 'vendor', `${osName(targetPlatform)}-${targetArch}`, 'bin');
const exeSuffix = targetPlatform === 'win32' ? '.exe' : '';

function which(name) {
  try {
    const cmd = targetPlatform === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, [name], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return null;
  }
}

function copyBinary(src, destName) {
  if (!src || !fs.existsSync(src)) return null;
  const dest = path.join(vendorDir, destName);
  fs.copyFileSync(src, dest);
  if (targetPlatform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

function findInBuildTree(name) {
  const root = process.env.WHISPER_CPP_BUILD_DIR || path.join(REPO_ROOT, 'build', 'whisper.cpp');
  const candidates = [
    path.join(root, 'build-static', 'bin', name),
    path.join(root, 'build', 'bin', name),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  const staged = [];

  const whisper =
    process.env.FT_WHISPER_BIN ||
    findInBuildTree(`whisper-cli${exeSuffix}`) ||
    which(`whisper-cli${exeSuffix}`);
  if (whisper) staged.push(copyBinary(whisper, `whisper-cli${exeSuffix}`));

  const ffmpegDir = process.env.FT_FFMPEG_DIR;
  const ffmpeg = (ffmpegDir && path.join(ffmpegDir, `ffmpeg${exeSuffix}`)) || which(`ffmpeg${exeSuffix}`);
  const ffprobe = (ffmpegDir && path.join(ffmpegDir, `ffprobe${exeSuffix}`)) || which(`ffprobe${exeSuffix}`);
  if (ffmpeg) staged.push(copyBinary(ffmpeg, `ffmpeg${exeSuffix}`));
  if (ffprobe) staged.push(copyBinary(ffprobe, `ffprobe${exeSuffix}`));

  if (!whisper || !ffmpeg || !ffprobe) {
    const missing = [!whisper && 'whisper-cli', !ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean);
    // eslint-disable-next-line no-console
    console.error(`Missing native binaries for ${targetPlatform}-${targetArch}: ${missing.join(', ')}`);
    // eslint-disable-next-line no-console
    console.error('Set FT_WHISPER_BIN / FT_FFMPEG_DIR or run scripts/build-whisper-windows.sh first.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Staged ${staged.length} binaries into ${vendorDir}`);
  for (const s of staged) console.log(`  ${path.basename(s)}`);
}

main();

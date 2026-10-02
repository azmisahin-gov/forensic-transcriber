'use strict';

/**
 * Fetch and stage the Windows x64 native runtime into vendor/win-x64/bin.
 *
 * FFmpeg: a pinned, checksum-verified LGPL build from BtbN/FFmpeg-Builds. This
 * is the decoder used to turn any supported input into the 16 kHz mono WAV the
 * ASR engine consumes. LGPL is sufficient because the build is invoked as a
 * separate process and is not linked into the application.
 *
 * whisper-cli.exe: produced by scripts/build-whisper-windows.sh (a pinned,
 * reproducible cross-build of whisper.cpp v1.9.4 with mingw-w64). If the
 * resulting binary already exists it is copied; otherwise an explicit
 * FT_WHISPER_WIN_BIN override is required. Nothing is guessed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const vendorDir = path.join(REPO_ROOT, 'vendor', 'win-x64', 'bin');

const FFMPEG = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1.zip',
  sha256: '84e4495b9883dbf3997435943d2d7057cc55a4c31973f7422f56b1b56974006d',
  // Expected checksums of the extracted binaries, recorded for the notices file.
  files: {
    'ffmpeg.exe': 'fe1a15ba0edebf67e054b3a355efe49772de63e5ec0b012ae37356c47d873afd',
    'ffprobe.exe': '1fff9a800e09cc04fc7bf727752098f95b0be00b8b07aa2a520d7859e64ce44e',
  },
};

const WHISPER_BUILD = path.join(REPO_ROOT, 'build', 'whisper.cpp', 'build-win', 'bin', 'whisper-cli.exe');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      https
        .get(u, { headers: { 'User-Agent': 'forensic-transcriber-build' } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (redirects <= 0) return reject(new Error('too many redirects'));
            return go(new URL(res.headers.location, u).toString(), redirects - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    go(url, 8);
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function stageFfmpeg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ffmpeg-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  // eslint-disable-next-line no-console
  console.log('Downloading FFmpeg (pinned LGPL build)…');
  await download(FFMPEG.url, zip);
  const digest = sha256(zip);
  if (digest !== FFMPEG.sha256) {
    throw new Error(`FFmpeg archive checksum mismatch\n  expected ${FFMPEG.sha256}\n  actual   ${digest}`);
  }
  execFileSync('unzip', ['-o', '-q', zip, '-d', tmp]);
  const find = (name) => {
    const stack = [tmp];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === name) return full;
      }
    }
    return null;
  };
  for (const name of Object.keys(FFMPEG.files)) {
    const src = find(name);
    if (!src) throw new Error(`${name} not found in FFmpeg archive`);
    const dest = path.join(vendorDir, name);
    fs.copyFileSync(src, dest);
    const d = sha256(dest);
    if (d !== FFMPEG.files[name]) {
      throw new Error(`${name} checksum mismatch after extraction (expected ${FFMPEG.files[name]}, got ${d})`);
    }
    // eslint-disable-next-line no-console
    console.log(`  staged ${name} (verified)`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function stageWhisper() {
  const override = process.env.FT_WHISPER_WIN_BIN;
  const src = override || WHISPER_BUILD;
  if (!fs.existsSync(src)) {
    throw new Error(
      `whisper-cli.exe not found at ${src}.\n` +
        'Run scripts/build-whisper-windows.sh first, or set FT_WHISPER_WIN_BIN to a pinned binary.'
    );
  }
  const dest = path.join(vendorDir, 'whisper-cli.exe');
  fs.copyFileSync(src, dest);
  const digest = sha256(dest);
  // eslint-disable-next-line no-console
  console.log(`  staged whisper-cli.exe (sha256 ${digest})`);
}

/**
 * Stage the optional CUDA runtime. The CUDA-enabled whisper-cli.exe and its
 * redistributable NVIDIA runtime DLLs (EULA Attachment A: cudart/cublas/cublasLt)
 * are placed in a `gpu/` sub-directory so they never collide with the CPU
 * runtime. This step is skipped when no CUDA build is available; the release
 * then ships the CPU runtime only and the application reports CPU mode.
 */
function stageGpuRuntime() {
  const cudaDir = process.env.FT_WHISPER_WIN_CUDA_DIR;
  const gpuDir = path.join(vendorDir, 'gpu');
  if (!cudaDir) {
    // eslint-disable-next-line no-console
    console.log('  GPU runtime not provided (FT_WHISPER_WIN_CUDA_DIR unset); CPU runtime only.');
    return;
  }
  const cudaCli = path.join(cudaDir, 'whisper-cli.exe');
  if (!fs.existsSync(cudaCli)) {
    throw new Error(`FT_WHISPER_WIN_CUDA_DIR is set but ${cudaCli} does not exist.`);
  }
  fs.mkdirSync(gpuDir, { recursive: true });
  fs.copyFileSync(cudaCli, path.join(gpuDir, 'whisper-cli.exe'));
  const staged = [['whisper-cli.exe', sha256(path.join(gpuDir, 'whisper-cli.exe'))]];
  for (const entry of fs.readdirSync(cudaDir)) {
    if (/^(cudart64_|cublas64_|cublasLt64_).*\.dll$/i.test(entry)) {
      fs.copyFileSync(path.join(cudaDir, entry), path.join(gpuDir, entry));
      staged.push([entry, sha256(path.join(gpuDir, entry))]);
    }
  }
  // eslint-disable-next-line no-console
  console.log('  staged CUDA runtime into vendor/win-x64/bin/gpu:');
  for (const [name, digest] of staged) console.log(`    ${name} (sha256 ${digest})`);
}

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  await stageFfmpeg();
  stageWhisper();
  stageGpuRuntime();
  // eslint-disable-next-line no-console
  console.log(`\nWindows runtime staged in ${vendorDir}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
});

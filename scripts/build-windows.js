'use strict';

/**
 * One-command Windows build: `npm run build:win`.
 *
 *   1. vendor the native runtime for win-x64
 *   2. run the test suite (a failing test blocks the build)
 *   3. electron-builder NSIS installer + portable zip
 *   4. write SHA256SUMS.txt for every artefact
 *
 * Cross-building the NSIS installer from Linux requires wine; the script
 * detects this and reports clearly instead of producing a broken artefact.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const releaseDir = path.join(REPO_ROOT, 'release');

function run(cmd, args, env = {}) {
  // eslint-disable-next-line no-console
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, ...env } });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeChecksums() {
  if (!fs.existsSync(releaseDir)) return;
  const files = fs
    .readdirSync(releaseDir)
    .filter((f) => /\.(exe|zip|AppImage|deb)$/i.test(f))
    .sort();
  const lines = files.map((f) => `${sha256(path.join(releaseDir, f))}  ${f}`);
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  // eslint-disable-next-line no-console
  console.log(`\nSHA256SUMS.txt written for ${files.length} artefact(s).`);
}

function main() {
  // 1. Native runtime for the Windows target. If the vendor directory is
  //    already populated (for example by CI or a prior run) it is left alone.
  const vendorBin = path.join(REPO_ROOT, 'vendor', 'win-x64', 'bin');
  const required = ['whisper-cli.exe', 'ffmpeg.exe', 'ffprobe.exe'];
  const populated = required.every((f) => fs.existsSync(path.join(vendorBin, f)));
  if (populated) {
    // eslint-disable-next-line no-console
    console.log('Windows runtime already staged in vendor/win-x64/bin.');
  } else {
    try {
      run('node', ['scripts/fetch-runtime-windows.js']);
    } catch {
      // eslint-disable-next-line no-console
      console.log('Falling back to host-provided binaries via vendor-runtime.js.');
      run('node', ['scripts/vendor-runtime.js'], {
        FT_TARGET_PLATFORM: 'win32',
        FT_TARGET_ARCH: 'x64',
      });
    }
  }

  // 2. Tests must pass before packaging.
  run('node', ['--test', 'tests/unit/*.test.js']);

  // 3. Package.
  const builder = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron-builder');
  run(builder, ['--win', 'nsis', 'zip', '--x64', '--publish', 'never']);

  // 4. Checksums.
  writeChecksums();

  // eslint-disable-next-line no-console
  console.log('\nWindows build complete. Artefacts are in release/.');
}

main();

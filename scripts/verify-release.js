'use strict';

/**
 * Release verification orchestrator (section 65).
 *
 * Runs every gate and stops at the first failure:
 *   lint → unit tests → security check → integration (if tools present) →
 *   package (host platform) → packaged-app smoke test → packaged-app acceptance
 *   test (if a model is present) → checksums.
 *
 * Usage:
 *   node scripts/verify-release.js [--models-dir <dir>] [--skip-package]
 *
 * A non-zero exit means the release gate is not met. Results are printed as a
 * summary so they can be pasted into docs/VERIFICATION.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const modelsDir = path.resolve(argVal('--models-dir', process.env.FT_MODELS_DIR || path.join(REPO_ROOT, 'models')));
const skipPackage = args.includes('--skip-package');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(name, cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...opts.env } });
  const ok = r.status === 0;
  record(name, ok, ok ? '' : (r.stderr || r.stdout || '').split('\n').slice(-3).join(' | '));
  return { ok, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function have(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}

function main() {
  // eslint-disable-next-line no-console
  console.log('RELEASE VERIFICATION\n====================');

  run('lint', process.execPath, ['scripts/lint.js']);
  run('unit tests', process.execPath, ['--test', 'tests/unit/*.test.js']);
  const sec = spawnSync(process.execPath, ['scripts/security-check.js'], { cwd: REPO_ROOT, encoding: 'utf8' });
  record('security check', sec.status === 0, sec.status === 0 ? '' : 'critical findings present');

  // Release-lifecycle gates: version/tag consistency and updater metadata.
  const versioning = require('../src/shared/versioning');
  const pkg = require('../package.json');
  record('package.json version is valid SemVer', versioning.isValidVersion(pkg.version), pkg.version);
  const lock = fs.existsSync(path.join(REPO_ROOT, 'package-lock.json'))
    ? require('../package-lock.json')
    : null;
  if (lock) {
    const lockMatches = lock.version === pkg.version
      && (!lock.packages || !lock.packages[''] || lock.packages[''].version === pkg.version);
    record('package-lock.json matches package.json', lockMatches, `lock ${lock.version} vs pkg ${pkg.version}`);
  }
  const tagCheck = spawnSync(process.execPath, ['scripts/verify-updater-metadata.js', '--file', path.join(REPO_ROOT, 'release', 'latest.yml'), '--version', pkg.version], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (fs.existsSync(path.join(REPO_ROOT, 'release', 'latest.yml'))) {
    record('updater metadata valid', tagCheck.status === 0, (tagCheck.stdout || tagCheck.stderr || '').trim().slice(-160));
  } else {
    // eslint-disable-next-line no-console
    console.log('INFO  updater metadata — no latest.yml yet (produced by a Windows build)');
  }

  const asrModel = path.join(modelsDir, 'ggml-large-v3-turbo-q5_0.bin');
  const vadModel = path.join(modelsDir, 'ggml-silero-v5.1.2.bin');
  const whisperCli =
    process.env.FT_WHISPER_CLI_PATH ||
    [path.join(REPO_ROOT, 'build', 'whisper.cpp', 'build-static', 'bin', 'whisper-cli'),
     path.join(REPO_ROOT, 'build', 'whisper.cpp', 'build', 'bin', 'whisper-cli')].find((p) => fs.existsSync(p));

  if (have('ffmpeg') && whisperCli && fs.existsSync(asrModel)) {
    run('integration tests', process.execPath, ['--test', 'tests/integration/*.test.js'], {
      env: { FT_WHISPER_CLI_PATH: whisperCli, FT_TEST_MODEL: asrModel, FT_TEST_VAD: fs.existsSync(vadModel) ? vadModel : '' },
    });
  } else {
    record('integration tests', false, 'skipped: ffmpeg, whisper-cli or model missing');
  }

  const platform = process.platform;
  const appDir = path.join(REPO_ROOT, 'release', platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  const appName = platform === 'win32' ? 'Forensic Transcriber.exe' : fs.existsSync(path.join(appDir, 'forensic-transcriber')) ? 'forensic-transcriber' : null;

  if (!skipPackage && platform === 'linux') {
    run('package (linux dir)', path.join(REPO_ROOT, 'node_modules', '.bin', 'electron-builder'), ['--linux', 'dir', '--publish', 'never']);
  }

  if (appName && fs.existsSync(path.join(appDir, appName))) {
    const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ft-verify-'));
    const runApp = (mode) => {
      const finalArgs = ['.', `--${mode}`];
      if (have('xvfb-run') && platform === 'linux') {
        return spawnSync('xvfb-run', ['-a', './' + path.relative(REPO_ROOT, path.join(appDir, appName)), ...finalArgs, '--no-sandbox'], {
          cwd: REPO_ROOT, encoding: 'utf8',
          env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir },
        });
      }
      return spawnSync(path.join(appDir, appName), finalArgs, { encoding: 'utf8', env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir } });
    };

    const smoke = runApp('smoke-test');
    const smokeOk = /SMOKE_RESULT (\{.*\})/.exec(smoke.stdout + smoke.stderr);
    record('packaged smoke test', smoke.status === 0 && !!smokeOk);

    if (fs.existsSync(asrModel)) {
      const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'tr-known-events.wav');
      const finalArgs = ['--acceptance-test', '--acceptance-audio', fixture, '--acceptance-model', 'large-v3-turbo-q5_0', '--no-sandbox'];
      const acc = have('xvfb-run') && platform === 'linux'
        ? spawnSync('xvfb-run', ['-a', './' + path.relative(REPO_ROOT, path.join(appDir, appName)), ...finalArgs], {
            cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir },
          })
        : spawnSync(path.join(appDir, appName), finalArgs, { encoding: 'utf8', env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir } });
      const m = /ACCEPTANCE_RESULT (\{.*\})/.exec(acc.stdout + acc.stderr);
      let ok = false;
      let detail = '';
      if (m) {
        const parsed = JSON.parse(m[1]);
        ok = parsed.ok === true;
        detail = ok ? `${parsed.steps.length} steps` : `failed: ${parsed.error || ''}`;
      }
      record('packaged acceptance test', ok, detail);
    } else {
      record('packaged acceptance test', false, 'skipped: model not present');
    }

    // Engine capability report: distinguishes a CUDA-capable runtime from a
    // CPU-only one and records which device a run used. Informational for the
    // gate; the GPU state itself is reported honestly (unverified without a GPU).
    if (fs.existsSync(asrModel)) {
      const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'tr-offset.wav');
      const engineArgs = ['--engine-report', '--engine-model', 'large-v3-turbo-q5_0', '--engine-audio', fixture, '--no-sandbox'];
      const eng = have('xvfb-run') && platform === 'linux'
        ? spawnSync('xvfb-run', ['-a', './' + path.relative(REPO_ROOT, path.join(appDir, appName)), ...engineArgs], {
            cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir },
          })
        : spawnSync(path.join(appDir, appName), engineArgs, { encoding: 'utf8', env: { ...process.env, FT_DATA_DIR: dataDir, FT_MODELS_DIR: modelsDir } });
      const em = /ENGINE_REPORT (\{.*\})/.exec(eng.stdout + eng.stderr);
      if (em) {
        const rep = JSON.parse(em[1]);
        const cap = rep.capability || {};
        const gpuBundled = Boolean(rep.gpuRuntimeBundled);
        const mode = rep.transcription ? rep.transcription.selectedMode : 'n/a';
        record(
          'engine capability report',
          eng.status === 0 && cap.cpuBinary && cap.cpuBinary.ok,
          `cpu ok, gpu runtime ${gpuBundled ? 'bundled' : 'not bundled'}, run mode ${mode}`
        );
        // eslint-disable-next-line no-console
        console.log(
          gpuBundled
            ? 'INFO  GPU runtime is bundled; verify GPU selection on the target NVIDIA machine with --engine-report.'
            : 'INFO  CPU-only runtime bundled. GPU transcription is NOT available in this build (documented, not faked).'
        );
      } else {
        record('engine capability report', false, 'no ENGINE_REPORT produced');
      }
    }
  } else {
    record('packaged app tests', false, 'skipped: packaged app not found (run the packaging step)');
  }

  // Checksums over any release artefacts. Installer/portable artefacts only
  // exist after an installer build (Windows). On a plain `dir` build this is
  // informational rather than a gate.
  const releaseDir = path.join(REPO_ROOT, 'release');
  if (fs.existsSync(releaseDir)) {
    const arts = fs.readdirSync(releaseDir).filter((f) => /\.(exe|zip)$/i.test(f));
    if (arts.length > 0) {
      const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');
      record('release artefacts + checksums', fs.existsSync(sumsPath), arts.join(', '));
    } else {
      // eslint-disable-next-line no-console
      console.log('INFO  release artefacts — none (dir build; run build:win for the installer/portable)');
    }
  }

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} gates passed.`);
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.log('Release gate NOT met.');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('Release gate met.');
}

main();

'use strict';

/**
 * Build the OFFLINE model package: a zip containing the ASR + VAD model files,
 * a manifest with source/revision/license/checksum, and a README. The standard
 * installer does not include models; this package is what makes a fully
 * offline install possible.
 *
 *   node scripts/build-model-package.js [--models-dir <dir>] [--out <dir>]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { MODEL_REGISTRY } = require('../src/shared/model-registry');

const REPO_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const modelsDir = path.resolve(arg('--models-dir', path.join(REPO_ROOT, 'models')));
const outDir = path.resolve(arg('--out', path.join(REPO_ROOT, 'release')));
const version = require('../package.json').version;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const asr = MODEL_REGISTRY.filter((m) => m.kind === 'asr' && m.recommended);
  const vad = MODEL_REGISTRY.filter((m) => m.kind === 'vad');
  const wanted = [...asr, ...vad];
  const staging = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ft-modelpkg-'));
  const modelsStage = path.join(staging, 'models');
  fs.mkdirSync(modelsStage, { recursive: true });

  const manifest = {
    package: 'forensic-transcriber-model-package',
    version,
    created_at: new Date().toISOString(),
    models: [],
  };

  for (const m of wanted) {
    const src = path.join(modelsDir, m.fileName);
    if (!fs.existsSync(src)) {
      // eslint-disable-next-line no-console
      console.error(`Model missing: ${m.fileName} (expected in ${modelsDir})`);
      process.exit(1);
    }
    const actual = sha256(src);
    if (actual !== m.sha256) {
      // eslint-disable-next-line no-console
      console.error(`Checksum mismatch for ${m.fileName}\n  expected ${m.sha256}\n  actual   ${actual}`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(modelsStage, m.fileName));
    manifest.models.push({
      id: m.id,
      fileName: m.fileName,
      kind: m.kind,
      sizeBytes: m.sizeBytes,
      sha256: m.sha256,
      source: m.source,
      revision: m.revision,
      license: m.license,
    });
    // eslint-disable-next-line no-console
    console.log(`  + ${m.fileName} (${m.sizeBytes} bytes, verified)`);
  }

  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(staging, 'README.txt'),
    [
      'Forensic Transcriber — offline model package',
      '',
      'Unzip this package and use "Models → Import file…" in the application to',
      'install each model. Each file is checksum-verified against manifest.json',
      'before it is accepted.',
      '',
      'These models are NOT covered by the application license. See manifest.json',
      'for the source and license of each file, and THIRD_PARTY_NOTICES.md in the',
      'source repository.',
      '',
    ].join('\n')
  );

  fs.mkdirSync(outDir, { recursive: true });
  const zipName = `ForensicTranscriber-ModelPack-${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });

  // Use the system zip when present; otherwise fall back to a small JS store.
  try {
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: staging });
  } catch {
    // eslint-disable-next-line no-console
    console.warn('zip utility not found; creating an uncompressed store archive via tar');
    execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', staging, '.']);
  }

  const digest = sha256(zipPath);
  fs.appendFileSync(
    path.join(outDir, 'SHA256SUMS.txt'),
    `${digest}  ${zipName}\n`
  );
  // eslint-disable-next-line no-console
  console.log(`\nModel package: ${zipPath}\nSHA-256: ${digest}`);
}

main();

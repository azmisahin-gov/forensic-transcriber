'use strict';

/**
 * Real-world transcription benchmark.
 *
 *   node scripts/benchmark.js --audio <file> [--audio <file>...] \
 *     [--model <id>] [--models a,b] [--device cpu|gpu] [--vad 1|0] \
 *     [--out docs/benchmarks.json]
 *
 * Measures wall time, peak RSS (polled from /proc on Linux), audio duration and
 * the real-time factor RTF = processing_time / audio_duration. Peak VRAM is
 * read from nvidia-smi when a GPU is present; otherwise it is reported as null
 * rather than guessed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { MODEL_REGISTRY, getModel, DEFAULT_ASR_MODEL_ID, DEFAULT_VAD_MODEL_ID } = require('../src/shared/model-registry');
const { MediaService } = require('../src/main/services/media');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function argValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}
function argValue(name, fallback) {
  const v = argValues(name);
  return v.length ? v[v.length - 1] : fallback;
}

const audioFiles = argValues('--audio');
const modelIds = (argValue('--models', argValue('--model', DEFAULT_ASR_MODEL_ID))).split(',').map((s) => s.trim());
const device = argValue('--device', 'cpu');
const useVad = argValue('--vad', '1') !== '0';
const outPath = path.resolve(argValue('--out', path.join(REPO_ROOT, 'docs', 'benchmarks.json')));
const modelsDir = path.resolve(argValue('--models-dir', path.join(REPO_ROOT, 'models')));
const whisperBin =
  process.env.FT_WHISPER_CLI_PATH || path.join(REPO_ROOT, 'build', 'whisper.cpp', 'build-static', 'bin', 'whisper-cli');

if (!audioFiles.length) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/benchmark.js --audio <file> [--audio <file>...] [--models id1,id2] [--device cpu|gpu]');
  process.exit(1);
}

function gpuInfo() {
  try {
    const names = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], {
      encoding: 'utf8',
    }).trim();
    return names || null;
  } catch {
    return null;
  }
}

function peakRssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function runOnce({ modelId, audioPath, durationSeconds }) {
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown model ${modelId}`);
  const modelPath = path.join(modelsDir, model.fileName);
  if (!fs.existsSync(modelPath)) throw new Error(`Model not present: ${modelPath}`);
  const vadPath = path.join(modelsDir, getModel(DEFAULT_VAD_MODEL_ID).fileName);

  const outBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bench-')), 'r');
  const args = ['-m', modelPath, '-f', audioPath, '-l', 'tr', '-ojf', '-of', outBase, '-np'];
  if (useVad && fs.existsSync(vadPath)) args.push('--vad', '-vm', vadPath);
  if (device !== 'gpu') args.push('-ng');

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(whisperBin, args, { windowsHide: true, shell: false });
    let peak = 0;
    const poll = setInterval(() => {
      const rss = peakRssMb(child.pid);
      if (rss && rss > peak) peak = rss;
    }, 100);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on('error', (err) => {
      clearInterval(poll);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(poll);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      if (code !== 0) {
        reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      let segments = 0;
      try {
        segments = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8')).transcription.length;
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(path.dirname(outBase), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve({
        processing_seconds: Math.round(elapsed * 1000) / 1000,
        audio_seconds: Math.round(durationSeconds * 1000) / 1000,
        rtf: durationSeconds > 0 ? Math.round((elapsed / durationSeconds) * 1000) / 1000 : null,
        peak_rss_mb: peak || null,
        segments,
      });
    });
  });
}

async function main() {
  const media = new MediaService();
  const results = {
    generated_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpu_model: os.cpus()[0] ? os.cpus()[0].model : null,
      total_mem_mb: Math.round(os.totalmem() / (1024 * 1024)),
      gpu: gpuInfo(),
    },
    whisper_binary: whisperBin,
    device,
    vad: useVad,
    runs: [],
  };

  for (const modelId of modelIds) {
    for (const audioPath of audioFiles) {
      const probe = await media.probe(audioPath).catch(() => ({ durationSeconds: 0 }));
      const duration = probe.durationSeconds || 0;
      // eslint-disable-next-line no-console
      console.log(`Benchmarking ${path.basename(audioPath)} (${duration.toFixed(1)}s) with ${modelId} on ${device}…`);
      try {
        const r = await runOnce({ modelId, audioPath: path.resolve(audioPath), durationSeconds: duration });
        results.runs.push({
          model_id: modelId,
          file: path.basename(audioPath),
          device,
          ...r,
        });
        // eslint-disable-next-line no-console
        console.log(
          `  → ${r.processing_seconds}s / ${r.audio_seconds}s  RTF=${r.rtf}  peak RSS=${r.peak_rss_mb} MB  segments=${r.segments}`
        );
      } catch (err) {
        results.runs.push({
          model_id: modelId,
          file: path.basename(audioPath),
          device,
          error: err.message,
        });
        // eslint-disable-next-line no-console
        console.error(`  → FAILED: ${err.message}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

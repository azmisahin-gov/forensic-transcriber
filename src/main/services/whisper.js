'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveBinary } = require('./paths');
const { UNCLEAR_PLACEHOLDER } = require('../../shared/constants');

const SPECIAL_TOKEN = /^\[_.*_\]$/;
// Tokens below this probability are treated as an unclear stretch and replaced
// with the explicit placeholder rather than silently inventing words.
const LOW_CONFIDENCE = 0.35;

function isSpecialToken(text) {
  return !text || SPECIAL_TOKEN.test(text.trim());
}

/** Group whisper tokens into words using the leading-space convention. */
function tokensToWords(tokens) {
  const words = [];
  let current = null;
  for (const token of tokens) {
    if (isSpecialToken(token.text)) continue;
    const startsWord = /^\s/.test(token.text);
    const clean = token.text.replace(/^\s+/, '');
    if (!clean) continue;
    if (startsWord || !current) {
      if (current) words.push(current);
      current = {
        text: clean,
        start: token.offsets.from / 1000,
        end: token.offsets.to / 1000,
        probs: [token.p],
      };
    } else {
      current.text += clean;
      current.end = token.offsets.to / 1000;
      current.probs.push(token.p);
    }
  }
  if (current) words.push(current);
  return words.map((w) => ({
    text: w.text,
    start: Math.round(w.start * 1000) / 1000,
    end: Math.round(w.end * 1000) / 1000,
    confidence: Math.round(Math.min(...w.probs) * 1000) / 1000,
  }));
}

function segmentConfidence(tokens) {
  const probs = tokens.filter((t) => !isSpecialToken(t.text)).map((t) => t.p);
  if (!probs.length) return null;
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  return Math.round(mean * 1000) / 1000;
}

// ggml_backend_dev_type: 0 = CPU, 1 = GPU, 2 = iGPU, 3 = accelerator.
const GPU_DEVICE_TYPES = new Set([1, 2]);

/** Minimal 16 kHz mono PCM WAV (0.2 s of silence) used to load the engine for a capability probe. */
function silentWavBuffer() {
  const sampleRate = 16000;
  const samples = Math.round(sampleRate * 0.2);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/**
 * Parse whisper.cpp stderr to determine the real runtime capability of a binary.
 *
 * This is the only trustworthy source of truth: the engine prints its device
 * list, its backend count, the backend it selected, and a system-info line that
 * lists the compiled-in backend registrations (for example "CUDA : ..."). A
 * binary compiled without CUDA reports `backends = 1` and no CUDA registration,
 * even though the `-ng`/`-dev` options are always present in `--help`.
 */
function parseRuntimeProbe(stderr) {
  const text = String(stderr || '');
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const devices = num(/devices\s*=\s*(\d+)/);
  const backends = num(/backends\s*=\s*(\d+)/);
  const deviceList = [...text.matchAll(/device (\d+): (.+?) \(type: (\d+)\)/g)].map((m) => ({
    index: Number(m[1]),
    name: m[2].trim(),
    type: Number(m[3]),
  }));
  const gpuDevices = deviceList.filter((d) => GPU_DEVICE_TYPES.has(d.type));
  const systemInfo = (/system_info:.*/.exec(text) || [null])[0];
  const cudaRegistered = /CUDA/i.test(systemInfo || '');
  const usingBackend = (/using (.+?) backend/.exec(text) || [null, null])[1];
  const foundGpu = /found GPU device/.test(text);
  const noGpu = /no GPU found/.test(text);

  // The binary is CUDA-capable when a CUDA backend is registered at load time,
  // which shows up either as an extra backend (CPU + CUDA) or in system-info.
  const cudaCapable = cudaRegistered || (backends !== null && backends >= 2) || gpuDevices.length > 0;

  // A GPU is actually usable only when a GPU-type device is enumerated and the
  // engine selected a non-CPU backend for it.
  const gpuDeviceFound = gpuDevices.length > 0;
  const gpuSelected = foundGpu && Boolean(usingBackend) && !/^cpu$/i.test(usingBackend);

  return {
    cudaCapable,
    gpuDeviceFound,
    gpuSelected,
    gpuName: gpuDevices.length ? gpuDevices[0].name : null,
    devices,
    backends,
    deviceList,
    usingBackend: usingBackend || null,
    systemInfo: systemInfo || null,
    messages: { foundGpu, noGpu },
  };
}

function parseSegments(transcription) {
  const segments = [];
  let index = 0;
  for (const raw of transcription) {
    const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
    const confidence = segmentConfidence(tokens);
    const words = tokensToWords(tokens);
    let text = (raw.text || '').replace(/\s+/g, ' ').trim();
    if (!text) text = UNCLEAR_PLACEHOLDER;
    segments.push({
      segment_id: `SEG-${String(index).padStart(4, '0')}`,
      start: raw.offsets.from / 1000,
      end: raw.offsets.to / 1000,
      speaker: 'SPEAKER_01',
      text,
      status: 'AUTOMATIC',
      confidence,
      words: words.length ? words : null,
      _lowConfidence: confidence !== null && confidence < LOW_CONFIDENCE,
    });
    index += 1;
  }
  return segments;
}

class WhisperAdapter {
  constructor({ binaryPath, modelPath, vadModelPath, versionArgs } = {}) {
    this.binaryPath = binaryPath || resolveBinary('whisper-cli');
    this.modelPath = modelPath || null;
    this.vadModelPath = vadModelPath || null;
    // Extra argv used only by version(). Defaults to the engine's own flag; the
    // tests override it so a cross-platform script can be used as the fixture.
    this.versionArgs = Array.isArray(versionArgs) ? versionArgs : ['--version'];
    this.lastInvocation = null;
  }

  describe() {
    return {
      engine: 'whisper.cpp',
      binaryPath: this.binaryPath,
      modelPath: this.modelPath,
      vadModelPath: this.vadModelPath,
    };
  }

  async version() {
    try {
      const out = await new Promise((resolve, reject) => {
        const child = spawn(this.binaryPath, this.versionArgs, { windowsHide: true, shell: false });
        let text = '';
        child.stdout.on('data', (d) => (text += d));
        child.stderr.on('data', (d) => (text += d));
        child.on('error', reject);
        child.on('close', () => resolve(text));
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Determine what the binary can actually do, by loading a model and reading the
   * engine's own device/backend report. This distinguishes a CUDA-capable binary
   * from a CPU-only one, and reports whether a GPU was really selected — it never
   * infers capability from the presence of the `-ng` option or from the host
   * having an NVIDIA device.
   *
   * @returns {Promise<{ok:boolean, reason?:string, cudaCapable:boolean, gpuSelected:boolean, ...}>}
   */
  async probeRuntime({ modelPath = this.modelPath, timeoutMs = 120000 } = {}) {
    if (!modelPath || !fs.existsSync(modelPath)) {
      return { ok: false, reason: 'MODEL_NOT_INSTALLED', cudaCapable: false, gpuSelected: false };
    }
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-probe-'));
      const wav = path.join(dir, 'silence.wav');
      fs.writeFileSync(wav, silentWavBuffer());
      const { code, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(this.binaryPath, ['-m', modelPath, '-f', wav, '-nt'], {
          windowsHide: true,
          shell: false,
        });
        let out = '';
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          reject(Object.assign(new Error('runtime probe timed out'), { code: 'PROBE_TIMEOUT' }));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => {
          out += d;
          if (out.length > 2 * 1024 * 1024) out = out.slice(-1024 * 1024);
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, stderr: out });
        });
      });
      if (code !== 0) {
        return { ok: false, reason: 'PROBE_FAILED', cudaCapable: false, gpuSelected: false, stderr: stderr.slice(-2000) };
      }
      return { ok: true, ...parseRuntimeProbe(stderr) };
    } catch (err) {
      return { ok: false, reason: err.code || 'PROBE_ERROR', cudaCapable: false, gpuSelected: false };
    } finally {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Transcribe a prepared 16 kHz mono WAV file.
   *
   * @param {string} wavPath
   * @param {object} options
   * @param {(info:{percent:number,stage:string})=>void} [options.onProgress]
   * @param {AbortSignal} [options.signal]
   */
  transcribe(wavPath, options = {}) {
    const {
      language = 'tr',
      useGpu = true,
      useVad = true,
      threads = Math.max(1, Math.min(8, os.cpus().length - 1)),
      beamSize = 5,
      onProgress,
      signal,
    } = options;

    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      const err = new Error('ASR model is not installed.');
      err.code = 'MODEL_NOT_INSTALLED';
      throw err;
    }

    const outBase = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ft-asr-')),
      'result'
    );

    const args = [
      '-m', this.modelPath,
      '-f', wavPath,
      '-l', language,
      '-t', String(threads),
      '-bs', String(beamSize),
      '-ojf',
      '-of', outBase,
      '-np',
      '-pp',
    ];
    if (useVad && this.vadModelPath && fs.existsSync(this.vadModelPath)) {
      args.push('--vad', '-vm', this.vadModelPath);
    }
    if (!useGpu) args.push('-ng');

    this.lastInvocation = { binary: this.binaryPath, args };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.binaryPath, args, { windowsHide: true, shell: false });
      } catch (err) {
        reject(Object.assign(err, { code: 'ASR_SPAWN_FAILED' }));
        return;
      }

      let stderr = '';
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const progressRe = /progress\s*=\s*(\d+)%/;
      child.stderr.on('data', (d) => {
        const chunk = d.toString('utf8');
        stderr += chunk;
        if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
        const m = progressRe.exec(chunk);
        if (m && onProgress) {
          onProgress({ percent: Math.min(99, Number(m[1])), stage: 'transcribing' });
        }
      });
      child.stdout.on('data', () => {});

      child.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(Object.assign(err, { code: 'ASR_SPAWN_FAILED' }));
      });

      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (aborted) {
          reject(Object.assign(new Error('Transcription cancelled.'), { code: 'TRANSCRIPTION_CANCELLED' }));
          return;
        }
        if (code !== 0) {
          const err = new Error('The transcription engine exited with an error.');
          err.code = 'ASR_FAILED';
          err.exitCode = code;
          err.detail = stderr.trim().split('\n').slice(-15).join('\n');
          reject(err);
          return;
        }
        const jsonPath = `${outBase}.json`;
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (err) {
          reject(Object.assign(new Error('Could not read transcription output.'), { code: 'ASR_OUTPUT_MISSING' }));
          return;
        }
        const segments = parseSegments(parsed.transcription || []);
        try {
          fs.rmSync(path.dirname(outBase), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        if (onProgress) onProgress({ percent: 100, stage: 'done' });
        const runtime = parseRuntimeProbe(stderr);
        resolve({
          segments,
          language: (parsed.result && parsed.result.language) || language,
          engine: 'whisper.cpp',
          runtime,
          raw: {
            systemInfo: parsed.systeminfo || null,
            modelType: parsed.model ? parsed.model.type : null,
          },
        });
      });
    });
  }
}

module.exports = { WhisperAdapter, parseSegments, tokensToWords, parseRuntimeProbe, silentWavBuffer };

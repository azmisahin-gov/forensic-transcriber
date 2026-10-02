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
  constructor({ binaryPath, modelPath, vadModelPath } = {}) {
    this.binaryPath = binaryPath || resolveBinary('whisper-cli');
    this.modelPath = modelPath || null;
    this.vadModelPath = vadModelPath || null;
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
      const r = await new Promise((resolve, reject) => {
        const child = spawn(this.binaryPath, ['--version'], { windowsHide: true, shell: false });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });
      return out.trim();
    } catch {
      return null;
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
        resolve({
          segments,
          language: (parsed.result && parsed.result.language) || language,
          engine: 'whisper.cpp',
          raw: {
            systemInfo: parsed.systeminfo || null,
            modelType: parsed.model ? parsed.model.type : null,
          },
        });
      });
    });
  }
}

module.exports = { WhisperAdapter, parseSegments, tokensToWords };

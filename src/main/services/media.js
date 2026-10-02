'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveBinary } = require('./paths');

/**
 * Run a child process without a shell. Arguments are passed as an array so a
 * crafted file name can never be interpreted as a shell command. stderr/stdout
 * are captured with a hard cap to keep a hostile or corrupt file from
 * exhausting memory.
 */
function runProcess(bin, args, { timeoutMs = 0, maxOutputBytes = 8 * 1024 * 1024, signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, shell: false, signal });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedByCap = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
            reject(Object.assign(new Error(`Process timed out after ${timeoutMs} ms`), { code: 'PROCESS_TIMEOUT' }));
          }, timeoutMs)
        : null;

    child.stdout.on('data', (d) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= maxOutputBytes) stdout += d.toString('utf8');
      else killedByCap = true;
    });
    child.stderr.on('data', (d) => {
      stderrBytes += d.length;
      if (stderrBytes <= maxOutputBytes) stderr += d.toString('utf8');
      if (onStderr) onStderr(d.toString('utf8'));
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal: sig, stdout, stderr, truncated: killedByCap });
    });
  });
}

function parseRational(value) {
  if (!value || value === 'N/A') return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class MediaService {
  constructor() {
    this.ffmpeg = resolveBinary('ffmpeg');
    this.ffprobe = resolveBinary('ffprobe');
  }

  async available() {
    const result = { ffmpeg: false, ffprobe: false, version: null };
    try {
      const r = await runProcess(this.ffprobe, ['-version'], { timeoutMs: 15000 });
      result.ffprobe = r.code === 0;
      result.version = (r.stdout.split('\n')[0] || '').trim() || null;
    } catch {
      /* not available */
    }
    try {
      const r = await runProcess(this.ffmpeg, ['-version'], { timeoutMs: 15000 });
      result.ffmpeg = r.code === 0;
    } catch {
      /* not available */
    }
    return result;
  }

  /**
   * Probe a media file for the metadata the case record keeps. A malformed
   * file yields a structured error instead of throwing an unhandled exception.
   */
  async probe(filePath) {
    const stat = fs.statSync(filePath);
    const result = await runProcess(
      this.ffprobe,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeoutMs: 120000 }
    );
    if (result.code !== 0) {
      const err = new Error('Media could not be decoded by ffprobe.');
      err.code = 'PROBE_FAILED';
      err.detail = result.stderr.trim().slice(0, 2000);
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      const err = new Error('ffprobe returned malformed output.');
      err.code = 'PROBE_PARSE_FAILED';
      throw err;
    }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const hasVideo = streams.some((s) => s.codec_type === 'video');
    const duration = parseDuration(parsed.format && parsed.format.duration) ??
      (audio ? parseDuration(audio.duration) : null);
    const bitRate = audio ? Number(audio.bits_per_raw_sample || 0) : 0;

    return {
      containerFormat: (parsed.format && parsed.format.format_name) || null,
      sizeBytes: stat.size,
      durationSeconds: duration,
      hasVideo,
      format: audio ? audio.codec_name || null : null,
      codec: audio ? audio.codec_long_name || audio.codec_name || null : null,
      sampleRate: audio && audio.sample_rate ? Number(audio.sample_rate) : null,
      channels: audio && audio.channels ? Number(audio.channels) : null,
      bitDepth: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : null,
      channelLayout: audio ? audio.channel_layout || null : null,
    };
  }

  /**
   * Produce a 16 kHz mono PCM WAV working copy for the ASR engine. The
   * original evidence file is never modified.
   */
  async toAsrWav(inputPath, outputPath, { onProgress } = {}) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-sn',
      '-dn',
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      outputPath,
    ];
    const result = await runProcess(this.ffmpeg, args, {
      timeoutMs: 0,
      onStderr: onProgress ? (chunk) => onProgress(chunk) : undefined,
    });
    if (result.code !== 0) {
      const err = new Error('FFmpeg could not decode the recording to a working format.');
      err.code = 'DECODE_FAILED';
      err.detail = result.stderr.trim().slice(0, 2000);
      throw err;
    }
    return outputPath;
  }

  /** Read a decimated peak envelope for waveform rendering. */
  async waveformPeaks(inputPath, buckets = 1600) {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-',
    ];
    const result = await runProcess(this.ffmpeg, args, { timeoutMs: 600000, maxOutputBytes: 512 * 1024 * 1024 });
    if (result.code !== 0) {
      const err = new Error('Could not compute waveform.');
      err.code = 'WAVEFORM_FAILED';
      throw err;
    }
    const buf = Buffer.from(result.stdout, 'binary');
    const sampleCount = Math.floor(buf.length / 2);
    if (sampleCount === 0) return { buckets: 0, peaks: [] };
    const perBucket = Math.max(1, Math.floor(sampleCount / buckets));
    const peaks = [];
    for (let i = 0; i < sampleCount; i += perBucket) {
      let max = 0;
      const end = Math.min(i + perBucket, sampleCount);
      for (let j = i; j < end; j += 1) {
        const v = Math.abs(buf.readInt16LE(j * 2)) / 32768;
        if (v > max) max = v;
      }
      peaks.push(Math.round(max * 1000) / 1000);
    }
    return { buckets: peaks.length, peaks };
  }
}

module.exports = { MediaService, runProcess, parseRational };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Minimal local file logger. Writes to <baseDir>/logs/forensic-transcriber.log.
 * No remote sink is configured anywhere: the application performs no
 * telemetry or analytics.
 *
 * Privacy: logs are support diagnostics, not a case record. They must never
 * contain transcript text or evidence content. Every logged value is passed
 * through `redact`, which replaces anything that looks like long free text with
 * a placeholder and strips absolute home paths.
 */

const MAX_STRING = 200;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) return `<redacted ${value.length} chars>`;
    // Collapse the user's home directory so a log never reveals the account
    // name or the exact local layout.
    return value.split(os.homedir()).join('~');
  }
  if (depth > 3) return '<redacted nested>';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Never persist a segment's or transcript's text.
      if (/^(text|segments|transcript|content|words)$/i.test(k)) {
        out[k] = '<redacted>';
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return '<redacted>';
}

class Logger {
  constructor(baseDir, { name = 'forensic-transcriber' } = {}) {
    this.dir = path.join(baseDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, `${name}.log`);
  }

  _write(level, message, meta) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message: redact(String(message)),
      ...(meta ? { meta: redact(meta) } : {}),
    });
    try {
      fs.appendFileSync(this.file, `${line}\n`);
    } catch {
      /* logging must never crash the app */
    }
    if (level === 'error' || level === 'warn' || process.env.FT_VERBOSE) {
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : 'log'](line);
    }
  }

  info(message, meta) {
    this._write('info', message, meta);
  }

  warn(message, meta) {
    this._write('warn', message, meta);
  }

  error(message, meta) {
    this._write('error', message, meta);
  }
}

module.exports = { Logger, redact };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Minimal local file logger. Writes to <baseDir>/logs/forensic-transcriber.log.
 * No remote sink is configured anywhere: the application performs no
 * telemetry or analytics.
 */
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
      message: String(message),
      ...(meta ? { meta } : {}),
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

module.exports = { Logger };

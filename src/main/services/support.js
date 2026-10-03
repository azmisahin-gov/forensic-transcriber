'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const { createTar } = require('./tar');
const { writeFileAtomic } = require('./atomic');
const { redact } = require('./logger');

/**
 * Local support/diagnostic bundle.
 *
 * The application is offline-first and stores case content only on this
 * machine. This bundle is therefore built and kept locally: nothing is uploaded
 * anywhere. It contains the technical facts needed to diagnose a problem
 * (versions, platform, engine/runtime selection, error codes, recent events)
 * and never the case itself — no transcript text, no audio, no evidence, no
 * personal data. Every value passes through the same redactor the logger uses.
 *
 * The user decides whether to share the resulting file.
 */

const BUNDLE_FORMAT = 'forensic-transcriber-support-bundle';
const BUNDLE_VERSION = 1;

function safeJson(value) {
  return `${JSON.stringify(redact(value), null, 2)}\n`;
}

/** Read the tail of the local log file, redacted line by line. */
function readLogTail(logFile, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.stringify(redact(JSON.parse(line)));
          } catch {
            return JSON.stringify(redact(line));
          }
        })
        .join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Build the support bundle.
 *
 * @param {object} args
 * @param {object} args.appInfo        result of the app:info payload
 * @param {object} [args.engineInfo]   engine capability/probe summary
 * @param {Array}  [args.diagnostics]  storage.listDiagnostics()
 * @param {string} [args.logFile]      path to the local log file
 * @param {object} [args.extra]        additional redacted key/values
 * @returns {{buffer:Buffer, manifest:object}}
 */
function buildSupportBundle({ appInfo = {}, engineInfo = null, diagnostics = [], logFile = null, extra = {} } = {}) {
  const entries = [];
  const fileIndex = [];
  const add = (name, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    entries.push({ name, data: buf });
    fileIndex.push({ path: name, sizeBytes: buf.length, sha256: require('node:crypto').createHash('sha256').update(buf).digest('hex') });
  };

  const environment = {
    generated_at: new Date().toISOString(),
    app: {
      name: appInfo.name,
      version: appInfo.version,
      scope: appInfo.scope,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      // Only the OS release string; the hostname and user name are not included.
    },
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    engine: engineInfo,
    media: appInfo.media || null,
    lastRunMode: appInfo.lastRunMode || null,
    extra,
  };

  add('environment.json', safeJson(environment));
  add('diagnostics.json', safeJson(diagnostics));

  const logTail = logFile ? readLogTail(logFile) : '';
  add('logs/recent.log', logTail || '(no log entries)\n');

  add(
    'README.txt',
    [
      'Forensic Transcriber — support bundle',
      '',
      'This file was created locally to help diagnose a problem. It was not sent',
      'anywhere by the application.',
      '',
      'It contains technical information only: application and OS versions, the',
      'transcription engine and runtime selection, error codes and recent events.',
      'It contains no transcript text, no audio, no evidence and no personal data.',
      '',
      'Share it only if you choose to, and only with someone you trust.',
    ].join('\n')
  );

  const manifest = {
    format: BUNDLE_FORMAT,
    bundle_version: BUNDLE_VERSION,
    generated_at: environment.generated_at,
    app_version: appInfo.version || null,
    platform: process.platform,
    files: fileIndex,
    redaction: 'logger.redact applied to every value',
  };
  const manifestJson = Buffer.from(safeJson(manifest), 'utf8');
  entries.push({ name: 'manifest.json', data: manifestJson });

  const buffer = zlib.gzipSync(createTar(entries), { level: 9 });
  return { buffer, manifest };
}

/** Write the support bundle atomically. */
function writeSupportBundle({ destPath, ...args }) {
  const { buffer, manifest } = buildSupportBundle(args);
  writeFileAtomic(destPath, buffer);
  return { path: destPath, bytes: buffer.length, manifest };
}

module.exports = {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  buildSupportBundle,
  writeSupportBundle,
  readLogTail,
};

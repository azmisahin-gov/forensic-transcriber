'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Durable file primitives used wherever a half-written file would be worse than
 * no file at all: exports, the case-archive manifest, and the database backup.
 *
 * The pattern is always: write to a sibling temp file, flush it to disk, then
 * rename it over the destination. rename(2) is atomic within a filesystem, so a
 * reader either sees the complete old file or the complete new file, never a
 * partial one.
 */

/**
 * Write `data` to `destPath` atomically.
 *
 * @param {string} destPath
 * @param {string|Buffer} data
 * @param {object} [opts]
 * @param {boolean} [opts.fsync=true] flush the file (and its directory) to disk
 * @returns {string} the destination path
 */
function writeFileAtomic(destPath, data, { fsync = true } = {}) {
  const dir = path.dirname(destPath);
  const tmp = path.join(dir, `.${path.basename(destPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, data);
    if (fsync) {
      safeFsync(fd);
    }
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, destPath);
    if (fsync) {
      fsyncDir(dir);
    }
    return destPath;
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Flush a directory entry so a rename survives a power loss (best effort). */
function fsyncDir(dir) {
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      safeFsync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // Directory fsync is not supported on every platform; the file itself is
    // already flushed, which is the important part.
  }
}

/**
 * fsync is a durability optimisation, not a correctness requirement: the rename
 * is what keeps readers from ever seeing a partial file. Some platforms
 * (notably Windows, for certain handles) reject fsync with EPERM/EINVAL, so it
 * is attempted and, if unsupported, skipped rather than failing the write.
 */
function safeFsync(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (!['EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(err.code)) throw err;
  }
}

/**
 * Copy `srcPath` to `destPath` atomically, removing any partial file on failure.
 */
function copyFileAtomic(srcPath, destPath, { fsync = true } = {}) {
  const dir = path.dirname(destPath);
  const tmp = path.join(dir, `.${path.basename(destPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.copyFileSync(srcPath, tmp);
    if (fsync) {
      const fd = fs.openSync(tmp, 'r');
      try {
        safeFsync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmp, destPath);
    if (fsync) {
      fsyncDir(dir);
    }
    return destPath;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = { writeFileAtomic, copyFileAtomic, fsyncDir };

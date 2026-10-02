'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { MODEL_REGISTRY, getModel } = require('../../shared/model-registry');

function downloadUrl(model) {
  return `${model.source.replace(/\/$/, '')}/resolve/main/${model.fileName}`;
}

function fetchToFile(url, destPath, { onProgress, maxRedirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (currentUrl, redirectsLeft) => {
      const lib = currentUrl.startsWith('http:') ? http : https;
      const req = lib.get(currentUrl, { headers: { 'User-Agent': 'forensic-transcriber' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(Object.assign(new Error('Too many redirects'), { code: 'DOWNLOAD_REDIRECT' }));
            return;
          }
          const next = new URL(res.headers.location, currentUrl).toString();
          go(next, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            Object.assign(new Error(`Download failed with HTTP ${res.statusCode}`), {
              code: 'DOWNLOAD_HTTP',
              status: res.statusCode,
            })
          );
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress({ received, total });
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ received, total })));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', (err) => reject(Object.assign(err, { code: 'DOWNLOAD_NETWORK' })));
      req.setTimeout(60000, () => req.destroy(Object.assign(new Error('Download stalled'), { code: 'DOWNLOAD_TIMEOUT' })));
    };
    go(url, maxRedirects);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class ModelManager {
  constructor(modelsDir) {
    this.modelsDir = modelsDir;
    fs.mkdirSync(this.modelsDir, { recursive: true });
    this._hashCache = new Map();
    this._active = new Map();
  }

  pathFor(id) {
    const model = getModel(id);
    if (!model) return null;
    return path.join(this.modelsDir, model.fileName);
  }

  async _verify(filePath, expected) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { exists: false, verified: false };
    }
    const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    let digest = this._hashCache.get(key);
    if (!digest) {
      digest = await sha256File(filePath);
      this._hashCache.set(key, digest);
    }
    return { exists: true, verified: digest === expected, sha256: digest, sizeBytes: stat.size };
  }

  async list() {
    const out = [];
    for (const model of MODEL_REGISTRY) {
      const filePath = this.pathFor(model.id);
      const state = await this._verify(filePath, model.sha256);
      out.push({
        id: model.id,
        label: model.label,
        kind: model.kind,
        recommended: model.recommended,
        description: model.description,
        license: model.license,
        source: model.source,
        revision: model.revision,
        expectedSha256: model.sha256,
        expectedSizeBytes: model.sizeBytes,
        installed: state.exists,
        verified: state.verified,
        actualSizeBytes: state.sizeBytes ?? null,
        actualSha256: state.sha256 ?? null,
        path: state.exists ? filePath : null,
      });
    }
    return out;
  }

  async status(id) {
    const model = getModel(id);
    if (!model) return { installed: false, verified: false, expected: null };
    const filePath = this.pathFor(id);
    const state = await this._verify(filePath, model.sha256);
    return { ...state, path: state.exists ? filePath : null, expected: model.sha256 };
  }

  resolvePath(id) {
    const filePath = this.pathFor(id);
    if (!filePath) return null;
    try {
      if (fs.statSync(filePath).size > 0) return filePath;
    } catch {
      return null;
    }
    return null;
  }

  async install(id, { onProgress, signal } = {}) {
    const model = getModel(id);
    if (!model) {
      const err = new Error(`Unknown model: ${id}`);
      err.code = 'MODEL_UNKNOWN';
      throw err;
    }
    if (this._active.has(id)) {
      const err = new Error('Model install already in progress.');
      err.code = 'MODEL_INSTALL_BUSY';
      throw err;
    }
    const finalPath = this.pathFor(id);
    const tmpPath = `${finalPath}.partial`;
    const controller = new AbortController();
    this._active.set(id, controller);

    try {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      await fetchToFile(downloadUrl(model), tmpPath, { onProgress });
      const digest = await sha256File(tmpPath);
      if (digest !== model.sha256) {
        fs.rmSync(tmpPath, { force: true });
        const err = new Error('Downloaded model failed checksum verification.');
        err.code = 'MODEL_CHECKSUM_MISMATCH';
        err.expected = model.sha256;
        err.actual = digest;
        throw err;
      }
      fs.renameSync(tmpPath, finalPath);
      const stat = fs.statSync(finalPath);
      this._hashCache.set(`${finalPath}:${stat.size}:${stat.mtimeMs}`, digest);
      return { id, path: finalPath, sha256: digest, sizeBytes: stat.size, verified: true };
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      this._active.delete(id);
    }
  }

  async importFromFile(id, sourcePath, { onProgress } = {}) {
    const model = getModel(id);
    if (!model) {
      const err = new Error(`Unknown model: ${id}`);
      err.code = 'MODEL_UNKNOWN';
      throw err;
    }
    const stat = fs.statSync(sourcePath);
    if (stat.size === 0) {
      const err = new Error('Model file is empty.');
      err.code = 'MODEL_EMPTY';
      throw err;
    }
    const finalPath = this.pathFor(id);
    const tmpPath = `${finalPath}.partial`;
    await new Promise((resolve, reject) => {
      const src = fs.createReadStream(sourcePath);
      const dst = fs.createWriteStream(tmpPath);
      let received = 0;
      src.on('data', (c) => {
        received += c.length;
        if (onProgress) onProgress({ received, total: stat.size });
      });
      src.on('error', reject);
      dst.on('error', reject);
      dst.on('finish', () => dst.close(resolve));
      src.pipe(dst);
    });
    const digest = await sha256File(tmpPath);
    if (digest !== model.sha256) {
      fs.rmSync(tmpPath, { force: true });
      const err = new Error('Selected file does not match the expected model checksum.');
      err.code = 'MODEL_CHECKSUM_MISMATCH';
      err.expected = model.sha256;
      err.actual = digest;
      throw err;
    }
    fs.renameSync(tmpPath, finalPath);
    const finalStat = fs.statSync(finalPath);
    this._hashCache.set(`${finalPath}:${finalStat.size}:${finalStat.mtimeMs}`, digest);
    return { id, path: finalPath, sha256: digest, sizeBytes: finalStat.size, verified: true };
  }
}

module.exports = { ModelManager, sha256File, downloadUrl };

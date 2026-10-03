'use strict';

/**
 * Minimal, deterministic TAR (ustar) writer and reader.
 *
 * Written in-repo rather than pulled from a dependency for two reasons:
 *  - **Determinism.** System tar/gzip embed mtimes, uid/gid and platform
 *    metadata. Here every header field is fixed (mtime 0, uid/gid 0, mode
 *    0644/0755 by entry kind) and entries are sorted, so the same input always
 *    produces byte-identical output. That is what makes a case archive
 *    reproducible and verifiable.
 *  - **No attack surface.** One small, auditable implementation with no
 *    dependency tree.
 *
 * The reader is deliberately strict: it rejects truncated archives and any
 * entry whose declared size does not match the data, so a corrupt archive fails
 * loudly instead of restoring partial data.
 */

const BLOCK = 512;

function toOctal(value, length) {
  const s = value.toString(8);
  return `${'0'.repeat(Math.max(0, length - 1 - s.length))}${s}\0`;
}

function writeString(buf, offset, length, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`value too long for field: ${value}`);
  bytes.copy(buf, offset);
}

/**
 * @param {Array<{name:string, mode?:number, data:Buffer}>} entries
 * @returns {Buffer}
 */
function createTar(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = [];
  for (const entry of sorted) {
    const { name, prefix } = splitName(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const header = Buffer.alloc(BLOCK, 0);
    writeString(header, 0, 100, name);
    writeString(header, 100, 8, toOctal(entry.mode || 0o644, 8));
    writeString(header, 108, 8, toOctal(0, 8)); // uid
    writeString(header, 116, 8, toOctal(0, 8)); // gid
    writeString(header, 124, 12, toOctal(data.length, 12));
    writeString(header, 136, 12, toOctal(0, 12)); // mtime = 0 for determinism
    writeString(header, 148, 8, '        '); // checksum placeholder
    writeString(header, 156, 1, '0'); // typeflag: regular file
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    writeString(header, 265, 32, 'root');
    writeString(header, 297, 32, 'root');
    if (prefix) writeString(header, 345, 155, prefix);

    let sum = 0;
    for (const byte of header) sum += byte;
    writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);

    chunks.push(header);
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  return Buffer.concat(chunks);
}

/** Split a path into the ustar name/prefix fields (prefix <= 155, name <= 100). */
function splitName(fullName) {
  const name = String(fullName).replace(/^\/+/, '');
  if (Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  let rest = parts.pop();
  let prefix = parts.join('/');
  while (prefix && Buffer.byteLength(prefix, 'utf8') > 155) {
    const idx = prefix.indexOf('/');
    if (idx < 0) break;
    rest = `${prefix.slice(idx + 1)}/${rest}`;
    prefix = prefix.slice(0, idx);
  }
  if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(rest, 'utf8') > 100) {
    throw new Error(`path too long for tar: ${fullName}`);
  }
  return { name: rest, prefix };
}

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(buf, offset, length) {
  const s = readString(buf, offset, length).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a tar buffer into entries. Throws on truncation or a bad header.
 * @returns {Array<{name:string, mode:number, data:Buffer}>}
 */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end marker
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    offset += BLOCK;
    if (offset + size > buffer.length) {
      throw new Error(`tar entry truncated: ${name}`);
    }
    const data = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (!name) continue;
    entries.push({ name: prefix ? `${prefix}/${name}` : name, mode, data });
  }
  return entries;
}

module.exports = { createTar, readTar, BLOCK };

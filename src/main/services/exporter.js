'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const exporters = require('./exports');
const { writeFileAtomic } = require('./atomic');

const FORMATS = {
  json: { ext: 'json', render: exporters.toJson, mime: 'application/json' },
  txt: { ext: 'txt', render: exporters.toTxt, mime: 'text/plain' },
  srt: { ext: 'srt', render: exporters.toSrt, mime: 'application/x-subrip' },
  html: { ext: 'html', render: exporters.toHtml, mime: 'text/html' },
};

function safeStem(name) {
  const base = path.basename(String(name || 'transcript'));
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'transcript';
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Render and write transcript exports.
 *
 * @returns {Promise<Array<{format:string,path:string,bytes:number,sha256:string}>>}
 */
async function runExport({ caseRecord, evidence, transcript, segments, language, modelId, engine, formats, outputDir, baseName }) {
  const dir = outputDir || path.join(caseRecord.case_dir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  // Two recordings in one case can share a file name, so the evidence id is
  // part of the export name. Without it, exporting the second recording would
  // silently overwrite the first recording's export in the shared folder.
  const evidenceStem = safeStem(baseName || (evidence && evidence.original_name) || caseRecord.case_id);
  const evidenceId = evidence && evidence.evidence_id ? evidence.evidence_id : null;
  const stem = evidenceId ? `${evidenceStem}__${evidenceId}` : evidenceStem;
  const ctx = { caseRecord, evidence, transcript, segments, language, modelId, engine };
  const written = [];
  for (const format of formats) {
    const spec = FORMATS[format];
    if (!spec) {
      const err = new Error(`Unsupported export format: ${format}`);
      err.code = 'EXPORT_FORMAT_UNSUPPORTED';
      throw err;
    }
    const content = spec.render(ctx);
    const filePath = path.join(dir, `${stem}.${spec.ext}`);
    // Atomic write: an interrupted export must not leave a partial file that
    // looks complete.
    writeFileAtomic(filePath, content, { fsync: true });
    const stat = fs.statSync(filePath);
    written.push({
      format,
      path: filePath,
      bytes: stat.size,
      sha256: sha256Text(content),
    });
  }
  return written;
}

module.exports = { runExport, FORMATS, safeStem };

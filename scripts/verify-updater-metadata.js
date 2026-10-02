'use strict';

/**
 * Validate electron-updater metadata (latest.yml) before publishing.
 *
 *   node scripts/verify-updater-metadata.js --file release/latest.yml --version 0.1.1
 *
 * The updater only installs an artifact that the release metadata describes and
 * that matches its recorded hash. If latest.yml is missing, malformed, points at
 * the wrong file, or carries no usable sha512, the release must not be published
 * — otherwise clients would either find no update or download something the
 * updater cannot verify.
 *
 * The checks are exported so the tests can exercise them without a release.
 */

const fs = require('node:fs');
const yaml = require('js-yaml');

const EXPECTED_ARTIFACT = 'ForensicTranscriber-Setup-x64.exe';

/**
 * @returns {{ok:boolean, errors:string[], info?:object}}
 */
function validateUpdaterMetadata(metadata, { expectedVersion, expectedArtifact = EXPECTED_ARTIFACT } = {}) {
  const errors = [];
  if (!metadata || typeof metadata !== 'object') {
    return { ok: false, errors: ['metadata is empty or not an object'] };
  }
  if (!metadata.version || typeof metadata.version !== 'string') {
    errors.push('metadata has no version');
  } else if (expectedVersion && metadata.version !== expectedVersion) {
    errors.push(`metadata version ${metadata.version} does not match expected ${expectedVersion}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    errors.push('metadata has no files[]');
  } else {
    const match = metadata.files.find((f) => f && f.url === expectedArtifact);
    if (!match) {
      errors.push(`metadata does not reference ${expectedArtifact} (found: ${metadata.files.map((f) => f && f.url).join(', ')})`);
    } else {
      if (!match.sha512 || typeof match.sha512 !== 'string' || match.sha512.length < 64) {
        errors.push(`${expectedArtifact} has no usable sha512`);
      }
      if (match.size !== undefined && (typeof match.size !== 'number' || match.size <= 0)) {
        errors.push(`${expectedArtifact} has an invalid size`);
      }
    }
    // The model package and portable zip must never be listed as updater
    // payloads; only the installer participates in auto-update.
    for (const f of metadata.files) {
      if (f && typeof f.url === 'string' && /ModelPack|Portable/i.test(f.url)) {
        errors.push(`metadata must not list ${f.url} as an updater artifact`);
      }
    }
  }
  if (!metadata.path || metadata.path !== expectedArtifact) {
    errors.push(`metadata path is ${metadata.path}, expected ${expectedArtifact}`);
  }
  return { ok: errors.length === 0, errors, info: { version: metadata.version, files: metadata.files ? metadata.files.length : 0 } };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const file = arg('--file', 'release/latest.yml');
  const expectedVersion = arg('--version', null);

  if (!fs.existsSync(file)) {
    // eslint-disable-next-line no-console
    console.error(`Updater metadata not found: ${file}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Updater metadata is not valid YAML: ${err.message}`);
    process.exit(1);
  }

  const result = validateUpdaterMetadata(parsed, { expectedVersion });
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error('Updater metadata is invalid:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Updater metadata OK: version=${result.info.version}, files=${result.info.files}, artifact=${EXPECTED_ARTIFACT}`);
}

if (require.main === module) main();

module.exports = { validateUpdaterMetadata, EXPECTED_ARTIFACT };

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUpdaterMetadata, EXPECTED_ARTIFACT } = require('../../scripts/verify-updater-metadata');

function goodMetadata(overrides = {}) {
  return {
    version: '0.1.1',
    files: [
      {
        url: EXPECTED_ARTIFACT,
        sha512: 'a'.repeat(88),
        size: 193125697,
      },
    ],
    path: EXPECTED_ARTIFACT,
    sha512: 'a'.repeat(88),
    releaseDate: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

test('a well-formed metadata file is accepted', () => {
  const r = validateUpdaterMetadata(goodMetadata(), { expectedVersion: '0.1.1' });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.info.version, '0.1.1');
});

test('a missing version is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ version: undefined }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no version/.test(e)));
});

test('a version mismatch is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata(), { expectedVersion: '0.2.0' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /does not match expected/.test(e)));
});

test('metadata without files[] is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ files: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no files/.test(e)));
});

test('metadata that does not reference the installer is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ files: [{ url: 'other.exe', sha512: 'a'.repeat(88) }], path: 'other.exe' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /does not reference/.test(e)));
});

test('an entry without a usable sha512 is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ files: [{ url: EXPECTED_ARTIFACT, sha512: 'short', size: 10 }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no usable sha512/.test(e)));
});

test('the model package must never be listed as an updater artifact', () => {
  const r = validateUpdaterMetadata(goodMetadata({
    files: [
      { url: EXPECTED_ARTIFACT, sha512: 'a'.repeat(88), size: 10 },
      { url: 'ForensicTranscriber-ModelPack-0.1.1.zip', sha512: 'b'.repeat(88), size: 10 },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must not list/.test(e)));
});

test('the portable zip must never be listed as an updater artifact', () => {
  const r = validateUpdaterMetadata(goodMetadata({
    files: [
      { url: EXPECTED_ARTIFACT, sha512: 'a'.repeat(88), size: 10 },
      { url: 'ForensicTranscriber-Portable-x64.zip', sha512: 'b'.repeat(88), size: 10 },
    ],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must not list/.test(e)));
});

test('a path that does not match the artifact is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ path: 'something-else.exe' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /path is/.test(e)));
});

test('empty or non-object metadata is rejected', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    const r = validateUpdaterMetadata(bad);
    assert.equal(r.ok, false);
  }
});

test('an invalid size is rejected', () => {
  const r = validateUpdaterMetadata(goodMetadata({ files: [{ url: EXPECTED_ARTIFACT, sha512: 'a'.repeat(88), size: -1 }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /invalid size/.test(e)));
});

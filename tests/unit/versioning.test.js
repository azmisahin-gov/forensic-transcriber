'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../src/shared/versioning');

test('parseVersion accepts plain SemVer and splits the parts', () => {
  const p = v.parseVersion('1.2.3');
  assert.equal(p.major, 1);
  assert.equal(p.minor, 2);
  assert.equal(p.patch, 3);
  assert.equal(p.prerelease, null);
});

test('parseVersion accepts pre-release and build metadata', () => {
  const p = v.parseVersion('1.0.0-rc.1+build.5');
  assert.equal(p.prerelease, 'rc.1');
  assert.equal(p.build, 'build.5');
});

test('parseVersion rejects malformed input', () => {
  for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3.4', 'a.b.c', null, undefined, 123]) {
    assert.equal(v.parseVersion(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('bumpVersion implements the patch/minor/major rules', () => {
  assert.equal(v.nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(v.nextVersion('0.1.1', 'minor'), '0.2.0');
  assert.equal(v.nextVersion('0.2.0', 'major'), '1.0.0');
});

test('a major bump resets minor and patch; a minor bump resets patch', () => {
  assert.equal(v.nextVersion('1.4.7', 'major'), '2.0.0');
  assert.equal(v.nextVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(v.nextVersion('1.4.7', 'patch'), '1.4.8');
});

test('bumping clears pre-release and build metadata', () => {
  assert.equal(v.nextVersion('1.2.3-rc.1+abc', 'patch'), '1.2.4');
});

test('bumpVersion rejects an unknown release type', () => {
  assert.throws(() => v.bumpVersion('1.0.0', 'hotfix'), /Invalid release type/);
});

test('compareVersions orders releases correctly', () => {
  assert.equal(v.compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(v.compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(v.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(v.compareVersions('1.0.0-rc.1', '1.0.0'), -1, 'pre-release precedes release');
});

test('isNewer only accepts a strictly greater version', () => {
  assert.equal(v.isNewer('0.1.1', '0.1.0'), true);
  assert.equal(v.isNewer('0.1.0', '0.1.0'), false);
  assert.equal(v.isNewer('0.0.9', '0.1.0'), false);
});

test('tag helpers round-trip and reject non-tags', () => {
  assert.equal(v.tagForVersion('0.1.0'), 'v0.1.0');
  assert.equal(v.versionFromTag('v0.1.0'), '0.1.0');
  assert.equal(v.versionFromTag('0.1.0'), null, 'a bare version is not a tag');
  assert.equal(v.versionFromTag('release-1'), null);
  assert.equal(v.versionFromTag('vnot-a-version'), null);
});

test('tag/version consistency accepts a match', () => {
  const r = v.checkTagVersionConsistency('v0.1.1', '0.1.1');
  assert.equal(r.ok, true);
});

test('tag/version consistency rejects a mismatch', () => {
  const r = v.checkTagVersionConsistency('v0.1.1', '0.1.0');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VERSION_MISMATCH');
});

test('tag/version consistency rejects an invalid tag', () => {
  assert.equal(v.checkTagVersionConsistency('vNext', '0.1.0').code, 'TAG_INVALID');
});

test('planRelease calculates the next version and tag', () => {
  const r = v.planRelease({ currentVersion: '0.1.0', releaseType: 'patch', existingTags: ['v0.1.0'] });
  assert.equal(r.ok, true);
  assert.equal(r.nextVersion, '0.1.1');
  assert.equal(r.tag, 'v0.1.1');
});

test('planRelease refuses a duplicate tag', () => {
  const r = v.planRelease({ currentVersion: '0.1.1', releaseType: 'patch', existingTags: ['v0.1.1', 'v0.1.2'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TAG_EXISTS');
  assert.equal(r.tag, 'v0.1.2');
});

test('planRelease refuses an invalid release type', () => {
  const r = v.planRelease({ currentVersion: '0.1.0', releaseType: 'huge' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RELEASE_TYPE_INVALID');
});

test('planRelease refuses an invalid current version', () => {
  const r = v.planRelease({ currentVersion: 'one.two', releaseType: 'patch' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CURRENT_INVALID');
});

test('planRelease never proposes a version equal to the current one', () => {
  for (const type of v.RELEASE_TYPES) {
    const r = v.planRelease({ currentVersion: '0.1.0', releaseType: type });
    assert.equal(r.ok, true);
    assert.equal(v.isNewer(r.nextVersion, '0.1.0'), true);
  }
});

test('latestReleaseTag picks the highest released tag and ignores junk', () => {
  const r = v.latestReleaseTag(['v0.1.0', 'nightly', 'v0.2.0', 'v0.1.10', 'not-a-tag']);
  assert.equal(r.tag, 'v0.2.0');
  assert.equal(r.version, '0.2.0');
});

test('latestReleaseTag returns null with no valid tags', () => {
  assert.equal(v.latestReleaseTag(['main', 'vNext']), null);
  assert.equal(v.latestReleaseTag([]), null);
});

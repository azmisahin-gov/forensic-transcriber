'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  updatePackageJson,
  updatePackageLock,
  updateChangelog,
} = require('../../scripts/bump-version');

test('updatePackageJson sets the version and preserves other fields', () => {
  const input = JSON.stringify({ name: 'x', version: '0.1.0', private: true }, null, 2);
  const out = JSON.parse(updatePackageJson(input, '0.1.1'));
  assert.equal(out.version, '0.1.1');
  assert.equal(out.name, 'x');
  assert.equal(out.private, true);
});

test('updatePackageLock updates both the top-level and packages[""] version', () => {
  const input = JSON.stringify({ name: 'x', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'x', version: '0.1.0' } } }, null, 2);
  const out = JSON.parse(updatePackageLock(input, '0.2.0'));
  assert.equal(out.version, '0.2.0');
  assert.equal(out.packages[''].version, '0.2.0');
  assert.equal(out.lockfileVersion, 3);
});

test('updatePackageLock tolerates a lockfile without a packages map', () => {
  const input = JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2);
  const out = JSON.parse(updatePackageLock(input, '0.1.1'));
  assert.equal(out.version, '0.1.1');
});

test('updateChangelog converts Unreleased into a dated release heading', () => {
  const input = [
    '# Changelog',
    '',
    '## [Unreleased] — in progress',
    '',
    '### Fixed',
    '',
    '- something',
    '',
    '## [0.1.0] - 2026-01-01',
    '',
    '- old',
    '',
  ].join('\n');
  const out = updateChangelog(input, '0.1.1', '2026-10-03');
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-10-03/);
  assert.match(out, /### Fixed\n\n- something/);
  assert.match(out, /## \[0\.1\.0\] - 2026-01-01/);
});

test('updateChangelog inserts a release heading when there is no Unreleased section', () => {
  const input = '# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- old\n';
  const out = updateChangelog(input, '0.1.1', '2026-10-03');
  assert.match(out, /## \[0\.1\.1\] - 2026-10-03\n\n## \[0\.1\.0\] - 2026-01-01/);
});

test('updateChangelog appends a heading when there are no version sections', () => {
  const input = '# Changelog\n\nSome intro.\n';
  const out = updateChangelog(input, '0.1.1', '2026-10-03');
  assert.match(out, /## \[0\.1\.1\] - 2026-10-03/);
});

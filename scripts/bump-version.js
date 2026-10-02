'use strict';

/**
 * Controlled version bump for the release lifecycle.
 *
 *   node scripts/bump-version.js --type patch|minor|major [--dry-run] [--no-git]
 *
 * It:
 *   1. reads the current version from package.json,
 *   2. calculates the next version (SemVer),
 *   3. refuses duplicate or inconsistent versions,
 *   4. updates package.json, package-lock.json and CHANGELOG.md,
 *   5. optionally commits the bump and creates the matching vX.Y.Z tag.
 *
 * The pure content transforms are exported so the tests can exercise them
 * without touching the working tree.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const versioning = require('../src/shared/versioning');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const PACKAGE_LOCK = path.join(REPO_ROOT, 'package-lock.json');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

// ------------------------------------------------------------------ pure transforms

/** Set the `version` field of a package.json document, preserving formatting. */
function updatePackageJson(content, nextVersion) {
  const doc = JSON.parse(content);
  doc.version = nextVersion;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Set the version in package-lock.json. npm lockfiles carry the version twice:
 * at the top level and in `packages[""]`.
 */
function updatePackageLock(content, nextVersion) {
  const doc = JSON.parse(content);
  doc.version = nextVersion;
  if (doc.packages && doc.packages['']) {
    doc.packages[''].version = nextVersion;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Move the `## [Unreleased]` section to a dated release heading and open a new
 * empty Unreleased section. Keeps a Keep-a-Changelog style file consistent.
 */
function updateChangelog(content, nextVersion, date) {
  const unreleasedRe = /^##\s*\[Unreleased\][^\n]*$/m;
  const newRelease = `## [${nextVersion}] - ${date}`;
  if (unreleasedRe.test(content)) {
    return content.replace(unreleasedRe, `## [Unreleased]\n\n${newRelease}`);
  }
  // No Unreleased section: insert the release heading before the first existing
  // version heading, or after the intro paragraph if there is none.
  const firstVersionRe = /^##\s*\[[0-9]+\.[0-9]+\.[0-9]+\][^\n]*$/m;
  if (firstVersionRe.test(content)) {
    return content.replace(firstVersionRe, `${newRelease}\n\n$&`);
  }
  return `${content.replace(/\s*$/, '')}\n\n${newRelease}\n`;
}

// ------------------------------------------------------------------ git helpers

function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function git(args, { dryRun = false } = {}) {
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[dry-run] git ${args.join(' ')}`);
    return '';
  }
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const typeIndex = argv.indexOf('--type');
  const type = typeIndex >= 0 ? argv[typeIndex + 1] : null;
  return {
    type,
    dryRun: argv.includes('--dry-run'),
    noGit: argv.includes('--no-git'),
  };
}

function main() {
  const { type, dryRun, noGit } = parseArgs(process.argv.slice(2));
  if (!type) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/bump-version.js --type patch|minor|major [--dry-run] [--no-git]');
    process.exit(1);
  }

  const pkgContent = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const currentVersion = JSON.parse(pkgContent).version;
  const tags = gitTags();

  const plan = versioning.planRelease({ currentVersion, releaseType: type, existingTags: tags });
  if (!plan.ok) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to bump: ${plan.message} [${plan.code}]`);
    process.exit(1);
  }

  const { nextVersion, tag } = plan;
  const date = new Date().toISOString().slice(0, 10);
  // eslint-disable-next-line no-console
  console.log(`Bumping ${currentVersion} -> ${nextVersion} (${type}); tag ${tag}`);

  const newPkg = updatePackageJson(pkgContent, nextVersion);
  let newLock = null;
  if (fs.existsSync(PACKAGE_LOCK)) {
    newLock = updatePackageLock(fs.readFileSync(PACKAGE_LOCK, 'utf8'), nextVersion);
  }
  let newChangelog = null;
  if (fs.existsSync(CHANGELOG)) {
    newChangelog = updateChangelog(fs.readFileSync(CHANGELOG, 'utf8'), nextVersion, date);
  }

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log('[dry-run] would write package.json, package-lock.json, CHANGELOG.md');
    if (!noGit) console.log(`[dry-run] would commit and tag ${tag}`);
    return;
  }

  fs.writeFileSync(PACKAGE_JSON, newPkg);
  if (newLock) fs.writeFileSync(PACKAGE_LOCK, newLock);
  if (newChangelog) fs.writeFileSync(CHANGELOG, newChangelog);

  if (!noGit) {
    git(['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
    git(['commit', '-m', `Release ${nextVersion}`]);
    git(['tag', '-a', tag, '-m', `Release ${nextVersion}`]);
    // eslint-disable-next-line no-console
    console.log(`Created commit and tag ${tag}. Push with: git push origin HEAD --follow-tags`);
  }
}

if (require.main === module) main();

module.exports = { updatePackageJson, updatePackageLock, updateChangelog, parseArgs };

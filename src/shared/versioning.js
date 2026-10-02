'use strict';

/**
 * Semantic versioning helpers for the release lifecycle.
 *
 * This module is deliberately free of I/O and of any dependency so it can be
 * used by the application, by the release scripts and by the tests. It is the
 * single source of truth for how a version is parsed, compared, bumped and
 * checked against a Git tag.
 *
 * UMD wrapper: loads under Node (CommonJS) and in the renderer (global).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FT_VERSIONING = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Semantic Versioning 2.0.0: MAJOR.MINOR.PATCH with optional pre-release and
  // build metadata. The release lifecycle only ever produces plain X.Y.Z tags.
  const SEMVER_RE =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

  const RELEASE_TYPES = Object.freeze(['patch', 'minor', 'major']);

  /** Parse a version string, or return null if it is not valid SemVer. */
  function parseVersion(input) {
    if (typeof input !== 'string') return null;
    const match = SEMVER_RE.exec(input.trim());
    if (!match) return null;
    return {
      raw: input.trim(),
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] || null,
      build: match[5] || null,
    };
  }

  function isValidVersion(input) {
    return parseVersion(input) !== null;
  }

  function formatVersion(v) {
    const base = `${v.major}.${v.minor}.${v.patch}`;
    return `${base}${v.prerelease ? `-${v.prerelease}` : ''}${v.build ? `+${v.build}` : ''}`;
  }

  /**
   * Compare two versions for precedence.
   * Returns -1 if a < b, 0 if equal, 1 if a > b. Build metadata is ignored
   * (SemVer 2.0.0 §10); a pre-release sorts before the same release.
   */
  function compareVersions(a, b) {
    const pa = typeof a === 'string' ? parseVersion(a) : a;
    const pb = typeof b === 'string' ? parseVersion(b) : b;
    if (!pa || !pb) throw new Error(`Cannot compare invalid versions: ${a} vs ${b}`);
    for (const key of ['major', 'minor', 'patch']) {
      if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
    }
    if (pa.prerelease === pb.prerelease) return 0;
    if (pa.prerelease === null) return 1;
    if (pb.prerelease === null) return -1;
    return pa.prerelease < pb.prerelease ? -1 : 1;
  }

  /** True when the candidate is strictly newer than the current version. */
  function isNewer(candidate, current) {
    return compareVersions(candidate, current) > 0;
  }

  /**
   * Calculate the next version for a release type. Pre-release and build
   * metadata are cleared: a release is always a plain X.Y.Z.
   */
  function bumpVersion(current, releaseType) {
    const v = typeof current === 'string' ? parseVersion(current) : current;
    if (!v) throw new Error(`Invalid current version: ${current}`);
    if (!RELEASE_TYPES.includes(releaseType)) {
      throw new Error(`Invalid release type: ${releaseType} (expected one of ${RELEASE_TYPES.join(', ')})`);
    }
    switch (releaseType) {
      case 'major':
        return { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: null, build: null };
      case 'minor':
        return { ...v, minor: v.minor + 1, patch: 0, prerelease: null, build: null };
      case 'patch':
      default:
        return { ...v, patch: v.patch + 1, prerelease: null, build: null };
    }
  }

  /** Convenience: the next version as a string. */
  function nextVersion(current, releaseType) {
    return formatVersion(bumpVersion(current, releaseType));
  }

  /** `0.1.0` -> `v0.1.0`. */
  function tagForVersion(version) {
    const v = typeof version === 'string' ? version : formatVersion(version);
    if (!isValidVersion(v)) throw new Error(`Cannot build a tag from an invalid version: ${version}`);
    return `v${v}`;
  }

  /** `v0.1.0` -> `0.1.0`, or null when the string is not a release tag. */
  function versionFromTag(tag) {
    if (typeof tag !== 'string') return null;
    const m = /^v(.+)$/.exec(tag.trim());
    if (!m) return null;
    return isValidVersion(m[1]) ? m[1] : null;
  }

  /**
   * Validate that a tag and an application version agree.
   * This is the guard that stops a tag from pointing at a commit whose
   * package.json declares a different version.
   */
  function checkTagVersionConsistency(tag, appVersion) {
    const tagVersion = versionFromTag(tag);
    if (!tagVersion) {
      return { ok: false, code: 'TAG_INVALID', message: `Not a valid release tag: ${tag}` };
    }
    if (!isValidVersion(appVersion)) {
      return { ok: false, code: 'APP_VERSION_INVALID', message: `Not a valid application version: ${appVersion}` };
    }
    if (tagVersion !== appVersion) {
      return {
        ok: false,
        code: 'VERSION_MISMATCH',
        message: `Tag ${tag} (${tagVersion}) does not match package.json version ${appVersion}`,
        tagVersion,
        appVersion,
      };
    }
    return { ok: true, code: 'OK', version: appVersion };
  }

  /**
   * Decide whether a new release tag may be created.
   *
   * @param {object} args
   * @param {string} args.currentVersion version currently in package.json
   * @param {string} args.releaseType    patch | minor | major
   * @param {string[]} [args.existingTags] tags already present in the repository
   * @returns {{ok:boolean, code:string, message:string, nextVersion?:string, tag?:string}}
   */
  function planRelease({ currentVersion, releaseType, existingTags = [] } = {}) {
    if (!isValidVersion(currentVersion)) {
      return { ok: false, code: 'CURRENT_INVALID', message: `Current version is not valid SemVer: ${currentVersion}` };
    }
    if (!RELEASE_TYPES.includes(releaseType)) {
      return {
        ok: false,
        code: 'RELEASE_TYPE_INVALID',
        message: `Release type must be one of ${RELEASE_TYPES.join(', ')} (got ${releaseType})`,
      };
    }
    const proposed = nextVersion(currentVersion, releaseType);
    const tag = tagForVersion(proposed);
    if (!isNewer(proposed, currentVersion)) {
      return { ok: false, code: 'NOT_AN_INCREASE', message: `${proposed} is not newer than ${currentVersion}` };
    }
    const normalized = new Set(existingTags.map((t) => String(t).trim()));
    if (normalized.has(tag)) {
      return { ok: false, code: 'TAG_EXISTS', message: `Tag ${tag} already exists`, tag, nextVersion: proposed };
    }
    return { ok: true, code: 'OK', nextVersion: proposed, tag, currentVersion };
  }

  /** The most recent released version among a list of tags, or null. */
  function latestReleaseTag(tags = []) {
    let best = null;
    for (const tag of tags) {
      const v = versionFromTag(tag);
      if (!v) continue;
      if (!best || compareVersions(v, best.version) > 0) best = { tag, version: v };
    }
    return best;
  }

  return {
    SEMVER_RE,
    RELEASE_TYPES,
    parseVersion,
    isValidVersion,
    formatVersion,
    compareVersions,
    isNewer,
    bumpVersion,
    nextVersion,
    tagForVersion,
    versionFromTag,
    checkTagVersionConsistency,
    planRelease,
    latestReleaseTag,
  };
});

# Release process

This document describes the complete release lifecycle: versioning, the manual
release trigger, the Windows build, the GitHub Release, and how users receive
updates.

## Policy

**Normal development never releases.** A push or merge to `main` runs CI only.
There is no release on every commit, merge or tag created by hand.

A release happens only when a maintainer starts the **Release (version)**
workflow and chooses a bump. That workflow calculates the version, commits the
bump, tags it, and calls the build-and-publish workflow.

```
maintainer starts "Release (version)" → patch | minor | major
   → version calculated (SemVer)
   → package.json, package-lock.json and CHANGELOG.md updated
   → version bump committed to main
   → matching vX.Y.Z tag created and pushed
   → "Release (build & publish)" runs
        → verifies tag == package.json version
        → builds Windows installer + portable + latest.yml (windows-latest)
        → builds the offline model package (ubuntu-latest)
        → verifies the full artefact set and the updater metadata
        → writes SHA256SUMS.txt
        → publishes the GitHub Release
```

## Current release status

| | |
| --- | --- |
| Latest release | **v0.1.4** — https://github.com/azmisahin-gov/forensic-transcriber/releases/tag/v0.1.4 |
| Assets | installer, portable zip, model package, `latest.yml`, `SHA256SUMS.txt` |
| GPU runtime | **not included** — the hosted `windows-latest` runner has no CUDA toolkit, so this release ships the CPU runtime only |
| Code signing | **none** — see [Code-signing status](#code-signing-status) |

`v0.1.0` is an earlier, non-distributable release (source archives only),
`v0.1.1` shipped a dead renderer, `v0.1.2` failed when a second recording was
added to a case, and `v0.1.3` was the first solid multi-evidence release.
**Use `v0.1.4` or newer.**

## How to create a patch release

A patch release is a bug fix: `0.1.0 → 0.1.1`.

1. Merge the fix to `main` and confirm CI is green.
2. Ensure `CHANGELOG.md` has an `## [Unreleased]` section describing the fix.
3. GitHub → **Actions** → **Release (version)** → **Run workflow**.
4. `release_type`: **patch**.
5. Run it. The workflow commits `Release 0.1.1`, tags `v0.1.1`, and builds and
   publishes the release.

The CUDA build step reports in the job summary whether the GPU runtime was built
for that release. If the runner has no CUDA toolkit, the release ships the CPU
runtime and the summary says so.

## How to create a minor release

A minor release adds a backward-compatible feature: `0.1.1 → 0.2.0`.

Same steps, choosing `release_type: minor`.

## How to create a major release

A major release makes an incompatible change: `0.2.0 → 1.0.0`.

Same steps, choosing `release_type: major`.

## What the workflow refuses

- A **duplicate tag**: if `vX.Y.Z` already exists, the run stops with `TAG_EXISTS`.
- An **invalid release type**: anything other than patch/minor/major.
- A **tag/version mismatch**: the build job re-reads `package.json` at the tag and
  refuses to publish if it disagrees with the tag.
- An **incomplete artefact set**: if the installer, portable zip, model package
  or `latest.yml` is missing, the publish job fails before creating a release.
- A **Linux artefact published as a Windows asset**: the publish job fails if a
  Linux build is present in the artefact set.
- **Broken updater metadata**: if `latest.yml` does not reference
  `ForensicTranscriber-Setup-x64.exe` with a usable sha512, publishing stops.

## Release artefacts

Every GitHub Release contains:

| Artefact | Purpose |
| --- | --- |
| `ForensicTranscriber-Setup-x64.exe` | The Windows installer. Also the auto-update payload. |
| `ForensicTranscriber-Portable-x64.zip` | Manual download; no installation. |
| `ForensicTranscriber-ModelPack-*.zip` | Optional offline speech-model package. |
| `latest.yml` | electron-updater metadata: version, file, sha512. |
| `SHA256SUMS.txt` | SHA-256 of every `.exe` and `.zip` in the release. |

The NSIS installer and its blockmap are produced by `electron-builder` on
`windows-latest`; the CUDA runtime is built there too when the toolchain is
available, with the CPU runtime always present as the fallback.

## How users receive updates

The installed application checks GitHub Releases over HTTPS for a newer version.

- On startup (about 8 seconds in) it checks once and only reports what it finds.
- The user can also open **About → Application updates → Check for updates**.
- Updates are delivered only from
  `github.com/azmisahin-gov/forensic-transcriber` over HTTPS, on the `latest`
  channel. Nothing else is configured.

Nothing is downloaded and nothing is installed automatically.

## How to postpone an update

When an update is available the user can press **Postpone**. Nothing is
downloaded. The postponed version stays postponed on later checks; a *different*,
newer version is offered again. The user can still download it later from the
same panel.

## Installing an update

1. **Download update** — the application downloads the installer and shows
   progress.
2. **Restart and install** — only after the user presses this and confirms the
   restart dialog does the application quit and restart into the new version.

A failed download or install leaves the current installation running; the update
panel shows the error and the user can retry or keep working.

## Where GitHub Releases are hosted

```
https://github.com/azmisahin-gov/forensic-transcriber/releases
```

The website's download buttons resolve to
`https://github.com/azmisahin-gov/forensic-transcriber/releases/latest/download/<asset>`.

## How model updates differ from application updates

| | Application update | Model update |
| --- | --- | --- |
| What it changes | The application binaries | The speech model files |
| Source | `latest.yml` + the NSIS installer in a GitHub Release | The model registry and the model download/import flow |
| Trigger | The update panel, with explicit user consent | **Models → Install**, or **Models → Import file…** |
| Payload | `ForensicTranscriber-Setup-x64.exe` only | `ggml-*.bin` files, checksum-verified |
| User data | Never touched | Never touched |

The auto-updater only ever installs the application. The model package
(`ForensicTranscriber-ModelPack-*.zip`) is a manual download; it is deliberately
**not** an update payload, and the publish job fails if it appears in
`latest.yml`.

## User data is never touched by an update

Case data lives in the Electron `userData` directory (the case database plus the
`cases/` folder), separately from the application binaries. An application update
replaces the program, not the data directory, so cases, evidence copies,
transcripts and history are preserved. The updater has no code path that writes
to the case store.

## Code-signing status

**The Windows executable is not code-signed.** No Authenticode certificate is
configured. Consequences, stated honestly:

- Windows SmartScreen may warn on first launch of the installer.
- No "verified publisher" is claimed anywhere.
- The updater's integrity check is limited to the **sha512 recorded in
  `latest.yml`**, which protects against a corrupted or swapped download over a
  broken connection. It is **not** a publisher signature and does not prove who
  built the artifact. The release is fetched over HTTPS from GitHub Releases,
  which is the only integrity guarantee currently available.

If signing is added later, electron-updater will verify the publisher signature
as well; until then this limitation stands.

## Permissions

The version workflow declares `contents: write` because it commits the bump and
pushes the tag. The build/publish workflow declares `contents: write` to create
the release. The CI workflow declares `contents: read` only.

If the repository's settings forbid a workflow from pushing to `main` or pushing
tags (for example, if "Read and write permissions" is not enabled for the
`GITHUB_TOKEN`, or if a branch protection rule blocks direct pushes), the
version workflow will fail at the push step. The fix is a repository setting, not
a weaker process:

- Settings → Actions → General → Workflow permissions → **Read and write
  permissions**.
- Or provide a `RELEASE_TOKEN` secret with `contents: write` for a user allowed
  to push to `main`.
- Branch protection on `main` must allow the release commit, or be temporarily
  relaxed for the release, or the release must go through the same review as any
  other change.

## Manual rebuild of an existing tag

**Release (build & publish)** can be run directly with `tag: vX.Y.Z` to rebuild
or re-publish an existing tag. It re-verifies that the tag and `package.json`
agree before publishing.

# Project state

CURRENT_PHASE: P11 — release lifecycle
CURRENT_STATUS: COMPLETE WITH KNOWN LIMITATIONS
LAST_UPDATED: 2026-10-02

## First distributable release published: v0.1.1

The controlled release lifecycle ran end to end and published a real,
distributable release.

| | |
| --- | --- |
| Version | **0.1.1** (patch from 0.1.0) |
| Tag | `v0.1.1` → `af6b1a7` ("Release 0.1.1") |
| Release | https://github.com/azmisahin-gov/forensic-transcriber/releases/tag/v0.1.1 |
| Assets | `ForensicTranscriber-Setup-x64.exe` (192 564 370 B), `ForensicTranscriber-Portable-x64.zip` (260 840 978 B), `ForensicTranscriber-ModelPack-0.1.1.zip` (534 060 311 B), `latest.yml` (363 B), `SHA256SUMS.txt` (309 B) |
| Workflow run | `37078216359` — version, verify-version, build-windows, model-package, publish all **success** |

Verified after publication:
- `SHA256SUMS.txt` covers all three distributables and `sha256sum -c` passes for
  every downloaded asset.
- `latest.yml` reports `version: 0.1.1`, `path:
  ForensicTranscriber-Setup-x64.exe`, and its **sha512 exactly matches** the
  published installer bytes (checked with `node:crypto`).
- Tag, `package.json`, `package-lock.json` (both fields) and `latest.yml` all
  agree on `0.1.1`.
- The packaged application binary is a genuine **x64 PE**; the portable zip
  contains `resources/vendor/bin/{whisper-cli.exe,ffmpeg.exe,ffprobe.exe}` and
  **no Linux artifacts**.
- The model package contains the pinned ASR + VAD models with their expected
  checksums.
- `v0.1.0` tag and release were **not** modified.

## Fixes applied on top of the merged lifecycle

- Consolidated `CHANGELOG.md` into a single `[Unreleased]` section (it had two,
  which would have produced a malformed release section).
- Declared `js-yaml` as an explicit dependency (it was required directly by
  `scripts/verify-updater-metadata.js` but only present transitively).
- The Windows CUDA build step no longer uses `continue-on-error`, which showed a
  **green tick over a build that did not happen**. It now skips cleanly when no
  CUDA toolkit is present, reports the GPU runtime state in the job summary, and
  still builds the CUDA runtime when a toolkit exists.

## Verified in this environment

- Unit tests: 99/99 pass.
- Integration tests: pipeline 4/4, red-team 15/15, update-data-safety 4/4.
- Lint: 0 problems (44 files).
- Security check: 0 critical findings.
- Packaged-app smoke test: 14/14 steps; acceptance test: 20/20 steps.
- Release gate: 12/12 pass.

## Not verified (known limitations)

- **No live auto-update run.** A real update requires a *second* published
  release and an installed Windows build. The configuration, state machine,
  metadata and safety properties are verified; the live update is not.
- **GPU runtime is not in this release.** The hosted `windows-latest` runner has
  no CUDA toolkit, so `v0.1.1` ships the **CPU runtime only**. The application
  reports CPU mode and the GPU runtime remains unverified.
- **Not verified on target NVIDIA hardware** (no RTX 3060 available).
- **The Windows installer was not launched on real Windows hardware**; the
  Windows binaries were validated under Wine.
- **No code signing.** The updater's integrity check is the sha512 in
  `latest.yml`, not a publisher signature.
- Accuracy is a **synthetic benchmark**, not a human corpus.

## Next exact action

Install `ForensicTranscriber-Setup-x64.exe` (v0.1.1) on a real Windows x64
machine, confirm transcription and the **Check engine** report, then publish a
second release to exercise the live auto-update path.

VERIFICATION_STATUS: release published and its artifacts independently verified;
live auto-update and target-machine validation outstanding and marked unverified.


## What this phase added

- **Semantic versioning** (`src/shared/versioning.js`): parse, compare, bump,
  tag formatting, tag/version consistency, duplicate-tag detection.
- **Controlled bump** (`scripts/bump-version.js`): updates `package.json`,
  `package-lock.json` and `CHANGELOG.md`; refuses duplicate tags and invalid
  types; `--dry-run` supported.
- **Release (version) workflow**: manual `workflow_dispatch` with
  patch/minor/major; commits the bump, tags `vX.Y.Z`, calls the build/publish
  workflow. Normal development never releases.
- **Release (build & publish) workflow** (reusable): re-verifies tag/version
  consistency, builds on `windows-latest`, validates `latest.yml`, refuses an
  incomplete or wrong-platform artefact set, writes `SHA256SUMS.txt`, publishes.
- **Windows auto-update** via `electron-updater` from GitHub Releases: check,
  postpone, download with progress, restart-and-install only on explicit
  confirmation. Never automatic, never touches case data or the speech model.
- **Update UX**: About & updates dialog, topbar badge, update states.

## Verified in this environment

- Unit tests: 99/99 pass (`node --test tests/unit/*.test.js`), including 40 new
  tests for versioning, the bump transforms, the updater state machine and
  updater-metadata validation.
- Integration tests: 4/4 pipeline + 15/15 red-team + 4/4 update-data-safety.
- Lint: 0 problems (44 files).
- Security check: 0 critical findings.
- Packaged-app smoke test: 14/14 steps (now covers the update surface).
- Packaged-app acceptance test: 20/20 steps.
- Release gate: **12/12 pass**.
- `latest.yml` from a real Windows build validates and its sha512 matches the
  installer exactly (verified with `node:crypto`).

## Not verified in this environment (known limitations)

- **No end-to-end auto-update run.** A real update needs a published release and
  a Windows installation. What is verified here is the configuration, the state
  machine, the metadata and the safety properties — not a live update.
- **Not verified on target NVIDIA hardware** (no GPU/CUDA toolkit available).
- **The Windows installer was not launched on real Windows hardware** here; the
  binaries were validated under Wine.
- **The published v0.1.0 release is not distributable.** It contains only GitHub's
  source archives because the earlier Windows run failed. No new tag was created
  by this phase.
- **No code signing.** The updater's integrity check is the sha512 in
  `latest.yml`, not a publisher signature.
- Accuracy is a **synthetic benchmark**, not a human corpus.

## Next exact action

Merge this branch, then run the **Release (version)** workflow with `patch` to
produce a real `v0.1.1` release, and confirm on a Windows machine that the
installed application detects and installs it.

VERIFICATION_STATUS: automated and packaged-app validation complete; live
auto-update and target-machine validation outstanding and marked unverified.


## What changed in the release-hardening pass

- **GPU audit.** The first release shipped a CPU-only `whisper-cli.exe` while the
  docs implied GPU support. Confirmed by running the packaged binary:
  `devices = 1`, `backends = 1`, `device 0: CPU (type: 0)`, `no GPU found`.
- **Two-runtime strategy.** CPU runtime (always shipped) plus an optional CUDA
  runtime in `bin/gpu/`. Selection is by the engine's own device/backend report
  (`src/main/services/runtime-selector.js`), never by the host having a GPU.
- **Verification mechanism.** `WhisperAdapter.probeRuntime()`, the
  `app:engine-probe` IPC channel, the **Check engine** button and the
  `--engine-report` self-test all report CUDA-capable vs CPU-only and which
  device a run used.
- **Windows CUDA build path.** `scripts/build-whisper-cuda-windows.cmd` and the
  release workflow build the CUDA runtime on the `windows-latest` runner and
  stage the redistributable NVIDIA DLLs (EULA Attachment A). Staged only when
  the build succeeds.
- **Fixed a real bug.** `WhisperAdapter.version()` always returned `null`
  because the output buffer was scoped inside the promise executor.
- **Pages workflow.** Root cause of the failure: the repository Pages site was
  not enabled. `actions/configure-pages` now runs with `enablement: true`, and
  the one-time manual setting is documented.
- **Site download links.** Point at the real asset names through
  `releases/latest/download`; a portable and a model-package link were added.
- **Docs consistency.** Corrected test counts (42 unit, 4 pipeline, 15 red-team),
  separated automated / target-machine / human-corpus validation tiers, and
  replaced the "real-world validation" label with "synthetic benchmark".

## Verified in this environment

- Unit tests: 42/42 pass (`node --test tests/unit/*.test.js`).
- Integration tests: 4/4 pipeline (incl. the offset timestamp contract) and
  15/15 red-team pass.
- Lint: 0 problems.
- Security check: 0 critical findings.
- Packaged-app smoke test: 11/11 steps.
- Packaged-app acceptance test: 20/20 steps.
- Engine report: CPU runtime confirmed; GPU runtime correctly reported as not
  bundled in this build; selection reason `GPU_RUNTIME_NOT_BUNDLED`; run mode CPU.
- Windows build: NSIS installer, portable zip and offline model package build
  from pinned, checksum-verified sources.

## Not verified in this environment (known limitations)

- **The v0.1.0 GitHub Release is not distributable.** The Windows release workflow
  failed at the unit test stage, so the release contains only GitHub's automatic
  source archives — no `.exe`, portable `.zip`, model package or `SHA256SUMS.txt`.
  It becomes usable only after the workflow succeeds on `windows-latest` and
  attaches those assets. No new tag was created by this fix.
- **Not verified on target NVIDIA hardware.** There is no NVIDIA GPU and no CUDA
  toolkit in the build environment, so the CUDA runtime could not be compiled or
  exercised here. The CUDA build runs on the `windows-latest` CI runner. The
  application reports the real runtime mode on the user's machine, so GPU
  behaviour is verifiable there but is **unverified here**.
- The Windows NSIS installer and portable zip were built but not launched on real
  Windows hardware (the environment is Linux); Windows binaries were validated
  under Wine.
- Accuracy is a **synthetic benchmark** (espeak-ng TTS audio), not a human corpus.
- No PDF export; no automatic diarization.

## Next exact action

Run `npm run build:win` on Windows (or let the release workflow run), install the
artefact, then execute the target-machine acceptance scenario in
`docs/RELEASE_CHECKLIST.md` — including `--engine-report` on the RTX 3060 — and
record the observed GPU mode in `docs/VERIFICATION.md`.

VERIFICATION_STATUS: automated and packaged-app validation complete; target-machine
GPU validation outstanding and explicitly marked unverified.

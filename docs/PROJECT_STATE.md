# Project state

CURRENT_PHASE: P11 — release lifecycle
CURRENT_STATUS: COMPLETE WITH KNOWN LIMITATIONS
LAST_UPDATED: 2026-10-02

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

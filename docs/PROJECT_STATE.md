# Project state

CURRENT_PHASE: P10 — release hardening
CURRENT_STATUS: COMPLETE WITH KNOWN LIMITATIONS
LAST_UPDATED: 2026-10-02

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

# Changelog

All notable changes to this project are documented here.
Format based on Keep a Changelog; the project follows Semantic Versioning.

## [Unreleased] — release lifecycle

### Added

- **Controlled release lifecycle.** A **Release (version)** workflow
  (`workflow_dispatch` with `patch`/`minor`/`major`) calculates the next SemVer,
  updates `package.json`, `package-lock.json` and `CHANGELOG.md`, commits the
  bump, creates the matching `vX.Y.Z` tag and calls the build/publish workflow.
  Normal development never releases: pushes and merges to `main` run CI only.
- **Semantic versioning module** (`src/shared/versioning.js`): parse, compare,
  bump, tag formatting, tag/version consistency and duplicate-tag detection.
- **Version bump script** (`scripts/bump-version.js`) with `--dry-run`, used by
  the workflow and available locally.
- **Windows auto-update** via `electron-updater` with GitHub Releases as the only
  source: check, postpone, download with progress, and restart-and-install on
  explicit user confirmation. Nothing is downloaded or installed automatically.
- **Update UX**: an **About & updates** dialog with version information, update
  status, progress and actions, plus a topbar badge when an update is available.
- **Updater metadata**: `electron-builder` writes `latest.yml`, which is
  published with the release and validated before publishing
  (`scripts/verify-updater-metadata.js`).
- **Tests**: 40 new unit tests (versioning, bump transforms, updater state
  machine, updater metadata validation) and an integration test proving an
  update never touches case data.

### Changed

- `release.yml` is now a reusable build/publish workflow (`workflow_call` plus
  manual dispatch) that re-verifies tag/version consistency, refuses an
  incomplete artefact set, refuses to publish Linux artefacts as Windows assets,
  and validates `latest.yml` before publishing.
- The combined `SHA256SUMS.txt` now covers every `.exe` and `.zip` in the release,
  including the model package.

### Security

- The update source is pinned to `azmisahin-gov/forensic-transcriber` over HTTPS
  on the `latest` channel; no other channel is configurable at runtime.
- The model package is explicitly **not** an update payload, and publishing fails
  if it appears in `latest.yml`.
- Code signing is not available; this is documented honestly, and the updater's
  integrity check is the sha512 in the release metadata, not a publisher
  signature.

## [Unreleased] — release hardening

### Fixed

- **GPU support was not actually present.** The packaged `whisper-cli.exe` was a
  CPU-only build (`backends = 1`, `device 0: CPU (type: 0)`, `no GPU found`),
  while the documentation implied GPU acceleration. A real two-runtime strategy
  now exists and the documentation states exactly what is verified.
- **`WhisperAdapter.version()` always returned `null`.** The output buffer was
  scoped inside the promise executor and was undefined outside it. A regression
  test covers this.
- **The `version()` regression test was invalid on Windows.** It created a POSIX
  shell script and only renamed it to `.exe`, so the Windows release job failed
  with `actual: null`. The fixture is now the running Node executable
  (`process.execPath`) plus a temporary script, which is a genuine executable on
  Windows, Linux and macOS and exercises the same spawn/collect/close path.
  A second test covers the "cannot spawn" branch.
- **GitHub Pages workflow failed.** The repository Pages site was not enabled;
  `actions/configure-pages` now runs with `enablement: true`, and the one-time
  manual setting is documented in `docs/RELEASE_CHECKLIST.md`.
- **The release workflow could publish an incomplete release.** `SHA256SUMS.txt`
  is produced per job, but the `model-package` job never uploaded one and the
  published release only took the first match, so the model package could be
  omitted from the checksums. The final `release` job now verifies that the
  installer, portable zip and model package are all present, generates one
  combined `SHA256SUMS.txt` from the downloaded artefacts, and fails before
  publishing if an expected asset is missing.

### Added

- **CPU + optional CUDA runtimes.** The CPU runtime always ships; a CUDA runtime
  is staged into `bin/gpu/` with the redistributable NVIDIA DLLs (CUDA EULA
  Attachment A) when the CI CUDA build succeeds.
- **Runtime capability probe.** `WhisperAdapter.probeRuntime()` reads the
  engine's own device/backend report to distinguish a CUDA-capable binary from a
  CPU-only one and to report the device actually used.
- **Runtime selection with explicit reasons.** `src/main/services/runtime-selector.js`
  picks CPU or GPU by evidence (`GPU_AVAILABLE`, `GPU_RUNTIME_NOT_BUNDLED`,
  `GPU_BINARY_NOT_CUDA`, `NO_GPU_DEVICE`, `OPERATOR_SELECTED_CPU`) and never
  infers capability from the host having a GPU.
- **Engine reporting in the UI and CLI.** A **Check engine** button, engine
  status line, per-run GPU/CPU toast, and an `--engine-report` self-test used by
  the release gate.
- **Windows CUDA build path.** `scripts/build-whisper-cuda-windows.cmd` and the
  release workflow build the CUDA runtime on `windows-latest`.
- Site download links for the portable zip and the offline model package, and a
  clear statement that the installer ships without a model.
- Unit tests for the runtime probe parser, the runtime selector, and `version()`.

### Changed

- Documentation now separates **automated validation**, **target-machine
  validation** and **human-corpus validation**; accuracy figures are labelled a
  **synthetic benchmark**, not real-world validation.
- Test counts corrected across the docs.

## [0.1.0] — 2026-10-02

First working release. Local-first 56.12 transcription workbench for Windows x64.

### Added

- **Case management**: create, list, open, update and delete local cases backed
  by SQLite (`node:sqlite`). No server, no account, no login.
- **Evidence ingestion**: file picker and drag-and-drop import of WAV, MP3, M4A,
  FLAC, OGG, MP4 and other FFmpeg-decodable formats. Original files are copied
  and never modified; metadata (container, codec, duration, sample rate,
  channels, bit depth) and SHA-256 are recorded. Original and derived files are
  kept in separate folders.
- **Local transcription**: whisper.cpp v1.9.4 adapter with Turkish language
  selection, optional Silero VAD, GPU (CUDA) acceleration with CPU fallback,
  streamed progress and cancellation.
- **Transcript model**: segments with `start`/`end` on the original timeline,
  speaker, text, status (`AUTOMATIC`/`REVIEWED`/`EDITED`/`VERIFIED`), real token
  confidence, and optional word timestamps.
- **Review workspace**: audio player with play/pause, seek, ±5 s, segment jump,
  playback speed; waveform with playhead and selection; click-to-play a segment;
  text editing, split, merge, speaker relabelling and status marking; exact
  undo/redo.
- **Export**: JSON (versioned canonical schema), TXT, SRT and self-contained
  HTML, all carrying case/evidence/hash provenance and the machine-vs-expert
  distinction.
- **Traceability**: append-only history of case, import, transcription, edit and
  export actions.
- **Packaging**: one-command Windows build producing an NSIS installer
  (`ForensicTranscriber-Setup-x64.exe`), a portable zip and `SHA256SUMS.txt`;
  vendored native runtime so end users install no development tools.
- **Offline model package**: `scripts/build-model-package.js` builds a zip with
  the default ASR + VAD models, manifest and checksums.
- **Documentation**: scope, architecture, methodology, standards, model notes,
  decisions, verification, release checklist, security notes, third-party
  notices.
- **Tests**: unit tests (transcript store, exports, storage), integration tests
  (full pipeline plus a timestamp-contract test that proves a delayed utterance
  keeps its original-timeline offset), red-team tests for hostile input, and
  packaged-app smoke and acceptance tests.
- **Tooling**: `scripts/lint.js` (syntax + safety rules),
  `scripts/security-check.js` (no telemetry/network/secrets/shell),
  `scripts/benchmark.js` (RTF, peak RSS), `scripts/wer.js` (WER/CER).

### Security

- Renderer sandboxed with `contextIsolation`, no `nodeIntegration`, a strict CSP
  and a narrow preload API.
- Child processes spawned with argument arrays and `shell: false`.
- Media served through a scoped custom protocol that only resolves known
  evidence ids.
- Model files checksum-verified before use.
- No telemetry, no analytics, no hidden network calls.

### Known limitations

See `docs/VERIFICATION.md`. Highlights: CPU-only GPU-accelerated benchmarking was
not possible in the build environment; the Windows NSIS installer is produced but
was not launched on real Windows hardware in this environment (the Windows
binaries were validated under Wine); no automatic diarization; PDF export is not
included.

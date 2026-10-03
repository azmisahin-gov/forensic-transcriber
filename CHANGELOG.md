# Changelog

All notable changes to this project are documented here.
Format based on Keep a Changelog; the project follows Semantic Versioning.

## [Unreleased]

## [0.2.0] - 2026-10-03

### Added

- **56.12 expert work station (additive).** Case intake fields
  (`file_number`, `authority`, `case_type`, `assignment_date`, `due_date`,
  `assignment_description`, `requested_questions`, `scope`), a live case
  dashboard, per-case notes/bookmarks, per-segment operator review flags
  (`UNCLEAR`/`REVISIT`/`REVIEW`), transcript filtering and in-transcript search
  highlighting, parametric report templates with a data-integrity verdict and a
  delivery-readiness checklist (TXT/HTML/DOCX/PDF), a one-file delivery package
  and a local redacted support bundle. All offline; no new runtime dependency.
  Review flags never change segment text or status, and reports carry a
  technical-work-product disclaimer (no legal assessment).
- **Safe transcript revision semantics.** A transcript now keeps an
  append-only `transcript_revisions` history (`transcript_revisions` table,
  schema_version 4). A new ASR run records a new `MACHINE` revision linked to its
  `transcription_runs` row; it does **not** overwrite a current human
  `REVIEWED`/`EDITED`/`VERIFIED` revision. The operator can explicitly promote any
  stored revision to current (`transcript:set-revision`). The live segment set is
  always that of the current revision, and every revision remains readable.
- **Export revision linkage.** JSON metadata and the TXT/HTML headers record the
  `transcript_revision` (`revision_id`, `state`, `created_at`, `run_id`) the
  export was rendered from.
- **Multi-audio-stream visibility.** `probe()` reports every audio stream and the
  selected order; `toAsrWav()` accepts an explicit `audioStreamOrder` (default
  `0:a:0`). The stream count is stored on the evidence row and `>>1` is visible
  rather than silently transcribed.
- **Regression coverage** for run lifecycle, revision non-destruction, archive
  provenance, atomic evidence import, fail-closed migration backup and
  binary-safe waveform (`tests/unit/p0-revision-lifecycle.test.js`,
  `tests/unit/p0-regression.test.js`).
- **Full localization and i18n regression coverage.** Every remaining
  hard-coded operator string (model import, DB integrity, case restore,
  cancelling, drop-path error, engine check, postponed update, model badge,
  play-from-here) now resolves through `t()`. The tr/en dictionaries are asserted
  key-for-key identical (338 each), every `data-i18n` key in `index.html`
  resolves in both locales, and an unknown locale falls back to Turkish
  (`tests/unit/productization.test.js`).

### Fixed

- **Transcription run lifecycle.** `runId` is now declared before the `try`, so
  the `catch` can always close an opened run. Every started run reaches
  `SUCCEEDED`, `FAILED` or `CANCELLED` with `finished_at` set; no orphan
  `STARTED` run remains. Closing a run is fault-tolerant and can no longer raise
  a second exception that masks the original error.
- **Binary-safe waveform.** The waveform no longer decodes FFmpeg's raw PCM
  output to a UTF-8 string (`Buffer.from(stdout, 'binary')` was lossy). It is
  consumed as bytes, decimated incrementally, so memory is bounded by the bucket
  count rather than the recording length.
- **Case archive provenance.** Archives carry all transcript revisions
  (archive_version 1 and 2 accepted). Restore re-creates runs and revisions with
  explicit `old id → new id` mapping, preserves run status, engine/version,
  model/model hash, VAD, settings, runtime mode/reason and timestamps, and
  re-links each revision to its run.

### Changed

- `schema_version` is now **5** (adds `evidence.audio_stream_count`, the case
  assignment fields `cases.*`, `notes`, `reports`, `preferences` and a local
  diagnostics buffer; then adds `segments.flags_json`). Every step is an
  additive, backed-up migration.
- Case archive format is now **version 2** (adds revisions); version 1 archives
  still restore.
- The atomic-evidence-import regression test no longer relies on POSIX directory
  permissions (Windows ignores them). It fails the copy call directly, so the
  same regression runs on Windows CI as well as Linux.

## [0.1.4] - 2026-10-03

### Added

- **P0 reliability and data-integrity hardening.** No new product features; every
  change protects case data.
  - **Case backup / archive** (`Back up case…` / `Restore case…`): a
    deterministic, versioned archive containing a manifest, the case rows, the
    original and derived evidence, the transcripts and prior exports. The same
    case always produces identical bytes. A restore always creates a new case and
    re-verifies every evidence hash, so a tampered or truncated archive is
    rejected rather than partially restored. Implemented in-repo with no new
    dependency.
  - **Database durability**: `journal_mode=WAL`, `synchronous=FULL`,
    `foreign_keys=ON`, `busy_timeout=5000`, and a `healthCheck()` running
    `PRAGMA quick_check`.
  - **Atomic writes** for exports, the archive and the pre-migration database
    backup (temp → fsync → rename → directory fsync).
  - **Crash-safe migration**: a byte-for-byte database backup is taken before any
    schema rewrite; migrations are idempotent. `schema_version` is now 3.
  - **Evidence re-verification**: opening a case re-hashes every evidence copy
    and reports OK / MISMATCH / MISSING; it never rewrites the stored hash.
  - **Transcription run provenance**: a `transcription_runs` table records, per
    attempt, the input and derived hashes, engine and version, model and model
    hash, VAD state, settings, runtime mode/reason and the app version.
  - **Failed-operation safety**: failed or cancelled transcriptions close their
    run row and leave other transcripts intact; the restart-to-install-update
    flow prompts to save or discard unsaved edits.
  - **Log privacy**: the logger redacts transcript and evidence content and long
    strings, and collapses the home directory.
- **Self-test modes bypass the single-instance lock**, so the release gate can
  run the packaged smoke, acceptance, multi-evidence and engine-report checks
  without a previous run making the next one exit silently.

## [0.1.3] - 2026-10-03

### Fixed

- **A second recording in the same case failed with
  `UNIQUE constraint failed: segments.segment_id`.** The ASR engine numbers its
  segments from zero for every recording, and `segments.segment_id` was the
  single-column primary key, so two transcripts in one case collided. The key is
  now `(transcript_id, segment_id)` — a segment id is only unique within its
  transcript — and a migration rebuilds the table for existing databases copying
  every row unchanged. Generated ids are also prefixed with a per-run id so they
  are unique by construction.
- **The sidebar counts showed a stale snapshot.** It read `0 cases · 0 files`
  while the case list beside it already listed cases and files; the counts now
  recompute whenever the case list refreshes.
- **"Data folder" opened an unrelated directory picker.** It now opens the real
  data folder and is labelled "Open data folder".
- **The export folder was hard to find.** The export dialog now has an
  "Open exports folder" button, and after an export the app asks whether to open
  it. Export file names include the evidence id, so two recordings with the same
  file name no longer overwrite each other's exports.

## [0.1.2] - 2026-10-03

### Fixed

- **The renderer crashed on startup in v0.1.1, leaving the UI completely dead.**
  `src/renderer/index.html` never loaded `shared/constants.js`, so the browser
  global `FT_CONSTANTS` was undefined and `transcript-store.js` threw
  (`Cannot destructure property 'SEGMENT_STATUS'`). The constants script now
  loads first, and the transcript store fails with an explicit load-order message
  when it is missing. The packaged smoke test now asserts the renderer actually
  booted, its dependency globals exist, its primary controls are wired and no
  uncaught renderer error occurred; the acceptance test now drives the real DOM.
- **An expert edit destroyed the automatic transcript.** The `segments` table
  stored only the current text and the renderer cleared undo history on save, so
  the machine output was lost permanently once an edit was saved. Added
  `segments.original_text`, written once and never overwritten, carried forward
  on every save, with a migration that backfills existing databases. The JSON
  export now includes the automatic text whenever it differs from the current
  text.
- **The Windows CUDA build step reported a false success.** It used
  `continue-on-error: true`, so when the runner had no CUDA toolkit the step
  still showed a green tick over a build that never happened. It now skips
  cleanly, writes the GPU runtime state to the job summary, and still builds the
  CUDA runtime when a toolkit is present.
- **`CHANGELOG.md` had two `## [Unreleased]` sections**, which would have
  produced a malformed release section; consolidated into one.
- **`js-yaml` was an undeclared direct dependency** of
  `scripts/verify-updater-metadata.js`; now declared explicitly.

### Changed

- **The application version is visible in the top bar and in the About dialog.**
- **"Check engine" moved out of the transcription panel into About →
  Diagnostics**, so the transcription workflow shows only what an expert needs.
- The app root no longer uses `aria-hidden` (browsers block it when the subtree
  holds focus); it uses a booting class instead. This removes the
  "Blocked aria-hidden on an element because its descendant retained focus"
  warning.

## [0.1.1] - 2026-10-02

First distributable release: Windows x64 installer, portable zip, offline model
package, `latest.yml` and `SHA256SUMS.txt`.

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

### Added (release hardening)


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

### Changed (release hardening)


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

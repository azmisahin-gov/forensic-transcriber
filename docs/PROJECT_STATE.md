# Project state

CURRENT_PHASE: P14 — professionalization v1 (backend/storage + report/findings/search)
CURRENT_STATUS: IN PROGRESS — Linux release gate met in this environment; Windows/GPU verification outstanding
LAST_UPDATED: 2026-10-03

## P14 — professionalization v1 (unreleased)

Scope: harden the backend/storage and add an expert report workspace on top of
the working v0.2.0 product, without breaking the P12/P13 trust and revision
invariants and without a new runtime dependency. The offline-first guarantee is
unchanged.

Implemented:

- **Report revisions (schema_version 6).** New `report_revisions` append-only
  table; `saveReport()` appends, never silently replaces a `FINAL`
  (`REPORT_FINAL_LOCKED`), and `setCurrentReportRevision()` restores an earlier
  snapshot without deleting later ones. `getReport()` exposes the current
  revision id/state.
- **Findings.** New `findings` table with an explicit evidence + transcript
  revision link; CRUD (`createFinding`/`updateFinding`/`deleteFinding`/
  `listFindings`) with index maintenance.
- **FTS5 search with fallback.** Guarded `search_index` virtual table;
  `searchCase()` uses FTS5 `MATCH` with quoted prefix terms joined AND and falls
  back to a substring scan when FTS5 is unavailable (`this.ftsAvailable`). Index
  hooks on transcript save, note and finding mutations, and evidence imports.
- **Segment paging.** `getSegmentPage()` and `getSegmentAt()` for windowed reads
  of long transcripts.
- **SQL dashboard.** `caseDashboard()` now derives counts with SQL aggregates
  (including findings and report revisions).
- **Archive provenance extension.** Archive v2 also carries notes, findings and
  report revisions; `restoreNote`/`restoreFinding`/`restoreReport` re-create them
  with explicit `old id → new id` remapping, including the finding → restored
  transcript revision link.
- **UYAP hand-off folder.** `prepareUyapPackage()` writes a local report +
  transcript hand-off with a manifest recording the transcript revision per file.
- **Optional local assist (off by default).** `services/assist.js` is a
  deterministic draft builder over the operator's own records; no model, no
  network. `status()` reports `language_model: false`, `network: false`.
- **UI wiring.** Case-header buttons and dialogs for case search, findings,
  report revisions and the UYAP folder, with tr/en strings and CSS.

### Verified in this environment (P14)

- `npm test` → 215 tests, 215 pass, 0 fail (all unit + integration suites).
- `npm run lint` → Lint OK — 66 files.
- `node scripts/security-check.js` → 0 critical findings.
- New regression files, all passing against real services (no mocks):
  `tests/unit/v1-professionalization.test.js` (8 tests: report revision
  append/FINAL-lock/restore, findings + source link, FTS5 + LIKE fallback,
  segment paging, dashboard aggregates, archive provenance remap, UYAP hand-off,
  AI-disabled) and `tests/unit/v1-ui-wiring.test.js` (4 tests: i18n key
  completeness across locales, new DOM ids, renderer bindings, preload APIs).
- `node scripts/verify-release.js --skip-package` → **9/9 gates passed**
  (lint, unit, security, SemVer, lockfile, integration, packaged smoke,
  packaged acceptance — 55 steps, engine capability report). Packaged smoke and
  acceptance ran on the real `release/linux-unpacked` binary with FFmpeg,
  `whisper-cli` v1.9.4, `ggml-large-v3-turbo-q5_0.bin` and
  `ggml-silero-v5.1.2.bin` present. CPU runtime; GPU runtime not bundled.

### Not verified in this environment (P14)

- **Windows build / installer / CI:** not exercised here (no Windows runner
  available in this session). SQLite migration, atomic file operations and path
  handling pass the unit suite on Linux; Windows-only depth is **NOT VERIFIED**.
- **`npm run build:win`:** not run — Windows installer/portable and `latest.yml`
  are produced by a Windows build → **NOT VERIFIED**.
- **GPU (`GPU capable` / `GPU selected` / `GPU actually used`):** not verified on
  target NVIDIA hardware (no RTX 3060 here). The bundled runtime is CPU-only.
- **Long-recording memory (1/4/8 h):** unchanged from P13 — the waveform path
  stays O(buckets); no multi-hour recording was measured here.

## P13 — expert work-station productization (unreleased)

Scope: additively extend the working v0.1.x product toward a 56.12 expert work
station (case intake, dashboard, notes, reports, delivery package, support
bundle, review aids) **without** breaking the P12 trust/revision invariants and
without any new runtime dependency. The offline-first guarantee is unchanged.

Implemented:

- **Case intake / dashboard.** `cases` carries the assignment fields
  (`file_number`, `authority`, `case_type`, `assignment_date`, `due_date`,
  `assignment_description`, `requested_questions`, `scope`); `caseDashboard()`
  derives live counts (evidence, transcribed, reviewed, verified, unclear,
  failed runs, notes, revisions, missing assignment fields). Rendered in a case
  overview panel with an assignment editor.
- **Notes / bookmarks.** Per-case (optionally per-evidence, time-anchored) notes
  with categories, editable and deletable, stored locally only.
- **Review aids.** Per-segment operator flags (`UNCLEAR`/`REVISIT`/`REVIEW`,
  `segments.flags_json`) that never change status or text; a transcript filter
  (unclear / unreviewed / low-confidence) and in-transcript search highlighting;
  F2 edit and F3 flag shortcuts. Pure helpers live in `src/renderer/lib/search.js`
  and `src/renderer/lib/shortcuts.js` and are unit-tested without a DOM.
- **Reports.** Parametric, Ministry-of-Justice-shaped section templates with
  automatic population from verified case data, a data-integrity verdict and a
  delivery-readiness checklist carried into TXT, HTML, DOCX and PDF; a
  technical-work-product disclaimer (no legal assessment is generated).
- **Delivery package and support bundle.** One delivery package (report,
  transcripts, metadata, per-file hashes, source revision per file) and a local,
  redacted support bundle containing no transcript text, audio or evidence.
- **Business-case self-test.** `--business-case-test` drives the whole expert
  workflow (intake → import → transcribe → edit → delivery → report → archive →
  restore → integrity) through the real services with a deterministic injected
  ASR adapter (no model), and also asserts a mid-run failure closes the run as
  `FAILED` and a later machine run does not displace the verified human revision.

### Verified in this environment (P13)

- `npm test` → 203 tests, 203 pass, 0 fail (172 unit + 31 integration; FFmpeg
  7.1.5 present).
- `npm run lint` → Lint OK — 64 files.
- `node scripts/security-check.js` → 0 critical findings.
- `tests/unit/productization.test.js` → 15 tests, all passing, exercising real
  Storage/report/archive/delivery/support code and the real renderer libs. This
  now includes i18n coverage: the tr/en dictionaries expose exactly the same
  keys (338 each), every `data-i18n` key used by `index.html` resolves in both
  locales, and an unknown locale falls back to Turkish.
- **Acceptance self-test (source launch, not the packaged binary):** the existing
  `release/linux-unpacked` binary predates these changes and was **not** rebuilt;
  the acceptance run used the current source via `electron .`:
  `FT_DATA_DIR=/tmp/ft-data-acc FT_MODELS_DIR=…/models xvfb-run -a
  ./node_modules/.bin/electron . --acceptance-test --no-sandbox` → **52/52 steps
  passed**. UI steps assert the dashboard renders live counts, the workflow
  stepper renders eight steps, the runtime panel separates available/selected/
  used, per-segment flags + filter + highlight work, the notes and
  report-checklist panels open and populate, and the locale preference persists
  through `preferences.all()`. Real model `ggml-large-v3-turbo-q5_0.bin` + VAD
  `ggml-silero-v5.1.2.bin`.

### Not verified in this environment (P13)

- **Packaged build / installer (incl. Windows):** neither the Linux nor the
  Windows installer was rebuilt or launched here; `npm run verify:release` was
  not run (its packaged smoke/acceptance gates would use the stale binary) →
  **NOT VERIFIED**.
- **GPU:** not verified on target NVIDIA hardware (no RTX 3060 here).
- **Long-recording memory (1/4/8 h):** the waveform path stays O(buckets); no
  multi-hour recording was measured here.

## P12 — trust/revision hardening (unreleased)

Scope: fix the real P0 transcript state/provenance/data-integrity issues without
a rewrite. No new features.

Implemented:

- **P0-1 run lifecycle.** `runId` is declared before the `try` in the transcribe
  handler; the `catch` always closes an opened run and can no longer raise a
  second exception that masks the original error. Runs end `SUCCEEDED`, `FAILED`
  or `CANCELLED` with `finished_at` set.
- **P0-2/P0-3 transcript revisions.** Append-only `transcript_revisions`
  (schema_version 4), one current revision, run → revision link, machine vs.
  human state. A new ASR run appends a `MACHINE` revision and does not displace a
  current human revision unless the operator promotes it.
- **P0-4 archive provenance.** Archive v2 carries all revisions; restore
  re-creates runs and revisions with explicit `old id → new id` mapping and
  re-links revisions to runs. v1 archives still restore.
- **P0-5 atomic evidence import.** temp → hash/size verify → atomic rename →
  DB insert; failure removes the temp file and leaves no row.
- **P0-6 fail-closed migration backup.** A failed pre-migration backup aborts the
  migration with `MIGRATION_BACKUP_FAILED`; the database is left untouched.
- **P0-7/P0-8 waveform.** Binary-safe (no UTF-8 round-trip) and memory-bounded
  (incremental decimation).
- **P0-9 multi-audio-stream.** `probe()` reports every stream and the selected
  order; `toAsrWav()` accepts an explicit order; the stream count is stored on
  evidence.
- **Export linkage.** JSON/TXT/HTML record the source `transcript_revision`.

### Verified in this environment (P12)

- `npm test` → 188 tests, 183 pass, 5 skipped, 0 fail (was 169/164/5/0).
- `npm run lint` → Lint OK — 55 files.
- `node scripts/security-check.js` → 0 critical findings.
- New regression files: `tests/unit/p0-revision-lifecycle.test.js` (7 tests) and
  `tests/unit/p0-regression.test.js` (12 tests), all passing. These exercise real
  Storage/MediaService/archive code, not mocks; FFmpeg-dependent cases were run
  with FFmpeg 7.1.5 present.
- `npm run verify:release` → 10/10 gates passed (lint, unit, security, version,
  lockfile, integration, package, packaged smoke, packaged acceptance, engine
  report), with `whisper-cli` (v1.9.4), `ggml-large-v3-turbo-q5_0.bin` and
  `ggml-silero-v5.1.2.bin` present.
- **Packaged acceptance self-test:** `--acceptance-test` on the packaged Linux
  build with the real model → 47/47 steps passed, including real re-transcription
  (`revisionBecameCurrent === false`), run-lifecycle terminality, archive
  restore, and export-revision linkage. Previously **NOT VERIFIED**.
- **Windows CI:** `test-windows` job green on the pushed branch — 157 unit tests,
  152 pass, 0 fail, 5 skipped; `security-check.js` 0 critical. Run
  `37127085856` on `azmisahin-gov/forensic-transcriber`.
- Atomic-import failure test made cross-platform (Windows ignores POSIX
  directory permissions, so the old chmod-based failure injection did not fire
  there; the copy call is now failed directly, still through real import code).

### Not verified in this environment (P12)

- **Windows packaged build / installer:** the Windows CI runner runs unit tests
  and the security check only; no Windows installer or packaged-app launch was
  exercised. `latest.yml` updater metadata is produced by a Windows build and
  is not present here → **NOT VERIFIED**.
- **Windows-only behaviour depth:** SQLite migration, atomic file operations and
  path handling pass the unit suite on Windows CI, but no Windows acceptance or
  packaged run was performed.
- **GPU (`GPU capable` / `GPU selected` / `GPU actually used`):** not verified on
  target NVIDIA hardware (no RTX 3060 here). The bundled runtime is CPU-only;
  no GPU claim is made.
- **Long-recording memory (1/4/8 h):** the waveform path is now O(buckets) by
  construction and tested for bounded output, but no multi-hour recording was
  measured here.

## Latest release: v0.1.4

| | |
| --- | --- |
| Version | **0.1.4** (patch from 0.1.3) |
| Tag | `v0.1.4` → commit `a0c8146` |
| Release | https://github.com/azmisahin-gov/forensic-transcriber/releases/tag/v0.1.4 |
| Assets | `ForensicTranscriber-Setup-x64.exe` (192 579 456 B), `ForensicTranscriber-Portable-x64.zip` (260 859 799 B), `ForensicTranscriber-ModelPack-0.1.4.zip` (534 060 311 B), `latest.yml`, `SHA256SUMS.txt` |
| Workflow run | `37114840539` — verify-version, build-windows, model-package, publish all **success** |

v0.1.4 is the **P0 reliability and data-integrity** release: case backup/archive,
database durability, atomic writes, crash-safe migration, evidence
re-verification, transcription-run provenance, failed-operation safety and log
redaction. It also fixes a Windows release blocker (fsync `EPERM` on read
handles) that the earlier v0.1.4 attempt hit, and adds a `windows-latest` unit-test
job to CI so that class of failure is caught before a release.

Release history:

| Release | State |
| --- | --- |
| v0.1.0 | non-distributable (source archives only) |
| v0.1.1 | shipped a dead renderer |
| v0.1.2 | failed when a second recording was added to a case |
| v0.1.3 | first solid multi-evidence release |
| **v0.1.4** | current; adds P0 reliability and integrity hardening |

## Earlier release: v0.1.3

| | |
| --- | --- |
| Version | **0.1.3** (patch from 0.1.2) |
| Tag | `v0.1.3` → `86caabb` (tag object) → commit `95414fb` ("Release 0.1.3") |
| Release | https://github.com/azmisahin-gov/forensic-transcriber/releases/tag/v0.1.3 |
| Assets | `ForensicTranscriber-Setup-x64.exe` (192 560 570 B), `ForensicTranscriber-Portable-x64.zip` (260 835 791 B), `ForensicTranscriber-ModelPack-0.1.3.zip` (534 060 311 B), `latest.yml` (363 B), `SHA256SUMS.txt` (309 B) |
| Workflow run | `37104907862` — version, verify-version, build-windows, model-package, publish all **success** |

v0.1.3 fixes the multi-evidence blocker found in the real Windows test: a second
recording in a case failed with `UNIQUE constraint failed: segments.segment_id`.

Release history:

| Release | State |
| --- | --- |
| v0.1.0 | non-distributable (source archives only) |
| v0.1.1 | shipped a dead renderer |
| v0.1.2 | failed when a second recording was added to a case |
| **v0.1.3** | current; use this or newer |

## Earlier release: v0.1.2

| | |
| --- | --- |
| Version | **0.1.2** (patch from 0.1.1) |
| Tag | `v0.1.2` → `a6ef155` (tag object `a6ef155…`) → commit `95cab00` ("Release 0.1.2") |
| Release | https://github.com/azmisahin-gov/forensic-transcriber/releases/tag/v0.1.2 |
| Assets | `ForensicTranscriber-Setup-x64.exe` (192 568 667 B), `ForensicTranscriber-Portable-x64.zip` (260 846 211 B), `ForensicTranscriber-ModelPack-0.1.2.zip` (534 060 310 B), `latest.yml` (363 B), `SHA256SUMS.txt` (309 B) |
| Workflow run | `37086334972` — version, verify-version, build-windows, model-package, publish all **success** |

Verified after publication:
- `SHA256SUMS.txt` covers all three distributables and `sha256sum -c` passes for
  every downloaded asset.
- `latest.yml` reports `version: 0.1.2`, `path:
  ForensicTranscriber-Setup-x64.exe`, and its **sha512 exactly matches** the
  published installer bytes (checked with `node:crypto`).
- Tag, `package.json`, `package-lock.json` and `latest.yml` all agree on `0.1.2`.
- **The renderer fix is present in the published artifact**: the asar inside the
  portable zip loads `../shared/constants.js` before `lib/transcript-store.js`.
- The packaged app reports version `0.1.2` and contains `original_text`,
  `markBootReady`, the visible version element and the Diagnostics dialog.
- `v0.1.0` and `v0.1.1` tags and releases were **not** modified.

`v0.1.1` shipped a **fatal renderer crash** (the UI never started) and is
superseded; it remains published and untouched for the record.

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
  no CUDA toolkit, so `v0.1.3` ships the **CPU runtime only**. The application
  reports CPU mode and the GPU runtime remains unverified.
- **Not verified on target NVIDIA hardware** (no RTX 3060 available).
- **The Windows installer was not launched on real Windows hardware**; the
  Windows binaries were validated under Wine.
- **No code signing.** The updater's integrity check is the sha512 in
  `latest.yml`, not a publisher signature.
- Accuracy is a **synthetic benchmark**, not a human corpus.

## Next exact action

Install `ForensicTranscriber-Setup-x64.exe` (v0.1.4) on a real Windows x64
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
produce the next patch release, and confirm on a Windows machine that the
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

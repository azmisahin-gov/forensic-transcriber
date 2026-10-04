# DECISIONS

Architecture decision record. Each decision lists the options considered, the
evidence used, and the choice made. Decisions are closed once made.

## D1 — Scope: 56.12, not 56.11

**Context.** The repository is for the Turkish Ministry of Justice expert
classification area 56.12 "Ses Kayıtlarının Metin Haline Dönüştürülmesi". 56.11
"Adli Ses ve Görüntü İnceleme ve Çözümlemeleri" is a separate specialty.

**Decision.** The product implements 56.12 only: transcription of speech into
text plus human review. Speaker identification, voice comparison, biometric
voice recognition, deepfake/manipulation detection, emotion/sentiment/lie
analysis, threat/crime classification and legal interpretation are explicitly
out of scope and are documented as such. Video input is accepted only for its
audio track.

## D2 — Desktop stack: Electron

**Options evaluated (Oct 2026):** Electron 44.x, Tauri 2.x, Wails 2.12, Flutter
Desktop.

**Evidence.**
- Tauri 2 has the strongest security model (capability/permission scoped, `fs`
  closed by default) and the smallest bundles, but its backend is Rust.
- The native runtime for this product is C/C++ (whisper.cpp) and FFmpeg. Both
  are already shipped as child-process binaries, so a Rust backend adds no
  capability we do not already have.
- Electron ships a Chromium/WebCodecs media stack and the `Range`-aware custom
  protocol needed for sample-accurate audio seeking, with a mature
  `electron-builder` NSIS/portable pipeline and well-understood code-signing.
- Electron 44.x is the current stable line (Chromium 150, Node 24).

**Decision.** Electron 44 with `electron-builder` 26. Security is enforced by
the same discipline Tauri would require: `contextIsolation: true`,
`nodeIntegration: false`, a Content-Security-Policy that forbids remote scripts
and network connections, a narrow preload API, no arbitrary filesystem or shell
exposure, and navigation/window-open handlers that hand external links to the OS
browser. A future Rust/Tauri port is not blocked: the main-process services are
plain CommonJS with no Electron dependency except path resolution.

## D3 — ASR engine: whisper.cpp

**Options evaluated:** whisper.cpp v1.9.4, faster-whisper v1.2.1, WhisperX,
plus the hosted-style alternatives (Parakeet, Canary) for reference.

**Evidence.**
- All Whisper-family runtimes load the same weights, so transcription accuracy
  is essentially identical; the choice is about packaging and deployment.
- whisper.cpp is a dependency-free C/C++ implementation with a static binary,
  CUDA support, a native VAD path, quantization and a CPU fallback — exactly the
  profile needed for a single Windows installer with no Python runtime.
- faster-whisper is faster on GPU in Python but requires a Python + PyTorch +
  CUDA stack, which is unacceptable for the end-user packaging constraint
  (section 8: the user must not install Python or CUDA Toolkit).
- whisper.cpp also emits token-level timestamps and per-token probabilities,
  which this product uses for real (not fabricated) confidence values.

**Decision.** whisper.cpp **v1.9.4** (2026-09-11), invoked as `whisper-cli` over
a prepared 16 kHz mono WAV. Engine adapter: `src/main/services/whisper.js`.

## D4 — Model: Whisper large-v3-turbo, q5_0 by default

**Options evaluated:** `large-v3`, `large-v3-turbo` (f16), `large-v3-turbo-q8_0`,
`large-v3-turbo-q5_0`, `small`.

**Evidence (Turkish, FLEURS-TR, published benchmarks).**
| Model | WER % | CER % | Notes |
| --- | --- | --- | --- |
| Whisper large-v3 | 7.08 | 1.50 | Best accuracy, ~2× slower than turbo |
| Whisper large-v3-turbo | 7.75 | 1.66 | Near-large-v3 accuracy, much faster |
| Whisper small | 15.12 | 3.49 | Substantially worse on Turkish |

`large-v3-turbo-q5_0` is 574 041 195 bytes (547 MiB) and fits comfortably in
6 GB VRAM; `q8_0` is 874 188 075 bytes (834 MiB). The size/accuracy trade-off of
q5_0 against f16 is small and the throughput gain is real on the target GPU.

**Decision.** Default model `large-v3-turbo-q5_0`; `q8_0`, f16 and `small`
remain selectable. The default is a starting point, not a claim of "best";
operators can change it per case. See `docs/model-notes.md` for provenance and
`docs/benchmarks.json` for measured numbers.

## D5 — Storage: SQLite via `node:sqlite`

**Options evaluated:** `node:sqlite` (built-in), better-sqlite3, sql.js.

**Decision.** The built-in `node:sqlite` (`DatabaseSync`). It is synchronous,
needs no native rebuild step per platform, and avoids a third-party native
dependency. No server database (PostgreSQL/MongoDB/Redis) is used: cases must
open offline.

## D6 — Media decode: FFmpeg as a child process

**Decision.** FFmpeg/FFprobe are invoked as separate processes with an argument
array (`shell: false`), never a shell string, so a crafted file name cannot be
interpreted as a command. The Windows build ships a pinned, checksum-verified
**LGPL** FFmpeg build; LGPL is sufficient because the binary is executed as a
separate program and not linked into the application.

## D7 — Timestamp contract: original timeline is canonical

**Decision.** Every segment stores `start`/`end` in seconds on the **original**
recording's timeline. The engine's internal chunk/VAD timeline is never exposed.
VAD is used to tighten boundaries to the real speech onsets. An automated
integration test asserts that known spoken events land in their expected
intervals; a failing test blocks the release (see `docs/VERIFICATION.md`).

## D8 — Status model preserves machine vs. expert output

**Decision.** Segments carry `AUTOMATIC | REVIEWED | EDITED | VERIFIED`.
Editing never overwrites the automatic version irrecoverably (undo history keeps
it) and every export reports the status per segment and the count of
human-reviewed segments.

## D8b — Transcript revisions are append-only; a new ASR run never displaces human work

**Decision.** A transcript owns an append-only list of revisions (newest first
in storage, one flagged current). Each revision records its state
(`MACHINE | REVIEWED | EDITED | VERIFIED`), the run that produced it (if any) and
its own segment snapshot. Saving human work (`source: 'review'` or any
`REVIEWED`/`EDITED`/`VERIFIED` segment) appends a new revision and makes it
current. Saving an ASR result appends a `MACHINE` revision; it becomes current
**only if** the transcript has no human current revision (or the operator
explicitly promotes it). The live `segments` rows always mirror the current
revision.

**Why.** The 56.12 core principle is that machine output and expert output must
not overwrite each other. Re-transcribing an evidence item used to overwrite the
reviewed transcript in place; with revisions, run 2 produces a separate readable
revision while the verified human text stays current until the operator chooses
otherwise.

## D9 — Diarization is optional and never identifies people

**Decision.** MVP ships manual speaker labels (`SPEAKER_01`, `SPEAKER_02`, …)
and free-form custom labels. Automatic diarization is a documented roadmap item,
must degrade gracefully, and may only ever emit `SPEAKER_NN` — never a name.

## D9b — Multi-audio-stream containers: first stream, made visible

**Decision.** The decode pipeline selects audio stream order 0 (`-map 0:a:0`) by
default and accepts an explicit `audioStreamOrder`. `probe()` reports every audio
stream and the selected order, and the stream count is stored on the evidence
row. A file with more than one audio stream is therefore visible in the case
rather than silently transcribed from an unstated track.

**Why.** `-map 0:a:0` is a deliberate, documented choice, but a silent choice
for a multi-track recording risks a transcript from the wrong track. Keeping the
default and surfacing the fact is the minimum safe change; selecting among
streams in the UI remains a roadmap item.

## D9c — Waveform is binary-safe and memory-bounded

**Decision.** The waveform pipeline reads FFmpeg's raw `s16le` PCM output as
bytes and decimates it incrementally; it never round-trips PCM through a UTF-8
string. Memory is bounded by the peak-bucket count, not the recording length.

**Why.** Decoding binary output with `Buffer.from(stdout, 'binary')` corrupts
samples that are not valid UTF-8, and buffering the whole decoded stream scales
with the recording length. Both are avoided for a visual aid that must still be
correct and must not spike memory on multi-hour recordings.

## D8c — Reports are technical work products; review aids are non-destructive

**Decision.** The work-station additions (case intake/dashboard, notes, reports,
delivery package, support bundle, per-segment flags, transcript filter/search)
are **additive**. They never generate a legal assessment: the report builders
emit a data-integrity verdict and a delivery-readiness checklist and carry a
technical-work-product disclaimer into every format (TXT/HTML/DOCX/PDF). Review
flags (`UNCLEAR`/`REVISIT`/`REVIEW`) are operator working state stored in
`segments.flags_json`; they never change a segment's text or status. Editing
still goes through the D8/D8b status/revision model unchanged.

**Why.** The product must be usable as a 56.12 expert work station without
weakening the core invariant that machine and expert output never overwrite each
other, and without implying forensic or legal conclusions the software cannot
make. Keeping reports and review aids purely additive preserves the P12 trust
model and the offline-first guarantee (no new dependency; the DOCX/PDF/ZIP/TAR
writers are in-repo).

## D8d — UI is fully localized; Turkish is the default

**Decision.** All operator-facing strings resolve through the in-repo
`src/shared/i18n.js` dictionary (`t(key)`), driven by `data-i18n` attributes in
the markup and `t()` calls in the renderer. Turkish is the default and English is
a complete second locale; both dictionaries must expose exactly the same keys.
An unknown or absent locale falls back to Turkish. No string is left hard-coded
in the renderer.

**Why.** A 56.12 expert work station is used by Turkish Ministry of Justice
experts; a half-translated or partially hard-coded UI is a correctness and trust
problem, not a cosmetic one. Key-for-key parity is enforced by a regression test
so a new string cannot ship in only one language. Keeping the dictionary in-repo
(no runtime dependency, no network fetch) preserves the offline-first guarantee.

## D8e — Report revisions, findings and search are additive provenance

**Context.** The professionalization phase adds a report workspace (draft +
append-only revisions), structured findings, full-text search and a UYAP
hand-off folder. These touch the same "who wrote what" surfaces as the D8/D8b
transcript revision model, so they must not create a second, weaker notion of
history.

**Decision.**

- **Report revisions are append-only.** Saving a report appends a
  `report_revisions` row; the `reports` row is the working draft. A `FINAL`
  report cannot be silently overwritten (`REPORT_FINAL_LOCKED`). Restoring an
  earlier revision (`transcript:set-revision` analogue `report:set-revision`)
  makes it current without deleting later snapshots. Report revision state is a
  **separate** concept from transcript revision state; neither is derived from
  the other.
- **Findings carry an explicit source link.** A `findings` row records the
  evidence and the transcript revision it was observed against, so a finding is
  never re-attached to a different revision by accident, across archive/restore
  included. Findings are observations, not legal conclusions.
- **Search is an index, not a source of truth.** `search_index` (FTS5 when
  available) is a derived cache over segments/notes/findings; it is rebuilt from
  the rows, and a missing FTS5 falls back to a substring scan. A wrong or absent
  index can never change stored data.
- **Archive v2 round-trips all of it.** Notes, findings and report revisions are
  carried in the archive and re-created on restore with explicit `old id → new
  id` remapping, including the finding → restored transcript-revision link.

**Why.** The core invariant is that machine and expert output never silently
overwrite each other. Extending that invariant to reports (append-only) and
findings (source-linked) keeps one consistent provenance story at every
lifecycle stage — live, saved, archived, restored, exported — while staying
dependent only on in-repo infrastructure (no new runtime dependency, no
network).

## D8f — The public site is Turkish-first and release-derived

**Context.** The GitHub Pages site is the only public description and download
portal. It previously defaulted to English and hard-coded a release version
(`0.1.0`), so the download buttons and the quoted version drifted from the
actual release.

**Decision.**

- The site defaults to **Turkish** (matching the D8d localization default) with
  an optional English section toggled on the client; the language choice is not
  persisted to any server.
- Download links use GitHub's stable `releases/latest/download/<asset>` path, and
  the release version, release notes and the model-package asset name are read
  from the public Releases API at load time. No version is hard-coded.
- The asset names the page links to match exactly what the release workflow
  publishes (`ForensicTranscriber-Setup-x64.exe`,
  `ForensicTranscriber-Portable-x64.zip`,
  `ForensicTranscriber-ModelPack-<version>.zip`, `SHA256SUMS.txt`), so the page
  cannot silently point at a non-existent file.
- The site carries the same scope disclaimers as the application (56.12, not
  56.11; no speaker identification, no legal opinion) and states that it is a
  static download portal that must never receive case material.

**Why.** A public download page that advertises a stale version or a dead link
erodes trust in a forensics tool; deriving both from the release itself keeps the
page correct without a manual edit on every release. A regression test asserts
the Turkish default and the absence of a hard-coded version.

## D8g — The expert analysis layer is separate from the transcript

**Context.** The design plan (PR-3) adds a workspace for the expert's own
reading of a recording: the critical passages they flag, the claims they record,
the external sources they cite and the verification status of each claim. This
sits close to the transcript, so it is the most likely place for the core
invariant — machine output and expert work never silently overwrite each other —
to be broken by a shortcut such as storing expert notes back onto transcript
segments.

**Decision.**

- **The analysis layer is its own set of rows** (`passages`, `claims`, `sources`,
  `verifications`, schema_version 7). It never writes to `segments`,
  `transcripts` or `transcript_revisions`. The transcript stays the machine +
  human-review artifact; the analysis layer is the expert's interpretation of it.
- **A passage is anchored, not floating.** It records the evidence, the transcript
  and the exact `revision_id` it was taken from, so a later ASR run cannot
  re-attach it to different text. It also carries a mandatory positive context
  window (`context_before_seconds` / `context_after_seconds`): a passage without
  its surrounding audio is refused (`CONTEXT_REQUIRED`).
- **A claim separates what was said from what is alleged.** `as_stated` and
  `alleged_meaning` are distinct columns, and `asserted_by` records who makes the
  claim. The application never computes a legal conclusion from them; a claim is
  a structured record, not an assessment.
- **Vocabulary is fixed.** `speech_act`, `confidence` and `verification` are
  validated against fixed enumerations; an unknown value is refused
  (`INVALID_INPUT`) rather than stored. Evidence links are checked to belong to
  the same case (`EVIDENCE_MISMATCH`).
- **Archive v3 carries the layer.** Passages, claims, sources, verifications and
  the case history log round-trip through archive/restore with explicit
  `old id → new id` remapping; v1 and v2 archives remain readable. Restore still
  writes a new case and re-verifies every evidence hash.

**Why.** The value of an expert review is that its statements are traceable to
the exact audio and the exact transcript revision they were made against. Keeping
that as a separate, revision-anchored graph — instead of annotations on the
transcript — preserves the machine/expert separation at every lifecycle stage
and keeps the schema change additive (no rewrite, no data migration of existing
rows).

## D10 — Repository layout

Single repository, single application. `src/main`, `src/renderer`,
`src/shared`, `scripts`, `tests`, `site`, `docs`. No package explosion. The
original suggested `app/` directory is realized as `src/`.

## D11 — GPU runtime: two binaries, probe-verified selection

**Context (release-hardening audit).** The first release shipped a CPU-only
`whisper-cli.exe` while the documentation said GPU support existed. Verified by
running the packaged binary: `devices = 1`, `backends = 1`,
`device 0: CPU (type: 0)`, `no GPU found`. The `-ng`/`-dev` options appear in
`--help` on every build, so their presence proves nothing.

**Decision.** Ship two runtimes and select between them by evidence:

```
vendor/<os>-<arch>/bin/whisper-cli(.exe)        CPU runtime — always present
vendor/<os>-<arch>/bin/gpu/whisper-cli(.exe)    CUDA runtime — optional
vendor/<os>-<arch>/bin/gpu/cudart64_*.dll       CUDA redistributables (EULA Attachment A)
vendor/<os>-<arch>/bin/gpu/cublas64_*.dll
vendor/<os>-<arch>/bin/gpu/cublasLt64_*.dll
```

Selection (`src/main/services/runtime-selector.js`) uses the engine's own
device/backend report, never the host's hardware:

- operator chose CPU → CPU runtime;
- no GPU runtime bundled → CPU runtime (`GPU_RUNTIME_NOT_BUNDLED`);
- GPU runtime bundled but not CUDA-capable → CPU runtime (`GPU_BINARY_NOT_CUDA`);
- CUDA-capable but no GPU device enumerated → CPU runtime (`NO_GPU_DEVICE`);
- CUDA-capable with a GPU device enumerated → GPU runtime (`GPU_AVAILABLE`).

The chosen mode and reason are reported in the UI, in the case history and by the
`--engine-report` self-test.

**Why two binaries instead of one.** A single CUDA-enabled binary would require
shipping the CUDA runtime DLLs to every user, including those without an NVIDIA
GPU, enlarging the installer and adding a large third-party payload for no
benefit. Two binaries keep the universal fallback small and self-contained.

**Why the CUDA binary is built in CI, not here.** The CUDA compiler (`nvcc`)
and an NVIDIA toolchain are required; they are not available in the Linux build
environment and cannot be cross-compiled. The CUDA runtime is therefore built on
the `windows-latest` runner (`scripts/build-whisper-cuda-windows.cmd`,
`.github/workflows/release.yml`) and staged only if that build succeeds. When it
does not, the release ships the CPU runtime and the application reports CPU mode
— it never claims GPU support it does not have.

**Redistribution.** `cudart64_*`, `cublas64_*` and `cublasLt64_*` are listed as
redistributable in the NVIDIA CUDA Toolkit EULA, Attachment A. They are copied
from the CUDA Toolkit install by the build script; they are never committed to
this repository.

## Rejected alternatives (summary)

| Rejected | Reason |
| --- | --- |
| Tauri/Wails | Rust/Go backend adds no capability; the native runtime is already C/C++. |
| faster-whisper / WhisperX | Requires Python + PyTorch + CUDA on the end-user machine. |
| Bundling models in the installer | Inflates every download; models change independently. Offline package instead. |
| Committing models to the repository | Binary bloat and license mixing; models have their own provenance. |
| Server database / cloud | Violates the offline-first, no-account requirement. |
| Browser (WebGPU) transcription | WebGPU is not baseline across browsers; the real workflow must be a desktop app. |
| One CUDA-only binary | Forces the CUDA runtime DLLs onto every user, including those without an NVIDIA GPU. |
| Claiming GPU support from `-ng`/`useGpu` | Those exist in every build and prove nothing about capability. |

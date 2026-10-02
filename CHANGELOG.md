# Changelog

All notable changes to this project are documented here.
Format based on Keep a Changelog; the project follows Semantic Versioning.

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

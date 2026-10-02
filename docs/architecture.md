# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Renderer (Chromium, sandboxed, CSP-locked)                          │
│   index.html · styles.css · renderer.js                             │
│   lib/transcript-store.js  lib/audio.js  lib/waveform.js            │
└───────────────▲──────────────────────────────┬──────────────────────┘
                │ contextBridge (window.ft)    │ ft-media:// (audio)
┌───────────────┴──────────────────────────────┴──────────────────────┐
│ Preload (src/main/preload.js) — narrow, explicit IPC surface        │
└───────────────▲─────────────────────────────────────────────────────┘
                │ ipcMain.handle
┌───────────────┴─────────────────────────────────────────────────────┐
│ Main process (src/main/main.js)                                     │
│   Storage (SQLite)   Media (FFmpeg)   ModelManager   WhisperAdapter │
└───────┬──────────────────┬──────────────────┬───────────────────────┘
        │                  │                  │
   case.db            ffmpeg/ffprobe      whisper-cli
   case folders       (child process,     (child process,
   (original/         shell:false)        shell:false)
    derived/transcript/exports)
```

## Processes and trust boundaries

- **Renderer** has no Node access (`nodeIntegration: false`,
  `contextIsolation: true`). It can only call the functions exposed on
  `window.ft`. A Content-Security-Policy forbids remote scripts and all network
  connections (`connect-src 'none'`); the only media source is `ft-media:`.
- **Preload** exposes a fixed, small API. No generic filesystem, shell or
  network primitive is exposed.
- **Main** owns the database, the case folders and all child processes. Child
  processes are spawned with an argument array and `shell: false`.

## Media access

Audio playback uses a custom `ft-media:` protocol registered as standard,
secure, fetch- and stream-capable. It resolves **only** an `evidence_id` that
exists in the local database and serves that file with HTTP `Range` support so
the player can seek. Arbitrary paths are never exposed to the renderer.

## Data model (SQLite)

| Table | Purpose |
| --- | --- |
| `meta` | schema version |
| `cases` | case id, title, notes, case directory, timestamps |
| `evidence` | imported file, metadata, SHA-256, original/derived paths |
| `transcripts` | one per (case, evidence), language, model, engine |
| `segments` | ordered segments with start/end, speaker, text, status, confidence, words |
| `history` | append-only action log (provenance/traceability) |

The database is opened with `journal_mode=WAL` and `foreign_keys=ON`. Deletes
cascade from case → evidence → transcript → segments.

## Case folder layout

```
<userData>/cases/<CASE-ID>/
  evidence/original/   imported copy (never modified)
  evidence/derived/    16 kHz mono WAV working copy for the ASR engine
  transcript/          reserved for transcript side files
  exports/             generated JSON / TXT / SRT / HTML
```

The original and derived files are kept separate and clearly named.

## Transcription pipeline

1. Probe the original with `ffprobe` → metadata for the case record.
2. Decode to 16 kHz mono PCM WAV with `ffmpeg` into `evidence/derived/`.
3. Run `whisper-cli` with the selected model, language `tr`, optional Silero VAD
   and optional GPU (`-ng` disables it for the CPU fallback).
4. Parse the JSON output: per-segment text, `start`/`end` on the original
   timeline, mean token probability as confidence, and token-derived words.
5. Persist segments with status `AUTOMATIC`.

Progress is parsed from the engine's `progress = NN%` lines and streamed to the
renderer. Cancellation aborts the child process; the job registry prevents
concurrent runs and aborts everything on quit.

## Timestamp contract

`segment.start` / `segment.end` are seconds on the **original** recording. The
engine's internal chunking is never surfaced. VAD tightens boundaries to real
speech onsets. This is verified by an integration test against known spoken
events (see `docs/VERIFICATION.md`).

## Error handling

Every IPC handler returns `{ ok, data }` or `{ ok, error: { code, message, detail } }`.
Errors carry a stable `code` (for example `MODEL_NOT_INSTALLED`,
`DECODE_FAILED`, `PROBE_FAILED`, `TRANSCRIPTION_CANCELLED`) so the UI can react
without string matching. Child-process output is capped to protect against a
hostile file producing unbounded output.

## Offline-first

The application performs no network activity during normal operation. The only
outbound call is the explicit model download in `model-manager.js`, which
verifies a SHA-256 before accepting a file. `scripts/security-check.js` enforces
that no other module uses a network API.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `src/main/main.js` | window, IPC, media protocol, orchestration, self-tests |
| `src/main/preload.js` | `window.ft` API |
| `src/main/services/storage.js` | SQLite schema and all persistence |
| `src/main/services/media.js` | FFmpeg/FFprobe, safe process execution, waveform |
| `src/main/services/model-manager.js` | model download/verify/import |
| `src/main/services/whisper.js` | ASR adapter and output parsing |
| `src/main/services/exporter.js` + `exports.js` | export rendering and writing |
| `src/main/services/logger.js` | local file logging |
| `src/main/services/paths.js` | binary and data directory resolution |
| `src/renderer/*` | UI, editor, player, waveform |
| `src/shared/*` | constants and model registry (used by both sides) |

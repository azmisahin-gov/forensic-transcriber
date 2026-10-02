# AGENTS.md

Persistent memory for automated agents and contributors working in this
repository. Read this first.

## What this repository is

A local-first desktop application (Electron) that turns audio recordings into
time-aligned transcripts for the Turkish Ministry of Justice expert area
**56.12 — Ses Kayıtlarının Metin Haline Dönüştürülmesi**, with human review and
export. It is **not** a 56.11 forensic audio/video analysis system.

## Non-negotiable rules

1. **Scope.** No speaker identification, voice comparison, biometric voice
   recognition, deepfake/manipulation detection, emotion/sentiment/lie analysis,
   threat/crime classification, or legal interpretation. Video is accepted only
   for its audio track.
2. **Machine ≠ expert.** Never collapse `AUTOMATIC` output into expert output.
   Keep the four statuses and preserve the automatic text in undo history.
3. **No legal claims.** Do not write that the software produces a legally valid
   report, provides a chain of custody, replaces an expert report, or is accepted
   by a court. Call hashes/logs "software provenance/traceability features".
4. **Offline-first.** No telemetry, analytics, login, account, cloud storage or
   audio upload. The only outbound call is the explicit model download.
5. **Security.** `contextIsolation: true`, `nodeIntegration: false`, strict CSP,
   narrow preload API, `spawn(bin, args[], { shell: false })`, no arbitrary
   filesystem or network exposure.
6. **No false verification.** Never write "tested"/"works"/"production ready"
   unless a real command produced that result. Report the actual status.
7. **No models or binaries in git.** `models/*.bin` and `vendor/` are ignored;
   they are fetched or built. Only synthetic fixtures live in `tests/fixtures`.

## Build, test, run

```bash
npm install
npm test                                   # unit tests (fast, no external tools)
npm run lint                               # syntax + safety rules
node scripts/security-check.js             # release security checks
npm start                                  # run the app
npm run build:win                          # Windows installer + portable + checksums
```

Integration tests need FFmpeg and a whisper.cpp build:

```bash
FT_WHISPER_CLI_PATH=/path/to/whisper-cli \
FT_TEST_MODEL=/path/to/ggml-large-v3-turbo-q5_0.bin \
FT_TEST_VAD=/path/to/ggml-silero-v5.1.2.bin \
node --test tests/integration/*.test.js
```

Packaged-app self-tests:

```bash
FT_DATA_DIR=/tmp/ft-data FT_MODELS_DIR=/path/to/models \
  xvfb-run -a ./release/linux-unpacked/forensic-transcriber --smoke-test --no-sandbox
FT_DATA_DIR=/tmp/ft-data FT_MODELS_DIR=/path/to/models \
  xvfb-run -a ./release/linux-unpacked/forensic-transcriber --acceptance-test --no-sandbox
```

## Key files

| Path | What it does |
| --- | --- |
| `src/main/main.js` | window, IPC, media protocol, orchestration, self-tests |
| `src/main/services/storage.js` | SQLite schema and persistence |
| `src/main/services/media.js` | FFmpeg/FFprobe, safe spawn, waveform |
| `src/main/services/whisper.js` | ASR adapter, output parsing, confidence, runtime probe |
| `src/main/services/runtime-selector.js` | chooses CPU vs CUDA runtime by engine evidence |
| `src/main/services/model-manager.js` | model download/verify/import |
| `src/main/services/exporter.js` + `exports.js` | export rendering |
| `src/renderer/renderer.js` | UI orchestration |
| `src/renderer/lib/transcript-store.js` | edit/split/merge + undo/redo |
| `src/shared/constants.js`, `src/shared/model-registry.js` | shared, UMD |

## Conventions

- `src/shared/*` and `src/renderer/lib/*` are UMD (work in Node and the browser).
  `src/main/*` is plain CommonJS.
- IPC handlers return `{ ok, data }` or `{ ok, error: { code, message, detail } }`.
  Use stable error `code`s, not string matching.
- Comments explain *why*, not *what*. Avoid narrating changes.
- Prefer editing existing files; do not create parallel versions.

## GPU / runtime rules

- Never claim GPU support from the presence of `-ng`/`-dev` in `--help` or from a
  `useGpu` flag. Every build has those.
- The only trustworthy capability signal is the engine's own report:
  `devices`, `backends`, `device N: <name> (type: T)` and the `system_info:` line
  (`CUDA :` registration). `parseRuntimeProbe()` reads exactly this.
- The CPU runtime always ships and is the universal fallback. The CUDA runtime is
  optional (`bin/gpu/`) and is used only when it loads a GPU backend.
- GPU capability and GPU selection are separate facts. Report both.
- If GPU behaviour cannot be verified (no NVIDIA hardware), mark it
  `Not verified on target NVIDIA hardware`. Never fabricate a GPU result.

## Phase workflow (from the original task)

Read `docs/PROJECT_STATE.md`, `docs/DECISIONS.md`, `docs/VERIFICATION.md` at the
start of work. Update them (and `CHANGELOG.md`) and commit at the end. If work is
interrupted, record `CURRENT_PHASE`, `COMPLETED`, `IN_PROGRESS`, `BLOCKER`,
`NEXT_EXACT_ACTION`, `VERIFICATION_STATUS` honestly — never mark COMPLETE
without a real test run.

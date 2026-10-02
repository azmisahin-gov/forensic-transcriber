# Final implementation report

STATUS: **COMPLETE WITH KNOWN LIMITATIONS**

VERSION: 0.1.0

COMMIT: see the repository's initial release commit (this document ships with it)

ASR ENGINE: whisper.cpp v1.9.4 (2026-09-11), invoked as `whisper-cli` over a
16 kHz mono WAV working copy. Adapter: `src/main/services/whisper.js`. Two
runtimes: a static CPU binary and an optional CUDA binary.

MODEL: Whisper **large-v3-turbo**, quantization **q5_0** by default
(`ggml-large-v3-turbo-q5_0.bin`, 574 041 195 bytes).

MODEL REVISION: `ggerganov/whisper.cpp` `main`, verified 2026-10;
SHA-256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`.

DIARIZATION: not included (MVP scope). Manual speaker labels
(`SPEAKER_01`, `SPEAKER_02`, …). Automatic diarization is a roadmap item and may
only ever produce anonymous labels.

DESKTOP STACK: Electron 44.5.1, packaged with electron-builder 26.15.3.

DATABASE: SQLite via the built-in `node:sqlite` (`DatabaseSync`), WAL mode,
foreign keys on. Local only; no server database.

AUDIO DECODER: FFmpeg / FFprobe as separate processes. Windows ships a pinned,
checksum-verified **LGPL** build
(`ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1`).

WINDOWS BUILD: `npm run build:win` → one command. Cross-builds a fully static
`whisper-cli.exe` (mingw-w64, only ADVAPI32/KERNEL32/msvcrt), fetches the pinned
FFmpeg, runs unit tests, packages, and writes checksums.

INSTALLER: `ForensicTranscriber-Setup-x64.exe` (NSIS, x64), 193 125 697 bytes,
SHA-256 `598cbca708ae8ad68a70cbabdea68bcecb9c23a32a4272aed820308b86f2db5e`.
Built successfully by `npm run build:win`. It was **not installed on real Windows
hardware** in this environment (Linux); the installer payload (app + vendored
`whisper-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`) was verified, and the Windows
application binaries were validated under Wine.

PORTABLE BUILD: `ForensicTranscriber-Portable-x64.zip`, 261 620 674 bytes,
SHA-256 `4806da0a0b2ac16a2caf8d23aa6e1c347b6deee7a284249e62266e61ac57c10a`.
Built successfully; contains `Forensic Transcriber.exe` and
`resources/vendor/bin/{whisper-cli.exe,ffmpeg.exe,ffprobe.exe}`. Not launched on
real Windows hardware in this environment.

OFFLINE MODEL PACKAGE: `ForensicTranscriber-ModelPack-0.1.0.zip`, 534 060 311
bytes, SHA-256 `ef4ff3aa9dbd77d2431d7ff3305e99c33b57dd9bd5d01a9d719bfcda1ef03a1e`.
Built by `scripts/build-model-package.js`: default ASR + VAD models, a
checksummed `manifest.json`, and a README. Model files are verified against
`docs/model-notes.md` before being included.

RELEASE DISTRIBUTABILITY: the artefacts above were built and checksum-verified in
this environment. The published **v0.1.0 GitHub Release is not distributable**:
the Windows release workflow did not complete, so the release currently contains
only GitHub's automatic source archives and **no** `.exe`, portable `.zip`, model
package or `SHA256SUMS.txt`. Do not treat v0.1.0 as a usable download until that
workflow succeeds and attaches those assets.

GITHUB PAGES: `site/` (static documentation + download portal). No audio
processing on the site; the download button points at the latest release asset.
Publishing requires enabling Pages for the repository (a repository setting).

OFFLINE MODE: yes. No telemetry, no analytics, no login, no cloud, no audio
upload. The only outbound call is the explicit, checksum-verified model download.

GPU: two-runtime architecture. The CPU runtime always ships; an optional CUDA
runtime (`bin/gpu/whisper-cli.exe` + `cudart64_*`, `cublas64_*`, `cublasLt64_*`
DLLs, CUDA EULA Attachment A) is staged by the release workflow when the CUDA
build on `windows-latest` succeeds. Selection is by the engine's own
device/backend report (`src/main/services/runtime-selector.js`), never by the
host having an NVIDIA device. **Not verified on target NVIDIA hardware** — no
NVIDIA GPU or CUDA toolkit in the build environment. The application reports the
real runtime mode on the user's machine via `--engine-report` / **Check engine**.

CPU FALLBACK: verified. A GPU request on a CPU-only build and on a machine with
no GPU completed successfully on CPU, with the selection reason recorded
(`GPU_RUNTIME_NOT_BUNDLED`).

BENCHMARK RESULTS (CPU only, 4 vCPU, no GPU):

| Model | Audio | Processing | RTF | Peak RSS |
| --- | --- | --- | --- | --- |
| large-v3-turbo-q5_0 | 60 s | 71.29 s | 1.188 | 854 MB |
| large-v3-turbo-q5_0 | 300 s | 362.41 s | 1.208 | 950 MB |
| small-q5_1 | 60 s | 24.49 s | 0.408 | 533 MB |
| small-q5_1 | 300 s | 207.41 s | 0.691 | 614 MB |

Raw data: `docs/benchmarks.json`. No VRAM figure is reported (no GPU present).

WER / CER RESULTS (synthetic Turkish TTS fixture, 25 words):

| Model | WER | CER |
| --- | --- | --- |
| large-v3-turbo-q5_0 | 64.0 % | 42.98 % |
| small-q5_1 | 188.0 % | 27.27 % |

The headline WER is dominated by number rendering (the large model wrote `145`
for `on dört sıfır beşte`; the small model spelled digits letter-by-letter,
pushing WER above 100 %). On the first sentence alone (no numbers) the large
model measured **25.0 % WER / 5.0 % CER**. Small sample and synthetic audio; not
generalisable. Published FLEURS-TR benchmarks (large-v3 7.08 %, turbo 7.75 %,
small 15.12 %) were the basis for the model decision and are recorded in
`docs/DECISIONS.md`.

TEST RESULTS:

- Unit tests: **42/42 pass.**
- Integration tests (pipeline + timestamp contract): **4/4 pass.**
- Red-team tests: **15/15 pass.**
- Lint: **35 files, 0 problems.**
- Packaged-app smoke test: **11/11 pass.**
- Packaged-app acceptance test: **20/20 pass.**
- Engine capability report: CPU runtime confirmed; GPU runtime correctly
  reported as not bundled in this build; run mode CPU.

VALIDATION TIERS:

- Automated validation — complete (all gates above).
- Target-machine validation — **not performed** (no Windows host with an RTX
  3060 here).
- Real-world human corpus validation — **not performed**; accuracy figures are a
  **synthetic benchmark** (espeak-ng TTS), not a human corpus.

SECURITY REVIEW: 0 critical findings. Renderer sandboxed
(`contextIsolation`, no `nodeIntegration`), strict CSP, narrow preload API,
scoped `ft-media:` protocol, `spawn(bin, args[], { shell:false })`, bounded child
output, sanitised file names, checksum-verified models. No telemetry, no
analytics, no hidden network calls, no hardcoded credentials. See
`docs/security.md`.

LICENSE REVIEW: application code **AGPL-3.0-only**. Bundled Electron and
whisper.cpp are MIT; FFmpeg is LGPL (executed as a separate process, not linked);
Whisper and Silero models are MIT. Details in `THIRD_PARTY_NOTICES.md`.

THIRD-PARTY REVIEW: every distributed component and model is recorded with
version, license, source and purpose in `THIRD_PARTY_NOTICES.md`; models are
recorded with size, revision and SHA-256 in `docs/model-notes.md`. Model licenses
are treated as separate from the code license.

KNOWN LIMITATIONS:

1. **Not verified on target NVIDIA hardware.** No NVIDIA GPU or CUDA toolkit was
   available, so the CUDA runtime could not be compiled or exercised here. It is
   built on the `windows-latest` CI runner. The application reports the real
   runtime mode on the target machine.
2. The Windows NSIS installer and portable zip were not launched on real Windows
   hardware here; the Windows binaries were validated under Wine instead.
3. Accuracy figures are a synthetic benchmark (espeak-ng TTS), not a human corpus.
4. No PDF export.
5. No automatic diarization.
6. The executable is not code-signed.

NEXT STEPS: run `npm run build:win` on Windows (or let the release workflow run),
install the NSIS artefact, then run the target-machine acceptance scenario in
`docs/RELEASE_CHECKLIST.md` — including `--engine-report` on the RTX 3060 — and
record the observed GPU mode in `docs/VERIFICATION.md`.

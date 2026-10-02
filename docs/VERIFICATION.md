# Verification

Every result below comes from a command actually run in the build environment on
2026-10-02. Nothing here is asserted without a command behind it.

## Environment

| Item | Value |
| --- | --- |
| OS | Debian GNU/Linux 13 (trixie), kernel 6.8 |
| CPU | AMD EPYC 9B14, 4 vCPU |
| RAM | 15 990 MB |
| GPU | none (no NVIDIA device present) |
| Node.js | 24.21.0 |
| Electron | 44.5.1 |
| FFmpeg / FFprobe | 7.1.5 (host, integration tests) |
| whisper.cpp | v1.9.4, built from pinned source |

## 1. Unit tests

Command: `node --test tests/unit/*.test.js`

Result: **28 passed, 0 failed.** Covers the transcript store (edit/split/merge,
undo/redo, status rules, the "never invent words" placeholder), exports (SRT time
formatting, JSON schema and status distinction, HTML escaping and
self-containment) and storage (case layout, hashing without modifying the
original, name sanitisation, ordering validation, persistence across reopen,
cascade delete).

## 2. Integration tests — pipeline and timestamp contract

Command:
```
FT_WHISPER_CLI_PATH=.../whisper-cli \
FT_TEST_MODEL=.../ggml-large-v3-turbo-q5_0.bin \
FT_TEST_VAD=.../ggml-silero-v5.1.2.bin \
node --test tests/integration/pipeline.test.js
```

Result: **4 passed, 0 failed.**

The load-bearing timestamp test uses `tests/fixtures/tr-offset.wav`, which is a
3.0 s silence followed by one utterance. If the ASR timeline were reset to the
start of speech instead of the original recording, the reported start would be
~0 s. Measured:

| Fixture | Expected interval | Measured (large-v3-turbo-q5_0 + VAD) |
| --- | --- | --- |
| tr-offset.wav (utterance after 3.0 s silence) | 3.000 – 7.383 s | 2.980 – 6.920 s |

The full pipeline test also ran import → decode → ASR → save → reopen → export
over `tests/fixtures/tr-known-events.wav`; segments were ordered, non-overlapping
and positive-length, all `AUTOMATIC`, and the original file's SHA-256 was
unchanged after import and after creating a derived working copy. All four export
formats were written and the JSON reopened matched the stored transcript.

**Note on segmentation.** Whisper merges short separated utterances into a single
segment regardless of the silence between them (a known Whisper behaviour). The
fixture therefore measures the timeline anchor precisely rather than asserting a
particular segment count. Operators split merged segments in the review
workspace.

## 3. Red-team / hostile input

Command: `node --test tests/integration/redteam.test.js`

Result: **15 passed, 0 failed.** Each adverse case produced a controlled,
structured error rather than a crash:

| Case | Observed behaviour |
| --- | --- |
| Corrupt audio | `PROBE_FAILED`; import still succeeds and is flagged |
| Empty file | `PROBE_FAILED`; recorded with size 0 |
| Random / unsupported data | `PROBE_FAILED`, no hang |
| Unicode / Turkish file name | Preserved and importable |
| Path traversal in name | Stored leaf name sanitised; cannot escape case dir |
| Duplicate file name | Both kept, distinct ids and paths |
| Read-only export dir | Permission error surfaced, no crash |
| Missing model | `MODEL_NOT_INSTALLED` |
| Invalid edits | `INVALID_SEGMENTS` for non-array, out-of-order, inverted, NaN |
| ASR on non-audio | `DECODE_FAILED` before ASR |
| Cancel mid-transcription | `TRANSCRIPTION_CANCELLED` |
| GPU requested, none present | Fell back to CPU and still succeeded |
| Database corruption | Garbage file rejected at open |
| Restart during work | Case and edit intact after reopen |
| Case delete | Cascades to evidence, transcripts, history |

## 4. Lint and security

- `node scripts/lint.js` → **Lint OK — 25 files checked** (syntax plus
  no-shell, no-eval, no-remote-script, no-hardcoded-secret, no-telemetry rules).
- `node scripts/security-check.js` → **0 critical findings.** Confirmed:
  no telemetry dependency, the only outbound network path is the model
  downloader, all child processes use `spawn(bin, args[])` with `shell:false`,
  no hardcoded credentials, only synthetic fixtures present, no secret files.

## 5. Packaged application self-tests

### Automated release gate

Command:
```
FT_MODELS_DIR=... FT_WHISPER_CLI_PATH=... node scripts/verify-release.js --skip-package
```

Result: **7/7 gates pass.**

```
PASS  lint
PASS  unit tests
PASS  security check
PASS  integration tests
PASS  packaged smoke test
PASS  packaged acceptance test — 20 steps
PASS  release artefacts + checksums — ForensicTranscriber-ModelPack-0.1.0.zip,
      ForensicTranscriber-Portable-x64.zip, ForensicTranscriber-Setup-x64.exe
```

Release artefacts (built by `npm run build:win` and
`node scripts/build-model-package.js`):

| Artefact | Bytes | SHA-256 |
| --- | --- | --- |
| `ForensicTranscriber-Setup-x64.exe` | 193 125 697 | `598cbca708ae8ad68a70cbabdea68bcecb9c23a32a4272aed820308b86f2db5e` |
| `ForensicTranscriber-Portable-x64.zip` | 261 620 674 | `4806da0a0b2ac16a2caf8d23aa6e1c347b6deee7a284249e62266e61ac57c10a` |
| `ForensicTranscriber-ModelPack-0.1.0.zip` | 574 927 571 | `ef4ff3aa9dbd77d2431d7ff3305e99c33b57dd9bd5d01a9d719bfcda1ef03a1e` |

`release/SHA256SUMS.txt` lists all three. The portable zip contains
`Forensic Transcriber.exe` and `resources/vendor/bin/{whisper-cli.exe,ffmpeg.exe,ffprobe.exe}`.

### Smoke test

Command:
```
FT_DATA_DIR=... FT_MODELS_DIR=... xvfb-run -a \
  ./release/linux-unpacked/forensic-transcriber --smoke-test --no-sandbox
```

Result: `{"ok":true, ...}` — **9/9 steps**: window loaded, preload API exposed,
`app.info` resolves, database open, FFmpeg available, FFprobe available, case
create, case persisted, model registry readable.

### Acceptance test

Command:
```
FT_DATA_DIR=... FT_MODELS_DIR=... xvfb-run -a \
  ./release/linux-unpacked/forensic-transcriber --acceptance-test --no-sandbox
```

Result: `{"ok":true, ...}` — **20/20 steps**:

| Step | Result |
| --- | --- |
| Fresh launch | ok |
| Create case | ok |
| Import recording | ok |
| Metadata visible | ok |
| SHA-256 visible | ok |
| Audio stream reachable (`ft-media:` Range request) | ok — HTTP 206, `audio/wav`, 1024 bytes |
| Model installed | ok |
| Transcribe | ok |
| Turkish transcript produced (≥3 segments) | ok |
| Segments are automatic | ok |
| Segments carry timestamps | ok |
| Edit + save | ok |
| Reopen: edit persists | ok |
| Reopen: automatic preserved | ok |
| Export (4 formats) | ok |
| Export json/txt/srt/html written | ok |
| Export json matches stored transcript | ok |

## 6. Windows x64 runtime

whisper.cpp v1.9.4 was cross-compiled with mingw-w64 as a **fully static** binary.

```
$ x86_64-w64-mingw32-objdump -p whisper-cli.exe | grep "DLL Name"
  ADVAPI32.dll
  KERNEL32.dll
  msvcrt.dll
```

Only Windows system DLLs are required (no `libgomp-1.dll`, `libstdc++-6.dll` or
`libgcc_s_seh-1.dll`).

Functional check under Wine:

```
$ wine whisper-cli.exe --version
whisper.cpp version: 1.9.4-dev

$ wine whisper-cli.exe -m ggml-small-q5_1.bin -f simple.wav -l tr -oj -np
[00:00:00.000 --> 00:00:04.500]   Merhaba, bu bir hali ses kaydı inceleme testi di.
[00:00:05.800 --> 00:00:09.500]   Kayıt satondort sihirbeste basamış di.
[00:00:11.300 --> 00:00:16.500]   Telefon numara sibesi uzatu ziki, kirk bir, seksen yedi.
```

The Windows binary decodes audio and produces Turkish output with timestamps.

FFmpeg for Windows is a pinned, checksum-verified LGPL build
(`ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1`), staged by
`scripts/fetch-runtime-windows.js`.

## 7. Benchmarks (RTF, memory)

Command:
```
FT_WHISPER_CLI_PATH=.../whisper-cli node scripts/benchmark.js \
  --models-dir models --audio tr-1min.wav --audio tr-5min.wav \
  --models large-v3-turbo-q5_0,small-q5_1 --device cpu
```

Raw output: `docs/benchmarks.json`.

| Model | Audio | Processing | RTF | Peak RSS | Segments |
| --- | --- | --- | --- | --- | --- |
| large-v3-turbo-q5_0 | 60 s | 71.29 s | 1.188 | 854 MB | 11 |
| large-v3-turbo-q5_0 | 300 s | 362.41 s | 1.208 | 950 MB | 58 |
| small-q5_1 | 60 s | 24.49 s | 0.408 | 533 MB | 11 |
| small-q5_1 | 300 s | 207.41 s | 0.691 | 614 MB | 56 |

RTF = processing time / audio duration. **These are CPU-only numbers** (4 vCPU,
no GPU). They are not representative of the target RTX 3060, which is expected to
be far faster; GPU numbers could not be produced because the build environment
has no NVIDIA device. **No VRAM figure is reported** — reporting one without a
GPU would be fabrication.

## 8. Turkish accuracy (WER / CER)

Command: `node scripts/wer.js --ref ref.txt --hyp hyp.txt`

The reference is the known text of the synthetic fixture (3 sentences, 25 words).
The hypothesis is the real output of the shipped engine on
`tests/fixtures/tr-known-events.wav`.

| Model | WER | CER | Notes |
| --- | --- | --- | --- |
| large-v3-turbo-q5_0 | 64.0 % | 42.98 % | dominated by number handling |
| small-q5_1 | 188.0 % | 27.27 % | spelled the numbers letter-by-letter |

The headline numbers are dominated by **number rendering**, not word
recognition. The large model rendered `on dört sıfır beşte` as `145` and
`beş yüz otuz iki, kırk bir, seksen yedi` as `782 41-67`; the small model spelled
the digits individually (`A-Y-I-T-...`), which inflates WER above 100 %. This is
a genuine, observed failure mode and exactly the kind of segment an expert must
correct by listening.

To separate word recognition from number formatting, the first sentence (no
numbers) was measured alone:

| Model | WER | CER |
| --- | --- | --- |
| large-v3-turbo-q5_0 | 25.0 % | 5.0 % |

Observed error patterns: Turkish suffixes (`adli`→`adlı`, `inceleme`→`ingeleme`),
numbers, and — on the small model — letter-by-letter spelling of digit strings.
This is consistent with the published Turkish ranking in which large-v3-turbo is
close to large-v3 and small is materially worse on Turkish.

**Caveat.** The reference is synthetic TTS audio (espeak-ng), not a human
reference corpus, and the sample is tiny. These numbers must not be generalised
to real case material. They are recorded to satisfy the release requirement that
quality be measured rather than assumed.

## 9. What was NOT verified (honest limitations)

- **The NSIS installer was not launched on real Windows hardware.** The
  environment is Linux. The Windows native binaries were validated under Wine;
  the packaging configuration was validated by building the Linux equivalent.
  This is the single most important remaining verification step and is listed as
  the next action in `docs/PROJECT_STATE.md`.
- **No GPU / CUDA verification.** No NVIDIA device was available. The code path
  exists (`useGpu`, `-ng` fallback) and the CPU fallback was verified, but GPU
  acceleration was not exercised.
- **No code-signing.** The executable is unsigned; no signed/trusted publisher
  claim is made.
- **WER/CER uses synthetic audio**, as noted above.
- **No portable-zip launch test on Windows** (same reason as the installer).

## Release gate decision

All automated, integration, red-team, lint, security and packaged-application
acceptance tests pass. The Windows installer and portable zip build from pinned,
checksum-verified sources. The remaining gap is execution on real Windows
hardware with a GPU, which cannot be closed in this environment.

Status: **COMPLETE WITH KNOWN LIMITATIONS.**

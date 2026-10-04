# Verification

Every result below comes from a command actually run in the build environment on
2026-10-02/03. Nothing here is asserted without a command behind it. Windows
results come from the `windows-latest` CI runner; everything else from the Linux
build environment.

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

## 0. Branch verification — P1 PR-7 / PR-8 (`p1-pr7-pr8-studio-completion`)

All commands below were run on 2026-10-03 in the Linux build environment
(FFmpeg 7.1.5 installed on the host; `vendor/linux-x64` ffmpeg lacks its shared
libraries, so `FT_FFMPEG_PATH`/`FT_FFPROBE_PATH` point at the host binaries).

| Command | Result |
| --- | --- |
| `npm run lint` | Lint OK — 72 files checked |
| `npm run test:unit` | 225 passed, 0 failed, 0 skipped |
| `node scripts/security-check.js` | 0 critical findings |
| `node --test tests/integration/*.test.js` (with FFmpeg + whisper-cli) | 31 passed, 0 failed, 0 skipped |
| `verify:release.js` packaged smoke (fresh `release/linux-unpacked`) | `ok:true`, `unwired: 0` |
| `verify:release.js` packaged acceptance | `ok:true`, 60 steps, 0 failed |
| `npm run verify:release` (full gate) | **10/10 gates passed — Release gate met** |

The acceptance run's new steps exercise the real IPC data behind the PR-7/PR-8
surfaces: `cases.runs` returns the run list, the operations centre renders run
rows, Ctrl+K opens the search palette, the delivery dialog renders the real
checklist and outputs, and the draft collector reports `AI_DISABLED` by default
while leaving the report sections byte-identical.

NOT VERIFIED for this branch: Windows CI (branch not pushed) and real RTX 3060
GPU behaviour (no NVIDIA hardware); the engine report shows the CPU runtime only.

## 1. Unit tests

Command: `node --test tests/unit/*.test.js`

Result (2026-10-03, P13 productization): **`node --test tests/unit/*.test.js`
= 169 passed, 0 failed; full `npm test` (unit + integration) = 200 passed,
0 failed.**

The P13 work-station pass added `tests/unit/productization.test.js` (12 tests:
review-flag persistence and `TranscriptStore.toggleFlag`, the search/shortcut
helpers, the data-integrity verdict and delivery checklist in every report
format, delivery-package provenance, the support bundle, and a real
run1 → human edit → run2 product-flow assertion). It runs real
Storage/report/archive/delivery/support code and the real renderer libs, not
mocks.

Result (2026-10-03, P12 hardening): **157 passed, 0 failed.**

The P12 hardening added `tests/unit/p0-revision-lifecycle.test.js` (run
lifecycle; revision non-destruction) and `tests/unit/p0-regression.test.js`
(real re-transcription with distinct run ids, archive provenance, atomic
evidence import, fail-closed migration backup, binary-safe waveform on known
PCM, multi-audio-stream policy). Both run real Storage/MediaService/archive
code, not mocks.

Earlier result: 42 passed, 0 failed. Covers the transcript store (edit/split/
merge, undo/redo, status rules, the "never invent words" placeholder), exports
(SRT time formatting, JSON schema and status distinction, HTML escaping and
self-containment), storage (case layout, hashing without modifying the original,
name sanitisation, ordering validation, persistence across reopen, cascade
delete), the runtime-probe parser, the runtime selector, and `version()`.

The `version()` regression test uses `process.execPath` (the Node binary running
the test) with a temporary script as its fixture. This is a genuine executable on
Windows, Linux and macOS and does not depend on a POSIX execute bit, so the same
assertion runs on every supported CI platform.

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

- `node scripts/lint.js` → **Lint OK — 55 files checked** (syntax plus
  no-shell, no-eval, no-remote-script, no-hardcoded-secret, no-telemetry rules).
- `node scripts/security-check.js` → **0 critical findings.** Confirmed:
  no telemetry dependency, the only outbound network path is the model
  downloader, all child processes use `spawn(bin, args[])` with `shell:false`,
  no hardcoded credentials, only synthetic fixtures present, no secret files.

## 5. Packaged application self-tests

### Automated release gate

Command:
```
FT_MODELS_DIR=... FT_WHISPER_CLI_PATH=... FT_TEST_MODEL=... FT_TEST_VAD=... \
  npm run verify:release
```

Result (2026-10-03, P12): **10/10 gates passed.**

```
PASS  lint
PASS  unit tests
PASS  security check
PASS  package.json version is valid SemVer — 0.1.4
PASS  package-lock.json matches package.json — lock 0.1.4 vs pkg 0.1.4
PASS  integration tests
PASS  package (linux dir)
PASS  packaged smoke test
PASS  packaged acceptance test — 47 steps
PASS  engine capability report — cpu ok, gpu runtime not bundled, run mode cpu
```

The Windows release artefacts (`ForensicTranscriber-Setup-x64.exe`,
`ForensicTranscriber-Portable-x64.zip`, `ForensicTranscriber-ModelPack-*.zip`)
and `latest.yml` are produced by a Windows build and were not produced here;
the Linux run reports `INFO release artefacts — none (dir build; run build:win
for the installer/portable)` and `INFO updater metadata — no latest.yml yet`.

Release artefacts (built by `npm run build:win` and
`node scripts/build-model-package.js`):

| Artefact | Bytes | SHA-256 |
| --- | --- | --- |
| `ForensicTranscriber-Setup-x64.exe` | 193 125 697 | `598cbca708ae8ad68a70cbabdea68bcecb9c23a32a4272aed820308b86f2db5e` |
| `ForensicTranscriber-Portable-x64.zip` | 261 620 674 | `4806da0a0b2ac16a2caf8d23aa6e1c347b6deee7a284249e62266e61ac57c10a` |
| `ForensicTranscriber-ModelPack-0.1.0.zip` | 534 060 311 | `ef4ff3aa9dbd77d2431d7ff3305e99c33b57dd9bd5d01a9d719bfcda1ef03a1e` |

`release/SHA256SUMS.txt` lists all three. The portable zip contains
`Forensic Transcriber.exe` and `resources/vendor/bin/{whisper-cli.exe,ffmpeg.exe,ffprobe.exe}`.

### Smoke test

Command:
```
FT_DATA_DIR=... FT_MODELS_DIR=... xvfb-run -a \
  ./release/linux-unpacked/forensic-transcriber --smoke-test --no-sandbox
```

Result (2026-10-03, P12): `{"ok":true, ...}` — **19/19 steps**: window loaded,
renderer booted without a fatal error, renderer dependency globals defined,
renderer primary controls wired, renderer reports an application version
(0.1.4), no uncaught renderer errors, preload API exposed, `app.info` resolves,
database open, FFmpeg available, FFprobe available, case create, case persisted,
model registry readable, engine probe reachable, engine reports
`gpuRuntimeBundled` flag, update state reachable, update check is safe when
disabled, updater disabled off-Windows.

### Acceptance test

Command:
```
FT_DATA_DIR=... FT_MODELS_DIR=... xvfb-run -a \
  ./release/linux-unpacked/forensic-transcriber --acceptance-test \
  --acceptance-audio tests/fixtures/tr-known-events.wav \
  --acceptance-model large-v3-turbo-q5_0 --no-sandbox
```

Result (2026-10-03, P13, real `ggml-large-v3-turbo-q5_0.bin`, run against the
current source because the packaged binary was not rebuilt): `{"ok":true, ...}`
— **51/51 steps** (P12 was 47/47). The four added P13 steps:

| Step | Result |
| --- | --- |
| Case dashboard shows live counts | ok |
| Flags + filter + search highlight work | ok |
| Notes panel adds a note | ok |
| Report checklist renders through the UI | ok |

The P0-critical steps unchanged from P12:

| Step | Result |
| --- | --- |
| Fresh launch / create case / import recording | ok |
| Metadata visible / SHA-256 visible | ok |
| Audio stream reachable (`ft-media:` Range request) | ok — HTTP 206, `audio/wav`, 1024 bytes |
| Transcribe (real model) | ok |
| Turkish transcript produced / segments automatic / timestamps | ok |
| Edit + save | ok |
| Reopen: edit persists / automatic preserved | ok |
| Export (4 formats) + JSON matches stored transcript | ok |
| Export records the transcript revision | ok |
| Re-transcription completes | ok |
| Re-transcription keeps the human revision current | ok (`revisionBecameCurrent === false`) |
| Both transcript revisions are stored | ok |
| Human edit still present after the new run | ok |
| No orphan `STARTED` run remains | ok |
| Every run is terminal with a finish time | ok |
| UI: version, sidebar, open case, select/edit/speaker/split/merge/save/export | ok |
| Case archive written / verifies / restored as a new case | ok |
| Restored evidence count + hashes match | ok |
| Evidence re-verification OK / database health ok | ok |
| Transcription run provenance + input/model hashes recorded | ok |

### Business-case self-test

Command:
```
FT_DATA_DIR=... xvfb-run -a ./node_modules/.bin/electron . \
  --business-case-test --no-sandbox
```

Result (2026-10-03, P13): `{"ok":true, ...}` — **26/26 steps**, no speech model
(a deterministic injected ASR adapter exercises the real storage/revision
code). Covers intake → import → transcribe → expert edit → delivery package →
report export → archive → restore → integrity re-verification, plus a
mid-transcription failure closing the run as `FAILED` and a later machine run
not displacing the verified human revision.

## 6. Windows x64 runtime

### 6a. GPU audit — the packaged binary is CPU-only

This was the first thing checked in the release-hardening pass. Running the
packaged binary and reading its own report (the `-ng`/`-dev` options appear in
`--help` on every build, so they prove nothing):

```
$ ./release/linux-unpacked/resources/vendor/bin/whisper-cli -m ggml-small-q5_1.bin -f silent.wav -nt
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: devices    = 1
whisper_init_with_params_no_state: backends   = 1
whisper_backend_init_gpu: device 0: CPU (type: 0)
whisper_backend_init_gpu: no GPU found
system_info: ... WHISPER : VITISAI = 0 | COREML = 0 | OPENVINO = 0 | CPU : AVX2 = 1 | OPENMP = 1 | REPACK = 1 |
```

`backends = 1` and the absence of a `CUDA :` registration mean the binary was
compiled **without CUDA**. The original release therefore had no GPU support,
contrary to the documentation. This is now corrected (section 6c).

### 6b. CPU runtime (shipped)

whisper.cpp v1.9.4 is cross-compiled with mingw-w64 as a **fully static** binary.

```
$ x86_64-w64-mingw32-objdump -p whisper-cli.exe | grep "DLL Name"
  ADVAPI32.dll
  KERNEL32.dll
  msvcrt.dll
```

Only Windows system DLLs are required (no `libgomp-1.dll`, `libstdc++-6.dll` or
`libgcc_s_seh-1.dll`). Functional check under Wine:

```
$ wine whisper-cli.exe --version
whisper.cpp version: 1.9.4-dev

$ wine whisper-cli.exe -m ggml-small-q5_1.bin -f simple.wav -l tr -oj -np
[00:00:00.000 --> 00:00:04.500]   Merhaba, bu bir hali ses kaydı inceleme testi di.
[00:00:05.800 --> 00:00:09.500]   Kayıt satondort sihirbeste basamış di.
[00:00:11.300 --> 00:00:16.500]   Telefon numara sibesi uzatu ziki, kirk bir, seksen yedi.
```

FFmpeg for Windows is a pinned, checksum-verified LGPL build
(`ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1`), staged by
`scripts/fetch-runtime-windows.js`.

### 6c. GPU runtime (CUDA) — implemented, not verified here

Two runtimes are supported. The CPU runtime always ships; the CUDA runtime is
optional and lives in `bin/gpu/` with the redistributable NVIDIA DLLs
(`cudart64_*`, `cublas64_*`, `cublasLt64_*`; CUDA EULA Attachment A). Selection
is by the engine's own device/backend report — never by the host having a GPU
(`src/main/services/runtime-selector.js`).

Verification mechanism, run in this environment (CPU-only, no CUDA toolkit):

```
$ ./release/linux-unpacked/forensic-transcriber --engine-report \
    --engine-model large-v3-turbo-q5_0 --engine-audio tests/fixtures/tr-offset.wav
ENGINE_REPORT {
  "engineVersion": "whisper.cpp version: 1.9.4-dev",
  "gpuRuntimeBundled": false,
  "capability": {
    "cpuBinary":  { "ok": true, "cudaCapable": false, "gpuDeviceFound": false },
    "gpuBinary":  null,
    "gpuUsable":  false,
    "recommendedMode": "cpu"
  },
  "transcription": {
    "requested": "gpu",
    "selectedMode": "cpu",
    "selectionReason": "GPU_RUNTIME_NOT_BUNDLED",
    "gpuSelected": false, "segments": 1
  }
}
```

This is the mechanism that distinguishes a CUDA-capable binary from a CPU-only
one and reports the device actually used. It was also verified end-to-end with a
**non-CUDA binary placed in the GPU slot** (to simulate a mislabelled runtime):
the packaged application loaded it, read `backends = 1` / `device 0: CPU`, and
refused to use it — selecting CPU with reason `GPU_BINARY_NOT_CUDA`:

```
"gpuRuntimeBundled": true,
"capability": { "gpuBinary": { "ok": true, "cudaCapable": false, "gpuDeviceFound": false }, "gpuUsable": false },
"transcription": { "requested": "gpu", "selectedMode": "cpu", "selectionReason": "GPU_BINARY_NOT_CUDA" }
```

The unit tests additionally cover the four selection outcomes (GPU available,
CUDA binary without a device, non-CUDA "gpu" binary, probe failure).

**Not verified on target NVIDIA hardware.** There is no NVIDIA GPU and no CUDA
toolkit in the build environment, so the CUDA runtime could not be compiled or
exercised here. The CUDA build runs on the `windows-latest` CI runner
(`scripts/build-whisper-cuda-windows.cmd`). On the target RTX 3060 the operator
can confirm the real mode with **Check engine** or `--engine-report`. GPU
behaviour is therefore **unverified here and explicitly marked as such** — no
GPU result is fabricated.

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
to real case material. This is a **synthetic benchmark**, not real-world
validation. It is recorded to satisfy the release requirement that quality be
measured rather than assumed.

## 9. What was NOT verified (honest limitations)

- **Not verified on target NVIDIA hardware.** There is no NVIDIA GPU and no CUDA
  toolkit in the build environment. The CUDA runtime is built on the
  `windows-latest` CI runner; it could not be compiled or exercised here. The
  application reports the real runtime mode on the user's machine
  (`--engine-report` / **Check engine**), but no GPU result is claimed here. See
  section 6c.
- **The NSIS installer was not launched on real Windows hardware.** The
  environment is Linux. The Windows native binaries were validated under Wine;
  the packaging configuration was validated by building the Linux equivalent.
  This is the single most important remaining verification step and is listed as
  the next action in `docs/PROJECT_STATE.md`.
- **No code-signing.** The executable is unsigned; no signed/trusted publisher
  claim is made.
- **Accuracy is a synthetic benchmark**, not a human corpus, as noted above.
- **No portable-zip launch test on Windows** (same reason as the installer).

## Release gate decision

All automated, integration, red-team, lint, security, packaged-application and
engine-capability checks pass. The Windows installer, portable zip and offline
model package build from pinned, checksum-verified sources.

The remaining gap is **execution on real Windows hardware with an RTX 3060**,
which cannot be closed in this environment: no NVIDIA GPU and no CUDA toolkit are
available, so the CUDA runtime is built in CI and GPU behaviour is explicitly
**unverified here**. The application reports the real runtime mode on the target
machine so that gap can be closed there.

Status: **COMPLETE WITH KNOWN LIMITATIONS.**

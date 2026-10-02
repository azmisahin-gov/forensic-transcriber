# FORENSIC TRANSCRIBER

**Local-first transcription workspace for 56.12 audio transcription workflows.**

No cloud. No account. No API key.

```
Open  →  New case  →  Import recording  →  Transcribe  →  Review  →  Edit  →  Export
```

Forensic Transcriber is a Windows desktop application that turns audio recordings
into reviewable, time-aligned transcripts **entirely on the local machine**. It is
built for the Turkish Ministry of Justice expert-classification area **56.12 — Ses
Kayıtlarının Metin Haline Dönüştürülmesi** (conversion of audio recordings into text).

It is **not** a 56.11 "Adli Ses ve Görüntü İnceleme ve Çözümlemeleri" system. See
[Scope](docs/scope.md) for the exact boundary.

---

## Download

[ **DOWNLOAD FOR WINDOWS** ](../../releases/latest) &nbsp;·&nbsp;
[ Documentation](docs/) &nbsp;·&nbsp;
[ Source code ](../../) &nbsp;·&nbsp;
[ Releases ](../../releases) &nbsp;·&nbsp;
[ Security ](docs/security.md) &nbsp;·&nbsp;
[ License ](#license)

The installer and a portable zip are produced per release, together with
`SHA256SUMS.txt`. The executable is **not code-signed**, so Windows SmartScreen may
warn on first launch; there is no "verified publisher" claim. The standard installer
does **not** bundle a speech model — open the application and use **Models → Install**
(or the offline model package) before transcribing.

---

## What it does

- **Import** WAV, MP3, M4A, FLAC, OGG, MP4 (and other formats FFmpeg can decode) by
  picker or drag-and-drop. The original file is copied into the case, never modified.
- **Record provenance**: file name, size, container, codec, duration, sample rate,
  channels, bit depth and a **SHA-256** of the imported copy.
- **Transcribe locally** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
  with optional voice-activity detection. Two runtimes are supported: a CPU runtime that
  always ships, and an optional CUDA runtime. The application picks the CUDA runtime only
  when it actually detects a usable GPU, and otherwise runs on the CPU. Press **Check
  engine** in the app to see whether the installed runtime is CUDA-capable and which
  device a run used.
- **Review against the audio**: click any transcript line to play exactly that region of
  the original recording. A waveform shows position, selection and speech regions.
- **Edit**: change text, split, merge, relabel speakers, and set each segment's status.
- **Keep the machine output and the expert output separate** at all times (see below).
- **Export** JSON, TXT, SRT and self-contained HTML.

## What it deliberately does not do

No speaker identification, voice comparison, biometric voice recognition, deepfake or
audio-manipulation detection, emotion/sentiment analysis, lie detection, threat
classification, crime classification, legal interpretation, or automatic assignment of
legal roles (suspect/victim/defendant). Video files are accepted **only** for the audio
track they contain; no image or video analysis is performed.

## Automatic output is not expert opinion

Every transcript segment carries a status that is preserved in storage and in every
export:

| Status | Meaning |
| --- | --- |
| `AUTOMATIC` | Machine output from the ASR engine. Never treated as expert opinion. |
| `REVIEWED` | A human has checked it against the audio. |
| `EDITED` | A human has changed the text, speaker or timing. |
| `VERIFIED` | A human has explicitly confirmed it. |

The automatic and expert versions are never collapsed into one: editing keeps the
original in undo history, and the JSON export reports how many segments are
`AUTOMATIC` versus human-reviewed.

## How it works

```
desktop UI (Electron)  →  local SQLite case store
                       →  FFmpeg  (decode → 16 kHz mono WAV working copy)
                       →  whisper.cpp (local ASR, VAD, CUDA or CPU)
                       →  transcript editor  →  JSON / TXT / SRT / HTML
```

All inference and all data stay on the machine. The only outbound network call in the
whole application is the explicit, checksum-verified model download you trigger from the
Models dialog. See [Architecture](docs/architecture.md) and
[Methodology](docs/methodology.md).

## Quick start (end user)

1. Download `ForensicTranscriber-Setup-x64.exe` from the latest release.
2. Install and open the application.
3. **Models → Install** (or import the offline model package).
4. **New case**, then import a recording (picker or drag-and-drop).
5. Press **Transcribe**, then review each line against the audio, edit, save and export.

No Python, Node.js, Rust, CMake, CUDA Toolkit or FFmpeg installation is required.

## Updates

The installed application can update itself from GitHub Releases over HTTPS.

- It checks once at startup and reports what it finds; you can also check from
  **About → Application updates**.
- Nothing is downloaded until you press **Download update**.
- Nothing is installed until you press **Restart and install** and confirm.
- You can **Postpone** an update; your current version keeps working.
- An application update never touches your case data and never changes your
  speech model. Models are installed separately from **Models → Install**.
- A failed update leaves your current installation usable.

The Windows executable is **not code-signed**, so SmartScreen may warn on first
launch, and the updater's integrity check is the sha512 in the release metadata
rather than a publisher signature. See
[docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md#code-signing-status).

## Quick start (developer)

Prerequisites: Node.js 20+ and, for the native runtime, a C++ toolchain + CMake.

```bash
npm install
npm test                 # unit tests
node scripts/fetch-runtime-windows.js   # or vendor-runtime.js for the host platform
npm start                # run the app
npm run build:win        # one-command Windows release (installer + portable + checksums)
npm run verify:release   # run the full release gate locally
```

## Releasing

Normal development never releases: pushing or merging to `main` runs CI only.
To cut a release, a maintainer starts the **Release (version)** workflow and
chooses `patch`, `minor` or `major`. The version is calculated, committed, tagged
`vX.Y.Z`, and the tag is built and published to GitHub Releases.

```bash
# The same bump, locally (dry run first):
node scripts/bump-version.js --type patch --dry-run
node scripts/bump-version.js --type patch          # commits and tags
```

Full instructions — including how users receive and postpone updates, where the
releases are hosted, and the code-signing limitation — are in
[docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md). See also
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek −5 s / +5 s |
| `↑` / `↓` | Previous / next segment (plays it) |
| `Ctrl+S` | Save transcript |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

---

## Legal and scope disclaimer

> This software is a technical transcription and review aid. It does not itself
> constitute a forensic opinion, legal assessment, speaker identification, or
> authenticity determination. Final evaluation and use of any transcript remain the
> responsibility of the qualified professional using the software.

> Bu yazılım, bilirkişinin 56.12 kapsamındaki transkripsiyon çalışma sürecini
> desteklemek üzere tasarlanmış teknik bir transkripsiyon ve inceleme yardımcısıdır.
> Tek başına adli bir kanaat, hukuki değerlendirme, konuşmacı kimlik tespiti veya
> sesin gerçekliğine ilişkin bir belirleme oluşturmaz. Nihai değerlendirme ve
> transkriptin kullanımı, yazılımı kullanan yetkin uzmanın sorumluluğundadır.

Technical hashes, audit/history records and process logs are described as **software
provenance and traceability features**. No claim is made that they satisfy any legal
chain-of-custody requirement.

## Privacy

No telemetry. No analytics. No login. No account. No audio upload. Case data stays on
the local machine. See [docs/security.md](docs/security.md).

## Validation status

Validation is reported in three separate tiers. Do not read one tier as another.

| Tier | What it means | Current state |
| --- | --- | --- |
| Automated validation | Tests, lint and security checks run in the build environment | All green (see counts below) |
| Target-machine validation | Running the built installer/portable on real Windows x64 with an NVIDIA RTX 3060 | Not yet performed — see limitations |
| Real-world human corpus validation | Accuracy measured against human-verified case recordings | Not performed — WER/CER is synthetic only |

### Automated validation (actual results)

| Gate | Result |
| --- | --- |
| Lint | 0 problems (35 files) |
| Unit tests | 42/42 pass |
| Integration tests — pipeline + timestamp contract | 4/4 pass |
| Integration tests — red-team / hostile input | 15/15 pass |
| Security check | 0 critical findings |
| Packaged smoke test | 11/11 steps |
| Packaged acceptance test | 20/20 steps |

Accuracy figures in this repository come from a **synthetic benchmark** (espeak-ng TTS
audio), not a human corpus. They are labelled as such and must not be read as
real-world validation.

## Final implementation report

The release report (status, versions, engine/model, build and test results, benchmarks,
security and license review, known limitations) is in
[docs/VERIFICATION.md](docs/VERIFICATION.md) and
[docs/FINAL_REPORT.md](docs/FINAL_REPORT.md).

| | |
| --- | --- |
| Status | COMPLETE WITH KNOWN LIMITATIONS |
| Version | 0.1.0 |
| ASR engine | whisper.cpp v1.9.4 (CPU runtime; optional CUDA runtime) |
| Model | Whisper large-v3-turbo (q5_0), 547 MiB |
| Desktop stack | Electron 44.5.1 + electron-builder 26.15.3 |
| Database | SQLite (`node:sqlite`), local only |
| Decoder | FFmpeg (pinned LGPL build on Windows) |
| GPU | CUDA runtime path implemented and probe-verified; not verified on target NVIDIA hardware |
| Security | 0 critical findings; no telemetry, no hidden network calls |
| License | AGPL-3.0-only (code); MIT/LGPL/NVIDIA third parties |

Known limitations: the Windows installer was not launched on real Windows hardware in the
build environment (Windows binaries were validated under Wine); GPU transcription was not
verified on an RTX 3060 (no NVIDIA device available); accuracy was measured on synthetic
audio only; no PDF export; no automatic diarization; the executable is not code-signed.

## License

Application code: **AGPL-3.0-only** (see [LICENSE](LICENSE)). Bundled third-party
components and models have their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/model-notes.md](docs/model-notes.md).

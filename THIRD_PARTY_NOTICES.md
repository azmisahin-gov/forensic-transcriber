# Third-party notices

This file records the third-party components that Forensic Transcriber uses or
distributes. Application code is AGPL-3.0-only; **third-party components and
models keep their own licenses**. Do not assume the model license matches the
code license.

## Distributed with the application (Windows x64)

| Component | Version | License | Source | Purpose | Distribution condition |
| --- | --- | --- | --- | --- | --- |
| Electron | 44.5.1 | MIT | https://github.com/electron/electron | Desktop runtime (Chromium + Node) | MIT notice retained; Chromium/Node licenses in `LICENSES.chromium.html` shipped beside the app |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | n8.1.3 (build `ffmpeg-n8.1.3-14-g330caae0c1-win64-lgpl-8.1`) | LGPL-3.0-or-later (LGPL build) | https://github.com/BtbN/FFmpeg-Builds (source: https://ffmpeg.org) | Decode any input to a 16 kHz mono WAV; probe metadata | Executed as a separate process, not linked. LGPL notice + source offer required. Build chosen specifically to avoid GPL-only components. |
| whisper.cpp (`whisper-cli.exe`) | v1.9.4 (2026-09-11) | MIT | https://github.com/ggml-org/whisper.cpp | Local ASR engine | MIT notice retained |
| Silero VAD ggml model | v5.1.2 | MIT | https://huggingface.co/ggml-org/whisper-vad | Voice activity detection | Not bundled in the standard installer; included in the offline model package |

## Models (downloaded or imported; not in the standard installer)

| Model | File | License | Source |
| --- | --- | --- | --- |
| Whisper large-v3-turbo (q5_0 / q8_0 / f16) | `ggml-large-v3-turbo*.bin` | MIT (whisper.cpp distribution; OpenAI Whisper weights are MIT) | https://huggingface.co/ggerganov/whisper.cpp |
| Whisper small (q5_1) | `ggml-small-q5_1.bin` | MIT | https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD | `ggml-silero-v5.1.2.bin` | MIT | https://huggingface.co/ggml-org/whisper-vad |

See `docs/model-notes.md` for size, checksum and revision of each model.

## Build-time / development dependencies (not distributed)

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| electron-builder | 26.15.3 | MIT | Packaging NSIS installer and portable zip |
| Node.js (built-in `node:sqlite`, `node:test`, `node:crypto`) | 20+ | MIT | Runtime APIs, tests, hashing |
| mingw-w64 | GCC 14 (win32) | GPL-3.0 with runtime exception | Cross-compiling the Windows ASR binary (build tool only) |
| espeak-ng | 1.5x | GPL-3.0 | Generating synthetic test audio (tests only) |
| CMake | 3.31 | BSD-3-Clause | Building whisper.cpp |
| FFmpeg (host) | 7.1.5 | LGPL/GPL per build | Test audio generation and integration tests |

The GPL tools above are used only to **produce** artefacts or test data; they are
not linked into or distributed with the application.

## License of generated test audio

`tests/fixtures/tr-known-events.wav` and audio produced by
`scripts/generate-test-audio.js` are synthetic speech generated with espeak-ng
from original Turkish sentences. They contain no real recording and no personal
data, and are redistributable with this project.

## Obligations summary

- **AGPL-3.0** (this project): provide source; network use of modified versions
  must offer source. The application ships its source in this repository.
- **MIT** (Electron, whisper.cpp, models, electron-builder, Node): retain the
  copyright and permission notice.
- **LGPL-3.0** (FFmpeg): retain the notice, state that FFmpeg is used, and make
  the corresponding source available. Because FFmpeg is invoked as a separate
  process and is not statically or dynamically linked into the application, the
  application is not itself derived from FFmpeg.

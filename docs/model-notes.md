# Model notes

Models are **not** committed to this repository and are **not** bundled with the
standard installer. They are downloaded or imported explicitly, and every file
is SHA-256 verified against this record before it is accepted.

The checksums below are the upstream SHA-256 values published by the Hugging
Face repositories (LFS object ids) and were independently re-verified during
development (the computed digest matched the published value for each file).

## ASR models (whisper.cpp GGML)

All ASR weights originate from OpenAI's Whisper and are distributed in GGML form
by the whisper.cpp project.

| id | file | size (bytes) | SHA-256 | license |
| --- | --- | --- | --- | --- |
| `large-v3-turbo-q5_0` | `ggml-large-v3-turbo-q5_0.bin` | 574 041 195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` | MIT |
| `large-v3-turbo-q8_0` | `ggml-large-v3-turbo-q8_0.bin` | 874 188 075 | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` | MIT |
| `large-v3-turbo-f16` | `ggml-large-v3-turbo.bin` | 1 624 555 275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` | MIT |
| `small-q5_1` | `ggml-small-q5_1.bin` | 190 085 487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` | MIT |

- **Source:** `https://huggingface.co/ggerganov/whisper.cpp`
- **Revision used:** `main`, verified 2026-10.
- **Default:** `large-v3-turbo-q5_0` (see `docs/DECISIONS.md`, D4).

## Voice activity detection

| id | file | size (bytes) | SHA-256 | license |
| --- | --- | --- | --- | --- |
| `silero-vad-5.1.2` | `ggml-silero-v5.1.2.bin` | 885 098 | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` | MIT (Silero VAD) |

- **Source:** `https://huggingface.co/ggml-org/whisper-vad`
- **Revision used:** `main`, verified 2026-10.

## Download URLs

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>
https://huggingface.co/ggml-org/whisper-vad/resolve/main/<file>
```

## Distribution conditions

- The application code is AGPL-3.0-only. The models are **not** covered by that
  license; they carry their own license as recorded above. Do not assume the
  model license matches the code license.
- The standard installer ships no model. The **offline package** produced by
  `scripts/build-model-package.js` bundles the default ASR model and the VAD
  model together with a `manifest.json` that repeats this provenance.
- A downloaded or imported file is rejected unless its SHA-256 matches the value
  above, so a corrupted or substituted file cannot be installed silently.

## Rebuilding this record

```bash
# Compute the digest of a local file
sha256sum models/ggml-large-v3-turbo-q5_0.bin

# Compare with the upstream published value
curl -s "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main" \
  | python3 -c "import sys,json;[print(e['path'],e.get('lfs',{}).get('oid')) for e in json.load(sys.stdin) if e['path'].startswith('ggml-large-v3-turbo')]"
```

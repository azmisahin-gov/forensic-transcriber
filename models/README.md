# Models

This directory is intentionally empty in the repository. **Model weights are
never committed.**

At runtime the application looks for models in the user data directory
(`<userData>/models`), or in `FT_MODELS_DIR` if set. Use **Models → Install** in
the application to download and checksum-verify a model, or **Models → Import
file…** to install a model you already have.

Expected file names:

```
ggml-large-v3-turbo-q5_0.bin   (default ASR, 547 MiB)
ggml-large-v3-turbo-q8_0.bin
ggml-large-v3-turbo.bin
ggml-small-q5_1.bin
ggml-silero-v5.1.2.bin         (voice activity detection)
```

Source, revision, size, license and SHA-256 for every model are recorded in
[`../docs/model-notes.md`](../docs/model-notes.md). A downloaded or imported file
is rejected unless its checksum matches, so a corrupted or substituted file
cannot be installed silently.

For a developer machine you can place verified files here and point
`FT_MODELS_DIR` at this directory:

```bash
export FT_MODELS_DIR="$(pwd)/models"
```

To build the offline model package (ASR + VAD + manifest + checksums):

```bash
node scripts/build-model-package.js --models-dir ./models --out ./release
```

Model licenses are separate from the application license (AGPL-3.0-only). Do not
assume they are the same.

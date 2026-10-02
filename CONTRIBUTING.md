# Contributing

Thanks for helping improve Forensic Transcriber. Please read this before opening
a pull request.

## What this project is (and is not)

It is a **56.12** tool: it converts audio recordings into text and supports the
expert's review of that text. It is **not** a 56.11 "Adli Ses ve Görüntü İnceleme
ve Çözümlemeleri" system. Contributions that add speaker identification, voice
comparison, biometric recognition, deepfake/manipulation detection,
emotion/sentiment/lie analysis, threat/crime classification or legal
interpretation are out of scope and will be declined. See `docs/scope.md`.

## Ground rules

- Keep the product **simple and working**. Do not add architecture for its own
  sake; do not delay a working feature for a perfect one.
- No feature creep. If a feature does not directly serve the 56.12 transcription
  workflow, put it in `docs/ROADMAP.md` instead of the current release.
- Never present machine output as expert output. Preserve the
  `AUTOMATIC`/`REVIEWED`/`EDITED`/`VERIFIED` distinction everywhere.
- Never claim legal force. Hashes and history are software provenance features.

## Development setup

```bash
git clone <repo>
cd forensic-transcriber
npm install

# Native runtime for the host platform (dev convenience)
FT_TARGET_PLATFORM=$(node -p process.platform) FT_TARGET_ARCH=$(node -p process.arch) \
  FT_WHISPER_BIN=/path/to/whisper-cli node scripts/vendor-runtime.js

npm test        # unit tests
npm run lint    # syntax + safety rules
npm start       # run the app
```

`node scripts/security-check.js` runs the release security checks.

## Tests

- `tests/unit` — pure logic (transcript store, exports, storage). Fast, no
  external tools.
- `tests/integration` — the real pipeline (import → decode → ASR → export) and
  the timestamp contract. Requires FFmpeg and a whisper.cpp build; set
  `FT_TEST_AUDIO`, `FT_TEST_MODEL`, `FT_TEST_VAD` if not using the defaults.
- Packaged-app checks: `--smoke-test` and `--acceptance-test` flags on the
  built application.

**Do not** use mocks for the pipeline tests. They must exercise real code paths.

## Adding a native runtime or a model

1. Add an entry to `src/shared/model-registry.js` (or the vendor scripts) with
   name, version, license, source and SHA-256.
2. Record it in `THIRD_PARTY_NOTICES.md` and, for models,
   `docs/model-notes.md`.
3. Update the download/verification path so a mismatched file is rejected.

## Commit and PR expectations

- Keep commits focused. Explain the *why* in the message.
- Update `docs/PROJECT_STATE.md`, `docs/VERIFICATION.md` and `CHANGELOG.md` when
  behaviour changes.
- Run `npm test` and `npm run lint` before pushing.
- Do not commit models, the `vendor/` directory, databases or real recordings.
  Only synthetic or explicitly redistributable audio belongs in `tests/fixtures`.

## Security

- No telemetry, analytics, login or cloud storage. Ever.
- No arbitrary shell execution; spawn with argument arrays.
- No hardcoded credentials.
- Scope filesystem and network access to the minimum required.

Report security concerns as described in `docs/security.md`.

# Release checklist

Run through this list before publishing a release. Do not mark a step done
without a real command or observation behind it.

## 1. Automated checks

- [ ] `npm test` — all unit tests pass.
- [ ] `node --test tests/integration/*.test.js` — pipeline and timestamp contract pass.
- [ ] `npm run lint` — no syntax or safety-rule problems.
- [ ] `node scripts/security-check.js` — 0 critical findings.

## 2. Build

- [ ] `npm run build:win` completes and writes `release/`:
  - [ ] `ForensicTranscriber-Setup-x64.exe`
  - [ ] `ForensicTranscriber-Portable-x64.zip`
  - [ ] `SHA256SUMS.txt` (covers every artefact)
- [ ] `node scripts/build-model-package.js` produces the offline model package
      and its checksum.
- [ ] Native runtime is present in the package (`resources/vendor/bin/`):
      `whisper-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`.

## 3. Installer acceptance test (real Windows hardware)

- [ ] Install `ForensicTranscriber-Setup-x64.exe` on a clean Windows 10/11 x64 machine.
- [ ] Launch the application.
- [ ] `Models → Install` the default model (or import the offline package).
- [ ] Create a case.
- [ ] Import a WAV, then an MP3, then an M4A.
- [ ] Confirm metadata and SHA-256 are visible.
- [ ] Start transcription; confirm progress is shown.
- [ ] Confirm a Turkish transcript appears.
- [ ] Click a transcript line; confirm exactly that audio region plays.
- [ ] Edit a line; confirm the status becomes `EDITED` and the automatic text is
      recoverable with Undo.
- [ ] Save; close the application; reopen the case; confirm the edit persisted.
- [ ] Export JSON, TXT, SRT and HTML; open each and confirm it matches.
- [ ] Close the application cleanly.
- [ ] Confirm no development tools were required at any point.

## 4. Portable test

- [ ] On a fresh Windows environment, unzip `ForensicTranscriber-Portable-x64.zip`.
- [ ] Launch without installing anything.
- [ ] Repeat a short transcribe + export.

## 5. GPU

- [ ] `--engine-report` on the target machine reports the GPU runtime as
      `gpuRuntimeBundled: true` and, on an RTX 3060, `cudaCapable: true`,
      `gpuDeviceFound: true` and `selectedMode: "gpu"`.
- [ ] In the app, **Check engine** shows "CUDA runtime bundled, GPU detected".
- [ ] Run a transcription and confirm the toast and engine status say **GPU**.
- [ ] Disable the GPU in the app (uncheck "Use GPU if available") and confirm the
      run reports **CPU** and still completes.
- [ ] If the CUDA runtime is not bundled in this release, record that explicitly
      as `Not verified on target NVIDIA hardware` — do not claim GPU support.

## 6. Documentation test

- [ ] Follow `README.md` developer steps on a clean checkout; nothing is missing.
- [ ] Follow the end-user quick start; no step assumes terminal use.

## 7. GitHub Pages (one-time repository setting)

The Pages workflow uses `actions/configure-pages` with `enablement: true`, which
enables a Pages site configured to build from GitHub Actions on first run. If the
repository policy or token does not permit that, an owner/admin must do it once:

1. Repository **Settings → Pages**.
2. **Build and deployment → Source: GitHub Actions**.

Without this setting the `Pages` workflow fails at "Configure Pages" with
`Get Pages site failed ... Not Found`. After the setting is applied, re-run the
workflow. The site is static documentation/download only; it never processes
audio.

## 8. Publication

- [ ] Update `CHANGELOG.md`, `docs/PROJECT_STATE.md`, `docs/VERIFICATION.md`
      with real results.
- [ ] Tag the release (`v0.1.0`) and confirm the release workflow attaches:
      installer, portable zip, model package and `SHA256SUMS.txt`.
- [ ] Confirm no release notes or links reference an asset that does not exist.
- [ ] Confirm the GitHub Pages download links resolve to the tested assets.
- [ ] Confirm no models, `vendor/`, databases or real recordings are committed.

## Status states

Use only: `COMPLETE`, `COMPLETE WITH KNOWN LIMITATIONS`, `BLOCKED`, `INCOMPLETE`.
`COMPLETE` requires the acceptance test to have actually been run.

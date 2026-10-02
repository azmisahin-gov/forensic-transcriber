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

- [ ] On an NVIDIA machine, confirm transcription uses the GPU.
- [ ] Disable GPU (or remove the driver) and confirm the CPU fallback works.

## 6. Documentation test

- [ ] Follow `README.md` developer steps on a clean checkout; nothing is missing.
- [ ] Follow the end-user quick start; no step assumes terminal use.

## 7. Publication

- [ ] Update `CHANGELOG.md`, `docs/PROJECT_STATE.md`, `docs/VERIFICATION.md`
      with real results.
- [ ] Tag the release and attach the installer, portable zip, model package and
      `SHA256SUMS.txt`.
- [ ] Confirm the GitHub Pages download button resolves to the tested asset.
- [ ] Confirm no models, `vendor/`, databases or real recordings are committed.

## Status states

Use only: `COMPLETE`, `COMPLETE WITH KNOWN LIMITATIONS`, `BLOCKED`, `INCOMPLETE`.
`COMPLETE` requires the acceptance test to have actually been run.

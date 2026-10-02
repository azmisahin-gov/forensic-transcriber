# Roadmap

Deliberately deferred. Nothing here belongs in the current release; each item is
recorded so the current version does not grow.

## Next

- **PDF export** — only once a layout is genuinely tested and the output is
  clearly marked as a software-generated working draft, never as an official
  template.
- **Automatic diarization** — optional enhancement only. Must degrade gracefully
  (a failed diarizer must not stop transcription) and may only emit anonymous
  `SPEAKER_NN` labels. Never resolves a label to a person.
- **Windows CUDA build of whisper-cli** — ship a GPU-enabled `whisper-cli.exe`
  produced with the NVIDIA toolchain, keeping the CPU build as fallback.
- **Batch transcription** — queue several evidence files in one case.

## Later

- ELAN / TEI import-export for interoperability with other transcription tools.
- Keyboard-only full review mode and accessibility pass.
- Code signing (Windows Authenticode) so SmartScreen does not warn.
- macOS and Linux installers (the code is already cross-platform).
- A browser "demo" page using WebGPU — explicitly **not** the forensic workflow,
  which stays on the desktop.

## Explicitly rejected (will not be added)

- Speaker identification, voice comparison, biometric voice recognition.
- Deepfake / splicing / authenticity detection.
- Emotion, sentiment, lie detection, threat or crime classification.
- Legal interpretation or automatic legal conclusions.
- Any cloud processing, account, telemetry or analytics.

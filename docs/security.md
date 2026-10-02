# Security

## Privacy model

- **No telemetry.** No analytics, crash reporting or usage tracking of any kind.
- **No account, no login.** There is no user system.
- **No cloud.** Cases are stored on the local machine only.
- **No audio upload.** Recordings are never sent anywhere.
- **Offline-first.** The application performs no network activity during normal
  operation. The only outbound call is the explicit model download you trigger,
  and it verifies a SHA-256 before accepting the file.

`scripts/security-check.js` enforces these properties at release time: it fails
if a telemetry dependency appears, if a network API is used outside the model
downloader, if a shell-execution pattern appears, or if a credential-like string
is found.

## Application hardening

| Area | Measure |
| --- | --- |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false` |
| Content Security Policy | `default-src 'none'`; scripts/styles only from the app; `connect-src ft-media:`; no remote scripts |
| Preload surface | A fixed, small API on `window.ft`; no generic fs/shell/net primitive |
| Navigation | `will-navigate` and `setWindowOpenHandler` block in-app navigation; external links open in the OS browser |
| Media access | `ft-media:` custom protocol resolves only known `evidence_id`s, never arbitrary paths; supports `Range` for seeking |
| Child processes | `spawn(bin, args[], { shell: false })`; arguments are never concatenated into a shell string; absolute/verified binary paths |
| Output bounds | Child-process stdout/stderr are capped so a hostile file cannot exhaust memory |
| File names | Imported names are sanitised; path traversal, reserved Windows names and control characters are neutralised |
| Models | Downloaded or imported model files are SHA-256 verified before use |
| Database | Local SQLite with foreign keys and cascade deletes; malformed input is rejected with a structured error |

## Threat considerations addressed

- **Malformed / corrupt media** — decode failures produce structured errors
  (`PROBE_FAILED`, `DECODE_FAILED`); the app does not crash and records what was
  rejected.
- **Unsupported codecs** — reported to the operator; the import is still recorded.
- **Hostile file names** — sanitised; cannot escape the case directory.
- **Shell injection** — impossible by construction (no shell, argument arrays).
- **Missing model / GPU / CUDA failure** — explicit error codes and a CPU
  fallback path; the user is told to install a model rather than being left with
  a silent failure.
- **Cancellation and restart** — transcription aborts its child process; the job
  registry prevents concurrent runs and aborts everything on quit.

## What is explicitly not claimed

Hash values, history records and logs are **software provenance and traceability
features**. No claim is made that they satisfy any legal chain-of-custody
requirement. The software does not determine authenticity, does not identify
speakers, and does not produce a legally valid report.

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainers
directly. Please do not include real recordings or personal data in a report.

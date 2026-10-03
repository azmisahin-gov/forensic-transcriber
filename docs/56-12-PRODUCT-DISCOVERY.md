# 56.12 Product Discovery & Technical Architecture Audit

**Status:** research / audit only. **No feature is implemented here.** This
document is the input to a later, separately approved roadmap.

**Date:** 2026-10-03
**Repository state audited:** `main` @ `1539d80`, version **0.1.3**.

---

## 1. Executive summary

The application is now operationally sound on a real Windows machine for the
core 56.12 flow: install, update, model setup, case creation, multi-evidence
import, transcription, review, edit, export. Three consecutive real-world
blockers (dead renderer, destroyed automatic text, multi-evidence id collision)
have been found and fixed, each with a new permanent regression gate.

This audit makes four arguments.

1. **The product is functionally correct but not yet reliability-hardened.** The
   serious risks are no longer "does it work" but "can it lose or corrupt a
   case". There is no backup/archive, no integrity check, no crash-recovery
   story, and `synchronous` is not set on the database. For a tool whose output
   becomes evidence, this is the highest-value gap.

2. **The scope boundary is now well defined by the primary source.** The
   Ministry of Justice Bilirkişilik Daire Başkanlığı lists **56.12 "Ses
   Kayıtlarının Metin Haline Dönüştürülmesi (Yargı mercilerince ses ve görüntü
   bilişim sisteminin kullanılması hariç)"** and **56.11 "Adli Ses ve Görüntü
   İnceleme ve Çözümlemeleri"** as separate sub-specialities. Law 6754 art. 3/2
   and HMK art. 279/4 forbid an expert from offering legal characterisation.
   The software must therefore remain a transcription-and-review aid and must
   never present output as an opinion, an identity, or an authenticity finding.

3. **There is no evidence to justify changing the ASR engine.** Whisper-family
   runtimes load the same weights, so accuracy is essentially identical; 2026's
   newer models (Parakeet TDT v3, Qwen3-ASR) are strong but mainly English /
   European, and switching would require a human-verified Turkish corpus that
   does not yet exist. The correct move is to *measure*, not to switch.

4. **The biggest unknowns are all human.** No real 56.12 practitioner has
   validated the workflow; there is no human-verified Turkish corpus; the
   target hardware (RTX 3060) and the live auto-update path have not been
   exercised on real hardware.

The recommended next step is **reliability and integrity work (P0), then core
workflow depth (P1)** — not new capability.

---

## 2. Current repository audit

### 2.1 Architecture as built

```
Electron 44 main process (src/main)
  main.js        window, IPC, ft-media protocol, orchestration, self-tests
  preload.js     narrow window.ft API (contextIsolation)
  services/
    storage.js          SQLite (node:sqlite), schema + migrations + persistence
    media.js            FFmpeg/FFprobe, safe spawn, waveform peaks
    model-manager.js    model download / checksum verify / import
    whisper.js          whisper.cpp adapter, probe, output parsing
    runtime-selector.js CPU vs CUDA runtime choice by engine evidence
    updater.js          electron-updater wrapper + pure state machine
    exporter.js / exports.js   JSON/TXT/SRT/HTML rendering
    paths.js, logger.js
renderer (src/renderer)
  renderer.js (1294 lines)  UI orchestration
  lib/ transcript-store.js (311), audio.js (119), waveform.js (96), format.js (62)
shared (src/shared)
  constants.js, model-registry.js, versioning.js  (UMD, used by both sides)
```

Size: ~5,960 lines of application JS. Largest files are `main.js` (1,271) and
`renderer.js` (1,294).

### 2.2 Data model (SQLite, `schema_version` 2)

| Table | Purpose | Key |
| --- | --- | --- |
| `cases` | case id, title, notes, case dir, timestamps | `case_id` |
| `evidence` | original file, metadata, SHA-256, original/derived paths | `evidence_id` |
| `transcripts` | one per (case, evidence): language, model, engine | `transcript_id`, unique `(case_id, evidence_id)` |
| `segments` | ordered segments with start/end, speaker, text, **original_text**, status, confidence, words | **(transcript_id, segment_id)** |
| `history` | append-only action log (provenance) | autoincrement |
| `meta` | schema version | key |

`journal_mode = WAL`, `foreign_keys = ON`. Deletes cascade case → evidence →
transcript → segments.

### 2.3 Evidence model

Import **copies** the file into `cases/<id>/evidence/original/`, hashes the copy
with SHA-256, records container/codec/duration/sample rate/channels/bit depth,
and never writes to the source. A 16 kHz mono working copy is written to
`evidence/derived/`. Original and derived are clearly separated.

### 2.4 Transcript model

`segment_id`, `start`, `end` (seconds on the **original** timeline), `speaker`,
`text`, `original_text` (immutable automatic text), `status`
(`AUTOMATIC`/`REVIEWED`/`EDITED`/`VERIFIED`), `confidence` (mean token
probability), optional `words[]`.

### 2.5 Provenance and history

`history` records `CASE_CREATED`, `EVIDENCE_IMPORTED`, `TRANSCRIPTION_STARTED/
_CREATED/_FAILED/_CANCELLED`, `TRANSCRIPT_SAVED`, `EXPORT_CREATED`, with a JSON
detail payload. Exports carry case id, evidence name, SHA-256, engine, model and
the machine/expert status note.

### 2.6 Audio pipeline and FFmpeg usage

`ffprobe` for metadata; `ffmpeg` decodes to 16 kHz mono PCM via
`-vn -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le`. Both are separate processes,
`spawn(bin, args[], { shell: false })`, absolute/vendor-resolved paths, capped
output.

### 2.7 Whisper integration

`whisper-cli` invoked with `-ojf` (JSON with tokens), optional `--vad` +
Silero model, `-ng` for CPU. Output parsed into segments with per-token
probabilities. Segment ids are prefixed with a per-run id. A runtime probe reads
the engine's own `devices`/`backends`/`device N (type T)`/`system_info` to
distinguish a CUDA-capable binary from a CPU-only one.

### 2.8 Renderer architecture

Single `renderer.js` (1,294 lines) holding state, IPC wrapper, render functions
and event wiring. Four UMD libs with documented load order. A boot signal
(`window.__FT_RENDERER_STATE__`) reports globals, control wiring and errors.

### 2.9 Model management and runtime provenance

Registry (`model-registry.js`) records id, file name, size, SHA-256, source URL,
revision, license, recommendation. Downloads go to `*.partial`, are hashed, and
are rejected on mismatch. Optional CUDA runtime lives in `bin/gpu/`.

### 2.10 Updater

electron-updater 6.8.9, GitHub provider over HTTPS, `autoDownload: false`,
`autoInstallOnAppQuit: false`. State machine: idle → checking → available →
(postponed) → downloading → downloaded → install. An automatic check runs ~8 s
after startup when packaged on Windows.

### 2.11 Tests

119 unit, 4 pipeline integration, 15 red-team integration, 4 update-data-safety.
Packaged self-tests: smoke (19 steps), acceptance (31 steps including 10
real-DOM UI steps), multi-evidence (19 steps, 10 recordings), engine report.

### 2.12 Release, security, documentation, Pages

Controlled release: manual `Release (version)` → bump → tag → reusable
build/publish on `windows-latest`; publishes installer, portable zip, model
package, `latest.yml`, `SHA256SUMS.txt`. Security check forbids telemetry,
network APIs outside the model downloader, shell execution, hardcoded secrets.
`docs/` holds scope, architecture, methodology, standards, model-notes,
decisions, verification, release process/checklist, security. `site/` is a
static GitHub Pages portal.

### 2.13 Risk register

**A. Technical debt**

| # | Item | Evidence |
| --- | --- | --- |
| A1 | `renderer.js` is 1,294 lines mixing state, IPC, render and wiring | `wc -l` |
| A2 | `main.js` is 1,271 lines; IPC handlers, self-tests and protocol in one file | `wc -l` |
| A3 | Export naming logic lives in `exporter.js`, model metadata in two places (`model-registry.js`, `docs/model-notes.md`) | code + docs |
| A4 | `schema_version` is written but migrations are detected structurally, not by version | `_migrate*` methods |
| A5 | README "Automated validation" table is stale (says 35 files / 42 unit / 11 smoke / 20 acceptance; actual: 47 / 119 / 19 / 31) | README vs `node --test` |

**B. Reliability risks**

| # | Item | Evidence |
| --- | --- | --- |
| B1 | SQLite `synchronous` is not set (WAL default), so a power loss can lose recent commits | no `PRAGMA synchronous` |
| B2 | No backup/archive/export-a-case feature; a case is a folder plus a DB row | grep: no `backup`/`vacuum` |
| B3 | No `PRAGMA integrity_check` or recovery path for a corrupted DB | grep |
| B4 | A crash mid-migration is rolled back, but the DB is not backed up before a schema rebuild | `_migrateSegmentsCompositeKey` |
| B5 | Transcription has no resume; a crash loses all work for that recording | design |
| B6 | Long recordings are processed in one process with no partial results | design |
| B7 | Only audio stream `0:a:0` is decoded; other streams are silently ignored | `media.js` `-map 0:a:0` |

**C. Data-integrity risks**

| # | Item | Evidence |
| --- | --- | --- |
| C1 | No detection of DB or evidence tampering; SHA-256 is recorded but never re-verified after import | `sha256File` only at import |
| C2 | `original_text` is preserved, but a manual `segment_id` collision inside one transcript is prevented only in the renderer | `_uniqueId` renderer-only |
| C3 | Export files are written without an atomic temp-then-rename, so an interrupted export can leave a partial file | `exporter.js` `writeFile` |
| C4 | The DB file lives beside the case folder; moving the folder without the DB (or vice versa) silently breaks the link | `casesDir` layout |

**D. UX risks**

| # | Item | Evidence |
| --- | --- | --- |
| D1 | The sidebar "0 cases · 0 files" bug was fixed, but similar derived values are computed in several places | `updateStorageInfo` |
| D2 | Long operations show a progress bar but no time estimate and no "resume" | `handleProgress` |
| D3 | No indication that only the first audio stream is used | `media.js` |
| D4 | No way to compare the automatic and edited text side by side in the UI (only in JSON) | `renderSegment` |

**E. Privacy / security risks**

| # | Item | Evidence |
| --- | --- | --- |
| E1 | **The privacy statement is inaccurate.** README and `docs/security.md` say the only outbound call is the model download, but the packaged app also checks GitHub Releases ~8 s after startup (`updater.js` `checkForUpdates`) | README vs `main.js:359` |
| E2 | Updater traffic reveals "this machine runs Forensic Transcriber" and an IP to GitHub; acceptable but must be disclosed | updater |
| E3 | The logger writes error entries to a local log; a renderer console error could embed a file path or transcript fragment | `console-message` capture |
| E4 | No log redaction policy is documented | `logger.js` |

**F. Maintainability risks**

| # | Item | Evidence |
| --- | --- | --- |
| F1 | Large single-file modules (A1, A2) make review and testing harder | `wc -l` |
| F2 | Self-test code (`runSmokeTest`, `runAcceptanceTest`, `runMultiEvidenceTest`) lives in the production `main.js` | `main.js` |
| F3 | Model provenance duplicated in code and docs can drift | A3 |
| F4 | The `site/` Pages content duplicates README claims and can drift | `site/index.html` |

**G. Things that should NOT be changed**

| # | Item | Reason |
| --- | --- | --- |
| G1 | The `ft-media:` protocol and its Range handling | Works; scoped; no arbitrary path exposure |
| G2 | `spawn(bin, args[], { shell: false })` | Correct injection defence; do not switch to `exec` |
| G3 | The `(transcript_id, segment_id)` key | Correct scope; verified by migration tests |
| G4 | `original_text` immutability | Core 56.12 guarantee |
| G5 | The offline-first default and no-telemetry stance | Product identity |
| G6 | The manual, evidence-based runtime selection | Honest GPU handling; verified |
| G7 | The `AUTOMATIC/REVIEWED/EDITED/VERIFIED` status model | Core 56.12 guarantee |
| G8 | The controlled release policy (no release on merge) | Proven by three releases |

---

## 3. Current product capabilities

Verified on the packaged artifact and, for the core flow, on a real Windows
machine by the maintainer:

- Windows x64 installer, portable zip, offline model package, auto-update.
- Local transcription with whisper.cpp (large-v3-turbo q5_0), Silero VAD,
  CPU runtime shipped, optional CUDA runtime built in CI.
- Multi-evidence cases (10+ recordings verified), per-recording transcripts.
- Segment-level audio↔text review; click a line to play that region.
- Edit, split, merge, speaker label, status; exact undo/redo.
- `original_text` preserved so machine output is never destroyed.
- Export JSON/TXT/SRT/HTML with provenance and machine/expert status.
- Provenance/history; SHA-256 of the imported copy.
- No telemetry, no account, no cloud; offline-first.

## 4. Current gaps

Grouped, not yet prioritised (that is §11):

- **Reliability:** no backup/archive, no integrity check, `synchronous` unset,
  no resume, single-stream audio only.
- **Integrity:** hash recorded but not re-verified; non-atomic export writes.
- **Workflow depth:** no inaudible/unintelligible distinction, no overlap,
  no per-segment note, no field-level diff.
- **Review quality:** no second-review mode, no reviewer sign-off.
- **Privacy statement:** inaccurate (E1).
- **Documentation:** stale counts (A5).
- **Validation:** no human corpus, no target-hardware run.

---

## 5. Official 56.12 requirements and constraints

### 5.1 The exact definition (primary source)

The Bilirkişilik Daire Başkanlığı "Bilirkişilik Temel ve Alt Uzmanlık Alanları
ile Bilirkişilerde Aranan Nitelikler" document (published on the Ministry site;
2025 edition dated 29.12.2025) lists, under **56 ADLİ VE KRİMİNALİSTİK
İNCELEMELER**:

- **56.11 ADLİ SES VE GÖRÜNTÜ İNCELEME VE ÇÖZÜMLEMELERİ**
- **56.12 SES KAYITLARININ METİN HALİNE DÖNÜŞTÜRÜLMESİ (YARGI MERCİLERİNCE SES VE GÖRÜNTÜ BİLİŞİM SİSTEMİNİN KULLANILMASI HARİÇ)**

So the audited product's target is **56.12**, and **56.11 is a separate
sub-speciality**. The parenthetical excludes recordings made through the
judiciary's own audio/video informatics system (SEGBİS) from 56.12.

### 5.2 Recent naming history (why the wording matters)

An earlier edition of the same list numbered the areas differently (for example
`58.14 SES VE GÖRÜNTÜ KAYITLARININ METİN HALİNE DÖNÜŞTÜRÜLMESİ` and
`58.13 ADLİ SES İNCELEMELERİ` in a Tesk reproduction of an earlier list). The
current official list uses **56.11 / 56.12**. The product has consistently used
the 56.12 wording and its "audio → text" scope; this is correct against the
current list.

### 5.3 Legal limits on the expert (hence on the software)

- **Law 6754 (Bilirkişilik Kanunu) art. 3/2:** the expert "cannot make
  explanations outside matters requiring their expertise, and cannot make legal
  characterisation or evaluations."
- **HMK art. 279/4** repeats: the expert cannot go beyond expert matters nor
  perform the legal assessment that belongs to the judge.
- **Law 6754 art. 3/1:** the expert acts independently, impartially and
  objectively.
- **Law 6754 art. 3/5:** the expert must keep confidential the information,
  documents and secrets entrusted.

**Software implications (safe to support, not a legal decision):** the tool may
transcribe, time-align, preserve the original, keep machine and expert text
apart, record provenance, and export a working draft. It must not classify,
opine, identify speakers, or produce anything framed as a legal conclusion. The
current disclaimers match this and should be retained.

### 5.4 What no official source defines (and therefore what the tool must not invent)

The Ministry list defines *who may be an expert* and *which sub-speciality*;
it does **not** publish a mandatory machine-readable transcript format, a
mandatory report template for 56.12, or a required tool. Any claim that the
software "produces a 56.12 report" would be unsupported. The product correctly
calls its output a "working draft".

### 5.5 Reporting standards that inform (not bind) the data model

- **ISO 24624:2016** "Language resource management — Transcription of spoken
  language" (published 2016-08-15, confirmed 2022) specifies a TEI-based XML
  representation with tiers, time alignment to the media and speaker
  annotation. It is the right reference for a *structured, interoperable*
  model; its full tier machinery is unnecessary for the MVP.
- International digital-evidence practice (**SWGDE Best Practices for Forensic
  Audio**, 08-A-001) covers receipt, documentation, handling and examination of
  audio evidence and the "fair and accurate representation" standard. It is a
  useful checklist source, not a Turkish legal requirement.

---

## 6. Practitioner workflow findings

Synthesised from forensic-transcription practice and vendor/practitioner
material, separated by confidence.

**Authoritative guidance (SWGDE, ISO):**
- Preserve the original; work from a copy; document every step. *(matches the
  product's original/derived split and hash)*
- Keep the transcript time-aligned to the media so any line can be checked.
- Verbatim standards matter: fillers, false starts, non-verbal sounds, pauses,
  overlapping speech, and inaudible sections must be representable.

**Practitioner practice (transcription services, forensic labs):**
- Verbatim is a *mode*; many briefs want a readable version. Both need the same
  underlying evidence-preserving data.
- Overlap handling: preserve intelligible simultaneous turns; mark
  unintelligible overlap; return to it in QA.
- Mark `[inaudible]` vs `[unintelligible]` distinctly.
- Second review by a different person is normal.
- Timestamp granularity follows the deliverable (start-end for evidence, cue
  intervals for captions).

**Commercial/vendor claims (treat with caution):**
- "99% accuracy", "court-ready", "AI + human hybrid". These are marketing;
  accuracy depends on the recording, and no vendor number transfers to a
  specific case.

**Anecdotal/community:**
- Long recordings, names/numbers, and repeated playback are the recurring
  friction points.

## 7. Pain-point map

| Pain point | Evidence type | How the product handles it today | Gap |
| --- | --- | --- | --- |
| Long recordings | practitioner + community | single long run, progress bar | no resume, no partial output, no time estimate |
| Timestamp navigation | authoritative | click-a-line plays the region | word-level timestamps only if the engine emits them |
| Speaker labelling | practitioner | manual `SPEAKER_NN` | no auto-diarization; no per-speaker timeline view |
| Overlap | authoritative + practitioner | not representable | no overlap marker |
| Inaudible vs unintelligible | practitioner | one placeholder `[ANLAŞILAMADI]` | no distinction |
| Repeated playback | community | player + segment playback | no A/B loop, no bookmark |
| Names/numbers | practitioner | nothing special | no glossary/prompt, no numeric-focused QA |
| Revision control | authoritative | undo/redo within a session; history log | no field-level diff; no version snapshots |
| Second review | practitioner | status flags | no explicit second-reviewer mode |
| Provenance | authoritative | hash + history | hash never re-verified; no signed manifest |
| Evidence preservation | authoritative | copy + hash + derived split | no archive/export of a whole case |
| Multi-file cases | real-world test | verified 10 recordings | no cross-file search/concordance |
| Archive/delivery | practitioner | per-file export | no single case archive |
| QA | practitioner | manual | no QA report, no coverage check |

---

## 8. Technology landscape 2026

Assessed for a **local Windows x64, offline-first** product. The engine is
**not** to be replaced without human-corpus evidence (§9).

| Option | What it is | Turkish / multilingual | Local Windows fit | Verdict |
| --- | --- | --- | --- | --- |
| **whisper.cpp** (v1.9.x, 2026) | C/C++ GGML port; CUDA/Vulkan/CPU; native VAD; quantized models | Same Whisper weights; 99+ languages; Turkish supported | **Excellent** — static binary, no Python | **Keep as engine** |
| **Whisper large-v3-turbo** | 809M, 4-layer decoder; ~6 GB VRAM; ~8× large-v3 speed | FLEURS-TR ~7.75% WER | Via whisper.cpp | **Keep as default model** |
| **faster-whisper** | CTranslate2 reimplementation | Same weights | Needs Python + CUDA | Reject for end users |
| **WhisperX** | faster-whisper + wav2vec2 forced alignment + pyannote diarization | Alignment quality good; needs Python/HF token | Needs Python + torch + HF account | Reference for **future alignment/diarization**, not MVP |
| **Qwen3-ASR** (0.6B/1.7B) | 2026 multilingual ASR, 52 languages | Strong multilingual; **no published Turkish-specific WER found** | Python runtimes; not GGML | **Evaluate only with Turkish corpus** |
| **NVIDIA Parakeet TDT v3** | FastConformer-TDT, 0.6B, 25 European languages | No Turkish in v3's 25 | Python/NeMo | Out for Turkish |
| **Canary / Granite Speech** | High English accuracy | English-centric | Python | Out for Turkish |
| **Silero VAD** | VAD model | language-neutral | GGML via whisper.cpp | **Keep** |
| **pyannote.audio 3.x** | State-of-art diarization | language-neutral | Python + HF gated token | Future optional, degrades gracefully |

**Key 2026 facts used:** whisper.cpp v1.9.x added a native VAD path and CUDA
device selection; Whisper's known failure modes are **hallucination on silence**
and **repetition loops**, mitigated by VAD pre-filtering, beam search and
temperature fallback — all of which the current pipeline already uses (VAD on,
`-bs 5`, temperature fallback default on). Whisper timestamps drift; forced
alignment is the remedy when word-level precision is required.

---

## 9. ASR / model benchmark strategy

Purpose: decide, **with evidence**, whether the current engine/model is good
enough for Turkish 56.12 work, and whether any change is justified. Synthetic
audio is for **regression only**; quality claims require a human corpus.

### 9.1 Metrics

| Metric | Definition |
| --- | --- |
| WER / CER | Levenshtein over words / characters, normalised text |
| Numeric accuracy | exact-match rate on digit/date/phone strings |
| Proper-name accuracy | exact-match rate on a fixed name list |
| Hallucination rate | invented spans in silence-only or non-speech regions |
| Timestamp error | mean/95th-percentile offset of anchor events vs ground truth |
| Speech omission rate | ground-truth speech intervals with no emitted segment |
| Processing time / RTF | wall time ÷ audio duration |
| Peak RAM / VRAM | `VmHWM` and `nvidia-smi` peaks |

### 9.2 Tiers

- **Regression (synthetic):** the existing espeak-ng fixtures, run in CI on
  every change, asserting no regression against a stored baseline. Synthetic
  audio cannot be used for a quality claim.
- **Human corpus (quality):** requires recordings with a **human-verified
  Turkish transcript** and time anchors, covering: studio-clean speech;
  telephone/narrowband; background noise; two and three speakers; overlap;
  names; numbers, dates and phone numbers; regional accents; spontaneous
  speech (fillers, false starts); long-form (>30 min); and a silence-only
  control for hallucination measurement.

### 9.3 What a real corpus needs

At least ~5–10 hours across the conditions above, transcribed and time-anchored
by two independent Turkish transcribers with adjudication, plus explicit
redistribution rights. This does not exist; creating it is a research task, not
a coding task. Until then, **no engine/model change is justified**.

### 9.4 Decision rule

Change the engine or model only if, on the human corpus, the candidate improves
WER on the *representative* subset (not only clean audio) with no regression in
timestamp error or hallucination rate, and stays offline-first on Windows.

---

## 10. Red-team strategy (second generation)

The current suite proves controlled failure for corrupt input, cancellation and
single-file cases. The next generation targets **state integrity under
interruption and scale**.

| Scenario | Expected safe behaviour | What it guards |
| --- | --- | --- |
| Crash during save | No half-written transcript; DB consistent on reopen | C1, B1 |
| Crash during migration | Old schema intact or fully migrated; no partial table | B4 |
| Interrupted model install | `.partial` removed; no half model accepted | model integrity |
| Interrupted export | No partial file left that looks complete | C3 |
| Interrupted transcription | No partial transcript row; other evidence intact | B5, existing test |
| Long recording (2h+) | Bounded memory; progress; cancellable; no timeout crash | B6 |
| 100+ evidence items | UI responsive; list virtualised or paginated; no id collision | scale |
| Multiple channels (2ch stereo) | Deterministic, documented behaviour (downmix) | B7 |
| Multiple audio streams | Deterministic choice; documented; not silent | B7 |
| Duplicate names | Distinct evidence; distinct exports | fixed, keep |
| Low disk | Clear error; no corruption | reliability |
| Corrupted model | Rejected by checksum; app still runs on CPU/other model | model integrity |
| Case backup/restore | Round-trips without loss (once implemented) | B2 |
| Update while unsaved work | Prompt or block; no silent loss | E/D |
| DB tampering detection | Detect an out-of-band edit (once implemented) | C1 |
| Log content | No transcript/evidence content in logs | E3/E4 |
| Temporary files | Cleaned on success and failure | hygiene |
| Update rollback | Failed update leaves the running version usable | already verified |
| Unexpected power loss | No corruption (needs `synchronous`) | B1 |

Each scenario gets an automated test where the environment allows, and a
documented manual step where it needs real hardware.

---

## 11. Product opportunity matrix

Ranked by impact, not a wishlist. **Nothing here is approved for
implementation.**

Legend — **Fit:** 56.12 fit. **Risk:** privacy/56.11 risk. **AC:** measurable
acceptance test.

### P0 — reliability and data integrity

| # | Capability | User problem | Evidence | Solution | Complexity | Privacy | Fit | 56.11 risk | AC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0-1 | **Case backup / archive** | A case is a folder + DB row; no single artifact to hand over or store | §4 gaps; practitioner "archive/delivery" | Export a self-contained case archive (manifest + DB + evidence + exports) and import it back | M | none (local) | core | low | Round-trip a 10-evidence case; hashes match; transcripts identical |
| P0-2 | **DB durability** (`synchronous=FULL`, integrity check) | Power loss can lose recent commits | B1, B3 | Set `synchronous`; run `PRAGMA integrity_check` on open; surface failure | S | none | core | low | Kill process mid-write; reopen shows consistent state |
| P0-3 | **Atomic writes** for exports and DB-adjacent files | Interrupted export leaves a partial file | C3 | Write temp + fsync + rename | S | none | core | low | Interrupt export; only complete files present |
| P0-4 | **Crash-safe migration** | A schema rebuild with no backup risks the whole DB | B4 | Copy the DB before a rebuild; verify after | S | none | core | low | Simulate crash mid-migration; DB opens |
| P0-5 | **Evidence re-verification** | The recorded hash is never re-checked | C1 | Verify evidence hashes on case open; flag drift | S | none | core | low | Tamper a file; app flags it |
| P0-6 | **Fix the privacy statement** | Docs claim the only outbound call is the model download, but the updater also checks at startup | E1 | Correct README/security to disclose the startup update check; offer a setting to disable | S | improves | core | low | Docs match code; disabling prevents the call |

### P1 — core 56.12 workflow

| # | Capability | User problem | Evidence | Solution | Complexity | Privacy | Fit | 56.11 risk | AC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1-1 | **Inaudible vs unintelligible** | Both reduce to one placeholder | §6/§7 | Two placeholders plus a non-verbal marker; keyboard shortcuts | S | none | core | low | Each can be set and is exported distinctly |
| P1-2 | **Overlap marking** | Simultaneous speech cannot be represented | authoritative | A per-segment overlap flag and multi-speaker interval | M | none | core | low | Overlap flag set, shown and exported |
| P1-3 | **Per-segment expert note** | No place for the expert's reasoning | §7 | Optional free-text note per segment, in the DB and export | S | none | core | low | Note persists and appears in JSON |
| P1-4 | **Field-level change history** | History says "saved", not what changed | §7 | Record per-segment before/after on save | M | none | core | low | Changing one word records exactly that |
| P1-5 | **Automatic vs edited side-by-side** | The comparison is only visible after export | §7 | Show both texts in the segment row | S | none | core | low | UI-driven acceptance step |
| P1-6 | **Second-review mode** | No explicit second reviewer | practitioner | A reviewer pass with its own status and sign-off | M | none | core | low | Two passes recorded distinctly |

### P2 — reviewer productivity

| # | Capability | User problem | Evidence | Solution | Complexity | Privacy | Fit | 56.11 risk | AC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P2-1 | **A/B loop and bookmark** | Repeated playback is manual | community | Loop the current segment; save positions | S | none | core | low | Loop and bookmark persist |
| P2-2 | **Low-confidence worklist** | No way to find the risky lines | product | Sort/filter by confidence and status | S | none | core | low | Worklist matches a known set |
| P2-3 | **Cross-evidence search** | No search across a case | §7 | Search text/speaker/time across transcripts | M | none | core | low | Query returns the right segments |
| P2-4 | **Speaker time view** | No per-speaker overview | §7 | Speaker filter and timeline | M | none | core | low | Filter shows only that speaker |
| P2-5 | **Glossary / initial prompt** | Names/numbers are error-prone | practitioner | Optional user glossary passed as the whisper prompt | S | none | core | low | Glossary terms improve a fixed fixture |

### P3 — optional advanced (only with corpus evidence)

| # | Capability | User problem | Evidence | Solution | Complexity | Privacy | Fit | 56.11 risk | AC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P3-1 | **Forced alignment** | Segment timestamps can drift | WhisperX | wav2vec2-style word alignment, offline | L | none | core | medium | Timestamp error improves on the corpus |
| P3-2 | **Optional diarization** | Manual labelling is slow | practitioner | Anonymous `SPEAKER_NN` only; must degrade gracefully | L | none | core | **high** | Labels improve over manual on the corpus; never a name |
| P3-3 | **CUDA runtime in the release** | GPU unused in shipped builds | §8 | Build `whisper-cli` with CUDA on a runner that has the toolkit | M | none | core | low | `--engine-report` shows `gpuSelected: true` on RTX 3060 |
| P3-4 | **Long-audio pipeline** | 2h+ recordings are one fragile run | B6 | Chunked processing with resume | L | none | core | low | 2h file completes with bounded RAM |

### OUT — scope violation (do not build)

Speaker identification, voice comparison, biometric voice recognition,
deepfake/splicing/authenticity detection, emotion/sentiment/lie detection,
threat/crime classification, legal interpretation, automatic legal roles,
video-frame analysis, cloud transcription, telemetry, accounts. These belong to
56.11 or other specialities, or violate the product identity.

---

## 12. Proposed target architecture

Direction, not a mandate; changes only via the §11 process.

- **Keep** the process split (main / preload / renderer), the `ft-media`
  protocol, safe `spawn`, the storage layer, the runtime selector, the updater
  state machine, the status model, and `original_text`.
- **Split** `renderer.js` into view modules (cases, evidence, transcript,
  player, dialogs) and `main.js` into IPC modules, moving self-tests to
  `src/main/selftest/`.
- **Introduce** a case-archive service (P0-1) as the single integrity
  boundary, with a manifest that records evidence hashes and the DB.
- **Harden** storage: `synchronous`, integrity check, pre-migration backup,
  atomic writes (P0-2/3/4).
- **Keep the engine** whisper.cpp; add forced alignment and optional
  anonymous diarization only as P3, behind corpus evidence.
- **Keep** offline-first; disclose the one startup update check and make it
  switchable.

## 13. Proposed roadmap

Ordered by risk reduction, pending approval of §11:

1. **R0 — integrity (P0):** backup/archive, durability, atomic writes,
   crash-safe migration, evidence re-verification, privacy-statement fix.
2. **R1 — core workflow (P1):** inaudible/unintelligible, overlap, notes,
   field-level diff, side-by-side, second review.
3. **R2 — productivity (P2):** loop/bookmark, worklists, search, speaker view,
   glossary.
4. **R3 — corpus and evidence-gated changes (P3):** build the human corpus,
   then decide on alignment, diarization, CUDA release, long-audio pipeline.

## 14. Explicit out-of-scope list

Everything under §11 **OUT**, plus: PDF as a hard requirement before it is
properly tested; any LLM summarisation; any network feature; any automatic legal
or identity conclusion. `docs/scope.md` remains the authority.

## 15. Open research questions

1. What does a real 56.12 expert actually produce today, and in what format?
2. Is there any *official* 56.12 transcript format or report template? (None found.)
3. Which Turkish conditions dominate real casework: telephone, background noise,
   dialect, overlap, long-form?
4. What timestamp tolerance is acceptable to practitioners?
5. Is "inaudible vs unintelligible distinction" or "overlap marking" the more
   urgent gap?
6. Does a second-reviewer workflow exist in current 56.12 practice?
7. Would a case archive be used as the handover artifact, and in what form?
8. On the RTX 3060, does CUDA change the practical workflow, and by how much?
9. Does the cohort expect any interoperability with UYAP/SEGBİS at the file level?
10. What does the cohort consider "safe" automation vs "this must be human"?

## 16. Source bibliography

Primary (official):

- T.C. Adalet Bakanlığı, Hukuk İşleri Genel Müdürlüğü, Bilirkişilik Daire
  Başkanlığı — *Bilirkişilik Temel ve Alt Uzmanlık Alanları ile Bilirkişilerde
  Aranan Nitelikler* (2025 edition, dated 29.12.2025).
  https://bilirkisilik.adalet.gov.tr/Resimler/SayfaDokuman/20251229165728294Bilirki%C5%9Filik%20Temel%20ve%20Alt%20Uzmanl%C4%B1k%20Alanlar%C4%B1%20ile%20Bilirki%C5%9Filerde%20Aranan%20Nitelikler.pdf
  (retrieved 2026-10-03). Source of the exact 56.11 / 56.12 wording.
- T.C. Adalet Bakanlığı — *6754 sayılı Bilirkişilik Kanunu* (adopted 03.11.2016,
  Resmî Gazete 24.11.2016/29898). Art. 2, 3.
  https://bilirkisilik.adalet.gov.tr/Resimler/SayfaDokuman/16112023141252bilirki%C5%9Filik%20kanunu.pdf
- HMK (6100) art. 266, 279/4 as amended by 6754 art. 49/54.
  https://barandogan.av.tr/blog/mevzuat/hmk-madde-279-bilirkisi-aciklamalarinin-tespiti-ve-rapor
- Bilirkişilik Daire Başkanlığı — *2025 Yılı Bilirkişilik Başvuru İlanı*
  (published 23.12.2025). https://bilirkisilik.adalet.gov.tr/Home/SayfaDetay/2025-yili-bilirkisilik-basvuru-ilani23122025050542
- T.B.M.M. — Bilirkişilik Kanunu metni.
  https://cdn.tbmm.gov.tr/KKBSPublicFile/D26/Y1/T1/KanunMetni/e3b5db99-e4b9-48f7-8dfc-a41cbb21167f.html

Standards:

- ISO 24624:2016, *Language resource management — Transcription of spoken
  language* (published 2016-08-15; confirmed 2022). https://www.iso.org/standard/37338.html
- CLARIN Standards Information System — ISO 24624 entry.
  https://standards.clarin.eu/sis/views/view-spec.xq?id=SpecTranScript
- Hedeland & Schmidt, *The TEI-based ISO Standard 'Transcription of spoken
  language'*. https://ecp.ep.liu.se/index.php/clarin/article/download/415/431/378
- SWGDE, *Best Practices for Forensic Audio* (08-A-001).
  https://www.swgde.org/documents/published-complete-listing/08-a-001-swgde-best-practices-for-forensic-audio
- SWGDE, *Core Competencies for Forensic Audio* (10-A-001).
  https://www.swgde.org/documents/published-complete-listing/10-a-001-core-competencies-for-forensic-audio
- SWGDE, *Best Practices for Digital Audio Authentication* (15-A-001).
  https://www.swgde.org/documents/published-complete-listing/15-a-001-swgde-best-practices-for-digital-audio-authentication

Technology (2026, secondary):

- whisper.cpp versions and native VAD / CUDA notes.
  https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026
- WhisperX (faster-whisper + wav2vec2 alignment + pyannote). https://localaimaster.com/blog/whisperx-guide
- Open-source STT model comparison 2026 (Canary, Qwen3-ASR, Whisper, Parakeet).
  https://www.gladia.io/blog/best-open-source-speech-to-text-models
- Parakeet vs Whisper-turbo vs Qwen3-ASR production notes.
  https://snailtext.app/blog/parakeet-vs-whisper-turbo-vs-qwen3-asr
- Whisper hallucination on silence and repetition loops. https://metawhisp.com/blog/whisper-hallucination-silence-fix
  and https://localaimaster.com/blog/whisper-hallucination-fix

Practitioner / vendor (tertiary, treat as claims):

- Forensic audio transcription workflow and verbatim requirements (vendor).
  https://sonix.ai/ai/forensic-audio-transcription
- Speaker labels and timestamps best practices (vendor).
  https://hinoter.com/blog/speaker-labels-and-timestamps
- Investigative time-stamped transcripts (vendor).
  https://www.gmrtranscription.com/blog/investigative-transcription-with-timestamps

Repository (internal):

- `docs/scope.md`, `docs/architecture.md`, `docs/methodology.md`,
  `docs/standards.md`, `docs/security.md`, `docs/VERIFICATION.md`,
  `docs/DECISIONS.md`, `docs/model-notes.md`, `README.md` @ `1539d80`.

# Methodology

This document describes how the software turns a recording into a transcript and
how it supports the expert's verification, without making any claim about the
legal value of the result.

## 1. Import and preservation

The original recording is **copied** into the case and is never modified in
place. The copy is hashed with SHA-256 immediately after import. This hash is a
software provenance value: it identifies the exact byte sequence the case was
built from, so a later re-hash of the original can be compared. It is not a
chain-of-custody guarantee.

Technical metadata (container, codec, duration, sample rate, channels, bit
depth) is read with `ffprobe`. A file that cannot be decoded is still imported
and recorded, but is flagged so the operator can see exactly what was rejected.

## 2. Derived working copy

Automatic speech recognition expects a uniform input. The application decodes
the original into a 16 kHz mono PCM WAV working copy under
`evidence/derived/`. The original stays untouched. The working copy is derived,
regenerable, and is clearly named with the evidence id.

## 3. Automatic transcription

Recognition runs locally with whisper.cpp (`whisper-cli`). The engine:

- runs with the operator-selected model (default `large-v3-turbo-q5_0`),
- is told the language explicitly (`tr`) rather than guessing,
- optionally uses Silero VAD to find speech regions,
- optionally uses the GPU (CUDA) and falls back to CPU when disabled or
  unavailable,
- emits token-level timestamps and per-token probabilities.

## 4. From engine output to segments

Each engine segment becomes a transcript segment with:

- `start` / `end` in seconds on the **original** timeline,
- `text` (whitespace-normalised),
- `speaker` (default `SPEAKER_01`),
- `status` = `AUTOMATIC`,
- `confidence` = mean token probability (a real value from the engine, shown so
  the operator can prioritise where to listen first),
- optional `words[]` derived from token timestamps.

### Unclear audio

The engine is not allowed to invent words silently. When the produced text is
empty, the segment text becomes the explicit placeholder `[ANLAŞILAMADI]`. Low
confidence is surfaced through the confidence value so the operator can listen
again. The software does not "clean up" or "guess" what was said.

## 5. Timestamp integrity

The canonical timeline is the original recording. To keep it honest:

- VAD is used to snap boundaries to actual speech onsets,
- an automated integration test places known spoken events at known times and
  asserts the transcript intervals match within a tolerance,
- the release gate fails if that test fails.

No fake precision is produced. Word timestamps are only attached when the engine
actually returns them; otherwise the field is absent rather than synthesised.

## 6. Expert review

The review workspace is built around **audio ↔ transcript verification**:

- clicking a transcript line plays exactly that region of the original audio and
  stops at the segment end,
- a waveform shows position, the selected segment and speech regions,
- the operator can edit text, split at the playhead, merge with the next
  segment, relabel the speaker, and mark status,
- undo/redo is exact (snapshot based), so an edit never destroys the automatic
  text irrecoverably.

Editing a segment raises its status from `AUTOMATIC` to `EDITED` (or keeps a
higher status such as `VERIFIED`). The distinction between machine output and
expert output is therefore always visible.

## 7. Speaker labelling

Speakers are labelled manually (`SPEAKER_01`, `SPEAKER_02`, … or any custom
label). Automatic diarization is not part of the MVP. If it is added, it may only
produce anonymous labels and must never map a label to a person.

## 8. Export

JSON is the canonical interchange format (versioned schema). TXT, SRT and
self-contained HTML are also produced. Every export:

- carries the case id, evidence name and SHA-256,
- states the engine and model used,
- states the machine/expert status of every segment,
- includes the scope disclaimer.

Exports are working drafts, not official report templates.

## 9. Traceability

A `history` table records actions such as `CASE_CREATED`, `EVIDENCE_IMPORTED`,
`TRANSCRIPTION_STARTED`, `TRANSCRIPTION_CREATED`, `TRANSCRIPT_SAVED`,
`EXPORT_CREATED`. This is a software traceability feature, not a legal
chain-of-custody mechanism.

## 10. Limitations

- Whisper is a general-purpose recogniser. Turkish accuracy on noisy,
  overlapping or telephone-quality audio is lower than on clean speech.
- The confidence value is a token probability average; it is a listening
  priority hint, not a calibrated error probability.
- Overlapping speech is not separated. Diarization is not included.
- Automatic output is a first draft and always requires expert review.

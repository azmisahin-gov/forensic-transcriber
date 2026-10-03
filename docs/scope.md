# Scope

## In scope — 56.12

Forensic Transcriber supports the workflow of the expert classification area
**56.12 — Ses Kayıtlarının Metin Haline Dönüştürülmesi** (conversion of audio
recordings into text):

- importing audio (and the audio track of video) recordings,
- recording technical metadata and a SHA-256 of the imported copy,
- local, offline automatic speech recognition with timestamps,
- presenting the transcript next to the audio for line-by-line verification,
- human editing, splitting, merging, speaker labelling and status marking,
- exporting the transcript in structured, readable formats,
- software-level traceability (history, provenance, checksums).

## Out of scope — not implemented, by design

The following belong to 56.11 or to other specialties and are **not** part of
this product. They are not merely "not yet done"; they are outside the intended
purpose and are excluded deliberately:

- speaker identification (who a voice belongs to),
- voice comparison / speaker verification,
- biometric voice recognition,
- deepfake detection,
- audio splicing / manipulation detection,
- audio authenticity analysis,
- emotion detection, sentiment analysis, lie detection,
- threat classification, crime classification,
- legal interpretation, automatic legal opinion,
- inferring intent, or assigning legal roles such as suspect/victim/defendant.

Automatic diarization, if added later, may only ever produce anonymous labels
(`SPEAKER_01`, `SPEAKER_02`, …). It must never resolve a label to a name.

## Video input

Video files (MP4, MOV, MKV, WEBM) are accepted **only** so that the audio track
they contain can be transcribed. No video frame is decoded for analysis, no
image recognition is performed, and no video-forensic feature exists. The
application extracts the first audio stream to a 16 kHz mono working copy and
ignores the picture entirely.

## Automatic output is not expert output

The application never presents machine output as an expert conclusion. Every
segment carries a status (`AUTOMATIC`, `REVIEWED`, `EDITED`, `VERIFIED`).

The **automatic text is stored permanently** in `segments.original_text`. It is
written once when the transcript is created and is never overwritten, so an
expert edit cannot destroy what the engine produced — not on save, not after
closing and reopening the case. The JSON export includes `original_text` for any
segment where it differs from the current text.

## 56.12 capability audit

Checked against the definition of 56.12 ("Ses Kayıtlarının Metin Haline
Dönüştürülmesi — Yargı mercilerince ses ve görüntü bilişim sisteminin
kullanılması hariç").

### Present and verified

| Capability | Where |
| --- | --- |
| Original recording preserved, never modified | Import copies the file; the original is only read |
| SHA-256 of the imported copy | `evidence.sha256`, computed on the copy |
| Technical metadata recorded | container, codec, duration, sample rate, channels, bit depth |
| Transcript tied to the original timeline | `start`/`end` in seconds on the original recording |
| Segment-level audio ↔ text verification | click a line to play exactly that region |
| Machine vs human output kept distinct | `AUTOMATIC` / `REVIEWED` / `EDITED` / `VERIFIED`, plus `original_text` |
| Automatic text never destroyed by editing | `segments.original_text`, never overwritten |
| Unclear speech marked, not invented | `[ANLAŞILAMADI]` placeholder |
| Speaker labels, not identification | `SPEAKER_01…`; never resolved to a name |
| Export does not imply an automatic conclusion | every export states the machine/expert status |
| Original vs derived working copy separated | `evidence/original/` vs `evidence/derived/` |
| Provenance and action history | `history` table surfaced in the case |
| Exported transcript traceable to case/evidence/version | JSON carries case, evidence and hash |

### Category A — 56.12 blockers (fixed in this pass)

1. **Renderer crashed on startup in v0.1.1**, so none of the above was reachable.
2. **An expert edit destroyed the automatic transcript** after save.

### Category B — important usability gaps (not blockers)

1. **A segment cannot be marked explicitly as inaudible versus unintelligible.**
   Both currently reduce to `[ANLAŞILAMADI]`. An expert may want to record
   "no audible speech" separately from "speech present but unclear".
2. **Overlapping / simultaneous speech cannot be marked.** There is no way to
   flag a segment as containing two speakers at once.
3. **The history shows actions, not a field-level diff.** It records that a
   transcript was saved, not which words changed.
4. **No free-text note per segment** for an expert's reasoning.

### Category C — out of scope for 56.12 (do not add)

Speaker identification, voice comparison, deepfake/manipulation detection,
emotion or sentiment analysis, lie detection, threat or crime classification,
legal interpretation, automatic legal roles, video-frame analysis. These belong
to 56.11 or other specialties.

## Legal position

The software is a technical transcription and review aid. It does not itself
constitute a forensic opinion, legal assessment, speaker identification or
authenticity determination. Hash values, history records and logs are described
as **software provenance and traceability features**; no claim is made that they
satisfy any legal chain-of-custody requirement, and no output is described as an
official report template or as accepted by any court.

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
segment carries a status (`AUTOMATIC`, `REVIEWED`, `EDITED`, `VERIFIED`), the
automatic text is preserved in undo history when it is edited, and exports state
the machine/expert distinction explicitly.

## Legal position

The software is a technical transcription and review aid. It does not itself
constitute a forensic opinion, legal assessment, speaker identification or
authenticity determination. Hash values, history records and logs are described
as **software provenance and traceability features**; no claim is made that they
satisfy any legal chain-of-custody requirement, and no output is described as an
official report template or as accepted by any court.

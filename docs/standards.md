# Standards

## Reference standard

**ISO 24624 — Language resource management — Transcription of spoken language**
was reviewed as the reference model for the transcription data structure. Its
core ideas inform this project:

- a transcript is a sequence of time-aligned segments,
- each segment refers to a region of a media timeline,
- speakers are identified by labels,
- the transcript is separate from the media it describes.

The full complexity of the standard (multi-tier annotation, dependency
annotation, alignment of parallel streams) is deliberately **not** carried into
the MVP. The goal is a data model that is *simple, structured, interoperable and
traceable*, not a complete implementation of the standard.

## Resulting data model

A transcript segment carries:

| Field | Meaning |
| --- | --- |
| `segment_id` | stable identifier |
| `start`, `end` | seconds on the original recording timeline |
| `speaker` | label such as `SPEAKER_01` (never a person's name) |
| `text` | transcript text, or `[ANLAŞILAMADI]` when unclear |
| `status` | `AUTOMATIC` / `REVIEWED` / `EDITED` / `VERIFIED` |
| `confidence` | mean token probability from the engine (or null) |
| `words[]` | optional word-level timestamps when the engine provides them |

## Interchange format

JSON is the canonical interchange format with a versioned schema:

```json
{
  "schema_version": "1.0",
  "case_id": "CASE-...",
  "evidence_id": "EVIDENCE-...",
  "language": "tr",
  "segments": [
    { "start": 12.42, "end": 15.91, "speaker": "SPEAKER_01", "text": "..." }
  ]
}
```

`schema_version` allows a future format change to be migrated explicitly rather
than silently.

## Time formats

- Internal storage and JSON: seconds (floating point).
- SRT: `HH:MM:SS,mmm`.
- UI and TXT/HTML display: `HH:MM:SS.mmm`.

## Deliberate omissions

The following are intentionally out of the MVP and tracked on the roadmap:

- multi-tier / parallel annotation,
- phonetic or prosodic annotation tiers,
- a full TEI or ELAN import/export,
- automatic diarization.

These can be added later without breaking the schema because `schema_version` is
explicit.

'use strict';

/**
 * Optional local report-draft assist.
 *
 * This is deliberately NOT a language model and makes NO outbound call. The
 * application is offline-first and forbids cloud transcription, telemetry and
 * hidden network access, so no model is bundled or downloaded here. What this
 * provides is a deterministic draft builder: it assembles a starting point for
 * the operator's own report from data the operator already entered (structured
 * findings, transcript revision states, unresolved segments). It never invents
 * text, never interprets, and never produces a conclusion.
 *
 * It is disabled by default. When disabled, `generate` returns AI_DISABLED and
 * nothing is written. When enabled, the output is clearly marked as a draft
 * assembled from the operator's own records and still requires expert review.
 */

const { SEGMENT_STATUS, UNCLEAR_PLACEHOLDER } = require('../../shared/constants');

const DEFAULT_STATE = { enabled: false };

function status(state = DEFAULT_STATE) {
  return {
    enabled: Boolean(state && state.enabled),
    language_model: false,
    network: false,
    // The interface is present so a future, explicitly installed local helper
    // could be wired in; today there is none, and this reports that honestly.
    available: Boolean(state && state.enabled),
    reason: state && state.enabled
      ? 'local deterministic draft builder'
      : 'disabled (offline-first: no model is bundled or downloaded)',
  };
}

/**
 * Build a draft from the operator's own structured data.
 *
 * @returns {{ok:boolean, code?:string, draft?:object}}
 */
function generate({ storage, caseId, evidenceId = null, action = 'report-draft' } = {}) {
  if (!DEFAULT_STATE.enabled) {
    return { ok: false, code: 'AI_DISABLED', message: 'Local assist is disabled.' };
  }
  if (action !== 'report-draft') {
    return { ok: false, code: 'AI_ACTION_UNSUPPORTED', message: `Unsupported action: ${action}` };
  }
  const evidence = evidenceId
    ? storage.listEvidence(caseId).filter((e) => e.evidence_id === evidenceId)
    : storage.listEvidence(caseId);

  const lines = [];
  for (const ev of evidence) {
    const t = storage.getTranscript(caseId, ev.evidence_id);
    if (!t) continue;
    const rev = storage.getCurrentRevisionInfo(t.transcript_id);
    const segments = storage.getSegments(t.transcript_id);
    const unresolved = segments.filter(
      (s) => s.status === SEGMENT_STATUS.AUTOMATIC || s.text === UNCLEAR_PLACEHOLDER
    ).length;
    lines.push({
      evidence_id: ev.evidence_id,
      evidence_name: ev.original_name,
      revision_id: rev ? rev.revision_id : null,
      revision_state: rev ? rev.state : null,
      segment_count: segments.length,
      unresolved_segments: unresolved,
    });
  }

  const findings = storage.listFindings(caseId).map((f) => ({
    finding_id: f.finding_id,
    title: f.title,
    observation: f.observation,
    evidence_id: f.evidence_id,
    revision_id: f.revision_id,
    at_seconds: f.at_seconds,
  }));

  return {
    ok: true,
    draft: {
      generated_at: new Date().toISOString(),
      // Explicitly not machine-authored prose: this is the operator's own data,
      // gathered so they can start typing their report.
      origin: 'assembled-from-operator-records',
      requires_expert_review: true,
      transcripts: lines,
      findings,
    },
  };
}

module.exports = { status, generate, DEFAULT_STATE };

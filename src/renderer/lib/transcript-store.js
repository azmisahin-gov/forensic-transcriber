'use strict';

/**
 * In-memory transcript model with snapshot-based undo/redo.
 *
 * Every mutating operation records a snapshot, so undo/redo is exact. The
 * store is deliberately free of DOM and IPC so it can be unit tested directly.
 * UMD wrapper: usable from the renderer (global) and from Node tests (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../shared/constants'));
  } else {
    // Loaded as a plain browser script: FT_CONSTANTS must already be defined.
    // Fail with an explicit message rather than a cryptic destructuring error,
    // so a wrong <script> order is obvious instead of silent.
    if (!root.FT_CONSTANTS) {
      throw new Error(
        'transcript-store.js requires FT_CONSTANTS. Load ../shared/constants.js before lib/transcript-store.js.'
      );
    }
    root.FT_TRANSCRIPT_STORE = factory(root.FT_CONSTANTS);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (constants) {
  if (!constants || !constants.SEGMENT_STATUS) {
    throw new Error('transcript-store.js: constants module did not provide SEGMENT_STATUS.');
  }
  const { SEGMENT_STATUS, UNCLEAR_PLACEHOLDER } = constants;
  const MAX_HISTORY = 200;

  function cloneSegments(segments) {
    return segments.map((s) => ({
      ...s,
      words: Array.isArray(s.words) ? s.words.map((w) => ({ ...w })) : s.words ?? null,
    }));
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  class TranscriptStore {
    constructor(segments = []) {
      this.segments = cloneSegments(segments).sort((a, b) => a.start - b.start);
      this._undo = [];
      this._redo = [];
      this.dirty = false;
      this._listeners = new Set();
    }

    onChange(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    _emit() {
      for (const fn of this._listeners) fn(this);
    }

    _snapshot() {
      return { segments: cloneSegments(this.segments), dirty: this.dirty };
    }

    _commit() {
      this._undo.push(this._snapshot());
      if (this._undo.length > MAX_HISTORY) this._undo.shift();
      this._redo.length = 0;
      this.dirty = true;
      this._emit();
    }

    get canUndo() {
      return this._undo.length > 0;
    }

    get canRedo() {
      return this._redo.length > 0;
    }

    undo() {
      if (!this._undo.length) return false;
      this._redo.push(this._snapshot());
      const prev = this._undo.pop();
      this.segments = prev.segments;
      this.dirty = prev.dirty;
      this._emit();
      return true;
    }

    redo() {
      if (!this._redo.length) return false;
      this._undo.push(this._snapshot());
      const next = this._redo.pop();
      this.segments = next.segments;
      this.dirty = next.dirty;
      this._emit();
      return true;
    }

    getById(segmentId) {
      return this.segments.find((s) => s.segment_id === segmentId) || null;
    }

    indexOf(segmentId) {
      return this.segments.findIndex((s) => s.segment_id === segmentId);
    }

    replaceAll(segments) {
      this.segments = cloneSegments(segments).sort((a, b) => a.start - b.start);
      this._undo.length = 0;
      this._redo.length = 0;
      this.dirty = false;
      this._emit();
    }

    markSaved() {
      this.dirty = false;
      this._undo.length = 0;
      this._redo.length = 0;
      this._emit();
    }

    _humanStatus(current) {
      return current === SEGMENT_STATUS.AUTOMATIC ? SEGMENT_STATUS.EDITED : current;
    }

    editText(segmentId, text) {
      const seg = this.getById(segmentId);
      if (!seg) return false;
      const next = typeof text === 'string' ? text : '';
      const normalized = next.trim().length ? next : UNCLEAR_PLACEHOLDER;
      if (seg.text === normalized && seg.status !== SEGMENT_STATUS.AUTOMATIC) return false;
      this._commit();
      const target = this.getById(segmentId);
      target.text = normalized;
      target.status = this._humanStatus(seg.status);
      this._emit();
      return true;
    }

    setSpeaker(segmentId, speaker) {
      const seg = this.getById(segmentId);
      if (!seg || !speaker || seg.speaker === speaker) return false;
      this._commit();
      const target = this.getById(segmentId);
      target.speaker = speaker;
      target.status = this._humanStatus(seg.status);
      this._emit();
      return true;
    }

    setStatus(segmentId, status) {
      const seg = this.getById(segmentId);
      if (!seg || seg.status === status) return false;
      this._commit();
      this.getById(segmentId).status = status;
      this._emit();
      return true;
    }

    setStatusBulk(segmentIds, status) {
      const ids = new Set(segmentIds);
      const changed = this.segments.some((s) => ids.has(s.segment_id) && s.status !== status);
      if (!changed) return false;
      this._commit();
      for (const s of this.segments) if (ids.has(s.segment_id)) s.status = status;
      this._emit();
      return true;
    }

    deleteSegment(segmentId) {
      if (!this.getById(segmentId)) return false;
      this._commit();
      this.segments = this.segments.filter((s) => s.segment_id !== segmentId);
      this._emit();
      return true;
    }

    splitSegment(segmentId, atSeconds) {
      const idx = this.indexOf(segmentId);
      if (idx < 0) return false;
      const seg = this.segments[idx];
      const at = Number(atSeconds);
      if (!Number.isFinite(at) || at <= seg.start + 0.02 || at >= seg.end - 0.02) return false;

      const ratio = (at - seg.start) / (seg.end - seg.start);
      const words = seg.text.split(/\s+/).filter(Boolean);
      const cut = Math.max(1, Math.min(Math.max(1, words.length - 1), Math.round(words.length * ratio)));
      const firstText = words.slice(0, cut).join(' ') || seg.text;
      const secondText = words.slice(cut).join(' ') || seg.text;

      let firstWords = null;
      let secondWords = null;
      if (Array.isArray(seg.words)) {
        firstWords = seg.words.filter((w) => w.start < at);
        secondWords = seg.words.filter((w) => w.start >= at);
        if (!firstWords.length || !secondWords.length) {
          firstWords = null;
          secondWords = null;
        }
      }

      const first = {
        ...seg,
        end: at,
        text: firstText,
        status: this._humanStatus(seg.status),
        words: firstWords,
      };
      const second = {
        segment_id: this._uniqueId(`${seg.segment_id}-B`),
        start: at,
        end: seg.end,
        speaker: seg.speaker,
        text: secondText,
        status: this._humanStatus(seg.status),
        confidence: seg.confidence ?? null,
        words: secondWords,
      };

      this._commit();
      const i = this.indexOf(segmentId);
      this.segments.splice(i, 1, first, second);
      this._emit();
      return true;
    }

    mergeWithNext(segmentId) {
      const idx = this.indexOf(segmentId);
      if (idx < 0 || idx >= this.segments.length - 1) return false;
      const a = this.segments[idx];
      const b = this.segments[idx + 1];
      const merged = {
        ...a,
        end: Math.max(a.end, b.end),
        text: `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim(),
        status: this._humanStatus(a.status === SEGMENT_STATUS.AUTOMATIC ? b.status : a.status),
        confidence: null,
        words: Array.isArray(a.words) && Array.isArray(b.words) ? [...a.words, ...b.words] : null,
      };
      this._commit();
      const i = this.indexOf(segmentId);
      this.segments.splice(i, 2, merged);
      this._emit();
      return true;
    }

    insertSegmentAfter(segmentId, { start, end, speaker, text, status } = {}) {
      const idx = this.indexOf(segmentId);
      const anchor = idx >= 0 ? this.segments[idx] : null;
      const seg = {
        segment_id: this._uniqueId(`SEG-NEW-${Date.now().toString(36)}`),
        start: start ?? (anchor ? anchor.end : 0),
        end: end ?? (anchor ? anchor.end + 1 : 1),
        speaker: speaker || (anchor ? anchor.speaker : 'SPEAKER_01'),
        text: text || UNCLEAR_PLACEHOLDER,
        status: status || SEGMENT_STATUS.EDITED,
        confidence: null,
        words: null,
      };
      this._commit();
      const i = this.indexOf(segmentId);
      this.segments.splice(i + 1, 0, seg);
      this._emit();
      return seg;
    }

    /**
     * Make an id unique within this transcript. Split and insert derive ids from
     * a base string; repeated operations on the same base would otherwise
     * collide, which the database (transcript_id, segment_id) key would reject.
     */
    _uniqueId(base) {
      let candidate = base;
      let n = 1;
      while (this.segments.some((s) => s.segment_id === candidate)) {
        candidate = `${base}-${n}`;
        n += 1;
      }
      return candidate;
    }

    toPayload() {
      return this.segments.map((s) => ({
        segment_id: s.segment_id,
        start: s.start,
        end: s.end,
        speaker: s.speaker,
        text: s.text,
        // Carried through so the stored automatic text is never overwritten by
        // an edit. The main process preserves the existing value regardless.
        original_text: s.original_text ?? s.text,
        status: s.status,
        confidence: s.confidence ?? null,
        words: s.words ?? null,
      }));
    }

    serialize() {
      return cloneValue({
        segments: this.segments,
        dirty: this.dirty,
        canUndo: this.canUndo,
        canRedo: this.canRedo,
      });
    }
  }

  return { TranscriptStore, cloneSegments };
});

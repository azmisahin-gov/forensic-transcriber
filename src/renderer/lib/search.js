'use strict';

/**
 * Pure helpers for transcript filtering and search-result highlighting.
 *
 * The actual case-wide search runs in the main process against SQLite; these
 * functions only shape and present the results in the renderer (and are unit
 * testable without a DOM). UMD so the same file loads in the renderer and under
 * Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FT_SEARCH = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FILTERS = Object.freeze({
    ALL: 'all',
    UNCLEAR: 'unclear',
    UNREVIEWED: 'unreviewed',
    LOW_CONFIDENCE: 'low-confidence',
  });

  /** True when a segment is marked as an unclear / to-revisit working item. */
  function isUnclear(segment, placeholder) {
    if (!segment) return false;
    if (segment.status === 'REVIEWED' || segment.status === 'EDITED' || segment.status === 'VERIFIED') {
      return false;
    }
    if (segment.text === placeholder) return true;
    return Array.isArray(segment.flags) && segment.flags.length > 0;
  }

  function isUnreviewed(segment) {
    return Boolean(segment) && segment.status === 'AUTOMATIC';
  }

  function isLowConfidence(segment, threshold = 0.6) {
    return Boolean(segment) && typeof segment.confidence === 'number' && segment.confidence < threshold;
  }

  /**
   * Filter a segment list by a named filter. `placeholder` is the text used for
   * an unclear segment; it is passed in rather than imported so this module has
   * no dependency on the constants file.
   */
  function filterSegments(segments, filter, { placeholder = '[ANLAŞILAMADI]', threshold = 0.6 } = {}) {
    if (!Array.isArray(segments)) return [];
    switch (filter) {
      case FILTERS.UNCLEAR:
        return segments.filter((s) => isUnclear(s, placeholder));
      case FILTERS.UNREVIEWED:
        return segments.filter((s) => isUnreviewed(s));
      case FILTERS.LOW_CONFIDENCE:
        return segments.filter((s) => isLowConfidence(s, threshold));
      case FILTERS.ALL:
      default:
        return segments.slice();
    }
  }

  /**
   * Find case-insensitive occurrences of `query` in `text`. Returns an array of
   * {start, end} ranges, in order, for the renderer to wrap in <mark>.
   */
  function highlightRanges(text, query) {
    const haystack = String(text ?? '');
    const needle = String(query ?? '');
    if (!needle) return [];
    const lowerHay = haystack.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const ranges = [];
    let from = 0;
    while (from <= lowerHay.length - lowerNeedle.length) {
      const idx = lowerHay.indexOf(lowerNeedle, from);
      if (idx < 0) break;
      ranges.push({ start: idx, end: idx + lowerNeedle.length });
      from = idx + Math.max(1, lowerNeedle.length);
    }
    return ranges;
  }

  /**
   * Split `text` into ordered parts for rendering with highlights:
   * [{ text, match: boolean }]. Avoids any HTML string building in the caller.
   */
  function highlightParts(text, query) {
    const haystack = String(text ?? '');
    const ranges = highlightRanges(haystack, query);
    if (!ranges.length) return [{ text: haystack, match: false }];
    const parts = [];
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) parts.push({ text: haystack.slice(cursor, r.start), match: false });
      parts.push({ text: haystack.slice(r.start, r.end), match: true });
      cursor = r.end;
    }
    if (cursor < haystack.length) parts.push({ text: haystack.slice(cursor), match: false });
    return parts;
  }

  return {
    FILTERS,
    isUnclear,
    isUnreviewed,
    isLowConfidence,
    filterSegments,
    highlightRanges,
    highlightParts,
  };
});

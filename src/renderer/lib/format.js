'use strict';

/** Formatting helpers. UMD so the same file runs in the renderer and in tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FT_FORMAT = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function pad(n, width = 2) {
    return String(Math.floor(n)).padStart(width, '0');
  }

  /** HH:MM:SS.mmm */
  function formatClock(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const ms = Math.round((s % 1) * 1000);
    const total = Math.floor(s);
    return `${pad(total / 3600)}:${pad((total % 3600) / 60)}:${pad(total % 60)}.${pad(ms, 3)}`;
  }

  /** Short MM:SS for compact lists. */
  function formatShort(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const total = Math.floor(s);
    return `${pad(total / 60)}:${pad(total % 60)}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0 ? `${h}h ${pad(m)}m ${pad(sec)}s` : `${m}m ${pad(sec)}s`;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  return { formatClock, formatShort, formatBytes, formatDuration, relativeTime };
});

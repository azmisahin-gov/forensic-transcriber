'use strict';

/**
 * Waveform drawing. Kept as pure functions over a 2D context so the geometry
 * can be reasoned about (and tested with a stub context) without a DOM.
 *
 * The waveform is a visual aid only: it is derived from the original audio by
 * FFmpeg and is never tied to the ASR engine's internal chunking.
 * UMD so the same file loads in the renderer and under Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FT_WAVEFORM = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COLORS = {
    background: '#141b24',
    base: '#3d5166',
    played: '#4ea1ff',
    selection: 'rgba(78, 161, 255, 0.16)',
    selectionEdge: '#4ea1ff',
    playhead: '#ffcf4d',
    grid: 'rgba(255,255,255,0.05)',
  };

  function timeToX(time, duration, width) {
    if (!duration || duration <= 0) return 0;
    return Math.max(0, Math.min(width, (time / duration) * width));
  }

  function xToTime(x, duration, width) {
    if (!width) return 0;
    return Math.max(0, Math.min(duration, (x / width) * duration));
  }

  function drawWaveform(ctx, { width, height, peaks, duration, currentTime = 0, selection = null }) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    const mid = height / 2;
    const n = peaks && peaks.length ? peaks.length : 0;
    const playX = timeToX(currentTime, duration, width);

    if (selection && duration > 0) {
      const x1 = timeToX(selection.start, duration, width);
      const x2 = timeToX(selection.end, duration, width);
      ctx.fillStyle = COLORS.selection;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
      ctx.fillStyle = COLORS.selectionEdge;
      ctx.fillRect(x1, 0, 1, height);
      ctx.fillRect(x2 - 1, 0, 1, height);
    }

    if (n === 0) {
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      return;
    }

    const step = width / n;
    for (let i = 0; i < n; i += 1) {
      const x = i * step;
      const amp = Math.max(0.008, Math.min(1, peaks[i]));
      const h = amp * (height * 0.46);
      const played = x + step / 2 <= playX;
      ctx.fillStyle = played ? COLORS.played : COLORS.base;
      ctx.fillRect(x, mid - h, Math.max(1, step - 0.4), h * 2);
    }

    if (duration > 0) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(playX, 0, 2, height);
    }
  }

  /** Downsample a peak array to a target bucket count (nearest-max). */
  function resamplePeaks(peaks, target) {
    if (!peaks || !peaks.length || target <= 0) return [];
    if (peaks.length <= target) return peaks.slice();
    const out = new Array(target);
    const ratio = peaks.length / target;
    for (let i = 0; i < target; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(peaks.length, Math.floor((i + 1) * ratio));
      let max = 0;
      for (let j = start; j < end; j += 1) if (peaks[j] > max) max = peaks[j];
      out[i] = max;
    }
    return out;
  }

  return { drawWaveform, resamplePeaks, timeToX, xToTime, COLORS };
});

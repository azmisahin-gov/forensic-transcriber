'use strict';

/**
 * Thin wrapper around an HTMLAudioElement that exposes the operations the
 * review workspace needs. Playback of a transcript segment always seeks to the
 * canonical timeline position supplied by the caller (seconds into the
 * original recording), never an engine-internal offset.
 * UMD so the same file loads in the renderer and under Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FT_AUDIO = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  class AudioController {
    constructor(audioEl, { onTime, onState, onDuration } = {}) {
      this.audio = audioEl;
      this.audio.preload = 'metadata';
      this._onTime = onTime;
      this._onState = onState;
      this._onDuration = onDuration;
      this._segmentStopAt = null;
      this._listeners = [];

      this._bind('timeupdate', () => {
        if (this._onTime) this._onTime(this.audio.currentTime);
        if (this._segmentStopAt !== null && this.audio.currentTime >= this._segmentStopAt) {
          this._segmentStopAt = null;
          this.pause();
        }
      });
      this._bind('durationchange', () => {
        if (this._onDuration && Number.isFinite(this.audio.duration)) this._onDuration(this.audio.duration);
      });
      this._bind('loadedmetadata', () => {
        if (this._onDuration && Number.isFinite(this.audio.duration)) this._onDuration(this.audio.duration);
      });
      this._bind('play', () => this._onState && this._onState('playing'));
      this._bind('pause', () => this._onState && this._onState('paused'));
      this._bind('ended', () => {
        this._segmentStopAt = null;
        this._onState && this._onState('ended');
      });
      this._bind('error', () => this._onState && this._onState('error'));
    }

    _bind(type, handler) {
      this.audio.addEventListener(type, handler);
      this._listeners.push([type, handler]);
    }

    load(url) {
      this.audio.src = url;
      this.audio.load();
    }

    destroy() {
      for (const [type, handler] of this._listeners) this.audio.removeEventListener(type, handler);
      this._listeners = [];
    }

    get duration() {
      return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    get currentTime() {
      return this.audio.currentTime || 0;
    }

    get paused() {
      return this.audio.paused;
    }

    get playbackRate() {
      return this.audio.playbackRate;
    }

    play() {
      const p = this.audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => this._onState && this._onState('error'));
    }

    pause() {
      this.audio.pause();
    }

    toggle() {
      if (this.audio.paused) this.play();
      else this.pause();
    }

    seek(seconds) {
      const clamped = Math.max(0, Math.min(Number(seconds) || 0, this.duration || Number(seconds) || 0));
      this.audio.currentTime = clamped;
      if (this._onTime) this._onTime(this.audio.currentTime);
    }

    skip(delta) {
      this.seek(this.currentTime + delta);
    }

    setPlaybackRate(rate) {
      const r = Number(rate);
      if (Number.isFinite(r) && r > 0) this.audio.playbackRate = r;
    }

    /** Play a segment region and stop automatically at its end. */
    playSegment(start, end) {
      this._segmentStopAt = Number.isFinite(end) ? end : null;
      this.seek(start);
      this.play();
    }

    stopAtSegmentEnd() {
      this._segmentStopAt = null;
    }
  }

  return { AudioController };
});

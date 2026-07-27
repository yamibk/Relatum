(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumCanvasTimer = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const WIDTH = 248;
  const HEIGHT = 112;
  const MAX_LABEL_LENGTH = 60;
  const MAX_DURATION_MS = ((99 * 60 * 60) + (59 * 60) + 59) * 1000;
  const MODES = new Set(['countdown', 'countup']);

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeMode(value) {
    return MODES.has(value) ? value : 'countdown';
  }

  function normalizeLabel(value) {
    return String(value == null ? '' : value).trim().slice(0, MAX_LABEL_LENGTH);
  }

  function normalizeDuration(value) {
    const duration = Math.round(finiteNumber(value, 25 * 60 * 1000));
    return Math.min(MAX_DURATION_MS, Math.max(1000, duration));
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id == null ? '' : raw.id).trim();
    const x = finiteNumber(raw.x, null);
    const y = finiteNumber(raw.y, null);
    if (!id || x === null || y === null) return null;
    const mode = normalizeMode(raw.mode);
    const timer = {
      id: id,
      x: x,
      y: y,
      mode: mode,
      label: normalizeLabel(raw.label),
      elapsedMs: Math.max(0, Math.round(finiteNumber(raw.elapsedMs, 0))),
    };
    if (mode === 'countdown') {
      timer.durationMs = normalizeDuration(raw.durationMs);
      timer.elapsedMs = Math.min(timer.durationMs, timer.elapsedMs);
    }
    return timer;
  }

  function normalizeList(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const timers = [];
    raw.forEach(function (item) {
      const timer = normalize(item);
      if (!timer || seen.has(timer.id)) return;
      seen.add(timer.id);
      timers.push(timer);
    });
    return timers;
  }

  function clone(raw) {
    const timer = normalize(raw);
    if (!timer) return null;
    const copy = {
      id: timer.id,
      x: timer.x,
      y: timer.y,
      mode: timer.mode,
      label: timer.label,
      elapsedMs: timer.elapsedMs,
    };
    if (timer.mode === 'countdown') copy.durationMs = timer.durationMs;
    return copy;
  }

  function effectiveElapsed(raw, runtime, now) {
    const timer = normalize(raw);
    if (!timer) return 0;
    let elapsed = timer.elapsedMs;
    if (runtime && runtime.running) {
      const startedAt = finiteNumber(runtime.startedAt, finiteNumber(now, Date.now()));
      elapsed += Math.max(0, finiteNumber(now, Date.now()) - startedAt);
    }
    elapsed = Math.max(0, elapsed);
    return timer.mode === 'countdown' ? Math.min(timer.durationMs, elapsed) : elapsed;
  }

  function isComplete(raw, elapsedMs) {
    const timer = normalize(raw);
    if (!timer || timer.mode !== 'countdown') return false;
    const elapsed = elapsedMs == null ? timer.elapsedMs : Math.max(0, finiteNumber(elapsedMs, 0));
    return elapsed >= timer.durationMs;
  }

  function displayMilliseconds(raw, elapsedMs) {
    const timer = normalize(raw);
    if (!timer) return 0;
    const elapsed = Math.max(0, finiteNumber(elapsedMs, timer.elapsedMs));
    if (timer.mode === 'countdown') return Math.max(0, timer.durationMs - elapsed);
    return elapsed;
  }

  function format(raw, elapsedMs) {
    const timer = normalize(raw);
    if (!timer) return '00:00:00';
    const milliseconds = displayMilliseconds(timer, elapsedMs);
    const totalSeconds = timer.mode === 'countdown'
      ? Math.ceil(milliseconds / 1000)
      : Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return String(hours).padStart(2, '0')
      + ':' + String(minutes).padStart(2, '0')
      + ':' + String(seconds).padStart(2, '0');
  }

  function durationFromParts(hours, minutes, seconds) {
    const h = Number(hours);
    const m = Number(minutes);
    const s = Number(seconds);
    if (![h, m, s].every(Number.isSafeInteger)
      || h < 0 || h > 99
      || m < 0 || m > 59
      || s < 0 || s > 59) {
      return null;
    }
    const duration = ((h * 3600) + (m * 60) + s) * 1000;
    return duration >= 1000 && duration <= MAX_DURATION_MS ? duration : null;
  }

  function durationParts(value) {
    const duration = normalizeDuration(value);
    const totalSeconds = Math.floor(duration / 1000);
    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }

  function reset(raw) {
    const timer = clone(raw);
    if (!timer) return null;
    timer.elapsedMs = 0;
    return timer;
  }

  function toggle(raw, runtime, now) {
    const timer = clone(raw);
    if (!timer) return null;
    const timestamp = finiteNumber(now, Date.now());
    if (runtime && runtime.running) {
      timer.elapsedMs = effectiveElapsed(timer, runtime, timestamp);
      return { timer: timer, runtime: null, running: false };
    }
    if (isComplete(timer, timer.elapsedMs)) timer.elapsedMs = 0;
    return {
      timer: timer,
      runtime: { running: true, startedAt: timestamp },
      running: true,
    };
  }

  function toggleBatch(entries, now) {
    const timestamp = finiteNumber(now, Date.now());
    if (!Array.isArray(entries)) return [];
    return entries.map(function (entry) {
      if (!entry || typeof entry !== 'object') return null;
      const result = toggle(entry.timer, entry.runtime, timestamp);
      if (!result) return null;
      return {
        id: result.timer.id,
        timer: result.timer,
        runtime: result.runtime,
        running: result.running,
      };
    }).filter(Boolean);
  }

  return {
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    MAX_LABEL_LENGTH: MAX_LABEL_LENGTH,
    MAX_DURATION_MS: MAX_DURATION_MS,
    normalizeMode: normalizeMode,
    normalizeDuration: normalizeDuration,
    normalize: normalize,
    normalizeList: normalizeList,
    clone: clone,
    effectiveElapsed: effectiveElapsed,
    displayMilliseconds: displayMilliseconds,
    isComplete: isComplete,
    format: format,
    durationFromParts: durationFromParts,
    durationParts: durationParts,
    reset: reset,
    toggle: toggle,
    toggleBatch: toggleBatch,
  };
});

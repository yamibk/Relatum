// Lightweight common shell when the canvas homepage is not selected.
(function () {
  'use strict';
  const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; } };
  const query = role => document.querySelector('[data-role="' + role + '"]');
  const startSpeedRange = query('start-speed-range'), startSpeedValue = query('start-speed-value');
  const spineSpeedRange = query('spine-speed-range'), spineSpeedValue = query('spine-speed-value');
  const noteFontScaleRange = query('note-font-scale'), noteFontScaleValue = query('note-font-scale-value');
  const careerScrollFeelRanges = Array.from(document.querySelectorAll('[data-role="career-scroll-feel-range"]'));
  const careerScrollFeelValues = Array.from(document.querySelectorAll('[data-role="career-scroll-feel-value"]'));
  const careerScrollRevealToggle = query('career-scroll-reveal-toggle');
  const START_SPEED_KEY = 'canvas:startTurnMs', START_SPEED_MIN = 180, START_SPEED_MAX = 500, START_SPEED_DEFAULT = 260;
  const SPINE_SPEED_KEY = 'canvas:spineMotionMs:v1', SPINE_SPEED_MIN = 100, SPINE_SPEED_MAX = 800, SPINE_SPEED_DEFAULT = 414;
  const CAREER_SCROLL_FEEL_KEY = 'canvas:careerScrollFeel:v1', CAREER_SCROLL_IDLE_KEY = 'canvas:careerScrollIdleMs:v1';
  const CAREER_SCROLL_IDLE_MIN = 20, CAREER_SCROLL_IDLE_MAX = 160, CAREER_SCROLL_IDLE_DEFAULT = 50;
  const CAREER_SCROLL_FEEL_DEFAULTS = Object.freeze({ strength: 100, inertia: 45, acceleration: 60, maxSpeed: 2400, pauseReveal: false });
  const NOTE_FONT_SCALE_KEY = 'canvas:noteFontScale:v1', NOTE_IMAGE_TEXT_SCALE_KEY = 'canvas:noteImageTextScale:v1';
  let startTurnSpeed = START_SPEED_DEFAULT;
  function clampStartSpeed(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return START_SPEED_DEFAULT;
    const rounded = Math.round(n / 10) * 10;
    return Math.max(START_SPEED_MIN, Math.min(START_SPEED_MAX, rounded));
  }

  function setStartMsVar(name, value) {
    document.documentElement.style.setProperty(name, Math.round(value) + 'ms');
  }

  function applySpineSpeed(value, persist) {
    const n = Number(value);
    const ms = value == null || value === '' || !Number.isFinite(n)
      ? SPINE_SPEED_DEFAULT
      : Math.max(SPINE_SPEED_MIN, Math.min(SPINE_SPEED_MAX, Math.round(n)));
    setStartMsVar('--spine-motion-ms', ms);
    if (spineSpeedRange) {
      spineSpeedRange.value = String(ms);
      spineSpeedRange.setAttribute('aria-valuetext', ms + 'ms');
    }
    if (spineSpeedValue) spineSpeedValue.textContent = ms + 'ms';
    if (persist) {
      try { localStorage.setItem(SPINE_SPEED_KEY, String(ms)); } catch (e) {}
    }
  }

  function applyStartSpeed(value, persist) {
    const ms = clampStartSpeed(value);
    startTurnSpeed = ms;
    setStartMsVar('--start-turn-ms', ms);
    setStartMsVar('--start-turn-leave-ms', Math.max(165, ms * 0.92));
    setStartMsVar('--start-turn-fade-ms', Math.max(110, ms * 0.6));
    setStartMsVar('--start-turn-out-fade-ms', Math.max(80, ms * 0.38));
    setStartMsVar('--start-rest-fade-ms', Math.max(240, ms * 1.36));
    setStartMsVar('--start-stage-fade-ms', Math.max(230, ms * 1.28));
    setStartMsVar('--start-orb-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-shape-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-clip-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-fade-ms', Math.max(70, ms * 0.32));
    if (startSpeedRange && startSpeedRange.value !== String(ms)) startSpeedRange.value = String(ms);
    if (startSpeedValue) startSpeedValue.textContent = ms + 'ms';
    if (startSpeedRange) startSpeedRange.setAttribute('aria-valuetext', ms + 'ms');
    if (persist) {
      try { localStorage.setItem(START_SPEED_KEY, String(ms)); } catch (e) {}
    }
  }

  function clampCareerScrollIdle(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return CAREER_SCROLL_IDLE_DEFAULT;
    const rounded = Math.round(n / 10) * 10;
    return Math.max(CAREER_SCROLL_IDLE_MIN, Math.min(CAREER_SCROLL_IDLE_MAX, rounded));
  }

  function clampCareerScrollFeel(key, value) {
    if (key === 'pauseReveal') return value !== false;
    const n = Number(value);
    if (key === 'idleMs') return clampCareerScrollIdle(n);
    const fallback = CAREER_SCROLL_FEEL_DEFAULTS[key];
    if (!Number.isFinite(n) || fallback == null) return fallback;
    if (key === 'strength') return Math.max(50, Math.min(200, Math.round(n / 5) * 5));
    if (key === 'inertia' || key === 'acceleration') return Math.max(0, Math.min(100, Math.round(n / 5) * 5));
    if (key === 'maxSpeed') return Math.max(600, Math.min(3600, Math.round(n / 100) * 100));
    return fallback;
  }

  function readCareerScrollFeel() {
    let raw = null;
    let idleMs = CAREER_SCROLL_IDLE_DEFAULT;
    try { raw = JSON.parse(localStorage.getItem(CAREER_SCROLL_FEEL_KEY) || 'null'); } catch (e) {}
    try { idleMs = clampCareerScrollIdle(localStorage.getItem(CAREER_SCROLL_IDLE_KEY) || CAREER_SCROLL_IDLE_DEFAULT); } catch (e) {}
    const next = Object.assign({}, CAREER_SCROLL_FEEL_DEFAULTS, raw || {});
    Object.keys(CAREER_SCROLL_FEEL_DEFAULTS).forEach((key) => { next[key] = clampCareerScrollFeel(key, next[key]); });
    next.idleMs = idleMs;
    return next;
  }

  function careerScrollFeelLabel(key, value) {
    if (key === 'idleMs') return value + 'ms';
    if (key === 'maxSpeed') return value + 'px/s';
    return value + '%';
  }

  function applyCareerScrollFeel(settings, persist) {
    const next = Object.assign({}, CAREER_SCROLL_FEEL_DEFAULTS, settings || {});
    Object.keys(CAREER_SCROLL_FEEL_DEFAULTS).forEach((key) => { next[key] = clampCareerScrollFeel(key, next[key]); });
    next.idleMs = clampCareerScrollIdle(settings && settings.idleMs);
    careerScrollFeelRanges.forEach((input) => {
      const key = input.dataset.setting;
      if (!key || next[key] == null) return;
      input.value = String(next[key]);
      input.setAttribute('aria-valuetext', careerScrollFeelLabel(key, next[key]));
    });
    careerScrollFeelValues.forEach((output) => {
      const key = output.dataset.setting;
      if (key && next[key] != null) output.textContent = careerScrollFeelLabel(key, next[key]);
    });
    if (careerScrollRevealToggle) careerScrollRevealToggle.checked = next.pauseReveal;
    if (persist) {
      try {
        const stored = {};
        Object.keys(CAREER_SCROLL_FEEL_DEFAULTS).forEach((key) => { stored[key] = next[key]; });
        localStorage.setItem(CAREER_SCROLL_FEEL_KEY, JSON.stringify(stored));
        localStorage.setItem(CAREER_SCROLL_IDLE_KEY, String(next.idleMs));
      } catch (e) {}
    }
    document.dispatchEvent(new CustomEvent('relatum:career-scroll-feel', { detail: next }));
    document.dispatchEvent(new CustomEvent('relatum:career-scroll-idle', { detail: { ms: next.idleMs } }));
    return next;
  }

  function normalizeImageTextScale(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(50, Math.min(300, Math.round(number / 5) * 5)) : 100;
  }
  function readImageTextScale() {
    try { return normalizeImageTextScale(localStorage.getItem(NOTE_IMAGE_TEXT_SCALE_KEY) ?? 100); }
    catch (error) { return 100; }
  }
  function applyImageTextScale(value, persist) {
    const scale = normalizeImageTextScale(value);
    document.documentElement.style.setProperty('--note-image-text-scale', String(scale / 100));
    const input = document.querySelector('[data-role="note-image-text-scale"]');
    const output = document.querySelector('[data-role="note-image-text-scale-value"]');
    if (input) input.value = String(scale);
    if (output) output.textContent = scale + '%';
    if (persist) {
      try { localStorage.setItem(NOTE_IMAGE_TEXT_SCALE_KEY, String(scale)); } catch (error) {}
    }
    window.dispatchEvent(new Event('relatum:image-text-scale'));
    return scale;
  }
  function readNoteFontScale() {
    let value = 100;
    try { value = Number(localStorage.getItem(NOTE_FONT_SCALE_KEY) || 100); } catch (e) {}
    return Math.max(80, Math.min(140, Math.round(value / 5) * 5 || 100));
  }

  function applyNoteFontScale(value, persist) {
    const scale = Math.max(80, Math.min(140, Math.round(Number(value) / 5) * 5 || 100));
    document.documentElement.style.setProperty('--note-font-scale', String(scale / 100));
    if (noteFontScaleRange) noteFontScaleRange.value = String(scale);
    if (noteFontScaleValue) noteFontScaleValue.textContent = scale + '%';
    if (persist) {
      try { localStorage.setItem(NOTE_FONT_SCALE_KEY, String(scale)); } catch (e) {}
    }
    return scale;
  }

  const preferences = {
    readImageTextScale, readFontScale: readNoteFontScale,
    applyFontScale(value, persist) { return applyNoteFontScale(value, persist !== false); },
    resetFontScale() { localStorage.removeItem(NOTE_FONT_SCALE_KEY); return applyNoteFontScale(100, false); },
    resetImageTextScale() { localStorage.removeItem(NOTE_IMAGE_TEXT_SCALE_KEY); return applyImageTextScale(100, false); },
  };
  window.RelatumNotePreferences = Object.freeze(preferences);
  applyNoteFontScale(readNoteFontScale(), false);
  applyImageTextScale(readImageTextScale(), false);
  if (noteFontScaleRange) noteFontScaleRange.addEventListener('input', () => applyNoteFontScale(noteFontScaleRange.value, true));
  const imageScale = query('note-image-text-scale');
  if (imageScale) imageScale.addEventListener('input', () => applyImageTextScale(imageScale.value, true));
  applyStartSpeed(read(START_SPEED_KEY, START_SPEED_DEFAULT), false);
  if (startSpeedRange) startSpeedRange.addEventListener('input', () => applyStartSpeed(startSpeedRange.value, true));
  applySpineSpeed(read(SPINE_SPEED_KEY, SPINE_SPEED_DEFAULT), false);
  if (spineSpeedRange) spineSpeedRange.addEventListener('input', () => applySpineSpeed(spineSpeedRange.value, true));
  applyCareerScrollFeel(readCareerScrollFeel(), false);
  careerScrollFeelRanges.forEach(input => input.addEventListener('input', () => {
    const next = readCareerScrollFeel(); next[input.dataset.setting] = input.value; applyCareerScrollFeel(next, true);
  }));
  if (careerScrollRevealToggle) careerScrollRevealToggle.addEventListener('change', () => {
    const next = readCareerScrollFeel(); next.pauseReveal = careerScrollRevealToggle.checked; applyCareerScrollFeel(next, true);
  });
  const careerReset = document.querySelector('[data-action="career-scroll-feel-reset"]');
  if (careerReset) careerReset.addEventListener('click', () => applyCareerScrollFeel(CAREER_SCROLL_FEEL_DEFAULTS, true));

  function theme(value, persist) {
    const next = value === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.startTheme = document.body.dataset.startTheme = next;
    const button = document.querySelector('[data-action="start-theme-toggle"]');
    if (button) button.setAttribute('aria-pressed', String(next === 'dark'));
    if (persist) localStorage.setItem('canvas:startTheme', next);
  }
  const themeButton = document.querySelector('[data-action="start-theme-toggle"]');
  if (themeButton) themeButton.addEventListener('click', () => theme(document.body.dataset.startTheme === 'dark' ? 'light' : 'dark', true));
  function background(value, persist) {
    const next = value === 'scenic' ? 'scenic' : 'simple';
    document.documentElement.dataset.startBackground = document.body.dataset.startBackground = next;
    document.querySelectorAll('[data-role="start-background-switch"] button').forEach(button => {
      const active = button.dataset.backgroundStyle === next;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    if (persist) localStorage.setItem('canvas:startBackgroundStyle', next);
  }
  background(read('canvas:startBackgroundStyle', 'simple'), false);
  document.querySelectorAll('[data-role="start-background-switch"] button').forEach(button => button.addEventListener('click', () => background(button.dataset.backgroundStyle, true)));
  const pop = query('start-speed-pop'), toggle = document.querySelector('[data-action="start-speed-toggle"]');
  if (toggle && pop) {
    toggle.addEventListener('click', event => { event.stopPropagation(); pop.hidden = !pop.hidden; toggle.setAttribute('aria-expanded', String(!pop.hidden)); });
    pop.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => { pop.hidden = true; toggle.setAttribute('aria-expanded', 'false'); });
  }
  const reset = document.querySelector('[data-action="start-panel-reset"]');
  if (reset) reset.addEventListener('click', () => {
    ['canvas:startTheme','canvas:startBackgroundStyle',START_SPEED_KEY,SPINE_SPEED_KEY,CAREER_SCROLL_FEEL_KEY,CAREER_SCROLL_IDLE_KEY].forEach(key => localStorage.removeItem(key));
    theme('light', false); background('simple', false); applyStartSpeed(260, false); applySpineSpeed(414, false); applyCareerScrollFeel(CAREER_SCROLL_FEEL_DEFAULTS, false);
  });
  const settings = query('desktop-settings');
  const settingsOpen = document.querySelector('[data-action="desktop-settings-open"]');
  const sizeForm = query('desktop-size-form');
  function syncSize(size) {
    if (!sizeForm || !size) return;
    const limits = size.limits || {};
    for (const axis of ['width','height']) {
      const input = sizeForm.elements[axis], label = axis === 'width' ? 'Width' : 'Height';
      input.value = size[axis];
      if (limits['min'+label]) input.min = limits['min'+label];
      if (limits['max'+label]) input.max = limits['max'+label];
    }
  }
  async function setSize(width, height) {
    if (window.CanvasDesktop) syncSize(await window.CanvasDesktop.setRestoredSize(Number(width), Number(height)));
  }
  if (settingsOpen) settingsOpen.addEventListener('click', async () => {
    settings.hidden = false;
    if (window.CanvasDesktop) syncSize(await window.CanvasDesktop.getRestoredSize());
  });
  document.querySelectorAll('[data-action="desktop-settings-close"]').forEach(button => button.addEventListener('click', () => { settings.hidden = true; }));
  if (sizeForm) sizeForm.addEventListener('submit', event => { event.preventDefault(); setSize(sizeForm.elements.width.value, sizeForm.elements.height.value); });
  document.querySelectorAll('[data-role="desktop-size-presets"] button').forEach(button => button.addEventListener('click', () => setSize(button.dataset.width, button.dataset.height)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (settings) settings.hidden = true; if (pop) pop.hidden = true; }
  });
  window.RelatumWorkspaceRuntime.create({
    turnSpeed: () => startTurnSpeed, onChange() {}, onCanvasReveal() {},
    notice(title, message) { window.alert(title + '\n' + message); },
  });
})();

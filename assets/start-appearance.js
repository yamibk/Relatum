(function () {
  'use strict';
  const key = 'canvas:startAppearance:v1';
  const choices = Object.freeze(['default', 'claude', 'sky', 'apple']);
  const root = document.documentElement;
  let stored;
  try { stored = localStorage.getItem(key); } catch (_) {}
  root.dataset.startAppearance = choices.includes(stored) ? stored : 'default';

  window.RelatumStartAppearance = Object.freeze({
    choices,
    read() { return root.dataset.startAppearance; },
    apply(value) {
      if (!choices.includes(value)) return false;
      try { localStorage.setItem(key, value); } catch (_) { return false; }
      root.dataset.startAppearance = value;
      return true;
    },
    reset() {
      try { localStorage.removeItem(key); } catch (_) { return false; }
      root.dataset.startAppearance = 'default';
      return true;
    },
  });
})();

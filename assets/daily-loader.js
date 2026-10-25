// Shell integration only. Hidden/unvisited Daily never loads its page runtimes.
(function () {
  'use strict';
  const loads = new Map();
  let toastTimer = 0;
  function toast(message) {
    const node = document.querySelector('[data-role="study-toast"], [data-role="toast"]');
    if (!node) return;
    clearTimeout(toastTimer); node.textContent = window.RelatumI18n?.t(String(message)) || String(message);
    node.classList.add('show'); toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
  }
  function script(src, ready) {
    if (ready()) return Promise.resolve(ready());
    if (loads.has(src)) return loads.get(src);
    const pending = new Promise((resolve, reject) => {
      const node = document.createElement('script'); node.src = src;
      node.onload = () => { if (ready()) resolve(ready()); else fail(); };
      const fail = () => { node.remove(); loads.delete(src); reject(new Error(src + ' 加载失败')); };
      node.onerror = fail; document.head.append(node);
    });
    loads.set(src, pending); return pending;
  }
  function focus() {
    if (!window.RelatumFeatureRuntime.enabled('daily.focus')) return Promise.reject(new Error('专注未启用'));
    return script('focus-service.js', () => window.RelatumFocusService);
  }
  async function load() {
    await script('daily-workspace.js', () => window.RelatumDailyWorkspace);
    return window.RelatumDailyWorkspace;
  }
  async function open(page, params) {
    if (!window.RelatumFeatureRuntime.visibleWorkspaces().includes('daily')) return false;
    if (!await window.RelatumStartWorkspace.set('daily')) return false;
    return (await load()).navigate(page, params);
  }
  const countdown = document.querySelector('[data-role="calendar-countdown-toggle"]');
  const countdownKey = 'daily:calendarCountdownEnabled';
  function applyCountdown(value, persist = false) {
    if (countdown) countdown.checked = value;
    if (persist) try { localStorage.setItem(countdownKey, value ? '1' : '0'); } catch (_) {}
    document.dispatchEvent(new CustomEvent('calendar:countdown-visibility', { detail: { enabled: value } }));
  }
  if (countdown) {
    let enabled = true; try { enabled = localStorage.getItem(countdownKey) !== '0'; } catch (_) {}
    applyCountdown(enabled);
    countdown.addEventListener('change', () => applyCountdown(countdown.checked, true));
  }
  window.RelatumDailyLoader = Object.freeze({ script, focus, load, open, applyCountdown, toast });
  // A saved running session is the only exception to the unvisited-workspace rule.
  try {
    const saved = JSON.parse(localStorage.getItem('daily:focusRuntime') || 'null');
    if (saved?.version === 1 && (saved.running || saved.pendingSession)
        && window.RelatumFeatureRuntime.enabled('daily.focus')) focus().catch(() => {});
  } catch (_) {}
})();

// Session capabilities are injected by the local server before the first paint.
(function () {
  'use strict';
  const profile = window.RelatumFeatures;
  const enabled = key => !profile || !profile.restricted || profile.features[key] === true;
  const workspaces = Object.freeze((profile?.workspaces || []).map(item => Object.freeze({ ...item, label: Object.freeze(item.label.slice()) })));
  const workspaceIds = workspaces.map(item => item.id);
  const workspaceEnabled = key => workspaceIds.includes(key) && (key === 'canvas' ? !profile || profile.canvasHome
    : enabled(key) && (!profile?.availableWorkspaces || profile.availableWorkspaces.includes(key)));
  const layoutKey = 'canvas:workspaceLayout:v1';
  function normalizeLayout(raw) {
    const valid = raw && Array.isArray(raw.order) && Array.isArray(raw.hidden);
    const order = valid ? [...new Set(raw.order.filter(id => workspaceIds.includes(id)))] : [];
    workspaceIds.forEach(id => { if (!order.includes(id)) order.push(id); });
    const hidden = order.filter(id => valid && raw.order.includes(id)
      ? raw.hidden.includes(id) : workspaces.find(item => item.id === id).defaultVisible !== true);
    return { order, hidden };
  }
  function readLayout() {
    try { return normalizeLayout(JSON.parse(localStorage.getItem(layoutKey))); } catch (_) { return normalizeLayout(null); }
  }
  const visibleWorkspaces = (layout = readLayout()) => layout.order.filter(id => workspaceEnabled(id) && !layout.hidden.includes(id));
  const workspace = (requested, layout = readLayout()) => {
    const visible = visibleWorkspaces(layout);
    return visible.includes(requested) ? requested : visible[0] || 'none';
  };
  const viewEnabled = name => !profile || !profile.restricted || (profile.views[name]
    ? enabled(profile.views[name]) : enabled('canvas.library'));
  window.RelatumFeatureRuntime = Object.freeze({ enabled, workspaceEnabled, workspace, workspaces, layoutKey, normalizeLayout, readLayout, visibleWorkspaces, viewEnabled, preloadEnabled: enabled('runtime.preload') });
  // This stylesheet is ready before the body, so hidden/reordered tabs never flash.
  const navigationStyle = document.createElement('style');
  function syncWorkspaceStyle(layout = readLayout()) {
    const visible = visibleWorkspaces(layout), count = visible.length;
    document.documentElement.style.setProperty('--start-workspace-count', String(Math.max(1, count)));
    document.documentElement.style.setProperty('--start-workspace-slider-width', count ? 'calc((100% - ' + (count + 5) + 'px) / ' + count + ')' : '0px');
    navigationStyle.textContent = workspaces.map(item => {
      const index = visible.indexOf(item.id), selector = '.start-workspace-switch button[data-start-workspace="' + item.id + '"]';
      return selector + '{order:' + Math.max(0, index) + (index < 0 ? ';display:none!important' : '') + '}'
        + 'html[data-start-workspace="' + item.id + '"] .start-workspace-slider{transform:translateX(calc(' + Math.max(0, index) * 100 + '% + ' + Math.max(0, index) + 'px))}'
        + 'html[data-start-workspace="' + item.id + '"] ' + selector + '{color:var(--workspace-active-ink,#fff)}';
    }).join('') + (count ? '' : '.start-workspace-switch{display:none!important}');
  }
  document.head.appendChild(navigationStyle); syncWorkspaceStyle();
  document.addEventListener('relatum:workspace-layout', event => syncWorkspaceStyle(event.detail));
  if (new URLSearchParams(location.search).get('startupTrace') === '1') {
    window.RelatumStartupMark = name => performance.mark('relatum:' + name);
    window.RelatumStartupMark('document-entry');
  }
  if (!profile || !profile.restricted) return;
  const selectors = [];
  if (!enabled('canvas.library')) selectors.push('.top-actions', '.canvas-library-head', '[data-role="file-list"]', '[data-role="page-dots"] > .page-dot', '[data-role="trash-entry"]', '[data-action="new"]', '[data-action="import-canvas-file"]', '[data-action="import-canvas-folder"]');
  if (!enabled('editor.ai')) selectors.push('[data-role="ai-toggle"]', '[data-role="ai-panel"]');
  if (!enabled('editor.graph')) selectors.push('[data-action="graph"]');
  if (!enabled('daily.calendar.wallpaper')) selectors.push('[data-countdown-wallpaper]');
  if (!workspaces.some(item => workspaceEnabled(item.id))) selectors.push('.editor-back');
  if (selectors.length) {
    const style = document.createElement('style');
    style.textContent = selectors.join(',') + '{display:none!important}';
    document.head.appendChild(style);
  }
  // Feature-specific settings do not initialize hidden page runtimes.
  document.addEventListener('DOMContentLoaded', () => {
    const groups = [
      ['notes', '[data-role="note-font-scale"], [data-role="note-image-text-scale"], [data-role="note-graph-spacing"]'],
      ['career', '[data-role^="career-scroll-"]'],
      ['canvas.quicknotes', '[data-role^="notes-"]'],
      ['daily.calendar', '[data-role="calendar-countdown-toggle"]'],
      ['canvas.library', '[data-role="library-search-toggle"]'],
    ];
    groups.forEach(([key, selector]) => {
      if (!enabled(key)) document.querySelectorAll(selector).forEach(el => {
        if ('disabled' in el) el.disabled = true;
      });
    });
  });
})();

// Session capabilities are injected by the local server before the first paint.
(function () {
  'use strict';
  const profile = window.RelatumFeatures;
  const enabled = key => !profile || !profile.restricted || profile.features[key] === true;
  const workspaceEnabled = key => key === 'canvas' ? !profile || profile.canvasHome : enabled(key);
  const workspace = requested => workspaceEnabled(requested) && ['canvas', 'notes', 'research', 'career'].includes(requested)
    ? requested : ['canvas', 'notes', 'research', 'career'].find(workspaceEnabled) || '';
  const viewEnabled = name => !profile || !profile.restricted || (profile.views[name]
    ? enabled(profile.views[name]) : enabled('canvas.library'));
  const workspaces = ['canvas', 'notes', 'research', 'career'].filter(workspaceEnabled);
  window.RelatumFeatureRuntime = Object.freeze({ enabled, workspaceEnabled, workspace, viewEnabled, preloadEnabled: enabled('runtime.preload') });
  if (new URLSearchParams(location.search).get('startupTrace') === '1') {
    window.RelatumStartupMark = name => performance.mark('relatum:' + name);
    window.RelatumStartupMark('document-entry');
  }
  if (!profile || !profile.restricted) return;
  if (workspaces.length) {
    document.documentElement.style.setProperty('--start-workspace-count', String(workspaces.length));
    document.documentElement.style.setProperty('--start-workspace-slider-width', 'calc((100% - ' + (workspaces.length + 5) + 'px) / ' + workspaces.length + ')');
    const navigationStyle = document.createElement('style');
    navigationStyle.textContent = workspaces.map((name, index) =>
      'html body[data-start-workspace="' + name + '"] .start-workspace-slider{transform:translateX(calc(' + index * 100 + '% + ' + index + 'px))}'
    ).join('');
    document.head.appendChild(navigationStyle);
  }
  const selectors = [];
  if (!enabled('canvas.library')) selectors.push('.top-actions', '.canvas-library-head', '[data-role="file-list"]', '[data-role="page-dots"]', '[data-role="trash-entry"]', '[data-action="new"]', '[data-action="import-canvas-file"]', '[data-action="import-canvas-folder"]');
  if (!enabled('editor.ai')) selectors.push('[data-role="ai-toggle"]', '[data-role="ai-panel"]');
  if (!enabled('editor.graph')) selectors.push('[data-action="graph"]');
  if (!enabled('calendar.wallpaper')) selectors.push('[data-countdown-wallpaper]');
  if (!profile.canvasHome && !enabled('notes') && !enabled('research') && !enabled('career')) selectors.push('.editor-back');
  if (selectors.length) {
    const style = document.createElement('style');
    style.textContent = selectors.join(',') + '{display:none!important}';
    document.head.appendChild(style);
  }
  // Feature-specific settings do not initialize hidden page runtimes.
  document.addEventListener('DOMContentLoaded', () => {
    const groups = [
      ['notes', '[data-role="note-font-scale"], [data-role="note-image-text-scale"]'],
      ['career', '[data-role^="career-scroll-"]'],
      ['canvas.quicknotes', '[data-role^="notes-"]'],
      ['canvas.calendar', '[data-role="calendar-countdown-toggle"]'],
      ['canvas.library', '[data-role="library-search-toggle"]'],
    ];
    groups.forEach(([key, selector]) => {
      if (!enabled(key)) document.querySelectorAll(selector).forEach(el => {
        if ('disabled' in el) el.disabled = true;
      });
    });
  });
})();

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const sourceId = String(params.get('id') || '').trim();
  const currentPath = String(params.get('current') || '').trim();
  const viewport = document.querySelector('[data-role="canvas-viewport"]');
  const guideLayer = document.querySelector('[data-role="canvas-guide-layer"]');
  const errorBox = document.querySelector('[data-role="dual-reference-error"]');
  const menu = document.querySelector('[data-role="node-menu"]');
  const copyToMain = menu && menu.querySelector('[data-action="copy-to-main"]');
  const language = localStorage.getItem('canvas:toolbarLanguage') === 'en' ? 'en' : 'zh-CN';
  let sourceInfo = null;
  let lastAppearance = null;

  document.documentElement.lang = language;
  document.documentElement.dataset.uiLanguage = language;
  document.body.dataset.uiLanguage = language;
  if (copyToMain) copyToMain.textContent = language === 'en' ? 'Copy to main canvas' : '复制到主画布';

  function post(message) {
    if (window.parent === window) return;
    window.parent.postMessage(message, window.location.origin);
  }

  function message(error) {
    return error && (error.displayMessage || error.message)
      ? (error.displayMessage || error.message)
      : (language === 'en' ? 'Could not open this canvas.' : '无法打开这张画布。');
  }

  function showError(error) {
    const text = message(error);
    if (errorBox) {
      errorBox.textContent = text;
      errorBox.hidden = false;
    }
    post({ type: 'relatum:dual:error', sourceId: sourceId, error: text });
  }

  function selectionPayload() {
    if (!window.CanvasModule || typeof window.CanvasModule.getDualSelectionPayload !== 'function') {
      return { ok: false, reason: 'not-ready' };
    }
    return window.CanvasModule.getDualSelectionPayload();
  }

  function copySelection(event) {
    if (!sourceInfo || !window.RelatumDualClipboard) return false;
    const payload = selectionPayload();
    if (!payload || !payload.ok) return false;
    const token = window.RelatumDualClipboard.createToken();
    const readable = window.RelatumDualClipboard.plainText(payload);
    if (event && event.clipboardData) {
      window.RelatumDualClipboard.write(event.clipboardData, token, readable);
      event.preventDefault();
    }
    post({
      type: 'relatum:dual:copy',
      token: token,
      sourceId: sourceInfo.id,
      revision: sourceInfo.revision,
      payload: payload,
    });
    return true;
  }

  function copySelectionToMain() {
    if (!sourceInfo) return;
    const payload = selectionPayload();
    if (!payload || !payload.ok) {
      if (window.CanvasModule && typeof window.CanvasModule.showToast === 'function') {
        window.CanvasModule.showToast(language === 'en' ? 'Select objects first.' : '请先选择对象');
      }
      return;
    }
    post({
      type: 'relatum:dual:paste-to-main',
      sourceId: sourceInfo.id,
      revision: sourceInfo.revision,
      payload: payload,
    });
    if (menu) menu.hidden = true;
  }

  function applyAppearance(detail) {
    if (!detail || typeof detail !== 'object') return;
    lastAppearance = detail;
    if (!viewport) return;
    const vars = detail.viewportVars || {};
    Object.keys(vars).forEach(function (name) {
      viewport.style.setProperty(name, String(vars[name] || ''));
    });
    const surfaceMode = ['plain', 'flowing', 'image', 'immersive'].includes(detail.surfaceMode)
      ? detail.surfaceMode
      : 'plain';
    document.body.classList.toggle('shared-dual-background', detail.sharedBackground === true);
    viewport.classList.toggle('flowing-background', surfaceMode === 'flowing');
    viewport.classList.toggle('image-background', surfaceMode === 'image');
    viewport.dataset.guideType = detail.guideType || 'none';
    if (guideLayer) guideLayer.hidden = viewport.dataset.guideType === 'none';
    document.body.dataset.backgroundTone = detail.tone === 'dark' ? 'dark' : 'light';
    document.body.dataset.surfaceMode = surfaceMode;
    document.body.style.setProperty(
      '--dual-reference-background-fill',
      surfaceMode === 'immersive'
        ? String(detail.baseFill || (detail.tone === 'dark' ? '#121815' : '#f1f0ed'))
        : String(vars['--canvas-background-fill'] || (detail.tone === 'dark' ? '#121815' : '#f1f0ed')),
    );
    const background = document.querySelector('[data-role="dual-reference-background"]');
    if (background) {
      const backgroundVars = detail.backgroundVars || {};
      Object.keys(backgroundVars).forEach(function (name) {
        background.style.setProperty(name, String(backgroundVars[name] || ''));
      });
    }
    document.dispatchEvent(new CustomEvent('canvas:guide-visual-refresh'));
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin || !event.data) return;
    if (event.data.type === 'relatum:dual:appearance') applyAppearance(event.data.appearance);
  });
  document.addEventListener('copy', copySelection);
  if (copyToMain) copyToMain.addEventListener('click', copySelectionToMain);

  if (!sourceId || !window.CanvasModule) {
    showError(new Error(language === 'en' ? 'Missing canvas source.' : '缺少参考画布来源。'));
    return;
  }

  fetch(
    '/api/canvas-dual-open?id=' + encodeURIComponent(sourceId)
      + '&current=' + encodeURIComponent(currentPath),
    { cache: 'no-store' },
  )
    .then(function (response) {
      return response.json().then(function (json) {
        if (!response.ok) throw new Error(json.error || response.statusText);
        return json;
      });
    })
    .then(function (json) {
      sourceInfo = {
        id: String(json.id || sourceId),
        title: String(json.title || ''),
        path: String(json.path || ''),
        revision: String(json.revision || ''),
      };
      const data = json.data && typeof json.data === 'object'
        ? json.data
        : { version: 2, nodes: [], edges: [] };
      if (!Array.isArray(data.nodes)) data.nodes = [];
      if (!Array.isArray(data.edges)) data.edges = [];
      const excludedNodeIds = new Set(data.nodes
        .filter(function (node) { return node && node.kind === 'task-root'; })
        .map(function (node) { return String(node.id || ''); }));
      data.nodes = data.nodes.filter(function (node) {
        return node && !excludedNodeIds.has(String(node.id || ''));
      });
      data.edges = data.edges.filter(function (edge) {
        return edge && !excludedNodeIds.has(String(edge.from || ''))
          && !excludedNodeIds.has(String(edge.to || ''));
      });
      delete data.taskbook;
      delete data.ruler;
      delete data.timers;
      window.CanvasModule.init({
        viewport: viewport,
        guideLayer: guideLayer,
        surface: document.querySelector('[data-role="canvas-surface"]'),
        emptyHint: document.querySelector('[data-role="empty-hint"]'),
        edgesLayer: document.querySelector('[data-role="canvas-edges"]'),
        edgesCanvas: document.querySelector('[data-role="canvas-edges-canvas"]'),
        inkLayer: document.querySelector('[data-role="canvas-ink"]'),
        zoomIndicator: document.querySelector('[data-role="zoom-indicator"]'),
        nodeMenu: menu,
        filePath: sourceInfo.path,
        embed: true,
        readonly: true,
        referenceOnly: true,
        data: data,
        initialViewport: null,
        onViewportChange: function () {},
        onChange: function () {},
      });
      if (lastAppearance) applyAppearance(lastAppearance);
      post({
        type: 'relatum:dual:ready',
        sourceId: sourceInfo.id,
        title: sourceInfo.title,
        revision: sourceInfo.revision,
      });
    })
    .catch(showError);
})();

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumDualClipboard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MIME = 'application/x-relatum-canvas-selection';
  const HTML_ATTRIBUTE = 'data-relatum-selection-token';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createToken() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'dual-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function plainText(payload) {
    const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
    const parts = nodes.map(function (node) {
      const title = String(node && node.text || '').trim();
      const body = String(node && node.body || '').trim();
      if (title && body && body !== title) return title + '\n' + body;
      return title || body || '';
    }).filter(Boolean);
    return parts.join('\n\n---\n\n') || '[Relatum canvas selection]';
  }

  function write(dataTransfer, token, text) {
    if (!dataTransfer || !token) return false;
    const readable = String(text || '[Relatum canvas selection]');
    let wrote = false;
    try {
      dataTransfer.setData(MIME, token);
      wrote = true;
    } catch (_) {}
    try {
      dataTransfer.setData('text/plain', readable);
      wrote = true;
    } catch (_) {}
    try {
      dataTransfer.setData(
        'text/html',
        '<div ' + HTML_ATTRIBUTE + '="' + escapeHtml(token) + '"><pre>'
          + escapeHtml(readable) + '</pre></div>',
      );
      wrote = true;
    } catch (_) {}
    return wrote;
  }

  function readToken(dataTransfer) {
    if (!dataTransfer) return '';
    try {
      const direct = String(dataTransfer.getData(MIME) || '').trim();
      if (direct) return direct;
    } catch (_) {}
    try {
      const html = String(dataTransfer.getData('text/html') || '');
      const match = new RegExp(HTML_ATTRIBUTE + '=["\\\']([^"\\\']+)["\\\']', 'i').exec(html);
      return match ? match[1] : '';
    } catch (_) {
      return '';
    }
  }

  return {
    MIME: MIME,
    HTML_ATTRIBUTE: HTML_ATTRIBUTE,
    createToken: createToken,
    plainText: plainText,
    write: write,
    readToken: readToken,
  };
});

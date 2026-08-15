// 大体积展示字体按需注册，避免仅解析全局 CSS 就下载 12MB KoseFont。
(function () {
  'use strict';

  let koseFontPromise = null;

  function ensureKoseFont() {
    if (koseFontPromise) return koseFontPromise;
    koseFontPromise = new Promise((resolve) => {
      if (!document.getElementById('relatum-kose-font-face')) {
        const style = document.createElement('style');
        style.id = 'relatum-kose-font-face';
        style.textContent = '@font-face{font-family:"KoseFont";src:url("fonts/kose-font.woff2") format("woff2");font-weight:normal;font-style:normal;font-display:swap;}';
        document.head.appendChild(style);
      }
      if (!document.fonts || typeof document.fonts.load !== 'function') {
        resolve();
        return;
      }
      document.fonts.load('16px "KoseFont"').then(resolve, resolve);
    });
    return koseFontPromise;
  }

  function canvasNeedsKoseFont(data) {
    const nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
    return nodes.some((node) => node && (
      node.handText === true
      || node.kind === 'textBox'
      || (node.kind === 'box' && Array.isArray(node.groupMemberIds) && node.groupMemberIds.length > 0)
    ));
  }

  window.RelatumFontLoader = {
    ensureKose: ensureKoseFont,
    prepareCanvas: function (data) {
      return canvasNeedsKoseFont(data) ? ensureKoseFont() : Promise.resolve();
    },
  };
})();

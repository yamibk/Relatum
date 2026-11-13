// This page is used by a same-origin iframe and by the desktop print WebView.
(function () {
  'use strict';
  const host = document.querySelector('main');
  const editor = window.RelatumNoteLiveEditor;

  async function loadImages(content) {
    const results = await Promise.all(Array.from(content.querySelectorAll('img[data-note-image]'), async image => {
      const frame = image.closest('.md-local-image');
      if (image.dataset.notePrintReference) return 0;
      try {
        await image.decode();
        if (/\.svg$/i.test(image.dataset.noteImage)) {
          frame.classList.add('has-svg-auto-size');
          frame.style.setProperty('--note-svg-natural-width', image.naturalWidth + 'px');
          frame.style.setProperty('--note-svg-ratio', image.naturalWidth / image.naturalHeight);
        }
        return 0;
      } catch (_) {
        frame.classList.add('is-failed');
        const fallback = frame.querySelector('.md-local-image-fallback');
        fallback.textContent = image.alt + ' · ' + (document.documentElement.lang === 'en' ? 'Image unavailable' : '图片无法加载');
        image.removeAttribute('src');
        return 1;
      }
    }));
    return results.reduce((count, warning) => count + warning, 0);
  }

  function fitImages(content) {
    const maxHeight = 252 / 25.4 * 96;
    content.querySelectorAll('.md-local-image.has-explicit-size:not(.is-failed)').forEach(frame => {
      const image = frame.querySelector('img');
      const ratio = frame.classList.contains('has-explicit-box') ? getComputedStyle(frame).aspectRatio.split('/').map(Number) : [image.naturalWidth, image.naturalHeight];
      const maxWidth = maxHeight * ratio[0] / ratio[1];
      if (maxWidth > 0) frame.style.maxWidth = 'min(100%, ' + maxWidth + 'px)';
    });
  }

  async function renderMath(content) {
    window.MathJax = {
      tex: {
        inlineMath: [['$', '$'], ['\\(', '\\)']],
        displayMath: [['$$', '$$'], ['\\[', '\\]']],
        processEscapes: true,
        packages: { '[-]': ['noundefined'] },
      },
      startup: { typeset: false },
    };
    let failed = false;
    try { failed = !await editor.typesetMath(content, () => content.isConnected); } catch (_) { failed = true; }
    const items = window.MathJax?.startup?.document?.getMathItemsWithin?.([content]) || [];
    let warnings = 0;
    for (const item of items) {
      const output = item.typesetRoot;
      if (!output?.isConnected || !output.querySelector('mjx-merror')) continue;
      const source = document.createElement(item.display ? 'pre' : 'code');
      source.textContent = item.math;
      output.replaceWith(source);
      warnings++;
    }
    return warnings + Number(failed);
  }

  async function renderDiagrams(content) {
    try {
      const runtime = await editor.loadNoteMermaid();
      const diagrams = runtime.attach(content, { mode: 'print' });
      try { return await diagrams.ready; } finally { diagrams.destroy(); }
    } catch (_) { return content.querySelectorAll('.mermaid-diagram:not(.is-rendered)').length; }
  }

  window.RelatumNotePrint = {
    async render({ path, value, language, mermaid }) {
      document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
      document.title = path.split('/').pop().replace(/\.md$/i, '') + '.pdf';
      window.RelatumFeatureRuntime = { enabled: key => key === 'notes.mermaid' && mermaid === true };
      const result = editor.renderMarkdown(host, value, path, { print: true });
      if (result.error) throw new Error('Markdown rendering failed');
      const content = result.content;
      content.querySelectorAll('pre.md-code').forEach(block => {
        if (!block.textContent.trim()) block.remove();
      });
      // Preload the actual glyphs at the final body width before measuring SVGs.
      content.getBoundingClientRect();
      await document.fonts.ready;
      const [images, math, diagrams] = await Promise.all([
        loadImages(content),
        result.features.math || content.querySelector('[data-note-cards-math="1"]') ? renderMath(content) : 0,
        result.features.mermaid ? renderDiagrams(content) : 0,
      ]);
      fitImages(content);
      content.getBoundingClientRect();
      await document.fonts.ready;
      result.measureImages();
      return { warnings: images + math + diagrams };
    },
  };
})();

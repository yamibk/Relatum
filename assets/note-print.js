// This page is used by a same-origin iframe and by the desktop print WebView.
(function () {
  'use strict';
  const host = document.querySelector('main');
  const editor = window.RelatumNoteLiveEditor;
  const IMAGE_TIMEOUT = 30000;
  const IMAGE_CONCURRENCY = 4;

  async function loadImages(content) {
    const images = Array.from(content.querySelectorAll('img[data-note-print-src]'));
    if (!images.length) return 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT);
    const { signal } = controller;
    let next = 0, warnings = 0;
    async function loadBatch() {
      while (!signal.aborted && next < images.length) {
        const image = images[next++];
        const loaded = await new Promise(resolve => {
          const done = () => {
            image.removeEventListener('load', done);
            image.removeEventListener('error', done);
            signal.removeEventListener('abort', done);
            resolve(!signal.aborted && image.naturalWidth > 0);
          };
          image.addEventListener('load', done);
          image.addEventListener('error', done);
          signal.addEventListener('abort', done);
          image.src = image.dataset.notePrintSrc;
          if (image.complete) done();
        });
        if (signal.aborted) { image.removeAttribute('src'); break; }
        const frame = image.closest('.md-local-image');
        if (!loaded) {
          frame.classList.add('is-failed');
          const fallback = frame.querySelector('.md-local-image-fallback');
          fallback.textContent = image.alt + ' · ' + (document.documentElement.lang === 'en' ? 'Image unavailable' : '图片无法加载');
          image.removeAttribute('src');
          warnings++;
        } else if (/\.svg$/i.test(image.dataset.noteImage)) {
          frame.classList.add('has-svg-auto-size');
          frame.style.setProperty('--note-svg-natural-width', image.naturalWidth + 'px');
          frame.style.setProperty('--note-svg-ratio', image.naturalWidth / image.naturalHeight);
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, images.length) }, loadBatch));
      if (signal.aborted) throw new Error('image-timeout');
      return warnings;
    } finally { clearTimeout(timer); }
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

  async function renderDatabases(content, path, language) {
    const groups = new Map();
    for (const element of content.querySelectorAll('.note-database-carrier')) {
      const id = element.dataset.databaseId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(element);
    }
    if (!groups.size) return 0;
    try {
      if (!window.RelatumNoteDatabase) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          const timer = setTimeout(() => { script.remove(); reject(new Error('Database script timed out')); }, 15000);
          script.src = new URL('note-database.js', document.baseURI).href;
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Database script failed')); };
          document.head.append(script);
        });
      }
    } catch (_) {
      for (const elements of groups.values()) for (const element of elements)
        element.textContent = language === 'en' ? 'Database unavailable' : '数据库无法读取';
      return groups.size;
    }
    const jobs = Array.from(groups);
    let warnings = 0;
    for (let i = 0; i < jobs.length; i += 4) {
      const results = await Promise.all(jobs.slice(i, i + 4).map(async ([id, [first, ...duplicates]]) => {
        const result = await window.RelatumNoteDatabase.renderPrint(first, path, id, language, duplicates);
        // Charts draw each copy with its own SVG identifiers. Tables and messages share the first projection.
        for (const element of duplicates) {
          if (!element.hasChildNodes()) element.replaceChildren(...Array.from(first.childNodes, node => node.cloneNode(true)));
        }
        return result;
      }));
      warnings += results.reduce((total, result) => total + result, 0);
    }
    return warnings;
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
      const hasMath = result.features.math || content.querySelector('[data-note-cards-math="1"], .md-derive-eq:not(:empty)');
      const [images, math, diagrams, databases] = await Promise.all([
        loadImages(content),
        hasMath ? renderMath(content) : 0,
        result.features.mermaid ? renderDiagrams(content) : 0,
        renderDatabases(content, path, language),
      ]);
      fitImages(content);
      content.getBoundingClientRect();
      await document.fonts.ready;
      result.measureImages();
      return { warnings: images + math + diagrams + databases };
    },
  };
})();

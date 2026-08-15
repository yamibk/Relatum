// 编辑器非首屏运行时：先让画布和可见内容就绪，再在空闲期或首次交互时补齐功能。
(function () {
  'use strict';

  const scriptJobs = new Map();
  const styleJobs = new Map();

  function loadScript(src) {
    if (scriptJobs.has(src)) return scriptJobs.get(src);
    const job = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('无法加载 ' + src)), { once: true });
      document.head.appendChild(script);
    });
    scriptJobs.set(src, job);
    return job;
  }

  function loadScriptsInOrder(sources) {
    return sources.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());
  }

  function loadStyle(href) {
    if (styleJobs.has(href)) return styleJobs.get(href);
    const job = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => reject(new Error('无法加载 ' + href)), { once: true });
      document.head.appendChild(link);
    });
    styleJobs.set(href, job);
    return job;
  }

  function scheduleIdle(task, timeout) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(task, { timeout: timeout });
    } else {
      window.setTimeout(task, Math.min(timeout, 900));
    }
  }

  let aiRuntimePromise = null;
  function ensureAIRuntime() {
    if (!aiRuntimePromise) {
      aiRuntimePromise = loadScript('ai.js').then(() => {
        window.RelatumAIReady = true;
      });
    }
    return aiRuntimePromise;
  }

  const aiToggle = document.querySelector('[data-role="ai-toggle"]');
  if (aiToggle) {
    let aiOpening = false;
    const openAIWhenReady = (event) => {
      if (window.RelatumAIReady) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (aiOpening) return;
      aiOpening = true;
      aiToggle.setAttribute('aria-busy', 'true');
      ensureAIRuntime().then(() => {
        aiToggle.removeEventListener('click', openAIWhenReady, true);
        aiToggle.removeAttribute('aria-busy');
        window.RelatumAIReady = true;
        aiToggle.click();
      }).catch((error) => {
        aiOpening = false;
        aiToggle.removeAttribute('aria-busy');
        console.warn('[编辑器] AI 运行时加载失败', error);
      });
    };
    aiToggle.addEventListener('click', openAIWhenReady, true);
  }

  let graphRuntimePromise = null;
  function ensureGraphRuntime() {
    if (!graphRuntimePromise) {
      graphRuntimePromise = loadScriptsInOrder(['graph-gl.js', 'graph-engine.js', 'graph-view.js'])
        .then(() => document.dispatchEvent(new CustomEvent('editor:graph-runtime-ready')));
    }
    return graphRuntimePromise;
  }

  const graphToggle = document.querySelector('[data-action="graph"]');
  if (graphToggle) {
    graphToggle.disabled = false;
    let graphOpening = false;
    const openGraphWhenReady = (event) => {
      if (window.GraphView) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (graphOpening) return;
      graphOpening = true;
      graphToggle.setAttribute('aria-busy', 'true');
      ensureGraphRuntime().then(() => {
        graphToggle.removeEventListener('click', openGraphWhenReady, true);
        graphToggle.removeAttribute('aria-busy');
        const open = () => graphToggle.click();
        if (document.body.classList.contains('canvas-ready')) open();
        else document.addEventListener('editor:canvasready', open, { once: true });
      }).catch((error) => {
        graphOpening = false;
        graphToggle.removeAttribute('aria-busy');
        console.warn('[编辑器] 图谱运行时加载失败', error);
      });
    };
    graphToggle.addEventListener('click', openGraphWhenReady, true);
  }

  document.addEventListener('editor:ready', () => {
    // 新手引导与说明框只影响首屏之后的辅助交互；样式和脚本一起延后，避免占用画布揭幕前的解析时间。
    loadStyle('editor-onboarding.css').then(() => loadScript('editor-onboarding.js'))
      .catch((error) => console.warn('[编辑器] 新手引导加载失败', error));
    scheduleIdle(() => {
      // 首次交互仍可抢先触发同一 Promise；若用户暂未操作，则在揭幕后空闲补齐，
      // 避免第一次展开 AI 或图谱时才开始下载运行时。
      ensureAIRuntime().catch((error) => console.warn('[编辑器] AI 运行时预热失败', error));
      ensureGraphRuntime().catch((error) => console.warn('[编辑器] 图谱运行时预热失败', error));
    }, 3200);
    scheduleIdle(() => {
      loadScript('tooltip.js').catch((error) => console.warn('[编辑器] 说明框加载失败', error));
      // 空画布不再让 12MB 手写字体阻塞首屏；空闲后补齐，使首次使用文字工具时通常已就绪。
      if (window.RelatumFontLoader && typeof window.RelatumFontLoader.ensureKose === 'function') {
        window.RelatumFontLoader.ensureKose();
      }
    }, 2400);
  }, { once: true });
})();

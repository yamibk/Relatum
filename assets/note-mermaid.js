// Notes-only, offline Pele adapter. Markdown remains the sole source of truth.
(function () {
  'use strict';
  const ownUrl = document.currentScript?.src || new URL('note-mermaid.js', document.baseURI).href;
  const enabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid');
  const english = () => window.RelatumI18n?.language === 'en' || document.documentElement.lang === 'en';
  const text = (zh, en) => english() ? en : zh;
  const jobs = new Set();
  let resourcePromise = null, timer = 0, nextId = 0;

  function loadAsset(name, style) {
    return new Promise((resolve, reject) => {
      const el = document.createElement(style ? 'link' : 'script');
      let timeout;
      const finish = error => {
        clearTimeout(timeout); el.onload = el.onerror = null;
        if (error) { el.remove(); reject(error); } else resolve();
      };
      if (style) { el.rel = 'stylesheet'; el.href = new URL(name, ownUrl).href; }
      else { el.src = new URL(name, ownUrl).href; el.async = true; }
      el.dataset.noteMermaidAsset = name;
      el.onload = () => finish();
      el.onerror = () => finish(new Error(text('离线图表资源加载失败', 'Could not load offline diagram resources')));
      timeout = setTimeout(() => finish(new Error(text('离线图表资源加载超时，请重试', 'Offline diagram resources timed out. Please retry.'))), 10000);
      document.head.append(el);
    });
  }

  let styled = false;
  function resources() {
    if (!enabled()) return Promise.reject(new Error('Mermaid disabled'));
    if (!resourcePromise) resourcePromise = Promise.all([
      styled ? null : loadAsset('note-mermaid.css', true).then(() => { styled = true; }),
      window.pele ? null : loadAsset('vendor/pele/pele.global.js', false),
    ]).then(() => {
      if (!window.pele?.parse || !window.pele?.render || !window.pele?.enableZoom) throw new Error('Pele did not initialize');
      return window.pele;
    }).catch(error => { resourcePromise = null; throw error; });
    return resourcePromise;
  }

  function normalize(source, language) {
    const value = String(source || '').replace(/\r\n?/g, '\n').trim();
    const headers = { flowchart: 'flowchart TD', flow: 'flowchart TD', graph: 'graph TD',
      sequence: 'sequenceDiagram', sequencediagram: 'sequenceDiagram', timeline: 'timeline', gantt: 'gantt',
      class: 'classDiagram', classdiagram: 'classDiagram', state: 'stateDiagram-v2', statediagram: 'stateDiagram-v2',
      er: 'erDiagram', erdiagram: 'erDiagram', mindmap: 'mindmap' };
    const header = headers[String(language || '').toLowerCase()];
    const body = value.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').replace(/^(?:\s*%%[^\n]*(?:\n|$))*/, '').trimStart();
    return !header || /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|timeline|gantt|mindmap)\b/i.test(body)
      ? value : header + '\n' + value;
  }

  function safeSvg(markup) {
    if (markup.length > 4000000 || /<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error('Invalid diagram output');
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror')) throw new Error('Invalid diagram SVG');
    svg.querySelectorAll('script,foreignObject,iframe,object,embed,image,audio,video,animate,animateTransform,animateMotion,set,feImage').forEach(el => el.remove());
    const unsafeCss = value => /@import|@keyframes|expression\s*\(|(?:javascript|vbscript|data)\s*:|url\s*\(\s*(?!["']?#[\w-]+["']?\s*\))/i.test(value);
    [svg, ...svg.querySelectorAll('*')].forEach(el => {
      if (el.localName === 'style' && unsafeCss(el.textContent)) { el.remove(); return; }
      Array.from(el.attributes).forEach(attr => {
        const name = attr.name.toLowerCase(), value = attr.value.trim();
        if (/^on/.test(name) || /^(?:src|srcset|formaction)$/.test(name)
            || /^(?:href|xlink:href)$/.test(name) && value && !/^#[\w-]+$/.test(value)
            || unsafeCss(value)) el.removeAttribute(attr.name);
      });
    });
    svg.setAttribute('role', 'img'); svg.setAttribute('focusable', 'false');
    return document.importNode(svg, true);
  }

  function schedule(entry) {
    if (entry.error || entry.waiting || !entry.owner.current(entry)) return;
    const ticket = {};
    entry.waiting = ticket;
    const generation = entry.owner.generation;
    Promise.resolve().then(() => entry.owner.options.whenSettled?.()).then(() => {
      if (generation !== entry.owner.generation || !entry.owner.current(entry)) return;
      return resources().then(() => {
        if (generation !== entry.owner.generation || !entry.owner.current(entry)) return;
        jobs.add(entry);
        if (!timer) timer = setTimeout(flush, 0);
      });
    }).catch(error => {
      if (generation === entry.owner.generation && entry.owner.current(entry)) entry.owner.fail(entry, error, true);
    }).finally(() => { if (entry.waiting === ticket) entry.waiting = false; });
  }

  function flush() {
    timer = 0;
    const until = performance.now() + 4;
    for (const entry of jobs) {
      jobs.delete(entry);
      if (entry.owner.current(entry)) {
        try { entry.owner.draw(entry); } catch (error) { entry.owner.fail(entry, error, false); }
      }
      if (performance.now() >= until) break;
    }
    if (jobs.size) timer = setTimeout(flush, 0);
  }

  function attach(root, options = {}) {
    root.__noteMermaid?.destroy();
    let disposed = false, paused = false, pageActive = true, watching = false;
    let intersection = null, resize = null, mutation = null;
    const byElement = new Map();
    const elements = [...(root.matches('.mermaid-diagram') ? [root] : []), ...root.querySelectorAll('.mermaid-diagram')];
    const owner = { options, generation: 0, current, draw, fail };
    const entries = elements.map(el => {
      const carrier = el.querySelector('.mermaid-source');
      const source = normalize(carrier?.content?.textContent || carrier?.textContent || '', el.dataset.mermaidLang);
      el.classList.add('note-mermaid');
      const entry = { owner, el, source, model: null, key: '', visible: false, waiting: false, error: false,
        prefix: 'relatum-note-pele-' + (++nextId), zoom: null };
      byElement.set(el, entry); return entry;
    });

    function foreground() {
      return enabled() && !disposed && !paused && pageActive && !document.hidden
        && document.documentElement.dataset.desktopMinimized !== '1' && root.isConnected && !root.closest('[hidden]')
        && (!root.closest('.note-workspace') || document.body.dataset.startWorkspace === 'notes')
        && (!options.isCurrent || options.isCurrent());
    }
    function current(entry) { return foreground() && entry.visible && entry.el.isConnected; }
    function layout() { if (foreground()) options.onLayout?.(); }
    function stop() {
      owner.generation++;
      intersection?.disconnect(); resize?.disconnect(); intersection = resize = null;
      entries.forEach(entry => { jobs.delete(entry); entry.waiting = false; entry.visible = false; entry.zoom?.destroy(); entry.zoom = null; });
      if (!jobs.size && timer) { clearTimeout(timer); timer = 0; }
      watching = false;
    }
    function sync() {
      if (!foreground()) { if (watching) stop(); return; }
      if (!watching) {
        watching = true;
        if (typeof IntersectionObserver === 'function') intersection = new IntersectionObserver(records => {
          records.forEach(record => {
            const entry = byElement.get(record.target); if (!entry) return;
            entry.visible = record.isIntersecting;
            if (entry.visible) schedule(entry);
            else { jobs.delete(entry); entry.zoom?.destroy(); entry.zoom = null; }
          });
        });
        if (typeof ResizeObserver === 'function') resize = new ResizeObserver(records => {
          records.forEach(record => { const entry = byElement.get(record.target); if (entry) schedule(entry); });
        });
        entries.forEach(entry => {
          if (intersection) intersection.observe(entry.el);
          else { const box = entry.el.getBoundingClientRect(); entry.visible = box.bottom > 0 && box.top < innerHeight; }
          resize?.observe(entry.el); schedule(entry);
        });
      } else entries.forEach(schedule);
    }
    function controls(entry) {
      const stage = entry.el.querySelector('.note-mermaid-stage'), svg = stage?.querySelector(':scope > svg');
      if (options.mode !== 'reading' || entry.zoom || !svg) return;
      // Very wide, short diagrams can be only a few pixels tall when fitted.
      // Reserve a usable viewport before Pele measures it or installs its bar.
      stage.classList.toggle('has-note-mermaid-zoom', parseFloat(svg.getAttribute('width')) > stage.clientWidth + 1);
      entry.zoom = window.pele.enableZoom(stage, { labels: {
        zoomIn: text('放大图表', 'Zoom in'), zoomOut: text('缩小图表', 'Zoom out'), reset: text('复位图表', 'Reset zoom'),
      } });
    }
    function draw(entry) {
      const style = getComputedStyle(entry.el), width = entry.el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (!(width > 0)) return;
      const font = style.fontFamily, size = parseFloat(style.fontSize) || 16;
      const key = [Math.round(width * 100) / 100, font, size, style.getPropertyValue('--note-font-mono')].join('|');
      if (entry.key === key && entry.el.querySelector('.note-mermaid-stage > svg')) { controls(entry); return; }
      if (entry.source.length > 65536) throw new Error(text('图表源码超过 64 KiB 限制', 'Diagram source exceeds the 64 KiB limit'));
      entry.model ||= window.pele.parse(entry.source, { limit: 65536, maxEdges: 5000 });
      const result = window.pele.render(entry.model, { limit: 65536, maxEdges: 5000, outputLimit: 4000000,
        fontFamily: font, fontFamilyMono: style.getPropertyValue('--note-font-mono').trim() || 'monospace', fontSize: size,
        maxWidth: width, autoDirection: false, responsive: true, links: false, images: false, idPrefix: entry.prefix });
      const svg = safeSvg(result.svg);
      entry.zoom?.destroy(); entry.zoom = null;
      const stage = document.createElement('div'); stage.className = 'note-mermaid-stage'; stage.append(svg);
      entry.el.querySelectorAll(':scope > :not(template)').forEach(el => el.remove());
      entry.el.append(stage); entry.el.classList.add('is-rendered'); entry.el.classList.remove('is-error');
      entry.el.dataset.noteMermaidRendered = '1'; entry.key = key;
      controls(entry); layout();
    }
    function fail(entry, error, retryable) {
      entry.error = true; entry.zoom?.destroy(); entry.zoom = null;
      entry.el.classList.remove('is-rendered'); entry.el.classList.add('is-error');
      delete entry.el.dataset.noteMermaidRendered;
      const box = document.createElement('div'); box.className = 'note-mermaid-error';
      const message = document.createElement('p');
      message.textContent = text('图表暂未显示：', 'Diagram unavailable: ') + String(error?.message || error);
      const pre = document.createElement('pre'); pre.textContent = entry.source;
      box.append(message);
      if (retryable) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.noteMermaidControl = 'retry';
        button.textContent = text('重试', 'Retry');
        button.addEventListener('mousedown', event => event.stopPropagation());
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); entry.error = false; box.remove(); schedule(entry); });
        box.append(button);
      }
      box.append(pre); entry.el.querySelectorAll(':scope > :not(template)').forEach(el => el.remove()); entry.el.append(box); layout();
    }
    const pagehide = () => { pageActive = false; stop(); };
    const pageshow = () => { pageActive = true; sync(); };
    const fonts = () => { window.pele?.forgetTextWidths(); entries.forEach(entry => { entry.key = ''; }); sync(); };
    const language = () => { entries.forEach(entry => { entry.zoom?.destroy(); entry.zoom = null; }); fonts(); };
    const inputSettled = () => Promise.resolve(options.whenSettled?.()).then(sync);
    const events = [[document, 'visibilitychange', sync], [window, 'canvasdesktop:visibility', sync],
      [document, 'relatum:start-workspacechange', sync], [window, 'pagehide', pagehide], [window, 'pageshow', pageshow],
      [document, 'relatum:languagechange', language], [document, 'compositionend', inputSettled]];
    events.forEach(([target, name, handler]) => target.addEventListener(name, handler));
    document.fonts?.addEventListener('loadingdone', fonts);
    mutation = new MutationObserver(sync);
    // Attribute-only observation of this host's ancestors, never a body subtree observer.
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      mutation.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'data-start-workspace'] });
    }
    const controller = { suspend() { paused = true; stop(); }, resume() { paused = false; sync(); }, destroy() {
      if (disposed) return;
      disposed = true; stop(); mutation.disconnect();
      events.forEach(([target, name, handler]) => target.removeEventListener(name, handler));
      document.fonts?.removeEventListener('loadingdone', fonts);
      entries.forEach(entry => { entry.model = null; }); byElement.clear();
      if (root.__noteMermaid === controller) delete root.__noteMermaid;
    } };
    root.__noteMermaid = controller; sync();
    return controller;
  }
  window.RelatumNoteMermaid = Object.freeze({ attach });
})();

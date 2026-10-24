// Notes-only, offline Pele adapter. Markdown remains the sole source of truth.
(function () {
  'use strict';
  const ownUrl = document.currentScript?.src || new URL('note-mermaid.js', document.baseURI).href;
  const enabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid');
  const english = () => window.RelatumI18n?.language === 'en' || document.documentElement.lang === 'en';
  const text = (zh, en) => english() ? en : zh;
  const abort = () => new DOMException('Diagram task cancelled', 'AbortError');
  const yields = [], channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  if (channel) channel.port1.onmessage = () => yields.shift()?.();
  function yieldTask(signal) {
    if (signal?.aborted) return Promise.reject(abort());
    const task = window.scheduler?.yield ? window.scheduler.yield() : new Promise(resolve => {
      if (channel) { yields.push(resolve); channel.port2.postMessage(0); } else setTimeout(resolve, 0);
    });
    if (!signal) return task;
    return new Promise((resolve, reject) => {
      const cancel = () => { signal.removeEventListener('abort', cancel); reject(abort()); };
      signal.addEventListener('abort', cancel, { once: true });
      task.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
    });
  }
  const MAX_ITEMS = 32, MAX_BYTES = 8 * 1024 * 1024;
  const cache = new Map(), owners = new Set(), queue = new Map(), fontLoads = new Map(), fontEpochs = new Map(), preparedFaces = new WeakSet();
  const heightHints = new Map(), lastGood = new Map();
  let heightBytes = 0, cacheBytes = 0, fontRevision = 0, nextId = 0, running = false;
  let stylePromise = null, fallbackPromise = null, workerState = null, workerDisabled = false;
  let cacheEpoch = 0;
  const cacheBudget = () => window.RelatumNoteSystem?.budget('mermaid') || { items: MAX_ITEMS, bytes: MAX_BYTES };
  function trimCache(clear = false) {
    const budget = cacheBudget(), protectedKeys = new Set();
    owners.forEach(owner => owner.cacheKeys().forEach(key => protectedKeys.add(key)));
    for (const [key, entry] of cache) {
      if (!clear && cache.size <= budget.items && cacheBytes <= budget.bytes) break;
      if (protectedKeys.has(key)) continue;
      cacheBytes -= entry.bytes; cache.delete(key);
      for (const [identity, prior] of lastGood) if (prior === key) lastGood.delete(identity);
    }
  }
  function configureWorker(clear = false) {
    if (workerState && !workerState.stopped) workerState.worker.postMessage({ kind: 'cache', ...cacheBudget(), epoch: cacheEpoch, clear });
  }
  window.addEventListener('relatum:note-system', event => {
    if (!event.detail.clear && event.detail.previous.cache === event.detail.value.cache) return;
    if (event.detail.clear) cacheEpoch++;
    trimCache(event.detail.clear); configureWorker(event.detail.clear);
  });

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
  function styles() {
    return stylePromise ||= loadAsset('note-mermaid.css', true).catch(error => { stylePromise = null; throw error; });
  }
  function fallback() {
    return fallbackPromise ||= (window.pele ? Promise.resolve() : loadAsset('vendor/pele/pele.global.js', false)).then(() => {
      if (!window.pele?.parse || !window.pele?.render) throw new Error('Pele did not initialize');
      return window.pele;
    }).catch(error => { fallbackPromise = null; throw error; });
  }
  function stopWorker() {
    const state = workerState;
    if (!state) return;
    workerState = null; state.stopped = true; clearTimeout(state.timeout);
    state.worker.terminate(); state.rejectReady(abort());
    state.pending?.reject(abort()); state.pending = null;
  }
  function getWorker() {
    if (workerDisabled || typeof Worker !== 'function') return Promise.reject(new Error('Worker unavailable'));
    if (workerState) return workerState.ready;
    let worker;
    try { worker = new Worker(new URL('note-mermaid-worker.js', ownUrl)); } catch (error) { return Promise.reject(error); }
    const state = { worker, pending: null, stopped: false };
    state.ready = new Promise((resolve, reject) => { state.resolveReady = resolve; state.rejectReady = reject; });
    workerState = state;
    const fail = error => {
      if (state.stopped) return;
      clearTimeout(state.timeout); state.stopped = true; state.worker.terminate();
      if (workerState === state) workerState = null;
      state.rejectReady(error); state.pending?.reject(error); state.pending = null;
    };
    state.worker.onmessage = event => {
      const data = event.data;
      if (data.ready) { clearTimeout(state.timeout); configureWorker(); state.resolveReady(state); return; }
      if (data.unavailable) { fail(new Error(data.unavailable)); return; }
      const pending = state.pending;
      if (!pending || pending.id !== data.id || pending.documentId !== data.documentId
          || pending.blockId !== data.blockId || pending.version !== data.version) return;
      state.pending = null; clearTimeout(state.timeout);
      if (data.error) pending.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
      else pending.resolve(data.result);
    };
    state.worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Diagram worker unavailable')); };
    state.timeout = setTimeout(() => fail(new Error('Diagram worker timed out')), 10000);
    return state.ready;
  }
  async function engine(job) {
    if (!workerDisabled) {
      try {
        const state = await getWorker();
        if (!job.valid() || state.stopped) throw abort();
        return await new Promise((resolve, reject) => {
          state.pending = { ...job.data, resolve, reject };
          state.timeout = setTimeout(() => {
            state.pending = null; stopWorker(); reject(new Error('Diagram worker timed out'));
          }, 10000);
          state.worker.postMessage(job.data);
        });
      } catch (error) {
        if (error.name === 'AbortError' || ['syntax', 'semantic', 'limit', 'unsupported-diagram', 'render'].includes(error.code)) throw error;
        workerDisabled = true; stopWorker();
      }
    }
    const runtime = await fallback();
    await yieldTask(job.signal);
    if (!job.valid()) throw abort();
    // Compatibility path for browsers without worker canvas/font support.
    const model = [...cache.values()].find(item => item.source === job.data.source && item.model)?.model
      || runtime.parse(job.data.source, { limit: 65536, maxEdges: 5000 });
    return { ...runtime.render(model, { ...job.data.options, limit: 65536, maxEdges: 5000, outputLimit: 4000000,
      autoDirection: false, responsive: true, links: false, images: false, idPrefix: 'relatum-note-pele-template' }), model };
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.size) {
        const [entry, job] = queue.entries().next().value;
        queue.delete(entry);
        if (!job.valid()) { job.reject(abort()); continue; }
        try { job.resolve(await engine(job)); } catch (error) { job.reject(error); }
      }
    } finally { running = false; if (!owners.size) stopWorker(); }
  }
  function render(entry, data, valid) {
    return new Promise((resolve, reject) => {
      queue.get(entry)?.reject(abort()); queue.set(entry, { data, valid, resolve, reject, signal: entry.ticket?.controller.signal }); pump();
    });
  }
  function cancel(entry) { queue.get(entry)?.reject(abort()); queue.delete(entry); }
  function warmWorker(options, valid) {
    if (workerDisabled || workerState) return;
    getWorker().then(state => { if (valid() && !state.stopped) state.worker.postMessage({ kind: 'fonts', options }); }).catch(error => {
      if (error.name !== 'AbortError') { workerDisabled = true; stopWorker(); }
    });
  }
  const fontNames = family => family.split(',').map(name => name.replace(/["']/g, '').trim().toLowerCase());
  const fontStamp = (family, mono) => JSON.stringify([fontRevision, ...fontNames(family + ',' + mono).map(name => [name, fontEpochs.get(name) || 0])]);
  function fontsChanged(event) {
    const changed = event.fontfaces ? [...new Set(Array.from(event.fontfaces).filter(face => !preparedFaces.has(face))
      .map(face => fontNames(face.family)[0]))] : null;
    if (changed && !changed.length) return;
    if (changed) changed.forEach(name => fontEpochs.set(name, (fontEpochs.get(name) || 0) + 1));
    else fontRevision++;
    window.pele?.forgetTextWidths(); owners.forEach(owner => owner.fontsChanged(changed));
  }
  function watch(owner) {
    if (!owners.size) document.fonts?.addEventListener('loadingdone', fontsChanged);
    owners.add(owner);
  }
  function unwatch(owner) {
    owners.delete(owner);
    trimCache();
    if (!owners.size) { document.fonts?.removeEventListener('loadingdone', fontsChanged); stopWorker(); }
  }
  function prepareFonts(family) {
    if (!document.fonts) return Promise.resolve();
    const known = [
      ['Relatum Open Sans', 'normal 400'], ['Relatum Open Sans', 'normal 700'],
      ['Relatum Open Sans', 'italic 400'], ['Relatum Open Sans', 'italic 700'], ['Noto Sans SC', 'normal 400'],
    ];
    return Promise.all(known.filter(face => family.includes(face[0])).map(face => {
      const key = face.join('|');
      if (!fontLoads.has(key)) fontLoads.set(key, document.fonts.load(face[1] + ' 16px "' + face[0] + '"', 'Aa汉字')
        .then(loaded => { loaded.forEach(font => preparedFaces.add(font)); return loaded; })
        .catch(error => { fontLoads.delete(key); throw error; }));
      return fontLoads.get(key);
    }));
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
  function remember(key, result) {
    const size = 2 * (key.length + result.svg.length);
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    if (size > cacheBudget().bytes) {
      for (const [identity, prior] of lastGood) if (prior === key) lastGood.delete(identity);
      return;
    }
    cache.set(key, { ...result, bytes: size }); cacheBytes += size;
    trimCache();
  }
  function rememberGood(identity, key) {
    if (!identity) return;
    lastGood.delete(identity); if (!cache.has(key)) return;
    lastGood.set(identity, key);
    while (lastGood.size > cacheBudget().items) lastGood.delete(lastGood.keys().next().value);
  }
  function cached(key) {
    const result = cache.get(key);
    if (result) { cache.delete(key); cache.set(key, result); }
    return result;
  }
  function fingerprint(value) {
    let a = 2166136261, b = 2654435769;
    for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 2246822519); }
    return value.length.toString(36) + '.' + (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36);
  }
  function layoutSignature(width, family, mono, size, source) {
    const day = /(?:^|\n)\s*gantt\b/i.test(source) ? new Date().toDateString() : '';
    return JSON.stringify([Math.round(width * 100) / 100, family, mono, size, fontStamp(family, mono), day]);
  }
  const heightKey = (mode, layout, source) => (mode === 'reading' ? 'r:' : 'l:') + fingerprint(layout) + ':' + fingerprint(source);
  function rememberHeight(key, height) {
    if (heightHints.has(key)) { heightBytes -= heightHints.get(key).bytes; heightHints.delete(key); }
    const bytes = key.length * 2 + 24;
    heightHints.set(key, { height, bytes }); heightBytes += bytes;
    while (heightHints.size > 2048 || heightBytes > 256 * 1024) {
      const first = heightHints.keys().next().value; heightBytes -= heightHints.get(first).bytes; heightHints.delete(first);
    }
  }
  function releaseReservation(el) {
    if (!el.classList.contains('note-mermaid-reserved')) return;
    el.classList.remove('note-mermaid-reserved'); el.style.removeProperty('min-height');
  }
  // Only numeric, fingerprinted hints survive SVG eviction. Apply them before
  // restoring a reading scroll position, including diagrams above the viewport.
  // Batch writes/reads so a long document does not force layout per diagram.
  function reserve(root, options = {}) {
    if (!enabled() || !heightHints.size) return;
    const elements = [...root.querySelectorAll('.mermaid-diagram')], updates = [];
    elements.forEach(el => el.classList.add('note-mermaid'));
    elements.forEach(el => {
      if (el.querySelector('.note-mermaid-stage > svg')) return;
      const carrier = el.querySelector('.mermaid-source');
      const source = normalize(carrier?.content?.textContent || carrier?.textContent || '', el.dataset.mermaidLang);
      const style = getComputedStyle(el), width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (!(width > 0)) return;
      const key = heightKey(options.mode, layoutSignature(width, style.fontFamily, style.getPropertyValue('--note-font-mono').trim() || 'monospace',
        parseFloat(style.fontSize) || 16, source), source);
      const hint = heightHints.get(key);
      if (hint) { heightHints.delete(key); heightHints.set(key, hint); updates.push({ el, height: hint.height }); }
    });
    updates.forEach(({ el, height }) => { el.classList.add('note-mermaid-reserved'); el.style.minHeight = height + 'px'; });
  }

  const unsafeCss = value => /@import|@keyframes|expression\s*\(|(?:javascript|vbscript|data)\s*:|url\s*\(\s*(?!["']?#[\w-]+["']?\s*\))/i.test(value);
  const forbidden = /^(?:script|foreignobject|iframe|object|embed|image|audio|video|animate|animatetransform|animatemotion|set|feimage)$/i;
  async function safeSvg(markup, prefix, valid, trusted, signal) {
    if (markup.length > 4000000 || /<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error('Invalid diagram output');
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelector('parsererror')) throw new Error('Invalid diagram SVG');
    const walker = parsed.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT), ids = new Map();
    const identified = [...(svg.id ? [svg] : []), ...svg.querySelectorAll('[id]')];
    identified.forEach(el => ids.set(el.id, prefix + '-' + ids.size));
    if (trusted && !ids.size) {
      if (!valid()) throw abort();
      svg.setAttribute('role', 'img'); svg.setAttribute('focusable', 'false');
      return { svg: document.adoptNode(svg), clean: markup };
    }
    let node = svg, until = performance.now() + 4, dirty = false, visited = 0;
    if (!valid()) throw abort();
    while (node) {
      const el = node;
      if (!trusted && (forbidden.test(el.localName) || el.localName === 'style' && unsafeCss(el.textContent))) {
        // Skip the forbidden subtree before detaching it from the parsed tree.
        node = walker.nextSibling();
        while (!node && walker.parentNode() && walker.currentNode !== svg) node = walker.nextSibling();
        el.remove(); dirty = true;
      } else {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase(), value = attr.value.trim();
          if (!trusted && (/^on/.test(name) || /^(?:src|srcset|formaction)$/.test(name)
              || /^(?:href|xlink:href)$/.test(name) && value && !/^#[\w-]+$/.test(value) || unsafeCss(value))) {
            el.removeAttribute(attr.name); dirty = true;
          } else if (ids.size) {
            let mapped = attr.value;
            if (name === 'id') mapped = ids.get(mapped);
            else if (/^(?:href|xlink:href)$/.test(name) && mapped.startsWith('#') && ids.has(mapped.slice(1))) mapped = '#' + ids.get(mapped.slice(1));
            else if (/^aria-(?:labelledby|describedby)$/.test(name)) mapped = mapped.split(/\s+/).map(id => ids.get(id) || id).join(' ');
            else if (mapped.includes('url(')) mapped = mapped.replace(/url\(\s*(["']?)#([\w-]+)\1\s*\)/g,
              (match, quote, id) => ids.has(id) ? 'url(#' + ids.get(id) + ')' : match);
            if (mapped !== attr.value) el.setAttribute(attr.name, mapped);
          }
        }
        if (ids.size && el.localName === 'style') el.textContent = el.textContent.replace(/url\(\s*(["']?)#([\w-]+)\1\s*\)/g,
          (match, quote, id) => ids.has(id) ? 'url(#' + ids.get(id) + ')' : match);
        node = walker.nextNode();
      }
      // JavaScript cannot change this task's identity until we yield. Checking
      // ancestors per SVG node was more expensive than sanitation itself.
      if (++visited % 32 === 0 && performance.now() >= until) {
        await yieldTask(signal); if (!valid()) throw abort(); until = performance.now() + 4;
      }
    }
    if (!valid()) throw abort();
    const clean = dirty || ids.size ? new XMLSerializer().serializeToString(svg) : markup;
    svg.setAttribute('role', 'img'); svg.setAttribute('focusable', 'false');
    return { svg: document.adoptNode(svg), clean };
  }

  // Viewport behavior is local and does not require loading Pele in this realm.
  // Teardown removes input behavior without resetting the saved camera.
  function createZoom(stage, saved) {
    const svg = stage.querySelector(':scope > svg'), width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'));
    for (const name of ['width', 'height', 'max-width', 'margin', 'display']) svg.style.removeProperty(name);
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const available = stage.clientWidth, fit = Math.min(1, available / width);
    stage.classList.toggle('has-note-mermaid-zoom', fit < .999);
    if (!(width > 0 && height > 0 && available > 0) || fit >= .999) return { destroy() {}, snapshot: null };
    const viewportHeight = Math.max(110, height * fit), max = Math.max(3, fit);
    let scale = fit, cx = width / 2, cy = height / 2, dragged = false, frame = 0;
    if (saved && saved.width === width && saved.height === height && Math.abs(saved.available - available) <= 1) ({ scale, cx, cy } = saved);
    const bar = document.createElement('div'); bar.className = 'pele pele-zoom note-mermaid-zoom';
    const buttons = {}, labels = { in: text('放大图表', 'Zoom in'), out: text('缩小图表', 'Zoom out'), reset: text('复位图表', 'Reset zoom') };
    const icons = { in: 'M5 12h14M12 5v14', out: 'M5 12h14', reset: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5' };
    for (const name of ['in', 'out', 'reset']) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.noteMermaidControl = name;
      button.setAttribute('aria-label', labels[name]); button.title = labels[name];
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + icons[name] + '"></path></svg>';
      buttons[name] = button; bar.append(button);
    }
    stage.append(bar); svg.tabIndex = 0;
    const zoomed = () => scale > fit * 1.001;
    function constrain() {
      const vw = zoomed() ? available / scale : width, vh = zoomed() ? viewportHeight / scale : height;
      cx = vw >= width ? width / 2 : Math.max(vw / 2, Math.min(width - vw / 2, cx));
      cy = vh >= height ? height / 2 : Math.max(vh / 2, Math.min(height - vh / 2, cy));
    }
    function apply() {
      frame = 0;
      const active = zoomed();
      const vw = active ? available / scale : width, vh = active ? viewportHeight / scale : height;
      constrain();
      svg.setAttribute('viewBox', [cx - vw / 2, cy - vh / 2, vw, vh].join(' '));
      svg.style.width = active ? '100%' : ''; svg.style.height = active ? viewportHeight + 'px' : '';
      svg.style.maxWidth = '100%'; svg.style.touchAction = active ? 'none' : 'pan-y';
      svg.style.cursor = active ? 'grab' : ''; svg.style.userSelect = active ? 'none' : '';
      buttons.in.disabled = scale >= max * .999; buttons.out.disabled = !active; buttons.reset.hidden = !active;
    }
    function paint() { constrain(); if (!frame) frame = requestAnimationFrame(apply); }
    function flush() { if (frame) { cancelAnimationFrame(frame); apply(); } }
    function zoom(next, x, y) {
      const box = stage.getBoundingClientRect(), old = scale;
      const px = x == null ? available / 2 : x - box.left, py = y == null ? viewportHeight / 2 : y - box.top;
      const wx = cx + (px - available / 2) / old, wy = cy + (py - viewportHeight / 2) / old;
      scale = Math.min(max, Math.max(fit, next));
      if (!zoomed()) { scale = fit; cx = width / 2; cy = height / 2; }
      else { cx = wx - (px - available / 2) / scale; cy = wy - (py - viewportHeight / 2) / scale; }
      paint();
    }
    function pan(dx, dy) { cx -= dx / scale; cy -= dy / scale; paint(); }
    const pointers = new Map();
    const pair = () => { const [a, b] = [...pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) }; };
    const down = event => {
      if (bar.contains(event.target) || event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); dragged = false;
      if (zoomed() || pointers.size === 2) { event.preventDefault(); stage.setPointerCapture?.(event.pointerId); }
    };
    const move = event => {
      const before = pointers.get(event.pointerId); if (!before) return;
      const prior = pointers.size === 2 ? pair() : null;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (prior) { const after = pair(); if (prior.distance > 0) zoom(scale * after.distance / prior.distance, after.x, after.y); pan(after.x - prior.x, after.y - prior.y); dragged = true; }
      else if (zoomed()) { const dx = event.clientX - before.x, dy = event.clientY - before.y; if (Math.abs(dx) + Math.abs(dy) > 0) dragged = true; pan(dx, dy); }
    };
    const up = event => { if (event.type === 'pointerup') move(event); pointers.delete(event.pointerId); flush(); if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId); };
    const click = event => { if (dragged && !bar.contains(event.target)) { dragged = false; event.preventDefault(); event.stopPropagation(); } };
    const wheel = event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoom(scale * 2 ** (Math.max(-24, Math.min(24, -event.deltaY)) * .02), event.clientX, event.clientY); } };
    const double = event => { if (!bar.contains(event.target)) { event.preventDefault(); zoom(zoomed() ? fit : Math.max(1, fit * 2), event.clientX, event.clientY); } };
    const key = event => {
      if (bar.contains(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') zoom(scale * 1.25);
      else if (event.key === '-') zoom(scale / 1.25);
      else if (zoomed() && /^(?:0|Escape)$/.test(event.key)) zoom(fit);
      else if (zoomed() && /^Arrow/.test(event.key)) {
        if (event.key === 'ArrowLeft') pan(48, 0); else if (event.key === 'ArrowRight') pan(-48, 0);
        else if (event.key === 'ArrowUp') pan(0, 48); else if (event.key === 'ArrowDown') pan(0, -48); else return;
      } else return;
      event.preventDefault();
    };
    let gestureScale = 0;
    const gestureStart = event => { event.preventDefault(); gestureScale = scale; };
    const gestureChange = event => { if (gestureScale) { event.preventDefault(); zoom(gestureScale * event.scale, event.clientX, event.clientY); } };
    const gestureEnd = () => { gestureScale = 0; flush(); };
    const blur = () => { pointers.clear(); gestureEnd(); };
    buttons.in.addEventListener('click', () => zoom(scale * 1.5625));
    buttons.out.addEventListener('click', () => zoom(scale / 1.5625));
    buttons.reset.addEventListener('click', () => zoom(fit));
    const events = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up],
      ['lostpointercapture', up], ['click', click, true], ['wheel', wheel, { passive: false }], ['dblclick', double], ['keydown', key],
      ['gesturestart', gestureStart, { passive: false }], ['gesturechange', gestureChange, { passive: false }], ['gestureend', gestureEnd]];
    events.forEach(args => stage.addEventListener(...args)); window.addEventListener('blur', blur); apply();
    return { get snapshot() { return { scale, cx, cy, width, height, available }; }, destroy() {
      pointers.forEach((_, id) => { if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id); }); pointers.clear();
      flush(); events.forEach(args => stage.removeEventListener(...args)); window.removeEventListener('blur', blur); bar.remove(); svg.removeAttribute('tabindex');
    } };
  }

  function attach(root, options = {}) {
    root.__noteMermaid?.destroy();
    let disposed = false, paused = false, pageActive = true, watching = false, measure = 0, midnight = 0;
    let intersection = null, resize = null;
    const byElement = new Map(), documentId = 'note-diagrams-' + (++nextId);
    const elements = [...(root.matches('.mermaid-diagram') ? [root] : []), ...root.querySelectorAll('.mermaid-diagram')];
    const entries = elements.map(el => {
      const carrier = el.querySelector('.mermaid-source'); el.classList.add('note-mermaid');
      const entry = { el, source: normalize(carrier?.content?.textContent || carrier?.textContent || '', el.dataset.mermaidLang),
        key: '', visible: false, version: 0, timer: 0, ticket: null, again: false, error: false, observedWidth: -1,
        prefix: 'relatum-note-pele-' + (++nextId), zoom: null, camera: null };
      byElement.set(el, entry); return entry;
    });
    const owner = { sync, cacheKeys() {
      if (!foreground()) return [];
      return entries.filter(current).flatMap(entry => [entry.key, lastGood.get(options.historyKey)]).filter(Boolean);
    }, fontsChanged(changed) {
      if (!changed || entries.some(entry => entry.fontNames?.some(name => changed.includes(name)))) sync();
    } };
    function foreground() {
      return enabled() && !disposed && !paused && pageActive && !document.hidden
        && document.documentElement.dataset.desktopMinimized !== '1' && root.isConnected && !root.closest('[hidden]')
        && (!root.closest('.note-workspace') || document.body.dataset.startWorkspace === 'notes')
        && (!options.isCurrent || options.isCurrent());
    }
    function current(entry) { return foreground() && entry.visible && entry.el.isConnected; }
    function layout() {
      if (options.onLayout && !measure && foreground()) measure = requestAnimationFrame(() => { measure = 0; if (foreground()) options.onLayout(); });
    }
    function releaseZoom(entry) { if (entry.zoom) { entry.camera = entry.zoom.snapshot; entry.zoom.destroy(); entry.zoom = null; } }
    function invalidate(entry) {
      entry.version++; entry.ticket?.controller.abort(); entry.ticket = null; entry.again = false; clearTimeout(entry.timer); entry.timer = 0; cancel(entry);
    }
    function stop() {
      intersection?.disconnect(); resize?.disconnect(); intersection = resize = null;
      entries.forEach(entry => { invalidate(entry); entry.visible = false; releaseZoom(entry); });
      if (measure) cancelAnimationFrame(measure); measure = 0; clearTimeout(midnight); midnight = 0;
      watching = false; unwatch(owner);
    }
    function controls(entry) {
      const stage = entry.el.querySelector('.note-mermaid-stage');
      if (options.mode === 'reading' && !entry.zoom && stage?.querySelector(':scope > svg')) entry.zoom = createZoom(stage, entry.camera);
    }
    function mount(entry, svg, key) {
      releaseZoom(entry); entry.camera = null;
      const stage = document.createElement('div'); stage.className = 'note-mermaid-stage'; stage.append(svg);
      entry.el.querySelectorAll(':scope > :not(template)').forEach(el => el.remove()); releaseReservation(entry.el);
      entry.el.append(stage); entry.el.classList.add('is-rendered'); entry.el.classList.remove('is-error');
      entry.el.dataset.noteMermaidRendered = '1'; entry.key = key; entry.failure = null;
      controls(entry); layout(); armMidnight();
    }
    function armMidnight() {
      if (midnight || !entries.some(entry => entry.visible && /(?:^|\n)\s*gantt\b/i.test(entry.source))) return;
      const next = new Date(); next.setHours(24, 0, 0, 20);
      midnight = setTimeout(() => { midnight = 0; entries.forEach(entry => schedule(entry)); armMidnight(); }, next.getTime() - Date.now());
    }
    function schedule(entry, delay = 0) {
      if (entry.error || entry.timer || entry.ticket || !current(entry)) return;
      entry.timer = setTimeout(() => { entry.timer = 0; draw(entry); }, delay);
    }
    async function draw(entry) {
      if (!current(entry)) return;
      const requestedCacheEpoch = cacheEpoch;
      const version = entry.version, ticket = { controller: new AbortController() }; entry.ticket = ticket;
      const valid = () => entry.ticket === ticket && entry.version === version && current(entry);
      let requestedRevision = null, requestedFamily = '', requestedMono = '';
      const currentFontStamp = () => fontStamp(requestedFamily, requestedMono);
      try {
        await options.whenSettled?.(); if (!valid()) return;
        const hint = getComputedStyle(entry.el), hintedFonts = { fontFamily: hint.fontFamily,
          fontFamilyMono: hint.getPropertyValue('--note-font-mono').trim() || 'monospace' };
        entry.fontNames = fontNames(hintedFonts.fontFamily + ',' + hintedFonts.fontFamilyMono);
        // Start font transfer and worker compilation together, only for a real
        // visible cache miss. Cached diagrams need neither a worker nor Pele.
        if (![...cache.keys()].some(key => key.endsWith('\n' + entry.source))) warmWorker(hintedFonts, () => current(entry));
        await Promise.all([styles(), prepareFonts(hintedFonts.fontFamily + ',' + hintedFonts.fontFamilyMono)]);
        if (!valid()) return;
        const style = getComputedStyle(entry.el), width = entry.el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (!(width > 0)) return;
        const fontFamily = style.fontFamily, fontFamilyMono = style.getPropertyValue('--note-font-mono').trim() || 'monospace';
        await prepareFonts(fontFamily + ',' + fontFamilyMono); if (!valid()) return;
        requestedFamily = fontFamily; requestedMono = fontFamilyMono;
        entry.fontNames = fontNames(fontFamily + ',' + fontFamilyMono); requestedRevision = currentFontStamp();
        const now = Date.now();
        const renderOptions = { fontFamily, fontFamilyMono, fontSize: parseFloat(style.fontSize) || 16,
          maxWidth: Math.round(width * 100) / 100, now };
        const layoutKey = layoutSignature(renderOptions.maxWidth, fontFamily, fontFamilyMono, renderOptions.fontSize, entry.source);
        const key = layoutKey + '\n' + entry.source;
        if (entry.key === key && entry.el.querySelector('.note-mermaid-stage > svg')) { controls(entry); return; }
        if (entry.source.length > 65536) throw Object.assign(new Error(text('图表源码超过 64 KiB 限制', 'Diagram source exceeds the 64 KiB limit')), { code: 'limit' });
        const hit = cached(key);
        if (!hit && options.editing && !entry.el.querySelector('.note-mermaid-stage > svg')) {
          const previousKey = lastGood.get(options.historyKey), previous = cached(previousKey);
          if (previous?.layoutKey === layoutKey) {
            const restored = await safeSvg(previous.svg, entry.prefix, valid, true, ticket.controller.signal);
            if (!valid()) return;
            mount(entry, restored.svg, previousKey);
          }
        }
        const result = hit || await render(entry, { id: ++nextId, documentId, blockId: entry.prefix, version, cacheEpoch: requestedCacheEpoch,
          source: entry.source, options: renderOptions, layoutKey, fontRevision: requestedRevision }, valid);
        if (!valid() || requestedRevision !== currentFontStamp()) return;
        const sanitized = await safeSvg(result.svg, entry.prefix, valid, !!hit, ticket.controller.signal);
        await options.whenSettled?.(); if (!valid() || requestedRevision !== currentFontStamp()) return;
        const latest = getComputedStyle(entry.el), latestWidth = entry.el.clientWidth - parseFloat(latest.paddingLeft) - parseFloat(latest.paddingRight);
        if (Math.abs(latestWidth - width) > .01 || latest.fontFamily !== fontFamily || (parseFloat(latest.fontSize) || 16) !== renderOptions.fontSize
            || (latest.getPropertyValue('--note-font-mono').trim() || 'monospace') !== fontFamilyMono) { entry.again = true; return; }
        if (!hit && requestedCacheEpoch === cacheEpoch) remember(key, { svg: sanitized.clean, width: result.width, height: result.height, source: entry.source, model: result.model, layoutKey });
        rememberGood(options.historyKey, key); mount(entry, sanitized.svg, key);
        const svgHeight = result.height * Math.min(1, width / result.width);
        const reservedHeight = Math.max(svgHeight, options.mode === 'reading' && result.width > width ? 110 : 0)
          + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        if (Number.isFinite(reservedHeight)) rememberHeight(heightKey(options.mode, layoutKey, entry.source), reservedHeight);
      } catch (error) {
        if (valid() && error.name !== 'AbortError') fail(entry, error, !['syntax', 'semantic', 'limit', 'unsupported-diagram', 'render'].includes(error.code));
      } finally {
        if (entry.ticket === ticket) {
          entry.ticket = null;
          const again = entry.again || requestedRevision !== null && requestedRevision !== currentFontStamp(); entry.again = false;
          if (again) schedule(entry);
        }
      }
    }
    function fail(entry, error, retryable) {
      entry.error = true; entry.failure = { error, retryable };
      const editing = options.editing === true;
      const box = document.createElement('div'); box.className = editing ? 'note-mermaid-status' : 'note-mermaid-error';
      const message = document.createElement('p');
      message.textContent = editing && !retryable ? text('图表源码尚未完成', 'Diagram source is incomplete')
        : text('图表暂未显示：', 'Diagram unavailable: ') + String(error?.message || error);
      box.append(message);
      if (retryable) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.noteMermaidControl = 'retry';
        button.textContent = text('重试', 'Retry');
        button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); entry.error = false; entry.failure = null; workerDisabled = false; box.remove(); schedule(entry);
        }); box.append(button);
      }
      entry.el.querySelectorAll(':scope > .note-mermaid-status, :scope > .note-mermaid-error').forEach(el => el.remove());
      if (!editing) {
        releaseReservation(entry.el);
        releaseZoom(entry); entry.camera = null; entry.key = '';
        entry.el.classList.remove('is-rendered'); entry.el.classList.add('is-error'); delete entry.el.dataset.noteMermaidRendered;
        const pre = document.createElement('pre'); pre.textContent = entry.source; box.append(pre);
        entry.el.querySelectorAll(':scope > :not(template)').forEach(el => el.remove());
      }
      entry.el.append(box); layout();
    }
    function sync() {
      if (!foreground()) { if (watching) stop(); return; }
      if (!watching) {
        watching = true; watch(owner);
        if (typeof IntersectionObserver === 'function') intersection = new IntersectionObserver(records => records.forEach(record => {
          const entry = byElement.get(record.target); if (!entry) return;
          entry.visible = record.isIntersecting;
          if (entry.visible) { schedule(entry); armMidnight(); }
          else { invalidate(entry); releaseZoom(entry); }
        }));
        if (typeof ResizeObserver === 'function') resize = new ResizeObserver(records => records.forEach(record => {
          const entry = byElement.get(record.target);
          if (entry && Math.abs(entry.observedWidth - record.contentRect.width) > .01) {
            if (entry.observedWidth >= 0) invalidate(entry);
            entry.observedWidth = record.contentRect.width; schedule(entry);
          }
        }));
        entries.forEach(entry => {
          if (intersection) intersection.observe(entry.el);
          else { const box = entry.el.getBoundingClientRect(); entry.visible = box.bottom > 0 && box.top < innerHeight; }
          resize?.observe(entry.el); schedule(entry);
        });
      } else entries.forEach(entry => { if (entry.ticket) entry.again = true; else schedule(entry); });
    }
    const pagehide = () => { pageActive = false; stop(); };
    const pageshow = () => { pageActive = true; sync(); };
    const language = () => { entries.forEach(entry => { releaseZoom(entry); if (entry.error && entry.failure) fail(entry, entry.failure.error, entry.failure.retryable); }); sync(); };
    const inputSettled = () => Promise.resolve(options.whenSettled?.()).then(sync);
    const events = [[document, 'visibilitychange', sync], [window, 'canvasdesktop:visibility', sync],
      [document, 'relatum:start-workspacechange', sync], [window, 'pagehide', pagehide], [window, 'pageshow', pageshow],
      [document, 'relatum:languagechange', language], [document, 'compositionstart', sync], [document, 'compositionend', inputSettled]];
    events.forEach(([target, name, handler]) => target.addEventListener(name, handler));
    const mutation = new MutationObserver(sync);
    for (let parent = root; parent; parent = parent.parentElement) mutation.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'data-start-workspace'] });
    const controller = {
      update(source, language) {
        if (disposed || entries.length !== 1) return;
        const entry = entries[0], normalized = normalize(source, language);
        if (normalized === entry.source) return;
        invalidate(entry); entry.source = normalized; entry.error = false; entry.failure = null;
        const notices = entry.el.querySelectorAll(':scope > .note-mermaid-status, :scope > .note-mermaid-error');
        notices.forEach(el => el.remove()); if (notices.length) layout();
        schedule(entry, options.editing ? 120 : 0);
      },
      suspend() { paused = true; stop(); }, resume() { paused = false; sync(); }, destroy() {
        if (disposed) return;
        disposed = true; stop(); mutation.disconnect();
        events.forEach(([target, name, handler]) => target.removeEventListener(name, handler)); byElement.clear();
        if (root.__noteMermaid === controller) delete root.__noteMermaid;
      },
    };
    root.__noteMermaid = controller; sync(); return controller;
  }
  window.RelatumNoteMermaid = Object.freeze({ attach, reserve });
})();

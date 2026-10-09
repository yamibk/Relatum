// Optional plugin host. Loaded only for a visible enabled canvas block.
(function () {
  'use strict';
  const script = document.currentScript;
  const base = new URL('.', script.src);
  let ready = null;
  const mounts = new Set();
  let active = null;
  function selectionChanged() { document.dispatchEvent(new Event('relatum:note-canvas-selection')); }
  function activate(adapter) {
    if(active===adapter) return;
    const previous=active;active=null;previous?.engine?.suspend();active=adapter;
    selectionChanged();
  }
  function deactivate(adapter) { if(active===adapter) {active=null;selectionChanged();} }
  const VIEW_KEY = 'canvas:noteCanvasViews:v1', SIZE_KEY = 'canvas:noteCanvasNodeScale:v1';
  function preferences() { try { const value = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch (_) { return {}; } }
  let views = preferences(), persistTimer = 0;
  function persist() {
    clearTimeout(persistTimer); persistTimer = setTimeout(() => {
      const entries = Object.entries(views).sort((a, b) => b[1].time - a[1].time).slice(0, 256);
      views = Object.fromEntries(entries); try { localStorage.setItem(VIEW_KEY, JSON.stringify(views)); } catch (_) {}
    }, 350);
  }
  function viewKey(note, target, ordinal) { return JSON.stringify([note, target.toLowerCase(), ordinal || 0]); }
  function load() {
    if (ready) return ready;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('canvas.css', base).href; document.head.appendChild(css);
    const stylesheet = new Promise((resolve, reject) => { css.onload = resolve; css.onerror = reject; });
    const loadScript = name => new Promise((resolve, reject) => { const el = document.createElement('script'); el.src = new URL(name, base).href; el.onload = resolve; el.onerror = reject; document.head.appendChild(el); });
    ready = Promise.all([stylesheet, (window.RelatumNoteCanvasStyle ? Promise.resolve() : loadScript('../note-canvas-style.js'))
      .then(() => loadScript('geometry.js')).then(() => loadScript('session.js')).then(() => loadScript('engine.js'))]).catch(error => { ready = null; css.remove(); throw error; });
    return ready;
  }
  function mount(frame, options) {
    let engine = null, session = null, destroyed = false, visible = false, generation = 0, cleanupResize = null;
    frame.classList.add('note-canvas-frame'); frame.dataset.canvasSource = options.parsed.target;
    let frameWidth = 0, frameHeight = 0;
    function dimensions(width, height) {
      width = width || 640; height = height || width * 9 / 16;
      if (frameWidth === width && frameHeight === height) return false;
      frameWidth = width; frameHeight = height;
      frame.style.width = width + 'px'; frame.style.maxWidth = '100%'; frame.style.aspectRatio = width + '/' + height;
      return true;
    }
    dimensions(options.parsed.width, options.parsed.height);
    function select(selected) {
      selected = !!selected && !options.readOnly;
      frame.classList.toggle('is-selected', selected);
      if (selected && cleanupResize) return;
      if (cleanupResize) { cleanupResize(); cleanupResize = null; }
      if (!selected || options.readOnly || !window.RelatumNoteMediaFrame) return;
      cleanupResize = window.RelatumNoteMediaFrame.resize(frame, {
        selected: true, resolve: () => options.resolve?.() || (!options.readOnly && options.parsed),
        blocked: () => !!(engine && session?.owner),
        maxWidth: () => options.maxWidth?.() || frame.parentElement.clientWidth,
        preview(width, rect) { if (dimensions(width, Math.round(width * rect.height / rect.width))) { options.measure?.(); engine?.refreshSize(); } },
        restore() { if (dimensions(options.parsed.width, options.parsed.height)) { options.measure?.(); engine?.refreshSize(); } },
        commit(width, rect) { options.resize?.(width, Math.max(1, Math.round(width * rect.height / rect.width))); },
      });
    }
    async function enter() {
      const seq = ++generation;
      try {
        await load(); if (destroyed || !visible || seq !== generation || !frame.isConnected) return;
        frame.querySelector('.is-unavailable')?.remove();
        const S = window.RelatumNoteCanvasSessions;
        const acquired = await S.acquire(options.note, options.parsed.target);
        if (destroyed || !visible || seq !== generation || !frame.isConnected) { S.releaseUnused(); return; }
        S.retainNote(acquired, options.note);
        if (session !== acquired) { if (session) session.pins--; session = acquired; session.pins++; }
        const key = viewKey(options.note, session.path, options.ordinal);
        engine = window.RelatumNoteCanvasEngine.create({ host: frame, session, readOnly: options.readOnly,
          viewport: views[key]?.view,
          nodeScale() { try { return Math.max(.5, Math.min(3, Number(localStorage.getItem(SIZE_KEY) || 100) / 100)); } catch (_) { return 1; } },
          onViewChange(view) { views[viewKey(options.note, session.path, options.ordinal)] = { view, time: Date.now() }; persist(); },
          onActivate() { activate(adapter);options.select?.(); select(!options.readOnly); },
          onDeactivate() { deactivate(adapter); },
          onCopyReference: () => navigator.clipboard.writeText(options.source || options.parsed.source).catch(() => {}),
          onDeleteReference: () => options.remove?.(),
        });
        options.measure?.(); select(!!options.selected);
      } catch (error) {
        if (!destroyed && seq === generation && frame.isConnected) {
          const message = document.createElement('div'); message.className = 'note-canvas-viewport is-unavailable'; message.textContent = error.message;
          frame.appendChild(message); options.measure?.();
        }
      }
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        visible = entry.isIntersecting;
        if (visible && !engine) enter();
        else if (!visible && engine) {
          const previous = engine; generation++; previous.suspend();
          previous.whenInputSettled().then(() => { if (!visible && engine === previous) { previous.destroy(); engine = null; } });
        }
      });
    });
    observer.observe(frame);
    const menu = event => {
      if (options.readOnly) { event.preventDefault(); event.stopPropagation(); return; }
      event.preventDefault(); event.stopPropagation(); options.onContextMenu?.({ x: event.clientX, y: event.clientY, frame, adapter });
    };
    frame.addEventListener('contextmenu', menu);
    const adapter = {
      frame, options, get engine() { return engine; }, get session() { return session; },
      update(next) {
        const changedSize = options.parsed.width !== next.parsed.width || options.parsed.height !== next.parsed.height;
        Object.assign(options, next); frame.dataset.canvasSource = options.parsed.target;
        if (changedSize && dimensions(options.parsed.width, options.parsed.height)) { options.measure?.(); engine?.refreshSize(); }
        select(!!options.selected);
      },
      async settle() { return engine ? engine.whenInputSettled() : true; },
      suspend() { engine?.suspend(); },
      async destroy() {
        if (destroyed) return; destroyed = true; generation++; observer.disconnect(); frame.removeEventListener('contextmenu', menu);
        engine?.suspend();deactivate(adapter);
        if (cleanupResize) cleanupResize();
        await engine?.whenInputSettled(); engine?.destroy(); engine = null;
        if (session) { session.pins--; session = null; } mounts.delete(adapter);
      },
    };
    mounts.add(adapter); frame.__noteCanvas = adapter; select(!!options.selected); return adapter;
  }
  function remapViews(source, destination, noteMove) {
    if (noteMove) window.RelatumNoteCanvasSessions?.remapNotes(source, destination);
    Object.entries(views).forEach(([key, value]) => {
      let parts; try { parts = JSON.parse(key); } catch (_) { return; }
      const index = noteMove ? 0 : 1, path = parts[index];
      if (path === source || noteMove && path.startsWith(source + '/')) {
        parts[index] = destination + path.slice(source.length); delete views[key]; views[JSON.stringify(parts)] = value;
      }
    }); persist();
  }
  window.RelatumNoteCanvas = Object.freeze({ mount, remapViews,
    getActive() { return active?.engine || null; },
    async flushAll(options) { const settle = options?.settle !== false; if (settle) await Promise.all([...mounts].map(m => m.settle())); return window.RelatumNoteCanvasSessions ? window.RelatumNoteCanvasSessions.flushAll(!settle) : true; },
    get dirty() { return !!window.RelatumNoteCanvasSessions?.dirty(); },
    suspend() { mounts.forEach(m => m.suspend()); },
    releaseUnused() { window.RelatumNoteCanvasSessions?.releaseUnused(); },
    async releaseNote(note) { await Promise.all([...mounts].filter(m => m.options.note === note).map(m => m.destroy())); window.RelatumNoteCanvasSessions?.releaseNote(note); },
    renameSession(source, result) { window.RelatumNoteCanvasSessions?.rename(source, result); remapViews(source.toLowerCase(), result.path.toLowerCase(), false); },
  });
})();

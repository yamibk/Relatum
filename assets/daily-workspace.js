(function () {
  'use strict';
  const element = document.querySelector('#start-daily-workspace');
  const features = window.RelatumFeatureRuntime;
  const pageLayout = window.RelatumPageLayout;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const pages = {
    tasks: { label: ['每日任务', 'Daily tasks'], factory: 'RelatumDailyTasks', scripts: ['daily-tasks.js'], role: 'focus-view' },
    calendar: { label: ['日历', 'Calendar'], factory: 'RelatumDailyCalendar', scripts: ['markdown.js', 'mermaid-renderer.js', 'start-sticky-notes.js', 'calendar.js'], role: 'calendar-shell' },
    focus: { label: ['专注', 'Focus'], factory: 'RelatumDailyFocus', scripts: ['focus-service.js', 'start-sticky-notes.js', 'focus.js'], role: 'focus-view' },
    ledger: { label: ['记账', 'Ledger'], factory: 'RelatumDailyLedger', scripts: ['study-palette.js', 'ledger-model.js', 'start-sticky-notes.js', 'ledger.js'], role: 'ledger-shell' },
    images: { label: ['图片编辑', 'Image editor'], factory: 'RelatumDailyImages', styles: ['review-controls.css'], scripts: ['review-controls.js', 'image-markup-core.js', 'daily-images.js'], role: 'images-shell' },
  };
  const ready = { 'markdown.js': () => window.MarkdownMini, 'mermaid-renderer.js': () => window.MermaidRenderer,
    'study-palette.js': () => window.RelatumStudyPalette, 'ledger-model.js': () => window.RelatumLedgerModel,
    'focus-service.js': () => window.RelatumFocusService, 'start-sticky-notes.js': () => window.RelatumStartPageNotes,
    'image-markup-core.js': () => window.RelatumImageMarkupCore, 'review-controls.js': () => window.RelatumReviewControls };
  const instances = new Map(), snapshots = new Map(), prepared = new Map(), styles = new Map();
  let active = false, current = '', sequence = 0, disposed = false, releaseTimer = 0;
  let releaseVersion = 0, leftAt = null, exitFinished = false;
  let warmup = null, dataVersion = 0, navigation = Promise.resolve(true), pageHidden = false;
  let composing = null;
  let sliderTarget = '', sliderFrame = 0, sliderRestore = 0, sliderInstant = false, sliderReady = false, navResize = null;
  let wheelAccum = 0, wheelResetTimer = 0;
  element.addEventListener('compositionstart', event => { composing = event.target; }, true);
  element.addEventListener('compositionend', event => { if (composing === event.target) composing = null; }, true);
  const visible = () => active && !pageHidden && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1';
  const available = () => pageLayout.items('daily').map(item => item.id);
  const text = pair => pair[window.RelatumI18n?.language === 'en' ? 1 : 0];
  function syncSlider() {
    sliderFrame = 0;
    const nav = element.querySelector('.daily-navigation'), slider = nav?.querySelector('.daily-nav-slider');
    const button = nav?.querySelector('[data-daily-page="' + (sliderTarget || current) + '"]');
    if (!slider || !button || !visible() || !button.offsetWidth) { sliderReady = false; return; }
    const instant = sliderInstant || !sliderReady || reducedMotion.matches;
    sliderInstant = false; sliderReady = true;
    cancelAnimationFrame(sliderRestore); sliderRestore = 0;
    nav.classList.toggle('daily-nav-no-motion', instant);
    const track = slider.firstElementChild;
    const x = button.offsetLeft, y = button.offsetTop;
    const buttons = [...nav.querySelectorAll('button:not([hidden])')];
    // Read local coordinates: workspace entrance transforms must not scale them.
    const boxes = buttons.map(item => ({ x: item.offsetLeft, y: item.offsetTop, w: item.offsetWidth, h: item.offsetHeight }));
    slider.style.width = button.offsetWidth + 'px'; slider.style.height = button.offsetHeight + 'px';
    slider.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    track.style.transform = 'translate3d(' + -x + 'px,' + -y + 'px,0)';
    [...track.children].forEach((label, index) => {
      const box = boxes[index]; label.textContent = buttons[index].textContent;
      Object.assign(label.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
    });
    slider.classList.add('show');
    if (instant) sliderRestore = requestAnimationFrame(() => { sliderRestore = 0; nav.classList.remove('daily-nav-no-motion'); });
  }
  function queueSlider(instant = false) {
    sliderInstant ||= instant;
    if (visible() && !sliderFrame) sliderFrame = requestAnimationFrame(syncSlider);
  }
  function stopSlider() {
    clearTimeout(wheelResetTimer); wheelResetTimer = 0; wheelAccum = 0;
    cancelAnimationFrame(sliderFrame); cancelAnimationFrame(sliderRestore); sliderFrame = sliderRestore = 0;
    sliderTarget = current; sliderInstant = true;
    const nav = element.querySelector('.daily-navigation'); nav?.classList.add('daily-nav-no-motion');
    // Commit the resting position before the outer workspace exits.
    if (visible()) syncSlider();
    cancelAnimationFrame(sliderRestore); sliderRestore = 0; sliderReady = false;
    nav?.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
  }
  function orderNavigation() {
    const nav = element.querySelector('.daily-navigation'); if (!nav) return;
    const focused = nav.contains(document.activeElement) ? document.activeElement : null;
    const buttons = new Map([...nav.querySelectorAll('button')].map(button => [button.dataset.dailyPage, button]));
    const order = available();
    pageLayout.items('daily', { includeHidden: true }).forEach(({ id }) => {
      const button = buttons.get(id); if (!button) return;
      button.hidden = !order.includes(id); button.disabled = button.hidden; nav.append(button);
    });
    nav.hidden = !order.length;
    const track = nav.querySelector('.daily-nav-slider-track');
    if (track.children.length !== order.length) track.replaceChildren(...order.map(() => document.createElement('span')));
    if (!current) nav.querySelector('.daily-nav-slider').classList.remove('show');
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    queueSlider(true);
  }
  function createScope(root) {
    const controller = new AbortController(), timers = new Set(), frames = new Set();
    const listeners = new WeakMap();
    let alive = true;
    const scope = {
      get alive() { return alive; },
      listen(target, type, callback, options) {
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        let callbacks = listeners.get(target);
        if (!callbacks) listeners.set(target, callbacks = new Map());
        let registrations = callbacks.get(callback);
        if (!registrations) callbacks.set(callback, registrations = new Map());
        const key = type + ':' + capture;
        if (registrations.has(key)) return;
        const foreground = /^(?:click|keydown|pointermove|pointerup|pointercancel|resize|scroll)$/.test(type);
        const listener = event => {
          if (options?.once) { registrations.delete(key); if (!registrations.size) callbacks.delete(callback); }
          if (!alive || (foreground && (!visible() || root.hidden))) return;
          callback.call(target, event);
        };
        registrations.set(key, listener);
        target.addEventListener(type, listener, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: controller.signal });
      },
      setTimeout(callback, delay, ...args) { if (!alive) return 0; const id = window.setTimeout(() => { timers.delete(id); if (alive) callback(...args); }, delay); timers.add(id); return id; },
      clearTimeout(id) { timers.delete(id); window.clearTimeout(id); },
      requestAnimationFrame(callback) { if (!alive) return 0; const id = window.requestAnimationFrame(time => { frames.delete(id); if (alive) callback(time); }); frames.add(id); return id; },
      cancelAnimationFrame(id) { frames.delete(id); window.cancelAnimationFrame(id); },
      stop({ freeze = false } = {}) {
        timers.forEach(window.clearTimeout); timers.clear(); frames.forEach(window.cancelAnimationFrame); frames.clear();
        root?.getAnimations({ subtree: true }).forEach(animation => { if (freeze) animation.pause(); else animation.cancel(); });
      },
      destroy() { alive = false; scope.stop(); controller.abort(); },
    };
    return scope;
  }
  async function css(src) {
    if (styles.has(src)) return styles.get(src);
    const pending = new Promise((resolve, reject) => {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = src;
      link.onload = () => resolve(link);
      link.onerror = () => { styles.delete(src); link.remove(); reject(new Error(src + ' 加载失败')); };
      document.head.append(link);
    });
    styles.set(src, pending); return pending;
  }
  function changed() { dataVersion++; prepared.clear(); }
  async function read(path, options = {}) {
    if (path === '/api/daily' && !features.enabled('daily.tasks')) return { tasks: [], groups: [] };
    const cached = prepared.get(path);
    if (cached && !options.signal?.aborted) { prepared.delete(path); return cached; }
    const response = await fetch(path, options), json = await response.json();
    if (!response.ok || json.ok === false) throw new Error(json.error || '读取失败');
    return json;
  }
  function cancelWarmup() { warmup?.abort(); warmup = null; }
  function prepare() {
    cancelWarmup();
    if (!visible() || !current || features.preloadEnabled === false) return;
    const controller = warmup = new AbortController(), version = dataVersion;
    (async () => {
      for (const [feature, path] of [['tasks', '/api/daily'], ['focus', '/api/focus']]) {
        if (!available().includes(feature) || current === feature || prepared.has(path)) continue;
        await window.RelatumWorkspaceRuntime.preparation().waitForIdle(controller.signal);
        if (!visible() || !available().includes(feature) || version !== dataVersion) return;
        const json = await read(path, { signal: controller.signal });
        if (!controller.signal.aborted && visible() && version === dataVersion) prepared.set(path, json);
      }
    })().catch(() => {}).finally(() => { if (warmup === controller) warmup = null; });
  }
  function makeShell() {
    if (element.firstElementChild) { observeNavigation(); orderNavigation(); return; }
    const nav = document.createElement('nav'); nav.className = 'daily-navigation'; nav.setAttribute('aria-label', text(['日常页面', 'Daily pages']));
    for (const { id } of pageLayout.items('daily', { includeHidden: true })) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.dailyPage = id;
      button.textContent = text(pages[id].label); button.addEventListener('click', () => navigate(id)); nav.append(button);
    }
    const slider = document.createElement('span'), track = document.createElement('span');
    slider.className = 'daily-nav-slider'; slider.setAttribute('aria-hidden', 'true'); track.className = 'daily-nav-slider-track';
    available().forEach(() => track.append(document.createElement('span'))); slider.append(track); nav.prepend(slider);
    nav.addEventListener('keydown', event => {
      const horizontal = matchMedia('(max-width: 700px)').matches;
      const previousKey = horizontal ? 'ArrowLeft' : 'ArrowUp', nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll('button:not([hidden])')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === nextKey ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus(); if (buttons[next]) navigate(buttons[next].dataset.dailyPage);
    });
    nav.addEventListener('wheel', event => {
      if (!visible() || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const order = available(), index = order.indexOf(sliderTarget || current);
      const direction = Math.sign(event.deltaY);
      if (!direction || index < 0) return;
      // Keep content scrolling native; only this navigation surface flips pages.
      event.preventDefault();
      if (wheelAccum && Math.sign(wheelAccum) !== direction) wheelAccum = 0;
      wheelAccum += event.deltaY;
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => { wheelAccum = 0; wheelResetTimer = 0; }, 200);
      if (Math.abs(wheelAccum) < 24) return;
      wheelAccum = 0;
      const next = order[index + direction];
      if (next) navigate(next);
    }, { passive: false });
    const stage = document.createElement('div'); stage.className = 'daily-stage'; element.append(nav, stage);
    observeNavigation();
    orderNavigation();
  }
  function observeNavigation() {
    const nav = element.querySelector('.daily-navigation');
    if (!nav || navResize) return;
    navResize = new ResizeObserver(() => queueSlider(true)); navResize.observe(nav);
    nav.querySelectorAll('button').forEach(button => navResize.observe(button));
  }
  async function mount(id, expected) {
    if (instances.has(id)) return instances.get(id);
    const config = pages[id];
    for (const src of config.styles || []) await css(src);
    await css('daily-' + id + '.css');
    for (const src of config.scripts) await window.RelatumDailyLoader.script(src, ready[src] || (() => window[config.factory]));
    let markup = '';
    if (id === 'tasks' || id === 'focus') {
      const response = await fetch('daily-' + id + '.html'); if (!response.ok) throw new Error('页面模板加载失败'); markup = await response.text();
    }
    if (!active || expected !== sequence || disposed) throw new DOMException('Page superseded', 'AbortError');
    const root = document.createElement('section'); root.className = 'daily-page daily-page-' + id;
    root.dataset.role = config.role; root.hidden = true; root.inert = true;
    if (id === 'tasks') root.classList.add('focus-view-daily');
    if (id === 'calendar') root.classList.add('calendar-shell');
    if (id === 'ledger') root.classList.add('ledger-shell');
    root.innerHTML = markup;
    element.querySelector('.daily-stage').append(root);
    const entry = { root, controller: null, api: null, scopes: [], front: false, workspaceReturn: false,
      language: window.RelatumI18n?.language, state: snapshots.get(id) || {} };
    const host = {
      element, state: entry.state, isActive: () => visible() && current === id,
      toast: notice,
      createScope() { const scope = createScope(root); entry.scopes.push(scope); return scope; },
      read: (path, options = {}) => read(path, { ...options, signal: options.signal || entry.controller?.signal }),
      navigate, navigateTarget(detail) {
        if (detail.view === 'focus') navigate('focus', detail);
        else document.dispatchEvent(new CustomEvent('daily:navigate-canvas', { detail }));
      },
      async bindTask(task) {
        if (!available().includes('focus')) { hiddenPageNotice(); return; }
        const service = await window.RelatumDailyLoader.focus(); if (service.bindTask(task.id, task.name, 'daily')) navigate('focus');
      },
      openSource(source) {
        if (!features.enabled('canvas.editor') || !source.canvasPath || !source.rootId) return;
        location.href = 'editor.html?file=' + encodeURIComponent(source.canvasPath) + '&taskRoot=' + encodeURIComponent(source.rootId) + (source.nodeId ? '&node=' + encodeURIComponent(source.nodeId) : '');
      },
    };
    try { entry.api = window[config.factory](root, host); }
    catch (error) { entry.scopes.forEach(scope => scope.destroy()); root.remove(); throw error; }
    instances.set(id, entry); window.RelatumI18n?.apply?.(root); return entry;
  }
  async function beforeLeave() {
    if (composing?.isConnected) {
      composing.blur();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (composing?.isConnected) return false;
    }
    const entry = instances.get(current);
    return !entry || await entry.api.beforeLeave?.() !== false;
  }
  function deactivatePage({ freeze = false } = {}) {
    const entry = instances.get(current); if (!entry) return;
    entry.state.scrollTop = entry.root.scrollTop;
    entry.state.innerScrollTop = entry.root.querySelector('.focus-daily-scroll')?.scrollTop || 0;
    entry.front = false; entry.api.deactivate?.({ freeze }); entry.controller?.abort(); entry.root.inert = true;
    document.dispatchEvent(new CustomEvent('daily:hostchange', { detail: {} }));
  }
  function navigate(id, params = {}) {
    if (!active || !available().includes(id)) {
      if (pages[id] && !available().includes(id)) hiddenPageNotice();
      return Promise.resolve(false);
    }
    const expected = ++sequence;
    sliderTarget = id; queueSlider();
    navigation = navigation.catch(() => false).then(async () => {
      if (!active || expected !== sequence || !available().includes(id)) return false;
      if (current === id && instances.get(id)?.front && !Object.keys(params).length) return true;
      if (!await beforeLeave()) return false;
      if (!active || expected !== sequence) return false;
      cancelWarmup();
      let entry;
      try { entry = await mount(id, expected); }
      catch (error) { if (error.name !== 'AbortError') notice(error); return false; }
      if (!active || expected !== sequence) return false;
      showPage(id, entry, expected, params);
      return true;
    });
    navigation = navigation.catch(error => { if (expected === sequence) notice(error); return false; }).then(ok => {
      if (!ok && active && expected === sequence) { sliderTarget = current; queueSlider(); }
      return ok;
    });
    return navigation;
  }
  function showPage(id, entry, expected, params = {}) {
    deactivatePage(); current = id; sliderTarget = id;
    instances.forEach((item, page) => { item.root.hidden = page !== id; item.root.inert = page !== id; item.root.setAttribute('aria-hidden', String(page !== id)); });
    element.querySelectorAll('[data-daily-page]').forEach(button => { const selected = button.dataset.dailyPage === id; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false'); });
    if (!entry) {
      stopSlider();
      element.querySelector('.daily-nav-slider')?.classList.remove('show');
      document.dispatchEvent(new CustomEvent('daily:pagechange', { detail: { page: '' } }));
      return;
    }
    entry.front = true; entry.controller = new AbortController(); entry.root.scrollTop = entry.state.scrollTop || 0;
    try { localStorage.setItem('daily:page:v1', id); } catch (_) {}
    const isCurrent = () => active && expected === sequence && current === id && entry.front;
    Promise.resolve().then(() => {
      if (!isCurrent() || !visible()) return;
      entry.scopes.forEach(scope => scope.stop());
      return activateEntry(entry);
    }).then(async () => {
      if (!isCurrent()) return;
      const scroller = entry.root.querySelector('.focus-daily-scroll');
      if (scroller) scroller.scrollTop = entry.state.innerScrollTop || 0;
      if (params.day) await entry.api.showDay?.(params.day, params.sessionId);
      if (isCurrent() && visible()) prepare();
    }).catch(error => { if (isCurrent() && error.name !== 'AbortError') notice(error); });
    document.dispatchEvent(new CustomEvent('daily:pagechange', { detail: { page: id } }));
    document.dispatchEvent(new CustomEvent('daily:hostchange', { detail: { scope: id === 'ledger' ? 'calendar' : id, root: entry.root } }));
    queueSlider();
  }
  function hiddenPageNotice() { notice(text(['此页面已隐藏，请在全局设置 → 导航中开启。', 'This page is hidden. Enable it in Settings → Navigation.'])); }
  pageLayout.configure('daily', (next, commit) => {
    const expected = ++sequence;
    cancelWarmup();
    navigation = navigation.catch(() => false).then(async () => {
      if (expected !== sequence) return false;
      const order = pageLayout.items('daily', { value: next }).map(item => item.id);
      const target = order.includes(current) ? current : order[0] || '';
      if (target === current) return commit();
      if (!await beforeLeave() || expected !== sequence) return false;
      let entry = null;
      if (target && visible()) {
        try { entry = await mount(target, expected); }
        catch (error) { if (error.name !== 'AbortError') notice(error); return false; }
      }
      if (expected !== sequence || !commit()) return false;
      showPage(entry ? target : '', entry, expected);
      return true;
    }).catch(error => { notice(error); return false; }).then(ok => {
      if (expected === sequence) { sliderTarget = current; queueSlider(true); }
      return ok;
    });
    return navigation;
  });
  function notice(error) {
    window.RelatumDailyLoader.toast(typeof error === 'string' ? error : error.message);
  }
  function activateEntry(entry) {
    if (entry.language !== window.RelatumI18n?.language) {
      window.RelatumI18n?.apply?.(entry.root); entry.language = window.RelatumI18n?.language;
    }
    const workspaceReturn = entry.workspaceReturn; entry.workspaceReturn = false;
    return entry.api.activate?.({ workspaceReturn });
  }
  function cancelRelease() {
    clearTimeout(releaseTimer); releaseTimer = 0; releaseVersion++;
  }
  function retentionMs() {
    if (!features.visibleWorkspaces(window.RelatumStartWorkspace?.layout).includes('daily')) return 0;
    return { immediate: 0, '30s': 30000, '5m': 300000, session: Infinity }[window.RelatumGlobalSystem.read().dailyRetention];
  }
  function scheduleRelease() {
    cancelRelease();
    if (active || !exitFinished || leftAt === null) return;
    const duration = retentionMs(); if (duration === Infinity) return;
    const expected = releaseVersion;
    releaseTimer = setTimeout(() => {
      if (expected === releaseVersion && !active) release();
    }, Math.max(0, duration - (Date.now() - leftAt)));
  }
  function afterLeave() {
    if (active || exitFinished) return;
    exitFinished = true; leftAt = Date.now();
    navResize?.disconnect(); navResize = null; prepared.clear();
    instances.forEach(entry => { entry.api.finalizeExitMotion?.(); entry.scopes.forEach(scope => scope.stop()); });
    scheduleRelease();
  }
  function release() {
    if (active) return;
    cancelRelease(); cancelWarmup(); leftAt = null; exitFinished = false;
    stopSlider(); navResize?.disconnect(); navResize = null;
    instances.forEach((entry, id) => { entry.api.destroy?.(); snapshots.set(id, { ...entry.state }); entry.scopes.forEach(scope => scope.destroy()); entry.root.remove(); });
    instances.clear(); prepared.clear(); element.replaceChildren(); current = ''; disposed = true;
    styles.forEach(pending => pending.then(link => link.remove()).catch(() => {})); styles.clear();
  }
  async function activate() {
    if (!active && exitFinished && leftAt !== null && Date.now() - leftAt >= retentionMs()) release();
    cancelRelease(); leftAt = null; exitFinished = false; disposed = false; active = true;
    await css('daily-workspace.css'); makeShell();
    let requested; try { requested = localStorage.getItem('daily:page:v1'); } catch (_) {}
    const query = new URLSearchParams(location.search);
    if (query.get('workspace') === 'daily' && query.has('view')) {
      const target = query.get('view');
      if (available().includes(target)) requested = target;
      else if (pages[target]) hiddenPageNotice();
      query.delete('workspace'); query.delete('view');
      history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
    }
    const target = available().includes(requested) ? requested : available()[0];
    if (!target) { showPage('', null, sequence); return true; }
    return navigate(target);
  }
  async function leave() {
    if (!await beforeLeave()) return false;
    stopSlider();
    active = false; sequence++; cancelWarmup(); deactivatePage({ freeze: true });
    instances.forEach(entry => { entry.workspaceReturn = true; });
    cancelRelease(); leftAt = null; exitFinished = false;
    return true;
  }
  function visibility() {
    cancelWarmup();
    const entry = instances.get(current);
    if (!visible()) { stopSlider(); if (entry) entry.front = false; entry?.api.deactivate?.(); entry?.controller?.abort(); }
    else if (entry) { queueSlider(true); entry.front = true; entry.controller = new AbortController(); activateEntry(entry); prepare(); }
    else if (available().length) navigate(available()[0]);
  }
  document.addEventListener('canvas:data-changed', changed);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('canvasdesktop:visibility', visibility);
  window.addEventListener('relatum:global-system', scheduleRelease);
  document.addEventListener('relatum:workspace-layout', scheduleRelease);
  window.addEventListener('pagehide', () => { pageHidden = true; active = false; sequence++; cancelWarmup(); release(); });
  window.addEventListener('pageshow', event => { pageHidden = false; if (event.persisted && window.RelatumStartWorkspace.current === 'daily') activate(); });
  document.addEventListener('relatum:languagechange', () => {
    element.querySelector('.daily-navigation')?.setAttribute('aria-label', text(['日常页面', 'Daily pages']));
    element.querySelectorAll('[data-daily-page]').forEach(button => { button.textContent = text(pages[button.dataset.dailyPage].label); }); queueSlider(true);
  });
  document.addEventListener('relatum:page-layout', event => {
    if (event.detail.workspace !== 'daily') return;
    cancelWarmup(); prepared.clear(); orderNavigation();
  });
  reducedMotion.addEventListener('change', () => { stopSlider(); queueSlider(true); });
  window.RelatumDailyWorkspace = Object.freeze({ activate, leave, navigate, release, afterLeave, get current() { return current; } });
})();

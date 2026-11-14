(function () {
  'use strict';
  const element = document.querySelector('#start-daily-workspace');
  const features = window.RelatumFeatureRuntime;
  const pageLayout = window.RelatumPageLayout;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const narrowNavigation = matchMedia('(max-width: 700px)');
  const pageTurnDelay = 40;
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
  let active = false, current = '', releaseTimer = 0, leavingWorkspace = false;
  let releaseVersion = 0, leftAt = null, exitFinished = false;
  let warmup = null, dataVersion = 0, pending = null, pageHidden = false;
  let composing = null, inputVersion = 0, retiring = null;
  let sliderTarget = '', sliderFrame = 0, sliderRestore = 0, sliderInstant = false, sliderReady = false, navResize = null;
  let wheelAccum = 0, wheelResetTimer = 0;
  element.addEventListener('input', () => { inputVersion++; }, true);
  element.addEventListener('compositionstart', event => {
    if (!visible()) return;
    composing = event.target;
    stopPreparation(pending);
    if (instances.get(current)?.motion?.kind === 'preview') restorePage(true);
  }, true);
  element.addEventListener('compositionend', event => {
    if (composing !== event.target) return;
    composing = null;
    if (pending) scheduleNavigation(pending, pageTurnDelay);
  }, true);
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
    const animations = new Set();
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
          if (!alive || (foreground && (!visible() || root.hidden || root.inert))) return;
          callback.call(target, event);
        };
        registrations.set(key, listener);
        target.addEventListener(type, listener, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: controller.signal });
      },
      setTimeout(callback, delay, ...args) { if (!alive) return 0; const id = window.setTimeout(() => { timers.delete(id); if (alive) callback(...args); }, delay); timers.add(id); return id; },
      clearTimeout(id) { timers.delete(id); window.clearTimeout(id); },
      requestAnimationFrame(callback) { if (!alive) return 0; const id = window.requestAnimationFrame(time => { frames.delete(id); if (alive) callback(time); }); frames.add(id); return id; },
      cancelAnimationFrame(id) { frames.delete(id); window.cancelAnimationFrame(id); },
      animate(target, keyframes, options, { hold = false } = {}) {
        const animation = target.animate(keyframes, options);
        animations.add(animation);
        animation.addEventListener('cancel', () => animations.delete(animation), { once: true });
        if (!hold) animation.addEventListener('finish', () => {
          animations.delete(animation);
          if (animation.playState === 'finished') animation.cancel();
        }, { once: true });
        return animation;
      },
      resumeMotion() { animations.forEach(animation => { if (animation.playState === 'paused') animation.play(); }); },
      clearMotion() { animations.forEach(animation => animation.cancel()); animations.clear(); },
      stop({ freeze = false } = {}) {
        timers.forEach(window.clearTimeout); timers.clear(); frames.forEach(window.cancelAnimationFrame); frames.clear();
        if (freeze) animations.forEach(animation => { if (animation.playState === 'running') animation.pause(); });
        else scope.clearMotion();
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
  function syncNavigationSelection(id) {
    element.querySelectorAll('[data-daily-page]').forEach(button => {
      const selected = button.dataset.dailyPage === id;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  function makeShell() {
    if (element.firstElementChild) { observeNavigation(); orderNavigation(); return; }
    const nav = document.createElement('nav'); nav.className = 'daily-navigation'; nav.setAttribute('aria-label', text(['日常页面', 'Daily pages']));
    for (const { id } of pageLayout.items('daily', { includeHidden: true })) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.dailyPage = id;
      button.textContent = text(pages[id].label); button.addEventListener('click', () => requestPage(id, {}, pageTurnDelay)); nav.append(button);
    }
    const slider = document.createElement('span'), track = document.createElement('span');
    slider.className = 'daily-nav-slider'; slider.setAttribute('aria-hidden', 'true'); track.className = 'daily-nav-slider-track';
    available().forEach(() => track.append(document.createElement('span'))); slider.append(track); nav.prepend(slider);
    nav.addEventListener('pointerdown', event => {
      if (composing?.isConnected && event.target.closest('button')) event.preventDefault();
    });
    nav.addEventListener('keydown', event => {
      const horizontal = narrowNavigation.matches;
      const previousKey = horizontal ? 'ArrowLeft' : 'ArrowUp', nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll('button:not([hidden])')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === nextKey ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      if (!composing?.isConnected) buttons[next]?.focus();
      if (buttons[next]) requestPage(buttons[next].dataset.dailyPage, {}, pageTurnDelay);
    });
    const stage = document.createElement('div');
    stage.className = 'daily-stage';
    element.append(nav, stage);
    const turnWithWheel = event => {
      if (!visible() || leavingWorkspace || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey
        || Math.abs(event.deltaX) > Math.abs(event.deltaY) || element.classList.contains('focus-zen')) return;
      if (!nav.contains(event.target)) {
        if (narrowNavigation.matches || nav.hidden
          || !(event.target === stage || event.target === instances.get(current)?.root)) return;
        const left = stage.getBoundingClientRect().left;
        if (event.clientX < left || event.clientX >= left + 16) return;
      }
      const order = available(), index = order.indexOf(sliderTarget || current);
      const direction = Math.sign(event.deltaY);
      if (!direction || index < 0) return;
      event.preventDefault();
      if (wheelAccum && Math.sign(wheelAccum) !== direction) wheelAccum = 0;
      wheelAccum += event.deltaY;
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => { wheelAccum = 0; wheelResetTimer = 0; }, 200);
      if (Math.abs(wheelAccum) < 24) return;
      wheelAccum = 0;
      const next = order[index + direction];
      if (next) requestPage(next, {}, pageTurnDelay);
    };
    nav.addEventListener('wheel', turnWithWheel, { passive: false });
    stage.addEventListener('wheel', turnWithWheel, { passive: false });
    observeNavigation();
    orderNavigation();
  }
  function observeNavigation() {
    const nav = element.querySelector('.daily-navigation');
    if (!nav || navResize) return;
    navResize = new ResizeObserver(() => queueSlider(true)); navResize.observe(nav);
    nav.querySelectorAll('button').forEach(button => navResize.observe(button));
  }
  async function mount(id, signal) {
    if (signal.aborted) throw signal.reason;
    if (instances.has(id)) return instances.get(id);
    const config = pages[id];
    for (const src of config.styles || []) { await css(src); if (signal.aborted) throw signal.reason; }
    await css('daily-' + id + '.css');
    for (const src of config.scripts) {
      if (signal.aborted) throw signal.reason;
      await window.RelatumDailyLoader.script(src, ready[src] || (() => window[config.factory]));
    }
    let markup = '';
    if (id === 'tasks' || id === 'focus') {
      const response = await fetch('daily-' + id + '.html', { signal });
      if (!response.ok) throw new Error(text(['页面模板加载失败', 'Could not load the page template']));
      markup = await response.text();
    }
    if (signal.aborted) throw signal.reason;
    if (instances.has(id)) return instances.get(id);
    const root = document.createElement('section'); root.className = 'daily-page daily-page-' + id;
    root.dataset.role = config.role; root.hidden = true; root.inert = true; root.setAttribute('aria-hidden', 'true');
    if (id === 'tasks') root.classList.add('focus-view-daily');
    if (id === 'calendar') root.classList.add('calendar-shell');
    if (id === 'ledger') root.classList.add('ledger-shell');
    root.innerHTML = markup;
    element.querySelector('.daily-stage').append(root);
    const entry = { root, controller: null, api: null, scopes: [], front: false, workspaceReturn: false, motion: null,
      language: window.RelatumI18n?.language, state: snapshots.get(id) || {} };
    const host = {
      element, state: entry.state, isActive: () => visible() && entry.front && current === id,
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
    return await instances.get(current)?.api.beforeLeave?.() !== false;
  }
  const restFrame = { opacity: 1, transform: 'none' };
  const turnDistance = 42;
  const translate = x => 'translate3d(' + x + 'px,0,0)';
  const speed = (name, fallback) => parseFloat(document.documentElement.style.getPropertyValue(name)) || fallback;
  const canAnimate = () => visible() && !reducedMotion.matches && typeof element.animate === 'function';
  function pageFrame(entry) {
    if (!entry.motion) return restFrame;
    const style = getComputedStyle(entry.root);
    return { opacity: Number(style.opacity), transform: style.transform };
  }
  function clearPageMotion(entry) {
    const motion = entry.motion;
    entry.motion = null;
    motion?.animation?.cancel();
    if (motion?.onEnd) entry.root.removeEventListener('animationend', motion.onEnd);
    entry.root.removeAttribute('data-daily-motion');
  }
  function playPageMotion(entry, kind, frames, duration, easing, finish) {
    clearPageMotion(entry);
    const animation = entry.root.animate(frames, { duration, easing, fill: 'both' });
    const motion = entry.motion = { kind, animation };
    animation.finished.then(() => {
      if (entry.motion === motion) finish?.();
    }, () => {});
  }
  function finishEntrance(entry) {
    clearPageMotion(entry);
    if (pending?.id && pending.id !== current && entry === instances.get(current)) previewPage();
  }
  function playEntrance(entry, direction, frame) {
    if (frame) {
      playPageMotion(entry, 'enter', [frame, restFrame], speed('--start-turn-ms', 210), 'cubic-bezier(.42,0,.58,1)', () => finishEntrance(entry));
      return;
    }
    const motion = entry.motion = { kind: 'enter', onEnd(event) {
      if (event.target === entry.root && entry.motion === motion && /^startViewEnter/.test(event.animationName)) finishEntrance(entry);
    } };
    entry.root.addEventListener('animationend', motion.onEnd);
    entry.root.dataset.dailyMotion = direction > 0 ? 'forward' : 'back';
  }
  function previewPage() {
    const entry = instances.get(current);
    if (!entry?.front || !canAnimate() || composing?.isConnected || entry.motion?.kind === 'preview') return;
    const from = pageFrame(entry);
    if (from.opacity <= .78) return;
    const duration = Math.max(120, Math.min(220, Math.round(speed('--start-turn-ms', 210) * .65)));
    playPageMotion(entry, 'preview', [from, { ...from, opacity: .78 }], duration, 'cubic-bezier(.4,0,.2,1)');
  }
  function restorePage(instant = false) {
    const entry = instances.get(current);
    if (!entry?.motion) return;
    if (instant || !canAnimate()) clearPageMotion(entry);
    else if (entry.motion.kind === 'preview') {
      playPageMotion(entry, 'recover', [pageFrame(entry), restFrame], 120, 'cubic-bezier(.22,1,.36,1)', () => clearPageMotion(entry));
    }
  }
  function clearInnerMotion(entry) {
    entry.api.finalizeExitMotion?.();
    entry.scopes.forEach(scope => scope.clearMotion());
    entry.root.classList.remove('daily-motion-frozen');
  }
  function hidePage(entry) {
    if (retiring === entry) retiring = null;
    entry.root.hidden = true;
    clearPageMotion(entry);
    clearInnerMotion(entry);
  }
  function holdRetiring(target) {
    const animation = retiring?.motion?.animation;
    if (!animation || animation.playState === 'finished') return;
    if (instances.get(target) === retiring) animation.pause();
    else if (animation.playState === 'paused') animation.play();
  }
  function finishSubpageMotion() {
    restorePage(true);
    if (retiring) hidePage(retiring);
  }
  function publishHost(id, entry) {
    document.dispatchEvent(new CustomEvent('daily:hostchange', {
      detail: entry ? { scope: id === 'ledger' ? 'calendar' : id, root: entry.root } : {},
    }));
  }
  function deactivatePage({ freeze = false } = {}) {
    const entry = instances.get(current); if (!entry?.front) return;
    entry.state.scrollTop = entry.root.scrollTop;
    entry.state.innerScrollTop = entry.root.querySelector('.focus-daily-scroll')?.scrollTop || 0;
    if (freeze) entry.root.classList.add('daily-motion-frozen');
    entry.front = false; entry.api.deactivate?.({ freeze }); entry.controller?.abort(); entry.controller = null;
    entry.root.inert = true; entry.root.setAttribute('aria-hidden', 'true');
    if (!freeze) clearInnerMotion(entry);
    publishHost();
  }
  function stopPreparation(request) {
    if (!request) return;
    clearTimeout(request.timer);
    request.controller?.abort();
    request.controller = null;
  }
  function settleNavigation(ok) {
    const request = pending;
    pending = null;
    stopPreparation(request);
    request?.resolve(ok);
  }
  function cancelNavigation(instant = true) {
    settleNavigation(false);
    sliderTarget = current;
    if (instant) finishSubpageMotion();
    else { holdRetiring(''); restorePage(); }
    queueSlider(instant);
  }
  function scheduleNavigation(request, delay) {
    if (composing?.isConnected) return;
    if (request.id !== current) previewPage();
    request.timer = setTimeout(() => prepareNavigation(request), delay);
  }
  async function prepareNavigation(request) {
    if (pending !== request || !visible()) return;
    const controller = request.controller = new AbortController();
    const { id, params, commitLayout, order } = request;
    const valid = () => pending === request && !controller.signal.aborted && visible();
    let ok = false;
    try {
      const changing = id !== current || (!!id && !instances.get(id)?.front);
      let entry = instances.get(id);
      if (changing) {
        // The editor stays live while preparing. Commit only after saving its latest input.
        let savedInput;
        do {
          savedInput = inputVersion;
          if (!await beforeLeave() || !valid()) return;
          if (id && !entry) entry = await mount(id, controller.signal);
          if (!valid()) return;
        } while (savedInput !== inputVersion);
      }
      if (commitLayout && !commitLayout()) return;
      if (changing) showPage(id, entry, params, Math.sign(order.indexOf(id) - request.previousIndex) || 1);
      else if (entry && params.day) locateDay(entry, params);
      ok = true;
    } catch (error) {
      if (valid() && error.name !== 'AbortError') notice(error);
    } finally {
      if (valid()) {
        if (ok) settleNavigation(true);
        else cancelNavigation(false);
      }
    }
  }
  function requestPage(id, params, delay, { order = available(), commitLayout } = {}) {
    if (!visible() || leavingWorkspace || (id && !order.includes(id))) {
      if (pages[id] && !available().includes(id)) hiddenPageNotice();
      return Promise.resolve(false);
    }
    const hasParams = !!Object.keys(params).length;
    if (pending?.id === id && !hasParams && !commitLayout && !pending.commitLayout) return pending.promise;
    if (current === id && instances.get(id)?.front && !hasParams && !commitLayout) {
      if (pending) cancelNavigation(false);
      return Promise.resolve(true);
    }
    settleNavigation(false);
    const previous = instances.get(current);
    if (previous) previous.action = null;
    const currentIndex = order.indexOf(current);
    const request = { id, params, commitLayout, order, previousIndex: currentIndex < 0 ? available().indexOf(current) : currentIndex };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    pending = request;
    sliderTarget = id; queueSlider();
    if (id === current) restorePage(false);
    holdRetiring(id);
    scheduleNavigation(request, delay);
    return request.promise;
  }
  function navigate(id, params = {}) {
    return pages[id] ? requestPage(id, params, 0) : Promise.resolve(false);
  }
  function locateDay(entry, params, afterActivation = entry.activation) {
    const controller = entry.controller;
    const action = entry.action = {};
    const isCurrent = () => entry.action === action && entry.front && entry.controller === controller && visible();
    Promise.resolve(afterActivation).then(() => {
      if (isCurrent()) return entry.api.showDay?.(params.day, params.sessionId, { isCurrent });
    }).catch(error => { if (isCurrent() && error.name !== 'AbortError') notice(error); });
  }
  function showPage(id, entry, params = {}, direction = 1) {
    cancelWarmup();
    const previous = instances.get(current);
    const change = previous && previous !== entry && !previous.root.hidden;
    const animate = change && previous.front && canAnimate();
    const resume = !!entry && canAnimate() && entry.root.classList.contains('daily-motion-frozen');
    const incoming = resume && retiring === entry ? pageFrame(entry) : null;
    const outgoing = animate ? pageFrame(previous) : null;
    if (retiring) {
      if (retiring === entry) { clearPageMotion(entry); retiring = null; }
      else hidePage(retiring);
    }
    const restoreFocus = previous?.root.contains(document.activeElement);
    if (previous?.front) deactivatePage({ freeze: !!animate });
    if (change) {
      if (animate) {
        retiring = previous;
        playPageMotion(previous, 'exit', [outgoing, { opacity: 0, transform: translate(-direction * turnDistance) }],
          speed('--start-turn-leave-ms', 193), 'cubic-bezier(.42,0,.58,1)', () => hidePage(previous));
      } else hidePage(previous);
    }
    current = id; sliderTarget = id;
    syncNavigationSelection(id);
    if (!entry) {
      stopSlider();
      element.querySelector('.daily-nav-slider')?.classList.remove('show');
      document.dispatchEvent(new CustomEvent('daily:pagechange', { detail: { page: '' } }));
      return;
    }
    entry.root.hidden = false;
    entry.root.scrollTop = entry.state.scrollTop || 0;
    if (animate) playEntrance(entry, direction, incoming);
    const activation = startEntry(entry, { resumeMotion: resume });
    if (params.day) locateDay(entry, params, activation);
    if (restoreFocus) element.querySelector('[data-daily-page="' + id + '"]')?.focus({ preventScroll: true });
    try { localStorage.setItem('daily:page:v1', id); } catch (_) {}
    document.dispatchEvent(new CustomEvent('daily:pagechange', { detail: { page: id } }));
    publishHost(id, entry);
    queueSlider();
  }
  function hiddenPageNotice() { notice(text(['此页面已隐藏，请在全局设置 → 导航中开启。', 'This page is hidden. Enable it in Settings → Navigation.'])); }
  pageLayout.configure('daily', (next, commit) => {
    const order = pageLayout.items('daily', { value: next }).map(item => item.id);
    if (order.includes(current) || !visible()) return commit();
    if (composing?.isConnected) return false;
    return requestPage(order[0] || '', {}, 0, { order, commitLayout: commit });
  });
  function notice(error) {
    window.RelatumDailyLoader.toast(typeof error === 'string' ? error : error.message);
  }
  function startEntry(entry, { resumeMotion = false } = {}) {
    if (resumeMotion) {
      entry.root.classList.remove('daily-motion-frozen');
      entry.scopes.forEach(scope => scope.resumeMotion());
    } else clearInnerMotion(entry);
    if (entry.language !== window.RelatumI18n?.language) {
      window.RelatumI18n?.apply?.(entry.root); entry.language = window.RelatumI18n?.language;
    }
    entry.root.inert = false; entry.root.setAttribute('aria-hidden', 'false');
    entry.front = true; const controller = entry.controller = new AbortController();
    const workspaceReturn = entry.workspaceReturn; entry.workspaceReturn = false;
    const isCurrent = () => entry.controller === controller && entry.front && visible();
    const scroller = entry.root.querySelector('.focus-daily-scroll');
    if (scroller) scroller.scrollTop = entry.state.innerScrollTop || 0;
    const pendingScroll = scroller && entry.state.innerScrollTop > scroller.scrollTop;
    const activation = Promise.resolve().then(() => {
      if (isCurrent()) return entry.api.activate?.({ workspaceReturn, resumeMotion });
    }).then(() => {
      if (isCurrent()) {
        if (pendingScroll && !scroller.scrollTop) scroller.scrollTop = entry.state.innerScrollTop;
        prepare();
      }
    }).catch(error => { if (isCurrent() && error.name !== 'AbortError') notice(error); });
    entry.activation = activation;
    return activation;
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
    instances.forEach(clearInnerMotion);
    scheduleRelease();
  }
  function release() {
    if (active) return;
    cancelRelease(); cancelWarmup(); leftAt = null; exitFinished = false;
    cancelNavigation();
    stopSlider(); navResize?.disconnect(); navResize = null;
    instances.forEach((entry, id) => { clearPageMotion(entry); entry.api.destroy?.(); snapshots.set(id, { ...entry.state }); entry.scopes.forEach(scope => scope.destroy()); entry.root.remove(); });
    instances.clear(); prepared.clear(); element.replaceChildren(); current = '';
    styles.forEach(pending => pending.then(link => link.remove()).catch(() => {})); styles.clear();
  }
  async function activate() {
    if (!active && exitFinished && leftAt !== null && Date.now() - leftAt >= retentionMs()) release();
    cancelRelease(); leftAt = null; exitFinished = false; active = true;
    await css('daily-workspace.css');
    if (!active) return false;
    makeShell();
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
    if (!target) { showPage('', null); return true; }
    return navigate(target);
  }
  async function leave() {
    leavingWorkspace = true;
    cancelNavigation(false);
    try {
      let savedInput;
      do {
        savedInput = inputVersion;
        if (!await beforeLeave()) return false;
      } while (savedInput !== inputVersion);
    } finally { leavingWorkspace = false; }
    if (!active) return true;
    cancelNavigation();
    stopSlider(); cancelWarmup(); deactivatePage({ freeze: canAnimate() }); active = false;
    instances.forEach(entry => { entry.workspaceReturn = true; });
    cancelRelease(); leftAt = null; exitFinished = false;
    return true;
  }
  function visibility() {
    cancelWarmup();
    const entry = instances.get(current);
    if (!visible()) {
      cancelNavigation();
      composing = null; stopSlider(); deactivatePage();
      if (entry) clearInnerMotion(entry);
    } else if (entry && available().includes(current)) {
      queueSlider(true);
      if (!entry.front) {
        startEntry(entry);
        publishHost(current, entry);
      }
    } else if (available().length) navigate(available()[0]);
    else if (entry) showPage('', null);
  }
  document.addEventListener('canvas:data-changed', changed);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('canvasdesktop:visibility', visibility);
  window.addEventListener('relatum:global-system', scheduleRelease);
  document.addEventListener('relatum:workspace-layout', scheduleRelease);
  window.addEventListener('pagehide', () => { pageHidden = true; visibility(); active = false; release(); });
  window.addEventListener('pageshow', event => { pageHidden = false; if (event.persisted && window.RelatumStartWorkspace.current === 'daily') activate(); });
  document.addEventListener('relatum:languagechange', () => {
    element.querySelector('.daily-navigation')?.setAttribute('aria-label', text(['日常页面', 'Daily pages']));
    element.querySelectorAll('[data-daily-page]').forEach(button => { button.textContent = text(pages[button.dataset.dailyPage].label); }); queueSlider(true);
  });
  document.addEventListener('relatum:page-layout', event => {
    if (event.detail.workspace !== 'daily') return;
    if (pending?.id && !available().includes(pending.id)) cancelNavigation();
    cancelWarmup(); prepared.clear(); orderNavigation();
    if (visible() && !available().includes(current)) {
      const target = available()[0];
      if (target) navigate(target);
      else showPage('', null);
    }
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      finishSubpageMotion();
      instances.forEach(clearInnerMotion);
    }
    stopSlider(); sliderTarget = pending?.id || current; queueSlider(true);
  });
  window.RelatumDailyWorkspace = Object.freeze({ activate, leave, navigate, release, afterLeave, get current() { return current; } });
})();

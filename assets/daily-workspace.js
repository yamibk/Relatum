(function () {
  'use strict';
  const element = document.querySelector('#start-daily-workspace');
  const features = window.RelatumFeatureRuntime;
  const pages = {
    tasks: { label: ['每日任务', 'Daily tasks'], factory: 'RelatumDailyTasks', scripts: ['daily-tasks.js'], role: 'focus-view' },
    calendar: { label: ['日历', 'Calendar'], factory: 'RelatumDailyCalendar', scripts: ['markdown.js', 'mermaid-renderer.js', 'start-sticky-notes.js', 'calendar.js'], role: 'calendar-shell' },
    focus: { label: ['专注', 'Focus'], factory: 'RelatumDailyFocus', scripts: ['focus-service.js', 'start-sticky-notes.js', 'focus.js'], role: 'focus-view' },
    ledger: { label: ['记账', 'Ledger'], factory: 'RelatumDailyLedger', scripts: ['study-palette.js', 'ledger-model.js', 'start-sticky-notes.js', 'ledger.js'], role: 'ledger-shell' },
  };
  const ready = { 'markdown.js': () => window.MarkdownMini, 'mermaid-renderer.js': () => window.MermaidRenderer,
    'study-palette.js': () => window.RelatumStudyPalette, 'ledger-model.js': () => window.RelatumLedgerModel,
    'focus-service.js': () => window.RelatumFocusService, 'start-sticky-notes.js': () => window.RelatumStartPageNotes };
  const instances = new Map(), snapshots = new Map(), prepared = new Map(), styles = new Map();
  let active = false, current = '', sequence = 0, disposed = false, releaseTimer = 0;
  let warmup = null, dataVersion = 0, navigation = Promise.resolve(true), pageHidden = false;
  let composing = null;
  element.addEventListener('compositionstart', event => { composing = event.target; }, true);
  element.addEventListener('compositionend', event => { if (composing === event.target) composing = null; }, true);
  const visible = () => active && !pageHidden && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1';
  const available = () => Object.keys(pages).filter(id => features.enabled('daily.' + id));
  const text = pair => pair[window.RelatumI18n?.language === 'en' ? 1 : 0];
  function createScope(root) {
    const controller = new AbortController(), timers = new Set(), frames = new Set();
    let alive = true;
    const scope = {
      get alive() { return alive; },
      listen(target, type, callback, options) { target.addEventListener(type, callback, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: controller.signal }); },
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
    if (!visible() || features.preloadEnabled === false) return;
    const controller = warmup = new AbortController(), version = dataVersion;
    (async () => {
      for (const [feature, path] of [['tasks', '/api/daily'], ['focus', '/api/focus']]) {
        if (!features.enabled('daily.' + feature) || current === feature || prepared.has(path)) continue;
        await window.RelatumWorkspaceRuntime.preparation().waitForIdle(controller.signal);
        if (!visible() || version !== dataVersion) return;
        const json = await read(path, { signal: controller.signal });
        if (!controller.signal.aborted && visible() && version === dataVersion) prepared.set(path, json);
      }
    })().catch(() => {}).finally(() => { if (warmup === controller) warmup = null; });
  }
  function makeShell() {
    if (element.firstElementChild) return;
    const nav = document.createElement('nav'); nav.className = 'daily-navigation'; nav.setAttribute('aria-label', text(['日常页面', 'Daily pages']));
    for (const id of available()) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.dailyPage = id;
      button.textContent = text(pages[id].label); button.addEventListener('click', () => navigate(id)); nav.append(button);
    }
    nav.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll('button')], index = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus(); if (buttons[next]) navigate(buttons[next].dataset.dailyPage);
    });
    const stage = document.createElement('div'); stage.className = 'daily-stage'; element.append(nav, stage);
  }
  async function mount(id, expected) {
    if (instances.has(id)) return instances.get(id);
    const config = pages[id];
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
    const entry = { root, controller: null, api: null, scopes: [], front: false, state: snapshots.get(id) || {} };
    const host = {
      element, state: entry.state, isActive: () => visible() && current === id,
      toast: notice,
      createScope() { const scope = createScope(root); entry.scopes.push(scope); return scope; },
      read: (path, options = {}) => read(path, { ...options, signal: options.signal || entry.controller?.signal }),
      navigate, navigateTarget(detail) {
        if (detail.view === 'focus') navigate('focus', detail);
        else document.dispatchEvent(new CustomEvent('daily:navigate-canvas', { detail }));
      },
      async bindTask(task) { const service = await window.RelatumDailyLoader.focus(); if (service.bindTask(task.id, task.name, 'daily')) navigate('focus'); },
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
    const expected = ++sequence;
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
      deactivatePage(); current = id;
      instances.forEach((item, page) => { item.root.hidden = page !== id; item.root.inert = page !== id; item.root.setAttribute('aria-hidden', String(page !== id)); });
      element.querySelectorAll('[data-daily-page]').forEach(button => { const selected = button.dataset.dailyPage === id; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false'); });
      entry.front = true; entry.controller = new AbortController(); entry.root.scrollTop = entry.state.scrollTop || 0;
      try { localStorage.setItem('daily:page:v1', id); } catch (_) {}
      const isCurrent = () => active && expected === sequence && current === id && entry.front;
      Promise.resolve().then(() => {
        if (!isCurrent()) return;
        entry.scopes.forEach(scope => scope.stop());
        return entry.api.activate?.();
      }).then(async () => {
        if (!isCurrent()) return;
        const scroller = entry.root.querySelector('.focus-daily-scroll');
        if (scroller) scroller.scrollTop = entry.state.innerScrollTop || 0;
        if (params.day) await entry.api.showDay?.(params.day, params.sessionId);
        if (isCurrent() && visible()) prepare();
      }).catch(error => { if (isCurrent() && error.name !== 'AbortError') notice(error); });
      document.dispatchEvent(new CustomEvent('daily:pagechange', { detail: { page: id } }));
      document.dispatchEvent(new CustomEvent('daily:hostchange', { detail: { scope: id === 'ledger' ? 'calendar' : id, root: entry.root } }));
      return true;
    });
    return navigation;
  }
  function notice(error) {
    window.RelatumDailyLoader.toast(typeof error === 'string' ? error : error.message);
  }
  function release() {
    if (active) return;
    instances.forEach((entry, id) => { entry.api.destroy?.(); snapshots.set(id, { ...entry.state }); entry.scopes.forEach(scope => scope.destroy()); entry.root.remove(); });
    instances.clear(); prepared.clear(); element.replaceChildren(); current = ''; disposed = true;
    styles.forEach(pending => pending.then(link => link.remove()).catch(() => {})); styles.clear();
  }
  async function activate() {
    clearTimeout(releaseTimer); disposed = false; active = true;
    await css('daily-workspace.css'); makeShell();
    let requested; try { requested = localStorage.getItem('daily:page:v1'); } catch (_) {}
    const query = new URLSearchParams(location.search);
    if (query.get('workspace') === 'daily' && available().includes(query.get('view'))) {
      requested = query.get('view'); query.delete('workspace'); query.delete('view');
      history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
    }
    return navigate(available().includes(requested) ? requested : available()[0]);
  }
  async function leave() {
    if (!await beforeLeave()) return false;
    active = false; sequence++; cancelWarmup(); deactivatePage({ freeze: true });
    return true;
  }
  function visibility() {
    cancelWarmup();
    const entry = instances.get(current);
    if (!visible()) { if (entry) entry.front = false; entry?.api.deactivate?.(); entry?.controller?.abort(); }
    else if (entry) { entry.front = true; entry.controller = new AbortController(); entry.api.activate?.(); prepare(); }
  }
  document.addEventListener('canvas:data-changed', changed);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('canvasdesktop:visibility', visibility);
  window.addEventListener('pagehide', () => { pageHidden = true; active = false; sequence++; cancelWarmup(); release(); });
  window.addEventListener('pageshow', event => { pageHidden = false; if (event.persisted && window.RelatumStartWorkspace.current === 'daily') activate(); });
  document.addEventListener('relatum:languagechange', () => element.querySelectorAll('[data-daily-page]').forEach(button => { button.textContent = text(pages[button.dataset.dailyPage].label); }));
  window.RelatumDailyWorkspace = Object.freeze({ activate, leave, navigate, release,
    afterLeave() { clearTimeout(releaseTimer); releaseTimer = setTimeout(release, 0); }, get current() { return current; } });
})();

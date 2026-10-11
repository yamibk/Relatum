/* One foreground owner per document tree. Independent of Career/preloading. */
(function () {
  'use strict';
  if (window.RelatumUsage) return;
  try {
    if (window.parent !== window && window.parent.RelatumUsage) {
      window.RelatumUsage = window.parent.RelatumUsage;
      return;
    }
  } catch (_) { /* An unrelated external frame cannot own this document. */ }

  const categories = ['notes', 'canvas', 'embedded', 'research', 'study', 'tree', 'quicknotes', 'review', 'checkin'];
  const owners = { notes: 'notes', canvas: 'canvas.editor', embedded: 'notes.canvas', research: 'research', study: 'canvas.study', tree: 'canvas.tree', quicknotes: 'canvas.quicknotes', review: 'canvas.review', checkin: 'canvas.focus' };
  const labels = { notes: ['笔记', 'Notes'], canvas: ['画布', 'Canvas'], embedded: ['笔记内嵌画布', 'Embedded canvases'], research: ['研究', 'Research'], study: ['学习', 'Learning'], tree: ['树状', 'Trees'], quicknotes: ['速记', 'Quick notes'], review: ['复习', 'Review'], checkin: ['打卡', 'Check-ins'] };
  const queuePrefix = 'canvas:usageQueue:v2:';
  let owner;
  try { owner=sessionStorage.getItem('relatum:usage-owner');if(!owner){owner=window.crypto?.randomUUID?.()||String(Date.now())+Math.random();sessionStorage.setItem('relatum:usage-owner',owner);} } catch (_) { owner=String(Date.now())+Math.random(); }
  const queueKey = queuePrefix + owner;
  const settingsKey = 'canvas:usageTracking:v2';
  let queue = [], settings = {}, ready = false, active = [], cursor = 0, probeAt = 0;
  let sending = null, retry = 0, timer = 0, disposed = false, explicit = null, bootEpoch = 0;
  const uuid = () => window.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const enabledFeature = (c) => window.RelatumFeatures?.features?.[owners[c]] !== false || (c==='canvas'&&window.RelatumFeatures?.features?.['canvas.library']===true);
  const english = () => (window.RelatumI18n?.language || document.documentElement.lang) === 'en';
  try {
    const saved=JSON.parse(localStorage.getItem(queueKey)||'{}');queue=Array.isArray(saved.items)?saved.items:[];
    const keys=Object.keys(localStorage).filter(k=>k.startsWith(queuePrefix)&&k!==queueKey);
    for(const key of keys){const pending=JSON.parse(localStorage.getItem(key)||'{}');if(pending.closed||Date.now()-(pending.at||0)>120000){queue.push(...(pending.items||[]));localStorage.removeItem(key);}}
  } catch (_) {}
  function persist() {
    try { if(queue.length)localStorage.setItem(queueKey, JSON.stringify({items:queue,at:Date.now(),closed:disposed}));else localStorage.removeItem(queueKey); } catch (_) { /* In-memory retries still work when storage is full. */ }
  }
  function target() {
    if (explicit) return [explicit];
    const workspace = document.documentElement.dataset.startWorkspace || document.body.dataset.startWorkspace;
    if (workspace === 'career') return [];
    if (workspace === 'notes') {
      const path = window.CanvasNoteWorkspace?.usagePath ?? window.CanvasNoteWorkspace?.currentPath ?? '';
      const result = [{ category: 'notes', locator: path, name: path.split('/').pop() || 'notes' }];
      const embed = window.RelatumNoteCanvas?.usageTarget?.();
      if (embed?.path) result.push({ category: 'embedded', locator: embed.path, name: embed.path.split('/').pop() });
      return result;
    }
    if (workspace === 'research') {
      const frame = document.querySelector('.research-workspace iframe');
      let page;
      try { page = frame?.contentWindow?.RelatumResearchUsageTarget; } catch (_) {}
      return [{ category: 'research', locator: page?.id || '', name: page?.title || 'research' }];
    }
    if (workspace === 'canvas') {
      const view = document.querySelector('[data-role="book-view"]')?.dataset.viewName || document.querySelector('.book-view')?.dataset.viewName || '';
      const category = { study: 'study', tree: 'tree', notes: 'quicknotes', review: 'review' }[view];
      // The focus clock and diary are deliberately outside usage collection.
      if(category)return [{category,locator:'',name:category}];
      return view==='recent'||view==='cadence'?[{category:'canvas',locator:'',name:'canvas'}]:[];
    }
    if (!workspace && window.RelatumResearchUsageTarget) {
      const page=window.RelatumResearchUsageTarget;
      return [{category:'research',locator:page.id,name:page.title||page.id}];
    }
    return [];
  }
  const signature = (list) => JSON.stringify(list);
  function capture(now) {
    if (!cursor || !active.length) return;
    if(probeAt && (now-probeAt>15000||now<probeAt)){cursor=now;return;}
    const duration = now - cursor;
    if (duration > 0 && duration <= 45000) {
      for (const item of active) queue.push({ type: 'interval', id: uuid(), ...item, start: cursor, end: now });
      persist();
    }
    cursor = now;
  }
  function sync() {
    if (!ready || disposed) return;
    const now = Date.now();
    // A suspended OS/event loop must never turn the elapsed sleep into time.
    if (probeAt && (now - probeAt > 15000 || now < probeAt)) cursor = 0;
    probeAt = now;
    const next = !document.hidden && document.documentElement.dataset.desktopMinimized!=='1' && document.hasFocus()
      ? target().filter((t) => enabledFeature(t.category) && settings[t.category] !== false) : [];
    if (signature(next) !== signature(active)) {
      capture(now);
      active = next;
      cursor = next.length ? now : 0;
      flush(false).catch(() => {});
    } else if (cursor && now - cursor >= 30000) {
      capture(now);
      flush(false).catch(() => {});
    } else if (!cursor && next.length) cursor = now;
    updateControls();
  }
  async function flush(keepalive = false) {
    if (sending) { await sending; return flush(keepalive); }
    if (retry) { clearTimeout(retry); retry = 0; }
    if (!queue.length) return true;
    const bodyFor=items=>JSON.stringify({intervals:items.filter(i=>i.type==='interval').map(({type,...i})=>i),settings:items.filter(i=>i.type==='setting').map(({type,...i})=>i)});
    let items=queue.slice(0,128), body=bodyFor(items);
    // Chromium caps aggregate keepalive bodies at 64 KiB. Keep each tail
    // batch below that ceiling; unsent items remain durable for the next open.
    while(items.length>1&&new TextEncoder().encode(body).length>52000){items=items.slice(0,Math.ceil(items.length/2));body=bodyFor(items);}
    sending = (async () => {
      try {
        const response = await fetch('/api/usage/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive,
          body
        });
        if (!response.ok) throw new Error('Usage queue pending');
        const result = await response.json();
        queue.splice(0, items.length);
        settings = result.settings || settings;
        queue.filter(i=>i.type==='setting').forEach(i=>{settings[i.category]=i.enabled;});
        persist();
        try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (_) {}
        updateControls();
        return true;
      } finally { sending = null; }
    })();
    try {
      const result = await sending;
      if (queue.length) return await flush(keepalive);
      return result;
    } catch (error) {
      if (!disposed) retry = setTimeout(() => { retry = 0; flush(false).catch(() => {}); }, 5000);
      throw error;
    }
  }
  function pause(close = false) {
    const now = Date.now();
    if (!probeAt || now - probeAt <= 15000) capture(now);
    active = []; cursor = 0;
    flush(true).catch(() => {});
    if (close) { disposed = true; ready = false; bootEpoch++; clearInterval(timer); clearTimeout(retry); timer = retry = 0; persist(); }
  }
  function updateControls() {
    document.querySelectorAll('[data-usage-category]').forEach(input => {
      const category = input.dataset.usageCategory;
      input.checked = settings[category] !== false;
      input.disabled = !ready || !enabledFeature(category);
      const label = input.closest('label')?.querySelector('span');
      if (label) label.textContent = labels[category][english() ? 1 : 0];
      input.closest('label').hidden = !enabledFeature(category);
    });
    document.querySelectorAll('[data-usage-heading]').forEach(el => { el.textContent = english() ? 'Usage statistics' : '使用统计'; });
    document.querySelectorAll('[data-usage-help]').forEach(el => { el.textContent = english() ? 'Record foreground reading and work. Turning a category off preserves its history.' : '记录前台阅读与工作时间。关闭分类后保留已有历史。'; });
  }
  function controls() {
    const panel = document.querySelector('[data-usage-panel]');
    const gear = document.querySelector('[data-role="start-speed-pop"]');
    if (panel && gear && panel.parentElement !== gear) gear.append(panel);
    document.querySelectorAll('[data-usage-settings]').forEach(host => {
      if (host.dataset.ready) return;
      host.dataset.ready = 'true';
      for (const category of categories) {
        const label = document.createElement('label'); label.className = 'start-setting-row';
        const text = document.createElement('span'), input = document.createElement('input');
        input.type = 'checkbox'; input.dataset.usageCategory = category;
        input.addEventListener('change', () => {
          const now = Date.now(); capture(now);
          settings[category] = input.checked;
          queue.push({ type: 'setting', category, enabled: input.checked, at: now });
          persist(); sync(); flush(false).catch(() => {});
        });
        label.append(text, input); host.append(label);
      }
    });
    updateControls();
  }
  async function boot() {
    const epoch = ++bootEpoch;
    controls();
    try {
      const response = await fetch('/api/usage/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('Usage state pending');
      const state = await response.json();
      if (disposed || epoch !== bootEpoch) return;
      settings = state.settings;
      // Deleting the new database deliberately starts a new journal. A queued
      // setting from before that origin must not block all later time batches.
      queue=queue.filter(item=>item.type!=='setting'||item.at>=state.since);persist();
      // Replay locally pending choices before accepting any new interval.
      queue.filter(i => i.type === 'setting').forEach(i => { settings[i.category] = i.enabled; });
      ready = true; sync(); timer = setInterval(sync, 5000);
      flush(false).catch(() => {});
    } catch (_) { if (!disposed && epoch === bootEpoch) retry = setTimeout(boot, 5000); }
  }
  window.RelatumUsage = Object.freeze({
    sync,
    setTarget(value) { capture(Date.now()); explicit = value; active = []; cursor = 0; sync(); },
    async flush() { capture(Date.now()); await flush(false); return true; },
    waitForIdle() { return this.flush().then(() => true, () => false); },
    resetSettings(){const now=Date.now();capture(now);for(const category of categories){if(enabledFeature(category)){settings[category]=true;queue.push({type:'setting',category,enabled:true,at:now});}}persist();sync();flush(false).catch(()=>{});},
    get pending() { return queue.length; },
    get settings() { return { ...settings }; }
  });
  window.RelatumStartPageActivity = window.RelatumUsage;
  ['start:viewchange', 'relatum:start-workspacechange', 'relatum:usage-target'].forEach(name => document.addEventListener(name, sync));
  document.addEventListener('relatum:languagechange', updateControls);
  document.addEventListener('visibilitychange', () => document.hidden ? pause() : sync());
  window.addEventListener('focus', sync);
  window.addEventListener('canvasdesktop:visibility',event=>event.detail?.minimized?pause():sync());
  window.addEventListener('blur', () => setTimeout(() => document.hasFocus() ? sync() : pause(), 0));
  window.addEventListener('pagehide', () => pause(true));
  window.addEventListener('pageshow', () => { if (disposed) { disposed = false; boot(); } });
  window.addEventListener('online', () => flush(false).catch(() => {}));
  window.addEventListener('storage', event => {
    if (event.key === settingsKey && event.newValue) {
      capture(Date.now());
      try { settings = JSON.parse(event.newValue); } catch (_) {}
      sync();
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

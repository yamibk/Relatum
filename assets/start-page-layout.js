// Lightweight page identities and preferences. Does not load page runtimes.
(function () {
  'use strict';
  const features = window.RelatumFeatureRuntime;
  const keys = { canvas: 'canvas:pageOrder:v1', daily: 'daily:pageOrder:v1' };
  const legacyKey = 'canvas:hideSpecialPages';
  const hosts = new Map(), queues = new Map();
  const canvas = [
    ['review', '复习', 'Review', 'canvas.review'], ['cadence', '活跃', 'Activity', 'canvas.activity'],
    ['notes', '速记', 'Quick notes', 'canvas.quicknotes'], ['tree', '树状', 'Tree', 'canvas.tree'],
    ['study', '学习', 'Study', 'canvas.study'], ['recent', '最近', 'Recent', 'canvas.library'],
    ['favorites', '收藏', 'Favorites', 'canvas.library'], ['inbox', '未分组', 'Ungrouped', 'canvas.library'],
  ];
  const daily = [
    ['tasks', '每日任务', 'Daily tasks', 'daily.tasks'], ['calendar', '日历', 'Calendar', 'daily.calendar'],
    ['focus', '专注', 'Focus', 'daily.focus'], ['ledger', '记账', 'Ledger', 'daily.ledger'],
  ];
  let groups = null;
  const descriptors = workspace => {
    const source = (workspace === 'canvas' ? canvas : daily).map(([id, zh, en, feature]) => ({ id, label: [zh, en], feature }));
    if (workspace === 'canvas' && groups) source.splice(source.length - 1, 0, ...groups.map(group => ({
      id: 'group:' + group.id, label: [group.name, group.name], feature: 'canvas.library', groupId: group.id,
    })));
    return source;
  };
  function stored(workspace) {
    try { return JSON.parse(localStorage.getItem(keys[workspace])); } catch (_) { return null; }
  }
  function normalize(workspace, raw, legacy = true) {
    const defaults = descriptors(workspace).map(item => item.id), known = new Set(defaults);
    const valid = id => typeof id === 'string' && (known.has(id)
      || (workspace === 'canvas' && groups === null && id.startsWith('group:') && id.length > 6));
    const order = Array.isArray(raw?.order) ? [...new Set(raw.order.filter(valid))] : [], seen = new Set(order);
    defaults.forEach(id => { if (!seen.has(id)) { order.push(id); seen.add(id); } });
    let hidden = Array.isArray(raw?.hidden) ? raw.hidden.filter(valid) : [];
    if (workspace === 'canvas' && legacy && !Array.isArray(raw?.hidden) && features.enabled('canvas.library')) {
      try { if (localStorage.getItem(legacyKey) === '1') hidden = canvas.slice(0, 5).map(item => item[0]); } catch (_) {}
    }
    return { order, hidden: [...new Set(hidden)] };
  }
  const layout = workspace => normalize(workspace, stored(workspace));
  function items(workspace, { includeHidden = false, value = layout(workspace) } = {}) {
    const byId = new Map(descriptors(workspace).map(item => [item.id, item])), hidden = new Set(value.hidden);
    return value.order.map(id => byId.get(id)).filter(item => item && features.enabled(item.feature)
      && (includeHidden || !hidden.has(item.id)));
  }
  function isVisible(workspace, id, value = layout(workspace)) {
    if (!value.order.includes(id) || value.hidden.includes(id)) return false;
    const descriptor = descriptors(workspace).find(item => item.id === id);
    return descriptor ? features.enabled(descriptor.feature)
      : workspace === 'canvas' && groups === null && id.startsWith('group:') && features.enabled('canvas.library');
  }
  function syncBoot() {
    for (const workspace of ['canvas', 'daily']) {
      const value = layout(workspace);
      const known = new Map(descriptors(workspace).map(item => [item.id, item.feature])), hidden = new Set(value.hidden);
      if (document.documentElement) document.documentElement.dataset[workspace + 'PagesEmpty'] =
        value.order.some(id => !hidden.has(id) && (known.has(id) ? features.enabled(known.get(id))
          : workspace === 'canvas' && groups === null && id.startsWith('group:') && features.enabled('canvas.library'))) ? '0' : '1';
    }
  }
  const canPreload = (workspace, id) => isVisible(workspace, id)
    && features.visibleWorkspaces?.().includes(workspace) !== false;
  function publish(workspace) {
    syncBoot();
    document.dispatchEvent(new CustomEvent('relatum:page-layout', { detail: { workspace } }));
  }
  function apply(workspace, value, { reset = false } = {}) {
    if (!keys[workspace]) return Promise.resolve(false);
    const pending = (queues.get(workspace) || Promise.resolve()).catch(() => false).then(async () => {
      const next = normalize(workspace, reset ? null : value, !reset), previous = layout(workspace);
      const saved = new Map();
      try {
        saved.set(keys[workspace], localStorage.getItem(keys[workspace]));
        if (workspace === 'canvas') saved.set(legacyKey, localStorage.getItem(legacyKey));
      } catch (_) { return false; }
      let committed = false;
      const restore = () => saved.forEach((raw, key) => { if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw); });
      const commit = () => {
        if (committed) return true;
        try {
          if (reset) localStorage.removeItem(keys[workspace]);
          else localStorage.setItem(keys[workspace], JSON.stringify(next));
          if (workspace === 'canvas') localStorage.removeItem(legacyKey);
          committed = true; return true;
        } catch (_) { try { restore(); } catch (_) {} return false; }
      };
      let ok = false;
      try { ok = hosts.has(workspace) ? await hosts.get(workspace)(next, commit, previous) !== false : commit(); } catch (_) {}
      if (!ok || !committed) {
        if (committed) { try { restore(); } catch (_) {} publish(workspace); }
        return false;
      }
      publish(workspace); return true;
    });
    queues.set(workspace, pending); return pending;
  }
  function setGroups(value) {
    const next = value.map(group => ({ id: String(group.id), name: String(group.name) }));
    if (groups && groups.length === next.length && groups.every((group, index) => group.id === next[index].id && group.name === next[index].name)) return;
    groups = next; publish('canvas');
  }
  function routeId(route) {
    if (route.view !== 'library') return route.view;
    return route.groupId === '__favorites__' ? 'favorites' : route.groupId === '__inbox__' ? 'inbox'
      : route.groupId ? 'group:' + route.groupId : 'recent';
  }
  function route(id) {
    if (id === 'recent' || id === 'favorites' || id === 'inbox' || id.startsWith('group:')) {
      return { view: 'library', groupId: id === 'favorites' ? '__favorites__' : id === 'inbox' ? '__inbox__' : id === 'recent' ? '' : id.slice(6) };
    }
    return { view: id };
  }
  window.RelatumPageLayout = Object.freeze({ keys: Object.freeze(keys), layout, items, isVisible, canPreload, apply, setGroups, routeId, route,
    configure(workspace, transition) { hosts.set(workspace, transition); } });
  syncBoot();
})();

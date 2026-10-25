// Lightweight page identities and preferences. Does not load page runtimes.
(function () {
  'use strict';
  const features = window.RelatumFeatureRuntime;
  const keys = { canvas: 'canvas:pageOrder:v1', daily: 'daily:pageOrder:v1' };
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
  function normalize(workspace, raw) {
    const defaults = descriptors(workspace).map(item => item.id), known = new Set(defaults);
    const valid = id => typeof id === 'string' && (known.has(id)
      || (workspace === 'canvas' && groups === null && id.startsWith('group:') && id.length > 6));
    const order = Array.isArray(raw?.order) ? [...new Set(raw.order.filter(valid))] : [], seen = new Set(order);
    defaults.forEach(id => { if (!seen.has(id)) { order.push(id); seen.add(id); } });
    return { order };
  }
  const layout = workspace => normalize(workspace, stored(workspace));
  function items(workspace) {
    const byId = new Map(descriptors(workspace).map(item => [item.id, item]));
    return layout(workspace).order.map(id => byId.get(id)).filter(item => item && features.enabled(item.feature));
  }
  function publish(workspace) {
    document.dispatchEvent(new CustomEvent('relatum:page-layout', { detail: { workspace } }));
  }
  function apply(workspace, value, { reset = false } = {}) {
    if (!keys[workspace]) return false;
    try {
      if (reset) localStorage.removeItem(keys[workspace]);
      else localStorage.setItem(keys[workspace], JSON.stringify(normalize(workspace, value)));
    } catch (_) { return false; }
    publish(workspace); return true;
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
  window.RelatumPageLayout = Object.freeze({ keys: Object.freeze(keys), layout, items, apply, setGroups, routeId, route });
})();

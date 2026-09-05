(function (root) {
  'use strict';

  // Internal change sets only; neither snapshots nor .canvas files acquire new fields.
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }

  const SETS = ['nodeIds', 'edgeIds', 'contentNodeIds', 'addedNodeIds', 'removedNodeIds'];
  const FLAGS = ['topology', 'taskbook', 'ink', 'ruler', 'timers'];
  const NODE_TOPOLOGY = ['kind', 'shapeType', 'groupMemberIds', 'groupCollapsed', 'mindmapCollapsed', 'textBindTarget', 'taskRootId'];
  const EDGE_TOPOLOGY = ['from', 'to', 'arrow', 'taskRootId'];
  function changedFields(a, b, fields) {
    return fields.some((key) => !equal(a[key], b[key]));
  }

  function diff(before, after) {
    before = before || {};
    after = after || {};
    const change = {};
    SETS.forEach((key) => { change[key] = new Set(); });
    FLAGS.forEach((key) => { change[key] = key === 'topology' ? false : !equal(before[key], after[key]); });
    ['nodes', 'edges'].forEach((kind) => {
      const previous = new Map((before[kind] || []).map((item) => [item.id, item]));
      if ((after[kind] || []).some((item, index) => !before[kind] || !before[kind][index] || before[kind][index].id !== item.id)) {
        change.topology = true;
      }
      const ids = kind === 'nodes' ? change.nodeIds : change.edgeIds;
      (after[kind] || []).forEach((item) => {
        const old = previous.get(item.id);
        previous.delete(item.id);
        if (equal(old, item)) return;
        ids.add(item.id);
        if (!old || changedFields(old, item, kind === 'nodes' ? NODE_TOPOLOGY : EDGE_TOPOLOGY)) change.topology = true;
        if (kind === 'nodes') {
          if (old && old.strike !== item.strike) change.taskbook = true;
          if (!old) change.addedNodeIds.add(item.id);
          if (!old || changedFields(old, item, Array.from(new Set(Object.keys(old).concat(Object.keys(item)))).filter((key) => key !== 'x' && key !== 'y'))) {
            change.contentNodeIds.add(item.id);
          }
        }
      });
      previous.forEach((item, id) => {
        ids.add(id);
        change.topology = true;
        if (kind === 'nodes') change.removedNodeIds.add(id);
      });
    });
    return change;
  }

  function merge(a, b) {
    if (!a) return b;
    SETS.forEach((key) => b[key].forEach((id) => a[key].add(id)));
    FLAGS.forEach((key) => { a[key] = a[key] || b[key]; });
    return a;
  }

  function restoreRecords(current, saved, clone) {
    const previous = new Map(current.map((item) => [item.id, item]));
    return saved.map((item) => {
      const old = previous.get(item.id);
      if (equal(old, item)) return old;
      const copy = clone(item);
      if (!old) return copy;
      // DOM listeners close over these records. Preserve identity while replacing all saved
      // fields, and never share mutable marks/waypoints with an undo snapshot.
      Object.keys(old).forEach((key) => { if (!Object.prototype.hasOwnProperty.call(copy, key)) delete old[key]; });
      Object.assign(old, copy);
      return old;
    });
  }

  const api = { equal, diff, merge, restoreRecords };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumCanvasChanges = api;
})(typeof window === 'object' ? window : null);

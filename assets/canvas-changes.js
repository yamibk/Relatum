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

  function restoreRecords(current, saved, clone, changedIds) {
    const previous = new Map(current.map((item) => [item.id, item]));
    return saved.map((item) => {
      const old = previous.get(item.id);
      if (old && changedIds && !changedIds.has(item.id)) return old;
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

  // A single detached head plus bounded entity patches. Unrelated ink is never visited
  // by a scoped node transaction. Unknown callers deliberately retain snapshot fallback.
  function createHistory(initial, options) {
    options = options || {};
    const clone = options.clone;
    let head = initial;
    const past = [], future = [];
    const limit = Math.max(1, (options.limit || 50) - 1);
    function copyChanges(change) {
      const copy = merge(diff({}, {}), change);
      ['strokesIds', 'arrowsIds'].forEach(function (key) { if (change[key]) copy[key] = new Set(change[key]); });
      return copy;
    }
    function commit(state, scope) {
      const before = head;
      let next, patch;
      if (!scope) {
        next = clone.state(state);
        patch = { before: before, after: next };
      } else {
        next = Object.assign({}, head);
        patch = { tables: {}, fields: {} };
        ['nodes', 'edges', 'timers', 'strokes', 'arrows'].forEach(function (kind) {
          const ink = kind === 'strokes' || kind === 'arrows';
          const hint = scope[kind] || (ink && scope.ink);
          if (!hint) return;
          const old = (ink ? head.ink && head.ink[kind] : head[kind]) || [];
          const live = (ink ? state.ink && state.ink[kind] : state[kind]) || [];
          const byId = new Map(old.map(function (item) { return [item.id, item]; }));
          const records = [], changes = [];
          live.forEach(function (item) {
            const saved = byId.get(item.id);
            byId.delete(item.id);
            const touched = hint === true || hint.has(item.id);
            if (saved && (!touched || equal(saved, item))) records.push(saved);
            else {
              const copy = clone[kind](item);
              changes.push([item.id, saved || null, copy]);
              records.push(copy);
            }
          });
          byId.forEach(function (item, id) { changes.push([id, item, null]); });
          const reordered = old.length !== live.length || old.some(function (item, i) { return item.id !== live[i].id; });
          if (!changes.length && !reordered) return;
          patch.tables[kind] = { records: changes, beforeOrder: reordered ? old.map(function (item) { return item.id; }) : null,
            afterOrder: reordered ? live.map(function (item) { return item.id; }) : null };
          if (ink) {
            if (next.ink === head.ink) next.ink = Object.assign({}, head.ink);
            next.ink[kind] = records;
          } else next[kind] = records;
        });
        ['ruler', 'taskbook'].forEach(function (kind) {
          if (scope[kind] && !equal(head[kind], state[kind])) {
            next[kind] = clone[kind](state[kind]);
            patch.fields[kind] = [head[kind], next[kind]];
          }
        });
      }
      const changes = diff(before, next);
      if (patch.tables) ['strokes', 'arrows'].forEach(function (kind) {
        changes[kind + 'Ids'] = new Set(patch.tables[kind] ? patch.tables[kind].records.map(function (record) { return record[0]; }) : []);
      });
      patch.changes = changes;
      head = next;
      past.push(patch);
      if (past.length > limit) past.shift();
      future.length = 0;
      return copyChanges(changes);
    }
    function apply(patch, forward) {
      if (patch.before) head = forward ? patch.after : patch.before;
      else {
        const next = Object.assign({}, head);
        Object.keys(patch.tables).forEach(function (kind) {
          const ink = kind === 'strokes' || kind === 'arrows';
          const table = patch.tables[kind];
          const current = (ink ? head.ink && head.ink[kind] : head[kind]) || [];
          const byId = new Map(current.map(function (item) { return [item.id, item]; }));
          table.records.forEach(function (record) {
            const value = record[forward ? 2 : 1];
            if (value) byId.set(record[0], value); else byId.delete(record[0]);
          });
          const order = table[forward ? 'afterOrder' : 'beforeOrder'];
          const records = order ? order.map(function (id) { return byId.get(id); }) : Array.from(byId.values());
          if (ink) { if (next.ink === head.ink) next.ink = Object.assign({}, head.ink); next.ink[kind] = records; }
          else next[kind] = records;
        });
        Object.keys(patch.fields).forEach(function (kind) { next[kind] = patch.fields[kind][forward ? 1 : 0]; });
        head = next;
      }
      // Reverse additions/removals for reconcile and geometry invalidation.
      const change = copyChanges(patch.changes);
      if (!forward) {
        const added = change.addedNodeIds;
        change.addedNodeIds = change.removedNodeIds;
        change.removedNodeIds = added;
      }
      return { snapshot: head, changes: change };
    }
    return {
      commit: commit,
      undo: function () { if (!past.length) return null; const patch = past.pop(); future.push(patch); return apply(patch, false); },
      redo: function () { if (!future.length) return null; const patch = future.pop(); past.push(patch); return apply(patch, true); },
      head: function () { return head; },
      refresh: function (key, value) { head = Object.assign({}, head); head[key] = value; },
      reset: function (state) { head = state; past.length = future.length = 0; },
      canUndo: function () { return !!past.length; }, canRedo: function () { return !!future.length; },
    };
  }

  const api = { equal, diff, merge, restoreRecords, createHistory };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumCanvasChanges = api;
})(typeof window === 'object' ? window : null);

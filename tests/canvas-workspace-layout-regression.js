'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function functionSource(source, name) {
  const start = source.indexOf('  function ' + name + '(');
  assert(start >= 0, name);
  const open = source.indexOf('{', start);
  let depth = 0, quote = '';
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(name + ' boundary');
}
for (const filename of ['tree-page.js', 'study-route.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../assets', filename), 'utf8');
  for (const hz of [60, 120, 144, 240]) for (const translate of [true, false]) {
    let time = 100, nextId = 1;
    const frames = new Map(), writes = new Map(), nodeElements = new Map(), edgeElements = new Map();
    const previous = { nodes: Array.from({ length: 1200 }, (_, i) => ({ id: String(i), x: i % 40 * 150, y: Math.floor(i / 40) * 90, width: 120, height: 60 })),
      edges: Array.from({ length: 1199 }, (_, i) => ({ from: String(i), to: String(i + 1) })) };
    previous.nodes.forEach(node => nodeElements.set(node.id, { style: new Proxy({}, { set(target, key, value) {
      writes.set(node.id, (writes.get(node.id) || 0) + 1); target[key] = value; return true;
    } }) }));
    previous.edges.forEach(edge => {
      const attrs = {}; edgeElements.set(edge.from + '>' + edge.to, { getAttribute: key => attrs[key], setAttribute(key, value) { attrs[key] = value; } });
    });
    const css = { supports: () => translate };
    const context = { nodeElements, edgeElements, visualPlacements: new Map(), layoutFrame: 0, prefersReduced: false,
      window: { CSS: css }, CSS: css, performance: { now: () => time },
      edgePath: (a, b) => `${a.x},${a.y};${b.x},${b.y}`, visualEdgePath: (a, b) => `${a.x},${a.y};${b.x},${b.y}`,
      requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); } };
    vm.createContext(context);
    vm.runInContext(['placementMap', 'edgeKey', 'writeNodePosition', 'applyLayoutFrame', 'animateLayout'].map(name => functionSource(source, name)).join('\n'), context);
    context.applyLayoutFrame(previous, context.placementMap(previous.nodes));
    writes.clear();
    const next = JSON.parse(JSON.stringify(previous)); next.nodes[600].x += 90; next.nodes[600].y += 30;
    context.animateLayout(previous, next, 300);
    let live;
    for (let i = 1; i <= Math.ceil(hz * .3) + 1; i++) {
      time = 100 + i * 1000 / hz;
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time));
      if (live) assert.equal(context.visualPlacements, live, 'animation must reuse its work map');
      live = context.visualPlacements;
    }
    assert.equal(context.visualPlacements.get('600').x, next.nodes[600].x);
    assert.equal(context.visualPlacements.get('600').y, next.nodes[600].y);
    assert.deepEqual([...writes.keys()], ['600'], 'unchanged nodes must not receive position writes');
    assert.equal(frames.size, 0);
    const settledWrites = writes.get('600');
    context.applyLayoutFrame(next, context.visualPlacements);
    assert.equal(writes.get('600'), settledWrites, 'settled layout must not rewrite positions');
    assert.equal(next.nodes[600].x, previous.nodes[600].x + 90, 'live animation cannot mutate its target');
  }
  console.log(filename + ': dense layout, work-map reuse, translate/fallback, 60/120/144/240Hz passed');
}
const focus = fs.readFileSync(path.join(__dirname, '../assets/focus.js'), 'utf8');
const dailyGroups = Array.from({ length: 100 }, (_, i) => ({ id: 'g' + i, parentId: i ? 'g' + Math.floor((i - 1) / 4) : '' }));
const dailyTasks = Array.from({ length: 2000 }, (_, i) => ({ id: 't' + i, groupId: 'g' + (i % 100), doneToday: i % 3 === 0 }));
const context = { dailyTasks, dailyGroups, dailyGroupsById: new Map(), dailyTasksByGroup: new Map(), dailyGroupsByParent: new Map(), dailyProgressCache: new Map() };
vm.createContext(context);
vm.runInContext(['rebuildDailyIndexes', 'dailyGroupById', 'dailyChildGroups', 'dailyDirectTasks', 'dailyGroupProgress', 'dailyGroupChain', 'invalidateDailyProgress']
  .map(name => functionSource(focus, name)).join('\n'), context);
context.rebuildDailyIndexes();
dailyTasks.filter = dailyGroups.filter = dailyGroups.find = () => { throw Error('group lookup scanned full data'); };
assert.equal(context.dailyGroupProgress('g0').total, 2000);
assert.equal(context.dailyGroupProgress('g0').done, Math.ceil(2000 / 3));
const cached = context.dailyGroupProgress('g0');
assert.equal(context.dailyGroupProgress('g0'), cached);
dailyTasks[1].doneToday = true; context.invalidateDailyProgress(dailyTasks[1].groupId);
assert.equal(context.dailyGroupProgress('g0').done, cached.done + 1);
console.log('daily groups: nested 2000 tasks, indexed lookup, cached aggregation and ancestor invalidation passed');

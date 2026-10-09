'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real engine with a deterministic scheduler and a display-only backend.
function fixture() {
  let clock = 100, id = 0;
  const timers = new Map(), frames = new Map();
  const canvas = { addEventListener() {}, removeEventListener() {}, getContext() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 720 }) };
  const sandbox = { performance: { now: () => (clock += .5) }, Math, Date,
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/graph-engine.js'), 'utf8'), sandbox);
  const engine = sandbox.GraphEngine.create({ canvas, backend: () => ({ kind: 'test',
    syncSize: () => ({ width: 1200, height: 720, scale: 1 }), draw() {}, destroy() {} }),
    config: { presolveSteps: 120, alphaDecay: .001 } });
  const nodes = Array.from({ length: 120 }, (_, i) => ({ id: String(i), x: i % 12 * 20, y: Math.floor(i / 12) * 20, r: 4 }));
  const seed = nodes.map(n => [n.x, n.y]);
  engine.setData(nodes, [], { intro: true });
  function slice() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); }
  return { engine, nodes, seed, timers, frames, slice };
}
{
  const f = fixture(); f.engine.start();
  assert.equal(f.timers.size, 1, 'mount must yield before physics');
  assert.deepEqual(f.nodes.map(n => [n.x, n.y]), f.seed);
  f.slice();
  assert.equal(f.timers.size, 1, '4ms budget must split the presolve');
  assert.notDeepEqual(f.nodes.map(n => [n.x, n.y]), f.seed);
  f.engine.setActive(false);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
  assert.deepEqual(f.nodes.map(n => [n.x, n.y]), f.seed, 'cancel must restore the intro seed');
  f.engine.setActive(true); assert.equal(f.timers.size, 1);
  for (let i = 0; f.timers.size && i < 1000; i++) f.slice();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.nodes.map(n => [n.x, n.y]), f.seed);
  assert(f.nodes.every(n => n._born > 100 && !n._appeared), 'intro starts after the complete layout');
  f.engine.destroy(); assert.equal(f.frames.size, 0);
}
{
  const f = fixture(); f.engine.start(); f.slice();
  const stale = f.timers.values().next().value;
  f.engine.setData([{ id: 'new', x: 9, y: 10, r: 5 }], []); f.engine.start({ intro: false });
  const view = f.engine.view; stale();
  assert.deepEqual(f.engine.view, view, 'stale slices must not fit replacement data');
  f.engine.destroy(); assert.equal(f.timers.size, 0);
}
{
  const f = fixture(); f.engine.start(); f.slice();
  f.engine.setVisible(false); assert.equal(f.timers.size, 0);
  f.engine.setReduceMotion(true); f.engine.setVisible(true);
  assert.equal(f.timers.size, 0, 'reduced motion must not restart pending presolve');
  assert(f.nodes.every(n => n._appeared && n._appearOpacity === 1));
  f.engine.destroy(); assert.equal(f.frames.size, 0);
}
console.log('graph presolve: cooperative slices, suspend/resume, stale data, destroy and reduced motion passed');

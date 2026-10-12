'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function eventTarget() {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const items = listeners.get(type); items?.delete(fn); if (!items?.size) listeners.delete(type);
    },
    dispatch(type, event = {}) { Array.from(listeners.get(type) || []).forEach(fn => fn(event)); },
  };
}

function fixture(options = {}) {
  let clock = 100, id = 0, draws = 0;
  const timers = new Map(), frames = new Map(), captures = new Set();
  const document = { ...eventTarget(), hidden: !!options.hidden,
    documentElement: { dataset: { desktopMinimized: options.minimized ? '1' : '0' } } };
  const canvas = { ...eventTarget(), getContext() {}, clientWidth: 1200, clientHeight: 720,
    setPointerCapture(id) { captures.add(id); }, hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 720 }) };
  const sandbox = { ...eventTarget(), document, performance: { now: () => options.presolve ? (clock += .5) : clock }, Math, Date,
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/graph-engine.js'), 'utf8'), sandbox);
  const clicks = [], hovers = [];
  const engine = sandbox.GraphEngine.create({ canvas, active: options.active !== false,
    backend: () => ({ kind: 'test', syncSize: () => ({ cssW: 1200, cssH: 720, dpr: 1 }), draw() { draws++; }, destroy() {} }),
    config: { repulsion: 0, gravity: 0, alphaDecay: options.presolve ? .001 : 1, introMs: 500, introStagger: 0 },
    coalesceHover: true, drift: options.drift ? { speed: .001, amp: () => 1 } : null,
    onNodeClick: node => clicks.push(node.id), onNodeHover: node => hovers.push(node?.id || null) });
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: String(i), x: 100 + i * 20, y: 120, r: 5 }));
  engine.setData(nodes, []);
  function frame(elapsed = 20) {
    clock += elapsed;
    const jobs = Array.from(frames); frames.clear(); jobs.forEach(([, fn]) => fn(clock));
  }
  function minimize(value) {
    document.documentElement.dataset.desktopMinimized = value ? '1' : '0';
    sandbox.dispatch('canvasdesktop:visibility');
  }
  function hide(value) { document.hidden = value; document.dispatch('visibilitychange'); }
  function pointer(type, x = 2, y = 2) {
    canvas.dispatch(type, { button: 0, pointerId: 1, clientX: x, clientY: y, deltaY: -100, preventDefault() {} });
  }
  function slice() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn(); }
  return { engine, nodes, frames, timers, captures, clicks, hovers, document, sandbox,
    frame, minimize, hide, pointer, slice, get draws() { return draws; } };
}

for (const pause of ['document', 'desktop', 'pagehide']) {
  const f = fixture({ drift: true }); f.engine.start({ intro: false, fit: false }); f.frame();
  const view = { ...f.engine.view }, before = f.draws;
  const stale = f.frames.values().next().value;
  if (pause === 'document') f.hide(true);
  else if (pause === 'desktop') f.minimize(true);
  else f.sandbox.dispatch('pagehide');
  assert.equal(f.frames.size, 0, pause + ' cancels continuous frames');
  assert.equal(f.timers.size, 0);
  stale(200);
  for (let i = 0; i < 120; i++) { f.engine.requestRender(); f.pointer('pointermove', 200, 200); }
  f.engine.setVisible(true); f.engine.setActive(true); f.frame(8000);
  assert.equal(f.draws, before, pause + ' blocks late callbacks and redraw requests');
  assert.equal(f.frames.size, 0);
  if (pause === 'document') f.hide(false);
  else if (pause === 'desktop') f.minimize(false);
  else f.sandbox.dispatch('pageshow');
  assert.equal(f.frames.size, 1, 'resume queues one existing engine frame');
  f.sandbox.dispatch('canvasdesktop:visibility'); f.document.dispatch('visibilitychange');
  assert.equal(f.frames.size, 1, 'repeated visibility notifications are idempotent');
  assert.deepEqual({ ...f.engine.view }, view, 'resume preserves the camera');
  f.frame(); assert(f.draws > before); f.engine.destroy();
  assert.equal(f.frames.size, 0); assert.equal(f.document.listeners.size, 0);
  assert.equal(f.sandbox.listeners.size, 0, 'destroy removes all page/native lifecycle listeners');
}

{
  const f = fixture(); f.frame(); f.engine.requestRender();
  const before = f.draws, stale = f.frames.values().next().value;
  f.minimize(true); stale(); assert.equal(f.draws, before, 'one-shot paints cannot run after minimize');
  f.hide(true); f.minimize(false); assert.equal(f.frames.size, 0, 'native restore cannot override document hiding');
  f.engine.setActive(false); f.hide(false); assert.equal(f.frames.size, 0, 'restore cannot activate another workspace');
  f.engine.setActive(true); assert.equal(f.frames.size, 1); f.engine.destroy();
}
for (const options of [{ hidden: true }, { minimized: true }]) {
  const f = fixture(options); f.engine.start({ intro: true, fit: true });
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0, 'hidden startup defers physics and presolve');
  f.hide(false); f.minimize(false); assert.equal(f.timers.size, 1);
  f.engine.destroy(); assert.equal(f.timers.size, 0);
}
{
  const f = fixture({ presolve: true });
  const seed = f.nodes.map(node => [node.x, node.y]);
  f.engine.start({ intro: true, fit: true }); f.slice();
  const stale = f.timers.values().next().value;
  f.minimize(true); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.nodes.map(node => [node.x, node.y]), seed, 'paused presolve restores its seed');
  stale(); assert.equal(f.timers.size, 0, 'late presolve slices are discarded');
  f.minimize(false); assert.equal(f.timers.size, 1, 'resume restarts the same pending presolve');
  f.engine.destroy();
}
{
  const f = fixture(); f.engine.start({ intro: true, fit: false }); f.frame(40);
  const opacity = f.nodes[0]._appearOpacity, born = f.nodes[0]._born;
  f.minimize(true); f.frame(8000); f.minimize(false);
  assert.equal(f.nodes[0]._born, born + 8000, 'minimize freezes the current growth clock');
  f.minimize(false); assert.equal(f.nodes[0]._born, born + 8000);
  f.frame(20); assert(f.nodes[0]._appearOpacity >= opacity && f.nodes[0]._appearOpacity < .5, 'growth continues without replay or jumping to completion');
  f.engine.destroy();
}
{
  const f = fixture(); f.frame(); f.pointer('pointerdown'); f.pointer('pointermove', 20, 30);
  const view = { ...f.engine.view }; assert.equal(f.captures.size, 1);
  f.minimize(true); assert.equal(f.captures.size, 0, 'minimize releases a captured gesture');
  f.minimize(false); f.pointer('pointermove', 100, 100); f.pointer('pointerup', 100, 100);
  assert.deepEqual({ ...f.engine.view }, view, 'a suspended drag cannot continue on restore');
  assert.deepEqual(f.clicks, []); f.engine.destroy();
}
console.log('graph: native/document/page visibility, late callbacks, deferred startup, presolve, growth and gestures passed');

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
{
  const f = fixture();
  f.engine.requestRender(); assert.equal(f.frames.size, 1);
  f.engine.start();
  assert.equal(f.frames.size, 0, 'presolve supersedes a pending one-shot paint');
  assert.equal(f.timers.size, 1);
  f.engine.destroy(); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
}
// A settled graph still receives mouse events faster than the display cadence.
// Keep camera/velocity samples synchronous, but share one paint with its latest state.
function interactionFixture(labels = false, reduced = false, config = {}) {
  let clock = 100, id = 0;
  let drawHook = null;
  const frames = new Map(), listeners = new Map(), draws = [];
  const canvas = { clientWidth: 1200, clientHeight: 720, width: 1, height: 1,
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {}, getContext() {},
    setPointerCapture() {}, hasPointerCapture() { return false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 720 }) };
  const sandbox = { performance: { now: () => clock }, Math, Date, setTimeout, clearTimeout,
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/graph-engine.js'), 'utf8'), sandbox);
  const engine = sandbox.GraphEngine.create({ canvas, reduceMotion: reduced, config,
    domOverlay: labels ? { sync() {}, destroy() {} } : null,
    backend: () => ({ kind: 'test', syncSize: () => ({ cssW: 1200, cssH: 720, dpr: 1 }),
      draw(frame) {
        draws.push({ x: frame.cam.viewX, y: frame.cam.viewY, scale: frame.cam.unit });
        if (drawHook) drawHook();
      }, destroy() {} }) });
  engine.setData(Array.from({ length: 3000 }, (_, i) => ({ id: String(i), x: 10000 + i * 30, y: 10000, r: 5 })), []);
  function event(name, x, y) {
    clock += .2;
    listeners.get(name)({ button: 0, pointerId: 1, clientX: x, clientY: y, deltaY: 100, preventDefault() {} });
  }
  function frame() {
    clock += 1000 / 60;
    const jobs = Array.from(frames); frames.clear();
    jobs.forEach(([, fn]) => fn(clock));
  }
  return { engine, frames, draws, event, frame, onDraw(fn) { drawHook = fn; } };
}
for (const labels of [false, true]) {
  const f = interactionFixture(labels);
  f.event('pointerdown', 10, 10);
  for (let i = 1; i <= 120; i++) f.event('pointermove', 10 + i, 10 + i);
  assert.equal(f.draws.length, 0, 'a settled graph must not paint every input sample');
  assert.equal(f.frames.size, 1, 'a burst must queue one display frame');
  assert.equal(f.engine.view.x, -120, 'camera state must immediately preserve the final input');
  f.event('pointerup', 130, 130);
  assert.equal(f.frames.size, 1, 'label animation must reuse the pending display frame');
  f.frame();
  assert.equal(f.draws.length, 1);
  assert.deepEqual(f.draws[0], { x: -120, y: -120, scale: 1 });
  if (!labels) assert.equal(f.frames.size, 0, 'one-shot paint must not start an idle loop');
  f.engine.destroy(); assert.equal(f.frames.size, 0);
}
{
  const f = interactionFixture();
  f.engine.requestRender();
  const stale = f.frames.values().next().value;
  f.engine.setActive(false);
  assert.equal(f.frames.size, 0, 'deactivation must cancel a pending one-shot paint');
  stale(); assert.equal(f.draws.length, 0, 'an old paint callback cannot render a hidden graph');
  f.engine.setActive(true); f.engine.requestRender();
  assert.equal(f.frames.size, 1, 'reactivation and an explicit paint must share one frame');
  f.engine.setVisible(false); assert.equal(f.frames.size, 0);
  f.engine.setVisible(true); f.engine.requestRender();
  assert.equal(f.frames.size, 1);
  f.engine.destroy(); assert.equal(f.frames.size, 0);
  stale(); assert.equal(f.draws.length, 0, 'destroyed graphs cannot paint late');
}
{
  const f = interactionFixture();
  f.engine.requestRender(); f.engine.heat(.32);
  for (let i = 0; i < 120; i++) f.engine.requestRender();
  assert.equal(f.frames.size, 1, 'the physics loop supersedes one-shot paints');
  f.onDraw(() => { f.onDraw(null); f.engine.requestRender(); f.engine.heat(.32); });
  f.frame(); assert.equal(f.draws.length, 1);
  assert.equal(f.frames.size, 1, 'reentrant render/animation requests share the next physics frame');
  f.engine.destroy(); assert.equal(f.frames.size, 0);
}
{
  const f = interactionFixture(false, true);
  for (let i = 0; i < 12; i++) f.event('wheel', 600, 360);
  assert.equal(f.draws.length, 0, 'reduced-motion zoom also batches painting');
  assert.equal(f.frames.size, 1);
  const finalView = f.engine.view;
  f.frame(); assert.equal(f.draws.length, 1); assert.equal(f.frames.size, 0);
  assert.equal(f.engine.view.x, finalView.x); assert.equal(f.engine.view.y, finalView.y);
  f.engine.destroy();
}
{
  const f = interactionFixture(false, false, { alphaDecay: 1 });
  f.engine.start({ intro: false, fit: true });
  f.frame();
  assert.equal(f.draws.length, 1);
  assert.equal(f.frames.size, 1, 'auto-fit at convergence cannot queue a second animation frame');
  f.frame(); assert.equal(f.draws.length, 2);
  assert.equal(f.frames.size, 1);
  f.engine.destroy();
}
for (const stop of ['inactive', 'hidden', 'destroy']) {
  const f = interactionFixture();
  f.engine.heat(.32);
  f.onDraw(() => {
    f.onDraw(null);
    if (stop === 'inactive') f.engine.setActive(false);
    else if (stop === 'hidden') f.engine.setVisible(false);
    else f.engine.destroy();
    f.engine.requestRender(); f.engine.heat(.32);
  });
  f.frame(); assert.equal(f.draws.length, 1);
  assert.equal(f.frames.size, 0, stop + ' during drawing must prevent any next frame');
  f.engine.destroy();
}
console.log('graph: presolve, latest-frame painting, animation handoff, lifecycle and reduced motion passed');

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/graph-engine.js'), 'utf8');

function fixture(config = {}, size = [1600, 1000], options = {}) {
  let clock = 100, id = 0, settled = 0;
  const frames = new Map(), timers = new Map(), resizes = [], draws = [], listeners = new Map();
  const canvas = { clientWidth: size[0], clientHeight: size[1], getContext() {},
    addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); }, hasPointerCapture: () => false,
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; } };
  const sandbox = { Math, Date, performance: { now: () => clock },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { constructor(fn) { resizes.push(fn); } observe() {} disconnect() {} } };
  sandbox.window = sandbox; vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const engine = sandbox.GraphEngine.create({ canvas, ...options,
    config: { zoomMin: .04, zoomMax: 3.5, fitScaleMin: .04, fitScaleMax: 3.5, ...config },
    onLayoutSettled() { settled++; }, getEdgeRest: edge => edge.rest,
    backend: () => ({ kind: 'test', syncSize: () => ({ cssW: canvas.clientWidth, cssH: canvas.clientHeight, dpr: 1 }),
      draw(state) { draws.push({ view: { ...engine.view }, unit: state.cam.unit }); }, destroy() {} }) });
  function frame() {
    clock += 1000 / 60;
    const jobs = [...frames.values()]; frames.clear(); jobs.forEach(fn => fn(clock));
  }
  function finish() { for (let i = 0; frames.size && i < 1000; i++) frame(); assert.equal(frames.size, 0); }
  return { engine, canvas, frames, timers, draws, frame, finish, resize: () => resizes.forEach(fn => fn()), settled: () => settled,
    doubleClick: event => listeners.get('dblclick')(event), wheel: event=>listeners.get('wheel')(event) };
}
const readable = { fitUnitMin: .8, fitUnitMax: 1.2, fitCenter: 'median' };
function unit(f) { return Math.min(f.canvas.clientWidth / 1200, f.canvas.clientHeight / 720) * f.engine.view.scale; }
function center(f) { const v = f.engine.view; return [v.x + 600 / v.scale, v.y + 360 / v.scale]; }
function close(a, b) { assert(Math.abs(a - b) < 1e-7, `${a} != ${b}`); }

// The screen policy depends on CSS size, not DPR or far-away outliers.
for (const size of [[1600, 1000], [600, 600]]) {
  const f = fixture(readable, size);
  f.engine.setData([{ x: 500, y: 300, r: 6 }, { x: 600, y: 400, r: 6 }, { x: 1e6, y: -1e6, r: 6 }], []);
  f.engine.fitView(false); close(unit(f), .8); assert.deepEqual(center(f), [600, 300]);
  f.engine.restoreView({ x: 1e6, y: 1e6, scale: .04 });
  f.doubleClick({ clientX: 5, clientY: 5, preventDefault() {}, stopPropagation() {} }); f.finish();
  close(unit(f), .8); assert.deepEqual(center(f), [600, 300], 'blank double-click shares the readable fit policy');
  f.engine.setData([{ x: 600, y: 360, r: 6 }], []); f.engine.fitView(false); close(unit(f), 1.2);
  f.engine.setData([{ x: 500, y: 300, r: 6 }, { x: 700, y: 500, r: 6 }], []);
  f.engine.fitView(false); assert.deepEqual(center(f), [600, 400]);
  const view = { ...f.engine.view }; f.canvas.clientWidth += 50; f.resize(); f.finish();
  assert.deepEqual({ ...f.engine.view }, view, 'resize does not refit an established camera');
  f.engine.destroy();
}
{
  const f = fixture(readable, [100, 100]); f.engine.setData([{ x: 600, y: 360, r: 6 }], []);
  f.engine.fitView(false); assert.equal(f.engine.view.scale, 3.5, 'tiny windows obey the zoom ceiling'); f.engine.destroy();
}
{
  const f = fixture({}, [600, 900]);
  f.engine.setData([{ x: 0, y: 0, r: 6 }, { x: 2000, y: 1000, r: 6 }], []);
  f.engine.fitView(false); close(f.engine.view.scale, Math.min(1200 / (2000 + 60 + 96), 720 / (1000 + 60 + 96)));
  assert.deepEqual(center(f), [1000, 500]); assert.equal(f.engine.layoutSpacing, 1); f.engine.destroy();
}
// An initially zero-size canvas waits for ResizeObserver, without polling RAF.
{
  const f = fixture(readable, [0, 0]); f.engine.setData([{ x: 600, y: 360, r: 6 }], [], { intro: true });
  f.engine.start(); f.finish(); assert.equal(f.timers.size, 0); assert.equal(f.draws.length, 0);
  f.canvas.clientWidth = 1600; f.canvas.clientHeight = 1000;
  f.engine.setReduceMotion(true); f.resize(); f.finish();
  close(unit(f), 1.2); assert(f.draws.length > 0); assert.equal(f.settled(), 1); f.engine.destroy();
}
{
  const f = fixture(readable, [0, 0]); f.engine.setData([{ x: 600, y: 360, r: 6 }], []);
  assert.equal(f.engine.fitView(false), false); assert.equal(f.frames.size, 0);
  f.canvas.clientWidth = 600; f.canvas.clientHeight = 600; f.resize(); f.finish(); close(unit(f), 1.2); f.engine.destroy();
}

function model(count, spacing, linked) {
  const nodes = Array.from({ length: count }, (_, i) => {
    const angle = i * 2.399963229728653, radius = 300 * spacing * Math.sqrt((i + .5) / count);
    return { x: 600 + Math.cos(angle) * radius, y: 360 + Math.sin(angle) * radius, r: 6, id: String(i) };
  });
  return { nodes, edges: linked ? Array.from({ length: 29 }, (_, i) => ({ source: i, target: i + 1, rest: 112 })) : [] };
}
// Scaling forces and seeds together scales the layout, including isolated nodes.
for (const linked of [false, true]) {
  let baseline;
  for (const spacing of [.8, 1, 1.25, 2]) {
    const f = fixture({ layoutSpacing: spacing }), { nodes, edges } = model(150, spacing, linked);
    f.engine.setData(nodes, edges); f.engine.start({ intro: false, fit: false, preserveView: true }); f.finish();
    const normalized = nodes.map(n => [(n.x - 600) / spacing, (n.y - 360) / spacing]);
    if (!baseline) baseline = normalized;
    normalized.forEach((point, i) => { close(point[0], baseline[i][0]); close(point[1], baseline[i][1]); });
    assert(nodes.every(n => n.r === 6)); assert.equal(f.settled(), 1); f.engine.destroy();
  }
}
// Rapid settings supersede entry and camera animation without replacing positions.
{
  const f = fixture(readable), { nodes, edges } = model(150, 1, true);
  f.engine.setData(nodes, edges); f.engine.restoreView({ x: 1e6, y: -1e6, scale: .04 });
  f.engine.start({ intro: true, fit: false, preserveView: true, introDelayMs: 100, introSpanMs: 3000 });
  f.frame(); const camera = { ...f.engine.view }, coordinates = nodes.map(n => [n.x, n.y]);
  for (const value of [1.25, 1.5, .8, 2, 1.25]) assert(f.engine.setLayoutSpacing(value));
  assert.equal(f.frames.size, 1); assert.deepEqual(nodes.map(n => [n.x, n.y]), coordinates);
  assert(nodes.every(n => n._appeared && n._appearOpacity === 1 && n._appearScale === 1));
  f.finish(); assert.equal(f.settled(), 1); assert(f.draws.every(d => JSON.stringify(d.view) === JSON.stringify(camera)));
  assert.equal(f.engine.setLayoutSpacing(1.25), false); assert.equal(f.frames.size, 0);
  for (const value of [NaN, Infinity, 0, -1, '1.5']) assert.equal(f.engine.setLayoutSpacing(value), false);
  assert(f.engine.setLayoutSpacing(10)); assert.equal(f.engine.layoutSpacing, 2); f.finish();
  f.engine.fitView(true); f.frame(); const duringFit = { ...f.engine.view };
  f.engine.setLayoutSpacing(1); f.finish(); assert.deepEqual({ ...f.engine.view }, duringFit);
  f.engine.destroy(); assert.equal(f.engine.setLayoutSpacing(1.25), false); assert.equal(f.frames.size, 0);
}
// A cancelled pre-layout slice cannot later move the camera or replay entry.
{
  const f = fixture(readable), { nodes, edges } = model(150, 1, true);
  f.engine.setData(nodes, edges, { intro: true }); f.engine.start();
  const stale = [...f.timers.values()][0]; assert(stale);
  const camera = { ...f.engine.view }; f.engine.setLayoutSpacing(1.25); assert.equal(f.timers.size, 0);
  stale(); f.finish(); assert.deepEqual({ ...f.engine.view }, camera); assert(nodes.every(n => n._appeared)); f.engine.destroy();
}
// The opt-in Career guard must leave every existing graph's wheel behavior intact.
for(const guarded of [false,true]){
  const f=fixture({},[1200,720],guarded?{shouldHandleWheel:event=>event.ctrlKey||event.metaKey}:{});
  f.engine.setData([{x:500,y:300,r:6}],[]);f.engine.restoreView({x:0,y:0,scale:1});f.finish();
  const camera={...f.engine.view};let prevented=0;
  const event={clientX:600,clientY:360,deltaY:-100,ctrlKey:false,metaKey:false,preventDefault(){prevented++;}};
  f.wheel(event);
  if(guarded){assert.equal(prevented,0);assert.equal(f.frames.size,0);assert.deepEqual({...f.engine.view},camera);f.wheel({...event,ctrlKey:true});}
  assert.equal(prevented,1);f.finish();assert(f.engine.view.scale>camera.scale);f.engine.destroy();
}
console.log('graph: readable CSS framing, robust centers, spacing, cancellation, optional wheel guard and zero idle RAF passed');

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real engine, attribute translation and GraphGL uploads together.
// A deterministic GL/scheduler makes skipped CPU work and buffer traffic observable.
function fixture(options = {}) {
  let clock = 100, id = 0, bufferId = 0, shaderId = 0, programId = 0;
  let boundBuffer = null, currentProgram = null, core = null, replacements = 0, glError = '';
  let nodeStyles = 0, edgeStyles = 0, positionWrites = 0, lostContexts = 0;
  const frames = new Map(), timers = new Map(), uploads = [], draws = [], overlays = [], clicks = [];
  const uniforms = new Map(), storage = new Map();
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, FLOAT: 8,
    ONE: 9, ONE_MINUS_SRC_ALPHA: 10, COLOR_BUFFER_BIT: 11, TRIANGLE_STRIP: 12,
    createShader: () => ++shaderId, shaderSource() {}, compileShader() {},
    getShaderParameter: () => !options.shaderFailure, getShaderInfoLog: () => 'driver rejected shader', deleteShader() {},
    createProgram: () => ++programId, attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram() {},
    getUniformLocation: (program, name) => program + ':' + name,
    createBuffer: () => ++bufferId, bindBuffer(target, buffer) { boundBuffer = buffer; },
    bufferData(target, data, usage) {
      storage.set(boundBuffer, Array.from(data));
      if (usage === gl.DYNAMIC_DRAW) uploads.push({ buffer: boundBuffer, length: data.length });
    }, deleteBuffer() {}, createVertexArray: () => ({}), bindVertexArray() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {}, deleteVertexArray() {},
    enable() {}, disable() {}, blendFunc() {}, clearColor() {}, viewport() {}, clear() {},
    useProgram(program) { currentProgram = program; },
    uniform4f(location, ...value) { uniforms.set(location, value); },
    uniform1f(location, value) { uniforms.set(location, value); },
    drawArraysInstanced(mode, first, count, instances) { draws.push({ program: currentProgram, instances }); },
    getExtension: () => ({ loseContext() { lostContexts++; } }),
  };
  const ctx = Object.fromEntries(['setTransform', 'clearRect', 'translate', 'scale', 'save', 'restore',
    'beginPath', 'arc', 'fill'].map(name => [name, () => {}]));
  function canvas(fresh = false) {
    const listeners = new Map();
    const element = { listeners, clientWidth: 1200, clientHeight: 720, width: 1, height: 1,
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name) { listeners.delete(name); },
      getContext(kind) { return kind === 'webgl2' ? gl : (fresh || !options.shaderFailure ? ctx : null); },
      setPointerCapture() {}, hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 720 }),
      cloneNode: () => canvas(true), replaceWith() {},
    };
    return element;
  }
  const originalCanvas = canvas();
  const sandbox = { Math, Date, devicePixelRatio: 1, performance: { now: () => clock },
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const filename of ['graph-gl.js', 'graph-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets', filename), 'utf8'), sandbox);
  }
  const makeGL = sandbox.GraphGL.create;
  sandbox.GraphGL.create = element => {
    try { return (core = makeGL(element)); }
    catch (error) { glError = error.stack; throw error; }
  };
  const engine = sandbox.GraphEngine.create({ canvas: originalCanvas, backend: 'webgl', cacheInstances: options.cache !== false,
    nodeStyleTimeDependent: !!options.timeStyle, reduceMotion: !!options.reduced,
    labelVisibility: options.legacyLabels ? undefined : 'always', domOverlayOnCanvas2D: true,
    config: { alphaDecay: 1, repulsion: 0, spring: 0, gravity: 0, introMs: 80, introStagger: 0 },
    domOverlay: { sync(state) { overlays.push(state); }, destroy() {} },
    onNodeClick(node) { clicks.push(node.id); },
    onCanvasReplace(next, previous) { replacements++; assert.equal(previous, originalCanvas); },
    nodeStyle(node, env) { nodeStyles++; return { r: node.r, fill: [1, 0, 0, env.dim ? .2 : 1],
      stroke: [0, 0, 0, 1], strokeW: 2, scale: options.timeStyle ? 1 + .04 * Math.sin(clock) : 1 }; },
    edgeStyle(edge, source, target, env) { edgeStyles++; return { color: [0, 0, 0, env.dim ? .1 : .5], width: 1.2 }; },
  });
  assert(engine, 'fixture must create an engine');
  if (!options.shaderFailure) assert.equal(engine.backendKind, 'webgl', 'mock must exercise the real GL backend: ' + glError);
  const nodes = Array.from({ length: options.count || 2 }, (_, i) => ({ id: String(i), x: 100 + i * 25, y: 120, r: 6 }));
  const edges = Array.from({ length: nodes.length - 1 }, (_, i) => ({ source: i, target: i + 1 }));
  engine.setData(nodes, edges);
  for (const node of nodes) {
    let rx = node._rx, ry = node._ry;
    Object.defineProperties(node, {
      _rx: { configurable: true, get: () => rx, set(value) { rx = value; positionWrites++; } },
      _ry: { configurable: true, get: () => ry, set(value) { ry = value; positionWrites++; } },
    });
  }
  function frame(elapsed = 1000 / 60) {
    clock += elapsed;
    const jobs = Array.from(frames); frames.clear();
    jobs.forEach(([, fn]) => fn(clock));
  }
  function drain(limit = 100) {
    for (let i = 0; frames.size && i < limit; i++) frame();
    assert.equal(frames.size, 0, 'finite animation must stop');
  }
  function event(name, x, y, extra = {}) {
    engine.canvas.listeners.get(name)({ button: 0, pointerId: 1, clientX: x, clientY: y,
      deltaY: -100, preventDefault() {}, ...extra });
  }
  function pan() { event('pointerdown', 2, 2); event('pointermove', 22, 32); event('pointerup', 22, 32); frame(); }
  function counts() {
    return { nodeStyles, edgeStyles, positionWrites, nodeUploads: uploads.filter(x => x.buffer === 3).length,
      edgeUploads: uploads.filter(x => x.buffer === 4).length };
  }
  engine.requestRender(); frame();
  return { engine, nodes, edges, frames, timers, uploads, draws, overlays, clicks, uniforms, storage, sandbox,
    originalCanvas, frame, drain, event, pan, counts, get core() { return core; },
    get replacements() { return replacements; }, get lostContexts() { return lostContexts; } };
}

for (const reduced of [false, true]) {
  const f = fixture({ count: 3000, reduced });
  const before = f.counts(), firstPositionVersion = f.overlays.at(-1).positionVersion;
  f.pan();
  assert.deepEqual(f.counts(), before, 'static panning reuses positions, styles and both GPU buffers');
  assert.equal(f.overlays.at(-1).positionVersion, firstPositionVersion);
  assert.equal(f.engine.labelAlpha, 1, 'always-visible labels stay visible while panning');
  assert.equal(f.frames.size, 0, 'static labels cannot start a fade loop');
  const firstAA = f.uniforms.get('1:uAA');
  f.event('wheel', 600, 360); f.drain();
  assert.deepEqual(f.counts(), before, 'zoom and its tween reuses static instances');
  assert(f.uniforms.get('1:uAA') < firstAA,
    'zoom updates AA independently of instance attributes: ' + firstAA + ' -> ' + f.uniforms.get('1:uAA'));
  assert.equal(f.storage.get(3)[2], 6, 'radius remains in world units');
  assert(Math.abs(f.storage.get(4)[8] - 1.2) < 1e-6, 'line width remains in world units');
  assert(f.overlays.every(state => state.labelAlpha === 1));
  f.sandbox.devicePixelRatio = 2; f.engine.resetView(); f.frame();
  assert.equal(f.uniforms.get('1:uAA'), .5, 'DPR changes AA without uploading geometry');
  assert.equal(f.engine.canvas.width, 2400);
  assert.deepEqual(f.counts(), before);
  const camera = f.engine.view;
  assert.equal(f.engine.restoreView({ x: NaN, y: 0, scale: 1 }), false);
  assert.deepEqual(f.engine.view, camera);
  assert.equal(f.engine.restoreView({ x: 70, y: -20, scale: 1.3 }), true);
  f.frame();
  assert.equal(f.engine.view.x, 70); assert.equal(f.engine.view.y, -20);
  assert.equal(f.engine.view.scale, 1.3);
  assert.deepEqual(f.counts(), before, 'restoring a session camera does not invalidate instances or positions');
  assert.equal(f.engine.restoreView({ x: 0, y: 0, scale: -1 }), false);
  f.engine.destroy(); assert.equal(f.frames.size, 0);
}
{
  const f = fixture({ timeStyle: true });
  const before = f.counts(), attributes = f.storage.get(3).slice();
  f.pan();
  assert(f.counts().nodeStyles > before.nodeStyles);
  assert.equal(f.counts().edgeStyles, before.edgeStyles, 'time-dependent node style does not reevaluate edge style');
  assert.equal(f.counts().edgeUploads, before.edgeUploads);
  assert.equal(f.counts().positionWrites, before.positionWrites);
  assert.notEqual(f.storage.get(3)[13], attributes[13], 'pulse/breath style still follows time');
  assert.equal(f.frames.size, 0, 'a time-style declaration cannot create an idle animation loop');
  f.engine.destroy();
}
{
  const f = fixture();
  const before = f.counts();
  f.event('pointerdown', 100, 120);
  f.event('pointermove', 220, 260); f.frame();
  assert.equal(f.nodes[0]._rx, 220);
  assert.equal(f.storage.get(3)[0], 220, 'dragging invalidates cached node coordinates');
  assert.equal(f.storage.get(4)[0], 220, 'dragging invalidates adjacent edge geometry');
  assert(f.counts().positionWrites > before.positionWrites);
  f.event('pointerup', 220, 260); f.drain();
  f.engine.destroy();
}
{
  const f = fixture();
  const before = f.counts();
  f.event('pointermove', 100, 120); f.frame();
  assert.equal(f.counts().nodeUploads, before.nodeUploads + 1);
  assert.equal(f.counts().edgeUploads, before.edgeUploads + 1);
  const hovered = f.counts();
  for (let i = 0; i < 100; i++) f.event('pointermove', 100, 120);
  assert.equal(f.frames.size, 0, 'same-node hover must not invalidate or paint again');
  assert.deepEqual(f.counts(), hovered);
  f.engine.requestRender(); f.frame();
  assert.equal(f.counts().nodeUploads, hovered.nodeUploads + 1, 'public request refreshes external styles');
  assert.equal(f.counts().edgeUploads, hovered.edgeUploads + 1);
  f.engine.destroy();
}
{
  const f = fixture({ legacyLabels: true });
  f.event('pointerdown', 2, 2);
  assert.equal(f.engine.labelAlpha, 0, 'original hosts retain interaction label hiding');
  f.event('pointerup', 2, 2); f.drain();
  assert(f.engine.labelAlpha > .99, 'legacy labels fade back after interaction');
  f.event('wheel', 600, 360);
  assert.equal(f.engine.labelAlpha, 0, 'original hosts also hide during zoom');
  f.drain(); assert(f.engine.labelAlpha > .99);
  f.engine.destroy();
}
{
  const f = fixture();
  const before = f.counts();
  f.engine.start({ intro: true, fit: false }); f.frame();
  assert(f.counts().nodeUploads > before.nodeUploads && f.counts().edgeUploads > before.edgeUploads);
  const earlyAlpha = f.storage.get(4)[7], during = f.counts();
  f.frame();
  assert(f.storage.get(4)[7] > earlyAlpha, 'edges follow endpoint appearance while physics is already settled');
  assert(f.counts().edgeUploads > during.edgeUploads);
  f.drain(); const settled = f.counts(); f.pan();
  assert.deepEqual(f.counts(), settled, 'after intro both buffers return to static reuse');
  f.engine.destroy();
}
{
  const f = fixture();
  const before = f.counts();
  f.engine.setDrift({ speed: .003, amp: () => 10 }); f.frame(40);
  assert.notEqual(f.nodes[0]._rx, f.nodes[0].x);
  assert(f.counts().nodeUploads > before.nodeUploads && f.counts().edgeUploads > before.edgeUploads);
  f.engine.setDrift(null); f.drain();
  assert.equal(f.nodes[0]._rx, f.nodes[0].x, 'turning off drift restores base node positions');
  assert.equal(f.storage.get(4)[0], f.nodes[0].x, 'turning off drift restores edge endpoints');
  const stopped = f.counts(); f.pan(); assert.deepEqual(f.counts(), stopped);
  f.engine.setDrift({ speed: .003, amp: () => 10 }); f.frame(40);
  f.engine.setReduceMotion(true); f.drain();
  assert.equal(f.nodes[0]._rx, f.nodes[0].x, 'reduced motion also clears cached drift');
  f.engine.destroy();
}
{
  const f = fixture();
  const before = f.counts();
  f.engine.setParticles({ speed: .001, perEdge: 1, size: 2, color: [0, 1, 0, 1] }); f.frame(40);
  assert(f.counts().nodeUploads > before.nodeUploads);
  assert.equal(f.counts().edgeUploads, before.edgeUploads, 'particles leave edge buffer untouched');
  assert(f.draws.at(-1).instances > f.nodes.length, 'particles occupy extra node instances');
  f.engine.setParticles(null); f.drain();
  assert.equal(f.draws.at(-1).instances, f.nodes.length, 'disabled particles cannot remain in cached draw count');
  f.engine.destroy();
}
{
  const f = fixture({ count: 3000 });
  const before = f.counts();
  f.core.nodeData = new Float32Array(f.core.nodeData.length);
  f.pan();
  assert.equal(f.counts().nodeUploads, before.nodeUploads + 1, 'new backing storage cannot reuse previous GPU attributes');
  assert.equal(f.storage.get(3)[0], 100);
  assert.equal(f.counts().edgeUploads, before.edgeUploads);
  f.engine.setData([{ id: 'replacement', x: 80, y: 90, r: 8 }], []);
  f.engine.requestRender(); f.frame();
  assert.equal(f.draws.at(-1).instances, 1, 'replacement data updates instance count');
  assert.equal(f.storage.get(3)[0], 80);
  f.engine.destroy();
}
{
  const f = fixture({ cache: false }); const before = f.counts(); f.pan();
  assert.equal(f.counts().nodeUploads, before.nodeUploads + 1, 'default/noncached backend retains original uploads');
  assert.equal(f.counts().edgeUploads, before.edgeUploads + 1);
  f.engine.destroy();
}
{
  const f = fixture();
  f.event('pointerdown', 100, 120);
  f.engine.setData([{ id: 'different-notebook', x: 100, y: 120, r: 8 }], []);
  f.event('pointerup', 100, 120); f.drain();
  assert.deepEqual(f.clicks, [], 'old dataset gestures cannot click a replacement notebook node');
  assert.equal(f.frames.size, 0, 'old dragged-node references cannot keep the replacement graph running');
  f.engine.destroy();
}
{
  const f = fixture({ shaderFailure: true });
  assert.equal(f.engine.backendKind, 'canvas2d');
  assert.notEqual(f.engine.canvas, f.originalCanvas, 'a WebGL-locked canvas is replaced for a real 2D fallback');
  assert.equal(f.replacements, 1);
  assert.equal(f.lostContexts, 1, 'failed WebGL context is explicitly released');
  assert.equal(f.originalCanvas.listeners.size, 0);
  assert(f.engine.canvas.listeners.has('wheel'), 'fallback interactions bind to the new canvas');
  assert(f.overlays.length > 0 && f.overlays.at(-1).labelAlpha === 1, 'DOM labels also render on Canvas2D');
  f.pan(); f.engine.destroy(); assert.equal(f.engine.canvas.listeners.size, 0);
}
console.log('graph: split instance caches, camera reuse, AA/size semantics, dynamic effects, invalidation and shader fallback passed');

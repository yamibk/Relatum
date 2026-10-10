'use strict';
// Actual adapter + production layout CSS, synthetic data only. No server or user library.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const assets = path.resolve(__dirname, '../assets');

function installProbe() {
  const probe = window.graphLabelProbe = { draws: 0, measures: 0, created: 0, raf: 0,
    uploads: 0, uploadBytes: 0, contexts: 0, buffers: 0, programs: 0, recycledMax: 0, engines: [] };
  const measure = CanvasRenderingContext2D.prototype.measureText;
  CanvasRenderingContext2D.prototype.measureText = function (...args) { probe.measures++; return measure.apply(this, args); };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = callback => { probe.raf++; return raf(callback); };
  const getContext = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const gl = getContext.call(this, kind, ...args);
    if (gl && /^webgl/.test(kind) && !seen.has(gl)) {
      seen.add(gl); probe.contexts++;
      this.addEventListener('webglcontextlost', () => probe.contexts--, { once: true });
      for (const [makeName, dropName, key] of [['createBuffer', 'deleteBuffer', 'buffers'], ['createProgram', 'deleteProgram', 'programs']]) {
        const make = gl[makeName], drop = gl[dropName];
        gl[makeName] = function (...a) { const item = make.apply(this, a); if (item) probe[key]++; return item; };
        gl[dropName] = function (item) { if (item) probe[key]--; return drop.call(this, item); };
      }
      const upload = gl.bufferData;
      gl.bufferData = function (target, data, usage) {
        if (usage === gl.DYNAMIC_DRAW) { probe.uploads++; probe.uploadBytes += data.byteLength || 0; }
        return upload.call(this, target, data, usage);
      };
    }
    return gl;
  };
  const makeGL = GraphGL.create;
  GraphGL.create = canvas => {
    const renderer = makeGL(canvas);
    if (renderer) { const draw = renderer.draw; renderer.draw = function (...args) { probe.draws++; return draw.apply(this, args); }; }
    return renderer;
  };
  const create = GraphEngine.create;
  GraphEngine.create = options => {
    const record = { engine: null, nodes: [], edges: [], growth: null }, sync = options.domOverlay.sync;
    options.domOverlay.sync = state => {
      sync(state);
      const growth = record.growth;
      if (!growth) return;
      const time = performance.now(), first = state.nodes[0], last = state.nodes.at(-1);
      if (!growth.frames) {
        growth.firstFrameBlank = state.nodes.every(node => node._appearOpacity === 0)
          && (state.unit <= .25 || Array.from(document.querySelectorAll('[data-note-graph-label]')).every(el => Number(el.style.opacity) === 0));
      } else growth.intervals.push(time - growth.previous);
      growth.previous = time; growth.frames++;
      if (JSON.stringify(record.engine.view) !== growth.camera) growth.cameraChanges++;
      if (first._appearOpacity > 0 && growth.firstVisibleMs === null) growth.firstVisibleMs = time - growth.began;
      if (last._appeared && growth.appearanceEndMs === null) growth.appearanceEndMs = time - growth.began;
    };
    const engine = record.engine = create(options), setData = engine.setData;
    probe.engines.push(record); probe.latest = record;
    engine.setData = function (nodes, edges, ...rest) { record.nodes = nodes; record.edges = edges; return setData.call(this, nodes, edges, ...rest); };
    return engine;
  };
  window.graphModel = (root, count) => ({ root, signature: root + ':' + count,
    nodes: Array.from({ length: count }, (_, i) => ({ id: `${root}/笔记-${i}.md`, path: `${root}/笔记-${i}.md`, title: `笔记-${i}：中文合成标题` })),
    edges: Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({ from: `${root}/笔记-${i}.md`, to: `${root}/笔记-${i + 1}.md` })),
  });
  window.openSyntheticNotebook = async count => {
    const model = graphModel('', count);
    window.syntheticGraph = RelatumNoteGraph.create({ host: document.querySelector('#graph'),
      getRoot: () => '', isActive: () => true, language: () => 'zh', onSelect: async () => false,
      request: async () => model, showError: message => { throw new Error(message); } });
    await syntheticGraph.activate();
    if (probe.latest.engine.backendKind !== 'webgl') throw new Error('Real WebGL2 is required for GPU measurements');
  };
  window.notebookLabelInfo = () => {
    const { engine, nodes } = probe.latest, rect = engine.canvas.getBoundingClientRect(), view = engine.view;
    const base = Math.min(rect.width / 1200, rect.height / 720), unit = base * view.scale;
    const tx = (rect.width - 1200 * base) / 2 - view.x * unit, ty = (rect.height - 720 * base) / 2 - view.y * unit;
    const intersecting = nodes.filter(node => {
      const sx = node._rx * unit + tx, y = node._ry * unit + ty + node.r * unit + 8;
      const width = probe.widths.get(node.id).width;
      return sx + width / 2 >= 0 && sx - width / 2 <= rect.width && y + 16 >= 0 && y <= rect.height;
    }).length;
    const progress = Math.max(0, Math.min(1, (unit - .25) / .4));
    return { labels: document.querySelectorAll('[data-note-graph-label]').length, intersecting, unit,
      labelAlpha: Number(getComputedStyle(document.querySelector('.note-graph-label')).opacity), expectedAlpha: progress * progress * (3 - 2 * progress),
      measures: probe.measures, font: getComputedStyle(document.querySelector('.note-graph-label')).fontSize,
      cssWidth: rect.width, cssHeight: rect.height, pixelWidth: engine.canvas.width, pixelHeight: engine.canvas.height };
  };
  window.runLabelPan = async frames => {
    const canvas = probe.latest.engine.canvas, { x, y } = window.graphPanPoint;
    const stats = { parentStyleWrites: 0, anchorStyleWrites: 0, labelMounts: 0 };
    const world = document.querySelector('.note-graph-label-world');
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target === world) stats.parentStyleWrites++;
          else if (record.target.matches('.note-graph-label-anchor')) stats.anchorStyleWrites++;
        } else stats.labelMounts += Array.from(record.addedNodes).filter(node => node.nodeType === 1 && node.matches('.note-graph-label-anchor')).length;
      }
    });
    observer.observe(world, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });
    const tasks = [], long = new PerformanceObserver(list => tasks.push(...list.getEntries().map(item => item.duration)));
    long.observe({ type: 'longtask', buffered: false });
    const before = { measures: probe.measures, draws: probe.draws, created: probe.created, uploads: probe.uploads, bytes: probe.uploadBytes };
    const intervals = []; let previous = 0;
    for (let i = 0; i < frames; i++) {
      await new Promise(resolve => requestAnimationFrame(time => {
        if (previous) intervals.push(time - previous); previous = time;
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', button: 0,
          clientX: x + Math.sin(i * .1) * 4, clientY: y + Math.cos(i * .1) * 4 }));
        resolve();
      }));
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    observer.disconnect(); long.disconnect(); intervals.sort((a, b) => a - b);
    return { ...stats, labelCreates: probe.created - before.created, measures: probe.measures - before.measures, draws: probe.draws - before.draws,
      uploads: probe.uploads - before.uploads, uploadBytes: probe.uploadBytes - before.bytes,
      frameIntervalP50Ms: intervals[Math.floor(intervals.length * .5)], frameIntervalP95Ms: intervals[Math.floor(intervals.length * .95)],
      longTasks: tasks.length, longestTaskMs: Math.max(0, ...tasks) };
  };
  window.runGraphGrowth = async () => {
    const record = probe.latest, engine = record.engine;
    engine.setReduceMotion(false);
    const before = { measures: probe.measures, engines: probe.engines.length, uploads: probe.uploads, bytes: probe.uploadBytes };
    const tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(item => item.duration)));
    observer.observe({ type: 'longtask', buffered: false });
    const began = performance.now();
    document.querySelector('[data-action="graph-grow"]').click();
    const growth = record.growth = { began, camera: JSON.stringify(engine.view), cameraChanges: 0,
      frames: 0, intervals: [], previous: 0, firstVisibleMs: null, appearanceEndMs: null };
    const birthSpanMs = record.nodes.at(-1)._born - record.nodes[0]._born;
    const staggerMs = record.nodes.length > 1 ? record.nodes[1]._born - record.nodes[0]._born : 0;
    let complete = false;
    for (let i = 0; i < 300; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!engine.layoutPending && record.nodes.every(node => node._appeared)) { complete = true; break; }
    }
    record.growth = null; observer.disconnect(); growth.intervals.sort((a, b) => a - b);
    const result = { complete, frames: growth.frames, firstFrameBlank: growth.firstFrameBlank,
      cameraChanges: growth.cameraChanges, firstVisibleMs: growth.firstVisibleMs, appearanceEndMs: growth.appearanceEndMs,
      birthSpanMs, staggerMs, totalUntilSettledMs: performance.now() - began,
      frameIntervalP50Ms: growth.intervals[Math.floor(growth.intervals.length * .5)],
      frameIntervalP95Ms: growth.intervals[Math.floor(growth.intervals.length * .95)],
      longTasks: tasks.length, longestTaskMs: Math.max(0, ...tasks), measures: probe.measures - before.measures,
      uploads: probe.uploads - before.uploads, uploadBytes: probe.uploadBytes - before.bytes, enginesCreated: probe.engines.length - before.engines };
    const idle = { draws: probe.draws, raf: probe.raf };
    await new Promise(resolve => setTimeout(resolve, 350));
    result.idleDraws = probe.draws - idle.draws; result.idleRaf = probe.raf - idle.raf;
    return result;
  };
}

// Private cache observations exist only in the test-injected source.
const production = fs.readFileSync(path.join(assets, 'note-graph.js'), 'utf8');
const source = production
  .replace('return value;', 'graphLabelProbe.widths = measurements; return value;')
  .replace('const RECYCLE_LIMIT = 256;', 'const RECYCLE_LIMIT = 256; graphLabelProbe.recycledEntries = recycled;')
  .replace("const anchor = document.createElement('div'); anchor.className = 'note-graph-label-anchor';",
    "const anchor = document.createElement('div'); anchor.className = 'note-graph-label-anchor'; graphLabelProbe.created++;")
  .replace('while (recycled.size > RECYCLE_LIMIT) recycled.delete(recycled.keys().next().value);',
    'while (recycled.size > RECYCLE_LIMIT) recycled.delete(recycled.keys().next().value); graphLabelProbe.recycledMax = Math.max(graphLabelProbe.recycledMax, recycled.size);')
  .replace('const scenes = new Map();', 'const scenes = new Map(); graphLabelProbe.scenes = scenes;')
  .replace('let sceneBytes = 0;', 'let sceneBytes = 0; Object.defineProperty(graphLabelProbe, "sceneBytes", {configurable: true, get: () => sceneBytes});');
assert(source.includes('graphLabelProbe.recycledMax = Math.max') && source.includes('get: () => sceneBytes'));

async function preparePage(browser, dpr, size) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><body class="start-page" data-start-theme="light"><div id="workspace" class="note-workspace note-graph-active">'
    + '<aside class="note-tree-pane"></aside><main class="note-document-pane"><nav class="note-tab-bar"><span>关系图谱 · notes</span></nav>'
    + '<section id="graph" class="note-graph-panel"></section></main></div></body></html>');
  await page.addStyleTag({ path: path.join(assets, 'styles.css') });
  // The tab case uses production sidebar/tab geometry. The former window stage is 1160 × 702 CSS px.
  await page.addStyleTag({ content: size === 'tab'
    ? '#workspace { position:fixed;inset:92px 0 0; }'
    : '#workspace { position:fixed;left:380px;top:189px;width:1160px;height:702px;display:block; } .note-tree-pane,.note-tab-bar {display:none} .note-document-pane {height:100%}' });
  for (const filename of ['graph-gl.js', 'graph-engine.js']) await page.addScriptTag({ path: path.join(assets, filename) });
  await page.evaluate(installProbe); await page.addScriptTag({ content: source });
  return { context, page, errors };
}
async function released(page) {
  await page.waitForFunction(() => graphLabelProbe.contexts === 0 && graphLabelProbe.buffers === 0 && graphLabelProbe.programs === 0);
  assert.equal(await page.locator('[data-note-graph-label]').count(), 0);
}
async function measure(browser, count, dpr, size) {
  const { context, page, errors } = await preparePage(browser, dpr, size);
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  async function metrics() {
    const result = await cdp.send('Performance.getMetrics'); return Object.fromEntries(result.metrics.map(item => [item.name, item.value]));
  }
  try {
    const before = await metrics(); await page.evaluate(count => openSyntheticNotebook(count), count);
    let stable = false;
    for (let i = 0; i < 100; i++) {
      const draws = await page.evaluate(() => graphLabelProbe.draws); await page.waitForTimeout(200);
      if (i > 2 && draws === await page.evaluate(() => graphLabelProbe.draws) && !await page.evaluate(() => graphLabelProbe.latest.engine.layoutPending)) { stable = true; break; }
    }
    assert(stable, count + ': physics converged');
    await page.evaluate(() => { graphLabelProbe.latest.engine.setPanInertia(0); graphLabelProbe.latest.engine.fitView(false); });
    await page.waitForTimeout(80); const setup = await metrics(), labelInfo = await page.evaluate(() => notebookLabelInfo());
    assert.equal(labelInfo.labels, labelInfo.intersecting, 'intersecting anchors are retained across fade');
    assert(Math.abs(labelInfo.labelAlpha - labelInfo.expectedAlpha) < .002, 'fit view uses scale-aware title opacity');
    assert(labelInfo.labels >= count * .95); assert.equal(labelInfo.measures, count); assert.equal(labelInfo.font, '12px');
    assert.equal(labelInfo.pixelWidth, Math.round(labelInfo.cssWidth * dpr)); assert.equal(labelInfo.pixelHeight, Math.round(labelInfo.cssHeight * dpr));
    const rect = await page.locator('[data-role="graph-canvas"]').boundingBox();
    const point = await page.evaluate(rect => {
      const candidates = [{ x: rect.x + 5, y: rect.y + 5 }, { x: rect.x + rect.width - 5, y: rect.y + 5 },
        { x: rect.x + 5, y: rect.y + rect.height - 5 }, { x: rect.x + rect.width - 5, y: rect.y + rect.height - 5 }];
      // Dense fits can put a node within the expanded pointer hit radius of a corner.
      window.graphPanPoint = candidates.find(p => graphLabelProbe.latest.engine.nodeAtClient(p.x, p.y) < 0);
      return window.graphPanPoint;
    }, rect);
    assert(point, 'the pure camera measurement starts on certified blank space');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    const panStart = await metrics(), pan = await page.evaluate(() => runLabelPan(90)), panEnd = await metrics();
    await page.mouse.up(); await page.waitForTimeout(80);
    // A title appearing for the first time at a clipped edge needs its three initial styles.
    assert(pan.anchorStyleWrites <= pan.labelCreates * 3, JSON.stringify(pan)); assert(pan.parentStyleWrites > 0);
    assert.equal(pan.measures, 0); assert.equal(pan.uploads, 0); assert.equal(pan.uploadBytes, 0);
    const idleStart = await page.evaluate(() => ({ draws: graphLabelProbe.draws, raf: graphLabelProbe.raf }));
    await page.waitForTimeout(350); const idleEnd = await page.evaluate(() => ({ draws: graphLabelProbe.draws, raf: graphLabelProbe.raf }));
    assert.deepEqual(idleEnd, idleStart, 'stable adapter has zero RAF/draws');
    const view = await page.evaluate(() => graphLabelProbe.latest.engine.view);
    await page.evaluate(() => graphLabelProbe.latest.engine.restoreView({ x: 1000000, y: 1000000, scale: .3 }));
    await page.waitForTimeout(80); assert.equal(await page.locator('[data-note-graph-label]').count(), 0);
    assert.equal(await page.evaluate(() => graphLabelProbe.recycledEntries.size), Math.min(count, 256));
    assert((await page.evaluate(() => graphLabelProbe.recycledMax)) <= 256);
    await page.evaluate(view => graphLabelProbe.latest.engine.restoreView(view), view); await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => graphLabelProbe.measures), labelInfo.measures);
    const returned = await page.evaluate(() => notebookLabelInfo()); assert.equal(returned.labels, returned.intersecting);
    await page.mouse.move(1, 1); await page.waitForTimeout(80);
    const zoomStart = await metrics();
    const zoom = await page.evaluate(async () => {
      const probe = graphLabelProbe, engine = probe.latest.engine, view = engine.view;
      const rect = engine.canvas.getBoundingClientRect(), base = Math.min(rect.width / 1200, rect.height / 720);
      const centerX = view.x + 600 / view.scale, centerY = view.y + 360 / view.scale;
      const uploads = probe.uploads, bytes = probe.uploadBytes, measures = probe.measures;
      const states = [];
      for (let step = 0; step <= 24; step++) {
        const unit = .2 + .6 * (1 - Math.abs(step - 12) / 12), scale = unit / base;
        engine.restoreView({ x: centerX - 600 / scale, y: centerY - 360 / scale, scale });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (step === 0 || step === 12 || step === 24) states.push(Number(getComputedStyle(document.querySelector('.note-graph-label')).opacity));
      }
      engine.restoreView(view);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { uploads: probe.uploads - uploads, bytes: probe.uploadBytes - bytes, measures: probe.measures - measures, states };
    });
    const zoomEnd = await metrics();
    assert.equal(zoom.uploads, 0); assert.equal(zoom.bytes, 0); assert.equal(zoom.measures, 0);
    assert.deepEqual(zoom.states, [0, 1, 0], 'large graph zoom hides, restores and hides full titles');
    const zoomIdle = await page.evaluate(() => ({ draws: graphLabelProbe.draws, raf: graphLabelProbe.raf }));
    await page.waitForTimeout(350);
    assert.deepEqual(await page.evaluate(() => ({ draws: graphLabelProbe.draws, raf: graphLabelProbe.raf })), zoomIdle, 'fade adds no idle frames');
    const sample = { count, edges: count - 1, dpr, size, ...labelInfo, pan,
      zoom, zoomScriptCpuMs: (zoomEnd.ScriptDuration - zoomStart.ScriptDuration) * 1000,
      zoomStyleCpuMs: (zoomEnd.RecalcStyleDuration - zoomStart.RecalcStyleDuration) * 1000,
      setupScriptCpuMs: (setup.ScriptDuration - before.ScriptDuration) * 1000,
      panScriptCpuMs: (panEnd.ScriptDuration - panStart.ScriptDuration) * 1000,
      panStyleCpuMs: (panEnd.RecalcStyleDuration - panStart.RecalcStyleDuration) * 1000,
      panLayoutCpuMs: (panEnd.LayoutDuration - panStart.LayoutDuration) * 1000,
      idleRaf: idleEnd.raf - idleStart.raf, idleDraws: idleEnd.draws - idleStart.draws,
      recycledMax: await page.evaluate(() => graphLabelProbe.recycledMax) };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const growthStart = await metrics(); sample.growth = await page.evaluate(() => runGraphGrowth());
    const growthEnd = await metrics();
    sample.growth.scriptCpuMs = (growthEnd.ScriptDuration - growthStart.ScriptDuration) * 1000;
    sample.growth.styleCpuMs = (growthEnd.RecalcStyleDuration - growthStart.RecalcStyleDuration) * 1000;
    sample.growth.layoutCpuMs = (growthEnd.LayoutDuration - growthStart.LayoutDuration) * 1000;
    assert(sample.growth.complete && sample.growth.firstFrameBlank, 'bounded growth starts blank and finishes');
    assert.equal(sample.growth.cameraChanges, 0); assert.equal(sample.growth.measures, 0); assert.equal(sample.growth.enginesCreated, 0);
    assert(sample.growth.birthSpanMs <= 3000.001 && sample.growth.staggerMs <= 12.001);
    assert(sample.growth.firstVisibleMs >= 95 && sample.growth.appearanceEndMs >= 100 + sample.growth.birthSpanMs + 450);
    assert.equal(sample.growth.idleRaf, 0); assert.equal(sample.growth.idleDraws, 0);
    // Even after re-layout, the first static camera repaint must use existing instances.
    const cameraUploads = await page.evaluate(() => {
      const before = graphLabelProbe.uploads, engine = graphLabelProbe.latest.engine, view = engine.view;
      engine.restoreView({ ...view, x: view.x + 2 }); return before;
    });
    await page.waitForTimeout(80); assert.equal(await page.evaluate(() => graphLabelProbe.uploads), cameraUploads);
    const catchUp = await page.evaluate(async () => {
      const { engine, nodes } = graphLabelProbe.latest, node = nodes[0], view = engine.view;
      const rect = engine.canvas.getBoundingClientRect(), unit = .8, scale = unit / Math.min(rect.width / 1200, rect.height / 720);
      engine.restoreView({ x: node._rx - 600 / scale, y: node._ry - 360 / scale, scale });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const anchor = Array.from(document.querySelectorAll('[data-note-graph-label]')).find(el => el.dataset.noteGraphLabel === node.id);
      const title = anchor.querySelector('span'), box = title.getBoundingClientRect();
      const caughtUp = Math.abs(box.left + box.width / 2 - (rect.left + rect.width / 2)) < 1
        && Math.abs(box.top - (rect.top + rect.height / 2 + node.r * unit + 8)) < 1;
      const visible = getComputedStyle(title).opacity === '1' && getComputedStyle(anchor).opacity === '1';
      engine.restoreView(view); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { caughtUp, visible };
    });
    assert.deepEqual(catchUp, { caughtUp: true, visible: true }, 'first visible frame catches up deferred title positions and opacity');
    assert.equal(await page.evaluate(() => graphLabelProbe.uploads), cameraUploads);
    sample.growth.titleCatchUp = true;
    await page.evaluate(() => syntheticGraph.deactivate()); await released(page);
    assert.equal(await page.evaluate(() => graphLabelProbe.scenes.size), 1, 'hiding keeps only a logical scene');
    await page.evaluate(() => syntheticGraph.destroy()); assert.equal(await page.evaluate(() => graphLabelProbe.scenes.size), 0);
    sample.released = true; assert.deepEqual(errors, []); return sample;
  } finally { await cdp.detach(); await context.close(); }
}

async function cacheRegression(browser) {
  const { context, page, errors } = await preparePage(browser, 1, 'tab');
  try {
    const cache = await page.evaluate(async () => {
      let scope = 'Book0', count = 0;
      const graph = RelatumNoteGraph.create({ host: document.querySelector('#graph'), getRoot: () => scope,
        isActive: () => true, language: () => 'zh', onSelect: async () => false,
        request: async () => graphModel(scope, count), showError: () => {} });
      for (let i = 0; i < 30; i++) { scope = 'Book' + i; await graph.activate(); graph.deactivate(); }
      const lru = { size: graphLabelProbe.scenes.size, first: graphLabelProbe.scenes.keys().next().value, bytes: graphLabelProbe.sceneBytes };
      scope = 'View'; count = 1; await graph.activate();
      graphLabelProbe.latest.engine.restoreView({ x: 30, y: 50, scale: .75 }); graph.deactivate();
      const first = graphLabelProbe.scenes.get(scope), position = { x: first.nodes[0].x, y: first.nodes[0].y };
      await graph.activate(); const restored = graphLabelProbe.latest.engine.view, preserved = graphLabelProbe.latest.nodes[0];
      const samePosition = preserved.x === position.x && preserved.y === position.y;
      const engines = graphLabelProbe.engines.length;
      graph.remap('Book20', 'OtherBook');
      const unrelatedKept = graphLabelProbe.engines.length === engines;
      graphLabelProbe.latest.engine.kick(); graph.deactivate();
      const pendingKept = graphLabelProbe.scenes.get(scope).needsLayout;
      await graph.activate();
      scope = 'Renamed'; graph.remap('View', 'Renamed'); await graph.activate(); graph.deactivate();
      const renamed = graphLabelProbe.scenes.has('Renamed') && !graphLabelProbe.scenes.has('View');
      graph.prune('Renamed'); const pruned = !graphLabelProbe.scenes.has('Renamed');
      graph.deactivate({ clearCache: true }); const cleared = graphLabelProbe.scenes.size === 0 && graphLabelProbe.sceneBytes === 0;
      graph.destroy(); return { lru, restored, samePosition, unrelatedKept, pendingKept, renamed, pruned, cleared };
    });
    assert.equal(cache.lru.size, 24); assert.equal(cache.lru.first, 'Book6'); assert(cache.lru.bytes <= 16 * 1024 * 1024);
    assert.deepEqual(cache.restored, { x: 30, y: 50, scale: .75 }); assert(cache.samePosition && cache.unrelatedKept && cache.pendingKept && cache.renamed && cache.pruned && cache.cleared);
    await released(page);
    // A small test-only budget exercises the production byte limit and oversize bypass.
    await page.addScriptTag({ content: source.replace('CACHE_BYTES = 16 * 1024 * 1024', 'CACHE_BYTES = 8192') });
    const budget = await page.evaluate(async () => {
      let scope = 'Small0';
      const graph = RelatumNoteGraph.create({ host: document.querySelector('#graph'), getRoot: () => scope,
        isActive: () => true, language: () => 'zh', onSelect: async () => false, showError: () => {},
        request: async () => { const model = graphModel(scope, 1); model.nodes[0].title = '长标题'.repeat(scope === 'Huge' ? 4000 : 60); return model; } });
      for (let i = 0; i < 8; i++) { scope = 'Small' + i; await graph.activate(); graph.deactivate(); await new Promise(resolve => setTimeout(resolve, 0)); }
      const bounded = graphLabelProbe.sceneBytes <= 8192 && graphLabelProbe.scenes.size < 8;
      scope = 'Huge'; await graph.activate(); graph.deactivate(); const oversizedSkipped = !graphLabelProbe.scenes.has('Huge');
      graph.destroy(); return { bounded, oversizedSkipped };
    });
    assert.deepEqual(budget, { bounded: true, oversizedSkipped: true }); await released(page);
    await page.addScriptTag({ content: source });
    const late = await page.evaluate(async () => {
      let scope = 'Old'; const replies = [], roots = [];
      const graph = RelatumNoteGraph.create({ host: document.querySelector('#graph'), getRoot: () => scope,
        isActive: () => true, language: () => 'zh', onSelect: async () => false, showError: () => {},
        request: url => { roots.push(new URL(url, 'http://127.0.0.1').searchParams.get('root')); return new Promise(resolve => replies.push(resolve)); } });
      const old = graph.activate(); scope = 'Renamed'; graph.remap('Old', 'Renamed');
      replies[1](graphModel('Renamed', 1)); replies[0](graphModel('Old', 1));
      const staleResult = await old; await graph.activate(); await new Promise(resolve => setTimeout(resolve, 50));
      const newModelKept = graphLabelProbe.latest.nodes[0].id.startsWith('Renamed/');
      graphLabelProbe.latest.engine.restoreView({ x: 1000000, y: 1000000, scale: 1 }); await new Promise(resolve => setTimeout(resolve, 50));
      const offscreenRetained = graphLabelProbe.recycledEntries.size === 1;
      const remove = graph.checkExternalChanges(); replies[2](graphModel('Renamed', 0)); await remove;
      const removedCacheClean = graphLabelProbe.widths.size === 0 && graphLabelProbe.recycledEntries.size === 0 && !document.querySelector('[data-note-graph-label]');
      graph.destroy(); return { staleResult, roots, newModelKept, offscreenRetained, removedCacheClean };
    });
    assert.deepEqual(late, { staleResult: false, roots: ['Old', 'Renamed', 'Renamed'], newModelKept: true, offscreenRetained: true, removedCacheClean: true });
    await released(page); assert.deepEqual(errors, []); return { cache, budget, late };
  } finally { await context.close(); }
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
  const report = { measuredAt: new Date().toISOString(), scope: 'same current adapter and WebGL caches; former window stage area vs production tab layout, synthetic Chinese titles', samples: [] };
  try {
    report.regression = await cacheRegression(browser); console.log(JSON.stringify({ regression: report.regression }));
    if (!process.argv.includes('--regression-only')) {
      for (const dpr of [1, 2]) for (const count of [150, 1500, 3000]) for (const size of process.argv.includes('--tab-only') ? ['tab'] : ['window-area', 'tab']) {
        const sample = await measure(browser, count, dpr, size); report.samples.push(sample); console.log(JSON.stringify(sample));
      }
    }
    const output = process.argv.slice(2).find(arg => !arg.startsWith('--')) || process.env.RELATUM_NOTE_GRAPH_REPORT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

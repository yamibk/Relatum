'use strict';
// Real API + Edge. Every file and preference belongs to a disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const panel = '[data-role="note-graph-panel"]', token = 'relatum:graph-tab:v1';
const longName = '独立的中文长标题完整显示而且不截断超过十八个字符';

function instrumentation(fallback) {
  const probe = window.__graphProbe = { contexts: 0, buffers: 0, programs: 0, uploads: 0, draws: 0, engines: [] };
  const original = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (fallback === 'unavailable' && /^webgl/.test(kind)) return null;
    const gl = original.call(this, kind, ...args);
    if (gl && /^webgl/.test(kind) && !seen.has(gl)) {
      seen.add(gl); probe.contexts++;
      this.addEventListener('webglcontextlost', () => probe.contexts--, { once: true });
      for (const [makeName, dropName, key] of [['createBuffer', 'deleteBuffer', 'buffers'], ['createProgram', 'deleteProgram', 'programs']]) {
        const make = gl[makeName], drop = gl[dropName];
        gl[makeName] = function (...a) { const value = make.apply(this, a); if (value) probe[key]++; return value; };
        gl[dropName] = function (value) { if (value) probe[key]--; return drop.call(this, value); };
      }
      for (const name of ['bufferData', 'bufferSubData']) {
        const fn = gl[name]; gl[name] = function (...a) { probe.uploads++; return fn.apply(this, a); };
      }
      const draw = gl.drawArraysInstanced;
      gl.drawArraysInstanced = function (...a) { probe.draws++; return draw.apply(this, a); };
      if (fallback === 'shader') gl.getShaderParameter = () => false;
    }
    return gl;
  };
  let module;
  Object.defineProperty(window, 'GraphEngine', { configurable: true, get: () => module, set(value) {
    const create = value.create;
    value.create = options => {
      const record = { engine: null, nodes: [], edges: [], track: false, frames: [], nodeColors: {}, edgeColors: {} };
      const sync = options.domOverlay.sync;
      options.domOverlay.sync = state => {
        sync(state);
        const labelAlpha = Number(document.querySelector('.note-graph-label-world').style.getPropertyValue('--note-graph-label-alpha'));
        if (record.track) record.frames.push({ time: performance.now(), view: record.engine.view,
          opacity: state.nodes.map(node => node._appearOpacity), scale: state.nodes.map(node => node._appearScale),
          labels: Array.from(document.querySelectorAll('[data-note-graph-label]')).map(el => Number(el.style.opacity || 1) * (el.classList.contains('is-hovered') ? 1 : labelAlpha)) });
      };
      const styleNode = options.nodeStyle, styleEdge = options.edgeStyle, drawNode = options.drawNode, drawEdge = options.drawEdge;
      options.nodeStyle = (node, env) => { const style = styleNode(node, env); record.nodeColors[node.id] = style.fill.slice(0, 3); return style; };
      options.edgeStyle = (...args) => { const style = styleEdge(...args); record.edgeColors.normal = style.color.slice(0, 3); return style; };
      options.drawNode = (ctx, node, env) => { drawNode(ctx, node, env); record.nodeColors[node.id] = ctx.fillStyle; };
      options.drawEdge = (...args) => { drawEdge(...args); record.edgeColors.normal = args[0].strokeStyle; };
      const engine = create(options);
      if (engine) {
        record.engine = engine;
        const setData = engine.setData;
        engine.setData = function (nodes, edges, ...rest) { record.nodes = nodes; record.edges = edges; return setData.call(this, nodes, edges, ...rest); };
        probe.engines.push(record); probe.latest = record;
      }
      return engine;
    };
    module = value;
  } });
}

async function run(browser, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-graph-tab-')), notes = path.join(root, 'notes');
  for (const book of ['One', 'Two', 'Empty']) fs.mkdirSync(path.join(notes, 'CustomNotebook', book), { recursive: true });
  fs.writeFileSync(path.join(notes, 'A.md'), '[[B]]\n'); fs.writeFileSync(path.join(notes, 'B.md'), '正文\n');
  fs.writeFileSync(path.join(notes, longName + '.md'), '独立笔记\n');
  for (const book of ['One', 'Two']) {
    fs.writeFileSync(path.join(notes, 'CustomNotebook', book, 'A.md'), '[[B]]\n[重复](B.md)\n[[CustomNotebook/Other/B]]\n');
    fs.writeFileSync(path.join(notes, 'CustomNotebook', book, 'B.md'), '正文\n');
  }
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`, args = ['app.py', '--no-browser', '--port', String(port)];
  if (mode === 'notes-only' || mode === 'notes-no-canvas') {
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
    args.push('--launch-profile', JSON.stringify({ version: 1,
      features: Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes' || mode === 'notes-only' && f.id === 'notes.canvas'])) }));
  }
  const server = spawn(process.env.RELATUM_PYTHON || 'python', args,
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) { ready = true; break; } } catch (_) {} await pause(100); }
    assert(ready, mode + ': server started');
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', req => requests.push(new URL(req.url()).pathname));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, activateTab, closeTab, closeAllTabs, selectNotebook, triggerExternalSync, flushSave, movePath, recycleEntry, setSideMode, notebookUi, showBrowserResults, get graph(){return noteGraph;}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(instrumentation, mode === 'fallback' ? 'unavailable' : mode === 'shader-failure' ? 'shader' : '');
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0');
      localStorage.setItem('canvas:noteGraphViews:v1', 'legacy-window-settings');
    });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.active);
    const button = page.locator('[data-note-action="toggle-graph"]');
    assert(!requests.includes('/note-graph.js'), 'graph runtime stays lazy');
    assert.equal(await page.evaluate(() => __graphProbe.contexts), 0);
    await page.evaluate(() => T.openNote('A.md'));
    if (mode === 'full') {
      await page.route('**/note-graph.js', route => route.abort('failed'));
      const failed = page.waitForEvent('requestfailed', request => request.url().endsWith('/note-graph.js'));
      await button.click(); await failed; await pause(80);
      assert.equal(await page.evaluate(() => T.state.activeTab), 'A.md', 'load failure retains the MD tab');
      assert.equal(await page.locator(panel).isVisible(), false);
      await page.unroute('**/note-graph.js');
      await page.route('**/api/note-save', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"test save conflict","code":"revision_conflict"}' }));
      await page.evaluate(() => T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\nopening draft\n' } }));
      await button.click(); await pause(250);
      assert.equal(await page.evaluate(() => T.state.activeTab), 'A.md', 'save failure retains the MD tab');
      assert.equal(await page.locator(panel).isVisible(), false);
      await page.unroute('**/api/note-save'); assert(await page.evaluate(() => T.flushSave()));
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() => { T.editor.view.dispatch({ selection: { anchor: T.editor.view.state.doc.length } }); T.editor.focus(); });
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
      await page.waitForFunction(() => T.editor.inputPending);
      await button.evaluate(el => el.click()); await pause(120);
      assert.equal(await page.locator(panel).isVisible(), false, 'tab activation waits for native composition');
      await cdp.send('Input.insertText', { text: '中文' });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await cdp.detach();
    } else await button.click();
    async function shown(count, edges) {
      await page.locator(panel).waitFor({ state: 'visible' });
      await page.waitForFunction(({ count, edges }) => {
        const host = document.querySelector('[data-role="note-graph-panel"]');
        return Number(host?.querySelector('[data-role="graph-node-count"]')?.textContent) === count
          && Number(host?.querySelector('[data-role="graph-edge-count"]')?.textContent) === edges;
      }, { count, edges });
    }
    async function resourcesReleased() {
      await page.waitForFunction(() => __graphProbe.contexts === 0 && __graphProbe.buffers === 0 && __graphProbe.programs === 0);
      assert.equal(await page.locator('[data-note-graph-label]').count(), 0);
    }
    async function select(scope, count, edges) { await page.evaluate(scope => T.selectNotebook(scope), scope); await button.click(); await shown(count, edges); }
    async function camera() { return page.evaluate(() => __graphProbe.latest.engine.view); }
    async function nodePoint(path) {
      return page.evaluate(path => {
        const { engine, nodes } = __graphProbe.latest, node = nodes.find(n => n.id === path);
        const rect = engine.canvas.getBoundingClientRect(), view = engine.view;
        const base = Math.min(rect.width / 1200, rect.height / 720), unit = base * view.scale;
        return { x: rect.left + (rect.width - 1200 * base) / 2 + (node._rx - view.x) * unit,
          y: rect.top + (rect.height - 720 * base) / 2 + (node._ry - view.y) * unit };
      }, path);
    }
    async function verifyLabelFade(path) {
      await page.waitForFunction(() => !__graphProbe.latest.engine.layoutPending);
      await pause(800); // Finish entry/theme/resize work before measuring camera-only invalidation.
      const saved = await camera();
      await page.mouse.move(1, 1); await pause(80);
      const uploads = await page.evaluate(() => __graphProbe.uploads);
      const label = page.locator('[data-note-graph-label=' + JSON.stringify(path) + '] span');
      for (const [unit, alpha] of [[.2, 0], [.25, 0], [.45, .5], [.65, 1], [.8, 1], [.45, .5], [.2, 0]]) {
        await page.evaluate(({ path, unit }) => {
          const { engine, nodes } = __graphProbe.latest, node = nodes.find(n => n.id === path);
          const rect = engine.canvas.getBoundingClientRect(), scale = unit / Math.min(rect.width / 1200, rect.height / 720);
          engine.restoreView({ x: node._rx - 600 / scale, y: node._ry - 360 / scale, scale });
        }, { path, unit });
        await pause(60);
        assert(Math.abs(await label.evaluate(el => Number(getComputedStyle(el).opacity)) - alpha) < .002, 'title opacity follows screen unit in both directions');
        assert.equal(await label.evaluate(el => getComputedStyle(el).fontSize), '12px');
      }
      assert.equal(await page.evaluate(() => __graphProbe.uploads), uploads, 'fade does not invalidate GPU instances');
      const point = await nodePoint(path); await page.mouse.move(point.x, point.y); await pause(80);
      assert.equal(await label.evaluate(el => getComputedStyle(el).opacity), '1', 'hover reveals hidden full title');
      assert.equal(await page.locator('.note-graph-label-anchor.is-hovered').count(), 1);
      assert(await page.locator('.note-graph-label-anchor:not(.is-hovered) .note-graph-label').evaluateAll(elements => elements.every(el => getComputedStyle(el).opacity === '0')), 'neighbors stay hidden');
      await page.mouse.move(1, 1); await pause(80);
      assert.equal(await label.evaluate(el => getComputedStyle(el).opacity), '0', 'leaving restores hidden title');
      const draws = await page.evaluate(() => __graphProbe.draws); await pause(150);
      assert.equal(await page.evaluate(() => __graphProbe.draws), draws, 'fade adds no idle drawing');
      await page.evaluate(view => __graphProbe.latest.engine.restoreView(view), saved); await pause(80);
    }
    async function verifyPalette(dark, path) {
      await page.evaluate(() => __graphProbe.latest.engine.fitView(false)); await pause(80);
      const point = await nodePoint(path); await page.mouse.move(point.x, point.y); await pause(80);
      const paint = await page.evaluate(path => ({ node: __graphProbe.latest.nodeColors[path],
        edge: __graphProbe.latest.edgeColors.normal, backend: __graphProbe.latest.engine.backendKind }), path);
      const focus = dark ? '#f5f5f5' : '#202020', normal = dark ? '#b9b9b9' : '#5f5f5f';
      function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); }
      assert.deepEqual(paint.node, paint.backend === 'webgl' ? rgb(focus) : focus, 'hover uses neutral high contrast');
      if (paint.backend === 'webgl') assert.equal(new Set(paint.edge).size, 1, 'GL edges are grayscale');
      else assert(/^rgba?\((\d+), \1, \1[,)]/.test(paint.edge), '2D edges are grayscale: ' + paint.edge);
      await page.mouse.move(1, 1); await pause(80);
      assert.deepEqual(await page.evaluate(path => __graphProbe.latest.nodeColors[path], path), paint.backend === 'webgl' ? rgb(normal) : normal);
    }
    async function verifyGrowthAndSpread() {
      const grow = page.locator(`${panel} [data-action="graph-grow"]`);
      assert.equal(await grow.getAttribute('aria-label'), '播放关系图谱生长动画');
      assert.equal(await grow.getAttribute('data-ui-tooltip'), '播放关系图谱生长动画');
      assert(await grow.evaluate(el => el.nextElementSibling.dataset.action === 'graph-relax'));
      const view = { x: 1000000, y: -1000000, scale: .04 };
      await page.evaluate(view => {
        const record = __graphProbe.latest; record.track = true; record.frames = [];
        record.engine.restoreView(view); document.querySelector('[data-action="graph-relax"]').click();
      }, view);
      assert.deepEqual(await camera(), view, 'spread does not reset a remote camera on click');
      await page.waitForFunction(() => !__graphProbe.latest.engine.layoutPending); await pause(150);
      const spread = await page.evaluate(() => { const r = __graphProbe.latest; r.track = false; return r.frames; });
      assert(spread.length > 30); assert(spread.every(frame => JSON.stringify(frame.view) === JSON.stringify(view)), 'every spread frame keeps the camera including final empty-viewport frame');
      assert.equal(await page.locator('[data-note-graph-label]').count(), 0);
      await page.locator(`${panel} [data-action="graph-reset-view"]`).evaluate(el => el.click()); await pause(1000);
      assert.notDeepEqual(await camera(), view, 'explicit reset recovers offscreen nodes');
      const creates = await page.evaluate(() => __graphProbe.engines.length), queries = requests.filter(url => url === '/api/note-graph').length;
      const blank = await page.evaluate(() => {
        const r = __graphProbe.latest; r.track = true; r.frames = [];
        document.querySelector('[data-action="graph-grow"]').click();
        const rect = r.engine.canvas.getBoundingClientRect(), n = r.nodes[0], view = r.engine.view;
        const base = Math.min(rect.width / 1200, rect.height / 720), unit = base * view.scale;
        const x = rect.left + (rect.width - 1200 * base) / 2 + (n.x - view.x) * unit;
        const y = rect.top + (rect.height - 720 * base) / 2 + (n.y - view.y) * unit;
        return { view, born: r.nodes.map(node => node._born), opacity: r.nodes.map(node => node._appearOpacity), hit: r.engine.nodeAtClient(x, y) };
      });
      assert(blank.opacity.every(alpha => alpha === 0)); assert.equal(blank.hit, -1);
      await page.waitForFunction(() => __graphProbe.latest.frames.length > 0);
      const first = await page.evaluate(() => __graphProbe.latest.frames[0]);
      assert(first.opacity.every(alpha => alpha === 0) && first.labels.every(alpha => alpha === 0), 'first rendered growth frame is blank including labels');
      await pause(200);
      const replay = await page.evaluate(() => {
        const r = __graphProbe.latest, before = r.nodes.map(node => node._appearOpacity);
        document.querySelector('[data-action="graph-grow"]').click();
        return { view: r.engine.view, before, born: r.nodes.map(node => node._born), opacity: r.nodes.map(node => node._appearOpacity) };
      });
      assert(replay.before[0] > 0 && replay.before[0] >= replay.before.at(-1));
      assert.deepEqual(replay.view, blank.view, 'continuous replay reuses the initial growth framing');
      assert(replay.born[0] > blank.born[0]); assert(replay.opacity.every(alpha => alpha === 0));
      assert.equal(await page.evaluate(() => __graphProbe.engines.length), creates, 'replay reuses the engine');
      assert.equal(requests.filter(url => url === '/api/note-graph').length, queries, 'replay makes no data request');
      await page.waitForFunction(() => !__graphProbe.latest.engine.layoutPending && __graphProbe.latest.nodes.every(node => node._appeared)); await pause(200);
      const growth = await page.evaluate(() => { const r = __graphProbe.latest; r.track = false; return r.frames; });
      assert(growth.every(frame => JSON.stringify(frame.view) === JSON.stringify(blank.view)), 'growth never changes camera after its blank-phase framing');
      assert(growth.some(frame => frame.opacity[0] > frame.opacity.at(-1) && frame.scale[0] !== frame.scale.at(-1)), 'appearance is staggered');
      assert(growth.at(-1).opacity.every(alpha => alpha === 1));
      const draws = await page.evaluate(() => __graphProbe.draws); await pause(200);
      assert.equal(await page.evaluate(() => __graphProbe.draws), draws, 'finished growth has no ongoing rendering');
    }
    await shown(3, 1);
    assert.equal(await page.evaluate(() => T.state.activeTab), token);
    assert(!requests.includes('/graph-window.js'), 'notes do not load the floating window shell');
    assert.equal(await page.locator('[data-role="note-graph-overlay"]').count(), 0);
    assert.equal(await page.locator(`${panel} [data-role="graph-opacity"]`).count(), 0);
    assert.equal(await page.locator('.note-document-head').isVisible(), false);
    assert.equal(await page.locator(panel).evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.evaluate(() => __graphProbe.latest.engine.backendKind), ['fallback', 'shader-failure'].includes(mode) ? 'canvas2d' : 'webgl');
    await page.waitForFunction(name => Array.from(document.querySelectorAll('[data-note-graph-label]')).some(el => el.textContent === name), longName);
    await pause(6500);
    await verifyLabelFade(longName + '.md');
    await verifyPalette(false, 'A.md');
    await verifyGrowthAndSpread();
    const viewBeforeRepeat = await camera(), creates = await page.evaluate(() => __graphProbe.engines.length);
    await button.click(); await button.click();
    assert.equal(await page.locator('.note-tab.is-graph').count(), 1);
    assert.equal(await page.evaluate(() => __graphProbe.engines.length), creates, 'repeat activates without recreating');
    assert.deepEqual(await camera(), viewBeforeRepeat);
    const stage = await page.locator(`${panel} [data-role="graph-stage"]`).boundingBox();
    const pane = await page.locator('.note-document-pane').boundingBox(), tabs = await page.locator('.note-tab-bar').boundingBox();
    assert(Math.abs(stage.width - pane.width) < 2 && Math.abs(stage.height - (pane.height - tabs.height)) < 2, 'graph fills the area below the tab bar');
    if (process.env.RELATUM_ARTIFACT_DIR && mode === 'full') {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-graph-tab-full-light.png') });
    }
    const uploads = await page.evaluate(() => __graphProbe.uploads), draws = await page.evaluate(() => __graphProbe.draws);
    await pause(150); assert.equal(await page.evaluate(() => __graphProbe.draws), draws, 'stable graph stops drawing');
    await page.evaluate(() => __graphProbe.latest.engine.setPanInertia(0));
    const label = page.locator('[data-note-graph-label]').filter({ hasText: longName }).locator('span');
    const width = await label.evaluate(el => el.getBoundingClientRect().width);
    await page.mouse.move(stage.x + 5, stage.y + 5); await page.mouse.down();
    await page.mouse.move(stage.x + 35, stage.y + 22, { steps: 6 }); await page.mouse.up();
    await page.mouse.wheel(0, 90); await pause(800);
    assert(Math.abs(width - await label.evaluate(el => el.getBoundingClientRect().width)) < 1, 'zoom keeps full titles at a fixed font size');
    assert.equal(await page.evaluate(() => __graphProbe.uploads), uploads, 'static camera movement uploads zero instances');
    await page.evaluate(() => { window.__firstLabel = document.querySelector('[data-note-graph-label]'); });
    await page.evaluate(() => T.triggerExternalSync({ silentErrors: true }));
    assert(await page.evaluate(() => __firstLabel.isConnected), 'unchanged signature preserves labels');
    const savedView = await camera();
    await page.evaluate(() => T.activateTab('A.md'));
    await page.locator(panel).waitFor({ state: 'hidden' }); await resourcesReleased();
    assert.equal(await page.locator('.note-tab.is-graph').count(), 1, 'switching MD preserves the graph tab');
    await page.evaluate(() => T.setSideMode('outline')); await pause(450);
    assert(await page.evaluate(() => T.notebookUi().open && T.notebookUi().mode === 'outline'));
    await button.click(); await shown(3, 1);
    assert.deepEqual(await camera(), savedView, 'return restores the session camera');
    assert(!await page.evaluate(() => document.querySelector('[data-start-workspace-panel="notes"]').classList.contains('links-overlay-open')));
    await page.locator('[data-note-action="graph-notebooks"]').click();
    await page.locator('[data-role="note-notebooks-content"]').waitFor({ state: 'visible' }).catch(async error => {
      error.message += '\n' + JSON.stringify(await page.evaluate(() => ({
        root: document.querySelector('[data-start-workspace-panel="notes"]').className,
        active: T.state.activeTab, mode: T.state.sideMode,
        panel: getComputedStyle(document.querySelector('.note-links-pane')).visibility,
        contentHidden: document.querySelector('[data-role="note-notebooks-content"]').hidden,
        expanded: document.querySelector('[data-note-action="graph-notebooks"]').getAttribute('aria-expanded'),
      })));
      throw error;
    });
    assert.equal(await page.locator('[data-role="note-outline"]').isVisible(), false);
    await select('CustomNotebook/One', 2, 1);
    await pause(400);
    assert(await page.evaluate(() => T.notebookUi().open && T.notebookUi().mode === 'outline'), 'temporary sidebar does not overwrite MD preferences on notebook change');
    const diskTree = await (await fetch(url + '/api/notes-tree?notebookSettings=1')).json();
    assert(diskTree.notebookSettings.ui.open && diskTree.notebookSettings.ui.mode === 'outline', 'persisted sidebar preference survives graph notebook changes');
    await page.locator('[data-note-action="graph-notebooks"]').click();
    await pause(4500);
    await page.evaluate(() => __graphProbe.latest.engine.restoreView({ x: 40, y: 60, scale: .8 })); await pause(50);
    await select('CustomNotebook/Two', 2, 1); await select('CustomNotebook/One', 2, 1);
    assert.deepEqual(await camera(), { x: 40, y: 60, scale: .8 }, 'notebook cameras are independent');
    assert((await page.locator('[data-note-graph-label]').evaluateAll(list => list.map(el => el.dataset.noteGraphLabel))).every(name => name.startsWith('CustomNotebook/One/')));
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('[data-note-browser-provider="recent"]').click();
    await page.locator('[data-role="note-browser-results"]').waitFor({ state: 'visible' });
    await resourcesReleased(); assert.equal(await page.locator(panel).isVisible(), false, 'browser results release the graph');
    await button.click(); await shown(2, 1);
    await page.keyboard.press('Control+t'); await resourcesReleased();
    await button.click(); await shown(2, 1);
    await page.keyboard.press('Control+Shift+Tab'); await page.locator(panel).waitFor({ state: 'hidden' });
    await button.click(); await shown(3, 1);
    await select('CustomNotebook/One', 2, 1);
    // Node read failures do not create a broken MD tab or dismiss the graph.
    await page.evaluate(() => __graphProbe.latest.engine.fitView(false)); await pause(50);
    await page.route('**/api/note?*', route => new URL(route.request().url()).searchParams.get('path') === 'CustomNotebook/One/B.md'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test read failure"}' }) : route.continue());
    const target = await nodePoint('CustomNotebook/One/B.md'); await page.mouse.click(target.x, target.y); await pause(200);
    assert.equal(await page.evaluate(() => T.state.activeTab), token);
    assert(!await page.evaluate(() => T.state.tabs.includes('CustomNotebook/One/B.md')));
    await page.unroute('**/api/note?*'); await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => T.state.current?.path === 'CustomNotebook/One/B.md'); await resourcesReleased();
    assert(await page.evaluate(() => T.state.sideMode === 'outline' && document.querySelector('[data-start-workspace-panel="notes"]').classList.contains('links-overlay-open')), 'MD sidebar restored');
    assert.equal(await page.locator('.note-tab.is-graph').count(), 1);
    await button.click(); await shown(2, 1);
    fs.writeFileSync(path.join(notes, 'CustomNotebook/One', 'External.md'), '[[A]]');
    await page.evaluate(() => T.triggerExternalSync({ silentErrors: true })); await shown(3, 2);
    await page.locator('[data-note-graph-label="CustomNotebook/One/External.md"]').waitFor({ state: 'attached' });
    const goodCount = await page.locator('[data-note-graph-label]').count();
    await page.route('**/api/note-graph?*', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"incomplete","code":"statistics_incomplete"}' }));
    await page.evaluate(() => T.graph.checkExternalChanges());
    assert(await page.locator(`${panel} [data-note-graph-retry]`).isVisible());
    assert.equal(await page.locator('[data-note-graph-label]').count(), goodCount, 'failed refresh retains the correct scene');
    await page.unroute('**/api/note-graph?*'); await page.locator(`${panel} [data-note-graph-retry]`).click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-graph-message"]').hidden);
    await select('CustomNotebook/Empty', 0, 0); await resourcesReleased();
    assert(await page.locator(`${panel} [data-action="graph-grow"]`).isDisabled());
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert((await page.locator(`${panel} [data-role="graph-empty"]`).textContent()).includes('no notes'));
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.evaluate(() => T.selectNotebook(null)); await resourcesReleased();
    assert(await button.isDisabled()); assert(await page.locator(panel).isVisible());
    assert((await page.locator(`${panel} [data-role="note-graph-message"]`).textContent()).includes('选择笔记本'));
    await select('CustomNotebook/One', 3, 2);
    if (mode === 'full') {
      let release, arrived;
      const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { arrived = resolve; });
      await page.route('**/api/note-graph?*', async route => {
        if (new URL(route.request().url()).searchParams.get('root') === 'CustomNotebook/Two') { arrived(); await gate; }
        await route.continue();
      });
      await page.evaluate(() => T.selectNotebook('CustomNotebook/Two')); await entered;
      await page.evaluate(() => T.selectNotebook('CustomNotebook/One')); release(); await shown(3, 2); await pause(150);
      assert((await page.locator('[data-note-graph-label]').evaluateAll(list => list.map(el => el.dataset.noteGraphLabel))).every(name => name.startsWith('CustomNotebook/One/')));
      await page.unroute('**/api/note-graph?*');
      assert(await page.evaluate(() => T.movePath('CustomNotebook/One', 'CustomNotebook/Renamed')));
      await shown(3, 2);
      assert.equal(await page.evaluate(() => T.state.notebookRoot), 'CustomNotebook/Renamed');
      assert((await page.locator('[data-note-graph-label]').evaluateAll(list => list.map(el => el.dataset.noteGraphLabel))).every(name => name.startsWith('CustomNotebook/Renamed/')));
      await page.evaluate(async () => { await CanvasNoteWorkspace.deactivate(); document.querySelector('[data-start-workspace-panel="notes"]').hidden = true; });
      await resourcesReleased();
      await page.evaluate(async () => { document.querySelector('[data-start-workspace-panel="notes"]').hidden = false; await CanvasNoteWorkspace.activate(); });
      await shown(3, 2);
      await page.locator(`${panel} [data-action="graph-grow"]`).evaluate(el => el.click());
      const hiddenView = await camera();
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await resourcesReleased();
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await shown(3, 2); assert.deepEqual(await camera(), hiddenView, 'visibility return restores the session camera');
      assert(await page.evaluate(() => __graphProbe.latest.nodes.every(node => node._appeared)), 'return does not replay cancelled growth');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); await resourcesReleased();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))); await shown(3, 2);
      await page.evaluate(() => T.recycleEntry({ kind: 'folder', path: 'CustomNotebook/Renamed', name: 'Renamed' }));
      await shown(3, 1); assert.equal(await page.evaluate(() => T.state.notebookRoot), '', 'deleted notebook falls back to the default range');
    }
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await page.setViewportSize({ width: 760, height: 640 });
    assert.equal(await page.locator(`${panel} [data-note-graph-copy="relax"]`).textContent(), 'Spread');
    await page.locator(`${panel} [data-note-action="toggle-tree"]`).click();
    assert(await page.locator('.note-tree-pane').isVisible(), 'narrow graph has a reachable directory control');
    await page.locator(`${panel} [data-note-action="toggle-tree"]`).click();
    await verifyLabelFade(await page.evaluate(() => __graphProbe.latest.nodes[0].id));
    assert.equal(await page.locator(`${panel} [data-action="graph-grow"]`).getAttribute('aria-label'), 'Play graph growth animation');
    assert.equal(await page.locator(`${panel} [data-action="graph-grow"]`).getAttribute('data-ui-tooltip'), 'Play graph growth animation');
    await verifyPalette(true, await page.evaluate(() => __graphProbe.latest.nodes.find(node => node.degree > 0).id));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => T.activateTab('A.md')); await resourcesReleased();
    await page.evaluate(() => T.activateTab('relatum:graph-tab:v1')); await shown(3, 1);
    const reduced = await page.evaluate(() => {
      document.querySelector('[data-action="graph-grow"]').click();
      const r = __graphProbe.latest;
      return { opacity: r.nodes.map(node => node._appearOpacity), scale: r.nodes.map(node => node._appearScale), born: r.nodes.map(node => node._born) };
    });
    assert(reduced.opacity.every(alpha => alpha === 1) && reduced.scale.every(scale => scale === 1), 'low motion skips the blank phase and growth easing');
    assert(reduced.born.every(time => time === reduced.born[0]), 'low motion skips staggering');
    if (process.env.RELATUM_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true }); await pause(300);
      await page.evaluate(() => { const toast = document.querySelector('[data-role="note-toast"]'); if (toast) toast.hidden = true; });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, `note-graph-tab-${mode}-dark.png`) });
    }
    // Active graph identity survives restart; no MD API request uses its token.
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.waitForFunction(() => window.T?.state.initialized && T.state.active);
    await page.locator(panel).waitFor({ state: 'visible' });
    await page.waitForFunction(() => __graphProbe.latest?.nodes.length > 0);
    assert.equal(await page.locator('.note-tab.is-graph').count(), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteGraphViews:v1')), 'legacy-window-settings', 'old floating preferences are neither read nor written');
    await page.evaluate(() => T.activateTab('A.md'));
    const requestIndex = requests.length;
    await page.reload(); await page.waitForFunction(() => T?.state.initialized && T.state.active);
    assert.equal(await page.locator('.note-tab.is-graph').count(), 1);
    assert.equal(await page.locator(panel).isVisible(), false);
    assert(!requests.slice(requestIndex).includes('/note-graph.js'), 'restoring a hidden tab does not load a graph module');
    assert.equal(await page.evaluate(() => __graphProbe.engines.length), 0);
    await button.click(); await shown(3, 1);
    // Closing a graph cannot resurrect it if the following uncached MD fails to read.
    if (mode === 'full') {
      await page.evaluate(() => { T.state.tabs.push('B.md'); T.state.documentCache.delete('B.md'); });
      await page.route('**/api/note?*', route => new URL(route.request().url()).searchParams.get('path') === 'B.md'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test next-tab failure"}' }) : route.continue());
      await page.evaluate(() => T.closeTab('relatum:graph-tab:v1'));
      await resourcesReleased(); assert.equal(await page.locator(panel).isVisible(), false);
      assert(!await page.evaluate(() => T.state.tabs.includes('relatum:graph-tab:v1')));
      await page.unroute('**/api/note?*'); await page.evaluate(() => T.openNote('A.md'));
      await button.click(); await shown(3, 1);
    }
    await page.keyboard.press('Control+w'); await resourcesReleased();
    assert.equal(await page.locator('.note-tab.is-graph').count(), 0);
    await button.click(); await page.locator(panel).waitFor({ state: 'visible' });
    await page.evaluate(() => T.closeAllTabs()); await resourcesReleased();
    assert.equal(await page.evaluate(() => T.state.tabs.length), 0);
    assert.deepEqual(errors, [], mode + ': no browser errors');
    // A final uninstrumented workspace uses the same production entry and tab close action.
    await page.unroute('**/note-workspace.js*'); await page.reload(); await page.waitForFunction(() => window.CanvasNoteWorkspace);
    await button.click(); await page.locator(panel).waitFor({ state: 'visible' });
    await page.locator('.note-tab.is-graph .note-tab-close').click(); await page.locator(panel).waitFor({ state: 'hidden' });
    console.log(`note graph tab ${mode}: passed`);
  } finally {
    await context.close(); server.kill(); await pause(100);
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('relatum-note-graph-tab-')) fs.rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const available = ['full', 'notes-only', 'notes-no-canvas', 'fallback', 'shader-failure'];
  const modes = process.argv.length > 2 ? process.argv.slice(2) : available;
  assert(modes.every(mode => available.includes(mode)));
  try { for (const mode of modes) await run(browser, mode); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

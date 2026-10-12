'use strict';

// Real Edge pages and an isolated server. Browser packages belong to the test host.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { makePage, openCanvas, interactionRegression, lifecycleRegression, translationAndDualRegression, startRegression }
  = require('./canvas-browser-performance.js');
const repo = path.resolve(__dirname, '..');

function installProbe(fallback) {
  const probe = window.__canvasResources = { draws: 0, creates: 0, records: [] };
  if (fallback) {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^webgl/.test(type) ? null : get.call(this, type, ...args);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (probe.records.some(record => record.alive && record.engine.canvas === this.canvas)) probe.draws++;
      return clear.apply(this, args);
    };
  }
  let module;
  Object.defineProperty(window, 'GraphEngine', { configurable: true, get: () => module, set(value) {
    const create = value.create;
    value.create = options => {
      const sync = options.domOverlay?.sync;
      if (sync) options.domOverlay.sync = state => { probe.draws++; return sync(state); };
      const engine = create(options);
      if (engine) {
        const record = { engine, nodes: [], alive: true };
        const setData = engine.setData, destroy = engine.destroy;
        engine.setData = (nodes, ...args) => { record.nodes = nodes; return setData(nodes, ...args); };
        engine.destroy = () => { record.alive = false; record.nodes = []; return destroy(); };
        probe.records.push(record); probe.creates++;
      }
      return engine;
    };
    module = value;
  } });
  localStorage.setItem('canvas:hideSpecialPages', '0');
  localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
}

async function minimize(page, value) {
  await page.evaluate(value => {
    document.documentElement.dataset.desktopMinimized = value ? '1' : '0';
    window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: value } }));
  }, value);
}

async function graphVisibility(page, baseline) {
  await page.waitForFunction(() => window.__canvasResources.records.some(record => record.alive));
  await page.waitForTimeout(450);
  const initial = await page.evaluate(() => {
    const probe = __canvasResources, record = probe.records.findLast(record => record.alive);
    return { draws: probe.draws, creates: probe.creates, view: record.engine.view, backend: record.engine.backendKind };
  });
  await minimize(page, true);
  await minimize(page, true);
  const before = await page.evaluate(() => __canvasResources.draws);
  await page.evaluate(() => {
    const engine = __canvasResources.records.findLast(record => record.alive).engine;
    engine.heat(.2); engine.requestRender();
  });
  await page.waitForTimeout(900);
  const suspended = await page.evaluate(() => {
    const probe = __canvasResources, record = probe.records.findLast(record => record.alive);
    return { draws: probe.draws, view: record.engine.view };
  });
  if (!baseline) {
    assert.equal(suspended.draws, before, 'native minimize must stop actual rendering while document stays visible');
    assert.deepEqual(suspended.view, initial.view, 'minimize retains the camera');
  }
  await minimize(page, false);
  await minimize(page, false);
  await page.waitForTimeout(160);
  const resumed = await page.evaluate(() => ({ draws: __canvasResources.draws, creates: __canvasResources.creates }));
  assert.equal(resumed.creates, initial.creates, 'restore reuses the same graph engine');
  if (!baseline) assert(resumed.draws > suspended.draws, 'restore resumes a pending animation');
  return { backend: initial.backend, documentHidden: await page.evaluate(() => document.hidden),
    minimizedDraws: suspended.draws - before, restoredDraws: resumed.draws - suspended.draws, creates: resumed.creates };
}

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

(async () => {
  const compare = process.argv.includes('--compare');
  const baselineRef = process.env.RELATUM_CANVAS_BASELINE_REF || 'HEAD';
  const currentCanvas = fs.readFileSync(path.join(repo, 'assets/canvas.js'), 'utf8');
  const oldCanvas = compare ? execFileSync('git', ['show', baselineRef + ':assets/canvas.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : '';
  const oldGraph = compare ? execFileSync('git', ['show', baselineRef + ':assets/graph-engine.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : '';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-perf-'));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const python = process.env.RELATUM_PYTHON || 'python';
  execFileSync(python, ['-B', 'tests/generate-performance-fixtures.py', root], { cwd: repo, windowsHide: true });
  const nodes = [], edges = [];
  for (let i = 0; i < 16; i++) {
    nodes.push({ id: 'a' + i, kind: 'text', text: '起点 ' + i, x: 120 + i * 100, y: 120 + i * 100, width: 120, height: 60 },
      { id: 'b' + i, kind: 'text', text: '远处 ' + i, x: 65536 + i * 100, y: 65536 + i * 100, width: 120, height: 60 });
    edges.push({ id: 'e' + i, from: 'a' + i, to: 'b' + i, curve: 'straight', arrow: 'end' });
  }
  fs.writeFileSync(path.join(root, 'canvases/long-spatial.canvas'), JSON.stringify({ version: 2, nodes, edges }));
  const server = spawn(python, ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { measuredAt: new Date().toISOString(), samples: [], visibility: [] };
  report.baselineRef = compare ? baselineRef : null;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/runtime')).ok) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'isolated server starts');
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
    report.browser = browser.version();
    for (let run = 0; run < 3; run++) for (const baseline of compare ? [true, false] : [false]) {
      const page = await makePage(browser, { protectFixtures: true, dpr: run === 1 ? 2 : 1, reduced: run === 1 });
      await page.context().addInitScript(installProbe, run === 2);
      const canvasSource = (baseline ? oldCanvas : currentCanvas).replace('    function queryEdgeGeometry(bounds) {', `
    window.__testFarEdgePoint = function (id) {
      ensureEdgeGeometryCache();
      const p = edgePathCache.get(id).midpoint, rect = cachedViewportRect();
      setViewportImmediate(1, rect.width / 2 - p.x, rect.height / 2 - p.y);
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    function queryEdgeGeometry(bounds) {`);
      await page.route('**/canvas.js*', route => route.fulfill({ contentType: 'text/javascript', body: canvasSource }));
      if (baseline) {
        await page.route('**/graph-engine.js*', route => route.fulfill({ contentType: 'text/javascript', body: oldGraph }));
      }
      try {
        const cdp = await page.context().newCDPSession(page);
        await openCanvas(page, { url, root }, 'long-spatial');
        if (run === 1) await page.evaluate(() => {
          document.body.dataset.backgroundTone = 'dark'; document.body.classList.add('dark-semantic-ui');
          document.dispatchEvent(new Event('canvas:edge-visual-refresh'));
        });
        await page.waitForTimeout(250);
        await cdp.send('HeapProfiler.collectGarbage');
        const sample = await page.evaluate(() => ({ opening: __relatumPerfSnapshot().opening,
          edges: __relatumPerfSnapshot().edges, heapBytes: performance.memory?.usedJSHeapSize }));
        sample.baseline = baseline; sample.run = run; sample.dpr = run === 1 ? 2 : 1;
        if (!baseline) { assert.equal(sample.edges.spatialRefs, 0); assert.equal(sample.edges.spatialOverflow, 16); }
        // A far-away crossing remains drawable and selectable, preserving topmost order.
        const point = await page.evaluate(() => __testFarEdgePoint('e15'));
        const crossing = await page.evaluate(() => {
          const snap = __relatumPerfSnapshot();
          return { svg: snap.edges.svgPaths, cache: snap.edges.geometryCache };
        });
        assert.equal(crossing.cache, 16);
        await page.mouse.dblclick(point.x, point.y);
        assert.equal(await page.locator('.canvas-edge-label.editing').getAttribute('data-id'), 'e15', 'overflow edges preserve reverse stacking hit tests');
        await page.keyboard.press('Escape');
        await page.locator('[data-action="graph"]').evaluate(button => button.click());
        const visibility = await graphVisibility(page, baseline);
        report.visibility.push({ host: 'editor', baseline, run, ...visibility });
        await page.locator('[data-action="graph-close"]').click();
        await page.waitForFunction(() => document.querySelector('[data-role="graph-overlay"]').hidden);
        assert(await page.evaluate(() => __canvasResources.records.every(record => !record.alive)));
        await page.goto(url + '/');
        await page.locator('.left-spine [data-action="cadence-view"]').click();
        report.visibility.push({ host: 'activity', baseline, run, ...await graphVisibility(page, baseline) });
        await page.locator('.left-spine .page-dot[data-group-id=""]').click();
        await page.waitForTimeout(1100);
        assert(await page.evaluate(() => __canvasResources.records.every(record => !record.alive)), 'leaving still destroys star resources');
        assert.deepEqual(page.testErrors, []);
        report.samples.push(sample); console.log(JSON.stringify({ run, baseline, edges: sample.edges, heapBytes: sample.heapBytes }));
        await cdp.detach();
      } finally { await page.context().close(); }
    }
    if (process.argv.includes('--regression')) {
      const config = { url, root };
      report.regressions = [];
      for (const options of [{}, { dark: true, dpr: 2, reduced: true }, { fallback: true }]) {
        report.regressions.push(await interactionRegression(browser, config, options));
      }
      report.lifecycle = await lifecycleRegression(browser, config);
      report.translationAndDual = await translationAndDualRegression(browser, config);
      report.start = await startRegression(browser, config);
    }
    const output = process.env.RELATUM_CANVAS_RESOURCE_REPORT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.visibility));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    const target = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    assert(path.dirname(target) === parent && path.basename(target).startsWith('relatum-canvas-perf-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

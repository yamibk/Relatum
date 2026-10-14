'use strict';

// Host-provided Edge/Playwright, isolated service and synthetic Research data.
// Counters are injected only by this test; the application has no profiling API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const baselineRef = process.env.RELATUM_RESEARCH_BASELINE_REF || 'HEAD';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function fixture() {
  return { researchVersion: 3, subcircuits: [], activePageId: 'visibility', pages: [{
    id: 'visibility', title: '', nodes: [{ id: 'clock', type: 'clock', label: 'Clock',
      x: 520, y: 260, width: 168, height: 80, config: { periodMs: 32 }, statePolicy: 'reset' }],
    edges: [], view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 },
  }] };
}

async function intercept(page) {
  const document = fixture(), saves = [];
  await page.route('**/api/research/workspace', async (route) => {
    if (route.request().method() === 'POST') saves.push(route.request().postDataJSON().document);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      document: saves.at(-1) || document, revision: 'isolated-' + saves.length,
    }) });
  });
  if (baseline) {
    const files = ['research-canvas.js', 'research-model.js', 'research-orthogonal.js',
      'research-decoration-canvas.js', 'research-editor.js', 'research-runtime.js'];
    for (const name of files) {
      const body = execFileSync('git', ['show', baselineRef + ':assets/research/' + name], { cwd: repo, encoding: 'utf8' });
      await page.route('**/research/' + name, (route) => route.fulfill({ contentType: 'text/javascript', body }));
    }
  }
  return saves;
}

async function mountSample(browser, url, count, dpr = 1, narrow = false) {
  const context = await browser.newContext({ viewport: { width: narrow ? 900 : 1440, height: 900 },
    deviceScaleFactor: dpr, reducedMotion: narrow ? 'no-preference' : 'reduce', colorScheme: narrow ? 'dark' : 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await intercept(page); await page.goto(url + '/research.html');
  if (narrow) await page.evaluate(() => RelatumResearchWorkspace.setLanguage('en'));
  await page.evaluate(async (count) => {
    const [{ createResearchCanvas }, { createResearchModel }, { loadResearchRegistry }, { DecorationIndex }] = await Promise.all([
      import('/research/research-canvas.js'), import('/research/research-model.js'),
      import('/research/research-registry.js'), import('/research/research-orthogonal.js'),
    ]);
    const registry = await loadResearchRegistry();
    const nodes = Array.from({ length: count }, (_, i) => ({ ...registry.createNode('constant', {
      config: { value: { type: 'number', value: i } },
    }), id: 'node-' + i, label: 'Constant ' + i, x: (i % 40) * 220, y: Math.floor(i / 40) * 130,
    width: 168, height: 80 }));
    const model = createResearchModel({ nodes, edges: [] }, registry);
    window.__researchPerf = { createResearchCanvas, createResearchModel, registry, model, DecorationIndex };
  }, count);
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  const mountMs = await page.evaluate(() => {
    const p = window.__researchPerf, start = performance.now();
    p.canvas = p.createResearchCanvas({ stage: document.querySelector('[data-research-stage]'), model: p.model,
      registry: p.registry, view: { x: 28, y: 28, scale: .25 } });
    return performance.now() - start;
  });
  const after = await metrics();
  await page.evaluate(() => window.__researchPerf.canvas.activate());
  await sleep(150);
  const projection = await page.evaluate(() => {
    const p = window.__researchPerf, canvas = p.canvas;
    const initial = Object.fromEntries(p.model.nodes().map((n, i) => [n.id, { output: { type: 'number', value: i }, outputs: {} }]));
    canvas.setComputeProjection(initial);
    const observer = new MutationObserver(() => {});
    observer.observe(document.querySelector('[data-research-surface]'), { subtree: true, childList: true, attributes: true, characterData: true });
    const start = performance.now(); canvas.setComputeProjection(initial);
    const repeatMs = performance.now() - start, repeatedMutations = observer.takeRecords().length;
    canvas.setComputeProjection({ ...initial, 'node-0': { output: { type: 'number', value: 12345 }, outputs: {} } });
    const changedMutations = observer.takeRecords().length;
    const text = document.querySelector('[data-node-id="node-0"] [data-compute-result]').textContent;
    observer.disconnect();
    const buffers = [...document.querySelectorAll('canvas.research-decorations')].map((c) => c.width * c.height);
    return { repeatMs, repeatedMutations, changedMutations, text, decorationPixels: buffers.reduce((a, b) => a + b, 0) };
  });
  assert.equal(await page.locator('[data-node-id]').count(), count);
  assert.equal(projection.text, '= 12345');
  if (!baseline) {
    // Includes the fixed viewport/minimap shell measurements, not just nodes.
    assert(after.LayoutCount - before.LayoutCount <= 6,
      'mounting must batch DOM writes before layout reads: ' + JSON.stringify({ count, mountMs,
        layouts: after.LayoutCount - before.LayoutCount }));
    assert.equal(projection.repeatedMutations, 0, 'identical projection must leave node DOM untouched');
    assert(projection.changedMutations <= 2, 'one changed output must only update that output');
    assert.equal(projection.decorationPixels, 1, 'unused decoration canvas must release its full-size backing store');
    if (narrow) {
      await page.evaluate(() => {
        const p = window.__researchPerf;
        p.errorProjection = { 'node-0': { error: { code: 'test', message: '除数不能为零' } } };
        p.canvas.setComputeProjection(p.errorProjection);
      });
      await sleep(50);
      assert.equal(await page.locator('[data-node-id="node-0"] [data-compute-result]').textContent(), 'Error · The divisor cannot be zero');
      assert.equal(await page.evaluate(() => {
        const p = window.__researchPerf, observer = new MutationObserver(() => {});
        observer.observe(document.querySelector('[data-research-surface]'), { subtree: true, attributes: true, childList: true });
        p.canvas.setComputeProjection(p.errorProjection);
        const changes = observer.takeRecords().length; observer.disconnect(); return changes;
      }), 0, 'localized error results must also skip identical DOM writes');
    }
  }
  const decoration = await page.evaluate(() => {
    const p = window.__researchPerf;
    p.canvas.dispose();
    const objects = Array.from({ length: 3000 }, (_, i) => ({ id: 'decoration-' + i, kind: 'line',
      x: (i % 60) * 120, y: Math.floor(i / 60) * 120, direction: 0, units: 2, unitLength: 40,
      width: 2, lineStyle: 'solid', color: 'mono', arrowhead: 'none' }));
    p.model = p.createResearchModel({ nodes: [], edges: [], decorations: objects }, p.registry);
    p.canvas = p.createResearchCanvas({ stage: document.querySelector('[data-research-stage]'), model: p.model, registry: p.registry });
    p.canvas.setEditorMode('orthogonal'); p.canvas.activate();
    const rebuild = p.DecorationIndex.prototype.rebuild, reindex = p.model.reindex;
    let rebuiltObjects = 0, modelReindexes = 0;
    p.DecorationIndex.prototype.rebuild = function (objects) { rebuiltObjects += objects.length; return rebuild.call(this, objects); };
    p.model.reindex = function () { modelReindexes++; return reindex.call(this); };
    const observer = new MutationObserver(() => {});
    observer.observe(document.querySelector('[data-research-minimap-nodes]'), { subtree: true, attributes: true });
    const start = performance.now();
    for (let i = 0; i < 30; i++) p.model.updateDecorations({ 'decoration-100': { y: 150 + i } }, { live: true });
    const durationMs = performance.now() - start;
    const minimapWrites = observer.takeRecords().length; observer.disconnect();
    p.DecorationIndex.prototype.rebuild = rebuild; p.model.reindex = reindex;
    return { durationMs, rebuiltObjects, modelReindexes, minimapWrites, y: p.model.decoration('decoration-100').y };
  });
  assert.equal(decoration.y, 179);
  if (!baseline) {
    assert.equal(decoration.rebuiltObjects, 0, 'live edits must not rebuild unrelated decoration bounds');
    assert.equal(decoration.modelReindexes, 0, 'live edits must not reindex the whole model');
    assert(decoration.minimapWrites <= 150, 'live edits must only move the affected minimap dot');
    const longLineGridWrites = await page.evaluate(() => {
      const p = window.__researchPerf;
      p.canvas.setEditorMode('default');
      const set = Map.prototype.set; let gridWrites = 0;
      Map.prototype.set = function (key, value) {
        if (typeof key === 'string' && /^-?\d+:-?\d+$/.test(key)) gridWrites++;
        return set.call(this, key, value);
      };
      try {
        p.model.restore({ nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({
          ...p.registry.createNode('note'), id, label: id, x: i % 2 ? 1e7 : -1e7, y: 300,
          width: 168, height: 80,
        })), edges: [{ id: 'long-first', kind: 'relation', fromNodeId: 'a', toNodeId: 'b' },
          { id: 'long-second', kind: 'relation', fromNodeId: 'c', toNodeId: 'd' }], decorations: [] });
      } finally { Map.prototype.set = set; }
      return gridWrites;
    });
    assert.equal(longLineGridWrites, 0, 'oversized lines must use bounded candidates instead of allocating world cells');
    await page.mouse.click(650, 340);
    assert.deepEqual(await page.evaluate(() => window.__researchPerf.canvas.getSelection().edgeIds), ['long-first'],
      'long lines must retain their mid-span hit and tie order');
    await page.evaluate(() => {
      const p = window.__researchPerf;
      p.model.remove([], ['long-first']); p.canvas.clearSelection();
    });
    await page.mouse.click(650, 340);
    assert.deepEqual(await page.evaluate(() => window.__researchPerf.canvas.getSelection().edgeIds), ['long-second']);
    await page.evaluate(() => {
      const p = window.__researchPerf;
      const before = p.model.capture();
      p.model.moveNodes({ c: { x: -1e7, y: 500 }, d: { x: 1e7, y: 500 } });
      p.model.commitFrom(before, { kind: 'node-move', nodeIds: ['c', 'd'], alreadyEmitted: true });
      p.canvas.clearSelection();
    });
    await page.mouse.click(650, 340);
    assert.deepEqual(await page.evaluate(() => window.__researchPerf.canvas.getSelection().edgeIds), [], 'old long-line bounds must be cleared');
    await page.mouse.click(650, 540);
    assert.deepEqual(await page.evaluate(() => window.__researchPerf.canvas.getSelection().edgeIds), ['long-second']);
    await page.evaluate(() => {
      const p = window.__researchPerf;
      p.model.undo(); p.canvas.clearSelection();
    });
    await page.mouse.click(650, 340);
    assert.deepEqual(await page.evaluate(() => window.__researchPerf.canvas.getSelection().edgeIds), ['long-second']);
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.__researchPerf.canvas.dispose());
  await context.close();
  return { count, dpr, narrow, mountMs, mountLayouts: after.LayoutCount - before.LayoutCount,
    mountLayoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, projection, decoration };
}

async function visibilitySample(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); const saves = await intercept(page);
  await page.addInitScript(() => {
    localStorage.setItem('canvas:startWorkspace:v1', 'research');
    localStorage.setItem('canvas:runtimePreload:v1', '0');
    const tick = window.requestAnimationFrame;
    window.__researchDraws = 0;
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args) { window.__researchDraws++; return stroke.apply(this, args); };
    window.__researchFrames = 0;
    window.requestAnimationFrame = (callback) => tick((time) => { window.__researchFrames++; callback(time); });
  });
  await page.goto(url + '/index.html');
  await page.locator('button[data-start-workspace="research"]').click();
  const frame = await page.waitForEvent('framenavigated', { predicate: (f) => f.url().endsWith('/research.html'), timeout: 1000 }).catch(() =>
    page.frames().find((f) => f.url().endsWith('/research.html')));
  assert(frame, 'homepage must mount its Research iframe');
  await frame.waitForSelector('[data-node-id="clock"]');
  await frame.locator('[data-research-run]').click();
  const pulse = () => frame.locator('[data-node-id="clock"] [data-compute-result]').textContent();
  await sleep(160); const running = await pulse();
  const notify = (minimized) => page.evaluate((minimized) => {
    document.documentElement.dataset.desktopMinimized = minimized ? '1' : '0';
    window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized } }));
  }, minimized);
  await notify(true); await sleep(80);
  const frozen = await pulse(), before = await frame.evaluate(() => window.__researchFrames);
  await sleep(220); const after = await frame.evaluate(() => window.__researchFrames), still = await pulse();
  await notify(true); await notify(false); await sleep(160); const restored = await pulse();
  if (!baseline) {
    assert.equal(still, frozen, 'native minimization must freeze simulation');
    assert.equal(after, before, 'native minimization must stop Research RAF work');
  }
  assert.notEqual(running, restored, 'restore must resume the previous run intent');
  await frame.evaluate(() => RelatumResearchWorkspace.suspend());
  const inactive = await pulse(); await notify(true); await notify(false); await sleep(160);
  assert.equal(await pulse(), inactive, 'restore must not reactivate a suspended workspace');
  await frame.evaluate(() => RelatumResearchWorkspace.activate());
  await frame.locator('[data-research-pause]').click(); await sleep(180);
  const paused = await pulse(); await notify(true); await notify(false); await sleep(160);
  assert.equal(await pulse(), paused, 'an explicit pause must survive minimization');
  if (!baseline) {
    await frame.locator('[data-research-run]').click();
    await frame.evaluate(() => {
      window.__testResearchHidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__testResearchHidden });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(80); const hidden = await pulse();
    await sleep(160); assert.equal(await pulse(), hidden, 'document visibility must freeze simulation too');
    await frame.evaluate(() => { window.__testResearchHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(160); assert.notEqual(await pulse(), hidden);
  }
  await frame.evaluate(() => RelatumResearchWorkspace.dispose());
  assert(saves.every((doc) => !JSON.stringify(doc).includes('simulationTime')), 'transient simulation state must not be saved');
  await context.close();
  return { froze: still === frozen, hiddenFrames: after - before, restored: restored !== running };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-research-perf-'));
  const port = await freePort(), url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root, PYTHONUTF8: '1' }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/runtime')).ok) { ready = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert(ready, 'isolated service must start');
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || undefined });
    const rounds = Math.min(5, Math.max(1, Number(process.env.RELATUM_RESEARCH_ROUNDS) || 1));
    const report = { baseline, baselineRef: baseline ? baselineRef : undefined, rounds, browser: browser.version(), samples: [] };
    for (const count of [1200, 3000]) for (let round = 0; round < rounds; round++)
      report.samples.push({ round, ...await mountSample(browser, url, count) });
    if (!baseline) report.samples.push(await mountSample(browser, url, 1200, 2, true));
    report.visibility = await visibilitySample(browser, url);
    if (process.env.RELATUM_RESEARCH_REPORT) fs.writeFileSync(process.env.RELATUM_RESEARCH_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    server.kill();
    if (server.exitCode == null) await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 2000); });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

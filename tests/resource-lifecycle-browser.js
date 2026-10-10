'use strict';
// Real Edge/WebGL/audio checks; all writes belong to a disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function instrumentResources() {
  const stats = window.__resources = { contexts: 0, activeContexts: 0, buffers: 0, programs: 0, sourcesStarted: 0, sourcesStopped: 0, audioBuffers: [] };
  const seen = new WeakSet();
  const originalContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = originalContext.apply(this, args);
    if (context && /^webgl/.test(args[0]) && !seen.has(context)) {
      seen.add(context);
      stats.contexts++;
      stats.activeContexts++;
      this.addEventListener('webglcontextlost', () => stats.activeContexts--, { once: true });
      for (const [create, remove, key] of [['createBuffer', 'deleteBuffer', 'buffers'], ['createProgram', 'deleteProgram', 'programs']]) {
        const make = context[create], drop = context[remove];
        context[create] = function (...a) { const item = make.apply(this, a); if (item) stats[key]++; return item; };
        context[remove] = function (item) { if (item) stats[key]--; return drop.call(this, item); };
      }
    }
    return context;
  };
  const proto = (window.AudioContext || window.webkitAudioContext)?.prototype;
  if (proto) {
    const createBuffer = proto.createBuffer, decode = proto.decodeAudioData;
    proto.createBuffer = function (...args) {
      const buffer = createBuffer.apply(this, args);
      stats.audioBuffers.push({ ref: new WeakRef(buffer), bytes: buffer.length * buffer.numberOfChannels * 4, duration: buffer.duration });
      return buffer;
    };
    proto.decodeAudioData = function (...args) {
      return decode.apply(this, args).then(buffer => {
        stats.audioBuffers.push({ ref: new WeakRef(buffer), bytes: buffer.length * buffer.numberOfChannels * 4, duration: buffer.duration });
        return buffer;
      });
    };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) { stats.sourcesStarted++; return start.apply(this, args); };
    AudioBufferSourceNode.prototype.stop = function (...args) { stats.sourcesStopped++; return stop.apply(this, args); };
  }
  localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
  localStorage.setItem('canvas:focusNoise', '1');
  localStorage.setItem('canvas:hideSpecialPages', '0');
}

async function snapshot(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  return page.evaluate(() => {
    const s = window.__resources;
    return {
      contexts: s.contexts, activeContexts: s.activeContexts, buffers: s.buffers, programs: s.programs,
      audioSources: s.sourcesStarted - s.sourcesStopped,
      retainedPCMBytes: s.audioBuffers.reduce((n, item) => n + (item.ref.deref() ? item.bytes : 0), 0),
      audioBufferSizes: s.audioBuffers.map(item => ({ bytes: item.bytes, duration: item.duration })),
      graphLabels: document.querySelectorAll('.ge-dom-overlay > *').length,
      heapBytes: performance.memory?.usedJSHeapSize,
      scripts: Array.from(document.scripts, script => new URL(script.src || location.href).pathname),
    };
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-resources-'));
  const canvasDir = path.join(root, 'canvases');
  fs.mkdirSync(canvasDir);
  const canvas = path.join(canvasDir, 'resource-test.canvas');
  fs.writeFileSync(canvas, JSON.stringify({ nodes: Array.from({ length: 300 }, (_, i) => ({ id: String(i), kind: 'text', text: `节点 ${i}`, x: i % 20 * 220, y: Math.floor(i / 20) * 120, width: 200, height: 100 })), edges: Array.from({ length: 299 }, (_, i) => ({ id: 'e' + i, from: String(i), to: String(i + 1), fromSide: 'right', toSide: 'left' })) }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const args = ['app.py', '--no-browser', '--port', String(port)];
  if (process.argv.includes('--on-demand')) args.push('--launch-profile', JSON.stringify({ version: 1, features: { 'runtime.preload': false } }));
  const server = spawn(process.env.RELATUM_PYTHON || 'python', args, { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const report = { measuredAt: new Date().toISOString(), baseline, onDemand: process.argv.includes('--on-demand'), samples: [] };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/runtime')).ok) { ready = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert(ready, 'isolated server starts');
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH, args: ['--autoplay-policy=no-user-gesture-required'] });
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
      await context.addInitScript(instrumentResources);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/editor.html?file=' + encodeURIComponent(canvas));
      await page.waitForFunction(() => document.body.classList.contains('canvas-ready'));
      await sleep(3500);
      const editorIdle = await snapshot(page);
      if (!baseline) assert.equal(editorIdle.buffers, 0, 'unopened graph allocates no GPU buffers');
      for (let i = 0; i < 3; i++) {
        await page.locator('[data-action="graph"]').evaluate(button => button.click());
        await page.waitForFunction(() => !document.querySelector('[data-role="graph-overlay"]').hidden);
        await sleep(700);
        if (!baseline && i === 0) {
          assert.equal(await page.locator('[data-role="graph-edge-count"]').textContent(), '299', 'fixture has real graph edges');
          await page.waitForFunction(() => document.querySelector('.ge-dom-overlay')?.childElementCount > 0, null, { timeout: 15000 });
        }
        const open = await snapshot(page);
        assert(open.buffers > 0 && open.programs > 0, 'open graph renders with WebGL');
        await page.locator('[data-action="graph-close"]').click();
        await page.waitForFunction(() => document.querySelector('[data-role="graph-overlay"]').hidden);
        const closed = await snapshot(page);
        if (!baseline) {
          assert.equal(closed.buffers, 0, 'close deletes graph GPU buffers');
          assert.equal(closed.programs, 0, 'close deletes graph shaders');
          assert.equal(closed.activeContexts, 0, 'close releases the WebGL context');
          assert.equal(closed.graphLabels, 0, 'close releases node label DOM');
        }
        report.samples.push({ reducedMotion, gesture: i, editorIdle, open, closed });
      }
      if (!baseline && reducedMotion === 'no-preference') {
        await page.locator('[data-action="graph"]').evaluate(button => button.click());
        await page.locator('[data-action="graph-close"]').evaluate(button => button.click());
        await page.locator('[data-action="graph"]').evaluate(button => button.click());
        await sleep(500);
        assert(await page.locator('[data-role="graph-overlay"]').evaluate(el => !el.hidden), 'stale close cannot hide a reopened graph');
        assert.equal((await snapshot(page)).buffers, 4, 'reopening during close keeps one engine');
        await page.locator('[data-action="graph-close"]').click();
        await page.waitForFunction(() => document.querySelector('[data-role="graph-overlay"]').hidden);
        assert.equal((await snapshot(page)).activeContexts, 0);
      }
      console.log(`graph ${reducedMotion}: idle ${editorIdle.buffers} GPU buffers; closed ${report.samples.at(-1).closed.buffers}`);
      assert.deepEqual(errors, [], 'graph open/close has no script errors');
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await context.addInitScript(instrumentResources);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/');
    await page.waitForFunction(() => window.CanvasFocus);
    await sleep(3500);
    report.homeIdle = await snapshot(page);
    if (!baseline) assert.equal(report.homeIdle.buffers, 0, 'hidden star graph allocates no GPU buffers');
    if (report.onDemand) {
      assert(!report.homeIdle.scripts.includes('/note-workspace.js'), 'notes runtime waits for use');
      assert(!report.homeIdle.scripts.includes('/career-report.js'), 'career runtime waits for use');
    }
    await page.locator('.left-spine [data-action="cadence-view"]').waitFor({ state: 'visible', timeout: 10000 }).catch(async error => {
      error.message += '\n' + JSON.stringify(await page.evaluate(() => ({
        body: document.body.className, workspace: document.body.dataset.startWorkspace, hideSpecial: document.body.dataset.hideSpecial,
        cadence: getComputedStyle(document.querySelector('.cadence-spine-tab')).display,
        parents: Array.from(document.querySelector('.left-spine').parentElement.parentElement.children).map(el => ({ tag: el.tagName, classes: el.className, hidden: el.hidden })),
      })));
      throw error;
    });
    await page.locator('.left-spine [data-action="cadence-view"]').click();
    await page.waitForFunction(() => window.__resources.buffers > 0, null, { timeout: 10000 });
    report.starOpen = await snapshot(page);
    if (!baseline) {
      await page.evaluate(() => window.RelatumStartWorkspace.set('notes', { animate: false }));
      await sleep(1100);
      assert.equal((await snapshot(page)).activeContexts, 0, 'workspace switch releases the star graph');
      await page.evaluate(() => window.RelatumStartWorkspace.set('canvas', { animate: false }));
      await page.waitForFunction(() => window.__resources.buffers > 0);
    }
    await page.locator('.left-spine [data-action="focus-view"]').click();
    await page.evaluate(() => {
      window.CanvasFocus.showTimer({ animate: false });
    });
    await sleep(1100);
    report.starClosed = await snapshot(page);
    if (!baseline) {
      assert.equal(report.starClosed.buffers, 0, 'leaving star graph releases GPU buffers');
      assert.equal(report.starClosed.activeContexts, 0, 'leaving star graph releases its context');
    }
    // Allow graph changes to verify both hosts without running the independent audio suite.
    if (process.argv.includes('--graph-only')) {
      assert.deepEqual(errors, [], 'star graph transitions have no script errors');
      await context.close();
      if (process.env.RELATUM_RESOURCE_REPORT) fs.writeFileSync(process.env.RELATUM_RESOURCE_REPORT, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ graphOnly: true, onDemand: report.onDemand, starClosedBuffers: report.starClosed.buffers,
        starClosedContexts: report.starClosed.activeContexts, homeIdleBuffers: report.homeIdle.buffers }));
      return;
    }
    await page.locator('[data-role="focus-primary"]').click();
    await page.waitForFunction(() => window.__resources.sourcesStarted > 0, null, { timeout: 20000 });
    await sleep(500);
    report.rainPlaying = await snapshot(page);
    await page.locator('[data-role="focus-primary"]').click();
    await sleep(2200);
    report.rainPaused = await snapshot(page);
    if (!baseline) assert.equal(report.rainPaused.audioSources, 0, 'pause stops the rain loop after fading');
    // Short pauses reuse the PCM and rapid pause/resume cancels the deferred stop.
    await page.locator('[data-role="focus-primary"]').click();
    await sleep(100);
    assert.equal((await snapshot(page)).audioSources, 1);
    await page.locator('[data-role="focus-primary"]').click();
    await sleep(100);
    await page.locator('[data-role="focus-primary"]').click();
    await sleep(2200);
    assert.equal((await snapshot(page)).audioSources, 1, 'resume cancels pending source stop');
    if (!baseline) {
      await page.locator('[data-role="focus-primary"]').click();
      await sleep(30500);
      const expired = await snapshot(page);
      assert.equal(expired.audioSources, 0, 'long pause leaves no looping source');
      assert.equal(expired.retainedPCMBytes, 0, 'pause cache expires after 30 seconds');
      report.rainCacheExpired = expired;
      await page.locator('[data-role="focus-primary"]').click();
      await page.waitForFunction(() => window.__resources.sourcesStarted - window.__resources.sourcesStopped === 1);
    }
    await page.locator('[data-action="focus-settings"]').click();
    await page.locator('[data-role="focus-set-noise"]').uncheck();
    await sleep(2200);
    report.rainDisabled = await snapshot(page);
    if (!baseline) assert.equal(report.rainDisabled.retainedPCMBytes, 0, 'disable releases decoded PCM');
    if (!baseline) {
      await page.locator('[data-role="focus-set-noise"]').check();
      await page.waitForFunction(() => window.__resources.sourcesStarted - window.__resources.sourcesStopped === 1);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      report.pageHidden = await snapshot(page);
      assert.equal(report.pageHidden.audioSources, 0, 'pagehide stops the audio source');
      assert.equal(report.pageHidden.retainedPCMBytes, 0, 'pagehide releases PCM');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.waitForFunction(() => window.__resources.sourcesStarted - window.__resources.sourcesStopped === 1);
      await page.locator('[data-role="focus-set-noise"]').uncheck();
      await sleep(2200);
      // Abort a late fetch and ensure its result cannot reactivate or retain PCM.
      await page.route('**/audio/rain.mp3', async route => {
        await sleep(500);
        await route.continue().catch(() => {});
      });
      await page.locator('[data-role="focus-set-noise"]').check();
      await sleep(50);
      await page.locator('[data-role="focus-set-noise"]').uncheck();
      await sleep(1000);
      const aborted = await snapshot(page);
      assert.equal(aborted.audioSources, 0, 'late audio request does not restart');
      assert.equal(aborted.retainedPCMBytes, 0, 'late audio request does not retain PCM');
      await page.unroute('**/audio/rain.mp3');
      await page.evaluate(() => {
        const original = AudioContext.prototype.decodeAudioData;
        window.__lateDecode = { pending: 0, completed: 0 };
        AudioContext.prototype.decodeAudioData = function (...args) {
          window.__lateDecode.pending++;
          return original.apply(this, args)
            .then(buffer => new Promise(resolve => setTimeout(() => resolve(buffer), 700)))
            .finally(() => { window.__lateDecode.pending--; window.__lateDecode.completed++; });
        };
      });
      await page.locator('[data-role="focus-set-noise"]').check();
      await page.waitForFunction(() => window.__lateDecode.pending > 0, null, { timeout: 20000 });
      await page.locator('[data-role="focus-set-noise"]').uncheck();
      // Native decoding time varies; collect only after the deliberately delayed result settles.
      await page.waitForFunction(() => window.__lateDecode.completed > 0 && window.__lateDecode.pending === 0, null, { timeout: 20000 });
      const lateDecode = await snapshot(page);
      assert.equal(lateDecode.audioSources, 0, 'late decoding does not restart');
      assert.equal(lateDecode.retainedPCMBytes, 0, 'late decoding does not retain PCM');
    }
    assert.deepEqual(errors, [], 'focus audio has no script errors');
    await context.close();
    if (report.onDemand && !baseline) {
      const retryContext = await browser.newContext({ reducedMotion: 'reduce' });
      await retryContext.addInitScript(instrumentResources);
      const retryPage = await retryContext.newPage();
      const attempts = {};
      for (const resource of ['graph-gl.js', 'ai.js', 'vendor/codemirror/relatum-codemirror.min.js', 'career-report.js']) {
        attempts[resource] = 0;
        await retryPage.route(base + '/' + resource, route => ++attempts[resource] === 1 ? route.abort() : route.continue());
      }
      await retryPage.goto(base + '/editor.html?file=' + encodeURIComponent(canvas));
      await retryPage.waitForFunction(() => document.body.classList.contains('canvas-ready'));
      for (const selector of ['[data-action="graph"]', '[data-role="ai-toggle"]']) {
        await retryPage.locator(selector).evaluate(button => button.click());
        await retryPage.waitForFunction(selector => !document.querySelector(selector).hasAttribute('aria-busy'), selector);
        await retryPage.locator(selector).evaluate(button => button.click());
        await retryPage.waitForFunction(selector => !document.querySelector(selector).hasAttribute('aria-busy'), selector);
      }
      assert.equal(attempts['graph-gl.js'], 2, 'graph can retry a failed script');
      assert.equal(attempts['ai.js'], 2, 'AI can retry a failed script');
      report.graphRetryAttempts = attempts['graph-gl.js'];
      await retryPage.goto(base + '/');
      await retryPage.waitForFunction(() => window.RelatumStartWorkspace);
      for (const name of ['notes', 'career']) {
        assert.equal(await retryPage.evaluate(name => window.RelatumStartWorkspace.set(name, { animate: false }), name), false);
        assert.equal(await retryPage.evaluate(name => window.RelatumStartWorkspace.set(name, { animate: false }), name), true);
      }
      assert.equal(attempts['vendor/codemirror/relatum-codemirror.min.js'], 2, 'notes can retry a failed runtime');
      assert.equal(attempts['career-report.js'], 2, 'career can retry a failed runtime');
      report.retryAttempts = attempts;
      await retryContext.close();
    }
    if (process.env.RELATUM_RESOURCE_REPORT) fs.writeFileSync(process.env.RELATUM_RESOURCE_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ homeHeapBytes: report.homeIdle.heapBytes, starClosedBuffers: report.starClosed.buffers, pausedSources: report.rainPaused.audioSources, disabledPCMBytes: report.rainDisabled.retainedPCMBytes, expiredPCMBytes: report.rainCacheExpired?.retainedPCMBytes, graphRetryAttempts: report.graphRetryAttempts }));
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    assert(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('relatum-resources-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

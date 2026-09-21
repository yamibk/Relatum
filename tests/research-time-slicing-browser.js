'use strict';

// Optional real-browser performance/acceptance harness. The fixture is served
// through the normal Research persistence boundary and never touches user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_COUNT = 1000;
const PERIOD_MS = 16;
const TARGET_BATCHES = 20;
const RESUME_BATCHES = 10;
const LAST_CLOCK_ID = `stress-clock-${String(SOURCE_COUNT - 1).padStart(4, '0')}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rounded(value) { return Math.round(Number(value || 0) * 100) / 100; }

function durations(values) {
  return {
    count: values.length,
    medianMs: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    maxMs: rounded(Math.max(0, ...values)),
  };
}

function buildFixture() {
  const nodes = [];
  for (let index = 0; index < SOURCE_COUNT; index += 1) {
    const column = index % 40;
    const row = Math.floor(index / 40);
    nodes.push({
      id: `stress-clock-${String(index).padStart(4, '0')}`,
      type: 'clock',
      label: `Clock ${String(index + 1).padStart(4, '0')}`,
      x: column * 190,
      y: row * 105,
      width: 168,
      height: 80,
      config: { periodMs: PERIOD_MS },
      statePolicy: 'reset',
    });
  }
  return {
    researchVersion: 3,
    subcircuits: [],
    pages: [{
      id: 'time-slicing-1000',
      title: '1,000 active clocks',
      nodes,
      edges: [],
      view: { x: 28, y: 28, scale: 0.25 },
      simulation: { speed: 1 },
    }],
    activePageId: 'time-slicing-1000',
  };
}

async function validateFixture(document) {
  const definitions = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [registryModule, schemaModule, computeModule] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-registry.js')).href),
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-schema.js')).href),
    import(pathToFileURL(path.join(ROOT, 'assets/research/research-compute.js')).href),
  ]);
  const registry = registryModule.createResearchRegistry(definitions);
  const checked = schemaModule.validateResearchDocument(document, registry);
  assert(checked.ok, checked.errors.map((item) => `${item.code}:${item.path || ''}`).join('\n'));
  const compiled = computeModule.compileResearchGraph(checked.document.pages[0], registry);
  assert.equal(compiled.errors.length, 0, compiled.errors.map((item) => item.message).join('\n'));
  assert.equal(compiled.stats.nodeCount, SOURCE_COUNT);
  assert.equal(compiled.stats.stateNodeCount, SOURCE_COUNT);
  return checked.document;
}

async function installFixtureRoute(page, fixture) {
  let current = clone(fixture);
  let revision = 0;
  const saves = [];
  await page.route('**/api/research/workspace', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ document: clone(current), revision: `time-slicing-${revision}` }),
      });
      return;
    }
    const payload = request.postDataJSON();
    current = clone(payload.document);
    revision += 1;
    saves.push(clone(current));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ document: clone(current), revision: `time-slicing-${revision}` }),
    });
  });
  return { current: () => clone(current), saves };
}

async function installInstrumentation(context) {
  await context.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const state = {
      capture: false,
      zeroSchedules: [],
      zeroCallbacks: [],
      frames: [],
      longTasks: [],
      rafId: 0,
    };
    window.__researchTimeSlicing = state;
    window.setTimeout = function instrumentedSetTimeout(callback, delay, ...args) {
      const zero = Number(delay) === 0;
      if (state.capture && zero) state.zeroSchedules.push(performance.now());
      return nativeSetTimeout(function instrumentedCallback(...callbackArgs) {
        if (state.capture && zero) state.zeroCallbacks.push(performance.now());
        if (typeof callback === 'function') return callback(...callbackArgs);
        return undefined;
      }, delay, ...args);
    };
    window.clearTimeout = function instrumentedClearTimeout(id) { return nativeClearTimeout(id); };
    if (typeof PerformanceObserver === 'function') {
      try {
        const observer = new PerformanceObserver((list) => {
          if (!state.capture) return;
          list.getEntries().forEach((entry) => state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          }));
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch (_error) {}
    }
    window.__startResearchTimeCapture = () => {
      state.capture = true;
      state.zeroSchedules = [];
      state.zeroCallbacks = [];
      state.frames = [];
      state.longTasks = [];
      const frame = (timestamp) => {
        if (!state.capture) return;
        state.frames.push(timestamp);
        state.rafId = requestAnimationFrame(frame);
      };
      state.rafId = requestAnimationFrame(frame);
      return performance.now();
    };
    window.__stopResearchTimeCapture = () => {
      state.capture = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
      return performance.now();
    };
  });
}

function pulseSequence(text) {
  const match = String(text || '').match(/#(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function currentSequence(page) {
  return pulseSequence(await page.locator(`[data-node-id="${LAST_CLOCK_ID}"] [data-compute-result]`).textContent());
}

async function waitForSequence(page, minimum) {
  await page.waitForFunction(({ id, minimum: target }) => {
    const result = document.querySelector(`[data-node-id="${id}"] [data-compute-result]`);
    const match = result && result.textContent.match(/#(\d+)/);
    return match && Number(match[1]) >= target;
  }, { id: LAST_CLOCK_ID, minimum }, { timeout: 20000 });
  return currentSequence(page);
}

async function waitForStableSequence(page, timeoutMs = 5000) {
  const started = Date.now();
  let previous = await currentSequence(page);
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(120);
    const current = await currentSequence(page);
    if (current === previous) return current;
    previous = current;
  }
  assert.fail('the visible pulse sequence must settle after Pause');
}

async function activateAndWait(page) {
  await page.waitForFunction(() => !!window.RelatumResearchWorkspace);
  const started = await page.evaluate(() => performance.now());
  await page.evaluate(() => RelatumResearchWorkspace.activate());
  await page.waitForFunction((count) => document.querySelectorAll('[data-node-id]').length === count, SOURCE_COUNT, { timeout: 20000 });
  return rounded((await page.evaluate(() => performance.now())) - started);
}

async function run(playwright, url, options = {}) {
  const fixture = await validateFixture(buildFixture());
  const browser = await playwright.chromium.launch({
    headless: options.headless !== false,
    executablePath: options.edgePath || undefined,
  });
  const report = {
    browser: browser.version(),
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    fixture: {
      nodes: SOURCE_COUNT,
      activeTimeNodes: SOURCE_COUNT,
      type: 'clock',
      periodMs: PERIOD_MS,
      synchronized: true,
      wires: 0,
    },
    correctness: {},
    metrics: {},
    errors: [],
  };
  try {
    const context = await browser.newContext({ viewport: report.viewport, reducedMotion: 'reduce' });
    await installInstrumentation(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') report.errors.push('console: ' + message.text());
    });
    const routeState = await installFixtureRoute(page, fixture);
    const baseUrl = url.replace(/\/$/, '') + '/research.html';
    const navigationStarted = Date.now();
    await page.goto(baseUrl);
    report.metrics.initialLoadMs = Date.now() - navigationStarted;
    report.metrics.initialActivationMs = await activateAndWait(page);
    assert.equal(await page.locator('[data-node-id]').count(), SOURCE_COUNT);
    assert.equal(await page.locator('.is-compute-error').count(), 0);

    const reloads = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = Date.now();
      await page.evaluate(() => RelatumResearchWorkspace.dispose());
      await page.reload();
      await activateAndWait(page);
      reloads.push(Date.now() - started);
      assert.equal(await page.locator('[data-node-id]').count(), SOURCE_COUNT);
      assert.equal(await page.locator('.is-compute-error').count(), 0);
    }
    report.metrics.coldReload = durations(reloads);

    await page.locator('[data-research-speed]').selectOption('4');
    await page.waitForFunction(() => document.querySelector('[data-research-speed]').value === '4');
    const captureStarted = await page.evaluate(() => window.__startResearchTimeCapture());
    await page.locator('[data-research-run]').click();
    const firstSequence = await waitForSequence(page, SOURCE_COUNT * TARGET_BATCHES);
    assert.equal(firstSequence % SOURCE_COUNT, 0, 'a visible batch must contain all 1,000 synchronized pulses');

    await page.evaluate(() => RelatumResearchWorkspace.suspend());
    const suspendedAt = await currentSequence(page);
    await page.waitForTimeout(120);
    assert.equal(await currentSequence(page), suspendedAt, 'suspension must stop active time advancement');
    const resumeStarted = await page.evaluate(() => performance.now());
    await page.evaluate(() => RelatumResearchWorkspace.activate());
    const resumedSequence = await waitForSequence(page, suspendedAt + SOURCE_COUNT * RESUME_BATCHES);
    report.metrics.resumeToTenBatchesMs = rounded((await page.evaluate(() => performance.now())) - resumeStarted);

    const pauseStarted = await page.evaluate(() => performance.now());
    await page.locator('[data-research-pause]').click();
    await page.waitForFunction(() => document.querySelector('[data-research-pause]').classList.contains('is-active'));
    report.metrics.pauseLatencyMs = rounded((await page.evaluate(() => performance.now())) - pauseStarted);
    const finalSequence = await waitForStableSequence(page);
    const captureStopped = await page.evaluate(() => window.__stopResearchTimeCapture());
    await page.waitForTimeout(100);
    assert.equal(await currentSequence(page), finalSequence, 'public Pause must stop all active clocks');
    assert.equal(finalSequence % SOURCE_COUNT, 0, 'the final visible state must be a complete deterministic batch');
    assert(finalSequence >= resumedSequence);

    const instrumentation = await page.evaluate(() => ({
      zeroSchedules: window.__researchTimeSlicing.zeroSchedules.slice(),
      zeroCallbacks: window.__researchTimeSlicing.zeroCallbacks.slice(),
      frames: window.__researchTimeSlicing.frames.slice(),
      longTasks: window.__researchTimeSlicing.longTasks.slice(),
    }));
    const completedBatches = finalSequence / SOURCE_COUNT;
    const frameGaps = instrumentation.frames.slice(1).map((value, index) => value - instrumentation.frames[index]);
    assert(instrumentation.zeroCallbacks.length >= completedBatches * 3,
      '1,000 sources must cooperatively yield between the four 256-source slices');
    assert(instrumentation.frames.length >= 2, 'the browser must render frames while active time nodes run');
    assert.equal(await page.locator('.is-compute-error').count(), 0);
    assert.equal(report.errors.length, 0, report.errors.join('\n'));

    const persisted = routeState.current();
    const serialized = JSON.stringify(persisted);
    assert(!serialized.includes('timeSliceCount') && !serialized.includes('pulseCount')
      && !serialized.includes('simulationTime'), 'runtime scheduling counters must not be persisted');
    report.correctness = {
      schemaValid: true,
      completeDeterministicBatches: true,
      suspendedWithoutAdvancing: true,
      resumed: true,
      pausedWithoutAdvancing: true,
      runtimeStatePersisted: false,
      computeErrors: 0,
    };
    report.metrics.runCaptureMs = rounded(captureStopped - captureStarted);
    report.metrics.completedBatches = completedBatches;
    report.metrics.processedClockPulses = finalSequence;
    report.metrics.observedZeroDelayYields = instrumentation.zeroCallbacks.length;
    report.metrics.minimumExpectedYields = completedBatches * 3;
    report.metrics.frameIntervals = durations(frameGaps);
    report.metrics.longTasks = {
      count: instrumentation.longTasks.length,
      totalMs: rounded(instrumentation.longTasks.reduce((sum, item) => sum + item.duration, 0)),
      maxMs: rounded(Math.max(0, ...instrumentation.longTasks.map((item) => item.duration))),
    };
    report.persistence = {
      saves: routeState.saves.length,
      bytes: Buffer.byteLength(serialized, 'utf8'),
    };
    report.accepted = true;
    await page.evaluate(() => RelatumResearchWorkspace.dispose());
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [url, outputPath] = process.argv.slice(2);
  if (!url) {
    console.log('Optional browser test: node tests/research-time-slicing-browser.js <local URL> [report.json]');
    return;
  }
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'time-slicing fixture only accepts a local server');
  const playwright = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
  const report = await run(playwright, url, { edgePath: process.env.RELATUM_EDGE_PATH });
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

module.exports = { buildFixture, installFixtureRoute, run };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

// Continuous navigation on an isolated real homepage. No application dependency.
// --baseline-only records Git assets; --compare alternates those assets/current.
// --behavior checks real-page handoffs; --glyphs checks stroke-mask visibility.
// RELATUM_NAV_RELEASE runs the existing EXE with workspace assets and isolated data.
// Performance collection deliberately has no geometry, style, or pixel probes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-navigation-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = new Set(process.argv.slice(2));
const baselineRef = execFileSync('git', ['rev-parse', process.env.RELATUM_NAV_BASELINE_REF || '95e6e523'], { cwd: repo, encoding: 'utf8' }).trim();
const runs = Number(process.env.RELATUM_NAV_RUNS || 3);
const report = { baselineRef, measuredAt: new Date().toISOString(), samples: [], checks: [], output: root,
  measurementLimits: ['RAF intervals in headless Chromium are not physical display FPS.',
    'CDP Paint duration does not include complete raster/GPU costs.',
    'Visual/DOM probes run separately from performance collection.'] };
const gitAssets = new Map();
const currentAssets = new Map(fs.readdirSync(path.join(repo, 'assets'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:js|css|html)$/.test(entry.name))
  .map(entry => [`assets/${entry.name}`, fs.readFileSync(path.join(repo, 'assets', entry.name))]));
report.currentHashes = Object.fromEntries(['index.html', 'styles.css', 'start.js', 'start-navigation.js', 'start-spine.js']
  .map(name => [name, currentAssets.has(`assets/${name}`) ? createHash('sha256').update(currentAssets.get(`assets/${name}`)).digest('hex') : null]));

function asset(relative, baseline) {
  if (!baseline) return currentAssets.get(relative) || null;
  if (!gitAssets.has(relative)) {
    try { gitAssets.set(relative, execFileSync('git', ['show', `${baselineRef}:${relative}`], { cwd: repo, maxBuffer: 12 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
    catch { gitAssets.set(relative, null); }
  }
  return gitAssets.get(relative);
}

const fixture = {
  files: Array.from({ length: 72 }, (_, i) => ({ path: path.join(root, 'canvases', `fixture-${i}.canvas`),
    title: `导航测试 ${i}`, exists: true, favorite: i % 7 === 0, groupId: `g${i % 4}`,
    lastOpenedAt: `2026-10-17T00:${String(i % 60).padStart(2, '0')}:00Z` })),
  groups: Array.from({ length: 36 }, (_, i) => ({ id: `g${i}`, name: `测试分组 ${i}` })), recentLimit: 80,
};

async function routeAssets(context, baseline) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^\//, '').replace(/^assets\//, '');
    if (name === 'api/recent') return route.fulfill({ json: fixture });
    if (name === 'api/file-stats') return route.fulfill({ json: { files: [] } });
    if (!name.includes('vendor/') && /\.(?:js|css|html)$/.test(name)) {
      let body = asset(`assets/${name}`, baseline);
      if (body && name === 'index.html') {
        // Preserve the server's feature/desktop bootstrap when swapping HTML assets.
        const response = await route.fetch(), rendered = await response.text();
        const bootstrap = rendered.match(/<head>([\s\S]*?)(?=\s*<meta\b)/i)?.[1];
        assert(bootstrap?.includes('feature-runtime.js'), 'served homepage has its feature bootstrap');
        body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + bootstrap));
      }
      if (body) return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'text/javascript', body });
    }
    return route.continue();
  });
}

async function prepareContext(browser, url, config, baseline, options = {}) {
  const context = options.nativePage ? options.nativePage.context() : await browser.newContext({ viewport: { width: config.width || 1600, height: config.height || 1000 }, deviceScaleFactor: config.dpr,
    reducedMotion: config.reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript(config => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
    localStorage.setItem('canvas:startTheme', config.theme);
    localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
    localStorage.setItem('canvas:hideSpecialPages', '0');
    localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    if (config.speed === null) localStorage.removeItem('canvas:spineMotionMs:v1');
    else localStorage.setItem('canvas:spineMotionMs:v1', String(config.speed || 457));
  }, config);
  await routeAssets(context, baseline);
  const page = options.nativePage || await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + '/index.html?view=review');
  await page.waitForSelector('.review-spine-tab');
  await page.waitForTimeout(1200);
  // Prewarm page modules before recording. Cold activation is checked separately.
  for (const name of options.warm === false ? [] : ['calendar', 'cadence', 'notes', 'tree-page', 'study', 'focus', 'review']) {
    await page.locator(`.left-spine [data-action="${name}-view"]`).evaluate(el => el.click());
    await page.waitForTimeout(750);
  }
  return { context, page, errors };
}

async function coordinates(page) {
  return page.locator('.left-spine').evaluate(nav => {
    const result = {};
    for (const button of nav.querySelectorAll('.study-spine-tab,.page-dot:not(.dot-add)')) {
      const b = button.getBoundingClientRect();
      const key = button.dataset.action || `group:${button.dataset.groupId || ''}`;
      result[key] = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    const b = nav.getBoundingClientRect();
    result.wheel = { x: b.right + 36, y: b.top + 240 };
    return result;
  });
}

async function dispatchClick(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function inputSequence(cdp, points, scenario) {
  const clicked = ['calendar-view', 'cadence-view', 'review-view', 'notes-view', 'study-view', 'focus-view',
    'calendar-view', 'review-view', 'group:', 'group:g0', 'group:g1', 'calendar-view', 'cadence-view', 'review-view',
    'notes-view', 'tree-page-view', 'study-view', 'focus-view', 'calendar-view', 'review-view'];
  const actual = [], started = performance.now();
  const count = scenario === 'clicks' ? clicked.length : 24;
  const interval = scenario === 'clicks' ? 25 : 20;
  for (let i = 0; i < count; i++) {
    await pause(Math.max(0, started + i * interval - performance.now()));
    const begin = performance.now();
    if (scenario === 'clicks') await dispatchClick(cdp, points[clicked[i]]);
    else await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...points.wheel, deltaX: 0,
      deltaY: i < 12 ? 65 : -65 });
    actual.push({ index: i, target: scenario === 'clicks' ? clicked[i] : i < 12 ? '+1' : '-1',
      sentMs: begin - started, acknowledgedMs: performance.now() - started });
  }
  return actual;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function displayFrameSummary(events, speed) {
  const inputs = events.filter(e => e.name === 'EventDispatch' && e.ph === 'X'
    && ['click', 'wheel'].includes(e.args?.data?.type));
  if (!inputs.length) return null;
  const first = Math.min(...inputs.map(e => e.ts)), last = Math.max(...inputs.map(e => e.ts));
  const stamps = [...new Set(events.filter(e => e.name === 'Display::FrameDisplayed'
    && e.ts >= first && e.ts <= last + speed * 1000).map(e => e.ts))].sort((a, b) => a - b);
  const intervals = stamps.slice(1).map((stamp, i) => (stamp - stamps[i]) / 1000);
  const estimatedCadenceMs = percentile(intervals.filter(n => n > 1 && n < 8), .5);
  return { count: intervals.length, estimatedCadenceMs, firstInputToNextCompositorFrameMs: stamps.length ? (stamps[0] - first) / 1000 : null,
    feedbackLimit: 'The next compositor event may contain an unchanged frame; this is not verified pixel feedback latency. CDP acknowledgments are transport round trips.',
    p95: percentile(intervals, .95), p99: percentile(intervals, .99),
    max: Math.max(0, ...intervals), overTwoEstimatedCadences: estimatedCadenceMs ? intervals.filter(n => n > estimatedCadenceMs * 2 + .5).length : null,
    rawIntervals: intervals, limit: 'Compositor signal during input plus slider settling; multiple surfaces and skipped unchanged frames prevent treating it as physical display FPS/dropped frames.' };
}

async function performanceSample(page, cdp, config, label, run, scenario) {
  await page.bringToFront();
  await page.locator('.review-spine-tab').evaluate(el => el.click());
  await page.waitForTimeout(1700);
  const points = await coordinates(page); // All UI reads finish before trace/RAF collection.
  const display = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const events = [], collect = chunk => events.push(...chunk.value);
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  cdp.on('Tracing.dataCollected', collect);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,benchmark', transferMode: 'ReportEvents' });
  const before = await metrics();
  await page.evaluate(() => {
    window.__navigationFrames = { active: true, last: 0, deltas: [], longTasks: [] };
    if (typeof PerformanceObserver === 'function') {
      window.__navigationFrames.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__navigationFrames.longTasks.push(entry.duration);
      });
      window.__navigationFrames.observer.observe({ entryTypes: ['longtask'] });
    }
    const step = time => {
      const p = window.__navigationFrames;
      if (!p.active) return;
      if (p.last) p.deltas.push(time - p.last);
      p.last = time; requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const inputs = await inputSequence(cdp, points, scenario);
  await page.waitForTimeout(1100);
  const frameProbe = await page.evaluate(() => {
    const p = window.__navigationFrames; p.active = false; p.observer?.disconnect();
    return { deltas: p.deltas, longTasks: p.longTasks };
  });
  const deltas = frameProbe.deltas;
  const after = await metrics();
  const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); await finished; cdp.off('Tracing.dataCollected', collect);
  const durations = names => events.filter(e => e.ph === 'X' && names.includes(e.name)).map(e => e.dur / 1000);
  const tasks = frameProbe.longTasks;
  const paints = durations(['Paint']);
  const result = { label, run, config, display, scenario, inputs, frameIntervals: { count: deltas.length, rawDeltas: deltas,
    p95: percentile(deltas, .95), p99: percentile(deltas, .99), max: Math.max(0, ...deltas),
    over25: deltas.filter(n => n > 25).length, over50: deltas.filter(n => n > 50).length },
    longTasks: { count: tasks.length, maxMs: tasks.length ? Math.max(...tasks) : null },
    paintMs: paints.reduce((a, b) => a + b, 0), paintCount: paints.length,
    compositorFrames: displayFrameSummary(events, config.speed || 457) };
  for (const key of ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount']) result[key] = after[key] - before[key];
  // This is a post-trace outcome check, not a probe on the hot path.
  result.final = await page.locator('.book-view').evaluate(el => ({ view: el.dataset.viewName,
    active: document.querySelector('.left-spine .active')?.dataset.action || document.querySelector('.left-spine .active')?.dataset.groupId }));
  fs.writeFileSync(path.join(root, `${label}-${config.theme}-${config.dpr}-${run}-${scenario}.trace.json`), JSON.stringify({ traceEvents: events }));
  report.samples.push(result);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const compact = Object.assign({}, result, { inputs: `${inputs.length} trusted CDP inputs`,
    frameIntervals: Object.assign({}, result.frameIntervals, { rawDeltas: undefined }),
    compositorFrames: result.compositorFrames && Object.assign({}, result.compositorFrames, { rawIntervals: undefined }) });
  console.log(JSON.stringify(compact));
}

async function waitView(page, name) {
  await page.waitForFunction(name => document.querySelector('.book-view').dataset.viewName === name, name);
}

async function behaviorChecks(browser, url, config) {
  const { context, page, errors } = await prepareContext(browser, url, config, false);
  try {
    assert(await page.evaluate(() => !!window.RelatumStartNavigation), 'new navigation module is loaded');
    await waitView(page, 'review');
    const immediate = await page.evaluate(() => {
      const book = document.querySelector('.book-view'), changes = [];
      window.__navigationChanges = changes;
      window.__navigationObserver = new MutationObserver(records => {
        for (const record of records) changes.push({ old: record.oldValue, next: book.dataset.viewName });
      });
      window.__navigationObserver.observe(book, { attributes: true, attributeFilter: ['data-view-name'], attributeOldValue: true });
      for (const name of ['calendar', 'cadence', 'notes']) document.querySelector(`[data-action="${name}-view"]`).click();
      return { committed: book.dataset.viewName, feedback: document.querySelector('.left-spine .is-target')?.dataset.action,
        active: document.querySelector('.left-spine .active')?.dataset.action };
    });
    assert.deepEqual(immediate, { committed: 'review', feedback: 'notes-view', active: 'review-view' }, 'feedback is immediate while the page waits for the quiet period');
    await waitView(page, 'notes');
    const changed = await page.evaluate(() => { window.__navigationObserver.disconnect(); return window.__navigationChanges; });
    assert.equal(changed.length, 1, 'a same-task burst commits only its final route');
    assert.equal(await page.locator('.left-spine [aria-current="page"]').count(), 1, 'only the committed page has aria-current');

    // Ordinary groups used to retain independent delayed swaps after leaving the library.
    await page.locator('.review-spine-tab').evaluate(el => el.click()); await waitView(page, 'review');
    await page.evaluate(() => {
      const clickGroup = id => document.querySelector(`.page-dot[data-group-id="${id}"]`).click();
      clickGroup(''); clickGroup('g0'); clickGroup('g1');
      document.querySelector('.calendar-spine-tab').click();
    });
    await waitView(page, 'calendar'); await page.waitForTimeout(850);
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'calendar', 'old library swaps cannot replace a newer special page');
    await page.evaluate(() => {
      for (const id of ['g0', 'g1', 'g2']) document.querySelector(`.page-dot[data-group-id="${id}"]`).click();
    });
    await page.waitForFunction(() => document.querySelector('.page-dot.active')?.dataset.groupId === 'g2');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:activeGroup')), 'g2');

    // A repeated click on an already mounted page is a command, not a route burst.
    const commands = [];
    for (const entry of [{ view: 'calendar', action: 'calendar', api: 'CanvasCalendar', method: 'toggleMode' },
      { view: 'study', action: 'study', api: 'StudyView', method: 'toggleMode' },
      { view: 'focus', action: 'focus', api: 'CanvasFocus', method: 'toggleMode' },
      { view: 'tree', action: 'tree-page', api: 'CanvasTreePage', method: 'resetView' },
      { view: 'notes', action: 'notes', api: 'CanvasNotes', method: 'resetView' }]) {
      await page.locator('.review-spine-tab').evaluate(el => el.click()); await waitView(page, 'review');
      await page.locator(`.left-spine [data-action="${entry.action}-view"]`).evaluate(el => el.click()); await waitView(page, entry.view);
      const result = await page.evaluate(entry => {
        const api = window[entry.api], original = api[entry.method], originalActivate = api.activate;
        let called = 0, activated = 0;
        const mode = () => entry.view === 'study' ? document.querySelector('.study-embedded').classList.contains('study-mode-list') : api.getViewMode?.();
        const before = mode();
        api[entry.method] = function (...args) { called++; return original.apply(this, args); };
        if (originalActivate) api.activate = function (...args) { activated++; return originalActivate.apply(this, args); };
        const button = document.querySelector(`.left-spine [data-action="${entry.action}-view"]`);
        button.click(); button.click();
        const after = mode();
        api[entry.method] = original; if (originalActivate) api.activate = originalActivate;
        return { view: entry.view, called, activated, before, after };
      }, entry);
      assert.equal(result.called, 2, `${entry.view} preserves both same-route commands`);
      assert.equal(result.activated, 0, `${entry.view} command does not reenter the mounted page`);
      assert.equal(result.after, result.before, `${entry.view} two toggle commands restore the original mode`);
      commands.push(result);
      // The same two clicks before mounting still represent one pending route.
      await page.locator('.review-spine-tab').evaluate(el => el.click()); await waitView(page, 'review');
      await page.evaluate(entry => {
        const api = window[entry.api], original = api[entry.method];
        window.__pendingCommand = { calls: 0, original, api: entry.api, method: entry.method };
        api[entry.method] = function (...args) { window.__pendingCommand.calls++; return original.apply(this, args); };
        const button = document.querySelector(`.left-spine [data-action="${entry.action}-view"]`); button.click(); button.click();
      }, entry);
      await waitView(page, entry.view);
      assert.equal(await page.evaluate(() => {
        const p = window.__pendingCommand; window[p.api][p.method] = p.original; return p.calls;
      }), 0, `${entry.view} pending route duplicates do not turn into repeat commands`);
    }

    // Native wheel delivery checks the input boundary, separately from measured traces.
    await page.locator('.review-spine-tab').evaluate(el => el.click()); await waitView(page, 'review');
    const points = await coordinates(page), cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...points.wheel, deltaX: 0, deltaY: 65 });
    await waitView(page, 'calendar');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...points.wheel, deltaX: 100, deltaY: 5 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...points.wheel, deltaX: 0, deltaY: 80, modifiers: 2 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'calendar', 'horizontal gestures and Ctrl zoom do not navigate');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: points.wheel.y, deltaX: 0, deltaY: 80 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'calendar', 'content scrolling does not navigate');
    await cdp.detach();

    // An isolated input keeps the candidate session independent of real notes/data.
    const composition = await page.evaluate(async () => {
      const input = document.createElement('input'); input.id = 'navigation-composition-fixture';
      input.style.cssText = 'position:fixed;left:400px;top:200px;z-index:9999'; document.body.appendChild(input); input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      document.querySelector('.notes-spine-tab').click(); document.querySelector('.review-spine-tab').click();
      await new Promise(resolve => setTimeout(resolve, 160));
      const during = document.querySelector('.book-view').dataset.viewName;
      input.value = '输入法最终文本';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: input.value }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: input.value }));
      return { during, value: input.value };
    });
    assert.deepEqual(composition, { during: 'calendar', value: '输入法最终文本' }, 'candidate input holds page commits and preserves the final text');
    await waitView(page, 'review');
    await page.locator('#navigation-composition-fixture').evaluate(el => el.remove());

    for (const lifecycle of ['minimize', 'pagehide', 'hidden']) {
      await page.evaluate(kind => {
        document.querySelector('.calendar-spine-tab').click();
        if (kind === 'minimize') {
          document.documentElement.dataset.desktopMinimized = '1';
          window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
        } else if (kind === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide'));
        else { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }
      }, lifecycle);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'review', `${lifecycle} cancels a pending page`);
      await page.evaluate(kind => {
        if (kind === 'minimize') {
          document.documentElement.dataset.desktopMinimized = '0';
          window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } }));
        } else if (kind === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pageshow'));
        else { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }
      }, lifecycle);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'review', `${lifecycle} cannot revive a canceled request`);
    }

    // A real navigation scroll retains its current page and calibrates the marker.
    await page.setViewportSize({ width: 680, height: 570 });
    const navBox = await page.locator('.left-spine').boundingBox();
    await page.mouse.move(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2);
    await page.mouse.wheel(0, 600); await page.waitForTimeout(160);
    assert((await page.locator('.left-spine').evaluate(el => el.scrollTop)) > 0, 'overflowing navigation uses native scrolling');
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'review');
    await page.locator('.left-spine').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(100);
    const alignment = await page.evaluate(() => {
      const a = document.querySelector('.review-spine-tab').getBoundingClientRect(), b = document.querySelector('.spine-active-orb').getBoundingClientRect();
      return Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
    });
    assert(alignment < 1.1, 'resize/scroll calibration snaps the marker to the current target');
    assert.deepEqual(errors, []);
    report.checks.push({ type: 'behavior', config, immediate, changed, commands, composition, alignment });
    console.log('navigation behavior passed ' + JSON.stringify(config));
  } finally { await context.close(); }
}

async function spinePageResizeChecks(browser, url) {
  for (const speed of [null, 800]) {
    const expectedMs = speed === null ? 414 : speed;
    const { context, page, errors } = await prepareContext(browser, url,
      { theme: 'light', dpr: 1, speed }, false, { warm: false });
    try {
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.locator('.focus-spine-tab').evaluate(el => el.click());
      await waitView(page, 'focus'); await page.waitForTimeout(1100);
      for (const view of ['recent', 'focus']) {
        const result = await page.evaluate(async ({ view, expectedMs }) => {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const book = document.querySelector('.book-view'), spine = document.querySelector('.left-spine');
          const orb = spine.querySelector('.spine-active-orb'), track = spine.querySelector('.spine-glyph-track');
          const initialHeight = book.clientHeight;
          const target = view === 'focus' ? spine.querySelector('.focus-spine-tab')
            : spine.querySelector('.page-dot[data-group-id=""]');
          target.click();
          const deadline = performance.now() + 3000;
          while (book.dataset.viewName !== view) {
            if (performance.now() > deadline) throw new Error('Page commit timed out');
            await frame();
          }
          // Include the ResizeObserver delivery caused by the real page handoff.
          await frame(); await frame();
          const transition = element => element.getAnimations().find(animation =>
            animation.transitionProperty === 'transform' && animation.playState === 'running');
          const carrier = transition(orb), inverse = transition(track);
          if (!carrier || !inverse) throw new Error('Page handoff truncated the slider transition');
          const durations = [carrier.effect.getTiming().duration, inverse.effect.getTiming().duration];
          const naturalHeightDelta = book.clientHeight - initialHeight;
          carrier.pause(); inverse.pause();
          carrier.currentTime = inverse.currentTime = expectedMs * .2;
          const offsetError = () => {
            const a = new DOMMatrix(getComputedStyle(orb).transform);
            const b = new DOMMatrix(getComputedStyle(track).transform);
            return Math.hypot(a.m41 + b.m41, a.m42 + b.m42);
          };
          const beforeError = offsetError(), originalHeight = book.style.height;
          const beforeHeight = book.clientHeight;
          try {
            // Also exercise a deterministic 1px resize if font/platform metrics
            // do not reproduce the natural header-height difference.
            book.style.height = (beforeHeight - 1) + 'px';
            await frame(); await frame();
            const retained = orb.getAnimations().includes(carrier) && track.getAnimations().includes(inverse);
            const afterError = offsetError(), heightDelta = book.clientHeight - beforeHeight;
            const noTransition = spine.classList.contains('spine-marker-no-transition');
            const times = [carrier.currentTime, inverse.currentTime];
            if (!retained) throw new Error('A 1px host resize cancelled the original slider animations');
            return { view, expectedMs, durations, naturalHeightDelta, heightDelta,
              retained, noTransition, beforeError, afterError, times };
          } finally {
            book.style.height = originalHeight;
            carrier.play(); inverse.play();
            await Promise.all([carrier.finished, inverse.finished]);
          }
        }, { view, expectedMs });
        assert.deepEqual(result.durations, [expectedMs, expectedMs], 'both tracks use the configured full duration');
        assert.equal(result.heightDelta, -1, 'the real page host changed by exactly one pixel');
        assert.equal(result.noTransition, false, 'local host resize does not disable motion');
        assert(result.beforeError < .15 && result.afterError < .15, 'inverse glyphs stay aligned during resize');
        assert(result.times.every(time => Math.abs(time - expectedMs * .2) < .1), 'resize retains the current animation frame');
        report.checks.push({ type: 'spine-page-resize', ...result });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
}

async function latePreparationCheck(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas'); localStorage.setItem('canvas:hideSpecialPages', '0');
    let module;
    window.__navigationGate = { defer: '', releases: [], commits: [] };
    Object.defineProperty(window, 'RelatumStartNavigation', { configurable: true, get: () => module, set(value) {
      module = value; const original = value.create;
      value.create = settings => original(Object.assign({}, settings, {
        prepare(route, state) {
          const result = settings.prepare?.(route, state);
          if (route.view !== window.__navigationGate.defer) return result;
          return new Promise(resolve => window.__navigationGate.releases.push(() => resolve(result)));
        },
        commit(route, previous, state) { window.__navigationGate.commits.push(route.view); return settings.commit?.(route, previous, state); },
      }));
    } });
  });
  await routeAssets(context, false);
  const page = await context.newPage();
  try {
    await page.goto(url + '/index.html?view=review'); await waitView(page, 'review');
    await page.evaluate(() => { window.__navigationGate.commits.length = 0; window.__navigationGate.defer = 'calendar'; document.querySelector('.calendar-spine-tab').click(); });
    await page.waitForFunction(() => window.__navigationGate.releases.length === 1);
    await page.locator('.notes-spine-tab').evaluate(el => el.click()); await waitView(page, 'notes');
    await page.evaluate(() => window.__navigationGate.releases.splice(0).forEach(release => release()));
    await page.waitForTimeout(220);
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'notes');
    assert.deepEqual(await page.evaluate(() => window.__navigationGate.commits), ['notes'], 'late readiness cannot commit its obsolete route');
    report.checks.push({ type: 'late-preparation', final: 'notes' });
    console.log('navigation late preparation passed');
  } finally { await context.close(); }
}

async function focusAndLibraryRaceChecks(browser, url) {
  const { context, page, errors } = await prepareContext(browser, url, { theme: 'light', dpr: 1 }, false);
  try {
    await page.locator('.focus-spine-tab').evaluate(el => el.click()); await waitView(page, 'focus');
    await page.evaluate(() => {
      window.__lateFocus = { scrolls: 0, editorOpens: 0 };
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.closest('.focus-embedded')) window.__lateFocus.scrolls++;
        return original.apply(this, args);
      };
      const editor = document.querySelector('[data-role="focus-session-editor"]');
      window.__focusEditorObserver = new MutationObserver(() => { if (!editor.hidden) window.__lateFocus.editorOpens++; });
      window.__focusEditorObserver.observe(editor, { attributes: true, attributeFilter: ['hidden'] });
    });
    let holdFocus = true, releaseFocus;
    await context.route('**/api/focus', async route => {
      if (holdFocus) await new Promise(resolve => { releaseFocus = resolve; });
      return route.fulfill({ json: { sessions: [{ id: 'navigation-session', day: '2026-10-17',
        endedAt: '2026-10-17T04:00:00.000Z', durationSec: 1500, taskTitle: '导航迟到回归', goal: '', outcome: '' }] } });
    });
    await page.evaluate(() => { window.__focusPending = window.CanvasFocus.showDay('2026-10-17', 'navigation-session'); });
    for (let i = 0; i < 100 && !releaseFocus; i++) await pause(20);
    assert(releaseFocus, 'showDay starts its independently delayed focus request');
    await page.locator('.review-spine-tab').evaluate(el => el.click()); await waitView(page, 'review');
    holdFocus = false; releaseFocus();
    await page.evaluate(() => window.__focusPending); await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__lateFocus), { scrolls: 0, editorOpens: 0 }, 'late focus data cannot scroll or open an editor after leaving');
    assert(await page.locator('[data-role="focus-session-editor"]').evaluate(el => el.hidden));
    // Positive control proves that the fixture exercises the editor/scrolling path.
    await page.locator('.focus-spine-tab').evaluate(el => el.click()); await waitView(page, 'focus');
    await page.evaluate(() => window.CanvasFocus.showDay('2026-10-17', 'navigation-session'));
    const positive = await page.evaluate(() => window.__lateFocus);
    assert(positive.scrolls > 0 && positive.editorOpens > 0, 'active showDay still reveals the requested session');
    await page.locator('[data-action="focus-session-close"]').evaluate(el => el.click());
    holdFocus = true; releaseFocus = null;
    await page.evaluate(() => {
      window.__lateFocus = { scrolls: 0, editorOpens: 0 };
      window.__focusPending = window.CanvasFocus.showDay('2026-10-17', 'navigation-session');
    });
    for (let i = 0; i < 100 && !releaseFocus; i++) await pause(20);
    assert(releaseFocus, 'second showDay starts a delayed request before the mode changes');
    await page.locator('.focus-spine-tab').evaluate(el => el.click());
    assert.equal(await page.evaluate(() => window.CanvasFocus.getViewMode()), 'daily');
    holdFocus = false; releaseFocus();
    await page.evaluate(() => window.__focusPending); await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__lateFocus), { scrolls: 0, editorOpens: 0 }, 'late focus data cannot reveal the timer after switching to daily mode');
    await page.evaluate(() => window.__focusEditorObserver.disconnect());

    let recentPayload = fixture;
    await context.route('**/api/recent', route => route.fulfill({ json: recentPayload }));
    await context.route('**/api/recent-sync', route => route.fulfill({ json: { addedPaths: [], addedCount: 0, removedCount: 0, skippedInvalidCount: 0 } }));
    const refresh = async () => {
      await page.locator('[data-action="recent-sync"]').evaluate(el => el.click());
      await page.waitForFunction(() => !document.querySelector('[data-action="recent-sync"]').disabled);
    };
    const removeDuringPending = async () => {
      recentPayload = fixture; await refresh();
      await page.locator('.page-dot[data-group-id="g0"]').evaluate(el => el.click());
      await page.waitForFunction(() => document.querySelector('.page-dot.active')?.dataset.groupId === 'g0');
      await page.evaluate(() => {
        const input = document.createElement('input'); input.id = 'navigation-delete-composition'; document.body.appendChild(input);
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        document.querySelector('.calendar-spine-tab').click();
      });
      recentPayload = Object.assign({}, fixture, { groups: fixture.groups.filter(g => g.id !== 'g0') });
      await refresh();
      assert.equal(await page.locator('.page-dot[data-group-id="g0"]').count(), 0);
      assert.equal(await page.locator('.left-spine .is-target').getAttribute('data-action'), 'calendar-view', 'background deletion preserves a pending special target');
    };
    await removeDuringPending();
    await page.locator('#navigation-delete-composition').evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); el.remove(); });
    await waitView(page, 'calendar');

    await removeDuringPending();
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
      document.getElementById('navigation-delete-composition').remove();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '0';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } }));
    });
    await page.waitForFunction(() => document.querySelector('.page-dot.active[aria-current="page"]')?.dataset.groupId === '');
    assert.equal(await page.locator('.left-spine [aria-current="page"]').count(), 1, 'canceled target reconciles a removed current group after restore');

    await removeDuringPending();
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
      document.getElementById('navigation-delete-composition').remove();
      document.documentElement.dataset.desktopMinimized = '0';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } }));
      document.querySelector('.notes-spine-tab').click();
    });
    await waitView(page, 'notes'); await page.waitForTimeout(180);
    assert.equal(await page.locator('.book-view').getAttribute('data-view-name'), 'notes', 'a queued group reconciliation cannot replace a new pending target');
    assert.deepEqual(errors, []);
    report.checks.push({ type: 'focus-library-races', lateFocus: { scrolls: 0, editorOpens: 0 }, positive });
    console.log('navigation focus/library races passed');
  } finally { await context.close(); }
}

function luminance(png, x, y) {
  const i = (Math.max(0, Math.min(png.height - 1, y)) * png.width + Math.max(0, Math.min(png.width - 1, x))) * 4;
  return (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
}

function makeStrokeMask(normal, blank, box, viewport) {
  const sx = normal.width / viewport.width, sy = normal.height / viewport.height;
  const left = Math.floor(box.x * sx), top = Math.floor(box.y * sy);
  const right = Math.ceil((box.x + box.width) * sx), bottom = Math.ceil((box.y + box.height) * sy);
  const samples = [];
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    samples.push({ x, y, difference: Math.abs(luminance(normal, x, y) - luminance(blank, x, y)) });
  }
  const peak = Math.max(...samples.map(p => p.difference));
  const stroke = samples.filter(p => p.difference >= Math.max(30, peak * .65));
  const radius = Math.ceil(4 * Math.max(sx, sy));
  for (const point of stroke) {
    const neighbors = [];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (!dx && !dy) continue;
      const x = point.x + dx, y = point.y + dy;
      if (x < left - sx || x >= right + sx || y < top - sy || y >= bottom + sy) continue;
      if (Math.abs(luminance(normal, x, y) - luminance(blank, x, y)) <= 8) neighbors.push({ x, y, distance: dx * dx + dy * dy });
    }
    neighbors.sort((a, b) => a.distance - b.distance);
    point.background = neighbors.slice(0, Math.max(5, Math.ceil(6 * sx)));
  }
  return stroke.filter(p => p.background.length >= 3);
}

function markerCoverage(png, nav, viewport, theme) {
  const sx = png.width / viewport.width, sy = png.height / viewport.height;
  const left = Math.max(0, Math.floor((nav.x + 5) * sx)), top = Math.max(0, Math.floor(nav.y * sy));
  const width = Math.min(png.width - left, Math.ceil((nav.width - 10) * sx));
  const height = Math.min(png.height - top, Math.ceil(nav.height * sy));
  const pixels = new Uint8Array(width * height), queue = new Int32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = luminance(png, left + x, top + y);
    pixels[y * width + x] = (theme === 'dark' ? value >= 247 : value <= 8) ? 1 : 0;
  }
  let largest = [];
  for (let start = 0; start < pixels.length; start++) {
    if (pixels[start] !== 1) continue;
    let head = 0, tail = 1; queue[0] = start; pixels[start] = 2;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      for (const next of [x ? current - 1 : -1, x < width - 1 ? current + 1 : -1,
        y ? current - width : -1, y < height - 1 ? current + width : -1]) {
        if (next >= 0 && pixels[next] === 1) { pixels[next] = 2; queue[tail++] = next; }
      }
    }
    if (tail > largest.length) largest = Array.from(queue.subarray(0, tail));
  }
  const rows = new Map();
  if (largest.length >= 20 * sx * sy) for (const point of largest) {
    const y = top + Math.floor(point / width), x = left + point % width;
    const row = rows.get(y);
    if (row) { row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x); }
    else rows.set(y, [x, x]);
  }
  const inside = (x, y) => { const row = rows.get(y); return !!row && x >= row[0] && x <= row[1]; };
  return { inside, fill: theme === 'dark' ? 255 : 0, pixels: largest.length };
}

function strokeVisibility(png, mask, coverage, offset = { x: 0, y: 0 }) {
  const contrasts = [], boundary = [];
  for (const original of mask) {
    const point = { x: original.x + offset.x, y: original.y + offset.y,
      background: original.background.map(p => ({ x: p.x + offset.x, y: p.y + offset.y })) };
    const onMarker = coverage?.inside(point.x, point.y);
    const isBoundary = coverage && [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .some(([dx, dy]) => coverage.inside(point.x + dx, point.y + dy) !== onMarker);
    const neighbors = point.background.filter(p => !coverage || coverage.inside(p.x, p.y) === onMarker)
      .map(p => luminance(png, p.x, p.y));
    const background = onMarker ? coverage.fill : percentile(neighbors, .5);
    const contrast = Math.abs(luminance(png, point.x, point.y) - background);
    if (isBoundary || !neighbors.length && !onMarker) boundary.push(contrast);
    else contrasts.push(contrast);
  }
  return { medianContrast: percentile(contrasts, .5), visibleFraction: contrasts.filter(n => n >= 28).length / contrasts.length,
    assessedPoints: contrasts.length, boundaryPoints: boundary.length, totalPoints: mask.length };
}

function registerStaticGlyphs(png, normal, masks, coverage, positions, viewport) {
  const offsets = Object.fromEntries(masks.map(mask => [mask.key, {
    x: Math.round((positions[mask.key].x - mask.rect.x) * png.width / viewport.width),
    y: Math.round((positions[mask.key].y - mask.rect.y) * png.height / viewport.height),
  }]));
  const staticMasks = masks.filter(mask => !mask.points.some(p => coverage.inside(p.x + offsets[mask.key].x, p.y + offsets[mask.key].y)));
  assert(staticMasks.length >= 3, 'registration uses at least three original glyphs outside the slider');
  let best = { x: 0, y: 0, error: Infinity };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let error = 0, count = 0;
    for (const mask of staticMasks) for (const p of mask.points) {
      error += Math.abs(luminance(normal, p.x, p.y) - luminance(png, p.x + offsets[mask.key].x + dx, p.y + offsets[mask.key].y + dy)); count++;
    }
    const score = error / count;
    if (score < best.error) best = { x: dx, y: dy, error: score };
  }
  for (const value of Object.values(offsets)) { value.x += best.x; value.y += best.y; }
  return { offsets, residual: best, originals: staticMasks.map(mask => mask.key) };
}

async function compositeSnapshot(page, cdp) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let capture;
  const frame = new Promise(resolve => { capture = resolve; cdp.once('Page.screencastFrame', capture); });
  try {
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    const event = await Promise.race([frame, pause(3000).then(() => { throw new Error('reference composite frame timed out'); })]);
    await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    return Buffer.from(event.data, 'base64');
  } finally { cdp.off('Page.screencastFrame', capture); await cdp.send('Page.stopScreencast'); }
}

async function glyphChecks(browser, url, config, options = {}) {
  const { PNG } = require(require.resolve('pngjs', { paths: [path.dirname(require.resolve(process.env.RELATUM_PLAYWRIGHT || 'playwright'))] }));
  const baseline = args.has('--glyph-baseline');
  const { context, page, errors } = await prepareContext(browser, url, Object.assign({ width: 1280, height: 900 }, config), baseline,
    { warm: false, nativePage: options.nativePage });
  const prefix = `glyph-${options.nativePage ? 'native' : baseline ? 'baseline' : 'current'}-${config.theme}-${config.dpr}-${config.speed}`;
  try {
    const cdp = await context.newCDPSession(page);
    await waitView(page, 'review'); await page.waitForTimeout(800); await page.mouse.move(1100, 600);
    const glyphs = await page.locator('.left-spine > .study-spine-tab > span:not(.dot-bubble)').evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect();
      return { key: el.parentElement.dataset.action, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }));
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    const navBox = await page.locator('.left-spine').boundingBox();
    await page.evaluate(() => {
      const color = getComputedStyle(document.querySelector('.calendar-spine-tab')).color;
      const style = document.createElement('style'); style.id = 'navigation-glyph-reference';
      style.textContent = `.left-spine .spine-active-orb,.left-spine .spine-hover-orb,.left-spine .spine-hover-rail{visibility:hidden!important}.left-spine>.study-spine-tab>span:not(.dot-bubble){color:${color}!important}`;
      document.head.appendChild(style);
    });
    const normalData = await compositeSnapshot(page, cdp), normal = PNG.sync.read(normalData);
    await page.evaluate(() => {
      const style = document.createElement('style'); style.id = 'navigation-glyph-blank';
      style.textContent = '.left-spine>.study-spine-tab>span:not(.dot-bubble){visibility:hidden!important}'; document.head.appendChild(style);
    });
    const blankData = await compositeSnapshot(page, cdp), blank = PNG.sync.read(blankData);
    await page.evaluate(() => { document.getElementById('navigation-glyph-reference').remove(); document.getElementById('navigation-glyph-blank').remove(); });
    const masks = glyphs.map(g => ({ key: g.key, rect: g.rect, points: makeStrokeMask(normal, blank, g.rect, viewport) }));
    for (const mask of masks) assert(mask.points.length >= 8, `${mask.key} reference contains a real stroke mask`);
    fs.writeFileSync(path.join(root, `${prefix}-reference.png`), normalData);
    fs.writeFileSync(path.join(root, `${prefix}-blank.png`), blankData);
    fs.writeFileSync(path.join(root, `${prefix}-mask.json`), JSON.stringify({ viewport, navBox, masks }));
    if (!baseline) {
      await page.locator('.calendar-spine-tab').evaluate(el => el.click());
      await page.waitForTimeout(Number(config.speed) + 850);
      const aligned = PNG.sync.read(await compositeSnapshot(page, cdp));
      const calendarPositions = await page.locator('.left-spine>.study-spine-tab>span:not(.dot-bubble)').evaluateAll(elements => Object.fromEntries(elements.map(el => {
        const r = el.getBoundingClientRect(); return [el.parentElement.dataset.action, { x: r.x, y: r.y }];
      })));
      const calibrationCoverage = markerCoverage(aligned, navBox, viewport, config.theme);
      const calibrationRegistration = registerStaticGlyphs(aligned, normal, masks, calibrationCoverage, calendarPositions, viewport);
      const calendarMask = masks.find(m => m.key === 'calendar-view');
      const alignedScore = strokeVisibility(aligned, calendarMask.points, calibrationCoverage, calibrationRegistration.offsets['calendar-view']);
      assert(alignedScore.visibleFraction >= .60 && alignedScore.medianContrast >= 35, 'stroke-mask oracle accepts the aligned fully covered calendar glyph');
      await page.locator('.spine-glyph-track').evaluate(el => { el.dataset.testTranslate = el.style.translate; el.style.translate = '4px 0'; });
      const shifted = PNG.sync.read(await compositeSnapshot(page, cdp));
      const shiftedCoverage = markerCoverage(shifted, navBox, viewport, config.theme);
      const shiftedRegistration = registerStaticGlyphs(shifted, normal, masks, shiftedCoverage, calendarPositions, viewport);
      const shiftedScore = strokeVisibility(shifted, calendarMask.points, shiftedCoverage, shiftedRegistration.offsets['calendar-view']);
      await page.locator('.spine-glyph-track').evaluate(el => { el.style.translate = el.dataset.testTranslate; delete el.dataset.testTranslate; });
      assert(shiftedScore.visibleFraction < .60 || shiftedScore.medianContrast < 35, 'stroke-mask oracle rejects an intentionally misaligned inverse glyph');
      report.checks.push({ type: 'glyph-oracle-calibration', config, alignedScore, shiftedScore });
      await page.locator('.review-spine-tab').evaluate(el => el.click()); await page.waitForTimeout(Number(config.speed) + 850);
    }
    const cases = args.has('--glyph-smoke') ? [['calendar-view', 'review-view'], ['review-view', 'focus-view']]
      : [['calendar-view', 'review-view'], ['calendar-view', 'cadence-view'], ['review-view', 'focus-view'],
        ['focus-view', 'review-view'], ['group:__favorites__', 'review-view'], ['group:', 'focus-view']];
    const selector = key => key.startsWith('group:') ? `.left-spine .page-dot[data-group-id="${key.slice(6)}"]` : `.left-spine [data-action="${key}"]`;
    const failures = [];
    for (const [from, to] of cases) {
      await page.locator(selector(from)).evaluate(el => { if (!el.classList.contains('active')) el.click(); }); await page.waitForTimeout(Number(config.speed) + 900);
      await page.evaluate(() => {
        window.__glyphGeometry = { active: true, samples: [] };
        const step = () => {
          const probe = window.__glyphGeometry;
          if (!probe.active) return;
          const glyphs = {};
          for (const glyph of document.querySelectorAll('.left-spine>.study-spine-tab>span:not(.dot-bubble)')) {
            const r = glyph.getBoundingClientRect();
            glyphs[glyph.parentElement.dataset.action] = { x: r.x, y: r.y };
          }
          probe.samples.push({ time: (performance.timeOrigin + performance.now()) / 1000, glyphs });
          requestAnimationFrame(step);
        }; step();
      });
      const frames = [], capture = event => {
        frames.push({ data: Buffer.from(event.data, 'base64'), time: event.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      };
      cdp.on('Page.screencastFrame', capture); await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await page.waitForTimeout(80);
      await page.locator(selector(to)).evaluate(el => el.click());
      await page.waitForTimeout(Number(config.speed) + 280);
      await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', capture);
      const geometry = await page.evaluate(() => { window.__glyphGeometry.active = false; return window.__glyphGeometry.samples; });
      assert(frames.length >= 3, 'visual capture includes the moving interval');
      const series = frames.map((frame, index) => {
        const png = PNG.sync.read(frame.data);
        assert.equal(png.width, normal.width, 'reference/capture use the same PNG/CSS mapping');
        const coverage = markerCoverage(png, navBox, viewport, config.theme);
        const positions = geometry.reduce((nearest, item) => Math.abs(item.time - frame.time) < Math.abs(nearest.time - frame.time) ? item : nearest, geometry[0]).glyphs;
        const registration = registerStaticGlyphs(png, normal, masks, coverage, positions, viewport);
        return { index, ms: (frame.time - frames[0].time) * 1000, registration,
          glyphs: masks.map(mask => {
            const offset = registration.offsets[mask.key];
            return { key: mask.key, offset, ...strokeVisibility(png, mask.points, coverage, offset) };
          }) };
      });
      const bad = series.flatMap(frame => frame.glyphs.filter(g => g.visibleFraction < .60 || g.medianContrast < 35 || g.assessedPoints < g.totalPoints * .35).map(g => ({ index: frame.index, ms: frame.ms, ...g })));
      for (const sample of bad) failures.push({ from, to, ...sample });
      const safe = `${from}-${to}`.replace(/[^a-z0-9-]/gi, '_');
      fs.writeFileSync(path.join(root, `${prefix}-${safe}.json`), JSON.stringify({ from, to, viewport,
        masks: masks.map(m => ({ key: m.key, rect: m.rect, count: m.points.length })), geometry, series, failures: bad }, null, 2));
      const selected = args.has('--glyph-frames') ? frames.map((_, i) => i) : [...new Set([0, frames.length - 1, ...bad.map(f => f.index)])];
      for (const index of selected) fs.writeFileSync(path.join(root, `${prefix}-${safe}-${index}.png`), frames[index].data);
      console.log(JSON.stringify({ type: 'glyph', config, from, to, frameCount: frames.length, failures: bad.length }));
    }
    await cdp.detach();
    report.checks.push({ type: 'glyph', config, native: !!options.nativePage, baseline, viewport, failures });
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, []);
    if (!baseline) assert.deepEqual(failures, [], 'every captured glyph retains its stroke contrast, including underneath the moving slider');
  } finally { if (!options.nativePage) await context.close(); }
}

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

(async () => {
  const port = await freePort(), debugPort = await freePort();
  let url = `http://127.0.0.1:${port}`;
  const release = process.env.RELATUM_NAV_RELEASE;
  const server = spawn(release ? path.join(release, 'Relatum.exe') : process.env.RELATUM_PYTHON || 'python',
    release ? [] : ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: release || repo, env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(release ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } : {}) },
      windowsHide: true, stdio: 'ignore' });
  let browser, nativePage;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) { try { ready = (await fetch(release ? `http://127.0.0.1:${debugPort}/json/version` : url + '/api/runtime')).ok; } catch {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service/native debugging endpoint starts');
    if (release) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      for (let i = 0; i < 100; i++) {
        nativePage = browser.contexts()[0].pages().find(p => p.url().startsWith('http://127.0.0.1:'));
        if (nativePage) break; await pause(100);
      }
      assert(nativePage, 'isolated native homepage'); url = new URL(nativePage.url()).origin;
      await nativePage.setViewportSize({ width: 1280, height: 900 });
      report.native = true;
    } else browser = await chromium.launch({ headless: !args.has('--headed'), ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    report.browser = browser.version();
    if (args.has('--behavior')) {
      assert(!nativePage, '--behavior creates browser fixtures; use --glyphs or --compare in the native host');
      for (const config of [{ theme: 'light', dpr: 1 }, { theme: 'dark', dpr: 2 }, { theme: 'light', dpr: 2, reduced: true }]) await behaviorChecks(browser, url, config);
      await spinePageResizeChecks(browser, url);
      await latePreparationCheck(browser, url);
      await focusAndLibraryRaceChecks(browser, url);
    }
    if (args.has('--races') && !args.has('--behavior')) {
      assert(!nativePage, '--races creates isolated browser fixtures');
      await focusAndLibraryRaceChecks(browser, url);
    }
    if (args.has('--glyphs') || args.has('--glyph-smoke')) {
      const themes = (process.env.RELATUM_NAV_GLYPH_THEMES || (nativePage ? 'dark' : 'light,dark')).split(',');
      const dprs = (process.env.RELATUM_NAV_GLYPH_DPRS || (nativePage ? '1' : '1,2')).split(',').map(Number);
      const speeds = (process.env.RELATUM_NAV_GLYPH_SPEEDS || (args.has('--glyph-smoke') ? '457' : '100,457,800')).split(',').map(Number);
      assert(!nativePage || themes.length * dprs.length * speeds.length === 1, 'native runs take one theme/DPR/speed; invoke again for another configuration');
      for (const theme of themes) for (const dpr of dprs) for (const speed of speeds) await glyphChecks(browser, url, { theme, dpr, speed }, { nativePage });
    }
    if (!args.has('--behavior') && !args.has('--races') && !args.has('--glyphs') && !args.has('--glyph-smoke')) {
      const labels = args.has('--baseline-only') ? ['baseline'] : args.has('--compare') ? ['baseline', 'current'] : ['current'];
      const configs = nativePage ? [{ theme: process.env.RELATUM_NAV_THEME || 'dark', dpr: 1 }] : [{ theme: 'light', dpr: 1 }, { theme: 'dark', dpr: 2 }];
      for (const config of configs) {
        if (nativePage) {
          for (let run = 0; run < runs; run++) for (const label of run % 2 ? [...labels].reverse() : labels) {
            const { page, errors } = await prepareContext(browser, url, config, label === 'baseline', { nativePage });
            const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
            for (const scenario of ['clicks', 'wheel']) await performanceSample(page, cdp, config, label, run, scenario);
            await cdp.detach(); assert.deepEqual(errors, []);
          }
        } else {
          const sessions = {};
          for (const label of labels) sessions[label] = await prepareContext(browser, url, config, label === 'baseline');
          for (let run = 0; run < runs; run++) for (const label of run % 2 ? [...labels].reverse() : labels) {
            const { page } = sessions[label], cdp = await page.context().newCDPSession(page);
            await cdp.send('Performance.enable');
            for (const scenario of ['clicks', 'wheel']) await performanceSample(page, cdp, config, label, run, scenario);
            await cdp.detach();
          }
          for (const { context, errors } of Object.values(sessions)) { assert.deepEqual(errors, []); await context.close(); }
        }
      }
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('navigation report: ' + path.join(root, 'report.json'));
  } finally {
    if (nativePage) await Promise.race([nativePage.evaluate(() => window.pywebview?.api.close_window()).catch(() => {}), pause(3000)]);
    if (browser) await Promise.race([browser.close().catch(() => {}), pause(3000)]);
    if (server.exitCode === null) server.kill();
  }
})().catch(error => { console.error(error); console.error('artifacts: ' + root); process.exitCode = 1; });

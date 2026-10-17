'use strict';

// The real module runs in a focused host; all probes stay in this test. Real
// homepage navigation, pixel masks and performance live in start-navigation-browser.js.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-spine-motion-'));
const source = fs.readFileSync(path.join(repo, 'assets/start-spine.js'), 'utf8');
const css = fs.readFileSync(path.join(repo, 'assets/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(repo, 'assets/index.html'), 'utf8');
const start = html.indexOf('<nav class="left-spine"');
const nav = html.slice(start, html.indexOf('</nav>', start) + 6);
const report = { measuredAt: new Date().toISOString(), checks: [], output };
const frame = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function fixture(browser, config) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    deviceScaleFactor: config.dpr, reducedMotion: config.reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.testErrors = [];
  page.on('pageerror', error => page.testErrors.push(error.message));
  await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body class="start-page" '
    + 'data-start-theme="' + config.theme + '" data-start-workspace="canvas" data-start-state="study">'
    + '<section class="recent-view book-view" style="position:relative;height:calc(100vh - 50px)">'
    + nav + '</section></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: `
    window.P = { renders: 0, measures: 0, reads: 0 };
    const get = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('.left-spine,.left-spine > .study-spine-tab,.page-dot')) P.reads++;
      return get.call(this);
    };
  ` });
  await page.addScriptTag({ content: source
    .replace('function render() {', 'function render() { window.P.renders++;')
    .replace('function measure() {', 'function measure() { window.P.measures++;') });
  await page.addScriptTag({ content: `
    const spine = document.querySelector('.left-spine');
    const dots = document.querySelector('[data-role="page-dots"]');
    for (const [id, title] of [['','最近'], ['__favorites__','收藏'], ['__inbox__','未分组']]) {
      const button = document.createElement('button');
      button.className = 'page-dot'; button.dataset.groupId = id;
      const bubble = document.createElement('span'); bubble.className = 'dot-bubble';
      bubble.textContent = title; button.append(bubble); dots.append(button);
    }
    const targets = [...spine.querySelectorAll('.study-spine-tab,.page-dot')];
    let selected = targets[5];
    const view = RelatumStartSpine.create({ spine, dots,
      bookView: document.querySelector('.book-view'), getTarget: () => selected,
      getGroupIndex: id => id === 'g0' ? 0 : -1,
      visible: () => document.body.dataset.startWorkspace === 'canvas' });
    window.S = {
      targets, sync: view.sync, clear: view.clearHover, invalidate: view.invalidate,
      bounds: view.getBounds, destroy: view.destroy,
      reset() { for (const key of Object.keys(P)) P[key] = 0; },
      activate(index, config) {
        selected = targets[index];
        targets.forEach(target => target.classList.toggle('is-target', target === selected));
        view.sync(config);
      },
      hover(index) { targets[index].dispatchEvent(new PointerEvent('pointerenter')); }
    };
    S.activate(5, { animate: false });
  ` });
  await frame(page); await page.waitForTimeout(60);
  return page;
}

async function geometry(page, markerIndex) {
  return page.evaluate(markerIndex => {
    const spine = document.querySelector('.left-spine');
    const active = spine.querySelector('.is-target'), orb = spine.querySelector('.spine-active-orb');
    const marker = markerIndex == null ? active : S.targets[markerIndex];
    const a = active.getBoundingClientRect(), b = orb.getBoundingClientRect();
    const m = marker.getBoundingClientRect(), h = spine.querySelector('.spine-hover-orb').getBoundingClientRect();
    const rail = spine.querySelector('.spine-hover-rail').getBoundingClientRect();
    const surface = orb.querySelector('.spine-orb-surface'), s = surface.getBoundingClientRect();
    return {
      activeError: Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2),
      hoverError: Math.hypot(m.x + m.width / 2 - h.x - h.width / 2, m.y + m.height / 2 - h.y - h.height / 2),
      railError: Math.abs(m.y + m.height / 2 - rail.y - rail.height / 2),
      shape: orb.dataset.shape, carrierWidth: b.width, surfaceWidth: s.width,
      background: getComputedStyle(surface).backgroundColor,
      clip: getComputedStyle(orb.querySelector('.spine-glyph-clip')).clipPath,
      activeProperties: getComputedStyle(orb).transitionProperty,
      trackProperties: getComputedStyle(orb.querySelector('.spine-glyph-track')).transitionProperty,
      running: spine.getAnimations({ subtree: true }).filter(animation =>
        animation.transitionProperty === 'transform' && animation.playState === 'running').length
    };
  }, markerIndex);
}

async function behavior(browser, config) {
  const page = await fixture(browser, config);
  try {
    const burst = await page.evaluate(async () => {
      S.reset();
      for (let i = 0; i < 70; i++) S.hover(i % S.targets.length);
      const before = { ...P };
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return { before, after: { ...P } };
    });
    assert.equal(burst.before.reads, 0, 'hover input never synchronously measures');
    assert.equal(burst.after.renders, 1, '70 hover requests share one frame');
    assert.equal(burst.after.measures, 0, 'hover reuses the layout snapshot');
    await page.waitForTimeout(360);
    assert((await geometry(page, 9)).hoverError < 1.1);
    assert((await geometry(page, 9)).railError < 1.1);
    await page.evaluate(() => S.clear({ animate: false })); await frame(page);
    const activeBurst = await page.evaluate(async () => {
      S.reset(); for (let i = 0; i < 20; i++) S.activate(i % 7);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return { ...P };
    });
    assert.equal(activeBurst.renders, 1); assert.equal(activeBurst.measures, 0);
    assert.equal(activeBurst.reads, 0);

    await page.waitForTimeout(450);
    const writes = await page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(document.querySelector('.left-spine'), { subtree: true, attributes: true });
      for (let i = 0; i < 20; i++) S.sync();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      count += observer.takeRecords().length; observer.disconnect(); return count;
    });
    assert.equal(writes, 0, 'unchanged requests do not rewrite attributes');
    await page.evaluate(() => S.reset()); await page.waitForTimeout(140);
    assert.equal(await page.evaluate(() => P.renders), 0, 'idle leaves no navigation RAF');

    await page.evaluate(() => S.hover(0)); await frame(page);
    await page.evaluate(() => S.clear()); await frame(page); await page.waitForTimeout(70);
    await page.evaluate(() => S.hover(6)); await frame(page); await page.waitForTimeout(370);
    assert((await geometry(page, 6)).hoverError < 1.1, 'new preview wins over old return');
    await page.evaluate(() => { S.clear(); S.activate(1); }); await page.waitForTimeout(470);
    assert((await geometry(page)).activeError < 1.1);

    if (!config.reduced) {
      await page.evaluate(() => S.activate(6)); await frame(page); await page.waitForTimeout(65);
      const reverse = await page.evaluate(async () => {
        const orb = document.querySelector('.spine-active-orb');
        const y = () => new DOMMatrix(getComputedStyle(orb).transform).f;
        const before = y(); S.activate(0); const synchronous = y();
        await new Promise(requestAnimationFrame); const next = y();
        await new Promise(resolve => setTimeout(resolve, 470));
        return { before, synchronous, next, final: y() };
      });
      assert(Math.abs(reverse.before - reverse.synchronous) < 1);
      assert(reverse.next > reverse.final + 10, 'reversal starts at displayed position');
      const stationary = await page.evaluate(async () => {
        const original = document.querySelector('.calendar-spine-tab > .calendar-spine-glyph');
        const copy = document.querySelector('.spine-copy-calendar');
        let maxError = 0;
        for (const [index, delay] of [[6, 180], [0, 480]]) {
          S.activate(index); const start = performance.now();
          while (performance.now() - start < delay) {
            await new Promise(requestAnimationFrame);
            const a = original.getBoundingClientRect(), b = copy.getBoundingClientRect();
            maxError = Math.max(maxError, Math.abs(a.x - b.x), Math.abs(a.y - b.y),
              Math.abs(a.width - b.width), Math.abs(a.height - b.height));
          }
        }
        return maxError;
      });
      assert(stationary < .15, 'counter-translated glyph stays fixed: ' + stationary);
    }

    for (const [index, shape, size] of [[7, 'dot', 12], [8, 'star', 18], [5, 'tab', 34]]) {
      await page.evaluate(index => { S.clear(); S.activate(index); }, index);
      await page.waitForTimeout(config.reduced ? 50 : 470);
      const state = await geometry(page);
      assert.equal(state.shape, shape); assert.equal(state.carrierWidth, 38);
      assert(Math.abs(state.surfaceWidth - size) < .1);
      assert(state.activeError < 1.1 && state.hoverError < 1.1 && state.railError < 1.1);
      assert.equal(state.background, config.theme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
      if (!config.reduced) {
        assert.equal(state.activeProperties, 'transform'); assert.equal(state.trackProperties, 'transform');
      }
    }
    await page.locator('.calendar-spine-tab').focus(); await page.waitForTimeout(360);
    assert((await geometry(page, 1)).hoverError < 1.1);
    await page.keyboard.press('Tab'); await page.waitForTimeout(360);
    assert((await geometry(page, 2)).hoverError < 1.1);
    await page.evaluate(() => S.clear({ animate: false }));
    await page.setViewportSize({ width: 680, height: 450 }); await frame(page);
    let calibrated = await geometry(page);
    assert(calibrated.activeError < 1.1 && calibrated.hoverError < 1.1 && calibrated.running === 0);
    assert.equal(await page.evaluate(() => S.bounds().scrollable), true);
    await page.locator('.left-spine').evaluate(element => { element.scrollTop = 90; }); await frame(page);
    calibrated = await geometry(page);
    assert(calibrated.activeError < 1.1 && calibrated.hoverError < 1.1 && calibrated.running === 0);
    const cached = await page.evaluate(() => {
      S.reset(); for (let i = 0; i < 70; i++) S.bounds(); return { ...P };
    });
    assert.equal(cached.reads, 0, 'wheel bounds are cached');

    await page.evaluate(() => {
      document.documentElement.lang = 'en';
      document.querySelector('.calendar-spine-tab > .calendar-spine-glyph').textContent = 'D';
    }); await frame(page);
    assert.equal(await page.locator('.spine-copy-calendar').textContent(), 'D');
    assert.equal(await page.locator('.calendar-spine-glyph').count(), 1);
    const replicas = await page.locator('.spine-glyph-clip').evaluate(element => ({
      hidden: element.getAttribute('aria-hidden'), copies: element.querySelectorAll('.spine-glyph-slot').length,
      interactive: element.querySelectorAll('button,[id],[data-action],[data-i18n],[tabindex]').length
    }));
    assert.deepEqual(replicas, { hidden: 'true', copies: 7, interactive: 0 });
    const minimized = await page.evaluate(async () => {
      S.reset(); S.hover(0);
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return { ...P };
    });
    assert.equal(minimized.renders, 0);
    await page.waitForTimeout(2900);
    assert.equal(await page.locator('.orb-breathing').count(), 0);
    assert.equal(await page.locator('.left-spine').evaluate(el => el.getAnimations({ subtree: true })
      .filter(animation => animation.playState === 'running').length), 0);
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '0';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
    }); await frame(page);
    assert((await geometry(page)).activeError < 1.1);
    for (const hidden of [true, false]) {
      await page.evaluate(hidden => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden); await frame(page);
      assert.equal(await page.locator('.left-spine').evaluate(el =>
        el.classList.contains('spine-motion-suspended')), hidden);
    }
    await page.evaluate(() => delete document.hidden);
    await page.evaluate(() => { S.hover(0); window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    assert.equal(await page.locator('.left-spine').evaluate(el =>
      el.classList.contains('spine-motion-suspended')), true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))); await frame(page);
    assert((await geometry(page)).activeError < 1.1);
    if (!config.reduced) {
      await page.evaluate(() => S.activate(8)); await frame(page);
      await page.emulateMedia({ reducedMotion: 'reduce' }); await frame(page);
      assert.equal((await geometry(page)).running, 0, JSON.stringify(await page.locator('.left-spine')
        .evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running')
          .map(a => ({ property: a.transitionProperty, target: a.effect.target.className })))));
    }
    assert.deepEqual(page.testErrors, []);
    await page.screenshot({ path: path.join(output, 'spine-' + config.theme + '-' + config.dpr
      + (config.reduced ? '-reduced' : '') + '.png') });
    await page.evaluate(() => { S.destroy(); S.reset(); });
    await page.setViewportSize({ width: 710, height: 580 }); await frame(page);
    assert.equal(await page.evaluate(() => P.renders), 0, 'destroy releases listeners');
    assert.equal(await page.locator('.spine-glyph-slot').count(), 0);
    report.checks.push({ config, burst, activeBurst, writes, calibrated, replicas });
  } finally { await page.context().close(); }
}

async function speedChecks(browser) {
  const page = await fixture(browser, { theme: 'dark', dpr: 1 });
  try {
    for (const speed of [100, 414, 457, 800]) {
      await page.evaluate(speed => document.documentElement.style.setProperty('--spine-motion-ms', speed + 'ms'), speed);
      await page.evaluate(() => S.activate(0, { animate: false })); await frame(page);
      await page.evaluate(() => S.activate(6)); await frame(page);
      const timing = await page.evaluate(() => {
        const a = getComputedStyle(document.querySelector('.spine-active-orb'));
        const b = getComputedStyle(document.querySelector('.spine-glyph-track'));
        return [a.transitionDuration, b.transitionDuration, a.transitionTimingFunction, b.transitionTimingFunction];
      });
      assert.equal(timing[0], speed / 1000 + 's');
      assert.equal(timing[0], timing[1]); assert.equal(timing[2], timing[3]);
      await page.waitForTimeout(speed + 70);
      assert((await geometry(page)).activeError < 1.1);
      report.checks.push({ speed, timing });
    }
  } finally { await page.context().close(); }
}

async function layoutChecks(browser) {
  const page = await fixture(browser, { theme: 'dark', dpr: 1 });
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Performance.enable');
    await page.evaluate(async () => { await document.fonts.ready; });
    await frame(page); await page.waitForTimeout(460);
    const layoutCount = async () => {
      const response = await session.send('Performance.getMetrics');
      return response.metrics.find(metric => metric.name === 'LayoutCount').value;
    };
    for (const [name, from, to] of [
      ['tab-to-tab', 0, 6], ['tab-to-dot', 0, 7],
      ['dot-to-star', 7, 8], ['star-to-tab', 8, 0]
    ]) {
      await page.evaluate(from => { S.clear({ animate: false }); S.activate(from, { animate: false }); }, from);
      await frame(page); await page.waitForTimeout(70);
      await page.evaluate(to => S.activate(to), to);
      // The shape changes once at submission. Read after two presented frames so
      // this check measures the running transform, including both clipped tracks.
      await frame(page);
      const runningBefore = await page.locator('.spine-active-orb').evaluate(element =>
        element.getAnimations().some(animation => animation.transitionProperty === 'transform'
          && animation.playState === 'running'));
      const before = await layoutCount();
      await page.waitForTimeout(100);
      const after = await layoutCount();
      const runningAfter = await page.locator('.spine-active-orb').evaluate(element =>
        element.getAnimations().some(animation => animation.transitionProperty === 'transform'
          && animation.playState === 'running'));
      assert(runningBefore && runningAfter, name + ' samples the middle of actual motion');
      assert.equal(after - before, 0, name + ' must not produce per-frame CSS layout');
      report.checks.push({ layoutScenario: name, before, after, delta: after - before,
        runningBefore, runningAfter, sampleMs: 100 });
      await page.waitForTimeout(450);
    }
  } finally { await session.detach(); await page.context().close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  report.browser = browser.version();
  try {
    for (const config of [
      { theme: 'light', dpr: 1 }, { theme: 'dark', dpr: 2 },
      { theme: 'light', dpr: 2, reduced: true }, { theme: 'dark', dpr: 1, reduced: true }
    ]) {
      await behavior(browser, config); console.log('behavior passed ' + JSON.stringify(config));
    }
    await speedChecks(browser);
    await layoutChecks(browser);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('start spine motion browser passed: ' + path.join(output, 'report.json'));
    if (process.argv.includes('--compare')) console.log(
      'Performance comparisons moved to: node tests/start-navigation-browser.js --compare (real homepage; no visual probes).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

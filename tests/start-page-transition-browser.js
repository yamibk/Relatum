'use strict';

// Real page transitions on a disposable server; browser/runtime are test-host only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-page-transition-'));
const report = { samples: [], measuredAt: new Date().toISOString() };

async function activate(page, name) {
  await page.locator(`.left-spine [data-action="${name}-view"]`).evaluate(el => {
    if (!el.classList.contains('active')) el.click();
  });
}

async function behaviorChecks(browser, url, config) {
  const context = await browser.newContext({ viewport: { width: config.width || 1600, height: 1000 },
    deviceScaleFactor: config.dpr, reducedMotion: config.reduced ? 'reduce' : 'no-preference' });
  await context.addInitScript(config => {
    localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
    localStorage.setItem('canvas:startTheme', config.theme);
    localStorage.setItem('canvas:toolbarLanguage', config.language || 'zh-CN');
    localStorage.setItem('canvas:hideSpecialPages', '0');
    localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    const original = Element.prototype.getAnimations;
    window.transitionProbe = { enumerations: 0, animations: element => original.call(element, { subtree: true }) };
    Element.prototype.getAnimations = function (...args) {
      if (this.closest('[data-role="calendar-shell"],[data-role="study-cadence"]')) transitionProbe.enumerations++;
      return original.apply(this, args);
    };
  }, config);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url + '/index.html?view=study');
    await page.waitForSelector('.left-spine .study-spine-tab.active');
    await activate(page, 'calendar');
    await page.waitForSelector('[data-diary-body]');
    await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(() => transitionProbe.animations(document.querySelector('[data-role="calendar-shell"]'))
      .filter(a => a.constructor.name === 'Animation').length), 0, 'finished day-column effects release their handles and fill');
    await page.locator('[data-calendar-day]:not(.selected)').first().click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('[data-calendar-day].selected').count(), 1, 'day navigation keeps one selection');
    await activate(page, 'review'); await page.waitForTimeout(750);
    await page.evaluate(() => { transitionProbe.enumerations = 0; });
    await activate(page, 'calendar'); await page.waitForTimeout(80);
    await activate(page, 'cadence'); await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => transitionProbe.enumerations), 0, 'calendar replay and exit do not enumerate descendant animations');
    if (!config.reduced) {
      const frozen = await page.evaluate(async () => {
        const root = document.querySelector('[data-role="calendar-shell"]');
        const animations = transitionProbe.animations(root).filter(a => a.playState === 'paused');
        const times = animations.map(a => a.currentTime);
        await new Promise(resolve => setTimeout(resolve, 60));
        return { frozen: root.classList.contains('calendar-exit-frozen'), count: times.length,
          stable: animations.every((a, i) => a.currentTime === times[i]) };
      });
      assert(frozen.frozen && frozen.count > 0 && frozen.stable, 'calendar preserves its entrance frame during the outer exit');
    }
    await page.waitForSelector('.cadence-reveal-band');
    assert.equal(await page.locator('.cadence-reveal-band').count(), 7);
    const heatmap = await page.evaluate(() => {
      const host = document.querySelector('[data-role="study-cadence"]');
      const animations = transitionProbe.animations(host);
      const days = Array.from(host.querySelectorAll('.cadence-cell'), el => el.dataset.dayKey);
      return { cells: days.length, chronological: days.every((day, i) => !i || day > days[i - 1]),
        cellAnimations: animations.filter(a => a.effect?.target?.matches('.cadence-cell')).length,
        bands: animations.filter(a => a.animationName === 'cadenceBandIn').length };
    });
    assert(heatmap.cells >= 365 && heatmap.cells <= 366);
    assert.equal(heatmap.cellAnimations, 0, 'year reveal does not create a per-day animation');
    assert(heatmap.chronological, 'grouping preserves chronological DOM and Tab order');
    assert.equal(heatmap.bands, config.reduced ? 0 : 7);
    await page.evaluate(() => { transitionProbe.enumerations = 0; });
    await activate(page, 'focus');
    assert.equal(await page.evaluate(() => transitionProbe.enumerations), 0, 'cadence exit does not enumerate SVG animations');
    if (!config.reduced) {
      const frozen = await page.evaluate(async () => {
        const root = document.querySelector('[data-role="study-cadence"]');
        const band = root.querySelector('.cadence-reveal-band');
        const anim = transitionProbe.animations(band).find(a => a.animationName === 'cadenceBandIn');
        const time = anim?.currentTime;
        await new Promise(resolve => setTimeout(resolve, 60));
        return root.classList.contains('cadence-exit-frozen') && anim?.playState === 'paused' && anim.currentTime === time;
      });
      assert(frozen, 'cadence band reveal freezes without snapping to its final frame');
    }
    // Reversals before old cleanup deadlines must only leave the final page alive.
    for (const name of ['calendar', 'cadence', 'calendar', 'review', 'cadence', 'study', 'calendar']) {
      await activate(page, name); await page.waitForTimeout(25);
    }
    await page.waitForTimeout(2200);
    const final = await page.evaluate(() => {
      const root = document.querySelector('.calendar-embedded');
      const button = document.querySelector('.calendar-spine-tab'), orb = document.querySelector('.spine-active-orb');
      const a = button.getBoundingClientRect(), b = orb.getBoundingClientRect();
      return { view: document.querySelector('.book-view').dataset.viewName,
        frozen: document.querySelectorAll('.calendar-exit-frozen,.cadence-exit-frozen').length,
        error: Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2),
        visible: root.getAttribute('aria-hidden') === 'false' && !root.inert,
        opacity: getComputedStyle(root.querySelector('.calendar-day')).opacity };
    });
    assert.equal(final.view, 'calendar'); assert.equal(final.frozen, 0); assert(final.visible && final.error < 1.1);
    assert.equal(final.opacity, '1', 'interrupted entrance returns to fully visible content');
    if (config.theme === 'light' && config.dpr === 1) {
      await page.mouse.dblclick(1510, 870);
      await page.waitForSelector('.start-page-note-body[contenteditable]');
      await page.locator('.start-page-note-body[contenteditable]').fill('切页便签验证');
      await page.keyboard.press('Escape');
      await activate(page, 'review'); await page.waitForTimeout(800);
      await activate(page, 'calendar'); await page.waitForTimeout(2100);
      assert.equal(await page.locator('.start-page-note-body').textContent(), '切页便签验证', 'empty-page fast path still supports creating and restoring notes');
      await page.locator('.start-page-note').click(); await page.keyboard.press('Backspace');
      await page.waitForTimeout(600);
      assert.equal(await page.locator('.start-page-note').count(), 0);
    }
    await page.screenshot({ path: path.join(root, `behavior-${config.theme}-${config.dpr}${config.reduced ? '-reduced' : ''}.png`) });
    assert.deepEqual(errors, []);
    (report.checks ||= []).push({ config, heatmap, final });
    console.log('transition behavior passed: ' + JSON.stringify(config));
  } finally { await context.close(); }
}

async function sample(page, cdp, from, to, label, run) {
  await activate(page, from);
  await page.waitForTimeout(Number(process.env.RELATUM_TRANSITION_WAIT || 1700));
  const events = [];
  const collect = chunk => events.push(...chunk.value);
  cdp.on('Tracing.dataCollected', collect);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  const getMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const before = await getMetrics();
  const frames = await page.evaluate(async to => {
    const frames = [], started = performance.now();
    let last = 0, firstFrameMs = 0;
    const step = stamp => {
      if (last) frames.push(stamp - last); else firstFrameMs = performance.now() - started;
      last = stamp;
      if (stamp - started < 800) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    document.querySelector(`.left-spine [data-action="${to}-view"]`).click();
    const clickMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 900));
    return { clickMs, firstFrameMs, deltas: frames };
  }, to);
  const after = await getMetrics();
  const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); await finished; cdp.off('Tracing.dataCollected', collect);
  const result = { label, run, from, to, ...frames };
  for (const key of ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount']) result[key] = after[key] - before[key];
  result.paintMs = events.filter(e => e.name === 'Paint' && e.ph === 'X').reduce((n, e) => n + e.dur / 1000, 0);
  result.paintCount = events.filter(e => e.name === 'Paint' && e.ph === 'X').length;
  result.animations = events.filter(e => e.name === 'Animation' && e.args?.data).map(e => e.args.data);
  result.longEvents = events.filter(e => e.ph === 'X' && e.dur > 15000).map(e => ({ name: e.name, ms: e.dur / 1000, data: e.args?.data }));
  fs.writeFileSync(path.join(root, `${label}-${run}-${from}-${to}.trace.json`), JSON.stringify({ traceEvents: events }));
  report.samples.push(result);
  console.log(JSON.stringify({ ...result, deltas: { count: frames.deltas.length, max: Math.max(...frames.deltas), over25: frames.deltas.filter(n => n > 25).length }, animations: result.animations.length }));
}

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: !process.argv.includes('--headed'), ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    report.browser = browser.version();
    report.baseline = process.argv.includes('--compare')
      ? execFileSync('git', ['rev-parse', process.env.RELATUM_SPINE_BASELINE_REF || 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() : null;
    if (process.argv.includes('--behavior')) {
      for (const config of [{ theme: 'light', dpr: 1 }, { theme: 'dark', dpr: 2, language: 'en' },
        { theme: 'light', dpr: 2, reduced: true, width: 680 }]) await behaviorChecks(browser, url, config);
    }
    const labels = process.argv.includes('--behavior') ? [] : process.argv.includes('--compare') ? ['baseline', 'current'] : ['current'];
    for (const label of labels) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
      await context.addInitScript(() => {
        localStorage.setItem('canvas:startWorkspace:v1', 'canvas');
        localStorage.setItem('canvas:startTheme', 'light');
        localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
        localStorage.setItem('canvas:hideSpecialPages', '0');
        localStorage.setItem('canvas:noteGraphPreload:v1', '0');
      });
      if (label === 'baseline') {
        const ref = process.env.RELATUM_SPINE_BASELINE_REF || 'HEAD';
        for (const file of ['start.js', 'styles.css', 'calendar.js', 'study-activity.js', 'start-sticky-notes.js']) {
          const body = execFileSync('git', ['show', `${ref}:assets/${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
          await context.route(`**/${file}`, route => route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body }));
        }
      }
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url + '/index.html?view=study');
      await page.waitForSelector('.left-spine .study-spine-tab.active');
      await page.waitForTimeout(1800);
      for (const to of ['calendar', 'cadence', 'review', 'study', 'focus', 'notes', 'tree-page']) {
        await page.locator(`.left-spine [data-action="${to}-view"]`).evaluate(el => el.click());
        await page.waitForTimeout(1800);
      }
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      if (process.argv.includes('--inspect')) {
        await page.locator('.review-spine-tab').evaluate(el => el.click()); await page.waitForTimeout(800);
        await page.locator('.focus-spine-tab').evaluate(el => el.click());
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          const orb = document.querySelector('.spine-active-orb');
          const anim = orb.getAnimations().find(a => a.transitionProperty === 'transform');
          if (anim) {
            anim.pause();
            const button = document.querySelector('.calendar-spine-tab').getBoundingClientRect();
            const target = button.y + button.height / 2;
            let lo = 0, hi = anim.effect.getTiming().duration;
            for (let i = 0; i < 14; i++) {
              const t = (lo + hi) / 2;
              anim.currentTime = t;
              const rect = orb.getBoundingClientRect();
              if (rect.y + rect.height / 2 < target) lo = t; else hi = t;
            }
          }
        });
        await page.screenshot({ path: path.join(root, `${label}-crossing.png`), clip: { x: 0, y: 70, width: 82, height: 620 } });
        console.log('crossing screenshot: ' + path.join(root, `${label}-crossing.png`));
        await page.evaluate(() => document.querySelector('.spine-active-orb').getAnimations().forEach(a => a.finish()));
      }
      const pairs = process.argv.includes('--top-only')
        ? [['review', 'calendar'], ['calendar', 'review'], ['calendar', 'cadence'], ['cadence', 'review'], ['cadence', 'calendar']]
        : [['study', 'focus'], ['review', 'calendar'], ['calendar', 'review'], ['calendar', 'study'], ['cadence', 'study'], ['study', 'calendar'], ['study', 'cadence']];
      for (let run = 0; run < Number(process.env.RELATUM_TRANSITION_RUNS || 1); run++) {
        for (const [from, to] of pairs) await sample(page, cdp, from, to, label, run);
      }
      await page.screenshot({ path: path.join(root, `${label}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('page transition report: ' + path.join(root, 'report.json'));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

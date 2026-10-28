'use strict';
// Disposable real API + Edge. Timing/heap figures describe this fixture only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-global-system-'));
const key = 'canvas:globalSystem:v1', report = { samples: [], screenshots: [] };
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, windowsHide: true, env: { ...process.env, RELATUM_DATA_ROOT: root } });
  let logs = '', browser;
  server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key }) => {
      if (!localStorage.getItem('qa:system-seeded')) {
        localStorage.setItem('qa:system-seeded', '1');
        localStorage.setItem(key, JSON.stringify({ preload: false, dailyRetention: 'immediate' }));
      }
      window.RelatumDesktopPreferencesSeed = { sessionKey: 'qa', launchId: localStorage.getItem('qa:launch') || 'first' };
    }, { key });
    const page = await context.newPage(), errors = [], pending = new Set(), requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { requests.push(new URL(request.url()).pathname); if (/\/api\/(?:daily|focus|calendar|ledger|diary|countdown)/.test(request.url())) pending.add(request); });
    page.on('requestfinished', request => pending.delete(request)); page.on('requestfailed', request => pending.delete(request));
    async function settled() {
      for (let i = 0; i < 200 && pending.size; i++) await pause(10);
      assert.equal(pending.size, 0, 'business requests settle');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function workspace(name) { assert(await page.evaluate(name => RelatumStartWorkspace.set(name, { animate: false }), name)); await settled(); }
    const policy = dailyRetention => page.evaluate(dailyRetention => RelatumGlobalSystem.update({ dailyRetention }), dailyRetention);
    const dialog = page.locator('#global-settings-dialog');
    await page.goto(base); await page.waitForFunction(() => !!window.RelatumGlobalSettings);
    assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false);
    await page.evaluate(() => RelatumGlobalSettings.open({ category: 'system' }));
    assert(await dialog.locator('[data-role="global-system-preload"]').isVisible(), 'browser exposes System without launcher support');
    assert.equal(await dialog.locator('[data-role="global-daily-retention"]').count(), 4);
    await dialog.locator('[data-role="global-system-preload"]').check();
    assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false, 'UI changes do not affect this launch');
    await dialog.locator('[data-role="global-daily-retention"][value="session"]').check();
    assert.equal(await page.evaluate(() => RelatumGlobalSystem.read().dailyRetention), 'session');
    // A storage error must restore the control without publishing a policy.
    await page.evaluate(() => { window.__storageSet = Storage.prototype.setItem; Storage.prototype.setItem = function(name, value) { if (name === 'canvas:globalSystem:v1') throw Error('QA disk failure'); return __storageSet.call(this, name, value); }; });
    await dialog.locator('[data-role="global-daily-retention"][value="5m"]').click();
    assert(await dialog.locator('[data-role="global-daily-retention"][value="session"]').isChecked());
    await page.evaluate(() => { Storage.prototype.setItem = __storageSet; });
    const search = dialog.locator('.relatum-settings-search input');
    await search.fill('保留'); await dialog.locator('.relatum-settings-result').first().click();
    assert(await dialog.locator('[data-role="global-daily-retention"]').first().evaluate(node => node === document.activeElement));
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => RelatumGlobalSystem.read().dailyRetention), '30s', 'native radio keyboard selection saves');
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => { RelatumI18n.setLanguage(mode === 'dark' ? 'en' : 'zh-CN'); document.body.dataset.startTheme = mode; document.documentElement.dataset.startTheme = mode; }, mode);
      await page.setViewportSize({ width: mode === 'dark' ? 680 : 1440, height: 980 });
      const file = path.join(root, 'system-' + mode + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file);
      assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    }
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.setViewportSize({ width: 1440, height: 980 });
    await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    assert(await dialog.locator('[data-role="global-daily-retention"][value="immediate"]').isChecked());
    await page.evaluate(() => RelatumGlobalSettings.close({ instant: true }));
    await page.reload(); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
    assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false, 'same desktop launch freezes preloading across navigation');
    // Check other served documents share the launch snapshot, including iframe navigation.
    for (const endpoint of ['/editor.html', '/research.html']) {
      await page.goto(base + endpoint); await page.waitForFunction(() => !!window.RelatumFeatureRuntime);
      assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false);
    }
    await page.goto(base); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'qa-research-frame'; frame.src = '/research.html'; document.body.append(frame); });
    const frame = await page.locator('#qa-research-frame').elementHandle();
    const child = await frame.contentFrame(); await child.waitForFunction(() => !!window.RelatumFeatureRuntime);
    assert.equal(await child.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false);
    await page.locator('#qa-research-frame').evaluate(node => node.remove());
    await page.evaluate(() => localStorage.setItem('qa:launch', 'second'));
    await page.reload(); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
    assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), true, 'new launch adopts the saved preload choice');
    await page.evaluate(() => { RelatumGlobalSystem.update({ preload: false }); localStorage.setItem('qa:launch', 'third'); });
    await page.reload(); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
    assert.equal(await page.evaluate(() => RelatumFeatureRuntime.preloadEnabled), false);
    await page.evaluate(async () => { const layout = RelatumStartWorkspace.layout; layout.hidden = layout.hidden.filter(id => id !== 'daily'); await RelatumStartWorkspace.applyLayout(layout); });
    await workspace('daily');
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    async function metrics() { await cdp.send('HeapProfiler.collectGarbage'); const raw = await cdp.send('Performance.getMetrics'); const m = Object.fromEntries(raw.metrics.map(item => [item.name, item.value])); return { heapBytes: m.JSHeapUsedSize, listeners: m.JSEventListeners, nodes: m.Nodes }; }
    for (const mode of ['immediate', 'session']) {
      await policy(mode); const values = []; let rebuilds = 0;
      for (const id of ['calendar', 'focus', 'ledger', 'tasks']) { await page.evaluate(id => RelatumDailyWorkspace.navigate(id), id); await settled(); }
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => { window.__rootBefore = document.querySelector('.daily-page-tasks'); });
        await workspace('canvas');
        if (mode === 'immediate') await page.waitForFunction(() => !document.querySelector('.daily-page'));
        const start = performance.now(); await workspace('daily'); values.push(performance.now() - start);
        rebuilds += await page.evaluate(() => Number(__rootBefore !== document.querySelector('.daily-page-tasks')));
      }
      assert.equal(rebuilds, mode === 'session' ? 0 : 5);
      const warm = await metrics();
      for (let i = 0; i < 12; i++) { await workspace('canvas'); await workspace('daily'); }
      const final = await metrics(); assert(final.listeners <= warm.listeners + 20, 'retention must not accumulate listeners');
      await workspace('canvas');
      if (mode === 'immediate') await page.waitForFunction(() => !document.querySelector('.daily-page'));
      const inactive = await metrics(); await workspace('daily');
      report.samples.push({ mode, returnMs: values, rebuilds, warm, final, inactive });
    }
    await workspace('canvas'); await pause(600);
    const idleRequests = requests.length;
    const frames = await page.evaluate(async () => {
      let count = 0; const original = window.requestAnimationFrame;
      window.requestAnimationFrame = function(callback) { return original(time => { count++; callback(time); }); };
      await new Promise(resolve => setTimeout(resolve, 400)); window.requestAnimationFrame = original; return count;
    });
    assert.equal(frames, 0, 'retained background pages have no animation-frame loop');
    assert.equal(requests.length, idleRequests, 'retained background pages do not poll');
    report.idle = { frames, requests: requests.length - idleRequests, durationMs: 400 };
    // Repeated drag setup on a retained task page must not multiply wrappers.
    await workspace('daily');
    await page.locator('[data-action="daily-compose-toggle"]').click();
    await page.locator('[data-role="focus-daily-input"]').fill('Retention drag probe');
    await page.locator('.focus-daily-add-btn').click(); await page.waitForSelector('.focus-daily-row'); await settled();
    async function pointerSetup() {
      await page.evaluate(() => {
        document.querySelector('.focus-daily-row').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 17, clientX: 100, clientY: 200 }));
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 17 }));
      });
    }
    await pointerSetup(); const dragWarm = await metrics();
    for (let i = 0; i < 6; i++) await pointerSetup();
    const dragFinal = await metrics();
    assert.equal(dragFinal.listeners, dragWarm.listeners, 'repeated drag setup preserves native listener deduplication');
    // Retained calendars still check authoritative data on workspace returns.
    await workspace('daily'); await page.evaluate(() => RelatumDailyWorkspace.navigate('calendar')); await settled();
    await workspace('canvas'); const calendarReads = requests.filter(url => url.startsWith('/api/calendar')).length;
    await workspace('daily'); await settled();
    assert(requests.filter(url => url.startsWith('/api/calendar')).length > calendarReads);
    await page.route('**/api/diary-save', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"QA save failure"}' }));
    await page.locator('[data-diary-body]').fill('Retained diary save boundary');
    assert.equal(await page.evaluate(() => RelatumStartWorkspace.set('canvas', { animate: false })), false, 'retention never bypasses a failed diary save');
    await page.unroute('**/api/diary-save');
    await page.locator('[data-diary-body]').dispatchEvent('compositionstart');
    assert.equal(await page.evaluate(() => RelatumStartWorkspace.set('canvas', { animate: false })), false, 'unfinished composition blocks workspace exit');
    await page.locator('[data-diary-body]').dispatchEvent('compositionend');
    await page.evaluate(() => {
      const service = RelatumFocusService, subscribe = service.subscribe;
      window.__focusSubscriptions = 0;
      service.subscribe = callback => {
        __focusSubscriptions++; const off = subscribe(callback); let live = true;
        return () => { if (live) { __focusSubscriptions--; live = false; } off(); };
      };
    });
    await page.evaluate(() => RelatumDailyWorkspace.navigate('focus')); await settled();
    assert.equal(await page.evaluate(() => __focusSubscriptions), 1);
    await page.locator('[data-role="focus-primary"]').click(); await workspace('canvas');
    assert.equal(await page.evaluate(() => __focusSubscriptions), 0, 'retained Focus view unsubscribes');
    assert(await page.evaluate(() => RelatumFocusService.running && !!RelatumFocusService.ticker), 'independent focus clock keeps running');
    await workspace('daily');
    assert.equal(await page.evaluate(() => __focusSubscriptions), 1, 'return subscribes exactly once');
    await page.evaluate(() => RelatumFocusService.reset());
    await page.evaluate(() => RelatumDailyWorkspace.navigate('calendar')); await settled();
    // Exercise actual TTL callbacks with a browser clock, avoiding minutes of waiting.
    await page.clock.install();
    await policy('30s'); await workspace('canvas');
    await page.clock.fastForward(29000);
    assert(await page.evaluate(() => !!document.querySelector('.daily-page')));
    await page.clock.fastForward(1100);
    assert.equal(await page.locator('.daily-page').count(), 0, '30-second TTL releases instances');
    await workspace('daily'); await policy('5m'); await workspace('canvas');
    await page.clock.fastForward(31000);
    assert(await page.evaluate(() => !!document.querySelector('.daily-page')));
    await page.clock.fastForward(269100);
    assert.equal(await page.locator('.daily-page').count(), 0, 'five-minute TTL releases instances');
    await workspace('daily'); await policy('5m'); await workspace('canvas');
    await page.clock.fastForward(31000);
    await policy('30s'); await page.waitForFunction(() => !document.querySelector('.daily-page'));
    await workspace('daily'); await policy('30s'); await workspace('canvas');
    await page.clock.fastForward(10000); await workspace('daily');
    await page.clock.fastForward(21000);
    assert(await page.evaluate(() => !!document.querySelector('.daily-page')), 'a cancelled release cannot destroy a reopened workspace');
    await workspace('daily'); await policy('session'); await workspace('canvas');
    await page.clock.fastForward(310000);
    assert(await page.evaluate(() => !!document.querySelector('.daily-page')), 'session policy has no expiry');
    await page.evaluate(async () => { const layout = RelatumStartWorkspace.layout; layout.hidden.push('daily'); await RelatumStartWorkspace.applyLayout(layout); });
    await page.waitForFunction(() => !document.querySelector('.daily-page'));
    await page.evaluate(async () => { const layout = RelatumStartWorkspace.layout; layout.hidden = layout.hidden.filter(id => id !== 'daily'); await RelatumStartWorkspace.applyLayout(layout); });
    await workspace('daily');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal(await page.locator('.daily-page').count(), 0, 'pagehide overrides session retention');
    assert.deepEqual(errors, []);
    await cdp.detach();
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Global System UI, errors, launch scope, retention, TTL, IME, stale refresh and idle lifecycle passed');
    console.log(JSON.stringify({ artifacts: root, samples: report.samples }, null, 2));
  } catch (error) { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.error('Artifacts:', root, '\nIsolated server:', logs.slice(-1200)); throw error; }
  finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

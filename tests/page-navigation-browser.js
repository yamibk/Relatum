'use strict';
// Real navigation and intermediate animation frames, using disposable data only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-page-navigation-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function fixture(browser, mode) {
  const root = fs.mkdtempSync(path.join(artifacts, mode + '-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const selected = mode === 'daily' ? ['daily', 'daily.tasks', 'daily.calendar', 'daily.focus', 'daily.ledger']
    : mode === 'special' ? ['canvas', 'canvas.review', 'canvas.study'] : null;
  const choices = Object.fromEntries(catalog.features.map(item => [item.id, selected ? selected.includes(item.id) : item.id !== 'runtime.preload']));
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify({ version: 1, features: choices })],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true });
  let logs = ''; server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(new URL(r.url()).pathname));
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    await page.goto(base); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
  } catch (error) { server.kill(); await context.close(); throw new Error(error.message + '\n' + logs); }
  return { page, context, server, base, errors, requests, root };
}
async function openNavigation(page) {
  await page.evaluate(() => RelatumGlobalSettings.open({ category: 'navigation' }));
  await page.waitForSelector('#global-settings-dialog [data-settings-category="navigation"][aria-current="page"]');
  return page.locator('#global-settings-dialog');
}
async function moveRow(page, list, id, key) {
  await list.locator('[data-sidebar-page="' + id + '"] .note-sidebar-grip').focus(); await page.keyboard.press(key);
  await page.waitForFunction(() => !document.querySelector('#global-settings-dialog .note-sidebar-grip:disabled'));
}
async function fullChecks(browser) {
  const f = await fixture(browser, 'full'), { page, base } = f;
  let groups = [{ id: 'g0', name: '分组零' }, { id: 'g1', name: '分组一' }], rejectReorder = false, writes = [];
  try {
    await page.route('**/api/recent', route => route.fulfill({ json: { files: [], groups } }));
    await page.route('**/api/groups-reorder', route => { writes.push(route.request().postDataJSON().order); return route.fulfill({ status: rejectReorder ? 500 : 200, json: { ok: !rejectReorder } }); });
    await page.reload(); await page.waitForSelector('.page-dot[data-group-id="g0"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:pageOrder:v1')), null);
    const dialog = await openNavigation(page), canvas = dialog.locator('[data-role="canvas-page-order-list"]'), daily = dialog.locator('[data-role="daily-page-order-list"]');
    assert.equal(await dialog.locator('nav [data-settings-category="navigation"]').textContent(), '导航');
    assert.equal(await canvas.locator('input').count(), 0); assert.equal(await daily.locator('input').count(), 0);
    assert(!f.requests.some(url => /daily-workspace\.js|daily-(tasks|focus|calendar|ledger)\.(js|css|html)$/.test(url)), 'navigation settings do not load Daily pages');
    await page.evaluate(() => { window.__recentButton = document.querySelector('.page-dot[data-group-id=""]'); window.__bookRoot = document.querySelector('[data-role="book-stage"]'); });
    await moveRow(page, canvas, 'group:g0', 'Home');
    await moveRow(page, canvas, 'recent', 'Home');
    let order = await page.evaluate(() => RelatumPageLayout.layout('canvas').order);
    assert.deepEqual(order.slice(0, 3), ['recent', 'group:g0', 'review']);
    assert.equal(writes.length, 0, 'settings ordering never writes group data');
    assert(await page.evaluate(() => __recentButton === document.querySelector('.page-dot[data-group-id=""]') && __bookRoot === document.querySelector('[data-role="book-stage"]')));
    // Drag, then Escape: the dynamic list uses the existing cancellation protocol.
    const from = await canvas.locator('[data-sidebar-page="group:g0"] .note-sidebar-grip').boundingBox();
    await page.mouse.move(from.x + 6, from.y + 6); await page.mouse.down(); await page.mouse.move(from.x + 6, from.y + 130, { steps: 8 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => RelatumPageLayout.layout('canvas').order), order);
    await page.evaluate(() => RelatumGlobalSettings.close({ instant: true }));
    // Real wheel navigation follows the interleaved order.
    await page.locator('.page-dot[data-group-id=""]').click();
    const spine = await page.locator('.left-spine').boundingBox();
    await page.mouse.move(spine.x + spine.width + 8, spine.y + 100); await page.mouse.wheel(0, 60);
    await page.waitForSelector('.page-dot[data-group-id="g0"].active');
    await page.mouse.wheel(0, 60); await page.waitForSelector('[data-action="review-view"].active');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.page-dot[data-group-id=""]').click();
    await page.waitForFunction(() => document.querySelector('.book-view').classList.contains('view-back'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Right-click group move swaps only group slots, including failure rollback.
    await page.locator('.page-dot[data-group-id="g0"]').click({ button: 'right' });
    await page.locator('[data-role="context-menu"]').getByText('向下移动', { exact: true }).click();
    await page.waitForFunction(() => RelatumPageLayout.layout('canvas').order[1] === 'group:g1');
    assert.deepEqual(writes.at(-1), ['g1', 'g0']);
    const afterMove = await page.evaluate(() => RelatumPageLayout.layout('canvas').order);
    rejectReorder = true;
    await page.locator('.page-dot[data-group-id="g1"]').click({ button: 'right' });
    const failed = page.waitForResponse(r => r.url().endsWith('/api/groups-reorder') && r.status() === 500);
    await page.locator('[data-role="context-menu"]').getByText('向下移动', { exact: true }).click(); await failed;
    await page.waitForFunction(expected => JSON.stringify(RelatumPageLayout.layout('canvas').order) === JSON.stringify(expected), afterMove);
    // Authoritative metadata refreshes preserve identities and remove deleted groups.
    groups = [{ id: 'g1', name: '重命名一' }, { id: 'g0', name: '分组零' }, { id: 'g2', name: '新增分组' }];
    await page.reload(); await page.waitForSelector('.page-dot[data-group-id="g2"]');
    assert.equal((await page.evaluate(() => RelatumPageLayout.layout('canvas').order)).at(-1), 'group:g2');
    assert.equal(await page.locator('.page-dot[data-group-id="g1"]').getAttribute('aria-label'), '重命名一');
    groups = groups.filter(group => group.id !== 'g0'); await page.reload(); await page.waitForSelector('.page-dot[data-group-id="g2"]');
    assert.equal((await page.evaluate(() => RelatumPageLayout.layout('canvas').order)).includes('group:g0'), false);
    await page.route('**/api/recent', route => route.fulfill({ status: 500, json: { error: 'unreadable' } }));
    await page.reload(); await page.waitForFunction(() => !!window.RelatumPageLayout);
    assert((await page.evaluate(() => RelatumPageLayout.layout('canvas').order)).includes('group:g1'), 'failed listing preserves saved group slots');
    await page.unroute('**/api/recent');
    await page.route('**/api/recent', route => route.fulfill({ json: { files: [], groups } }));
    await page.reload(); await page.waitForSelector('.page-dot[data-group-id="g2"]');
    await openNavigation(page);
    await daily.locator('[data-sidebar-page="ledger"]').scrollIntoViewIfNeeded();
    const dragFrom = await daily.locator('[data-sidebar-page="ledger"] .note-sidebar-grip').boundingBox();
    const dragTo = await daily.locator('[data-sidebar-page="tasks"]').boundingBox();
    await page.mouse.move(dragFrom.x + 6, dragFrom.y + 6); await page.mouse.down();
    await page.mouse.move(dragTo.x + 20, dragTo.y + 3, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => RelatumPageLayout.layout('daily').order[0] === 'ledger');
    await page.screenshot({ path: path.join(artifacts, 'navigation-light.png'), fullPage: true });
    await page.evaluate(async () => {
      RelatumGlobalSettings.close({ instant: true });
      const value = RelatumStartWorkspace.layout; value.hidden = value.hidden.filter(id => id !== 'daily');
      await RelatumStartWorkspace.applyLayout(value); await RelatumStartWorkspace.set('daily');
    });
    await page.waitForSelector('.daily-page-ledger:not([hidden])');
    assert.deepEqual(await page.locator('.daily-navigation button').evaluateAll(nodes => nodes.map(node => node.dataset.dailyPage)), ['ledger', 'tasks', 'calendar', 'focus']);
    await sliderChecks(page);
    await openNavigation(page); await page.locator('#global-settings-dialog [data-settings-action="reset-category"]').click();
    await page.locator('#global-settings-dialog [data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:pageOrder:v1')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('daily:pageOrder:v1')), null);
    assert.deepEqual(f.errors, []); console.log('Full: mixed page order, dynamic groups, wheel/direction, rollback, persistence, reset and slider passed');
  } finally { await f.context.close(); f.server.kill(); }
}
async function sliderChecks(page) {
  const nav = await page.locator('.daily-navigation').boundingBox();
  await page.mouse.move(nav.x + nav.width / 2, nav.y + 30);
  await page.mouse.wheel(0, 60); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'tasks');
  await page.mouse.wheel(0, 60); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'calendar');
  await page.mouse.wheel(0, 60); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'focus');
  await page.mouse.wheel(0, 60); await frames(page);
  assert.equal(await page.evaluate(() => RelatumDailyWorkspace.current), 'focus', 'wheel stops at the last page');
  await page.mouse.wheel(0, -60); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'calendar');
  await page.mouse.move(nav.x + nav.width + 200, nav.y + 200); await page.mouse.wheel(0, -60); await frames(page);
  assert.equal(await page.evaluate(() => RelatumDailyWorkspace.current), 'calendar', 'content wheel does not flip pages');
  await page.evaluate(() => {
    const nav = document.querySelector('.daily-navigation');
    for (const deltaY of [-60, -60]) nav.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => RelatumDailyWorkspace.current === 'ledger');
  await page.mouse.move(nav.x + nav.width / 2, nav.y + 30); await page.mouse.wheel(0, -60); await frames(page);
  assert.equal(await page.evaluate(() => RelatumDailyWorkspace.current), 'ledger', 'wheel stops at the first page');
  await page.evaluate(() => RelatumDailyWorkspace.navigate('tasks')); await frames(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.documentElement.style.setProperty('--spine-motion-ms', '800ms'));
  await page.locator('[data-daily-page="calendar"]').click(); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'calendar');
  await frames(page); await pause(90);
  const middle = await page.evaluate(() => {
    const slider = document.querySelector('.daily-nav-slider'), nav = document.querySelector('.daily-navigation');
    const matrix = new DOMMatrix(getComputedStyle(slider).transform), track = new DOMMatrix(getComputedStyle(slider.firstElementChild).transform);
    return { y: matrix.m42, start: nav.querySelector('[data-daily-page="tasks"]').offsetTop, end: nav.querySelector('[data-daily-page="calendar"]').offsetTop, inverse: matrix.m42 + track.m42 };
  });
  assert(middle.y > middle.start && middle.y < middle.end, 'the carrier has a real intermediate position');
  assert(Math.abs(middle.inverse) < .5, 'opposite glyph transforms stay aligned while moving');
  const jump = await page.evaluate(() => {
    const node = document.querySelector('.daily-nav-slider'), y = () => new DOMMatrix(getComputedStyle(node).transform).m42;
    const before = y(); RelatumDailyWorkspace.navigate('ledger'); const after = y(); return Math.abs(after - before);
  });
  assert(jump < 1, 'quick reversal continues from the current position');
  await page.waitForFunction(() => RelatumDailyWorkspace.current === 'ledger'); await pause(850);
  await page.locator('[data-daily-page="ledger"]').focus(); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => RelatumDailyWorkspace.current === 'tasks');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 600, height: 850 }); await frames(page);
  await page.locator('[data-daily-page="tasks"]').focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => RelatumDailyWorkspace.current === 'calendar'); await frames(page);
  await page.locator('[data-daily-page="calendar"]').hover(); await page.mouse.wheel(0, -60);
  await page.waitForFunction(() => RelatumDailyWorkspace.current === 'tasks');
  await page.mouse.wheel(0, 60); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'calendar'); await frames(page);
  assert(await page.evaluate(() => {
    const pill = document.querySelector('.daily-nav-slider').getBoundingClientRect(), button = document.querySelector('[data-daily-page="calendar"]').getBoundingClientRect();
    return Math.abs(pill.x - button.x) < 1 && Math.abs(pill.y - button.y) < 1;
  }), 'narrow horizontal navigation calibrates the carrier');
  await page.evaluate(() => RelatumI18n.setLanguage('en')); await frames(page);
  await page.evaluate(() => document.querySelector('[data-action="start-theme-toggle"]').click());
  await page.screenshot({ path: path.join(artifacts, 'daily-narrow-dark.png') });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
  await page.route('**/api/diary-save', route => route.fulfill({ status: 500, json: { error: 'test save failure' } }));
  await page.locator('[data-diary-body]').fill('保存失败时保留日历与滑块');
  const failure = page.waitForResponse(r => r.url().endsWith('/api/diary-save') && r.status() === 500);
  await page.locator('[data-daily-page="tasks"]').click(); await failure; await frames(page);
  assert.equal(await page.evaluate(() => RelatumDailyWorkspace.current), 'calendar');
  assert(await page.evaluate(() => {
    const slider = document.querySelector('.daily-nav-slider'), button = document.querySelector('[data-daily-page="calendar"]');
    return Math.abs(new DOMMatrix(getComputedStyle(slider).transform).m42 - button.offsetTop) < 1;
  }), 'failed saving restores the committed marker');
  await page.unroute('**/api/diary-save');
  await page.locator('[data-daily-page="tasks"]').click(); await page.waitForFunction(() => RelatumDailyWorkspace.current === 'tasks');
  await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
  assert.equal(await page.locator('.daily-navigation').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
  await frames(page);
  await page.evaluate(() => { window.__idleFrames = 0; const raf = requestAnimationFrame; window.requestAnimationFrame = fn => { __idleFrames++; return raf(fn); }; });
  await pause(400); assert.equal(await page.evaluate(() => __idleFrames), 0, 'idle navigation has no RAF loop');
}
async function restrictedChecks(browser, mode) {
  const f = await fixture(browser, mode), { page } = f;
  try {
    await openNavigation(page);
    if (mode === 'daily') {
      assert.equal(await page.locator('[data-role="canvas-page-order-list"]').count(), 0);
      assert(await page.locator('#global-settings-dialog [data-role="spine-speed-range"]').isVisible());
      const list = page.locator('[data-role="daily-page-order-list"]'); await moveRow(page, list, 'focus', 'Home');
      assert(!f.requests.some(url => /daily-workspace\.js$/.test(url)));
      await page.locator('#global-settings-dialog [data-role="spine-speed-range"]').fill('700');
      await page.locator('#global-settings-dialog [data-role="spine-speed-range"]').dispatchEvent('input');
      await page.locator('#global-settings-dialog [data-settings-action="reset-category"]').click(); await page.locator('#global-settings-dialog [data-settings-action="accept-reset"]').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('daily:pageOrder:v1')), null);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--spine-motion-ms').trim()), '447ms');
      await moveRow(page, list, 'focus', 'Home');
      await page.evaluate(async () => { RelatumGlobalSettings.close({ instant: true }); const value = RelatumStartWorkspace.layout; value.hidden = []; await RelatumStartWorkspace.applyLayout(value); });
      await page.waitForFunction(() => window.RelatumDailyWorkspace?.current === 'focus');
    } else {
      await moveRow(page, page.locator('[data-role="canvas-page-order-list"]'), 'study', 'Home');
      await page.evaluate(() => RelatumGlobalSettings.close({ instant: true }));
      assert(await page.locator('[data-role="page-dots"] [data-action="study-view"]').isVisible(), 'special-only sessions keep the unified navigation visible');
      assert.deepEqual(await page.locator('[data-role="page-dots"] > button').evaluateAll(nodes => nodes.map(node => node.dataset.action)), ['study-view', 'review-view']);
      await page.reload(); await page.waitForSelector('[data-action="study-view"].active');
    }
    assert.deepEqual(f.errors, []); console.log(mode + ': feature filtering, reordered startup and shell settings passed');
  } finally { await f.context.close(); f.server.kill(); }
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH, headless: true });
  try { await fullChecks(browser); await restrictedChecks(browser, 'daily'); await restrictedChecks(browser, 'special'); }
  finally { await browser.close(); console.log('Artifacts: ' + artifacts); }
})().catch(error => { console.error(error); process.exitCode = 1; });

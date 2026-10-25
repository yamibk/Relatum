'use strict';
// Focused theme-artwork checks on the two production shells, using disposable data.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-theme-icons-')), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value; }
async function run(browser, mode) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-theme-data-'));
  const enabled = mode === 'library' ? ['canvas', 'canvas.library', 'canvas.editor'] : ['career'];
  const number = await freePort(), url = 'http://127.0.0.1:' + number;
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, enabled.includes(item.id)])) };
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(number), '--launch-profile', JSON.stringify(profile)], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'no-preference' });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const dialog = page.locator('#global-settings-dialog'), button = dialog.locator('[data-action="start-theme-toggle"]');
  const state = () => page.evaluate(() => Array.from(document.querySelectorAll('.start-theme-toggle-icon')).map(icon => ({
    scale: new DOMMatrix(getComputedStyle(icon.querySelector('.theme-icon-disc')).transform).a,
    opacity: Number(getComputedStyle(icon.querySelector('.theme-icon-rays')).opacity),
    cutout: new DOMMatrix(getComputedStyle(icon.querySelector('.theme-icon-cutout')).transform).e,
    width: icon.getBoundingClientRect().width,
    svgWidth: icon.querySelector('svg').getBoundingClientRect().width,
    running: icon.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
  })));
  const closeTo = (value, expected) => assert(Math.abs(value - expected) < .015, `${value} should equal ${expected}`);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready);
    if (mode === 'library') assert((await fetch(url + '/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok);
    await context.addInitScript(() => {
      if (!sessionStorage.getItem('theme-seeded')) { localStorage.setItem('canvas:startTheme', 'dark'); sessionStorage.setItem('theme-seeded', '1'); }
      function firstFrame() {
        const icon = Array.from(document.querySelectorAll('.start-theme-toggle-icon svg')).find(node => node.getClientRects().length);
        if (!icon) { requestAnimationFrame(firstFrame); return; }
        window.firstThemeFrame = { theme: document.documentElement.dataset.startTheme, scale: new DOMMatrix(getComputedStyle(icon.querySelector('.theme-icon-disc')).transform).a, running: icon.getAnimations({ subtree: true }).length };
      }
      requestAnimationFrame(firstFrame);
    });
    await page.goto(url); await page.waitForFunction(() => window.RelatumGlobalSettings);
    await page.evaluate(() => RelatumGlobalSettings.open({ category: 'appearance' })); await dialog.waitFor();
    await page.waitForFunction(() => window.firstThemeFrame);
    const first = await page.evaluate(() => firstThemeFrame);
    assert.equal(first.theme, 'dark'); closeTo(first.scale, 1.7); assert.equal(first.running, 0, 'dark startup has no introductory animation');
    await pause(220);
    const ids = await page.locator('.start-theme-toggle-icon mask').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(ids.length, mode === 'library' ? 2 : 1); assert.equal(new Set(ids).size, ids.length);
    for (const icon of (await state()).filter(icon => icon.width)) { closeTo(icon.scale, 1.7); closeTo(icon.opacity, 0); closeTo(icon.cutout, -7); assert.equal(icon.width, 20); assert.equal(icon.svgWidth, 20); }
    assert(await page.locator('.start-theme-toggle-icon').first().evaluate(icon => getComputedStyle(icon).backgroundColor === 'rgba(0, 0, 0, 0)'));
    await page.screenshot({ path: path.join(artifacts, mode + '-moon.png') });
    await button.click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.startTheme), 'light', 'page theme switches immediately');
    // Sample actual CSS transitions deterministically at their middle frame.
    await page.evaluate(() => document.querySelectorAll('.start-theme-toggle-icon').forEach(icon => icon.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 160; })));
    const middle = (await state()).filter(icon => icon.width); assert(middle[0].scale > 1 && middle[0].scale < 1.7); assert(middle[0].cutout > -7 && middle[0].cutout < 0);
    await page.screenshot({ path: path.join(artifacts, mode + '-middle.png') });
    await page.evaluate(() => document.querySelectorAll('.start-theme-toggle-icon').forEach(icon => icon.getAnimations({ subtree: true }).forEach(animation => animation.finish())));
    await pause(30);
    for (const icon of await state()) { closeTo(icon.scale, 1); closeTo(icon.opacity, 1); closeTo(icon.cutout, 0); }
    await page.screenshot({ path: path.join(artifacts, mode + '-sun.png') });
    await button.click(); await pause(100);
    const reverse = await page.evaluate(() => {
      const disc = document.querySelector('#global-settings-dialog .theme-icon-disc');
      const before = new DOMMatrix(getComputedStyle(disc).transform).a;
      document.querySelector('#global-settings-dialog [data-action="start-theme-toggle"]').click();
      return { before, after: new DOMMatrix(getComputedStyle(disc).transform).a };
    });
    assert(reverse.before > 1 && reverse.before < 1.7); assert(Math.abs(reverse.before - reverse.after) < .04, 'reversing continues from the displayed geometry');
    await pause(420); for (const icon of await state()) closeTo(icon.scale, 1);
    await page.evaluate(() => RelatumI18n.setLanguage('en')); await button.click(); await pause(400);
    assert.equal(await button.getAttribute('aria-label'), 'Switch to light theme'); assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({ width: 560, height: 780 }); await page.screenshot({ path: path.join(artifacts, mode + '-narrow.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' }); await button.click();
    for (const icon of await state()) { closeTo(icon.scale, 1); closeTo(icon.cutout, 0); assert.equal(icon.running, 0); }
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await button.click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    for (const icon of await state()) { if (icon.width) closeTo(icon.scale, 1.7); assert.equal(icon.running, 0); }
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); RelatumGlobalSettings.open({ category: 'appearance' }); }); await pause(220);
    await button.click(); await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    for (const icon of await state()) { closeTo(icon.scale, 1); assert.equal(icon.running, 0); }
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.reload(); await page.waitForFunction(() => window.RelatumGlobalSettings);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:startTheme')), 'light');
    await page.evaluate(() => RelatumGlobalSettings.open({ category: 'appearance' })); await page.waitForFunction(() => window.firstThemeFrame); await pause(450);
    const rafCalls = await page.evaluate(async () => {
      const original = window.requestAnimationFrame; let calls = 0;
      window.requestAnimationFrame = callback => { calls++; return original(callback); };
      try { await new Promise(resolve => setTimeout(resolve, 350)); return calls; } finally { window.requestAnimationFrame = original; }
    });
    assert.equal(rafCalls, 0, 'idle icon has no RAF loop'); assert.deepEqual(errors, []);
    console.log(mode + ': cold boot, morph, reversal, synchronization and lifecycle passed');
  } catch (error) { await page.screenshot({ path: path.join(artifacts, mode + '-failure.png') }).catch(() => {}); console.error({ errors, icons: await state().catch(() => []) }); throw error; }
  finally {
    await context.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    assert(data.startsWith(path.join(os.tmpdir(), 'relatum-theme-data-'))); fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of ['library', 'career']) await run(browser, mode); }
  finally { await browser.close(); console.log('Artifacts: ' + artifacts); }
})().catch(error => { console.error(error); process.exitCode = 1; });

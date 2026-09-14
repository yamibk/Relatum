'use strict';

// Desktop-shell behavior in a real browser, with an isolated notes root and a
// stubbed pywebview bridge so the window is not actually destroyed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-focus-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

(async () => {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/?desktop=1`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/runtime`)).ok) break; } catch (error) {}
      await sleep(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      if (localStorage.getItem('canvas:startWorkspace:v1') === null) localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      if (localStorage.getItem('canvas:noteFocusMode:v1') === null) localStorage.setItem('canvas:noteFocusMode:v1', '1');
      window.__closeCalls = 0;
      window.pywebview = { api: {
        set_dirty() {}, set_note_workspace_active() {},
        get_window_state: async () => ({ maximized: false }),
        close_window: async () => {
          window.__closeCalls += 1;
          if (window.__holdClose) await new Promise(resolve => { window.__releaseClose = resolve; });
        },
      } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const boot = await page.evaluate(() => ({
      workspace: document.body.dataset.startWorkspace,
      focused: document.body.classList.contains('note-focus-mode'),
      topHeight: document.querySelector('.top-bar').getBoundingClientRect().height,
    }));
    assert.equal(boot.workspace, 'notes');
    assert.equal(boot.focused, true);
    assert(boot.topHeight < 1, 'restored focus must hide the title bar before first paint');
    await page.waitForFunction(() => window.CanvasNoteWorkspace && document.querySelector('.desktop-note-focus-close'));
    const floating = page.locator('.desktop-note-focus-close');
    const toggle = page.locator('[data-note-action="toggle-focus"]');
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert(await floating.isVisible());
    assert(await page.evaluate(() => document.elementFromPoint(innerWidth - 23, 20).closest('.desktop-note-focus-close') !== null));
    await sleep(500);
    await page.screenshot({ path: path.join(root, 'focus-light.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(root, 'focus-dark.png') });
    await page.setViewportSize({ width: 720, height: 500 });
    await page.screenshot({ path: path.join(root, 'focus-narrow.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
    await page.setViewportSize({ width: 1280, height: 800 });

    await toggle.click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFocusMode:v1')), '0');
    assert.equal(await floating.getAttribute('aria-hidden'), 'true');
    assert.equal(await floating.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    await sleep(400);
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height > 40));
    await toggle.click();
    await sleep(240);
    const enteringOpacity = await page.locator('.desktop-note-focus-controls').evaluate(node => Number(getComputedStyle(node).opacity));
    assert(enteringOpacity > 0 && enteringOpacity < 1, 'focus controls should fade in gradually');
    await page.screenshot({ path: path.join(root, 'focus-controls-fade.png') });
    await sleep(220);
    assert.equal(await page.locator('.desktop-note-focus-controls').evaluate(node => getComputedStyle(node).pointerEvents), 'auto');
    await toggle.click();
    await sleep(400);
    await page.evaluate(() => { const button = document.querySelector('[data-note-action="toggle-focus"]'); for (let i = 0; i < 7; i++) button.click(); });
    await sleep(410);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFocusMode:v1')), '1');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('note-focus-transitioning')), false);
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height < 1));
    await toggle.click();
    await sleep(80);
    await toggle.click();
    await sleep(80);
    await toggle.click();
    await sleep(80);
    await toggle.click();
    await sleep(410);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteFocusMode:v1')), '1');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('note-focus-transitioning')), false);
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height < 1));
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');

    await page.evaluate(() => document.querySelector('[data-start-workspace="canvas"]').click());
    await page.waitForFunction(() => document.body.dataset.startWorkspace === 'canvas');
    assert.equal(await floating.getAttribute('aria-hidden'), 'true');
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height > 40));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('body').getAttribute('data-start-workspace'), 'canvas');
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height > 40));
    assert.equal(await page.locator('.desktop-note-focus-close').getAttribute('aria-hidden'), 'true');
    await page.locator('[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => document.body.dataset.startWorkspace === 'notes');
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert(await page.locator('body').evaluate(node => node.classList.contains('note-focus-mode')));
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height < 1));
    await page.waitForFunction(() => window.CanvasNoteWorkspace?.currentPath !== undefined);
    await page.locator('.note-head-actions [data-note-action="new-note"]').click();
    await page.waitForFunction(() => !!CanvasNoteWorkspace.currentPath);
    const notePath = await page.evaluate(() => CanvasNoteWorkspace.currentPath);
    assert(notePath && notePath.endsWith('.md'));
    await page.locator('.cm-content').click();
    await page.keyboard.type('Saved before close');
    await floating.click();
    await page.waitForFunction(() => window.__closeCalls === 1);
    assert(fs.readFileSync(path.join(root, 'notes', notePath), 'utf8').includes('Saved before close'));
    await page.evaluate(() => { window.__holdClose = true; });
    await page.locator('.desktop-window-controls [data-window-action="close"]').evaluate(node => node.click());
    await page.waitForFunction(() => window.__closeCalls === 2);
    await floating.click();
    assert.equal(await page.evaluate(() => window.__closeCalls), 2, 'a close already in flight must not run twice');
    await page.evaluate(() => { window.__holdClose = false; window.__releaseClose(); });
    await page.evaluate(() => CanvasDesktop.setBeforeCloseHandler(async () => false));
    await floating.click();
    await sleep(100);
    assert.equal(await page.evaluate(() => window.__closeCalls), 2, 'a failed save must veto both close buttons');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggle.click();
    await toggle.click();
    assert.equal(await floating.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await page.locator('.top-bar').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('note focus desktop browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

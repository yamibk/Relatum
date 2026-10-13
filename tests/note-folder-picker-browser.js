'use strict';

// Real wheel input and production search UI; data/profile always disposable.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-folder-picker-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch {} await sleep(100); }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [], queries = [];
    page.on('pageerror', error => errors.push(error.message));
    const entries = Array.from({ length: 1000 }, (_, i) => ({ kind: 'folder', name: 'Folder-' + String(i).padStart(4, '0'), path: 'Folder-' + String(i).padStart(4, '0'), children: [] }));
    await page.route('**/api/notes-tree*', route => route.fulfill({ json: { entries, pagination: { '': { offset: 1000, hasMore: false } },
      notebookSettings: { version: 1, colors: {}, ui: { open: false, mode: 'notebooks', selectedRoot: '', expanded: [] } } } }));
    await page.route('**/api/note-query', route => {
      queries.push(route.request().postDataJSON()); return route.fulfill({ json: { items: [], total: 0, hasMore: false } });
    });
    await page.goto(url); await page.locator('button[data-start-workspace="notes"]').click();
    await page.locator('[data-role="note-tree"] .note-tree-row').first().waitFor();
    await page.keyboard.press('Control+Shift+F');
    await page.locator('.note-search-filter-button').click();
    const input = page.locator('[data-note-search="folder"]'), menu = page.locator('.note-search-folder-menu');
    const toggle = page.locator('.note-search-folder-toggle');
    await toggle.click();
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    assert(await menu.locator('[role="option"]').count() < 40, '1000 folders have a bounded mounted viewport');
    const box = await menu.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const parentScroll = await page.locator('.note-browser-results').evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 160);
    const samples = await menu.evaluate(async node => {
      const values = [node.scrollTop];
      for (let i = 0; i < 80; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve)); values.push(node.scrollTop);
        if (Math.abs(node.scrollTop - 160) < .5) break;
      }
      return values;
    });
    assert(new Set(samples).size > 3 && samples.some(value => value > 0 && value < 160), 'real wheel scrolls through intermediate positions');
    assert(Math.abs(samples.at(-1) - 160) <= 1, JSON.stringify(samples));
    assert.equal(await page.locator('.note-browser-results').evaluate(node => node.scrollTop), parentScroll, 'wheel stays inside the dropdown');
    await menu.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, cancelable: true })); node.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, cancelable: true })); });
    await sleep(400); assert(Math.abs(await menu.evaluate(node => node.scrollTop) - 320) <= 1, 'rapid detents accumulate');
    await menu.evaluate(node => node.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, cancelable: true })));
    await sleep(40);
    const reverse = await menu.evaluate(node => { const before = node.scrollTop; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, cancelable: true })); return before; });
    await sleep(400); assert(Math.abs(await menu.evaluate(node => node.scrollTop) - Math.max(0, reverse - 80)) <= 1, 'reversal starts at the visible position');
    await input.press('Escape'); assert.equal(await menu.isHidden(), true);
    assert.equal(await menu.locator('[role="option"]').count(), 0, 'closing releases candidates');
    const chosen = page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.scope?.path === 'Folder-0000');
    await input.press('ArrowDown'); await input.press('Enter'); await chosen;
    assert.equal(await input.inputValue(), 'Folder-0000');
    assert.deepEqual(queries.at(-1).scope, { kind: 'folder', path: 'Folder-0000' });
    await input.fill('0999');
    await menu.locator('[data-folder-path="Folder-0999"]').click();
    assert.equal(await input.inputValue(), 'Folder-0999'); assert.equal(await menu.isHidden(), true);
    await input.fill(''); await toggle.click(); if (await menu.isHidden()) await toggle.click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await menu.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, cancelable: true })); return node.scrollTop; });
    assert.equal(reduced, 160, 'reduced motion is immediate');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('[data-note-search="query"]').click(); assert.equal(await menu.isHidden(), true, 'outside focus closes');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.setViewportSize({ width: 700, height: 700 });
    await toggle.click(); await menu.waitFor();
    if (process.env.RELATUM_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-folder-picker-dark-narrow.png') });
    }
    await menu.evaluate(node => node.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, cancelable: true })));
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
    });
    assert.equal(await menu.isHidden(), true, 'minimizing closes and cancels scrolling');
    await input.dispatchEvent('compositionend'); assert.equal(await menu.isHidden(), true, 'late input cannot reopen a hidden workspace');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'folder picker: ok', wheelSamples: samples, folders: 1000 }));
  } finally {
    if (browser) await browser.close(); service.kill();
    await new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('relatum-folder-picker-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

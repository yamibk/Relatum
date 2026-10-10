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
      window.__maximizeCalls = 0; window.__minimizeCalls = 0; window.__maximized = false;
      window.__dragStarts = 0;
      document.addEventListener('mousedown', event => {
        if (event.target.closest('.pywebview-drag-region')) window.__dragStarts++;
      });
      window.pywebview = { api: {
        set_dirty() {}, set_note_workspace_active() {},
        get_window_state: async () => ({ maximized: false }),
        minimize: async () => { window.__minimizeCalls++; },
        toggle_maximize: async () => { window.__maximizeCalls++; window.__maximized = !window.__maximized; return { maximized: window.__maximized }; },
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
    const visibleFocusIcon = () => toggle.locator('svg').evaluateAll(icons =>
      icons.filter(icon => getComputedStyle(icon).display !== 'none').map(icon => icon.querySelector('use').getAttribute('href')));
    async function expectSeparatedCloseButtons() {
      const sidebarToggle = page.locator('[data-note-action="toggle-notebooks"]');
      const initiallyOpen = await sidebarToggle.getAttribute('aria-expanded') === 'true';
      if (!initiallyOpen) await sidebarToggle.click();
      await sleep(300);
      const geometry = await page.evaluate(() => {
        const close = document.querySelector('[data-note-action="close-links"]');
        const panel = close.getBoundingClientRect();
        const controls = document.querySelector('.desktop-note-focus-controls').getBoundingClientRect();
        const modes = [...document.querySelectorAll('.note-side-modes button')].map(button => {
          const rect = button.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, right: rect.right };
        });
        const nav = document.querySelector('.note-side-modes').getBoundingClientRect();
        return { panelRight: panel.right, panelLeft: panel.left, controlsLeft: controls.left,
          modes, navRight: nav.right, panelTop: panel.top, panelBottom: panel.bottom,
          hit: document.elementFromPoint(panel.x + panel.width / 2, panel.y + panel.height / 2)?.closest('button')?.dataset.noteAction };
      });
      assert(geometry.panelRight <= geometry.controlsLeft - 7, 'sidebar close has a gap before the desktop window controls');
      assert(geometry.navRight <= geometry.panelLeft && geometry.modes.every(rect => rect.top >= geometry.panelTop - 1 && rect.bottom <= geometry.panelBottom + 1), 'scrolling sidebar tabs remain on the first row, clipped before the fixed close button');
      assert.equal(geometry.hit, 'close-links', 'sidebar close remains clickable independently');
      const calls = await page.evaluate(() => __closeCalls);
      await page.locator('[data-note-action="close-links"]').click();
      assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => __closeCalls), calls, 'sidebar close never closes the window');
      assert.equal(await floating.getAttribute('aria-hidden'), 'false');
      if (initiallyOpen) await sidebarToggle.click();
      await sleep(300);
    }
    const dragSelectors = ['.note-tree-pane > .note-pane-head', '.note-tab-bar'];
    async function expectDragMarkers(enabled) {
      assert.deepEqual(await page.evaluate(selectors => selectors.map(selector => document.querySelector('#start-notes-workspace ' + selector).classList.contains('pywebview-drag-region')), dragSelectors), [enabled, enabled]);
    }
    async function blankPoint(selector) {
      const rect = await page.locator('#start-notes-workspace ' + selector).boundingBox();
      return { x: rect.x + 4, y: rect.y + 3 };
    }
    async function expectBlankDrag() {
      const before = await page.evaluate(() => __dragStarts);
      const hits = [];
      for (const selector of dragSelectors) {
        const point = await blankPoint(selector);
        // The narrow layout intentionally keeps the closed file tree offscreen.
        if (point.x < 0) continue;
        hits.push(await page.evaluate(({point, selector}) => ({selector, point, hit:document.elementFromPoint(point.x, point.y)?.className}), {point, selector}));
        await page.mouse.move(point.x, point.y); await page.mouse.down();
        await page.mouse.move(point.x + 2, point.y + 1); await page.mouse.up();
      }
      assert.equal(await page.evaluate(() => __dragStarts), before + hits.length, JSON.stringify(hits));
    }
    await expectDragMarkers(true);
    await expectBlankDrag();
    const secondaryStarts = await page.evaluate(() => __dragStarts);
    for (const selector of dragSelectors) {
      const point = await blankPoint(selector);
      await page.mouse.click(point.x, point.y, { button: 'right' });
      await page.mouse.click(point.x, point.y, { button: 'middle' });
    }
    assert.equal(await page.evaluate(() => __dragStarts), secondaryStarts, 'only the primary mouse button may start dragging');
    const protectedStarts = await page.evaluate(() => __dragStarts);
    await page.locator('.note-library-focus-button svg').first().dispatchEvent('mousedown', { button: 0 });
    await page.locator('.note-expand-all svg').first().dispatchEvent('mousedown', { button: 0 });
    await page.evaluate(() => {
      const header = document.querySelector('.note-tree-pane > .note-pane-head');
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<span>menu item</span>';
      header.appendChild(menu); menu.firstChild.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); menu.remove();
    });
    assert.equal(await page.evaluate(() => __dragStarts), protectedStarts, 'buttons, disabled buttons and popup descendants must not drag the window');
    await page.locator('.note-library-focus-button svg').first().dispatchEvent('dblclick', { button: 0 });
    assert.equal(await page.evaluate(() => __maximizeCalls), 0);
    let point = await blankPoint(dragSelectors[0]);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(() => __maximizeCalls === 1 && document.body.classList.contains('desktop-maximized'));
    await expectDragMarkers(false);
    const maximizedStarts = await page.evaluate(() => __dragStarts);
    point = await blankPoint(dragSelectors[1]);
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => __dragStarts), maximizedStarts);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(() => __maximizeCalls === 2 && !document.body.classList.contains('desktop-maximized'));
    await expectDragMarkers(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('canvasdesktop:window-state', { detail: { maximized: true } })));
    await expectDragMarkers(false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('canvasdesktop:window-state', { detail: { maximized: false } })));
    await expectDragMarkers(true);
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await visibleFocusIcon(), ['#note-icon-focus-contract'], 'show-top-bar uses four inward arrows');
    assert(await floating.isVisible());
    assert(await page.evaluate(() => document.elementFromPoint(innerWidth - 23, 20).closest('.desktop-note-focus-close') !== null));
    await sleep(500);
    await expectSeparatedCloseButtons();
    await page.screenshot({ path: path.join(root, 'focus-light.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await expectSeparatedCloseButtons();
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await expectSeparatedCloseButtons();
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await expectBlankDrag();
    await page.screenshot({ path: path.join(root, 'focus-dark.png') });
    await page.setViewportSize({ width: 720, height: 500 });
    await expectSeparatedCloseButtons();
    await expectBlankDrag();
    await page.screenshot({ path: path.join(root, 'focus-narrow.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
    await page.setViewportSize({ width: 1280, height: 800 });

    await toggle.click();
    await expectDragMarkers(false);
    assert.deepEqual(await visibleFocusIcon(), ['#note-icon-focus-expand'], 'hide-top-bar uses four outward arrows');
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
    await expectDragMarkers(true);
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
    await expectDragMarkers(false);
    assert.equal(await floating.getAttribute('aria-hidden'), 'true');
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height > 40));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('body').getAttribute('data-start-workspace'), 'canvas');
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height > 40));
    assert.equal(await page.locator('.desktop-note-focus-close').getAttribute('aria-hidden'), 'true');
    await page.locator('[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => document.body.dataset.startWorkspace === 'notes');
    await expectDragMarkers(true);
    assert.equal(await floating.getAttribute('aria-hidden'), 'false');

    await page.reload({ waitUntil: 'domcontentloaded' });
    assert(await page.locator('body').evaluate(node => node.classList.contains('note-focus-mode')));
    assert(await page.locator('.top-bar').evaluate(node => node.getBoundingClientRect().height < 1));
    await page.waitForFunction(() => window.CanvasNoteWorkspace?.currentPath !== undefined);
    await page.locator('.note-head-actions [data-note-action="new-note"]').click();
    await page.waitForFunction(() => !!CanvasNoteWorkspace.currentPath);
    await expectDragMarkers(true);
    const tabStarts = await page.evaluate(() => __dragStarts), maximizeCalls = await page.evaluate(() => __maximizeCalls);
    await page.locator('.note-tab-label').first().dispatchEvent('mousedown', { button: 0 });
    await page.locator('.note-tab-label').first().dispatchEvent('dblclick', { button: 0 });
    assert.equal(await page.evaluate(() => __dragStarts), tabStarts);
    assert.equal(await page.evaluate(() => __maximizeCalls), maximizeCalls, 'tab double clicks must not maximize');
    await page.locator('.desktop-note-focus-controls [data-window-action="minimize"]').click();
    assert.equal(await page.evaluate(() => __minimizeCalls), 1);
    const notePath = await page.evaluate(() => CanvasNoteWorkspace.currentPath);
    assert(notePath && notePath.endsWith('.md'));
    await page.locator('[data-note-action="new-tab"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-tab').length === 2);
    const tabsBefore = await page.locator('.note-tab').evaluateAll(nodes => nodes.map(node => node.dataset.noteTabPath));
    const sortingStarts = await page.evaluate(() => __dragStarts);
    await page.locator('.note-tab').first().dragTo(page.locator('.note-tab').last());
    assert.deepEqual(await page.locator('.note-tab').evaluateAll(nodes => nodes.map(node => node.dataset.noteTabPath)), tabsBefore.slice().reverse());
    assert.equal(await page.evaluate(() => __dragStarts), sortingStarts, 'sorting tabs must not start window dragging');
    await page.locator('.note-tab').filter({ hasText: path.basename(notePath, '.md') }).click();
    await page.waitForFunction(note => CanvasNoteWorkspace.currentPath === note, notePath);
    await page.locator('.note-tab.is-blank .note-tab-close').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-tab').length === 1);
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
    await expectSeparatedCloseButtons();
    assert.equal(await floating.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await page.locator('.top-bar').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.deepEqual(errors, []);
    const browserContext = await browser.newContext();
    await browserContext.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '1'); });
    const browserPage = await browserContext.newPage();
    await browserPage.goto(`http://127.0.0.1:${port}/`);
    assert.equal(await browserPage.locator('#start-notes-workspace .pywebview-drag-region').count(), 0);
    assert.equal(await browserPage.locator('.desktop-note-focus-controls').count(), 0);
    await browserPage.waitForFunction(() => window.CanvasNoteWorkspace);
    await browserPage.locator('[data-note-action="toggle-notebooks"]').click();
    await sleep(300);
    assert.equal(await browserPage.locator('.note-links-head').evaluate(node => getComputedStyle(node).paddingRight), '12px', 'ordinary browser does not reserve desktop control space');
    await browserContext.close();
    await context.close();
    console.log('note focus desktop browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

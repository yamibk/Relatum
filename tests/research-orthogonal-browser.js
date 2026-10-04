'use strict';
// Real API + isolated data root. Playwright and Edge belong to the test host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port;
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-orthogonal-'));
  const port = await freePort(), url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root, PYTHONUTF8: '1' }, windowsHide: true, stdio: 'ignore' });
  let browser;
  const errors = [];
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/research/workspace')).ok) break; } catch (_error) {}
      await sleep(100);
    }
    const fixture = { researchVersion: 3, subcircuits: [], activePageId: 'research-page-1', pages: [
      { id: 'research-page-1', title: '', nodes: [{ id: 'old-note', type: 'note', label: 'original',
        x: 900, y: 140, width: 176, height: 72, config: {}, statePolicy: 'reset' }], edges: [],
      view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 } },
    ] };
    const seed = await fetch(url + '/api/research/workspace', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: fixture, revision: '' }) });
    assert(seed.ok, await seed.text());
    browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || undefined });
    if (process.argv.includes('--subcircuits')) {
      const report = await require('./research-subcircuits-browser.js').run(require(process.env.RELATUM_PLAYWRIGHT || 'playwright'), url,
        { edgePath: process.env.RELATUM_EDGE_PATH });
      assert.deepEqual(report.errors, []); console.log(JSON.stringify(report)); return;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    const open = async () => { await page.goto(url + '/research.html'); await page.evaluate(() => RelatumResearchWorkspace.activate()); };
    const mode = page.locator('button[data-research-editor-mode]');
    const chooseMode = async (value) => {
      await mode.click(); await page.locator(`[data-research-mode-option="${value}"]`).click();
    };
    const snapshot = async () => {
      await sleep(500); const payload = await (await fetch(url + '/api/research/workspace')).json(); return payload.document;
    };
    const tool = async (key, value) => {
      await page.locator('[data-research-add]').click();
      await page.locator(`[data-research-decoration-tool="${key}"][data-value="${value}"]`).click();
    };
    const draw = async (x, y, endX, endY) => {
      await page.keyboard.down('Alt'); await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt');
    };
    const toolbarFits = async () => assert(await page.locator('[data-research-compute-dock]').evaluate((dock) => {
      const a = dock.querySelector('[data-research-dock-collapse]').getBoundingClientRect();
      const b = document.querySelector('[data-research-corner-actions]').getBoundingClientRect();
      return a.right <= b.left || a.bottom <= b.top || b.bottom <= a.top;
    }), 'toolbar collapse must remain clear of corner actions');
    await open(); await page.locator('[data-node-id="old-note"]').waitFor();
    await page.locator('[data-research-run]').click();
    assert(await page.locator('[data-research-run]').evaluate((e) => e.classList.contains('is-active')));
    await chooseMode('orthogonal');
    assert.equal(await page.locator('[data-research-run]').evaluate((e) => e.classList.contains('is-active')), false);
    const oldConnection = await page.locator('[data-research-viewport]').getAttribute('data-research-connection-kind');
    for (const selector of ['connection-kind="relation"', 'connection-kind="wire"', 'run', 'pause', 'step', 'reset'])
      await page.locator(`button[data-research-${selector}]`).evaluate((e) => e.click());
    await page.locator('[data-research-speed]').evaluate((e) => { e.value = '4'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.locator('[data-research-default-tools]').isVisible(), false);
    assert.equal(await page.locator('[data-research-orthogonal-tools]').isVisible(), true);
    assert.equal(await page.locator('[data-research-quick-symbol]').count(), 9);
    await toolbarFits();
    await page.locator('[data-research-quick-line-style="dashed"]').click();
    assert.equal(await page.locator('[data-research-quick-line-style="dashed"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-research-decoration-tool="lineStyle"][data-value="dashed"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-research-quick-line-style="solid"]').click();
    await page.locator('[data-research-quick-symbol="capacitor"]').click();
    assert.equal(await page.locator('[data-research-decoration-tool="symbol"][data-value="capacitor"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-research-quick-symbol="rectangle"]').click();
    assert.equal(await page.locator('[data-research-speed]').inputValue(), '1');
    assert.equal(await page.locator('[data-research-viewport]').getAttribute('data-research-connection-kind'), oldConnection);
    await draw(420, 300, 625, 300);
    let document = await snapshot(); let decorations = document.pages[0].decorations;
    assert.equal(decorations.length, 1); assert.equal(decorations[0].units, 5);
    assert.equal(decorations[0].x, 420); assert.equal(decorations[0].y, 300);
    await tool('color', 'red'); await tool('lineStyle', 'dashed'); await tool('arrowhead', 'end');
    await draw(461, 302, 542, 301);
    decorations = (await snapshot()).pages[0].decorations;
    assert.equal(decorations.length, 3);
    assert.deepEqual(decorations.filter((d) => d.color === 'mono').map((d) => [d.x, d.units]), [[420, 1], [540, 2]]);
    const red = decorations.find((d) => d.color === 'red'); assert.equal(red.x, 460); assert.equal(red.units, 2);
    assert.equal(red.lineStyle, 'dashed'); assert.equal(red.arrowhead, 'end');
    await page.keyboard.press('Control+z'); assert.equal((await snapshot()).pages[0].decorations.length, 1);
    await page.keyboard.press('Control+Shift+z'); assert.equal((await snapshot()).pages[0].decorations.length, 3);
    await tool('symbol', 'lamp'); await page.mouse.dblclick(541, 302);
    decorations = (await snapshot()).pages[0].decorations;
    let lamp = decorations.find((d) => d.type === 'lamp'); assert(lamp); assert.equal(lamp.x, 540); assert.equal(lamp.y, 300);
    await page.locator('[data-research-decoration-label]').fill('L1'); await page.locator('[data-research-decoration-label]').press('Enter');
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'lamp').label, 'L1');
    // A symbol moves independently and the line geometry stays fixed.
    await page.mouse.move(540, 300); await page.mouse.down(); await page.mouse.move(540, 370, { steps: 4 }); await page.mouse.up();
    decorations = (await snapshot()).pages[0].decorations;
    assert.equal(decorations.find((d) => d.type === 'lamp').y, 370);
    assert.equal(decorations.find((d) => d.id === red.id).y, 300);
    // Selected line endpoint stretch and cancellation preserve one history step.
    await page.mouse.click(580, 300); await page.mouse.move(620, 300); await page.mouse.down();
    await page.mouse.move(700, 300, { steps: 4 }); await page.mouse.up();
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.x === 540 && d.kind === 'line').units, 4);
    await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(740, 300);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.x === 540 && d.kind === 'line').units, 4);
    // Default objects cannot be dragged or edited in orthogonal mode.
    await page.mouse.move(950, 160); await page.mouse.down(); await page.mouse.move(1000, 200); await page.mouse.up();
    assert.deepEqual((await snapshot()).pages[0].nodes, fixture.pages[0].nodes);
    await page.locator('[data-research-settings-open]').click();
    await page.locator('[data-research-unit-length]').evaluate((e) => { e.value = '80'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('[data-research-line-width]').evaluate((e) => { e.value = '4'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.mouse.click(800, 400);
    await draw(420, 480, 581, 641);
    decorations = (await snapshot()).pages[0].decorations;
    const diagonal = decorations.find((d) => d.kind === 'line' && d.y === 480);
    assert.equal(diagonal.direction, 1); assert.equal(diagonal.units, 2); assert.equal(diagonal.unitLength, 80); assert.equal(diagonal.width, 4);
    assert.equal(decorations.find((d) => d.id === red.id).unitLength, 40);
    await draw(421, 302, 461, 301);
    const restyled = (await snapshot()).pages[0].decorations.find((d) => d.kind === 'line' && d.x === 420 && d.y === 300);
    assert.equal(restyled.units, 1); assert.equal(restyled.unitLength, 40);
    assert.equal(restyled.width, 4); assert.equal(restyled.color, 'red');
    // Cancelling a live move on mode switch must not auto-save its preview.
    await page.mouse.move(540, 370); await page.mouse.down(); await page.mouse.move(600, 420);
    await mode.evaluate((e) => e.click());
    await page.locator('[data-research-mode-option="default"]').click();
    await page.mouse.up();
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'lamp').y, 370);
    assert.equal(await page.locator('[data-research-run]').evaluate((e) => e.classList.contains('is-active')), false);
    // Default mode hits ignore decorative symbols.
    await page.mouse.click(540, 370); assert.equal(await page.locator('[data-research-decoration-label]').isVisible(), false);
    await chooseMode('orthogonal'); await page.mouse.click(540, 370); await page.keyboard.press('Control+d');
    assert.equal((await snapshot()).pages[0].decorations.filter((d) => d.type === 'lamp').length, 2);
    // Delete affects only current-mode objects, then undo restores them.
    await page.locator('[data-research-viewport]').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
    assert.equal((await snapshot()).pages[0].decorations.length, 0);
    assert.equal((await snapshot()).pages[0].nodes.length, 1);
    await page.keyboard.press('Control+z');
    const persisted = (await snapshot()).pages[0].decorations;
    await page.screenshot({ path: path.join(root, 'light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('[data-research-zoom-indicator]').click(); await sleep(100);
    await page.screenshot({ path: path.join(root, 'dark.png') });
    await page.setViewportSize({ width: 720, height: 600 });
    await page.screenshot({ path: path.join(root, 'narrow.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload(); await page.evaluate(() => RelatumResearchWorkspace.activate());
    assert.equal(await mode.getAttribute('data-value'), 'orthogonal');
    assert.deepEqual((await snapshot()).pages[0].decorations, persisted);
    assert.equal(await page.locator('[data-research-unit-length]').inputValue(), '80');
    assert.equal(await page.locator('[data-research-minimap]').isVisible(), true);
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'data/research-workspace/workspace.json'), 'utf8'));
    assert.deepEqual(stored.pages[0].decorations, persisted);
    // Language must roundtrip even for controls created while English is active.
    await page.evaluate(() => RelatumResearchWorkspace.setLanguage('en'));
    await page.waitForFunction(() => document.querySelector('[data-research-quick-symbol="voltage-source"]').textContent === 'Voltage source');
    assert(await page.locator('.research-compute-row').evaluate((row) =>
      [...row.querySelectorAll('[data-research-orthogonal-tools] button')].every((button) => button.scrollWidth <= button.clientWidth)),
    'English toolbar names must retain their complete width');
    await page.screenshot({ path: path.join(root, 'toolbar-english.png') });
    await toolbarFits();
    await page.locator('[data-research-add]').click();
    assert.equal(await page.locator('[data-research-decoration-tool="symbol"][data-value="lamp"]').getAttribute('aria-label'), 'Lamp');
    assert.equal(await page.locator('[data-research-decoration-tool="symbol"][data-value="switch"]').getAttribute('aria-label'), 'Switch');
    await page.mouse.click(540, 370);
    assert.equal(await page.locator('[data-research-inspector-title]').textContent(), 'Research · Decorative symbol');
    await page.evaluate(() => RelatumResearchWorkspace.setLanguage('zh-CN'));
    await page.waitForFunction(() => document.querySelector('[data-research-inspector-title]').textContent === '研究 · 装饰符号');
    await page.locator('[data-research-add]').click();
    assert.equal(await page.locator('[data-research-decoration-tool="symbol"][data-value="lamp"]').getAttribute('aria-label'), '灯泡');
    // Current mode persists through page changes; decoration-only pages are not empty.
    await page.locator('[data-research-page-hotspot]').hover();
    await page.locator('[data-research-page-add]').click();
    await toolbarFits();
    await draw(420, 200, 500, 200);
    assert.equal(await page.locator('[data-research-page-delete]').isVisible(), false);
    let pages = (await snapshot()).pages;
    assert.equal(pages.length, 2); assert.equal(pages[0].decorations.length, persisted.length); assert.equal(pages[1].decorations.length, 1);
    // Restore the first page for visual verification.
    await page.locator('[data-research-page-hotspot]').hover();
    await page.locator('[data-research-page-id]').nth(0).click();
    assert.equal(await mode.getAttribute('data-value'), 'orthogonal');
    assert.equal((await snapshot()).activePageId, 'research-page-1');
    // SVG library, transparent mode entry and accessible keyboard menu.
    await page.locator('[data-research-add]').click();
    assert.equal(await page.locator('[data-research-decoration-tool="symbol"] svg').count(), 15);
    assert.equal(await page.locator('[title]').count(), 0, 'Research must not create hover text tooltips');
    const hoverTile = page.locator('[data-research-decoration-tool="symbol"][data-value="voltage-source"]');
    const inkBefore = await hoverTile.evaluate((e) => getComputedStyle(e).color);
    await hoverTile.hover();
    assert.equal(await hoverTile.evaluate((e) => getComputedStyle(e).color), inkBefore, 'hover must preserve the SVG ink color');
    assert.equal(await hoverTile.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('[data-research-add-list] .research-decoration-help').count(), 0);
    assert.equal(await page.locator('.research-compute-separator').count(), 0);
    const modeStyles = await mode.evaluate((e) => { e.blur(); const s = getComputedStyle(e); return { border: s.borderTopWidth, background: s.backgroundColor }; });
    assert.equal(modeStyles.border, '0px');
    assert.equal(await page.locator('[data-research-mode-menu]').evaluate((e) => getComputedStyle(e).transitionDuration), '0s');
    await mode.focus(); await page.keyboard.press('ArrowUp');
    assert.equal(await mode.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await mode.getAttribute('aria-expanded'), 'false');
    assert(await mode.evaluate((e) => e === document.activeElement));
    await mode.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await mode.getAttribute('data-value'), 'default');
    assert.equal(await page.locator('[data-research-default-tools]').isVisible(), true);
    assert.equal(await page.locator('[data-research-orthogonal-tools]').isVisible(), false);
    assert.equal(await page.locator('[data-research-compute-dock]').evaluate((e) => e.getBoundingClientRect().height), 44);
    await chooseMode('orthogonal');
    // Endpoint slider is a display preference, never document data/history.
    const beforeEndpoint = (await snapshot()).pages[0].decorations;
    await page.locator('[data-research-settings-open]').click();
    await page.locator('[data-research-endpoint-size]').evaluate((e) => { e.value = '5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('[data-research-endpoint-size-value]').textContent(), '5px');
    assert(await page.locator('[data-research-endpoint-size]').evaluate((e) => e.closest('label').classList.contains('research-settings-slider')));
    await page.screenshot({ path: path.join(root, 'updated-settings.png') });
    assert.deepEqual((await snapshot()).pages[0].decorations, beforeEndpoint);
    await page.mouse.click(800, 400);
    await tool('symbol', 'dot'); await page.mouse.dblclick(860, 420);
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'dot').width, 8);
    await tool('symbol', 'capacitor'); await page.mouse.dblclick(900, 480);
    const inspector = page.locator('[data-research-inspector]');
    const edit = async (key, value) => { const input = inspector.locator(`[data-symbol-field="${key}"]`); await input.fill(String(value)); await input.press('Tab'); };
    await edit('rotationDegrees', 37.5); await edit('label', 'C<&1');
    await edit('labelOffsetX', -50); await edit('labelOffsetY', 80); await edit('labelFontSize', 18);
    // Keyboard offsets repaint before blur, stay out of saves, and commit once.
    const imageBeforeOffset = await page.locator('[data-research-decorations]').evaluate((e) => e.toDataURL());
    const offset = inspector.locator('[data-symbol-field="labelOffsetX"]');
    await offset.fill('-70');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.notEqual(await page.locator('[data-research-decorations]').evaluate((e) => e.toDataURL()), imageBeforeOffset);
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'capacitor').labelOffsetX, -50);
    await offset.press('Escape');
    assert.equal(await inspector.locator('[data-symbol-field="labelOffsetX"]').inputValue(), '-50');
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'capacitor').labelOffsetX, -50, 'Escape must not commit the cancelled preview through blur');
    await inspector.locator('[data-symbol-field="labelOffsetX"]').fill('-70');
    await inspector.locator('[data-symbol-field="labelOffsetX"]').fill('-90');
    await inspector.locator('[data-symbol-field="labelOffsetX"]').press('Tab');
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'capacitor').labelOffsetX, -90);
    await page.locator('[data-research-viewport]').focus(); await page.keyboard.press('Control+z');
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.type === 'capacitor').labelOffsetX, -50, 'all typed digits must form one history entry');
    await page.keyboard.press('Control+Shift+z'); await edit('labelOffsetX', -50);
    await inspector.locator('[data-symbol-field="color"]').selectOption('custom');
    await inspector.locator('[data-symbol-color="color"]').evaluate((e) => { e.value = '#123456'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await inspector.locator('[data-symbol-field="labelColor"]').selectOption('red');
    let capacitor = (await snapshot()).pages[0].decorations.find((d) => d.type === 'capacitor');
    assert.equal(capacitor.rotationDegrees, 37.5); assert.equal(capacitor.labelOffsetY, 80); assert.equal(capacitor.color, '#123456');
    await page.screenshot({ path: path.join(root, 'updated-inspector.png') });
    await page.locator('[data-research-viewport]').focus(); await page.keyboard.press('Control+z');
    assert.equal((await snapshot()).pages[0].decorations.find((d) => d.id === capacitor.id).labelColor, 'inherit');
    await page.keyboard.press('Control+Shift+z');
    // Color preview cancellation restores both document and history.
    const beforePreview = (await snapshot()).pages[0].decorations;
    await inspector.locator('[data-symbol-color="color"]').evaluate((e) => { e.value = '#abcdef'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.deepEqual((await snapshot()).pages[0].decorations, beforePreview, 'live colors must not leak into auto-save');
    await inspector.locator('[data-symbol-color="color"]').dispatchEvent('blur');
    assert.deepEqual((await snapshot()).pages[0].decorations, beforePreview);
    // Save the instance as a local preset; its SVG keeps the actual angle and label.
    // Clicking Save immediately after typing must commit once and retain the click.
    await inspector.locator('[data-symbol-field="label"]').fill('C<&2');
    await page.locator('[data-research-save-preset]').click();
    const dialog = page.locator('[data-research-preset-dialog]');
    await dialog.locator('[data-research-preset-name]').fill('My capacitor');
    assert((await dialog.locator('[data-research-preset-preview]').innerHTML()).includes('rotate(37.5)'));
    assert.equal(await dialog.locator('svg text').textContent(), 'C<&2');
    await dialog.locator('[data-symbol-field="labelOffsetX"]').fill('-75');
    assert.equal(await dialog.locator('svg text').getAttribute('x'), '-75', 'preset SVG offset must preview without blur');
    await dialog.locator('[data-symbol-field="labelOffsetX"]').fill('-50'); await dialog.locator('[data-symbol-field="labelOffsetX"]').press('Tab');
    assert(await dialog.locator('[data-research-preset-save]').evaluate((e) => {
      const b = e.getBoundingClientRect(); return b.bottom < innerHeight && b.top > 0; }), 'preset actions must stay visible without scrolling');
    await page.screenshot({ path: path.join(root, 'preset-dialog.png') });
    await dialog.locator('[data-research-preset-save]').click();
    const presetTile = page.locator('[data-research-decoration-preset]');
    assert.equal(await presetTile.count(), 1); assert.equal(await presetTile.getAttribute('aria-pressed'), 'true');
    await page.mouse.dblclick(900, 600);
    let copies = (await snapshot()).pages[0].decorations.filter((d) => d.type === 'capacitor'); assert.equal(copies.length, 2);
    assert.equal(copies[1].rotationDegrees, 37.5); assert.equal(copies[1].labelOffsetX, -50); assert.notEqual(copies[0].id, copies[1].id);
    // Preview templates may be edited without changing existing instances.
    await page.locator('[data-research-add]').click(); await presetTile.click({ button: 'right' });
    await page.locator('.research-preset-menu').getByRole('menuitem', { name: '编辑预设' }).click();
    await dialog.locator('[data-symbol-field="width"]').fill('64'); await dialog.locator('[data-symbol-field="width"]').press('Tab');
    await dialog.locator('[data-symbol-field="color"]').selectOption('blue');
    await dialog.locator('[data-research-preset-save]').click();
    assert.deepEqual((await snapshot()).pages[0].decorations.filter((d) => d.type === 'capacitor'), copies);
    await page.reload(); await page.evaluate(() => RelatumResearchWorkspace.activate());
    await page.locator('[data-research-add]').click(); assert.equal(await presetTile.count(), 1);
    assert.equal(await page.locator('[data-research-endpoint-size]').inputValue(), '5');
    const savedPresets = await page.evaluate(() => JSON.parse(localStorage.getItem('research:decorationPresets:v1')));
    assert.equal(savedPresets.presets[0].template.width, 64);
    await page.evaluate(() => RelatumResearchWorkspace.suspend());
    await page.emulateMedia({ colorScheme: 'light' }); await page.evaluate(() => RelatumResearchWorkspace.activate());
    assert.equal(await presetTile.locator('svg g').getAttribute('stroke'), '#4279b0', 'preset SVGs must refresh after a suspended theme change');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.querySelector('[data-research-decoration-preset] svg g').getAttribute('stroke') === '#87b6e8');
    // Reset drawing preferences keeps the user's preset library.
    await page.locator('[data-research-settings-open]').click();
    await page.locator('[data-research-settings-reset-open]').click(); await page.locator('[data-research-settings-reset-accept]').click();
    assert.equal(await page.locator('[data-research-endpoint-size]').inputValue(), '4'); assert.equal(await presetTile.count(), 1);
    await page.mouse.click(800, 400);
    // Local-storage failure retains the draft and original library.
    await page.locator('[data-research-preset-add]').click(); await dialog.locator('[data-research-preset-name]').fill('Unsaved');
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) {
      if (key === 'research:decorationPresets:v1') throw new DOMException('quota', 'QuotaExceededError'); return window.originalSetItem.call(this, key, value); }; });
    await dialog.locator('[data-research-preset-save]').click();
    assert(await dialog.locator('[role="alert"]').isVisible()); assert.equal(await dialog.locator('[data-research-preset-name]').inputValue(), 'Unsaved');
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem; });
    await dialog.locator('footer button[type="button"]').click();
    await presetTile.focus(); await page.keyboard.press('Shift+F10');
    await page.locator('.research-preset-menu').getByRole('menuitem', { name: '删除预设' }).click();
    assert.equal(await presetTile.count(), 0);
    assert.deepEqual((await snapshot()).pages[0].decorations.filter((d) => d.type === 'capacitor'), copies);
    await page.screenshot({ path: path.join(root, 'updated-library.png') });
    await mode.click(); await page.screenshot({ path: path.join(root, 'mode-menu.png') }); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 720, height: 600 });
    await mode.click(); await page.screenshot({ path: path.join(root, 'updated-narrow.png') });
    assert(await page.locator('[data-research-mode-menu]').evaluate((e) => {
      const b = e.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-research-mode-menu]') === e;
    }), 'the narrow-window menu must paint above the side panel');
    await page.keyboard.press('Escape');
    assert(await page.locator('.research-compute-row').evaluate((row) => row.scrollWidth > row.clientWidth),
      'a narrow orthogonal toolbar must scroll rather than truncate names');
    await page.locator('[data-research-quick-symbol="ground"]').scrollIntoViewIfNeeded();
    assert(await page.locator('[data-research-quick-symbol="ground"]').evaluate((e) => {
      const b = e.getBoundingClientRect(), r = e.closest('.research-compute-row').getBoundingClientRect();
      return b.left >= r.left && b.right <= r.right && e.scrollWidth <= e.clientWidth;
    }), 'the last tool must scroll fully into view');
    await page.locator('.research-compute-row').evaluate((row) => { row.scrollLeft = 0; });
    await toolbarFits();
    await page.setViewportSize({ width: 480, height: 600 }); await toolbarFits();
    await page.setViewportSize({ width: 720, height: 600 });
    const menuFits = await page.locator('[data-research-mode-menu]').evaluate((e) => {
      const rect = e.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; });
    assert(menuFits); await page.setViewportSize({ width: 1280, height: 800 });
    // A DPR2 fixture covers all symbols, clipping, box/Shift selection and many objects.
    const visualContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const visual = await visualContext.newPage();
    visual.on('pageerror', (error) => errors.push(error.message));
    await visual.addInitScript(() => localStorage.setItem('research:editorMode:v1', 'orthogonal'));
    const visualFixture = structuredClone(fixture);
    visualFixture.pages[0].decorations = [{ id: 'through', kind: 'line', x: 420, y: 260, direction: 0, units: 8,
      unitLength: 40, width: 2, color: 'mono', lineStyle: 'solid', arrowhead: 'none' }];
    ['rectangle', 'current-source', 'voltage-source', 'lamp', 'dot'].forEach((type, i) => {
      visualFixture.pages[0].decorations.push({ id: type, kind: 'symbol', type, x: 500 + i * 48, y: 260,
        width: type === 'dot' ? 12 : 32, height: type === 'rectangle' ? 14 : type === 'dot' ? 12 : 32, rotation: 0, label: type === 'rectangle' ? 'R1' : '', labelOffsetY: 26 });
    });
    for (let i = 0; i < 1500; i++) visualFixture.pages[0].decorations.push({ id: 'far-' + i, kind: 'line',
      x: (i % 50) * 80, y: 1000 + Math.floor(i / 50) * 80, direction: i % 8, units: 1,
      unitLength: 40, width: 2, color: 'green', lineStyle: 'solid', arrowhead: 'none' });
    const componentTypes = ['capacitor', 'inductor', 'switch', 'ground', 'ac-voltage-source', 'diode', 'op-amp', 'transformer', 'controlled-voltage-source', 'controlled-current-source'];
    componentTypes.forEach((type, i) => {
      visualFixture.pages[0].decorations.push({ id: 'new-' + type, kind: 'symbol', type, x: 450 + i % 5 * 64, y: 380 + Math.floor(i / 5) * 100,
        width: 32, height: 32, rotation: 0, rotationDegrees: i === 0 ? 22.5 : 0, color: i === 0 ? '#b8524d' : 'mono', label: '', labelOffsetX: 0, labelOffsetY: 0 });
    });
    visualFixture.pages[0].decorations.push({ id: 'through-capacitor', kind: 'line', x: 410, y: 380, direction: 0, units: 8,
      unitLength: 40, width: 2, color: 'mono', lineStyle: 'solid', arrowhead: 'none' });
    await require('./research-circuit-browser.js').installFixtureRoute(visual, visualFixture);
    await visual.goto(url + '/research.html'); await visual.evaluate(() => RelatumResearchWorkspace.activate());
    await sleep(120);
    const alpha = await visual.locator('[data-research-decorations]').evaluate((e) => {
      const ctx = e.getContext('2d'); return [ctx.getImageData(1000, 520, 1, 1).data[3], ctx.getImageData(960, 520, 1, 1).data[3]];
    });
    assert.equal(alpha[0], 0, 'symbol clipping must preserve the transparent canvas/grid background');
    assert(alpha[1] > 0, 'the uncovered line/endpoint must remain visible');
    const capacitorAlpha = await visual.locator('[data-research-decorations]').evaluate((e) => e.getContext('2d').getImageData(900, 760, 1, 1).data[3]);
    assert.equal(capacitorAlpha, 0, 'an open rotated capacitor must erase the wire and its unit endpoint between plates');
    assert.equal(await visual.locator('[data-research-decorations]').count(), 1);
    assert.equal(await visual.locator('[data-research-surface] > *').count(), 1, 'unit endpoints must not create DOM');
    assert((await visual.locator('[data-research-mode-menu]').evaluate((e) => getComputedStyle(e).transitionDuration)).includes('0.14s'));
    await visual.mouse.move(475, 230); await visual.mouse.down(); await visual.mouse.move(720, 290, { steps: 4 }); await visual.mouse.up();
    assert((await visual.locator('[data-research-selection-copy]').textContent()).includes('6'));
    await visual.keyboard.down('Shift'); await visual.mouse.click(500, 260); await visual.keyboard.up('Shift');
    assert((await visual.locator('[data-research-selection-copy]').textContent()).includes('5'));
    const started = Date.now();
    await visual.keyboard.down('Space'); await visual.mouse.move(800, 400); await visual.mouse.down();
    await visual.mouse.move(820, 420, { steps: 8 }); await visual.mouse.up(); await visual.keyboard.up('Space');
    assert(Date.now() - started < 5000, 'large decoration fixture must remain interactive');
    const scaleBefore = await visual.locator('[data-research-zoom-indicator]').textContent();
    await visual.mouse.wheel(0, -200);
    await visual.waitForFunction((before) => document.querySelector('[data-research-zoom-indicator]').textContent !== before, scaleBefore);
    assert.equal(await visual.locator('[data-research-surface] > *').count(), 1, 'zoom must not materialize decorative endpoints as DOM');
    await visual.screenshot({ path: path.join(root, 'symbols-dpr2.png') });
    await visual.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' }); await sleep(120);
    await visual.screenshot({ path: path.join(root, 'symbols-dark-dpr2.png') });
    await visual.emulateMedia({ reducedMotion: 'no-preference' });
    const animatedDock = await visual.evaluate(async () => {
      const dock = document.querySelector('[data-research-compute-dock]'), mode = document.querySelector('button[data-research-editor-mode]');
      const start = dock.getBoundingClientRect().width;
      document.querySelector('[data-research-mode-option="default"]').click();
      const immediateMode = mode.dataset.value;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const middle = dock.getBoundingClientRect().width, moving = dock.getAnimations().some((a) => a.playState === 'running');
      document.querySelector('[data-research-mode-option="orthogonal"]').click();
      await Promise.all(dock.getAnimations().map((a) => a.finished));
      return { start, middle, moving, immediateMode, end: dock.getBoundingClientRect().width, mode: mode.dataset.value };
    });
    assert.equal(animatedDock.immediateMode, 'default'); assert(animatedDock.moving);
    assert(animatedDock.middle < animatedDock.start && animatedDock.middle > 760, 'mode resize must pass through an intermediate width: ' + JSON.stringify(animatedDock));
    assert.equal(animatedDock.mode, 'orthogonal'); assert.equal(animatedDock.end, animatedDock.start, 'rapid reversal must finish at the new natural width');
    await visual.emulateMedia({ reducedMotion: 'reduce' });
    await visual.locator('[data-research-mode-option="default"]').evaluate((e) => e.click());
    assert.equal(await visual.locator('[data-research-compute-dock]').evaluate((e) => e.getAnimations().length), 0);
    await visualContext.close();
    assert.deepEqual(errors, []);
    // Run the established interaction suites against their own routed fixtures.
    const circuit = await require('./research-circuit-browser.js').runAcceptance(require(process.env.RELATUM_PLAYWRIGHT || 'playwright'), url,
      { edgePath: process.env.RELATUM_EDGE_PATH });
    assert.deepEqual(circuit.errors, []);
    console.log(JSON.stringify({ ok: true, root, objects: persisted.length, errors, existingCircuitRegression: true }));
  } finally {
    if (browser) await browser.close(); server.kill();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });

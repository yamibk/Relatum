'use strict';
// Production shell, disposable notes, and bounded synthetic directory fixtures.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-file-colors-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const data = path.join(output, 'isolated'), notes = path.join(data, 'notes');
  fs.mkdirSync(path.join(notes, 'Folder'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'Main.md'), '# File colors\n\nOriginal text.\n');
  fs.writeFileSync(path.join(notes, 'Folder/A.md'), 'Child note\n');
  fs.mkdirSync(path.join(notes, 'CustomNotebook/Other'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'CustomNotebook/Other/Hidden.md'), 'Unopened notebook\n');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify(profile)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, page, releaseQueuedWrite = () => {};
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  try {
    const url = 'http://127.0.0.1:' + port; let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, renderTree, setNoteSettingsOpen, performMove, stopExternalSync, stopDocumentPrefetch, cancelStatistics, get colors(){return fileColorHost?.instance}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
      localStorage.setItem('canvas:noteActivePath:v1', 'Main.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.editor && !T.state.openingPath);
    const left = '[data-role="note-tree"]', menu = page.locator('[data-role="note-context-menu"]');
    const row = value => page.locator(left + ' .note-tree-row[data-note-path="' + value + '"]');
    const enabled = value => page.evaluate(value => RelatumNoteExtensions.set('file-colors', { enabled: value }), value);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const colorRequests = () => requests.filter(url => url.includes('/api/note-file-colors/')).length;
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').enabled), false);
    assert(!requests.some(url => /file-colors/.test(url)));
    assert(!fs.existsSync(path.join(data, 'data/note-file-colors.sqlite3')));
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    const dialog = page.locator('[data-role="note-settings-dialog"]');
    const menuToggle = dialog.locator('[data-file-color-menu]');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), null, 'opening settings never writes defaults');
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await menuToggle.evaluate(button => button.closest('label')), null, 'menu button is outside the extension checkbox label');
    await menuToggle.click();
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').enabled), false);
    await page.evaluate(() => {
      window.menuStorageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'canvas:noteExtensions:v1') throw new DOMException('Fixture storage failure', 'QuotaExceededError');
        return window.menuStorageSet.call(this, key, value);
      };
    });
    await menuToggle.click();
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'true', 'failed preference save preserves the old button state');
    assert((await dialog.locator('[data-extension-id="file-colors"] .note-extension-status').innerText()).includes('设置保存失败'));
    await page.evaluate(() => { Storage.prototype.setItem = window.menuStorageSet; delete window.menuStorageSet; });
    await menuToggle.focus(); await page.keyboard.press('Space');
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(colorRequests(), 0, 'disabled extension menu preference never queries or writes colors');
    await dialog.locator('[data-extension-configure="file-colors"]').click();
    assert((await dialog.locator('.note-file-colors-guide').innerText()).includes('子项不会继承'));
    assert.equal(await dialog.locator('[data-file-color-option]').count(), 4);
    assert.deepEqual(await dialog.locator('[data-file-color-option]').evaluateAll(items => items.map(item => item.value)), ['100', '100', '100', '100']);
    assert.deepEqual(await page.evaluate(() => RelatumNoteExtensions.list().find(item => item.id === 'file-colors').normalizeOptions({
      backgroundStrength: Infinity, hoverStrength: -10, selectedStrength: 333, iconSaturation: '200' })),
      { backgroundStrength: 100, hoverStrength: 0, selectedStrength: 300, iconSaturation: 100, showContextMenu: true });
    assert.deepEqual(await page.evaluate(() => [false, 'false', null].map(showContextMenu =>
      RelatumNoteExtensions.list().find(item => item.id === 'file-colors').normalizeOptions({ showContextMenu }).showContextMenu)), [false, true, true]);
    await dialog.locator('[data-settings-search]').fill('图标饱和度');
    await dialog.locator('.relatum-settings-result').first().click();
    assert.equal(await dialog.locator('[data-file-color-option="iconSaturation"]').evaluate(input => input === document.activeElement), true);
    await dialog.locator('[data-settings-search]').fill('');
    assert(!requests.some(url => /note-extensions\/file-colors\.js/.test(url)), 'settings stay metadata-only');
    await dialog.locator('[data-extension-enabled="file-colors"]:visible').check();
    await page.waitForFunction(() => T.colors);
    await dialog.locator('[data-settings-action="close"]').click();
    await row('Main.md').waitFor();
    await page.evaluate(() => { window.originalRow = document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]'); window.originalEditor = T.editor.view; });
    await row('Main.md').click({ button: 'right' });
    const first = menu.locator('.note-notebook-colors button').first(); await first.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.locator('button:focus').getAttribute('data-color'), 'blue', 'palette uses existing keyboard navigation');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await page.waitForFunction(() => document.querySelector('[data-note-path="Main.md"]').dataset.fileColor === 'blue');
    await page.waitForTimeout(150);
    assert(fs.existsSync(path.join(data, 'data/note-file-colors.sqlite3')));
    assert(await page.evaluate(() => window.originalRow === document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]') && window.originalEditor === T.editor.view));
    const appearance = () => row('Main.md').evaluate(element => ({ bg: getComputedStyle(element).backgroundColor,
      icon: getComputedStyle(element.querySelector('.note-tree-icon')).color, name: getComputedStyle(element.querySelector('.note-tree-label')).color,
      text: getComputedStyle(element).color }));
    let style = await appearance(); assert.equal(style.icon, 'rgb(94, 136, 189)'); assert.equal(style.name, style.text); assert.notEqual(style.bg, 'rgba(0, 0, 0, 0)');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    await page.evaluate(() => { window.menuIdentity = { colors: T.colors, row: document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]'),
      view: T.editor.view, doc: T.editor.view.state.doc }; });
    const beforeMenu = colorRequests();
    await menuToggle.click();
    assert.equal(await dialog.locator('[data-extension-enabled="file-colors"]:visible').isChecked(), true);
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await menuToggle.locator('.note-file-color-menu-slash').evaluate(element => getComputedStyle(element).display), 'block');
    assert.equal(colorRequests(), beforeMenu);
    assert(await page.evaluate(() => menuIdentity.colors === T.colors && menuIdentity.row === document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]')
      && menuIdentity.view === T.editor.view && menuIdentity.doc === T.editor.view.state.doc));
    assert.deepEqual(await appearance(), style, 'hiding menu colors leaves the existing appearance intact');
    await page.screenshot({ path: path.join(output, 'menu-hidden-light.png') });
    await dialog.locator('[data-settings-action="close"]').click();
    for (const value of ['Main.md', 'Folder']) {
      await row(value).click({ button: 'right' });
      assert.equal(await menu.locator('.note-notebook-colors').count(), 0);
      assert.equal(await menu.getByRole('button', { name: '清除颜色', exact: true }).count(), 0);
      assert.equal(await menu.evaluate(element => element.firstElementChild.tagName), 'BUTTON', 'no leading color separator remains');
      assert(await menu.getByRole('button', { name: '重命名', exact: true }).isVisible());
      await page.keyboard.press('Escape');
    }
    await enabled(false); await enabled(true);
    await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options.showContextMenu), false);
    await page.reload();
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.colors?.get('Main.md') === 'blue');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'true', 'hidden menu preference survives reload');
    await page.setViewportSize({ width: 600, height: 760 });
    await page.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = 'dark'; });
    assert.equal(await menuToggle.getAttribute('data-ui-tooltip'), 'Show context menu colors');
    assert.equal(await menuToggle.getAttribute('aria-label'), 'Hide context menu colors');
    assert.equal(await dialog.locator('.note-extension-overview').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: path.join(output, 'menu-hidden-dark-narrow-en.png') });
    await page.evaluate(() => { RelatumI18n.setLanguage('zh-CN'); document.body.dataset.startTheme = 'light'; });
    await page.setViewportSize({ width: 1440, height: 980 });
    await dialog.locator('[data-extension-configure="file-colors"]').click();
    const option = key => dialog.locator('[data-file-color-option="' + key + '"]');
    const beforeOptions = colorRequests();
    await page.evaluate(() => {
      window.appearanceIdentity = { colors: T.colors, row: document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]'),
        view: T.editor.view, doc: T.editor.view.state.doc };
      window.optionWrites = 0; const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'canvas:noteExtensions:v1') window.optionWrites++; return original.call(this, key, value); };
    });
    const bounds = await option('backgroundStrength').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 3, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 2 / 3, bounds.y + bounds.height / 2, { steps: 16 });
    const backgroundStrength = Number(await option('backgroundStrength').inputValue());
    assert(backgroundStrength >= 190 && backgroundStrength <= 210);
    assert.equal(await page.evaluate(() => window.optionWrites), 0, 'native dragging previews without storage writes');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options.backgroundStrength), 100);
    assert.equal(await page.locator(left).evaluate(element => Number(element.style.getPropertyValue('--file-color-background-light'))), .09 * backgroundStrength / 100);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.optionWrites), 1, 'release persists once');
    for (const key of ['hoverStrength', 'selectedStrength', 'iconSaturation']) { await option(key).focus(); await page.keyboard.press('End'); }
    assert.deepEqual(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options),
      { backgroundStrength, hoverStrength: 300, selectedStrength: 300, iconSaturation: 200, showContextMenu: false });
    assert.equal(await row('Main.md').locator('.note-tree-icon').evaluate(element => getComputedStyle(element).filter), 'none');
    assert.notEqual((await appearance()).icon, 'rgb(94, 136, 189)', 'saturation increases icon color without a CSS filter');
    assert.equal(colorRequests(), beforeOptions, 'appearance changes do not query or write color records');
    assert(await page.evaluate(() => appearanceIdentity.colors === T.colors && appearanceIdentity.row === document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]')
      && appearanceIdentity.view === T.editor.view && appearanceIdentity.doc === T.editor.view.state.doc));
    const committed = await page.locator(left).evaluate(element => element.style.getPropertyValue('--file-color-background-light'));
    await option('backgroundStrength').evaluate(input => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator(left).evaluate(element => element.style.getPropertyValue('--file-color-background-light')), committed, 'blur cancels an unfinished preview');
    await page.screenshot({ path: path.join(output, 'appearance-controls.png') });
    await page.reload();
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.colors?.get('Main.md') === 'blue');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options.backgroundStrength), backgroundStrength, 'appearance persists across reload');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    await dialog.locator('[data-extension-configure="file-colors"]').click();
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await option('iconSaturation').getAttribute('aria-label'), 'Icon saturation');
    await page.setViewportSize({ width: 600, height: 760 });
    await option('iconSaturation').scrollIntoViewIfNeeded();
    assert.equal(await dialog.locator('.note-file-colors-settings').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: path.join(output, 'appearance-narrow-en.png') });
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await dialog.locator('[data-file-color-reset]').click();
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options.showContextMenu), false, 'resetting appearance keeps the menu preference');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').enabled), true);
    assert.equal(await page.evaluate(() => T.colors.get('Main.md')), 'blue', 'resetting appearance preserves file colors');
    assert.deepEqual(await dialog.locator('[data-file-color-option]').evaluateAll(items => items.map(item => item.value)), ['100', '100', '100', '100']);
    await dialog.locator('[data-extension-action="back"]').click();
    const beforeRestoreMenu = colorRequests();
    await menuToggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await menuToggle.locator('.note-file-color-menu-slash').evaluate(element => getComputedStyle(element).display), 'none');
    assert.equal(colorRequests(), beforeRestoreMenu);
    await dialog.locator('[data-settings-action="close"]').click();
    await page.screenshot({ path: path.join(output, 'light.png') });
    await page.evaluate(() => document.body.dataset.startTheme = 'dark'); await settle();
    style = await appearance(); assert.equal(style.icon, 'rgb(94, 136, 189)'); assert.equal(style.name, style.text);
    await page.screenshot({ path: path.join(output, 'dark.png') });
    await enabled(false); await page.waitForFunction(() => !T.colors);
    assert.equal(await page.locator(left).getAttribute('data-file-colors-enabled'), null);
    const disabledRequests = requests.filter(url => url.includes('/api/note-file-colors/')).length;
    await page.evaluate(() => T.renderTree()); await pause(100);
    assert.equal(requests.filter(url => url.includes('/api/note-file-colors/')).length, disabledRequests);
    await enabled(true); await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await row('Folder').click({ button: 'right' }); await menu.locator('[data-color="green"]').click();
    await row('Folder').click(); await row('Folder/A.md').waitFor();
    assert.equal(await row('Folder/A.md').getAttribute('data-file-color'), null, 'folder colors do not inherit');
    await page.waitForTimeout(100);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => !T.colors);
    const pausedQueries = requests.filter(url => url.includes('/api/note-file-colors/query')).length;
    await pause(100);
    assert.equal(requests.filter(url => url.includes('/api/note-file-colors/query')).length, pausedQueries);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await page.route('**/api/note-file-colors/set', route => route.fulfill({ status: 503, json: { error: 'Fixture save failure' } }));
    await page.evaluate(() => T.colors.set('Main.md', 'red'));
    assert.equal(await row('Main.md').getAttribute('data-file-color'), 'blue', 'failed save restores the confirmed color');
    await page.unroute('**/api/note-file-colors/set');
    await page.waitForFunction(async () => (await (await fetch('/api/note-index-state')).json()).phase === 'ready');
    assert.equal(await page.evaluate(() => T.performMove('Main.md', 'Renamed.md', false)), true,
      await page.evaluate(() => T.state.lastMoveError + ' [' + T.state.lastMoveCode + ']'));
    await page.waitForFunction(() => T.colors?.get('Renamed.md') === 'blue');
    await row('Renamed.md').click({ button: 'right' }); await menu.getByRole('button', { name: '清除颜色', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-tree"] [data-note-path="Renamed.md"]').dataset.fileColor === undefined);
    await page.evaluate(() => T.colors.set('Renamed.md', 'blue'));
    await page.evaluate(async () => {
      await fetch('/api/note-file-colors/set', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'CustomNotebook/Other/Hidden.md', color: 'purple' }) });
    });
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    await dialog.locator('[data-extension-configure="file-colors"]').click();
    const clearButton = dialog.locator('[data-file-color-clear]');
    const confirmation = dialog.locator('.relatum-settings-confirm[data-confirm-action="file-colors-clear"]');
    const clearRequests = () => requests.filter(url => url.includes('/api/note-file-colors/clear')).length;
    const beforeClear = clearRequests();
    await clearButton.click(); await confirmation.waitFor({ state: 'visible' });
    assert((await confirmation.innerText()).includes('滑条参数保留'));
    await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'hidden' });
    assert.equal(clearRequests(), beforeClear, 'cancel sends no clear request');
    assert.equal(await page.evaluate(() => T.colors.get('Renamed.md')), 'blue');
    await page.route('**/api/note-file-colors/clear', route => route.fulfill({ status: 503, json: { error: 'Fixture clear failure' } }));
    await clearButton.click(); await confirmation.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => document.querySelector('[data-file-color-clear-status]').textContent.includes('Fixture clear failure'));
    assert.equal(await page.evaluate(() => T.colors.get('Renamed.md')), 'blue', 'failed clear preserves color display');
    await page.unroute('**/api/note-file-colors/clear');
    const beforeClearOptions = await page.evaluate(() => RelatumNoteExtensions.read('file-colors'));
    await clearButton.click();
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await confirmation.locator('h3').textContent(), 'Clear all file color data?');
    await page.keyboard.press('Tab');
    assert.equal(await confirmation.locator('[data-settings-action="accept-reset"]').evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await confirmation.locator('[data-settings-action="cancel-reset"]').evaluate(button => button === document.activeElement), true);
    await confirmation.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => document.querySelector('[data-file-color-clear-status]').textContent.includes('All file colors cleared'));
    assert.equal(clearRequests(), beforeClear + 2);
    assert.equal(await page.locator(left + ' [data-file-color]').count(), 0);
    assert.deepEqual(await page.evaluate(() => RelatumNoteExtensions.read('file-colors')), beforeClearOptions);
    const hiddenColors = await page.evaluate(async () => (await (await fetch('/api/note-file-colors/query', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['Renamed.md', 'CustomNotebook/Other/Hidden.md'] }) })).json()).colors);
    assert.deepEqual(hiddenColors, {}, 'all notebooks are cleared, including unloaded rows');
    assert.equal(fs.readFileSync(path.join(notes, 'CustomNotebook/Other/Hidden.md'), 'utf8'), 'Unopened notebook\n');
    const queuedWriteGate = new Promise(resolve => { releaseQueuedWrite = resolve; });
    await page.route('**/api/note-file-colors/set', async route => { await queuedWriteGate; await route.continue(); });
    const queuedWrite = page.waitForRequest(request => request.url().endsWith('/api/note-file-colors/set'));
    await page.evaluate(() => { T.colors.set('Renamed.md', 'red'); RelatumNoteExtensions.set('file-colors', { enabled: false }); });
    await queuedWrite;
    const beforeQueuedClear = clearRequests();
    await clearButton.click(); await confirmation.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => document.querySelector('[data-file-color-clear]').disabled);
    assert.equal(clearRequests(), beforeQueuedClear, 'clear waits behind a save from the disabled controller');
    releaseQueuedWrite();
    await page.waitForFunction(() => !document.querySelector('[data-file-color-clear]').disabled
      && document.querySelector('[data-file-color-clear-status]').textContent.includes('All file colors cleared'));
    await page.unroute('**/api/note-file-colors/set');
    await enabled(true); await page.waitForFunction(() => T.colors);
    const afterQueuedClear = await page.evaluate(async () => (await (await fetch('/api/note-file-colors/query', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['Renamed.md'] }) })).json()).colors);
    assert.deepEqual(afterQueuedClear, {}, 'an old save cannot restore cleared colors after re-enabling');
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await dialog.locator('[data-settings-action="close"]').click();
    const report = [];
    const measure = () => page.evaluate(() => {
      const rounds = [];
      for (let i = 0; i < 5; i++) { const start = performance.now(); T.renderTree({ entryIndexReady: true }); rounds.push(performance.now() - start); }
      return rounds.sort((a, b) => a - b)[2];
    });
    await page.evaluate(() => { T.stopExternalSync(); T.stopDocumentPrefetch(); T.cancelStatistics(); });
    await page.route('**/api/note-file-colors/query', async route => {
      const { paths } = route.request().postDataJSON(); assert(paths.length <= 512);
      await route.fulfill({ json: { generation: 100, colors: Object.fromEntries(paths.filter(value => value.startsWith('Perf-')).map(value => [value, 'blue'])) } });
    });
    for (const count of [1000, 10000]) {
      await page.evaluate(count => {
        T.state.entries = Array.from({ length: count }, (_, i) => ({ kind: 'note', name: 'Perf-' + String(i).padStart(5, '0'),
          path: 'Perf-' + String(i).padStart(5, '0') + '.md', modifiedNs: 1, createdNs: 1, size: 1 }));
        T.state.treePagination = { '': { offset: count, total: count, hasMore: false, generation: 0 } };
        T.colors.invalidate(); T.renderTree();
      }, count);
      await page.waitForFunction(count => T.colors?.get('Perf-' + String(count - 1).padStart(5, '0') + '.md') === 'blue', count);
      await pause(100);
      const enabledRenderMs = await measure();
      const queryCount = requests.filter(url => url.includes('/api/note-file-colors/query')).length;
      const result = await page.evaluate(async count => {
        const host = document.querySelector('[data-role="note-tree"]'), scroller = document.querySelector('[data-role="note-sidebar-scroll"]');
        const firstRow = host.querySelector('.note-tree-row');
        const start = performance.now(); T.colors.decorate(firstRow, firstRow.dataset.notePath); const paintMs = performance.now() - start;
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { count, paintMs, domRows: host.querySelectorAll('.note-tree-row').length, colored: !!host.querySelector('[data-file-color="blue"]') };
      }, count);
      assert(result.domRows < 200 && result.colored, 'large trees remain windowed and decorated');
      await pause(100);
      assert.equal(requests.filter(url => url.includes('/api/note-file-colors/query')).length, queryCount, 'scrolling never queries per row');
      await enabled(false); const disabledRenderMs = await measure();
      await enabled(true);
      await page.waitForFunction(count => T.colors?.get('Perf-' + String(count - 1).padStart(5, '0') + '.md') === 'blue', count);
      report.push({ ...result, enabledRenderMs, disabledRenderMs });
    }
    await page.waitForTimeout(500);
    const rafs = await page.evaluate(async () => {
      const original = window.requestAnimationFrame; let calls = 0;
      window.requestAnimationFrame = callback => { calls++; return original(callback); };
      await new Promise(resolve => setTimeout(resolve, 250)); window.requestAnimationFrame = original; return calls;
    });
    assert.equal(rafs, 0, 'idle extension has no RAF loop');
    await page.evaluate(() => RelatumNoteExtensions.reset());
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').options.showContextMenu), true, 'extension reset restores the default menu');
    assert.equal(await page.locator(left).getAttribute('data-file-colors-enabled'), null);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, performance: report, idleRafs: rafs }, null, 2));
    console.log('PASS file colors; artifacts: ' + output + '; ' + JSON.stringify(report));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Artifacts: ' + output + '\n' + logs); throw error;
  } finally {
    releaseQueuedWrite();
    await browser?.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

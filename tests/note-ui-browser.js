'use strict';
// Production Notes UI with isolated Markdown, preferences and Edge profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(browser, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-ui-')), notes = path.join(root, 'notes');
  for (const dir of ['notes/Folder', 'notes/CustomNotebook/Study', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(notes, 'N' + String(i).padStart(3, '0') + '.md'), '# Record ' + i + '\nsharedtoken result ' + i + '\n#tag\n');
  fs.writeFileSync(path.join(notes, 'Main.md'), '# Main\nsharedtoken selected body\n');
  fs.writeFileSync(path.join(notes, 'Folder/A.md'), 'sharedtoken folder');
  fs.writeFileSync(path.join(notes, 'CustomNotebook/Study/B.md'), 'sharedtoken book');
  fs.writeFileSync(path.join(root, 'data/note-notebooks.json'), JSON.stringify({ version: 1, colors: {}, ui: { open: true, mode: 'notebooks', selectedRoot: '', expanded: [] } }));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const profile = mode === 'full' ? [] : ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'))).features.map(f => [f.id, ['notes', 'notes.graph'].includes(f.id) || mode === 'notes-only' && f.id === 'notes.canvas'])) })];
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port), ...profile],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const url = 'http://127.0.0.1:' + port;
  let context;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch {} await sleep(100); }
    context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: 'no-preference', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(), errors = [], queries = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/note-query')) queries.push(request.postDataJSON()); });
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, setViewMode, refreshTree, stopExternalSync, stopDocumentPrefetch, get browser(){return noteBrowser;}, get folders(){return browserFolders();}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {')
      .replace('getNotebooks: () => notebookRoots().map', 'getNotebooks: () => window.__fakeBooks || notebookRoots().map');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:tooltipHoverDelay', '0');
      localStorage.setItem('canvas:noteFocusMode:v1', '0');
      window.__frames = 0; const original = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { window.__frames++; return original(callback); };
    });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.active && !T.state.openingPath);
    let indexed = false;
    for (let i = 0; i < 200; i++) { indexed = (await (await fetch(url + '/api/note-index-state')).json()).phase === 'ready'; if (indexed) break; await sleep(50); }
    assert(indexed, 'fixture index is ready');
    // Commit the final directory snapshot before measuring explicit search requests.
    // External polling has separate coverage; it may legitimately invalidate a query.
    await page.evaluate(async () => { await T.refreshTree(false); T.stopExternalSync(); T.stopDocumentPrefetch(); });
    const query = page.locator('[data-note-search="query"]'), scope = page.locator('[data-note-search="scope"]'), sort = page.locator('[data-note-search="sort"]');
    const menu = page.locator('[data-role="note-context-menu"]'), after = page.locator('[data-note-search="after"]'), before = page.locator('[data-note-search="before"]');
    const calendarButton = page.locator('.note-search-date-toggle').first();
    const calendar = page.locator('.note-search-calendar').first();
    const busy = () => page.waitForFunction(() => document.querySelector('.note-browser-results')?.getAttribute('aria-busy') === 'false');
    const search = async text => {
      const response = page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.q === text);
      await query.fill(text); await query.press('Enter'); await response; await busy();
    };
    const rightAt = async locator => { const box = await locator.boundingBox(); await page.mouse.click(box.x + 12, box.y + box.height / 2, { button: 'right' }); };
    await page.keyboard.press('Control+Shift+F'); await search('sharedtoken');
    await page.locator('.note-browser-result').first().evaluate(node => { window.__firstRow = node; window.__firstTitle = node.firstElementChild; });
    await search('sharedtoken ');
    assert(await page.locator('.note-browser-result').first().evaluate(node => node === window.__firstRow && node.firstElementChild === window.__firstTitle), 'equivalent results reuse row contents');
    const repeated = queries.length; await query.press('Enter'); await sleep(250); assert.equal(queries.length, repeated, 'same committed search is not requested twice');
    let changedCursor = false;
    const changeCursor = async route => {
      if (!changedCursor && route.request().postDataJSON()?.offset === 50) {
        changedCursor = true; await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Index changed', code: 'query_changed' }) });
      } else await route.continue();
    };
    await page.route('**/api/note-query', changeCursor);
    await page.locator('.note-browser-more').click(); await busy();
    await page.unroute('**/api/note-query', changeCursor);
    assert(changedCursor); assert.equal(await page.locator('.note-browser-result').count(), 100, 'a changed cursor reloads the requested page as well as committed pages');
    assert(await page.locator('.note-browser-result').first().evaluate(node => node === window.__firstRow), 'pagination preserves existing rows');
    let releasePage, pageStarted;
    const heldPage = new Promise(resolve => { releasePage = resolve; }), startedPage = new Promise(resolve => { pageStarted = resolve; });
    const holdPage = async route => {
      if (route.request().postDataJSON()?.offset === 100) { pageStarted(); await heldPage; }
      await route.continue();
    };
    await page.route('**/api/note-query', holdPage); await page.locator('.note-browser-more').click(); await startedPage;
    const duringMore = queries.length;
    await page.evaluate(() => { T.browser.invalidate(); T.browser.invalidate(); }); await sleep(60);
    assert.equal(queries.length, duringMore, 'invalidation waits for active pagination'); releasePage(); await busy();
    await page.unroute('**/api/note-query', holdPage);
    assert.equal(await page.locator('.note-browser-result').count(), 150, 'queued refresh preserves appended pages');
    for (let i = 0; i < 2; i++) { await page.locator('.note-browser-more').click(); await busy(); }
    assert(await page.locator('.note-browser-result').count() < 90, '250 results retain viewport-sized DOM');
    await page.locator('.note-browser-result').first().evaluate(node => { window.__windowedRow = node; });
    await page.evaluate(() => T.browser.setLanguage());
    assert(await page.locator('.note-browser-result').first().evaluate(node => node === window.__windowedRow), 'metadata/language refresh retains unchanged windowed rows');
    await page.locator('.note-browser-result').first().focus();
    const focusedPath = await page.evaluate(() => document.activeElement.dataset.noteBrowserPath);
    await page.evaluate(() => {
      window.__refreshSizes = [];
      window.__refreshObserver = new MutationObserver(() => window.__refreshSizes.push(Number(document.querySelector('.note-browser-result')?.getAttribute('aria-setsize'))));
      window.__refreshObserver.observe(document.querySelector('.note-browser-list'), { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-setsize'] });
    });
    const refreshed = page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.offset === 200);
    await page.evaluate(() => T.browser.invalidate()); await refreshed; await busy();
    assert(await page.evaluate(() => { window.__refreshObserver.disconnect(); return window.__refreshSizes.every(size => size === 250); }), 'multi-page refresh commits once without shrinking the list');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.noteBrowserPath), focusedPath, 'focus survives normal/windowed threshold crossings');
    await scope.click(); const scopeMenu = page.locator('#' + await scope.getAttribute('aria-controls'));
    await scopeMenu.locator('[role="option"]').first().evaluate(node => { window.__scopeOption = node; });
    await scope.press('Escape'); await scopeMenu.waitFor({ state: 'hidden' });
    await page.evaluate(() => T.browser.setLanguage()); await scope.click();
    assert(await scopeMenu.locator('[role="option"]').first().evaluate(node => node === window.__scopeOption), 'unchanged options are retained');
    await scope.press('Escape'); await scopeMenu.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const snapshot = T.folders;
      window.__fakeBooks = Array.from({ length: 1000 }, (_, i) => ({ path: 'CustomNotebook/Book-' + i, name: 'Book ' + i }));
      T.browser.setLanguage(); window.__sameFolders = snapshot === T.folders;
    });
    assert(await page.evaluate(() => window.__sameFolders), 'unchanged directory reuses candidate snapshot');
    await scope.click(); assert(await scopeMenu.locator('[role="option"]').count() < 50, '1000 notebooks use bounded candidate DOM');
    await scope.press('End'); assert.equal(await scopeMenu.locator('[aria-selected="true"]').textContent(), 'Book 999');
    const backgroundRefresh = page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.offset === 200);
    await page.evaluate(() => T.browser.invalidate()); await backgroundRefresh; await busy();
    assert.equal(await scopeMenu.locator('[aria-selected="true"]').textContent(), 'Book 999', 'background refresh preserves the active keyboard candidate');
    await scope.press('Escape'); await scopeMenu.waitFor({ state: 'hidden' }); assert.equal(await scopeMenu.locator('[role="option"]').count(), 0, 'close releases large candidate DOM');
    await page.evaluate(() => { window.__fakeBooks = null; T.browser.setLanguage(); }); await scope.click();
    await sort.click(); assert.equal(await scopeMenu.isHidden(), true, 'only one popup is open');
    await sort.press('ArrowDown'); await sort.press('Enter'); await busy();
    assert.equal(await sort.getAttribute('aria-expanded'), 'false');
    await page.locator('.note-search-filter-button').click();
    if (process.env.RELATUM_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true }); await sleep(200);
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-ui-' + mode + '-search-light.png') });
    }
    await calendarButton.click(); assert.equal(await calendarButton.getAttribute('aria-expanded'), 'true');
    await calendarButton.click(); assert.equal(await calendarButton.getAttribute('aria-expanded'), 'false'); await calendar.waitFor({ state: 'hidden' });
    await calendarButton.click(); await calendarButton.click(); await calendarButton.click(); await sleep(250);
    assert.equal(await calendarButton.getAttribute('aria-expanded'), 'true', 'old close does not hide a reopened calendar');
    await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' }); assert(await after.evaluate(node => document.activeElement === node));
    const preserved = await page.locator('.note-browser-results-head').textContent(), invalidRequests = queries.length;
    await after.fill('2023-02-29'); await page.evaluate(() => T.browser.invalidate()); await sleep(250);
    assert.equal(queries.length, invalidRequests, 'invalid date does not query');
    assert.equal(await page.locator('.note-browser-more').isDisabled(), true, 'invalid filters cannot paginate the previous query');
    assert.equal(await after.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('.note-browser-results-head').textContent(), preserved);
    await after.fill('2024-02-28'); await sleep(250); await busy();
    await calendarButton.click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await busy();
    assert.equal(await after.inputValue(), '2024-02-29', 'keyboard selects leap day');
    await before.fill('2024-02-29'); await sleep(250); await busy();
    assert.equal(queries.at(-1).modified.before - queries.at(-1).modified.after, 86400 * 1e9, 'through includes the whole selected local day');
    const validRequests = queries.length; await before.fill('2024-02-28'); await sleep(250);
    assert.equal(queries.length, validRequests); assert.equal(await before.getAttribute('aria-invalid'), 'true');
    await before.fill(''); await sleep(250); await busy();
    await calendarButton.click(); await calendar.locator('.note-search-calendar-title').click();
    await calendar.locator('.note-search-calendar-year').fill('2025'); await calendar.locator('[data-month="0"]').click();
    await page.keyboard.press('Enter'); await busy(); assert.equal(await after.inputValue(), '2025-01-01', 'year/month shortcut keeps canonical value');
    await calendarButton.click(); await calendar.locator('[data-calendar-action="today"]').click(); await busy();
    assert.equal(await after.inputValue(), await page.evaluate(() => { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }));
    await calendarButton.click(); await calendar.locator('[data-calendar-action="clear"]').click(); await busy(); assert.equal(await after.inputValue(), '');
    await calendarButton.click(); await page.locator('[data-note-action="toggle-sort"]').click(); assert.equal(await calendar.isHidden(), true);
    await scope.click(); assert.equal(await page.locator('[data-role="note-sort-menu"]').isHidden(), true);
    await query.click(); await scopeMenu.waitFor({ state: 'hidden' });
    await page.evaluate(() => RelatumI18n.setLanguage('en')); await calendarButton.click();
    assert.equal(await calendar.locator('[data-calendar-action="today"]').textContent(), 'Today');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; }); await page.setViewportSize({ width: 700, height: 680 });
    await calendarButton.click(); await calendar.waitFor();
    await sleep(180);
    const bounds = await calendar.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 700 && bounds.y + bounds.height <= 680, 'calendar fits narrow viewport');
    if (process.env.RELATUM_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-ui-' + mode + '-calendar-dark.png') });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await calendarButton.click(); assert.equal(await calendar.isHidden(), true);
    await calendarButton.click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    assert.equal(await calendar.isHidden(), true);
    await after.dispatchEvent('compositionend'); assert.equal(await calendar.isHidden(), true, 'late input cannot revive a minimized popup');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await page.setViewportSize({ width: 1440, height: 950 }); await page.emulateMedia({ reducedMotion: 'no-preference' });
    const pendingText = 'sharedtoken hidden-pending';
    await query.fill(pendingText); await page.evaluate(() => T.browser.showDocument()); await sleep(250);
    assert(!queries.some(item => item.q === pendingText), 'leaving cancels a queued search');
    const returned = page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.q === pendingText);
    await page.locator('.note-browser-back').click(); await returned; await busy();
    await page.evaluate(() => T.openNote('Main.md'));
    const folder = page.locator('[data-role="note-tree"] .note-tree-row[data-note-path="Folder"]');
    await rightAt(folder); await menu.waitFor(); await rightAt(menu); assert(await menu.evaluate(node => node.inert)); await menu.waitFor({ state: 'hidden' });
    await rightAt(folder); await menu.waitFor();
    await rightAt(page.locator('[data-role="note-tree"] .note-tree-row[data-note-path="Main.md"]'));
    await menu.waitFor({ state: 'hidden' }); assert.equal(await page.locator('.note-notebook-colors').count(), 0, 'second right click dismisses rather than switching');
    await page.locator('.cm-content').press('Shift+F10'); await menu.waitFor(); await page.keyboard.press('ArrowRight');
    const submenu = page.locator('.note-context-submenu'); await submenu.waitFor(); await rightAt(submenu); await menu.waitFor({ state: 'hidden' });
    const notebook = page.locator('[data-role="note-notebook-tree"] > .note-notebook-root > .note-tree-row[data-note-path="CustomNotebook/Study"]');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await rightAt(notebook); await menu.waitFor();
      for (const swatch of await page.locator('.note-notebook-colors button').all()) {
        const color = await swatch.evaluate(node => getComputedStyle(node).backgroundColor);
        await swatch.hover(); await sleep(120); assert.equal(await swatch.evaluate(node => getComputedStyle(node).backgroundColor), color, 'hover retains swatch color');
        assert.equal(await page.locator('#relatum-ui-tooltip').getAttribute('aria-hidden'), 'true', 'palette suppresses underlying row tooltip');
        await swatch.focus(); assert.equal(await swatch.evaluate(node => getComputedStyle(node).backgroundColor), color, 'focus retains swatch color');
        await page.mouse.down(); assert.equal(await swatch.evaluate(node => getComputedStyle(node).backgroundColor), color, 'press retains swatch color');
        const box = await menu.boundingBox(); await page.mouse.move(box.x - 4, box.y - 4); await page.mouse.up();
        assert.equal(await swatch.getAttribute('title'), null); assert.equal(await swatch.getAttribute('data-ui-tooltip'), null);
      }
      if (process.env.RELATUM_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'note-ui-' + mode + '-palette-' + theme + '.png') });
      await rightAt(menu); await menu.waitFor({ state: 'hidden' });
    }
    await rightAt(notebook); await menu.waitFor(); await page.locator('[data-note-action="toggle-library-settings"]').click(); assert.equal(await menu.isHidden(), true);
    await notebook.hover(); await sleep(120); assert.equal(await page.locator('#relatum-ui-tooltip').getAttribute('aria-hidden'), 'false', 'normal row tooltips resume after palette closes');
    await page.locator('[data-note-action="toggle-settings"]').click(); assert.equal(await page.locator('[data-role="note-library-settings"]').isHidden(), true);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert.equal(await page.locator('[data-role="note-settings-pop"]').isHidden(), true);
    await sleep(350); const idle = await page.evaluate(() => window.__frames); await sleep(1000);
    assert.equal(await page.evaluate(() => window.__frames), idle, 'idle controls have no ongoing RAF');
    await rightAt(folder); await menu.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await menu.isHidden(), true, 'pagehide commits close immediately');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, status: 'note UI: ok', queries: queries.length, resultRowsReused: true, swatches: 8, idleFrames: 0 }));
  } finally {
    if (context) await context.close(); service.kill();
    await new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('relatum-note-ui-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ['full', 'notes-only', 'notes-no-canvas']) await run(browser, mode); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

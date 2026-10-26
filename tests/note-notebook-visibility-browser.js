'use strict';
// Real UI and persistence; only disposable notebooks and a fresh browser profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notebook-visibility-'));
const physics = 'CustomNotebook/Physics', empty = 'CustomNotebook/Empty', note = physics + '/P.md';
const settingsFile = path.join(data, 'data/note-notebooks.json'), artifacts = process.env.RELATUM_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notebook-visibility-artifacts-'));
fs.mkdirSync(path.join(data, 'notes', physics), { recursive: true });
fs.mkdirSync(path.join(data, 'notes', empty), { recursive: true });
fs.writeFileSync(path.join(data, 'notes', note), '# Physics\nhiddennotebooktoken\n');
fs.writeFileSync(path.join(data, 'notes/Root.md'), '# Root\n[[CustomNotebook/Physics/P]]\n');
const settings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: 'ignore' });
  let browser, page;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch {} await delay(100); }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, setViewMode, refreshTree, setNoteSettingsOpen, setSideOpen, selectNotebook, flushNotebookSettings, stopExternalSync, stopDocumentPrefetch, toggleAllNotebooks, movePath, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0'); });
    const dialog = page.locator('#note-settings-dialog');
    const notebook = value => page.locator('[data-role="note-notebook-tree"] > .note-notebook-root > .note-tree-row').and(page.locator(`[data-note-path="${value}"]`));
    const checkbox = value => dialog.locator(`.note-notebook-setting[data-notebook-path="${value}"] input`);
    const ready = async () => {
      await page.waitForFunction(() => window.T?.state.initialized && T.state.active && !T.state.openingPath);
      await page.evaluate(() => { T.setSideOpen(true); T.stopExternalSync(); T.stopDocumentPrefetch(); });
    };
    const openSettings = async () => { await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'notebooks' })); await dialog.waitFor(); };
    const closeSettings = async () => { await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' }); };
    const change = async (value, checked) => { if (await checkbox(value).isChecked() !== checked) await checkbox(value).click(); await page.waitForFunction(() => !document.querySelector('.note-notebook-settings-list input:disabled')); };
    const reset = async all => { await dialog.locator(`[data-settings-action="reset-${all ? 'all' : 'category'}"]`).click(); await dialog.locator('[data-settings-action="accept-reset"]').click(); await page.waitForFunction(() => !Object.keys(T.state.notebookVisible).length); };
    await fetch(url + '/api/notes-tree?notebookSettings=1');
    assert.equal(fs.existsSync(settingsFile), false, 'reading old/default preferences never creates a settings file');
    await page.goto(url); await ready();
    await page.evaluate(path => T.openNote(path), note);
    await notebook(physics).press('ArrowRight');
    await notebook(physics).click({ button: 'right' });
    const menu = page.locator('[data-role="note-context-menu"]');
    await menu.getByRole('button', { name: '红色', exact: true }).click();
    await page.evaluate(() => T.flushNotebookSettings());
    await page.evaluate(() => {
      T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\nunsaved visibility draft' } });
      clearTimeout(T.state.saveTimer);
      window.savedView = T.editor.view; window.savedDocument = T.state.current;
      window.savedText = T.editor.view.state.doc.toString(); window.savedLeft = document.querySelector('[data-role="note-tree"] .note-tree-row');
      window.savedExpanded = [...T.state.notebookExpanded]; window.savedTabs = JSON.stringify(T.state.tabs);
    });
    await notebook(physics).click({ button: 'right' });
    const actions = await menu.locator(':scope > button').allTextContents();
    assert(actions.indexOf('隐藏笔记本') > actions.indexOf('在资源管理器中打开'));
    assert(actions.indexOf('隐藏笔记本') < actions.indexOf('移到系统回收站'));
    await menu.getByRole('button', { name: '隐藏笔记本', exact: true }).click();
    await page.waitForFunction(path => T.state.notebookVisible[path] === false, physics);
    assert.equal(await notebook(physics).count(), 0);
    assert(await page.evaluate(path => T.state.notebookRoot === path && T.editor.view === savedView && T.state.current === savedDocument
      && T.editor.view.state.doc.toString() === savedText && JSON.stringify(T.state.tabs) === savedTabs
      && document.querySelector('[data-role="note-tree"] .note-tree-row') === savedLeft
      && JSON.stringify([...T.state.notebookExpanded]) === JSON.stringify(savedExpanded), physics), 'hiding preserves editor, unsaved content, tabs, folder DOM and expansion');
    assert(!fs.readFileSync(path.join(data, 'notes', note), 'utf8').includes('unsaved visibility draft'));
    await page.evaluate(() => T.refreshTree(false)); await page.evaluate(() => T.flushNotebookSettings());
    assert.equal(settings().colors[physics], 'red'); assert.equal(settings().visible[physics], false);
    await page.evaluate(() => { T.toggleAllNotebooks(); T.toggleAllNotebooks(); });
    assert(await page.evaluate(path => T.state.notebookExpanded.has(path), physics), 'expand/collapse visible notebooks preserves hidden expansion');
    // Existing search and link behavior must retain hidden notebooks.
    await page.keyboard.press('Control+Shift+F');
    const query = page.locator('[data-note-search="query"]'); await query.fill('hiddennotebooktoken'); await query.press('Enter');
    await page.locator('.note-browser-results [data-note-browser-path="' + note + '"]').waitFor();
    await page.locator('.note-browser-results [data-note-browser-path="' + note + '"]').click();
    await page.waitForFunction(path => T.state.current?.path === path && !T.state.openingPath, note);
    assert.equal(await notebook(physics).count(), 0);
    await page.evaluate(async () => { await T.openNote('Root.md'); await T.setViewMode('reading'); });
    await page.locator('.note-reading-view a').filter({ hasText: 'P' }).click();
    await page.waitForFunction(path => T.state.current?.path === path && !T.state.openingPath, note);
    assert.equal(await notebook(physics).count(), 0, 'following a link does not unhide the notebook');
    await openSettings();
    const categories = await dialog.locator('nav button').evaluateAll(items => items.map(item => item.dataset.settingsCategory));
    assert.equal(categories.at(-2), 'system'); assert.equal(categories.at(-1), 'notebooks');
    assert.deepEqual(await dialog.locator('.note-notebook-setting').evaluateAll(items => items.map(item => item.dataset.notebookPath)), ['', empty, physics]);
    assert.equal(await checkbox(physics).isChecked(), false);
    await checkbox(physics).focus(); await page.keyboard.press('Space');
    await page.waitForFunction(path => T.state.notebookVisible[path] !== false, physics);
    assert.equal(await checkbox(physics).evaluate(input => document.activeElement === input), true, 'keyboard toggles retain checkbox focus after saving');
    await change(physics, false);
    await checkbox(empty).focus(); await page.evaluate(() => { window.savedSetting = document.activeElement; return T.refreshTree(false); });
    assert(await page.evaluate(() => document.activeElement === savedSetting), 'refresh reuses the focused checkbox');
    await change('', false); await change(empty, false); await closeSettings();
    await page.locator('.note-notebooks-empty button').click();
    assert.equal(await dialog.locator('nav [data-settings-category="notebooks"]').getAttribute('aria-current'), 'page');
    await reset(false); assert.equal(settings().colors[physics], 'red');
    await change(physics, false); await change('', false); await closeSettings();
    await page.reload(); await ready();
    assert.equal(await notebook(physics).count(), 0); assert.equal(await notebook('').count(), 0);
    await openSettings(); assert.equal(await checkbox(physics).isChecked(), false);
    // A failed click stays rolled back, including subsequent unrelated saves.
    let rejected = 0;
    const fail = async route => {
      if (route.request().postDataJSON()?.visible) { rejected++; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"visibility write failed"}' }); }
      else await route.continue();
    };
    await page.route('**/api/note-notebooks-settings', fail);
    await change(empty, false);
    assert.equal(await checkbox(empty).isChecked(), true); assert.equal(rejected, 1);
    await page.evaluate(() => T.flushNotebookSettings()); await delay(450); assert.equal(rejected, 1, 'failed visibility is never queued for a later retry');
    await page.unroute('**/api/note-notebooks-settings', fail);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const delayed = async route => { if (route.request().postDataJSON()?.visible) await gate; await route.continue(); };
    await page.route('**/api/note-notebooks-settings', delayed);
    await checkbox(empty).uncheck(); await page.waitForFunction(() => !!document.querySelector('.note-notebook-settings-list input:disabled'));
    assert.equal(await notebook(empty).count(), 1, 'the list changes only after successful persistence');
    assert.equal(await dialog.locator('.note-notebook-setting input:not(:disabled)').count(), 0);
    release(); await page.waitForFunction(path => T.state.notebookVisible[path] === false, empty);
    await page.unroute('**/api/note-notebooks-settings', delayed);
    await reset(true); assert.deepEqual(settings().visible, {}); assert.equal(settings().colors[physics], 'red');
    // Rename a hidden root through the existing disk transaction and remap.
    await change(physics, false); await closeSettings();
    const renamed = 'CustomNotebook/Renamed';
    assert(await page.evaluate(async ({ source, target }) => { const ok = await T.movePath(source, target); await T.flushNotebookSettings(); return ok; }, { source: physics, target: renamed }));
    assert.deepEqual(settings().visible, { [renamed]: false }); assert.equal(settings().colors[renamed], 'red');
    await openSettings(); assert.equal(await checkbox(renamed).isChecked(), false); await closeSettings();
    fs.renameSync(path.join(data, 'notes', renamed), path.join(data, 'notes/CustomNotebook/External'));
    await page.evaluate(() => T.refreshTree(false));
    await page.evaluate(() => T.flushNotebookSettings());
    assert.equal(settings().visible[renamed], undefined);
    await notebook('CustomNotebook/External').waitFor();
    // Default notebook has only reveal/hide, and deleting hidden paths prunes metadata.
    await notebook('').click({ button: 'right' });
    assert.deepEqual(await menu.locator(':scope > button').allTextContents(), ['在资源管理器中打开', '隐藏笔记本']);
    await page.keyboard.press('Escape');
    await openSettings(); await change(empty, false); await closeSettings();
    fs.rmdirSync(path.join(data, 'notes', empty)); await page.evaluate(() => T.refreshTree(false)); await page.evaluate(() => T.flushNotebookSettings());
    assert.equal(settings().visible[empty], undefined);
    await openSettings();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await dialog.locator('[data-settings-search]').fill('隐藏');
    await dialog.locator('.relatum-settings-result').filter({ has: page.locator('span').filter({ hasText: /^笔记本$/ }) }).click();
    assert.equal(await dialog.locator('nav [data-settings-category="notebooks"]').getAttribute('aria-current'), 'page');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await page.screenshot({ path: path.join(artifacts, 'notebooks-' + theme + '.png') });
    }
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await dialog.locator('nav [data-settings-category="notebooks"]').textContent(), 'Notebooks');
    await page.setViewportSize({ width: 560, height: 780 });
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(artifacts, 'notebooks-narrow-en.png') });
    assert.deepEqual(errors, []);
    console.log('notebook visibility browser: passed; screenshots: ' + artifacts);
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-1800), state: window.T && { root: T.state.notebookRoot, hidden: T.state.notebookVisible } })).catch(() => ({}))); }
    throw error;
  } finally {
    if (browser) await browser.close();
    service.kill(); await new Promise(resolve => service.exitCode !== null ? resolve() : service.once('exit', resolve));
    assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir()));
    assert(path.basename(data).startsWith('relatum-notebook-visibility-'));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

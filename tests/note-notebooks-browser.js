'use strict';

// Real notebook UI/API acceptance on an isolated disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notebooks-'));
const notes = path.join(dataRoot, 'notes');
const container = path.join(notes, 'CustomNotebook');
const settingsFile = path.join(dataRoot, 'data', 'note-notebooks.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(path.join(notes, 'Legacy'), { recursive: true });
fs.mkdirSync(path.join(container, 'Physics', 'Chapter'), { recursive: true });
fs.mkdirSync(path.join(container, 'Empty'));
fs.writeFileSync(path.join(notes, 'Root.md'), 'Original note\n');
fs.writeFileSync(path.join(container, 'Physics', 'P.md'), 'Physics note\n');
fs.writeFileSync(path.join(container, 'Physics', 'Chapter', 'C.md'), 'Chapter note\n');

async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
function settings() { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(url + '/api/runtime')).ok; } catch { return false; } }, 'server did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__notebooksTest = {state, editor: liveEditor, flushNotebookSettings, triggerExternalSync};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    let treeRequests = 0, settingRequests = 0;
    page.on('request', request => {
      if (request.url().includes('/api/notes-tree')) treeRequests++;
      if (request.url().includes('/api/note-notebooks-settings')) settingRequests++;
    });
    async function enter() {
      await page.goto(url);
      await page.waitForFunction(() => window.CanvasNoteWorkspace);
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => window.__notebooksTest?.state.initialized && window.__notebooksTest.state.active);
    }
    const left = '[data-role="note-tree"]';
    const right = '[data-role="note-notebook-tree"]';
    const row = (host, value) => page.locator(`${host} .note-tree-row[data-note-path="${value}"]`);
    const rootRow = value => page.locator(`${right} > .note-notebook-root > .note-tree-row[data-note-path="${value}"]`);
    const notebookNames = () => page.locator(`${right} > .note-notebook-root > .note-tree-row .note-tree-label`).allTextContents();
    const sync = () => page.evaluate(() => __notebooksTest.triggerExternalSync({ silentErrors: true }));
    const flush = () => page.evaluate(() => __notebooksTest.flushNotebookSettings());
    async function screenshot(name) {
      if (process.env.RELATUM_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, name + '.png') });
      }
    }

    await enter();
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 0);
    assert.equal(await row(left, 'CustomNotebook').count(), 0, 'container must not appear in default notebook');
    await row(left, 'Root.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Root.md');
    await page.evaluate(() => { window.__originalDoc = __notebooksTest.editor.view.state.doc; window.__originalView = __notebooksTest.editor.view; });
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    assert.deepEqual(await notebookNames(), ['notes', 'Empty', 'Physics']);
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false');
    await rootRow('CustomNotebook/Physics').click();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics');
    assert.equal(await page.evaluate(() => __notebooksTest.editor.view === __originalView && __notebooksTest.editor.view.state.doc === __originalDoc), true, 'classification must preserve editor and document');
    assert.equal(await row(left, 'Root.md').count(), 0);
    await row(left, 'CustomNotebook/Physics/P.md').waitFor();
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'Root.md');
    assert.equal(Math.round((await page.locator('.note-links-pane').boundingBox()).width), 300);
    assert.equal(await page.locator('.note-links-pane').evaluate(el => getComputedStyle(el).position), 'relative');

    await row(left, 'CustomNotebook/Physics/Chapter').click();
    assert.equal(await row(right, 'CustomNotebook/Physics/Chapter').getAttribute('aria-expanded'), 'false', 'trees have separate expansion state');
    await row(right, 'CustomNotebook/Physics/Chapter').click();
    await row(right, 'CustomNotebook/Physics/Chapter/C.md').waitFor();
    await row(right, 'CustomNotebook/Physics/Chapter/C.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'CustomNotebook/Physics/Chapter/C.md');
    await page.locator('.cm-content').click();
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 1);
    await page.locator('[data-note-action="toggle-all-notebooks"]').click();
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'false');
    assert.equal(await row(left, 'CustomNotebook/Physics/Chapter').getAttribute('aria-expanded'), 'true');
    for (let i = 0; i < 5; i++) await rootRow('CustomNotebook/Physics').click();
    await page.waitForTimeout(400);
    assert.equal(await rootRow('CustomNotebook/Physics').getAttribute('aria-expanded'), 'true');
    await rootRow('CustomNotebook/Physics').click({ button: 'right' });
    await page.locator('.note-notebook-colors button[data-color="blue"]').click();
    await flush();
    assert.equal(settings().colors['CustomNotebook/Physics'], 'blue');
    await screenshot('notebooks-light');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; document.body.dataset.startBackground = 'scenic'; });
    await screenshot('notebooks-dark');
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.body.dataset.startBackground = 'simple'; });
    await rootRow('').click({ button: 'right' });
    assert.equal(await page.locator('[data-role="note-context-menu"]').isVisible(), false, 'default notes has no delete menu');

    await page.locator('[data-note-action="new-notebook"]').click();
    await rootRow('CustomNotebook/Untitled1').waitFor();
    assert.equal(await page.locator('.note-modal-card').count(), 0, 'creation does not ask for a name');
    await page.locator('[data-note-action="new-notebook"]').click();
    await rootRow('CustomNotebook/Untitled2').waitFor();
    await rootRow('CustomNotebook/Untitled2').click({ button: 'right' });
    await page.locator('[data-role="note-context-menu"] button').filter({ hasText: /^重命名$/ }).click();
    const notebookRename = page.locator(`${right} .note-tree-rename`);
    await notebookRename.fill('New'); await notebookRename.press('Enter');
    await rootRow('CustomNotebook/New').waitFor();
    assert(fs.statSync(path.join(container, 'New')).isDirectory());
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), 'CustomNotebook/Physics/Chapter/C.md');
    await page.locator('[data-note-action="new-folder"]').click();
    const rename = page.locator(`${left} .note-tree-rename`);
    await rename.waitFor(); await rename.fill('Folder'); await rename.press('Enter');
    await row(left, 'CustomNotebook/New/Folder').waitFor();
    await waitFor(() => fs.existsSync(path.join(container, 'New', 'Folder')), 'renamed folder not committed');
    assert(fs.statSync(path.join(container, 'New', 'Folder')).isDirectory());
    await page.locator('.note-tree-pane [data-note-action="new-note"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath.startsWith('CustomNotebook/New/Folder/'));
    await page.locator('.note-inline-title').press('Escape');
    await page.locator('.cm-content').click();
    await page.keyboard.type('Notebook saved content');
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    const createdPath = await page.evaluate(() => CanvasNoteWorkspace.currentPath);
    assert(fs.readFileSync(path.join(notes, createdPath), 'utf8').includes('Notebook saved content'));
    await rootRow('CustomNotebook/Physics').click();
    await flush();
    await page.reload();
    await page.waitForFunction(() => window.__notebooksTest?.state.initialized);
    assert.equal(await page.locator('.note-workspace.links-overlay-open').count(), 1, 'open state restores');
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/Physics', 'selected classification restores even with another notebook open');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.currentPath), createdPath);
    assert.equal(await rootRow('CustomNotebook/Physics').locator('.note-notebook-icon').getAttribute('data-color'), 'blue');
    await page.locator('[data-note-action="side-history"]').click(); await flush();
    await page.reload();
    await page.waitForFunction(() => window.__notebooksTest?.state.initialized && __notebooksTest.state.current && document.querySelector('[data-role="note-history-list"]')?.textContent.length > 0);
    assert.equal(await page.locator('[data-role="note-history-content"]').isVisible(), true, 'history mode restores with its current document');
    await page.locator('[data-note-action="side-notebooks"]').click();

    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('#note-sort-menu [data-note-sort-mode="name-asc"]').click();
    await flush(); await sync();
    const writes = settingRequests;
    await page.evaluate(() => {
      window.__treeMutations = 0;
      const observer = new MutationObserver(records => { __treeMutations += records.length; });
      for (const host of document.querySelectorAll('[data-role="note-tree"], [data-role="note-notebook-tree"]')) observer.observe(host, { childList: true, subtree: true, attributes: true });
      window.__treeObserver = observer;
    });
    for (let i = 0; i < 3; i++) await sync();
    assert.equal(await page.evaluate(() => __treeMutations), 0, 'unchanged trees must not mutate DOM');
    assert.equal(settingRequests, writes, 'unchanged checks must not write settings');
    await page.evaluate(() => __treeObserver.disconnect());
    fs.mkdirSync(path.join(container, 'Added'));
    await sync(); assert((await notebookNames()).includes('Added'));
    fs.renameSync(path.join(container, 'Physics'), path.join(container, 'Renamed'));
    await sync(); await flush();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), '');
    assert.equal(settings().colors['CustomNotebook/Physics'], undefined);
    assert.equal(await rootRow('CustomNotebook/Renamed').locator('.note-notebook-icon').getAttribute('data-color'), 'gray');

    await rootRow('CustomNotebook/New').click();
    await page.route('**/api/note-trash', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated recycle failure' }) }));
    await rootRow('CustomNotebook/New').click({ button: 'right' });
    await page.locator('[data-role="note-context-menu"] button.danger').click();
    await rootRow('CustomNotebook/New').waitFor();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), 'CustomNotebook/New');
    assert(fs.existsSync(path.join(container, 'New')), 'failed recycle preserves folder');
    await page.unroute('**/api/note-trash');
    await rootRow('CustomNotebook/New').click({ button: 'right' });
    await page.locator('.note-notebook-colors button[data-color="green"]').click(); await flush();
    await page.route('**/api/notes-tree*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated read failure' }) }));
    await sync();
    assert((await notebookNames()).includes('New'), 'read failures preserve notebook tree');
    assert.equal(settings().colors['CustomNotebook/New'], 'green', 'read failure must not prune colors');
    await page.unroute('**/api/notes-tree*');
    fs.renameSync(path.join(container, 'New'), path.join(dataRoot, 'removed-notebook'));
    await sync(); await flush();
    assert.equal(await page.evaluate(() => __notebooksTest.state.notebookRoot), '');
    assert.equal(await row(left, 'Root.md').count(), 1);
    assert.equal(await page.evaluate(() => __notebooksTest.state.tabs.some(path => path.startsWith('CustomNotebook/New/'))), false);
    assert(!fs.existsSync(path.join(container, 'New')), 'autosave cannot recreate externally removed notebook');
    assert.equal(settings().colors['CustomNotebook/New'], undefined);
    fs.renameSync(container, path.join(dataRoot, 'removed-container'));
    await sync(); await flush();
    assert.deepEqual(await notebookNames(), ['notes']);
    assert(!fs.existsSync(container), 'ordinary refresh cannot recreate container');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; document.body.dataset.startBackground = 'scenic'; });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('[data-note-action="side-notebooks"]').textContent(), 'Notebooks');
    await page.setViewportSize({ width: 680, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.note-links-pane').evaluate(el => getComputedStyle(el).position), 'absolute');
    await screenshot('notebooks-narrow');
    await page.locator('[data-note-action="side-links"]').click();
    assert.equal(await page.locator('[data-role="note-links-content"]').isVisible(), true);
    await page.locator('[data-note-action="side-notebooks"]').click();
    await page.locator('[data-note-action="close-links"]').click();
    await flush(); assert.equal(settings().ui.open, false);
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.locator('button[data-start-workspace="canvas"]').click();
    const inactiveRequests = treeRequests;
    await delay(2300); assert.equal(treeRequests, inactiveRequests, 'inactive workspace must stop directory checks');
    assert.equal(settings().ui.open, true, 'workspace switch preserves panel state');
    assert.deepEqual(errors, []);
    console.log('note notebooks browser: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(dataRoot).startsWith('relatum-notebooks-'));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

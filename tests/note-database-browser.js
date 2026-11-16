'use strict';

// Production Notes workspace and HTTP service. Recycle is redirected to the disposable vault.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { features } = require('../assets/feature-catalog.json');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-database-'));
const notes = path.join(root, 'notes');
const marker = '```database\n```';
const databaseFile = note => path.join(notes, note + '.assets', '.relatum-database', 'database.sqlite3');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(notes);
fs.mkdirSync(path.join(root, 'recycled'));
for (const name of ['Main', 'Drop', 'Other']) fs.writeFileSync(path.join(notes, name + '.md'), name + ' body\n');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function until(fn) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  assert.fail('Timed out waiting for database integration');
}

(async () => {
  const native = process.argv.includes('--webview2');
  const notesOnly = process.argv.includes('--notes-only');
  const port = await freePort(), debug = native ? await freePort() : 0;
  const origin = 'http://127.0.0.1:' + port;
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const code = 'import os, sys, uuid, app; from pathlib import Path; '
    + 'root = Path(os.environ["RELATUM_DATA_ROOT"]); '
    + 'app._move_paths_to_recycle_bin = lambda paths: [p.rename(root / "recycled" / (uuid.uuid4().hex + "-" + p.name)) for p in paths]; '
    + (native ? 'import desktop; sys.argv[0] = "desktop.py"; sys.exit(desktop.main())' : 'sys.argv[0] = "app.py"; sys.exit(app.main())');
  const args = ['-B', '-c', code];
  if (!native) args.push('--port', String(port), '--no-browser');
  if (notesOnly) args.push('--launch-profile', JSON.stringify({ version: 1,
    features: Object.fromEntries(features.map(({ id }) => [id, id === 'notes'])) }));
  const child = spawn(python, args, { cwd: path.join(__dirname, '..'), windowsHide: true,
    env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) } });
  let logs = '', browser, page;
  child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
  try {
    const cdp = 'http://127.0.0.1:' + debug;
    await until(async () => {
      try { return (await fetch(native ? cdp + '/json/version' : origin + '/api/runtime')).ok; } catch { return false; }
    });
    if (native) {
      browser = await chromium.connectOverCDP(cdp);
      page = await until(() => browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1')));
    } else {
      browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
      page = await browser.newPage({ viewport: { width: 1310, height: 885 }, reducedMotion: 'reduce' });
    }
    page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/note-database')) requests.push(request.url()); });
    await page.addInitScript(() => {
      localStorage.setItem('canvas:toolbarLanguage', 'en');
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteView:v1', 'live');
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-workspace.js'), 'utf8');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source.replace(
      '  window.CanvasNoteWorkspace = {', '  window.__databaseTest = {state, openNote, flushSave, setViewMode, get editor() {return liveEditor;}};\n  window.CanvasNoteWorkspace = {') }));
    await page.goto(native ? page.url() : origin);
    if (!notesOnly) {
      const workspace = page.locator('button[data-start-workspace="notes"]');
      if (await workspace.isVisible() && await workspace.getAttribute('aria-pressed') !== 'true') await workspace.click();
    }
    await page.waitForFunction(() => window.__databaseTest?.state.initialized && __databaseTest.state.active && !__databaseTest.state.openingPath);
    const open = note => page.evaluate(note => __databaseTest.openNote(note, { reuseActiveTab: false }), note);
    const save = () => page.evaluate(() => __databaseTest.flushSave());
    const mode = next => page.evaluate(next => __databaseTest.setViewMode(next), next);
    const body = page.locator('[data-role="note-editor"] .cm-content').first();
    const blocks = page.locator('.note-database-carrier:visible');
    const documentText = () => page.evaluate(() => __databaseTest.editor.snapshot().value);
    async function append(text) {
      await page.evaluate(text => {
        const { view } = __databaseTest.editor;
        view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.test' });
      }, text);
      await save();
    }
    async function command(name, note = 'Main.md') {
      const row = page.locator(`[data-role="note-tree"] [data-path="${note}"] > .note-tree-row`);
      await row.click({ button: 'right' });
      await page.locator(`[data-role="note-context-menu"] [data-note-action="${name}"]`).click();
    }
    async function get(note) {
      const response = await page.request.get(new URL('/api/note-database?path=' + encodeURIComponent(note), page.url()).href);
      assert(response.ok(), await response.text());
      return response.json();
    }

    assert(await open('Main.md'));
    await body.locator('.cm-line').filter({ hasText: 'Main body' }).click({ button: 'right' });
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('script[src$="note-database.js"]').count(), 0, 'load the database runtime only on demand');
    const menu = page.locator('[data-role="note-context-menu"]');
    await menu.locator('[data-note-submenu="insert"]').hover();
    await menu.locator('[data-note-command="insert:database"]').click();
    await save();
    assert((await documentText()).includes(marker));
    await blocks.first().locator('table').waitFor();
    const first = await get('Main.md');
    assert(fs.existsSync(databaseFile('Main')) && first.exists && first.columns.length === 1);
    await append('\n\n' + marker + '\n');
    await blocks.nth(1).locator('table').waitFor();
    await blocks.first().locator('[data-db-role="add-row"]').click();
    await blocks.nth(1).locator('tbody tr').first().waitFor();
    assert.equal((await get('Main.md')).rows.length, 1, 'both views add records to the same database');

    const grid = blocks.first();
    const firstCell = grid.locator('tbody tr').first().locator('td button').first();
    assert(await firstCell.evaluate(node => node === document.activeElement), 'added row focuses its first cell');
    await page.keyboard.press('H');
    const editor = grid.locator('.note-database-cell-input');
    assert.equal(await editor.inputValue(), 'H');
    await editor.fill('First record');
    await editor.press('Enter');
    await blocks.nth(1).getByText('First record', { exact: true }).waitFor();
    await firstCell.press('Shift+F10');
    await grid.locator('.note-database-panel button').filter({ hasText: /Delete row|删除记录/ }).click();
    await until(async () => (await get('Main.md')).total === 0);
    await page.waitForFunction(() => document.activeElement?.dataset.dbRole === 'add-row');
    await page.keyboard.press('Control+z');
    await grid.getByText('First record', { exact: true }).waitFor();
    for (const type of ['status', 'number']) {
      await grid.locator('[data-db-role="add-column"]').click();
      await grid.locator('[data-db-role="type-' + type + '"]').click();
      await until(async () => (await get('Main.md')).columns.some(column => column.type === type));
    }
    const columns = (await get('Main.md')).columns;
    const status = columns.find(column => column.type === 'status'), number = columns.find(column => column.type === 'number');
    const done = status.choices.at(-1);
    await grid.locator('[data-db-role="view"]').click();
    await grid.locator('.review-choice-trigger').click();
    await grid.locator('.review-choice-popup').waitFor();
    assert.equal(await grid.locator('select:visible').count(), 0, 'production uses the shared dropdown');
    await page.keyboard.press('Escape');
    await grid.locator('.review-choice-popup').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await grid.locator('.note-database-panel').waitFor({ state: 'detached' });
    await grid.locator('tbody tr').first().locator('td button').nth(1).dblclick();
    await grid.locator('.note-database-panel').getByRole('button', { name: done.name, exact: true }).click();
    await until(async () => (await get('Main.md')).rows[0].values[status.id] === done.id);
    async function paste(text) {
      await firstCell.click();
      await firstCell.evaluate((node, value) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', value);
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, text);
    }
    await paste('Edited\t' + done.name + '\t42\r\nAppended\t' + done.name + '\t67');
    const pasted = await until(async () => {
      const data = await get('Main.md');
      return data.rows.length === 2 && data;
    });
    assert.equal(pasted.rows[0].values[number.id], 42);
    assert.equal(pasted.rows[1].values[status.id], done.id);
    await grid.getByText('Edited', { exact: true }).waitFor();
    await firstCell.press('Shift+ArrowRight');
    assert.equal(await grid.locator('.is-selected').count(), 2);
    await firstCell.press('Control+z');
    await until(async () => (await get('Main.md')).rows.length === 1);
    await firstCell.press('Control+y');
    await until(async () => (await get('Main.md')).rows.length === 2);
    await paste('Invalid\t' + done.name + '\tnot a number');
    assert.equal((await get('Main.md')).rows[0].values[columns[0].id], 'Edited', 'invalid paste leaves earlier cells intact');

    await grid.locator('[data-db-role="search-toggle"]').click();
    const search = grid.locator('[data-db-role="search"]');
    await search.fill('Only pinned row');
    await page.waitForFunction(() => document.querySelector('.note-database-carrier tbody').rows.length === 0);
    await grid.locator('[data-db-role="add-row"]').click();
    await grid.locator('tr.is-pinned').waitFor();
    await page.keyboard.press('Enter');
    await editor.fill('Only pinned row');
    await editor.press('Enter');
    await blocks.nth(1).getByText('Only pinned row', { exact: true }).waitFor();
    await search.fill('');
    await until(() => grid.locator('tbody tr').count().then(count => count === 3));

    const resize = grid.locator('[data-db-role="size-' + status.id + '"]');
    const stateCell = grid.locator('tbody tr').first().locator('td button').nth(1);
    await stateCell.evaluate(node => { node.dataset.resizeProbe = 'kept'; });
    await resize.press('ArrowRight');
    await until(async () => (await get('Main.md')).columns.find(column => column.id === status.id).width === 192);
    await grid.locator('[data-db-role="size-' + status.id + '"]').waitFor();
    assert.equal(await stateCell.getAttribute('data-resize-probe'), 'kept', 'a column width change preserves cell DOM');
    await grid.locator('[data-db-role="edit-' + status.id + '"]').click();
    await grid.locator('.note-database-panel button').filter({ hasText: /Move left|左移/ }).click();
    await until(async () => (await get('Main.md')).columns[0].id === status.id);
    await grid.locator('[data-db-role="edit-' + status.id + '"]').click();
    await grid.locator('.note-database-panel button').filter({ hasText: /Hide field|隐藏字段/ }).click();
    await until(async () => (await get('Main.md')).columns[0].hidden);
    await blocks.nth(1).locator('[data-db-role="edit-' + status.id + '"]').waitFor({ state: 'detached' });

    const idle = requests.length;
    await append('\n\nOrdinary text.');
    await pause(500);
    assert.equal(requests.length, idle, 'text changes and idle produce no database requests');
    await mode('reading');
    await blocks.first().locator('table').waitFor();
    await mode('source');
    assert.equal(await blocks.count(), 0);
    assert.equal((await documentText()).split(marker).length, 3);
    await mode('live');
    await command('delete-database');
    await page.locator('.note-modal-actions button.danger').click();
    await until(() => !fs.existsSync(databaseFile('Main')));
    await append('\nAfter removal.');
    assert(!(await get('Main.md')).exists);
    assert.equal((await documentText()).split(marker).length, 3);
    await blocks.first().locator('[data-db-role="create"]').click();
    await until(() => fs.existsSync(databaseFile('Main')));
    await blocks.nth(1).locator('table').waitFor();

    await open('Drop.md');
    const transfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['%PDF-1.7'], 'reference.pdf', { type: 'application/pdf' }));
      return transfer;
    });
    await body.dispatchEvent('drop', { dataTransfer: transfer, clientX: 500, clientY: 350 });
    await blocks.first().locator('table').waitFor();
    await until(() => fs.readFileSync(path.join(notes, 'Drop.md'), 'utf8').includes(marker));
    assert.equal((await get('Drop.md')).rows.length, 0, 'attachment import does not add rows');
    const files = path.join(path.dirname(databaseFile('Drop')), 'files');
    assert.equal(fs.readdirSync(files).length, 1);
    await command('cleanup-unused-database-attachments', 'Drop.md');
    const confirmation = page.locator('.note-modal-card');
    assert.match(await confirmation.locator('p').innerText(), /1/);
    await confirmation.locator('.note-modal-actions button.danger').click();
    await until(() => fs.readdirSync(files).length === 0);
    assert((await get('Drop.md')).exists, 'attachment cleanup preserves the database');
    assert.deepEqual(errors, []);
    console.log('Note database workspace verified (' + (native ? 'WebView2' : notesOnly ? 'notes only' : 'browser') + ')');
  } catch (error) {
    console.error(logs, error); process.exitCode = 1;
  } finally {
    if (native) {
      await page?.evaluate(() => window.pywebview?.api?.close_window()).catch(() => {});
      if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(4000)]);
    }
    await browser?.close().catch(() => {});
    const stopped = child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    if (child.exitCode === null) child.kill();
    await stopped;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-database-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})();

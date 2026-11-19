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
const chartsOnly = process.argv.includes('--charts-only');
const chartViews = process.argv.includes('--chart-views');
const chartColors = process.argv.includes('--chart-colors');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-database-'));
const notes = path.join(root, 'notes');
const downloads = path.join(root, 'downloads');
const marker = id => '```database ' + id + '\n```';
const databaseFile = note => path.join(notes, note + '.assets', '.relatum-databases', 'database.sqlite3');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(notes);
fs.mkdirSync(downloads);
fs.mkdirSync(path.join(root, 'recycled'));
for (const name of ['Main', 'Drop', 'Other']) fs.writeFileSync(path.join(notes, name + '.md'), name + ' body\n');
if (chartsOnly) fs.writeFileSync(path.join(notes, 'Charts.md'), marker('charts') + '\n');
if (chartViews || chartColors) fs.writeFileSync(path.join(notes, 'Charts.md'), 'Before chart\n\n' + marker('charts') + '\n\nBetween charts\n\n'
  + marker('charts') + '\n\nAfter chart\n\n' + Array.from({ length: 120 }, (_, index) => `Paragraph ${index}\n\n`).join(''));

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
  const python = process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python';
  const code = 'import os, sys, uuid, app; from pathlib import Path; '
    + 'import note_database; '
    + 'from note_database import NoteDatabases; initialize = NoteDatabases._initialize; failures = {"retry-once"}; '
    + 'exec("def initialize_once(connection, identity, language):\\n if identity in failures:\\n  failures.remove(identity)\\n  raise OSError(\\\"simulated database write failure\\\")\\n return initialize(connection, identity, language)"); '
    + 'NoteDatabases._initialize = staticmethod(initialize_once); '
    + 'root = Path(os.environ["RELATUM_DATA_ROOT"]); '
    + 'note_database._downloads_directory = lambda: root / "downloads"; '
    + 'app._move_paths_to_recycle_bin = lambda paths: [p.rename(root / "recycled" / (uuid.uuid4().hex + "-" + p.name)) for p in paths]; '
    + (native ? 'import desktop; sys.argv[0] = "desktop.py"; sys.exit(desktop.main())' : 'sys.argv[0] = "app.py"; sys.exit(app.main())');
  const args = ['-B', '-c', code];
  if (notesOnly) args.push('--launch-profile', JSON.stringify({ version: 1,
    features: Object.fromEntries(features.map(({ id }) => [id, id === 'notes'])) }));
  let logs = '', child, browser, page;
  const errors = [], requests = [], chartRequests = [];
  async function launch() {
    const port = await freePort(), debug = native ? await freePort() : 0;
    const origin = 'http://127.0.0.1:' + port;
    child = spawn(python, native ? args : [...args, '--port', String(port), '--no-browser'], {
      cwd: path.join(__dirname, '..'), windowsHide: true, env: { ...process.env, RELATUM_DATA_ROOT: root,
        ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) },
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-12000); });
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
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/api/note-database')) requests.push(url);
      if (/\/note-database-chart\.js|\/vendor\/echarts\/|\/api\/note-database\/chart/.test(url)) chartRequests.push(url);
    });
    await page.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('canvas:toolbarLanguage', 'en');
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteView:v1', 'live');
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-workspace.js'), 'utf8');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source.replace(
      '  window.CanvasNoteWorkspace = {', '  window.__databaseTest = {state, openNote, flushSave, setViewMode, movePath, setNoteSettingsOpen, get editor() {return liveEditor;}};\n  window.CanvasNoteWorkspace = {') }));
    await page.goto(native ? page.url() : origin);
    if (!notesOnly) {
      const workspace = page.locator('button[data-start-workspace="notes"]');
      if (await workspace.isVisible() && await workspace.getAttribute('aria-pressed') !== 'true') await workspace.click();
    }
    await page.waitForFunction(native => window.__databaseTest?.state.initialized && __databaseTest.state.active
      && !__databaseTest.state.openingPath && (!native || typeof window.pywebview?.api?.close_window === 'function'), native);
    return page;
  }
  async function stop(requireGraceful = false) {
    if (!child) return;
    if (native) {
      const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
      await page?.evaluate(() => { void window.pywebview?.api?.close_window(); }).catch(() => {});
      await Promise.race([exited, pause(4500)]);
    }
    const graceful = child.exitCode === 0;
    await browser?.close().catch(() => {});
    const stopped = child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    if (child.exitCode === null) child.kill();
    await stopped;
    child = browser = page = null;
    if (requireGraceful && native) assert(graceful, 'WebView2 must exit normally before restarting');
  }
  try {
    await launch();
    const open = note => page.evaluate(note => __databaseTest.openNote(note, { reuseActiveTab: false }), note);
    const save = () => page.evaluate(() => __databaseTest.flushSave());
    const mode = next => page.evaluate(next => __databaseTest.setViewMode(next), next);
    const body = page.locator('[data-role="note-editor"] .cm-content').first();
    const blocks = page.locator('.note-database-carrier:visible');
    if (process.argv.includes('--reference-move')) {
      const { checkReferenceMove } = require('./note-reference-move-browser.js');
      await checkReferenceMove({ page, notes, open, save, native });
      assert.deepEqual(errors, []);
      console.log(`Note reference block movement verified (${native ? 'WebView2' : 'Edge'})`);
      return;
    }
    if (chartViews || chartColors) {
      const check = chartColors ? require('./note-database-chart-colors-browser.js').checkChartColors
        : require('./note-database-chart-views-browser.js').checkChartViews;
      await check({ page, open, mode, chartRequests, until, restart: async () => {
        await stop(true);
        return launch();
      } });
      assert.deepEqual(errors, []);
      console.log(`Note database chart ${chartColors ? 'colors' : 'views'} and restart verified (${native ? 'WebView2' : 'Edge'})`);
      return;
    }
    if (chartsOnly) {
      const { checkCharts } = require('./note-database-chart-browser.js');
      assert(await open('Main.md'));
      await body.locator('.cm-line').filter({ hasText: 'Main body' }).waitFor();
      await checkCharts({ page, open, blocks, chartRequests });
      assert.deepEqual(errors, []);
      console.log('Note database charts verified (' + (native ? 'WebView2' : notesOnly ? 'notes only' : 'browser') + ')');
      return;
    }
    const documentText = () => page.evaluate(() => __databaseTest.editor.snapshot().value);
    const reveal = end => page.evaluate(end => {
      const { view } = __databaseTest.editor;
      view.dispatch({ selection: { anchor: end ? view.state.doc.length : 0 }, scrollIntoView: true });
    }, end);
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
    let mainId;
    async function get(note, databaseId = mainId) {
      const params = new URLSearchParams({ path: note, databaseId });
      const response = await page.request.get(new URL('/api/note-database?' + params, page.url()).href);
      assert(response.ok(), await response.text());
      return response.json();
    }

    assert(await open('Main.md'));
    await body.locator('.cm-line').filter({ hasText: 'Main body' }).click({ button: 'right' });
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('script[src$="note-database.js"]').count(), 0, 'load the database runtime only on demand');
    const menu = page.locator('[data-role="note-context-menu"]');
    await menu.locator('[data-note-submenu="insert"]').hover();
    let releaseSave;
    const gated = new Promise(resolve => { releaseSave = resolve; });
    const slowSave = async route => { await gated; await route.continue(); };
    await page.route('**/api/note-save', slowSave);
    await menu.locator('[data-note-command="insert:database"]').click();
    try {
      await blocks.first().waitFor();
      assert.equal(await blocks.first().locator('table, [data-db-role="retry-create"]').count(), 0);
      assert.equal(requests.length, 0, 'an unsaved block starts no database read');
    } finally { releaseSave(); }
    await save();
    await page.unroute('**/api/note-save', slowSave);
    await blocks.first().locator('table').waitFor();
    mainId = await blocks.first().getAttribute('data-database-id');
    assert((await documentText()).includes(marker(mainId)));
    const first = await get('Main.md');
    assert(fs.existsSync(databaseFile('Main')) && first.exists && first.columns.length === 1);
    await append('\n\n' + marker(mainId) + '\n');
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
    await firstCell.click();
    assert.equal(await editor.inputValue(), 'First record');
    await editor.press('Escape');
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
    assert.deepEqual(status.choices.map(option => option.tone), ['neutral', 'blue', 'green']);
    const done = status.choices.at(-1);
    await grid.locator('[data-db-role="view"]').click();
    await grid.locator('.review-choice-trigger').click();
    await grid.locator('.review-choice-popup').waitFor();
    assert.equal(await grid.locator('select:visible').count(), 0, 'production uses the shared dropdown');
    await page.keyboard.press('Escape');
    await grid.locator('.review-choice-popup').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await grid.locator('.note-database-panel').waitFor({ state: 'detached' });
    await grid.locator('tbody tr').first().locator('td button').nth(1).click();
    await grid.locator('.note-database-panel').getByRole('button', { name: done.name, exact: true }).click();
    await until(async () => (await get('Main.md')).rows[0].values[status.id] === done.id);
    async function paste(text, target = firstCell) {
      await target.focus();
      await target.evaluate((node, value) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', value);
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, text);
    }
    await firstCell.click();
    await paste('Edited\t' + done.name + '\t42\r\nAppended\t' + done.name + '\t67', editor);
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
    const drag = grid.locator('[data-db-role="edit-' + status.id + '"]');
    const drop = grid.locator('[data-db-role="edit-' + number.id + '"]');
    await drag.dragTo(drop, { targetPosition: { x: 14, y: 14 } });
    await until(async () => (await get('Main.md')).columns[1].id === status.id);
    await grid.locator('[data-db-role="edit-' + status.id + '"]').click();
    await grid.locator('.note-database-panel button').filter({ hasText: /Hide field|隐藏字段/ }).click();
    await until(async () => (await get('Main.md')).columns.find(column => column.id === status.id).hidden);
    await blocks.nth(1).locator('[data-db-role="edit-' + status.id + '"]').waitFor({ state: 'detached' });
    const nameHeader = grid.locator('[data-db-role="edit-' + columns[0].id + '"]');
    if (!native) await page.setViewportSize({ width: 970, height: 885 });
    await nameHeader.dragTo(drop, { targetPosition: { x: 128, y: 14 } });
    await until(async () => (await get('Main.md')).columns[0].id === number.id);
    assert.equal((await get('Main.md')).columns[1].id, status.id, 'hidden fields keep their previous slots');
    if (!native) await page.setViewportSize({ width: 1310, height: 885 });

    for (const [type, expected] of [['select', /Single tag|单标签/], ['multiSelect', /Multiple tags|多标签/]]) {
      await grid.locator('[data-db-role="add-column"]').click();
      const entry = grid.locator('[data-db-role="type-' + type + '"]');
      assert.match(await entry.innerText(), expected);
      await entry.click();
      const added = await until(async () => (await get('Main.md')).columns.find(column => column.type === type));
      assert.match(added.name, expected);
    }
    const single = grid.locator('tbody tr').first().locator('[data-db-type="select"]');
    await single.click();
    await grid.locator('.note-database-panel input').fill('Reference');
    await grid.locator('[data-db-role="create-choice"]').click();
    await single.getByText('Reference', { exact: true }).waitFor();
    await single.click();
    await grid.getByRole('button', { name: /(?:Edit option|编辑选项) · Reference/ }).press('Enter');
    const colors = grid.locator('.note-database-option-menu');
    await colors.getByRole('button', { name: /^(?:Brown|棕色)$/ }).click();
    await colors.waitFor({ state: 'detached' });
    await blocks.nth(1).locator('[data-db-tone="brown"]').getByText('Reference', { exact: true }).waitFor();
    await page.keyboard.press('Escape');

    const title = grid.locator('[data-db-role="rename-database"]');
    await title.click();
    assert.equal(await grid.locator('.note-database-panel').count(), 0);
    await title.dblclick();
    const nameEditor = grid.getByRole('textbox', { name: /^(?:Database name|数据库名称)$/ });
    await nameEditor.fill('Attachment ledger');
    await nameEditor.press('Enter');
    await blocks.nth(1).getByText('Attachment ledger', { exact: true }).waitFor();
    await title.press('Enter');
    assert.equal(await nameEditor.inputValue(), 'Attachment ledger');
    await page.keyboard.press('Escape');
    await grid.locator('[data-db-role="add-column"]').click();
    await grid.locator('[data-db-role="type-attachment"]').click();
    const attachmentColumn = await until(async () => (await get('Main.md')).columns.find(column => column.type === 'attachment'));
    const attachmentCell = grid.locator('tbody tr').first().locator('button[data-db-type="attachment"]');
    await attachmentCell.click({ position: { x: 24, y: 13 } });
    const upload = grid.locator('[data-db-role="upload-attachment"]');
    const download = grid.locator('[data-db-role="download-attachment"]');
    async function pick(file) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()]);
      await chooser.setFiles(file);
    }
    const pdf = { name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 fixture') };
    await pick(pdf);
    await attachmentCell.getByText(pdf.name, { exact: true }).waitFor();
    await attachmentCell.click({ position: { x: 24, y: 13 } });
    await download.click();
    await until(() => fs.existsSync(path.join(downloads, pdf.name)));
    await download.click();
    await until(() => fs.existsSync(path.join(downloads, 'fixture (2).pdf')));
    assert.deepEqual(fs.readFileSync(path.join(downloads, pdf.name)), pdf.buffer);
    await pick([]);
    await grid.locator('input[type="file"]').waitFor({ state: 'detached' });
    assert.equal((await get('Main.md')).rows[0].values[attachmentColumn.id].name, pdf.name);
    await pick({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await grid.getByRole('status').getByText(/图片内容与扩展名不一致/).waitFor();
    assert.equal((await get('Main.md')).rows[0].values[attachmentColumn.id].name, pdf.name);
    const picture = { name: 'fixture.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>') };
    await pick(picture);
    await attachmentCell.getByText(picture.name, { exact: true }).waitFor();
    const sharedFiles = path.join(path.dirname(databaseFile('Main')), 'files');
    assert.equal(fs.readdirSync(sharedFiles).length, 2);
    assert.equal((await get('Main.md')).rows[0].values[attachmentColumn.id].name, picture.name);

    const idle = requests.length;
    await append('\n\nOrdinary text.');
    await pause(500);
    assert.equal(requests.length, idle, 'text changes and idle produce no database requests');
    await mode('reading');
    await blocks.first().locator('table').waitFor();
    await mode('source');
    assert.equal(await blocks.count(), 0);
    assert.equal((await documentText()).split(marker(mainId)).length, 3);
    await mode('live');
    await append('\n\n' + marker('independent'));
    await reveal(true);
    await page.locator('.note-database-carrier[data-database-id="independent"] table').waitFor();
    assert.equal((await get('Main.md', 'independent')).total, 0);
    await reveal(false);
    const trash = blocks.first().locator('[data-db-role="delete-database"]');
    assert.deepEqual(await trash.evaluate(node => [node.previousElementSibling.dataset.dbRole, node.nextElementSibling.dataset.dbRole]), ['search-toggle', 'view']);
    const smallConfirmation = page.locator('.note-database-confirm');
    await trash.click();
    const cancelDelete = smallConfirmation.getByRole('button', { name: /^(?:Cancel|取消)$/ });
    await cancelDelete.waitFor();
    assert(await cancelDelete.evaluate(node => document.activeElement === node));
    await cancelDelete.click();
    assert((await get('Main.md')).exists);
    await trash.click();
    const confirmDelete = smallConfirmation.getByRole('button', { name: /^(?:Delete|删除)$/ });
    assert.equal(await confirmDelete.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 0, 0)');
    const oldTheme = await page.evaluate(() => {
      const theme = document.body.dataset.startTheme;
      document.body.dataset.startTheme = 'dark';
      return theme;
    });
    assert.equal(await confirmDelete.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.evaluate(theme => {
      if (theme == null) delete document.body.dataset.startTheme;
      else document.body.dataset.startTheme = theme;
    }, oldTheme);
    const table = await get('Main.md');
    const renameOutside = await page.request.post(new URL('/api/note-database/action', page.url()).href, { data: {
      path: 'Main.md', databaseId: mainId, action: { type: 'renameDatabase', revision: table.revision, name: 'Renamed elsewhere' },
    } });
    assert(renameOutside.ok());
    await confirmDelete.click();
    await title.filter({ hasText: 'Renamed elsewhere' }).waitFor();
    assert((await get('Main.md')).exists, 'a modification during confirmation prevents deletion');
    await trash.click();
    await confirmDelete.click();
    await smallConfirmation.waitFor({ state: 'detached' });
    await until(async () => (await get('Main.md')).deleted);
    const manager = page.locator('.note-database-manager');
    assert((await get('Main.md', 'independent')).exists);
    assert.equal(fs.readdirSync(sharedFiles).length, 2);
    await append('\nAfter removal.');
    assert((await get('Main.md')).deleted);
    assert.equal((await documentText()).split(marker(mainId)).length, 3);
    await reveal(false);
    await page.locator('.note-database-carrier[data-database-id="' + mainId + '"]').first().getByText(/Database deleted|数据库已删除/).waitFor();
    await append('\n\n' + marker('retry-once'));
    await reveal(true);
    const retryBlock = page.locator('.note-database-carrier[data-database-id="retry-once"]');
    await retryBlock.locator('[data-db-role="retry-create"]').click();
    await retryBlock.locator('table').waitFor();
    assert((await get('Main.md', 'retry-once')).exists);

    await open('Drop.md');
    const transfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['%PDF-1.7'], 'reference.pdf', { type: 'application/pdf' }));
      return transfer;
    });
    await body.dispatchEvent('drop', { dataTransfer: transfer, clientX: 500, clientY: 350 });
    await blocks.first().locator('table').waitFor();
    const dropId = await blocks.first().getAttribute('data-database-id');
    await until(() => fs.readFileSync(path.join(notes, 'Drop.md'), 'utf8').includes(marker(dropId)));
    assert.equal((await get('Drop.md', dropId)).rows.length, 0, 'attachment import does not add rows');
    const files = path.join(path.dirname(databaseFile('Drop')), 'files');
    assert.equal(fs.readdirSync(files).length, 1);
    await command('cleanup-unused-database-attachments', 'Drop.md');
    const confirmation = page.locator('.note-modal-card');
    assert.match(await confirmation.locator('p').innerText(), /1/);
    await confirmation.locator('.note-modal-actions button.danger').click();
    await until(() => fs.readdirSync(files).length === 0);
    assert((await get('Drop.md', dropId)).exists, 'attachment cleanup preserves the database');
    await body.dispatchEvent('drop', { dataTransfer: transfer, clientX: 500, clientY: 350 });
    await until(() => fs.readdirSync(files).length === 1);
    assert.equal(await blocks.count(), 1, 'dropping near a table reuses the shared files directory');
    await command('delete-database', 'Drop.md');
    await manager.locator('[data-note-action="purge-databases"]').click();
    assert.match(await manager.locator('.note-database-manager-list').innerText(), /1 .*1 /);
    await manager.locator('[data-note-action="confirm-database-delete"]').click();
    await manager.waitFor({ state: 'detached' });
    assert(!fs.existsSync(files));
    assert((await get('Drop.md', dropId)).deleted);
    assert.deepEqual(errors, []);
    console.log('Note database workspace verified (' + (native ? 'WebView2' : notesOnly ? 'notes only' : 'browser') + ')');
  } catch (error) {
    console.error(logs, error); process.exitCode = 1;
  } finally {
    await stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-database-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})();

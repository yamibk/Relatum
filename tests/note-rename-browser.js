'use strict';
// Real UI and move API with disposable notebooks; no real user files are used.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-rename-'));
const book = path.join(root, 'notes', 'CustomNotebook', 'Book');
fs.mkdirSync(path.join(book, 'Folder', 'Source.assets'), { recursive: true });
fs.mkdirSync(path.join(book, 'Existing'));
fs.mkdirSync(path.join(book, 'Large'));
fs.writeFileSync(path.join(book, 'Folder', 'Source.md'), '# Original\n');
fs.writeFileSync(path.join(book, 'Folder', 'Source.assets', 'keep.txt'), 'Attachment fixture');
for (let i = 0; i < 230; i++) fs.mkdirSync(path.join(book, 'Large', 'F' + String(i).padStart(3, '0')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let browser, server;
  try {
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const url = 'http://127.0.0.1:' + port;
    server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
      cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, RELATUM_DATA_ROOT: root },
    });
    let ready = false;
    for (let i = 0; i < 150; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.stack || error.message));
    let source = fs.readFileSync(path.join(__dirname, '../assets/note-workspace.js'), 'utf8');
    source = source.replace('  window.CanvasNoteWorkspace = {', '  window.__renameTest = {state,renderTree,selectNotebook,loadDirectory,stopExternalSync,stopDocumentPrefetch};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url); await page.waitForFunction(() => window.CanvasNoteWorkspace);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__renameTest?.state.initialized && __renameTest.state.active);
    await page.waitForFunction(() => !document.querySelector('[data-start-workspace-panel="notes"]').classList.contains('workspace-entering'));
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.locator('[data-note-action="side-notebooks"]').click();
    await page.evaluate(() => {
      const test = __renameTest; test.stopExternalSync(); test.stopDocumentPrefetch(); test.selectNotebook('CustomNotebook/Book');
      test.state.notebookExpanded.add('CustomNotebook/Book'); test.state.notebookTreeDirty = true; test.renderTree();
    });
    const host = side => side === 'left' ? '[data-role="note-tree"]' : '[data-role="note-notebook-tree"]';
    const row = (side, name) => page.locator(host(side) + ' .note-tree-row[data-note-path="CustomNotebook/Book/' + name + '"]');
    async function rename(side, name) {
      await row(side, name).click({ button: 'right' });
      await page.locator('[data-role="note-context-menu"] > button').filter({ hasText: /^重命名$/ }).click();
      const input = page.locator(host(side) + ' .note-tree-rename'); await input.waitFor();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.note-tree-rename').count(), 1, 'Only the initiating tree owns an input');
      assert(await input.evaluate(node => node === document.activeElement), 'Input keeps focus');
      return input;
    }
    let moves = 0; page.on('request', request => { if (request.url().includes('/api/note-move')) moves++; });
    for (const side of ['left', 'right']) { const input = await rename(side, 'Folder'); await input.press('Escape'); await page.waitForFunction(() => !__renameTest.state.renamePath); }
    assert.equal(moves, 0, 'Cancel performs no disk operation');
    let input = await rename('left', 'Folder'); await input.fill('Existing'); await input.press('Enter');
    await page.locator(host('left') + ' .note-tree-inline-error').waitFor();
    assert.equal(await page.locator('.note-tree-rename').count(), 1, 'Name conflict preserves one draft');
    input = page.locator(host('left') + ' .note-tree-rename'); await input.fill('Renamed'); await input.press('Enter');
    await row('left', 'Renamed').waitFor(); await row('right', 'Renamed').waitFor();
    assert.equal(fs.readFileSync(path.join(book, 'Renamed', 'Source.md'), 'utf8'), '# Original\n');
    assert.equal(fs.readFileSync(path.join(book, 'Renamed', 'Source.assets', 'keep.txt'), 'utf8'), 'Attachment fixture');
    input = await rename('right', 'Renamed'); await input.fill('Folder');
    await input.press('Tab');
    await page.waitForFunction(() => !__renameTest.state.renameCommitPromise && !__renameTest.state.renamePath);
    await row('left', 'Folder').waitFor();
    input = await rename('left', 'Folder'); await input.fill(''); await input.press('Enter');
    await page.locator(host('left') + ' .note-tree-inline-error').filter({ hasText: '名称不能为空' }).waitFor();
    await page.locator(host('left') + ' .note-tree-rename').press('Escape');
    input = await rename('left', 'Folder'); const beforeComposition = moves;
    await input.dispatchEvent('compositionstart', { data: 'zhong' }); await input.fill('中文'); await input.press('Enter');
    assert.equal(moves, beforeComposition, 'Composition Enter does not submit a rename');
    await input.dispatchEvent('compositionend', { data: '中文' }); await input.press('Escape');
    await page.waitForFunction(() => !__renameTest.state.renamePath);
    await page.evaluate(() => { const t = __renameTest; t.state.notebookExpanded.delete('CustomNotebook/Book'); t.state.notebookTreeDirty = true; t.renderTree(); });
    input = await rename('left', 'Folder'); await input.press('Escape');
    // Exercise independently windowed projections of the same long directory.
    await page.evaluate(async () => {
      const t = __renameTest; await t.loadDirectory('CustomNotebook/Book/Large');
      while (t.state.treePagination['CustomNotebook/Book/Large']?.hasMore) await t.loadDirectory('CustomNotebook/Book/Large');
      t.state.expanded.add('CustomNotebook/Book/Large'); t.state.notebookExpanded.add('CustomNotebook/Book');
      t.state.notebookExpanded.add('CustomNotebook/Book/Large'); t.state.notebookTreeDirty = true; t.renderTree();
      for (const role of ['note-tree', 'note-notebook-tree']) document.querySelector('[data-role="' + role + '"]').__noteWindow?.scrollToKey('CustomNotebook/Book/Large/F220');
    });
    for (const side of ['left', 'right']) {
      await page.evaluate(role => document.querySelector('[data-role="' + role + '"]').__noteWindow?.scrollToKey('CustomNotebook/Book/Large/F220'), side === 'left' ? 'note-tree' : 'note-notebook-tree');
      input = await rename(side, 'Large/F220'); await input.press('Escape'); await page.waitForFunction(() => !__renameTest.state.renamePath);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Notebook rename: dual trees, conflict/retry, blur, composition and windowed rows OK');
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

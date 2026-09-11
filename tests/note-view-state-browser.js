'use strict';

// Optional acceptance test: host-provided Playwright, isolated real notes API.
// RELATUM_PLAYWRIGHT, RELATUM_PYTHON and RELATUM_EDGE_PATH configure the host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-view-'));
const key = 'canvas:noteViewStates:v1';
const initial = 'First line\n' + 'A test line\n'.repeat(100) + 'Last line';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(path.join(root, 'notes', 'folder'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', 'A.md'), initial);
fs.writeFileSync(path.join(root, 'notes', 'B.md'), 'Second note');
fs.writeFileSync(path.join(root, 'notes', 'folder', 'C.md'), initial);
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, 'notes', `extra-${i}.md`), `Note ${i}`);

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
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (error) {}
      if (ready) break;
      await sleep(100);
    }
    assert(ready, 'isolated server did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    // Expose internals only in the intercepted test response; production has no debug API.
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__noteViewTest = {state, openNote, closeAllTabs, createEntry, movePath, setViewMode, flushSave, checkExternalChanges, snapshot: editorSnapshot, editor: liveEditor, rememberViewState, persistViewStates};\n  window.CanvasNoteWorkspace = {');
    async function prepare(target) {
      const page = await target.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      await page.goto(url);
      await page.waitForFunction(() => window.CanvasNoteWorkspace);
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => window.__noteViewTest?.state.active && window.__noteViewTest.state.initialized);
      return page;
    }
    let page = await prepare(context);
    async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await sleep(120); }
    async function open(name) { await page.evaluate(name => __noteViewTest.openNote(name, { reuseActiveTab: false }), name); await settle(); }
    async function position(anchor, head = anchor, scrollTop) {
      await page.evaluate(({anchor, head, scrollTop}) => {
        const view = __noteViewTest.editor.view;
        view.dispatch({ selection: { anchor, head }, scrollIntoView: scrollTop == null }); view.focus();
        if (scrollTop != null) view.scrollDOM.scrollTop = scrollTop;
      }, {anchor, head, scrollTop});
      await settle();
    }
    async function snapshot() { return page.evaluate(() => { const {anchor, head, scrollTop} = __noteViewTest.snapshot(); return {anchor, head, scrollTop}; }); }
    async function expectPosition(expected, message) {
      const actual = await snapshot();
      assert.equal(actual.anchor, expected.anchor, message + ': anchor');
      assert.equal(actual.head, expected.head, message + ': head');
      assert(Math.abs(actual.scrollTop - expected.scrollTop) < 16, `${message}: scroll ${actual.scrollTop} vs ${expected.scrollTop}`);
    }
    await open('A.md');
    const originalRow = await page.locator('.note-tree-row[data-note-path="A.md"]').elementHandle();
    const treeChanges = await page.evaluate(async () => {
      const records = [];
      const observer = new MutationObserver(changes => records.push(...changes));
      observer.observe(document.querySelector('[data-role="note-tree"]'), {childList: true, subtree: true});
      await __noteViewTest.checkExternalChanges(false);
      records.push(...observer.takeRecords()); observer.disconnect();
      return records.length;
    });
    assert.equal(treeChanges, 0, 'unchanged refresh must not rebuild tree DOM');
    await page.keyboard.press('F2');
    const rename = page.locator('.note-tree-rename');
    await rename.fill('Uncommitted draft');
    const renameNode = await rename.elementHandle();
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert(await renameNode.evaluate(node => node.isConnected && document.activeElement === node), 'refresh preserves rename focus');
    assert.equal(await rename.inputValue(), 'Uncommitted draft');
    await rename.press('Escape');
    const metadataRow = await page.locator('.note-tree-row[data-note-path="A.md"]').elementHandle();
    const stat = fs.statSync(path.join(root, 'notes', 'A.md'));
    fs.utimesSync(path.join(root, 'notes', 'A.md'), stat.atime, new Date(stat.mtimeMs + 1000));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert(await metadataRow.evaluate(node => node.isConnected), 'mtime-only refresh retains rows');
    fs.writeFileSync(path.join(root, 'notes', '000-added.md'), 'New external note');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await metadataRow.evaluate(node => node.isConnected), false, 'structural changes rebuild rows');
    assert.equal(await page.locator('.note-tree-row[data-note-path="000-added.md"]').count(), 1);
    fs.unlinkSync(path.join(root, 'notes', '000-added.md'));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row[data-note-path="000-added.md"]').count(), 0);
    await page.route('**/api/notes-tree', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test unavailable"}' }));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row').count(), 0);
    await page.unroute('**/api/notes-tree');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row[data-note-path="A.md"]').count(), 1, 'unchanged tree recovers after error');
    await originalRow.dispose();
    await position(initial.length);
    await page.keyboard.type(' local edit');
    await page.evaluate(() => __noteViewTest.flushSave());
    await settle();
    const saved = await snapshot();
    await open('B.md');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    await sleep(150);
    await open('A.md');
    await expectPosition(saved, 'own save -> other note -> refresh -> return');
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await settle();
    await expectPosition(saved, 'unchanged window focus');

    fs.appendFileSync(path.join(root, 'notes', 'A.md'), '\nexternal change');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    await settle();
    await expectPosition(saved, 'external change');
    await page.evaluate(() => __noteViewTest.closeAllTabs());
    await open('A.md');
    await expectPosition(saved, 'close all and reopen');
    for (let i = 0; i < 30; i++) await open(`extra-${i}.md`);
    assert.equal(await page.evaluate(() => __noteViewTest.state.documentCache.has('A.md')), false, 'A must actually be evicted');
    await open('A.md');
    await expectPosition(saved, 'cache eviction');
    await page.locator('button[data-start-workspace="canvas"]').click();
    await page.waitForFunction(() => !__noteViewTest.state.active);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => __noteViewTest.state.active);
    await settle();
    await expectPosition(saved, 'workspace switch');
    await page.screenshot({ path: path.join(root, 'restored-editor.png') });

    await position(50, 0, 0);
    const reversed = await snapshot();
    await open('B.md'); await open('A.md');
    await expectPosition(reversed, 'reverse selection ending at zero');
    await position(700, 700, 530);
    const scrolled = await snapshot();
    await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'A.md' && __noteViewTest.state.active);
    await settle();
    await expectPosition(scrolled, 'reload after selection/scroll only');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const storageState = await context.storageState();
    await context.close();
    context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page = await prepare(context); await settle();
    await expectPosition(scrolled, 'fresh browser context with persisted state');

    assert(await page.evaluate(() => __noteViewTest.movePath('A.md', 'Renamed.md', true)));
    await settle(); await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'Renamed.md');
    await settle(); await expectPosition(scrolled, 'rename survives reload');
    assert.equal(await page.evaluate(() => __noteViewTest.movePath('Renamed.md', 'B.md', true)), false);
    await settle(); await expectPosition(scrolled, 'failed rename');
    await open('folder/C.md'); await position(800); const folderView = await snapshot();
    assert(await page.evaluate(() => __noteViewTest.movePath('folder', 'moved', true)));
    await open('B.md'); await open('moved/C.md');
    await expectPosition(folderView, 'folder move');

    await open('Renamed.md');
    fs.writeFileSync(path.join(root, 'notes', 'Renamed.md'), 'short');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false)); await settle();
    assert.equal((await snapshot()).anchor, 5, 'shortened document clamps position');
    await open('moved/C.md');
    await page.evaluate(() => __noteViewTest.setViewMode('source')); await settle();
    await position(600); const sourceView = await snapshot();
    await page.evaluate(() => __noteViewTest.setViewMode('live')); await settle();
    await expectPosition(sourceView, 'source/live toggle');
    await page.evaluate(() => __noteViewTest.setViewMode('reading')); await settle();
    await page.evaluate(() => { document.querySelector('[data-role="note-reading-view"]').scrollTop = 500; });
    await settle(); const readingView = await snapshot();
    await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'moved/C.md');
    await settle(); await expectPosition(readingView, 'reading mode reload');

    await page.evaluate(() => {
      __noteViewTest.setViewMode('live');
      __noteViewTest.rememberViewState('Reused.md', {anchor: 90, head: 90, scrollTop: 400});
    });
    assert(await page.evaluate(() => __noteViewTest.createEntry('note', {parent: '', name: 'Reused.md', content: 'Fresh note '.repeat(30), noFocus: true})));
    await settle();
    assert.equal((await snapshot()).anchor, 0, 'new file must not inherit an old name\'s position');

    await page.evaluate(() => {
      for (let i = 0; i < 220; i++) __noteViewTest.rememberViewState(`memory-${i}.md`, {anchor: i, head: i, scrollTop: 0});
      __noteViewTest.persistViewStates();
    });
    const records = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.equal(records.length, 200);
    assert.deepEqual(Object.keys(records[0][1]).sort(), ['anchor', 'head', 'scrollTop']);
    await page.evaluate(key => localStorage.setItem(key, '{corrupt'), key);
    // A fresh tab reads the corrupt preference without the old page's unload writer.
    const corruptPage = await prepare(context);
    assert(await corruptPage.evaluate(() => !!__noteViewTest.editor));
    await corruptPage.evaluate(() => {
      const native = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'canvas:noteViewStates:v1') throw new Error('quota'); return native.call(this, key, value); };
      __noteViewTest.rememberViewState('test.md', {anchor: 1, head: 1, scrollTop: 0});
      __noteViewTest.persistViewStates();
    });
    assert.deepEqual(errors, [], 'browser errors');
    console.log('note view state browser: ok (tree DOM reuse, rename focus, metadata/structure refresh, error recovery, focus, external edits, reopen, eviction, selection, restart, moves, clamping, modes, bounded/corrupt/unavailable storage)');
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

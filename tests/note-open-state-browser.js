'use strict';
// Real tree clicks and failed/overlapping opens, using a disposable notes library.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-open-state-'));
  fs.mkdirSync(path.join(root, 'notes', 'canvases'), { recursive: true });
  const original = '原正文\n\n![seed.canvas|640x360](canvases/seed.canvas)\n\n结尾\n';
  fs.writeFileSync(path.join(root, 'notes', 'A.md'), original);
  fs.writeFileSync(path.join(root, 'notes', 'B.md'), '第二篇正文\n');
  fs.writeFileSync(path.join(root, 'notes', 'C.md'), '第三篇正文\n');
  fs.writeFileSync(path.join(root, 'notes', 'canvases', 'seed.canvas'), JSON.stringify({ version: 2, nodes: [], edges: [] }));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    source = source.replace('  async function openNote(path, options) {',
      '  function openNote(path, options) { const task = testOpenNote(path, options); (window.noteOpenTasks ||= []).push(task); return task; }\n  async function testOpenNote(path, options) {');
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, refreshTree, stopExternalSync, stopDocumentPrefetch, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
      localStorage.setItem('canvas:noteActivePath:v1', 'A.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'A.md' && T.editor
      && document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    await page.evaluate(async () => { await T.refreshTree(false); T.stopExternalSync(); T.stopDocumentPrefetch(); });
    const tree = page.locator('[data-role="note-tree"]');
    const sideOpen = () => page.locator('.note-workspace').evaluate(el => el.classList.contains('links-overlay-open'));
    const completed = index => page.evaluate(index => window.noteOpenTasks[index], index);
    async function startFile(file) {
      const count = await page.evaluate(() => window.noteOpenTasks.length);
      await tree.locator('[data-note-path="' + file + '"]').click();
      await page.waitForFunction(count => window.noteOpenTasks.length > count, count);
      return count;
    }
    async function expectTabWorks() {
      await tree.focus(); const before = await sideOpen();
      await page.keyboard.press('Tab'); assert.equal(await sideOpen(), !before, 'Tab opens/closes after the failed open finishes');
      await page.keyboard.press('Tab'); assert.equal(await sideOpen(), before, 'Tab remains usable without reopening the note');
    }
    async function expectReleased(file) {
      assert.deepEqual(await page.evaluate(() => ({ path: T.state.current?.path, opening: T.state.openingPath,
        switching: document.querySelector('.note-workspace').classList.contains('note-document-switch-pending'),
        inert: document.querySelector('[data-role="note-editor"]').inert })),
      { path: file, opening: '', switching: false, inert: false });
      assert.equal(await page.locator('[data-role="note-current-path"] .is-file').innerText(), file, 'breadcrumb returns to the displayed note');
      assert.equal(await tree.locator('.note-tree-row.active').getAttribute('data-note-path'), file);
    }
    async function holdNext(pattern, failure) {
      let release;
      const gate = new Promise(resolve => { release = resolve; }), received = page.waitForRequest(pattern);
      received.catch(() => {});
      let held = false;
      const handler = async route => {
        if (held) { await route.continue(); return; }
        held = true; await gate;
        if (failure) await route.fulfill({ status: 503, json: { error: 'Isolated request failure' } });
        else await route.continue();
      };
      await page.route(pattern, handler);
      return { received, async release() { release(); await page.unroute(pattern, handler); } };
    }

    // A real canvas draft must survive rejected file switches; Tab needs no restart.
    await page.route('**/api/notes-canvas/save', route => route.fulfill({ status: 507, json: { error: 'Isolated save failure' } }));
    const viewport = page.locator('.note-canvas-viewport');
    await viewport.dblclick({ position: { x: 160, y: 95 } });
    await viewport.locator('textarea').fill('未保存的画布草稿');
    await viewport.locator('textarea').press('Control+Enter');
    for (let i = 0; i < 2; i++) {
      assert.equal(await completed(await startFile('B.md')), false);
      await expectReleased('A.md'); await expectTabWorks();
      assert.equal(await page.evaluate(() => RelatumNoteCanvas.dirty), true);
      assert.equal(await viewport.locator('.note-canvas-text').innerText(), '未保存的画布草稿');
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'A.md'), 'utf8'), original);
    }
    await page.unroute('**/api/notes-canvas/save');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.flushSave()), true);
    await expectReleased('A.md'); await expectTabWorks();
    assert.equal(await completed(await startFile('B.md')), true);
    await expectReleased('B.md');
    assert.equal(await completed(await startFile('A.md')), true);

    // Exceptions during preparation also release the tree's primed state.
    await page.waitForFunction(() => document.querySelector('.is-canvas .note-live-image-frame')?.__noteCanvas?.engine);
    await page.evaluate(() => {
      const adapter = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas, settle = adapter.settle;
      adapter.settle = () => { adapter.settle = settle; throw new Error('Isolated preparation exception'); };
    });
    assert.equal(await completed(await startFile('B.md')), false);
    await expectReleased('A.md'); await expectTabWorks();

    // An older failure cannot release a newer open waiting for its own save.
    await page.evaluate(() => {
      const session = document.querySelector('.is-canvas .note-live-image-frame').__noteCanvas.session;
      session.change({}, data => { data.nodes[0].text = '连续切换草稿'; }, { nodes: [session.data.nodes[0].id] });
      clearTimeout(session.timer); session.timer = 0;
    });
    const failedSave = await holdNext('**/api/notes-canvas/save', true);
    const oldPreparation = await startFile('B.md'); await failedSave.received;
    const nextSave = await holdNext('**/api/notes-canvas/save');
    const newPreparation = await startFile('C.md');
    await failedSave.release(); await nextSave.received;
    assert.equal(await completed(oldPreparation), false);
    assert.equal(await page.evaluate(() => T.state.openingPath), 'C.md', 'older preparation cannot clear the latest tree feedback');
    await tree.focus(); const beforePendingTab = await sideOpen(); await page.keyboard.press('Tab');
    assert.equal(await sideOpen(), beforePendingTab, 'Tab remains protected during the actual preparation');
    await nextSave.release(); assert.equal(await completed(newPreparation), true);
    await expectReleased('C.md'); await expectTabWorks();

    // Late reads, including failed reads, cannot replace or unlock the newer note.
    for (const [failOld, finishNewFirst] of [[true, false], [false, false], [true, true], [false, true]]) {
      await page.evaluate(() => { T.state.documentCache.delete('A.md'); T.state.documentCache.delete('B.md'); });
      const oldRead = await holdNext('**/api/note?path=A.md', failOld);
      const oldOpen = await startFile('A.md'); await oldRead.received;
      const nextRead = await holdNext('**/api/note?path=B.md');
      const nextOpen = await startFile('B.md'); await nextRead.received;
      if (finishNewFirst) {
        await nextRead.release(); assert.equal(await completed(nextOpen), true);
        await oldRead.release(); assert.equal(await completed(oldOpen), false);
      } else {
        await oldRead.release(); assert.equal(await completed(oldOpen), false);
        assert.equal(await page.evaluate(() => T.state.openingPath), 'B.md');
        assert.equal(await page.locator('.note-workspace').evaluate(el => el.classList.contains('note-document-switch-pending')), true);
        await nextRead.release(); assert.equal(await completed(nextOpen), true);
      }
      await expectReleased('B.md'); await expectTabWorks();
      assert.equal(await completed(await startFile('C.md')), true);
    }
    const failedRead = await holdNext('**/api/note?path=A.md', true);
    const failedOpen = await startFile('A.md'); await failedRead.received; await failedRead.release();
    assert.equal(await completed(failedOpen), false);
    await expectReleased('C.md'); await expectTabWorks();
    fs.unlinkSync(path.join(root, 'notes', 'A.md'));
    await page.evaluate(() => T.state.documentCache.delete('A.md'));
    assert.equal(await completed(await startFile('A.md')), false, 'a file removed externally cannot leave the editor locked');
    await expectReleased('C.md'); await expectTabWorks();

    // The fix must still leave the real editor's Tab behavior intact.
    await page.evaluate(() => T.editor.focus());
    const beforeEditorTab = await sideOpen(); await page.keyboard.press('Tab');
    assert.equal(await sideOpen(), beforeEditorTab);
    assert((await page.evaluate(() => T.editor.snapshot().value)).includes('\t'), 'focused Markdown keeps its native indentation command');
    await page.keyboard.press('Control+z'); await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'note open state and Tab recovery: ok', fixtures: root }));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Cross-tree folder drops use the real UI/API and disposable notes only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const native = process.argv.includes('--webview2');
const repo = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-notebook-drop-'));
const notes = path.join(dataRoot, 'notes');
const sourceBook = 'CustomNotebook/源本', targetBook = 'CustomNotebook/目标本';
const topic = '戴维宁定理', originalNote = `${sourceBook}/${topic}/小节/正文.md`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function write(relative, value) {
  const target = path.join(notes, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
}
write('Keep.md', '# 保留正文\nkeep content\n');
write('Index.md', `[[${originalNote.slice(0, -3)}]]`);
write(originalNote, '# 定理\n#迁移\n' + '测试段落\n\n'.repeat(160) + '\n![diagram](正文.assets/images/diagram.png)\n');
write(`${sourceBook}/${topic}/小节/正文.assets/images/diagram.png`, png);
for (const name of ['空目录', '冲突', 'CaseFolder', '服务失败', '保存失败', '迟到', '失败迟到', '隐藏前', '保存时隐藏', '目标消失', 'zz移动']) {
  fs.mkdirSync(path.join(notes, sourceBook, name), { recursive: true });
}
write(`${sourceBook}/冲突/Keep.md`, 'source conflict');
write(`${targetBook}/冲突/Keep.md`, 'target conflict');
fs.mkdirSync(path.join(notes, targetBook, 'casefolder'));
for (let i = 0; i < 225; i++) fs.mkdirSync(path.join(notes, targetBook, 'A' + String(i).padStart(3, '0')));
fs.mkdirSync(path.join(notes, 'CustomNotebook/消失本'));
fs.mkdirSync(path.join(notes, 'Parent/Sub'), { recursive: true });

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await pause(100); }
  throw new Error(message);
}

(async () => {
  const port = await freePort(), debug = native ? await freePort() : 0;
  let url = `http://127.0.0.1:${port}`;
  const python = native ? process.env.RELATUM_WEBVIEW_PYTHON : process.env.RELATUM_PYTHON || 'python';
  assert(python, 'Configure RELATUM_WEBVIEW_PYTHON for native acceptance');
  const server = spawn(python, ['-B', native ? 'desktop.py' : 'app.py', ...(!native ? ['--no-browser', '--port', String(port)] : [])], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot,
      ...(native ? { LOCALAPPDATA: dataRoot, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '', browser, page;
  const failures = [];
  const log = chunk => { diagnostics = (diagnostics + chunk).slice(-16000); };
  server.stdout.on('data', log); server.stderr.on('data', log);
  try {
    await waitFor(async () => { try { return (await fetch(native ? `http://127.0.0.1:${debug}/json/version` : url + '/api/runtime')).ok; } catch { return false; } }, 'isolated host did not start');
    if (native) {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + debug);
      await waitFor(() => { page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:')); return !!page; }, 'native page did not start');
      url = new URL(page.url()).origin;
      await page.setViewportSize({ width: 1600, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    } else {
      browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
      page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    }
    page.on('response', async response => { if (!response.ok() && response.url().includes('/api/note-')) failures.push([response.status(), response.url(), await response.text().catch(() => '')]); });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let script = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    script = script.replace('  window.CanvasNoteWorkspace = {',
      '  window.__dropTest = {state, get editor() { return liveEditor; }, openNote, flushSave, triggerExternalSync, treeRowIndexes, isBusy: () => !!(noteMovePromise || notebookDropRunning)};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    let moveRequests = 0, importRequests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/note-move') moveRequests++;
      if (new URL(request.url()).pathname === '/api/note-import-begin') importRequests++;
    });
    const left = '[data-role="note-tree"]', right = '[data-role="note-notebook-tree"]';
    const row = (host, value) => page.locator(`${host} .note-tree-row[data-note-path="${value}"]`);
    const rootRow = value => page.locator(`${right} > .note-notebook-root > .note-tree-row[data-note-path="${value}"]`);
    const idle = () => page.waitForFunction(() => !__dropTest.isBusy());
    const open = async value => {
      assert(await page.evaluate(value => __dropTest.openNote(value), value), 'note should open: ' + value);
      await page.waitForFunction(value => CanvasNoteWorkspace.currentPath === value
        && __dropTest.editor.snapshot().value === __dropTest.state.current.content, value);
    };
    const sync = () => page.evaluate(() => __dropTest.triggerExternalSync({ silentErrors: true }));
    async function choose(value) { await rootRow(value).click(); await page.waitForFunction(value => __dropTest.state.notebookRoot === value, value); }
    async function drag(source, target) { await row(left, source).dragTo(rootRow(target)); await idle(); }
    async function beginDrag(source, target, host = right) {
      return page.evaluate(({ source, target, host }) => {
        const src = document.querySelector(`[data-role="note-tree"] .note-tree-row[data-note-path="${source}"]`);
        const dest = document.querySelector(`${host} .note-tree-row[data-note-path="${target}"]`);
        window.__dragSource = src; window.__dragTransfer = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: __dragTransfer }));
        const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: __dragTransfer });
        dest.dispatchEvent(event); return { accepted: event.defaultPrevented, highlighted: dest.classList.contains('note-drop-target') };
      }, { source, target, host });
    }
    async function drop(target, host = right) {
      await page.evaluate(({ target, host }) => {
        document.querySelector(`${host} .note-tree-row[data-note-path="${target}"]`)
          .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: __dragTransfer }));
        __dragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: __dragTransfer }));
      }, { target, host });
    }
    async function cleanDrag() {
      assert.deepEqual(await page.evaluate(() => [__dropTest.state.draggedPath,
        document.querySelectorAll('.note-drop-target, .note-drop-root, .note-tree-row.dragging').length]), ['', 0]);
    }
    async function indexes() {
      assert.deepEqual(await page.evaluate(() => {
        const issues = [];
        __dropTest.treeRowIndexes.forEach((index, host) => {
          if (index.rows.size !== host.querySelectorAll('.note-tree-row').length) issues.push('row count');
          for (const [key, row] of index.rows) if (!host.contains(row) || row.dataset.notePath !== key) issues.push('stale row');
        }); return issues;
      }), []);
    }
    async function delayedMove(source, target, during, fail = false) {
      let release, received = false;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/note-move', async route => {
        received = true; await gate;
        if (fail) await route.fulfill({ status: 500, json: { error: 'delayed move failure' } });
        else await route.continue();
      });
      try {
        await beginDrag(source, target); await drop(target);
        await waitFor(() => received, 'move request did not arrive'); await during();
      } finally { release(); }
      await idle(); await page.unroute('**/api/note-move');
    }

    await page.goto(url + (native ? '/?desktop=1' : '/')); await page.waitForFunction(() => window.CanvasNoteWorkspace);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__dropTest?.state.initialized && __dropTest.state.active
      && !document.querySelector('[data-start-workspace-panel="notes"]').classList.contains('workspace-entering'));
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await rootRow(sourceBook).waitFor();
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('#note-sort-menu [data-note-sort-mode="name-asc"]').click();
    await sync();
    await open(originalNote);
    assert.equal(await rootRow(targetBook).getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      const editor = __dropTest.editor;
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '\nunsaved move marker\n' }, selection: { anchor: 20, head: 25 } });
      editor.view.scrollDOM.scrollTop = 300; window.__retainedEditor = editor.view;
    });
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => { const s = __dropTest.editor.snapshot(); return [s.anchor, s.head, s.scrollTop, __dropTest.state.viewMode]; });
    await drag(`${sourceBook}/${topic}`, targetBook);
    const movedNote = `${targetBook}/${topic}/小节/正文.md`;
    await page.waitForFunction(value => CanvasNoteWorkspace.currentPath === value && __dropTest.state.notebookRoot === value.split('/').slice(0, 2).join('/'), movedNote);
    assert.equal(await row(left, `${targetBook}/${topic}`).evaluate(el => el.classList.contains('selected-folder')), true);
    assert.equal(await page.evaluate(() => __dropTest.editor.view === __retainedEditor), true);
    const after = await page.evaluate(() => { const s = __dropTest.editor.snapshot(); return [s.anchor, s.head, s.scrollTop, __dropTest.state.viewMode]; });
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2)); assert(Math.abs(after[2] - before[2]) < 2); assert.equal(after[3], before[3]);
    assert(fs.readFileSync(path.join(notes, movedNote), 'utf8').includes('unsaved move marker'));
    assert(!fs.existsSync(path.join(notes, sourceBook, topic)));
    assert(fs.readFileSync(path.join(notes, 'Index.md'), 'utf8').includes(movedNote.slice(0, -3)));
    assert.deepEqual(fs.readFileSync(path.join(notes, targetBook, topic, '小节/正文.assets/images/diagram.png')), png);
    assert.equal(await rootRow(targetBook).getAttribute('aria-expanded'), 'false', 'drop does not expand the right tree');
    await cleanDrag(); await indexes();

    for (const folder of ['冲突', 'CaseFolder']) {
      await choose(sourceBook); const count = moveRequests;
      await drag(`${sourceBook}/${folder}`, targetBook);
      assert.equal(moveRequests, count + 1, 'backend remains authoritative for collisions');
      assert.equal(await page.locator('[data-role="note-toast"]').textContent(), '目标笔记本有重名文件夹');
      assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), sourceBook);
      assert(fs.existsSync(path.join(notes, sourceBook, folder))); await indexes();
    }
    assert.equal(fs.readFileSync(path.join(notes, targetBook, '冲突/Keep.md'), 'utf8'), 'target conflict');
    assert.equal(fs.readFileSync(path.join(notes, sourceBook, '冲突/Keep.md'), 'utf8'), 'source conflict');

    await choose(sourceBook); await open('Keep.md'); await choose(sourceBook);
    await drag(`${sourceBook}/zz移动`, targetBook);
    await sync();
    assert.equal(await row(left, `${targetBook}/zz移动`).count(), 1, 'selected folder survives first-page refresh and virtualization');
    assert.equal(await row(left, `${targetBook}/zz移动`).isVisible(), true);
    await indexes();

    await choose(sourceBook); await drag(`${sourceBook}/空目录`, '');
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), '');
    assert(fs.existsSync(path.join(notes, '空目录')));
    const beforeNoop = moveRequests; await drag('空目录', ''); assert.equal(moveRequests, beforeNoop);
    await drag('空目录', targetBook); assert(fs.existsSync(path.join(notes, targetBook, '空目录')));

    await choose(sourceBook);
    const hoverCount = moveRequests;
    assert.deepEqual(await beginDrag(`${sourceBook}/服务失败`, targetBook), { accepted: true, highlighted: true });
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), sourceBook, 'hover never switches notebooks');
    assert.equal(moveRequests, hoverCount);
    await page.evaluate(() => __dragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await cleanDrag();
    for (const lifecycle of ['blur', 'minimize', 'pagehide']) {
      await beginDrag(`${sourceBook}/服务失败`, targetBook);
      await page.evaluate(lifecycle => {
        if (lifecycle === 'minimize') { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
        else window.dispatchEvent(new Event(lifecycle));
      }, lifecycle);
      await cleanDrag();
      await page.evaluate(lifecycle => {
        if (lifecycle === 'minimize') { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
        else if (lifecycle === 'pagehide') window.dispatchEvent(new Event('pageshow'));
      }, lifecycle);
    }
    assert.equal(moveRequests, hoverCount);
    await choose('');
    assert.equal((await beginDrag('Keep.md', targetBook)).accepted, false, 'individual notes are outside the new drop scope');
    await page.evaluate(() => __dragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    const importsBefore = importRequests;
    await rootRow(targetBook).evaluate(el => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['external'], 'External.md', { type: 'text/markdown' }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assert.equal(importRequests, importsBefore, 'right notebook roots do not import Explorer files');
    await choose(sourceBook);
    await rootRow(sourceBook).locator('.note-tree-toggle').click();
    assert.equal((await beginDrag(`${sourceBook}/服务失败`, `${sourceBook}/冲突`)).accepted, false, 'right subfolders are outside the new drop scope');
    await page.evaluate(() => __dragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await rootRow(sourceBook).locator('.note-tree-toggle').click();

    await choose(sourceBook);
    await page.route('**/api/note-move', route => route.fulfill({ status: 500, json: { error: 'simulated move failure' } }));
    await drag(`${sourceBook}/服务失败`, targetBook); await page.unroute('**/api/note-move');
    assert(fs.existsSync(path.join(notes, sourceBook, '服务失败'))); assert(!fs.existsSync(path.join(notes, targetBook, '服务失败')));
    assert.equal(await row(left, `${sourceBook}/服务失败`).count(), 1); await indexes();
    assert.equal(await page.locator('[data-role="note-toast"]').textContent(), 'simulated move failure');

    await page.route('**/api/note-save', route => route.fulfill({ status: 500, json: { error: 'simulated save failure' } }));
    await page.evaluate(() => { const view = __dropTest.editor.view; view.dispatch({ changes: { from: view.state.doc.length, insert: '\nsave gate marker' } }); });
    const countBeforeSaveFailure = moveRequests;
    await drag(`${sourceBook}/保存失败`, targetBook);
    assert.equal(moveRequests, countBeforeSaveFailure); assert(fs.existsSync(path.join(notes, sourceBook, '保存失败')));
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), sourceBook);
    await page.unroute('**/api/note-save'); await page.evaluate(() => __dropTest.flushSave());

    await beginDrag(`${sourceBook}/目标消失`, 'CustomNotebook/消失本');
    fs.renameSync(path.join(notes, 'CustomNotebook/消失本'), path.join(dataRoot, 'removed-target'));
    await drop('CustomNotebook/消失本'); await idle();
    assert(fs.existsSync(path.join(notes, sourceBook, '目标消失'))); await indexes();

    await delayedMove(`${sourceBook}/迟到`, targetBook, async () => { await choose(''); await row(left, 'Keep.md').click(); });
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Keep.md');
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), '');
    assert(fs.existsSync(path.join(notes, targetBook, '迟到')));
    await choose(sourceBook);
    await delayedMove(`${sourceBook}/失败迟到`, targetBook, () => choose(''), true);
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), '', 'rollback preserves a later notebook selection');
    assert(fs.existsSync(path.join(notes, sourceBook, '失败迟到')));
    await choose(sourceBook);
    await delayedMove(`${sourceBook}/隐藏前`, targetBook, () => page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility'));
    }));
    assert(fs.existsSync(path.join(notes, targetBook, '隐藏前')));
    assert.equal(await page.evaluate(() => __dropTest.state.notebookRoot), sourceBook);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });

    let releaseSave, saving = false;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/api/note-save', async route => { saving = true; await saveGate; await route.continue(); });
    await page.evaluate(() => { const view = __dropTest.editor.view; view.dispatch({ changes: { from: view.state.doc.length, insert: '\ncancel before move' } }); });
    const countBeforeHiddenSave = moveRequests;
    await beginDrag(`${sourceBook}/保存时隐藏`, targetBook); await drop(targetBook);
    await waitFor(() => saving, 'save request did not arrive');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    releaseSave(); await idle(); await page.unroute('**/api/note-save');
    assert.equal(moveRequests, countBeforeHiddenSave, 'hiding before the move request cancels the drop after saving');
    assert(fs.existsSync(path.join(notes, sourceBook, '保存时隐藏')));
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });

    await choose(''); await row(left, 'Parent').click();
    await drag('Parent/Sub', ''); assert(fs.existsSync(path.join(notes, 'Sub')));
    await waitFor(async () => (await (await fetch(url + '/api/note-index-state')).json()).phase === 'ready', 'index did not settle for the existing left-tree move');
    await row(left, 'Sub').dragTo(row(left, 'Parent')); await idle();
    assert(fs.existsSync(path.join(notes, 'Parent/Sub')), 'left-tree moves retain their existing behavior');
    await page.locator(left).evaluate(el => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['external import'], 'External.md', { type: 'text/markdown' }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitFor(() => fs.existsSync(path.join(notes, 'External.md')), 'left-tree Explorer import failed');
    await page.waitForFunction(() => !__dropTest.state.importRunning);
    await choose(sourceBook);
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await page.setViewportSize({ width: 920, height: 800 });
    await drag(`${sourceBook}/CaseFolder`, targetBook);
    assert.equal(await page.locator('[data-role="note-toast"]').textContent(), 'The target notebook already has a folder with this name');
    await cleanDrag(); await indexes();
    assert.deepEqual(errors, []);
    if (process.env.RELATUM_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, 'notebook-folder-drop.png') });
    }
    console.log('note notebook folder drop ' + (native ? 'WebView2' : 'Edge') + ': ok');
  } catch (error) {
    console.error(diagnostics); console.error(JSON.stringify(failures));
    if (page) console.error(await page.locator('[data-role="note-toast"]').textContent().catch(() => ''));
    throw error;
  }
  finally {
    if (native) await page?.evaluate(() => pywebview.api.close_window()).catch(() => {});
    if (native && server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(4000)]);
    if (browser) await browser.close(); if (server.exitCode === null) server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    assert(path.basename(dataRoot).startsWith('relatum-notebook-drop-'));
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

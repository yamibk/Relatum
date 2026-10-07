'use strict';

// Host-provided Playwright/Edge. All documents and saved notes are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-table-'));
const sample = '前文\n\n| Alpha | Beta |\n| --- | --- |\n| one | two |\n| three | four |\n\n## 表后代码\n\n```js\nconst stable = 1;\n```\n\n后文';
const empty = '|  |  |\n| --- | --- |\n|  |  |\n|  |  |';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style>
</head><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
<script src="markdown.js"></script><script src="markdown-table.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script>
<script src="note-table-editor.js"></script><script src="note-live-editor.js"></script><script>
window.changes=0;window.saves=0;window.menus=0;window.images=0;
window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(sample)},notePath:'table.md',onDocChanged(){changes++},onSaveRequest(){saves++},onContextMenu(){menus++},onImageFiles(){images++},imageUrl(){return ''}});
</script></body></html>`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (!pathname.startsWith('/assets/')) { res.writeHead(404).end(); return; }
    const filename = path.resolve(repo, '.' + pathname);
    if (!filename.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, service;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.editor && document.querySelector('.note-live-rich-block.is-table table'));
    await page.evaluate(() => {
      window.__tableFocusEvents = [];
      for (const name of ['focusin', 'focusout']) document.addEventListener(name, event => {
        __tableFocusEvents.push(name + ':' + event.target.className);
        if (__tableFocusEvents.length > 16) __tableFocusEvents.shift();
      }, true);
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const table = page.locator('.note-live-rich-block.is-table').first();
    const input = page.locator('textarea.note-table-cell-editor');
    const cell = (row, col) => table.locator(`td[data-table-row="${row}"][data-table-col="${col}"]`);
    const snapshot = () => page.evaluate(() => editor.snapshot().value);
    const rows = () => page.evaluate(() => { const model = MarkdownTable.findTables(editor.snapshot().value)[0]?.model; return model ? [model.header, ...model.rows] : []; });
    async function reset(value = sample) {
      await page.evaluate(value => editor.setDocument({ value, notePath: 'table.md', anchor: value.length, head: value.length, scrollTop: 0 }), value);
      await settle();
      await table.waitFor({ state: 'visible' });
    }
    async function edit(row, col, text) {
      await cell(row, col).click();
      try { await input.fill(text); }
      catch (error) {
        console.error({ errors, diagnostics: await page.evaluate(() => {
          const state = editor.snapshot();
          return { active: document.activeElement?.outerHTML.slice(0, 300), focusEvents: __tableFocusEvents,
            selection: { length: state.value.length, prefix: state.value.slice(0, 160), anchor: state.anchor, head: state.head },
            table: document.querySelector('.note-live-rich-block.is-table')?.outerHTML.slice(0, 300) };
        }) });
        throw error;
      }
      await settle();
    }
    async function exitCell() { if (await input.count()) await input.press('Escape'); await settle(); }
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    async function drag(from, to) {
      const first = await from.boundingBox(), last = await to.boundingBox();
      assert(first && last, 'table handles must have pointer geometry');
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    async function edgeInsert(kind) {
      const rect = await table.locator('table').boundingBox();
      if (kind === 'row') {
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height + 1);
      } else {
        await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2);
      }
      await table.locator('.note-table-control:visible').click(); await settle();
    }
    async function selectGrip(kind, index) {
      const target = await cell(kind === 'row' ? index : 0, kind === 'row' ? 0 : index).boundingBox();
      await page.mouse.move(kind === 'row' ? target.x + 1 : target.x + target.width / 2, kind === 'row' ? target.y + target.height / 2 : target.y + 1);
      await table.locator('.note-table-grip:visible').click(); await settle();
    }
    async function dragCells(r0, c0, r1, c1) {
      const a = await cell(r0, c0).boundingBox(), b = await cell(r1, c1).boundingBox();
      await page.mouse.move(a.x + a.width - 18, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width - 18, b.y + b.height / 2, { steps: 8 }); await page.mouse.up(); await settle();
    }

    // All visible rows are data: no semantic or visual header treatment.
    await page.evaluate(() => {
      editor.setDocument({ value: '插入位置', notePath: 'table.md', anchor: 4, head: 4 });
      editor.executeCommand('insert:table');
    });
    await settle();
    assert.deepEqual(await rows(), [['', ''], ['', ''], ['', '']], 'the insertion command creates only empty data cells');
    await reset();
    assert.equal(await table.locator('th').count(), 0, 'live tables must have no header cells');
    assert.equal(await table.locator('td[data-table-row][data-table-col]').count(), 6);
    const equalRows = await page.evaluate(() => {
      const cells = [document.querySelector('td[data-table-row="0"][data-table-col="0"]'), document.querySelector('td[data-table-row="1"][data-table-col="0"]')];
      return cells.map(item => ({ fontWeight: getComputedStyle(item).fontWeight, background: getComputedStyle(item).backgroundColor }));
    });
    assert.deepEqual(equalRows[0], equalRows[1], 'first visible row has the same treatment as other rows');
    await edit(1, 0, '直接输入');
    assert.equal((await rows())[1][0], '直接输入');
    assert.equal(await table.count(), 1, 'clicking and typing must retain the rendered table');
    await input.press('Control+a');
    await input.press('Backspace');
    assert.equal((await rows())[1][0], '');
    assert((await snapshot()).startsWith('前文\n\n'), 'native textarea select-all/delete cannot replace the note');
    await input.press('Control+s');
    assert.equal(await page.evaluate(() => saves), 1, 'save shortcut is forwarded from the active cell');
    assert.equal(await page.evaluate(() => menus + images), 0);

    // Native Chromium IME preedit must remain private and commit one undo unit.
    await edit(1, 0, '甲乙');
    await input.evaluate(area => area.setSelectionRange(1, 1));
    const beforeIme = await snapshot();
    const changesBeforeIme = await page.evaluate(() => changes);
    const cdp = await context.newCDPSession(page);
    for (const text of ['z', 'zh', 'zhong']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    assert.equal(await snapshot(), beforeIme, 'autosave snapshots must exclude provisional Pinyin');
    assert.equal(await page.evaluate(() => changes), changesBeforeIme, 'candidate input cannot publish document changes');
    assert.equal(await page.evaluate(() => editor.inputPending), true);
    assert.notEqual(await page.evaluate(() => editor.view.dom.parentElement.dataset.inputPhase), 'composing', 'table composition must not enter the body composition session');
    await cdp.send('Input.insertText', { text: '中' });
    await settle();
    assert.equal((await rows())[1][0], '甲中乙');
    assert.equal(await page.evaluate(() => editor.inputPending), false);
    assert.equal(await input.inputValue(), '甲中乙');
    await input.press('Control+z');
    await settle();
    assert.equal((await rows())[1][0], '甲乙', 'one undo removes one chosen candidate');
    await page.keyboard.press('Control+y');
    await settle();
    assert.equal((await rows())[1][0], '甲中乙');

    // Tab/Enter navigate cells while ordinary arrows and text selection stay native.
    await reset();
    await cell(0, 0).click();
    await input.press('Tab');
    assert.equal(await input.inputValue(), 'Beta');
    await input.press('Shift+Tab');
    assert.equal(await input.inputValue(), 'Alpha');
    await input.press('Enter');
    assert.equal(await input.inputValue(), 'one');
    await input.press('Home');
    await input.press('ArrowRight');
    assert.equal(await input.evaluate(area => area.selectionStart), 1);
    await exitCell();

    // Add/delete operations and selection all use data-row indices, including row 0.
    await edgeInsert('row');
    assert.equal((await rows()).length, 4);
    await page.keyboard.press('Control+z');
    await settle();
    assert.equal((await rows()).length, 3, 'one undo restores an added row');
    await edgeInsert('column');
    assert.equal((await rows())[0].length, 3);
    await page.keyboard.press('Control+z');
    await settle();
    assert.equal((await rows())[0].length, 2);
    await reset();
    await dragCells(0, 0, 1, 1);
    await page.keyboard.press('Control+c');
    assert.equal(await clipboard(), 'Alpha\tBeta\none\ttwo', 'dragged data rows copy as TSV');
    await page.keyboard.press('Delete');
    assert.deepEqual(await rows(), [['three', 'four']], 'Delete removes selected full rows including row 0');
    await page.keyboard.press('Control+z');
    await settle();
    assert.deepEqual(await rows(), [['Alpha', 'Beta'], ['one', 'two'], ['three', 'four']]);
    await dragCells(0, 0, 2, 1);
    await page.keyboard.press('Control+c');
    assert.equal(await clipboard(), 'Alpha\tBeta\none\ttwo\nthree\tfour', 'dragged columns copy every data row');
    await reset();
    await selectGrip('column', 1);
    await page.keyboard.press('Delete');
    assert.deepEqual(await rows(), [['Alpha'], ['one'], ['three']], 'Delete removes the selected column without affecting other cells');
    await reset();
    await selectGrip('row', 1);
    const beforeFailedCut = await snapshot();
    await table.evaluate(wrap => {
      const event = new Event('cut', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData() { throw new Error('clipboard denied'); } } });
      wrap.dispatchEvent(event);
    });
    assert.equal(await snapshot(), beforeFailedCut, 'a failed clipboard write cannot delete a selected row');
    await page.keyboard.press('Control+x');
    assert.equal(await clipboard(), 'one\ttwo');
    assert.deepEqual(await rows(), [['Alpha', 'Beta'], ['three', 'four']], 'cut copies selected data rows before removing them');
    await page.keyboard.press('Control+z');
    await settle();
    assert.deepEqual(await rows(), [['Alpha', 'Beta'], ['one', 'two'], ['three', 'four']]);

    // A partial Shift-click range clears cells while retaining other columns.
    await reset('| Alpha | Beta | kept |\n| --- | --- | --- |\n| one | two | kept |\n| three | four | kept |');
    await cell(0, 0).click();
    await cell(1, 1).click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+c');
    assert.equal(await clipboard(), 'Alpha\tBeta\none\ttwo');
    await page.keyboard.press('Delete');
    assert.deepEqual((await rows()).slice(0, 2), [['', '', 'kept'], ['', '', 'kept']]);
    assert.equal((await rows()).length, 3);
    assert.equal(await table.count(), 1);

    // Shift extension across all columns has the same row semantics as a drag.
    await reset();
    await cell(1, 1).click();
    await cell(0, 0).click({ modifiers: ['Shift'] });
    await page.keyboard.press('Delete'); await settle();
    assert.deepEqual(await rows(), [['three', 'four']]);
    await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await rows(), [['Alpha', 'Beta'], ['one', 'two'], ['three', 'four']]);

    // TSV grows a table from any current cell in one transaction and round-trips pipes.
    await reset(empty);
    await cell(0, 0).click();
    await page.evaluate(() => navigator.clipboard.writeText('甲\t乙\t丙\n丁\t戊\t己'));
    await page.keyboard.press('Control+v');
    await settle();
    assert.deepEqual((await rows()).slice(0, 2), [['甲', '乙', '丙'], ['丁', '戊', '己']]);
    await page.keyboard.press('Control+z');
    await settle();
    assert.deepEqual(await rows(), [['', ''], ['', ''], ['', '']], 'one undo restores a rectangular paste');
    await page.keyboard.press('Delete');
    await settle();
    assert.deepEqual(await rows(), [['', ''], ['', ''], ['', '']], 'Delete after paste expansion and undo cannot address stale columns');
    await reset();
    await edit(1, 0, 'A | B');
    assert.equal((await rows())[1][0], 'A | B', 'typed literal pipes must stay within their cell');
    assert((await snapshot()).includes('A \\| B'));
    await exitCell();
    const withPipe = await snapshot();
    await page.evaluate(() => { editor.setSourceMode(true); editor.setSourceMode(false); });
    await settle();
    assert.equal(await snapshot(), withPipe);
    assert.equal(await table.count(), 1);
    assert.equal(await page.locator('.cm-line.note-live-code-line').count(), 3, 'table editing retains neighbouring code geometry and highlighting');
    await reset('| `a|b` | C |\n| --- | --- |\n| D | E |');
    assert.deepEqual(await rows(), [['`a|b`', 'C'], ['D', 'E']], 'code pipes use the shared table parser');
    await reset('Foo [ | Beta\n--- | ---\nOne | Two');
    assert.deepEqual(await rows(), [['Foo [', 'Beta'], ['One', 'Two']], 'imported tables without outer pipes retain incomplete inline input');
    await edit(0, 0, 'Foo [中文');
    assert.equal((await rows())[0][1], 'Beta', 'editing an imported partial cell cannot consume its neighbour');
    await edit(0, 0, '# 13');
    await exitCell();
    assert.equal(await cell(0, 0).innerText(), '# 13', 'a heading marker inside a data cell stays literal');
    assert.equal(await cell(0, 0).locator('h1,h2,h3,h4,h5,h6').count(), 0);
    await edit(0, 1, '$x^2$');
    await exitCell();
    await cell(0, 1).locator('mjx-container').waitFor({ state: 'visible' });
    assert.equal((await rows())[0][1], '$x^2$', 'inline formula rendering cannot rewrite its Markdown source');
    for (const marker of ['[', '(', '`', '$', '{']) {
      for (const [row, col] of [[0, 0], [2, 1]]) {
        await reset();
        await cell(row, col).click();
        await input.fill('');
        await page.keyboard.type(marker);
        const afterOpening = await rows();
        assert.equal(afterOpening[row][col], marker, 'an unmatched opening marker stays in its own data cell');
        assert.equal(afterOpening[0][1], 'Beta');
        assert.equal(afterOpening[2][0], 'three');
        await page.keyboard.type('字|值');
        const afterTyping = await rows();
        assert.equal(afterTyping[row][col], marker + '字|值');
        assert.equal(afterTyping[0][1], 'Beta', 'progressive first/last cell syntax cannot swallow its neighbour');
        assert.equal(afterTyping[2][0], 'three');
        assert.equal(afterTyping.length, 3);
        assert(afterTyping.every(row => row.length === 2));
        assert.equal(await table.count(), 1, 'unclosed syntax cannot tear down the table projection');
      }
    }
    await reset('| first |\n| --- |\n| --- |');
    assert.deepEqual(await rows(), [['first'], ['---']], 'a single-column body containing only dashes remains a data row');
    assert.equal(await table.locator('td[data-table-row]').count(), 2);
    await edit(1, 0, '----');
    assert.deepEqual(await rows(), [['first'], ['----']]);
    await reset(empty);
    await cell(0, 0).click();
    const oversizedCell = '保'.repeat(270000);
    await input.fill(oversizedCell);
    await settle();
    assert.equal((await rows())[0][0], oversizedCell, 'a table exceeding the projection budget keeps its full committed text');

    // Fast composition handoffs and pending mode changes keep the native host alive.
    await reset();
    await cell(1, 0).click();
    await input.evaluate(area => area.setSelectionRange(area.value.length, area.value.length));
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    await page.evaluate(() => editor.setSourceMode(true));
    assert.equal(await input.count(), 1, 'mode switches cannot remove the native composition host');
    await cdp.send('Input.insertText', { text: '汉' });
    await settle();
    assert((await snapshot()).includes('one汉'));
    await page.waitForFunction(() => editor.view.dom.parentElement.classList.contains('is-source-mode'));
    await page.evaluate(() => editor.setSourceMode(false));
    await settle();
    await cell(1, 0).click();
    await cdp.send('Input.imeSetComposition', { text: 'zi', selectionStart: 2, selectionEnd: 2 });
    await cell(1, 1).click();
    await cdp.send('Input.insertText', { text: '字' });
    await settle();
    const afterHandoff = await rows();
    assert(afterHandoff[1][0].includes('字') && !afterHandoff[1][1].includes('字'), 'an old candidate cannot commit to the newly targeted cell');
    assert(!afterHandoff.flat().some(value => value.includes('zi')), 'preedit cannot survive a cell handoff: ' + JSON.stringify(afterHandoff));
    assert.equal(await input.inputValue(), 'two', 'the queued target cell opens after the old candidate settles');

    // A second table must not steal an in-flight candidate from the first host.
    await reset(empty + '\n\n两张表之间\n\n' + empty);
    await cell(0, 0).click();
    await cdp.send('Input.imeSetComposition', { text: 'er', selectionStart: 2, selectionEnd: 2 });
    const firstNativeHost = await input.elementHandle();
    const secondCell = page.locator('.note-live-rich-block.is-table').nth(1).locator('td[data-table-row="1"][data-table-col="1"]');
    await secondCell.click();
    assert.equal(await page.evaluate(() => editor.inputPending), true, 'targeting a second table cannot hide the first pending session');
    assert(await firstNativeHost.evaluate(area => area.isConnected), 'cross-table handoff retains the original native host');
    await cdp.send('Input.insertText', { text: '二' });
    await settle();
    const multiRows = await page.evaluate(() => MarkdownTable.findTables(editor.snapshot().value).map(table => [table.model.header, ...table.model.rows]));
    assert.equal(multiRows[0][0][0], '二');
    assert.equal(multiRows[1][1][1], '', 'the second table cannot receive the first table candidate');
    assert.equal(await page.evaluate(() => editor.inputPending), false);
    await page.waitForFunction(() => {
      const area = document.querySelector('textarea.note-table-cell-editor');
      return area?.parentElement.dataset.tableRow === '1' && area.parentElement.dataset.tableCol === '1'
        && area.closest('.note-live-rich-block.is-table') === document.querySelectorAll('.note-live-rich-block.is-table')[1];
    }, null, { timeout: 2000 });
    assert.equal(await input.evaluate(area => area.parentElement.dataset.tableRow + ':' + area.parentElement.dataset.tableCol), '1:1');

    // Virtualization must retain the only browser-owned IME host off screen.
    await reset(empty + '\n\n' + Array.from({ length: 900 }, (_, index) => '远处段落 ' + index + '\n').join('\n'));
    await cell(0, 0).click();
    await cdp.send('Input.imeSetComposition', { text: 'yuan', selectionStart: 4, selectionEnd: 4 });
    const scrollingNativeHost = await input.elementHandle();
    await page.evaluate(() => { editor.view.scrollDOM.scrollTop = editor.view.scrollDOM.scrollHeight; });
    await settle();
    const scrollingHostState = await scrollingNativeHost.evaluate(area => ({ connected: area.isConnected, value: area.value }));
    const scrollingEditorState = await page.evaluate(() => ({ pending: editor.inputPending, value: MarkdownTable.findTables(editor.snapshot().value)[0]?.model.header[0] }));
    assert(scrollingHostState.connected, 'scrolling cannot virtualize away an active composition textarea: ' + JSON.stringify({ scrollingHostState, scrollingEditorState }));
    assert.equal(await page.evaluate(() => editor.inputPending), true);
    await cdp.send('Input.insertText', { text: '远' });
    await settle();
    assert.equal((await rows())[0][0], '远', 'the off-screen candidate commits to its original table');
    assert.equal(await page.evaluate(() => editor.inputPending), false);
    await reset();

    await exitCell();
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.setViewportSize({ width: 560, height: 500 });
    await edit(0, 0, '窄窗中文');
    assert.equal((await rows())[0][0], '窄窗中文');
    const bounds = await input.boundingBox();
    assert(bounds && bounds.width > 0 && bounds.height > 0, 'the narrow dark-theme cell editor must remain measurable');
    await page.screenshot({ path: path.join(output, 'table-dark-narrow.png') });
    assert.deepEqual(errors, [], 'static table fixture browser errors');

    // The real workspace lazy loader, automatic save and note switches use isolated APIs.
    const dataRoot = path.join(output, 'vault');
    fs.mkdirSync(path.join(dataRoot, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'notes', 'Table.md'), empty);
    fs.writeFileSync(path.join(dataRoot, 'notes', 'Other.md'), '其他笔记原文');
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const workspaceOrigin = `http://127.0.0.1:${port}`;
    service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
      cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: dataRoot }, windowsHide: true, stdio: 'ignore',
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(workspaceOrigin + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await pause(100);
    }
    assert(ready, 'isolated Notes API must start');
    const workspace = await context.newPage();
    workspace.on('pageerror', error => errors.push(error.message));
    const workspaceSource = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__noteTableTest = {state, openNote, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    assert(workspaceSource.includes('window.__noteTableTest'), 'workspace test probe must attach');
    await workspace.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspaceSource }));
    await workspace.goto(workspaceOrigin);
    await workspace.locator('button[data-start-workspace="notes"]').click();
    await workspace.waitForFunction(() => window.__noteTableTest?.state.initialized && __noteTableTest.state.active && !__noteTableTest.state.openingPath);
    await workspace.evaluate(() => __noteTableTest.openNote('Table.md'));
    const workspaceCell = workspace.locator('td[data-table-row="0"][data-table-col="0"]');
    const workspaceInput = workspace.locator('textarea.note-table-cell-editor');
    await workspaceCell.click();
    await workspaceInput.fill('自动保存');
    for (let attempt = 0; attempt < 50 && !fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8').includes('自动保存'); attempt++) await pause(100);
    assert(fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8').includes('自动保存'), 'ordinary cell edits auto-save while the textarea stays focused');
    const workspaceCdp = await context.newCDPSession(workspace);
    await workspaceInput.evaluate(area => area.setSelectionRange(area.value.length, area.value.length));
    await workspaceCdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await workspace.evaluate(() => { window.__pendingTableSave = __noteTableTest.flushSave(); });
    await pause(450);
    assert(!fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8').includes('zhong'), 'autosave cannot persist cell preedit');
    await workspace.evaluate(() => { window.__pendingTableSwitch = __noteTableTest.openNote('Other.md'); });
    await workspaceCdp.send('Input.insertText', { text: '中' });
    await workspace.evaluate(async () => { await __pendingTableSave; await __pendingTableSwitch; });
    assert.equal(await workspace.evaluate(() => __noteTableTest.state.current.path), 'Other.md');
    assert(fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8').includes('自动保存中'), 'switching notes flushes the final table candidate to its own file');
    assert.equal(fs.readFileSync(path.join(dataRoot, 'notes', 'Other.md'), 'utf8'), '其他笔记原文');
    await workspace.evaluate(() => __noteTableTest.openNote('Table.md'));
    await workspace.waitForFunction(() => document.querySelector('td[data-table-row="0"][data-table-col="0"]')?.textContent.includes('自动保存中'));
    assert.equal(await workspace.locator('.note-live-rich-block.is-table th').count(), 0);
    const savedGrid = await workspace.evaluate(() => { const m = MarkdownTable.findTables(__noteTableTest.editor.snapshot().value)[0].model; return [m.header, ...m.rows]; });
    const bodyClick = await workspace.evaluate(() => { const t = document.querySelector('.note-table table').getBoundingClientRect(), c = __noteTableTest.editor.view.contentDOM.getBoundingClientRect(); return { x: c.left + 2, y: t.bottom + 50 }; });
    await workspace.mouse.click(bodyClick.x, bodyClick.y);
    const bodyPosition = await workspace.evaluate(() => { const v = __noteTableTest.editor.view; return { focus: v.hasFocus, line: v.state.doc.lineAt(v.state.selection.main.head).text, input: !!document.querySelector('.note-table-cell-editor') }; });
    assert(bodyPosition.focus && !bodyPosition.input); assert.equal(bodyPosition.line, '');
    await workspace.keyboard.type('123'); await workspaceCdp.send('Input.insertText', { text: '正文中文' });
    await workspace.evaluate(() => __noteTableTest.flushSave());
    const bodySaved = fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8');
    assert(bodySaved.endsWith('123正文中文'));
    assert.deepEqual(await workspace.evaluate(() => { const m = MarkdownTable.findTables(__noteTableTest.editor.snapshot().value)[0].model; return [m.header, ...m.rows]; }), savedGrid);
    await workspace.evaluate(() => __noteTableTest.openNote('Other.md'));
    await workspace.evaluate(() => __noteTableTest.openNote('Table.md'));
    assert.equal(await workspace.evaluate(() => __noteTableTest.editor.snapshot().value), bodySaved, 'post-table body content saves and reopens at the same source position');
    fs.writeFileSync(path.join(output, 'body-hit.json'), JSON.stringify({ bodyClick, bodyPosition, bodySaved, savedGrid }, null, 2));
    // Pointer capture must make the real file tree/tab bar safe drop regions,
    // without opening another note or redirecting the saved body caret.
    const reorderSaved = [];
    for (const kind of ['row', 'column']) {
      const target = workspace.locator('td[data-table-row="0"][data-table-col="0"]');
      const box = await target.boundingBox();
      await workspace.mouse.move(kind === 'row' ? box.x + 1 : box.x + box.width / 2, kind === 'row' ? box.y + box.height / 2 : box.y + 1);
      const handle = workspace.locator(`.note-table-grip[data-table-kind="${kind}"]`);
      await handle.waitFor({ state: 'visible' }); const start = await handle.boundingBox();
      const tableBox = await workspace.locator('.note-table table').boundingBox();
      const tabs = await workspace.locator('[data-role="note-tabs"]').boundingBox();
      const endpoint = kind === 'row' ? { x: 35, y: tableBox.y + tableBox.height + 30 }
        : { x: tableBox.x + tableBox.width - 2, y: tabs.y + tabs.height / 2 };
      const original = await workspace.evaluate(() => __noteTableTest.editor.snapshot().value);
      await workspace.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await workspace.mouse.down();
      await workspace.mouse.move(endpoint.x, endpoint.y, { steps: 8 });
      assert.equal(await workspace.evaluate(() => __noteTableTest.editor.snapshot().value), original, 'preview over workspace controls does not edit the note');
      assert.equal(await workspace.locator('.note-table-drop:visible').count(), 1);
      await workspace.mouse.up();
      await workspace.evaluate(() => __noteTableTest.flushSave());
      const saved = fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8');
      const expectedRows = kind === 'row' ? [savedGrid[1], savedGrid[2], savedGrid[0]]
        : [savedGrid[1], savedGrid[2], savedGrid[0]].map(row => [row[1], row[0]]);
      assert.equal(await workspace.evaluate(() => __noteTableTest.state.current.path), 'Table.md');
      assert.deepEqual(await workspace.evaluate(() => { const m = MarkdownTable.findTables(__noteTableTest.editor.snapshot().value)[0].model; return [m.header, ...m.rows]; }), expectedRows);
      assert(saved.endsWith('123正文中文')); assert.equal(fs.readFileSync(path.join(dataRoot, 'notes', 'Other.md'), 'utf8'), '其他笔记原文');
      assert.equal(saved, await workspace.evaluate(() => __noteTableTest.editor.snapshot().value));
      await workspace.evaluate(() => __noteTableTest.openNote('Other.md')); await workspace.evaluate(() => __noteTableTest.openNote('Table.md'));
      assert.equal(saved, await workspace.evaluate(() => __noteTableTest.editor.snapshot().value), 'reordered Markdown saves and reopens unchanged');
      reorderSaved.push({ kind, endpoint, saved });
    }
    const afterReorderLine = await workspace.locator('.cm-line').filter({ hasText: /^123正文中文$/ }).boundingBox();
    await workspace.mouse.click(afterReorderLine.x + 1, afterReorderLine.y + afterReorderLine.height / 2);
    const afterReorderFocus = await workspace.evaluate(() => { const v = __noteTableTest.editor.view; return { head: v.state.selection.main.head, line: v.state.doc.lineAt(v.state.selection.main.head).text, focus: v.hasFocus, active: document.activeElement.className }; });
    assert(afterReorderFocus.focus); assert.equal(afterReorderFocus.line, '123正文中文');
    await workspaceCdp.send('Input.insertText', { text: '重排后' }); await workspace.evaluate(() => __noteTableTest.flushSave());
    assert(fs.readFileSync(path.join(dataRoot, 'notes', 'Table.md'), 'utf8').endsWith('重排后123正文中文'));
    fs.writeFileSync(path.join(output, 'grip-save.json'), JSON.stringify({ reorderSaved, afterReorderFocus }, null, 2));
    await workspace.screenshot({ path: path.join(output, 'table-workspace.png') });
    assert.deepEqual(errors, [], 'table fixture and workspace must not produce browser errors');
    console.log(JSON.stringify({ output, ime: true, undo: true, dataRows: true, selection: true, paste: true, isolatedSave: true }));
  } finally {
    if (browser) await browser.close();
    if (service) service.kill();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Local assets, real clipboard/input, and disposable browser state only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-table-editing-'));
const grid = '| **A** | B | C |\n| :--- | :---: | ---: |\n| D | E | F |\n| G | H | I |';
const html = skin => `<!doctype html><html lang="zh-CN" data-note-theme="${skin}"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css">
<style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style></head>
<body class="start-page" data-start-theme="light"><main class="note-workspace note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
${['markdown.js','markdown-table.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-live-editor.js'].map(name => `<script src="${name}"></script>`).join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'',notePath:'editing.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(url.searchParams.get('skin') || 'default')); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [], matrix = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const value = () => page.evaluate(() => editor.snapshot().value);
    const cell = (r, c) => page.locator(`td[data-table-row="${r}"][data-table-col="${c}"]`).first();
    const input = page.locator('.note-table-cell-editor');
    async function reset(source, head = 0, anchor = head) {
      await page.evaluate(({ source, head, anchor }) => {
        editor.setSourceMode(false); editor.setDocument({ value: source, notePath: 'editing.md', head, anchor, scrollTop: 0 }); editor.focus();
      }, { source, head, anchor }); await settle();
    }
    async function checkCell(row, col, position) {
      const state = await input.evaluate(node => ({ row: Number(node.closest('td').dataset.tableRow), col: Number(node.closest('td').dataset.tableCol),
        head: node.__noteCellInput.selectionEnd, length: node.__noteCellInput.value.length, focused: document.activeElement === node }));
      assert.equal(state.row, row); assert.equal(state.col, col); assert(state.focused);
      assert.equal(state.head, position === 'end' ? state.length : position);
    }
    async function select(kind, index) {
      if (kind === 'table') {
        await page.locator('.note-table').first().focus(); await page.keyboard.press('Control+a'); return;
      }
      await page.locator('.note-table').first().evaluate((node, { kind, index }) => node.__noteTableSurface.select(kind, index, false), { kind, index });
    }
    for (const skin of ['default', 'claude', 'sky', 'apple']) {
      await page.goto(origin + '/?skin=' + skin); await page.waitForFunction(() => window.editor); await page.evaluate(() => document.fonts.ready);
      for (const [theme, width, scale] of [['light', 1400, 1], ['dark', 620, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
        for (const blanks of [0, 1, 2]) {
          const source = 'before\n' + '\n'.repeat(blanks) + grid + '\n' + '\n'.repeat(blanks) + 'after';
          await reset(source);
          const layout = await page.evaluate(() => {
            const content = editor.view.contentDOM, table = content.querySelector('.note-table'), style = getComputedStyle(table);
            return { blanks: [...content.children].filter(node => node.matches('.cm-line') && !node.textContent).length,
              padding: [style.paddingTop, style.paddingBottom] };
          });
          assert.equal(layout.blanks, blanks * 2, 'only real blank lines may occupy layout'); assert.deepEqual(layout.padding, ['4px', '4px']);
          assert.equal(await value(), source, 'loading cannot rewrite whitespace');
          // Approach the bottom edge first: its add strip must not cover the following paragraph/blank.
          const table = await page.locator('.note-table table').boundingBox();
          await page.mouse.move(table.x + table.width / 2, table.y + table.height - 1);
          if (!blanks) await page.screenshot({ path: path.join(output, skin + '-' + theme + '-compact.png') });
          const targets = await page.evaluate(() => [...editor.view.contentDOM.children].filter(node => node.matches('.cm-line')).map(node => {
            const r = node.getBoundingClientRect(); return { x: r.left + 3, y: (r.top + r.bottom) / 2, from: editor.view.posAtDOM(node), text: node.textContent };
          }));
          for (const point of targets) {
            await page.mouse.click(point.x, point.y); await settle();
            const hit = await page.evaluate(() => { const v = editor.view, head = v.state.selection.main.head; return { line: v.state.doc.lineAt(head).text, head, focused: v.hasFocus }; });
            assert(hit.focused); assert.equal(hit.line, point.text); if (!point.text) assert.equal(hit.head, point.from);
            assert.equal(await value(), source, 'clicking a real line cannot add or delete table rows');
          }
        }
        for (const text of ['', '**bold**', 'alphabet 中文 '.repeat(12)]) {
          await reset('| ' + text + ' | B |\n| --- | --- |\n| C | D |'); await cell(0, 0).click(); await settle();
          const caret = await input.evaluate(node => {
            const line = node.querySelector('.cm-line'), style = getComputedStyle(line), rect = node.__noteCellInput.view.coordsAtPos(node.__noteCellInput.selectionEnd);
            return { color: style.caretColor, text: style.color, rect, focus: document.activeElement === node };
          });
          assert(caret.focus); assert.equal(caret.color, caret.text); assert.notEqual(caret.color, 'rgba(0, 0, 0, 0)'); assert(caret.rect.bottom > caret.rect.top);
        }
        await page.screenshot({ path: path.join(output, skin + '-' + theme + '.png'), caret: 'initial' });
        matrix.push({ skin, theme, width, scale, realBlanks: [0, 1, 2], nativeCaret: true });
      }
    }
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.noteTheme = 'default'; document.body.dataset.startTheme = 'light'; document.body.style.setProperty('--note-font-scale', 1); });
    for (const [source, blocks, blanks] of [[grid, 1, 0], [grid + '\n\n' + grid, 2, 1], ['\n\n' + grid + '\n\n', 1, 4]]) {
      await reset(source);
      assert.equal(await page.locator('.note-table').count(), blocks);
      assert.equal(await page.evaluate(() => [...editor.view.contentDOM.children].filter(node => node.matches('.cm-line') && !node.textContent).length), blanks);
      assert.equal(await value(), source);
    }
    // Both sides, including legacy hidden-source boundary selections and native beforeinput.
    for (const [source, head, backward] of [[grid, grid.length, true], [grid + '\n', grid.length + 1, true], [grid + '\nafter', grid.length + 1, true],
      ['before\n' + grid, 6, false], [grid, 0, false], ['before\n\n' + grid, 7, false]]) {
      await reset(source, head); await page.keyboard.press(backward ? 'Backspace' : 'Delete'); await settle();
      assert.equal(await value(), source); await checkCell(backward ? 2 : 0, backward ? 2 : 0, backward ? 'end' : 0);
    }
    await reset(grid + '\n\n', grid.length + 2); await page.keyboard.press('Backspace'); await settle();
    assert.equal(await value(), grid + '\n'); assert.equal(await input.count(), 0, 'extra real blank lines delete normally');
    await page.keyboard.press('Backspace'); await settle(); assert.equal(await value(), grid + '\n'); await checkCell(2, 2, 'end');
    await page.keyboard.press('Backspace'); await settle(); assert((await value()).includes('| G | H |  |'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), grid + '\n', 'the focus-only boundary hop adds no history entry');
    for (const backward of [true, false]) {
      const source = backward ? grid + '\n' : 'before\n' + grid;
      await reset(source, backward ? grid.length + 1 : 6);
      const cancelled = await page.evaluate(backward => !editor.view.contentDOM.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: backward ? 'deleteContentBackward' : 'deleteContentForward',
      })), backward); await settle(); assert(cancelled); assert.equal(await value(), source);
      await checkCell(backward ? 2 : 0, backward ? 2 : 0, backward ? 'end' : 0);
    }
    await reset(grid + '\n', grid.length + 1); await page.evaluate(() => editor.setSourceMode(true)); await settle();
    await page.keyboard.press('Backspace'); await settle(); assert.equal(await value(), grid, 'source mode retains ordinary character deletion');
    await reset(grid + '\nafter', grid.length + 1, 0); await page.keyboard.press('Backspace'); await settle(); assert.equal(await value(), 'after', 'explicit source selections remain deletable');
    await reset(grid); await select('table', 0); await page.keyboard.press('Delete'); await settle(); assert.equal(await value(), '');
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), grid);

    await reset(grid); await cell(2, 1).click(); await page.keyboard.press('Enter'); await settle(); await checkCell(3, 1, 0);
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), grid);
    await cell(2, 2).click(); await page.keyboard.press('Tab'); await settle(); await checkCell(3, 0, 0);

    await reset(grid); await select('table', 0); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), grid);
    const clipboardHTML = await page.evaluate(async () => {
      const items = await navigator.clipboard.read(), blob = await items[0].getType('text/html');
      const doc = new DOMParser().parseFromString(await blob.text(), 'text/html');
      return { tables: doc.querySelectorAll('table').length, rows: doc.querySelectorAll('tr').length, bold: doc.querySelector('th strong')?.textContent,
        tools: doc.querySelectorAll('button,textarea,[contenteditable],.note-table-control').length };
    });
    assert.deepEqual(clipboardHTML, { tables: 1, rows: 3, bold: 'A', tools: 0 });
    await reset(''); await page.keyboard.press('Control+v'); await settle(); assert.equal(await value(), grid, 'Markdown clipboard creates a complete table in body text');
    await reset(grid); await cell(0, 1).click(); await cell(1, 2).click({ modifiers: ['Shift'] }); await page.keyboard.press('Control+c');
    const subset = '| B | C |\n| :---: | ---: |\n| E | F |';
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), subset);
    await reset('| L | R |\n| :--- | :--- |\n| one | two |'); await cell(1, 0).click(); await page.keyboard.press('Control+v'); await settle();
    const pasted = await page.evaluate(() => document.querySelector('.note-table').__noteTableSurface.model);
    assert.deepEqual(pasted.align, ['left', 'left']); assert.deepEqual(pasted.rows, [['B', 'C'], ['E', 'F']]);
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), '| L | R |\n| :--- | :--- |\n| one | two |');
    await reset('| alphabet | B |\n| --- | --- |'); await cell(0, 0).click();
    await input.evaluate(node => node.__noteCellInput.setSelectionRange(1, 4)); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'lph', 'native text selection remains plain text');

    // Text write is mandatory for cut; optional HTML failure must not block a valid cut.
    for (const fail of ['text/plain', 'text/html']) {
      await reset(grid); await select('row', 1);
      const written = await page.locator('.note-table').evaluate((node, fail) => {
        const writes = {}, event = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData(type, text) { if (type === fail) throw new Error('denied'); writes[type] = text; } } });
        node.dispatchEvent(event); return writes;
      }, fail);
      if (fail === 'text/plain') assert.equal(await value(), grid);
      else { assert.equal(written['text/plain'], '| D | E | F |\n| :--- | :---: | ---: |'); assert.equal(await value(), '| **A** | B | C |\n| :--- | :---: | ---: |\n| G | H | I |'); }
    }
    await reset(grid); await cell(1, 1).click();
    const beforeIME = await value(); await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await value(), beforeIME, 'provisional input remains in the native cell');
    assert.equal(await input.evaluate(node => getComputedStyle(node.querySelector('.cm-line')).caretColor === getComputedStyle(node).color), true);
    await cdp.send('Input.insertText', { text: '中' }); await settle(); assert((await value()).includes('中'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), beforeIME);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ matrix, boundaryDeletion: true, clipboardHTML, copyRoundTrip: true, nativeIME: true, errors }, null, 2));
    console.log(JSON.stringify({ output, matrix: matrix.length, boundaryDeletion: true, clipboard: true, nativeIME: true }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

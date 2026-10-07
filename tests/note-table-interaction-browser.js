'use strict';

// Real pointer/input checks. This host only serves repository assets; no user notes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-table-interaction-'));
const grid = '| A | B |\n| --- | --- |\n| C | D |\n| E | F |';
const source = '123\n\n# 123\n\n' + grid;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style>
</head><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
<script src="markdown.js"></script><script src="markdown-table.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script>
<script src="note-table-editor.js"></script><script src="note-live-editor.js"></script><script>
window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(source)},notePath:'interaction.md'});
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const filename = path.resolve(repo, '.' + pathname);
    if (!filename.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [], hits = [];
    const cdp = await context.newCDPSession(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.editor && document.querySelector('.note-table'));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const rows = () => page.evaluate(() => { const m = MarkdownTable.findTables(editor.snapshot().value)[0]?.model; return m ? [m.header, ...m.rows] : []; });
    const value = () => page.evaluate(() => editor.snapshot().value);
    async function reset(text = source) {
      await page.evaluate(text => { editor.setDocument({ value: text, notePath: 'interaction.md', anchor: 0, head: 0, scrollTop: 0 }); editor.view.contentDOM.blur(); }, text);
      await settle();
    }
    const table = page.locator('.note-table').first();
    const input = page.locator('.note-table-cell-editor');
    const cell = (r, c) => table.locator(`td[data-table-row="${r}"][data-table-col="${c}"]`);
    async function cellPoint(r, c, blank = true) {
      const rect = await cell(r, c).boundingBox();
      return { x: blank ? rect.x + rect.width - 18 : rect.x + 13, y: rect.y + rect.height / 2 };
    }
    async function dragPoints(a, b) {
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up(); await settle();
    }
    async function grip(kind, index) {
      const rect = await cell(kind === 'row' ? index : 0, kind === 'row' ? 0 : index).boundingBox();
      await page.mouse.move(kind === 'row' ? rect.x + 1 : rect.x + rect.width / 2, kind === 'row' ? rect.y + rect.height / 2 : rect.y + 1);
      const control = table.locator(`.note-table-grip[data-table-kind="${kind}"][data-table-index="${index}"]`);
      await control.waitFor({ state: 'visible' }); return control;
    }
    // Previously the visible post-table cursor was actually at the last pipe.
    for (const suffix of ['', '\n', '\n\n']) for (const dy of [6, 25, 48]) {
      await reset(source + suffix);
      const dataBox = await table.locator('table').boundingBox();
      await page.mouse.move(dataBox.x + dataBox.width / 2, dataBox.y + dataBox.height + 1);
      const point = await page.evaluate(dy => {
        const w = document.querySelector('.note-table').getBoundingClientRect(), c = editor.view.contentDOM.getBoundingClientRect();
        const add = document.querySelector('.note-table-add:not([hidden])').getBoundingClientRect();
        return { x: c.left + 5, y: Math.max(w.bottom, add.bottom) + dy };
      }, dy);
      await page.mouse.click(point.x, point.y);
      await settle();
      const caret = await page.evaluate(() => {
        const v = editor.view, head = v.state.selection.main.head;
        return { line: v.state.doc.lineAt(head).text, head, focus: v.hasFocus, input: !!document.querySelector('.note-table-cell-editor'), rect: v.coordsAtPos(head) };
      });
      assert.equal(caret.line, '', 'a visible post-table caret must belong to a real empty document line');
      assert(caret.focus && !caret.input, 'body typing must have the body input host');
      await page.keyboard.type('123');
      await settle();
      assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']], 'body input cannot append a third table column');
      assert((await value()).endsWith('123') || (await value()).endsWith('123\n'));
      hits.push({ suffix, dy, point, caret, result: await value() });
    }
    await page.screenshot({ path: path.join(output, 'body-boundary.png') });
    // A source-mode cursor on the final pipe is a boundary too when switching
    // back. Keyboard entry must move to a body line before native insertion.
    for (const key of ['ArrowDown', 'Process']) {
      await reset(source); await page.evaluate(() => editor.setSourceMode(true)); await settle();
      const sourcePoint = await page.evaluate(() => {
        const line = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')).find(l => l.textContent === '| E | F |');
        const range = document.createRange(); range.selectNodeContents(line); const r = range.getBoundingClientRect();
        return { x: r.right + 1, y: r.top + r.height / 2 };
      });
      await page.mouse.click(sourcePoint.x, sourcePoint.y);
      await page.evaluate(() => editor.setSourceMode(false)); await settle();
      if (key === 'Process') await page.locator('.cm-content').dispatchEvent('keydown', { key: 'Process', keyCode: 229 });
      else await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text), '', 'native IME initiation must relocate a hidden source boundary before composition: ' + JSON.stringify(await page.evaluate(key => { const s = document.querySelector('.note-table')?.__noteTableSurface; return { key, head: editor.view.state.selection.main.head, focus: document.activeElement.className, current: s?.current(), boundary: s?.controller.boundary(editor.view), epoch: [s?.widget.epoch,s?.widget.coordinator.epoch], pending: editor.inputPending }; }, key)));
      await page.keyboard.type('123'); await settle();
      assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);
    }
    // No toolbar, layout controls or header distinction; only one nearby edge control.
    await reset(source + '\n\n后文');
    assert.equal(await table.locator('.note-table-toolbar,.note-table-gutter,.note-table-column-tools,th').count(), 0);
    await page.mouse.move(20, 20);
    assert.equal(await table.locator('.note-table-control:visible').count(), 0);
    const edgeCell = await cell(0, 1).boundingBox();
    await page.mouse.move(edgeCell.x + edgeCell.width - 1, edgeCell.y + edgeCell.height - 1);
    assert.equal(await table.locator('.note-table-control:visible').count(), 1);
    await table.locator('.note-table-control:visible').click(); await settle();
    assert.equal((await rows())[0].length, 3, 'right edge appends a column');
    await page.keyboard.press('Control+z'); await settle(); assert.equal((await rows())[0].length, 2);
    await reset(source + '\n\n后文');
    const bottomCell = await cell(2, 0).boundingBox();
    await page.mouse.move(bottomCell.x + bottomCell.width - 1, bottomCell.y + bottomCell.height - 1);
    await table.locator('.note-table-control:visible').click(); await settle();
    assert.equal((await rows()).length, 4, 'bottom edge appends a row');

    // A blank part of the SAME cell must allow selecting the cell, even while editing.
    await reset(source + '\n\n后文');
    await cell(0, 0).click();
    const a = await cellPoint(0, 0), b = { x: a.x - 50, y: a.y };
    await dragPoints(a, b);
    assert.equal(await input.count(), 0); assert.equal(await table.locator('td.is-table-selected').count(), 1);
    await page.keyboard.press('Delete'); await settle(); assert.equal((await rows())[0][0], '');
    await page.keyboard.press('Control+z'); await settle(); assert.equal((await rows())[0][0], 'A');

    // Body dragging replaces the old physical-button-only range selection.
    await reset(source + '\n\n后文');
    await dragPoints(await cellPoint(0, 0), await cellPoint(1, 1));
    await page.screenshot({ path: path.join(output, 'internal-selection.png') });
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A\tB\nC\tD');
    await page.keyboard.press('Delete'); await settle(); assert.deepEqual(await rows(), [['E', 'F']]);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);

    // Reverse pointer ranges retain the same bounds and structural semantics.
    await reset(source + '\n\n后文');
    await dragPoints(await cellPoint(1, 1), await cellPoint(0, 0));
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A\tB\nC\tD');
    await page.keyboard.press('Delete'); await settle(); assert.deepEqual(await rows(), [['E', 'F']]);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);

    // Text dragging stays native inside the same cell, then crosses into grid selection.
    await reset('| alphabet | second |\n| --- | --- |\n| third | fourth |\n\n后文');
    await cell(0, 0).click();
    const area = await input.boundingBox();
    await dragPoints({ x: area.x + 11, y: area.y + 16 }, { x: area.x + 48, y: area.y + 16 });
    assert.equal(await table.locator('td.is-table-selected').count(), 0);
    assert(await input.evaluate(node => node.selectionEnd > node.selectionStart), 'same-cell character dragging selects text');
    const area2 = await input.boundingBox(), other = await cellPoint(0, 1);
    await dragPoints({ x: area2.x + 15, y: area2.y + 16 }, other);
    assert.equal(await input.count(), 0, JSON.stringify(await table.evaluate(node => ({ edit: node.__noteTableSurface.edit && [node.__noteTableSurface.edit.row, node.__noteTableSurface.edit.col], selection: node.__noteTableSurface.selection, gesture: node.__noteTableSurface.gesture && node.__noteTableSurface.gesture.mode, active: document.activeElement.className })))); assert.equal(await table.locator('td.is-table-selected').count(), 2);

    // Text sizing must never collapse the native input host. Width and font
    // changes resize it using a mirror, keeping wrapped caret geometry valid.
    await reset(source + '\n\n后文'); await cell(0, 0).click();
    await input.evaluate(area => {
      window.__zeroInputHeight = false;
      Object.defineProperty(area.style, 'height', { configurable: true, get() { return this.getPropertyValue('height'); }, set(value) { if (value === '0px') __zeroInputHeight = true; this.setProperty('height', value); } });
    });
    await input.fill('中文长文本 '.repeat(60)); await settle();
    const wideHeight = (await input.boundingBox()).height;
    await page.setViewportSize({ width: 720, height: 700 }); await settle(); await settle();
    assert((await input.boundingBox()).height > wideHeight, 'native input height must follow its real wrapped width');
    await input.fill('短'); await settle();
    assert((await input.boundingBox()).height < wideHeight, 'mirror sizing also shrinks after deletion');
    assert.equal(await page.evaluate(() => __zeroInputHeight), false, 'the IME host never has a transient zero height');
    await page.setViewportSize({ width: 1400, height: 1000 });

    // Insertion-style reordering, including row zero and column alignment.
    await reset(source + '\n\n后文');
    let handle = await grip('row', 0), handleBox = await handle.boundingBox(), last = await cell(2, 0).boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: last.x + 30, y: last.y + last.height - 2 });
    assert.deepEqual(await rows(), [['C', 'D'], ['E', 'F'], ['A', 'B']]);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);
    // Reordering immediately after a text commit must form a separate undo unit.
    await reset(source + '\n\n后文'); await cell(0, 0).click(); await input.fill('edited');
    handle = await grip('row', 0); handleBox = await handle.boundingBox(); last = await cell(2, 0).boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: last.x + 30, y: last.y + last.height - 2 });
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['edited', 'B'], ['C', 'D'], ['E', 'F']]);
    await reset('| A | B | C |\n| :--- | :---: | ---: |\n| D | E | F |\n\n后文');
    handle = await grip('column', 0); handleBox = await handle.boundingBox(); last = await cell(0, 2).boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: last.x + last.width - 2, y: last.y + 20 });
    assert.deepEqual(await rows(), [['B', 'C', 'A'], ['E', 'F', 'D']]);
    assert.deepEqual(await page.evaluate(() => MarkdownTable.findTables(editor.snapshot().value)[0].model.align), ['center', 'right', 'left']);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['A', 'B', 'C'], ['D', 'E', 'F']]);
    const beforeCancel = await value(); handle = await grip('column', 1); handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down(); await page.mouse.move(20, 20); await page.mouse.up();
    await settle();
    assert.deepEqual(await rows(), [['B', 'A', 'C'], ['E', 'D', 'F']], 'outside the table but inside the window still snaps along the column axis');
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), beforeCancel);
    handle = await grip('column', 1); handleBox = await handle.boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: -20, y: 20 });
    assert.equal(await value(), beforeCancel, 'release outside the window cancels');

    // Cancelled drags must not swallow the next real edge click.
    const edgeAfterCancel = await cell(1, 2).boundingBox();
    await page.mouse.move(edgeAfterCancel.x + edgeAfterCancel.width - 1, edgeAfterCancel.y + edgeAfterCancel.height - 1);
    await table.locator('.note-table-control:visible').click(); await settle();
    assert.equal((await rows())[0].length, 4);

    await reset(source + '\n\n后文');
    await (await grip('row', 0)).click();
    await page.keyboard.down('Shift'); await (await grip('row', 1)).click(); await page.keyboard.up('Shift');
    assert.equal(await table.locator('td.is-table-selected').count(), 4);
    handle = await grip('row', 0); handleBox = await handle.boundingBox(); last = await cell(2, 0).boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: last.x + 30, y: last.y + last.height - 1 });
    assert.deepEqual(await rows(), [['E', 'F'], ['A', 'B'], ['C', 'D']], 'a selected consecutive group moves as one range');
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);
    const beforeEscape = await value(); handle = await grip('row', 0); handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down(); await page.mouse.move(last.x + 30, last.y + last.height - 1);
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    assert.equal(await value(), beforeEscape, 'Escape cancels a reorder without a transaction');

    // Continuous column groups and their alignment metadata move together.
    await reset('| A | B | C |\n| :--- | :---: | ---: |\n| D | E | F |\n\n后文');
    const beforeColumnGroup = await value();
    await (await grip('column', 0)).click();
    await page.keyboard.down('Shift'); await (await grip('column', 1)).click(); await page.keyboard.up('Shift');
    assert.equal(await table.locator('td.is-table-selected').count(), 4);
    handle = await grip('column', 1); handleBox = await handle.boundingBox(); last = await cell(0, 2).boundingBox();
    await dragPoints({ x: handleBox.x + 11, y: handleBox.y + 11 }, { x: last.x + last.width - 1, y: last.y + 20 });
    assert.deepEqual(await rows(), [['C', 'A', 'B'], ['F', 'D', 'E']]);
    assert.deepEqual(await page.evaluate(() => MarkdownTable.findTables(editor.snapshot().value)[0].model.align), ['right', 'left', 'center']);
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), beforeColumnGroup);

    // Grip-only window-wide snapping: perpendicular coordinates never affect
    // the gap, input host, source selection or layout during the drag.
    const dragEvidence = [];
    const dragState = () => table.evaluate(node => {
      const s = node.__noteTableSurface, rect = s.table.getBoundingClientRect(), drop = s.drop.getBoundingClientRect();
      const style = getComputedStyle(s.drop), v = editor.view;
      return { gap: s.gesture?.gap, capture: s.gesture && s.grip.hasPointerCapture(s.gesture.id),
        table: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        drop: { x: drop.x, y: drop.y, width: drop.width, height: drop.height },
        visible: !s.drop.hidden, color: style.backgroundColor, events: style.pointerEvents,
        anchor: v.state.selection.main.anchor, head: v.state.selection.main.head, focus: document.activeElement === node ? 'table' : document.activeElement.className };
    });
    for (const theme of ['light', 'dark']) for (const kind of ['row', 'column']) {
      await reset(source + '\n\n后文');
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      handle = await grip(kind, 0); handleBox = await handle.boundingBox();
      const original = await value(), before = await dragState(), box = await table.locator('table').boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
      const pressed = await dragState();
      const far = kind === 'row' ? { x: 20, y: box.y + box.height + 40 } : { x: box.x + box.width + 40, y: 20 };
      await page.mouse.move(far.x, far.y, { steps: 8 }); await settle();
      const first = await dragState();
      await page.mouse.move(kind === 'row' ? 1380 : far.x, kind === 'row' ? far.y : 960); await settle();
      const second = await dragState();
      assert(first.capture && first.visible && second.visible, 'capture retains a visible preview over other window regions');
      assert.equal(first.gap, kind === 'row' ? 3 : 2); assert.equal(second.gap, first.gap);
      assert.equal(await value(), original, 'drag preview must not dispatch a document change');
      assert.deepEqual(second.table, before.table, 'overlay cannot resize or move the original table');
      assert.equal(second.head, before.head); assert.equal(second.anchor, before.anchor);
      assert.equal(second.focus, pressed.focus, 'dragging cannot change the input owner');
      assert.equal(first.events, 'none');
      assert.equal(first.color, theme === 'light' ? 'rgb(120, 147, 108)' : 'rgb(173, 203, 165)');
      if (kind === 'row') { assert.equal(first.drop.height, 4); assert.equal(first.drop.width, first.table.width); assert.equal(first.drop.y + 2, first.table.y + first.table.height); }
      else { assert.equal(first.drop.width, 4); assert.equal(first.drop.height, first.table.height); assert.equal(first.drop.x + 2, first.table.x + first.table.width); }
      await page.screenshot({ path: path.join(output, `grip-${kind}-${theme}.png`) });
      await page.mouse.up(); await settle();
      assert.deepEqual(await rows(), kind === 'row' ? [['C', 'D'], ['E', 'F'], ['A', 'B']] : [['B', 'A'], ['D', 'C'], ['F', 'E']]);
      await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), original);
      dragEvidence.push({ theme, kind, before, first, second });
    }
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });

    // Only the reorder axis scrolls, including when the pointer is far away
    // on the perpendicular axis. The visible gap tracks the resulting DOM.
    await page.setViewportSize({ width: 720, height: 600 });
    const tallRows = Array.from({ length: 24 }, (_, index) => '| 行' + index + ' | 值' + index + ' |').join('\n');
    await reset('| A | B |\n| --- | --- |\n' + tallRows + '\n\n后文');
    handle = await grip('row', 0); handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down(); await page.mouse.move(710, 592, { steps: 8 });
    await page.waitForFunction(() => editor.view.scrollDOM.scrollTop > 40);
    const scrollPreview = await dragState();
    assert(scrollPreview.visible); assert(scrollPreview.gap > 0);
    assert.equal(await table.locator('.note-table-scroll').evaluate(node => node.scrollLeft), 0, 'row reorders never scroll horizontally');
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    await reset('| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n\n后文');
    // Force a genuinely wide table, rather than relying on text min-width.
    await table.locator('.note-table-scroll').evaluate(node => { node.style.width = '500px'; node.querySelector('table').style.width = '1600px'; }); await settle();
    handle = await grip('column', 0); handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down(); await page.mouse.move(710, 10, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('.note-table-scroll').scrollLeft > 40);
    assert.equal(await page.evaluate(() => editor.view.scrollDOM.scrollTop), 0, 'column reorders never scroll vertically');
    assert((await dragState()).visible);
    await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    await page.setViewportSize({ width: 1400, height: 1000 });

    // Preview is remeasured during an active gesture, using variable row
    // heights and CSS pixels after wrapping, font and viewport changes.
    await reset('| ' + '长文本 '.repeat(35) + ' | B |\n| --- | --- |\n| C | D |\n| E | F |\n\n后文');
    handle = await grip('row', 2); handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down();
    await page.mouse.move(20, 10, { steps: 8 }); await settle();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.evaluate(() => { document.getElementById('editor').style.fontSize = '135%'; editor.view.requestMeasure(); }); await settle();
    let measured = await dragState();
    assert.equal(measured.gap, 0); assert.equal(measured.drop.y + 2, measured.table.y); assert.equal(measured.drop.width, measured.table.width);
    await page.mouse.up(); await settle(); assert.deepEqual((await rows())[0], ['E', 'F']);
    await page.keyboard.press('Control+z'); await settle();
    await page.evaluate(() => { document.getElementById('editor').style.fontSize = ''; });
    await page.setViewportSize({ width: 1400, height: 1000 });

    // Same slot, sub-threshold, lost capture, blur, source mode and document
    // replacement cancel without a transaction or a stuck drag listener.
    for (const reason of ['noop', 'threshold', 'capture', 'blur', 'source', 'document']) {
      await reset(source + '\n\n后文'); const original = await value();
      handle = await grip('row', 1); handleBox = await handle.boundingBox();
      await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down();
      await page.mouse.move(reason === 'threshold' ? handleBox.x + 13 : 20,
        reason === 'noop' || reason === 'threshold' ? handleBox.y + 11 : 10);
      if (reason === 'capture') await table.evaluate(node => { const s = node.__noteTableSurface; s.grip.releasePointerCapture(s.gesture.id); });
      if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (reason === 'source') await page.evaluate(() => editor.setSourceMode(true));
      if (reason === 'document') await page.evaluate(original => editor.setDocument({ value: original, notePath: 'next.md', anchor: 0, head: 0, scrollTop: 0 }), original);
      await page.mouse.up(); await settle(); assert.equal(await value(), original, reason);
      await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), original, reason + ' writes no undo unit');
      await page.evaluate(() => editor.setSourceMode(false)); await settle();
    }

    // Pending candidates retain their native host. A released reorder waits;
    // an Escape or later body target invalidates the deferred intent.
    for (const end of ['commit', 'escape', 'blur', 'body']) {
      await reset(source + '\n\n后文'); await cell(0, 0).click(); await input.press('End');
      await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
      const host = await input.elementHandle();
      handle = await grip('row', 0); handleBox = await handle.boundingBox(); last = await cell(2, 0).boundingBox();
      await page.mouse.move(handleBox.x + 11, handleBox.y + 11); await page.mouse.down();
      await page.mouse.move(20, last.y + last.height + 35, { steps: 8 }); await settle();
      assert(await host.evaluate(area => area.isConnected && document.activeElement === area), 'candidate host stays focused and mounted during a grip drag');
      assert.equal((await rows())[0][0], 'A', 'preedit is not document content');
      await page.mouse.up(); await settle();
      if (end === 'escape') await page.keyboard.press('Escape');
      if (end === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (end === 'body') {
        const line = await page.locator('.cm-line').filter({ hasText: /^后文$/ }).boundingBox();
        await page.mouse.click(line.x + 1, line.y + line.height / 2);
      }
      await cdp.send('Input.insertText', { text: '汉' }); await settle();
      assert.deepEqual(await rows(), end === 'commit' ? [['C', 'D'], ['E', 'F'], ['A汉', 'B']] : [['A汉', 'B'], ['C', 'D'], ['E', 'F']]);
      if (end === 'body') assert.equal(await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text), '后文');
      assert.equal(await table.locator('.note-table-drop:visible').count(), 0, 'a deferred action never restarts a finished gesture');
    }

    // Leaving a committed cell for body text must not restore the hidden source caret.
    await reset(source + '\n\n后文');
    const beforeTableLine = await page.locator('.cm-line').filter({ hasText: /^123$/ }).first().boundingBox();
    await page.mouse.click(beforeTableLine.x + 1, beforeTableLine.y + beforeTableLine.height / 2);
    assert.equal(await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text), '123');
    await cdp.send('Input.insertText', { text: '表前中文' }); await settle();
    assert((await value()).startsWith('表前中文123')); assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);
    await reset(source + '\n\n后文'); await cell(2, 1).click(); await input.fill('新单元格');
    const bodyPoint = await page.evaluate(() => { const line = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')).find(line => line.textContent === '后文'); const r = line.getBoundingClientRect(); return { x: r.left + 1, y: r.top + r.height / 2 }; });
    await page.mouse.click(bodyPoint.x, bodyPoint.y); await page.keyboard.type('body'); await settle();
    assert.equal((await rows())[2][1], '新单元格'); assert((await value()).includes('body后文'));

    // A pending click is mapped through a candidate commit, and the latest
    // body click wins rather than an earlier callback restoring its target.
    await reset(source + '\n\n后文\n\n再后文'); await cell(2, 1).click();
    await input.press('End');
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await page.mouse.click(bodyPoint.x, bodyPoint.y); await settle();
    assert.equal(await page.evaluate(() => editor.inputPending), true);
    assert.equal((await rows())[2][1], 'F');
    const lastBody = await page.locator('.cm-line').filter({ hasText: /^再后文$/ }).boundingBox();
    await page.mouse.click(lastBody.x + 1, lastBody.y + lastBody.height / 2);
    await cdp.send('Input.insertText', { text: '中' }); await settle();
    assert.equal((await rows())[2][1], 'F中');
    assert.equal(await input.count(), 0);
    assert.equal(await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text), '再后文');
    await page.keyboard.type('body'); await settle(); assert((await value()).endsWith('body再后文'));

    // WebView2/MS Pinyin may end composition BEFORE dispatching the pointer
    // event. The settling phase must retain the requested body position too.
    await reset(source + '\n\n后文'); await cell(2, 1).click(); await input.press('End');
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    const settledTarget = await page.locator('.cm-line').filter({ hasText: /^后文$/ }).boundingBox();
    await page.evaluate(({x, y}) => {
      const area = document.querySelector('.note-table-cell-editor');
      area.value = 'F汉'; area.dispatchEvent(new CompositionEvent('compositionend', { data: '汉', bubbles: true }));
      const target = document.elementFromPoint(x, y);
      target.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    }, { x: settledTarget.x + 1, y: settledTarget.y + settledTarget.height / 2 });
    await settle();
    assert.equal((await rows())[2][1], 'F汉');
    assert.equal(await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text), '后文');
    await page.keyboard.type('body'); await settle(); assert((await value()).endsWith('body后文'));

    // Real pointer entry, Unicode and native clipboard at several layouts.
    for (const width of [720, 1400]) {
      await page.setViewportSize({ width, height: 700 });
      await reset(source + '\n\n');
      await page.evaluate(() => { document.getElementById('editor').style.fontSize = '135%'; editor.view.requestMeasure(); }); await settle();
      const r = await table.boundingBox(), c = await page.locator('.cm-content').boundingBox();
      await page.mouse.click(c.x + 2, r.y + r.height + 20); await cdp.send('Input.insertText', { text: '正文中文' });
      await page.evaluate(() => navigator.clipboard.writeText('粘贴正文'));
      await page.keyboard.press('Control+v'); await settle();
      assert.deepEqual(await rows(), [['A', 'B'], ['C', 'D'], ['E', 'F']]);
      assert((await value()).endsWith('正文中文粘贴正文'));
      await page.evaluate(() => { editor.setSourceMode(true); editor.setSourceMode(false); }); await settle();
      assert((await value()).endsWith('正文中文粘贴正文'));
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ hits, dragEvidence, errors, textSelection: true, gridSelection: true, reorder: true, settlingBodyClick: true, responsiveBodyPaste: true }, null, 2));
    console.log(JSON.stringify({ output, status: 'note table interaction browser checks passed' }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

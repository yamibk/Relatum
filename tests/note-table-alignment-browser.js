'use strict';

// Static assets + synthetic notes only. Native pointer/CDP composition, no user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-table-alignment-'));
const source = '前文\n\n| 序号 | 学科 | 数量 |\n|  ----  | :-----: | ---: |\n| 01 | 高等数学 | 30 kWh |\n| 02 | 线性代数 | 18 kWh |\n\n后文';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style></head>
<body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
${['markdown-table.js','markdown.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-live-editor.js'].map(name => '<script src="' + name + '"></script>').join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(source)},notePath:'alignment.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForSelector('.note-table');
    const cdp = await page.context().newCDPSession(page);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const toolbar = page.locator('.note-table-alignment:visible');
    const button = align => toolbar.locator('[data-table-align="' + align + '"]');
    const cell = (r, c) => page.locator('td[data-table-row="' + r + '"][data-table-col="' + c + '"]').first();
    const value = () => page.evaluate(() => editor.snapshot().value);
    const aligns = () => page.evaluate(() => MarkdownTable.findTables(editor.snapshot().value)[0].model.align);
    const reset = async (text = source) => {
      await page.evaluate(value => { editor.setSourceMode(false); editor.setDocument({ value, notePath: 'alignment.md', anchor: 0, head: 0, scrollTop: 0 }); }, text);
      await settle();
    };
    const apply = async align => { await button(align).click(); await settle(); };
    assert.equal(await toolbar.count(), 0, 'inactive tables have no visible controls');
    await cell(1, 2).click(); await settle();
    assert.equal(await button('right').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => {
      window.inputHost = document.activeElement;
      window.cells = Array.from(document.querySelectorAll('.note-table td'));
      window.contents = cells.map(cell => cell.firstElementChild);
      window.beforeScroll = editor.view.scrollDOM.scrollTop;
    });
    await apply('left');
    assert.equal(await value(), source.replace('|  ----  | :-----: | ---: |', '|  ----  | :-----: | :--- |'));
    assert(await page.evaluate(() => document.activeElement === inputHost && inputHost.isConnected
      && cells.every((cell, i) => cell === document.querySelectorAll('.note-table td')[i] && cell.firstElementChild === contents[i])
      && beforeScroll === editor.view.scrollDOM.scrollTop), 'alignment retains DOM, input, focus and scroll');
    assert.equal(await page.locator('.note-table-cell-editor').evaluate(node => getComputedStyle(node).textAlign), 'left');
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source, 'one undo restores just the delimiter');
    await page.keyboard.press('Control+y'); await settle(); assert.deepEqual(await aligns(), ['', 'center', 'left']);
    await apply('left'); await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source, 'no-op alignment adds no undo entry');

    for (const separator of ['  ----  | :-----: | ---:  ', '|\t-\t| :--: |---:|']) {
      const variant = source.replace('|  ----  | :-----: | ---: |', separator);
      await reset(variant); await cell(1, 2).click(); await apply('center');
      assert.equal(await value(), variant.replace(separator, separator.replace(/---:(?=\s*\|?\s*$)/, ':---:')), 'optional pipes, tabs, spacing and dash counts remain intact');
    }

    // A real cell rectangle selection applies to covered columns, not just the head.
    await reset();
    const first = await cell(1, 1).boundingBox(), last = await cell(2, 2).boundingBox();
    await page.mouse.move(first.x + first.width - 15, first.y + first.height / 2); await page.mouse.down();
    await page.mouse.move(last.x + last.width - 15, last.y + last.height / 2, { steps: 8 }); await page.mouse.up(); await settle();
    assert.equal(await toolbar.locator('[aria-pressed="true"]').count(), 0, 'mixed columns have no selected alignment');
    await apply('center'); assert.deepEqual(await aligns(), ['', 'center', 'center']);
    await page.keyboard.press('Control+a'); await settle(); await apply('left');
    assert.deepEqual(await aligns(), ['', 'left', 'left'], 'select all then align affects the whole table');
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await aligns(), ['', 'center', 'center']);

    for (const kind of ['row', 'column']) {
      await reset();
      await page.evaluate(kind => document.querySelector('.note-table').__noteTableSurface.select(kind, 1, false), kind);
      await settle(); await apply('right');
      assert.deepEqual(await aligns(), kind === 'row' ? ['right', 'right', 'right'] : ['', 'right', 'right']);
    }
    // Keyboard access after leaving the native input; Escape returns to the table.
    await reset(); await cell(1, 1).click(); await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tableAlign), 'center');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await settle();
    assert.deepEqual(await aligns(), ['', 'right', 'right']);
    await page.keyboard.press('Control+z'); await settle(); assert.deepEqual(await aligns(), ['', 'center', 'right']);
    await page.keyboard.press('Control+y'); await settle(); assert.deepEqual(await aligns(), ['', 'right', 'right']);
    await page.keyboard.press('Escape'); assert(await page.evaluate(() => document.activeElement.classList.contains('note-table')));
    await page.evaluate(() => editor.focus()); await settle(); assert.equal(await toolbar.count(), 0, 'body focus dismisses the toolbar');

    // CDP drives Chromium's real composition path; clicking must retain its host
    // until the candidate commits, and alignment has its own undo boundary.
    await reset(); await cell(1, 0).click();
    await page.evaluate(() => { window.compositionHost = document.activeElement; });
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await apply('center'); assert.equal(await value(), source, 'preedit and queued alignment do not change the document');
    assert(await page.evaluate(() => compositionHost.isConnected && document.activeElement === compositionHost));
    await cdp.send('Input.insertText', { text: '中' }); await settle(); await settle();
    assert.equal((await aligns())[0], 'center');
    assert((await value()).includes('01中')); assert(!(await value()).includes('zhong'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal((await aligns())[0], ''); assert((await value()).includes('01中'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source);

    // A queued command cannot apply after an explicit departure.
    await reset(); await cell(1, 0).click();
    await cdp.send('Input.imeSetComposition', { text: 'qu', selectionStart: 2, selectionEnd: 2 });
    await apply('center');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await settle(); await settle();
    assert.equal(await toolbar.count(), 0); assert.equal((await aligns())[0], '');
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; });

    for (const scale of [1, 1.25, 1.5, 2]) for (const dark of [false, true]) {
      await reset(); await page.setViewportSize({ width: scale === 2 ? 520 : 1280, height: 900 });
      await page.evaluate(({ scale, dark }) => {
        document.body.dataset.startTheme = dark ? 'dark' : 'light'; document.documentElement.lang = dark ? 'en' : 'zh-CN';
        document.getElementById('editor').style.setProperty('--note-font-scale', scale);
      }, { scale, dark });
      await cell(1, 1).click(); await settle();
      await page.evaluate(() => document.fonts.ready);
      if (await toolbar.evaluate(node => node.classList.contains('is-compact'))) await toolbar.locator('.note-table-alignment-toggle').click();
      await apply('left'); assert.equal((await aligns())[1], 'left');
      const rect = await toolbar.boundingBox(), viewport = page.viewportSize();
      assert(rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y >= 0 && rect.y + rect.height <= viewport.height);
      await page.screenshot({ path: path.join(output, 'alignment-' + scale + '-' + (dark ? 'dark' : 'light') + '.png') });
      const before = await value(); await page.evaluate(() => editor.setSourceMode(true)); await settle(); assert.equal(await toolbar.count(), 0);
      await page.evaluate(() => editor.setSourceMode(false)); await settle(); assert.equal(await value(), before);
    }
    await page.setViewportSize({ width: 520, height: 350 }); await reset(); await cell(1, 0).click(); await settle();
    await toolbar.locator('.note-table-alignment-toggle').click();
    const menuRect = await toolbar.locator('.note-table-alignment-options').boundingBox();
    assert(menuRect.x >= 0 && menuRect.y >= 0 && menuRect.y + menuRect.height <= 350, 'compact popup avoids the viewport edge');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await reset(); await cell(1, 0).click(); await settle();
    await page.evaluate(() => { document.querySelector('.note-document-pane').style.display = 'none'; }); await settle(); await settle();
    assert.equal(await toolbar.count(), 0, 'hidden ancestors release the portal');
    await page.evaluate(() => { document.querySelector('.note-document-pane').style.display = ''; });

    // 8000 cells: column styles change locally; fragments/models remain shared.
    const large = '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
      + Array.from({ length: 999 }, (_, i) => '| ' + Array.from({ length: 8 }, (_, j) => i + ':' + j).join(' | ') + ' |').join('\n');
    await reset(large); await cell(1, 2).click(); await settle();
    await page.evaluate(() => {
      window.largeCells = Array.from(document.querySelectorAll('.note-table td')); window.largeContents = largeCells.map(cell => cell.firstElementChild);
      window.parseCount = 0; const parse = MarkdownTable.parse; MarkdownTable.parse = (...args) => { parseCount++; return parse(...args); };
      window.styleWrites = []; window.mutations = new MutationObserver(records => styleWrites.push(...records.map(record => record.target.dataset.tableCol)));
      mutations.observe(document.querySelector('.note-table tbody'), { attributes: true, subtree: true, attributeFilter: ['style'] });
    });
    await apply('right');
    const largeCheck = await page.evaluate(() => {
      mutations.disconnect();
      return { count: largeCells.length, stable: largeCells.every((cell, i) => cell === document.querySelectorAll('.note-table td')[i] && cell.firstElementChild === largeContents[i]),
        parseCount, columns: [...new Set(styleWrites.filter(Boolean))], local: document.querySelector('.note-table').__noteTableSurface.widget.spec.alignmentDelta?.columns };
    });
    assert.equal(largeCheck.count, 8000); assert(largeCheck.stable); assert.equal(largeCheck.parseCount, 0);
    assert.deepEqual(largeCheck.local, [2]); assert.deepEqual(largeCheck.columns, ['2']);
    await page.evaluate(() => { editor.view.scrollDOM.scrollTop = 5000; }); await settle();
    assert(await toolbar.evaluate(node => node.getBoundingClientRect().top >= 0), 'long tables retain an accessible viewport toolbar');
    await page.evaluate(() => { window.rafCount = 0; const raf = window.requestAnimationFrame; window.requestAnimationFrame = callback => { rafCount++; return raf(callback); }; });
    await page.waitForTimeout(500); assert.equal(await page.evaluate(() => rafCount), 0, 'idle toolbar creates no animation loop');
    await page.evaluate(() => editor.destroy()); assert.equal(await page.locator('.note-table-alignment').count(), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks: 'alignment, selection, source preservation, undo, IME, keyboard, themes, narrow, lifecycle, 8000 cells, idle', largeCheck, errors }, null, 2));
    console.log('note table alignment browser: ok', output);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

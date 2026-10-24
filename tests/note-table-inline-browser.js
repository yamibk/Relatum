'use strict';
// Synthetic notes only; inspect real glyphs, native input and parent history.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-table-inline-'));
const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css">'
  + '<style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style>'
  + '<body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="host"></div></div></main>'
  + ['markdown.js', 'markdown-table.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-live-editor.js'].map(name => '<script src="' + name + '"></script>').join('')
  + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"inline.md"});</script></html>';
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const input = page.locator('.note-table-cell-editor'), cell = page.locator('td[data-table-row="0"][data-table-col="0"]');
    const value = () => input.evaluate(node => node.__noteCellInput.value);
    const source = () => page.evaluate(() => editor.snapshot().value);
    const select = position => input.evaluate((node, position) => node.__noteCellInput.setSelectionRange(position, position), position);
    async function reset(text) {
      await page.evaluate(text => {
        editor.setSourceMode(false);
        editor.setDocument({ value: '| ' + text + ' | other |\n| --- | --- |\n| next | last |', notePath: 'inline.md', anchor: 0, head: 0, scrollTop: 0 });
      }, text);
      await settle(); await cell.click(); await settle();
    }
    const examples = [['**abc**', 'strong', 3], ['__abc__', 'strong', 3], ['*abc*', 'emphasis', 2], ['_abc_', 'emphasis', 2],
      ['~~abc~~', 'strike', 3], ['==abc==', 'highlight', 3], ['`abc`', 'inline-code', 2]];
    for (const [text, kind, position] of examples) {
      await reset(text + ' tail'); await select(position); await settle();
      assert(await input.locator('.note-live-' + kind).count(), text + ' has its text style');
      assert.equal(await input.locator('.note-live-source-mark').count(), 2, text + ' reveals two delimiters');
      const colors = await input.evaluate(node => ({ text: getComputedStyle(node).color, mark: getComputedStyle(node.querySelector('.note-live-source-mark')).color }));
      assert.notEqual(colors.text, colors.mark, text + ' uses the document marker color');
      if (kind === 'strong') assert.equal(await input.locator('.note-live-strong').first().evaluate(node => getComputedStyle(node).fontWeight), '700');
      if (kind === 'emphasis') assert.equal(await input.locator('.note-live-emphasis').first().evaluate(node => getComputedStyle(node).fontStyle), 'italic');
      const before = await source(); await select(text.length + 4); await settle();
      assert.equal(await input.locator('.note-live-source-mark').count(), 0, 'moving to plain text hides delimiters');
      assert.equal(await source(), before, 'projection never edits Markdown');
    }
    await reset(''); await page.keyboard.type('**abc**'); await select(3); await settle();
    assert.equal(await value(), '**abc**');
    assert.equal(await input.locator('.note-live-source-mark').count(), 2, 'typed delimiters gain their hint immediately');
    const point = await input.locator('.note-live-strong').evaluate(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let text;
      while (walker.nextNode()) if (walker.currentNode.textContent === 'abc') text = walker.currentNode;
      const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 2);
      const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width * .2, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.click(point.x, point.y); await page.keyboard.type('X'); await settle();
    assert.equal(await value(), '**aXbc**', 'real clicking on a bold glyph maps to the correct source position');
    const inlineBeforeSwitch = await source();
    await input.press('Escape'); await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.equal(await source(), inlineBeforeSwitch);
    await page.evaluate(() => editor.setSourceMode(false)); await settle(); assert.equal(await source(), inlineBeforeSwitch);
    for (const text of ['POWER_SOURCES', '**unclosed', '\\*literal\\*', '`**code** ==raw==`', '$a_b_c$ ==outside==', '# cell text', '---']) {
      await reset(text); await select(2); await settle();
      assert.equal(await input.locator('.note-live-strong,.note-live-emphasis,.note-live-heading').count(), 0, text + ' stays literal');
      if (!text.includes('outside')) assert.equal(await input.locator('.note-live-highlight').count(), 0, 'code does not interpret highlighters');
    }
    await reset('**bold _nested_**'); await select(10); await settle();
    assert(await input.locator('.note-live-strong .note-live-emphasis,.note-live-emphasis .note-live-strong').count(), 'nested styles compose');
    await reset('**POWER_SOURCES**'); await select(6); await settle();
    assert.equal(await input.locator('.note-live-emphasis').count(), 0, 'identifier underscore is not emphasis');
    const stable = await input.elementHandle();
    await input.press('End'); await page.keyboard.type('x'); await settle();
    assert((await source()).includes('**POWER_SOURCES**x'));
    assert(await stable.evaluate(node => node.isConnected && node === document.activeElement), 'ordinary input preserves the host');
    await input.press('Control+z'); await settle(); assert((await source()).includes('**POWER_SOURCES**'));
    await reset('**abc**'); await select(3);
    const cdp = await page.context().newCDPSession(page), before = await source();
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await source(), before, 'preedit is absent from the parent snapshot');
    assert.equal(await page.evaluate(() => editor.inputPending), true);
    await cdp.send('Input.insertText', { text: '中' }); await settle();
    assert((await source()).includes('**a中bc**')); assert.equal(await page.evaluate(() => editor.inputPending), false);
    await input.press('Control+z'); await settle(); assert.equal(await source(), before, 'one undo removes the candidate');
    // End a real browser composition immediately before a body click. Repeat
    // the handoff to catch delayed selection/focus work from the child view.
    for (let round = 0; round < 15; round++) {
      await reset('plain');
      await page.evaluate(() => {
        const value = editor.snapshot().value + '\n\n后文';
        editor.setDocument({ value, notePath: 'inline.md', anchor: 0, head: 0 });
      });
      await settle(); await page.locator('td[data-table-row="1"][data-table-col="1"]').click(); await input.press('End');
      await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
      const target = await page.locator('.cm-line').filter({ hasText: /^后文$/ }).boundingBox();
      await cdp.send('Input.insertText', { text: '汉' });
      await page.evaluate(({ x, y }) => {
        document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, detail: 1, bubbles: true, cancelable: true }));
      }, { x: target.x + 1, y: target.y + target.height / 2 });
      await settle(); await page.keyboard.type('body'); await settle();
      assert((await source()).endsWith('body后文'), 'post-composition body typing round ' + round + ': ' + await source());
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; document.querySelector('.note-document-body').style.setProperty('--note-font-scale', '2'); }, theme);
      await page.setViewportSize({ width: 560, height: 700 }); await reset('**中文加粗** and ==高亮=='); await select(4); await settle();
      await page.screenshot({ path: path.join(output, theme + '.png') });
      assert(await input.locator('.cm-widgetBuffer').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === 'inline')),
        'hidden-delimiter buffers must not inherit block-image layout');
      const layout = await input.evaluate(node => {
        const style = getComputedStyle(node); return { height: node.getBoundingClientRect().height, line: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
      });
      assert(layout.height <= layout.line * 3 + layout.padding + 2, 'three wrapped text lines have no extra blank image-buffer lines');
      const caret = await input.evaluate(node => { const input = node.__noteCellInput; return input.view.coordsAtPos(input.view.state.selection.main.head); });
      const bounds = await cell.boundingBox(); assert(caret && caret.left >= bounds.x && caret.right <= bounds.x + bounds.width, 'caret stays inside cell');
    }
    await settle(); await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.inlineFrames = 0; const original = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => { inlineFrames++; return original(callback); };
    });
    await page.waitForTimeout(350); assert.equal(await page.evaluate(() => inlineFrames), 0, 'idle cells have no recurring RAF');
    await page.evaluate(() => editor.destroy());
    assert.equal(await input.count(), 0, 'destroy releases the child input');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ output, examples: examples.length, passed: true }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

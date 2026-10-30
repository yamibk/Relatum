'use strict';
// Synthetic documents only; all screenshots and persisted fixtures live in TEMP.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { tableInput } = require('./note-table-test-helpers');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-containers-'));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css"><style>body{margin:0}.note-workspace{display:block!important;height:100vh}.note-document-pane{height:100%;margin:0!important;display:flex;flex-direction:column}.note-document-pane::before{display:none}.note-document-body{margin:0!important}#reading{padding:32px}</style></head><body class="start-page" data-start-workspace="notes" data-start-theme="light"><div class="note-workspace"><main class="note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div><div id="reading" hidden></div></div></main></div><script src="markdown-table.js"></script><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script><script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("editor"),{value:"plain",notePath:"containers.md",imageUrl(){return "/pixel.svg"}})</script></body></html>';
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html); }
    if (pathname === '/pixel.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#aaa"/></svg>'); }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1000, height: 1100 }, reducedMotion: 'reduce' });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(10000);
    await page.goto(origin); await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const load = async value => { await page.evaluate(value => {
      document.getElementById('reading').hidden = true; document.getElementById('editor').hidden = false;
      RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading'));
      editor.setSourceMode(false); editor.setDocument({ value, notePath: 'containers.md' }); document.activeElement?.blur();
    }, value); await settle(); };
    const snapshot = () => page.evaluate(() => editor.snapshot().value);
    const read = async () => { await page.evaluate(() => {
      const host = document.getElementById('reading'); host.hidden = false;
      RelatumNoteLiveEditor.renderMarkdown(host, editor.snapshot().value, 'containers.md', { calloutSession: editor.calloutSession });
      document.getElementById('editor').hidden = true;
    }); await settle(); };
    const quoted = '> [!white]\n> # 标题\n>\n> | A | B |\n> | :--- | ---: |\n> | one | two |\n> |three|four|\n>\n> 尾文\n\n外文';
    await load('> [!white]\n> | A | B |\n> | --- | --- |\n> | one | two |\n\n外文');
    await page.locator('td[data-table-row="1"][data-table-col="0"]').click();
    await tableInput(page).fill('首行表格');
    assert((await snapshot()).includes('> | 首行表格 | two |'));
    await load(quoted);
    const table = page.locator('#editor .is-table'), cell = table.locator('td[data-table-row="1"][data-table-col="0"]');
    assert.equal(await table.count(), 1);
    await cell.click(); const input = tableInput(page);
    await input.press('Control+a'); await input.pressSequentially('changed'); await settle();
    assert((await snapshot()).includes('> | changed | two |'));
    assert((await snapshot()).includes('> |three|four|'), 'unmodified row spacing survives typing');
    assert.equal(await input.count(), 1, 'typing retains the active cell');
    const beforeIme = await snapshot(), cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await snapshot(), beforeIme, 'preedit never enters saved Markdown');
    await cdp.send('Input.insertText', { text: '中' }); await settle();
    assert((await snapshot()).includes('changed中'));
    await input.press('Control+z'); await settle(); assert.equal(await snapshot(), beforeIme);
    const current = await snapshot();
    await table.evaluate(dom => { const s = dom.__noteTableSurface; s.alignColumns(0, 0, 'right'); }); await settle();
    assert((await snapshot()).includes('> | ---: | ---: |'));
    await page.evaluate(() => RelatumCodeMirror.undo(editor.view)); await settle(); assert.equal(await snapshot(), current);
    await table.evaluate(dom => { const s = dom.__noteTableSurface; s.write({ ...s.model, rows: [...s.model.rows, ['new', 'row']] }, 'input.table-row'); }); await settle();
    assert((await snapshot()).includes('> | new | row |'));
    assert((await snapshot()).includes('> |three|four|'));
    await page.evaluate(() => RelatumCodeMirror.undo(editor.view)); await settle(); assert.equal(await snapshot(), current);
    await table.evaluate(dom => dom.__noteTableSurface.reorder('row', null, 1, 3)); await settle();
    assert((await snapshot()).indexOf('> |three|four|') < (await snapshot()).indexOf('> | changed | two |'));
    await page.evaluate(() => RelatumCodeMirror.undo(editor.view)); await settle(); assert.equal(await snapshot(), current);
    await table.evaluate(dom => { const s = dom.__noteTableSurface; s.selection = { kind: 'column', r0: 0, r1: 2, c0: 1, c1: 1 }; s.action('delete-column'); }); await settle();
    assert((await snapshot()).includes('> | changed |') && !(await snapshot()).includes('two'));
    await page.evaluate(() => RelatumCodeMirror.undo(editor.view)); await settle(); assert.equal(await snapshot(), current);
    await read(); assert.equal(await page.locator('#reading [data-callout="white"] table').count(), 1);
    assert.equal(await page.locator('#reading [data-callout="white"] h1').innerText(), '标题');
    fs.writeFileSync(path.join(output, 'roundtrip.md'), await snapshot(), { encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(output, 'roundtrip.md'), 'utf8'), current);
    await load(current); await page.evaluate(() => { editor.setSourceMode(true); editor.setSourceMode(false); }); await settle(); assert.equal(await snapshot(), current);
    await page.evaluate(() => { editor.view.dispatch({ selection: { anchor: 0, head: editor.view.state.doc.length } }); editor.focus(); });
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), current);
    await page.keyboard.press('Control+x'); assert.equal(await snapshot(), '');
    await page.keyboard.press('Control+z'); assert.equal(await snapshot(), current, 'a cross-block cut restores in one undo');

    const mixed = '> [!white] **卡片标题**\n> 正文 **加粗** 与 [链接](https://example.com)。\n>\n> - [ ] 任务\n>\n> ![示意图|160](image.svg)\n>\n> ```js\n> const value = 1;\n> ```\n>\n> ---\n>\n> 结束\n\n外文';
    await load(mixed);
    assert.equal(await page.locator('#editor .is-image').count(), 1);
    assert.equal(await page.locator('#editor .is-rule').count(), 1);
    assert.equal(await page.locator('#editor .note-live-code-language').count(), 1);
    await page.locator('#editor .note-live-code-language').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const value = 1;');
    assert.equal(await snapshot(), mixed);
    const imageFrame = page.locator('#editor .note-live-image-frame.is-block');
    await imageFrame.click({ position: { x: 30, y: 20 } });
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await imageFrame.click({ position: { x: 75, y: 25 } });
    await page.locator('.note-image-text-editor').fill('容器图片文字');
    await page.locator('.note-image-text-editor').press('Control+Enter'); await settle();
    assert((await snapshot()).split('\n').some(line => line.startsWith('> ![示意图') && line.includes('relatum:image-text:v1:')));
    assert((await snapshot()).endsWith('\n\n外文'));
    await page.evaluate(() => editor.setImageTextMode(false));
    await read(); assert.equal(await page.locator('#reading .md-callout-body img').count(), 1);
    assert.equal(await page.locator('#reading .md-callout-body pre').count(), 1);

    const nested = '> [!white]\n> # 一级标题\n>\n> > [!blue] 内层\n> >\n> > > [!white]\n> > > | A | B |\n> > > | --- | --- |\n> > > | 1 | 2 |\n> > >\n> > > 正文自然换行，保留完整祖先背景与卡片边界。\n\n外文';
    let matrix = 0;
    for (const skin of ['default', 'claude', 'sky', 'apple']) for (const mode of ['light', 'dark']) for (const width of [1000, 520]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(({ skin, mode }) => { document.documentElement.dataset.noteTheme = skin; document.body.dataset.startTheme = mode; }, { skin, mode });
      await load(nested);
      assert.equal(await page.locator('#editor .is-table.note-live-callout-layered').count(), 1);
      assert(await page.locator('#editor .is-table').evaluate(n => getComputedStyle(n).backgroundImage.includes('gradient')));
      await page.screenshot({ path: path.join(output, `${skin}-${mode}-${width}-live.png`) });
      await read();
      const card = page.locator('#reading [data-callout="white"]').first();
      assert.equal(await card.evaluate(n => getComputedStyle(n).borderLeftWidth), '1px');
      assert.equal(await page.locator('#reading [data-callout="blue"] [data-callout="white"] table').count(), 1);
      if (mode === 'light') assert.equal(await card.evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(output, `${skin}-${mode}-${width}-reading.png`) }); matrix++;
    }
    await load('> [!white]- **折叠**\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n> ![图](image.svg)\n\n外文');
    assert.equal(await page.locator('#editor .is-table, #editor .is-image').count(), 0);
    await page.locator('#editor .note-callout-fold').click(); await settle();
    assert.equal(await page.locator('#editor .is-table').count(), 1);
    await read(); assert.equal(await page.locator('#reading .note-callout-fold').getAttribute('aria-expanded'), 'true');

    await page.setViewportSize({ width: 1000, height: 1100 });
    await page.evaluate(() => { window.RelatumNoteCanvas = { mount(frame, options) {
      frame.__containerOptions = options;
      return { update(next) { frame.__containerOptions = next; }, destroy() {} };
    } }; });
    await load('> [!white]\n> ![图.canvas|640x360](canvases/test.canvas)\n\n外文');
    await page.waitForFunction(() => document.querySelector('#editor .is-canvas .note-live-image-frame')?.__containerOptions);
    await page.evaluate(() => document.querySelector('#editor .is-canvas .note-live-image-frame').__containerOptions.resize(400, 200)); await settle();
    assert((await snapshot()).includes('> ![图.canvas|400x200](canvases/test.canvas)'));
    await read(); assert.equal(await page.locator('#reading .note-live-image-frame').count(), 1);

    await load('> [!white]\n> ```quiz\n> 选择题\n>\n> - [ ] A\n> - [x] B\n> ```\n\n外文');
    await page.waitForSelector('#editor .note-quiz');
    assert.equal(await page.locator('#editor .is-quiz.note-live-callout-layered').count(), 1);
    assert((await snapshot()).includes('> - [x] B'));
    await read(); await page.waitForSelector('#reading [data-callout="white"] .note-quiz');

    await load('> [!white]\n> ```mermaid\n> graph LR\n> A-->B\n> ```\n\n外文');
    await page.waitForSelector('#editor .mermaid-diagram svg');
    assert.equal(await page.locator('#editor .is-mermaid.note-live-callout-layered').count(), 1);
    await read(); await page.waitForSelector('#reading [data-callout="white"] .mermaid-diagram svg');

    const mathRequests = [];
    page.on('request', req => { if (req.url().includes('/mathjax/')) mathRequests.push(req.url()); });
    await load('> [!white]- 折叠公式\n> $$x^2$$\n\n外文');
    await read(); await settle();
    assert.equal(mathRequests.length, 0, 'folded reading math keeps MathJax cold');
    await page.locator('#reading .note-callout-fold').click();
    await page.waitForSelector('#reading .md-callout-body mjx-container');
    await load('> [!white]\n> $$x^2$$');
    await page.waitForSelector('#editor .is-math mjx-container');
    assert.equal(await page.locator('#editor .is-math.note-live-callout-layered').count(), 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, matrix, tableEdits: true, ime: true, roundtrip: true, nested: true, errors }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });

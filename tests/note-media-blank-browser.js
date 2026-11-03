'use strict';
// Production assets, synthetic Markdown and disposable browser data only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-blank-'));
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-media.js', 'note-live-editor.js'];
const html = '<!doctype html><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css">'
  + '<style>body{margin:0;display:block}.note-workspace{display:block!important;height:100vh}.note-document-pane{height:100%;margin:0!important}.note-document-pane::before{display:none}.note-document-body{height:100%;margin:0!important}.note-live-editor-host{width:min(960px,100vw);height:100vh;margin:auto}</style>'
  + '<body class="start-page" data-start-theme="light" data-start-workspace="notes"><main class="note-workspace"><section class="note-document-pane"><div class="note-document-body"><div id="host" class="note-live-editor-host"></div></div></section></main>'
  + scripts.map(file => '<script src="' + file + '"></script>').join('')
  + '<script>const createMedia=RelatumNoteMedia.createController;window.RelatumNoteMedia={...RelatumNoteMedia,createController(options){const wait=options.whenMediaInputSettled;options.whenMediaInputSettled=()=>Promise.all([wait(),window.placementGate]);return createMedia(options)}};'
  + 'window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"blank.md",imageUrl:()=>"/image.svg",onOpenExternal:url=>window.openedURL=url});</script>';
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html); }
  if (name === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1200"><rect width="400" height="1200" fill="#ddd"/></svg>'); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
});
(async () => {
  const report = { matrix: [], cases: [], errors: [] }; let browser, page;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' }); page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.stack));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.editor);
    const pause = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const source = (body = '', prefix = '> ') => prefix + '[!media]\n' + prefix + '![image|200](image.svg)\n' + prefix.trimEnd() + '\n' + body.split('\n').map(row => prefix + row).join('\n');
    const load = async (body = '', prefix) => {
      const value = source(body, prefix);
      await page.evaluate(value => editor.setDocument({ value, notePath: 'blank.md' }), value);
      await page.locator('.note-media-image img').waitFor(); await pause(); return value;
    };
    const open = async () => { await page.locator('.note-media-body').click({ position: { x: 12, y: 8 } }); await page.locator('.note-media-input').waitFor(); await pause(); };
    const value = () => page.evaluate(() => editor.snapshot().value);
    const body = () => page.evaluate(() => MarkdownMini.parseMediaBlock(editor.snapshot().value)?.body);
    const rowPoint = row => page.locator('.note-media-body').evaluate((dom, row) => {
      const rect = dom.getBoundingClientRect(), step = parseFloat(getComputedStyle(dom).lineHeight) * (document.getElementById('host').getBoundingClientRect().width / document.getElementById('host').offsetWidth);
      return { x: rect.x + rect.width * .7, y: rect.y + (row - .5) * step };
    }, row);
    const afterPoint = rows => page.locator('.note-media').evaluate((root, rows) => {
      const input = root.__noteMedia.input, rect = root.querySelector('.note-media-body').getBoundingClientRect(); input.posAtCoords({ x: rect.x + 10, y: rect.y + 5 }, false);
      const step = parseFloat(getComputedStyle(input.contentDOM).lineHeight) * input.scaleY;
      return { x: rect.x + rect.width * .7, y: input.documentTop + input.lineBlockAt(input.state.doc.length).bottom + (rows - .5) * step };
    }, rows);
    const click = async point => { await page.mouse.click(point.x, point.y); await pause(); };
    const caret = () => page.locator('.note-media').evaluate(root => { const input = root.__noteMedia.input, at = input.state.selection.main.head, line = input.state.doc.lineAt(at); return { line: line.number, column: at - line.from }; });
    const empty = await load(); await open(); assert.equal(await value(), empty, 'first-line click only places the caret');
    const third = await rowPoint(3); await click(third); assert.equal(await body(), '\n\n'); assert.deepEqual(await caret(), { line: 3, column: 0 });
    await click(third); assert.equal(await body(), '\n\n', 'clicking an existing empty line does not append again');
    await page.keyboard.type('hello'); assert.equal(await body(), '\n\nhello');
    await page.keyboard.press('Control+z'); await pause(); assert.equal(await body(), '\n\n', 'typing is separate from blank insertion');
    await page.keyboard.press('Control+z'); await pause(); assert.equal(await value(), empty, 'one undo removes the complete blank insertion');
    await page.keyboard.press('Control+y'); await pause(); assert.equal(await body(), '\n\n');
    await page.keyboard.press('Escape'); await pause(); assert.equal(await body(), '\n\n', 'leaving editing keeps blank lines');
    await load(); await click(await rowPoint(3)); assert.equal(await body(), '\n\n', 'first click can append from static preview');
    report.cases.push('first/repeated click, undo/redo, history separation, preview');

    for (const caption of ['ONE', 'ONE\n\n', '## Heading', '- item', 'wrap text '.repeat(30)]) {
      await load(caption); await open(); await click(await afterPoint(2));
      assert.equal(await body(), caption + '\n\n', caption); assert.equal((await caret()).column, 0);
    }
    await load('wrap text '.repeat(30)); await open(); const wrapped = await value(); await click(await rowPoint(2)); assert.equal(await value(), wrapped, 'wrapped visual rows are existing text');
    await load('nested', '> > '); await open(); await click(await afterPoint(2)); assert.equal(await value(), source('nested\n\n', '> > '), 'newlines retain the complete quote prefix');
    report.cases.push('existing/wrapped text, trailing blanks, heading/list, nested quote');

    for (const modifier of ['Shift', 'Control', 'Alt', 'Meta']) {
      await load(); await open(); await page.keyboard.down(modifier); await click(await rowPoint(3)); await page.keyboard.up(modifier); assert.equal(await body(), '');
    }
    await load(); const drag = await rowPoint(3); await page.mouse.move(drag.x, drag.y); await page.mouse.down(); await page.mouse.move(drag.x + 20, drag.y + 20, { steps: 4 }); await page.mouse.up(); await pause(); assert.equal(await body(), '', 'dragging is not a blank click');
    await load('[link](https://example.com)'); await page.locator('.note-media-body a').click(); assert.equal(await body(), '[link](https://example.com)'); assert.equal(await page.evaluate(() => openedURL), 'https://example.com');
    await load(); const protectedSource = await value(); await page.locator('.note-media-image .note-live-image-frame').click(); assert.equal(await value(), protectedSource);
    const cdp = await context.newCDPSession(page);
    await load(); await open(); await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await click(await rowPoint(3)); assert.equal(await body(), '', 'preedit and requested blanks are not saved early');
    await cdp.send('Input.insertText', { text: '中' }); await page.waitForFunction(() => MarkdownMini.parseMediaBlock(editor.snapshot().value)?.body === '中\n\n');
    await page.keyboard.press('Control+z'); await pause(); assert.equal(await body(), '中', 'blank insertion and IME commit undo independently');
    report.cases.push('modifiers, drag, links/images, native Chromium preedit');

    for (const cancel of ['new-click', 'switch', 'hidden', 'hide-restore']) {
      await load(); await open(); await page.evaluate(() => { window.placementGate = new Promise(resolve => window.releasePlacement = resolve); });
      await click(await rowPoint(3)); assert.equal(await body(), '');
      if (cancel === 'new-click') await click(await rowPoint(1));
      else if (cancel === 'switch') await page.evaluate(() => editor.setDocument({ value: '# Other', notePath: 'other.md' }));
      else await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
      if (cancel === 'hide-restore') await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
      await page.evaluate(() => { releasePlacement(); window.placementGate = undefined; }); await pause(); await pause();
      if (cancel === 'switch') assert.equal(await value(), '# Other'); else assert.equal(await body(), '');
      await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    }
    // Force the automatic operation over its budget without changing the
    // existing valid source or requiring a physically enormous image.
    await load(); await open(); const limited = await value();
    await page.locator('.note-media').evaluate(root => {
      const surface = root.__noteMedia, input = surface.input, step = parseFloat(getComputedStyle(input.contentDOM).lineHeight) * input.scaleY;
      surface.place({ x: root.getBoundingClientRect().right - 30, y: input.documentTop + input.lineBlockAt(input.state.doc.length).bottom + 100000 * step }, true);
    });
    assert.equal(await value(), limited, 'oversized automatic insertion leaves source intact');
    report.cases.push('late-click cancellation, document/visibility handoff, size limit');

    for (const standalone of [false, true]) {
      if (standalone) { await page.addStyleTag({ url: '/assets/markdown-file.css' }); await page.evaluate(() => document.body.classList.add('markdown-window')); }
      for (const theme of ['default', 'claude', 'sky', 'apple']) for (const dark of [false, true]) for (const narrow of [false, true]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: narrow ? 480 : 1280, height: 1100 });
        await page.evaluate(({ theme, dark, scale }) => { document.documentElement.dataset.noteTheme = theme; document.body.dataset.startTheme = dark ? 'dark' : 'light'; document.querySelector('.note-document-pane').style.setProperty('--note-font-scale', scale); }, { theme, dark, scale });
        await load(); await page.evaluate(() => document.fonts.ready); await pause();
        if (narrow) {
          const size = await page.locator('.note-media-body').evaluate(dom => ({ height: dom.getBoundingClientRect().height, line: parseFloat(getComputedStyle(dom).lineHeight) }));
          assert(size.height <= size.line + 1, JSON.stringify(size)); await click(await rowPoint(1)); assert.equal(await body(), '');
        } else { await click(await rowPoint(3)); assert.equal(await body(), '\n\n'); assert.deepEqual(await caret(), { line: 3, column: 0 }); }
        report.matrix.push({ standalone, theme, dark, narrow, scale });
      }
    }
    await page.setViewportSize({ width: 1280, height: 1100 }); await load();
    await page.evaluate(() => document.getElementById('host').style.transform = 'scale(.8)'); await pause(); await click(await rowPoint(3)); assert.equal(await body(), '\n\n', 'transformed host uses screen-space line height');
    await page.evaluate(() => document.getElementById('host').style.transform = '');
    await page.screenshot({ path: path.join(output, 'blank-click.png') });
    await load(); await open(); await page.evaluate(() => { window.placementGate = new Promise(resolve => window.releasePlacement = resolve); });
    await click(await rowPoint(3)); await page.evaluate(() => { editor.destroy(); releasePlacement(); }); await pause();
    assert.equal(await page.locator('#host').textContent(), '', 'destroy cancels pending placement');
    assert.deepEqual(report.errors, []);
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, state: await page.evaluate(() => ({ value: window.editor?.snapshot().value, html: document.getElementById('host')?.innerHTML })).catch(() => null) }, null, 2)); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve)); console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

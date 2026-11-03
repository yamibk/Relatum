'use strict';
// Static assets and synthetic notes only. Artifacts go to this run's TEMP folder.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-'));
const block = '> [!media]\n> ![测试|240](image.svg)\n>\n> **说明标题**\n> 第一行说明。\n> 第二行说明。\n>\n> - 第一项\n> - 第二项';
const source = '前文\n\n' + block + '\n\n后文';
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-media.js', 'note-live-editor.js', 'note-guide.js'];
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css"><style>body{margin:0}.note-workspace{display:block!important;height:100vh}.note-document-pane{height:100%;margin:0!important;display:flex;flex-direction:column}.note-document-pane::before{display:none}.note-document-body{margin:0!important}#reading,#guide{padding:24px;overflow:auto}[hidden]{display:none!important}</style></head><body class="start-page" data-start-theme="light" data-start-workspace="notes"><main class="note-workspace note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div><div id="reading" hidden></div><div id="guide" hidden></div></div></main>' + scripts.map(name => '<script src="' + name + '"></script>').join('') + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("editor"),{value:"",notePath:"media.md",imageUrl:()=>"/image.svg",onOpenExternal:target=>window.opened=target});</script></body></html>';
(async () => {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html); }
    if (name === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#987b6e"/><circle cx="350" cy="80" r="35" fill="#d9c99f"/></svg>'); }
    const file = path.resolve(repo, '.' + name);
    if (!name.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser, page;
  const errors = [], matrix = [], requests = [], performanceChecks = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] }); page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.stack)); page.on('request', request => requests.push(request.url()));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const value = () => page.evaluate(() => editor.snapshot().value);
    const load = async text => { await page.evaluate(text => { editor.setSourceMode(false); editor.setDocument({ value: text, notePath: 'media.md' }); document.getElementById('editor').hidden = false; document.getElementById('reading').hidden = true; document.getElementById('guide').hidden = true; }, text); await settle(); };
    await load(source); await page.locator('#editor .note-media-image img').waitFor(); await settle();
    assert.equal(await page.locator('#editor .note-media').count(), 1, JSON.stringify(errors));
    const restricted = '> [!media]\n> ![测试|240](image.svg)\n>\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n> $$\n> x^2\n> $$\n> ![other](other.png)';
    const restrictedSpecs = await page.evaluate(source => RelatumNoteLiveSyntax.scanBlockSpecsFromString(source).map(spec => spec.kind), restricted);
    assert.deepEqual(restrictedSpecs, ['media'], 'a media block owns its source; fallback scanners must not mount hidden rich children');
    await load(restricted); assert.equal(await page.locator('#editor .note-media').count(), 1); assert.equal(await page.locator('#editor .is-table, #editor .is-math').count(), 0);
    const distant = 'A distant paragraph for viewport discovery.\n\n'.repeat(8000) + source;
    await load(distant); assert.equal(await page.locator('#editor .note-media').count(), 0);
    await page.evaluate(() => { const value = editor.snapshot().value, at = value.indexOf('第一行说明'); editor.revealPosition(at, { end: at + 5, align: 'start' }); });
    await page.locator('#editor .note-media-input').waitFor({ timeout: 2500 });
    assert.equal(await page.locator('#editor .note-media').evaluate(root => { const input = root.__noteMedia.input, range = input.state.selection.main; return input.state.doc.sliceString(range.from, range.to); }), '第一行说明');
    await load(source);
    await page.screenshot({ path: path.join(output, 'initial.png') });
    const input = () => page.locator('#editor .note-media-input .cm-content');
    await page.locator('#editor .note-media-body').click(); await input().waitFor();
    assert.notEqual(await input().locator('.cm-line').first().evaluate(line => getComputedStyle(line, '::selection').backgroundColor), 'rgba(0, 0, 0, 0)', 'native child selection must stay visible above the parent selection theme');
    await input().press('Control+End'); await input().press('Enter'); await input().pressSequentially('new line'); await settle();
    assert((await value()).includes('> - new line'), await value());
    const entered = await value(); await input().press('Control+z'); await settle(); assert.notEqual(await value(), entered);
    await input().press('Control+y'); await settle(); assert.equal(await value(), entered);
    const cdp = await context.newCDPSession(page), beforeIme = await value();
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); assert.equal(await value(), beforeIme);
    await cdp.send('Input.insertText', { text: '中' }); await page.waitForFunction(() => !editor.inputPending); await settle();
    assert((await value()).includes('new line中')); await input().press('Control+z'); await settle(); assert.equal(await value(), beforeIme);
    assert.equal(await page.evaluate(() => editor.inputPending), false);
    await input().press('Control+Enter'); await page.keyboard.type('outside'); await settle(); assert((await value()).includes('\noutside'));
    await load(source);
    const frame = page.locator('#editor .note-media-image .note-live-image-frame'); await frame.click();
    const handle = frame.locator('.note-live-image-resize-handle'); await handle.waitFor(); const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 135, box.y, { steps: 8 }); await page.mouse.up(); await settle();
    assert.notEqual(await value(), source); const resized = await value(); assert(resized.includes('第一行说明。')); await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source);
    for (const theme of ['default', 'claude', 'sky', 'apple']) for (const dark of [false, true]) for (const narrow of [false, true]) {
      await page.setViewportSize({ width: narrow ? 480 : 1400, height: 1000 }); await load(source);
      await page.evaluate(({ theme, dark }) => { document.documentElement.dataset.noteTheme = theme; document.body.dataset.startTheme = dark ? 'dark' : 'light'; }, { theme, dark }); await settle();
      const geometry = await page.locator('#editor .note-media').evaluate(root => {
        const image = root.querySelector('.note-media-image').getBoundingClientRect(), body = root.querySelector('.note-media-body').getBoundingClientRect(), rect = root.getBoundingClientRect();
        return { image: { x: image.x, y: image.y, width: image.width, height: image.height }, body: { x: body.x, y: body.y, width: body.width, height: body.height }, width: rect.width, overflow: root.scrollWidth - root.clientWidth, background: getComputedStyle(root).backgroundColor };
      });
      assert(geometry.overflow <= 1, JSON.stringify(geometry)); assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
      if (narrow) assert(geometry.body.y > geometry.image.y + geometry.image.height - 1, JSON.stringify(geometry)); else assert(Math.abs(geometry.image.y - geometry.body.y) <= 1, JSON.stringify(geometry));
      matrix.push({ theme, dark, narrow, geometry });
      await page.evaluate(() => { const reading = document.getElementById('reading'); reading.hidden = false; RelatumNoteLiveEditor.renderMarkdown(reading, editor.snapshot().value, 'media.md', { imageUrl: () => '/image.svg' }); document.getElementById('editor').hidden = true; }); await settle();
      assert.equal(await page.locator('#reading .note-media').count(), 1); assert((await page.locator('#reading .note-media-body').innerHTML()).includes('<br>'));
      if (theme === 'apple' && !dark && !narrow || theme === 'sky' && dark && narrow) await page.screenshot({ path: path.join(output, theme + '-' + dark + '-' + narrow + '.png') });
    }
    await page.setViewportSize({ width: 1400, height: 1000 }); await load('![图|180](image.svg)'); await page.locator('#editor .note-live-image-frame').click();
    assert(await page.evaluate(() => editor.queryCommand('image:media', editor.commandContext()).enabled));
    await page.evaluate(() => editor.executeCommand('image:media', editor.commandContext())); await input().waitFor(); assert((await value()).startsWith('> [!media]\n> ![图|180]'));
    await input().pressSequentially('description'); await settle(); assert((await value()).endsWith('> description'));
    await input().press('Control+z'); await settle(); await input().press('Control+z'); await settle(); assert.equal(await value(), '![图|180](image.svg)');
    const long = '> [!media]\n> ![测试|240](image.svg)\n>\n> ' + '自动折行1234567890'.repeat(80);
    await load(long); await page.locator('#editor .note-media-body').click(); await input().waitFor();
    await input().press('Control+Home'); await input().press('Backspace'); assert.equal(await value(), long, 'body boundary Backspace never removes the image or container');
    await input().press('Control+a'); await input().press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '自动折行1234567890'.repeat(80));
    await page.setViewportSize({ width: 700, height: 1000 }); await settle(); assert.equal(await value(), long, 'visual wrapping does not add source newlines');
    const wrap = await input().evaluate(dom => ({ overflow: dom.scrollWidth - dom.clientWidth, lines: dom.children.length, height: dom.clientHeight })); assert(wrap.overflow <= 1); assert.equal(wrap.lines, 1); assert(wrap.height > 100);
    await page.setViewportSize({ width: 1400, height: 1000 }); await load(source); await frame.click();
    await page.keyboard.press('Delete'); await settle(); assert(!(await value()).includes('[!media]')); assert((await value()).includes('第一行说明。')); await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source);
    await page.evaluate(() => { const value = editor.snapshot().value, from = value.indexOf('> [!media]'), to = value.indexOf('\n\n后文'); editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.range(from, to) }); editor.view.focus(); });
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), block);
    await page.keyboard.press('Delete'); await settle(); assert(!(await value()).includes('第一行说明。')); await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), source);
    await frame.click(); const beforeCancel = await frame.boundingBox(), cancelHandle = await handle.boundingBox();
    await page.mouse.move(cancelHandle.x + 3, cancelHandle.y + 3); await page.mouse.down(); await page.mouse.move(cancelHandle.x + 90, cancelHandle.y); await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
    assert.equal(await value(), source); assert(Math.abs((await frame.boundingBox()).width - beforeCancel.width) <= 1);
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); }); await frame.click({ position: { x: 80, y: 60 } });
    const imageText = page.locator('.note-image-text-editor'); await imageText.fill('图内文字'); await imageText.press('Control+Enter'); await settle();
    assert((await value()).includes('relatum:image-text:')); assert((await value()).includes('第一行说明。')); assert.deepEqual(await page.evaluate(() => editor.imageTextRenderedLines()), [4]);
    await page.evaluate(() => editor.setImageTextMode(false));
    const annotated = await value(); await page.evaluate(() => editor.setSourceMode(true)); await page.evaluate(() => editor.setSourceMode(false)); await settle(); assert.equal(await value(), annotated); assert.equal(await page.locator('.note-media .note-image-text-box').count(), 1);
    for (const lineCount of [8, 360]) {
      const body = Array.from({ length: lineCount }, (_, i) => 'line ' + i + ' ' + '普通说明1234567890'.repeat(38)).join('\n');
      await load('before\n\n> [!media]\n> ![测试|240](image.svg)\n>\n' + body.split('\n').map(line => '> ' + line).join('\n') + '\n\nafter');
      await page.locator('#editor .note-media-body').click({ position: { x: 15, y: 15 } }); await input().waitFor(); await settle();
      const result = await page.evaluate(() => {
        const md = MarkdownMini, parse = md.parseMediaBlock, literal = md.mediaLiteralLines, surface = document.querySelector('#editor .note-media').__noteMedia;
        let parses = 0, literals = 0; md.parseMediaBlock = function(...args) { parses++; return parse.apply(this, args); }; md.mediaLiteralLines = function(...args) { literals++; return literal.apply(this, args); };
        const start = performance.now();
        try {
          for (let i = 0; i < 40; i++) { surface.input.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(10 + i % 15) }); editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(i % 2) }); }
          return { bytes: new TextEncoder().encode(surface.model.body).length, milliseconds: performance.now() - start, parses, literals };
        } finally { md.parseMediaBlock = parse; md.mediaLiteralLines = literal; }
      });
      assert.equal(result.parses, 0, 'selection-only updates reuse the parsed media model'); assert.equal(result.literals, 0, 'selection-only updates reuse the child document literal map'); performanceChecks.push(result);
    }
    await load(source); await settle(); await page.waitForTimeout(100);
    const idle = await page.evaluate(() => { const dispatch = editor.view.dispatch, start = performance.now(); let updates = 0; editor.view.dispatch = function(...args) { updates++; return dispatch.apply(this, args); }; return new Promise(resolve => setTimeout(() => { editor.view.dispatch = dispatch; resolve({ updates, milliseconds: performance.now() - start }); }, 300)); });
    assert.equal(idle.updates, 0, 'stable idle media must not dispatch recurring layout work'); performanceChecks.push({ idle });
    await load(source); await page.locator('#editor .note-media-body').click(); await input().waitFor();
    await page.evaluate(() => { const surface = document.querySelector('#editor .note-media').__noteMedia; surface.input.dispatch({ changes: { from: 0, to: surface.input.state.doc.length, insert: 'x'.repeat(70 * 1024) } }); });
    await settle(); assert((await value()).includes('x'.repeat(70 * 1024)), 'oversized edits remain in Markdown when rich projection falls back');
    for (const language of ['zh-CN', 'en']) {
      await page.evaluate(language => { document.documentElement.lang = language; document.getElementById('editor').hidden = true; const host = document.getElementById('guide'); host.hidden = false; window.mediaGuide?.destroy(); window.mediaGuide = RelatumNoteGuide.create({ host, language: () => language === 'en' ? 'en' : 'zh', isCurrent: () => true }); mediaGuide.show('media'); }, language);
      assert.equal(await page.locator('#guide .note-media').count(), 1); assert((await page.locator('#guide pre').textContent()).includes('[!media]'));
    }
    assert.deepEqual(errors, []); assert(!requests.some(url => /mathjax|mermaid|pele/i.test(url)), 'plain descriptions never load math or diagram runtimes');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await load('> [!media]\n> ![测试|240](image.svg)\n>\n> 公式 $x^2+1$');
    await page.waitForTimeout(100); assert(!requests.some(url => /mathjax|mermaid|pele/i.test(url)), 'minimized media does not start formula runtimes');
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility')); });
    await page.locator('#editor .note-media-body mjx-container').waitFor({ timeout: 30000 });
    await page.locator('#editor .note-media-body').click(); await input().waitFor(); await input().press('Control+End'); await input().press('Enter'); await input().pressSequentially('after math'); await input().press('Escape');
    await page.locator('#editor .note-media-body mjx-container').waitFor(); assert((await value()).includes('> after math'));
    await load(source); await settle(); assert.equal(await page.locator('#editor mjx-container').count(), 0); assert.deepEqual(errors, []);
    const nested = '> [!white]\n> before\n>\n> > [!media]\n> > ![测试|180](image.svg)\n> >\n> > nested body\n>\n> after';
    await load(nested); assert.equal(await page.locator('#editor .note-media.note-live-callout-layered').count(), 1);
    await page.locator('#editor .note-media-body').click(); await input().waitFor(); await input().press('Control+End'); await input().press('Enter'); await input().pressSequentially('nested line'); await settle(); assert((await value()).includes('> > nested line'));
    await page.addStyleTag({ url: '/assets/markdown-file.css' });
    await page.evaluate(() => { document.body.classList.add('markdown-window'); document.querySelector('main').classList.add('markdown-root'); });
    await load(source); await page.locator('#editor .note-media-body').click(); await input().waitFor(); await input().press('Control+End'); await input().press('Enter'); await input().pressSequentially('file window'); await settle(); assert((await value()).includes('> - file window'));
    const standalone = await input().evaluate(dom => ({ content: dom.clientHeight, scroll: dom.parentElement.getBoundingClientRect().height })); assert(Math.abs(standalone.content - standalone.scroll) <= 2); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ matrix, performanceChecks, errors }, null, 2)); console.log('note media browser: ok ' + output);
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, state: await page.evaluate(() => ({ value: window.editor?.snapshot().value, html: document.getElementById('editor')?.innerHTML })).catch(() => null) }, null, 2)); }
    console.error(output); throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

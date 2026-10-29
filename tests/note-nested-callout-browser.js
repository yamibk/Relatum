'use strict';
// Synthetic notes only. Inspect actual native line paint, caret coordinates and
// the reading DOM; never open or save a user's notebook.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const sharp = require(process.env.RELATUM_SHARP || 'sharp');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-nested-callout-'));
const lazy = '> [!indigo]\n> Outer text\n> > [!cyan]\n> Inner body wraps naturally when the window becomes narrow. 中文嵌套正文。\n\nafter';
const strict = lazy.replace('> Inner body', '> > Inner body');
const html = '<!doctype html><html><head><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css"><style>body{margin:0}.note-workspace{height:100vh;display:block!important}.note-document-pane{height:100%;display:flex;flex-direction:column;margin:0!important}.note-document-pane::before{display:none}.note-document-body{margin:0!important}#reading{padding:40px}</style></head><body class="start-page" data-start-workspace="notes" data-start-theme="light"><div class="note-workspace"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div><div id="reading" hidden></div></div></main></div><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script><script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("editor"),{value:"plain",notePath:"nested.md"});</script></body></html>';
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html); }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const load = async source => {
      await page.evaluate(source => {
        document.getElementById('editor').hidden = false; document.getElementById('reading').hidden = true;
        editor.setSourceMode(false); editor.setDocument({ value: source, notePath: 'nested.md' });
        document.activeElement?.blur();
      }, source); await settle();
    };
    const reading = async () => {
      await page.evaluate(() => {
        const host = document.getElementById('reading'); host.hidden = false;
        RelatumNoteLiveEditor.renderMarkdown(host, editor.snapshot().value, 'nested.md', { calloutSession: editor.calloutSession });
        document.getElementById('editor').hidden = true;
      }); await settle();
    };
    for (const skin of ['default', 'claude', 'sky', 'apple']) for (const mode of ['light', 'dark']) for (const width of [1000, 520]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ skin, mode }) => { document.documentElement.dataset.noteTheme = skin; document.body.dataset.startTheme = mode; }, { skin, mode });
      for (const source of [lazy, strict]) {
        await load(source);
        const row = page.locator('.cm-line.note-live-callout-layered').filter({ hasText: 'Inner body' });
        assert.equal(await row.count(), 1, 'nested body remains one native editable line');
        const geometry = await row.evaluate(n => {
          const s = getComputedStyle(n), r = n.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, background: s.backgroundImage, pl: parseFloat(s.paddingLeft), pt: parseFloat(s.paddingTop), pb: parseFloat(s.paddingBottom) };
        });
        assert(geometry.background.includes('radial-gradient') && geometry.pl === 40 && geometry.pt >= 24 && geometry.pb >= 24, JSON.stringify({ skin, mode, width, geometry }));
        const buffer = await page.screenshot({ path: path.join(output, skin + '-' + mode + '-' + width + '.png') });
        const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x, y) => Array.from(data.subarray((Math.round(y) * info.width + Math.round(x)) * info.channels, (Math.round(y) * info.width + Math.round(x)) * info.channels + 3));
        const descriptor = await page.evaluate(mode => ['indigo', 'cyan'].map(type => MarkdownMini.noteBlock(type).style.match(new RegExp('--note-block-bg-' + mode + ':(#[A-Fa-f0-9]+)'))[1]), mode);
        const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
        assert.deepEqual(pixel(geometry.left + 5, geometry.top + geometry.pt + 7), rgb(descriptor[0]), 'outer background survives beside the inner block');
        assert.deepEqual(pixel(geometry.right - 30, geometry.top + geometry.pt + 7), rgb(descriptor[1]), 'inner background paints inside its inset');
        assert.deepEqual(pixel((geometry.left + geometry.right) / 2, geometry.bottom - 5), rgb(descriptor[0]), 'outer background closes underneath inner block');
        await reading();
        assert(await page.locator('#reading [data-callout="indigo"] > .md-callout-body > [data-callout="cyan"]').innerText().then(text => text.includes('Inner body')), 'both prefix spellings put the same body inside the child in reading mode');
        assert.equal(await page.locator('#reading > article > [data-callout]').count(), 1);
        assert.equal(await page.evaluate(() => editor.snapshot().value), source);
      }
    }
    await page.setViewportSize({ width: 1000, height: 900 });
    await load('> [!indigo]\n> Outer\n> > [!cyan]\n> > Inner\n> > > [!green]\n> > > Third\n>\n> Outer again\n\n> [!cyan]\n> Separate\n\nafter');
    assert.equal(await page.locator('.cm-line').filter({ hasText: 'Third' }).evaluate(n => getComputedStyle(n).paddingLeft), '56px');
    await reading();
    assert.equal(await page.locator('#reading [data-callout="indigo"] [data-callout="cyan"] [data-callout="green"]').count(), 1);
    assert(!(await page.locator('#reading [data-callout="cyan"]').first().innerText()).includes('Outer again'));
    assert.equal(await page.locator('#reading > article > [data-callout]').count(), 2);
    await load('> [!indigo]+ Outer\n> > [!cyan]- Inner\n> > hidden\n\nafter');
    const fold = page.locator('.note-live-callout-title-widget').filter({ hasText: 'Inner' }).locator('button');
    await fold.click(); await settle(); assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    await fold.focus(); await page.keyboard.press('Space'); await settle(); assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    await reading(); assert.equal(await page.locator('#reading [data-callout="cyan"] button').getAttribute('aria-expanded'), 'false');
    await load('> [!indigo]\n> Outer\n> > [!cyan]\n> > $$x^2$$\n\nafter');
    await page.waitForFunction(() => document.querySelector('.note-live-rich-block.is-math mjx-container'));
    assert(await page.locator('.note-live-rich-block.is-math').evaluate(n => n.classList.contains('note-live-callout-layered') && getComputedStyle(n).backgroundImage.includes('radial-gradient')));
    await page.screenshot({ path: path.join(output, 'nested-math.png') });
    await page.evaluate(() => editor.view.dispatch({ changes: { from: 4, to: 10, insert: 'red' }, userEvent: 'input.type' }));
    await settle();
    assert(await page.locator('.note-live-rich-block.is-math:not(.note-live-math-preview)').evaluate(n => n.style.getPropertyValue('--note-callout-layers-light').includes(MarkdownMini.noteBlock('red').style.match(/--note-block-bg-light:(#[A-Fa-f0-9]+)/)[1])), 'a parent color edit refreshes the formula ancestor paint');
    await load('> [!indigo]\n> > [!cyan]\n> > $$x^2$$\n\nafter');
    await page.waitForFunction(() => document.querySelector('.note-live-rich-block.is-math mjx-container'));
    await page.evaluate(() => { editor.view.dispatch({ selection: { anchor: editor.snapshot().value.indexOf('x^2') + 1 } }); editor.focus(); });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview mjx-container'));
    assert.equal(await page.locator('.cm-line').filter({ hasText: 'x^2' }).evaluate(n => getComputedStyle(n).paddingBottom), '0px', 'the source continues into its preview without closing the ancestor layers early');
    assert.equal(await page.locator('.note-live-math-preview').evaluate(n => getComputedStyle(n).paddingBottom), '24px');
    await load('---\ntags: sample\n---\n\n' + lazy);
    await reading();
    assert((await page.locator('#reading [data-callout="indigo"] [data-callout="cyan"]').innerText()).includes('Inner body'), 'frontmatter keeps the original line mapping');
    // A body's native coordinate still resolves to the same source line.
    await load(strict);
    const caret = await page.evaluate(() => {
      const at = editor.snapshot().value.indexOf('Inner body') + 6, r = editor.view.coordsAtPos(at);
      return { at, mapped: editor.view.posAtCoords({ x: r.left, y: (r.top + r.bottom) / 2 }), x: r.left, y: (r.top + r.bottom) / 2, focus: editor.view.hasFocus,
        lines: Array.from(document.querySelectorAll('.cm-line')).map(n => ({ text: n.textContent, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom })) };
    });
    await page.mouse.click(caret.x, caret.y); await settle();
    const clicked = await page.evaluate(() => ({ head: editor.snapshot().head, line: editor.view.state.doc.lineAt(editor.snapshot().head).text,
      lines: Array.from(document.querySelectorAll('.cm-line')).map(n => ({ text: n.textContent, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom })) }));
    assert(clicked.line.includes('Inner body'), JSON.stringify({ caret, clicked }));
    const drag = await page.evaluate(() => {
      const from = editor.snapshot().value.indexOf('Inner body'), a = editor.view.coordsAtPos(from), b = editor.view.coordsAtPos(from + 5);
      return { x1: a.left, y1: (a.top + a.bottom) / 2, x2: b.left, y2: (b.top + b.bottom) / 2 };
    });
    await page.mouse.move(drag.x1, drag.y1); await page.mouse.down(); await page.mouse.move(drag.x2, drag.y2, { steps: 8 }); await page.mouse.up(); await settle();
    assert.equal(await page.evaluate(() => { const r = editor.view.state.selection.main; return editor.view.state.doc.sliceString(r.from, r.to); }), 'Inner');
    const original = await page.evaluate(() => editor.snapshot().value);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '候选' }); await cdp.detach(); await settle();
    assert((await page.evaluate(() => editor.snapshot().value)).includes('候选'));
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), original, 'one undo removes the committed composition');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, matrix: 32, errors }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Disposable documents and browser profile; exercises real pointer/clipboard/IME.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-editing-'));
const diagram = '```mermaid\nflowchart LR\n A[中文开始] --> B[完成]\n```';
const source = 'before\n\n' + diagram + '\n\nafter';
const html = skin => `<!doctype html><html lang="zh-CN" data-note-theme="${skin}"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style></head>
<body class="start-page" data-start-theme="light" data-start-workspace="notes"><main class="note-workspace note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div></div></main>
<script>window.jobs=0;const Native=Worker;window.Worker=class extends Native{postMessage(data,...rest){if(data.source)jobs++;return super.postMessage(data,...rest)}};</script>
${['markdown.js','markdown-table.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-live-editor.js'].map(name => `<script src="${name}"></script>`).join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'',notePath:'editing.md',onContextMenu(){window.menu=editor.commandContext()}});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(url.searchParams.get('skin') || 'default')); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage(), errors = [], matrix = []; page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message)); const cdp = await context.newCDPSession(page);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const value = () => page.evaluate(() => editor.snapshot().value);
    const svg = () => page.locator('.note-mermaid-block .note-mermaid-stage > svg').first();
    const preview = () => page.locator('.note-live-mermaid-preview .note-mermaid-stage > svg').first();
    async function reset(text = source, head = 0, anchor = head) {
      await page.evaluate(({ text, head, anchor }) => { editor.setSourceMode(false); editor.setDocument({ value: text, notePath: 'editing.md', head, anchor, scrollTop: 0 }); editor.focus(); }, { text, head, anchor });
      await settle();
    }
    async function caretLine() {
      return page.evaluate(() => { const v = editor.view, main = v.state.selection.main; return { head: main.head, empty: main.empty, line: v.state.doc.lineAt(main.head).text, focus: v.hasFocus }; });
    }
    for (const skin of ['default', 'claude', 'sky', 'apple']) {
      await page.goto(origin + '/?skin=' + skin); await page.waitForFunction(() => window.editor); await page.evaluate(() => document.fonts.ready);
      for (const [theme, width, scale] of [['light', 1400, 1], ['dark', 620, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
        for (const blanks of [0, 1, 2]) {
          const text = 'before\n' + '\n'.repeat(blanks) + diagram + '\n' + '\n'.repeat(blanks) + 'after';
          await reset(text); await svg().waitFor(); await settle();
          const layout = await page.evaluate(() => {
            const content = editor.view.contentDOM, outer = content.querySelector('.note-mermaid-block'), inner = outer.querySelector('.note-mermaid');
            const o = getComputedStyle(outer), i = getComputedStyle(inner);
            return { blanks: [...content.children].filter(n => n.matches('.cm-line') && !n.textContent).length,
              padding: [o.paddingTop, o.paddingBottom], inner: [i.marginTop, i.marginBottom, i.paddingTop, i.paddingBottom] };
          });
          assert.equal(layout.blanks, blanks * 2); assert.deepEqual(layout.padding, ['4px', '4px']); assert.deepEqual(layout.inner, ['0px', '0px', '0px', '0px']);
          const points = await page.evaluate(() => [...editor.view.contentDOM.children].filter(n => n.matches('.cm-line')).map(n => {
            const r = n.getBoundingClientRect(); return { x: r.left + 2, y: (r.top + r.bottom) / 2, text: n.textContent, from: editor.view.posAtDOM(n) };
          }));
          for (const p of points) {
            const beforeHit = await page.evaluate(p => { const b = editor.view.lineBlockAtHeight(p.y - editor.view.documentTop);
              return { position: editor.view.posAtCoords(p), target: document.elementFromPoint(p.x, p.y)?.className,
                block: { from: b.from, to: b.to, top: b.top, bottom: b.bottom } }; }, p);
            await page.mouse.click(p.x, p.y); await settle(); const caret = await caretLine();
            assert(caret.focus); assert.equal(caret.line, p.text, JSON.stringify({ skin, theme, blanks, p, beforeHit, caret })); if (!p.text) assert.equal(caret.head, p.from); assert.equal(await value(), text);
          }
          if (!blanks) await page.screenshot({ path: path.join(output, skin + '-' + theme + '.png') });
        }
        await reset(); await svg().waitFor(); await page.evaluate(() => { window.originalSVG = document.querySelector('.note-mermaid-block svg'); window.originalJobs = jobs; });
        const height = await page.locator('.note-mermaid-block').evaluate(n => n.getBoundingClientRect().height);
        await svg().click(); await settle();
        assert.equal(await page.locator('.note-mermaid-block.is-selected').count(), 1); assert.equal(await preview().count(), 0);
        assert.equal(await page.evaluate(() => originalSVG === document.querySelector('.note-mermaid-block svg') && jobs === originalJobs), true, 'selecting reuses the mounted SVG and creates no render job');
        assert(Math.abs(await page.locator('.note-mermaid-block').evaluate(n => n.getBoundingClientRect().height) - height) < 1);
        await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagram);
        await page.keyboard.press('Enter'); await preview().waitFor(); await settle(); assert.equal((await caretLine()).line, 'flowchart LR');
        await page.keyboard.press('Escape'); await svg().waitFor(); await settle(); assert.equal(await page.locator('.note-mermaid-block.is-selected').count(), 1);
        assert.equal(await value(), source); matrix.push({ skin, theme, width, scale, blanks: [0, 1, 2], select: true, edit: true });
      }
    }
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.noteTheme = 'default'; document.body.dataset.startTheme = 'light'; document.body.style.setProperty('--note-font-scale', 1); });
    await reset(); await svg().waitFor(); await svg().click(); await page.screenshot({ path: path.join(output, 'selected.png') });
    await page.keyboard.press('Enter'); await preview().waitFor(); await settle(); await page.screenshot({ path: path.join(output, 'editing.png'), caret: 'initial' });
    for (const [text, count, blanks] of [[diagram, 1, 0], [diagram + '\n\n' + diagram, 2, 1], ['\n\n' + diagram + '\n\n', 1, 4]]) {
      await reset(text); await svg().waitFor(); assert.equal(await page.locator('.note-mermaid-block').count(), count);
      assert.equal(await page.evaluate(() => [...editor.view.contentDOM.children].filter(n => n.matches('.cm-line') && !n.textContent).length), blanks); assert.equal(await value(), text);
    }
    await reset(); await svg().waitFor(); await svg().dblclick(); await preview().waitFor(); assert.equal((await caretLine()).line, 'flowchart LR');
    await page.evaluate(() => { const v = editor.view, from = v.state.doc.toString().indexOf('中文开始'); v.dispatch({ selection: { anchor: from, head: from + 4 } }); });
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '中文开始', 'editing source copies only its selected text');
    await page.keyboard.insertText('新的开始'); await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('新的开始'));
    await page.keyboard.press('Escape'); await svg().waitFor(); assert.equal(await value(), source.replace('中文开始', '新的开始'));
    await page.keyboard.press('Control+z'); await svg().waitFor(); assert.equal(await value(), source, 'Esc and selection add no history entries');
    await svg().dblclick(); await preview().waitFor();
    await page.evaluate(() => { const v = editor.view, text = v.state.doc.toString(), from = text.indexOf('flowchart'), to = text.lastIndexOf('```');
      v.dispatch({ changes: { from, to, insert: 'flowchart LR\n A[\n' }, selection: { anchor: from + 16 } }); });
    await page.locator('.note-live-mermaid-preview .note-mermaid-status').waitFor();
    await page.keyboard.press('Escape'); await page.locator('.note-mermaid-block .note-mermaid-error').waitFor(); await svg().waitFor();
    assert((await svg().textContent()).includes('中文开始'), 'closing invalid source preserves the last successful diagram');
    await reset(); await svg().waitFor();
    // Cross-block ranges keep the rendered graph and copy ordinary Markdown.
    await page.evaluate(() => { const v = editor.view; v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); });
    await settle(); assert.equal(await svg().count(), 1); assert.equal(await preview().count(), 0);
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
    await reset(); await svg().waitFor(); await svg().click({ button: 'right' }); await settle();
    assert.equal(await page.evaluate(() => menu && editor.queryCommand('copy', menu).enabled), true); assert.equal(await page.locator('.note-mermaid-block.is-selected').count(), 1);
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagram);
    assert.equal(await page.evaluate(() => editor.executeCommand('cut', menu, '')), true, 'the existing context-menu cut command uses the object deletion transaction');
    assert.equal(await value(), 'before\n\n\n\nafter');
    await page.keyboard.press('Control+z'); await svg().waitFor(); assert.equal(await value(), source);
    await svg().click();
    // Failure is non-destructive; a native successful cut is one history step.
    await page.evaluate(() => { const event = new Event('cut', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { setData() { throw new Error('denied'); } } }); editor.view.contentDOM.dispatchEvent(event); });
    assert.equal(await value(), source);
    await page.keyboard.press('Control+x'); assert.equal(await value(), 'before\n\n\n\nafter');
    await page.keyboard.press('Control+z'); await svg().waitFor(); assert.equal(await value(), source);
    await svg().click(); await page.keyboard.press('Delete'); assert.equal(await value(), 'before\n\n\n\nafter');
    await page.keyboard.press('Control+z'); await svg().waitFor(); assert.equal(await value(), source);
    const alias = '~~~~flowchart\n A[别名] --> B[原样]\n~~~~';
    await reset('before\n\n' + alias + '\n\nafter'); await svg().waitFor(); await svg().click(); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), alias);
    await reset(''); await page.keyboard.press('Control+v'); await svg().waitFor(); assert.equal(await value(), alias);

    for (const [text, at, backwards, line] of [[diagram + '\nafter', diagram.length + 1, true, ' A[中文开始] --> B[完成]'],
      ['before\n' + diagram, 6, false, 'flowchart LR'], [diagram + '\n', diagram.length + 1, true, ' A[中文开始] --> B[完成]']]) {
      await reset(text, at); await svg().waitFor(); await page.keyboard.press(backwards ? 'Backspace' : 'Delete'); await preview().waitFor(); await settle();
      const caret = await caretLine(); assert(caret.empty && caret.focus); assert.equal(caret.line, line); assert.equal(await value(), text);
      assert.equal(caret.head, await page.evaluate(backwards => { const v = editor.view, l = v.state.doc.lineAt(v.state.selection.main.head); return backwards ? l.to : l.from; }, backwards));
    }
    await reset(diagram + '\n\n', diagram.length + 2); await svg().waitFor(); await page.keyboard.press('Backspace'); await settle();
    assert.equal(await value(), diagram + '\n'); assert.equal(await preview().count(), 0);
    await page.keyboard.press('Backspace'); await preview().waitFor(); assert.equal(await value(), diagram + '\n');
    await page.keyboard.press('Backspace'); await settle(); assert((await value()).includes('B[完成\n'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), diagram + '\n');
    await reset(diagram); await svg().waitFor(); await page.keyboard.press('ArrowDown'); await settle(); await page.keyboard.insertText('正文');
    assert.equal(await value(), diagram + '\n\n正文', 'native entry after a document-only diagram uses a real body paragraph');
    await reset(source, 0); await page.evaluate(() => editor.setSourceMode(true)); await settle();
    await page.evaluate(() => { const v = editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('flowchart') } }); });
    await page.keyboard.press('Backspace'); assert.equal(await value(), source.replace('```mermaid\nflowchart', '```mermaidflowchart'));
    for (const text of ['```mermaid\n```', '```mermaid\nflowchart LR\nA-->B', '```mermaid\n' + 'A'.repeat(65537) + '\n```']) {
      await reset(text); await settle(); assert.equal(await page.locator('.note-mermaid-block').count(), 0); assert.equal(await value(), text);
    }
    // Quoted source positions retain prefixes, including nested Callouts.
    const quoted = 'before\n\n> [!note] Outer\n> > [!tip] Inner\n> > ```mermaid\n> > flowchart LR\n> > A[引用]-->B\n> > ```\n\nafter';
    await reset(quoted); await svg().waitFor(); await svg().click(); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '> > ```mermaid\n> > flowchart LR\n> > A[引用]-->B\n> > ```');
    await page.keyboard.press('Enter'); await preview().waitFor(); await settle(); assert.equal((await caretLine()).line, '> > flowchart LR'); assert.equal(await value(), quoted);
    await page.evaluate(() => editor.view.contentDOM.blur()); await settle();
    assert.equal(await preview().count(), 1, 'native focus changes retain the open source and its text range');
    await reset(); await svg().waitFor(); await svg().dblclick(); await preview().waitFor();
    await page.evaluate(() => { const v = editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('中文开始') } }); });
    const beforeIME = await value(), oldSVG = await preview().innerHTML();
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    await settle(); assert.equal(await value(), beforeIME); assert.equal(await preview().innerHTML(), oldSVG);
    await cdp.send('Input.insertText', { text: '汉' }); await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('汉中文'));
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await value(), beforeIME);
    await cdp.send('Input.imeSetComposition', { text: 'quxiao', selectionStart: 6, selectionEnd: 6 });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await settle(); assert.equal(await value(), beforeIME);

    const two = source + '\n\n' + diagram.replace('中文开始', '第二张');
    await reset(two); await page.locator('.note-mermaid-block svg').nth(1).waitFor(); await svg().dblclick(); await preview().waitFor();
    await page.evaluate(() => { const v = editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('中文开始') } }); });
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    await page.locator('.note-mermaid-block svg').last().click();
    assert.equal(await value(), two); assert.equal(await page.evaluate(() => editor.inputPending), true);
    await cdp.send('Input.insertText', { text: '汉' }); await settle();
    assert.equal(await value(), two.replace('中文开始', '汉中文开始'));
    assert.equal(await page.locator('.note-mermaid-block.is-selected').count(), 1);
    assert((await page.locator('.note-mermaid-block.is-selected').textContent()).includes('第二张'), 'candidate completion selects the intended new block');
    await reset(two); await page.locator('.note-mermaid-block svg').nth(1).waitFor(); await svg().dblclick(); await preview().waitFor();
    await page.evaluate(() => { const v = editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('中文开始') } }); });
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    await page.locator('.note-mermaid-block svg').last().click();
    await page.evaluate(() => editor.setDocument({ value: '新的文档', notePath: 'new.md', head: 0, anchor: 0 }));
    await cdp.send('Input.insertText', { text: '汉' }); await settle();
    assert.equal(await value(), '新的文档'); assert.equal(await page.locator('.note-mermaid-block.is-selected').count(), 0, 'a late block handoff cannot steal the new document');

    const contrast = '```mermaid\nflowchart LR\nA[white]:::white --> B[black]:::black\nclassDef white fill:#ffffff\nclassDef black fill:#000000\n```';
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; }); await reset('before\n\n' + contrast + '\n\nafter'); await svg().waitFor();
    const colors = await svg().evaluate(node => [...node.querySelectorAll('text')].filter(n => /^(white|black)$/.test(n.textContent)).map(n => ({ text: n.textContent, fill: getComputedStyle(n).fill })));
    assert.deepEqual(colors, [{ text: 'white', fill: 'rgb(26, 26, 26)' }, { text: 'black', fill: 'rgb(245, 245, 245)' }]);
    await reset('before\n\n```mermaid\nflowchart LR\nA["中文\uFFFF😀"]-->B[输出]\n```\n\nafter'); await svg().waitFor();
    assert.equal(await svg().evaluate(n => n.outerHTML.includes('\uFFFF')), false);
    await page.evaluate(() => { window.frames = 0; const raf = requestAnimationFrame; window.requestAnimationFrame = cb => { frames++; return raf(cb); }; });
    await page.waitForTimeout(300); assert.equal(await page.evaluate(() => frames), 0, 'idle diagrams schedule no continuous frames');
    await Promise.all([page.evaluate(() => editor.destroy()), ...page.workers().map(worker => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker was not released')), 2000);
      worker.once('close', () => { clearTimeout(timer); resolve(); });
    }))]);
    assert.equal(page.workers().length, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ matrix, colors, clipboard: true, sourceBoundaries: true, ime: true, idle: true, errors }, null, 2));
    console.log(JSON.stringify({ output, matrix: matrix.length, clipboard: true, sourceBoundaries: true, ime: true }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

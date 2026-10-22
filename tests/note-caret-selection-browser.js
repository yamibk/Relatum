'use strict';

// Local assets and synthetic text only; no user notebook or browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const { PNG } = require(require.resolve('pngjs', { paths: [path.dirname(require.resolve(process.env.RELATUM_PLAYWRIGHT || 'playwright'))] }));
const repo = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const baselineRef = process.env.RELATUM_NOTE_CARET_BASELINE || 'e3f9456';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-caret-selection-'));
const originalCSS = baseline ? execFileSync('git', ['show', baselineRef + ':assets/styles.css'], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) : null;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh}.note-document-body{--note-inline-title-space:24px}</style>
</head><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div></div></main>
${['markdown-table.js','markdown.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-media-frame.js','note-live-editor.js'].map(name => `<script src="${name}"></script>`).join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'',notePath:'geometry.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(originalCSS && pathname === '/assets/styles.css' ? originalCSS : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const report = { baseline, baselineRef, carets: [], ime: [], selections: [], delimiters: [], failures: [] };
  const check = (condition, message) => { if (!condition) report.failures.push(message); };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(() => document.fonts.ready);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function reset(value, head = value.length, anchor = head) {
      await page.evaluate(({ value, head, anchor }) => {
        editor.setSourceMode(false); editor.setDocument({ value, notePath: 'geometry.md', head, anchor, scrollTop: 0 }); editor.focus();
      }, { value, head, anchor });
      await settle();
    }
    async function caret() {
      await settle();
      return page.evaluate(() => {
        const view = editor.view, head = view.state.selection.main.head, at = view.domAtPos(head);
        const line = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
        const rect = r => ({ left: r.left, top: r.top, bottom: r.bottom, height: r.height ?? r.bottom - r.top });
        let glyph = null;
        if (head && view.state.doc.sliceString(head - 1, head) !== '\n') {
          const from = view.domAtPos(head - 1), range = document.createRange();
          range.setStart(from.node, from.offset); range.setEnd(at.node, at.offset); glyph = rect(range.getBoundingClientRect());
        }
        return { head, glyph, coords: rect(view.coordsAtPos(head)), cursor: rect(view.dom.querySelector('.cm-cursor').getBoundingClientRect()),
          line: rect(line.getBoundingClientRect()), lineHeight: parseFloat(getComputedStyle(line).lineHeight), className: line.className };
      });
    }
    for (const [theme, width, scale] of [['light', 1280, 1], ['dark', 620, 1.25], ['light', 1280, 2]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
      for (const start of ['', '上一行']) {
        await reset(start);
        let previous = await caret();
        for (let number = 1; number <= 3; number++) {
          await page.keyboard.press('Enter');
          const empty = await caret();
          await page.mouse.click(empty.coords.left + 20, (empty.coords.top + empty.coords.bottom) / 2);
          check(await page.evaluate(() => editor.view.state.selection.main.head) === empty.head, 'empty-line click resolves to its real source position');
          await page.keyboard.type('M');
          const filled = await caret();
          await page.keyboard.press('Backspace');
          const delta = empty.coords.top - previous.coords.top;
          const shifted = filled.coords.top - empty.coords.top;
          const result = { theme, width, scale, start, number, delta, shifted, previous, empty, filled };
          report.carets.push(result);
          check(delta >= 24 * scale, 'Enter advances a full line: ' + JSON.stringify({ theme, scale, start, number, delta }));
          check(Math.abs(shifted) < 1, 'typing keeps the empty-line baseline: ' + JSON.stringify({ theme, scale, start, number, shifted }));
          check(Math.abs(empty.cursor.top - empty.coords.top) < 1, 'drawn caret matches text coordinates');
          check(Math.abs(filled.glyph.left - empty.coords.left) < 1 && Math.abs(filled.glyph.top - empty.coords.top) < 1, 'the first glyph starts at the empty-line caret');
          previous = await caret();
        }
      }
    }
    const cdp = await page.context().newCDPSession(page);
    for (const initial of ['中文\n\n', '> 引用\n> ', '> [!note] 提示\n> ']) {
      await reset(initial);
      const before = await caret();
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
      check(await page.evaluate(() => editor.snapshot().value) === initial, 'provisional IME text stays out of Markdown');
      await cdp.send('Input.insertText', { text: '中' }); await settle();
      const committed = await caret();
      report.ime.push({ initial, before, committed });
      check(await page.evaluate(() => editor.snapshot().value) === initial + '中', 'IME commits at the empty-line source position');
      check(Math.abs(committed.glyph.top - before.coords.top) < 1 && Math.abs(committed.glyph.left - before.coords.left) < 1, 'IME commit retains the empty-line baseline: ' + JSON.stringify({ initial, before: before.coords, glyph: committed.glyph }));
      await page.keyboard.press('Control+z'); await settle();
      check(await page.evaluate(() => editor.snapshot().value) === initial, 'one undo restores the empty line after IME commit');
      await cdp.send('Input.imeSetComposition', { text: 'qu', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await settle();
      check(await page.evaluate(() => editor.snapshot().value) === initial, 'IME cancellation leaves Markdown unchanged');
    }
    check(await page.evaluate(() => !window.MathJax), 'ordinary typing and composition do not load MathJax');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.body.style.setProperty('--note-font-scale', 1); });
    const equation = String.raw`\[
\mathrm{CRR}_{\mathrm{GPS}}=4.948\%,\quad
\bar d=-0.0146\text{ pp},
\]`;
    const cases = [
      ['plain', '普通文本 Partial selection 普通文本', 3, 20],
      ['wrapped', '普通文本 Partial selection '.repeat(12), 4, 210],
      ['list', '3. 普通文本 Partial selection 普通文本', 5, 23],
      ['math', equation, 1, equation.length],
      ['dollars', '$$\nx^2 + y^2\n$$', 1, 15],
      ['code', '```js\nconst selected = 123;\n```', 8, 24, true],
      ['callout', '> [!note] 提示\n> 普通文本 Partial selection', 17, 28, true],
      ['callout-math', '> [!note] 提示\n> $$\n> x^2 + y^2\n> $$', 20, 27, true],
    ];
    for (const theme of ['light', 'dark']) for (const [name, value, from, to, native] of cases) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await reset(value, to, from);
      if (['math', 'dollars', 'callout-math'].includes(name)) await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
      if (name === 'code') await page.waitForFunction(() => document.querySelector('.note-live-code-keyword'));
      await page.evaluate(() => document.fonts.ready);
      await settle();
      const metrics = await page.evaluate(() => {
        const view = editor.view, { from, to } = view.state.selection.main;
        const lines = [...view.contentDOM.querySelectorAll('.cm-line')];
        const style = node => ({ text: node.textContent, className: node.className,
          native: getComputedStyle(node, '::selection').backgroundColor, background: getComputedStyle(node).backgroundColor });
        const rect = r => ({ left: r.left, top: r.top, bottom: r.bottom, height: r.height ?? r.bottom - r.top });
        const data = new DataTransfer(); view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
        return { lines: lines.map(style), spans: lines.flatMap(line => [...line.querySelectorAll('span')].map(style)),
          rectangles: [...view.dom.querySelectorAll('.cm-selectionBackground')].map(node => rect(node.getBoundingClientRect())),
          start: rect(view.coordsAtPos(from)), end: rect(view.coordsAtPos(to)), copied: data.getData('text/plain') };
      });
      check(metrics.copied === value.slice(from, to), name + ' copies exact Markdown');
      check(metrics.lines.concat(metrics.spans).every(node => node.native === (native ? 'rgba(65, 131, 196, 0.22)' : 'rgba(0, 0, 0, 0)')), name + '/' + theme + ' uses a single selection painter');
      // Compare actual pixels with the redundant painter disabled. This catches
      // dark overlap, including partial ranges and wrapped / multiline source.
      const cursorStyle = await page.addStyleTag({ content: '.note-live-editor-host .cm-cursorLayer{visibility:hidden!important}' });
      const actual = await page.screenshot({ path: path.join(output, name + '-' + theme + '.png') });
      const referenceStyle = await page.addStyleTag({ content: native
        ? '.note-live-editor-host .cm-selectionLayer{visibility:hidden!important}'
        : '#editor .cm-line::selection,#editor .cm-line ::selection{background-color:transparent!important}' });
      const reference = await page.screenshot();
      const first = PNG.sync.read(actual), second = PNG.sync.read(reference);
      const identical = first.data.equals(second.data);
      check(identical, name + '/' + theme + ' has no doubled selection pixels');
      if (!identical) fs.writeFileSync(path.join(output, name + '-' + theme + '-single-painter.png'), reference);
      await referenceStyle.evaluate(node => node.remove());
      await cursorStyle.evaluate(node => node.remove());
      report.selections.push({ name, theme, identical, ...metrics });
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      for (const source of [equation, '$$\nx^2\n$$']) {
        await reset(source, 3);
        const markers = await page.locator('.note-live-math-delimiter').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, color: getComputedStyle(node).color })));
        report.delimiters.push({ theme, markers });
        check(markers.length === 2, 'both formula delimiters are highlighted');
        check(markers.every(marker => { const [r, g, b] = marker.color.match(/\d+/g).map(Number); return b - g >= 70 && r > g; }), theme + ' formula delimiters use vivid purple');
      }
    }
    check(errors.length === 0, 'no page errors: ' + JSON.stringify(errors));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, baseline, baselineRef, failures: report.failures.length, carets: report.carets.length, ime: report.ime.length, selections: report.selections.length }));
  }
  if (!baseline) assert.equal(report.failures.length, 0, report.failures.join('\n'));
})().catch(error => { console.error(error); process.exitCode = 1; });

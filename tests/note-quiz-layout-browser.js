'use strict';
// Real pointer/Chromium input against synthetic notes; no user library or API.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-quiz-layout-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fence = (body = '以下哪个数是偶数？\n\n- [ ] 3\n- [x] 4\n- [ ] 5\n\n---\n4 可以被 2 整除。') => '```quiz\n' + body + '\n```';
const tail = '后方正文定位XYZ';
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body{margin:0}main.note-document-pane{height:100vh;display:flex;flex-direction:column}
.note-document-body{--note-inline-title-space:18px}
</style><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div></div></main>
<script>window.RelatumFeatureRuntime={enabled:key=>key!=='notes.canvas'};</script>
<script src="markdown-table.js"></script><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script>
<script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.testEditor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'初始正文',notePath:'layout.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1080 } });
  const page = await context.newPage(), errors = [], external = [], report = { layouts: [], interactions: [], ime: [] };
  page.on('pageerror', error => errors.push(error.stack)); page.on('request', req => { if (!req.url().startsWith(base)) external.push(req.url()); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) { errors.push(message.text()); console.error(message.text()); } });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function set(value, count) {
    await page.evaluate(value => {
      document.activeElement?.blur(); testEditor.setSourceMode(false);
      testEditor.setDocument({ value, notePath: 'layout.md', anchor: value.length, head: value.length, scrollTop: 0 });
    }, value);
    if (count) await page.waitForFunction(count => document.querySelectorAll('#editor .note-quiz').length === count, count);
    await settle();
  }
  const value = () => page.evaluate(() => testEditor.snapshot().value);
  const undo = async () => { await page.keyboard.press('Control+z'); await settle(); };
  const redo = async () => { await page.keyboard.press('Control+y'); await settle(); };
  async function pointFor(text) {
    return page.evaluate(text => {
      const line = Array.from(testEditor.view.contentDOM.querySelectorAll('.cm-line')).find(el => el.textContent === text);
      if (!line) throw Error('Missing native line: ' + text);
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.length < 2) continue;
        const range = document.createRange(); range.setStart(walker.currentNode, 1); range.setEnd(walker.currentNode, 2);
        const rect = range.getBoundingClientRect(); return { x: rect.left + .25, y: (rect.top + rect.bottom) / 2 };
      }
      throw Error('Missing visible text: ' + text);
    }, text);
  }
  async function typeAtTail(source) {
    const point = await pointFor(tail);
    await page.mouse.click(point.x, point.y); await settle();
    const selected = await page.evaluate(() => { const head = testEditor.view.state.selection.main.head; return { head, line: testEditor.view.state.doc.lineAt(head).text }; });
    assert.equal(selected.line, tail, 'pointer must reach the visible tail paragraph');
    assert.equal(selected.head, source.indexOf(tail) + 1, 'DOM glyph and source caret must agree: ' + JSON.stringify({ point, selected }));
    await page.keyboard.type('Z'); await settle();
    const changed = source.slice(0, selected.head) + 'Z' + source.slice(selected.head);
    assert.equal(await value(), changed); await undo(); assert.equal(await value(), source);
    await redo(); assert.equal(await value(), changed); await undo(); assert.equal(await value(), source);
  }
  async function blankPoints() {
    return page.evaluate(() => Array.from(testEditor.view.contentDOM.children).filter(el => el.classList.contains('cm-line') && !el.textContent).map(el => {
      const rect = el.getBoundingClientRect(); return { x: rect.left + 4, y: (rect.top + rect.bottom) / 2 };
    }));
  }
  try {
    await page.goto(base); await page.waitForFunction(() => !!window.testEditor);
    const q = fence(), formula = fence('电流 $I=U/R$ 是多少？\n- [ ] $0$ mA\n- [x] $6$ mA\n---\n由 $I=12/2000$ 得到。');
    const fixtures = [
      ['only', q, 1, 0], ['start', q + '\n' + tail, 1, 0], ['end', '前文\n' + q, 1, 0],
      ['adjacent', q + '\n' + q + '\n' + tail, 2, 0],
      ['one-blank', q + '\n\n' + q + '\n\n' + tail, 2, 2],
      ['two-blanks', q + '\n\n\n' + q + '\n' + tail, 2, 2],
      ['three', '前文\n' + q + '\n' + q + '\n' + q + '\n' + tail, 3, 0],
      ['formula', '前文\n' + formula + '\n' + tail, 1, 0],
    ];
    for (const [theme, width, scale] of [['light', 1280, 1], ['dark', 760, 1.4], ['light', 620, .8], ['dark', 620, 1.15]]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
      for (const [name, source, count, blanks] of fixtures) {
        await set(source, count);
        if (name === 'formula') { await page.locator('.note-quiz-question mjx-container').waitFor(); await settle(); }
        const geometry = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('#editor .note-quiz'));
          const boxes = cards.map(card => { const rect = card.getBoundingClientRect(), wrapper = card.parentElement.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height, wrapperHeight: wrapper.height, margin: getComputedStyle(card).margin }; });
          const lines = Array.from(testEditor.view.contentDOM.children).filter(el => el.classList.contains('cm-line') && !el.textContent);
          return { boxes, blanks: lines.length, gaps: boxes.slice(1).map((box, index) => box.top - boxes[index].bottom),
            lineHeight: parseFloat(getComputedStyle(testEditor.view.contentDOM).lineHeight) };
        });
        assert.equal(geometry.blanks, blanks, name + ': only actual Markdown blank lines may be displayed');
        for (const box of geometry.boxes) { assert.equal(box.margin, '0px'); assert(Math.abs(box.wrapperHeight - box.height - 8) < 1, 'Quiz outer spacing must be measured as 4px padding per side'); }
        for (const gap of geometry.gaps) {
          const blankCount = name === 'one-blank' ? 1 : name === 'two-blanks' ? 2 : 0;
          assert(Math.abs(gap - 8 - blankCount * geometry.lineHeight) < 1, name + ': gap must follow real empty lines');
        }
        assert.equal(await value(), source);
        for (let index = 0; index < blanks; index++) {
          const point = (await blankPoints())[index]; await page.mouse.click(point.x, point.y); await settle();
          const at = await page.evaluate(() => { const head = testEditor.view.state.selection.main.head; if (testEditor.view.state.doc.lineAt(head).text !== '') throw Error('Blank-line click reached hidden source'); return head; });
          await page.keyboard.type('Q'); await settle(); assert.equal(await value(), source.slice(0, at) + 'Q' + source.slice(at));
          await undo(); assert.equal(await value(), source);
        }
        if (source.includes(tail)) await typeAtTail(source);
        if (name === 'adjacent') await page.screenshot({ path: path.join(output, 'adjacent-' + theme + '-' + width + '.png') });
        report.layouts.push({ name, theme, width, scale, ...geometry });
      }
      const source = '前文\n' + formula + '\n\n' + q + '\n' + tail;
      await set(source, 2); await page.locator('.note-quiz-question mjx-container').waitFor();
      const first = page.locator('#editor .note-quiz').first();
      await first.evaluate(element => { window.quizOriginalDOM = element; window.quizOriginalFeedback = element.querySelector('.note-quiz-feedback-body'); });
      for (const action of ['incorrect', 'correct', 'reset']) {
        if (action === 'reset') await first.locator('.note-quiz-reset').click();
        else await first.locator('[data-quiz-option="' + (action === 'correct' ? 1 : 0) + '"]').click();
        await settle();
        if (action !== 'reset') { await first.locator('.note-quiz-feedback mjx-container').first().waitFor(); await settle(); }
        assert(await first.evaluate(element => element === window.quizOriginalDOM && element.querySelector('.note-quiz-feedback-body') === window.quizOriginalFeedback), 'height invalidation must reuse the quiz and its feedback DOM');
        assert.equal(await first.getAttribute('data-quiz-state'), action === 'reset' ? 'unanswered' : action);
        await typeAtTail(source); report.interactions.push({ theme, width, scale, action, pointer: true, history: true });
      }
      await first.hover(); await first.locator('.note-quiz-edit').click(); await page.waitForFunction(() => document.querySelectorAll('#editor .note-quiz').length === 1);
      assert.equal(await value(), source);
      await page.evaluate(() => { const view = testEditor.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); });
      await page.waitForFunction(() => document.querySelectorAll('#editor .note-quiz').length === 2); await typeAtTail(source);
      await page.evaluate(() => testEditor.setSourceMode(true)); assert.equal(await value(), source);
      await page.evaluate(() => testEditor.setSourceMode(false)); await page.locator('#editor .note-quiz').nth(1).waitFor(); await typeAtTail(source);
      await page.screenshot({ path: path.join(output, 'compact-' + theme + '-' + width + '.png') });
    }

    await page.setViewportSize({ width: 1280, height: 1080 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; document.body.style.setProperty('--note-font-scale', '1'); });
    const source = '前文\n\n' + q + '\n\n' + tail, cdp = await context.newCDPSession(page);
    for (const side of ['before', 'after']) for (const commit of [false, true]) {
      await set(source, 1);
      const at = side === 'before' ? '前文\n'.length : source.indexOf('\n\n' + tail) + 1;
      await page.evaluate(at => { testEditor.view.dispatch({ selection: { anchor: at } }); testEditor.focus(); }, at); await settle();
      for (const text of ['han', 'zhong']) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        assert.equal(await value(), source, 'preedit stays outside saved Markdown');
        assert((await page.locator('#editor .cm-content').innerText()).includes(text), 'preedit remains visible next to Quiz');
      }
      if (commit) await cdp.send('Input.insertText', { text: '汉' });
      else await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await page.waitForFunction(() => !testEditor.inputPending); await settle();
      assert.equal(await value(), commit ? source.slice(0, at) + '汉' + source.slice(at) : source);
      if (commit) { await undo(); assert.equal(await value(), source); }
      report.ime.push({ side, commit, nativeChromium: true });
    }
    await cdp.detach();

    const mixed = '前文\n' + q + '\n\n***\n\n| A | B |\n| --- | --- |\n| C | D |\n\n> [!note] Callout\n> 正文与 $x^2$。\n\n```mermaid\nflowchart LR\n A[开始] --> B[结束]\n```\n\n```javascript\nconst first = 1;\nconst second = 2;\n```\n\n' + tail;
    await set(mixed); await page.locator('#editor .note-quiz').waitFor();
    await page.locator('#editor .is-mermaid').scrollIntoViewIfNeeded(); await page.locator('#editor .is-mermaid svg').waitFor();
    await page.locator('#editor .cm-line').filter({ hasText: tail }).scrollIntoViewIfNeeded(); await settle(); await typeAtTail(mixed);
    assert.equal(await page.locator('#editor .note-live-callout-line').count() > 0, true);
    report.mixed = { quiz: true, rule: true, table: true, callout: true, mermaid: true, code: true, pointer: true };
    const long = Array.from({ length: 32 }, (_, index) => '## 段落 ' + index + '\n\n' + q + '\n\n' + ('普通文字用于滚动。'.repeat(8)) + '\n').join('\n') + '\n```javascript\nconst last = 32;\n```\n\n' + tail;
    await set(long);
    await page.evaluate(() => { testEditor.view.scrollDOM.scrollTop = testEditor.view.scrollDOM.scrollHeight; });
    await page.waitForFunction(text => Array.from(testEditor.view.contentDOM.querySelectorAll('.cm-line')).some(el => el.textContent === text), tail);
    await settle(); await typeAtTail(long); report.long = { quizCount: 32, pointerAfterScroll: true };
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('note quiz layout browser: ok ' + JSON.stringify({ layouts: report.layouts.length, interactions: report.interactions.length, ime: report.ime, mixed: report.mixed, long: report.long }));
  } catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ...report, errors, external }, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)); console.log(output); }
})().catch(error => { console.error(error); process.exitCode = 1; });

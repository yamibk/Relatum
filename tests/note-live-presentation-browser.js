'use strict';

// Host-provided Playwright + Edge; serves only static assets and synthetic notes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = process.env.RELATUM_NOTE_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-presentation-'));
const sample = [
  '# 数组与模块化编程', '',
  '把相关的数据放在一起，让结构更清楚。这里包含 **关键概念**、*补充说明*、==重点== 和 `arr[row][col]`。', '',
  '## 二维数组的初始化', '', '用行和列组织数据，以下三种写法都可以初始化一个二维数组。', '',
  '```c', '#include <stdio.h>', '', 'int main(void) {',
  '    // 方法一：按行初始化（推荐，一眼能看出行和列）',
  '    int arr1[3][4] = {', '        {1, 2, 3, 4},    // 第 0 行元素',
  '        {5, 6, 7, 8},    // 第 1 行元素', '        {9, 10, 11, 12}  // 第 2 行元素', '    };', '',
  '    // 方法二：简化初始化，系统自动按行填充',
  '    int arr2[3][4] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};', '',
  '    printf("%d\\n", arr1[0][0]);', '    return 0;', '}', '```', '',
  '## 知识检查', '', '- [ ] 理解行与列的下标', '- 试着修改数组中的一个元素', '',
  '> [!tip] 小提示', '> 下标从 **0** 开始，最后一列的下标是 `3`。', '',
  '| 表达式 | 含义 |', '| --- | --- |', '| `arr[0][0]` | 第一个元素 |', '| `arr[2][3]` | 最后一个元素 |', '',
  '---', '', '结尾用于检查光标点击与键盘返回。',
].join('\n');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body { margin: 0; }
.note-document-pane { height: 100vh; display: flex; flex-direction: column; }
.note-document-body { --note-inline-title-space: 24px; }
</style></head><body class="start-page" data-start-theme="light">
<main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
<script src="markdown.js"></script><script src="mermaid-renderer.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-live-editor.js"></script>
<script>window.editor = RelatumNoteLiveEditor.create(document.getElementById('editor'), {value: ${JSON.stringify(sample)}, notePath:'sample.md', imageUrl(){return '/fixture.png';}});</script>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (pathname === '/fixture.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAYAAADGFbfiAAAACXBIWXMAAAsTAAALEwEAmpwYAAABWUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgG7WgABM7mWAAAAAElFTkSuQmCC', 'base64'));
      return;
    }
    if (pathname === '/harness') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(repo, 'tests/note-live-editor-harness.html'))); return;
    }
    if (!pathname.startsWith('/assets/')) { res.writeHead(404).end(); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    if (file.endsWith('note-live-editor.js')) {
      res.end(fs.readFileSync(file, 'utf8').replace('window.RelatumNoteLiveEditor = { create, renderMarkdown };',
        'window.RelatumNoteLiveEditor = { create, renderMarkdown }; window.__probe = {createInlineDecorations, createBlockField};'));
    } else res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(process.env.RELATUM_EDGE_PATH ? {executablePath: process.env.RELATUM_EDGE_PATH} : {})});
    const page = await browser.newPage({viewport:{width:1280,height:960}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.editor && document.querySelector('.note-live-code-language'));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    await page.screenshot({path:path.join(output, 'light.png')});
    const metrics = await page.evaluate(() => {
      const CM = RelatumCodeMirror;
      const source = '```c\n' + 'int value = 5; // 长代码块\n'.repeat(6000) + '```';
      const coordinator = {};
      const options = {coordinator};
      const field = __probe.createBlockField(() => '', options, coordinator);
      const state = CM.EditorState.create({doc:source, extensions:[CM.markdown({base:CM.markdownLanguage,codeLanguages:CM.relatumCodeLanguages}),field]});
      const from = state.doc.line(10).from, to = state.doc.line(45).to;
      const view = {state, visibleRanges:[{from,to}], hasFocus:false, composing:false};
      const times = [];
      let count = 0;
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        const decorations = __probe.createInlineDecorations(view, field, () => '', options);
        times.push(performance.now()-start);
        if (i === 11) decorations.between(0, source.length, () => count++);
      }
      return {chars:source.length, lines:state.doc.lines, visibleLines:36, decorations:count, timesMs:times};
    });
    if (!process.env.RELATUM_NOTE_BASELINE) assert(metrics.decorations < 100, 'code decorations must be bounded by visible lines');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await settle();
    await page.screenshot({path:path.join(output, 'dark.png')});
    if (process.env.RELATUM_NOTE_BASELINE) { console.log(JSON.stringify({output,metrics})); return; }

    // Use actual browser text rectangles to click code after repeated variable
    // height blocks, rather than deriving both sides from CodeMirror geometry.
    const mixed = Array.from({length:12}, (_, index) => [
      '> [!tip] 提示 ' + index, '> 包含 **重点** 与 `中文注释`。', '',
      '| 列 | 内容 |', '| --- | --- |', '| A | 较长的表格内容用于检查累计高度。 |', '',
      '---', '', '```c', 'int sentinel_' + index + ' = ' + index + '; // 可点击的目标行', '```', '',
    ].join('\n')).join('\n');
    let clickChecks = 0;
    for (const variant of [{width:1280,scale:1,theme:'light'}, {width:620,scale:1.35,theme:'dark'}]) {
      await page.setViewportSize({width:variant.width,height:960});
      await page.evaluate(({mixed,variant}) => {
        document.body.dataset.startTheme = variant.theme;
        document.documentElement.style.setProperty('--note-font-scale', variant.scale);
        editor.setDocument({value:mixed, notePath:'mixed.md'});
      }, {mixed,variant});
      await settle();
      for (const index of [0,5,11]) {
        const token = 'sentinel_' + index;
        await page.evaluate(token => {
          const pos = editor.view.state.doc.toString().indexOf(token);
          editor.view.dispatch({effects:RelatumCodeMirror.EditorView.scrollIntoView(pos, {y:'center'})});
          editor.view.contentDOM.blur();
        }, token);
        await settle();
        const target = await page.evaluate(token => {
          const line = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')).find(el => el.textContent.includes(token));
          if (!line) return null;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const offset = node.textContent.indexOf(token);
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(node, offset + 3); range.setEnd(node, offset + 4);
            const rect = range.getBoundingClientRect();
            return {x:rect.left + 1, y:(rect.top + rect.bottom)/2};
          }
          return null;
        }, token);
        assert(target, 'visible code token must have a text rectangle');
        await page.mouse.click(target.x, target.y);
        await settle();
        const click = await page.evaluate(() => {
          const view = editor.view, main = view.state.selection.main;
          const caret = view.coordsAtPos(main.head);
          const cursor = view.dom.querySelector('.cm-cursor');
          return {line:view.state.doc.lineAt(main.head).text, focus:view.hasFocus, caret,
            cursor:!!cursor && cursor.getBoundingClientRect().height > 0, failure:view.dom.parentElement.dataset.livePreviewError};
        });
        assert(click.line.includes(token), `click below rich blocks landed on ${click.line}`);
        assert(click.focus && click.cursor && !click.failure, 'click must retain a visible editing cursor');
        assert(Math.abs((click.caret.top + click.caret.bottom)/2 - target.y) < 5, 'caret must stay on the clicked visual line');
        clickChecks++;
      }
    }

    await page.setViewportSize({width:1280,height:960});
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--note-font-scale');
      document.body.dataset.startTheme = 'light';
      editor.setDocument({value:'- [ ] task\n- bullet\n\n```c\nint last = 7;', notePath:'copy.md'});
      editor.view.contentDOM.blur();
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => { window.__copied = text; }}});
    });
    await settle();
    assert.equal(await page.locator('.note-live-list-marker').count(), 1, 'only the ordinary list should have a bullet');
    await page.locator('.note-live-code-language').click();
    assert.equal(await page.evaluate(() => window.__copied), 'int last = 7;', 'copy must retain the last line of an unclosed fence');
    await page.locator('.note-live-task').click();
    assert((await page.evaluate(() => editor.snapshot().value)).startsWith('- [x] task'), 'checkbox must still edit Markdown');

    // Compartment switches must preserve the native history and focused cursor.
    await page.evaluate(() => {
      editor.setDocument({value:'```c\n// 正文\n```', notePath:'ime.md', anchor:10, head:10});
      editor.focus();
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {text:'中文',selectionStart:2,selectionEnd:2});
    await cdp.send('Input.insertText', {text:'中文'});
    await settle();
    const composed = await page.evaluate(() => editor.snapshot());
    assert.equal(composed.value, '```c\n// 正文中文\n```');
    await page.evaluate(() => { editor.setSourceMode(true); editor.setSourceMode(false); });
    await settle();
    const switched = await page.evaluate(() => editor.snapshot());
    assert.equal(switched.value, composed.value);
    assert.equal(switched.head, composed.head);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => editor.snapshot().value), '```c\n// 正文\n```');
    await cdp.detach();

    // Images stay visual while selected, align with text, and commit one
    // proportional resize transaction using Obsidian's pixel-width syntax.
    const imageSource = '正文左边缘\n\n![[fixture.png|240]]\n\n结尾';
    await page.evaluate(imageSource => {
      editor.setDocument({value:imageSource, notePath:'image.md'});
      editor.setSourceMode(false);
    }, imageSource);
    await page.waitForFunction(() => {
      const image = document.querySelector('.note-live-image-frame.is-block img');
      return image && image.complete;
    });
    await settle();
    const alignment = await page.evaluate(() => {
      const frame = document.querySelector('.note-live-image-frame.is-block');
      const textLine = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line'))
        .find(line => line.textContent.includes('正文左边缘'));
      const textNode = textLine.firstChild;
      const range = document.createRange();
      range.setStart(textNode, 0); range.setEnd(textNode, 1);
      return {
        imageLeft:frame.getBoundingClientRect().left,
        textLeft:range.getBoundingClientRect().left,
        parents:Array.from({length:4}, (_, index) => {
          let node = frame;
          for (let step = 0; step <= index; step++) node = node && node.parentElement;
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return {className:node.className, left:rect.left, width:rect.width};
        }),
      };
    });
    assert(Math.abs(alignment.imageLeft - alignment.textLeft) <= 1, JSON.stringify(alignment));
    await page.locator('.note-live-image-frame.is-block').click({position:{x:40,y:40}});
    await settle();
    assert.equal(await page.locator('.note-live-image-frame.is-selected').count(), 1, 'clicking an image must select the visual widget');
    assert.equal(await page.locator('.note-live-image-resize-handle').count(), 1, 'a selected image must expose one resize handle');
    await page.screenshot({path:path.join(output, 'image-selected.png')});
    assert(!await page.locator('.cm-content').innerText().then(text => text.includes('![[fixture.png')),
      'selecting an image in Live Preview must not expose source');
    const handleBox = await page.locator('.note-live-image-resize-handle').boundingBox();
    assert(handleBox, 'resize handle must have browser geometry');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 60, handleBox.y + handleBox.height / 2, {steps:4});
    await page.mouse.up();
    await settle();
    assert((await page.evaluate(() => editor.snapshot().value)).includes('![[fixture.png|300]]'),
      'resize must write the rounded pixel width');
    await page.keyboard.press('Control+z');
    assert.equal((await page.evaluate(() => editor.snapshot().value)), imageSource, 'one undo must restore the pre-resize source');
    await page.locator('.note-live-image-frame.is-block').click({position:{x:40,y:40}});
    const cancelHandle = await page.locator('.note-live-image-resize-handle').boundingBox();
    await page.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y + cancelHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(cancelHandle.x + cancelHandle.width / 2 + 35, cancelHandle.y + cancelHandle.height / 2);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settle();
    assert.equal((await page.evaluate(() => editor.snapshot().value)), imageSource, 'Escape must cancel resizing without a document edit');
    assert(Math.abs((await page.locator('.note-live-image-frame.is-block').boundingBox()).width - 240) <= 1,
      'cancelled resizing must restore the rendered width');
    await page.keyboard.press('Delete');
    assert(!await page.evaluate(() => editor.snapshot().value.includes('fixture.png')), 'Delete must remove the selected image token');
    await page.keyboard.press('Control+z');
    assert.equal((await page.evaluate(() => editor.snapshot().value)), imageSource, 'undo must restore a deleted image');
    await page.locator('.note-live-image-frame.is-block').click({position:{x:40,y:40}});
    await page.keyboard.press('ArrowLeft');
    const beforeImage = await page.evaluate(() => {
      const snapshot = editor.snapshot();
      return {empty:snapshot.anchor === snapshot.head, head:snapshot.head, imageAt:snapshot.value.indexOf('![[fixture.png')};
    });
    assert(beforeImage.empty && beforeImage.head === beforeImage.imageAt, JSON.stringify(beforeImage));
    await page.evaluate(() => editor.setSourceMode(true));
    await settle();
    assert((await page.locator('.cm-content').innerText()).includes('![[fixture.png|240]]'),
      'source mode must expose the original image Markdown');
    await page.evaluate(() => {
      const from = editor.view.state.doc.toString().indexOf('![[fixture.png');
      editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.cursor(from + 5)});
      editor.setSourceMode(false);
    });
    await settle();
    assert.equal(await page.locator('.note-live-image-frame.is-selected').count(), 1,
      'a source cursor inside an image must become a safe visual image selection when Live Preview resumes');
    await page.evaluate(() => editor.setDocument({
      value:'前文 ![行内图|96](fixture.png) 后文', notePath:'inline-image.md',
    }));
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame.is-inline img')?.complete);
    await page.locator('.note-live-image-frame.is-inline').click({position:{x:20,y:20}});
    await settle();
    assert.equal(await page.locator('.note-live-image-frame.is-inline.is-selected').count(), 1,
      'inline images must use the same visual object selection');
    assert(!await page.locator('.cm-content').innerText().then(text => text.includes('![行内图|96]')),
      'an active inline image must not reveal its Markdown source');

    // Existing late-viewport and segmented-range fixtures exercise MathJax,
    // tables, callouts and mounted language highlighting together.
    await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
    await page.waitForFunction(() => window.__relatumRunMixedPreviewProbe);
    const mixedProbe = await page.evaluate(() => __relatumRunMixedPreviewProbe());
    assert(mixedProbe.complete, JSON.stringify(mixedProbe));
    const longProbe = await page.evaluate(() => __relatumRunLongPreviewProbe());
    assert(longProbe.complete, JSON.stringify(longProbe));
    await page.locator('[data-role="control-performance"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.noteLivePerformance);
    const typingProbe = await page.evaluate(() => JSON.parse(document.documentElement.dataset.noteLivePerformance));
    assert.deepEqual(errors, []);
    const report = {output,metrics,clickChecks,ime:true,copy:true,undo:true,mixedProbe,longProbe,typingProbe};
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

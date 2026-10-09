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
<script src="markdown-table.js"></script><script src="markdown.js"></script><script src="mermaid-renderer.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
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

    // Native Callout line padding must be included in CM's measured geometry,
    // while a body caret keeps the rendered header and one continuous surface.
    const calloutFixture = '> [!hint] **中文写作提示**\n> 正文起点。' + '这段较长的中文正文会自然换行，编辑和指针仍按实际高度定位。'.repeat(6)
      + '\n>\n> 最后一行正文\n\n后方定位段落';
    const calloutChecks = [];
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width:620,height:960});
      await page.evaluate(({source, theme}) => {
        document.documentElement.style.removeProperty('--note-font-scale');
        document.body.dataset.startTheme = theme;
        editor.setDocument({value:source, notePath:'callout.md', anchor:source.length, head:source.length});
        editor.view.contentDOM.blur();
      }, {source:calloutFixture, theme});
      await settle();
      const textPoint = token => page.evaluate(token => {
        const line = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')).find(el => el.textContent.includes(token));
        if (!line) return null;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, offset = node.textContent.indexOf(token);
          if (offset < 0) continue;
          const range = document.createRange();
          range.setStart(node, offset + 1); range.setEnd(node, offset + 2);
          const rect = range.getBoundingClientRect();
          return {x:rect.left + 1, y:(rect.top + rect.bottom)/2};
        }
        return null;
      }, token);
      const bodyPoint = await textPoint('正文起点');
      assert(bodyPoint, 'callout body must have a real native text rectangle');
      await page.mouse.click(bodyPoint.x, bodyPoint.y);
      await settle();
      const card = await page.evaluate(() => {
        const lines = Array.from(document.querySelectorAll('.note-live-callout-line'));
        const body = lines.find(line => line.textContent.includes('正文起点'));
        return {title:document.querySelectorAll('.note-live-callout-title-widget').length,
          backgrounds:lines.map(line => getComputedStyle(line).backgroundColor),
          rows:lines.length, wrappedHeight:body.getBoundingClientRect().height,
          lineHeight:parseFloat(getComputedStyle(body).lineHeight),
          source:editor.snapshot().value, line:editor.view.state.doc.lineAt(editor.snapshot().head).text};
      });
      assert.equal(card.title, 1, 'a body click must preserve the callout title and icon');
      assert.equal(card.rows, 4, 'every Callout line including blank quote rows must join the card');
      assert.equal(new Set(card.backgrounds).size, 1, 'the active line must use exactly the same background as its neighbors');
      assert(!['transparent','rgba(0, 0, 0, 0)'].includes(card.backgrounds[0]), 'the card must have a visible continuous surface');
      assert(card.wrappedHeight > card.lineHeight * 2, 'long Callout prose must have naturally measured wrapped height');
      assert(card.line.includes('正文起点') && card.source === calloutFixture, 'body clicks must retain both native caret and exact Markdown');
      await page.screenshot({path:path.join(output, 'callout-' + theme + '.png')});
      const afterPoint = await textPoint('后方定位段落');
      await page.mouse.click(afterPoint.x, afterPoint.y);
      await settle();
      const after = await page.evaluate(() => {
        const view = editor.view, caret = view.coordsAtPos(view.state.selection.main.head);
        return {line:view.state.doc.lineAt(view.state.selection.main.head).text, caret};
      });
      assert(after.line.includes('后方定位段落'), 'a click below a wrapped Callout must land in the following paragraph');
      assert(Math.abs((after.caret.top + after.caret.bottom)/2 - afterPoint.y) < 5, 'Callout padding must not shift later pointer coordinates');
      await page.locator('.note-live-callout-title-widget').click();
      await settle();
      assert.equal(await page.locator('.note-live-callout-title-widget').count(), 0, 'a title click must enter its native Markdown line');
      assert((await page.evaluate(() => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text)).includes('[!hint]'),
        'the title cursor must remain inside the original header');
      calloutChecks.push({theme, rows:card.rows, wrappedHeight:card.wrappedHeight, background:card.backgrounds[0], afterClick:true});
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

    // Exercise a real Chromium composition stream, including the provisional
    // Latin text emitted by Windows Pinyin before the selected Hanzi commit.
    // Relatum must never treat those intermediate DOM values as committed data.
    await page.evaluate(() => {
      editor.setDocument({value:'甲乙', notePath:'ime-middle.md', anchor:1, head:1});
      editor.focus();
    });
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['z', 'zh', 'zhong']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    const provisional = await page.evaluate(() => editor.snapshot());
    assert.equal(provisional.value, '甲乙', 'snapshot must hide provisional Pinyin from saving');
    await cdp.send('Input.insertText', {text:'中'});
    await settle();
    const composed = await page.evaluate(() => editor.snapshot());
    assert.equal(composed.value, '甲中乙');
    assert.equal(composed.anchor, composed.head, 'middle insertion must leave an empty caret');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => editor.snapshot().value), '甲乙', 'one undo must remove one selected candidate');

    // Compartment switches must preserve the native history and focused cursor.
    await page.evaluate(() => {
      editor.setDocument({value:'```c\n// 正文\n```', notePath:'ime-code.md', anchor:10, head:10});
      editor.focus();
    });
    for (const text of ['z', 'zh', 'zhong', 'zhongwen']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    await cdp.send('Input.insertText', {text:'中文'});
    await settle();
    const codeComposed = await page.evaluate(() => editor.snapshot());
    assert.equal(codeComposed.value, '```c\n// 正文中文\n```');
    await page.evaluate(() => { editor.setSourceMode(true); editor.setSourceMode(false); });
    await settle();
    const switched = await page.evaluate(() => editor.snapshot());
    assert.equal(switched.value, codeComposed.value);
    assert.equal(switched.head, codeComposed.head);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => editor.snapshot().value), '```c\n// 正文\n```');

    // A rendered formula must be directly enterable and remain stable while
    // the IME replaces its provisional Pinyin with the chosen character.
    await page.evaluate(() => editor.setDocument({value:'公式 $x^2$ 结尾', notePath:'ime-math.md'}));
    await settle();
    await page.locator('.note-live-inline-math').click();
    await settle();
    const formulaCaret = await page.evaluate(() => editor.snapshot());
    assert(formulaCaret.anchor === formulaCaret.head && formulaCaret.head > formulaCaret.value.indexOf('$x^2')
      && formulaCaret.head < formulaCaret.value.lastIndexOf('$') + 1, 'formula click must reveal an internal source caret');
    for (const text of ['z', 'zi']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    await cdp.send('Input.insertText', {text:'字'});
    await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '公式 $x^2字$ 结尾');

    // The editor still has focus from the preceding IME test. A caret at zero
    // intentionally exposes the formula source, so start outside the math block
    // before testing a click on its projected widget.
    await page.evaluate(() => editor.setDocument({value:'$$x^2$$\n\nafter', notePath:'ime-block-math.md', anchor:14, head:14}));
    await settle();
    await page.locator('[aria-label="点击编辑 math 源码"]').click();
    await settle();
    const blockFormulaCaret = await page.evaluate(() => editor.snapshot());
    assert.deepEqual({anchor:blockFormulaCaret.anchor, head:blockFormulaCaret.head}, {anchor:2, head:2},
      'block formula click must reveal an empty caret after its opening delimiter');
    for (const text of ['h', 'han']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    await cdp.send('Input.insertText', {text:'汉'});
    await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '$$汉x^2$$\n\nafter');

    // Images remain projected, but text insertion beside them must keep an
    // empty text caret and must not select/replace the image source range.
    const imeImageSource = '前文\n\n![[fixture.png|240]]\n\n后文';
    await page.evaluate(source => {
      const at = source.indexOf('后文') + 1;
      editor.setDocument({value:source, notePath:'ime-image.md', anchor:at, head:at});
      editor.focus();
    }, imeImageSource);
    for (const text of ['s', 'sh', 'shuru']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    await cdp.send('Input.insertText', {text:'输入'});
    await settle();
    const imageAdjacent = await page.evaluate(() => editor.snapshot());
    assert.equal(imageAdjacent.value, imeImageSource.replace('后文', '后输入文'));
    assert.equal(imageAdjacent.anchor, imageAdjacent.head);

    const calloutImeSource = '> [!tip] 输入法标题\n> 甲乙\n\n后文';
    await page.evaluate(source => {
      const at = source.indexOf('甲乙') + 1;
      editor.setDocument({value:source, notePath:'ime-callout.md', anchor:at, head:at});
      editor.focus();
    }, calloutImeSource);
    for (const text of ['z', 'zh', 'zhong']) {
      await cdp.send('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length});
    }
    assert.equal(await page.evaluate(() => editor.snapshot().value), calloutImeSource,
      'Callout snapshots must never persist provisional Pinyin');
    assert.equal(await page.locator('.note-live-callout-title-widget').count(), 1,
      'Callout titles must remain projected during native body composition');
    await cdp.send('Input.insertText', {text:'中'});
    await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), calloutImeSource.replace('甲乙', '甲中乙'));
    assert.equal(await page.locator('.note-live-callout-title-widget').count(), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => editor.snapshot().value), calloutImeSource,
      'one undo must remove the Callout candidate without altering its syntax');
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

    // A candidate-window blur must not commit the textarea's provisional
    // Latin spelling. The final composition value is one image transaction.
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await page.locator('.note-live-image-frame.is-block').click({position:{x:100,y:55}});
    await page.locator('.note-image-text-editor').waitFor();
    const imageTextDuringBlur = await page.evaluate(() => {
      const input = document.querySelector('.note-image-text-editor');
      input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true, data:''}));
      input.value = 'zi';
      input.dispatchEvent(new InputEvent('input', {bubbles:true, data:'zi', inputType:'insertCompositionText'}));
      input.blur();
      const retained = input.isConnected;
      input.value = '字';
      input.dispatchEvent(new InputEvent('input', {bubbles:true, data:'字', inputType:'insertCompositionText'}));
      input.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'字'}));
      return retained;
    });
    assert(imageTextDuringBlur, 'blur during composition must retain the native textarea until the final candidate arrives');
    await settle();
    const imageTextValue = await page.evaluate(() => {
      const parsed = MarkdownMini.parseImageBlock(editor.snapshot().value.split('\n').find(line => line.includes('fixture.png')));
      return parsed && parsed.imageTextItems && parsed.imageTextItems[0] && parsed.imageTextItems[0].text;
    });
    assert.equal(imageTextValue, '字');
    // Synthetic textarea.blur() leaves focus on body, unlike a real click back
    // into the editor. Send undo to CodeMirror rather than the browser document.
    await page.evaluate(() => editor.focus());
    await page.keyboard.press('Control+z');
    await page.evaluate(() => editor.setImageTextMode(false));
    await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), imageSource,
      'one undo must remove the complete image-text candidate commit');

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
    assert(beforeImage.empty && beforeImage.head === beforeImage.imageAt - 1,
      'ArrowLeft must use the preceding paragraph instead of a removed boundary line: ' + JSON.stringify(beforeImage));
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

    // Standalone projections cover their visual boundary lines. Real blank
    // Markdown lines remain visible, and pointer coordinates follow the layout.
    await page.evaluate(() => {
      // This static fixture checks the canvas host only. The real API/runtime
      // interactions remain covered by note-canvas-browser.js.
      window.RelatumNoteCanvas = { mount() { return { update() {}, destroy() {} }; } };
    });
    const compactChecks = [];
    const fixtures = [
      ['math', '1\n$$a^2+b^2=c^2$$\n2', 1, 0],
      ['multiline', '1\n$$\n\\frac{\\sqrt{a^2+b^2}}{\\int_0^\\infty e^{-x}\\,dx}\n$$\n2', 1, 0],
      ['brackets', '1\n\\[x^2\\]\n2', 1, 0],
      ['consecutive', '1\n$$x^2$$\n$$y^2$$\n2', 2, 0],
      ['blank-lines', '1\n\n$$x^2$$\n\n2', 1, 2],
      ['image', '1\n![fixture|240x180](fixture.png)\n2', 1, 0],
      ['canvas', '1\n![diagram.canvas|240x180](canvases/diagram.canvas)\n2', 1, 0],
      ['consecutive-media', '1\n![fixture|240x180](fixture.png)\n![diagram.canvas|240x180](canvases/diagram.canvas)\n2', 2, 0],
      ['media-blank-lines', '1\n\n![fixture|240x180](fixture.png)\n\n![diagram.canvas|240x180](canvases/diagram.canvas)\n\n2', 2, 3],
      ['image-only', '![[fixture.png|240x180]]', 1, 0],
      ['canvas-only', '![diagram.canvas|240x180](canvases/diagram.canvas)', 1, 0],
      ['math-only', '$$x^2$$', 1, 0],
      ['multiline-only', '$$\n\\frac{1}{x}\n$$', 1, 0],
      ['wide-math', '1\n$$' + Array(100).fill('x^2').join('+') + '$$\n2', 1, 0],
    ];
    for (const [theme, width, scale] of [['light', 1280, 1], ['dark', 760, 1.35]]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(({ theme, scale }) => {
        document.body.dataset.startTheme = theme;
        document.body.style.setProperty('--note-font-scale', String(scale));
      }, { theme, scale });
      for (const [name, value, blocks, blanks] of fixtures) {
        await page.evaluate(value => {
          document.activeElement?.blur();
          editor.setDocument({ value, notePath: 'compact.md', anchor: value.length, head: value.length });
        }, value);
        await page.waitForFunction(blocks => {
          const projected = [...document.querySelectorAll('.cm-content > .note-live-rich-block')];
          return projected.length === blocks && projected.every(block => !block.classList.contains('is-math') || block.querySelector('mjx-container'));
        }, blocks);
        await settle();
        const layout = await page.evaluate(() => {
          const content = editor.view.contentDOM;
          const math = [...content.querySelectorAll('.is-math')].map(block => {
            const container = block.querySelector('mjx-container'), style = getComputedStyle(container);
            return { height: block.getBoundingClientRect().height, margin: style.marginTop, overflowY: style.overflowY,
              width: block.clientWidth, scrollWidth: block.scrollWidth, heightOverflow: block.scrollHeight - block.clientHeight };
          });
          return { blanks: [...content.children].filter(el => el.classList.contains('cm-line') && !el.textContent).length,
            contentWidth: content.clientWidth, math };
        });
        assert.equal(layout.blanks, blanks, name + ' must not add boundary lines');
        assert.equal(await page.evaluate(() => editor.snapshot().value), value);
        for (const math of layout.math) {
          assert.equal(math.margin, '0px');
          assert.equal(math.overflowY, 'visible', 'MathJax glyphs must not be clipped by their container');
          assert(math.heightOverflow <= 2, name + ' must fit vertically in its outer scroller');
        }
        if (name === 'math') assert(layout.math[0].height < 45 * scale, 'simple math must use its measured height and modest padding');
        if (name === 'wide-math') {
          assert(layout.math[0].scrollWidth > layout.math[0].width + 100, 'wide formulas must scroll in the outer block');
          assert(layout.contentWidth <= width, 'wide formulas must not expand the editor beyond the viewport');
        }
        if (value.endsWith('\n2')) {
          const point = await page.evaluate(() => {
            const line = [...editor.view.contentDOM.children].find(el => el.classList.contains('cm-line') && el.textContent === '2');
            const rect = line.getBoundingClientRect(); return { x: rect.left + 3, y: (rect.top + rect.bottom) / 2 };
          });
          await page.mouse.click(point.x, point.y); await settle();
          const caret = await page.evaluate(() => {
            const head = editor.view.state.selection.main.head, rect = editor.view.coordsAtPos(head);
            return { head, y: (rect.top + rect.bottom) / 2 };
          });
          assert.equal(caret.head, value.length - 1, name + ' must land on the visible paragraph');
          assert(Math.abs(caret.y - point.y) < 5, name + ' must preserve pointer/caret coordinates');
          await page.keyboard.type('Z'); await settle();
          assert.equal(await page.evaluate(() => editor.snapshot().value), value.slice(0, -1) + 'Z2');
          await page.keyboard.press('Control+z'); await settle();
          assert.equal(await page.evaluate(() => editor.snapshot().value), value);
        } else {
          await page.evaluate(() => { editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(editor.view.state.doc.length) }); editor.focus(); });
          await page.keyboard.press('Enter'); await page.keyboard.type('Z'); await settle();
          assert.equal(await page.evaluate(() => editor.snapshot().value), value + '\nZ', 'a document ending in a block must allow a following paragraph');
        }
        compactChecks.push({ name, theme, scale, ...layout });
        if (name === 'multiline') await page.screenshot({ path: path.join(output, 'compact-math-' + theme + '.png') });
      }
    }
    // Native carets navigate to the real paragraphs beside an image. Exact
    // hidden-source boundary mapping is covered by the StateField regression.
    // Candidates must remain visible without entering autosave snapshots.
    const boundaryCdp = await page.context().newCDPSession(page);
    const boundarySource = '1\n![[fixture.png|240x180]]\n2';
    for (const side of ['start', 'end']) {
      for (const commit of [true, false]) {
        const at = side === 'start' ? 1 : boundarySource.lastIndexOf('\n') + 1;
        await page.evaluate(value => {
          editor.setDocument({ value, notePath: 'boundary-ime.md', anchor: value.length, head: value.length });
        }, boundarySource);
        await settle();
        await page.locator('.note-live-image-frame.is-block').click({ position: { x: 20, y: 20 } });
        await page.keyboard.press(side === 'start' ? 'ArrowLeft' : 'ArrowRight');
        await settle();
        assert.equal(await page.evaluate(() => editor.view.state.selection.main.head), at, 'arrows must navigate outside the media source');
        for (const text of ['h', 'han']) {
          await boundaryCdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
          assert.equal(await page.evaluate(() => editor.snapshot().value), boundarySource);
          assert((await page.locator('.cm-content').innerText()).includes(text), 'boundary preedit must remain visible at ' + side);
        }
        if (commit) await boundaryCdp.send('Input.insertText', { text: '汉' });
        else await boundaryCdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
        await settle();
        assert.equal(await page.evaluate(() => editor.snapshot().value), commit ? boundarySource.slice(0, at) + '汉' + boundarySource.slice(at) : boundarySource);
      }
    }
    await boundaryCdp.detach();
    // A sole-image document temporarily retains native editable boundary lines
    // in image-text mode; leaving that mode must restore the compact layout.
    const soleImage = '![[fixture.png|240x180]]';
    await page.evaluate(value => editor.setDocument({ value, notePath: 'image-only-mode.md' }), soleImage);
    await settle();
    await page.locator('.note-live-image-frame.is-block').click({ position: { x: 20, y: 20 } });
    await page.evaluate(() => editor.setImageTextMode(true));
    await page.waitForFunction(() => [...editor.view.contentDOM.children].filter(el => el.classList.contains('cm-line') && !el.textContent).length === 2);
    assert.equal(await page.evaluate(() => editor.snapshot().value), soleImage);
    await page.evaluate(() => editor.setImageTextMode(false));
    await page.waitForFunction(() => editor.view.contentDOM.querySelectorAll(':scope > .cm-line').length === 0);
    assert.equal(await page.evaluate(() => editor.snapshot().value), soleImage);

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
    const report = {output,metrics,clickChecks,calloutChecks,compactChecks,boundaryIme:true,ime:true,copy:true,undo:true,mixedProbe,longProbe,typingProbe};
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Focused geometry/interaction regression. Uses host-provided Playwright + Edge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const source = '![[fixture.png|400]]';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-live-editor-host{width:760px;height:600px;margin:30px}</style></head>
<body class="start-page" data-start-theme="light"><div class="note-live-editor-host" id="editor"></div>
<script src="markdown.js"></script><script src="mermaid-renderer.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-live-editor.js"></script>
<script>window.defaultsChanges=[];window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{
value:${JSON.stringify(source)},notePath:'image-text.md',imageUrl(){return '/fixture.png'},
imageTextDefaults:{size:'lg',color:'blue'},onImageTextDefaultsChange(value){defaultsChanges.push(value)}});</script></body></html>`;

function geometry(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
  };
}

(async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
    if (pathname === '/fixture.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAYAAADGFbfiAAAACXBIWXMAAAsTAAALEwEAmpwYAAABWUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgG7WgABM7mWAAAAAElFTkSuQmCC', 'base64'));
      return;
    }
    if (!pathname.startsWith('/assets/')) { response.writeHead(404).end(); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const frame = page.locator('.note-live-image-frame.is-block');
    await frame.locator('img').waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('.note-live-image-frame.is-block img');
      return image && image.complete && image.naturalWidth > 0;
    });
    await frame.click({ position: { x: 30, y: 30 } });
    await page.locator('.note-live-image-frame.is-selected').waitFor();
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await page.locator('.note-live-image-frame.is-image-text-armed').waitFor();
    await frame.click({ position: { x: 200, y: 100 } });
    const input = page.locator('.note-image-text-editor');
    await input.fill('第一行\n第二行');
    await input.press('Control+Enter');
    await page.locator('.note-image-text-box[data-image-text-id]').waitFor();
    const initial = await page.evaluate(() => {
      const line = editor.snapshot().value.split('\n').find((value) => value.includes('fixture.png'));
      return MarkdownMini.parseImageBlock(line).imageTextItems[0];
    });
    assert.equal(initial.size, 'lg', 'a new box must use the restored font-size preference');
    assert.equal(initial.color, 'blue', 'a new box must use the restored color preference');

    const display = await page.locator('.note-image-text-box[data-image-text-id]').evaluate(geometry);
    await page.evaluate(() => editor.imageTextCommand('edit'));
    await input.waitFor();
    const editing = await input.evaluate(geometry);
    assert(Math.abs(display.centerX - editing.centerX) <= 1 && Math.abs(display.centerY - editing.centerY) <= 1,
      'edit mode must preserve the display center');
    assert(Math.abs(display.width - editing.width) <= 1 && Math.abs(display.height - editing.height) <= 1,
      'edit mode must preserve the display dimensions');
    assert.equal(editing.fontSize, display.fontSize);
    assert.equal(editing.lineHeight, display.lineHeight);
    await input.press('Escape');

    await page.waitForTimeout(600);
    const beforeNudge = initial.x;
    await page.keyboard.press('ArrowRight');
    const afterNudge = await page.evaluate(() => {
      const line = editor.snapshot().value.split('\n').find((value) => value.includes('fixture.png'));
      return MarkdownMini.parseImageBlock(line).imageTextItems[0].x;
    });
    assert(afterNudge > beforeNudge, 'ArrowRight must nudge the selected box');
    await page.evaluate(() => editor.imageTextCommand('color', 'red'));
    const remembered = await page.evaluate(() => defaultsChanges.at(-1));
    assert.deepEqual(remembered, { size: 'lg', color: 'red' }, 'explicit style choices must be exposed for persistence');
    const labelBox = await page.locator('.note-image-text-box[data-image-text-id]').boundingBox();
    const imageBox = await frame.locator('img').boundingBox();
    assert(labelBox && imageBox);
    await page.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(imageBox.x + imageBox.width + 120, labelBox.y + labelBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => editor.imageTextCommand('size', 'xl'));
    const bounded = await page.evaluate(() => {
      const text = document.querySelector('.note-image-text-box[data-image-text-id]').getBoundingClientRect();
      const image = document.querySelector('.note-live-image-frame.is-block img').getBoundingClientRect();
      return { textLeft: text.left, textRight: text.right, imageLeft: image.left, imageRight: image.right };
    });
    assert(bounded.textLeft >= bounded.imageLeft - 1 && bounded.textRight <= bounded.imageRight + 1,
      'dragging to an edge and enlarging text must keep the complete box visible');
    await page.reload();
    await frame.locator('img').waitFor();
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame.is-block img').complete);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frame.click({ position: { x: 30, y: 30 } });
    await page.locator('.note-live-image-frame.is-selected').waitFor();
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await page.locator('.note-live-image-frame.is-image-text-armed').waitFor();
    await frame.click({ position: { x: 120, y: 70 } });
    await input.waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('.note-image-text-editor'));
    await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      target.value = 't';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 't', inputType: 'insertCompositionText' }));
    });
    const scrollerBox = await page.locator('.cm-scroller').boundingBox();
    assert(scrollerBox);
    await page.mouse.click(scrollerBox.x + scrollerBox.width - 12, scrollerBox.y + scrollerBox.height - 12);
    const retainedUntilRawCommit = await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      if (!target) return false;
      target.dispatchEvent(new FocusEvent('blur'));
      target.value = '他';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: '他', inputType: 'insertCompositionText' }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '他' }));
      return true;
    });
    assert(retainedUntilRawCommit, 'a page click must let the native IME finish before closing the textarea');
    await page.waitForFunction(() => !document.querySelector('.note-image-text-editor'));
    const rawPointerText = await page.evaluate(() => {
      const line = editor.snapshot().value.split('\n').find((value) => value.includes('fixture.png'));
      return MarkdownMini.parseImageBlock(line).imageTextItems.map((item) => item.text);
    });
    assert.deepEqual(rawPointerText, ['t'], 'clicking page blank space must preserve the visible raw preedit text');

    await page.reload();
    await frame.locator('img').waitFor();
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame.is-block img').complete);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frame.click({ position: { x: 30, y: 30 } });
    await page.locator('.note-live-image-frame.is-selected').waitFor();
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await page.locator('.note-live-image-frame.is-image-text-armed').waitFor();
    await frame.click({ position: { x: 120, y: 70 } });
    await input.waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('.note-image-text-editor'));
    const retainedDuringComposition = await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      target.value = 'zi';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'zi', inputType: 'insertCompositionText' }));
      target.dispatchEvent(new FocusEvent('blur'));
      const retained = target.isConnected;
      target.value = '字';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: '字', inputType: 'insertCompositionText' }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '字' }));
      return retained;
    });
    assert(retainedDuringComposition, 'candidate-window blur must not remove the native textarea');
    await page.waitForFunction(() => !document.querySelector('.note-image-text-editor'));
    const composedResult = await page.evaluate(() => {
      const line = editor.snapshot().value.split('\n').find((value) => value.includes('fixture.png'));
      return { source: editor.snapshot().value, texts: MarkdownMini.parseImageBlock(line).imageTextItems.map((item) => item.text) };
    });
    assert.deepEqual(composedResult.texts, ['字'],
      'only the final IME candidate may be committed: ' + JSON.stringify(composedResult));

    await page.reload();
    await frame.locator('img').waitFor();
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame.is-block img').complete);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frame.click({ position: { x: 30, y: 30 } });
    await page.locator('.note-live-image-frame.is-selected').waitFor();
    await page.evaluate(() => { editor.setImageTextMode(true); editor.imageTextCommand('add'); });
    await page.locator('.note-live-image-frame.is-image-text-armed').waitFor();
    await frame.click({ position: { x: 120, y: 70 } });
    await input.waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('.note-image-text-editor'));
    const remainsAfterImeEscape = await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      target.value = 't';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 't', inputType: 'insertCompositionText' }));
      target.value = '';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'deleteCompositionText' }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      return target.isConnected;
    });
    assert(remainsAfterImeEscape, 'cancelling only the IME composition must leave the empty text-box editor open');
    await input.press('Escape');
    assert.equal(await page.evaluate(() => editor.snapshot().value), source,
      'explicitly cancelling the text box must not revive or save the raw preedit text');
    assert.deepEqual(errors, []);
    console.log('note image text browser regression: ok');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

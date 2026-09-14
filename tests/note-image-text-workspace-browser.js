'use strict';

// Focused end-to-end regression for the Notes image-text toolbar. The real
// local API runs against a disposable data root; user notes are never opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-image-text-toolbar-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(path.join(root, 'notes', 'Image.assets', 'images'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', 'Image.md'),
  '# Image text\n\n![fixture|700](Image.assets/images/fixture.png)\n\nAfter');
fs.writeFileSync(path.join(root, 'notes', 'Image.assets', 'images', 'fixture.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAYAAADGFbfiAAAACXBIWXMAAAsTAAALEwEAmpwYAAABWUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgG7WgABM7mWAAAAAElFTkSuQmCC',
  'base64'));

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let index = 0; index < 100; index += 1) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (error) {}
      if (ready) break;
      await sleep(100);
    }
    assert(ready, 'isolated server did not start');
    browser = await chromium.launch({
      headless: true,
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__imageTextToolbarTest = {state, openNote, flushSave, checkExternalChanges, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url);
    await page.waitForFunction(() => window.CanvasNoteWorkspace);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__imageTextToolbarTest?.state.active
      && window.__imageTextToolbarTest.state.initialized);
    await page.evaluate(() => __imageTextToolbarTest.openNote('Image.md', { reuseActiveTab: false }));
    const frame = page.locator('.note-live-image-frame.is-block');
    await frame.locator('img').waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('.note-live-image-frame.is-block img');
      return image && image.complete && image.naturalWidth > 0;
    });
    await frame.click({ position: { x: 30, y: 30 } });
    const toggle = page.locator('[data-role="note-image-text-toggle"]');
    const tools = page.locator('[data-role="note-image-text-tools"]');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-image-text-toggle"]')
      .getAttribute('aria-pressed') === 'true');

    if (!process.env.RELATUM_IMAGE_OPERATIONS_ONLY) {
    // Focus and projection updates may move the CodeMirror selection for one
    // frame, but they cannot close an explicitly opened toolbar.
    await page.evaluate(() => __imageTextToolbarTest.editor.view.dispatch({ selection: { anchor: 0 } }));
    await sleep(120);
    assert.equal(await tools.isVisible(), true, 'selection reconciliation must not close the toolbar');
    for (let index = 0; index < 24; index += 1) {
      await toggle.click();
      assert.equal(await tools.isHidden(), true, `toolbar close ${index + 1}`);
      await toggle.click();
      await sleep([0, 8, 25, 60][index % 4]);
      assert.equal(await tools.isVisible(), true, `toolbar reopen ${index + 1}`);
    }
    await sleep(2400);
    assert.equal(await tools.isVisible(), true, 'background refresh must not close the toolbar');

    // Two fast clicks while a draft is waiting represent close then reopen.
    await page.locator('[data-image-text-action="add"]').click();
    await frame.click({ position: { x: 180, y: 90 } });
    const input = page.locator('.note-image-text-editor');
    await input.waitFor();
    await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      target.value = 't';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 't', inputType: 'insertCompositionText' }));
    });
    await toggle.click();
    await toggle.click();
    await page.evaluate(() => {
      const target = document.querySelector('.note-image-text-editor');
      target.value = '他';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: '他', inputType: 'insertCompositionText' }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '他' }));
    });
    await page.waitForFunction(() => !document.querySelector('.note-image-text-editor'));
    await sleep(120);
    assert.equal(await tools.isVisible(), true, 'the latest queued toolbar intent must win');

    // Replay a dismissed IME draft and reopen before/after its final events.
    // Keep these events in one browser task: Playwright's click auto-waiting
    // otherwise lets both settling frames finish and misses the fast path.
    for (const endBeforeOpen of [false, true]) {
      await page.locator('[data-image-text-action="add"]').click();
      await frame.click({ position: { x: endBeforeOpen ? 320 : 250, y: 110 } });
      await page.waitForFunction(() => document.activeElement === document.querySelector('.note-image-text-editor'));
      await page.evaluate((endBeforeOpen) => {
        const target = document.querySelector('.note-image-text-editor');
        target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        target.value = 'abc';
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'abc', inputType: 'insertCompositionText' }));
        document.querySelector('.cm-scroller').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        const end = () => {
          target.value = '阿';
          target.dispatchEvent(new InputEvent('input', { bubbles: true, data: '阿', inputType: 'insertCompositionText' }));
          target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '阿' }));
        };
        if (endBeforeOpen) end();
        const button = document.querySelector('[data-role="note-image-text-toggle"]');
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        button.click();
        if (!endBeforeOpen) end();
      }, endBeforeOpen);
      await sleep(500);
      assert.equal(await page.evaluate(() => __imageTextToolbarTest.editor.inputPending), false);
      assert.equal(await tools.isVisible(), true, `IME blank-click reopen (end first: ${endBeforeOpen})`);
    }

    // Chromium's native composition path also triggers focus and background
    // sync. Exercise the real Windows writer, not a mocked save response.
    const cdp = await page.context().newCDPSession(page);
    for (let index = 0; index < 12; index += 1) {
      await page.locator('[data-image-text-action="add"]').click();
      await frame.click({ position: { x: 30 + index * 40, y: 40 } });
      await page.waitForFunction(() => document.activeElement === document.querySelector('.note-image-text-editor'));
      await cdp.send('Input.imeSetComposition', { text: 'abc', selectionStart: 3, selectionEnd: 3 });
      const button = await toggle.boundingBox();
      await page.mouse.click(1590, 520);
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      await sleep(700);
      assert.equal(await tools.isVisible(), true, 'native IME reopen ' + index);
      const synced = await page.evaluate(async () => {
        const test = __imageTextToolbarTest;
        const doc = test.editor.view.state.doc;
        await test.flushSave();
        const disk = await (await fetch('/api/note?path=Image.md')).json();
        const revisionMatches = test.state.current.revision === disk.revision;
        await test.checkExternalChanges(false);
        return { revisionMatches, sameDocument: test.editor.view.state.doc === doc };
      });
      assert.deepEqual(synced, { revisionMatches: true, sameDocument: true },
        'own autosave must not masquerade as an external edit and reset the document');
      assert.equal(await tools.isVisible(), true, 'toolbar must survive autosave and external-change polling');
    }

    // The blank strip beyond the editor content is a real outside click.
    await page.mouse.click(1590, 520);
    assert.equal(await tools.isHidden(), true, 'far-right page blank space must close the toolbar');
    }

    // Real PNG generation and destructive cleanup, including an offscreen image,
    // unused comments, code/HTML source, disk history and editor undo.
    const fixture = await page.evaluate(async () => {
      const md = window.MarkdownMini;
      const image = '![](Image.assets/images/fixture.png)';
      const item = (id, text, color) => ({ id, text, color, x: .5, y: .5, size: 'md' });
      const annotated = (items, source = image) => md.serializeImageBlock(md.parseImageBlock(source), items);
      const selected = annotated([item('merged-one', '中文\nPNG text', 'white'),
        { ...item('merged-two', '边缘', 'black'), x: .15, y: .2 }], '![合并|700](Image.assets/images/fixture.png)');
      const other = annotated([item('kept-one', '保留文字', 'red')]);
      const orphan = annotated([item('orphan-one', '残留', 'white')]).slice(image.length);
      const code = annotated([item('code-one', '代码残留', 'white')]);
      const html = annotated([item('html-one', 'HTML 残留', 'white')]);
      const value = [selected, '', '```md', code, '```', '', '<div>', html, '</div>', '', orphan,
        ...Array(100).fill('正文段落\n'), other].join('\n');
      const editor = __imageTextToolbarTest.editor;
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: value }, selection: { anchor: 0 } });
      await __imageTextToolbarTest.flushSave();
      return { selected, other, value };
    });
    // No selection: opening the menu checks metadata on demand, and exposes
    // cleanup only. Existing image annotations must remain untouched.
    await page.evaluate(() => {
      const editor = __imageTextToolbarTest.editor;
      editor.view.dispatch({ selection: { anchor: editor.snapshot().value.indexOf('正文段落') } });
    });
    await toggle.click();
    assert.equal(await tools.isVisible(), true);
    for (const action of ['add', 'edit', 'size', 'color', 'delete', 'merge']) {
      assert.equal(await page.locator(`[data-image-text-action="${action}"]`).first().isDisabled(), true);
    }
    await page.locator('[data-image-text-action="cleanup"]').click();
    await page.waitForFunction(() => !__imageTextToolbarTest.state.imageTextBusy);
    const withoutOrphans = await page.evaluate(() => __imageTextToolbarTest.editor.snapshot().value);
    assert(withoutOrphans.includes(fixture.selected) && withoutOrphans.includes(fixture.other));
    assert.equal((withoutOrphans.match(/<!--relatum:image-text:/g) || []).length, 2);
    await page.evaluate(() => {
      const editor = __imageTextToolbarTest.editor;
      editor.view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    });
    const first = page.locator('.note-live-image-frame.is-block').first();
    await first.click({ position: { x: 25, y: 25 } });
    await toggle.click();
    await page.locator('[data-image-text-action="merge"]').click();
    await page.waitForFunction(() => !__imageTextToolbarTest.state.imageTextBusy
      && __imageTextToolbarTest.editor.snapshot().value.includes('merged-')).catch(async (error) => {
      console.error(await page.evaluate(() => ({ busy: __imageTextToolbarTest.state.imageTextBusy,
        text: __imageTextToolbarTest.editor.snapshot().value.slice(0, 200),
        toast: document.querySelector('[data-role="note-toast"]')?.textContent,
        selected: __imageTextToolbarTest.editor.imageTextTarget() })));
      throw error;
    });
    const merged = await page.evaluate(async () => {
      const test = __imageTextToolbarTest;
      const value = test.editor.snapshot().value;
      const parsed = MarkdownMini.parseImageBlock(value.split('\n')[0]);
      const image = new Image();
      // Use the actual renderer URL, keeping the test independent of query names.
      image.src = document.querySelector('.note-live-image-frame.is-block img').src;
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonTransparent = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) nonTransparent++;
      const beforeUndo = test.editor.snapshot().value;
      test.editor.view.focus();
      return { value, parsed, nonTransparent, width: canvas.width, height: canvas.height, beforeUndo };
    });
    assert.equal(merged.width, 400); assert.equal(merged.height, 200);
    assert(merged.nonTransparent > 100 && merged.nonTransparent < 20000, 'PNG must contain text and preserve transparent background');
    assert.equal(merged.parsed.width, 700);
    assert.equal(merged.parsed.imageTextItems.length, 0);
    assert(merged.value.includes(fixture.other), 'offscreen image text must survive');
    assert.equal((merged.value.match(/<!--relatum:image-text:/g) || []).length, 1, 'unused/code/HTML annotations must be removed');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => __imageTextToolbarTest.editor.snapshot().value), merged.beforeUndo);

    // Select the remaining annotated image directly, then exercise the actual button.
    await page.evaluate(() => {
      const editor = __imageTextToolbarTest.editor;
      const doc = editor.view.state.doc;
      const line = doc.line(doc.lines);
      editor.view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
    });
    await page.locator('.note-live-image-frame.is-selected .note-image-text-box').last().waitFor();
    await toggle.click();
    const beforeFailure = await page.evaluate(() => __imageTextToolbarTest.editor.snapshot().value);
    await page.route('**/api/note-image-text-cleanup', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试写盘失败，请重试' }),
    }), { times: 1 });
    await page.locator('[data-image-text-action="cleanup"]').click();
    await page.waitForFunction(() => !__imageTextToolbarTest.state.imageTextBusy);
    assert.equal(await page.evaluate(() => __imageTextToolbarTest.editor.snapshot().value), beforeFailure,
      'failed writes must leave editable text intact');
    let cleanupRequests = 0;
    await page.route('**/api/note-image-text-cleanup', async (route) => {
      cleanupRequests++;
      await sleep(200);
      await route.continue();
    });
    await page.evaluate(() => {
      const button = document.querySelector('[data-image-text-action="cleanup"]');
      button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(() => !__imageTextToolbarTest.state.imageTextBusy
      && !__imageTextToolbarTest.editor.snapshot().value.includes('<!--relatum:image-text:'));
    assert.equal(cleanupRequests, 1, 'repeated clicks must not queue duplicate destructive operations');
    const cleared = await page.evaluate(async () => {
      const disk = await (await fetch('/api/note?path=Image.md')).json();
      const history = await (await fetch('/api/note-history?path=Image.md')).json();
      const versions = await Promise.all(history.versions.map(async (v) =>
        (await (await fetch('/api/note-history?path=Image.md&version=' + v.id)).json()).content));
      return { disk: disk.content, versions, editor: __imageTextToolbarTest.editor.snapshot().value };
    });
    assert.equal(cleared.disk, cleared.editor);
    assert(cleared.versions.every((value) => !value.includes('<!--relatum:image-text:')));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => __imageTextToolbarTest.editor.snapshot().value), cleared.editor);
    assert(fs.existsSync(path.join(root, 'notes/Image.assets/images/fixture.png')), 'original asset stays intact');
    assert.deepEqual(errors, []);
    console.log('note image text workspace browser regression: ok');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

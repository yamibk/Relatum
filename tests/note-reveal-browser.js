'use strict';

// Real Notes UI on a disposable vault; Explorer requests are intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-reveal-'));
const notebook = 'CustomNotebook/数学 笔记';
const note = notebook + '/图片 笔记.md';
const targets = ['图片 笔记.assets/images/第一 张.png', '图片%20笔记.assets/images/第二%20张.png', '第三 张.png'];
const markdown = '# 图片定位\n\n普通文字\n\n![first|100](' + targets[0] + ')\n\n行内 ![second|80](' + targets[1] + ') 图片\n\n![[' + targets[2] + '|100]]\n\n末尾文字';
fs.mkdirSync(path.join(root, 'notes', notebook, '图片 笔记.assets/images'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', note), markdown);
for (const target of targets) fs.writeFileSync(path.join(root, 'notes', notebook, decodeURIComponent(target)), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'isolated server starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__revealTest = {state, openNote, setViewMode, selectNotebook, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    let fail = false;
    await page.route('**/api/note-reveal', route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: fail ? 404 : 200, contentType: 'application/json',
        body: JSON.stringify(fail ? { error: '图片不存在', code: 'not_found' } : { ok: true }) });
    });
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__revealTest?.state.initialized && __revealTest.state.active && !__revealTest.state.openingPath);
    await page.evaluate(async ({ notebook, note }) => {
      __revealTest.selectNotebook(notebook);
      await __revealTest.openNote(note);
    }, { notebook, note });
    const menu = page.locator('[data-role="note-context-menu"]');
    assert.equal(await page.locator('.cm-content .note-live-image-frame').count(), 3);
    const label = () => page.evaluate(() => document.documentElement.lang === 'en' ? 'Open in File Explorer' : '在资源管理器中打开');
    const explorer = async () => menu.getByRole('menuitem', { name: await label(), exact: true });
    async function revealImage(index, mode) {
      const images = mode === 'reading' ? page.locator('[data-role="note-reading-view"] .md-local-image')
        : page.locator('.cm-content .note-live-image-frame');
      await images.nth(index).click({ button: 'right' });
      await menu.waitFor({ state: 'visible' });
      assert.equal(await menu.locator('[data-note-submenu]').count(), mode === 'reading' ? 0 : 2);
      if (index === 0 && mode === 'live') {
        await menu.locator('[data-note-submenu="paragraph"]').hover();
        assert.equal(await page.locator('.note-context-submenu:visible').count(), 1);
        await (await explorer()).hover();
        assert.equal(await page.locator('.note-context-submenu:visible').count(), 0);
      }
      if (index === 0 && mode === 'live') await page.screenshot({ path: path.join(root, 'reveal-light.png') });
      const before = requests.length;
      await (await explorer()).click();
      await page.waitForFunction(() => document.querySelector('[data-role="note-context-menu"]').hidden);
      assert.equal(requests.length, before + 1);
      assert.deepEqual(requests.at(-1), { kind: 'image', path: note, target: targets[index], imageSyntax: index === 2 ? 'wiki' : 'markdown' });
    }
    await revealImage(0, 'live');
    await revealImage(1, 'live'); // The first image is still selected before right-clicking the second.
    await revealImage(2, 'live');
    assert.equal(await page.evaluate(() => __revealTest.editor.snapshot().value), markdown, 'reveal leaves Markdown unchanged');
    await page.locator('.cm-content').press('Shift+F10');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await (await explorer()).count(), 1, 'selected image supports keyboard menu');
    await page.keyboard.press('End');
    assert.equal(await menu.getByRole('menuitem', { name: '移到系统回收站', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');

    // A menu opened over text never inherits the previous image target.
    const text = page.locator('.cm-line').filter({ hasText: '普通文字' });
    await text.click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    assert.equal(await (await explorer()).count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('.cm-content .note-live-image-frame').first().click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    const beforeClose = requests.length;
    await menu.click({ button: 'right' });
    await menu.waitFor({ state: 'hidden' });
    assert.equal(requests.length, beforeClose, 'second right-click only closes the menu');

    await page.evaluate(() => __revealTest.setViewMode('reading'));
    for (let index = 0; index < targets.length; index++) await revealImage(index, 'reading');
    const readerImage = page.locator('[data-role="note-reading-view"] .md-local-image').first();
    await readerImage.click({ button: 'right' });
    const staleButton = await (await explorer()).elementHandle();
    await page.evaluate(() => __revealTest.setViewMode('live'));
    await staleButton.evaluate(el => el.click());
    assert.equal(requests.length, beforeClose + 3, 'a stale reading menu cannot reveal after switching mode');

    // Image text editing keeps its existing right-click commit behavior.
    if (!await page.locator('.note-workspace.links-overlay-open').count()) {
      await page.locator('[data-note-action="toggle-notebooks"]').click();
    }
    await page.evaluate(() => {
      const editor = __revealTest.editor;
      editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.range(0) });
    });
    await page.locator('.cm-content .note-live-image-frame').first().click();
    await page.locator('[data-note-action="toggle-image-text"]').click();
    await page.locator('[data-image-text-action="add"]').click();
    await page.locator('.cm-content .note-live-image-frame').first().click();
    const draft = page.locator('.note-image-text-editor');
    await draft.waitFor({ state: 'visible' });
    await draft.click({ button: 'right' });
    assert.equal(await menu.isHidden(), true, 'image text right-click never opens the image menu');
    await draft.waitFor({ state: 'hidden' });
    await page.locator('[data-note-action="toggle-image-text"]').click();

    // Notebook context does not switch the current document.
    if (!await page.locator('.note-workspace.links-overlay-open').count()) {
      await page.locator('[data-note-action="toggle-notebooks"]').click();
    }
    const row = page.locator(`[data-role="note-notebook-tree"] > .note-notebook-root > .note-tree-row[data-note-path="${notebook}"]`);
    await row.click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    assert.deepEqual(await menu.locator(':scope > button').allTextContents(), ['重命名', '在资源管理器中打开', '移到系统回收站']);
    await page.screenshot({ path: path.join(root, 'reveal-notebook.png') });
    await menu.getByRole('button', { name: '在资源管理器中打开', exact: true }).click();
    assert.deepEqual(requests.at(-1), { path: notebook });
    assert.equal(await page.evaluate(() => __revealTest.state.current.path), note);

    // Normal motion/light and reduced motion/dark/narrow share the same menu.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await revealImage(1, 'live');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      RelatumI18n.setLanguage('en');
      document.body.dataset.startTheme = 'dark';
    });
    await page.setViewportSize({ width: 620, height: 850 });
    await page.evaluate(() => __revealTest.setViewMode('reading'));
    await readerImage.click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    const bounds = await menu.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 620 && bounds.y + bounds.height <= 850);
    await page.screenshot({ path: path.join(root, 'reveal-dark-narrow.png') });
    fail = true;
    await (await explorer()).click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-toast"]')?.textContent.includes('图片不存在'));
    assert.deepEqual(errors, []);
    await page.evaluate(() => __revealTest.flushSave());
    assert.equal(fs.readFileSync(path.join(root, 'notes', note), 'utf8'), markdown, 'all menu actions preserve the note');
    console.log(JSON.stringify({ ok: true, requests: requests.length, artifacts: root }));
  } finally {
    if (browser) await browser.close();
    service.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

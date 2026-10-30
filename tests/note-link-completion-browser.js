'use strict';
// Real API and Edge; Markdown, SQLite and browser preferences are all disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-link-completion-'));
const notes = path.join(root, 'notes'); fs.mkdirSync(notes);
for (const [file, content] of Object.entries({ 'Main.md': 'Main', 'Visited.md': 'visited', 'OlderVisit.md': 'older',
  '电子学.md': '电路知识', 'Body.md': '独有正文needle', 'A/同名.md': 'A', 'B/同名.md': 'B',
  'CustomNotebook/One/Cross.md': 'cross notebook' })) {
  const target = path.join(notes, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
}
for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(notes, 'N' + String(i).padStart(3, '0') + '.md'), 'text');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port, errors = [], queries = [];
  const features = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'))).features;
  const profile = { version: 1, features: Object.fromEntries(features.map(feature => [feature.id, feature.id === 'notes'])) };
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify(profile)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {}
      assert.equal(service.exitCode, null, 'isolated API stays running'); await sleep(100);
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.stack));
    page.on('request', request => { if (request.url().endsWith('/api/note-query') && request.method() === 'POST') queries.push(request.postDataJSON()); });
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__links={openNote,flushSave,setViewMode,setNoteSettingsOpen,state,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0');
      localStorage.setItem('canvas:noteRecentFiles:v1', JSON.stringify([['Visited.md', 200], ['OlderVisit.md', 100]]));
    });
    await page.goto(url); await page.waitForFunction(() => window.__links?.state.initialized && __links.state.active);
    await page.evaluate(() => __links.openNote('Main.md'));
    for (let i = 0; i < 200; i++) { if ((await (await fetch(url + '/api/note-index-state')).json()).phase === 'ready') break; await sleep(50); }
    const menu = page.locator('.note-link-completion'), status = page.locator('.note-link-completion-status');
    const value = () => page.evaluate(() => __links.editor.snapshot().value);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function reset(text = '', head = text.length, sourceMode = false) {
      await page.evaluate(async ({ text, head, sourceMode }) => {
        await __links.setViewMode(sourceMode ? 'source' : 'live');
        __links.editor.setDocument({ value: text, notePath: 'Main.md', anchor: head, head, scrollTop: 0 }); __links.editor.focus();
      }, { text, head, sourceMode }); await settle();
    }
    async function suggestions(query = '') { await reset(); await page.keyboard.type('[['); if (query) await page.keyboard.insertText(query); await menu.waitFor(); }
    async function choose(title, key = 'Enter') {
      const rows = await menu.locator('.cm-completionLabel').allTextContents(), index = rows.indexOf(title);
      assert(index >= 0, title + ' appears in ' + rows.join(', '));
      for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press(key); await menu.waitFor({ state: 'hidden' }); await sleep(80);
    }
    for (const sourceMode of [false, true]) {
      await reset('', 0, sourceMode); await page.keyboard.type('[['); await menu.waitFor();
      assert.equal(await menu.locator('.cm-completionLabel').first().textContent(), 'Visited');
      assert(await menu.evaluate(node => node.classList.contains('note-link-completion-more')));
      assert(await menu.locator('ul').evaluate(node => node.scrollHeight > node.clientHeight));
      assert(await menu.locator('ul').evaluate(node => node.clientHeight >= 350 && !getComputedStyle(node).fontFamily.includes('monospace')), 'eight-row menu uses the UI font');
      await choose('Visited', 'Tab'); assert.equal(await value(), '[[Visited]]');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '[[]]', 'completion is a separate undo step');
      await page.keyboard.press('Control+y'); assert.equal(await value(), '[[Visited]]');
    }
    await suggestions('电子'); await choose('电子学'); assert.equal(await value(), '[[电子学]]');
    await reset('[[电子#章节|显示名]]', 4); await page.keyboard.press('Control+Space'); await menu.waitFor();
    await choose('电子学'); assert.equal(await value(), '[[电子学#章节|显示名]]');
    await suggestions('同名');
    await menu.locator('li').filter({ hasText: 'A' }).first().click(); await sleep(120); assert.equal(await value(), '[[A/同名]]');
    await suggestions('Cross'); await choose('Cross'); assert.equal(await value(), '[[Cross]]');

    await reset(); await page.keyboard.type('[[绝不存在'); await status.waitFor(); await sleep(200);
    assert((await status.textContent()).includes('没有匹配'));
    assert(!fs.existsSync(path.join(notes, '绝不存在.md')));
    await page.keyboard.press('Escape'); await status.waitFor({ state: 'hidden' });
    await reset(); await page.keyboard.type('[[独有正文needle'); await status.waitFor(); await sleep(200); assert.equal(await menu.count(), 0);
    await page.evaluate(() => RelatumNoteLinkCompletion.update({ ...RelatumNoteLinkCompletion.read(), includeBody: true }));
    await page.keyboard.press('Control+Space'); await menu.waitFor(); assert((await menu.textContent()).includes('正文匹配'));
    await choose('Body'); assert.equal(await value(), '[[Body]]');
    await page.evaluate(() => RelatumNoteLinkCompletion.reset());

    await page.evaluate(() => RelatumNoteLinkCompletion.update({ ...RelatumNoteLinkCompletion.read(), automatic: false }));
    await reset(); await page.keyboard.type('[['); await sleep(300); assert.equal(await menu.count(), 0);
    await page.keyboard.press('Control+Space'); await menu.waitFor(); await choose('Visited');
    await reset(); await page.keyboard.type('[['); await page.keyboard.press('Control+Space'); await menu.waitFor();
    await page.keyboard.insertText('电子'); await page.waitForFunction(() => document.querySelector('.note-link-completion .cm-completionLabel')?.textContent === '电子学');
    await choose('电子学'); assert.equal(await value(), '[[电子学]]', 'manual session keeps filtering with automatic display off');
    await reset('[[]]', 2); await page.keyboard.press('Control+Space'); await menu.waitFor();
    const manualIme = await page.context().newCDPSession(page), beforeManualIme = queries.length;
    await manualIme.send('Input.imeSetComposition', { text: '电子', selectionStart: 2, selectionEnd: 2 });
    await sleep(220); assert.equal(queries.length, beforeManualIme);
    await manualIme.send('Input.insertText', { text: '电子' }); await menu.waitFor(); await choose('电子学');
    assert.equal(await value(), '[[电子学]]', 'manual session resumes after native Chinese composition');
    await page.evaluate(() => RelatumNoteLinkCompletion.reset());
    for (const sourceMode of [false, true]) for (const text of ['`[[x]]`', '```js\n[[x]]\n```', '$[[x]]$', '$$\n[[x]]\n$$', '<!-- [[x]] -->', '%% [[x]] %%', '---\ntitle: [[x]]\n---\n', '![[x]]', '[[Name|alias]]', '[[Name#header]]']) {
      const head = text.includes('alias') ? text.indexOf('alias') + 2 : text.includes('header') ? text.indexOf('header') + 2 : text.indexOf('x') + 1;
      await reset(text, head, sourceMode); const count = queries.length; await page.keyboard.press('Control+Space'); await sleep(200);
      assert.equal(await menu.count(), 0, 'excluded context: ' + text); assert.equal(queries.length, count, 'no query in ' + text);
    }
    await reset('[[]]', 2); const imeQueries = queries.length;
    const content = page.locator('.note-live-editor-host > .cm-editor .cm-content:not(.note-table-cell-editor)').first();
    await content.dispatchEvent('compositionstart', { data: '' }); await page.keyboard.press('Control+Space'); await sleep(200);
    assert.equal(queries.length, imeQueries, 'IME candidates do not query');
    await content.dispatchEvent('compositionend', { data: '' }); await settle();
    await reset('[[]]', 2); const cdp = await page.context().newCDPSession(page), beforeNativeIme = queries.length;
    await cdp.send('Input.imeSetComposition', { text: '电子', selectionStart: 2, selectionEnd: 2 });
    await sleep(220); assert.equal(queries.length, beforeNativeIme, 'native candidate text is not queried');
    await cdp.send('Input.insertText', { text: '电子' }); await menu.waitFor(); await choose('电子学');
    assert.equal(await value(), '[[电子学]]', 'committing Chinese resumes suggestions');

    await reset('| H | Z |\n| --- | --- |\n|  |  |', 0);
    await page.locator('.note-table td').first().click(); await page.keyboard.type('[['); await menu.waitFor();
    assert.equal(await page.locator('.note-table-cell-editor').count(), 1);
    await choose('Visited', 'Tab'); assert((await value()).includes('[[Visited]]'));
    assert.equal(await page.locator('.note-table-cell-editor').count(), 1, 'accepting does not leave the cell');
    await page.keyboard.press('Control+z'); assert(!(await value()).includes('[[Visited]]'), 'parent history owns cell completion');

    for (const theme of ['default', 'claude', 'sky', 'apple']) {
      await page.evaluate(theme => RelatumNoteTheme.apply(theme), theme);
      for (const dark of [false, true]) {
        await page.evaluate(dark => { document.body.dataset.startTheme = dark ? 'dark' : 'light'; }, dark);
        await suggestions();
        assert(await menu.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; }));
        const colors = await menu.evaluate(node => { const css = getComputedStyle(node); return [css.backgroundColor, css.color]; });
        assert.notEqual(colors[0], colors[1]);
        if (theme === 'apple' && !dark) await page.screenshot({ path: path.join(root, 'completion-apple-light.png') });
      }
    }
    await page.setViewportSize({ width: 520, height: 700 }); await suggestions();
    assert(await menu.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    await page.evaluate(() => __links.setNoteSettingsOpen(true, { category: 'editing' })); await menu.waitFor({ state: 'hidden' });
    const dialog = page.locator('#note-settings-dialog'); await dialog.waitFor();
    assert.equal(await dialog.locator('.note-link-completion-settings').count(), 1);
    await page.screenshot({ path: path.join(root, 'settings-narrow.png') });
    const automatic = dialog.locator('[data-link-setting="automatic"]'); await automatic.uncheck();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteLinkCompletion:v1')).automatic), false);
    await page.evaluate(() => __links.setNoteSettingsOpen(false, { instant: true }));
    await page.evaluate(() => RelatumNoteLinkCompletion.reset());

    await page.setViewportSize({ width: 1300, height: 900 });
    let held = null, releaseHeld = null, failNext = true, dropSelected = true;
    const handler = async route => {
      const body = route.request().postDataJSON();
      if (body.mode !== 'link-completion') return route.continue();
      if (body.selectedPath && dropSelected) { dropSelected = false; return route.fulfill({ json: { items: [], index: { phase: 'ready' } } }); }
      if (body.q === 'slow') { held = route; await new Promise(resolve => { releaseHeld = resolve; });
        return route.fulfill({ json: { items: [{ path: 'Late.md', title: 'Late', location: '', insertTarget: 'Late', titleHighlights: [] }], index: { phase: 'ready' } } }).catch(() => {}); }
      if (body.q === 'retry' && failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: 'test unavailable' } }); }
      return route.continue();
    };
    await page.route('**/api/note-query', handler);
    await suggestions(); await page.keyboard.press('Enter'); await sleep(220); await menu.waitFor();
    assert.equal(await value(), '[[]]', 'failed target recheck leaves the input untouched and refreshes candidates');
    await reset(); await page.keyboard.type('[[slow');
    await page.waitForFunction(() => document.querySelector('.note-link-completion-status')?.textContent.includes('正在查找'));
    for (let i = 0; i < 50 && !held; i++) await sleep(20);
    assert(held); await reset('new document'); releaseHeld(); await sleep(200);
    assert.equal(await value(), 'new document'); assert.equal(await menu.count(), 0, 'late results never reopen in another document');
    await reset(); await page.keyboard.type('[[retry'); await status.getByRole('button', { name: '重试' }).waitFor();
    await status.getByRole('button', { name: '重试' }).click(); await sleep(400);
    assert((await status.textContent()).includes('匹配') && !(await status.getByRole('button').count()), 'retry displays the available-index empty result');
    assert.equal(queries.filter(query => query.q === 'retry').length, 2);
    assert(await page.evaluate(() => __links.editor.view.hasFocus), 'retry preserves editor focus');
    await page.unroute('**/api/note-query', handler);

    const prefBefore = await page.evaluate(() => RelatumNoteLinkCompletion.read());
    const failed = await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'canvas:noteLinkCompletion:v1') throw new Error('test storage failure'); return original.call(this, key, value); };
      try { return RelatumNoteLinkCompletion.update({ ...RelatumNoteLinkCompletion.read(), automatic: false }); }
      finally { Storage.prototype.setItem = original; }
    });
    assert.equal(failed, false); assert.deepEqual(await page.evaluate(() => RelatumNoteLinkCompletion.read()), prefBefore);

    await page.evaluate(() => RelatumNoteLinkCompletion.update({ automatic: false, scope: 'notebook', sort: 'name', includeBody: true }));
    await page.reload(); await page.waitForFunction(() => window.__links?.state.initialized && __links.state.active);
    assert.deepEqual(await page.evaluate(() => RelatumNoteLinkCompletion.read()), { automatic: false, scope: 'notebook', sort: 'name', includeBody: true });
    await page.evaluate(() => __links.openNote('Main.md'));
    await page.evaluate(() => __links.setNoteSettingsOpen(true, { category: 'editing' })); await dialog.waitFor();
    await dialog.getByRole('button', { name: '恢复此分类默认值' }).click(); await sleep(100);
    await dialog.locator('[data-settings-action="accept-reset"]').click(); await sleep(100);
    assert.deepEqual(await page.evaluate(() => RelatumNoteLinkCompletion.read()), { automatic: true, scope: 'all', sort: 'smart', includeBody: false });
    await page.evaluate(() => __links.setNoteSettingsOpen(false, { instant: true }));

    await suggestions(); await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await menu.waitFor({ state: 'hidden' });
    await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, queries: queries.length, isolatedRoot: root }));
  } finally { await browser?.close(); service.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

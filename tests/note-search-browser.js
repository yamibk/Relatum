'use strict';
// Actual Edge or freshly built EXE/WebView2, isolated Markdown and preferences.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = process.env.RELATUM_NOTE_RELEASE || '';
async function port() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value;
}
async function run(browser, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-search-')), notes = path.join(root, 'notes');
  fs.mkdirSync(notes);
  for (let i = 0; i < 320; i++) fs.writeFileSync(path.join(notes, `N${String(i).padStart(3, '0')}.md`), '# 记录 ' + i + '\n学习知识，Alpha beta 中文。\n\n```js\nconst calculate = ' + i + ';\n```\n#学/统计\n');
  for (const book of ['One', 'Two']) {
    fs.mkdirSync(path.join(notes, 'CustomNotebook', book), { recursive: true });
    fs.writeFileSync(path.join(notes, 'CustomNotebook', book, 'A.md'), `学习，Alpha beta ${book}\n#学/概率\n`);
  }
  fs.mkdirSync(path.join(notes, 'Nested'));
  fs.mkdirSync(path.join(notes, 'Nested', 'Deep', 'Leaf'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'Nested', 'Deep', 'Leaf', 'Plain.md'), 'independent plain text');
  let longText = '# 长文\n' + '章节内容，学习与记录。\n'.repeat(600) + '\n> [!note]- 折叠内容\n> 针点😀 Alpha beta\n';
  const longPath = path.join(notes, 'Nested', 'Hit.md'); fs.writeFileSync(longPath, longText);
  const overlay = Buffer.from(JSON.stringify({ items: [{ id: 't', text: '图上学习 ImageText', x: .5, y: .5, size: 'md', color: 'black' }] })).toString('base64url');
  fs.writeFileSync(path.join(notes, 'Image.md'), `![图片](image.png) <!--relatum:image-text:v1:${overlay}-->\n`);
  fs.writeFileSync(path.join(notes, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const listen = await port(), debug = release ? await port() : 0;
  let url = `http://127.0.0.1:${listen}`;
  const profile = mode === 'full' ? [] : ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'))).features.map(f => [f.id, ['notes', 'notes.graph'].includes(f.id) || mode === 'notes-only' && f.id === 'notes.canvas'])) })];
  const service = spawn(release ? path.join(release, 'Relatum.exe') : process.env.RELATUM_PYTHON || 'python',
    release ? profile : ['app.py', '--no-browser', '--port', String(listen), ...profile],
    { cwd: release || repo, env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(release ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}` } : {}) }, windowsHide: true, stdio: 'ignore' });
  let context, connection, page;
  try {
    if (release) {
      for (let i = 0; i < 200; i++) {
        try { if ((await fetch(`http://127.0.0.1:${debug}/json/version`)).ok) break; } catch {}
        assert.equal(service.exitCode, null); await sleep(100);
      }
      connection = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`); context = connection.contexts()[0];
      for (let i = 0; i < 100; i++) { page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(100); }
      assert(page); url = new URL(page.url()).origin;
    } else { context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); page = await context.newPage(); }
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch {} await sleep(100); }
    const errors = [], queries = [], treeRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/note-query')) queries.push(request.postDataJSON()); if (request.url().includes('/api/notes-tree')) treeRequests.push(request.url()); });
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, selectNotebook, setViewMode, renderTree, setTreeSort, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0'); });
    await page.goto(url + (release ? '/?desktop=1' : ''));
    await page.waitForFunction(() => window.T?.state.initialized && T.state.active);
    for (let i = 0; i < 200; i++) { if ((await (await fetch(url + '/api/note-index-state')).json()).phase === 'ready') break; await sleep(50); }
    await page.locator('[data-note-action="toggle-all-folders"]').click();
    await page.waitForFunction(() => T.state.expanded.has('Nested/Deep/Leaf') && T.state.entryIndex.has('Nested/Deep/Leaf/Plain.md'));
    await page.locator('[data-note-action="toggle-all-folders"]').click();
    await page.keyboard.press('Control+Shift+F');
    const input = page.locator('[data-note-search="query"]'); await input.waitFor({ state: 'visible' });
    const search = async q => {
      const response = q ? page.waitForResponse(response => response.url().includes('/api/note-query') && response.request().postDataJSON()?.q === q && response.status() === 200) : null;
      await input.fill(q); await input.press('Enter'); if (response) await response;
      if (!q) await page.waitForFunction(() => document.querySelector('.note-browser-results-head')?.textContent.includes('0'));
      await page.waitForFunction(() => document.querySelector('.note-browser-results')?.getAttribute('aria-busy') === 'false');
    };
    const count = async n => page.waitForFunction(n => document.querySelector('.note-browser-results-head')?.textContent.includes(String(n)), n);
    await search('学习'); await count(324);
    assert.equal(await page.locator('.note-browser-result').count(), 50);
    assert.equal(await page.locator('.note-search-filters').isVisible(), false);
    for (let i = 0; i < 4; i++) {
      await page.locator('.note-browser-more').click();
      if (i < 3) await page.waitForFunction(n => document.querySelectorAll('.note-browser-result').length === n, (i + 2) * 50);
      else await page.waitForFunction(() => document.querySelector('.note-browser-result[aria-setsize="250"]'));
      // The new DOM can arrive before loadPage's finally clears its busy flag.
      await page.waitForFunction(() => document.querySelector('.note-browser-results')?.getAttribute('aria-busy') === 'false');
    }
    assert(await page.locator('.note-browser-result').count() < 90, '250 loaded rows use viewport-sized DOM');
    const loaded = await page.evaluate(() => document.querySelector('.note-browser-result').getAttribute('aria-setsize'));
    assert.equal(loaded, '250');
    await page.locator('.note-browser-results').evaluate(el => el.scrollTop = el.scrollHeight);
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length < 90 && document.querySelector('.note-browser-result[aria-setsize="250"]'));
    await page.locator('.note-browser-results').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: path.join(root, 'search-light.png') });
    await page.locator('[data-note-search="scope"]').selectOption('b:CustomNotebook/One'); await count(1);
    assert.equal(await page.locator('.note-browser-result').first().getAttribute('data-note-browser-path'), 'CustomNotebook/One/A.md');
    await page.locator('[data-note-search="scope"]').selectOption('b:'); await count(322);
    await page.locator('.note-search-filter-button').click();
    await page.locator('[data-note-search="tags"]').fill('学/统计'); await count(320);
    await page.locator('[data-note-search="after"]').fill('2050-01-01'); await page.locator('[data-note-search="after"]').dispatchEvent('change'); await count(0);
    await page.locator('[data-note-search="clear"]').click(); await count(322);
    await page.locator('[data-note-search="folder"]').fill('Nested'); await count(1);
    await page.locator('[data-note-search="clear"]').click();
    await page.locator('[data-note-search="scope"]').selectOption('all'); await count(324);
    await search('"Alpha beta"'); await count(323);
    assert((await page.locator('.note-browser-result mark').first().textContent()).includes('Alpha beta'), 'case is preserved in excerpt');
    await search('calculate'); await count(320);
    await search('Plain'); await count(1); assert.equal(await page.locator('.note-browser-result strong mark').textContent(), 'Plain');
    await search('ImageText'); await count(1);
    assert((await page.locator('.note-browser-result').textContent()).includes('图上学习'));
    // Chromium's real composition path, not synthetic input events.
    await search(''); await sleep(250); await input.focus();
    const cdp = await context.newCDPSession(page), beforeIme = queries.length;
    await cdp.send('Input.imeSetComposition', { text: '学习', selectionStart: 2, selectionEnd: 2 });
    await sleep(220); assert.equal(queries.length, beforeIme, 'candidate text is not queried');
    await cdp.send('Input.insertText', { text: '学习' }); await count(324);
    assert(queries.length > beforeIme);
    await search('针点😀'); await count(1);
    await page.locator('.note-browser-result').click();
    await page.waitForFunction(() => T.state.current?.path === 'Nested/Hit.md');
    await page.waitForFunction(() => { const s = T.editor.view.state.selection.main; return T.editor.view.state.doc.sliceString(s.from, s.to) === '针点😀'; });
    await page.waitForFunction(() => T.editor.view.scrollDOM.scrollTop > 200);
    await page.locator('[data-role="note-browser-back"]').click();
    assert.equal(await input.inputValue(), '针点😀');
    assert.equal(await page.locator('.note-browser-result.is-selected').count(), 1);
    // Change the file after showing the result, keeping its old result revision.
    await page.evaluate(() => T.state.documentCache.delete('Nested/Hit.md'));
    longText = '新增前言\n'.repeat(100) + longText; fs.writeFileSync(longPath, longText);
    await page.locator('.note-browser-result').click();
    await page.waitForFunction(expected => T.editor.view.state.doc.toString() === expected, longText);
    await page.waitForFunction(() => { const s = T.editor.view.state.selection.main; return T.editor.view.state.doc.sliceString(s.from, s.to) === '针点😀'; });
    assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.from), longText.indexOf('针点😀'), 'changed revisions relocate the original search');
    await page.evaluate(() => T.setViewMode('reading'));
    await page.locator('[data-role="note-browser-back"]').click(); await page.locator('.note-browser-result').click();
    await page.waitForFunction(() => T.state.viewMode === 'reading' && document.querySelector('[data-role="note-reading-view"]').scrollTop > 200);
    assert.equal(await page.locator('.md-callout-body[hidden]').count(), 0, 'reading location unfolds the matching callout');
    await page.locator('[data-role="note-browser-back"]').click();
    await page.evaluate(() => { document.body.dataset.startTheme = document.documentElement.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await page.screenshot({ path: path.join(root, 'search-dark.png') });
    await page.setViewportSize({ width: 620, height: 800 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(root, 'search-narrow.png') });
    assert.equal(await page.locator('.note-search-controls').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    // Index activity follows native minimization even when document.hidden=false.
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } })); });
    await sleep(150); assert.equal((await (await fetch(url + '/api/note-index-state')).json()).visible, false);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } })); });
    await sleep(150); assert.equal((await (await fetch(url + '/api/note-index-state')).json()).visible, true);
    assert.deepEqual(errors, []);
    assert(queries.some(q => q.cursor), 'result pagination uses generation-bound cursors');
    console.log(JSON.stringify({ mode, native: !!release, result: 'note search: ok', queries: queries.length, initialTreeRequests: treeRequests.length, screenshots: root }));
  } finally {
    if (context && !release) await context.close();
    if (release && page && service.exitCode === null) {
      await page.evaluate(() => window.pywebview.api.close_window()).catch(() => {});
      if (service.exitCode === null) await Promise.race([new Promise(resolve => service.once('exit', resolve)), sleep(5000)]);
    }
    if (connection) await connection.close();
    if (release && service.exitCode === null) await execute('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else if (!release) service.kill();
    console.log('Isolated search fixtures: ' + root);
  }
}
(async () => {
  const browser = release ? null : await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ['full', 'notes-only', 'notes-no-canvas']) await run(browser, mode); }
  finally { if (browser) await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

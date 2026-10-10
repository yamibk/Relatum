'use strict';
// Unified sidebar acceptance in real Edge and an isolated, disposable library.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-sidebar-'));
const notes = path.join(root, 'notes');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(path.join(notes, 'Folder'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'A.md'), '开始\n\n正文 #Topic\n');
  fs.writeFileSync(path.join(notes, 'Folder', 'Nested.md'), '子目录正文 #Topic\n');
  for (let i = 0; i < 110; i++) fs.writeFileSync(path.join(notes, `N${String(i).padStart(3, '0')}.md`), `笔记 ${i} #Topic\n`);
  fs.appendFileSync(path.join(notes, 'N000.md'), Array.from({ length: 35 }, (_, i) => `#Tag${i}`).join(' ') + '\n');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      if (!localStorage.getItem('canvas:noteOpenTabs:v1')) {
        localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
        localStorage.setItem('canvas:noteActivePath:v1', 'A.md');
        localStorage.setItem('canvas:noteExpandedFolders:v1', '["Folder"]');
      }
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    let source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    source = source.replace('  async function beforeBrowse() {',
      '  async function beforeBrowse() { if (window.holdBrowse) await new Promise(resolve => { window.releaseBrowse = resolve; });');
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, runDocumentPrefetch, stopDocumentPrefetch, stopExternalSync, get prefetching(){return prefetchRunning;}, get editor(){return liveEditor;}, get browser(){return noteBrowser;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.initialized && T.state.current?.path === 'A.md' && T.editor);
    const toggle = page.locator('[data-note-action="toggle-browser"]');
    const scroller = page.locator('[data-role="note-sidebar-scroll"]');
    const disclosure = page.locator('[data-role="note-browser-disclosure"]');
    const navigation = page.locator('[data-role="note-browser-navigation"]');
    const tree = page.locator('[data-role="note-tree"]');
    const recent = page.locator('[data-note-browser-provider="recent"]');
    const tagHeading = page.locator('[data-note-browser-provider="tags"]');
    const results = page.locator('[data-role="note-browser-results"]');
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function settled(open) {
      await page.waitForFunction(open => {
        const shell = document.querySelector('.note-browser-disclosure');
        return open ? !shell.hidden && shell.classList.contains('is-open') && getComputedStyle(shell).opacity === '1' : shell.hidden;
      }, open);
      await frame();
    }
    const queryCount = () => requests.filter(url => url.includes('/api/note-query')).length;
    assert(!requests.some(url => /\/note-browser\.js/.test(url)), 'collapsed cold start keeps the browser module lazy');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      window.originalRows = [...document.querySelector('[data-role="note-tree"]').querySelectorAll('.note-tree-row')];
      window.originalView = T.editor.view; window.originalDoc = T.editor.view.state.doc;
    });
    // A cancelled lazy load cannot open the disclosure when its script arrives.
    let releaseScript, scriptSeen;
    const scriptGate = new Promise(resolve => { releaseScript = resolve; });
    const seenScript = new Promise(resolve => { scriptSeen = resolve; });
    await page.route('**/note-browser.js', async route => { scriptSeen(); await scriptGate; await route.continue(); });
    await toggle.click(); await seenScript; await toggle.click(); releaseScript();
    await page.waitForFunction(() => window.RelatumNoteBrowser && T.browser);
    await settled(false); await page.unroute('**/note-browser.js');
    assert.equal(await page.locator('.note-browser-showing-results').count(), 0);
    await toggle.click(); await settled(true);
    assert.equal(queryCount(), 0, 'disclosure opening does not load any result page');
    assert.equal(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc), true);
    assert.equal(await page.locator('[data-role="note-browser-back"]').isVisible(), false, 'mere expansion does not create a back destination');
    await page.screenshot({ path: path.join(root, 'sidebar-light.png') });
    for (const action of ['new-note', 'new-folder', 'toggle-sort', 'toggle-all-folders']) {
      assert.equal(await page.locator(`.note-tree-pane [data-note-action="${action}"]`).isEnabled(), true, 'tree tools remain available: ' + action);
    }
    // Reverse an in-flight height transition, rather than restarting at an endpoint.
    const animation = await page.evaluate(async () => {
      const button = document.querySelector('[data-note-action="toggle-browser"]');
      const shell = document.querySelector('.note-browser-disclosure'), tree = document.querySelector('[data-role="note-tree"]');
      const measure = () => ({ height: shell.getBoundingClientRect().height, top: tree.getBoundingClientRect().top });
      const full = measure(); button.click(); await new Promise(resolve => setTimeout(resolve, 60)); const middle = measure();
      button.click(); await Promise.resolve(); const reversed = measure();
      await new Promise(resolve => setTimeout(resolve, 300)); const final = measure();
      return { full, middle, reversed, final, hidden: shell.hidden };
    });
    assert(animation.middle.height > 0 && animation.middle.height < animation.full.height - 2);
    assert(Math.abs(animation.reversed.height - animation.middle.height) < 3, 'reversal starts from the current height');
    assert(Math.abs(animation.final.height - animation.full.height) < 1 && !animation.hidden, 'old close completion cannot hide a reopened session');
    assert(Math.abs((animation.full.top - animation.middle.top) - (animation.full.height - animation.middle.height)) < 1, 'tree follows the disclosure height');
    await page.evaluate(() => { const b = document.querySelector('[data-note-action="toggle-browser"]'); for (let i = 0; i < 9; i++) b.click(); });
    await settled(false); await toggle.click(); await settled(true);
    // A late tag catalog must be discarded, with expanded state retained for retry.
    let releaseTags, tagsSeen, firstTags = true;
    const tagsGate = new Promise(resolve => { releaseTags = resolve; });
    const seenTags = new Promise(resolve => { tagsSeen = resolve; });
    await page.route('**/api/note-tags', async route => {
      if (firstTags) { firstTags = false; tagsSeen(); await tagsGate; }
      await route.continue();
    });
    const lateTags = page.waitForResponse(response => response.url().endsWith('/api/note-tags'));
    await tagHeading.click(); await seenTags; await toggle.click(); releaseTags();
    await (await lateTags).finished(); await settled(false);
    assert.equal(await page.locator('[data-note-browser-tag="topic"]').count(), 0);
    await toggle.click(); await settled(true); await page.locator('[data-note-browser-tag="topic"]').waitFor();
    await page.unroute('**/api/note-tags');
    await page.evaluate(() => { window.originalTag = document.querySelector('[data-note-browser-tag="topic"]'); });
    await page.evaluate(() => { T.stopDocumentPrefetch(); T.stopExternalSync(); });
    await page.waitForFunction(() => !T.prefetching);
    await page.evaluate(() => {
      T.state.documentCache.forEach((value, key) => { if (value !== T.state.current) T.state.documentCache.delete(key); });
      document.querySelector('[data-role="note-sidebar-scroll"]').scrollTop = 0;
    });
    const prefetchCount = requests.filter(url => url.includes('/api/note?')).length;
    await page.evaluate(() => T.runDocumentPrefetch());
    assert.equal(requests.filter(url => url.includes('/api/note?')).length, prefetchCount, 'prefetch ignores tree rows below the common viewport when tags fill it');
    // No scroll anchoring or focus restoration may scroll the shared container.
    await scroller.evaluate(el => { el.scrollTop = 430; });
    const scrollBefore = await scroller.evaluate(el => el.scrollTop);
    await toggle.click(); await settled(false); assert.equal(await scroller.evaluate(el => el.scrollTop), scrollBefore);
    await toggle.click(); await settled(true); assert.equal(await scroller.evaluate(el => el.scrollTop), scrollBefore);
    assert.equal(await tagHeading.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => originalTag === document.querySelector('[data-note-browser-tag="topic"]')), true);
    assert.equal(await page.evaluate(() => {
      const rows = [...document.querySelector('[data-role="note-tree"]').querySelectorAll('.note-tree-row')];
      return rows.length === originalRows.length && rows.every((row, i) => row === originalRows[i]);
    }), true, 'tree row identity and expansion survive every disclosure transition');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.note-sidebar-scroll, .note-tree-scroll, .note-browser-navigation')].filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY)).length), 1, 'only the common sidebar scrolls');
    await page.evaluate(async () => { T.stopExternalSync(); await CanvasNoteWorkspace.refresh(); T.stopExternalSync(); });
    assert.equal(await page.evaluate(() => originalRows.every(row => row.isConnected)), true, 'unchanged external tree check does not rebuild rows');
    // Real Chromium composition keeps its native host and commits once after toggling.
    await scroller.evaluate(el => { el.scrollTop = 0; });
    const savedBeforeInput = fs.readFileSync(path.join(notes, 'A.md'), 'utf8');
    const savesBeforeInput = requests.filter(url => url.endsWith('/api/note-save')).length;
    await page.evaluate(() => { const view = T.editor.view; view.dispatch({ selection: { anchor: 2 } }); T.editor.focus(); window.imeHost = document.activeElement; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    assert.equal(await page.evaluate(() => T.editor.inputPending), true);
    await toggle.click(); await settled(false); await toggle.click(); await settled(true);
    assert.equal(await page.evaluate(() => document.activeElement === imeHost && T.editor.inputPending), true, 'disclosure does not blur or settle composition');
    assert.equal(requests.filter(url => url.endsWith('/api/note-save')).length, savesBeforeInput, 'disclosure never triggers save');
    assert.equal(fs.readFileSync(path.join(notes, 'A.md'), 'utf8'), savedBeforeInput);
    await cdp.send('Input.insertText', { text: '中' });
    await page.waitForFunction(() => !T.editor.inputPending);
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert(fs.readFileSync(path.join(notes, 'A.md'), 'utf8').includes('开始中'));
    // Save failure blocks entering results, but cannot block left-side disclosure.
    await page.route('**/api/note-save', route => route.fulfill({ status: 500, json: { error: 'Isolated save failure' } }));
    await page.evaluate(() => T.editor.replaceSelection('待保存'));
    await toggle.click(); await settled(false); await toggle.click(); await settled(true);
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/note-save') && response.status() === 500), recent.click()]);
    assert.equal(await page.locator('.note-browser-showing-results').count(), 0);
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.dirty), true);
    await page.unroute('**/api/note-save'); await recent.click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 50);
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 100);
    await results.evaluate(el => { el.scrollTop = 600; });
    await page.evaluate(() => { window.resultRow = document.querySelector('.note-browser-result'); });
    await toggle.click(); await settled(false);
    assert.equal(await page.evaluate(() => resultRow === document.querySelector('.note-browser-result')), true);
    assert.equal(await results.evaluate(el => el.scrollTop), 600);
    await tree.locator('[data-note-path="A.md"]').click();
    assert.equal(await results.isVisible(), false, 'tree opens documents with navigation collapsed');
    await page.locator('[data-role="note-browser-back"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 100 && !document.querySelector('.note-browser-results').hidden);
    assert.equal(await results.evaluate(el => el.scrollTop), 600, 'back keeps pagination and scroll after tree navigation');
    await page.locator('button[data-start-workspace="canvas"]').click();
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => T.state.active && !document.querySelector('.note-browser-results').hidden);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'workspace return preserves collapsed navigation');
    assert.equal(await results.evaluate(el => el.scrollTop), 600, 'workspace return resumes results independently of navigation');
    await page.locator('.note-browser-result').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-role="note-browser-back"]').hidden);
    await toggle.click(); await settled(true);
    // A newer file-tree action supersedes an entry waiting at its input/save boundary.
    const beforeStaleBrowse = queryCount();
    await page.evaluate(() => { window.holdBrowse = true; }); await recent.click();
    await page.waitForFunction(() => window.releaseBrowse);
    await tree.locator('[data-note-path="A.md"]').click();
    await page.evaluate(() => { window.holdBrowse = false; window.releaseBrowse(); }); await frame();
    assert.equal(await results.isVisible(), false, 'late browse preparation cannot replace a newer file-tree document');
    assert.equal(queryCount(), beforeStaleBrowse);
    // Navigation blank/drop events never select files or run file import.
    const beforeDrop = requests.filter(url => url.includes('/api/note-import')).length;
    const selectionBeforeDrop = await page.evaluate(() => T.state.selectedPath);
    await navigation.evaluate(el => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['ignored'], 'Ignored.md', { type: 'text/markdown' }));
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    assert.equal(await page.evaluate(() => T.state.selectedPath), selectionBeforeDrop);
    assert.equal(requests.filter(url => url.includes('/api/note-import')).length, beforeDrop);
    await tree.locator('[data-note-path="A.md"]').click({ button: 'right' });
    await page.locator('[data-role="note-context-menu"]').waitFor(); await page.keyboard.press('Escape');
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('[data-role="note-sort-menu"]').waitFor(); await page.keyboard.press('Escape');
    for (const open of [false, true]) {
      await toggle.click(); await settled(open);
      for (const action of ['new-note', 'new-folder', 'toggle-sort', 'toggle-all-folders']) {
        assert.equal(await page.locator(`.note-tree-pane [data-note-action="${action}"]`).isEnabled(), true);
      }
      const expand = page.locator('[data-note-action="toggle-all-folders"]');
      const wasExpanded = await expand.getAttribute('aria-pressed');
      await expand.click(); assert.notEqual(await expand.getAttribute('aria-pressed'), wasExpanded);
      await expand.click(); assert.equal(await expand.getAttribute('aria-pressed'), wasExpanded);
      const file = open ? 'Imported-expanded.md' : 'Imported-collapsed.md';
      await tree.evaluate((el, file) => {
        const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['临时导入正文'], file, { type: 'text/markdown' }));
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      }, file);
      await page.waitForFunction(file => !T.state.importRunning && T.state.current?.path === file, file);
      assert.equal(fs.readFileSync(path.join(notes, file), 'utf8'), '临时导入正文', 'tree drop works with navigation ' + (open ? 'open' : 'closed'));
    }
    // Workspace Tab still toggles the right sidebar from a file-tree focus.
    await tree.focus();
    const sideOpen = () => page.locator('.note-workspace').evaluate(el => el.classList.contains('links-overlay-open'));
    const sideWasOpen = await sideOpen();
    await page.keyboard.press('Tab'); assert.equal(await sideOpen(), !sideWasOpen);
    await page.keyboard.press('Tab'); assert.equal(await sideOpen(), sideWasOpen);
    await page.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = document.documentElement.dataset.startTheme = 'dark'; });
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse note browsing');
    assert.equal(await toggle.getAttribute('data-ui-tooltip'), 'Collapse note browsing');
    await tagHeading.click(); await scroller.evaluate(el => { el.scrollTop = 0; }); await pause(250);
    await page.screenshot({ path: path.join(root, 'sidebar-dark.png') });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('.note-document-head .note-mobile-pane-button').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.note-tree-pane')).transform === 'none');
    await page.screenshot({ path: path.join(root, 'sidebar-narrow.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await toggle.click(); await settled(false); await toggle.click(); await settled(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggle.click(); assert.equal(await disclosure.isHidden(), true);
    await toggle.click(); assert.equal(await disclosure.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    // Both old preference values restore disclosure only, preserving the active document.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    const restoredPath = await page.evaluate(() => T.state.current.path);
    const beforeReloadQueries = queryCount(); await page.reload();
    await page.waitForFunction(path => window.T?.state.current?.path === path && document.querySelector('.note-browser-disclosure').classList.contains('is-open'), restoredPath);
    assert.equal(queryCount(), beforeReloadQueries, 'expanded cold start does not query recent results');
    assert.equal(await results.isVisible(), false);
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse note browsing');
    await toggle.click(); await page.reload();
    await page.waitForFunction(path => window.T?.state.initialized && T.state.current?.path === path, restoredPath);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand note browsing');
    assert.equal(await disclosure.isHidden(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'unified note sidebar: ok', screenshots: root, notes: 114, nativeComposition: true }));
  } finally { if (browser) await browser.close(); server.kill(); console.log('Isolated fixtures: ' + root); }
})().catch(error => { console.error(error); process.exitCode = 1; });

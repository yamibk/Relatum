'use strict';

// Optional acceptance test: host-provided Playwright, isolated real notes API.
// RELATUM_PLAYWRIGHT, RELATUM_PYTHON and RELATUM_EDGE_PATH configure the host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-view-'));
const key = 'canvas:noteViewStates:v1';
const initial = 'First line\n' + 'A test line\n'.repeat(100) + 'Last line';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(path.join(root, 'notes', 'folder'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', 'A.md'), initial);
fs.writeFileSync(path.join(root, 'notes', 'B.md'), 'Second note');
fs.writeFileSync(path.join(root, 'notes', 'folder', 'C.md'), initial);
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, 'notes', `extra-${i}.md`), `Note ${i}`);

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
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
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (error) {}
      if (ready) break;
      await sleep(100);
    }
    assert(ready, 'isolated server did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    let source = fs.readFileSync(path.join(repo, 'assets', 'note-workspace.js'), 'utf8');
    // Expose internals only in the intercepted test response; production has no debug API.
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__noteViewTest = {state, openNote, closeAllTabs, createEntry, movePath, recycleEntry, setViewMode, flushSave, checkExternalChanges, stopExternalSync, stopDocumentPrefetch, snapshot: editorSnapshot, editor: liveEditor, rememberViewState, persistViewStates};\n  window.CanvasNoteWorkspace = {');
    async function prepare(target) {
      const page = await target.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      await page.goto(url);
      await page.waitForFunction(() => window.CanvasNoteWorkspace);
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => window.__noteViewTest?.state.active && window.__noteViewTest.state.initialized);
      return page;
    }
    async function verifyDeferredLinks() {
      const first = 'links-audit-A.md', second = 'links-audit-B.md';
      fs.writeFileSync(path.join(root, 'notes', first), '# Links audit\n\n[[links-audit-B]]\n');
      fs.writeFileSync(path.join(root, 'notes', second), 'Wiki destination');
      const auditContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      try {
        const audit = await prepare(auditContext);
        const requests = [];
        const isLinks = request => new URL(request.url()).pathname === '/api/note-links';
        audit.on('request', request => { if (isLinks(request)) requests.push(new URL(request.url()).searchParams.get('path')); });
        await audit.evaluate(first => __noteViewTest.openNote(first), first);
        await audit.evaluate(() => {
          __noteViewTest.stopExternalSync(); __noteViewTest.stopDocumentPrefetch();
          const native = window.setTimeout;
          window.__captureLinksDelay = false; window.__capturedLinksDelays = [];
          window.setTimeout = function(callback, delay, ...args) {
            const id = native.call(this, callback, delay, ...args);
            if (window.__captureLinksDelay && delay === 500 && typeof callback === 'function') window.__capturedLinksDelays.push(() => callback(...args));
            return id;
          };
        });
        const side = mode => audit.locator(`[data-note-action="side-${mode}"]`);
        async function save(label, capture) {
          await audit.evaluate(async ({label, capture}) => {
            const test = __noteViewTest, view = test.editor.view;
            view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' + label } });
            window.__capturedLinksDelays = []; window.__captureLinksDelay = !!capture;
            let saved;
            try { saved = await test.flushSave(); } finally { window.__captureLinksDelay = false; test.stopExternalSync(); }
            if (!saved) throw new Error('isolated link audit save failed');
          }, {label, capture});
        }
        async function showLinks() {
          if (!(await audit.locator('.note-workspace').evaluate(node => node.classList.contains('links-overlay-open')))) await audit.locator('[data-note-action="toggle-notebooks"]').click();
          await side('notebooks').click();
          const before = requests.length, response = audit.waitForResponse(response => isLinks(response.request()));
          await side('links').click(); await response;
          assert.equal(requests.length, before + 1, 'entering the Links tab queries immediately');
        }
        async function invokeLateCallbacks() {
          assert.equal(await audit.evaluate(() => window.__capturedLinksDelays.length), 1, 'capture the delayed link request independently of editor statistics');
          await audit.evaluate(() => window.__capturedLinksDelays.forEach(callback => callback()));
        }
        if (!(await audit.locator('.note-workspace').evaluate(node => node.classList.contains('links-overlay-open')))) await audit.locator('[data-note-action="toggle-notebooks"]').click();
        for (const mode of ['notebooks', 'canvas', 'guide']) {
          await side(mode).click(); const before = requests.length;
          await save('Save with ' + mode); await sleep(650);
          assert.equal(requests.length, before, mode + ' must not query hidden links after saving');
        }
        await showLinks();
        const coalesced = requests.length;
        await save('First links save'); await sleep(100);
        await save('Second links save'); await sleep(100);
        await save('Third links save'); await sleep(350);
        assert.equal(requests.length, coalesced, 'each save restarts the 500ms link refresh window');
        await sleep(300);
        assert.deepEqual(requests.slice(coalesced), [first], 'continuous saves share one delayed link query');

        const cancellations = ['close', 'tab', 'document', 'workspace', 'hidden', 'pagehide'];
        for (const [index, cancellation] of cancellations.entries()) {
          await audit.evaluate(first => __noteViewTest.openNote(first), first);
          await showLinks(); const before = requests.length;
          const target = 'extra-' + index;
          await save('Cancel on ' + cancellation + '\n[[' + target + ']]', true);
          if (cancellation === 'close') await audit.locator('[data-note-action="close-links"]').click();
          else if (cancellation === 'tab') await side('guide').click();
          else if (cancellation === 'document') {
            const response = audit.waitForResponse(response => isLinks(response.request()));
            await audit.evaluate(second => __noteViewTest.openNote(second), second); await response;
          } else if (cancellation === 'workspace') {
            await audit.locator('button[data-start-workspace="canvas"]').click();
            await audit.waitForFunction(() => !__noteViewTest.state.active);
          } else if (cancellation === 'hidden') {
            await audit.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
          } else await audit.evaluate(() => window.dispatchEvent(new Event('pagehide')));
          await invokeLateCallbacks(); await sleep(650);
          assert.deepEqual(requests.slice(before), cancellation === 'document' ? [second] : [],
            cancellation + ' cancels the pending request and rejects a late callback');
          const resumed = requests.length;
          if (cancellation === 'workspace') {
            await audit.locator('button[data-start-workspace="notes"]').click();
            await audit.waitForFunction(() => __noteViewTest.state.active);
          } else if (cancellation === 'hidden') await audit.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
          else if (cancellation === 'pagehide') await audit.evaluate(() => window.dispatchEvent(new Event('pageshow')));
          await audit.evaluate(() => __noteViewTest.stopExternalSync());
          if (['workspace', 'hidden', 'pagehide'].includes(cancellation)) {
            await sleep(650);
            assert.deepEqual(requests.slice(resumed), [first], cancellation + ' resumes exactly one pending refresh when visible');
            assert(await audit.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: target }).count(), cancellation + ' restores the saved link in the visible panel');
          }
        }
        await showLinks(); const failedLeave = requests.length;
        await save('Pending link refresh before failed leave');
        await audit.route('**/api/note-save', route => route.fulfill({ status: 500, json: { error: 'isolated save failure' } }), { times: 1 });
        await audit.evaluate(() => {
          const view = __noteViewTest.editor.view;
          view.dispatch({ changes: { from: view.state.doc.length, insert: '\nUnsaved before leaving' } });
        });
        const failure = audit.waitForResponse(response => new URL(response.url()).pathname === '/api/note-save');
        await audit.locator('button[data-start-workspace="canvas"]').click();
        assert.equal((await failure).status(), 500);
        await audit.waitForFunction(() => __noteViewTest.state.active && !__noteViewTest.state.saveRunning && !__noteViewTest.state.linksRefreshSuspended);
        await sleep(650);
        assert.deepEqual(requests.slice(failedLeave), [first], 'failed departure restores the pending refresh and keeps the dirty document open');
        assert(await audit.evaluate(() => __noteViewTest.state.current.persistedGeneration < __noteViewTest.state.current.editGeneration));
        const recovered = requests.length;
        await save('Recovery after failed leave'); await sleep(650);
        assert.deepEqual(requests.slice(recovered), [first], 'saving after failed departure resumes normal link refresh');

        await showLinks(); const failedNavigation = requests.length;
        await save('Refresh after failed navigation\n[[extra-12]]');
        await audit.route('**/api/note?path=' + second, route => route.fulfill({ status: 503, json: { error: 'isolated read failure' } }), { times: 1 });
        assert.equal(await audit.evaluate(second => __noteViewTest.openNote(second, { force: true }), second), false);
        assert.equal(await audit.evaluate(() => __noteViewTest.state.current.path), first, 'failed navigation preserves the previous document');
        await audit.evaluate(() => __noteViewTest.stopExternalSync()); await sleep(650);
        assert.deepEqual(requests.slice(failedNavigation), [first], 'failed navigation resumes the previous document refresh');
        assert(await audit.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: 'extra-12' }).count());

        await showLinks(); const finalSave = requests.length;
        let releaseSave, sawSave;
        const saveRelease = new Promise(resolve => { releaseSave = resolve; });
        const saveReceived = new Promise(resolve => { sawSave = resolve; });
        await audit.route('**/api/note-save', async route => {
          const response = await route.fetch(); sawSave(); await saveRelease; await route.fulfill({ response });
        }, { times: 1 });
        await audit.evaluate(() => {
          const view = __noteViewTest.editor.view;
          view.dispatch({ changes: { from: view.state.doc.length, insert: '\n[[extra-13]]' } });
          window.__lateAuditSave = __noteViewTest.flushSave();
        });
        await saveReceived;
        await audit.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        releaseSave(); assert(await audit.evaluate(() => window.__lateAuditSave));
        await sleep(650);
        assert.equal(requests.length, finalSave, 'a save response after pagehide does not restart hidden link work');
        await audit.evaluate(() => window.dispatchEvent(new Event('pageshow'))); await sleep(650);
        assert.deepEqual(requests.slice(finalSave), [first], 'pageshow restores one refresh after the final save finishes');
        assert(await audit.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: 'extra-13' }).count());

        await showLinks(); const departureSave = requests.length;
        await audit.evaluate(() => {
          const view = __noteViewTest.editor.view;
          view.dispatch({ changes: { from: view.state.doc.length, insert: '\n[[extra-14]]' } });
        });
        await audit.locator('button[data-start-workspace="canvas"]').click();
        await audit.waitForFunction(() => !__noteViewTest.state.active); await sleep(650);
        assert.equal(requests.length, departureSave, 'the departure flush saves the new link without querying the hidden panel');
        await audit.locator('button[data-start-workspace="notes"]').click();
        await audit.waitForFunction(() => __noteViewTest.state.active);
        await audit.evaluate(() => __noteViewTest.stopExternalSync()); await sleep(650);
        assert.deepEqual(requests.slice(departureSave), [first], 'returning refreshes links saved by the departure flush');
        assert(await audit.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: 'extra-14' }).count());

        let releaseLinks, sawLinks;
        const linksRelease = new Promise(resolve => { releaseLinks = resolve; });
        const linksReceived = new Promise(resolve => { sawLinks = resolve; });
        await audit.route('**/api/note-links?*', async route => {
          const response = await route.fetch(); sawLinks(); await linksRelease; await route.fulfill({ response });
        }, { times: 1 });
        const staleLinks = requests.length, oldResponse = audit.waitForResponse(response => isLinks(response.request()));
        await side('links').click(); await linksReceived;
        await save('Save during an old links response\n[[extra-15]]');
        releaseLinks(); await oldResponse; await sleep(50);
        assert.equal(await audit.evaluate(() => __noteViewTest.state.current.linksRefreshNeeded), true,
          'a response captured before the save cannot clear the new revision refresh');
        await sleep(650);
        assert.deepEqual(requests.slice(staleLinks), [first, first], 'an old-revision response is followed by one current links request');
        assert(await audit.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: 'extra-15' }).count());
        await showLinks(); await audit.locator('[data-note-action="close-links"]').click();
        const reopened = requests.length, response = audit.waitForResponse(response => isLinks(response.request()));
        await audit.locator('[data-note-action="toggle-notebooks"]').click(); await response;
        assert.equal(requests.length, reopened + 1, 'reopening the Links sidebar queries immediately');
        await audit.locator('[data-note-action="close-links"]').click();
        await audit.evaluate(first => __noteViewTest.openNote(first), first);
        await audit.evaluate(() => __noteViewTest.setViewMode('reading'));
        const wiki = requests.length;
        await audit.locator('[data-role="note-reading-view"] [data-wikilink="links-audit-B"]').click();
        await audit.waitForFunction(second => __noteViewTest.state.current?.path === second, second);
        assert.deepEqual(requests.slice(wiki), [first], 'Wiki navigation still resolves links with the sidebar closed');
        assert.equal(await audit.locator('.note-workspace').evaluate(node => node.classList.contains('links-overlay-open')), false);
      } finally { await auditContext.close(); }
    }
    let page = await prepare(context);
    // Keep this pre-existing DOM reuse suite on name order: a modified-time
    // sort is expected to move rows when an external edit changes their rank.
    await page.locator('[data-note-action="toggle-sort"]').click();
    await page.locator('#note-sort-menu [data-note-sort-mode="name-asc"]').click();
    async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await sleep(120); }
    async function open(name) { await page.evaluate(name => __noteViewTest.openNote(name, { reuseActiveTab: false }), name); await settle(); }
    async function position(anchor, head = anchor, scrollTop) {
      await page.evaluate(({anchor, head, scrollTop}) => {
        const view = __noteViewTest.editor.view;
        view.dispatch({ selection: { anchor, head }, scrollIntoView: scrollTop == null }); view.focus();
        if (scrollTop != null) view.scrollDOM.scrollTop = scrollTop;
      }, {anchor, head, scrollTop});
      await settle();
    }
    async function snapshot() { return page.evaluate(() => { const {anchor, head, scrollTop} = __noteViewTest.snapshot(); return {anchor, head, scrollTop}; }); }
    async function expectPosition(expected, message) {
      const actual = await snapshot();
      assert.equal(actual.anchor, expected.anchor, message + ': anchor');
      assert.equal(actual.head, expected.head, message + ': head');
      assert(Math.abs(actual.scrollTop - expected.scrollTop) < 16, `${message}: scroll ${actual.scrollTop} vs ${expected.scrollTop}`);
    }
    await open('A.md');
    const originalRow = await page.locator('.note-tree-row[data-note-path="A.md"]').elementHandle();
    const treeChanges = await page.evaluate(async () => {
      const records = [];
      const observer = new MutationObserver(changes => records.push(...changes));
      observer.observe(document.querySelector('[data-role="note-tree"]'), {childList: true, subtree: true});
      await __noteViewTest.checkExternalChanges(false);
      records.push(...observer.takeRecords()); observer.disconnect();
      return records.length;
    });
    assert.equal(treeChanges, 0, 'unchanged refresh must not rebuild tree DOM');
    await page.keyboard.press('F2');
    const rename = page.locator('.note-tree-rename');
    await rename.fill('Uncommitted draft');
    const renameNode = await rename.elementHandle();
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert(await renameNode.evaluate(node => node.isConnected && document.activeElement === node), 'refresh preserves rename focus');
    assert.equal(await rename.inputValue(), 'Uncommitted draft');
    await rename.press('Escape');

    fs.writeFileSync(path.join(root, 'notes', 'auto-added.md'), 'Automatic external note');
    await page.locator('.note-tree-row[data-note-path="auto-added.md"]').waitFor({ timeout: 6500 });
    fs.unlinkSync(path.join(root, 'notes', 'auto-added.md'));
    await page.waitForFunction(() => !document.querySelector('.note-tree-row[data-note-path="auto-added.md"]'), null, { timeout: 6500 });

    fs.writeFileSync(path.join(root, 'notes', 'trash-ui.md'), 'Recycle immediately');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    await open('trash-ui.md');
    let releaseTrash;
    const trashRelease = new Promise(resolve => { releaseTrash = resolve; });
    let sawTrashRequest;
    const trashRequested = new Promise(resolve => { sawTrashRequest = resolve; });
    await page.route('**/api/note-trash', async route => {
      sawTrashRequest();
      await trashRelease;
      fs.unlinkSync(path.join(root, 'notes', 'trash-ui.md'));
      const tree = await (await fetch(url + '/api/notes-tree')).json();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, path: 'trash-ui.md', tree }) });
    });
    await page.evaluate(() => { window.__trashPromise = __noteViewTest.recycleEntry({ kind: 'note', path: 'trash-ui.md' }); });
    assert.equal(await page.locator('.note-tree-row[data-note-path="trash-ui.md"]').count(), 0,
      'the Recycle Bin action removes its row before the backend responds');
    await trashRequested;
    releaseTrash();
    await page.evaluate(() => window.__trashPromise);
    await page.unroute('**/api/note-trash');
    assert.equal(await page.evaluate(() => __noteViewTest.state.tabs.includes('trash-ui.md')), false,
      'a confirmed Recycle Bin action removes its tab');

    fs.writeFileSync(path.join(root, 'notes', 'auto-dirty.md'), 'Delete me');
    await page.locator('.note-tree-row[data-note-path="auto-dirty.md"]').waitFor({ timeout: 6500 });
    await open('auto-dirty.md');
    await page.keyboard.type(' unsaved tail');
    fs.unlinkSync(path.join(root, 'notes', 'auto-dirty.md'));
    await page.waitForFunction(() => __noteViewTest.state.current?.path !== 'auto-dirty.md', null, { timeout: 6500 });
    await sleep(800);
    assert.equal(fs.existsSync(path.join(root, 'notes', 'auto-dirty.md')), false, 'an autosave must not recreate an externally deleted note');
    assert.equal(await page.locator('[data-role="note-error"]').isHidden(), true, 'external deletion must not leave a save retry error');

    await page.locator('button[data-start-workspace="canvas"]').click();
    await page.waitForFunction(() => !__noteViewTest.state.active);
    fs.writeFileSync(path.join(root, 'notes', 'inactive-added.md'), 'Added while inactive');
    await sleep(2400);
    assert.equal(await page.locator('.note-tree-row[data-note-path="inactive-added.md"]').count(), 0, 'inactive Notes must not keep polling');
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => __noteViewTest.state.active);
    await page.locator('.note-tree-row[data-note-path="inactive-added.md"]').waitFor({ timeout: 3000 });

    fs.mkdirSync(path.join(root, 'notes', 'auto-folder'));
    fs.writeFileSync(path.join(root, 'notes', 'auto-folder', 'one.md'), 'One');
    fs.writeFileSync(path.join(root, 'notes', 'auto-folder', 'two.md'), 'Two');
    await page.locator('.note-tree-row[data-note-path="auto-folder"]').waitFor({ timeout: 6500 });
    await open('auto-folder/one.md');
    await open('auto-folder/two.md');
    fs.rmSync(path.join(root, 'notes', 'auto-folder'), { recursive: true, force: true });
    await page.waitForFunction(() => !__noteViewTest.state.tabs.some(path => path.startsWith('auto-folder/')), null, { timeout: 6500 });
    assert.equal(await page.locator('.note-tree-row[data-note-path="auto-folder"]').count(), 0, 'external folder deletion removes the full subtree');
    assert.equal(await page.evaluate(() => Array.from(__noteViewTest.state.documentCache.keys()).some(path => path.startsWith('auto-folder/'))), false,
      'external folder deletion clears descendant document caches');

    const metadataRow = await page.locator('.note-tree-row[data-note-path="A.md"]').elementHandle();
    const stat = fs.statSync(path.join(root, 'notes', 'A.md'));
    fs.utimesSync(path.join(root, 'notes', 'A.md'), stat.atime, new Date(stat.mtimeMs + 1000));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert(await metadataRow.evaluate(node => node.isConnected), 'mtime-only refresh retains rows');
    fs.writeFileSync(path.join(root, 'notes', '000-added.md'), 'New external note');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await metadataRow.evaluate(node => node.isConnected), false, 'structural changes rebuild rows');
    assert.equal(await page.locator('.note-tree-row[data-note-path="000-added.md"]').count(), 1);
    fs.unlinkSync(path.join(root, 'notes', '000-added.md'));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row[data-note-path="000-added.md"]').count(), 0);
    await page.route('**/api/notes-tree', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test unavailable"}' }));
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row[data-note-path="A.md"]').count(), 1, 'a transient refresh error must keep the existing tree');
    await page.unroute('**/api/notes-tree');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    assert.equal(await page.locator('.note-tree-row[data-note-path="A.md"]').count(), 1, 'unchanged tree recovers after error');
    await originalRow.dispose();
    await position(initial.length);
    await page.keyboard.type(' local edit');
    await page.evaluate(() => __noteViewTest.flushSave());
    await settle();
    const saved = await snapshot();
    await open('B.md');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    await sleep(150);
    await open('A.md');
    await expectPosition(saved, 'own save -> other note -> refresh -> return');
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await settle();
    await expectPosition(saved, 'unchanged window focus');

    fs.appendFileSync(path.join(root, 'notes', 'A.md'), '\nexternal change');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false));
    await settle();
    await expectPosition(saved, 'external change');
    await page.evaluate(() => __noteViewTest.closeAllTabs());
    await open('A.md');
    await expectPosition(saved, 'close all and reopen');
    for (let i = 0; i < 30; i++) await open(`extra-${i}.md`);
    assert.equal(await page.evaluate(() => __noteViewTest.state.documentCache.has('A.md')), false, 'A must actually be evicted');
    await open('A.md');
    await expectPosition(saved, 'cache eviction');
    await page.locator('button[data-start-workspace="canvas"]').click();
    await page.waitForFunction(() => !__noteViewTest.state.active);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => __noteViewTest.state.active);
    await settle();
    await expectPosition(saved, 'workspace switch');
    await page.screenshot({ path: path.join(root, 'restored-editor.png') });

    await position(50, 0, 0);
    const reversed = await snapshot();
    await open('B.md'); await open('A.md');
    await expectPosition(reversed, 'reverse selection ending at zero');
    await position(700, 700, 530);
    const scrolled = await snapshot();
    await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'A.md' && __noteViewTest.state.active);
    await settle();
    await expectPosition(scrolled, 'reload after selection/scroll only');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const storageState = await context.storageState();
    await context.close();
    context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page = await prepare(context); await settle();
    await expectPosition(scrolled, 'fresh browser context with persisted state');

    assert(await page.evaluate(() => __noteViewTest.movePath('A.md', 'Renamed.md', true)));
    await settle(); await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'Renamed.md');
    await settle(); await expectPosition(scrolled, 'rename survives reload');
    assert.equal(await page.evaluate(() => __noteViewTest.movePath('Renamed.md', 'B.md', true)), false);
    await settle(); await expectPosition(scrolled, 'failed rename');
    await open('folder/C.md'); await position(800); const folderView = await snapshot();
    assert(await page.evaluate(() => __noteViewTest.movePath('folder', 'moved', true)));
    await open('B.md'); await open('moved/C.md');
    await expectPosition(folderView, 'folder move');

    await open('Renamed.md');
    fs.writeFileSync(path.join(root, 'notes', 'Renamed.md'), 'short');
    await page.evaluate(() => __noteViewTest.checkExternalChanges(false)); await settle();
    assert.equal((await snapshot()).anchor, 5, 'shortened document clamps position');
    await open('moved/C.md');
    await page.evaluate(() => __noteViewTest.setViewMode('source')); await settle();
    await position(600); const sourceView = await snapshot();
    await page.evaluate(() => __noteViewTest.setViewMode('live')); await settle();
    await expectPosition(sourceView, 'source/live toggle');
    await page.evaluate(() => __noteViewTest.setViewMode('reading')); await settle();
    await page.evaluate(() => { document.querySelector('[data-role="note-reading-view"]').scrollTop = 500; });
    await settle(); const readingView = await snapshot();
    await page.reload();
    await page.waitForFunction(() => window.__noteViewTest?.state.current?.path === 'moved/C.md');
    await settle(); await expectPosition(readingView, 'reading mode reload');

    await page.evaluate(() => {
      __noteViewTest.setViewMode('live');
      __noteViewTest.rememberViewState('Reused.md', {anchor: 90, head: 90, scrollTop: 400});
    });
    assert(await page.evaluate(() => __noteViewTest.createEntry('note', {parent: '', name: 'Reused.md', content: 'Fresh note '.repeat(30), noFocus: true})));
    await settle();
    assert.equal((await snapshot()).anchor, 0, 'new file must not inherit an old name\'s position');

    await page.evaluate(() => {
      for (let i = 0; i < 220; i++) __noteViewTest.rememberViewState(`memory-${i}.md`, {anchor: i, head: i, scrollTop: 0});
      __noteViewTest.persistViewStates();
    });
    const records = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.equal(records.length, 200);
    assert.deepEqual(Object.keys(records[0][1]).sort(), ['anchor', 'head', 'scrollTop']);
    await page.evaluate(key => localStorage.setItem(key, '{corrupt'), key);
    // A fresh tab reads the corrupt preference without the old page's unload writer.
    const corruptPage = await prepare(context);
    assert(await corruptPage.evaluate(() => !!__noteViewTest.editor));
    await corruptPage.evaluate(() => {
      const native = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'canvas:noteViewStates:v1') throw new Error('quota'); return native.call(this, key, value); };
      __noteViewTest.rememberViewState('test.md', {anchor: 1, head: 1, scrollTop: 0});
      __noteViewTest.persistViewStates();
    });
    await verifyDeferredLinks();
    assert.deepEqual(errors, [], 'browser errors');
    console.log('note view state browser: ok (tree DOM reuse, optimistic recycle, automatic external sync, rename focus, metadata/structure refresh, error recovery, focus, external edits, reopen, eviction, selection, restart, moves, clamping, modes, bounded/corrupt/unavailable storage, deferred visible links and cancellation, closed-sidebar Wiki navigation)');
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Direct wiki creation and remaining Notes prompts, always with disposable data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-modal-'));
fs.mkdirSync(path.join(root, 'notes'));
const original = '正文\n\n' + ['Panel', 'Missing', '名字A', '目录/名字B.md#小节|别名', 'Other', 'Duplicate', 'Repeated', 'Failed', 'Stale', 'Late', 'Unsaved'].map(target => '[[' + target + ']]').join('\n\n') + '\n';
fs.writeFileSync(path.join(root, 'notes/Main.md'), original);
fs.writeFileSync(path.join(root, 'notes/Other.md'), 'Other note');
for (const folder of ['Folder', 'One', 'Two']) fs.mkdirSync(path.join(root, 'notes', folder));
fs.writeFileSync(path.join(root, 'notes/Folder/Source.md'), '[[同目录]]\n');
for (const folder of ['One', 'Two']) fs.writeFileSync(path.join(root, 'notes', folder, 'Duplicate.md'), folder);

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, openWikiFromEditor, canvasNameInput, setViewMode, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Main.md');
      window.wikiModalCount = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches('.note-modal-overlay') || node.querySelector('.note-modal-overlay'))) window.wikiModalCount++;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.current?.path === 'Main.md');
    const modal = page.locator('.note-modal-card');
    const body = () => page.evaluate(() => T.editor.snapshot().value);
    const focusedInModal = () => page.evaluate(() => !!document.activeElement?.closest('.note-modal-card'));
    const creates = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/note-create') creates.push(request.postDataJSON()); });
    async function openWiki(target) { await page.evaluate(target => T.openWikiFromEditor(target), target); }
    async function main() { await page.evaluate(() => T.openNote('Main.md')); }
    async function holdNext(pattern) {
      let release, intercepted;
      const gate = new Promise(resolve => { release = resolve; });
      const received = new Promise(resolve => { intercepted = resolve; });
      let held = false;
      const handler = async route => {
        if (held) { await route.continue(); return; }
        held = true;
        const response = await route.fetch();
        intercepted(); await gate;
        await route.fulfill({ response });
      };
      await page.route(pattern, handler);
      return { received, async release() { release(); await page.unroute(pattern, handler); } };
    }
    assert(!fs.existsSync(path.join(root, 'notes/Missing.md')), 'rendering a wiki link does not create its target');
    await page.locator('.note-live-wikilink').filter({ hasText: 'Missing' }).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => T.state.current?.path === 'Missing.md');
    assert(fs.existsSync(path.join(root, 'notes/Missing.md')), 'live editor wiki activation creates and opens directly');
    await main();
    await page.evaluate(() => T.setViewMode('reading'));
    await page.locator('[data-wikilink="名字A"]').click();
    await page.waitForFunction(() => T.state.current?.path === '名字A.md');
    assert(fs.existsSync(path.join(root, 'notes/名字A.md')), 'reading mode click creates a Chinese filename');
    await main(); await openWiki('目录/名字B.md#小节|别名');
    assert.equal(await page.evaluate(() => T.state.current.path), '目录/名字B.md', 'path, suffix, alias and heading are normalized');
    assert(fs.existsSync(path.join(root, 'notes/目录/名字B.md')), 'explicit paths create parent directories');
    await page.evaluate(() => T.openNote('Folder/Source.md')); await openWiki('同目录');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Folder/同目录.md', 'bare targets stay beside the source');
    await main();
    let before = creates.length;
    await openWiki('Other');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Other.md', 'existing notes are opened');
    assert.equal(creates.length, before, 'existing targets are never recreated');
    await main(); await openWiki('Duplicate');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Main.md', 'ambiguous targets keep the source open');
    assert.equal(creates.length, before, 'ambiguous targets are not created');
    assert(!fs.existsSync(path.join(root, 'notes/Duplicate.md')));
    await page.evaluate(() => Promise.all([T.openWikiFromEditor('Repeated'), T.openWikiFromEditor('Repeated')]));
    assert.equal(creates.length, before + 1, 'repeated activations share one create request');
    await main(); await openWiki('Repeated');
    assert.equal(creates.length, before + 1, 'later activations open the created target');

    await main();
    const sideToggle = page.locator('[data-note-action="toggle-notebooks"]');
    if (await sideToggle.getAttribute('aria-expanded') !== 'true') await sideToggle.click();
    await page.locator('[data-note-action="side-links"]').click();
    const card = page.locator('[data-role="note-outgoing"] .note-link-card').filter({ hasText: 'Panel' });
    await card.click();
    await page.waitForFunction(() => T.state.current?.path === 'Panel.md');
    assert(fs.existsSync(path.join(root, 'notes/Panel.md')), 'links panel uses the same direct creation');
    await page.locator('[data-note-action="side-notebooks"]').click();

    await main();
    const failCreate = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic creation failure' }) });
    await page.route('**/api/note-create', failCreate);
    await openWiki('Failed');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Main.md', 'creation failure keeps the current note');
    assert(!fs.existsSync(path.join(root, 'notes/Failed.md')));
    assert(await page.getByText('Synthetic creation failure', { exact: true }).count(), 'creation failure is reported');
    await page.unroute('**/api/note-create', failCreate);
    await openWiki('../Escape');
    assert(!fs.existsSync(path.join(root, 'Escape.md')), 'path validation still rejects traversal');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Main.md');

    const pendingLinks = await holdNext('**/api/note-links?path=Main.md');
    await page.evaluate(() => { window.wikiTask = T.openWikiFromEditor('Stale'); });
    await pendingLinks.received;
    await page.evaluate(() => T.openNote('Other.md'));
    await pendingLinks.release(); await page.evaluate(() => window.wikiTask);
    assert(!fs.existsSync(path.join(root, 'notes/Stale.md')), 'late link queries cannot create after a document switch');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Other.md');
    await main();
    const pendingCreate = await holdNext('**/api/note-create');
    await page.evaluate(() => { window.wikiTask = T.openWikiFromEditor('Late'); });
    await pendingCreate.received;
    await page.evaluate(() => T.openNote('Other.md'));
    await pendingCreate.release(); await page.evaluate(() => window.wikiTask);
    assert(fs.existsSync(path.join(root, 'notes/Late.md')), 'a started create request completes on disk');
    assert.equal(await page.evaluate(() => T.state.current.path), 'Other.md', 'late creation does not replace the newer document');
    await main();
    await page.evaluate(() => T.setViewMode('live'));
    await page.evaluate(() => T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\n[[仅输入]]\n[[SavedDraft]]' } }));
    assert(!fs.existsSync(path.join(root, 'notes/仅输入.md')), 'typing a complete wiki link does not create a file');
    await openWiki('SavedDraft');
    assert.equal(await page.evaluate(() => T.state.current.path), 'SavedDraft.md');
    assert.equal(fs.readFileSync(path.join(root, 'notes/Main.md'), 'utf8'), original + '\n[[仅输入]]\n[[SavedDraft]]', 'creation saves the source draft before opening the target');
    assert(!fs.existsSync(path.join(root, 'notes/仅输入.md')), 'saving an unclicked link does not create it');
    await main();
    await page.evaluate(original => T.editor.view.dispatch({ changes: { from: 0, to: T.editor.view.state.doc.length, insert: original } }), original);
    await page.evaluate(() => T.flushSave());
    const failSave = route => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save failure' }) });
    await page.route('**/api/note-save', failSave);
    await page.evaluate(() => T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '未保存正文' } }));
    before = creates.length; await openWiki('Unsaved');
    assert.equal(creates.length, before, 'failed source saves prevent creation');
    assert((await body()).endsWith('未保存正文'), 'failed saves retain the editor draft');
    await page.unroute('**/api/note-save', failSave);
    await page.evaluate(original => T.editor.view.dispatch({ changes: { from: 0, to: T.editor.view.state.doc.length, insert: original } }), original);
    await page.evaluate(() => T.flushSave());
    assert.equal(fs.readFileSync(path.join(root, 'notes/Main.md'), 'utf8'), original, 'source Markdown stays intact');
    assert.equal(await page.evaluate(() => window.wikiModalCount), 0, 'wiki activation never mounts a confirmation, even briefly');

    await page.evaluate(() => T.openNote('Main.md'));
    await page.evaluate(() => { T.editor.view.focus(); window.renameResult = undefined; window.renameTask = T.canvasNameInput('Old.canvas').then(value => { window.renameResult = value; }); });
    const input = modal.locator('input'); await input.waitFor();
    assert(await input.evaluate(node => node === document.activeElement), 'canvas name input receives focus');
    await page.keyboard.press('Shift+Tab');
    assert(await modal.locator('button').last().evaluate(node => node === document.activeElement), 'reverse Tab stays in the rename dialog');
    await page.keyboard.press('Tab');
    assert(await input.evaluate(node => node === document.activeElement), 'forward Tab wraps to the rename input');
    const tabs = await page.evaluate(() => T.state.tabs.slice());
    for (const key of ['Control+t', 'Control+n', 'Control+w', 'Control+s', 'Control+Tab', 'Control+1', 'Control+Shift+f', 'F2']) {
      await page.keyboard.press(key);
      assert(await focusedInModal(), key + ' keeps the prompt focused');
    }
    assert.deepEqual(await page.evaluate(() => T.state.tabs.slice()), tabs, 'workspace shortcuts do not act behind a modal');
    await input.fill('新名称');
    await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await modal.count(), 1, 'candidate confirmation does not submit a name');
    await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await modal.count(), 1, 'candidate cancellation does not dismiss the prompt');
    await input.press('Tab'); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.renameResult), null, 'Escape on a button also cancels a rename');
    assert.equal(await page.evaluate(() => document.activeElement === T.editor.view.contentDOM), true, 'cancel restores editor focus');
    assert.equal(await body(), original, 'rename input never edits the note');

    // Replacement cancels the older promise; its scheduled focus must not steal the new field.
    await page.evaluate(() => {
      window.firstResult = undefined; window.secondResult = undefined;
      T.canvasNameInput('First.canvas').then(value => { window.firstResult = value; });
      T.canvasNameInput('Second.canvas').then(value => { window.secondResult = value; });
    });
    await page.waitForFunction(() => window.firstResult === null);
    assert.equal(await modal.count(), 1);
    await input.waitFor(); await page.waitForTimeout(80);
    assert(await input.evaluate(node => node === document.activeElement), 'replacement focuses only the surviving input');
    assert.equal(await input.inputValue(), 'Second');
    await input.fill('提交名称'); await input.press('Enter'); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.secondResult), '提交名称');

    await page.evaluate(() => { window.renameResult = undefined; T.canvasNameInput('Stale.canvas').then(value => { window.renameResult = value; }); });
    await modal.waitFor();
    await page.evaluate(() => T.openNote('Other.md')); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.renameResult), null, 'document replacement cancels a stale rename');
    await page.evaluate(() => { window.renameResult = undefined; T.canvasNameInput('Hidden.canvas').then(value => { window.renameResult = value; }); });
    await modal.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.renameResult), null, 'pagehide cancels pending rename actions');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('note modal browser: ok (direct wiki creation, live/reading/panel, Chinese/path/alias, existing/ambiguous/repeated links, failures, stale responses, rename focus/keyboard/IME and pagehide)');
    await context.close();
  } finally {
    if (browser) await browser.close(); service.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

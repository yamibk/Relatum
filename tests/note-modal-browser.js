'use strict';

// Real Notes prompts, disposable Markdown/preferences, and the existing browser host.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-modal-'));
fs.mkdirSync(path.join(root, 'notes'));
const original = '正文\n\n[[Missing]]\n';
fs.writeFileSync(path.join(root, 'notes/Main.md'), original);
fs.writeFileSync(path.join(root, 'notes/Other.md'), 'Other note');

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
      '  window.T = {state, openNote, openWikiFromEditor, confirmCreateWiki, canvasNameInput, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Main.md');
    });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.current?.path === 'Main.md');
    const modal = page.locator('.note-modal-card');
    const body = () => page.evaluate(() => T.editor.snapshot().value);
    const focusedInModal = () => page.evaluate(() => !!document.activeElement?.closest('.note-modal-card'));
    async function confirm(target = 'Missing') {
      await page.evaluate(target => { window.modalResult = undefined; window.modalTask = T.confirmCreateWiki(target).then(value => { window.modalResult = value; }); }, target);
      await modal.waitFor();
    }
    await page.evaluate(() => { T.editor.view.focus(); T.editor.view.dispatch({ selection: { anchor: T.editor.view.state.doc.length } }); });
    await confirm();
    await page.keyboard.type('x');
    assert.equal(await body(), original, 'typing in a confirmation must not edit the obscured note');
    assert(await focusedInModal(), 'confirmation moves keyboard focus into the dialog');
    assert.equal(await modal.locator('button').first().evaluate(node => node === document.activeElement), true, 'Cancel is the initial confirmation action');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await modal.locator('button').last().evaluate(node => node === document.activeElement), true, 'reverse Tab stays in the dialog');
    await page.keyboard.press('Tab');
    assert.equal(await modal.locator('button').first().evaluate(node => node === document.activeElement), true, 'forward Tab wraps within the dialog');
    const tabs = await page.evaluate(() => T.state.tabs.slice());
    for (const key of ['Control+t', 'Control+n', 'Control+w', 'Control+s', 'Control+Tab', 'Control+1', 'Control+Shift+f', 'F2']) {
      await page.keyboard.press(key);
      assert(await focusedInModal(), key + ' keeps the prompt focused');
    }
    assert.deepEqual(await page.evaluate(() => T.state.tabs.slice()), tabs, 'workspace shortcuts do not act behind a modal');
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement === T.editor.view.contentDOM), true, 'cancel restores the original editor focus');
    assert(!fs.existsSync(path.join(root, 'notes/Missing.md')), 'cancel does not create a file');

    await confirm(); await page.keyboard.press('Enter'); await modal.waitFor({ state: 'detached' });
    assert(!fs.existsSync(path.join(root, 'notes/Missing.md')), 'Enter on the initial Cancel action is harmless');
    await confirm(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => T.state.current?.path === 'Missing.md');
    assert(fs.existsSync(path.join(root, 'notes/Missing.md')), 'Create can be activated with the keyboard');

    await page.evaluate(() => T.openNote('Main.md'));
    await page.evaluate(() => { T.editor.view.focus(); window.renameResult = undefined; window.renameTask = T.canvasNameInput('Old.canvas').then(value => { window.renameResult = value; }); });
    const input = modal.locator('input'); await input.waitFor();
    assert(await input.evaluate(node => node === document.activeElement), 'canvas name input receives focus');
    await input.fill('新名称');
    await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await modal.count(), 1, 'candidate confirmation does not submit a name');
    await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await modal.count(), 1, 'candidate cancellation does not dismiss the prompt');
    await input.press('Tab'); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.renameResult), null, 'Escape on a button also cancels a rename');
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

    await confirm('Stale');
    await page.evaluate(() => T.openNote('Other.md')); await modal.waitFor({ state: 'detached' });
    assert(!fs.existsSync(path.join(root, 'notes/Stale.md')), 'a replaced document cancels a stale create prompt');
    await confirm('Hidden');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await modal.waitFor({ state: 'detached' });
    assert(!fs.existsSync(path.join(root, 'notes/Hidden.md')), 'pagehide cancels pending prompt actions');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('note modal browser: ok (focus, isolated keyboard, Tab, Escape, IME, create, rename, replacement, document handoff and pagehide)');
    await context.close();
  } finally {
    if (browser) await browser.close(); service.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

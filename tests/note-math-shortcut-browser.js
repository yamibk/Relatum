'use strict';

// Real workspace and native keyboard history; all notes and browser profiles are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-math-shortcut-'));
const root = path.join(output, 'workspace'), notes = path.join(root, 'notes');
fs.mkdirSync(notes, { recursive: true });
for (const name of ['Main.md', 'Fallback.md']) fs.writeFileSync(path.join(notes, name), 'original');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [
  { value: '', anchor: 0, expected: '$$\n\n$$', caret: 3 },
  { value: 'above\n', anchor: 6, expected: 'above\n$$\n\n$$', caret: 9 },
  { value: 'above\n\nbelow', anchor: 6, expected: 'above\n$$\n\n$$\n\nbelow', caret: 9 },
  { value: 'above\n\n\nbelow', anchor: 7, expected: 'above\n\n$$\n\n$$\n\nbelow', caret: 10 },
  { value: 'beforeafter', anchor: 6, expected: 'before\n$$\n\n$$\n\nafter', caret: 10 },
  { value: 'x+y', anchor: 0, head: 3, expected: '$$\nx+y\n$$', caret: 3 },
  { value: 'x+y', anchor: 3, head: 0, expected: '$$\nx+y\n$$', caret: 3 },
  { value: 'x+y\n', anchor: 0, head: 4, expected: '$$\nx+y\n$$', caret: 3 },
  { value: 'x+y\n\n', anchor: 0, head: 5, expected: '$$\nx+y\n\n$$', caret: 3 },
  { value: 'x+y\nrest', anchor: 0, head: 4, expected: '$$\nx+y\n$$\n\nrest', caret: 3 },
];

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, page;
  service.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.on('error', error => { logs += error.message; });
  const errors = [];
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break; await pause(100);
    }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    async function open({ fallback = false, legacy = false } = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const next = await context.newPage(); next.setDefaultTimeout(15000);
      next.on('pageerror', error => errors.push(error.message));
      const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
        '  window.T = {state, flushSave, setViewMode, setNoteSettingsOpen, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
      await next.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      if (fallback) await next.route('**/note-live-editor.js*', route => route.fulfill({ contentType: 'text/javascript',
        body: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') + '\nRelatumNoteLiveEditor.create = () => {throw Error("test fallback");};' }));
      await next.addInitScript(({ fallback, legacy }) => {
        const name = fallback ? 'Fallback.md' : 'Main.md';
        localStorage.setItem('canvas:startWorkspace:v1', 'notes');
        localStorage.setItem('canvas:noteOpenTabs:v1', JSON.stringify([name]));
        localStorage.setItem('canvas:noteActiveTab:v1', name);
        localStorage.setItem('canvas:noteGraphPreload:v1', '0');
        if (legacy) localStorage.setItem('canvas:noteShortcuts:v1', JSON.stringify({ version: 1, commands: { bold: ['Mod-g'], italic: [] } }));
      }, { fallback, legacy });
      await next.goto(url);
      await next.waitForFunction(fallback => window.T?.state.active && !T.state.openingPath
        && T.state.current?.path === (fallback ? 'Fallback.md' : 'Main.md')
        && (fallback ? document.querySelector('[data-role="note-editor-fallback"]:not([hidden])') : T.editor), fallback);
      return next;
    }
    page = await open();
    const value = () => page.evaluate(() => T.editor.snapshot().value);
    async function reset(item, mode = 'source') {
      await page.evaluate(async ({ item, mode }) => {
        await T.editor.whenInputSettled(); await T.setViewMode(mode);
        const view = T.editor.view, CM = RelatumCodeMirror;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: item.value },
          selection: CM.EditorSelection.range(item.anchor, item.head ?? item.anchor),
          annotations: CM.isolateHistory.of('full'), userEvent: 'input.test' });
        T.editor.focus();
      }, { item, mode });
    }
    const menu = page.locator('[data-role="note-context-menu"]');
    for (const mode of ['source', 'live']) for (const method of ['keyboard', 'menu']) for (const item of cases) {
      await reset(item, mode);
      if (method === 'keyboard') await page.keyboard.press('Control+g');
      else {
        await page.keyboard.press('Shift+F10'); await menu.waitFor({ state: 'visible' });
        await menu.locator(':scope > button[data-note-submenu="insert"]').hover();
        await menu.locator('[data-note-command="insert:math"]').click(); await menu.waitFor({ state: 'hidden' });
      }
      const result = await page.evaluate(() => T.editor.snapshot());
      assert.equal(result.value, item.expected, `${mode}/${method}: ${JSON.stringify(item)}`);
      assert.equal(result.anchor, item.caret); assert.equal(result.head, item.caret);
      await page.keyboard.press('Control+z'); assert.equal(await value(), item.value, 'one undo restores the original source');
      await page.keyboard.press('Control+y'); assert.equal(await value(), item.expected, 'one redo restores the complete block');
    }
    await reset({ value: 'above\n', anchor: 6 }, 'live'); await page.keyboard.press('Control+g');
    await page.keyboard.insertText('x^2');
    assert(await page.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(path.join(notes, 'Main.md'), 'utf8'), 'above\n$$\nx^2\n$$', 'saving preserves exact line placement');
    await page.evaluate(() => T.setViewMode('reading'));
    await page.waitForFunction(() => document.querySelector('[data-role="note-reading-view"] .md-math-block mjx-container'));
    assert.equal(await value(), 'above\n$$\nx^2\n$$', 'a math block directly after a paragraph renders without rewriting source');

    await reset({ value: 'compose', anchor: 7 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    assert(await page.evaluate(() => T.editor.inputPending));
    const composing = await page.evaluate(() => T.editor.view.state.doc.toString());
    await page.evaluate(() => T.editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'g', code: 'KeyG', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true })));
    assert.equal(await page.evaluate(() => T.editor.view.state.doc.toString()), composing, 'composition does not insert a math block');
    await cdp.send('Input.insertText', { text: '拼' }); await page.evaluate(() => T.editor.whenInputSettled());
    const readingSource = await value();
    await page.evaluate(() => T.setViewMode('reading')); await page.keyboard.press('Control+g');
    assert.equal(await value(), readingSource, 'reading mode does not change Markdown');
    await page.evaluate(() => T.setViewMode('source'));

    const dialog = page.locator('[data-role="note-settings-dialog"]');
    async function settings() {
      await page.evaluate(() => T.setNoteSettingsOpen(true)); await dialog.waitFor({ state: 'visible' });
      await dialog.locator('nav [data-settings-category="shortcuts"]').click();
    }
    async function closeSettings() { await page.evaluate(() => T.setNoteSettingsOpen(false)); await dialog.waitFor({ state: 'hidden' }); }
    const mathRow = dialog.locator('.note-shortcut-row').filter({ has: page.locator('[data-note-shortcut-command="math"]') });
    await settings();
    assert((await mathRow.innerText()).includes('数学块')); assert((await mathRow.innerText()).includes('Ctrl + G'));
    const beforeSettings = await value();
    await dialog.locator('[data-settings-search]').focus(); await page.keyboard.press('Control+g');
    assert.equal(await value(), beforeSettings, 'settings input does not insert into the hidden editor');
    await mathRow.locator('[data-note-shortcut-action="remove"]').click();
    await closeSettings(); await reset({ value: 'keep', anchor: 4 }); await page.keyboard.press('Control+g');
    assert.equal(await value(), 'keep'); assert.equal(await page.locator('.cm-search').count(), 0, 'removed Ctrl+G is consumed before CodeMirror search');
    await settings(); await mathRow.locator('[data-note-shortcut-action="record"]').click(); await page.keyboard.press('Alt+m');
    assert.deepEqual(await page.evaluate(() => T.state.shortcutBindings.math), ['Alt-m']);
    await closeSettings(); await reset(cases[0]); await page.keyboard.press('Alt+m'); assert.equal(await value(), cases[0].expected);
    await page.evaluate(() => T.flushSave()); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath && T.editor);
    assert.deepEqual(await page.evaluate(() => T.state.shortcutBindings.math), ['Alt-m'], 'custom binding survives reload');
    await reset(cases[0]); await page.keyboard.press('Alt+m'); assert.equal(await value(), cases[0].expected);
    await settings(); await dialog.locator('[data-settings-action="reset-category"]').click();
    await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.deepEqual(await page.evaluate(() => T.state.shortcutBindings.math), ['Mod-g']);
    await page.screenshot({ path: path.join(output, 'math-shortcut-settings.png') });
    await closeSettings(); await reset(cases[1], 'live'); await page.keyboard.press('Control+g');
    assert.equal(await value(), cases[1].expected);
    await page.screenshot({ path: path.join(output, 'math-in-current-line.png') });
    await page.evaluate(() => T.flushSave());

    const legacy = await open({ legacy: true });
    assert.deepEqual(await legacy.evaluate(() => T.state.shortcutBindings.math), []);
    assert.deepEqual(await legacy.evaluate(() => T.state.shortcutBindings.bold), ['Mod-g']);
    assert.deepEqual(await legacy.evaluate(() => T.state.shortcutBindings.italic), []);
    await legacy.context().close();

    const fallback = await open({ fallback: true }), area = fallback.locator('[data-role="note-editor-fallback"]');
    for (const mode of ['source', 'live']) for (const item of cases) {
      await fallback.evaluate(mode => T.setViewMode(mode), mode);
      await area.fill(item.value);
      await area.evaluate((el, item) => el.setSelectionRange(Math.min(item.anchor, item.head ?? item.anchor), Math.max(item.anchor, item.head ?? item.anchor)), item);
      await area.press('Control+g'); assert.equal(await area.inputValue(), item.expected, 'fallback matches the main editor');
      assert.deepEqual(await area.evaluate(el => [el.selectionStart, el.selectionEnd]), [item.caret, item.caret]);
      await area.press('Control+z'); assert.equal(await area.inputValue(), item.value, 'fallback insertion has one native undo step');
      await area.press('Control+y'); assert.equal(await area.inputValue(), item.expected, `fallback redo/${mode}: ${JSON.stringify(item)}`);
    }
    await area.fill('candidate');
    await area.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'g', code: 'KeyG', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true })));
    assert.equal(await area.inputValue(), 'candidate', 'fallback composition preserves text');
    await area.evaluate(el => { el.readOnly = true; }); await area.press('Control+g');
    assert.equal(await area.inputValue(), 'candidate', 'readonly fallback is protected');
    await area.evaluate(el => { el.readOnly = false; });
    assert(await fallback.evaluate(() => T.flushSave()));
    await fallback.context().close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, insertionCases: cases.length * 6, settings: true, legacy: true, history: true, composition: true, errors }));
  } catch (error) {
    console.error(logs.slice(-1500));
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('math shortcut artifacts:', output); throw error;
  } finally { if (browser) await browser.close(); service.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

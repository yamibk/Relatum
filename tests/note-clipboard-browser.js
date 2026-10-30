'use strict';
// Actual system clipboard + offline MathJax, with a disposable Notes workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const fixture = require('./note-clipboard-fixture');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-clipboard-'));
const root = path.join(output, 'workspace'), notes = path.join(root, 'notes');
fs.mkdirSync(notes, { recursive: true });
fs.writeFileSync(path.join(notes, 'Main.md'), '原来的正文');
fs.writeFileSync(path.join(notes, 'Fallback.md'), '备用编辑器');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const errors = [], requests = [];
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break; await wait(100);
    }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    async function open(fallback = false) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
      const next = await context.newPage(); next.setDefaultTimeout(15000);
      next.on('pageerror', error => errors.push(error.message));
      next.on('request', request => requests.push(request.url()));
      const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
        '  window.T = {state, openNote, flushSave, setViewMode, get menuContext(){return bodyMenuContext;}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {')
        .replace('  async function runBodyCommand(name) {', '  async function runBodyCommand(name) { window.__command = name;')
        .replace("    } catch (error) {\n      if (name === 'copy'", "    } catch (error) { window.__clipboardError = error.stack;\n      if (name === 'copy'");
      await next.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      if (fallback) await next.route('**/note-live-editor.js*', route => route.fulfill({ contentType: 'text/javascript',
        body: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') + '\nRelatumNoteLiveEditor.create = () => {throw Error("test fallback");};' }));
      await next.addInitScript(fallback => {
        const name = fallback ? 'Fallback.md' : 'Main.md';
        localStorage.setItem('canvas:startWorkspace:v1', 'notes');
        localStorage.setItem('canvas:noteOpenTabs:v1', JSON.stringify([name]));
        localStorage.setItem('canvas:noteActiveTab:v1', name);
        localStorage.setItem('canvas:noteGraphPreload:v1', '0');
      }, fallback);
      await next.goto(url);
      await next.waitForFunction(fallback => window.T?.state.active && T.state.current?.path === (fallback ? 'Fallback.md' : 'Main.md')
        && (fallback ? document.querySelector('[data-role="note-editor-fallback"]:not([hidden])') : T.editor), fallback);
      return next;
    }
    page = await open();
    const value = () => page.evaluate(() => T.editor.snapshot().value);
    async function set(text, mode = 'source', position = text.length) {
      await page.evaluate(async ({ text, mode, position }) => {
        await T.setViewMode(mode);
        const view = T.editor.view, CM = RelatumCodeMirror;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: CM.EditorSelection.cursor(position),
          annotations: CM.isolateHistory ? CM.isolateHistory.of('full') : [], userEvent: 'input.test' });
        T.editor.focus();
      }, { text, mode, position });
      await page.evaluate(() => T.editor.whenInputSettled());
      await page.waitForTimeout(120);
    }
    async function paste(text, plain = false) {
      await page.evaluate(text => navigator.clipboard.writeText(text), text);
      await page.keyboard.press(plain ? 'Control+Shift+v' : 'Control+v');
    }
    async function menuPaste(text, plain = false) {
      await page.evaluate(text => navigator.clipboard.writeText(text), text);
      await page.keyboard.press('Shift+F10');
      const menu = page.locator('[data-role="note-context-menu"]');
      await menu.waitFor({ state: 'visible' });
      await menu.locator('[data-note-command="' + (plain ? 'paste-plain' : 'paste') + '"]').click();
      await menu.waitFor({ state: 'hidden' });
    }
    await set(''); await paste('普通粘贴'); assert.equal(await value(), '普通粘贴');
    assert(!requests.some(url => url.includes('/vendor/mathjax/')), 'ordinary text does not load MathJax');
    await set(''); await paste(fixture.copied); assert.equal(await value(), fixture.expected);
    await page.keyboard.press('Control+z'); assert.equal(await value(), '', 'one undo removes the complete paste');
    await page.keyboard.press('Control+y'); assert.equal(await value(), fixture.expected);
    assert(await page.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(path.join(notes, 'Main.md'), 'utf8'), fixture.expected);
    await page.evaluate(() => T.setViewMode('reading'));
    await page.waitForFunction(() => document.querySelectorAll('.note-reading-content mjx-container').length === 9);
    assert.equal(await page.locator('.note-reading-content mjx-merror').count(), 0);
    assert.equal(await page.locator('.note-reading-content .mjx-c5F, .note-reading-content .mjx-c2C').count(), 0,
      'underbrace annotations and integral spacing must not become literal underscore/comma glyphs');
    assert(await page.locator('.note-reading-content mjx-munder').count() >= 4);
    await page.screenshot({ path: path.join(output, 'reading-light.png') });
    await page.evaluate(async () => { await T.setViewMode('live'); document.body.dataset.startTheme = 'dark'; T.editor.focus(); });
    await page.waitForFunction(() => document.querySelectorAll('[data-role="note-editor"] mjx-container').length >= 9);
    await page.screenshot({ path: path.join(output, 'live-dark.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'light'; });
    await page.reload(); await page.waitForFunction(() => window.T?.editor && T.state.current?.path === 'Main.md');
    assert.equal(await value(), fixture.expected, 'saved standard Markdown survives reopening');
    await set(''); await menuPaste(fixture.copied); assert.equal(await value(), fixture.expected);
    await page.keyboard.press('Control+z'); assert.equal(await value(), '', 'menu paste is one undo');
    for (const menu of [false, true]) {
      await set('');
      if (menu) await menuPaste(fixture.copied, true); else await paste(fixture.copied, true);
      assert.equal(await value(), fixture.copied, 'plain paste retains all original bytes');
    }
    const literal = '```tex\nplace\n```', at = literal.indexOf('place');
    for (const menu of [false, true]) {
      await set(literal, 'source', at);
      if (menu) await menuPaste(fixture.copied); else await paste(fixture.copied);
      assert.equal(await value(), literal.slice(0, at) + fixture.copied + literal.slice(at), 'code destination stays literal');
    }
    const mixed = 'prose\n\n```tex\ncode\n```', inline = String.raw`\\(x\\)`;
    for (const prefix of ['', '> ']) for (const menu of [false, true]) {
      const code = prefix + '```md\n' + prefix + '> ```\n' + prefix + inline + '\n' + prefix + '```';
      const payload = code + '\n\n' + inline, expected = code + '\n\n' + String.raw`\(x\)`;
      await set('');
      if (menu) await menuPaste(payload); else await paste(payload);
      assert.equal(await value(), expected, 'a quoted fence example never rewrites literal code or masks following math');
      await page.keyboard.press('Control+z'); assert.equal(await value(), '', 'the protected paste is still one undo');
    }
    for (const menu of [false, true]) {
      await set(mixed);
      await page.evaluate(() => {
        const view = T.editor.view, CM = RelatumCodeMirror;
        view.dispatch({ selection: CM.EditorSelection.create([CM.EditorSelection.cursor(5), CM.EditorSelection.cursor(view.state.doc.toString().indexOf('code') + 4)]) });
      });
      if (menu) await menuPaste(inline); else await paste(inline);
      assert.equal(await value(), 'prose' + String.raw`\(x\)` + '\n\n```tex\ncode' + inline + '\n```', 'each cursor respects its own literal context');
    }
    await set('');
    await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob(['https://example.test/page'], { type: 'text/plain' }),
      'text/html': new Blob(['<a href="https://example.test/page">网页标题</a>'], { type: 'text/html' }),
    })]));
    await page.keyboard.press('Control+v'); assert.equal(await value(), '[网页标题](https://example.test/page)');

    const copiedInline = String.raw`\\(q=Cu_C\\)`, expectedInline = String.raw`\(q=Cu_C\)`;
    async function cell() {
      await set('| old | other |\n| --- | --- |\n| next | last |', 'live', 0);
      await page.locator('td[data-table-row="0"][data-table-col="0"]').click();
      const input = page.locator('.note-table-cell-editor');
      await input.evaluate(node => node.__noteCellInput.setSelectionRange(0, node.__noteCellInput.value.length));
      return input;
    }
    let input = await cell(); await paste(copiedInline);
    assert.equal(await input.evaluate(node => node.__noteCellInput.value), expectedInline);
    await page.keyboard.press('Control+z'); assert((await value()).includes('| old |'), 'cell paste uses parent history');
    input = await cell(); await paste(copiedInline, true);
    assert.equal(await input.evaluate(node => node.__noteCellInput.value), copiedInline);
    input = await cell(); await paste(copiedInline + '\t' + copiedInline);
    assert(!(await value()).includes(copiedInline) && (await value()).includes(expectedInline), 'TSV cells normalize math');
    input = await cell();
    await input.evaluate(node => { node.__noteCellInput.value = '`literal`'; node.__noteCellInput.setSelectionRange(1, 1); });
    await paste(copiedInline); assert((await input.evaluate(node => node.__noteCellInput.value)).includes(copiedInline));

    const fallback = await open(true), area = fallback.locator('[data-role="note-editor-fallback"]');
    await area.focus(); await area.press('Control+a');
    await fallback.evaluate(text => navigator.clipboard.writeText(text), fixture.copied);
    await area.press('Control+v'); assert.equal(await area.inputValue(), fixture.expected);
    await area.press('Control+z'); assert.equal(await area.inputValue(), '备用编辑器', 'fallback paste has native undo');
    await area.press('Control+y'); assert.equal(await area.inputValue(), fixture.expected);
    assert(await fallback.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(path.join(notes, 'Fallback.md'), 'utf8'), fixture.expected);
    await area.press('Control+a'); await area.press('Control+Shift+v'); assert.equal(await area.inputValue(), fixture.copied);
    await fallback.context().close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ output, source: true, live: true, reading: true, clipboard: true, plain: true,
      table: true, fallback: true, history: true, saved: true, errors }));
  } catch (error) {
    console.error('clipboard output:', output, logs);
    console.error(await page?.evaluate(() => ({ errors: [], busy: document.querySelector('[data-role="note-context-menu"]')?.getAttribute('aria-busy'),
      command: window.__command, clipboardError: window.__clipboardError, pending: T.editor?.inputPending, menuValid: T.menuContext && T.editor?.queryCommand('paste', T.menuContext),
      toasts: [...document.querySelectorAll('.toast')].map(node => node.textContent) })).catch(() => null), errors);
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    if (service.pid && service.exitCode === null && service.signalCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve)); service.kill(); await exited;
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

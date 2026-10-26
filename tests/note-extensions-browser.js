'use strict';
// One targeted production-shell session; all notes, profiles and images are disposable.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-extensions-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const data = path.join(output, 'isolated'); fs.mkdirSync(path.join(data, 'notes'), { recursive: true });
  const filename = path.join(data, 'notes/Main.md'); fs.writeFileSync(filename, '# Extensions\n\nPlain text.\n');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify(profile)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, context, page;
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  try {
    const url = 'http://127.0.0.1:' + port; let ready = false;
    for (let i = 0; i < 120; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, setViewMode, setNoteSettingsOpen, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
      localStorage.setItem('canvas:noteActivePath:v1', 'Main.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.editor && !T.state.openingPath);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const doc = () => page.evaluate(() => T.editor.view.state.doc.toString());
    const reset = async (value, at = value.length) => {
      await page.evaluate(async ({ value, at }) => {
        await T.editor.whenInputSettled(); T.state.current.content = value;
        T.editor.setDocument({ value, notePath: 'Main.md', anchor: at, head: at }); T.editor.focus();
      }, { value, at }); await settle();
    };
    const set = async patch => { await page.evaluate(patch => RelatumNoteExtensions.set('latex-input', patch), patch); await settle(); };
    const type = async text => { await page.keyboard.type(text); await settle(); };
    const dialog = page.locator('[data-role="note-settings-dialog"]');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' })); await dialog.waitFor();
    assert.deepEqual(await dialog.locator('nav button').evaluateAll(items => items.slice(-3).map(item => item.dataset.settingsCategory)), ['system', 'notebooks', 'extensions']);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), null);
    assert(!requests.some(url => url.endsWith('/note-extensions/latex-input.js')), 'disabled extension stays unloaded, even in settings');
    const toggle = dialog.locator('[data-extension-enabled="latex-input"]');
    assert.equal(await dialog.locator('.note-extension-card table').count(), 0, 'details are lazy');
    await dialog.locator('[data-settings-search]').fill('自动展开');
    await dialog.locator('.relatum-settings-result').first().click();
    assert.equal(await dialog.locator('.note-extension-card table tr').count(), 16);
    assert(await dialog.locator('.note-extension-card details').evaluate(element => element.open), 'search prepares settings and opens details');
    assert(!requests.some(url => url.endsWith('/note-extensions/latex-input.js')), 'search only prepares metadata');
    await page.evaluate(() => { window.originalView = T.editor.view; window.originalDoc = T.editor.view.state.doc; });
    // Failed and delayed loads must never replace the editor or attach after disable.
    await page.route('**/note-extensions/latex-input.js', route => route.abort());
    await toggle.check(); await dialog.locator('.note-extension-status').waitFor();
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc));
    await page.unroute('**/note-extensions/latex-input.js');
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/note-extensions/latex-input.js', async route => { await delayed; await route.continue(); });
    await dialog.locator('[data-extension-retry="latex-input"]').click();
    const loaded = page.waitForResponse(response => response.url().endsWith('/note-extensions/latex-input.js'));
    await toggle.uncheck(); release(); await loaded;
    await settle(); await page.unroute('**/note-extensions/latex-input.js');
    await page.evaluate(() => T.setNoteSettingsOpen(false)); await dialog.waitFor({ state: 'hidden' });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ sq $');
    await set({ enabled: true });
    for (const [trigger, result] of [['sq', '\\sqrt{}'], ['//', '\\frac{}{}'], ['sum', '\\sum_{}^{}'], ['int', '\\int_{}^{}'],
      ['xsr', 'x^{2}'], ['xcb', 'x^{3}'], ['xinvs', 'x^{-1}'], ['@a', '\\alpha'], ['@b', '\\beta'], ['@g', '\\gamma'],
      ['@d', '\\delta'], ['@t', '\\theta'], ['@l', '\\lambda'], ['@p', '\\pi'], ['@s', '\\sigma'], ['@o', '\\omega']]) {
      await reset('$  $', 2); await type(trigger); assert.equal(await doc(), '$ ' + result + ' $', trigger);
    }
    await page.keyboard.press('Control+z'); await settle(); assert.equal(await doc(), '$ @o $', 'Undo restores the literal trigger');
    await page.keyboard.press('Control+y'); await settle(); assert.equal(await doc(), '$ \\omega $', 'Redo does not expand twice');
    await reset('$  $', 2); await type('//'); await type('sq'); await type('x');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await type('y');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => T.editor.view.state.sliceDoc(T.editor.view.state.selection.main.from, T.editor.view.state.selection.main.to)), '\\sqrt{x}');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await doc(), '$ \\frac{\\sqrt{x}}{y} $', 'nested sessions return to their outer placeholder');
    await reset('$  $', 2); await type('sq'); await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
    assert((await doc()).includes('\t'), 'Escape releases snippet Tab handling');
    for (const [value, at, result] of [['\\(  \\)', 3, '\\( \\alpha \\)'], ['\\[  \\]', 3, '\\[ \\alpha \\]'],
      ['$$\n\n$$', 3, '$$\n\\alpha\n$$'], ['> [!note]\n> $$\n> \n> $$', 16, '> [!note]\n> $$\n> \\alpha\n> $$']]) {
      const position = value.includes('> $$') ? value.indexOf('\n> \n') + 3 : at;
      await reset(value, position); await type('@a'); assert.equal(await doc(), result, 'formula delimiters and Callout');
    }
    // Formula source mode uses the same protection and snippet engine.
    await page.evaluate(() => T.setViewMode('source')); await reset('$$\n\n$$', 3); await type('sq'); assert.equal(await doc(), '$$\n\\sqrt{}\n$$');
    for (const [value, at, trigger] of [['plain ', 6, 'sq'], ['`$  $`', 3, 'sq'], ['```tex\n$  $\n```', 9, 'sq'],
      ['<!-- $  $ -->', 7, 'sq'], ['$ \\text{} $', 8, 'sq'], ['$ \\operatorname{} $', 16, 'sq'], ['$ %  $', 4, 'sq'],
      ['$ \\textcolor{red}{} $', 18, 'sq'],
      ['$ \\ $', 3, '@a'], ['$ as $', 4, 'q']]) {
      await reset(value, at); await type(trigger); assert.equal(await doc(), value.slice(0, at) + trigger + value.slice(at), 'protected source ' + value);
    }
    await reset('$  $', 2);
    await page.evaluate(() => T.editor.view.dispatch({ changes: { from: 2, insert: 'sq' }, selection: { anchor: 4 }, userEvent: 'input.paste' }));
    await settle(); assert.equal(await doc(), '$ sq $', 'paste does not expand');
    await set({ options: { automatic: false } }); await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ sq $');
    await page.keyboard.press('Tab'); assert.equal(await doc(), '$ \\sqrt{} $', 'manual expansion');
    await reset('- one\n- two', 11); await page.keyboard.press('Tab'); assert((await doc()).startsWith('- one\n  - two'), 'list indentation still owns ordinary Tab');
    await reset('$  $\n$  $', 2);
    await page.evaluate(() => T.editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.create([RelatumCodeMirror.EditorSelection.cursor(2), RelatumCodeMirror.EditorSelection.cursor(7)]) }));
    await type('sq'); assert.equal(await doc(), '$ sq $\n$ sq $', 'multi-cursor input remains literal');
    await set({ options: { automatic: true } }); await reset('$  $', 2);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'sq', selectionStart: 2, selectionEnd: 2 });
    assert(await page.evaluate(() => T.editor.inputPending));
    // Configuration changes are held until composition and its quiet handoff finish.
    await page.evaluate(() => { RelatumNoteExtensions.set('latex-input', { enabled: false }); RelatumNoteExtensions.set('latex-input', { enabled: true, options: { automatic: false } }); });
    await cdp.send('Input.insertText', { text: 'sq' });
    await page.waitForFunction(() => !T.editor.inputPending); await settle(); assert.equal(await doc(), '$ sq $', 'IME commit remains literal');
    await page.keyboard.press('Tab'); assert.equal(await doc(), '$ \\sqrt{} $', 'last deferred option wins');
    await set({ enabled: false });
    await page.evaluate(() => { window.beforeToggle = { view: T.editor.view, doc: T.editor.view.state.doc, selection: T.editor.view.state.selection, top: T.editor.view.scrollDOM.scrollTop }; });
    await set({ enabled: true }); await set({ enabled: false });
    assert(await page.evaluate(() => beforeToggle.view === T.editor.view && beforeToggle.doc === T.editor.view.state.doc
      && beforeToggle.selection.eq(T.editor.view.state.selection) && beforeToggle.top === T.editor.view.scrollDOM.scrollTop), 'toggle preserves editor state');
    await set({ enabled: true, options: { automatic: true } });
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ sq $', 'minimized editor is detached');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }); await settle();
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ \\sqrt{} $', 'restore reattaches once');
    await reset('$  $', 2);
    await page.evaluate(() => {
      T.editor.view.dispatch({ changes: { from: 2, insert: 'sq' }, selection: { anchor: 4 }, userEvent: 'input.type' });
      window.dispatchEvent(new Event('pagehide'));
    });
    await settle(); assert.equal(await doc(), '$ sq $', 'pagehide cancels a queued expansion');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow'))); await settle();
    await page.evaluate(() => T.setViewMode('reading')); await settle();
    await page.evaluate(() => T.setViewMode('live')); await settle();
    await reset('$  $', 2); await type('@t'); assert.equal(await doc(), '$ \\theta $');
    assert(await page.evaluate(() => T.flushSave())); assert.equal(fs.readFileSync(filename, 'utf8'), '$ \\theta $', 'normal save contains only LaTeX');
    await page.reload(); await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.editor);
    assert.deepEqual(await page.evaluate(() => RelatumNoteExtensions.read('latex-input')), { enabled: true, options: { automatic: true } });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ \\sqrt{} $', 'reload restores activation');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' })); await dialog.waitFor();
    await dialog.locator('.note-extension-card summary').click();
    await page.screenshot({ path: path.join(output, 'extensions-light.png') });
    await page.setViewportSize({ width: 600, height: 860 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await settle(); await page.screenshot({ path: path.join(output, 'extensions-dark-narrow.png') });
    assert.equal(await dialog.locator('[data-settings-title]').textContent(), 'Extensions');
    assert(await dialog.locator('nav [data-settings-category="extensions"]').isVisible());
    await dialog.locator('[data-settings-action="reset-category"]').click();
    await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), null);
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(errors, [], 'no browser exceptions');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, scenarios: ['lazy loading and failure', 'stale load', '16 snippets', 'undo/redo', 'nested tabstops', 'boundaries', 'source mode', 'IME handoff', 'multi-cursor', 'lifecycle', 'save/reload', 'settings and reset'] }, null, 2));
    console.log('PASS note extensions; artifacts: ' + output);
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ editor: !!window.T?.editor, text: window.T?.editor?.view.state.doc.toString(), error: document.body.innerText.slice(-500) })).catch(() => ({}))); }
    console.error('Artifacts: ' + output); throw error;
  } finally {
    await context?.close(); await browser?.close(); server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

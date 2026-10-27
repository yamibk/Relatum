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
    await page.evaluate(() => { window.beforePanel = { view: T.editor.view, doc: T.editor.view.state.doc, top: T.editor.view.scrollDOM.scrollTop }; });
    assert.deepEqual(await dialog.locator('nav button').evaluateAll(items => items.slice(-3).map(item => item.dataset.settingsCategory)), ['system', 'notebooks', 'extensions']);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), null);
    assert(!requests.some(url => url.endsWith('/note-extensions/latex-input.js')), 'disabled extension stays unloaded, even in settings');
    const toggle = dialog.locator('[data-extension-enabled="latex-input"]:visible');
    const tab = id => dialog.locator('[data-latex-tab="' + id + '"]');
    const configure = () => dialog.locator('[data-extension-configure="latex-input"]').click();
    const chooseSnippet = async id => {
      await tab('snippets').click(); await dialog.locator('[data-latex-group="all"]').click();
      await dialog.locator('[data-latex-search]').fill(''); await dialog.locator('[data-latex-snippet="' + id + '"]').click();
    };
    assert.equal(await dialog.locator('.note-latex-settings').count(), 0, 'details are lazy');
    await dialog.locator('[data-settings-search]').fill('自动展开');
    assert.equal(await dialog.locator('.note-latex-settings').count(), 0, 'search index is metadata only');
    await dialog.locator('.relatum-settings-result').first().click();
    assert.equal(await dialog.locator('.note-latex-settings').getAttribute('data-tab'), 'basic');
    assert.equal(await dialog.locator('[data-extension-option="automatic"]').evaluate(element => element === document.activeElement), true, 'global search focuses the actual option');
    assert.equal(await dialog.locator('.note-extension-detail-head h3 > span').first().textContent(), 'latex辅助输入');
    assert.equal(await dialog.locator('.note-extension-settings').getAttribute('data-detail'), 'latex-input');
    assert(!requests.some(url => url.endsWith('/note-extensions/latex-input.js')), 'search only prepares metadata');
    await dialog.locator('[data-settings-search]').fill('sq'); await dialog.locator('.relatum-settings-result').first().click();
    assert.equal(await dialog.locator('.note-latex-settings').getAttribute('data-tab'), 'snippets');
    assert.equal(await dialog.locator('[data-latex-field="trigger"]').inputValue(), 'sq', 'global search reveals the snippet editor');
    assert.equal(await dialog.locator('[data-latex-snippet]').count(), await page.evaluate(() => RelatumNoteExtensions.list()[0].snippets.length));
    assert(await dialog.locator('.relatum-settings-scroll').evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'no outer scrolling around the detail workspace');
    await dialog.locator('[data-latex-search]').fill('rho'); assert.equal(await dialog.locator('[data-latex-snippet]').count(), 1, 'local search filters by trigger and replacement');
    await dialog.locator('[data-latex-search]').fill('');
    const configChecks = await page.evaluate(() => {
      const definition = RelatumNoteExtensions.list()[0], item = (id, trigger, replacement = '\\test{$1}$0') => ({ id, trigger, replacement, boundary: 'start', enabled: true });
      const many = Array.from({ length: 129 }, (_, index) => item('custom-' + index, 'zz' + index));
      const valid = definition.normalizeOptions({ automatic: false, custom: many });
      const invalid = definition.normalizeOptions({ custom: [item('custom-long', 'a'.repeat(65)), item('custom-template', 'aaa', 'a'.repeat(4097)),
        item('custom-placeholder', 'bbb', '$10'), item('custom-duplicate', 'sq'), item('custom-valid', 'c'.repeat(64))] });
      const copy = RelatumNoteExtensions.read('latex-input'); copy.options.custom.push(item('custom-mutated', 'mmm'));
      const collisions = definition.effectiveSnippets({ overrides: [item('sq', 'sum'), item('sum', 'sum')] });
      return { count: valid.custom.length, defaultFraction: valid.autoFraction, automatic: valid.automatic,
        invalid: invalid.custom.map(item => item.id), independent: RelatumNoteExtensions.read('latex-input').options.custom.length === 0,
        repeated: definition.snippetProblem(item('custom-repeat', 'rrr', '$1$1')), unique: new Set(collisions.map(item => item.trigger)).size === collisions.length };
    });
    assert.deepEqual(configChecks, { count: 128, defaultFraction: true, automatic: false, invalid: ['custom-valid'], independent: true, repeated: 'placeholder', unique: true });
    const field = key => dialog.locator('[data-latex-field="' + key + '"]');
    const action = key => dialog.locator('[data-latex-action="' + key + '"]');
    await action('add').click(); await field('trigger').fill('qq'); await field('replacement').fill('\\mathbb{$1}$0'); await action('save').click();
    const customId = await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom[0].id);
    const customRow = () => dialog.locator('[data-latex-snippet="' + customId + '"]');
    await customRow().click();
    await dialog.locator('[data-latex-enabled]').uncheck(); assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom[0].enabled), false);
    await dialog.locator('[data-latex-enabled]').check();
    await field('trigger').fill('sq'); await action('save').click();
    assert((await dialog.locator('.note-latex-form [role="alert"]').textContent()).includes('已被')); assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom[0].trigger), 'qq');
    await field('trigger').fill('qq'); await field('replacement').fill('$10'); await action('save').click();
    assert((await dialog.locator('.note-latex-form [role="alert"]').textContent()).includes('占位')); await action('cancel').click();
    await chooseSnippet('sq');
    await field('replacement').fill('\\sqrt[4]{$1}$0'); await chooseSnippet('//'); await chooseSnippet('sq');
    assert.equal(await field('replacement').inputValue(), '\\sqrt[4]{$1}$0', 'switching snippets preserves unsaved drafts');
    await tab('basic').click(); await tab('snippets').click(); assert.equal(await field('replacement').inputValue(), '\\sqrt[4]{$1}$0', 'tab switching preserves the draft');
    await dialog.locator('[data-extension-action="back"]').click(); await configure(); await tab('snippets').click();
    assert.equal(await field('replacement').inputValue(), '\\sqrt[4]{$1}$0', 'returning to overview preserves this session draft');
    await field('replacement').fill('\\sqrt[3]{$1}$0'); await action('save').click();
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.overrides[0].replacement), '\\sqrt[3]{$1}$0');
    await action('restore').click();
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.overrides.length), 0);
    assert(await page.evaluate(() => beforePanel.view === T.editor.view && beforePanel.doc === T.editor.view.state.doc && beforePanel.top === T.editor.view.scrollDOM.scrollTop), 'panel operations preserve editor identity, document and scroll');
    await field('replacement').fill('\\sqrt[5]{$1}$0');
    await page.evaluate(() => T.setNoteSettingsOpen(false)); await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' })); await dialog.waitFor();
    await configure(); await tab('snippets').click();
    assert.equal(await field('replacement').inputValue(), '\\sqrt{$1}$0', 'closing settings discards unsaved drafts');
    assert(!requests.some(url => url.endsWith('/note-extensions/latex-input.js')), 'editing snippet settings does not load runtime');
    await page.evaluate(() => { window.originalView = T.editor.view; window.originalDoc = T.editor.view.state.doc; });
    // Failed and delayed loads must never replace the editor or attach after disable.
    await page.route('**/note-extensions/latex-input.js', route => route.abort());
    await toggle.check(); await dialog.locator('.note-extension-status:visible').waitFor();
    assert(await page.evaluate(() => T.editor.view === originalView && T.editor.view.state.doc === originalDoc));
    await page.unroute('**/note-extensions/latex-input.js');
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/note-extensions/latex-input.js', async route => { await delayed; await route.continue(); });
    await dialog.locator('[data-extension-retry="latex-input"]:visible').click();
    const loaded = page.waitForResponse(response => response.url().endsWith('/note-extensions/latex-input.js'));
    await toggle.uncheck(); release(); await loaded;
    await settle(); await page.unroute('**/note-extensions/latex-input.js');
    await page.evaluate(() => T.setNoteSettingsOpen(false)); await dialog.waitFor({ state: 'hidden' });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ sq $');
    await set({ enabled: true });
    await reset('$  $', 2); await type('qq'); await type('R'); assert.equal(await doc(), '$ \\mathbb{R} $', 'custom template uses normal placeholders');
    await set({ options: { custom: [] } });
    await set({ options: { overrides: [{ id: 'sq', trigger: 'sq', replacement: '\\sqrt{$1}$0', boundary: 'start', enabled: false }] } });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ sq $', 'disabled built-in remains literal');
    await set({ options: { overrides: [] } });
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
    await set({ options: { tabout: false } });
    await reset('$  $', 2); await type('sq'); await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
    assert((await doc()).includes('\t'), 'Escape releases snippet Tab handling');
    await set({ options: { tabout: true } });
    for (const [trigger, result] of [['@asr', '\\alpha^{2}'], ['@ax', '\\alpha x'], ['@a@b', '\\alpha\\beta'],
      ['@a1', '\\alpha_{1}'], ['x12', 'x_{12}'], ['xvec', '\\vec{x}'], ['@ahat', '\\hat{\\alpha}'],
      ['rd', 'rd'], ['xrd', 'x^{}'], ['x_', 'x_{}'], ['sin', '\\sin'], ['@G', '\\Gamma'], ['phi', '\\phi'],
      ['\\customsr', '\\customsr'], ['\\alphax', '\\alphax']]) {
      await reset('$  $', 2); await type(trigger); assert.equal(await doc(), '$ ' + result + ' $', trigger);
    }
    await set({ options: { automatic: false } });
    await reset('$  $', 2); await type('//'); await page.keyboard.press('Tab'); await type('sq'); await page.keyboard.press('Tab');
    assert.equal(await doc(), '$ \\frac{\\sqrt{}}{} $', 'manual nested expansion precedes placeholder navigation');
    await type('x'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await type('y');
    assert.equal(await doc(), '$ \\frac{\\sqrt{x}}{y} $');
    await set({ options: { automatic: true } });
    for (const [input, result] of [['x/', '\\frac{x}{}'], ['(a+b)/', '\\frac{a+b}{}'], ['(a+b(c+d))/', '\\frac{a+b(c+d)}{}'],
      ['a+x/', 'a+\\frac{x}{}'], ['x^{2}/', '\\frac{x^{2}}{}'], ['x^2/', '\\frac{x^2}{}'], ['\\alpha/', '\\frac{\\alpha}{}'],
      ['\\sin(x)/', '\\frac{\\sin(x)}{}'], ['\\frac{a}{b}/', '\\frac{\\frac{a}{b}}{}'], ['x_{1}^{2}/', '\\frac{x_{1}^{2}}{}'],
      ['a&x/', 'a&\\frac{x}{}']]) {
      await reset('$  $', 2);
      // Literal source setup avoids the independent numeric-subscript input rule.
      const prefix = input.slice(0, -1); await reset('$ ' + prefix + ' $', 2 + prefix.length); await type('/');
      assert.equal(await doc(), '$ ' + result + ' $', 'fraction ' + input);
      await page.keyboard.press('Control+z'); await settle(); assert.equal(await doc(), '$ ' + input + ' $', 'fraction undo');
      await page.keyboard.press('Control+y'); await settle(); assert.equal(await doc(), '$ ' + result + ' $', 'fraction redo');
    }
    await set({ options: { automatic: false } }); await reset('$ x $', 3); await type('/'); assert.equal(await doc(), '$ x/ $');
    await page.keyboard.press('Tab'); assert.equal(await doc(), '$ \\frac{x}{} $');
    await set({ options: { automatic: true, autoFraction: false } }); await reset('$ x $', 3); await type('/'); assert.equal(await doc(), '$ x/ $');
    await set({ options: { autoFraction: true } });
    for (const [value, at, target] of [['$ (x) $', 4, 5], ['$ \\left(x\\right) $', 8, 16], ['$ x $', 4, 5], ['\\(x\\)', 3, 5]]) {
      await reset(value, at); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), target, 'tabout ' + value);
      assert.equal(await doc(), value, 'tabout does not write source');
    }
    for (const environment of ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'array', 'cases', 'align', 'aligned', 'gather']) {
      const value = '$$\n\\begin{' + environment + '}\na\n\\end{' + environment + '}\n$$', at = value.indexOf('\na\n') + 2;
      await reset(value, at); await page.keyboard.press('Tab'); await type('b'); await page.keyboard.press('Enter'); await type('c');
      assert((await doc()).includes('\na&b\\\\\nc\n'), 'matrix keys ' + environment);
      await page.keyboard.press('Shift+Enter');
      assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), (await doc()).indexOf('\\end{') + ('\\end{' + environment + '}').length);
    }
    const quotedMatrix = '> [!note]\n> $$\n> \\begin{matrix}\n> a\n> \\end{matrix}\n> $$';
    await reset(quotedMatrix, quotedMatrix.indexOf('> a') + 3); await page.keyboard.press('Enter'); await type('b');
    assert((await doc()).includes('> a\\\\\n> b\n'), 'matrix preserves Callout prefixes');
    const nestedMatrix = '$$\n\\begin{matrix}\n(x)\n\\end{matrix}\n$$';
    await reset(nestedMatrix, nestedMatrix.indexOf('(x)') + 2); await page.keyboard.press('Tab');
    assert.equal(await doc(), nestedMatrix, 'bracket navigation wins inside matrix parameters');
    await set({ options: { matrix: false } }); await reset(nestedMatrix, nestedMatrix.indexOf('(x)') + 3); await page.keyboard.press('Tab');
    assert.notEqual(await doc(), nestedMatrix, 'matrix switch releases Tab to ordinary indentation');
    assert(!(await doc()).includes('&')); await set({ options: { matrix: true } });
    const environments = '$$\n\\begin{matrix}\n\\begin{cases}\nx\n\\end{cases}\n\\end{matrix}\n$$';
    await reset(environments, environments.indexOf('\nx\n') + 2); await page.keyboard.press('Shift+Enter');
    assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), environments.indexOf('\\end{cases}') + 11, 'nested matrix exits the innermost environment');
    await page.keyboard.press('Tab'); assert((await doc()).includes('\\end{cases}&'), 'outer environment resumes after inner exit');
    await set({ options: { tabout: false, subscripts: false } });
    await reset('$ x $', 3); await type('1'); assert.equal(await doc(), '$ x1 $', 'numeric subscript has its own switch');
    await reset('$ (x) $', 4); await page.keyboard.press('Tab'); assert.notEqual(await doc(), '$ (x) $', 'tabout switch releases original input');
    await set({ options: { tabout: true, subscripts: true } });
    for (const [value, at, result] of [['\\(  \\)', 3, '\\( \\alpha \\)'], ['\\[  \\]', 3, '\\[ \\alpha \\]'],
      ['$$\n\n$$', 3, '$$\n\\alpha\n$$'], ['> [!note]\n> $$\n> \n> $$', 16, '> [!note]\n> $$\n> \\alpha\n> $$']]) {
      const position = value.includes('> $$') ? value.indexOf('\n> \n') + 3 : at;
      await reset(value, position); await type('@a'); assert.equal(await doc(), result, 'formula delimiters and Callout');
    }
    // Formula source mode uses the same protection and snippet engine.
    await page.evaluate(() => T.setViewMode('source')); await reset('$$\n\n$$', 3); await type('sq'); assert.equal(await doc(), '$$\n\\sqrt{}\n$$');
    for (const [value, at, trigger] of [['plain ', 6, 'sq'], ['`$  $`', 3, 'sq'], ['```tex\n$  $\n```', 9, 'sq'],
      ['<!-- $  $ -->', 7, 'sq'], ['$ \\text{} $', 8, 'sq'], ['$ \\operatorname{} $', 16, 'sq'], ['$ %  $', 4, 'sq'],
      ['$ \\textcolor{red}{} $', 18, 'sq'], ['$ \\begin{} $', 9, 'int'], ['$ \\end{} $', 7, 'sum'],
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
    assert.deepEqual(await page.evaluate(() => RelatumNoteExtensions.read('latex-input')), { enabled: true,
      options: { automatic: true, autoFraction: true, tabout: true, matrix: true, subscripts: true, overrides: [], custom: [] } });
    await reset('$  $', 2); await type('sq'); assert.equal(await doc(), '$ \\sqrt{} $', 'reload restores activation');
    const legacyPreference = JSON.stringify({ version: 1, extensions: { 'latex-input': { enabled: true, options: { automatic: false } },
      'future-extension': { enabled: true, options: { keep: 'unchanged' } } } });
    await page.evaluate(value => localStorage.setItem('canvas:noteExtensions:v1', value), legacyPreference);
    await page.reload(); await page.waitForFunction(() => window.T?.editor && T.state.current?.path === 'Main.md');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.automatic), false, 'legacy manual preference survives upgrade');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.autoFraction), true, 'new capability defaults on');
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), legacyPreference, 'upgrade does not write defaults');
    await set({ options: { automatic: true } });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteExtensions:v1')).extensions['future-extension']),
      { enabled: true, options: { keep: 'unchanged' } }, 'unknown extension is preserved');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' })); await dialog.waitFor();
    await configure(); await tab('snippets').click();
    await action('add').click(); await field('trigger').fill('z'.repeat(64)); await field('replacement').fill('\\boldsymbol{$1}$0'); await action('save').click();
    await page.evaluate(() => T.setNoteSettingsOpen(false)); await dialog.waitFor({ state: 'hidden' });
    await reset('$  $', 2); await type('z'.repeat(64)); assert.equal(await doc(), '$ \\boldsymbol{} $', 'longest configured trigger is supported');
    await page.reload(); await page.waitForFunction(() => window.T?.editor && T.state.current?.path === 'Main.md');
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom[0].trigger.length), 64, 'custom snippet survives reload');
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' })); await dialog.waitFor();
    await configure(); await chooseSnippet(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom[0].id));
    await dialog.locator('[data-latex-action="delete"]').click(); assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('latex-input').options.custom.length), 0);
    await dialog.locator('[data-extension-action="back"]').click();
    await page.screenshot({ path: path.join(output, 'extensions-overview.png') });
    await configure(); await tab('snippets').click();
    await page.screenshot({ path: path.join(output, 'extensions-split.png') });
    await action('add').click(); await field('trigger').fill('demo'); await field('replacement').fill('\\mathbb{$1}$0');
    await page.screenshot({ path: path.join(output, 'extensions-light.png') });
    await page.setViewportSize({ width: 600, height: 860 });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage('en'); });
    await settle(); await page.screenshot({ path: path.join(output, 'extensions-dark-narrow.png') });
    assert.equal(await dialog.locator('[data-settings-title]').textContent(), 'Extensions');
    assert.equal(await dialog.locator('.note-extension-detail-head h3 > span').first().textContent(), 'LaTeX Input Assistant');
    assert(await action('list').isVisible());
    assert.equal(await dialog.locator('.note-latex-library').isVisible(), false, 'narrow editor replaces the list');
    assert(await dialog.locator('.note-latex-editor-footer').isVisible());
    assert(await dialog.locator('.note-extension-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'narrow detail has no horizontal overflow');
    await action('list').click(); assert(await dialog.locator('.note-latex-library').isVisible(), 'narrow back restores list');
    await tab('basic').click();
    await page.screenshot({ path: path.join(output, 'extensions-basics-dark.png') });
    await tab('guide').click(); await page.screenshot({ path: path.join(output, 'extensions-guide-dark.png') });
    await page.setViewportSize({ width: 400, height: 720 }); await tab('snippets').click(); await action('add').click();
    assert(await dialog.locator('.note-extension-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'small window has no horizontal overflow');
    assert(await action('save').isVisible(), 'small window keeps editor actions available');
    assert(await dialog.locator('nav [data-settings-category="extensions"]').isVisible());
    await dialog.locator('[data-settings-action="reset-category"]').click();
    await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteExtensions:v1')), null);
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(errors, [], 'no browser exceptions');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, scenarios: ['overview and detail navigation', 'metadata search and control focus', 'snippet search and split layout', 'session drafts and close cleanup', 'editor identity, document and scroll preserved', 'narrow layout and actions', 'lazy loading and failure', 'stale load', 'original and added snippets', 'continuous commands', 'manual and automatic nesting', 'fractions and history', 'tabout', 'matrix and Callout', 'custom snippet forms, limits and reload', 'boundaries', 'source mode', 'IME handoff', 'multi-cursor', 'lifecycle', 'save/reload', 'bilingual settings and reset'] }, null, 2));
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

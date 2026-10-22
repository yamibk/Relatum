'use strict';

// Real offline MathJax + CodeMirror, synthetic Markdown and disposable output.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const net = require('node:net'), { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-math-preview-'));
const equation = String.raw`$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0\mathbf{J}
+\mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body{margin:0;background:var(--bg,#fbfbfa)}.note-workspace{display:block;position:static;width:100%;height:100vh;transform:none;animation:none}
.note-live-editor-host{height:100vh}.note-live-editor-host .cm-content{font-size:calc(16px * var(--note-font-scale,1))}
</style></head><body class="start-page" data-start-theme="light"><main class="note-workspace"><div class="note-live-editor-host" id="editor"></div></main>
<script src="markdown-table.js"></script><script src="markdown.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'ordinary text',notePath:'math.md'});</script></body></html>`;

async function checkWorkspace(browser) {
  const root = path.join(output, 'workspace');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const value = '前文\n\n' + equation + '\n\n后文';
  const filename = path.join(root, 'notes/Formula.md');
  fs.writeFileSync(filename, value);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', context;
  service.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  service.on('error', error => { logs += error.message; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (error) {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'isolated workspace service starts: ' + logs);
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["Formula.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Formula.md');
      localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Formula.md' && T.editor);
    await page.evaluate(() => {
      const at = T.editor.view.state.doc.toString().indexOf('\\rho');
      T.editor.view.dispatch({ selection: { anchor: at, head: at }, scrollIntoView: true }); T.editor.focus();
      window.__originalEditor = T.editor;
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'workspace-light.png') });
    assert.equal(fs.readFileSync(filename, 'utf8'), value, 'opening the preview does not write Markdown');
    const before = await page.evaluate(() => ({ top: T.editor.view.scrollDOM.scrollTop,
      y: T.editor.view.coordsAtPos(T.editor.view.state.selection.main.head).top }));
    await page.evaluate(() => {
      const at = T.editor.view.state.doc.toString().indexOf('\\rho');
      T.editor.view.dispatch({ changes: { from: at, to: at + 4, insert: '\\frac{a}{b}' }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => document.querySelectorAll('.note-live-math-preview-content mjx-mfrac').length >= 4);
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ top: T.editor.view.scrollDOM.scrollTop,
      y: T.editor.view.coordsAtPos(T.editor.view.state.selection.main.head).top, same: __originalEditor === T.editor }));
    assert(after.same && Math.abs(after.top - before.top) <= 1 && Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }));
    assert(await page.evaluate(() => T.flushSave()));
    assert.equal(fs.readFileSync(filename, 'utf8'), value.replace('\\rho', '\\frac{a}{b}'), 'only actual input reaches disk');
    await page.evaluate(() => T.setViewMode('reading'));
    await page.waitForFunction(() => document.querySelector('.note-reading-content mjx-container'));
    assert.equal(await page.locator('.note-live-math-preview-content').count(), 0, 'reading mode suspends the editing preview');
    await page.evaluate(async () => { await T.setViewMode('live'); T.editor.focus(); });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(output, 'workspace-dark.png') });
    assert.deepEqual(errors, []);
    return { saved: true, reading: true, scrollStable: true, editorReused: true };
  } finally {
    await context?.close();
    if (service.pid && service.exitCode === null && service.signalCode === null) {
      const exited = new Promise(resolve => service.once('exit', resolve));
      service.kill(); await exited;
    }
  }
}

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const set = async (value, at = value.indexOf('x') >= 0 ? value.indexOf('x') + 1 : value.indexOf('\\begin') + 3) => {
      await page.evaluate(({ value, at }) => {
        editor.view.contentDOM.blur();
        editor.setDocument({ value, notePath: 'math.md', anchor: at, head: at, scrollTop: 0 });
        editor.focus();
      }, { value, at });
      await settle();
    };
    const previewReady = () => page.waitForFunction(() => document.querySelector('.note-live-math-preview-content mjx-container'));
    // No eager math load, including ordinary edits and an unclosed delimiter.
    await set('ordinary text', 4);
    assert.equal(await page.evaluate(() => !!window.MathJax), false);
    await set('$$\nx^2', 5);
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    assert.equal(await page.evaluate(() => !!window.MathJax), false);

    await set(equation);
    await previewReady();
    assert.equal(await page.locator('.note-live-math-delimiter').count(), 2);
    const appearance = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-line.note-live-math-source')];
      const marker = document.querySelector('.note-live-math-delimiter');
      const preview = document.querySelector('.note-live-math-preview');
      window.__previewDOM = preview;
      return { backgrounds: lines.map(line => getComputedStyle(line).backgroundColor),
        marker: getComputedStyle(marker).color, text: getComputedStyle(lines[1]).color,
        after: preview.getBoundingClientRect().top >= lines.at(-1).getBoundingClientRect().bottom - 1,
        readonly: preview.contentEditable, value: editor.snapshot().value };
    });
    assert(appearance.backgrounds.every(value => value === 'rgba(0, 0, 0, 0)'), JSON.stringify(appearance));
    assert.notEqual(appearance.marker, appearance.text);
    assert(appearance.after); assert.equal(appearance.readonly, 'false'); assert.equal(appearance.value, equation);
    await page.screenshot({ path: path.join(output, 'maxwell-light.png') });
    await page.evaluate(() => {
      const view = editor.view, value = view.state.doc.toString();
      const from = value.indexOf('\\nabla'), to = value.lastIndexOf('$$') + 2;
      view.dispatch({ selection: { anchor: from, head: to } });
      const clipboard = new DataTransfer();
      view.contentDOM.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: clipboard }));
      if (clipboard.getData('text/plain') !== value.slice(from, to)) throw new Error('copy must contain exact Markdown, without the preview');
    });

    // Keep only the latest typing result, reuse the preview DOM, preserve source history.
    await set('before\n\n$$x^2$$\n\nafter'); await previewReady();
    await page.evaluate(() => {
      window.__previewDOM = document.querySelector('.note-live-math-preview');
      window.__mathCalls = 0; window.__mathParallel = 0; window.__mathPeak = 0;
      const original = MathJax.typesetPromise.bind(MathJax);
      MathJax.typesetPromise = async nodes => {
        __mathCalls++; __mathParallel++; __mathPeak = Math.max(__mathPeak, __mathParallel);
        try { return await original(nodes); } finally { __mathParallel--; }
      };
      for (const digit of ['3', '4', '5', '6']) {
        const at = editor.view.state.doc.toString().indexOf('^') + 1;
        editor.view.dispatch({ changes: { from: at, to: at + 1, insert: digit }, userEvent: 'input.type' });
      }
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('6'));
    assert.deepEqual(await page.evaluate(() => ({ calls: __mathCalls, peak: __mathPeak, reused: __previewDOM === document.querySelector('.note-live-math-preview') })),
      { calls: 1, peak: 1, reused: true });
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ selection: { anchor: at, head: at } });
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => __mathCalls), 1, 'caret movement and idle must not typeset unchanged source');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => editor.snapshot().value.includes('x^2'));
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => editor.snapshot().value.includes('x^6'));
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('6'));

    // An older slow render must not replace a newer edit, or start concurrent work.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => {
        MathJax.typesetPromise = original;
        return new Promise((resolve, reject) => {
          window.__releaseEdit = async () => { try { resolve(await original.call(MathJax, nodes)); } catch (error) { reject(error); } };
        });
      };
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '7' } });
    });
    await page.waitForFunction(() => typeof __releaseEdit === 'function');
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '8' } });
    });
    await page.waitForTimeout(150);
    assert((await page.locator('.note-live-math-preview-content').textContent()).includes('6'));
    await page.evaluate(async () => { await __releaseEdit(); delete window.__releaseEdit; });
    await page.waitForFunction(() => document.querySelector('.note-live-math-preview-content')?.textContent.includes('8'));
    assert.equal(await page.evaluate(() => __mathPeak), 1);

    // Invalid input keeps the last good result without exposing MathJax's error box.
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('x^8');
      editor.view.dispatch({ changes: { from: at, to: at + 3, insert: '\\frac{' } });
    });
    await page.waitForFunction(() => !document.querySelector('.note-live-math-status').hidden);
    assert.equal(await page.locator('.note-live-math-preview mjx-merror').count(), 0);
    assert((await page.locator('.note-live-math-preview-content').textContent()).includes('8'));
    await page.evaluate(() => {
      const at = editor.view.state.doc.toString().indexOf('\\frac{');
      editor.view.dispatch({ changes: { from: at, to: at + 6, insert: '\\frac{1}{2}' } });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-status').hidden && document.querySelector('.note-live-math-preview-content mjx-mfrac'));
    await page.evaluate(() => {
      const value = editor.view.state.doc.toString(), from = value.indexOf('$$') + 2, to = value.lastIndexOf('$$');
      editor.view.dispatch({ changes: { from, to, insert: '\\fra' } });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-math-status').hidden === false);
    assert.equal(await page.locator('.note-live-math-preview-content mjx-mfrac').count(), 1, 'an incomplete command keeps the last fraction');
    assert.equal(await page.locator('.note-live-math-preview-content mtext[mathcolor="red"]').count(), 0);

    // First-invalid and corrected input; delimiter removal removes the preview.
    await set('$$\n\\frac{\n$$', 8);
    await page.waitForFunction(() => document.querySelector('.note-live-math-status')?.hidden === false);
    assert.equal(await page.locator('.note-live-math-preview-content').count(), 0);
    await page.evaluate(() => {
      const length = editor.view.state.doc.length;
      editor.view.dispatch({ changes: { from: length - 2, to: length } });
    });
    await settle(); assert.equal(await page.locator('.note-live-math-preview').count(), 0);

    const variants = [];
    for (const [theme, width, scale] of [['light', 1100, 1], ['dark', 620, 1.4]]) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(({ theme, scale }) => { document.body.dataset.startTheme = theme; document.body.style.setProperty('--note-font-scale', scale); }, { theme, scale });
      for (const [name, value] of [
        ['single', '$$x^2$$'], ['brackets', '\\[x^2\\]'], ['integral', '$$\n\\int_0^\\infty e^{-x}dx\n$$'],
        ['matrix', '$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$'], ['number', '$$\\frac{a}{b}\\tag{6}$$'],
        ['literal', '$$\\text{**bold** [link](https://example.test)}$$'],
        ['quote', '> $$\n> x^2\n> $$'], ['callout', '> [!note]\n> $$x^2$$'], ['color', '> [!blue]\n> $$x^2$$'],
      ]) {
        await set(value + '\n\nafter', value.indexOf('x') >= 0 ? value.indexOf('x') + 1 : value.indexOf('\\') + 3);
        await previewReady();
        assert.equal(await page.locator('.note-live-math-preview').count(), 1, name);
        assert.equal(await page.locator('.note-live-math-delimiter').count(), 2, name);
        assert.equal(await page.locator('.note-live-math-preview mjx-merror').count(), 0, name);
        assert.equal(await page.locator('.cm-line.note-live-math-source .note-live-strong, .cm-line.note-live-math-source .note-live-inline-code, .cm-line.note-live-math-source .note-live-link, .cm-line.note-live-math-source .is-escape').count(), 0,
          'formula source must not acquire Markdown formatting: ' + name);
        if (name === 'number') assert.equal(await page.locator('.note-live-math-preview mjx-labels').count(), 1);
        if (name === 'callout' || name === 'color') {
          const colors = await page.evaluate(() => [document.querySelector('.note-live-math-preview'), document.querySelector('.cm-line.note-live-math-source')].map(el => getComputedStyle(el).backgroundColor));
          assert.equal(colors[0], colors[1]); assert.notEqual(colors[0], 'rgba(0, 0, 0, 0)');
        }
        variants.push({ name, theme });
      }
      await set(equation); await previewReady();
      await page.screenshot({ path: path.join(output, 'maxwell-' + theme + '.png') });
      const wide = '$$' + Array.from({ length: 75 }, (_, i) => 'x_{' + i + '}').join('+') + '$$';
      await set(wide + '\n\nafter', 5); await previewReady();
      const sizing = await page.evaluate(() => {
        const el = document.querySelector('.note-live-math-preview');
        el.scrollLeft = 70;
        return { width: el.clientWidth, scrollWidth: el.scrollWidth, scrolled: el.scrollLeft > 0, editor: editor.view.contentDOM.getBoundingClientRect().width, viewport: innerWidth };
      });
      assert(sizing.scrollWidth > sizing.width && sizing.scrolled && sizing.editor <= sizing.viewport, JSON.stringify(sizing));
    }

    // Composition uses the browser's actual provisional text, never a rebuilt source line.
    await set('$$x^2$$\n\nafter'); await previewReady();
    const cdp = await page.context().newCDPSession(page);
    const callsBeforeIme = await page.evaluate(() => __mathCalls);
    for (const text of ['h', 'han']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => __mathCalls), callsBeforeIme);
    await cdp.send('Input.insertText', { text: '汉' });
    await page.waitForFunction(() => editor.snapshot().value.includes('汉') && document.querySelector('.note-live-math-preview-content')?.textContent.includes('汉'));
    assert.equal(await page.locator('.note-live-math-preview').count(), 1);
    for (const text of ['z', 'zi']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await settle(); assert(!await page.evaluate(() => editor.snapshot().value.includes('zi')));

    // Source/read-only presentation, folding, and leaving the formula retain the old behavior.
    await set('> [!note]+ Title\n> $$x^2$$\n\nafter'); await previewReady();
    await page.locator('.note-callout-fold').click(); await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    await set(equation); await previewReady();
    await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.equal(await page.locator('.note-live-math-preview, .note-live-math-delimiter').count(), 0);
    await page.evaluate(() => { editor.setSourceMode(false); editor.focus(); }); await previewReady();
    await page.evaluate(() => { editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length, head: editor.view.state.doc.length } }); editor.view.contentDOM.blur(); });
    await settle(); assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    await set('inline $x^2$ only', 10); await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);

    // Visibility cancellation releases all MathItems and resumes only the current formula.
    for (const kind of ['minimize', 'hidden', 'workspace', 'pagehide']) {
      await set('$$x^2$$\n\nafter'); await previewReady();
      await page.evaluate(kind => {
        if (kind === 'minimize') { document.documentElement.dataset.desktopMinimized = '1'; dispatchEvent(new Event('canvasdesktop:visibility')); }
        if (kind === 'hidden') document.querySelector('.note-workspace').hidden = true;
        if (kind === 'workspace') document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'canvas' } }));
        if (kind === 'pagehide') dispatchEvent(new Event('pagehide'));
      }, kind);
      await settle();
      assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0, kind);
      await page.waitForTimeout(180);
      assert.equal(await page.locator('.note-live-math-preview-content').count(), 0, kind);
      await page.evaluate(kind => {
        if (kind === 'minimize') { document.documentElement.dataset.desktopMinimized = '0'; dispatchEvent(new Event('canvasdesktop:visibility')); }
        if (kind === 'hidden') document.querySelector('.note-workspace').hidden = false;
        if (kind === 'workspace') document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'notes' } }));
        if (kind === 'pagehide') dispatchEvent(new Event('pageshow'));
      }, kind);
      await previewReady();
    }
    // A delayed typeset cannot populate a new document or retain detached MathItems.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => new Promise((resolve, reject) => {
        window.__releaseMath = async () => { MathJax.typesetPromise = original; try { resolve(await original.call(MathJax, nodes)); } catch (error) { reject(error); } };
      });
      const at = editor.view.state.doc.toString().indexOf('^') + 1;
      editor.view.dispatch({ changes: { from: at, to: at + 1, insert: '8' } });
    });
    await page.waitForFunction(() => typeof __releaseMath === 'function');
    await page.evaluate(async () => { editor.setDocument({ value: 'ordinary text', notePath: 'other.md' }); await __releaseMath(); delete window.__releaseMath; });
    await settle();
    assert.equal(await page.locator('.note-live-math-preview').count(), 0);
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    const idle = await page.evaluate(() => __mathCalls); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => __mathCalls), idle);
    await set('$$x^2$$\n\nafter'); await previewReady();
    await page.evaluate(() => editor.destroy()); await settle();
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    assert.deepEqual(errors, []);
    const workspace = await checkWorkspace(browser);
    console.log(JSON.stringify({ output, variants, typing: true, history: true, errors: true, ime: true, lifecycle: true, workspace }));
  } catch (error) {
    console.error('math preview output:', output);
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      console.error(await page.evaluate(() => ({ value: editor.snapshot().value, html: document.querySelector('.note-live-math-preview')?.outerHTML.slice(0, 1800),
        records: window.MathJax?.startup?.document && Array.from(MathJax.startup.document.math).length, calls: window.__mathCalls })).catch(() => null));
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

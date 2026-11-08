'use strict';

// Real offline MathJax/CodeMirror; only synthetic documents and a disposable profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-inline-math-'));
const popup = '.note-inline-math-preview';
const html = markdown => `<!doctype html><html lang="zh-CN" ${markdown ? 'data-markdown-dark="0"' : ''}><head>
<meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="note-theme.css">${markdown ? '<link rel="stylesheet" href="markdown-file.css">' : ''}
<style>body{margin:0}.note-workspace{display:block;position:static;width:100%;height:100vh;transform:none;animation:none}
.note-document-pane{position:relative;height:100%;width:100%}.note-live-editor-host{height:100%}</style></head>
<body class="start-page ${markdown ? 'markdown-window' : ''}" data-start-workspace="notes" data-start-theme="light">
<main class="note-workspace ${markdown ? 'markdown-root' : ''}"><div class="note-document-pane"><div id="editor" class="note-live-editor-host"></div></div></main>
<script src="markdown-table.js"></script><script src="markdown.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.changes=0;window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{
value:'ordinary text',notePath:'synthetic.md',onChange(){changes++}});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html(url.searchParams.has('markdown'))); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  let browser, page;
  const errors = [], requests = [], report = {};
  try {
    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1050, height: 780 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.stack)); page.on('request', request => requests.push(request.url()));
    page.setDefaultTimeout(10000);
    await page.goto(url); await page.waitForFunction(() => window.editor?.view);
    assert(!requests.some(value => value.includes('mathjax')), 'ordinary text does not load math');
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const ready = async () => {
      await page.waitForFunction(() => document.querySelector('.note-inline-math-preview:not([hidden]) .note-inline-math-content mjx-container'));
      await settle();
    };
    const absent = async () => { await settle(); assert.equal(await page.locator(popup + ':visible').count(), 0); };
    const set = async (value, anchor = value.lastIndexOf('x') + 1, head = anchor) => {
      await page.evaluate(({ value, anchor, head }) => {
        editor.view.contentDOM.blur(); editor.setSourceMode(false); editor.setExtensionsActive(true);
        editor.setDocument({ value, notePath: 'synthetic.md', anchor, head, scrollTop: 0 }); editor.focus();
      }, { value, anchor, head }); await settle();
    };

    // Loading the local runtime may finish after the user has left the formula.
    let releaseLoader, enteredLoader;
    const loaderStarted = new Promise(resolve => { enteredLoader = resolve; });
    await page.route('**/mathjax/tex-mml-chtml.js', route => { releaseLoader = () => route.continue(); enteredLoader(); });
    await set('Text $x^2$ tail'); await loaderStarted;
    await set('ordinary replacement', 2); await releaseLoader();
    await page.waitForFunction(() => typeof window.MathJax?.typesetPromise === 'function');
    await page.evaluate(() => MathJax.startup.promise); await absent();
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    await page.unroute('**/mathjax/tex-mml-chtml.js');

    // Existing decoration guards, containers and both content boundaries.
    const contexts = ['Text $x^2+y^2$ tail', String.raw`Text \(x^2+y^2\) tail`, '- Text $x^2$ tail',
      '> Text $x^2$ tail', '> [!note]\n> Text $x^2$ tail', '> [!note]\n> > [!tip]\n> > Text $x^2$ tail'];
    for (const value of contexts) {
      await set(value); await ready();
      assert.equal(await page.evaluate(() => editor.snapshot().value), value);
      assert.equal(await page.evaluate(() => document.activeElement === editor.view.contentDOM), true);
    }
    await set('Text $x^2$ tail', 6); await ready(); // immediately after opening $
    await page.evaluate(() => editor.view.dispatch({ selection: { anchor: 9 } })); await ready(); // before closing $
    for (const at of [5, 10, 12]) { await set('Text $x^2$ tail', at); await absent(); }
    const guarded = ['Text $x^2 tail', String.raw`Text \$x^2$ tail`, '`$x^2$`', '```tex\n$x^2$\n```',
      '<!-- $x^2$ -->', '---\nformula: $x^2$\n---\nbody', '$$x^2$$', '$' + 'x'.repeat(4096) + '$',
      '[label](https://example.com/$x^2$)', '<div>$x^2$</div>'];
    for (const value of guarded) { await set(value); await absent(); }
    await set('Text $x^2$ tail', 6, 8); await absent();
    await set('Text $x^2$ tail'); await ready();
    await page.evaluate(() => editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.create([
      RelatumCodeMirror.EditorSelection.cursor(7), RelatumCodeMirror.EditorSelection.cursor(13)]) })); await absent();
    report.recognition = contexts.length + guarded.length + 6;

    await set('Text $x^2$ tail', 14); await absent();
    await page.locator('.note-live-inline-math').click(); await ready();
    assert.equal(await page.evaluate(() => editor.snapshot().value), 'Text $x^2$ tail');

    // Preview work changes neither source geometry nor undo history.
    await set('Text $x^2$ tail'); await ready();
    const before = await page.evaluate(() => ({ value: editor.snapshot().value, selection: editor.view.state.selection.toJSON(), changes,
      height: editor.view.contentDOM.scrollHeight, scroll: editor.view.scrollDOM.scrollTop }));
    await page.keyboard.press('Escape'); await absent();
    assert.deepEqual(await page.evaluate(() => ({ value: editor.snapshot().value, selection: editor.view.state.selection.toJSON(), changes,
      height: editor.view.contentDOM.scrollHeight, scroll: editor.view.scrollDOM.scrollTop })), before);
    await page.keyboard.type('3'); await ready();
    assert.equal(await page.evaluate(() => editor.snapshot().value), 'Text $x3^2$ tail');
    await page.keyboard.press('Control+z'); await ready();
    assert.equal(await page.evaluate(() => editor.snapshot().value), before.value);
    await page.keyboard.press('Control+y'); await ready();
    assert.equal(await page.evaluate(() => editor.snapshot().value), 'Text $x3^2$ tail');
    await page.locator(popup).click();
    assert.equal(await page.evaluate(() => document.activeElement === editor.view.contentDOM), true);
    await page.evaluate(() => {
      const view = editor.view, at = view.state.doc.toString().lastIndexOf('$');
      view.dispatch({ changes: { from: at, to: at + 1 }, userEvent: 'delete' });
    }); await absent();

    await set('Text $x^2$ tail'); await ready();
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      window.inlineCalls = 0; window.mathPeak = 0; let active = 0;
      MathJax.typesetPromise = async nodes => {
        if (nodes[0].matches('.note-inline-math-stage')) inlineCalls++;
        mathPeak = Math.max(mathPeak, ++active);
        try { return await original.call(MathJax, nodes); } finally { active--; }
      };
    });
    await page.keyboard.type('12345', { delay: 10 });
    await page.waitForFunction(() => document.querySelector('.note-inline-math-content')?.textContent.includes('12345'));
    assert.deepEqual(await page.evaluate(() => ({ calls: inlineCalls, peak: mathPeak })), { calls: 1, peak: 1 });
    await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await absent();
    assert.equal(await page.evaluate(() => editor.snapshot().value), '');

    // One successful result survives incomplete TeX, then recovers.
    await set(String.raw`Text $\frac{x}{2}$ tail`); await ready();
    await page.evaluate(() => {
      const view = editor.view, value = view.state.doc.toString(), from = value.indexOf('\\frac'), to = value.lastIndexOf('$');
      view.dispatch({ changes: { from, to, insert: '\\fra' }, selection: { anchor: from + 4 }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => document.querySelector('.note-inline-math-status:not([hidden])'));
    assert.equal(await page.locator(popup + ' mjx-mfrac').count(), 1);
    assert.equal(await page.locator(popup + ' mjx-merror').count(), 0);
    await page.evaluate(() => {
      const view = editor.view, value = view.state.doc.toString(), from = value.indexOf('\\fra'), to = value.lastIndexOf('$');
      view.dispatch({ changes: { from, to, insert: 'x+8' }, selection: { anchor: from + 2 }, userEvent: 'input.paste' });
    });
    await page.waitForFunction(() => document.querySelector('.note-inline-math-content')?.textContent.includes('8')
      && document.querySelector('.note-inline-math-status').hidden);

    // A rejected render releases the shared queue; first failures expose no
    // MathJax error boxes, and all status messages follow the UI language.
    await page.evaluate(() => {
      document.documentElement.lang = 'en';
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => {
        if (!nodes[0].matches('.note-inline-math-stage')) return original.call(MathJax, nodes);
        MathJax.typesetPromise = original; return Promise.reject(new Error('deliberate test rejection'));
      };
    });
    await set('Text $x+7$ tail');
    await page.waitForFunction(() => document.querySelector('.note-inline-math-status')?.textContent === 'Formula preview unavailable');
    assert.equal(await page.locator(popup + ' mjx-container').count(), 0);
    await set(String.raw`Text $\fra{x}$ tail`);
    await page.waitForFunction(() => document.querySelector('.note-inline-math-status')?.textContent === 'Formula is incomplete');
    assert.equal(await page.locator(popup + ' mjx-merror').count(), 0);
    await page.evaluate(() => { document.documentElement.lang = 'zh-CN'; });
    await set('Text $x+8$ tail'); await ready();

    // A deliberately slow typeset must never commit into a newer document.
    await page.evaluate(() => {
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => {
        if (!nodes[0].matches('.note-inline-math-stage')) return original.call(MathJax, nodes);
        MathJax.typesetPromise = original;
        return new Promise((resolve, reject) => { window.releaseMath = () => original.call(MathJax, nodes).then(resolve, reject); });
      };
      editor.view.dispatch({ changes: { from: 7, insert: '+9' }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => window.releaseMath);
    await set('ordinary replacement', 2); await page.evaluate(() => releaseMath()); await absent();
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    await set('Text $x+10$ tail'); await ready();

    await page.evaluate(() => {
      delete window.releaseMath;
      const original = MathJax.typesetPromise;
      MathJax.typesetPromise = nodes => {
        if (!nodes[0].matches('.note-inline-math-stage')) return original.call(MathJax, nodes);
        MathJax.typesetPromise = original;
        return new Promise((resolve, reject) => { window.releaseMath = () => original.call(MathJax, nodes).then(resolve, reject); });
      };
      editor.view.dispatch({ changes: { from: 7, insert: '+9' }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => window.releaseMath);
    await page.evaluate(() => {
      editor.view.dispatch({ changes: { from: 6, to: 12, insert: 'x+77' }, selection: { anchor: 7 }, userEvent: 'input.type' });
      return releaseMath();
    });
    await page.waitForFunction(() => document.querySelector('.note-inline-math-content')?.textContent.includes('77'));
    assert(!(await page.locator('.note-inline-math-content').textContent()).includes('9'), 'superseded formula result is discarded');
    await page.evaluate(() => { document.documentElement.style.setProperty('--note-font-scale', '1.4'); editor.view.requestMeasure(); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.note-inline-math-preview')).fontSize === getComputedStyle(editor.view.contentDOM).fontSize);
    assert.equal(await page.locator(popup).evaluate(node => getComputedStyle(node).fontSize), '22.4px');
    await page.evaluate(() => { document.documentElement.style.removeProperty('--note-font-scale'); editor.view.requestMeasure(); });

    // Real Chromium composition input commits only once and can render Chinese
    // TeX text after the candidate session has settled.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '汉', selectionStart: 1, selectionEnd: 1 }); await absent();
    await cdp.send('Input.insertText', { text: '汉' }); await ready();
    assert((await page.evaluate(() => editor.snapshot().value)).includes('汉'));
    await cdp.detach();

    // IME suspension and every host lifecycle use the existing visibility path.
    await page.evaluate(() => editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await absent();
    await page.evaluate(() => editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await ready();
    await page.evaluate(() => editor.setSourceMode(true)); await absent();
    await page.evaluate(() => editor.setSourceMode(false)); await ready();
    for (const kind of ['active', 'minimized', 'workspace', 'pagehide', 'blur', 'hidden']) {
      await page.evaluate(kind => {
        if (kind === 'active') editor.setExtensionsActive(false);
        if (kind === 'minimized') { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
        if (kind === 'workspace') { document.body.dataset.startWorkspace = 'daily'; document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', { detail: { workspace: 'daily' } })); }
        if (kind === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        if (kind === 'blur') editor.view.contentDOM.blur();
        if (kind === 'hidden') { document.getElementById('editor').hidden = true; editor.setExtensionsActive(false); }
      }, kind); await absent();
      await page.evaluate(kind => {
        delete document.documentElement.dataset.desktopMinimized; document.body.dataset.startWorkspace = 'notes';
        document.getElementById('editor').hidden = false; editor.setExtensionsActive(true);
        window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('canvasdesktop:visibility')); editor.focus();
      }, kind); await ready();
    }
    report.lifecycle = 9;

    // Theme portals, viewport edges, body scaling and real horizontal scrolling.
    const themes = [];
    for (const theme of ['default', 'claude', 'sky', 'apple']) for (const dark of [false, true]) {
      await page.evaluate(({ theme, dark }) => { document.documentElement.dataset.noteTheme = theme;
        document.body.dataset.startTheme = dark ? 'dark' : 'light'; }, { theme, dark });
      await set(String.raw`Text $\frac{x^2}{y+1}$ tail`); await ready();
      const metrics = await page.locator(popup).evaluate(node => ({ bg: getComputedStyle(node).backgroundColor,
        color: getComputedStyle(node).color, width: node.offsetWidth, height: node.offsetHeight }));
      assert.notEqual(metrics.bg, 'rgba(0, 0, 0, 0)'); assert.notEqual(metrics.bg, metrics.color);
      assert(metrics.width <= 480 && metrics.height <= 240);
      themes.push({ theme, dark, ...metrics });
      await page.screenshot({ path: path.join(output, theme + (dark ? '-dark' : '-light') + '.png') });
    }
    await page.setViewportSize({ width: 390, height: 650 });
    await set('Text $' + Array.from({ length: 60 }, (_, i) => 'x_{' + i + '}').join('+') + '$ tail'); await ready();
    await page.waitForFunction(() => {
      const rect = document.querySelector('.note-inline-math-preview').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    });
    const wide = await page.locator(popup).evaluate(node => {
      const r = node.getBoundingClientRect(); node.scrollLeft = 80;
      return { left: r.left, right: r.right, width: r.width, scroll: node.scrollLeft, height: r.height,
        style: node.style.cssText, transform: getComputedStyle(node).transform, transition: getComputedStyle(node).transition,
        body: getComputedStyle(document.body).transform, position: getComputedStyle(node).position };
    });
    assert(wide.width <= 366 && wide.left >= 0 && wide.right <= 390 && wide.scroll > 0, JSON.stringify(wide));
    const thumb = await page.locator(popup).evaluate(node => {
      node.scrollLeft = 0; const rect = node.getBoundingClientRect();
      return { x: rect.left + Math.max(25, node.clientWidth * node.clientWidth / node.scrollWidth / 2),
        y: rect.bottom - (node.offsetHeight - node.clientHeight) / 2 };
    });
    await page.mouse.move(thumb.x, thumb.y); await page.mouse.down();
    await page.mouse.move(thumb.x + 120, thumb.y, { steps: 6 }); await page.mouse.up();
    assert(await page.locator(popup).evaluate(node => node.scrollLeft > 80), 'native thumb drag scrolls the preview');
    assert.equal(await page.evaluate(() => document.activeElement === editor.view.contentDOM), true);
    await page.locator(popup).click({ position: { x: 20, y: 12 } });
    assert.equal(await page.evaluate(() => document.activeElement === editor.view.contentDOM), true);
    await page.screenshot({ path: path.join(output, 'narrow-wide-formula.png') });
    report.themes = themes;

    // The standalone Markdown shell gets the same editor with its own pure colors.
    await page.goto(url + '/?markdown'); await page.waitForFunction(() => window.editor?.view);
    for (const dark of [false, true]) {
      await page.evaluate(dark => { document.documentElement.dataset.markdownDark = dark ? '1' : '0'; }, dark);
      await set('Markdown $x^2+y^2$ tail'); await ready();
      assert.equal(await page.locator(popup).evaluate(node => getComputedStyle(node).backgroundColor), dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    }
    await page.evaluate(() => editor.destroy()); await absent();
    assert.equal(await page.evaluate(() => Array.from(MathJax.startup.document.math).length), 0);
    assert.deepEqual(errors, []);
    assert(requests.every(value => new URL(value).origin === url), 'all formula/font resources stay offline');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, recognition: report.recognition, lifecycle: report.lifecycle, themes: themes.length, standalone: 2 }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      console.error(await page.evaluate(() => ({ value: editor?.snapshot().value, popup: document.querySelector('.note-inline-math-preview')?.outerHTML.slice(0, 1400) })).catch(() => null)); }
    console.error({ output, errors }); throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

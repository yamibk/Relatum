'use strict';
// Real pointer input against static assets and synthetic notes. No user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-parent-input-'));
const baselineRef = process.env.RELATUM_MEDIA_INPUT_BASELINE || 'd9bb379';
const old = Object.fromEntries(['note-media.js', 'note-media.css'].map(name => [name,
  execFileSync('git', ['show', baselineRef + ':assets/' + name], { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 })]));
const paragraph = '2022 年发表在 Journal of Computational Languages 的研究 **Surveying communities of users of MATLAB and clone languages** 调查了 212 份有效问卷。';
const block = (body = '', target = 'image.svg') => '> [!media]\n> ![图|200](' + target + ')\n>\n' + body.split('\n').map(row => '> ' + row).join('\n');
const text = '```\nCODE\n```\n\n' + paragraph;
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-media.js', 'note-live-editor.js'];
const html = variant => '<!doctype html><meta charset="utf-8"><base href="/' + variant + '/assets/">'
  + '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css">'
  + '<style>body{margin:0;display:block}.note-workspace{display:block!important;height:100vh}.note-document-pane{height:100%;margin:0!important}.note-document-pane::before{display:none}.note-document-body{height:100%;margin:0!important}.note-live-editor-host{width:min(960px,100vw);height:100vh;margin:auto}</style>'
  + '<body class="start-page" data-start-theme="light" data-start-workspace="notes"><main class="note-workspace"><section class="note-document-pane"><div class="note-document-body"><div id="host" class="note-live-editor-host"></div></div></section></main>'
  + scripts.map(name => '<script src="' + name + '"></script>').join('')
  + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"parent.md",imageUrl:(note,target)=>"/"+target});</script>';
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname, variant = name.split('/')[1];
  if (name === '/image.svg' || name === '/delayed.svg') {
    const send = () => { if (!res.destroyed) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#b8b0a5"/></svg>'); } };
    if (name === '/delayed.svg') setTimeout(send, 250); else send(); return;
  }
  if (!['baseline', 'current'].includes(variant)) return res.writeHead(404).end();
  if (name === '/' + variant + '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name.replace(/^\/(baseline|current)/, '')));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(variant === 'baseline' && old[path.basename(file)] || fs.readFileSync(file));
});
(async () => {
  const report = { baselineRef, reproduction: [], matrix: [], scenarios: [], errors: [] }; let browser, page;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.stack));
    const pause = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const open = async variant => { await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/'); await page.waitForFunction(() => window.editor); };
    const load = async value => {
      await page.evaluate(value => { editor.setSourceMode(false); editor.setDocument({ value, notePath: 'parent.md' }); editor.view.scrollDOM.scrollTop = 0; }, value);
      await pause(); await page.evaluate(() => document.fonts.ready); await pause();
      if (value.includes('[!media]') && !value.includes('delayed.svg')) {
        await page.waitForFunction(() => [...document.querySelectorAll('.note-media-image img')].every(img => img.complete && img.naturalWidth > 0)); await pause();
      }
    };
    const source = () => page.evaluate(() => editor.snapshot().value);
    const focus = async at => { await page.evaluate(at => { editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(at), effects: RelatumCodeMirror.EditorView.scrollIntoView(at, { y: 'center' }) }); editor.view.focus(); }, at); await pause(); };
    const point = async at => {
      await page.evaluate(at => editor.view.dispatch({ effects: RelatumCodeMirror.EditorView.scrollIntoView(at, { y: 'center' }) }), at); await pause();
      return page.evaluate(at => { const c = editor.view.coordsAtPos(at); if (!c) throw Error('No coordinates at ' + at); return { x: c.left + .5, y: (c.top + c.bottom) / 2 }; }, at);
    };
    const selection = () => page.evaluate(() => { const range = editor.view.state.selection.main; return { from: range.from, to: range.to }; });
    const clickAt = async at => { const p = await point(at); await page.mouse.click(p.x, p.y); await pause(); return (await selection()).to; };
    const drag = async (from, to) => {
      await focus(from); const a = await point(from); await page.mouse.move(a.x, a.y); await page.mouse.down(); await pause();
      // Marker visibility follows the real selection. Re-read the final target
      // after that normal layout transition, as a user adjusts their drag.
      for (let i = 0; i < 3; i++) { const b = await point(to); await page.mouse.move(b.x, b.y, { steps: 5 }); await pause(); }
      await page.mouse.up(); await pause(); return selection();
    };
    const geometry = () => page.evaluate(() => {
      const view = editor.view; view.posAtCoords({ x: 20, y: 20 }, false);
      const lines = [...view.contentDOM.children].filter(el => el.classList.contains('cm-line')).map(el => {
        const at = view.posAtDOM(el, 0), block = view.lineBlockAt(at);
        return { at, delta: el.getBoundingClientRect().top - view.documentTop - block.top };
      });
      const widgets = [...view.contentDOM.children].filter(el => el.__noteMedia).map(el => {
        const surface = el.__noteMedia, block = view.lineBlockAt(surface.widget.spec.from);
        return { measured: block.bottom - block.top, actual: el.getBoundingClientRect().height, cached: el.__relatumBlockLayout?.widget.layoutHeight,
          spacing: el.getBoundingClientRect().height - surface.root.getBoundingClientRect().height };
      });
      return { lines, widgets };
    });
    const check = async ({ reproduce = false, insert = false } = {}) => {
      const original = await source(), fence = original.indexOf('```\nCODE') + 3, tail = original.indexOf('有效') + 1;
      await focus(original.indexOf('CODE') + 1); const fenceActual = await clickAt(fence);
      await focus(tail); const tailActual = await clickAt(tail);
      const from = original.indexOf('212') + 1, to = original.indexOf('问卷') + 1;
      const partial = await drag(from, to), backward = await drag(to, from);
      const crossFrom = original.indexOf('2022') + 2, crossTo = original.indexOf('有效') + 1;
      const cross = await drag(crossFrom, crossTo), crossBack = await drag(crossTo, crossFrom);
      const measured = await geometry(), result = { fence, fenceActual, tail, tailActual, partial, backward, cross, crossBack, measured };
      if (!reproduce) {
        assert.equal(fenceActual, fence, 'fence opener accepts the exact caret position'); assert.equal(tailActual, tail, 'wrapped paragraph accepts the exact caret position');
        assert.deepEqual(partial, { from, to }); assert.deepEqual(backward, { from, to });
        assert.deepEqual(cross, { from: crossFrom, to: crossTo }); assert.deepEqual(crossBack, { from: crossFrom, to: crossTo });
        for (const line of measured.lines) assert(Math.abs(line.delta) <= 1, JSON.stringify(line));
        for (const widget of measured.widgets) { assert(Math.abs(widget.measured - widget.actual) <= 1, JSON.stringify(widget)); assert(Math.abs(widget.spacing - 24) <= 1, JSON.stringify(widget)); }
        if (insert) {
          await focus(tail); await clickAt(tail); await page.keyboard.type('X'); await pause();
          assert.equal(await source(), original.slice(0, tail) + 'X' + original.slice(tail)); await page.keyboard.press('Control+z'); await pause();
        }
        assert.equal(await source(), original, 'pointer operations and undo preserve Markdown');
      }
      return result;
    };
    for (const variant of ['baseline', 'current']) {
      await open(variant); await page.evaluate(() => document.documentElement.dataset.noteTheme = 'apple'); await load(block() + '\n\n' + text);
      report.reproduction.push({ variant, ...await check({ reproduce: variant === 'baseline', insert: variant === 'current' }) });
    }
    const broken = report.reproduction[0]; assert.notEqual(broken.fenceActual, broken.fence); assert.notEqual(broken.tailActual, broken.tail);
    assert(broken.measured.lines.some(line => Math.abs(line.delta - 24) <= 1), 'baseline exposes the omitted 24px spacing');

    for (const standalone of [false, true]) {
      if (standalone) { await page.addStyleTag({ url: '/current/assets/markdown-file.css' }); await page.evaluate(() => document.body.classList.add('markdown-window')); }
      for (const theme of ['default', 'claude', 'sky', 'apple']) for (const dark of [false, true]) for (const narrow of [false, true]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: narrow ? 480 : 1280, height: 1400 });
        await page.evaluate(({ theme, dark, scale }) => { document.documentElement.dataset.noteTheme = theme; document.body.dataset.startTheme = dark ? 'dark' : 'light'; document.querySelector('.note-document-pane').style.setProperty('--note-font-scale', scale); }, { theme, dark, scale });
        await load(block() + '\n\n' + text); const result = await check(); report.matrix.push({ standalone, theme, dark, narrow, scale, result });
      }
    }
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.evaluate(() => { document.body.classList.remove('markdown-window'); document.documentElement.dataset.noteTheme = 'apple'; document.body.dataset.startTheme = 'light'; document.querySelector('.note-document-pane').style.setProperty('--note-font-scale', 1); });
    for (const [name, value] of Object.entries({ none: text, after: text + '\n\n' + block(), multiple: [block(), block('Caption'), block(), text].join('\n\n'), brackets: block() + '\n\n' + text.replace(paragraph, '【' + paragraph + '】'), nested: '> [!note]\n> before\n>\n' + block().split('\n').map(row => '> ' + row).join('\n') + '\n>\n> after\n\n' + text })) {
      await load(value); report.scenarios.push({ name, result: await check() });
    }
    // Complete asynchronous resources, resize/edit/select/remove the visual
    // block, and then exercise the same parent text rather than only the caption.
    await load(block('', 'delayed.svg') + '\n\n' + text); await page.locator('.note-media-image img').evaluate(img => img.loading = 'eager');
    await page.waitForFunction(() => document.querySelector('.note-media-image img')?.naturalWidth > 0); await pause(); report.scenarios.push({ name: 'delayed-image', result: await check() });
    await page.locator('.note-media-image .note-live-image-frame').click();
    const handle = await page.locator('.note-live-image-resize-handle').boundingBox();
    await page.mouse.move(handle.x + 3, handle.y + 3); await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + 3, { steps: 5 }); await page.mouse.up(); await pause(); report.scenarios.push({ name: 'resized-image', result: await check() });
    await page.locator('.note-media-body').click({ position: { x: 15, y: 8 } }); await page.keyboard.type('caption'); await page.keyboard.press('Escape'); await pause(); report.scenarios.push({ name: 'edited-selected-media', result: await check() });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const root = document.querySelector('.note-media'), spec = root.__noteMedia.current(); editor.view.dispatch({ changes: { from: spec.from, to: spec.to + 2 } }); }); await pause();
    report.scenarios.push({ name: 'deleted-media', result: await check() });
    for (const [name, extra] of Object.entries({ callout: '> [!note]\n> Existing callout', table: '| A | B |\n|---|---|\n| One | Two |', mermaid: '```mermaid\nflowchart LR\nA-->B\n```' })) {
      await load(block() + '\n\n' + extra + '\n\n' + text);
      if (name === 'mermaid') { await page.locator('.note-mermaid svg').first().waitFor({ timeout: 30000 }); await pause(); }
      report.scenarios.push({ name, result: await check() });
    }
    await page.screenshot({ path: path.join(output, 'parent-input.png') });
    assert.deepEqual(report.errors, []);
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, state: await page.evaluate(() => ({ value: window.editor?.snapshot().value, html: document.getElementById('host')?.innerHTML })).catch(() => null) }, null, 2)); }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve)); console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

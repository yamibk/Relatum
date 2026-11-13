'use strict';
// Uses the real local service and, with --webview2, the prepared desktop Python.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-pdf-'));
const note = '研究笔记.md', other = 'Other.md', imageNote = 'Images.md';
const pdf = path.join(root, '研究笔记.pdf');
const notes = path.join(root, 'notes'), attachments = path.join(notes, '研究笔记.assets');
fs.mkdirSync(attachments, { recursive: true });
fs.writeFileSync(path.join(attachments, 'local.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDXYAAAAASUVORK5CYII=', 'base64'));
fs.writeFileSync(path.join(attachments, 'tall.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="1500" viewBox="0 0 100 1500"><rect width="100" height="1500" fill="#e6eef6"/></svg>');
const fence = '```';
const source = [
  '# 研究笔记', '', '[TOC]', '', '第一段与脚注[^a]。[Example](https://example.com)', '',
  '> [!note]- Folded', '> Exported folded content.', '',
  '| Repeated heading | Description |', '| --- | --- |',
  ...Array.from({ length: 66 }, (_, i) => `| Table row ${i} | ${'wide-word'.repeat(8)} |`),
  '', '## 屏外内容', '', '![Local image](研究笔记.assets/local.png)', '',
  '![Missing image](研究笔记.assets/missing.png)', '', '![Remote image](https://example.com/image.png)', '',
  '![Shared.canvas|640x360](canvases/Shared.canvas)', '',
  '$$x^2+1$$', '', fence + 'mermaid', 'flowchart LR', 'A[MermaidStart] --> B[MermaidEnd]', fence, '',
  '$$\\notARealMathCommand$$', '', fence + 'mermaid', 'flowchart LR', 'A[', fence, '',
  '![Tall|100x1500](研究笔记.assets/tall.svg)', '',
  fence + 'quiz', 'Quiz question', '- [x] Answer', '- [ ] Distractor', fence, '',
  '[^a]: Footnote content', '', '## Tail marker', '',
].join('\n');
fs.writeFileSync(path.join(notes, note), source);
fs.writeFileSync(path.join(notes, other), '# Other note');
fs.writeFileSync(path.join(notes, imageNote), Array.from({ length: 12 }, (_, index) => {
  const filename = 'image-' + index + '.png';
  fs.copyFileSync(path.join(attachments, 'local.png'), path.join(attachments, filename));
  return '![Image ' + index + '|450x280](研究笔记.assets/' + filename + ')';
}).join('\n\n'));

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function verifyPrintFrame(frame) {
  const contents = await frame.evaluate(() => {
    const article = document.querySelector('article.note-reading-content');
    return {
      title: document.title, text: article.textContent,
      links: [...article.querySelectorAll('a[data-note-jump]')].map(link => link.hash && !!document.getElementById(link.hash.slice(1))),
      external: article.querySelector('a[href="https://example.com"]')?.href,
      table: article.querySelector('thead th')?.textContent,
      svg: article.querySelector('.note-mermaid-stage svg')?.textContent,
      math: !!article.querySelector('mjx-container'),
      mathFallback: article.querySelector('.md-math-block pre')?.textContent,
      diagramFallback: article.querySelector('.note-mermaid-error pre')?.textContent,
      image: article.querySelector('img[alt="Local image"]')?.naturalWidth,
      missing: article.querySelector('img[alt="Missing image"]')?.parentElement.classList.contains('is-failed'),
      remote: article.querySelector('img[alt="Remote image"]')?.hasAttribute('src'),
      tall: article.querySelector('img[alt="Tall"]')?.getBoundingClientRect().height,
      white: getComputedStyle(document.body).backgroundColor,
      folded: article.querySelector('.md-callout-body').hidden,
    };
  });
  assert.equal(contents.title, note.replace('.md', '.pdf'));
  assert(contents.links.length >= 3 && contents.links.every(Boolean), JSON.stringify(contents.links));
  assert.equal(contents.external, 'https://example.com/');
  assert.equal(contents.table, 'Repeated heading');
  assert.match(contents.svg, /MermaidEnd/);
  assert(contents.math && contents.image && contents.missing && !contents.remote);
  assert.match(contents.mathFallback, /notARealMathCommand/);
  assert.match(contents.diagramFallback, /A\[/);
  assert(contents.tall > 900 && contents.tall < 955, contents.tall);
  assert.equal(contents.white, 'rgb(255, 255, 255)');
  assert(!contents.folded);
  for (const text of ['Shared.canvas', 'Quiz question', 'Tail marker', 'Table row 65']) assert(contents.text.includes(text));
}

(async () => {
  const native = process.argv.includes('--webview2');
  const notesOnly = process.argv.includes('--notes-only');
  const port = await freePort(), debug = native && await freePort();
  const catalog = require('../assets/feature-catalog.json');
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(({ id }) =>
    [id, ['notes', 'notes.mermaid'].includes(id)])) };
  const launcher = native ? [
    '-c',
    'import os,sys,desktop,webview.window; from pathlib import Path; '
      + 'root=Path(os.environ["RELATUM_DATA_ROOT"]); '
      + 'webview.window.Window.create_file_dialog=lambda self,*args,**kw: '
      + 'None if (root/"cancel").exists() else [str(root/"blocked.pdf"/"output.pdf")] if (root/"fail").exists() '
      + 'else [str(root/kw["save_filename"])]; '
      + 'sys.argv=["desktop.py",*sys.argv[1:]]; sys.exit(desktop.main())',
  ] : ['app.py', '--no-browser', '--port', String(port)];
  if (notesOnly) launcher.push('--launch-profile', JSON.stringify(profile));
  const child = spawn(process.env[native ? 'RELATUM_WEBVIEW_PYTHON' : 'RELATUM_PYTHON'] || 'python', ['-B', ...launcher], {
    cwd: path.join(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) },
  });
  let logs = '', browser;
  child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
  const origin = 'http://127.0.0.1:' + port, cdp = 'http://127.0.0.1:' + debug;
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = (await fetch(native ? cdp + '/json/version' : origin + '/api/runtime')).ok; } catch (_) {}
      if (!ready) await pause(100);
    }
    assert(ready, logs);
    let page;
    if (native) {
      browser = await chromium.connectOverCDP(cdp);
      const context = browser.contexts()[0];
      for (let i = 0; i < 100 && !page; i++) { page = context.pages().find(p => p.url().startsWith('http://127.0.0.1')); if (!page) await pause(100); }
    } else {
      browser = await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
      page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    }
    assert(page, logs);
    page.setDefaultTimeout(20000);
    await page.addInitScript(({ note, other }) => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', JSON.stringify([note, other]));
      localStorage.setItem('canvas:noteActiveTab:v1', note);
      localStorage.setItem('canvas:noteActivePath:v1', note);
      localStorage.setItem('canvas:toolbarLanguage', 'zh-CN');
      localStorage.setItem('canvas:startTheme', 'dark');
    }, { note, other });
    let workspace = fs.readFileSync(path.join(__dirname, '../assets/note-workspace.js'), 'utf8').replace(
      '  window.CanvasNoteWorkspace = {', '  window.pdfTest = { state, openNote, setViewMode, get editor() { return liveEditor; } };\n  window.CanvasNoteWorkspace = {');
    if (!native) workspace = workspace
      .replace('frame.contentWindow.print();', 'frame.contentWindow.__didPrint = true;')
      .replace('waitForPdfStep(printing, 300000)', 'waitForPdfStep(printing, window.__printTimeout || 300000)');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(native ? new URL('/?desktop=1', page.url()).href : origin);
    await page.waitForFunction(note => window.pdfTest?.state.current?.path === note && pdfTest.editor, note);
    assert(!requests.some(url => url.includes('note-print.')));
    const menu = page.locator('button[data-note-action="current-menu"]');
    const action = page.locator('button[data-note-action="export-pdf"]');
    async function openMenu(label) {
      await menu.click();
      assert.equal(await action.textContent(), label);
      assert.match(await action.evaluate(button => button.previousElementSibling.textContent), /^(打开|Open)$/);
    }

    if (native) {
      fs.writeFileSync(path.join(root, 'cancel'), '');
      await openMenu('导出成 PDF'); await action.click();
      await pause(350);
      assert(!fs.existsSync(pdf));
      fs.unlinkSync(path.join(root, 'cancel'));
      fs.writeFileSync(path.join(root, 'fail'), '');
      fs.writeFileSync(path.join(root, 'blocked.pdf'), 'existing destination');
      await openMenu('导出成 PDF'); await action.click();
      await page.getByText('导出 PDF 失败，请重试。', { exact: true }).waitFor();
      fs.unlinkSync(path.join(root, 'fail'));
      assert.equal(fs.readFileSync(path.join(root, 'blocked.pdf'), 'utf8'), 'existing destination');
      fs.writeFileSync(pdf, 'old PDF');
      await openMenu('导出成 PDF'); await action.click();
      await page.getByText('部分图片、公式或图表未能渲染，已在 PDF 中保留说明或源码。', { exact: true }).waitFor();
      const output = fs.readFileSync(pdf).toString('latin1');
      assert(output.startsWith('%PDF-') && /\/Count [2-9]\b/.test(output));
      assert(!fs.readdirSync(root).some(name => name.startsWith('.relatum-pdf-')));
      console.log(pdf);
      await page.evaluate(path => pdfTest.openNote(path), imageNote);
      const imagePdf = path.join(root, 'Images.pdf');
      for (let attempt = 0; attempt < 8; attempt++) {
        if (fs.existsSync(imagePdf)) fs.writeFileSync(imagePdf, 'previous output');
        await openMenu('导出成 PDF');
        assert(await action.isEnabled());
        await action.click();
        await page.getByText('PDF 已保存', { exact: true }).waitFor();
        const output = fs.readFileSync(imagePdf).toString('latin1');
        assert(output.startsWith('%PDF-') && /\/Subtype \/Image\b/.test(output));
        assert(!fs.readdirSync(root).some(name => name.startsWith('.relatum-pdf-')));
        assert.equal(browser.contexts()[0].pages().filter(tab => tab.url().includes('/note-print.html')).length, 0);
      }
    } else {
      for (const mode of ['live', 'source', 'reading']) {
        await page.evaluate(mode => pdfTest.setViewMode(mode), mode);
        if (mode === 'source') await page.evaluate(() => {
          const v = pdfTest.editor.view;
          v.dispatch({ changes: { from: 0, insert: 'Unsaved snapshot\n\n' }, selection: { anchor: 2, head: 9 }, userEvent: 'input.type' });
        });
        if (mode === 'reading') await page.evaluate(() => window.RelatumI18n.setLanguage('en'));
        const selection = () => page.evaluate(() => {
          const { anchor, head, scrollTop } = pdfTest.editor.snapshot();
          return { anchor, head, scrollTop };
        });
        const before = await selection();
        await openMenu(mode === 'reading' ? 'Export as PDF' : '导出成 PDF');
        await action.click();
        await page.waitForFunction(() => document.querySelector('iframe[src="note-print.html"]')?.contentWindow.__didPrint);
        const frame = page.frames().find(frame => frame.url().endsWith('/note-print.html'));
        await verifyPrintFrame(frame);
        if (mode === 'source') {
          assert.match(await frame.locator('main').textContent(), /Unsaved snapshot/);
          await openMenu('导出成 PDF');
          assert(await action.isDisabled());
          await menu.click();
          assert.deepEqual(await selection(), before);
          await page.evaluate(other => pdfTest.openNote(other), other);
          assert.doesNotMatch(await frame.locator('main').textContent(), /Other note/);
          await page.evaluate(note => pdfTest.openNote(note), note);
        }
        await page.evaluate(() => document.querySelector('iframe[src="note-print.html"]').contentWindow.dispatchEvent(new Event('afterprint')));
        await page.locator('iframe[src="note-print.html"]').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => pdfTest.state.viewMode), mode);
        if (mode !== 'source') assert.deepEqual(await selection(), before);
      }
      assert(!requests.some(url => url.startsWith('https://example.com')));
      await page.evaluate(path => pdfTest.openNote(path), imageNote);
      await page.route('**/note-print.js', async route => {
        const source = fs.readFileSync(path.join(__dirname, '../assets/note-print.js'), 'utf8');
        await route.fulfill({ contentType: 'text/javascript',
          body: source.replace('const IMAGE_TIMEOUT = 30000;', 'const IMAGE_TIMEOUT = 300;') });
      });
      let stalled = false;
      const holdImage = async route => {
        if (!route.request().frame().url().includes('/note-print.html')
          || !new URL(route.request().url()).searchParams.get('src').endsWith('/image-0.png')) return route.continue();
        stalled = true;
        // Keep a print-only request open until the export timeout tears down its frame.
        await pause(750);
        await route.abort().catch(() => {});
      };
      await page.route('**/api/note-asset?*', holdImage);
      await openMenu('Export as PDF');
      await action.click();
      await openMenu('Export as PDF');
      assert(await action.isDisabled());
      await page.getByText('Images took too long to load. No PDF was created. Try again.').waitFor();
      assert(stalled);
      await action.waitFor();
      assert(await action.isEnabled(), 'an already-open menu unlocks when the export exits');
      await page.locator('iframe[src="note-print.html"]').waitFor({ state: 'detached' });
      await page.unroute('**/api/note-asset?*', holdImage);
      await page.unroute('**/note-print.js');
      await page.evaluate(() => { window.__printTimeout = 500; });
      await action.click();
      await page.waitForFunction(() => document.querySelector('iframe[src="note-print.html"]')?.contentWindow.__didPrint);
      await page.getByText('PDF export timed out. Try again.').waitFor();
      await page.locator('iframe[src="note-print.html"]').waitFor({ state: 'detached' });
      await openMenu('Export as PDF');
      assert(await action.isEnabled(), 'missing afterprint leaves export ready to retry');
      await page.evaluate(() => { window.__printTimeout = 0; });
      await action.click();
      await page.waitForFunction(() => document.querySelector('iframe[src="note-print.html"]')?.contentWindow.__didPrint);
      const retryFrame = page.frames().find(frame => frame.url().endsWith('/note-print.html'));
      assert.equal(await retryFrame.locator('img').evaluateAll(images => images.filter(image => image.naturalWidth > 0).length), 12);
      await page.evaluate(() => document.querySelector('iframe[src="note-print.html"]').contentWindow.dispatchEvent(new Event('afterprint')));
      await page.locator('iframe[src="note-print.html"]').waitFor({ state: 'detached' });
    }
    console.log('Note PDF export verified (' + (native ? 'WebView2' : 'browser') + ')');
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

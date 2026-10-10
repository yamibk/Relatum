'use strict';
// Real Edge + a disposable service/library. No real notes are opened or saved.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = process.env.RELATUM_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-outline-proof-'));
fs.mkdirSync(artifacts, { recursive: true });
const fence = '`'.repeat(3), filler = count => Array.from({ length: count }, (_, i) => '段落 ' + i + '：用于验证章节滚动与定位。\n').join('\n');
const documentSource = [
  '---', 'tags: [Outline]', '# Not a heading', '---', '', '# Fourier Transform', '', filler(12),
  '### Skipped level', '', filler(12), '## Same title', '', filler(12), '## Same title', '', filler(12),
  '#### Four', '##### Five', '###### Six', '',
  fence + 'md', '# Code title', fence, '', '> # Quoted title', '', '> [!note]', '> ## Callout title', '',
  '%%', '# Hidden title', '%%', '', '$$', '# Formula title', '$$', '',
  'Underlined heading', '===', '', filler(12), 'Second underline', '---', '', filler(30),
].join('\n');

async function run(browser, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-outline-')), notes = path.join(root, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'A.md'), documentSource);
  fs.writeFileSync(path.join(notes, 'B.md'), '# Other note\n\n## Child\n\n' + filler(30));
  fs.writeFileSync(path.join(notes, 'Empty.md'), 'Plain note without headings.\n');
  fs.writeFileSync(path.join(notes, 'Big.md'), '# Big\n\n' + 'plain '.repeat(680000) + '\n\n## End\n\n' + filler(30));
  fs.mkdirSync(path.join(notes, 'canvases'));
  fs.writeFileSync(path.join(notes, 'canvases', 'Shared.canvas'), '{"version":2,"nodes":[],"edges":[]}');
  fs.writeFileSync(path.join(notes, 'Media.md'), '# Before canvas\n\n![Shared.canvas|640x360](canvases/Shared.canvas)\n\n## After canvas\n\n' + filler(30));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port, args = ['app.py', '--no-browser', '--port', String(port)];
  if (mode !== 'full') {
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
    const features = Object.fromEntries(catalog.features.map(feature => [feature.id, feature.id === 'notes' || mode === 'notes-only' && feature.id === 'notes.canvas']));
    args.push('--launch-profile', JSON.stringify({ version: 1, features }));
  }
  const server = spawn(process.env.RELATUM_PYTHON || 'python', args, { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    await context.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      if (!localStorage.getItem('canvas:noteOpenTabs:v1')) {
        localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
        localStorage.setItem('canvas:noteActivePath:v1', 'A.md');
      }
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, setViewMode, clearCurrent, closeAllTabs, flushSave, flushNotebookSettings, syncOutline, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    const editor = fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') +
      '\nwindow.outlineScans=0; window.outlineSteps=0; window.outlineMaxStepMs=0; const originalScan=RelatumNoteLiveSyntax.scanNoteHeadings; RelatumNoteLiveSyntax.scanNoteHeadings=function(source){outlineScans++;const scan=originalScan(source); return {next(){const start=performance.now(); const result=scan.next();outlineSteps++;outlineMaxStepMs=Math.max(outlineMaxStepMs,performance.now()-start);return result;}};};';
    await page.route('**/note-live-editor.js*', route => route.fulfill({ contentType: 'text/javascript', body: editor }));
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'A.md' && T.editor);
    assert(!requests.some(value => value.includes('/note-outline.js')), 'cold boot/preload keeps the outline module lazy');
    const outline = page.locator('[data-role="note-outline"]'), labels = outline.locator('.note-outline-title');
    const row = title => outline.locator('.note-outline-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
    const settled = async () => {
      await page.waitForFunction(() => document.querySelector('[data-role="note-outline"]')?.getAttribute('aria-busy') !== 'true'
        && document.querySelector('.note-outline-tree'));
      await pause(160);
    };
    const expected = ['Fourier Transform', 'Skipped level', 'Same title', 'Same title', 'Four', 'Five', 'Six', 'Underlined heading', 'Second underline'];
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.locator('[data-note-action="side-outline"]').click(); await settled();
    assert.deepEqual(await labels.allTextContents(), expected);
    assert.equal(await row('Skipped level').getAttribute('aria-level'), '2', 'skipped levels attach to the nearest smaller heading');
    assert.equal(await outline.locator('[aria-expanded]').count(), 5);
    assert.equal(requests.filter(value => value.includes('/note-outline.js')).length, 1);
    const secondPosition = documentSource.lastIndexOf('## Same title');
    const snapshot = () => page.evaluate(() => T.editor.snapshot());
    const original = await snapshot();
    for (const viewMode of ['live', 'source', 'reading']) {
      await page.evaluate(mode => T.setViewMode(mode), viewMode); await settled();
      await labels.filter({ hasText: /^Same title$/ }).nth(1).click();
      if (viewMode !== 'reading') {
        await page.waitForFunction(position => T.editor.view.state.selection.main.anchor === position, secondPosition);
        assert.equal((await snapshot()).value, original.value, 'navigation leaves Markdown unchanged');
        assert(await page.evaluate(() => T.editor.view.hasFocus), 'editor navigation restores body focus');
      } else {
        const target = page.locator('[data-role="note-reading-view"] [data-note-heading-from="' + secondPosition + '"]');
        assert.equal(await target.textContent(), 'Same title');
        await page.waitForFunction(position => {
          const host = document.querySelector('[data-role="note-reading-view"]'), target = host.querySelector('[data-note-heading-from="' + position + '"]');
          return Math.abs(target.getBoundingClientRect().top - host.getBoundingClientRect().top - 12) < 3;
        }, secondPosition);
        const underlined = page.locator('[data-role="note-reading-view"] h1').filter({ hasText: /^Underlined heading$/ });
        assert.equal(await underlined.count(), 1, 'reading supports Setext H1');
      }
      await page.waitForFunction(position => document.querySelector('.note-outline-row.is-current')?.dataset.outlineFrom === String(position), secondPosition);
    }
    await row('Fourier Transform').locator('.note-outline-toggle').click();
    assert.equal(await row('Fourier Transform').getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(() => document.querySelector('.note-outline-row.is-current')?.getAttribute('aria-label') === 'Fourier Transform');
    await page.evaluate(() => T.openNote('B.md')); await settled();
    assert.deepEqual(await labels.allTextContents(), ['Other note', 'Child']);
    await page.evaluate(() => T.openNote('A.md')); await settled();
    assert.equal(await row('Fourier Transform').getAttribute('aria-expanded'), 'false', 'folds survive switching notes within the session');
    await row('Fourier Transform').locator('.note-outline-toggle').click();
    await row('Fourier Transform').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Skipped level');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Fourier Transform');
    await page.evaluate(() => T.setViewMode('live')); await settled();
    await page.evaluate(() => {
      window.initialOutlineRows = [...document.querySelectorAll('.note-outline-row')];
      T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\n## Unsaved heading\n' }, userEvent: 'input' });
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.note-outline-title')].some(node => node.textContent === 'Unsaved heading'));
    await page.evaluate(() => RelatumCodeMirror.historyKeymap.find(binding => binding.key === 'Mod-z').run(T.editor.view));
    await page.waitForFunction(() => ![...document.querySelectorAll('.note-outline-title')].some(node => node.textContent === 'Unsaved heading'));
    await page.evaluate(() => {
      window.unchangedOutlineRows = [...document.querySelectorAll('.note-outline-row')];
      const position = T.editor.snapshot().value.indexOf('段落');
      T.editor.view.dispatch({ changes: { from: position, insert: '新增正文 ' }, userEvent: 'input' });
    });
    await pause(300); await settled();
    assert(await page.evaluate(() => unchangedOutlineRows.every(node => node.isConnected)), 'body changes reuse unchanged outline rows');
    await page.evaluate(() => T.flushSave());
    await page.evaluate(() => T.flushNotebookSettings());
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/note-notebooks.json'))).ui.mode, 'outline');
    await page.screenshot({ path: path.join(artifacts, 'outline-' + mode + '-light.png') });

    // Chromium's real native preedit leaves the old outline intact until it
    // settles. Its queued navigation maps an unchanged target after insertion.
    if (mode === 'full') {
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() => { T.editor.view.dispatch({ selection: { anchor: 0 } }); T.editor.focus(); });
      await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
      await page.waitForFunction(() => T.editor.inputPending);
      await labels.filter({ hasText: /^Same title$/ }).nth(1).click();
      const selectionBefore = await page.evaluate(() => T.editor.view.state.selection.main.anchor);
      await pause(200);
      assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.anchor), selectionBefore, 'navigation waits for native composition');
      await cdp.send('Input.insertText', { text: '中文' });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await page.waitForFunction(() => !T.editor.inputPending);
      await page.waitForFunction(() => T.editor.view.state.selection.main.anchor === T.editor.snapshot().value.lastIndexOf('## Same title'));
      await cdp.detach();

      const queueInputWait = () => page.evaluate(() => {
        const editor = T.editor, original = editor.whenInputSettled;
        const descriptor = Object.getOwnPropertyDescriptor(editor, 'inputPending');
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        editor.whenInputSettled = () => wait;
        window.releaseOutlineWait = () => {
          editor.whenInputSettled = original; Object.defineProperty(editor, 'inputPending', descriptor); release(true);
        };
        Object.defineProperty(editor, 'inputPending', { configurable: true, get: () => true });
      });

      // A target removed while native input settles cannot reuse a later row.
      await queueInputWait();
      await labels.filter({ hasText: /^Same title$/ }).first().click();
      const deletionSelection = await page.evaluate(() => {
        const source = T.editor.snapshot().value, from = source.indexOf('## Same title');
        T.editor.view.dispatch({ changes: { from, to: from + '## Same title'.length }, userEvent: 'input' });
        return T.editor.view.state.selection.main.anchor;
      });
      await page.evaluate(() => releaseOutlineWait()); await pause(350); await settled();
      assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.anchor), deletionSelection, 'a deleted target cannot move the caret');
      assert.equal(await labels.filter({ hasText: /^Same title$/ }).count(), 1);
      await page.evaluate(() => RelatumCodeMirror.historyKeymap.find(binding => binding.key === 'Mod-z').run(T.editor.view));
      await page.waitForFunction(() => [...document.querySelectorAll('.note-outline-title')].filter(node => node.textContent === 'Same title').length === 2);

      // A queued click cannot jump in a newly selected document.
      await queueInputWait();
      await labels.filter({ hasText: /^Same title$/ }).first().click();
      await page.evaluate(() => { Object.defineProperty(T.editor, 'inputPending', { configurable: true, get: () => false }); window.nextOutlineNote = T.openNote('B.md'); });
      await page.waitForFunction(() => T.state.current?.path === 'B.md');
      await page.evaluate(() => releaseOutlineWait()); await pause(250);
      assert.equal(await page.evaluate(() => T.state.current.path), 'B.md');
      assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.anchor), 0, 'a stale navigation cannot change the new note caret');
      await page.evaluate(() => T.openNote('A.md')); await settled();
    }

    const beforeIdle = await page.evaluate(() => ({ scans: outlineScans, steps: outlineSteps }));
    await page.evaluate(() => { window.outlineMutations = 0; window.outlineObserver = new MutationObserver(records => { outlineMutations += records.length; }); outlineObserver.observe(document.querySelector('[data-role="note-outline"]'), { subtree: true, attributes: true, childList: true }); });
    await pause(700);
    assert.deepEqual(await page.evaluate(() => ({ scans: outlineScans, steps: outlineSteps })), beforeIdle, 'idle outline performs no parsing');
    assert.equal(await page.evaluate(() => outlineMutations), 0, 'idle outline performs no DOM writes');
    await page.evaluate(() => outlineObserver.disconnect());
    await page.locator('[data-note-action="close-links"]').click();
    const suspendedScans = await page.evaluate(() => outlineScans);
    await page.evaluate(() => T.editor.view.dispatch({ changes: { from: T.editor.view.state.doc.length, insert: '\n## Hidden change\n' }, userEvent: 'input' }));
    await pause(350);
    assert.equal(await page.evaluate(() => outlineScans), suspendedScans, 'closed outline does not parse background edits');
    await page.locator('[data-note-action="toggle-notebooks"]').click(); await settled();
    assert(await labels.filter({ hasText: /^Hidden change$/ }).count());

    await page.evaluate(() => T.openNote('Empty.md')); await page.waitForFunction(() => document.querySelector('.note-outline-status')?.textContent === '当前笔记没有标题');
    await page.evaluate(() => T.closeAllTabs()); await page.waitForFunction(() => document.querySelector('.note-outline-status')?.textContent === '打开笔记以查看大纲');
    await page.evaluate(() => T.openNote('A.md')); await settled();
    await row('Fourier Transform').locator('.note-outline-toggle').click();
    await page.evaluate(() => T.flushNotebookSettings());
    await page.reload(); await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'A.md'); await settled();
    assert.equal(await page.locator('[data-note-action="side-outline"]').getAttribute('aria-pressed'), 'true', 'outline preference restores');
    assert.equal(await row('Fourier Transform').getAttribute('aria-expanded'), 'true', 'a new session starts expanded');
    await page.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = 'dark'; });
    await page.setViewportSize({ width: 640, height: 760 }); await settled();
    assert.equal(await page.locator('[data-note-action="side-outline"]').textContent(), 'Outline');
    const layout = await page.evaluate(() => {
      const button = document.querySelector('[data-note-action="side-outline"]'), nav = button.parentElement;
      const close = document.querySelector('[data-note-action="close-links"]');
      return { outline: button.getBoundingClientRect().toJSON(), nav: nav.getBoundingClientRect().toJSON(), close: close.getBoundingClientRect().toJSON() };
    });
    assert(layout.outline.left >= layout.nav.left - 1 && layout.outline.right <= layout.nav.right + 1, 'current English tab remains visible in a narrow sidebar');
    assert(layout.close.left >= layout.nav.right - 1 && layout.close.right <= 640, 'close control stays separate and clickable');
    await page.screenshot({ path: path.join(artifacts, 'outline-' + mode + '-dark-narrow.png') });

    if (mode === 'full') {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => T.openNote('Media.md')); await settled();
      await page.evaluate(() => T.setViewMode('reading')); await settled();
      const mediaPosition = fs.readFileSync(path.join(notes, 'Media.md'), 'utf8').indexOf('## After canvas');
      await labels.filter({ hasText: /^After canvas$/ }).click();
      assert.equal(await page.locator('[data-role="note-reading-view"] [data-note-heading-from="' + mediaPosition + '"]').textContent(), 'After canvas', 'canvas placeholders preserve heading source positions');
      await page.evaluate(() => T.setViewMode('live'));
      await page.evaluate(() => T.openNote('Big.md'));
      try {
        await page.waitForFunction(() => document.querySelector('[data-role="note-outline"]')?.getAttribute('aria-busy') !== 'true'
          && [...document.querySelectorAll('.note-outline-title')].map(node => node.textContent).join('|') === 'Big|End');
      } catch (error) {
        console.log('outline diagnostic:', await page.evaluate(() => ({ path: T.state.current?.path, length: T.editor.view.state.doc.length,
          status: document.querySelector('[data-role="note-outline"]')?.outerHTML.slice(0, 400), scans: outlineScans, steps: outlineSteps,
          error: document.querySelector('[data-role="note-error"]')?.textContent })));
        throw error;
      }
      await settled();
      assert.deepEqual(await labels.allTextContents(), ['Big', 'End']);
      const elapsed = await page.evaluate(() => {
        const view = T.editor.view, start = performance.now();
        view.dispatch({ changes: { from: 20, insert: 'x' }, userEvent: 'input' }); return performance.now() - start;
      });
      assert(elapsed < 250, 'outline does not perform full-document parsing in the synchronous input listener');
      await pause(500); await settled();
      const perf = await page.evaluate(() => ({ maxScanStepMs: outlineMaxStepMs, scans: outlineScans, steps: outlineSteps }));
      fs.writeFileSync(path.join(artifacts, 'outline-performance.json'), JSON.stringify({ dispatchMs: elapsed, ...perf }, null, 2));
      console.log('outline long note:', JSON.stringify({ dispatchMs: elapsed, maxScanStepMs: perf.maxScanStepMs }));
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('note outline browser:', mode, 'ok');
  } finally {
    await context.close(); server.kill(); await pause(250);
    const resolved = path.resolve(root), prefix = path.join(os.tmpdir(), 'relatum-note-outline-');
    assert(resolved.startsWith(prefix), 'cleanup is limited to the generated test root');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of ['full', 'notes-only', 'disabled']) await run(browser, mode); console.log('outline artifacts:', artifacts); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Real Notes workspace, disposable vault, host-provided Playwright/Edge only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-menu-'));
fs.mkdirSync(path.join(root, 'notes'));
fs.writeFileSync(path.join(root, 'notes', 'Main.md'), '复变函数\n电路\n概率论\n');
fs.writeFileSync(path.join(root, 'notes', 'Other.md'), 'Other note');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await sleep(100);
    }
    assert(ready, 'isolated API did not start');
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1300, height: 850 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__noteTestFrames = 0;
      const original = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { window.__noteTestFrames++; return original(callback); };
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__noteMenuTest = {state, openNote, flushSave, setViewMode, makeDocument, cacheDocument, noteStatistics, scheduleStatistics, scheduleDocumentPrefetch, stopExternalSync, checkExternalChanges, triggerExternalSync, resetExternalSyncActivity, externalSyncDelay, uploadImages, get menuContext(){return bodyMenuContext;}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__noteMenuTest?.state.initialized && __noteMenuTest.state.active && !__noteMenuTest.state.openingPath);
    await page.evaluate(() => __noteMenuTest.flushSave());
    await page.waitForFunction(() => window.__noteMenuTest?.state.initialized);
    await page.evaluate(() => __noteMenuTest.openNote('Main.md'));
    const menu = page.locator('[data-role="note-context-menu"]');
    async function set(value, anchor = 0, head = anchor) {
      await page.evaluate(({ value, anchor, head }) => {
        const editor = __noteMenuTest.editor;
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: value },
          selection: RelatumCodeMirror.EditorSelection.range(anchor, head), userEvent: 'input.test' });
      }, { value, anchor, head });
      await page.waitForTimeout(100);
    }
    const value = () => page.evaluate(() => __noteMenuTest.editor.snapshot().value);
    async function openMenu() {
      await page.locator('.cm-content').press('Shift+F10');
      await menu.waitFor({ state: 'visible' });
    }
    async function command(group, name) {
      await openMenu();
      await menu.locator(`:scope > button[data-note-submenu="${group}"]`).hover();
      await menu.locator(`button[data-note-command="${group === 'paragraph' ? 'paragraph' : 'insert'}:${name}"]`).click();
      await menu.waitFor({ state: 'hidden' });
    }
    await set('复变函数\n电路\n概率论\n下段', 0, 12);
    await command('paragraph', 'task');
    assert.equal(await value(), '- [ ] 复变函数\n- [ ] 电路\n- [ ] 概率论\n下段');
    await page.locator('.cm-content').press('Control+z');
    assert.equal(await value(), '复变函数\n电路\n概率论\n下段', 'one undo restores the whole formatting batch');
    await page.locator('.cm-content').press('Control+y');
    assert((await value()).startsWith('- [ ]'));
    await page.evaluate(() => __noteMenuTest.flushSave());
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'Main.md'), 'utf8'), await value());

    await set('- [x] done\n- todo\n\nend', 17, 0);
    await command('paragraph', 'task');
    assert.equal(await value(), '- [x] done\n- [ ] todo\n\nend');
    await set('  - **first**\n  2. *second*\nlast', 0, 27);
    await command('paragraph', 'heading-2');
    assert.equal(await value(), '  ## **first**\n  ## *second*\nlast');
    await command('paragraph', 'heading-2');
    assert.equal(await value(), '  ## **first**\n  ## *second*\nlast', 'repeated heading never stacks markers');
    await command('paragraph', 'quote');
    assert((await value()).startsWith('  > ## **first**'));
    await command('paragraph', 'body');
    assert.equal(await value(), '  **first**\n  *second*\nlast');

    await set('alpha\nbeta', 0, 6); // Ends exactly at the next line's start.
    await command('paragraph', 'ordered');
    assert.equal(await value(), '1. alpha\nbeta');
    await set('alpha\nbeta', 0, 6);
    await command('insert', 'table');
    assert((await value()).startsWith('alpha\n\n| ') && (await value()).endsWith('\n\nbeta'),
      'a selection ending at the next line start inserts before that unselected line');
    for (const protectedText of ['```js\nlet n = 1;\n```', '| A | B |\n| --- | --- |\n| a | b |', '![image](Main.assets/img.png)']) {
      await set(protectedText, 0, protectedText.length);
      await openMenu(); await menu.locator('button[data-note-submenu="paragraph"]').hover();
      assert(await menu.locator('[data-note-command="paragraph:task"]').isDisabled());
      await page.keyboard.press('Escape');
      assert.equal(await value(), protectedText);
    }
    for (const kind of ['table', 'callout', 'rule', 'code-block', 'math']) {
      await set('selected\nend', 0, 8);
      await command('insert', kind);
      const changed = await value();
      assert(changed.includes('selected'), `${kind} preserves selected words`);
      assert(changed.includes({ table: '| --- | --- |', callout: '> [!note]', rule: '\n---', 'code-block': '```', math: '$$' }[kind]));
      await page.locator('.cm-content').press('Control+z');
      assert.equal(await value(), 'selected\nend');
    }
    await set('contains ``` inside', 0, 19);
    await command('insert', 'code-block');
    assert((await value()).includes('````\ncontains ``` inside\n````'));

    await set('copy me', 0, 7);
    await openMenu(); await menu.locator('[data-note-command="copy"]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'copy me');
    await openMenu(); await menu.locator('[data-note-command="cut"]').click();
    await menu.waitFor({ state: 'hidden' }); assert.equal(await value(), '');
    await page.evaluate(() => navigator.clipboard.writeText('**pasted**'));
    await openMenu(); await menu.locator('[data-note-command="paste-plain"]').click();
    await menu.waitFor({ state: 'hidden' }); assert.equal(await value(), '**pasted**');
    await set('must survive', 0, 12);
    await page.evaluate(() => { window.__originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await openMenu(); await menu.locator('[data-note-command="cut"]').click();
    await page.waitForTimeout(100); assert.equal(await value(), 'must survive');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { navigator.clipboard.writeText = __originalWrite; });
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await openMenu(); await menu.locator('[data-note-command="paste"]').click();
    await menu.waitFor({ state: 'hidden' }); assert.equal(await value(), 'must survive', 'empty clipboard must not delete a selection');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    });
    await set('image here', 10);
    await openMenu(); await menu.locator('[data-note-command="paste"]').click();
    await menu.waitFor({ state: 'hidden' });
    assert((await value()).includes('Other.assets') || (await value()).includes('Main.assets'));
    await page.evaluate(() => __noteMenuTest.flushSave());
    assert(fs.existsSync(path.join(root, 'notes', 'Main.assets', 'images')));
    await set('two images', 10);
    await openMenu();
    const imageTransactions = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const view = __noteMenuTest.editor.view, original = view.dispatch.bind(view);
      let changes = 0;
      view.dispatch = (...args) => { const before = view.state.doc; original(...args); if (view.state.doc !== before) changes++; };
      try { await __noteMenuTest.uploadImages([new File([png], 'one.png', {type: 'image/png'}), new File([png], 'two.png', {type: 'image/png'})], __noteMenuTest.menuContext); }
      finally { view.dispatch = original; }
      return changes;
    });
    assert.equal(imageTransactions, 1, 'a menu paste of multiple images must be one document transaction');
    assert.equal(((await value()).match(/!\[/g) || []).length, 2);
    await page.locator('.cm-content').press('Control+z');
    assert.equal(await value(), 'two images');

    // Right-click must leave a native composition alone and never open a format menu.
    await set('输入');
    await page.evaluate(() => __noteMenuTest.editor.focus());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    await page.locator('.cm-content').dispatchEvent('contextmenu', { clientX: 500, clientY: 200 });
    assert(await menu.isHidden());
    await cdp.send('Input.insertText', { text: '拼' });
    await page.waitForTimeout(100);
    assert((await value()).includes('拼') && !(await value()).includes('pin'));

    // Native right click inside a reverse selection, plus viewport avoidance.
    await set('right click keeps this selection', 25, 0);
    const coords = await page.evaluate(() => __noteMenuTest.editor.view.coordsAtPos(5));
    await page.mouse.click(coords.left + 2, coords.top + 3, { button: 'right' });
    await menu.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => __noteMenuTest.editor.view.state.selection.main.anchor), 25);
    assert.equal(await menu.evaluate(el => el.contains(document.activeElement)), false, 'mouse menus keep body focus');
    await page.keyboard.press('Escape');
    await openMenu();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.note-context-submenu:visible').count(), 1);
    await page.screenshot({ path: path.join(root, 'menu-light.png') });
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Escape');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.setViewportSize({ width: 560, height: 420 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await openMenu(); await menu.locator('button[data-note-submenu="paragraph"]').hover();
    const bounds = await page.locator('.note-context-submenu').boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 560 && bounds.y + bounds.height <= 420);
    await page.screenshot({ path: path.join(root, 'menu-dark-narrow.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1300, height: 850 });
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await openMenu(); assert.equal(await menu.locator('button[data-note-submenu="paragraph"]').innerText(), 'Paragraph');
    await page.keyboard.press('Escape');

    // A stale menu cannot apply to another note or a subsequently changed document.
    await openMenu(); await page.evaluate(() => __noteMenuTest.openNote('Other.md'));
    assert(await menu.isHidden());
    await openMenu(); await page.evaluate(() => __noteMenuTest.editor.replaceSelection('new'));
    assert(await menu.isHidden());
    await page.evaluate(() => __noteMenuTest.setViewMode('source'));
    await command('paragraph', 'heading-1');
    assert((await value()).startsWith('# '));
    await page.evaluate(() => __noteMenuTest.setViewMode('reading'));
    assert.equal(await page.locator('[data-role="note-reading-view"] article').count(), 1);
    await page.evaluate(() => __noteMenuTest.setViewMode('live'));
    assert.equal(await page.locator('[data-role="note-reading-view"] *').count(), 0);
    assert.equal(await page.locator('[data-role="note-editor-fallback"]').inputValue(), '');
    assert(await page.evaluate(async () => {
      const previousMath = window.MathJax, host = document.createElement('div'), cleared = [];
      let finish, content;
      document.body.appendChild(host);
      window.MathJax = { typesetPromise(nodes) { content = nodes[0]; return new Promise(resolve => { finish = resolve; }); },
        typesetClear(nodes) { cleared.push(...nodes); } };
      try {
        RelatumNoteLiveEditor.renderMarkdown(host, '$$x^2$$', 'Main.md');
        await Promise.resolve();
        RelatumNoteLiveEditor.releaseReadingDocument(host);
        finish(); await Promise.resolve(); await Promise.resolve();
        return !host.firstChild && cleared.includes(content);
      } finally { window.MathJax = previousMath; host.remove(); }
    }), 'formula records finishing after reading was released must also be cleared');

    // Chinese, astral characters, joiners and image annotations retain the old counting rules.
    await set("中文 don't a--b é foo_bar\n第二行😀");
    await page.waitForFunction(() => __noteMenuTest.state.current.countedGeneration === __noteMenuTest.state.current.editGeneration);
    const counts = await page.evaluate(() => {
      const actual = __noteMenuTest.state.current, expected = __noteMenuTest.noteStatistics(__noteMenuTest.editor.snapshot().value);
      return { actual: [actual.wordCount, actual.characterCount], expected: [expected.words, expected.characters] };
    });
    assert.deepEqual(counts.actual, counts.expected);
    await set(await page.evaluate(() => MarkdownMini.serializeImageBlock(MarkdownMini.parseImageBlock('![i](Other.assets/i.png)'),
      [{ id: 'count-fixture', text: '中文 words😀', x: .5, y: .5, size: 'md', color: 'black' }])));
    await page.waitForFunction(() => __noteMenuTest.state.current.countedGeneration === __noteMenuTest.state.current.editGeneration);
    assert(await page.evaluate(() => {
      const current = __noteMenuTest.state.current, expected = __noteMenuTest.noteStatistics(__noteMenuTest.editor.snapshot().value);
      return current.wordCount === expected.words && current.characterCount === expected.characters;
    }), 'image-text statistics preserve the visible-text counting rules');
    const budgets = await page.evaluate(() => {
      for (let index = 0; index < 30; index++) __noteMenuTest.cacheDocument(__noteMenuTest.makeDocument({ path: `fixture-${index}.md`, content: 'x'.repeat(1024 * 1024) }));
      const documents = [...__noteMenuTest.state.documentCache.values()];
      return { size: documents.length, bytes: documents.reduce((sum, item) => sum + item.content.length * 2, 0), current: documents.includes(__noteMenuTest.state.current) };
    });
    assert(budgets.size <= 24 && budgets.bytes <= 16 * 1024 * 1024 && budgets.current);
    assert(await page.evaluate(() => {
      const dirty = __noteMenuTest.makeDocument({ path: 'dirty-guard.md', content: 'pending'.repeat(200000) });
      dirty.editGeneration++;
      __noteMenuTest.cacheDocument(dirty);
      for (let index = 0; index < 25; index++) __noteMenuTest.cacheDocument(__noteMenuTest.makeDocument({ path: `clean-${index}.md`, content: 'clean'.repeat(200000) }));
      const protectedDraft = __noteMenuTest.state.documentCache.get('dirty-guard.md') === dirty;
      __noteMenuTest.state.documentCache.delete('dirty-guard.md');
      return protectedDraft;
    }), 'a pending inactive draft must survive memory pressure');
    await page.evaluate(() => __noteMenuTest.flushSave());
    await page.route('**/api/note-save', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic save failure"}' }));
    await set('unsaved draft during save failure');
    assert.equal(await page.evaluate(() => __noteMenuTest.flushSave()), false);
    assert(await page.evaluate(async () => {
      for (let index = 0; index < 30; index++) __noteMenuTest.cacheDocument(__noteMenuTest.makeDocument({ path: `failed-save-${index}.md`, content: 'x'.repeat(1024 * 1024) }));
      const current = __noteMenuTest.state.current;
      return !await CanvasNoteWorkspace.deactivate() && __noteMenuTest.state.active
        && __noteMenuTest.state.documentCache.get(current.path) === current
        && current.editGeneration > current.persistedGeneration
        && __noteMenuTest.editor.snapshot().value === 'unsaved draft during save failure';
    }), 'failed saving and memory pressure must retain the active draft and block departure');
    await page.unroute('**/api/note-save');
    assert.equal(await page.evaluate(() => __noteMenuTest.flushSave()), true);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'Other.md'), 'utf8'), 'unsaved draft during save failure');

    // Prefetch only small visible notes, sequentially; leaving stops queued reads.
    let activePrefetch = 0, maxPrefetch = 0, prefetched = 0, hugeReads = 0;
    await page.route('**/api/note?*', async route => {
      const note = new URL(route.request().url()).searchParams.get('path');
      if (note === 'Prefetch-Huge.md') hugeReads++;
      if (!note.startsWith('Prefetch-') || note === 'Prefetch-Huge.md') { await route.continue(); return; }
      activePrefetch++; maxPrefetch = Math.max(maxPrefetch, activePrefetch);
      try { await sleep(60); const response = await route.fetch(); await route.fulfill({ response }); prefetched++; }
      finally { activePrefetch--; }
    });
    fs.writeFileSync(path.join(root, 'notes', 'Prefetch-Huge.md'), 'x'.repeat(600 * 1024));
    for (let index = 0; index < 3; index++) fs.writeFileSync(path.join(root, 'notes', `Prefetch-${index}.md`), 'small');
    await page.evaluate(() => CanvasNoteWorkspace.refresh(false));
    for (let index = 0; index < 40 && prefetched < 3; index++) await sleep(100);
    assert.equal(prefetched, 3); assert.equal(maxPrefetch, 1); assert.equal(hugeReads, 0);
    await page.evaluate(() => {
      for (let index = 0; index < 3; index++) __noteMenuTest.state.documentCache.delete(`Prefetch-${index}.md`);
      __noteMenuTest.scheduleDocumentPrefetch();
    });
    await page.locator('button[data-start-workspace="canvas"]').click();
    await sleep(500); assert.equal(prefetched, 3, 'queued prefetch must not run after departure');
    assert.equal(await page.evaluate(() => __noteMenuTest.state.externalSyncTimer), 0);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => __noteMenuTest.state.active && !__noteMenuTest.state.openingPath);
    await page.evaluate(async () => { await CanvasNoteWorkspace.activate(); await __noteMenuTest.flushSave(); });
    const delays = await page.evaluate(async () => {
      await __noteMenuTest.state.externalSyncChain;
      __noteMenuTest.stopExternalSync();
      __noteMenuTest.state.externalSyncFailures = 0; __noteMenuTest.state.externalSyncUnchanged = 0;
      const delays = [], diagnostics = [];
      for (let index = 0; index < 5; index++) {
        const ok = await __noteMenuTest.checkExternalChanges(false, { background: true, metadataOnly: true }); delays.push(__noteMenuTest.externalSyncDelay());
        diagnostics.push({ok, active:__noteMenuTest.state.active, unchanged:__noteMenuTest.state.externalSyncUnchanged, failures:__noteMenuTest.state.externalSyncFailures, busy:__noteMenuTest.state.imageTextBusy, current:__noteMenuTest.state.current?.path, generation:__noteMenuTest.state.editGeneration});
      }
      __noteMenuTest.resetExternalSyncActivity(); return { delays, diagnostics, reset: __noteMenuTest.externalSyncDelay() };
    });
    assert.equal(delays.delays.at(-1), 30000, JSON.stringify(delays)); assert.equal(delays.reset, 2000);

    // Full-workspace large-document measurements include autosave and the asynchronous statistics.
    const performanceReport = await page.evaluate(async () => {
      const editor = __noteMenuTest.editor, CM = RelatumCodeMirror;
      const source = 'ordinary English words and 中文笔记。\n'.repeat(120000);
      const longTasks = []; const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: source }, selection: CM.EditorSelection.cursor(0) });
      const samples = [];
      for (let index = 0; index < 30; index++) {
        const start = performance.now(); editor.view.dispatch({ changes: { from: index, insert: 'x' }, selection: CM.EditorSelection.cursor(index + 1), userEvent: 'input.type' });
        samples.push(performance.now() - start);
      }
      const saveStart = performance.now(); await __noteMenuTest.flushSave(); const saveMs = performance.now() - saveStart;
      await new Promise(resolve => setTimeout(resolve, 2500)); observer.disconnect();
      return { chars: source.length, typingP95Ms: samples.sort((a,b) => a-b)[28], saveMs, longTasks,
        statisticsComplete: __noteMenuTest.state.current.countedGeneration === __noteMenuTest.state.current.editGeneration,
        nodes: document.querySelectorAll('*').length };
    });
    assert(performanceReport.statisticsComplete);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Performance.enable');
    const memory = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => ['JSHeapUsedSize', 'Nodes', 'Documents'].includes(metric.name));
    const richPerformanceReports = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const measurement = await page.evaluate(async () => {
        const editor = __noteMenuTest.editor;
        const source = '## Heading\n\n**bold** and [link](https://example.com) and [[Main]] $x^2$.\n\n> [!note]\n> A callout.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n'.repeat(8000);
        const longTasks = [], observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)));
        observer.observe({ type: 'longtask', buffered: false });
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: source }, selection: RelatumCodeMirror.EditorSelection.cursor(0) });
        const samples = [];
        for (let index = 0; index < 30; index++) {
          const start = performance.now();
          editor.view.dispatch({ changes: { from: index, insert: 'x' }, selection: RelatumCodeMirror.EditorSelection.cursor(index + 1), userEvent: 'input.type' });
          samples.push(performance.now() - start);
        }
        const saveStart = performance.now(); await __noteMenuTest.flushSave(); const saveMs = performance.now() - saveStart;
        await new Promise(resolve => setTimeout(resolve, 2500)); observer.disconnect();
        return { chars: source.length, typingP95Ms: samples.sort((a,b) => a-b)[28], saveMs, longTasks,
          statisticsComplete: __noteMenuTest.state.current.countedGeneration === __noteMenuTest.state.current.editGeneration,
          nodes: document.querySelectorAll('*').length };
      });
      assert(measurement.statisticsComplete);
      await cdp.send('HeapProfiler.collectGarbage');
      measurement.memory = (await cdp.send('Performance.getMetrics')).metrics.filter(metric => ['JSHeapUsedSize', 'Nodes', 'Documents'].includes(metric.name));
      richPerformanceReports.push(measurement);
    }
    await sleep(1500);
    const beforeFrames = await page.evaluate(() => __noteTestFrames);
    await sleep(2000);
    const idleFrames = await page.evaluate(before => __noteTestFrames - before, beforeFrames);
    assert.equal(idleFrames, 0, 'settled notes must not keep scheduling animation frames');
    await page.locator('button[data-start-workspace="canvas"]').click();
    assert.equal(await page.evaluate(() => __noteMenuTest.state.externalSyncTimer), 0);
    assert.deepEqual(errors, []);
    const report = { root, budgets, delays, counts, prefetch: { prefetched, maxPrefetch, hugeReads }, performanceReport, memory, richPerformanceReports, idleFramesOver2s: idleFrames, errors };
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    service.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

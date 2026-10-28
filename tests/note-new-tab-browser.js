'use strict';
// Real modifier clicks against the local service, using disposable notes only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-new-tab-'));
  const notes = path.join(root, 'notes');
  const original = '# 起点\n\n[[B]]\n\n[[C|别名]]\n\n[[Long#目标标题]]\n\n[[A]]\n\n[[Missinglive]]\n\n[[Missingsource]]\n\n[[Missingreading]]\n\n[[Dup]]\n\n[普通链接](B.md)\n\n末尾\n';
  fs.mkdirSync(path.join(notes, 'one'), { recursive: true });
  fs.mkdirSync(path.join(notes, 'two'));
  for (const [name, content] of Object.entries({ 'A.md': original, 'B.md': '第二篇\n', 'C.md': '第三篇\n',
    'Long.md': '# 开头\n\n' + '一段很长的正文。\n\n'.repeat(80) + '## 目标标题\n\n结束\n',
    'one/Dup.md': '一\n', 'two/Dup.md': '二\n' })) fs.writeFileSync(path.join(notes, name), content);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser, logs = '';
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {}
      if (ready || server.exitCode != null) break;
      await pause(100);
    }
    assert(ready, 'isolated service starts: ' + logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, closeAllTabs, setViewMode, refreshTree, stopExternalSync, stopDocumentPrefetch, get editor(){return liveEditor;}, get wikiTask(){return wikiOpenTask?.promise;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes');
      localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
      localStorage.setItem('canvas:noteActivePath:v1', 'A.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'A.md' && T.editor);
    await page.evaluate(async () => { await T.refreshTree(false); T.stopExternalSync(); T.stopDocumentPrefetch(); });
    const tree = page.locator('[data-role="note-tree"]');
    async function expectTabs(expected, active) {
      await page.waitForFunction(active => CanvasNoteWorkspace.currentPath === active && !CanvasNoteWorkspace.backgroundBusy, active);
      assert.deepEqual(await page.locator('[data-role="note-tabs"] [data-note-tab-path]').evaluateAll(rows => rows.map(row => row.dataset.noteTabPath)), expected);
      assert.equal(await page.locator('.note-tab.active').getAttribute('data-note-tab-path'), active);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteOpenTabs:v1'))), expected);
    }
    async function reset(mode = 'live') {
      await page.evaluate(async mode => { await T.closeAllTabs(); await T.openNote('A.md'); await T.setViewMode(mode); }, mode);
      await expectTabs(['A.md'], 'A.md');
    }
    async function wiki(target, ctrl = true) {
      if (await page.evaluate(() => T.state.viewMode === 'reading')) {
        await page.locator('[data-role="note-reading-view"] [data-wikilink]').filter({ hasText: target === 'C|别名' ? '别名' : target }).first()
          .click({ modifiers: ctrl ? ['Control'] : [] });
      } else {
        // Keep the source visible at the hit position in both live and source mode.
        await page.evaluate(target => {
          const view = T.editor.view, position = view.state.doc.toString().indexOf('[[' + target + ']]') + 2;
          if (position < 2) throw new Error('Missing fixture link: ' + target);
          view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
        }, target);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const coords = await page.evaluate(() => {
          const box = T.editor.view.coordsAtPos(T.editor.view.state.selection.main.head);
          return { x: box.left + 2, y: (box.top + box.bottom) / 2 };
        });
        if (ctrl) await page.keyboard.down('Control');
        try { await page.mouse.click(coords.x, coords.y); } finally { if (ctrl) await page.keyboard.up('Control'); }
      }
      await page.evaluate(() => T.wikiTask);
    }
    await tree.locator('[data-note-path="B.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['A.md', 'B.md'], 'B.md');
    await tree.locator('[data-note-path="A.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['A.md', 'B.md'], 'A.md');
    await tree.locator('[data-note-path="A.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['A.md', 'B.md'], 'A.md');
    await tree.locator('[data-note-path="C.md"]').click();
    await expectTabs(['C.md', 'B.md'], 'C.md');
    const folder = tree.locator('[data-note-path="one"]'), expanded = await folder.getAttribute('aria-expanded');
    await folder.click({ modifiers: ['Control'] });
    assert.notEqual(await folder.getAttribute('aria-expanded'), expanded);
    await expectTabs(['C.md', 'B.md'], 'C.md');
    await reset();
    if (!(await page.locator('.note-workspace').evaluate(node => node.classList.contains('links-overlay-open')))) {
      await page.locator('[data-note-action="toggle-notebooks"]').click();
    }
    await page.locator('[data-note-action="side-notebooks"]').click();
    const notebooks = page.locator('[data-role="note-notebook-tree"]');
    const defaultNotebook = notebooks.locator('[data-note-path=""]');
    if (await defaultNotebook.getAttribute('aria-expanded') !== 'true') await defaultNotebook.locator('.note-tree-toggle').click();
    await notebooks.locator('[data-note-path="B.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['B.md'], 'B.md');
    await page.locator('[data-note-action="close-links"]').click();
    await reset();
    await page.evaluate(() => { T.editor.view.dispatch({ selection: { anchor: T.editor.view.state.doc.length } }); T.editor.replaceSelection('未保存草稿'); });
    await tree.locator('[data-note-path="B.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['A.md', 'B.md'], 'B.md');
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert(fs.readFileSync(path.join(notes, 'A.md'), 'utf8').endsWith('未保存草稿'));
    await page.locator('.note-tab[data-note-tab-path="A.md"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'A.md');
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), original + '未保存草稿', 'returning preserves the saved draft');
    assert.equal(await page.evaluate(() => T.editor.view.state.selection.main.head), original.length + '未保存草稿'.length, 'returning preserves the cursor');
    await page.evaluate(() => { T.editor.focus(); T.editor.replaceSelection('继续编辑'); });
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), original + '未保存草稿', 'editing and undo still work after returning');
    await page.evaluate(from => T.editor.view.dispatch({ changes: { from, to: T.editor.view.state.doc.length, insert: '' } }), original.length);
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert.equal(fs.readFileSync(path.join(notes, 'A.md'), 'utf8'), original);

    for (const mode of ['live', 'source', 'reading']) {
      await reset(mode); await wiki('B'); await expectTabs(['A.md', 'B.md'], 'B.md');
      await page.locator('.note-tab[data-note-tab-path="A.md"]').click();
      await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'A.md');
      await wiki('B'); await expectTabs(['A.md', 'B.md'], 'B.md');
      await reset(mode); await wiki('C|别名'); await expectTabs(['A.md', 'C.md'], 'C.md');
      await reset(mode); await wiki('A'); await expectTabs(['A.md'], 'A.md');
      await reset(mode); await wiki('Long#目标标题'); await expectTabs(['A.md', 'Long.md'], 'Long.md');
      await page.waitForFunction(() => T.state.viewMode === 'reading'
        ? document.querySelector('[data-role="note-reading-view"]').scrollTop > 300
        : T.editor.view.state.selection.main.head === T.editor.view.state.doc.toString().indexOf('## 目标标题'));
      await reset(mode); await wiki('Dup'); await expectTabs(['A.md'], 'A.md');
      assert.equal(fs.existsSync(path.join(notes, 'Dup.md')), false, 'ambiguous target is never created');
      // Each mode exercises creation through its own actual link click.
      const missing = 'Missing' + mode;
      await wiki(missing); await expectTabs(['A.md', missing + '.md'], missing + '.md');
      assert(fs.existsSync(path.join(notes, missing + '.md')));
      await page.locator('.note-tab[data-note-tab-path="A.md"]').click();
      await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'A.md');
      assert.equal(await page.evaluate(() => T.editor.snapshot().value), original, 'creation retains the source document');
    }
    for (const mode of ['live', 'source']) {
      await reset(mode); await wiki('B', false); await expectTabs(['A.md'], 'A.md');
    }
    await reset('reading'); await wiki('B', false); await expectTabs(['B.md'], 'B.md');
    await reset('reading');
    await page.locator('[data-role="note-reading-view"] [data-href="B.md"]').click({ modifiers: ['Control'] });
    await expectTabs(['B.md'], 'B.md');
    assert.deepEqual(errors, []);
    assert.equal(fs.readFileSync(path.join(notes, 'A.md'), 'utf8'), original);
    console.log(JSON.stringify({ result: 'note tree and wiki new tabs: ok', fixtures: root }));
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

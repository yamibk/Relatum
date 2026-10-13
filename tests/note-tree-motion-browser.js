'use strict';

// Actual workspace/CSS in Edge; all API data and storage are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-tree-motion-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const note = (name, parent = '') => ({ kind: 'note', name, fileName: name + '.md',
  path: (parent ? parent + '/' : '') + name + '.md', modifiedNs: 1, createdNs: 1, size: 12 });
const folder = (name, children) => ({ kind: 'folder', name, path: name, children });

async function compare(browser, url) {
  const baseline = execFileSync('git', ['rev-parse', '--verify', (process.env.RELATUM_NOTE_TREE_BASELINE_REF || 'HEAD') + '^{commit}'],
    { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const read = (version, file) => version === 'current' ? fs.readFileSync(path.join(repo, file), 'utf8')
    : execFileSync('git', ['show', baseline + ':' + file], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const samples = [];
  for (const count of [80, 3000]) for (const dpr of [1, 2]) for (const version of ['baseline', 'current']) {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 }, deviceScaleFactor: dpr });
    try {
      const items = Array.from({ length: 20 }, (_, i) => note('Child-' + i, 'Folder'));
      const entries = [folder('Folder', items), ...Array.from({ length: count }, (_, i) => note('N' + i))];
      await page.route('**/api/notes-tree*', route => route.fulfill({ json: { entries,
        pagination: { '': { offset: entries.length, hasMore: false } },
        notebookSettings: { version: 1, colors: {}, ui: { open: false, mode: 'notebooks', selectedRoot: '', expanded: [] } } } }));
      await page.route('**/api/note-children*', async route => {
        await pause(15);
        await route.fulfill({ json: { items, total: items.length, hasMore: false, generation: 1 } });
      });
      let source = read(version, 'assets/note-workspace.js');
      for (const name of ['renderTreeInto', 'rebuildEntryIndex', 'treeOrderSignature', 'sortedTreeEntries']) {
        source = source.replace(new RegExp('(  function ' + name + '\\([^)]*\\) \\{)'), '$1 window.__benchCounts.' + name + '++;');
      }
      source = source.replace('  window.CanvasNoteWorkspace = {',
        '  window.__benchTest = {state,loadDirectory,stopExternalSync,stopDocumentPrefetch};\n  window.CanvasNoteWorkspace = {');
      const windowedSource = read(version, 'assets/windowed-list.js'), cssSource = read(version, 'assets/styles.css');
      await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      await page.route('**/windowed-list.js*', route => route.fulfill({ contentType: 'text/javascript', body: windowedSource }));
      await page.route('**/styles.css*', route => route.fulfill({ contentType: 'text/css', body: cssSource }));
      await page.addInitScript(() => {
        window.__benchCounts = { renderTreeInto: 0, rebuildEntryIndex: 0, treeOrderSignature: 0, sortedTreeEntries: 0, elements: 0, raf: 0 };
        const create = Document.prototype.createElement, raf = window.requestAnimationFrame;
        Document.prototype.createElement = function (...args) { window.__benchCounts.elements++; return create.apply(this, args); };
        window.requestAnimationFrame = function (...args) { window.__benchCounts.raf++; return raf.apply(this, args); };
      });
      await page.goto(url);
      await page.locator('button[data-start-workspace="notes"]').click();
      await page.waitForFunction(() => window.__benchTest?.state.initialized && __benchTest.state.active);
      await page.evaluate(() => { __benchTest.stopExternalSync(); __benchTest.stopDocumentPrefetch(); });
      const toggle = () => page.evaluate(() => document.querySelector('[data-role="note-tree"] [data-note-path="Folder"] .note-tree-toggle').click());
      await toggle(); await pause(340); await toggle(); await pause(340);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      const rounds = [];
      for (let round = 0; round < 3; round++) {
        await page.evaluate(() => { for (const key of Object.keys(__benchCounts)) __benchCounts[key] = 0; });
        const before = await metrics();
        for (let i = 0; i < 8; i++) { await toggle(); await pause(320); }
        const after = await metrics();
        const counters = await page.evaluate(() => ({ ...__benchCounts }));
        rounds.push({ ...counters, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
          layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
          styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          layouts: after.LayoutCount - before.LayoutCount, styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount });
      }
      await page.evaluate(() => { for (const key of Object.keys(__benchCounts)) __benchCounts[key] = 0; });
      for (let i = 0; i < 4; i++) await page.evaluate(() => __benchTest.loadDirectory('Folder'));
      const duplicate = await page.evaluate(() => ({ ...__benchCounts }));
      await pause(350);
      await page.evaluate(() => { __benchCounts.raf = 0; });
      await pause(500);
      const idle = await page.evaluate(() => ({ rafRequests: __benchCounts.raf,
        animations: document.querySelector('[data-role="note-tree"]').getAnimations({ subtree: true }).length,
        mountedRows: document.querySelectorAll('[data-role="note-tree"] .note-tree-row').length }));
      assert.equal(idle.rafRequests, 0, 'tree changes introduce no idle animation loop');
      assert.equal(idle.animations, 0, 'no tree animation survives settling');
      samples.push({ version, count, dpr, rounds, duplicate, idle });
      console.log(JSON.stringify({ version, count, dpr, complete: true }));
    } finally { await page.close(); }
  }
  const median = (rounds, key) => rounds.map(round => round[key]).sort((a, b) => a - b)[1];
  const summary = samples.map(sample => ({ version: sample.version, count: sample.count, dpr: sample.dpr,
    scriptMs: median(sample.rounds, 'scriptMs'), layoutMs: median(sample.rounds, 'layoutMs'),
    styleMs: median(sample.rounds, 'styleMs'), taskMs: median(sample.rounds, 'taskMs'),
    elements: median(sample.rounds, 'elements'), indexBuilds: median(sample.rounds, 'rebuildEntryIndex'),
    orderSignatures: median(sample.rounds, 'treeOrderSignature'), sorts: median(sample.rounds, 'sortedTreeEntries'),
    duplicateRenders: sample.duplicate.renderTreeInto, ...sample.idle }));
  const report = { baseline, browser: browser.version(), togglesPerRound: 8, rounds: 3,
    viewport: { width: 1300, height: 850 }, summary, samples };
  if (process.env.RELATUM_NOTE_TREE_REPORT) fs.writeFileSync(process.env.RELATUM_NOTE_TREE_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'note tree comparison: ok', baseline, summary }));
}

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
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await pause(100);
    }
    assert(ready, 'isolated API did not start');
    browser = await chromium.launch({ headless: true,
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    if (process.argv.includes('--compare')) { await compare(browser, url); return; }
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const entries = [folder('Existing', [note('A', 'Existing'), note('B', 'Existing')]),
      folder('Lazy', []), note('Unrelated')];
    const children = new Map([['Existing', entries[0].children], ['Lazy', [note('Loaded', 'Lazy')]]]);
    const delay = 35;
    await page.route('**/api/notes-tree*', route => route.fulfill({ json: { version: 1, entries,
      pagination: { '': { offset: 3, hasMore: false } },
      notebookSettings: { version: 1, colors: {}, ui: { open: false, mode: 'notebooks', selectedRoot: '', expanded: [] } } } }));
    await page.route('**/api/note-children*', async route => {
      const parent = new URL(route.request().url()).searchParams.get('parent');
      const items = children.get(parent) || [];
      await pause(delay);
      await route.fulfill({ json: { items, hasMore: false, total: items.length, generation: 1 } });
    });
    await page.route('**/api/note?*', route => route.fulfill({ json: {
      path: new URL(route.request().url()).searchParams.get('path'), content: '示例正文。\n\n文件树开合保留当前笔记。', revision: 'fixture',
    } }));
    let source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    for (const name of ['renderTreeInto', 'rebuildEntryIndex', 'treeOrderSignature']) {
      source = source.replace(new RegExp('(  function ' + name + '\\([^)]*\\) \\{)'),
        '$1 window.__motionCounts.' + name + '++;');
    }
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__motionTest = {state,treeRowIndexes,directoryLoads,loadDirectory,renderTree,stopExternalSync,stopDocumentPrefetch};\n  window.CanvasNoteWorkspace = {');
    await page.addInitScript(() => { window.__motionCounts = { renderTreeInto: 0, rebuildEntryIndex: 0, treeOrderSignature: 0 }; });
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__motionTest?.state.initialized && __motionTest.state.active);
    await page.evaluate(() => { __motionTest.stopExternalSync(); __motionTest.stopDocumentPrefetch(); });
    const left = '[data-role="note-tree"]', right = '[data-role="note-notebook-tree"]';
    const row = (tree, path) => page.locator(`${tree} .note-tree-row[data-note-path="${path}"]`);
    const loadsDone = () => page.waitForFunction(() => !__motionTest.directoryLoads.size);
    const settle = () => page.waitForTimeout(320);
    async function indexes() {
      assert.deepEqual(await page.evaluate(() => {
        const issues = [];
        __motionTest.treeRowIndexes.forEach((index, tree) => {
          const rows = Array.from(tree.querySelectorAll('.note-tree-row'));
          if (index.rows.size !== rows.length) issues.push('row count');
          for (const row of rows) if (index.rows.get(row.dataset.notePath) !== row) issues.push('unindexed row');
          for (const row of index.rows.values()) if (!tree.contains(row)) issues.push('detached row');
        });
        return issues;
      }), [], 'indices contain exactly the mounted rows');
    }
    async function click(tree, path) {
      await row(tree, path).evaluate(element => element.querySelector('.note-tree-toggle').click());
    }
    await row(left, 'Existing').evaluate(element => { window.__folderRow = element; window.__unrelatedRow = element.parentElement.parentElement.querySelector('[data-note-path="Unrelated.md"]'); });
    await click(left, 'Existing');
    await page.evaluate(() => { window.__shell = __folderRow.parentElement.querySelector('.note-tree-children-shell'); });
    await loadsDone();
    assert.equal(await row(left, 'Existing').evaluate(element => element === __folderRow), true,
      'a directory response must not replace the rotating arrow');
    assert.equal(await page.evaluate(() => __shell.isConnected), true,
      'the child transition survives a directory response');
    assert.equal(await row(left, 'Unrelated.md').evaluate(element => element === __unrelatedRow), true,
      'directory loading preserves unrelated rows');
    await settle();
    const duplicate = await page.evaluate(async () => {
      for (const key of Object.keys(__motionCounts)) __motionCounts[key] = 0;
      await __motionTest.loadDirectory('Existing');
      return { ...__motionCounts };
    });
    assert.deepEqual(duplicate, { renderTreeInto: 0, rebuildEntryIndex: 0, treeOrderSignature: 0 },
      'an identical directory page does not repeat rendering, indexing or sorting');
    await click(left, 'Existing'); await settle();
    children.set('Existing', [...children.get('Existing'), note('New', 'Existing')]);
    await page.evaluate(() => { delete __motionTest.state.treePagination.Existing; });
    await click(left, 'Existing'); await loadsDone();
    assert.equal(await page.evaluate(() => __folderRow.isConnected && __shell !== __folderRow.parentElement.querySelector('.note-tree-children-shell')), true);
    await page.evaluate(() => { window.__shell = __folderRow.parentElement.querySelector('.note-tree-children-shell'); });
    assert.equal(await row(left, 'Unrelated.md').evaluate(element => element === __unrelatedRow), true);
    assert.equal(await row(left, 'Existing/New.md').count(), 1, 'new directory children appear without replacing their folder');
    assert.equal(await page.evaluate(() => __shell.getAnimations().some(animation => animation.playState === 'running')), true,
      'a changed directory page also preserves the running expansion');
    await settle();
    // The first close's cleanup must not finish a later close prematurely.
    await page.evaluate(async () => {
      const toggle = __folderRow.querySelector('.note-tree-toggle');
      toggle.click(); await new Promise(resolve => setTimeout(resolve, 65));
      toggle.click(); await new Promise(resolve => setTimeout(resolve, 65));
      toggle.click(); await new Promise(resolve => requestAnimationFrame(resolve));
      __shell.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'grid-template-rows', elapsedTime: .22, bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 145));
    });
    assert.equal(await page.evaluate(() => __shell.isConnected), true, 'rapid reversal invalidates the first close task');
    await settle();
    assert.equal(await row(left, 'Existing/A.md').count(), 0);
    await click(left, 'Lazy'); await loadsDone();
    const reveal = await row(left, 'Lazy').evaluate(async element => {
      const shell = element.parentElement.querySelector('.note-tree-children-shell');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { height: shell.getBoundingClientRect().height, full: shell.firstChild.scrollHeight,
        running: shell.getAnimations().some(animation => animation.playState === 'running') };
    });
    assert(reveal.running && reveal.height < reveal.full, 'a lazily loaded child starts a real CSS expansion');
    await settle(); await indexes();
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await click(right, ''); await loadsDone(); await settle();
    await row(right, 'Existing').evaluate(element => { window.__rightFolder = element; });
    await click(right, 'Existing'); await settle();
    assert.equal(await row(right, 'Existing').evaluate(element => element === __rightFolder), true);
    assert.equal(await row(left, 'Existing').getAttribute('aria-expanded'), 'false', 'two trees keep independent expansion');
    await indexes();
    async function reset(count) {
      await page.evaluate(count => {
        const state = __motionTest.state;
        const make = (i, parent = '') => ({ kind: 'note', name: 'N' + i, path: parent + 'N' + i + '.md', size: 12 });
        state.entries = [{ kind: 'folder', name: 'Big', path: 'Big', children: Array.from({ length: 30 }, (_, i) => make(i, 'Big/')) },
          ...Array.from({ length: count }, (_, i) => make(i))];
        state.expanded = new Set(); state.notebookExpanded = new Set();
        state.treePagination = { '': { hasMore: false }, Big: { hasMore: false } };
        __motionTest.renderTree();
      }, count);
      await settle();
    }
    for (const count of [3000, 190]) {
      await reset(count);
      await row(left, 'Big').evaluate(element => {
        window.__bigFolder = element; element.focus(); getComputedStyle(element.querySelector('.note-tree-toggle'), '::before').transform;
      });
      await click(left, 'Big');
      assert.equal(await row(left, 'Big').evaluate(element => element === __bigFolder), true, 'windowed expansion preserves its arrow');
      const arrow = await row(left, 'Big').evaluate(async element => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const toggle = element.querySelector('.note-tree-toggle');
        const style = getComputedStyle(toggle, '::before');
        return { expanded: element.getAttribute('aria-expanded'), transform: style.transform,
          duration: style.transitionDuration, running: toggle.getAnimations({ subtree: true }).some(animation => animation.playState === 'running') };
      });
      assert(arrow.running, 'a windowed folder keeps a real arrow transition: ' + JSON.stringify({ count, ...arrow }));
      await settle();
      assert(await page.locator(`${left} .note-tree-row`).count() < 160, 'large trees keep a bounded mounted viewport');
      await click(left, 'Big');
      assert.equal(await row(left, 'Big').evaluate(element => element === __bigFolder && document.activeElement === element), true,
        'windowed collapse/threshold crossings keep the arrow and keyboard focus');
      await settle(); await indexes();
      await page.evaluate(() => {
        __motionTest.state.renamePath = 'Big'; __motionTest.state.renameOriginal = 'Big';
        __motionTest.state.renameDraft = 'Big'; __motionTest.renderTree();
      });
      await page.locator(`${left} .note-tree-rename`).waitFor();
      await page.locator(`${left} .note-tree-rename`).press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-role="note-tree"] .note-tree-rename'));
      await indexes();
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await click(left, 'Big'); await click(left, 'Big');
    assert.equal(await row(left, 'Big').getAttribute('aria-expanded'), 'false');
    assert.equal(await row(left, 'Big').evaluate(element => getComputedStyle(element.querySelector('.note-tree-toggle'), '::before').transitionDuration), '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await click(left, 'Big');
    await page.locator('[data-note-action="close-links"]').click(); await settle();
    assert.equal(await page.locator(right).evaluate(element => element.childNodes.length), 0);
    assert.equal(await page.locator(right).evaluate(element => !!element.__noteWindow || !!element.__noteTreeRender), false,
      'closing the sidebar releases its list/controller');
    await reset(2); await click(left, 'Big'); await settle();
    await row(left, 'Big/N0.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Big/N0.md');
    await page.evaluate(() => { __motionTest.stopExternalSync(); __motionTest.stopDocumentPrefetch(); });
    async function screenshot(name) {
      if (!process.env.RELATUM_ARTIFACT_DIR) return;
      fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR, name + '.png') });
    }
    await screenshot('note-tree-light');
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await click(left, 'Big'); await settle(); await click(left, 'Big'); await settle();
    await screenshot('note-tree-dark');
    await page.setViewportSize({ width: 700, height: 700 });
    await page.locator('[data-note-action="toggle-tree"]').first().click();
    await click(left, 'Big'); await settle(); await click(left, 'Big'); await settle();
    await screenshot('note-tree-narrow');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await click(left, 'Big');
    assert.equal(await row(left, 'Big/N0.md').count(), 0, 'reduced motion removes the compact subtree immediately');
    await click(left, 'Big');
    assert.equal(await row(left, 'Big/N0.md').count(), 1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await click(left, 'Big');
    await page.evaluate(() => {
      document.documentElement.dataset.desktopMinimized = '1';
      window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
    });
    assert.equal(await row(left, 'Big/N0.md').count(), 0, 'minimizing finishes an in-flight collapse immediately');
    await settle();
    assert.equal(await page.locator(left).evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), 0,
      'minimizing leaves no running tree animations');
    await indexes();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'note tree motion: ok', duplicate, reveal, windowedCounts: [3000, 190] }));
  } finally {
    if (browser) await browser.close();
    service.kill();
    await new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-tree-motion-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

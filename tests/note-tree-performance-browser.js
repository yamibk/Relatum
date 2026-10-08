'use strict';

// Real workspace with synthetic trees; no user notes are read or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-tree-perf-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let entries = Array.from({ length: 3000 }, (_, i) => {
      const name = 'Perf-' + String(i).padStart(4, '0');
      return { kind: 'note', name, fileName: name + '.md', path: name + '.md', modifiedNs: 1, createdNs: 1, size: 12 };
    });
    await page.route('**/api/notes-tree*', route => route.fulfill({ json: { version: 1, entries,
      notebookSettings: { version: 1, colors: {}, ui: { open: false, mode: 'notebooks', selectedRoot: '', expanded: [] } } } }));
    await page.route('**/api/note?*', route => route.fulfill({ json: {
      path: new URL(route.request().url()).searchParams.get('path'), content: 'A small note', revision: 'fixture',
    } }));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.__treePerf = {state,treeRowIndexes,updateTreeSelection,refreshTree,stopExternalSync,stopDocumentPrefetch,makeDocument,cacheDocument,openNote};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__treePerf?.state.initialized && __treePerf.state.active);
    await page.evaluate(() => { __treePerf.stopExternalSync(); __treePerf.stopDocumentPrefetch(); });
    const report = await page.evaluate(async () => {
      const test = __treePerf, host = document.querySelector('.note-workspace');
      let scans = 0;
      const queries = new Map([host, ...test.treeRowIndexes.keys()].map(element => [element, element.querySelectorAll]));
      queries.forEach((query, element) => {
        element.querySelectorAll = function (selector) { if (selector === '.note-tree-row') scans++; return query.call(this, selector); };
      });
      const observer = new MutationObserver(() => {});
      for (const tree of test.treeRowIndexes.keys()) observer.observe(tree, { attributes: true, subtree: true });
      const times = [], switches = [];
      try {
        for (let i = 0; i < 40; i++) {
          test.state.openingPath = i % 2 ? 'Perf-0000.md' : 'Perf-0001.md';
          const start = performance.now(); test.updateTreeSelection(); times.push(performance.now() - start);
        }
        const changedWrites = observer.takeRecords().length;
        for (let i = 0; i < 40; i++) test.updateTreeSelection();
        const unchangedWrites = observer.takeRecords().length;
        test.state.openingPath = ''; test.updateTreeSelection();
        for (const path of ['Perf-0000.md', 'Perf-0001.md']) test.cacheDocument(test.makeDocument({ path, content: 'A small note', revision: 'fixture' }));
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          await test.openNote(i % 2 ? 'Perf-0000.md' : 'Perf-0001.md', { noFocus: true, noRecent: true, skipSave: true });
          switches.push(performance.now() - start);
        }
        times.sort((a, b) => a - b); switches.sort((a, b) => a - b);
        return { rows: 3000, selectionMedianMs: times[20], selectionP95Ms: times[37],
          cachedSwitchMedianMs: switches[10], cachedSwitchP95Ms: switches[18], scans, changedWrites, unchangedWrites };
      } finally { queries.forEach((query, element) => { element.querySelectorAll = query; }); observer.disconnect(); test.stopExternalSync(); test.stopDocumentPrefetch(); }
    });
    assert.equal(report.scans, 0, 'selection and cached switches cannot scan all tree rows');
    assert.equal(report.unchangedWrites, 0, 'unchanged selection cannot write DOM');
    assert(report.changedWrites < 500, 'only old and new selected rows are written');
    async function checkIndexes() {
      assert.deepEqual(await page.evaluate(() => {
        const issues = [];
        __treePerf.treeRowIndexes.forEach((index, tree) => {
          const rows = Array.from(tree.querySelectorAll('.note-tree-row'));
          if (index.rows.size !== rows.length) issues.push('row count');
          for (const row of rows) if (index.rows.get(row.dataset.notePath) !== row) issues.push('unindexed row');
          for (const row of index.rows.values()) if (!tree.contains(row)) issues.push('detached row');
        });
        return issues;
      }), [], 'indices contain exactly the mounted rows');
    }
    const folder = { kind: 'folder', name: 'Nested', path: 'Nested', children: [
      { kind: 'note', name: 'Child', fileName: 'Child.md', path: 'Nested/Child.md', modifiedNs: 1, createdNs: 1, size: 12 },
    ] };
    entries.push(folder);
    await page.evaluate(() => __treePerf.refreshTree());
    const left = '[data-role="note-tree"]', right = '[data-role="note-notebook-tree"]';
    const row = (tree, path) => page.locator(`${tree} .note-tree-row[data-note-path="${path}"]`);
    await row(left, 'Nested').click(); await checkIndexes();
    await row(left, 'Nested/Child.md').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Nested/Child.md');
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await row(right, '').locator('.note-tree-toggle').click();
    await row(right, 'Nested').click(); await checkIndexes();
    for (const tree of [left, right]) {
      assert.equal(await row(tree, 'Nested/Child.md').getAttribute('aria-current'), 'page');
      assert.equal(await row(tree, 'Nested').evaluate(el => el.classList.contains('active-ancestor')), true);
    }
    await row(right, '').locator('.note-tree-toggle').click(); await checkIndexes();
    await page.locator('[data-note-action="toggle-notebooks"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="note-notebook-tree"]').childNodes.length);
    await checkIndexes();
    assert.equal(await page.evaluate(() => __treePerf.treeRowIndexes.get(document.querySelector('[data-role="note-notebook-tree"]')).rows.size), 0, 'closing the sidebar releases every indexed row');
    await page.locator('[data-note-action="toggle-notebooks"]').click(); await checkIndexes();
    assert.equal(await row(right, '').count(), 1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (let i = 0; i < 3; i++) await row(left, 'Nested').click();
    await pause(350); await checkIndexes();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (await row(left, 'Nested').getAttribute('aria-expanded') !== 'true') await row(left, 'Nested').click();
    await row(left, 'Nested').click(); await checkIndexes();
    assert.equal(await row(left, 'Nested/Child.md').count(), 0);
    entries = entries.filter(entry => entry.path !== 'Nested');
    await page.evaluate(() => __treePerf.refreshTree()); await checkIndexes();
    assert.equal(await row(left, 'Nested').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'note tree performance and lifecycle: ok', ...report }));
  } finally {
    if (browser) await browser.close();
    service.kill();
    await new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-tree-perf-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

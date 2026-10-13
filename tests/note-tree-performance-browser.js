'use strict';

// Real workspace with synthetic trees; no user notes are read or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-tree-perf-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function compareSorting(page, browser) {
  const baseline = process.env.RELATUM_NOTE_TREE_BASELINE_REF || '60f9941f7cc90309ca922462d4b5defba60fc291';
  const oldSource = execFileSync('git', ['show', baseline + ':assets/note-workspace.js'], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const names = ['isNotebookContainer', 'nameCompare', 'sortedTreeEntries', 'naturalSort', 'notebookRoots'];
  const declarations = names.map(name => {
    const match = oldSource.match(new RegExp('  function ' + name + '\\([^\\n]*\\) \\{(?:[^\\n]*\\}|[\\s\\S]*?\\n  \\})'));
    assert(match, 'missing baseline function: ' + name); return match[0];
  }).join('\n');
  const samples = await page.evaluate(declarations => {
    const test = __treePerf, savedSort = test.state.treeSort, savedEntries = test.state.entries, savedLanguage = RelatumI18n.language;
    const old = new Function('state', 'language', 'const NOTEBOOK_CONTAINER = "CustomNotebook";\n' + declarations + '\nreturn {sortedTreeEntries,naturalSort,notebookRoots};')
      (test.state, () => RelatumI18n.language === 'en' ? 'en' : 'zh-CN');
    const samples = [], labels = ['笔记', 'Note', 'École', 'école', 'e\u0301cole', '文件', '目录', '😀', 'A', 'a', '甲'];
    const paths = entries => JSON.stringify(entries.map(entry => entry.path));
    try {
      for (const locale of ['zh-CN', 'en', 'zh-CN']) {
        RelatumI18n.setLanguage(locale);
        for (const count of [1000, 3000, 10000]) {
          let seed = 1234567;
          const entries = Array.from({ length: count }, (_, i) => ({ kind: i % 17 ? 'note' : 'folder', name: labels[i % labels.length] + (i % 137),
            path: 'Fixture/' + i + '.md', modifiedNs: i % 13, createdNs: i % 7, children: [] }));
          for (let i = entries.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [entries[i], entries[j]] = [entries[j], entries[i]]; }
          for (const mode of ['name-asc', 'name-desc', 'modified-desc', 'modified-asc', 'created-desc', 'created-asc']) {
            test.state.treeSort = mode;
            if (paths(test.sortedTreeEntries(entries)) !== paths(old.sortedTreeEntries(entries))) throw new Error('Sort order changed: ' + locale + '/' + mode + '/' + count);
          }
          const currentNatural = entries.slice(), oldNatural = entries.slice(); test.naturalSort(currentNatural); old.naturalSort(oldNatural);
          if (paths(currentNatural) !== paths(oldNatural)) throw new Error('Merge order changed');
          test.state.entries = [{ kind: 'folder', path: 'CustomNotebook', children: entries.map(entry => ({ ...entry, kind: 'folder' })) }];
          if (paths(test.notebookRoots()) !== paths(old.notebookRoots())) throw new Error('Notebook order changed');
          test.state.entries = savedEntries; test.state.treeSort = 'name-asc';
          const rounds = [], constructors = window.__treeSortCollators;
          for (let round = 0; round < 3; round++) {
            const result = {};
            for (const version of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
              const start = performance.now(); (version === 'current' ? test : old).sortedTreeEntries(entries); result[version + 'Ms'] = performance.now() - start;
            }
            rounds.push(result);
          }
          if (window.__treeSortCollators !== constructors) throw new Error('Repeated sorting recreated the collator');
          samples.push({ locale, count, rounds, repeatedCollatorBuilds: window.__treeSortCollators - constructors });
        }
        test.state.treeSort = savedSort;
      }
      return samples;
    } finally { test.state.entries = savedEntries; test.state.treeSort = savedSort; RelatumI18n.setLanguage(savedLanguage); }
  }, declarations);
  const median = (rounds, key) => rounds.map(round => round[key]).sort((a, b) => a - b)[1];
  const report = { baseline, browser: browser.version(), status: 'note sorting compatibility and performance: ok', samples,
    summary: samples.map(sample => ({ locale: sample.locale, count: sample.count, baselineMs: median(sample.rounds, 'baselineMs'), currentMs: median(sample.rounds, 'currentMs'), repeatedCollatorBuilds: sample.repeatedCollatorBuilds })) };
  if (process.env.RELATUM_NOTE_TREE_REPORT) fs.writeFileSync(process.env.RELATUM_NOTE_TREE_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, samples: undefined }));
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
    let source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    for (const [name, counter] of [['rebuildEntryIndex', '__treePerfIndexBuilds'], ['treeOrderSignature', '__treePerfOrderSignatures']]) {
      const declaration = new RegExp('(  function ' + name + '\\([^)]*\\) \\{)');
      assert(declaration.test(source), 'missing tree instrumentation target: ' + name);
      source = source.replace(declaration, '$1 window.' + counter + ' = (window.' + counter + ' || 0) + 1;');
    }
    source = source.replace('  window.CanvasNoteWorkspace = {',
      '  window.__treePerf = {state,treeRowIndexes,updateTreeSelection,refreshTree,stopExternalSync,stopDocumentPrefetch,makeDocument,cacheDocument,openNote,flattenEntries,treeOrderSignature,sortedTreeEntries,naturalSort,notebookRoots};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    if (process.argv.includes('--sorting-only')) await page.addInitScript(() => {
      window.__treeSortCollators = 0;
      Intl.Collator = new Proxy(Intl.Collator, { construct(target, args) { window.__treeSortCollators++; return Reflect.construct(target, args); } });
    });
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.__treePerf?.state.initialized && __treePerf.state.active);
    await page.evaluate(() => { __treePerf.stopExternalSync(); __treePerf.stopDocumentPrefetch(); });
    if (process.argv.includes('--sorting-only')) { await compareSorting(page, browser); assert.deepEqual(errors, []); return; }
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
    const refreshReports = [];
    async function refreshOnce(label, { reuseRows = false, firstPath = '' } = {}) {
      const result = await page.evaluate(async () => {
        const test = __treePerf, state = test.state;
        const tree = document.querySelector('[data-role="note-tree"]');
        const previousEntries = state.entries, previousCurrent = state.current;
        const previousRows = Array.from(tree.querySelectorAll('.note-tree-row'));
        window.__treePerfIndexBuilds = 0; window.__treePerfOrderSignatures = 0;
        const ok = await test.refreshTree(false, { background: true });
        test.stopExternalSync(); test.stopDocumentPrefetch();
        const indexBuilds = window.__treePerfIndexBuilds, orderSignatures = window.__treePerfOrderSignatures;
        const flat = test.flattenEntries(state.entries, []);
        const rows = Array.from(tree.querySelectorAll('.note-tree-row'));
        return {
          ok, indexBuilds, orderSignatures, entriesReplaced: previousEntries !== state.entries,
          latestEntriesIndexed: state.entryIndex.size === flat.length && flat.every(entry => state.entryIndex.get(entry.path) === entry),
          metadataMatches: state.treeMetadataSignature === JSON.stringify(flat.map(entry => [entry.path, entry.modifiedNs, entry.size, entry.revision])),
          orderMatches: state.renderedOrder === test.treeOrderSignature(state.entries),
          reusedRows: rows.length === previousRows.length && rows.every((row, index) => row === previousRows[index]),
          currentPreserved: state.current === previousCurrent,
          selectedPath: rows.find(row => row.getAttribute('aria-current') === 'page')?.dataset.notePath || '',
          firstPath: rows[0]?.dataset.notePath || '', cachedPaths: Array.from(state.documentCache.keys()),
        };
      });
      assert.equal(result.ok, true, label + ': refresh succeeds');
      assert.equal(result.indexBuilds, 1, label + ': rebuild the path index once, including any tree rendering');
      assert.equal(result.orderSignatures, 1, label + ': reuse the calculated order when rendering');
      assert.equal(result.entriesReplaced, true, label + ': adopt the latest API entries');
      assert.equal(result.latestEntriesIndexed, true, label + ': index points to this response, never stale entry objects');
      assert.equal(result.metadataMatches, true, label + ': metadata signature covers the latest flattened tree');
      assert.equal(result.orderMatches, true, label + ': rendered order follows the selected sort');
      assert.equal(result.currentPreserved, true, label + ': keep the current document session');
      assert.equal(result.selectedPath, 'Perf-0000.md', label + ': keep the active selection');
      if (reuseRows) assert.equal(result.reusedRows, true, label + ': unchanged rows keep DOM identity');
      if (firstPath) assert.equal(result.firstPath, firstPath, label + ': update the visible order');
      refreshReports.push({ label, indexBuilds: result.indexBuilds, orderSignatures: result.orderSignatures, reusedRows: result.reusedRows });
      await checkIndexes();
      return result;
    }
    await refreshOnce('unchanged', { reuseRows: true, firstPath: 'Perf-0000.md' });
    entries.find(entry => entry.path === 'Perf-0001.md').size += 1;
    const metadataRefresh = await refreshOnce('metadata only', { reuseRows: true, firstPath: 'Perf-0000.md' });
    assert(!metadataRefresh.cachedPaths.includes('Perf-0001.md'), 'changed noncurrent metadata invalidates its document cache');
    assert(metadataRefresh.cachedPaths.includes('Perf-0000.md'), 'unchanged current document remains cached');
    entries.find(entry => entry.path === 'Perf-0001.md').modifiedNs = 2;
    const reordered = await refreshOnce('metadata reorder', { firstPath: 'Perf-0001.md' });
    assert.equal(reordered.reusedRows, false, 'modified-date reorder updates the tree DOM');
    await page.evaluate(() => {
      __treePerf.cacheDocument(__treePerf.makeDocument({ path: 'Perf-2999.md', content: 'A cached deleted note', revision: 'fixture' }));
      __treePerf.state.selectedPath = 'Perf-2999.md';
    });
    entries = entries.filter(entry => entry.path !== 'Perf-2999.md');
    const deleted = await refreshOnce('delete', { firstPath: 'Perf-0001.md' });
    assert(!deleted.cachedPaths.includes('Perf-2999.md'), 'deleted noncurrent note is removed from the document cache');
    assert.equal(await page.evaluate(() => __treePerf.state.selectedPath), '', 'delete prunes the old selected path');
    const folder = { kind: 'folder', name: 'Nested', path: 'Nested', children: [
      { kind: 'note', name: 'Child', fileName: 'Child.md', path: 'Nested/Child.md', modifiedNs: 1, createdNs: 1, size: 12 },
    ] };
    entries.push(folder);
    await refreshOnce('add folder and note', { firstPath: 'Nested' });
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
    console.log(JSON.stringify({ status: 'note tree performance and lifecycle: ok', ...report, refreshReports }));
  } finally {
    if (browser) await browser.close();
    service.kill();
    await new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('relatum-note-tree-perf-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

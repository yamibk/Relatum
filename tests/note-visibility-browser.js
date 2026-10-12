'use strict';
// Production Notes runtime, disposable data/profile, and test-only response probes.
// --webview2 uses RELATUM_WEBVIEW_PYTHON; no release package is rebuilt or changed.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), native = process.argv.includes('--webview2');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
  '  window.P = {state, openNote, activateGraphTab, setViewMode, setSideOpen, setBrowserMode, syncOutline, triggerExternalSync, scheduleExternalSync, runDocumentPrefetch, stopExternalSync, stopDocumentPrefetch, scheduleStatistics, get editor(){return liveEditor;}, get browser(){return noteBrowser;}, get statisticsJob(){return statisticsJob;}};\n  window.CanvasNoteWorkspace = {');
assert(source.includes('window.P ='), 'workspace probe anchor');

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function probe(fallback) {
  localStorage.setItem('canvas:startWorkspace:v1', 'notes');
  localStorage.setItem('canvas:noteGraphPreload:v1', '0');
  localStorage.setItem('canvas:noteOpenTabs:v1', '["A.md"]');
  localStorage.setItem('canvas:noteActiveTab:v1', 'A.md');
  const stats = window.V = { live: new Set(), records: [], draws: 0, buffers: 0, programs: 0, contexts: 0, outlineScans: 0 };
  const get = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (fallback && /^webgl/.test(kind)) return null;
    const gl = get.call(this, kind, ...args);
    if (gl && /^webgl/.test(kind) && !seen.has(gl)) {
      seen.add(gl); stats.contexts++;
      this.addEventListener('webglcontextlost', () => stats.contexts--, { once: true });
      for (const [make, drop, key] of [['createBuffer', 'deleteBuffer', 'buffers'], ['createProgram', 'deleteProgram', 'programs']]) {
        const create = gl[make], destroy = gl[drop];
        gl[make] = function (...params) { const item = create.apply(this, params); if (item) stats[key]++; return item; };
        gl[drop] = function (item) { if (item) stats[key]--; return destroy.call(this, item); };
      }
    }
    return gl;
  };
  const positions = nodes => nodes.map(node => [node.id, node.x, node.y]);
  let api;
  Object.defineProperty(window, 'GraphEngine', { configurable: true, get: () => api, set(value) {
    api = value; const create = value.create;
    value.create = options => {
      if (!options.canvas.closest('[data-role="note-graph-panel"]')) return create(options);
      const record = { engine: null, nodes: [], intros: 0 }, sync = options.domOverlay.sync;
      options.domOverlay.sync = frame => { stats.draws++; if (record.engine && !record.firstView) record.firstView = { ...record.engine.view }; return sync(frame); };
      const engine = record.engine = create(options), set = engine.setData, destroy = engine.destroy, start = engine.start;
      engine.setData = function (nodes, ...args) { record.nodes = nodes; record.installed = positions(nodes); return set.call(this, nodes, ...args); };
      engine.start = function (settings) { if (settings?.intro) record.intros++; return start.call(this, settings); };
      engine.destroy = function () {
        if (stats.live.delete(record)) stats.released = { view: { ...engine.view }, positions: positions(record.nodes), pending: engine.layoutPending };
        return destroy();
      };
      stats.records.push(record); stats.live.add(record); stats.latest = record; return engine;
    };
  } });
}

async function run(browser, mode) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-visibility-'));
  fs.mkdirSync(path.join(dataRoot, 'notes')); fs.mkdirSync(path.join(dataRoot, 'data'));
  const body = '---\ntags: [audit]\n---\n\n# First\n\n[[B]]\n\n## Second\n\nText\n';
  fs.writeFileSync(path.join(dataRoot, 'notes/A.md'), body);
  fs.writeFileSync(path.join(dataRoot, 'notes/B.md'), '# Destination\n');
  for (let i = 0; i < 398; i++) fs.writeFileSync(path.join(dataRoot, 'notes', `Note-${i}.md`), `# Note ${i}\n` + (i < 397 ? `[[Note-${i + 1}]]\n` : ''));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
  const graph = mode !== 'notes-no-graph', port = await freePort(), debug = native ? await freePort() : 0;
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id,
    item.id === 'notes' || graph && item.id === 'notes.graph'])) };
  const args = ['-B', native ? 'desktop.py' : 'app.py', ...(!native ? ['--no-browser', '--port', String(port)] : []),
    ...(mode !== 'full' ? ['--launch-profile', JSON.stringify(profile)] : [])];
  const server = spawn(native ? process.env.RELATUM_WEBVIEW_PYTHON : process.env.RELATUM_PYTHON, args, {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELATUM_DATA_ROOT: dataRoot,
      ...(native ? { LOCALAPPDATA: dataRoot, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}` } : {}) },
  });
  let logs = '', context, connection, page; server.stderr.on('data', data => { logs += data; });
  const holds = new Set(), requests = [], errors = [];
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(native ? `http://127.0.0.1:${debug}/json/version` : `http://127.0.0.1:${port}/api/runtime`)).ok; } catch (_) {}
      if (ready) break; assert.equal(server.exitCode, null, logs); await delay(100);
    }
    assert(ready, 'isolated host starts');
    let url = `http://127.0.0.1:${port}`;
    if (native) {
      connection = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`); context = connection.contexts()[0];
      for (let i = 0; i < 100; i++) { page = context.pages().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await delay(100); }
      assert(page); url = new URL(page.url()).origin;
    } else { context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); page = await context.newPage(); }
    page.setDefaultTimeout(25000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    const editorSource = fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') +
      '\nconst scanHeadings=RelatumNoteLiveSyntax.scanNoteHeadings;RelatumNoteLiveSyntax.scanNoteHeadings=(...args)=>{V.outlineScans++;return scanHeadings(...args);};';
    await page.route('**/note-live-editor.js*', route => route.fulfill({ contentType: 'text/javascript', body: editorSource }));
    await page.addInitScript(probe, mode === 'fallback');
    await page.goto(url + (native ? '/?desktop=1' : '/'), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.P?.state.active && P.state.current?.path === 'A.md' && P.editor);
    const backgroundCalls = () => requests.filter(item => item.path.startsWith('/api/note') && (item.method === 'GET' || item.path === '/api/note-query')).length;
    async function minimize() {
      if (native) { await page.evaluate(() => pywebview.api.minimize()); await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1'); }
      else await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } })); });
    }
    async function restore() {
      if (native) {
        await page.evaluate(() => pywebview.api.toggle_maximize()); await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
        await page.evaluate(() => pywebview.api.toggle_maximize());
      } else await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } })); });
    }
    async function hold(endpoint, transform) {
      let release, started, finished, used = false;
      const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
      const completed = new Promise(resolve => { finished = resolve; });
      const match = url => url.pathname === endpoint;
      const handle = async route => {
        if (used) return route.continue(); used = true;
        const response = await route.fetch(); let content = await response.text();
        if (transform) content = transform(content);
        started(); await gate;
        try { await route.fulfill({ response, body: content }); } finally { finished(); }
      };
      await page.route(match, handle);
      const unlock = async () => { release(); if (used) await completed; await page.unroute(match, handle); holds.delete(unlock); };
      holds.add(unlock);
      return { async requested() {
        let timer;
        try { await Promise.race([requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request: ' + endpoint)), 10000); })]); }
        finally { clearTimeout(timer); }
      }, release: unlock };
    }
    const checks = [];
    if (graph) {
      await page.evaluate(() => { P.activateGraphTab(); });
      await page.waitForFunction(() => V.live.size === 1 && V.latest.nodes.length === 400);
      await page.evaluate(() => { V.latest.engine.restoreView({ x: 75, y: 45, scale: .95 }); V.latest.engine.kick(); P.scheduleExternalSync(100); });
      await minimize();
      assert.equal(await page.evaluate(() => document.hidden), false, 'native minimize is independently visible to the browser document');
      await page.waitForFunction(() => V.live.size === 0 && V.buffers === 0 && V.programs === 0 && V.contexts === 0);
      assert.equal(await page.locator('[data-note-graph-label]').count(), 0, 'minimized graph releases titles');
      const idle = await page.evaluate(() => ({ draws: V.draws, creates: V.records.length })), calls = backgroundCalls();
      await page.waitForTimeout(native ? 9500 : 2600);
      assert.deepEqual(await page.evaluate(() => ({ draws: V.draws, creates: V.records.length })), idle, 'minimized graph has zero draws and recreations');
      assert.equal(backgroundCalls(), calls, 'minimized notebook starts zero reads/scans');
      await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } })); });
      await restore(); await page.waitForFunction(() => V.live.size === 1 && V.latest.firstView);
      assert(await page.evaluate(() => V.released.pending), 'test interrupts an unfinished layout');
      assert.deepEqual(await page.evaluate(() => V.latest.installed), await page.evaluate(() => V.released.positions), 'restore consumes saved coordinates');
      assert.deepEqual(await page.evaluate(() => V.latest.firstView), await page.evaluate(() => V.released.view), 'restore keeps the camera');
      assert.equal(await page.evaluate(() => V.latest.intros), 0, 'restore does not replay growth');
      const creates = await page.evaluate(() => V.records.length);
      await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } })); });
      await page.waitForTimeout(150); assert.equal(await page.evaluate(() => V.records.length), creates, 'duplicate restore notifications do not initialize twice');
      checks.push('native/synthetic minimize, zero resources/work, unfinished layout, camera, duplicate notifications');

      // An old graph response must remain stale even after a quick restore.
      await page.evaluate(() => { P.stopExternalSync(); window.oldGraph = P.triggerExternalSync({ background: true }); });
      await page.evaluate(() => window.oldGraph);
      const pendingGraph = await hold('/api/note-graph', text => {
        const data = JSON.parse(text); return JSON.stringify({ root: data.root, signature: 'obsolete-minimized-response', nodes: [{ id: 'late', path: 'Late.md', title: 'Late' }], edges: [] });
      });
      await page.evaluate(() => { window.oldGraph = P.triggerExternalSync({ background: true }); }); await pendingGraph.requested();
      await minimize(); await restore(); await pendingGraph.release(); await page.evaluate(() => window.oldGraph);
      await page.waitForFunction(() => V.live.size === 1 && V.latest.nodes.length === 400);
      assert(await page.evaluate(() => V.records.every(record => record.nodes.every(node => node.id !== 'late'))), 'late graph never installs after restore');
      checks.push('late graph response after rapid restore');
      await page.evaluate(() => P.openNote('A.md', { reuseActiveTab: false }));
    }

    // Reject a held external tree before it can invalidate browser/graph state.
    await page.evaluate(() => P.state.externalSyncChain);
    await page.evaluate(() => { P.stopExternalSync(); P.stopDocumentPrefetch(); });
    const tree = await hold('/api/notes-tree', text => { const data = JSON.parse(text); data.entries.push({ path: 'Late.md', name: 'Late.md', kind: 'note', size: 10, modifiedNs: 1 }); return JSON.stringify(data); });
    await page.evaluate(() => { window.oldTree = P.triggerExternalSync({ background: true }); }); await tree.requested();
    await minimize(); await page.evaluate(() => { window.treeIdentity = P.state.entries; });
    await tree.release(); await page.evaluate(() => window.oldTree);
    assert(await page.evaluate(() => P.state.entries === treeIdentity && !P.state.entries.some(entry => entry.path === 'Late.md')), 'late tree retains the old model');
    assert.equal(await page.evaluate(() => P.state.externalSyncTimer), 0, 'late sync cannot schedule polling');
    await restore(); await page.evaluate(() => P.state.externalSyncChain);
    checks.push('late directory response and polling cancellation');

    // A held external document read must not rebuild the editor or replace a draft.
    await page.evaluate(() => { P.stopExternalSync(); P.stopDocumentPrefetch(); window.documentIdentity = P.state.current; window.editorIdentity = P.editor.view; });
    const document = await hold('/api/note', text => { const data = JSON.parse(text); data.content = '# Obsolete body'; data.revision = 'obsolete'; return JSON.stringify(data); });
    await page.evaluate(() => { window.oldDocument = P.triggerExternalSync({}); }); await document.requested();
    await minimize(); await document.release(); await page.evaluate(() => window.oldDocument);
    assert(await page.evaluate(() => P.state.current === documentIdentity && P.editor.view === editorIdentity && !P.editor.snapshot().value.includes('Obsolete')), 'late document does not rebuild the editor');
    await restore(); await page.evaluate(() => P.state.externalSyncChain);
    checks.push('late document read preserves editor/draft');

    const links = await hold('/api/note-links', () => JSON.stringify({ outgoing: [{ path: 'Late.md' }], backlinks: [] }));
    await page.evaluate(() => { P.stopExternalSync(); P.stopDocumentPrefetch(); P.state.sideMode = 'links'; P.setSideOpen(true); });
    await links.requested(); await minimize(); await links.release(); await page.waitForTimeout(100);
    assert(await page.evaluate(() => P.state.current.linksRefreshNeeded && P.state.current.outgoing.every(item => item.path !== 'Late.md')), 'late links remain pending without installing the old response');
    await restore(); await page.waitForFunction(() => !P.state.current.linksRefreshNeeded && P.state.current.outgoing.some(item => item.path === 'B.md'));
    await page.evaluate(() => P.setSideOpen(false));
    checks.push('late links stay pending and refresh on restore');

    // Pre-reading is sequential; hiding while the first read is pending stops the rest.
    await page.evaluate(() => { P.stopExternalSync(); P.stopDocumentPrefetch(); for (const key of P.state.documentCache.keys()) if (key !== P.state.current.path) P.state.documentCache.delete(key); });
    const prefetch = await hold('/api/note');
    await page.evaluate(() => { window.prefetch = P.runDocumentPrefetch(); }); await prefetch.requested();
    await minimize(); const readCount = backgroundCalls(); await prefetch.release(); await page.evaluate(() => window.prefetch);
    assert.equal(backgroundCalls(), readCount, 'late pre-read starts no following reads');
    assert.deepEqual(await page.evaluate(() => [...P.state.documentCache.keys()]), ['A.md'], 'late pre-read is not cached');
    await restore(); checks.push('late pre-read and sequential cancellation');

    // Lazy outline loading also obeys native visibility rather than document.hidden.
    const outline = await hold('/note-outline.js');
    await page.evaluate(() => { P.state.sideMode = 'outline'; P.setSideOpen(true); P.syncOutline(); }); await outline.requested();
    await minimize(); const scans = await page.evaluate(() => V.outlineScans);
    await outline.release(); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => V.outlineScans), scans, 'late outline script does not parse while minimized');
    await restore(); await page.waitForFunction(() => document.querySelectorAll('.note-outline-row').length === 2);
    await minimize(); const outlineScans = await page.evaluate(() => V.outlineScans);
    await page.evaluate(() => P.editor.view.dispatch({ changes: { from: P.editor.view.state.doc.length, insert: '\n### Saved while minimized\n' } }));
    await page.evaluate(() => P.scheduleStatistics(P.state.current, 0)); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => V.outlineScans), outlineScans, 'document changes do not restart minimized outline work');
    assert.equal(await page.evaluate(() => P.statisticsJob), null, 'minimized word counting does not start');
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert(fs.readFileSync(path.join(dataRoot, 'notes/A.md'), 'utf8').includes('Saved while minimized'), 'saving remains operational');
    await restore(); await page.waitForFunction(() => document.querySelectorAll('.note-outline-row').length === 3);
    checks.push('lazy outline, stopped parsing/counting, saved draft and restored outline');

    // Exercise the browser query's own cancellation and preserved selection.
    await page.evaluate(() => { P.setSideOpen(false); P.stopExternalSync(); });
    const query = await hold('/api/note-query');
    await page.evaluate(() => { window.browsing = P.setBrowserMode(true, 'audit'); }); await query.requested();
    await minimize(); await query.release(); await page.evaluate(() => window.browsing);
    const queryCount = backgroundCalls(); await page.waitForTimeout(250); assert.equal(backgroundCalls(), queryCount, 'late browsing query stays suspended');
    await restore(); await page.waitForFunction(() => document.querySelector('.note-browser-result'));
    await page.evaluate(() => P.openNote('A.md', { reuseActiveTab: false }));
    checks.push('browser query suspension and restored results');

    // Reading mode shares the same lifecycle without replacing the displayed document.
    await page.evaluate(() => P.setViewMode('reading'));
    await page.evaluate(() => { window.readingIdentity = document.querySelector('[data-role="note-reading-view"]').firstChild; });
    await minimize(); await restore();
    assert(await page.evaluate(() => P.state.viewMode === 'reading' && document.querySelector('[data-role="note-reading-view"]').firstChild === readingIdentity), 'reading DOM and mode survive minimization');
    await page.evaluate(() => P.setViewMode('live'));

    const cdp = await context.newCDPSession(page);
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      P.editor.view.dispatch({ selection: { anchor: P.editor.view.state.doc.length } }); P.editor.focus();
    });
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await page.waitForFunction(() => P.editor.inputPending);
    await minimize();
    // WinForms can settle preedit when iconic. Confirm text in the restored
    // native input; the synthetic case also covers confirmation while hidden.
    if (native) { await restore(); await page.evaluate(() => P.editor.focus()); }
    await cdp.send('Input.insertText', { text: '中文' });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await page.waitForFunction(() => !P.editor.inputPending); await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    const savedComposition = fs.readFileSync(path.join(dataRoot, 'notes/A.md'), 'utf8');
    assert.equal(savedComposition, await page.evaluate(() => P.editor.snapshot().value), 'composition and the saved document agree');
    assert(savedComposition.includes('中文'), 'native confirmation is saved');
    // An iconic WinForms host can settle preedit and restore its old DOM caret
    // (also reproduced with HEAD). Only the browser case promises the suffix.
    if (!native) assert(savedComposition.endsWith('中文'), 'browser confirmation replaces preedit at the original position');
    if (!native) await restore(); await cdp.detach(); checks.push('reading DOM and Chromium native composition/save');

    if (!native) {
      // Restoring the native host alone must not wake a still-hidden browser page.
      await minimize(); await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await restore(); const hiddenCalls = backgroundCalls(); await page.waitForTimeout(200); assert.equal(backgroundCalls(), hiddenCalls);
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      if (mode === 'full') {
        await page.locator('[data-start-workspace="canvas"]').click(); await minimize(); await restore();
        assert.equal(await page.evaluate(() => V.live.size), 0, 'restore does not reactivate the departed workspace');
        await page.locator('[data-start-workspace="notes"]').click();
      }
      checks.push('combined page/native visibility and inactive workspace');
    }
    assert.deepEqual(errors, [], 'no browser errors');
    const result = { mode, native, browserVersion: (connection || browser).version(), dataRoot, checks, errors };
    fs.writeFileSync(path.join(dataRoot, 'visibility-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    for (const release of holds) await release().catch(() => {});
    if (native) {
      await page?.evaluate(() => pywebview.api.close_window()).catch(() => {});
      if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(4000)]);
      await connection?.close().catch(() => {});
    } else await context?.close();
    if (server.exitCode === null) server.kill();
  }
}
(async () => {
  assert(process.env.RELATUM_PYTHON && (!native || process.env.RELATUM_WEBVIEW_PYTHON), 'Configure the existing Python host(s)');
  const requested = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
  const modes = requested ? [requested] : native ? ['notes-no-canvas'] : ['full', 'notes-no-canvas', 'notes-no-graph', 'fallback'];
  const browser = native ? null : await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try { for (const mode of modes) await run(browser, mode); } finally { await browser?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

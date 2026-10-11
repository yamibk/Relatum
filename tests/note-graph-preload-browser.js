'use strict';
// Real local API and startup paths. Fixtures, launcher choices and WebView2 profiles are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile), key = 'canvas:noteGraphPreload:v1', token = 'relatum:graph-tab:v1';
const release = process.env.RELATUM_GRAPH_RELEASE ? path.resolve(process.env.RELATUM_GRAPH_RELEASE) : '';
const catalog = JSON.parse(fs.readFileSync(path.join(release || repo, release ? '_internal/assets/feature-catalog.json' : 'assets/feature-catalog.json'), 'utf8'));
const report = { measuredAt: new Date().toISOString(), regression: [], samples: [] };
const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
  '  window.P = {state, activateGraphTab, activateTab, setSideOpen, setNoteSettingsOpen, selectNotebook, closeAllTabs, get graph(){return noteGraph;}};\n  window.CanvasNoteWorkspace = {');
const adapter = fs.readFileSync(path.join(repo, 'assets/note-graph.js'), 'utf8')
  .replace('const scenes = new Map();', 'const scenes = new Map(); window.__preloadProbe.scenes = scenes;')
  .replace('let sceneBytes = 0;', 'let sceneBytes = 0; Object.defineProperty(window.__preloadProbe, "bytes", { get: () => sceneBytes });');
assert(workspace.includes('window.P =') && adapter.includes('window.__preloadProbe.scenes ='));

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function profile(options) {
  if (options.mode === 'full') return null;
  if (options.mode === 'no-notes') return { version: 1, features: Object.fromEntries(catalog.features.map(item =>
    [item.id, ['canvas', 'canvas.library', 'runtime.preload'].includes(item.id)])) };
  const ids = ['notes', ...(options.graph === false ? [] : ['notes.graph']),
    ...(options.total === false ? [] : ['runtime.preload']), ...(options.canvas === false ? [] : ['notes.canvas'])];
  const features = Object.fromEntries(catalog.features.map(item => [item.id, ids.includes(item.id)]));
  if (options.legacy) delete features['notes.graph'];
  return { version: 1, features };
}
function probe(options) {
  const graphToken = 'relatum:graph-tab:v1';
  const p = window.__preloadProbe = { engines: 0, contexts: 0, starts: 0, draws: 0, dataCount: 0,
    requests: [], firstDrawAt: 0 };
  p.seed = options;
  if (!localStorage.getItem('relatum:graph-test-seeded')) {
    localStorage.setItem('relatum:graph-test-seeded', '1');
    localStorage.setItem('canvas:startWorkspace:v1', options.startWorkspace || 'notes');
    localStorage.setItem('canvas:noteFocusMode:v1', options.focus ? '1' : '0');
    if (options.preload !== undefined) localStorage.setItem('canvas:noteGraphPreload:v1', options.preload ? '1' : '0');
    localStorage.setItem('canvas:toolbarLanguage', options.english ? 'en' : 'zh-CN');
    localStorage.setItem('canvas:startTheme', options.dark ? 'dark' : 'light');
    if (options.restore) {
      localStorage.setItem('canvas:noteOpenTabs:v1', JSON.stringify([options.restore === 'blank' ? graphToken : options.note, graphToken]));
      localStorage.setItem('canvas:noteActiveTab:v1', graphToken);
      localStorage.setItem('canvas:noteGraphSpacing:v1', '140');
    }
  }
  const fetcher = window.fetch;
  window.fetch = function (url, ...args) {
    if (String(url).startsWith('/api/note-graph')) p.requests.push(String(url));
    return fetcher.call(this, url, ...args);
  };
  const get = HTMLCanvasElement.prototype.getContext;
  const NativeWorker = window.Worker;
  if (NativeWorker) window.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); p.workers = (p.workers || 0) + 1; this.finished = false; }
    terminate() { if (!this.finished) { this.finished = true; p.workers--; } super.terminate(); }
  };
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (options.fallback && /^webgl/.test(kind)) return null;
    const context = get.call(this, kind, ...args);
    if (context && /^webgl/.test(kind)) p.contexts++;
    return context;
  };
  let module;
  Object.defineProperty(window, 'GraphEngine', { configurable: true, get: () => module, set(value) {
    const create = value.create;
    value.create = settings => {
      p.engines++;
      if (document.documentElement.classList.contains('note-graph-boot-pending')) p.createdDuringPreparation = true;
      const sync = settings.domOverlay?.sync;
      if (sync) settings.domOverlay.sync = state => { p.draws++; if (!p.firstDrawAt) p.firstDrawAt = performance.now(); return sync(state); };
      const engine = create(settings), start = engine.start, setData = engine.setData;
      engine.start = function (...args) { p.starts++; return start.apply(this, args); };
      engine.setData = function (nodes, ...args) { p.dataCount = nodes.length; return setData.call(this, nodes, ...args); };
      p.latest = engine; return engine;
    };
    module = value;
  } });
}

async function session(browser, options, test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-graph-preload-')), notes = path.join(root, 'notes');
  const selected = options.selected === undefined ? '' : options.selected, count = options.count ?? 2;
  const target = selected || '', data = path.join(root, 'data');
  for (const book of ['', 'CustomNotebook/One', 'CustomNotebook/Other', 'CustomNotebook/Empty']) fs.mkdirSync(path.join(notes, book), { recursive: true });
  if (selected !== 'CustomNotebook/Empty') for (let i = 0; i < count; i++) {
    const filename = `笔记-${i}.md`;
    fs.writeFileSync(path.join(notes, target, filename), (i < (options.edges ?? count - 1) ? `[[笔记-${i + 1}]]\n` : '') + '正文\n');
  }
  fs.writeFileSync(path.join(notes, 'CustomNotebook/Other/Other.md'), 'other notebook\n');
  const note = [target, '笔记-0.md'].filter(Boolean).join('/');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'note-notebooks.json'), JSON.stringify({ version: 1, colors: {},
    ui: { open: false, mode: 'notebooks', selectedRoot: selected, expanded: [] } }));
  const choices = profile(options), port = await freePort(), debugPort = release ? await freePort() : 0;
  const launchedAt = performance.now();
  let url = `http://127.0.0.1:${port}`, context, connection, page, server;
  if (release) {
    assert(choices, 'native tests use isolated notes-only sessions');
    fs.writeFileSync(path.join(data, 'launcher-profile.json'), JSON.stringify(choices));
    fs.writeFileSync(path.join(data, 'launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
    const pref = path.join(data, 'desktop-sessions/notes'); fs.mkdirSync(pref, { recursive: true });
    fs.writeFileSync(path.join(pref, 'preferences.json'), JSON.stringify({ version: 1, values: {
      'canvas:startWorkspace:v1': 'notes', [key]: options.preload ? '1' : '0',
      'canvas:noteFocusMode:v1': options.focus ? '1' : '0' } }));
    server = spawn(path.join(release, 'RelatumLauncher.exe'), [], { cwd: release, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root,
        RELATUM_STARTUP_TRACE: '1',
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } });
  } else {
    server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port),
      ...(choices ? ['--launch-profile', JSON.stringify(choices)] : [])], { cwd: repo, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, RELATUM_DATA_ROOT: root } });
  }
  try {
    for (let i = 0; i < 250; i++) {
      try { if ((await fetch(release ? `http://127.0.0.1:${debugPort}/json/version` : url + '/api/runtime')).ok) break; } catch (_) {}
      assert.equal(server.exitCode, null, 'isolated process stays alive'); await sleep(80);
      assert(i < 249, 'isolated host starts');
    }
    if (release) {
      connection = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); context = connection.contexts()[0];
      for (let i = 0; i < 100; i++) {
        page = context.pages().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await sleep(50);
      }
      assert(page); url = new URL(page.url()).origin;
      await page.waitForFunction(() => window.RelatumFeatureRuntime);
      assert.equal(await page.evaluate(() => RelatumFeatureRuntime.enabled('notes.graph')), options.graph !== false,
        'real launcher hands the new child choice to the native main window');
    } else { context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); page = await context.newPage(); }
    page.setDefaultTimeout(15000); await page.emulateMedia({ reducedMotion: 'reduce' });
    if (options.nativeBenchmark) {
      await page.waitForFunction(() => window.CanvasNoteWorkspace && !document.documentElement.classList.contains('note-boot-pending')
        && !document.documentElement.classList.contains('note-graph-boot-pending'));
      await test({ page, context, root, pid: server.pid, startupMs: performance.now() - launchedAt });
      return;
    }
    const errors = [], resources = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => resources.push(new URL(req.url()).pathname));
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.route('**/note-graph.js*', route => route.fulfill({ contentType: 'text/javascript', body: adapter }));
    await page.addInitScript(probe, { ...options, note });
    if (options.setup) await options.setup(page);
    if (options.editor) {
      const canvases = path.join(root, 'canvases'); fs.mkdirSync(canvases, { recursive: true });
      const canvas = path.join(canvases, 'fixture.canvas');
      fs.writeFileSync(canvas, '{"version":2,"nodes":[],"edges":[]}');
      await page.goto(url + '/editor.html?file=' + encodeURIComponent(canvas), { waitUntil: 'domcontentloaded' });
    } else await page.goto(url + '/?startupTrace=1' + (release ? '&desktop=1' : ''), { waitUntil: 'domcontentloaded' });
    await test({ page, context, resources, url, root, notes, note, selected, errors });
    assert.deepEqual(errors, [], 'no browser errors');
  } finally {
    if (release) {
      if (page && server.exitCode === null) await page.evaluate(() => pywebview.api.close_window()).catch(() => {});
      if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(4000)]);
      await connection?.close().catch(() => {});
      if (server.exitCode === null) await execute('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    } else { await context?.close(); server.kill(); if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(1000)]); }
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('relatum-graph-preload-')) {
      // WebView2 releases its lock shortly after the native parent exits.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}
async function ready(page) {
  await page.waitForFunction(() => window.P?.state.initialized && P.state.active
    && !document.documentElement.classList.contains('note-graph-boot-pending')
    && !document.documentElement.classList.contains('note-boot-pending'));
}
async function hiddenResources(page) {
  assert.deepEqual(await page.evaluate(() => ({ engines: __preloadProbe.engines, contexts: __preloadProbe.contexts,
    starts: __preloadProbe.starts, draws: __preloadProbe.draws, labels: document.querySelectorAll('[data-note-graph-label]').length })),
  { engines: 0, contexts: 0, starts: 0, draws: 0, labels: 0 });
}
async function prepared(page) {
  await page.waitForFunction(() => performance.getEntriesByName('relatum:note-graph-preload-ready').length > 0);
}
async function openGraph(page, count) {
  await page.evaluate(() => P.activateGraphTab());
  await page.waitForFunction(count => document.querySelector('[data-role="graph-node-count"]').textContent === String(count), count);
  if (count) await page.waitForFunction(() => __preloadProbe.draws > 0);
}
async function regression(browser) {
  const cases = release ? [{ preload: true, count: 398, edges: 79 }, { preload: true, graph: false, restore: true },
    { preload: true, total: false }, { preload: true, count: 3000, canvas: false },
    { preload: true, dark: true, english: true, focus: true, fallback: true }]
    : [{ preload: false }, { preload: true }, { preload: true, total: false },
      { preload: true, graph: false, restore: true }, { preload: true, graph: false, restore: 'blank' },
      { preload: true, canvas: false }, { preload: true, mode: 'full' }, { preload: true, legacy: true },
      { preload: true, fallback: true, dark: true, english: true, focus: true },
      { preload: true, selected: 'CustomNotebook/One' }, { preload: true, selected: 'CustomNotebook/Empty', count: 0 },
      { preload: true, selected: null }, { mode: 'full' }];
  for (const options of cases) await session(browser, options, async ({ page, resources, url, note, selected, root }) => {
    await ready(page);
    const enabled = options.graph !== false, warm = enabled && options.preload === true && options.total !== false;
    assert.equal(await page.locator('.note-graph-boot-status').count(), 0, 'preparation has no blocking startup surface');
    assert.equal(await page.evaluate(() => document.querySelector('.start-workspace-stage').inert), false);
    if (warm) await prepared(page);
    if (warm && options.mode === 'full') {
      await page.evaluate(() => {
        document.documentElement.dataset.desktopMinimized = '1';
        window.dispatchEvent(new Event('canvasdesktop:visibility'));
        window.__idleAfterRestore = false;
        RelatumBackgroundPreparation.waitForIdle().then(() => { window.__idleAfterRestore = true; });
      });
      await sleep(1800);
      assert.equal(await page.evaluate(() => window.__idleAfterRestore), false, 'native minimize pauses idle preparation even with retained focus');
      await page.evaluate(() => {
        document.documentElement.dataset.desktopMinimized = '0';
        window.dispatchEvent(new Event('canvasdesktop:visibility'));
      });
      await page.waitForFunction(() => window.__idleAfterRestore);
    }
    await hiddenResources(page);
    assert.equal(resources.includes('/note-graph.js'), warm, 'startup resource boundary');
    assert.equal(await page.evaluate(() => __preloadProbe.requests.length), warm && selected !== null ? 1 : 0);
    const state = await page.evaluate(() => ({ ready: performance.getEntriesByName('relatum:notes-ready')[0]?.startTime,
      prepared: performance.getEntriesByName('relatum:note-graph-preload-ready')[0]?.startTime,
      root: P.state.notebookRoot, tabs: P.state.tabs, current: P.state.current?.path,
      preload: RelatumNotePreferences.readGraphPreload(), spacing: RelatumNotePreferences.readGraphSpacing() }));
    assert.equal(state.root, selected); assert.equal(state.preload, options.preload === true);
    if (warm) assert(state.prepared > state.ready, 'main workspace activation precedes idle preparation');
    if (!enabled) {
      assert.equal(await page.locator('[data-note-action="toggle-graph"], [data-role="note-graph-panel"], [data-role="note-graph-preload"], [data-role="note-graph-spacing"]').count(), 0);
      assert(!state.tabs.includes(token)); assert.equal(state.current || '', options.restore === 'blank' ? '' : note,
        JSON.stringify({ state, storage: await page.evaluate(() => localStorage.getItem('canvas:noteOpenTabs:v1')),
          error: await page.locator('[data-role="note-error"]').textContent().catch(() => ''), seed: await page.evaluate(() => __preloadProbe.seed) }));
      assert.equal(state.spacing, 140, 'disabled graph retains spacing');
      const response = await fetch(url + '/api/note-graph?root='); assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'feature-disabled');
      assert.equal((await fetch(url + '/note-graph.js')).status, 403);
      assert.equal((await fetch(url + '/graph-engine.js')).status, 403);
    } else {
      await page.evaluate(() => P.setSideOpen(true));
      await page.locator('[data-note-action="toggle-settings"]').click();
      const input = page.locator('[data-role="note-graph-preload"]'); assert.equal(await input.isChecked(), options.preload === true);
      assert.equal(await page.locator('[data-role="note-graph-preload-paused"]').isVisible(), options.total === false);
      if (options.english) assert.equal(await page.locator('#note-settings-startup-title').textContent(), 'Startup');
      if (process.env.RELATUM_ARTIFACT_DIR && (release || options.english || options.preload === false)) {
        fs.mkdirSync(process.env.RELATUM_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RELATUM_ARTIFACT_DIR,
          `graph-preload-${release ? 'webview2' : 'edge'}-${options.english ? 'en-dark' : options.total === false ? 'paused' : 'zh'}.png`) });
      }
      const scripts = resources.filter(resource => resource === '/note-graph.js').length;
      await input.setChecked(!(options.preload === true)); await sleep(150);
      assert.equal(resources.filter(resource => resource === '/note-graph.js').length, scripts, 'runtime preference changes never initiate loading');
      assert.equal(await page.evaluate(() => RelatumBoot.noteGraphPreloadRequested), warm, 'startup decision stays fixed');
      await input.setChecked(true);
      if (selected !== null) {
        await page.evaluate(() => P.setNoteSettingsOpen(false)); await openGraph(page, options.count ?? 2);
        const requests = await page.evaluate(() => __preloadProbe.requests);
        assert.equal(requests.filter(url => !url.includes('&signature=')).length, 1, 'first open does not repeat a prepared full request');
        if (warm) assert(requests.some(url => url.includes('&signature=')));
        assert.equal(resources.filter(resource => resource === '/note-graph.js').length, 1, 'scripts load once');
        await page.evaluate(() => P.closeAllTabs());
        assert.equal(await page.locator('[data-note-graph-label]').count(), 0, 'leaving releases labels');
      }
      if (!release && !options.restore) {
        // Keep localStorage on this origin; only the next document reads the changed startup choice.
        await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page);
        assert.equal(await page.evaluate(() => RelatumBoot.noteGraphPreloadRequested), options.total !== false);
        await page.evaluate(() => P.setNoteSettingsOpen(true));
        await page.locator('[data-note-settings-action="reset-open"]').click();
        await page.locator('[data-note-settings-action="reset-accept"]').click();
        assert.equal(await input.isChecked(), false); assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
      }
      if (release) {
        await page.evaluate(() => RelatumDesktopPreferences.flush());
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'data/desktop-sessions/notes/preferences.json'), 'utf8'));
        assert.equal(saved.values[key], '1', 'native checkbox joins the existing disk snapshot');
      }
    }
    const sample = { ...options, native: !!release, passed: true }; delete sample.setup;
    report.regression.push(sample); console.log('graph startup ' + JSON.stringify(sample));
  });
  if (release) {
    await session(browser, { preload: true, focus: true, setup: async page => {
      await page.route('**/api/note-graph?*', async route => { await sleep(4500); await route.abort().catch(() => {}); });
    } }, async ({ page }) => {
      await page.waitForFunction(() => __preloadProbe.requests.length === 1);
      await hiddenResources(page);
      const close = page.locator('.desktop-note-focus-close'); await close.waitFor({ state: 'visible' });
      assert(await close.evaluate(el => { const r = el.getBoundingClientRect();
        return !el.closest('[inert]') && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-window-action="close"]') === el; }),
      'native close control stays usable throughout preparation');
      const closed = page.waitForEvent('close'); await close.click(); await closed;
      report.regression.push({ kind: 'native-close-during-preparation', passed: true });
      console.log('native startup: close during preparation passed');
    });
    return;
  }
  await session(browser, { preload: true, setup: async page => {
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      window.__interactionTimer = setInterval(() => document.dispatchEvent(new PointerEvent('pointermove')), 80);
    }, { once: true }));
  } }, async ({ page, resources }) => {
    await ready(page); await sleep(1800);
    assert(!resources.includes('/note-graph.js'), 'continuous interaction postpones scripts');
    await page.evaluate(() => {
      clearInterval(__interactionTimer);
      window.__releasePreparationBusy = RelatumBackgroundPreparation.beginBusy();
    });
    await sleep(1800);
    assert(!resources.includes('/note-graph.js'), 'application work postpones scripts');
    await page.evaluate(() => __releasePreparationBusy());
    await prepared(page); await hiddenResources(page);
    assert.equal(await page.evaluate(() => __preloadProbe.workers || 0), 0, 'finished worker is released');
    assert.equal(await page.evaluate(() => __preloadProbe.scenes.get('').backgroundLayout), true);
    await openGraph(page, 2);
    assert.equal(await page.evaluate(() => __preloadProbe.starts), 0, 'prepared layout opens without automatic growth');
    report.regression.push({ kind: 'idle-interaction-busy-and-stable-open', passed: true });
  });
  await session(browser, { preload: true }, async ({ page }) => {
    await ready(page); await prepared(page);
    await page.evaluate(() => P.selectNotebook('CustomNotebook/Other', { rootTarget: true }));
    await page.waitForFunction(() => __preloadProbe.scenes.get('CustomNotebook/Other')?.backgroundLayout);
    await hiddenResources(page); await openGraph(page, 1);
    assert.equal(await page.evaluate(() => __preloadProbe.latest.layoutPending), false);
    report.regression.push({ kind: 'idle-preparation-follows-selected-notebook', passed: true });
  });
  await session(browser, { preload: true, mode: 'full', startWorkspace: 'canvas' }, async ({ page, resources }) => {
    await page.waitForFunction(() => window.P?.state.initialized && RelatumStartWorkspace.current === 'canvas'
      && !document.documentElement.classList.contains('note-graph-boot-pending'));
    await prepared(page);
    await hiddenResources(page);
    assert.equal(await page.evaluate(() => P.state.active), false, 'preparation does not activate the hidden notes workspace');
    assert(resources.includes('/note-graph.js')); assert.equal(await page.evaluate(() => __preloadProbe.requests.length), 1);
    await page.evaluate(() => RelatumStartWorkspace.set('notes', { animate: false }));
    await ready(page); await openGraph(page, 2);
    assert.equal(await page.evaluate(() => __preloadProbe.requests.filter(url => !url.includes('&signature=')).length), 1);
    report.regression.push({ kind: 'canvas-start-with-hidden-notes-preparation', passed: true });
  });
  await session(browser, { preload: true, restore: true }, async ({ page }) => {
    await ready(page); await page.waitForFunction(() => __preloadProbe.draws > 0);
    assert.equal(await page.evaluate(() => __preloadProbe.createdDuringPreparation || false), false,
      'restored graph tab creates its engine only after preparation ends');
    assert.equal(await page.evaluate(() => P.state.activeTab), token);
    assert.equal(await page.evaluate(() => __preloadProbe.requests.filter(url => !url.includes('&signature=')).length), 1);
    report.regression.push({ kind: 'restored-visible-graph', passed: true });
  });
  await session(browser, { preload: true }, async ({ page, notes }) => {
    await ready(page); await prepared(page); fs.writeFileSync(path.join(notes, '笔记-0.md'), 'external prose without a link\n');
    await openGraph(page, 2);
    assert.equal(await page.locator('[data-role="graph-edge-count"]').textContent(), '0',
      'signature handoff checks real external edits before accepting the old topology');
    report.regression.push({ kind: 'external-edit-before-first-open', passed: true });
  });
  await session(browser, { preload: true, mode: 'no-notes', startWorkspace: 'canvas' }, async ({ page, resources }) => {
    await page.waitForFunction(() => window.RelatumStartWorkspace);
    assert.equal(await page.evaluate(() => RelatumBoot.noteGraphPreloadRequested), false);
    assert.equal(await page.locator('[data-start-workspace-panel="notes"]').count(), 0);
    assert(!resources.includes('/note-graph.js')); await hiddenResources(page);
    report.regression.push({ kind: 'notes-disabled', passed: true });
  });
  await session(browser, { preload: true, mode: 'full', editor: true }, async ({ page, resources }) => {
    await page.waitForFunction(() => window.CanvasModule);
    assert(!resources.includes('/note-graph.js')); assert(!resources.includes('/note-workspace.js'));
    assert.equal(await page.evaluate(() => __preloadProbe.requests.length), 0);
    report.regression.push({ kind: 'direct-canvas-editor', passed: true });
  });
  for (const kind of ['api-failure', 'script-failure', 'timeout', 'pagehide']) {
    await session(browser, { preload: true, setup: async page => {
      if (kind === 'script-failure') await page.route('**/note-graph.js*', route => route.abort('failed'));
      else await page.route('**/api/note-graph?*', async route => {
        if (kind === 'api-failure') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"offline"}' });
        await sleep(11000); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ root: '', signature: 'late', nodes: [], edges: [] }) }).catch(() => {});
      });
    } }, async ({ page }) => {
      if (kind === 'timeout' || kind === 'pagehide') {
        await page.waitForFunction(() => __preloadProbe.requests.length === 1);
        assert.equal(await page.evaluate(() => document.querySelector('.start-workspace-stage').inert), false);
        assert.equal(await page.locator('.note-graph-boot-status').count(), 0);
        await hiddenResources(page);
        if (kind === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      }
      await ready(page); await hiddenResources(page);
      if (kind !== 'pagehide') await page.waitForFunction(() =>
        performance.getEntriesByName('relatum:note-graph-preload-skipped').length > 0);
      if (kind === 'timeout') {
        const ended = await page.evaluate(() => performance.getEntriesByName('relatum:note-graph-preload-skipped')[0].startTime);
        const started = await page.evaluate(() => performance.getEntriesByName('relatum:note-graph-preload-start')[0].startTime);
        assert(ended - started >= 10000, 'request timeout is independent of usable startup');
      }
      assert.equal(await page.evaluate(() => __preloadProbe.scenes?.size || 0), 0, 'failure/cancellation never caches a late empty graph');
      await page.unroute('**/api/note-graph?*'); await page.unroute('**/note-graph.js*');
      if (kind !== 'pagehide') await openGraph(page, 2);
      report.regression.push({ kind, passed: true }); console.log('graph startup recovery ' + kind + ': passed');
    });
  }
}
async function benchmark(browser) {
  assert(!release, 'benchmarks use cold browser contexts and a fresh isolated server per sample');
  for (const count of [398, 3000]) for (let round = 0; round < 3; round++) for (const preload of [false, true]) {
    await session(browser, { preload, count, edges: count === 398 ? 79 : 2999, canvas: false }, async ({ page, context }) => {
      await ready(page); await hiddenResources(page);
      if (preload) await prepared(page);
      const cdp = await context.newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage');
      const memory = await cdp.send('Runtime.getHeapUsage');
      const startup = await page.evaluate(() => ({ startupMs: performance.getEntriesByName('relatum:notes-ready')[0].startTime,
        rawCacheBytes: __preloadProbe.bytes || 0, preparedMs: performance.getEntriesByName('relatum:note-graph-preload-ready')[0]?.startTime || 0 }));
      await page.evaluate(() => { __preloadProbe.openAt = performance.now(); P.activateGraphTab(); });
      await page.waitForFunction(() => __preloadProbe.firstDrawAt > 0);
      const open = await page.evaluate(() => ({ firstGraphMs: __preloadProbe.firstDrawAt - __preloadProbe.openAt,
        fullRequests: __preloadProbe.requests.filter(url => !url.includes('&signature=')).length,
        signatureRequests: __preloadProbe.requests.filter(url => url.includes('&signature=')).length }));
      const sample = { count, edges: count === 398 ? 79 : 2999, dpr: 2, round, preload, ...startup, ...open,
        idleJSHeapBytes: memory.usedSize };
      report.samples.push(sample); console.log(JSON.stringify(sample));
    });
  }
}
async function nativeBenchmark(browser) {
  for (const count of [398, 3000]) for (let round = 0; round < 3; round++) for (const preload of [false, true]) {
    await session(browser, { preload, count, edges: count === 398 ? 79 : 2999, canvas: false, nativeBenchmark: true },
      async ({ page, context, pid, startupMs }) => {
        if (preload) await prepared(page);
        assert.equal(await page.evaluate(() => !!window.RelatumNoteGraph), preload);
        assert.equal(await page.locator('[data-note-graph-label]').count(), 0);
        assert(await page.evaluate(() => { const canvas = document.querySelector('[data-role="note-graph-panel"] canvas');
          return !canvas || !canvas.hasAttribute('width') && !canvas.hasAttribute('height'); }),
        'native startup leaves the canvas shell at its untouched HTML dimensions');
        const cdp = await context.newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage');
        const memory = await cdp.send('Runtime.getHeapUsage');
        // Follow only this isolated launcher's descendants. No process names or command lines are emitted.
        const command = `$taskProcesses = Get-CimInstance Win32_Process; $taskIds = @(${pid}); `
          + 'do { $taskNew = @($taskProcesses | Where-Object { $taskIds -contains $_.ParentProcessId -and $taskIds -notcontains $_.ProcessId } | ForEach-Object ProcessId); $taskIds += $taskNew } while ($taskNew.Count); '
          + '$taskMemory = @(Get-Process -Id $taskIds -ErrorAction SilentlyContinue); '
          + '[pscustomobject]@{ bytes = ($taskMemory | Measure-Object WorkingSet64 -Sum).Sum; processes = $taskMemory.Count } | ConvertTo-Json -Compress';
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
        const total = JSON.parse(stdout.trim());
        await page.evaluate(() => {
          const began = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector('[data-note-graph-label]')) { window.nativeGraphFirstLabelMs = performance.now() - began; observer.disconnect(); }
          });
          observer.observe(document.querySelector('[data-role="note-graph-panel"]'), { childList: true, subtree: true });
          document.querySelector('[data-note-action="toggle-graph"]').click();
        });
        await page.waitForFunction(() => window.nativeGraphFirstLabelMs > 0);
        const sample = { native: true, count, round, preload, startupMs,
          firstGraphMs: await page.evaluate(() => nativeGraphFirstLabelMs),
          dpr: await page.evaluate(() => devicePixelRatio), idleJSHeapBytes: memory.usedSize,
          idleProcessWorkingSetBytes: total.bytes, processes: total.processes };
        report.samples.push(sample); console.log(JSON.stringify(sample));
      });
  }
}
(async () => {
  const browser = release ? null : await chromium.launch({ headless: true, executablePath: process.env.RELATUM_EDGE_PATH });
  try {
    if (!process.argv.includes('--benchmark-only')) await regression(browser);
    if (!process.argv.includes('--regression-only') && (!release || process.argv.includes('--benchmark-only'))) {
      await (release ? nativeBenchmark : benchmark)(browser);
    }
  } finally {
    await browser?.close();
    if (process.env.RELATUM_NOTE_GRAPH_REPORT) fs.writeFileSync(process.env.RELATUM_NOTE_GRAPH_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

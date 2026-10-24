'use strict';
// Focused production-shell verification with isolated data and test-only observation hooks.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-system-artifacts-'));
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function run(browser, mode) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-system-data-'));
  fs.mkdirSync(path.join(data, 'notes')); fs.mkdirSync(path.join(data, 'data'));
  const note = '# Main\n\n' + 'A paragraph for scroll and selection verification.\n\n'.repeat(180);
  fs.writeFileSync(path.join(data, 'notes/Main.md'), note);
  fs.writeFileSync(path.join(data, 'notes/Diagram.md'), '# Diagram\n\n```mermaid\nflowchart LR\n A[中文] --> B[测试]\n```\n');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(data, 'notes/N' + i + '.md'), '# Note ' + i + '\n\n[[Main]]\n');
  fs.writeFileSync(path.join(data, 'data/note-notebooks.json'), JSON.stringify({ version: 1, colors: {}, ui: { open: true, mode: 'notebooks', selectedRoot: '', expanded: [] } }));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const enabled = ['notes', ...(mode === 'minimal' ? [] : ['notes.graph', 'notes.mermaid'])];
  const profile = mode === 'full' ? [] : ['--launch-profile', JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(f => [f.id, enabled.includes(f.id)])) })];
  const number = await port(), url = 'http://127.0.0.1:' + number;
  let logs = '';
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(number), ...profile], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', x => { logs += x; }); server.stderr.on('data', x => { logs += x; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'no-preference' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.stack)); page.on('request', request => requests.push(request.url()));
  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, runDocumentPrefetch, stopDocumentPrefetch, cacheDocument, setViewMode, get prefetchRunning(){return prefetchRunning;}, editorInputPending, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.route('**/note-graph.js*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(repo, 'assets/note-graph.js'), 'utf8').replace('    return { activate, deactivate, preload,', '    global.systemGraph = {get engine(){return engine;}, scenes};\n    return { activate, deactivate, preload,') }));
    await page.route('**/note-mermaid.js*', route => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(repo, 'assets/note-mermaid.js'), 'utf8').replace('  window.RelatumNoteMermaid =', '  window.systemMermaid = {cache, heightHints};\n  window.RelatumNoteMermaid =') }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteFocusMode:v1', '0'); localStorage.setItem('canvas:noteActivePath:v1', 'Main.md'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]'); });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Main.md' && !T.state.openingPath);
    await page.waitForFunction(() => T.state.entryIndex.size >= 14 && !T.prefetchRunning);
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSystem:v1')), null, 'startup never writes default policy');
    const dialog = page.locator('dialog.relatum-settings');
    const open = async () => { const gear = page.locator('[data-note-action="toggle-settings"]'); await (await gear.isVisible() ? gear : page.locator('[data-note-action="toggle-library-settings"]')).click(); await dialog.waitFor(); await dialog.locator('nav [data-settings-category="system"]').click(); };
    const close = async () => { await dialog.locator('[data-settings-action="close"]').click(); await dialog.waitFor({ state: 'hidden' }); };
    await open();
    assert.equal(await dialog.locator('nav button').last().textContent(), '系统');
    assert.equal(await dialog.locator('[data-system-field="renderScale"]').count(), mode === 'minimal' ? 0 : 1);
    assert.equal(await dialog.locator('[data-role="note-graph-preload"]').count(), mode === 'minimal' ? 0 : 1);
    await page.evaluate(() => { window.keptView = T.editor.view; window.keptDoc = keptView.state.doc; window.keptCurrent = T.state.current; });
    await dialog.locator('[data-system-preset="economy"]').click();
    assert.deepEqual(await page.evaluate(() => RelatumNoteSystem.read()), { animations: false, prefetch: false, cache: 'small', renderScale: .75 });
    assert(await page.evaluate(() => RelatumNoteSystem.motion.matches));
    assert.equal(await dialog.evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length), 0, 'disabling animations settles current settings motion');
    await dialog.locator('summary').click();
    await dialog.locator('[data-system-field="prefetch"]').check();
    assert((await dialog.locator('.note-system-current').textContent()).includes('自定义'));
    await dialog.locator('[data-system-field="prefetch"]').uncheck();
    const capacities = await page.evaluate(() => {
      T.stopDocumentPrefetch();
      for (let i = 0; i < 14; i++) T.cacheDocument({ path: 'cache-' + i, content: 'x', editGeneration: 0, persistedGeneration: 0 });
      return { count: T.state.documentCache.size, pinned: T.state.documentCache.get('Main.md') === keptCurrent };
    });
    assert(capacities.count <= 6 && capacities.pinned, 'small cache trims immediately and preserves current document');
    await page.evaluate(() => T.cacheDocument({ path: 'pending-test', content: 'unsaved', editGeneration: 1, persistedGeneration: 0 }));
    await dialog.locator('[data-system-clear]').click();
    assert(await page.evaluate(() => T.state.documentCache.has('pending-test') && T.state.documentCache.get('Main.md') === keptCurrent));
    assert(await page.evaluate(() => T.editor.view === keptView && T.editor.view.state.doc === keptDoc), 'policy changes and clearing never rebuild the editor');
    await page.evaluate(() => T.state.documentCache.delete('pending-test'));
    // A response already in flight may serve the foreground, but cannot refill a cleared/disabled prefetch cache.
    let releaseRead, requestedRead;
    const readSeen = new Promise(resolve => { requestedRead = resolve; });
    await page.route('**/api/note?path=*', async route => { requestedRead(); await new Promise(resolve => { releaseRead = resolve; }); await route.continue(); });
    await page.evaluate(() => { RelatumNoteSystem.update({ prefetch: true }); T.stopDocumentPrefetch(); window.prefetchDone = T.runDocumentPrefetch(); });
    await Promise.race([readSeen, pause(4000).then(() => { throw new Error('Prefetch did not start'); })]);
    await page.evaluate(() => RelatumNoteSystem.update({ prefetch: false }));
    releaseRead(); await page.evaluate(() => prefetchDone);
    assert.equal(await page.evaluate(() => T.state.documentCache.size), 1, 'late disabled prefetch does not refill cache');
    await page.unroute('**/api/note?path=*');
    // Searching a collapsed advanced field opens its details and focuses the actual input.
    await dialog.locator('summary').click();
    await dialog.locator('[data-settings-search]').fill('正文预读');
    await dialog.locator('.relatum-settings-result').first().click();
    assert(await page.evaluate(() => document.activeElement?.dataset.systemField === 'prefetch'));
    await dialog.locator('[data-system-preset="balanced"]').click();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => RelatumNoteSystem.motion.matches);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForFunction(() => !RelatumNoteSystem.motion.matches);
    await dialog.locator('[data-system-preset="switching"]').click();
    await close(); await page.reload();
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.state.active);
    assert.equal(await page.evaluate(() => RelatumNoteSystem.read().cache), 'large');
    await open();
    if (mode !== 'minimal') {
      await dialog.locator('summary').click(); await dialog.locator('[data-role="note-graph-preload"]').check();
      await dialog.locator('nav [data-settings-category="graph"]').click();
      await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteGraphPreload:v1')), '1', 'graph category reset preserves system startup choice');
      await dialog.locator('nav [data-settings-category="system"]').click();
    }
    await dialog.locator('[data-settings-action="reset-category"]').click(); await dialog.locator('[data-settings-action="accept-reset"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteSystem:v1')), null);
    if (mode !== 'minimal') assert.equal(await page.evaluate(() => localStorage.getItem('canvas:noteGraphPreload:v1')), null);
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    assert.equal(await dialog.locator('nav button').last().textContent(), 'System');
    for (const [theme, width] of [['light', 1440], ['dark', 560]]) {
      await page.setViewportSize({ width, height: 980 }); await page.evaluate(theme => { document.body.dataset.startTheme = theme; }, theme);
      await page.screenshot({ path: path.join(artifacts, mode + '-' + theme + '.png') });
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'system settings fit the window');
    }
    await page.setViewportSize({ width: 1440, height: 980 }); await close();
    if (mode === 'full') {
      await page.evaluate(() => T.setViewMode('source'));
      await page.evaluate(() => T.editor.view.focus()); await page.keyboard.press('Control+End'); await page.keyboard.type('system-check');
      await page.waitForFunction(() => T.editor.view.state.doc.toString().endsWith('system-check'));
      await open(); await dialog.locator('[data-system-preset="economy"]').click(); await dialog.locator('[data-system-clear]').click(); await close();
      await page.evaluate(() => T.editor.view.focus()); await page.keyboard.press('Control+z');
      assert.equal(await page.evaluate(() => T.editor.view.state.doc.toString()), note, 'clearing and policy changes preserve native undo');
      await page.evaluate(() => CanvasNoteWorkspace.flushSave());
      await page.evaluate(() => T.setViewMode('live'));
    }
    if (mode !== 'minimal') {
      await page.evaluate(() => T.openNote('Diagram.md'));
      await page.evaluate(() => T.setViewMode('reading'));
      const diagramStage = page.locator('[data-role="note-reading-view"] .note-mermaid-stage').first();
      await diagramStage.locator('svg').waitFor();
      const diagram = await diagramStage.boundingBox();
      await open(); await dialog.locator('[data-system-preset="economy"]').click(); await dialog.locator('[data-system-clear]').click(); await close();
      assert.equal(await diagramStage.locator('svg').count(), 1, 'cache clearing preserves active diagrams');
      assert.deepEqual(await diagramStage.boundingBox(), diagram);
      await page.locator('[data-note-action="toggle-graph"]').click();
      await page.waitForFunction(() => window.systemGraph?.engine?.hasNodes());
      const result = await page.evaluate(() => {
        const engine = systemGraph.engine, before = engine.view;
        RelatumNoteSystem.update({ renderScale: .5 });
        window.keptGraphEngine = engine; window.keptGraphView = before;
        return true;
      }); assert(result);
      await pause(100);
      assert(await page.evaluate(() => systemGraph.engine === keptGraphEngine && JSON.stringify(systemGraph.engine.view) === JSON.stringify(keptGraphView)));
      assert(await page.evaluate(() => Math.abs(systemGraph.engine.canvas.width - systemGraph.engine.canvas.clientWidth * devicePixelRatio * .5) <= 1));
      await open(); await dialog.locator('[data-system-clear]').click(); await close();
      assert(await page.evaluate(() => systemGraph.engine === keptGraphEngine), 'clear never destroys an active graph');
      await page.evaluate(() => T.openNote('Main.md'));
      await page.waitForFunction(() => !systemGraph.engine);
    } else assert(!requests.some(url => /note-graph\.js|note-mermaid|vendor\/pele/.test(url)), 'disabled features remain unloaded');
    await page.evaluate(() => { window.rafCount = 0; window.originalRaf = requestAnimationFrame; window.requestAnimationFrame = fn => { rafCount++; return originalRaf(fn); }; });
    await pause(650); const idle = await page.evaluate(() => rafCount); await pause(500);
    assert.equal(await page.evaluate(() => rafCount), idle, 'no continuous RAF is introduced');
    assert.equal(fs.readFileSync(path.join(data, 'notes/Main.md'), 'utf8'), note);
    assert.deepEqual(errors, []); console.log(mode + ': system policy, lifecycle, caches, persistence and layout passed');
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, mode + '-failure.png') }).catch(() => {});
    console.error(logs.slice(-2200)); console.error(errors); throw error;
  } finally {
    await context.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of process.env.RELATUM_SYSTEM_MODES?.split(',') || ['full', 'notes-only', 'minimal']) await run(browser, mode); }
  finally { await browser.close(); console.log('Artifacts: ' + artifacts); }
})().catch(error => { console.error(error); process.exitCode = 1; });

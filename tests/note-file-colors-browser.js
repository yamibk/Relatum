'use strict';
// Production shell, disposable notes, and bounded synthetic directory fixtures.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-file-colors-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const data = path.join(output, 'isolated'), notes = path.join(data, 'notes');
  fs.mkdirSync(path.join(notes, 'Folder'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'Main.md'), '# File colors\n\nOriginal text.\n');
  fs.writeFileSync(path.join(notes, 'Folder/A.md'), 'Child note\n');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port), '--launch-profile', JSON.stringify(profile)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser, page;
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  try {
    const url = 'http://127.0.0.1:' + port; let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, renderTree, setNoteSettingsOpen, performMove, stopExternalSync, stopDocumentPrefetch, cancelStatistics, get colors(){return fileColorHost?.instance}, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
      localStorage.setItem('canvas:noteActivePath:v1', 'Main.md');
    });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.current?.path === 'Main.md' && T.editor && !T.state.openingPath);
    const left = '[data-role="note-tree"]', menu = page.locator('[data-role="note-context-menu"]');
    const row = value => page.locator(left + ' .note-tree-row[data-note-path="' + value + '"]');
    const enabled = value => page.evaluate(value => RelatumNoteExtensions.set('file-colors', { enabled: value }), value);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => RelatumNoteExtensions.read('file-colors').enabled), false);
    assert(!requests.some(url => /file-colors/.test(url)));
    assert(!fs.existsSync(path.join(data, 'data/note-file-colors.sqlite3')));
    await page.evaluate(() => T.setNoteSettingsOpen(true, { category: 'extensions' }));
    const dialog = page.locator('[data-role="note-settings-dialog"]');
    await dialog.locator('[data-extension-configure="file-colors"]').click();
    assert((await dialog.locator('.note-file-colors-guide').innerText()).includes('子项不会继承'));
    assert(!requests.some(url => /note-extensions\/file-colors\.js/.test(url)), 'settings stay metadata-only');
    await dialog.locator('[data-extension-enabled="file-colors"]:visible').check();
    await page.waitForFunction(() => T.colors);
    await dialog.locator('[data-settings-action="close"]').click();
    await row('Main.md').waitFor();
    await page.evaluate(() => { window.originalRow = document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]'); window.originalEditor = T.editor.view; });
    await row('Main.md').click({ button: 'right' });
    const first = menu.locator('.note-notebook-colors button').first(); await first.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.locator('button:focus').getAttribute('data-color'), 'blue', 'palette uses existing keyboard navigation');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await page.waitForFunction(() => document.querySelector('[data-note-path="Main.md"]').dataset.fileColor === 'blue');
    await page.waitForTimeout(150);
    assert(fs.existsSync(path.join(data, 'data/note-file-colors.sqlite3')));
    assert(await page.evaluate(() => window.originalRow === document.querySelector('[data-role="note-tree"] [data-note-path="Main.md"]') && window.originalEditor === T.editor.view));
    const appearance = () => row('Main.md').evaluate(element => ({ bg: getComputedStyle(element).backgroundColor,
      icon: getComputedStyle(element.querySelector('.note-tree-icon')).color, name: getComputedStyle(element.querySelector('.note-tree-label')).color,
      text: getComputedStyle(element).color }));
    let style = await appearance(); assert.equal(style.icon, 'rgb(94, 136, 189)'); assert.equal(style.name, style.text); assert.notEqual(style.bg, 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(output, 'light.png') });
    await page.evaluate(() => document.body.dataset.startTheme = 'dark'); await settle();
    style = await appearance(); assert.equal(style.icon, 'rgb(94, 136, 189)'); assert.equal(style.name, style.text);
    await page.screenshot({ path: path.join(output, 'dark.png') });
    await enabled(false); await page.waitForFunction(() => !T.colors);
    assert.equal(await page.locator(left).getAttribute('data-file-colors-enabled'), null);
    const disabledRequests = requests.filter(url => url.includes('/api/note-file-colors/')).length;
    await page.evaluate(() => T.renderTree()); await pause(100);
    assert.equal(requests.filter(url => url.includes('/api/note-file-colors/')).length, disabledRequests);
    await enabled(true); await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await row('Folder').click({ button: 'right' }); await menu.locator('[data-color="green"]').click();
    await row('Folder').click(); await row('Folder/A.md').waitFor();
    assert.equal(await row('Folder/A.md').getAttribute('data-file-color'), null, 'folder colors do not inherit');
    await page.waitForTimeout(100);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => !T.colors);
    const pausedQueries = requests.filter(url => url.includes('/api/note-file-colors/query')).length;
    await pause(100);
    assert.equal(requests.filter(url => url.includes('/api/note-file-colors/query')).length, pausedQueries);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => T.colors?.get('Main.md') === 'blue');
    await page.route('**/api/note-file-colors/set', route => route.fulfill({ status: 503, json: { error: 'Fixture save failure' } }));
    await page.evaluate(() => T.colors.set('Main.md', 'red'));
    assert.equal(await row('Main.md').getAttribute('data-file-color'), 'blue', 'failed save restores the confirmed color');
    await page.unroute('**/api/note-file-colors/set');
    await page.waitForFunction(async () => (await (await fetch('/api/note-index-state')).json()).phase === 'ready');
    assert.equal(await page.evaluate(() => T.performMove('Main.md', 'Renamed.md', false)), true,
      await page.evaluate(() => T.state.lastMoveError + ' [' + T.state.lastMoveCode + ']'));
    await page.waitForFunction(() => T.colors?.get('Renamed.md') === 'blue');
    await row('Renamed.md').click({ button: 'right' }); await menu.getByRole('button', { name: '清除颜色', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-tree"] [data-note-path="Renamed.md"]').dataset.fileColor === undefined);
    const report = [];
    const measure = () => page.evaluate(() => {
      const rounds = [];
      for (let i = 0; i < 5; i++) { const start = performance.now(); T.renderTree({ entryIndexReady: true }); rounds.push(performance.now() - start); }
      return rounds.sort((a, b) => a - b)[2];
    });
    await page.evaluate(() => { T.stopExternalSync(); T.stopDocumentPrefetch(); T.cancelStatistics(); });
    await page.route('**/api/note-file-colors/query', async route => {
      const { paths } = route.request().postDataJSON(); assert(paths.length <= 512);
      await route.fulfill({ json: { generation: 100, colors: Object.fromEntries(paths.filter(value => value.startsWith('Perf-')).map(value => [value, 'blue'])) } });
    });
    for (const count of [1000, 10000]) {
      await page.evaluate(count => {
        T.state.entries = Array.from({ length: count }, (_, i) => ({ kind: 'note', name: 'Perf-' + String(i).padStart(5, '0'),
          path: 'Perf-' + String(i).padStart(5, '0') + '.md', modifiedNs: 1, createdNs: 1, size: 1 }));
        T.state.treePagination = { '': { offset: count, total: count, hasMore: false, generation: 0 } };
        T.colors.invalidate(); T.renderTree();
      }, count);
      await page.waitForFunction(count => T.colors?.get('Perf-' + String(count - 1).padStart(5, '0') + '.md') === 'blue', count);
      await pause(100);
      const enabledRenderMs = await measure();
      const queryCount = requests.filter(url => url.includes('/api/note-file-colors/query')).length;
      const result = await page.evaluate(async count => {
        const host = document.querySelector('[data-role="note-tree"]'), scroller = document.querySelector('[data-role="note-sidebar-scroll"]');
        const firstRow = host.querySelector('.note-tree-row');
        const start = performance.now(); T.colors.decorate(firstRow, firstRow.dataset.notePath); const paintMs = performance.now() - start;
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { count, paintMs, domRows: host.querySelectorAll('.note-tree-row').length, colored: !!host.querySelector('[data-file-color="blue"]') };
      }, count);
      assert(result.domRows < 200 && result.colored, 'large trees remain windowed and decorated');
      await pause(100);
      assert.equal(requests.filter(url => url.includes('/api/note-file-colors/query')).length, queryCount, 'scrolling never queries per row');
      await enabled(false); const disabledRenderMs = await measure();
      await enabled(true);
      await page.waitForFunction(count => T.colors?.get('Perf-' + String(count - 1).padStart(5, '0') + '.md') === 'blue', count);
      report.push({ ...result, enabledRenderMs, disabledRenderMs });
    }
    await page.waitForTimeout(500);
    const rafs = await page.evaluate(async () => {
      const original = window.requestAnimationFrame; let calls = 0;
      window.requestAnimationFrame = callback => { calls++; return original(callback); };
      await new Promise(resolve => setTimeout(resolve, 250)); window.requestAnimationFrame = original; return calls;
    });
    assert.equal(rafs, 0, 'idle extension has no RAF loop');
    await page.evaluate(() => RelatumNoteExtensions.reset());
    assert.equal(await page.locator(left).getAttribute('data-file-colors-enabled'), null);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, performance: report, idleRafs: rafs }, null, 2));
    console.log('PASS file colors; artifacts: ' + output + '; ' + JSON.stringify(report));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Artifacts: ' + output + '\n' + logs); throw error;
  } finally {
    await browser?.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

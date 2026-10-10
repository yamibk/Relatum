'use strict';
// Real service + browser; all documents live under disposable roots.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(browser, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-discovery-'));
  const notes = path.join(root, 'notes'), canvases = path.join(notes, 'canvases');
  fs.mkdirSync(path.join(notes, 'Book'), { recursive: true });
  fs.mkdirSync(canvases);
  fs.writeFileSync(path.join(notes, 'A.md'), '![shared](canvases/Shared.canvas)\n![again](canvases/Shared.canvas)\n![lost](canvases/Lost.canvas)\n');
  fs.writeFileSync(path.join(notes, 'Book/B.md'), '![shared](../canvases/SHARED.canvas)\n');
  fs.writeFileSync(path.join(canvases, 'Shared.canvas'), JSON.stringify({ version: 2, nodes: [], edges: [] }));
  for (let i = 1; i <= 65; i++) fs.writeFileSync(path.join(canvases, `C${i}.canvas`), 'not JSON: catalog must not read bodies');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const args = ['app.py', '--no-browser', '--port', String(port)];
  if (mode !== 'full') {
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
    const features = Object.fromEntries(catalog.features.map(f => [f.id, f.id === 'notes' || mode === 'notes-only' && f.id === 'notes.canvas']));
    args.push('--launch-profile', JSON.stringify({ version: 1, features }));
  }
  const server = spawn(process.env.RELATUM_PYTHON || 'python', args, { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    let workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8');
    workspace = workspace.replace('  window.CanvasNoteWorkspace = {', '  window.T = {state, openNote, setViewMode, get editor(){return liveEditor;}, get browser(){return noteBrowser;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteView:v1', 'source'); });
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized && T.state.active);
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('[data-note-browser-provider="recent"]').waitFor();
    assert.equal(await page.locator('.note-browser-results-head').count(), 0, 'opening navigation leaves the document unchanged');
    assert(!requests.some(r => r.includes('/api/notes-canvas/')), 'ordinary browse startup must not query canvas catalog');
    const nav = page.locator('[data-note-browser-provider="canvas"]');
    if (mode === 'disabled') {
      assert.equal(await nav.count(), 0);
      assert.equal((await fetch(url + '/api/notes-canvas/list')).status, 403);
      assert.equal((await fetch(url + '/api/notes-canvas/references?path=canvases/Shared.canvas')).status, 403);
      assert.deepEqual(errors, []); return;
    }
    await nav.click();
    const allCount = () => page.locator('.note-browser-canvas').count();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 50);
    assert((await page.locator('.note-browser-results-head').innerText()).includes('67'));
    assert.equal(await page.locator('.note-browser-canvas').nth(1).getAttribute('data-note-browser-canvas'), 'canvases/C2.canvas');
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 67);
    const shared = page.locator('[data-note-browser-canvas="canvases/Shared.canvas"]');
    assert((await shared.innerText()).includes('被 2 篇笔记引用'));
    await shared.locator('.note-browser-canvas-heading').click();
    await shared.locator('.note-browser-reference').first().waitFor();
    assert.equal(await shared.locator('.note-browser-reference').count(), 2);
    await page.screenshot({ path: path.join(root, 'canvas-light.png') });
    const lost = page.locator('[data-note-browser-canvas="canvases/Lost.canvas"]');
    assert.equal(await lost.locator('.note-browser-canvas-reveal').isDisabled(), true);
    assert.equal((await fetch(url + '/api/notes-canvas/list?limit=51')).status, 400);
    assert.equal((await fetch(url + '/api/notes-canvas/list?offset=invalid')).status, 400);
    assert.equal((await fetch(url + '/api/notes-canvas/references?path=../outside.canvas')).status, 403);
    // Invoke no native Explorer: verify the browser reuses the authorized endpoint.
    let revealed;
    await page.route('**/api/notes-canvas/reveal', route => { revealed = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
    await shared.locator('.note-browser-canvas-reveal').click();
    assert.deepEqual(revealed, { path: 'canvases/Shared.canvas' });
    await page.locator('.note-browser-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const beforeScroll = await page.locator('.note-browser-results').evaluate(node => node.scrollTop);
    await shared.locator('[data-note-browser-path="A.md"]').click();
    await page.waitForFunction(() => T.state.current?.path === 'A.md' && !document.querySelector('[data-role="note-browser-back"]').hidden);
    await page.locator('[data-role="note-browser-back"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 67);
    assert.equal(await shared.locator('.note-browser-canvas-heading').getAttribute('aria-expanded'), 'true');
    assert.equal(await shared.locator('.note-browser-reference').count(), 2);
    assert(Math.abs(await page.locator('.note-browser-results').evaluate(node => node.scrollTop) - beforeScroll) < 5, 'back restores scrolling');
    assert(!requests.some(r => /note-canvas\/|\/api\/notes-canvas\/read/.test(r)), 'catalog and source opening do not load drawing engine');
    if (mode === 'notes-only') { assert.deepEqual(errors, []); return; }
    await page.evaluate(() => { window.__canvasRow = document.querySelector('.note-browser-canvas'); });
    await page.evaluate(() => T.browser.checkExternalCanvases());
    assert(await page.evaluate(() => __canvasRow === document.querySelector('.note-browser-canvas')), 'unchanged catalog retains DOM');
    await page.locator('[data-canvas-filter="unused"]').click();
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head').textContent.includes('65'));
    assert.equal(await allCount(), 50);
    await page.locator('[data-canvas-filter="missing"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 1);
    assert.equal(await lost.count(), 1);
    // Delayed earlier selection cannot overwrite a newer filter.
    let release, captured;
    const capturedPromise = new Promise(resolve => { captured = resolve; });
    await page.route('**/api/notes-canvas/list?*', async route => {
      if (new URL(route.request().url()).searchParams.get('filter') === 'unused' && !release) {
        await new Promise(resolve => { release = resolve; captured(); });
      }
      await route.continue();
    });
    await page.locator('[data-canvas-filter="unused"]').click(); await capturedPromise;
    await page.locator('[data-canvas-filter="missing"]').click();
    release(); await pause(300);
    assert.equal(await allCount(), 1);
    await page.unroute('**/api/notes-canvas/list?*');
    await page.locator('[data-canvas-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 50);
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 67);
    fs.writeFileSync(path.join(canvases, 'Z-new.canvas'), '{}');
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head').textContent.includes('68'), null, { timeout: 35000 });
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 68);
    assert.equal(await allCount(), 68, 'automatic refresh preserves loaded pages');
    fs.unlinkSync(path.join(canvases, 'Shared.canvas'));
    await page.evaluate(() => CanvasNoteWorkspace.refresh());
    await page.waitForFunction(() => document.querySelector('[data-note-browser-canvas="canvases/Shared.canvas"] .note-browser-canvas-reveal').disabled);
    // Incomplete scan replaces counts with an explicit retry state.
    fs.writeFileSync(path.join(notes, 'bad.md'), Buffer.from([255]));
    await page.evaluate(() => CanvasNoteWorkspace.refresh());
    await page.waitForFunction(() => document.querySelector('.note-browser-message')?.textContent.includes('统计未完成'));
    assert.equal(await allCount(), 0);
    fs.unlinkSync(path.join(notes, 'bad.md'));
    await page.locator('button.note-browser-message').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 50);
    await page.locator('[data-canvas-filter="missing"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 2);
    if (await shared.locator('.note-browser-canvas-heading').getAttribute('aria-expanded') !== 'true') await shared.locator('.note-browser-canvas-heading').click();
    await shared.locator('[data-note-browser-path="A.md"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="note-browser-back"]').hidden);
    await page.route('**/api/note-save', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Simulated disk failure"}' }));
    await page.evaluate(() => T.editor.replaceSelection('保存检查\n'));
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/note-save') && response.status() === 500), page.locator('[data-role="note-browser-back"]').click()]);
    assert.equal(await page.locator('.note-browser-showing-results').count(), 0, 'failed save keeps document');
    await page.unroute('**/api/note-save');
    await page.locator('[data-role="note-browser-back"]').click();
    await page.waitForFunction(() => document.querySelector('.note-browser-showing-results'));
    assert(fs.readFileSync(path.join(notes, 'A.md'), 'utf8').includes('保存检查'));
    await page.evaluate(() => { RelatumI18n.setLanguage('en'); document.body.dataset.startTheme = document.documentElement.dataset.startTheme = 'dark'; });
    assert.equal(await nav.innerText(), 'Canvas');
    assert((await shared.innerText()).includes('Referenced by 2 notes'));
    await page.screenshot({ path: path.join(root, 'canvas-dark.png') });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.screenshot({ path: path.join(root, 'canvas-narrow.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow view does not overflow');
    // A delayed reference reply is discarded when the row is collapsed/reopened.
    await page.setViewportSize({ width: 1440, height: 900 });
    let releaseReference, capturedReference;
    const referenceSeen = new Promise(resolve => { capturedReference = resolve; });
    await page.route('**/api/notes-canvas/references?*', async route => {
      if (new URL(route.request().url()).searchParams.get('path') === 'canvases/Lost.canvas' && !releaseReference) {
        await new Promise(resolve => { releaseReference = resolve; capturedReference(); });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ path: 'Stale.md', title: 'Stale' }], total: 1, hasMore: false, signature: 'old' }) });
      }
      await route.continue();
    });
    await lost.locator('.note-browser-canvas-heading').click();
    await referenceSeen;
    await lost.locator('.note-browser-canvas-heading').click();
    await lost.locator('.note-browser-canvas-heading').click();
    await lost.locator('.note-browser-reference').waitFor();
    releaseReference(); await pause(200);
    assert.equal(await lost.locator('[data-note-browser-path="Stale.md"]').count(), 0);
    await page.unroute('**/api/notes-canvas/references?*');
    await page.locator('[data-canvas-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 50);
    await page.locator('[data-note-action="toggle-browser"]').click();
    assert.equal(await page.locator('.note-browser-showing-results').count(), 1, 'collapsing navigation leaves canvas results visible');
    await page.evaluate(() => { window.__collapsedCanvasRow = document.querySelector('.note-browser-canvas'); });
    await page.evaluate(() => T.browser.checkExternalCanvases());
    assert(await page.evaluate(() => __collapsedCanvasRow === document.querySelector('.note-browser-canvas')), 'unchanged checks keep rows while navigation is collapsed');
    fs.writeFileSync(path.join(canvases, 'External.canvas'), 'catalog only');
    await page.evaluate(() => T.browser.checkExternalCanvases());
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head').textContent.includes('69'));
    await page.locator('[data-canvas-filter="missing"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 2);
    assert.equal(await lost.count(), 1, 'filters remain usable with collapsed navigation');
    await page.evaluate(() => T.browser.suspend({ keepView: true }));
    const requestsBefore = requests.filter(r => r.includes('/api/notes-canvas/list')).length;
    await page.evaluate(() => T.browser.checkExternalCanvases());
    assert.equal(requests.filter(r => r.includes('/api/notes-canvas/list')).length, requestsBefore, 'suspended browser does not poll');
    assert.deepEqual(errors, []);
  } finally { await context.close(); server.kill(); console.log(mode + ': isolated fixtures ' + root); }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { for (const mode of ['full', 'notes-only', 'disabled']) await run(browser, mode); }
  finally { await browser.close(); }
  console.log('canvas browser discovery: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });

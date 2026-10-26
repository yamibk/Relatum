'use strict';

// A single production page, isolated notes, and a filesystem recycle substitute.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-context-'));
const notes = path.join(root, 'notes');
fs.mkdirSync(path.join(notes, 'canvases/B-other.assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'recycled'));
const source = '![shared](canvases/A-shared.canvas)\n\n![other](canvases/B-other.canvas)\n\n![lost](canvases/Missing.canvas)\n';
for (const name of ['A.md', 'B.md']) fs.writeFileSync(path.join(notes, name), source);
const emptyCanvas = JSON.stringify({ version: 2, nodes: [], edges: [] });
for (const name of ['A-shared', 'B-other']) fs.writeFileSync(path.join(notes, `canvases/${name}.canvas`), emptyCanvas);
fs.writeFileSync(path.join(notes, 'canvases/B-other.assets/asset.txt'), 'asset');
for (let i = 0; i <= 50; i++) fs.writeFileSync(path.join(notes, `canvases/C${String(i).padStart(2, '0')}.canvas`), 'not JSON');

(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const helper = 'import app,shutil; from pathlib import Path; ' +
    'app._move_paths_to_recycle_bin=lambda targets: [shutil.move(str(p),str(Path(app.ROOT)/"recycled"/p.name)) for p in targets]; app.main()';
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', helper, '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser, logs = '';
  service.stdout.on('data', data => { logs += data; }); service.stderr.on('data', data => { logs += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url + '/api/runtime')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [], recycleRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/notes-canvas/trash-file')) recycleRequests.push(request.postDataJSON()); });
    const script = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state,openNote,closeAllTabs,setViewMode,flushSave,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteView:v1', 'source'); });
    await page.goto(url);
    await page.waitForFunction(() => window.T?.state.initialized && T.state.active && !T.state.openingPath);
    await page.evaluate(() => T.closeAllTabs());
    assert.equal(await page.evaluate(() => T.state.current), null);
    await page.waitForFunction(async () => {
      const response = await fetch('/api/notes-canvas/list?limit=1');
      return response.ok && (await response.json()).total === 54;
    });
    await page.locator('[data-note-action="toggle-browser"]').click();
    const nav = page.locator('[data-note-browser-provider="canvas"]');
    await nav.click();
    const card = name => page.locator(`[data-note-browser-canvas="canvases/${name}.canvas"]`);
    const menu = page.locator('[data-role="note-context-menu"]');
    const action = name => menu.locator(':scope > button').filter({ hasText: name });
    const count = () => page.locator('.note-browser-canvas').count();
    async function openMenu(name, keyboard = false) {
      const heading = card(name).locator('.note-browser-canvas-heading');
      if (keyboard) { await heading.focus(); await heading.press('Shift+F10'); }
      else await heading.click({ button: 'right' });
      await menu.waitFor({ state: 'visible' });
      assert.deepEqual(await menu.locator(':scope > button').allTextContents(), ['重命名', '在系统资源管理器中打开', '移到系统回收站']);
    }
    async function recycle(name) {
      await openMenu(name);
      const response = page.waitForResponse(response => response.url().endsWith('/api/notes-canvas/trash-file'));
      await action('移到系统回收站').click();
      assert.equal((await response).status(), 200);
      await page.waitForFunction(() => !document.querySelector('.note-workspace').inert);
    }
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 50);
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 54);
    await openMenu('Missing');
    assert.equal(await menu.locator(':scope > button:disabled').count(), 3);
    await page.keyboard.press('Escape');
    let revealed;
    await page.route('**/api/notes-canvas/reveal', route => { revealed = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); });
    await openMenu('A-shared', true);
    assert.equal(await action('重命名').evaluate(node => node === document.activeElement), true);
    await page.screenshot({ path: path.join(root, 'canvas-menu.png') });
    await action('在系统资源管理器中打开').click();
    assert.deepEqual(revealed, { path: 'canvases/A-shared.canvas' });
    assert.equal(await page.evaluate(() => !!window.RelatumNoteCanvas), false, 'listing/menu/reveal do not load the engine');

    await openMenu('A-shared');
    const stale = await action('移到系统回收站').elementHandle();
    await page.locator('[data-canvas-filter="unused"]').click();
    await page.waitForFunction(() => document.querySelector('[data-canvas-filter="unused"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.note-browser-results').getAttribute('aria-busy') === 'false');
    await stale.evaluate(node => node.click());
    assert.equal(recycleRequests.length, 0, 'old menu cannot act after a filter switch');
    await page.locator('[data-canvas-filter="all"]').click();
    await card('A-shared').waitFor();
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-canvas').length === 54);
    await card('B-other').locator('.note-browser-canvas-heading').click();
    await card('B-other').locator('.note-browser-reference').first().waitFor();
    await card('B-other').locator('.note-browser-reference').first().click({ button: 'right' });
    assert(await menu.isHidden(), 'reference note rows never open a canvas menu');
    await page.keyboard.press('Escape');
    await openMenu('A-shared');
    await menu.click({ button: 'right' });
    await menu.waitFor({ state: 'hidden' });

    await openMenu('A-shared');
    const scroll = await page.locator('.note-browser-results').evaluate(node => node.scrollTop);
    await action('重命名').click();
    await page.locator('.note-modal-card input').fill('A-renamed');
    await page.locator('.note-modal-card button').filter({ hasText: '重命名' }).click();
    await card('A-renamed').waitFor();
    assert.equal(await count(), 54, 'rename retains loaded pages');
    assert.equal(await card('B-other').locator('.note-browser-canvas-heading').getAttribute('aria-expanded'), 'true');
    assert(Math.abs(await page.locator('.note-browser-results').evaluate(node => node.scrollTop) - scroll) < 5);
    const renamed = fs.readFileSync(path.join(notes, 'A.md'), 'utf8');
    assert(renamed.includes('canvases/A-renamed.canvas'));
    assert.equal(fs.readFileSync(path.join(notes, 'B.md'), 'utf8'), renamed);
    assert.equal(await page.evaluate(() => !!window.RelatumNoteCanvas), false, 'rename reads data without loading the engine');
    await page.route('**/api/notes-canvas/trash-file', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"recycle denied"}' }));
    await openMenu('A-renamed');
    await action('移到系统回收站').click();
    await page.waitForFunction(() => document.querySelector('[data-role="note-toast"]')?.textContent.includes('recycle denied'));
    assert(fs.existsSync(path.join(notes, 'canvases/A-renamed.canvas')));
    assert.equal(await count(), 54);
    await page.unroute('**/api/notes-canvas/trash-file');
    await recycle('A-renamed');
    await card('A-renamed').locator('.note-browser-missing').waitFor();
    assert(fs.existsSync(path.join(root, 'recycled/A-renamed.canvas')));
    await openMenu('A-renamed');
    assert.equal(await menu.locator(':scope > button:disabled').count(), 3);
    await page.keyboard.press('Escape');
    for (const name of ['A.md', 'B.md']) assert.equal(fs.readFileSync(path.join(notes, name), 'utf8'), renamed, 'recycle preserves every Markdown reference');
    await recycle('C50');
    await card('C50').waitFor({ state: 'detached' });
    assert.equal(await count(), 53, 'unreferenced files disappear without losing the second loaded page');

    await page.evaluate(() => T.openNote('A.md'));
    await page.evaluate(() => T.setViewMode('live'));
    await page.waitForFunction(() => [...document.querySelectorAll('.note-canvas-frame')].some(frame => frame.__noteCanvas?.session?.path === 'canvases/B-other.canvas'));
    // The embedded entry still uses the same rename operation and its existing session.
    await page.locator('.note-canvas-frame[data-canvas-source="canvases/B-other.canvas"]').click({ button: 'right' });
    await action('重命名').click();
    const embeddedRename = page.waitForResponse(response => response.url().endsWith('/api/notes-canvas/rename'));
    await page.locator('.note-modal-card button').filter({ hasText: '重命名' }).click();
    assert.equal((await embeddedRename).status(), 200);
    await page.evaluate(() => T.flushSave());
    await page.waitForFunction(() => [...document.querySelectorAll('.note-canvas-frame')].some(frame => frame.__noteCanvas?.session?.path === 'canvases/B-other.canvas'));
    await page.evaluate(() => { window.oldCanvas = [...document.querySelectorAll('.note-canvas-frame')].find(frame => frame.__noteCanvas?.session?.path === 'canvases/B-other.canvas').__noteCanvas.session; });
    await nav.click();
    await page.waitForFunction(() => document.querySelector('.note-browser-showing-results') && document.querySelector('.note-browser-results').getAttribute('aria-busy') === 'false');
    await recycle('B-other');
    await card('B-other').locator('.note-browser-missing').waitFor();
    await page.evaluate(async () => { oldCanvas.generation++; await oldCanvas.flush(); });
    assert(!fs.existsSync(path.join(notes, 'canvases/B-other.canvas')), 'old session cannot recreate the recycled file');
    assert(fs.existsSync(path.join(root, 'recycled/B-other.assets/asset.txt')), 'same-name companion moves with its canvas');
    for (const name of ['A.md', 'B.md']) assert.equal(fs.readFileSync(path.join(notes, name), 'utf8'), renamed);
    await page.evaluate(() => T.openNote('A.md'));
    await page.locator('.note-canvas-frame[data-canvas-source="canvases/B-other.canvas"] .is-unavailable').waitFor();
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), renamed, 'retained embeds show missing state without changing Markdown');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, artifacts: root }));
  } catch (error) {
    console.error(logs.slice(-5000));
    throw error;
  } finally {
    if (browser) await browser.close();
    service.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

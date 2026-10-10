'use strict';
// Isolated real API/browser regression, with a bounded probe for layout hangs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const release = process.argv[2] ? path.resolve(process.argv[2]) : '';
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const number = socket.address().port; await new Promise(resolve => socket.close(resolve)); return number;
}
async function run(browser, full, fallback = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-canvas-stability-'));
  fs.mkdirSync(path.join(root, 'notes/canvases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes/A.md'), 'Before\n\n![canvas|640x360](canvases/test.canvas)\n\nAfter\n');
  fs.writeFileSync(path.join(root, 'notes/canvases/test.canvas'), JSON.stringify({ version: 2, nodes: [], edges: [] }));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
  const features = Object.fromEntries(catalog.features.map(f => [f.id, ['notes', 'notes.canvas'].includes(f.id) || full && ['canvas', 'canvas.library'].includes(f.id)]));
  const number = await availablePort(), debugPort = release ? await availablePort() : 0;
  let url = `http://127.0.0.1:${number}`, connection, context, page;
  const profileArgs = ['--launch-profile', JSON.stringify({ version: 1, features })];
  const server = spawn(release ? path.join(release, 'Relatum.exe') : process.env.RELATUM_PYTHON || 'python',
    release ? profileArgs : ['app.py', '--no-browser', '--port', String(number), ...profileArgs],
    { cwd: release || repo, env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(release ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } : {}) }, windowsHide: true, stdio: 'ignore' });
  try {
    if (release) {
      for (let i = 0; i < 200; i++) {
        try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch (_) {}
        assert.equal(server.exitCode, null, 'test client stays running'); await pause(100);
      }
      connection = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      context = connection.contexts()[0];
      for (let i = 0; i < 100; i++) {
        page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100);
      }
      assert(page, 'native client page'); url = new URL(page.url()).origin;
      await page.setViewportSize({ width: 1440, height: 960 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    } else {
      for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {} await pause(100); }
      context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
      page = await context.newPage();
    }
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const workspace = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T = {state, openNote, setViewMode};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: workspace }));
    let engineSource = fs.readFileSync(path.join(release || repo, release ? '_internal/assets/note-canvas/engine.js' : 'assets/note-canvas/engine.js'), 'utf8');
    // A synchronous renderer loop otherwise prevents Playwright's page cleanup.
    engineSource = engineSource.replace('function layoutNode(el, node, measureText, preserveSize) {',
      'function layoutNode(el, node, measureText, preserveSize) { let probeSteps = 0; window.layoutCalls = (window.layoutCalls || 0) + 1;');
    engineSource = engineSource.replace('const fits=(size,boxWidth)=>{',
      'const fits=(size,boxWidth)=>{ window.fitSteps = Math.max(window.fitSteps || 0, ++probeSteps); if (probeSteps > 32) throw new Error("Auto-height did not converge: " + JSON.stringify({height:h,width:w,size,shape:style.shape}));');
    await page.route('**/note-canvas/engine.js*', route => route.fulfill({ contentType: 'text/javascript', body: engineSource }));
    await page.addInitScript(fallback => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteView:v1', 'live');
      if (fallback) window.Path2D = undefined;
    }, fallback);
    await page.goto(url); await page.waitForFunction(() => window.T?.state.initialized);
    await page.evaluate(() => T.openNote('A.md'));
    const frame = page.locator('.note-canvas-frame').first(), viewport = frame.locator('.note-canvas-viewport');
    await page.waitForFunction(() => document.querySelector('.note-canvas-frame')?.__noteCanvas?.engine);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function create(scale, shape = 'rounded-rect', patch = {}, text = '') {
      await page.evaluate(({ scale, shape, patch }) => {
        localStorage.setItem('canvas:noteCanvasNodeScale:v1', String(scale));
        localStorage.setItem('canvas:noteCanvasDefaults:v1', JSON.stringify({ node: { shape, ...patch } }));
      }, { scale, shape, patch });
      const box = await viewport.boundingBox(); await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await settle(); assert.deepEqual(errors, [], `double click at ${scale}% / ${shape}`);
      const input = viewport.locator('textarea'); assert.equal(await input.count(), 1);
      if (text) await input.fill(text);
      await settle(); assert.deepEqual(errors, [], `text at ${scale}% / ${shape}`);
      const dimensions = await input.evaluate(el => {
        const node = el.closest('[data-canvas-node]'); return { w: node.offsetWidth, h: node.offsetHeight };
      });
      assert(dimensions.w > 0 && dimensions.h > 0 && dimensions.h <= 6000);
      if (shape === 'circle' || shape === 'square') assert.equal(dimensions.w, dimensions.h);
      await input.press('Escape'); await settle();
      assert.equal(await viewport.locator('.note-canvas-node').count(), 0, 'cancelled creation restores the empty canvas');
      assert.equal(await frame.evaluate(el => el.__noteCanvas.session.past.length), 0);
    }
    // 95% used to freeze even an empty default rounded rectangle.
    await create(95);
    for (let scale = 50; scale <= 300; scale += 5) await create(scale);
    for (const [shape] of await page.evaluate(() => RelatumNoteCanvasStyle.shapes)) {
      await create(95, shape, {}, 'Auto height\n' + 'wrapped text '.repeat(30));
    }
    for (const height of [24.2, 43.2, 45.6, 46.01, 47.99, 48.4, 5999.2]) {
      await create(100, 'rounded-rect', { height });
    }
    await create(100, 'triangle', { width: 24, height: 24, paddingX: 80, paddingY: 80 }, 'x'.repeat(2000));
    await page.evaluate(() => {
      localStorage.setItem('canvas:noteCanvasNodeScale:v1', '95');
      localStorage.removeItem('canvas:noteCanvasDefaults:v1');
    });
    const box = await viewport.boundingBox(); await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await viewport.locator('textarea').fill('Persisted at 95%'); await viewport.locator('textarea').press('Control+Enter'); await settle();
    assert.equal(await frame.evaluate(el => el.__noteCanvas.session.past.length), 1);
    assert.equal(await page.evaluate(() => RelatumNoteCanvas.flushAll()), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'notes/canvases/test.canvas'))).nodes[0].text, 'Persisted at 95%');
    const before = await frame.evaluate(el => ({ ...el.__noteCanvas.engine.stats(), layouts: window.layoutCalls }));
    await pause(400);
    const after = await frame.evaluate(el => ({ ...el.__noteCanvas.engine.stats(), layouts: window.layoutCalls }));
    assert.equal(after.staticDraws, before.staticDraws, 'idle canvas does not redraw');
    assert.equal(after.layouts, before.layouts, 'idle canvas does not repeatedly measure');
    assert.equal(after.framesPending, false);
    const fitSteps = await page.evaluate(() => window.fitSteps); assert(fitSteps <= 16, `bounded layout: ${fitSteps}`);
    await page.unroute('**/note-canvas/engine.js*'); await page.reload();
    await page.waitForFunction(() => document.querySelector('.note-canvas-frame')?.__noteCanvas?.engine);
    assert.equal(await page.evaluate(() => RelatumNoteCanvasEngine.create.toString().includes('probeSteps')), false, 'final check uses the unmodified production script');
    const reopened = await viewport.boundingBox(); await page.mouse.dblclick(reopened.x + 30, reopened.y + 35);
    await viewport.locator('textarea').fill('Production script'); await viewport.locator('textarea').press('Control+Enter'); await settle();
    assert.equal(await viewport.locator('.note-canvas-node').count(), 2);
    assert.equal(await page.evaluate(() => RelatumNoteCanvas.flushAll()), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'notes/canvases/test.canvas'))).nodes.length, 2);
    await page.screenshot({ path: path.join(root, 'stability.png') });
    assert.deepEqual(errors, []);
    return { desktop: !!release, full, fallback, scales: 51, shapes: 12, maxFitSteps: fitSteps, idleDraws: after.staticDraws - before.staticDraws, idleLayouts: after.layouts - before.layouts, screenshot: path.join(root, 'stability.png') };
  } finally {
    if (release) {
      if (page && server.exitCode === null) {
        await page.evaluate(() => window.pywebview.api.close_window()).catch(() => {});
        await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)]);
      }
      await connection?.close().catch(() => {});
      if (server.exitCode === null) await execute('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    } else { await context?.close(); server.kill(); }
  }
}
(async () => {
  const browser = release ? null : await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try { console.log(JSON.stringify([await run(browser, false), await run(browser, true), await run(browser, false, true)], null, 2)); }
  finally { await browser?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Actual same-process launcher entries and native chooser fallbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = path.resolve(process.argv[2] || path.join(__dirname, '../../Relatum-release'));
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function run(name, ids, fallback = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-launcher-entry-')), port = await freePort();
  fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'canvases'));
  const canvas = path.join(root, 'canvases/test.canvas');
  fs.writeFileSync(canvas, JSON.stringify({ nodes: [], edges: [] }));
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, ids.includes(item.id)])) };
  if (name.includes('editor')) profile.canvasFile = name === 'invalid-editor' ? path.join(root, 'missing.canvas') : canvas;
  if (name !== 'missing') fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), name === 'corrupt' ? 'bad' : JSON.stringify(profile));
  fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  const app = spawn(path.join(release, 'RelatumLauncher.exe'), [], { cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    if (fallback) {
      await sleep(2200);
      assert.equal(app.exitCode, null, `${name}: selection window remains open`);
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${app.pid}').Count`], { windowsHide: true });
      assert.equal(Number(stdout.trim()), 0, `${name}: no WebView2 or second app`);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`));
    } else {
      let ready = false;
      for (let i = 0; i < 300; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch (_) {}
        await sleep(50);
      }
      assert(ready, `${name}: WebView2 opens`);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      let page;
      for (let i = 0; i < 100; i++) { page = browser.contexts()[0]?.pages()[0]; if (page) break; await sleep(50); }
      await page.waitForFunction(() => typeof window.pywebview?.api?.close_window === 'function');
      assert.equal(app.exitCode, null, 'launcher remains the main process');
      const runtime = await page.evaluate(async () => (await fetch('/api/runtime')).json());
      assert(runtime.launcherMode);
      if (name === 'editor') {
        await page.waitForFunction(() => document.body.classList.contains('canvas-ready'));
        // The minimal fixture is normalized and autosaved after the reveal.
        // Let that existing save finish before requesting native destruction.
        await sleep(2200);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.singleWorkspace), undefined);
        assert((await page.locator('.editor-top-bar').boundingBox()).height > 20, 'editor toolbar unchanged');
      } else {
        if (name === 'research') await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow.RelatumResearchWorkspace);
        if (name === 'career') await page.waitForFunction(() => window.RelatumCareerReport);
        if (name === 'notes-career') await page.waitForFunction(() => window.CanvasNoteWorkspace);
        assert.equal(await page.locator('body > .top-bar').evaluate(el => getComputedStyle(el).opacity), name === 'career' ? '0' : '1');
      }
      await page.evaluate(async () => { await window.CanvasDesktop.flushBeforeClose(); window.pywebview.api.close_window(); });
      await Promise.race([
        new Promise(resolve => app.exitCode !== null ? resolve() : app.once('exit', resolve)),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(Error(`${name}: close timeout`)), 10000); timer.unref(); }),
      ]);
      assert.equal(app.exitCode, 0);
    }
    console.log(`${name}: packaged entry passed`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await sleep(400);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
(async () => {
  for (const [name, ids, fallback] of [
    ['canvas', ['canvas', 'canvas.library']], ['research', ['research']], ['career', ['career']],
    ['notes-career', ['notes', 'career']], ['editor', ['canvas', 'canvas.editor']],
    ['missing', ['notes'], true], ['corrupt', ['notes'], true], ['invalid-editor', ['canvas', 'canvas.editor'], true],
  ]) await run(name, ids, fallback);
})().catch(error => { console.error(error); process.exitCode = 1; });

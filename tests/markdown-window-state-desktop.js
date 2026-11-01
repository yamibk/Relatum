'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-md-placement-'));
const filename = path.join(root, 'Placement.md'), record = path.join(root, 'data', 'desktop-sessions', 'markdown-files', 'window-state.json');
fs.writeFileSync(filename, '# Placement\n'); fs.mkdirSync(path.join(root, 'data'));
const mainRecord = path.join(root, 'data', 'window-state.json'); fs.writeFileSync(mainRecord, 'main window sentinel');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const usedUrls = new Set();
let debugPort = null, sharedBrowser = null;
const host = `import sys, desktop
from markdown_window_state import capture_placement
def test_geometry(self):
    return capture_placement(desktop, self._window)
def test_resize(self, width, height):
    self._window.resize(width, height)
    self._window.move(80, 80)
def test_show(self):
    desktop._show_window(self._window, desktop.SW_RESTORE)
desktop.DesktopBridge.markdown_test_geometry = test_geometry
desktop.DesktopBridge.markdown_test_resize = test_resize
desktop.DesktopBridge.markdown_test_show = test_show
sys.argv = ['desktop.py', sys.argv[1]]
sys.exit(desktop.main())`;
async function waitFor(check, description) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out: ' + description);
}
function read() { try { return JSON.parse(fs.readFileSync(record, 'utf8')); } catch { return {}; } }
async function open() {
  if (debugPort === null) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const socket = net.createServer(), port = 20000 + Math.floor(Math.random() * 20000);
      try { await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); }); }
      catch { continue; }
      debugPort = port; await new Promise(resolve => socket.close(resolve)); break;
    }
    assert.notEqual(debugPort, null, 'No free debugger port');
  }
  const port = debugPort; // Shared WebView2 storage requires identical browser arguments.
  const child = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', '-c', host, filename], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  const result = { child, browser: null }; children.push(result);
  try { await waitFor(async () => { assert.equal(child.exitCode, null, logs); try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'native debug port'); }
  catch (error) { throw new Error(error.message + '\n' + logs); }
  const browser = sharedBrowser?.isConnected() ? sharedBrowser : await chromium.connectOverCDP('http://127.0.0.1:' + port);
  sharedBrowser = browser;
  let page;
  await waitFor(() => { page = browser.contexts()[0].pages().find(item => item.url().includes('markdown-file.html') && !usedUrls.has(item.url())); return !!page; }, 'Markdown page');
  usedUrls.add(page.url());
  page.setDefaultTimeout(15000); result.page = page;
  await page.waitForFunction(() => window.RelatumMarkdownWindow?.editor);
  result.geometry = () => page.evaluate(() => pywebview.api.markdown_test_geometry());
  result.resize = (width, height) => page.evaluate(([w, h]) => pywebview.api.markdown_test_resize(w, h), [width, height]);
  result.close = async () => {
    await page.evaluate(() => { RelatumMarkdownWindow.close(); });
    await waitFor(() => child.exitCode !== null, 'native close');
  };
  return result;
}
(async () => {
  try {
    const a = await open(); await pause(600);
    assert(!fs.existsSync(record), 'Initial placement does not write a preference');
    await a.resize(820, 620); await waitFor(() => read().width === 820 && read().height === 620, 'first resize');
    const b = await open(); assert.equal((await b.geometry()).width, 820);
    await a.resize(850, 640); await waitFor(() => read().width === 850, 'older window adjustment');
    await b.resize(930, 670); await waitFor(() => read().width === 930, 'newer window adjustment');
    await b.close(); await a.close(); assert.equal(read().width, 930, 'Reverse close order retains the latest adjustment');
    const c = await open(); assert.equal((await c.geometry()).width, 930);
    await c.page.evaluate(() => pywebview.api.toggle_maximize());
    await waitFor(() => read().maximized === true, 'maximize');
    assert.equal(read().width, 930, 'Maximize saves the actual restore width');
    await c.page.evaluate(() => pywebview.api.minimize());
    await c.page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
    await c.page.evaluate(() => pywebview.api.markdown_test_show());
    await c.page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
    assert.equal((await c.geometry()).maximized, true, 'Restoring a minimized maximized window resumes the same state');
    await c.page.evaluate(() => pywebview.api.minimize()); await c.close();
    assert.equal(read().maximized, true, 'Minimize does not replace maximize preference');
    const d = await open(); assert.equal((await d.geometry()).maximized, true);
    await d.page.evaluate(() => pywebview.api.toggle_maximize());
    await waitFor(async () => (await d.geometry())?.maximized === false, 'restore saved maximized window');
    assert.equal((await d.geometry()).width, 930); await d.close();
    fs.writeFileSync(record, '{invalid');
    const e = await open(); assert.equal((await e.geometry()).width, 1040); await e.close();
    assert.equal(fs.readFileSync(mainRecord, 'utf8'), 'main window sentinel');
    console.log('Markdown native placement: resize/reopen, reverse close, maximize/restore, minimized close and corrupt state OK');
  } finally {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {});
    for (const item of children) {
      if (item.browser) await item.browser.close().catch(() => {});
      if (item.child.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(item.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

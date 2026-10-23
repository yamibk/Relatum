'use strict';
// Real packaged Launcher + WebView2. Only temporary user data is created.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'pass an independent release directory');
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-desktop-report-'));
const source = '# Mermaid 桌面验证\n\n```mermaid\nflowchart LR\n' + Array.from({ length: 18 }, (_, index) => `A${index}[步骤 ${index}] --> A${index + 1}[步骤 ${index + 1}]`).join('\n') + '\n```\n\n正文';
async function port() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value; }

(async () => {
  const checks = [];
  const runtime = fs.readFileSync(path.join(release, '_internal/assets/vendor/pele/pele.global.js'));
  assert.equal(crypto.createHash('sha256').update(runtime).digest('hex'), '323c16de7844d4b609743f70449ebce041a531e4f48f23b1e9e7ec9d3b917287');
  for (const enabled of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-desktop-data-')), debug = await port();
    fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'notes/Diagram.md'), source);
    fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(feature => [feature.id, feature.id === 'notes' || enabled && feature.id === 'notes.mermaid'])) }));
    fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
    const app = spawn(path.join(release, 'RelatumLauncher.exe'), [], { cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug }, windowsHide: true, stdio: 'ignore' });
    let browser;
    try {
      let ready = false;
      for (let index = 0; index < 200; index++) { try { ready = (await fetch('http://127.0.0.1:' + debug + '/json/version')).ok; } catch (_) {} if (ready) break; assert.equal(app.exitCode, null); await pause(100); }
      assert(ready, 'native WebView2 starts'); browser = await chromium.connectOverCDP('http://127.0.0.1:' + debug);
      const context = browser.contexts()[0]; let page;
      for (let index = 0; index < 100; index++) { page = context.pages().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100); }
      assert(page); page.setDefaultTimeout(25000);
      const origin = new URL(page.url()).origin, requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
      // Read the package's own script; expose state only in the test response.
      const packagedSource = await (await fetch(origin + '/note-workspace.js')).text();
      assert(packagedSource.includes('  window.CanvasNoteWorkspace = {'));
      await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: packagedSource.replace('  window.CanvasNoteWorkspace = {', '  window.N={state,setViewMode,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {') }));
      await page.addInitScript(() => {
        localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Diagram.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'Diagram.md'); localStorage.setItem('canvas:noteFocusMode:v1', '0');
      });
      await page.goto(origin + '/?desktop=1');
      await page.waitForFunction(() => window.N?.state.current?.path === 'Diagram.md' && N.editor && window.pywebview?.api?.minimize);
      const profile = await page.evaluate(async () => (await fetch('/api/runtime')).json());
      assert.equal(profile.features['notes.mermaid'], enabled); assert(profile.launcherMode);
      if (enabled) {
        await page.locator('.is-mermaid svg').waitFor();
        await page.locator('.is-mermaid').focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('.is-mermaid svg').count(), 0);
        await page.waitForFunction(() => {
          const view = N.editor.view;
          return view.state.doc.lineAt(view.state.selection.main.head).text.startsWith('flowchart');
        });
        await page.evaluate(() => { const view = N.editor.view; view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); });
        await page.locator('.is-mermaid svg').waitFor();
        await page.evaluate(() => N.setViewMode('reading'));
        await page.getByRole('button', { name: '放大图表', exact: true }).waitFor();
        await page.getByRole('button', { name: '放大图表', exact: true }).click();
        assert(await page.locator('.note-reading-content .note-mermaid').evaluate(el => {
          const box = el.getBoundingClientRect();
          return Array.from(el.querySelectorAll('.pele-zoom button')).filter(button => getComputedStyle(button).display !== 'none').every(button => button.getBoundingClientRect().bottom <= box.bottom);
        }), 'native zoom controls are not clipped by a short diagram');
        await page.screenshot({ path: path.join(output, 'reading.png') });
        await page.evaluate(() => pywebview.api.minimize());
        await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
        assert.equal(await page.getByRole('button', { name: '放大图表', exact: true }).count(), 0);
        await page.evaluate(() => pywebview.api.toggle_maximize());
        await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
        await page.getByRole('button', { name: '放大图表', exact: true }).waitFor();
        await page.evaluate(() => pywebview.api.toggle_maximize());
        await page.evaluate(() => N.setViewMode('source'));
        assert.equal(await page.locator('.is-mermaid svg').count(), 0);
        await page.evaluate(() => N.setViewMode('live')); await page.locator('.is-mermaid svg').waitFor();
      } else {
        await page.evaluate(() => N.setViewMode('reading')); await page.locator('.note-reading-content pre.md-code').waitFor();
        await pause(200); assert(!requests.some(url => url.includes('note-mermaid') || url.includes('vendor/pele/')));
        for (const asset of ['note-mermaid.js', 'note-mermaid.css', 'vendor/pele/pele.global.js']) assert.equal((await fetch(origin + '/' + asset)).status, 403);
      }
      assert(!requests.some(url => url.includes('vendor/mermaid/'))); assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => N.editor.snapshot().value), source);
      await page.evaluate(async () => { await CanvasDesktop.flushBeforeClose(); pywebview.api.close_window(); });
      for (let index = 0; index < 100 && app.exitCode === null; index++) await pause(100);
      assert.equal(app.exitCode, 0); assert.equal(fs.readFileSync(path.join(root, 'notes/Diagram.md'), 'utf8'), source);
      checks.push({ enabled, mode: 'Launcher/WebView2', errors });
      console.log('packaged Mermaid ' + (enabled ? 'enabled' : 'disabled') + ': passed');
    } finally {
      await browser?.close().catch(() => {});
      if (app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      await pause(300);
      const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
      assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase()); assert(path.basename(resolved).startsWith('relatum-mermaid-desktop-data-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ release, checks }, null, 2)); console.log(output);
})().catch(error => { console.error(error); process.exitCode = 1; });

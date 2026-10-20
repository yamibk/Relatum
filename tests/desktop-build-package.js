'use strict';
// Native package acceptance. Use only a copied release and disposable user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = path.resolve(process.argv[2]);
console.log('Checking native build copy: ' + source);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-build-native-'));
const release = path.join(sandbox, 'package-copy');
execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command',
  'Copy-Item -LiteralPath $env:RELATUM_SMOKE_SOURCE -Destination $env:RELATUM_SMOKE_COPY -Recurse -ErrorAction Stop'],
{ windowsHide: true, env: { ...process.env, RELATUM_SMOKE_SOURCE: source, RELATUM_SMOKE_COPY: release }, stdio: 'inherit' });
console.log('Disposable package copy: ' + release);
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function run(launcher) {
  const root = path.join(sandbox, launcher ? 'launcher-data' : 'main-data'), port = await freePort();
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true }); fs.mkdirSync(path.join(root, 'data'));
  const markdown = '打包搜索验收 ab\n\n[[直接创建]]\n';
  fs.writeFileSync(path.join(root, 'notes/Main.md'), markdown);
  fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), JSON.stringify(profile));
  fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  const process = spawn(path.join(release, launcher ? 'RelatumLauncher.exe' : 'Relatum.exe'), launcher ? [] : ['--launch-profile', JSON.stringify(profile)], {
    cwd: release, windowsHide: true, stdio: 'ignore', env: { ...global.process.env, RELATUM_DATA_ROOT: root,
      LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let browser, closed = false;
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch (_) {}
      if (ready) break;
      assert.equal(process.exitCode, null, 'native process stays alive'); await pause(100);
    }
    assert(ready, 'WebView2 starts from the generated package');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    let page;
    for (let i = 0; i < 100; i++) { page = browser.contexts()[0]?.pages()[0]; if (page) break; await pause(50); }
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => window.CanvasNoteWorkspace && typeof window.pywebview?.api?.close_window === 'function');
    await page.locator('.note-tree-row[data-note-path="Main.md"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'Main.md');
    const search = await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const response = await fetch('/api/note-query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'search', q: 'ab' }) });
        const result = await response.json();
        if (result.items?.some(item => item.path === 'Main.md')) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    });
    assert(search, 'bundled SQLite supports short-character full-text search');
    await page.locator('.note-live-wikilink').filter({ hasText: '直接创建' }).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === '直接创建.md');
    assert.equal(await page.locator('.note-modal-card').count(), 0, 'missing wiki targets create without a prompt');
    assert(fs.existsSync(path.join(root, 'notes/直接创建.md')));
    assert.equal(fs.readFileSync(path.join(root, 'notes/Main.md'), 'utf8'), markdown);
    await page.evaluate(async () => { await CanvasDesktop.flushBeforeClose(); pywebview.api.close_window(); });
    for (let i = 0; i < 100 && process.exitCode === null; i++) await pause(100);
    assert.equal(process.exitCode, 0, 'native close completes'); closed = true;
    console.log((launcher ? 'launcher' : 'main') + ': package startup, note search, direct wiki creation and close passed');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!closed && process.exitCode === null) await execute('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  }
}
(async () => {
  await run(false); await run(true);
  console.log('Isolated native fixtures: ' + sandbox);
})().catch(error => { console.error(error); global.process.exitCode = 1; });

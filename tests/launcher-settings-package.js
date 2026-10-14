'use strict';
// Real portable WebView2 settings -> launcher -> reduced session -> chooser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile);
const release = path.resolve(process.argv[2] || path.join(__dirname, '../../Relatum-release'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-launcher-settings-'));
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
fs.mkdirSync(path.join(root, 'data'));
const profileFile = path.join(root, 'data/launcher-profile.json');
const settingsFile = path.join(root, 'data/launcher-settings.json');
const languageFile = path.join(root, 'data/launcher-language.json');
fs.writeFileSync(profileFile, JSON.stringify(profile));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = [], pids = new Set();
let browser;
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function start(exe, port, args = [], windowsHide = true) {
  const process = spawn(path.join(release, exe), args, { cwd: release, env: { ...global.process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, windowsHide, stdio: 'ignore' });
  processes.push(process);
  return process;
}
async function connect(port, app) {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch (_) {}
    await sleep(100);
  }
  assert(ready, 'native WebView2 startup');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 50; i++) {
    page = browser.contexts()[0].pages()[0];
    if (page) break;
    await sleep(100);
  }
  assert(page);
  await page.waitForFunction(() => window.CanvasDesktop && typeof window.pywebview?.api?.get_launcher_settings === 'function');
  return page;
}
async function setToggle(page, value) {
  await page.locator('[data-action="desktop-settings-open"]').click();
  const toggle = page.locator('[data-role="launcher-skip-selection"]');
  await toggle.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-role="launcher-skip-selection"]').disabled);
  await toggle.setChecked(value);
  await page.waitForFunction(value => {
    const input = document.querySelector('[data-role="launcher-skip-selection"]');
    return !input.disabled && input.checked === value;
  }, value);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).skipSelection, value);
  assert.deepEqual(JSON.parse(fs.readFileSync(profileFile, 'utf8')), profile, 'setting keeps feature choices');
}
async function closeMain(page, port) {
  await page.waitForFunction(() => typeof window.pywebview?.api?.close_window === 'function');
  await page.evaluate(async () => { await window.CanvasDesktop.flushBeforeClose(); window.pywebview.api.close_window(); });
  let closed = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch (_) { closed = true; break; }
    await sleep(100);
  }
  assert(closed, 'main process closes');
  await browser.close();
  browser = null;
  await sleep(300);
}
async function checkChooser(language) {
  // UI Automation needs a visible top-level window, unlike the CDP-only probes.
  const chooser = start('RelatumLauncher.exe', await freePort(), [], false);
  await sleep(2500);
  assert.equal(chooser.exitCode, null, 'unchecking restores chooser');
  const { stdout: children } = await execute('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${chooser.pid}').Count`], { windowsHide: true });
  assert.equal(Number(children.trim()), 0, 'chooser has no main or WebView2 child');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName UIAutomationClient
    $window = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Process -Id ${chooser.pid}).MainWindowHandle)
    $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    @($controls | ForEach-Object { $_.Current.Name }) | ConvertTo-Json -Compress
  `], { windowsHide: true });
  const names = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  for (const text of language === 'en' ? ['Choose features for this session', 'Notes workspace', 'Start Relatum', 'Cancel'] : ['选择本次需要的功能', '笔记工作区', '启动 Relatum', '取消']) {
    assert(names.includes(text), `${language} packaged chooser: ${text}`);
  }
  await execute('taskkill.exe', ['/PID', String(chooser.pid), '/T', '/F'], { windowsHide: true });
  if (chooser.exitCode === null) await new Promise(resolve => chooser.once('exit', resolve));
}
async function checkGuide(page) {
  await page.waitForFunction(() => window.RelatumStartWorkspace);
  await page.locator('button[data-start-workspace="canvas"]').click();
  await page.waitForFunction(() => window.RelatumStartWorkspace.current === 'canvas');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The fresh-library empty page has no spine; use the existing public guide entry.
  await page.waitForFunction(() => window.CanvasStartHelp);
  const copy = page.locator('[data-role="start-help-page-copy"]');
  for (const language of ['zh-CN', 'en']) {
    await page.evaluate(language => window.RelatumI18n.setLanguage(language), language);
    await page.evaluate(() => window.CanvasStartHelp.open('storage'));
    await copy.getByText('data/launcher-language.json', { exact: true }).waitFor();
    assert((await copy.innerText()).includes(language === 'en' ? 'Deleting this file makes the launcher default to Chinese' : '删除此文件后，启动器默认使用中文'));
    for (const width of [1280, 720]) {
      await page.setViewportSize({ width, height: 800 });
      await copy.getByText(language === 'en' ? 'Launcher language' : '启动器语言', { exact: true }).scrollIntoViewIfNeeded();
      assert(await page.locator('.start-help-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'guide has no horizontal overflow');
      if (process.env.RELATUM_LAUNCHER_PREVIEW_DIR) {
        fs.mkdirSync(process.env.RELATUM_LAUNCHER_PREVIEW_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.RELATUM_LAUNCHER_PREVIEW_DIR, `guide-${language}-${width}.png`) });
      }
    }
    await page.locator('.start-help-close').click();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}
(async () => {
  try {
    let port = await freePort();
    const direct = start('Relatum.exe', port);
    let page = await connect(port, direct);
    assert(Object.values((await page.evaluate(async () => (await fetch('/api/runtime')).json())).features).every(Boolean), 'direct main remains full');
    await checkGuide(page);
    await setToggle(page, true);
    await page.evaluate(() => window.RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('[data-role="launcher-setting"] strong').textContent(), 'Skip the RelatumLauncher selection window');
    await closeMain(page, port);
    assert.equal(JSON.parse(fs.readFileSync(languageFile, 'utf8')).language, 'en');
    port = await freePort();
    const quick = start('RelatumLauncher.exe', port);
    page = await connect(port, quick);
    await page.waitForFunction(() => window.CanvasNoteWorkspace && window.RelatumStartWorkspace.current === 'notes');
    assert.equal(quick.exitCode, null, 'quick launcher hosts the main window in the same process');
    const { stdout: children } = await execute('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${quick.pid}').Name`], { windowsHide: true });
    assert(!children.includes('Relatum.exe'), 'no second main executable');
    const runtime = await page.evaluate(async () => (await fetch('/api/runtime')).json());
    assert(runtime.launcherMode && runtime.features.notes && !runtime.features['canvas.editor']);
    assert.equal(await page.locator('button[data-start-workspace="notes"]').textContent(), '笔记', 'new combination uses independent default language');
    await page.evaluate(() => window.RelatumDesktopPreferences.flush());
    assert.equal(JSON.parse(fs.readFileSync(languageFile, 'utf8')).language, 'en', 'restoring a different session does not overwrite launcher language');
    await page.evaluate(() => window.RelatumI18n.setLanguage('en'));
    assert.equal(await page.locator('button[data-start-workspace="notes"]').textContent(), 'Notes');
    await setToggle(page, false);
    await closeMain(page, port);
    await checkChooser('en');
    port = await freePort();
    page = await connect(port, start('Relatum.exe', port, ['--launch-profile', JSON.stringify(profile)]));
    await page.waitForFunction(() => window.RelatumI18n);
    assert.equal(await page.evaluate(() => window.RelatumI18n.language), 'en', 'notes mode restores its own language');
    await page.evaluate(() => window.RelatumI18n.setLanguage('zh-CN'));
    if (process.env.RELATUM_SETTINGS_PREVIEW) await page.screenshot({ path: process.env.RELATUM_SETTINGS_PREVIEW });
    await closeMain(page, port);
    assert.equal(JSON.parse(fs.readFileSync(languageFile, 'utf8')).language, 'zh-CN');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/desktop-sessions/full/preferences.json'), 'utf8')).values['canvas:toolbarLanguage'], 'en', 'notes language does not overwrite full preferences');
    await checkChooser('zh-CN');
    console.log('packaged launcher settings: bilingual guide, explicit language persistence, independent session restoration and English/Chinese native choosers passed');
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const app of processes) if (app.exitCode === null) pids.add(app.pid);
    for (const pid of pids) await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await sleep(300);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

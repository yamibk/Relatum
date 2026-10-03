'use strict';
// Native portable application QA and cold process-tree measurements. Uses only
// temporary data and WebView2 profiles; no browser is launched by Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const release = path.resolve(process.argv[2] || path.join(repo, '..', 'Relatum-release'));
const reportPath = process.argv[3] || path.join(os.tmpdir(), 'relatum-launcher-memory.json');
const rounds = Number(process.argv[4] || 3);
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function profile(ids) { return { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, ids.includes(item.id)])) }; }
async function memory(pid) {
  assert(Number.isInteger(pid));
  const command = `$taskItems = @(Get-CimInstance Win32_Process); $taskIds = [System.Collections.Generic.HashSet[int]]::new(); [void]$taskIds.Add(${pid}); do { $taskBefore = $taskIds.Count; foreach ($taskItem in $taskItems) { if ($taskIds.Contains([int]$taskItem.ParentProcessId)) { [void]$taskIds.Add([int]$taskItem.ProcessId) } } } while ($taskIds.Count -gt $taskBefore); $taskStats = @(foreach ($taskItem in $taskItems) { if ($taskIds.Contains([int]$taskItem.ProcessId)) { $taskProcess = Get-Process -Id $taskItem.ProcessId -ErrorAction SilentlyContinue; if ($taskProcess) { [pscustomobject]@{id=$taskProcess.Id; name=$taskProcess.ProcessName; private=$taskProcess.PrivateMemorySize64; working=$taskProcess.WorkingSet64} } } }); ConvertTo-Json -InputObject $taskStats -Compress`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
  const processes = JSON.parse(stdout.trim());
  return { processes, privateMiB: processes.reduce((sum, item) => sum + item.private, 0) / 1048576, workingMiB: processes.reduce((sum, item) => sum + item.working, 0) / 1048576 };
}
async function run(name, choices, round) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-package-'));
  const debugPort = await freePort();
  const args = choices ? ['--launch-profile', JSON.stringify(choices)] : [];
  // A poisoned saved selection proves direct Relatum.exe does not read it.
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), JSON.stringify(profile(['notes'])));
  if (name === 'notes') fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  const app = spawn(path.join(release, name === 'notes' ? 'RelatumLauncher.exe' : 'Relatum.exe'), name === 'notes' ? [] : args, { cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) { ready = true; break; } } catch (_) {}
      if (app.exitCode !== null) throw new Error(`${name}: native process exited (${app.exitCode})`);
      await sleep(100);
    }
    assert(ready, `${name}: WebView2 CDP startup`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    let page = context.pages()[0];
    for (let i = 0; !page && i < 50; i++) { await sleep(100); page = context.pages()[0]; }
    assert(page, 'main native page exists');
    await page.waitForFunction(() => window.RelatumStartWorkspace && typeof window.pywebview?.api?.close_window === 'function');
    if (name === 'notes') await page.waitForFunction(() => window.CanvasNoteWorkspace);
    await sleep(10000); // full idle prewarm settles; fresh WebView profile on every run
    const state = await page.evaluate(async () => ({
      runtime: await (await fetch('/api/runtime')).json(),
      workspace: window.RelatumStartWorkspace.current,
      resources: performance.getEntriesByType('resource').map(item => new URL(item.name).pathname),
      study: !!window.StudyView, activity: !!window.StudyActivity,
      notes: !!window.CanvasNoteWorkspace, career: !!window.RelatumCareerReport,
    }));
    assert.equal(state.runtime.launcherMode, !!choices);
    if (!choices) assert(Object.values(state.runtime.features).every(Boolean), 'direct exe ignores saved launcher profile');
    if (name === 'library') {
      assert(!state.study && !state.activity && !state.notes && !state.career);
      assert(!state.resources.includes('/study.js') && !state.resources.includes('/note-workspace.js'));
    }
    if (name === 'notes') assert.equal(state.workspace, 'notes');
    const measurement = await memory(app.pid);
    // Verify real ordinary single-instance activation on the complete profile.
    if (!choices && round === 0) {
      const second = spawn(path.join(release, 'Relatum.exe'), [], { cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root }, windowsHide: true, stdio: 'ignore' });
      const code = await new Promise(resolve => second.once('exit', resolve));
      assert.equal(code, 0, 'ordinary second exe only activates the existing window');
    }
    // Real notes close path must flush a just-created document before destruction.
    if (name === 'notes' && round === 0) {
      const note = await page.evaluate(async () => {
        const response = await fetch('/api/note-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'note', autoName: 'timestamp' }) });
        return response.json();
      });
      assert(note.path, 'native notes creation');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.CanvasNoteWorkspace && typeof window.pywebview?.api?.close_window === 'function');
      await page.locator('[data-note-path="' + note.path + '"]').first().click();
      const editor = page.locator('.cm-content');
      await editor.click();
      await page.keyboard.type('Launcher close verification');
      await page.locator('.desktop-window-controls [data-window-action="close"]').click();
      await new Promise(resolve => app.exitCode !== null ? resolve() : app.once('exit', resolve));
      assert(fs.readFileSync(path.join(root, 'notes', note.path), 'utf8').includes('Launcher close verification'));
    } else {
      await page.evaluate(async () => { await window.CanvasDesktop.flushBeforeClose(); window.pywebview.api.close_window(); });
      await new Promise(resolve => app.exitCode !== null ? resolve() : app.once('exit', resolve));
    }
    console.log(`${name} ${round + 1}: private ${measurement.privateMiB.toFixed(1)} MiB, working ${measurement.workingMiB.toFixed(1)} MiB (${measurement.processes.length} processes)`);
    return { name, round: round + 1, ...measurement, state };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app.exitCode === null) { await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); }
    await sleep(300);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
(async () => {
  const exe = fs.readFileSync(path.join(release, 'Relatum.exe'));
  assert(exe.equals(fs.readFileSync(path.join(release, 'RelatumLauncher.exe'))), 'identical archive and embedded icon');
  assert(fs.existsSync(path.join(release, 'RelatumLauncher.exe.config')));
  for (const name of ['data', 'canvases', 'notes']) assert(!fs.existsSync(path.join(release, name)), 'clean release');
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-launcher-exe-'));
  const launcher = spawn(path.join(release, 'RelatumLauncher.exe'), [], { cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: launcherRoot }, windowsHide: true, stdio: 'ignore' });
  try {
    await sleep(3000);
    assert.equal(launcher.exitCode, null, 'launcher waits for confirmation');
    const launcherMemory = await memory(launcher.pid);
    assert.equal(launcherMemory.processes.length, 1, 'native launcher has no WebView2 child');
    assert(!fs.existsSync(path.join(launcherRoot, 'data')), 'opening launcher does not save preferences');
    console.log(`launcher: ${launcherMemory.privateMiB.toFixed(1)} MiB, no WebView2`);
  } finally {
    await execute('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    fs.rmSync(launcherRoot, { recursive: true, force: true });
  }
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    for (const [name, choices] of [['full', null], ['library', profile(['canvas', 'canvas.library'])], ['notes', profile(['notes'])]]) samples.push(await run(name, choices, round));
  }
  const median = values => { values.sort((a,b) => a-b); return values[Math.floor(values.length / 2)]; };
  const summary = Object.fromEntries(['full','library','notes'].map(name => [name, {
    privateMiB: median(samples.filter(item => item.name === name).map(item => item.privateMiB)),
    workingMiB: median(samples.filter(item => item.name === name).map(item => item.workingMiB)),
  }]));
  const report = { measuredAt: new Date().toISOString(), platform: os.release(), rounds, settleSeconds: 10, metric: 'sum of process-tree private committed bytes and working sets', summary, samples };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary, reportPath }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

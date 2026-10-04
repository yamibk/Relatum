'use strict';
// Native multi-window QA and measurements. Only temporary libraries are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = path.resolve(process.argv[2]);
const reportPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'relatum-multiopen-report.json'));
const mode = process.argv[4] || 'all';
const source = process.env.RELATUM_SOURCE === '1';
const catalog = JSON.parse(fs.readFileSync(path.join(release, source ? 'assets/feature-catalog.json' : '_internal/assets/feature-catalog.json'), 'utf8'));
const processes = new Set();
const profile = ids => ({ version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, ids.includes(item.id)])) });
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function start(root, ids, { launcher = false, remember = false, connect = true, file = '' } = {}) {
  const debugPort = await freePort(), started = performance.now();
  if (launcher) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), JSON.stringify(profile(ids)));
    fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  }
  const args = launcher || ids === null ? [] : ['--launch-profile', JSON.stringify(profile(ids))];
  if (remember) args.push('--remember-launch-choice');
  if (file) args.push(file);
  const executable = source ? process.env.RELATUM_PYTHON : path.join(release, launcher ? 'RelatumLauncher.exe' : 'Relatum.exe');
  if (source) args.unshift(path.join(release, 'desktop.py'), ...(launcher ? ['--launcher'] : []));
  const app = spawn(executable, args, {
    cwd: release, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
  });
  processes.add(app);
  const entry = { app, debugPort, ids, root };
  if (!connect) return entry;
  for (let count = 0; count < 400; count++) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch (_) {}
    if (app.exitCode !== null) throw Error(`startup exit ${app.exitCode}: ${ids}`);
    await sleep(50);
    if (count === 399) throw Error(`startup timeout: ${ids}`);
  }
  entry.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  for (let count = 0; count < 100; count++) {
    entry.page = entry.browser.contexts()[0]?.pages().find(page => page.url().startsWith('http://127.0.0.1:'));
    if (entry.page) break;
    await sleep(50);
  }
  assert(entry.page, 'main page');
  await entry.page.waitForFunction(() => window.RelatumStartWorkspace && typeof window.pywebview?.api?.update_window_preferences === 'function');
  if (ids?.includes('notes') && ids.length === 1) await entry.page.waitForFunction(() => window.CanvasNoteWorkspace);
  if (ids?.includes('research') && ids.length === 1) await entry.page.waitForFunction(() => document.querySelector('iframe')?.contentWindow.RelatumResearchWorkspace);
  if (ids?.includes('career') && ids.length === 1) await entry.page.waitForFunction(() => window.RelatumCareerReport);
  entry.startupMs = performance.now() - started;
  return entry;
}
async function waitExit(app) {
  if (app.exitCode !== null) return app.exitCode;
  return Promise.race([new Promise(resolve => app.once('exit', resolve)), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('native close timeout')), 15000); timer.unref();
  })]);
}
async function close(entry) {
  console.log(`closing ${entry.ids || 'full'} (${entry.app.pid})`);
  if (entry.page && entry.app.exitCode === null) {
    await entry.page.evaluate(() => { window.pywebview.api.close_window(); });
    try { assert.equal(await waitExit(entry.app), 0); } catch (error) {
      console.error(await entry.page.evaluate(async () => ({ dirty: document.body.className, prefs: await window.RelatumDesktopPreferences.flush(), ready: !!window.CanvasDesktop, note: window.RelatumStartWorkspace?.current })));
      await entry.page.screenshot({ path: reportPath + '.failure.png' });
      throw error;
    }
  }
  if (entry.browser) await entry.browser.close().catch(() => {});
}
async function kill(entry) {
  if (entry.browser) await entry.browser.close().catch(() => {});
  if (entry.app.exitCode === null) await execute('taskkill.exe', ['/PID', String(entry.app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
}
async function snapshot(entries) {
  const pids = entries.map(entry => entry.app.pid);
  const command = `$taskItems = @(Get-CimInstance Win32_Process); $taskIds = [System.Collections.Generic.HashSet[int]]::new(); foreach ($taskId in @(${pids.join(',')})) { [void]$taskIds.Add($taskId) }; do { $taskBefore = $taskIds.Count; foreach ($taskItem in $taskItems) { if ($taskIds.Contains([int]$taskItem.ParentProcessId)) { [void]$taskIds.Add([int]$taskItem.ProcessId) } } } while ($taskIds.Count -gt $taskBefore); $taskStats = @(foreach ($taskId in $taskIds) { $taskProcess = Get-Process -Id $taskId -ErrorAction SilentlyContinue; if ($taskProcess) { [pscustomobject]@{id=$taskProcess.Id; name=$taskProcess.ProcessName; private=$taskProcess.PrivateMemorySize64; working=$taskProcess.WorkingSet64; cpuMs=$taskProcess.TotalProcessorTime.TotalMilliseconds} } }); ConvertTo-Json -InputObject $taskStats -Compress`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
  const items = JSON.parse(stdout.trim());
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  return { items, privateMiB: items.reduce((sum, item) => sum + item.private, 0) / 1048576, workingMiB: items.reduce((sum, item) => sum + item.working, 0) / 1048576 };
}
async function checkChooser(entry) {
  await sleep(3000);
  assert.equal(entry.app.exitCode, null, 'chooser is kept open');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${entry.app.pid} AND Name = 'msedgewebview2.exe'").Count`], { windowsHide: true });
  assert.equal(Number(stdout.trim()), 0, 'conflict opens no WebView2');
  await assert.rejects(fetch(`http://127.0.0.1:${entry.debugPort}/json/version`));
  await kill(entry);
}
async function functional() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-multiopen-qa-'));
  const entries = [];
  try {
    const canvas = await start(root, ['canvas', 'canvas.library', 'canvas.editor'], { remember: true }); entries.push(canvas);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'data/launcher-profile.json'), 'utf8'));
    assert(saved.features['canvas.editor'] && !saved.features.notes, 'manual admitted session saves choices');
    const notes = await start(root, ['notes'], { launcher: true }); entries.push(notes);
    const research = await start(root, ['research']); entries.push(research);
    const career = await start(root, ['career']); entries.push(career);
    assert.equal(new Set(entries.map(entry => new URL(entry.page.url()).port)).size, 4, 'independent ports');
    for (const [entry, enabled, disabled] of [[canvas, '/api/research/workspace', '/research.html'], [notes, '/api/notes-tree', '/research.html']]) {
      const status = await entry.page.evaluate(async urls => Promise.all(urls.map(async url => (await fetch(url)).status)), [enabled, disabled]);
      assert.equal(status[1], 403);
    }
    const forbidden = await canvas.page.evaluate(async () => (await fetch('/api/note-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    assert.equal(forbidden, 403);
    await notes.page.evaluate(async () => {
      localStorage.setItem('canvas:startTheme', 'dark');
      localStorage.setItem('canvas:noteImageTextScale:v1', '135');
      await window.RelatumDesktopPreferences.flush();
      await window.pywebview.api.set_restored_size(1000, 680);
    });
    assert.notEqual(await canvas.page.evaluate(() => localStorage.getItem('canvas:startTheme')), 'dark');
    const frame = research.page.frames().find(frame => frame.url().includes('research.html'));
    await frame.evaluate(async () => { localStorage.setItem('research:panSpeed:v1', '137'); await window.RelatumDesktopPreferences.flush(); });
    const repeated = await start(root, ['notes'], { launcher: true, connect: false }); entries.push(repeated);
    await checkChooser(repeated);
    const original = fs.readFileSync(path.join(root, 'data/launcher-profile.json'), 'utf8');
    const overlap = await start(root, ['canvas', 'canvas.study', 'notes'], { remember: true, connect: false }); entries.push(overlap);
    await checkChooser(overlap);
    assert.equal(fs.readFileSync(path.join(root, 'data/launcher-profile.json'), 'utf8'), original, 'rejected choice is not saved');
    // Native Alt+F4-equivalent close bypasses the UI button; notes must still flush.
    const note = await notes.page.evaluate(async () => (await fetch('/api/note-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'note', autoName: 'timestamp' }) })).json());
    await notes.page.reload();
    await notes.page.waitForFunction(() => window.CanvasNoteWorkspace && window.pywebview?.api?.close_window);
    await notes.page.locator(`[data-note-path="${note.path}"]`).first().click();
    await notes.page.locator('.cm-content').click();
    await notes.page.keyboard.type('Multiworkspace immediate close');
    await close(notes);
    assert(fs.readFileSync(path.join(root, 'notes', note.path), 'utf8').includes('Multiworkspace immediate close'));
    await close(canvas); // free the first port so reopened notes necessarily gets another origin
    const reopened = await start(root, ['notes']); entries.push(reopened);
    assert.notEqual(new URL(reopened.page.url()).port, new URL(notes.page.url()).port);
    assert.equal(await reopened.page.evaluate(() => localStorage.getItem('canvas:startTheme')), 'dark');
    assert.equal(await reopened.page.evaluate(() => localStorage.getItem('canvas:noteImageTextScale:v1')), '135');
    const size = await reopened.page.evaluate(() => window.pywebview.api.get_restored_size());
    assert.equal(size.width, 1000); assert.equal(size.height, 680);
    const report = await career.page.evaluate(async () => (await fetch('/api/career-report-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json());
    assert(report.exists);
    await close(research);
    const research2 = await start(root, ['research']); entries.push(research2);
    assert.equal(await research2.page.frames().find(frame => frame.url().includes('research.html')).evaluate(() => localStorage.getItem('research:panSpeed:v1')), '137');
    await kill(research2);
    const research3 = await start(root, ['research']); entries.push(research3);
    await close(research3); await close(reopened); await close(career);
    const full = await start(root, null); entries.push(full);
    const second = await start(root, null, { connect: false }); entries.push(second);
    assert.equal(await waitExit(second.app), 0, 'complete repeat forwards');
    const blocked = await start(root, ['notes'], { connect: false }); entries.push(blocked);
    await checkChooser(blocked);
    await close(full);
    console.log('Native multiopen QA passed: four windows, overlap, preferences across ports, close save, crash restart, full activation');
    return { passed: true };
  } finally {
    for (const entry of entries.reverse()) await kill(entry);
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
async function benchmark() {
  const samples = [];
  for (let round = 1; round <= 3; round++) for (const [name, groups] of [
    ['full', [null]], ['two', [['canvas', 'canvas.library'], ['notes']]],
    ['four', [['canvas', 'canvas.library'], ['notes'], ['research'], ['career']]],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-multiopen-bench-')), entries = [];
    try {
      for (const ids of groups) entries.push(await start(root, ids));
      await sleep(10000);
      const first = await snapshot(entries), began = performance.now();
      await sleep(5000);
      const last = await snapshot(entries), elapsed = performance.now() - began;
      const previous = new Map(first.items.map(item => [item.id, item.cpuMs]));
      const cpuMs = last.items.reduce((sum, item) => sum + Math.max(0, item.cpuMs - (previous.get(item.id) ?? item.cpuMs)), 0);
      const sample = { name, round, privateMiB: last.privateMiB, workingMiB: last.workingMiB, idleCpuOneCorePercent: cpuMs / elapsed * 100, idleIntervalMs: elapsed, startupsMs: entries.map(entry => entry.startupMs), processes: last.items };
      samples.push(sample);
      fs.writeFileSync(reportPath, JSON.stringify({ samples }, null, 2));
      console.log(`${name} ${round}: ${sample.privateMiB.toFixed(1)} MiB, idle ${sample.idleCpuOneCorePercent.toFixed(2)}% of one core, ${last.items.length} processes`);
      for (const entry of entries) await close(entry);
    } finally {
      for (const entry of entries.reverse()) await kill(entry);
      await sleep(300); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(['full', 'two', 'four'].map(name => {
    const matches = samples.filter(item => item.name === name);
    return [name, { privateMiB: median(matches.map(item => item.privateMiB)), workingMiB: median(matches.map(item => item.workingMiB)), idleCpuOneCorePercent: median(matches.map(item => item.idleCpuOneCorePercent)), startupMedianMs: median(matches.flatMap(item => item.startupsMs)) }];
  }));
  return { samples, summary };
}
(async () => {
  if (!source) {
    assert(fs.readFileSync(path.join(release, 'Relatum.exe')).equals(fs.readFileSync(path.join(release, 'RelatumLauncher.exe'))));
    for (const name of ['data', 'canvases', 'notes']) assert(!fs.existsSync(path.join(release, name)), 'clean release');
  }
  const qa = mode === 'bench' ? null : await functional();
  const measurements = mode === 'qa' ? {} : await benchmark();
  const report = { measuredAt: new Date().toISOString(), platform: os.release(), qa, ...measurements };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ qa, summary: report.summary, reportPath }, null, 2));
})().catch(async error => {
  console.error(error.stack);
  for (const app of processes) if (app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  process.exitCode = 1;
});

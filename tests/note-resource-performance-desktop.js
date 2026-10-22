'use strict';
// Actual EXE/WebView2, fresh data and browser profile for every sample. The
// baseline/current distinction replaces only the changed JS in test responses.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), repo = path.resolve(__dirname, '..');
const release = path.resolve(process.argv[2] || 'D:/Relatum-release');
const rounds = Number(process.env.RELATUM_NOTE_RESOURCE_ROUNDS || 3);
const output = process.env.RELATUM_NOTE_RESOURCE_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-resources-'));
fs.mkdirSync(output, { recursive: true });
const baselineRef = 'c22006b', changed = ['markdown.js', 'note-live-editor.js'];
const old = new Map(changed.map(name => [name, execFileSync('git', ['show', baselineRef + ':assets/' + name], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })]));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function processes(pid) {
  assert(Number.isInteger(pid));
  const command = `$taskItems=@(Get-CimInstance Win32_Process); $taskIds=[System.Collections.Generic.HashSet[int]]::new(); [void]$taskIds.Add(${pid}); do { $taskBefore=$taskIds.Count; foreach($taskItem in $taskItems){if($taskIds.Contains([int]$taskItem.ParentProcessId)){[void]$taskIds.Add([int]$taskItem.ProcessId)}} }while($taskIds.Count -gt $taskBefore); $taskStats=@(foreach($taskItem in $taskItems){if($taskIds.Contains([int]$taskItem.ProcessId)){$taskProcess=Get-Process -Id $taskItem.ProcessId -ErrorAction SilentlyContinue; if($taskProcess){[pscustomobject]@{id=$taskProcess.Id;name=$taskProcess.ProcessName;private=$taskProcess.PrivateMemorySize64;working=$taskProcess.WorkingSet64;cpu=$taskProcess.TotalProcessorTime.TotalSeconds}}}}); ConvertTo-Json -InputObject $taskStats -Compress`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 15000 });
  const items = JSON.parse(stdout.trim());
  return { items, privateMiB: items.reduce((sum, item) => sum + item.private, 0) / 1048576, workingMiB: items.reduce((sum, item) => sum + item.working, 0) / 1048576 };
}
const fixture = '[TOC]\n\n# Notes resource verification\n\n' + 'Paragraph with `code`, [r] and inline $a+b$.\n\n'.repeat(1000)
  + '\n[r]: https://example.com\n\n[^n]: Footnote\n\nReference [^n].\n';
async function run(mode, variant, round) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-resource-case-')), debugPort = await freePort();
  fs.mkdirSync(path.join(root, 'notes')); fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'notes', 'Main.md'), fixture); fs.writeFileSync(path.join(root, 'notes', 'Other.md'), '# Other\n\nplain text\n');
  if (mode === 'notes') {
    fs.writeFileSync(path.join(root, 'data', 'launcher-profile.json'), JSON.stringify({ version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id.startsWith('notes')])) }));
    fs.writeFileSync(path.join(root, 'data', 'launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  }
  const app = spawn(path.join(release, mode === 'notes' ? 'RelatumLauncher.exe' : 'Relatum.exe'), [], {
    cwd: release, windowsHide: true, stdio: 'ignore', env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
  });
  let browser, page;
  try {
    for (let i = 0; i < 200; i++) {
      let ready = false; try { ready = (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch (_) {}
      if (ready) break; assert.equal(app.exitCode, null, 'isolated EXE stays alive'); await pause(100);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    for (let i = 0; i < 100; i++) { page = context.pages().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100); }
    assert(page); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/(?:assets\/)?/, '');
      if (changed.includes(name)) return route.fulfill({ contentType: 'text/javascript', body: variant === 'baseline' ? old.get(name) : fs.readFileSync(path.join(repo, 'assets', name), 'utf8') });
      if (name === 'note-workspace.js') {
        const source = fs.readFileSync(path.join(repo, 'assets', name), 'utf8').replace('  window.CanvasNoteWorkspace = {',
          '  window.resourceTest = {state,openNote,flushSave,setViewMode,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
        return route.fulfill({ contentType: 'text/javascript', body: source });
      }
      return route.continue();
    });
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteView:v1', 'live');
      localStorage.setItem('canvas:noteGraphPreload:v1', '0');
      window.resourceFrames = 0; const frame = requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { resourceFrames++; return frame(callback); };
    });
    await page.reload(); await page.waitForFunction(() => window.resourceTest?.state.initialized && resourceTest.state.active);
    await page.evaluate(() => resourceTest.openNote('Main.md'));
    await pause(10000);
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.collectGarbage');
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const metrics = (await cdp.send('Performance.getMetrics')).metrics;
      return Object.fromEntries(metrics.filter(item => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'JSEventListeners'].includes(item.name)).map(item => [item.name, item.value]));
    };
    const initialHeap = await heap(), initial = await processes(app.pid), loops = [];
    for (let batch = 0; batch < 3; batch++) {
      await page.evaluate(async () => {
        for (let i = 0; i < 10; i++) {
          await resourceTest.openNote('Other.md'); await resourceTest.openNote('Main.md');
          if (i % 5 === 0) { await resourceTest.setViewMode('reading'); await resourceTest.setViewMode('live'); }
        }
      });
      await pause(1000); loops.push(await heap());
    }
    await pause(3000);
    const finalHeap = await heap(), before = await processes(app.pid), started = Date.now();
    const frameBefore = await page.evaluate(() => resourceFrames); await pause(5000);
    const after = await processes(app.pid), seconds = (Date.now() - started) / 1000;
    const prior = new Map(before.items.map(item => [item.id, item.cpu]));
    const cpuSeconds = after.items.reduce((sum, item) => sum + Math.max(0, item.cpu - (prior.get(item.id) ?? item.cpu)), 0);
    const idleFrames = await page.evaluate(before => resourceFrames - before, frameBefore);
    assert.equal(idleFrames, 0, 'settled workspace has no RAF loop');
    assert.equal(await page.evaluate(() => resourceTest.editor.snapshot().value), fixture);
    assert.equal(fs.readFileSync(path.join(root, 'notes/Main.md'), 'utf8'), fixture);
    assert.deepEqual(errors, []);
    const result = { mode, variant, round, root, initial, after, initialHeap, loops, finalHeap, idleFrames,
      idleCpuOneCorePercent: cpuSeconds / seconds * 100, cpuSampleSeconds: seconds };
    const initialCpu = new Map(initial.items.map(item => [item.id, item.cpu]));
    result.interactionCpuSeconds = after.items.reduce((sum, item) => sum + Math.max(0, item.cpu - (initialCpu.get(item.id) ?? item.cpu)), 0) - cpuSeconds;
    assert(finalHeap.JSHeapUsedSize <= loops[0].JSHeapUsedSize + 2 * 1024 * 1024, 'repeated switches plateau after GC');
    return result;
  } finally {
    if (page) await page.evaluate(() => window.pywebview?.api?.close_window()).catch(() => {});
    for (let i = 0; i < 40 && app.exitCode === null; i++) await pause(100);
    if (app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await browser?.close().catch(() => {});
  }
}
(async () => {
  const report = { baselineRef, release, rounds, metric: 'PID-deduplicated process-tree private commit, working set, single-core CPU; separate post-GC JS heap', samples: [], summary: [] };
  const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  try {
    for (let round = 0; round < rounds; round++) for (const mode of ['full', 'notes']) for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const result = await run(mode, variant, round); report.samples.push(result);
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, variant, round, privateMiB: result.after.privateMiB, heapMiB: result.finalHeap.JSHeapUsedSize / 1048576, cpu: result.idleCpuOneCorePercent }));
    }
    for (const mode of ['full', 'notes']) for (const variant of ['baseline', 'current']) {
      const rows = report.samples.filter(item => item.mode === mode && item.variant === variant);
      report.summary.push({ mode, variant, privateMiB: median(rows.map(item => item.after.privateMiB)), workingMiB: median(rows.map(item => item.after.workingMiB)),
        heapMiB: median(rows.map(item => item.finalHeap.JSHeapUsedSize / 1048576)), cpuOneCorePercent: median(rows.map(item => item.idleCpuOneCorePercent)),
        interactionCpuSeconds: median(rows.map(item => item.interactionCpuSeconds)) });
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, summary: report.summary }));
  } finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

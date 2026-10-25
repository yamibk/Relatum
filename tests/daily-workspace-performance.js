'use strict';
// Fresh profiles and isolated servers; baseline assets come from Git without a checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util'), execute = promisify(execFile);
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const python = process.env.RELATUM_PYTHON || 'python';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-daily-perf-'));
const old = new Map(), report = { baselineRef: process.env.RELATUM_DAILY_BASELINE || 'HEAD', browser: [], native: [], note: 'Fresh browser profiles; OS file cache is retained. Native samples use a hidden source desktop shell.' };
report.baselineRef = execFileSync('git', ['rev-parse', report.baselineRef], { cwd: repo, encoding: 'utf8' }).trim();
const changed = execFileSync('git', ['diff', report.baselineRef, '--name-only', '--', 'assets'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/);
for (const file of changed) if (/\.(?:js|css|html)$/.test(file)) old.set('/' + file.slice(7), execFileSync('git', ['show', report.baselineRef + ':' + file], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
async function port() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value; }
async function baseline(page) {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname, file = pathname === '/' ? '/index.html' : pathname;
    if (!old.has(file)) return route.continue();
    let body = old.get(file);
    if (file === '/index.html') {
      const current = await (await route.fetch()).text();
      const prefix = current.slice(current.indexOf('<head>') + 6, current.indexOf('\n  <meta charset'));
      body = body.replace('<head>', '<head>' + prefix);
    }
    await route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript', body });
  });
}
async function sample(page, label, base) {
  if (label === 'before') await baseline(page);
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  await page.goto(base); await page.waitForFunction(() => !!window.RelatumStartWorkspace);
  await page.waitForTimeout(3500); await cdp.send('HeapProfiler.collectGarbage');
  const raw = await cdp.send('Performance.getMetrics'), metrics = Object.fromEntries(raw.metrics.map(item => [item.name, item.value]));
  const data = await page.evaluate(() => ({
    dom: document.querySelectorAll('*').length,
    scripts: [...document.scripts].filter(node => node.src).length,
    scriptAndCssBytes: performance.getEntriesByType('resource').filter(item => /\.(?:js|css)$/.test(new URL(item.name).pathname)).reduce((sum, item) => sum + item.decodedBodySize, 0),
    navigation: (() => { const n = performance.getEntriesByType('navigation')[0]; return { domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd }; })(),
    documentHidden: document.hidden,
  }));
  await cdp.detach(); return { label, ...data, heapBytes: metrics.JSHeapUsedSize, nodes: metrics.Nodes, listeners: metrics.JSEventListeners, scriptMs: metrics.ScriptDuration * 1000, layoutMs: metrics.LayoutDuration * 1000 };
}
async function pageTimings(page, label) {
  // End-to-end automated navigation, including lazy assets and business reads.
  // Reduced motion removes the intentionally different outer transition lengths.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (label === 'after') await page.evaluate(async () => {
    const layout = RelatumStartWorkspace.layout;
    layout.hidden = layout.hidden.filter(id => id !== 'daily');
    await RelatumStartWorkspace.applyLayout(layout);
  });
  const pending = new Set(), rows = [];
  const requested = request => { if (/\/api\/(?:daily|focus|calendar|ledger|diary|countdown)(?:[/?-]|$)/.test(request.url())) pending.add(request); };
  const finished = request => pending.delete(request);
  page.on('request', requested); page.on('requestfinished', finished); page.on('requestfailed', finished);
  try {
    for (const pass of ['first', 'return']) for (const id of ['tasks', 'calendar', 'focus', 'ledger']) {
      const started = performance.now();
      if (label === 'after') {
        await page.locator('button[data-start-workspace="daily"]').evaluate(element => { if (!element.classList.contains('active')) element.click(); });
        await page.waitForFunction(() => RelatumStartWorkspace.current === 'daily' && !!window.RelatumDailyWorkspace?.current);
        await page.locator(`[data-daily-page="${id}"]`).evaluate(element => { if (!element.classList.contains('active')) element.click(); });
        await page.waitForFunction(id => RelatumDailyWorkspace.current === id, id);
      } else {
        const parent = ['tasks', 'focus'].includes(id) ? 'focus' : 'calendar';
        await page.locator(`[data-action="${parent}-view"]`).evaluate(element => { if (!element.classList.contains('active')) element.click(); });
        await page.waitForFunction(parent => document.querySelector('.book-view').dataset.viewName === parent, parent);
        await page.locator(`[data-action="${parent}-view"]`).evaluate((element, id) => {
          const expected = id === 'tasks' ? 'daily' : id === 'focus' ? 'timer' : id;
          if ((['tasks', 'focus'].includes(id) ? CanvasFocus : CanvasCalendar).getViewMode() !== expected) element.click();
        }, id);
        await page.waitForFunction(id => (['tasks', 'focus'].includes(id) ? CanvasFocus : CanvasCalendar).getViewMode()
          === (id === 'tasks' ? 'daily' : id === 'focus' ? 'timer' : id), id);
      }
      const selector = { tasks: '[data-role="focus-daily-list"]', calendar: '[data-calendar-day]', focus: '[data-role="focus-primary"]', ledger: '[data-ledger-add]' }[id];
      await page.locator(selector).first().waitFor({ state: 'visible' });
      for (let i = 0; pending.size && i < 200; i++) await delay(10);
      assert.equal(pending.size, 0, id + ' business requests settled');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      rows.push({ pass, page: id, elapsedMs: performance.now() - started });
    }
    return rows;
  } finally { page.off('request', requested); page.off('requestfinished', finished); page.off('requestfailed', finished); }
}
async function nativeMemory(pid) {
  const code = `$items = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $before = $ids.Count; foreach($item in $items){if($ids.Contains([int]$item.ParentProcessId)){[void]$ids.Add([int]$item.ProcessId)}} }while($before -ne $ids.Count); $rows = @(foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{id=$p.Id;name=$p.ProcessName;private=$p.PrivateMemorySize64;working=$p.WorkingSet64}}});ConvertTo-Json -InputObject $rows -Compress`;
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', code], { windowsHide: true });
  const processes = JSON.parse(result.stdout); return { processes, privateMiB: processes.reduce((n, p) => n + p.private, 0) / 1048576 };
}
(async () => {
  const servicePort = await port(), base = `http://127.0.0.1:${servicePort}`;
  const server = spawn(python, ['-B', 'app.py', '--no-browser', '--port', String(servicePort)], { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: path.join(root, 'data') }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch (_) {} await delay(100); }
    browser = await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH, headless: true });
    for (let round = 0; round < 5; round++) for (const label of ['before', 'after']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage(), sampled = await sample(page, label, base);
      report.browser.push({ round, ...sampled, pageTimings: await pageTimings(page, label) }); await context.close();
    }
    await browser.close(); browser = null;
    if (process.env.RELATUM_DESKTOP_PYTHON) for (let round = 0; round < 3; round++) for (const label of ['before', 'after']) {
      const data = path.join(root, `native-${round}-${label}`); fs.mkdirSync(data);
      const debugPort = await port(), startFile = path.join(data, 'start.json');
      const app = spawn(process.env.RELATUM_DESKTOP_PYTHON, ['-B', path.join(repo, 'tests/daily-native-performance.py')], {
        cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: data, LOCALAPPDATA: data, RELATUM_DAILY_START_URL: startFile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = ''; app.stdout.on('data', value => logs += value); app.stderr.on('data', value => logs += value);
      let native;
      try {
        let ready = false;
        for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok && fs.existsSync(startFile)) { ready = true; break; } } catch (_) {} if (app.exitCode !== null) throw Error('Native shell exited: ' + app.exitCode + '\n' + logs); await delay(100); }
        assert(ready, 'hidden native shell starts');
        native = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
        const page = native.contexts()[0].pages()[0], target = JSON.parse(fs.readFileSync(startFile, 'utf8')).url;
        const sampled = await sample(page, label, target); await page.waitForTimeout(2500);
        report.native.push({ round, ...sampled, ...await nativeMemory(app.pid) });
        await page.evaluate(() => window.pywebview.api.close_window());
      } finally { await native?.close(); app.kill(); }
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    report.medians = {};
    for (const kind of ['browser', 'native']) for (const label of ['before', 'after']) {
      const rows = report[kind].filter(row => row.label === label); if (!rows.length) continue;
      report.medians[kind + '-' + label] = Object.fromEntries(['dom', 'scripts', 'scriptAndCssBytes', 'heapBytes', 'listeners', 'scriptMs', 'layoutMs', ...(kind === 'native' ? ['privateMiB'] : [])].map(key => [key, median(rows.map(row => row[key]))]));
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(root, 'report.json'), medians: report.medians }, null, 2));
  } finally { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log('Performance artifacts:', root); await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

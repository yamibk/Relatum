'use strict';
// Source desktop measurements only. Every process gets a fresh data/WebView root.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.argv[2] || path.join(os.tmpdir(), 'relatum-startup-timing.json');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-startup-timing-'));
async function sample(round) {
  const root = fs.mkdtempSync(path.join(artifacts, 'run-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const trace = path.join(root, 'startup.jsonl'), startedAt = Date.now();
  const app = spawn(process.env.RELATUM_NATIVE_PYTHON || process.env.RELATUM_PYTHON || 'python', ['-B', 'tests/startup-timing-native.py'], {
    cwd: repo, windowsHide: true, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root,
      RELATUM_STARTUP_TRACE: trace, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let logs = '', browser, closed = false;
  app.stdout.on('data', chunk => logs += chunk); app.stderr.on('data', chunk => logs += chunk);
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (app.exitCode !== null) throw Error('Desktop exited: ' + app.exitCode);
      try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (_) {}
      await pause(50);
    }
    assert(ready, 'WebView2 CDP becomes available');
    const cdpObservedMs = Date.now() - startedAt;
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => performance.getEntriesByName('relatum:canvas-ready').length && window.pywebview?.api?.close_window, null, { timeout: 20000 });
    const document = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, hidden: globalThis.document.hidden,
      marks: performance.getEntriesByType('mark').filter(item => item.name.startsWith('relatum:')).map(item => ({ name: item.name.slice(8), ms: item.startTime })),
      navigation: performance.getEntriesByType('navigation').map(item => ({ dcl: item.domContentLoadedEventEnd, load: item.loadEventEnd })),
      usageVisible: !!globalThis.document.querySelector('[data-usage-panel]')?.getClientRects().length,
    }));
    assert.equal(document.usageVisible, false);
    const stages = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const native = name => Math.round(stages.find(item => item.stage === name).timeMs - startedAt);
    const canvas = document.marks.find(item => item.name === 'canvas-ready');
    const result = { round, pythonEntryMs: native('python-entry'), serverMs: native('server-ready'), webviewMs: native('webview-ready'),
      canvasReadyMs: Math.round(document.timeOrigin + canvas.ms - startedAt), frontendMs: Math.round(canvas.ms), cdpObservedMs, document };
    await page.evaluate(async () => { await CanvasDesktop.flushBeforeClose(); window.pywebview.api.close_window(); });
    for (let i = 0; i < 100; i++) { if (app.exitCode !== null) { closed = true; break; } await pause(50); }
    assert(closed, 'isolated desktop exits normally');
    console.log(JSON.stringify({ round, serverMs: result.serverMs, webviewMs: result.webviewMs, canvasReadyMs: result.canvasReadyMs, frontendMs: result.frontendMs }));
    return result;
  } catch (error) { throw new Error(error.stack + '\n' + logs.slice(-5000)); }
  finally {
    await browser?.close().catch(() => {});
    if (!closed && app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  }
}
(async () => {
  const samples = []; for (let round = 1; round <= 5; round++) samples.push(await sample(round));
  const summary = Object.fromEntries(['pythonEntryMs', 'serverMs', 'webviewMs', 'canvasReadyMs', 'frontendMs'].map(key => {
    const values = samples.map(item => item[key]).sort((a, b) => a - b); return [key, { median: values[2], min: values[0], max: values[4] }];
  }));
  fs.writeFileSync(output, JSON.stringify({ measuredAt: new Date().toISOString(), conditions: 'Source desktop, full feature profile, empty isolated data and fresh WebView2 profile per run; OS caches retained. Native window is hidden; canvas-ready is a DOM readiness mark, not a displayed-frame measurement. No launcher selection dialog or packaged executable is measured.', samples, summary }, null, 2));
  console.log(JSON.stringify({ summary, output, artifacts }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

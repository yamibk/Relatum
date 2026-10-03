'use strict';
// Alternating fresh data roots and WebView profiles; CDP is diagnostic only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = path.resolve(process.argv[2] || path.join(__dirname, '../../Relatum-release'));
const output = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'relatum-startup-after.json'));
const rounds = Math.max(5, Number(process.argv[4]) || 5);
const catalog = JSON.parse(fs.readFileSync(path.join(release, '_internal/assets/feature-catalog.json'), 'utf8'));
const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function run(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-startup-')), port = await freePort();
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/launcher-profile.json'), JSON.stringify(profile));
  fs.writeFileSync(path.join(root, 'data/launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  const trace = path.join(root, 'startup.jsonl'), started = Date.now(), clock = process.hrtime.bigint();
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - clock) / 1e6);
  const app = spawn(path.join(release, mode === 'launcher' ? 'RelatumLauncher.exe' : 'Relatum.exe'), mode === 'direct' ? ['--launch-profile', JSON.stringify(profile)] : [], {
    cwd: release, env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, RELATUM_STARTUP_TRACE: trace, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, windowsHide: true, stdio: 'ignore',
  });
  let browser, closed = false;
  try {
    let ready = false;
    for (let i = 0; i < 600; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { ready = true; break; } } catch (_) {}
      await sleep(50);
    }
    if (!ready) throw Error('WebView2 startup timeout');
    const webviewMs = elapsed();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page;
    for (let i = 0; i < 100; i++) { page = browser.contexts()[0]?.pages()[0]; if (page) break; await sleep(20); }
    await page.waitForFunction(() => window.CanvasNoteWorkspace && window.RelatumStartWorkspace?.current === 'notes' && !document.documentElement.classList.contains('note-boot-pending') && typeof window.pywebview?.api?.set_dirty === 'function');
    const homeMs = elapsed();
    const document = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      marks: performance.getEntriesByType('mark').filter(item => item.name.startsWith('relatum:')).map(item => ({ stage: item.name.slice(8), startMs: item.startTime })),
      resources: performance.getEntriesByType('resource').filter(item => /note-|codemirror|\/api\/notes/.test(item.name)).map(item => ({ name: new URL(item.name).pathname, startMs: item.startTime, durationMs: item.duration })),
    }));
    await page.waitForFunction(() => typeof window.pywebview?.api?.close_window === 'function');
    await page.evaluate(async () => { await window.CanvasDesktop.flushBeforeClose(); window.pywebview.api.close_window(); });
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch (_) { closed = true; break; }
      await sleep(50);
    }
    if (!closed) throw Error('Window failed to close');
    const nativeStages = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(item => ({ stage: item.stage, pid: item.pid, elapsedMs: Math.round(item.timeMs - started) }));
    const sample = { mode, startedAtMs: started, webviewMs, homeMs, nativeStages, document };
    console.log(JSON.stringify({ mode, webviewMs, homeMs }));
    return sample;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!closed && app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await sleep(500);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (_) { console.log(`Retained locked isolated root: ${root}`); }
  }
}
(async () => {
  const samples = [];
  for (let round = 0; round < rounds; round++) for (const mode of (round % 2 ? ['launcher', 'direct'] : ['direct', 'launcher'])) samples.push(await run(mode));
  const stats = values => { const sorted = values.sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }; };
  const summary = Object.fromEntries(['direct', 'launcher'].map(mode => [mode, {
    home: stats(samples.filter(item => item.mode === mode).map(item => item.homeMs)),
    webview: stats(samples.filter(item => item.mode === mode).map(item => item.webviewMs)),
  }]));
  fs.writeFileSync(output, JSON.stringify({ rounds, profile, samples, summary }, null, 2));
  console.log(JSON.stringify({ summary, output }));
})().catch(error => { console.error(error); process.exitCode = 1; });

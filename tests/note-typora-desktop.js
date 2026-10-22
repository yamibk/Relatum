'use strict';
// Manual Windows IME companion: native input is sent by computer-use, never
// synthesized by CDP. The EXE, notes and WebView profile are isolated.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-typora-desktop-'));
const release = process.env.RELATUM_TYPORA_RELEASE || 'D:/Relatum-release';
const source = '# 桌面体验验收\n\n普通正文 Typography 123。\n\n正文落点，用于真实微软拼音确认与取消。\n\n<u>下划线</u> x<sup>2</sup> H<sub>2</sub>O\n\n- [x] 蓝色任务框\n- [ ] 保存与撤销\n\n> 一级引用\n>\n> > 二级引用\n> >\n> > > 三级引用\n\nhttps://example.com/\n\n[TOC]\n\n## 脚注\n\n正文[^note]\n\n[^note]: 脚注说明';
fs.mkdirSync(path.join(root, 'notes')); fs.writeFileSync(path.join(root, 'notes/桌面体验验收.md'), source);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const debugPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
  const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes' || item.id === 'notes.canvas'])) };
  const process = spawn(path.join(release, 'Relatum.exe'), ['--launch-profile', JSON.stringify(profile)], {
    cwd: release, windowsHide: true, stdio: 'ignore', env: { ...global.process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break; } catch {}
      if (process.exitCode !== null) throw new Error('Isolated desktop exited before CDP was available');
      await pause(100);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    let page;
    for (let attempt = 0; attempt < 100; attempt++) { page = context.pages().find(page => page.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100); }
    if (!page) throw new Error('No isolated WebView page');
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const name = decodeURIComponent(url.pathname).replace(/^\/(?:assets\/)?/, '');
      const file = path.resolve(repo, 'assets', name);
      if (!/\.(?:js|css|woff2)$/.test(name) || !file.startsWith(path.join(repo,'assets') + path.sep) || !fs.existsSync(file)) return route.continue();
      let body = fs.readFileSync(file);
      if (name === 'note-workspace.js') body = body.toString('utf8').replace('  window.CanvasNoteWorkspace = {', '  window.__typoraDesktop = {state, get editor(){return liveEditor}};\n  window.CanvasNoteWorkspace = {');
      return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'font/woff2', body });
    });
    await page.addInitScript(() => { localStorage.setItem('canvas:startWorkspace:v1','notes'); localStorage.setItem('canvas:noteView:v1','live'); });
    await page.reload(); await page.waitForFunction(() => window.__typoraDesktop?.state.initialized);
    const ready = { root, debugPort, pid: process.pid, source, note: path.join(root, 'notes/桌面体验验收.md') };
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify(ready, null, 2));
    console.log(JSON.stringify(ready));
    while (!fs.existsSync(path.join(root, 'finish'))) { if (process.exitCode !== null) throw new Error('Desktop closed during manual verification'); await pause(500); }
    await page.screenshot({ path: path.join(root, 'desktop.png') });
    const report = await page.evaluate(() => ({ source: __typoraDesktop.editor?.snapshot().value,
      font: getComputedStyle(document.querySelector('.cm-content')).fontFamily,
      lineHeight: getComputedStyle(document.querySelector('.cm-content')).lineHeight, dpr: devicePixelRatio }));
    report.disk = fs.readFileSync(ready.note, 'utf8'); report.errors = errors;
    report.unchanged = report.source === source && report.disk === source;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, unchanged: report.unchanged, errors, font: report.font, lineHeight: report.lineHeight, dpr: report.dpr }));
    if (!report.unchanged || errors.length) throw new Error('Desktop source/disk verification failed');
  } finally { if (browser) await browser.close(); if (process.exitCode === null) process.kill(); }
})().catch(error => { console.error(error); global.process.exitCode = 1; });

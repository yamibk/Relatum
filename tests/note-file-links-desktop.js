'use strict';
// Native WebView2 + source bridge. --launch-defaults also dispatches the three
// disposable documents to their actual Windows default applications.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { pathToFileURL } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-file-links-desktop-'));
const workspace = process.argv.includes('--workspace'), actual = process.argv.includes('--launch-defaults');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const documents = path.join(root, '外部文档 空格'); fs.mkdirSync(documents);
const targets = ['Relatum-file-link-validation.html', 'Relatum-file-link-validation.pdf', 'Relatum-file-link-validation.png'].map(name => path.join(documents, name));
const urls = targets.map(file => pathToFileURL(file).href);
fs.writeFileSync(targets[0], '<!doctype html><meta charset="utf-8"><title>Relatum external link validation</title><h1>Relatum 本机文件链接验收</h1><p>临时 HTML 文件已由系统默认程序打开。</p>');
const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 22 Tf 60 700 Td (Relatum local file link validation) Tj ET';
pdfObjects.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
let pdf = '%PDF-1.4\n', offsets = [0];
pdfObjects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
const xref = Buffer.byteLength(pdf);
pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
fs.writeFileSync(targets[1], pdf);
const note = workspace ? path.join(root, 'notes', 'Main.md') : path.join(root, 'Main.md');
fs.mkdirSync(path.dirname(note), { recursive: true }); fs.writeFileSync(note, '# 本机文件链接\n\n' + urls.join('\n\n') + '\n');
if (workspace) {
  const prefs = path.join(root, 'data', 'desktop-sessions', 'full'); fs.mkdirSync(prefs, { recursive: true });
  fs.writeFileSync(path.join(prefs, 'preferences.json'), JSON.stringify({ version: 1, values: {
    'canvas:startWorkspace:v1': 'notes', 'canvas:noteOpenTabs:v1': '["Main.md"]', 'canvas:noteActiveTab:v1': 'Main.md',
  } }));
}
const record = path.join(root, 'opens.jsonl');
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const bootstrap = [
    'import os, sys, json, desktop', 'from PIL import Image, ImageDraw',
    'image=Image.new("RGB", (640,400), "white")', 'draw=ImageDraw.Draw(image)',
    'draw.text((40,170), "RELATUM LOCAL FILE LINK VALIDATION", fill="black", font_size=24)',
    'image.save(' + JSON.stringify(targets[2]) + ')', 'original_startfile=os.startfile',
    'def record_open(target, *args, **kwargs):',
    ...(actual ? ['    original_startfile(target, *args, **kwargs)'] : []),
    '    with open(' + JSON.stringify(record) + ', "a", encoding="utf-8") as stream:',
    '        stream.write(json.dumps(str(target), ensure_ascii=False)+"\\n")',
    'os.startfile=record_open', 'sys.argv=["desktop.py"' + (workspace ? '' : ', ' + JSON.stringify(note)) + ']', 'sys.exit(desktop.main())',
  ].join('\n');
  const child = spawn(process.env.RELATUM_NATIVE_PYTHON || process.env.RELATUM_PYTHON || 'python', ['-B', '-c', bootstrap], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let logs = '', browser;
  child.stdout.on('data', value => logs = (logs + value).slice(-6000)); child.stderr.on('data', value => logs = (logs + value).slice(-6000));
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch (_) {}
      if (ready) break; assert.equal(child.exitCode, null, logs); await pause(100);
    }
    assert(ready, logs);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    let page;
    for (let i = 0; i < 100; i++) {
      page = browser.contexts()[0].pages().find(page => page.url().includes(workspace ? 'index.html' : 'markdown-file.html'));
      if (page) break; await pause(100);
    }
    assert(page, logs); page.setDefaultTimeout(15000);
    if (workspace) await page.waitForFunction(() => window.CanvasNoteWorkspace?.currentPath === 'Main.md');
    else await page.waitForFunction(() => window.RelatumMarkdownWindow?.editor);
    for (const [index, url] of urls.entries()) {
      await page.locator('.note-live-link').filter({ hasText: url }).first().click({ modifiers: ['Control'] });
      for (let i = 0; i < 100 && (!fs.existsSync(record) || fs.readFileSync(record, 'utf8').trim().split('\n').length < index + 1); i++) await pause(100);
      const opened = fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(opened[index], targets[index], logs);
    }
    if (!workspace) {
      const blocked = await page.evaluate(() => pywebview.api.markdown_open_link('file:///C:/Windows/system32/cmd.exe'));
      assert.equal(blocked.ok, false); assert.equal(blocked.code, 'unsafe_path');
      assert(!fs.existsSync(path.join(root, 'notes')), 'the standalone window does not create a notebook');
    }
    await page.screenshot({ path: path.join(root, 'desktop.png') });
    console.log('note file links native: ok (' + (workspace ? 'workspace' : 'standalone') + (actual ? ', actual default applications' : ', OS opener substitute') + '); ' + root);
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode == null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

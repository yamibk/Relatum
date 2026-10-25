'use strict';
// Real local service and disposable library; browser probes never use user notes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-image-compat-'));
const notes = path.join(root, 'notes');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
<style>.shape { fill: url(#gradient); }</style>
<defs><linearGradient id="gradient"><stop stop-color="#78936c"/><stop offset="1" stop-color="#cfaa70"/></linearGradient></defs>
<rect class="shape" x="1" y="1" width="398" height="198" rx="16"/>
<text x="30" y="110" font-size="32" fill="white">SVG 矢量图片</text></svg>`;
const source = [
  '![电路|160](images/电路\\(1\\).png)',
  '前文 ![电路|80](images/电路(1).png) 后文',
  '![空格|160](<images/电路 空格\\(1\\).png> "标题")',
  '![编码|160](images/%E7%94%B5%E8%B7%AF%281%29.png)',
  '![Windows|160](images\\plain.png)',
  '![[images/电路(1).png|160]]',
  '![矢量|160](<images/矢量 (1).svg>)',
  '行内 ![矢量行内|80](images/vector.svg) 后文',
  '![[images/vector.svg|160]]',
].join('\n\n');
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh}.note-live-editor-host{height:95vh}</style>
</head><body class="start-page" data-start-theme="light"><main class="note-document-pane">
<div id="editor" class="note-live-editor-host"></div><div id="reader" class="note-reading-view" hidden></div></main>
<script src="markdown-table.js"></script><script src="markdown.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>
window.editor=null;window.probes=[];const originalFetch=window.fetch;
window.fetch=(url,options)=>{const probe={url:String(url),aborted:false};probes.push(probe);
options?.signal?.addEventListener('abort',()=>probe.aborted=true);return originalFetch(url,options);};
window.show=(value,mode='live')=>{
 window.editor?.destroy();window.editor=null;RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reader'));
 const reading=mode==='reading';document.getElementById('editor').hidden=reading;document.getElementById('reader').hidden=!reading;
 if(reading)RelatumNoteLiveEditor.renderMarkdown(document.getElementById('reader'),value,'Picture.md');
 else window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value,notePath:'Picture.md',sourceMode:mode==='source'});
};</script></body></html>`;

(async () => {
  fs.mkdirSync(path.join(notes, 'images'), { recursive: true });
  fs.mkdirSync(path.join(notes, 'other'));
  fs.writeFileSync(path.join(notes, 'Picture.md'), source);
  for (const name of ['电路(1).png', '电路 空格(1).png', 'plain.png']) fs.writeFileSync(path.join(notes, 'images', name), png);
  fs.writeFileSync(path.join(notes, 'other', 'plain.png'), png);
  for (const name of ['矢量 (1).svg', 'vector.svg']) fs.writeFileSync(path.join(notes, 'images', name), svg);
  fs.writeFileSync(path.join(notes, 'bad.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted=1</script></svg>');
  const oversized = Buffer.from(png); oversized.writeUInt32BE(40000, 16);
  fs.writeFileSync(path.join(notes, 'oversized.png'), oversized);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = ''; server.stdout.on('data', chunk => diagnostics += chunk); server.stderr.on('data', chunk => diagnostics += chunk);
  let browser, page;
  const held = [];
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.route(url + '/image-compat-harness', route => route.fulfill({ contentType: 'text/html', body: harness }));
    await page.route('**/api/note-asset?**', async route => {
      if (!new URL(route.request().url()).searchParams.get('src').startsWith('slow.png')) return route.continue();
      if (route.request().resourceType() === 'fetch') await new Promise(resolve => held.push(resolve));
      try { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'not_found' }) }); } catch (_) {}
    });
    await page.goto(url + '/image-compat-harness');
    await page.waitForFunction(() => typeof window.show === 'function');
    for (const mode of ['live', 'reading']) {
      await page.evaluate(({ source, mode }) => show(source, mode), { source, mode });
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('.note-live-image-frame img, .md-local-image img')];
        return images.length === 9 && images.every(image => image.naturalWidth > 0);
      });
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.note-live-image-frame img, .md-local-image img')]
        .filter(image => image.src.includes('.svg')).every(image => Math.abs(image.naturalWidth / image.naturalHeight - 2) < 0.01)), true, 'viewBox-only SVG keeps its aspect ratio');
      assert.equal(await page.evaluate(() => probes.length), 0, 'successful images must not make diagnostic requests');
      if (mode === 'live') {
        assert.equal(await page.evaluate(() => editor.snapshot().value), source);
        await page.locator('.note-live-image-frame.is-block').first().click({ position: { x: 15, y: 15 } });
        const handle = page.locator('.note-live-image-resize-handle');
        await handle.waitFor();
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
        const resized = await page.evaluate(() => editor.snapshot().value);
        assert.notEqual(resized, source);
        assert(resized.includes('(images/电路\\(1\\).png)'), 'resizing preserves the original escaped destination');
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => editor.snapshot().value), source, 'one undo restores the original image source');
        await page.locator('.note-live-image-frame').filter({ has: page.locator('img[alt="矢量"]') }).click({ position: { x: 15, y: 15 } });
        const svgHandle = await page.locator('.note-live-image-resize-handle').boundingBox();
        await page.mouse.move(svgHandle.x + svgHandle.width / 2, svgHandle.y + svgHandle.height / 2);
        await page.mouse.down(); await page.mouse.move(svgHandle.x + 60, svgHandle.y + svgHandle.height / 2, { steps: 4 }); await page.mouse.up();
        const svgResized = await page.evaluate(() => editor.snapshot().value);
        assert.notEqual(svgResized, source);
        assert(svgResized.includes('](<images/矢量 (1).svg>)'), 'SVG resize keeps the vector file and its original path');
        await page.keyboard.press('Control+z');
        assert.equal(await page.evaluate(() => editor.snapshot().value), source, 'SVG resize is one undo step');
      }
      await page.screenshot({ path: path.join(root, `image-svg-${mode}.png`) });
    }
    await page.evaluate(value => show(value, 'source'), source);
    assert.equal(await page.locator('.note-live-image-frame img, .md-local-image img').count(), 0);
    await page.evaluate(() => show('`![图](images/a.png)`\n\n![图]\\(images/a.png)'));
    assert.equal(await page.locator('.note-live-image-frame img, .md-local-image img').count(), 0, 'examples and escaped syntax must remain source');
    for (const mode of ['live', 'reading']) {
      const before = requests.length;
      await page.evaluate(mode => show('![绝对](C:/library/a.png)\n\n行内 ![绝对](file:///C:/library/a.png)', mode), mode);
      await page.waitForFunction(() => document.querySelectorAll('.is-failed[data-error-label]').length === 2);
      assert.equal(await page.locator('[data-error-label]').first().getAttribute('data-error-label'), '仅支持笔记库内相对路径，请将图片放入笔记库后使用相对路径');
      assert.equal(requests.slice(before).filter(value => value.includes('/api/note-asset')).length, 0);
      for (const [markdown, label] of [
        ['![图](missing.png)', '图片不存在'], ['![图](unsupported.avif)', '不支持这种图片格式'],
        ['![图](bad.svg)', '图片无法加载'],
        ['![图](oversized.png)', '图片超过'], ['![[plain.png]]', '不唯一'], ['![图](../outside.png)', '仅支持'],
      ]) {
        const count = await page.evaluate(() => probes.length);
        await page.evaluate(({ markdown, mode }) => show(markdown, mode), { markdown, mode });
        await page.waitForFunction(label => document.querySelector('[data-error-label]')?.dataset.errorLabel.includes(label), label);
        assert.equal(await page.evaluate(() => probes.length), count + 1, 'each failed image makes at most one diagnostic request');
      }
    }
    for (const mode of ['live', 'reading']) for (const lifecycle of ['replace', 'minimize', 'workspace', 'pagehide']) {
      const count = await page.evaluate(() => probes.length);
      await page.evaluate(({ value, mode }) => show(value, mode), { value: `![慢响应](slow.png#${mode}-${lifecycle})`, mode });
      await page.waitForFunction(count => probes.length === count + 1, count);
      await page.evaluate(lifecycle => {
        if (lifecycle === 'replace') show('![正常](images/plain.png)');
        else if (lifecycle === 'minimize') { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); }
        else if (lifecycle === 'workspace') { document.getElementById('reader').hidden = true; document.getElementById('editor').hidden = true; document.dispatchEvent(new Event('relatum:start-workspacechange')); }
        else window.dispatchEvent(new Event('pagehide'));
      }, lifecycle);
      await page.waitForFunction(() => probes.at(-1).aborted);
      held.splice(0).forEach(resolve => resolve());
      await page.evaluate(() => { delete document.documentElement.dataset.desktopMinimized; show('![正常](images/plain.png)'); });
      await page.waitForFunction(() => document.querySelector('.note-live-image-frame img, .md-local-image img')?.naturalWidth > 0);
      assert.equal(await page.locator('.is-failed').count(), 0, 'late errors must not change the new document');
    }
    const count = await page.evaluate(() => probes.length);
    await page.evaluate(() => show('| 图片 |\n| --- |\n| ![慢响应](slow.png#table) |'));
    await page.waitForFunction(count => probes.length === count + 1, count);
    await page.locator('td[data-table-row="1"]').click();
    await page.locator('.note-table-cell-editor').fill('替换图片');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => probes.at(-1).aborted);
    held.splice(0).forEach(resolve => resolve());
    assert((await page.evaluate(() => editor.snapshot().value)).includes('替换图片'));
    await page.evaluate(() => { document.documentElement.lang = 'en'; document.body.dataset.startTheme = 'dark'; show('![image](missing.png)', 'reading'); });
    await page.setViewportSize({ width: 680, height: 800 });
    await page.waitForFunction(() => document.querySelector('[data-error-label]')?.dataset.errorLabel.startsWith('Image not found'));
    await page.screenshot({ path: path.join(root, 'image-errors-dark-en.png') });
    await page.evaluate(() => show('![vector|320](images/vector.svg)', 'reading'));
    await page.waitForFunction(() => document.querySelector('.md-local-image img')?.naturalWidth > 0);
    await page.screenshot({ path: path.join(root, 'image-svg-dark-en.png') });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.svgExecuted), undefined);
    assert(requests.every(value => !value.startsWith('http') || value.startsWith(url + '/')), 'SVG never loads external resources');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, requests: requests.length, diagnostics: await page.evaluate(() => probes.length) }, null, 2));
    console.log('note image compatibility browser: ok; report: ' + root);
  } catch (error) {
    if (page) {
      console.error(await page.evaluate(() => ({ images: [...document.querySelectorAll('img')].map(image => ({ alt: image.alt, width: image.naturalWidth, src: image.getAttribute('src') })), probes, errors: document.body.textContent.slice(-300) })));
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    }
    console.error(diagnostics.slice(-6000)); throw error;
  } finally {
    held.splice(0).forEach(resolve => resolve());
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

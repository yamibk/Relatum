'use strict';
// Real Edge + disposable service/profile. Never reads personal images or libraries.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json'), 'utf8'));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-image-markup-'));
const native = process.argv.includes('--native');
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function fixture({ only = false, dpr = 1 } = {}) {
  const directory = fs.mkdtempSync(path.join(artifacts, 'run-')), port = await freePort(), debug = native ? await freePort() : 0;
  const choices = Object.fromEntries(catalog.features.map(item => [item.id, only ? ['daily', 'daily.images'].includes(item.id) : item.id !== 'runtime.preload']));
  const args = ['-B', native ? 'desktop.py' : 'app.py', ...(!native ? ['--no-browser', '--port', String(port)] : []), '--launch-profile', JSON.stringify({ version: 1, features: choices })];
  const server = spawn(native ? process.env.RELATUM_NATIVE_PYTHON || process.env.RELATUM_PYTHON || 'python' : process.env.RELATUM_PYTHON || 'python', args,
    { cwd: repo, windowsHide: true, env: { ...process.env, RELATUM_DATA_ROOT: directory, ...(native ? { LOCALAPPDATA: directory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) } });
  let logs = '', browser, context;
  server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  try {
    const base = 'http://127.0.0.1:' + (native ? debug : port);
    let ready = false;
    for (let i = 0; i < 240; i++) {
      if (server.exitCode !== null) throw Error(logs);
      try { if ((await fetch(base + (native ? '/json/version' : ''))).ok) { ready = true; break; } } catch (_) {}
      await pause(100);
    }
    assert(ready, 'isolated service starts: ' + logs);
    browser = native ? await chromium.connectOverCDP(base) : await chromium.launch({ executablePath: process.env.RELATUM_EDGE_PATH, headless: true });
    context = native ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: dpr, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
    const page = native ? context.pages()[0] || await context.newPage() : await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
    if (!native) await page.goto(base);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !!window.RelatumStartWorkspace && !!window.RelatumPageLayout);
    if (native) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await page.evaluate(async () => {
      const layout = RelatumStartWorkspace.layout; layout.hidden = layout.hidden.filter(id => id !== 'daily'); await RelatumStartWorkspace.applyLayout(layout);
      await RelatumStartWorkspace.set('daily', { animate: false }); await RelatumDailyWorkspace.navigate('images');
    });
    await page.waitForSelector('.images-empty:visible');
    assert.equal(await page.locator('.images-head h1').textContent(), '图片编辑');
    assert.equal(await page.locator('[data-daily-page="images"]').textContent(), '图片编辑');
    assert.equal(await page.locator('.images-viewport').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    return { page, errors, requests, directory, async close() { if (native) { try { await page.evaluate(() => pywebview.api.close_window()); } catch (_) {} } await browser.close(); server.kill(); }, logs: () => logs };
  } catch (error) { await browser?.close(); server.kill(); throw error; }
}
async function imageFile(page, { width = 800, height = 500, color = null } = {}) {
  const data = await page.evaluate(async ({ width, height, color }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const c = canvas.getContext('2d');
    if (color) { c.fillStyle = color; c.fillRect(0, 0, width, height); }
    else {
      c.fillStyle = '#f6f7f8'; c.fillRect(0, 0, width, height);
      for (let x = 400; x < 700; x += 4) { c.fillStyle = x % 8 ? '#191919' : '#fafafa'; c.fillRect(x, 40, 4, 100); }
      c.clearRect(0, 0, 32, 32);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { width, height, color });
  return { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(data) };
}
async function load(page, image) {
  await page.locator('.images-file-input').setInputFiles(image);
  await page.waitForFunction(() => document.querySelector('.images-empty').hidden && !document.querySelector('[data-images-action="copy"]').disabled && document.querySelector('.images-loading').hidden);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function point(page, x, y, width = 800, height = 500) {
  return page.locator('.images-viewport').evaluate((node, { x, y, width, height }) => {
    const rect = node.getBoundingClientRect(), scale = Math.min(1, (node.clientWidth - 64) / width, (node.clientHeight - 64) / height);
    return { x: rect.left + node.clientLeft + (node.clientWidth - width * scale) / 2 + x * scale, y: rect.top + node.clientTop + (node.clientHeight - height * scale) / 2 + y * scale };
  }, { x, y, width, height });
}
async function drag(page, tool, x, y, x2, y2) {
  if (tool) await page.locator('[data-images-tool="' + tool + '"]').click();
  const start = await point(page, x, y), end = await point(page, x2, y2);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
}
async function copy(page) {
  await page.locator('[data-images-action="copy"]').click();
  await page.waitForFunction(() => document.querySelector('[data-images-action="copy"]').getAttribute('aria-busy') === 'false');
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read(), item = items.find(item => item.types.includes('image/png')); const blob = await item.getType('image/png');
    const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const c = canvas.getContext('2d'); c.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: canvas.width, height: canvas.height, bytes: Array.from(c.getImageData(0, 0, canvas.width, canvas.height).data) };
  });
}
function pixel(image, x, y) { const i = (Math.round(y) * image.width + Math.round(x)) * 4; return image.bytes.slice(i, i + 4); }
function red(pixel) { return pixel[0] > 180 && pixel[1] < 140 && pixel[2] < 140 && pixel[3] > 200; }
(async () => {
  const f = await fixture(), { page } = f;
  try {
    const original = await imageFile(page); await load(page, original);
    await drag(page, null, 100, 100, 300, 220);
    let result = await copy(page);
    assert.equal(result.width, 800); assert.equal(result.height, 500); assert.equal(pixel(result, 10, 10)[3], 0, 'PNG preserves alpha');
    assert(red(pixel(result, 200, 100)), 'rectangle exports at source coordinates');
    const firstHandle = await point(page, 300, 220), firstResize = await point(page, 340, 250);
    await page.mouse.move(firstHandle.x, firstHandle.y); await page.mouse.down(); await page.mouse.move(firstResize.x, firstResize.y, { steps: 5 }); await page.mouse.up();
    result = await copy(page); assert(red(pixel(result, 340, 180)), 'visible handles work without changing away from the drawing tool');
    await page.keyboard.press('Control+z');
    await drag(page, 'select', 180, 160, 260, 210);
    result = await copy(page); assert(red(pixel(result, 280, 150)), 'existing shape moves');
    // Resize via a selected corner, then undo it before checking the move history.
    const corner = await point(page, 380, 270), resized = await point(page, 430, 300);
    await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(resized.x, resized.y, { steps: 5 }); await page.mouse.up();
    result = await copy(page); assert(red(pixel(result, 430, 220)), 'selection handles resize geometry');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z'); result = await copy(page); assert(red(pixel(result, 200, 100)), 'undo move');
    await page.keyboard.press('Control+Shift+z'); result = await copy(page); assert(red(pixel(result, 280, 150)), 'redo move');
    await page.locator('[data-images-tool="text"]').click(); const textPoint = await point(page, 420, 250); await page.mouse.click(textPoint.x, textPoint.y);
    await page.locator('.images-text-editor').fill('中文标记\nSecond line'); await page.keyboard.press('Control+Enter');
    result = await copy(page); assert(result.bytes.some((_, i, bytes) => i > (250 * 800 + 420) * 4 && i < (320 * 800 + 700) * 4 && i % 4 === 0 && bytes[i] > 180 && bytes[i + 1] < 140), 'multiline text exports');
    await page.locator('[data-images-tool="select"]').click(); await page.mouse.dblclick(textPoint.x + 15, textPoint.y + 15); await page.waitForSelector('.images-text-editor:visible');
    await page.locator('.images-text-editor').fill('修改后的文字'); await page.keyboard.press('Control+Enter');
    // Candidate input keeps Enter inside the textarea until composition ends.
    await page.mouse.dblclick(textPoint.x + 15, textPoint.y + 15);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '候选中文', selectionStart: 4, selectionEnd: 4 });
    await page.keyboard.press('Enter'); assert(await page.locator('.images-text-editor').isVisible(), 'IME Enter does not finish the text box');
    await cdp.send('Input.insertText', { text: '候选中文' }); await page.keyboard.press('Control+Enter'); await cdp.detach();
    await drag(page, 'mosaic', 400, 40, 680, 140);
    result = await copy(page); assert.deepEqual(pixel(result, 420, 90), pixel(result, 423, 90), 'pixelation uses source pixels');
    const retained = result.bytes;
    await page.evaluate(() => RelatumDailyWorkspace.navigate('ledger')); await page.waitForSelector('.daily-page-ledger:visible');
    await page.evaluate(() => RelatumDailyWorkspace.navigate('images')); result = await copy(page); assert.deepEqual(result.bytes, retained, 'subpage switch preserves edits');
    await page.evaluate(() => RelatumStartWorkspace.set('canvas', { animate: false })); await page.waitForTimeout(350);
    assert.equal(await page.locator('.daily-page-images').count(), 0, 'view is actually released');
    await page.evaluate(() => RelatumStartWorkspace.set('daily', { animate: false })); await page.waitForSelector('.images-canvas');
    await page.waitForFunction(() => !document.querySelector('[data-images-action="copy"]').disabled);
    result = await copy(page); assert.deepEqual(result.bytes, retained, 'workspace teardown preserves only the session');
    await drag(page, 'crop', 110, 80, 650, 400); await page.locator('[data-images-action="apply"]').click();
    result = await copy(page); assert(Math.abs(result.width - 540) <= 1 && Math.abs(result.height - 320) <= 1, 'crop outputs native pixel dimensions');
    await page.keyboard.press('Control+z'); result = await copy(page); assert.deepEqual(result.bytes, retained, 'crop undo restores full image');
    for (const tool of ['ellipse', 'arrow', 'line', 'pen']) await drag(page, tool, 40, 300, 200, 400);
    await page.screenshot({ path: path.join(artifacts, 'workbench-light.png') });
    const blue = await imageFile(page, { width: 200, height: 120, color: '#0088cc' }); await load(page, blue);
    result = await copy(page); assert.equal(result.width, 200);
    await page.locator('.images-delete').click(); assert(await page.locator('.images-empty').isVisible());
    await page.keyboard.press('Control+z'); await page.waitForFunction(() => !document.querySelector('[data-images-action="copy"]').disabled);
    result = await copy(page); assert.equal(result.width, 200, 'delete is undoable');
    await page.keyboard.press('Control+z'); await page.waitForFunction(() => !document.querySelector('[data-images-action="copy"]').disabled);
    result = await copy(page); assert.equal(result.width, 800, 'replacement undo restores previous image and annotations');
    await page.locator('.images-file-input').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid') }); await page.waitForTimeout(100);
    result = await copy(page); assert.equal(result.width, 800, 'invalid import keeps old image');
    await page.evaluate(() => { window.__decode = createImageBitmap; window.createImageBitmap = (...args) => new Promise(resolve => { window.__releaseDecode = () => __decode(...args).then(resolve); }); });
    await page.locator('.images-file-input').setInputFiles(blue); await page.waitForFunction(() => !!window.__releaseDecode);
    await page.locator('.images-delete').click(); await page.evaluate(() => { __releaseDecode(); window.createImageBitmap = __decode; }); await page.waitForTimeout(150);
    assert(await page.locator('.images-empty').isVisible(), 'late import cannot resurrect deleted image');
    assert(await page.locator('.images-loading').isHidden(), 'delete also cancels loading feedback');
    await load(page, original);
    await page.evaluate(() => {
      window.__toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) { return __toBlob.call(this, blob => { window.__releaseEncode = () => callback(blob); }, ...args); };
    });
    await page.locator('[data-images-action="copy"]').click(); await page.waitForFunction(() => !!window.__releaseEncode);
    await page.locator('.images-delete').click();
    await page.evaluate(() => { __releaseEncode(); HTMLCanvasElement.prototype.toBlob = __toBlob; });
    await page.waitForTimeout(80); assert(await page.locator('.images-empty').isVisible(), 'late clipboard encoding cannot restore deleted content');
    await load(page, original);
    await page.locator('.images-viewport').click({ button: 'right' }); assert.equal(await page.locator('.images-context-menu button').count(), 3);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.images-context-menu').count(), 0);
    // Real clipboard source, keyboard paste, then keyboard copy.
    await page.evaluate(async bytes => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]); }, [...blue.buffer]);
    await page.locator('.images-viewport').click(); await page.keyboard.press('Control+v'); await page.waitForFunction(() => document.querySelector('.images-dimensions').textContent === '200 × 120');
    await page.keyboard.press('Control+c'); await page.waitForFunction(() => document.querySelector('[data-images-action="copy"]').getAttribute('aria-busy') === 'false');
    assert.equal((await copy(page)).width, 200, 'real clipboard paste/copy');
    await page.evaluate(() => { window.__write = navigator.clipboard.write; navigator.clipboard.write = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
    await page.locator('[data-images-action="copy"]').click(); await page.waitForFunction(() => document.querySelector('[data-images-action="copy"]').getAttribute('aria-busy') === 'false');
    assert(await page.locator('.images-empty').isHidden()); await page.evaluate(() => navigator.clipboard.write = __write);
    // File drag/drop uses the same importer and does not navigate away.
    await page.locator('.images-viewport').evaluate((node, bytes) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }));
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, [...original.buffer]);
    await page.waitForFunction(() => document.querySelector('.images-dimensions').textContent === '800 × 500');
    await page.waitForFunction(() => !document.querySelector('[data-images-action="copy"]').disabled);
    // Reject huge dimensions from just the header, without invoking a decoder.
    await page.evaluate(async () => {
      window.__decodeCalls = 0; const decode = window.createImageBitmap; window.createImageBitmap = (...args) => { __decodeCalls++; return decode(...args); };
      const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12); const view = new DataView(bytes.buffer); view.setUint32(16, 20000); view.setUint32(20, 1);
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'huge.png', { type: 'image/png' }));
      document.querySelector('.images-viewport').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await new Promise(resolve => setTimeout(resolve, 100)); window.createImageBitmap = decode;
    });
    assert.equal(await page.evaluate(() => __decodeCalls), 0, 'oversized header rejected before decoding');
    assert.equal((await copy(page)).width, 800);
    // Transparent GIF and a tiny BMP exercise both non-PNG header/decode paths.
    await load(page, { name: 'tiny.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') });
    assert.equal((await copy(page)).width, 1);
    const bmp = Buffer.alloc(70); bmp.write('BM'); bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.fill(128, 54);
    await load(page, { name: 'tiny.bmp', mimeType: 'image/bmp', buffer: bmp }); assert.equal((await copy(page)).height, 2);
    for (const type of ['image/jpeg', 'image/webp']) {
      const bytes = await page.evaluate(async type => { const c = document.createElement('canvas'); c.width = 20; c.height = 10; const blob = await new Promise(resolve => c.toBlob(resolve, type)); return [...new Uint8Array(await blob.arrayBuffer())]; }, type);
      await load(page, { name: 'tiny.' + type.split('/')[1], mimeType: type, buffer: Buffer.from(bytes) }); assert.equal((await copy(page)).width, 20);
    }
    await load(page, blue);
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; RelatumI18n.setLanguage?.('en'); });
    assert.equal(await page.locator('.images-head h1').textContent(), 'Image editor');
    assert.equal(await page.locator('[data-daily-page="images"]').textContent(), 'Image editor');
    assert.equal(await page.locator('.images-viewport').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    if (!native) await page.setViewportSize({ width: 720, height: 780 });
    await page.screenshot({ path: path.join(artifacts, 'workbench-dark-narrow.png') });
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(await page.locator('.images-canvas').evaluate(node => node.width), 0, 'minimize releases backing canvas');
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.waitForFunction(() => !document.querySelector('[data-images-action="copy"]').disabled); assert.equal((await copy(page)).width, 200);
    if (!native) {
      await page.reload(); await page.waitForFunction(() => window.RelatumDailyWorkspace?.current === 'images');
      assert(await page.locator('.images-empty').isVisible(), 'refresh clears image session');
    }
    assert.deepEqual(f.errors, []); console.log('Image workbench browser passed:', artifacts);
  } finally { await f.close(); }
  if (!native) {
    const independent = await fixture({ only: true, dpr: 2 });
    try {
      assert.deepEqual(await independent.page.locator('[data-daily-page]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.dailyPage)), ['images']);
      assert(!independent.requests.some(url => /\/(?:note-workspace|note-live-editor|canvas|mathjax-runtime|graph-engine)\.js$/.test(url)), 'standalone images does not load editors');
      await load(independent.page, await imageFile(independent.page)); await drag(independent.page, 'arrow', 30, 40, 250, 200);
      const result = await copy(independent.page); assert.equal(result.width, 800, 'DPR 2 does not multiply output pixels');
      const raf = await independent.page.evaluate(async () => {
        let calls = 0; const original = window.requestAnimationFrame; window.requestAnimationFrame = (...args) => { calls++; return original(...args); };
        await new Promise(resolve => setTimeout(resolve, 500)); window.requestAnimationFrame = original; return calls;
      });
      assert.equal(raf, 0, 'idle page has no animation loop'); assert.deepEqual(independent.errors, []);
      const cdp = await independent.page.context().newCDPSession(independent.page); await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.collectGarbage');
      const count = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value])).JSEventListeners;
      const before = await count();
      for (let i = 0; i < 6; i++) {
        await independent.page.evaluate(() => RelatumStartWorkspace.applyLayout({ order: ['daily'], hidden: ['daily'] }));
        await independent.page.waitForFunction(() => !document.querySelector('.daily-page-images'));
        await independent.page.evaluate(() => RelatumStartWorkspace.applyLayout({ order: ['daily'], hidden: [] }));
        await independent.page.waitForFunction(() => document.querySelector('[data-images-action="copy"]')?.disabled === false);
      }
      await cdp.send('HeapProfiler.collectGarbage'); assert(await count() <= before + 8, 'workbench listeners do not accumulate after repeated teardown');
      assert.equal((await copy(independent.page)).width, 800, 'repeated teardown still restores image'); await cdp.detach();
    } finally { await independent.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Real clipboard and disposable vault. Optional existing EXE host: --native.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const native = process.argv.includes('--native');
const release = process.env.RELATUM_IMAGE_COPY_RELEASE;
const python = process.env.RELATUM_PYTHON || 'python';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

function probe() {
  const bitmap = window.createImageBitmap.bind(window), element = document.createElement.bind(document);
  const fetchImage = window.fetch.bind(window), write = navigator.clipboard.write.bind(navigator.clipboard);
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  const p = window.imageCopyProbe = { active: false, writes: [], bitmaps: [], canvases: [], encodes: 0, fetches: 0, hold: false };
  window.createImageBitmap = async (...args) => {
    if (p.active && p.oversized) return { width: 20000, height: 1, close() { p.closedOversized = true; } };
    const image = await bitmap(...args); if (p.active) p.bitmaps.push(image); return image;
  };
  document.createElement = (...args) => {
    const result = element(...args); if (p.active && args[0] === 'canvas') p.canvases.push(result); return result;
  };
  HTMLCanvasElement.prototype.toBlob = function (...args) {
    if (p.active) {
      p.encodes++;
      if (p.holdEncode) {
        const callback = args[0]; args[0] = blob => { p.release = () => { p.release = null; callback(blob); }; };
      }
    }
    return toBlob.apply(this, args);
  };
  window.fetch = (url, options) => {
    if (p.active && String(url).startsWith('/api/note-asset?')) {
      p.fetches++;
      if (p.hold) return new Promise((resolve, reject) => {
        p.release = () => { p.release = null; fetchImage(url, options).then(resolve, reject); };
      });
      if (p.failFetch) return Promise.resolve(new Response('{}', { status: 404 }));
    }
    return fetchImage(url, options);
  };
  navigator.clipboard.write = items => {
    const record = { types: items[0].types, done: false }; p.writes.push(record);
    if (p.denyWrite) { record.done = true; return Promise.reject(new DOMException('Denied', 'NotAllowedError')); }
    const result = write(items);
    return result.then(value => { record.done = true; return value; }, error => { record.done = true; throw error; });
  };
  window.inspectCopyPixels = async blob => {
    const image = await bitmap(blob), canvas = element('canvas');
    try {
      canvas.width = image.width; canvas.height = image.height;
      const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, pixels: [...drawing.getImageData(0, 0, image.width, image.height).data] };
    } finally { image.close(); canvas.width = canvas.height = 0; }
  };
}

(async () => {
  assert(!native || release, 'Set RELATUM_IMAGE_COPY_RELEASE to the existing desktop release for --native');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-image-copy-'));
  const notes = path.join(root, 'notes'), assets = path.join(notes, '图片 笔记.assets', 'images');
  fs.mkdirSync(assets, { recursive: true });
  // Pillow is already part of the desktop/test host; no application dependency is added.
  execFileSync(python, ['-c', [
    'from PIL import Image', 'import pathlib, sys', 'p = pathlib.Path(sys.argv[1])',
    "image = Image.new('RGBA', (12, 8), (220, 30, 50, 255))",
    'image.putpixel((0, 0), (0, 0, 0, 0))', 'image.putpixel((1, 0), (0, 255, 0, 128))',
    "image.save(p / '透明 原图.png')", "image.convert('RGB').save(p / '照片.jpg', quality=90)",
    "image.save(p / 'WebP 图片.webp', lossless=True)", "image.convert('RGB').save(p / '位图.bmp')",
    "first = Image.new('RGB', (12, 8), 'red')", "last = Image.new('RGB', (12, 8), 'blue')",
    "first.save(p / '动画.gif', save_all=True, append_images=[last], duration=100, loop=0)",
  ].join('\n'), assets]);
  const files = ['透明 原图.png', '照片.jpg', 'WebP 图片.webp', '位图.bmp', '动画.gif'];
  const targets = files.map(name => '图片 笔记.assets/images/' + name);
  const lines = targets.map((target, i) => i === 2 ? `![[${target}|72]]` : `![image|72](${i === 1 ? encodeURI(target) : target})`);
  lines[1] = '行内 ' + lines[1] + ' 图片';
  let markdown = '# 图片复制\n\n普通文字 copy me\n\n' + lines.join('\n\n') + '\n\n末尾文字';
  fs.writeFileSync(path.join(notes, '图片 笔记.md'), markdown);
  fs.writeFileSync(path.join(notes, 'Other.md'), 'Other note');
  const originalAssets = files.map(name => fs.readFileSync(path.join(assets, name)));
  const port = await freePort(), debugPort = native ? await freePort() : 0;
  const server = spawn(native ? path.join(release, 'Relatum.exe') : python,
    native ? [] : ['-B', 'app.py', '--no-browser', '--port', String(port)], {
      cwd: native ? release : repo, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, RELATUM_DATA_ROOT: root,
        ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } : {}) },
    });
  let browser, context, page;
  const checks = [], errors = [], performance = [];
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(native ? `http://127.0.0.1:${debugPort}/json/version` : `http://127.0.0.1:${port}/api/runtime`)).ok; } catch {}
      if (ready) break; assert.equal(server.exitCode, null, 'isolated host stays running'); await pause(100);
    }
    assert(ready, 'isolated host starts');
    let url = `http://127.0.0.1:${port}`;
    if (native) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); context = browser.contexts()[0];
      for (let i = 0; i < 100; i++) {
        page = context.pages().find(item => item.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100);
      }
      assert(page, 'native page exists'); url = new URL(page.url()).origin;
    } else {
      browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
      context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
      page = await context.newPage();
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    // Load the current source even in an existing packaged WebView2 host.
    for (const name of ['note-workspace.js', 'note-live-editor.js', 'note-media-frame.js', 'markdown.js', 'styles.css']) {
      let source = fs.readFileSync(path.join(repo, 'assets', name), 'utf8');
      if (name === 'note-workspace.js') source = source.replace('  window.CanvasNoteWorkspace = {',
        '  window.copyTest = {state, openNote, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
      await page.route(`**/${name}*`, route => route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: source }));
    }
    await page.goto(url + (native ? '/?desktop=1' : '/'));
    if (!await page.evaluate(() => window.copyTest?.state.active)) await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.copyTest?.state.initialized && copyTest.state.active && !copyTest.state.openingPath);
    await page.evaluate(() => copyTest.openNote('图片 笔记.md'));
    await page.waitForFunction(() => copyTest.editor && document.querySelectorAll('.note-live-image-frame img').length === 5);
    await page.evaluate(probe);
    markdown = await page.evaluate(async () => {
      const editor = copyTest.editor, value = editor.snapshot().value;
      const line = value.split('\n').find(line => line.startsWith('![image'));
      const annotated = MarkdownMini.serializeImageBlock(MarkdownMini.parseImageBlock(line), [
        { id: 'overlay', text: '不要复制这段文字', x: .5, y: .5, size: 'lg', color: 'black' },
      ]);
      const result = value.replace(line, annotated);
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: result }, userEvent: 'input.test' });
      await copyTest.flushSave(); return result;
    });
    const menu = page.locator('[data-role="note-context-menu"]');
    const frame = index => page.locator('.cm-content .note-live-image-frame').nth(index);
    await page.locator('.note-image-text-box[data-image-text-id="overlay"]').waitFor({ state: 'visible' });
    async function openImage(index, keyboard = false) {
      await frame(index).scrollIntoViewIfNeeded();
      if (keyboard) { await frame(index).click(); await page.keyboard.press('Shift+F10'); }
      else await frame(index).click({ button: 'right' });
      await menu.waitFor({ state: 'visible' });
    }
    async function resetProbe(options = {}) {
      await page.evaluate(options => Object.assign(imageCopyProbe, { active: true, writes: [], bitmaps: [], canvases: [], encodes: 0,
        fetches: 0, hold: false, holdEncode: false, failFetch: false, denyWrite: false, oversized: false, closedOversized: false }, options), options);
    }
    async function readPixels(index) {
      return page.evaluate(async ({ index, targets }) => {
        const p = imageCopyProbe; p.active = false;
        const items = await navigator.clipboard.read();
        const item = items.find(item => item.types.includes('image/png')); if (!item) return { types: items.flatMap(item => item.types) };
        const actual = await inspectCopyPixels(await item.getType('image/png'));
        const response = await fetch('/api/note-asset?' + new URLSearchParams({ note: '图片 笔记.md', src: targets[index], syntax: index === 2 ? 'wiki' : 'markdown' }));
        return { types: item.types, actual, expected: await inspectCopyPixels(await response.blob()) };
      }, { index, targets });
    }
    async function copy(index, keyboard = false) {
      await openImage(index, keyboard); await resetProbe();
      await menu.locator('[data-note-command="copy"]').click(); await menu.waitFor({ state: 'hidden' });
      const metrics = await page.evaluate(() => ({ fetches: imageCopyProbe.fetches, encodes: imageCopyProbe.encodes,
        decoded: imageCopyProbe.bitmaps.length, bitmapsReleased: imageCopyProbe.bitmaps.every(image => image.width === 0),
        canvasesReleased: imageCopyProbe.canvases.every(canvas => !canvas.width && !canvas.height), types: imageCopyProbe.writes.map(item => item.types) }));
      assert.equal(metrics.fetches, 1); assert.equal(metrics.encodes, index ? 1 : 0); assert.equal(metrics.decoded, index ? 1 : 0);
      assert(metrics.bitmapsReleased && metrics.canvasesReleased); assert.deepEqual(metrics.types, [['image/png']]);
      const pixels = await readPixels(index);
      assert.deepEqual(pixels.types, ['image/png']); assert.deepEqual(pixels.actual, pixels.expected, files[index] + ': original pixels and dimensions');
      assert.equal(await page.evaluate(() => copyTest.editor.snapshot().value), markdown);
      performance.push({ file: files[index], ...metrics });
    }
    for (let i = 0; i < files.length; i++) await copy(i, i === 2);
    checks.push('original RGBA/dimensions, PNG/JPEG/WebP/BMP/GIF first frame, inline/wiki/Chinese paths, keyboard menu, overlay excluded');
    await page.screenshot({ path: path.join(root, 'image-copy.png') });

    for (const failure of ['failFetch', 'denyWrite', 'oversized']) {
      await openImage(failure === 'oversized' ? 1 : 0); await resetProbe({ [failure]: true });
      await page.evaluate(() => navigator.clipboard.writeText('preserve clipboard'));
      await menu.locator('[data-note-command="copy"]').click();
      await page.waitForFunction(() => document.querySelector('[data-role="note-context-menu"]').getAttribute('aria-busy') !== 'true');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'preserve clipboard');
      assert.equal(await page.evaluate(() => copyTest.editor.snapshot().value), markdown);
      const message = await page.locator('[data-role="note-toast"]').textContent();
      assert(message.includes(failure === 'oversized' ? '图片尺寸过大' : '复制图片失败'), message);
      if (failure === 'oversized') assert(await page.evaluate(() => imageCopyProbe.closedOversized));
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    }
    checks.push('missing image, denied clipboard, oversized conversion, unchanged clipboard/document and released decoder');

    for (const cancel of ['escape', 'note', 'source', 'minimize', 'workspace', 'conversion']) {
      await page.evaluate(async () => { imageCopyProbe.active = false; await copyTest.openNote('图片 笔记.md'); await copyTest.setViewMode('live'); });
      await openImage(cancel === 'conversion' ? 1 : 0);
      await resetProbe({ hold: cancel !== 'conversion', holdEncode: cancel === 'conversion' });
      await page.evaluate(() => navigator.clipboard.writeText('cancelled ' + copyTest.state.current.path));
      // Two synchronous clicks exercise the busy guard before the request settles.
      await menu.locator('[data-note-command="copy"]').evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !!imageCopyProbe.release);
      assert.equal(await page.evaluate(() => imageCopyProbe.writes.length), 1);
      if (cancel === 'escape' || cancel === 'conversion') await page.keyboard.press('Escape');
      else if (cancel === 'note') await page.evaluate(() => copyTest.openNote('Other.md'));
      else if (cancel === 'source') await page.evaluate(() => copyTest.setViewMode('source'));
      else if (cancel === 'minimize') await page.evaluate(() => {
        document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
      });
      else await page.locator('button[data-start-workspace="canvas"]').click();
      await page.evaluate(() => imageCopyProbe.release());
      await page.waitForFunction(() => imageCopyProbe.writes[0].done);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cancelled 图片 笔记.md');
      assert(await menu.isHidden());
      assert(await page.evaluate(() => imageCopyProbe.bitmaps.every(image => !image.width)
        && imageCopyProbe.canvases.every(canvas => !canvas.width && !canvas.height)), 'cancellation releases decoded images and canvases');
      if (cancel === 'minimize') await page.evaluate(() => {
        document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility'));
      });
      if (cancel === 'workspace') await page.locator('button[data-start-workspace="notes"]').click();
    }
    checks.push('one pending write, cancelled by Escape/note/mode/minimization/workspace or during PNG encoding; no late writes or retained resources');

    await page.evaluate(async () => { imageCopyProbe.active = false; await copyTest.openNote('图片 笔记.md'); await copyTest.setViewMode('live'); });
    await frame(0).click(); await page.keyboard.press('Control+c');
    const selectedSource = await page.evaluate(() => {
      const { doc, selection } = copyTest.editor.view.state; return doc.sliceString(selection.main.from, selection.main.to);
    });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selectedSource, 'Ctrl+C keeps the Markdown behavior');
    await page.evaluate(() => copyTest.setViewMode('source'));
    await page.keyboard.press('Shift+F10'); await menu.waitFor({ state: 'visible' });
    await menu.locator('[data-note-command="copy"]').click(); await menu.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selectedSource, 'source menu still copies source');
    await page.evaluate(() => copyTest.setViewMode('reading'));
    await page.locator('[data-role="note-reading-view"] .md-local-image').first().click({ button: 'right' });
    await menu.waitFor({ state: 'visible' }); assert.equal(await menu.locator('[data-note-command="copy"]').count(), 0);
    await page.keyboard.press('Escape'); await page.evaluate(() => copyTest.setViewMode('live'));
    checks.push('Ctrl+C/source copying and reading menu unchanged');

    await copy(0);
    await page.evaluate(() => { imageCopyProbe.active = false; return copyTest.openNote('Other.md'); });
    await page.locator('.cm-content').press('Control+End'); await page.keyboard.press('Shift+F10');
    await menu.waitFor({ state: 'visible' }); await menu.locator('[data-note-command="paste"]').click();
    await menu.waitFor({ state: 'hidden' }); await page.evaluate(() => copyTest.flushSave());
    assert(fs.readFileSync(path.join(notes, 'Other.md'), 'utf8').includes('Other.assets/images/'));
    checks.push('real image clipboard reimports through the existing note paste API');
    assert.equal(fs.readFileSync(path.join(notes, '图片 笔记.md'), 'utf8'), markdown);
    files.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(assets, name)), originalAssets[i]));

    let windowsClipboard, wordClipboard;
    if (native) {
      await page.evaluate(() => copyTest.openNote('图片 笔记.md')); await copy(0);
      windowsClipboard = JSON.parse(execFileSync(python, ['-c', [
        'import ctypes, struct, json, time', 'u = ctypes.windll.user32', 'k = ctypes.windll.kernel32',
        'u.GetClipboardData.restype = ctypes.c_void_p', 'k.GlobalLock.argtypes = [ctypes.c_void_p]',
        'k.GlobalLock.restype = ctypes.c_void_p', 'k.GlobalUnlock.argtypes = [ctypes.c_void_p]',
        'for _ in range(20):', ' if u.OpenClipboard(None): break', ' time.sleep(.05)',
        'else: raise RuntimeError("Clipboard locked")', 'try:',
        ' fmt = next((f for f in (17, 8) if u.IsClipboardFormatAvailable(f)), None)',
        ' assert fmt, "Windows bitmap clipboard format is available to desktop apps"',
        ' handle = u.GetClipboardData(fmt)', ' ptr = k.GlobalLock(handle)', ' assert ptr',
        ' try:', '  header, width, height, planes, bits = struct.unpack("<IiiHH", ctypes.string_at(ptr, 16))',
        '  print(json.dumps(dict(format=fmt, width=width, height=abs(height), bits=bits)))',
        ' finally: k.GlobalUnlock(handle)', 'finally: u.CloseClipboard()',
      ].join('\n')], { encoding: 'utf8' }));
      assert.equal(windowsClipboard.width, 12); assert.equal(windowsClipboard.height, 8);
      checks.push('real WebView2 and Windows native DIB clipboard format/dimensions');
      if (process.argv.includes('--word')) {
        wordClipboard = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$word = $null; $document = $null; $ownsWord = $false; $discard = 0
try {
  $word = New-Object -ComObject Word.Application
  if ($word.Documents.Count -ne 0) { throw 'Refusing to use a Word instance with existing documents' }
  $ownsWord = $true; $word.Visible = $false; $word.DisplayAlerts = 0
  $document = $word.Documents.Add()
  [void]$document.Content.Paste()
  if ($document.InlineShapes.Count -ne 1) { throw 'Clipboard did not paste as one real image in Word' }
  $shape = $document.InlineShapes.Item(1)
  @{ count = $document.InlineShapes.Count; widthPoints = $shape.Width; heightPoints = $shape.Height } | ConvertTo-Json -Compress
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shape)
} finally {
  try {
    if ($document) { [void]$document.Close([ref]$discard); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  } finally {
    if ($word) {
      if ($ownsWord) { [void]$word.Quit([ref]$discard) }
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    }
  }
}`], { encoding: 'utf8', windowsHide: true, timeout: 45000 }));
        assert.equal(wordClipboard.count, 1); assert(wordClipboard.widthPoints > 0 && wordClipboard.heightPoints > 0);
        checks.push('real Microsoft Word pastes one image into an unsaved isolated document');
      }
    }
    assert.deepEqual(errors, []);
    const report = { native, root, browserVersion: browser.version(), checks, performance, windowsClipboard, wordClipboard, errors };
    fs.writeFileSync(path.join(root, 'image-copy-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (native) {
      await page?.evaluate(() => pywebview.api.close_window()).catch(() => {});
      if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
    }
    await browser?.close();
    if (server.exitCode === null) server.kill();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

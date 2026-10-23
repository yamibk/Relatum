'use strict';

// Real image intake against a disposable vault. A Node-side watchdog also
// catches renderer hangs, for which a timer inside the page cannot run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const launcher = process.argv.includes('--launcher');
const native = launcher || process.argv.includes('--native');
const release = process.env.RELATUM_IMAGE_UPLOAD_RELEASE;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-image-upload-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let timeoutDiagnostic = null;
fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', 'Images.md'), '# 图片导入\n\n正文\n\n');
fs.writeFileSync(path.join(root, 'notes', 'Other.md'), '# Other\n\nKeep this text.');
fs.writeFileSync(path.join(root, 'notes', '图 (A.md'), '# Special paths\n\n');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function activateNativeWindow(pid) {
  // Only activate top-level windows owned by this test's disposable processes.
  // Page.bringToFront() alone does not activate the native WebView2 host.
  const result = execFileSync(process.env.RELATUM_PYTHON || 'python', ['-c', [
    'import ctypes as c, ctypes.wintypes as w, sys, json',
    'u = c.windll.user32; k = c.windll.kernel32; pid = int(sys.argv[1]); found = []',
    'u.GetForegroundWindow.restype = w.HWND',
    'u.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]',
    'u.SetForegroundWindow.argtypes = [w.HWND]; u.BringWindowToTop.argtypes = [w.HWND]',
    'u.ShowWindow.argtypes = [w.HWND, c.c_int]; u.IsIconic.argtypes = [w.HWND]',
    '@c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)',
    'def visit(hwnd, param):',
    ' p = w.DWORD(); u.GetWindowThreadProcessId(hwnd, c.byref(p))',
    ' if p.value == pid and u.IsWindowVisible(hwnd): found.append(hwnd)',
    ' return True',
    'u.EnumWindows(visit, 0)',
    'assert found, "Disposable native window must be visible"',
    'hwnd = found[0]; foreground = u.GetForegroundWindow()',
    'own = k.GetCurrentThreadId(); other = u.GetWindowThreadProcessId(foreground, None)',
    'attached = own != other and bool(u.AttachThreadInput(own, other, True))',
    'try:',
    ' if u.IsIconic(hwnd): u.ShowWindow(hwnd, 9)',
    ' u.BringWindowToTop(hwnd); u.SetForegroundWindow(hwnd)',
    ' p = w.DWORD(); u.GetWindowThreadProcessId(u.GetForegroundWindow(), c.byref(p))',
    ' print(json.dumps(dict(activated=p.value == pid)))',
    'finally:',
    ' if attached: u.AttachThreadInput(own, other, False)',
  ].join('\n'), String(pid)], { encoding: 'utf8', windowsHide: true });
  assert(JSON.parse(result).activated, 'the disposable app becomes the actual foreground window');
}

async function bounded(task, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation did not finish: ' + label)), timeout);
    })]);
  } catch (error) {
    if (timeoutDiagnostic && error.message.startsWith('Operation did not finish:')) {
      await Promise.race([timeoutDiagnostic().catch(() => {}), pause(3000)]);
    }
    throw error;
  } finally { clearTimeout(timer); }
}

(async () => {
  assert(!native || release && fs.existsSync(path.join(release, 'Relatum.exe')), 'native testing requires RELATUM_IMAGE_UPLOAD_RELEASE');
  if (launcher) {
    const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'feature-catalog.json'), 'utf8'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'launcher-profile.json'), JSON.stringify({ version: 1,
      features: Object.fromEntries(catalog.features.map(item => [item.id, /^(?:canvas|notes)(?:\.|$)/.test(item.id) || item.id === 'runtime.preload'])) }));
    fs.writeFileSync(path.join(root, 'data', 'launcher-settings.json'), JSON.stringify({ version: 1, skipSelection: true }));
  }
  const port = await freePort(), debugPort = native ? await freePort() : 0;
  let url = `http://127.0.0.1:${port}`;
  const server = spawn(native ? path.join(release, launcher ? 'RelatumLauncher.exe' : 'Relatum.exe') : process.env.RELATUM_PYTHON || 'python',
    native ? [] : ['-B', 'app.py', '--no-browser', '--port', String(port)], {
    cwd: native ? release : repo, env: { ...process.env, RELATUM_DATA_ROOT: root,
      ...(native ? { LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` } : {}) }, windowsHide: !native, stdio: 'ignore',
  });
  let browser, page, clipboardBrowser, clipboardPage, clipboardProcess;
  const errors = [], results = [], failures = [];
  const check = (label, actual, expected) => {
    results.push({ label, actual, expected });
    try { assert.deepEqual(actual, expected, label); }
    catch (error) { failures.push(error.message); console.log('regression reproduced: ' + label); }
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { ready = (await fetch(native ? `http://127.0.0.1:${debugPort}/json/version` : url + '/api/runtime')).ok; } catch (_) {}
      if (ready) break;
      assert.equal(server.exitCode, null, 'isolated server stays running');
      await pause(100);
    }
    assert(ready, 'isolated server starts');
    if (native) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { noDefaults: true });
      for (let i = 0; i < 100; i++) {
        page = browser.contexts()[0].pages().find(candidate => candidate.url().startsWith('http://127.0.0.1:'));
        if (page) break;
        await pause(100);
      }
      assert(page, 'native page opens');
      url = new URL(page.url()).origin;
    } else {
      browser = await chromium.launch({ headless: true,
        ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 },
        deviceScaleFactor: process.argv.includes('--dpr2') ? 2 : 1,
        reducedMotion: process.argv.includes('--reduced-motion') ? 'reduce' : 'no-preference' });
      page = await context.newPage();
    }
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const debug = await page.context().newCDPSession(page);
    timeoutDiagnostic = async () => {
      timeoutDiagnostic = null;
      await debug.send('Debugger.enable');
      const paused = new Promise(resolve => debug.once('Debugger.paused', resolve));
      await debug.send('Debugger.pause');
      const event = await Promise.race([paused, pause(2000)]);
      if (event) {
        const frames = [];
        for (const frame of event.callFrames.slice(0, 5)) {
          const scope = frame.scopeChain.find(scope => scope.type === 'local');
          const properties = scope ? (await debug.send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true })).result : [];
          frames.push({ name: frame.functionName, location: frame.location,
            locals: properties.map(item => ({ name: item.name, value: item.value?.value, description: item.value?.description })) });
        }
        console.log('renderer timeout stack: ' + JSON.stringify(frames));
        await debug.send('Debugger.resume');
      }
    };
    const baseline = process.env.RELATUM_IMAGE_UPLOAD_BASELINE;
    for (const name of ['note-workspace.js', 'note-live-editor.js', 'note-media-frame.js', 'markdown.js', 'styles.css']) {
      let source = baseline ? execFileSync('git', ['show', `${baseline}:assets/${name}`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
        : fs.readFileSync(path.join(repo, 'assets', name), 'utf8');
      if (name === 'note-workspace.js') source = source.replace('  window.CanvasNoteWorkspace = {',
        '  window.uploadTest = {state, openNote, flushSave, setViewMode, uploadImages, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {')
        .replace('onImageSelectionChange: (selection) => updateImageTextTools(selection),',
          'onImageSelectionChange: (selection) => { if (window.uploadProbe) uploadProbe.notifications++; updateImageTextTools(selection); },');
      await page.route(`**/${name}*`, route => route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: source }));
    }
    await page.goto(url + (native ? '/?desktop=1' : '/'));
    if (!await page.evaluate(() => window.uploadTest?.state.active)) await page.locator('button[data-start-workspace="notes"]').click();
    await page.waitForFunction(() => window.uploadTest?.state.initialized && uploadTest.state.active);
    await page.evaluate(() => uploadTest.openNote('Images.md'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
      canvas.getContext('2d').fillRect(0, 0, 400, 200);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      window.imageUploadBytes = new Uint8Array(await blob.arrayBuffer());
      canvas.width = canvas.height = 0;
      window.imageUploadFiles = count => Array.from({ length: count }, (_, i) => new File([imageUploadBytes], `图片-${i}.png`, { type: 'image/png' }));
      window.uploadProbe = { changes: 0, reads: 0, uploads: 0, notifications: 0 };
      const reader = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (...args) { uploadProbe.reads++; return reader.apply(this, args); };
      const fetcher = window.fetch;
      window.fetch = function (url, options) { if (String(url).startsWith('/api/note-upload-image')) uploadProbe.uploads++; return fetcher.call(this, url, options); };
    });
    // Install a real CodeMirror extension using its public configuration effect.
    await page.evaluate(() => uploadTest.editor.view.dispatch({ effects: RelatumCodeMirror.StateEffect.appendConfig.of(
      RelatumCodeMirror.EditorView.updateListener.of(update => { if (update.docChanged) uploadProbe.changes++; })) }));
    const reset = async value => {
      await bounded(() => page.evaluate(value => {
        const editor = uploadTest.editor;
        editor.setImageTextMode(false);
        editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: value },
          selection: { anchor: value.length }, userEvent: 'input.test' });
        uploadProbe.changes = uploadProbe.reads = uploadProbe.uploads = uploadProbe.notifications = 0;
      }, value), 'reset document');
    };
    for (const [label, value] of [['empty', ''], ['end', '# 图片\n\n正文\n\n'], ['inline', '插入位置'],
      ['table', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n'], ['code', '```js\nconst x = 1;\n```\n\n']]) {
      await reset(value);
      await bounded(() => page.evaluate(() => uploadTest.uploadImages(imageUploadFiles(1))), label + ' image upload');
      const result = await bounded(() => page.evaluate(() => ({ value: uploadTest.editor.snapshot().value,
        error: uploadTest.editor.view.dom.parentElement.dataset.livePreviewError || '' })), label + ' heartbeat');
      assert(result.value.includes('.assets/images/'), label + ' image is inserted');
      assert.equal(result.error, '');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.note-live-image-frame img')).some(image => image.naturalWidth > 0));
      results.push({ label, passed: true });
      console.log(label + ': ok');
    }
    for (let i = 0; i < 4; i++) {
      await reset(i % 2 ? '# Clipboard\n\n' : '');
      await page.evaluate(async () => {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([imageUploadBytes], { type: 'image/png' }) })]);
        uploadTest.editor.focus();
      });
      await bounded(() => page.keyboard.press('Control+V'), 'native clipboard paste');
      await bounded(() => page.waitForFunction(() => uploadTest.editor.snapshot().value.includes('.assets/images/')), 'native clipboard completes');
      console.log('native clipboard ' + (i + 1) + ': ok');
    }
    // A separate clipboard source changes focus before returning to the note.
    // In desktop mode it is an independent Edge window with no user profile.
    if (native) {
      const clipboardPort = await freePort();
      clipboardProcess = spawn(process.env.RELATUM_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        [`--remote-debugging-port=${clipboardPort}`, `--user-data-dir=${path.join(root, 'clipboard-browser')}`,
          '--no-first-run', '--no-default-browser-check', '--window-size=800,600', 'about:blank'], { windowsHide: false, stdio: 'ignore' });
      for (let attempt = 0; ; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${clipboardPort}/json/version`)).ok) break; } catch (_) {}
        assert(attempt < 150 && clipboardProcess.exitCode === null, 'isolated clipboard source opens'); await pause(100);
      }
      clipboardBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${clipboardPort}`, { noDefaults: true });
    }
    clipboardPage = clipboardBrowser ? clipboardBrowser.contexts()[0].pages()[0] : await page.context().newPage();
    clipboardPage.setDefaultTimeout(10000);
    await clipboardPage.goto(url + '/api/runtime');
    await clipboardPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    // Native CDP connections use noDefaults: true. Playwright otherwise keeps
    // every page logically focused, masking real cross-window blur/focus.
    await page.evaluate(() => {
      window.imageFocusProbe = { blur: 0, focus: 0 };
      window.addEventListener('blur', () => imageFocusProbe.blur++);
      window.addEventListener('focus', () => imageFocusProbe.focus++);
    });
    for (const stage of ['window', 'maximized', 'restored']) {
      if (stage !== 'window') {
        if (native) {
          await page.waitForFunction(() => typeof window.pywebview?.api?.toggle_maximize === 'function');
          const result = await page.evaluate(() => pywebview.api.toggle_maximize());
          assert.equal(result.maximized, stage === 'maximized', 'native maximize/restore state');
        } else await page.setViewportSize(stage === 'maximized' ? { width: 1920, height: 1080 } : { width: 1280, height: 800 });
      }
      // Resetting after each paste misses overlapping atomic image boundaries.
      await reset('');
      const bytes = await page.evaluate(async stage => {
        if (stage === 'window') return [...imageUploadBytes];
        const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1800;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = '#dcd9ce'; drawing.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        canvas.width = canvas.height = 0;
        return [...new Uint8Array(await blob.arrayBuffer())];
      }, stage);
      for (let i = 0; i < 3; i++) {
        await clipboardPage.bringToFront();
        if (native) {
          activateNativeWindow(clipboardProcess.pid);
          await clipboardPage.mouse.click(40, 80);
          await page.waitForFunction(() => !document.hasFocus());
          await clipboardPage.waitForFunction(() => document.hasFocus());
        }
        await clipboardPage.evaluate(async bytes => {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]);
        }, bytes);
        await page.bringToFront();
        if (native) {
          activateNativeWindow(server.pid);
          await page.waitForFunction(() => document.hasFocus());
        }
        await page.evaluate(() => {
          const view = uploadTest.editor.view;
          view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus();
        });
        await bounded(() => page.keyboard.press('Control+V'), stage + ' consecutive clipboard paste');
        await bounded(() => page.waitForFunction(count => (uploadTest.editor.snapshot().value.match(/!\[/g) || []).length === count, i + 1), 'consecutive paste completes');
      }
      await page.waitForFunction(() => document.querySelectorAll('.note-live-image-frame img').length === 3
        && [...document.querySelectorAll('.note-live-image-frame img')].every(image => image.naturalWidth > 0));
      const original = await page.evaluate(() => uploadTest.editor.snapshot().value);
      for (let round = 0; round < 3; round++) {
        for (const index of [0, 2, 1]) {
          const frame = page.locator('.note-live-image-frame').nth(index);
          await bounded(() => frame.click({ position: { x: 20, y: 20 } }), 'select adjacent image');
          const point = await bounded(() => frame.evaluate(frame => {
            const image = frame.getBoundingClientRect(), content = frame.closest('.cm-content').getBoundingClientRect();
            return { x: Math.min(content.right - 5, image.right + 20), y: Math.min(innerHeight - 80, image.top + image.height / 2) };
          }), 'image side coordinates');
          await bounded(() => page.mouse.click(point.x, point.y), 'click blank space beside adjacent image');
          await bounded(() => page.evaluate(() => uploadTest.editor.snapshot().value.length), 'heartbeat after adjacent image clicks');
        }
      }
      await page.locator('.note-live-image-frame').nth(1).click({ position: { x: 20, y: 20 } });
      await page.keyboard.press('Delete');
      assert.equal(await page.locator('.note-live-image-frame').count(), 2, 'each image remains individually deletable');
      await page.keyboard.press('Control+Z');
      assert.equal(await page.evaluate(() => uploadTest.editor.snapshot().value), original, 'undo restores the exact image Markdown');
      await page.locator('.note-live-image-frame').last().click({ position: { x: 20, y: 20 } });
      await page.keyboard.press('ArrowRight'); await page.keyboard.type('Body after pictures');
      assert.equal(await page.evaluate(() => uploadTest.editor.snapshot().value), original + 'Body after pictures', 'body input after image navigation remains usable');
      await page.keyboard.press('Control+Z');
      await page.evaluate(() => uploadTest.flushSave());
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'Images.md'), 'utf8'), original, 'clicking images preserves saved content');
      results.push({ label: stage + ' consecutive pastes and 18 image/blank clicks', ...await page.evaluate(() => ({
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, focus: imageFocusProbe,
      })) });
      if (native) assert((await page.evaluate(() => imageFocusProbe.focus)) >= 3, 'real focus events are observed');
      console.log(stage + ' consecutive clipboard, focus and image clicks: ok');
    }
    await clipboardPage.close(); clipboardPage = null;
    if (clipboardBrowser) { await clipboardBrowser.close(); clipboardBrowser = null; }
    for (const type of ['paste', 'drop']) {
      await reset('# Event\n\n');
      await bounded(() => page.evaluate(type => {
        const data = new DataTransfer();
        imageUploadFiles(3).forEach(file => data.items.add(file));
        uploadTest.editor.view.contentDOM.dispatchEvent(type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, clientX: 500, clientY: 300, bubbles: true, cancelable: true }));
      }, type), type + ' event');
      await bounded(() => page.waitForFunction(() => (uploadTest.editor.snapshot().value.match(/!\[/g) || []).length === 3), type + ' completes');
      await page.evaluate(() => uploadTest.flushSave());
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'Images.md'), 'utf8'), await page.evaluate(() => uploadTest.editor.snapshot().value));
      console.log(type + ': ok');
    }
    await reset('# Batch\n\n');
    const start = performance.now();
    await bounded(() => page.evaluate(() => uploadTest.uploadImages(imageUploadFiles(40))), '40 image batch', 30000);
    const batch = await page.evaluate(() => ({ ...uploadProbe, count: (uploadTest.editor.snapshot().value.match(/!\[/g) || []).length }));
    assert.equal(batch.count, 40);
    check('one document update per batch', batch.changes, 1);
    results.push({ label: 'batch', ...batch, elapsed: performance.now() - start });

    await reset('Size limit\n');
    await bounded(() => page.evaluate(() => {
      const file = imageUploadFiles(1)[0];
      Object.defineProperty(file, 'size', { value: 40 * 1024 * 1024 + 1 });
      return uploadTest.uploadImages([file]);
    }), 'reject oversized file before reading');
    check('oversized files have no reads or uploads', await page.evaluate(() => [uploadProbe.reads, uploadProbe.uploads, uploadTest.editor.snapshot().value]), [0, 0, 'Size limit\n']);

    // Hold only the network response, after the real isolated API has written
    // the asset. Changes in the waiting window are deterministic.
    const heldUpload = async action => {
      let release, entered;
      const held = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { entered = resolve; });
      const handler = async route => {
        const response = await route.fetch(); entered();
        await held; await route.fulfill({ response });
      };
      await page.route('**/api/note-upload-image', handler);
      try {
        await page.evaluate(() => { window.waitingImageUpload = uploadTest.uploadImages(imageUploadFiles(1)); });
        await bounded(() => requested, 'upload reaches local API');
        await action();
      } finally { release(); }
      await bounded(() => page.evaluate(() => waitingImageUpload), 'held upload finishes');
      await page.unroute('**/api/note-upload-image', handler);
    };
    await reset('Caret movement\n');
    const notifications = await page.evaluate(() => {
      uploadProbe.notifications = 0;
      for (let i = 0; i < 100; i++) uploadTest.editor.view.dispatch({ selection: { anchor: i % 8 } });
      return uploadProbe.notifications;
    });
    check('unchanged image state does not rebuild the toolbar', notifications, 0);
    await reset('Original\nKeep this text.');
    await page.evaluate(() => uploadTest.editor.view.dispatch({ selection: { anchor: 9 } }));
    await heldUpload(async () => {
      await page.evaluate(() => uploadTest.editor.view.dispatch({ selection: { anchor: 9, head: uploadTest.editor.view.state.doc.length } }));
    });
    const anchored = await page.evaluate(() => uploadTest.editor.snapshot().value);
    check('moving the selection during upload preserves text', anchored.endsWith('Keep this text.'), true);
    check('upload stays at its original insertion point', anchored.startsWith('Original\n!['), true);

    await reset('Before\nAfter');
    await page.evaluate(() => uploadTest.editor.view.dispatch({ selection: { anchor: 7 } }));
    await heldUpload(async () => {
      await page.evaluate(() => uploadTest.editor.view.dispatch({ changes: { from: 0, insert: 'New\n' }, selection: { anchor: 0 } }));
    });
    check('insertion maps across intervening edits', (await page.evaluate(() => uploadTest.editor.snapshot().value)).startsWith('New\nBefore\n!['), true);

    await reset('Selected text');
    await page.evaluate(() => uploadTest.editor.view.dispatch({ selection: { anchor: 0, head: 8 } }));
    await heldUpload(async () => {
      await page.evaluate(() => uploadTest.editor.view.dispatch({ changes: { from: 0, to: 8, insert: 'Edited' }, selection: { anchor: 0 } }));
    });
    check('editing the selected upload destination cancels insertion', await page.evaluate(() => uploadTest.editor.snapshot().value), 'Edited text');

    await reset('Reopened note must stay intact.');
    await page.evaluate(() => uploadTest.flushSave());
    await heldUpload(async () => {
      await page.evaluate(async () => { await uploadTest.openNote('Other.md'); await uploadTest.openNote('Images.md'); });
    });
    check('returning to the same path cannot revive an old upload', await page.evaluate(() => uploadTest.editor.snapshot().value), 'Reopened note must stay intact.');

    await reset('Minimized note\n');
    await heldUpload(async () => {
      await page.evaluate(() => {
        document.documentElement.dataset.desktopMinimized = '1';
        window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } }));
        document.documentElement.dataset.desktopMinimized = '0';
        window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } }));
      });
    });
    check('a response from before minimization stays cancelled after restore', await page.evaluate(() => uploadTest.editor.snapshot().value), 'Minimized note\n');

    await reset('Partial success\n');
    await bounded(() => page.evaluate(() => uploadTest.uploadImages([
      new File(['invalid'], 'bad.png', { type: 'image/png' }), ...imageUploadFiles(1),
    ])), 'failed file does not cancel other images');
    check('successful files survive a failed file', (await page.evaluate(() => uploadTest.editor.snapshot().value)).includes('.assets/images/'), true);

    await reset('Abort must settle\n');
    await bounded(() => page.evaluate(async () => {
      const OriginalReader = window.FileReader;
      window.FileReader = class { readAsDataURL() { queueMicrotask(() => this.onabort?.()); } };
      try { await uploadTest.uploadImages(imageUploadFiles(1)); } finally { window.FileReader = OriginalReader; }
    }), 'aborted file reader settles', 3000);
    check('aborted image read preserves the note', await page.evaluate(() => uploadTest.editor.snapshot().value), 'Abort must settle\n');
    await bounded(() => page.evaluate(() => uploadTest.uploadImages(imageUploadFiles(1))), 'uploads recover after read abort');
    check('queue recovers after read abort', (await page.evaluate(() => uploadTest.editor.snapshot().value)).includes('.assets/images/'), true);
    await reset('Request timeout\n');
    await bounded(() => page.evaluate(async () => {
      const fetcher = window.fetch, timer = window.setTimeout;
      window.setTimeout = (callback, ms, ...args) => timer(callback, ms === 45000 ? 10 : ms, ...args);
      window.fetch = (url, options) => String(url).startsWith('/api/note-upload-image')
        ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
        : fetcher.call(window, url, options);
      try { await uploadTest.uploadImages(imageUploadFiles(1)); }
      finally { window.fetch = fetcher; window.setTimeout = timer; }
    }), 'stalled image request has a finite timeout', 3000);
    await bounded(() => page.evaluate(() => uploadTest.uploadImages(imageUploadFiles(1))), 'uploads recover after request timeout');
    check('queue recovers after request timeout', (await page.evaluate(() => uploadTest.editor.snapshot().value)).includes('.assets/images/'), true);
    await page.evaluate(async () => {
      await uploadTest.openNote('图 (A.md');
      await uploadTest.uploadImages([new File([imageUploadBytes], '图 [1](demo).png', { type: 'image/png' })]);
    });
    await bounded(() => page.waitForFunction(() => Array.from(document.querySelectorAll('.note-live-image-frame img'))
      .some(image => image.alt === '图 [1](demo).png' && image.naturalWidth === 400)), 'escaped attachment path loads');
    check('image filename brackets and unbalanced note parentheses are preserved', await page.evaluate(() => {
      const line = uploadTest.editor.snapshot().value.split('\n').find(line => line.startsWith('!['));
      const parsed = MarkdownMini.parseImageBlock(line);
      return !!parsed && parsed.alt === '图 [1](demo).png' && parsed.target.includes('%28');
    }), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    console.log('note image upload browser regression: ok');
  } finally {
    console.log(JSON.stringify({ native, launcher, results, failures, errors }));
    if (clipboardBrowser) await clipboardBrowser.close();
    else if (clipboardPage) await clipboardPage.close();
    if (clipboardProcess?.exitCode === null) clipboardProcess.kill();
    if (native) {
      await bounded(() => page?.evaluate(() => pywebview.api.close_window()).catch(() => {}), 'native close', 4000).catch(() => {});
      if (server.exitCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
    }
    if (browser) await browser.close();
    if (server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

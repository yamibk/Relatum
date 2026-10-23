'use strict';
// Real saved Markdown, CodeMirror coordinates and native WebView2 lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const execute = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const native = process.argv.includes('--webview2'), repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-workspace-'));
const pie = '```mermaid\npie showData\n title 每日时间分配\n "学习" : 8\n "睡眠" : 8\n "娱乐" : 3\n "运动" : 2\n "其他" : 3\n```';
const wide = '```mermaid\nflowchart LR\n' + Array.from({ length: 18 }, (_, i) => `A${i}[步骤${i}]-->A${i + 1}[步骤${i + 1}]`).join('\n') + '\n```';
const value = '前文\n\n' + pie + '\n\n' + wide + '\n\n定位标记：图表下方的真实正文。\n\n'
  + Array.from({ length: 90 }, (_, i) => `正文段落${i}：` + '用于检查长文滚动、文字落点和模式交接。'.repeat(6)).join('\n\n') + '\n\n文末';
fs.mkdirSync(path.join(output, 'notes')); fs.writeFileSync(path.join(output, 'notes/Diagram.md'), value);
fs.writeFileSync(path.join(output, 'notes/Other.md'), '# 另一篇\n\n其他正文');
async function port() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const p = socket.address().port; await new Promise(resolve => socket.close(resolve)); return p; }

(async () => {
  const httpPort = await port(), debug = native ? await port() : 0;
  const python = native ? process.env.RELATUM_WEBVIEW_PYTHON : process.env.RELATUM_PYTHON;
  assert(python, 'Configure the existing Python host');
  const service = spawn(python, ['-B', native ? 'desktop.py' : 'app.py', ...(!native ? ['--no-browser', '--port', String(httpPort)] : [])],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELATUM_DATA_ROOT: output,
      ...(native ? { LOCALAPPDATA: output, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debug } : {}) } });
  let logs = '', browser, context, page;
  service.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
  service.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
  service.on('error', error => { logs += error.message; });
  const checks = [], errors = [];
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { ready = (await fetch(native ? `http://127.0.0.1:${debug}/json/version` : `http://127.0.0.1:${httpPort}/api/runtime`)).ok; } catch (_) {}
      if (ready) break; assert.equal(service.exitCode, null, logs); await pause(100);
    }
    assert(ready, 'isolated service starts: ' + logs);
    let origin = 'http://127.0.0.1:' + httpPort;
    if (native) {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + debug); context = browser.contexts()[0];
      for (let i = 0; i < 100; i++) { page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:')); if (page) break; await pause(100); }
      assert(page); origin = new URL(page.url()).origin;
    } else {
      browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
      context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 }); page = await context.newPage();
    }
    page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T={state,openNote,flushSave,setViewMode,setSideOpen,setSideMode,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    await page.addInitScript(() => {
      localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Diagram.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1', 'Diagram.md'); localStorage.setItem('canvas:noteGraphPreload:v1', '0');
    });
    await page.goto(origin + (native ? '/?desktop=1' : '/'));
    await page.waitForFunction(() => window.T?.state.active && T.state.current?.path === 'Diagram.md' && T.editor);
    await page.locator('.is-mermaid svg').first().waitFor();
    assert.equal(await page.locator('.cm-line.note-live-code-line').count(), 0, 'projected diagrams leave no colored fence line');
    await page.evaluate(() => {
      const v = T.editor.view, at = v.state.doc.toString().indexOf('"学习"') + 1;
      v.dispatch({ selection: { anchor: at }, scrollIntoView: true }); v.focus(); window.__editorIdentity = T.editor;
    });
    await page.locator('.note-live-mermaid-preview svg').waitFor(); await pause(350);
    assert.equal(fs.readFileSync(path.join(output, 'notes/Diagram.md'), 'utf8'), value, 'preview does not save derived content');
    const position = () => page.evaluate(() => { const v = T.editor.view; return { scroll: v.scrollDOM.scrollTop, y: v.coordsAtPos(v.state.selection.main.head).top }; });
    const before = await position();
    await page.evaluate(() => { const v = T.editor.view, at = v.state.doc.toString().indexOf('"学习" : 8') + 7;
      v.dispatch({ changes: { from: at, to: at + 1, insert: '9' }, userEvent: 'input.type' }); });
    await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('学习 [9]'));
    await pause(200); const after = await position();
    assert(Math.abs(after.scroll - before.scroll) <= 1 && Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }));
    assert(await page.evaluate(() => T.flushSave()));
    let saved = value.replace('"学习" : 8', '"学习" : 9');
    assert.equal(fs.readFileSync(path.join(output, 'notes/Diagram.md'), 'utf8'), saved);
    checks.push('source preview, exact save bytes, stable caret and scroll');

    // Chromium's native preedit text must never be rendered provisionally.
    const cdp = await context.newCDPSession(page);
    const oldSvg = await page.locator('.note-live-mermaid-preview .note-mermaid-stage').innerHTML();
    for (const text of ['h', 'han']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await pause(180); assert.equal(await page.locator('.note-live-mermaid-preview .note-mermaid-stage').innerHTML(), oldSvg);
    await cdp.send('Input.insertText', { text: '汉' });
    await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('汉学习'));
    for (const text of ['z', 'zi']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await pause(180); assert(!await page.evaluate(() => T.editor.snapshot().value.includes('zi')));
    saved = saved.replace('"学习"', '"汉学习"');
    assert(await page.evaluate(() => T.flushSave())); assert.equal(fs.readFileSync(path.join(output, 'notes/Diagram.md'), 'utf8'), saved);
    checks.push('native Chromium IME confirmation/cancellation and no provisional preview');

    for (const [width, dark, motion] of native ? [[0, false, 'no-preference'], [0, true, 'reduce']] :
      [[1500, false, 'no-preference'], [760, true, 'no-preference'], [1120, false, 'reduce'], [1121, true, 'reduce']]) {
      if (width) await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: motion });
      await page.evaluate(dark => { document.body.dataset.startTheme = dark ? 'dark' : 'light'; document.documentElement.style.setProperty('--note-font-scale', dark ? '1.25' : '1'); }, dark);
      await pause(250);
      if (width > 1120 || native) {
        const first = await position();
        await page.evaluate(() => T.setSideOpen(true)); await pause(70); await page.evaluate(() => T.setSideOpen(false)); await pause(320);
        const last = await position(); assert(Math.abs(first.y - last.y) <= 1 && Math.abs(first.scroll - last.scroll) <= 1, 'sidebar reversal preserves the source position');
      }
      await page.screenshot({ path: path.join(output, `editing-${width || 'native'}-${dark ? 'dark' : 'light'}.png`) });
    }
    await page.evaluate(() => { const v = T.editor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    const marker = page.locator('.cm-line').filter({ hasText: '定位标记：' });
    await page.evaluate(() => T.editor.revealPosition(T.editor.snapshot().value.indexOf('定位标记'), { align: 'start' }));
    await marker.waitFor(); await pause(250);
    const point = await page.evaluate(() => { const v = T.editor.view, at = v.state.doc.toString().indexOf('定位标记') + 5, box = v.coordsAtPos(at); return { x: box.left + 1, y: (box.top + box.bottom) / 2, at }; });
    await page.mouse.click(point.x, point.y);
    assert(await page.evaluate(() => T.editor.view.state.doc.lineAt(T.editor.view.state.selection.main.head).text.includes('定位标记')), 'real mouse lands in the paragraph below both diagrams');
    await page.keyboard.insertText('输入验证'); await page.keyboard.press('Control+z'); await pause(150);
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), saved);
    await page.evaluate(() => T.openNote('Other.md')); await page.evaluate(() => T.openNote('Diagram.md'));
    assert.equal(await page.evaluate(() => T.editor.snapshot().value), saved);
    assert(await page.evaluate(() => __editorIdentity === T.editor));
    checks.push('themes, DPR 2, breakpoints, sidebar reversal, real mouse mapping and tab reuse');

    await page.evaluate(() => T.setViewMode('source')); assert.equal(await page.locator('.note-live-mermaid-preview').count(), 0);
    await page.evaluate(() => T.setViewMode('reading'));
    const reading = page.locator('[data-role="note-reading-view"]');
    await reading.locator('.mermaid-diagram').nth(1).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '放大图表', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const graph = reading.locator('.mermaid-diagram').nth(1).locator('.note-mermaid-stage > svg');
    const camera = await graph.getAttribute('viewBox'), top = await reading.evaluate(el => el.scrollTop);
    await reading.evaluate(el => { el.scrollTop = 3000; }); await pause(100);
    await reading.evaluate((el, top) => { el.scrollTop = top; }, top);
    await page.getByRole('button', { name: '复位图表', exact: true }).waitFor();
    assert.equal(await graph.getAttribute('viewBox'), camera);
    if (native) {
      await page.evaluate(() => pywebview.api.minimize());
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '1');
    } else await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(page.workers().length, 0, 'minimization terminates the rendering worker');
    assert.equal(await page.locator('.note-mermaid-zoom').count(), 0);
    if (native) {
      // Restore the same native bounds, without maximizing/resizing in between.
      const command = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MermaidRestore {
        public delegate bool Visitor(IntPtr h, IntPtr p);
        [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor cb, IntPtr p);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
        public static void Restore(uint[] pids) { IntPtr target=IntPtr.Zero; EnumWindows((h,p)=>{uint owner; GetWindowThreadProcessId(h,out owner); if(Array.IndexOf(pids,owner)>=0&&IsIconic(h)){target=h;return false;}return true;},IntPtr.Zero);
          if(target==IntPtr.Zero)throw new Exception("Test window not found"); ShowWindowAsync(target,9); }
        }';
        $mermaidTestProcesses=Get-CimInstance Win32_Process;
        $mermaidTestIds=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$mermaidTestIds.Add(${service.pid});
        do { $mermaidTestAdded=$false; foreach($mermaidTestProcess in $mermaidTestProcesses) {
          if($mermaidTestIds.Contains([uint32]$mermaidTestProcess.ParentProcessId) -and $mermaidTestIds.Add([uint32]$mermaidTestProcess.ProcessId)) { $mermaidTestAdded=$true; }
        } } while($mermaidTestAdded);
        [MermaidRestore]::Restore([uint32[]]@($mermaidTestIds))`;
      await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true });
      await page.waitForFunction(() => document.documentElement.dataset.desktopMinimized === '0');
    } else await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.getByRole('button', { name: '复位图表', exact: true }).waitFor();
    assert.equal(await graph.getAttribute('viewBox'), camera, 'unchanged native bounds preserve the camera');
    checks.push('reading camera, ordinary scrolling, native minimize/restore and worker release');
    await reading.evaluate(el => { el.scrollTop = 3000; }); await pause(100);
    const anchor = await page.evaluate(() => {
      const area = document.querySelector('[data-role="note-reading-view"]'), top = area.getBoundingClientRect().top;
      const row = [...area.querySelectorAll('p')].find(el => el.textContent.startsWith('正文段落') && el.getBoundingClientRect().bottom > top + 30);
      return { text: row.textContent, y: row.getBoundingClientRect().top - top, scroll: area.scrollTop,
        diagrams: [...area.querySelectorAll('.mermaid-diagram')].map(el => ({ height: el.getBoundingClientRect().height, width: el.clientWidth, classes: el.className, rendered: el.dataset.noteMermaidRendered })),
        font: getComputedStyle(row).font, height: area.scrollHeight };
    });
    await page.evaluate(() => T.openNote('Other.md')); await page.evaluate(() => T.openNote('Diagram.md')); await pause(250);
    const returned = await page.evaluate(text => {
      const area = document.querySelector('[data-role="note-reading-view"]');
      const row = [...area.querySelectorAll('p')].find(el => el.textContent === text);
      return { y: row.getBoundingClientRect().top - area.getBoundingClientRect().top, scroll: area.scrollTop,
        diagrams: [...area.querySelectorAll('.mermaid-diagram')].map(el => ({ height: el.getBoundingClientRect().height, width: el.clientWidth, classes: el.className, rendered: el.dataset.noteMermaidRendered })),
        font: getComputedStyle(row).font, height: area.scrollHeight };
    }, anchor.text);
    assert(Math.abs(anchor.y - returned.y) <= 1, 'returning below offscreen diagrams preserves the visible text: ' + JSON.stringify({ anchor, returned }));
    checks.push('reading tab return preserves the visual anchor below offscreen diagrams');
    assert.equal(fs.readFileSync(path.join(output, 'notes/Diagram.md'), 'utf8'), saved);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ native, checks, errors, before, after }, null, 2));
    console.log('Mermaid workspace ' + (native ? 'WebView2' : 'Edge') + ': ok; ' + output);
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'server.log'), logs);
    if (page) fs.writeFileSync(path.join(output, 'failure.html'), await page.content().catch(() => ''));
    console.error('Mermaid workspace artifacts: ' + output); throw error;
  } finally {
    if (native) await page?.evaluate(() => pywebview.api.close_window()).catch(() => {});
    if (native && service.exitCode === null) await Promise.race([new Promise(resolve => service.once('exit', resolve)), pause(4000)]);
    await browser?.close().catch(() => {});
    if (service.exitCode === null) service.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

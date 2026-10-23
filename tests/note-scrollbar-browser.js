'use strict';

// Native document scrollbars in the real workspace; disposable notes only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fallbackOnly = process.argv.includes('--fallback-only');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-scrollbar-'));
fs.mkdirSync(path.join(root, 'notes'));
const content = '# 长笔记\n\n| 项目 | 内容 |\n| --- | --- |\n| 示例 | 可编辑表格 |\n\n$$\nx^2 + y^2 = 1\n$$\n\n'
  + '![布局图片](pixel.png)\n\n'
  + Array.from({ length: 260 }, (_, i) => `第 ${i} 段：` + '验证长文自然换行、正文宽度和滚动位置。'.repeat(7)).join('\n\n')
  + '\n\n文末标记';
fs.writeFileSync(path.join(root, 'notes', 'Long.md'), content);
fs.writeFileSync(path.join(root, 'notes', 'Short.md'), '短文');
fs.writeFileSync(path.join(root, 'notes', 'pixel.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'));

function metrics() {
  const area = T.state.viewMode === 'reading' ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
  const text = T.state.viewMode === 'reading' ? area.querySelector('.note-reading-content') : T.editor.view.contentDOM;
  const rect = area.getBoundingClientRect(), body = document.querySelector('.note-document-body').getBoundingClientRect();
  const pane = document.querySelector('.note-document-pane').getBoundingClientRect(), textRect = text.getBoundingClientRect();
  const title = document.querySelector('.note-inline-title-shell');
  return { left: rect.left, right: rect.right, top: rect.top, height: rect.height, bodyRight: body.right,
    paneRight: pane.right, textLeft: textRect.left, textWidth: textRect.width, scroll: area.scrollTop,
    scrollHeight: area.scrollHeight, clientHeight: area.clientHeight, clientWidth: area.clientWidth,
    sideWidth: parseFloat(getComputedStyle(document.querySelector('.note-workspace')).getPropertyValue('--note-side-width')),
    titleLeft: title.hidden ? null : title.getBoundingClientRect().left };
}

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, env: { ...process.env, RELATUM_DATA_ROOT: root }, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(url + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, 'isolated service starts');
    // Playwright hides native scrollbars in headless mode unless explicitly kept.
    browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const results = [];
    for (const dpr of fallbackOnly ? [1] : [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: dpr,
        reducedMotion: dpr === 2 ? 'reduce' : 'no-preference' });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
        '  window.T = {state, openNote, flushSave, closeAllTabs, setViewMode, setSideOpen, setSideMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
      await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
      await page.addInitScript(() => {
        localStorage.setItem('canvas:startWorkspace:v1', 'notes');
        localStorage.setItem('canvas:noteOpenTabs:v1', '["Long.md"]');
        localStorage.setItem('canvas:noteActiveTab:v1', 'Long.md');
        localStorage.setItem('canvas:noteGraphPreload:v1', '0');
      });
      await page.goto(url);
      await page.waitForFunction(() => window.T?.state.current?.path === 'Long.md' && T.state.active && T.editor);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.querySelector('.note-live-editor-host mjx-container')
        && [...document.querySelectorAll('.note-live-editor-host img')].some(img => img.complete && img.naturalWidth));
      for (const width of fallbackOnly ? [] : dpr === 1 ? [1920, 1440, 1121, 1120, 760] : [1920, 1121]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(dark => { document.body.dataset.startTheme = dark ? 'dark' : 'light'; T.setSideOpen(false); }, width < 1920 || dpr === 2);
        for (const mode of ['live', 'source', 'reading']) {
          await page.evaluate(mode => T.setViewMode(mode), mode);
          await page.waitForTimeout(350);
          await page.evaluate(() => {
            const area = T.state.viewMode === 'reading' ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
            area.scrollTop = 1200;
          });
          await page.waitForTimeout(200);
          const before = await page.evaluate(metrics);
          assert(before.scrollHeight > before.clientHeight * 10, 'fixture is a long document');
          const reserve = before.paneRight - before.right;
          assert(Math.abs(reserve - (width > 1120 ? before.sideWidth + 8 : 0)) <= 1, 'responsive fixed gutter: ' + JSON.stringify({ width, dpr, mode, reserve }));
          assert(before.titleLeft === null || Math.abs(before.titleLeft - before.textLeft) <= 1, 'filename and text keep the same left edge');
          await page.evaluate(() => { window.retainedEditor = T.editor.view; window.sidebarSamples = []; });
          // Observe the whole transition and reversal, not just its final geometry.
          for (const action of ['open', 'outline', 'links', 'close', 'reverse']) {
            await page.evaluate(async action => {
              if (action === 'open') T.setSideOpen(true);
              else if (action === 'close') T.setSideOpen(false);
              else if (action !== 'reverse') T.setSideMode(action);
              else { T.setSideOpen(true); await new Promise(resolve => requestAnimationFrame(resolve)); T.setSideOpen(false); }
              const until = performance.now() + 300;
              do {
                await new Promise(resolve => requestAnimationFrame(resolve));
                const area = T.state.viewMode === 'reading' ? document.querySelector('[data-role="note-reading-view"]') : T.editor.view.scrollDOM;
                const text = T.state.viewMode === 'reading' ? area.querySelector('.note-reading-content') : T.editor.view.contentDOM;
                sidebarSamples.push({ right: area.getBoundingClientRect().right, textWidth: text.getBoundingClientRect().width, scroll: area.scrollTop });
              } while (performance.now() < until);
            }, action);
          }
          const samples = await page.evaluate(() => sidebarSamples);
          assert(samples.every(item => Math.abs(item.right - before.right) <= 1 && Math.abs(item.textWidth - before.textWidth) <= 1
            && Math.abs(item.scroll - before.scroll) <= 1), 'sidebar keeps scrollbar, text width and viewport stable: ' + JSON.stringify({ width, dpr, mode, before, last: samples.at(-1) }));
          assert(await page.evaluate(() => T.editor.view === retainedEditor), 'sidebar retains the editor');
          const area = page.locator(mode === 'reading' ? '[data-role="note-reading-view"]' : '.note-live-editor-host .cm-scroller');
          const box = await area.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 240);
          await page.waitForTimeout(180);
          assert((await page.evaluate(metrics)).scroll > before.scroll + 100, 'real wheel scrolling works');
          if (width === 1920) {
            await page.evaluate(() => T.setSideOpen(true)); await page.waitForTimeout(300);
            const drag = await page.evaluate(metrics);
            const thumb = Math.max(32, drag.clientHeight * drag.clientHeight / drag.scrollHeight);
            const center = drag.top + (drag.clientHeight - thumb) * drag.scroll / (drag.scrollHeight - drag.clientHeight) + thumb / 2;
            await page.screenshot({ path: path.join(root, `drag-${mode}-dpr${dpr}.png`) });
            await page.mouse.move(drag.right - 5, center); await page.mouse.down();
            await page.mouse.move(drag.right - 5, center + 90, { steps: 6 }); await page.mouse.up();
            await page.waitForTimeout(200);
            const dragged = await page.evaluate(metrics);
            assert(dragged.scroll > drag.scroll + 500, 'native scrollbar can be dragged while sidebar is open: ' + JSON.stringify({ mode, dpr, center, drag, dragged }));
            await page.evaluate(() => T.setSideOpen(false)); await page.waitForTimeout(300);
          }
          await page.evaluate(() => {
            if (T.state.viewMode === 'reading') document.querySelector('[data-role="note-reading-view"]').focus({ preventScroll: true });
            else {
              const view = T.editor.view, rect = view.scrollDOM.getBoundingClientRect();
              const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 10, y: rect.top + rect.height / 2 });
              if (pos !== null) view.dispatch({ selection: { anchor: pos } });
              view.focus();
            }
          });
          const keyBefore = (await page.evaluate(metrics)).scroll;
          await page.keyboard.press('PageDown'); await page.waitForTimeout(200);
          assert((await page.evaluate(metrics)).scroll > keyBefore + 100, 'keyboard scrolling works');
          await page.keyboard.press('Control+End'); await page.waitForTimeout(350);
          const end = await page.evaluate(metrics);
          assert(end.scrollHeight - end.clientHeight - end.scroll <= 140, 'document end is reachable above the bottom text padding');
          assert.equal(await page.evaluate(() => T.editor.snapshot().value), content, 'scrolling and panels leave Markdown intact');
          results.push({ width, dpr, mode, right: before.right, textWidth: before.textWidth });
        }
      }
      await page.setViewportSize({ width: 1920, height: 900 });
      await page.evaluate(async () => { await T.setViewMode('live'); T.setSideOpen(true); });
      await page.waitForTimeout(350);
      await page.evaluate(() => { T.editor.view.dispatch({ selection: { anchor: 2, head: 5 } }); T.editor.view.focus(); });
      await page.keyboard.insertText('已验证'); await page.evaluate(() => T.flushSave());
      assert.equal(fs.readFileSync(path.join(root, 'notes', 'Long.md'), 'utf8'), content.replace('长笔记', '已验证'), 'selection editing saves the expected Markdown');
      await page.screenshot({ path: path.join(root, `wide-open-dpr${dpr}.png`) });
      await page.evaluate(() => T.setSideOpen(false)); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(root, `wide-closed-dpr${dpr}.png`) });
      await page.evaluate(() => T.openNote('Short.md')); await page.waitForTimeout(350);
      const short = await page.evaluate(metrics);
      assert(short.scrollHeight <= short.clientHeight + 1, 'short text has no forced vertical scrollbar');
      await page.evaluate(() => T.openNote('Long.md'));
      await page.evaluate(value => T.editor.view.dispatch({ changes: { from: 0, to: T.editor.view.state.doc.length, insert: value } }), content);
      await page.evaluate(() => T.flushSave());
      if (dpr === 1) {
        await page.route('**/note-live-editor.js*', route => route.fulfill({ contentType: 'text/javascript',
          body: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8')
            + '\nwindow.RelatumNoteLiveEditor.create = () => {throw new Error("test editor fallback");};' }));
        await page.reload();
        const fallback = page.locator('[data-role="note-editor-fallback"]');
        await fallback.waitFor({ state: 'visible' });
        for (const width of [1920, 1121]) {
          await page.setViewportSize({ width, height: 900 });
          for (const open of [false, true]) {
            await page.evaluate(open => T.setSideOpen(open), open); await page.waitForTimeout(300);
            const geometry = await fallback.evaluate(area => ({ right: area.getBoundingClientRect().right,
              body: document.querySelector('.note-document-body').getBoundingClientRect().right,
              pane: document.querySelector('.note-document-pane').getBoundingClientRect().right }));
            assert(Math.abs(geometry.right - geometry.body) <= 1 && Math.abs(geometry.pane - geometry.right - 328) <= 1,
              'fallback textarea shares the native scrollbar gutter');
          }
        }
        // No active note: the empty state must not reserve the sidebar twice.
        await page.evaluate(() => T.closeAllTabs());
        const empty = await page.evaluate(() => {
          const element = document.querySelector('.note-empty-state');
          return { right: element.getBoundingClientRect().right, body: element.parentElement.getBoundingClientRect().right };
        });
        assert(Math.abs(empty.right - empty.body) <= 1, 'empty state fills the already reserved document area');
      }
      assert.deepEqual(errors, [], 'no browser errors');
      await context.close();
    }
    fs.writeFileSync(path.join(root, 'scrollbar-report.json'), JSON.stringify(results, null, 2));
    console.log((fallbackOnly ? 'note scrollbar fallback: ok' : 'note scrollbar browser: ok (' + results.length + ' responsive/mode/DPR scenarios)') + '; report: ' + root);
  } finally { await browser?.close(); service.kill(); console.log('Isolated fixtures: ' + root); }
})().catch(error => { console.error(error); process.exitCode = 1; });

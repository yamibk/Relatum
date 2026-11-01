'use strict';
// Actual source desktop shell, WebView2 and disk files. Registry registration is
// covered by a fake registry in Python; this test never registers an application.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-markdown-files-'));
const artifact = process.env.RELATUM_ARTIFACT_DIR || root;
const file = path.join(root, '桌面 文档.md');
const source = '# A quiet page · 静心书写\n\n直接编辑磁盘上的 Markdown，保留原来的文件位置。\n\n## 熟悉的实时预览\n\n**加粗**、*斜体*和 `code`。\n\n| 功能 | 状态 |\n| --- | --- |\n| 原有编辑器 | 复用 |\n| 笔记库 | 独立 |\n\n## 大纲只在需要时出现\n\n正文是窗口的中心。\n';
const blank = process.argv.includes('--blank');
const release = process.env.RELATUM_MARKDOWN_RELEASE;
const workspace = process.argv.includes('--workspace');
assert(!(release && blank), '--blank uses a source-only file-picker test double');
fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(artifact, { recursive: true });
fs.writeFileSync(file, '\ufeff' + source.replace(/\n/g, '\r\n'));
fs.writeFileSync(path.join(root, 'data', 'markdown-files.json'), JSON.stringify({ version: 1, autoSave: false, outline: false, recent: [] }));
if (workspace) {
  fs.mkdirSync(path.join(root, 'data', 'desktop-sessions', 'full'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'desktop-sessions', 'full', 'preferences.json'), JSON.stringify({ version: 1,
    values: { 'canvas:startWorkspace:v1': 'notes' } }));
}
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
(async () => {
  const port = await freePort(), debug = 'http://127.0.0.1:' + port;
  const saveTarget = path.join(root, '新建 文档.md'), copyTarget = path.join(root, '另存 文档.md');
  const blankHost = 'import sys, desktop, webview.window; targets=iter(' + JSON.stringify([saveTarget, copyTarget]) + '); webview.window.Window.create_file_dialog=lambda *args,**kwargs:[next(targets)]; sys.argv=["desktop.py","--markdown-file"]; sys.exit(desktop.main())';
  const argumentsList = workspace ? (release ? [] : ['-B', 'desktop.py']) : release ? [file] : blank ? ['-B', '-c', blankHost] : ['-B', 'desktop.py', file];
  const child = spawn(release ? path.join(release, 'Relatum.exe') : process.env.RELATUM_PYTHON || 'python', argumentsList, {
    cwd: release || repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELATUM_DATA_ROOT: root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  });
  let logs = '', browser;
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) { try { ready = (await fetch(debug + '/json/version')).ok; } catch (_) {} if (ready) break; assert.equal(child.exitCode, null, logs); await pause(100); }
    assert(ready, logs);
    browser = await chromium.connectOverCDP(debug); const context = browser.contexts()[0];
    let page;
    for (let i = 0; i < 100; i++) { page = context.pages().find(p => p.url().includes(workspace ? 'index.html' : 'markdown-file.html')); if (page) break; await pause(100); }
    assert(page, logs); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.stack || e.message));
    if (workspace) {
      await page.waitForFunction(() => window.CanvasNoteWorkspace && document.body.dataset.startWorkspace === 'notes');
      await page.locator('[data-note-action="toggle-library-settings"]').click();
      await page.locator('nav [data-settings-category="markdown-files"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-markdown-action="autoSave"]').disabled);
      assert.equal(await page.locator('.markdown-files-card').count(), 4);
      await page.locator('[data-markdown-action="autoSave"]').check();
      await page.waitForFunction(() => !document.querySelector('[data-markdown-action="autoSave"]').disabled);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'markdown-files.json'))).autoSave, true);
      await page.locator('.relatum-settings-scroll').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: path.join(artifact, 'markdown-file-workspace-settings.png') });
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('Markdown management in full desktop: OK; artifacts: ' + artifact);
      return;
    }
    await page.waitForFunction(() => window.RelatumMarkdownWindow?.editor);
    if (blank) {
      assert.equal(await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value), '');
      await page.evaluate(() => RelatumMarkdownWindow.editor.replaceSelection('# 新文档\n\n保留修改。\n'));
      await page.locator('[data-action="save"]').click();
      await page.waitForFunction(() => document.querySelector('[data-role="save-status"]').textContent === '已保存');
      assert.equal(fs.readFileSync(saveTarget, 'utf8'), '# 新文档\n\n保留修改。\n');
      await page.keyboard.press('Control+Shift+s');
      await page.waitForFunction(() => document.querySelector('[data-role="filename"]').textContent === '另存 文档.md');
      assert.equal(fs.readFileSync(copyTarget, 'utf8'), fs.readFileSync(saveTarget, 'utf8'));
      assert(fs.readFileSync(file, 'utf8').includes('静心书写'), 'other files remain untouched');
      await page.evaluate(() => { RelatumMarkdownWindow.close(); });
      console.log('Markdown new / Save As: OK; artifacts: ' + artifact);
      return;
    }
    assert.equal(await page.locator('.cm-editor').count(), 1);
    assert.equal(await page.locator('.note-tree, .note-ai-panel, .note-graph-panel').count(), 0);
    assert.equal(await page.locator('.markdown-outline').isVisible(), false);
    assert.equal(await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value), source);
    await page.evaluate(() => {
      const e = RelatumMarkdownWindow.editor, at = e.view.state.doc.toString().indexOf('quiet');
      e.view.dispatch({ selection: { anchor: at, head: at + 5 } }); e.focus();
      e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    });
    await page.locator('menu.markdown-more:visible').getByRole('button', { name: '加粗', exact: true }).click();
    assert((await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value)).includes('**quiet**'));
    await page.locator('[data-action="more"]').click();
    await page.getByRole('button', { name: '撤销  Ctrl+Z', exact: true }).click();
    assert(!(await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value)).includes('**quiet**'));
    const requests = []; page.on('request', r => requests.push(r.url()));
    await page.locator('[data-action="outline"]').click();
    await page.locator('.note-outline-title').first().waitFor();
    assert.equal(await page.locator('.note-outline-title').count(), 3);
    await page.locator('.note-outline-title').last().click();
    assert(await page.evaluate(() => RelatumMarkdownWindow.editor.view.state.selection.main.head > 100));
    await page.evaluate(() => { const e = RelatumMarkdownWindow.editor; e.view.dispatch({ changes: { from: e.view.state.doc.length, insert: '\n新增内容。\n' } }); });
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(() => document.querySelector('[data-role="save-status"]').textContent === '已保存');
    const saved = fs.readFileSync(file); assert(saved.subarray(0, 3).equals(Buffer.from([239, 187, 191])));
    assert(saved.toString().includes('新增内容。\r\n')); assert(!saved.toString().includes('\r\r\n'));
    fs.writeFileSync(file, '# External change\n');
    await page.evaluate(() => { const e = RelatumMarkdownWindow.editor; e.view.dispatch({ changes: { from: e.view.state.doc.length, insert: '\nKeep my draft\n' } }); });
    await page.locator('[data-action="save"]').click();
    await page.locator('[data-role="error"]').filter({ hasText: '其他程序' }).waitFor();
    assert.equal(fs.readFileSync(file, 'utf8'), '# External change\n');
    assert((await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value)).includes('Keep my draft'));
    await page.locator('[data-action="more"]').click(); await page.getByRole('button', { name: '重新载入磁盘文件', exact: true }).click();
    await page.locator('.markdown-close-dialog button[value="reload"]').click();
    await page.waitForFunction(() => RelatumMarkdownWindow.editor.snapshot().value === '# External change\n');
    // Restore a visually representative document through the same external-read flow.
    fs.writeFileSync(file, source);
    await page.locator('[data-action="more"]').click(); await page.getByRole('button', { name: '重新载入磁盘文件', exact: true }).click();
    await page.waitForFunction(() => RelatumMarkdownWindow.editor.snapshot().value.includes('静心书写'));
    await page.screenshot({ path: path.join(artifact, 'markdown-file-window.png') });
    await page.locator('[data-action="settings"]').click();
    await page.locator('.markdown-files-card').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-markdown-action="autoSave"]').disabled);
    assert.equal(await page.locator('.markdown-files-steps').count(), 1);
    const system = await page.evaluate(() => pywebview.api.markdown_files('status'));
    assert.equal(await page.locator('[data-markdown-action="defaults"]').isDisabled(), !system.association.supported);
    await page.locator('[data-markdown-action="autoSave"]').check();
    await page.waitForFunction(() => !document.querySelector('[data-markdown-action="autoSave"]').disabled);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'markdown-files.json'))).autoSave, true);
    await page.screenshot({ path: path.join(artifact, 'markdown-file-settings.png') });
    await page.locator('.relatum-settings-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(artifact, 'markdown-file-setup.png') });
    await page.locator('[data-settings-category="appearance"]').first().click();
    await page.locator('.markdown-appearance select').selectOption('apple');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.relatum-settings').open);
    await page.evaluate(() => { const e = RelatumMarkdownWindow.editor; e.view.dispatch({ changes: { from: e.view.state.doc.length, insert: '\nAutosaved\n' } }); });
    await page.waitForFunction(() => document.querySelector('[data-role="save-status"]').textContent === '已保存');
    assert(fs.readFileSync(file, 'utf8').includes('Autosaved'));
    await page.locator('[data-action="source"]').click();
    assert.equal(await page.locator('[data-action="source"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-action="source"]').click();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: true } })); });
    await pause(80);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new CustomEvent('canvasdesktop:visibility', { detail: { minimized: false } })); });
    await page.screenshot({ path: path.join(artifact, 'markdown-file-apple.png') });
    assert(!requests.some(u => /notes-tree|note-query|graph-engine|note-ai|vendor\/mathjax|note-mermaid/.test(u)), 'plain file does not load notebook, graph, AI or math runtimes');
    // Paste a real image file through the shared editor callback, then read it
    // through the window's limited asset route.
    await page.evaluate(() => {
      const e = RelatumMarkdownWindow.editor, end = e.view.state.doc.length;
      e.view.dispatch({ selection: { anchor: end } });
      const clipboard = new DataTransfer();
      clipboard.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>'], 'pasted.svg', { type: 'image/svg+xml' }));
      e.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
    });
    await page.waitForFunction(() => RelatumMarkdownWindow.editor.snapshot().value.includes('.assets/'));
    await page.evaluate(() => { const e = RelatumMarkdownWindow.editor; e.view.dispatch({ selection: { anchor: 0 } }); e.view.scrollDOM.scrollTop = e.view.scrollDOM.scrollHeight; });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('img[src*="markdown-file-asset"]')).some(image => image.naturalWidth === 30));
    const asset = await page.locator('img[src*="markdown-file-asset"]').first().getAttribute('src');
    assert.equal((await fetch(new URL(asset, page.url()))).status, 200);
    assert.equal((await fetch(new URL('/api/markdown-file-asset?token=wrong&src=test.svg', page.url()))).status, 403);
    assert.equal((await fetch(new URL('/api/markdown-file-asset?token=中文&src=test.svg', page.url()))).status, 403);
    assert.equal((await fetch(new URL('/api/note?path=secret.md', page.url()))).status, 404);
    assert.equal((await fetch(new URL('/api/note-save', page.url()), { method: 'POST', body: '{}' })).status, 405);
    await page.evaluate(() => {
      const e = RelatumMarkdownWindow.editor;
      e.view.dispatch({ changes: { from: 0, insert: '$x^2$\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n' }, selection: { anchor: 0 } });
      e.view.scrollDOM.scrollTop = 0;
    });
    await page.locator('mjx-container').first().waitFor();
    await page.locator('.is-mermaid svg').first().waitFor();
    await page.locator('[data-action="settings"]').click();
    await page.locator('[data-settings-action="reset-all"]').click();
    await page.locator('[data-settings-action="accept-reset"]').click();
    await page.waitForFunction(() => RelatumNoteTheme.read() === 'default');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'markdown-files.json'))).autoSave, true);
    assert(JSON.parse(fs.readFileSync(path.join(root, 'data', 'markdown-files.json'))).recent.length > 0, 'reset preserves recent entries');
    await page.keyboard.press('Escape');
    assert(!fs.existsSync(path.join(root, 'notes')), 'no notebook directory is created');
    assert.equal(errors.length, 0, errors.join('\n'));
    // Close with a pending manual edit: Cancel preserves it; Discard closes.
    await page.evaluate(async () => { await pywebview.api.markdown_files('autoSave', false); RelatumMarkdownWindow.editor.view.dispatch({ changes: { from: 0, insert: 'Pending ' } }); });
    await page.evaluate(() => { RelatumMarkdownWindow.close(); });
    await page.locator('.markdown-close-dialog button[value="cancel"]').click();
    assert((await page.evaluate(() => RelatumMarkdownWindow.editor.snapshot().value)).startsWith('Pending '));
    await page.evaluate(() => { RelatumMarkdownWindow.close(); });
    await page.locator('.markdown-close-dialog button[value="discard"]').click();
    console.log('Markdown desktop: OK; artifacts: ' + artifact);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {} }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

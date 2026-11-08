'use strict';
// Real clipboard/modifier clicks against isolated Notes and standalone pages.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-file-links-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const address = 'file:///C:/link-fixture/%E4%B8%AD%E6%96%87/guide%20%28v1%29.html';
const chinese = 'file:///D:/中文目录/示例文档.html', spaced = 'file:///D:/示例 目录/guide (v1).pdf';
const initial = '# Links\n\n' + address + '\n\n[示例文档](' + chinese + ')\n\n<' + spaced + '>\n\n[参考][ref]\n\n[ref]: ' + address + '\n';
fs.mkdirSync(path.join(root, 'notes'));
fs.writeFileSync(path.join(root, 'notes', 'Main.md'), initial);

(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const service = spawn(process.env.RELATUM_PYTHON || 'python', ['-B', 'app.py', '--no-browser', '--port', String(port)],
    { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELATUM_DATA_ROOT: root } });
  let browser, logs = '';
  service.stdout.on('data', value => logs = (logs + value).slice(-6000));
  service.stderr.on('data', value => logs = (logs + value).slice(-6000));
  service.on('error', error => logs += error.message);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(origin + '/api/runtime')).ok; } catch (_) {} if (ready) break; await pause(100); }
    assert(ready, logs);
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    for (const standalone of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      const page = await context.newPage(), opens = [], errors = [], requests = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      if (standalone) {
        await context.addInitScript(initial => {
          window.fixture = { opens: [], saved: localStorage.getItem('file-links-test-saved') ?? initial };
          window.pywebview = { api: {
            async markdown_document(action, content) {
              if (action === 'save') { fixture.saved = content; localStorage.setItem('file-links-test-saved', content); }
              return { ok: true, changed: false, settings: { autoSave: false, outline: false },
                document: { path: 'C:/fixture/Main.md', name: 'Main.md', revision: 'fixture', token: 'fixture', content: fixture.saved } };
            },
            async markdown_files() { return { ok: true, settings: { autoSave: false, outline: false }, recent: [], association: { supported: false } }; },
            async markdown_open_link(target) { fixture.opens.push(target); return { ok: true }; },
            async set_dirty() { return { ok: true }; }, async markdown_set_appearance() { return { ok: true }; },
          } };
        }, initial);
      } else {
        const source = fs.readFileSync(path.join(repo, 'assets/note-workspace.js'), 'utf8').replace('  window.CanvasNoteWorkspace = {',
          '  window.T = {state, setViewMode, flushSave, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
        await page.route('**/note-workspace.js*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
        await page.route('**/api/open-external', route => { opens.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
        await context.addInitScript(() => {
          localStorage.setItem('canvas:startWorkspace:v1', 'notes'); localStorage.setItem('canvas:noteOpenTabs:v1', '["Main.md"]');
          localStorage.setItem('canvas:noteActiveTab:v1', 'Main.md'); localStorage.setItem('canvas:noteGraphPreload:v1', '0');
        });
      }
      const editor = standalone ? 'RelatumMarkdownWindow.editor' : 'T.editor';
      const opened = async () => standalone ? page.evaluate(() => fixture.opens) : opens.map(value => value.target);
      const value = () => page.evaluate(editor => (0, eval)(editor).snapshot().value, editor);
      async function boot() {
        await page.goto(origin + (standalone ? '/markdown-file.html' : '/'));
        await page.waitForFunction(editor => { try { return !!(0, eval)(editor); } catch (_) { return false; } }, editor);
      }
      async function set(source, mode = 'source') {
        if (standalone) {
          if (await page.locator('.note-live-editor-host').evaluate(node => node.classList.contains('is-source-mode')) !== (mode === 'source')) await page.locator('[data-action="source"]').click();
        } else await page.evaluate(mode => T.setViewMode(mode), mode);
        await page.evaluate(({ editor, source }) => {
          const e = (0, eval)(editor), view = e.view;
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: source.length },
            annotations: RelatumCodeMirror.isolateHistory.of('full'), userEvent: 'input.test' }); e.focus();
        }, { editor, source });
        await page.waitForTimeout(100);
      }
      async function clickText(text, ctrl = true) {
        const coords = await page.evaluate(async ({ editor, text }) => {
          const e = (0, eval)(editor), from = e.view.state.doc.toString().indexOf(text);
          if (from < 0) throw Error('Fixture text missing: ' + text);
          const position = from + Math.min(8, text.length - 1);
          e.view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); e.focus();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const box = e.view.coordsAtPos(position); return { x: box.left + 1, y: (box.top + box.bottom) / 2 };
        }, { editor, text });
        if (ctrl) await page.keyboard.down('Control');
        try { await page.mouse.click(coords.x, coords.y); } finally { if (ctrl) await page.keyboard.up('Control'); }
        await page.waitForTimeout(100);
      }
      async function clipboard(html = true, plain = address) {
        await page.evaluate(async ({ html, plain, address }) => {
          const data = { 'text/plain': new Blob([plain], { type: 'text/plain' }) };
          if (html) data['text/html'] = new Blob(['<a href="' + address + '">示例网页 | 本地文件</a>'], { type: 'text/html' });
          await navigator.clipboard.write([new ClipboardItem(data)]);
        }, { html, plain, address });
      }
      async function menuPaste(plain) {
        await page.keyboard.press('Shift+F10');
        if (standalone) await page.locator('menu.markdown-more:visible').getByRole('button', { name: plain ? '纯文本粘贴' : '粘贴', exact: true }).click();
        else await page.locator('[data-role="note-context-menu"] [data-note-command="' + (plain ? 'paste-plain' : 'paste') + '"]').click();
      }
      await boot();
      for (const mode of ['live', 'source']) {
        await set(initial, mode);
        const before = (await opened()).length;
        await clickText(address, false); assert.equal((await opened()).length, before, 'ordinary editor click edits');
        for (const [text, target] of [[address, address], ['示例文档', chinese], ['<' + spaced, spaced], ['参考', address]]) {
          await clickText(text); assert.equal((await opened()).at(-1), target, mode + ' / ' + text);
        }
        assert.equal(await value(), initial, 'opening never changes Markdown');
        for (const menu of [false, true]) for (const plain of [false, true]) {
          await set('', mode); await clipboard();
          if (menu) await menuPaste(plain); else await page.keyboard.press(plain ? 'Control+Shift+v' : 'Control+v');
          const expected = plain ? address : '[示例网页 | 本地文件](' + address + ')';
          await page.waitForFunction(({ editor, expected }) => (0, eval)(editor).snapshot().value === expected, { editor, expected });
          assert.equal(await value(), expected, 'title/explicit plain paste: ' + JSON.stringify({ standalone, mode, menu, plain }));
          await page.keyboard.press('Control+z'); assert.equal(await value(), '', 'paste has one undo');
        }
        await set('', mode); await clipboard(false); await page.keyboard.press('Control+v');
        await page.waitForFunction(({ editor, address }) => (0, eval)(editor).snapshot().value === address, { editor, address });
      }
      if (!standalone) {
        await set(initial, 'live'); await page.evaluate(() => T.setViewMode('reading'));
        assert.equal(await page.locator('.note-reading-content [data-href]').count(), 4);
        await page.locator('.note-reading-content [data-href]').nth(0).click(); assert.equal((await opened()).at(-1), address);
        assert(opens.every(item => item.kind === 'note-file-url' && item.note === 'Main.md'));
      }
      for (const source of ['```md\n' + address + '\n```', '`' + address + '`', '<!--\n' + address + '\n-->',
        '%%\n' + address + '\n%%', '$$\n' + address + '\n$$', '\\[\n' + address + '\n\\]', '---\nlink: ' + address + '\n---']) {
        await set(source); const before = (await opened()).length; await clickText(address);
        assert.equal((await opened()).length, before, 'literal stays inactive: ' + source);
      }
      const transforms = await page.evaluate(address => {
        const html = '<a href="' + address + '">标题 [重点]</a>';
        return [MarkdownMini.pastedLinkMarkdown(address, html),
          MarkdownMini.pastedLinkMarkdown(address, html.replace(address, 'https://example.test')),
          MarkdownMini.pastedLinkMarkdown(address, html, { before: '```\n', after: '\n```' }),
          MarkdownMini.pastedLinkMarkdown(address, html, { before: '`', after: '`' })];
      }, address);
      assert.deepEqual(transforms, ['[标题 \\[重点\\]](' + address + ')', address, address, address]);
      await set(initial + '\nSaved', 'live');
      if (standalone) { await page.keyboard.press('Control+s'); await page.waitForFunction(() => fixture.saved.endsWith('Saved')); }
      else { assert(await page.evaluate(() => T.flushSave())); assert(fs.readFileSync(path.join(root, 'notes', 'Main.md'), 'utf8').endsWith('Saved')); }
      await boot(); assert.equal(await value(), initial + '\nSaved');
      await page.screenshot({ path: path.join(root, standalone ? 'standalone.png' : 'workspace.png') });
      assert.deepEqual(errors, []); assert(!requests.some(url => !url.startsWith(origin)), 'links stay inert until activated');
      await context.close();
    }
    console.log('note file links browser: ok (workspace + standalone); ' + root);
  } finally {
    await browser?.close(); service.kill();
    if (service.exitCode == null) await Promise.race([new Promise(resolve => service.once('exit', resolve)), pause(5000)]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

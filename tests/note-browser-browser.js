'use strict';
// Actual service + Edge, always using a disposable data root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-browser-'));
const notes = path.join(root, 'notes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(notes);
  for (let index = 0; index < 105; index++) {
    const file = path.join(notes, `N${String(index).padStart(3, '0')}.md`);
    fs.writeFileSync(file, `---\ntags: [学习/概率, AI]\n---\n第 ${index} 篇摘要 #学习/统计\n\n正文。`);
    fs.utimesSync(file, 10000 + index, 10000 + index);
  }
  fs.mkdirSync(path.join(notes, 'images'));
  fs.writeFileSync(path.join(notes, 'images', 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(notes, 'Formula.md'), '---\ntags: [数学]\nother: "#hidden"\n---\n\n随机变量 \\(X\\) 与 \\(x\\)。\n\n\\[P(X\\le 74)\\]\n\n\\[\nZ=\\frac{X-80}{6}\n\\]\n\n> [!note]\n> \\(q\\)\n\n| 值 |\n| --- |\n| \\(t\\) |\n\n#数学\n\n![[sample.png|80]]\n\n结束。');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.RELATUM_PYTHON || 'python', ['app.py', '--no-browser', '--port', String(port)], {
    cwd:repo, env:{...process.env, RELATUM_DATA_ROOT:root}, windowsHide:true, stdio:'ignore',
  });
  let browser;
  try {
    for (let index = 0; index < 100; index++) {
      try { if ((await fetch(url + '/api/runtime')).ok) break; } catch (error) {}
      await sleep(100);
    }
    browser = await chromium.launch({headless:true, ...(process.env.RELATUM_EDGE_PATH ? {executablePath:process.env.RELATUM_EDGE_PATH} : {})});
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.addInitScript(() => {
      let runtime;
      Object.defineProperty(window, 'RelatumNoteLiveEditor', {configurable:true, get(){return runtime;}, set(value) {
        runtime = value;
        const create = value.create;
        value.create = function(...args) { const editor = create(...args); window.__noteEditor = editor; return editor; };
      }});
    });
    await page.goto(url);
    await page.locator('button[data-start-workspace="notes"]').click();
    await page.locator('.note-tree-row[data-note-path="N000.md"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'N000.md');
    assert.equal(requests.some(request => request.includes('/api/note-tags')), false, 'ordinary startup must not scan tag catalog');
    assert.equal(requests.some(request => request.includes('vendor/mathjax')), false, 'plain note must not load MathJax');
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 50);
    assert.equal(await page.locator('.note-browser-nav-row').first().locator('svg use').getAttribute('href'), '#note-icon-clock-3');
    assert.equal(await page.locator('.note-browser-nav-row[aria-expanded] svg use').getAttribute('href'), '#note-icon-hash');
    assert.equal(await page.locator('.note-browser-result').first().getAttribute('data-note-browser-path'), 'N000.md');
    await page.locator('.note-browser-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 100);
    await page.locator('.note-browser-results').evaluate(node => node.scrollTop = 600);
    await page.locator('.note-browser-result[data-note-browser-path="N095.md"]').click();
    await page.waitForFunction(() => CanvasNoteWorkspace.currentPath === 'N095.md');
    assert.equal(await page.locator('[data-role="note-browser-back"] svg use').getAttribute('href'), '#note-icon-arrow-left');
    await page.locator('[data-role="note-browser-back"]').click();
    assert.equal(await page.locator('.note-browser-result').count(), 100);
    assert.equal(await page.locator('.note-browser-result.is-selected').getAttribute('data-note-browser-path'), 'N095.md');
    await page.locator('.note-browser-nav-row[aria-expanded]').click();
    await page.waitForFunction(() => document.querySelector('[data-note-browser-tag="学习"]'));
    await page.evaluate(() => { window.__tagHeading = document.querySelector('.note-browser-nav-row[aria-expanded]'); });
    assert.equal(await page.locator('.note-browser-nav-row[aria-expanded] .note-tree-toggle').count(), 1);
    await page.evaluate(() => { __tagHeading.click(); __tagHeading.click(); });
    assert.equal(await page.evaluate(() => __tagHeading === document.querySelector('.note-browser-nav-row[aria-expanded]')), true, 'the arrow must retain its DOM through rapid reversals');
    await page.waitForFunction(() => document.querySelector('.note-browser-navigation .note-tree-children-shell').classList.contains('is-open'));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(() => { __tagHeading.click(); __tagHeading.click(); });
    assert.equal(await page.evaluate(() => getComputedStyle(__tagHeading.querySelector('.note-tree-toggle'), '::before').transitionDuration), '0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('[data-note-browser-tag="学习"]').click();
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head').textContent.includes('105'));
    await page.screenshot({path:path.join(root, 'browser-light.png')});
    let releaseQuery, seenQuery;
    const queryGate = new Promise(resolve => { releaseQuery = resolve; });
    const querySeen = new Promise(resolve => { seenQuery = resolve; });
    await page.route('**/api/note-query', async route => {
      if (route.request().postDataJSON().tag === '学习') { seenQuery(); await queryGate; }
      await route.continue();
    });
    const staleReply = page.waitForResponse(response => response.url().endsWith('/api/note-query') && response.request().postDataJSON().tag === '学习');
    await page.locator('[data-note-browser-tag="学习"]').click();
    await querySeen;
    await page.locator('.note-browser-nav-row').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 50);
    releaseQuery(); await (await staleReply).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await page.locator('.note-browser-results-head').textContent().then(value => value.includes('最近文件')), 'an old tag reply must not replace newer recent results');
    await page.unroute('**/api/note-query');
    await page.locator('[data-note-browser-tag="学习"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 50);
    await page.locator('.note-browser-result').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-role="note-browser-back"]').hidden);
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('.note-tree-row[data-note-path="Formula.md"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-live-inline-math mjx-container').length === 3 && document.querySelectorAll('.note-live-rich-block.is-math mjx-container').length === 2);
    await page.waitForFunction(() => document.querySelector('.note-table mjx-container'));
    await page.waitForFunction(() => document.querySelector('.note-live-image-frame img')?.naturalWidth > 0);
    fs.mkdirSync(path.join(notes, 'duplicate'));
    fs.copyFileSync(path.join(notes, 'images', 'sample.png'), path.join(notes, 'duplicate', 'sample.png'));
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'ambiguous-image-probe'; host.style.cssText = 'position:fixed;top:0;left:0;width:32px;height:32px';
      document.body.appendChild(host); RelatumNoteLiveEditor.renderMarkdown(host, '![[sample.png]]', 'Formula.md', {
        imageUrl: (note, source, syntax) => '/api/note-asset?note=' + encodeURIComponent(note) + '&src=' + encodeURIComponent(source) + '&syntax=' + encodeURIComponent(syntax) + '&probe=ambiguity',
      });
    });
    await page.waitForFunction(() => document.querySelector('#ambiguous-image-probe .md-local-image-fallback')?.textContent.includes('不唯一'));
    await page.evaluate(() => { const host = document.querySelector('#ambiguous-image-probe'); RelatumNoteLiveEditor.releaseReadingDocument(host); host.remove(); });
    fs.unlinkSync(path.join(notes, 'duplicate', 'sample.png'));
    assert.equal(await page.locator('.note-live-frontmatter').count(), 4);
    await page.locator('.note-tag[data-note-tag="数学"]').click({modifiers:['Control']});
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head')?.textContent.includes('#数学'));
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 1);
    assert.equal(await page.locator('.note-browser-result').count(), 1);
    await page.locator('.note-browser-result').click();
    const before = fs.readFileSync(path.join(notes, 'Formula.md'), 'utf8');
    await page.route('**/api/note-save', route => route.fulfill({status:500, contentType:'application/json', body:JSON.stringify({error:'Simulated disk failure'})}));
    await page.evaluate(() => {
      const editor = window.__noteEditor;
      editor.replaceSelection('测试编辑');
    });
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/note-save') && response.status() === 500),
      page.locator('[data-role="note-browser-back"]').click(),
    ]);
    assert.equal(await page.locator('.note-workspace.note-browser-showing-results').count(), 0, 'save failure must keep the document visible');
    assert.equal(await page.evaluate(() => CanvasNoteWorkspace.dirty), true);
    await page.unroute('**/api/note-save');
    await page.locator('[data-role="note-browser-back"]').click();
    await page.waitForFunction(() => document.querySelector('.note-workspace').classList.contains('note-browser-showing-results'));
    assert(fs.readFileSync(path.join(notes, 'Formula.md'), 'utf8').includes('测试编辑'), 'browse switch must finish the save');
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.evaluate(() => window.__noteEditor.focus());
    await page.keyboard.press('Control+z');
    await page.evaluate(() => CanvasNoteWorkspace.flushSave());
    assert.equal(fs.readFileSync(path.join(notes, 'Formula.md'), 'utf8'), before, 'sidebar switches must preserve undo');
    await page.locator('[data-note-action="current-menu"]').click();
    await page.getByRole('menuitemradio', {name:'阅读模式', exact:true}).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-role="note-reading-view"] mjx-container').length === 6);
    assert.equal(await page.locator('[data-role="note-reading-view"] .note-frontmatter').count(), 1);
    await page.locator('[data-role="note-reading-view"] .note-tag').click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 1);
    await page.locator('.note-browser-result').click();
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.locator('[data-note-action="current-menu"]').click();
    await page.getByRole('menuitemradio', {name:'实时预览', exact:true}).click();
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.evaluate(() => { document.body.dataset.startTheme = document.documentElement.dataset.startTheme = 'dark'; });
    await page.waitForFunction(() => !document.querySelector('[data-note-browser-tag="hidden"]'));
    await page.evaluate(() => RelatumI18n.setLanguage('en'));
    await page.waitForFunction(() => document.querySelector('.note-browser-nav-row').textContent.includes('Recent files'));
    await page.screenshot({path:path.join(root, 'browser-dark.png')});
    await page.evaluate(() => RelatumI18n.setLanguage('zh-CN'));
    await page.setViewportSize({width:700,height:900});
    assert.equal(await page.locator('.note-browser-results .note-mobile-pane-button svg use').getAttribute('href'), '#note-icon-panel-left');
    await page.locator('.note-browser-results .note-mobile-pane-button').click();
    assert.equal(await page.locator('.note-workspace.tree-overlay-open').count(), 1);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.note-tree-pane')).transform === 'none');
    await page.screenshot({path:path.join(root, 'browser-narrow.png')});
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.waitForFunction(() => !document.querySelector('.note-workspace').classList.contains('note-browser-mode'));
    await page.locator('[data-note-action="toggle-browser"]').click();
    await page.waitForFunction(() => document.querySelector('.note-workspace').classList.contains('note-browser-showing-results'));
    await page.locator('.note-browser-results .note-mobile-pane-button').click();
    await page.locator('.note-browser-nav-row').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.note-browser-result').length === 50);
    assert.equal(await page.locator('.note-workspace.tree-overlay-open').count(), 0);
    await page.setViewportSize({width:1440,height:900});
    const recentBeforeReload = await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('canvas:noteRecentFiles:v1'))));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.note-workspace').classList.contains('note-browser-mode') && document.querySelectorAll('.note-browser-result').length === 50);
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem('canvas:noteRecentFiles:v1')))).some(([file]) => file === 'N095.md'));
    assert.equal(await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('canvas:noteRecentFiles:v1')))['Formula.md']), recentBeforeReload['Formula.md'], 'startup restore must not record an active open');
    fs.writeFileSync(path.join(notes, 'N004.md'), '#外部修改\n外部摘要。');
    fs.utimesSync(path.join(notes, 'N004.md'), Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    await page.evaluate(() => CanvasNoteWorkspace.refresh());
    await page.waitForFunction(() => document.querySelector('.note-browser-result')?.dataset.noteBrowserPath === 'N004.md');
    fs.unlinkSync(path.join(notes, 'N095.md'));
    await page.evaluate(() => CanvasNoteWorkspace.refresh());
    await page.waitForFunction(() => document.querySelector('.note-browser-results-head').textContent.includes('105'));
    assert.equal(await page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('canvas:noteRecentFiles:v1')))['N095.md']), undefined, 'deleted files must leave recent records');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({result:'note browser integration: ok', screenshots:root, notes:106, formulas:6}));
  } finally {
    if (browser) await browser.close();
    server.kill();
    console.log('Isolated fixtures: ' + root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

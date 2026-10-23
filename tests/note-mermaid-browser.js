'use strict';
// Synthetic Markdown only. Browser probes and reports never enter production assets.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = process.env.RELATUM_MERMAID_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-'));
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = {
  flowchart: 'flowchart LR\n A[中文开始] --> B{数据有效?}\n B -->|是| C[完成]\n classDef good fill:#dcedc8,stroke:#33691e\n class C good',
  sequence: 'sequenceDiagram\n participant A as 用户\n participant B as 服务\n A->>B: 请求\n B-->>A: 返回',
  class: 'classDiagram\n class Student {\n +String name\n +study()\n }\n Student --> Course',
  state: 'stateDiagram-v2\n [*] --> Ready\n Ready --> Running: 开始\n Running --> [*]',
  er: 'erDiagram\n STUDENT ||--o{ COURSE : studies\n STUDENT {\n string name\n }',
  gantt: 'gantt\n title 学习进度\n dateFormat YYYY-MM-DD\n section 第一阶段\n 练习 :a1, 2026-10-01, 3d',
  pie: 'pie title 时间分配\n "阅读" : 40\n "练习" : 60',
  mindmap: 'mindmap\n root((学习))\n  数学\n  编程',
};
const fence = code => '```mermaid\n' + code + '\n```';
const one = '# 图表\n\n' + fence(samples.flowchart) + '\n\n最后正文';
const all = Object.entries(samples).map(([name, source]) => '## ' + name + '\n\n' + fence(source)).join('\n\n') + '\n\n最后正文';
const wide = fence('flowchart LR\n' + Array.from({ length: 18 }, (_, i) => `A${i}[步骤 ${i}] --> A${i + 1}[步骤 ${i + 1}]`).join('\n'));
const report = { samples: Object.keys(samples), checks: [], performance: [] };
const html = off => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body{margin:0;--bg:#fbfbfa;--text:#222220;--text-secondary:#777772;--border:#ddd;--border-strong:#999;--surface:#f6f5f2}
main{height:100vh;box-sizing:border-box;padding:12px 24px;max-width:960px;margin:auto}
#editor{height:calc(100vh - 24px)}#reading{height:calc(100vh - 24px);overflow:auto}
#editor[hidden],#reading[hidden]{display:none!important}
body[data-start-theme="dark"]{--bg:#202320;--text:#ecece5;--text-secondary:#b5b7b0;--surface:#30352f;--border:#424940;--border-strong:#75806e;background:var(--bg)}
</style><body class="start-page" data-start-theme="light"><main><div id="editor" class="note-live-editor-host"></div><div id="reading" hidden></div></main>
<script>window.RelatumFeatureRuntime={enabled:key=>key!=='notes.canvas'&&(${off ? 'false' : 'true'}||key!=='notes.mermaid')};</script>
<script src="markdown-table.js"></script><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script>
<script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>
window.testEditor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'普通正文',notePath:'fixture.md'});
window.setSample=(source,mode='live')=>{const e=document.getElementById('editor'),r=document.getElementById('reading');
 RelatumNoteLiveEditor.releaseReadingDocument(r);e.hidden=mode==='reading';r.hidden=mode!=='reading';
 testEditor.setSourceMode(mode==='source');testEditor.setDocument({value:source,notePath:'fixture.md',anchor:source.length,head:source.length,scrollTop:0});
 if(mode==='reading')RelatumNoteLiveEditor.renderMarkdown(r,source,'fixture.md');};
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/off') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(pathname === '/off')); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const errors = [], external = [], requests = [];
  let context;
  async function fresh(off = false, options = {}, before) {
    await context?.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
    if (before) await before(context);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { requests.push(request.url()); if (!request.url().startsWith(base)) external.push(request.url()); });
    await page.goto(base + (off ? '/off' : '/')); await page.waitForFunction(() => !!window.testEditor);
    return page;
  }
  async function set(page, source, mode) { await page.evaluate(({ source, mode }) => window.setSample(source, mode), { source, mode }); }
  async function visit(page, count) {
    for (let index = 0; index < count; index++) {
      const block = page.locator('#reading .mermaid-diagram').nth(index);
      await block.scrollIntoViewIfNeeded(); await block.locator('[data-note-mermaid-rendered], svg').first().waitFor();
    }
  }
  try {
    let page = await fresh();
    const initial = requests.length;
    await pause(150); await set(page, one, 'source'); await pause(150);
    assert.equal(requests.slice(initial).filter(url => /note-mermaid|vendor\/(?:pele|mermaid)/.test(url)).length, 0, 'plain/source notes do not load diagram resources');
    await set(page, one, 'live'); await page.locator('.is-mermaid svg').waitFor();
    assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    assert.equal(requests.filter(url => url.includes('vendor/pele/pele.global.js')).length, 1);
    assert(!requests.some(url => url.includes('vendor/mermaid/')));
    await page.locator('.is-mermaid svg').click();
    assert.equal(await page.locator('.is-mermaid svg').count(), 0, 'click exposes editable source');
    await page.evaluate(() => { const v = testEditor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.locator('.is-mermaid svg').waitFor();
    await page.evaluate(() => { const v = testEditor.view, at = v.state.doc.toString().indexOf('中文开始'); v.dispatch({ changes: { from: at, to: at + 4, insert: '新的开始' }, selection: { anchor: v.state.doc.length } }); });
    await page.waitForFunction(() => document.querySelector('.is-mermaid svg')?.textContent.includes('新的开始'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => testEditor.snapshot().value.includes('中文开始'));
    assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    report.checks.push('lazy loading, live editing, undo and source integrity');

    await set(page, all, 'reading'); await visit(page, 8);
    assert.equal(await page.locator('#reading svg').count(), 8);
    const ids = await page.locator('#reading svg [id], #reading svg[id]').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(new Set(ids).size, ids.length, 'diagram IDs are unique');
    assert.equal(await page.locator('#reading script,#reading foreignObject,#reading image,#reading [onload]').count(), 0);
    await page.locator('#reading .mermaid-diagram').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'reading-light.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(output, 'reading-dark.png') });
    await page.evaluate(() => { const original = pele; window.__parses = 0; window.pele = { ...original, parse(...args) { window.__parses++; return original.parse(...args); } }; });
    await page.setViewportSize({ width: 760, height: 850 }); await pause(200);
    assert.equal(await page.evaluate(() => window.__parses), 0, 'width changes reuse parsed models');
    await set(page, wide + '\n\n' + '正文\n\n'.repeat(80), 'reading');
    await page.getByRole('button', { name: '放大图表', exact: true }).waitFor();
    await page.getByRole('button', { name: '放大图表', exact: true }).click();
    assert(await page.locator('#reading .note-mermaid').evaluate(el => {
      const box = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll('.pele-zoom button')).filter(button => getComputedStyle(button).display !== 'none').every(button => {
        const rect = button.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom && rect.right <= box.right;
      });
    }), 'all zoom controls stay inside a very short, wide diagram');
    await page.getByRole('button', { name: '复位图表', exact: true }).click();
    const top = await page.locator('#reading').evaluate(el => el.scrollTop);
    await page.locator('#reading .note-mermaid-stage > svg').hover(); await page.mouse.wheel(0, 260); await pause(160);
    assert((await page.locator('#reading').evaluate(el => el.scrollTop)) > top, 'ordinary wheel still scrolls the note');
    report.checks.push('eight diagram types, Chinese, unique IDs, themes, parse reuse, reading zoom and wheel');

    await set(page, '> [!note] 引用\n> ```mermaid\n> flowchart TD\n> A[中文] --> B[结束]\n> ```\n\n最后正文', 'live');
    await page.locator('.is-mermaid svg').waitFor();
    await set(page, fence('flowchart TD\n A['), 'reading'); await page.locator('.note-mermaid-error').waitFor();
    assert((await page.locator('.note-mermaid-error pre').textContent()).includes('A['));
    await set(page, fence('flowchart TD\n' + 'A'.repeat(65537)), 'reading'); await page.locator('.note-mermaid-error').waitFor();
    await set(page, '```mermaid\nflowchart TD\nA-->B', 'live'); await pause(80);
    assert.equal(await page.locator('.is-mermaid').count(), 0);
    report.checks.push('nested callout, syntax error, size guard and incomplete fence');

    page = await fresh(true); const offStart = requests.length;
    await set(page, one, 'live'); await pause(100); assert.equal(await page.locator('.is-mermaid').count(), 0);
    await set(page, all, 'reading'); assert.equal(await page.locator('#reading pre.md-code').count(), 8); await pause(100);
    assert.equal(requests.slice(offStart).filter(url => /note-mermaid|vendor\/(?:pele|mermaid)/.test(url)).length, 0);
    report.checks.push('disabled feature retains ordinary editable/readable code without engine requests');

    for (const asset of ['note-mermaid.js', 'vendor/pele/pele.global.js']) {
      let failures = 0;
      page = await fresh(false, {}, async ctx => ctx.route('**/assets/' + asset, route => ++failures === 1 ? route.abort() : route.continue()));
      await set(page, one, 'live'); await page.getByRole('button', { name: '重试', exact: true }).waitFor();
      await page.getByRole('button', { name: '重试', exact: true }).click(); await page.locator('.is-mermaid svg').waitFor();
      assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    }
    report.checks.push('adapter and engine load failure retry');

    page = await fresh(false, {}, async ctx => ctx.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktopMinimized = '1'; }); }));
    const hiddenStart = requests.length; await set(page, one, 'live'); await pause(160);
    assert.equal(requests.slice(hiddenStart).filter(url => /note-mermaid|vendor\/pele/.test(url)).length, 0);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.locator('.is-mermaid svg').waitFor();
    await set(page, wide, 'reading'); await page.getByRole('button', { name: '放大图表', exact: true }).waitFor();
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '1'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    assert.equal(await page.getByRole('button', { name: '放大图表', exact: true }).count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.desktopMinimized = '0'; window.dispatchEvent(new Event('canvasdesktop:visibility')); });
    await page.getByRole('button', { name: '放大图表', exact: true }).waitFor();
    report.checks.push('native minimize defers first load, releases controls and resumes');

    for (const asset of ['note-mermaid.js', 'vendor/pele/pele.global.js']) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      page = await fresh(false, {}, async ctx => ctx.route('**/assets/' + asset, async route => { await gate; await route.continue().catch(() => {}); }));
      const pending = page.waitForRequest('**/assets/' + asset);
      await set(page, one, 'live'); await pending; await set(page, '新的正文', 'live'); release(); await pause(200);
      assert.equal(await page.locator('.is-mermaid, #reading svg').count(), 0);
      assert.equal(await page.evaluate(() => testEditor.snapshot().value), '新的正文');
    }
    report.checks.push('late adapter/engine response cannot update a replacement document');

    for (const lifecycle of ['composition', 'pagehide']) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      page = await fresh(false, {}, async ctx => ctx.route('**/assets/vendor/pele/pele.global.js', async route => { await gate; await route.continue().catch(() => {}); }));
      const pending = page.waitForRequest('**/assets/vendor/pele/pele.global.js');
      await set(page, one, 'live'); await pending;
      await page.evaluate(lifecycle => {
        if (lifecycle === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        else testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      }, lifecycle);
      release(); await pause(180);
      assert.equal(await page.locator('.is-mermaid svg').count(), 0, lifecycle + ': late resources do not draw');
      await page.evaluate(lifecycle => {
        if (lifecycle === 'pagehide') window.dispatchEvent(new Event('pageshow'));
        else testEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      }, lifecycle);
      await page.locator('.is-mermaid svg').waitFor();
      assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    }
    report.checks.push('engine completion during IME/pagehide waits for a valid lifecycle');

    await page.evaluate(() => {
      const render = pele.render;
      window.pele = { ...pele, render(...args) {
        const result = render(...args);
        result.svg = result.svg.replace('</svg>', '<script>window.__unsafeDiagram=1</script><foreignObject><div>unsafe</div></foreignObject><image href="https://invalid.example/diagram.png"/><a href="javascript:alert(1)"><text>label</text></a><style>@import "https://invalid.example/style.css";</style><g onload="window.__unsafeDiagram=2" style="fill:url(https://invalid.example/pattern)"></g></svg>');
        return result;
      } };
    });
    await set(page, one, 'reading'); await page.locator('#reading .note-mermaid-stage > svg').waitFor();
    assert.equal(await page.locator('#reading script,#reading foreignObject,#reading image,#reading [onload],#reading a[href]').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafeDiagram), undefined);
    report.checks.push('SVG output boundary removes executable markup and external resource references');

    for (const [width, scale, motion] of [[420, 1, 'no-preference'], [760, 2, 'reduce'], [1440, 2, 'no-preference']]) {
      page = await fresh(false, { viewport: { width, height: 900 }, deviceScaleFactor: scale, reducedMotion: motion }, async ctx => ctx.addInitScript(() => { window.RelatumI18n = { language: 'en' }; }));
      await set(page, all, 'reading'); await visit(page, 8);
      assert(await page.locator('#reading').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'reading area fits ' + width);
      await set(page, wide, 'reading'); await page.getByRole('button', { name: 'Zoom in', exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, 'reading-' + width + '-dpr' + scale + '.png') });
      const before = await page.locator('#reading .note-mermaid-stage').innerHTML();
      await page.evaluate(() => { document.getElementById('reading').hidden = true; });
      await pause(50); assert.equal(await page.getByRole('button', { name: 'Zoom in', exact: true }).count(), 0);
      await page.evaluate(() => { document.getElementById('reading').hidden = false; });
      await page.getByRole('button', { name: 'Zoom in', exact: true }).waitFor();
      assert(before.includes('<svg'));
    }
    report.checks.push('narrow/wide, DPR 1/2, reduced motion, English controls and hidden-host resume');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('note Mermaid browser: ok; ' + output);
  } catch (error) {
    const failedPage = context?.pages()[0];
    if (failedPage) {
      await failedPage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      fs.writeFileSync(path.join(output, 'failure.html'), await failedPage.content());
    }
    console.error('Mermaid failure artifacts: ' + output); throw error;
  } finally { await context?.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

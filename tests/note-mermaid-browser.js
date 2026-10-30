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
body{display:block}main{width:100%;height:100vh;box-sizing:border-box;padding:12px 24px;max-width:960px;margin:auto}
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
    await context.addInitScript(() => {
      window.__diagramMetrics = { parses: 0, renders: 0, created: 0, terminated: 0, requests: [] };
      const Native = Worker;
      window.Worker = class extends Native {
        constructor(...args) {
          super(...args); __diagramMetrics.created++; this.__ended = false;
          this.addEventListener('message', event => {
            if (event.data.probe === 'parse') __diagramMetrics.parses++;
            if (event.data.probe === 'render') __diagramMetrics.renders++;
          });
        }
        postMessage(data, ...rest) { __diagramMetrics.requests.push({ source: data.source, version: data.version }); return super.postMessage(data, ...rest); }
        terminate() { if (!this.__ended) { this.__ended = true; __diagramMetrics.terminated++; } return super.terminate(); }
      };
    });
    await context.route('**/assets/note-mermaid.js', route => route.fulfill({ contentType: 'text/javascript', body:
      fs.readFileSync(path.join(repo, 'assets/note-mermaid.js'), 'utf8').replace('  window.RelatumNoteMermaid =',
        '  window.__diagramCache=()=>({items:cache.size,bytes:cacheBytes});\n  window.RelatumNoteMermaid =') }));
    await context.route('**/note-mermaid-worker.js', route => route.fulfill({ contentType: 'text/javascript', body:
      fs.readFileSync(path.join(repo, 'assets/note-mermaid-worker.js'), 'utf8').replace("importScripts('vendor/pele/pele.global.js');", `importScripts('vendor/pele/pele.global.js');
      const original = pele; pele = { ...original,
        parse(...args) { self.postMessage({probe:'parse'}); return original.parse(...args); },
        render(...args) { self.postMessage({probe:'render'}); return original.render(...args); } };`) }));
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
    assert.equal(await page.evaluate(() => typeof window.pele), 'undefined', 'the main thread does not load a second full engine');
    assert.equal(await page.locator('.cm-line.note-live-code-line').count(), 0, 'projected fences have no residual code stripe');
    assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    assert.equal(requests.filter(url => url.includes('vendor/pele/pele.global.js')).length, 1);
    assert(!requests.some(url => url.includes('vendor/mermaid/')));
    await page.locator('.is-mermaid svg').dblclick();
    await page.locator('.note-live-mermaid-preview svg').waitFor();
    assert(await page.locator('.cm-line').filter({ hasText: 'flowchart' }).count(), 'click exposes source with a preview below');
    assert.equal(await page.locator('.cm-line.note-live-code-line').filter({ hasText: '' }).evaluateAll(nodes => nodes.filter(node => !node.textContent.trim()).length), 0,
      'only real source lines receive a code background');
    await page.evaluate(() => { const v = testEditor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.locator('.is-mermaid svg').waitFor();
    await page.evaluate(() => { const v = testEditor.view, at = v.state.doc.toString().indexOf('中文开始'); v.dispatch({ changes: { from: at, to: at + 4, insert: '新的开始' }, selection: { anchor: v.state.doc.length } }); });
    await page.waitForFunction(() => document.querySelector('.is-mermaid svg')?.textContent.includes('新的开始'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => testEditor.snapshot().value.includes('中文开始'));
    assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => document.querySelector('.is-mermaid svg')?.textContent.includes('新的开始'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('.is-mermaid svg')?.textContent.includes('中文开始'));
    report.checks.push('lazy loading, live editing, undo and source integrity');

    // Source remains editable while a stable widget displays the last good SVG.
    await page.locator('.is-mermaid svg').dblclick();
    await page.locator('.note-live-mermaid-preview svg').waitFor();
    await page.waitForFunction(() => testEditor.view.state.doc.lineAt(testEditor.view.state.selection.main.head).text.startsWith('flowchart'));
    await page.evaluate(() => {
      window.__previewDOM = document.querySelector('.note-live-mermaid-preview');
      window.__editSVG = __previewDOM.querySelector('svg');
      const v = testEditor.view, source = v.state.doc.toString(), from = source.indexOf('flowchart'), to = source.lastIndexOf('```');
      v.dispatch({ changes: { from, to, insert: 'flowchart TD\n A[\n' }, selection: { anchor: from + 16 } });
    });
    await page.locator('.note-live-mermaid-preview .note-mermaid-status').waitFor();
    assert.deepEqual(await page.evaluate(() => ({ dom: __previewDOM === document.querySelector('.note-live-mermaid-preview'),
      svg: __editSVG === document.querySelector('.note-live-mermaid-preview svg') })), { dom: true, svg: true });
    await page.evaluate(() => { const v = testEditor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
    await page.locator('.is-mermaid .note-mermaid-error').waitFor();
    await page.evaluate(() => { const v = testEditor.view, at = v.state.doc.toString().indexOf('flowchart'); v.dispatch({ selection: { anchor: at + 4 } }); v.focus(); });
    await page.locator('.note-live-mermaid-preview svg').waitFor();
    assert((await page.locator('.note-live-mermaid-preview svg').textContent()).includes('中文开始'), 're-entering an incomplete block retains its last successful diagram');
    await page.evaluate(() => {
      const v = testEditor.view, source = v.state.doc.toString(), from = source.indexOf('flowchart'), to = source.lastIndexOf('```');
      v.dispatch({ changes: { from, to, insert: 'flowchart TD\n A[暂存]-->B[结束]\n' }, selection: { anchor: from + 15 } });
    });
    await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('暂存'));
    const calls = await page.evaluate(() => __diagramMetrics.requests.length);
    for (let index = 0; index < 6; index++) {
      await page.evaluate(index => { const v = testEditor.view, at = v.state.doc.toString().indexOf('暂存');
        v.dispatch({ changes: { from: at + 2, to: at + 2 + (index ? 1 : 0), insert: String(index) }, selection: { anchor: at } }); }, index);
      await pause(12);
    }
    await page.waitForFunction(() => document.querySelector('.note-live-mermaid-preview svg')?.textContent.includes('暂存5'));
    assert.equal(await page.evaluate(() => __diagramMetrics.requests.length), calls + 1, 'rapid source changes coalesce into the latest request');
    const selection = await page.evaluate(() => testEditor.snapshot().head);
    await page.locator('.note-live-mermaid-preview svg').click();
    assert.equal(await page.evaluate(() => testEditor.snapshot().head), selection, 'clicking the editing preview retains the caret');
    await page.evaluate(() => { const v = testEditor.view, end = v.state.doc.toString().lastIndexOf('```'); v.dispatch({ changes: { from: end, to: end + 3 } }); });
    await pause(160); assert.equal(await page.locator('.note-live-mermaid-preview').count(), 0, 'removing the closing fence removes the editing preview');
    await set(page, fence('flowchart TD\n A[') + '\n\n尾文', 'live');
    await page.locator('.is-mermaid').dblclick();
    await page.locator('.note-live-mermaid-preview .note-mermaid-status').waitFor();
    assert.equal(await page.locator('.note-live-mermaid-preview svg').count(), 0, 'first-invalid input has no invented diagram');
    await set(page, one, 'live'); await page.locator('.is-mermaid svg').waitFor();
    const reused = await page.evaluate(() => ({ parses: __diagramMetrics.parses, renders: __diagramMetrics.renders }));
    for (let index = 0; index < 3; index++) {
      await page.locator('.is-mermaid svg').dblclick(); await page.locator('.note-live-mermaid-preview svg').waitFor();
      await page.evaluate(() => { const v = testEditor.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); });
      await page.waitForFunction(() => !document.querySelector('.note-live-mermaid-preview') && document.querySelector('.is-mermaid svg'));
    }
    assert.deepEqual(await page.evaluate(() => ({ parses: __diagramMetrics.parses, renders: __diagramMetrics.renders })), reused,
      'unchanged source/preview toggles reuse layout results');
    report.checks.push('source preview DOM reuse, last good SVG, error recovery, input coalescing, caret integrity and layout cache');

    await set(page, all, 'reading'); await visit(page, 8);
    assert.equal(await page.locator('#reading svg').count(), 8);
    const ids = await page.locator('#reading svg [id], #reading svg[id]').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(new Set(ids).size, ids.length, 'diagram IDs are unique');
    assert.equal(await page.locator('#reading script,#reading foreignObject,#reading image,#reading [onload]').count(), 0);
    await page.locator('#reading .mermaid-diagram').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'reading-light.png') });
    await page.evaluate(() => { document.body.dataset.startTheme = 'dark'; });
    await page.screenshot({ path: path.join(output, 'reading-dark.png') });
    const parses = await page.evaluate(() => __diagramMetrics.parses);
    await page.setViewportSize({ width: 760, height: 850 }); await pause(200);
    assert.equal(await page.evaluate(() => __diagramMetrics.parses), parses, 'width changes reuse parsed models');
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
    await page.locator('#reading').evaluate(el => { el.scrollTop = 0; });
    await page.getByRole('button', { name: '放大图表', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const camera = await page.locator('#reading .note-mermaid-stage > svg').getAttribute('viewBox');
    await page.locator('#reading').evaluate(el => { el.scrollTop = 1200; }); await pause(100);
    await page.locator('#reading').evaluate(el => { el.scrollTop = 0; });
    await page.getByRole('button', { name: '复位图表', exact: true }).waitFor();
    assert.equal(await page.locator('#reading .note-mermaid-stage > svg').getAttribute('viewBox'), camera, 'ordinary scrolling preserves the diagram camera');
    const beforeFont = await page.evaluate(() => ({ calls: __diagramMetrics.renders }));
    await page.evaluate(() => {
      window.__fontSvg = document.querySelector('#reading .note-mermaid-stage > svg');
      const unrelated = new FontFace('Fixture unrelated math font', 'local(serif)');
      document.fonts.dispatchEvent(new FontFaceSetLoadEvent('loadingdone', { fontfaces: [unrelated] }));
    });
    await pause(100);
    assert.equal(await page.evaluate(() => __diagramMetrics.renders), beforeFont.calls, 'unrelated math fonts do not invalidate Mermaid');
    assert(await page.evaluate(() => __fontSvg === document.querySelector('#reading .note-mermaid-stage > svg')));
    report.checks.push('eight diagram types, Chinese, unique IDs, themes, parse reuse, reading zoom and wheel');

    await set(page, '> [!note] 引用\n> ```mermaid\n> flowchart TD\n> A[中文] --> B[结束]\n> ```\n\n最后正文', 'live');
    await page.locator('.is-mermaid svg').waitFor();
    await page.locator('.is-mermaid svg').dblclick(); await page.locator('.note-live-mermaid-preview svg').waitFor();
    assert((await page.locator('.note-live-mermaid-preview svg').textContent()).includes('中文'), 'quoted source renders without quote prefixes');
    await set(page, fence('flowchart TD\n A['), 'reading'); await page.locator('.note-mermaid-error').waitFor();
    assert((await page.locator('.note-mermaid-error pre').textContent()).includes('A['));
    await set(page, fence('flowchart TD\n' + 'A'.repeat(65537)), 'reading'); await page.locator('.note-mermaid-error').waitFor();
    await set(page, '```mermaid\nflowchart TD\nA-->B', 'live'); await pause(80);
    assert.equal(await page.locator('.is-mermaid').count(), 0);
    for (const body of ['', 'flowchart TD\n' + 'A'.repeat(65537)]) {
      const source = fence(body) + '\n\n尾文';
      await set(page, source, 'live');
      await page.evaluate(() => { const v = testEditor.view, at = v.state.doc.toString().indexOf('\n') + 1;
        v.dispatch({ selection: { anchor: at } }); v.focus(); });
      await pause(160);
      assert.equal(await page.locator('.note-live-mermaid-preview').count(), 0, 'empty/over-limit fences have no editing preview');
      assert.equal(await page.evaluate(() => testEditor.snapshot().value), source);
    }
    report.checks.push('nested callout, syntax error, size guard, empty and incomplete fences');

    let releaseFont, blockedFont = false;
    const fontGate = new Promise(resolve => { releaseFont = resolve; });
    page = await fresh(false, {}, ctx => ctx.route('**/assets/fonts/open-sans-bolditalic.woff2', async route => {
      blockedFont = true; await fontGate; await route.continue();
    }));
    try {
      await page.evaluate(() => document.getElementById('editor').style.setProperty('--note-font-text', '"Relatum Open Sans", sans-serif'));
      await set(page, one, 'live'); await page.waitForFunction(() => __diagramMetrics.requests.length > 0 || document.querySelector('link[data-note-mermaid-asset]'));
      await pause(120); assert(blockedFont, 'local font loading is delayed by the fixture');
      assert.equal(await page.locator('.is-mermaid svg').count(), 0, 'initial rendering waits for the actual local fonts');
    } finally { releaseFont(); }
    await page.locator('.is-mermaid svg').waitFor();
    const beforeRelevantFont = await page.evaluate(() => ({ parses: __diagramMetrics.parses, renders: __diagramMetrics.renders }));
    await page.evaluate(() => document.fonts.dispatchEvent(new FontFaceSetLoadEvent('loadingdone', {
      fontfaces: [new FontFace('Relatum Open Sans', 'local(serif)')],
    })));
    await page.waitForFunction(count => __diagramMetrics.renders > count, beforeRelevantFont.renders);
    assert.equal(await page.evaluate(() => __diagramMetrics.parses), beforeRelevantFont.parses, 'relevant font invalidation reuses the parsed model');
    report.checks.push('late local fonts delay initial layout, relevant font changes reuse models');

    page = await fresh(true); const offStart = requests.length;
    await set(page, one, 'live'); await pause(100); assert.equal(await page.locator('.is-mermaid').count(), 0);
    await set(page, all, 'reading'); assert.equal(await page.locator('#reading pre.md-code').count(), 8); await pause(100);
    assert.equal(requests.slice(offStart).filter(url => /note-mermaid|vendor\/(?:pele|mermaid)/.test(url)).length, 0);
    report.checks.push('disabled feature retains ordinary editable/readable code without engine requests');

    for (const asset of ['note-mermaid.js', 'vendor/pele/pele.global.js']) {
      let allow = false;
      page = await fresh(false, {}, async ctx => ctx.route('**/assets/' + asset, route => allow ? route.continue() : route.abort()));
      await set(page, one, 'live'); await page.getByRole('button', { name: '重试', exact: true }).waitFor();
      allow = true;
      await page.getByRole('button', { name: '重试', exact: true }).click(); await page.locator('.is-mermaid svg').waitFor();
      assert.equal(await page.evaluate(() => testEditor.snapshot().value), one);
    }
    report.checks.push('adapter and engine load failure retry');

    for (const kind of ['missing', 'blocked']) {
      page = await fresh(false, {}, ctx => ctx.addInitScript(kind => {
        window.Worker = kind === 'missing' ? undefined : class { constructor() { throw new DOMException('Blocked in fixture', 'SecurityError'); } };
      }, kind));
      await set(page, one, 'live'); await page.locator('.is-mermaid svg').waitFor();
      assert.equal(await page.evaluate(() => typeof window.pele?.render), 'function', kind + ': synchronous compatibility path renders');
      await page.evaluate(() => { const p = pele; window.__fallbackParses = 0; window.pele = { ...p, parse(...args) { __fallbackParses++; return p.parse(...args); } }; });
      await page.setViewportSize({ width: 760, height: 850 }); await pause(150);
      assert.equal(await page.evaluate(() => __fallbackParses), 0, 'fallback width changes also reuse models');
    }
    report.checks.push('missing/blocked Worker fallback and parsed-model reuse');

    page = await fresh(false, { hasTouch: true }); await set(page, wide + '\n\n' + '正文\n\n'.repeat(100), 'reading');
    const viewport = page.locator('#reading .note-mermaid-stage > svg');
    await page.getByRole('button', { name: '放大图表', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const zoomed = await viewport.getAttribute('viewBox');
    await viewport.focus(); await page.keyboard.press('ArrowRight'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.notEqual(await viewport.getAttribute('viewBox'), zoomed, 'keyboard pans the zoomed diagram');
    const box = await viewport.boundingBox(), beforeDrag = await viewport.getAttribute('viewBox');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    assert.notEqual(await viewport.getAttribute('viewBox'), beforeDrag, 'pointer drag commits its final camera');
    const cdp = await context.newCDPSession(page), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 25, y, id: 1 }, { x: x + 25, y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 50, y, id: 1 }, { x: x + 50, y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert(parseFloat((await viewport.getAttribute('viewBox')).split(' ')[2]) < parseFloat(beforeDrag.split(' ')[2]), 'two-finger pinch increases scale');
    await viewport.focus(); await page.keyboard.press('0'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.getByRole('button', { name: '复位图表', exact: true }).count(), 0);
    report.checks.push('keyboard zoom/pan/reset, pointer drag and native touch pinch');

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

    page = await fresh(false, {}, ctx => ctx.route('**/note-mermaid-worker.js', route => route.fulfill({ contentType: 'text/javascript', body:
      fs.readFileSync(path.join(repo, 'assets/note-mermaid-worker.js'), 'utf8').replace("importScripts('vendor/pele/pele.global.js');", `importScripts('vendor/pele/pele.global.js');
      const original = pele; pele = { ...original, render(...args) { const result = original.render(...args);
      result.svg = result.svg.replace('</svg>', '<script>window.__unsafeDiagram=1</script><foreignObject><div>unsafe</div></foreignObject><image href="https://invalid.example/diagram.png"/><a href="javascript:alert(1)"><text>label</text></a><style>@import "https://invalid.example/style.css";</style><g onload="window.__unsafeDiagram=2" style="fill:url(https://invalid.example/pattern)"></g></svg>'); return result; } };`) })));
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

    page = await fresh(); await set(page, one, 'reading'); await page.locator('#reading .note-mermaid-stage > svg').waitFor();
    for (let index = 0; index < 36; index++) {
      await page.evaluate(index => document.querySelector('#reading .note-reading-content').__noteMermaid.update('flowchart TD\nA[缓存图' + index + ']-->B', 'mermaid'), index);
      await page.waitForFunction(index => document.querySelector('#reading .note-mermaid-stage > svg')?.textContent.includes('缓存图' + index), index);
    }
    assert.equal((await page.evaluate(() => __diagramCache())).items, 32);
    for (let index = 0; index < 3; index++) {
      const body = 'flowchart LR\nA0[预算图' + index + ']\n' + Array.from({ length: 500 }, (_, i) =>
        Array.from({ length: Math.min(8, 499 - i) }, (_, k) => `A${i}-->A${i + k + 1}`).join('\n')).join('\n');
      await page.evaluate(body => document.querySelector('#reading .note-reading-content').__noteMermaid.update(body, 'mermaid'), body);
      await page.waitForFunction(index => document.querySelector('#reading .note-mermaid-stage > svg')?.textContent.includes('预算图' + index), index);
      assert((await page.evaluate(() => __diagramCache())).bytes <= 8 * 1024 * 1024);
    }
    assert((await page.evaluate(() => __diagramCache())).items <= 2, 'large layouts evict earlier SVG strings by bytes');
    await page.evaluate(() => RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading')));
    await pause(50); assert.equal(page.workers().length, 0);
    report.checks.push('main-thread cache item/byte eviction and last-owner worker teardown');
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

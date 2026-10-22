'use strict';
// Local assets, synthetic Markdown, disposable browser profile and reports.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const baselineRef = process.env.RELATUM_NOTE_TYPOGRAPHY_BASELINE || '2a1b4c8';
const themeRoot = path.join(process.env.RELATUM_TYPORA_HOME || 'D:/Typora', 'resources/style/themes');
const referenceAvailable = fs.existsSync(path.join(themeRoot, 'github.css'));
const output = process.env.RELATUM_NOTE_TYPOGRAPHY_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-typography-'));
fs.mkdirSync(output, { recursive: true });
const source = [
  '# Markdown 渲染器综合测试', '', '> Markdown Rendering Test', '>', '> 测试标准 Markdown、GFM 与嵌套结构。', '',
  '## 1. 标题与文本', '', '### 三级标题 Heading 3', '', '#### 四级标题 Heading 4', '',
  '这是一段普通正文 Typography 123，用于观察字体、字号和行间距。', '',
  '**这是粗体文本**', '', '*这是斜体文本 italic*', '', '<u>下划线</u> x<sup>2</sup> H<sub>2</sub>O <kbd>Ctrl</kbd><br>显式换行', '',
  '## 2. 列表与链接', '', '- [x] 完成 Markdown 基础渲染', '- [ ] 支持紧凑编辑', '- [ ] 保留 Relatum 专属功能', '',
  'https://example.com/path_(a)。www.example.com，name@example.com。', '', '[参考网站][site]', '',
  '## 3. 嵌套引用', '', '> 一级引用', '>', '> > 二级引用', '> >', '> > > 三级引用', '',
  '## 4. 目录与脚注', '', '[TOC]', '', '正文引用[^first]，另一条[^second]，再次引用[^first]。', '',
  '[site]: https://example.com/ref "参考标题"', '', '[^first]: 第一条 **注释**', '    续行说明', '', '[^second]: 第二条注释', '',
  '> [!tip] Relatum 提示', '> 保留原有 Callout。', '',
  '| 单元格 | 内容 |', '| --- | --- |', '| A | **粗体** |', '', '最后一段用于光标落点与中文输入。',
].join('\n');
const baseline = new Map(['styles.css', 'markdown.js', 'note-live-editor.js'].map(name => [name,
  execFileSync('git', ['show', `${baselineRef}:assets/${name}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })]));
const sandbox = { window: {}, console }; vm.createContext(sandbox);
for (const name of ['markdown-table.js', 'markdown.js']) vm.runInContext(fs.readFileSync(path.join(repo, 'assets', name), 'utf8'), sandbox);
const rendered = sandbox.window.MarkdownMini.renderResult(source, { noteSyntax: true, noteBlocks: true }).html;
const html = old => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/${old ? 'old-assets' : 'assets'}/">
<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}.note-document-body{--note-inline-title-space:24px}</style></head>
<body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main>
${['markdown-table.js','markdown.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-media-frame.js','note-live-editor.js'].map(name => `<script src="${name}"></script>`).join('')}
<script>window.opened=[];window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(source)},notePath:'sample.md',onOpenExternal:target=>opened.push(target)});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/' || pathname === '/before') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html(pathname === '/before')); return; }
    if (pathname === '/reference') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/reference-style/github.css"><style>body{margin:0}#write{box-sizing:border-box}</style></head><body><main id="write">' + rendered + '</main></body></html>'); return;
    }
    const reference = pathname.startsWith('/reference-style/');
    const prefix = reference ? '/reference-style/' : pathname.startsWith('/old-assets/') ? '/old-assets/' : '/assets/';
    if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const root = reference ? themeRoot : path.join(repo, 'assets');
    const name = pathname.slice(prefix.length), file = path.resolve(root, name);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
    res.end(prefix === '/old-assets/' && baseline.has(name) ? baseline.get(name) : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const report = { output, baselineRef, referenceAvailable, checks: [], metrics: [] };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (process.argv.includes('--performance-only')) {
      for (let round = 0; round < 3; round++) for (const variant of round % 2 ? ['current','baseline'] : ['baseline','current']) {
        await page.goto(base + (variant === 'baseline' ? '/before' : '/'));
        await page.evaluate(() => document.fonts.ready);
        const loadMs = await page.evaluate(() => {
          const line = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '.repeat(2) + '\n\n';
          const value = line.repeat(Math.ceil(4 * 1024 * 1024 / line.length)).slice(0, 4 * 1024 * 1024);
          const start = performance.now(); editor.setDocument({value,notePath:'long.md',anchor:0,head:0}); return performance.now()-start;
        });
        await settle();
        const samples = await page.evaluate(() => {
          const samples=[];
          for (let index=0;index<35;index++) { const start=performance.now(); editor.replaceSelection('x'); if(index>=5)samples.push(performance.now()-start); }
          return samples;
        });
        const ordered=samples.slice().sort((a,b)=>a-b);
        report.metrics.push({variant,round,bytes:4*1024*1024,loadMs,medianMs:ordered[15],p95Ms:ordered[28],samples});
      }
      const middle=values=>values.sort((a,b)=>a-b)[1];
      for(const name of ['medianMs','p95Ms']) {
        const before=middle(report.metrics.filter(item=>item.variant==='baseline').map(item=>item[name]));
        const after=middle(report.metrics.filter(item=>item.variant==='current').map(item=>item[name]));
        assert(after<=Math.max(before*1.1,before+2), '4 MiB input must stay within same-host tolerance');
      }
      report.checks.push('three alternating rounds, 4 MiB source, 30 measured dispatches, median and p95 tolerance');
      assert.deepEqual(errors,[]); console.log(JSON.stringify(report)); return;
    }
    for (const route of ['/before', ...(referenceAvailable ? ['/reference'] : []), '/']) {
      await page.goto(base + route); await page.evaluate(() => document.fonts.ready); await settle();
      await page.screenshot({ path: path.join(output, route === '/' ? 'after-light.png' : route === '/before' ? 'before-light.png' : 'reference-theme.png') });
    }
    const metrics = await page.evaluate(() => {
      const el = Array.from(editor.view.contentDOM.querySelectorAll('.cm-line')).find(el => el.textContent.includes('Typography 123'));
      el.dataset.fontProbe = 'true';
      const style = getComputedStyle(el);
      return { font: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight,
        h1: getComputedStyle(document.querySelector('.note-live-h1')).fontSize,
        quoteDepths: Array.from(document.querySelectorAll('.note-live-quote-line'), el => getComputedStyle(el).getPropertyValue('--note-quote-depth').trim()),
        gapHeight: document.querySelector('.note-live-paragraph-gap').getBoundingClientRect().height,
        toc: !!document.querySelector('.note-live-toc'), source: editor.snapshot().value };
    });
    assert.equal(metrics.source, source); delete metrics.source;
    assert.equal(metrics.size, '16px'); assert.equal(metrics.lineHeight, '25.6px'); assert.equal(metrics.h1, '36px');
    assert(metrics.quoteDepths.includes('3')); assert(metrics.gapHeight > 0 && metrics.gapHeight < 20);
    const cdp = await page.context().newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-font-probe]' });
    metrics.fonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    assert(metrics.fonts.some(font => font.familyName.includes('Open Sans')));
    report.metrics.push(metrics); report.checks.push('font, heading, compact gaps, three-level quote');
    await page.evaluate(() => { const pos = sourcePosition('https://example.com/path'); function sourcePosition(s) { return editor.snapshot().value.indexOf(s); } editor.view.dispatch({ effects: RelatumCodeMirror.EditorView.scrollIntoView(pos, { y: 'center' }) }); });
    await settle();
    const urlPoint = await page.evaluate(() => {
      const pos = editor.snapshot().value.indexOf('https://example.com/path') + 8;
      const box = editor.view.coordsAtPos(pos); return { x: box.left + 2, y: (box.top + box.bottom) / 2 };
    });
    await page.mouse.click(urlPoint.x, urlPoint.y); assert.equal(await page.evaluate(() => opened.length), 0);
    await page.keyboard.down('Control'); await page.mouse.click(urlPoint.x, urlPoint.y); await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => opened[0]), 'https://example.com/path_(a)');
    report.checks.push('ordinary click edits; Ctrl click opens balanced automatic URL');
    await page.evaluate(() => { const value = editor.snapshot().value, pos = value.indexOf('[TOC]'); editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(value.length), effects: RelatumCodeMirror.EditorView.scrollIntoView(pos, { y: 'center' }) }); editor.view.contentDOM.blur(); });
    await settle(); assert(await page.locator('.note-live-toc').count());
    await page.locator('.note-live-toc a').first().click();
    assert.equal(await page.evaluate(() => editor.view.state.selection.main.head), 0);
    report.checks.push('TOC uses Markdown heading positions');
    await page.evaluate(() => { editor.setSourceMode(true); }); await settle();
    assert.equal(await page.locator('.note-live-toc').count(), 0);
    assert.equal(await page.evaluate(() => editor.snapshot().value), source);
    await page.evaluate(() => { editor.setSourceMode(false); }); await settle();
    const caret = await page.evaluate(() => {
      const pos = editor.snapshot().value.indexOf('最后一段') + 4;
      editor.view.dispatch({ selection: RelatumCodeMirror.EditorSelection.cursor(pos), effects: RelatumCodeMirror.EditorView.scrollIntoView(pos, { y: 'center' }) }); editor.focus(); return pos;
    });
    await settle();
    await cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '汉' }); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), source.slice(0, caret) + '汉' + source.slice(caret));
    await page.keyboard.press('Control+z'); await settle();
    assert.equal(await page.evaluate(() => editor.snapshot().value), source);
    report.checks.push('source/live round trip and native Chromium composition, one undo');
    await page.evaluate(source => { const host = document.createElement('div'); host.id='reading'; document.body.appendChild(host); RelatumNoteLiveEditor.renderMarkdown(host, source, 'sample.md'); }, source);
    assert.equal(await page.locator('#reading .note-footnote').count(), 2);
    assert.equal(await page.locator('#reading .note-toc').count(), 1);
    assert.equal(await page.locator('#reading u').textContent(), '下划线');
    const projected='![很长的画布文件名.canvas|640x360](canvases/very-long-filename.canvas)\n\n[TOC]\n\n## Canvas after heading\n\n正文[^x]\n\n[^x]: 定义';
    const positions=await page.evaluate(value=>{
      const host=document.createElement('div'); document.body.appendChild(host);
      RelatumNoteLiveEditor.renderMarkdown(host,value,'sample.md');
      const result={toc:Number(host.querySelector('.note-toc a').dataset.noteJump),definition:Number(host.querySelector('.note-footnote').dataset.noteDefinitionFrom),
        ref:Number(host.querySelector('.note-footnote-ref a').dataset.noteJump),back:Number(host.querySelector('.note-footnote-returns a').dataset.noteJump)};
      RelatumNoteLiveEditor.releaseReadingDocument(host);host.remove();return result;
    },projected);
    assert.equal(positions.toc,projected.indexOf('## Canvas'));
    assert.equal(positions.definition,projected.indexOf('[^x]:'));
    assert.equal(positions.ref,positions.definition);assert.equal(positions.back,projected.indexOf('[^x]'));
    report.checks.push('reading shares semantic HTML, footnotes and TOC');
    report.checks.push('reading jumps retain original source offsets after embedded canvas projection');
    await page.evaluate(() => document.getElementById('reading').remove());
    await page.evaluate(()=>editor.setDocument({value:'> 外层\n>\n> > ```js\n> > const n = 1;\n> > if (n > 0) done();\n> > ```\n\n之后',notePath:'quote-code.md',anchor:100,head:100})); await settle();
    const quoteCode=await page.evaluate(()=>Array.from(document.querySelectorAll('.note-live-code-line'),el=>({text:el.textContent,padding:parseFloat(getComputedStyle(el).paddingLeft)})));
    assert(quoteCode.some(line=>line.text.includes('const n')));
    assert(quoteCode.every(line=>!/^\s*>/.test(line.text)),'quoted code prefixes must stay structural');
    assert(quoteCode.every(line=>line.padding>=40),'nested code must retain quote indentation');
    report.checks.push('nested quote code preserves source operators and indentation');
    const tableSource='😀 正文\n\n| Keep | Links |\n| --- | --- |\n| unchanged | [标题][ref] [^n] |\n\n[ref]: https://first.example/\n\n[^n]: 注释定义';
    await page.evaluate(value=>editor.setDocument({value,notePath:'references.md',anchor:0,head:0}),tableSource); await settle();
    assert.equal(await page.locator('.note-table-cell-content [data-href]').getAttribute('data-href'),'https://first.example/');
    await page.evaluate(()=>{ window.stableCell=document.querySelector('td[data-table-row="1"][data-table-col="0"] .note-table-cell-content').firstChild; const value=editor.snapshot().value, from=value.indexOf('https://first.example/'); editor.view.dispatch({changes:{from,to:from+'https://first.example/'.length,insert:'https://second.example/'},userEvent:'input'}); }); await settle();
    assert.equal(await page.locator('.note-table-cell-content [data-href]').getAttribute('data-href'),'https://second.example/');
    assert(await page.evaluate(()=>stableCell===document.querySelector('td[data-table-row="1"][data-table-col="0"] .note-table-cell-content').firstChild));
    await page.locator('.note-table-cell-content .note-footnote-ref a').click(); await settle();
    assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),tableSource.replace('first','second').indexOf('注释定义'));
    assert.equal(await page.locator('.note-table-cell-content .note-footnotes').count(),0);
    report.checks.push('table reference definitions refresh dependent fragments; UTF-16 footnote jump; unrelated cell reuse');
    await page.evaluate(value=>{editor.setDocument({value,notePath:'sample.md',anchor:value.length,head:value.length});editor.view.contentDOM.blur();},source);
    for (const variant of [{ width: 1280, scale: 1.25, theme: 'light' }, { width: 1280, scale: 1.5, theme: 'dark' }, { width: 620, scale: 2, theme: 'dark' }]) {
      await page.setViewportSize({ width: variant.width, height: 960 });
      await page.evaluate(variant => { document.body.dataset.startTheme=variant.theme; document.documentElement.style.setProperty('--note-font-scale',variant.scale); editor.view.dispatch({ effects: RelatumCodeMirror.EditorView.scrollIntoView(0,{y:'start'}) }); }, variant);
      await settle(); await page.screenshot({ path: path.join(output, `after-${variant.theme}-${variant.width}-${variant.scale}.png`) });
      assert.equal(await page.evaluate(() => editor.snapshot().value), source);
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => editor.view.dom.parentElement.dataset.livePreviewError || ''), '');
    report.checks.push('light/dark, 100/125/150/200 percent, narrow viewport, unchanged source');
    console.log(JSON.stringify(report));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

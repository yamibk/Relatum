'use strict';
// Only synthetic documents, an asset-only server and a disposable browser profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-cards-'));
const body = '### [zap] 提高供电效率\n减少**转换损耗**，优化电力分配。\n\n---\n\n### [shield] 提升可靠性\n- 降低风险\n- 持续运行\n\n---\n\n### 学习资料\n[参考资料](https://example.com) 与 `code`';
const fence = '```cards\n' + body + '\n```', source = 'before\n\n' + fence + '\n\nafter';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="note-theme.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}#reading,#guide{height:100vh;overflow:auto;padding:32px;box-sizing:border-box}[hidden]{display:none!important}</style></head>
<body class="start-page" data-start-theme="light" data-start-workspace="notes"><main class="note-workspace note-document-pane"><div class="note-document-body"><div id="editor" class="note-live-editor-host"></div></div><div id="reading" hidden></div><div id="guide" hidden></div></main>
<script>window.RelatumFeatureRuntime={enabled:key=>key!=='notes.mermaid'&&key!=='notes.canvas'&&key!=='notes.quiz'};</script>
${['markdown.js','markdown-table.js','vendor/codemirror/relatum-codemirror.min.js','note-table-editor.js','note-cards.js','note-live-editor.js','note-guide.js'].map(name => '<script src="' + name + '"></script>').join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'',notePath:'cards.md',onOpenExternal:target=>window.opened=target});</script></body></html>`;
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors = [], requests = [], matrix = []; page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.stack)); page.on('request', req => requests.push(req.url()));
    await page.goto(origin); await page.waitForFunction(() => !!window.editor);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const value = () => page.evaluate(() => editor.snapshot().value);
    const group = () => page.locator('#editor .note-cards-block').first();
    const preview = () => page.locator('#editor .note-live-cards-preview');
    async function reset(text = source) {
      await page.evaluate(text => { document.getElementById('editor').hidden=false; document.getElementById('reading').hidden=true; document.getElementById('guide').hidden=true; window.cardsGuide?.suspend(); editor.setSourceMode(false); editor.setDocument({value:text,notePath:'cards.md',head:text.length,anchor:text.length,scrollTop:0}); editor.focus(); }, text);
      await settle();
    }
    await reset(); await group().waitFor();
    for (const skin of ['default','claude','sky','apple']) for (const theme of ['light','dark']) for (const width of [1500,700]) for (const scale of [1,1.35]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(([skin,theme,scale]) => {document.documentElement.dataset.noteTheme=skin;document.body.dataset.startTheme=theme;document.body.style.setProperty('--note-font-scale',scale);}, [skin,theme,scale]);
      await reset(); await group().waitFor(); await settle();
      const layout = await group().evaluate(root => { const g=root.querySelector('.note-cards'), c=[...root.querySelectorAll('.note-card')].map(n=>n.getBoundingClientRect()); return {width:g.getBoundingClientRect().width,columns:getComputedStyle(g.firstElementChild).gridTemplateColumns.split(' ').length,first:c[0].height,second:c[1].height,odd:c[2].width,card:c[0].width}; });
      assert.equal(layout.columns, layout.width>=560?2:1); if(layout.columns===2) {assert(Math.abs(layout.first-layout.second)<1);assert(Math.abs(layout.odd-layout.card)<1);}
      const left = await page.evaluate(()=>[document.querySelector('.note-cards').getBoundingClientRect().left,[...document.querySelectorAll('#editor .cm-line')].find(n=>n.textContent==='before').getBoundingClientRect().left]); assert(Math.abs(left[0]-left[1])<1,'cards align with the note text');
      assert.equal(await page.locator('#editor .note-live-code-language,#editor .note-live-code-line').count(),0);
      await page.locator('#editor .cm-line').filter({hasText:/^after$/}).click();
      assert.equal(await page.evaluate(()=>editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text),'after');
      await group().locator('.note-card-title').first().click(); await page.keyboard.press('Enter'); await preview().waitFor();
      await page.keyboard.press('Escape'); await group().waitFor(); assert.equal(await value(),source);
      matrix.push({skin,theme,width,scale,...layout});
    }
    await page.setViewportSize({width:1500,height:1000}); await page.evaluate(()=>{document.documentElement.dataset.noteTheme='default';document.body.dataset.startTheme='light';document.body.style.setProperty('--note-font-scale',1);}); await reset();
    await page.setViewportSize({width:700,height:1000});await settle();await page.locator('.cm-line').filter({hasText:/^after$/}).click();assert.equal(await page.evaluate(()=>editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text),'after');await page.setViewportSize({width:1500,height:1000});await settle();
    await group().locator('a').click(); assert.equal(await page.evaluate(()=>window.opened),'https://example.com');
    await group().locator('.note-card-title').first().click();
    await page.evaluate(()=>window.selectedDOM=document.querySelector('.note-cards-block .note-cards'));
    await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),fence);
    await group().locator('.note-card-title').first().click(); assert(await page.evaluate(()=>selectedDOM===document.querySelector('.note-cards-block .note-cards')));
    await page.keyboard.press('Control+x');assert.equal(await value(),'before\n\n\n\nafter');await page.keyboard.press('Control+z');await group().waitFor();assert.equal(await value(),source);await group().locator('.note-card-title').first().click();
    await page.keyboard.press('Backspace'); assert.equal(await page.locator('.note-cards-block').count(),0); await page.keyboard.press('Control+z'); await group().waitFor(); assert.equal(await value(),source);
    await group().locator('.note-card-title').first().dblclick(); await preview().waitFor();
    const cdp=await context.newCDPSession(page);
    await page.evaluate(()=>{const v=editor.view,at=v.state.doc.toString().indexOf('减少');v.dispatch({selection:{anchor:at}});v.focus();});
    await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5}); assert.equal(await value(),source,'preedit is not saved');
    await cdp.send('Input.insertText',{text:'中文'}); await page.waitForFunction(()=>document.querySelector('.note-live-cards-preview')?.textContent.includes('中文减少'));
    await page.keyboard.press('Escape'); await group().waitFor(); const edited=source.replace('减少','中文减少'); assert.equal(await value(),edited);
    await page.keyboard.press('Control+z'); assert.equal(await value(),source); if(await preview().count()) await page.keyboard.press('Escape'); await group().waitFor();
    await page.evaluate(()=>editor.setSourceMode(true)); assert.equal(await page.locator('.note-cards-block').count(),0);
    await page.evaluate(()=>editor.setSourceMode(false)); await group().waitFor();
    await page.evaluate(()=>editor.revealPosition(editor.view.state.doc.toString().indexOf('降低风险'),{end:editor.view.state.doc.toString().indexOf('降低风险')+4,unfold:true})); await preview().waitFor();
    await reset();
    for(const invalid of ['```cards\n### a','```cards\nmissing\n```','```cards\n\n```']){await reset(invalid);assert.equal(await page.locator('.note-cards-block').count(),0);assert.equal(await value(),invalid);}
    for(const blanks of [0,1,2]){await reset('before\n'+ '\n'.repeat(blanks)+fence+'\n'+'\n'.repeat(blanks)+'after');await group().waitFor();await page.locator('.cm-line').filter({hasText:/^after$/}).click();assert.equal(await page.evaluate(()=>editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text),'after');}
    await reset(source);
    await page.evaluate(text=>{document.getElementById('editor').hidden=true;const root=document.getElementById('reading');root.hidden=false;RelatumNoteLiveEditor.renderMarkdown(root,text,'cards.md',{});}, source);
    assert.equal(await page.locator('#reading .note-card').count(),3);
    await page.evaluate(()=>{RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading'));document.getElementById('reading').hidden=true;const host=document.getElementById('guide');host.hidden=false;window.cardsGuide=RelatumNoteGuide.create({host,language:()=> 'zh',isCurrent:()=>!host.hidden,renderFence:RelatumNoteLiveEditor.renderFence,attachCards:RelatumNoteLiveEditor.attachCards});cardsGuide.show('cards');});
    await page.locator('#guide .note-cards').first().waitFor(); await page.locator('#guide mjx-container').first().waitFor();
    await page.locator('#guide .note-guide-copy').first().click(); assert((await page.evaluate(()=>navigator.clipboard.readText())).startsWith('```cards'));
    await reset(source.replace('减少**转换损耗**','公式 $I=U/R$ 与**转换损耗**')); await group().locator('mjx-container').waitFor();
    await page.evaluate(()=>document.querySelector('.note-workspace').style.width='700px');await settle();await page.locator('.cm-line').filter({hasText:/^after$/}).click();assert.equal(await page.evaluate(()=>editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text),'after');await page.evaluate(()=>document.querySelector('.note-workspace').style.width='');await settle();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(output,'cards-light.png')});
    await page.evaluate(()=>document.body.dataset.startTheme='dark');await settle();await page.screenshot({path:path.join(output,'cards-dark.png')});await page.evaluate(()=>document.body.dataset.startTheme='light');
    const mathSource=await value();await page.evaluate(text=>{editor.setDocument({value:text,notePath:'reopened.md',head:text.length,anchor:text.length});},mathSource);await group().waitFor();assert.equal(await value(),mathSource);
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='1';window.dispatchEvent(new Event('canvasdesktop:visibility'));});await reset(mathSource);await settle();assert.equal(await group().locator('mjx-container').count(),0);await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='0';window.dispatchEvent(new Event('canvasdesktop:visibility'));});await group().locator('mjx-container').waitFor();
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await reset(mathSource);await settle();assert.equal(await group().locator('mjx-container').count(),0);await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await group().locator('mjx-container').waitFor();
    await page.evaluate(text=>{document.getElementById('editor').hidden=true;const root=document.getElementById('reading');root.hidden=false;RelatumNoteLiveEditor.renderMarkdown(root,'> [!white]- 折叠卡片\n>\n'+text.split('\n').map(line=>'> '+line).join('\n'),'folded.md',{});},fence.replace('减少','公式 $x$ 减少'));await settle();assert.equal(await page.locator('#reading mjx-container').count(),0);await page.locator('#reading .note-callout-fold').click();await page.locator('#reading .note-cards mjx-container').waitFor();await page.evaluate(()=>RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading')));
    await reset(source);await page.evaluate(()=>{window.lateResolve=null;window.MathJax={typesetPromise:()=>new Promise(resolve=>window.lateResolve=resolve),typesetClear:()=>{}};});
    await reset(source.replace('减少','公式 $x$ 减少'));await page.waitForFunction(()=>!!window.lateResolve);await reset('new document');await page.evaluate(()=>lateResolve());await settle();assert.equal(await value(),'new document');assert.equal(await page.locator('#editor .note-cards').count(),0,'late math cannot restore the old document');
    assert.deepEqual(errors,[]); assert(!requests.some(url=>!url.startsWith(origin)), 'no outgoing requests');
    fs.writeFileSync(path.join(output,'validation.json'),JSON.stringify({matrix,checks:['selection/edit/clipboard/history/IME/source/reading/guide/search/boundaries/math/reopen/stale'],errors},null,2));
    console.log('note cards browser: ok; '+output);
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});

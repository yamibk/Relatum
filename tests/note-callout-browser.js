'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const sharp = require(process.env.RELATUM_SHARP || 'sharp');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-callouts-'));
const fixture = '# Callouts\n\n> [!NOTE]\n> 这是 Note 测试。\n\n> [!TIP]+ 自定义标题\n> 公式之前 $a^2$\n> $$\n> a^2+b^2 > 0\n> $$\n> 公式之后\n\n> [!warning]- 默认折叠\n> 隐藏正文\n> $$x^2$$\n\n> [!LaVeNdEr]\n> 纯色块正文\n\n后方定位段落';
const html = `<!doctype html><html><head><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}.note-document-body{--note-inline-title-space:24px}</style></head><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div><div id="reading" hidden></div></div></main><script src="markdown-table.js"></script><script src="markdown.js"></script><script src="mermaid-renderer.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script><script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(fixture)},notePath:'callouts.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.RELATUM_EDGE_PATH ? {executablePath:process.env.RELATUM_EDGE_PATH} : {})});
    const page = await browser.newPage({viewport:{width:1000,height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.editor && document.querySelector('.note-live-rich-block.is-math mjx-container'));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const initial = await page.evaluate(() => ({
      math:Array.from(document.querySelectorAll('.note-live-rich-block.is-math')).map(el => el.textContent),
      text:editor.view.contentDOM.textContent,
      titles:Array.from(document.querySelectorAll('.note-live-callout-title-widget')).map(el=>el.textContent),
      error:document.getElementById('editor').dataset.livePreviewError,
      color: Array.from(document.querySelectorAll('.cm-line.note-color-block')).map(el => ({background:getComputedStyle(el).backgroundColor,height:el.getBoundingClientRect().height})),
    }));
    assert(!initial.error, JSON.stringify(initial));
    assert.equal(initial.color.length,1,'a titleless color block has exactly one native body row');
    assert(!initial.color[0].background.includes('0, 0, 0, 0') && initial.color[0].height < 55,JSON.stringify(initial.color));
    const continuity = await page.evaluate(() => {
      const math = document.querySelector('.note-block-math').getBoundingClientRect();
      const line = Array.from(document.querySelectorAll('.note-live-callout-line')).find(el=>el.textContent.includes('公式之后')).getBoundingClientRect();
      return {math:[math.left,math.right],line:[line.left,line.right]};
    });
    assert.deepEqual(continuity.math,continuity.line,'math background covers the complete native Callout width');
    assert.equal(initial.math.length, 1, 'collapsed math must not have an overlapping widget');
    assert(initial.titles.includes('Note') && !initial.titles.some(title=>title.includes('Lavender')), JSON.stringify(initial));
    assert(initial.text.includes('公式之后') && !initial.text.includes('隐藏正文'), JSON.stringify(initial));
    assert(initial.math[0].includes('>') || initial.math[0].includes('0'), 'TeX comparisons survive structural quote removal');
    await page.screenshot({path:path.join(output,'live-light.png')});
    const warning = page.locator('.note-live-callout-title-widget').filter({hasText:'默认折叠'}).locator('button');
    await warning.focus(); await page.keyboard.press('Enter'); await settle();
    assert.equal(await warning.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => document.querySelectorAll('.is-math mjx-container').length === 2);
    await page.keyboard.press('Space'); await settle();
    assert.equal(await warning.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => editor.snapshot().value), fixture, 'folding never changes Markdown');
    await page.evaluate(() => editor.setSourceMode(true)); await settle();
    assert.equal(await page.locator('.note-callout-fold').count(), 2, 'source mode retains fold controls');
    assert((await page.locator('.cm-content').innerText()).includes('隐藏正文'));
    await page.evaluate(() => editor.setSourceMode(false)); await settle();
    assert.equal(await warning.getAttribute('aria-expanded'), 'false', 'fold state survives source mode');
    await page.evaluate(() => {
      const reading = document.getElementById('reading'); reading.hidden=false;
      RelatumNoteLiveEditor.renderMarkdown(reading, editor.snapshot().value, 'callouts.md', {calloutSession:editor.calloutSession});
      document.getElementById('editor').hidden=true;
    }); await settle();
    const readWarning = page.locator('#reading .note-block[data-callout="warning"] button');
    assert.equal(await readWarning.getAttribute('aria-expanded'),'false');
    await readWarning.click(); await settle();
    await page.evaluate(() => { document.getElementById('reading').hidden=true; document.getElementById('editor').hidden=false; }); await settle();
    assert.equal(await warning.getAttribute('aria-expanded'),'true', 'reading shares the document session');
    await page.evaluate(() => {
      const pos=editor.snapshot().value.indexOf('隐藏正文')+2;
      editor.view.dispatch({selection:{anchor:pos}});editor.focus();
    }); await settle();
    await warning.click(); await settle();
    assert((await page.evaluate(()=>editor.view.state.doc.lineAt(editor.snapshot().head).text)).includes('[!warning]-'), 'collapsing a body caret moves it to the visible header');
    assert.equal(await page.locator('.note-live-callout-first .note-callout-fold[aria-expanded="false"]').count(),1,'source header keeps its fold control');
    await page.evaluate(fixture=>editor.setDocument({value:fixture,notePath:'callouts.md'}),fixture); await settle();
    assert.equal(await warning.getAttribute('aria-expanded'),'false','reopening resets fold state to the Markdown suffix');
    await page.evaluate(() => {
      const pos=editor.snapshot().value.indexOf('[!LaVeNdEr]');
      editor.view.dispatch({selection:{anchor:pos}});editor.focus();
    }); await settle();
    assert((await page.locator('.cm-content').innerText()).includes('[!LaVeNdEr]'),'entering a titleless marker line exposes native source');
    await page.evaluate(()=>editor.view.contentDOM.blur()); await settle();

    const catalog = await page.evaluate(() => {
      const catalog = MarkdownMini.noteBlockCatalog;
      const container = document.createElement('div'); container.className='node-text'; document.body.appendChild(container);
      const types = catalog.types.flatMap(type=>[type.name,...type.aliases]);
      const colors = catalog.colors.map(color=>color.name.toUpperCase());
      container.innerHTML=MarkdownMini.renderResult([...types,...colors].map(type=>'> [!'+type+']\n> 正文').join('\n\n'), {noteBlocks:true}).html;
      const blocks=Array.from(container.querySelectorAll('.note-block'));
      const metrics=blocks.map(block=>({type:block.dataset.callout,title:block.querySelector('.note-callout-title-text')?.textContent||'',icon:!!block.querySelector('svg'),radius:getComputedStyle(block).borderRadius,border:getComputedStyle(block).borderLeftWidth,bg:getComputedStyle(block).backgroundColor}));
      container.remove(); return {types,colors,metrics};
    });
    assert.equal(catalog.colors.length,32);
    catalog.metrics.slice(0,catalog.types.length).forEach((block,index)=>{
      const name=catalog.types[index]; assert.equal(block.title,name[0].toUpperCase()+name.slice(1)); assert(block.icon); assert.equal(block.radius,'4px'); assert.equal(block.border,'0px');
    });
    catalog.metrics.slice(catalog.types.length).forEach(block=>{assert(!block.title && !block.icon); assert.equal(block.radius,'7px'); assert.equal(block.border,'0px');});
    for (const theme of ['light','dark']) {
      await page.setViewportSize({width:520,height:1000});
      await page.evaluate(theme=>{document.body.dataset.startTheme=theme;document.documentElement.style.setProperty('--note-font-scale','1.35');},theme); await settle();
      assert(await page.evaluate(()=>document.querySelector('.note-block-math').scrollWidth <= document.querySelector('.note-block-math').clientWidth+1));
      await page.screenshot({path:path.join(output,'narrow-'+theme+'.png')});
    }
    await page.evaluate(() => {
      editor.setDocument({value:'> [!blue]\n> \\[E=mc^2\\]\n> 后续正文\n\n尾段',notePath:'single.md'});
    }); await settle();
    await page.waitForFunction(()=>document.querySelector('.note-block-math.note-color-block mjx-container'));
    assert.equal(await page.locator('.note-block-math.note-live-callout-first').count(),1);
    await page.locator('.note-block-math').click(); await settle();
    assert((await page.evaluate(()=>editor.view.state.doc.lineAt(editor.snapshot().head).text)).includes('E=mc^2'),'quoted math click reveals its own source');
    await page.evaluate(() => {
      const result=MarkdownMini.renderResult('> [!blue]\n> $$\n> x > y\n> $$\n> 后续正文', {noteBlocks:true});
      window.__quoted=result.html;
    });
    const quoted=await page.evaluate(()=>window.__quoted);
    assert(quoted.includes('x &gt; y') && !quoted.includes('&gt; x'),quoted);
    assert(/md-callout-body[^]*后续正文[^]*<\/div><\/div>$/.test(quoted),quoted);
    const wide = '> [!info]\n> $$'+'x+'.repeat(200)+'x$$\n> 后续正文\n\n尾段';
    await page.evaluate(wide=>editor.setDocument({value:wide,notePath:'wide.md'}),wide);await settle();
    await page.waitForFunction(()=>document.querySelector('.note-block-math mjx-container'));
    const wideMetrics=await page.evaluate(()=>{
      const math=document.querySelector('.note-block-math'),pane=document.querySelector('.note-document-body');
      return {scroll:math.scrollWidth,width:math.clientWidth,pane:pane.clientWidth,content:editor.view.contentDOM.getBoundingClientRect().width,overflow:getComputedStyle(math).overflowX};
    });
    assert(wideMetrics.scroll > wideMetrics.width && wideMetrics.width <= wideMetrics.pane && wideMetrics.overflow === 'auto',JSON.stringify(wideMetrics));
    await page.evaluate(()=>editor.setDocument({value:'> [!note]\n> ```tex\n> $$x$$\n> ```\n\n> [!note]\n> <!--\n> $$x$$\n> -->\n\n> [!note]\n> %%\n> $$x$$\n> %%',notePath:'protected.md'}));await settle();
    assert.equal(await page.locator('.is-math').count(),0,'quoted code and comments never project display math');

    // Same content and font scale as the reference; compare flat background
    // pixels and native title/body coordinates rather than whole-window chrome.
    await page.setViewportSize({width:1000,height:2200});
    const reference=await page.evaluate(()=>MarkdownMini.noteBlockCatalog.types.map(type=>'> [!'+type.name+']\n> 这是 '+type.name[0].toUpperCase()+type.name.slice(1)+' 测试。').join('\n\n'));
    await page.evaluate(reference=>{document.body.dataset.startTheme='light';document.documentElement.style.setProperty('--note-font-scale','1');editor.setDocument({value:reference,notePath:'reference.md'});editor.view.contentDOM.blur();},reference); await settle();
    const positions=await page.evaluate(()=>Array.from(document.querySelectorAll('.note-live-callout-first')).map(line=>{
      const r=line.getBoundingClientRect(),icon=line.querySelector('svg').getBoundingClientRect(),title=line.querySelector('.note-callout-title-text').getBoundingClientRect();
      const body=line.nextElementSibling,r2=body.getBoundingClientRect();
      return {type:line.className.match(/is-callout-(\w+)/)[1],x:r.left,y:r.top,width:r.width,radius:getComputedStyle(line).borderTopLeftRadius,icon:[icon.width,icon.height,icon.left-r.left],gap:title.left-icon.right,font:getComputedStyle(line.querySelector('.note-live-callout-title-widget')).fontSize,bodyFont:getComputedStyle(body).fontSize,bodyTop:r2.top,stroke:line.querySelector('svg').getAttribute('stroke-width')};
    }));
    const png=await page.screenshot({path:path.join(output,'reference-light.png')});
    const raw=await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const targets={note:'E6F0FB',info:'E6F0FB',todo:'E6F0FB',abstract:'E5F8F8',tip:'E5F8F8',success:'E6F8ED',question:'FDF1E5',warning:'FDF1E5',failure:'FCEAEC',danger:'FCEAEC',bug:'FCEAEC',example:'F1EDFD',quote:'F5F5F5'};
    assert.equal(positions.length,13);
    const pixels=positions.map(item=>{
      const offset=(Math.floor(item.y+8)*raw.info.width+Math.floor(item.x+8))*raw.info.channels;
      const rgb=Array.from(raw.data.subarray(offset,offset+3));
      const target=targets[item.type].match(/../g).map(hex=>parseInt(hex,16));
      assert.deepEqual(rgb,target,JSON.stringify({item,rgb,target}));
      assert.equal(item.radius,'4px'); assert.deepEqual(item.icon.slice(0,2),[18,18]); assert(Math.abs(item.icon[2]-24)<1); assert(Math.abs(item.gap-4)<1); assert.equal(item.font,item.bodyFont); assert.equal(item.stroke,'1.75');
      return {type:item.type,rgb};
    });
    await page.evaluate(reference=>{
      document.getElementById('editor').hidden=true;document.getElementById('reading').hidden=false;
      RelatumNoteLiveEditor.renderMarkdown(document.getElementById('reading'),reference,'reference.md');
    },reference); await settle();
    await page.screenshot({path:path.join(output,'reading-light.png')});
    await page.evaluate(()=>document.body.dataset.startTheme='dark'); await settle();
    await page.screenshot({path:path.join(output,'reading-dark.png')});
    const darkTitles=await page.evaluate(()=>Array.from(document.querySelectorAll('#reading .note-block')).map(block=>({type:block.dataset.callout,color:getComputedStyle(block.querySelector('.md-callout-title')).color})));
    const darkAccent={note:[2,122,255],info:[2,122,255],todo:[2,122,255],abstract:[83,223,221],tip:[83,223,221],success:[68,207,110],question:[233,151,63],warning:[233,151,63],failure:[251,70,76],danger:[251,70,76],bug:[251,70,76],example:[168,130,255],quote:[158,158,158]};
    darkTitles.forEach(item=>assert.deepEqual(item.color.match(/\d+/g).map(Number),darkAccent[item.type]));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(fixture=>RelatumNoteLiveEditor.renderMarkdown(document.getElementById('reading'),fixture,'fold.md'),fixture);await settle();
    assert.equal(await page.locator('#reading .note-callout-fold svg').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    fs.writeFileSync(path.join(output,'validation.json'),JSON.stringify({positions,pixels,darkTitles,wideMetrics,types:catalog.types.length,colors:catalog.colors.length},null,2));
    assert.deepEqual(errors,[]);
    assert(!await page.getAttribute('#editor','data-live-preview-error'));
    console.log(JSON.stringify({output,types:catalog.types.length,colors:catalog.colors.length,folding:true,quotedMath:true,pixels}));
  } finally { if (browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});

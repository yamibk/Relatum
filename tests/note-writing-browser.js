'use strict';

// Real Chromium editing, isolated static assets and synthetic Markdown only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = process.env.RELATUM_NOTE_WRITING_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-writing-'));
const sample = [
  '# 信号采样与数字控制', '', '把实验代码、推导和待办放在同一张纸上。', '',
  '## 采样程序', '', '- [ ] 检查采样周期 **Ts** 与单位', '- [x] 保存示波器波形', '',
  '```c', '#include <stdint.h>', '', '// 定时中断：读取电流并更新 PWM 占空比',
  'float controller(float current, float reference) {', '    const float kp = 0.25f;',
  '    float error = reference - current;', '    return kp * error;', '}', '```', '',
  '### 实验记录', '', '对比不同增益下的超调量与稳态误差。',
].join('\n');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/assets/">
<link rel="stylesheet" href="styles.css"><style>
body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}
.note-document-body{--note-inline-title-space:24px}.note-reading-view{height:100vh}
</style></head><body class="start-page" data-start-theme="light">
<main class="note-document-pane"><div class="note-document-body">
<div id="editor" class="note-live-editor-host"></div><div id="reading" class="note-reading-view" hidden></div>
</div></main><script src="markdown-table.js"></script><script src="markdown.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:${JSON.stringify(sample)},notePath:'writing.md'});</script>
</body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.RELATUM_EDGE_PATH?{executablePath:process.env.RELATUM_EDGE_PATH}:{})});
    const page = await browser.newPage({viewport:{width:1280,height:980}});
    page.setDefaultTimeout(12000);
    const errors = [], remote = [];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:')&&!request.url().startsWith('data:'))remote.push(request.url());});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.editor);
    const settle = () => page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const value = () => page.evaluate(()=>editor.snapshot().value);
    async function reset(source, head=source.length, anchor=head) {
      await page.evaluate(({source,head,anchor})=>{
        const reading=document.getElementById('reading');RelatumNoteLiveEditor.releaseReadingDocument(reading);reading.hidden=true;
        document.getElementById('editor').hidden=false;editor.setSourceMode(false);
        editor.setDocument({value:source,notePath:'writing.md',head,anchor,scrollTop:0});editor.focus();
      },{source,head,anchor});
      await settle();
    }
    async function read(source) {
      await page.evaluate(source=>{
        editor.view.contentDOM.blur();document.getElementById('editor').hidden=true;
        const reading=document.getElementById('reading');reading.hidden=false;reading.scrollTop=0;
        RelatumNoteLiveEditor.renderMarkdown(reading,source,'writing.md');
      },source); await settle();
    }
    async function taskCaret() {
      await settle();
      return page.evaluate(()=>{
        const view=editor.view,head=view.state.selection.main.head,at=view.domAtPos(head);
        const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(el=>el.contains(at.node));
        const box=line?.querySelector('.note-live-task'),cursor=view.dom.querySelector('.cm-cursor');
        const rect=el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};};
        const coords=view.coordsAtPos(head);
        return{head,focus:view.hasFocus,coords:{left:coords.left,top:coords.top,bottom:coords.bottom,height:coords.bottom-coords.top},box:box&&rect(box),cursor:cursor&&rect(cursor),value:editor.snapshot().value};
      });
    }
    function checkTaskCaret(metrics) {
      assert(metrics.focus&&metrics.box&&metrics.cursor,'empty task keeps an editor caret');
      assert(metrics.coords.left-metrics.box.right>=4,'caret stays beyond the checkbox border and margin');
      assert(metrics.coords.height>metrics.box.height,'caret uses text height rather than checkbox height');
      assert(Math.abs(metrics.cursor.height-metrics.coords.height)<.1,'drawn cursor uses the measured text height');
      assert(Math.abs(metrics.cursor.left-metrics.coords.left)<1,'drawn cursor is at the text origin');
      assert(!metrics.value.includes('\u200b'),'view anchor must never enter the source');
    }
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});
    });

    // A caret in either task must leave every checkbox and ordered number visible.
    const tasks='前段\n\n- [ ] alpha **beta**\n- [x] done\n\n1. [ ] ordered';
    await reset(tasks,tasks.indexOf('alpha')+2);
    assert.equal(await page.locator('.note-live-task').count(),3);
    assert.equal(await page.locator('.note-live-list-marker').count(),1);
    assert(!(await page.locator('.cm-content').innerText()).includes('[ ]'));
    await page.keyboard.type('Z');
    assert.equal(await value(),tasks.replace('alpha','alZpha'));
    assert.equal(await page.locator('.note-live-task').count(),3);
    const selection=await page.evaluate(()=>editor.view.state.selection.main.head);
    await page.locator('.note-live-task').first().click();await settle();
    assert.equal(await value(),tasks.replace('alpha','alZpha').replace('- [ ]','- [x]'));
    assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),selection);
    assert(await page.locator('.note-live-task').first().isChecked());
    await page.keyboard.press('Control+z'); assert.equal(await value(),tasks.replace('alpha','alZpha'));
    await page.evaluate(()=>{
      editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.range(0,editor.view.state.doc.length)});
      const data=new DataTransfer();editor.view.contentDOM.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data}));window.__selectedCopy=data.getData('text/plain');
    });
    assert.equal(await page.evaluate(()=>window.__selectedCopy),tasks.replace('alpha','alZpha'),'copy preserves task source rather than widget text');

    await reset('');await page.keyboard.type('- [ ] hello');
    assert.equal(await value(),'- [ ] hello');assert.equal(await page.locator('.note-live-task').count(),1);

    // Home and the two structural deletion steps use source-preserving history.
    await reset('- [ ] alpha',8);
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),6);
    await page.keyboard.press('Backspace');assert.equal(await value(),'- alpha');
    await page.keyboard.press('Backspace');assert.equal(await value(),'alpha');
    await page.keyboard.press('Control+z');assert.equal(await value(),'- alpha');
    await page.keyboard.press('Control+z');assert.equal(await value(),'- [ ] alpha');
    await page.keyboard.press('Control+y');assert.equal(await value(),'- alpha');
    await page.keyboard.press('Control+y');assert.equal(await value(),'alpha');
    await reset('1. [x] ordered',7);await page.keyboard.press('Backspace');assert.equal(await value(),'1. ordered');
    await page.keyboard.press('Backspace');assert.equal(await value(),'ordered');

    const nested='- [ ] parent\n- [ ] child';
    await reset(nested);await page.keyboard.press('Tab');assert.equal(await value(),'- [ ] parent\n  - [ ] child');
    await page.keyboard.press('Shift+Tab');assert.equal(await value(),nested);
    assert.equal(await page.locator('.note-live-task').count(),2);
    await reset('- [x] alpha');await page.keyboard.press('Enter');assert.equal(await value(),'- [x] alpha\n- [ ] ');
    assert.equal(await page.locator('.note-live-task').count(),2);
    await page.keyboard.press('Enter');assert.equal(await value(),'- [x] alpha\n\n');

    await reset('前段\n- [ ] alpha',9);
    await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),9);
    await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),2);
    await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),9);
    await page.keyboard.press('Delete');assert.equal(await value(),'前段\n- [ ] lpha');
    await page.evaluate(()=>editor.setSourceMode(true));await settle();
    assert.equal(await page.locator('.note-live-task').count(),0);
    assert((await page.locator('.cm-content').innerText()).includes('- [ ]'));
    await page.evaluate(()=>editor.setSourceMode(false));await settle();
    assert.equal(await page.locator('.note-live-task').count(),1);
    await page.keyboard.press('Control+z');assert.equal(await value(),'前段\n- [ ] alpha');

    // Real Chromium provisional/committed IME text never replaces the checkbox.
    const cdp=await page.context().newCDPSession(page);
    await reset('- [ ] 记录');
    for(const text of ['z','zhong'])await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
    assert.equal(await value(),'- [ ] 记录');
    assert.equal(await page.locator('.note-live-task').count(),1);
    await cdp.send('Input.insertText',{text:'中文'});await settle();
    await page.waitForFunction(()=>editor.snapshot().value==='- [ ] 记录中文');
    assert.equal(await page.locator('.note-live-task').count(),1);
    await reset('- [ ] 取消');
    await cdp.send('Input.imeSetComposition',{text:'qu',selectionStart:2,selectionEnd:2});
    await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();
    assert.equal(await value(),'- [ ] 取消');
    await reset('- [ ] 记录',6);
    await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    await cdp.send('Input.insertText',{text:'中'});await settle();
    await page.waitForFunction(()=>editor.snapshot().value==='- [ ] 中记录');
    assert.equal(await page.locator('.note-live-task').count(),1);
    await page.evaluate(()=>editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.range(0,editor.view.state.doc.length)}));
    await page.keyboard.type('replacement');assert.equal(await value(),'replacement');

    // Empty task carets must match real text geometry, including actual clicks.
    const emptyTaskLayouts=[];
    for(const [theme,width,scale,motion] of [['light',1280,1,'no-preference'],['dark',620,1.35,'reduce'],['light',620,.8,'reduce']]){
      await page.setViewportSize({width,height:980});await page.emulateMedia({reducedMotion:motion});
      await page.evaluate(({theme,scale})=>{document.body.dataset.startTheme=theme;document.body.style.setProperty('--note-font-scale',scale);},{theme,scale});
      for(const source of ['- [ ] ','- [x] ','1. [ ] ','- [ ] parent\n  - [ ] ','> - [ ] ','> [!note] Tasks\n> - [ ] ']){
        await reset(source+'M',source.length);
        const filled=await taskCaret();
        const text=await page.evaluate(()=>{const view=editor.view,r=view.coordsAtPos(view.state.selection.main.head+1);return{top:r.top,height:r.bottom-r.top};});
        await reset(source);
        const empty=await taskCaret();checkTaskCaret(empty);
        for(const key of ['left','top','height'])assert(Math.abs(empty.coords[key]-filled.coords[key])<.1,'empty and filled task '+key);
        for(const key of ['top','height'])assert(Math.abs(empty.coords[key]-text[key])<.1,'empty caret matches the actual text glyph '+key);
        await page.mouse.click(empty.coords.left+25,(empty.coords.top+empty.coords.bottom)/2);
        assert.equal(await page.evaluate(()=>editor.view.state.selection.main.head),source.length,'empty-row click lands at the text origin');
        checkTaskCaret(await taskCaret());
        emptyTaskLayouts.push({theme,width,scale,source,empty,filled});
      }
      await reset('# 实验任务\n\n- [x] 核对电路参数\n- [ ] 记录采样结果\n- [ ] ');
      await page.locator('.cm-cursorLayer').evaluate(el=>{el.style.animation='none';});
      await page.screenshot({path:path.join(output,'empty-task-'+theme+'-'+Math.round(scale*100)+'.png')});
      await page.locator('.cm-cursorLayer').evaluate(el=>{el.style.removeProperty('animation');});
    }
    await page.setViewportSize({width:1280,height:980});await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{document.body.dataset.startTheme='light';document.body.style.setProperty('--note-font-scale',1);});
    await reset('- [ ] ');await page.keyboard.type('Q');assert.equal(await value(),'- [ ] Q');
    await page.keyboard.press('Backspace');assert.equal(await value(),'- [ ] ');checkTaskCaret(await taskCaret());
    await reset('- [ ] Q');await page.keyboard.press('Backspace');checkTaskCaret(await taskCaret());
    await page.keyboard.press('Control+z');assert.equal(await value(),'- [ ] Q');
    await page.keyboard.press('Control+y');assert.equal(await value(),'- [ ] ');checkTaskCaret(await taskCaret());
    await page.locator('.note-live-task').click();assert.equal(await value(),'- [x] ');checkTaskCaret(await taskCaret());
    await page.keyboard.press('Control+z');assert.equal(await value(),'- [ ] ');checkTaskCaret(await taskCaret());
    await page.keyboard.press('Backspace');assert.equal(await value(),'- ');
    await page.keyboard.press('Backspace');assert.equal(await value(),'');
    await page.keyboard.press('Control+z');assert.equal(await value(),'- ');
    await page.keyboard.press('Control+z');assert.equal(await value(),'- [ ] ');checkTaskCaret(await taskCaret());
    await page.evaluate(()=>editor.setSourceMode(true));await settle();assert.equal(await value(),'- [ ] ');
    await page.evaluate(()=>editor.setSourceMode(false));checkTaskCaret(await taskCaret());
    await page.evaluate(()=>{
      editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.range(0,editor.view.state.doc.length)});
      const data=new DataTransfer();editor.view.contentDOM.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data}));window.__emptyTaskCopy=data.getData('text/plain');
    });
    assert.equal(await page.evaluate(()=>window.__emptyTaskCopy),'- [ ] ');
    await reset('- [x] done');await page.keyboard.press('Enter');assert.equal(await value(),'- [x] done\n- [ ] ');checkTaskCaret(await taskCaret());
    await page.keyboard.press('Enter');assert.equal(await value(),'- [x] done\n\n');
    await reset('- [ ] ');
    await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    assert.equal(await value(),'- [ ] ');
    assert.equal(await page.locator('.note-live-task').count(),1);
    assert.equal(await page.locator('#editor').evaluate(el=>getComputedStyle(el.querySelector('.cm-cursorLayer')).visibility),'hidden','native IME owns the only visible caret');
    await cdp.send('Input.insertText',{text:'中'});await settle();
    await page.waitForFunction(()=>editor.snapshot().value==='- [ ] 中');
    await reset('- [ ] ');
    await cdp.send('Input.imeSetComposition',{text:'qu',selectionStart:2,selectionEnd:2});
    await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle();
    assert.equal(await value(),'- [ ] ');checkTaskCaret(await taskCaret());

    const headingSource=Array.from({length:6},(_,i)=>'#'.repeat(i+1)+' 标题层级 '+(i+1)).join('\n\n');
    const sizes=[1.9,1.5,1.25,1.1,1,.94], layouts=[];
    for(const [theme,width,scale,motion] of [['light',1280,1,'no-preference'],['dark',620,1.35,'reduce']]){
      await page.setViewportSize({width,height:980});await page.emulateMedia({reducedMotion:motion});
      await page.evaluate(({theme,scale})=>{document.body.dataset.startTheme=theme;document.body.style.setProperty('--note-font-scale',scale);},{theme,scale});
      await reset(headingSource);
      const live=await page.evaluate(()=>[...document.querySelectorAll('.note-live-heading')].map(el=>{const s=getComputedStyle(el);return{font:parseFloat(s.fontSize),border:parseFloat(s.borderBottomWidth),left:el.getBoundingClientRect().left};}));
      assert.equal(live.length,6);
      live.forEach((item,i)=>{assert(Math.abs(item.font-16*scale*sizes[i])<.05);assert.equal(item.border,i<2?1:0);assert(Math.abs(item.left-live[0].left)<.1);});
      await read(headingSource);
      const reading=await page.evaluate(()=>[...document.querySelectorAll('.note-reading-content :is(h1,h2,h3,h4,h5,h6)')].map(el=>{const s=getComputedStyle(el);return{font:parseFloat(s.fontSize),border:parseFloat(s.borderBottomWidth)};}));
      assert.equal(reading.length,6);reading.forEach((item,i)=>{assert.equal(item.font,live[i].font);assert.equal(item.border,live[i].border);});
      layouts.push({theme,width,scale,live,reading});
      await reset(sample);await page.evaluate(()=>editor.view.contentDOM.blur());await settle();
      await page.screenshot({path:path.join(output,theme+'.png')});
    }
    await page.setViewportSize({width:1280,height:980});
    await page.evaluate(()=>{document.body.dataset.startTheme='light';document.body.style.removeProperty('--note-font-scale');});
    await reset('下划线一级\n===\n\n下划线二级\n---');
    assert.equal(await page.locator('.note-live-h1').count(),1);assert.equal(await page.locator('.note-live-h2').count(),1);

    // Unlabelled and incomplete fences both copy exact code, without delimiters.
    for(const source of ['```\nline 1\nline 2\n```','```python\nvalue = 7 // 2']){
      await reset(source);await page.evaluate(()=>editor.view.contentDOM.blur());await settle();
      await page.locator('.note-live-code-language').click();
      assert.equal(await page.evaluate(()=>window.__copied),source.includes('line 1')?'line 1\nline 2':'value = 7 // 2');
      assert.equal(await page.locator('.note-live-code-language').innerText(),'已复制');
      assert.equal(await value(),source);
    }
    await page.evaluate(()=>{
      navigator.clipboard.writeText=async()=>{throw new Error('test clipboard denial');};
      document.execCommand=()=>false;
    });
    await page.locator('.note-live-code-language').click();
    assert.equal(await page.locator('.note-live-code-language').innerText(),'复制失败');
    await page.evaluate(()=>{navigator.clipboard.writeText=async text=>{window.__copied=text;};});
    for(const language of ['text','output','unknown-python-language']){
      await reset('```'+language+'\nreturn 42;\n```');
      assert.equal(await page.locator('.cm-line.note-live-code-line:not(.note-live-code-first):not(.note-live-code-last) [class*="note-live-code-"]').count(),0,language+' code bodies do not guess syntax');
    }

    const readingSource='## 语言一致性\n\n```c\n#include <stdio.h>\nint main(void) { return 0; }\n```\n\n```python\nvalue = 7 // 2 # 中文\n```\n\n```\nplain text\n```';
    await read(readingSource);
    await page.waitForFunction(()=>document.querySelectorAll('[data-note-code-ready="1"]').length===2);
    const readingCode=await page.evaluate(()=>[...document.querySelectorAll('pre.md-code')].map(pre=>({source:pre.querySelector('code').textContent,tokens:[...pre.querySelectorAll('code span')].map(el=>({text:el.textContent,className:el.className,color:getComputedStyle(el).color})),background:getComputedStyle(pre).backgroundColor,toolbar:pre.querySelector('.note-code-toolbar').getBoundingClientRect().bottom,textTop:pre.querySelector('code').getBoundingClientRect().top})));
    assert(readingCode[0].tokens.some(token=>token.text==='#include'&&token.className.includes('meta')));
    assert(readingCode[1].tokens.some(token=>token.text.includes('//')&&token.className.includes('operator')));
    assert(!readingCode[1].tokens.some(token=>token.text.includes('//')&&token.className.includes('comment')));
    assert.equal(readingCode[2].source,'plain text');assert.equal(readingCode[2].tokens.length,0);
    readingCode.forEach(code=>{assert.equal(code.background,'rgb(248, 249, 247)');assert(code.toolbar<=code.textTop,'copy controls leave the first code line clear');});
    const luminance = color=>{const c=(color.startsWith('#')?color.slice(1).match(/../g).map(v=>parseInt(v,16)):color.match(/[\d.]+/g).slice(0,3).map(Number)).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
    readingCode.forEach(code=>code.tokens.forEach(token=>{assert((luminance(code.background)+.05)/(luminance(token.color)+.05)>=4.5,'syntax contrast: '+token.className);}));
    await page.locator('.note-code-toolbar button').nth(1).click();assert.equal(await page.evaluate(()=>window.__copied),'value = 7 // 2 # 中文');
    await page.screenshot({path:path.join(output,'reading-light.png')});

    const paletteSource='```c\n#include <stdio.h>\n// 读取采样值并输出实验记录\nint sample(float gain) {\n    printf("gain=%f\\n", gain);\n    return 42;\n}\n```';
    const palettes=[],kinds=['comment','keyword','type','string','number','function','definition','meta','escape','operator'];
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>{document.body.dataset.startTheme=theme;},theme);
      let expectedColors;
      for(const mode of ['live','source','reading']){
        await reset(paletteSource);
        if(mode==='source'){await page.evaluate(()=>editor.setSourceMode(true));await settle();}
        if(mode==='reading'){await read(paletteSource);await page.waitForFunction(()=>document.querySelector('[data-note-code-ready="1"]'));}
        const palette=await page.evaluate(({mode,kinds})=>{
          const host=document.querySelector(mode==='reading'?'.note-reading-content':'#editor'),style=getComputedStyle(host);
          return{background:style.getPropertyValue('--note-code-bg').trim(),baseColors:['text','invalid'].map(kind=>style.getPropertyValue('--note-code-'+kind).trim()),colors:Object.fromEntries(kinds.map(kind=>{
            const token=host.querySelector('.note-live-code-'+kind);return[kind,token&&getComputedStyle(token).color];
          }))};
        },{mode,kinds});
        for(const color of palette.baseColors){
          const foreground=luminance(color),background=luminance(palette.background);
          assert((Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)>=4.5,theme+'/'+mode+' base/error contrast');
        }
        for(const [kind,color] of Object.entries(palette.colors)){
          assert(color,theme+'/'+mode+' provides '+kind+' syntax');
          const foreground=luminance(color),background=luminance(palette.background);
          assert((Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)>=4.5,theme+'/'+mode+'/'+kind+' contrast');
        }
        if(expectedColors)assert.deepEqual(palette.colors,expectedColors,'all three modes share the '+theme+' palette');
        else expectedColors=palette.colors;
        palettes.push({theme,mode,...palette});
      }
      await page.locator('.note-code-toolbar button').click();assert.equal(await page.evaluate(()=>window.__copied),paletteSource.split('\n').slice(1,-1).join('\n'));
      await page.screenshot({path:path.join(output,'syntax-'+theme+'.png')});
    }
    await page.evaluate(()=>{document.body.dataset.startTheme='light';});

    // Native minimization pauses preparation even when Chromium reports visible.
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='1';window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    await read(readingSource);await settle();
    assert.equal(await page.locator('[data-note-code-ready="1"]').count(),0);
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='0';window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    await page.waitForFunction(()=>document.querySelectorAll('[data-note-code-ready="1"]').length===2);
    // Hold actual idle callbacks to inspect cancellation before parsing starts.
    // Calls with options still belong to CodeMirror's ordinary parse worker.
    await page.evaluate(()=>{
      window.__idleOriginal=[window.requestIdleCallback,window.cancelIdleCallback];window.__heldIdle=new Map();let id=100000000;
      window.requestIdleCallback=(callback,options)=>{if(options)return __idleOriginal[0].call(window,callback,options);const key=++id;__heldIdle.set(key,callback);return key;};
      window.cancelIdleCallback=key=>{if(!__heldIdle.delete(key))__idleOriginal[1].call(window,key);};
    });
    await read(readingSource);await page.waitForFunction(()=>__heldIdle.size>0);
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='1';window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    assert.equal(await page.evaluate(()=>__heldIdle.size),0,'minimization cancels the queued highlighter');
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='0';window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    await page.waitForFunction(()=>__heldIdle.size>0);
    await page.evaluate(()=>RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading')));
    assert.equal(await page.evaluate(()=>__heldIdle.size),0,'leaving reading cancels the queued highlighter');
    await read(readingSource);await page.waitForFunction(()=>__heldIdle.size>0);
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    assert.equal(await page.evaluate(()=>__heldIdle.size),0,'pagehide releases the queued highlighter');
    await page.evaluate(()=>{[window.requestIdleCallback,window.cancelIdleCallback]=__idleOriginal;delete window.__heldIdle;delete window.__idleOriginal;});
    await read('```c\n'+'int value = 1;\n'.repeat(6000)+'```');
    assert.equal(await page.locator('[data-note-code-ready="plain"]').count(),1);
    await page.locator('.note-code-toolbar button').click();assert.equal(await page.evaluate(()=>window.__copied),Array(6000).fill('int value = 1;').join('\n'));
    await page.evaluate(()=>RelatumNoteLiveEditor.releaseReadingDocument(document.getElementById('reading')));await settle();
    assert.equal(await page.locator('.note-reading-content').count(),0);
    assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
    const report={output,layouts,emptyTaskLayouts,palettes,readingCode,tasks:true,ime:true,copy:true,lifecycle:true,errors};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({output,tasks:true,ime:true,headings:true,reading:true,copy:true,lifecycle:true}));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

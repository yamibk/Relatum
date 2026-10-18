'use strict';
// Save/reopen through the actual workspace and HTTP service, with a disposable
// note library and browser profile. Never reads or writes the user's notebooks.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname,'..'), root = fs.mkdtempSync(path.join(os.tmpdir(),'relatum-writing-save-'));
const initial = '# 电机控制实验\n\n## 采样\n\n- [ ] 检查采样周期\n\n```c\n#include <stdint.h>\nfloat kp = 0.25f; // 中文注释\n```\n\n```python\nvalue = 7 // 2 # 整除\n```\n';
fs.mkdirSync(path.join(root,'notes'));
const note = path.join(root,'notes','Writing.md');fs.writeFileSync(note,initial);
const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const socket = net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const url='http://127.0.0.1:'+port;
  const service=spawn(process.env.RELATUM_PYTHON||'python',['-B','app.py','--no-browser','--port',String(port)],{cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,stdio:'ignore'});
  let browser;
  try{
    let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(url+'/api/runtime')).ok;}catch(_){}if(ready)break;await pause(100);}
    assert(ready,'isolated service starts');
    browser=await chromium.launch({headless:true,...(process.env.RELATUM_EDGE_PATH?{executablePath:process.env.RELATUM_EDGE_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    const script=fs.readFileSync(path.join(repo,'assets/note-workspace.js'),'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.WritingTest = {state, openNote, flushSave, setViewMode, get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*',route=>route.fulfill({contentType:'text/javascript',body:script}));
    await page.addInitScript(()=>{
      localStorage.setItem('canvas:startWorkspace:v1','notes');
      localStorage.setItem('canvas:noteOpenTabs:v1','["Writing.md"]');
      localStorage.setItem('canvas:noteActiveTab:v1','Writing.md');
      localStorage.setItem('canvas:noteGraphPreload:v1','0');
    });
    await page.goto(url);await page.waitForFunction(()=>window.WritingTest?.state.current?.path==='Writing.md'&&WritingTest.editor&&WritingTest.state.active);
    assert.equal(await page.evaluate(()=>WritingTest.editor.snapshot().value),initial);
    await page.evaluate(async()=>{await WritingTest.setViewMode('source');await WritingTest.setViewMode('reading');});
    await page.waitForFunction(()=>document.querySelector('.note-reading-content pre.md-code code .note-live-code-meta'));
    assert.equal(fs.readFileSync(note,'utf8'),initial,'display and theme changes do not rewrite Markdown');
    await page.evaluate(async()=>{await WritingTest.setViewMode('live');});
    await page.locator('.note-live-task').click();
    const expected=initial.replace('- [ ]','- [x]')+'补充实验记录';
    await page.evaluate(()=>{
      const editor=WritingTest.editor;editor.view.dispatch({selection:RelatumCodeMirror.EditorSelection.cursor(editor.view.state.doc.length)});editor.focus();
    });
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.insertText',{text:'补充实验记录'});
    assert.equal(await page.evaluate(()=>WritingTest.editor.snapshot().value),expected);
    assert(await page.evaluate(()=>WritingTest.flushSave(WritingTest.state.current)),'workspace save succeeds');
    assert.equal(fs.readFileSync(note,'utf8'),expected);
    assert(!fs.readFileSync(note).includes(Buffer.from('\r\n')),'LF source remains LF');
    await page.reload();await page.waitForFunction(()=>window.WritingTest?.state.current?.path==='Writing.md'&&WritingTest.editor&&WritingTest.state.active);
    assert.equal(await page.evaluate(()=>WritingTest.editor.snapshot().value),expected);
    assert(await page.locator('.note-live-task').isChecked());
    await page.evaluate(async()=>{await WritingTest.setViewMode('reading');});
    await page.waitForFunction(()=>document.querySelector('.note-reading-content pre.md-code code .note-live-code-meta'));
    assert.equal(fs.readFileSync(note,'utf8'),expected);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({saved:true,reopened:true,sourceUnchangedByRendering:true,errors},null,2));
    console.log(JSON.stringify({root,saved:true,reopened:true,sourceUnchangedByRendering:true}));
  }finally{if(browser)await browser.close();service.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Sorting and real search UI, using test-host Edge/Playwright and disposable data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const {spawn,execFileSync} = require('node:child_process');
const {chromium} = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo=path.resolve(__dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-library-sort-'));
const current=fs.readFileSync(path.join(repo,'assets/start.js'),'utf8');
const baseline=execFileSync('git',['show',(process.env.RELATUM_LIBRARY_BASELINE_REF||'HEAD')+':assets/start.js'],{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024});
const report={samples:[],checks:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function extracted(js){
  return 'let libraryTitleCollator=null;'+js.slice(js.indexOf('  function openedAtValue('),js.indexOf('  function byRank('))
    +js.slice(js.indexOf('  function stableAllCanvasFiles('),js.indexOf('  function visibleLibraryFiles('));
}
function files(count){
  let seed=65;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  const titles=['Math 2','math 02','MATH 10','数学 2','数学 10','École','ecole','e\u0301cole','Ａ 2','A 2','日本語','🙂','Ω','0',''];
  return Array.from({length:count},(_,i)=>({id:'id'+i,path:path.join(root,'canvases','fixture-'+i+'.canvas'),
    title:i<titles.length?titles[i]:(i%2?'Math 画布 ':'数学 Canvas ')+(rnd()%count),exists:true,groupId:'',favorite:false,
    lastOpenedAt:i%17===0?'2026-10-14T10:00:00Z':i%19===0?'bad-date':'',}));
}
async function sortChecks(browser,locale){
  const context=await browser.newContext({locale}),page=await context.newPage();
  try{
    for(const count of [100,500,2000]){
      const input=files(count);
      const sample=await page.evaluate(({before,after,input})=>{
        const old=new Function('lastFiles',before+'return stableAllCanvasFiles();');
        // One closure persists just as the real start.js module does across inputs.
        const getNew=new Function('let lastFiles=[];'+after+'return value=>{lastFiles=value;return stableAllCanvasFiles();};')();
        const snapshot=JSON.stringify(input),expected=old(input).map(f=>f.path);
        const times={baseline:[],current:[]};
        for(let run=0;run<5;run++)for(const version of run%2?['current','baseline']:['baseline','current']){
          const start=performance.now(),out=(version==='baseline'?old:getNew)(input);
          times[version].push(performance.now()-start);
          if(JSON.stringify(out.map(f=>f.path))!==JSON.stringify(expected))throw Error('sorting changed');
        }
        if(JSON.stringify(input)!==snapshot)throw Error('sorting mutated source metadata');
        const changed=input.map(f=>({...f}));changed[0].title='Math 9999';changed[1].lastOpenedAt='2026-10-15T10:00:00Z';
        if(JSON.stringify(getNew(changed).map(f=>f.path))!==JSON.stringify(old(changed).map(f=>f.path)))throw Error('changed metadata kept stale order');
        return times;
      },{before:extracted(baseline),after:extracted(current),input});
      report.samples.push({locale,count,...sample});
    }
    report.checks.push({locale,sorting:true});
  }finally{await context.close();}
}
async function uiChecks(browser,url){
  const fixture={files:files(2000),groups:[],recentLimit:30};
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
    localStorage.setItem('canvas:startWorkspace:v1','canvas');localStorage.setItem('canvas:librarySearchEnabled','1');
    localStorage.setItem('canvas:noteGraphPreload:v1','0');
  });
  const probe='window.L={visible:visibleLibraryFiles,refresh};\n';
  await context.route('**/start.js',route=>route.fulfill({contentType:'text/javascript',body:current.replace('  function visibleLibraryFiles() {',probe+'  function visibleLibraryFiles() {')}));
  await context.route('**/api/recent',route=>route.fulfill({json:fixture}));
  await context.route('**/api/file-stats',route=>route.fulfill({json:{files:[]}}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(url+'/index.html');await page.waitForSelector('.recent-item');
    await page.keyboard.press('Control+f');
    await page.locator('[data-search-scope="all"]').click();
    const search=page.locator('[data-role="library-search-input"]');
    await search.fill('Math');
    await page.waitForFunction(()=>L.visible().length>900 && document.querySelector('.library-search-count')?.textContent?.includes(String(L.visible().length)));
    assert(await page.locator('.recent-item').count()<100,'large results remain windowed');
    const original=await page.evaluate(()=>L.visible().map(f=>f.path));
    await search.fill('Math 2');await page.waitForFunction(()=>L.visible().length<500);
    assert((await page.evaluate(()=>L.visible())).every(f=>f.title.toLowerCase().includes('math')&&f.title.includes('2')));
    await page.evaluate(()=>RelatumI18n.setLanguage('en'));
    await search.fill('Math');await page.waitForFunction(count=>L.visible().length===count,original.length);
    assert.deepEqual(await page.evaluate(()=>L.visible().map(f=>f.path)),original);
    fixture.files[1].title='Math 9999';fixture.files[2].lastOpenedAt='2026-10-15T10:00:00Z';
    await page.evaluate(()=>L.refresh());
    assert.equal((await page.evaluate(()=>L.visible()))[0].id,'id2');
    await page.locator('[data-action="library-search-clear"]').click();
    assert.equal(await search.inputValue(),'');
    assert.deepEqual(errors,[]);report.checks.push({ui:true,windowed:true,metadataRefresh:true});
  }finally{await context.close();}
}
(async()=>{
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const url='http://127.0.0.1:'+port;
  const server=spawn(process.env.RELATUM_PYTHON||'python',['-B','app.py','--no-browser','--port',String(port)],
    {cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,stdio:'ignore'});
  let browser;
  try{
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(url+'/api/runtime')).ok;}catch{}if(ready)break;await pause(100);}assert(ready);
    browser=await chromium.launch({headless:true,...(process.env.RELATUM_EDGE_PATH?{executablePath:process.env.RELATUM_EDGE_PATH}:{})});
    report.browser=browser.version();
    for(const locale of ['zh-CN','en-US']){await sortChecks(browser,locale);console.log('sorting passed '+locale);}
    await uiChecks(browser,url);
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
    console.log('library sorting browser passed: '+path.join(root,'report.json'));
  }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

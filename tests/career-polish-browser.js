'use strict';
// Frozen synthetic snapshot, production modules, disposable browser; no user library.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const repo=path.resolve(__dirname,'..'),baseline=process.argv.includes('--baseline'),perfOnly=process.argv.includes('--performance');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-career-polish-'));
const fixture=process.env.RELATUM_CAREER_FIXTURE;
assert(fixture&&path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)&&fs.existsSync(path.join(fixture,'fixture-manifest.json')),'Use a disposable career-v2 fixture under TEMP');
let report=JSON.parse(fs.readFileSync(path.join(fixture,'data','career-report-v2.json'),'utf8'));
const files=new Map();
function source(name){if(!files.has(name))files.set(name,baseline&&name.startsWith('assets/career/')?execFileSync('git',['show','82c150e:'+name],{cwd:repo,encoding:'utf8'}):fs.readFileSync(path.join(repo,name),'utf8'));return files.get(name);}
const percentile=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length*.95)]||0;
const html='<html lang="zh-CN"><head><style>body{margin:0;font-family:Segoe UI,Microsoft YaHei,sans-serif;--bg:#fbfaf7}.career-workspace{height:100vh}</style></head><body class="start-page" data-start-theme="light" data-start-workspace="career"><main class="career-workspace"><div class="career-scroll" data-role="career-scroll"><div class="career-entry" data-role="career-entry"><p class="career-kicker"></p><h1></h1><p></p><button></button></div><div data-role="career-loading" hidden><strong></strong><p></p></div><div data-role="career-report" hidden></div></div></main></body></html>';
async function main(){
  const browser=await chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const errors=[],results={baseline,browserVersion:browser.version(),fixture:{notes:report.inventory.notes.count,bytes:JSON.stringify(report).length},performance:[]};
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://career.test/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      if(url.pathname==='/api/career/report')return route.fulfill({json:{exists:true,report}});
      if(url.pathname==='/api/career/generate'){report=JSON.parse(JSON.stringify(report));report.inventory.notes.wordCount++;return route.fulfill({json:{id:'polish',status:'complete'}});}
      const name=url.pathname.startsWith('/assets/')?url.pathname.slice(1):'assets/'+url.pathname.slice(1);
      return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:source(name)});
    });
    await page.addInitScript(()=>{
      window.metrics={fills:0,graphs:0,live:new Set()};
      const fill=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(...args){metrics.fills++;return fill.apply(this,args);};
      let api;Object.defineProperty(window,'GraphEngine',{configurable:true,get:()=>api,set(value){api=value;const create=api.create;api.create=options=>{const engine=create(options),destroy=engine.destroy;metrics.graphs++;metrics.live.add(engine);window.lastGraph=engine;engine.destroy=()=>{metrics.live.delete(engine);return destroy();};return engine;};}});
    });
    async function open(){await page.goto('http://career.test/');await page.evaluate(async()=>{const {createCareer}=await import('/assets/career/lifecycle.js');window.career=createCareer(value=>window.frozen=value);await career.activate();});await page.waitForTimeout(1750);}
    const jump=key=>page.evaluate(key=>{const panel=document.querySelector(`[data-chart-key="${key}"]`).closest('.career-panel'),scroll=document.querySelector('.career-scroll');scroll.scrollTop+=panel.getBoundingClientRect().top-scroll.getBoundingClientRect().top-90;},key);
    await open();
    if(!perfOnly){
      assert(!baseline,'Functional acceptance targets the new implementation');
      await jump('note-network');await page.waitForFunction(()=>metrics.live.size>0);await page.waitForFunction(()=>[...metrics.live].every(e=>!e.layoutPending),null,{timeout:20000});
      await page.evaluate(()=>{
        window.originalGraph=lastGraph;window.originalCanvas=document.querySelector('[data-chart-key="note-network"] canvas');window.originalShell=document.querySelector('.career-report-shell');window.originalFilter=document.querySelector('.career-filter [data-mode="30"]');
        const details=document.querySelector('[data-chart-key="note-network"] details');details.open=true;
      });await page.waitForTimeout(60);
      await page.locator('[data-chart-key="note-network"] .career-more').evaluate(node=>node.click());
      const loaded=await page.locator('[data-chart-key="note-network"] tbody tr').count();
      await page.evaluate(()=>{originalFilter.focus({preventScroll:true});originalFilter.click();});await page.waitForTimeout(80);
      assert(await page.evaluate(()=>originalGraph===lastGraph&&originalCanvas===document.querySelector('[data-chart-key="note-network"] canvas')&&originalShell===document.querySelector('.career-report-shell')&&originalFilter===document.activeElement),'filter preserves inventory engine, canvas, shell and focus');
      assert.equal(await page.locator('[data-chart-key="note-network"] tbody tr').count(),loaded,'inventory detail pages retained');
      const writes=await page.evaluate(async()=>{let count=0;const observer=new MutationObserver(r=>count+=r.length);observer.observe(originalShell,{subtree:true,childList:true,characterData:true,attributes:true});originalFilter.click();await new Promise(r=>setTimeout(r,40));observer.disconnect();return count;});assert.equal(writes,0,'same filter causes no report DOM updates');
      const camera=await page.evaluate(()=>({...lastGraph.view}));
      await page.evaluate(()=>document.body.dataset.startTheme='dark');await page.waitForTimeout(80);
      assert(await page.evaluate(()=>originalGraph===lastGraph&&originalCanvas===document.querySelector('[data-chart-key="note-network"] canvas')),'theme reuses graph resources');
      assert.deepEqual(await page.evaluate(()=>({...lastGraph.view})),camera,'theme preserves camera');
      const graphBox=await page.locator('[data-chart-key="note-network"] canvas').boundingBox(),pressPoint={x:graphBox.x+graphBox.width/2,y:graphBox.y+graphBox.height/2};
      await page.mouse.move(pressPoint.x,pressPoint.y);await page.mouse.down();await page.evaluate(()=>document.body.dataset.startWorkspace='notes');
      await page.waitForTimeout(40);await page.evaluate(()=>document.body.dataset.startWorkspace='career');await page.waitForTimeout(100);
      await page.mouse.move(pressPoint.x+40,pressPoint.y+30);await page.mouse.up();await page.waitForTimeout(50);
      assert(await page.evaluate(()=>originalGraph===lastGraph&&originalCanvas===document.querySelector('[data-chart-key="note-network"] canvas')),'quick reversal keeps the original engine');
      assert.deepEqual(await page.evaluate(()=>({...lastGraph.view})),camera,'paused gesture cannot pan after quick return');
      assert.equal(await page.locator('.career-panel').first().evaluate(node=>getComputedStyle(node).borderTopWidth),'0px');
      await page.evaluate(()=>{document.body.dataset.startWorkspace='notes';window.delayedSwitchDone=false;setTimeout(()=>document.querySelector('.career-workspace').hidden=true,350);setTimeout(()=>{delayedSwitchDone=true;document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'notes'}}));},1200);});
      await page.waitForTimeout(70);assert(await page.evaluate(()=>metrics.live.size>0),'visible exit keeps its frozen drawing');
      await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>metrics.live.size),0,'hidden boundary releases before delayed next initialization');assert.equal(await page.evaluate(()=>delayedSwitchDone),false);assert.equal(await page.locator('.career-chart-tip').count(),0);
      await page.evaluate(()=>{document.documentElement.lang='en';document.dispatchEvent(new CustomEvent('relatum:languagechange'));});
      await page.waitForTimeout(800);
      await page.evaluate(async()=>{document.body.dataset.startWorkspace='career';document.querySelector('.career-workspace').hidden=false;await career.activate();});
      assert.equal(await page.locator('.career-hero h1').innerText(),'Usage report','hidden language change is applied on return');
      await jump('daily');await page.waitForTimeout(1100);await page.screenshot({path:path.join(out,'dark-en.png')});
      await page.evaluate(()=>{document.body.dataset.startTheme='light';document.documentElement.lang='zh-CN';document.dispatchEvent(new CustomEvent('relatum:languagechange'));});await page.waitForTimeout(1100);
      await jump('daily');await page.waitForTimeout(1100);await page.screenshot({path:path.join(out,'light-zh.png')});
      await page.setViewportSize({width:430,height:850});await jump('daily');await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'narrow-zh.png')});
      assert(await page.evaluate(()=>document.querySelector('.career-scroll').scrollWidth<=document.querySelector('.career-scroll').clientWidth+1),'narrow layout has no horizontal overflow');
      assert.equal(await page.locator('[data-chart-key="note-network"]').getAttribute('data-measured'),null,'width change discards the old offscreen pixel height');
      await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>document.body.dataset.startTheme='dark');await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
      await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});
      // Dense real-date paths keep every sample and isolated values, without all dots.
      await page.evaluate(async()=>{
        const {mountChart}=await import('/assets/career/charts.js'),{scheduler}=await import('/assets/career/motion.js');
        const host=document.createElement('div');host.className='career-chart-mount';document.querySelector('.career-workspace').append(host);window.denseHost=host;
        const rows=[];for(let i=0;i<365;i++){const date=new Date(2026,0,i+1,12);rows.push({date:`2026-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,seconds:147});}
        window.denseRuntime=mountChart(host,{type:'trend',key:'dense',rows,keys:['seconds']},{scheduler:scheduler(),legendState:new Map(),data:{start:'2026-01-01',end:'2026-12-31',collection:()=> 'on'}});
      });
      assert.equal(await page.locator('.career-series-line').last().getAttribute('d').then(d=>(d.match(/ L/g)||[]).length),364,'all real consecutive data remains in the path');
      assert.equal(await page.locator('main > .career-chart-mount .career-trend-point').count(),0,'dense continuous trend omits intermediate point DOM');
      assert(await page.locator('main > .career-chart-mount .career-axis-label').allTextContents().then(v=>v.includes('分钟 / 日')),'short duration axis uses minutes');
      await page.evaluate(()=>{
        denseRuntime.destroy();denseHost.remove();document.querySelector('.career-filter [data-mode="custom"]').click();
        const inputs=document.querySelectorAll('.career-custom-range input');inputs[0].value='2020-01-01';inputs[1].value='2020-01-30';document.querySelector('.career-custom-range button').click();
      });await page.waitForTimeout(50);
      assert(await page.locator('.career-history-empty').isVisible(),'empty range keeps inventory and reports its missing history');
      assert.equal(await page.locator('[data-chart-key="composition"]').getAttribute('data-preview-height'),null,'empty range discards its old SVG preview size');
      await page.locator('.career-filter [data-mode="all"]').evaluate(node=>node.click());await page.waitForTimeout(50);assert(await page.locator('.career-history-empty').isHidden());
      await page.evaluate(()=>document.dispatchEvent(new Event('pagehide')));assert.equal(await page.evaluate(()=>metrics.live.size),0);
      results.functional='passed';
    }else{
      for(const stress of [false,true]){
        const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:stress?4:1});
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:stress?2:1,mobile:false});
        for(let round=0;round<3;round++){
          await open();
          const filters=await page.evaluate(()=>{const times=[],stock=document.querySelector('[data-chart-key="note-size"]'),shell=document.querySelector('.career-report-shell');let stockReplaced=0,shellReplaced=0;for(const mode of ['30','90','year','all','30','all']){const start=performance.now();document.querySelector(`.career-filter [data-mode="${mode}"]`).click();times.push(performance.now()-start);if(stock!==document.querySelector('[data-chart-key="note-size"]'))stockReplaced++;if(shell!==document.querySelector('.career-report-shell'))shellReplaced++;}return{times,stockReplaced,shellReplaced};});
          await page.waitForTimeout(1200);
          const scrolling=await page.evaluate(async()=>{
            const scroll=document.querySelector('.career-scroll'),max=scroll.scrollHeight-scroll.clientHeight,values=[];scroll.scrollTop=0;
            let previous=0,start=0;await new Promise(resolve=>{function tick(now){if(!start)start=now;if(previous)values.push(now-previous);previous=now;const progress=Math.min(1,(now-start)/12000);scroll.scrollTop=max*progress;if(progress<1)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});
            return{values,height:max,fillCalls:metrics.fills,graphsCreated:metrics.graphs};
          });
          const r={stress,round,p95:percentile(scrolling.values),max:Math.max(...scrolling.values),over35:scrolling.values.filter(v=>v>35).length,frames:scrolling.values.length,height:scrolling.height,fillCalls:scrolling.fillCalls,graphsCreated:scrolling.graphsCreated,filterMs:filters.times,stockReplaced:filters.stockReplaced,shellReplaced:filters.shellReplaced};results.performance.push(r);process.stdout.write(JSON.stringify(r)+'\n');
          await page.evaluate(()=>document.dispatchEvent(new Event('pagehide')));assert.equal(await page.evaluate(()=>metrics.live.size),0);
        }
        await cdp.detach();
      }
    }
    assert.deepEqual(errors,[]);results.errors=errors;
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({results:path.join(out,'results.json')}));
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});

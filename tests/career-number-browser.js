'use strict';
// Real lifecycle/chapters/CSS; frozen synthetic report, disposable browser and data root.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..'),python=process.env.RELATUM_PYTHON;
async function main(){
  assert(python,'Set RELATUM_PYTHON to an actual Python executable');
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-career-numbers-'));
  execFileSync(python,['-B',path.join(__dirname,'career-v2-fixture.py')],{cwd:root,env:{...process.env,RELATUM_DATA_ROOT:dataRoot},windowsHide:true,timeout:180000});
  const report=JSON.parse(fs.readFileSync(path.join(dataRoot,'data','career-report-v2.json'),'utf8'));
  report.history.days=[{date:new Date(report.history.cutoff).toISOString().slice(0,10),seconds:7200.25,categories:{notes:7200.25}}];
  report.inventory.notes.wordCount=100000000;
  const browser=await chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const results=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const html='<html lang="zh-CN"><head><style>body{margin:0;font-family:Segoe UI,sans-serif;--bg:#fbfaf7}.career-workspace{height:100vh}</style></head><body class="start-page" data-start-theme="light"><main class="career-workspace"><div class="career-entry" data-role="career-entry"><p></p><h1></h1><button></button></div><div data-role="career-loading" hidden><strong></strong><p></p></div><div class="career-scroll" data-role="career-scroll"><div data-role="career-report" hidden></div></div></main></body></html>';
    await page.route('http://career.test/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      if(url.pathname==='/api/career/report')return route.fulfill({json:{exists:true,report}});
      if(url.pathname==='/api/career/generate'){report.inventory.notes.wordCount++;return route.fulfill({json:{id:'test',status:'complete'}});}
      const file=path.join(root,url.pathname.startsWith('/assets/')?url.pathname.slice(1):'assets/'+url.pathname.slice(1));
      return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file,'utf8')});
    });
    async function open({language='zh-CN',reduced=false}={}){
      await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});await page.goto('http://career.test/');
      await page.evaluate(async language=>{
        document.documentElement.lang=language;window.RelatumI18n={language};
        const {createCareer}=await import('/assets/career/lifecycle.js');
        window.probe={started:{},writes:[],activated:0};
        new MutationObserver(records=>{for(const record of records){const node=(record.type==='characterData'?record.target.parentElement:record.target)?.closest?.('[data-career-number]');
          if(!node)continue;const key=node.dataset.metricKey;
          if(record.type==='attributes'&&node.dataset.counted==='1')probe.started[key]??=performance.now();
          if(record.type==='characterData')probe.writes.push({key,text:record.target.data,at:performance.now()});
        }}).observe(document.querySelector('[data-role="career-report"]'),{attributes:true,attributeFilter:['data-counted'],characterData:true,subtree:true});
        window.career=createCareer(()=>{});await career.activate();probe.activated=performance.now();
      },language);
    }
    const displayed=key=>page.locator(`[data-metric-key="${key}"] .career-number-value`);
    const actual=key=>page.evaluate(key=>{const node=document.querySelector(`[data-metric-key="${key}"]`);return node._numberText?.data??node.textContent;},key);
    const assertFinal=async key=>assert(await page.evaluate(key=>{const node=document.querySelector(`[data-metric-key="${key}"]`);return (node._numberText?.data??node.textContent)===node._format(Number(node.dataset.careerNumber));},key),key+' final value');
    const jump=async key=>page.evaluate(key=>{const node=document.querySelector(`[data-metric-key="${key}"]`);const scroll=document.querySelector('.career-scroll');scroll.scrollTop+=node.getBoundingClientRect().top-scroll.getBoundingClientRect().top-100;},key);
    await open();assert.equal(await actual('usage'),'0 小时');
    await page.waitForTimeout(100);assert.equal(await actual('note-words'),'0','entrance delay keeps zero');
    assert.equal(await page.locator('[data-metric-key="canvas-count"]').getAttribute('data-counted'),null,'offscreen preparation does not count');
    assert.equal(await page.locator('.career-number-reserve').first().getAttribute('aria-hidden'),'true');
    const samples=await page.evaluate(async()=>{
      const node=document.querySelector('[data-metric-key="note-words"]'),strip=node.closest('.career-hero-metrics'),out=[];const start=performance.now();
      await new Promise(resolve=>{function tick(now){const a=node.getBoundingClientRect(),b=strip.getBoundingClientRect();out.push({at:now,value:node._numberText.data,width:a.width,height:a.height,stripHeight:b.height});if(now-start<1750)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return out;
    });
    assert.equal(new Set(samples.map(s=>s.width+','+s.height+','+s.stripHeight)).size,1,'large numbers reserve stable dimensions');
    await assertFinal('usage');await assertFinal('note-words');
    const probe=await page.evaluate(()=>probe);
    assert(probe.started['note-words']-probe.activated>=170,'first count starts after the entrance delay');
    const wordValues=probe.writes.filter(w=>w.key==='note-words').map(w=>Number(w.text.replaceAll(',','')));
    assert(wordValues.every((v,i)=>!i||v>=wordValues[i-1]),'visible count is monotonic');
    assert(probe.writes.filter(w=>w.key==='usage').every(w=>w.text.endsWith(' 小时')),'duration keeps hours');
    assert(probe.writes.filter(w=>w.key==='active-days'||w.key==='longest-streak').every(w=>/^\d+$/.test(w.text)),'days only display integers');
    results.push({scenario:'wide',frames:samples.length,stableDimensions:true,entranceDelayMs:probe.started['note-words']-probe.activated});

    // Less than 15% visibility keeps the counter at zero; crossing it starts counting.
    await page.evaluate(()=>{const node=document.querySelector('[data-metric-key="canvas-count"]'),scroll=document.querySelector('.career-scroll'),a=node.getBoundingClientRect(),b=scroll.getBoundingClientRect();scroll.scrollTop+=a.top-b.bottom+a.height*.1;});
    await page.waitForTimeout(180);assert.equal(await page.locator('[data-metric-key="canvas-count"]').getAttribute('data-counted'),null,'10% visibility is below the threshold');
    await page.evaluate(()=>document.querySelector('.career-scroll').scrollTop+=30);
    await page.waitForFunction(()=>document.querySelector('[data-metric-key="canvas-count"]').dataset.counted==='1');
    await page.waitForTimeout(250);
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='1';window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    await assertFinal('canvas-count');await assertFinal('embedded-count');
    await page.evaluate(()=>{delete document.documentElement.dataset.desktopMinimized;window.dispatchEvent(new Event('canvasdesktop:visibility'));});
    await page.waitForTimeout(100);await assertFinal('canvas-count');
    await jump('note-words');await page.waitForTimeout(150);
    await assertFinal('note-words');
    await page.evaluate(()=>document.body.dataset.startTheme='dark');await page.waitForTimeout(100);await assertFinal('note-words');
    await page.evaluate(()=>{RelatumI18n.language='en';document.dispatchEvent(new Event('relatum:languagechange'));});await page.waitForTimeout(100);
    await assertFinal('note-words');assert.equal(await actual('usage'),'2 h');
    await page.locator('.career-filter [data-mode="30"]').click();await assertFinal('note-words');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'notes'}})));
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'career'}})));await page.waitForTimeout(100);await assertFinal('note-words');
    const writesBefore=await page.evaluate(()=>probe.writes.length);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>probe.writes.length),writesBefore,'return/rebuild does not restart counting');
    await page.evaluate(()=>career.generate());await page.waitForTimeout(50);
    assert.notEqual(await actual('note-words'),'100,000,001','new generation resets presentation');
    await page.waitForTimeout(1700);await assertFinal('note-words');
    const idle=await page.evaluate(async()=>{let frames=0;const original=requestAnimationFrame;window.requestAnimationFrame=fn=>{frames++;return original(fn);};await new Promise(r=>setTimeout(r,500));window.requestAnimationFrame=original;return frames;});assert.equal(idle,0);
    results.push({scenario:'threshold/minimize/return/rebuild/generate',idleFrames:idle});

    await page.setViewportSize({width:430,height:850});await open({language:'en'});
    const narrow=await page.evaluate(async()=>{const node=document.querySelector('[data-metric-key="note-words"]'),sizes=[];await new Promise(resolve=>{const start=performance.now();function tick(now){const r=node.getBoundingClientRect();sizes.push(r.width+','+r.height);if(now-start<1850)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return sizes;});
    assert.equal(new Set(narrow).size,1,'narrow wrapping is stable');await assertFinal('note-words');
    assert(await page.evaluate(()=>document.querySelector('.career-scroll').scrollWidth<=document.querySelector('.career-scroll').clientWidth+2));
    // Hiding during a new animation finalizes it, with no late writes on return.
    await open();await page.waitForTimeout(450);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await assertFinal('note-words');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(100);await assertFinal('note-words');
    await open();await page.waitForTimeout(450);await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(50);await assertFinal('note-words');await assertFinal('canvas-count');
    const reducedWrites=await page.evaluate(()=>probe.writes.length);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>probe.writes.length),reducedWrites,'switching reduced motion cancels current and pending counts');
    await open({reduced:true});await assertFinal('note-words');assert.equal(await page.locator('.career-number-value').count(),0);assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
    results.push({scenario:'narrow/hidden/reduced',stableDimensions:true});
    await page.setViewportSize({width:1440,height:1000});await open();await jump('canvas-count');await page.waitForTimeout(450);
    assert.equal(await page.locator('[data-metric-key="note-words"]').getAttribute('data-counted'),null,'fast scroll cancels a pending unseen count');
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await assertFinal('canvas-count');
    const hiddenWrites=await page.evaluate(()=>probe.writes.length);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>probe.writes.length),hiddenWrites,'pagehide rejects late work');
    await open();await page.waitForTimeout(450);
    await page.evaluate(()=>{
      document.dispatchEvent(new CustomEvent('relatum:career-scroll-feel',{detail:{pauseReveal:true,inertia:0}}));
      const scroll=document.querySelector('.career-scroll');scroll.dispatchEvent(new Event('scroll'));
      window.pauseTimer=setInterval(()=>scroll.dispatchEvent(new Event('scroll')),15);
    });
    const pausedValue=await actual('note-words');await page.waitForTimeout(300);assert.equal(await actual('note-words'),pausedValue,'scroll-pause preference freezes an active count');
    await page.evaluate(()=>clearInterval(pauseTimer));await page.waitForTimeout(1600);await assertFinal('note-words');
    for(const seconds of [12.125,125.25]){
      report.history.days[0].seconds=seconds;await open({language:'en'});
      const unit=seconds<60?'s':'min';assert.equal(await actual('usage'),'0 '+unit);await page.waitForTimeout(1850);await assertFinal('usage');
      assert((await page.evaluate(()=>probe.writes.filter(w=>w.key==='usage'))).every(w=>w.text.endsWith(' '+unit)));
    }
    report.inventory.notes.wordCount=null;report.inventory.canvas.count=0;await open();
    assert.equal(await page.locator('.career-hero-metric strong').nth(3).innerText(),'—','unknown stays unknown');
    assert.equal(await actual('canvas-count'),'0');assert.equal(await page.locator('[data-metric-key="canvas-count"] .career-number-value').count(),0,'zero is static');
    results.push({scenario:'fast-scroll/pagehide/scroll-pause/fractional-duration/unknown/zero'});
    assert.deepEqual(errors,[]);console.log(JSON.stringify({careerNumbers:results,errors,browserVersion:browser.version()}));
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

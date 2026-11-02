'use strict';
// Real queue/API recovery followed by deterministic lifecycle races. Disposable data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const repo=path.resolve(__dirname,'..'),python=process.env.RELATUM_PYTHON;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;}
async function main(){
  assert(python,'Set RELATUM_PYTHON');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-career-regeneration-'));
  execFileSync(python,['-B',path.join(__dirname,'career-v2-fixture.py')],{cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,timeout:180000});
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'fixture-manifest.json'),'utf8'));
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const server=spawn(python,['-B','app.py','--no-browser','--port',String(port)],{cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='',browser;server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
  try{
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/runtime')).ok)break;}catch(_){}await delay(100);}
    assert.equal(path.resolve((await(await fetch(base+'/api/runtime')).json()).root),path.resolve(root));
    browser=await chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
    page.on('pageerror',error=>errors.push(error.message));
    let failUsage=true,generatePosts=0;const attempts=[];
    await page.route('**/api/usage/batch',async route=>{
      attempts.push({failed:failUsage,body:route.request().postDataJSON()});
      if(failUsage)return route.fulfill({status:503,json:{error:'统计暂未写入，请重试'}});
      return route.continue();
    });
    await page.route('**/api/career/generate',route=>{generatePosts++;return route.continue();});
    await page.addInitScript(()=>{
      localStorage.setItem('canvas:startWorkspace:v1','career');localStorage.setItem('canvas:toolbarLanguage','zh-CN');
      sessionStorage.setItem('relatum:usage-owner','regeneration-test');
      const at=Date.now();localStorage.setItem('canvas:usageQueue:v2:regeneration-test',JSON.stringify({at,items:[
        {type:'interval',id:'recovered-note',category:'notes',locator:'Note 0001.md',start:at-30000,end:at-1000},
        {type:'interval',id:'recovered-embedded',category:'embedded',locator:'canvases/shared.canvas',start:at-20000,end:at-1000}
      ]}));
    });
    await page.goto(base);await page.waitForSelector('.career-report-shell');await page.waitForTimeout(700);
    await page.waitForFunction(()=>RelatumUsage.pending===2);
    const initialDate=await page.evaluate(()=>RelatumCareerReport.report.generatedAt);
    await page.evaluate(()=>{const s=document.querySelector('.career-scroll');s.scrollTop=document.querySelector('#career-range').offsetTop;});
    failUsage=false;
    await page.locator('.career-regenerate').focus();await page.keyboard.press('Enter');
    const departing=await page.evaluate(()=>({busy:document.querySelector('.career-workspace').getAttribute('aria-busy'),inert:document.querySelector('.career-scroll').inert,durations:document.querySelector('.career-scroll').getAnimations().map(a=>a.effect.getTiming().duration)}));
    assert.equal(departing.busy,'true');assert(departing.inert);assert(departing.durations.includes(180),'generation fades out before blank waiting');
    await page.waitForFunction(date=>RelatumCareerReport.report.generatedAt!==date,initialDate);
    const arriving=await page.evaluate(()=>({top:document.querySelector('.career-scroll').scrollTop,durations:document.querySelector('.career-scroll').getAnimations().map(a=>a.effect.getTiming().duration),pending:RelatumUsage.pending}));
    assert.equal(arriving.top,0);assert.equal(arriving.pending,0);assert(arriving.durations.includes(600));assert.equal(generatePosts,1);
    for(const failed of [true,false])assert(attempts.some(a=>a.failed===failed&&a.body.intervals.some(r=>r.id==='recovered-embedded')),'retry retains original embedded receipt');
    await page.waitForTimeout(700);await page.screenshot({path:path.join(root,'regenerated-light.png')});
    checks.push('durable mixed queue, real API generation, keyboard, 180/600ms transition');

    await page.evaluate(()=>{window.savedPanel=document.querySelector('[data-chart-key="note-size"]');window.savedShell=document.querySelector('.career-report-shell');document.querySelector('.career-filter [data-mode="custom"]').click();});
    assert.match(await page.locator('[data-note-usage="all"]').textContent(),/所选日期/);
    await page.evaluate(()=>document.querySelector('.career-filter [data-mode="all"]').click());
    assert(!(await page.locator('[data-note-usage="all"]').textContent()).includes('所选日期'));
    assert(await page.evaluate(()=>savedPanel===document.querySelector('[data-chart-key="note-size"]')&&savedShell===document.querySelector('.career-report-shell')));
    checks.push('same-range filters update labels and retain inventory DOM');

    await page.evaluate(()=>{window.savedUsage=RelatumUsage;window.RelatumUsage={flush:async()=>{throw new Error('disk unavailable');}};const s=document.querySelector('.career-scroll');s.scrollTop=document.querySelector('#career-notes').offsetTop+80;window.savedTop=s.scrollTop;window.savedHeight=s.scrollHeight;});
    await page.evaluate(()=>RelatumCareerReport.generate());
    await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    assert.match(await page.locator('[data-career-message]').textContent(),/使用记录尚未提交/);
    const restored=await page.evaluate(()=>({top:document.querySelector('.career-scroll').scrollTop,savedTop,height:document.querySelector('.career-scroll').scrollHeight,savedHeight}));
    assert(Math.abs(restored.top-restored.savedTop)<2&&Math.abs(restored.height-restored.savedHeight)<2,JSON.stringify(restored));
    assert(await page.locator('[data-career-message]').evaluate(n=>!n.closest('.career-scroll')),'feedback does not participate in report layout');
    assert.equal(generatePosts,1,'queue failure never starts generation');
    await page.evaluate(()=>RelatumI18n.setLanguage('en'));
    assert.match(await page.locator('[data-career-message]').textContent(),/Usage records have not been submitted/);
    const feedback=await page.locator('[data-career-message]').boundingBox();assert(feedback.y>=0&&feedback.y<100,'failure feedback is in the viewport');
    await page.setViewportSize({width:520,height:820});await page.evaluate(()=>{document.body.dataset.startTheme='dark';});
    await page.waitForTimeout(1000);
    await page.screenshot({path:path.join(root,'failure-dark-narrow.png')});
    await page.getByRole('button',{name:'Dismiss message'}).click();assert(await page.locator('[data-career-message]').isHidden());
    checks.push('failure preserves anchor/report geometry and localizes viewport feedback');

    // Keep the production lifecycle; control only server timing and revisions.
    await page.evaluate(()=>{window.RelatumUsage={flush:()=>new Promise(resolve=>window.releaseReducedFlush=resolve)};void RelatumCareerReport.generate();});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.querySelector('.career-scroll').getAnimations().length===0);
    assert.equal(await page.locator('.career-scroll').evaluate(n=>getComputedStyle(n).opacity),'0');
    await page.evaluate(()=>releaseReducedFlush());
    await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    checks.push('enabling reduced motion during departure settles the fade without blocking generation');
    await page.setViewportSize({width:1440,height:1000});
    let frozen=await page.evaluate(()=>RelatumCareerReport.report),revision=frozen.history.archiveRevision||0,complete=false,holdNext=false,releasePost=null,held=false,fakePosts=0,failNextPost=false,failNextReport=false;
    await page.route('**/api/usage/management',route=>route.fulfill({json:{archiveRevision:revision}}));
    await page.route('**/api/career/report',route=>{
      if(failNextReport){failNextReport=false;return route.fulfill({status:503,json:{error:'snapshot unavailable'}});}
      return route.fulfill({json:{exists:true,report:{...frozen,generatedAt:new Date().toISOString(),history:{...frozen.history,archiveRevision:revision}}}});
    });
    await page.unroute('**/api/career/generate');
    await page.route('**/api/career/generate',async route=>{
      fakePosts++;
      if(failNextPost){failNextPost=false;return route.fulfill({status:503,json:{error:'generator unavailable'}});}
      if(holdNext){holdNext=false;held=true;const outcome=await new Promise(resolve=>releasePost=resolve);return route.fulfill(outcome);}
      return route.fulfill({json:{id:'current-job',status:'running',progress:10,stage:'notes'}});
    });
    let polls=0;
    await page.route('**/api/career/jobs/*',route=>{polls++;return route.fulfill({json:{id:'current-job',status:complete?'complete':'running',progress:complete?100:10,stage:complete?'complete':'notes'}});});
    for(const scenario of ['old-flush-failure','old-post-failure','old-post-success']){
      complete=false;held=false;
      if(scenario==='old-flush-failure')await page.evaluate(()=>{window.RelatumUsage={flush:()=>new Promise((resolve,reject)=>window.rejectOldFlush=reject)};void RelatumCareerReport.generate();});
      else{holdNext=true;await page.evaluate(()=>{window.RelatumUsage={flush:async()=>true};void RelatumCareerReport.generate();});for(let i=0;i<100&&!held;i++)await delay(10);assert(held);}
      revision++;
      await page.evaluate(rev=>document.dispatchEvent(new CustomEvent('relatum:usage-archived',{detail:{archiveRevision:rev}})),revision);
      await page.waitForFunction(rev=>RelatumCareerReport.report?.history.archiveRevision===rev,revision);
      await page.evaluate(()=>{window.RelatumUsage={flush:async()=>true};void RelatumCareerReport.generate();});
      await page.waitForFunction(()=>document.querySelector('[data-career-message]').textContent.includes('10%'));
      if(scenario==='old-flush-failure')await page.evaluate(()=>rejectOldFlush(new Error('old queue failed')));
      else releasePost(scenario==='old-post-failure'?{status:503,json:{error:'old request failed'}}:{json:{id:'obsolete-job',status:'complete'}});
      await page.waitForTimeout(80);
      assert.equal(await page.locator('.career-workspace').getAttribute('aria-busy'),'true',scenario);
      assert.equal(await page.locator('[data-career-message]').getAttribute('class'),'career-inline-error',scenario);
      assert(await page.locator('.career-regenerate').isDisabled(),scenario+' cannot unlock new generation');
      complete=true;await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    }
    checks.push('archive races reject stale flush failures, POST failures and POST successes');

    failNextPost=true;
    await page.evaluate(()=>RelatumCareerReport.generate());
    await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    assert.match(await page.locator('[data-career-message]').textContent(),/Could not generate the report.*generator unavailable/);
    complete=true;failNextReport=true;
    await page.evaluate(()=>RelatumCareerReport.generate());
    await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    assert.match(await page.locator('[data-career-message]').textContent(),/The new report could not load.*snapshot unavailable/);
    assert(await page.evaluate(()=>!!RelatumCareerReport.report&&!!document.querySelector('.career-report-shell')));
    checks.push('generation and snapshot loading failures preserve the old report with distinct feedback');

    complete=false;const beforeDuplicate=fakePosts;
    await page.evaluate(()=>{void RelatumCareerReport.generate();void RelatumCareerReport.generate();});
    await page.waitForFunction(()=>document.querySelector('[data-career-message]').textContent.includes('10%'));
    assert.equal(fakePosts,beforeDuplicate+1,'duplicate clicks only submit one generation');
    await page.evaluate(()=>{document.body.dataset.startWorkspace='notes';document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'notes'}}));});
    const awayPolls=polls;await page.waitForTimeout(650);assert.equal(polls,awayPolls,'leaving pauses polling before the outer exit finishes');
    await page.evaluate(()=>{document.body.dataset.startWorkspace='career';document.dispatchEvent(new CustomEvent('relatum:start-workspacechange',{detail:{workspace:'career'}}));});
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    const hiddenPolls=polls;await page.waitForTimeout(650);assert.equal(polls,hiddenPolls,'hidden generation does not poll');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='1';window.dispatchEvent(new CustomEvent('canvasdesktop:visibility',{detail:{minimized:true}}));});
    const pausedPolls=polls;await page.waitForTimeout(650);assert.equal(polls,pausedPolls);
    complete=true;
    await page.evaluate(()=>{document.documentElement.dataset.desktopMinimized='0';window.dispatchEvent(new CustomEvent('canvasdesktop:visibility',{detail:{minimized:false}}));});
    await page.waitForFunction(()=>!document.querySelector('.career-workspace').hasAttribute('aria-busy'));
    assert.equal(await page.locator('.career-scroll').evaluate(n=>n.getAnimations().length),0,'reduced motion has no fade');
    checks.push('duplicate clicks, workspace exits, hiding, native visibility notification, resumed polling, reduced motion');
    await page.waitForTimeout(100);
    const idle=await page.evaluate(async()=>{let frames=0;const original=requestAnimationFrame;window.requestAnimationFrame=fn=>{frames++;return original(fn);};await new Promise(resolve=>setTimeout(resolve,250));window.requestAnimationFrame=original;return frames;});assert.equal(idle,0);
    for(const [name,hash] of Object.entries(manifest.content))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),hash,name+' content unchanged');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(root,'regeneration-checks.json'),JSON.stringify({checks,idle,errors},null,2));
    console.log(JSON.stringify({checks,root,idle}));
  }catch(error){console.error(logs.slice(-2500));throw error;}
  finally{await browser?.close();if(server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

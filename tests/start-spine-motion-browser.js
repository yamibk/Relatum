'use strict';

// Test-host Playwright/Edge only. All probes are injected; product assets and personal
// data are never rewritten. --compare alternates HEAD and working-tree assets 3 times.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const current = {
  js: fs.readFileSync(path.join(repo, 'assets/start.js'), 'utf8'),
  css: fs.readFileSync(path.join(repo, 'assets/styles.css'), 'utf8'),
};
const html = fs.readFileSync(path.join(repo, 'assets/index.html'), 'utf8');
const navStart = html.indexOf('<nav class="left-spine"');
const nav = html.slice(navStart, html.indexOf('</nav>', navStart) + 6);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-spine-motion-'));
const report = { browser: '', measuredAt: new Date().toISOString(), checks: [], samples: [] };

function exposeProbe(js) {
  const modern = js.includes('function renderSpineMotion()');
  return `window.S = {
    sync: syncActiveSpineOrb, clear: clearSpineHover,
    state: () => ({state: spineMarkerState, key: spineMarkerTargetKey,
      breathe: spineBreatheTimer, settle: spineMarkerSettleTimer,
      transition: spineMarkerTransitionFrame, ready: spineMarkerReady,
      frame: ${modern ? 'spineRenderFrame' : '0'}})
  };`;
}

function installCounters() {
  const spine = document.querySelector('.left-spine');
  const observed = new MutationObserver(() => {});
  observed.observe(spine, { subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-shape'] });
  const indicator = element => element === spine || element.matches('.spine-active-orb,.spine-hover-orb,.spine-hover-rail,.dot-bubble');
  let lastMutations = false;
  window.C = { spine: 0, target: 0, frames: 0, readAfterWrite: 0, writes: 0 };
  function collect() {
    const count = observed.takeRecords().filter(record => indicator(record.target)).length;
    C.writes += count;
    if (count) lastMutations = true;
  }
  const get = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this === spine || this.matches('.left-spine .study-spine-tab,.left-spine .page-dot')) {
      collect();
      if (lastMutations) C.readAfterWrite++;
      if (this === spine) C.spine++; else C.target++;
    }
    return get.call(this);
  };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = callback => raf.call(window, stamp => {
    if (callback.name === 'renderSpineMotion' || callback.name === 'syncActiveSpineOrb') {
      collect(); lastMutations = false; C.frames++;
    }
    callback(stamp);
    collect();
  });
  window.resetCounters = () => {
    observed.takeRecords(); lastMutations = false;
    for (const key of Object.keys(C)) C[key] = 0;
  };
  window.counters = () => { collect(); return { ...C }; };
}

async function motionPage(browser, assets, config, counters = false) {
  const modern = assets.js.includes('function renderSpineMotion()');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    deviceScaleFactor: config.dpr, reducedMotion: config.reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.testErrors = [];
  page.on('pageerror', error => page.testErrors.push(error.message));
  await page.setContent(`<!doctype html><meta charset="utf-8"><body class="start-page"
    data-start-theme="${config.theme}" data-start-workspace="canvas" data-start-state="study">
    <section class="recent-view book-view" style="position:relative;height:calc(100vh - 50px)">${nav}</section></body>`);
  await page.addStyleTag({ content: assets.css });
  const declarations = assets.js.slice(assets.js.indexOf('  const spineActiveOrb ='), assets.js.indexOf('  const fileList ='));
  const motion = assets.js.slice(assets.js.indexOf('  // 书脊滑块的两种形状'), assets.js.indexOf('  function listViewName()'));
  const bindingStart = assets.js.indexOf('  bindStaticSpineHoverTargets();', assets.js.indexOf('// 两套滚动系统'));
  const bindings = assets.js.slice(bindingStart, assets.js.indexOf('  const SPINE_WHEEL_REACH', bindingStart));
  await page.addScriptTag({ content: `
    const spineEl = document.querySelector('.left-spine'), bookView = document.querySelector('.book-view');
    const dots = document.querySelector('[data-role="page-dots"]');
    ${declarations}
    let studyActive=false, cadenceActive=false, treePageActive=false, notesActive=false,
      calendarActive=false, reviewActive=false, focusActive=false;
    const FAVORITES_PAGE='__favorites__', INBOX_PAGE='__inbox__', lastGroups=[];
    for (const [id, name] of [['','最近'], [FAVORITES_PAGE,'收藏'], [INBOX_PAGE,'未分组']]) {
      const b=document.createElement('button'); b.className='page-dot'; b.dataset.groupId=id;
      b.innerHTML='<span class="dot-bubble">'+name+'</span>'; dots.append(b);
    }
    ${motion}
    ${bindings}
    dots.querySelectorAll('.page-dot').forEach(bindSpineHoverTarget);
    ${exposeProbe(assets.js)}
    const targets=[...spineEl.querySelectorAll('.study-spine-tab,.page-dot:not(.dot-add)')];
    S.activate = (index, options) => {
      targets.forEach(t => t.classList.remove('active')); targets[index].classList.add('active');
      ${modern ? 'syncActiveSpineOrb(options)' : 'options ? requestAnimationFrame(() => syncActiveSpineOrb(options)) : requestAnimationFrame(syncActiveSpineOrb)'};
    };
    S.hover = index => targets[index].dispatchEvent(new PointerEvent('pointerenter'));
    S.targets = targets;
    S.activate(5, {animate:false});
  ` });
  await frame(page); await page.waitForTimeout(420);
  if (counters) await page.evaluate(installCounters);
  return page;
}

async function alignment(page, animated = false) {
  return page.evaluate(animated => {
    const active = document.querySelector('.study-spine-tab.active,.page-dot.active');
    const spine = document.querySelector('.left-spine'), orb = spine.querySelector('.spine-active-orb');
    const a = active.getBoundingClientRect(), b = orb.getBoundingClientRect();
    const key = S.state().key;
    const target = [...spine.querySelectorAll('.study-spine-tab,.page-dot')].find(t =>
      (t.classList.contains('page-dot') ? 'page:'+(t.dataset.groupId||'recent') : 'tab:'+t.dataset.action) === key);
    const m = target?.getBoundingClientRect(), h = spine.querySelector('.spine-hover-orb').getBoundingClientRect();
    const r = spine.querySelector('.spine-hover-rail').getBoundingClientRect();
    return { error: Math.hypot(a.x+a.width/2-b.x-b.width/2, a.y+a.height/2-b.y-b.height/2),
      markerError: m ? Math.hypot(m.x+m.width/2-h.x-h.width/2, m.y+m.height/2-h.y-h.height/2) : Infinity,
      railError: m ? Math.abs(m.y+m.height/2-r.y-r.height/2) : Infinity,
      markerTransitions: [...spine.querySelectorAll('.spine-hover-orb,.spine-hover-rail')]
        .flatMap(el=>el.getAnimations()).filter(a=>a.transitionProperty && a.playState==='running').length,
      transitions: orb.getAnimations().filter(a => a.transitionProperty && a.playState === 'running').length,
      opacity: getComputedStyle(orb).opacity, color: getComputedStyle(orb).backgroundColor,
      shape: orb.dataset.shape, width: b.width, animated };
  }, animated);
}

async function behaviorChecks(browser, config) {
  const page = await motionPage(browser, current, config, true);
  try {
    const burst = await page.evaluate(async () => {
      resetCounters();
      for (let i=0; i<70; i++) S.hover(i%S.targets.length);
      const before = counters();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return { before, after: counters(), state: S.state() };
    });
    assert.equal(burst.before.spine + burst.before.target, 0, 'hover input must not synchronously measure');
    assert.equal(burst.after.frames, 1, '70 hover inputs share one render');
    assert.equal(burst.after.spine, 1);
    assert.equal(burst.after.target, 2, 'active and final preview are each measured once, including its tooltip');
    assert.equal(burst.after.readAfterWrite, 0);
    assert.equal(burst.state.key, 'page:__inbox__');

    await page.evaluate(() => S.clear({animate:false})); await frame(page);
    const activeBurst = await page.evaluate(async () => {
      resetCounters();
      for(let i=0;i<20;i++) S.activate(i%7);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return {counters:counters(),state:S.state()};
    });
    assert.equal(activeBurst.counters.frames, 1);
    assert.equal(activeBurst.counters.spine, 1);
    assert.equal(activeBurst.counters.target, 1, 'matching active and marker reuse their geometry');
    assert.equal(activeBurst.counters.readAfterWrite, 0);
    await page.waitForTimeout(430);
    const repeated = await page.evaluate(async () => {
      const timer=S.state().breathe;
      resetCounters(); for(let i=0;i<20;i++) S.sync();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return {timer,after:S.state().breathe,counters:counters()};
    });
    assert.equal(repeated.after, repeated.timer, 'unchanged state keeps its existing breath deadline');
    assert.equal(repeated.counters.writes, 0, 'unchanged requests must not rewrite indicator styles/classes');
    await page.evaluate(()=>resetCounters());await page.waitForTimeout(120);
    assert.equal(await page.evaluate(()=>counters().frames),0,'settled motion leaves no animation-frame loop');

    // A cancelled return must never settle or redirect a newer preview.
    await page.evaluate(() => { S.hover(0); }); await frame(page);
    await page.evaluate(() => S.clear()); await frame(page); await page.waitForTimeout(70);
    await page.evaluate(() => S.hover(6)); await frame(page); await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => [S.state().state,S.state().key]), ['preview','tab:focus-view']);
    await page.evaluate(() => { S.clear(); S.activate(1); }); await frame(page);
    await page.waitForTimeout(430);
    assert.deepEqual(await page.evaluate(() => [S.state().state,S.state().key]), ['resting','tab:calendar-view']);

    // Retargeting in the middle of a CSS transition starts from the displayed position.
    if (!config.reduced) {
      await page.evaluate(() => S.activate(6)); await frame(page); await page.waitForTimeout(65);
      const reverse = await page.evaluate(async () => {
        const orb=document.querySelector('.spine-active-orb');
        const y=()=>new DOMMatrix(getComputedStyle(orb).transform).f;
        const before=y(); S.activate(0);
        const synchronous=y(); await new Promise(requestAnimationFrame);
        const next=y(); await new Promise(resolve=>setTimeout(resolve,460));
        return {before,synchronous,next,final:y()};
      });
      assert(Math.abs(reverse.before-reverse.synchronous)<1, 'input does not reset to an old endpoint');
      assert(reverse.next > reverse.final+10, 'reversal stays between the current position and its target');
    }
    for (const [index,shape,size] of [[7,'dot',12],[8,'star',18],[5,'tab',34]]) {
      await page.evaluate(index => {S.clear();S.activate(index);},index);
      await page.waitForTimeout(config.reduced ? 50 : 480);
      const state=await alignment(page);
      assert.equal(state.shape,shape); assert(Math.abs(state.width-size)<.1);
      assert(state.error<1.1, 'settled entity aligns with its icon: '+JSON.stringify(state));
      assert.equal(state.opacity,'1');
      assert.equal(state.color,config.theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');
    }

    await page.setViewportSize({width:680,height:570}); await frame(page);
    const resized=await alignment(page);
    assert(resized.error<1.1 && resized.markerError<1.1 && resized.railError<1.1
      && resized.transitions===0 && resized.markerTransitions===0, 'resize must instantly align both layers');
    await page.locator('.calendar-spine-tab').focus(); await frame(page);
    assert.equal(await page.evaluate(()=>S.state().key),'tab:calendar-view');
    await page.keyboard.press('Tab'); await frame(page);
    assert.equal(await page.evaluate(()=>S.state().key),'tab:cadence-view');
    await page.evaluate(()=>S.clear({animate:false})); await frame(page);
    await page.locator('.left-spine').evaluate(el=>el.classList.add('notes-search-active'));await frame(page);
    if(!config.reduced)assert((await page.locator('.spine-active-orb').evaluate(el=>el.getAnimations().length))>0);

    // Hide between input and render; even a browser that still considers the native
    // minimized page visible must not execute pending geometry or delayed glows.
    const minimized=await page.evaluate(async()=>{
      resetCounters();S.hover(0);
      document.documentElement.dataset.desktopMinimized='1';
      for(let i=0;i<2;i++) window.dispatchEvent(new CustomEvent('canvasdesktop:visibility',{detail:{minimized:true}}));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      return {state:S.state(),counts:counters()};
    });
    assert.equal(minimized.counts.spine+minimized.counts.target,0);
    for(const name of ['breathe','settle','transition','frame'])assert.equal(minimized.state[name],0);
    await page.waitForTimeout(2900);
    assert.equal(await page.locator('.orb-breathing').count(),0);
    assert.equal(await page.locator('.spine-active-orb').evaluate(el=>el.getAnimations().length),0);
    await page.evaluate(()=>{
      document.documentElement.dataset.desktopMinimized='0';
      for(let i=0;i<2;i++)window.dispatchEvent(new CustomEvent('canvasdesktop:visibility',{detail:{minimized:false}}));
      document.querySelector('.left-spine').classList.remove('notes-search-active');
    }); await frame(page);
    assert((await alignment(page)).error<1.1);
    for(const hidden of [true,false]){
      await page.evaluate(hidden=>{
        Object.defineProperty(document,'hidden',{configurable:true,value:hidden});
        document.dispatchEvent(new Event('visibilitychange'));
      },hidden);await frame(page);
      if(hidden)assert.equal((await page.evaluate(()=>S.state())).breathe,0);
    }
    await page.evaluate(()=>delete document.hidden);
    await page.evaluate(()=>{S.hover(0);window.dispatchEvent(new PageTransitionEvent('pagehide'));});
    assert.equal((await page.evaluate(()=>S.state())).frame,0);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));await frame(page);
    assert((await alignment(page)).error<1.1);
    if(!config.reduced){
      await page.evaluate(()=>S.activate(8));await frame(page);
      await page.emulateMedia({reducedMotion:'reduce'});await frame(page);
      assert.equal((await page.evaluate(()=>S.state())).breathe,0);
      assert.equal((await alignment(page)).transitions,0);
    }
    assert.deepEqual(page.testErrors,[]);
    report.checks.push({config,burst,activeBurst,repeated,resized});
    await page.screenshot({path:path.join(root,`spine-${config.theme}-${config.dpr}${config.reduced?'-reduced':''}.png`)});
  }finally{await page.context().close();}
}

async function fullPageChecks(browser,url,fixture){
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
    localStorage.setItem('canvas:startWorkspace:v1','canvas');
    localStorage.setItem('canvas:hideSpecialPages','0');
    localStorage.setItem('canvas:noteGraphPreload:v1','0');
    localStorage.setItem('canvas:spineMotionMs:v1','217');
  });
  const instrumented=current.js.replace('  function listViewName() {',exposeProbe(current.js)+'\n  window.refreshSpineFixture = refresh;\n  function listViewName() {');
  await context.route('**/start.js',route=>route.fulfill({contentType:'text/javascript',body:instrumented}));
  await context.route('**/api/recent',route=>route.fulfill({json:fixture}));
  await context.route('**/api/file-stats',route=>route.fulfill({json:{files:[]}}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(url+'/index.html?view=study');await page.waitForSelector('.study-spine-tab.active');await page.waitForTimeout(700);
    assert.equal(await page.locator('.spine-active-orb').evaluate(el=>getComputedStyle(el).transitionDuration.split(',')[0]),'0.217s');
    for(const action of ['review','calendar','cadence','notes','tree-page','study','focus','review','focus']){
      await page.locator(`.left-spine [data-action="${action}-view"]`).evaluate(el=>el.click());
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.study-spine-tab.active').getAttribute('data-action'),'focus-view');
    assert((await alignment(page)).error<1.1);
    // A genuine click/focus pair on the same element shares the next render too.
    await page.locator('.review-spine-tab').click();await page.waitForTimeout(500);
    assert((await alignment(page)).error<1.1);
    await page.locator('.left-spine .page-dot[data-group-id=""]').evaluate(el=>el.click());await page.waitForTimeout(650);
    assert.equal((await alignment(page)).shape,'dot');
    fixture.groups=Array.from({length:36},(_,i)=>({id:'g'+i,name:'分组 '+i}));
    await page.evaluate(()=>refreshSpineFixture());await frame(page);
    let state=await alignment(page);assert(state.error<1.1 && state.markerError<1.1 && state.railError<1.1
      && state.transitions===0 && state.markerTransitions===0,'structural group refresh calibrates without flying in');
    await page.locator('.left-spine .page-dot[data-group-id="__favorites__"]').evaluate(el=>el.click());await page.waitForTimeout(650);
    assert.equal((await alignment(page)).shape,'star');
    await page.setViewportSize({width:680,height:560});await frame(page);
    await page.locator('.left-spine').evaluate(el=>{el.scrollTop=140;});await frame(page);
    state=await alignment(page);assert(state.error<1.1 && state.markerError<1.1 && state.railError<1.1
      && state.transitions===0 && state.markerTransitions===0,'scroll calibration includes scrollTop exactly once');
    await page.evaluate(()=>RelatumStartWorkspace.set('notes'));await page.waitForFunction(()=>document.body.dataset.startWorkspace==='notes');
    for(const name of ['breathe','settle','transition','frame'])assert.equal((await page.evaluate(()=>S.state()))[name],0);
    await page.evaluate(()=>RelatumStartWorkspace.set('canvas'));await page.waitForTimeout(800);
    state=await alignment(page);assert(state.error<1.1 && state.markerError<1.1 && state.railError<1.1
      && state.transitions===0 && state.markerTransitions===0,'return to canvas aligns both cursors');
    await page.evaluate(()=>RelatumI18n.setLanguage('en'));await frame(page);
    assert((await alignment(page)).error<1.1);
    assert.deepEqual(errors,[]);
    report.checks.push({fullPage:true,final:state});
  }finally{await context.close();}
}

async function performanceSample(browser,assets,config,label,run){
  const page=await motionPage(browser,assets,config);
  try{
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    for(const scenario of ['hover','tab-tab','tab-dot-star']){
      await page.evaluate(()=>S.clear({animate:false}));await page.waitForTimeout(450);
      const events=[];cdp.on('Tracing.dataCollected',onData);
      function onData(event){events.push(...event.value);}
      await cdp.send('Tracing.start',{categories:'devtools.timeline',transferMode:'ReportEvents'});
      const before=await metrics();
      const time=await page.evaluate(async scenario=>{
        const start=performance.now();
        for(let i=0;i<24;i++){
          if(scenario==='hover')S.hover(i%7);
          else S.activate(scenario==='tab-tab'?i%7:[5,7,8,9][i%4]);
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        await new Promise(resolve=>setTimeout(resolve,450));
        return performance.now()-start;
      },scenario);
      const after=await metrics();
      const completed=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
      await cdp.send('Tracing.end');await completed;cdp.off('Tracing.dataCollected',onData);
      const delta={};for(const key of ['ScriptDuration','RecalcStyleDuration','LayoutDuration','TaskDuration','LayoutCount','RecalcStyleCount'])delta[key]=after[key]-before[key];
      const paints=events.filter(e=>e.ph==='X'&&e.name==='Paint');
      report.samples.push({label,run,config,scenario,elapsedMs:time,...delta,paintMs:paints.reduce((n,e)=>n+(e.dur||0)/1000,0),paintCount:paints.length});
    }
    await page.evaluate(()=>{S.activate(5,{animate:false});S.clear({animate:false});});await page.waitForTimeout(450);
    await page.evaluate(installCounters);
    const bursts=await page.evaluate(async()=>{
      const frames=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
      resetCounters();for(let i=0;i<70;i++)S.hover(i%S.targets.length);await frames();
      const hover=counters();S.clear({animate:false});await frames();
      resetCounters();for(let i=0;i<20;i++)S.activate(i%7);await frames();
      return {hover,active:counters()};
    });
    (report.bursts ||= []).push({label,run,config,...bursts});
  }finally{await page.context().close();}
}

(async()=>{
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const url=`http://127.0.0.1:${port}`;
  const server=spawn(process.env.RELATUM_PYTHON||'python',['-B','app.py','--no-browser','--port',String(port)],
    {cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,stdio:'ignore'});
  let browser;
  try{
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(url+'/api/runtime')).ok;}catch{}if(ready)break;await pause(100);}
    assert(ready,'isolated service starts');
    browser=await chromium.launch({headless:true,...(process.env.RELATUM_EDGE_PATH?{executablePath:process.env.RELATUM_EDGE_PATH}:{})});
    report.browser=browser.version();
    const configs=[{theme:'light',dpr:1},{theme:'dark',dpr:2},{theme:'light',dpr:2,reduced:true}];
    for(const config of configs){await behaviorChecks(browser,config);console.log('behavior passed '+JSON.stringify(config));}
    await fullPageChecks(browser,url,{files:[{path:path.join(root,'canvases','fixture.canvas'),title:'测试画布',exists:true,
      lastOpenedAt:'2026-10-15T00:00:00Z',groupId:'',favorite:false}],groups:[{id:'g0',name:'分组'}],recentLimit:30});
    console.log('full page passed');
    if(process.argv.includes('--compare')){
      const ref=process.env.RELATUM_SPINE_BASELINE_REF||'HEAD';report.baseline=ref;
      const old={};for(const [key,file]of [['js','assets/start.js'],['css','assets/styles.css']])old[key]=execFileSync('git',['show',ref+':'+file],{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024});
      for(let run=0;run<3;run++)for(const config of configs.slice(0,2)){
        for(const label of run%2?['current','baseline']:['baseline','current'])
          await performanceSample(browser,label==='baseline'?old:current,config,label,run);
        console.log('comparison passed '+JSON.stringify({run,config}));
      }
    }
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
    console.log('start spine motion browser passed: '+path.join(root,'report.json'));
  }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

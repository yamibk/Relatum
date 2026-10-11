'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),python=process.env.RELATUM_PYTHON;
const playwright=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(values,p)=>values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]||0;
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function installGraphProbe(fallback){
  const probe={live:new Set(),created:0,destroyed:0};window.__careerGraphs=probe;
  let api;
  Object.defineProperty(window,'GraphEngine',{configurable:true,get:()=>api,set(value){
    api=value;const create=value.create;
    value.create=options=>{const engine=create(options);if(!options.canvas.closest('[data-career-graph]'))return engine;
      const record={engine,options,nodes:[]};probe.live.add(record);probe.created++;
      const set=engine.setData,destroy=engine.destroy;engine.setData=(nodes,...args)=>{record.nodes=nodes;return set(nodes,...args);};
      engine.destroy=()=>{if(probe.live.delete(record))probe.destroyed++;return destroy();};return engine;
    };
  }});
  if(fallback){const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl/.test(type))return null;return get.call(this,type,...args);};}
}
async function main(){
  assert(python,'Set RELATUM_PYTHON to an actual Python executable');
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-career-v2-')),large=process.argv.includes('--large'),native=process.argv.includes('--webview2'),fallback=process.argv.includes('--fallback');
  const fixture=JSON.parse(execFileSync(python,['-B',path.join(__dirname,'career-v2-fixture.py'),...(large?['--large']:[])],{cwd:root,env:{...process.env,RELATUM_DATA_ROOT:dataRoot},windowsHide:true,encoding:'utf8',timeout:180000}).trim());
  process.stdout.write(JSON.stringify({fixture})+'\n');
  const port=await freePort(),debugPort=native?await freePort():0;let base=`http://127.0.0.1:${port}`;
  const server=spawn(native?process.env.RELATUM_WEBVIEW_PYTHON:python,native?['-B','desktop.py']:['-B','app.py','--no-browser','--port',String(port)],{cwd:root,env:{...process.env,RELATUM_DATA_ROOT:dataRoot,...(native?{LOCALAPPDATA:dataRoot,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let browser,page;
  try{
    let context;
    if(native){
      for(let i=0;i<200;i++){try{if((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok)break;}catch(_){}assert.equal(server.exitCode,null,'isolated WebView2 process');await delay(100);}
      browser=await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);context=browser.contexts()[0];
      for(let i=0;i<100;i++){page=context.pages().find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await delay(100);}assert(page,'native page');base=new URL(page.url()).origin;await page.setViewportSize({width:1440,height:1000});
    }else{browser=await playwright.chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();}
    for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/runtime');if(r.ok){const runtime=await r.json();assert.equal(path.resolve(runtime.root),path.resolve(dataRoot));break;}}catch(_){}await delay(100);}
    const errors=[],requests=[],usage=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/career/'))requests.push(r.url());if(r.url().endsWith('/api/usage/batch'))usage.push(r.postDataJSON());});
    await page.addInitScript(()=>{localStorage.setItem('canvas:startWorkspace:v1','canvas');localStorage.setItem('canvas:toolbarLanguage','zh-CN');});
    await page.addInitScript(installGraphProbe,fallback);
    await page.goto(base+(native?'/?desktop=1':''),{waitUntil:'networkidle'});await page.waitForTimeout(1500);
    assert.equal(await page.locator('.career-chart-mount canvas').count(),0,'warmup must not draw');
    await page.locator('[data-start-workspace="research"]').click();
    await page.waitForFunction(()=>document.querySelector('.research-workspace iframe')?.contentWindow?.RelatumResearchUsageTarget?.id);
    const research=page.frames().find(f=>f.url().includes('research.html'));assert(research);
    await research.locator('[data-research-viewport]').click();await page.waitForTimeout(5500);
    await page.evaluate(()=>window.RelatumUsage.flush());
    assert(await research.evaluate(()=>window.RelatumUsage===window.parent.RelatumUsage),'same collector in iframe');
    assert(usage.flatMap(b=>b.intervals||[]).some(r=>r.category==='research'&&r.locator==='research-page-0'&&r.end>r.start),'real iframe foreground duration');
    if(native){
      await page.evaluate(()=>window.pywebview.api.minimize());await page.waitForFunction(()=>document.documentElement.dataset.desktopMinimized==='1');
      await page.waitForTimeout(250);await page.evaluate(()=>window.RelatumUsage.flush());const before=usage.length;
      await page.waitForTimeout(1200);await page.evaluate(()=>window.RelatumUsage.flush());assert.equal(usage.length,before,'minimized time is excluded');
      await page.evaluate(()=>window.pywebview.api.toggle_maximize());await page.waitForTimeout(200);await page.evaluate(()=>window.pywebview.api.toggle_maximize());await page.waitForTimeout(500);
    }
    await page.locator('[data-start-workspace="career"]').click();
    await page.waitForSelector('.career-report-shell',{state:'visible'});await page.waitForTimeout(1600);
    assert.equal(await page.locator('.career-chapter').count(),6);
    assert(await page.locator('.career-hero').innerText().then(t=>t.includes('笔记')));
    const initialRequests=requests.length;
    const jump=async id=>{await page.evaluate(id=>{const scroll=document.querySelector('.career-scroll'),node=document.querySelector('#career-'+id);scroll.scrollTop=node.offsetTop;},id);await page.waitForTimeout(650);};
    await jump('overview');await page.screenshot({path:path.join(dataRoot,'overview.png')});
    assert(await page.locator('[data-chart-key="daily"] canvas').count());
    assert.equal(await page.locator('[data-chart-key="daily"] .career-plot').getAttribute('data-presentation'),'first','entry plays when the real chart enters the viewport');
    await jump('notes');await page.screenshot({path:path.join(dataRoot,'notes.png')});
    await jump('overview');assert.equal(await page.locator('[data-chart-key="daily"] .career-plot').getAttribute('data-presentation'),'shown','return keeps data and skips full unfolding');
    const dailyBox=await page.locator('[data-chart-key="daily"] canvas').boundingBox(),dailyPoint={x:dailyBox.x+80,y:dailyBox.y+100};
    await page.mouse.move(dailyPoint.x,dailyPoint.y);await page.waitForTimeout(70);
    const liveTip=page.locator('.career-chart-tip');assert(await liveTip.isVisible());assert.equal(await liveTip.count(),1,'one shared tooltip');
    assert(await liveTip.evaluate(n=>n.parentElement===document.body),'tooltip escapes panel containment');
    const tipBox=await liveTip.boundingBox();assert(Math.abs(tipBox.x-dailyPoint.x-12)<2&&Math.abs(tipBox.y-dailyPoint.y-12)<2);
    await jump('notes');
    assert(await liveTip.isHidden(),'scroll clears old chart feedback');
    for(const mode of ['30','90','year','all']){await page.locator(`.career-filter [data-mode="${mode}"]`).click();await page.waitForTimeout(130);}
    assert.equal(requests.length,initialRequests,'filters must not read a new snapshot or rescan');
    await page.locator('.career-filter [data-mode="custom"]').click();
    const from=page.locator('.career-custom-range input').nth(0),to=page.locator('.career-custom-range input').nth(1);
    await from.fill('2020-01-01');await to.fill('2020-01-30');await page.locator('.career-custom-range button').click();
    assert(await page.locator('.career-history-empty').isVisible());
    await page.locator('.career-filter [data-mode="all"]').click();
    await page.evaluate(()=>{const s=document.querySelector('.career-scroll');s.scrollTop=document.querySelector('[data-chart-key="note-network"]').closest('.career-panel').offsetTop;});
    await page.waitForSelector('[data-chart-key="note-network"] canvas');await page.waitForTimeout(4500);
    assert.equal(await page.evaluate(()=>[...__careerGraphs.live][0]?.engine.backendKind),fallback?'canvas2d':'webgl');
    const palette=await page.evaluate(()=>{
      const o=[...__careerGraphs.live][0].options;
      return [false,true].flatMap(focus=>[false,true].map(dim=>({
        node:o.nodeStyle({}, {focus,dim}), edge:o.edgeStyle({}, {}, {}, {highlighted:focus,dim})
      })));
    });
    for(const style of palette)for(const color of [style.node.fill,style.edge.color]){
      assert.equal(color.length,4,'WebGL color uses four numeric components');
      assert(color.every(c=>Number.isFinite(c)&&c>=0&&c<=1),'finite normalized color');
      assert(color[0]===color[1]&&color[1]===color[2],'Career graph uses neutral grayscale');
    }
    assert(palette[1].edge.color[3]<palette[0].edge.color[3],'dimmed links use the environment argument');
    assert(palette[2].edge.width>palette[0].edge.width,'highlighted links use the environment argument');
    const graph=page.locator('[data-chart-key="note-network"] canvas'),box=await graph.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);const before=await page.evaluate(()=>document.querySelector('.career-scroll').scrollTop);
    await page.mouse.wheel(0,150);await page.waitForTimeout(200);assert(await page.evaluate(()=>document.querySelector('.career-scroll').scrollTop)>before,'ordinary graph wheel scrolls report');
    await page.keyboard.down('Control');const ctrlBefore=await page.evaluate(()=>document.querySelector('.career-scroll').scrollTop);await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.querySelector('.career-scroll').scrollTop),ctrlBefore,'Ctrl wheel zoom does not scroll report');
    await page.mouse.move(80,2);await page.waitForTimeout(400);
    const stage=page.locator('[data-chart-key="note-network"] .career-graph-stage');await stage.focus();
    const camera=await page.evaluate(()=>({...[...__careerGraphs.live][0].engine.view}));
    await page.keyboard.press('ArrowRight');assert(Math.abs(await page.evaluate(()=>[...__careerGraphs.live][0].engine.view.x)-(camera.x-30))<.001,'keyboard graph pan');
    await page.keyboard.press('=');assert(await page.evaluate(()=>[...__careerGraphs.live][0].engine.view.scale)>camera.scale,'keyboard graph zoom');
    await page.keyboard.press('0');await page.waitForTimeout(650);
    for(let i=0;i<5;i++){
      await page.locator('[data-start-workspace="notes"]').click();await page.waitForTimeout(500);assert.equal(await page.locator('.career-chart-mount canvas').count(),0,'leaving releases chart resources');assert.equal(await page.locator('.career-chart-tip').count(),0,'leaving releases the portal');assert.equal(await page.evaluate(()=>__careerGraphs.live.size),0,'no retained graph engines');
      await page.locator('[data-start-workspace="career"]').click();await page.waitForTimeout(650);
    }
    await page.evaluate(()=>{document.body.dataset.startTheme='dark';});await page.waitForTimeout(300);await jump('overview');await page.screenshot({path:path.join(dataRoot,'dark.png')});
    await page.evaluate(()=>{window.RelatumI18n?.setLanguage?.('en');document.dispatchEvent(new CustomEvent('relatum:languagechange'));});await page.waitForTimeout(200);
    await page.setViewportSize({width:430,height:850});await page.waitForTimeout(350);
    assert(await page.evaluate(()=>document.querySelector('.career-scroll').scrollWidth<=document.querySelector('.career-scroll').clientWidth+2),'narrow report overflow');await page.screenshot({path:path.join(dataRoot,'narrow.png')});
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.body.dataset.startTheme='light';});
    // Finite probe is test-only and observes report idle, not unrelated hosts.
    await jump('overview');await page.waitForTimeout(1800);
    const idle=await page.evaluate(async()=>{let count=0;const original=window.requestAnimationFrame;window.requestAnimationFrame=fn=>{count++;return original(fn);};await new Promise(r=>setTimeout(r,650));window.requestAnimationFrame=original;return count;});assert.equal(idle,0,'idle report must not schedule RAF');
    const perf=[],interaction=[],performanceFailures=[];
    for(const stress of process.argv.includes('--checks-only')?[]:[false,true]){
      const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:stress?4:1});
      if(stress)await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
      for(let round=0;round<3;round++){
        const intervals=await page.evaluate(async()=>{const scroll=document.querySelector('.career-scroll');scroll.scrollTop=0;await new Promise(r=>setTimeout(r,900));const values=[];let previous=performance.now(),i=0;const max=scroll.scrollHeight-scroll.clientHeight;await new Promise(resolve=>{function tick(now){values.push(now-previous);previous=now;scroll.scrollTop=max*(i/180);if(++i<180)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return values.slice(1);});
        const result={stress,round,p95:percentile(intervals,.95),max:Math.max(...intervals),fps:intervals.length*1000/intervals.reduce((sum,value)=>sum+value,0)};perf.push(result);process.stdout.write(JSON.stringify(result)+'\n');
        if(result.p95>(stress?35:20))performanceFailures.push({kind:'scroll',...result});
      }
      await page.evaluate(()=>{const s=document.querySelector('.career-scroll');s.scrollTop=document.querySelector('[data-chart-key="note-network"]').closest('.career-panel').offsetTop;});await page.waitForTimeout(5500);
      for(let round=0;round<3;round++){
        const hit=await page.evaluate(()=>{
          const record=[...__careerGraphs.live].find(r=>r.options.canvas.closest('[data-chart-key="note-network"]')),engine=record.engine,rect=engine.canvas.getBoundingClientRect(),view=engine.view;
          const w=record.options.config.viewW,h=record.options.config.viewH,base=Math.min(rect.width/w,rect.height/h),unit=base*view.scale;
          const points=record.nodes.map(n=>({x:rect.left+(rect.width-w*base)/2+(n._rx-view.x)*unit,y:rect.top+(rect.height-h*base)/2+(n._ry-view.y)*unit}));
          const point=points.find(p=>p.x>rect.left+20&&p.x<rect.right-60&&p.y>Math.max(100,rect.top+20)&&p.y<Math.min(innerHeight-60,rect.bottom-60));if(!point)throw new Error('No visible draggable node');
          const index=engine.nodeAtClient(point.x,point.y);if(index<0)throw new Error('Real node hit failed');record.sample={point,node:record.nodes[index]};return point;
        });
        await page.mouse.move(hit.x,hit.y);await page.mouse.down();
        const intervals=await page.evaluate(async()=>{
          const record=[...__careerGraphs.live].find(r=>r.options.canvas.closest('[data-chart-key="note-network"]')),engine=record.engine,canvas=engine.canvas,rect=canvas.getBoundingClientRect(),view=engine.view;
          const point=record.sample.point,node=record.sample.node,start={x:node.x,y:node.y};
          const emit=(type,x,y,buttons=0)=>canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',button:0,buttons,clientX:x,clientY:y}));
          const values=[];let previous=0,i=0;
          await new Promise(resolve=>{function tick(now){if(previous)values.push(now-previous);previous=now;emit('pointermove',point.x+Math.sin(i/12)*25,point.y+Math.cos(i/16)*22,1);if(++i<90)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});
          emit('pointerup',point.x+40,point.y+25);if(node.x===start.x&&node.y===start.y)throw new Error('Drag did not move the node');
          previous=0;i=0;await new Promise(resolve=>{function tick(now){if(previous)values.push(now-previous);previous=now;for(let j=0;j<3;j++)emit('pointermove',rect.left+rect.width*(.15+(i%65)/100)+j,rect.top+rect.height*.45);if(++i<90)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});emit('pointerleave',rect.left-1,rect.top-1);
          return values;
        });
        await page.mouse.up();await page.mouse.move(80,2);
        const result={stress,round,p95:percentile(intervals,.95),max:Math.max(...intervals),fps:intervals.length*1000/intervals.reduce((sum,value)=>sum+value,0)};interaction.push(result);process.stdout.write(JSON.stringify({interaction:result})+'\n');
        if(result.p95>(stress?35:20))performanceFailures.push({kind:'interaction',...result});
      }
      await cdp.detach();
    }
    await page.mouse.move(80,2);await page.waitForTimeout(5500);
    const graphIdle=await page.evaluate(async()=>{let count=0;const original=requestAnimationFrame;window.requestAnimationFrame=fn=>{count++;return original(fn);};await new Promise(r=>setTimeout(r,650));window.requestAnimationFrame=original;return count;});assert.equal(graphIdle,0,'settled graph has no continuing RAF');
    if(native){
      await page.evaluate(()=>window.pywebview.api.minimize());await page.waitForFunction(()=>document.documentElement.dataset.desktopMinimized==='1');
      assert.equal(await page.evaluate(()=>__careerGraphs.live.size),0,'native minimize releases graph engines');
      assert.equal(await page.locator('.career-chart-mount canvas').count(),0,'native minimize releases canvases');
      await page.evaluate(()=>window.pywebview.api.toggle_maximize());await page.waitForTimeout(200);await page.evaluate(()=>window.pywebview.api.toggle_maximize());await page.waitForTimeout(800);
    }
    // Headless Chromium does not consistently mark background tabs hidden.
    // Exercise the real visibility handler using the same deterministic probe
    // as the notebook graph acceptance; no probe ships with the application.
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(400);
    assert.equal(await page.locator('.career-chart-mount canvas').count(),0,'hidden report releases drawing resources');assert.equal(await page.evaluate(()=>__careerGraphs.live.size),0);
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(1000);
    // Inventory changes remain absent until explicit UI generation succeeds.
    fs.writeFileSync(path.join(dataRoot,'notes','After generation.md'),'# New inventory\nA later note.','utf8');
    assert.equal(await page.evaluate(()=>RelatumCareerReport.report.inventory.notes.count),fixture.notes);
    await jump('range');await page.locator('.career-regenerate').click();
    await page.locator('.career-filter [data-mode="30"]').click();
    await page.evaluate(()=>{document.body.dataset.startTheme='dark';});
    await page.waitForFunction(count=>RelatumCareerReport.report.inventory.notes.count===count,fixture.notes+1,{timeout:45000});
    const regenerated=JSON.parse(fs.readFileSync(path.join(dataRoot,'data','career-report-v2.json'),'utf8'));assert.equal(regenerated.inventory.notes.count,fixture.notes+1);
    assert(!usage.flatMap(b=>b.intervals||[]).some(r=>r.category==='career'||r.category==='focus'||r.category==='diary'));
    assert.equal(errors.length,0,errors.join('\n'));
    const result={fixture,native,fallback,browserVersion:browser.version(),checksOnly:process.argv.includes('--checks-only'),perf,interaction,performanceFailures,graphIdle,idle,errors,checks:32,dataRoot};fs.writeFileSync(path.join(dataRoot,'acceptance.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify({result:path.join(dataRoot,'acceptance.json')})+'\n');
    assert.equal(performanceFailures.length,0,`frame interval targets: ${JSON.stringify(performanceFailures)}`);
  }finally{if(native)await page?.evaluate(()=>window.pywebview?.api.close_window()).catch(()=>{});await browser?.close();if(server.exitCode===null)server.kill();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

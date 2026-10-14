'use strict';
// Reproduce the existing fast-scroll/drag pressure probe in the complete shell.
// Source overrides read the baseline from Git; all state stays in a disposable fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const repo=path.resolve(__dirname,'..'),baseline=process.argv.includes('--baseline'),fixture=process.env.RELATUM_CAREER_FIXTURE;
assert(fixture&&path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep)&&fs.existsSync(path.join(fixture,'fixture-manifest.json')),'Disposable fixture required');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-career-shell-')),delay=ms=>new Promise(r=>setTimeout(r,ms));
const p95=values=>values.slice().sort((a,b)=>a-b)[Math.floor(values.length*.95)];
async function main(){
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const server=spawn(process.env.RELATUM_PYTHON,['-B','app.py','--no-browser','--port',String(port)],{cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:fixture},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let browser;const results={baseline,perf:[],interaction:[],errors:[]};
  try{
    const base='http://127.0.0.1:'+port;let ready=false;
    for(let i=0;i<100;i++){let response;try{response=await fetch(base+'/api/runtime');}catch{}if(response?.ok){const runtime=await response.json();assert.equal(path.resolve(runtime.root).toLowerCase(),path.resolve(fixture).toLowerCase(),'server must use the isolated fixture');ready=true;break;}await delay(100);}assert(ready,'isolated server ready');
    browser=await chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>results.errors.push(e.message));
    if(baseline)await page.route('**/career/**',route=>{const pathname=new URL(route.request().url()).pathname;if(!pathname.startsWith('/career/'))return route.continue();const name='assets'+pathname;try{return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:execFileSync('git',['show','82c150e:'+name],{cwd:repo,encoding:'utf8'})});}catch(error){results.errors.push(error.message);return route.abort();}});
    await page.addInitScript(()=>{
      localStorage.setItem('canvas:startWorkspace:v1','canvas');localStorage.setItem('canvas:toolbarLanguage','zh-CN');
      window.probe={live:new Set()};let api;Object.defineProperty(window,'GraphEngine',{configurable:true,get:()=>api,set(value){api=value;const create=api.create;api.create=options=>{const engine=create(options);if(!options.canvas.closest('[data-career-graph]'))return engine;const record={engine,options,nodes:[]},set=engine.setData,destroy=engine.destroy;probe.live.add(record);engine.setData=(nodes,...args)=>{record.nodes=nodes;return set(nodes,...args);};engine.destroy=()=>{probe.live.delete(record);return destroy();};return engine;};}});
    });
    await page.goto(base,{waitUntil:'networkidle'});await page.evaluate(()=>RelatumStartWorkspace.set('career'));await page.waitForTimeout(1800);
    const jump=()=>page.evaluate(()=>{const s=document.querySelector('.career-scroll');s.scrollTop=document.querySelector('[data-chart-key="note-network"]').closest('.career-panel').offsetTop;});
    await jump();await page.waitForFunction(()=>probe.live.size>0);await page.waitForTimeout(5500);
    for(let i=0;i<5;i++){await page.evaluate(()=>RelatumStartWorkspace.set('notes'));await page.evaluate(()=>RelatumStartWorkspace.set('career'));await page.waitForTimeout(650);}
    await page.evaluate(()=>{document.body.dataset.startTheme='dark';RelatumI18n.setLanguage('en');});await page.setViewportSize({width:430,height:850});await page.waitForTimeout(350);await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.body.dataset.startTheme='light');await page.waitForTimeout(1800);
    for(const stress of [false,true]){
      const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:stress?4:1});if(stress)await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:2,mobile:false});
      for(let round=0;round<3;round++){
        const values=await page.evaluate(async()=>{const s=document.querySelector('.career-scroll');s.scrollTop=0;await new Promise(r=>setTimeout(r,900));const max=s.scrollHeight-s.clientHeight,values=[];let previous=performance.now(),i=0;await new Promise(resolve=>{function tick(now){values.push(now-previous);previous=now;s.scrollTop=max*(i/180);if(++i<180)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return values.slice(1);});
        const r={stress,round,p95:p95(values),max:Math.max(...values)};results.perf.push(r);console.log(JSON.stringify({scroll:r}));
      }
      await jump();await page.waitForTimeout(5500);
      for(let round=0;round<3;round++){
        const point=await page.evaluate(()=>{const record=[...probe.live].find(r=>r.options.canvas.closest('[data-chart-key="note-network"]')),e=record.engine,r=e.canvas.getBoundingClientRect(),v=e.view,o=record.options.config,base=Math.min(r.width/o.viewW,r.height/o.viewH),unit=base*v.scale;const points=record.nodes.map(n=>({x:r.left+(r.width-o.viewW*base)/2+(n._rx-v.x)*unit,y:r.top+(r.height-o.viewH*base)/2+(n._ry-v.y)*unit}));const p=points.find(p=>p.x>r.left+20&&p.x<r.right-60&&p.y>Math.max(100,r.top+20)&&p.y<Math.min(innerHeight-60,r.bottom-60));if(!p)throw Error('No visible node');const index=e.nodeAtClient(p.x,p.y);if(index<0)throw Error('Node hit failed');record.sample={point:p,node:record.nodes[index]};return p;});
        await page.mouse.move(point.x,point.y);await page.mouse.down();
        const values=await page.evaluate(async()=>{const record=[...probe.live].find(r=>r.options.canvas.closest('[data-chart-key="note-network"]')),c=record.engine.canvas,r=c.getBoundingClientRect(),p=record.sample.point,n=record.sample.node,start={x:n.x,y:n.y},values=[];
          const emit=(type,x,y,buttons=0)=>c.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',button:0,buttons,clientX:x,clientY:y}));let previous=0,i=0;
          await new Promise(resolve=>{function tick(now){if(previous)values.push(now-previous);previous=now;emit('pointermove',p.x+Math.sin(i/12)*25,p.y+Math.cos(i/16)*22,1);if(++i<90)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});emit('pointerup',p.x+40,p.y+25);if(n.x===start.x&&n.y===start.y)throw Error('Drag did not move a node');previous=0;i=0;
          await new Promise(resolve=>{function tick(now){if(previous)values.push(now-previous);previous=now;for(let j=0;j<3;j++)emit('pointermove',r.left+r.width*(.15+(i%65)/100)+j,r.top+r.height*.45);if(++i<90)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});emit('pointerleave',r.left-1,r.top-1);return values;
        });await page.mouse.up();await page.mouse.move(80,2);
        const r={stress,round,p95:p95(values),max:Math.max(...values)};results.interaction.push(r);console.log(JSON.stringify({interaction:r}));
      }
      await cdp.detach();
    }
    assert.deepEqual(results.errors,[]);results.browserVersion=browser.version();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({results:path.join(out,'results.json')}));
  }finally{await browser?.close();if(server.exitCode===null)server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});

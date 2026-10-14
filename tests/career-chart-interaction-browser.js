'use strict';
// Exercise production modules in a disposable browser, with synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.RELATUM_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.RELATUM_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const results=[];
  try {
    for(const fallback of [false,true]) {
      const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      const html='<html lang="zh-CN"><head><link rel="stylesheet" href="/assets/career/report.css"></head><body class="start-page" data-start-theme="light"><main class="career-workspace" style="margin:80px 0 0 120px;width:900px;--bg:#fff"><section class="career-panel"><div id="chart" class="career-chart-mount"></div></section></main></body></html>';
      await page.route('http://career.test/**',route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});const name=url.pathname.startsWith('/assets/')?url.pathname.slice(1):'assets/'+url.pathname.slice(1);return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(root,name),'utf8')});});
      if(fallback)await page.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/.test(type)?null:get.call(this,type,...args);};});
      await page.addInitScript(()=>{let api;Object.defineProperty(window,'GraphEngine',{configurable:true,get:()=>api,set(value){api=value;const create=api.create;api.create=options=>{const engine=create(options),set=engine.setData;window.graphProbe={engine,options};engine.setData=(nodes,edges,...rest)=>{graphProbe.nodes=nodes;graphProbe.edges=edges;return set(nodes,edges,...rest);};return engine;};}});});
      await page.goto('http://career.test/');
      await page.evaluate(async()=>{
        const {mountChart}=await import('/assets/career/charts.js'),{scheduler}=await import('/assets/career/motion.js');
        window.context={scheduler:scheduler(),graphViews:new Map(),legendState:new Map(),data:{start:'2026-01-01',end:'2026-01-05',collection:()=> 'on',entityDays:[{category:'canvas',id:'c',date:'2026-01-01',seconds:30}],rankings:()=>[{id:'c',name:'Canvas',value:30}],entities:new Map([['c',{name:'Canvas'}]])}};
        window.mount=spec=>{window.runtime?.destroy();window.runtime=mountChart(document.querySelector('#chart'),spec,context);};
        window.fills=0;const fill=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(...args){fills++;return fill.apply(this,args);};
        mount({type:'heatmap',rows:[{date:'2026-01-01',seconds:30}],title:'Year'});
      });
      await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>fills),365,'identical initial resize does not paint twice');
      assert.equal(await page.locator('.career-plot').getAttribute('data-presentation'),'waiting');
      await page.evaluate(()=>runtime.enter(true));assert.equal(await page.locator('.career-plot').getAttribute('data-presentation'),'first');
      assert(await page.evaluate(()=>document.getAnimations().length)>0,'first entry unfolds');await page.waitForTimeout(1150);
      const canvas=await page.locator('#chart canvas').boundingBox(),point={x:canvas.x+32,y:canvas.y+68};
      await page.mouse.move(point.x,point.y);await page.waitForTimeout(50);
      const tip=page.locator('.career-chart-tip'),box=await tip.boundingBox();assert(box);assert(Math.abs(box.x-point.x-12)<2&&Math.abs(box.y-point.y-12)<2,'viewport position has no panel offset');assert(await tip.innerText().then(t=>t.includes('00:00:30')));
      await page.evaluate(()=>{window.tipWrites=0;window.tipObserver=new MutationObserver(records=>tipWrites+=records.filter(r=>r.type==='childList'||r.type==='characterData').length);tipObserver.observe(document.querySelector('.career-chart-tip'),{subtree:true,childList:true,characterData:true});});
      for(let i=0;i<8;i++){await page.mouse.move(point.x+i%2,point.y+i%2);await page.waitForTimeout(20);}
      assert.equal(await page.evaluate(()=>tipWrites),0,'same cell does not rewrite tooltip');assert.equal(await page.evaluate(()=>fills),365,'hover reuses the static canvas');
      assert(await page.locator('.career-dense-highlight').isVisible());
      const cleanWrites=await page.evaluate(async()=>{runtime.clearInteraction();let writes=0;const observer=new MutationObserver(records=>writes+=records.length);observer.observe(document.querySelector('#chart'),{attributes:true,subtree:true});observer.observe(document.querySelector('.career-chart-tip'),{attributes:true});for(let i=0;i<8;i++){runtime.clearInteraction();context.tooltip.hide();}await Promise.resolve();observer.disconnect();return writes;});assert.equal(cleanWrites,0,'clearing idle feedback does not rewrite classes or hidden attributes');
      await page.locator('#chart canvas').focus();await page.waitForTimeout(50);assert(await tip.innerText().then(t=>t.includes('2026-01-01')));assert(await page.locator('#chart canvas').getAttribute('aria-describedby'));
      await page.keyboard.press('ArrowDown');await page.waitForTimeout(50);assert(await tip.innerText().then(t=>t.includes('2026-01-02')),'keyboard moves between actual calendar cells');assert.equal(await page.evaluate(()=>fills),365,'keyboard feedback does not repaint the base chart');
      await page.evaluate(()=>{runtime.leave();runtime.enter(false);});assert.equal(await page.locator('.career-plot').getAttribute('data-presentation'),'shown');assert(await page.evaluate(()=>document.getAnimations().some(a=>a.effect.getTiming().duration===240)),'return is a short fade');
      assert(await tip.isHidden());
      await page.evaluate(()=>{const h=document.querySelector('#chart');context.tooltip.forHost(h).show('Long name '.repeat(80),innerWidth-4,innerHeight-4);});await page.waitForTimeout(50);
      const edgeBox=await tip.boundingBox();assert(edgeBox.x>=8&&edgeBox.y>=8&&edgeBox.x+edgeBox.width<=1440-7&&edgeBox.y+edgeBox.height<=1000-7,'long tooltip stays inside viewport');
      for(const spec of [
        {type:'rank',unit:'seconds',rows:[{name:'Rank name',value:30}]},
        {type:'distribution',unit:'Notes',rows:[{name:'Short notes',value:5},{name:'Long notes',value:8}]},
        {type:'treemap',unit:'Words',rows:[{name:'Notebook',value:100},{name:'Other',value:50}]},
        {type:'matrix',category:'canvas',rows:[]},
        {type:'trend',key:'trend',rows:[{date:'2026-01-01',seconds:30},{date:'2026-01-02',seconds:60},{date:'2026-01-04',seconds:40}],keys:['seconds']}
      ]) {
        await page.evaluate(spec=>{mount(spec);runtime.enter(true);},spec);await page.waitForTimeout(1150);
        const mark=page.locator('#chart .career-feedback[tabindex="0"],#chart .career-rank').first();await mark.focus();await page.waitForTimeout(50);
        assert(await tip.isVisible(),spec.type+' keyboard hint');assert(await mark.getAttribute('aria-describedby'),'focus describes the exact value');assert(await mark.evaluate(n=>n.classList.contains('is-hit')));
        const target=await mark.boundingBox(),hint=await tip.boundingBox();assert(Math.abs(hint.x-(target.x+target.width/2+12))<2,spec.type+' hint is anchored to the focused mark');
        if(spec.type==='trend') {
          const original=await page.evaluate(()=>window.seriesNode=document.querySelector('.career-series'));
          assert(original);await page.locator('.career-legend button').click();await page.locator('.career-legend button').click();assert(await page.evaluate(()=>seriesNode===document.querySelector('.career-series')),'legend reuses geometry and DOM');
          assert.equal(await page.locator('.career-series-line').getAttribute('d').then(d=>(d.match(/ M/g)||[]).length),2,'calendar gap stays disconnected');
          const dotBoxes=await page.locator('.career-trend-point').evaluateAll(nodes=>nodes.slice(0,2).map(n=>{const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};}));
          await page.mouse.move((dotBoxes[0].x+dotBoxes[1].x)/2,(dotBoxes[0].y+dotBoxes[1].y)/2);await page.waitForTimeout(60);assert(await tip.isVisible(),'line segments provide exact nearest real point');
        }
      }
      await page.evaluate(()=>{mount({type:'barcode',rows:[{date:'2026-01-01',seconds:30}]});runtime.enter(true);});await page.waitForTimeout(1150);const daily=await page.locator('#chart canvas').boundingBox();await page.mouse.move(daily.x+80,daily.y+100);await page.waitForTimeout(60);assert(await tip.isVisible());assert(await page.locator('.career-dense-highlight').isVisible());await page.locator('#chart canvas').focus();await page.keyboard.press('End');await page.waitForTimeout(50);assert(await tip.innerText().then(t=>t.includes('2026-01-05')),'keyboard inspects the last daily line');
      await page.evaluate(()=>{window.graphSpec={type:'graph',key:'graph',network:{nodes:[{id:'a',title:'Alpha',words:10},{id:'b',title:'Beta',words:20},{id:'c',title:'Gamma',words:30}],edges:[{from:'a',to:'b'},{from:'b',to:'c'}]}};mount(graphSpec);runtime.enter(true);});
      await page.waitForTimeout(3000);
      const hits=await page.evaluate(()=>{const {engine,nodes,edges,options}=graphProbe,r=engine.canvas.getBoundingClientRect(),v=engine.view,base=Math.min(r.width/options.config.viewW,r.height/options.config.viewH),unit=base*v.scale;
        const project=n=>({x:r.left+(r.width-options.config.viewW*base)/2+(n._rx-v.x)*unit,y:r.top+(r.height-options.config.viewH*base)/2+(n._ry-v.y)*unit});
        const inside=p=>p.x>r.left+15&&p.x<r.right-15&&p.y>r.top+15&&p.y<Math.min(innerHeight-15,r.bottom-15);
        const node=nodes.map(project).find(inside);let edge=null;for(const e of edges){const a=project(nodes[e.source]),b=project(nodes[e.target]),p={x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(inside(p)&&engine.nodeAtClient(p.x,p.y)<0){edge=p;break;}}return{node,edge,backend:engine.backendKind};});
      assert.equal(hits.backend,fallback?'canvas2d':'webgl');assert(hits.node&&hits.edge,'visible production graph hit points');
      await page.mouse.move(hits.node.x,hits.node.y);await page.waitForTimeout(70);assert(await tip.isVisible());assert(await page.locator('.career-graph-halo').isVisible());
      const graphTip=await tip.boundingBox();assert(Math.abs(graphTip.x-hits.node.x-12)<2&&Math.abs(graphTip.y-hits.node.y-12)<2,'graph tooltip uses viewport coordinates');
      await page.mouse.move(hits.edge.x,hits.edge.y);await page.waitForTimeout(70);assert(await tip.innerText().then(t=>t.includes('↔')));assert(await page.evaluate(()=>graphProbe.edges.some(e=>e._highlighted)&&graphProbe.nodes.some(n=>n._near)));
      await page.evaluate(()=>runtime.clearInteraction());
      const saved=await page.evaluate(()=>{graphProbe.engine.heat(.04);graphProbe.engine.setActive(false);window.previousGraph=graphProbe;runtime.destroy();const state=context.graphViews.get('graph');mount(graphSpec);runtime.enter(false);return{alpha:state.layoutAlpha,settled:state.settled,camera:state.camera};});
      assert.equal(saved.alpha,.04);assert.equal(saved.settled,false);await page.waitForFunction(()=>graphProbe!==previousGraph);await page.waitForTimeout(150);
      assert(await page.evaluate(()=>graphProbe.engine.layoutAlpha<=.04),'unfinished layout resumes its remaining energy without reheating');
      assert.deepEqual(await page.evaluate(()=>graphProbe.engine.view),saved.camera,'layout continuation keeps the camera');
      await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{runtime.leave();runtime.enter(true);});assert.equal(await page.locator('.career-plot').getAttribute('data-presentation'),'shown');assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
      await page.setViewportSize({width:430,height:850});await page.evaluate(()=>{document.querySelector('.career-workspace').style.cssText='margin:0;width:100%;--bg:#111';document.body.dataset.startTheme='dark';context.tooltip.forHost(document.querySelector('#chart')).show('长名称'.repeat(100),425,840);});await page.waitForTimeout(70);const narrow=await tip.boundingBox();assert(narrow.x>=8&&narrow.x+narrow.width<=423&&narrow.y>=8&&narrow.y+narrow.height<=843,JSON.stringify(narrow));assert.equal(await tip.evaluate(n=>getComputedStyle(n).color),'rgb(245, 245, 247)');
      await page.evaluate(()=>{runtime.destroy();context.tooltip.destroy();context.scheduler.stop();});assert.equal(await page.locator('.career-chart-tip').count(),0);assert.equal(await page.locator('#chart canvas').count(),0);
      assert.deepEqual(errors,[]);results.push({fallback,initialCanvasPaints:365,sameCellTextWrites:0,errors});await page.close();
    }
    console.log(JSON.stringify({careerChartInteractions:results}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

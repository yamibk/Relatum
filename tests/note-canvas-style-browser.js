'use strict';
// Real sidebar, renderer and persistence in an isolated library. No user files.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() {
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const number=socket.address().port;await new Promise(resolve=>socket.close(resolve));return number;
}
async function run(browser, full, fallback=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relatum-canvas-style-'));
  fs.mkdirSync(path.join(root,'notes/canvases'),{recursive:true});fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'notes/A.md'),'前文\n\n![样式|640x360](canvases/styles.canvas)\n\n后文\n');
  fs.writeFileSync(path.join(root,'notes/B.md'),'![共享|640x360](canvases/styles.canvas)\n');
  fs.writeFileSync(path.join(root,'data/note-notebooks.json'),JSON.stringify({version:1,colors:{},ui:{open:true,mode:'canvas',selectedRoot:'',expanded:[]}}));
  const fixture={version:2,nodes:[
    {id:'a',kind:'index',x:-240,y:-70,width:160,height:70,text:'节点 A',autoHeight:true},
    {id:'b',kind:'index',x:160,y:60,width:160,height:80,text:'节点 B',bgColor:'#d8e9db'}],
    edges:[{id:'e',from:'a',to:'b',curve:'straight',text:'关系'},
      {id:'f',from:'b',to:'a',curve:'bezier',waypoints:[{x:0,y:130,customPoint:'keep'}],labelOffsetY:35,text:'返回'}],custom:{preserved:true}};
  fs.writeFileSync(path.join(root,'notes/canvases/styles.canvas'),JSON.stringify(fixture));
  const catalog=JSON.parse(fs.readFileSync(path.join(repo,'assets/feature-catalog.json')));
  const features=Object.fromEntries(catalog.features.map(f=>[f.id,['notes','notes.canvas'].includes(f.id)||full&&['canvas','canvas.library'].includes(f.id)]));
  const number=await availablePort(),url=`http://127.0.0.1:${number}`;
  const server=spawn(process.env.RELATUM_PYTHON||'python',['app.py','--no-browser','--port',String(number),'--launch-profile',JSON.stringify({version:1,features})],
    {cwd:repo,env:{...process.env,RELATUM_DATA_ROOT:root},windowsHide:true,stdio:'ignore'});
  const context=await browser.newContext({viewport:{width:1500,height:1000},reducedMotion:'reduce'});
  let page;
  try {
    for(let i=0;i<100;i++) {try {if((await fetch(url+'/api/runtime')).ok) break;} catch(_) {}await pause(100);}
    page=await context.newPage();page.setDefaultTimeout(12000);
    const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
    const workspace=fs.readFileSync(path.join(repo,'assets/note-workspace.js'),'utf8').replace('  window.CanvasNoteWorkspace = {',
      '  window.T={state,openNote,setViewMode,get editor(){return liveEditor;}};\n  window.CanvasNoteWorkspace = {');
    await page.route('**/note-workspace.js*',route=>route.fulfill({contentType:'text/javascript',body:workspace}));
    const schema=fs.readFileSync(path.join(repo,'assets/note-canvas-style.js'),'utf8').replace('  function values(kind, record) {',
      '  function values(kind, record) {\n    if(window.trackStyleReads) {window.styleReads=(window.styleReads||0)+1;(window.styleKinds||={})[kind]=(window.styleKinds[kind]||0)+1;}');
    await page.route('**/note-canvas-style.js*',route=>route.fulfill({contentType:'text/javascript',body:schema}));
    await page.addInitScript(fallback=>{localStorage.setItem('canvas:startWorkspace:v1','notes');localStorage.setItem('canvas:noteView:v1','live');if(fallback) window.Path2D=undefined;},fallback);
    await page.goto(url);await page.waitForFunction(()=>window.T?.state.initialized);
    const settings=page.locator('[data-role="note-canvas-settings"]');
    assert.equal(await settings.locator('[data-shape]').count(),24);
    assert.equal(await settings.locator('details, select.note-canvas-target').count(),0);
    const defaultTabs=settings.locator('[data-canvas-group="defaults"] [role="tab"]');assert.equal(await defaultTabs.count(),4);
    for(const kind of ['node','edge','nodeText','edgeText']) {
      const tab=settings.locator(`[data-default-target="${kind}"]`);await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'),'true');assert.equal(await settings.locator('[role="tab"][aria-selected="true"]').count(),1);
      assert.equal(await settings.locator('[data-canvas-default-fields] [data-canvas-style]').evaluateAll(els=>new Set(els.map(el=>el.dataset.canvasStyle.split('.')[0])).size),1);
      assert.equal(await settings.locator('[data-role="note-canvas-default-scale"]').isVisible(),kind==='node');
    }
    await settings.locator('[data-default-target="edgeText"]').press('Home');assert.equal(await settings.locator('[data-default-target="node"]').getAttribute('aria-selected'),'true');
    assert.equal(requests.filter(r=>/note-canvas\//.test(r)).length,0,'sidebar alone never starts the renderer');
    const defaultColor=settings.locator('[data-canvas-group="defaults"] [data-canvas-style="node.bgColor"]');
    await defaultColor.click();assert.equal(await settings.locator('.note-canvas-color-popup').count(),1);
    await defaultColor.click();assert.equal(await settings.locator('.note-canvas-color-popup').count(),0,'second swatch click closes instead of reopening');
    await defaultColor.click();await page.keyboard.press('Escape');assert.equal(await settings.locator('.note-canvas-color-popup').count(),0);
    await defaultColor.click();await settings.locator('[data-default-target="edge"]').click();assert.equal(await settings.locator('.note-canvas-color-popup').count(),0,'switching panels releases the color popup');
    await settings.locator('[data-default-target="node"]').click();
    assert.equal(await settings.locator('[data-canvas-group="node"] input:enabled').count(),0);
    assert.equal((await settings.innerText()).includes('当前画布'),false);
    await page.evaluate(()=>T.openNote('A.md'));await page.waitForFunction(()=>document.querySelector('.note-canvas-frame')?.__noteCanvas?.engine);
    const frame=page.locator('.note-canvas-frame').first(),viewport=frame.locator('.note-canvas-viewport');
    const a=frame.locator('[data-canvas-node="a"]'),b=frame.locator('[data-canvas-node="b"]');
    const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const data=()=>frame.evaluate(el=>el.__noteCanvas.session.data);
    const history=()=>frame.evaluate(el=>el.__noteCanvas.session.past.length);
    const apply=(kind,patch,options)=>page.evaluate(async ({kind,patch,options})=>RelatumNoteCanvas.getActive().applySelectionStyle(kind,patch,options),{kind,patch,options});
    const undo=()=>page.evaluate(()=>RelatumNoteCanvas.getActive().travel(false));
    const group=kind=>settings.locator(`[data-canvas-group="${kind}"]`);
    const panelMode=()=>settings.locator('[data-canvas-group]:visible').getAttribute('data-canvas-group');
    async function point(fraction,key='e') {
      return frame.evaluate((el,{fraction,key})=>{
        const adapter=el.__noteCanvas,edge=adapter.session.edges.get(key).edge,S=RelatumNoteCanvasStyle,G=RelatumNoteCanvasGeometry;
        const rect=id=>{const n=adapter.session.nodes.get(id),dom=el.querySelector(`[data-canvas-node="${id}"]`),s=S.values('node',n);
          return {x:n.x,y:n.y,w:dom.offsetWidth,h:dom.offsetHeight,r:s.radius,shape:s.shape};};
        const item=G.build(edge,rect(edge.from),rect(edge.to)),p=G.pointAt(item,fraction),v=el.querySelector('.note-canvas-viewport').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(el.querySelector('.note-canvas-world')).transform);
        return {x:v.left+m.e+p.x*m.a,y:v.top+m.f+p.y*m.d,d:item.d};
      },{fraction,key});
    }
    await a.click();
    assert.equal(await panelMode(),'node');assert.equal(await settings.locator('[data-note-action="reset-canvas-settings"]').isVisible(),false);
    assert.equal(await group('defaults').isVisible(),false);assert.equal(await group('node').locator('[data-canvas-style="nodeText.fontSize"]').isVisible(),true);
    const nodePanel=await group('node').elementHandle();
    await settings.evaluate(el=>{el.scrollTop=150;});await b.click();await settle();
    assert.equal(await settings.evaluate(el=>el.scrollTop),150,'same-type selection retains panel scroll');
    assert(await nodePanel.evaluate(el=>el===document.querySelector('[data-canvas-group="node"]')),'selection reuses panel DOM');await a.click();
    const widthInput=group('node').locator('[data-canvas-style="node.width"]');
    const inputBox=await widthInput.boundingBox();await widthInput.press('ArrowUp');await settle();assert.equal((await data()).nodes[0].width,161);
    assert.equal(await widthInput.evaluate(el=>getComputedStyle(el).appearance),'textfield');
    assert.equal((await widthInput.boundingBox()).width,inputBox.width,'numeric controls keep their dimensions without spinners');await undo();await settle();
    const alignSelect=group('node').locator('[data-canvas-style="nodeText.textAlign"]');await alignSelect.focus();await b.click();
    await alignSelect.evaluate(el=>{el.value='right';el.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
    assert.equal((await data()).nodes[1].textAlign,undefined,'a delayed select change cannot retarget another node');assert.equal(await alignSelect.inputValue(),'left');await a.click();
    await page.locator('[data-note-action="close-links"]').click();await a.click();assert.equal(await page.locator('.note-workspace').evaluate(el=>el.classList.contains('links-overlay-open')),false,'selection does not open the sidebar');
    await page.locator('[data-note-action="toggle-notebooks"]').click();await settle();assert.equal(await panelMode(),'node','manually opening the sidebar retains selection');
    await page.locator('[data-note-action="side-links"]').click();await a.click();assert.equal(await page.evaluate(()=>T.state.sideMode),'links','selection does not change the chosen sidebar tab');
    await page.locator('[data-note-action="side-canvas"]').click();await settle();assert.equal(await panelMode(),'node','canvas tab activation retains selection');
    const sideOpen=()=>page.locator('.note-workspace').evaluate(el=>el.classList.contains('links-overlay-open'));
    const dispatchTab=(locator,extra={})=>locator.evaluate((el,extra)=>{
      const event=new KeyboardEvent('keydown',{key:'Tab',code:'Tab',bubbles:true,cancelable:true,...extra});
      el.addEventListener('keydown',event=>event.stopPropagation(),{once:true});el.dispatchEvent(event);return event.defaultPrevented;
    },extra);
    for(const mode of ['notebooks','links','canvas']) {
      await page.locator(`[data-note-action="side-${mode}"]`).click();await a.click();
      const beforeSelection=await page.evaluate(()=>RelatumNoteCanvas.getActive().getSelection());
      const beforeHistory=await history();
      await viewport.press('Tab');assert.equal(await sideOpen(),false,`Tab closes the ${mode} tab`);
      assert(await viewport.evaluate(el=>document.activeElement===el),'closing keeps canvas focus');
      assert.deepEqual(await page.evaluate(()=>RelatumNoteCanvas.getActive().getSelection()),beforeSelection);
      await viewport.press('Tab');assert.equal(await sideOpen(),true);assert.equal(await page.evaluate(()=>T.state.sideMode),'canvas');
      assert(await viewport.evaluate(el=>document.activeElement===el),'opening keeps canvas focus');
      assert.equal(await history(),beforeHistory,'sidebar toggles do not write canvas history');
    }
    assert.equal(await dispatchTab(viewport,{repeat:true}),true);assert.equal(await sideOpen(),true,'long press does not toggle again or move focus');
    for(const extra of [{shiftKey:true},{altKey:true},{metaKey:true},{isComposing:true},{keyCode:229}]) {
      assert.equal(await dispatchTab(viewport,extra),false);assert.equal(await sideOpen(),true);
    }
    await widthInput.focus();assert.equal(await dispatchTab(widthInput),false);assert.equal(await sideOpen(),true,'panel inputs retain native Tab');
    await a.dblclick();const tabInput=viewport.locator('textarea');
    assert.equal(await dispatchTab(tabInput),false);assert.equal(await sideOpen(),true,'canvas text retains native Tab');await tabInput.press('Escape');
    await frame.evaluate(el=>el.__noteCanvas.engine.suspend());await viewport.focus();
    assert.equal(await dispatchTab(viewport),false);assert.equal(await sideOpen(),true,'inactive canvas does not toggle the sidebar');await a.click();
    assert(await page.evaluate(()=>{
      const S=RelatumNoteCanvasStyle,G=RelatumNoteCanvasGeometry,curves=['straight','bezier','smooth','elbow','rounded-elbow'];
      for(const [shape] of S.shapes) for(const curve of curves) for(const side of ['auto','top','right','bottom','left']) {
        const rect={x:0,y:0,w:160,h:160,r:12,shape},target={x:400,y:220,w:160,h:100,r:12,shape:'ellipse'};
        const item=G.build({curve,fromSide:side,toSide:side},rect,target);
        for(const [r,p] of [[rect,item.samples[0]],[target,item.samples.at(-1)]]) {
          const dx=p.x-r.x-r.w/2,dy=p.y-r.y-r.h/2,n=Math.hypot(dx,dy);
          if(!S.contains(r.shape,r.w,r.h,r.r,p.x-r.x-dx/n*.01,p.y-r.y-dy/n*.01)||
            S.contains(r.shape,r.w,r.h,r.r,p.x-r.x+dx/n*.01,p.y-r.y+dy/n*.01)) return false;
        }
        if(side!=='auto'&&curve!=='straight') {
          const [dx,dy]={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]}[side],a=item.samples[0],b=item.samples[1],t=item.samples.at(-1),near=item.samples.at(-2);
          if((b.x-a.x)*dx+(b.y-a.y)*dy<=0||(near.x-t.x)*dx+(near.y-t.y)*dy<=0) return false;
        }
      }return true;
    }), 'every shape/path/port shares outline endpoints and outward routing');
    for(const shape of await page.evaluate(()=>RelatumNoteCanvasStyle.shapes.map(s=>s[0]))) {
      await group('node').locator(`[data-shape="${shape}"]`).click();await settle();
      assert.equal((await data()).nodes[0].shape||'rounded-rect',shape);
      const hit=await a.evaluate((el,shape)=>{
        const r=el.getBoundingClientRect(),x=r.left+r.width*.06,y=r.top+r.height*.06;
        return {actual:document.elementFromPoint(x,y)?.closest('[data-canvas-node]')===el,
          expected:RelatumNoteCanvasStyle.contains(shape,el.offsetWidth,el.offsetHeight,8,el.offsetWidth*.06,el.offsetHeight*.06),path:el.querySelector('.note-canvas-fill').getAttribute('d')};
      },shape);
      assert.equal(hit.actual,hit.expected,`${shape} uses its real outline for hit testing`);assert(hit.path.length>10);
      await apply('node',{width:48,height:24,autoHeight:false});await settle();
      assert.equal(await a.locator('.note-canvas-content').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');
      assert.equal(await a.locator('.note-canvas-content').evaluate(el=>getComputedStyle(el,'::-webkit-scrollbar').width),'0px');
      assert.equal(await a.locator('.note-canvas-content').evaluate(el=>el.offsetWidth-el.clientWidth),0,`${shape} reserves no scroll gutter`);
      assert.equal(await group('node').locator('[data-field="radius"]').isVisible(),shape==='rounded-rect');
      const smallNode=(await data()).nodes[0],smallHistory=await history(),corner=await frame.locator('[data-canvas-resize="a"][data-corner="se"]').boundingBox();
      await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+12,corner.y+12,{steps:3});await settle();
      assert.equal(await a.locator('.note-canvas-content').evaluate(el=>getComputedStyle(el,'::-webkit-scrollbar-button').display),'none');
      await a.screenshot({path:path.join(root,`shape-${shape}-drag.png`)});
      await viewport.press('Escape');await page.mouse.up();await settle();assert.deepEqual((await data()).nodes[0],smallNode);assert.equal(await history(),smallHistory);
      await undo();await settle();await a.click();
    }
    await apply('node',{shape:'rounded-rect',width:160,height:70,autoHeight:true});await settle();
    await page.screenshot({path:path.join(root,'styles-light-desktop.png')});
    const beforeAppearance=await frame.evaluate(el=>el.__noteCanvas.engine.stats().geometryBuilds);
    const old=await data();await apply('node',{bgColor:'#f3d9d4',bgOpacity:.4,borderColor:'#8d5148',borderWidth:2});await settle();
    assert.equal(await frame.evaluate(el=>el.__noteCanvas.engine.stats().geometryBuilds),beforeAppearance,'color does not rebuild geometry');
    assert.equal((await data()).nodes[1].bgColor,old.nodes[1].bgColor);
    assert.equal(await a.locator('.note-canvas-fill').evaluate(el=>getComputedStyle(el).fillOpacity),'0.4');
    assert.equal(await a.evaluate(el=>getComputedStyle(el).opacity),'1','fill alpha does not fade text and borders');
    const beforeIdentityRace=await data(),raceHistory=await history();
    assert.equal(await page.evaluate(async()=>{const e=RelatumNoteCanvas.getActive(),pending=e.applySelectionStyle('node',{bgOpacity:.1});e.travel(false);return pending;}),false,'undo invalidates a style operation waiting for the old model');
    await page.evaluate(()=>RelatumNoteCanvas.getActive().travel(true));await settle();assert.deepEqual(await data(),beforeIdentityRace);assert.equal(await history(),raceHistory);
    assert.equal(await viewport.evaluate(async el=>{const pending=RelatumNoteCanvas.getActive().applySelectionStyle('node',{bgOpacity:.1});el.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));return pending;}),false,'deleting the target cancels pending styles without throwing');
    await undo();await settle();assert.deepEqual(await data(),beforeIdentityRace);await a.click();
    let past=await history();
    await page.evaluate(async()=>{const e=RelatumNoteCanvas.getActive(),token={};for(const value of [.3,.2,.6,.8]) await e.applySelectionStyle('node',{bgOpacity:value},{token,final:false});await e.applySelectionStyle('node',{bgOpacity:.8},{token,final:true});});
    assert.equal(await history(),past+1,'a continuous slider is one history step');await undo();assert.equal((await data()).nodes[0].bgOpacity,.4);
    past=await history();await apply('node',{bgOpacity:.4});assert.equal(await history(),past,'unchanged styles have no history');
    await page.evaluate(async()=>{const e=RelatumNoteCanvas.getActive(),token={};await e.applySelectionStyle('node',{bgOpacity:.2},{token,final:false});e.endSelectionStyle(token,false);});
    assert.equal((await data()).nodes[0].bgOpacity,.4);assert.equal(await history(),past);
    const opacity=group('node').locator('[data-canvas-style="node.bgOpacity"]');
    await opacity.press('ArrowRight');await settle();assert.equal((await data()).nodes[0].bgOpacity,.45);assert.equal(await opacity.inputValue(),'0.45');assert.equal(await history(),past+1);
    await opacity.press('Control+z');await settle();assert.equal((await data()).nodes[0].bgOpacity,.4);assert.equal(await opacity.inputValue(),'0.4');assert.equal(await history(),past);
    for(const cancel of ['Escape','pointercancel']) {
      await opacity.evaluate(el=>{el.focus();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1}));el.value='.15';el.dispatchEvent(new Event('input',{bubbles:true}));});await settle();
      assert.equal((await data()).nodes[0].bgOpacity,.15);
      if(cancel==='Escape') await opacity.press('Escape');else await opacity.dispatchEvent('pointercancel',{pointerId:1});
      await settle();assert.equal((await data()).nodes[0].bgOpacity,.4);assert.equal(await history(),past);assert.equal(await opacity.inputValue(),'0.4');
    }
    await opacity.evaluate(el=>{el.value='.05';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
    assert.equal((await data()).nodes[0].bgOpacity,.4);assert.equal(await history(),past,'cancelled native slider events cannot restart a transaction');
    await opacity.evaluate(el=>{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:2}));el.value='.15';el.dispatchEvent(new Event('input',{bubbles:true}));});await settle();
    await b.click();await opacity.evaluate(el=>{el.value='.9';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
    assert.equal((await data()).nodes[1].bgOpacity,undefined,'a late slider event cannot retarget another selection');await undo();await settle();await a.click();
    await page.evaluate(()=>{window.trackStyleReads=true;window.styleReads=0;});await b.click({modifiers:['Shift']});await settle();
    const selectionReads=await page.evaluate(()=>{window.trackStyleReads=false;return window.styleKinds;});assert.deepEqual({node:selectionReads.node,text:selectionReads.nodeText},{node:2,text:2},'two selected nodes normalize each category once, not once per control');
    assert.equal(await group('node').locator('[data-field="bgColor"]').evaluate(el=>el.classList.contains('is-mixed')),true);
    assert.equal(await group('node').locator('[data-field="bgColor"] .note-canvas-mixed-state').innerText(),'混合');
    const aFill=(await data()).nodes[0].bgColor;await apply('node',{borderWidth:3});assert.equal((await data()).nodes[0].bgColor,aFill);assert.equal((await data()).nodes[1].borderWidth,3);
    assert.equal(await frame.locator('[data-canvas-resize]').count(),0,'multiple nodes have no single-node resize handles');
    await a.click();await settle();past=await history();
    const grip=frame.locator('[data-canvas-resize="a"][data-corner="se"]'),r=await grip.boundingBox();
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+35,r.y+r.height/2+20,{steps:8});await page.mouse.up();await settle();
    assert.equal((await data()).nodes[0].autoHeight,false);assert((await data()).nodes[0].width>160);assert.equal(await history(),past+1);await undo();await settle();
    const beforeCancel=(await data()).nodes[0],g=await grip.boundingBox();past=await history();
    await page.mouse.move(g.x+g.width/2,g.y+g.height/2);await page.mouse.down();await page.mouse.move(g.x+35,g.y+30);await viewport.press('Escape');await page.mouse.up();await settle();
    assert.deepEqual((await data()).nodes[0],beforeCancel);assert.equal(await history(),past);
    await a.click();
    const beforeOverflow=await data(),overflowHistory=await history();
    await apply('node',{width:120,height:70,autoHeight:false});await apply('nodeText',{wrap:false});
    await a.dblclick();await a.locator('textarea').fill('固定尺寸长文字'.repeat(60)+'\n显式换行\n第三行');await a.locator('textarea').press('Control+Enter');await settle();
    assert.equal(await a.evaluate(el=>el.offsetHeight),70);
    assert(await a.locator('.note-canvas-content').evaluate(el=>el.scrollWidth>el.clientWidth&&el.scrollHeight>el.clientHeight),'fixed no-wrap text scrolls in both directions');
    const content=a.locator('.note-canvas-content'),scrollCamera=await frame.locator('.note-canvas-world').evaluate(el=>el.style.transform);
    await content.hover();await page.mouse.wheel(0,60);await page.waitForFunction(()=>document.querySelector('[data-canvas-node="a"] .note-canvas-content').scrollTop>0);
    await page.mouse.wheel(120,0);await page.waitForFunction(()=>document.querySelector('[data-canvas-node="a"] .note-canvas-content').scrollLeft>0);
    assert.equal(await frame.locator('.note-canvas-world').evaluate(el=>el.style.transform),scrollCamera,'scrolling overflowing text does not zoom the canvas');
    await apply('nodeText',{wrap:true});await apply('node',{shape:'circle',autoHeight:true});await settle();
    assert(await a.evaluate(el=>el.offsetWidth===el.offsetHeight&&el.offsetHeight>120),'auto height expands both axes of a circle');
    assert(await a.evaluate(el=>el.offsetHeight<1000),'circle growth accounts for its expanding text width');
    const grownSize=await a.evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight})),grownGeometry=await frame.evaluate(el=>el.__noteCanvas.engine.stats().geometryBuilds);
    await apply('node',{bgOpacity:.25});await settle();
    assert.deepEqual(await a.evaluate(el=>({w:el.offsetWidth,h:el.offsetHeight})),grownSize);
    assert.equal(await frame.evaluate(el=>el.__noteCanvas.engine.stats().geometryBuilds),grownGeometry,'appearance changes preserve an auto-grown shape and its geometry');
    while(await history()>overflowHistory) await undo();await settle();assert.deepEqual(await data(),beforeOverflow);
    await a.click();await apply('nodeText',{fontSize:23,color:'#493b61',fontWeight:650,lineHeight:1.7,textAlign:'right',verticalAlign:'bottom',wrap:false});await settle();
    assert.equal(await a.locator('.note-canvas-content').evaluate(el=>getComputedStyle(el).whiteSpace),'pre');
    assert.equal(await a.locator('.note-canvas-content').evaluate(el=>getComputedStyle(el).fontSize),'23px');
    // Panel edits wait for the native candidate and retain the selected object.
    await a.dblclick();const input=a.locator('textarea');await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await input.fill('中文候选完成');
    assert.equal(await page.evaluate(()=>RelatumNoteCanvas.getActive().getSelection().focusKind),'nodeText');
    assert.equal(await input.evaluate(el=>document.activeElement===el),true,'panel navigation never takes the native input focus');
    const textPosition=await settings.evaluate(el=>el.scrollTop);assert(textPosition>0,'editing body text locates its typography section');
    await page.evaluate(()=>{window.stylePending=RelatumNoteCanvas.getActive().applySelectionStyle('nodeText',{fontSize:26});});
    assert.equal(await input.count(),1);assert.equal((await data()).nodes[0].fontSize,23);
    await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value})));await settle();assert.equal(await page.evaluate(()=>stylePending),true);
    assert.equal((await data()).nodes[0].text,'中文候选完成');assert.equal((await data()).nodes[0].fontSize,26);
    assert.equal(await settings.evaluate(el=>el.scrollTop),textPosition,'style and lock notifications do not reposition the panel');
    // Moving to prose invalidates a style operation still waiting on a candidate.
    await a.dblclick();await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await input.fill('第二次候选');
    await page.evaluate(()=>{window.staleStyle=RelatumNoteCanvas.getActive().applySelectionStyle('node',{bgColor:'#00ff00'});});
    await page.locator('.cm-line').filter({hasText:'前文'}).first().click();
    await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value})));await settle();assert.equal(await page.evaluate(()=>staleStyle),false);
    assert.equal((await data()).nodes[0].bgColor,aFill);assert.equal(await group('node').locator('input:enabled').count(),0);
    assert.equal(await panelMode(),'defaults');
    await a.click();await a.dblclick();await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
    await page.evaluate(()=>{window.blurStyle=RelatumNoteCanvas.getActive().applySelectionStyle('node',{bgColor:'#00ff00'});window.dispatchEvent(new Event('blur'));});
    await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value})));await settle();assert.equal(await page.evaluate(()=>blurStyle),false,'window blur cancels styles awaiting native input');assert.equal((await data()).nodes[0].bgColor,aFill);
    await group('node').locator('[data-canvas-style="node.bgColor"]').focus();
    await frame.locator('.note-canvas-edge-label[data-canvas-edge="e"]').click();await settle();
    const beforeHiddenEvent=await data();await group('node').locator('[data-canvas-style="node.bgColor"]').evaluate(el=>{el.value='#ff0000';el.dispatchEvent(new Event('input',{bubbles:true}));});await settle();
    assert.deepEqual(await data(),beforeHiddenEvent,'hidden cached controls ignore late native input');
    assert.equal(await panelMode(),'edge');assert.equal(await group('node').isVisible(),false);
    assert.equal(await page.evaluate(()=>RelatumNoteCanvas.getActive().getSelection().focusKind),'edgeText');
    assert(await settings.evaluate(el=>el.scrollTop>0),'clicking a label locates its section');
    const paths=[];
    for(const curve of ['straight','bezier','smooth','elbow','rounded-elbow']) {await apply('edge',{curve});await settle();paths.push((await point(.3)).d);assert.equal(await group('edge').locator('[data-field="cornerRadius"]').isVisible(),curve==='rounded-elbow');}
    assert.equal(new Set(paths).size,5,'all five path types have distinct geometry');
    const labelStats=await frame.evaluate(el=>el.__noteCanvas.engine.stats());await apply('edge',{labelPosition:.35,labelOffsetX:10});await settle();
    assert.deepEqual(await frame.evaluate(el=>({builds:el.__noteCanvas.engine.stats().geometryBuilds,draws:el.__noteCanvas.engine.stats().staticDraws})),
      {builds:labelStats.geometryBuilds,draws:labelStats.staticDraws},'sidebar label positioning reuses geometry and never redraws the static edge layer');
    await apply('edge',{curve:'rounded-elbow',fromSide:'bottom',toSide:'top',cornerRadius:22,lineStyle:'dotted',color:'#49734e',width:4,arrowStart:true,arrowEnd:true,arrowSize:18,labelPosition:.65,labelOffsetX:15,labelOffsetY:-10});await settle();
    await apply('edgeText',{fontSize:18,color:'#274d65',fontWeight:600,lineHeight:1.6,wrap:true,width:110,height:60,textAlign:'left',verticalAlign:'bottom'});await settle();
    assert.equal((await data()).edges[0].labelStyle.width,110);
    assert.equal(await frame.locator('.note-canvas-edge-label[data-canvas-edge="e"]').evaluate(el=>getComputedStyle(el).width),'110px');
    if(fallback) {assert(await frame.locator('.note-canvas-live g').count()>0);assert.equal(await frame.locator('.note-canvas-live g').first().locator('polygon').count(),2);}
    else assert(await frame.locator('.note-canvas-edges').evaluate(el=>{const pixels=el.getContext('2d').getImageData(0,0,el.width,el.height).data;return pixels.some((v,i)=>i%4===3&&v>0);}), 'static canvas is nonblank');
    await apply('edge',{curve:'straight',fromSide:'auto',toSide:'auto',labelPosition:.5,labelOffsetX:0,labelOffsetY:0});await settle();
    let p=await point(.25);past=await history();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+10,p.y-40,{steps:8});await page.mouse.up();await settle();
    assert.equal((await data()).edges[0].waypoints.length,1);assert.equal(await history(),past+1);
    const bend=frame.locator('[data-canvas-bend="e"]'),bendBox=await bend.boundingBox();const beforeBend=(await data()).edges[0].waypoints;past=await history();
    await page.mouse.move(bendBox.x+bendBox.width/2,bendBox.y+bendBox.height/2);await page.mouse.down();await page.mouse.move(bendBox.x+35,bendBox.y-20);await viewport.press('Escape');await page.mouse.up();await settle();
    assert.deepEqual((await data()).edges[0].waypoints,beforeBend);assert.equal(await history(),past);
    await frame.locator('.note-canvas-edge-label[data-canvas-edge="e"]').click();await settle();
    await bend.dblclick();await settle();assert.equal((await data()).edges[0].waypoints.length,0);
    const label=frame.locator('.note-canvas-edge-label[data-canvas-edge="e"]'),labelBox=await label.boundingBox();past=await history();
    await page.mouse.move(labelBox.x+labelBox.width/2,labelBox.y+labelBox.height/2);await page.mouse.down();await page.mouse.move(labelBox.x+labelBox.width/2+25,labelBox.y+labelBox.height/2+12);await page.mouse.up();await settle();
    assert((await data()).edges[0].labelOffsetX>0);assert.equal(await history(),past+1);
    await frame.locator('.note-canvas-edge-label[data-canvas-edge="f"]').click({modifiers:['Shift']});await apply('edge',{width:2.7});
    assert((await data()).edges.every(edge=>edge.width===2.7));
    assert.equal(await group('edge').locator('[data-canvas-style="edge.curve"]').inputValue(),'','different path types display a mixed option');
    const fLabel=frame.locator('.note-canvas-edge-label[data-canvas-edge="f"]');await fLabel.click();await settle();
    const fGrip=await frame.locator('[data-canvas-bend="f"]').boundingBox();
    await page.mouse.move(fGrip.x+fGrip.width/2,fGrip.y+fGrip.height/2);await page.mouse.down();await page.mouse.move(fGrip.x+20,fGrip.y-15);await page.mouse.up();await settle();
    assert.equal((await data()).edges[1].waypoints[0].customPoint,'keep','moving a waypoint retains unknown metadata');await undo();await settle();
    const fBox=await fLabel.boundingBox(),beforeReturn=(await data()).edges[1];past=await history();
    await page.mouse.move(fBox.x+fBox.width/2,fBox.y+fBox.height/2);await page.mouse.down();await page.mouse.move(fBox.x+fBox.width/2+20,fBox.y+fBox.height/2+20);await settle();
    await page.mouse.move(fBox.x+fBox.width/2,fBox.y+fBox.height/2);await page.mouse.up();await settle();
    assert.equal(await history(),past,'returning a label to its original offset has no history');assert.deepEqual((await data()).edges[1],beforeReturn);
    await a.click({modifiers:['Shift']});await settle();assert.equal(await panelMode(),'mixed');
    assert.equal(await group('mixed').locator('input').count(),5);assert.equal(await group('mixed').locator('input:not([type="color"])').count(),0);
    const beforeMixed=await data();past=await history();
    for(const [kind,key,color] of [['node','bgColor','#aabbcc'],['node','borderColor','#334455'],['nodeText','color','#223344'],['edge','color','#667788'],['edgeText','color','#112233']]) {
      const before=await data(),count=await history();
      await group('mixed').locator(`[data-canvas-style="${kind}.${key}"]`).evaluate((el,color)=>{el.value=color;el.dispatchEvent(new Event('input',{bubbles:true}));},color);await settle();
      const expected=structuredClone(before);if(kind==='node'||kind==='nodeText') expected.nodes[0][key]=color;
      else if(kind==='edgeText') expected.edges[1].labelStyle={...expected.edges[1].labelStyle,[key]:color};else expected.edges[1][key]=color;
      assert.deepEqual(await data(),expected,`${kind}.${key} changes only its selected target category`);assert.equal(await history(),count+1);
    }
    const colored=await data();await group('mixed').locator('[data-field="bgColor"] button').click();await settle();assert.equal((await data()).nodes[0].bgColor,'');assert.deepEqual((await data()).edges,colored.edges);
    while(await history()>past) await undo();await settle();assert.deepEqual(await data(),beforeMixed);assert.equal(await panelMode(),'mixed','history keeps the mixed selection panel');
    await page.screenshot({path:path.join(root,'styles-mixed-desktop.png')});
    await viewport.click({position:{x:15,y:15}});await settle();assert.equal(await panelMode(),'defaults');
    await page.screenshot({path:path.join(root,'styles-defaults-desktop.png')});
    const beforeDefaults=await data(),defaultHistory=await history();await group('defaults').locator('[data-shape="pill"]').click();await settle();assert.deepEqual(await data(),beforeDefaults);
    await group('defaults').locator('[data-canvas-style="node.width"]').press('Control+z');assert.deepEqual(await data(),beforeDefaults);assert.equal(await history(),defaultHistory,'undo in creation defaults does not change canvas history');
    await group('defaults').locator('[data-canvas-style="node.bgOpacity"]').evaluate(el=>{window.detachedRange=el;el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:3}));el.value='.2';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await group('defaults').locator('[data-default-target="edge"]').click();
    await page.evaluate(()=>{detachedRange.value='.05';detachedRange.dispatchEvent(new Event('input',{bubbles:true}));detachedRange.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>RelatumNoteCanvasStyle.readDefaults().node.bgOpacity),1,'rebuilding a panel cancels uncommitted defaults and ignores detached controls');
    await viewport.dblclick({position:{x:300,y:320}});await viewport.locator('textarea').fill('继承默认');await viewport.locator('textarea').press('Control+Enter');await settle();
    assert.equal((await data()).nodes.at(-1).shape,'pill');assert.equal((await data()).nodes.at(-1).kind,'index');
    await viewport.click({position:{x:15,y:15}});await settle();
    await settings.locator('[data-note-action="reset-canvas-settings"]').click();assert.equal(await page.evaluate(()=>RelatumNoteCanvasStyle.readDefaults().node.shape),'rounded-rect');
    assert.equal((await data()).nodes.at(-1).shape,'pill','default reset preserves existing nodes');
    assert.equal(await page.evaluate(()=>CanvasNoteWorkspace.flushSave()),true);
    const saved=JSON.parse(fs.readFileSync(path.join(root,'notes/canvases/styles.canvas'),'utf8'));assert.deepEqual(saved.custom,{preserved:true});assert.equal(saved.nodes[0].text,'第二次候选');
    await a.click();await a.dblclick();
    await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
    await frame.evaluate(el=>{window.destroyStyle=RelatumNoteCanvas.getActive().applySelectionStyle('node',{bgColor:'#00ff00'});window.destroyDone=el.__noteCanvas.destroy();});
    await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:el.value})));
    await page.evaluate(()=>destroyDone);assert.equal(await page.evaluate(()=>destroyStyle),false,'destroying an instance cancels a waiting style operation');
    await page.evaluate(()=>T.openNote('B.md'));await page.waitForFunction(()=>document.querySelector('.note-canvas-frame')?.__noteCanvas?.engine);assert.equal((await data()).nodes[0].fontSize,26);
    await page.evaluate(()=>T.setViewMode('source'));assert.equal(await page.evaluate(()=>RelatumNoteCanvas.getActive()),null);assert.equal(await group('node').locator('input:enabled').count(),0);
    await page.evaluate(()=>T.setViewMode('reading'));await page.waitForFunction(()=>document.querySelector('.note-reading-content .note-canvas-frame')?.__noteCanvas?.engine);
    assert.equal(await page.locator('.note-reading-content [data-canvas-resize]').count(),0);
    const readingViewport=page.locator('.note-reading-content .note-canvas-viewport');
    await readingViewport.click({position:{x:15,y:15}});await readingViewport.press('Tab');assert.equal(await sideOpen(),false);
    await readingViewport.press('Tab');assert.equal(await sideOpen(),true);assert.equal(await page.evaluate(()=>T.state.sideMode),'canvas');
    assert(await readingViewport.evaluate(el=>document.activeElement===el),'reading canvas keeps focus for repeated toggles');
    await page.evaluate(()=>T.setViewMode('live'));await page.waitForFunction(()=>document.querySelector('.note-canvas-frame')?.__noteCanvas?.engine);
    await page.evaluate(()=>RelatumI18n.setLanguage('en'));await settle();assert.equal(await group('node').locator('[data-shape="diamond"]').getAttribute('aria-label'),'Diamond');
    await page.evaluate(()=>{document.documentElement.dataset.startTheme=document.body.dataset.startTheme='dark';});await settle();
    assert.equal(await a.locator('.note-canvas-fill').evaluate(el=>getComputedStyle(el).fill),'rgb(243, 217, 212)','custom colors survive theme changes');
    await page.setViewportSize({width:940,height:800});await settle();
    assert(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth));
    assert(await defaultTabs.evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth&&el.scrollHeight<=el.clientHeight)),'English tabs fit the narrow sidebar');
    assert.equal(await settings.evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');assert.equal(await settings.evaluate(el=>el.offsetWidth-el.clientWidth),0);
    await group('defaults').locator('[data-canvas-style="edge.width"]').hover();const defaultScroll=await settings.evaluate(el=>el.scrollTop);await page.mouse.wheel(0,120);
    await page.waitForFunction(scroll=>document.querySelector('[data-role="note-canvas-settings"]').scrollTop>scroll,defaultScroll);
    await settings.evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:path.join(root,'styles-dark-narrow.png')});
    await frame.locator('.note-canvas-edge-label[data-canvas-edge="e"]').click();
    await settings.evaluate(el=>{el.scrollTop=0;});await settle();
    await page.screenshot({path:path.join(root,'styles-edge-narrow.png')});
    assert.deepEqual(errors,[]);return {full,fallback,shapes:12,paths:5,screenshot:path.join(root,'styles-dark-narrow.png')};
  } catch(error) {
    if(page) console.error('Style diagnostics',await page.evaluate(()=>({active:!!window.RelatumNoteCanvas?.getActive(),selection:window.RelatumNoteCanvas?.getActive()?.getSelection(),html:document.querySelector('[data-role="note-canvas-style-groups"]')?.outerHTML?.slice(0,1200)})).catch(()=>null));throw error;
  } finally {await context.close();server.kill();}
}
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.RELATUM_EDGE_PATH?{executablePath:process.env.RELATUM_EDGE_PATH}:{})});
  try {console.log(JSON.stringify([await run(browser,false),await run(browser,true),await run(browser,false,true)],null,2));}
  finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

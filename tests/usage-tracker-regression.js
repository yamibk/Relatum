'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/usage-tracker.js'),'utf8');
const cats=['notes','canvas','embedded','research','study','tree','quicknotes','review','checkin'];
class Events{constructor(){this.listeners={};}addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}emit(type,data={}){for(const fn of this.listeners[type]||[])fn(data);}}
function storage(){const result={};Object.defineProperties(result,{getItem:{value:key=>result[key]??null},setItem:{value:(key,value)=>{result[key]=value;}},removeItem:{value:key=>delete result[key]}});return result;}
async function host(options={}){
  let clock=1000000,next=0,fail=false,focus=true,hidden=false;
  let releaseState;
  const stateReady=options.delayState?new Promise(resolve=>{releaseState=resolve;}):Promise.resolve();
  const timers=new Map(),requests=[],inputs=[],settings=Object.fromEntries(cats.map(c=>[c,true]));
  class Element extends Events{constructor(tag){super();this.tagName=tag;this.dataset={};this.children=[];}append(...nodes){for(const n of nodes){this.children.push(n);n.parentElement=this;if(n.tagName==='input')inputs.push(n);}}closest(){return this.parentElement;}querySelector(){return this.children.find(c=>c.tagName==='span');}}
  const controls=new Element('div'),panel=new Element('section'),gear=new Element('div');
  const doc=new Events();Object.assign(doc,{readyState:'complete',documentElement:{lang:'zh-CN',dataset:{startWorkspace:'notes'}},body:{dataset:{}},hasFocus:()=>focus,createElement:tag=>new Element(tag),querySelector:selector=>selector==='[data-usage-panel]'?panel:selector==='[data-role="start-speed-pop"]'?gear:null,querySelectorAll:selector=>selector==='[data-usage-settings]'?[controls]:selector==='[data-usage-category]'?inputs:[]});
  Object.defineProperty(doc,'hidden',{get:()=>hidden});
  const win=new Events(),ls=options.storage||storage(),ss=storage();
  const env={window:win,document:doc,localStorage:ls,sessionStorage:ss,TextEncoder,Event:class{},CustomEvent:class{},Date:class extends Date{static now(){return clock;}},JSON,Object,Math,Promise,console,
    setTimeout:(fn,ms=0)=>{timers.set(++next,{fn,at:clock+ms});return next;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{timers.set(++next,{fn,at:clock+ms,period:ms});return next;},clearInterval:id=>timers.delete(id),
    fetch:async(url,request)=>{requests.push({url,body:request?.body?JSON.parse(request.body):null});if(url==='/api/usage/state')await stateReady;if(fail)return{ok:false};if(request?.body){for(const c of JSON.parse(request.body).settings)settings[c.category]=c.enabled;}return{ok:true,json:async()=>({settings:{...settings},since:1000000})};}};
  Object.assign(win,{parent:options.parent||win,crypto:{randomUUID:()=>String(++next)},CanvasNoteWorkspace:{usagePath:'A.md'},RelatumFeatures:{features:{}},RelatumI18n:{language:'zh-CN'}});
  vm.runInNewContext(source,env);const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};await drain();
  return {win,doc,requests,inputs,timers,ls,drain,releaseState:()=>releaseState?.(),set fail(value){fail=value;},set focus(value){focus=value;},set hidden(value){hidden=value;},
    sleep(ms){clock+=ms;},async advance(ms){const end=clock+ms;while(true){const candidate=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!candidate)break;const[id,t]=candidate;clock=t.at;if(t.period)t.at+=t.period;else timers.delete(id);t.fn();await drain();}clock=end;await drain();},
    rows(){return requests.flatMap(r=>r.body?.intervals||[]);}};
}
(async()=>{
  const h=await host();await h.advance(10000);h.win.CanvasNoteWorkspace.usagePath='B.md';h.doc.emit('relatum:usage-target');await h.drain();await h.advance(5000);await h.win.RelatumUsage.flush();
  assert.deepEqual(h.rows().map(r=>[r.locator,r.end-r.start]),[['A.md',10000],['B.md',5000]],'rapid target tails');
  h.focus=false;h.win.emit('blur');await h.advance(0);const count=h.rows().length;await h.advance(60000);assert.equal(h.rows().length,count,'unfocused time excluded');
  h.focus=true;h.win.emit('focus');await h.advance(5000);h.sleep(600000);h.win.emit('focus');await h.drain();await h.advance(5000);await h.win.RelatumUsage.flush();assert(h.rows().every(r=>r.end-r.start<=30000),'sleep never backfills');
  h.doc.documentElement.dataset.desktopMinimized='1';h.win.emit('canvasdesktop:visibility',{detail:{minimized:true}});await h.drain();const minimized=h.rows().length;await h.advance(35000);assert.equal(h.rows().length,minimized,'native minimize overrides stale WebView2 focus');
  h.doc.documentElement.dataset.desktopMinimized='0';h.win.emit('canvasdesktop:visibility',{detail:{minimized:false}});await h.drain();
  const off=h.inputs.find(i=>i.dataset.usageCategory==='notes');off.checked=false;off.emit('change');await h.drain();const whenOff=h.rows().length;await h.advance(35000);assert.equal(h.rows().length,whenOff,'disabled reading excluded');
  off.checked=true;off.emit('change');await h.drain();await h.advance(5000);h.fail=true;await assert.rejects(h.win.RelatumUsage.flush());assert(h.win.RelatumUsage.pending>0);const pending=h.requests.at(-1).body.intervals[0];h.fail=false;await h.win.RelatumUsage.flush();assert.equal(h.requests.at(-1).body.intervals[0].id,pending.id,'retry keeps receipt id');
  h.doc.documentElement.dataset.startWorkspace='career';h.doc.emit('relatum:start-workspacechange');await h.drain();const career=h.rows().length;await h.advance(35000);assert.equal(h.rows().length,career,'Career does not collect itself');
  const child=await host({parent:h.win});assert.equal(child.win.RelatumUsage,h.win.RelatumUsage);assert.equal(child.requests.length,0,'iframe has no second owner');assert.equal(child.timers.size,0);
  h.win.emit('pagehide');await h.drain();assert.equal(h.timers.size,0,'close releases probe and retry timers');
  const failed=await host();failed.fail=true;await failed.advance(10000);failed.win.emit('pagehide');await failed.drain();assert(Object.keys(failed.ls).some(k=>k.startsWith('canvas:usageQueue:v2:')),'failed close preserves durable queue');
  const restored=await host({storage:failed.ls});await restored.drain();assert(restored.rows().some(r=>r.locator==='A.md'&&r.end-r.start===10000),'next owner recovers closed queue');
  restored.win.emit('pagehide');await restored.drain();
  const late=await host({delayState:true});late.win.emit('pagehide');late.releaseState();await late.drain();
  assert.equal(late.timers.size,0,'late initialization cannot restart a closed owner');
  late.win.emit('pageshow');await late.drain();assert.equal([...late.timers.values()].filter(t=>t.period).length,1,'page restore has one owner timer');
  await late.advance(5000);await late.win.RelatumUsage.flush();assert.equal(late.rows().at(-1).end-late.rows().at(-1).start,5000);
  late.win.emit('pagehide');await late.drain();
  console.log('usage collector: target tails, focus, sleep, switches, retries, iframe ownership, exclusions and recovery passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
// Production scheduler with a deterministic display clock; no browser/data writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'..','assets','career',name),'utf8');
let now=0,reduced=false,frameId=0;
const frames=new Map();
class Text {
  constructor(value){this.value=value;this.writes=0;}
  get data(){return this.value;}
  set data(value){this.value=value;this.writes++;}
}
class Element {
  constructor(){this.dataset={};this.children=[];this.attributes={};}
  matches(){return this.dataset.careerNumber!==undefined&&this.dataset.counted!=='1';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;}
}
const context={Intl,window:{RelatumI18n:{language:'zh-CN'}},document:{documentElement:{lang:'zh-CN'},createElement:()=>new Element(),createTextNode:value=>new Text(value)},
  performance:{now:()=>now},matchMedia:()=>({matches:reduced}),requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id)};
vm.runInNewContext(read('data.js').replace(/export /g,'')+'\nthis.format={metricNumber,metricDuration};',context);
vm.runInNewContext(read('motion.js').replace(/export /g,'')+'\nthis.motion={scheduler,prepareNumber,animateNumbers,numberMotion};',context);
const {scheduler,prepareNumber,animateNumbers,numberMotion}=context.motion;
function frame(at){now=at;const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(now);}
function metric(value,format=context.format.metricNumber){const node=new Element();node.dataset.careerNumber=String(value);node._format=format;node.textContent=format(value);return node;}
function reset(){assert.equal(frames.size,0);now=0;reduced=false;}

assert.equal(numberMotion.duration,1500);
for(const rate of [30,60,120]){
  reset();const values=[],node=metric(100000,value=>{values.push(value);return context.format.metricNumber(value);}),schedule=scheduler();
  prepareNumber(node);const text=node._numberText;
  assert.equal(text.data,'0');assert.equal(node.children[0].attributes['aria-hidden'],'true');
  animateNumbers(node,schedule,()=>false);
  for(let i=1;i<=Math.ceil(1500*rate/1000);i++)frame(Math.min(1500,i*1000/rate));
  assert.equal(text.data,'100,000');assert.equal(schedule.size,0);assert.equal(frames.size,0);
  const samples=values.slice(2); // initial final-size reservation and zero presentation
  assert(samples.every((v,i)=>!i||v>=samples[i-1]),'growth is monotonic at '+rate+'Hz');
  assert.equal(node._numberText,text,'one stable text node');
}
reset();{
  const schedule=scheduler(),node=metric(100000),finish=animateNumbers(node,schedule,()=>false);
  frame(180);assert.equal(node._numberText.data,'3,974','soft start is about 4%, rather than 68%');
  frame(750);assert.equal(node._numberText.data,'50,000');
  frame(1500);assert.equal(node._numberText.data,'100,000','dropped frames do not stretch elapsed time');
  const writes=node._numberText.writes;finish();finish();assert.equal(node._numberText.writes,writes,'finished cleanup performs no repeated writes');
}
reset();{
  const schedule=scheduler(),node=metric(1000);let paused=false;
  animateNumbers(node,schedule,()=>paused);frame(100);const before=node._numberText.data;
  paused=true;frame(600);assert.equal(node._numberText.data,before);
  paused=false;frame(700);assert.equal(node._numberText.data,before,'resuming excludes the paused interval');
  frame(2099);assert(schedule.size>0);frame(2100);assert.equal(node._numberText.data,'1,000');assert.equal(frames.size,0);
}
reset();{
  const schedule=scheduler(),node=metric(1);animateNumbers(node,schedule,()=>false);
  for(let i=1;i<=90;i++)frame(i*1500/90);
  assert.equal(node._numberText.writes,1,'small integer only writes when the displayed value changes');
}
reset();{
  const schedule=scheduler(),node=metric(10),finish=animateNumbers(node,schedule,()=>false);frame(100);
  finish();assert.equal(node._numberText.data,'10');assert.equal(frames.size,0);frame(1000);assert.equal(node._numberText.data,'10');
}
for(const language of ['zh-CN','en']){
  context.window.RelatumI18n.language=language;
  for(const target of [12.125,59.9,60,3599.5,3600,7200]){
    const format=context.format.metricDuration(target),unit=format(target).split(' ').pop();
    for(const value of [0,target*.01,target*.5,target])assert.equal(format(value).split(' ').pop(),unit,'unit stays fixed');
    assert.equal(format(null),'—');
  }
  assert.equal(context.format.metricNumber(6.8),'7');assert.equal(context.format.metricNumber(null),'—');
}
reset();{
  const schedule=scheduler(),zero=metric(0);animateNumbers(zero,schedule,()=>false);assert.equal(zero.textContent,'0');assert.equal(schedule.size,0);
  reduced=true;const node=metric(10);animateNumbers(node,schedule,()=>false);assert.equal(node.textContent,'10');assert.equal(frames.size,0);
  reduced=false;const prepared=metric(10);prepareNumber(prepared);reduced=true;animateNumbers(prepared,schedule,()=>false);
  assert.equal(prepared._numberText.data,'10','reduced motion after preparation settles directly');assert.equal(frames.size,0);
}
console.log('Career numbers: 30/60/120Hz, elapsed time, pause, integer/unit stability, deduplicated writes, cancellation and reduced motion passed');

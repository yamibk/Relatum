'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const current=fs.readFileSync(path.join(root,'assets/career/data.js'),'utf8');
const previous=execFileSync('git',['show','82c150e:assets/career/data.js'],{cwd:root,encoding:'utf8'});
function api(source){const context={window:{RelatumI18n:{language:'zh-CN'}},document:{documentElement:{lang:'zh-CN'}},Intl,Date,Map,Set};vm.runInNewContext(source.replace(/export /g,'')+'\nthis.api={select,scale:typeof chartScale==="function"?chartScale:null,prepare:typeof prepareReport==="function"?prepareReport:null};',context);return context.api;}
const before=api(previous),after=api(current),at=text=>new Date(text).getTime();
const categories=['notes','canvas','research','study','tree','quicknotes','review','checkin','embedded'];
const report={history:{since:at('2026-01-01T09:00:00'),cutoff:at('2026-12-31T12:00:00'),days:[],entityDays:[],events:[],hours:[],entities:[],coverage:[]},inventory:{notes:{items:[{id:'a',words:10},{id:'b',words:100}]},embedded:{items:[{references:3}]},research:{items:[{nodes:12}]}}};
for(let i=0;i<99;i++){const category=categories[i%9];report.history.coverage.push({category,at:at('2025-12-30T00:00:00')+Math.floor(i/9)*20*86400000+i*1700,enabled:i%4!==0});}
for(let i=0;i<240;i++){const date=new Date(2026,0,i+1,12),day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;report.history.days.push({date:day,seconds:i%3?i+.125:0});report.history.entityDays.push({date:day,id:'a',category:'notes',seconds:i});report.history.hours.push({date:day,hour:i%24,seconds:i});report.history.events.push({day,kind:i%2?'created':'checkin',category:'notes',entity:'a',count:1});}
report.history.entities.push({id:'a',name:'Alpha',category:'notes'});
const bytes=JSON.stringify(report),prepared=after.prepare(report);
assert.equal(prepared,after.prepare(report),'static preparation reused');
for(const filter of [{mode:'all'},{mode:'30'},{mode:'90'},{mode:'year',year:'2025'},{mode:'custom',start:'2026-03-03',end:'2026-08-11'}]){
  const a=before.select(report,filter),b=after.select(report,filter);
  for(const key of ['start','end','seconds','activeDays','longest'])assert.equal(b[key],a[key]);
  assert.equal(JSON.stringify(b.rankings('notes')),JSON.stringify(a.rankings('notes')));
  assert.equal(b,after.select(report,{...filter}),'identical range projection reused');
  for(let i=0;i<365;i+=7){const date=new Date(2026,0,i+1,12),day=`2026-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;for(const category of [null,...categories,'unknown'])assert.equal(b.collection(day,category),a.collection(day,category),`${day}/${category}`);}
  assert.equal(b.hourTotals.reduce((a,b)=>a+b,0),b.hours.reduce((a,b)=>a+b.seconds,0));
  assert.equal(b.eventKinds.get('checkin')||0,b.events.filter(r=>r.kind==='checkin').length);
}
assert.equal(JSON.stringify(report),bytes,'frozen snapshot not mutated');
const outside=JSON.parse(bytes);outside.history.days.push({date:'2027-01-01',seconds:1000});outside.history.events.push({day:'2025-01-01',count:1000,kind:'created',category:'notes'});
const originalOutside=before.select(outside,{mode:'all'}),currentOutside=after.select(outside,{mode:'all'});
assert.equal(currentOutside.seconds,originalOutside.seconds,'out-of-range rows are excluded even for all mode');assert.equal(currentOutside.events.length,originalOutside.events.length);
const calls={filters:0,sorts:0},coverage=new Proxy(report.history.coverage,{get(target,key,receiver){if(key==='filter')return fn=>{calls.filters++;const rows=target.filter(fn),sort=rows.sort;rows.sort=function(...args){calls.sorts++;return sort.apply(this,args);};return rows;};return Reflect.get(target,key,receiver);}});
const observed={...report,history:{...report.history,coverage}};
function inspectCoverage(api){calls.filters=calls.sorts=0;const data=api.select(observed,{mode:'all'});for(let day=1;day<=7;day++){const date='2026-01-0'+day;data.collection(date);data.collection(date,'notes');}return{...calls};}
const coverageCalls={before:inspectCoverage(before),after:inspectCoverage(after)};assert.equal(coverageCalls.before.filters,70);assert.equal(coverageCalls.before.sorts,70);assert.equal(coverageCalls.after.filters,0);assert.equal(coverageCalls.after.sorts,0);
for(const max of [0,.001,.01,.125,59.999,60,147,3599,3600,72000]){const s=after.scale(max,{time:true});assert(s.max*s.divisor>=max);assert.equal(new Set(s.ticks.map(s.format)).size,s.ticks.length,'distinct duration ticks');assert(s.ticks.length>=2&&s.ticks.length<=7);}
for(const max of [0,1,2,3,5,123]){const s=after.scale(max,{count:true});assert(s.ticks.every(Number.isInteger));assert.equal(new Set(s.ticks.map(s.format)).size,s.ticks.length);}
assert.equal(after.scale(147,{time:true}).unit,'分钟');assert.equal(after.scale(.001,{time:true}).unit,'秒');
// Local midnight follows DST; collection is measured against the actual day.
if(!process.argv.includes('--dst'))execFileSync(process.execPath,[__filename,'--dst'],{env:{...process.env,TZ:'America/New_York'},stdio:'pipe'});
else{
  const r={history:{since:at('2026-03-01T00:00:00'),cutoff:at('2026-11-10T00:00:00'),days:[],entityDays:[],hours:[],events:[],entities:[],coverage:[{category:'notes',at:at('2026-03-01T00:00:00'),enabled:true},{category:'notes',at:at('2026-11-02T00:00:00'),enabled:false}]}};
  const data=after.select(r,{mode:'all'});assert.equal(data.collection('2026-03-08','notes'),'on');assert.equal(data.collection('2026-11-01','notes'),'on');assert.equal(data.collection('2026-11-02','notes'),'off');
}
console.log('Career preparation, projection reuse, legacy equivalence, local DST, immutable inventory and readable axes passed');console.log(JSON.stringify({coverageCalls}));

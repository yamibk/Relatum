export const en = () => (window.RelatumI18n?.language || document.documentElement.lang) === 'en';
export const tr = (zh, english) => en() ? english : zh;
const formats={en:new Intl.NumberFormat('en-US',{maximumFractionDigits:1}),zh:new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1})};
export const number = value => value == null ? '—' : formats[en()?'en':'zh'].format(value);
export function exactDuration(seconds){
  if(seconds==null)return '—';
  const ms=Math.round(seconds*1000),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${ms%1000?'.'+String(ms%1000).padStart(3,'0'):''}`;
}
export function duration(seconds) {
  if (seconds == null) return '—';
  return seconds >= 3600 ? `${number(seconds / 3600)} ${tr('小时', 'h')}` : seconds >= 60 ? `${number(seconds / 60)} ${tr('分钟', 'min')}` : `${number(seconds)} ${tr('秒', 's')}`;
}
// Metrics count whole items; durations keep their final unit throughout counting.
export const metricNumber = value => value == null ? '—' : number(Math.round(value));
export function metricDuration(target) {
  const divisor = target >= 3600 ? 3600 : target >= 60 ? 60 : 1;
  const unit = divisor === 3600 ? tr('小时', 'h') : divisor === 60 ? tr('分钟', 'min') : tr('秒', 's');
  return value => value == null ? '—' : `${number(value / divisor)} ${unit}`;
}
export function el(tag, className = '', text = '') {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== '') node.textContent = text; return node;
}
export const categories = {
  notes: ['笔记', 'Notes'], canvas: ['画布', 'Canvas'], embedded: ['内嵌画布', 'Embedded canvas'], research: ['研究', 'Research'],
  study: ['学习', 'Learning'], tree: ['树状', 'Trees'], quicknotes: ['速记', 'Quick notes'], review: ['复习', 'Review'], checkin: ['打卡', 'Check-ins']
};
export const label = category => categories[category]?.[en() ? 1 : 0] || category;
export const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const dateValue = text => new Date(text + 'T12:00:00').getTime();
export function calendarDays(start, end) {
  const result = [], cursor = new Date(start + 'T12:00:00'), last = new Date(end + 'T12:00:00');
  while (cursor <= last) { result.push(dateKey(cursor)); cursor.setDate(cursor.getDate() + 1); }
  return result;
}
// Derived state belongs to the frozen snapshot, never to persisted user data.
const preparedReports = new WeakMap();
export function prepareReport(report) {
  let prepared = preparedReports.get(report);
  if (prepared) return prepared;
  const history = report.history, policies = new Map(), intervals = new Map();
  for (const row of history.coverage) {
    if (!policies.has(row.category)) policies.set(row.category, []);
    policies.get(row.category).push(row);
  }
  function merge(spans) {
    spans.sort((a,b)=>a[0]-b[0]);
    const result=[];
    for (const span of spans) {
      const last=result[result.length-1];
      if (last && span[0]<=last[1]) last[1]=Math.max(last[1],span[1]);
      else result.push(span.slice());
    }
    return result;
  }
  const all=[];
  for (const [category, rows] of policies) {
    rows.sort((a,b)=>a.at-b.at);
    const spans=[];
    rows.forEach((row,i)=>{
      const a=Math.max(history.since,row.at), b=Math.min(history.cutoff,rows[i+1]?.at??history.cutoff);
      if(row.enabled && b>a) spans.push([a,b]);
    });
    intervals.set(category,merge(spans));
    if(categories[category]) all.push(...spans);
  }
  intervals.set('all',merge(all));
  const bounds=new Map(),noteUsageDays=Array.isArray(history.noteUsageDays)?history.noteUsageDays:null;
  for(const name of ['days','entityDays','events','hours','noteUsageDays']){
    let first=null,last=null,invalid=false;
    for(const row of (name==='noteUsageDays'?noteUsageDays:history[name])||[]){const day=row.date||row.day;if(typeof day!=='string'){invalid=true;continue;}if(first===null||day<first)first=day;if(last===null||day>last)last=day;}
    bounds.set(name,{first,last,invalid});
  }
  const stock=report.inventory;
  const sorted=(rows,key)=>rows.map(row=>({...row,value:row[key]})).sort((a,b)=>b.value-a.value);
  prepared={entities:new Map(history.entities.map(row=>[row.id,row])),policies,intervals,bounds,noteUsageDays,
    noteCount:history.entities.filter(row=>row.category==='notes').length,
    inventoryRows:stock?{noteSize:sorted(stock.notes.items,'words'),embeddedStructure:sorted(stock.embedded.items,'references'),researchSize:sorted(stock.research.items,'nodes')}:null,
    selection:null};
  preparedReports.set(report,prepared);
  return prepared;
}
export function select(report, filter) {
  const history = report.history;
  const prepared=prepareReport(report);
  const cutoff = dateKey(new Date(history.cutoff));
  let start = dateKey(new Date(history.since)), end = cutoff;
  if (filter.mode === '30' || filter.mode === '90') { const d = new Date(end + 'T12:00:00'); d.setDate(d.getDate() - Number(filter.mode) + 1); start = dateKey(d); }
  else if (filter.mode === 'year') {
    const year=/^\d{4}$/.test(String(filter.year))&&Number(filter.year)<=Number(cutoff.slice(0,4))?String(filter.year):cutoff.slice(0,4);
    start=year+'-01-01';end=year===cutoff.slice(0,4)?cutoff:year+'-12-31';
  }
  else if (filter.mode === 'custom') { start = filter.start || start; end = filter.end || end; }
  if(prepared.selection?.start===start && prepared.selection.end===end) return prepared.selection;
  const inRange = row => (row.date || row.day) >= start && (row.date || row.day) <= end;
  const choose=name=>{const range=prepared.bounds.get(name),rows=name==='noteUsageDays'?prepared.noteUsageDays:history[name];return !range.invalid&&(range.first===null||start<=range.first&&end>=range.last)?rows:rows.filter(inRange);};
  const days=choose('days'),entityDays=choose('entityDays'),events=choose('events'),hours=choose('hours');
  const noteUsageDays=prepared.noteUsageDays?choose('noteUsageDays'):null;
  const previousSelection=prepared.selection;
  if(previousSelection&&previousSelection.days===days&&previousSelection.entityDays===entityDays&&previousSelection.events===events&&previousSelection.hours===hours&&previousSelection.noteUsageDays===noteUsageDays){prepared.selection={...previousSelection,start,end};return prepared.selection;}
  const active = days.filter(d => d.seconds > 0).map(d => d.date);
  let longest = 0, streak = 0, previous = null;
  for (const day of active) { streak = previous && Math.round((dateValue(day)-dateValue(previous))/86400000) === 1 ? streak + 1 : 1; longest = Math.max(longest, streak); previous = day; }
  const seconds = days.reduce((s,d) => s+d.seconds,0);
  const totals = new Map();
  for (const row of entityDays) totals.set(row.id, (totals.get(row.id)||0)+row.seconds);
  const entities = prepared.entities;
  function collection(date,category=null){
    const a=new Date(date+'T00:00:00').getTime(),next=new Date(a);next.setDate(next.getDate()+1);const b=next.getTime();
    const spans=prepared.intervals.get(category||'all')||[];
    let lo=0,hi=spans.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(spans[mid][1]<=a)lo=mid+1;else hi=mid;}
    let covered=0;
    for(let i=lo;i<spans.length&&spans[i][0]<b;i++) covered+=Math.max(0,Math.min(b,spans[i][1])-Math.max(a,spans[i][0]));
    return covered>=b-a?'on':covered>0?'partial':'off';
  }
  const ranks=new Map(), monthly=new Map();
  for(const [id,value] of totals){const entity=entities.get(id);if(!entity)continue;const category=entity.category;if(!ranks.has(category))ranks.set(category,[]);ranks.get(category).push({id,name:entity.name,value,deleted:!!entity.deleted});}
  for(const rows of ranks.values()) rows.sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name));
  for(const row of entityDays){if(!monthly.has(row.category))monthly.set(row.category,{months:new Set(),values:new Map()});const group=monthly.get(row.category),month=row.date.slice(0,7),key=row.id+'|'+month;group.months.add(month);group.values.set(key,(group.values.get(key)||0)+row.seconds);}
  const weekdays=Array(7).fill(0),hourTotals=Array(24).fill(0),eventKinds=new Map(),eventCategories=new Map(),eventDays=new Map();
  for(const row of hours){hourTotals[row.hour]+=row.seconds;weekdays[(new Date(row.date+'T12:00:00').getDay()+6)%7]+=row.seconds;}
  for(const event of events){eventKinds.set(event.kind,(eventKinds.get(event.kind)||0)+event.count);eventCategories.set(event.category,(eventCategories.get(event.category)||0)+event.count);const day=eventDays.get(event.day)||{date:event.day,seconds:0,categories:{}};day.seconds+=event.count;day.categories[event.category]=(day.categories[event.category]||0)+event.count;eventDays.set(event.day,day);}
  function rankings(category) {
    return ranks.get(category)||[];
  }
  const noteTimes=noteUsageDays?noteUsageDays.reduce((sum,row)=>({archived:sum.archived+row.archived,unarchived:sum.unarchived+row.unarchived,total:sum.total+row.total}),{archived:0,unarchived:0,total:0}):null;
  const archivedNotes={count:history.archivedNotes?.count||0,seconds:noteTimes?noteTimes.archived:totals.get('archive:notes')||0};
  const noteUsage={available:noteTimes!==null,archived:archivedNotes,
    unarchived:{count:prepared.noteCount,seconds:noteTimes?noteTimes.unarchived:null},
    all:{count:archivedNotes.count+prepared.noteCount,seconds:noteTimes?noteTimes.total:null}};
  prepared.selection={ start, end, days, seconds, activeDays: active.length, longest, entityDays, events, hours, totals, entities, rankings, archivedNotes,noteUsage,noteUsageDays,monthly,weekdays,hourTotals,eventKinds,eventCategories,eventDays:[...eventDays.values()].sort((a,b)=>a.date.localeCompare(b.date)),
           hasHistory: !!history.days.length, since: history.since, coverage: history.coverage, collection };
  return prepared.selection;
}
// Axis labels use one unit and enough precision for distinct, readable ticks.
export function chartScale(maximum,{time=false,count=false}={}) {
  const divisor=time?(maximum>=3600?3600:maximum>=60?60:1):1;
  const unit=time?(divisor===3600?tr('小时','h'):divisor===60?tr('分钟','min'):tr('秒','s')):'';
  const value=Math.max(0,Number(maximum)||0)/divisor, raw=(value||1)/4;
  const power=10**Math.floor(Math.log10(raw)), ratio=raw/power;
  let step=(ratio<=1?1:ratio<=2?2:ratio<=5?5:10)*power;
  if(count) step=Math.max(1,step);
  const ceiling=Math.ceil((value||1)/step)*step, ticks=[];
  for(let i=0;i<=Math.round(ceiling/step);i++) ticks.push(i*step);
  const precision=Math.max(0,Math.min(12,-Math.floor(Math.log10(step))));
  const format=new Intl.NumberFormat(en()?'en-US':'zh-CN',{maximumFractionDigits:precision});
  return {divisor,unit,max:ceiling,ticks,format:value=>format.format(value)};
}
export async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

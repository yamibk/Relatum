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
export function select(report, filter) {
  const history = report.history;
  const cutoff = dateKey(new Date(history.cutoff));
  let start = dateKey(new Date(history.since)), end = cutoff;
  if (filter.mode === '30' || filter.mode === '90') { const d = new Date(end + 'T12:00:00'); d.setDate(d.getDate() - Number(filter.mode) + 1); start = dateKey(d); }
  else if (filter.mode === 'year') {
    const year=/^\d{4}$/.test(String(filter.year))&&Number(filter.year)<=Number(cutoff.slice(0,4))?String(filter.year):cutoff.slice(0,4);
    start=year+'-01-01';end=year===cutoff.slice(0,4)?cutoff:year+'-12-31';
  }
  else if (filter.mode === 'custom') { start = filter.start || start; end = filter.end || end; }
  const inRange = row => (row.date || row.day) >= start && (row.date || row.day) <= end;
  const days = history.days.filter(inRange), active = days.filter(d => d.seconds > 0).map(d => d.date);
  let longest = 0, streak = 0, previous = null;
  for (const day of active) { streak = previous && Math.round((dateValue(day)-dateValue(previous))/86400000) === 1 ? streak + 1 : 1; longest = Math.max(longest, streak); previous = day; }
  const seconds = days.reduce((s,d) => s+d.seconds,0);
  const entityDays = history.entityDays.filter(inRange), events = history.events.filter(inRange), hours = history.hours.filter(inRange);
  const totals = new Map();
  for (const row of entityDays) totals.set(row.id, (totals.get(row.id)||0)+row.seconds);
  const entities = new Map(history.entities.map(e => [e.id,e]));
  const coverageCache=new Map();
  function collection(date,category=null){
    const cacheKey=date+'|'+(category||'all');if(coverageCache.has(cacheKey))return coverageCache.get(cacheKey);
    const a=new Date(date+'T00:00:00').getTime(),next=new Date(a);next.setDate(next.getDate()+1);const b=next.getTime();
    const spans=[];
    for(const c of category?[category]:Object.keys(categories)){
      const periods=history.coverage.filter(p=>p.category===c).sort((x,y)=>x.at-y.at);
      periods.forEach((p,i)=>{if(p.enabled){const x=Math.max(a,p.at,history.since),y=Math.min(b,periods[i+1]?.at??history.cutoff,history.cutoff);if(y>x)spans.push([x,y]);}});
    }
    spans.sort((x,y)=>x[0]-y[0]);let covered=0,lastA=0,lastB=0;
    for(const [x,y] of spans){if(x>lastB){covered+=lastB-lastA;lastA=x;lastB=y;}else lastB=Math.max(lastB,y);}covered+=lastB-lastA;
    const value=covered>=b-a?'on':covered>0?'partial':'off';coverageCache.set(cacheKey,value);return value;
  }
  function rankings(category) {
    return [...totals].filter(([id]) => entities.get(id)?.category === category).map(([id,value]) => ({ id, name: entities.get(id).name, value, deleted: !!entities.get(id).deleted })).sort((a,b) => b.value-a.value || a.name.localeCompare(b.name));
  }
  return { start, end, days, seconds, activeDays: active.length, longest, entityDays, events, hours, totals, entities, rankings,
           hasHistory: !!history.days.length, since: history.since, coverage: history.coverage, collection };
}
export async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

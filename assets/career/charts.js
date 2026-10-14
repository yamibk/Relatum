import { el, tr, number, duration, exactDuration, label, dateValue, calendarDays, chartScale } from './data.js';
import { chartPresentation } from './motion.js';
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) { const n = document.createElementNS(NS,tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v); if (text != null) n.textContent=text; return n; }
function table(host, headings, rows, values=row=>row) {
  const details = el('details','career-details'), summary = el('summary','',tr('查看精确明细','View exact values'));
  const grid = el('table'), head = el('thead'), body = el('tbody'), hr = el('tr');
  headings.forEach(h => hr.append(el('th','',h))); head.append(hr);
  // Large inventories use a bounded initial page; all rows remain reachable.
  let offset = 0;
  const more = el('button','career-more',tr('加载更多','Load more')); more.type='button';
  const append = () => { rows.slice(offset,offset+50).forEach(row => { const line=el('tr'); values(row).forEach(c => line.append(el('td','',String(c)))); body.append(line); }); offset=Math.min(rows.length,offset+50);details.dataset.loadedRows=String(offset); more.hidden=offset>=rows.length; };
  more.addEventListener('click',append); details.addEventListener('toggle',() => { if (details.open && !offset) append(); });
  grid.append(head,body); const wrap=el('div','career-table-wrap'); wrap.append(grid); details.append(summary,wrap,more); host.append(details);
  const saved=host._careerDetailsState?.get(host.dataset.chartKey);
  if(saved?.open){details.open=true;do{append();}while(offset<Math.min(rows.length,saved.loaded||50));wrap.scrollTop=saved.scrollTop||0;}
  if(saved?.focused)summary.focus({preventScroll:true});
}
function rememberDetails(host,context) {
  const details=host.querySelector('.career-details');if(!details)return;
  context.detailsState ||= new Map();
  context.detailsState.set(host.dataset.chartKey,{open:details.open,loaded:Number(details.dataset.loadedRows)||0,scrollTop:details.querySelector('.career-table-wrap').scrollTop,focused:details.contains(document.activeElement)});
}
let tipIdentity=0;
export function createChartTooltip(schedule) {
  const tip=el('div','career-chart-tip');tip.id='career-chart-tip-'+(++tipIdentity);tip.hidden=true;tip.setAttribute('role','tooltip');document.body.append(tip);
  const key={};let latest=null,owner=null,anchor=null,size=null,lastText='',lastX=null,lastY=null;
  function describe(next) {
    if(anchor===next)return;
    if(anchor){const ids=(anchor.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tip.id);if(ids.length)anchor.setAttribute('aria-describedby',ids.join(' '));else anchor.removeAttribute('aria-describedby');}
    anchor=next;
    if(anchor)anchor.setAttribute('aria-describedby',[...(anchor.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean),tip.id].join(' '));
  }
  function hide() { latest=null;owner=null;describe(null);schedule.remove(key);if(!tip.hidden)tip.hidden=true; }
  return {
    forHost(host) { return {
      show(text,x,y,target=null) {
        latest={host,text,x,y,target};
        schedule.add(key,()=>{
          if(!latest||!host.isConnected)return;
          if(owner!==host){owner=host;const style=getComputedStyle(host);for(const name of ['--career-ink','--career-paper','--career-line'])tip.style.setProperty(name,style.getPropertyValue(name));size=null;}
          describe(latest.target);
          if(lastText!==latest.text){lastText=latest.text;tip.textContent=lastText;size=null;}
          if(tip.hidden)tip.hidden=false;
          if(!size){const rect=tip.getBoundingClientRect();size={width:rect.width,height:rect.height};}
          let left=latest.x+12,top=latest.y+12;
          if(left+size.width>innerWidth-8)left=latest.x-size.width-12;
          if(top+size.height>innerHeight-8)top=latest.y-size.height-12;
          left=Math.round(Math.max(8,Math.min(innerWidth-size.width-8,left)));top=Math.round(Math.max(8,Math.min(innerHeight-size.height-8,top)));
          if(left!==lastX){tip.style.left=left+'px';lastX=left;}if(top!==lastY){tip.style.top=top+'px';lastY=top;}
        });
      },
      hide(){if(owner===host||latest?.host===host)hide();},
      destroy(){if(owner===host||latest?.host===host)hide();}
    }; },
    hide,
    destroy(){hide();tip.remove();}
  };
}
function tooltip(host, context) {
  context.tooltip ||= createChartTooltip(context.scheduler);
  return context.tooltip.forHost(host);
}

export function mountChart(host, spec, context) {
  host.replaceChildren();
  host._careerDetailsState=context.detailsState;
  if(spec.unavailable){
    host.append(el('p','career-chart-empty',tr('此来源未能读取，规模未知。详情见数据范围。','This source could not be read. Inventory is unknown; see coverage.')));
    return {destroy(){host.replaceChildren();}};
  }
  if (spec.type === 'graph') return mountGraph(host,spec,context);
  const abort = new AbortController(), signal=abort.signal;
  const tip = tooltip(host,context);
  let observer=null, draw=null, bounds=null, points=[], surface=null, presentation=null, hitNode=null, hitGroup=null, highlight=null,paintAgain=null,cursor=null;
  const pointerKey={}; let pointer=null;
  function clearInteraction() {
    pointer=null;context.scheduler.remove(pointerKey);tip.hide();
    hitNode?.classList.remove('is-hit');if(hitGroup){hitGroup.classList.remove('is-hit');surface?.classList.remove('has-series-hit');}hitNode=hitGroup=null;if(highlight&&!highlight.hidden)highlight.hidden=true;
    if(cursor&&cursor.style.display!=='none')cursor.style.display='none';
  }
  function feedback(node,text,group=null) {node.classList.add('career-feedback');node._careerFeedback={text,group};if(typeof text==='string')node.setAttribute('aria-label',text);return node;}
  function stagger(node,index,count) {if(!context.presented?.has(spec.key))node.style.setProperty('--career-stagger',Math.round(index/Math.max(1,count-1)*160)+'ms');return node;}
  function bindMarks(node) {
    surface=node;presentation=chartPresentation(node);
    function show(target,event,focus=false) {
      const info=target?._careerFeedback;if(!info){clearInteraction();return;}
      if(hitNode!==target){hitNode?.classList.remove('is-hit');target.classList.add('is-hit');hitNode=target;}
      if(hitGroup!==info.group){hitGroup?.classList.remove('is-hit');hitGroup=info.group;hitGroup?.classList.add('is-hit');node.classList.toggle('has-series-hit',!!hitGroup);}
      const rect=focus?target.getBoundingClientRect():null;
      const text=typeof info.text==='function'?info.text(event):info.text;
      if(text)tip.show(text,focus?rect.left+rect.width/2:event.clientX,focus?rect.bottom:event.clientY,focus?target:null);
    }
    node.addEventListener('pointermove',event=>{const target=event.target.closest('.career-feedback');pointer={target,clientX:event.clientX,clientY:event.clientY};context.scheduler.add(pointerKey,()=>{const p=pointer;pointer=null;if(p)show(p.target,p);});},{signal});
    node.addEventListener('focusin',event=>{clearInteraction();show(event.target.closest('.career-feedback'),null,true);},{signal});
    node.addEventListener('focusout',clearInteraction,{signal});node.addEventListener('pointerleave',clearInteraction,{signal});
  }
  const color = () => getComputedStyle(host).getPropertyValue('--career-ink').trim() || '#1d1d1f';
  function bindSurface(node, hit) {
    surface=node;presentation=chartPresentation(node.parentElement);
    let focusedIndex=0;
    node.tabIndex=0;node.classList.add('career-feedback');
    node.setAttribute('aria-label',(spec.title||'')+tr('。方向键查看日期，Home / End 查看首尾日期。','; arrow keys inspect dates, Home / End inspect the first or last date.'));
    function show(row,x,y,anchor=null){
      if(!row){clearInteraction();return;}
      tip.show(row.text,x,y,anchor);
      if(highlight){const p=row.point,next=[p.x,p.y,p.width,p.height].join(',');if(highlight.dataset.geometry!==next){highlight.style.left=p.x+'px';highlight.style.top=p.y+'px';highlight.style.width=p.width+'px';highlight.style.height=p.height+'px';highlight.dataset.geometry=next;}if(highlight.hidden)highlight.hidden=false;}
    }
    function focusDate(){
      const p=points[focusedIndex];if(!p||!bounds)return;
      const x=p.x+p.width/2,y=p.y+p.height/2,rect=node.getBoundingClientRect();
      show(hit(x/bounds.width,y/bounds.height),rect.left+x,rect.top+y,node);
    }
    node.addEventListener('pointermove',event => {
      if(!bounds)return;
      pointer={x:event.offsetX/bounds.width,y:event.offsetY/bounds.height,clientX:event.clientX,clientY:event.clientY};
      context.scheduler.add(pointerKey,()=>{const latest=pointer;pointer=null;if(latest)show(hit(latest.x,latest.y),latest.clientX,latest.clientY);});
    },{signal});
    node.addEventListener('focus',()=>{clearInteraction();focusedIndex=Math.max(0,points.findIndex(p=>p.value||p.seconds));focusDate();},{signal});
    node.addEventListener('keydown',event=>{const column=spec.type==='heatmap'?7:1,step={ArrowLeft:-column,ArrowRight:column,ArrowUp:-1,ArrowDown:1}[event.key];if(step===undefined&&!['Home','End'].includes(event.key))return;event.preventDefault();focusedIndex=event.key==='Home'?0:event.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,focusedIndex+step));focusDate();},{signal});
    node.addEventListener('blur',clearInteraction,{signal});
    node.addEventListener('pointerleave',clearInteraction,{signal});
  }
  function frame(height=250) {
    const root=svg('svg',{viewBox:`0 0 720 ${height}`,role:'group','aria-label':spec.title||'',class:'career-native-chart'}); host.append(root);bindMarks(root);return root;
  }
  function dense(height=240) {
    const wrap=el('div','career-dense-surface'),canvas=el('canvas','career-native-chart'); canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',spec.title||''); canvas.style.height=height+'px';highlight=el('div','career-dense-highlight');highlight.hidden=true;wrap.append(canvas,highlight);host.append(wrap);
    let painted='';const resize = (force=false) => { const w=Math.max(1,Math.round(canvas.clientWidth)); const d=Math.min(2,devicePixelRatio||1),stamp=[w,height,d].join('|');if(force!==true&&stamp===painted)return;clearInteraction(); if (canvas.width!==Math.round(w*d) || canvas.height!==Math.round(height*d)) { canvas.width=Math.round(w*d); canvas.height=Math.round(height*d); } bounds={width:w,height};if(draw){draw(canvas.getContext('2d'),w,height,d);painted=stamp;} };
    observer=new ResizeObserver(resize); observer.observe(canvas);paintAgain=()=>resize(true); return { canvas, resize };
  }
  const rows=spec.rows||[];
  if (!rows.length && !['heatmap','matrix'].includes(spec.type)) {
    host.append(el('p','career-chart-empty',spec.empty||tr('尚未积累记录','No records yet')));
    return { destroy() { abort.abort(); tip.destroy();host.replaceChildren(); } };
  }
  if (spec.type === 'rank') {
    const list=el('div','career-ranks'), max=Math.max(1,...rows.map(r=>r.value));
    rows.slice(0,12).forEach((row,i) => {
      const line=el('div','career-rank'), name=el('span','career-rank-name',`${String(i+1).padStart(2,'0')}  ${row.name}`), track=el('span','career-rank-track'), bar=el('i');
      bar.style.width=(row.value/max*100)+'%'; track.append(bar);
      const text=(spec.unit==='seconds'?duration(row.value):number(row.value)) + (row.deleted?tr(' · 已删除',' · deleted'):'');
      line.tabIndex=0;feedback(line,`${row.name}: ${spec.unit==='seconds'?exactDuration(row.value):text}`);stagger(line,i,Math.min(12,rows.length));
      line.append(name,track,el('span','career-rank-value',text)); list.append(line);
    }); host.append(list);bindMarks(list);
    table(host,[tr('名称','Name'),spec.unit==='seconds'?tr('时长（时:分:秒）','Duration (h:m:s)'):spec.unit||tr('数量','Count')], rows,r=>[r.name,spec.unit==='seconds'?exactDuration(r.value):number(r.value)]);
  } else if (spec.type === 'treemap') {
    const root=frame(280), total=rows.reduce((s,r)=>s+r.value,0)||1; let x=0;
    rows.forEach((row,i) => { const width=row.value/total*684; const group=svg('g',{tabindex:0,role:'img','aria-label':`${row.name}: ${number(row.value)}`});
      const mark=feedback(svg('rect',{x:18+x,y:18,width:Math.max(0,width-2),height:208,rx:3,fill:'currentColor',opacity:.12+(i%5)*.12,class:'career-area-mark'}),`${row.name}: ${number(row.value)} ${spec.unit||''}`);group.classList.add('career-area-enter');stagger(group,i,rows.length);feedback(group,mark._careerFeedback.text);group.append(mark);
      const text=svg('text',{x:24+x,y:247,class:'career-axis-label'},row.name.length>14?row.name.slice(0,13)+'…':row.name);
      root.append(group);if(width>52)root.append(text);x+=width;
    }); table(host,[tr('笔记本','Notebook'),spec.unit],rows,r=>[r.name,number(r.value)]);
  } else if (spec.type === 'distribution') {
    const root=frame(),scale=chartScale(Math.max(0,...rows.map(r=>r.value))*(spec.duration?3600:1),{time:!!spec.duration,count:!spec.duration}),max=scale.max;
    const valueText=value=>spec.duration?exactDuration(value*3600):number(value);
    for(const tick of scale.ticks) { const y=205-tick/max*176; root.append(svg('line',{x1:48,y1:y,x2:704,y2:y,class:'career-axis-grid'}),svg('text',{x:38,y:y+4,'text-anchor':'end',class:'career-axis-label'},scale.format(tick))); }
    rows.forEach((row,i)=> { const width=650/rows.length,x=53+i*width,h=row.value*(spec.duration?3600:1)/scale.divisor/max*176; const mark=feedback(svg('rect',{x,y:205-h,width:Math.max(1,width-18),height:Math.max(1,h),rx:2,fill:'currentColor',opacity:.35+i/rows.length*.55,tabindex:0,class:'career-bar-mark'}),`${row.name}: ${valueText(row.value)} ${spec.duration?'':spec.unit||''}`),group=stagger(svg('g',{class:'career-bar-enter'}),i,rows.length);group.append(mark);root.append(group,svg('text',{x:x+(width-18)/2,y:229,'text-anchor':'middle',class:'career-axis-label'},row.name)); });
    root.append(svg('text',{x:48,y:15,class:'career-axis-label'},spec.duration?scale.unit:spec.unit||tr('数量','Count')));
    table(host,[tr('分类','Category'),spec.duration?tr('时长（时:分:秒）','Duration (h:m:s)'):spec.unit||tr('数量','Count')],rows,r=>[r.name,valueText(r.value)]);
  } else if (spec.type === 'trend') {
    // Real date coordinates, split paths at calendar gaps. Never interpolate
    // uncollected days into a fabricated continuous trend.
    const root=frame(280), keys=spec.keys||['seconds'], visible=new Set(keys), hidden=context.legendState.get(spec.key)||new Set();
    for(const key of hidden) visible.delete(key);
    const legend=el('div','career-legend');
    const first=dateValue(context.data.start), last=dateValue(context.data.end), span=Math.max(86400000,last-first);
    const counts=spec.unit==='count';
    const value=(row,key)=>key==='seconds'?row.seconds:(row.workspaces?.[key]??row.categories?.[key]??0);
    const scale=chartScale(Math.max(0,...rows.map(row=>Math.max(...keys.map(key=>value(row,key))))),{time:!counts,count:counts}),max=scale.max,divisor=scale.divisor;
    const patterns=['','7 3','2 3','9 3 2 3','5 3 2 3','12 4','3 3','8 3 3 3','1 3'];
    const series=new Map(),dates=rows.map(row=>dateValue(row.date));
    function paint() {
      for(const tick of scale.ticks) { const y=222-tick/max*192; root.append(svg('line',{x1:52,y1:y,x2:704,y2:y,class:'career-axis-grid'}),svg('text',{x:40,y:y+4,'text-anchor':'end',class:'career-axis-label'},scale.format(tick))); }
      root.append(svg('text',{x:52,y:16,class:'career-axis-label'},counts?tr('操作数量 / 日','operations / day'):`${scale.unit} / ${tr('日','day')}`));
      keys.forEach((key,index)=> { let d='',previous=null;
        const group=svg('g',{class:'career-series',opacity:Math.max(.45,1-index*.07)}),samples=[];
        const allowed=rows.map(row=>!!value(row,key)||context.data.collection(row.date,key)!=='off');
        group.hidden=!visible.has(key);group.style.display=visible.has(key)?'':'none';series.set(key,group);stagger(group,index,keys.length);
        rows.forEach((row,i)=> { if(!allowed[i]){previous=null;return;}
          const x=52+(dates[i]-first)/span*652,y=222-(value(row,key)/divisor)/max*192;
          const consecutive=previous!=null&&Math.round((dates[i]-previous)/86400000)===1;
          d+=(consecutive?' L':' M')+x.toFixed(2)+' '+y.toFixed(2);previous=dates[i];
          const text=`${row.date} · ${key==='seconds'?tr('合计','Total'):label(key)}: ${counts?number(value(row,key)):exactDuration(value(row,key))}`;
          samples.push({x,y,text});
          const isolated=!(allowed[i-1]&&Math.round((dates[i]-dates[i-1])/86400000)===1)&&!(allowed[i+1]&&Math.round((dates[i+1]-dates[i])/86400000)===1);
          if(rows.length<=90||isolated){const dot=feedback(svg('circle',{cx:x,cy:y,r:rows.length>90?1.8:2.6,fill:'currentColor',class:'career-trend-point',tabindex:rows.length<=90?0:-1}),text,group);if(rows.length<=90)stagger(dot,i,rows.length);group.append(dot);}
        });
        const path=svg('path',{d,fill:'none',stroke:'currentColor','stroke-width':1.5,'stroke-dasharray':patterns[index%patterns.length],class:'career-series-line'}),hit=svg('path',{d,fill:'none',stroke:'transparent','stroke-width':12,'vector-effect':'non-scaling-stroke',class:'career-series-hit'});
        feedback(hit,event=>{if(!samples.length)return null;const rect=root.getBoundingClientRect(),x=(event.clientX-rect.left)*720/rect.width;let lo=0,hi=samples.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].x<x)lo=mid+1;else hi=mid;}const sample=lo&&Math.abs(samples[lo-1].x-x)<Math.abs(samples[lo].x-x)?samples[lo-1]:samples[lo];if(cursor){if(cursor.getAttribute('cx')!==String(sample.x))cursor.setAttribute('cx',sample.x);if(cursor.getAttribute('cy')!==String(sample.y))cursor.setAttribute('cy',sample.y);if(cursor.style.display)cursor.style.display='';}return sample.text;},group);
        // Wide transparent stroke receives line hits; visible dots remain above it.
        group.prepend(path,hit);root.append(group);
      });
      [context.data.start,context.data.end].forEach((date,i)=>root.append(svg('text',{x:i?704:52,y:253,'text-anchor':i?'end':'start',class:'career-axis-label'},date)));
      cursor=svg('circle',{r:3,fill:'currentColor',class:'career-trend-cursor',style:'display:none'});root.append(cursor);
    }
    keys.forEach((key,index)=> { const button=el('button','',key==='seconds'?tr('合计','Total'):label(key)),mark=svg('svg',{viewBox:'0 0 24 12',class:'career-legend-mark','aria-hidden':'true'});mark.append(svg('line',{x1:1,x2:23,y1:6,y2:6,stroke:'currentColor','stroke-width':1.5,'stroke-dasharray':patterns[index%patterns.length],opacity:Math.max(.45,1-index*.07)}));button.prepend(mark);button.type='button'; button.setAttribute('aria-pressed',String(visible.has(key))); button.addEventListener('click',()=> { clearInteraction();if(visible.has(key)){visible.delete(key);hidden.add(key);}else{visible.add(key);hidden.delete(key);} context.legendState.set(spec.key,hidden);button.setAttribute('aria-pressed',String(visible.has(key)));const group=series.get(key);group.hidden=!visible.has(key);group.style.display=visible.has(key)?'':'none'; },{signal}); legend.append(button); }); host.prepend(legend);paint();
    table(host,[tr('日期','Date'),...keys.map(k=>label(k))],rows,r=>[r.date,...keys.map(k=>!value(r,k)&&context.data.collection(r.date,k)==='off'?tr('未采集','Not collected'):counts?number(value(r,k)):exactDuration(value(r,k)))]);
  } else if (spec.type === 'barcode') {
    const all=calendarDays(context.data.start,context.data.end), byDay=new Map(rows.map(r=>[r.date,r]));
    const scale=chartScale(Math.max(0,...rows.map(r=>r.seconds)),{time:true}),max=scale.max*scale.divisor; const {canvas,resize}=dense(240);
    draw=(ctx,w,h,d)=> { ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle=color();ctx.strokeStyle=color();ctx.font='10px sans-serif';
      points=[];const width=(w-64)/Math.max(1,all.length);
      ctx.globalAlpha=.65;ctx.fillText(scale.unit,36,12);
      for(const tick of scale.ticks){const y=194-tick/scale.max*172;ctx.globalAlpha=.07;ctx.beginPath();ctx.moveTo(36,y);ctx.lineTo(w-8,y);ctx.stroke();ctx.globalAlpha=.65;ctx.fillText(scale.format(tick),2,y-5);}
      all.forEach((day,i)=> { const seconds=byDay.get(day)?.seconds||0,x=36+(i+.5)*width,bh=seconds/max*172; ctx.globalAlpha=seconds?.85:.07;ctx.fillRect(x,194-bh,Math.max(.6,Math.min(2,width*.58)),Math.max(1,bh));points.push({day,seconds,x,y:194-bh,width:Math.max(2,Math.min(2,width*.58)),height:Math.max(1,bh)}); });
      ctx.globalAlpha=.5;ctx.fillText(context.data.start,36,222);ctx.textAlign='right';ctx.fillText(context.data.end,w-8,222);ctx.textAlign='left';ctx.globalAlpha=1;
    };resize();
    const emptyTime=day=>context.data.collection(day)==='on'?tr('采集开启，记录为零','Collection on, recorded zero'):context.data.collection(day)==='partial'?tr('部分时段采集，尚无时长','Partial collection, no duration yet'):tr('未采集','Not collected');
    bindSurface(canvas,(x,y)=> {if(x*bounds.width<36||x*bounds.width>bounds.width-28||y*240>195)return null;const i=Math.max(0,Math.min(all.length-1,Math.floor((x*bounds.width-36)/((bounds.width-64)/all.length)))); const p=points[i];return p&&{text:`${p.day} · ${p.seconds?exactDuration(p.seconds):emptyTime(p.day)}`,point:p}; });
    table(host,[tr('日期','Date'),tr('前台时间（时:分:秒）','Foreground time (h:m:s)')],rows,r=>[r.date,exactDuration(r.seconds)]);
  } else if (spec.type === 'heatmap') {
    const years=[...new Set([context.data.start.slice(0,4),context.data.end.slice(0,4),...rows.map(r=>r.date.slice(0,4))])].sort();
    let year=years.includes(context.heatmapYear)?context.heatmapYear:context.data.end.slice(0,4);
    const choose=el('select','career-year-select'); choose.setAttribute('aria-label',tr('热力图年份','Heatmap year')); years.forEach(y=>{const option=el('option','',y);option.value=y;choose.append(option);});choose.value=year;host.append(choose);
    const byDay=new Map(rows.map(r=>[r.date,r.seconds])); const {canvas,resize}=dense(156);let offset=0,cell=0;
    draw=(ctx,w,h,d)=> { ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);const dates=calendarDays(year+'-01-01',year+'-12-31');offset=(new Date(year+'-01-01T12:00:00').getDay()+6)%7;cell=Math.min(13,(w-40)/54);const max=Math.max(1,...dates.map(d=>byDay.get(d)||0));points=[];ctx.fillStyle=color();ctx.font='9px sans-serif';
      dates.forEach((date,i)=> { const col=Math.floor((i+offset)/7),row=(i+offset)%7,x=28+col*cell,y=25+row*cell,value=byDay.get(date)||0,width=Math.max(1,cell-2);ctx.globalAlpha=value?.18+.82*Math.sqrt(value/max):.055;ctx.fillRect(x,y,width,width);points.push({date,value,x,y,cell,width,height:width});if(date.endsWith('-01')){ctx.globalAlpha=.55;ctx.fillText(date.slice(5,7),x,14);} });ctx.globalAlpha=.55;ctx.fillText(tr('一','M'),3,34);ctx.fillText(tr('日','S'),3,25+6*cell+9);ctx.globalAlpha=1;
    };choose.addEventListener('change',()=>{year=choose.value;context.heatmapYear=year;resize(true);},{signal});resize();
    bindSurface(canvas,(x,y)=> {const px=x*bounds.width,py=y*156,col=Math.floor((px-28)/cell),row=Math.floor((py-25)/cell),index=col*7+row-offset;const p=col>=0&&row>=0&&row<7&&index>=0?points[index]:null;if(!p||px<p.x||px>=p.x+p.width||py<p.y||py>=p.y+p.height)return null;const state=context.data.collection(p.date);return {text:`${p.date} · ${p.value?exactDuration(p.value):state==='on'?tr('采集开启，记录为零','Collection on, recorded zero'):state==='partial'?tr('部分时段采集，尚无时长','Partial collection, no duration yet'):tr('未采集','Not collected')}`,point:p}; });
    table(host,[tr('日期','Date'),tr('时长（时:分:秒）','Duration (h:m:s)')],rows,r=>[r.date,exactDuration(r.seconds)]);
  } else if (spec.type === 'matrix') {
    let monthly=context.data.monthly?.get(spec.category);
    if(!context.data.monthly){monthly={months:new Set(),values:new Map()};for(const row of context.data.entityDays){if(row.category!==spec.category)continue;const month=row.date.slice(0,7),key=row.id+'|'+month;monthly.months.add(month);monthly.values.set(key,(monthly.values.get(key)||0)+row.seconds);}}
    const months=monthly?[...monthly.months].sort():[];
    const entities=context.data.rankings(spec.category).slice(0,18), values=monthly?.values||new Map();
    if(!months.length)host.append(el('p','career-chart-empty',tr('尚未积累月份记录','No monthly history yet')));
    else { const root=frame(Math.max(130,entities.length*24+45)), max=Math.max(1,...values.values());
      entities.forEach((r,i)=>{root.append(svg('text',{x:160,y:30+i*24,'text-anchor':'end',class:'career-axis-label'},r.name.slice(0,22)));months.forEach((month,j)=>{const value=values.get(r.id+'|'+month)||0,circle=feedback(svg('circle',{cx:184+j*500/Math.max(1,months.length-1),cy:26+i*24,r:value?2+6*Math.sqrt(value/max):1,fill:'currentColor',opacity:value?.85:.08,tabindex:0,class:'career-matrix-point'}),`${r.name} · ${month}: ${exactDuration(value)}`);stagger(circle,i*months.length+j,entities.length*months.length);root.append(circle);});});months.forEach((m,j)=>root.append(svg('text',{x:184+j*500/Math.max(1,months.length-1),y:entities.length*24+30,'text-anchor':'middle',class:'career-axis-label'},m))); }
    table(host,[tr('项目','Project'),tr('月份','Month'),tr('时长（时:分:秒）','Duration (h:m:s)')],[...values],([k,v])=>{const [id,month]=k.split('|');return[context.data.entities.get(id)?.name||id,month,exactDuration(v)];});
  }
  host.addEventListener('pointerdown',clearInteraction,{signal});host.addEventListener('pointercancel',clearInteraction,{signal});
  return { target:presentation?.target||host,enter(first){presentation?.enter(first);},leave(){clearInteraction();presentation?.leave();},clearInteraction,
    pause(){clearInteraction();presentation?.pause();},resume(){clearInteraction();},refreshTheme(){clearInteraction();paintAgain?.();},
    destroy() { rememberDetails(host,context);clearInteraction();abort.abort();observer?.disconnect();presentation?.destroy();tip.destroy(); if(surface?.tagName==='CANVAS'){surface.width=1;surface.height=1;}host.replaceChildren(); } };
}

let graphReady;
async function loadGraph() {
  if (window.GraphEngine) return;
  if (!graphReady) graphReady=(async()=>{
    for(const [name,exported] of [['graph-gl.js','GraphGL'],['graph-engine.js','GraphEngine']]){
      if(window[exported])continue;
      await new Promise((resolve,reject)=>{const s=el('script');s.src=name;const fail=()=>{s.remove();reject(new Error(name+' failed to initialize'));};s.onload=()=>window[exported]?resolve():fail();s.onerror=fail;document.head.append(s);});
    }
  })().catch(error=>{graphReady=null;throw error;});
  return graphReady;
}
function mountGraph(host,spec,context) {
  if (!spec.network.nodes.length) {
    host.replaceChildren(el('p','career-chart-empty',tr('此来源没有可展示的节点','No nodes to display for this source')));
    return { destroy() { host.replaceChildren(); } };
  }
  let alive=true, engine=null, canvas=el('canvas'), view=context.graphViews.get(spec.key),paused=false,booting=false,refreshPalette=null;
  const stage=el('div','career-graph-stage');stage.dataset.careerGraph='1';stage.tabIndex=0;stage.setAttribute('aria-label',tr('关系图谱。拖动节点；Ctrl 加滚轮缩放；方向键移动；加减键缩放。','Relationship graph. Drag nodes; Ctrl and wheel to zoom; arrows to pan; plus and minus to zoom.'));
  const hint=el('p','career-graph-hint',tr('拖拽探索关系 · Ctrl / ⌘ + 滚轮缩放','Drag to explore · Ctrl / ⌘ + wheel to zoom'));
  const tip=tooltip(host,context), controls=el('div','career-graph-controls'), reset=el('button','',tr('复位','Reset'));reset.type='button';controls.append(reset);stage.append(canvas);host.append(stage,controls,hint);
  const presentation=chartPresentation(stage),halo=el('div','career-graph-halo');halo.hidden=true;stage.append(halo);let showing=false,started=false,pointerId=null;
  const abort=new AbortController(),signal=abort.signal;
  const network=spec.network, nodes=network.nodes.map((n,i)=>({ ...n, x:view?.positions.get(n.id)?.x??Math.cos(i*2.39996)*Math.sqrt(i+1)*25, y:view?.positions.get(n.id)?.y??Math.sin(i*2.39996)*Math.sqrt(i+1)*25, r:4+Math.min(7,Math.sqrt(n.degree||1)) }));
  const byId=new Map(nodes.map((node,i)=>[node.id,i]));
  const edges=network.edges.map(edge=>({source:byId.get(edge.from),target:byId.get(edge.to),rest:112})).filter(e=>e.source!==undefined&&e.target!==undefined);
  host.append(el('p','career-graph-count',tr(`展示 ${nodes.length} / ${network.totalNodes??nodes.length} 个节点，${network.edges.length} / ${network.totalEdges??network.edges.length} 条真实关系`,`Showing ${nodes.length} / ${network.totalNodes??nodes.length} nodes, ${network.edges.length} / ${network.totalEdges??network.edges.length} real relationships`)));
  let ro;
  function initialize(){
    if(!alive||paused||engine||booting)return;booting=true;
    loadGraph().then(()=> {
    booting=false;if(!alive||paused)return;
    let fill,focus,nodeStyles,edgeStyles;
    refreshPalette=()=>{
      const dark=document.body.dataset.startTheme==='dark';fill=dark?'#b9b9b9':'#5f5f5f';focus=dark?'#f5f5f5':'#202020';
      const gray=dark?185/255:95/255,highlighted=dark?245/255:32/255;
      nodeStyles=[0,1,2,3].map(state=>{const color=state&2?highlighted:gray;return {fill:[color,color,color,state&1?.18:1]};});
      edgeStyles=[0,1,2,3].map(state=>{const color=state&2?highlighted:gray,alpha=state&2?(state&1?.08:.8):(state&1?.04:.25);return {color:[color,color,color,alpha],width:state&2?1.5:1};});
      engine?.requestRender();
    };refreshPalette();
    engine=window.GraphEngine.create({ canvas,backend:'webgl',cacheInstances:true,coalesceHover:true,ignoreHiddenNodes:true,reduceMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      labelVisibility:'always',domOverlayOnCanvas2D:true,
      domOverlay:{sync(frame){const node=frame.nodes[frame.focusIndex];if(!showing||!node){if(!halo.hidden)halo.hidden=true;return;}const x=frame.offsetX+(node._rx-frame.viewX)*frame.unit,y=frame.offsetY+(node._ry-frame.viewY)*frame.unit,r=node.r*frame.unit+5,stamp=[x,y,r].join('|');if(halo.dataset.geometry!==stamp){halo.style.left=(x-r)+'px';halo.style.top=(y-r)+'px';halo.style.width=halo.style.height=(r*2)+'px';halo.dataset.geometry=stamp;}if(halo.hidden)halo.hidden=false;},destroy(){halo.remove();}},
      shouldHandleWheel:event=>event.ctrlKey||event.metaKey,
      config:{viewW:900,viewH:420,zoomMin:.12,zoomMax:4,presolveMaxNodes:0,alphaDecay:.04,finalFitOnConverge:false,fitMargin:28},
      onCanvasReplace:replacement=>{canvas=replacement;}, nodeStyle:(n,e)=>nodeStyles[(e.focus?2:0)+(e.dim?1:0)],edgeStyle:(edge,a,b,e)=>edgeStyles[(e.highlighted?2:0)+(e.dim?1:0)],
      drawNode(ctx,node,e){ctx.globalAlpha*=e.dim?.18:1;ctx.fillStyle=e.focus?focus:fill;ctx.beginPath();ctx.arc(0,0,node.r,0,Math.PI*2);ctx.fill();},
      drawEdge(ctx,edge,a,b,e){ctx.globalAlpha*=e.highlighted?.8:e.dim?.04:.25;ctx.strokeStyle=e.highlighted?focus:fill;ctx.lineWidth=e.highlighted?1.5:1;ctx.beginPath();ctx.moveTo(a._rx,a._ry);ctx.lineTo(b._rx,b._ry);ctx.stroke();},
      onNodeHover(node,event){if(showing&&node)tip.show(`${node.title} · ${number(node.words??node.degree??0)} ${node.words!=null?tr('字词','words'):tr('关系','relations')}`,event.clientX,event.clientY);else tip.hide();},
      onEdgeHover(edge,event){if(showing&&edge)tip.show(`${nodes[edge.source].title} ${spec.key==='reuse-network'?'→':'↔'} ${nodes[edge.target].title}`,event.clientX,event.clientY);else tip.hide();}
    });engine.setDrift(false);engine.setParticles(false);engine.setData(nodes,edges);
    const start=()=>{if(!alive||paused||stage.clientWidth<=0||stage.clientHeight<=0)return;ro?.disconnect();ro=null;started=true;engine.setActive(true);engine.setVisible(true);if(view){engine.restoreView(view.camera);if(!view.settled)engine.heat(Number.isFinite(view.layoutAlpha)?view.layoutAlpha:.18);}else engine.start({intro:showing,introSpanMs:160});};
    ro=new ResizeObserver(start);ro.observe(stage);start();
    reset.addEventListener('click',()=>engine?.fitView(true),{signal});
    stage.addEventListener('keydown',event=>{if(!engine)return;const camera=engine.view;if(!camera)return;const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'];if(!keys.includes(event.key))return;clearInteraction();event.preventDefault();if(event.key==='0'){engine.fitView(true);return;}engine.restoreView({...camera,x:camera.x+(event.key==='ArrowLeft'?30:event.key==='ArrowRight'?-30:0),y:camera.y+(event.key==='ArrowUp'?30:event.key==='ArrowDown'?-30:0),scale:camera.scale*(event.key==='+'||event.key==='='?1.15:event.key==='-'?1/1.15:1)});},{signal});
  }).catch(()=> {booting=false;if(alive&&!paused)stage.replaceChildren(el('p','career-chart-empty',tr('图谱加载失败，重新进入可重试','Graph failed to load; re-enter to retry')));});
  }initialize();
  table(host,[tr('节点','Node'),tr('关系数','Relations')],nodes,n=>[n.title,number(n.degree||0)]);
  function clearInteraction(){tip.hide();if(!halo.hidden)halo.hidden=true;engine?.clearHover();}
  stage.addEventListener('pointerdown',event=>{pointerId=event.pointerId;clearInteraction();},{signal});stage.addEventListener('pointerup',()=>{pointerId=null;},{signal});stage.addEventListener('pointercancel',()=>{pointerId=null;clearInteraction();},{signal});stage.addEventListener('wheel',clearInteraction,{signal,passive:true});
  return {target:stage,enter(first){showing=true;presentation.enter(first);},leave(){showing=false;clearInteraction();presentation.leave();},clearInteraction,
    pause(){paused=true;clearInteraction();presentation.pause();engine?.setActive(false);if(pointerId!==null){const id=pointerId;pointerId=null;canvas.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:id}));}},
    resume(){paused=false;clearInteraction();if(engine)engine.setActive(true);else initialize();},
    refreshTheme(){clearInteraction();refreshPalette?.();},
    destroy() {rememberDetails(host,context);alive=false;showing=false;abort.abort();ro?.disconnect();presentation.destroy();tip.destroy();if(engine){if(started)context.graphViews.set(spec.key,{camera:engine.view,positions:new Map(nodes.map(n=>[n.id,{x:n.x,y:n.y}])),settled:!engine.layoutPending,layoutAlpha:engine.layoutAlpha});engine.destroy();engine=null;}canvas.width=1;canvas.height=1;host.replaceChildren();} };
}

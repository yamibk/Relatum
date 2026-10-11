import { el, tr, number, duration, exactDuration, label, dateValue, calendarDays } from './data.js';
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) { const n = document.createElementNS(NS,tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v); if (text != null) n.textContent=text; return n; }
function table(host, headings, rows, values=row=>row) {
  const details = el('details','career-details'), summary = el('summary','',tr('查看精确明细','View exact values'));
  const grid = el('table'), head = el('thead'), body = el('tbody'), hr = el('tr');
  headings.forEach(h => hr.append(el('th','',h))); head.append(hr);
  // Large inventories use a bounded initial page; all rows remain reachable.
  let offset = 0;
  const more = el('button','career-more',tr('加载更多','Load more')); more.type='button';
  const append = () => { rows.slice(offset,offset+50).forEach(row => { const line=el('tr'); values(row).forEach(c => line.append(el('td','',String(c)))); body.append(line); }); offset+=50; more.hidden=offset>=rows.length; };
  more.addEventListener('click',append); details.addEventListener('toggle',() => { if (details.open && !offset) append(); });
  grid.append(head,body); const wrap=el('div','career-table-wrap'); wrap.append(grid); details.append(summary,wrap,more); host.append(details);
}
function tooltip(host, schedule) {
  const tip = el('div','career-chart-tip'); tip.hidden=true; tip.setAttribute('role','status'); host.append(tip);
  const key = {}; let latest=null;
  return { show(text, x, y) { latest={text,x,y}; schedule.add(key,() => { if (!latest) return; tip.textContent=latest.text; tip.style.left=`${Math.max(8,Math.min(innerWidth-244,latest.x+12))}px`; tip.style.top=`${Math.max(8,Math.min(innerHeight-70,latest.y+12))}px`; tip.hidden=false; }); }, hide() { latest=null; schedule.remove(key); tip.hidden=true; }, destroy() { latest=null; schedule.remove(key); tip.remove(); } };
}

export function mountChart(host, spec, context) {
  host.replaceChildren();
  if(spec.unavailable){
    host.append(el('p','career-chart-empty',tr('此来源未能读取，规模未知。详情见数据范围。','This source could not be read. Inventory is unknown; see coverage.')));
    return {destroy(){host.replaceChildren();}};
  }
  if (spec.type === 'graph') return mountGraph(host,spec,context);
  const abort = new AbortController(), signal=abort.signal;
  const tip = tooltip(host,context.scheduler);
  let observer=null, draw=null, bounds=null, points=[], surface=null;
  const pointerKey={}; let pointer=null;
  const color = () => getComputedStyle(host).getPropertyValue('--career-ink').trim() || '#171816';
  function bindSurface(node, hit) {
    surface=node;
    node.addEventListener('pointermove',event => {
      if(!bounds)return;
      pointer={x:event.offsetX/bounds.width,y:event.offsetY/bounds.height,clientX:event.clientX,clientY:event.clientY};
      context.scheduler.add(pointerKey,()=>{const latest=pointer;pointer=null;if(!latest)return;const row=hit(latest.x,latest.y);if(row)tip.show(row,latest.clientX,latest.clientY);else tip.hide();});
    },{signal});
    node.addEventListener('pointerleave',() => { pointer=null;context.scheduler.remove(pointerKey);tip.hide(); },{signal});
  }
  function frame(height=250) {
    const root=svg('svg',{viewBox:`0 0 720 ${height}`,role:'img','aria-label':spec.title||'',class:'career-native-chart'}); host.append(root); return root;
  }
  function dense(height=240) {
    const canvas=el('canvas','career-native-chart'); canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',spec.title||''); canvas.style.height=height+'px'; host.append(canvas);
    const resize = () => { const w=Math.max(1,Math.round(canvas.clientWidth)); const d=Math.min(2,devicePixelRatio||1); if (canvas.width!==Math.round(w*d) || canvas.height!==Math.round(height*d)) { canvas.width=Math.round(w*d); canvas.height=Math.round(height*d); } bounds={width:w,height};draw?.(canvas.getContext('2d'),w,height,d); };
    observer=new ResizeObserver(resize); observer.observe(canvas); return { canvas, resize };
  }
  const rows=spec.rows||[];
  if (!rows.length && !['heatmap','matrix'].includes(spec.type)) {
    host.append(el('p','career-chart-empty',spec.empty||tr('尚未积累记录','No records yet')));
    return { destroy() { abort.abort(); tip.destroy(); } };
  }
  if (spec.type === 'rank') {
    const list=el('div','career-ranks'), max=Math.max(1,...rows.map(r=>r.value));
    rows.slice(0,12).forEach((row,i) => {
      const line=el('div','career-rank'), name=el('span','career-rank-name',`${String(i+1).padStart(2,'0')}  ${row.name}`), track=el('span','career-rank-track'), bar=el('i');
      bar.style.width=(row.value/max*100)+'%'; track.append(bar);
      const text=(spec.unit==='seconds'?duration(row.value):number(row.value)) + (row.deleted?tr(' · 已删除',' · deleted'):'');
      line.tabIndex=0; line.title=`${row.name}: ${spec.unit==='seconds'?exactDuration(row.value):text}`;
      line.append(name,track,el('span','career-rank-value',text)); list.append(line);
    }); host.append(list);
    table(host,[tr('名称','Name'),spec.unit==='seconds'?tr('时长（时:分:秒）','Duration (h:m:s)'):spec.unit||tr('数量','Count')], rows,r=>[r.name,spec.unit==='seconds'?exactDuration(r.value):number(r.value)]);
  } else if (spec.type === 'treemap') {
    const root=frame(280), total=rows.reduce((s,r)=>s+r.value,0)||1; let x=0;
    rows.forEach((row,i) => { const width=row.value/total*684; const group=svg('g',{tabindex:0,role:'img','aria-label':`${row.name}: ${number(row.value)}`});
      group.append(svg('rect',{x:18+x,y:18,width:Math.max(0,width-2),height:208,rx:3,fill:'currentColor',opacity:.12+(i%5)*.12}));
      const text=svg('text',{x:24+x,y:247,class:'career-axis-label'},row.name.length>14?row.name.slice(0,13)+'…':row.name); if(width>52) group.append(text);
      group.append(svg('title',{},`${row.name}: ${number(row.value)} ${spec.unit||''}`)); root.append(group); x+=width;
    }); table(host,[tr('笔记本','Notebook'),spec.unit],rows,r=>[r.name,number(r.value)]);
  } else if (spec.type === 'distribution') {
    const root=frame(), max=Math.max(1,...rows.map(r=>r.value));
    const valueText=value=>spec.duration?exactDuration(value*3600):number(value);
    for(let i=0;i<=4;i++) { const y=205-i*44; root.append(svg('line',{x1:48,y1:y,x2:704,y2:y,class:'career-axis-grid'}),svg('text',{x:38,y:y+4,'text-anchor':'end',class:'career-axis-label'},number(max*i/4))); }
    rows.forEach((row,i)=> { const width=650/rows.length,x=53+i*width,h=row.value/max*176; const mark=svg('rect',{x,y:205-h,width:Math.max(1,width-18),height:h,rx:2,fill:'currentColor',opacity:.25+i/rows.length*.6,tabindex:0}); mark.append(svg('title',{},`${row.name}: ${valueText(row.value)}`)); root.append(mark,svg('text',{x:x+(width-18)/2,y:229,'text-anchor':'middle',class:'career-axis-label'},row.name)); });
    root.append(svg('text',{x:48,y:15,class:'career-axis-label'},spec.unit||tr('数量','Count')));
    table(host,[tr('分类','Category'),spec.duration?tr('时长（时:分:秒）','Duration (h:m:s)'):spec.unit||tr('数量','Count')],rows,r=>[r.name,valueText(r.value)]);
  } else if (spec.type === 'trend') {
    // Real date coordinates, split paths at calendar gaps. Never interpolate
    // uncollected days into a fabricated continuous trend.
    const root=frame(280), keys=spec.keys||['seconds'], visible=new Set(keys), hidden=context.legendState.get(spec.key)||new Set();
    for(const key of hidden) visible.delete(key);
    const legend=el('div','career-legend');
    const first=dateValue(context.data.start), last=dateValue(context.data.end), span=Math.max(86400000,last-first);
    const counts=spec.unit==='count', divisor=counts?1:3600;
    const value=(row,key)=>key==='seconds'?row.seconds:(row.workspaces?.[key]??row.categories?.[key]??0);
    const max=Math.max(1,...rows.map(row=>Math.max(...keys.map(key=>value(row,key)))))/divisor;
    function paint() {
      root.replaceChildren();
      for(let i=0;i<=4;i++) { const y=222-i*48; root.append(svg('line',{x1:52,y1:y,x2:704,y2:y,class:'career-axis-grid'}),svg('text',{x:40,y:y+4,'text-anchor':'end',class:'career-axis-label'},number(max*i/4))); }
      root.append(svg('text',{x:52,y:16,class:'career-axis-label'},counts?tr('操作数量 / 日','operations / day'):tr('小时 / 日','hours / day')));
      keys.forEach((key,index)=> { if(!visible.has(key)) return; let d='', previous=null;
        rows.forEach(row=> { if(!value(row,key)&&context.data.collection(row.date,key)==='off'){previous=null;return;}
          const x=52+(dateValue(row.date)-first)/span*652,y=222-(value(row,key)/divisor)/max*192;
          const consecutive=previous&&Math.round((dateValue(row.date)-dateValue(previous))/86400000)===1;
          d+=(consecutive?' L':' M')+x.toFixed(2)+' '+y.toFixed(2); previous=row.date;
          const dot=svg('circle',{cx:x,cy:y,r:rows.length>300?1.2:2.6,fill:'currentColor',opacity:Math.max(.18,1-index*.1),tabindex:rows.length<=90?0:-1}); dot.append(svg('title',{},`${row.date} · ${key==='seconds'?tr('合计','Total'):label(key)}: ${counts?number(value(row,key)):exactDuration(value(row,key))}`)); root.append(dot);
        }); root.prepend(svg('path',{d,fill:'none',stroke:'currentColor','stroke-width':1.4,opacity:Math.max(.18,1-index*.1)}));
      });
      [context.data.start,context.data.end].forEach((date,i)=>root.append(svg('text',{x:i?704:52,y:253,'text-anchor':i?'end':'start',class:'career-axis-label'},date)));
    }
    keys.forEach(key=> { const button=el('button','',key==='seconds'?tr('合计','Total'):label(key)); button.type='button'; button.setAttribute('aria-pressed',String(visible.has(key))); button.addEventListener('click',()=> { if(visible.has(key)){visible.delete(key);hidden.add(key);}else{visible.add(key);hidden.delete(key);} context.legendState.set(spec.key,hidden);button.setAttribute('aria-pressed',String(visible.has(key))); paint(); },{signal}); legend.append(button); }); host.prepend(legend);paint();
    table(host,[tr('日期','Date'),...keys.map(k=>label(k))],rows,r=>[r.date,...keys.map(k=>!value(r,k)&&context.data.collection(r.date,k)==='off'?tr('未采集','Not collected'):counts?number(value(r,k)):exactDuration(value(r,k)))]);
  } else if (spec.type === 'barcode') {
    const all=calendarDays(context.data.start,context.data.end), byDay=new Map(rows.map(r=>[r.date,r]));
    const max=Math.max(1,...rows.map(r=>r.seconds)); const {canvas,resize}=dense(240);
    draw=(ctx,w,h,d)=> { ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle=color();ctx.strokeStyle=color();ctx.font='10px sans-serif';
      points=[];const width=(w-64)/Math.max(1,all.length);
      for(let i=0;i<=4;i++){const y=194-i*43;ctx.globalAlpha=.09;ctx.beginPath();ctx.moveTo(36,y);ctx.lineTo(w-8,y);ctx.stroke();ctx.globalAlpha=.55;ctx.fillText(duration(max*i/4),2,y-5);}
      all.forEach((day,i)=> { const seconds=byDay.get(day)?.seconds||0,x=36+(i+.5)*width,bh=seconds/max*172; ctx.globalAlpha=seconds?.85:.07;ctx.fillRect(x,194-bh,Math.max(.6,Math.min(2,width*.58)),Math.max(1,bh));points.push({day,seconds,x}); });
      ctx.globalAlpha=.5;ctx.fillText(context.data.start,36,222);ctx.textAlign='right';ctx.fillText(context.data.end,w-8,222);ctx.textAlign='left';ctx.globalAlpha=1;
    };resize();
    const emptyTime=day=>context.data.collection(day)==='on'?tr('采集开启，记录为零','Collection on, recorded zero'):context.data.collection(day)==='partial'?tr('部分时段采集，尚无时长','Partial collection, no duration yet'):tr('未采集','Not collected');
    bindSurface(canvas,(x)=> { const i=Math.max(0,Math.min(all.length-1,Math.floor((x*bounds.width-36)/((bounds.width-64)/all.length)))); const p=points[i];return p&&`${p.day} · ${p.seconds?exactDuration(p.seconds):emptyTime(p.day)}`; });
    table(host,[tr('日期','Date'),tr('前台时间（时:分:秒）','Foreground time (h:m:s)')],rows,r=>[r.date,exactDuration(r.seconds)]);
  } else if (spec.type === 'heatmap') {
    const years=[...new Set([context.data.start.slice(0,4),context.data.end.slice(0,4),...rows.map(r=>r.date.slice(0,4))])].sort();
    let year=years.includes(context.heatmapYear)?context.heatmapYear:context.data.end.slice(0,4);
    const choose=el('select','career-year-select'); choose.setAttribute('aria-label',tr('热力图年份','Heatmap year')); years.forEach(y=>{const option=el('option','',y);option.value=y;choose.append(option);});choose.value=year;host.append(choose);
    const byDay=new Map(rows.map(r=>[r.date,r.seconds])); const {canvas,resize}=dense(156);
    draw=(ctx,w,h,d)=> { ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);const dates=calendarDays(year+'-01-01',year+'-12-31'), offset=(new Date(year+'-01-01T12:00:00').getDay()+6)%7, cell=Math.min(13,(w-40)/54), max=Math.max(1,...dates.map(d=>byDay.get(d)||0)); points=[];ctx.fillStyle=color();ctx.font='9px sans-serif';
      dates.forEach((date,i)=> { const col=Math.floor((i+offset)/7),row=(i+offset)%7,x=28+col*cell,y=25+row*cell,value=byDay.get(date)||0;ctx.globalAlpha=value?.18+.82*Math.sqrt(value/max):.055;ctx.fillRect(x,y,Math.max(1,cell-2),Math.max(1,cell-2));points.push({date,value,x,y,cell});if(date.endsWith('-01')){ctx.globalAlpha=.55;ctx.fillText(date.slice(5,7),x,14);} });ctx.globalAlpha=.55;ctx.fillText(tr('一','M'),3,34);ctx.fillText(tr('日','S'),3,25+6*cell+9);ctx.globalAlpha=1;
    };choose.addEventListener('change',()=>{year=choose.value;context.heatmapYear=year;resize();},{signal});resize();
    bindSurface(canvas,(x,y)=> { const p=points.find(p=>x*bounds.width>=p.x&&x*bounds.width<p.x+p.cell&&y*156>=p.y&&y*156<p.y+p.cell);const state=p&&context.data.collection(p.date);return p&&`${p.date} · ${p.value?exactDuration(p.value):state==='on'?tr('采集开启，记录为零','Collection on, recorded zero'):state==='partial'?tr('部分时段采集，尚无时长','Partial collection, no duration yet'):tr('未采集','Not collected')}`; });
    table(host,[tr('日期','Date'),tr('时长（时:分:秒）','Duration (h:m:s)')],rows,r=>[r.date,exactDuration(r.seconds)]);
  } else if (spec.type === 'matrix') {
    const months=[...new Set(context.data.entityDays.filter(r=>r.category===spec.category).map(r=>r.date.slice(0,7)))].sort();
    const entities=context.data.rankings(spec.category).slice(0,18), values=new Map();for(const r of context.data.entityDays.filter(r=>r.category===spec.category)) { const key=r.id+'|'+r.date.slice(0,7);values.set(key,(values.get(key)||0)+r.seconds); }
    if(!months.length)host.append(el('p','career-chart-empty',tr('尚未积累月份记录','No monthly history yet')));
    else { const root=frame(Math.max(130,entities.length*24+45)), max=Math.max(1,...values.values());
      entities.forEach((r,i)=>{root.append(svg('text',{x:160,y:30+i*24,'text-anchor':'end',class:'career-axis-label'},r.name.slice(0,22)));months.forEach((month,j)=>{const value=values.get(r.id+'|'+month)||0,circle=svg('circle',{cx:184+j*500/Math.max(1,months.length-1),cy:26+i*24,r:value?2+6*Math.sqrt(value/max):1,fill:'currentColor',opacity:value?.85:.08,tabindex:0});circle.append(svg('title',{},`${r.name} · ${month}: ${exactDuration(value)}`));root.append(circle);});});months.forEach((m,j)=>root.append(svg('text',{x:184+j*500/Math.max(1,months.length-1),y:entities.length*24+30,'text-anchor':'middle',class:'career-axis-label'},m))); }
    table(host,[tr('项目','Project'),tr('月份','Month'),tr('时长（时:分:秒）','Duration (h:m:s)')],[...values],([k,v])=>{const [id,month]=k.split('|');return[context.data.entities.get(id)?.name||id,month,exactDuration(v)];});
  }
  return { destroy() { abort.abort(); observer?.disconnect();pointer=null;context.scheduler.remove(pointerKey);tip.destroy(); if(surface?.tagName==='CANVAS'){surface.width=1;surface.height=1;}host.replaceChildren(); } };
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
  let alive=true, engine=null, canvas=el('canvas'), view=context.graphViews.get(spec.key), settled=!!view;
  const stage=el('div','career-graph-stage');stage.dataset.careerGraph='1';stage.tabIndex=0;stage.setAttribute('aria-label',tr('关系图谱。拖动节点；Ctrl 加滚轮缩放；方向键移动；加减键缩放。','Relationship graph. Drag nodes; Ctrl and wheel to zoom; arrows to pan; plus and minus to zoom.'));
  const hint=el('p','career-graph-hint',tr('拖拽探索关系 · Ctrl / ⌘ + 滚轮缩放','Drag to explore · Ctrl / ⌘ + wheel to zoom'));
  const tip=tooltip(host,context.scheduler), controls=el('div','career-graph-controls'), reset=el('button','',tr('复位','Reset'));reset.type='button';controls.append(reset);stage.append(canvas);host.append(stage,controls,hint);
  const abort=new AbortController(),signal=abort.signal;
  const network=spec.network, nodes=network.nodes.map((n,i)=>({ ...n, x:view?.positions.get(n.id)?.x??Math.cos(i*2.39996)*Math.sqrt(i+1)*25, y:view?.positions.get(n.id)?.y??Math.sin(i*2.39996)*Math.sqrt(i+1)*25, r:4+Math.min(7,Math.sqrt(n.degree||1)) }));
  const byId=new Map(nodes.map((node,i)=>[node.id,i]));
  const edges=network.edges.map(edge=>({source:byId.get(edge.from),target:byId.get(edge.to),rest:112})).filter(e=>e.source!==undefined&&e.target!==undefined);
  host.append(el('p','career-graph-count',tr(`展示 ${nodes.length} / ${network.totalNodes??nodes.length} 个节点，${network.edges.length} / ${network.totalEdges??network.edges.length} 条真实关系`,`Showing ${nodes.length} / ${network.totalNodes??nodes.length} nodes, ${network.edges.length} / ${network.totalEdges??network.edges.length} real relationships`)));
  let ro;
  loadGraph().then(()=> {
    if(!alive)return;
    const dark=document.body.dataset.startTheme==='dark', fill=dark?'#b9b9b9':'#5f5f5f', focus=dark?'#f5f5f5':'#202020';
    const gray=dark?185/255:95/255, highlighted=dark?245/255:32/255;
    const nodeStyles=[0,1,2,3].map(state=>{const color=state&2?highlighted:gray;return {fill:[color,color,color,state&1?.18:1]};});
    const edgeStyles=[0,1,2,3].map(state=>{const color=state&2?highlighted:gray,alpha=state&2?(state&1?.08:.8):(state&1?.04:.25);return {color:[color,color,color,alpha],width:state&2?1.5:1};});
    engine=window.GraphEngine.create({ canvas,backend:'webgl',cacheInstances:true,coalesceHover:true,reduceMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      shouldHandleWheel:event=>event.ctrlKey||event.metaKey,
      config:{viewW:900,viewH:420,zoomMin:.12,zoomMax:4,presolveMaxNodes:0,alphaDecay:.04,finalFitOnConverge:false,fitMargin:28},
      onCanvasReplace:replacement=>{canvas=replacement;}, nodeStyle:(n,e)=>nodeStyles[(e.focus?2:0)+(e.dim?1:0)],edgeStyle:(edge,a,b,e)=>edgeStyles[(e.highlighted?2:0)+(e.dim?1:0)],
      drawNode(ctx,node,e){ctx.globalAlpha*=e.dim?.18:1;ctx.fillStyle=e.focus?focus:fill;ctx.beginPath();ctx.arc(0,0,node.r,0,Math.PI*2);ctx.fill();},
      drawEdge(ctx,edge,a,b,e){ctx.globalAlpha*=e.dim?.04:.24;ctx.strokeStyle=e.highlighted?focus:fill;ctx.lineWidth=e.highlighted?1.5:1;ctx.beginPath();ctx.moveTo(a._rx,a._ry);ctx.lineTo(b._rx,b._ry);ctx.stroke();},
      onNodeHover(node,event){if(node)tip.show(`${node.title} · ${number(node.words??node.degree??0)} ${node.words!=null?tr('字词','words'):tr('关系','relations')}`,event.clientX,event.clientY);else tip.hide();},
      onLayoutSettled(){settled=true;}
    });engine.setDrift(false);engine.setParticles(false);engine.setData(nodes,edges);
    const start=()=>{if(!alive||stage.clientWidth<=0||stage.clientHeight<=0)return;ro?.disconnect();ro=null;engine.setActive(true);engine.setVisible(true);if(view){engine.restoreView(view.camera);if(!view.settled)engine.heat(.18);}else engine.start({intro:true,introSpanMs:900});};
    ro=new ResizeObserver(start);ro.observe(stage);start();
    reset.addEventListener('click',()=>engine?.fitView(true),{signal});
    stage.addEventListener('keydown',event=>{if(!engine)return;const camera=engine.view;if(!camera)return;const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'];if(!keys.includes(event.key))return;event.preventDefault();if(event.key==='0'){engine.fitView(true);return;}engine.restoreView({...camera,x:camera.x+(event.key==='ArrowLeft'?30:event.key==='ArrowRight'?-30:0),y:camera.y+(event.key==='ArrowUp'?30:event.key==='ArrowDown'?-30:0),scale:camera.scale*(event.key==='+'||event.key==='='?1.15:event.key==='-'?1/1.15:1)});},{signal});
  }).catch(()=> {if(alive)stage.replaceChildren(el('p','career-chart-empty',tr('图谱加载失败，重新进入可重试','Graph failed to load; re-enter to retry')));});
  table(host,[tr('节点','Node'),tr('关系数','Relations')],nodes,n=>[n.title,number(n.degree||0)]);
  return { destroy() {alive=false;abort.abort();ro?.disconnect();tip.destroy();if(engine){context.graphViews.set(spec.key,{camera:engine.view,positions:new Map(nodes.map(n=>[n.id,{x:n.x,y:n.y}])),settled});engine.destroy();engine=null;}canvas.width=1;canvas.height=1;host.replaceChildren();} };
}

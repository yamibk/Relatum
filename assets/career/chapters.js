import { el, tr, number, duration, label, dateKey, select, categories } from './data.js';

export function buildReport(report, context, actions) {
  const data=select(report,context.filter);context.data=data;
  const inventory=report.inventory, shell=el('div','career-report-shell'), charts=[];
  shell.dataset.i18nManaged='1';
  const stockLabel=tr('生成时规模','Inventory at generation');
  function metric(name,value,format=number) {
    const item=el('div','career-hero-metric'), n=el('strong','',format(value));
    if(value!=null){n.dataset.careerNumber=String(value);n._format=format;} item.append(n,el('span','',name));return item;
  }
  function chapter(id,index,title,copy) {
    const node=el('section','career-chapter');node.id='career-'+id;node.dataset.chapter=id;
    const head=el('header','career-section-head');head.append(el('p','career-section-kicker',`${index} / RELATUM`),el('h2','',title),el('p','',copy));node.append(head);shell.append(node);
    const grid=el('div','career-editorial-grid');node.append(grid);return {node,grid};
  }
  function card(section,key,title,copy,spec,wide=false) {
    if(spec.inventory){
      const category=section.node.dataset.chapter;
      const source=category==='canvas'?(key.startsWith('embedded')?inventory.embedded:inventory.canvas):inventory[category];
      if(source?.status==='unavailable')spec={...spec,unavailable:true};
      if(source?.status==='partial')copy+=' · '+tr('仅含成功读取的部分','Successfully read portion only');
    }
    const panel=el('section','career-panel'+(wide?' is-wide':''));
    panel.append(el('p','career-panel-kicker',spec.inventory?stockLabel:tr('新历史','New history')),el('h3','',title),el('p','career-panel-copy',copy));
    const host=el('div',`career-chart-mount career-chart-${spec.type}`);host.dataset.chartKey=key;host.style.minHeight=spec.type==='graph'?'530px':spec.type==='rank'?'390px':'290px';panel.append(host);section.grid.append(panel);
    charts.push({host,panel,spec:{...spec,key,title}});return panel;
  }
  const hero=el('section','career-hero');hero.dataset.chapter='hero';
  hero.append(el('p','career-section-kicker','RELATUM · CAREER'),el('p','career-hero-date',new Date(report.generatedAt).toLocaleString()),el('h1','',tr('使用报告','Usage report')),
    el('p','career-hero-copy',tr('使用时长、内容规模与完成记录。','Usage time, content size and completed activities.')));
  if(report.history.demo)hero.append(el('p','career-demo-label',tr('验收数据 · 用于检查图表，不是实际使用记录','Demo data · for checking charts, not actual usage')));
  const summary=el('div','career-hero-metrics');summary.append(metric(tr('使用时长','Usage time'),data.seconds,duration),metric(tr('活跃日期','Active days'),data.activeDays),metric(tr('最长连续活跃','Longest streak'),data.longest),metric(tr('笔记字词 · 生成时','Note words · at generation'),inventory.notes.wordCount));hero.append(el('div','career-hero-rule'),summary);shell.append(hero);
  const toolbar=el('nav','career-filter');toolbar.setAttribute('aria-label',tr('冻结数据的时间范围','Time range of the frozen report'));
  const modes=[['all',tr('全部记录','All records')],['30',tr('近 30 天','30 days')],['90',tr('近 90 天','90 days')],['year',tr('自然年','This year')],['custom',tr('自定义','Custom')]];
  modes.forEach(([mode,text])=>{const b=el('button','',text);b.type='button';b.dataset.mode=mode;b.setAttribute('aria-pressed',String(context.filter.mode===mode));b.addEventListener('click',()=>actions.filter({...context.filter,mode}));toolbar.append(b);});
  const year=el('select','career-year-select');year.hidden=context.filter.mode!=='year';year.setAttribute('aria-label',tr('报告年份','Report year'));
  const firstYear=new Date(report.history.since).getFullYear(),lastYear=new Date(report.history.cutoff).getFullYear();
  for(let y=lastYear;y>=firstYear;y--){const option=el('option','',String(y));option.value=String(y);year.append(option);}year.value=String(context.filter.year||lastYear);
  year.addEventListener('change',()=>actions.filter({mode:'year',year:year.value}));toolbar.append(year);
  const range=el('div','career-custom-range');range.hidden=context.filter.mode!=='custom';
  const from=el('input'),to=el('input'),apply=el('button','',tr('应用','Apply'));apply.type='button';
  from.type=to.type='date';from.value=context.filter.start||data.start;to.value=context.filter.end||data.end;
  from.setAttribute('aria-label',tr('开始日期','Start date'));to.setAttribute('aria-label',tr('结束日期','End date'));
  const maximum=dateKey(new Date(report.history.cutoff));from.max=to.max=maximum;
  apply.addEventListener('click',()=>{to.setCustomValidity(from.value>to.value?tr('结束日期不能早于开始日期','End must follow start'):'');if(from.reportValidity()&&to.reportValidity())actions.filter({mode:'custom',start:from.value,end:to.value});});range.append(from,el('span','','—'),to,apply);toolbar.append(range);shell.append(toolbar);
  shell.append(el('p','career-range-caption',`${data.start} — ${data.end} · ${tr('筛选只改变冻结历史；内容规模以生成时为准','Filters use frozen history; inventories describe generation time')}`));
  if(!data.days.length)shell.append(el('p','career-history-empty',tr('这个时间范围尚未积累使用记录。当前内容规模仍在下方展示。','No usage history in this range yet. Current inventories are shown below.')));

  const overview=chapter('overview','01',tr('使用概况','Usage overview'),tr('统计前台停留时间。重叠时段只计一次。','Foreground time. Overlapping intervals count once.'));
  card(overview,'daily',tr('每日时长','Daily usage'),tr('每根细线是一日，长度对应实际时长。','One fine line per calendar day; length represents duration.'),{type:'barcode',rows:data.days},true);
  card(overview,'heatmap',tr('年度热力图','Yearly heatmap'),tr('深浅表示前台时间；空白不代表已开启采集。','Shade represents foreground time. Blank cells do not imply collection was enabled.'),{type:'heatmap',rows:data.days});
  card(overview,'composition',tr('工作区时长趋势','Workspace usage trends'),tr('日期按实际间隔绘制；没有记录的日期不连接。','Dates use real intervals. Gaps remain gaps.'),{type:'trend',rows:data.days,keys:['notes','canvas','research']});

  const notes=chapter('notes','02',tr('笔记','Notes'),`${stockLabel} · ${number(inventory.notes.count)} ${tr('篇','notes')} · ${number(inventory.notes.wordCount)} ${tr('字词','words')} · ${number(inventory.notes.linkCount)} ${tr('关系','links')}`);
  card(notes,'notebooks',tr('笔记本字数','Words by notebook'),tr('面积表示字词数量。','Area represents word count.'),{type:'treemap',inventory:true,unit:tr('字词','Words'),rows:inventory.notes.books.map(b=>({name:b.name,value:b.words}))});
  card(notes,'lengths',tr('篇幅分布','Note length distribution'),tr('按正文可见字词统计，包含图片文字。','Visible words, including image text.'),{type:'distribution',inventory:true,unit:tr('篇','Notes'),rows:inventory.notes.lengths.map((value,i)=>({name:['<100','100–499','500–999','1k–<2k','2k–<5k','≥5k'][i],value}))});
  card(notes,'note-use',tr('常用笔记','Most used notes'),tr('当前筛选范围内的前台使用时长。','Foreground time within the selected range.'),{type:'rank',unit:'seconds',rows:data.rankings('notes')});
  card(notes,'note-size',tr('笔记字数排名','Notes by word count'),stockLabel,{type:'rank',inventory:true,unit:tr('字词','Words'),rows:inventory.notes.items.map(n=>({...n,value:n.words})).sort((a,b)=>b.value-a.value)});
  card(notes,'note-network',tr('笔记关系','Note links'),tr('同一笔记本内的双链和 Markdown 链接。','Wiki and Markdown links within each notebook.'),{type:'graph',inventory:true,network:inventory.notes.network},true);

  const canvas=chapter('canvas','03',tr('画布','Canvases'),tr('主画布与笔记内嵌画布分别计量。共享内嵌文件只计算一次。','Main and embedded canvases are counted separately. Shared embedded files are counted once.'));
  const canvasMetrics=el('div','career-stat-strip');canvasMetrics.append(metric(tr('主画布 · 生成时','Main canvases · at generation'),inventory.canvas.count),metric(tr('内嵌文件 · 生成时','Embedded files · at generation'),inventory.embedded.count),metric(tr('有效内嵌引用','Valid embedded references'),inventory.embedded.references));canvas.node.insertBefore(canvasMetrics,canvas.grid);
  card(canvas,'canvas-types',tr('节点类型','Node types'),`${stockLabel} · ${number(inventory.canvas.nodes)} ${tr('节点','nodes')} · ${number(inventory.canvas.edges)} ${tr('连线','edges')}`,{type:'distribution',inventory:true,rows:Object.entries(inventory.canvas.kinds).map(([name,value])=>({name,value}))});
  card(canvas,'canvas-use',tr('常用画布','Frequently used canvases'),tr('改名与移动保留同一身份的历史。','Renaming and moving preserve identity and history.'),{type:'rank',unit:'seconds',rows:data.rankings('canvas')});
  card(canvas,'canvas-months',tr('画布每月时长','Monthly canvas usage'),tr('圆点面积表示每月时长，精确值见提示与明细。','Dot area represents monthly time; exact values appear in hints and details.'),{type:'matrix',category:'canvas',rows:[]},true);
  card(canvas,'embedded-structure',tr('内嵌画布引用','Embedded canvas references'),`${stockLabel} · ${number(inventory.embedded.nodes)} ${tr('节点','nodes')} · ${number(inventory.embedded.edges)} ${tr('连线','edges')} · ${number(inventory.embedded.missingReferences)} ${tr('缺失文件引用','references to missing files')}`,{type:'rank',inventory:true,unit:tr('引用笔记','Referencing notes'),rows:inventory.embedded.items.map(i=>({...i,value:i.references})).sort((a,b)=>b.value-a.value)});
  card(canvas,'embedded-use',tr('内嵌画布的使用','Embedded canvas use'),tr('这是笔记时间的细分，不再次加入总时长。','A subdivision of note time, not added again to the total.'),{type:'rank',unit:'seconds',rows:data.rankings('embedded')});

  const research=chapter('research','04',tr('研究','Research'),inventory.research.status==='unavailable'?tr('研究来源未能读取，规模未计入。','Research could not be read; its inventory is unavailable.'):`${stockLabel} · ${number(inventory.research.count)} ${tr('页面','pages')} · ${number(inventory.research.components||0)} ${tr('组件','components')} · ${number(inventory.research.wires||0)} ${tr('导线','wires')} · ${number(inventory.research.relations||0)} ${tr('关系线','relations')} · ${number(inventory.research.definitions||0)} ${tr('子电路定义','definitions')}`);
  card(research,'research-use',tr('常用研究页面','Most used research pages'),tr('后台仿真与隐藏页面不计入前台时间。','Background simulations and hidden pages do not add foreground time.'),{type:'rank',unit:'seconds',rows:data.rankings('research')});
  card(research,'research-size',tr('页面组件数量','Components by page'),stockLabel,{type:'rank',inventory:true,unit:tr('组件','Components'),rows:inventory.research.items.map(p=>({...p,value:p.nodes})).sort((a,b)=>b.value-a.value)});
  card(research,'reuse-network',tr('实际复用依赖','Actual reuse dependencies'),tr('页面到子电路、子电路之间的真实实例依赖。','Real instance dependencies from pages to definitions and between definitions.'),{type:'graph',inventory:true,network:inventory.research.network},true);

  const habits=chapter('habits','05',tr('学习与习惯','Learning and habits'),tr('只展示新启用后成功产生的归档、复习与打卡记录。','Only successful archives, reviews and check-ins since the new journal began.'));
  card(habits,'learning-stock',tr('当前学习结构','Current learning structures'),stockLabel,{type:'distribution',inventory:true,rows:inventory.learning.items.map(i=>({name:label(i.name),value:i.count+i.nodes}))});
  const weekdays=Array(7).fill(0),hours=Array(24).fill(0);
  data.hours.forEach(r=>{hours[r.hour]+=r.seconds;weekdays[(new Date(r.date+'T12:00:00').getDay()+6)%7]+=r.seconds;});
  card(habits,'weekday',tr('星期分布','Usage by weekday'),tr('真实前台时间按星期分布。','Real foreground time by weekday.'),{type:'distribution',duration:true,unit:tr('小时','Hours'),rows:weekdays.map((v,i)=>({name:[tr('一','M'),tr('二','Tu'),tr('三','W'),tr('四','Th'),tr('五','F'),tr('六','Sa'),tr('日','Su')][i],value:v/3600}))});
  card(habits,'hours',tr('小时分布','Usage by hour'),tr('跨小时与跨午夜时段均按当地时间拆分。','Intervals are split at local hour and midnight boundaries.'),{type:'distribution',duration:true,unit:tr('小时','Hours'),rows:hours.map((v,i)=>({name:String(i).padStart(2,'0'),value:v/3600}))},true);
  const eventKinds=['archived','checkin','reviewed','created','modified'];
  card(habits,'events',tr('操作记录','Recorded activities'),tr('重复操作与无变化保存不增加记录。','Repeated operations and unchanged saves do not add records.'),{type:'distribution',rows:eventKinds.map((kind,i)=>({name:[tr('归档','Archives'),tr('打卡','Check-ins'),tr('复习','Reviews'),tr('创建','Created'),tr('修改','Modified')][i],value:data.events.filter(e=>e.kind===kind).reduce((s,e)=>s+e.count,0)}))});
  card(habits,'event-categories',tr('各类新记录','New records by category'),tr('按成功业务操作累计数量。','Counts of successful business operations.'),{type:'distribution',rows:Object.keys(categories).map(name=>({name:label(name),value:data.events.filter(e=>e.category===name).reduce((s,e)=>s+e.count,0)}))});
  const eventDays=new Map();for(const event of data.events){const day=eventDays.get(event.day)||{date:event.day,seconds:0,categories:{}};day.seconds+=event.count;day.categories[event.category]=(day.categories[event.category]||0)+event.count;eventDays.set(event.day,day);}
  card(habits,'event-trend',tr('各类操作趋势','Activity trends by category'),tr('按实际日期展示新操作数量，日期缺口保留。','New operation counts on real dates, preserving gaps.'),{type:'trend',unit:'count',keys:Object.keys(categories),rows:[...eventDays.values()].sort((a,b)=>a.date.localeCompare(b.date))},true);
  const timeline=el('section','career-panel is-wide career-completion-timeline');timeline.append(el('h3','',tr('完成时间线','Completion timeline')));
  const eventList=el('ol','career-events'), meaningful=data.events.filter(e=>['archived','reviewed','checkin'].includes(e.kind)).slice().reverse();let count=0;
  const more=el('button','career-more',tr('加载更多','Load more'));more.type='button';const add=()=>{meaningful.slice(count,count+40).forEach(event=>{const item=el('li');item.append(el('time','',event.day),el('span','',`${label(event.category)} · ${data.entities.get(event.entity)?.name||label(event.category)}`),el('strong','',number(event.count)));eventList.append(item);});count+=40;more.hidden=count>=meaningful.length;};more.addEventListener('click',add);add();if(!meaningful.length)eventList.append(el('li','',tr('尚未积累完成记录','No completion records yet')));timeline.append(eventList,more);habits.grid.append(timeline);

  const rangeChapter=chapter('range','06',tr('数据范围','Data coverage'),tr('每个来源独立说明完整性。读取失败的来源不会显示成零。','Completeness is reported for each source. Unreadable sources are never presented as zero.'));
  const rangePanel=el('section','career-panel is-wide');rangePanel.append(el('h3','',tr('记录与生成范围','Collection and generation range')),
    el('p','',`${tr('新记录起点','New journal began')}: ${new Date(report.history.since).toLocaleString()}`),el('p','',`${tr('生成时点','Generated')}: ${new Date(report.generatedAt).toLocaleString()}`),
    el('p','',tr('当前库存参与规模统计；旧计时账本与旧报告不读取、不回填。专注钟和日记不参与。','Current content is counted as inventory. Legacy ledgers and reports are neither read nor backfilled. Focus clocks and diaries are excluded.')));
  const statuses={available:tr('已读取','Read'),empty:tr('来源为空','Empty source'),partial:tr('部分读取','Partially read'),unavailable:tr('未能读取','Unreadable'),disabled:tr('功能未启用','Feature disabled')};
  const sources=el('ul','career-coverage-list');report.sources.forEach(source=>sources.append(el('li','',`${label(source.id)} · ${statuses[source.status]||source.status} · ${tr('未读取','Skipped')} ${number(source.skipped)}`)));rangePanel.append(sources);
  const periods=el('details','career-details');periods.append(el('summary','',tr('分类记录开关历史','Collection setting history')));
  const list=el('ul');for(const category of Object.keys(categories)){const policies=report.history.coverage.filter(p=>p.category===category).sort((a,b)=>a.at-b.at);policies.forEach((p,i)=>list.append(el('li','',`${label(category)} · ${new Date(p.at).toLocaleString()} — ${new Date(policies[i+1]?.at??report.history.cutoff).toLocaleString()} · ${p.enabled?tr('采集开启','Collection on'):tr('未采集','Not collected')}`)));}periods.append(list);rangePanel.append(periods);
  const regenerate=el('button','career-regenerate',tr('重新生成报告','Generate a fresh report'));regenerate.type='button';regenerate.dataset.careerAction='generate';regenerate.addEventListener('click',actions.generate);rangePanel.append(regenerate);rangeChapter.grid.append(rangePanel);
  const end=el('footer','career-end');end.append(el('p','career-kicker','RELATUM · CAREER'));shell.append(end);
  return {shell,charts};
}

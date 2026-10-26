import { el, tr, number, metricNumber, metricDuration, label, dateKey, select, prepareReport, categories } from './data.js';
import { prepareNumber } from './motion.js';

export function buildReport(report, context, actions) {
  let data=select(report,context.filter);context.data=data;
  const prepared=prepareReport(report);
  const inventory=report.inventory, shell=el('div','career-report-shell'), charts=[];
  shell.dataset.i18nManaged='1';
  const stockLabel=tr('生成时规模','Inventory at generation');
  function metric(key,name,value,format=metricNumber) {
    const item=el('div','career-hero-metric'), n=el('strong','',format(value));
    if(value!=null){
      n.dataset.careerNumber=String(value);n.dataset.metricKey=key;n._format=format;
      if(context.countedNumbers.has(key))n.dataset.counted='1';
      else prepareNumber(n);
      if(n.dataset.counted==='1')context.countedNumbers.add(key);
    }
    item.append(n,el('span','',name));return item;
  }
  function chapter(id,index,title,copy) {
    const node=el('section','career-chapter');node.id='career-'+id;node.dataset.chapter=id;
    const head=el('header','career-section-head');head.append(el('p','career-section-kicker',`${index} / RELATUM`),el('h2','',title),el('p','',copy));node.append(head);shell.append(node);
    const grid=el('div','career-editorial-grid');node.append(grid);return {node,grid};
  }
  function chartHeight(spec){
    if(spec.unavailable||spec.type==='graph'&&!spec.network.nodes.length)return '226px';
    if(spec.type==='graph')return 'calc(var(--career-graph-height,420px) + 145px)';
    if(spec.type==='rank'){const count=Math.min(12,spec.rows.length);return count?`calc(${count} * var(--career-rank-row,18px) + ${Math.max(0,count-1)*15+79}px)`:'226px';}
    if(spec.type==='matrix'&&!data.monthly.get(spec.category)?.months.size)return '275px';
    if(!spec.rows.length&&!['heatmap','matrix'].includes(spec.type))return '226px';
    return spec.type==='heatmap'?'244px':spec.type==='barcode'?'290px':'0px';
  }
  function previewHeight(host,spec){
    let height=0;
    if(!spec.unavailable&&['trend','treemap','distribution','matrix'].includes(spec.type)&&(spec.rows.length||spec.type==='matrix'&&data.monthly.get(spec.category)?.months.size))height=spec.type==='matrix'?Math.max(130,Math.min(18,data.rankings(spec.category).length)*24+45):spec.type==='distribution'?250:280;
    if(height){if(host.dataset.previewHeight!==String(height)){host.dataset.previewHeight=String(height);host.style.setProperty('--career-preview-height',height);}}
    else if(host.hasAttribute('data-preview-height')){delete host.dataset.previewHeight;host.style.removeProperty('--career-preview-height');}
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
    const host=el('div',`career-chart-mount career-chart-${spec.type}`);host.dataset.chartKey=key;host.dataset.mounted='0';host.style.minHeight=chartHeight(spec);
    previewHeight(host,spec);
    if(spec.type==='trend'){host.style.setProperty('--career-preview-space','105px');if(spec.keys.length>3)host.classList.add('has-many-series');}
    panel.append(host);section.grid.append(panel);
    charts.push({host,panel,minHeight:chartHeight(spec),spec:{...spec,key,title}});return panel;
  }
  const hero=el('section','career-hero');hero.dataset.chapter='hero';
  hero.append(el('p','career-section-kicker','RELATUM · CAREER'),el('p','career-hero-date',new Date(report.generatedAt).toLocaleString()),el('h1','',tr('使用报告','Usage report')),
    el('p','career-hero-copy',tr('使用时长、内容规模与完成记录。','Usage time, content size and completed activities.')));
  if(report.history.demo)hero.append(el('p','career-demo-label',tr('验收数据 · 用于检查图表，不是实际使用记录','Demo data · for checking charts, not actual usage')));
  const summary=el('div','career-hero-metrics');summary.append(metric('usage',tr('使用时长','Usage time'),data.seconds,metricDuration(data.seconds)),metric('active-days',tr('活跃日期','Active days'),data.activeDays),metric('longest-streak',tr('最长连续活跃','Longest streak'),data.longest),metric('note-words',tr('笔记字词 · 生成时','Note words · at generation'),inventory.notes.wordCount));hero.append(el('div','career-hero-rule'),summary);shell.append(hero);
  const toolbar=el('nav','career-filter');toolbar.setAttribute('aria-label',tr('冻结数据的时间范围','Time range of the frozen report'));
  const segments=el('div','career-filter-segments');toolbar.append(segments);
  const modes=[['all',tr('全部记录','All records')],['30',tr('近 30 天','30 days')],['90',tr('近 90 天','90 days')],['year',tr('自然年','This year')],['custom',tr('自定义','Custom')]];
  modes.forEach(([mode,text])=>{const b=el('button','',text);b.type='button';b.dataset.mode=mode;b.setAttribute('aria-pressed',String(context.filter.mode===mode));b.addEventListener('click',()=>actions.filter({...context.filter,mode}));segments.append(b);});
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
  const caption=el('p','career-range-caption'),empty=el('p','career-history-empty',tr('这个时间范围尚未积累使用记录。当前内容规模仍在下方展示。','No usage history in this range yet. Current inventories are shown below.'));
  shell.append(caption,empty);
  function rangeCaption(){caption.textContent=`${data.start} — ${data.end} · ${tr('筛选只改变冻结历史；内容规模以生成时为准','Filters use frozen history; inventories describe generation time')}`;if(empty.hidden!==!!data.days.length)empty.hidden=!!data.days.length;}
  rangeCaption();

  const overview=chapter('overview','01',tr('使用概况','Usage overview'),tr('统计前台停留时间。重叠时段只计一次。','Foreground time. Overlapping intervals count once.'));
  card(overview,'daily',tr('每日时长','Daily usage'),tr('每根细线是一日，长度对应实际时长。','One fine line per calendar day; length represents duration.'),{type:'barcode',rows:data.days},true);
  card(overview,'heatmap',tr('年度热力图','Yearly heatmap'),tr('深浅表示前台时间；空白不代表已开启采集。','Shade represents foreground time. Blank cells do not imply collection was enabled.'),{type:'heatmap',rows:data.days});
  card(overview,'composition',tr('工作区时长趋势','Workspace usage trends'),tr('日期按实际间隔绘制；没有记录的日期不连接。','Dates use real intervals. Gaps remain gaps.'),{type:'trend',rows:data.days,keys:['notes','canvas','research']});

  const notes=chapter('notes','02',tr('笔记','Notes'),`${stockLabel} · ${number(inventory.notes.count)} ${tr('篇','notes')} · ${number(inventory.notes.wordCount)} ${tr('字词','words')} · ${number(inventory.notes.linkCount)} ${tr('关系','links')}`);
  card(notes,'notebooks',tr('笔记本字数','Words by notebook'),tr('面积表示字词数量。','Area represents word count.'),{type:'treemap',inventory:true,unit:tr('字词','Words'),rows:inventory.notes.books.map(b=>({name:b.name,value:b.words}))});
  card(notes,'lengths',tr('篇幅分布','Note length distribution'),tr('按正文可见字词统计，包含图片文字。','Visible words, including image text.'),{type:'distribution',inventory:true,unit:tr('篇','Notes'),rows:inventory.notes.lengths.map((value,i)=>({name:['<100','100–499','500–999','1k–<2k','2k–<5k','≥5k'][i],value}))});
  const noteUse=card(notes,'note-use',tr('常用笔记','Most used notes'),tr('当前筛选范围内的前台使用时长。','Foreground time within the selected range.'),{type:'rank',unit:'seconds',rows:data.rankings('notes')});
  const archivedSummary=el('p','career-archived-notes');noteUse.append(archivedSummary);
  function updateArchivedSummary(){
    const value=data.archivedNotes,selectedDates=context.filter.mode!=='all';
    archivedSummary.hidden=!value?.count;
    archivedSummary.textContent=value?.count?tr(`已归档笔记 · 累计 ${number(value.count)} 篇 · 已归档的笔记总时长 ${metricDuration(value.seconds)(value.seconds)}${selectedDates?'（所选日期）':''}`,`Archived notes · ${number(value.count)} in total · Total archived note time ${metricDuration(value.seconds)(value.seconds)}${selectedDates?' (selected dates)':''}`):'';
  }
  updateArchivedSummary();
  card(notes,'note-size',tr('笔记字数排名','Notes by word count'),stockLabel,{type:'rank',inventory:true,unit:tr('字词','Words'),rows:prepared.inventoryRows.noteSize});
  card(notes,'note-network',tr('笔记关系','Note links'),tr('同一笔记本内的双链和 Markdown 链接。','Wiki and Markdown links within each notebook.'),{type:'graph',inventory:true,network:inventory.notes.network},true);

  const canvas=chapter('canvas','03',tr('画布','Canvases'),tr('主画布与笔记内嵌画布分别计量。共享内嵌文件只计算一次。','Main and embedded canvases are counted separately. Shared embedded files are counted once.'));
  const canvasMetrics=el('div','career-stat-strip');canvasMetrics.append(metric('canvas-count',tr('主画布 · 生成时','Main canvases · at generation'),inventory.canvas.count),metric('embedded-count',tr('内嵌文件 · 生成时','Embedded files · at generation'),inventory.embedded.count),metric('embedded-references',tr('有效内嵌引用','Valid embedded references'),inventory.embedded.references));canvas.node.insertBefore(canvasMetrics,canvas.grid);
  card(canvas,'canvas-types',tr('节点类型','Node types'),`${stockLabel} · ${number(inventory.canvas.nodes)} ${tr('节点','nodes')} · ${number(inventory.canvas.edges)} ${tr('连线','edges')}`,{type:'distribution',inventory:true,rows:Object.entries(inventory.canvas.kinds).map(([name,value])=>({name,value}))});
  card(canvas,'canvas-use',tr('常用画布','Frequently used canvases'),tr('改名与移动保留同一身份的历史。','Renaming and moving preserve identity and history.'),{type:'rank',unit:'seconds',rows:data.rankings('canvas')});
  card(canvas,'canvas-months',tr('画布每月时长','Monthly canvas usage'),tr('圆点面积表示每月时长，精确值见提示与明细。','Dot area represents monthly time; exact values appear in hints and details.'),{type:'matrix',category:'canvas',rows:[]},true);
  card(canvas,'embedded-structure',tr('内嵌画布引用','Embedded canvas references'),`${stockLabel} · ${number(inventory.embedded.nodes)} ${tr('节点','nodes')} · ${number(inventory.embedded.edges)} ${tr('连线','edges')} · ${number(inventory.embedded.missingReferences)} ${tr('缺失文件引用','references to missing files')}`,{type:'rank',inventory:true,unit:tr('引用笔记','Referencing notes'),rows:prepared.inventoryRows.embeddedStructure});
  card(canvas,'embedded-use',tr('内嵌画布的使用','Embedded canvas use'),tr('这是笔记时间的细分，不再次加入总时长。','A subdivision of note time, not added again to the total.'),{type:'rank',unit:'seconds',rows:data.rankings('embedded')});

  const research=chapter('research','04',tr('研究','Research'),inventory.research.status==='unavailable'?tr('研究来源未能读取，规模未计入。','Research could not be read; its inventory is unavailable.'):`${stockLabel} · ${number(inventory.research.count)} ${tr('页面','pages')} · ${number(inventory.research.components||0)} ${tr('组件','components')} · ${number(inventory.research.wires||0)} ${tr('导线','wires')} · ${number(inventory.research.relations||0)} ${tr('关系线','relations')} · ${number(inventory.research.definitions||0)} ${tr('子电路定义','definitions')}`);
  card(research,'research-use',tr('常用研究页面','Most used research pages'),tr('后台仿真与隐藏页面不计入前台时间。','Background simulations and hidden pages do not add foreground time.'),{type:'rank',unit:'seconds',rows:data.rankings('research')});
  card(research,'research-size',tr('页面组件数量','Components by page'),stockLabel,{type:'rank',inventory:true,unit:tr('组件','Components'),rows:prepared.inventoryRows.researchSize});
  card(research,'reuse-network',tr('实际复用依赖','Actual reuse dependencies'),tr('页面到子电路、子电路之间的真实实例依赖。','Real instance dependencies from pages to definitions and between definitions.'),{type:'graph',inventory:true,network:inventory.research.network},true);

  const habits=chapter('habits','05',tr('学习与习惯','Learning and habits'),tr('只展示新启用后成功产生的归档、复习与打卡记录。','Only successful archives, reviews and check-ins since the new journal began.'));
  card(habits,'learning-stock',tr('当前学习结构','Current learning structures'),stockLabel,{type:'distribution',inventory:true,rows:inventory.learning.items.map(i=>({name:label(i.name),value:i.count+i.nodes}))});
  const weekdays=data.weekdays,hours=data.hourTotals;
  card(habits,'weekday',tr('星期分布','Usage by weekday'),tr('真实前台时间按星期分布。','Real foreground time by weekday.'),{type:'distribution',duration:true,unit:tr('小时','Hours'),rows:weekdays.map((v,i)=>({name:[tr('一','M'),tr('二','Tu'),tr('三','W'),tr('四','Th'),tr('五','F'),tr('六','Sa'),tr('日','Su')][i],value:v/3600}))});
  card(habits,'hours',tr('小时分布','Usage by hour'),tr('跨小时与跨午夜时段均按当地时间拆分。','Intervals are split at local hour and midnight boundaries.'),{type:'distribution',duration:true,unit:tr('小时','Hours'),rows:hours.map((v,i)=>({name:String(i).padStart(2,'0'),value:v/3600}))},true);
  const eventKinds=['archived','checkin','reviewed','created','modified'];
  const eventNames=[tr('归档','Archives'),tr('打卡','Check-ins'),tr('复习','Reviews'),tr('创建','Created'),tr('修改','Modified')];
  card(habits,'events',tr('操作记录','Recorded activities'),tr('重复操作与无变化保存不增加记录。','Repeated operations and unchanged saves do not add records.'),{type:'distribution',rows:eventKinds.map((kind,i)=>({name:eventNames[i],value:data.eventKinds.get(kind)||0}))});
  card(habits,'event-categories',tr('各类新记录','New records by category'),tr('按成功业务操作累计数量。','Counts of successful business operations.'),{type:'distribution',rows:Object.keys(categories).map(name=>({name:label(name),value:data.eventCategories.get(name)||0}))});
  card(habits,'event-trend',tr('各类操作趋势','Activity trends by category'),tr('按实际日期展示新操作数量，日期缺口保留。','New operation counts on real dates, preserving gaps.'),{type:'trend',unit:'count',keys:Object.keys(categories),rows:data.eventDays},true);
  const timeline=el('section','career-panel is-wide career-completion-timeline');timeline.append(el('h3','',tr('完成时间线','Completion timeline')));
  const eventList=el('ol','career-events');let meaningful=[],count=0;
  const more=el('button','career-more',tr('加载更多','Load more'));more.type='button';const add=()=>{meaningful.slice(count,count+40).forEach(event=>{const item=el('li');item.append(el('time','',event.day),el('span','',`${label(event.category)} · ${data.entities.get(event.entity)?.name||label(event.category)}`),el('strong','',number(event.count)));eventList.append(item);});count+=40;more.hidden=count>=meaningful.length;};more.addEventListener('click',add);
  let timelineEvents=null;
  function updateTimeline(){if(timelineEvents===data.events)return;timelineEvents=data.events;meaningful=data.events.filter(e=>['archived','reviewed','checkin'].includes(e.kind)).slice().reverse();count=0;eventList.replaceChildren();add();if(!meaningful.length)eventList.append(el('li','',tr('尚未积累完成记录','No completion records yet')));}
  updateTimeline();timeline.append(eventList,more);habits.grid.append(timeline);

  const rangeChapter=chapter('range','06',tr('数据范围','Data coverage'),tr('每个来源独立说明完整性。读取失败的来源不会显示成零。','Completeness is reported for each source. Unreadable sources are never presented as zero.'));
  const rangePanel=el('section','career-panel is-wide');rangePanel.append(el('h3','',tr('记录与生成范围','Collection and generation range')),
    el('p','',`${tr('新记录起点','New journal began')}: ${new Date(report.history.since).toLocaleString()}`),el('p','',`${tr('生成时点','Generated')}: ${new Date(report.generatedAt).toLocaleString()}`),
    el('p','',tr('当前库存参与规模统计；旧计时账本与旧报告不读取、不回填。专注钟和日记不参与。','Current content is counted as inventory. Legacy ledgers and reports are neither read nor backfilled. Focus clocks and diaries are excluded.')));
  const statuses={available:tr('已读取','Read'),empty:tr('来源为空','Empty source'),partial:tr('部分读取','Partially read'),unavailable:tr('未能读取','Unreadable'),disabled:tr('功能未启用','Feature disabled')};
  const sources=el('ul','career-coverage-list');report.sources.forEach(source=>sources.append(el('li','',`${label(source.id)} · ${statuses[source.status]||source.status} · ${tr('未读取','Skipped')} ${number(source.skipped)}`)));rangePanel.append(sources);
  const periods=el('details','career-details');periods.append(el('summary','',tr('分类记录开关历史','Collection setting history')));
  const list=el('ul');for(const category of Object.keys(categories)){const policies=prepared.policies.get(category)||[];policies.forEach((p,i)=>list.append(el('li','',`${label(category)} · ${new Date(p.at).toLocaleString()} — ${new Date(policies[i+1]?.at??report.history.cutoff).toLocaleString()} · ${p.enabled?tr('采集开启','Collection on'):tr('未采集','Not collected')}`)));}periods.append(list);rangePanel.append(periods);
  const regenerate=el('button','career-regenerate',tr('重新生成报告','Generate a fresh report'));regenerate.type='button';regenerate.dataset.careerAction='generate';regenerate.addEventListener('click',actions.generate);rangePanel.append(regenerate);rangeChapter.grid.append(rangePanel);
  const end=el('footer','career-end');end.append(el('p','career-kicker','RELATUM · CAREER'));shell.append(end);
  const changingMetrics=['usage','active-days','longest-streak'].map(key=>hero.querySelector(`[data-metric-key="${key}"]`));
  function updateFilter(filter) {
    const previousFilter=context.filter,previousData=data;
    context.filter=filter;data=select(report,filter);context.data=data;
    for(const button of segments.children){const pressed=String(button.dataset.mode===filter.mode);if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);}
    if(year.hidden!==(filter.mode!=='year'))year.hidden=filter.mode!=='year';if(year.value!==String(filter.year||lastYear))year.value=String(filter.year||lastYear);if(range.hidden!==(filter.mode!=='custom'))range.hidden=filter.mode!=='custom';
    if(previousFilter.mode!=='custom'){from.value=filter.start||data.start;to.value=filter.end||data.end;}
    if(data===previousData)return [];
    rangeCaption();
    updateArchivedSummary();
    [data.seconds,data.activeDays,data.longest].forEach((value,i)=>{
      const node=changingMetrics[i],format=i===0?metricDuration(value):metricNumber;
      if(node.dataset.careerNumber===String(value))return;
      node.dataset.careerNumber=String(value);node._format=format;
      if(node._numberText){node.querySelector('.career-number-reserve').textContent=format(value);node._numberText.data=format(node.dataset.counted==='1'?value:0);}
      else node.textContent=format(value);
    });
    const changed=[];
    for(const record of charts){
      if(record.spec.inventory)continue;
      const spec=record.spec,key=spec.key;
      if(['note-use','canvas-use','embedded-use','research-use','canvas-months'].includes(key)&&data.entityDays===previousData.entityDays)continue;
      if(['weekday','hours'].includes(key)&&data.hours===previousData.hours)continue;
      if(['events','event-categories'].includes(key)&&data.events===previousData.events)continue;
      if(['daily','heatmap','composition'].includes(key))spec.rows=data.days;
      else if(key==='note-use')spec.rows=data.rankings('notes');
      else if(key==='canvas-use')spec.rows=data.rankings('canvas');
      else if(key==='embedded-use')spec.rows=data.rankings('embedded');
      else if(key==='research-use')spec.rows=data.rankings('research');
      else if(key==='weekday')spec.rows=data.weekdays.map((value,i)=>({name:spec.rows[i].name,value:value/3600}));
      else if(key==='hours')spec.rows=data.hourTotals.map((value,i)=>({name:String(i).padStart(2,'0'),value:value/3600}));
      else if(key==='events')spec.rows=eventKinds.map((kind,i)=>({name:eventNames[i],value:data.eventKinds.get(kind)||0}));
      else if(key==='event-categories')spec.rows=Object.keys(categories).map(name=>({name:label(name),value:data.eventCategories.get(name)||0}));
      else if(key==='event-trend')spec.rows=data.eventDays;
      record.minHeight=chartHeight(spec);
      previewHeight(record.host,spec);
      if(record.host.dataset.mounted==='0'){delete record.host.dataset.measured;if(record.host.style.minHeight!==record.minHeight)record.host.style.minHeight=record.minHeight;}
      changed.push(record);
    }
    updateTimeline();
    return changed;
  }
  return {shell,charts,updateFilter};
}

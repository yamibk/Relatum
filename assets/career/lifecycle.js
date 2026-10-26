import { el, tr, request, select, en } from './data.js';
import { buildReport } from './chapters.js';
import { mountChart } from './charts.js';
import { scheduler, scrolling, animateNumbers, numberMotion } from './motion.js';

export function createCareer(onReport) {
  const root=document.querySelector('.career-workspace'), scroll=root.querySelector('[data-role="career-scroll"]'),
    host=root.querySelector('[data-role="career-report"]'),entry=root.querySelector('[data-role="career-entry"]'),loading=root.querySelector('[data-role="career-loading"]');
  const schedule=scheduler(), context={scheduler:schedule,filter:{mode:'all'},graphViews:new Map(),legendState:new Map(),detailsState:new Map(),presented:new Set(),countedNumbers:new Set(),heatmapYear:null};
  let report=null, initialized=null, active=false, sequence=0, charts=[], observer=null, graphObserver=null, viewportObserver=null,interactionAbort=null,renderVersion=0, reportVersion=0, job=null, generating=false, pollController=null, css=null, scroller=null;
  const mounted=new Map();
  const finishNumbers=new Set();
  const pendingReveals=new Map();
  let entrance=null, numberStartAt=0, generationState=null;
  let view=null,refreshCharts=null,renderLanguage=null,renderTheme=document.body.dataset.startTheme,suspended=true,sizingWidth=0,observationVersion=0;
  const visible=()=>active&&(!document.body.dataset.startWorkspace||document.body.dataset.startWorkspace==='career')&&!document.hidden&&document.documentElement.dataset.desktopMinimized!=='1'&&!root.hidden;
  function styles() {
    if(!css)css=new Promise((resolve,reject)=>{const link=el('link');link.rel='stylesheet';link.href='career/report.css';link.onload=resolve;link.onerror=()=>{link.remove();css=null;reject(new Error(tr('生涯样式未能加载','Career styles could not load')));};document.head.append(link);});
    return css;
  }
  function message(error=false,text='') {
    let box=root.querySelector('[data-career-message]');if(!box){box=el('p','career-inline-error');box.dataset.careerMessage='1';loading.after(box);}
    box.hidden=!text;box.textContent=text;box.classList.toggle('is-error',error);
  }
  function syncEntry() {
    entry.hidden=!!report;
    entry.querySelector('h1').textContent=tr('使用报告','Usage report');
    entry.querySelector('p:not(.career-kicker)').textContent=tr('查看使用时长、内容规模和完成记录。','View usage time, content size and completed activities.');
    entry.querySelector('button').textContent=tr('生成报告','Generate report');
    const disabled=!!job||generating;
    root.querySelectorAll('[data-career-action="generate"]').forEach(button=>{if(button.disabled!==disabled)button.disabled=disabled;});
  }
  function pause() {
    suspended=true;refreshCharts=null;observationVersion++;
    entrance?.cancel();entrance=null;scroll.style.removeProperty('opacity');
    sequence++;observer?.disconnect();observer=null;graphObserver?.disconnect();graphObserver=null;viewportObserver?.disconnect();viewportObserver=null;interactionAbort?.abort();interactionAbort=null;
    for(const timer of pendingReveals.values())clearTimeout(timer);pendingReveals.clear();
    for(const runtime of mounted.values())runtime.pause?.();
    context.tooltip?.hide();
    for(const finish of finishNumbers)finish();finishNumbers.clear();
    schedule.stop();scroller?.destroy();scroller=null;
    pollController?.abort();pollController=null;
    loading.hidden=true;
  }
  function stop() {
    pause();
    for(const [target,runtime] of mounted){runtime.destroy();target.dataset.mounted='0';}mounted.clear();
    context.tooltip?.destroy();context.tooltip=null;
  }
  function anchor() {
    const top=scroll.scrollTop, chapters=[...host.querySelectorAll('[data-chapter]')];
    let found=chapters[0];for(const node of chapters)if(node.offsetTop<=top+100)found=node;
    return {id:found?.dataset.chapter,offset:found?top-found.offsetTop:top,top};
  }
  function restore(saved) {
    if(!saved)return;
    const node=host.querySelector(`[data-chapter="${saved.id}"]`);scroll.scrollTop=node?node.offsetTop+saved.offset:saved.top;
    scroller?.measure();
  }
  function fadeContent() {
    entrance?.cancel();entrance=null;
    numberStartAt=performance.now()+numberMotion.entranceDelay;
    scroll.style.removeProperty('opacity');
    if(visible()&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&typeof scroll.animate==='function'){
      const animation=scroll.animate([{opacity:0},{opacity:1}],{duration:600,easing:'ease-out'});
      entrance=animation;animation.finished.then(()=>{if(entrance===animation)entrance=null;},()=>{});
    }
  }
  function beginGeneration() {
    generationState={anchor:anchor()};
    root.classList.add('is-generating');root.setAttribute('aria-busy','true');scroll.inert=true;
    pause();scroll.scrollTop=0;numberStartAt=Infinity;
  }
  function endGeneration() {
    const saved=generationState?.anchor;generationState=null;
    root.classList.remove('is-generating');root.removeAttribute('aria-busy');scroll.inert=false;
    loading.hidden=true;
    return saved;
  }
  function generationFailed(error) {
    job=null;const saved=endGeneration();
    message(true,error);syncEntry();
    if(visible())resume();restore(saved);
    if(visible())fadeContent();
  }
  function observe() {
    if(!visible()||!report||generationState||observer)return;
    suspended=false;
    resetSizing();
    schedule.start();scroller?.destroy();scroller=scrolling(scroll,schedule,visible);
    const version=renderVersion,observation=observationVersion;
    const current=()=>visible()&&!generationState&&version===renderVersion&&observation===observationVersion;
    const visualRecords=new Map(),inView=new Set();
    function mount(record) {
      if(!current())return;
      let runtime=mounted.get(record.host);
      if(runtime)runtime.resume?.();else{record.host.style.minHeight=record.minHeight;runtime=mountChart(record.host,record.spec,context);mounted.set(record.host,runtime);record.host.dataset.mounted='1';}
      reveal(record.panel);
      const target=runtime.target||record.host;visualRecords.set(target,record);if(viewportObserver)viewportObserver.observe(target);else enterChart(target,record);
    }
    function unmount(record,height){
      const runtime=mounted.get(record.host);if(!runtime)return;
      const target=runtime.target||record.host;viewportObserver?.unobserve(target);visualRecords.delete(target);inView.delete(target);clearTimeout(pendingReveals.get(target));pendingReveals.delete(target);
      record.host.style.minHeight=Math.ceil(height)+'px';
      record.host.dataset.measured='1';
      runtime.destroy();mounted.delete(record.host);record.host.dataset.mounted='0';
    }
    const lookup=new Map(charts.map(r=>[r.host,r]));
    function prepare(entries){
      // Measure removals together before any mount/destroy can invalidate layout.
      const leaving=[];
      for(const item of entries)if(!item.isIntersecting&&mounted.has(item.target))leaving.push({record:lookup.get(item.target),height:item.target.getBoundingClientRect().height});
      for(const item of leaving)unmount(item.record,item.height);
      for(const item of entries){const record=lookup.get(item.target);if(!record){if(item.isIntersecting)reveal(item.target);else{clearTimeout(pendingReveals.get(item.target));pendingReveals.delete(item.target);}}else if(item.isIntersecting)mount(record);}
    }
    const reveals=[...host.querySelectorAll('.career-section-head,.career-panel')];
    const numbers=[...host.querySelectorAll('[data-career-number]:not([data-counted])')];
    function enterNumber(node){
      if(node.dataset.counted==='1'||pendingReveals.has(node))return;
      const check=()=>{pendingReveals.delete(node);if(!current()||!inView.has(node))return;
        const delay=Math.min(numberMotion.entranceDelay,Math.max(0,numberStartAt-performance.now()));
        if(scroller?.revealPaused||delay>0){pendingReveals.set(node,setTimeout(check,scroller?.revealPaused?80:delay));return;}
        context.countedNumbers.add(node.dataset.metricKey);
        finishNumbers.add(animateNumbers(node,schedule,()=>scroller?.revealPaused));
      };check();
    }
    function enterChart(target,record){
      if(inView.has(target)||pendingReveals.has(target))return;
      inView.add(target);
      const check=()=>{pendingReveals.delete(target);if(!current()||!inView.has(target))return;
        if(scroller?.revealPaused){pendingReveals.set(target,setTimeout(check,80));return;}
        const runtime=mounted.get(record.host);if(!runtime)return;const first=!context.presented.has(record.spec.key);runtime.enter?.(first);context.presented.add(record.spec.key);
      };check();
    }
    function reveal(node){
      if(node.dataset.visible==='1'||pendingReveals.has(node))return;
      const check=()=>{pendingReveals.delete(node);if(!current())return;
        if(scroller?.revealPaused){pendingReveals.set(node,setTimeout(check,80));return;}
        node.dataset.visible='1';};check();
    }
    if('IntersectionObserver' in window){
      viewportObserver=new IntersectionObserver(entries=>{if(!current())return;
        for(const item of entries){const record=visualRecords.get(item.target);if(record){if(item.isIntersecting&&item.intersectionRatio>=.06)enterChart(item.target,record);else if(!item.isIntersecting){inView.delete(item.target);clearTimeout(pendingReveals.get(item.target));pendingReveals.delete(item.target);mounted.get(record.host)?.leave?.();}}
          else if(item.target.matches('[data-career-number]')){
            if(item.isIntersecting&&item.intersectionRatio>=numberMotion.visibleRatio){inView.add(item.target);enterNumber(item.target);}
            else{inView.delete(item.target);clearTimeout(pendingReveals.get(item.target));pendingReveals.delete(item.target);}
          }
        }
      },{root:scroll,threshold:[0,.06,numberMotion.visibleRatio]});numbers.forEach(node=>viewportObserver.observe(node));
      observer=new IntersectionObserver(entries=>{if(!current())return;
        prepare(entries);
      },{root:scroll,rootMargin:'240px 0px',threshold:0});charts.filter(r=>r.spec.type!=='graph').forEach(r=>observer.observe(r.host));reveals.forEach(node=>observer.observe(node));
      // Start graph loading and layout ahead of the viewport, including during continuous scrolling.
      const graphMargin=Math.round(Math.max(900,Math.min(1800,scroll.clientHeight*1.25)));
      graphObserver=new IntersectionObserver(entries=>{if(!current())return;
        prepare(entries);
      },{root:scroll,rootMargin:`${graphMargin}px 0px`,threshold:0});charts.filter(r=>r.spec.type==='graph').forEach(r=>graphObserver.observe(r.host));
      for(const record of charts)if(mounted.has(record.host))mount(record);
    }else{charts.forEach(mount);reveals.forEach(reveal);numbers.forEach(node=>{inView.add(node);enterNumber(node);});}
    refreshCharts=records=>{
      if(!current())return;
      const replacing=records.filter(record=>mounted.has(record.host)).map(record=>({record,height:record.host.getBoundingClientRect().height}));
      for(const item of replacing)unmount(item.record,item.height);
      for(const item of replacing)mount(item.record);
    };
    interactionAbort=new AbortController();
    const clearInteraction=()=>{for(const runtime of mounted.values())runtime.clearInteraction?.();context.tooltip?.hide();};
    scroll.addEventListener('scroll',clearInteraction,{passive:true,signal:interactionAbort.signal});window.addEventListener('blur',clearInteraction,{signal:interactionAbort.signal});window.addEventListener('resize',()=>{clearInteraction();resetSizing();},{signal:interactionAbort.signal});
  }
  function resetSizing(){
    const width=scroll.clientWidth;if(width===sizingWidth)return;sizingWidth=width;
    for(const record of charts)if(!mounted.has(record.host)){delete record.host.dataset.measured;record.host.style.minHeight=record.minHeight;}
  }
  function render(keepAnchor=true,resetPresentation=false) {
    if(!visible()||!report||generationState)return;
    const saved=keepAnchor?anchor():null;
    stop();active=true;schedule.start();renderVersion++;
    if(resetPresentation){context.graphViews.clear();context.presented.clear();context.countedNumbers.clear();context.detailsState.clear();}
    const built=buildReport(report,context,{filter:updateFilter,generate});view=built;renderLanguage=en();renderTheme=document.body.dataset.startTheme;charts=built.charts;host.replaceChildren(built.shell);host.hidden=false;entry.hidden=true;loading.hidden=true;
    if(!keepAnchor)scroll.scrollTop=0;
    observe();restore(saved);syncEntry();if(job)poll(job);
  }
  function updateFilter(value){
    if(!visible()||generationState||!view||['mode','year','start','end'].every(key=>String(value[key]||'')===String(context.filter[key]||'')))return;
    const changesData=select(report,value)!==context.data,saved=changesData?anchor():null;
    if(changesData){context.tooltip?.hide();for(const finish of finishNumbers)finish();finishNumbers.clear();}
    const changed=view.updateFilter(value);refreshCharts?.(changed);
    if(saved)restore(saved);
  }
  async function preload() {
    if(!initialized)initialized=(async()=>{const version=reportVersion,result=await request('/api/career/report');if(version!==reportVersion)return report;report=result.exists?result.report:null;if(result.job)job=result.job;if(result.error)message(true,result.code==='archive-report-pending'?tr('归档完成，生涯报告待重新生成', 'Archiving is complete. Regenerate the career report.'):result.error);onReport(report);return report;})().catch(error=>{initialized=null;throw error;});
    return initialized;
  }
  function invalidateArchive(value={}) {
    if(report && Number(value.archiveRevision||0)<=Number(report.history.archiveRevision||0))return;
    stop();reportVersion++;initialized=null;report=null;onReport(null);host.replaceChildren();host.hidden=true;charts=[];view=null;
    context.data=null;context.graphViews.clear();context.presented.clear();context.countedNumbers.clear();context.detailsState.clear();
    job=value.job||null;generating=false;generationState=null;root.classList.remove('is-generating');root.removeAttribute('aria-busy');scroll.inert=false;
    syncEntry();
    if(visible())activate().catch(error=>message(true,error.message));
  }
  async function checkArchive() {
    const version=reportVersion;
    try{const state=await request('/api/usage/management');if(version===reportVersion&&report&&state.archiveRevision>Number(report.history.archiveRevision||0)){invalidateArchive(state);return true;}}catch(_){}
    return false;
  }
  document.addEventListener('relatum:usage-archived',event=>invalidateArchive(event.detail));
  window.addEventListener('storage',event=>{if(event.key==='canvas:usageArchiveRevision:v1')invalidateArchive({archiveRevision:Number(event.newValue)});});
  async function activate() {
    active=true;const own=++sequence;
    entrance?.cancel();entrance=null;scroll.style.opacity='0';
    if(await checkArchive())return;
    await styles();await preload();
    if(!visible()||own!==sequence)return;
    if(job&&!report&&!generationState)beginGeneration();
    if(generationState){syncEntry();scroll.scrollTop=0;scroll.style.removeProperty('opacity');if(job)poll(job);return;}
    numberStartAt=Infinity;
    syncEntry();if(report){if(!host.childElementCount)render(false);else if(renderLanguage!==en())render(true);else{syncTheme();observe();}}
    // Start the delay with the visible fade, after report construction/layout.
    fadeContent();
    if(job)poll(job);
  }
  function waiting(ms,signal) {
    return new Promise((resolve,reject)=>{const timer=setTimeout(finish,ms);function finish(){signal.removeEventListener('abort',cancel);resolve();}function cancel(){clearTimeout(timer);reject(new DOMException('Hidden','AbortError'));}signal.addEventListener('abort',cancel,{once:true});});
  }
  function progress(value) {
    loading.hidden=false;loading.classList.toggle('is-regenerating',!!report);
    const names={usage:tr('冻结使用记录','Freezing usage history'),notes:tr('统计笔记与真实关系','Counting notes and relationships'),canvas:tr('统计主画布与内嵌文件','Counting canvases and embedded files'),research:tr('读取研究结构','Reading research structures'),learning:tr('统计学习与习惯','Counting learning and habits'),snapshot:tr('保存新冻结快照','Saving the new snapshot')};
    loading.querySelector('strong').textContent=tr('正在生成报告','Generating your report');loading.querySelector('p').textContent=`${value.progress}% · ${names[value.stage]||''}`;
    root.querySelectorAll('[data-career-action="generate"]').forEach(b=>{b.disabled=true;});
  }
  async function poll(initial) {
    if(!visible()||pollController)return;
    const controller=new AbortController();pollController=controller;
    try {
      let current=initial;
      while(visible()&&!controller.signal.aborted){
        if(current.status==='complete'){
          const result=await request('/api/career/report',{signal:controller.signal});
          if(controller.signal.aborted||!visible())return;
          if(!result.report)throw new Error(tr('新报告未能加载，请重试。','The new report could not load. Please try again.'));
          report=result.report;reportVersion++;onReport(report);initialized=Promise.resolve(report);job=null;
          endGeneration();numberStartAt=Infinity;render(false,true);message(false,'');fadeContent();return;
        }
        if(current.status==='error')throw new Error(current.code==='archive-report-pending'?tr('归档完成，生涯报告待重新生成','Archiving is complete. Regenerate the career report.'):current.error);
        progress(current);await waiting(500,controller.signal);
        const next=await request('/api/career/jobs/'+initial.id,{signal:controller.signal});
        if(controller.signal.aborted||!visible())return;
        current=next;job=current;
      }
    }catch(error){if(error.name!=='AbortError'&&!controller.signal.aborted)generationFailed(error.message);}
    finally{if(pollController===controller)pollController=null;}
  }
  async function generate() {
    if(job||generating||generationState)return;
    generating=true;beginGeneration();syncEntry();
    message(false,tr('正在提交尚未写入的使用记录…','Flushing pending usage records…'));
    try {
      await window.RelatumUsage?.flush();
      job=await request('/api/career/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      message(false,'');syncEntry();poll(job);
    }catch(error){generationFailed(tr('未能生成报告：','Could not generate report: ')+error.message);}
    finally{generating=false;syncEntry();}
  }
  entry.querySelector('button').addEventListener('click',generate);
  function syncTheme(){
    if(generationState||renderTheme===document.body.dataset.startTheme)return;
    renderTheme=document.body.dataset.startTheme;context.tooltip?.hide();
    for(const runtime of mounted.values())runtime.refreshTheme?.();
  }
  function resume(){if(!visible())return;if(!report&&!initialized){activate().catch(error=>message(true,error.message));return;}checkArchive();if(generationState){syncEntry();if(job)poll(job);return;}if(report&&renderLanguage!==en())render(true);else{syncTheme();observe();}if(job)poll(job);}
  document.addEventListener('relatum:start-workspacechange',event=>{active=event.detail.workspace==='career';if(!active){if(root.hidden)stop();else if(!suspended)pause();}else resume();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else resume();});
  window.addEventListener('canvasdesktop:visibility',()=>{if(!visible())stop();else resume();});
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener('change',()=>{
    if(!reducedMotion.matches)return;
    entrance?.cancel();entrance=null;scroll.style.removeProperty('opacity');
    if(generationState)return;
    for(const finish of finishNumbers)finish();finishNumbers.clear();
    host.querySelectorAll('[data-career-number]:not([data-counted])').forEach(node=>{
      clearTimeout(pendingReveals.get(node));pendingReveals.delete(node);
      context.countedNumbers.add(node.dataset.metricKey);animateNumbers(node,schedule,()=>false);
    });
  });
  document.addEventListener('relatum:languagechange',()=>{if(visible()&&report)render(true);else syncEntry();});
  // The shared shell publishes its state before awaiting the next workspace.
  // Freeze during its visible exit, then release at the actual hidden boundary.
  const theme=new MutationObserver(records=>{
    if(records.some(record=>record.attributeName==='data-start-workspace')){
      if(!visible()){if(root.hidden)stop();else if(!suspended)pause();}else if(suspended)resume();
    }
    if(records.some(record=>record.attributeName==='data-start-theme')&&visible())syncTheme();
  });theme.observe(document.body,{attributes:true,attributeFilter:['data-start-theme','data-start-workspace']});
  const panelVisibility=new MutationObserver(()=>{if(root.hidden)stop();else if(suspended)resume();});panelVisibility.observe(root,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('pagehide',()=>{stop();context.graphViews.clear();});
  window.addEventListener('pageshow',resume);
  return {activate,preload,generate,get report(){return report;}};
}

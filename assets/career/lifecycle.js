import { el, tr, request } from './data.js';
import { buildReport } from './chapters.js';
import { mountChart } from './charts.js';
import { scheduler, scrolling, animateNumbers } from './motion.js';

export function createCareer(onReport) {
  const root=document.querySelector('.career-workspace'), scroll=root.querySelector('[data-role="career-scroll"]'),
    host=root.querySelector('[data-role="career-report"]'),entry=root.querySelector('[data-role="career-entry"]'),loading=root.querySelector('[data-role="career-loading"]');
  const schedule=scheduler(), context={scheduler:schedule,filter:{mode:'all'},graphViews:new Map(),legendState:new Map(),heatmapYear:null};
  let report=null, initialized=null, active=false, sequence=0, charts=[], observer=null, renderVersion=0, reportVersion=0, job=null, generating=false, pollController=null, css=null, scroller=null;
  const mounted=new Map();
  const finishNumbers=new Set();
  const pendingGraphs=new Map();
  const pendingReveals=new Map();
  let entrance=null;
  const visible=()=>active&&!document.hidden&&document.documentElement.dataset.desktopMinimized!=='1'&&!root.hidden;
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
    entry.querySelector('button').disabled=!!job||generating;
  }
  function stop() {
    entrance?.cancel();entrance=null;scroll.style.removeProperty('opacity');
    sequence++;observer?.disconnect();observer=null;
    for(const timer of pendingGraphs.values())clearTimeout(timer);pendingGraphs.clear();
    for(const timer of pendingReveals.values())clearTimeout(timer);pendingReveals.clear();
    for(const [target,runtime] of mounted){runtime.destroy();target.dataset.mounted='0';}mounted.clear();
    for(const finish of finishNumbers)finish();finishNumbers.clear();
    schedule.stop();scroller?.destroy();scroller=null;
    pollController?.abort();pollController=null;
    loading.hidden=true;
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
  function observe() {
    if(!visible()||!report||observer)return;
    schedule.start();scroller?.destroy();scroller=scrolling(scroll,schedule,visible);
    const version=renderVersion;
    function mount(record) {
      if(!visible()||version!==renderVersion||mounted.has(record.host))return;
      const runtime=mountChart(record.host,record.spec,context);mounted.set(record.host,runtime);record.host.dataset.mounted='1';reveal(record.panel);record.panel.classList.add('career-entered');
    }
    function near(record){
      if(record.spec.type!=='graph'){mount(record);return;}
      if(mounted.has(record.host)||pendingGraphs.has(record.host))return;
      const check=()=>{pendingGraphs.delete(record.host);if(!visible()||version!==renderVersion)return;
        if(scroller?.isScrolling){pendingGraphs.set(record.host,setTimeout(check,80));return;}mount(record);};
      pendingGraphs.set(record.host,setTimeout(check,80));
    }
    const lookup=new Map(charts.map(r=>[r.host,r]));
    const reveals=[...host.querySelectorAll('.career-section-head,.career-panel,[data-career-number]')];
    function reveal(node){
      if(node.dataset.visible==='1'||pendingReveals.has(node))return;
      const check=()=>{pendingReveals.delete(node);if(!visible()||version!==renderVersion)return;
        if(scroller?.revealPaused){pendingReveals.set(node,setTimeout(check,80));return;}
        node.dataset.visible='1';if(node.matches('[data-career-number]'))finishNumbers.add(animateNumbers(node,schedule,()=>scroller?.revealPaused));};check();
    }
    if('IntersectionObserver' in window){
      observer=new IntersectionObserver(entries=>{if(!visible()||version!==renderVersion)return;
        for(const item of entries){const record=lookup.get(item.target);if(!record){if(item.isIntersecting)reveal(item.target);else{clearTimeout(pendingReveals.get(item.target));pendingReveals.delete(item.target);}continue;}if(item.isIntersecting)near(record);else{clearTimeout(pendingGraphs.get(item.target));pendingGraphs.delete(item.target);if(mounted.has(item.target)){item.target.style.minHeight=Math.ceil(item.target.getBoundingClientRect().height)+'px';mounted.get(item.target).destroy();mounted.delete(item.target);item.target.dataset.mounted='0';}}}
      },{root:scroll,rootMargin:'240px 0px',threshold:0});charts.forEach(r=>observer.observe(r.host));reveals.forEach(node=>observer.observe(node));
    }else{charts.forEach(mount);reveals.forEach(reveal);}
  }
  function render(keepAnchor=true) {
    if(!visible()||!report)return;
    const saved=keepAnchor?anchor():null;
    stop();active=true;schedule.start();renderVersion++;
    const built=buildReport(report,context,{filter(value){context.filter=value;render(true);},generate});charts=built.charts;host.replaceChildren(built.shell);host.hidden=false;entry.hidden=true;loading.hidden=true;
    observe();restore(saved);syncEntry();if(job)poll(job);
  }
  async function preload() {
    if(!initialized)initialized=(async()=>{const version=reportVersion,result=await request('/api/career/report');if(version!==reportVersion)return report;report=result.exists?result.report:null;if(result.error)message(true,result.error);onReport(report);return report;})().catch(error=>{initialized=null;throw error;});
    return initialized;
  }
  async function activate() {
    active=true;const own=++sequence;
    entrance?.cancel();entrance=null;scroll.style.opacity='0';
    await styles();await preload();
    if(!active||own!==sequence||document.hidden)return;
    syncEntry();if(report){if(!host.childElementCount)render(false);else observe();}
    scroll.style.removeProperty('opacity');
    if(visible()&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&typeof scroll.animate==='function'){
      const animation=scroll.animate([{opacity:0},{opacity:1}],{duration:600,easing:'ease-out'});
      entrance=animation;animation.finished.then(()=>{if(entrance===animation)entrance=null;},()=>{});
    }
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
          const saved=anchor();report=result.report;reportVersion++;onReport(report);initialized=Promise.resolve(report);job=null;context.graphViews.clear();render(false);restore(saved);message(false,'');return;
        }
        if(current.status==='error')throw new Error(current.error);
        progress(current);await waiting(500,controller.signal);
        current=await request('/api/career/jobs/'+initial.id,{signal:controller.signal});job=current;
      }
    }catch(error){if(error.name!=='AbortError'){job=null;message(true,error.message);loading.hidden=true;syncEntry();root.querySelectorAll('[data-career-action="generate"]').forEach(b=>{b.disabled=false;});}}
    finally{if(pollController===controller)pollController=null;}
  }
  async function generate() {
    if(job||generating)return;
    generating=true;syncEntry();
    message(false,tr('正在提交尚未写入的使用记录…','Flushing pending usage records…'));
    try {
      await window.RelatumUsage?.flush();
      job=await request('/api/career/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      message(false,'');syncEntry();poll(job);
    }catch(error){message(true,tr('未能生成报告：','Could not generate report: ')+error.message);}
    finally{generating=false;syncEntry();}
  }
  entry.querySelector('button').addEventListener('click',generate);
  document.addEventListener('relatum:start-workspacechange',event=>{active=event.detail.workspace==='career';if(!active)stop();else if(report){if(!host.childElementCount)render(false);else if(!observer)observe();}if(active&&job)poll(job);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(active){observe();if(job)poll(job);}});
  window.addEventListener('canvasdesktop:visibility',()=>{if(!visible())stop();else{observe();if(job)poll(job);}});
  document.addEventListener('relatum:languagechange',()=>{if(visible()&&report)render(true);else syncEntry();});
  const theme=new MutationObserver(()=>{if(visible()&&report)render(true);});theme.observe(document.body,{attributes:true,attributeFilter:['data-start-theme']});
  window.addEventListener('pagehide',()=>{stop();context.graphViews.clear();});
  window.addEventListener('pageshow',()=>{if(visible()){observe();if(job)poll(job);}});
  return {activate,preload,generate,get report(){return report;}};
}

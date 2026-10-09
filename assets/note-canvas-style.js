// Lightweight sidebar/schema. No canvas renderer, file requests or editor state.
(function () {
  'use strict';
  const KEY = 'canvas:noteCanvasDefaults:v1';
  const shapes = [
    ['rect', '矩形', 'Rectangle'], ['rounded-rect', '圆角矩形', 'Rounded rectangle'],
    ['square', '正方形', 'Square'], ['circle', '圆形', 'Circle'], ['ellipse', '椭圆', 'Ellipse'],
    ['diamond', '菱形', 'Diamond'], ['triangle', '三角形', 'Triangle'], ['hexagon', '六边形', 'Hexagon'],
    ['parallelogram', '平行四边形', 'Parallelogram'], ['trapezoid', '梯形', 'Trapezoid'],
    ['pill', '胶囊', 'Capsule'], ['cylinder', '圆柱', 'Cylinder']
  ];
  const defaults = {
    node: { shape: 'rounded-rect', width: 160, height: 48, radius: 8, bgColor: '', bgOpacity: 1,
      hideBackground: false, borderColor: '', borderWidth: 1, paddingX: 12, paddingY: 10, autoHeight: true },
    nodeText: { fontSize: 16, color: '', fontWeight: 400, lineHeight: 1.4, wrap: true, textAlign: 'left', verticalAlign: 'top' },
    edge: { curve: 'straight', lineStyle: 'solid', color: '', width: 1.6, arrowStart: false, arrowEnd: true,
      arrowSize: 9, fromSide: 'auto', toSide: 'auto', cornerRadius: 18, labelPosition: .5, labelOffsetX: 0, labelOffsetY: 0 },
    edgeText: { fontSize: 13, color: '', fontWeight: 400, lineHeight: 1.4, wrap: true,
      textAlign: 'center', verticalAlign: 'center', width: 0, height: 0 }
  };
  const align = [['left', '左', 'Left'], ['center', '中', 'Center'], ['right', '右', 'Right']];
  const vertical = [['top', '上', 'Top'], ['center', '中', 'Middle'], ['bottom', '下', 'Bottom']];
  const sides = [['auto', '自动', 'Automatic'], ['top', '上', 'Top'], ['right', '右', 'Right'], ['bottom', '下', 'Bottom'], ['left', '左', 'Left']];
  const field = (key, zh, en, type, a, b, step) => ({ key, zh, en, type, min: a, max: b, step });
  const textFields = [field('fontSize', '字号', 'Font size', 'number', 8, 120, 1), field('color', '文字颜色', 'Text color', 'color'),
    field('fontWeight', '字重', 'Weight', 'range', 100, 900, 10), field('lineHeight', '行距', 'Line height', 'number', .8, 3, .1),
    field('wrap', '自动换行', 'Wrap text', 'checkbox'), { ...field('textAlign', '水平对齐', 'Horizontal alignment', 'select'), options: align },
    { ...field('verticalAlign', '垂直对齐', 'Vertical alignment', 'select'), options: vertical }];
  const fields = {
    node: [{ ...field('shape', '形状', 'Shape', 'shapes'), options: shapes },
      field('width', '宽度', 'Width', 'number', 24, 6000, 1), field('height', '高度', 'Height', 'number', 24, 6000, 1),
      field('autoHeight', '自动撑高', 'Auto height', 'checkbox'), field('paddingX', '水平内边距', 'Horizontal padding', 'number', 0, 80, 1),
      field('paddingY', '垂直内边距', 'Vertical padding', 'number', 0, 80, 1), field('radius', '圆角', 'Corner radius', 'range', 0, 80, 1),
      field('bgColor', '背景颜色', 'Fill color', 'color'), field('bgOpacity', '背景透明度', 'Fill opacity', 'range', 0, 1, .05),
      field('hideBackground', '隐藏背景', 'Hide fill', 'checkbox'), field('borderColor', '边框颜色', 'Border color', 'color'),
      field('borderWidth', '边框粗细', 'Border width', 'number', 0, 12, .5)],
    nodeText: textFields,
    edge: [{ ...field('curve', '路径', 'Path', 'select'), options: [['straight', '直线', 'Straight'], ['bezier', '贝塞尔曲线', 'Bezier'],
      ['smooth', '平滑曲线', 'Smooth'], ['elbow', '折线', 'Orthogonal'], ['rounded-elbow', '圆角折线', 'Rounded orthogonal']] },
      field('cornerRadius', '拐角半径', 'Bend radius', 'range', 0, 80, 1),
      { ...field('lineStyle', '线条样式', 'Line style', 'select'), options: [['solid', '实线', 'Solid'], ['dashed', '虚线', 'Dashed'], ['dotted', '点线', 'Dotted']] },
      field('color', '线条颜色', 'Line color', 'color'), field('width', '线宽', 'Line width', 'number', .5, 12, .1),
      field('arrowStart', '起点箭头', 'Start arrow', 'checkbox'), field('arrowEnd', '终点箭头', 'End arrow', 'checkbox'),
      field('arrowSize', '箭头大小', 'Arrow size', 'range', 4, 40, 1),
      { ...field('fromSide', '起点连接', 'Source connection', 'select'), options: sides },
      { ...field('toSide', '终点连接', 'Target connection', 'select'), options: sides },
      field('labelPosition', '标注位置', 'Label position', 'range', 0, 1, .01),
      field('labelOffsetX', '标注水平偏移', 'Label horizontal offset', 'number', -6000, 6000, 1),
      field('labelOffsetY', '标注垂直偏移', 'Label vertical offset', 'number', -6000, 6000, 1)],
    edgeText: [...textFields, field('width', '标注宽度（0 为自动）', 'Label width (0 = auto)', 'number', 0, 6000, 1),
      field('height', '标注高度（0 为自动）', 'Label height (0 = auto)', 'number', 0, 6000, 1)]
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const polygonPoints = { diamond: [[.5,0],[1,.5],[.5,1],[0,.5]], triangle: [[.5,0],[1,1],[0,1]],
    hexagon: [[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]],
    parallelogram: [[.2,0],[1,0],[.8,1],[0,1]], trapezoid: [[.2,0],[.8,0],[1,1],[0,1]] };
  const english = () => window.RelatumI18n?.language === 'en' || document.documentElement.lang === 'en';
  const copy = (zh, en) => english() ? en : zh;
  function clean(kind, patch) {
    const result = {};
    fields[kind].forEach(f => {
      if (!Object.hasOwn(patch, f.key)) return;
      let value = patch[f.key];
      if (f.type === 'checkbox') { if (typeof value !== 'boolean') return; }
      else if (f.options) { if (!f.options.some(item => item[0] === value)) return; }
      else if (f.type === 'color') { if (typeof value !== 'string' || !/^(?:|#[\da-f]{6})$/i.test(value)) return; }
      else { if (typeof value !== 'number' || !Number.isFinite(value)) return; value = Math.max(f.min, Math.min(f.max, value)); }
      result[f.key] = value;
    });
    return result;
  }
  function readDefaults() {
    let stored; try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) {}
    return Object.fromEntries(Object.keys(defaults).map(kind => [kind, { ...defaults[kind], ...clean(kind, stored?.[kind] || {}) }]));
  }
  function values(kind, record) {
    const source = kind === 'edgeText' ? record.labelStyle || {} : record;
    const result = { ...defaults[kind], ...clean(kind, source) };
    if (kind === 'edge' && record.arrow !== undefined) {
      if (record.arrowStart === undefined) result.arrowStart = record.arrow === 'both';
      if (record.arrowEnd === undefined) result.arrowEnd = record.arrow !== 'none';
    }
    return result;
  }
  function polygon(shape, w, h) {
    const p = polygonPoints[shape];
    return p?.map(([x,y]) => ({ x: x*w, y: y*h }));
  }
  function outline(shape, w, h, radius) {
    const poly = polygon(shape, w, h);
    if (poly) return 'M ' + poly.map(p => p.x + ' ' + p.y).join(' L ') + ' Z';
    if (shape === 'circle' || shape === 'ellipse') return `M 0 ${h/2} A ${w/2} ${h/2} 0 1 0 ${w} ${h/2} A ${w/2} ${h/2} 0 1 0 0 ${h/2} Z`;
    if (shape === 'cylinder') {
      const r = Math.min(h*.16, w*.18);
      return `M 0 ${r} A ${w/2} ${r} 0 0 1 ${w} ${r} L ${w} ${h-r} A ${w/2} ${r} 0 0 1 0 ${h-r} Z`;
    }
    const r = Math.min(w/2, h/2, shape === 'pill' ? Math.min(w,h)/2 : shape === 'rounded-rect' ? radius : 0);
    if(!r) return `M 0 0 H ${w} V ${h} H 0 Z`;
    return `M ${r} 0 H ${w-r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h-r} A ${r} ${r} 0 0 1 ${w-r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h-r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  }
  function contains(shape, w, h, radius, x, y) {
    if (x < 0 || y < 0 || x > w || y > h) return false;
    const poly = polygonPoints[shape];
    if (poly) {
      x/=w;y/=h;
      let inside = false;
      for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
        const a=poly[i],b=poly[j];
        if ((a[1]>y)!==(b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
      }
      return inside;
    }
    if (shape === 'circle' || shape === 'ellipse') return ((x-w/2)/(w/2))**2 + ((y-h/2)/(h/2))**2 <= 1;
    if (shape === 'cylinder') {
      const r=Math.min(h*.16,w*.18);
      return y>=r && y<=h-r || ((x-w/2)/(w/2))**2 + ((y-(y<r?r:h-r))/r)**2 <= 1;
    }
    const r=Math.min(w/2,h/2,shape==='pill'?Math.min(w,h)/2:shape==='rounded-rect'?radius:0);
    if (!r) return true;
    const dx=Math.max(r-x,0,x-(w-r)),dy=Math.max(r-y,0,y-(h-r));
    return dx*dx+dy*dy<=r*r;
  }
  function inset(shape, w, h, radius) {
    let x=0,y=0,bottom;
    if (shape==='circle'||shape==='ellipse') { x=w*.147; y=h*.147; }
    else if (shape==='diamond') { x=w*.25; y=h*.25; }
    else if (shape==='triangle') { x=w*.26; y=h*.52; bottom=h*.06; }
    else if (shape==='hexagon') x=w*.25;
    else if (shape==='parallelogram'||shape==='trapezoid') x=w*.2;
    else if (shape==='cylinder') y=Math.min(h*.16,w*.18)*2;
    else if (shape==='pill') x=y=Math.min(w,h)*.147;
    else if (shape==='rounded-rect') x=y=Math.min(radius,w/2,h/2)*.293;
    return { x, y, w: Math.max(1,w-2*x), h: Math.max(1,h-y-(bottom??y)) };
  }
  function initPanel(host, resetScale) {
    if (!host || host.dataset.styleReady) return;
    host.dataset.styleReady='true';
    const groups = host.querySelector('[data-role="note-canvas-style-groups"]');
    groups.dataset.i18nManaged='true';
    const scale=host.querySelector('[data-role="note-canvas-default-scale"]');
    const resetDefaults=host.querySelector('[data-note-action="reset-canvas-settings"]');
    const panels=new Map();
    let defaultKind='node', subscribed=null, unsubscribe=null, pending=null, mode='', lastEngine=null, lastFocus=-1;
    let positionFrame=0, pendingPosition=null;
    const controls=[];
    const kindNames={ node:['节点','Nodes'], nodeText:['节点正文','Node text'], edge:['连线','Edges'], edgeText:['连线标注','Edge labels'] };
    function automaticColor(key, kind) {
      const dark=document.body.dataset.startTheme==='dark';
      if(key==='bgColor') return dark?'#202020':'#ffffff';
      if(key==='borderColor') return dark?'#bfbfbf':'#505050';
      return dark?(kind==='edge'?'#eeeeee':'#f1f1f1'):(kind==='nodeText'||kind==='edgeText'?'#242424':'#262626');
    }
    function choice(options, value, change) {
      const select=document.createElement('select');
      options.forEach(([key,zh,en])=>{ const opt=new Option(copy(zh,en),key); select.add(opt); });
      select.value=value; select.addEventListener('change',()=>change(select.value)); return select;
    }
    function apply(kind, patch, isDefault, token, final) {
      if (isDefault) {
        const d=readDefaults();if(token) {token.kind=kind;token.beforeDefault||=clone(d[kind]);}
        Object.assign(d[kind],clean(kind,patch)); try { localStorage.setItem(KEY,JSON.stringify(d)); } catch (_) {} refresh(); return;
      }
      const engine=window.RelatumNoteCanvas?.getActive();
      if (!engine) return;
      if(token && typeof token==='object') {
        if(token.cancelled) return;
        if(token.engine && (token.engine!==engine||token.version!==engine.getSelection().version)) {token.cancelled=true;refresh(true);return;}
        token.engine=engine;token.version=engine.getSelection().version;
      }
      const operation={engine,kind,patch,token,final}; pending=operation;
      engine.applySelectionStyle(kind,patch,{token,final}).then(()=>{ if(pending===operation) {pending=null;refresh(final===true&&!!token);} });
    }
    function usable(row) { return row.isConnected && !row.closest('[hidden]') && row.closest('[data-canvas-group]')?.dataset.canvasGroup===mode; }
    function addFields(parent, kind, isDefault, list=fields[kind]) {
      list.forEach(f=>{
        const row=document.createElement(f.type==='shapes'?'div':'label'); row.className='note-canvas-field'; row.dataset.field=f.key;
        const update=(patch,token,final)=>{if(usable(row)) apply(kind,patch,isDefault,token,final);};
        const title=document.createElement('span'); title.textContent=copy(f.zh,f.en); row.appendChild(title);
        let input, output, cancelRange;
        if(f.type==='shapes') {
          input=document.createElement('div'); input.className='note-canvas-shapes';input.setAttribute('role','group');
          shapes.forEach(([key,zh,en])=>{
            const button=document.createElement('button'); button.type='button'; button.dataset.shape=key;button.disabled=true;
            button.title=copy(zh,en); button.setAttribute('aria-label',button.title);
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','-2 -2 104 64');
            const path=document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',outline(key,key==='circle'||key==='square'?60:100,60,10));
            if(key==='circle'||key==='square') path.setAttribute('transform','translate(20 0)');
            svg.appendChild(path); button.appendChild(svg); input.appendChild(button);
            button.addEventListener('click',()=>{if(!button.disabled) update({shape:key});});
          });
        } else if(f.type==='select') {
          let target=null;
          const capture=()=>{const engine=isDefault?null:window.RelatumNoteCanvas?.getActive();target={engine,version:engine?.getSelection().version};};
          input=choice(f.options,'',value=>{if(!input.disabled) update({[f.key]:value},target,true);});
          input.addEventListener('pointerdown',capture);input.addEventListener('focus',capture);
          const mixed=new Option(copy('混合','Mixed'),''); mixed.disabled=true; input.prepend(mixed);
        }
        else {
          input=document.createElement('input'); input.type=f.type;
          if(f.min!==undefined) { input.min=f.min; input.max=f.max; input.step=f.step; }
          let token=null;
          const freshToken=()=>{const engine=isDefault?null:window.RelatumNoteCanvas?.getActive();return {engine,version:engine?.getSelection().version};};
          input.addEventListener('pointerdown',()=>{ token=freshToken(); });
          input.addEventListener('focus',()=>{ if(f.type!=='range') token=freshToken(); });
          const cancel=(silent)=>{
            if(!token) return;token.cancelled=true;token.engine?.endSelectionStyle(token,false);
            if(token.beforeDefault) {const d=readDefaults();d[token.kind]=token.beforeDefault;try {localStorage.setItem(KEY,JSON.stringify(d));} catch (_) {}}
            token.beforeDefault=null;if(silent!==true) refresh(true);
          };
          if(f.type==='range') cancelRange=cancel;
          input.addEventListener('pointercancel',()=>cancel());
          input.addEventListener('keydown',event=>{
            if(f.type!=='range') return;
            if(event.key==='Escape') {event.preventDefault();event.stopPropagation();cancel();}
            else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)&&token?.cancelled) token=freshToken();
          });
          input.addEventListener('input',()=>{
            if(!usable(row)||input.disabled) return;
            if(token?.cancelled) {refresh(true);return;}
            if(f.type==='number' && (input.value==='' || !input.validity.valid)) return;
            if(f.type==='range'&&!token) token=freshToken();
            const value=f.type==='checkbox'?input.checked:f.type==='color'?input.value:Number(input.value);
            update({[f.key]:value},token,f.type!=='range');
          });
          input.addEventListener('change',()=>{
            if(!usable(row)||input.disabled||f.type!=='range'||!token) return;
            const completed=token;token=null;
            if(completed.cancelled) refresh(true);else update({[f.key]:Number(input.value)},completed,true);
          });
          if(f.type==='range') { output=document.createElement('output'); row.appendChild(output); }
        }
        input.dataset.canvasStyle=kind+'.'+f.key; input.setAttribute('aria-label',copy(f.zh,f.en)); row.appendChild(input);
        input.disabled=true;
        let automatic;
        if(f.type==='color') {
          automatic=document.createElement('button'); automatic.type='button'; automatic.className='note-canvas-auto-color';
          automatic.disabled=true;
          automatic.textContent=copy('自动','Auto'); automatic.title=copy('跟随主题颜色','Follow theme color');
          automatic.addEventListener('click',event=>{ event.preventDefault();if(!automatic.disabled) update({[f.key]:''}); }); row.appendChild(automatic);
        }
        let mixedLabel;
        if(f.type==='color'||f.type==='shapes') {
          mixedLabel=document.createElement('small');mixedLabel.className='note-canvas-mixed-state';mixedLabel.hidden=true;
          mixedLabel.textContent=copy('混合','Mixed');row.appendChild(mixedLabel);
        }
        controls.push({row,input,output,f,kind,isDefault,automatic,mixedLabel,cancelRange,panel:parent.closest('[data-canvas-group]')}); parent.appendChild(row);
      });
    }
    function resetButton(parent,kind,zh='恢复样式',en='Reset style',patch=defaults[kind]) {
      const button=document.createElement('button');button.type='button';button.className='note-canvas-object-reset';
      button.textContent=copy(zh,en);button.dataset.canvasReset=kind;
      button.addEventListener('click',()=>{if(!button.disabled&&usable(button)) apply(kind,clone(patch),false);});parent.appendChild(button);
    }
    function section(panel,key,zh,en) {
      const el=document.createElement('section');el.className='note-canvas-property-section';el.dataset.canvasSection=key;
      const heading=document.createElement('h4');heading.textContent=copy(zh,en);el.appendChild(heading);panel.appendChild(el);return el;
    }
    function populateDefaults() {
      const panel=panels.get('defaults');
      for(let i=controls.length-1;i>=0;i--) if(controls[i].isDefault) {controls[i].cancelRange?.(true);controls.splice(i,1);}
      panel.appendChild(scale);scale.hidden=defaultKind!=='node';
      panel.querySelector('[data-canvas-default-fields]')?.remove();
      const content=document.createElement('div');content.dataset.canvasDefaultFields='true';content.id='note-canvas-default-fields';
      content.setAttribute('role','tabpanel');content.setAttribute('aria-labelledby','note-canvas-default-tab-'+defaultKind);
      panel.appendChild(content);if(defaultKind==='node') content.appendChild(scale);addFields(content,defaultKind,true);
      panel.querySelectorAll('[data-default-target]').forEach(button=>{
        const selected=button.dataset.defaultTarget===defaultKind;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      });
    }
    function build() {
      const scroll=host.scrollTop;
      controls.forEach(control=>control.cancelRange?.(true));
      groups.replaceChildren();controls.length=0;panels.clear();
      [['defaults','新建默认样式','New default styles'],['node','节点','Nodes'],['edge','连线','Edges'],['mixed','混合调色','Selection colors']].forEach(([key,zh,en])=>{
        const panel=document.createElement('section');panel.dataset.canvasGroup=key;panel.hidden=key!==mode;
        const title=document.createElement('h3');title.textContent=copy(zh,en);
        title.className='note-canvas-panel-title';panel.appendChild(title);panels.set(key,panel);groups.appendChild(panel);
      });
      const creation=panels.get('defaults');
      scale.querySelector('strong').textContent=copy('新建画布节点尺寸','New canvas node size');
      scale.querySelector('input').setAttribute('aria-label',copy('新建画布节点尺寸','New canvas node size'));
      const tabs=document.createElement('div');tabs.className='note-canvas-default-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',copy('新建样式目标','New style target'));
      ['node','edge','nodeText','edgeText'].forEach(kind=>{
        const button=document.createElement('button');button.type='button';button.dataset.defaultTarget=kind;button.id='note-canvas-default-tab-'+kind;
        button.setAttribute('role','tab');button.setAttribute('aria-controls','note-canvas-default-fields');button.textContent=copy(...kindNames[kind]);
        button.addEventListener('click',()=>{if(!usable(button)||defaultKind===kind) return;defaultKind=kind;populateDefaults();refresh(true);host.scrollTop=0;});tabs.appendChild(button);
      });
      tabs.addEventListener('keydown',event=>{
        const buttons=[...tabs.children],index=buttons.indexOf(event.target);
        if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
        buttons[next].click();buttons[next].focus({preventScroll:true});
      });
      creation.appendChild(tabs);populateDefaults();
      const node=panels.get('node'),edge=panels.get('edge'),mixed=panels.get('mixed');
      const subset=(kind,keys)=>keys.map(key=>fields[kind].find(f=>f.key===key));
      addFields(section(node,'appearance','形状与外观','Shape and appearance'),'node',false,
        subset('node',['shape','radius','bgColor','bgOpacity','hideBackground','borderColor','borderWidth']));
      addFields(section(node,'size','尺寸','Size'),'node',false,subset('node',['width','height','autoHeight','paddingX','paddingY']));
      resetButton(node,'node');
      const body=section(node,'nodeText','正文排版','Body text');addFields(body,'nodeText',false);resetButton(body,'nodeText');
      addFields(section(edge,'appearance','路径与外观','Path and appearance'),'edge',false,subset('edge',['curve','cornerRadius','lineStyle','color','width']));
      addFields(section(edge,'connections','连接与箭头','Connections and arrows'),'edge',false,subset('edge',['fromSide','toSide','arrowStart','arrowEnd','arrowSize']));
      resetButton(edge,'edge');
      const label=section(edge,'edgeText','连线标注','Edge label');
      addFields(label,'edge',false,subset('edge',['labelPosition','labelOffsetX','labelOffsetY']));
      resetButton(label,'edge','标注位置复位','Reset label position',{labelPosition:.5,labelOffsetX:0,labelOffsetY:0});
      addFields(label,'edgeText',false);resetButton(label,'edgeText');
      [['node','bgColor','节点填充','Node fill'],['node','borderColor','节点边框','Node border'],['nodeText','color','节点正文','Node text'],
        ['edge','color','连线','Edge stroke'],['edgeText','color','标注文字','Label text']].forEach(([kind,key,zh,en])=>
          addFields(mixed,kind,false,[{...fields[kind].find(f=>f.key===key),zh,en}]));
      refresh(true);host.scrollTop=scroll;
    }
    function position() {
      if(positionFrame||pendingPosition===null) return;
      positionFrame=requestAnimationFrame(()=>{
        positionFrame=0;if(host.hidden) return;
        const target=pendingPosition;pendingPosition=null;
        const el=target==='top'?null:panels.get(mode)?.querySelector(`[data-canvas-section="${target}"]`);
        host.scrollTop=el?host.scrollTop+el.getBoundingClientRect().top-host.getBoundingClientRect().top-16:0;
      });
    }
    function refresh(force) {
      const engine=window.RelatumNoteCanvas?.getActive()||null;
      if(engine!==subscribed) { unsubscribe?.(); subscribed=engine; unsubscribe=engine?.subscribeSelection(refresh); }
      const selection=engine?.getSelection(), d=readDefaults(), normalized={};
      const next=selection?.nodes.length?(selection.edges.length?'mixed':'node'):selection?.edges.length?'edge':'defaults';
      if(next!==mode||engine!==lastEngine) {
        const previous=mode;mode=next;lastEngine=engine;lastFocus=-1;
        controls.filter(c=>c.panel?.dataset.canvasGroup===previous).forEach(c=>{c.cancelRange?.(true);c.input.querySelectorAll?.('button').forEach(b=>{b.disabled=true;});c.input.disabled=true;if(c.automatic) c.automatic.disabled=true;});
        panels.forEach((panel,key)=>{panel.hidden=key!==mode;});pendingPosition='top';
      }
      resetDefaults.hidden=mode!=='defaults';
      if(selection&&selection.focusVersion!==lastFocus) {
        lastFocus=selection.focusVersion;
        if((mode==='node'&&selection.focusKind==='nodeText')||(mode==='edge'&&selection.focusKind==='edgeText')) pendingPosition=selection.focusKind;
      }
      position();
      controls.forEach(({row,input,output,f,kind,isDefault,automatic,mixedLabel,panel})=>{
        if(panel.hidden) return;
        const records=isDefault?[d[kind]]:(kind==='node'||kind==='nodeText'?selection?.nodes:selection?.edges)||[];
        const all=isDefault?records:normalized[kind]||(normalized[kind]=records.map(r=>values(kind,r)));
        const first=all[0]||defaults[kind], value=first[f.key], mixed=all.some(r=>r[f.key]!==value);
        const disabled=!isDefault && (!records.length||selection.readOnly||selection.busy);
        const irrelevant=f.key==='radius' && all.some(r=>r.shape!=='rounded-rect') || f.key==='cornerRadius' && all.some(r=>r.curve!=='rounded-elbow');
        row.hidden=irrelevant;
        row.classList.toggle('is-disabled',disabled||irrelevant); row.classList.toggle('is-mixed',mixed);
        if(mixedLabel) mixedLabel.hidden=!mixed;
        if(f.type==='shapes') input.querySelectorAll('button').forEach(b=>{ b.disabled=disabled; b.setAttribute('aria-pressed',String(!mixed&&b.dataset.shape===value)); });
        else {
          input.disabled=disabled||irrelevant; input.title=mixed?copy('混合','Mixed'):'';
          if(f.type==='checkbox') {input.checked=!!value;input.indeterminate=mixed;}
          else if(document.activeElement!==input||force===true) input.value=f.type==='color'?(value||automaticColor(f.key,kind)):mixed&&(f.type==='number'||f.type==='select')?'':String(value);
          if(f.type==='number') input.placeholder=mixed?copy('混合','Mixed'):'';
        }
        if(output) output.textContent=mixed?copy('混合','Mixed'):(f.key==='bgOpacity'||f.key==='labelPosition'?Math.round(value*100)+'%':String(value));
        if(automatic) { automatic.disabled=disabled;automatic.setAttribute('aria-pressed',String(!mixed&&!value)); }
      });
      groups.querySelectorAll('[data-canvas-reset]').forEach(b=>{ const s=b.dataset.canvasReset; b.disabled=!selection||selection.readOnly||selection.busy||!(s==='node'||s==='nodeText'?selection.nodes:selection.edges).length; });
    }
    host.addEventListener('keydown',event=>{
      if(event.isComposing||event.keyCode===229||event.target.closest('[data-canvas-group="defaults"]')||event.target.matches('[data-role="note-canvas-node-scale"]')) return;
      if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())&&window.RelatumNoteCanvas?.getActive()) {
        event.preventDefault();event.stopPropagation();window.RelatumNoteCanvas.getActive().travel(event.key.toLowerCase()==='y'||event.shiftKey);refresh(true);
      }
    });
    document.addEventListener('relatum:note-canvas-selection',refresh);
    window.addEventListener('blur',()=>{controls.forEach(control=>control.cancelRange?.(true));refresh(true);});
    new MutationObserver(()=>refresh(true)).observe(document.body,{attributes:true,attributeFilter:['data-start-theme']});
    document.addEventListener('relatum:languagechange',build);
    new MutationObserver(position).observe(host,{attributes:true,attributeFilter:['hidden']});
    resetDefaults.addEventListener('click',()=>{
      if(mode!=='defaults') return;
      try { localStorage.removeItem(KEY); } catch (_) {} resetScale?.(); refresh();
    });
    build();
  }
  window.RelatumNoteCanvasStyle=Object.freeze({ defaults, fields, shapes, clean, values, readDefaults, outline, contains, inset, initPanel, clone });
})();

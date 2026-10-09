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
    let defaultKind='node', textKind='nodeText', subscribed=null, unsubscribe=null, pending=null;
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
    function addFields(parent, kind, isDefault) {
      fields[kind].forEach(f=>{
        const row=document.createElement(f.type==='shapes'?'div':'label'); row.className='note-canvas-field'; row.dataset.field=f.key;
        const title=document.createElement('span'); title.textContent=copy(f.zh,f.en); row.appendChild(title);
        let input, output, cancelRange;
        if(f.type==='shapes') {
          input=document.createElement('div'); input.className='note-canvas-shapes';input.setAttribute('role','group');
          shapes.forEach(([key,zh,en])=>{
            const button=document.createElement('button'); button.type='button'; button.dataset.shape=key;
            button.title=copy(zh,en); button.setAttribute('aria-label',button.title);
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','-2 -2 104 64');
            const path=document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',outline(key,key==='circle'||key==='square'?60:100,60,10));
            if(key==='circle'||key==='square') path.setAttribute('transform','translate(20 0)');
            svg.appendChild(path); button.appendChild(svg); input.appendChild(button);
            button.addEventListener('click',()=>apply(kind,{shape:key},isDefault));
          });
        } else if(f.type==='select') {
          input=choice(f.options,'',value=>apply(kind,{[f.key]:value},isDefault));
          const mixed=new Option(copy('混合','Mixed'),''); mixed.disabled=true; input.prepend(mixed);
        }
        else {
          input=document.createElement('input'); input.type=f.type;
          if(f.min!==undefined) { input.min=f.min; input.max=f.max; input.step=f.step; }
          let token=null;
          const freshToken=()=>{const engine=isDefault?null:window.RelatumNoteCanvas?.getActive();return {engine,version:engine?.getSelection().version};};
          input.addEventListener('pointerdown',()=>{ if(f.type==='range') token=freshToken(); });
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
            if(!input.isConnected) return;
            if(token?.cancelled) {refresh(true);return;}
            if(f.type==='number' && (input.value==='' || !input.validity.valid)) return;
            if(f.type==='range'&&!token) token=freshToken();
            const value=f.type==='checkbox'?input.checked:f.type==='color'?input.value:Number(input.value);
            apply(kind,{[f.key]:value},isDefault,token,f.type!=='range');
          });
          input.addEventListener('change',()=>{
            if(!input.isConnected||f.type!=='range'||!token) return;
            const completed=token;token=null;
            if(completed.cancelled) refresh(true);else apply(kind,{[f.key]:Number(input.value)},isDefault,completed,true);
          });
          if(f.type==='range') { output=document.createElement('output'); row.appendChild(output); }
        }
        input.dataset.canvasStyle=kind+'.'+f.key; input.setAttribute('aria-label',copy(f.zh,f.en)); row.appendChild(input);
        let automatic;
        if(f.type==='color') {
          automatic=document.createElement('button'); automatic.type='button'; automatic.className='note-canvas-auto-color';
          automatic.textContent=copy('自动','Auto'); automatic.title=copy('跟随主题颜色','Follow theme color');
          automatic.addEventListener('click',event=>{ event.preventDefault(); apply(kind,{[f.key]:''},isDefault); }); row.appendChild(automatic);
        }
        let mixedLabel;
        if(f.type==='color'||f.type==='shapes') {
          mixedLabel=document.createElement('small');mixedLabel.className='note-canvas-mixed-state';mixedLabel.hidden=true;
          mixedLabel.textContent=copy('混合','Mixed');row.appendChild(mixedLabel);
        }
        controls.push({row,input,output,f,kind,isDefault,automatic,mixedLabel,cancelRange}); parent.appendChild(row);
      });
    }
    function build() {
      controls.forEach(control=>control.cancelRange?.(true));
      groups.replaceChildren(); controls.length=0;
      [['defaults','新建默认样式','New default styles'],['node','节点','Nodes'],['text','文字','Text'],['edge','连线','Edges']].forEach(([key,zh,en])=>{
        const details=document.createElement('details'); details.dataset.canvasGroup=key;
        const summary=document.createElement('summary'); summary.textContent=copy(zh,en); details.appendChild(summary);
        if(key==='defaults'||key==='text') {
          const kinds=key==='defaults'?Object.keys(defaults):['nodeText','edgeText'];
          const switchKind=value=>{
            if(key==='defaults') defaultKind=value; else textKind=value;
            const open=[...groups.querySelectorAll('details')].filter(d=>d.open).map(d=>d.dataset.canvasGroup); build();
            groups.querySelectorAll('details').forEach(d=>{ d.open=open.includes(d.dataset.canvasGroup); });
          };
          if(key==='text') {
            const picker=document.createElement('div');picker.className='note-canvas-target-switch';picker.setAttribute('role','group');picker.setAttribute('aria-label',copy('文字目标','Text target'));
            kinds.forEach(k=>{const button=document.createElement('button');button.type='button';button.textContent=copy(...kindNames[k]);button.dataset.textTarget=k;
              button.setAttribute('aria-pressed',String(k===textKind));button.addEventListener('click',()=>switchKind(k));picker.appendChild(button);});details.appendChild(picker);
          } else {
            const picker=choice(kinds.map(k=>[k,...kindNames[k]]),defaultKind,switchKind);
            picker.className='note-canvas-target';picker.setAttribute('aria-label',copy('样式目标','Style target'));details.appendChild(picker);
          }
        }
        const kind=key==='defaults'?defaultKind:key==='text'?textKind:key;
        addFields(details,kind,key==='defaults');
        if(key!=='defaults') {
          const reset=document.createElement('button'); reset.type='button'; reset.className='note-canvas-object-reset';
          reset.textContent=copy('恢复样式','Reset style'); reset.dataset.canvasReset=kind;
          reset.addEventListener('click',()=>apply(kind,clone(defaults[kind]),false)); details.appendChild(reset);
          if(key==='edge') {
            const position=document.createElement('button'); position.type='button'; position.className='note-canvas-object-reset'; position.dataset.canvasReset='edge';
            position.textContent=copy('标注位置复位','Reset label position'); position.addEventListener('click',()=>apply('edge',{labelPosition:.5,labelOffsetX:0,labelOffsetY:0},false)); details.appendChild(position);
          }
        }
        groups.appendChild(details);
      }); refresh();
    }
    function refresh(force) {
      const engine=window.RelatumNoteCanvas?.getActive()||null;
      if(engine!==subscribed) { unsubscribe?.(); subscribed=engine; unsubscribe=engine?.subscribeSelection(refresh); }
      const selection=engine?.getSelection(), d=readDefaults(), normalized={};
      controls.forEach(({row,input,output,f,kind,isDefault,automatic,mixedLabel})=>{
        const records=isDefault?[d[kind]]:(kind==='node'||kind==='nodeText'?selection?.nodes:selection?.edges)||[];
        const all=isDefault?records:normalized[kind]||(normalized[kind]=records.map(r=>values(kind,r)));
        const first=all[0]||defaults[kind], value=first[f.key], mixed=all.some(r=>r[f.key]!==value);
        const disabled=!isDefault && (!records.length||selection.readOnly||selection.busy);
        const irrelevant=f.key==='radius' && all.some(r=>r.shape!=='rounded-rect') || f.key==='cornerRadius' && all.some(r=>r.curve!=='rounded-elbow');
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
    document.addEventListener('relatum:languagechange',()=>{
      const open=[...groups.querySelectorAll('details')].filter(d=>d.open).map(d=>d.dataset.canvasGroup);build();
      groups.querySelectorAll('details').forEach(d=>{d.open=open.includes(d.dataset.canvasGroup);});
    });
    host.querySelector('[data-note-action="reset-canvas-settings"]').addEventListener('click',()=>{
      try { localStorage.removeItem(KEY); } catch (_) {} resetScale?.(); refresh();
    });
    build();
  }
  window.RelatumNoteCanvasStyle=Object.freeze({ defaults, fields, shapes, clean, values, readDefaults, outline, contains, inset, initPanel, clone });
})();

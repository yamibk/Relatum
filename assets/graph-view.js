// 当前画布关系图谱（适配层）。
// 物理 / 相机 / 交互 / 渲染循环统一交给 graph-engine.js；这里只负责：
//   · 从当前 .canvas 读出只读的 nodes/edges（力导向位置只属于浮窗，不写回原画布坐标）；
//   · 节点配色 / 形状(index 方块) / 标签规则；
//   · 点击节点 → 定位回原画布；浮窗拖动 / 透明度 / 舒展 / 复位 / 计数等外壳交互。
(function (global) {
  'use strict';

  const VIEW_W = 1200;
  const VIEW_H = 720;
  const CENTER_X = VIEW_W / 2;
  const CENTER_Y = VIEW_H / 2;
  const OPACITY_KEY = 'canvas:graphOpacity';
  const NODE_COLORS = {
    gray: '#8a8c8d', blue: '#4e77be', green: '#4f9571',
    yellow: '#bc913c', red: '#b66059', purple: '#8061b3',
  };
  const KIND_COLORS = {
    index: '#2f3437', text: '#2f3437', preview: '#bc913c',
    card: '#4f9571', table: '#477f78', pdf: '#b07a4f', md: '#5b8c7e', normal: '#35383b',
  };

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  // 关系图谱闲时"呼吸"：节点错相位轻微起伏（仅缩放，GPU 实例属性免费）。比星图更克制——
  // 不动透明度、索引节点几乎不动，保持工具感；reduceMotion / 聚焦时返回 1。
  const GV_BREATH_SPEED = 0.0009;       // 周期 ≈ 7s

  // 读画布的「拖拽惯性」设置（canvas:panInertia, 0–1），让图谱视图平移惯性与画布同步；缺省取画布默认 0.15。
  function readPanInertia() {
    try {
      const v = parseFloat(localStorage.getItem('canvas:panInertia'));
      if (isFinite(v) && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return 0.15;
  }

  function isDecorationNode(node) {
    return node && (node.kind === 'shape' || node.kind === 'image' || node.kind === 'textBox');
  }
  function cleanLabel(text) {
    const first = String(text || '').split(/\r?\n/).find((line) => line.trim()) || '未命名节点';
    return first
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/[*_`~]/g, '')
      .replace(/^\s*[-+]\s+/, '')
      .trim() || '未命名节点';
  }
  function nodeTypeName(node) {
    if (node.kind === 'index' || node.kind === 'text') return '索引节点';
    if (node.kind === 'preview') return '预览节点';
    if (node.kind === 'card') return '卡片节点';
    if (node.kind === 'table') return '表格对象';
    if (node.kind === 'pdf') return 'PDF 附件';
    if (node.kind === 'md') return 'Markdown 附件';
    return '普通节点';
  }
  function graphNodeLabel(node) {
    if (node.kind === 'pdf' || node.kind === 'md') return cleanLabel(node.name);
    if (node.kind === 'table' && !String(node.text || '').trim()) {
      const syntax = global.MarkdownTable;
      const parsed = syntax && syntax.parse(node.body || '', { ensureBodyRow: false });
      if (parsed && parsed.ok) {
        const headers = parsed.model.header.filter(function (cell) { return String(cell || '').trim(); });
        if (headers.length) return cleanLabel(headers.slice(0, 2).join(' · '));
      }
      return '未命名表格';
    }
    return cleanLabel(node.text);
  }
  function nodeColor(node) {
    if (NODE_COLORS[node.color]) return NODE_COLORS[node.color];
    if (node.borderColor && /^#[0-9a-f]{6}$/i.test(node.borderColor)
        && node.borderColor.toLowerCase() !== '#000000') {
      return node.borderColor;
    }
    return KIND_COLORS[node.kind] || KIND_COLORS.normal;
  }
  function rgbString(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!match) return '53,56,59';
    const raw = match[1];
    return parseInt(raw.slice(0, 2), 16) + ','
      + parseInt(raw.slice(2, 4), 16) + ','
      + parseInt(raw.slice(4, 6), 16);
  }
  // 解析 getComputedStyle 给出的颜色，判断是否深色主题（正文色偏亮即说明背景是暗的）
  function luminanceOf(colorStr) {
    const m = /rgba?\(([^)]+)\)/i.exec(colorStr || '');
    if (!m) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
  }
  // —— 颜色 → WebGL 用的 0..1 分量数组（描述符喂给 GPU 用）——
  function hex01(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return [0.21, 0.22, 0.23];
    const r = m[1];
    return [parseInt(r.slice(0, 2), 16) / 255, parseInt(r.slice(2, 4), 16) / 255, parseInt(r.slice(4, 6), 16) / 255];
  }
  function rgba01(str) {
    const m = /rgba?\(([^)]+)\)/i.exec(str || '');
    if (!m) return [0.1, 0.11, 0.13, 1];
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, p[3] == null ? 1 : p[3]];
  }

  function init(options) {
    const overlay = options && options.overlay;
    if (!overlay) return null;

    const trigger = options.trigger || null;
    const onSelect = options.onSelect || function () {};
    const onVisibilityChange = options.onVisibilityChange || function () {};
    const frame = overlay.querySelector('[data-role="graph-window"]');
    const handle = overlay.querySelector('[data-role="graph-drag-handle"]');
    const title = overlay.querySelector('[data-role="graph-title"]');
    const stage = overlay.querySelector('[data-role="graph-stage"]');
    const canvas = overlay.querySelector('[data-role="graph-canvas"]');
    const tooltip = overlay.querySelector('[data-role="graph-tooltip"]');
    const hint = overlay.querySelector('[data-role="graph-hint"]');
    const empty = overlay.querySelector('[data-role="graph-empty"]');
    const nodeCount = overlay.querySelector('[data-role="graph-node-count"]');
    const edgeCount = overlay.querySelector('[data-role="graph-edge-count"]');
    const opacity = overlay.querySelector('[data-role="graph-opacity"]');
    const opacityValue = overlay.querySelector('[data-role="graph-opacity-val"]');
    const closeButton = overlay.querySelector('[data-action="graph-close"]');
    const relaxButton = overlay.querySelector('[data-action="graph-relax"]');
    const resetButton = overlay.querySelector('[data-action="graph-reset-view"]');
    if (!frame || !stage || !canvas || !canvas.getContext || !global.GraphEngine) return null;

    let reduceMotion = false;
    try { reduceMotion = global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    let nodes = [];
    let edges = [];
    let windowDrag = null;
    let opened = false;
    let closing = false;
    let closeTimer = null;

    // —— 主题相关颜色：开图时读一次（随主题切换重读）——
    const theme = {
      font: '600 12px system-ui', text: '#2f3437',
      labelHalo: 'rgba(251,251,250,0.95)', dotStroke: 'rgba(255,255,255,0.94)',
      edge: 'rgba(27,29,32,0.22)', edgeHi: 'rgba(27,29,32,0.66)',
      dotStrokeGL: rgba01('rgba(255,255,255,0.94)'),
      edgeGL: rgba01('rgba(27,29,32,0.22)'), edgeHiGL: rgba01('rgba(27,29,32,0.66)'),
    };
    function syncTheme() {
      try {
        const cs = global.getComputedStyle(canvas);
        const text = cs.getPropertyValue('color') || '#2f3437';
        const family = cs.getPropertyValue('font-family') || 'system-ui';
        theme.text = text.trim() || '#2f3437';
        theme.font = '600 12px ' + (family.trim() || 'system-ui');
        const dark = luminanceOf(theme.text) > 0.6;
        theme.labelHalo = dark ? 'rgba(20,21,23,0.92)' : 'rgba(251,251,250,0.95)';
        theme.dotStroke = dark ? 'rgba(25,26,27,0.9)' : 'rgba(255,255,255,0.94)';
        theme.edge = dark ? 'rgba(214,217,221,0.22)' : 'rgba(27,29,32,0.22)';
        theme.edgeHi = dark ? 'rgba(224,227,231,0.66)' : 'rgba(27,29,32,0.66)';
      } catch (e) {}
      // WebGL 描述符用的 0..1 版本（与上面 Canvas2D 串一一对应，主题切换时同步重算）
      theme.dotStrokeGL = rgba01(theme.dotStroke);
      theme.edgeGL = rgba01(theme.edge);
      theme.edgeHiGL = rgba01(theme.edgeHi);
    }

    function buildGraphData(data) {
      const contentNodes = (Array.isArray(data.nodes) ? data.nodes : [])
        .filter((node) => node && !isDecorationNode(node));
      const byId = new Map();
      nodes = contentNodes.map((node, index) => {
        byId.set(node.id, index);
        const color = nodeColor(node);
        return {
          id: node.id,
          label: graphNodeLabel(node),
          type: nodeTypeName(node),
          kind: node.kind === 'text' ? 'index' : (node.kind || 'normal'),
          color: color,
          rgb: rgbString(color),
          glFill: hex01(color),
          degree: 0,
          x: 0, y: 0, r: 6,
        };
      });
      edges = [];
      const seen = new Set();
      (Array.isArray(data.edges) ? data.edges : []).forEach((edge) => {
        if (!edge || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) return;
        const source = byId.get(edge.from);
        const target = byId.get(edge.to);
        const key = Math.min(source, target) + ':' + Math.max(source, target);
        if (seen.has(key)) return;
        seen.add(key);
        const degSum = nodes[source].degree + nodes[target].degree;
        const rest = degSum >= 10 ? 148 : (degSum >= 5 ? 120 : 92);
        edges.push({ source: source, target: target, rest: rest });
        nodes[source].degree++;
        nodes[target].degree++;
      });
      nodes.forEach((node) => {
        node.r = Math.max(6, Math.min(17, 6 + node.degree * 1.5));
        node.shownLabel = node.label.length > 18 ? node.label.slice(0, 17) + '...' : node.label;
        // 分层重力：度数越高越锚定中心，避免整图漂移、加速收敛（与足迹星图同理）
        if (node.degree >= 6) { node._grav = 0.022; node._driftAmp = 2.0; }
        else if (node.degree >= 3) { node._grav = 0.009; node._driftAmp = 4.6; }
        else if (node.degree >= 1) { node._grav = 0.005; node._driftAmp = 7.0; }
        else { node._grav = 0.0035; node._driftAmp = 8.4; }
      });
    }

    function seedPositions() {
      const count = Math.max(nodes.length, 1);
      const radius = Math.min(VIEW_W, VIEW_H) * 0.29;
      nodes.forEach((node, index) => {
        const angle = index / count * Math.PI * 2;
        const spread = radius * (0.86 + Math.random() * 0.28);
        node.x = CENTER_X + Math.cos(angle) * spread;
        node.y = CENTER_Y + Math.sin(angle) * spread;
      });
    }

    // 闲时呼吸缩放系数：索引节点几乎不动（depth 0.02），其余节点 ±4%；reduceMotion / 聚焦 → 1。
    function gvBreath(node, focus) {
      if (reduceMotion || focus) return 1;
      const depth = node.kind === 'index' ? 0.02 : 0.04;
      return 1 + depth * Math.sin(now() * GV_BREATH_SPEED + (node._phase || 0));
    }

    // —— 渲染回调：在「节点本地坐标」绘制，引擎已铺好进场缩放 / 透明度 ——
    function drawNode(ctx, node, env) {
      const r = node.r;
      const isIndex = node.kind === 'index';
      const base = ctx.globalAlpha * (env.dim ? 0.22 : 1);
      const focus = env.focus;
      const near = env.near;

      // 光晕（只在聚焦时显示——索引节点不再常驻光晕，省每帧 DOM/绘制，对齐足迹星图）
      let haloAlpha = focus ? 1 : 0;
      if (haloAlpha > 0) {
        ctx.globalAlpha = base * haloAlpha;
        ctx.beginPath();
        ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = isIndex ? 'rgba(27,29,32,0.11)' : ('rgba(' + node.rgb + ',0.12)');
        ctx.fill();
      }

      // 实心点（index 圆角方块，其余圆）
      ctx.globalAlpha = base;
      const scale = (focus ? 1.18 : 1) * gvBreath(node, focus);
      ctx.save();
      if (scale !== 1) ctx.scale(scale, scale);
      ctx.fillStyle = node.color;
      ctx.strokeStyle = focus ? node.color : theme.dotStroke;
      ctx.lineWidth = focus ? 2.5 : (near ? 2.2 : (isIndex ? 2.2 : 1.8));
      if (isIndex) {
        const size = r * 1.75;
        roundRect(ctx, -size / 2, -size / 2, size, size, Math.max(2.5, r * 0.32));
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // 标签：非索引节点仅在聚焦/邻近时显示；索引节点常显（0.88）
      let labelAlpha = isIndex ? ((focus || near) ? 1 : 0.88) : ((focus || near) ? 1 : 0);
      if (labelAlpha > 0 && node.shownLabel) {
        ctx.globalAlpha = base * labelAlpha;
        ctx.font = theme.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const ly = -(r + 8);
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(node.shownLabel, 0, ly);
        ctx.fillStyle = theme.text;
        ctx.fillText(node.shownLabel, 0, ly);
      }
    }

    function drawEdge(ctx, edge, s, d, env) {
      ctx.globalAlpha = ctx.globalAlpha * (env.dim ? 0.14 : 1);
      ctx.beginPath();
      ctx.moveTo(s._rx, s._ry);
      ctx.lineTo(d._rx, d._ry);
      if (env.highlighted) { ctx.strokeStyle = theme.edgeHi; ctx.lineWidth = 2; }
      else { ctx.strokeStyle = theme.edge; ctx.lineWidth = 1.2; }
      ctx.stroke();
    }

    function roundRect(ctx, x, y, w, h, radius) {
      const rad = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }

    // —— WebGL 路径：几何走描述符（对应 drawNode 的实心点），光晕 / 标签走顶层 2D 叠加层 ——
    // 与上面的 drawNode/drawEdge 一一对应；WebGL 不可用时引擎自动回落到那份 Canvas2D 代码。
    function nodeStyle(node, env) {
      const isIndex = node.kind === 'index';
      const dim = env.dim ? 0.22 : 1;
      const fill = node.glFill;
      const sg = env.focus ? fill : theme.dotStrokeGL;       // 聚焦用本色描边，平时用浅色描边
      const strokeA = (env.focus ? 1 : (theme.dotStrokeGL[3] == null ? 0.94 : theme.dotStrokeGL[3]));
      const strokeW = env.focus ? 2.5 : (env.near ? 2.2 : (isIndex ? 2.2 : 1.8));
      return {
        r: node.r,
        fill: [fill[0], fill[1], fill[2], dim],
        stroke: [sg[0], sg[1], sg[2], strokeA * dim],
        strokeW: strokeW,
        shape: isIndex ? 1 : 0,
        scale: (env.focus ? 1.18 : 1) * gvBreath(node, env.focus),
      };
    }
    function edgeStyle(edge, s, d, env) {
      const dim = env.dim ? 0.14 : 1;
      const c = env.highlighted ? theme.edgeHiGL : theme.edgeGL;
      return { color: [c[0], c[1], c[2], (c[3] == null ? 1 : c[3]) * dim], width: env.highlighted ? 2 : 1.2 };
    }
    // ── DOM 标签层：用 CSS transform 替代 Canvas 2D 文字绘制 ──
    // 标签 / 光晕提升为独立 DOM 元素，GPU compositor 管理合成，不触发 paint。
    // 文字渲染交浏览器 sub-pixel AA，中文更锐利；text-shadow 替代 strokeText 光晕。
    function createDOMLabelLayer() {
      const container = document.createElement('div');
      container.className = 'ge-dom-overlay';
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
      var parent = canvas.parentNode;
      if (parent) parent.insertBefore(container, canvas.nextSibling);

      var labelPool = Object.create(null);   // id → { el, inner }
      var haloPool = Object.create(null);    // id → { el }

      function w2s(wx, wy, st) {
        return {
          x: (wx - st.viewX) * st.unit + st.offsetX,
          y: (wy - st.viewY) * st.unit + st.offsetY,
        };
      }

      function sync(st) {
        var A = st.labelAlpha;
        var ns = st.nodes;
        var seenL = Object.create(null);
        var seenH = Object.create(null);
        var liveIds = Object.create(null);
        // 标签和光晕池可以跨帧复用，但不能跨数据集无界保留已删节点的 DOM。
        // open() 可多次喂入新的画布快照；先建当前存活 id 集，收尾时直接裁掉旧池项。
        for (var li = 0; li < ns.length; li++) liveIds[ns[li].id || li] = true;

        // 光晕圆（聚焦时）
        for (var i = 0; i < ns.length; i++) {
          var n = ns[i];
          var id = n.id || i;
          var isIndex = n.kind === 'index';
          var haloA = n._focus ? 1 : 0;   // 光晕只在聚焦时显示（不再给索引节点常驻光晕）
          if (haloA <= 0) continue;
          var alpha = A * (n._dim ? 0.22 : 1) * haloA;
          if (alpha < 0.004) continue;
          seenH[id] = true;
          var hp = haloPool[id];
          if (!hp) {
            var hel = document.createElement('div');
            hel.style.cssText = 'position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;will-change:transform,opacity;';
            container.appendChild(hel);
            hp = { el: hel };
            haloPool[id] = hp;
          }
          var center = w2s(n._rx, n._ry, st);
          var rpx = (n.r + 7) * st.unit;
          var sz = (rpx * 2).toFixed(1) + 'px';
          if (hp._sz !== sz) { hp.el.style.width = sz; hp.el.style.height = sz; hp._sz = sz; }
          var tf = 'translate(' + (center.x - rpx).toFixed(1) + 'px,' + (center.y - rpx).toFixed(1) + 'px)';
          if (hp._tf !== tf) { hp.el.style.transform = tf; hp._tf = tf; }
          if (hp._op !== alpha) { hp.el.style.opacity = alpha; hp._op = alpha; }
          var bg = isIndex ? 'rgba(27,29,32,0.11)' : ('rgba(' + n.rgb + ',0.12)');
          if (hp._bg !== bg) { hp.el.style.background = bg; hp._bg = bg; }
        }

        // 标签文字
        for (var i = 0; i < ns.length; i++) {
          var n = ns[i];
          if (!n.shownLabel) continue;
          var id = n.id || i;
          var isIndex = n.kind === 'index';
          var focusNear = n._focus || n._near;
          var labA = isIndex ? (focusNear ? 1 : 0.88) : (focusNear ? 1 : 0);
          if (st.scale < 0.62 && !focusNear) labA = 0;
          if (labA <= 0) continue;
          var alpha = A * (n._dim ? 0.22 : 1) * labA;
          if (alpha < 0.004) continue;
          seenL[id] = true;
          var lp = labelPool[id];
          if (!lp) {
            var lel = document.createElement('div');
            lel.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;';
            var inner = document.createElement('span');
            inner.style.cssText = 'display:block;transform:translate(-50%,-100%);white-space:nowrap;';
            inner.style.font = theme.font;
            inner.style.color = theme.text;
            lel.appendChild(inner);
            container.appendChild(lel);
            lp = { el: lel, inner: inner };
            labelPool[id] = lp;
          }
          var center = w2s(n._rx, n._ry, st);
          var ly = center.y - (n.r * st.unit) - 8;
          var tf = 'translate(' + center.x.toFixed(1) + 'px,' + ly.toFixed(1) + 'px)';
          if (lp._tf !== tf) { lp.el.style.transform = tf; lp._tf = tf; }
          if (lp._op !== alpha) { lp.el.style.opacity = alpha; lp._op = alpha; }
          if (lp._txt !== n.shownLabel) { lp.inner.textContent = n.shownLabel; lp._txt = n.shownLabel; }
          var sh = focusNear ? '0 0 4px ' + theme.labelHalo : 'none';
          if (lp._sh !== sh) { lp.inner.style.textShadow = sh; lp._sh = sh; }
        }

        // 收尾：当前数据里仍存在、只是本帧不显示的元素只隐藏；
        // 数据里已不存在的节点则移除 DOM 并删掉池项，避免反复增删后越用越卡。
        for (var k in labelPool) {
          if (!liveIds[k]) { labelPool[k].el.remove(); delete labelPool[k]; }
          else if (!seenL[k] && labelPool[k]._op !== 0) { labelPool[k].el.style.opacity = '0'; labelPool[k]._op = 0; }
        }
        for (var k in haloPool) {
          if (!liveIds[k]) { haloPool[k].el.remove(); delete haloPool[k]; }
          else if (!seenH[k] && haloPool[k]._op !== 0) { haloPool[k].el.style.opacity = '0'; haloPool[k]._op = 0; }
        }
      }

      function destroy() {
        try { container.remove(); } catch (e) {}
        for (var k in labelPool) delete labelPool[k];
        for (var k in haloPool) delete haloPool[k];
      }

      return { sync: sync, destroy: destroy };
    }

    var domOverlay = createDOMLabelLayer();

    // 闲时微漂移：小图谱保留"活着"的微动；节点超过阈值则收敛后关掉漂移、让 RAF 循环彻底停住
    // （静止时零开销——避免大图谱永不停的每帧重绘 + 标签层重排，这是图谱比星图卡的主因）。
    const DRIFT_MAX_NODES = 150;
    const IDLE_DRIFT = { speed: 0.00088, amp: function (node) { return node._driftAmp || 1.8; } };
    const GV_FLOW_COLOR = [0.27, 0.52, 0.40, 0.62];   // 连线流光：克制的青绿（浅色浮窗背景上也看得清）
    const PARTICLE_CFG = { speed: 0.00018, perEdge: 1, size: 2.2, getColor: function () { return GV_FLOW_COLOR; } };

    const engine = global.GraphEngine.create({
      canvas: canvas,
      backend: 'webgl',
      config: { viewW: VIEW_W, viewH: VIEW_H, repulsion: 7200, spring: 0.048, springRest: 112, gravity: 0.0055,
                alphaDecay: 0.022, alphaReheat: 0.28, theta: 0.92, velocityDamp: 0.84,
                zoomMin: 0.4, zoomMax: 3.5, fitScaleMin: 0.4, fitScaleMax: 3.5, fitPad: 26, fitMargin: 44 },
      reduceMotion: reduceMotion,
      active: false,
      drawNode: drawNode,           // Canvas2D 兜底路径（WebGL 失败时引擎自动用它，含标签）
      drawEdge: drawEdge,
      nodeStyle: nodeStyle,         // WebGL 几何
      edgeStyle: edgeStyle,
      domOverlay: domOverlay,       // DOM 标签层（CSS transform，GPU compositor）
      getGravity: function (node) { return node._grav != null ? node._grav : 0.0055; },
      getEdgeRest: function (edge) { return edge.rest || 112; },
      drift: IDLE_DRIFT,          // 实际开关在 open() 里按节点规模用 engine.setDrift 决定
      particles: PARTICLE_CFG,    // 连线流光，同样在 open() 里按规模用 engine.setParticles 决定
      onNodeClick: function (node) { close(); onSelect(node.id); },
      onNodeHover: function (node, event) {
        if (!tooltip) return;
        if (!node) { tooltip.hidden = true; return; }
        const rect = stage.getBoundingClientRect();
        tooltip.textContent = node.label + ' / ' + node.type;
        tooltip.style.left = (event.clientX - rect.left + 14) + 'px';
        tooltip.style.top = (event.clientY - rect.top + 14) + 'px';
        tooltip.hidden = false;
      },
    });
    if (!engine) return null;

    function applyOpacity(value) {
      const amount = clamp(Number(value) || 94, 36, 100);
      if (opacity) opacity.value = String(amount);
      if (opacityValue) opacityValue.textContent = amount + '%';
      if (opacity) opacity.style.setProperty('--graph-opacity-pct', (((amount - 36) / 64) * 100).toFixed(2) + '%');
      frame.style.setProperty('--graph-window-alpha', (amount / 100).toFixed(2));
      try { localStorage.setItem(OPACITY_KEY, String(amount)); } catch (e) {}
    }
    function readOpacity() {
      try { return localStorage.getItem(OPACITY_KEY) || '94'; } catch (e) { return '94'; }
    }

    function centerFrame() {
      const outer = overlay.getBoundingClientRect();
      // offset 尺寸不受入场 transform 影响，避免浮窗在缩放动画首帧按错误尺寸居中。
      frame.style.left = Math.max(12, (outer.width - frame.offsetWidth) / 2) + 'px';
      frame.style.top = Math.max(12, (outer.height - frame.offsetHeight) / 2) + 'px';
    }
    function keepFrameVisible() {
      const outer = overlay.getBoundingClientRect();
      const maxLeft = Math.max(12, outer.width - Math.min(frame.offsetWidth, outer.width - 24) - 12);
      const maxTop = Math.max(12, outer.height - Math.min(frame.offsetHeight, outer.height - 24) - 12);
      const left = clamp(parseFloat(frame.style.left) || 12, 12, maxLeft);
      const top = clamp(parseFloat(frame.style.top) || 12, 12, maxTop);
      frame.style.left = left + 'px';
      frame.style.top = top + 'px';
    }

    function finishClose() {
      if (!closing) return;
      closing = false;
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      overlay.classList.remove('closing');
      overlay.hidden = true;
      onVisibilityChange(false);
    }

    function close() {
      if (!opened || closing) return;
      opened = false;
      closing = true;
      engine.setActive(false);
      if (tooltip) tooltip.hidden = true;
      if (trigger) {
        trigger.classList.remove('active');
        trigger.setAttribute('aria-expanded', 'false');
      }
      if (reduceMotion) {
        finishClose();
        return;
      }
      overlay.classList.add('closing');
      frame.addEventListener('animationend', finishClose, { once: true });
      closeTimer = setTimeout(finishClose, 280);
    }

    function open(data, canvasTitle) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      closing = false;
      overlay.classList.remove('closing');
      overlay.hidden = false;
      opened = true;
      if (trigger) {
        trigger.classList.add('active');
        trigger.setAttribute('aria-expanded', 'true');
      }
      onVisibilityChange(true);
      if (title) title.textContent = canvasTitle || '当前画布';
      applyOpacity(readOpacity());
      syncTheme();
      buildGraphData(data || {});
      if (nodeCount) nodeCount.textContent = String(nodes.length);
      if (edgeCount) edgeCount.textContent = String(edges.length);
      if (empty) empty.hidden = nodes.length !== 0;
      if (hint) hint.hidden = nodes.length === 0 || edges.length !== 0;
      seedPositions();
      engine.setActive(true);
      engine.setData(nodes, edges);
      engine.setDrift(nodes.length > DRIFT_MAX_NODES ? null : IDLE_DRIFT);  // 大图谱收敛后停住，小图谱保留微动
      engine.setParticles(nodes.length > DRIFT_MAX_NODES ? null : PARTICLE_CFG);  // 连线流光同样大图谱关，零开销
      engine.setPanInertia(readPanInertia());                               // 视图平移惯性与画布「拖拽惯性」同步
      centerFrame();
      keepFrameVisible();
      engine.start({ intro: true, fit: false });
    }

    // —— 外壳交互 ——
    if (opacity) opacity.addEventListener('input', () => applyOpacity(opacity.value));
    if (closeButton) closeButton.addEventListener('click', close);
    if (relaxButton) relaxButton.addEventListener('click', () => {
      if (!nodes.length) return;
      seedPositions();
      engine.start({ intro: false, fit: true });
    });
    if (resetButton) resetButton.addEventListener('click', () => engine.fitView(true));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button, input, label')) return;
      const rect = frame.getBoundingClientRect();
      const outer = overlay.getBoundingClientRect();
      windowDrag = {
        pointerId: event.pointerId,
        x: event.clientX, y: event.clientY,
        left: rect.left - outer.left, top: rect.top - outer.top,
      };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!windowDrag || windowDrag.pointerId !== event.pointerId) return;
      frame.style.left = windowDrag.left + event.clientX - windowDrag.x + 'px';
      frame.style.top = windowDrag.top + event.clientY - windowDrag.y + 'px';
      keepFrameVisible();
    });
    function stopWindowDrag(event) {
      if (!windowDrag || windowDrag.pointerId !== event.pointerId) return;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      windowDrag = null;
      keepFrameVisible();
    }
    handle.addEventListener('pointerup', stopWindowDrag);
    handle.addEventListener('pointercancel', stopWindowDrag);
    global.addEventListener('resize', keepFrameVisible);

    return { open: open, close: close };
  }

  global.GraphView = { init: init };
})(window);

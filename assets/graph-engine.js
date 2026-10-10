// 共享力导向图谱引擎（Canvas2D / WebGL）。
// 关系视图(graph-view) 与 活跃页足迹星图(study-graph) 共用这一份核心：
//   · 渲染：Canvas 2D（取代逐元素 SVG，消除每帧整棵 SVG 树的 style/layout/paint 重算）；
//   · 斥力：Barnes-Hut 四叉树近似，O(n log n)（取代逐对 O(n²)）；
//   · 相机：滚轮锚点缩放 / 平移 / 自动 fit，均带柔和补间；
//   · 动效：进场逐个生长 + alpha 退火 + 拖拽惯性 + 邻域高亮 + 可选闲时微漂移；
//   · 生命周期：active(是否当前前置页) × visible(是否在视口) 双开关，二者皆真且有事可做才跑 RAF。
// 物理 / 动画的数值口径沿用旧 graph-view.js，以尽量保留原有手感。
// 渲染像素由各「适配层」通过 drawNode / drawEdge 回调自己画（形状、配色、标签各图不同）；
// 引擎只负责物理、相机、循环、命中检测与交互，并在调用回调前把坐标系/进场缩放/透明度铺好。
(function (global) {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function easeOut(t) {
    const c = clamp(t, 0, 1);
    return 1 - Math.pow(1 - c, 4);
  }
  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  // —— 默认调参（按 60fps 基准，运行时按真实帧时长归一化）——
  const DEFAULTS = {
    viewW: 1200,
    viewH: 720,
    frameMs: 1000 / 60,
    idleFps: 30,          // 闲时微动（漂移/呼吸/闪烁）渲染封顶帧率：高刷屏省 GPU，慢动作肉眼无差
    alphaMin: 0.0018,     // 低于此温度即视作收敛、停机
    driftFadeAlpha: 0.05, // 漂移随物理能量「交叉淡入」的起点：alpha 低于此值开始点亮漂移、到 alphaMin 全亮（避免"先停死再突然全体启动"）
    alphaDecay: 0.0205,   // 退火速率
    alphaReheat: 0.32,    // 拖动 / 重排时回温到的温度
    releaseReheat: 0.16,  // 松开被拖节点时的「温柔回落」温度上限（远低于抓起 reheat，回位是丝滑滑落而非弹性复位）
    velocityDamp: 0.84,   // 速度阻尼
    introMs: 460,         // 单个节点生长时长
    introStagger: 12,     // 逐个登场错峰
    zoomEase: 0.22,       // 滚轮缩放每帧逼近目标比例
    fitEase: 0.20,        // 适配视野每帧逼近目标比例
    repulsion: 8400,      // 斥力强度 K（force = K·mass / d² · alpha）
    spring: 0.046,        // 连线弹簧劲度
    springRest: 112,      // 连线自然长度（可被 getEdgeRest 覆盖）
    gravity: 0.0055,      // 向心引力（可被 getGravity(node) 覆盖）
    theta: 0.9,           // Barnes-Hut 近似阈值（越小越精确、越慢）
    zoomMin: 0.35,
    zoomMax: 4,
    fitScaleMin: 0.35,
    fitScaleMax: 4,
    fitPad: 24,           // 计算 fit 时每个节点的额外留白
    fitMargin: 48,        // fit 整体外边距
    inertiaClamp: 42,     // 松手惯性速度上限
    releaseInertia: 0.4,  // 松开节点时甩出速度的折扣（<1 收住甩动，减少"抛出再弹回"的复位观感）
    hitPad: 6,            // 命中检测在节点半径外的额外容差（世界单位）
    labelEase: 0.22,      // 顶层标签叠加层淡入淡出每帧逼近目标比例
    labelHideAlpha: 0.08, // 物理温度高于此值（铺开 / 回温中）时藏标签，避免随节点飞动抖字
    presolveSteps: 360,   // 进场+取景时无渲染预解算的最大步数（命中收敛即提前停）
    presolveMaxNodes: 800,// 超过此规模不预解算，退回收敛后动画 fit（限制预布局总计算量）
    introVelocityClamp: 0,// 进场期节点速度上限；0=不限制（默认保持旧行为）
    finalFitOnConverge: true, // 未命中预解算时，收敛后是否再做一次动画 fit
  };

  // ───────────────────────── Barnes-Hut 四叉树 ─────────────────────────
  // 每个节点质量记为 1；内部格子保存质心(cx,cy)与总质量(mass)。
  function makeCell(x, y, size) {
    return { x: x, y: y, size: size, mass: 0, cx: 0, cy: 0, body: null, bodies: null, kids: null };
  }
  function quadIndex(cell, node) {
    const half = cell.size / 2;
    return (node.x >= cell.x + half ? 1 : 0) | (node.y >= cell.y + half ? 2 : 0);
  }
  // 完全重合（或浮点精度下无法再分）的点不能无限拆分四叉树；
  // 到达最小格/最大深度后收进一个聚合叶子，斥力阶段仍以聚合质心 O(1) 近似。
  // 这个上限是容错线，正常坐标不会命中，因此不改变普通布局手感。
  const QUAD_MIN_SIZE = 1e-4;
  const QUAD_MAX_DEPTH = 48;
  function insert(cell, node, depth) {
    // 累计质心
    cell.cx = (cell.cx * cell.mass + node.x) / (cell.mass + 1);
    cell.cy = (cell.cy * cell.mass + node.y) / (cell.mass + 1);
    cell.mass += 1;
    if (!cell.kids && cell.body === null && !cell.bodies) { cell.body = node; return; }
    if (!cell.kids && (cell.size <= QUAD_MIN_SIZE || depth >= QUAD_MAX_DEPTH)) {
      if (!cell.bodies) {
        cell.bodies = new Set();
        if (cell.body) cell.bodies.add(cell.body);
        cell.body = null;
      }
      cell.bodies.add(node);
      return;
    }
    if (!cell.kids) {
      cell.kids = [null, null, null, null];
      const existing = cell.body;
      cell.body = null;
      placeInChild(cell, existing, depth);
    }
    placeInChild(cell, node, depth);
  }
  function placeInChild(cell, node, depth) {
    const half = cell.size / 2;
    const idx = quadIndex(cell, node);
    if (!cell.kids[idx]) {
      const kx = cell.x + (idx & 1 ? half : 0);
      const ky = cell.y + (idx & 2 ? half : 0);
      cell.kids[idx] = makeCell(kx, ky, half || 1);
    }
    insert(cell.kids[idx], node, depth + 1);
  }
  function buildQuad(nodes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    const size = Math.max(maxX - minX, maxY - minY) || 1;
    const root = makeCell(minX, minY, size);
    for (let i = 0; i < nodes.length; i++) insert(root, nodes[i], 0);
    return root;
  }
  // 把 cell 对 node 的斥力累加进 node._fx/_fy（沿用 K·mass/d² 的反平方斥力，方向背离质心）
  function applyRepulsion(node, cell, theta2, k, alpha) {
    if (!cell || cell.mass === 0) return;
    if (cell.body === node && cell.mass === 1) return;
    let mass = cell.mass;
    let cx = cell.cx;
    let cy = cell.cy;
    // 聚合叶子可能包含当前节点；用“剔除自身后的质心”避免自斥力，
    // 同时保持完全重合的大批节点仍是 O(n log n) 级别，不退化成逐对计算。
    if (!cell.kids && cell.bodies && cell.bodies.has(node)) {
      mass -= 1;
      if (mass <= 0) return;
      cx = (cell.cx * cell.mass - node.x) / mass;
      cy = (cell.cy * cell.mass - node.y) / mass;
    }
    let dx = cx - node.x;
    let dy = cy - node.y;
    let d2 = dx * dx + dy * dy;
    const isLeaf = !cell.kids;
    // 叶子直接算；内部格子满足 size²/d² < theta² 时整体近似为一个质心
    if (isLeaf || (cell.size * cell.size) < theta2 * d2) {
      if (d2 < 1) {
        const phase = Number.isFinite(node._phase) ? node._phase : 0;
        dx = Math.cos(phase) * 0.7;
        dy = Math.sin(phase) * 0.7;
        d2 = dx * dx + dy * dy + 0.01;
      }
      const dist = Math.sqrt(d2);
      const force = k * mass / d2 * alpha;
      node._fx -= force * dx / dist;
      node._fy -= force * dy / dist;
      return;
    }
    for (let i = 0; i < 4; i++) if (cell.kids[i]) applyRepulsion(node, cell.kids[i], theta2, k, alpha);
  }

  // ─────────────────────────── 可切换渲染后端 ───────────────────────────
  // 引擎只管物理 / 相机 / 漂移 / 命中 / 交互；"把这些节点连线画成像素"交给后端。
  // 默认后端 = Canvas 2D（与抽离前逐操作一致）；后续 WebGL 后端实现同一份接口即可一键切换、
  // 一键切回（兜底）。后端约定的极小接口：
  //   syncSize()  -> { cssW, cssH, dpr }   按 DPR 调整画布后备存储大小，返回 CSS 度量
  //   draw(frame)                          frame = { nodes, edges, cam, introActive, focusIndex, size }
  //                                        cam  = { offsetX, offsetY, unit, viewX, viewY }（相机由引擎算好）
  //                                        节点渲染坐标读 n._rx / n._ry（引擎已铺好闲时漂移）
  function createCanvas2DBackend(spec) {
    const canvas = spec.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const drawNode = spec.drawNode || function () {};
    const drawEdge = spec.drawEdge || function () {};
    // —— 视口后备存储：按 DPR 重置画布像素尺寸（与抽离前 syncSize 一致）——
    function syncSize() {
      const cssW = canvas.clientWidth || 1;
      const cssH = canvas.clientHeight || 1;
      const dpr = global.devicePixelRatio || 1;
      const needW = Math.max(1, Math.round(cssW * dpr));
      const needH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== needW) canvas.width = needW;
      if (canvas.height !== needH) canvas.height = needH;
      return { cssW: cssW, cssH: cssH, dpr: dpr };
    }
    // —— 一帧绘制：铺好坐标系（DPR→居中偏移→缩放→平移），先连线后节点，像素交给回调 ——
    function draw(frame) {
      const nodes = frame.nodes;
      const edges = frame.edges;
      const cam = frame.cam;
      const size = frame.size;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, size.cssW, size.cssH);
      ctx.translate(cam.offsetX, cam.offsetY);
      ctx.scale(cam.unit, cam.unit);
      ctx.translate(-cam.viewX, -cam.viewY);
      // 之后所有绘制都在「世界坐标」下，线宽 / 半径 / 字号与旧 SVG viewBox 单位一致
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 连线（在节点之下）
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const s = nodes[e.source];
        const d = nodes[e.target];
        if (!s || !d) continue;
        ctx.save();
        ctx.globalAlpha = Math.min(s._appearOpacity, d._appearOpacity);
        drawEdge(ctx, e, s, d, { highlighted: e._highlighted, dim: e._dim });
        ctx.restore();
      }
      // 节点（引擎铺好坐标系 / 进场缩放 / 进场透明度，像素交给适配层）
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        ctx.save();
        ctx.translate(n._rx, n._ry);
        if (!n._appeared && n._appearScale !== 1) ctx.scale(n._appearScale, n._appearScale);
        ctx.globalAlpha = n._appeared ? 1 : n._appearOpacity;
        drawNode(ctx, n, { focus: n._focus, near: n._near, dim: n._dim, hovered: i === frame.focusIndex });
        ctx.restore();
      }
      // 连线流光粒子（画在节点之上的小光点）
      const parts = frame.particles;
      const pcount = frame.particleCount || 0;
      for (let i = 0; i < pcount; i++) {
        const p = parts[i];
        ctx.globalAlpha = p.ca;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgb(' + ((p.cr * 255) | 0) + ',' + ((p.cg * 255) | 0) + ',' + ((p.cb * 255) | 0) + ')';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    return { kind: 'canvas2d', syncSize: syncSize, draw: draw, destroy: function () {} };
  }

  // —— 样式描述符（声明式，后端无关）——
  // 适配层（关系视图 / 星图）用它告诉后端「这个节点 / 连线长什么样」，取代命令式 drawNode/drawEdge，
  // 这样同一份样式既能喂 Canvas2D 也能喂 WebGL。颜色分量一律 0..1，alpha 直通。
  //   nodeStyle(node, env) -> { r, fill:[r,g,b,a], stroke:[r,g,b,a], strokeW, shape(0圆/1方), scale }
  //   edgeStyle(edge, s, d, env) -> { color:[r,g,b,a], width }
  // 缺省（适配层尚未提供描述符时）退化为朴素灰圆 / 淡灰线，仅用于让 WebGL 后端能独立画出几何。
  const _GRAY_FILL = [0.62, 0.64, 0.66, 1];
  const _NO_STROKE = [0, 0, 0, 0];
  function defaultNodeStyle(n) {
    return { r: n.r || 6, fill: _GRAY_FILL, stroke: _NO_STROKE, strokeW: 0, shape: 0, scale: 1 };
  }
  function defaultEdgeStyle() {
    return { color: [0.105, 0.114, 0.125, 0.16], width: 1.1 };
  }

  // ─────────────────────────── WebGL 渲染后端 ───────────────────────────
  // 依赖 graph-gl.js 暴露的 GraphGL 低层核心（WebGL2 实例化：圆 / 圆角方块 SDF + 带宽连线）。
  // 引擎只把每帧的「几何 + 样式描述符」翻译进 GraphGL 的两个 Float32Array，再交 GPU 一把画完——
  // 实例缓存开启后，静止几何的缩放 / 平移只更新矩阵和 AA；时间外观仍独立刷新节点实例。
  // 文字 / 光晕 / 聚合扇形不在这层，
  // 留给后续顶层 2D 叠加层（中文做不了位图字体图集，且文字不该进每帧热路径）。
  // GL 不可用 / 着色器编译失败 → 返回 null，由引擎自动回落 Canvas2D（广色域发灰风险也能经此切回）。
  function createWebGLBackend(spec) {
    if (!global.GraphGL || !global.GraphGL.create) return null;
    const canvas = spec.canvas;
    // WebGL2 存在不代表驱动一定能编译/链接当前 shader。
    // 底层失败时返回 null，让 create() 按契约回落 Canvas2D，不让整个图谱初始化中断。
    let core = null;
    try { core = global.GraphGL.create(canvas); } catch (e) { core = null; }
    if (!core) return null;
    const NS = core.NODE_STRIDE;
    const ES = core.EDGE_STRIDE;
    const nodeStyle = spec.nodeStyle || defaultNodeStyle;
    const edgeStyle = spec.edgeStyle || defaultEdgeStyle;
    const cacheInstances = spec.cacheInstances === true;
    let lastNodeVersion = -1, lastEdgeVersion = -1;
    let nodeStorage = null, edgeStorage = null;
    let nodeCount = 0, edgeCount = 0;
    let lastNodeInputCount = -1, lastEdgeInputCount = -1;

    // 后备存储与 viewport 由 core.draw 按 dpr 负责，这里只回报 CSS 度量（与 Canvas2D 后端口径一致）
    function syncSize() {
      const cssW = canvas.clientWidth || 1;
      const cssH = canvas.clientHeight || 1;
      const dpr = global.devicePixelRatio || 1;
      return { cssW: cssW, cssH: cssH, dpr: dpr };
    }

    function draw(frame) {
      const nodes = frame.nodes;
      const edges = frame.edges;
      const cam = frame.cam;
      const size = frame.size;
      const unit = cam.unit, cssW = size.cssW, cssH = size.cssH, dpr = size.dpr;
      // 把 Canvas2D 的相机（offset→scale unit→平移 -view，再 ×dpr）折算成 clip 空间仿射：
      //   x_clip = a·wx + b , y_clip = c·wy + d（y 轴翻转）
      const a = 2 * unit / cssW;
      const b = 2 * (cam.offsetX - unit * cam.viewX) / cssW - 1;
      const c = -2 * unit / cssH;
      const d = 1 - 2 * (cam.offsetY - unit * cam.viewY) / cssH;
      const aaWorld = 1 / (unit * dpr);   // ≈1 设备像素对应的世界宽度，喂给 SDF 抗锯齿

      const pcount = frame.particleCount || 0;
      core.ensureCapacity(nodes.length + pcount, edges.length);   // 预留流光粒子的实例位
      const nd = core.nodeData;
      const ed = core.edgeData;
      const uploadNodes = !cacheInstances || frame.nodeInstancesVersion == null
        || frame.nodeInstancesVersion !== lastNodeVersion || nd !== nodeStorage
        || lastNodeInputCount !== nodes.length + pcount;
      const uploadEdges = !cacheInstances || frame.edgeInstancesVersion == null
        || frame.edgeInstancesVersion !== lastEdgeVersion || ed !== edgeStorage
        || lastEdgeInputCount !== edges.length;

      // 连线（在节点之下，先写）
      if (uploadEdges) {
        let ei = 0;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const s = nodes[e.source];
          const dn = nodes[e.target];
          if (!s || !dn) continue;
          const st = edgeStyle(e, s, dn, { highlighted: e._highlighted, dim: e._dim });
          const col = st.color || _NO_STROKE;
          const alpha = (col[3] == null ? 1 : col[3]) * Math.min(s._appearOpacity, dn._appearOpacity);
          const o = ei * ES;
          ed[o] = s._rx; ed[o + 1] = s._ry;
          ed[o + 2] = dn._rx; ed[o + 3] = dn._ry;
          ed[o + 4] = col[0]; ed[o + 5] = col[1]; ed[o + 6] = col[2]; ed[o + 7] = alpha;
          ed[o + 8] = st.width || 1;
          ei++;
        }
        edgeCount = ei;
        edgeStorage = ed;
        lastEdgeVersion = frame.edgeInstancesVersion;
        lastEdgeInputCount = edges.length;
      }
      // 节点
      if (uploadNodes) {
        let ni = 0;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const st = nodeStyle(n, {
            focus: n._focus, near: n._near, dim: n._dim, hovered: i === frame.focusIndex,
          });
          const fill = st.fill || _GRAY_FILL;
          const stroke = st.stroke || _NO_STROKE;
          const appS = n._appeared ? 1 : n._appearScale;
          const appO = n._appeared ? 1 : n._appearOpacity;
          const o = ni * NS;
          nd[o] = n._rx; nd[o + 1] = n._ry;
          nd[o + 2] = (st.r == null ? (n.r || 6) : st.r);
          nd[o + 3] = fill[0]; nd[o + 4] = fill[1]; nd[o + 5] = fill[2];
          nd[o + 6] = (fill[3] == null ? 1 : fill[3]) * appO;
          nd[o + 7] = stroke[0]; nd[o + 8] = stroke[1]; nd[o + 9] = stroke[2];
          nd[o + 10] = (stroke[3] == null ? 0 : stroke[3]) * appO;
          nd[o + 11] = st.strokeW || 0;
          nd[o + 12] = st.shape ? 1 : 0;
          nd[o + 13] = (st.scale == null ? 1 : st.scale) * appS;
          ni++;
        }
        // 粒子追加在节点实例之后，同一 draw call；关闭粒子时同步缩小实例数。
        for (let i = 0; i < pcount; i++) {
          const p = frame.particles[i];
          const o = ni * NS;
          nd[o] = p.x; nd[o + 1] = p.y; nd[o + 2] = p.r;
          nd[o + 3] = p.cr; nd[o + 4] = p.cg; nd[o + 5] = p.cb; nd[o + 6] = p.ca;
          nd[o + 7] = 0; nd[o + 8] = 0; nd[o + 9] = 0; nd[o + 10] = 0;
          nd[o + 11] = 0; nd[o + 12] = 0; nd[o + 13] = 1;
          ni++;
        }
        nodeCount = ni;
        nodeStorage = nd;
        lastNodeVersion = frame.nodeInstancesVersion;
        lastNodeInputCount = nodes.length + pcount;
      }
      core.draw(nodeCount, edgeCount,
        { xform: [a, b, c, d], aaWorld: aaWorld, dpr: dpr, cssW: cssW, cssH: cssH },
        { nodes: uploadNodes, edges: uploadEdges });
    }

    function destroy() { try { core.destroy(); } catch (e) {} }

    return { kind: 'webgl', syncSize: syncSize, draw: draw, destroy: destroy };
  }

  // ───────────────────────────── 引擎实例 ─────────────────────────────
  function create(options) {
    const opts = options || {};
    let canvas = opts.canvas;
    if (!canvas || !canvas.getContext) return null;
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const VIEW_W = cfg.viewW;
    const VIEW_H = cfg.viewH;
    const CENTER_X = VIEW_W / 2;
    const CENTER_Y = VIEW_H / 2;
    const theta2 = cfg.theta * cfg.theta;
    const IDLE_FRAME_MS = 1000 / (cfg.idleFps || 30);   // 闲时微动渲染最小间隔

    const drawNode = opts.drawNode || function () {};
    const drawEdge = opts.drawEdge || function () {};
    const getEdgeRest = opts.getEdgeRest || function () { return cfg.springRest; };
    const getGravity = opts.getGravity || function () { return cfg.gravity; };
    const onNodeClick = opts.onNodeClick || function () {};
    const onNodeHover = opts.onNodeHover || function () {};
    const onConverge = opts.onConverge || function () {};
    let drift = opts.drift || null;          // { speed, amp: fn(node)->number }；可被 setDrift 运行时切换
    let particleCfg = opts.particles || null; // { speed, perEdge, size, getColor(edge,s,d)->[r,g,b,a]|null }；连线流光，可被 setParticles 切换
    const drawOverlay = opts.drawOverlay || null;  // 顶层 2D 叠加层绘制回调（标签/光晕/扇形）
    let reduceMotion = !!opts.reduceMotion;

    // 渲染后端：默认 Canvas 2D；opts.backend 可传工厂函数，或字符串 'webgl' / 'canvas2d'。
    // 选 WebGL 但 GL 不可用 / 着色器编译失败时 backend 为 null → 自动回落 Canvas2D（兜底，不崩）。
    // 接口三件套一致：syncSize / draw / destroy。Canvas2D 用命令式 drawNode/drawEdge，
    // WebGL 用声明式 nodeStyle/edgeStyle 描述符，二者各取所需、互不影响。
    const backendSpec = {
      canvas: canvas, drawNode: drawNode, drawEdge: drawEdge,
      nodeStyle: opts.nodeStyle, edgeStyle: opts.edgeStyle,
      cacheInstances: opts.cacheInstances === true,
    };
    const makeBackend = (typeof opts.backend === 'function') ? opts.backend
      : (opts.backend === 'webgl') ? createWebGLBackend
      : createCanvas2DBackend;
    let backend = makeBackend(backendSpec);
    if (!backend && makeBackend !== createCanvas2DBackend) {
      backend = createCanvas2DBackend(backendSpec);   // 回落兜底
      // shader 失败时原 canvas 已被 WebGL 锁定，不能再取得 2D context。
      // 换用未绑定 context 的画布，再通知宿主更新闭包引用与后续资源释放目标。
      if (!backend && canvas.cloneNode && canvas.replaceWith) {
        const oldCanvas = canvas;
        canvas = oldCanvas.cloneNode(false);
        canvas.width = canvas.height = 1;
        oldCanvas.replaceWith(canvas);
        try { oldCanvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) {}
        oldCanvas.width = oldCanvas.height = 1;
        backendSpec.canvas = canvas;
        if (typeof opts.onCanvasReplace === 'function') opts.onCanvasReplace(canvas, oldCanvas);
        backend = createCanvas2DBackend(backendSpec);
      }
    }
    if (!backend) return null;

    // —— 顶层标签层：支持两种后端 ——
    // 1) DOM 标签层（domOverlay，推荐）：适配层创建 DOM 元素，引擎每帧调 sync() 更新 CSS transform。
    //    GPU compositor 处理合成，不触发 paint；文字渲染由浏览器负责（sub-pixel AA）。
    // 2) 2D Canvas 叠加层（drawOverlay，旧方案）：引擎管理透明 canvas，适配层用 octx 回调绘制。
    //    每帧需要 Canvas 2D 文字光栅化，CPU 开销大，仅作 fallback。
    // 拖动 / 缩放 / 进场时 labelAlpha→0 淡出标签，停下淡入。
    const domOverlay = opts.domOverlay || null;
    let overlayCanvas = null;
    let octx = null;
    let labelAlpha = 0;
    let labelTarget = 0;
    const _hasLabels = !!(drawOverlay || domOverlay);  // 是否有标签层（影响交互时的淡入淡出逻辑）
    const alwaysShowLabels = opts.labelVisibility === 'always';
    // Canvas 叠加层仅当适配层提供 drawOverlay 且无 domOverlay、且后端非 canvas2d 时启用
    if (drawOverlay && !domOverlay && backend && backend.kind !== 'canvas2d') {
      overlayCanvas = global.document.createElement('canvas');
      overlayCanvas.className = 'graph-label-overlay';
      overlayCanvas.setAttribute('aria-hidden', 'true');
      overlayCanvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
      const parent = canvas.parentNode;
      if (parent) parent.insertBefore(overlayCanvas, canvas.nextSibling);
      octx = overlayCanvas.getContext('2d');
    }

    let nodes = [];
    let edges = [];
    let positionVersion = 0;
    let nodeInstancesVersion = 0;
    let edgeInstancesVersion = 0;
    let renderedPositionVersion = -1;
    let renderedDrift = false;
    let lastParticleCount = 0;
    function invalidateStyles() { nodeInstancesVersion++; edgeInstancesVersion++; }
    function invalidatePositions() { positionVersion++; invalidateStyles(); }
    let neighbors = [];
    let _partPool = [];        // 流光粒子复用池（零分配）：{ x,y,r,cr,cg,cb,ca }
    let draggedNode = null;
    let panOrigin = null;
    let pressInfo = null;
    let frameId = 0;
    let renderFrameId = 0;     // 收敛后的单次重绘，与连续物理/动画帧互斥
    let lastTickTime = 0;
    let lastRenderT = 0;      // 上次真正重画的时刻（闲时节流用）
    let tickCount = 0;
    let alpha = 0;
    let introActive = false;
    let presolveJob = null;
    function restorePresolveSeed(job) {
      job.nodes.forEach(function (node, i) {
        node.x = job.x[i]; node.y = job.y[i]; node.vx = node.vy = 0; node._rx = node.x; node._ry = node.y;
      });
      invalidatePositions();
    }
    function cancelPresolve(retain) {
      const job = presolveJob;
      if (!job) return;
      global.clearTimeout(job.timer);
      presolveJob = null; presolving = false;
      restorePresolveSeed(job);
      if (retain && !destroyed && nodes === job.nodes) pending = { intro: job.intro, fit: job.fit };
    }
    let presolving = false;    // 进场预解算（提前取景）期间为真：此时也施加 introVelocityClamp，
                               // 否则种子偶发近重合(<1px)会让反平方斥力炸飞整张图→fit 取到垃圾布局
    let idle = false;          // 收敛后进入闲时微漂移（仅当配置了 drift）
    let driftGain = 0;         // 漂移强度包络(0..1)：平滑淡入/淡出，避免缩放/拖拽/首次收敛时位置突跳
    let viewX = 0, viewY = 0, viewScale = 1;
    let dragVel = { x: 0, y: 0 };
    // —— 视图平移松手惯性（与画布 canvas.js 同口径；panInertia=0 关闭，星图不调 setPanInertia 即保持原样）——
    let panInertia = 0;
    let panVelScreen = { x: 0, y: 0 };   // 屏幕 px/ms 的平移速度（EMA）
    let panLast = null;                  // { x, y, t } 上一次平移采样
    let panLastMoveT = 0;
    const panGlide = { active: false, vx: 0, vy: 0, last: 0 };
    let lastFocusIndex = -1;
    let userAdjustedView = false;
    let autoFitPending = false;
    let destroyed = false;
    const observeTarget = opts.observe || null;
    let active = !(opts.active === false);
    let visible = !observeTarget;   // 若交了 stage 给 IO 观察，则初始不可见、待 IO 唤醒
    let pending = null;            // 待触发的进场参数（延到 active && visible 才执行）
    let io = null;
    let ro = null;
    const zoomTween = { active: false, target: 1, sx: 0, sy: 0, ax: 0, ay: 0 };
    const fitTween = { active: false, x: 0, y: 0, scale: 1 };

    // —— 视口度量：复刻 SVG viewBox + preserveAspectRatio="xMidYMid meet"（等比缩放并居中）——
    function metrics() {
      const cssW = canvas.clientWidth || 1;
      const cssH = canvas.clientHeight || 1;
      const baseUnit = Math.min(cssW / VIEW_W, cssH / VIEW_H);
      const unit = baseUnit * viewScale;
      const offsetX = (cssW - (VIEW_W * baseUnit)) / 2;
      const offsetY = (cssH - (VIEW_H * baseUnit)) / 2;
      return { cssW: cssW, cssH: cssH, unit: unit, offsetX: offsetX, offsetY: offsetY };
    }
    function screenToWorld(sx, sy) {
      const m = metrics();
      return { x: viewX + (sx - m.offsetX) / m.unit, y: viewY + (sy - m.offsetY) / m.unit };
    }

    function cancelRenderFrame() {
      if (renderFrameId) global.cancelAnimationFrame(renderFrameId);
      renderFrameId = 0;
    }
    function stopLoop() {
      cancelPresolve(true);
      if (frameId) global.cancelAnimationFrame(frameId);
      frameId = 0;
      cancelRenderFrame();
      lastTickTime = 0;
    }

    // —— 数据装载：node 需带 x,y,r（适配层先 seed 好坐标）；引擎补上运行期字段 ——
    function setData(nextNodes, nextEdges, dataOptions) {
      cancelPresolve(false);
      // 数据集切换不能让旧指针手势继续拖动旧节点、或以旧数组下标点击新节点。
      if (pressInfo && canvas.hasPointerCapture(pressInfo.pointerId)) canvas.releasePointerCapture(pressInfo.pointerId);
      pressInfo = draggedNode = panOrigin = null;
      panLast = null;
      cancelPanGlide();
      const armIntro = !!(dataOptions && dataOptions.intro);
      nodes = nextNodes || [];
      edges = nextEdges || [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.vx = 0; n.vy = 0;
        n._fx = 0; n._fy = 0;
        n._rx = n.x; n._ry = n.y;
        n._phase = Math.random() * Math.PI * 2;
        n._appeared = !armIntro;
        n._appearScale = armIntro ? 0.4 : 1;
        n._appearOpacity = armIntro ? 0 : 1;
        n._focus = false; n._near = false; n._dim = false;
      }
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        e._highlighted = false; e._dim = false;
        e._flowPhase = Math.random();   // 每条边的流光起始相位，避免所有光点齐步走
      }
      neighbors = nodes.map(function () { return new Set(); });
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (neighbors[e.source]) neighbors[e.source].add(e.target);
        if (neighbors[e.target]) neighbors[e.target].add(e.source);
      }
      lastFocusIndex = -1;
      if (alwaysShowLabels) labelAlpha = labelTarget = nodes.length ? 1 : 0;
      invalidatePositions();
    }

    // —— 物理一帧 —— （斥力换四叉树，其余弹簧/引力/阻尼/积分沿用旧口径）
    function runPhysics(dt) {
      alpha += (0 - alpha) * cfg.alphaDecay * (draggedNode ? 0.45 : 1) * dt;
      const a = alpha;
      // 斥力：建树 → 逐节点查询累加 → 应用（被拖拽节点仍进树施力，但自身不受力）
      const quad = buildQuad(nodes);
      for (let i = 0; i < nodes.length; i++) { nodes[i]._fx = 0; nodes[i]._fy = 0; }
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i] !== draggedNode) applyRepulsion(nodes[i], quad, theta2, cfg.repulsion, a);
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === draggedNode) continue;
        n.vx += n._fx; n.vy += n._fy;
      }
      // 连线弹簧
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const first = nodes[e.source];
        const second = nodes[e.target];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const force = cfg.spring * (distance - getEdgeRest(e)) * a;
        const fx = force * dx / distance;
        const fy = force * dy / distance;
        if (first !== draggedNode) { first.vx += fx; first.vy += fy; }
        if (second !== draggedNode) { second.vx -= fx; second.vy -= fy; }
      }
      // 向心引力 + 阻尼 + 积分
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === draggedNode) continue;
        const g = getGravity(n);
        n.vx += (CENTER_X - n.x) * g * a;
        n.vy += (CENTER_Y - n.y) * g * a;
        n.vx *= cfg.velocityDamp;
        n.vy *= cfg.velocityDamp;
        if ((introActive || presolving) && cfg.introVelocityClamp > 0) {
          const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
          if (speed > cfg.introVelocityClamp) {
            const k = cfg.introVelocityClamp / speed;
            n.vx *= k;
            n.vy *= k;
          }
        }
        n.x += n.vx * dt;
        n.y += n.vy * dt;
      }
      invalidatePositions();
    }

    function updateIntro(t) {
      let busy = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n._appeared) continue;
        const p = clamp((t - n._born) / cfg.introMs, 0, 1);
        n._appearScale = 0.4 + easeOut(p) * 0.6;
        n._appearOpacity = easeOut(Math.min(1, p * 1.25));
        if (p >= 1) { n._appeared = true; n._appearScale = 1; n._appearOpacity = 1; }
        else busy = true;
      }
      introActive = busy;
      // 连线透明度也取决于端点入场进度，不能只更新节点实例。
      invalidateStyles();
      return busy;
    }

    function computeFit() {
      if (!nodes.length) return { x: 0, y: 0, scale: 1 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const pad = (n.r || 6) + cfg.fitPad;
        minX = Math.min(minX, n.x - pad);
        minY = Math.min(minY, n.y - pad);
        maxX = Math.max(maxX, n.x + pad);
        maxY = Math.max(maxY, n.y + pad);
      }
      const width = (maxX - minX) + cfg.fitMargin * 2;
      const height = (maxY - minY) + cfg.fitMargin * 2;
      const scale = clamp(Math.min(VIEW_W / width, VIEW_H / height), cfg.fitScaleMin, cfg.fitScaleMax);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      return { x: cx - (VIEW_W / scale) / 2, y: cy - (VIEW_H / scale) / 2, scale: scale };
    }
    function fitView(animated) {
      const target = computeFit();
      zoomTween.active = false;
      cancelPanGlide();
      if (animated && !reduceMotion) {
        fitTween.x = target.x; fitTween.y = target.y; fitTween.scale = target.scale;
        fitTween.active = true;
        ensureLoop();
      } else {
        fitTween.active = false;
        viewX = target.x; viewY = target.y; viewScale = target.scale;
        requestFrame();
      }
    }
    function fitViewSilently() {
      const target = computeFit();
      zoomTween.active = false;
      cancelPanGlide();
      fitTween.active = false;
      viewX = target.x; viewY = target.y; viewScale = target.scale;
    }
    function visibleNodeCount() {
      if (!nodes.length) return 0;
      const m = metrics();
      let count = 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if ((n._appearOpacity || 0) <= 0.02) continue;
        const sx = (n.x - viewX) * m.unit + m.offsetX;
        const sy = (n.y - viewY) * m.unit + m.offsetY;
        const pad = ((n.r || 6) + cfg.fitPad) * m.unit;
        if (sx >= -pad && sx <= m.cssW + pad && sy >= -pad && sy <= m.cssH + pad) count++;
      }
      return count;
    }
    function updateFit(dt) {
      const factor = reduceMotion ? 1 : Math.min(1, cfg.fitEase * dt);
      viewX += (fitTween.x - viewX) * factor;
      viewY += (fitTween.y - viewY) * factor;
      viewScale += (fitTween.scale - viewScale) * factor;
      if (Math.abs(fitTween.scale - viewScale) < 0.0015
          && Math.abs(fitTween.x - viewX) < 0.5
          && Math.abs(fitTween.y - viewY) < 0.5) {
        viewX = fitTween.x; viewY = fitTween.y; viewScale = fitTween.scale;
        fitTween.active = false;
      }
    }
    function updateZoom(dt) {
      const factor = reduceMotion ? 1 : Math.min(1, cfg.zoomEase * dt);
      viewScale += (zoomTween.target - viewScale) * factor;
      if (Math.abs(zoomTween.target - viewScale) < 0.0015) {
        viewScale = zoomTween.target;
        zoomTween.active = false;
      }
      // 每帧按当前缩放重算，使光标锚点始终钉住同一世界坐标
      const m = metrics();
      viewX = zoomTween.ax - (zoomTween.sx - m.offsetX) / m.unit;
      viewY = zoomTween.ay - (zoomTween.sy - m.offsetY) / m.unit;
    }

    // —— 视图平移惯性：松手后相机按延续速度滑行、带时间无关摩擦优雅停（口径同 canvas.js）——
    function cancelPanGlide() { panGlide.active = false; }
    function startPanGlide() {
      if (!(panInertia > 0)) return;
      if (!panLastMoveT || (now() - panLastMoveT) > 60) return;   // 松手前已停顿=放下，不甩
      let vx = panVelScreen.x * panInertia;
      let vy = panVelScreen.y * panInertia;
      let speed = Math.sqrt(vx * vx + vy * vy);
      if (speed < 0.06) return;                                   // 太慢不甩，避免轻触也滑
      const MAX_V = 5;
      if (speed > MAX_V) { const k = MAX_V / speed; vx *= k; vy *= k; }
      panGlide.vx = vx; panGlide.vy = vy; panGlide.last = now(); panGlide.active = true;
      ensureLoop();
    }
    function updatePanGlide(t) {
      let dtMs = t - panGlide.last; panGlide.last = t;
      if (!(dtMs > 0)) dtMs = cfg.frameMs;
      if (dtMs > 40) dtMs = 40;                                   // 掉帧/切后台不暴冲
      const f = Math.exp(-0.0045 * dtMs);                         // 约 0.7s 滑停，与画布一致
      const m = metrics();
      viewX -= (panGlide.vx * dtMs) / m.unit;                     // 与 pointermove 平移同号
      viewY -= (panGlide.vy * dtMs) / m.unit;
      panGlide.vx *= f; panGlide.vy *= f;
      if (Math.sqrt(panGlide.vx * panGlide.vx + panGlide.vy * panGlide.vy) < 0.015) panGlide.active = false;
    }

    // —— 渲染一帧 —— 引擎算相机 + 闲时漂移坐标，绘制委托给当前后端
    function render() {
      if (destroyed) return;
      const size = backend.syncSize();
      const m = metrics();
      const t = (driftGain > 0.001 && !reduceMotion) ? now() : 0;
      const drifting = !!(t && drift);
      // 计算渲染坐标（叠加闲时漂移×包络）→ 写入 n._rx/_ry，命中检测与后端绘制共用
      // 用 driftGain 而非 idle 把关：缩放时 idle 被关掉但 driftGain 不掉，节点不会被瞬间抹掉漂移而"瞬移"。
      if (renderedPositionVersion !== positionVersion || drifting || renderedDrift !== drifting) {
        // 漂移停止的首帧必须还原基础坐标；静止相机帧不逐节点改写 _rx/_ry。
        if (drifting || renderedDrift !== drifting) invalidatePositions();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          let dx = n.x, dy = n.y;
          if (drifting && n !== draggedNode) {
            const amp = (drift.amp ? drift.amp(n) : 0) * driftGain;
            if (amp) {
              dx += Math.sin(t * drift.speed + n._phase) * amp;
              dy += Math.cos(t * drift.speed * 0.86 + n._phase) * amp;
            }
          }
          n._rx = dx; n._ry = dy;
        }
        renderedPositionVersion = positionVersion;
        renderedDrift = drifting;
      }
      // —— 连线流光：沿每条边从 source→target 推进的小光点（适配层把 source 建成更靠中心的一端 → 向外发散）——
      // 用 _rx/_ry（已含漂移）定位，所以光点跟着边一起呼吸；端点 sin(πf) 淡入淡出、不在节点处突现。
      let partCount = 0;
      if (particleCfg && !reduceMotion && !introActive) {
        const pt = now();
        const spd = particleCfg.speed || 0.0002;
        const per = particleCfg.perEdge || 1;
        const psize = particleCfg.size || 2.4;
        const getColor = particleCfg.getColor;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const s = nodes[e.source];
          const d = nodes[e.target];
          if (!s || !d || e._dim) continue;                  // 邻域高亮时非聚焦边不发光，聚焦更清楚
          const col = getColor ? getColor(e, s, d) : particleCfg.color;
          if (!col) continue;
          const baseA = (col[3] == null ? 1 : col[3]);
          for (let k = 0; k < per; k++) {
            let f = pt * spd + e._flowPhase + k / per;
            f -= Math.floor(f);                              // frac → [0,1)
            const fade = Math.sin(Math.PI * f);              // 两端淡、中段亮
            if (fade < 0.03) continue;
            let p = _partPool[partCount];
            if (!p) { p = { x: 0, y: 0, r: 0, cr: 0, cg: 0, cb: 0, ca: 0 }; _partPool[partCount] = p; }
            p.x = s._rx + (d._rx - s._rx) * f;
            p.y = s._ry + (d._ry - s._ry) * f;
            p.r = psize * (0.6 + 0.4 * fade);
            p.cr = col[0]; p.cg = col[1]; p.cb = col[2]; p.ca = baseA * fade;
            partCount++;
          }
        }
      }
      if (partCount || partCount !== lastParticleCount || opts.nodeStyleTimeDependent) nodeInstancesVersion++;
      lastParticleCount = partCount;
      if (opts.edgeStyleTimeDependent) edgeInstancesVersion++;
      backend.draw({
        nodes: nodes,
        edges: edges,
        cam: { offsetX: m.offsetX, offsetY: m.offsetY, unit: m.unit, viewX: viewX, viewY: viewY },
        introActive: introActive,
        focusIndex: lastFocusIndex,
        particles: _partPool,
        particleCount: partCount,
        size: size,
        positionVersion: positionVersion,
        nodeInstancesVersion: nodeInstancesVersion,
        edgeInstancesVersion: edgeInstancesVersion,
      });
      // DOM 标签层：适配层可用版本跳过不变坐标，再用容器 transform 投影相机。
      // 默认仅 WebGL 启用；笔记显式开启 2D 后端共用标签时，drawNode 不再重复画字。
      // 始终调用 sync——由 sync 内部根据 labelAlpha 决定显隐，避免 pointerdown 瞬间置 0
      // 时跳过调用导致 DOM 元素残留上一次的 opacity。
      if (domOverlay && backend && (backend.kind !== 'canvas2d' || opts.domOverlayOnCanvas2D)) {
        domOverlay.sync({
          nodes: nodes, edges: edges, focusIndex: lastFocusIndex,
          labelAlpha: labelAlpha, scale: viewScale, unit: m.unit,
          reduceMotion: reduceMotion,
          viewX: viewX, viewY: viewY,
          offsetX: m.offsetX, offsetY: m.offsetY,
          cssW: m.cssW, cssH: m.cssH,
          positionVersion: positionVersion,
          nodeInstancesVersion: nodeInstancesVersion,
          edgeInstancesVersion: edgeInstancesVersion,
        });
      }
      // 2D Canvas 叠加层（旧方案，仅当无 domOverlay 时使用）
      // 闲时漂移每帧位移 <0.05px，跳过 2/3 的 2D 重绘大幅降低 CPU 开销；标签过渡中或交互中每帧重绘保证跟手
      if (octx) {
        const labelTransitioning = Math.abs(labelAlpha - labelTarget) > 0.006;
        if (!idle || reduceMotion || labelTransitioning || (tickCount % 3 === 0)) {
          const needW = Math.max(1, Math.round(size.cssW * size.dpr));
          const needH = Math.max(1, Math.round(size.cssH * size.dpr));
          if (overlayCanvas.width !== needW) overlayCanvas.width = needW;
          if (overlayCanvas.height !== needH) overlayCanvas.height = needH;
          octx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
          octx.clearRect(0, 0, size.cssW, size.cssH);
          if (drawOverlay && labelAlpha > 0.012) {
            octx.translate(m.offsetX, m.offsetY);
            octx.scale(m.unit, m.unit);
            octx.translate(-viewX, -viewY);
            octx.lineCap = 'round';
            octx.lineJoin = 'round';
            // 适配层在世界坐标下画标签 / 光晕 / 扇形；自行把 labelAlpha 乘进透明度、按 scale 做 LOD
            drawOverlay(octx, {
              nodes: nodes, edges: edges, focusIndex: lastFocusIndex,
              labelAlpha: labelAlpha, scale: viewScale, unit: m.unit,
            });
          }
        }
      }
    }
    // 单帧重绘（用于收敛后的悬停 / 平移 / 拖拽，避免空转 RAF）
    function tryBeginPending() {
      if (pending && canBegin()) {
        doBegin();
        return true;
      }
      return false;
    }
    function requestRender() {
      // 外部调用者可在原地修改主题/外观，保留下一帧完整刷新样式的旧契约。
      invalidateStyles();
      requestFrame();
    }
    function requestFrame() {
      if (presolveJob) return;
      lastRenderT = 0;          // 打断闲时节流：让下一拍立即重画（悬停高亮 / 平移即时跟手）
      if (tryBeginPending()) return;
      if (!active || !visible || destroyed) return;
      if (!frameId && !renderFrameId) {
        renderFrameId = global.requestAnimationFrame(function () {
          renderFrameId = 0;
          if (active && visible && !destroyed && !presolveJob && !frameId) render();
        });
      }
    }

    function tick(t) {
      // 当前回调也算在途帧；fit/onConverge 等重入请求由本帧及收尾统一接管。
      tickCount++;
      if (destroyed) { frameId = 0; return; }
      if (!lastTickTime) lastTickTime = t - cfg.frameMs;
      // 闲时微动封顶到 idleFps：当唯一在动的只是漂移/呼吸/闪烁（无物理/进场/缩放/平移惯性/拖拽/标签淡变）时，
      // 高刷屏不必每一拍都重画整图——慢动作下 30fps 与 144fps 肉眼无差，却能把闲时 GPU 占用压到约 1/5。
      // 交互（悬停/平移/缩放）会把 lastRenderT 清零（见 requestRender），下一拍即时跟手、不吃这道节流。
      if (idle && !draggedNode && !introActive && !zoomTween.active && !fitTween.active
          && !panGlide.active && alpha <= cfg.alphaMin
          && !(_hasLabels && Math.abs(labelAlpha - labelTarget) > 0.006)) {
        if ((t - lastRenderT) < IDLE_FRAME_MS) { frameId = global.requestAnimationFrame(tick); return; }
      }
      let dt = (t - lastTickTime) / cfg.frameMs;
      lastTickTime = t;
      lastRenderT = t;
      if (dt < 0.01) dt = 0.01;
      if (dt > 2.4) dt = 2.4;

      const physicsBusy = alpha > cfg.alphaMin || !!draggedNode;
      if (physicsBusy) runPhysics(dt);
      const wasIntro = introActive;
      if (introActive) updateIntro(t);
      if (zoomTween.active) updateZoom(dt);
      if (fitTween.active) updateFit(dt);
      if (panGlide.active) updatePanGlide(t);
      if (autoFitPending && !userAdjustedView && !draggedNode && alpha < 0.05) {
        autoFitPending = false;
        fitView(true);
        onConverge();
      }
      if (!introActive && !userAdjustedView && !draggedNode && !fitTween.active
          && !zoomTween.active && alpha < 0.05 && nodes.length && visibleNodeCount() === 0) {
        fitViewSilently();
      }
      // 收敛 + 配了 drift 或 流光 → 进入闲时循环（拖拽 / 视野动画期间不进）。
      // 关键：用 runPhysics 之后的实时 alpha 判定（而非帧首的 physicsBusy）——alpha 跨过 alphaMin 的那一帧
      // 也能即时 latch idle，否则该帧 keepGoing 会先变 false 把循环停掉，导致首次收敛后漂移/流光不动、
      // 非得缩放或拖一下才"复活"（首开静止 bug 的根因）。
      if (!idle && (drift || particleCfg) && alpha <= cfg.alphaMin && !draggedNode && !introActive
          && !zoomTween.active && !fitTween.active && !reduceMotion && nodes.length && !panGlide.active) {
        idle = true;
      }
      // 漂移强度包络：与物理能量做「交叉淡入」——物理熄火(alpha 从 driftFadeAlpha 衰到 alphaMin)的同时，
      // 漂移由 0 平滑点亮；smoothstep 让两端导数为 0，于是没有"先彻底停住、再一瞬间全体启动"的突兀感
      // （而非过去那种 alpha 跨过 alphaMin 才硬启动、起步速度突跳）。进场/拖拽/reduceMotion 时目标为 0；
      // 缩放时 idle 被关但 alpha 仍 ≤ alphaMin → 目标恒 1，漂移不掉（保留上一版去瞬移的效果）。
      let driftTarget = 0;
      if (!reduceMotion && !introActive && !draggedNode) {
        const span = cfg.driftFadeAlpha - cfg.alphaMin;
        let f = span > 0 ? (cfg.driftFadeAlpha - alpha) / span : (alpha <= cfg.alphaMin ? 1 : 0);
        f = clamp(f, 0, 1);
        driftTarget = f * f * (3 - 2 * f);   // smoothstep：两端导数为 0，淡入/淡出无速度突跳
      }
      // 仍保留一阶缓动：负责抓起/进场时目标骤降到 0 的平滑淡出（淡入已由上面的曲线保证顺滑）。
      driftGain += (driftTarget - driftGain) * Math.min(1, 0.12 * dt);

      // 标签叠加层：交互 / 进场 / 高温铺开时藏（→0），手停下来淡入（→1）
      if (_hasLabels) {
        if (reduceMotion || alwaysShowLabels) {
          labelAlpha = labelTarget = (nodes.length ? 1 : 0);   // 减少动效：标签恒显、不做淡入淡出
        } else {
          const interacting = !!draggedNode || !!panOrigin || zoomTween.active
            || fitTween.active || introActive || alpha > cfg.labelHideAlpha || panGlide.active;
          labelTarget = interacting ? 0 : 1;
          labelAlpha += (labelTarget - labelAlpha) * Math.min(1, cfg.labelEase * dt);
        }
      }

      render();

      const labelBusy = _hasLabels && Math.abs(labelAlpha - labelTarget) > 0.006;
      const keepGoing = (alpha > cfg.alphaMin) || draggedNode || introActive
        || zoomTween.active || fitTween.active || idle || labelBusy || panGlide.active;
      if (!destroyed && active && visible && keepGoing) {
        frameId = global.requestAnimationFrame(tick);
      } else {
        lastTickTime = 0;
        if (wasIntro && !introActive) render();  // 进场末帧补绘，抹平残留缩放
        frameId = 0;
      }
    }
    function ensureLoop() {
      if (presolveJob) return;
      if (tryBeginPending()) return;
      if (!frameId && !destroyed && active && visible) {
        cancelRenderFrame();   // 动画帧会绘制最新状态，不再另排一次同帧重绘
        frameId = global.requestAnimationFrame(tick);
      }
    }
    function heat(amount) {
      alpha = Math.max(alpha, amount);
      idle = false;
      ensureLoop();
    }
    function kick() { heat(cfg.alphaReheat); }

    // —— 进场：延到 active && visible 才真正开跑（隐藏时不白烧动画 / RAF）——
    function canBegin() { return active && visible && !destroyed && nodes.length > 0; }
    function doBegin() {
      if (!pending) return;
      cancelRenderFrame();
      const introWanted = pending.intro;
      const fitWanted = pending.fit;
      pending = null;
      idle = false;
      // 进场 + 需取景（星图首开命中）：预解算只为「提前取景」——先在不渲染的情况下把布局推到收敛，
      // 按最终布局 instant 定格镜头，随后把节点还原回种子位形、重新升温，让「铺开生长」的全过程
      // 在已固定的镜头里完整可见。进场动画与旧版完全一致，只是结尾不再有二次缩放（首开缩放的根因）。
      // 图谱开图(fit:false)/relax(intro:false)/reduceMotion/超大规模 都不走这条，行为与旧版一致。
      const usePresolve = introWanted && fitWanted && !reduceMotion && nodes.length <= cfg.presolveMaxNodes;
      if (usePresolve) {
        if (frameId) global.cancelAnimationFrame(frameId);
        frameId = 0;
        const job = { nodes: nodes, x: nodes.map(n => n.x), y: nodes.map(n => n.y), step: 0, timer: 0, intro: introWanted, fit: fitWanted };
        presolveJob = job;
        alpha = 1;
        presolving = true;
        function slice() {
          if (presolveJob !== job || destroyed || nodes !== job.nodes) return;
          if (!active || !visible) { cancelPresolve(true); return; }
          const started = now();
          do { runPhysics(1); job.step++; }
          while (job.step < cfg.presolveSteps && alpha > cfg.alphaMin && now() - started < 4);
          if (job.step < cfg.presolveSteps && alpha > cfg.alphaMin) { job.timer = global.setTimeout(slice, 0); return; }
          presolveJob = null; presolving = false;
          if (!userAdjustedView) fitView(false);
          autoFitPending = false;
          restorePresolveSeed(job);
          finishBegin(introWanted && !reduceMotion);
        }
        job.timer = global.setTimeout(slice, 0);
        return;
      } else {
        autoFitPending = fitWanted && cfg.finalFitOnConverge !== false;
      }
      finishBegin(introWanted);
    }
    function finishBegin(introWanted) {
      alpha = 1;
      const t = now();   // 预布局全部完成后才启动进场时钟。
      introActive = introWanted;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n._born = t + i * cfg.introStagger;
        if (introWanted) { n._appeared = false; n._appearScale = 0.4; n._appearOpacity = 0; }
        else { n._appeared = true; n._appearScale = 1; n._appearOpacity = 1; }
      }
      kick();
      invalidateStyles();
      requestFrame();
    }
    // start({intro,fit})：开图 / 重排都走这里。intro 默认开、fit 默认开。
    function start(o) {
      cancelPresolve(false);
      o = o || {};
      const introWanted = o.intro !== false && !reduceMotion && nodes.length > 0;
      pending = { intro: introWanted, fit: o.fit !== false && nodes.length > 0 };
      userAdjustedView = false;
      zoomTween.active = false;
      fitTween.active = false;
      cancelPanGlide();
      resetView();
      // 先按「未登场」预置一帧静态（若要进场），可见时再由 doBegin 生长
      if (introWanted) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          n._appeared = false; n._appearScale = 0.4; n._appearOpacity = 0;
        }
      }
      // 舒展按钮会先原地播种；start 必须同步使渲染坐标缓存失效。
      invalidatePositions();
      refreshObservedVisibility();
      if (canBegin()) doBegin();
      else requestFrame();
    }
    function resetView() { viewX = 0; viewY = 0; viewScale = 1; }

    // Restore a host's session camera without invalidating node/edge instances.
    function restoreView(view) {
      if (destroyed || !view || !Number.isFinite(view.x) || !Number.isFinite(view.y)
          || !Number.isFinite(view.scale) || view.scale <= 0) return false;
      zoomTween.active = false;
      fitTween.active = false;
      cancelPanGlide();
      userAdjustedView = true;
      autoFitPending = false;
      if (pending) pending.fit = false;
      viewX = view.x; viewY = view.y;
      viewScale = clamp(view.scale, cfg.zoomMin, cfg.zoomMax);
      requestFrame();
      return true;
    }

    // ───────────────────────── 命中检测 / 交互 ─────────────────────────
    function nodeAtClient(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const w = screenToWorld(clientX - rect.left, clientY - rect.top);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const dx = w.x - n._rx;
        const dy = w.y - n._ry;
        const reach = (n.r || 6) + cfg.hitPad;
        const d = dx * dx + dy * dy;
        if (d <= reach * reach && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    function clearHighlight() {
      for (let i = 0; i < nodes.length; i++) {
        nodes[i]._focus = false; nodes[i]._near = false; nodes[i]._dim = false;
      }
      for (let i = 0; i < edges.length; i++) {
        edges[i]._highlighted = false; edges[i]._dim = false;
      }
    }
    function highlightNeighborhood(index) {
      const near = neighbors[index] || new Set();
      for (let i = 0; i < nodes.length; i++) {
        const focus = i === index;
        const isNear = near.has(i);
        nodes[i]._focus = focus;
        nodes[i]._near = isNear;
        nodes[i]._dim = !focus && !isNear;
      }
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const involved = e.source === index || e.target === index;
        e._highlighted = involved;
        e._dim = !involved;
      }
    }
    function hover(event) {
      if (draggedNode || panOrigin) return;
      const index = nodeAtClient(event.clientX, event.clientY);
      if (index < 0) {
        if (lastFocusIndex !== -1) { clearHighlight(); lastFocusIndex = -1; onNodeHover(null, event); requestRender(); }
        return;
      }
      if (index !== lastFocusIndex) {
        highlightNeighborhood(index);
        lastFocusIndex = index;
        onNodeHover(nodes[index], event);
        requestRender();
      } else {
        onNodeHover(nodes[index], event);  // 仍停同一节点，仅刷新 tooltip 位置
      }
    }

    function handlePointerDown(event) {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      cancelPanGlide();                                  // 抓起即停惯性滑行（抓手感，像 Figma/画布）
      if (_hasLabels && !reduceMotion && !alwaysShowLabels) labelAlpha = 0;
      const index = nodeAtClient(event.clientX, event.clientY);
      if (index >= 0) {
        draggedNode = nodes[index];
        dragVel.x = 0; dragVel.y = 0;
        idle = false;
        pressInfo = { kind: 'node', pointerId: event.pointerId, index: index, x: event.clientX, y: event.clientY, moved: false };
        kick();
      } else {
        panOrigin = { clientX: event.clientX, clientY: event.clientY, viewX: viewX, viewY: viewY };
        pressInfo = { kind: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        panVelScreen.x = 0; panVelScreen.y = 0;
        panLast = { x: event.clientX, y: event.clientY, t: now() };
        panLastMoveT = 0;
      }
    }
    function handlePointerMove(event) {
      if (pressInfo && !pressInfo.moved) {
        const dx = event.clientX - pressInfo.x;
        const dy = event.clientY - pressInfo.y;
        pressInfo.moved = dx * dx + dy * dy > 25;
        if (pressInfo.moved) onNodeHover(null, event);   // 拖动一旦确立即收起悬停名牌（拖动时不显示任何点名）
      }
      if (draggedNode) {
        const rect = canvas.getBoundingClientRect();
        const p = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
        dragVel.x = dragVel.x * 0.5 + (p.x - draggedNode.x) * 0.5;
        dragVel.y = dragVel.y * 0.5 + (p.y - draggedNode.y) * 0.5;
        draggedNode.x = p.x; draggedNode.y = p.y;
        draggedNode.vx = 0; draggedNode.vy = 0;
        invalidatePositions();
        requestFrame();
      } else if (panOrigin) {
        const m = metrics();
        viewX = panOrigin.viewX - (event.clientX - panOrigin.clientX) / m.unit;
        viewY = panOrigin.viewY - (event.clientY - panOrigin.clientY) / m.unit;
        userAdjustedView = true;
        zoomTween.active = false; fitTween.active = false;
        if (panInertia > 0) {                            // 采集屏幕 px/ms 速度（EMA），供松手惯性
          const tnow = now();
          if (panLast) {
            const pdt = tnow - panLast.t;
            if (pdt > 0) {
              panVelScreen.x = panVelScreen.x * 0.5 + ((event.clientX - panLast.x) / pdt) * 0.5;
              panVelScreen.y = panVelScreen.y * 0.5 + ((event.clientY - panLast.y) / pdt) * 0.5;
            }
          }
          panLast = { x: event.clientX, y: event.clientY, t: tnow };
          panLastMoveT = tnow;
        }
        requestFrame();
      } else {
        hover(event);
      }
    }
    function endPointer(event) {
      if (draggedNode) {
        const wasClick = pressInfo && !pressInfo.moved && pressInfo.kind === 'node';
        const released = draggedNode;
        const clickIndex = wasClick ? pressInfo.index : -1;
        draggedNode = null;
        if (clickIndex >= 0) {
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          pressInfo = null;
          onNodeClick(nodes[clickIndex]);
          return;
        }
        // 温柔回落：收住甩出速度 + 用较低的 releaseReheat「封顶」当前温度（只下调、不注入能量），
        // 让松手后的节点丝滑滑回平衡位，而非高能弹性"复位动画"。
        released.vx = clamp(dragVel.x, -cfg.inertiaClamp, cfg.inertiaClamp) * cfg.releaseInertia;
        released.vy = clamp(dragVel.y, -cfg.inertiaClamp, cfg.inertiaClamp) * cfg.releaseInertia;
        alpha = Math.min(alpha, cfg.releaseReheat);
        idle = false;
        ensureLoop();
      }
      if (panOrigin) {
        panOrigin = null;
        startPanGlide();              // 平移松手 → 惯性滑行（panInertia>0 时）
      }
      pressInfo = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (_hasLabels && !alwaysShowLabels) ensureLoop();
    }
    function handlePointerCancel(event) {
      draggedNode = null; panOrigin = null; pressInfo = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (_hasLabels && !alwaysShowLabels) ensureLoop();
    }
    function handlePointerLeave(event) {
      if (!draggedNode) {
        if (lastFocusIndex !== -1) { clearHighlight(); lastFocusIndex = -1; requestRender(); }
        onNodeHover(null, event);
      }
    }
    function handleDoubleClick(event) {
      if (nodeAtClient(event.clientX, event.clientY) >= 0) return;
      userAdjustedView = false;
      fitView(true);
    }
    function handleWheel(event) {
      event.preventDefault();
      userAdjustedView = true;
      idle = false;
      fitTween.active = false;
      cancelPanGlide();
      if (_hasLabels && !reduceMotion && !alwaysShowLabels) labelAlpha = 0;
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const anchor = screenToWorld(sx, sy);
      const factor = event.deltaY > 0 ? 0.85 : 1.16;
      const base = zoomTween.active ? zoomTween.target : viewScale;
      const next = clamp(base * factor, cfg.zoomMin, cfg.zoomMax);
      if (reduceMotion) {
        viewScale = next;
        const m = metrics();
        viewX = anchor.x - (sx - m.offsetX) / m.unit;
        viewY = anchor.y - (sy - m.offsetY) / m.unit;
        requestFrame();
        return;
      }
      zoomTween.target = next;
      zoomTween.sx = sx; zoomTween.sy = sy;
      zoomTween.ax = anchor.x; zoomTween.ay = anchor.y;
      zoomTween.active = true;
      ensureLoop();
    }

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', handlePointerCancel);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('dblclick', handleDoubleClick);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    // —— 生命周期 ——
    function setActive(v) {
      v = !!v;
      if (active === v) return;
      active = v;
      // 进场只在「真正可见」时起跑：翻页途中 active 先变真、但 stage 还在视口外(visible=false)，
      // 此时不能抢跑 doBegin，否则进场动画在你看到画布之前就放完了（足迹星图“看不到生长”的根因）。
      // 交给 setVisible（IO 滑入≥1% 触发）接力。《图谱》不挂 IO → visible 恒真 → 此处与原来完全等价。
      if (active) { refreshObservedVisibility(); tryBeginPending(); idle = false; ensureLoop(); }
      else stopLoop();
    }
    function setVisible(v) {
      v = !!v;
      if (visible === v) return;
      visible = v;
      if (visible) { tryBeginPending(); ensureLoop(); }
      else stopLoop();
    }
    function refreshObservedVisibility() {
      if (!observeTarget || destroyed) return;
      const docEl = global.document && global.document.documentElement;
      const rect = observeTarget.getBoundingClientRect();
      const vw = global.innerWidth || (docEl && docEl.clientWidth) || 0;
      const vh = global.innerHeight || (docEl && docEl.clientHeight) || 0;
      const vis = rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
      setVisible(vis);
    }

    if (observeTarget && typeof global.IntersectionObserver === 'function') {
      try {
        io = new global.IntersectionObserver(function (entries) {
          const vis = entries.some(function (e) { return e.isIntersecting; });
          setVisible(vis);
        }, { threshold: 0.01 });
        io.observe(observeTarget);
        refreshObservedVisibility();
        global.requestAnimationFrame(function () {
          refreshObservedVisibility();
          global.requestAnimationFrame(refreshObservedVisibility);
        });
      } catch (e) { visible = true; }
    }
    if (typeof global.ResizeObserver === 'function') {
      try {
        ro = new global.ResizeObserver(function () {
          refreshObservedVisibility();
          requestFrame();
        });
        ro.observe(canvas);
      } catch (e) {}
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      if (pressInfo && canvas.hasPointerCapture(pressInfo.pointerId)) canvas.releasePointerCapture(pressInfo.pointerId);
      pressInfo = draggedNode = panOrigin = null;
      // canvas 通常会被外壳复用；destroy 必须同时解绑交互监听，
      // 否则旧引擎闭包会连同 nodes/edges 一直被 canvas 强引用。
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('dblclick', handleDoubleClick);
      canvas.removeEventListener('wheel', handleWheel);
      if (io) { try { io.disconnect(); } catch (e) {} io = null; }
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      if (backend && backend.destroy) { try { backend.destroy(); } catch (e) {} }
      if (overlayCanvas && overlayCanvas.parentNode) {
        try { overlayCanvas.parentNode.removeChild(overlayCanvas); } catch (e) {}
      }
      overlayCanvas = null; octx = null;
      if (domOverlay && domOverlay.destroy) { try { domOverlay.destroy(); } catch (e) {} }
      nodes = []; edges = []; neighbors = []; _partPool = [];
      pending = null;
      canvas.width = canvas.height = 1;
    }

    return {
      setData: setData,
      start: start,
      heat: heat,
      kick: kick,
      fitView: fitView,
      resetView: function () { resetView(); requestFrame(); },
      restoreView: restoreView,
      requestRender: requestRender,
      setActive: setActive,
      setVisible: setVisible,
      // 运行时切换闲时微漂移：传 null 关掉，收敛后让 RAF 循环彻底停住（静止零开销）；
      // 传 drift 描述符则恢复"活着"的微动。适配层按节点规模决定（大图谱关、小图谱留）。
      setDrift: function (d) {
        const next = d || null;
        if (drift === next) return;
        drift = next; idle = false;
        invalidatePositions();
        if (drift) ensureLoop();
        else requestFrame();
      },
      // 运行时切换连线流光（传 null 关掉）。大图谱可与 drift 一起关，收敛后彻底静止零开销。
      setParticles: function (p) {
        const next = p || null;
        if (particleCfg === next) return;
        particleCfg = next; idle = false;
        nodeInstancesVersion++;
        if (particleCfg) ensureLoop();
        else requestFrame();
      },
      // 视图平移松手惯性倍率（0–1，0=关）。图谱读 canvas:panInertia 传入与画布同步；星图不调用即保持原样。
      setPanInertia: function (v) { panInertia = Math.max(0, Math.min(1, Number(v) || 0)); },
      setReduceMotion: function (v) {
        const next = !!v;
        if (reduceMotion === next) return;
        reduceMotion = next;
        // 在闲时漂移已启动后动态切到 reduced-motion，必须解锁 idle；
        // 否则 keepGoing 会因 idle=true 永久保持 30fps RAF，却不再产生任何动效。
        idle = false;
        invalidatePositions();
        if (reduceMotion) {
          if (presolveJob) {
            const fit = presolveJob.fit;
            cancelPresolve(false);
            pending = { intro: false, fit: fit };
          } else if (pending) pending.intro = false;
          driftGain = 0;
          if (_hasLabels) labelAlpha = labelTarget = nodes.length ? 1 : 0;
          requestRender();
        } else {
          ensureLoop();
        }
      },
      nodeAtClient: nodeAtClient,
      hasNodes: function () { return nodes.length > 0; },
      get view() { return { x: viewX, y: viewY, scale: viewScale }; },
      get layoutPending() { return !destroyed && (!!pending || !!presolveJob || !!draggedNode || alpha > cfg.alphaMin); },
      get canvas() { return canvas; },
      get backendKind() { return backend && backend.kind; },
      get hasOverlay() { return !!(octx || domOverlay); },
      get labelAlpha() { return labelAlpha; },
      destroy: destroy,
    };
  }

  global.GraphEngine = {
    create: create, clamp: clamp, easeOut: easeOut,
    createCanvas2DBackend: createCanvas2DBackend,
    createWebGLBackend: createWebGLBackend,
  };
})(window);

// 活跃页「足迹星图」（适配层）：把已归档的完成任务画成力导向星图。
// 物理 / 相机 / 交互 / 渲染循环统一交给 graph-engine.js（与关系视图同源）；这里只负责：
//   · 把月度数据搭成层级结构（正常：根「我」→ 月枢纽 → 任务叶子；总览：再插一层年份）；
//   · 月色按当月完成数深浅、未命名任务聚合成「+N」点并在悬停时扇形展开；
//   · 闲时微漂移让星图“活着”；IntersectionObserver + setActive 控制隐藏即挂起。
// 纯回望、只读：归档后画布已入回收站，这里不做任何画布跳转。
(function (global) {
  'use strict';

  const VIEW_W = 1000;
  const VIEW_H = 520;
  const CENTER_X = VIEW_W / 2;
  const CENTER_Y = VIEW_H / 2;

  const LIGHT_STAR_THEME = Object.freeze({
    dark: false,
    monthTones: ['#dfe9e4', '#c9ded5', '#a9cfc2', '#7fb7a7', '#579787'],
    rootColor: '#dc825e',
    yearColor: '#809b91',
    taskColor: '#b7c9c2',
    aggColor: '#6fa898',
    flowColor: [0.31, 0.56, 0.50, 0.82],
    text: '#303633',
    aggText: '#ffffff',
    labelHalo: 'rgba(255,255,255,0.96)',
    dotStroke: 'rgba(255,255,255,0.98)',
    fanStroke: 'rgba(255,255,255,0.94)',
    edge: 'rgba(82,111,101,0.34)',
    edgeHi: 'rgba(67,137,120,0.78)',
  });
  const DARK_STAR_THEME = Object.freeze({
    dark: true,
    monthTones: ['#3d4449', '#4b5963', '#5c6f7e', '#71899b', '#8aa5b8'],
    rootColor: '#dc825e',
    yearColor: '#8aa5b8',
    taskColor: '#c7d2dc',
    aggColor: '#9bb5c6',
    flowColor: [0.58, 0.70, 0.78, 0.88],
    text: '#edf1f3',
    aggText: '#172027',
    labelHalo: 'rgba(17,19,20,0.96)',
    dotStroke: 'rgba(232,237,240,0.88)',
    fanStroke: 'rgba(232,237,240,0.82)',
    edge: 'rgba(184,199,210,0.34)',
    edgeHi: 'rgba(151,184,207,0.82)',
  });
  // 闲时微漂移振幅（按层级，根近乎不动作锚）——调大到肉眼明显的"漂浮"幅度
  const DRIFT_AMP = { root: 0.5, year: 2.1, month: 2.8, task: 4.2, agg: 3.2 };
  const DRIFT_SPEED = 0.00088;          // 周期 ≈ 7.1s，更明显的漂浮
  // 闲时"星辉"微动：每颗星错相位地轻轻起伏（缩放呼吸）+ 明灭（透明度闪烁）。
  // 复用引擎给每个节点种好的随机相位 n._phase；三层（漂移/呼吸/闪烁）速率各异 → 永不同步、有机。
  // 只改 scale 与 alpha（GPU 实例属性，免费），绝不碰 blur/shadow，故常驻动画几乎零额外开销。
  const BREATH_DEPTH = { root: 0.012, year: 0.022, month: 0.026, task: 0.032, agg: 0 };
  const TWINKLE_DEPTH = { root: 0, year: 0.035, month: 0.045, task: 0.065, agg: 0 };
  const BREATH_SPEED = 0.0009;          // 缩放呼吸 周期 ≈ 7s
  const TWINKLE_SPEED = 0.0013;         // 明灭 周期 ≈ 4.8s
  const LABEL_FADE_IN = 0.38;
  const LABEL_FADE_OUT = 0.47;
  const LABEL_EPSILON = 0.006;

  const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function isEnglish() {
    return !!(global.RelatumI18n && global.RelatumI18n.language === 'en');
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function rgbString(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!match) return '53,56,59';
    const raw = match[1];
    return parseInt(raw.slice(0, 2), 16) + ','
      + parseInt(raw.slice(2, 4), 16) + ','
      + parseInt(raw.slice(4, 6), 16);
  }
  // —— 颜色 → WebGL 用的 0..1 分量数组 ——
  function hex01(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return [0.48, 0.6, 0.52];
    const r = m[1];
    return [parseInt(r.slice(0, 2), 16) / 255, parseInt(r.slice(2, 4), 16) / 255, parseInt(r.slice(4, 6), 16) / 255];
  }
  function rgba01(str) {
    const m = /rgba?\(([^)]+)\)/i.exec(str || '');
    if (!m) return [0.1, 0.11, 0.13, 1];
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, p[3] == null ? 1 : p[3]];
  }
  function monthLabel(monthKey) {
    const m = parseInt(String(monthKey || '').slice(5, 7), 10);
    const names = isEnglish() ? MONTH_NAMES_EN : MONTH_NAMES;
    return names[m - 1] || monthKey;
  }
  function monthTone(total, tones) {
    let level = 0;
    if (total >= 9) level = 4;
    else if (total >= 5) level = 3;
    else if (total >= 3) level = 2;
    else if (total >= 1) level = 1;
    return tones[level];
  }
  function durationLabel(seconds, english) {
    const min = Math.round(Math.max(0, Number(seconds) || 0) / 60);
    if (min < 1) return english ? 'under 1 min' : '不足 1 分钟';
    if (min < 60) return english ? min + ' min' : min + ' 分钟';
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    return english
      ? hours + ' hr' + (rest ? ' ' + rest + ' min' : '')
      : hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
  }
  function clipLabel(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim() || (isEnglish() ? 'Untitled' : '未命名');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function approachLabelAlpha(current, target, reduce) {
    if (reduce) return target;
    const cur = Number.isFinite(current) ? current : 0;
    const speed = target > cur ? LABEL_FADE_IN : LABEL_FADE_OUT;
    return cur + (target - cur) * speed;
  }

  // —— 单个星图实例 ——
  function mount(host, graphData, opts) {
    if (!host || !global.GraphEngine) return null;
    let reduceMotion = false;
    try { reduceMotion = global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    host.innerHTML = '';
    const stage = document.createElement('div');
    stage.className = 'star-stage';
    const canvas = document.createElement('canvas');
    canvas.className = 'star-canvas';
    canvas.setAttribute('role', 'img');
    const canvasActivityGraph = !!(graphData && graphData.kind === 'canvas');
    canvas.setAttribute('aria-label', canvasActivityGraph ? '画布使用时间星图' : '已完成任务足迹星图');
    stage.appendChild(canvas);
    const tooltip = document.createElement('div');
    tooltip.className = 'star-tooltip';
    tooltip.hidden = true;
    stage.appendChild(tooltip);
    const empty = document.createElement('div');
    empty.className = 'star-empty';
    empty.textContent = canvasActivityGraph
      ? '使用过的画布，会在这里连成一片星图。'
      : '归档过的完成任务，会在这里连成一片星图。';
    empty.hidden = true;
    stage.appendChild(empty);
    host.appendChild(stage);

    let nodes = [];
    let edges = [];
    let hoverNode = null;
    let engine = null;
    const motionDefaults = {
      introMs: 1080,
      introStagger: 60,
      alphaReheat: 0.20,
      velocityDamp: 0.88,
      introVelocityClamp: 10,
      finalFitOnConverge: false,
    };

    function readMotionSettings() {
      let raw = null;
      try { raw = JSON.parse(global.localStorage.getItem('canvas:starmapMotion:v1') || 'null'); } catch (e) {}
      const next = Object.assign({}, motionDefaults, raw || {});
      next.introMs = clamp(Number(next.introMs) || motionDefaults.introMs, 240, 1800);
      next.introStagger = clamp(Number(next.introStagger) || motionDefaults.introStagger, 0, 60);
      next.alphaReheat = clamp(Number(next.alphaReheat) || motionDefaults.alphaReheat, 0.05, 0.60);
      next.velocityDamp = clamp(Number(next.velocityDamp) || motionDefaults.velocityDamp, 0.60, 0.98);
      next.introVelocityClamp = clamp(Number(next.introVelocityClamp) || motionDefaults.introVelocityClamp, 2, 60);
      next.finalFitOnConverge = !!next.finalFitOnConverge;
      return next;
    }

    let theme = null;
    function syncTheme() {
      const dark = document.body && document.body.dataset.startTheme === 'dark';
      const base = dark ? DARK_STAR_THEME : LIGHT_STAR_THEME;
      const changed = !theme || theme.dark !== base.dark;
      let family = 'system-ui';
      try {
        const cs = global.getComputedStyle(canvas);
        family = (cs.getPropertyValue('font-family') || 'system-ui').trim() || 'system-ui';
      } catch (e) {}
      theme = Object.assign({}, base, {
        font600: '600 11.5px ' + family,
        fontAgg: '700 10px ' + family,
      });
      // WebGL 描述符用的 0..1 版本（与上面 Canvas2D 串对应）
      theme.dotStrokeGL = rgba01(theme.dotStroke);
      theme.edgeGL = rgba01(theme.edge);
      theme.edgeHiGL = rgba01(theme.edgeHi);
      return changed;
    }

    // —— 正常：根 → 月 → 任务；总览：根 → 年 → 月 → 任务 ——
    function buildGraphData(data) {
      nodes = [];
      edges = [];
      const months = (data && Array.isArray(data.months)) ? data.months : [];
      const years = (data && Array.isArray(data.years)) ? data.years : [];
      const canvasGraph = !!(data && data.kind === 'canvas');
      if (!months.length && !years.length) return;

      const canvasIds = new Set();
      if (canvasGraph) {
        const sourceMonths = years.length
          ? years.flatMap((year) => Array.isArray(year.months) ? year.months : [])
          : months;
        sourceMonths.forEach((month) => (month.named || []).forEach((item) => {
          canvasIds.add(String(item.id || item.path || item.title || ''));
        }));
      }
      const totalAll = canvasGraph
        ? canvasIds.size
        : years.length
          ? years.reduce((sum, year) => sum + (year.total || 0), 0)
          : months.reduce((sum, month) => sum + (month.total || 0), 0);
      const durationAll = years.length
        ? years.reduce((sum, year) => sum + (year.durationSec || 0), 0)
        : months.reduce((sum, month) => sum + (month.durationSec || 0), 0);
      const rootColor = theme.rootColor;
      const yearColor = theme.yearColor;
      const taskColor = theme.taskColor;
      const aggColor = theme.aggColor;
      const english = isEnglish();
      const root = {
        tier: 'root', label: english ? 'Me' : '我',
        tip: canvasGraph
          ? (english
            ? totalAll + ' canvases · ' + durationLabel(durationAll, true)
            : totalAll + ' 张画布 · ' + durationLabel(durationAll, false))
          : english
          ? totalAll + ' total · ' + (years.length ? years.length + ' years' : months.length + ' months')
          : '累计 ' + totalAll + ' 件'
            + (years.length ? ' · ' + years.length + ' 年' : ' · ' + months.length + ' 个月'),
        color: rootColor, rgb: rgbString(rootColor), r: 15,
        x: CENTER_X, y: CENTER_Y,
      };
      nodes.push(root);
      const rootIndex = 0;

      function addMonth(month, parentIndex, rest) {
        const total = month.total || 0;
        const durationSec = Math.max(0, Number(month.durationSec) || 0);
        const color = monthTone(canvasGraph ? Math.max(0, Math.ceil(durationSec / 3600)) : total, theme.monthTones);
        const monthNode = {
          tier: 'month', label: monthLabel(month.month),
          tip: canvasGraph
            ? monthLabel(month.month) + ' · ' + total + (english ? ' canvases · ' : ' 张画布 · ')
              + durationLabel(durationSec, english)
            : monthLabel(month.month) + (english ? ' · ' + total + ' completed' : ' · 完成 ' + total + ' 项'),
          color: color, rgb: rgbString(color),
          r: canvasGraph
            ? clamp(8 + Math.log1p(durationSec / 60) * 1.45, 8, 18)
            : clamp(8 + total * 1.1, 8, 18), x: 0, y: 0,
        };
        const monthIndex = nodes.push(monthNode) - 1;
        edges.push({ source: parentIndex, target: monthIndex, rest: rest });

        (month.named || []).forEach((task) => {
          const taskSec = Math.max(0, Number(task.durationSec) || 0);
          const totalTaskSec = Math.max(taskSec, Number(task.totalDurationSec) || 0);
          const leaf = {
            tier: 'task', label: clipLabel(task.title, 14),
            tip: canvasGraph
              ? clipLabel(task.title, 40) + ' · ' + durationLabel(taskSec, english)
                + (totalTaskSec > taskSec
                  ? (english ? ' · total ' : ' · 累计 ') + durationLabel(totalTaskSec, english) : '')
                + (task.inferred && !taskSec ? (english ? ' · historical time unavailable' : ' · 历史时长无法还原') : '')
              : clipLabel(task.title, 40) + (task.day ? ' · ' + task.day : ''),
            color: taskColor, rgb: rgbString(taskColor),
            r: canvasGraph ? clamp(5.5 + Math.log1p(taskSec / 60) * 1.15, 5.5, 13) : 5.5,
            x: 0, y: 0,
          };
          const leafIndex = nodes.push(leaf) - 1;
          edges.push({ source: monthIndex, target: leafIndex, rest: 74 });
        });

        const unnamed = month.unnamed || 0;
        if (unnamed > 0) {
          const agg = {
            tier: 'agg', label: '+' + unnamed, count: unnamed,
            tip: english ? unnamed + ' untitled' : unnamed + ' 件未命名',
            color: aggColor, rgb: rgbString(aggColor),
            r: clamp(6 + unnamed * 0.6, 6, 11), x: 0, y: 0,
          };
          const aggIndex = nodes.push(agg) - 1;
          edges.push({ source: monthIndex, target: aggIndex, rest: 70 });
        }
      }

      if (years.length) {
        years.forEach((year) => {
          const yearNode = {
            tier: 'year', label: String(year.year || ''),
            tip: canvasGraph
              ? String(year.year || '') + (english ? ' · ' : ' 年 · ')
                + (year.total || 0) + (english ? ' canvases · ' : ' 张画布 · ')
                + durationLabel(year.durationSec || 0, english)
              : english
              ? String(year.year || '') + ' · ' + (year.total || 0) + ' completed'
              : String(year.year || '') + ' 年 · 完成 ' + (year.total || 0) + ' 项',
            color: yearColor, rgb: rgbString(yearColor),
            r: canvasGraph
              ? clamp(11 + Math.log1p((year.durationSec || 0) / 3600) * 2.2, 11, 19)
              : clamp(10 + (year.total || 0) * 0.34, 11, 19), x: 0, y: 0,
          };
          const yearIndex = nodes.push(yearNode) - 1;
          edges.push({ source: rootIndex, target: yearIndex, rest: 178 });
          (year.months || []).forEach((month) => addMonth(month, yearIndex, 104));
        });
      } else {
        months.forEach((month) => addMonth(month, rootIndex, 196));
      }
    }

    // 播种：正常模式月份绕根成环；总览模式年份绕根、月份绕年份，叶子洒在月份附近。
    function seedPositions() {
      const yearIndexes = [];
      const monthIndexes = [];
      const parentOf = new Map();
      nodes.forEach((node, index) => {
        if (node.tier === 'year') yearIndexes.push(index);
        if (node.tier === 'month') monthIndexes.push(index);
      });
      edges.forEach((edge) => { parentOf.set(edge.target, edge.source); });

      const monthAngle = new Map();
      if (yearIndexes.length) {
        const yearRingR = Math.min(VIEW_W, VIEW_H) * 0.27;
        yearIndexes.forEach((index, order) => {
          const angle = (order / Math.max(yearIndexes.length, 1)) * Math.PI * 2 - Math.PI / 2;
          nodes[index].x = CENTER_X + Math.cos(angle) * yearRingR;
          nodes[index].y = CENTER_Y + Math.sin(angle) * yearRingR;
          const childMonths = monthIndexes.filter((monthIndex) => parentOf.get(monthIndex) === index);
          childMonths.forEach((monthIndex, childOrder) => {
            const spread = childMonths.length > 1
              ? -1.05 + (childOrder / (childMonths.length - 1)) * 2.1
              : 0;
            const childAngle = angle + spread;
            monthAngle.set(monthIndex, childAngle);
            nodes[monthIndex].x = nodes[index].x + Math.cos(childAngle) * 88;
            nodes[monthIndex].y = nodes[index].y + Math.sin(childAngle) * 88;
          });
        });
      } else {
        const monthRingR = Math.min(VIEW_W, VIEW_H) * 0.3;
        monthIndexes.forEach((index, order) => {
          const angle = (order / Math.max(monthIndexes.length, 1)) * Math.PI * 2 - Math.PI / 2;
          monthAngle.set(index, angle);
          nodes[index].x = CENTER_X + Math.cos(angle) * monthRingR;
          nodes[index].y = CENTER_Y + Math.sin(angle) * monthRingR;
        });
      }

      nodes.forEach((node, index) => {
        if (node.tier === 'root') { node.x = CENTER_X; node.y = CENTER_Y; return; }
        if (node.tier === 'task' || node.tier === 'agg') {
          const parent = nodes[parentOf.get(index)] || nodes[0];
          const baseAngle = monthAngle.get(parentOf.get(index));
          const startAngle = (baseAngle == null ? Math.random() * Math.PI * 2 : baseAngle);
          const spreadAngle = startAngle + (Math.random() - 0.5) * 1.4;
          const spreadR = 60 + Math.random() * 46;
          node.x = parent.x + Math.cos(spreadAngle) * spreadR;
          node.y = parent.y + Math.sin(spreadAngle) * spreadR;
        }
      });
    }

    // 闲时"星辉"微动：返回复用的 scratch（零分配），s=缩放系数 a=透明度系数。
    // reduceMotion / 聚焦 / agg / 无配置层级 → 中性 1（聚焦让位给放大与高亮，不叠加抖动）。
    const _starAnim = { s: 1, a: 1 };
    function starAnim(node, focus) {
      _starAnim.s = 1; _starAnim.a = 1;
      if (reduceMotion || focus) return _starAnim;
      const bd = BREATH_DEPTH[node.tier] || 0;
      const td = TWINKLE_DEPTH[node.tier] || 0;
      if (!bd && !td) return _starAnim;
      const t = now();
      const ph = node._phase || 0;
      if (bd) _starAnim.s = 1 + bd * Math.sin(t * BREATH_SPEED + ph);
      if (td) _starAnim.a = 1 - td * (0.5 - 0.5 * Math.cos(t * TWINKLE_SPEED + ph));
      return _starAnim;
    }

    // —— 渲染回调 ——
    function drawNode(ctx, node, env) {
      const r = node.r;
      const tier = node.tier;
      const focus = env.focus;
      const near = env.near;
      const base = ctx.globalAlpha * (env.dim ? 0.24 : 1);

      // 光晕（聚焦时显）
      if (focus) {
        ctx.globalAlpha = base;
        ctx.beginPath();
        ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + node.rgb + ',0.14)';
        ctx.fill();
      }

      // 聚合点折叠的小星：聚焦时扇形展开
      if (tier === 'agg' && focus) {
        const show = Math.min(node.count, 6);
        const prog = reduceMotion ? 1 : clamp((now() - (node._fanStart || 0)) / 320, 0, 1);
        for (let k = 0; k < show; k++) {
          const a = -Math.PI / 2 + (k - (show - 1) / 2) * 0.46;
          const dist = (r + 16) * prog;
          const miniR = 3.4 * prog;
          if (miniR <= 0.05) continue;
          ctx.globalAlpha = base * 0.92 * prog;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist, miniR, 0, Math.PI * 2);
          ctx.fillStyle = node.color;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = theme.fanStroke;
          ctx.stroke();
        }
      }

      // 实心点（agg 收敛后缓慢脉动；其余星点错相位呼吸 + 明灭）
      const anim = starAnim(node, focus);
      ctx.globalAlpha = base * anim.a;
      let scale = focus ? 1.18 : 1;
      if (tier === 'agg' && !reduceMotion && !focus) {
        const ph = (now() % 3200) / 3200 * Math.PI * 2;
        scale = 1 + 0.04 * (1 - Math.cos(ph));
      } else {
        scale *= anim.s;
      }
      ctx.save();
      if (scale !== 1) ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();
      ctx.strokeStyle = focus ? node.color : theme.dotStroke;
      ctx.lineWidth = focus ? 2.4 : (near ? 2.1 : (tier === 'root' ? 2.2 : 1.7));
      ctx.stroke();
      ctx.restore();

      // 标签
      ctx.textAlign = 'center';
      if (tier === 'agg') {
        // 聚合点：白字号居中（始终显示）
        ctx.globalAlpha = base;
        ctx.font = theme.fontAgg;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = theme.aggText;
        ctx.fillText(node.label, 0, 0.5);
        return;
      }
      let labelTarget;
      if (tier === 'task') labelTarget = (focus || near) ? 1 : 0;
      else labelTarget = (focus || near) ? 1 : 0.92;   // root / year / month
      node._canvasLabelAlpha = approachLabelAlpha(node._canvasLabelAlpha, labelTarget, reduceMotion);
      const labelAlpha = node._canvasLabelAlpha;
      if (labelAlpha > 0 && node.label) {
        ctx.globalAlpha = base * labelAlpha;
        ctx.font = theme.font600;
        ctx.textBaseline = 'alphabetic';
        const ly = -(r + 8);
        ctx.lineWidth = 3.6;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(node.label, 0, ly);
        ctx.fillStyle = theme.text;
        ctx.fillText(node.label, 0, ly);
      }
    }

    function drawEdge(ctx, edge, s, d, env) {
      ctx.globalAlpha = ctx.globalAlpha * (env.dim ? 0.12 : 1);
      ctx.beginPath();
      ctx.moveTo(s._rx, s._ry);
      ctx.lineTo(d._rx, d._ry);
      if (env.highlighted) { ctx.strokeStyle = theme.edgeHi; ctx.lineWidth = 2.2; }
      else { ctx.strokeStyle = theme.edge; ctx.lineWidth = 1.45; }
      ctx.stroke();
    }

    // —— WebGL 路径：几何走描述符（dot + agg 脉动缩放），光晕 / 扇形 / 标签走顶层叠加层 ——
    // 与 drawNode/drawEdge 一一对应；WebGL 不可用时引擎自动回落到那份 Canvas2D 代码。
    function nodeStyle(node, env) {
      const tier = node.tier;
      if (!node._glFill) node._glFill = hex01(node.color);
      const fill = node._glFill;
      const dim = env.dim ? 0.24 : 1;
      const sg = env.focus ? fill : theme.dotStrokeGL;
      const strokeA = env.focus ? 1 : (theme.dotStrokeGL[3] == null ? 0.94 : theme.dotStrokeGL[3]);
      const strokeW = env.focus ? 2.4 : (env.near ? 2.1 : (tier === 'root' ? 2.2 : 1.7));
      const anim = starAnim(node, env.focus);
      let scale = env.focus ? 1.18 : 1;
      if (tier === 'agg' && !reduceMotion && !env.focus) {
        const ph = (now() % 3200) / 3200 * Math.PI * 2;   // 聚合点缓慢脉动
        scale = 1 + 0.04 * (1 - Math.cos(ph));
      } else {
        scale *= anim.s;
      }
      return {
        r: node.r,
        fill: [fill[0], fill[1], fill[2], dim * anim.a],
        stroke: [sg[0], sg[1], sg[2], strokeA * dim * anim.a],
        strokeW: strokeW,
        shape: 0,
        scale: scale,
      };
    }
    function edgeStyle(edge, s, d, env) {
      const dim = env.dim ? 0.12 : 1;
      const c = env.highlighted ? theme.edgeHiGL : theme.edgeGL;
      return { color: [c[0], c[1], c[2], (c[3] == null ? 1 : c[3]) * dim], width: env.highlighted ? 2.2 : 1.45 };
    }
    // ── DOM 标签层：CSS transform 替代 Canvas 2D ──
    // 标签 / 光晕 / 扇形折叠小星提升为 DOM 元素，GPU compositor 合成。
    function createDOMLabelLayer() {
      var container = document.createElement('div');
      container.className = 'ge-dom-overlay';
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
      var parent = canvas.parentNode;
      if (parent) parent.insertBefore(container, canvas.nextSibling);

      var haloPool = {};    // id → { el }
      var fanPool = [];     // array of { el } for fan-out mini circles
      var labelPool = {};   // id → { el, inner }

      function w2s(wx, wy, st) {
        return {
          x: (wx - st.viewX) * st.unit + st.offsetX,
          y: (wy - st.viewY) * st.unit + st.offsetY,
        };
      }

      function ensureFanEl(idx) {
        if (fanPool[idx]) return fanPool[idx];
        var el = document.createElement('div');
        el.style.cssText = 'position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;will-change:transform,opacity;';
        container.appendChild(el);
        fanPool[idx] = { el: el };
        return fanPool[idx];
      }

      function sync(st) {
        var A = st.labelAlpha;
        var ns = st.nodes;
        var seenH = {};
        var seenL = {};
        var fanUsed = 0;
        var reduce = !!st.reduceMotion;

        // 光晕（聚焦时）
        for (var i = 0; i < ns.length; i++) {
          var n = ns[i];
          if (!n._focus) continue;
          var id = n.id || i;
          var alpha = A * (n._dim ? 0.24 : 1);
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
          hp.el.style.width = (rpx * 2).toFixed(1) + 'px';
          hp.el.style.height = (rpx * 2).toFixed(1) + 'px';
          hp.el.style.transform = 'translate(' + (center.x - rpx).toFixed(1) + 'px,' + (center.y - rpx).toFixed(1) + 'px)';
          hp.el.style.opacity = alpha;
          hp.el.style.background = 'rgba(' + n.rgb + ',0.14)';
        }

        // 聚合点扇形展开（聚焦时）
        for (var i = 0; i < ns.length; i++) {
          var n = ns[i];
          if (n.tier !== 'agg' || !n._focus) continue;
          var show = Math.min(n.count, 6);
          var prog = reduceMotion ? 1 : clamp((now() - (n._fanStart || 0)) / 320, 0, 1);
          var dimF = (n._dim ? 0.24 : 1);
          for (var k = 0; k < show; k++) {
            var ang = -Math.PI / 2 + (k - (show - 1) / 2) * 0.46;
            var dist = (n.r + 16) * prog;
            var miniR = 3.4 * prog;
            if (miniR <= 0.05) continue;
            var alpha = A * dimF * 0.92 * prog;
            if (alpha < 0.004) continue;
            var fe = ensureFanEl(fanUsed);
            fanUsed++;
            var cx = n._rx + Math.cos(ang) * dist;
            var cy = n._ry + Math.sin(ang) * dist;
            var screen = w2s(cx, cy, st);
            var dpx = miniR * 2 * st.unit;
            fe.el.style.width = dpx.toFixed(1) + 'px';
            fe.el.style.height = dpx.toFixed(1) + 'px';
            fe.el.style.transform = 'translate(' + (screen.x - dpx / 2).toFixed(1) + 'px,' + (screen.y - dpx / 2).toFixed(1) + 'px)';
            fe.el.style.opacity = alpha;
            fe.el.style.background = n.color;
            fe.el.style.border = '1.2px solid ' + theme.fanStroke;
          }
        }

        // 标签
        for (var i = 0; i < ns.length; i++) {
          var n = ns[i];
          var tier = n.tier;
          var dimF = (n._dim ? 0.24 : 1);

          if (tier === 'agg') {
            // +N 白字（手停时始终显示）
            var id = n.id || i;
            var alpha = A * dimF;
            if (alpha < 0.004) continue;
            seenL[id] = true;
            var lp = labelPool[id];
            if (!lp) {
              var lel = document.createElement('div');
              lel.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;';
              var inner = document.createElement('span');
              inner.style.cssText = 'display:block;transform:translate(-50%,-50%);white-space:nowrap;';
              inner.style.font = theme.fontAgg;
              inner.style.color = theme.aggText;
              lel.appendChild(inner);
              container.appendChild(lel);
              lp = { el: lel, inner: inner, alpha: 0, target: 0 };
              labelPool[id] = lp;
            }
            lp.target = alpha;
            lp.alpha = approachLabelAlpha(lp.alpha, lp.target, reduce);
            var center = w2s(n._rx, n._ry, st);
            lp.el.style.transform = 'translate(' + center.x.toFixed(1) + 'px,' + (center.y + 0.5).toFixed(1) + 'px)';
            lp.el.style.opacity = lp.alpha;
            lp.inner.style.color = theme.aggText;
            lp.inner.textContent = n.label;
            continue;
          }

          if (!n.label) continue;
          var id = n.id || i;
          var focusNear = n._focus || n._near;
          var labA = (tier === 'task') ? (focusNear ? 1 : 0) : (focusNear ? 1 : 0.92);
          if (st.scale < 0.6 && !focusNear && tier !== 'root') labA = 0;
          var alpha = A * dimF * labA;
          var lp = labelPool[id];
          if (!lp && alpha < 0.004) continue;
          seenL[id] = true;
          if (!lp) {
            var lel = document.createElement('div');
            lel.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;will-change:transform,opacity;';
            var inner = document.createElement('span');
            inner.style.cssText = 'display:block;transform:translate(-50%,-100%);white-space:nowrap;';
            inner.style.font = theme.font600;
            inner.style.color = theme.text;
            lel.appendChild(inner);
            container.appendChild(lel);
            lp = { el: lel, inner: inner, alpha: 0, target: 0 };
            labelPool[id] = lp;
          }
          lp.target = alpha;
          lp.alpha = approachLabelAlpha(lp.alpha, lp.target, reduce);
          if (lp.alpha < LABEL_EPSILON && lp.target <= 0) {
            lp.el.style.opacity = '0';
            continue;
          }
          var center = w2s(n._rx, n._ry, st);
          var ly = center.y - (n.r * st.unit) - 8;
          lp.el.style.transform = 'translate(' + center.x.toFixed(1) + 'px,' + ly.toFixed(1) + 'px)';
          lp.el.style.opacity = lp.alpha;
          lp.inner.textContent = n.label;
          lp.inner.style.color = theme.text;
          lp.inner.style.textShadow = focusNear ? '0 0 3.6px ' + theme.labelHalo : 'none';
        }

        // 收尾：藏本轮未用元素
        for (var k in haloPool) {
          if (!seenH[k]) haloPool[k].el.style.opacity = '0';
        }
        for (var k in labelPool) {
          if (!seenL[k]) {
            labelPool[k].target = 0;
            labelPool[k].alpha = approachLabelAlpha(labelPool[k].alpha, 0, reduce);
            labelPool[k].el.style.opacity = labelPool[k].alpha < LABEL_EPSILON ? '0' : labelPool[k].alpha;
          }
        }
        for (var j = fanUsed; j < fanPool.length; j++) {
          fanPool[j].el.style.opacity = '0';
        }
      }

      function destroy() {
        try { container.remove(); } catch (e) {}
        for (var k in haloPool) delete haloPool[k];
        for (var k in labelPool) delete labelPool[k];
        fanPool.length = 0;
      }

      return { sync: sync, destroy: destroy };
    }

    var domOverlay = createDOMLabelLayer();

    // —— 起图 ——
    syncTheme();
    buildGraphData(graphData || {});
    empty.hidden = nodes.length > 0;
    if (!nodes.length) {
      return { setActive: function () {}, destroy: function () { try { host.innerHTML = ''; } catch (e) {} } };
    }
    seedPositions();

    const motion = readMotionSettings();
    engine = global.GraphEngine.create({
      canvas: canvas,
      backend: 'webgl',
      observe: stage,
      active: !(opts && opts.active === false),
      reduceMotion: reduceMotion,
      config: {
        viewW: VIEW_W, viewH: VIEW_H,
        repulsion: 7200, spring: 0.05,
        alphaReheat: motion.alphaReheat, velocityDamp: motion.velocityDamp,
        introMs: motion.introMs, introStagger: motion.introStagger,
        introVelocityClamp: motion.introVelocityClamp,
        zoomMin: 0.4, zoomMax: 3, fitScaleMin: 0.4, fitScaleMax: 3,
        fitPad: 26, fitMargin: 40,
        finalFitOnConverge: motion.finalFitOnConverge,
      },
      drift: { speed: DRIFT_SPEED, amp: function (node) { return DRIFT_AMP[node.tier] || 0; } },
      particles: {                  // 连线流光：从「我/月」向外的星点缓缓流动
        speed: 0.00022, perEdge: 1, size: 3.1,
        getColor: function () { return theme.flowColor; },
      },
      getEdgeRest: function (edge) { return edge.rest; },
      getGravity: function (node) { return node.tier === 'root' ? 0.05 : 0.0048; },
      drawNode: drawNode,           // Canvas2D 兜底路径（含标签 / 脉动 / 扇形）
      drawEdge: drawEdge,
      nodeStyle: nodeStyle,         // WebGL 几何
      edgeStyle: edgeStyle,
      domOverlay: domOverlay,       // DOM 标签层（CSS transform，GPU compositor）
      onNodeHover: function (node, event) {
        if (node !== hoverNode) {
          if (node && node.tier === 'agg') node._fanStart = now();
          hoverNode = node;
        }
        if (!node) { tooltip.hidden = true; return; }
        const rect = stage.getBoundingClientRect();
        tooltip.textContent = node.tip || node.label;
        tooltip.style.left = (event.clientX - rect.left + 14) + 'px';
        tooltip.style.top = (event.clientY - rect.top + 14) + 'px';
        tooltip.hidden = false;
      },
    });
    if (!engine) {
      return { setActive: function () {}, destroy: function () { try { host.innerHTML = ''; } catch (e) {} } };
    }
    engine.setData(nodes, edges, { intro: !(opts && opts.intro === false) });
    engine.start({ intro: !(opts && opts.intro === false), fit: true });

    function refreshTheme() {
      if (!syncTheme() || !engine) return;
      buildGraphData(graphData || {});
      seedPositions();
      engine.setData(nodes, edges, { intro: true });
      engine.start({ intro: true, fit: true });
    }
    const themeObserver = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(refreshTheme)
      : null;
    let themeObserving = false;
    function observeTheme() {
      if (!themeObserver || themeObserving || !document.body) return;
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-start-theme'],
      });
      themeObserving = true;
    }
    function pauseThemeObserver() {
      if (!themeObserver || !themeObserving) return;
      themeObserver.disconnect();
      themeObserving = false;
    }
    if (!(opts && opts.active === false)) observeTheme();

    return {
      // 由起步页翻页逻辑调用：进入活跃页 setActive(true) 唤醒，离开则挂起整条 RAF 循环。
      setActive: function (v) {
        if (v) {
          refreshTheme();
          observeTheme();
        } else {
          pauseThemeObserver();
        }
        engine.setActive(!!v);
      },
      // 重播入场生长：每次翻进活跃页时调用——重新播种 + 重新武装进场（节点先隐形预置），
      // 之后由引擎的 active && visible 自然触发：星图在视野内就地长出，仍在折叠线以下则等滚动进视野再长。
      // 与编辑器《图谱》open() 的生长同源（seedPositions → setData → start(intro)），不再自造按住/延时。
      replayIntro: function () {
        if (!engine) return;
        seedPositions();
        engine.setData(nodes, edges, { intro: true });
        engine.start({ intro: true, fit: true });
      },
      destroy: function () {
        pauseThemeObserver();
        try { engine.destroy(); } catch (e) {}
        try { host.innerHTML = ''; } catch (e) {}
      },
    };
  }

  global.StudyGraph = { mount: mount };
})(window);

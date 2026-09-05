// 起步页「速记」便签墙
// 极简灵感速记墙：双击空白生成便签（随机果冻色 + 轻微旋转 + 弹入）/ 拖动摆放 / 双击便签写短字
  // / 在空白处「快速划一刀」划过便签/线条即删除 / 右键拖出箭头 / Ctrl+Z·Ctrl+Y 撤销重做 / 全程自动存盘。
// 叠摞：拖一张压到另一张上叠成一摞；悬停一摞扇形展开预览，移开收回；展开态拖一张可拉出。
// 数据独立存 data/notes.json（含可选 stack 摞 id），与 .canvas、学习任务完全解耦。
// 页面本身不放任何文字 / 提示 / 按钮，保持一面干净的墙。
(function () {
  'use strict';

  const surface = document.querySelector('[data-role="notes-surface"]');
  if (!surface) return;
  const leftSpine = document.querySelector('.left-spine');

  const NOTE_W = 196;          // 与 styles.css .sticky-note 宽度一致
  const NOTE_H = 150;          // 居中落点用的估算高度
  const EDGE = 10;             // 贴边留白
  const SLASH_MIN = 36;        // 「划一刀」最短长度，低于此当作误触
  const HISTORY_MAX = 50;      // 撤销栈深度
  const PILE_DX = 4;           // 收拢一摞时，下层卡片向右下露出的步距
  const PILE_DY = 6;
  const FAN_STEP = 118;        // 展开扇形：相邻卡片水平间距
  const FAN_RISE = 10;         // 展开扇形：离中心越远略微下沉，做出微笑弧
  const FAN_ROT = 3;           // 展开扇形：每张额外旋转角
  const PAN_RESIST = 0.18;     // 越过柔性边界后的阻力系数
  const NOTES_INERTIA_KEY = 'canvas:notesInertia';
  const NOTES_INERTIA_DEFAULT = 0.45;
  const STACK_HOVER_DELAY_KEY = 'canvas:notesStackHoverDelay';
  const STACK_HOVER_DELAY_DEFAULT = 320;
  const STACK_HOVER_DELAY_MIN = 0;
  const STACK_HOVER_DELAY_MAX = 1200;
  const NOTES_VIEW_KEY = 'canvas:notesView';
  const NOTES_VIEW_MIN = 0.45;
  const NOTES_VIEW_MAX = 2.35;
  const NOTES_ZOOM_EASE = 0.32;    // 滚轮缩放缓动，贴近主画布滚轮手感
  const NOTES_KEY_PAN = 8;
  const NOTES_BOUNCE = 0.28;
  const NOTE_TYPOGRAPHY_SHORT_MAX = 18;
  const NOTE_TYPOGRAPHY_MEDIUM_MAX = 48;
  const NOTE_TYPOGRAPHY_NEWLINE_WEIGHT = 4;
  const stickyPalette = window.RelatumStickyPalette;
  const prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();

  let notes = [];              // [{id,x,y,color,text,rotate,stack?}]，数组顺序 = 全局叠放层级（后＝上）
  let edges = [];              // [{id,from,to}]，便签之间的连线（无向，端点引用便签 id）
  let arrows = [];             // [{id,fromNote?,toNote?,x1?,y1?,x2?,y2?}]，右键拖出的箭头
  let loaded = false;
  let loading = null;
  let preloadHandle = 0;
  let preloadUsesIdle = false;
  let touched = false;         // 用户是否已改动过墙面（防异步 load 回来覆盖新建/编辑）
  let lastColor = null;        // 上一次用过的颜色与色系，用于避免视觉近似的连续色
  let lastColorFamily = '';
  let expandedStack = null;    // 当前悬停展开的摞 id
  let collapseTimer = null;
  let expandTimer = null;
  let stackHoverDelay = STACK_HOVER_DELAY_DEFAULT;
  let interacting = false;     // 拖拽中：暂停悬停展开逻辑
  let activeNoteId = null;     // 最近悬停 / 操作过的便签，供无界面的 C 换色使用
  let spaceHeld = false;       // Space + 拖动空白 = 平移整面墙
  let noteInertia = NOTES_INERTIA_DEFAULT;
  let worldEl = null;
  let viewX = 0;
  let viewY = 0;
  let viewScale = 1;
  let targetViewX = 0;
  let targetViewY = 0;
  let targetViewScale = 1;
  let zoomRaf = null;
  let zoomTs = 0;
  let viewSaveTimer = null;
  const viewArrowKeys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
  let viewArrowShift = false;
  let viewArrowRaf = null;
  let viewArrowTs = 0;
  let viewPanInertiaRaf = null;    // 空格拖动画布松手后的惯性循环
  let lastPointer = null;          // N 新建时优先使用最近一次位于速记台面的鼠标位置
  let searchInput = null;          // 无可见 UI 的搜索输入捕获（支持中文输入法）
  let searchQuery = '';
  let searchMatches = [];
  let searchIndex = -1;
  let searchMatchIds = new Set();
  let keyboardBrowseActive = false;

  // ── 小工具 ──
  function genId() {
    return 'note_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }
  function genStackId() {
    return 'stk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }
  function genEdgeId() {
    return 'edge_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }
  function genArrowId() {
    return 'arr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }
  // 以接近实际占宽的单位估算文字密度：全角 / 中文按 1，半角按 0.55，
  // 空格按 0.25；换行额外增加视觉高度权重。只用于展示，不写入 notes.json。
  function noteTextVisualLength(value) {
    let length = 0;
    Array.from(String(value || '').replace(/\r\n?/g, '\n')).forEach((char) => {
      if (char === '\n') length += NOTE_TYPOGRAPHY_NEWLINE_WEIGHT;
      else if (/\s/u.test(char)) length += 0.25;
      else length += char.codePointAt(0) <= 0x7f ? 0.55 : 1;
    });
    return length;
  }
  function noteTypographyTier(value) {
    const length = noteTextVisualLength(value);
    if (length <= NOTE_TYPOGRAPHY_SHORT_MAX) return 'short';
    if (length <= NOTE_TYPOGRAPHY_MEDIUM_MAX) return 'medium';
    return 'long';
  }
  function applyNoteTypography(el, value) {
    if (!el) return;
    el.dataset.typography = noteTypographyTier(value);
  }
  function hasEdge(a, b) {
    return edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  }
  // 丢弃两端不再都存在的悬空连线（删便签后调用）
  function pruneEdges() {
    const ids = new Set(notes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }
  function pruneArrows() {
    const ids = new Set(notes.map((n) => n.id));
    arrows = arrows.filter((a) => (!a.fromNote || ids.has(a.fromNote)) && (!a.toNote || ids.has(a.toNote)));
  }
  // 先均衡抽色系、再抽色系内颜色；候选范围由共享便签偏好控制。
  function nextColor() {
    if (!stickyPalette) return 'yellow';
    const picked = stickyPalette.pick({
      excludeKey: lastColor,
      excludeFamily: lastColorFamily,
    });
    lastColor = picked.key;
    lastColorFamily = picked.family;
    return picked.key;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }
  function clampNoteInertia(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NOTES_INERTIA_DEFAULT;
    return Math.round(clamp(n, 0, 1.2) * 20) / 20;
  }
  function setNoteInertia(value, persist) {
    noteInertia = clampNoteInertia(value);
    if (noteInertia === 0) {
      cancelNoteInertia(true);
      cancelViewPanInertia();
    }
    if (persist) {
      try { localStorage.setItem(NOTES_INERTIA_KEY, String(noteInertia)); } catch (e) {}
    }
    return noteInertia;
  }
  try {
    const savedNoteInertia = localStorage.getItem(NOTES_INERTIA_KEY);
    noteInertia = savedNoteInertia == null ? NOTES_INERTIA_DEFAULT : clampNoteInertia(savedNoteInertia);
  } catch (e) {
    noteInertia = NOTES_INERTIA_DEFAULT;
  }
  try {
    const savedDelay = localStorage.getItem(STACK_HOVER_DELAY_KEY);
    if (savedDelay != null) {
      const v = Number(savedDelay);
      if (Number.isFinite(v)) stackHoverDelay = Math.max(STACK_HOVER_DELAY_MIN, Math.min(STACK_HOVER_DELAY_MAX, Math.round(v / 20) * 20));
    }
  } catch (e) {}
  function clampViewScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(NOTES_VIEW_MIN, Math.min(NOTES_VIEW_MAX, n));
  }
  function restoreView() {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTES_VIEW_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      const x = Number(raw.x);
      const y = Number(raw.y);
      const scale = clampViewScale(raw.scale);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      viewX = x;
      viewY = y;
      viewScale = scale;
      targetViewX = x;
      targetViewY = y;
      targetViewScale = scale;
    } catch (e) {}
  }
  function ensureWorld() {
    if (worldEl) return worldEl;
    worldEl = document.createElement('div');
    worldEl.className = 'notes-world';
    surface.appendChild(worldEl);
    syncWorldTransform();
    return worldEl;
  }
  function syncWorldTransform() {
    if (!worldEl) return;
    worldEl.style.transform = 'translate3d(' + viewX.toFixed(2) + 'px,' + viewY.toFixed(2)
      + 'px,0) scale(' + viewScale.toFixed(4) + ')';
  }
  function saveViewSoon() {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(flushViewSave, 220);
  }
  function flushViewSave() {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = null;
    try {
      localStorage.setItem(NOTES_VIEW_KEY, JSON.stringify({
        x: Math.round(viewX * 10) / 10,
        y: Math.round(viewY * 10) / 10,
        scale: Math.round(viewScale * 1000) / 1000,
      }));
    } catch (e) {}
  }
  function applyView(persist) {
    syncWorldTransform();
    renderEdges();
    if (persist) saveViewSoon();
  }
  function surfaceToWorldPoint(x, y) {
    return {
      x: (x - viewX) / viewScale,
      y: (y - viewY) / viewScale,
    };
  }
  function clientToWorldPoint(clientX, clientY, rect) {
    const r = rect || surface.getBoundingClientRect();
    return surfaceToWorldPoint(clientX - r.left, clientY - r.top);
  }
  function worldToSurfacePoint(x, y) {
    return {
      x: viewX + x * viewScale,
      y: viewY + y * viewScale,
    };
  }
  function clearPageSelection() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
    } catch (e) {}
  }
  function visibleWorldRect(rect) {
    const r = rect || surface.getBoundingClientRect();
    return {
      left: -viewX / viewScale,
      top: -viewY / viewScale,
      right: (r.width - viewX) / viewScale,
      bottom: (r.height - viewY) / viewScale,
    };
  }
  function panViewBy(dx, dy, persist) {
    cancelViewPanInertia();
    cancelZoom();
    viewX += dx;
    viewY += dy;
    targetViewX = viewX;
    targetViewY = viewY;
    targetViewScale = viewScale;
    applyView(persist);
  }
  function frameEase(r, ts, lastTs) {
    if (typeof ts !== 'number') ts = performance.now();
    let frames = lastTs ? (ts - lastTs) / (1000 / 60) : 1;
    if (!(frames > 0)) frames = 1;
    frames = Math.max(0.35, Math.min(3, frames));
    return 1 - Math.pow(1 - r, frames);
  }
  function cancelZoom(snap) {
    if (zoomRaf != null) {
      cancelAnimationFrame(zoomRaf);
      zoomRaf = null;
    }
    zoomTs = 0;
    if (snap) {
      targetViewX = viewX;
      targetViewY = viewY;
      targetViewScale = viewScale;
    }
  }
  function cancelViewPanInertia() {
    if (viewPanInertiaRaf != null) {
      cancelAnimationFrame(viewPanInertiaRaf);
      viewPanInertiaRaf = null;
    }
  }
  function startViewPanInertia(dragState) {
    cancelViewPanInertia();
    if (!dragState || dragState.velX == null || !(noteInertia > 0)) return;
    const now = performance.now();
    if (dragState.lastMoveT == null || now - dragState.lastMoveT > 60) return;
    let vx = dragState.velX * noteInertia;
    let vy = dragState.velY * noteInertia;
    let speed = Math.hypot(vx, vy);
    if (speed < 0.06) return;
    const MAX_V = 5;
    if (speed > MAX_V) {
      const k = MAX_V / speed;
      vx *= k;
      vy *= k;
    }
    let last = now;
    const step = (ts) => {
      viewPanInertiaRaf = null;
      let dt = ts - last;
      last = ts;
      if (!(dt > 0)) dt = 16.7;
      if (dt > 40) dt = 40;
      viewX += vx * dt;
      viewY += vy * dt;
      targetViewX = viewX;
      targetViewY = viewY;
      targetViewScale = viewScale;
      applyView(false);
      saveViewSoon();
      const friction = Math.exp(-0.0045 * dt);
      vx *= friction;
      vy *= friction;
      if (Math.hypot(vx, vy) > 0.015) {
        viewPanInertiaRaf = requestAnimationFrame(step);
      }
    };
    viewPanInertiaRaf = requestAnimationFrame(step);
  }
  function zoomViewTo(nextScale, clientX, clientY) {
    cancelViewPanInertia();
    if (prefersReduced) cancelZoom(true);
    const rect = surface.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (zoomRaf == null) {
      targetViewX = viewX;
      targetViewY = viewY;
      targetViewScale = viewScale;
    }
    const anchor = {
      x: (localX - targetViewX) / targetViewScale,
      y: (localY - targetViewY) / targetViewScale,
    };
    targetViewScale = clampViewScale(nextScale);
    targetViewX = localX - anchor.x * targetViewScale;
    targetViewY = localY - anchor.y * targetViewScale;
    if (prefersReduced) {
      viewX = targetViewX;
      viewY = targetViewY;
      viewScale = targetViewScale;
      applyView(true);
      return;
    }
    if (zoomRaf == null) {
      zoomTs = 0;
      zoomRaf = requestAnimationFrame(zoomTick);
    }
    saveViewSoon();
  }
  function zoomTick(ts) {
    zoomRaf = null;
    const ds = targetViewScale - viewScale;
    const dx = targetViewX - viewX;
    const dy = targetViewY - viewY;
    if (Math.abs(ds) < 0.0008 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      viewScale = targetViewScale;
      viewX = targetViewX;
      viewY = targetViewY;
      zoomTs = 0;
      applyView(true);
      return;
    }
    const ease = frameEase(NOTES_ZOOM_EASE, ts, zoomTs);
    zoomTs = typeof ts === 'number' ? ts : performance.now();
    viewScale += ds * ease;
    viewX += dx * ease;
    viewY += dy * ease;
    applyView(false);
    zoomRaf = requestAnimationFrame(zoomTick);
  }
  function resetView() {
    cancelNoteInertia(true);
    cancelZoom();
    viewX = 0;
    viewY = 0;
    viewScale = 1;
    targetViewX = 0;
    targetViewY = 0;
    targetViewScale = 1;
    applyView(true);
  }
  function animateViewTo(scale, panX, panY) {
    cancelNoteInertia(true);
    cancelViewPanInertia();
    cancelZoom();
    targetViewScale = clampViewScale(scale);
    targetViewX = panX;
    targetViewY = panY;
    if (prefersReduced) {
      viewScale = targetViewScale;
      viewX = targetViewX;
      viewY = targetViewY;
      applyView(true);
      return;
    }
    zoomTs = 0;
    zoomRaf = requestAnimationFrame(zoomTick);
    saveViewSoon();
  }
  function fitAllNotes() {
    if (!notes.length) { resetView(); return; }
    const rect = surface.getBoundingClientRect();
    const padding = Math.max(56, Math.min(rect.width, rect.height) * 0.09);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    notes.forEach((note) => {
      const el = elById(note.id);
      const w = el ? el.offsetWidth : NOTE_W;
      const h = el ? el.offsetHeight : NOTE_H;
      left = Math.min(left, note.x);
      top = Math.min(top, note.y);
      right = Math.max(right, note.x + w);
      bottom = Math.max(bottom, note.y + h);
    });
    const contentW = Math.max(1, right - left);
    const contentH = Math.max(1, bottom - top);
    const scale = clampViewScale(Math.min(
      (rect.width - padding * 2) / contentW,
      (rect.height - padding * 2) / contentH,
      1.25,
    ));
    animateViewTo(
      scale,
      rect.width / 2 - (left + right) / 2 * scale,
      rect.height / 2 - (top + bottom) / 2 * scale,
    );
  }
  function focusActiveNote() {
    const note = activeNote();
    if (!note) return;
    const rect = surface.getBoundingClientRect();
    const el = elById(note.id);
    const w = el ? el.offsetWidth : NOTE_W;
    const h = el ? el.offsetHeight : NOTE_H;
    const scale = clampViewScale(Math.max(viewScale, 1.15));
    animateViewTo(
      scale,
      rect.width / 2 - (note.x + w / 2) * scale,
      rect.height / 2 - (note.y + h / 2) * scale,
    );
  }
  function activeNoteIsVisible(note) {
    const el = note ? elById(note.id) : null;
    if (!el) return false;
    const sr = surface.getBoundingClientRect();
    const nr = el.getBoundingClientRect();
    const margin = 24;
    return nr.left >= sr.left + margin && nr.top >= sr.top + margin
      && nr.right <= sr.right - margin && nr.bottom <= sr.bottom - margin;
  }
  function revealActiveNoteIfNeeded() {
    const note = activeNote();
    if (!note || activeNoteIsVisible(note)) return;
    const rect = surface.getBoundingClientRect();
    const el = elById(note.id);
    const w = el ? el.offsetWidth : NOTE_W;
    const h = el ? el.offsetHeight : NOTE_H;
    animateViewTo(
      viewScale,
      rect.width / 2 - (note.x + w / 2) * viewScale,
      rect.height / 2 - (note.y + h / 2) * viewScale,
    );
  }
  restoreView();
  function resisted(v, lo, hi) {
    if (v < lo) return lo + (v - lo) * PAN_RESIST;
    if (v > hi) return hi + (v - hi) * PAN_RESIST;
    return v;
  }
  function elById(id) { return surface.querySelector('.sticky-note[data-id="' + id + '"]'); }
  function refreshKeyboardCurrent() {
    surface.querySelectorAll('.sticky-note.keyboard-current').forEach((el) => el.classList.remove('keyboard-current'));
    if (!keyboardBrowseActive || searchInput || !activeNoteId) return;
    const el = elById(activeNoteId);
    if (el) el.classList.add('keyboard-current');
  }
  function setActiveNote(data) {
    activeNoteId = data ? data.id : null;
    refreshKeyboardCurrent();
  }
  function activeNote() { return notes.find((note) => note.id === activeNoteId) || null; }
  function browseNotes(direction) {
    if (!notes.length) return false;
    keyboardBrowseActive = true;
    let index = notes.findIndex((note) => note.id === activeNoteId);
    if (index < 0) index = direction < 0 ? 0 : -1;
    index = (index + direction + notes.length) % notes.length;
    setActiveNote(notes[index]);
    revealActiveNoteIfNeeded();
    return true;
  }
  function stopKeyboardBrowse() {
    if (!keyboardBrowseActive && !activeNoteId) return false;
    keyboardBrowseActive = false;
    activeNoteId = null;
    refreshKeyboardCurrent();
    return true;
  }
  // 同一摞的成员（按数组顺序；散便签返回它自己）。stack 为空当作散便签。
  function groupMembers(data) {
    if (!data.stack) return [data];
    return notes.filter((n) => n.stack === data.stack);
  }
  function isMultiPile(data) { return !!data.stack && groupMembers(data).length > 1; }
  function moveGroupToEnd(members) {
    members.forEach((m) => { const i = notes.indexOf(m); if (i >= 0) notes.splice(i, 1); });
    members.forEach((m) => notes.push(m));
  }
  // 只剩 1 张的「摞」退化为散便签，清掉残留 stack id
  function normalizeStacks() {
    const counts = {};
    notes.forEach((n) => { if (n.stack) counts[n.stack] = (counts[n.stack] || 0) + 1; });
    notes.forEach((n) => { if (n.stack && counts[n.stack] < 2) delete n.stack; });
  }

  // ── 存盘（防抖整墙覆盖）──
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let archiving = false;
  let archivePromise = null;
  function scheduleSave() {
    touched = true;
    if (archiving) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const body = JSON.stringify({ notes: notes, edges: edges, arrows: arrows });
    const operation = saveChain.catch(() => undefined).then(() => fetch('/api/notes-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }));
    saveChain = operation;
    return operation.catch(() => undefined);
  }
  window.addEventListener('pagehide', () => {
    deactivate();
    if (saveTimer) flushSave();
    if (viewSaveTimer) flushViewSave();
  });

  // ── 撤销 / 重做（线性栈，快照便签数组深克隆）──
  let history = [];
  let redoStack = [];
  function snapshot() {
    return {
      notes: notes.map((n) => Object.assign({}, n)),
      edges: edges.map((e) => Object.assign({}, e)),
      arrows: arrows.map((a) => Object.assign({}, a)),
    };
  }
  function commit(pre) {                       // 改动前把旧状态压栈
    history.push(pre);
    if (history.length > HISTORY_MAX) history.shift();
    redoStack.length = 0;
  }
  function swapTo(target) {
    cancelNoteInertia(false);
    notes = target.notes;
    edges = target.edges || [];
    arrows = target.arrows || [];
    expandedStack = null;
    renderAll();
    scheduleSave();
  }
  function undo() {
    if (!history.length) return;
    redoStack.push(snapshot());
    if (redoStack.length > HISTORY_MAX) redoStack.shift();
    swapTo(history.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    history.push(snapshot());
    if (history.length > HISTORY_MAX) history.shift();
    swapTo(redoStack.pop());
  }

  // ── 连线层（垫在所有便签下面，端点用便签实际渲染矩形的中心算，
  //    叠摞偏移 / 扇形展开 / 平移整墙 / 旋转角都能自然跟随）──
  const SVGNS = 'http://www.w3.org/2000/svg';
  let edgeSvg = null;
  let edgeStaticG = null;
  let edgeTempLine = null;
  let arrowStaticG = null;
  let arrowTempPath = null;
  function ensureEdgeSvg() {
    if (edgeSvg) return;
    edgeSvg = document.createElementNS(SVGNS, 'svg');
    edgeSvg.setAttribute('class', 'notes-edges');
    const defs = document.createElementNS(SVGNS, 'defs');
    const marker = document.createElementNS(SVGNS, 'marker');
    marker.setAttribute('id', 'notes-arrow-head');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8.5');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS(SVGNS, 'path');
    head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    marker.appendChild(head);
    defs.appendChild(marker);
    edgeSvg.appendChild(defs);
    edgeStaticG = document.createElementNS(SVGNS, 'g');
    edgeSvg.appendChild(edgeStaticG);
    arrowStaticG = document.createElementNS(SVGNS, 'g');
    edgeSvg.appendChild(arrowStaticG);
    edgeTempLine = document.createElementNS(SVGNS, 'line');
    edgeTempLine.setAttribute('class', 'notes-edge notes-edge-temp');
    edgeTempLine.style.display = 'none';
    edgeSvg.appendChild(edgeTempLine);
    arrowTempPath = document.createElementNS(SVGNS, 'path');
    arrowTempPath.setAttribute('class', 'notes-arrow notes-arrow-temp');
    arrowTempPath.setAttribute('marker-end', 'url(#notes-arrow-head)');
    arrowTempPath.style.display = 'none';
    edgeSvg.appendChild(arrowTempPath);
    surface.insertBefore(edgeSvg, surface.firstChild);   // 永远在便签之下
  }
  function noteCenter(id, srect) {
    const el = elById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - srect.left + r.width / 2, y: r.top - srect.top + r.height / 2 };
  }
  function renderEdges() {
    ensureEdgeSvg();
    const srect = surface.getBoundingClientRect();
    while (edgeStaticG.firstChild) edgeStaticG.removeChild(edgeStaticG.firstChild);
    while (arrowStaticG.firstChild) arrowStaticG.removeChild(arrowStaticG.firstChild);
    edges.forEach((ed) => {
      const a = noteCenter(ed.from, srect);
      const b = noteCenter(ed.to, srect);
      if (!a || !b) return;
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('class', 'notes-edge');
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.dataset.id = ed.id;
      if (searchQuery) line.classList.add(searchMatchIds.has(ed.from) && searchMatchIds.has(ed.to) ? 'search-match' : 'search-dim');
      edgeStaticG.appendChild(line);
    });
    arrows.forEach((ar) => {
      const pts = arrowPoints(ar, srect);
      if (!pts) return;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'notes-arrow');
      path.setAttribute('marker-end', 'url(#notes-arrow-head)');
      path.setAttribute('d', arrowPathD(pts.a, pts.b));
      path.dataset.id = ar.id;
      if (searchQuery) {
        const fromMatches = !ar.fromNote || searchMatchIds.has(ar.fromNote);
        const toMatches = !ar.toNote || searchMatchIds.has(ar.toNote);
        path.classList.add(fromMatches && toMatches ? 'search-match' : 'search-dim');
      }
      arrowStaticG.appendChild(path);
    });
  }
  function arrowPathD(a, b) {
    return 'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1)
      + ' L' + b.x.toFixed(1) + ',' + b.y.toFixed(1);
  }
  function arrowPoints(ar, srect) {
    const a = ar.fromNote ? noteCenter(ar.fromNote, srect) : worldToSurfacePoint(Number(ar.x1), Number(ar.y1));
    const b = ar.toNote ? noteCenter(ar.toNote, srect) : worldToSurfacePoint(Number(ar.x2), Number(ar.y2));
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y)
      || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
    return { a: a, b: b };
  }
  function pointSegmentDistance(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }
  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  function segmentsIntersect(a, b, c, d) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if (o1 === 0 && pointSegmentDistance(c, a, b) < 0.5) return true;
    if (o2 === 0 && pointSegmentDistance(d, a, b) < 0.5) return true;
    if (o3 === 0 && pointSegmentDistance(a, c, d) < 0.5) return true;
    if (o4 === 0 && pointSegmentDistance(b, c, d) < 0.5) return true;
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  }
  function edgeHitBySlash(ed, pts, srect) {
    const a = noteCenter(ed.from, srect);
    const b = noteCenter(ed.to, srect);
    if (!a || !b || pts.length < 2) return false;
    const HIT = 12;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      if (segmentsIntersect(p0, p1, a, b)) return true;
      if (pointSegmentDistance(p0, a, b) <= HIT || pointSegmentDistance(p1, a, b) <= HIT) return true;
      if (pointSegmentDistance(a, p0, p1) <= HIT || pointSegmentDistance(b, p0, p1) <= HIT) return true;
    }
    return false;
  }
  function arrowHitBySlash(ar, pts, srect) {
    const ab = arrowPoints(ar, srect);
    if (!ab || pts.length < 2) return false;
    const HIT = 12;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      if (segmentsIntersect(p0, p1, ab.a, ab.b)) return true;
      if (pointSegmentDistance(p0, ab.a, ab.b) <= HIT || pointSegmentDistance(p1, ab.a, ab.b) <= HIT) return true;
      if (pointSegmentDistance(ab.a, p0, p1) <= HIT || pointSegmentDistance(ab.b, p0, p1) <= HIT) return true;
    }
    return false;
  }

  // ── 渲染 ──
  function buildNoteEl(data) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.dataset.id = data.id;
    el.dataset.color = data.color;
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.setProperty('--note-rot', 'rotate(' + (data.rotate || 0) + 'deg)');
    el.style.setProperty('--note-shift', 'translate(0px,0px)');
    applyNoteTypography(el, data.text);

    const body = document.createElement('div');
    body.className = 'sticky-note-body';
    body.textContent = data.text || '';

    el.appendChild(body);
    wireNote(el, data);
    return el;
  }

  function refreshSearchVisuals() {
    const query = searchQuery.trim().toLocaleLowerCase();
    searchMatches = query
      ? notes.filter((note) => String(note.text || '').toLocaleLowerCase().includes(query))
      : [];
    searchMatchIds = new Set(searchMatches.map((note) => note.id));
    if (!searchMatches.length) searchIndex = -1;
    else if (searchIndex >= searchMatches.length) searchIndex = searchMatches.length - 1;
    surface.classList.toggle('notes-searching', !!query);
    notes.forEach((note) => {
      const el = elById(note.id);
      if (!el) return;
      el.classList.toggle('search-match', !!query && searchMatchIds.has(note.id));
      el.classList.toggle('search-current', !!query && searchIndex >= 0 && searchMatches[searchIndex] === note);
    });
    renderEdges();
  }

  function focusSearchResult(direction) {
    if (!searchMatches.length) return;
    searchIndex = searchIndex < 0
      ? (direction < 0 ? searchMatches.length - 1 : 0)
      : (searchIndex + direction + searchMatches.length) % searchMatches.length;
    const note = searchMatches[searchIndex];
    setActiveNote(note);
    refreshSearchVisuals();
    focusActiveNote();
  }

  function closeNoteSearch() {
    if (!searchInput) return;
    searchInput.remove();
    searchInput = null;
    searchQuery = '';
    searchMatches = [];
    searchIndex = -1;
    searchMatchIds = new Set();
    if (leftSpine) leftSpine.classList.remove('notes-search-active');
    refreshSearchVisuals();
    refreshKeyboardCurrent();
  }

  function openNoteSearch() {
    if (searchInput) { searchInput.focus(); return; }
    const input = document.createElement('textarea');
    input.className = 'notes-search-capture';
    input.setAttribute('aria-label', '搜索速记');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.addEventListener('input', () => {
      searchQuery = input.value;
      searchIndex = -1;
      refreshSearchVisuals();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeNoteSearch();
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        focusSearchResult(e.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', () => {
      if (searchInput === input) requestAnimationFrame(() => input.focus());
    });
    document.body.appendChild(input);
    searchInput = input;
    refreshKeyboardCurrent();
    if (leftSpine) leftSpine.classList.add('notes-search-active');
    input.focus();
  }

  function renderAll() {
    const world = ensureWorld();
    world.querySelectorAll('.sticky-note').forEach((el) => el.remove());
    notes.forEach((data) => world.appendChild(buildNoteEl(data)));
    relayout();
    refreshKeyboardCurrent();
  }

  // 按摞关系重排每张卡的位置偏移（--note-shift）与层级（z-index）；left/top 始终=数据 x/y。
  function relayout() {
    notes.forEach((data) => {
      const el = elById(data.id);
      if (!el) return;
      el.style.left = data.x + 'px';
      el.style.top = data.y + 'px';
      const group = groupMembers(data);
      const n = group.length;
      const idx = group.indexOf(data);
      const globalZ = notes.indexOf(data) + 1;
      if (n <= 1) {
        el.style.setProperty('--note-shift', 'translate(0px,0px)');
        el.style.zIndex = String(globalZ);
        return;
      }
      if (expandedStack === data.stack) {
        const center = (n - 1) / 2;
        const off = idx - center;
        const sx = Math.round(off * FAN_STEP);
        const sy = Math.round(Math.abs(off) * FAN_RISE);
        const rot = (off * FAN_ROT).toFixed(2);
        el.style.setProperty('--note-shift', 'translate(' + sx + 'px,' + sy + 'px) rotate(' + rot + 'deg)');
        el.style.zIndex = String(1000 + idx);
      } else {
        const depth = (n - 1) - idx;     // 顶层=0，下层依次向右下露出
        el.style.setProperty('--note-shift', 'translate(' + (depth * PILE_DX) + 'px,' + (depth * PILE_DY) + 'px)');
        el.style.zIndex = String(globalZ);
      }
    });
    renderEdges();
    refreshKeyboardCurrent();
  }

  // ── 便签拖动松手惯性：沿用画布/图谱的“平滑测速 + 时间无关摩擦”思路，
  //    只延续普通拖动；叠摞落定不甩，避免破坏压到一起的语义。
  let noteInertiaRaf = null;
  let noteInertiaDirty = false;
  function cancelNoteInertia(savePending) {
    const wasRunning = noteInertiaRaf != null;
    if (noteInertiaRaf != null) {
      cancelAnimationFrame(noteInertiaRaf);
      noteInertiaRaf = null;
    }
    surface.classList.remove('note-inertia');
    if (savePending && wasRunning && noteInertiaDirty) scheduleSave();
    noteInertiaDirty = false;
  }
  function startNoteInertia(members, dragState) {
    cancelNoteInertia(false);
    if (!Array.isArray(members) || !members.length || !dragState || dragState.velX == null) return;
    if (!(noteInertia > 0)) return;
    const now = performance.now();
    if (dragState.lastMoveT == null || now - dragState.lastMoveT > 70) return;
    let vx = dragState.velX * noteInertia;
    let vy = dragState.velY * noteInertia;
    let speed = Math.hypot(vx, vy);
    if (speed < 0.08) return;
    const MAX_V = 3.6;
    if (speed > MAX_V) {
      const k = MAX_V / speed;
      vx *= k; vy *= k;
    }
    const moving = members.filter((m) => notes.includes(m));
    if (!moving.length) return;
    noteInertiaDirty = false;
    surface.classList.add('note-inertia');
    let last = now;
    const step = (ts) => {
      noteInertiaRaf = null;
      let dt = ts - last;
      last = ts;
      if (!(dt > 0)) dt = 16.7;
      if (dt > 40) dt = 40;
      let dx = vx * dt;
      let dy = vy * dt;
      const rect = surface.getBoundingClientRect();
      const viewBounds = visibleWorldRect(rect);
      let minDx = -Infinity, maxDx = Infinity, minDy = -Infinity, maxDy = Infinity;
      moving.forEach((m) => {
        const el = elById(m.id);
        const w = el ? el.offsetWidth : NOTE_W;
        const h = el ? el.offsetHeight : NOTE_H;
        minDx = Math.max(minDx, viewBounds.left + EDGE - m.x);
        maxDx = Math.min(maxDx, viewBounds.right - w - EDGE - m.x);
        minDy = Math.max(minDy, viewBounds.top + EDGE - m.y);
        maxDy = Math.min(maxDy, viewBounds.bottom - h - EDGE - m.y);
      });
      const nextDx = clamp(dx, minDx, maxDx);
      const nextDy = clamp(dy, minDy, maxDy);
      if (nextDx !== dx) {
        vx = -vx * NOTES_BOUNCE;
        if (Math.abs(vx) < 0.035) vx = 0;
      }
      if (nextDy !== dy) {
        vy = -vy * NOTES_BOUNCE;
        if (Math.abs(vy) < 0.035) vy = 0;
      }
      dx = nextDx; dy = nextDy;
      moving.forEach((m) => {
        m.x = Math.round((m.x + dx) * 10) / 10;
        m.y = Math.round((m.y + dy) * 10) / 10;
        const el = elById(m.id);
        if (el) { el.style.left = m.x + 'px'; el.style.top = m.y + 'px'; }
      });
      noteInertiaDirty = true;
      renderEdges();
      const f = Math.exp(-0.0062 * dt);
      vx *= f; vy *= f;
      if (Math.hypot(vx, vy) > 0.018) {
        noteInertiaRaf = requestAnimationFrame(step);
      } else {
        surface.classList.remove('note-inertia');
        noteInertiaDirty = false;
        scheduleSave();
      }
    };
    noteInertiaRaf = requestAnimationFrame(step);
  }

  // ── 悬停展开 / 收拢 ──
  function setExpanded(stackId) {
    if (expandedStack === stackId) return;
    expandedStack = stackId;
    relayout();
  }
  function scheduleCollapse() {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => setExpanded(null), 90);
  }
  function cancelCollapse() { clearTimeout(collapseTimer); }
  function scheduleExpand(stackId) {
    clearTimeout(expandTimer);
    expandTimer = setTimeout(() => setExpanded(stackId), stackHoverDelay);
  }
  function cancelExpand() { clearTimeout(expandTimer); }

  function visibleNoteBounds(rect) {
    const viewBounds = visibleWorldRect(rect || surface.getBoundingClientRect());
    const minX = viewBounds.left + EDGE;
    const minY = viewBounds.top + EDGE;
    return {
      minX: minX,
      minY: minY,
      maxX: Math.max(minX, viewBounds.right - NOTE_W - EDGE),
      maxY: Math.max(minY, viewBounds.bottom - NOTE_H - EDGE),
    };
  }

  function rotateActiveNote(straighten) {
    const data = activeNote();
    if (!data) return;
    const next = straighten
      ? 0
      : Math.round((Math.random() * 14 - 7) * 10) / 10;
    if (Math.abs((data.rotate || 0) - next) < 0.05) return;
    const pre = snapshot();
    data.rotate = next;
    const el = elById(data.id);
    if (el) el.style.setProperty('--note-rot', 'rotate(' + next + 'deg)');
    commit(pre);
    scheduleSave();
  }

  function duplicateActiveNote() {
    const src = activeNote();
    if (!src) return;
    cancelNoteInertia(true);
    const rect = surface.getBoundingClientRect();
    const bounds = visibleNoteBounds(rect);
    const el = elById(src.id);
    let x = src.x;
    let y = src.y;
    if (el) {
      const er = el.getBoundingClientRect();
      const p = surfaceToWorldPoint(er.left - rect.left, er.top - rect.top);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        x = p.x;
        y = p.y;
      }
    }
    const originX = clamp(x + 30, bounds.minX, bounds.maxX);
    const originY = clamp(y + 30, bounds.minY, bounds.maxY);
    const landing = avoidCrowding(originX, originY, bounds.minX, bounds.maxX, bounds.minY, bounds.maxY);
    const data = {
      id: genId(),
      x: Math.round(landing.x),
      y: Math.round(landing.y),
      color: src.color || nextColor(),
      text: src.text || '',
      rotate: Number.isFinite(Number(src.rotate)) ? Number(src.rotate) : 0,
      createdAt: new Date().toISOString(),
    };
    const pre = snapshot();
    notes.push(data);
    const copyEl = buildNoteEl(data);
    setActiveNote(data);
    if (!prefersReduced) {
      copyEl.style.setProperty('--note-arrive-x', (originX - data.x).toFixed(1) + 'px');
      copyEl.style.setProperty('--note-arrive-y', (originY - data.y).toFixed(1) + 'px');
      copyEl.classList.add('note-enter');
      copyEl.addEventListener('animationend', () => copyEl.classList.remove('note-enter'), { once: true });
    }
    ensureWorld().appendChild(copyEl);
    commit(pre);
    relayout();
    scheduleSave();
  }

  // ── 创建 ──
  function noteOverlap(x, y, data) {
    const dx = Math.max(0, Math.min(x + NOTE_W, data.x + NOTE_W) - Math.max(x, data.x));
    const dy = Math.max(0, Math.min(y + NOTE_H, data.y + NOTE_H) - Math.max(y, data.y));
    return dx * dy;
  }
  // 保留「随手落下」的自然感，只在明显压住已有便签时滑向附近最空的位置。
  function avoidCrowding(x, y, minX, maxX, minY, maxY) {
    if (!notes.length) return { x: x, y: y };
    const candidates = [{ x: x, y: y }];
    const rings = [54, 92, 136, 182];
    rings.forEach((r) => {
      for (let i = 0; i < 12; i++) {
        const a = Math.PI * 2 * i / 12;
        candidates.push({ x: clamp(x + Math.cos(a) * r, minX, maxX), y: clamp(y + Math.sin(a) * r, minY, maxY) });
      }
    });
    let best = candidates[0];
    let bestScore = Infinity;
    candidates.forEach((candidate) => {
      const overlap = notes.reduce((sum, data) => sum + noteOverlap(candidate.x, candidate.y, data), 0);
      const distance = Math.hypot(candidate.x - x, candidate.y - y);
      const score = overlap * 8 + distance;
      if (score < bestScore) { best = candidate; bestScore = score; }
    });
    return best;
  }
  function createNoteAt(localX, localY, options) {
    const opts = options || {};
    cancelNoteInertia(true);
    const rect = surface.getBoundingClientRect();
    const viewBounds = visibleWorldRect(rect);
    const minX = viewBounds.left + EDGE;
    const minY = viewBounds.top + EDGE;
    const maxX = Math.max(minX, viewBounds.right - NOTE_W - EDGE);
    const maxY = Math.max(minY, viewBounds.bottom - NOTE_H - EDGE);
    const originX = clamp(localX - NOTE_W / 2, minX, maxX);
    const originY = clamp(localY - NOTE_H / 2, minY, maxY);
    const landing = avoidCrowding(originX, originY, minX, maxX, minY, maxY);
    const data = {
      id: genId(),
      x: Math.round(landing.x),
      y: Math.round(landing.y),
      color: nextColor(),
      text: '',
      rotate: Math.round((Math.random() * 8 - 4) * 10) / 10,   // -4°~4°
      createdAt: new Date().toISOString(),
    };
    const pre = snapshot();      // 新便签和可选连线作为同一次历史操作
    notes.push(data);
    if (opts.linkFrom && opts.linkFrom !== data.id && !hasEdge(opts.linkFrom, data.id)) {
      edges.push({ id: genEdgeId(), from: opts.linkFrom, to: data.id });
    }
    const el = buildNoteEl(data);
    setActiveNote(data);
    if (!prefersReduced) {
      el.style.setProperty('--note-arrive-x', (originX - data.x).toFixed(1) + 'px');
      el.style.setProperty('--note-arrive-y', (originY - data.y).toFixed(1) + 'px');
      el.classList.add('note-enter');
    }
    ensureWorld().appendChild(el);
    el.addEventListener('animationend', () => el.classList.remove('note-enter'), { once: true });
    commit(pre);
    relayout();
    scheduleSave();
    if (opts.edit) requestAnimationFrame(() => enterEdit(el, data));
    return data;
  }

  function createFromActive(direction, linked) {
    const src = activeNote();
    if (!src) return false;
    const gap = 72;
    const centerX = direction === 'down'
      ? src.x + NOTE_W / 2
      : src.x + NOTE_W + gap + NOTE_W / 2;
    const centerY = direction === 'down'
      ? src.y + NOTE_H + gap + NOTE_H / 2
      : src.y + NOTE_H / 2;
    createNoteAt(centerX, centerY, { edit: true, linkFrom: linked ? src.id : null });
    return true;
  }

  function createAtPointerOrCenter() {
    const rect = surface.getBoundingClientRect();
    let clientX = rect.left + rect.width / 2;
    let clientY = rect.top + rect.height / 2;
    if (lastPointer && lastPointer.inside) {
      clientX = lastPointer.clientX;
      clientY = lastPointer.clientY;
      const underPointer = document.elementFromPoint(clientX, clientY);
      if (underPointer && underPointer.closest('.sticky-note')) return false;
    }
    const point = clientToWorldPoint(clientX, clientY, rect);
    createNoteAt(point.x, point.y, { edit: true });
    return true;
  }

  // ── 删除单张（不记历史，历史由调用方统一记一次）──
  function applyDelete(data) {
    const idx = notes.indexOf(data);
    if (idx < 0) return;
    notes.splice(idx, 1);
    const el = elById(data.id);
    if (el) {
      if (prefersReduced) {
        el.remove();
      } else {
        el.classList.add('note-leaving');
        let done = false;
        const fin = () => { if (done) return; done = true; el.remove(); };
        el.addEventListener('animationend', fin, { once: true });
        setTimeout(fin, 280);
      }
    }
    scheduleSave();
  }

  // ── 编辑 ──
  let editingEl = null;
  function enterEdit(el, data) {
    if (editingEl && editingEl !== el) editingEl.querySelector('.sticky-note-body').blur();
    const body = el.querySelector('.sticky-note-body');
    if (!body) return;
    const pre = snapshot();
    el.classList.add('editing');
    editingEl = el;
    body.setAttribute('contenteditable', 'plaintext-only');
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      body.removeEventListener('blur', finish);
      body.removeAttribute('contenteditable');
      el.classList.remove('editing');
      if (editingEl === el) editingEl = null;
      const next = body.textContent || '';
      applyNoteTypography(el, next);
      if (next !== data.text) { commit(pre); data.text = next; scheduleSave(); }
      // 字号档位或正文换行可能改变卡片高度；等待布局落定后再校准连线中心。
      requestAnimationFrame(renderEdges);
    };
    body.addEventListener('blur', finish);
    body.addEventListener('keydown', (e) => {
      e.stopPropagation();                         // Ctrl+Z 交给浏览器做字符撤销
      if (e.key === 'Escape') { e.preventDefault(); body.blur(); }
    });
  }

  // 把展开态某张卡从摞里拉成自由便签，落到它当前视觉位置
  function detachToFree(data) {
    const members = groupMembers(data);
    const n = members.length;
    const idx = members.indexOf(data);
    const center = (n - 1) / 2;
    const off = idx - center;
    const ax = members[0].x;
    const ay = members[0].y;
    const rect = surface.getBoundingClientRect();
    const viewBounds = visibleWorldRect(rect);
    const minX = viewBounds.left + EDGE;
    const minY = viewBounds.top + EDGE;
    const maxX = Math.max(minX, viewBounds.right - NOTE_W - EDGE);
    const maxY = Math.max(minY, viewBounds.bottom - NOTE_H - EDGE);
    data.x = clamp(Math.round(ax + off * FAN_STEP), minX, maxX);
    data.y = clamp(Math.round(ay + Math.abs(off) * FAN_RISE), minY, maxY);
    delete data.stack;
    const i = notes.indexOf(data);
    if (i >= 0) { notes.splice(i, 1); notes.push(data); }
  }

  // 找落点下方、最顶层、且不属于排除摞/自身的便签（用于叠摞命中）
  function groupAt(localX, localY, excludeStack, excludeId, rect) {
    for (let i = notes.length - 1; i >= 0; i--) {
      const nd = notes[i];
      if (nd.id === excludeId) continue;
      if (excludeStack && nd.stack === excludeStack) continue;
      const el = elById(nd.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const x0 = r.left - rect.left;
      const y0 = r.top - rect.top;
      if (localX >= x0 && localX <= x0 + r.width && localY >= y0 && localY <= y0 + r.height) return nd;
    }
    return null;
  }

  // 把一组便签并入 target 所在的摞（target 在下、members 叠上去）
  function mergeGroupInto(members, target) {
    let sid = target.stack;
    if (!sid) { sid = genStackId(); target.stack = sid; }
    members.forEach((m) => { m.stack = sid; m.x = target.x; m.y = target.y; });
    moveGroupToEnd(members);     // 叠到最上层
  }

  // ── Alt + 从一张便签拖到另一张 = 拉一条连线 ──
  function startEdgeDraw(srcEl, srcData, downEv) {
    cancelNoteInertia(true);
    ensureEdgeSvg();
    interacting = true;
    cancelCollapse();
    cancelExpand();
    setExpanded(null);
    const srect = surface.getBoundingClientRect();
    const src = noteCenter(srcData.id, srect) || { x: 0, y: 0 };
    edgeTempLine.style.display = '';
    edgeTempLine.setAttribute('x1', src.x.toFixed(1));
    edgeTempLine.setAttribute('y1', src.y.toFixed(1));
    edgeTempLine.setAttribute('x2', src.x.toFixed(1));
    edgeTempLine.setAttribute('y2', src.y.toFixed(1));
    surface.classList.add('linking');
    let hovered = null;
    try { srcEl.setPointerCapture(downEv.pointerId); } catch (err) {}

    const setHover = (tgt) => {
      if (hovered && (!tgt || tgt.id !== hovered.id)) {
        const he = elById(hovered.id);
        if (he) he.classList.remove('link-target');
        hovered = null;
      }
      if (tgt && (!hovered || hovered.id !== tgt.id)) {
        const te = elById(tgt.id);
        if (te) te.classList.add('link-target');
        hovered = tgt;
      }
    };
    const onMove = (ev) => {
      const lx = ev.clientX - srect.left;
      const ly = ev.clientY - srect.top;
      edgeTempLine.setAttribute('x2', lx.toFixed(1));
      edgeTempLine.setAttribute('y2', ly.toFixed(1));
      setHover(groupAt(lx, ly, null, srcData.id, srect));
    };
    const cleanup = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { srcEl.releasePointerCapture(ev.pointerId); } catch (err) {}
      setHover(null);
      edgeTempLine.style.display = 'none';
      surface.classList.remove('linking');
      interacting = false;
    };
    const onUp = (ev) => {
      const lx = ev.clientX - srect.left;
      const ly = ev.clientY - srect.top;
      const tgt = groupAt(lx, ly, null, srcData.id, srect);
      cleanup(ev);
      if (tgt && tgt.id !== srcData.id && !hasEdge(srcData.id, tgt.id)) {
        commit(snapshot());
        edges.push({ id: genEdgeId(), from: srcData.id, to: tgt.id });
        renderEdges();
        scheduleSave();
      }
    };
    const onCancel = (ev) => cleanup(ev);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // ── 右键拖出箭头：端点落在便签上就绑定便签，落在空白就是自由坐标 ──
  function startArrowDraw(downEv) {
    cancelNoteInertia(true);
    ensureEdgeSvg();
    downEv.preventDefault();
    interacting = true;
    cancelCollapse();
    cancelExpand();
    setExpanded(null);
    const srect = surface.getBoundingClientRect();
    const sx = downEv.clientX - srect.left;
    const sy = downEv.clientY - srect.top;
    const source = groupAt(sx, sy, null, null, srect);
    const start = source ? (noteCenter(source.id, srect) || { x: sx, y: sy }) : { x: sx, y: sy };
    arrowTempPath.style.display = '';
    arrowTempPath.setAttribute('d', arrowPathD(start, start));
    surface.classList.add('arrowing');
    let end = start;
    let moved = false;
    let hovered = null;

    const setHover = (tgt) => {
      if (hovered && (!tgt || tgt.id !== hovered.id)) {
        const he = elById(hovered.id);
        if (he) he.classList.remove('arrow-target');
        hovered = null;
      }
      if (tgt && (!hovered || hovered.id !== tgt.id)) {
        const te = elById(tgt.id);
        if (te) te.classList.add('arrow-target');
        hovered = tgt;
      }
    };
    const cleanup = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { surface.releasePointerCapture(ev.pointerId); } catch (err) {}
      setHover(null);
      arrowTempPath.style.display = 'none';
      surface.classList.remove('arrowing');
      interacting = false;
    };
    const onMove = (ev) => {
      const lx = ev.clientX - srect.left;
      const ly = ev.clientY - srect.top;
      end = { x: lx, y: ly };
      moved = moved || Math.hypot(lx - sx, ly - sy) >= 14;
      arrowTempPath.setAttribute('d', arrowPathD(start, end));
      setHover(groupAt(lx, ly, null, source ? source.id : null, srect));
    };
    const onUp = (ev) => {
      const lx = ev.clientX - srect.left;
      const ly = ev.clientY - srect.top;
      const target = groupAt(lx, ly, null, source ? source.id : null, srect);
      cleanup(ev);
      if (!moved) return;
      const targetPoint = target ? (noteCenter(target.id, srect) || { x: lx, y: ly }) : { x: lx, y: ly };
      if (!source && !target && Math.hypot(targetPoint.x - start.x, targetPoint.y - start.y) < 18) return;
      const ar = { id: genArrowId() };
      if (source) ar.fromNote = source.id;
      else {
        const startWorld = surfaceToWorldPoint(start.x, start.y);
        ar.x1 = Math.round(startWorld.x * 10) / 10;
        ar.y1 = Math.round(startWorld.y * 10) / 10;
      }
      if (target) ar.toNote = target.id;
      else {
        const targetWorld = surfaceToWorldPoint(targetPoint.x, targetPoint.y);
        ar.x2 = Math.round(targetWorld.x * 10) / 10;
        ar.y2 = Math.round(targetWorld.y * 10) / 10;
      }
      commit(snapshot());
      arrows.push(ar);
      renderEdges();
      scheduleSave();
    };
    const onCancel = (ev) => cleanup(ev);
    try { surface.setPointerCapture(downEv.pointerId); } catch (err) {}
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // ── 单张便签的事件 ──
  function wireNote(el, data) {
    el.addEventListener('mouseenter', () => {
      setActiveNote(data);
      if (interacting || editingEl) return;
      if (isMultiPile(data)) { cancelCollapse(); scheduleExpand(data.stack); }
      else scheduleCollapse();          // 移到散便签上 → 收拢已展开的摞
    });
    el.addEventListener('mouseleave', () => {
      if (interacting) return;
      if (isMultiPile(data)) { cancelExpand(); scheduleCollapse(); }
    });

    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearPageSelection();
      setActiveNote(data);
      if (!el.classList.contains('editing')) enterEdit(el, data);
    });

    // 拖动：收拢摞/散便签整体移动；展开态拖单张则拉出
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (el.classList.contains('editing')) return;
      e.stopPropagation();                         // 起手在便签上 = 拖动，绝不触发台面「划一刀」
      if (e.altKey) {
        e.preventDefault();
        startEdgeDraw(el, data, e);
        return;
      }
      cancelNoteInertia(true);
      setActiveNote(data);
      const pre = snapshot();
      const rect = surface.getBoundingClientRect();
      const dragScale = viewScale;
      const startX = e.clientX;
      const startY = e.clientY;
      const wasExpandedMember = isMultiPile(data) && expandedStack === data.stack;
      let dragging = false;
      let members = null;
      let origs = null;
      const dragState = { velX: null, velY: null, lastMoveX: startX, lastMoveY: startY, lastMoveT: null };
      interacting = true;
      cancelCollapse();
      cancelExpand();

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / dragScale;
        const dy = (ev.clientY - startY) / dragScale;
        if (!dragging) {
          if (Math.hypot(dx, dy) < 4) return;
          dragging = true;
          if (wasExpandedMember) {
            detachToFree(data);                    // 从摞里拉出这一张
            expandedStack = null;
          } else {
            moveGroupToEnd(groupMembers(data));    // 整摞/散便签提到最前
          }
          members = groupMembers(data);
          origs = members.map((m) => ({ m: m, x: m.x, y: m.y }));
          el.classList.add('dragging');
          try { el.setPointerCapture(ev.pointerId); } catch (err) {}
          relayout();
        }
        const viewBounds = visibleWorldRect(rect);
        const minX = viewBounds.left + EDGE;
        const minY = viewBounds.top + EDGE;
        const maxX = Math.max(minX, viewBounds.right - el.offsetWidth - EDGE);
        const maxY = Math.max(minY, viewBounds.bottom - el.offsetHeight - EDGE);
        const base = origs.find((o) => o.m === data);
        const nx = clamp(Math.round(base.x + dx), minX, maxX);
        const ny = clamp(Math.round(base.y + dy), minY, maxY);
        const rdx = nx - base.x;
        const rdy = ny - base.y;
        origs.forEach((o) => {
          o.m.x = o.x + rdx;
          o.m.y = o.y + rdy;
          const me = elById(o.m.id);
          if (me) { me.style.left = o.m.x + 'px'; me.style.top = o.m.y + 'px'; }
        });
        const now = performance.now();
        if (dragState.lastMoveT != null) {
          const dt = now - dragState.lastMoveT;
          if (dt > 0) {
            const ivx = (ev.clientX - dragState.lastMoveX) / dt / dragScale;
            const ivy = (ev.clientY - dragState.lastMoveY) / dt / dragScale;
            dragState.velX = dragState.velX == null ? ivx : dragState.velX * 0.4 + ivx * 0.6;
            dragState.velY = dragState.velY == null ? ivy : dragState.velY * 0.4 + ivy * 0.6;
          }
        }
        dragState.lastMoveX = ev.clientX;
        dragState.lastMoveY = ev.clientY;
        dragState.lastMoveT = now;
        renderEdges();
      };
      const onUp = (ev) => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        try { el.releasePointerCapture(ev.pointerId); } catch (err) {}
        interacting = false;
        if (dragging) {
          el.classList.remove('dragging');
          const base = origs.find((o) => o.m === data);
          const moved = data.x !== base.x || data.y !== base.y;
          // 叠摞命中：落点中心压在别的摞/便签上 → 并过去
          const center = worldToSurfacePoint(data.x + el.offsetWidth / 2, data.y + el.offsetHeight / 2);
          const target = groupAt(center.x, center.y, data.stack, data.id, rect);
          if (target) mergeGroupInto(members, target);
          normalizeStacks();
          if (moved || target || wasExpandedMember) { commit(pre); scheduleSave(); }
          relayout();
          if (moved && !target) startNoteInertia(members, dragState);
        }
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  // ── 台面：双击空白生成 ──
  surface.addEventListener('dblclick', (e) => {
    if (!loaded) return;
    e.preventDefault();
    e.stopPropagation();
    clearPageSelection();
    if (spaceHeld) return;
    if (e.target.closest('.sticky-note')) return;
    const rect = surface.getBoundingClientRect();
    const point = clientToWorldPoint(e.clientX, e.clientY, rect);
    createNoteAt(point.x, point.y);
  });
  // 鼠标离开整面墙 → 收拢展开的摞
  surface.addEventListener('mouseleave', () => { if (!interacting) setExpanded(null); });

  // ── 台面：在空白处「划一刀」删除划过的便签 ──
  function pathLen(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }
  function ensureSlashSvg(st) {
    if (st.svg) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'notes-slash');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
    surface.appendChild(svg);
    st.svg = svg;
    st.line = path;
  }
  // 平滑采样点，软化转折处的尖角
  function smoothPoints(pts) {
    if (pts.length <= 2) return pts.slice();
    let out = pts;
    for (let pass = 0; pass < 2; pass++) {
      const s = [out[0]];
      for (let i = 1; i < out.length - 1; i++) {
        s.push({
          x: (out[i - 1].x + out[i].x * 2 + out[i + 1].x) / 4,
          y: (out[i - 1].y + out[i].y * 2 + out[i + 1].y) / 4,
        });
      }
      s.push(out[out.length - 1]);
      out = s;
    }
    return out;
  }
  // 把手势点串做成「两端收尖、中段最宽」的刀锋填充路径（像一笔挥过的笔触）
  function bladePath(pts) {
    if (pts.length < 2) return '';
    const p = smoothPoints(pts);
    const n = p.length;
    const seg = [0];
    for (let i = 1; i < n; i++) seg[i] = seg[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    const total = seg[n - 1] || 1;
    const MAXW = 9;
    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) {
      const a = p[Math.max(0, i - 1)];
      const b = p[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy;
      const ny = dx;
      const t = seg[i] / total;
      const w = MAXW * Math.pow(Math.sin(Math.PI * t), 0.6) + 0.6;   // 两端→0、中段最宽
      left.push({ x: p[i].x + nx * w / 2, y: p[i].y + ny * w / 2 });
      right.push({ x: p[i].x - nx * w / 2, y: p[i].y - ny * w / 2 });
    }
    let d = 'M' + left[0].x.toFixed(1) + ',' + left[0].y.toFixed(1);
    for (let i = 1; i < n; i++) d += 'L' + left[i].x.toFixed(1) + ',' + left[i].y.toFixed(1);
    for (let i = n - 1; i >= 0; i--) d += 'L' + right[i].x.toFixed(1) + ',' + right[i].y.toFixed(1);
    return d + 'Z';
  }
  function updateSlashLine(st) {
    if (st.line) st.line.setAttribute('d', bladePath(st.points));
  }
  function fadeSlash(svg) {
    if (!svg) return;
    svg.classList.add('fading');
    setTimeout(() => svg.remove(), 260);
  }
  function finishSlash(st) {
    if (pathLen(st.points) >= SLASH_MIN) {
      // 用元素的实际渲染矩形判定（兼容摞的偏移 / 展开扇形）
      const hits = notes.filter((data) => {
        const el = elById(data.id);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x0 = r.left - st.rect.left;
        const y0 = r.top - st.rect.top;
        return st.points.some((p) => p.x >= x0 && p.x <= x0 + r.width && p.y >= y0 && p.y <= y0 + r.height);
      });
      const hitIds = new Set(edges.filter((ed) => edgeHitBySlash(ed, st.points, st.rect)).map((ed) => ed.id));
      const hitArrowIds = new Set(arrows.filter((ar) => arrowHitBySlash(ar, st.points, st.rect)).map((ar) => ar.id));
      if (hits.length || hitIds.size || hitArrowIds.size) {
        commit(snapshot());
        hits.forEach(applyDelete);
        if (hitIds.size) edges = edges.filter((ed) => !hitIds.has(ed.id));
        if (hitArrowIds.size) arrows = arrows.filter((ar) => !hitArrowIds.has(ar.id));
        if (hits.length) { pruneEdges(); pruneArrows(); }
        normalizeStacks();
        relayout();
        scheduleSave();
      }
    }
    fadeSlash(st.svg);
  }

  surface.addEventListener('pointerdown', (e) => {
    if (!loaded) return;
    if (e.button === 0 || e.button === 2) {
      cancelNoteInertia(true);
      cancelViewPanInertia();
    }
    const rect = surface.getBoundingClientRect();
    if (e.button === 2) {
      startArrowDraw(e);
      return;
    }
    if (e.button !== 0) return;
    if (e.target.closest('.sticky-note')) return;
    if (spaceHeld) {
      e.preventDefault();
      interacting = true;
      cancelCollapse();
      cancelExpand();
      setExpanded(null);
      surface.classList.add('panning');
      const startX = e.clientX;
      const startY = e.clientY;
      const startViewX = viewX;
      const startViewY = viewY;
      let panFrame = 0;
      let latest = e;
      let moved = false;
      const panState = {
        velX: null,
        velY: null,
        lastMoveX: e.clientX,
        lastMoveY: e.clientY,
        lastMoveT: performance.now(),
      };
      try { surface.setPointerCapture(e.pointerId); } catch (err) {}
      const draw = () => {
        panFrame = 0;
        const rawX = latest.clientX - startX;
        const rawY = latest.clientY - startY;
        const dx = resisted(rawX, -rect.width * 2.2, rect.width * 2.2);
        const dy = resisted(rawY, -rect.height * 2.2, rect.height * 2.2);
        moved = moved || Math.hypot(dx, dy) >= 2;
        viewX = startViewX + dx;
        viewY = startViewY + dy;
        applyView(false);
      };
      const onMove = (ev) => {
        const now = performance.now();
        const dt = now - panState.lastMoveT;
        if (dt > 0) {
          const ivx = (ev.clientX - panState.lastMoveX) / dt;
          const ivy = (ev.clientY - panState.lastMoveY) / dt;
          panState.velX = panState.velX == null ? ivx : panState.velX * 0.4 + ivx * 0.6;
          panState.velY = panState.velY == null ? ivy : panState.velY * 0.4 + ivy * 0.6;
        }
        panState.lastMoveX = ev.clientX;
        panState.lastMoveY = ev.clientY;
        panState.lastMoveT = now;
        latest = ev;
        if (!panFrame) panFrame = requestAnimationFrame(draw);
      };
      const onUp = (ev) => {
        surface.removeEventListener('pointermove', onMove);
        surface.removeEventListener('pointerup', onUp);
        surface.removeEventListener('pointercancel', onUp);
        if (panFrame) { cancelAnimationFrame(panFrame); draw(); }
        try { surface.releasePointerCapture(ev.pointerId); } catch (err) {}
        surface.classList.remove('panning');
        interacting = false;
        if (moved) {
          saveViewSoon();
          startViewPanInertia(panState);
        }
      };
      surface.addEventListener('pointermove', onMove);
      surface.addEventListener('pointerup', onUp);
      surface.addEventListener('pointercancel', onUp);
      return;
    }
    const st = {
      points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }],
      rect: rect, started: false, svg: null, line: null,
    };
    try { surface.setPointerCapture(e.pointerId); } catch (err) {}
    const onMove = (ev) => {
      st.points.push({ x: ev.clientX - st.rect.left, y: ev.clientY - st.rect.top });
      if (!st.started) {
        if (pathLen(st.points) < 8) return;
        st.started = true;
        ensureSlashSvg(st);
      }
      updateSlashLine(st);
    };
    const onUp = (ev) => {
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onUp);
      try { surface.releasePointerCapture(ev.pointerId); } catch (err) {}
      finishSlash(st);
    };
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onUp);
  });
  surface.addEventListener('contextmenu', (e) => e.preventDefault());
  surface.addEventListener('pointermove', (e) => {
    lastPointer = { clientX: e.clientX, clientY: e.clientY, inside: true };
  });
  surface.addEventListener('pointerleave', () => {
    if (lastPointer) lastPointer.inside = false;
  });
  document.addEventListener('pointerdown', (e) => {
    if (searchInput && !surface.contains(e.target)) closeNoteSearch();
  }, true);

  function notesPageActive() {
    const bv = document.querySelector('.book-view');
    return !!(bv && bv.classList.contains('notes-active'));
  }
  function wheelPixels(event) {
    const unit = event.deltaMode === 1 ? 18 : (event.deltaMode === 2 ? surface.clientHeight : 1);
    return {
      x: event.deltaX * unit,
      y: event.deltaY * unit,
    };
  }
  function startViewArrowPan() {
    if (viewArrowRaf == null) {
      viewArrowRaf = requestAnimationFrame(viewArrowTick);
    }
  }
  function viewArrowTick(ts) {
    viewArrowRaf = null;
    let dx = 0;
    let dy = 0;
    if (viewArrowKeys.ArrowLeft) dx += NOTES_KEY_PAN;
    if (viewArrowKeys.ArrowRight) dx -= NOTES_KEY_PAN;
    if (viewArrowKeys.ArrowUp) dy += NOTES_KEY_PAN;
    if (viewArrowKeys.ArrowDown) dy -= NOTES_KEY_PAN;
    if (!dx && !dy) {
      viewArrowTs = 0;
      return;
    }
    if (typeof ts !== 'number') ts = performance.now();
    let frames = viewArrowTs ? (ts - viewArrowTs) / (1000 / 60) : 1;
    viewArrowTs = ts;
    if (!(frames > 0)) frames = 1;
    frames = Math.max(0.35, Math.min(3, frames));
    const speed = viewArrowShift ? 3 : 1;
    panViewBy(dx * frames * speed, dy * frames * speed, false);
    saveViewSoon();
    viewArrowRaf = requestAnimationFrame(viewArrowTick);
  }
  function stopViewArrowPan() {
    if (viewArrowRaf != null) {
      cancelAnimationFrame(viewArrowRaf);
      viewArrowRaf = null;
    }
    viewArrowTs = 0;
  }
  function clearViewArrowKeys() {
    viewArrowKeys.ArrowUp = false;
    viewArrowKeys.ArrowDown = false;
    viewArrowKeys.ArrowLeft = false;
    viewArrowKeys.ArrowRight = false;
    viewArrowShift = false;
    stopViewArrowPan();
  }

  surface.addEventListener('wheel', (e) => {
    if (!loaded || !notesPageActive()) return;
    const delta = wheelPixels(e);
    e.preventDefault();
    e.stopPropagation();
    cancelNoteInertia(true);
    if (!delta.y) return;
    const step = Math.abs(delta.y);
    const dir = delta.y > 0 ? -1 : 1;
    const factor = Math.exp(dir * Math.min(step, 220) / 220 * Math.log(1.12));
    zoomViewTo(targetViewScale * factor, e.clientX, e.clientY);
  }, { passive: false });

  // ── 键盘：无 UI 创建 / 续写 / 定位，以及原有编辑快捷键 ──
  document.addEventListener('keydown', (e) => {
    if (!loaded || !notesPageActive()) return;
    if (searchInput) return;                          // 搜索输入自身接管文字、回车与退出
    if (editingEl) return;                            // 写字时让浏览器做字符级撤销
    if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, [contenteditable], [role="dialog"]')) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (stopKeyboardBrowse()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if ((e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'k')
      && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (browseNotes(e.key.toLowerCase() === 'j' ? 1 : -1)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openNoteSearch();
      return;
    }
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      spaceHeld = true;
      surface.classList.add('space-ready');
      return;
    }
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (createAtPointerOrCenter()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (createFromActive(e.shiftKey ? 'down' : 'right', false)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (createFromActive(e.shiftKey ? 'down' : 'right', true)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      fitAllNotes();
      return;
    }
    if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!activeNote()) return;
      e.preventDefault();
      e.stopPropagation();
      focusActiveNote();
      return;
    }
    if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const data = notes.find((note) => note.id === activeNoteId);
      if (!data) return;
      e.preventDefault();
      const pre = snapshot();
      const current = stickyPalette && stickyPalette.byKey(data.color);
      const picked = stickyPalette && stickyPalette.pick({
        excludeKey: data.color,
        excludeFamily: current ? current.family : '',
      });
      data.color = picked ? picked.key : 'yellow';
      lastColor = data.color;
      lastColorFamily = picked ? picked.family : '';
      const el = elById(data.id);
      if (el) {
        el.dataset.color = data.color;
        if (!prefersReduced) {
          el.classList.remove('note-recolor');
          void el.offsetWidth;
          el.classList.add('note-recolor');
          el.addEventListener('animationend', () => el.classList.remove('note-recolor'), { once: true });
        }
      }
      commit(pre);
      scheduleSave();
      return;
    }
    if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      rotateActiveNote(e.shiftKey);
      return;
    }
    if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      duplicateActiveNote();
      return;
    }
    if (Object.prototype.hasOwnProperty.call(viewArrowKeys, e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      cancelNoteInertia(true);
      viewArrowKeys[e.key] = true;
      viewArrowShift = e.shiftKey;
      startViewArrowPan();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); redo(); }
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceHeld = false;
      surface.classList.remove('space-ready');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(viewArrowKeys, e.key)) {
      viewArrowKeys[e.key] = false;
      if (!viewArrowKeys.ArrowUp && !viewArrowKeys.ArrowDown
        && !viewArrowKeys.ArrowLeft && !viewArrowKeys.ArrowRight) stopViewArrowPan();
    } else if (e.key === 'Shift') {
      viewArrowShift = false;
    }
  }, true);
  window.addEventListener('blur', () => {
    spaceHeld = false;
    surface.classList.remove('space-ready');
    clearViewArrowKeys();
    cancelNoteInertia(true);
  });

  // ── 数据加载 ──
  function load() {
    if (loaded) return Promise.resolve(true);
    if (loading) return loading;
    loading = fetch('/api/notes')
      .then((r) => r.json())
      .then((json) => {
        loaded = true;
        if (touched) return true;
        notes = (json && Array.isArray(json.notes)) ? json.notes : [];
        edges = (json && Array.isArray(json.edges)) ? json.edges : [];
        arrows = (json && Array.isArray(json.arrows)) ? json.arrows : [];
        cancelNoteInertia(false);
        renderAll();
        if (searchInput) refreshSearchVisuals();
        return true;
      })
      .catch(() => false)
      .finally(() => { loading = null; });
    return loading;
  }

  function cancelPreload() {
    if (!preloadHandle) return;
    if (preloadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(preloadHandle);
    } else {
      window.clearTimeout(preloadHandle);
    }
    preloadHandle = 0;
    preloadUsesIdle = false;
  }

  // 起步页稳定后在隐藏状态读取并构建速记墙；真正翻入页面时只需校准连线几何。
  function schedulePreload() {
    if (preloadHandle || loaded || loading) return;
    const warm = () => {
      preloadHandle = 0;
      preloadUsesIdle = false;
      load().catch(() => undefined);
    };
    preloadUsesIdle = typeof window.requestIdleCallback === 'function';
    preloadHandle = preloadUsesIdle
      ? window.requestIdleCallback(warm, { timeout: 1500 })
      : window.setTimeout(warm, 600);
  }

  // ── 整墙归档（长按速记图标触发）──
  // 有名字的便签搬进「学习归档」，无名的丢弃；之后整墙清空。归档是「定局」动作，
  // 不进撤销栈（后端已建好归档夹并清空 notes.json，本地再撤销会造成两边不一致）。
  function archive() {
    if (!loaded) return load().then((ok) => {
      if (!ok) throw new Error('速记墙载入失败');
      return archive();
    });
    if (archivePromise) return archivePromise;
    if (!notes.length && !arrows.length) return Promise.resolve({ ok: true, empty: true, count: 0 });
    const payload = notes.map((n) => Object.assign({}, n));
    clearTimeout(saveTimer);
    saveTimer = null;
    archiving = true;
    touched = true;
    archivePromise = saveChain.catch(() => undefined).then(() => fetch('/api/notes-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: payload }),
      }))
      .then((r) => r.json()).then((json) => {
      if (!json || !json.ok) throw new Error((json && json.error) || '归档失败');
      cancelNoteInertia(false);
      notes = [];
      edges = [];
      arrows = [];
      history = []; redoStack = [];                // 归档不可撤销
      expandedStack = null;
      renderEdges();
      const els = Array.from(surface.querySelectorAll('.sticky-note'));
      if (prefersReduced || !els.length) {
        els.forEach((el) => el.remove());
      } else {
        els.forEach((el, i) => {
          el.style.animationDelay = (i * 26) + 'ms';
          el.classList.add('note-leaving');
          setTimeout(() => el.remove(), 300 + i * 26);
        });
      }
      document.dispatchEvent(new CustomEvent('canvas:data-changed', {
        detail: { source: 'notes', path: '/api/notes-archive' },
      }));
      return json;
    }).catch((error) => {
      archiving = false;
      scheduleSave();
      throw error;
    }).finally(() => {
      archiving = false;
      archivePromise = null;
    });
    return archivePromise;
  }

  function deactivate() {
    cancelNoteInertia(true);
    cancelViewPanInertia();
    cancelZoom(true);
    clearViewArrowKeys();
    cancelCollapse();
    cancelExpand();
    closeNoteSearch();
    interacting = false;
    spaceHeld = false;
    surface.classList.remove('space-ready', 'panning');
  }

  window.CanvasNotes = {
    activate() {
      cancelPreload();
      const ready = loaded ? Promise.resolve(true) : load();
      return ready.then((ok) => {
        if (!ok) return false;
        // 隐藏预渲染时 content-visibility 会跳过尺寸计算；页面显现后重算一次端点。
        relayout();
        window.requestAnimationFrame(() => {
          if (notesPageActive()) renderEdges();
        });
        return true;
      });
    },
    deactivate,
    archive,
    count() { return notes.length; },
    setInertia(value) { return setNoteInertia(value, true); },
    getInertia() { return noteInertia; },
    setStackHoverDelay(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return stackHoverDelay;
      stackHoverDelay = Math.max(STACK_HOVER_DELAY_MIN, Math.min(STACK_HOVER_DELAY_MAX, Math.round(n / 20) * 20));
      try { localStorage.setItem(STACK_HOVER_DELAY_KEY, String(stackHoverDelay)); } catch (e) {}
      return stackHoverDelay;
    },
    getStackHoverDelay() { return stackHoverDelay; },
    fitAll: fitAllNotes,
    resetView,
  };

  document.addEventListener('start:viewchange', (event) => {
    if (!event.detail || event.detail.current !== 'notes') deactivate();
  });
  schedulePreload();
})();

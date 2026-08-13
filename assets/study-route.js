(function () {
  'use strict';

  var GoalTree = window.RelatumStudyGoalTree;
  var overlay = document.querySelector('[data-role="study-route-overlay"]');
  if (!GoalTree || !overlay) return;
  var panel = overlay.querySelector('.study-route-panel');
  var viewport = overlay.querySelector('[data-role="study-route-viewport"]');
  var scene = overlay.querySelector('[data-role="study-route-scene"]');
  var nodesHost = overlay.querySelector('[data-role="study-route-nodes"]');
  var edgesHost = overlay.querySelector('[data-role="study-route-edges"]');
  var summary = overlay.querySelector('[data-role="study-route-summary"]');
  var popover = overlay.querySelector('[data-role="study-route-popover"]');
  var confirmBox = overlay.querySelector('[data-role="study-route-confirm"]');
  var rail = overlay.querySelector('[data-role="study-route-rail"]');
  var railList = overlay.querySelector('[data-role="study-route-rail-list"]');
  var railAdd = overlay.querySelector('[data-role="study-route-rail-add"]');
  var stageEl = overlay.querySelector('.study-route-stage');
  var T = function (value) { return window.RelatumI18n ? window.RelatumI18n.t(value) : value; };
  var state = { tasks: [], tree: { version: 1, title: '我的学习路线', nodes: [] }, trees: [], activeTreeId: '' };
  var open = false, busy = false, layout = null, confirmAction = null;
  var routeRequestId = 0, routeCloseTimer = 0;
  // 树命令纪元：切/建/删树时递增。后台 /api/study 快照若取自纪元变化之前
  // （即切树前），落地时必须丢弃，否则会把刚完成的切换静默回退。
  var treeEpoch = 0;
  var popoverCloseTimer = 0, popoverSwapTimer = 0, popoverMotionId = 0;
  var confirmCloseTimer = 0, confirmMotionId = 0;
  var view = { x: 42, y: 42, zoom: 1 };
  var viewTarget = Object.assign({}, view), viewTickAt = 0;
  var pan = null, drag = null, dragEndedAt = 0, pointerDownInPopover = false;
  var nodeElements = new Map(), edgeElements = new Map(), visualPlacements = new Map();
  var layoutFrame = 0, summaryFrame = 0, viewFrame = 0, panInertiaFrame = 0, dragFrame = 0;
  var dropSlot = null, reparentBadge = null, viewSaveTimer = 0;
  var GOAL_TREE_ROUTE_VIEW_KEY = 'relatum.goal-tree-route.view';
  var legacyViewClaimed = false;
  var STUDY_DATA_CACHE_KEY = '_relatumStudyData';
  var studyCache = null, studyPrefetchId = 0;
  var prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
  })();

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }
  function api(url, options) {
    // 超时守卫：请求若永不落定，busy 会卡死整个面板；15s 足够本地服务完成任何操作。
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    options = options || {};
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (json) {
        if (!response.ok) throw new Error(json.error || ('HTTP ' + response.status));
        return json;
      });
    }).finally(function () { clearTimeout(timer); });
  }
  function post(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function findTask(id) { return state.tasks.find(function (task) { return task.id === id; }); }
  function taskProgress(task) {
    var progress = task && task.progress && typeof task.progress === 'object' ? task.progress : {};
    var target = Math.max(0, Number(progress.target) || 0);
    return { current: Math.max(0, Math.min(target, Number(progress.current) || 0)), target: target };
  }
  function applyTreePayloadInitial(json) {
    var trees = Array.isArray(json.goalTrees) ? json.goalTrees : [];
    if (!trees.length && json.goalTree) trees = [json.goalTree];
    state.trees = trees;
    state.activeTreeId = json.activeTreeId || (trees.length ? trees[0].id : '');
    state.tree = json.goalTree || trees[0] || { version: 1, title: '我的学习路线', nodes: [] };
  }
  function applyTreeSnapshot(json, expectedTreeId) {
    // 在途请求守卫：响应快照只属于请求发出时的那棵树，切树后不覆盖当前树。
    if (!expectedTreeId || (json.activeTreeId || '') !== expectedTreeId) return;
    if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
    if (json.goalTree) state.tree = json.goalTree;
  }
  var RAIL_ORB_HTML = '<span class="study-route-rail-orb" data-role="rail-active-orb" aria-hidden="true"></span>';
  var railOrbY = null;
  var railFlipTimer = 0;
  function clearRailTransients() {
    // 上一轮 FLIP 可能仍在途：清掉定时器、高度钉桩与退场幽灵，恢复由内容自撑。
    if (railFlipTimer) { clearTimeout(railFlipTimer); railFlipTimer = 0; }
    rail.classList.remove('rail-flipping');
    rail.style.height = '';
    Array.prototype.forEach.call(rail.querySelectorAll('.rail-ghost'), function (el) { el.remove(); });
    Array.prototype.forEach.call(railList.querySelectorAll('.rail-flip'), function (el) { el.classList.remove('rail-flip'); });
    railAdd.classList.remove('rail-flip');
    // 钉桩与幽灵清掉后滚动范围复原，收拢越界滚动。
    if (railList.scrollTop > railList.scrollHeight - railList.clientHeight) {
      railList.scrollTop = Math.max(0, railList.scrollHeight - railList.clientHeight);
    }
  }
  function railSnapshot() {
    var activeButton = railList.querySelector('.study-route-rail-item.is-active');
    return {
      height: rail.getBoundingClientRect().height,
      scrollTop: railList.scrollTop,
      addY: railAdd.getBoundingClientRect().top,
      activeId: activeButton ? activeButton.dataset.routeTreeId : null,
      buttons: Array.prototype.map.call(railList.querySelectorAll('.study-route-rail-item'), function (btn) {
        var rect = btn.getBoundingClientRect();
        return { element: btn, treeId: btn.dataset.routeTreeId, y: rect.top, offsetTop: btn.offsetTop };
      }),
    };
  }
  function renderRail() {
    if (!railList) return;
    // 先让上轮在途 FLIP 落定再取快照，避免量到飞行中的几何。
    clearRailTransients();
    var snap = railSnapshot();
    var fromY = railOrbY;
    railList.innerHTML = RAIL_ORB_HTML + state.trees.map(function (tree, index) {
      return '<button type="button" class="study-route-rail-item' + (tree.id === state.activeTreeId ? ' is-active' : '')
        + '" data-route-tree-id="' + escapeHtml(tree.id) + '" data-tooltip="' + escapeHtml(tree.title || '')
        + '" aria-label="' + escapeHtml(tree.title || '') + '">' + (index + 1) + '</button>';
    }).join('');
    // 重建后先恢复滚动位置（否则树多时跳回顶部）；只有活动树变化（切换/新建/删除）
    // 才把新活动按钮滚入视野，日常渲染不碰滚动，避免与 FLIP 混叠。
    railList.scrollTop = snap.scrollTop;
    var active = railList.querySelector('.study-route-rail-item.is-active');
    if (active && active.dataset.routeTreeId !== snap.activeId && railList.clientHeight < railList.scrollHeight) {
      var activeTop = active.offsetTop, activeBottom = activeTop + active.offsetHeight;
      if (activeTop < railList.scrollTop) railList.scrollTop = activeTop;
      else if (activeBottom > railList.scrollTop + railList.clientHeight) railList.scrollTop = activeBottom - railList.clientHeight;
    }
    var orb = railList.querySelector('.study-route-rail-orb');
    var toY = active ? active.offsetTop : 0;
    // 滑块 FLIP：先钉在旧位置提交一帧，再过渡到新位置；首渲染 / 减动效直接落位。
    if (fromY != null && fromY !== toY && !prefersReduced) {
      orb.classList.add('no-transition');
      orb.style.transform = 'translate3d(0,' + fromY + 'px,0)';
      void orb.offsetWidth;
      orb.classList.remove('no-transition');
    }
    orb.style.transform = 'translate3d(0,' + toY + 'px,0)';
    railOrbY = toY;
    animateRailChange(snap);
  }
  function animateRailChange(snap) {
    if (prefersReduced) return;
    var live = {};
    Array.prototype.forEach.call(railList.querySelectorAll('.study-route-rail-item'), function (btn) {
      live[btn.dataset.routeTreeId] = btn;
    });
    var oldById = {};
    snap.buttons.forEach(function (b) { oldById[b.treeId] = b; });
    var addedIds = state.trees.map(function (t) { return t.id; }).filter(function (id) { return !oldById[id]; });
    var removed = snap.buttons.filter(function (b) { return !live[b.treeId]; });
    // 滚动调整带来的视口位移与布局变化混叠：list 内元素换算回未滚动坐标再算位移。
    var scrollDelta = railList.scrollTop - snap.scrollTop;
    // 存留按钮与「＋」的位移（容器垂直居中，增删一棵会让全体平移半个槽位）。
    var shifts = [];
    snap.buttons.forEach(function (b) {
      var el = live[b.treeId];
      if (!el) return;
      var dy = b.y - (el.getBoundingClientRect().top + scrollDelta);
      if (Math.abs(dy) > 0.5) shifts.push({ element: el, dy: dy });
    });
    var addDy = snap.addY - railAdd.getBoundingClientRect().top;
    var newHeight = rail.getBoundingClientRect().height;
    if (!addedIds.length && !removed.length && !shifts.length
      && Math.abs(addDy) < 0.5 && Math.abs(newHeight - snap.height) < 0.5) return;
    // ---- invert：把新 DOM 全部钉回旧外观（无过渡），删除的按钮转幽灵留在原地 ----
    shifts.forEach(function (s) { s.element.style.transform = 'translate3d(0,' + s.dy + 'px,0)'; });
    if (Math.abs(addDy) >= 0.5) railAdd.style.transform = 'translate3d(0,' + addDy + 'px,0)';
    addedIds.forEach(function (id) {
      var el = live[id];
      if (!el) return;
      // 新树按钮从「＋」的位置长出（translate + scale + fade）。
      el.style.transform = 'translate3d(0,' + (snap.addY - (el.getBoundingClientRect().top + scrollDelta)) + 'px,0) scale(0.3)';
      el.style.opacity = '0';
    });
    // 幽灵放在 nav 内（list 的 overflow 会裁掉超出新内容的尾部按钮）；
    // 高度过渡时 nav 会重定中，用同节奏的 drift 抵消，视觉上原地淡出。
    var ghostDrift = (newHeight - snap.height) / 2;
    removed.forEach(function (b) {
      var ghost = b.element;
      ghost.classList.add('rail-ghost');
      ghost.style.top = (b.y - rail.getBoundingClientRect().top) + 'px';
      if (Math.abs(ghostDrift) >= 0.5) ghost.style.transform = 'translate3d(0,' + ghostDrift + 'px,0)';
      rail.appendChild(ghost);
    });
    rail.style.height = snap.height + 'px';
    rail.classList.add('rail-flipping');
    void rail.offsetHeight; // 提交 invert 首帧
    // ---- play：容器高度与各元素位移用同一套节奏过渡到新布局 ----
    shifts.forEach(function (s) { s.element.classList.add('rail-flip'); s.element.style.transform = ''; });
    if (Math.abs(addDy) >= 0.5) { railAdd.classList.add('rail-flip'); railAdd.style.transform = ''; }
    addedIds.forEach(function (id) {
      var el = live[id];
      if (!el) return;
      el.classList.add('rail-flip');
      el.style.transform = '';
      el.style.opacity = '';
    });
    removed.forEach(function (b) { b.element.style.transform = ''; b.element.classList.add('rail-ghost-out'); });
    rail.style.height = newHeight + 'px';
    railFlipTimer = setTimeout(clearRailTransients, 320);
  }
  var railRevealPx = 84, railOver = false, railVisible = false;
  function setRailVisible(visible) {
    visible = !!visible;
    if (railVisible === visible || !rail) return;
    railVisible = visible;
    rail.classList.toggle('revealed', visible);
  }
  function applyView() {
    scene.style.transform = 'translate3d(' + view.x + 'px,' + view.y + 'px,0) scale(' + view.zoom + ')';
  }
  function viewKeyFor(treeId) {
    return GOAL_TREE_ROUTE_VIEW_KEY + '.' + (treeId || 'default');
  }
  function flushViewSave() {
    if (viewSaveTimer) { clearTimeout(viewSaveTimer); viewSaveTimer = 0; }
    try {
      localStorage.setItem(viewKeyFor(state.activeTreeId), JSON.stringify({
        x: Math.round(view.x * 10) / 10,
        y: Math.round(view.y * 10) / 10,
        zoom: Math.round(view.zoom * 1000) / 1000,
      }));
    } catch (e) {}
  }
  function saveViewSoon() {
    clearTimeout(viewSaveTimer);
    // 在调度时刻钉住树 id 与镜头快照：防抖定时器触发时若已切树，也不能把旧镜头写进新树的 key。
    var treeId = state.activeTreeId;
    var snapshot = { x: view.x, y: view.y, zoom: view.zoom };
    viewSaveTimer = setTimeout(function () {
      viewSaveTimer = 0;
      try {
        localStorage.setItem(viewKeyFor(treeId), JSON.stringify({
          x: Math.round(snapshot.x * 10) / 10,
          y: Math.round(snapshot.y * 10) / 10,
          zoom: Math.round(snapshot.zoom * 1000) / 1000,
        }));
      } catch (e) {}
    }, 220);
  }
  function restoreView(treeId) {
    // 恢复的镜头是权威值：停掉上一棵树的惯性/缓动帧，防止它们继续改写 view 并把它存进新树的 key。
    stopPanInertia();
    stopViewAnimation();
    try {
      var raw = JSON.parse(localStorage.getItem(viewKeyFor(treeId)) || 'null');
      if (!raw && !legacyViewClaimed && state.trees[0] && state.trees[0].id === treeId) {
        raw = JSON.parse(localStorage.getItem(GOAL_TREE_ROUTE_VIEW_KEY) || 'null');
        if (raw) legacyViewClaimed = true;
      }
      if (!raw || typeof raw !== 'object') return false;
      var x = Number(raw.x), y = Number(raw.y), zoom = Number(raw.zoom);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return false;
      zoom = Math.max(.38, Math.min(1.6, zoom));
      view = { x: x, y: y, zoom: zoom };
      viewTarget = Object.assign({}, view);
      applyView();
      return true;
    } catch (e) { return false; }
  }
  function stopViewAnimation() {
    if (viewFrame) cancelAnimationFrame(viewFrame);
    viewFrame = 0;
    viewTickAt = 0;
  }
  function stopPanInertia() {
    if (panInertiaFrame) cancelAnimationFrame(panInertiaFrame);
    panInertiaFrame = 0;
  }
  function startPanInertia(source) {
    stopPanInertia();
    if (prefersReduced || !open || !source || source.velX == null) return;
    var now = performance.now();
    if (source.lastMoveT == null || now - source.lastMoveT > 60) return;
    var vx = source.velX * .15, vy = source.velY * .15;
    var speed = Math.hypot(vx, vy);
    if (speed < .06) return;
    var maxSpeed = 5;
    if (speed > maxSpeed) {
      var ratio = maxSpeed / speed;
      vx *= ratio; vy *= ratio;
    }
    stopViewAnimation();
    var last = now;
    function step(timestamp) {
      panInertiaFrame = 0;
      if (!open || pan) return;
      var dt = timestamp - last;
      last = timestamp;
      if (!(dt > 0)) dt = 16.667;
      if (dt > 40) dt = 40;
      view.x += vx * dt;
      view.y += vy * dt;
      viewTarget = Object.assign({}, view);
      applyView();
      var friction = Math.exp(-.0045 * dt);
      vx *= friction; vy *= friction;
      if (Math.hypot(vx, vy) > .015) panInertiaFrame = requestAnimationFrame(step);
      else saveViewSoon();
    }
    panInertiaFrame = requestAnimationFrame(step);
  }
  function requestViewAnimation() {
    if (prefersReduced) {
      view = Object.assign({}, viewTarget);
      applyView();
      return;
    }
    if (!viewFrame) viewFrame = requestAnimationFrame(tickView);
  }
  function tickView(timestamp) {
    viewFrame = 0;
    if (!open) return;
    var dt = viewTickAt ? Math.min(34, timestamp - viewTickAt) : 16.667;
    viewTickAt = timestamp;
    var factor = 1 - Math.pow(1 - .155, dt / 16.667);
    var dx = viewTarget.x - view.x, dy = viewTarget.y - view.y, dz = viewTarget.zoom - view.zoom;
    if (Math.abs(dx) < .25 && Math.abs(dy) < .25 && Math.abs(dz) < .0007) {
      view = Object.assign({}, viewTarget);
      viewTickAt = 0;
      applyView();
      return;
    }
    view.x += dx * factor;
    view.y += dy * factor;
    view.zoom += dz * factor;
    applyView();
    viewFrame = requestAnimationFrame(tickView);
  }
  function setViewTarget(next, immediate) {
    stopPanInertia();
    viewTarget = {
      x: Number(next.x) || 0,
      y: Number(next.y) || 0,
      zoom: Math.max(.38, Math.min(1.6, Number(next.zoom) || 1)),
    };
    if (immediate || prefersReduced) {
      stopViewAnimation();
      view = Object.assign({}, viewTarget);
      applyView();
    } else requestViewAnimation();
    saveViewSoon();
  }
  function fit(immediate) {
    if (!layout) return;
    var rect = viewport.getBoundingClientRect(), bounds = layout.bounds;
    if (!rect.width || !rect.height || !bounds.width || !bounds.height) return;
    var zoom = Math.max(.42, Math.min(1.08, Math.min((rect.width - 92) / bounds.width, (rect.height - 92) / bounds.height)));
    setViewTarget({
      zoom: zoom,
      x: (rect.width - bounds.width * zoom) / 2 - (Number(bounds.x) || 0) * zoom,
      y: (rect.height - bounds.height * zoom) / 2 - (Number(bounds.y) || 0) * zoom,
    }, immediate === true);
  }
  function setZoom(next, anchorX, anchorY) {
    var rect = viewport.getBoundingClientRect(), old = viewTarget.zoom;
    var zoom = Math.max(.38, Math.min(1.6, next));
    var ax = Number.isFinite(anchorX) ? anchorX - rect.left : rect.width / 2;
    var ay = Number.isFinite(anchorY) ? anchorY - rect.top : rect.height / 2;
    setViewTarget({
      x: ax - (ax - viewTarget.x) * (zoom / old),
      y: ay - (ay - viewTarget.y) * (zoom / old),
      zoom: zoom,
    });
  }
  function edgePath(from, to) {
    var reverse = to.x + to.width / 2 < from.x + from.width / 2;
    var x1 = reverse ? from.x : from.x + from.width, y1 = from.y;
    var x2 = reverse ? to.x + to.width : to.x, y2 = to.y;
    var middle = x1 + (x2 - x1) * .48;
    return 'M' + x1 + ',' + y1 + ' C' + middle + ',' + y1 + ' ' + middle + ',' + y2 + ' ' + x2 + ',' + y2;
  }
  function branchMarkup(placement) {
    var metrics = placement.metrics || { count: 0, progress: 0 };
    var percent = Math.round(metrics.progress * 100);
    return '<div class="study-route-branch-main"><strong data-user-content>' + escapeHtml(placement.node.title)
      + '</strong><span data-role="route-node-meta">' + percent + '% · ' + metrics.count + ' ' + T('项任务') + '</span>'
      + '<i aria-hidden="true"><b data-route-progress-fill data-progress-target="' + percent + '" style="width:' + percent + '%"></b></i></div>'
      + '<span class="study-route-node-actions"><button type="button" data-route-action="add" aria-label="'
      + T('添加') + '">＋</button><button type="button" data-route-action="menu" aria-label="'
      + T('更多') + '">⋯</button></span>';
  }
  var BRANCH_COLORS = [
    { value: '', label: '默认' },
    { value: '#fce2cc', label: '杏橙' },
    { value: '#e2ece4', label: '薄荷' },
    { value: '#e8ecf2', label: '天空' },
    { value: '#f0dee4', label: '蔷薇' },
    { value: '#ece2ee', label: '丁香' },
    { value: '#f3ecd8', label: '暖金' },
    { value: '#f2d9d6', label: '赤霞' },
  ];
  function colorPaletteHTML(currentColor) {
    currentColor = String(currentColor || '').trim();
    var swatches = BRANCH_COLORS.map(function (item) {
      var isActive = item.value === currentColor || (!item.value && !currentColor);
      var style = item.value ? ' style="background:' + item.value + '"' : '';
      return '<button type="button" data-route-pop="set-color" data-color="' + escapeHtml(item.value)
        + '" class="study-route-color-swatch' + (isActive ? ' is-active' : '') + '"'
        + ' aria-label="' + escapeHtml(item.label) + '"' + style + '></button>';
    }).join('');
    return '<div class="study-route-color-palette">' + swatches + '</div>';
  }
  function taskMarkup(placement) {
    var task = findTask(placement.node.taskId) || { title: T('已移除任务'), status: 'done', progress: {} };
    var progress = taskProgress(task), done = task.status === 'done';
    var ready = !done && progress.target > 0 && progress.current >= progress.target;
    var controls = progress.target && !done
      ? '<span class="study-route-task-steps"><button type="button" data-route-action="progress" data-delta="-1" aria-label="进度减一"'
        + (progress.current <= 0 ? ' disabled' : '') + '>−</button><button type="button" data-route-action="progress" data-delta="1" aria-label="进度加一"'
        + (progress.current >= progress.target ? ' disabled' : '') + '>＋</button></span>' : '';
    var value = progress.target ? progress.current + ' / ' + progress.target : T('设置进度');
    var width = progress.target ? Math.round(progress.current / progress.target * 100) : 0;
    return '<button type="button" class="study-route-task-check' + (done ? ' is-done' : '') + (ready ? ' is-ready' : '')
      + '" data-route-action="complete" aria-label="' + (done ? T('恢复为未完成') : T('标记完成')) + '"><span>✓</span></button>'
      + '<div class="study-route-task-main"><strong data-user-content>' + escapeHtml(task.title || T('未命名任务'))
      + '</strong><button type="button" class="study-route-task-value" data-route-action="settings">' + escapeHtml(value) + '</button>'
      + (progress.target ? '<i aria-hidden="true"><b data-route-progress-fill data-progress-target="' + width + '" style="width:' + width + '%"></b></i>' : '') + '</div>'
      + controls + '<button type="button" class="study-route-node-menu" data-route-action="menu" aria-label="' + T('更多') + '">⋯</button>';
  }
  function milestoneMarkup(placement) {
    var milestone = placement.node.milestone || {};
    return '<span class="study-route-milestone-dot" aria-hidden="true"></span><div><strong data-user-content>'
      + escapeHtml(milestone.name || T('任务点')) + '</strong><span>' + escapeHtml(T('第') + ' ' + milestone.at + ' ' + T('点'))
      + (milestone.reached ? ' · ' + escapeHtml(T('已到达')) : '') + '</span></div>';
  }
  function nodeMarkup(placement) {
    if (placement.kind === 'task') return taskMarkup(placement);
    if (placement.kind === 'milestone') return milestoneMarkup(placement);
    return branchMarkup(placement);
  }
  function placementMap(items) {
    return new Map((items || []).map(function (item) { return [item.id, Object.assign({}, item)]; }));
  }
  function syncEdgeElements(next) {
    var wanted = new Set(next.edges.map(function (edge) { return edge.from + '>' + edge.to; }));
    edgeElements.forEach(function (path, id) {
      if (wanted.has(id)) return;
      path.remove(); edgeElements.delete(id);
    });
    next.edges.forEach(function (edge) {
      var id = edge.from + '>' + edge.to, path = edgeElements.get(id);
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'study-route-edge is-entering');
        path.dataset.edgeId = id;
        path.dataset.from = edge.from; path.dataset.to = edge.to;
        edgesHost.appendChild(path); edgeElements.set(id, path);
        requestAnimationFrame(function () { if (path.isConnected) path.classList.remove('is-entering'); });
      }
    });
  }
  function applyLayoutFrame(next, placements) {
    visualPlacements = placementMap(Array.from(placements.values()));
    placements.forEach(function (placement, id) {
      var element = nodeElements.get(id);
      if (!element) return;
      element.style.left = placement.x + 'px';
      element.style.top = (placement.y - placement.height / 2) + 'px';
    });
    next.edges.forEach(function (edge) {
      var path = edgeElements.get(edge.from + '>' + edge.to);
      var from = placements.get(edge.from), to = placements.get(edge.to);
      if (path && from && to) path.setAttribute('d', edgePath(from, to));
    });
  }
  function animateLayout(previous, next, duration, excluded) {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = 0;
    var toMap = placementMap(next.nodes);
    var fromMap = visualPlacements.size ? placementMap(Array.from(visualPlacements.values()))
      : placementMap(previous && previous.nodes);
    next.nodes.forEach(function (item) {
      if (fromMap.has(item.id)) return;
      var edge = next.edges.find(function (candidate) { return candidate.to === item.id; });
      var parent = edge && (fromMap.get(edge.from) || toMap.get(edge.from));
      fromMap.set(item.id, parent ? Object.assign({}, item, { x: parent.x, y: parent.y }) : item);
    });
    if (prefersReduced || !previous || !duration) { applyLayoutFrame(next, toMap); return; }
    var started = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - started) / duration), eased = 1 - Math.pow(1 - t, 3), live = new Map();
      toMap.forEach(function (to, id) {
        if (excluded && excluded.has(id) && visualPlacements.has(id)) {
          live.set(id, Object.assign({}, visualPlacements.get(id))); return;
        }
        var from = fromMap.get(id) || to;
        live.set(id, Object.assign({}, to, {
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
        }));
      });
      applyLayoutFrame(next, live);
      if (t < 1) layoutFrame = requestAnimationFrame(frame);
      else layoutFrame = 0;
    }
    layoutFrame = requestAnimationFrame(frame);
  }
  function settleNodeFills(elements, fromZero) {
    elements.forEach(function (element) {
      element.querySelectorAll('[data-route-progress-fill]').forEach(function (fill) {
        var target = Number(fill.dataset.progressTarget || 0);
        if (fromZero && !prefersReduced) fill.style.width = '0%';
        requestAnimationFrame(function () { if (fill.isConnected) fill.style.width = target + '%'; });
      });
    });
  }
  function syncNodeElements(seed, options) {
    options = options || {};
    var wanted = new Set(seed.nodes.map(function (item) { return item.id; })), created = [];
    nodeElements.forEach(function (element, id) {
      if (wanted.has(id)) return;
      element.remove(); nodeElements.delete(id);
    });
    seed.nodes.forEach(function (placement) {
      var element = nodeElements.get(placement.id), isNew = !element;
      if (!element) {
        element = document.createElement('article');
        element.setAttribute('role', 'treeitem'); element.tabIndex = 0;
        nodesHost.appendChild(element); nodeElements.set(placement.id, element); created.push(element);
      }
      element.className = 'study-route-node is-' + placement.kind
        + ((placement.metrics || {}).complete && placement.kind !== 'root' ? ' is-complete' : '')
        + (placement.availability && !placement.availability.available ? ' is-blocked' : '')
        + (isNew && !prefersReduced && !((placement.metrics || {}).complete && placement.kind !== 'root') ? ' is-entering' : '');
      element.dataset.nodeId = placement.id; element.dataset.kind = placement.kind;
      if (placement.kind === 'task') element.dataset.taskId = placement.node.taskId;
      else delete element.dataset.taskId;
      if (placement.kind === 'milestone') {
        element.dataset.milestoneId = placement.node.milestone.id;
        element.dataset.parentTaskNodeId = placement.node.parentNodeId;
        element.tabIndex = -1;
      } else {
        delete element.dataset.milestoneId;
        delete element.dataset.parentTaskNodeId;
        element.tabIndex = 0;
      }
      element.innerHTML = nodeMarkup(placement);
      if (placement.kind === 'branch' && placement.node && placement.node.color) {
        element.style.setProperty('--branch-color', placement.node.color);
        element.dataset.branchColor = placement.node.color;
      } else if (placement.kind === 'branch') {
        element.style.removeProperty('--branch-color');
        delete element.dataset.branchColor;
      }
      element.dataset.progress = String(Math.round(((placement.metrics || {}).progress || 0) * 100));
      if (isNew) window.setTimeout(function () { if (element.isConnected) element.classList.remove('is-entering'); }, prefersReduced ? 0 : 420);
    });
    settleNodeFills(created, true);
    return new Set(created);
  }
  function preserveViewAnchor(previous, next, anchorId) {
    var before = visualPlacements.get(anchorId)
      || (previous && previous.nodes.find(function (item) { return item.id === anchorId; }));
    var after = next.nodes.find(function (item) { return item.id === anchorId; });
    if (!before || !after) return;
    var dx = after.x - before.x, dy = after.y - before.y;
    if (Math.abs(dx) < .01 && Math.abs(dy) < .01) return;
    visualPlacements = new Map(Array.from(visualPlacements.entries()).map(function (entry) {
      return [entry[0], Object.assign({}, entry[1], { x: entry[1].x + dx, y: entry[1].y + dy })];
    }));
    applyLayoutFrame(next, visualPlacements);
    view.x -= dx * view.zoom;
    view.y -= dy * view.zoom;
    viewTarget.x -= dx * viewTarget.zoom;
    viewTarget.y -= dy * viewTarget.zoom;
    applyView();
  }
  function render(options) {
    options = options || {};
    state.tree = GoalTree.normalizeTree(state.tree, state.tasks);
    var previous = layout;
    var first = GoalTree.layout(state.tree, state.tasks);
    var createdElements = syncNodeElements(first, options);
    var sizes = new Map();
    nodeElements.forEach(function (element, id) { sizes.set(id, { width: element.offsetWidth, height: element.offsetHeight }); });
    var next = GoalTree.layout(state.tree, state.tasks, { sizes: sizes });
    layout = next;
    scene.style.width = next.bounds.width + 'px'; scene.style.height = next.bounds.height + 'px';
    edgesHost.setAttribute('viewBox', '0 0 ' + next.bounds.width + ' ' + next.bounds.height);
    syncEdgeElements(next);
    if (options.preserveViewAnchor) preserveViewAnchor(previous, next, options.preserveViewAnchor);
    syncSummary(next.model.rootMetrics, !!previous);
    animateLayout(previous, next, Number(options.duration) || 320);
    settleNodeFills(Array.from(nodeElements.values()).filter(function (element) { return !createdElements.has(element); }), false);
    applyView();
  }
  function syncSummary(metrics, animate) {
    metrics = metrics || { count: 0, progress: 0 };
    var percent = Math.round(metrics.progress * 100);
    var completed = state.tree.nodes.filter(function (node) {
      var task = node.kind === 'task' && findTask(node.taskId);
      return task && task.status === 'done';
    }).length;
    var number = summary.querySelector('strong'), copy = summary.querySelector('span');
    if (!number) { number = document.createElement('strong'); summary.appendChild(number); }
    if (!copy) { copy = document.createElement('span'); summary.appendChild(copy); }
    copy.textContent = completed + ' / ' + metrics.count + ' ' + T('项任务');
    var from = Number(number.dataset.value);
    if (!Number.isFinite(from)) from = Number((number.textContent || '').replace('%', '')) || percent;
    if (summaryFrame) cancelAnimationFrame(summaryFrame);
    summaryFrame = 0;
    if (!animate || prefersReduced || Math.abs(percent - from) < .1) {
      number.textContent = percent + '%'; number.dataset.value = String(percent); return;
    }
    var started = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - started) / 560), eased = 1 - Math.pow(1 - t, 3);
      var value = from + (percent - from) * eased;
      number.textContent = Math.round(value) + '%'; number.dataset.value = String(value);
      if (t < 1) summaryFrame = requestAnimationFrame(frame);
      else { summaryFrame = 0; number.dataset.value = String(percent); }
    }
    summaryFrame = requestAnimationFrame(frame);
  }
  function setFill(fill, percent, from) {
    if (!fill) return;
    fill.dataset.progressTarget = String(percent);
    if (Number.isFinite(from) && !prefersReduced) {
      fill.style.width = from + '%'; void fill.offsetWidth;
      requestAnimationFrame(function () { if (fill.isConnected) fill.style.width = percent + '%'; });
    } else fill.style.width = percent + '%';
  }
  function syncTaskElement(element, placement) {
    var task = findTask(placement.node.taskId), progress = taskProgress(task), done = task && task.status === 'done';
    var oldFill = element.querySelector('[data-route-progress-fill]');
    var oldPercent = oldFill ? Number(oldFill.dataset.progressTarget || 0) : 0;
    var hasSteps = !!element.querySelector('.study-route-task-steps');
    var mustRebuild = (!!progress.target !== !!oldFill) || (!!progress.target && !done !== hasSteps);
    if (mustRebuild) {
      element.innerHTML = taskMarkup(placement);
      setFill(element.querySelector('[data-route-progress-fill]'), progress.target ? progress.current / progress.target * 100 : 0, oldPercent);
      return;
    }
    var check = element.querySelector('.study-route-task-check');
    var ready = !done && progress.target > 0 && progress.current >= progress.target;
    if (check) {
      check.classList.toggle('is-done', !!done); check.classList.toggle('is-ready', !!ready);
      check.setAttribute('aria-label', done ? T('恢复为未完成') : T('标记完成'));
    }
    var value = element.querySelector('.study-route-task-value');
    if (value) value.textContent = progress.target ? progress.current + ' / ' + progress.target : T('设置进度');
    setFill(oldFill, progress.target ? progress.current / progress.target * 100 : 0);
    element.querySelectorAll('[data-route-action="progress"]').forEach(function (button) {
      var delta = Number(button.dataset.delta || 0);
      button.disabled = delta < 0 ? progress.current <= 0 : progress.current >= progress.target;
    });
  }
  function syncProgress(taskId) {
    var model = GoalTree.buildModel(state.tree, state.tasks);
    var owner = GoalTree.taskOwner(state.tree, taskId);
    if (!owner || !layout) return;
    layout.model = model;
    var ids = [owner.node.id], cursor = owner.node.parentId;
    while (cursor) { ids.push(cursor); cursor = (model.byId.get(cursor) || {}).parentId; }
    ids.push('root');
    ids.forEach(function (id) {
      var element = nodeElements.get(id);
      var placement = layout.nodes.find(function (item) { return item.id === id; });
      if (!element || !placement) return;
      placement.metrics = model.metrics.get(id === 'root' ? 'root' : id);
      var percent = Math.round(((placement.metrics || {}).progress || 0) * 100);
      element.dataset.progress = String(percent);
      element.classList.toggle('is-complete', placement.kind !== 'root' && !!(placement.metrics && placement.metrics.complete));
      if (placement.kind === 'task') syncTaskElement(element, placement);
      else {
        var meta = element.querySelector('[data-role="route-node-meta"]');
        if (meta) meta.textContent = percent + '% · ' + (placement.metrics || {}).count + ' ' + T('项任务');
        setFill(element.querySelector('[data-route-progress-fill]'), percent);
      }
    });
    layout.nodes.forEach(function (placement) {
      if (placement.kind === 'milestone' && placement.node.taskId === taskId) {
        var liveMilestone = GoalTree.milestonesForTask(findTask(taskId)).find(function (item) {
          return item.id === placement.node.milestone.id;
        });
        if (!liveMilestone) return;
        var source = findTask(taskId), reached = source.status === 'done'
          || Number((source.progress || {}).current || 0) >= liveMilestone.at;
        placement.node.milestone = Object.assign({}, liveMilestone, { reached: reached });
        placement.metrics = { count: 0, progress: reached ? 1 : 0, complete: reached };
        var milestoneElement = nodeElements.get(placement.id);
        if (milestoneElement) {
          milestoneElement.classList.toggle('is-complete', reached);
          var milestoneMeta = milestoneElement.querySelector('div > span');
          if (milestoneMeta) milestoneMeta.textContent = T('第') + ' ' + liveMilestone.at + ' ' + T('点')
            + (reached ? ' · ' + T('已到达') : '');
        }
      }
      if (placement.kind !== 'milestone') {
        placement.availability = model.availability.get(placement.id) || { available: true, reason: '' };
        var routeElement = nodeElements.get(placement.id);
        if (routeElement) routeElement.classList.toggle('is-blocked', !placement.availability.available);
      }
    });
    syncSummary(model.rootMetrics, true);
  }
  function closePopover(restoreFocus, immediate) {
    var anchorId = popover.dataset.anchorId;
    if (popover.hidden) return;
    var motionId = ++popoverMotionId;
    if (popoverCloseTimer) clearTimeout(popoverCloseTimer);
    if (popoverSwapTimer) clearTimeout(popoverSwapTimer);
    popoverCloseTimer = 0;
    popoverSwapTimer = 0;
    popover.classList.remove('is-visible', 'is-swapping');
    popover.classList.add('is-closing');
    popover.setAttribute('aria-hidden', 'true');
    var finish = function () {
      if (motionId !== popoverMotionId) return;
      popover.hidden = true;
      popover.innerHTML = '';
      popover.classList.remove('is-closing');
      popover.removeAttribute('data-anchor-id');
      popoverCloseTimer = 0;
      if (restoreFocus && anchorId) {
        var anchor = nodesHost.querySelector('[data-node-id="' + CSS.escape(anchorId) + '"]');
        if (anchor) anchor.focus();
      }
    };
    if (immediate || prefersReduced) finish();
    else popoverCloseTimer = window.setTimeout(finish, 180);
  }
  function positionPopover(anchor) {
    var stageRect = overlay.querySelector('.study-route-stage').getBoundingClientRect();
    var anchorRect = anchor.getBoundingClientRect();
    var box = popover.getBoundingClientRect();
    var left = anchorRect.right - stageRect.left + 10;
    var top = anchorRect.top - stageRect.top;
    if (left + box.width > stageRect.width - 12) left = anchorRect.left - stageRect.left - box.width - 10;
    if (top + box.height > stageRect.height - 12) top = stageRect.height - box.height - 12;
    popover.style.left = Math.max(12, left) + 'px';
    popover.style.top = Math.max(12, top) + 'px';
  }
  function openPopover(anchor, html) {
    var wasHidden = popover.hidden;
    ++popoverMotionId;
    if (popoverCloseTimer) clearTimeout(popoverCloseTimer);
    if (popoverSwapTimer) clearTimeout(popoverSwapTimer);
    popoverCloseTimer = 0;
    popoverSwapTimer = 0;
    popover.classList.remove('is-closing', 'is-swapping');
    popover.innerHTML = html;
    popover.dataset.anchorId = anchor.dataset.nodeId || '';
    popover.hidden = false;
    popover.setAttribute('aria-hidden', 'false');
    positionPopover(anchor);
    if (wasHidden) {
      void popover.offsetWidth;
      requestAnimationFrame(function () {
        if (!popover.hidden) popover.classList.add('is-visible');
      });
    } else {
      popover.classList.add('is-visible', 'is-swapping');
      popoverSwapTimer = window.setTimeout(function () {
        popover.classList.remove('is-swapping');
        popoverSwapTimer = 0;
      }, prefersReduced ? 0 : 190);
    }
    requestAnimationFrame(function () {
      var focus = popover.querySelector('input,select,button');
      if (focus) focus.focus();
    });
  }
  function addMenu(anchor) {
    var anchorId = anchor.dataset.nodeId || '';
    if (!popover.hidden && popover.dataset.anchorId === anchorId) { closePopover(true); return; }
    openPopover(anchor, '<div class="study-route-menu"><button type="button" data-route-pop="new-branch">'
      + T('新建分支') + '</button><button type="button" data-route-pop="new-task">' + T('新建任务')
      + '</button><button type="button" data-route-pop="attach-task">' + T('选择已有任务') + '</button></div>');
  }
  function nodeMenu(anchor) {
    var anchorId = anchor.dataset.nodeId || '';
    if (!popover.hidden && popover.dataset.anchorId === anchorId) { closePopover(true); return; }
    var kind = anchor.dataset.kind;
    var html = '<div class="study-route-menu"><button type="button" data-route-pop="rename">' + T('改名') + '</button>';
    if (kind === 'task') html += '<button type="button" data-route-pop="new-task">' + T('新建后续任务')
      + '</button><button type="button" data-route-pop="attach-task">' + T('接入已有任务')
      + '</button><button type="button" data-route-pop="settings">' + T('设置进度')
      + '</button><button type="button" class="is-danger" data-route-pop="detach">' + T('移出路线') + '</button>';
    else if (kind === 'branch') html += '<button type="button" class="is-danger" data-route-pop="delete-branch">' + T('删除分支') + '</button>';
    else if (kind === 'root' && state.tree.id !== 'goal_legacy') html += '<button type="button" class="is-danger" data-route-pop="delete-tree">' + T('删除目标树') + '</button>';
    html += '</div>';
    openPopover(anchor, html);
  }
  function formPopover(anchor, kind) {
    var nodeId = anchor.dataset.nodeId;
    var node = nodeId === 'root' ? { title: state.tree.title, kind: 'root' }
      : state.tree.nodes.find(function (item) { return item.id === nodeId; });
    var task = node && node.kind === 'task' ? findTask(node.taskId) : null;
    if (kind === 'new-branch') {
      return openPopover(anchor, '<form data-route-form="new-branch"><label>' + T('分支名称')
        + '<input name="title" maxlength="160" required autofocus></label><button type="submit">' + T('添加分支') + '</button></form>');
    }
    if (kind === 'new-task') {
      return openPopover(anchor, '<form data-route-form="new-task"><label>' + T('任务名称')
        + '<input name="title" maxlength="160" required autofocus></label><label>' + T('目标总量')
        + '<input name="target" type="number" min="0" max="9999" inputmode="numeric" placeholder="可选"></label><button type="submit">'
        + T('创建任务') + '</button></form>');
    }
    if (kind === 'attach-task') {
      var owned = new Set(state.tree.nodes.filter(function (item) { return item.kind === 'task'; }).map(function (item) { return item.taskId; }));
      var options = state.tasks.filter(function (item) { return !owned.has(item.id); }).map(function (item) {
        return '<option value="' + escapeHtml(item.id) + '" data-user-content>' + escapeHtml(item.title) + '</option>';
      }).join('');
      return openPopover(anchor, options ? '<form data-route-form="attach-task"><label>' + T('选择已有任务')
        + '<select name="taskId">' + options + '</select></label><button type="submit">' + T('加入路线') + '</button></form>'
        : '<p class="study-route-popover-empty">' + T('没有可加入的学习任务') + '</p>');
    }
    if (kind === 'rename') {
      var title = task ? task.title : node && node.title;
      return openPopover(anchor, '<form data-route-form="rename"><label>' + T('名称') + '<input name="title" maxlength="160" required value="'
        + escapeHtml(title || '') + '"></label><button type="submit">' + T('保存') + '</button></form>');
    }
    if (kind === 'settings' && task) {
      var progress = taskProgress(task);
      var milestones = GoalTree.milestonesForTask(task);
      return openPopover(anchor, '<form data-route-form="settings"><div class="study-route-progress-fields"><label>' + T('当前进度')
        + '<input name="current" type="number" min="0" max="9999" value="' + progress.current + '"></label><label>' + T('目标总量')
        + '<input name="target" type="number" min="0" max="9999" value="' + (progress.target || '') + '"></label></div>'
        + (milestones.length ? '<p class="study-route-milestone-summary">' + T('任务点') + ' · '
          + milestones.map(function (item) { return escapeHtml(item.name + ' ' + item.at); }).join(' · ') + '</p>' : '')
        + '<p data-role="route-form-error"></p><button type="submit">'
        + T('保存') + '</button></form>');
    }
  }
  function command(body, options) {
    options = options || {};
    if (busy) return Promise.reject(new Error(T('请稍候')));
    busy = true;
    var sent = Object.assign({}, body);
    if (!['create-tree', 'switch-tree', 'delete-tree'].includes(sent.command) && !sent.treeId) {
      sent.treeId = state.activeTreeId;
    }
    var treeAtRequest = state.activeTreeId;
    var shouldFit = ['create-branch', 'create-task', 'attach-task'].includes(sent.command);
    var requestId = routeRequestId;
    var server = post('/api/study-goal-tree-command', sent);
    // 服务端往返注册进学习页 flush 队列：关面板后立即回收/恢复/归档时，
    // 全量快照会等本命令落地，不会把刚删/刚切的树写回主页状态。
    if (window.StudyTreeCommands) window.StudyTreeCommands.register(server);
    return server.then(function (json) {
      // 响应落地前面板已关闭或重开（代际变化）：不再碰状态与 DOM，
      // 避免旧响应向隐藏 overlay 重建整棵树、或覆盖重开后新树的渲染；下次打开会全量拉取。
      if (requestId !== routeRequestId) return json;
      // 树级命令成功落地才推进纪元，此后在途的旧 /api/study 快照全部失效。
      if (sent.command === 'switch-tree' || sent.command === 'create-tree' || sent.command === 'delete-tree') {
        treeEpoch++;
      }
      if (json.task) state.tasks.push(json.task);
      if (sent.command === 'switch-tree') {
        state.activeTreeId = json.treeId || '';
        if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        if (json.goalTree) state.tree = json.goalTree;
      } else if (sent.command === 'create-tree') {
        state.activeTreeId = json.treeId || '';
        if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        else if (json.goalTree) state.trees = state.trees.concat([json.goalTree]);
        if (json.goalTree) state.tree = json.goalTree;
      } else if (sent.command === 'delete-tree') {
        state.activeTreeId = json.treeId || '';
        if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        else state.trees = state.trees.filter(function (item) { return item.id !== json.removedTreeId; });
        if (json.goalTree) state.tree = json.goalTree;
      } else {
        applyTreeSnapshot(json, treeAtRequest);
      }
      closePopover(false);
      if (!options.skipRender) { render({ duration: options.duration || 320 }); renderRail(); }
      if (shouldFit && !options.skipRender) requestAnimationFrame(fit);
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
      return json;
    }).finally(function () { busy = false; });
  }
  function ignoreBusy(error) {
    if (error && error.message === T('请稍候')) return;
    showError(error);
  }
  // 树级操作（切树/建树/删树）的画布过渡：点击瞬间场景快速淡出，
  // 新画布落定后与节点 FLIP / 根卡入场同步淡入，形成"滑块一滑、画面形变"的整体感。
  function beginTreeTransition() {
    if (prefersReduced) return;
    scene.classList.add('is-fading');
  }
  function endTreeTransition() {
    scene.classList.remove('is-fading');
  }
  // 新树根卡入场：根卡节点 id 恒为 'root'，跨树复用同一元素，
  // 同步器不会给它打 is-entering，这里在树级命令落定后手动重触发一次。
  var rootEnterTimer = 0;
  function animateRootEntrance() {
    if (prefersReduced) return;
    if (rootEnterTimer) { clearTimeout(rootEnterTimer); rootEnterTimer = 0; }
    var root = nodesHost.querySelector('.study-route-node.is-root');
    if (!root) return;
    root.classList.remove('is-entering');
    void root.offsetWidth;  // 强制重排，连续切树时动画能重新触发
    root.classList.add('is-entering');
    rootEnterTimer = window.setTimeout(function () {
      if (root.isConnected) root.classList.remove('is-entering');
      rootEnterTimer = 0;
    }, 420);
  }
  // 树命令前先把镜头动画停掉、钉到目标值再落盘：
  // 保存的是用户意图的最终镜头，而不是缓动中间帧（与 closeRoute 同款处理）。
  function settleViewThenSave() {
    stopViewAnimation();
    stopPanInertia();
    view = Object.assign({}, viewTarget);
    applyView();
    flushViewSave();
  }
  function switchTree(treeId) {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    if (treeId === state.activeTreeId) return Promise.resolve(null);
    settleViewThenSave();
    beginTreeTransition();
    return command({ command: 'switch-tree', treeId: treeId }).then(function () {
      if (!restoreView(state.activeTreeId)) fit(true);
      animateRootEntrance();
    }).finally(endTreeTransition);
  }
  function createTree() {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    settleViewThenSave();
    beginTreeTransition();
    return command({ command: 'create-tree' }, { duration: 320 }).then(function () {
      if (!restoreView(state.activeTreeId)) fit(true);
      animateRootEntrance();
    }).finally(endTreeTransition);
  }
  function deleteTree() {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    settleViewThenSave();
    var removedTreeId = state.activeTreeId;
    beginTreeTransition();
    return command({ command: 'delete-tree', treeId: state.activeTreeId }, { duration: 320 }).then(function () {
      try { localStorage.removeItem(viewKeyFor(removedTreeId)); } catch (e) {}
      if (!restoreView(state.activeTreeId)) fit(true);
      animateRootEntrance();
    }).finally(endTreeTransition);
  }
  function showError(error) {
    var message = error && error.message;
    if (error && error.name === 'AbortError') message = T('请求超时，请重试');
    var target = popover.querySelector('[data-role="route-form-error"]');
    if (target) target.textContent = message || String(error);
    else window.alert(message || String(error));
  }
  function updateTask(task, patch, options) {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    busy = true;
    var treeAtRequest = state.activeTreeId;
    return post('/api/study-task-update', Object.assign({ id: task.id }, patch)).then(function (json) {
      var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
      if (index >= 0) state.tasks[index] = json.task;
      applyTreeSnapshot(json, treeAtRequest);
      closePopover(false);
      if (options && options.fullRender) render(); else syncProgress(task.id);
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
      return json;
    }).finally(function () { busy = false; });
  }
  function changeProgress(task, delta) {
    if (busy) return;
    busy = true;
    var treeAtRequest = state.activeTreeId;
    post('/api/study-task-progress', { id: task.id, delta: delta }).then(function (json) {
      var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
      if (index >= 0) state.tasks[index] = json.task;
      applyTreeSnapshot(json, treeAtRequest);
      syncProgress(task.id);
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
    }).catch(showError).finally(function () { busy = false; });
  }
  function openConfirm(title, copy, action) {
    ++confirmMotionId;
    if (confirmCloseTimer) clearTimeout(confirmCloseTimer);
    confirmCloseTimer = 0;
    confirmAction = action;
    confirmBox.querySelector('[data-role="study-route-confirm-title"]').textContent = title;
    confirmBox.querySelector('[data-role="study-route-confirm-copy"]').textContent = copy;
    confirmBox.hidden = false;
    confirmBox.classList.remove('is-closing');
    confirmBox.setAttribute('aria-hidden', 'false');
    void confirmBox.offsetWidth;
    requestAnimationFrame(function () {
      if (confirmBox.hidden) return;
      confirmBox.classList.add('is-visible');
      confirmBox.querySelector('[data-route-action="confirm-cancel"]').focus();
    });
  }
  function closeConfirm(immediate) {
    if (confirmBox.hidden) { confirmAction = null; return; }
    var motionId = ++confirmMotionId;
    if (confirmCloseTimer) clearTimeout(confirmCloseTimer);
    confirmCloseTimer = 0;
    confirmBox.classList.remove('is-visible');
    confirmBox.classList.add('is-closing');
    confirmBox.setAttribute('aria-hidden', 'true');
    confirmAction = null;
    var finish = function () {
      if (motionId !== confirmMotionId) return;
      confirmBox.hidden = true;
      confirmBox.classList.remove('is-closing');
      confirmCloseTimer = 0;
    };
    if (immediate || prefersReduced) finish();
    else confirmCloseTimer = window.setTimeout(finish, 210);
  }
  function showOverlay() {
    if (open) return;
    if (routeCloseTimer) clearTimeout(routeCloseTimer);
    routeCloseTimer = 0;
    overlay.classList.remove('is-visible', 'is-closing');
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('study-goal-tree-open');
    open = true;
    scene.classList.add('is-loading');
    endTreeTransition();
    void overlay.offsetWidth;
    overlay.classList.add('is-visible');
  }
  function applyStudyPayload(json, requestId, taskId) {
    if (requestId !== routeRequestId) return;
    state.tasks = Array.isArray(json.tasks) ? json.tasks : [];
    applyTreePayloadInitial(json);
    scene.classList.remove('is-loading');
    render();
    renderRail();
    if (!restoreView(state.activeTreeId)) fit(true);
    requestAnimationFrame(function () {
      if (!open || requestId !== routeRequestId) return;
      var owner = taskId && GoalTree.taskOwner(state.tree, taskId);
      var target = owner && nodesHost.querySelector('[data-node-id="' + CSS.escape(owner.node.id) + '"]');
      (target || viewport).focus();
    });
  }
  function prefetchStudyData() {
    if (studyCache) return;
    var id = ++studyPrefetchId;
    api('/api/study').then(function (json) {
      if (id !== studyPrefetchId) return;
      studyCache = json;
      window[STUDY_DATA_CACHE_KEY] = json;
    }).catch(function () {});
  }
  function openRoute(trigger, taskId) {
    var requestId = ++routeRequestId;
    showOverlay();
    if (studyCache && studyCache.tasks) {
      applyStudyPayload(studyCache, requestId, taskId);
      var epoch = treeEpoch;
      api('/api/study').then(function (json) {
        if (!json || !json.tasks) return;
        // 快照取自切树前（纪元已推进）或面板已关/重开：丢弃，避免旧快照回退切换；
        // 也不更新 studyCache，防止下次打开先把回退态闪出来。
        if (epoch !== treeEpoch || !open || requestId !== routeRequestId) return;
        studyCache = json; window[STUDY_DATA_CACHE_KEY] = json;
        state.tasks = Array.isArray(json.tasks) ? json.tasks : [];
        applyTreePayloadInitial(json);
        render();
        renderRail();
        if (!restoreView(state.activeTreeId)) fit(true);
      }).catch(function () {});
      return;
    }
    var shared = window[STUDY_DATA_CACHE_KEY];
    if (shared && shared.tasks) {
      studyCache = shared;
      applyStudyPayload(shared, requestId, taskId);
      return;
    }
    var epoch = treeEpoch;
    api('/api/study').then(function (json) {
      if (epoch !== treeEpoch) return;
      studyCache = json;
      window[STUDY_DATA_CACHE_KEY] = json;
      applyStudyPayload(json, requestId, taskId);
    }).catch(function (err) {
      if (requestId !== routeRequestId) return;
      scene.classList.remove('is-loading');
      showError(err);
    });
  }
  function closeRoute() {
    if (!open) return;
    setRailVisible(false);
    endTreeTransition();
    railOrbY = null;  // 滑块位置随画布一起失效，下次打开直接落位，不做跨会话飞行
    ++routeRequestId;
    if (routeCloseTimer) clearTimeout(routeCloseTimer);
    if (drag) finishDrag(true);
    if (pan) {
      try { viewport.releasePointerCapture(pan.id); } catch (error) {}
    }
    pan = null;
    viewport.classList.remove('is-panning');
    stopViewAnimation();
    stopPanInertia();
    // 先停动画并把镜头钉到目标值，再落盘：保存的是用户意图的最终镜头，而不是缓动中间帧。
    view = Object.assign({}, viewTarget);
    applyView();
    flushViewSave();
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    if (summaryFrame) cancelAnimationFrame(summaryFrame);
    layoutFrame = 0;
    summaryFrame = 0;
    closePopover(false); closeConfirm();
    if (reparentBadge) { reparentBadge.remove(); reparentBadge = null; }
    if (dropSlot) { dropSlot.remove(); dropSlot = null; }
    nodesHost.innerHTML = '';
    edgesHost.innerHTML = '';
    nodeElements.clear();
    edgeElements.clear();
    visualPlacements.clear();
    layout = null;
    overlay.classList.remove('is-visible');
    overlay.classList.add('is-closing');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('study-goal-tree-open');
    open = false;
    routeCloseTimer = window.setTimeout(function () {
      if (open) return;
      overlay.hidden = true;
      overlay.classList.remove('is-closing');
      routeCloseTimer = 0;
    }, prefersReduced ? 0 : 320);
  }
  function parentForAnchor(anchor) {
    return ['branch', 'task'].includes(anchor.dataset.kind) ? anchor.dataset.nodeId : null;
  }

  overlay.addEventListener('pointerdown', function (event) {
    pointerDownInPopover = !!event.target.closest('.study-route-popover');
  });
  overlay.addEventListener('click', function (event) {
    if (performance.now() - dragEndedAt < 220) return;
    var actionControl = event.target.closest('[data-route-action]');
    if (actionControl) {
      event.preventDefault(); event.stopPropagation();
      var action = actionControl.dataset.routeAction;
      if (action === 'close') return closeRoute();
      if (action === 'fit') return fit();
      if (action === 'confirm-cancel') return closeConfirm();
      if (action === 'confirm-ok') {
        var pending = confirmAction; closeConfirm(); if (pending) Promise.resolve(pending()).catch(ignoreBusy); return;
      }
      var anchor = actionControl.closest('.study-route-node');
      if (!anchor) return;
      if (action === 'add') return addMenu(anchor);
      if (action === 'menu') return nodeMenu(anchor);
      if (action === 'settings') return formPopover(anchor, 'settings');
      if (action === 'progress') {
        var progressTask = findTask(anchor.dataset.taskId);
        if (progressTask) changeProgress(progressTask, Number(actionControl.dataset.delta || 0));
        return;
      }
      if (action === 'complete') {
        var completeTask = findTask(anchor.dataset.taskId);
        if (completeTask) updateTask(completeTask, { status: completeTask.status === 'done' ? 'active' : 'done' }).catch(ignoreBusy);
      }
      return;
    }
    if (!event.target.closest('.study-route-popover') && !pointerDownInPopover) closePopover(false);
  });
  popover.addEventListener('click', function (event) {
    event.stopPropagation();
    var control = event.target.closest('[data-route-pop]');
    if (!control) return;
    event.preventDefault();
    var anchor = nodesHost.querySelector('[data-node-id="' + CSS.escape(popover.dataset.anchorId || '') + '"]');
    if (!anchor) return;
    var action = control.dataset.routePop;
    if (['new-branch', 'new-task', 'attach-task', 'rename', 'settings'].includes(action)) return formPopover(anchor, action);
    if (action === 'detach') {
      var task = findTask(anchor.dataset.taskId);
      return openConfirm(T('从路线移出任务？'), T('任务仍会保留在学习页。'), function () {
        return command({ command: 'detach-task', taskId: task.id });
      });
    }
    if (action === 'set-color') {
      return command({ command: 'update-branch', nodeId: anchor.dataset.nodeId, color: control.dataset.color || '' }).catch(showError);
    }
    if (action === 'delete-branch') {
      return openConfirm(T('删除这个分支？'), T('整段分支会从路线移除，其中的学习任务仍保留在学习页。'), function () {
        return command({ command: 'delete-branch', nodeId: anchor.dataset.nodeId });
      });
    }
    if (action === 'delete-tree') {
      var tree = state.trees.find(function (item) { return item.id === state.activeTreeId; }) || state.tree;
      return openConfirm(T('删除目标树？'), T('「') + (tree.title || T('未命名目标')) + T('」会被删除，其中的学习任务仍保留在学习页。'), function () {
        return deleteTree();
      });
    }
  });
  popover.addEventListener('submit', function (event) {
    var form = event.target.closest('form[data-route-form]');
    if (!form) return;
    event.preventDefault();
    var values = new FormData(form), kind = form.dataset.routeForm;
    var anchor = nodesHost.querySelector('[data-node-id="' + CSS.escape(popover.dataset.anchorId || '') + '"]');
    if (!anchor) return;
    var parentId = parentForAnchor(anchor), nodeId = anchor.dataset.nodeId;
    if (kind === 'new-branch') return command({ command: 'create-branch', parentId: parentId, title: values.get('title') }).catch(showError);
    var parentNode = state.tree.nodes.find(function (item) { return item.id === parentId; });
    var taskSlot = parentNode && parentNode.kind === 'task' ? { kind: 'end' } : null;
    if (kind === 'new-task') return command({ command: 'create-task', parentId: parentId, taskSlot: taskSlot, title: values.get('title'), target: values.get('target') }).catch(showError);
    if (kind === 'attach-task') return command({ command: 'attach-task', parentId: parentId, taskSlot: taskSlot, taskId: values.get('taskId') }).catch(showError);
    var node = nodeId === 'root' ? { kind: 'root' } : state.tree.nodes.find(function (item) { return item.id === nodeId; });
    if (kind === 'rename') {
      if (node.kind === 'root') return command({ command: 'rename-root', title: values.get('title') }).catch(showError);
      if (node.kind === 'branch') return command({ command: 'update-branch', nodeId: node.id, title: values.get('title') }).catch(showError);
      var renameTask = findTask(node.taskId);
      return updateTask(renameTask, { title: values.get('title') }, { fullRender: true }).catch(showError);
    }
    if (kind === 'settings') {
      var settingsTask = findTask(node.taskId), current = Number(values.get('current') || 0), target = Number(values.get('target') || 0);
      if (!Number.isInteger(current) || !Number.isInteger(target) || current < 0 || target < current || target > 9999) {
        return showError(new Error(T('进度需要满足 0 ≤ 当前进度 ≤ 目标总量 ≤ 9999')));
      }
      var oldMilestones = settingsTask.progress && Array.isArray(settingsTask.progress.milestones) ? settingsTask.progress.milestones : [];
      var milestones = target ? oldMilestones.filter(function (item) { return Number(item.at) <= target; }) : [];
      return updateTask(settingsTask, { progress: { current: current, target: target, milestones: milestones } }, { fullRender: true }).catch(showError);
    }
  });

  nodesHost.addEventListener('dblclick', function (event) {
    var anchor = event.target.closest('.study-route-node');
    if (!anchor || anchor.dataset.kind === 'milestone' || event.target.closest('button')) return;
    formPopover(anchor, 'rename');
  });
  overlay.addEventListener('contextmenu', function (event) {
    event.preventDefault();
  });

  nodesHost.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    event.stopPropagation();
    var anchor = event.target.closest('.study-route-node');
    if (!anchor || event.target.closest('button')) { closePopover(false); return; }
    if (anchor.dataset.kind === 'root') { addMenu(anchor); return; }
    if (anchor.dataset.kind === 'task') { nodeMenu(anchor); return; }
    if (anchor.dataset.kind !== 'branch') { closePopover(false); return; }
    var nodeId = anchor.dataset.nodeId || '';
    if (!popover.hidden && popover.dataset.anchorId === nodeId) {
      closePopover(true);
      return;
    }
    var node = state.tree.nodes.find(function (item) { return item.id === nodeId; });
    var currentColor = (node && node.color) ? node.color : '';
    openPopover(anchor, colorPaletteHTML(currentColor));
  });
  nodesHost.addEventListener('pointerdown', function (event) {
    var anchor = event.target.closest('.study-route-node');
    if (event.button !== 0 || drag || !anchor || ['root', 'milestone'].includes(anchor.dataset.kind) || event.target.closest('button')) return;
    drag = {
      id: event.pointerId, source: anchor, nodeId: anchor.dataset.nodeId,
      x: event.clientX, y: event.clientY,
      startPoint: routeScenePoint(event.clientX, event.clientY),
      active: false, candidate: null, starts: new Map(),
    };
    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragCancel);
  });
  function routeScenePoint(clientX, clientY) {
    var rect = viewport.getBoundingClientRect(), zoom = Math.max(.001, view.zoom);
    return { x: (clientX - rect.left - view.x) / zoom, y: (clientY - rect.top - view.y) / zoom };
  }
  function clearDropPreview() {
    nodesHost.querySelectorAll('.is-drop-target,.is-drop-parent,.is-reparent-target').forEach(function (item) {
      item.classList.remove('is-drop-target', 'is-drop-parent', 'is-reparent-target');
    });
    if (dropSlot) dropSlot.hidden = true;
    if (reparentBadge) reparentBadge.hidden = true;
  }
  function showDropPreview(candidate) {
    clearDropPreview();
    if (!candidate) return;
    if (candidate.type === 'reparent') {
      var target = nodeElements.get(candidate.targetId);
      if (target) target.classList.add('is-reparent-target');
      if (!reparentBadge) {
        reparentBadge = document.createElement('div');
        reparentBadge.className = 'study-route-reparent-badge'; reparentBadge.textContent = '+';
        reparentBadge.setAttribute('aria-hidden', 'true'); scene.appendChild(reparentBadge);
      }
      var placement = drag && drag.baseLayout && drag.baseLayout.nodes.find(function (item) { return item.id === candidate.targetId; });
      if (placement) {
        reparentBadge.style.left = ((candidate.direction === 'left' ? placement.x : placement.x + placement.width) - 9) + 'px';
        reparentBadge.style.top = (placement.y - placement.height / 2 - 9) + 'px';
        reparentBadge.hidden = false;
      }
      return;
    }
    if (!dropSlot) {
      dropSlot = document.createElement('div'); dropSlot.className = 'study-route-drop-slot';
      dropSlot.setAttribute('aria-hidden', 'true'); scene.appendChild(dropSlot);
    }
    var parent = nodeElements.get(candidate.parentId || 'root');
    if (parent) parent.classList.add('is-drop-parent');
    var sourcePlacement = drag && drag.baseLayout && drag.baseLayout.nodes.find(function (item) {
      return item.id === drag.nodeId;
    });
    var centerNudge = sourcePlacement ? Math.max(0, (sourcePlacement.width - 84) / 2) : 0;
    dropSlot.style.left = (candidate.depthCoord + centerNudge - 42) + 'px';
    dropSlot.style.top = (candidate.slotCoord - 1.5) + 'px';
    dropSlot.hidden = false;
  }
  function dragHitId(clientX, clientY) {
    if (typeof document.elementsFromPoint !== 'function') return '';
    var hits = document.elementsFromPoint(clientX, clientY);
    for (var index = 0; index < hits.length; index += 1) {
      var element = hits[index] && hits[index].closest ? hits[index].closest('.study-route-node') : null;
      if (!element || !nodesHost.contains(element)) continue;
      if (drag && drag.dragIds && drag.dragIds.has(element.dataset.nodeId)) continue;
      return element.dataset.nodeId || '';
    }
    return '';
  }
  function activateDrag() {
    if (!drag || drag.active || !layout) return;
    stopViewAnimation();
    viewTarget = Object.assign({}, view);
    drag.startPoint = routeScenePoint(drag.x, drag.y);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = 0;
    drag.baseTree = { version: 1, title: state.tree.title, nodes: state.tree.nodes.map(function (node) { return Object.assign({}, node); }) };
    drag.baseLayout = Object.assign({}, layout, {
      nodes: layout.nodes.map(function (placement) { return Object.assign({}, visualPlacements.get(placement.id) || placement); }),
    });
    drag.dropContext = GoalTree.prepareDropContext(drag.baseLayout, drag.baseTree, drag.nodeId);
    drag.dragIds = new Set(drag.dropContext.excluded);
    drag.livePlacements = placementMap(drag.baseLayout.nodes);
    drag.baseLayout.nodes.forEach(function (placement) {
      if (drag.dragIds.has(placement.id)) drag.starts.set(placement.id, Object.assign({}, placement));
    });
    drag.affectedEdges = drag.baseLayout.edges.filter(function (edge) {
      return drag.dragIds.has(edge.from) || drag.dragIds.has(edge.to);
    });
    drag.dragIds.forEach(function (id) {
      var element = nodeElements.get(id);
      if (element) element.classList.add(id === drag.nodeId ? 'is-drag-anchor' : 'is-subtree-dragging');
    });
    document.body.classList.add('study-route-node-dragging'); drag.active = true;
    try { drag.source.setPointerCapture(drag.id); } catch (error) {}
  }
  function autoPanDrag(clientX, clientY) {
    var rect = viewport.getBoundingClientRect(), edge = 56;
    var dx = clientX < rect.left + edge ? Math.min(11, (rect.left + edge - clientX) * .18)
      : clientX > rect.right - edge ? -Math.min(11, (clientX - rect.right + edge) * .18) : 0;
    var dy = clientY < rect.top + edge ? Math.min(11, (rect.top + edge - clientY) * .18)
      : clientY > rect.bottom - edge ? -Math.min(11, (clientY - rect.bottom + edge) * .18) : 0;
    if (!dx && !dy) return false;
    stopViewAnimation();
    view.x += dx; view.y += dy;
    viewTarget = Object.assign({}, view);
    applyView();
    return true;
  }
  function positionDraggedSubtree(clientX, clientY) {
    if (!drag || !drag.active) return;
    var point = routeScenePoint(clientX, clientY);
    var dx = point.x - drag.startPoint.x, dy = point.y - drag.startPoint.y;
    drag.starts.forEach(function (start, id) {
      var placement = Object.assign({}, start, { x: start.x + dx, y: start.y + dy });
      drag.livePlacements.set(id, placement);
      var element = nodeElements.get(id);
      if (element) element.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    });
    drag.affectedEdges.forEach(function (edge) {
      var path = edgeElements.get(edge.from + '>' + edge.to);
      var from = drag.livePlacements.get(edge.from), to = drag.livePlacements.get(edge.to);
      if (path && from && to) path.setAttribute('d', edgePath(from, to));
    });
  }
  function updateDragCandidate(clientX, clientY) {
    if (!drag || !drag.active) return;
    var point = routeScenePoint(clientX, clientY), hitId = dragHitId(clientX, clientY);
    var candidate = GoalTree.structureDropCandidate(
      drag.baseLayout, drag.baseTree, drag.nodeId, point,
      { targetId: hitId, rowGap: 30, levelGap: 92, context: drag.dropContext },
    );
    var candidateKey = candidate
      ? [candidate.type, candidate.targetId, candidate.parentId, candidate.beforeId,
        candidate.side, candidate.taskSlot && candidate.taskSlot.kind,
        candidate.taskSlot && candidate.taskSlot.milestoneId].join('|') : '';
    drag.candidate = candidate;
    if (candidateKey === drag.candidateKey) return;
    drag.candidateKey = candidateKey;
    showDropPreview(candidate);
  }
  function flushDragFrame(allowAutoPan) {
    dragFrame = 0;
    if (!drag || !drag.active) return;
    var panned = allowAutoPan !== false && autoPanDrag(drag.latestX, drag.latestY);
    positionDraggedSubtree(drag.latestX, drag.latestY);
    updateDragCandidate(drag.latestX, drag.latestY);
    if (panned && drag && drag.active) {
      dragFrame = requestAnimationFrame(function () { flushDragFrame(true); });
    }
  }
  function onDragMove(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 4) return;
    if (!drag.active) activateDrag();
    event.preventDefault(); drag.latestX = event.clientX; drag.latestY = event.clientY;
    if (!dragFrame) dragFrame = requestAnimationFrame(function () { flushDragFrame(true); });
  }
  function finishDrag(cancelled) {
    if (!drag) return;
    var current = drag;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (current.active && Number.isFinite(current.latestX) && Number.isFinite(current.latestY)) {
      positionDraggedSubtree(current.latestX, current.latestY);
      updateDragCandidate(current.latestX, current.latestY);
    }
    if (current.active && current.livePlacements) {
      visualPlacements = placementMap(Array.from(current.livePlacements.values()));
      current.dragIds.forEach(function (id) {
        var placement = current.livePlacements.get(id), element = nodeElements.get(id);
        if (!placement || !element) return;
        element.style.transform = '';
        element.style.left = placement.x + 'px';
        element.style.top = (placement.y - placement.height / 2) + 'px';
      });
    }
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragCancel);
    current.dragIds && current.dragIds.forEach(function (id) {
      var element = nodeElements.get(id);
      if (element) element.classList.remove('is-drag-anchor', 'is-subtree-dragging');
    });
    document.body.classList.remove('study-route-node-dragging'); clearDropPreview();
    if (current.active) saveViewSoon();
    if (current.active) {
      dragEndedAt = performance.now();
      var preview = !cancelled && current.candidate
        ? GoalTree.previewMove(
          current.baseTree, current.nodeId, current.candidate.parentId, current.candidate.beforeId,
          current.candidate.taskSlot, current.candidate.side,
        ) : null;
      if (preview) {
        state.tree = preview; render({ duration: 260, preserveViewAnchor: 'root' });
        command({
          command: 'move-node', nodeId: current.nodeId, parentId: current.candidate.parentId,
          beforeId: current.candidate.beforeId, taskSlot: current.candidate.taskSlot, side: current.candidate.side,
        }, { skipRender: true })
          .catch(function (error) {
            state.tree = current.baseTree;
            render({ duration: 260, preserveViewAnchor: 'root' });
            ignoreBusy(error);
          });
      } else {
        state.tree = current.baseTree; render({ duration: 260, preserveViewAnchor: 'root' });
      }
    }
  }
  function onDragEnd(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.active) event.preventDefault();
    finishDrag(false);
  }
  function onDragCancel(event) {
    if (!drag || drag.id !== event.pointerId) return;
    finishDrag(true);
  }

  viewport.addEventListener('wheel', function (event) {
    if (!open) return;
    event.preventDefault();
    setZoom(viewTarget.zoom * Math.exp(-event.deltaY * .00115), event.clientX, event.clientY);
  }, { passive: false });
  viewport.addEventListener('pointerdown', function (event) {
    if (event.button === 0) stopPanInertia();
    if (event.button !== 0 || event.target.closest('.study-route-node,.study-route-fit,.study-route-popover')) return;
    stopViewAnimation();
    var now = performance.now();
    pan = {
      id: event.pointerId, x: event.clientX, y: event.clientY, ox: view.x, oy: view.y,
      lastMoveX: event.clientX, lastMoveY: event.clientY, lastMoveT: now,
      velX: null, velY: null, moved: false,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
  });
  viewport.addEventListener('pointermove', function (event) {
    if (!pan || pan.id !== event.pointerId) return;
    var now = performance.now(), dt = now - pan.lastMoveT;
    if (dt > 0) {
      var instantaneousX = (event.clientX - pan.lastMoveX) / dt;
      var instantaneousY = (event.clientY - pan.lastMoveY) / dt;
      pan.velX = pan.velX == null ? instantaneousX : pan.velX * .4 + instantaneousX * .6;
      pan.velY = pan.velY == null ? instantaneousY : pan.velY * .4 + instantaneousY * .6;
    }
    pan.lastMoveX = event.clientX;
    pan.lastMoveY = event.clientY;
    pan.lastMoveT = now;
    pan.moved = pan.moved || Math.hypot(event.clientX - pan.x, event.clientY - pan.y) >= 2;
    view.x = pan.ox + event.clientX - pan.x;
    view.y = pan.oy + event.clientY - pan.y;
    viewTarget = Object.assign({}, view);
    applyView();
  });
  function endPan(event) {
    if (!pan || pan.id !== event.pointerId) return;
    var finished = pan;
    pan = null; viewport.classList.remove('is-panning');
    try { viewport.releasePointerCapture(event.pointerId); } catch (error) {}
    saveViewSoon();
    if (event.type === 'pointerup' && finished.moved) startPanInertia(finished);
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);
  overlay.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!confirmBox.hidden) closeConfirm();
    else if (!popover.hidden) closePopover(true);
    else closeRoute();
  });
  stageEl.addEventListener('mousemove', function (event) {
    var rect = stageEl.getBoundingClientRect();
    setRailVisible(event.clientX - rect.left <= railRevealPx || railOver);
  }, { passive: true });
  rail.addEventListener('pointerenter', function () { railOver = true; setRailVisible(true); });
  rail.addEventListener('pointerleave', function () { railOver = false; setRailVisible(false); });
  railList.addEventListener('click', function (event) {
    var button = event.target.closest('[data-route-tree-id]');
    if (!button) return;
    event.preventDefault();
    if (button.dataset.routeTreeId === state.activeTreeId) return;
    switchTree(button.dataset.routeTreeId).catch(ignoreBusy);
  });
  railAdd.addEventListener('click', function (event) {
    event.preventDefault();
    createTree().catch(ignoreBusy);
  });
  window.addEventListener('resize', function () { if (open) { closePopover(false); fit(); } });
  window.addEventListener('pagehide', function () { if (open) closeRoute(); });
  window.addEventListener('beforeunload', function () { if (open) flushViewSave(); });
  document.querySelectorAll('[data-action="study-goal-tree-open"]').forEach(function (button) {
    button.addEventListener('click', function () { openRoute(button); });
    button.addEventListener('pointerenter', function () { prefetchStudyData(); });
  });
  window.StudyRoute = { open: function (taskId, trigger) { openRoute(trigger, taskId); }, close: closeRoute, prefetch: prefetchStudyData, refresh: function () {
    if (!open) return Promise.resolve(false);
    var epoch = treeEpoch;
    return api('/api/study').then(function (json) {
      if (epoch !== treeEpoch) return false;
      studyCache = json; window[STUDY_DATA_CACHE_KEY] = json;
      state.tasks = Array.isArray(json.tasks) ? json.tasks : [];
      applyTreePayloadInitial(json);
      render();
      renderRail();
      return true;
    });
  } };
})();

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
  var guide = overlay.querySelector('[data-role="study-route-guide"]');
  var guideCopy = overlay.querySelector('[data-role="study-route-guide-copy"]');
  var guidePosition = overlay.querySelector('[data-role="study-route-guide-position"]');
  var helpTrigger = overlay.querySelector('[data-route-action="help"]');
  var stageEl = overlay.querySelector('.study-route-stage');
  var T = function (value) { return window.RelatumI18n ? window.RelatumI18n.t(value) : value; };
  var state = { tasks: [], tree: { version: 2, title: '我的学习路线', nodes: [], links: [] }, trees: [], activeTreeId: '' };
  var open = false, busy = false, layout = null, confirmAction = null;
  var collapsedIds = new Set(), nextTaskIndex = 0, nextCandidates = [];
  var guidePage = 0;
  var routeRequestId = 0, routeCloseTimer = 0;
  // 树命令纪元：切/建/删树时递增。后台 /api/study 快照若取自纪元变化之前
  // （即切树前），落地时必须丢弃，否则会把刚完成的切换静默回退。
  var treeEpoch = 0;
  var popoverCloseTimer = 0, popoverSwapTimer = 0, popoverMotionId = 0;
  var confirmCloseTimer = 0, confirmMotionId = 0;
  var view = { x: 42, y: 42, zoom: 1 };
  var viewTarget = Object.assign({}, view), viewTickAt = 0;
  var pan = null, drag = null, dragEndedAt = 0, pointerDownInPopover = false;
  var collapseMotion = null;
  var nodeElements = new Map(), edgeElements = new Map(), visualPlacements = new Map();
  var layoutFrame = 0, summaryFrame = 0, viewFrame = 0, panInertiaFrame = 0, dragFrame = 0;
  var dropSlot = null, reparentBadge = null, viewSaveTimer = 0;
  var GOAL_TREE_ROUTE_VIEW_KEY = 'relatum.goal-tree-route.view';
  var legacyViewClaimed = false;
  var STUDY_DATA_CACHE_KEY = '_relatumStudyData';
  var GOAL_TREE_SIMPLE_KEY = 'canvas:studyGoalTreeSimpleMode:v1';
  var studyCache = null, studyPrefetchId = 0;
  var prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
  })();

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character];
    });
  }
  function simpleModeEnabled() {
    try { return localStorage.getItem(GOAL_TREE_SIMPLE_KEY) !== '0'; } catch (error) { return true; }
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
  function activeTree(trees, treeId) {
    return (trees || []).find(function (tree) { return tree.id === treeId; }) || (trees || [])[0] || null;
  }
  function applyTreePayloadInitial(json) {
    var trees = Array.isArray(json.goalTrees) ? json.goalTrees : [];
    state.trees = trees;
    state.activeTreeId = json.activeTreeId || (trees.length ? trees[0].id : '');
    state.tree = activeTree(trees, state.activeTreeId) || { version: 2, title: '我的学习路线', nodes: [], links: [] };
    nextTaskIndex = 0;
  }
  function applyTreeSnapshot(json, expectedTreeId) {
    // 在途请求守卫：响应快照只属于请求发出时的那棵树，切树后不覆盖当前树。
    if (!expectedTreeId || (json.activeTreeId || '') !== expectedTreeId) return;
    if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
    state.tree = activeTree(state.trees, expectedTreeId) || state.tree;
  }
  function syncStudyCacheFromState() {
    var previous = studyCache || window[STUDY_DATA_CACHE_KEY] || {};
    var next = Object.assign({}, previous, {
      version: 6,
      tasks: state.tasks,
      goalTrees: state.trees,
      activeTreeId: state.activeTreeId,
    });
    if (!Array.isArray(next.trash)) next.trash = [];
    studyCache = next;
    window[STUDY_DATA_CACHE_KEY] = next;
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
  // activeId：切树点击瞬间的滑块/高亮抢跑目标；平时缺省用权威活动树。
  function renderRail(activeId) {
    if (!railList) return;
    // 先让上轮在途 FLIP 落定再取快照，避免量到飞行中的几何。
    clearRailTransients();
    var snap = railSnapshot();
    var fromY = railOrbY;
    var railActiveId = activeId || state.activeTreeId;
    railList.innerHTML = RAIL_ORB_HTML + state.trees.map(function (tree, index) {
      return '<button type="button" class="study-route-rail-item' + (tree.id === railActiveId ? ' is-active' : '')
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
  function sceneTransform(offsetX) {
    return 'translate3d(' + (view.x + (Number(offsetX) || 0)) + 'px,' + view.y + 'px,0) scale(' + view.zoom + ')';
  }
  function applyView() {
    scene.style.transform = sceneTransform(0);
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
        collapsedIds: Array.from(collapsedIds),
      }));
    } catch (e) {}
  }
  function saveViewSoon() {
    clearTimeout(viewSaveTimer);
    // 在调度时刻钉住树 id 与镜头快照：防抖定时器触发时若已切树，也不能把旧镜头写进新树的 key。
    var treeId = state.activeTreeId;
    var snapshot = { x: view.x, y: view.y, zoom: view.zoom, collapsedIds: Array.from(collapsedIds) };
    viewSaveTimer = setTimeout(function () {
      viewSaveTimer = 0;
      try {
        localStorage.setItem(viewKeyFor(treeId), JSON.stringify({
          x: Math.round(snapshot.x * 10) / 10,
          y: Math.round(snapshot.y * 10) / 10,
          zoom: Math.round(snapshot.zoom * 1000) / 1000,
          collapsedIds: snapshot.collapsedIds,
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
      collapsedIds = new Set();
      if (!raw || typeof raw !== 'object') return false;
      var validBranches = new Set((state.tree.nodes || []).filter(function (node) { return node.kind === 'branch'; }).map(function (node) { return node.id; }));
      (Array.isArray(raw.collapsedIds) ? raw.collapsedIds : []).forEach(function (id) {
        if (validBranches.has(id)) collapsedIds.add(id);
      });
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
  function availabilityText(placement) {
    var reasons = placement && placement.availability && placement.availability.reasons || [];
    if (!reasons.length) return placement && placement.kind === 'task' && !(placement.metrics || {}).complete ? T('可开始') : '';
    if (reasons.length > 1) return T('还需') + ' ' + reasons.length + ' ' + T('个条件');
    var reason = reasons[0];
    return reason.kind === 'milestone'
      ? T('等待「') + reason.title + T('」达到任务点')
      : T('等待「') + reason.title + T('」完成');
  }
  function branchMarkup(placement) {
    var metrics = placement.metrics || { count: 0, progress: 0 };
    var percent = Math.round(metrics.progress * 100);
    var children = GoalTree.primaryChildren(state.tree).get(placement.id) || [];
    var collapse = children.length ? '<button type="button" class="study-route-collapse" data-route-action="collapse" aria-expanded="'
      + (!placement.collapsed) + '" aria-label="' + (placement.collapsed ? T('展开阶段') : T('收起阶段')) + '">'
      + '<span aria-hidden="true"></span></button>' : '';
    var hidden = placement.collapsed ? '<em class="study-route-hidden-count">' + placement.hiddenCount + ' ' + T('项已隐藏') + '</em>' : '';
    return '<div class="study-route-branch-main"><strong data-user-content>' + escapeHtml(placement.node.title)
      + '</strong><span class="study-route-branch-meta-row"><button type="button" class="study-route-node-meta" data-role="route-node-meta" data-route-action="progress-breakdown">'
      + percent + '% · ' + metrics.count + ' ' + T('项任务') + '</button>'
      + hidden + '</span><i aria-hidden="true"><b data-route-progress-fill data-progress-target="' + percent + '" style="width:' + percent + '%"></b></i></div>'
      + '<span class="study-route-node-actions">' + collapse + '<button type="button" data-route-action="add" aria-label="'
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
    { value: '#def0ec', label: '青瓷' },
    { value: '#eae4f2', label: '雾蓝' },
    { value: '#eaf0dc', label: '新绿' },
    { value: '#f0efe9', label: '月灰' },
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
    var lockedByConditions = placement.availability && !placement.availability.available;
    var blocked = !done && lockedByConditions;
    var ready = !done && progress.target > 0 && progress.current >= progress.target;
    var controls = progress.target && !done
      ? '<span class="study-route-task-steps"><button type="button" data-route-action="progress" data-delta="-1" aria-label="进度减一"'
        + (blocked || progress.current <= 0 ? ' disabled' : '') + '>−</button><button type="button" data-route-action="progress" data-delta="1" aria-label="进度加一"'
        + (blocked || progress.current >= progress.target ? ' disabled' : '') + '>＋</button></span>' : '';
    var value = progress.target ? progress.current + ' / ' + progress.target : T('设置进度');
    var width = progress.target ? Math.round(progress.current / progress.target * 100) : 0;
    var availability = availabilityText(placement);
    return '<button type="button" class="study-route-task-check' + (done ? ' is-done' : '') + (ready ? ' is-ready' : '')
      + '" data-route-action="complete"' + (blocked ? ' disabled' : '') + ' aria-label="' + (done ? T('恢复为未完成') : T('标记完成')) + '"><span>✓</span></button>'
      + '<div class="study-route-task-main"><strong data-user-content>' + escapeHtml(task.title || T('未命名任务'))
      + '</strong><span class="study-route-task-line"><button type="button" class="study-route-task-value" data-route-action="settings"'
      + (lockedByConditions ? ' disabled' : '') + '>' + escapeHtml(value) + '</button>'
      + (availability ? (blocked ? '<button type="button" class="study-route-task-state" data-route-action="blockers">'
        + escapeHtml(availability) + '</button>' : '<small class="study-route-task-state">' + escapeHtml(availability) + '</small>') : '') + '</span>'
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
  function edgeKey(edge) { return edge.id || edge.from + '>' + edge.to; }
  function syncEdgeElements(next, options) {
    options = options || {};
    if (!edgesHost.querySelector('#study-route-arrow')) {
      var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = '<marker id="study-route-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker>';
      edgesHost.appendChild(defs);
    }
    var wanted = new Set(next.edges.map(edgeKey));
    edgeElements.forEach(function (path, id) {
      if (wanted.has(id)) return;
      path.remove(); edgeElements.delete(id);
    });
    next.edges.forEach(function (edge) {
      var id = edgeKey(edge), path = edgeElements.get(id), isNewPath = !path;
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.dataset.edgeId = id;
        path.dataset.from = edge.from; path.dataset.to = edge.to;
        edgesHost.appendChild(path); edgeElements.set(id, path);
        if (!options.suppressEntrance && !prefersReduced) {
          requestAnimationFrame(function () { if (path.isConnected) path.classList.remove('is-entering'); });
        }
      }
      path.setAttribute('class', 'study-route-edge is-' + edge.type + (edge.primary ? ' is-primary' : ' is-secondary')
        + (isNewPath && !options.suppressEntrance && !prefersReduced ? ' is-entering' : ''));
      if (edge.type === 'requires') path.setAttribute('marker-end', 'url(#study-route-arrow)');
      else path.removeAttribute('marker-end');
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
      var path = edgeElements.get(edgeKey(edge));
      var from = placements.get(edge.from), to = placements.get(edge.to);
      if (path && from && to) path.setAttribute('d', edgePath(from, to));
    });
  }
  function animateLayout(previous, next, duration, excluded, newNodesAtDestination) {
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = 0;
    var toMap = placementMap(next.nodes);
    var fromMap = visualPlacements.size ? placementMap(Array.from(visualPlacements.values()))
      : placementMap(previous && previous.nodes);
    next.nodes.forEach(function (item) {
      if (fromMap.has(item.id)) return;
      if (newNodesAtDestination) {
        fromMap.set(item.id, Object.assign({}, item));
        return;
      }
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
  function transitionFill(fill, target, from) {
    if (!fill) return;
    target = Math.max(0, Math.min(100, Number(target) || 0));
    fill.dataset.progressTarget = String(target);
    if (prefersReduced || !Number.isFinite(from) || Math.abs(target - from) < .01) {
      fill.style.width = target + '%';
      return;
    }
    fill.style.width = Math.max(0, Math.min(100, from)) + '%';
    void fill.offsetWidth;
    requestAnimationFrame(function () {
      if (fill.isConnected) fill.style.width = target + '%';
    });
  }
  function transitionTaskCheck(check, previous) {
    if (!check || !previous || prefersReduced) return;
    var nextDone = check.classList.contains('is-done');
    var nextReady = check.classList.contains('is-ready');
    if (previous.done === nextDone && previous.ready === nextReady) return;
    check.classList.toggle('is-done', previous.done);
    check.classList.toggle('is-ready', previous.ready);
    void check.offsetWidth;
    requestAnimationFrame(function () {
      if (!check.isConnected) return;
      check.classList.toggle('is-done', nextDone);
      check.classList.toggle('is-ready', nextReady);
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
      var isComplete = !!((placement.metrics || {}).complete && placement.kind !== 'root');
      var isBlocked = !!(placement.availability && !placement.availability.available);
      var wasBlocked = !!element && element.classList.contains('is-blocked');
      var oldFill = element && element.querySelector('[data-route-progress-fill]');
      var oldFillPercent = oldFill ? Number(oldFill.dataset.progressTarget || 0) : NaN;
      var oldCheck = element && element.querySelector('.study-route-task-check');
      var oldCheckState = oldCheck ? {
        done: oldCheck.classList.contains('is-done'),
        ready: oldCheck.classList.contains('is-ready'),
      } : null;
      if (!element) {
        element = document.createElement('article');
        element.setAttribute('role', 'treeitem'); element.tabIndex = 0;
        nodesHost.appendChild(element); nodeElements.set(placement.id, element); created.push(element);
      }
      var isExpansionEntrance = isNew && options.expandEntrance && !prefersReduced;
      element.className = 'study-route-node is-' + placement.kind
        + (isComplete ? ' is-complete' : '')
        + (isBlocked ? ' is-blocked' : '')
        + (placement.kind === 'task' && !(placement.metrics || {}).complete && placement.availability && placement.availability.available ? ' is-ready' : '')
        + (placement.collapsed ? ' is-collapsed' : '')
        + (isExpansionEntrance ? ' is-expanding' : '')
        + (isNew && !isExpansionEntrance && !options.suppressEntrance && !prefersReduced
          && !isComplete && !isBlocked ? ' is-entering' : '');
      element.dataset.nodeId = placement.id; element.dataset.kind = placement.kind;
      var statusText = availabilityText(placement);
      if (statusText) element.setAttribute('data-tooltip', statusText);
      else element.removeAttribute('data-tooltip');
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
      if (options.expandingControlIds && options.expandingControlIds.has(placement.id)) {
        var expandingControl = element.querySelector('.study-route-collapse');
        if (expandingControl) {
          expandingControl.classList.add('is-expanding');
          window.setTimeout(function () {
            if (expandingControl.isConnected) expandingControl.classList.remove('is-expanding');
          }, prefersReduced ? 0 : 230);
        }
      }
      if (options.revealingHiddenCountIds && options.revealingHiddenCountIds.has(placement.id)) {
        var revealingHiddenCount = element.querySelector('.study-route-hidden-count');
        if (revealingHiddenCount) {
          revealingHiddenCount.classList.add('is-revealing');
          window.setTimeout(function () {
            if (revealingHiddenCount.isConnected) revealingHiddenCount.classList.remove('is-revealing');
          }, prefersReduced ? 0 : 310);
        }
      }
      if (!prefersReduced && options.hidingHiddenCountById && options.hidingHiddenCountById.has(placement.id)) {
        var hiddenCountRow = element.querySelector('.study-route-branch-meta-row');
        if (hiddenCountRow) {
          var hidingHiddenCount = document.createElement('em');
          hidingHiddenCount.className = 'study-route-hidden-count is-hiding';
          hidingHiddenCount.textContent = options.hidingHiddenCountById.get(placement.id);
          hiddenCountRow.appendChild(hidingHiddenCount);
          window.setTimeout(function () {
            if (hidingHiddenCount.isConnected) hidingHiddenCount.remove();
          }, 210);
        }
      }
      if (!isNew) {
        var nextFill = element.querySelector('[data-route-progress-fill]');
        transitionFill(nextFill, nextFill ? Number(nextFill.dataset.progressTarget || 0) : 0, oldFillPercent);
        transitionTaskCheck(element.querySelector('.study-route-task-check'), oldCheckState);
      }
      if (placement.kind === 'branch' && placement.node && placement.node.color) {
        element.style.setProperty('--branch-color', placement.node.color);
        element.dataset.branchColor = placement.node.color;
      } else if (placement.kind === 'branch') {
        element.style.removeProperty('--branch-color');
        delete element.dataset.branchColor;
      }
      element.dataset.progress = String(Math.round(((placement.metrics || {}).progress || 0) * 100));
      if (wasBlocked && placement.availability && placement.availability.available && !prefersReduced) {
        element.classList.add('is-unlocking');
        window.setTimeout(function () { if (element.isConnected) element.classList.remove('is-unlocking'); }, 760);
      }
      if (isNew && !options.suppressEntrance) {
        window.setTimeout(function () {
          if (element.isConnected) element.classList.remove('is-entering', 'is-expanding');
        }, prefersReduced ? 0 : 420);
      }
    });
    settleNodeFills(created, !options.suppressProgressAnimation);
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
    var first = GoalTree.layout(state.tree, state.tasks, { collapsedIds: collapsedIds });
    var createdElements = syncNodeElements(first, options);
    var sizes = new Map();
    nodeElements.forEach(function (element, id) { sizes.set(id, { width: element.offsetWidth, height: element.offsetHeight }); });
    var next = GoalTree.layout(state.tree, state.tasks, { sizes: sizes, collapsedIds: collapsedIds });
    layout = next;
    scene.style.width = next.bounds.width + 'px'; scene.style.height = next.bounds.height + 'px';
    edgesHost.setAttribute('viewBox', '0 0 ' + next.bounds.width + ' ' + next.bounds.height);
    syncEdgeElements(next, options);
    if (options.preserveViewAnchor) preserveViewAnchor(previous, next, options.preserveViewAnchor);
    syncSummary(next.model.rootMetrics, !!previous && !options.suppressSummaryAnimation);
    var layoutDuration = options.animateLayout === false ? 0 : (Number(options.duration) || 320);
    animateLayout(previous, next, layoutDuration, null, !!options.expandEntrance);
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
    var nextButton = summary.querySelector('[data-route-action="next-task"]');
    if (!nextButton) {
      nextButton = document.createElement('button');
      nextButton.type = 'button'; nextButton.dataset.routeAction = 'next-task';
      nextButton.className = 'study-route-next'; nextButton.textContent = T('下一步');
      summary.appendChild(nextButton);
    }
    nextCandidates = GoalTree.nextTasks(layout ? layout.model : GoalTree.buildModel(state.tree, state.tasks));
    if (nextTaskIndex >= nextCandidates.length) nextTaskIndex = 0;
    nextButton.hidden = !nextCandidates.length;
    nextButton.disabled = !nextCandidates.length;
    copy.textContent = completed + ' / ' + metrics.count + ' ' + T('已完成');
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
  function focusNode(nodeId) {
    if (!layout || !nodeId) return;
    var placement = layout.nodes.find(function (item) { return item.id === nodeId; });
    if (!placement) return;
    var rect = viewport.getBoundingClientRect();
    setViewTarget({
      zoom: viewTarget.zoom,
      x: rect.width / 2 - (placement.x + placement.width / 2) * viewTarget.zoom,
      y: rect.height / 2 - placement.y * viewTarget.zoom,
    });
    var element = nodeElements.get(nodeId);
    if (element) {
      element.classList.remove('is-next-focus'); void element.offsetWidth;
      element.classList.add('is-next-focus');
      window.setTimeout(function () { if (element.isConnected) element.classList.remove('is-next-focus'); }, prefersReduced ? 0 : 900);
      element.focus({ preventScroll: true });
    }
  }
  function focusNextTask() {
    if (!layout || !nextCandidates.length) return;
    var node = nextCandidates[nextTaskIndex % nextCandidates.length];
    nextTaskIndex = (nextTaskIndex + 1) % nextCandidates.length;
    focusNode(node.id);
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
    var allowStage = anchor.dataset.kind !== 'task' || !simpleModeEnabled();
    openPopover(anchor, '<div class="study-route-menu">' + (allowStage ? '<button type="button" data-route-pop="new-branch">'
      + T(anchor.dataset.kind === 'task' ? '新建后续阶段' : '新建阶段') + '</button>' : '')
      + '<button type="button" data-route-pop="new-task">' + T('新建任务')
      + '</button><button type="button" data-route-pop="attach-task">' + T('选择已有任务') + '</button></div>');
  }
  function nodeMenu(anchor) {
    var anchorId = anchor.dataset.nodeId || '';
    if (!popover.hidden && popover.dataset.anchorId === anchorId) { closePopover(true); return; }
    var kind = anchor.dataset.kind;
    var model = layout && layout.model ? layout.model : GoalTree.buildModel(state.tree, state.tasks);
    var conditionCount = kind === 'root' ? 0 : GoalTree.requirementCount(model, anchor.dataset.nodeId);
    var simple = simpleModeEnabled();
    var menuTask = kind === 'task' ? findTask(anchor.dataset.taskId) : null;
    var unavailable = !!(menuTask && !(model.availability.get(anchor.dataset.nodeId) || { available: true }).available);
    var html = '<div class="study-route-menu"><button type="button" data-route-pop="rename">' + T('改名') + '</button>';
    if (kind === 'task') html += '<button type="button" data-route-pop="new-task">' + T('新建后续任务')
      + '</button>' + (simple ? '' : '<button type="button" data-route-pop="new-stage">' + T('新建后续阶段') + '</button>')
      + '<button type="button" data-route-pop="attach-task">' + T('接入已有任务')
      + '</button>' + (!simple || conditionCount ? '<button type="button" data-route-pop="requirements">' + T('解锁条件')
        + (conditionCount ? ' · ' + conditionCount : '') + '</button>' : '')
      + '<button type="button" data-route-pop="settings"' + (unavailable ? ' disabled' : '') + '>' + T('设置进度')
      + '</button><button type="button" class="is-danger" data-route-pop="detach">' + T('移出路线') + '</button>';
    else if (kind === 'branch') html += (!simple || conditionCount ? '<button type="button" data-route-pop="requirements">' + T('解锁条件')
      + (conditionCount ? ' · ' + conditionCount : '') + '</button>' : '')
      + '<button type="button" class="is-danger" data-route-pop="delete-branch">' + T('删除阶段') + '</button>';
    else if (kind === 'root') {
      html += '<button type="button" data-route-pop="collapse-complete">' + T('收起已完成阶段')
        + '</button><button type="button" data-route-pop="expand-all">' + T('全部展开') + '</button>';
      if (state.tree.id !== (state.trees[0] || {}).id) html += '<button type="button" class="is-danger" data-route-pop="delete-tree">' + T('删除目标树') + '</button>';
    }
    // 第一棵（最初）目标树永远不可删除：旧数据是 goal_legacy，全新安装是自动创建的「目标 1」
    html += '</div>';
    openPopover(anchor, html);
  }
  function formPopover(anchor, kind) {
    if (kind === 'settings' && !popover.hidden
        && popover.dataset.anchorId === (anchor.dataset.nodeId || '')
        && popover.querySelector('form[data-route-form="settings"]')) {
      closePopover(true);
      return;
    }
    var nodeId = anchor.dataset.nodeId;
    var node = nodeId === 'root' ? { title: state.tree.title, kind: 'root' }
      : state.tree.nodes.find(function (item) { return item.id === nodeId; });
    var task = node && node.kind === 'task' ? findTask(node.taskId) : null;
    if (kind === 'new-branch' || kind === 'new-stage') {
      return openPopover(anchor, '<form data-route-form="' + kind + '"><label>' + T('阶段名称')
        + '<input name="title" maxlength="160" required autofocus></label><button type="submit">' + T('添加阶段') + '</button></form>');
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
  function nodeTitle(nodeId) {
    var node = state.tree.nodes.find(function (item) { return item.id === nodeId; });
    if (!node) return T('未知节点');
    return node.kind === 'branch' ? node.title : ((findTask(node.taskId) || {}).title || T('未命名任务'));
  }
  function requirementDetail(link) {
    var trigger = link.trigger || { kind: 'complete' };
    if (trigger.kind !== 'milestone') return T('完成');
    var source = state.tree.nodes.find(function (node) { return node.id === link.from; });
    var task = source && source.kind === 'task' ? findTask(source.taskId) : null;
    var milestone = GoalTree.milestonesForTask(task).find(function (item) { return item.id === trigger.milestoneId; });
    return milestone ? T('达到任务点') + '「' + milestone.name + '」' : T('任务点');
  }
  function requirementRow(link, action, label) {
    return '<li><div><button type="button" class="study-route-source-link" data-route-pop="locate-source" data-source-node-id="'
      + escapeHtml(link.from) + '">' + escapeHtml(nodeTitle(link.from)) + '</button><small>' + escapeHtml(requirementDetail(link))
      + '</small></div><button type="button" data-route-pop="' + action + '" data-link-id="' + escapeHtml(link.id || '')
      + '">' + T(label) + '</button></li>';
  }
  function requirementsPopover(anchor) {
    var targetId = anchor.dataset.nodeId;
    var incoming = (state.tree.links || []).filter(function (link) { return link.type === 'requires' && link.to === targetId; });
    var primaryRows = incoming.filter(function (link) { return link.primary; }).map(function (link) {
      return requirementRow(link, 'clear-primary-requirement', '取消');
    }).join('');
    var extraRows = incoming.filter(function (link) { return !link.primary; }).map(function (link) {
      return requirementRow(link, 'remove-requirement', '移除');
    }).join('');
    var choices = [];
    var model = layout && layout.model ? layout.model : GoalTree.buildModel(state.tree, state.tasks);
    if (!simpleModeEnabled()) state.tree.nodes.forEach(function (node) {
      var completeTrigger = { kind: 'complete' };
      if (GoalTree.canAddRequirement(model, node.id, targetId, completeTrigger)) {
        choices.push('<option value="' + escapeHtml(node.id + '::complete') + '">' + escapeHtml(nodeTitle(node.id) + ' · ' + T('完成')) + '</option>');
      }
      if (node.kind === 'task') GoalTree.milestonesForTask(findTask(node.taskId)).forEach(function (milestone) {
        var trigger = { kind: 'milestone', milestoneId: milestone.id };
        if (!GoalTree.canAddRequirement(model, node.id, targetId, trigger)) return;
        choices.push('<option value="' + escapeHtml(node.id + '::milestone::' + milestone.id) + '">' + escapeHtml(nodeTitle(node.id) + ' · ' + milestone.name) + '</option>');
      });
    });
    return openPopover(anchor, '<div class="study-route-requirements"><strong>' + T('解锁条件') + '</strong>'
      + '<section><h4>' + T('主路线条件') + '</h4>' + (primaryRows ? '<ul>' + primaryRows + '</ul>' : '<p>' + T('无主路线条件') + '</p>') + '</section>'
      + '<section><h4>' + T('附加条件') + '</h4>' + (extraRows ? '<ul>' + extraRows + '</ul>' : '<p>' + T('无附加条件') + '</p>') + '</section>'
      + (choices.length ? '<form data-route-form="add-requirement"><label>' + T('添加解锁条件') + '<select name="source">' + choices.join('')
        + '</select></label><button type="submit">' + T('添加') + '</button><p data-role="route-form-error"></p></form>' : '') + '</div>');
  }
  function formatProgressNumber(value) {
    var rounded = Math.round(Number(value || 0) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }
  function progressBreakdownPopover(anchor) {
    if (!popover.hidden && popover.dataset.anchorId === (anchor.dataset.nodeId || '')
        && popover.querySelector('.study-route-progress-detail')) {
      closePopover(true);
      return;
    }
    var model = layout && layout.model ? layout.model : GoalTree.buildModel(state.tree, state.tasks);
    var detail = GoalTree.progressBreakdown(model, anchor.dataset.nodeId);
    var visibleRows = detail.rows.slice(0, 50).map(function (row) {
      var copy = row.done ? T('已完成') + ' · 100%'
        : row.target ? row.current + ' / ' + row.target + ' · ' + row.percent + '%'
          : T('未设置进度') + ' · 0%';
      return '<li><span data-user-content>' + escapeHtml(row.title) + '</span><small>' + escapeHtml(copy) + '</small></li>';
    }).join('');
    var sum = formatProgressNumber(detail.progressSum * 100);
    var formula = detail.count
      ? T('任务进度总和') + ' ' + sum + '% ÷ ' + detail.count + ' ' + T('项') + ' = ' + detail.percent + '%'
      : T('尚无参与统计的任务');
    return openPopover(anchor, '<div class="study-route-progress-detail"><strong>' + T('进度明细') + '</strong>'
      + (visibleRows ? '<ul>' + visibleRows + '</ul>' : '<p>' + T('尚无参与统计的任务') + '</p>')
      + (detail.rows.length > 50 ? '<p>' + T('仅展示前 50 项，公式仍按全部任务计算') + '</p>' : '')
      + '<p class="study-route-progress-formula">' + escapeHtml(formula) + '</p>'
      + '<p class="study-route-progress-note">' + T('阶段只汇总包含的任务；解锁关系不会改变进度归属。') + '</p></div>');
  }
  function blockersPopover(anchor) {
    var placement = layout && layout.nodes.find(function (item) { return item.id === anchor.dataset.nodeId; });
    var reasons = placement && placement.availability && placement.availability.reasons || [];
    var rows = reasons.map(function (reason) {
      var link = (state.tree.links || []).find(function (item) { return item.id === reason.linkId; });
      var copy = reason.kind === 'milestone' && link ? requirementDetail(link) : T('完成');
      return '<li><div><button type="button" class="study-route-source-link" data-route-pop="locate-source" data-source-node-id="'
        + escapeHtml(link && link.from || '') + '">' + escapeHtml(reason.title || T('未知节点')) + '</button><small>'
        + escapeHtml(copy) + (reason.inherited ? ' · ' + T('继承自所属阶段') : '') + '</small></div>'
        + (link ? '<button type="button" data-route-pop="manage-target-requirements" data-target-node-id="' + escapeHtml(link.to) + '">' + T('管理') + '</button>' : '')
        + '</li>';
    }).join('');
    return openPopover(anchor, '<div class="study-route-blockers"><strong>' + T('解锁条件') + '</strong><p>'
      + T('全部条件满足后才可推进。') + '</p><ul>' + rows + '</ul></div>');
  }
  function primaryLinkForAnchor(anchor) {
    var kind = anchor.dataset.kind, nodeId = anchor.dataset.nodeId;
    if (kind === 'root') return { from: null, type: 'contains', side: 'right' };
    if (kind === 'branch') return { from: nodeId, type: 'contains' };
    return { from: nodeId, type: 'requires', trigger: { kind: 'complete' } };
  }
  function pruneCollapsedIds() {
    var valid = new Set((state.tree.nodes || []).filter(function (node) { return node.kind === 'branch'; }).map(function (node) { return node.id; }));
    var changed = false;
    collapsedIds.forEach(function (id) { if (!valid.has(id)) { collapsedIds.delete(id); changed = true; } });
    if (changed) saveViewSoon();
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
      if (json.task) {
        var taskIndex = state.tasks.findIndex(function (task) { return task.id === json.task.id; });
        if (taskIndex >= 0) state.tasks[taskIndex] = json.task; else state.tasks.push(json.task);
      }
      if (sent.command === 'switch-tree') {
        if (options.optimistic) {
          // 乐观切换的 activeTreeId 与画布已由点击时的本地换树落地，响应只回收
          // 权威树列表；若响应抢先覆盖活动树，会与延后两帧的换树形成分叉窗口。
          if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        } else {
          state.activeTreeId = json.treeId || '';
          if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
          state.tree = activeTree(state.trees, state.activeTreeId) || state.tree;
        }
      } else if (sent.command === 'create-tree') {
        state.activeTreeId = json.treeId || '';
        if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        state.tree = activeTree(state.trees, state.activeTreeId) || state.tree;
        collapsedIds = new Set();
      } else if (sent.command === 'delete-tree') {
        state.activeTreeId = json.treeId || '';
        if (Array.isArray(json.goalTrees)) state.trees = json.goalTrees;
        else state.trees = state.trees.filter(function (item) { return item.id !== json.removedTreeId; });
        state.tree = activeTree(state.trees, state.activeTreeId) || state.tree;
        collapsedIds = new Set();
      } else {
        applyTreeSnapshot(json, treeAtRequest);
      }
      syncStudyCacheFromState();
      pruneCollapsedIds();
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
  var revealCleanupTimer = 0;
  function endTreeTransition() {
    scene.classList.remove('is-fading');
    // 切换淡入走零延迟（.is-revealing 规则）：把淡出后的黑屏停顿从 ~84ms 压到一帧；
    // 定时摘除，避免影响面板打开等其它淡入的 60ms 节奏。
    scene.classList.add('is-revealing');
    if (revealCleanupTimer) { clearTimeout(revealCleanupTimer); revealCleanupTimer = 0; }
    revealCleanupTimer = window.setTimeout(function () {
      revealCleanupTimer = 0;
      scene.classList.remove('is-revealing');
    }, 420);
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
  // ── 切树过渡（单画布）────────────────────────────────────
  // 数据切换与视觉切换分离：switchTree 负责乐观状态和失败回滚，本控制器只负责
  // “短退场 → 透明点换树 → 轻量入场”。位移跟随 rail 顺序，避免整屏飞行；所有
  // 动画都归属一个可取消句柄，关闭面板、连点和回滚不再分别清理 opacity/transform。
  var TREE_SWITCH_OUT_MS = 80;
  var TREE_SWITCH_IN_MS = 180;
  var TREE_SWITCH_EXIT_PX = 8;
  var TREE_SWITCH_ENTER_PX = 34;
  var treeSwitchMotion = null;
  var treeSwitchMotionId = 0;
  function finishTreeSwitchMotion(motion, completed) {
    if (!motion) return;
    var wasActive = treeSwitchMotion === motion;
    if (motion.frame) cancelAnimationFrame(motion.frame);
    motion.frame = 0;
    motion.cancelled = !completed;
    if (motion.resolveFinished) {
      motion.resolveFinished(!!completed);
      motion.resolveFinished = null;
    }
    if (!wasActive) return;
    treeSwitchMotion = null;
    // 先在 transition:none 的保护下恢复最终样式，再摘状态类，避免清理动作自己产生余波。
    scene.style.opacity = '';
    applyView();
    scene.classList.remove('is-tree-switching');
  }
  function cancelTreeSwitchMotion(motion) {
    finishTreeSwitchMotion(motion || treeSwitchMotion, false);
  }
  function requestTreeSwitchFrame(motion) {
    motion.frame = requestAnimationFrame(function (timestamp) { tickTreeSwitchMotion(motion, timestamp); });
  }
  function tickTreeSwitchMotion(motion, timestamp) {
    motion.frame = 0;
    if (!open || motion.cancelled || treeSwitchMotion !== motion) {
      finishTreeSwitchMotion(motion, false);
      return;
    }
    if (motion.startedAt == null) motion.startedAt = timestamp;
    var duration = motion.phase === 'out' ? TREE_SWITCH_OUT_MS : TREE_SWITCH_IN_MS;
    var p = Math.min(1, (timestamp - motion.startedAt) / duration);
    var eased = motion.phase === 'out' ? p * p : 1 - Math.pow(1 - p, 3);
    var offset = motion.phase === 'out'
      ? motion.direction * -TREE_SWITCH_EXIT_PX * eased
      : motion.direction * TREE_SWITCH_ENTER_PX * (1 - eased);
    scene.style.opacity = String(motion.phase === 'out' ? 1 - eased : eased);
    scene.style.transform = sceneTransform(offset);
    if (p < 1) {
      requestTreeSwitchFrame(motion);
      return;
    }
    if (motion.phase === 'out') {
      scene.style.opacity = '0';
      motion.swapped = motion.swap() !== false;
      if (!motion.swapped || !open) {
        finishTreeSwitchMotion(motion, false);
        return;
      }
      motion.phase = 'in';
      motion.startedAt = null;
      scene.style.transform = sceneTransform(motion.direction * TREE_SWITCH_ENTER_PX);
      requestTreeSwitchFrame(motion);
      return;
    }
    finishTreeSwitchMotion(motion, true);
  }
  function beginTreeSwitchMotion(swap, direction) {
    cancelTreeSwitchMotion();
    direction = direction < 0 ? -1 : 1;
    var motion = {
      id: ++treeSwitchMotionId,
      frame: 0,
      cancelled: false,
      swapped: false,
      phase: 'out',
      startedAt: null,
      direction: direction,
      swap: swap,
      resolveFinished: null,
      finished: null,
    };
    motion.finished = new Promise(function (resolve) { motion.resolveFinished = resolve; });
    treeSwitchMotion = motion;
    if (prefersReduced) {
      motion.swapped = swap() !== false;
      finishTreeSwitchMotion(motion, motion.swapped);
      return motion;
    }
    scene.classList.add('is-tree-switching');
    requestTreeSwitchFrame(motion);
    return motion;
  }
  function switchTree(treeId) {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    if (treeId === state.activeTreeId) return Promise.resolve(null);
    settleViewThenSave();
    var previousTreeId = state.activeTreeId;
    var requestId = routeRequestId;
    var previousTreeIndex = state.trees.findIndex(function (tree) { return tree.id === previousTreeId; });
    var targetTreeIndex = state.trees.findIndex(function (tree) { return tree.id === treeId; });
    var direction = targetTreeIndex < previousTreeIndex ? -1 : 1;
    var target = state.trees.find(function (tree) { return tree.id === treeId; });
    if (!target) {
      // 本地没有该树全量数据（快照陈旧）：退回淡出→等服务器回包→淡入。
      beginTreeTransition();
      return command({ command: 'switch-tree', treeId: treeId }).then(function () {
        if (!restoreView(state.activeTreeId)) fit(true);
        animateRootEntrance();
      }).finally(endTreeTransition);
    }
    // 乐观切换：/api/study 快照已带全部树的节点数据，落盘请求随点击即刻发出
    // （点过即算数，关面板不取消）；纪元在点击时推进，作废点击前在途的旧快照
    // （响应落地后 command 还会再推进一次，作废飞行期间取到的旧快照）。
    treeEpoch++;
    // 滑块抢跑：点击瞬间 rail 高亮与黑色滑块立刻开滑（与旧树淡出并行）；
    // 权威活动树状态仍在离屏点切换，落盘失败时随回退一起滑回。
    renderRail(treeId);
    var performSwap = function () {
      if (!open || requestId !== routeRequestId) return false;
      state.activeTreeId = treeId;
      state.tree = target;
      var restored = restoreView(treeId);
      // 切树保留进度条与顶部数字的细腻变化，但不把“已有节点”误演成刚刚创建；
      // 整棵树只由场景级过渡承载方向和位移，避免节点缩放与横移互相打架。
      render({ animateLayout: false, suppressEntrance: true });
      // 滑块已在点击时抢跑；若抢跑未发生才补一次 rail 同步（重建会掐断在途滑块动画）。
      var activeBtn = railList.querySelector('.study-route-rail-item.is-active');
      if (!activeBtn || activeBtn.dataset.routeTreeId !== treeId) renderRail();
      if (!restored) fit(true);
      return true;
    };
    var motion = beginTreeSwitchMotion(performSwap, direction);
    return command({ command: 'switch-tree', treeId: treeId }, { skipRender: true, optimistic: true }).catch(function (error) {
      if (requestId !== routeRequestId) throw error;
      // 落盘失败：若视觉已换过去，用同一个可取消控制器反向回退；若仍在退场，
      // 直接取消并恢复 rail。错误继续上抛，走 ignoreBusy 的规则。
      if (state.activeTreeId === treeId) {
        cancelTreeSwitchMotion(motion);
        settleViewThenSave();
        var previous = state.trees.find(function (tree) { return tree.id === previousTreeId; });
        var applyRevert = function () {
          if (!open || requestId !== routeRequestId) return false;
          state.activeTreeId = previousTreeId;
          if (previous) state.tree = previous;
          var restored = restoreView(previousTreeId);
          render({ animateLayout: false, suppressEntrance: true });
          renderRail();
          if (!restored) fit(true);
          return true;
        };
        beginTreeSwitchMotion(applyRevert, -direction);
      } else {
        cancelTreeSwitchMotion(motion);
        renderRail();
      }
      throw error;
    });
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
    return post('/api/study-task-update', Object.assign({ id: task.id, goalTreeId: state.activeTreeId }, patch)).then(function (json) {
      var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
      if (index >= 0) state.tasks[index] = json.task;
      applyTreeSnapshot(json, treeAtRequest);
      syncStudyCacheFromState();
      closePopover(false);
      render({ duration: 280, preserveViewAnchor: 'root' });
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
      return json;
    }).finally(function () { busy = false; });
  }
  function changeProgress(task, delta) {
    if (busy) return;
    busy = true;
    var treeAtRequest = state.activeTreeId;
    post('/api/study-task-progress', { id: task.id, delta: delta, goalTreeId: state.activeTreeId }).then(function (json) {
      var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
      if (index >= 0) state.tasks[index] = json.task;
      applyTreeSnapshot(json, treeAtRequest);
      syncStudyCacheFromState();
      render({ duration: 280, preserveViewAnchor: 'root' });
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
  var GUIDE_PAGES = [
    {
      title: '目标、阶段、任务与连线',
      body: '<p>目标是整棵路线；阶段用来收纳一组学习任务，本身没有手动进度。</p><ul><li>浅灰无箭头线：阶段“包含”任务。</li><li>深色箭头线：完成来源后，解锁下一项；虚线表示附加条件。</li></ul>',
    },
    {
      title: '进度怎样计算',
      body: '<p>所有任务等权：已完成是 100%；有总量时按“当前 ÷ 总量”；未设置总量且未完成是 0%。</p><p>阶段只平均它包含的任务，根目标平均整棵树中的唯一任务。点击阶段或根目标的进度文字，可以查看逐项公式。</p>',
    },
    {
      title: '解锁条件',
      body: '<p>一个节点有多个条件时采用 AND 规则：必须全部满足才可推进。主路线条件决定树的排版位置；附加条件只增加约束，不改变排版和进度归属。</p><p>被锁定的任务仍可改名、查看条件或移出路线，但不能完成或修改进度。</p>',
    },
    {
      title: '更快地编辑路线',
      body: '<p>拖动节点可调整主路线；“下一步”会依次定位当前可开始的任务；阶段可折叠，多棵目标树从左侧 Rail 切换。</p><p>起步页齿轮里的“精简目标树编辑”默认开启。关闭后，才显示新建后续阶段、添加解锁条件等高级入口；切换不会改动已有数据。</p>',
    },
  ];
  function renderGuidePage() {
    if (!guideCopy) return;
    var page = GUIDE_PAGES[guidePage] || GUIDE_PAGES[0];
    guideCopy.innerHTML = '<h4>' + T(page.title) + '</h4>' + page.body;
    guidePosition.textContent = (guidePage + 1) + ' / ' + GUIDE_PAGES.length;
    var previous = guide.querySelector('[data-route-action="help-prev"]');
    var next = guide.querySelector('[data-route-action="help-next"]');
    previous.disabled = guidePage === 0;
    next.disabled = guidePage === GUIDE_PAGES.length - 1;
  }
  function openGuide() {
    if (!guide) return;
    closePopover(false);
    guidePage = 0;
    renderGuidePage();
    guide.hidden = false;
    helpTrigger && helpTrigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () {
      guide.classList.add('is-visible');
      var close = guide.querySelector('[data-route-action="help-close"]:not(.study-route-guide-backdrop)');
      if (close) close.focus();
    });
  }
  function closeGuide() {
    if (!guide || guide.hidden) return;
    guide.classList.remove('is-visible');
    guide.hidden = true;
    helpTrigger && helpTrigger.setAttribute('aria-expanded', 'false');
    if (helpTrigger) helpTrigger.focus({ preventScroll: true });
  }
  function moveGuide(delta) {
    guidePage = Math.max(0, Math.min(GUIDE_PAGES.length - 1, guidePage + delta));
    renderGuidePage();
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
    var restored = restoreView(state.activeTreeId);
    render();
    renderRail();
    if (!restored) fit(true);
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
    var shared = window[STUDY_DATA_CACHE_KEY];
    if (shared && shared.tasks && shared !== studyCache) studyCache = shared;
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
        var restored = restoreView(state.activeTreeId);
        render();
        renderRail();
        if (!restored) fit(true);
      }).catch(function () {});
      return;
    }
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
    cancelCollapseMotion();
    if (pan) {
      try { viewport.releasePointerCapture(pan.id); } catch (error) {}
    }
    pan = null;
    viewport.classList.remove('is-panning');
    stopViewAnimation();
    stopPanInertia();
    cancelTreeSwitchMotion();  // 停在半途的切树过渡随面板一起失效，场景复位到当前树原位
    // 先停动画并把镜头钉到目标值，再落盘：保存的是用户意图的最终镜头，而不是缓动中间帧。
    view = Object.assign({}, viewTarget);
    applyView();
    flushViewSave();
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    if (summaryFrame) cancelAnimationFrame(summaryFrame);
    layoutFrame = 0;
    summaryFrame = 0;
    closePopover(false); closeConfirm(); closeGuide();
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
  function collapseVisibleDescendants(nodeId) {
    var descendants = new Set(), pending = [nodeId];
    while (pending.length) {
      var current = pending.pop();
      (layout && layout.edges || []).forEach(function (edge) {
        if (!edge.primary || edge.from !== current || descendants.has(edge.to)) return;
        descendants.add(edge.to);
        pending.push(edge.to);
      });
    }
    return descendants;
  }
  function cleanupCollapseMotion(motion) {
    if (!motion) return;
    motion.nodeIds.forEach(function (id) {
      var element = nodeElements.get(id);
      if (element) element.classList.remove('is-collapsing');
    });
    motion.edgeIds.forEach(function (id) {
      var path = edgeElements.get(id);
      if (path) path.classList.remove('is-collapsing');
    });
  }
  function cancelCollapseMotion() {
    if (!collapseMotion) return;
    window.clearTimeout(collapseMotion.timer);
    cleanupCollapseMotion(collapseMotion);
    collapseMotion = null;
  }
  function finishCollapseMotion() {
    if (!collapseMotion) return;
    var motion = collapseMotion;
    window.clearTimeout(motion.timer);
    cleanupCollapseMotion(motion);
    collapseMotion = null;
    collapsedIds.add(motion.nodeId);
    saveViewSoon();
    render({
      duration: 260,
      preserveViewAnchor: motion.nodeId,
      revealingHiddenCountIds: new Set([motion.nodeId]),
    });
  }
  function setCollapseControlExpanded(nodeId, expanded) {
    var element = nodeElements.get(nodeId);
    var control = element && element.querySelector('.study-route-collapse');
    if (!control) return;
    control.setAttribute('aria-expanded', String(!!expanded));
    control.setAttribute('aria-label', T(expanded ? '收起阶段' : '展开阶段'));
  }
  function toggleBranchCollapse(nodeId) {
    if (collapsedIds.has(nodeId)) {
      cancelCollapseMotion();
      var hidingHiddenCountById = new Map();
      var collapsedElement = nodeElements.get(nodeId);
      var hiddenCount = collapsedElement && collapsedElement.querySelector('.study-route-hidden-count');
      if (hiddenCount && !prefersReduced) hidingHiddenCountById.set(nodeId, hiddenCount.textContent || '');
      collapsedIds.delete(nodeId);
      saveViewSoon();
      render({
        duration: 260,
        preserveViewAnchor: nodeId,
        expandEntrance: true,
        expandingControlIds: new Set([nodeId]),
        hidingHiddenCountById: hidingHiddenCountById,
      });
      return;
    }
    if (collapseMotion && collapseMotion.nodeId === nodeId) {
      cancelCollapseMotion();
      setCollapseControlExpanded(nodeId, true);
      return;
    }
    if (prefersReduced) {
      collapsedIds.add(nodeId);
      saveViewSoon();
      render({ duration: 0, preserveViewAnchor: nodeId });
      return;
    }
    if (collapseMotion) {
      finishCollapseMotion();
    }
    setCollapseControlExpanded(nodeId, false);
    var nodeIds = collapseVisibleDescendants(nodeId);
    var edgeIds = new Set();
    (layout && layout.edges || []).forEach(function (edge) {
      if (nodeIds.has(edge.from) || nodeIds.has(edge.to)) edgeIds.add(edgeKey(edge));
    });
    nodeIds.forEach(function (id) {
      var element = nodeElements.get(id);
      if (element) element.classList.add('is-collapsing');
    });
    edgeIds.forEach(function (id) {
      var path = edgeElements.get(id);
      if (path) path.classList.add('is-collapsing');
    });
    collapseMotion = { nodeId: nodeId, nodeIds: nodeIds, edgeIds: edgeIds, timer: 0 };
    collapseMotion.timer = window.setTimeout(finishCollapseMotion, 190);
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
      if (action === 'next-task') return focusNextTask();
      if (action === 'help') return openGuide();
      if (action === 'help-close') return closeGuide();
      if (action === 'help-prev') return moveGuide(-1);
      if (action === 'help-next') return moveGuide(1);
      if (action === 'confirm-cancel') return closeConfirm();
      if (action === 'confirm-ok') {
        var pending = confirmAction; closeConfirm(); if (pending) Promise.resolve(pending()).catch(ignoreBusy); return;
      }
      var anchor = actionControl.closest('.study-route-node');
      if (!anchor) return;
      if (action === 'add') return addMenu(anchor);
      if (action === 'menu') return nodeMenu(anchor);
      if (action === 'progress-breakdown') return progressBreakdownPopover(anchor);
      if (action === 'blockers') return blockersPopover(anchor);
      if (action === 'collapse') {
        toggleBranchCollapse(anchor.dataset.nodeId); return;
      }
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
    if (['new-branch', 'new-stage', 'new-task', 'attach-task', 'rename', 'settings'].includes(action)) return formPopover(anchor, action);
    if (action === 'requirements') return requirementsPopover(anchor);
    if (action === 'locate-source') {
      var sourceNodeId = control.dataset.sourceNodeId;
      closePopover(false);
      focusNode(sourceNodeId);
      return;
    }
    if (action === 'manage-target-requirements') {
      var targetAnchor = nodesHost.querySelector('[data-node-id="' + CSS.escape(control.dataset.targetNodeId || '') + '"]');
      if (targetAnchor) requirementsPopover(targetAnchor);
      return;
    }
    if (action === 'clear-primary-requirement') {
      return command({ command: 'clear-primary-requirement', nodeId: anchor.dataset.nodeId }).catch(showError);
    }
    if (action === 'remove-requirement') {
      return command({ command: 'remove-requirement', linkId: control.dataset.linkId }).catch(showError);
    }
    if (action === 'collapse-complete') {
      var model = GoalTree.buildModel(state.tree, state.tasks);
      state.tree.nodes.forEach(function (node) {
        if (node.kind === 'branch' && (model.metrics.get(node.id) || {}).complete) collapsedIds.add(node.id);
      });
      saveViewSoon(); closePopover(false); render({ duration: 260, preserveViewAnchor: 'root' }); return;
    }
    if (action === 'expand-all') {
      var expandingControlIds = new Set(collapsedIds);
      var hidingHiddenCountById = new Map();
      if (!prefersReduced) collapsedIds.forEach(function (nodeId) {
        var element = nodeElements.get(nodeId);
        var hiddenCount = element && element.querySelector('.study-route-hidden-count');
        if (hiddenCount) hidingHiddenCountById.set(nodeId, hiddenCount.textContent || '');
      });
      collapsedIds.clear(); saveViewSoon(); closePopover(false);
      render({
        duration: 260,
        preserveViewAnchor: 'root',
        expandEntrance: true,
        expandingControlIds: expandingControlIds,
        hidingHiddenCountById: hidingHiddenCountById,
      }); return;
    }
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
      return openConfirm(T('删除这个阶段？'), T('整个阶段会从路线移除，其中的学习任务仍保留在学习页。'), function () {
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
    var nodeId = anchor.dataset.nodeId, primaryLink = primaryLinkForAnchor(anchor);
    if (kind === 'new-branch' || kind === 'new-stage') return command({ command: 'create-branch', primaryLink: primaryLink, title: values.get('title') }).catch(showError);
    if (kind === 'new-task') return command({ command: 'create-task', primaryLink: primaryLink, title: values.get('title'), target: values.get('target') }).catch(showError);
    if (kind === 'attach-task') return command({ command: 'attach-task', primaryLink: primaryLink, taskId: values.get('taskId') }).catch(showError);
    if (kind === 'add-requirement') {
      var parts = String(values.get('source') || '').split('::');
      var trigger = parts[1] === 'milestone' ? { kind: 'milestone', milestoneId: parts[2] } : { kind: 'complete' };
      return command({ command: 'add-requirement', fromNodeId: parts[0], toNodeId: nodeId, trigger: trigger }).catch(showError);
    }
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
    drag.baseTree = {
      version: 2, id: state.tree.id, title: state.tree.title,
      nodes: state.tree.nodes.map(function (node) { return Object.assign({}, node); }),
      links: (state.tree.links || []).map(function (link) {
        return Object.assign({}, link, link.trigger ? { trigger: Object.assign({}, link.trigger) } : {});
      }),
    };
    drag.baseLayout = Object.assign({}, layout, {
      nodes: layout.nodes.map(function (placement) { return Object.assign({}, visualPlacements.get(placement.id) || placement); }),
    });
    drag.dropContext = GoalTree.prepareDropContext(drag.baseLayout, drag.baseTree, drag.nodeId);
    drag.dragIds = new Set(drag.dropContext.structuralExcluded || []);
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
      var path = edgeElements.get(edgeKey(edge));
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
    if (candidate && simpleModeEnabled() && drag.source.dataset.kind === 'branch'
        && candidate.primaryLink && candidate.primaryLink.type === 'requires') candidate = null;
    var candidateKey = candidate
      ? [candidate.type, candidate.targetId, candidate.parentId, candidate.beforeId,
        candidate.side, candidate.primaryLink && candidate.primaryLink.type,
        candidate.primaryLink && candidate.primaryLink.trigger && candidate.primaryLink.trigger.kind,
        candidate.primaryLink && candidate.primaryLink.trigger && candidate.primaryLink.trigger.milestoneId].join('|') : '';
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
        ? GoalTree.previewMove(current.baseTree, current.nodeId, current.candidate.primaryLink) : null;
      if (preview) {
        state.tree = preview; render({ duration: 260, preserveViewAnchor: 'root' });
        command({
          command: 'move-node', nodeId: current.nodeId, primaryLink: current.candidate.primaryLink,
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
    if (!guide.hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault(); moveGuide(event.key === 'ArrowLeft' ? -1 : 1); return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!guide.hidden) closeGuide();
    else if (!confirmBox.hidden) closeConfirm();
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
  window.addEventListener('relatum:goal-tree-simple-mode-change', function () {
    if (open) closePopover(false);
  });
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

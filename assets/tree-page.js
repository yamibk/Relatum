(function () {
  'use strict';

  var GoalTree = window.RelatumStudyGoalTree;
  var overlay = document.querySelector('[data-role="tree-page-view"]');
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
  var guideReturnTrigger = null;
  var stageEl = overlay.querySelector('.study-route-stage');
  var T = function (value) { return window.RelatumI18n ? window.RelatumI18n.t(value) : value; };
  var state = { tasks: [], tree: { version: 2, title: '树 1', nodes: [], links: [] }, trees: [], activeTreeId: '' };
  var open = false, busy = false, layout = null, confirmAction = null;
  var progressCommandQueue = [], progressCommandContext = null;
  var appearanceCommandQueue = [], appearanceCommandContext = null;
  var collapsedIds = new Set(), nextTaskIndex = 0, nextCandidates = [];
  var guidePage = 0;
  var routeRequestId = 0, routeCloseTimer = 0, routeCloseAnimationHandler = null;
  var routeReturnFocus = null;
  // 树命令纪元：切/建/删树时递增。后台 /api/tree-page 快照若取自纪元变化之前
  // （即切树前），落地时必须丢弃，否则会把刚完成的切换静默回退。
  var treeEpoch = 0;
  var popoverCloseTimer = 0, popoverSwapTimer = 0, popoverMotionId = 0;
  var confirmCloseTimer = 0, confirmMotionId = 0;
  var view = { x: 42, y: 42, zoom: 1 };
  var viewTarget = Object.assign({}, view), viewTickAt = 0;
  var viewportSize = { width: 0, height: 0 };
  var pan = null, drag = null, dragEndedAt = 0, pointerDownInPopover = false;
  var collapseMotion = null;
  var nodeElements = new Map(), edgeElements = new Map(), visualPlacements = new Map();
  var layoutFrame = 0, summaryFrame = 0, rootProgressFrame = 0, viewFrame = 0, panInertiaFrame = 0, dragFrame = 0;
  var dropSlot = null, reparentBadge = null, viewSaveTimer = 0;
  var GOAL_TREE_ROUTE_VIEW_KEY = 'relatum.tree-page.view';
  var legacyViewClaimed = false;
  var STUDY_DATA_CACHE_KEY = '_relatumTreePageData';
  var GOAL_TREE_SIMPLE_KEY = 'canvas:studyGoalTreeSimpleMode:v1';
  var studyCache = null, studyPrefetchId = 0, studyPrefetchPromise = null;
  var treePagePreloadHandle = 0, treePagePreloadUsesIdle = false;
  var treeGoalBreathTimer = 0;
  var replayCleanupTimers = new WeakMap();
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
  function replayClass(element, className, cleanupMs) {
    if (!element || prefersReduced) return;
    var cleanupByClass = replayCleanupTimers.get(element) || new Map();
    window.clearTimeout(cleanupByClass.get(className));
    cleanupByClass.delete(className);
    replayCleanupTimers.set(element, cleanupByClass);
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
    if (Number(cleanupMs) > 0) {
      cleanupByClass.set(className, window.setTimeout(function () {
        element.classList.remove(className);
        cleanupByClass.delete(className);
        if (cleanupByClass.size === 0) replayCleanupTimers.delete(element);
      }, Number(cleanupMs)));
    }
  }
  function cancelReplayClass(element, className) {
    if (!element) return;
    var cleanupByClass = replayCleanupTimers.get(element);
    if (cleanupByClass) {
      window.clearTimeout(cleanupByClass.get(className));
      cleanupByClass.delete(className);
      if (cleanupByClass.size === 0) replayCleanupTimers.delete(element);
    }
    element.classList.remove(className);
  }
  function stopTreeGoalBreath() {
    window.clearTimeout(treeGoalBreathTimer);
    treeGoalBreathTimer = 0;
    nodesHost.querySelectorAll('.study-route-node.is-goal-breathing').forEach(function (node) {
      cancelReplayClass(node, 'is-goal-breathing');
    });
  }
  function visibleTreeGoalNodes() {
    return Array.prototype.filter.call(nodesHost.querySelectorAll(
      '.study-route-node:is(.is-task, .is-root).is-goal-ready:not(.is-goal-pending):not(.is-goal-celebrating)'
    ), function (node) {
      var rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    });
  }
  function scheduleTreeGoalBreath(delay) {
    window.clearTimeout(treeGoalBreathTimer);
    treeGoalBreathTimer = 0;
    if (prefersReduced || !open || document.hidden) return;
    treeGoalBreathTimer = window.setTimeout(function () {
      treeGoalBreathTimer = 0;
      if (prefersReduced || !open || document.hidden) return;
      visibleTreeGoalNodes().forEach(function (node) {
        replayClass(node, 'is-goal-breathing', 2540);
      });
      scheduleTreeGoalBreath(2800);
    }, Math.max(0, Number(delay) || 1400));
  }
  function activeTree(trees, treeId) {
    return (trees || []).find(function (tree) { return tree.id === treeId; }) || (trees || [])[0] || null;
  }
  function applyTreePayloadInitial(json) {
    var trees = Array.isArray(json.goalTrees) ? json.goalTrees : [];
    state.trees = trees;
    state.activeTreeId = json.activeTreeId || (trees.length ? trees[0].id : '');
    state.tree = activeTree(trees, state.activeTreeId) || { version: 2, title: '树 1', nodes: [], links: [] };
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
      version: 2,
      tasks: state.tasks,
      goalTrees: state.trees,
      activeTreeId: state.activeTreeId,
    });
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
      var primaryChildren = GoalTree.primaryChildren(state.tree);
      var validBranches = new Set((state.tree.nodes || []).filter(function (node) {
        return node.kind === 'branch' && (primaryChildren.get(node.id) || []).length > 0;
      }).map(function (node) { return node.id; }));
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
  function readViewportSize() {
    var rect = viewport.getBoundingClientRect();
    return { width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
  }
  function preserveViewOnResize() {
    if (!open) return;
    closePopover(false);
    var next = readViewportSize();
    if (!next.width || !next.height) return;
    if (viewportSize.width && viewportSize.height) {
      var deltaX = (next.width - viewportSize.width) / 2;
      var deltaY = (next.height - viewportSize.height) / 2;
      if (Math.abs(deltaX) > .01 || Math.abs(deltaY) > .01) {
        view.x += deltaX;
        view.y += deltaY;
        viewTarget.x += deltaX;
        viewTarget.y += deltaY;
        if (pan) {
          pan.ox += deltaX;
          pan.oy += deltaY;
        }
        applyView();
        saveViewSoon();
      }
    }
    viewportSize = next;
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
    var children = GoalTree.primaryChildren(state.tree).get(placement.id) || [];
    var hasChildren = children.length > 0;
    var showCollapse = placement.kind === 'branch' || hasChildren;
    var collapse = showCollapse ? '<button type="button" class="study-route-collapse" data-route-action="collapse" aria-expanded="'
      + (hasChildren ? !placement.collapsed : true) + '" aria-label="' + (hasChildren && placement.collapsed ? T('展开阶段') : T('收起阶段')) + '"'
      + (!hasChildren ? ' disabled aria-disabled="true"' : '') + '><span aria-hidden="true"></span></button>' : '';
    var hidden = hasChildren && placement.collapsed ? '<em class="study-route-hidden-count">' + placement.hiddenCount + ' ' + T('项已隐藏') + '</em>' : '';
    var heading = placement.kind === 'root'
      ? '<strong class="tree-page-root-progress" aria-label="' + percent + '%">' + percent + '%</strong>'
      : '<strong data-user-content>' + escapeHtml(placement.node.title) + '</strong>';
    var progressBar = placement.kind === 'root'
      ? '<span class="study-progress-track-shell tree-page-root-progress-track"><span class="study-progress-track'
        + (metrics.count > 0 && percent >= 100 ? ' is-full' : '')
        + '" role="progressbar" aria-label="' + escapeHtml(T('根节点进度'))
        + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent
        + '" aria-valuetext="' + percent + '%"><span class="study-progress-fill" data-route-progress-fill'
        + ' data-progress-target="' + percent + '" style="width:' + percent + '%"></span></span></span>'
      : '<i aria-hidden="true"><b data-route-progress-fill data-progress-target="' + percent
        + '" style="width:' + percent + '%"></b></i>';
    return '<div class="study-route-branch-main">' + heading
      + '<span class="study-route-branch-meta-row"><button type="button" class="study-route-node-meta" data-role="route-node-meta" data-route-action="progress-breakdown">'
      + percent + '% · ' + metrics.count + ' ' + T('项任务') + '</button>'
      + hidden + '</span>' + progressBar + '</div>'
      + '<span class="study-route-node-actions">' + collapse + '<button type="button" data-route-action="add" aria-label="'
      + T('添加') + '">＋</button><button type="button" data-route-action="menu" aria-label="'
      + T('更多') + '">⋯</button></span>';
  }
  var BRANCH_COLORS = window.RelatumStudyPalette && window.RelatumStudyPalette.COLORS
    ? window.RelatumStudyPalette.COLORS
    : [{ value: '', label: '默认' }];
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
  var TREE_PAGE_SHAPES = [
    { value: 'rounded', label: '圆角卡' },
    { value: 'rectangle', label: '矩形' },
    { value: 'pill', label: '胶囊' },
    { value: 'diamond', label: '菱形' },
    { value: 'circle', label: '圆形' },
  ];
  function appearancePaletteHTML(currentColor, currentShape) {
    currentShape = String(currentShape || 'rounded');
    var shapeButtons = TREE_PAGE_SHAPES.map(function (item) {
      return '<button type="button" class="tree-page-shape-choice tree-page-shape-' + item.value
        + (item.value === currentShape ? ' is-active' : '') + '" data-route-pop="set-shape" data-shape="'
        + item.value + '" aria-label="' + T(item.label) + '"><i aria-hidden="true"></i><span>'
        + T(item.label) + '</span></button>';
    }).join('');
    return '<div class="tree-page-appearance-panel"><div class="tree-page-appearance-colors">'
      + colorPaletteHTML(currentColor) + '</div><div class="tree-page-appearance-shapes">'
      + shapeButtons + '</div></div>';
  }
  function nodeAppearance(anchor) {
    if (!anchor) return { color: '', shape: 'rounded' };
    if (anchor.dataset.kind === 'root') return {
      color: state.tree.color || '', shape: state.tree.shape || 'rounded',
    };
    var node = state.tree.nodes.find(function (item) { return item.id === anchor.dataset.nodeId; }) || {};
    if (anchor.dataset.kind === 'task') {
      var task = findTask(node.taskId) || {};
      return { color: task.color || '', shape: task.shape || 'rounded' };
    }
    return { color: node.color || '', shape: node.shape || 'rounded' };
  }
  function taskMarkup(placement) {
    var task = findTask(placement.node.taskId) || { title: T('已移除任务'), status: 'done', progress: {} };
    var progress = taskProgress(task), done = task.status === 'done';
    var lockedByConditions = placement.availability && !placement.availability.available;
    var blocked = !done && lockedByConditions;
    var ready = !done && progress.target > 0 && progress.current >= progress.target;
    var controls = progress.target
      ? (done
        ? '<span class="study-route-task-steps is-placeholder" aria-hidden="true"></span>'
        : '<span class="study-route-task-steps"><button type="button" data-route-action="progress" data-delta="-1" aria-label="进度减一"'
          + (blocked || progress.current <= 0 ? ' disabled' : '') + '>−</button><button type="button" data-route-action="progress" data-delta="1" aria-label="进度加一"'
          + (blocked || progress.current >= progress.target ? ' disabled' : '') + '>＋</button></span>')
      : '';
    var value = progress.target ? progress.current + ' / ' + progress.target : '';
    var width = progress.target
      ? Math.min(100, progress.current / progress.target * 100).toFixed(2)
      : '0.00';
    var completionScale = (Number(width) / 100).toFixed(4);
    var atTarget = progress.target > 0 && progress.current >= progress.target;
    var progressBar = progress.target
      ? '<span class="study-progress-track-shell tree-page-task-progress"><span class="study-progress-track'
        + (atTarget ? ' is-full' : '') + '" role="progressbar" aria-label="' + escapeHtml(T('任务进度'))
        + '" aria-valuemin="0" aria-valuemax="' + progress.target + '" aria-valuenow="' + progress.current
        + '" aria-valuetext="' + escapeHtml(atTarget ? T('目标已达成，可以手动标记完成') : value)
        + '"><span class="study-progress-fill" data-route-progress-fill data-progress-target="' + width
        + '" style="width:' + width + '%"></span><span class="study-progress-fill tree-page-task-completion-fill"'
        + ' aria-hidden="true" data-completion-start-scale="' + completionScale
        + '" style="--tree-page-completion-start-scale:' + completionScale + '"></span></span></span>'
      : '';
    var progressValueMarkup = progress.target
      ? '<button type="button" class="study-route-task-value" data-route-action="settings"'
        + (lockedByConditions ? ' disabled' : '') + '>' + escapeHtml(value) + '</button>'
      : '';
    var taskLine = progressValueMarkup
      ? '<span class="study-route-task-line">' + progressValueMarkup + '</span>'
      : '';
    return '<button type="button" class="study-route-task-check' + (done ? ' is-done' : '') + (ready ? ' is-ready' : '')
      + '" data-route-action="complete"' + (blocked ? ' disabled' : '') + ' aria-label="' + (done ? T('恢复为未完成') : T('标记完成')) + '"><span>✓</span></button>'
      + '<div class="study-route-task-main"><strong data-user-content>' + escapeHtml(task.title || T('未命名任务'))
      + '</strong>' + taskLine
      + progressBar + '</div>'
      + controls + '<button type="button" class="study-route-node-menu" data-route-action="menu" aria-label="' + T('更多') + '">⋯</button>';
  }
  function syncExistingTaskMarkup(element, placement) {
    var template = document.createElement('div');
    template.innerHTML = taskMarkup(placement);
    var currentMain = element.querySelector('.study-route-task-main');
    var nextMain = template.querySelector('.study-route-task-main');
    if (!currentMain || !nextMain) return false;

    var currentTitle = currentMain.querySelector('strong');
    var nextTitle = nextMain.querySelector('strong');
    if (currentTitle && nextTitle) currentTitle.textContent = nextTitle.textContent;

    var currentShell = currentMain.querySelector('.tree-page-task-progress');
    var nextShell = nextMain.querySelector('.tree-page-task-progress');
    var currentLine = currentMain.querySelector('.study-route-task-line');
    var nextLine = nextMain.querySelector('.study-route-task-line');
    if (currentLine && nextLine) currentLine.replaceWith(nextLine);
    else if (currentLine) currentLine.remove();
    else if (nextLine) currentMain.insertBefore(nextLine, currentShell || null);

    if (currentShell && nextShell) {
      var currentTrack = currentShell.querySelector('.study-progress-track');
      var nextTrack = nextShell.querySelector('.study-progress-track');
      var currentFill = currentShell.querySelector('[data-route-progress-fill]');
      var nextFill = nextShell.querySelector('[data-route-progress-fill]');
      if (currentTrack && nextTrack && currentFill && nextFill) {
        // 这里与学习任务 syncStudyProgressBar 一样：进度条始终在 DOM 中，
        // 只切换满值状态与同一根 fill 的 width，让 CSS transition 从当前插值继续。
        currentTrack.classList.toggle('is-full', nextTrack.classList.contains('is-full'));
        ['aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].forEach(function (name) {
          var value = nextTrack.getAttribute(name);
          if (value == null) currentTrack.removeAttribute(name);
          else currentTrack.setAttribute(name, value);
        });
        currentFill.dataset.progressTarget = nextFill.dataset.progressTarget;
        currentFill.style.width = nextFill.style.width;
      }
      var currentCompletionFill = currentShell.querySelector('.tree-page-task-completion-fill');
      var nextCompletionFill = nextShell.querySelector('.tree-page-task-completion-fill');
      if (currentCompletionFill && nextCompletionFill) {
        var completionScale = nextCompletionFill.dataset.completionStartScale || '0';
        currentCompletionFill.dataset.completionStartScale = completionScale;
        currentCompletionFill.style.setProperty('--tree-page-completion-start-scale', completionScale);
      } else if (currentCompletionFill) {
        currentCompletionFill.remove();
      } else if (nextCompletionFill && currentTrack) {
        currentTrack.appendChild(nextCompletionFill);
      }
    } else if (currentShell) {
      currentShell.remove();
    } else if (nextShell) {
      currentMain.appendChild(nextShell);
    }

    var currentCheck = element.querySelector('.study-route-task-check');
    var nextCheck = template.querySelector('.study-route-task-check');
    if (currentCheck && nextCheck) currentCheck.replaceWith(nextCheck);

    var currentSteps = element.querySelector('.study-route-task-steps');
    var nextSteps = template.querySelector('.study-route-task-steps');
    var currentMenu = element.querySelector('.study-route-node-menu');
    if (currentSteps && nextSteps) currentSteps.replaceWith(nextSteps);
    else if (currentSteps) currentSteps.remove();
    else if (nextSteps) element.insertBefore(nextSteps, currentMenu || null);

    var nextMenu = template.querySelector('.study-route-node-menu');
    if (currentMenu && nextMenu) currentMenu.replaceWith(nextMenu);
    return true;
  }
  function syncRootProgressHeading(currentHeading, nextHeading) {
    var nextText = nextHeading.textContent || '0%';
    var percent = Number(nextText.replace('%', ''));
    currentHeading.setAttribute('aria-label', nextHeading.getAttribute('aria-label') || nextText);
    if (rootProgressFrame) cancelAnimationFrame(rootProgressFrame);
    rootProgressFrame = 0;
    if (!Number.isFinite(percent)) {
      currentHeading.textContent = nextText;
      delete currentHeading.dataset.value;
      return;
    }
    var from = Number(currentHeading.dataset.value);
    if (!Number.isFinite(from)) from = Number((currentHeading.textContent || '').replace('%', ''));
    if (!Number.isFinite(from)) from = percent;
    if (prefersReduced || Math.abs(percent - from) < .1) {
      currentHeading.textContent = Math.round(percent) + '%';
      currentHeading.dataset.value = String(percent);
      return;
    }
    var started = performance.now();
    function frame(now) {
      if (!currentHeading.isConnected) { rootProgressFrame = 0; return; }
      var t = Math.min(1, (now - started) / 520), eased = 1 - Math.pow(1 - t, 3);
      var value = from + (percent - from) * eased;
      currentHeading.textContent = Math.round(value) + '%';
      currentHeading.dataset.value = String(value);
      if (t < 1) rootProgressFrame = requestAnimationFrame(frame);
      else {
        rootProgressFrame = 0;
        currentHeading.textContent = Math.round(percent) + '%';
        currentHeading.dataset.value = String(percent);
      }
    }
    rootProgressFrame = requestAnimationFrame(frame);
  }
  function syncExistingRootMarkup(element, placement) {
    var template = document.createElement('div');
    template.innerHTML = branchMarkup(placement);
    var currentMain = element.querySelector('.study-route-branch-main');
    var nextMain = template.querySelector('.study-route-branch-main');
    if (!currentMain || !nextMain) return false;

    var currentHeading = currentMain.querySelector('.tree-page-root-progress');
    var nextHeading = nextMain.querySelector('.tree-page-root-progress');
    if (currentHeading && nextHeading) {
      syncRootProgressHeading(currentHeading, nextHeading);
    }
    var currentMeta = currentMain.querySelector('.study-route-branch-meta-row');
    var nextMeta = nextMain.querySelector('.study-route-branch-meta-row');
    if (currentMeta && nextMeta) currentMeta.replaceWith(nextMeta);

    var currentShell = currentMain.querySelector('.tree-page-root-progress-track');
    var nextShell = nextMain.querySelector('.tree-page-root-progress-track');
    if (currentShell && nextShell) {
      var currentTrack = currentShell.querySelector('.study-progress-track');
      var nextTrack = nextShell.querySelector('.study-progress-track');
      var currentFill = currentShell.querySelector('.study-progress-fill');
      var nextFill = nextShell.querySelector('.study-progress-fill');
      if (currentTrack && nextTrack && currentFill && nextFill) {
        currentTrack.classList.toggle('is-full', nextTrack.classList.contains('is-full'));
        ['aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].forEach(function (name) {
          var value = nextTrack.getAttribute(name);
          if (value == null) currentTrack.removeAttribute(name);
          else currentTrack.setAttribute(name, value);
        });
        currentFill.dataset.progressTarget = nextFill.dataset.progressTarget;
        currentFill.style.width = nextFill.style.width;
      }
    } else if (nextShell) {
      var legacyTrack = currentMain.querySelector(':scope > i');
      if (legacyTrack) legacyTrack.remove();
      currentMain.appendChild(nextShell);
    }

    var currentActions = element.querySelector('.study-route-node-actions');
    var nextActions = template.querySelector('.study-route-node-actions');
    if (currentActions && nextActions) currentActions.replaceWith(nextActions);
    return true;
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
  function appearanceForPlacement(placement) {
    if (!placement) return { color: '', shape: 'rounded' };
    if (placement.kind === 'root') return {
      color: String(state.tree.color || ''), shape: String(state.tree.shape || 'rounded'),
    };
    if (placement.kind === 'task') {
      var task = findTask(placement.node.taskId) || {};
      return { color: String(task.color || ''), shape: String(task.shape || 'rounded') };
    }
    return {
      color: String((placement.node && placement.node.color) || ''),
      shape: String((placement.node && placement.node.shape) || 'rounded'),
    };
  }
  function preserveTreeExtensions(source, target) {
    source = source || {};
    target = target || {};
    target.shape = source.shape || 'rounded';
    target.color = source.color || '';
    var shapes = new Map((source.nodes || []).filter(function (node) { return node.kind === 'branch'; })
      .map(function (node) { return [node.id, node.shape || 'rounded']; }));
    (target.nodes || []).forEach(function (node) {
      if (node.kind === 'branch') node.shape = shapes.get(node.id) || 'rounded';
    });
    return target;
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
      var wasExistingTask = !!element && element.dataset.kind === 'task';
      var wasExistingRoot = !!element && element.dataset.kind === 'root';
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
      var oldGoalState = element ? {
        ready: element.classList.contains('is-goal-ready'),
        pending: element.classList.contains('is-goal-pending'),
        celebrating: element.classList.contains('is-goal-celebrating'),
        breathing: element.classList.contains('is-goal-breathing'),
      } : { ready: false, pending: false, celebrating: false, breathing: false };
      var oldCompletionCelebrating = !!element && element.classList.contains('is-completion-celebrating');
      if (!element) {
        element = document.createElement('article');
        element.setAttribute('role', 'treeitem'); element.tabIndex = 0;
        nodesHost.appendChild(element); nodeElements.set(placement.id, element); created.push(element);
      }
      var isExpansionEntrance = isNew && options.expandEntrance && !prefersReduced;
      var appearance = appearanceForPlacement(placement);
      var taskForGoal = placement.kind === 'task' ? findTask(placement.node.taskId) : null;
      var taskGoalProgress = taskProgress(taskForGoal);
      var isGoalReady = !!(
        (taskForGoal && taskForGoal.status !== 'done' && taskGoalProgress.target > 0
          && taskGoalProgress.current >= taskGoalProgress.target)
        || (placement.kind === 'root' && (placement.metrics || {}).count > 0
          && (placement.metrics || {}).progress >= .999999)
      );
      element.className = 'study-route-node is-' + placement.kind + ' tree-page-shape-' + appearance.shape
        + (isComplete ? ' is-complete' : '')
        + (isBlocked ? ' is-blocked' : '')
        + (placement.kind === 'task' && !(placement.metrics || {}).complete && placement.availability && placement.availability.available ? ' is-ready' : '')
        + (isGoalReady ? ' is-goal-ready' : '')
        + (isGoalReady && oldGoalState.pending ? ' is-goal-pending' : '')
        + (isGoalReady && oldGoalState.celebrating ? ' is-goal-celebrating' : '')
        + (isGoalReady && oldGoalState.breathing ? ' is-goal-breathing' : '')
        + (isComplete && oldCompletionCelebrating ? ' is-completion-celebrating' : '')
        + (placement.collapsed ? ' is-collapsed' : '')
        + (isExpansionEntrance ? ' is-expanding' : '')
        + (isNew && !isExpansionEntrance && !options.suppressEntrance && !prefersReduced
          && !isComplete && !isBlocked ? ' is-entering' : '');
      element.dataset.nodeId = placement.id; element.dataset.kind = placement.kind;
      element.removeAttribute('data-tooltip');
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
      var taskMarkupSynced = !isNew && wasExistingTask && placement.kind === 'task'
        && syncExistingTaskMarkup(element, placement);
      var rootMarkupSynced = !isNew && wasExistingRoot && placement.kind === 'root'
        && syncExistingRootMarkup(element, placement);
      if (!taskMarkupSynced && !rootMarkupSynced) element.innerHTML = nodeMarkup(placement);
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
        var nextFillPercent = nextFill ? Number(nextFill.dataset.progressTarget || 0) : 0;
        if (!taskMarkupSynced && !rootMarkupSynced) {
          transitionFill(nextFill, nextFillPercent, oldFillPercent);
        }
        var nextCheck = element.querySelector('.study-route-task-check');
        transitionTaskCheck(nextCheck, oldCheckState);
        var nextCheckDone = !!nextCheck && nextCheck.classList.contains('is-done');
        if (oldCheckState && !oldCheckState.done && nextCheckDone && !prefersReduced) {
          cancelReplayClass(element, 'is-goal-breathing');
          cancelReplayClass(element, 'is-goal-celebrating');
          replayClass(element, 'is-completion-celebrating', 1480);
        } else if (oldCheckState && oldCheckState.done && !nextCheckDone) {
          cancelReplayClass(element, 'is-completion-celebrating');
        }
      }
      var routeNodeColor = placement.kind === 'root'
        ? String(state.tree.color || '')
        : (placement.kind === 'branch'
        ? (placement.node && placement.node.color) || ''
        : (placement.kind === 'task'
          ? ((findTask(placement.node.taskId) || {}).color) || ''
          : ''));
      if (routeNodeColor) {
        element.style.setProperty('--branch-color', routeNodeColor);
        element.dataset.branchColor = routeNodeColor;
      } else if (placement.kind === 'root' || placement.kind === 'branch' || placement.kind === 'task') {
        element.style.removeProperty('--branch-color');
        delete element.dataset.branchColor;
      }
      element.dataset.progress = String(Math.round(((placement.metrics || {}).progress || 0) * 100));
      if (placement.kind === 'root' && isGoalReady && !oldGoalState.ready && !isNew && !prefersReduced) {
        cancelReplayClass(element, 'is-goal-breathing');
        replayClass(element, 'is-goal-celebrating', 1480);
        scheduleTreeGoalBreath(1560);
      } else if (placement.kind === 'root' && !isGoalReady && oldGoalState.ready) {
        cancelReplayClass(element, 'is-goal-breathing');
        cancelReplayClass(element, 'is-goal-celebrating');
      }
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
    state.tree = preserveTreeExtensions(state.tree, GoalTree.normalizeTree(state.tree, state.tasks));
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
    nextCandidates = GoalTree.nextTasks(layout ? layout.model : GoalTree.buildModel(state.tree, state.tasks));
    if (nextTaskIndex >= nextCandidates.length) nextTaskIndex = 0;
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
    openPopover(anchor, '<div class="study-route-menu"><button type="button" data-route-pop="new-branch">'
      + T(anchor.dataset.kind === 'task' ? '新建后续阶段' : '新建阶段') + '</button>'
      + '<button type="button" data-route-pop="new-task">' + T('新建任务') + '</button></div>');
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
    if (kind === 'task') html += '<button type="button" data-route-pop="color">' + T('颜色')
      + '</button><button type="button" data-route-pop="new-task">' + T('新建后续任务')
      + '</button><button type="button" data-route-pop="new-stage">' + T('新建后续阶段') + '</button>'
      + (!simple ? '<button type="button" data-route-pop="requirements">' + T('解锁条件')
        + (conditionCount ? ' · ' + conditionCount : '') + '</button>' : '')
      + '<button type="button" data-route-pop="settings"' + (unavailable ? ' disabled' : '') + '>' + T('设置进度')
      + '</button><button type="button" class="is-danger" data-route-pop="delete-task">' + T('删除任务') + '</button>';
    else if (kind === 'branch') html += (!simple ? '<button type="button" data-route-pop="requirements">' + T('解锁条件')
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
  function primaryLinkForAnchor(anchor) {
    var kind = anchor.dataset.kind, nodeId = anchor.dataset.nodeId;
    if (kind === 'root') return { from: null, type: 'contains', side: 'right' };
    if (kind === 'branch') return { from: nodeId, type: 'contains' };
    return { from: nodeId, type: 'requires', trigger: { kind: 'complete' } };
  }
  function pruneCollapsedIds() {
    var primaryChildren = GoalTree.primaryChildren(state.tree);
    var valid = new Set((state.tree.nodes || []).filter(function (node) {
      return node.kind === 'branch' && (primaryChildren.get(node.id) || []).length > 0;
    }).map(function (node) { return node.id; }));
    var changed = false;
    collapsedIds.forEach(function (id) { if (!valid.has(id)) { collapsedIds.delete(id); changed = true; } });
    if (changed) saveViewSoon();
  }
  function createClientId(prefix) {
    var token = '';
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        token = window.crypto.randomUUID().replace(/-/g, '');
      }
    } catch (error) {}
    if (!token) token = Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
    return prefix + token;
  }
  function cloneOptimisticValue(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function optimisticPrimaryLink(primary, nodeId, linkId) {
    primary = primary && typeof primary === 'object' ? primary : {};
    var sourceId = String(primary.from || '').trim() || null;
    var type = sourceId ? (primary.type || 'contains') : 'contains';
    var link = {
      id: linkId,
      from: sourceId,
      to: nodeId,
      type: type,
      primary: true,
      order: 999999,
    };
    if (!sourceId) link.side = primary.side === 'left' ? 'left' : 'right';
    if (type === 'requires') link.trigger = Object.assign({}, primary.trigger || { kind: 'complete' });
    return link;
  }
  function createOptimistically(body) {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    var requestGeneration = routeRequestId;
    var rollback = {
      tasks: cloneOptimisticValue(state.tasks),
      trees: cloneOptimisticValue(state.trees),
      tree: cloneOptimisticValue(state.tree),
    };
    var sent = Object.assign({}, body, {
      clientNodeId: createClientId('goal_node_'),
      clientLinkId: createClientId('goal_link_'),
    });
    if (sent.command === 'create-task') sent.clientTaskId = createClientId('tree_task_');

    var tree = cloneOptimisticValue(state.tree);
    var node;
    if (sent.command === 'create-task') {
      var target = Number(sent.target || 0);
      var now = new Date().toISOString();
      state.tasks = state.tasks.slice();
      state.tasks.push({
        id: sent.clientTaskId,
        title: String(sent.title || '').trim() || T('未命名任务'),
        color: '',
        status: 'active',
        taskPage: 1,
        progress: { current: 0, target: Number.isInteger(target) && target >= 0 ? target : 0, milestones: [] },
        createdAt: now,
        updatedAt: now,
        completedAt: '',
        shape: 'rounded',
      });
      node = { id: sent.clientNodeId, kind: 'task', taskId: sent.clientTaskId };
    } else {
      node = {
        id: sent.clientNodeId,
        kind: 'branch',
        title: String(sent.title || '').trim() || T('未命名阶段'),
        shape: 'rounded',
      };
    }
    tree.nodes = (tree.nodes || []).concat(node);
    tree.links = (tree.links || []).concat(optimisticPrimaryLink(sent.primaryLink, sent.clientNodeId, sent.clientLinkId));
    state.tree = tree;
    state.trees = state.trees.map(function (item) { return item.id === tree.id ? tree : item; });
    syncStudyCacheFromState();
    closePopover(false, true);
    render({ duration: 320 });

    return command(sent).catch(function (error) {
      if (requestGeneration === routeRequestId) {
        state.tasks = rollback.tasks;
        state.trees = rollback.trees;
        state.tree = rollback.tree;
        syncStudyCacheFromState();
        render({ duration: 220 });
        renderRail();
      }
      throw error;
    });
  }
  function deleteTaskOptimistically(taskId) {
    if (busy) return Promise.reject(new Error(T('请稍候')));
    taskId = String(taskId || '').trim();
    var requestGeneration = routeRequestId;
    var rollback = {
      tasks: cloneOptimisticValue(state.tasks),
      trees: cloneOptimisticValue(state.trees),
      tree: cloneOptimisticValue(state.tree),
    };
    var tree = cloneOptimisticValue(state.tree);
    var owner = (tree.nodes || []).find(function (node) {
      return node.kind === 'task' && node.taskId === taskId;
    });
    if (!owner) return Promise.reject(new Error(T('没有找到这个任务')));

    // 对齐后端 _study_goal_detach_task：删掉任务节点时，它的主路线子项
    // 接到原父级，并清理与该节点相关的附加依赖。
    var incoming = (tree.links || []).find(function (link) {
      return link.primary && link.to === owner.id;
    });
    if (!incoming) return Promise.reject(new Error(T('任务结构不完整')));
    var children = (tree.links || []).filter(function (link) {
      return link.primary && link.from === owner.id;
    }).sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
    var childIds = new Set(children.map(function (link) { return link.id; }));
    children.forEach(function (child, offset) {
      child.from = incoming.from || null;
      child.type = incoming.type;
      child.order = Number(incoming.order || 0) + offset;
      if (incoming.type === 'requires') child.trigger = Object.assign({}, incoming.trigger || { kind: 'complete' });
      else delete child.trigger;
      if (!incoming.from) child.side = incoming.side === 'left' ? 'left' : 'right';
      else delete child.side;
    });
    tree.nodes = (tree.nodes || []).filter(function (node) { return node.id !== owner.id; });
    tree.links = (tree.links || []).filter(function (link) {
      return childIds.has(link.id) || (link.from !== owner.id && link.to !== owner.id);
    });
    state.tasks = state.tasks.filter(function (task) { return task.id !== taskId; });
    state.tree = tree;
    state.trees = state.trees.map(function (item) { return item.id === tree.id ? tree : item; });
    syncStudyCacheFromState();
    closePopover(false, true);
    render({ duration: 320, preserveViewAnchor: incoming.from || 'root', suppressEntrance: true });

    return command({ command: 'delete-task', taskId: taskId }).catch(function (error) {
      if (requestGeneration === routeRequestId) {
        state.tasks = rollback.tasks;
        state.trees = rollback.trees;
        state.tree = rollback.tree;
        syncStudyCacheFromState();
        render({ duration: 220, suppressEntrance: true });
        renderRail();
      }
      throw error;
    });
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
    var requestId = routeRequestId;
    var server = post('/api/tree-page-command', sent);
    return server.then(function (json) {
      // 响应落地前面板已关闭或重开（代际变化）：不再碰状态与 DOM，
      // 避免旧响应向隐藏 overlay 重建整棵树、或覆盖重开后新树的渲染；下次打开会全量拉取。
      if (requestId !== routeRequestId) return json;
      // 树级命令成功落地才推进纪元，此后在途的旧 /api/tree-page 快照全部失效。
      if (sent.command === 'switch-tree' || sent.command === 'create-tree' || sent.command === 'delete-tree') {
        treeEpoch++;
      }
      if (Array.isArray(json.tasks)) {
        state.tasks = json.tasks;
      } else if (json.task) {
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
    // 乐观切换：/api/tree-page 快照已带全部树的节点数据，落盘请求随点击即刻发出
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
    options = options || {};
    busy = true;
    var treeAtRequest = state.activeTreeId;
    var requestGeneration = routeRequestId;
    var rollback = null;
    if (options.optimistic) {
      rollback = {
        tasks: cloneOptimisticValue(state.tasks),
        trees: cloneOptimisticValue(state.trees),
        tree: cloneOptimisticValue(state.tree),
      };
      state.tasks = state.tasks.map(function (item) {
        if (item.id !== task.id) return item;
        var next = Object.assign({}, item, cloneOptimisticValue(patch));
        if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
          next.completedAt = patch.status === 'done' ? (item.completedAt || new Date().toISOString()) : '';
        }
        return next;
      });
      syncStudyCacheFromState();
      closePopover(false);
      render({ duration: 280, preserveViewAnchor: 'root', suppressEntrance: true });
    }
    return post('/api/tree-page-command', Object.assign({
      command: 'update-task', taskId: task.id, treeId: state.activeTreeId,
    }, patch)).then(function (json) {
      if (requestGeneration !== routeRequestId) return json;
      if (Array.isArray(json.tasks)) state.tasks = json.tasks;
      else {
        var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
        if (index >= 0) state.tasks[index] = json.task;
      }
      applyTreeSnapshot(json, treeAtRequest);
      syncStudyCacheFromState();
      closePopover(false);
      if (!options.optimistic) render({ duration: 280, preserveViewAnchor: 'root' });
      return json;
    }).catch(function (error) {
      if (rollback && requestGeneration === routeRequestId) {
        state.tasks = rollback.tasks;
        state.trees = rollback.trees;
        state.tree = rollback.tree;
        syncStudyCacheFromState();
        render({ duration: 220, preserveViewAnchor: 'root', suppressEntrance: true });
      }
      throw error;
    }).finally(function () { busy = false; });
  }
  function applyProgressCommandPayload(json, context) {
    if (Array.isArray(json.tasks)) {
      state.tasks = json.tasks;
    } else if (json.task) {
      state.tasks = state.tasks.map(function (item) { return item.id === json.task.id ? json.task : item; });
    }
    applyTreeSnapshot(json, context.treeId);
    syncStudyCacheFromState();
    render({ duration: 180, preserveViewAnchor: 'root', suppressEntrance: true });
  }
  function finishProgressCommands(error) {
    var context = progressCommandContext;
    progressCommandQueue = [];
    progressCommandContext = null;
    busy = false;
    if (!context) return;
    var authority = context.lastJson;
    if (context.requestId === routeRequestId) {
      if (authority) applyProgressCommandPayload(authority, context);
      else if (error) {
        state.tasks = context.rollback.tasks;
        state.trees = context.rollback.trees;
        state.tree = context.rollback.tree;
        syncStudyCacheFromState();
        render({ duration: 180, preserveViewAnchor: 'root', suppressEntrance: true });
      }
      context.pendingTaskIds.forEach(function (taskId) {
        var node = nodesHost.querySelector('[data-task-id="' + CSS.escape(taskId) + '"]');
        if (node) node.classList.remove('is-goal-pending');
      });
      if (!error) context.reachedTaskIds.forEach(function (taskId) {
        var task = findTask(taskId);
        var progress = taskProgress(task);
        if (!task || task.status === 'done' || !progress.target || progress.current < progress.target) return;
        var node = nodesHost.querySelector('[data-task-id="' + CSS.escape(taskId) + '"]');
        if (!node) return;
        cancelReplayClass(node, 'is-goal-breathing');
        replayClass(node, 'is-goal-celebrating', 1480);
      });
      if (!error && context.reachedTaskIds.size) scheduleTreeGoalBreath(1560);
      if (error) showError(error);
      return;
    }
    // 翻页后不再碰隐藏页的 DOM，但保留最后一份权威快照，
    // 避免下次打开先闪回未提交的乐观数值。
    if (authority) {
      studyCache = authority;
      window[STUDY_DATA_CACHE_KEY] = authority;
    } else if (error) {
      studyCache = null;
      window[STUDY_DATA_CACHE_KEY] = null;
    }
  }
  function drainProgressCommands() {
    var context = progressCommandContext;
    if (!context || context.sending) return;
    var item = progressCommandQueue.shift();
    if (!item) { finishProgressCommands(); return; }
    context.sending = true;
    post('/api/tree-page-command', {
      command: 'progress-task', taskId: item.taskId, delta: item.delta, treeId: context.treeId,
    }).then(function (json) {
      if (context !== progressCommandContext) return;
      context.sending = false;
      context.lastJson = json;
      drainProgressCommands();
    }).catch(function (error) {
      if (context !== progressCommandContext) return;
      context.sending = false;
      finishProgressCommands(error);
    });
  }
  function changeProgress(task, delta) {
    delta = Number(delta);
    if (delta !== -1 && delta !== 1) return;
    var joiningQueue = !!progressCommandContext;
    if (busy && !joiningQueue) return;
    if (joiningQueue && (progressCommandContext.treeId !== state.activeTreeId
      || progressCommandContext.requestId !== routeRequestId)) return;
    var latest = findTask(task && task.id);
    if (!latest || latest.status === 'done') return;
    var progress = taskProgress(latest);
    if (!progress.target) return;
    var nextCurrent = Math.max(0, Math.min(progress.target, progress.current + delta));
    if (nextCurrent === progress.current) return;

    if (!joiningQueue) {
      progressCommandContext = {
        treeId: state.activeTreeId,
        requestId: routeRequestId,
        sending: false,
        lastJson: null,
        pendingTaskIds: new Set(),
        reachedTaskIds: new Set(),
        rollback: {
          tasks: cloneOptimisticValue(state.tasks),
          trees: cloneOptimisticValue(state.trees),
          tree: cloneOptimisticValue(state.tree),
        },
      };
      busy = true;
    }
    var taskNode = nodesHost.querySelector('[data-task-id="' + CSS.escape(latest.id) + '"]');
    if (progress.current < progress.target && nextCurrent >= progress.target) {
      progressCommandContext.pendingTaskIds.add(latest.id);
      progressCommandContext.reachedTaskIds.add(latest.id);
      if (taskNode && !prefersReduced) {
        cancelReplayClass(taskNode, 'is-goal-breathing');
        taskNode.classList.add('is-goal-pending');
      }
    } else if (progress.current >= progress.target && nextCurrent < progress.target) {
      progressCommandContext.pendingTaskIds.delete(latest.id);
      progressCommandContext.reachedTaskIds.delete(latest.id);
      if (taskNode) {
        cancelReplayClass(taskNode, 'is-goal-breathing');
        cancelReplayClass(taskNode, 'is-goal-celebrating');
        taskNode.classList.remove('is-goal-pending');
      }
    }
    var updated = Object.assign({}, latest, {
      progress: Object.assign({}, latest.progress || {}, { current: nextCurrent }),
    });
    state.tasks = state.tasks.map(function (item) { return item.id === updated.id ? updated : item; });
    syncStudyCacheFromState();
    render({ duration: 180, preserveViewAnchor: 'root', suppressEntrance: true });
    progressCommandQueue.push({ taskId: updated.id, delta: delta });
    drainProgressCommands();
  }
  function applyAppearanceCommandPayload(json, context) {
    if (Array.isArray(json.tasks)) {
      state.tasks = json.tasks;
    } else if (json.task) {
      state.tasks = state.tasks.map(function (item) { return item.id === json.task.id ? json.task : item; });
    }
    applyTreeSnapshot(json, context.treeId);
    syncStudyCacheFromState();
    closePopover(false);
    render({ duration: 220, preserveViewAnchor: context.anchorId || 'root', suppressEntrance: true });
  }
  function finishAppearanceCommands(error) {
    var context = appearanceCommandContext;
    appearanceCommandQueue = [];
    appearanceCommandContext = null;
    busy = false;
    if (!context) return;
    var authority = context.lastJson;
    if (context.requestId === routeRequestId) {
      if (authority) applyAppearanceCommandPayload(authority, context);
      else if (error) {
        state.tasks = context.rollback.tasks;
        state.trees = context.rollback.trees;
        state.tree = context.rollback.tree;
        syncStudyCacheFromState();
        render({ duration: 220, preserveViewAnchor: context.anchorId || 'root', suppressEntrance: true });
      }
      if (error) showError(error);
      return;
    }
    if (authority) {
      studyCache = authority;
      window[STUDY_DATA_CACHE_KEY] = authority;
    } else if (error) {
      studyCache = null;
      window[STUDY_DATA_CACHE_KEY] = null;
    }
  }
  function drainAppearanceCommands() {
    var context = appearanceCommandContext;
    if (!context || context.sending) return;
    var item = appearanceCommandQueue.shift();
    if (!item) { finishAppearanceCommands(); return; }
    context.sending = true;
    post('/api/tree-page-command', item.body).then(function (json) {
      if (context !== appearanceCommandContext) return;
      context.sending = false;
      context.lastJson = json;
      drainAppearanceCommands();
    }).catch(function (error) {
      if (context !== appearanceCommandContext) return;
      context.sending = false;
      finishAppearanceCommands(error);
    });
  }
  function syncAppearancePaletteSelection(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
      var color = String(patch.color || '');
      popover.querySelectorAll('[data-route-pop="set-color"]').forEach(function (control) {
        control.classList.toggle('is-active', String(control.dataset.color || '') === color);
      });
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'shape')) {
      var shape = String(patch.shape || 'rounded');
      popover.querySelectorAll('[data-route-pop="set-shape"]').forEach(function (control) {
        control.classList.toggle('is-active', String(control.dataset.shape || 'rounded') === shape);
      });
    }
  }
  function updateAppearanceOptimistically(anchor, patch) {
    if (!anchor || !patch) return;
    var joiningQueue = !!appearanceCommandContext;
    if (busy && !joiningQueue) return;
    if (joiningQueue && (appearanceCommandContext.treeId !== state.activeTreeId
      || appearanceCommandContext.requestId !== routeRequestId)) return;
    var kind = anchor.dataset.kind;
    var nodeId = anchor.dataset.nodeId;
    var taskId = anchor.dataset.taskId;
    var body = { treeId: state.activeTreeId };
    var tree = cloneOptimisticValue(state.tree);
    if (kind === 'root') {
      body.command = 'update-root-appearance';
      if (Object.prototype.hasOwnProperty.call(patch, 'color')) tree.color = patch.color;
      if (Object.prototype.hasOwnProperty.call(patch, 'shape')) tree.shape = patch.shape;
    } else if (kind === 'task') {
      var task = findTask(taskId);
      if (!task) return;
      body.command = 'update-task';
      body.taskId = taskId;
      var updatedTask = Object.assign({}, task, patch);
      state.tasks = state.tasks.map(function (item) { return item.id === taskId ? updatedTask : item; });
    } else {
      var branch = (tree.nodes || []).find(function (node) { return node.id === nodeId && node.kind === 'branch'; });
      if (!branch) return;
      body.command = 'update-branch';
      body.nodeId = nodeId;
      Object.assign(branch, patch);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'color')) body.color = patch.color;
    if (Object.prototype.hasOwnProperty.call(patch, 'shape')) body.shape = patch.shape;

    if (!joiningQueue) {
      appearanceCommandContext = {
        treeId: state.activeTreeId,
        requestId: routeRequestId,
        anchorId: nodeId,
        sending: false,
        lastJson: null,
        rollback: {
          tasks: cloneOptimisticValue(state.tasks),
          trees: cloneOptimisticValue(state.trees),
          tree: cloneOptimisticValue(state.tree),
        },
      };
      // 任务外观已在上方修改，回滚快照需要还原修改前的任务。
      if (kind === 'task') appearanceCommandContext.rollback.tasks = appearanceCommandContext.rollback.tasks.map(function (item) {
        return item.id === taskId ? cloneOptimisticValue(task) : item;
      });
      busy = true;
    }
    if (kind !== 'task') {
      state.tree = tree;
      state.trees = state.trees.map(function (item) { return item.id === tree.id ? tree : item; });
    }
    appearanceCommandContext.anchorId = nodeId;
    syncStudyCacheFromState();
    syncAppearancePaletteSelection(patch);
    render({ duration: 220, preserveViewAnchor: nodeId || 'root', suppressEntrance: true });
    var liveAnchor = nodeElements.get(nodeId);
    if (liveAnchor && !popover.hidden) {
      positionPopover(liveAnchor);
      window.setTimeout(function () {
        var currentAnchor = nodeElements.get(nodeId);
        if (currentAnchor && !popover.hidden && popover.dataset.anchorId === nodeId) positionPopover(currentAnchor);
      }, prefersReduced ? 0 : 230);
    }
    appearanceCommandQueue.push({ body: body });
    drainAppearanceCommands();
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
      title: '一分钟开始使用',
      body: '<p>树状页最重要的用途，是把任务排成一条看得见的路线。</p><ul><li>点击根节点或阶段右侧的“＋”新建任务。</li><li>这里的任务只属于当前树状页，不与学习页联动。</li><li>先放入当前真正要做的任务，不必一开始就规划完整棵树。</li></ul>',
    },
    {
      title: '推进与整理',
      body: '<p>任务会根据阶段与解锁条件提示当前是否可以开始。</p><ul><li>点击任务圆点，可以完成或恢复任务。</li><li>有数量目标时，用“− / ＋”推进；“设置进度”可修改当前值和总量。</li><li>拖动卡片可调整路线；阶段右上角的箭头可收起或展开内容。</li></ul>',
    },
    {
      title: '阶段与进度',
      body: '<p>阶段只是一组任务的收纳夹，不需要手动设置进度。</p><ul><li>已完成任务记为 100%；有总量时按“当前 ÷ 总量”；未设总量且未完成时记为 0%。</li><li>阶段平均它收纳的任务，根目标平均整棵树中的任务。</li><li>点击进度文字可查看每项任务和计算公式；需要另一套路线时，从左侧编号栏新建目标树。</li></ul>',
    },
    {
      title: '箭头、解锁与高级编辑',
      body: '<p>只有需要“做完 A 才能做 B”时，才需要关心解锁条件。</p><ul><li>浅灰无箭头线表示“收纳在某阶段”；深色箭头线表示“完成后解锁下一项”。</li><li>虚线是附加条件；有多个条件时，必须全部满足才能推进。</li><li>被锁定的任务可改名、查看条件或删除，但不能修改进度。</li><li>如需添加附加解锁条件，请在起步页齿轮中关闭“精简目标树编辑”；这不会修改已有路线。</li></ul>',
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
  function openGuide(trigger) {
    if (!guide) return;
    guideReturnTrigger = trigger || guideReturnTrigger;
    closePopover(false);
    guidePage = 0;
    renderGuidePage();
    guide.hidden = false;
    guideReturnTrigger && guideReturnTrigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () {
      guide.classList.add('is-visible');
      var close = guide.querySelector('[data-route-action="help-close"]:not(.study-route-guide-backdrop)');
      if (close) close.focus();
    });
  }
  function closeGuide(restoreFocus) {
    if (!guide || guide.hidden) return;
    guide.classList.remove('is-visible');
    guide.hidden = true;
    if (guideReturnTrigger) guideReturnTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus !== false && guideReturnTrigger && guideReturnTrigger.isConnected) {
      guideReturnTrigger.focus({ preventScroll: true });
    }
    guideReturnTrigger = null;
  }
  function moveGuide(delta) {
    guidePage = Math.max(0, Math.min(GUIDE_PAGES.length - 1, guidePage + delta));
    renderGuidePage();
  }
  function showOverlay() {
    if (open) return;
    cancelRouteCloseWait();
    overlay.classList.remove('is-visible', 'is-closing');
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.dataset.active = '1';
    open = true;
    scene.classList.add('is-loading');
    endTreeTransition();
    void overlay.offsetWidth;
    overlay.classList.add('is-visible');
    viewportSize = readViewportSize();
  }
  function cancelRouteCloseWait() {
    if (routeCloseTimer) clearTimeout(routeCloseTimer);
    routeCloseTimer = 0;
    if (routeCloseAnimationHandler) {
      overlay.removeEventListener('animationend', routeCloseAnimationHandler);
      routeCloseAnimationHandler = null;
    }
  }
  function finishRouteCloseVisuals() {
    cancelRouteCloseWait();
    if (open) return;
    nodesHost.innerHTML = '';
    edgesHost.innerHTML = '';
    nodeElements.clear();
    edgeElements.clear();
    visualPlacements.clear();
    layout = null;
    overlay.hidden = true;
    overlay.classList.remove('is-visible', 'is-closing');
  }
  function focusRequestedTask(requestId, taskId) {
    requestAnimationFrame(function () {
      if (!open || requestId !== routeRequestId) return;
      var owner = taskId && GoalTree.taskOwner(state.tree, taskId);
      var target = owner && nodesHost.querySelector('[data-node-id="' + CSS.escape(owner.node.id) + '"]');
      if (guide.hidden) (target || viewport).focus();
    });
  }
  function applyStudyPayload(json, requestId, taskId, requestedTreeId) {
    if (requestId !== routeRequestId) return;
    state.tasks = Array.isArray(json.tasks) ? json.tasks : [];
    applyTreePayloadInitial(json);
    scene.classList.remove('is-loading');
    var restored = restoreView(state.activeTreeId);
    render();
    renderRail();
    scheduleTreeGoalBreath(1400);
    if (!restored) fit(true);
    var requestedTree = requestedTreeId && state.trees.find(function (tree) { return tree.id === requestedTreeId; });
    if (!requestedTree && taskId && !GoalTree.taskOwner(state.tree, taskId)) {
      requestedTree = state.trees.find(function (tree) { return !!GoalTree.taskOwner(tree, taskId); });
    }
    if (requestedTree && requestedTree.id !== state.activeTreeId) {
      switchTree(requestedTree.id).then(function () {
        focusRequestedTask(requestId, taskId);
      }).catch(ignoreBusy);
      return;
    }
    focusRequestedTask(requestId, taskId);
  }
  function ensureTreePageData() {
    if (studyCache) return Promise.resolve(studyCache);
    if (studyPrefetchPromise) return studyPrefetchPromise;
    var id = ++studyPrefetchId;
    var promise = api('/api/tree-page').then(function (json) {
      if (id !== studyPrefetchId) return studyCache || json;
      studyCache = json;
      window[STUDY_DATA_CACHE_KEY] = json;
      return json;
    });
    studyPrefetchPromise = promise;
    promise.finally(function () {
      if (studyPrefetchPromise === promise) studyPrefetchPromise = null;
    }).catch(function () {});
    return promise;
  }
  function prefetchStudyData() {
    return ensureTreePageData().then(function () { return true; });
  }
  function cancelTreePagePreload() {
    if (!treePagePreloadHandle) return;
    if (treePagePreloadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(treePagePreloadHandle);
    } else {
      window.clearTimeout(treePagePreloadHandle);
    }
    treePagePreloadHandle = 0;
    treePagePreloadUsesIdle = false;
  }
  function scheduleTreePagePreload() {
    if (treePagePreloadHandle || studyCache || studyPrefetchPromise) return;
    var warmTreePage = function () {
      treePagePreloadHandle = 0;
      treePagePreloadUsesIdle = false;
      prefetchStudyData().catch(function () {});
    };
    treePagePreloadUsesIdle = typeof window.requestIdleCallback === 'function';
    treePagePreloadHandle = treePagePreloadUsesIdle
      ? window.requestIdleCallback(warmTreePage, { timeout: 1500 })
      : window.setTimeout(warmTreePage, 600);
  }
  function loadTreePageForOpen(epoch, requestId, taskId, requestedTreeId, allowRetry) {
    ensureTreePageData().then(function (json) {
      if (epoch !== treeEpoch) return;
      applyStudyPayload(json, requestId, taskId, requestedTreeId);
    }).catch(function (err) {
      if (allowRetry && open && requestId === routeRequestId && !studyCache) {
        loadTreePageForOpen(epoch, requestId, taskId, requestedTreeId, false);
        return;
      }
      if (requestId !== routeRequestId) return;
      scene.classList.remove('is-loading');
      showError(err);
    });
  }
  function openRoute(trigger, taskId, requestedTreeId) {
    var requestId = ++routeRequestId;
    cancelTreePagePreload();
    if (trigger && typeof trigger.focus === 'function') routeReturnFocus = trigger;
    showOverlay();
    var shared = window[STUDY_DATA_CACHE_KEY];
    if (shared && shared.tasks && shared !== studyCache) studyCache = shared;
    if (studyCache && studyCache.tasks) {
      var epoch = treeEpoch;
      applyStudyPayload(studyCache, requestId, taskId, requestedTreeId);
      api('/api/tree-page').then(function (json) {
        if (!json || !json.tasks) return;
        // 快照取自切树前（纪元已推进）或面板已关/重开：丢弃，避免旧快照回退切换；
        // 也不更新 studyCache，防止下次打开先把回退态闪出来。
        if (epoch !== treeEpoch || !open || requestId !== routeRequestId) return;
        studyCache = json; window[STUDY_DATA_CACHE_KEY] = json;
        applyStudyPayload(json, requestId, taskId, requestedTreeId);
      }).catch(function () {});
      return;
    }
    if (shared && shared.tasks) {
      studyCache = shared;
      applyStudyPayload(shared, requestId, taskId, requestedTreeId);
      return;
    }
    var epoch = treeEpoch;
    loadTreePageForOpen(epoch, requestId, taskId, requestedTreeId, true);
  }
  function closeRoute(restoreFocus) {
    if (!open) return;
    var returnFocus = routeReturnFocus;
    routeReturnFocus = null;
    stopTreeGoalBreath();
    setRailVisible(false);
    endTreeTransition();
    railOrbY = null;  // 滑块位置随画布一起失效，下次打开直接落位，不做跨会话飞行
    ++routeRequestId;
    cancelRouteCloseWait();
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
    if (rootProgressFrame) cancelAnimationFrame(rootProgressFrame);
    layoutFrame = 0;
    summaryFrame = 0;
    rootProgressFrame = 0;
    closePopover(false); closeConfirm(); closeGuide(false);
    if (reparentBadge) { reparentBadge.remove(); reparentBadge = null; }
    if (dropSlot) { dropSlot.remove(); dropSlot = null; }
    overlay.setAttribute('aria-hidden', 'true');
    delete overlay.dataset.active;
    open = false;
    if (restoreFocus !== false && returnFocus && returnFocus.isConnected) {
      requestAnimationFrame(function () {
        if (!open && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      });
    }
    // 起步页已经给树状页根层添加了 view-leaving：退场期间保留现有节点、连线和
    // 镜头画面，只停止运行时工作；横移淡出结束后再释放 DOM，避免只剩空背景退场。
    if (!prefersReduced && overlay.classList.contains('view-leaving')) {
      routeCloseAnimationHandler = function (event) {
        if (event.target !== overlay) return;
        finishRouteCloseVisuals();
      };
      overlay.addEventListener('animationend', routeCloseAnimationHandler);
      routeCloseTimer = window.setTimeout(finishRouteCloseVisuals, 720);
    } else if (prefersReduced) {
      finishRouteCloseVisuals();
    } else {
      overlay.classList.remove('is-visible');
      overlay.classList.add('is-closing');
      routeCloseTimer = window.setTimeout(finishRouteCloseVisuals, 320);
    }
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
      if (action === 'help') return openGuide(actionControl);
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
        if (completeTask) updateTask(
          completeTask,
          { status: completeTask.status === 'done' ? 'active' : 'done' },
          { optimistic: true },
        ).catch(ignoreBusy);
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
    if (action === 'new-branch' || action === 'new-stage') {
      return createOptimistically({
        command: 'create-branch', primaryLink: primaryLinkForAnchor(anchor), title: T('未命名'),
      }).catch(showError);
    }
    if (action === 'new-task') {
      return createOptimistically({
        command: 'create-task', primaryLink: primaryLinkForAnchor(anchor), title: T('未命名'), target: 1,
      }).catch(showError);
    }
    if (action === 'rename' || action === 'settings') return formPopover(anchor, action);
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
    if (action === 'delete-task') {
      var task = findTask(anchor.dataset.taskId);
      return openConfirm(T('删除这个任务？'), T('任务及相关解锁条件都会永久删除。'), function () {
        return deleteTaskOptimistically(task.id);
      });
    }
    if (action === 'color') {
      var colorTask = anchor.dataset.kind === 'task' ? findTask(anchor.dataset.taskId) : null;
      if (!colorTask) return;
      openPopover(anchor, colorPaletteHTML(colorTask.color || ''));
      return;
    }
    if (action === 'set-color') {
      return updateAppearanceOptimistically(anchor, { color: control.dataset.color || '' });
    }
    if (action === 'set-shape') {
      var shape = control.dataset.shape || 'rounded';
      return updateAppearanceOptimistically(anchor, { shape: shape });
    }
    if (action === 'delete-branch') {
      return openConfirm(T('删除这个阶段？'), T('阶段、其中的全部任务与解锁条件都会永久删除。'), function () {
        return command({ command: 'delete-branch', nodeId: anchor.dataset.nodeId });
      });
    }
    if (action === 'delete-tree') {
      var tree = state.trees.find(function (item) { return item.id === state.activeTreeId; }) || state.tree;
      return openConfirm(T('删除这棵树？'), T('其中的全部阶段、任务与解锁条件都会永久删除。'), function () {
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
    var nodeId = anchor.dataset.nodeId;
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
    if (!anchor) { closePopover(false); return; }
    if (anchor.dataset.kind === 'milestone') { closePopover(false); return; }
    var nodeId = anchor.dataset.nodeId || '';
    if (!popover.hidden && popover.dataset.anchorId === nodeId) {
      closePopover(true);
      return;
    }
    var appearance = nodeAppearance(anchor);
    openPopover(anchor, appearancePaletteHTML(appearance.color, appearance.shape));
  });
  nodesHost.addEventListener('pointerdown', function (event) {
    var anchor = event.target.closest('.study-route-node');
    if (event.button !== 0 || drag || !anchor || anchor.dataset.kind === 'milestone' || event.target.closest('button')) return;
    if (anchor.dataset.kind === 'root') return;
    drag = {
      id: event.pointerId, source: anchor, nodeId: anchor.dataset.nodeId,
      x: event.clientX, y: event.clientY,
      startPoint: routeScenePoint(event.clientX, event.clientY),
      active: false, candidate: null, starts: new Map(),
    };
    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup', onDragEnd, true);
    window.addEventListener('pointercancel', onDragCancel, true);
    window.addEventListener('mouseup', onDragMouseUp, true);
    anchor.addEventListener('lostpointercapture', onDragLostCapture);
    try { anchor.setPointerCapture(event.pointerId); } catch (error) {}
  });
  function routeScenePoint(clientX, clientY) {
    var rect = viewport.getBoundingClientRect(), zoom = Math.max(.001, view.zoom);
    return { x: (clientX - rect.left - view.x) / zoom, y: (clientY - rect.top - view.y) / zoom };
  }
  function cancelActivePointerGestures() {
    if (drag) finishDrag(true);
    if (pan) {
      try { viewport.releasePointerCapture(pan.id); } catch (error) {}
      pan = null;
      viewport.classList.remove('is-panning');
      stopPanInertia();
    }
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
    if ((event.buttons & 1) === 0) { finishDrag(true); return; }
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
    window.removeEventListener('pointerup', onDragEnd, true);
    window.removeEventListener('pointercancel', onDragCancel, true);
    window.removeEventListener('mouseup', onDragMouseUp, true);
    current.source.removeEventListener('lostpointercapture', onDragLostCapture);
    try {
      if (current.source.hasPointerCapture(current.id)) current.source.releasePointerCapture(current.id);
    } catch (error) {}
    current.dragIds && current.dragIds.forEach(function (id) {
      var element = nodeElements.get(id);
      if (element) element.classList.remove('is-drag-anchor', 'is-subtree-dragging');
    });
    document.body.classList.remove('study-route-node-dragging'); clearDropPreview();
    if (current.active) saveViewSoon();
    if (current.active) {
      dragEndedAt = performance.now();
      var preview = !cancelled && current.candidate
        ? preserveTreeExtensions(current.baseTree,
          GoalTree.previewMove(current.baseTree, current.nodeId, current.candidate.primaryLink)) : null;
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
  function onDragMouseUp(event) {
    if (!drag || event.button !== 0) return;
    if (drag.active) event.preventDefault();
    finishDrag(false);
  }
  function onDragLostCapture(event) {
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
    else viewport.focus({ preventScroll: true });
  });
  stageEl.addEventListener('mousemove', function (event) {
    var rect = stageEl.getBoundingClientRect();
    setRailVisible(rect.right - event.clientX <= railRevealPx || railOver);
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
  window.addEventListener('resize', preserveViewOnResize);
  window.addEventListener('blur', cancelActivePointerGestures);
  window.addEventListener('relatum:goal-tree-simple-mode-change', function () {
    if (open) closePopover(false);
  });
  window.addEventListener('pagehide', function () { if (open) closeRoute(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelActivePointerGestures();
      stopTreeGoalBreath();
    }
    else if (open) scheduleTreeGoalBreath(1400);
  });
  window.addEventListener('beforeunload', function () { if (open) flushViewSave(); });
  window.CanvasTreePage = {
    activate: function () { if (!open) openRoute(); },
    deactivate: function () { if (open) closeRoute(false); },
    open: function (taskId, trigger, treeId) { openRoute(trigger, taskId, treeId); },
    help: function (trigger) { openRoute(trigger); openGuide(trigger); },
    close: closeRoute,
    prefetch: prefetchStudyData,
    refresh: function () {
      if (!open) return Promise.resolve(false);
      var epoch = treeEpoch;
      return api('/api/tree-page').then(function (json) {
        if (epoch !== treeEpoch) return false;
        studyCache = json; window[STUDY_DATA_CACHE_KEY] = json;
        state.tasks = Array.isArray(json.tasks) ? json.tasks : [];
        applyTreePayloadInitial(json);
        render();
        renderRail();
        return true;
      });
    },
  };
  scheduleTreePagePreload();
})();

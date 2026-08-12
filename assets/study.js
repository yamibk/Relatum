(function () {
  'use strict';

  const STATUS = ['active', 'done'];
  const STATUS_LABEL = { active: '未完成', done: '已完成' };
  const state = {
    tasks: [], trash: [], goalTree: { version: 1, title: '我的学习路线', nodes: [] },
    goalTrees: [], goalTreeArchives: [],
    selectedId: '',
  };
  const GoalTree = window.RelatumStudyGoalTree || null;
  let studyRefreshSeq = 0;
  let studyLoaded = false;
  let studyRevealTimer = 0;
  let studyRevealKey = '';
  let studyGoalBreathTimer = 0;
  let studyGoalCheckFlowTimer = 0;
  let studyPageActive = false;
  let studyInitialLoad = null;
  let studyLatestRefresh = null;
  let progressSettingsId = '';       // 当前浮动设置卡对应的任务 id
  let progressSettingsMilestones = null; // 浮动设置卡中的任务点草稿
  let progressSettingsPopover = null;
  let progressSettingsTrigger = null;
  let progressSettingsPositionFrame = 0;
  const trashPanel = document.querySelector('[data-role="trash-panel"]');
  const trashConfirm = document.querySelector('[data-role="study-trash-confirm"]');
  const toast = document.querySelector('[data-role="study-toast"]');
  const progressListEl = document.querySelector('[data-role="study-progress-list"]');
  const completedListEl = document.querySelector('[data-role="study-completed-list"]');
  const completedSectionEl = document.querySelector('[data-role="study-progress-completed-column"]');
  const goalTreeOverlay = document.querySelector('[data-role="study-goal-tree-overlay"]');
  const goalTreePanel = document.querySelector('#study-goal-tree-panel');
  const goalTreeSelect = document.querySelector('[data-role="study-goal-tree-select"]');
  const goalTreeSummary = document.querySelector('[data-role="study-goal-tree-summary"]');
  const goalTreeViewport = document.querySelector('[data-role="study-goal-tree-viewport"]');
  const goalTreeScene = document.querySelector('[data-role="study-goal-tree-scene"]');
  const goalTreeEdges = document.querySelector('[data-role="study-goal-tree-edges"]');
  const goalTreeNodes = document.querySelector('[data-role="study-goal-tree-nodes"]');
  const goalTreeEmpty = document.querySelector('[data-role="study-goal-tree-empty"]');
  const goalTreeDetail = document.querySelector('[data-role="study-goal-tree-detail"]');
  const goalTreeConfirm = document.querySelector('[data-role="study-goal-tree-confirm"]');
  const GOAL_TREE_ACTIVE_KEY = 'canvas:studyGoalTreeActive:v2';
  const GOAL_TREE_VIEW_KEY = 'canvas:studyGoalTreeView:v2';
  let goalTreeOpen = false;
  let goalTreeActiveId = '';
  let goalTreeSelectedId = '';
  let goalTreePendingTaskId = '';
  let goalTreeDetailMode = 'node';
  let goalTreeArchivePayload = null;
  let goalTreeCommandChain = Promise.resolve();
  let goalTreeCommandBusy = false;
  let goalTreeConfirmAction = null;
  let goalTreeOverlaySeq = 0;
  let goalTreeConfirmSeq = 0;
  let goalTreeLastTrigger = null;
  let goalTreeRenderLayout = null;
  let goalTreeView = { x: 36, y: 36, zoom: 1 };
  let goalTreeViewTarget = { x: 36, y: 36, zoom: 1 };
  let goalTreeViewFrame = 0;
  let goalTreeViewTickAt = 0;
  let goalTreeSummaryFrame = 0;
  let goalTreeLayoutFrame = 0;
  let goalTreeVisualPlacements = new Map();
  let goalTreeNodeElements = new Map();
  let goalTreeEdgeElements = new Map();
  let goalTreeNeedsFit = true;
  let goalTreePan = null;
  let goalTreePanInertiaFrame = 0;
  let goalTreeDrag = null;
  let goalTreeDragFrame = 0;
  let goalTreeDropSlot = null;
  let goalTreeReparentBadge = null;
  let goalTreeDropCandidateKey = '';
  let goalTreeDragEndedAt = 0;
  let goalTreeDetailFrame = 0;
  let goalTreeViewStateByTree = (function () {
    try {
      var raw = JSON.parse(localStorage.getItem(GOAL_TREE_VIEW_KEY) || '{}');
      if (!raw || typeof raw !== 'object') return {};
      return Object.keys(raw).reduce(function (clean, treeId) {
        var saved = raw[treeId];
        if (!saved || typeof saved !== 'object') return clean;
        clean[treeId] = {
          collapsedBranchIds: Array.isArray(saved.collapsedBranchIds) ? saved.collapsedBranchIds.slice() : [],
          expandedTaskIds: Array.isArray(saved.expandedTaskIds) ? saved.expandedTaskIds.slice() : [],
        };
        return clean;
      }, {});
    } catch (e) { return {}; }
  })();
  let toastTimer = null;
  let optimisticTaskSeq = 0;
  let reorderTimer = null;
  let reorderChain = Promise.resolve();
  let progressDrag = null;            // 进度面板拖拽排序状态
  let progressFlipAnims = new Map();  // 拖拽让位 FLIP 动画
  let progressDragClickGuard = '';    // 拖拽松手后吞掉紧随的 click
  let trashChain = Promise.resolve(); // 快速连删时后台按点击顺序落盘，界面无需等待网络
  let isEmptyingTrash = false;
  const STUDY_TRASH_LIMIT = 30;
  const STUDY_MILESTONES_MAX = 50;
  const taskCreatePromises = new WeakMap(); // 临时任务先动起来，后端随后认领真实 id
  const taskMutationChains = new WeakMap(); // 同一任务的新建后修改、进度与状态统一按顺序落盘
  const taskUpdateSeq = new WeakMap();
  const taskProgressSeq = new WeakMap();
  let trashEnterId = '';      // 回收站新增条目轻轻落入
  // 里程碑弹窗
  let studyMilestoneDialog = null;
  let studyMilestoneDialogDraft = [];
  let studyMilestoneDialogTarget = 0;
  let studyMilestoneReturnEl = null;
  let studyMilestoneTipSeq = 0;
  const prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();

  // —— 动画工具：复刻专注页的 replayClass，让同一个 CSS 动画类可以反复触发 ——
  const STUDY_MILESTONE_REACHED_CLEANUP_MS = 990;
  const replayCleanupTimers = new WeakMap();
  function replayClass(element, className, cleanupMs) {
    if (!element || prefersReduced) return;
    const cleanupByClass = replayCleanupTimers.get(element) || new Map();
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
    const cleanupByClass = replayCleanupTimers.get(element);
    if (cleanupByClass) {
      window.clearTimeout(cleanupByClass.get(className));
      cleanupByClass.delete(className);
      if (cleanupByClass.size === 0) replayCleanupTimers.delete(element);
    }
    element.classList.remove(className);
  }

  // —— 错峰入场：复刻专注页每日视图的三层 spring stagger（头 → 列标题 → 逐行卡片）——
  function armStudyEntranceCleanup() {
    window.clearTimeout(studyRevealTimer);
    studyRevealTimer = window.setTimeout(function () {
      var view = document.querySelector('[data-role="study-progress-view"]');
      if (view) view.classList.remove('is-revealing');
      studyRevealTimer = 0;
    }, 1450);
  }
  function replayStudyEntrance(key) {
    var view = document.querySelector('[data-role="study-progress-view"]');
    if (!view || prefersReduced || viewMode !== 'progress') return;
    var revealKey = String(key || 'manual');
    if (studyRevealKey === revealKey) return;
    studyRevealKey = revealKey;
    window.clearTimeout(studyRevealTimer);
    view.classList.remove('is-revealing');
    void view.offsetWidth;
    view.classList.add('is-revealing');
    armStudyEntranceCleanup();
  }

  // —— 视图模式：list(极简清单，默认) / progress(单位进度面板) ——
  const VIEW_MODE_KEY = 'study:viewMode:v2';
  const studyViewEl = document.querySelector('[data-role="study-view"]');
  function readViewMode() {
    try { return localStorage.getItem(VIEW_MODE_KEY) === 'progress' ? 'progress' : 'list'; }
    catch (e) { return 'list'; }
  }
  let viewMode = readViewMode();
  function stopStudyGoalBreath() {
    window.clearTimeout(studyGoalBreathTimer);
    studyGoalBreathTimer = 0;
    document.querySelectorAll('.study-progress-card.is-goal-breathing').forEach(function (card) {
      cancelReplayClass(card, 'is-goal-breathing');
    });
  }
  function visibleStudyGoalCards() {
    return Array.from(document.querySelectorAll('.study-progress-card.is-goal-ready:not(.is-goal-pending):not(.is-goal-celebrating)'))
      .filter(function (card) {
        var rect = card.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      });
  }
  function stopStudyGoalCheckFlow() {
    window.clearTimeout(studyGoalCheckFlowTimer);
    studyGoalCheckFlowTimer = 0;
  }
  function nudgeStudyGoalChecks() {
    visibleStudyGoalCards().forEach(function (card) {
      var check = card.querySelector('.study-progress-check');
      if (!check) return;
      var names = ['a', 'b', 'c', 'd'];
      var first = Math.floor(Math.random() * names.length);
      var second = (first + 1 + Math.floor(Math.random() * (names.length - 1))) % names.length;
      [names[first], names[second]].forEach(function (name) {
        var x = 14 + Math.random() * 72;
        var y = 16 + Math.random() * 68;
        check.style.setProperty('--study-check-speck-' + name + '-x', x.toFixed(1) + '%');
        check.style.setProperty('--study-check-speck-' + name + '-y', y.toFixed(1) + '%');
      });
    });
  }
  function scheduleStudyGoalCheckFlow(delay) {
    stopStudyGoalCheckFlow();
    if (prefersReduced || !studyPageActive || viewMode !== 'progress' || document.hidden) return;
    studyGoalCheckFlowTimer = window.setTimeout(function () {
      studyGoalCheckFlowTimer = 0;
      if (prefersReduced || !studyPageActive || viewMode !== 'progress' || document.hidden) return;
      nudgeStudyGoalChecks();
      scheduleStudyGoalCheckFlow(3400);
    }, Math.max(0, Number(delay) || 500));
  }
  function scheduleStudyGoalBreath(delay) {
    window.clearTimeout(studyGoalBreathTimer);
    studyGoalBreathTimer = 0;
    if (prefersReduced || !studyPageActive || viewMode !== 'progress' || document.hidden) return;
    studyGoalBreathTimer = window.setTimeout(function () {
      studyGoalBreathTimer = 0;
      if (prefersReduced || !studyPageActive || viewMode !== 'progress' || document.hidden) return;
      visibleStudyGoalCards().forEach(function (card) {
        replayClass(card, 'is-goal-breathing', 2540);
      });
      scheduleStudyGoalBreath(2800);
    }, Math.max(0, Number(delay) || 1400));
  }
  function applyViewMode() {
    if (studyViewEl) studyViewEl.classList.toggle('study-mode-list', viewMode === 'list');
  }
  function setViewMode(mode, animate) {
    const next = mode === 'list' ? 'list' : 'progress';
    if (next === viewMode) return;
    closeProgressSettings(false, true);
    viewMode = next;
    if (next === 'progress') {
      scheduleStudyGoalBreath(1400);
      scheduleStudyGoalCheckFlow(500);
    } else {
      stopStudyGoalBreath();
      stopStudyGoalCheckFlow();
    }
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch (e) {}
    if (animate && !prefersReduced && studyViewEl) {
      // study-mode-anim 全程在场（承载 transition），study-mode-switching 控制淡出
      studyViewEl.classList.add('study-mode-anim', 'study-mode-switching');
      setTimeout(() => {
        render();                                               // 隐身时换内容
        requestAnimationFrame(() => requestAnimationFrame(() => {
          studyViewEl.classList.remove('study-mode-switching'); // 再淡入
          if (next === 'progress') replayStudyEntrance('mode-switch');
          setTimeout(() => studyViewEl.classList.remove('study-mode-anim'), 240);
        }));
      }, 200);
    } else {
      render();
      if (next === 'progress') replayStudyEntrance('mode-switch');
    }
  }
  function toggleViewMode() {
    setViewMode(viewMode === 'list' ? 'progress' : 'list', true);
  }
  function activateStudyView() {
    studyPageActive = true;
    scheduleStudyGoalBreath(1400);
    scheduleStudyGoalCheckFlow(500);
    if (studyLoaded) {
      render();
      replayStudyEntrance('activate');
      return;
    }
    ensureStudyLoaded().then(function (loaded) {
      if (loaded) { render(); replayStudyEntrance('activate'); }
    });
  }
  window.StudyView = { toggleMode: toggleViewMode, activate: activateStudyView };

  // 离开学习页时重置错峰入场状态，确保再次进入时重播动画
  document.addEventListener('start:viewchange', function (event) {
    if (event.detail && event.detail.previous === 'study') {
      studyPageActive = false;
      stopStudyGoalBreath();
      stopStudyGoalCheckFlow();
      closeProgressSettings(false, true);
      studyRevealKey = '';
      window.clearTimeout(studyRevealTimer);
      studyRevealTimer = 0;
      var view = document.querySelector('[data-role="study-progress-view"]');
      if (view) view.classList.remove('is-revealing');
    }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopStudyGoalBreath();
      stopStudyGoalCheckFlow();
    } else if (studyPageActive) {
      scheduleStudyGoalBreath(1400);
      scheduleStudyGoalCheckFlow(500);
    }
  });
  window.addEventListener('pagehide', stopStudyGoalBreath);
  window.addEventListener('pagehide', stopStudyGoalCheckFlow);
  window.addEventListener('pagehide', function () { if (goalTreeOpen) closeGoalTree(); });

  function localDay(date) {
    const d = date || new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  const today = localDay();

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function focusDurationLabel(sec) {
    const mins = Math.max(0, Math.round((Number(sec) || 0) / 60));
    if (mins < 60) return mins + ' 分钟';
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
  }

  function T(message) {
    return window.RelatumI18n ? window.RelatumI18n.t(String(message || '')) : String(message || '');
  }

  function setStudyAriaLabel(element, source) {
    if (!element) return;
    element.dataset.i18nSourceAriaLabel = String(source || '');
    element.setAttribute('aria-label', T(source));
  }

  function showToast(message) {
    toast.textContent = T(message);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1500);
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || '操作失败');
    return json;
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((json) => {
      document.dispatchEvent(new CustomEvent('canvas:data-changed', {
        detail: { source: 'study', path },
      }));
      return json;
    });
  }

  function taskSelector(id) {
    return '[data-id="' + String(id || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  }

  function optimisticTask(payload) {
    const now = new Date().toISOString();
    return {
      id: 'tmp_' + Date.now().toString(36) + '_' + (++optimisticTaskSeq).toString(36),
      title: payload.title || '未命名任务',
      status: STATUS.includes(payload.status) ? payload.status : 'active',
      progress: { current: 0, target: 0, milestones: [] },
      createdAt: now,
      updatedAt: now,
      completedAt: '',
    };
  }

  function remapTaskId(task, oldId, newId) {
    task.id = newId;
    if (state.selectedId === oldId) state.selectedId = newId;
    document.querySelectorAll(taskSelector(oldId)).forEach((el) => { el.dataset.id = newId; });
  }

  function createOptimisticTask(payload) {
    const task = optimisticTask(payload);
    state.tasks.push(task);
    const request = post('/api/study-task-create', payload).then((json) => {
      const oldId = task.id;
      const live = { title: task.title, status: task.status, progress: task.progress };
      Object.assign(task, json.task, live);
      remapTaskId(task, oldId, json.task.id);
      taskCreatePromises.delete(task);
      return task;
    }).catch((error) => {
      taskCreatePromises.delete(task);
      const index = state.tasks.indexOf(task);
      if (index >= 0) state.tasks.splice(index, 1);
      if (state.selectedId === task.id) state.selectedId = '';
      render();
      showToast('新建任务失败：' + error.message);
      throw error;
    });
    taskCreatePromises.set(task, request);
    request.catch(() => undefined); // 失败由界面提示处理，避免临时任务 Promise 冒泡成控制台噪音
    return task;
  }

  function ensureTaskCreated(task) {
    return taskCreatePromises.get(task) || Promise.resolve(task);
  }

  function applyLocalTaskPatch(task, patch) {
    Object.keys(patch).forEach((key) => {
      if (key === 'tags') {
        task.tags = Array.isArray(patch.tags)
          ? patch.tags.slice()
          : String(patch.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
      } else if (key === 'progress' && patch.progress && typeof patch.progress === 'object') {
        task.progress = Object.assign({}, task.progress || {}, patch.progress);
      } else {
        task[key] = patch[key];
      }
    });
  }

  function queueTaskMutation(task, operation) {
    if (!task) return Promise.resolve(null);
    const previous = taskMutationChains.get(task) || Promise.resolve();
    const request = previous.catch(() => undefined).then(async () => {
      await ensureTaskCreated(task);
      return operation();
    });
    taskMutationChains.set(task, request);
    request.finally(() => {
      if (taskMutationChains.get(task) === request) taskMutationChains.delete(task);
    }).catch(() => undefined);
    return request;
  }

  function queueTaskPatch(task, patch, options) {
    if (!task) return Promise.resolve(null);
    options = options || {};
    applyLocalTaskPatch(task, patch);
    const seq = (taskUpdateSeq.get(task) || 0) + 1;
    taskUpdateSeq.set(task, seq);
    const request = queueTaskMutation(task, async () => {
      const json = await post('/api/study-task-update', Object.assign({ id: task.id }, patch));
      if (json.goalTree) state.goalTree = json.goalTree;
      if (taskUpdateSeq.get(task) === seq) Object.assign(task, json.task);
      else {
        task.updatedAt = json.task.updatedAt || task.updatedAt;
        task.completedAt = json.task.completedAt || task.completedAt;
      }
      if (goalTreeOpen && !options.skipGoalTreeRender) renderGoalTree();
      return task;
    });
    return request;
  }

  function scheduleStudyReorder() {
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(() => {
      reorderTimer = null;
      reorderChain = reorderChain.catch(() => undefined).then(async () => {
        await Promise.all(state.tasks.map((task) => ensureTaskCreated(task)));
        await post('/api/study-reorder', { ids: state.tasks.map((task) => task.id) });
      }).catch((error) => {
        showToast(error.message);
        refresh();
      });
    }, 110);
  }

  function findTask(id) {
    return state.tasks.find((task) => task.id === id);
  }

  // ── 目标树：现有学习任务之上的可选长期目标组织层 ──────────────
  function goalTreeOwner(taskId) {
    return GoalTree ? GoalTree.taskOwner(state.goalTree, taskId) : null;
  }
  function activeGoalTree() {
    return state.goalTree;
  }
  function applyStudyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    state.tasks = payload.tasks || [];
    state.trash = payload.trash || [];
    state.goalTree = payload.goalTree || { version: 1, title: '我的学习路线', nodes: [] };
  }
  function goalTreeCommand(command, payload, options) {
    if (['create-branch', 'delete-branch', 'attach-task', 'create-task', 'move-node', 'detach-task', 'delete-tree'].includes(command)) {
    }
    var before = captureGoalTreeRects();
    var body = Object.assign({ command: command }, payload || {});
    goalTreeCommandBusy = true;
    var request = goalTreeCommandChain.catch(function () {}).then(function () {
      return post('/api/study-goal-tree-command', body);
    }).then(function (json) {
      if (json.goalTree) state.goalTree = json.goalTree;
      if (Array.isArray(json.goalTreeArchives)) state.goalTreeArchives = json.goalTreeArchives;
      if (json.task && !findTask(json.task.id)) state.tasks.push(json.task);
      if (json.treeId) goalTreeActiveId = json.treeId;
      if (!state.goalTrees.some(function (tree) { return tree.id === goalTreeActiveId; })) {
        goalTreeActiveId = state.goalTrees[0] ? state.goalTrees[0].id : '';
      }
      if (json.nodeId) goalTreeSelectedId = json.nodeId;
      if (options && options.clearPending) goalTreePendingTaskId = '';
      if (options && options.mode) goalTreeDetailMode = options.mode;
      render({ skipGoalTree: true });
      if (!(options && options.skipGoalTreeRender)) {
        renderGoalTree(before, { duration: options && options.duration });
      }
      return json;
    }).catch(function (error) {
      showToast(error.message);
      if (options && options.rollbackTree) {
        var failedTree = state.goalTrees.find(function (item) { return item.id === options.rollbackTree.id; });
        state.goalTrees = state.goalTrees.map(function (item) {
          return item.id === options.rollbackTree.id ? options.rollbackTree : item;
        });
        renderGoalTree(null, {
          duration: 260,
          preserveMarkup: true,
          preserveDetail: true,
          preserveSummary: true,
          preserveSelect: true,
          localMove: failedTree && options.rollbackNodeId
            ? { beforeTree: failedTree, nodeId: options.rollbackNodeId }
            : null,
        });
        return null;
      }
      return refresh().then(function (refreshed) {
        return null;
      });
    }).finally(function () {
      if (goalTreeCommandChain === request) goalTreeCommandBusy = false;
    });
    goalTreeCommandChain = request;
    return request;
  }
  function goalTreeViewState(treeId) {
    var saved = goalTreeViewStateByTree[treeId];
    if (!saved || typeof saved !== 'object') saved = {};
    return {
      collapsedBranchIds: Array.isArray(saved.collapsedBranchIds) ? saved.collapsedBranchIds.slice() : [],
      expandedTaskIds: Array.isArray(saved.expandedTaskIds) ? saved.expandedTaskIds.slice() : [],
    };
  }
  function saveGoalTreeViewState(treeId, patch) {
    var next = Object.assign(goalTreeViewState(treeId), patch || {});
    goalTreeViewStateByTree[treeId] = {
      collapsedBranchIds: Array.isArray(next.collapsedBranchIds) ? next.collapsedBranchIds.slice() : [],
      expandedTaskIds: Array.isArray(next.expandedTaskIds) ? next.expandedTaskIds.slice() : [],
    };
    try { localStorage.setItem(GOAL_TREE_VIEW_KEY, JSON.stringify(goalTreeViewStateByTree)); } catch (e) {}
  }
  function goalTreeCollapsed(treeId) {
    return new Set(goalTreeViewState(treeId).collapsedBranchIds);
  }
  function goalTreeExpanded(treeId) {
    return new Set(goalTreeViewState(treeId).expandedTaskIds);
  }
  function goalTreeNodeTitle(node, tree) {
    if (!node) return '';
    if (node.kind === 'root') return tree.title || '未命名目标';
    if (node.kind === 'task') {
      var task = findTask(node.taskId);
      return task ? task.title : '已移除任务';
    }
    return node.title || (node.kind === 'archive' ? '已归档任务' : '未命名分支');
  }
  function goalTreeParentOptions(tree, selected) {
    var model = GoalTree && GoalTree.buildModel(tree, state.tasks);
    if (!model) return '<option value="">目标根节点</option>';
    var out = ['<option value="">目标根节点</option>'];
    function walk(parentId, depth) {
      (model.children.get(parentId || '') || []).forEach(function (node) {
        out.push('<option data-user-content value="' + escapeHtml(node.id) + '"'
          + (node.id === selected ? ' selected' : '') + '>'
          + escapeHtml(Array(depth + 1).join('　') + node.title) + '</option>');
        if (['branch', 'task', 'archive'].includes(node.kind)) walk(node.id, depth + 1);
      });
    }
    walk('', 1);
    return out.join('');
  }
  function goalTreeDestinationList(tree, selectedParentId, movingNodeId) {
    var model = GoalTree && GoalTree.buildModel(tree, state.tasks);
    if (!model) return '';
    var rows = [];
    function row(id, title, depth, count) {
      var blocked = movingNodeId && GoalTree.wouldCreateCycle(tree, movingNodeId, id);
      var selected = String(id || '') === String(selectedParentId || '');
      rows.push('<button type="button" class="study-goal-tree-destination' + (selected ? ' is-current' : '')
        + '" data-action="study-goal-tree-move-target" data-parent-id="' + escapeHtml(id || '') + '"'
        + (blocked ? ' disabled' : '') + ' style="--goal-destination-depth:' + depth + '">'
        + '<span class="study-goal-tree-destination-mark" aria-hidden="true"></span><span><strong data-user-content>'
        + escapeHtml(title) + '</strong><small>' + (count ? count + ' 项后代任务' : '空分支')
        + '</small></span>' + (selected ? '<em>当前位置</em>' : '<i aria-hidden="true">›</i>') + '</button>');
    }
    row('', tree.title || '目标根节点', 0, model.rootMetrics.leafCount);
    function walk(parentId, depth) {
      (model.children.get(parentId || '') || []).forEach(function (node) {
        if (!['branch', 'task', 'archive'].includes(node.kind)) return;
        var metrics = model.metrics.get(node.id) || { leafCount: 0 };
        row(node.id, node.title || '未命名模块', depth, metrics.leafCount);
        walk(node.id, depth + 1);
      });
    }
    walk('', 1);
    return rows.join('');
  }
  function goalTreeTaskOptions() {
    var items = state.tasks.filter(function (task) { return !goalTreeOwner(task.id); });
    return items.length
      ? items.map(function (task) {
          return '<option data-user-content value="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + '</option>';
        }).join('')
      : '<option value="">没有未归属的学习任务</option>';
  }
  function renderGoalTreeSelect() {
    if (!goalTreeSelect) return;
    goalTreeSelect.innerHTML = state.goalTrees.length
      ? state.goalTrees.map(function (tree) {
          return '<option data-user-content value="' + escapeHtml(tree.id) + '"'
            + (tree.id === goalTreeActiveId && !goalTreeArchivePayload ? ' selected' : '') + '>'
            + escapeHtml(tree.title) + '</option>';
        }).join('')
      : '<option value="">还没有目标树</option>';
    goalTreeSelect.disabled = !state.goalTrees.length || !!goalTreeArchivePayload;
  }
  function captureGoalTreeRects() {
    var rects = new Map(); rects.progress = new Map();
    if (!goalTreeNodes) return rects;
    goalTreeNodes.querySelectorAll('.study-goal-node[data-node-id]').forEach(function (node) {
      rects.set(node.dataset.nodeId, node.getBoundingClientRect());
      rects.progress.set(node.dataset.nodeId, Number(node.dataset.progress || 0));
    });
    var summaryNumber = goalTreeSummary && goalTreeSummary.querySelector('[data-goal-progress-number]');
    rects.summaryProgress = Number(summaryNumber && summaryNumber.dataset.value || 0);
    return rects;
  }
  function animateGoalTreeRects(before) {
    // V2 uses one requestAnimationFrame loop for nodes and SVG edges.
    return before;
  }
  function applyGoalTreeView() {
    if (!goalTreeScene) return;
    goalTreeScene.style.transform = 'translate3d(' + goalTreeView.x + 'px,' + goalTreeView.y + 'px,0) scale(' + goalTreeView.zoom + ')';
  }
  function stopGoalTreeViewAnimation() {
    if (goalTreeViewFrame) cancelAnimationFrame(goalTreeViewFrame);
    goalTreeViewFrame = 0;
    goalTreeViewTickAt = 0;
  }
  function requestGoalTreeViewAnimation() {
    if (prefersReduced) {
      goalTreeView = Object.assign({}, goalTreeViewTarget);
      applyGoalTreeView();
      return;
    }
    if (!goalTreeViewFrame) goalTreeViewFrame = requestAnimationFrame(tickGoalTreeView);
  }
  function tickGoalTreeView(timestamp) {
    goalTreeViewFrame = 0;
    if (!goalTreeOpen) return;
    var dt = goalTreeViewTickAt ? Math.min(34, timestamp - goalTreeViewTickAt) : 16.667;
    goalTreeViewTickAt = timestamp;
    var factor = 1 - Math.pow(1 - .155, dt / 16.667);
    var dx = goalTreeViewTarget.x - goalTreeView.x;
    var dy = goalTreeViewTarget.y - goalTreeView.y;
    var dz = goalTreeViewTarget.zoom - goalTreeView.zoom;
    if (Math.abs(dx) < .25 && Math.abs(dy) < .25 && Math.abs(dz) < .0007) {
      goalTreeView = Object.assign({}, goalTreeViewTarget);
      goalTreeViewTickAt = 0;
      applyGoalTreeView();
      return;
    }
    goalTreeView.x += dx * factor;
    goalTreeView.y += dy * factor;
    goalTreeView.zoom += dz * factor;
    applyGoalTreeView();
    goalTreeViewFrame = requestAnimationFrame(tickGoalTreeView);
  }
  function setGoalTreeViewTarget(next, immediate) {
    goalTreeViewTarget = {
      x: Number(next.x) || 0,
      y: Number(next.y) || 0,
      zoom: Math.max(.38, Math.min(1.6, Number(next.zoom) || 1)),
    };
    if (immediate || prefersReduced) {
      stopGoalTreeViewAnimation();
      goalTreeView = Object.assign({}, goalTreeViewTarget);
      applyGoalTreeView();
    } else requestGoalTreeViewAnimation();
  }
  function fitGoalTree() {
    if (!goalTreeViewport || !goalTreeRenderLayout) return;
    var rect = goalTreeViewport.getBoundingClientRect();
    var bounds = goalTreeRenderLayout.bounds;
    if (!rect.width || !rect.height || !bounds.width || !bounds.height) return;
    var zoom = Math.max(.42, Math.min(1.08, Math.min((rect.width - 92) / bounds.width, (rect.height - 92) / bounds.height)));
    setGoalTreeViewTarget({
      zoom: zoom,
      x: (rect.width - bounds.width * zoom) / 2 - (Number(bounds.x) || 0) * zoom,
      y: (rect.height - bounds.height * zoom) / 2 - (Number(bounds.y) || 0) * zoom,
    });
  }
  function setGoalTreeZoom(next, anchorX, anchorY) {
    if (!goalTreeViewport) return;
    var rect = goalTreeViewport.getBoundingClientRect();
    var old = goalTreeViewTarget.zoom;
    var zoom = Math.max(.38, Math.min(1.6, next));
    var ax = Number.isFinite(anchorX) ? anchorX - rect.left : rect.width / 2;
    var ay = Number.isFinite(anchorY) ? anchorY - rect.top : rect.height / 2;
    setGoalTreeViewTarget({
      x: ax - (ax - goalTreeViewTarget.x) * (zoom / old),
      y: ay - (ay - goalTreeViewTarget.y) * (zoom / old),
      zoom: zoom,
    });
  }
  function goalTreeEdgePath(from, to) {
    var reverse = to.x + to.width / 2 < from.x + from.width / 2;
    var x1 = reverse ? from.x : from.x + from.width;
    var y1 = from.y;
    var x2 = reverse ? to.x + to.width : to.x;
    var y2 = to.y;
    var mid = x1 + (x2 - x1) * .48;
    return 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2;
  }
  function goalTreePlacementMeta(placement) {
    var metrics = placement.metrics || { progress: 0, leafCount: 0, complete: false };
    var percent = Math.round((metrics.progress || 0) * 100);
    var task = placement.kind === 'task' ? findTask(placement.node.taskId) : null;
    var availability = placement.availability || { available: true, reason: '' };
    var subtree = placement.subtreeMetrics || metrics;
    var meta = placement.kind === 'root' || placement.kind === 'branch'
      ? (metrics.leafCount ? percent + '% · ' + metrics.leafCount + ' 项' : '尚未添加任务')
      : placement.kind === 'archive' ? '已归档'
        : placement.kind === 'milestone' ? ('第 ' + placement.node.milestone.at + ' 点' + (placement.node.milestone.reached ? ' · 已到达' : ''))
          : (task && task.progress && task.progress.target
            ? task.progress.current + ' / ' + task.progress.target
            : (task && task.status === 'done' ? '已完成' : '未设置进度'));
    if (placement.kind === 'task' && availability.reason === 'predecessor') meta += ' · 等待前置任务';
    if (placement.kind === 'task' && availability.reason === 'milestone') meta += ' · 等待任务点';
    if ((placement.kind === 'task' || placement.kind === 'archive') && subtree.leafCount > 1) {
      meta += ' · 子树 ' + Math.round(subtree.progress * 100) + '%';
    }
    return meta;
  }
  function goalTreeNodeMarkup(placement, tree, before) {
    var node = placement.node;
    var title = placement.kind === 'milestone' ? node.milestone.name
      : goalTreeNodeTitle(placement.kind === 'root' ? { kind: 'root' } : node, tree);
    var metrics = placement.metrics || { progress: 0, leafCount: 0, complete: false };
    var percent = Math.round((metrics.progress || 0) * 100);
    var task = placement.kind === 'task' ? findTask(node.taskId) : null;
    var focused = placement.kind === 'task' && (tree.focusTaskIds || []).includes(node.taskId);
    var milestoneSource = placement.kind === 'task' ? task
      : (placement.kind === 'archive' ? { progress: node.progress || {} } : null);
    var milestones = milestoneSource && GoalTree ? GoalTree.milestonesForTask(milestoneSource) : [];
    var meta = goalTreePlacementMeta(placement);
    var childCount = placement.kind !== 'milestone' && goalTreeRenderLayout
      ? (goalTreeRenderLayout.model.children.get(node.id) || []).length : 0;
    var collapse = placement.kind !== 'root' && placement.kind !== 'milestone' && childCount
      ? '<button type="button" class="study-goal-node-collapse" data-action="study-goal-node-collapse" aria-label="'
        + (placement.collapsed ? '展开分支' : '折叠分支') + '">' + (placement.collapsed ? '+' : '−') + '</button>' : '';
    var expand = (placement.kind === 'task' || placement.kind === 'archive') && milestones.length
      ? '<button type="button" class="study-goal-node-expand" data-action="study-goal-node-expand" aria-label="展开任务点">'
        + (goalTreeExpanded(tree.id).has(node.id) ? '−' : '+') + '</button>' : '';
    var oldPercent = before && before.progress && before.progress.has(placement.id)
      ? before.progress.get(placement.id) : percent;
    var taskTrack = placement.kind === 'task' || placement.kind === 'archive'
      ? '<span class="study-goal-task-track-host" data-role="study-goal-node-task-track"></span>' : '';
    var aggregateTrack = placement.kind === 'root' || placement.kind === 'branch'
      ? '<i class="study-goal-node-progress" aria-hidden="true"><b data-goal-progress-target="'
        + percent + '" style="width:' + oldPercent + '%"></b></i>' : '';
    return collapse + expand + (placement.kind === 'root' || placement.kind === 'milestone' || goalTreeArchivePayload ? ''
      : '<span class="study-goal-node-grip" aria-hidden="true">⠿</span>')
      + '<div><strong data-user-content>' + escapeHtml(title) + '</strong><span>' + escapeHtml(meta) + '</span></div>'
      + taskTrack + aggregateTrack
      + (focused ? '<em>进行中</em>' : '');
  }
  function syncGoalTreeNodeProgress(element, placement) {
    if (!element || !placement || !['task', 'archive'].includes(placement.kind)) return;
    var host = element.querySelector('[data-role="study-goal-node-task-track"]');
    if (!host) return;
    var source = placement.kind === 'task'
      ? findTask(placement.node.taskId)
      : { id: placement.node.sourceTaskId || placement.id, status: 'done', progress: placement.node.progress || {} };
    if (!source) return;
    var shell = host.querySelector('.study-progress-track-shell');
    if (!taskProgress(source).target) {
      if (shell) shell.remove();
      host.hidden = true;
      return;
    }
    host.hidden = false;
    if (!shell) {
      shell = buildStudyProgressShell(source, { compact: true, role: 'study-goal-node-progress-shell' });
      host.appendChild(shell);
    } else syncStudyProgressBar(shell, source);
  }
  function syncGoalTreeNodeMarkup(element, placement, tree) {
    if (!element || !placement) return;
    var title = placement.kind === 'milestone' ? placement.node.milestone.name
      : goalTreeNodeTitle(placement.kind === 'root' ? { kind: 'root' } : placement.node, tree);
    var heading = element.querySelector(':scope > div > strong');
    if (heading) heading.textContent = title;
    var meta = element.querySelector(':scope > div > span');
    if (meta) meta.textContent = goalTreePlacementMeta(placement);
    var childCount = placement.kind !== 'milestone' && goalTreeRenderLayout
      ? (goalTreeRenderLayout.model.children.get(placement.node.id) || []).length : 0;
    var collapse = element.querySelector(':scope > .study-goal-node-collapse');
    var needsCollapse = placement.kind !== 'root' && placement.kind !== 'milestone' && childCount > 0;
    if (!needsCollapse && collapse) collapse.remove();
    if (needsCollapse) {
      if (!collapse) {
        collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'study-goal-node-collapse';
        collapse.dataset.action = 'study-goal-node-collapse';
        element.insertBefore(collapse, element.firstChild);
      }
      collapse.setAttribute('aria-label', placement.collapsed ? '展开分支' : '折叠分支');
      collapse.textContent = placement.collapsed ? '+' : '−';
    }
    var aggregateFill = element.querySelector('[data-goal-progress-target]');
    if (aggregateFill) aggregateFill.dataset.goalProgressTarget = String(Math.round(((placement.metrics || {}).progress || 0) * 100));
  }
  function syncGoalTreeNodeElements(layout, tree, before, options) {
    if (!goalTreeNodes) return;
    options = options || {};
    var wanted = new Set(layout.nodes.map(function (item) { return item.id; }));
    goalTreeNodes.querySelectorAll('.study-goal-node[data-node-id]').forEach(function (element) {
      if (!wanted.has(element.dataset.nodeId)) {
        goalTreeNodeElements.delete(element.dataset.nodeId);
        element.remove();
      } else goalTreeNodeElements.set(element.dataset.nodeId, element);
    });
    layout.nodes.forEach(function (placement, index) {
      var element = goalTreeNodeElements.get(placement.id);
      var created = !element;
      if (created) {
        element = document.createElement('article');
        element.className = 'study-goal-node';
        element.setAttribute('role', 'treeitem');
        element.tabIndex = 0;
        element.dataset.nodeId = placement.id;
        goalTreeNodes.appendChild(element);
        goalTreeNodeElements.set(placement.id, element);
        if (!prefersReduced && !((placement.metrics || {}).complete)) element.classList.add('is-entering');
      }
      var node = placement.node;
      var metrics = placement.metrics || { progress: 0, complete: false };
      var focused = placement.kind === 'task' && (tree.focusTaskIds || []).includes(node.taskId);
      var dragging = goalTreeDrag && goalTreeDrag.active && goalTreeDrag.dragIds
        && goalTreeDrag.dragIds.has(placement.id);
      element.className = 'study-goal-node is-' + placement.kind
        + (placement.id === goalTreeSelectedId ? ' is-selected' : '')
        + (layout.model.focusPath.has(placement.id) ? ' is-current-path' : '')
        + (focused ? ' is-current' : '') + (metrics.complete ? ' is-complete' : '')
        + (placement.availability && !placement.availability.available ? ' is-blocked' : '')
        + (dragging ? ' is-dragging' : '')
        + (element.classList.contains('is-entering') ? ' is-entering' : '');
      element.dataset.kind = placement.kind;
      element.dataset.taskId = placement.kind === 'task' ? placement.node.taskId : '';
      element.dataset.draggable = placement.kind === 'root' || placement.kind === 'milestone' || goalTreeArchivePayload ? 'false' : 'true';
      element.dataset.progress = String(Math.round((metrics.progress || 0) * 100));
      element.style.width = placement.width + 'px';
      element.style.minHeight = placement.height + 'px';
      element.style.setProperty('--goal-node-index', Math.min(index, 10));
      if (created || !options.preserveMarkup) element.innerHTML = goalTreeNodeMarkup(placement, tree, before);
      else syncGoalTreeNodeMarkup(element, placement, tree);
      syncGoalTreeNodeProgress(element, placement);
      window.setTimeout(function () { if (element.isConnected) element.classList.remove('is-entering'); }, prefersReduced ? 0 : 420);
    });
  }
  function measureGoalTreeNodes(layout) {
    var sizes = new Map();
    if (!goalTreeNodes) return sizes;
    layout.nodes.forEach(function (placement) {
      var element = goalTreeNodeElements.get(placement.id);
      if (!element) return;
      sizes.set(placement.id, { width: Math.ceil(element.offsetWidth), height: Math.ceil(element.offsetHeight) });
    });
    return sizes;
  }
  function syncGoalTreeEdgeElements(layout) {
    if (!goalTreeEdges) return;
    var wanted = new Set(layout.edges.map(function (edge) { return edge.from + '>' + edge.to; }));
    goalTreeEdges.querySelectorAll('.study-goal-edge').forEach(function (path) {
      if (!wanted.has(path.dataset.edgeId)) {
        goalTreeEdgeElements.delete(path.dataset.edgeId);
        path.remove();
      } else goalTreeEdgeElements.set(path.dataset.edgeId, path);
    });
    layout.edges.forEach(function (edge, index) {
      var id = edge.from + '>' + edge.to;
      var path = goalTreeEdgeElements.get(id);
      if (!path) {
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'study-goal-edge');
        path.dataset.edgeId = id;
        path.dataset.from = edge.from; path.dataset.to = edge.to;
        goalTreeEdges.appendChild(path);
        goalTreeEdgeElements.set(id, path);
      }
      path.classList.toggle('is-current', layout.model.focusPath.has(edge.from) && layout.model.focusPath.has(edge.to));
      path.style.setProperty('--goal-edge-index', Math.min(index, 10));
    });
  }
  function applyGoalTreeLayoutFrame(layout, placements) {
    if (!goalTreeNodes || !goalTreeEdges) return;
    goalTreeVisualPlacements = new Map();
    placements.forEach(function (placement, id) {
      goalTreeVisualPlacements.set(id, Object.assign({}, placement));
      var element = goalTreeNodeElements.get(id);
      if (element) {
        element.style.left = placement.x + 'px';
        element.style.top = (placement.y - placement.height / 2) + 'px';
      }
    });
    goalTreeEdgeElements.forEach(function (path) {
      var from = placements.get(path.dataset.from), to = placements.get(path.dataset.to);
      if (from && to) path.setAttribute('d', goalTreeEdgePath(from, to));
    });
  }
  function animateGoalTreeLayout(previous, next, duration) {
    if (goalTreeLayoutFrame) cancelAnimationFrame(goalTreeLayoutFrame);
    goalTreeLayoutFrame = 0;
    var nextMap = new Map(next.nodes.map(function (item) { return [item.id, item]; }));
    var previousMap = goalTreeVisualPlacements.size
      ? new Map(Array.from(goalTreeVisualPlacements, function (entry) { return [entry[0], Object.assign({}, entry[1])]; }))
      : new Map((previous && previous.nodes || []).map(function (item) { return [item.id, item]; }));
    next.nodes.forEach(function (item) {
      if (previousMap.has(item.id)) return;
      var parentEdge = next.edges.find(function (edge) { return edge.to === item.id; });
      var parent = parentEdge && (previousMap.get(parentEdge.from) || nextMap.get(parentEdge.from));
      previousMap.set(item.id, parent ? Object.assign({}, item, { x: parent.x, y: parent.y }) : item);
    });
    if (prefersReduced || !previous) { applyGoalTreeLayoutFrame(next, nextMap); return; }
    var start = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var live = new Map();
      nextMap.forEach(function (to, id) {
        var from = previousMap.get(id) || to;
        live.set(id, Object.assign({}, to, {
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
        }));
      });
      applyGoalTreeLayoutFrame(next, live);
      if (t < 1) goalTreeLayoutFrame = requestAnimationFrame(frame);
      else goalTreeLayoutFrame = 0;
    }
    goalTreeLayoutFrame = requestAnimationFrame(frame);
  }
  function renderGoalTree(before, options) {
    if (!goalTreeOpen || !GoalTree || !goalTreeOverlay) return;
    options = options || {};
    var tree = activeGoalTree();
    if (!options.preserveSelect) renderGoalTreeSelect();
    var hasTree = !!tree;
    if (goalTreeEmpty) goalTreeEmpty.hidden = hasTree || goalTreeDetailMode === 'archives';
    if (goalTreeViewport) goalTreeViewport.hidden = !hasTree;
    if (!hasTree) {
      if (goalTreeEdges) goalTreeEdges.innerHTML = '';
      if (goalTreeNodes) goalTreeNodes.innerHTML = '';
      goalTreeNodeElements.clear();
      goalTreeEdgeElements.clear();
      if (goalTreeSummary) goalTreeSummary.innerHTML = '';
      renderGoalTreeDetail();
      return;
    }
    if (!goalTreeSelectedId || (goalTreeSelectedId !== tree.id
        && !(tree.nodes || []).some(function (node) { return node.id === goalTreeSelectedId; }))) {
      goalTreeSelectedId = tree.id;
    }
    var viewState = goalTreeViewState(tree.id);
    var collapsed = new Set(viewState.collapsedBranchIds);
    var expanded = new Set(viewState.expandedTaskIds);
    var sourceTasks = goalTreeArchivePayload ? [] : state.tasks;
    var seed = GoalTree.layout(tree, sourceTasks, {
      collapsedIds: Array.from(collapsed), expandedTaskIds: Array.from(expanded),
    });
    var previousLayout = goalTreeRenderLayout;
    goalTreeRenderLayout = seed;
    syncGoalTreeNodeElements(seed, tree, before, { preserveMarkup: !!options.preserveMarkup });
    var layout = GoalTree.layout(tree, sourceTasks, {
      collapsedIds: Array.from(collapsed), expandedTaskIds: Array.from(expanded),
      sizes: measureGoalTreeNodes(seed),
    });
    if (options.localMove && previousLayout && GoalTree.localizedLayout) {
      layout = GoalTree.localizedLayout(
        previousLayout,
        layout,
        options.localMove.beforeTree,
        tree,
        options.localMove.nodeId,
        { gap: 10 },
      );
    }
    goalTreeRenderLayout = layout;
    syncGoalTreeNodeElements(layout, tree, before, { preserveMarkup: !!options.preserveMarkup });
    if (goalTreeScene) {
      goalTreeScene.style.width = layout.bounds.width + 'px';
      goalTreeScene.style.height = layout.bounds.height + 'px';
    }
    if (goalTreeEdges) {
      goalTreeEdges.setAttribute('viewBox', '0 0 ' + layout.bounds.width + ' ' + layout.bounds.height);
      syncGoalTreeEdgeElements(layout);
    }
    if (goalTreeSummary && !options.preserveSummary) {
      var rootMetrics = layout.model.rootMetrics;
      var focusedTasks = (tree.focusTaskIds || []).map(findTask).filter(Boolean);
      var summaryPercent = Math.round(rootMetrics.progress * 100);
      var oldSummaryPercent = before && Number.isFinite(before.summaryProgress) ? before.summaryProgress : summaryPercent;
      goalTreeSummary.innerHTML = '<strong data-goal-progress-number data-value="' + oldSummaryPercent
        + '" data-target-value="' + summaryPercent + '">' + Math.round(oldSummaryPercent) + '%</strong><span>'
        + rootMetrics.leafCount + ' 项任务'
        + (focusedTasks.length ? ' · ' + focusedTasks.length + ' 项进行中' : ' · 尚未标记进行中') + '</span>';
    }
    if (!options.preserveDetail) renderGoalTreeDetail();
    applyGoalTreeView();
    if (goalTreeNeedsFit) {
      goalTreeNeedsFit = false;
      requestAnimationFrame(fitGoalTree);
    }
    animateGoalTreeLayout(previousLayout, layout, Number(options.duration) || 320);
    requestAnimationFrame(settleGoalTreeProgressBars);
  }

  function settleGoalTreeProgressBars(affectedIds) {
    if (!goalTreeOverlay) return;
    if (affectedIds && affectedIds.size) {
      affectedIds.forEach(function (id) {
        var element = goalTreeNodeElements.get(id);
        var fill = element && element.querySelector('[data-goal-progress-target]');
        if (fill) fill.style.width = Number(fill.dataset.goalProgressTarget || 0) + '%';
      });
    } else {
      goalTreeOverlay.querySelectorAll('[data-goal-progress-target]').forEach(function (fill) {
        fill.style.width = Number(fill.dataset.goalProgressTarget || 0) + '%';
      });
    }
    var number = goalTreeSummary && goalTreeSummary.querySelector('[data-goal-progress-number]');
    if (!number) return;
    var from = Number(number.dataset.value || 0);
    var to = Number(number.dataset.targetValue || from);
    if (goalTreeSummaryFrame) cancelAnimationFrame(goalTreeSummaryFrame);
    goalTreeSummaryFrame = 0;
    if (prefersReduced || Math.abs(to - from) < .1) {
      number.textContent = Math.round(to) + '%';
      number.dataset.value = String(to);
      return;
    }
    var start = performance.now();
    function frame(now) {
      if (!number.isConnected) return;
      var t = Math.min(1, (now - start) / 560);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = from + (to - from) * eased;
      number.textContent = Math.round(value) + '%';
      number.dataset.value = String(value);
      if (t < 1) goalTreeSummaryFrame = requestAnimationFrame(frame);
      else goalTreeSummaryFrame = 0;
    }
    goalTreeSummaryFrame = requestAnimationFrame(frame);
  }
  function syncGoalTreeDetailProgress(task) {
    if (!goalTreeDetail || !task) return;
    var selection = goalTreeSelection();
    if (!selection.node || selection.node.kind !== 'task' || selection.node.taskId !== task.id) return;
    var progress = taskProgress(task);
    var value = goalTreeDetail.querySelector('[data-role="study-goal-task-progress-value"]');
    if (value) value.textContent = progress.target ? progress.current + ' / ' + progress.target : (task.status === 'done' ? '已完成' : '未设置');
    var shell = goalTreeDetail.querySelector('[data-role="study-goal-detail-progress-track"]');
    if (shell) syncStudyProgressBar(shell, task);
    goalTreeDetail.querySelectorAll('[data-action="study-goal-tree-progress"]').forEach(function (button) {
      var delta = Number(button.dataset.delta || 0);
      button.disabled = delta < 0 ? progress.current <= 0 : progress.current >= progress.target;
    });
  }
  function syncGoalTreeProgress(taskId) {
    var tree = activeGoalTree();
    if (!goalTreeOpen || !tree || goalTreeArchivePayload || !GoalTree) return;
    var task = findTask(taskId);
    var model = GoalTree.buildModel(tree, state.tasks);
    if (!task || !model || !goalTreeRenderLayout) return;
    var previousModel = goalTreeRenderLayout.model;
    var affectedIds = new Set([tree.id]);
    var taskNode = model.tree.nodes.find(function (node) {
      return node.kind === 'task' && node.taskId === taskId;
    });
    var cursor = taskNode;
    while (cursor) {
      affectedIds.add(cursor.id);
      cursor = cursor.parentId ? model.byId.get(cursor.parentId) : null;
    }
    model.availability.forEach(function (availability, nodeId) {
      var previous = previousModel && previousModel.availability && previousModel.availability.get(nodeId);
      if (!previous || previous.available !== availability.available || previous.reason !== availability.reason) {
        affectedIds.add(nodeId);
      }
    });
    goalTreeRenderLayout.model = model;
    var liveMilestones = new Map(GoalTree.milestonesForTask(task).map(function (item) { return [item.id, item]; }));
    goalTreeRenderLayout.nodes.forEach(function (placement) {
      if (placement.kind === 'milestone' && placement.node.taskId === taskId) affectedIds.add(placement.id);
      if (!affectedIds.has(placement.id)) return;
      if (placement.kind === 'root') placement.metrics = model.rootMetrics;
      else if (placement.kind === 'branch') placement.metrics = model.metrics.get(placement.id);
      else if (placement.kind === 'task' || placement.kind === 'archive') {
        placement.metrics = model.ownMetrics.get(placement.id);
        placement.subtreeMetrics = model.subtreeMetrics.get(placement.id);
        placement.availability = model.availability.get(placement.id);
      } else if (placement.kind === 'milestone' && placement.node.taskId === taskId) {
        var liveMilestone = liveMilestones.get(placement.node.milestone.id);
        if (liveMilestone) placement.node.milestone = liveMilestone;
        placement.metrics = { leafCount: 0, progress: placement.node.milestone.reached ? 1 : 0, complete: placement.node.milestone.reached };
      }
      var element = goalTreeNodeElements.get(placement.id);
      if (!element) return;
      var metrics = placement.metrics || { progress: 0, complete: false };
      element.dataset.progress = String(Math.round((metrics.progress || 0) * 100));
      element.classList.toggle('is-complete', !!metrics.complete);
      element.classList.toggle('is-blocked', !!(placement.availability && !placement.availability.available));
      var meta = element.querySelector(':scope > div > span');
      if (meta) meta.textContent = goalTreePlacementMeta(placement);
      if (placement.kind === 'task' || placement.kind === 'archive') {
        syncGoalTreeNodeProgress(element, placement);
      } else if (placement.kind === 'root' || placement.kind === 'branch') {
        var fill = element.querySelector('[data-goal-progress-target]');
        if (fill) fill.dataset.goalProgressTarget = String(Math.round((metrics.progress || 0) * 100));
      }
    });
    if (goalTreeSummary) {
      var number = goalTreeSummary.querySelector('[data-goal-progress-number]');
      if (number) number.dataset.targetValue = String(Math.round(model.rootMetrics.progress * 100));
      var copy = goalTreeSummary.querySelector('span');
      if (copy) {
        var focusedTasks = (tree.focusTaskIds || []).map(findTask).filter(Boolean);
        copy.textContent = model.rootMetrics.leafCount + ' 项任务'
          + (focusedTasks.length ? ' · ' + focusedTasks.length + ' 项进行中' : ' · 尚未标记进行中');
      }
    }
    settleGoalTreeProgressBars(affectedIds);
    syncGoalTreeDetailProgress(task);
  }

  function renderGoalTreeDetail() {
    if (!goalTreeDetail) return;
    if (goalTreeDetailFrame) cancelAnimationFrame(goalTreeDetailFrame);
    goalTreeDetail.classList.remove('is-presented');
    renderGoalTreeDetailContent();
    void goalTreeDetail.offsetWidth;
    goalTreeDetailFrame = requestAnimationFrame(function () {
      goalTreeDetailFrame = 0;
      goalTreeDetail.classList.add('is-presented');
    });
  }

  function refreshGoalTreeDetailStable() {
    if (!goalTreeDetail) return;
    if (goalTreeDetailFrame) cancelAnimationFrame(goalTreeDetailFrame);
    goalTreeDetailFrame = 0;
    renderGoalTreeDetailContent();
    goalTreeDetail.classList.add('is-presented');
  }

  function renderGoalTreeDetailContent() {
    if (!goalTreeDetail) return;
    var tree = activeGoalTree();
    if (goalTreeDetailMode === 'archives') {
      var archives = state.goalTreeArchives || [];
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">ARCHIVE</p><h3>目标树归档</h3></header>'
        + (archives.length ? '<div class="study-goal-tree-archive-list">' + archives.map(function (item) {
            return '<button type="button" data-action="study-goal-tree-archive-open" data-archive-id="'
              + escapeHtml(item.id) + '"><strong data-user-content>' + escapeHtml(item.title) + '</strong><span>'
              + escapeHtml((item.archivedAt || '').slice(0, 10)) + ' · ' + item.leafCount + ' 项</span></button>';
          }).join('') + '</div>' : '<p class="study-goal-tree-detail-empty">还没有归档的目标树。</p>')
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-archives-back">返回当前目标</button>';
      return;
    }
    if (goalTreeArchivePayload) {
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">ARCHIVED</p><h3 data-user-content>'
        + escapeHtml(goalTreeArchivePayload.tree.title) + '</h3></header><p class="study-goal-tree-detail-note" data-user-content>'
        + escapeHtml(goalTreeArchivePayload.tree.note || '这是一份只读的完成快照。') + '</p>'
        + '<dl><div><dt>归档时间</dt><dd>' + escapeHtml((goalTreeArchivePayload.archivedAt || '').replace('T', ' '))
        + '</dd></div><div><dt>完成任务</dt><dd>' + Number(goalTreeArchivePayload.leafCount || 0) + '</dd></div></dl>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-archives-back">返回活动目标</button>';
      return;
    }
    if (goalTreeDetailMode === 'new-tree' || !tree) {
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">NEW GOAL</p><h3>创建目标树</h3></header>'
        + '<form data-role="study-goal-tree-new-form"><label><span>长期目标</span><input name="title" maxlength="160" required placeholder="例如：完成计算机网络专业课"></label>'
        + '<label><span>说明 · 可选</span><textarea name="note" maxlength="1000" rows="4" placeholder="写下范围或完成标准"></textarea></label>'
        + '<button type="submit" class="study-goal-tree-primary">创建目标树</button></form>';
      return;
    }
    if (goalTreePendingTaskId) {
      var pending = findTask(goalTreePendingTaskId);
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">ATTACH TASK</p><h3>加入目标树</h3></header>'
        + '<p class="study-goal-tree-picked-task" data-user-content>' + escapeHtml(pending ? pending.title : '学习任务') + '</p>'
        + '<form data-role="study-goal-tree-attach-form"><label><span>放入分支</span><select name="parentId">'
        + goalTreeParentOptions(tree, '') + '</select></label><button type="submit" class="study-goal-tree-primary">加入当前目标</button>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-attach-cancel">取消</button></form>';
      return;
    }
    var node = goalTreeSelectedId === tree.id ? { id: tree.id, kind: 'root', title: tree.title, note: tree.note || '' }
      : (tree.nodes || []).find(function (item) { return item.id === goalTreeSelectedId; });
    if (!node) node = { id: tree.id, kind: 'root', title: tree.title, note: tree.note || '' };
    if (goalTreeDetailMode === 'add-branch') {
      var branchParent = node.kind === 'branch' ? node.id : (node.parentId || '');
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">NEW BRANCH</p><h3>添加课程模块</h3></header>'
        + '<form data-role="study-goal-tree-branch-form"><input type="hidden" name="parentId" value="' + escapeHtml(branchParent) + '">'
        + '<label><span>模块名称</span><input name="title" maxlength="160" required placeholder="例如：传输层"></label>'
        + '<label><span>说明 · 可选</span><textarea name="note" maxlength="1000" rows="4"></textarea></label>'
        + '<button type="submit" class="study-goal-tree-primary">添加模块</button><button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-detail-back">取消</button></form>';
      return;
    }
    if (goalTreeDetailMode === 'add-task') {
      var taskParent = ['branch', 'task', 'archive'].includes(node.kind) ? node.id : (node.parentId || '');
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">ADD TASK</p><h3>添加学习任务</h3></header>'
        + '<form data-role="study-goal-tree-create-task-form"><input type="hidden" name="parentId" value="' + escapeHtml(taskParent) + '">'
        + '<label><span>新任务</span><input name="title" maxlength="160" required placeholder="写下一个可执行任务"></label>'
        + '<button type="submit" class="study-goal-tree-primary">创建并加入</button></form>'
        + '<div class="study-goal-tree-detail-divider"><span>或选择已有任务</span></div>'
        + '<form data-role="study-goal-tree-existing-task-form"><input type="hidden" name="parentId" value="' + escapeHtml(taskParent) + '">'
        + '<select name="taskId">' + goalTreeTaskOptions() + '</select><button type="submit" class="study-goal-tree-secondary">加入选中任务</button></form>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-detail-back">返回</button>';
      return;
    }
    if (goalTreeDetailMode === 'move-task' && node.kind === 'task') {
      var movingTask = findTask(node.taskId);
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">MOVE TASK</p><h3>移动学习任务</h3></header>'
        + '<p class="study-goal-tree-picked-task" data-user-content>' + escapeHtml(movingTask ? movingTask.title : '学习任务') + '</p>'
        + '<p class="study-goal-tree-detail-hint">选择新的归属分支。列表按目标树层级排列，移动后会自动重新布局。</p>'
        + '<div class="study-goal-tree-destinations" role="listbox" aria-label="选择目标分支">'
        + goalTreeDestinationList(tree, node.parentId || '', node.id) + '</div>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-detail-back">取消</button>';
      return;
    }
    if (node.kind === 'task') {
      var task = findTask(node.taskId);
      var progress = taskProgress(task || {});
      var focused = (tree.focusTaskIds || []).includes(node.taskId);
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">STUDY TASK</p><h3 data-user-content>' + escapeHtml(task ? task.title : '已移除任务') + '</h3></header>'
        + '<div class="study-goal-tree-task-progress" data-role="study-goal-task-progress"><div><span>总进度</span><strong data-role="study-goal-task-progress-value">'
        + (progress.target ? progress.current + ' / ' + progress.target : (task && task.status === 'done' ? '已完成' : '未设置'))
        + '</strong></div><span data-role="study-goal-detail-progress-shell"></span></div>'
        + (progress.target && task && task.status !== 'done' ? '<div class="study-goal-tree-progress-actions"><button type="button" data-action="study-goal-tree-progress" data-delta="-1"'
          + (progress.current <= 0 ? ' disabled' : '') + '>−1</button><button type="button" data-action="study-goal-tree-progress" data-delta="1"'
          + (progress.current >= progress.target ? ' disabled' : '') + '>＋1</button></div>' : '')
        + '<div class="study-goal-tree-detail-actions"><button type="button" class="study-goal-tree-primary" data-action="study-goal-tree-current"'
        + (task && task.status === 'done' ? ' disabled' : '') + '>' + (focused ? '取消进行中' : '标记为进行中') + '</button>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-task-complete">'
        + (task && task.status === 'done' ? '恢复为未完成' : '标记完成') + '</button>'
        + '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-task-settings">任务设置</button>'
        + '<details class="study-goal-tree-action-menu"><summary>＋ 添加</summary><button type="button" data-action="study-goal-tree-add-task">子任务或已有任务</button></details>'
        + '<details class="study-goal-tree-action-menu"><summary>更多</summary><button type="button" data-action="study-goal-tree-task-move">移动到其他分支</button>'
        + '<button type="button" class="study-goal-tree-danger" data-action="study-goal-tree-task-detach">从目标树移除</button></details></div>';
      var detailProgressHost = goalTreeDetail.querySelector('[data-role="study-goal-detail-progress-shell"]');
      if (detailProgressHost && task && progress.target) detailProgressHost.appendChild(buildStudyProgressShell(task, { role: 'study-goal-detail-progress-track' }));
      return;
    }
    if (node.kind === 'archive') {
      goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">ARCHIVED TASK</p><h3 data-user-content>' + escapeHtml(node.title) + '</h3></header>'
        + '<p class="study-goal-tree-detail-note">这项任务已经从普通清单归档，作为完成成果保留在目标树中。</p>'
        + '<div class="study-goal-tree-detail-actions"><details class="study-goal-tree-action-menu"><summary>＋ 添加</summary>'
        + '<button type="button" data-action="study-goal-tree-add-task">子任务或已有任务</button></details></div>';
      return;
    }
    var isRoot = node.kind === 'root';
    var metrics = goalTreeRenderLayout && goalTreeRenderLayout.model.metrics.get(node.id);
    goalTreeDetail.innerHTML = '<header><p class="study-eyebrow">' + (isRoot ? 'LONG-TERM GOAL' : 'COURSE BRANCH') + '</p><h3 data-user-content>'
      + escapeHtml(node.title) + '</h3></header><form data-role="study-goal-tree-node-form"><label><span>名称</span><input name="title" maxlength="160" value="'
      + escapeHtml(node.title) + '" required></label><label><span>说明 · 可选</span><textarea name="note" maxlength="1000" rows="5">'
      + escapeHtml(node.note || '') + '</textarea></label><button type="submit" class="study-goal-tree-primary">保存</button></form>'
      + '<dl><div><dt>分支进度</dt><dd>' + (metrics && metrics.leafCount ? Math.round(metrics.progress * 100) + '%' : '—') + '</dd></div><div><dt>任务数量</dt><dd>'
      + (metrics ? metrics.leafCount : 0) + '</dd></div></dl><div class="study-goal-tree-detail-actions">'
      + '<details class="study-goal-tree-action-menu"><summary>＋ 添加</summary>'
      + '<button type="button" data-action="study-goal-tree-add-branch">模块</button>'
      + '<button type="button" data-action="study-goal-tree-add-task">新任务或已有任务</button></details>'
      + (isRoot ? '<button type="button" class="study-goal-tree-secondary" data-action="study-goal-tree-archive"'
        + (metrics && metrics.complete ? '' : ' disabled') + '>归档目标树</button><button type="button" class="study-goal-tree-danger" data-action="study-goal-tree-delete">删除目标树</button>'
        : '<button type="button" class="study-goal-tree-danger" data-action="study-goal-tree-branch-delete">删除模块并提升子项</button>')
      + '</div>';
  }

  function openGoalTree(trigger, taskId, detailMode) {
    if (!goalTreeOverlay || !GoalTree) return;
    ensureStudyLoaded().then(function (loaded) {
      if (!loaded) return;
      goalTreeLastTrigger = trigger && trigger.isConnected ? trigger : document.activeElement;
      if (taskId && !goalTreeOwner(taskId)) goalTreePendingTaskId = taskId;
      var owner = taskId && goalTreeOwner(taskId);
      if (owner) {
        goalTreeActiveId = owner.tree.id;
        goalTreeSelectedId = owner.node.id;
      }
      if (!goalTreeActiveId) {
        try { goalTreeActiveId = localStorage.getItem(GOAL_TREE_ACTIVE_KEY) || ''; } catch (e) {}
      }
      if (!state.goalTrees.some(function (tree) { return tree.id === goalTreeActiveId; })) {
        goalTreeActiveId = state.goalTrees[0] ? state.goalTrees[0].id : '';
      }
      goalTreeDetailMode = detailMode || (state.goalTrees.length ? 'node' : 'new-tree');
      goalTreeArchivePayload = null;
      if (goalTreeLayoutFrame) cancelAnimationFrame(goalTreeLayoutFrame);
      goalTreeLayoutFrame = 0;
      goalTreeRenderLayout = null;
      goalTreeVisualPlacements.clear();
      goalTreeOpen = true;
      var openSeq = ++goalTreeOverlaySeq;
      goalTreeNeedsFit = true;
      goalTreeOverlay.hidden = false;
      document.body.classList.add('study-goal-tree-open');
      if (goalTreePanel && trigger && trigger.getBoundingClientRect) {
        var source = trigger.getBoundingClientRect();
        var target = goalTreePanel.getBoundingClientRect();
        goalTreePanel.style.setProperty('--goal-open-x', (source.left + source.width / 2 - target.left - target.width / 2) + 'px');
        goalTreePanel.style.setProperty('--goal-open-y', (source.top + source.height / 2 - target.top - target.height / 2) + 'px');
        goalTreePanel.style.setProperty('--goal-open-sx', Math.max(.08, source.width / target.width));
        goalTreePanel.style.setProperty('--goal-open-sy', Math.max(.05, source.height / target.height));
      }
      goalTreeOverlay.classList.remove('is-visible', 'is-closing');
      goalTreeOverlay.classList.add('is-opening');
      renderGoalTree();
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        goalTreeOverlay.classList.add('is-visible');
        window.setTimeout(function () {
          if (!goalTreeOpen || openSeq !== goalTreeOverlaySeq) return;
          goalTreeOverlay.classList.remove('is-opening');
          var focus = goalTreeNodes && goalTreeNodes.querySelector('.study-goal-node.is-selected');
          if (focus) focus.focus({ preventScroll: true }); else if (goalTreeSelect) goalTreeSelect.focus();
        }, prefersReduced ? 0 : 540);
      }); });
    });
  }
  function closeGoalTree() {
    if (!goalTreeOpen || !goalTreeOverlay) return;
    if (goalTreeDrag) finishGoalTreeNodeDrag(true);
    goalTreeOpen = false;
    var closeSeq = ++goalTreeOverlaySeq;
    goalTreeConfirmAction = null;
    closeGoalTreeConfirm(true);
    stopGoalTreeViewAnimation();
    if (goalTreePanInertiaFrame) cancelAnimationFrame(goalTreePanInertiaFrame);
    goalTreePanInertiaFrame = 0;
    if (goalTreeLayoutFrame) cancelAnimationFrame(goalTreeLayoutFrame);
    goalTreeLayoutFrame = 0;
    removeGoalTreeDropElements();
    if (goalTreeNodes) goalTreeNodes.innerHTML = '';
    if (goalTreeEdges) goalTreeEdges.innerHTML = '';
    goalTreeNodeElements.clear();
    goalTreeEdgeElements.clear();
    goalTreeVisualPlacements.clear();
    goalTreeRenderLayout = null;
    goalTreeOverlay.classList.remove('is-visible', 'is-opening');
    goalTreeOverlay.classList.add('is-closing');
    document.body.classList.remove('study-goal-tree-open');
    window.setTimeout(function () {
      if (closeSeq !== goalTreeOverlaySeq || goalTreeOpen) return;
      goalTreeOverlay.hidden = true;
      goalTreeOverlay.classList.remove('is-closing');
      goalTreeArchivePayload = null;
      goalTreePendingTaskId = '';
      if (goalTreeLastTrigger && goalTreeLastTrigger.isConnected) goalTreeLastTrigger.focus();
      goalTreeLastTrigger = null;
    }, prefersReduced ? 0 : 340);
  }
  function openGoalTreeConfirm(title, copy, action) {
    if (!goalTreeConfirm) return;
    goalTreeConfirm.querySelector('[data-role="study-goal-tree-confirm-title"]').textContent = title;
    goalTreeConfirm.querySelector('[data-role="study-goal-tree-confirm-copy"]').textContent = copy;
    goalTreeConfirmAction = action;
    var confirmSeq = ++goalTreeConfirmSeq;
    goalTreeConfirm.hidden = false;
    goalTreeConfirm.classList.remove('is-visible', 'is-closing');
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (confirmSeq !== goalTreeConfirmSeq || goalTreeConfirm.hidden) return;
      goalTreeConfirm.classList.add('is-visible');
      var button = goalTreeConfirm.querySelector('[data-action="study-goal-tree-confirm-ok"]');
      if (button) button.focus();
    }); });
  }
  function closeGoalTreeConfirm(instant) {
    goalTreeConfirmAction = null;
    if (!goalTreeConfirm || goalTreeConfirm.hidden) return;
    var confirmSeq = ++goalTreeConfirmSeq;
    goalTreeConfirm.classList.remove('is-visible');
    goalTreeConfirm.classList.add('is-closing');
    window.setTimeout(function () {
      if (confirmSeq !== goalTreeConfirmSeq) return;
      goalTreeConfirm.hidden = true;
      goalTreeConfirm.classList.remove('is-closing');
    }, instant || prefersReduced ? 0 : 220);
  }

  function goalTreeSelection() {
    var tree = activeGoalTree();
    if (!tree) return { tree: null, node: null };
    if (goalTreeSelectedId === tree.id) return { tree: tree, node: { id: tree.id, kind: 'root' } };
    var placement = goalTreeRenderLayout && goalTreeRenderLayout.nodes.find(function (item) {
      return item.id === goalTreeSelectedId;
    });
    if (placement && placement.kind === 'milestone') {
      return {
        tree: tree,
        node: (tree.nodes || []).find(function (item) { return item.id === placement.node.taskNodeId; }) || null,
        milestone: placement.node.milestone,
      };
    }
    return {
      tree: tree,
      node: (tree.nodes || []).find(function (item) { return item.id === goalTreeSelectedId; }) || null,
    };
  }
  function setGoalTreeDetailMode(mode) {
    goalTreeDetailMode = mode || 'node';
    renderGoalTreeDetail();
    var first = goalTreeDetail && goalTreeDetail.querySelector('input, textarea, select, button');
    if (first && (mode === 'add-branch' || mode === 'add-task' || mode === 'new-tree')) first.focus();
  }
  function selectGoalTreeNode(nodeId, focus) {
    goalTreeSelectedId = nodeId;
    goalTreeDetailMode = 'node';
    var tree = activeGoalTree();
    var structural = tree && (tree.nodes || []).find(function (item) { return item.id === nodeId; });
    if (structural && structural.kind === 'task' && GoalTree.milestonesForTask(findTask(structural.taskId)).length) {
      var expanded = goalTreeExpanded(tree.id);
      if (!expanded.has(nodeId)) {
        expanded.add(nodeId);
        saveGoalTreeViewState(tree.id, { expandedTaskIds: Array.from(expanded) });
        renderGoalTree(captureGoalTreeRects());
      }
    }
    if (goalTreeNodes) {
      goalTreeNodes.querySelectorAll('.study-goal-node.is-selected').forEach(function (item) {
        item.classList.remove('is-selected');
      });
      var selected = goalTreeNodes.querySelector('[data-node-id="' + CSS.escape(nodeId) + '"]');
      if (selected) {
        selected.classList.add('is-selected');
        if (focus) selected.focus({ preventScroll: true });
      }
    }
    renderGoalTreeDetail();
  }
  function beginGoalTreeInlineRename(item) {
    if (!item || goalTreeArchivePayload || item.dataset.kind === 'milestone' || item.dataset.kind === 'archive') return;
    var label = item.querySelector('strong');
    if (!label || label.isContentEditable) return;
    var original = label.textContent;
    label.contentEditable = 'plaintext-only';
    label.classList.add('is-editing');
    label.focus();
    var selection = window.getSelection();
    if (selection) { var range = document.createRange(); range.selectNodeContents(label); selection.removeAllRanges(); selection.addRange(range); }
    var finished = false;
    function finish(cancel) {
      if (finished) return; finished = true;
      label.removeEventListener('blur', onBlur); label.removeEventListener('keydown', onKey);
      label.contentEditable = 'false'; label.classList.remove('is-editing');
      var title = cancel ? original : String(label.textContent || '').trim();
      if (!title) title = original;
      label.textContent = title;
      if (cancel || title === original) return;
      var selectionState = goalTreeSelection();
      var tree = selectionState.tree, node = selectionState.node;
      if (!tree || !node) return;
      if (node.kind === 'task') {
        var task = findTask(node.taskId);
        if (task) queueTaskPatch(task, { title: title }, { skipGoalTreeRender: true }).then(function () { renderGoalTree(); });
      } else {
        goalTreeCommand(node.kind === 'root' ? 'update-tree' : 'update-branch', {
          treeId: tree.id, nodeId: node.kind === 'root' ? undefined : node.id, title: title,
        });
      }
    }
    function onBlur() { finish(false); }
    function onKey(event) {
      if (event.key === 'Enter') { event.preventDefault(); label.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(true); item.focus(); }
    }
    label.addEventListener('blur', onBlur); label.addEventListener('keydown', onKey);
  }
  function createGoalTreeRelative(node, asChild) {
    var tree = activeGoalTree();
    if (!tree || !node || goalTreeArchivePayload) return;
    var command, payload;
    if (node.kind === 'task' && asChild) {
      command = 'create-task';
      payload = { treeId: tree.id, parentId: node.id, taskSlot: { kind: 'end' }, title: '未命名任务' };
    } else if (node.kind === 'archive') {
      return showToast('归档快照只用于承载已有结构');
    } else if (node.kind === 'task') {
      command = 'create-task';
      payload = { treeId: tree.id, parentId: node.parentId || '', taskSlot: node.taskSlot || null, title: '未命名任务' };
    } else {
      command = 'create-branch';
      payload = { treeId: tree.id, parentId: asChild && node.kind === 'branch' ? node.id : (node.kind === 'root' ? '' : (node.parentId || '')), title: '未命名模块' };
    }
    goalTreeCommand(command, payload, { mode: 'node' }).then(function (json) {
      if (!json || !json.nodeId) return;
      var item = goalTreeNodes && goalTreeNodes.querySelector('[data-node-id="' + CSS.escape(json.nodeId) + '"]');
      if (item) beginGoalTreeInlineRename(item);
    });
  }
  function toggleGoalTreeBranch(nodeId) {
    var tree = activeGoalTree();
    if (!tree) return;
    var collapsed = goalTreeCollapsed(tree.id);
    if (collapsed.has(nodeId)) collapsed.delete(nodeId); else collapsed.add(nodeId);
    saveGoalTreeViewState(tree.id, { collapsedBranchIds: Array.from(collapsed) });
    renderGoalTree(captureGoalTreeRects());
  }
  function toggleGoalTreeTask(nodeId) {
    var tree = activeGoalTree();
    if (!tree) return;
    var expanded = goalTreeExpanded(tree.id);
    if (expanded.has(nodeId)) expanded.delete(nodeId); else expanded.add(nodeId);
    saveGoalTreeViewState(tree.id, { expandedTaskIds: Array.from(expanded) });
    renderGoalTree(captureGoalTreeRects());
  }
  function recommendNextGoalTask(tree) {
    var model = GoalTree && GoalTree.buildModel(tree, state.tasks);
    var task = model && findTask(model.nextTaskId);
    if (!task) return;
    openGoalTreeConfirm('继续推进下一项？', '建议按树顺序推进“' + task.title + '”。确认后会将它标记为进行中。', function () {
      return goalTreeCommand('set-focus', { treeId: tree.id, taskId: task.id, focused: true });
    });
  }
  function loadGoalTreeArchive(archiveId) {
    api('/api/study-goal-tree-archive?id=' + encodeURIComponent(archiveId)).then(function (payload) {
      goalTreeArchivePayload = payload;
      goalTreeActiveId = '';
      goalTreeSelectedId = payload.tree && payload.tree.id || '';
      goalTreeDetailMode = 'node';
      goalTreeNeedsFit = true;
      renderGoalTree();
    }).catch(function (error) { showToast(error.message); });
  }
  function handleGoalTreeAction(action, control) {
    var selection = goalTreeSelection();
    var tree = selection.tree;
    var node = selection.node;
    if (action === 'study-goal-tree-close') return closeGoalTree();
    if (action === 'study-goal-tree-new') {
      goalTreeArchivePayload = null;
      return setGoalTreeDetailMode('new-tree');
    }
    if (action === 'study-goal-tree-archives') {
      goalTreeArchivePayload = null;
      return setGoalTreeDetailMode('archives');
    }
    if (action === 'study-goal-tree-archives-back') {
      goalTreeArchivePayload = null;
      if (!goalTreeActiveId) goalTreeActiveId = state.goalTrees[0] ? state.goalTrees[0].id : '';
      goalTreeSelectedId = goalTreeActiveId;
      goalTreeDetailMode = state.goalTrees.length ? 'node' : 'new-tree';
      goalTreeNeedsFit = true;
      return renderGoalTree();
    }
    if (action === 'study-goal-tree-archive-open') return loadGoalTreeArchive(control.dataset.archiveId || '');
    if (action === 'study-goal-tree-fit') return fitGoalTree();
    if (action === 'study-goal-node-collapse') {
      var collapseNode = control.closest('[data-node-id]');
      return collapseNode && toggleGoalTreeBranch(collapseNode.dataset.nodeId);
    }
    if (action === 'study-goal-node-expand') {
      var expandNode = control.closest('[data-node-id]');
      return expandNode && toggleGoalTreeTask(expandNode.dataset.nodeId);
    }
    if (action === 'study-goal-tree-confirm-cancel') return closeGoalTreeConfirm();
    if (action === 'study-goal-tree-confirm-ok') {
      var confirmed = goalTreeConfirmAction;
      closeGoalTreeConfirm();
      if (confirmed) Promise.resolve(confirmed()).catch(function (error) { showToast(error.message); });
      return;
    }
    if (action === 'study-goal-tree-attach-cancel') {
      goalTreePendingTaskId = '';
      return setGoalTreeDetailMode('node');
    }
    if (action === 'study-goal-tree-detail-back') return setGoalTreeDetailMode('node');
    if (!tree || !node || goalTreeArchivePayload || goalTreeCommandBusy) return;
    if (action === 'study-goal-tree-move-target' && node.kind === 'task') {
      var nextParentId = control.dataset.parentId || '';
      if (nextParentId === (node.parentId || '')) return setGoalTreeDetailMode('node');
      goalTreeDetailMode = 'node';
      return commitGoalTreeMove(tree, node.id, { parentId: nextParentId, beforeId: '', taskSlot: null });
    }
    if (action === 'study-goal-tree-add-branch') return setGoalTreeDetailMode('add-branch');
    if (action === 'study-goal-tree-add-task') return setGoalTreeDetailMode('add-task');
    if (action === 'study-goal-tree-current' && node.kind === 'task') {
      var isFocused = (tree.focusTaskIds || []).includes(node.taskId);
      return goalTreeCommand('set-focus', {
        treeId: tree.id,
        taskId: node.taskId,
        focused: !isFocused,
      });
    }
    if (action === 'study-goal-tree-task-settings' && node.kind === 'task') {
      var settingsTask = findTask(node.taskId);
      if (settingsTask) openProgressSettings(settingsTask.id, control);
      return;
    }
    if (action === 'study-goal-tree-progress' && node.kind === 'task') {
      var task = findTask(node.taskId);
      if (task) changeTaskProgress(task, Number(control.dataset.delta || 0));
      return;
    }
    if (action === 'study-goal-tree-task-complete' && node.kind === 'task') {
      var selectedTask = findTask(node.taskId);
      if (!selectedTask) return;
      var beforeComplete = captureGoalTreeRects();
      var wasFocused = (tree.focusTaskIds || []).includes(selectedTask.id);
      var nextStatus = selectedTask.status === 'done' ? 'active' : 'done';
      return queueTaskPatch(selectedTask, { status: nextStatus }, { skipGoalTreeRender: true }).then(function () {
        render({ skipGoalTree: true });
        renderGoalTree(beforeComplete);
        if (wasFocused && nextStatus === 'done') {
          var freshTree = state.goalTrees.find(function (item) { return item.id === tree.id; });
          if (freshTree) recommendNextGoalTask(freshTree);
        }
      }).catch(function (error) { showToast(error.message); refresh(); });
    }
    if (action === 'study-goal-tree-task-detach' && node.kind === 'task') {
      return goalTreeCommand('detach-task', { treeId: tree.id, taskId: node.taskId }, { mode: 'node' });
    }
    if (action === 'study-goal-tree-task-move' && node.kind === 'task') {
      return setGoalTreeDetailMode('move-task');
    }
    if (action === 'study-goal-tree-branch-delete' && node.kind === 'branch') {
      return openGoalTreeConfirm('删除这个模块？', '模块中的子模块与任务会提升到上一层，不会删除学习任务。', function () {
        goalTreeSelectedId = tree.id;
        return goalTreeCommand('delete-branch', { treeId: tree.id, nodeId: node.id });
      });
    }
    if (action === 'study-goal-tree-delete' && node.kind === 'root') {
      var snapshots = (tree.nodes || []).filter(function (item) { return item.kind === 'archive'; }).length;
      return openGoalTreeConfirm('删除整棵目标树？', '活动任务会保留为未归属任务。'
        + (snapshots ? '其中 ' + snapshots + ' 条归档快照会一并删除。' : ''), function () {
          goalTreeSelectedId = '';
          return goalTreeCommand('delete-tree', { treeId: tree.id });
        });
    }
    if (action === 'study-goal-tree-archive' && node.kind === 'root') {
      return openGoalTreeConfirm('归档这棵目标树？', '将保存一份只读完成快照，并从活动目标中移除。', function () {
        goalTreeSelectedId = '';
        return goalTreeCommand('archive-tree', { treeId: tree.id });
      });
    }
  }
  function submitGoalTreeForm(form) {
    if (!form || goalTreeCommandBusy) return;
    var values = new FormData(form);
    var selection = goalTreeSelection();
    var tree = selection.tree;
    var node = selection.node;
    var role = form.dataset.role;
    if (role === 'study-goal-tree-new-form') {
      return goalTreeCommand('create-tree', { title: values.get('title'), note: values.get('note') }, { mode: 'node' });
    }
    if (!tree) return;
    if (role === 'study-goal-tree-attach-form') {
      return goalTreeCommand('attach-task', {
        treeId: tree.id, taskId: goalTreePendingTaskId, parentId: values.get('parentId'),
      }, { clearPending: true, mode: 'node' });
    }
    if (role === 'study-goal-tree-branch-form') {
      return goalTreeCommand('create-branch', {
        treeId: tree.id, parentId: values.get('parentId'), title: values.get('title'), note: values.get('note'),
      }, { mode: 'node' });
    }
    if (role === 'study-goal-tree-create-task-form') {
      return goalTreeCommand('create-task', {
        treeId: tree.id, parentId: values.get('parentId'), title: values.get('title'),
      }, { mode: 'node' });
    }
    if (role === 'study-goal-tree-existing-task-form') {
      if (!values.get('taskId')) return showToast('没有可加入的未归属任务');
      return goalTreeCommand('attach-task', {
        treeId: tree.id, parentId: values.get('parentId'), taskId: values.get('taskId'),
      }, { mode: 'node' });
    }
    if (role === 'study-goal-tree-move-task-form' && node && node.kind === 'task') {
      return goalTreeCommand('move-node', {
        treeId: tree.id, nodeId: node.id, parentId: values.get('parentId'),
      }, { mode: 'node' });
    }
    if (role === 'study-goal-tree-node-form' && node) {
      return goalTreeCommand(node.kind === 'root' ? 'update-tree' : 'update-branch', {
        treeId: tree.id,
        nodeId: node.kind === 'root' ? undefined : node.id,
        title: values.get('title'),
        note: values.get('note'),
      });
    }
  }
  function clearGoalTreeDropTarget() {
    goalTreeDropCandidateKey = '';
    if (!goalTreeNodes) return;
    goalTreeNodes.querySelectorAll('.is-drop-parent,.is-reparent-target').forEach(function (node) {
      node.classList.remove('is-drop-parent', 'is-reparent-target');
    });
    if (goalTreeDropSlot) goalTreeDropSlot.hidden = true;
    if (goalTreeReparentBadge) goalTreeReparentBadge.hidden = true;
  }
  function removeGoalTreeDropElements() {
    if (goalTreeDropSlot) { goalTreeDropSlot.remove(); goalTreeDropSlot = null; }
    if (goalTreeReparentBadge) { goalTreeReparentBadge.remove(); goalTreeReparentBadge = null; }
  }
  function beginGoalTreeNodeDrag(event, item) {
    if (event.button !== 0 || goalTreeDrag || goalTreeCommandBusy || item.dataset.draggable !== 'true') return;
    goalTreeDrag = {
      pointerId: event.pointerId,
      source: item,
      nodeId: item.dataset.nodeId,
      startX: event.clientX,
      startY: event.clientY,
      startPoint: goalTreeScenePoint(event.clientX, event.clientY),
      active: false,
      candidate: null,
      baseTree: null,
      baseLayout: null,
      starts: new Map(),
    };
    window.addEventListener('pointermove', onGoalTreeNodeDragMove, { passive: false });
    window.addEventListener('pointerup', onGoalTreeNodeDragEnd);
    window.addEventListener('pointercancel', onGoalTreeNodeDragCancel);
  }
  function activateGoalTreeNodeDrag() {
    var drag = goalTreeDrag;
    if (!drag || drag.active) return;
    if (goalTreeLayoutFrame) cancelAnimationFrame(goalTreeLayoutFrame);
    goalTreeLayoutFrame = 0;
    var tree = state.goalTrees.find(function (item) { return item.id === goalTreeActiveId; });
    drag.baseTree = tree;
    drag.baseLayout = goalTreeRenderLayout && Object.assign({}, goalTreeRenderLayout, {
      nodes: goalTreeRenderLayout.nodes.map(function (item) {
        return goalTreeVisualPlacements.get(item.id) || item;
      }),
    });
    drag.dropContext = GoalTree.prepareDropContext
      ? GoalTree.prepareDropContext(drag.baseLayout, tree, drag.nodeId)
      : null;
    drag.dragIds = drag.dropContext
      ? new Set(drag.dropContext.excluded)
      : GoalTree.subtreeIds(tree, drag.nodeId);
    drag.livePlacements = new Map(drag.baseLayout.nodes.map(function (item) { return [item.id, Object.assign({}, item)]; }));
    drag.baseLayout.nodes.forEach(function (item) {
      if (drag.dragIds.has(item.id)) drag.starts.set(item.id, Object.assign({}, item));
    });
    drag.affectedEdges = drag.baseLayout.edges.filter(function (edge) {
      return drag.dragIds.has(edge.from) || drag.dragIds.has(edge.to);
    });
    drag.dragIds.forEach(function (id) {
      var source = goalTreeNodeElements.get(id);
      if (source) source.classList.add(id === drag.nodeId ? 'is-drag-anchor' : 'is-subtree-dragging');
    });
    drag.active = true;
    document.body.classList.add('study-goal-node-dragging');
    try { drag.source.setPointerCapture(drag.pointerId); } catch (error) {}
  }
  function positionGoalTreeDraggedSubtree(clientX, clientY) {
    var drag = goalTreeDrag;
    if (!drag || !drag.active) return;
    var point = goalTreeScenePoint(clientX, clientY);
    var dx = point.x - drag.startPoint.x, dy = point.y - drag.startPoint.y;
    var live = drag.livePlacements;
    drag.starts.forEach(function (start, id) {
      var placement = Object.assign({}, start, { x: start.x + dx, y: start.y + dy });
      live.set(id, placement);
      var element = goalTreeNodeElements.get(id);
      if (element) element.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
    });
    drag.affectedEdges.forEach(function (edge) {
      var path = goalTreeEdgeElements.get(edge.from + '>' + edge.to);
      var from = live.get(edge.from), to = live.get(edge.to);
      if (path && from && to) path.setAttribute('d', goalTreeEdgePath(from, to));
    });
  }
  function goalTreeScenePoint(clientX, clientY) {
    if (!goalTreeViewport) return { x: 0, y: 0 };
    var rect = goalTreeViewport.getBoundingClientRect();
    var zoom = Math.max(.001, Number(goalTreeView.zoom) || 1);
    return {
      x: (clientX - rect.left - goalTreeView.x) / zoom,
      y: (clientY - rect.top - goalTreeView.y) / zoom,
    };
  }
  function markGoalTreeDropCandidate(candidate) {
    var candidateKey = candidate ? [
      candidate.type, candidate.targetId, candidate.parentId, candidate.beforeId,
      GoalTree.slotKey(candidate.taskSlot), candidate.side,
    ].join('|') : '';
    if (candidateKey === goalTreeDropCandidateKey) return;
    clearGoalTreeDropTarget();
    goalTreeDropCandidateKey = candidateKey;
    if (!candidate || !goalTreeNodes || !goalTreeScene) return;
    if (candidate.type === 'reparent') {
      var target = goalTreeNodeElements.get(candidate.targetId);
      if (target) target.classList.add('is-reparent-target');
      if (!goalTreeReparentBadge) {
        goalTreeReparentBadge = document.createElement('div');
        goalTreeReparentBadge.className = 'study-goal-reparent-badge';
        goalTreeReparentBadge.setAttribute('aria-hidden', 'true');
        goalTreeReparentBadge.textContent = '+';
        goalTreeScene.appendChild(goalTreeReparentBadge);
      }
      var targetPlacement = goalTreeDrag && goalTreeDrag.baseLayout
        && goalTreeDrag.baseLayout.nodes.find(function (item) { return item.id === candidate.targetId; });
      if (targetPlacement) {
        goalTreeReparentBadge.style.left = (targetPlacement.x + targetPlacement.width - 8) + 'px';
        goalTreeReparentBadge.style.top = (targetPlacement.y - targetPlacement.height / 2 - 8) + 'px';
        goalTreeReparentBadge.hidden = false;
      }
      return;
    }
    if (!goalTreeDropSlot) {
      goalTreeDropSlot = document.createElement('div');
      goalTreeDropSlot.className = 'study-goal-drop-slot';
      goalTreeDropSlot.setAttribute('aria-hidden', 'true');
      goalTreeScene.appendChild(goalTreeDropSlot);
    }
    var parentTarget = goalTreeNodeElements.get(candidate.parentId || (goalTreeDrag && goalTreeDrag.baseTree && goalTreeDrag.baseTree.id));
    if (parentTarget) parentTarget.classList.add('is-drop-parent');
    goalTreeDropSlot.hidden = false;
    goalTreeDropSlot.style.left = (candidate.depthCoord - 42) + 'px';
    goalTreeDropSlot.style.top = (candidate.slotCoord - 1.5) + 'px';
    goalTreeDropSlot.style.width = '84px';
    goalTreeDropSlot.style.height = '3px';
  }
  function updateGoalTreeDropCandidate(clientX, clientY) {
    var drag = goalTreeDrag;
    if (!drag || !drag.baseTree || !drag.baseLayout || !GoalTree.structureDropCandidate) return;
    var targetId = '';
    var milestoneId = '';
    if (typeof document.elementsFromPoint === 'function') {
      var hits = document.elementsFromPoint(clientX, clientY);
      for (var i = 0; i < hits.length; i += 1) {
        var nodeElement = hits[i] && hits[i].closest ? hits[i].closest('.study-goal-node[data-node-id]') : null;
        if (!nodeElement || !goalTreeNodes.contains(nodeElement)) continue;
        if (drag.dragIds.has(nodeElement.dataset.nodeId)) continue;
        targetId = nodeElement.dataset.nodeId;
        var milestoneElement = hits[i].closest('[data-milestone-id]');
        if (milestoneElement && nodeElement.contains(milestoneElement)) {
          milestoneId = milestoneElement.dataset.milestoneId || '';
        }
        break;
      }
    }
    drag.candidate = GoalTree.structureDropCandidate(
      drag.baseLayout, drag.baseTree, drag.nodeId, goalTreeScenePoint(clientX, clientY),
      { targetId: targetId, milestoneId: milestoneId, rowGap: 30, levelGap: 92, context: drag.dropContext },
    );
    markGoalTreeDropCandidate(drag.candidate);
  }
  function autoPanGoalTreeDuringDrag(clientX, clientY) {
    if (!goalTreeViewport) return false;
    var rect = goalTreeViewport.getBoundingClientRect();
    var edge = 56;
    var dx = clientX < rect.left + edge ? Math.min(11, (rect.left + edge - clientX) * .18)
      : clientX > rect.right - edge ? -Math.min(11, (clientX - rect.right + edge) * .18) : 0;
    var dy = clientY < rect.top + edge ? Math.min(11, (rect.top + edge - clientY) * .18)
      : clientY > rect.bottom - edge ? -Math.min(11, (clientY - rect.bottom + edge) * .18) : 0;
    if (!dx && !dy) return false;
    stopGoalTreeViewAnimation();
    goalTreeView.x += dx;
    goalTreeView.y += dy;
    goalTreeViewTarget = Object.assign({}, goalTreeView);
    applyGoalTreeView();
    return true;
  }
  function flushGoalTreeDragFrame(allowAutoPan) {
    var drag = goalTreeDrag;
    goalTreeDragFrame = 0;
    if (!drag || !drag.active) return;
    var panned = allowAutoPan !== false
      && autoPanGoalTreeDuringDrag(drag.latestClientX, drag.latestClientY);
    positionGoalTreeDraggedSubtree(drag.latestClientX, drag.latestClientY);
    updateGoalTreeDropCandidate(drag.latestClientX, drag.latestClientY);
    if (panned && goalTreeDrag && goalTreeDrag.active) {
      goalTreeDragFrame = requestAnimationFrame(function () { flushGoalTreeDragFrame(true); });
    }
  }
  function onGoalTreeNodeDragMove(event) {
    var drag = goalTreeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
    if (!drag.active) activateGoalTreeNodeDrag();
    event.preventDefault();
    drag.latestClientX = event.clientX;
    drag.latestClientY = event.clientY;
    if (!goalTreeDragFrame) {
      goalTreeDragFrame = requestAnimationFrame(function () { flushGoalTreeDragFrame(true); });
    }
  }
  function commitGoalTreeMove(tree, nodeId, destination) {
    var preview = GoalTree.previewMove(tree, nodeId, destination.parentId, destination.beforeId, destination.taskSlot, destination.side);
    if (!preview) return Promise.resolve(null);
    state.goalTrees = state.goalTrees.map(function (item) { return item.id === tree.id ? preview : item; });
    renderGoalTree(null, {
      duration: 260,
      preserveMarkup: true,
      preserveDetail: true,
      preserveSummary: true,
      preserveSelect: true,
      localMove: { beforeTree: tree, nodeId: nodeId },
    });
    return goalTreeCommand('move-node', {
      treeId: tree.id, nodeId: nodeId, parentId: destination.parentId,
      beforeId: destination.beforeId, taskSlot: destination.taskSlot, side: destination.side,
    }, { duration: 260, skipGoalTreeRender: true, rollbackTree: tree, rollbackNodeId: nodeId });
  }
  function finishGoalTreeNodeDrag(cancelled) {
    var drag = goalTreeDrag;
    if (!drag) return;
    if (goalTreeDragFrame) cancelAnimationFrame(goalTreeDragFrame);
    goalTreeDragFrame = 0;
    if (drag.active && Number.isFinite(drag.latestClientX) && Number.isFinite(drag.latestClientY)) {
      positionGoalTreeDraggedSubtree(drag.latestClientX, drag.latestClientY);
      updateGoalTreeDropCandidate(drag.latestClientX, drag.latestClientY);
    }
    if (drag.active && drag.livePlacements) {
      goalTreeVisualPlacements = new Map(Array.from(drag.livePlacements, function (entry) {
        return [entry[0], Object.assign({}, entry[1])];
      }));
      drag.dragIds.forEach(function (id) {
        var placement = drag.livePlacements.get(id);
        var element = goalTreeNodeElements.get(id);
        if (!element || !placement) return;
        element.style.transform = '';
        element.style.left = placement.x + 'px';
        element.style.top = (placement.y - placement.height / 2) + 'px';
      });
    }
    goalTreeDrag = null;
    window.removeEventListener('pointermove', onGoalTreeNodeDragMove);
    window.removeEventListener('pointerup', onGoalTreeNodeDragEnd);
    window.removeEventListener('pointercancel', onGoalTreeNodeDragCancel);
    document.body.classList.remove('study-goal-node-dragging');
    clearGoalTreeDropTarget();
    (drag.dragIds || new Set([drag.nodeId])).forEach(function (id) {
      var source = goalTreeNodeElements.get(id);
      if (source) source.classList.remove('is-drag-anchor', 'is-subtree-dragging');
    });
    if (drag.active) goalTreeDragEndedAt = performance.now();
    if (!cancelled && drag.active && drag.candidate) commitGoalTreeMove(drag.baseTree, drag.nodeId, drag.candidate);
    else if (drag.active && drag.baseLayout) animateGoalTreeLayout(drag.baseLayout, drag.baseLayout, 260);
  }
  function onGoalTreeNodeDragEnd(event) {
    if (!goalTreeDrag || event.pointerId !== goalTreeDrag.pointerId) return;
    finishGoalTreeNodeDrag(false);
  }
  function onGoalTreeNodeDragCancel(event) {
    if (!goalTreeDrag || event.pointerId !== goalTreeDrag.pointerId) return;
    finishGoalTreeNodeDrag(true);
  }
  function keyboardMoveGoalTreeNode(node, mode) {
    var tree = activeGoalTree();
    if (!tree || !node || node.kind === 'root' || node.kind === 'milestone' || goalTreeArchivePayload) return;
    var parent = (tree.nodes || []).find(function (item) { return item.id === node.parentId; });
    if (mode === 'outdent') {
      if (!parent) return;
      var nextParentId = parent.parentId || '';
      if (!GoalTree.validParent(tree, node.id, nextParentId)) return showToast('模块不能上提到任务下');
      var parentSiblings = (tree.nodes || []).filter(function (item) {
        return item.id !== node.id && (item.parentId || '') === nextParentId
          && GoalTree.slotKey(item.taskSlot) === GoalTree.slotKey(parent.taskSlot)
          && (nextParentId || GoalTree.rootSide(item.side) === GoalTree.rootSide(parent.side));
      }).sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
      var parentIndex = parentSiblings.findIndex(function (item) { return item.id === parent.id; });
      var afterParent = parentIndex >= 0 && parentSiblings[parentIndex + 1] ? parentSiblings[parentIndex + 1].id : '';
      return commitGoalTreeMove(tree, node.id, {
        parentId: nextParentId, beforeId: afterParent,
        taskSlot: parent.taskSlot ? Object.assign({}, parent.taskSlot) : null,
        side: nextParentId ? null : GoalTree.rootSide(parent.side),
      });
    }
    var siblings = (tree.nodes || []).filter(function (item) {
      return item.id !== node.id && (item.parentId || '') === (node.parentId || '')
        && GoalTree.slotKey(item.taskSlot) === GoalTree.slotKey(node.taskSlot)
        && (node.parentId || GoalTree.rootSide(item.side) === GoalTree.rootSide(node.side));
    }).concat([node]).sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
    var index = siblings.findIndex(function (item) { return item.id === node.id; });
    if (mode === 'up' && index > 0) {
      return commitGoalTreeMove(tree, node.id, { parentId: node.parentId || '', beforeId: siblings[index - 1].id, taskSlot: node.taskSlot || null, side: node.parentId ? null : GoalTree.rootSide(node.side) });
    }
    if (mode === 'down' && index >= 0 && index < siblings.length - 1) {
      var after = siblings[index + 2];
      return commitGoalTreeMove(tree, node.id, { parentId: node.parentId || '', beforeId: after ? after.id : '', taskSlot: node.taskSlot || null, side: node.parentId ? null : GoalTree.rootSide(node.side) });
    }
  }
  function navigateGoalTreeKey(currentId, key) {
    if (!goalTreeRenderLayout) return;
    var placements = goalTreeRenderLayout.nodes;
    var current = placements.find(function (item) { return item.id === currentId; });
    if (!current) return;
    var tree = activeGoalTree();
    var target = null;
    if (key === 'ArrowLeft') {
      var node = current.kind === 'root' ? null : current.node;
      target = placements.find(function (item) { return item.id === ((node && node.parentId) || (tree && tree.id)); });
    } else if (key === 'ArrowRight') {
      target = placements.find(function (item) {
        return item.id !== current.id && ((item.node && item.node.parentId) || (tree && tree.id)) === current.id;
      });
    } else {
      var siblings = placements.filter(function (item) { return item.depth === current.depth; })
        .sort(function (a, b) { return a.y - b.y; });
      var index = siblings.findIndex(function (item) { return item.id === current.id; });
      target = siblings[index + (key === 'ArrowUp' ? -1 : 1)];
    }
    if (target) selectGoalTreeNode(target.id, true);
  }

  // ── 拖拽排序：未完成列卡片左侧 2×3 点阵手柄，只在本容器（progressListEl）内排序 ──
  function enableTaskReorder(card, task) {
    if (task.status === 'done') return;   // 已完成列不需要手柄
    const grip = document.createElement('span');
    grip.className = 'study-progress-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⋮⋮';    // 两个竖省略号 = 2×3 点阵
    grip.addEventListener('pointerdown', function (event) {
      beginProgressDrag(event, card, task, grip);
    });
    card.insertBefore(grip, card.firstChild);
  }

  function progressListRows() {
    if (!progressListEl) return [];
    return Array.from(progressListEl.querySelectorAll('.study-progress-card[data-id]'));
  }

  function beginProgressDrag(event, card, task, grip) {
    if (event.button !== 0) return;
    if (progressListRows().length < 2) return;
    if (progressDrag) return;
    if (card.classList.contains('is-editing') || card.classList.contains('renaming')) return;
    event.preventDefault();
    event.stopPropagation();
    var rect = card.getBoundingClientRect();
    progressDrag = {
      taskId: task.id,
      card: card,
      grip: grip,
      pointerId: event.pointerId,
      active: false,
      ghost: null,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      originalOrder: progressListRows().map(function (row) { return row.dataset.id; }),
    };
    window.addEventListener('pointermove', onProgressDragPointerMove, { passive: false });
    window.addEventListener('pointerup', onProgressDragPointerUp);
    window.addEventListener('pointercancel', onProgressDragPointerCancel);
  }

  function onProgressDragPointerMove(event) {
    if (!progressDrag || event.pointerId !== progressDrag.pointerId) return;
    var dx = event.clientX - progressDrag.startX;
    var dy = event.clientY - progressDrag.startY;
    if (!progressDrag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      activateProgressDrag();
    }
    event.preventDefault();
    positionProgressGhost(event.clientX, event.clientY);
    liveReorderProgressCard(event.clientY);
  }

  function activateProgressDrag() {
    var drag = progressDrag;
    if (!drag || drag.active) return;
    try { drag.grip.setPointerCapture(drag.pointerId); } catch (error) {}
    var ghost = drag.card.cloneNode(true);
    var cardStyle = window.getComputedStyle(drag.card);
    ghost.classList.add('study-progress-ghost');
    ghost.classList.remove('drag-source', 'is-entering', 'is-leaving', 'is-editing',
      'renaming', 'is-completing', 'is-reopening', 'is-completed', 'is-goal-pending', 'is-goal-celebrating');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.tabIndex = -1;
    ghost.style.width = drag.width + 'px';
    ghost.style.height = drag.height + 'px';
    ghost.style.background = cardStyle.backgroundColor;
    ghost.style.borderColor = cardStyle.borderColor;
    ghost.style.borderRadius = cardStyle.borderRadius;
    ghost.style.gridTemplateColumns = '20px 30px minmax(0, 1fr) auto 48px';
    ghost.style.transition = 'none';
    ghost.style.animation = 'none';
    drag.ghost = ghost;
    positionProgressGhost(drag.startX, drag.startY);
    document.body.appendChild(ghost);
    drag.active = true;
    drag.card.classList.add('drag-source');
    document.body.classList.add('study-progress-dragging');
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function positionProgressGhost(x, y) {
    var drag = progressDrag;
    if (!drag || !drag.ghost) return;
    var left = x - drag.offsetX;
    var top = y - drag.offsetY;
    drag.ghost.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(1.028)';
    drag.ghost.dataset.dragLeft = String(left);
    drag.ghost.dataset.dragTop = String(top);
  }

  function progressInsertPoint(clientY) {
    if (!progressDrag) return null;
    var rows = progressListRows().filter(function (row) { return row !== progressDrag.card; });
    var beforeNode = null;
    for (var i = 0; i < rows.length; i++) {
      var rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        beforeNode = rows[i];
        break;
      }
    }
    return beforeNode;
  }

  function stopProgressFlipAnimations() {
    progressFlipAnims.forEach(function (animation) { animation.cancel(); });
    progressFlipAnims.clear();
  }

  function flipProgressCards(mutate) {
    if (prefersReduced) { mutate(); return; }
    var rows = progressListRows();
    var before = new Map();
    rows.forEach(function (row) { before.set(row, row.getBoundingClientRect()); });
    mutate();
    rows.forEach(function (row) {
      var animation = progressFlipAnims.get(row);
      if (animation) animation.cancel();
    });
    rows.forEach(function (row) {
      if (progressDrag && row === progressDrag.card) return;
      var oldRect = before.get(row);
      if (!oldRect) return;
      var newRect = row.getBoundingClientRect();
      var dx = oldRect.left - newRect.left;
      var dy = oldRect.top - newRect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      var distance = Math.hypot(dx, dy);
      var animation = row.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], {
        duration: Math.max(170, Math.min(280, 160 + distance * 0.28)),
        easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)',
      });
      progressFlipAnims.set(row, animation);
      animation.finished.catch(function () { return undefined; }).then(function () {
        if (progressFlipAnims.get(row) === animation) progressFlipAnims.delete(row);
      });
    });
  }

  function liveReorderProgressCard(clientY) {
    if (!progressDrag) return;
    var beforeNode = progressInsertPoint(clientY);
    if (progressDrag.card.nextElementSibling === beforeNode) return;
    flipProgressCards(function () {
      progressListEl.insertBefore(progressDrag.card, beforeNode);
    });
  }

  function onProgressDragPointerUp(event) {
    if (!progressDrag || event.pointerId !== progressDrag.pointerId) return;
    if (progressDrag.active) {
      positionProgressGhost(event.clientX, event.clientY);
      liveReorderProgressCard(event.clientY);
    }
    finishProgressDrag();
  }

  function onProgressDragPointerCancel(event) {
    if (!progressDrag || event.pointerId !== progressDrag.pointerId) return;
    finishProgressDrag({ cancel: true });
  }

  function finishProgressDrag(options) {
    options = options || {};
    var drag = progressDrag;
    if (!drag) return false;
    progressDrag = null;
    window.removeEventListener('pointermove', onProgressDragPointerMove);
    window.removeEventListener('pointerup', onProgressDragPointerUp);
    window.removeEventListener('pointercancel', onProgressDragPointerCancel);
    document.body.classList.remove('study-progress-dragging');

    if (!drag.active) return false;
    progressDragClickGuard = drag.taskId;
    setTimeout(function () {
      if (progressDragClickGuard === drag.taskId) progressDragClickGuard = '';
    }, 0);

    if (options.cancel) {
      if (prefersReduced) {
        stopProgressFlipAnimations();
        restoreNoteOrderDirect();
      } else {
        flipProgressCards(function () { restoreNoteOrderDirect(); });
      }
      function restoreNoteOrderDirect() {
        drag.originalOrder.forEach(function (id) {
          var row = progressListEl.querySelector('.study-progress-card[data-id="' + id + '"]');
          if (row) progressListEl.appendChild(row);
        });
      }
    }

    var domOrder = progressListRows().map(function (row) { return row.dataset.id; });
    var changed = !options.cancel
      && domOrder.some(function (id, index) { return id !== drag.originalOrder[index]; });
    if (changed) {
      var activeIds = {};
      domOrder.forEach(function (id) { activeIds[id] = true; });
      var ordered = domOrder.map(function (id) { return findTask(id); }).filter(Boolean);
      var gi = 0;
      state.tasks = state.tasks.map(function (t) {
        return activeIds[t.id] ? ordered[gi++] : t;
      });
      scheduleStudyReorder();
    }

    var landingCard = progressListEl.querySelector(
      '.study-progress-card[data-id="' + drag.taskId + '"]');
    if (landingCard) landingCard.classList.add('drag-source');
    if (options.immediate || prefersReduced) {
      if (drag.ghost) drag.ghost.remove();
      revealLandingCard(landingCard);
    } else {
      flyGhostToCard(drag.ghost, landingCard, function () {
        revealLandingCard(landingCard);
      });
    }

    stopProgressFlipAnimations();
    return true;
  }

  function revealLandingCard(card) {
    if (!card) return;
    card.classList.remove('drag-source');
    card.classList.remove('drag-handoff');
    card.style.removeProperty('background-color');
    card.style.removeProperty('border-color');
  }

  function flyGhostToCard(ghost, row, done) {
    if (!ghost || !row || prefersReduced) {
      if (ghost) ghost.remove();
      if (done) done();
      return;
    }
    var target = row.getBoundingClientRect();
    var ghostRect = ghost.getBoundingClientRect();
    var fromLeft = Number(ghost.dataset.dragLeft);
    var fromTop = Number(ghost.dataset.dragTop);
    var startLeft = Number.isFinite(fromLeft) ? fromLeft : ghostRect.left;
    var startTop = Number.isFinite(fromTop) ? fromTop : ghostRect.top;
    var distance = Math.hypot(target.left - startLeft, target.top - startTop);
    var duration = distance < 8
      ? 130
      : Math.max(300, Math.min(470, 270 + distance * 0.18));
    var animation = ghost.animate([
      {
        transform: 'translate3d(' + startLeft + 'px,' + startTop + 'px,0) scale(1.028)',
        opacity: 1,
      },
      {
        transform: 'translate3d(' + target.left + 'px,' + target.top + 'px,0) scale(1)',
        opacity: 1,
      },
    ], {
      duration: duration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards',
    });
    animation.finished.catch(function () { return undefined; }).then(function () {
      ghost.remove();
      if (done) done();
    });
  }

  function beginRename(card, task, titleEl) {
    if (card.classList.contains('renaming')) return;
    state.selectedId = task.id;
    card.classList.add('renaming');
    const original = task.title;
    let done = false;
    titleEl.contentEditable = 'plaintext-only';
    titleEl.spellcheck = false;
    titleEl.focus();
    // 全选当前文字
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(commit) {
      if (done) return;
      done = true;
      titleEl.contentEditable = 'false';
      card.classList.remove('renaming');
      titleEl.removeEventListener('keydown', onKey);
      titleEl.removeEventListener('blur', onBlur);
      const next = (titleEl.textContent || '').trim() || '未命名';
      if (commit && next !== original) {
        task.title = next;
        render();
        queueTaskPatch(task, { title: next })
          .then(() => undefined)
          .catch((error) => { task.title = original; render(); showToast(error.message); });
      } else {
        titleEl.textContent = original;
      }
    }
    function onKey(event) {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    }
    function onBlur() { finish(true); }
    titleEl.addEventListener('keydown', onKey);
    titleEl.addEventListener('blur', onBlur);
  }

  // ============ 极简清单视图（mode=list；勾选 / 双击改名 / 直接回收 / + 新建）============
  // —— 增量同步：极简清单行（不改名不重建，保留 DOM 以触发 CSS transition）——
  function syncListRowFromTask(row, task) {
    if (!row || !task) return;
    var done = task.status === 'done';
    row.classList.toggle('is-done', done);
    var check = row.querySelector('.study-list-check');
    if (check) {
      check.classList.toggle('on', done);
      check.textContent = done ? '✓' : '';
      check.setAttribute('aria-label', done ? '标记未完成' : '标记完成');
    }
    var title = row.querySelector('.study-list-title');
    if (title) title.textContent = task.title || '未命名';
  }

  function buildListGroupHead(group, tasks) {
    var head = document.createElement('div');
    head.className = 'study-list-head';
    head.innerHTML = '<h2>' + group.label + '</h2>'
      + (tasks.length ? '<span class="study-list-count">' + tasks.length + '</span>' : '');
    if (group.add) {
      var actions = document.createElement('div');
      actions.className = 'study-list-actions';
      var treeBtn = document.createElement('button');
      treeBtn.type = 'button';
      treeBtn.className = 'study-list-goal-tree';
      treeBtn.dataset.action = 'study-goal-tree-open';
      treeBtn.setAttribute('aria-label', '打开目标树');
      treeBtn.setAttribute('aria-haspopup', 'dialog');
      treeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path d="M5 5.5h5M10 5.5v13M10 10h5M15 10v8.5M10 18.5h5M15 14h4"></path></svg>';
      treeBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (window.StudyRoute) window.StudyRoute.open('', treeBtn);
      });
      actions.appendChild(treeBtn);
      var archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className = 'study-list-archive';
      archiveBtn.dataset.action = 'archive-done';
      archiveBtn.setAttribute('aria-label', '归档已完成任务');
      archiveBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path d="M4.5 8h15v11h-15zM3.5 5h17v3h-17zM9.5 12h5"></path></svg>';
      archiveBtn.addEventListener('click', function (event) { event.stopPropagation(); archiveDone(); });
      actions.appendChild(archiveBtn);
      var trashBtn = document.createElement('button');
      trashBtn.type = 'button';
      trashBtn.className = 'study-list-trash';
      trashBtn.setAttribute('aria-label', '任务回收站');
      trashBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path d="M8 7h8m-7.25 0 .55 11h5.4l.55-11M10 4.75h4M6.75 7h10.5"></path></svg>';
      trashBtn.addEventListener('click', function (event) { event.stopPropagation(); openTrash(); });
      actions.appendChild(trashBtn);
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'study-list-add';
      addBtn.title = '新建任务';
      addBtn.setAttribute('aria-label', '新建任务');
      addBtn.textContent = '+';
      addBtn.addEventListener('click', function (event) { event.stopPropagation(); listQuickAdd(); });
      actions.appendChild(addBtn);
      head.appendChild(actions);
    }
    return head;
  }

  function incrementalSyncListSection(section, group, tasks) {
    if (!section) return;
    // 收集已有行
    var existing = {};
    Array.from(section.querySelectorAll('.study-list-row')).forEach(function (row) {
      if (row.dataset.id) existing[row.dataset.id] = row;
    });

    // 更新头部计数
    var head = section.querySelector('.study-list-head');
    var count = head && head.querySelector('.study-list-count');
    if (count) count.textContent = String(tasks.length);

    // 按顺序摆放：已有行原地同步，新行直接创建
    var fragment = document.createDocumentFragment();
    tasks.forEach(function (task) {
      var row = existing[task.id];
      if (row) {
        syncListRowFromTask(row, task);
        fragment.appendChild(row);
      } else {
        row = taskRow(task);
        fragment.appendChild(row);
      }
    });

    // 清空旧内容，放入新 fragment
    section.innerHTML = '';
    if (head) section.appendChild(head);
    section.appendChild(fragment);
  }

  function renderList() {
    var host = document.querySelector('[data-role="study-list"]');
    if (!host) return;
    var groups = [
      { status: 'active', label: 'To Do', match: function (t) { return t.status === 'active'; }, add: true },
      { status: 'done', label: 'Done', match: function (t) { return t.status === 'done'; } },
    ];
    groups.forEach(function (group) {
      var tasks = state.tasks.filter(group.match);
      if (!tasks.length && !group.add) {
        var emptySection = host.querySelector('.study-list-group[data-status="' + group.status + '"]');
        if (emptySection) emptySection.remove();
        return;
      }
      var section = host.querySelector('.study-list-group[data-status="' + group.status + '"]');
      if (!section) {
        section = document.createElement('section');
        section.className = 'study-list-group';
        section.dataset.status = group.status;
        section.appendChild(buildListGroupHead(group, tasks));
        tasks.forEach(function (task) { section.appendChild(taskRow(task)); });
        host.appendChild(section);
      } else {
        // 刷新头部（操作按钮可能需重建）
        var oldHead = section.querySelector('.study-list-head');
        var newHead = buildListGroupHead(group, tasks);
        if (oldHead) oldHead.replaceWith(newHead);
        else section.insertBefore(newHead, section.firstChild);
        incrementalSyncListSection(section, group, tasks);
      }
    });
  }

  function taskRow(task) {
    var row = document.createElement('div');
    row.className = 'study-list-row' + (task.status === 'done' ? ' is-done' : '');
    row.dataset.id = task.id;
    enableTaskReorder(row, task);
    var checked = task.status === 'done';
    row.innerHTML = '<button type="button" class="study-list-check' + (checked ? ' on' : '')
      + '" aria-label="标记完成">' + (checked ? '✓' : '') + '</button>'
      + '<span class="study-list-title">' + escapeHtml(task.title) + '</span>';
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'study-list-remove';
    removeBtn.setAttribute('aria-label', '删除任务');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    removeBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      trashTaskById(task.id);
    });
    row.appendChild(removeBtn);
    row.querySelector('.study-list-check').addEventListener('click', function (event) {
      event.stopPropagation();
      moveTask(task.id, task.status === 'done' ? 'active' : 'done');
    });
    var titleEl = row.querySelector('.study-list-title');
    titleEl.addEventListener('dblclick', function (event) {
      event.stopPropagation();
      if (row.classList.contains('renaming')) return;
      beginRename(row, task, titleEl);
    });
    return row;
  }

  function listQuickAdd() {
    if (!studyLoaded) {
      ensureStudyLoaded().then(function (loaded) { if (loaded) listQuickAdd(); });
      return;
    }
    var task = createOptimisticTask({ title: '未命名', status: 'active' });
    render();
    scheduleStudyReorder();
    var row = document.querySelector('.study-list ' + taskSelector(task.id));
    if (row) {
      row.classList.add('quick-enter');
      setTimeout(function () { row.classList.remove('quick-enter'); }, 300);
    }
  }

  function renderTrash() {
    const list = document.querySelector('[data-role="trash-list"]');
    const prevRects = captureListRects(list, '.study-trash-item');
    list.innerHTML = '';
    if (!state.trash.length) {
      list.innerHTML = '<p class="study-empty soft-enter">回收站是空的。</p>';
      return;
    }
    state.trash.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'study-trash-item';
      item.dataset.id = entry.task.id;
      if (entry.task.id === trashEnterId) item.classList.add('quick-enter');
      item.innerHTML = '<div><strong>' + escapeHtml(entry.task.title)
        + '</strong><span>' + escapeHtml(STATUS_LABEL[entry.task.status] || '') + '</span></div>'
        + '<div class="study-trash-item-actions">'
        + '<button type="button" class="btn-text" data-action="restore">恢复</button>'
        + '<button type="button" class="btn-text study-danger" data-action="delete">永久移除</button></div>';
      item.querySelector('[data-action="restore"]').addEventListener('click', () => restoreTask(entry.task.id));
      item.querySelector('[data-action="delete"]').addEventListener('click', () => deleteTask(entry.task.id));
      list.appendChild(item);
    });
    trashEnterId = '';
    requestAnimationFrame(() => animateListMoves(list, '.study-trash-item', prevRects));
  }

  function captureListRects(list, selector) {
    var rects = new Map();
    if (!list) return rects;
    list.querySelectorAll(selector).forEach(function (item) {
      if (item.dataset.id) rects.set(item.dataset.id, item.getBoundingClientRect());
    });
    return rects;
  }

  function captureListRectsInto(rects, list, selector) {
    if (!list || !rects) return;
    list.querySelectorAll(selector).forEach(function (item) {
      if (item.dataset.id) rects.set(item.dataset.id, item.getBoundingClientRect());
    });
  }

  function animateListMoves(list, selector, prevRects) {
    if (prefersReduced || !list || !prevRects || !prevRects.size) return;
    list.querySelectorAll(selector).forEach(function (item) {
      // 跳过正在播退场动画的卡片（它们有自己的 CSS 动画）
      if (item.classList.contains('is-leaving')) return;
      var prev = prevRects.get(item.dataset.id);
      if (!prev) return;
      var now = item.getBoundingClientRect();
      var dx = prev.left - now.left;
      var dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      var duration = Math.max(190, Math.min(360, 180 + Math.hypot(dx, dy) * 0.28));
      item.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration: duration, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
    });
  }

  function animateListMovesInto(list, selector, prevRects) {
    // 与 animateListMoves 相同，但不消耗 prevRects（跨容器 FLIP 复用）
    animateListMoves(list, selector, prevRects);
  }

  function animateDetachedExit(item, className) {
    if (!item || prefersReduced) return;
    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.remove('quick-enter', 'status-pop');
    ghost.classList.add(className);
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    ghost.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-7px) scale(0.975)' },
    ], { duration: 230, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }).finished
      .catch(() => undefined).then(() => ghost.remove());
  }

  function animateArchiveCards(cards) {
    if (prefersReduced || !cards.length) return Promise.resolve();
    const animations = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.classList.remove('is-selected', 'quick-enter', 'renaming');
      ghost.classList.add('study-archive-exit-ghost');
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      document.body.appendChild(ghost);
      card.style.visibility = 'hidden';
      const animation = ghost.animate([
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0.88, transform: 'translateY(-2px) scale(0.997)', offset: 0.30 },
        { opacity: 0.48, transform: 'translateY(-6px) scale(0.988)', offset: 0.72 },
        { opacity: 0, transform: 'translateY(-12px) scale(0.972)' },
      ], {
        delay: Math.min(index * 42, 210),
        duration: 460,
        easing: 'cubic-bezier(0.22, 0.78, 0.24, 1)',
        fill: 'both',
      });
      return animation.finished.catch(() => undefined).then(() => ghost.remove());
    });
    return Promise.all(animations).then(() => undefined);
  }

  async function animateArchiveRows(group) {
    if (!group) return;
    const rows = Array.from(group.querySelectorAll('.study-list-row'));
    if (prefersReduced) return;
    const rowAnimations = rows.map((row, index) => row.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0.82, transform: 'translateY(-2px) scale(0.996)', offset: 0.34 },
      { opacity: 0, transform: 'translateY(-9px) scale(0.98)' },
    ], {
      delay: Math.min(index * 46, 220),
      duration: 440,
      easing: 'cubic-bezier(0.22, 0.78, 0.24, 1)',
      fill: 'both',
    }).finished.catch(() => undefined));
    const head = group.querySelector('.study-list-head');
    let headAnimation = Promise.resolve();
    if (head) {
      headAnimation = new Promise((resolve) => setTimeout(resolve, 260)).then(() =>
        head.animate([
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-7px)' },
        ], {
          duration: 300,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          fill: 'both',
        }).finished.catch(() => undefined));
    }
    await Promise.all([Promise.all(rowAnimations), headAnimation]);
    await group.animate([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-5px)' },
    ], {
      duration: 180,
      easing: 'ease-out',
      fill: 'both',
    }).finished.catch(() => undefined);
  }

  function lockTrashItem(id, locked) {
    const item = document.querySelector('.study-trash-item' + taskSelector(id));
    if (!item) return;
    item.classList.toggle('is-pending', !!locked);
    item.querySelectorAll('button').forEach((button) => { button.disabled = !!locked; });
  }

  function taskProgress(task) {
    const raw = task && task.progress && typeof task.progress === 'object' ? task.progress : {};
    const target = Math.max(0, Math.min(9999, Number(raw.target) || 0));
    return {
      current: Math.max(0, Math.min(target, Number(raw.current) || 0)),
      target: target,
      milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
    };
  }

  function studyGoalReady(task, progress) {
    var current = progress || taskProgress(task);
    return !!(task && task.status !== 'done' && current.target > 0 && current.current >= current.target);
  }

  function syncStudyProgressValue(value, progress, goalReady) {
    if (!value) return;
    value.classList.toggle('is-goal-ready', !!goalReady);
    var label = value.querySelector('.study-progress-goal-label');
    var number = value.querySelector('.study-progress-value-number');
    var labelText = T('目标已达');
    var numberText = progress.target
      ? progress.current + ' / ' + progress.target
      : '';
    if (label && label.textContent !== labelText) label.textContent = labelText;
    if (number && number.textContent !== numberText) number.textContent = numberText;
  }

  function buildStudyProgressValue(progress, goalReady) {
    var value = document.createElement('span');
    value.className = 'study-progress-value';
    var label = document.createElement('span');
    label.className = 'study-progress-goal-label';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = T('目标已达');
    var number = document.createElement('span');
    number.className = 'study-progress-value-number';
    value.append(label, number);
    syncStudyProgressValue(value, progress, goalReady);
    return value;
  }

  // —— 里程碑辅助函数（复刻专注页每日任务的里程碑 tooltip / 避让排线）——
  function studyMilestoneList(task) {
    var progress = taskProgress(task);
    var seen = new Set();
    return progress.milestones
      .filter(function (item) {
        var at = Number(item && item.at);
        var name = typeof (item && item.name) === 'string' ? item.name.trim() : '';
        if (!name || at < 1 || at > progress.target || seen.has(at)) return false;
        seen.add(at);
        return true;
      })
      .slice(0, STUDY_MILESTONES_MAX)
      .map(function (item, index) {
        return {
          id: String(item.id || ('sm_' + item.at + '_' + index)),
          name: item.name.trim(),
          at: Number(item.at),
        };
      })
      .sort(function (a, b) { return a.at - b.at; });
  }
  function studyMilestoneText(milestone, reached) {
    return milestone.name + ' · ' + milestone.at + (reached ? ' · 已达成' : '');
  }
  function studyMilestoneLanes(milestones, target) {
    var lanes = [[], [], []];
    return milestones.map(function (milestone) {
      var position = target > 0 ? Math.max(0, Math.min(100, milestone.at / target * 100)) : 0;
      var lane = lanes.findIndex(function (positions) { return positions.every(function (value) { return Math.abs(value - position) >= 4.5; }); });
      if (lane < 0) lane = lanes.reduce(function (best, positions, index) { return positions.length < lanes[best].length ? index : best; }, 0);
      lanes[lane].push(position);
      return { milestone: milestone, position: position, lane: [0, -1, 1][lane] };
    });
  }
  function syncStudyMilestones(shell, task, options) {
    var layer = shell && shell.querySelector('.study-progress-milestones');
    if (!layer) return;
    var opts = options || {};
    var progress = taskProgress(task);
    var crossed = new Set(Array.isArray(opts.crossedMilestoneIds) ? opts.crossedMilestoneIds : []);
    var layout = studyMilestoneLanes(studyMilestoneList(task), progress.target);
    layer.classList.toggle('is-dense', layout.length > 12);
    layer.classList.toggle('is-very-dense', layout.length > 24);
    var keep = new Set(layout.map(function (entry) { return entry.milestone.id; }));
    layer.querySelectorAll('.study-progress-milestone').forEach(function (marker) {
      if (keep.has(marker.dataset.milestoneId)) return;
      if (prefersReduced) marker.remove();
      else {
        marker.classList.add('is-leaving');
        window.setTimeout(function () { if (marker.parentNode) marker.remove(); }, 220);
      }
    });
    layout.forEach(function (entry) {
      var milestone = entry.milestone;
      var reached = progress.current >= milestone.at;
      var marker = Array.prototype.find.call(layer.children, function (item) { return item.dataset.milestoneId === milestone.id; });
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'study-progress-milestone is-entering';
        marker.dataset.milestoneId = milestone.id;
        marker.tabIndex = 0;
        marker.setAttribute('role', 'img');
        var stamp = document.createElement('span');
        stamp.className = 'study-progress-milestone-stamp';
        stamp.setAttribute('aria-hidden', 'true');
        var tip = document.createElement('span');
        tip.className = 'study-progress-milestone-tip';
        tip.setAttribute('role', 'tooltip');
        studyMilestoneTipSeq += 1;
        tip.id = 'study-milestone-tip-' + studyMilestoneTipSeq;
        marker.setAttribute('aria-describedby', tip.id);
        marker.append(stamp, tip);
        layer.appendChild(marker);
        if (!prefersReduced) window.setTimeout(function () { marker.classList.remove('is-entering'); }, 260);
        else marker.classList.remove('is-entering');
      }
      var text = studyMilestoneText(milestone, reached);
      marker.style.setProperty('--milestone-position', entry.position.toFixed(3) + '%');
      marker.style.setProperty('--milestone-lane', String(entry.lane));
      marker.classList.toggle('is-edge-start', entry.position < 12);
      marker.classList.toggle('is-edge-end', entry.position > 88);
      marker.classList.toggle('is-reached', reached);
      marker.setAttribute('aria-label', text);
      var tipEl = marker.querySelector('.study-progress-milestone-tip');
      if (tipEl) tipEl.textContent = text;
      if (crossed.has(milestone.id) && !prefersReduced) {
        replayClass(marker, 'is-just-reached', STUDY_MILESTONE_REACHED_CLEANUP_MS);
      }
    });
  }
  function syncStudyProgressBar(shell, task, options) {
    if (!shell) return;
    var opts = options || {};
    var progress = taskProgress(task);
    var goalReady = studyGoalReady(task, progress);
    var fill = shell.querySelector('.study-progress-fill');
    if (fill) fill.style.width = (progress.target ? Math.min(100, progress.current / progress.target * 100) : 0).toFixed(2) + '%';
    var track = shell.querySelector('.study-progress-track');
    var atTarget = progress.target > 0 && progress.current >= progress.target;
    if (track) {
      track.classList.toggle('is-full', atTarget);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(progress.target));
      track.setAttribute('aria-valuenow', String(progress.current));
      track.setAttribute('aria-valuetext', goalReady
        ? T('目标已达成，可以手动标记完成')
        : progress.current + ' / ' + progress.target);
    }
    syncStudyMilestones(shell, task, opts);
  }
  function buildStudyProgressShell(task, options) {
    options = options || {};
    var shell = document.createElement('span');
    shell.className = 'study-progress-track-shell' + (options.compact ? ' is-compact' : '');
    if (options.role) shell.dataset.role = options.role;
    var track = document.createElement('span');
    track.className = 'study-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', '任务进度');
    var fill = document.createElement('span');
    fill.className = 'study-progress-fill';
    track.appendChild(fill);
    var markers = document.createElement('span');
    markers.className = 'study-progress-milestones';
    shell.append(track, markers);
    syncStudyProgressBar(shell, task);
    return shell;
  }

  function buildProgressCard(task, completed) {
    const progress = taskProgress(task);
    const goalReady = !completed && studyGoalReady(task, progress);
    const card = document.createElement('article');
    card.className = 'study-progress-card'
      + (completed ? ' is-completed' : '')
      + (goalReady ? ' is-goal-ready' : '');
    card.dataset.id = task.id;
    enableTaskReorder(card, task);

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'study-progress-check' + (completed ? ' on' : '');
    setStudyAriaLabel(check, completed
      ? '恢复任务'
      : goalReady ? '目标已达成，可以手动标记完成' : '标记完成');
    check.addEventListener('click', () => moveTask(task.id, completed ? 'active' : 'done'));

    const main = document.createElement('div');
    main.className = 'study-progress-main';
    const heading = document.createElement('span');
    heading.className = 'study-progress-card-head';
    const title = document.createElement('strong');
    title.textContent = task.title || '未命名任务';
    const value = buildStudyProgressValue(progress, goalReady);
    heading.append(title, value);
    main.appendChild(heading);

    if (progress.target) {
      main.appendChild(buildStudyProgressShell(task));
    }

    // 双击标题 → 原地改名
    title.addEventListener('dblclick', function (event) {
      event.stopPropagation();
      if (card.classList.contains('renaming')) return;
      beginRename(card, task, title);
    });

    card.append(check, main);
    if (!completed && progress.target) {
      const controls = document.createElement('div');
      controls.className = 'study-progress-controls';
      [-1, 1].forEach((delta) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = delta < 0 ? '−1' : '+1';
        button.dataset.delta = String(delta);
        button.disabled = delta < 0 ? progress.current <= 0 : progress.current >= progress.target;
        button.setAttribute('aria-label', delta < 0 ? '进度减一' : '进度加一');
        button.addEventListener('click', () => changeTaskProgress(task, delta));
        controls.appendChild(button);
      });
      card.appendChild(controls);
    }

    // 右侧提示区：› 图标（悬停绿光）+ ⋯ 菜单按钮（悬停浮现）
    const detailGroup = document.createElement('span');
    detailGroup.className = 'study-progress-detail-group';

    const detailCue = document.createElement('span');
    detailCue.className = 'study-progress-detail-cue';
    detailCue.setAttribute('aria-hidden', 'true');
    detailCue.textContent = '›';
    detailGroup.appendChild(detailCue);

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'study-progress-menu';
    menu.setAttribute('aria-label', '任务选项');
    menu.setAttribute('aria-haspopup', 'dialog');
    menu.setAttribute('aria-expanded', progressSettingsId === task.id ? 'true' : 'false');
    menu.setAttribute('aria-controls', 'study-progress-settings-popover');
    menu.textContent = '⋯';
    menu.addEventListener('click', function (event) {
      event.stopPropagation();
      if (progressSettingsId === task.id && progressSettingsPopover) {
        closeProgressSettings(true);
      } else {
        openProgressSettings(task.id, menu);
      }
    });
    detailGroup.appendChild(menu);

    card.appendChild(detailGroup);
    return card;
  }

  // —— 增量同步卡片内容：由 task 数据更新已存在 DOM 卡片的文字 / 进度条 / 按钮 / 里程碑 ——
  function cardProgressStructureOk(card, task, completed) {
    var progress = taskProgress(task);
    var hasTrack = !!card.querySelector('.study-progress-track-shell');
    var hasControls = !!card.querySelector('.study-progress-controls');
    var hasStableValue = !!card.querySelector('.study-progress-goal-label')
      && !!card.querySelector('.study-progress-value-number');
    var needsTrack = !!progress.target;
    var needsControls = !completed && !!progress.target;
    return hasTrack === needsTrack && hasControls === needsControls && hasStableValue;
  }

  // —— 里程碑弹窗（复刻专注页每日任务的高级设置弹窗）——
  function cloneProgressMilestones(items) {
    return (Array.isArray(items) ? items : []).slice(0, STUDY_MILESTONES_MAX).map(function (item, index) {
      return {
        id: String(item && item.id || ('pm_draft_' + Date.now().toString(36) + '_' + index)),
        name: String(item && item.name || ''),
        at: Number(item && item.at) || 0,
      };
    });
  }
  function progressMilestoneDraftId() {
    return 'pm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }
  function setStudyMilestoneDialogError(message) {
    if (!studyMilestoneDialog) return;
    var error = studyMilestoneDialog.querySelector('[data-role="study-milestone-error"]');
    if (error) error.textContent = message || '';
  }
  function updateStudyMilestoneAddState() {
    if (!studyMilestoneDialog) return;
    var count = studyMilestoneDialog.querySelectorAll('.study-milestone-row:not(.is-leaving)').length;
    var add = studyMilestoneDialog.querySelector('[data-action="study-milestone-add"]');
    if (add) {
      add.disabled = count >= STUDY_MILESTONES_MAX;
      add.textContent = count >= STUDY_MILESTONES_MAX ? T('已达到 50 个安全上限') : T('添加任务点') + ' · ' + count;
    }
  }
  function appendStudyMilestoneDraftRow(item, animate) {
    if (!studyMilestoneDialog) return null;
    var list = studyMilestoneDialog.querySelector('[data-role="study-milestone-list"]');
    if (!list) return null;
    var row = document.createElement('div');
    row.className = 'study-milestone-row' + (animate && !prefersReduced ? ' is-entering' : '');
    row.dataset.milestoneId = item.id || progressMilestoneDraftId();
    var name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 40;
    name.className = 'study-milestone-name';
    name.dataset.role = 'study-milestone-name';
    name.placeholder = '任务点名称';
    name.setAttribute('aria-label', '任务点名称');
    name.value = item.name || '';
    var atWrap = document.createElement('label');
    atWrap.className = 'study-milestone-at-wrap';
    var at = document.createElement('input');
    at.type = 'number';
    at.min = '1';
    at.max = String(studyMilestoneDialogTarget || 9999);
    at.step = '1';
    at.className = 'study-milestone-at';
    at.dataset.role = 'study-milestone-at';
    at.setAttribute('aria-label', '位置');
    at.value = Number(item.at) > 0 ? String(item.at) : '';
    var unit = document.createElement('span');
    unit.textContent = '/ ' + (studyMilestoneDialogTarget || '?');
    atWrap.append(at, unit);
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'study-milestone-remove';
    remove.dataset.action = 'study-milestone-remove';
    remove.setAttribute('aria-label', '删除这个任务点');
    remove.textContent = '×';
    row.append(name, atWrap, remove);
    list.appendChild(row);
    if (row.classList.contains('is-entering')) window.setTimeout(function () { row.classList.remove('is-entering'); }, 260);
    updateStudyMilestoneAddState();
    return row;
  }
  function readStudyMilestoneDialog() {
    if (!studyMilestoneDialogTarget) return { error: '请先设置任务长度' };
    var rows = Array.from(studyMilestoneDialog.querySelectorAll('.study-milestone-row:not(.is-leaving)'));
    var result = [];
    var seenAt = new Set();
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      var nameInput = row.querySelector('[data-role="study-milestone-name"]');
      var atInput = row.querySelector('[data-role="study-milestone-at"]');
      var name = String(nameInput && nameInput.value || '').trim();
      var rawAt = String(atInput && atInput.value || '').trim();
      var atVal = /^\d+$/.test(rawAt) ? Number(rawAt) : 0;
      row.classList.remove('has-error');
      if (!name) {
        row.classList.add('has-error');
        if (nameInput) nameInput.focus();
        return { error: '请填写任务点名称' };
      }
      if (name.length > 40) {
        row.classList.add('has-error');
        if (nameInput) nameInput.focus();
        return { error: '任务点名称不能超过 40 个字符' };
      }
      if (!atVal || atVal > studyMilestoneDialogTarget) {
        row.classList.add('has-error');
        if (atInput) atInput.focus();
        return { error: '任务点位置必须在 1 到任务长度之间' };
      }
      if (seenAt.has(atVal)) {
        row.classList.add('has-error');
        if (atInput) atInput.focus();
        return { error: '同一位置只能设置一个任务点' };
      }
      seenAt.add(atVal);
      result.push({ id: row.dataset.milestoneId || progressMilestoneDraftId(), name: name, at: atVal });
    }
    result.sort(function (a, b) { return a.at - b.at; });
    return { milestones: result };
  }
  function openStudyMilestoneDialog(targetValue, returnElement) {
    if (!targetValue) { showToast('请先设置任务长度'); return; }
    if (studyMilestoneDialog) closeStudyMilestoneDialog(false, true);
    if (progressSettingsPopover) {
      progressSettingsPopover.classList.add('is-suspended');
      progressSettingsPopover.setAttribute('aria-hidden', 'true');
    }
    studyMilestoneDialogTarget = targetValue;
    studyMilestoneDialogDraft = cloneProgressMilestones(progressSettingsMilestones);
    studyMilestoneReturnEl = returnElement || null;
    var inGoalTree = !!(progressSettingsPopover && progressSettingsPopover.classList.contains('is-goal-tree'));
    var shell = document.createElement('div');
    shell.className = 'study-milestone-dialog-shell' + (inGoalTree ? ' is-goal-tree' : '');
    shell.dataset.role = 'study-milestone-dialog';
    var dialog = document.createElement('section');
    dialog.className = 'study-milestone-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'study-milestone-title');
    var head = document.createElement('header');
    var heading = document.createElement('div');
    var eyebrow = document.createElement('span');
    eyebrow.textContent = T('任务长度') + ' · ' + targetValue;
    var title = document.createElement('h2');
    title.id = 'study-milestone-title';
    title.textContent = '高级设置';
    heading.append(eyebrow, title);
    var close = document.createElement('button');
    close.type = 'button';
    close.dataset.action = 'study-milestone-cancel';
    close.setAttribute('aria-label', '关闭高级设置');
    close.textContent = '×';
    head.append(heading, close);
    var intro = document.createElement('p');
    intro.className = 'study-milestone-intro';
    intro.textContent = '把任务长度拆成有名字的任务点。达成状态会根据当前进度自动点亮。';
    var list = document.createElement('div');
    list.className = 'study-milestone-list';
    list.dataset.role = 'study-milestone-list';
    var error = document.createElement('p');
    error.className = 'study-milestone-error';
    error.dataset.role = 'study-milestone-error';
    error.setAttribute('aria-live', 'polite');
    var footer = document.createElement('footer');
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'study-milestone-add';
    add.dataset.action = 'study-milestone-add';
    var footerActions = document.createElement('div');
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'study-milestone-cancel';
    cancel.dataset.action = 'study-milestone-cancel';
    cancel.textContent = '取消';
    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'study-milestone-confirm';
    confirm.dataset.action = 'study-milestone-confirm';
    confirm.textContent = '确定';
    footerActions.append(cancel, confirm);
    footer.append(add, footerActions);
    dialog.append(head, intro, list, error, footer);
    shell.appendChild(dialog);
    var studyView = document.querySelector('[data-role="study-view"]');
    (inGoalTree ? document.body : (studyView || document.body)).appendChild(shell);
    studyMilestoneDialog = shell;
    studyMilestoneDialogDraft.forEach(function (item) { appendStudyMilestoneDraftRow(item, false); });
    updateStudyMilestoneAddState();
    requestAnimationFrame(function () { shell.classList.add('is-open'); });
    var first = shell.querySelector('input, [data-action="study-milestone-add"]');
    if (first) first.focus();
  }
  function closeStudyMilestoneDialog(apply, instant) {
    var shell = studyMilestoneDialog;
    if (!shell || shell.classList.contains('is-closing')) return;
    if (apply) {
      var result = readStudyMilestoneDialog();
      if (result.error) { setStudyMilestoneDialogError(result.error); return; }
      progressSettingsMilestones = result.milestones;
    }
    var returnEl = studyMilestoneReturnEl;
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      if (shell.isConnected) shell.remove();
      if (studyMilestoneDialog === shell) studyMilestoneDialog = null;
      studyMilestoneDialogDraft = [];
      studyMilestoneDialogTarget = 0;
      studyMilestoneReturnEl = null;
      if (progressSettingsPopover) {
        progressSettingsPopover.classList.remove('is-suspended');
        progressSettingsPopover.removeAttribute('aria-hidden');
        scheduleProgressSettingsPosition();
      }
      // 更新浮动设置卡中的任务点数量
      var button = progressSettingsPopover
        && progressSettingsPopover.querySelector('[data-role="progress-settings-milestones"]');
      if (button) {
        var count = Array.isArray(progressSettingsMilestones) ? progressSettingsMilestones.length : 0;
        button.textContent = '任务点设置' + (count ? ' · ' + count : '');
      }
      if (!instant && returnEl && returnEl.isConnected) returnEl.focus();
    };
    if (instant || prefersReduced) { finish(); return; }
    shell.classList.remove('is-open');
    shell.classList.add('is-closing');
    shell.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 260);
  }

  // ============ 进度卡片的锚定浮动设置卡 ============
  function setProgressSettingsError(message) {
    var error = progressSettingsPopover
      && progressSettingsPopover.querySelector('[data-role="progress-settings-error"]');
    if (error) error.textContent = message || '';
  }

  function positionProgressSettings() {
    if (!progressSettingsPopover || !progressSettingsTrigger || !progressSettingsTrigger.isConnected) return;
    var triggerRect = progressSettingsTrigger.getBoundingClientRect();
    var popoverRect = progressSettingsPopover.getBoundingClientRect();
    var gap = 8;
    var edge = 12;
    var left = triggerRect.right - popoverRect.width;
    left = Math.max(edge, Math.min(left, window.innerWidth - popoverRect.width - edge));
    var top = triggerRect.bottom + gap;
    var placement = 'below';
    if (top + popoverRect.height > window.innerHeight - edge
        && triggerRect.top - popoverRect.height - gap >= edge) {
      top = triggerRect.top - popoverRect.height - gap;
      placement = 'above';
    } else {
      top = Math.max(edge, Math.min(top, window.innerHeight - popoverRect.height - edge));
    }
    progressSettingsPopover.style.left = Math.round(left) + 'px';
    progressSettingsPopover.style.top = Math.round(top) + 'px';
    progressSettingsPopover.dataset.placement = placement;
  }

  function scheduleProgressSettingsPosition() {
    if (!progressSettingsPopover || progressSettingsPositionFrame) return;
    progressSettingsPositionFrame = requestAnimationFrame(function () {
      progressSettingsPositionFrame = 0;
      if (!progressSettingsTrigger || !progressSettingsTrigger.isConnected) {
        closeProgressSettings(false, true);
        return;
      }
      positionProgressSettings();
    });
  }

  function buildProgressSettings(task, options) {
    options = options || {};
    var progress = taskProgress(task);
    var box = document.createElement('section');
    box.id = 'study-progress-settings-popover';
    box.className = 'study-progress-settings-popover' + (options.compactGoalTree ? ' is-goal-tree' : '');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-labelledby', 'study-progress-settings-title');

    var title = document.createElement('strong');
    title.id = 'study-progress-settings-title';
    title.className = 'study-progress-settings-title';
    title.textContent = '任务设置';
    box.appendChild(title);

    var targetWrap = document.createElement('label');
    targetWrap.className = 'study-progress-settings-target';
    var targetLabel = document.createElement('span');
    targetLabel.textContent = '任务长度';
    var targetIn = document.createElement('input');
    targetIn.type = 'number';
    targetIn.min = '0';
    targetIn.max = '9999';
    targetIn.step = '1';
    targetIn.inputMode = 'numeric';
    targetIn.className = 'study-progress-settings-number';
    targetIn.dataset.role = 'progress-settings-target';
    targetIn.value = progress.target || '';
    targetIn.setAttribute('aria-label', '任务长度');
    targetWrap.append(targetLabel, targetIn);
    box.appendChild(targetWrap);

    var milestoneBtn = document.createElement('button');
    milestoneBtn.type = 'button';
    milestoneBtn.className = 'study-progress-settings-milestones';
    milestoneBtn.dataset.role = 'progress-settings-milestones';
    milestoneBtn.setAttribute('aria-haspopup', 'dialog');
    var updateMilestoneButton = function () {
      var value = Number(targetIn.value);
      var enabled = Number.isInteger(value) && value > 0 && value <= 9999;
      var count = Array.isArray(progressSettingsMilestones) ? progressSettingsMilestones.length : 0;
      milestoneBtn.disabled = !enabled;
      milestoneBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      milestoneBtn.textContent = '任务点设置' + (count ? ' · ' + count : '');
      setProgressSettingsError('');
    };
    targetIn.addEventListener('input', updateMilestoneButton);
    milestoneBtn.addEventListener('click', function () {
      openStudyMilestoneDialog(Number(targetIn.value) || 0, milestoneBtn);
    });
    updateMilestoneButton();
    box.appendChild(milestoneBtn);

    var treeSection = document.createElement('div');
    treeSection.className = 'study-progress-settings-goal-tree';
    var treeCopy = document.createElement('span');
    treeCopy.innerHTML = '<small>' + escapeHtml(T('目标树')) + '</small>';
    var owner = goalTreeOwner(task.id);
    var treeState = document.createElement('strong');
    treeState.textContent = owner ? owner.tree.title : T('未加入');
    if (owner) treeState.setAttribute('data-user-content', '');
    treeCopy.appendChild(treeState);
    var treeActions = document.createElement('span');
    treeActions.className = 'study-progress-settings-goal-tree-actions';
    var treeAction = document.createElement('button');
    treeAction.type = 'button';
    treeAction.textContent = owner ? T('在树中查看') : T('加入…');
    treeAction.addEventListener('click', function () {
      var origin = progressSettingsTrigger || treeAction;
      closeProgressSettings(false, true);
      if (owner) {
        goalTreeActiveId = owner.tree.id;
        goalTreeSelectedId = owner.node.id;
      } else {
        goalTreePendingTaskId = task.id;
      }
      openGoalTree(origin, task.id);
    });
    treeActions.appendChild(treeAction);
    if (owner) {
      var moveTreeTask = document.createElement('button');
      moveTreeTask.type = 'button';
      moveTreeTask.textContent = T('移动…');
      moveTreeTask.addEventListener('click', function () {
        var origin = progressSettingsTrigger || moveTreeTask;
        closeProgressSettings(false, true);
        goalTreeActiveId = owner.tree.id;
        goalTreeSelectedId = owner.node.id;
        openGoalTree(origin, task.id, 'move-task');
      });
      var detachTreeTask = document.createElement('button');
      detachTreeTask.type = 'button';
      detachTreeTask.textContent = T('移出');
      detachTreeTask.addEventListener('click', function () {
        closeProgressSettings(false, true);
        goalTreeCommand('detach-task', { treeId: owner.tree.id, taskId: task.id });
      });
      treeActions.append(moveTreeTask, detachTreeTask);
    }
    treeSection.append(treeCopy, treeActions);
    // 总路线相关操作统一在极简路线面板内完成，任务设置不再复制入口。

    var error = document.createElement('p');
    error.className = 'study-progress-settings-error';
    error.dataset.role = 'progress-settings-error';
    error.setAttribute('aria-live', 'polite');
    box.appendChild(error);

    var actions = document.createElement('div');
    actions.className = 'study-progress-settings-actions';
    var trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'study-progress-settings-trash';
    trashBtn.textContent = '移到回收站';
    trashBtn.addEventListener('click', function () {
      closeProgressSettings(false, true);
      trashTaskById(task.id);
    });
    var actionGroup = document.createElement('span');
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'study-progress-settings-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', function () { closeProgressSettings(true); });
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'study-progress-settings-save';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () { commitProgressSettings(task.id, box); });
    actionGroup.append(cancelBtn, saveBtn);
    if (!options.compactGoalTree) actions.appendChild(trashBtn);
    actions.appendChild(actionGroup);
    box.appendChild(actions);

    box.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        commitProgressSettings(task.id, box);
      }
    });
    return box;
  }

  function openProgressSettings(id, trigger) {
    var task = findTask(id);
    if (!task || !trigger) return;
    if (progressSettingsPopover) closeProgressSettings(false, true);
    progressSettingsId = id;
    progressSettingsMilestones = cloneProgressMilestones(taskProgress(task).milestones);
    progressSettingsTrigger = trigger;
    progressSettingsPopover = buildProgressSettings(task, {
      compactGoalTree: !!trigger.closest('.study-goal-tree-detail'),
    });
    trigger.setAttribute('aria-expanded', 'true');
    document.body.appendChild(progressSettingsPopover);
    positionProgressSettings();
    requestAnimationFrame(function () {
      if (!progressSettingsPopover) return;
      progressSettingsPopover.classList.add('is-open');
      positionProgressSettings();
    });
    window.setTimeout(function () {
      var input = progressSettingsPopover
        && progressSettingsPopover.querySelector('[data-role="progress-settings-target"]');
      if (input) { input.focus(); input.select(); }
    }, prefersReduced ? 0 : 80);
  }

  function closeProgressSettings(restoreFocus, instant) {
    var popover = progressSettingsPopover;
    var trigger = progressSettingsTrigger;
    if (!popover) return;
    if (progressSettingsPositionFrame) cancelAnimationFrame(progressSettingsPositionFrame);
    progressSettingsPositionFrame = 0;
    progressSettingsId = '';
    progressSettingsMilestones = null;
    progressSettingsPopover = null;
    progressSettingsTrigger = null;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    var finish = function () {
      if (popover.isConnected) popover.remove();
      if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
    };
    if (instant || prefersReduced) {
      finish();
      return;
    }
    popover.classList.remove('is-open');
    popover.classList.add('is-closing');
    window.setTimeout(finish, 190);
  }

  function commitProgressSettings(id, box) {
    var task = findTask(id);
    if (!task || box !== progressSettingsPopover) return;
    var targetIn = box.querySelector('[data-role="progress-settings-target"]');
    var rawTarget = String(targetIn && targetIn.value || '').trim();
    if (rawTarget && !/^\d+$/.test(rawTarget)) {
      setProgressSettingsError('任务长度需要是 0 到 9999 之间的整数');
      if (targetIn) targetIn.focus();
      return;
    }
    var target = rawTarget ? Number(rawTarget) : 0;
    var current = taskProgress(task).current;
    if (target > 9999) {
      setProgressSettingsError('任务长度不能超过 9999');
      if (targetIn) targetIn.focus();
      return;
    }
    if (target < current) {
      setProgressSettingsError('任务长度不能小于当前进度，请先回退进度');
      if (targetIn) targetIn.focus();
      return;
    }
    var milestones = target ? cloneProgressMilestones(progressSettingsMilestones) : [];
    if (milestones.some(function (item) { return item.at < 1 || item.at > target; })) {
      setProgressSettingsError('任务点位置不能超过任务长度');
      return;
    }

    var oldMilestoneSignature = JSON.stringify(taskProgress(task).milestones.map(function (item) {
      return [item.id, item.name, item.at];
    }));
    var newMilestoneSignature = JSON.stringify(milestones.map(function (item) {
      return [item.id, item.name, item.at];
    }));
    var milestoneStructureChanged = oldMilestoneSignature !== newMilestoneSignature;
    var beforeGoalTree = goalTreeOpen ? captureGoalTreeRects() : null;
    closeProgressSettings(false, true);
    if (!task.progress || typeof task.progress !== 'object') task.progress = {};
    task.progress.target = target;
    task.progress.milestones = milestones;
    render({ skipGoalTree: true });
    if (goalTreeOpen) {
      if (milestoneStructureChanged) {
        renderGoalTree(beforeGoalTree, {
          duration: 320,
          preserveMarkup: true,
          preserveDetail: true,
          preserveSummary: true,
          preserveSelect: true,
        });
      }
      refreshGoalTreeDetailStable();
      syncGoalTreeProgress(task.id);
    }
    queueTaskPatch(task, {
      progress: { target: target, milestones: milestones },
    }, { skipGoalTreeRender: true }).catch(function (error) {
      showToast(error.message);
      return refresh();
    });
  }

  function progressQuickAdd() {
    if (!studyLoaded) {
      ensureStudyLoaded().then(function (loaded) { if (loaded) progressQuickAdd(); });
      return;
    }
    var task = createOptimisticTask({ title: '未命名', status: 'active' });
    render();
    scheduleStudyReorder();
    var card = document.querySelector('.study-progress-card' + taskSelector(task.id));
    if (card) {
      card.classList.add('quick-enter');
      setTimeout(function () { card.classList.remove('quick-enter'); }, 300);
    }
  }

  function syncProgressCardFromTask(card, task) {
    if (!card || !task) return;
    const progress = taskProgress(task);
    const completed = task.status === 'done';
    const goalReady = !completed && studyGoalReady(task, progress);

    // 完成态与“目标已达、等待手动确认”是两层独立语义。
    card.classList.toggle('is-completed', completed);
    card.classList.toggle('is-goal-ready', goalReady);
    if (!goalReady) card.classList.remove('is-goal-pending', 'is-goal-celebrating');

    // 勾选按钮 — 原地更新状态 + 弹簧动画（复刻 focus-daily-check）
    const check = card.querySelector('.study-progress-check');
    if (check) {
      var wasOn = check.classList.contains('on');
      check.classList.toggle('on', completed);
      check.textContent = '';
      setStudyAriaLabel(check, completed
        ? '恢复任务'
        : goalReady ? '目标已达成，可以手动标记完成' : '标记完成');
      if (wasOn !== completed && !prefersReduced) {
        replayClass(check, completed ? 'is-check-pop' : 'is-uncheck-pop', 420);
      }
    }

    // 标题
    const title = card.querySelector('.study-progress-card-head strong');
    if (title) title.textContent = task.title || '未命名任务';

    // 进度数值
    const value = card.querySelector('.study-progress-value');
    if (value) syncStudyProgressValue(value, progress, goalReady);

    // 进度条（existing element → CSS transition fires）
    var shell = card.querySelector('.study-progress-track-shell');
    if (shell) {
      syncStudyProgressBar(shell, task);
    }

    // −1 / +1 按钮（仅未完成任务有）
    const controls = card.querySelector('.study-progress-controls');
    if (controls) {
      if (completed || !progress.target) {
        controls.style.display = 'none';
      } else {
        controls.style.display = '';
        var btns = controls.querySelectorAll('button');
        if (btns[0]) btns[0].disabled = progress.current <= 0;
        if (btns[1]) btns[1].disabled = progress.current >= progress.target;
      }
    }
  }

  // —— 增量同步：不销毁卡片，只更新 / 移动 / 新增 / 移除 ——
  function incrementalSyncCardList(container, tasks, completed, emptyMessage) {
    if (!container) return;

    // 收集现有卡片
    var existing = {};
    var cardList = Array.from(container.querySelectorAll('.study-progress-card'));
    cardList.forEach(function (card) {
      if (card.dataset.id) existing[card.dataset.id] = card;
    });

    var desiredIds = {};
    tasks.forEach(function (t) { desiredIds[t.id] = true; });

    // 移除不在目标集合中的卡片（带退场动画）
    cardList.forEach(function (card) {
      if (!desiredIds[card.dataset.id]) {
        if (!prefersReduced) {
          card.classList.add('is-leaving');
          setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 280);
        } else {
          if (card.parentNode) card.parentNode.removeChild(card);
        }
      }
    });

    // 空态处理
    if (!tasks.length) {
      container.innerHTML = '';
      if (emptyMessage) {
        var empty = document.createElement('p');
        empty.className = 'study-progress-empty';
        empty.textContent = emptyMessage;
        container.appendChild(empty);
      }
      return;
    }

    // 移除空态占位
    var existingEmpty = container.querySelector('.study-progress-empty');
    if (existingEmpty) existingEmpty.remove();

    // 按顺序摆放：已存在的移动位置 + 同步内容，不存在的创建新卡片
    // 若卡片结构不匹配（如新增/移除了进度条），则重建而非同步
    var fragment = document.createDocumentFragment();
    tasks.forEach(function (task) {
      var card = existing[task.id];
      if (card && cardProgressStructureOk(card, task, completed)) {
        syncProgressCardFromTask(card, task);
        fragment.appendChild(card);   // 从原位置移入 fragment
      } else {
        if (card && card.parentNode) card.parentNode.removeChild(card);
        card = buildProgressCard(task, completed);
        if (!prefersReduced && !completed) card.classList.add('is-entering');
        fragment.appendChild(card);
      }
    });

    // 保留正在退场的卡片，其余清空后放入新 fragment
    var leavingCards = [];
    Array.from(container.children).forEach(function (child) {
      if (child.classList.contains('study-progress-card') && child.classList.contains('is-leaving')) {
        leavingCards.push(child);
      }
    });
    container.innerHTML = '';
    container.appendChild(fragment);
    // 为错峰入场动画设置行序号（复刻专注页 --daily-row-index）
    var allCards = container.querySelectorAll('.study-progress-card:not(.is-leaving)');
    allCards.forEach(function (card, i) {
      card.style.setProperty('--study-row-index', String(Math.min(i, 7)));
    });
    leavingCards.forEach(function (card) { container.appendChild(card); });

    // 清除入场类（动画播完后）
    if (!prefersReduced) {
      var enteringCards = container.querySelectorAll('.study-progress-card.is-entering');
      setTimeout(function () {
        enteringCards.forEach(function (el) { el.classList.remove('is-entering'); });
      }, 460);
    }
  }

  function changeTaskProgress(task, delta) {
    var progress = taskProgress(task);
    if (!progress.target || task.status === 'done') return;
    var nextValue = Math.max(0, Math.min(progress.target, progress.current + delta));
    if (nextValue === progress.current) return;

    var prevValue = progress.current;
    task.progress.current = nextValue;
    if (goalTreeOpen) syncGoalTreeProgress(task.id);

    // 先对已有卡片做原地 fill 宽度更新（CSS transition 会触发）。
    var card = document.querySelector('.study-progress-card' + taskSelector(task.id));
    if (card) {
      if (!prefersReduced && prevValue < progress.target && nextValue >= progress.target) {
        cancelReplayClass(card, 'is-goal-breathing');
        card.classList.add('is-goal-pending');
      } else if (!prefersReduced && prevValue >= progress.target && nextValue < progress.target) {
        cancelReplayClass(card, 'is-goal-breathing');
        cancelReplayClass(card, 'is-goal-celebrating');
        card.classList.remove('is-goal-pending');
      }
      // 共享轨道直接从浏览器当前插值宽度过渡到新值；不强制回流，也不重播卡片入场。
      syncProgressCardFromTask(card, task);
    }

    var seq = (taskProgressSeq.get(task) || 0) + 1;
    taskProgressSeq.set(task, seq);
    var request = queueTaskMutation(task, function () {
      return post('/api/study-task-progress', { id: task.id, delta: delta });
    }).then(function (json) {
      if (json.goalTree) state.goalTree = json.goalTree;
      if (taskProgressSeq.get(task) === seq) {
        var serverProgress = taskProgress(json.task || {});
        var needsReconcile = serverProgress.current !== taskProgress(task).current
          || serverProgress.target !== taskProgress(task).target;
        Object.assign(task, json.task || {});
        if (needsReconcile) {
          var synced = document.querySelector('.study-progress-card' + taskSelector(task.id));
          if (synced) syncProgressCardFromTask(synced, task);
          if (goalTreeOpen) syncGoalTreeProgress(task.id);
        }
      }
      var crossed = Array.isArray(json.crossedMilestoneIds) ? json.crossedMilestoneIds : [];
      if (crossed.length) {
        requestAnimationFrame(function () {
          crossed.forEach(function (id) {
            var c = document.querySelector('.study-progress-card' + taskSelector(task.id));
            var m = c && Array.from(c.querySelectorAll('[data-milestone-id]'))
              .find(function (item) { return item.dataset.milestoneId === String(id); });
            if (m) replayClass(m, 'is-just-reached', STUDY_MILESTONE_REACHED_CLEANUP_MS);
          });
        });
      }
      var reachedCard = document.querySelector('.study-progress-card' + taskSelector(task.id));
      if (reachedCard && taskProgressSeq.get(task) === seq) {
        reachedCard.classList.remove('is-goal-pending');
        if (json.targetReached && studyGoalReady(task) && !prefersReduced) {
          cancelReplayClass(reachedCard, 'is-goal-breathing');
          replayClass(reachedCard, 'is-goal-celebrating', 1480);
          scheduleStudyGoalBreath(1560);
          scheduleStudyGoalCheckFlow(1560);
        }
      }
    }).catch(function (error) {
      showToast(error.message);
      if (taskProgressSeq.get(task) !== seq) return null;
      task.progress.current = prevValue;
      var rollbackCard = document.querySelector('.study-progress-card' + taskSelector(task.id));
      if (rollbackCard) syncProgressCardFromTask(rollbackCard, task);
      if (goalTreeOpen) syncGoalTreeProgress(task.id);
      return null;
    });
  }

  function renderProgress() {
    if (!progressListEl || !completedListEl || !completedSectionEl) return;
    // 拖拽排序期间不重建卡片列表，避免掐断幽灵卡与 FLIP 动画
    if (progressDrag && progressDrag.active) return;
    var active = state.tasks.filter(function (t) { return t.status === 'active'; });
    var done = state.tasks.filter(function (t) { return t.status === 'done'; });
    var count = document.querySelector('[data-role="study-task-count"]');
    var activeCount = document.querySelector('[data-role="study-active-count"]');
    var doneCount = document.querySelector('[data-role="study-completed-count"]');
    if (count) count.textContent = String(state.tasks.length);
    if (activeCount) activeCount.textContent = String(active.length);
    if (doneCount) doneCount.textContent = String(done.length);

    // 增量同步：保留已有卡片 DOM，只更新内容与顺序
    var emptyMsg = done.length ? '当前没有未完成任务。' : '还没有学习任务，点击右上角的 ＋ 开始。';
    incrementalSyncCardList(progressListEl, active, false, emptyMsg);

    // 已完成列始终可见，保持双列布局避免未完成卡片被拉长
    completedSectionEl.hidden = false;
    incrementalSyncCardList(completedListEl, done, true, '还没有已完成的任务。');
  }

  function render(options) {
    applyViewMode();
    if (viewMode === 'list') {
      var listHost = document.querySelector('[data-role="study-list"]');
      var prevListRects = captureListRects(listHost, '.study-list-row');
      renderList();
      requestAnimationFrame(function () { animateListMoves(listHost, '.study-list-row', prevListRects); });
    } else {
      renderProgress();
    }
    if (progressSettingsPopover
        && ((!goalTreeOpen && viewMode !== 'progress') || !progressSettingsTrigger || !progressSettingsTrigger.isConnected)) {
      closeProgressSettings(false, true);
    }
    renderTrash();
    if (goalTreeOpen && !(options && options.skipGoalTree)) renderGoalTree();
  }

  // —— 一年活跃热力图（已完成任务，按完成日；含归档历史，数据来自 /api/study-activity）——
  // 算法移植自博客 build.py 的 GitHub 风格贡献图：每页是一整个自然年，横轴按周、纵轴 7 天
  // （周一在上、周日在下），单元格颜色按当日「完成数量」分 5 档。活跃图与 render() 解耦。
  let activityDays = {};
  let activityPayload = null;
  let cadenceYear = '';
  let cadenceFlipping = false;
  let cadenceLoadSeq = 0;
  let activityDirty = true;
  let activityLoadPromise = null;
  let activityPreloadHandle = 0;
  let activityPreloadUsesIdle = false;
  let studyPreloadHandle = 0;
  let studyPreloadUsesIdle = false;
  let cadenceVisibleSyncFrame = 0;
  let cadenceYearWheelAccum = 0;
  let cadenceYearWheelTimer = 0;
  let starInstance = null;   // 足迹星图当前实例（活跃图重绘时先销毁旧实例再挂新的）
  let cadenceShown = false;  // 活跃页当前是否被选为前置页（起步页翻页时由 StudyActivity.setActive 同步）
  let starMode = 'normal';
  let cadenceLens = 'canvas';   // v2 首次默认画布；之后记住 canvas / complete / focus
  try {
    const storedLens = localStorage.getItem('canvas:cadenceLens:v2');
    if (storedLens === 'canvas' || storedLens === 'complete' || storedLens === 'focus') cadenceLens = storedLens;
  } catch (e) {}
  let cadenceInteractionCleanup = null;
  const CADENCE = { cell: 16, gap: 4, leftPad: 38, topPad: 28 };
  const CADENCE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function cadenceLevel(n) {
    if (!n) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n <= 4) return 3;
    if (n <= 7) return 4;
    if (n <= 10) return 5;
    if (n <= 14) return 6;
    return 7;
  }

  // 专注热力档位：按当天专注分钟分级（配套独立的暖棕色阶，与完成数的火红区分）。
  function cadenceFocusLevel(min) {
    if (!min) return 0;
    if (min <= 15) return 1;
    if (min <= 30) return 2;
    if (min <= 60) return 3;
    if (min <= 120) return 4;
    if (min <= 180) return 5;
    if (min <= 300) return 6;
    return 7;
  }
  function fmtFocusDur(min) {
    min = Math.round(min || 0);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  // 专注统计卡片的数字 + 单位（<1 小时显示分钟，否则 X.X 小时）。
  function fmtFocusStat(sec) {
    const min = Math.round((sec || 0) / 60);
    if (min < 60) return { num: String(min), unit: '分钟' };
    return { num: (min / 60).toFixed(1).replace(/\.0$/, ''), unit: '小时' };
  }
  function focusStatCell(sec, label) {
    const f = fmtFocusStat(sec);
    return '<div><strong>' + f.num + '<small> ' + f.unit + '</small></strong><span>' + label + '</span></div>';
  }

  function canvasStatCell(sec, label) {
    if (Number(sec) > 0 && Number(sec) < 60) {
      return '<div><strong>&lt;1<small> 分钟</small></strong><span>' + label + '</span></div>';
    }
    return focusStatCell(sec, label);
  }

  function fmtCanvasDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (sec > 0 && sec < 60) return '不足 1 分钟';
    return fmtFocusDur(Math.round(sec / 60));
  }

  function cadenceCanvasDayDetailHtml(day, entries, summary, todayKey) {
    const items = (entries || []).filter((item) => item.day === day);
    const future = day > todayKey;
    const durationSec = Math.max(0, Number(summary && summary.durationSec) || 0);
    let note = '这一天还没有画布使用记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !items.length) note = '今天还没有打开画布。';
    const list = items.length
      ? '<div class="cadence-day-detail-list">' + items.map((item, index) => {
        const flags = [];
        if (item.created) flags.push('<i>新建</i>');
        if (item.modified) flags.push('<i>修改</i>');
        if (item.inferred && !item.durationSec) flags.push('<i>历史记录</i>');
        const duration = item.durationSec
          ? '<span>' + escapeHtml(fmtCanvasDuration(item.durationSec)) + '</span>'
          : '<span>历史时长无法还原</span>';
        const open = item.canvasAvailable
          ? '<button type="button" class="cadence-open-canvas cadence-day-open" data-canvas-path="'
            + escapeHtml(item.path) + '">打开画布</button>'
          : '';
        return '<div class="cadence-day-detail-item cadence-canvas-detail-item" style="--detail-delay:'
          + (index * 45) + 'ms"><span aria-hidden="true"></span><div class="cadence-record-copy">'
          + '<strong>' + escapeHtml(item.title || '未命名画布') + '</strong>'
          + '<span class="cadence-canvas-meta">' + flags.join('') + duration + '</span></div>' + open + '</div>';
      }).join('') + '</div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    const heading = items.length
      ? '使用 ' + items.length + ' 张画布' + (durationSec ? ' · ' + fmtCanvasDuration(durationSec) : '')
      : '安静的一天';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + heading + '</h3></div>' + list;
  }
  function cadenceFocusDayDetailHtml(day, sec, count, todayKey) {
    const future = day > todayKey;
    const min = Math.round((sec || 0) / 60);
    let note = '这一天没有专注记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !min) note = '今天还没有开始专注。';
    const body = min
      ? '<div class="cadence-day-detail-focus"><strong>' + fmtFocusDur(min) + '</strong>'
        + '<span>共 ' + count + ' 段专注</span></div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + (min ? '专注 ' + fmtFocusDur(min) : '安静的一天') + '</h3></div>'
      + body;
  }

  function cadenceReflection(reflection) {
    if (!reflection) return '这里会慢慢长出你的节奏。';
    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月',
      '七月', '八月', '九月', '十月', '十一月', '十二月'];
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const month = parseInt(String(reflection.month || '').slice(5, 7), 10);
    return (monthNames[month - 1] || reflection.month) + '，你完成了 ' + reflection.count
      + ' 件事。最常在' + (weekdayNames[reflection.weekday] || '某一天') + '留下痕迹。';
  }

  function cadenceDateLabel(day, withYear) {
    const date = new Date(String(day || '') + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return String(day || '');
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return (withYear ? date.getFullYear() + ' 年 ' : '')
      + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日 · ' + weekdays[date.getDay()];
  }

  function cadenceRecordCopy(item) {
    const title = '<strong>' + escapeHtml(item.title || '未命名任务') + '</strong>';
    if (item.kind !== 'taskbook') return title;
    const leafCount = Math.max(0, Number(item.leafCount) || 0);
    const duration = focusDurationLabel(Math.max(0, Number(item.durationMs) || 0) / 1000);
    return title + '<span class="cadence-taskbook-meta"><i>任务簿</i><span>'
      + leafCount + ' 项 · ' + escapeHtml(duration) + '</span></span>';
  }

  function cadenceDayDetailHtml(day, entries, count, todayKey) {
    const items = (entries || []).filter((item) => item.day === day);
    const future = day > todayKey;
    let note = '这一天还没有留下完成记录。';
    if (future) note = '这一天还在前方。';
    else if (day === todayKey && !count) note = '今天仍是一张等待落笔的纸。';
    const list = items.length
      ? '<div class="cadence-day-detail-list">' + items.map((item, index) => {
        const canvas = item.canvasAvailable
          ? '<button type="button" class="cadence-open-canvas cadence-day-open" data-canvas-path="'
            + escapeHtml(item.linkedCanvas) + '">打开画布</button>'
          : '';
        return '<div class="cadence-day-detail-item" style="--detail-delay:' + (index * 45) + 'ms">'
          + '<span aria-hidden="true"></span><div class="cadence-record-copy">'
          + cadenceRecordCopy(item) + '</div>' + canvas + '</div>';
      }).join('') + '</div>'
      : '<p class="cadence-day-detail-empty">' + note + '</p>';
    return '<div class="cadence-day-detail-copy"><p>' + escapeHtml(cadenceDateLabel(day, true)) + '</p>'
      + '<h3>' + (count ? '留下 ' + count + ' 道足迹' : '安静的一天') + '</h3></div>'
      + list;
  }

  function recentCadenceHtml(recent) {
    if (!recent.length) {
      return '<p class="cadence-empty">归档过的任务，会安静地留在这里。</p>';
    }
    const groups = [];
    recent.forEach((item) => {
      const day = String(item.day || '');
      let group = groups[groups.length - 1];
      if (!group || group.day !== day) {
        group = { day, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    });
    return '<div class="cadence-recent-list">' + groups.map((group, index) => {
      const date = new Date(group.day + 'T00:00:00');
      const label = Number.isNaN(date.getTime())
        ? group.day
        : CADENCE_MONTHS[date.getMonth()] + ' ' + String(date.getDate()).padStart(2, '0');
      return '<section class="cadence-recent-group" style="--cadence-group-delay:' + (index * 52) + 'ms">'
        + '<time>' + escapeHtml(label) + '</time><div class="cadence-recent-group-items">'
        + group.items.map((item) => {
          const canvas = item.canvasAvailable
            ? '<button type="button" class="cadence-open-canvas" data-canvas-path="'
              + escapeHtml(item.linkedCanvas) + '">打开画布</button>'
            : '';
          return '<div class="cadence-recent-item"><span class="cadence-recent-dot"></span>'
            + '<div class="cadence-record-copy">' + cadenceRecordCopy(item) + '</div>'
            + canvas + '</div>';
        }).join('') + '</div></section>';
    }).join('') + '</div>';
  }

  function cadenceYearSpineHtml(years, activeYear) {
    return '<nav class="cadence-year-spine" data-role="cadence-year-spine" aria-label="活跃年份翻页">'
      + '<span class="cadence-year-orb" data-role="cadence-year-orb" aria-hidden="true"></span>'
      + years.map((year) => '<button type="button" class="cadence-year-dot'
        + (String(year) === String(activeYear) ? ' active' : '') + '" data-cadence-year="' + year
        + '" aria-label="查看 ' + year + ' 年"><i aria-hidden="true"></i><span>' + year + ' 年</span></button>').join('')
      + '</nav>';
  }

  function syncCadenceYearOrb(host, fromYear) {
    const spine = host.querySelector('[data-role="cadence-year-spine"]');
    const orb = host.querySelector('[data-role="cadence-year-orb"]');
    const active = spine && spine.querySelector('.cadence-year-dot.active');
    if (!spine || !orb || !active) return;
    const spineRect = spine.getBoundingClientRect();
    function transformFor(button) {
      const rect = button.getBoundingClientRect();
      return 'translate3d(' + (rect.left - spineRect.left + (rect.width - 14) / 2) + 'px,'
        + (rect.top - spineRect.top + (rect.height - 14) / 2) + 'px,0)';
    }
    const previous = fromYear && spine.querySelector('[data-cadence-year="' + fromYear + '"]');
    if (previous && previous !== active && !prefersReduced) {
      orb.classList.add('no-transition');
      orb.style.transform = transformFor(previous);
      orb.classList.add('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        orb.classList.remove('no-transition');
        orb.style.transform = transformFor(active);
      }));
      return;
    }
    orb.style.transform = transformFor(active);
    orb.classList.add('show');
  }

  function placeStarModeSlider(sw, animate) {
    const slider = sw && sw.querySelector('[data-role="star-mode-slider"]');
    const active = sw && sw.querySelector('.star-mode-btn.active');
    if (!slider || !active || !active.offsetWidth) return;
    if (!animate) slider.classList.add('no-transition');
    slider.style.width = active.offsetWidth + 'px';
    slider.style.height = active.offsetHeight + 'px';
    slider.style.transform = 'translate3d(' + active.offsetLeft + 'px,' + active.offsetTop + 'px,0)';
    slider.classList.add('show');
    if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => slider.classList.remove('no-transition')));
  }

  function mountStarGraph(host, payload, options) {
    if (starInstance) { try { starInstance.destroy(); } catch (e) {} starInstance = null; }
    const starStage = host.querySelector('[data-role="study-starmap"]');
    if (starStage && window.StudyGraph) {
      const canvasLens = cadenceLens === 'canvas';
      const graph = starMode === 'overview'
        ? (canvasLens ? (payload.canvasOverviewGraph || {}) : (payload.overviewGraph || {}))
        : (canvasLens ? (payload.canvasGraph || {}) : (payload.graph || {}));
      // 活跃页不是当前前置页时，星图以挂起态挂载（建好静态帧但不空转 RAF），进入活跃页再唤醒。
      starInstance = window.StudyGraph.mount(starStage, graph, {
        active: cadenceShown,
        intro: !(options && options.intro === false),
      });
    }
  }

  function setupStarModeSwitch(host, payload) {
    const sw = host.querySelector('[data-role="star-mode-switch"]');
    if (!sw) return;
    const buttons = Array.from(sw.querySelectorAll('.star-mode-btn'));
    function apply(animate, remount) {
      buttons.forEach((button) => button.classList.toggle('active', button.dataset.starMode === starMode));
      placeStarModeSlider(sw, animate);
      if (!remount) return;
      mountStarGraph(host, payload, { intro: true });
    }
    buttons.forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.starMode === starMode) return;
      starMode = button.dataset.starMode;
      apply(true, true);
    }));
    apply(false, false);
    // 动态活动页会先以中文建 DOM，再由 i18n 的 MutationObserver 翻译；
    // 下一帧按最终文案重量一次，避免英文 “Normal” 仍沿用中文按钮宽度而被裁切。
    requestAnimationFrame(() => placeStarModeSlider(sw, false));
  }

  function renderCadence(payload, options) {
    const host = document.querySelector('[data-role="study-cadence"]');
    if (!host) return;
    const days = payload.days || {};
    const entries = payload.entries || payload.recent || [];
    const stats = payload.stats || {};
    const recent = payload.recent || [];
    const focusDays = payload.focusDays || {};   // { 'YYYY-MM-DD': {sec,count} } 当年逐日专注
    const focusStats = payload.focusStats || {};  // { today, month, year, total }（秒）
    const canvasDays = payload.canvasDays || {};
    const canvasEntries = payload.canvasEntries || [];
    const canvasStats = payload.canvasStats || {};
    const C = CADENCE;
    const step = C.cell + C.gap;
    const now = new Date();
    const todayKey = localDay(now);
    const year = Number(payload.year) || now.getFullYear();
    const years = (payload.years || [year]).slice();
    const currentYear = year === now.getFullYear();
    // 每页是一整个自然年：左端补到该年元旦所在周的周一，右端补到年末所在周的周日。
    const yearStart = new Date(year, 0, 1);
    const start = new Date(yearStart);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(year, 11, 31);
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
    const weeks = Math.floor((end - start) / (7 * 86400000)) + 1;
    const rects = [];
    const monthLabels = [];
    let prevMonth = -1;
    let lastLabelW = -99;
    for (let w = 0; w < weeks; w++) {
      let columnMonth = -1;
      for (let d = 0; d < 7; d++) {
        const probe = new Date(start);
        probe.setDate(start.getDate() + w * 7 + d);
        if (probe.getFullYear() === year) { columnMonth = probe.getMonth(); break; }
      }
      if (columnMonth !== -1 && columnMonth !== prevMonth) {
        // 相邻月份保持 >=2 列间距，避免短月边界挤成一团。
        if (w - lastLabelW >= 2) {
          monthLabels.push('<text class="cadence-month" data-month="' + columnMonth + '" x="'
            + (C.leftPad + w * step) + '" y="' + (C.topPad - 9) + '">'
            + CADENCE_MONTHS[columnMonth] + '</text>');
          lastLabelW = w;
        }
        prevMonth = columnMonth;
      }
      for (let d = 0; d < 7; d++) {
        const cell = new Date(start);
        cell.setDate(start.getDate() + w * 7 + d);
        if (cell.getFullYear() !== year) continue;
        const key = localDay(cell);
        const count = days[key] || 0;
        const lv = cadenceLevel(count);
        const future = key > todayKey;
        const isToday = key === todayKey;
        const tip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : count ? ' · 完成 ' + count + ' 项' : ' · 暂无记录');
        const fd = focusDays[key];
        const fmin = fd ? Math.round((fd.sec || 0) / 60) : 0;
        const fcount = fd ? (fd.count || 0) : 0;
        const flv = cadenceFocusLevel(fmin);
        const ftip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : fmin ? ' · 专注 ' + fmtFocusDur(fmin) : ' · 未专注');
        const cd = canvasDays[key] || {};
        const csec = Math.max(0, Number(cd.durationSec) || 0);
        const cmin = csec ? Math.max(1, Math.ceil(csec / 60)) : 0;
        const clv = cadenceFocusLevel(cmin);
        const canvasHistorical = !!cd.inferred && !csec;
        const ctip = cadenceDateLabel(key, false) + (future
          ? ' · 尚未到来'
          : csec ? ' · 画布 ' + fmtCanvasDuration(csec)
            : canvasHistorical ? ' · 有历史画布记录，时长无法还原' : ' · 未使用画布');
        const activeTip = cadenceLens === 'canvas' ? ctip : (cadenceLens === 'focus' ? ftip : tip);
        rects.push('<rect x="' + (C.leftPad + w * step) + '" y="' + (C.topPad + d * step)
          + '" width="' + C.cell + '" height="' + C.cell + '" rx="3" class="cadence-cell cadence-l'
          + lv + ' cadence-fl' + flv + ' cadence-cl' + clv + (count ? ' has-activity' : '')
          + (canvasHistorical ? ' has-canvas-history' : '') + (future ? ' is-future' : '')
          + (isToday ? ' is-today' : '')
          + '" style="--cadence-delay:' + Math.round(Math.min(760, d * 92 + w * 5))
          + 'ms" data-wave-x="' + (C.leftPad + w * step + C.cell / 2) + '" data-wave-y="'
          + (C.topPad + d * step + C.cell / 2) + '" data-wave-w="' + w + '" data-wave-d="' + d
          + '" data-month="' + cell.getMonth() + '" data-day-key="' + key + '" data-count="' + count
          + '" data-focus-min="' + fmin + '" data-focus-count="' + fcount
          + '" data-canvas-sec="' + csec + '" data-tip="' + escapeHtml(tip)
          + '" data-tip-focus="' + escapeHtml(ftip) + '" data-tip-canvas="' + escapeHtml(ctip)
          + '" tabindex="' + (future ? '-1' : '0')
          + '" role="button" aria-label="' + escapeHtml(activeTip) + '"></rect>');
      }
    }
    const dayLabels = [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']].map((p) =>
      '<text class="cadence-day" data-day="' + p[0] + '" x="' + (C.leftPad - 7) + '" y="'
        + (C.topPad + p[0] * step + C.cell - 2) + '" text-anchor="end">' + p[1] + '</text>');
    const svgW = C.leftPad + weeks * step + 6;
    const svgH = C.topPad + 7 * step + 4;
    const statOne = currentYear ? (stats.monthTotal || 0) : (payload.pageTotal || 0);
    const statOneLabel = currentYear ? '本月完成' : year + ' 年完成';
    const statTwo = currentYear ? (stats.streak || 0) : (stats.longestStreak || 0);
    const statTwoLabel = currentYear ? '连续推进' : '最长连续';
    const activeSource = cadenceLens === 'canvas' ? canvasDays : (cadenceLens === 'focus' ? focusDays : days);
    const activeKeys = Object.keys(activeSource).filter((key) => activeSource[key] && key <= todayKey).sort();
    const initialDay = currentYear
      ? todayKey
      : (activeKeys[activeKeys.length - 1] || year + '-01-01');
    const contentHtml =
      '<div class="study-cadence-head">'
        + '<div><p class="study-eyebrow">YEAR IN MOTION · ' + year + '</p>'
          + '<div class="cadence-title-row"><h2>年度足迹</h2><span>' + year + '</span></div></div>'
        + '<div class="cadence-head-tools">'
        + '<div class="cadence-lens-switch" data-role="cadence-lens-switch" data-active="' + cadenceLens + '" aria-label="热力图查看">'
          + '<span class="cadence-lens-slider" aria-hidden="true"></span>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'canvas' ? ' active' : '') + '" data-lens="canvas">画布</button>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'complete' ? ' active' : '') + '" data-lens="complete">完成</button>'
          + '<button type="button" class="cadence-lens-btn' + (cadenceLens === 'focus' ? ' active' : '') + '" data-lens="focus">专注</button>'
        + '</div>'
        + '<div class="cadence-legend" aria-label="足迹浓度从静到丰"><span>静</span>'
        + '<span class="cadence-legend-cells">'
        + '<span class="cadence-legend-cell cadence-l0"></span>'
        + '<span class="cadence-legend-cell cadence-l1"></span>'
        + '<span class="cadence-legend-cell cadence-l2"></span>'
        + '<span class="cadence-legend-cell cadence-l3"></span>'
        + '<span class="cadence-legend-cell cadence-l4"></span>'
        + '<span class="cadence-legend-cell cadence-l5"></span>'
        + '<span class="cadence-legend-cell cadence-l6"></span>'
        + '<span class="cadence-legend-cell cadence-l7"></span>'
        + '</span><span>丰</span></div>'
        + '<button type="button" class="page-refresh" data-cadence-refresh'
        + ' aria-label="重新读取活跃数据" title="重新统计一年活跃热力图（画布计时、完成任务或专注后想立刻看到，点这里）">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
        + '<span>更新</span></button>'
        + '</div>'
      + '</div>'
      + '<div class="cadence-chart-shell">'
        + '<div class="cadence-chart-wrap">'
        + '<svg class="cadence-chart" viewBox="0 0 ' + svgW + ' ' + svgH + '" width="' + svgW
        + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg" role="img"'
        + ' aria-label="' + year + (cadenceLens === 'canvas' ? ' 年逐日画布使用时长热力图'
          : cadenceLens === 'focus' ? ' 年逐日专注时长热力图' : ' 年逐日已完成任务热力图') + '">'
        + monthLabels.join('') + dayLabels.join('') + rects.join('')
        + '</svg>'
        + '</div>'
        + '<div class="cadence-chart-caption"><span><i class="is-today-mark"></i>今天</span>'
          + '<span><i class="is-future-mark"></i>尚未到来</span>'
          + '<p>' + (cadenceLens === 'canvas' ? '悬停回望，点击展开当天画布' : '悬停回望，点击展开当天成果') + '</p></div>'
      + '</div>'
      + '<section class="cadence-day-detail" data-role="cadence-day-detail" aria-live="polite">'
        + (cadenceLens === 'canvas'
          ? cadenceCanvasDayDetailHtml(initialDay, canvasEntries, canvasDays[initialDay] || {}, todayKey)
          : cadenceLens === 'focus'
            ? cadenceFocusDayDetailHtml(initialDay, (focusDays[initialDay] || {}).sec || 0,
                (focusDays[initialDay] || {}).count || 0, todayKey)
            : cadenceDayDetailHtml(initialDay, entries, days[initialDay] || 0, todayKey))
      + '</section>'
      + '<div class="cadence-stats cadence-stats-canvas" aria-label="画布时间统计">'
        + canvasStatCell(currentYear ? canvasStats.monthSec : canvasStats.yearSec,
          currentYear ? '本月画布时间' : '当年画布时间')
        + '<div><strong>' + (currentYear ? (canvasStats.streak || 0) : (canvasStats.longestStreak || 0))
          + '<small> 天</small></strong><span>' + (currentYear ? '连续活跃' : '最长连续') + '</span></div>'
        + '<div><strong>' + (canvasStats.activeCanvasCount || 0) + '</strong><span>活跃画布</span></div>'
        + canvasStatCell(canvasStats.totalSec, '累计画布时间')
      + '</div>'
      + '<div class="cadence-stats cadence-stats-complete" aria-label="活跃统计">'
        + '<div><strong>' + statOne + '</strong><span>' + statOneLabel + '</span></div>'
        + '<div><strong>' + statTwo + '<small> 天</small></strong><span>' + statTwoLabel + '</span></div>'
        + '<div><strong>' + (payload.archiveFolders || 0) + '</strong><span>累计归档</span></div>'
        + '<div><strong>' + (payload.total || 0) + '</strong><span>累计完成</span></div>'
      + '</div>'
      + '<div class="cadence-stats cadence-stats-focus" aria-label="专注时间统计">'
        + focusStatCell(focusStats.today, '今日专注')
        + focusStatCell(focusStats.month, '本月专注')
        + focusStatCell(focusStats.year, '今年专注')
        + focusStatCell(focusStats.total, '累计专注')
      + '</div>'
      + '<section class="cadence-starmap">'
        + '<div class="cadence-starmap-head"><div><p class="study-eyebrow">STARMAP</p>'
          + '<h3 data-role="cadence-starmap-title">' + (cadenceLens === 'canvas' ? '画布星图' : '足迹星图') + '</h3></div>'
          + '<div class="cadence-starmap-tools">'
            + '<div class="star-mode-switch" data-role="star-mode-switch" aria-label="星图查看模式">'
              + '<span class="star-mode-slider" data-role="star-mode-slider" aria-hidden="true"></span>'
              + '<button type="button" class="star-mode-btn" data-star-mode="normal">正常</button>'
              + '<button type="button" class="star-mode-btn" data-star-mode="overview">总览</button>'
            + '</div>'
          + '</div></div>'
        + '<div class="cadence-starmap-stage" data-role="study-starmap"></div>'
      + '</section>'
      + '<section class="cadence-footprint">'
        + '<div class="cadence-footprint-head"><div><p class="study-eyebrow">FOOTPRINT</p>'
          + '<h3>最近完成</h3></div><p>' + escapeHtml(cadenceReflection(payload.reflection)) + '</p></div>'
        + recentCadenceHtml(recent)
      + '</section>';
    if (cadenceInteractionCleanup) {
      cadenceInteractionCleanup();
      cadenceInteractionCleanup = null;
    }
    if (starInstance) { try { starInstance.destroy(); } catch (e) {} starInstance = null; }
    const incoming = options && options.incoming;
    host.innerHTML =
      cadenceYearSpineHtml(years, year)
      + '<div class="cadence-year-page' + (incoming ? ' flip-in-' + incoming : '')
        + '" data-role="cadence-year-page">' + contentHtml + '</div>'
      + '<div class="cadence-tooltip" role="status" aria-hidden="true"></div>';
    host.classList.toggle('cadence-lens-focus', cadenceLens === 'focus');
    host.classList.toggle('cadence-lens-canvas', cadenceLens === 'canvas');
    const yearPage = host.querySelector('[data-role="cadence-year-page"]');
    if (incoming && yearPage && !prefersReduced) {
      void yearPage.offsetHeight;
      yearPage.classList.remove('flip-in-' + incoming);
    }
    syncCadenceYearOrb(host, options && options.orbFromYear);
    host.querySelectorAll('[data-cadence-year]').forEach((button) => {
      button.addEventListener('click', () => navigateCadenceYear(button.dataset.cadenceYear));
    });
    const yearSpine = host.querySelector('[data-role="cadence-year-spine"]');
    if (yearSpine) {
      yearSpine.addEventListener('wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();   // 窄窗口下年份书脊会靠近外层书脊，避免一次滚轮同时翻两层页
        if (cadenceFlipping) return;
        cadenceYearWheelAccum += event.deltaY;
        clearTimeout(cadenceYearWheelTimer);
        cadenceYearWheelTimer = setTimeout(() => { cadenceYearWheelAccum = 0; }, 200);
        if (Math.abs(cadenceYearWheelAccum) < 24) return;
        const delta = cadenceYearWheelAccum > 0 ? 1 : -1;
        cadenceYearWheelAccum = 0;
        flipCadenceYearBy(delta);
      }, { passive: false });
    }
    mountStarGraph(host, payload);
    setupStarModeSwitch(host, payload);
    const wrap = host.querySelector('.cadence-chart-wrap');
    if (wrap) wrap.scrollLeft = 0;
    const tooltip = host.querySelector('.cadence-tooltip');
    const svg = host.querySelector('.cadence-chart');
    const cells = Array.from(host.querySelectorAll('.cadence-cell'));
    const monthEls = Array.from(host.querySelectorAll('.cadence-month'));
    const dayEls = Array.from(host.querySelectorAll('.cadence-day'));
    const cellGrid = new Map(cells.map((cell) => [cell.dataset.waveW + ':' + cell.dataset.waveD, cell]));
    let focusedMonth = '';
    function setCadenceMonthFocus(month) {
      if (month === focusedMonth) return;
      focusedMonth = month;
      monthEls.forEach((label) => label.classList.toggle('is-focused', label.dataset.month === month));
    }
    let selectedDay = initialDay;
    let detailHeightAnim = null;   // 切换日期时的高度补间句柄；快速连切时先取消旧的，避免叠加
    // 当天详情按当前镜头取内容：画布时间 / 完成记录 / 专注时长。
    function detailHtmlForDay(day) {
      if (cadenceLens === 'canvas') {
        return cadenceCanvasDayDetailHtml(day, canvasEntries, canvasDays[day] || {}, todayKey);
      }
      if (cadenceLens === 'focus') {
        const fd = focusDays[day] || {};
        return cadenceFocusDayDetailHtml(day, fd.sec || 0, fd.count || 0, todayKey);
      }
      return cadenceDayDetailHtml(day, entries, days[day] || 0, todayKey);
    }
    // 换内容时先量旧高、换好量新高，用高度补间把跳变磨平，下方区块随之顺滑位移而非硬切。
    function applyDayDetail() {
      const detail = host.querySelector('[data-role="cadence-day-detail"]');
      if (!detail) return;
      const fromHeight = detail.offsetHeight;
      if (detailHeightAnim) { detailHeightAnim.cancel(); detailHeightAnim = null; detail.style.overflow = ''; }
      detail.classList.remove('is-refreshing');
      detail.innerHTML = detailHtmlForDay(selectedDay);
      detail.querySelectorAll('[data-canvas-path]').forEach((button) => {
        button.addEventListener('click', () => window.gotoEditor(button.dataset.canvasPath, null, false));
      });
      if (!prefersReduced) {
        const toHeight = detail.offsetHeight;
        if (fromHeight && toHeight && Math.abs(fromHeight - toHeight) > 0.5) {
          detail.style.overflow = 'hidden';
          const anim = detail.animate(
            [{ height: fromHeight + 'px' }, { height: toHeight + 'px' }],
            { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
          );
          detailHeightAnim = anim;
          anim.finished.catch(() => {}).then(() => {
            if (detailHeightAnim === anim) { detail.style.overflow = ''; detailHeightAnim = null; }
          });
        }
        void detail.offsetWidth;
        detail.classList.add('is-refreshing');
      }
    }
    function selectCadenceDay(cell, moveFocus) {
      if (!cell || cell.classList.contains('is-future')) return;
      selectedDay = cell.dataset.dayKey || selectedDay;
      cells.forEach((candidate) => candidate.classList.toggle('is-selected',
        candidate.dataset.dayKey === selectedDay));
      applyDayDetail();
      setCadenceMonthFocus(cell.dataset.month || '');
      if (moveFocus) cell.focus();
    }
    // 镜头切换：格子 / 图例 / 卡片靠 CSS 类瞬切，提示实时读，只重渲染「当天详情」一小块，星图不重挂。
    const lensSwitch = host.querySelector('[data-role="cadence-lens-switch"]');
    if (lensSwitch) {
      lensSwitch.querySelectorAll('.cadence-lens-btn').forEach((button) => {
        button.addEventListener('click', () => {
          const next = button.dataset.lens;
          if (next === cadenceLens) return;
          const remountStar = (next === 'canvas') !== (cadenceLens === 'canvas');
          cadenceLens = next;
          try { localStorage.setItem('canvas:cadenceLens:v2', cadenceLens); } catch (e) {}
          lensSwitch.dataset.active = cadenceLens;
          lensSwitch.querySelectorAll('.cadence-lens-btn').forEach((b) =>
            b.classList.toggle('active', b.dataset.lens === cadenceLens));
          host.classList.toggle('cadence-lens-focus', cadenceLens === 'focus');
          host.classList.toggle('cadence-lens-canvas', cadenceLens === 'canvas');
          cells.forEach((cell) => {
            const label = cadenceLens === 'canvas'
              ? (cell.dataset.tipCanvas || cell.dataset.tip)
              : cadenceLens === 'focus' ? (cell.dataset.tipFocus || cell.dataset.tip) : cell.dataset.tip;
            cell.setAttribute('aria-label', label);
          });
          const starTitle = host.querySelector('[data-role="cadence-starmap-title"]');
          if (starTitle) starTitle.textContent = cadenceLens === 'canvas' ? '画布星图' : '足迹星图';
          const chart = host.querySelector('.cadence-chart');
          if (chart) chart.setAttribute('aria-label', year + (cadenceLens === 'canvas'
            ? ' 年逐日画布使用时长热力图'
            : cadenceLens === 'focus' ? ' 年逐日专注时长热力图' : ' 年逐日已完成任务热力图'));
          const chartCaption = host.querySelector('.cadence-chart-caption p');
          if (chartCaption) chartCaption.textContent = cadenceLens === 'canvas'
            ? '悬停回望，点击展开当天画布'
            : '悬停回望，点击展开当天成果';
          if (remountStar) mountStarGraph(host, payload, { intro: true });
          applyDayDetail();
        });
      });
    }
    const cadenceRefresh = host.querySelector('[data-cadence-refresh]');
    if (cadenceRefresh) cadenceRefresh.addEventListener('click', () => refreshCadence(cadenceRefresh));
    const initialCell = cells.find((cell) => cell.dataset.dayKey === initialDay);
    if (initialCell) initialCell.classList.add('is-selected');
    let interactionFrame = 0;
    let pointerEvent = null;
    let geometry = null;
    let activeWaveCells = new Set();
    let tooltipCell = null;
    function refreshCadenceGeometry() {
      geometry = {
        host: host.getBoundingClientRect(),
        svg: svg ? svg.getBoundingClientRect() : null
      };
    }
    function clearCadenceWave() {
      activeWaveCells.forEach((cell) => {
        cell.style.removeProperty('--wave-scale');
        cell.style.removeProperty('--wave-lift');
        cell.classList.remove('is-wave');
      });
      activeWaveCells = new Set();
      dayEls.forEach((label) => label.classList.remove('is-focused'));
    }
    function renderCadenceInteraction() {
      interactionFrame = 0;
      if (!pointerEvent || prefersReduced) return;
      if (!geometry) refreshCadenceGeometry();
      const svgRect = geometry.svg;
      if (svgRect && pointerEvent.clientX >= svgRect.left && pointerEvent.clientX <= svgRect.right
          && pointerEvent.clientY >= svgRect.top && pointerEvent.clientY <= svgRect.bottom) {
        const svgW = C.leftPad + weeks * step + 6;
        const svgH = C.topPad + 7 * step + 4;
        const svgX = (pointerEvent.clientX - svgRect.left) * svgW / svgRect.width;
        const svgY = (pointerEvent.clientY - svgRect.top) * svgH / svgRect.height;
        const centerW = Math.round((svgX - C.leftPad - C.cell / 2) / step);
        const hoveredDay = Math.round((svgY - C.topPad - C.cell / 2) / step);
        const nextWaveCells = new Set();
        dayEls.forEach((label) => {
          label.classList.toggle('is-focused', Math.abs(Number(label.dataset.day) - hoveredDay) <= 1);
        });
        for (let w = Math.max(0, centerW - 5); w <= Math.min(weeks - 1, centerW + 5); w++) {
          for (let d = 0; d < 7; d++) {
            const cell = cellGrid.get(w + ':' + d);
            if (!cell) continue;
            const dx = svgX - Number(cell.dataset.waveX);
            const dy = svgY - Number(cell.dataset.waveY);
            const intensity = Math.max(0, 1 - Math.hypot(dx, dy) / (step * 4.2));
            const eased = intensity * intensity * (3 - 2 * intensity);
            if (eased < 0.015) continue;
            nextWaveCells.add(cell);
            cell.classList.add('is-wave');
            cell.style.setProperty('--wave-scale', (1 + eased * 0.055).toFixed(3));
            cell.style.setProperty('--wave-lift', (-eased * 1.8).toFixed(2) + 'px');
          }
        }
        activeWaveCells.forEach((cell) => {
          if (nextWaveCells.has(cell)) return;
          cell.style.removeProperty('--wave-scale');
          cell.style.removeProperty('--wave-lift');
          cell.classList.remove('is-wave');
        });
        activeWaveCells = nextWaveCells;
      } else {
        clearCadenceWave();
      }
    }
    function scheduleCadenceInteraction(event) {
      pointerEvent = event;
      if (!interactionFrame) interactionFrame = requestAnimationFrame(renderCadenceInteraction);
    }
    cadenceInteractionCleanup = function () {
      if (interactionFrame) cancelAnimationFrame(interactionFrame);
      interactionFrame = 0;
      pointerEvent = null;
      geometry = null;
      clearCadenceWave();
    };
    host.addEventListener('pointerenter', () => refreshCadenceGeometry());
    host.addEventListener('pointermove', (event) => {
      scheduleCadenceInteraction(event);
    });
    host.addEventListener('pointerleave', () => {
      if (interactionFrame) cancelAnimationFrame(interactionFrame);
      interactionFrame = 0;
      pointerEvent = null;
      geometry = null;
      clearCadenceWave();
    });
    if (wrap && tooltip) {
      wrap.addEventListener('scroll', () => { geometry = null; }, { passive: true });
      wrap.addEventListener('pointermove', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        setCadenceMonthFocus(cell ? (cell.dataset.month || '') : '');
        if (!cell || !cell.dataset.tip) {
          tooltipCell = null;
          tooltip.classList.remove('is-visible');
          tooltip.setAttribute('aria-hidden', 'true');
          return;
        }
        const hostRect = geometry ? geometry.host : host.getBoundingClientRect();
        if (cell !== tooltipCell) {
          tooltipCell = cell;
          tooltip.textContent = cadenceLens === 'canvas' && cell.dataset.tipCanvas
            ? cell.dataset.tipCanvas
            : (cadenceLens === 'focus' && cell.dataset.tipFocus) ? cell.dataset.tipFocus : cell.dataset.tip;
          tooltip.classList.add('is-visible');
          tooltip.setAttribute('aria-hidden', 'false');
        }
        const maxLeft = hostRect.width - 154;
        tooltip.style.left = Math.max(8, Math.min(maxLeft, event.clientX - hostRect.left + 12)) + 'px';
        tooltip.style.top = Math.max(8, event.clientY - hostRect.top - 34) + 'px';
      });
      wrap.addEventListener('pointerleave', () => {
        clearCadenceWave();
        tooltipCell = null;
        setCadenceMonthFocus('');
        dayEls.forEach((label) => label.classList.remove('is-focused'));
        tooltip.classList.remove('is-visible');
        tooltip.setAttribute('aria-hidden', 'true');
      });
      wrap.addEventListener('click', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        selectCadenceDay(cell, false);
      });
      wrap.addEventListener('keydown', (event) => {
        const cell = event.target.closest && event.target.closest('.cadence-cell');
        if (!cell) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectCadenceDay(cell, false);
          return;
        }
        const dayOffset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (!dayOffset) return;
        event.preventDefault();
        const date = new Date(cell.dataset.dayKey + 'T00:00:00');
        date.setDate(date.getDate() + dayOffset);
        const next = cells.find((candidate) => candidate.dataset.dayKey === localDay(date)
          && !candidate.classList.contains('is-future'));
        if (next) selectCadenceDay(next, true);
      });
    }
    host.querySelectorAll('[data-canvas-path]').forEach((button) => {
      button.addEventListener('click', () => window.gotoEditor(button.dataset.canvasPath, null, false));
    });
    const recentList = host.querySelector('.cadence-recent-list');
    if (recentList) {
      recentList.addEventListener('pointerover', (event) => {
        const item = event.target.closest && event.target.closest('.cadence-recent-item');
        if (!item) return;
        const group = item.closest('.cadence-recent-group');
        if (!group) return;
        recentList.classList.add('has-focus');
        recentList.querySelectorAll('.cadence-recent-group').forEach((candidate) => {
          candidate.classList.toggle('is-focused', candidate === group);
        });
      });
      recentList.addEventListener('pointerleave', () => {
        recentList.classList.remove('has-focus');
        recentList.querySelectorAll('.cadence-recent-group.is-focused').forEach((group) => {
          group.classList.remove('is-focused');
        });
      });
    }
  }

  function flipCadenceYearBy(delta) {
    const years = activityPayload && activityPayload.years || [];
    if (years.length < 2) return;
    let index = years.map(String).indexOf(String(cadenceYear));
    if (index < 0) index = 0;
    index = (index + delta) % years.length;
    if (index < 0) index += years.length;
    navigateCadenceYear(String(years[index]), delta > 0);
  }

  function navigateCadenceYear(nextYear, forwardHint) {
    const target = String(nextYear || '');
    if (!target || target === String(cadenceYear) || cadenceFlipping) return;
    const years = activityPayload && activityPayload.years || [];
    const fromYear = String(cadenceYear);
    const forward = typeof forwardHint === 'boolean'
      ? forwardHint
      : years.map(String).indexOf(target) >= years.map(String).indexOf(fromYear);
    const host = document.querySelector('[data-role="study-cadence"]');
    const page = host && host.querySelector('[data-role="cadence-year-page"]');
    cadenceFlipping = true;
    function loadNext() {
      queueActivityLoad(target, { incoming: forward ? 'r' : 'l', orbFromYear: fromYear }).then((loaded) => {
        if (!loaded && page) page.classList.remove('flip-out-l', 'flip-out-r');
        setTimeout(() => { cadenceFlipping = false; }, prefersReduced ? 0 : 240);
      });
    }
    if (prefersReduced || !page) {
      loadNext();
      return;
    }
    page.classList.add(forward ? 'flip-out-l' : 'flip-out-r');
    setTimeout(loadNext, 130);
  }

  async function loadActivity(year, options) {
    const seq = ++cadenceLoadSeq;
    try {
      const selected = year || cadenceYear;
      const json = await api('/api/study-activity' + (selected ? '?year=' + encodeURIComponent(selected) : ''));
      if (seq !== cadenceLoadSeq) return false;
      cadenceYear = String(json.year || '');
      activityPayload = json;
      activityDays = json.days || {};
      activityDirty = false;
      renderCadence(json, options);
      return true;
    } catch (e) {
      return false;   // 活跃图加载失败不打断学习页
    }
  }

  function queueActivityLoad(year, options) {
    const promise = loadActivity(year, options);
    activityLoadPromise = promise;
    promise.finally(() => {
      if (activityLoadPromise === promise) activityLoadPromise = null;
    }).catch(() => undefined);
    return promise;
  }

  function ensureActivityReady() {
    if (activityPayload && !activityDirty) return Promise.resolve(true);
    if (activityLoadPromise) return activityLoadPromise;
    return queueActivityLoad();
  }

  function cancelActivityPreload() {
    if (!activityPreloadHandle) return;
    if (activityPreloadUsesIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(activityPreloadHandle);
    } else {
      window.clearTimeout(activityPreloadHandle);
    }
    activityPreloadHandle = 0;
    activityPreloadUsesIdle = false;
  }

  function scheduleActivityPreload() {
    if (activityPreloadHandle || activityLoadPromise || (activityPayload && !activityDirty)) return;
    const warmActivity = () => {
      activityPreloadHandle = 0;
      activityPreloadUsesIdle = false;
      ensureActivityReady().catch(() => undefined);
    };
    activityPreloadUsesIdle = typeof window.requestIdleCallback === 'function';
    activityPreloadHandle = activityPreloadUsesIdle
      ? window.requestIdleCallback(warmActivity, { timeout: 1500 })
      : window.setTimeout(warmActivity, 600);
  }

  async function preloadStudy() {
    studyPreloadHandle = 0;
    studyPreloadUsesIdle = false;
    if (studyLoaded) return true;
    try {
      const json = await api('/api/study');
      applyStudyPayload(json);
      studyLoaded = true;
      window._relatumStudyData = json;
      return true;
    } catch (e) {
      return false;   // 静默失败——用户还没请求，不应弹 toast
    }
  }

  function scheduleStudyPreload() {
    if (studyPreloadHandle || studyLoaded) return;
    const warm = () => {
      studyPreloadHandle = 0;
      studyPreloadUsesIdle = false;
      preloadStudy().catch(() => undefined);
    };
    studyPreloadUsesIdle = typeof window.requestIdleCallback === 'function';
    studyPreloadHandle = studyPreloadUsesIdle
      ? window.requestIdleCallback(warm, { timeout: 1500 })
      : window.setTimeout(warm, 600);
  }

  function cancelCadenceVisibleSync() {
    if (!cadenceVisibleSyncFrame) return;
    window.cancelAnimationFrame(cadenceVisibleSyncFrame);
    cadenceVisibleSyncFrame = 0;
  }

  function syncCadenceVisibleLayout() {
    const host = document.querySelector('[data-role="study-cadence"]');
    if (!host || !host.childElementCount) return;
    const orb = host.querySelector('[data-role="cadence-year-orb"]');
    if (orb) orb.classList.add('no-transition');
    syncCadenceYearOrb(host);
    placeStarModeSlider(host.querySelector('[data-role="star-mode-switch"]'), false);
    if (orb) window.requestAnimationFrame(() => orb.classList.remove('no-transition'));
  }

  function scheduleCadenceVisibleActivation() {
    cancelCadenceVisibleSync();
    cadenceVisibleSyncFrame = window.requestAnimationFrame(() => {
      cadenceVisibleSyncFrame = window.requestAnimationFrame(() => {
        cadenceVisibleSyncFrame = 0;
        if (!cadenceShown) return;
        syncCadenceVisibleLayout();
        if (starInstance && starInstance.setActive) {
          starInstance.setActive(true);
          if (starInstance.replayIntro) starInstance.replayIntro();
        }
      });
    });
  }

  function invalidateActivity() {
    activityDirty = true;
    if (cadenceShown) queueActivityLoad();
  }

  // 「更新」按钮：强制重新统计活跃数据并重绘热力图。平时翻进活跃页用缓存，不重读。
  async function refreshCadence(btn) {
    if (btn) btn.classList.add('is-refreshing');
    try {
      activityDirty = true;
      await queueActivityLoad();
    } catch (e) {
      // 加载失败有各自兜底，这里只防 rejection 冒泡
    } finally {
      if (btn) btn.classList.remove('is-refreshing');
    }
  }

  // 暴露给起步页：速记归档后刷新一年活跃热力图 / 月统计 / 星图（数据已写进学习归档）。
  window.StudyActivity = {
    reload() { invalidateActivity(); },
    // 起步页翻页时调用：只有活跃页是当前前置页时星图才跑 RAF，离开即挂起，避免隐藏页 60fps 空转。
    setActive(active) {
      cadenceShown = !!active;
      if (!cadenceShown) {
        cancelCadenceVisibleSync();
        if (starInstance && starInstance.setActive) starInstance.setActive(false);
        return;
      }
      cancelActivityPreload();
      // 预渲染发生在 content-visibility:hidden 下；待外层页面真正可见两帧后，再校准书脊/滑块并唤醒星图。
      scheduleCadenceVisibleActivation();
      if (!activityPayload || activityDirty) ensureActivityReady().catch(() => undefined);
    },
    awaitReady() {
      return ensureActivityReady();
    },
    isReady() {
      return !!(activityPayload && !activityDirty);
    },
  };
  scheduleActivityPreload();
  scheduleStudyPreload();

  function moveTask(id, status) {
    var task = findTask(id);
    if (!task || task.status === status) return;
    var old = task.status;
    var formerOwner = goalTreeOwner(id);
    var completedFocusTreeId = status === 'done' && formerOwner
      && (formerOwner.tree.focusTaskIds || []).includes(id) ? formerOwner.tree.id : '';
    task.status = status;
    var done = status === 'done';

    var card = document.querySelector('.study-progress-card' + taskSelector(id));
    if (card && !prefersReduced) {
      replayClass(card, done ? 'is-completing' : 'is-reopening', 480);
    }

    // FLIP：捕获所有卡片位置，渲染后用 animateListMoves 做让位过渡
    var prevRects = new Map();
    if (!prefersReduced) {
      if (progressListEl) captureListRectsInto(prevRects, progressListEl, '.study-progress-card');
      if (completedListEl) captureListRectsInto(prevRects, completedListEl, '.study-progress-card');
    }

    // 让动画先起一帧，再触发增量同步（card/row 已在 DOM 中，sync 会更新它们）
    var doRender = function () {
      render();
      if (!prefersReduced && prevRects.size) {
        if (progressListEl) animateListMovesInto(progressListEl, '.study-progress-card', prevRects);
        if (completedListEl) animateListMovesInto(completedListEl, '.study-progress-card', prevRects);
      }
    };
    if (!prefersReduced && card) {
      setTimeout(doRender, 60);
    } else {
      doRender();
    }

    queueTaskPatch(task, { status }).then(function () {
      if (!completedFocusTreeId) return;
      var tree = state.goalTrees.find(function (item) { return item.id === completedFocusTreeId; });
      var model = tree && GoalTree && GoalTree.buildModel(tree, state.tasks);
      var next = model && findTask(model.nextTaskIdAfter(id));
      if (!next) return;
      if (goalTreeOpen) recommendNextGoalTask(tree);
      else showToast('进行中任务已完成 · 下一项建议：' + next.title);
    }).catch(function (error) {
      task.status = old;
      render();
      showToast(error.message);
    });
  }

  // 删除任务（移到学习回收站）。若关联了画布：入回收站即「解除绑定」，并把画布一并移入
  // 画布回收站（可恢复、非物理删除）。任务与画布从此各自独立，恢复互不牵连——风险低。
  function trashTaskById(id) {
    const task = findTask(id);
    if (!task) return;
    const index = state.tasks.indexOf(task);
    if (index < 0) return;

    const trashedTask = Object.assign({}, task);
    state.tasks.splice(index, 1);
    state.trash.unshift({ task: trashedTask, deletedAt: new Date().toISOString() });
    state.trash = state.trash.slice(0, STUDY_TRASH_LIMIT);
    trashEnterId = task.id;
    if (state.selectedId === id) state.selectedId = '';
    render();

    trashChain = trashChain.catch(() => undefined).then(async () => {
      await ensureTaskCreated(task);
      trashedTask.id = task.id; // 刚快速创建又立刻删除时，回收站记录同步后端分配的真实 id
      const pendingMutation = taskMutationChains.get(task);
      if (pendingMutation) await pendingMutation.catch(() => undefined);
      const json = await post('/api/study-task-trash', { id: task.id });
      if (json.study) applyStudyPayload(json.study);
    }).catch((error) => {
      showToast('删除任务失败，正在恢复：' + error.message);
      refresh();
    });
    showToast('任务已移到回收站');
  }

  async function restoreTask(id) {
    lockTrashItem(id, true);
    try {
      const json = await post('/api/study-task-restore', { id });
      animateDetachedExit(document.querySelector('.study-trash-item' + taskSelector(id)), 'study-trash-exit-ghost');
      if (json.study) applyStudyPayload(json.study);
      else {
        state.trash = state.trash.filter((entry) => entry.task.id !== id);
        state.tasks.push(json.task);
      }
      render();
      const restored = document.querySelector('.study-lane-list ' + taskSelector(json.task.id));
      if (restored && !prefersReduced) {
        restored.classList.add('quick-enter');
        setTimeout(() => restored.classList.remove('quick-enter'), 300);
      }
    } catch (error) {
      lockTrashItem(id, false);
      showToast(error.message);
    }
  }

  async function deleteTask(id) {
    if (!window.confirm(T('永久移除这条任务？此操作不可恢复。'))) return;
    lockTrashItem(id, true);
    try {
      await post('/api/study-task-delete', { id });
      animateDetachedExit(document.querySelector('.study-trash-item' + taskSelector(id)), 'study-trash-exit-ghost');
      state.trash = state.trash.filter((entry) => entry.task.id !== id);
      render();
    } catch (error) {
      lockTrashItem(id, false);
      showToast(error.message);
    }
  }

  function openTrash() {
    trashPanel.hidden = false;
    requestAnimationFrame(() => trashPanel.classList.add('show'));
  }

  function closeTrash() {
    closeTrashConfirm();
    trashPanel.classList.remove('show');
    setTimeout(() => { trashPanel.hidden = true; }, 180);
  }

  function openTrashConfirm() {
    if (!trashConfirm || !state.trash.length || isEmptyingTrash) return;
    trashConfirm.hidden = false;
  }

  function closeTrashConfirm() {
    if (isEmptyingTrash) return;
    if (trashConfirm) trashConfirm.hidden = true;
  }

  async function emptyTrash() {
    if (!state.trash.length || isEmptyingTrash) return;
    isEmptyingTrash = true;
    const confirmBtn = document.querySelector('[data-action="study-trash-empty-confirm"]');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      await post('/api/study-trash-empty');
      state.trash = [];
      if (trashConfirm) trashConfirm.hidden = true;
      render();
    } catch (error) {
      showToast(error.message);
    } finally {
      isEmptyingTrash = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  async function archiveDone() {
    if (!studyLoaded && !(await ensureStudyLoaded())) return;
    const done = state.tasks.filter((task) => task.status === 'done');
    if (!done.length) {
      showToast('已完成这一列还是空的');
      return;
    }
    const buttons = Array.from(document.querySelectorAll('[data-action="archive-done"]'));
    if (buttons.some((button) => button.disabled)) return;
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await Promise.all(done.map(async (task) => {
        await ensureTaskCreated(task);
        const pendingMutation = taskMutationChains.get(task);
        if (pendingMutation) await pendingMutation;
      }));
      const json = await post('/api/study-archive-done');
      const archivedIds = new Set(json.archivedIds || []);
      buttons.forEach((button) => button.classList.add('archive-success'));
      if (viewMode === 'list') {
        const doneGroup = document.querySelector('.study-list-group[data-status="done"]');
        await animateArchiveRows(doneGroup);
      }
      if (json.study) applyStudyPayload(json.study);
      else state.tasks = state.tasks.filter((task) => !archivedIds.has(task.id));
      render();
      invalidateActivity();   // 归档只是搬走数据，完成历史仍按完成日留在活跃图上
      const archiveMessage = '已归档' + json.count + '项已完成任务';
      showToast(window.RelatumI18n ? window.RelatumI18n.t(archiveMessage) : archiveMessage);
    } catch (error) {
      showToast(error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
      setTimeout(() => {
        buttons.forEach((button) => button.classList.remove('archive-success'));
      }, 860);
    }
  }

  window.StudyView.archiveDone = archiveDone;
  window.StudyView.refresh = refresh;
  window.StudyView.openTask = function (id) {
    if (!studyLoaded) {
      ensureStudyLoaded().then((loaded) => {
        if (loaded) window.StudyView.openTask(id);
      });
      return true;
    }
    if (!findTask(id)) return false;
    state.selectedId = id;
    if (viewMode !== 'progress') setViewMode('progress', false);
    else render();
    var menu = document.querySelector('.study-progress-card' + taskSelector(id) + ' .study-progress-menu');
    if (menu) openProgressSettings(id, menu);
    return true;
  };

  async function performStudyRefresh() {
    const requestId = ++studyRefreshSeq;
    try {
      const json = await api('/api/study');
      if (requestId !== studyRefreshSeq) return false;
      applyStudyPayload(json);
      studyLoaded = true;
      window._relatumStudyData = json;
      render();
      invalidateActivity();   // 顺带刷新一年活跃热力图
      return true;
    } catch (error) {
      if (requestId === studyRefreshSeq) showToast('学习页载入失败：' + error.message);
      return false;
    }
  }

  function refresh() {
    const pending = performStudyRefresh();
    studyLatestRefresh = pending;
    pending.finally(() => {
      if (studyLatestRefresh === pending) studyLatestRefresh = null;
    });
    return pending;
  }

  function waitForLatestStudyRefresh(pending) {
    return Promise.resolve(pending).then((success) => {
      if (studyLoaded) return true;
      const latest = studyLatestRefresh;
      if (latest && latest !== pending) return waitForLatestStudyRefresh(latest);
      return success === true && studyLoaded;
    });
  }

  function ensureStudyLoaded() {
    if (studyLoaded) return Promise.resolve(true);
    if (!studyInitialLoad) {
      studyInitialLoad = waitForLatestStudyRefresh(studyLatestRefresh || refresh())
        .catch(() => false)
        .finally(() => { studyInitialLoad = null; });
    }
    return studyInitialLoad.then((success) => success === true && studyLoaded);
  }

  const composeToggle = document.querySelector('[data-action="study-compose-toggle"]');
  if (composeToggle) composeToggle.addEventListener('click', function () {
    progressQuickAdd();
  });
  document.querySelectorAll('[data-action="study-goal-tree-open"]').forEach(function (button) {
    button.addEventListener('click', function () { openGoalTree(button); });
  });
  if (goalTreeSelect) goalTreeSelect.addEventListener('change', function () {
    if (!goalTreeSelect.value) return;
    goalTreeArchivePayload = null;
    goalTreeActiveId = goalTreeSelect.value;
    goalTreeSelectedId = goalTreeActiveId;
    goalTreeDetailMode = 'node';
    goalTreeNeedsFit = true;
    try { localStorage.setItem(GOAL_TREE_ACTIVE_KEY, goalTreeActiveId); } catch (e) {}
    renderGoalTree();
  });
  if (goalTreeOverlay) {
    goalTreeOverlay.addEventListener('click', function (event) {
      if (performance.now() - goalTreeDragEndedAt < 260) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var control = event.target.closest('[data-action]');
      if (control && goalTreeOverlay.contains(control)) {
        event.preventDefault();
        event.stopPropagation();
        handleGoalTreeAction(control.dataset.action, control);
        return;
      }
      var item = event.target.closest('.study-goal-node[data-node-id]');
      if (item && goalTreeNodes && goalTreeNodes.contains(item)) selectGoalTreeNode(item.dataset.nodeId, false);
    });
    goalTreeOverlay.addEventListener('submit', function (event) {
      var form = event.target.closest('form[data-role]');
      if (!form) return;
      event.preventDefault();
      submitGoalTreeForm(form);
    });
    goalTreeOverlay.addEventListener('dblclick', function (event) {
      var item = event.target.closest('.study-goal-node[data-node-id]');
      if (!item || !goalTreeNodes.contains(item) || event.target.closest('button')) return;
      event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false); beginGoalTreeInlineRename(item);
    });
    goalTreeOverlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (goalTreeConfirm && !goalTreeConfirm.hidden) closeGoalTreeConfirm();
        else closeGoalTree();
        return;
      }
      var item = event.target.closest && event.target.closest('.study-goal-node[data-node-id]');
      if (item && !event.target.isContentEditable && event.key === 'F2') {
        event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false); beginGoalTreeInlineRename(item); return;
      }
      if (item && !event.target.isContentEditable && event.key === 'Tab' && event.shiftKey) {
        event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false);
        keyboardMoveGoalTreeNode(goalTreeSelection().node, 'outdent'); return;
      }
      if (item && !event.target.isContentEditable && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false);
        var relative = goalTreeSelection().node;
        createGoalTreeRelative(relative, event.key === 'Tab'); return;
      }
      if (item && !event.target.isContentEditable && event.key === 'Delete') {
        event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false);
        var selected = goalTreeSelection().node;
        if (!selected) return;
        if (selected.kind === 'task') handleGoalTreeAction('study-goal-tree-task-detach', item);
        else if (selected.kind === 'branch') handleGoalTreeAction('study-goal-tree-branch-delete', item);
        else if (selected.kind === 'root') handleGoalTreeAction('study-goal-tree-delete', item);
        return;
      }
      if (item && !event.target.isContentEditable && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); selectGoalTreeNode(item.dataset.nodeId, false);
        keyboardMoveGoalTreeNode(goalTreeSelection().node, event.key === 'ArrowUp' ? 'up' : 'down'); return;
      }
      if (item && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        navigateGoalTreeKey(item.dataset.nodeId, event.key);
        return;
      }
      if (event.key === 'Tab' && goalTreePanel) {
        var focusable = Array.from(goalTreePanel.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
          .filter(function (element) { return element.offsetParent !== null; });
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    goalTreeOverlay.addEventListener('pointerdown', function (event) {
      var item = event.target.closest('.study-goal-node[data-draggable="true"]');
      if (!item || event.target.closest('button,input,textarea,select')) return;
      beginGoalTreeNodeDrag(event, item);
    });
  }
  if (goalTreeViewport) {
    goalTreeViewport.addEventListener('wheel', function (event) {
      if (!goalTreeOpen) return;
      event.preventDefault();
      setGoalTreeZoom(goalTreeViewTarget.zoom * Math.exp(-event.deltaY * .00115), event.clientX, event.clientY);
    }, { passive: false });
    goalTreeViewport.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || event.target.closest('.study-goal-node,.study-goal-tree-view-tools')) return;
      if (goalTreePanInertiaFrame) cancelAnimationFrame(goalTreePanInertiaFrame);
      goalTreePanInertiaFrame = 0;
      stopGoalTreeViewAnimation();
      goalTreeViewTarget = Object.assign({}, goalTreeView);
      goalTreePan = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: goalTreeView.x, oy: goalTreeView.y,
        lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(), vx: 0, vy: 0 };
      goalTreeViewport.setPointerCapture(event.pointerId);
      goalTreeViewport.classList.add('is-panning');
    });
    goalTreeViewport.addEventListener('pointermove', function (event) {
      if (!goalTreePan || goalTreePan.id !== event.pointerId) return;
      goalTreeView.x = goalTreePan.ox + event.clientX - goalTreePan.x;
      goalTreeView.y = goalTreePan.oy + event.clientY - goalTreePan.y;
      goalTreeViewTarget = Object.assign({}, goalTreeView);
      var now = performance.now();
      var dt = Math.max(1, now - goalTreePan.lastAt);
      goalTreePan.vx = goalTreePan.vx * .4 + (event.clientX - goalTreePan.lastX) / dt * .6;
      goalTreePan.vy = goalTreePan.vy * .4 + (event.clientY - goalTreePan.lastY) / dt * .6;
      goalTreePan.lastX = event.clientX; goalTreePan.lastY = event.clientY; goalTreePan.lastAt = now;
      applyGoalTreeView();
    });
    function endGoalTreePan(event) {
      if (!goalTreePan || goalTreePan.id !== event.pointerId) return;
      var vx = goalTreePan.vx, vy = goalTreePan.vy;
      goalTreePan = null;
      goalTreeViewport.classList.remove('is-panning');
      if (prefersReduced || Math.hypot(vx, vy) < .035) return;
      var last = performance.now();
      function inertia(now) {
        var dt = Math.min(34, now - last); last = now;
        goalTreeView.x += vx * dt; goalTreeView.y += vy * dt;
        goalTreeViewTarget = Object.assign({}, goalTreeView); applyGoalTreeView();
        var decay = Math.pow(.92, dt / 16.667); vx *= decay; vy *= decay;
        if (Math.hypot(vx, vy) > .015) goalTreePanInertiaFrame = requestAnimationFrame(inertia);
        else goalTreePanInertiaFrame = 0;
      }
      goalTreePanInertiaFrame = requestAnimationFrame(inertia);
    }
    goalTreeViewport.addEventListener('pointerup', endGoalTreePan);
    goalTreeViewport.addEventListener('pointercancel', endGoalTreePan);
  }
  const studyTrashButton = document.querySelector('[data-action="study-trash"]');
  if (studyTrashButton) studyTrashButton.addEventListener('click', openTrash);
  document.querySelectorAll('[data-action="close-trash"]').forEach((button) => button.addEventListener('click', closeTrash));
  const emptyTrashButton = document.querySelector('[data-action="empty-trash"]');
  if (emptyTrashButton) emptyTrashButton.addEventListener('click', openTrashConfirm);
  const emptyTrashCancel = document.querySelector('[data-action="study-trash-empty-cancel"]');
  if (emptyTrashCancel) emptyTrashCancel.addEventListener('click', closeTrashConfirm);
  const emptyTrashConfirm = document.querySelector('[data-action="study-trash-empty-confirm"]');
  if (emptyTrashConfirm) emptyTrashConfirm.addEventListener('click', emptyTrash);
  if (trashConfirm) {
    trashConfirm.addEventListener('mousedown', (event) => {
      if (event.target === trashConfirm) closeTrashConfirm();
    });
  }
  const archiveButton = document.querySelector('[data-role="study-progress-completed-column"] [data-action="archive-done"]');
  if (archiveButton) archiveButton.addEventListener('click', archiveDone);

  // 里程碑弹窗 & 进度条里程碑 tooltip 的事件代理
  if (studyViewEl) {
    studyViewEl.addEventListener('click', function (event) {
      // 里程碑弹窗内的按钮
      if (studyMilestoneDialog) {
        var action = event.target.closest('[data-action]');
        if (action) {
          if (action.dataset.action === 'study-milestone-add') {
            if (!action.disabled) {
              var row = appendStudyMilestoneDraftRow({ id: progressMilestoneDraftId(), name: '', at: 0 }, true);
              var input = row && row.querySelector('[data-role="study-milestone-name"]');
              if (input) input.focus();
              setStudyMilestoneDialogError('');
            }
            return;
          }
          if (action.dataset.action === 'study-milestone-remove') {
            var row = action.closest('.study-milestone-row');
            if (!row) return;
            var finish = function () { if (row.isConnected) row.remove(); updateStudyMilestoneAddState(); };
            if (prefersReduced) finish();
            else {
              row.classList.add('is-leaving');
              row.addEventListener('animationend', finish, { once: true });
              window.setTimeout(finish, 220);
            }
            setStudyMilestoneDialogError('');
            return;
          }
          if (action.dataset.action === 'study-milestone-cancel') { closeStudyMilestoneDialog(false); return; }
          if (action.dataset.action === 'study-milestone-confirm') { closeStudyMilestoneDialog(true); return; }
        }
        if (event.target === studyMilestoneDialog) {
          closeStudyMilestoneDialog(false);
          return;
        }
      }
      // 进度条里程碑 tooltip（触屏点击固定）
      var milestone = event.target.closest('.study-progress-milestone');
      if (milestone) {
        event.preventDefault();
        event.stopPropagation();
        var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (coarse) {
          studyViewEl.querySelectorAll('.study-progress-milestone.is-tip-pinned').forEach(function (item) {
            if (item !== milestone) item.classList.remove('is-tip-pinned');
          });
          milestone.classList.toggle('is-tip-pinned');
        }
        return;
      }
    });
  }

  // 全局点击：关闭已固定的里程碑 tooltip、取消浮动设置卡；点击弹窗遮罩关闭
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.study-progress-milestone')) {
      document.querySelectorAll('.study-progress-milestone.is-tip-pinned').forEach(function (item) {
        item.classList.remove('is-tip-pinned');
      });
    }
    if (studyMilestoneDialog && event.target === studyMilestoneDialog) {
      closeStudyMilestoneDialog(false);
      return;
    }
    if (!studyMilestoneDialog && progressSettingsPopover
        && !progressSettingsPopover.contains(event.target)
        && !(progressSettingsTrigger && progressSettingsTrigger.contains(event.target))) {
      closeProgressSettings(true);
    }
  });

  window.addEventListener('resize', scheduleProgressSettingsPosition);
  window.addEventListener('scroll', scheduleProgressSettingsPosition, true);

  document.addEventListener('keydown', (event) => {
    // 里程碑弹窗打开时优先处理
    if (studyMilestoneDialog) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeStudyMilestoneDialog(false);
        return;
      }
      return;
    }
    if (trashConfirm && !trashConfirm.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTrashConfirm();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (progressSettingsPopover) {
        event.preventDefault();
        closeProgressSettings(true);
      } else if (!trashPanel.hidden) {
        closeTrash();
      }
    }
  });

  window.addEventListener('canvas:starmap-motion-change', () => {
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) mountStarGraph(host, activityPayload, { intro: true });
  });
  document.addEventListener('relatum:languagechange', () => {
    document.querySelectorAll('.study-progress-card[data-id]').forEach(function (card) {
      var task = findTask(card.dataset.id);
      if (task) syncProgressCardFromTask(card, task);
    });
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) renderCadence(activityPayload, { intro: false });
  });
})();

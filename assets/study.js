(function () {
  'use strict';

  const STATUS = ['active', 'done'];
  const STATUS_LABEL = { active: '未完成', done: '已完成' };
  const state = {
    tasks: [], trash: [], goalTrees: [], temporaryTaskIds: [], taskPageNotes: {},
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
  const temporaryLayerEl = document.querySelector('[data-role="study-temporary-layer"]');
  const temporaryPanelEl = document.querySelector('[data-role="study-temporary-panel"]');
  const temporaryListEl = document.querySelector('[data-role="study-temporary-list"]');
  const temporaryToggleEl = document.querySelector('[data-action="study-temporary-toggle"]');
  const taskPageRailEl = document.querySelector('[data-role="study-task-page-rail"]');
  const taskPageOrbEl = document.querySelector('[data-role="study-task-page-orb"]');
  const taskPageTopScrollEl = document.querySelector('[data-role="study-task-page-top"]');
  const taskPageBottomScrollEl = document.querySelector('[data-role="study-task-page-bottom"]');
  const taskPageTopListEl = document.querySelector('[data-role="study-task-page-top-list"]');
  const taskPageBottomListEl = document.querySelector('[data-role="study-task-page-bottom-list"]');
  const taskPageNoteTriggerEl = document.querySelector('[data-role="study-task-page-note-trigger"]');
  const taskPageNoteEl = document.querySelector('[data-role="study-task-page-note"]');
  let goalTreeActiveId = '';
  let toastTimer = null;
  let optimisticTaskSeq = 0;
  const reorderTimers = new Map();
  const reorderChains = new Map();
  let progressDrag = null;            // 进度面板拖拽排序状态
  let progressFlipAnims = new Map();  // 拖拽让位 FLIP 动画
  let progressDragClickGuard = '';    // 拖拽松手后吞掉紧随的 click
  let temporaryPanelOpen = false;
  let temporaryMutationChain = Promise.resolve();
  const TEMPORARY_EDGE_DWELL_MS = 120;
  const TEMPORARY_EDGE_ZONE_PX = 36;
  let trashChain = Promise.resolve(); // 快速连删时后台按点击顺序落盘，界面无需等待网络
  let isEmptyingTrash = false;
  const STUDY_TRASH_LIMIT = 30;
  const STUDY_MILESTONES_MAX = 50;
  const STUDY_TASK_PAGE_MAX = 99;
  const STUDY_TASK_PAGE_KEY = 'study:taskPage:v1';
  const STUDY_TASK_PAGE_EDGE_PX = 84;
  // 切页动画：整体淡出彻底结束后才替换内容并淡入，避免旧卡片退场/新卡片入场叠加成残影。
  const STUDY_TASK_PAGE_SWITCH_MS = 150;
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
      if (temporaryLayerEl) temporaryLayerEl.classList.remove('is-revealing');
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
    if (temporaryLayerEl) temporaryLayerEl.classList.remove('is-revealing');
    void view.offsetWidth;
    view.classList.add('is-revealing');
    if (temporaryLayerEl) temporaryLayerEl.classList.add('is-revealing');
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
  function normalizeTaskPage(value) {
    var page = Number(value);
    return Number.isInteger(page) && page >= 1 && page <= STUDY_TASK_PAGE_MAX ? page : 1;
  }
  function readTaskPage() {
    try { return normalizeTaskPage(Number(localStorage.getItem(STUDY_TASK_PAGE_KEY))); }
    catch (error) { return 1; }
  }
  let currentTaskPage = readTaskPage();
  let taskPageRailVisible = false;
  let taskPageRailOver = false;
  let taskPagePointerX = -1;
  let taskPagePointerY = -1;
  let taskPageSwitchTimer = 0;
  let taskPageSwitchSeq = 0;
  let taskPageOrbSettleUntil = 0;
  let taskPageEntranceTimer = 0;
  let taskPageWheelAccum = 0;
  let taskPageWheelTimer = 0;
  let taskPageResizeFrame = 0;
  let taskPageNoteEdit = null;
  let taskPageNoteMutation = Promise.resolve();
  const taskPageNoteSeq = new Map();

  function taskPageOf(task) {
    return normalizeTaskPage(task && task.taskPage);
  }
  function tasksForPage(page) {
    var target = normalizeTaskPage(page);
    return state.tasks.filter(function (task) { return taskPageOf(task) === target; });
  }
  function currentPageTasks() {
    return tasksForPage(currentTaskPage);
  }
  function highestTaskPage() {
    var highestTask = state.tasks.reduce(function (highest, task) {
      return Math.max(highest, taskPageOf(task));
    }, 1);
    return Object.keys(state.taskPageNotes).reduce(function (highest, page) {
      return Math.max(highest, normalizeTaskPage(Number(page)));
    }, highestTask);
  }
  function currentTaskPageNote() {
    return String(state.taskPageNotes[String(currentTaskPage)] || '');
  }
  function renderTaskPageNote() {
    if (!taskPageNoteEl || (taskPageNoteEdit && taskPageNoteEdit.page === currentTaskPage)) return;
    var note = currentTaskPageNote();
    taskPageNoteEl.textContent = note;
    taskPageNoteEl.classList.remove('is-editing');
    taskPageNoteEl.classList.toggle('has-note', !!note);
  }
  function closeTaskPageNoteEdit(cancel) {
    var edit = taskPageNoteEdit;
    if (!edit) return;
    taskPageNoteEdit = null;
    var next = cancel ? edit.previous : edit.input.value.trim().slice(0, 240);
    if (!cancel && next !== edit.previous) {
      var seq = (taskPageNoteSeq.get(edit.page) || 0) + 1;
      taskPageNoteSeq.set(edit.page, seq);
      if (next) state.taskPageNotes[String(edit.page)] = next;
      else delete state.taskPageNotes[String(edit.page)];
      var request = taskPageNoteMutation.catch(function () {}).then(function () {
        return post('/api/study-task-page-note', { taskPage: edit.page, note: next });
      });
      taskPageNoteMutation = request.catch(function () {});
      request.then(function (json) {
        if (taskPageNoteSeq.get(edit.page) !== seq) return;
        if (json.note) state.taskPageNotes[String(edit.page)] = json.note;
        else delete state.taskPageNotes[String(edit.page)];
        renderTaskPageNote();
      }).catch(function (error) {
        if (taskPageNoteSeq.get(edit.page) !== seq) return;
        if (edit.previous) state.taskPageNotes[String(edit.page)] = edit.previous;
        else delete state.taskPageNotes[String(edit.page)];
        renderTaskPageNote();
        showToast(error.message);
      });
    }
    renderTaskPageNote();
  }
  function beginTaskPageNoteEdit(event) {
    if (!taskPageNoteEl || taskPageNoteEdit
        || (event && event.target.closest('h1, button, input'))) return;
    var page = currentTaskPage;
    var previous = currentTaskPageNote();
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'study-task-page-note-input';
    input.maxLength = 240;
    input.value = previous;
    setStudyAriaLabel(input, '学习任务页说明');
    taskPageNoteEl.textContent = '';
    taskPageNoteEl.classList.add('is-editing');
    taskPageNoteEl.appendChild(input);
    taskPageNoteEdit = { page: page, previous: previous, input: input };
    input.addEventListener('keydown', function (keyEvent) {
      if (keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        closeTaskPageNoteEdit(false);
      } else if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        closeTaskPageNoteEdit(true);
      }
    });
    input.addEventListener('blur', function () { closeTaskPageNoteEdit(false); }, { once: true });
    input.focus({ preventScroll: true });
    input.select();
  }
  function taskPageStackCapacity(scrollEl) {
    if (!scrollEl) return 1;
    return Math.max(1, Math.floor((scrollEl.clientHeight + 6) / 40));
  }
  function taskPageCapacity() {
    return Math.max(2,
      taskPageStackCapacity(taskPageTopScrollEl) + taskPageStackCapacity(taskPageBottomScrollEl));
  }
  function createTaskPageButton(page) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'study-task-page-button' + (page === currentTaskPage ? ' is-active' : '');
    button.dataset.taskPage = String(page);
    button.textContent = String(page);
    setStudyAriaLabel(button, '学习任务第 ' + page + ' 页');
    if (page === currentTaskPage) button.setAttribute('aria-current', 'page');
    return button;
  }
  function fillTaskPageList(host, first, last) {
    if (!host) return;
    var fragment = document.createDocumentFragment();
    for (var page = first; page <= last; page += 1) fragment.appendChild(createTaskPageButton(page));
    host.replaceChildren(fragment);
  }
  function scrollTaskPageButtonIntoView(button) {
    if (!button) return;
    var scroller = button.closest('.study-task-page-scroll');
    if (!scroller) return;
    var top = button.offsetTop;
    var bottom = top + button.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  }
  function positionTaskPageOrb(fromScroll) {
    if (!taskPageRailEl || !taskPageOrbEl) return;
    // 切页滑行期间由 scroll 逐帧覆盖 transform 会打断过渡，锁定到滑行结束
    if (fromScroll && performance.now() < taskPageOrbSettleUntil) return;
    var active = taskPageRailEl.querySelector('.study-task-page-button.is-active');
    if (!active) { taskPageOrbEl.style.opacity = '0'; return; }
    var railRect = taskPageRailEl.getBoundingClientRect();
    var buttonRect = active.getBoundingClientRect();
    var visible = buttonRect.bottom > railRect.top && buttonRect.top < railRect.bottom;
    taskPageOrbEl.style.opacity = visible ? '1' : '0';
    taskPageOrbEl.style.transform = 'translate3d(0,' + (buttonRect.top - railRect.top) + 'px,0)';
  }
  function currentOrbMs() {
    var raw = getComputedStyle(document.documentElement).getPropertyValue('--start-orb-ms');
    var ms = parseFloat(raw);
    return Number.isFinite(ms) && ms > 0 ? ms : 239;
  }
  function renderTaskPageRail() {
    if (!taskPageRailEl) return;
    var focusedPage = taskPageRailEl.contains(document.activeElement)
      && document.activeElement.dataset ? document.activeElement.dataset.taskPage : '';
    var total = Math.min(STUDY_TASK_PAGE_MAX,
      Math.max(taskPageCapacity(), currentTaskPage, highestTaskPage()));
    var topCount = Math.ceil(total / 2);
    fillTaskPageList(taskPageTopListEl, 1, topCount);
    fillTaskPageList(taskPageBottomListEl, topCount + 1, total);
    var active = taskPageRailEl.querySelector('.study-task-page-button.is-active');
    scrollTaskPageButtonIntoView(active);
    if (focusedPage) {
      var focusTarget = taskPageRailEl.querySelector('[data-task-page="' + focusedPage + '"]') || active;
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
    var orbMs = currentOrbMs();
    requestAnimationFrame(function () {
      taskPageOrbSettleUntil = performance.now() + orbMs + 10;
      positionTaskPageOrb(false);
      // 锁到期补位：若滑行期间用户滚动页栏并停下，锁内被跳过的定位在到期后补一次
      window.setTimeout(function () { positionTaskPageOrb(false); }, orbMs + 20);
    });
  }
  // 临时任务标签带（标签矩形上下各扩 20px）：带内任何位置都不显示页栏，
  // 无论鼠标在带内往左还是往右移动。只做硬拦截，不参与显示来源判定。
  function taskPagePointerInTabBlock() {
    if (taskPagePointerX < 0 || taskPagePointerY < 0) return false;
    var tab = document.querySelector('.study-temporary-tab');
    if (!tab) return false;
    var tabRect = tab.getBoundingClientRect();
    return taskPagePointerY >= tabRect.top - 20 && taskPagePointerY <= tabRect.bottom + 20;
  }
  function setTaskPageRailVisible(visible, options) {
    if (!taskPageRailEl) return;
    // 鼠标触发的显示一律过带内拦截；键盘聚焦（ignorePointer）不受影响
    if (visible && !(options && options.ignorePointer) && taskPagePointerInTabBlock()) visible = false;
    taskPageRailVisible = !!visible && studyPageActive && !temporaryPanelOpen;
    taskPageRailEl.classList.toggle('revealed', taskPageRailVisible);
  }
  // —— 切页错峰入场：复用整版 spring stagger（头 → 列标题 → 逐行卡片），
  //    只作用于进度视图容器，不走 studyRevealKey 去重，也不连带临时任务层 ——
  function startTaskPageEntrance() {
    var view = document.querySelector('[data-role="study-progress-view"]');
    if (!view || prefersReduced || viewMode !== 'progress') return;
    window.clearTimeout(taskPageEntranceTimer);
    void view.offsetWidth;
    view.classList.add('is-revealing');
    taskPageEntranceTimer = window.setTimeout(function () {
      view.classList.remove('is-revealing');
      taskPageEntranceTimer = 0;
    }, 1450);
  }
  function stopTaskPageEntrance() {
    window.clearTimeout(taskPageEntranceTimer);
    taskPageEntranceTimer = 0;
    var view = document.querySelector('[data-role="study-progress-view"]');
    if (view) view.classList.remove('is-revealing');
  }
  function setCurrentTaskPage(page, options) {
    options = options || {};
    var next = normalizeTaskPage(page);
    if (next === currentTaskPage) {
      renderTaskPageRail();
      return;
    }
    if (taskPageNoteEdit) closeTaskPageNoteEdit(false);
    stopTaskPageEntrance();
    if (progressDrag) finishProgressDrag({ cancel: true, immediate: true });
    closeProgressSettings(false, true);
    setTemporaryPanelOpen(false);
    currentTaskPage = next;
    state.selectedId = '';
    try { localStorage.setItem(STUDY_TASK_PAGE_KEY, String(next)); } catch (error) {}
    renderTaskPageRail();
    window.clearTimeout(taskPageSwitchTimer);
    if (prefersReduced || options.immediate || !studyViewEl) {
      render({ pageSwitch: true });
      return;
    }
    taskPageSwitchSeq += 1;
    var switchSeq = taskPageSwitchSeq;
    studyViewEl.classList.add('study-task-page-switching');
    taskPageSwitchTimer = window.setTimeout(function () {
      taskPageSwitchTimer = 0;
      // 快速连点时旧切换作废，只让最后一次换内容
      if (switchSeq !== taskPageSwitchSeq) return;
      render({ pageSwitch: true });
      requestAnimationFrame(function () {
        if (switchSeq !== taskPageSwitchSeq) return;
        if (viewMode === 'progress') {
          // 完整视图：去掉整体淡入——容器先禁过渡瞬跳回不透明，再直接播整版错峰入场
          var view = document.querySelector('[data-role="study-progress-view"]');
          if (view) {
            view.style.transition = 'none';
            view.style.opacity = '1';
            view.style.transform = 'none';
            studyViewEl.classList.remove('study-task-page-switching');
            startTaskPageEntrance();
            // 下一帧恢复：过渡与 inline 值一并清掉，避免 inline 覆盖下次切页的淡出类
            requestAnimationFrame(function () {
              view.style.transition = '';
              view.style.opacity = '';
              view.style.transform = '';
            });
            return;
          }
        }
        studyViewEl.classList.remove('study-task-page-switching');
      });
    }, STUDY_TASK_PAGE_SWITCH_MS);
  }
  if (taskPageRailEl) {
    taskPageRailEl.addEventListener('click', function (event) {
      var button = event.target.closest('[data-task-page]');
      if (!button) return;
      event.preventDefault();
      setCurrentTaskPage(Number(button.dataset.taskPage));
    });
    // 滚轮切页：页栏上向下滚 → 下一页，向上滚 → 上一页；
    // 列表本方向仍可滚动时先滚动列表，滚到边缘后再滚才切页
    taskPageRailEl.addEventListener('wheel', function (event) {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      var direction = event.deltaY > 0 ? 1 : -1;
      var scroller = event.target.closest ? event.target.closest('.study-task-page-scroll') : null;
      if (scroller) {
        var maxScroll = scroller.scrollHeight - scroller.clientHeight;
        var atEdge = direction > 0 ? scroller.scrollTop >= maxScroll - 1 : scroller.scrollTop <= 1;
        if (!atEdge) {
          // 列表仍可滚动：只拦冒泡，滚动留在页栏内，页面不响应
          event.stopPropagation();
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      taskPageWheelAccum += event.deltaY;
      window.clearTimeout(taskPageWheelTimer);
      taskPageWheelTimer = window.setTimeout(function () { taskPageWheelAccum = 0; }, 200);
      if (Math.abs(taskPageWheelAccum) < 24) return;   // 阈值，触控板友好、防误触
      var dir = taskPageWheelAccum > 0 ? 1 : -1;
      taskPageWheelAccum = 0;
      setCurrentTaskPage(currentTaskPage + dir);
    }, { passive: false });
    taskPageRailEl.addEventListener('pointerenter', function () {
      taskPageRailOver = true;
      setTaskPageRailVisible(true);
    });
    taskPageRailEl.addEventListener('pointerleave', function () {
      taskPageRailOver = false;
      setTaskPageRailVisible(false);
    });
    taskPageRailEl.addEventListener('focusin', function () {
      setTaskPageRailVisible(true, { ignorePointer: true });
    });
    taskPageRailEl.addEventListener('focusout', function (event) {
      if (!taskPageRailEl.contains(event.relatedTarget)) setTaskPageRailVisible(taskPageRailOver);
    });
  }
  [taskPageTopScrollEl, taskPageBottomScrollEl].forEach(function (scroller) {
    if (scroller) scroller.addEventListener('scroll', function () { positionTaskPageOrb(true); }, { passive: true });
  });
  if (studyViewEl) {
    studyViewEl.addEventListener('pointermove', function (event) {
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      var rect = studyViewEl.getBoundingClientRect();
      setTaskPageRailVisible(rect.right - event.clientX <= STUDY_TASK_PAGE_EDGE_PX || taskPageRailOver);
    }, { passive: true });
    studyViewEl.addEventListener('pointerleave', function () {
      if (!taskPageRailOver) setTaskPageRailVisible(false);
    });
  }
  // 全局记录最近鼠标位置，供带内硬拦截使用；不参与显示来源判定
  window.addEventListener('pointermove', function (event) {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    taskPagePointerX = event.clientX;
    taskPagePointerY = event.clientY;
  }, { passive: true });
  if (taskPageNoteTriggerEl) {
    taskPageNoteTriggerEl.addEventListener('dblclick', beginTaskPageNoteEdit);
  }
  function scheduleTaskPageRailLayout() {
    window.cancelAnimationFrame(taskPageResizeFrame);
    taskPageResizeFrame = requestAnimationFrame(function () {
      taskPageResizeFrame = 0;
      renderTaskPageRail();
    });
  }
  if (window.ResizeObserver && taskPageRailEl) {
    new ResizeObserver(scheduleTaskPageRailLayout).observe(taskPageRailEl);
  } else {
    window.addEventListener('resize', scheduleTaskPageRailLayout, { passive: true });
  }
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
    syncTemporaryLayerAvailability();
    renderTaskPageRail();
  }
  function setViewMode(mode, animate) {
    const next = mode === 'list' ? 'list' : 'progress';
    if (next === viewMode) return;
    closeProgressSettings(false, true);
    if (next === 'list') setTemporaryPanelOpen(false);
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
    resetStudyHorizontalOffset();
    syncTemporaryLayerAvailability();
    renderTaskPageRail();
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
  window.StudyView = {
    toggleMode: toggleViewMode,
    activate: activateStudyView,
    currentTaskPage: function () { return currentTaskPage; },
  };

  // 离开学习页时重置错峰入场状态，确保再次进入时重播动画
  document.addEventListener('start:viewchange', function (event) {
    if (event.detail && event.detail.previous === 'study') {
      studyPageActive = false;
      if (taskPageNoteEdit) closeTaskPageNoteEdit(false);
      setTaskPageRailVisible(false);
      setTemporaryPanelOpen(false);
      if (progressDrag) finishProgressDrag({ cancel: true, immediate: true });
      stopStudyGoalBreath();
      stopStudyGoalCheckFlow();
      closeProgressSettings(false, true);
      studyRevealKey = '';
      window.clearTimeout(studyRevealTimer);
      studyRevealTimer = 0;
      var view = document.querySelector('[data-role="study-progress-view"]');
      if (view) view.classList.remove('is-revealing');
      if (temporaryLayerEl) temporaryLayerEl.classList.remove('is-revealing');
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
    // 本地接口 15s 兜底：服务端挂起时不再让任务 patch 链永久排队（与路线面板 api 对齐）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, Object.assign({}, options, { signal: controller.signal }));
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || '操作失败');
      return json;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(T('请求超时，请重试'));
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
      taskPage: normalizeTaskPage(payload.taskPage),
      color: '',
      progress: { current: 0, target: 0, milestones: [] },
      createdAt: now,
      updatedAt: now,
      completedAt: '',
    };
  }

  function remapTaskId(task, oldId, newId) {
    task.id = newId;
    if (state.selectedId === oldId) state.selectedId = newId;
    state.temporaryTaskIds = state.temporaryTaskIds.map(function (id) {
      return id === oldId ? newId : id;
    });
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
    const treeAtRequest = goalTreeActiveId;
    const request = queueTaskMutation(task, async () => {
      const json = await post('/api/study-task-update', Object.assign({ id: task.id }, patch));
      if (Array.isArray(json.goalTrees)) state.goalTrees = json.goalTrees;
      if (json.activeTreeId && json.activeTreeId === treeAtRequest) goalTreeActiveId = json.activeTreeId;
      if (taskUpdateSeq.get(task) === seq) Object.assign(task, json.task);
      else {
        task.updatedAt = json.task.updatedAt || task.updatedAt;
        task.completedAt = json.task.completedAt || task.completedAt;
      }
      return task;
    });
    return request;
  }

  // 树级命令（路线面板 / 设置弹窗）也纳入 flush 落地等待：
  // 关面板后立即回收/恢复/归档时，避免旧快照把刚删/刚切的树写回主页状态。
  var treeCommandChains = new Map();
  var treeCommandSeq = 0;
  function registerTreeCommand(promise) {
    var id = ++treeCommandSeq;
    var settled = Promise.resolve(promise).catch(function () {});
    treeCommandChains.set(id, settled);
    settled.then(function () { treeCommandChains.delete(id); });
  }
  window.StudyTreeCommands = { register: registerTreeCommand };

  // 全量刷新 / 回收 / 恢复 / 归档前，先等所有在途 patch 落地：
  // 这些流程会用服务端快照整体替换 state.tasks，若改名/进度 patch 还在排队，
  // 快照里是旧值，替换后 UI 会把刚提交的改动”打回原形”（改名丢失即由此而来）。
  function flushStudyMutations() {
    try {
      var pending = Array.from(taskMutationChains.values()).concat(Array.from(treeCommandChains.values()));
      if (!pending.length) return Promise.resolve();
      var withTimeout = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('flush timeout')); }, 5000);
      });
      var allSettled = Promise.all(pending.map(function (request) {
        return Promise.resolve(request).catch(function () {});
      }));
      return Promise.race([allSettled, withTimeout]).catch(function () {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  function scheduleStudyReorder(page) {
    var taskPage = normalizeTaskPage(page || currentTaskPage);
    window.clearTimeout(reorderTimers.get(taskPage));
    reorderTimers.set(taskPage, window.setTimeout(function () {
      reorderTimers.delete(taskPage);
      var pageTasks = tasksForPage(taskPage);
      var previous = reorderChains.get(taskPage) || Promise.resolve();
      var request = previous.catch(function () {}).then(async function () {
        await Promise.all(pageTasks.map(function (task) { return ensureTaskCreated(task); }));
        await post('/api/study-reorder', {
          taskPage: taskPage,
          ids: pageTasks.map(function (task) { return task.id; }),
        });
      }).catch(function (error) {
        showToast(error.message);
        refresh();
      });
      reorderChains.set(taskPage, request);
      request.finally(function () {
        if (reorderChains.get(taskPage) === request) reorderChains.delete(taskPage);
      }).catch(function () {});
    }, 110));
  }

  function findTask(id) {
    return state.tasks.find((task) => task.id === id);
  }

  // 目标树 V4 由 study-route.js 独立渲染；学习页只同步任务与多树快照。
  function goalTreeOwner(taskId) {
    if (!GoalTree) return null;
    for (var i = 0; i < state.goalTrees.length; i += 1) {
      var owner = GoalTree.taskOwner(state.goalTrees[i], taskId);
      if (owner) return owner;
    }
    return null;
  }
  function reconcileStudyTaskSnapshots(snapshots) {
    var currentById = new Map(state.tasks.map(function (task) { return [task.id, task]; }));
    return (Array.isArray(snapshots) ? snapshots : []).map(function (snapshot) {
      var current = snapshot && currentById.get(snapshot.id);
      if (!current) return snapshot;
      Object.keys(current).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete current[key];
      });
      Object.assign(current, snapshot);
      return current;
    });
  }
  function applyStudyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    // 卡片 DOM 会跨刷新复用，事件处理器也会继续引用原任务对象。目标树修改进度后
    // 必须按 id 原地合并服务端快照，否则卡片虽显示新进度，±1 等操作仍会读取旧值。
    state.tasks = reconcileStudyTaskSnapshots(payload.tasks);
    state.tasks.forEach(function (task) { task.taskPage = taskPageOf(task); });
    state.trash = Array.isArray(payload.trash) ? payload.trash : [];
    state.goalTrees = Array.isArray(payload.goalTrees) ? payload.goalTrees : [];
    state.temporaryTaskIds = Array.isArray(payload.temporaryTaskIds)
      ? payload.temporaryTaskIds.map(String)
      : [];
    state.taskPageNotes = payload.taskPageNotes && typeof payload.taskPageNotes === 'object'
      ? Object.assign({}, payload.taskPageNotes)
      : {};
    goalTreeActiveId = payload.activeTreeId || (state.goalTrees[0] && state.goalTrees[0].id) || '';
    renderTaskPageRail();
  }
  function openGoalTree(trigger, taskId, treeId) {
    setTemporaryPanelOpen(false);
    if (window.StudyRoute && window.StudyRoute.open) window.StudyRoute.open(taskId || '', trigger, treeId || '');
  }

  function isTemporaryTask(id) {
    return state.temporaryTaskIds.indexOf(String(id || '')) >= 0;
  }

  function temporaryTasks() {
    var byId = new Map(state.tasks.filter(function (task) {
      return task && task.status === 'active';
    }).map(function (task) { return [task.id, task]; }));
    return state.temporaryTaskIds.map(function (id) { return byId.get(id); }).filter(Boolean);
  }

  function resetStudyHorizontalOffset() {
    if (!studyViewEl) return;
    studyViewEl.classList.remove('temporary-panel-open', 'temporary-drop-armed');
    if (studyViewEl.scrollLeft) studyViewEl.scrollLeft = 0;
  }

  function syncTemporaryLayerAvailability() {
    var available = !!(studyPageActive && viewMode === 'progress');
    if (temporaryLayerEl) temporaryLayerEl.classList.toggle('is-available', available);
    if (!available && temporaryPanelOpen) setTemporaryPanelOpen(false);
  }

  function setTemporaryPanelOpen(open, options) {
    options = options || {};
    temporaryPanelOpen = !!open && studyPageActive && viewMode === 'progress';
    resetStudyHorizontalOffset();
    if (temporaryPanelOpen && temporaryLayerEl) temporaryLayerEl.classList.remove('is-revealing');
    if (temporaryLayerEl) temporaryLayerEl.classList.toggle('is-open', temporaryPanelOpen);
    if (temporaryPanelEl) {
      temporaryPanelEl.setAttribute('aria-hidden', temporaryPanelOpen ? 'false' : 'true');
      temporaryPanelEl.inert = !temporaryPanelOpen;
      if (temporaryPanelOpen) temporaryPanelEl.removeAttribute('inert');
      else temporaryPanelEl.setAttribute('inert', '');
    }
    if (temporaryToggleEl) {
      temporaryToggleEl.setAttribute('aria-expanded', temporaryPanelOpen ? 'true' : 'false');
      setStudyAriaLabel(temporaryToggleEl, temporaryPanelOpen ? '收起临时任务' : '打开临时任务');
    }
    if (taskPageRailEl) {
      taskPageRailEl.classList.toggle('is-obscured', temporaryPanelOpen);
      taskPageRailEl.inert = temporaryPanelOpen;
      if (temporaryPanelOpen) {
        taskPageRailEl.setAttribute('inert', '');
        setTaskPageRailVisible(false);
      } else {
        taskPageRailEl.removeAttribute('inert');
      }
    }
    if (!temporaryPanelOpen && options.restoreFocus && temporaryToggleEl) {
      requestAnimationFrame(function () { temporaryToggleEl.focus({ preventScroll: true }); });
    }
    syncTemporaryLayerAvailability();
  }

  function releaseTemporaryTabFocus() {
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return;
    if (typeof active.blur === 'function') active.blur();
  }

  function highlightTemporaryTask(id) {
    if (!temporaryListEl || prefersReduced) return;
    var card = temporaryListEl.querySelector('.study-temporary-card' + taskSelector(id));
    if (!card) return;
    replayClass(card, 'is-highlighted', 760);
  }

  function buildTemporaryCard(task) {
    var progress = taskProgress(task);
    var card = document.createElement('article');
    card.className = 'study-temporary-card';
    card.dataset.id = task.id;

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'study-temporary-check';
    setStudyAriaLabel(check, '标记完成');
    check.addEventListener('click', function () {
      if (check.disabled) return;
      check.disabled = true;
      card.classList.add('is-completing');
      window.setTimeout(function () { moveTask(task.id, 'done'); }, prefersReduced ? 0 : 180);
    });

    var main = document.createElement('div');
    main.className = 'study-temporary-main';
    var heading = document.createElement('div');
    var title = document.createElement('strong');
    title.textContent = task.title || '未命名任务';
    heading.appendChild(title);
    if (progress.target) {
      var value = document.createElement('span');
      value.textContent = progress.current + ' / ' + progress.target;
      heading.appendChild(value);
      var track = document.createElement('span');
      track.className = 'study-temporary-track';
      var fill = document.createElement('i');
      fill.style.width = Math.min(100, progress.current / progress.target * 100).toFixed(2) + '%';
      track.appendChild(fill);
      main.append(heading, track);
    } else {
      main.appendChild(heading);
    }

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'study-temporary-remove';
    remove.textContent = '×';
    setStudyAriaLabel(remove, '移出临时任务');
    remove.addEventListener('click', function () { removeTemporaryTask(task, card); });
    card.append(check, main, remove);
    applyTaskColor(card, task);
    return card;
  }

  function captureTemporaryCardRects() {
    var rects = new Map();
    if (!temporaryListEl) return rects;
    temporaryListEl.querySelectorAll('.study-temporary-card[data-id]').forEach(function (card) {
      rects.set(card.dataset.id, card.getBoundingClientRect());
    });
    return rects;
  }

  function animateTemporaryCardReflow(beforeRects) {
    if (prefersReduced || !temporaryListEl || !(beforeRects instanceof Map)) return;
    var cards = temporaryListEl.querySelectorAll('.study-temporary-card[data-id]');
    cards.forEach(function (card) {
      var before = beforeRects.get(card.dataset.id);
      if (!before) return;
      var after = card.getBoundingClientRect();
      var deltaY = before.top - after.top;
      if (Math.abs(deltaY) < 0.5) return;
      card.animate([
        { transform: 'translate3d(0,' + deltaY + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], {
        duration: 190,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    });
    if (!cards.length && beforeRects.size) {
      var empty = temporaryListEl.querySelector('.study-temporary-empty');
      if (empty) replayClass(empty, 'is-entering', 220);
    }
  }

  function removeTemporaryTask(task, card) {
    if (!task || !card || card.classList.contains('is-removing')) return;
    if (prefersReduced) {
      setTemporaryMembership(task, false);
      return;
    }
    var beforeRects = captureTemporaryCardRects();
    var committed = false;
    card.classList.remove('is-highlighted');
    card.classList.add('is-removing');
    card.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
    function commit(event) {
      if (event && event.animationName !== 'studyTemporaryRemove') return;
      if (committed) return;
      committed = true;
      card.removeEventListener('animationend', commit);
      setTemporaryMembership(task, false, { reflowFrom: beforeRects });
    }
    card.addEventListener('animationend', commit);
    window.setTimeout(commit, 210);
  }

  function renderTemporaryPanel() {
    var tasks = temporaryTasks();
    document.querySelectorAll('[data-role="study-temporary-count"], [data-role="study-temporary-tab-count"]')
      .forEach(function (element) { element.textContent = String(tasks.length); });
    if (!temporaryListEl) return;
    temporaryListEl.innerHTML = '';
    if (!tasks.length) {
      var empty = document.createElement('p');
      empty.className = 'study-temporary-empty';
      empty.textContent = T('把未完成任务拖到屏幕最右侧，或从任务设置中加入。');
      temporaryListEl.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    tasks.forEach(function (task) { fragment.appendChild(buildTemporaryCard(task)); });
    temporaryListEl.appendChild(fragment);
  }

  function setTemporaryMembership(task, included, options) {
    options = options || {};
    if (!task || (included && task.status !== 'active')) return Promise.resolve(false);
    var currentlyIncluded = isTemporaryTask(task.id);
    if (currentlyIncluded === included) {
      if (included && options.open !== false) {
        setTemporaryPanelOpen(true);
        if (options.highlight !== false) {
          requestAnimationFrame(function () { highlightTemporaryTask(task.id); });
        }
      }
      return Promise.resolve(false);
    }

    var previousIndex = state.temporaryTaskIds.indexOf(task.id);
    if (included) state.temporaryTaskIds.push(task.id);
    else state.temporaryTaskIds = state.temporaryTaskIds.filter(function (id) { return id !== task.id; });
    renderTemporaryPanel();
    if (options.reflowFrom) animateTemporaryCardReflow(options.reflowFrom);
    if (included && options.open !== false) setTemporaryPanelOpen(true);

    var request = temporaryMutationChain.catch(function () {}).then(async function () {
      await ensureTaskCreated(task);
      return post('/api/study-temporary-update', { id: task.id, included: included });
    });
    temporaryMutationChain = request.catch(function () {});
    request.then(function () {
      if (included && options.highlight !== false) {
        requestAnimationFrame(function () { highlightTemporaryTask(task.id); });
      }
    }).catch(function (error) {
      var rollbackRects = captureTemporaryCardRects();
      if (included) {
        state.temporaryTaskIds = state.temporaryTaskIds.filter(function (id) { return id !== task.id; });
      } else if (!isTemporaryTask(task.id) && task.status === 'active') {
        var insertAt = Math.max(0, Math.min(previousIndex, state.temporaryTaskIds.length));
        state.temporaryTaskIds.splice(insertAt, 0, task.id);
      }
      renderTemporaryPanel();
      animateTemporaryCardReflow(rollbackRects);
      if (!included && temporaryListEl) {
        var restored = temporaryListEl.querySelector('.study-temporary-card' + taskSelector(task.id));
        if (restored) replayClass(restored, 'is-restoring', 240);
      }
      showToast(error.message);
    });
    return request;
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

  function setTemporaryDropVisual(drag, active, panelTarget) {
    if (!drag) return;
    drag.edgeArmed = !!active;
    if (temporaryPanelEl) temporaryPanelEl.classList.toggle('is-drop-target', !!panelTarget);
  }

  function clearTemporaryEdgeDwell(drag) {
    if (!drag) return;
    window.clearTimeout(drag.edgeTimer);
    drag.edgeTimer = 0;
    drag.edgeHovering = false;
    drag.overTemporaryPanel = false;
    setTemporaryDropVisual(drag, false, false);
  }

  function updateTemporaryDragTarget(clientX, clientY) {
    var drag = progressDrag;
    if (!drag || !drag.active) return false;
    var wasTemporaryAttempt = drag.overTemporaryPanel || drag.edgeHovering || drag.edgeArmed;
    var panelRect = temporaryPanelOpen && temporaryPanelEl
      ? temporaryPanelEl.getBoundingClientRect()
      : null;
    var overPanel = !!(panelRect && clientX >= panelRect.left && clientX <= panelRect.right
      && clientY >= panelRect.top && clientY <= panelRect.bottom);
    if (overPanel) {
      window.clearTimeout(drag.edgeTimer);
      drag.edgeTimer = 0;
      drag.edgeHovering = false;
      drag.overTemporaryPanel = true;
      setTemporaryDropVisual(drag, true, true);
      return true;
    }

    drag.overTemporaryPanel = false;
    if (temporaryPanelOpen) {
      if (wasTemporaryAttempt) {
        clearTemporaryEdgeDwell(drag);
        flipProgressCards(function () { restoreProgressOrder(drag); });
        return true;
      }
      setTemporaryDropVisual(drag, false, false);
      return false;
    }
    var atEdge = clientX >= window.innerWidth - TEMPORARY_EDGE_ZONE_PX;
    if (!atEdge) {
      if (wasTemporaryAttempt) {
        clearTemporaryEdgeDwell(drag);
        flipProgressCards(function () { restoreProgressOrder(drag); });
        return true;
      }
      clearTemporaryEdgeDwell(drag);
      return false;
    }

    drag.edgeHovering = true;
    if (!drag.edgeTimer && !drag.edgeArmed) {
      drag.edgeTimer = window.setTimeout(function () {
        if (!progressDrag || progressDrag !== drag || !drag.edgeHovering) return;
        drag.edgeTimer = 0;
        setTemporaryDropVisual(drag, true, false);
      }, TEMPORARY_EDGE_DWELL_MS);
    }
    return true;
  }

  function pointerInProgressReorderZone(clientX) {
    if (!progressListEl) return false;
    var rect = progressListEl.getBoundingClientRect();
    return clientX >= rect.left - 44 && clientX <= rect.right + 44;
  }

  function restoreProgressOrder(drag) {
    if (!drag || !progressListEl) return;
    drag.originalOrder.forEach(function (id) {
      var row = progressListEl.querySelector('.study-progress-card[data-id="' + id + '"]');
      if (row) progressListEl.appendChild(row);
    });
  }

  function beginProgressDrag(event, card, task, grip) {
    if (event.button !== 0) return;
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
      edgeTimer: 0,
      edgeHovering: false,
      edgeArmed: false,
      overTemporaryPanel: false,
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
    if (!updateTemporaryDragTarget(event.clientX, event.clientY)
        && pointerInProgressReorderZone(event.clientX)) {
      liveReorderProgressCard(event.clientY);
    }
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
    var temporaryDrop = false;
    var cancelEdgeAttempt = false;
    if (progressDrag.active) {
      positionProgressGhost(event.clientX, event.clientY);
      updateTemporaryDragTarget(event.clientX, event.clientY);
      temporaryDrop = progressDrag.edgeArmed || progressDrag.overTemporaryPanel;
      cancelEdgeAttempt = progressDrag.edgeHovering && !temporaryDrop;
      if (!temporaryDrop && !cancelEdgeAttempt && pointerInProgressReorderZone(event.clientX)) {
        liveReorderProgressCard(event.clientY);
      }
    }
    finishProgressDrag({ temporaryDrop: temporaryDrop, cancel: cancelEdgeAttempt });
  }

  function onProgressDragPointerCancel(event) {
    if (!progressDrag || event.pointerId !== progressDrag.pointerId) return;
    finishProgressDrag({ cancel: true });
  }

  function finishProgressDrag(options) {
    options = options || {};
    var drag = progressDrag;
    if (!drag) return false;
    window.clearTimeout(drag.edgeTimer);
    setTemporaryDropVisual(drag, false, false);
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

    if (options.cancel || options.temporaryDrop) {
      if (prefersReduced) {
        stopProgressFlipAnimations();
        restoreProgressOrder(drag);
      } else {
        flipProgressCards(function () { restoreProgressOrder(drag); });
      }
    }

    var domOrder = progressListRows().map(function (row) { return row.dataset.id; });
    var changed = !options.cancel && !options.temporaryDrop
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
    if (options.temporaryDrop) {
      revealLandingCard(landingCard);
      var task = findTask(drag.taskId);
      var membershipFailed = false;
      var cancelTemporaryTransfer = null;
      var membershipRequest = task
        ? setTemporaryMembership(task, true, { open: true, highlight: false })
        : Promise.resolve(false);
      membershipRequest.catch(function () {
        membershipFailed = true;
        if (cancelTemporaryTransfer) cancelTemporaryTransfer();
      });
      var temporaryCard = task && temporaryListEl
        ? temporaryListEl.querySelector('.study-temporary-card' + taskSelector(task.id))
        : null;
      if (temporaryCard) temporaryCard.classList.add('drag-handoff');
      if (options.immediate || prefersReduced) {
        if (drag.ghost) drag.ghost.remove();
        revealLandingCard(temporaryCard);
        if (task) highlightTemporaryTask(task.id);
      } else {
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          if (membershipFailed) {
            if (drag.ghost) drag.ghost.remove();
            revealLandingCard(temporaryCard);
            return;
          }
          var liveTemporaryCard = task && temporaryListEl
            ? temporaryListEl.querySelector('.study-temporary-card' + taskSelector(task.id))
            : null;
          var targetCard = liveTemporaryCard || temporaryCard || landingCard;
          cancelTemporaryTransfer = flyGhostToTemporaryCard(drag.ghost, targetCard, function () {
            revealLandingCard(liveTemporaryCard || temporaryCard);
            if (task) requestAnimationFrame(function () {
              requestAnimationFrame(function () { highlightTemporaryTask(task.id); });
            });
          }, temporaryLandingRect(targetCard));
        }); });
      }
      stopProgressFlipAnimations();
      return true;
    }
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

  function temporaryLandingRect(card) {
    if (!card) return null;
    var target = card.getBoundingClientRect();
    if (!temporaryPanelEl || !temporaryLayerEl || !temporaryPanelOpen
        || !card.closest('.study-temporary-panel')) return target;
    var panel = temporaryPanelEl.getBoundingClientRect();
    var layer = temporaryLayerEl.getBoundingClientRect();
    var finalPanelLeft = layer.right - panel.width;
    return {
      left: target.left + finalPanelLeft - panel.left,
      top: target.top,
      width: target.width,
      height: target.height,
    };
  }

  function flyGhostToTemporaryCard(ghost, row, done, targetRect) {
    if (!ghost || !row || !targetRect || prefersReduced) {
      if (ghost) ghost.remove();
      if (done) done();
      return function () {};
    }
    var target = targetRect;
    var source = ghost.getBoundingClientRect();
    if (!source.width || !source.height || !target.width || !target.height) {
      ghost.remove();
      if (done) done();
      return function () {};
    }

    var proxy = row.cloneNode(true);
    proxy.classList.remove('drag-handoff', 'is-highlighted', 'is-completing');
    proxy.classList.add('study-temporary-transfer-proxy');
    proxy.removeAttribute('id');
    proxy.setAttribute('aria-hidden', 'true');
    proxy.inert = true;
    proxy.setAttribute('inert', '');
    proxy.querySelectorAll('[id]').forEach(function (element) { element.removeAttribute('id'); });
    proxy.querySelectorAll('button, input, select, textarea, a, [tabindex]').forEach(function (element) {
      element.tabIndex = -1;
    });
    proxy.style.left = target.left + 'px';
    proxy.style.top = target.top + 'px';
    proxy.style.width = target.width + 'px';
    proxy.style.height = target.height + 'px';

    var offsetX = source.left - target.left;
    var offsetY = source.top - target.top;
    var scaleX = source.width / target.width;
    var scaleY = source.height / target.height;
    var fromTransform = 'translate3d(' + offsetX + 'px,' + offsetY + 'px,0) scale3d('
      + scaleX + ',' + scaleY + ',1)';
    var distance = Math.hypot(target.left - source.left, target.top - source.top);
    var duration = Math.max(320, Math.min(380, 300 + distance * 0.09));
    document.body.appendChild(proxy);

    var proxyAnimation = proxy.animate([
      { transform: fromTransform, opacity: 0, offset: 0 },
      { transform: fromTransform, opacity: 1, offset: 0.24 },
      { transform: 'translate3d(0,0,0) scale3d(1,1,1)', opacity: 1, offset: 1 },
    ], {
      duration: duration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards',
    });
    var ghostAnimation = ghost.animate([
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: 0.24 },
      { opacity: 0, offset: 1 },
    ], { duration: duration, easing: 'linear', fill: 'forwards' });
    var contentAnimations = Array.from(proxy.children).map(function (child, index) {
      var targetChild = row.children[index];
      var targetOpacity = targetChild ? window.getComputedStyle(targetChild).opacity : '1';
      return child.animate([
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 0.68 },
        { opacity: targetOpacity, offset: 1 },
      ], { duration: duration, easing: 'linear', fill: 'forwards' });
    });

    var settled = false;
    function cleanup(complete) {
      if (settled) return;
      settled = true;
      proxyAnimation.cancel();
      ghostAnimation.cancel();
      contentAnimations.forEach(function (animation) { animation.cancel(); });
      proxy.remove();
      ghost.remove();
      if (complete && done) done();
      else revealLandingCard(row);
    }
    proxyAnimation.finished.then(function () { cleanup(true); }, function () {
      if (!settled) cleanup(false);
    });
    return function () { cleanup(false); };
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
    applyTaskColor(row, task);
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
      var treeHelpBtn = document.createElement('button');
      treeHelpBtn.type = 'button';
      treeHelpBtn.className = 'study-route-help-trigger study-goal-tree-help is-list-view';
      treeHelpBtn.dataset.action = 'study-goal-tree-help';
      treeHelpBtn.setAttribute('aria-label', T('目标树使用教程'));
      treeHelpBtn.setAttribute('aria-haspopup', 'dialog');
      treeHelpBtn.setAttribute('aria-expanded', 'false');
      treeHelpBtn.textContent = '?';
      treeHelpBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (window.StudyRoute) window.StudyRoute.help(treeHelpBtn);
      });
      actions.appendChild(treeHelpBtn);
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
    var pageTasks = currentPageTasks();
    var groups = [
      { status: 'active', label: 'To Do', match: function (t) { return t.status === 'active'; }, add: true },
      { status: 'done', label: 'Done', match: function (t) { return t.status === 'done'; } },
    ];
    groups.forEach(function (group) {
      var tasks = pageTasks.filter(group.match);
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
    applyTaskColor(row, task);
    return row;
  }

  function listQuickAdd() {
    if (!studyLoaded) {
      ensureStudyLoaded().then(function (loaded) { if (loaded) listQuickAdd(); });
      return;
    }
    var task = createOptimisticTask({ title: '未命名', status: 'active', taskPage: currentTaskPage });
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

  // 任务卡片着色：颜色值来自目标树同款 12 色粉彩家族（study-palette.js），
  // 通过 --task-color 变量与 data-task-color 属性驱动 CSS 底色与左侧色条。
  function applyTaskColor(el, task) {
    if (!el) return;
    var color = task && task.color ? String(task.color).trim() : '';
    if (color) {
      el.style.setProperty('--task-color', color);
      el.setAttribute('data-task-color', color);
    } else {
      el.style.removeProperty('--task-color');
      el.removeAttribute('data-task-color');
    }
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
    applyTaskColor(card, task);
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
    setTemporaryPanelOpen(false);
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
    var otherOwners = state.goalTrees.filter(function (tree) {
      return tree.id !== (owner && owner.tree.id);
    }).map(function (tree) {
      return GoalTree ? GoalTree.taskOwner(tree, task.id) : null;
    }).filter(Boolean);
    var treeState = document.createElement('strong');
    treeState.textContent = owner
      ? (otherOwners.length ? owner.tree.title + ' · 另 ' + otherOwners.length + ' 棵' : owner.tree.title)
      : T('未加入');
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
      openGoalTree(origin, task.id, owner && owner.tree.id);
    });
    treeActions.appendChild(treeAction);
    treeSection.append(treeCopy, treeActions);
    // 总路线相关操作统一在极简路线面板内完成，任务设置不再复制入口。

    if (!options.compactGoalTree && task.status === 'active') {
      var temporaryBtn = document.createElement('button');
      temporaryBtn.type = 'button';
      temporaryBtn.className = 'study-progress-settings-temporary';
      temporaryBtn.textContent = isTemporaryTask(task.id) ? '移出临时任务' : '加入临时任务';
      temporaryBtn.addEventListener('click', function () {
        var included = !isTemporaryTask(task.id);
        closeProgressSettings(false, true);
        if (!included && temporaryPanelOpen && temporaryListEl) {
          var temporaryCard = temporaryListEl.querySelector('.study-temporary-card' + taskSelector(task.id));
          if (temporaryCard) {
            removeTemporaryTask(task, temporaryCard);
            return;
          }
        }
        setTemporaryMembership(task, included, { open: included });
      });
      box.appendChild(temporaryBtn);
    }

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

  // —— 调色盘浮层：右键任务卡片 / 图例色块弹出，与目标树阶段同款 12 色 ——
  let studyColorPopover = null;
  let studyColorTrigger = null;
  let studyColorPositionFrame = 0;
  let studyColorAnchorX = 0;
  let studyColorAnchorY = 0;
  let studyColorPick = null;

  function buildStudyColorPalette(currentColor) {
    var colors = (window.RelatumStudyPalette && window.RelatumStudyPalette.COLORS) || [];
    currentColor = String(currentColor || '').trim();
    var swatches = colors.map(function (item) {
      var isActive = item.value === currentColor || (!item.value && !currentColor);
      var style = item.value ? ' style="background:' + item.value + '"' : '';
      return '<button type="button" class="study-route-color-swatch' + (isActive ? ' is-active' : '') + '"'
        + ' data-color="' + escapeHtml(item.value) + '"'
        + ' aria-label="' + escapeHtml(item.label) + '"' + style + '></button>';
    }).join('');
    return '<div class="study-route-color-palette">' + swatches + '</div>';
  }

  function positionStudyColorPopover() {
    if (!studyColorPopover) return;
    var box = studyColorPopover.getBoundingClientRect();
    var edge = 12;
    var left = studyColorAnchorX + 10;
    if (left + box.width > window.innerWidth - edge) left = studyColorAnchorX - box.width - 10;
    left = Math.max(edge, left);
    var top = studyColorAnchorY + 10;
    if (top + box.height > window.innerHeight - edge) top = studyColorAnchorY - box.height - 10;
    top = Math.max(edge, top);
    studyColorPopover.style.left = Math.round(left) + 'px';
    studyColorPopover.style.top = Math.round(top) + 'px';
  }

  function scheduleStudyColorPosition() {
    if (!studyColorPopover || studyColorPositionFrame) return;
    studyColorPositionFrame = requestAnimationFrame(function () {
      studyColorPositionFrame = 0;
      if (!studyColorTrigger || !studyColorTrigger.isConnected) {
        closeStudyColorPopover(false, true);
        return;
      }
      positionStudyColorPopover();
    });
  }

  function openStudyColorPopover(trigger, clientX, clientY, options) {
    options = options || {};
    if (!trigger) return;
    if (studyColorPopover) closeStudyColorPopover(false, true);
    studyColorTrigger = trigger;
    studyColorAnchorX = clientX;
    studyColorAnchorY = clientY;
    studyColorPick = typeof options.pick === 'function' ? options.pick : null;
    var box = document.createElement('section');
    box.className = 'study-color-popover';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', options.label || T('选择颜色'));
    box.innerHTML = buildStudyColorPalette(options.currentColor || '');
    box.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    box.addEventListener('click', function (event) {
      var swatch = event.target.closest('button[data-color]');
      if (!swatch) return;
      var value = swatch.dataset.color || '';
      var pick = studyColorPick;
      closeStudyColorPopover(false, true);
      if (pick) pick(value);
    });
    studyColorPopover = box;
    document.body.appendChild(box);
    positionStudyColorPopover();
    requestAnimationFrame(function () {
      if (!studyColorPopover) return;
      studyColorPopover.classList.add('is-open');
      positionStudyColorPopover();
    });
    window.setTimeout(function () {
      if (!studyColorPopover) return;
      var active = studyColorPopover.querySelector('.study-route-color-swatch.is-active');
      var target = active || studyColorPopover.querySelector('.study-route-color-swatch');
      if (target) target.focus();
    }, prefersReduced ? 0 : 80);
  }

  function closeStudyColorPopover(restoreFocus, instant) {
    var popover = studyColorPopover;
    var trigger = studyColorTrigger;
    if (!popover) return;
    if (studyColorPositionFrame) cancelAnimationFrame(studyColorPositionFrame);
    studyColorPositionFrame = 0;
    studyColorPopover = null;
    studyColorTrigger = null;
    studyColorPick = null;
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
    window.setTimeout(finish, 160);
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

    closeProgressSettings(false, true);
    if (!task.progress || typeof task.progress !== 'object') task.progress = {};
    task.progress.target = target;
    task.progress.milestones = milestones;
    render();
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
    var task = createOptimisticTask({ title: '未命名', status: 'active', taskPage: currentTaskPage });
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

    // 颜色（增量同步时也要跟随）
    applyTaskColor(card, task);
  }

  // —— 增量同步：不销毁卡片，只更新 / 移动 / 新增 / 移除 ——
  function incrementalSyncCardList(container, tasks, completed, emptyMessage, options) {
    if (!container) return;
    // 切页静音：整版淡出淡入期间不叠加卡片级退场/入场动画，旧卡片直接移除、新卡片直接就位
    var silent = !!(options && options.pageSwitch);

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
        if (!silent && !prefersReduced) {
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
        if (!silent && !prefersReduced && !completed) card.classList.add('is-entering');
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
    if (!silent && !prefersReduced) {
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
    var treeAtRequest = goalTreeActiveId;
    var request = queueTaskMutation(task, function () {
      return post('/api/study-task-progress', { id: task.id, delta: delta });
    }).then(function (json) {
      // 多目标树：请求期间若已切换活动树，丢弃旧树快照
      if (Array.isArray(json.goalTrees)) state.goalTrees = json.goalTrees;
      if (json.activeTreeId && json.activeTreeId === treeAtRequest) goalTreeActiveId = json.activeTreeId;
      if (taskProgressSeq.get(task) === seq) {
        var serverProgress = taskProgress(json.task || {});
        var needsReconcile = serverProgress.current !== taskProgress(task).current
          || serverProgress.target !== taskProgress(task).target;
        Object.assign(task, json.task || {});
        if (needsReconcile) {
          var synced = document.querySelector('.study-progress-card' + taskSelector(task.id));
          if (synced) syncProgressCardFromTask(synced, task);
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
      return null;
    });
  }

  function renderProgress(options) {
    if (!progressListEl || !completedListEl || !completedSectionEl) return;
    // 拖拽排序期间不重建卡片列表，避免掐断幽灵卡与 FLIP 动画
    if (progressDrag && progressDrag.active) return;
    var pageTasks = currentPageTasks();
    var active = pageTasks.filter(function (t) { return t.status === 'active'; });
    var done = pageTasks.filter(function (t) { return t.status === 'done'; });
    var count = document.querySelector('[data-role="study-task-count"]');
    var activeCount = document.querySelector('[data-role="study-active-count"]');
    var doneCount = document.querySelector('[data-role="study-completed-count"]');
    if (count) count.textContent = String(pageTasks.length);
    if (activeCount) activeCount.textContent = String(active.length);
    if (doneCount) doneCount.textContent = String(done.length);

    // 增量同步：保留已有卡片 DOM，只更新内容与顺序
    var emptyMsg = done.length ? '当前没有未完成任务。' : '还没有学习任务，点击右上角的 ＋ 开始。';
    incrementalSyncCardList(progressListEl, active, false, emptyMsg, options);

    // 已完成列始终可见，保持双列布局避免未完成卡片被拉长
    completedSectionEl.hidden = false;
    incrementalSyncCardList(completedListEl, done, true, '还没有已完成的任务。', options);
  }

  function render(options) {
    closeStudyColorPopover(false, true);
    applyViewMode();
    renderTaskPageNote();
    if (viewMode === 'list') {
      var listHost = document.querySelector('[data-role="study-list"]');
      var prevListRects = captureListRects(listHost, '.study-list-row');
      renderList();
      requestAnimationFrame(function () { animateListMoves(listHost, '.study-list-row', prevListRects); });
    } else {
      renderProgress(options);
    }
    // 切页时回收站与临时面板跨页共享、内容未变，跳过全量重建
    if (!(options && options.pageSwitch)) {
      renderTemporaryPanel();
      renderTrash();
    }
    if (progressSettingsPopover
        && (viewMode !== 'progress' || !progressSettingsTrigger || !progressSettingsTrigger.isConnected)) {
      closeProgressSettings(false, true);
    }
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
    var temporaryIndex = state.temporaryTaskIds.indexOf(id);
    task.status = status;
    var done = status === 'done';
    if (done && temporaryIndex >= 0) {
      state.temporaryTaskIds.splice(temporaryIndex, 1);
    }

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

    queueTaskPatch(task, { status }).catch(function (error) {
      task.status = old;
      if (temporaryIndex >= 0 && !isTemporaryTask(task.id)) {
        state.temporaryTaskIds.splice(
          Math.min(temporaryIndex, state.temporaryTaskIds.length), 0, task.id);
      }
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
    state.temporaryTaskIds = state.temporaryTaskIds.filter(function (item) { return item !== id; });
    state.trash.unshift({ task: trashedTask, deletedAt: new Date().toISOString() });
    state.trash = state.trash.slice(0, STUDY_TRASH_LIMIT);
    trashEnterId = task.id;
    if (state.selectedId === id) state.selectedId = '';
    render();

    trashChain = trashChain.catch(() => undefined).then(async () => {
      await ensureTaskCreated(task);
      trashedTask.id = task.id; // 刚快速创建又立刻删除时，回收站记录同步后端分配的真实 id
      // 等所有任务的在途 patch 落地，避免 trash 响应里的快照把刚改的名字覆盖回去
      await flushStudyMutations();
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
      await flushStudyMutations();
      const json = await post('/api/study-task-restore', { id });
      animateDetachedExit(document.querySelector('.study-trash-item' + taskSelector(id)), 'study-trash-exit-ghost');
      if (json.study) applyStudyPayload(json.study);
      else {
        state.trash = state.trash.filter((entry) => entry.task.id !== id);
        state.tasks.push(json.task);
      }
      setCurrentTaskPage(taskPageOf(json.task), { immediate: true });
      render();
      const restored = document.querySelector('[data-role="study-view"] ' + taskSelector(json.task.id));
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
    setTemporaryPanelOpen(false);
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
    const taskPage = currentTaskPage;
    const done = tasksForPage(taskPage).filter((task) => task.status === 'done');
    if (!done.length) {
      showToast('已完成这一列还是空的');
      return;
    }
    const buttons = Array.from(document.querySelectorAll('[data-action="archive-done"]'));
    if (buttons.some((button) => button.disabled)) return;
    buttons.forEach((button) => { button.disabled = true; });
    try {
      // 等所有任务的在途 patch 落地，避免归档响应的快照把刚改的名字覆盖回去
      await flushStudyMutations();
      const json = await post('/api/study-archive-done', { taskPage: taskPage });
      const archivedIds = new Set(json.archivedIds || []);
      buttons.forEach((button) => button.classList.add('archive-success'));
      if (viewMode === 'list' && currentTaskPage === taskPage) {
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
    var task = findTask(id);
    if (taskPageOf(task) !== currentTaskPage) setCurrentTaskPage(taskPageOf(task), { immediate: true });
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
      await flushStudyMutations();
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
  if (temporaryToggleEl) temporaryToggleEl.addEventListener('click', function (event) {
    setTemporaryPanelOpen(!temporaryPanelOpen);
    // 鼠标点击标签后不要把焦点留在按钮上，否则下一次裸 Tab 会被当作按钮焦点导航。
    // 标签在展开态会退到面板下；键盘激活时把焦点送到面板内的关闭按钮。
    if (event.detail > 0 && document.activeElement === temporaryToggleEl) temporaryToggleEl.blur();
    else if (event.detail === 0 && temporaryPanelOpen && temporaryPanelEl) {
      var closeButton = temporaryPanelEl.querySelector('[data-action="study-temporary-close"]');
      if (closeButton) requestAnimationFrame(function () { closeButton.focus({ preventScroll: true }); });
    }
  });
  document.querySelectorAll('[data-action="study-temporary-close"]').forEach(function (button) {
    button.addEventListener('click', function () {
      setTemporaryPanelOpen(false, { restoreFocus: true });
    });
  });
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
      var blockingAction = event.target.closest('[data-action="study-goal-tree-open"]');
      if (blockingAction) setTemporaryPanelOpen(false);
    }, true);
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

  // 右键任务卡片 → 调色盘（进度卡 / 清单行 / 临时侧栏共用；按钮与表单控件不拦截）。
  // 与目标树一致：同一卡片再次右键 = 关闭。
  if (studyViewEl) {
    studyViewEl.addEventListener('contextmenu', function (event) {
      var card = event.target.closest('.study-progress-card, .study-list-row, .study-temporary-card');
      if (!card || event.target.closest('button, input, select, textarea, a')) return;
      var task = findTask(card.dataset.id);
      if (!task) return;
      event.preventDefault();
      event.stopPropagation();
      if (studyColorPopover && studyColorTrigger === card) {
        closeStudyColorPopover(true);
        return;
      }
      openStudyColorPopover(card, event.clientX, event.clientY, {
        currentColor: task.color || '',
        label: T('选择颜色'),
        pick: function (value) {
          queueTaskPatch(task, { color: value }).then(function () {
            render();
          }).catch(function (error) {
            showToast(error.message);
            return refresh();
          });
          // 乐观 DOM 上色：queueTaskPatch 已同步打好数据补丁，这里不等 POST 往返
          // 立即刷新所有可见卡片，消除偶发网络/落盘延迟造成的变色滞后。
          document.querySelectorAll(
            '.study-progress-card[data-id], .study-list-row[data-id], .study-temporary-card[data-id]'
          ).forEach(function (el) {
            if (el.dataset.id === task.id) applyTaskColor(el, task);
          });
        },
      });
    });
  }

  // —— 完整视图右上角颜色图例：4 个圆角色块，右键调色，localStorage 持久化 ——
  const STUDY_LEGEND_KEY = 'study:legend:v1';
  const STUDY_LEGEND_COUNT = 4;
  const STUDY_LEGEND_DEFAULT = ['', '', '', ''];
  const studyLegendEl = document.querySelector('[data-role="study-legend"]');
  let legendColors = loadStudyLegend();

  function isLegendColor(value) {
    return typeof value === 'string' && (value === '' || /^#[0-9a-fA-F]{6}$/.test(value));
  }

  function loadStudyLegend() {
    var colors = STUDY_LEGEND_DEFAULT.slice();
    try {
      var raw = JSON.parse(localStorage.getItem(STUDY_LEGEND_KEY) || 'null');
      if (raw && Array.isArray(raw.colors) && raw.colors.length === STUDY_LEGEND_COUNT) {
        var next = [];
        for (var i = 0; i < STUDY_LEGEND_COUNT; i += 1) {
          next.push(isLegendColor(raw.colors[i]) ? raw.colors[i] : '');
        }
        colors = next;
      }
    } catch (e) { /* 损坏回退默认 */ }
    return colors;
  }

  function saveStudyLegend() {
    try {
      localStorage.setItem(STUDY_LEGEND_KEY, JSON.stringify({ version: 1, colors: legendColors }));
    } catch (e) { /* 存储不可用（隐私模式/配额）时静默，仅本次会话生效 */ }
  }

  function setLegendColor(index, value) {
    if (index < 0 || index >= STUDY_LEGEND_COUNT) return;
    legendColors[index] = isLegendColor(value) ? value : '';
    saveStudyLegend();
    applyStudyLegend();
  }

  function applyStudyLegend() {
    if (!studyLegendEl) return;
    var chips = studyLegendEl.querySelectorAll('.study-legend-chip');
    chips.forEach(function (chip) {
      var index = Number(chip.dataset.legendIndex);
      var color = legendColors[index] || '';
      chip.classList.toggle('is-default', !color);
      if (color) chip.style.background = color;
      else chip.style.removeProperty('background');
      chip.setAttribute('aria-label', T('图例色') + ' ' + (index + 1));
    });
    studyLegendEl.setAttribute('aria-label', T('颜色图例'));
  }

  if (studyLegendEl) {
    studyLegendEl.addEventListener('contextmenu', function (event) {
      var chip = event.target.closest('.study-legend-chip');
      if (!chip) return;
      event.preventDefault();
      event.stopPropagation();
      if (studyColorPopover && studyColorTrigger === chip) {
        closeStudyColorPopover(true);
        return;
      }
      var index = Number(chip.dataset.legendIndex);
      openStudyColorPopover(chip, event.clientX, event.clientY, {
        currentColor: legendColors[index] || '',
        label: T('选择颜色'),
        pick: function (value) { setLegendColor(index, value); },
      });
    });
    studyLegendEl.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var chip = event.target.closest('.study-legend-chip');
      if (!chip) return;
      event.preventDefault();
      var rect = chip.getBoundingClientRect();
      var index = Number(chip.dataset.legendIndex);
      openStudyColorPopover(chip, rect.left + rect.width / 2, rect.bottom, {
        currentColor: legendColors[index] || '',
        label: T('选择颜色'),
        pick: function (value) { setLegendColor(index, value); },
      });
    });
  }
  applyStudyLegend();

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
    if (studyColorPopover
        && !studyColorPopover.contains(event.target)
        && !(studyColorTrigger && studyColorTrigger.contains(event.target))) {
      closeStudyColorPopover(true);
    }
    if (!studyMilestoneDialog && progressSettingsPopover
        && !progressSettingsPopover.contains(event.target)
        && !(progressSettingsTrigger && progressSettingsTrigger.contains(event.target))) {
      closeProgressSettings(true);
    }
  });

  window.addEventListener('resize', scheduleProgressSettingsPosition);
  window.addEventListener('scroll', scheduleProgressSettingsPosition, true);
  window.addEventListener('resize', scheduleStudyColorPosition);
  window.addEventListener('scroll', scheduleStudyColorPosition, true);

  document.addEventListener('keydown', (event) => {
    if (progressDrag && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishProgressDrag({ cancel: true, immediate: true });
      return;
    }
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
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        && studyPageActive && viewMode === 'progress' && !event.defaultPrevented) {
      var blockingLayer = studyColorPopover || progressSettingsPopover || studyMilestoneDialog
        || (trashPanel && !trashPanel.hidden)
        || document.querySelector('.study-progress-compose.is-open, .study-route-overlay:not([hidden])');
      if (!blockingLayer) {
        event.preventDefault();
        event.stopPropagation();
        setTemporaryPanelOpen(!temporaryPanelOpen);
        releaseTemporaryTabFocus();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (studyColorPopover) {
        event.preventDefault();
        closeStudyColorPopover(true);
      } else if (progressSettingsPopover) {
        event.preventDefault();
        closeProgressSettings(true);
      } else if (!trashPanel.hidden) {
        closeTrash();
      } else if (temporaryPanelOpen) {
        event.preventDefault();
        setTemporaryPanelOpen(false, { restoreFocus: true });
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
    renderTemporaryPanel();
    applyStudyLegend();
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) renderCadence(activityPayload, { intro: false });
  });
})();

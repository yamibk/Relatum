(function () {
  'use strict';

  const STATUS = ['todo', 'doing', 'done'];
  const STATUS_LABEL = { todo: '待办', doing: '进行中', done: '已完成' };
  const state = {
    tasks: [], trash: [], canvases: [], focusByTask: {}, focusSessions: [],
    dialogTaskId: '', selectedId: '',
  };
  let studyRefreshSeq = 0;
  let studyLoaded = false;
  let studyInitialLoad = null;
  let studyLatestRefresh = null;
  const COLUMN_ORDER = ['todo', 'doing', 'done'];
  const dialog = document.querySelector('[data-role="task-dialog"]');
  const form = document.querySelector('[data-role="task-form"]');
  const trashPanel = document.querySelector('[data-role="trash-panel"]');
  const trashConfirm = document.querySelector('[data-role="study-trash-confirm"]');
  const toast = document.querySelector('[data-role="study-toast"]');
  const canvasSelect = document.querySelector('[data-role="canvas-select"]');
  const canvasPanel = document.querySelector('[data-role="canvas-panel"]');
  const canvasFrame = document.querySelector('[data-role="canvas-frame"]');
  const canvasLoading = document.querySelector('[data-role="canvas-loading"]');
  const canvasPanelTitle = document.querySelector('[data-role="canvas-panel-title"]');
  const taskSaveButton = document.querySelector('[data-role="task-save"]');
  let toastTimer = null;
  let drag = null;            // 指针拖拽状态
  let suppressRenameClickId = ''; // 从标题拖动任务后，吞掉随后的 click，避免误进改名
  let selectionFollowUntil = 0; // 选中环短时逐帧贴住动画中的卡片
  let selectionFollowRaf = 0;
  let selectionRingFlight = null;
  let landingFlightId = '';    // 松手后幽灵卡仍在飞行：真实卡继续隐藏，直到单层动画抵达
  let optimisticTaskSeq = 0;
  let reorderTimer = null;
  let reorderChain = Promise.resolve();
  let trashChain = Promise.resolve(); // 快速连删时后台按点击顺序落盘，界面无需等待网络
  let isEmptyingTrash = false;
  let deleteFlushTimer = null;        // 连续删除时把多次列表重建合并成最后一次（防残影/卡顿）
  const taskCreatePromises = new WeakMap(); // 临时任务先动起来，后端随后认领真实 id
  const taskUpdateChains = new WeakMap();   // 同一任务的连续修改按顺序落盘
  const taskUpdateSeq = new WeakMap();
  let panelOpen = false;      // 迷你画布浮窗是否打开
  let panelPath = '';         // 浮窗 iframe 当前加载的画布路径
  let panelHideTimer = null;
  let suppressFlip = false;   // 拖拽落入用幽灵卡+回弹，跳过 FLIP，避免双重动画
  const liveFlipAnims = new Map(); // 实时让位中「正在飞」的卡→动画，供下次让位中断复用（防瞬移）
  let focusOpen = false;      // 今日专注沉浸页是否打开
  let focusCelebrationRaf = 0;
  let celebrated = false;     // 沉浸页本次全完成是否已放过庆祝（防重复触发）
  let focusStatusPopId = '';  // 沉浸页完成/取消完成后，新卡短促回弹
  let trashEnterId = '';      // 回收站新增条目轻轻落入
  const carryoverHideTimers = new WeakMap();
  const numberPopTimers = new WeakMap();
  const selectionRing = document.querySelector('[data-role="selection-ring"]');
  const todayZone = document.querySelector('.study-today');
  const prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();

  // —— 视图模式：board(看板，默认) / list(极简清单)；在学习页再点一次「学」书脊切换、localStorage 记忆 ——
  const VIEW_MODE_KEY = 'study:viewMode';
  const studyViewEl = document.querySelector('[data-role="study-view"]');
  function readViewMode() {
    try { return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'board'; }
    catch (e) { return 'board'; }
  }
  let viewMode = readViewMode();
  function applyViewMode() {
    if (studyViewEl) studyViewEl.classList.toggle('study-mode-list', viewMode === 'list');
  }
  function setViewMode(mode, animate) {
    const next = mode === 'list' ? 'list' : 'board';
    if (next === viewMode) return;
    viewMode = next;
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch (e) {}
    if (animate && !prefersReduced && studyViewEl) {
      // study-mode-anim 全程在场（承载 transition），study-mode-switching 控制淡出
      studyViewEl.classList.add('study-mode-anim', 'study-mode-switching');
      setTimeout(() => {
        render();                                               // 隐身时换内容
        requestAnimationFrame(() => requestAnimationFrame(() => {
          studyViewEl.classList.remove('study-mode-switching'); // 再淡入
          setTimeout(() => studyViewEl.classList.remove('study-mode-anim'), 240);
        }));
      }, 200);
    } else {
      render();
    }
  }
  function toggleViewMode() {
    setViewMode(viewMode === 'list' ? 'board' : 'list', true);
  }
  window.StudyView = { toggleMode: toggleViewMode };

  function studyVisible() {
    const view = document.querySelector('[data-role="study-view"]');
    const bookView = view && view.closest('.book-view');
    return !!(bookView && bookView.classList.contains('study-active'));
  }

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

  function prepareTaskFocus(task) {
    if (!task) return;
    document.dispatchEvent(new CustomEvent('focus:prepare', {
      detail: { taskId: task.id, taskTitle: task.title || '未命名任务' },
    }));
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
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
      status: STATUS.includes(payload.status) ? payload.status : 'todo',
      due: payload.due || '',
      focusDay: payload.focusDay || '',
      tags: [],
      memo: '',
      linkedCanvas: '',
      createdAt: now,
      updatedAt: now,
      completedAt: '',
    };
  }

  function remapTaskId(task, oldId, newId) {
    task.id = newId;
    if (state.selectedId === oldId) state.selectedId = newId;
    if (state.dialogTaskId === oldId) state.dialogTaskId = newId;
    if (drag && drag.id === oldId) drag.id = newId;
    if (form && form.elements.id.value === oldId) form.elements.id.value = newId;
    document.querySelectorAll(taskSelector(oldId)).forEach((el) => { el.dataset.id = newId; });
  }

  function createOptimisticTask(payload) {
    const task = optimisticTask(payload);
    state.tasks.push(task);
    const request = post('/api/study-task-create', payload).then((json) => {
      const oldId = task.id;
      const live = {
        title: task.title, status: task.status, due: task.due, focusDay: task.focusDay,
        tags: task.tags, memo: task.memo, linkedCanvas: task.linkedCanvas,
      };
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
      } else {
        task[key] = patch[key];
      }
    });
  }

  function queueTaskPatch(task, patch) {
    if (!task) return Promise.resolve(null);
    applyLocalTaskPatch(task, patch);
    const seq = (taskUpdateSeq.get(task) || 0) + 1;
    taskUpdateSeq.set(task, seq);
    const previous = taskUpdateChains.get(task) || Promise.resolve();
    const request = previous.catch(() => undefined).then(async () => {
      await ensureTaskCreated(task);
      const json = await post('/api/study-task-update', Object.assign({ id: task.id }, patch));
      if (taskUpdateSeq.get(task) === seq) Object.assign(task, json.task);
      else {
        task.updatedAt = json.task.updatedAt || task.updatedAt;
        task.completedAt = json.task.completedAt || task.completedAt;
      }
      return task;
    });
    taskUpdateChains.set(task, request);
    request.finally(() => {
      if (taskUpdateChains.get(task) === request) taskUpdateChains.delete(task);
    }).catch(() => undefined);
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

  function canvasName(path) {
    if (!path) return '';
    const hit = state.canvases.find((canvas) => canvas.path === path);
    if (hit) return hit.title;
    return path.split(/[\\/]/).pop().replace(/\.canvas$/i, '');
  }

  function dueLabel(task) {
    if (!task.due) return '';
    if (task.due === today) return '今天';
    if (task.due < today && task.status !== 'done') return '已逾期';
    return task.due;
  }

  function taskCard(task, compact) {
    const card = document.createElement('div');
    card.className = 'study-task-card' + (compact ? ' compact' : '');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.id = task.id;
    const tags = (task.tags || []).slice(0, 3)
      .map((tag) => '<span class="study-chip">#' + escapeHtml(tag) + '</span>').join('');
    const due = dueLabel(task);
    const canvas = task.linkedCanvas
      ? '<span class="study-chip study-chip-canvas">画布 · ' + escapeHtml(canvasName(task.linkedCanvas)) + '</span>'
      : '';
    card.innerHTML = [
      '<strong class="study-task-title">' + escapeHtml(task.title) + '</strong>',
      '<div class="study-task-meta">',
      due ? '<span class="study-chip' + (due === '已逾期' ? ' overdue' : '') + '">' + escapeHtml(due) + '</span>' : '',
      canvas, tags,
      '</div>',
    ].join('');

    const titleEl = card.querySelector('.study-task-title');
    // 单击标题 → 就地改名（不冒泡到卡片，避免打开详情弹窗）
    titleEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (suppressRenameClickId === task.id) {
        suppressRenameClickId = '';
        return;
      }
      beginRename(card, task, titleEl);
    });

    // 右上角 × 快速删除：pointerdown 阻断冒泡，避免触发卡片拖拽/选中
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'study-task-del';
    delBtn.title = '删除任务';
    delBtn.setAttribute('aria-label', '删除任务');
    delBtn.textContent = '×';
    delBtn.addEventListener('pointerdown', (event) => { event.stopPropagation(); });
    delBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      trashTaskById(task.id, card);
    });
    card.appendChild(delBtn);

    // 今日卡(compact)与看板卡走同一套交互：单击=选中(onCardPointerUp)、双击=详情、标题单击=改名。
    // 拖拽只在卡片自己的容器内排序（看板列内 / 今日栏内），不跨列、不跨今日栏。
    card.addEventListener('pointerdown', (event) => onCardPointerDown(event, card, task));
    card.addEventListener('dblclick', (event) => {
      if (card.classList.contains('renaming')) return;
      if (event.target.closest('.study-task-title')) return;
      openDialog(task.id);
    });
    return card;
  }

  // —— 就地改名 ——
  function beginRename(card, task, titleEl) {
    if (card.classList.contains('renaming')) return;
    state.selectedId = task.id;
    applySelected();
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

  // —— 今日集合：只看手动「今日专注」标记，与截止日完全解耦；标记戳当天日期、隔天自动失效 ——
  function isToday(task) {
    return task.focusDay === today;
  }
  function todayTasks() {            // 含已完成（沉浸页进度/庆祝要用）
    return state.tasks.filter(isToday);
  }
  function todayActive() {          // 不含已完成（看板小卡列表用）
    return state.tasks.filter((task) => isToday(task) && task.status !== 'done');
  }

  function renderStats() {
    const todays = todayActive();
    setAnimatedNumber(document.querySelector('[data-role="stat-today"]'), todays.length);
    setAnimatedNumber(document.querySelector('[data-role="stat-doing"]'),
      state.tasks.filter((task) => task.status === 'doing').length);
    setAnimatedNumber(document.querySelector('[data-role="stat-done"]'),
      state.tasks.filter((task) => task.status === 'done').length);
    setAnimatedNumber(document.querySelector('[data-role="trash-count"]'), state.trash.length);
  }

  function setAnimatedNumber(el, value) {
    if (!el) return;
    const next = String(value);
    if (el.textContent === next) return;
    el.textContent = next;
    if (prefersReduced) return;
    el.classList.remove('number-pop');
    void el.offsetWidth;
    el.classList.add('number-pop');
    const previous = numberPopTimers.get(el);
    if (previous) clearTimeout(previous);
    numberPopTimers.set(el, setTimeout(() => {
      el.classList.remove('number-pop');
      numberPopTimers.delete(el);
    }, 280));
  }

  function renderToday() {
    const list = document.querySelector('[data-role="today-list"]');
    const tasks = todayActive();
    list.innerHTML = '';
    document.querySelector('[data-role="today-label"]').textContent = tasks.length
      ? tasks.length + ' 件今天专注'
      : '选中任务按 G 加入，或按 F 进入今日专注';
    if (!tasks.length) {
      list.innerHTML = '<div class="study-empty soft-enter">无</div>';
      return;
    }
    tasks.forEach((task) => {
      const card = taskCard(task, true);
      if (task.id === landingFlightId) card.classList.add('drag-source');
      list.appendChild(card);
    });
  }

  // —— 跨日顺延提醒（C 方案）：之前标记过专注、还没做完的，温柔提醒带到今天 ——
  // 候选 = focusDay 是过去某天 且 未完成（隔天它已自动回到原列）。「不用了」用 localStorage 打盹当天。
  function carryoverCandidates() {
    return state.tasks.filter((t) => t.focusDay && t.focusDay < today && t.status !== 'done');
  }
  function carryoverDismissed() {
    try { return localStorage.getItem('canvas:carryoverDismissed') === today; } catch (e) { return false; }
  }
  function renderCarryover() {
    const n = carryoverCandidates().length;
    const show = n > 0 && !carryoverDismissed();
    document.querySelectorAll('[data-role="carryover"]').forEach((el) => {
      if (show) {
        const timer = carryoverHideTimers.get(el);
        if (timer) clearTimeout(timer);
        carryoverHideTimers.delete(el);
        el.hidden = false;
        el.classList.remove('leaving');
        const txt = el.querySelector('[data-role="carryover-text"]');
        if (txt) txt.textContent = '之前还有 ' + n + ' 件专注没做完，接着做吗？';
      } else if (!el.hidden && !el.classList.contains('leaving')) {
        if (prefersReduced) {
          el.hidden = true;
        } else {
          el.classList.add('leaving');
          carryoverHideTimers.set(el, setTimeout(() => {
            el.hidden = true;
            el.classList.remove('leaving');
            carryoverHideTimers.delete(el);
          }, 220));
        }
      }
    });
  }
  function carryoverPull() {
    const cands = carryoverCandidates();
    if (!cands.length) return;
    cands.forEach((t) => { t.focusDay = today; });   // 滚到今天，重新进今日区
    render();
    Promise.all(cands.map((t) => queueTaskPatch(t, { focusDay: today })))
      .catch((err) => { showToast(err.message); refresh(); });
  }
  function carryoverDismiss() {
    try { localStorage.setItem('canvas:carryoverDismissed', today); } catch (e) {}   // 打盹今天，明天若还没做完再提
    renderCarryover();
  }

  // —— 学习页卡片 FLIP（借鉴《学习工作台》animateTaskMoves）——
  // 重渲染前记下每张卡旧位置，渲染后让它从旧位置「滑回」新位置：
  // ←/→ 搬列、G 键往返今日区、删除补位、快捷新建挤位，都自然滑动而不是「消失-渐显」。
  function captureCardRects() {
    const rects = new Map();
    document.querySelectorAll('.study-lane-list .study-task-card, .study-today-list .study-task-card').forEach((card) => {
      rects.set(card.dataset.id, card.getBoundingClientRect());
    });
    return rects;
  }

  function animateCardMoves(prevRects) {
    if (prefersReduced || !prevRects) return;
    let longest = 0;
    document.querySelectorAll('.study-lane-list .study-task-card, .study-today-list .study-task-card').forEach((card) => {
      const prev = prevRects.get(card.dataset.id);
      if (!prev) return;
      const now = card.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      const sx = prev.width / now.width;
      const sy = prev.height / now.height;
      const resized = Math.abs(sx - 1) > 0.012 || Math.abs(sy - 1) > 0.012;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !resized) return;
      const distance = Math.hypot(dx, dy);
      const duration = Math.max(260, Math.min(540, 250 + distance * 0.34));
      longest = Math.max(longest, duration);
      const lift = Math.min(12, Math.max(5, Math.abs(dx) * 0.018));   // 跨列时轻轻抬一下
      card.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(' + sx + ',' + sy + ')', transformOrigin: 'top left', offset: 0 },
        { transform: 'translate3d(' + (dx * 0.16) + 'px,' + (dy * 0.34 - lift) + 'px,0) scale(1.012)', transformOrigin: 'top left', offset: 0.68 },
        { transform: 'translate3d(0,0,0) scale(1)', transformOrigin: 'top left', offset: 1 },
      ], { duration, easing: 'cubic-bezier(0.18, 0.9, 0.24, 1)' });
    });
    if (longest) followSelectionRing(longest + 80);
  }

  // —— 删除离场：新增落入动画的反向版。真实卡立即离开布局，临时视觉卡独立淡出。 ——
  // 临时卡挂到 body，不会被连续删除时的列表重建掐断，也不会留下参与布局的残影。
  function animateCardRemoval(card) {
    const list = card.parentElement;
    if (!list || prefersReduced) { card.remove(); return; }
    // 余下卡记住当前视觉位置；真实卡马上移除，让列表立即补位。
    const siblings = Array.from(list.querySelectorAll('.study-task-card'))
      .filter((c) => c !== card);
    const before = new Map();
    siblings.forEach((c) => before.set(c, c.getBoundingClientRect()));
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.remove('is-selected', 'quick-enter', 'renaming');
    ghost.classList.add('study-task-exit-ghost');
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    card.remove();

    // 连删时后一次从余下卡当前视觉位置继续接管，不发生瞬移。
    siblings.forEach((c) => { const p = liveFlipAnims.get(c); if (p) p.cancel(); });
    siblings.forEach((c) => {
      const b = before.get(c);
      if (!b) return;
      const now = c.getBoundingClientRect();
      const dx = b.left - now.left;
      const dy = b.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const distance = Math.hypot(dx, dy);
      const duration = Math.max(200, Math.min(380, 190 + distance * 0.32));
      const anim = c.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
      liveFlipAnims.set(c, anim);
      anim.finished.catch(() => undefined).then(() => {
        if (liveFlipAnims.get(c) === anim) liveFlipAnims.delete(c);
      });
    });

    // 与 studyQuickEnter 反向呼应：轻轻向上收起，临时卡播完立即销毁。
    ghost.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-9px) scale(0.97)' },
    ], { duration: 230, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }).finished
      .catch(() => undefined).then(() => ghost.remove());
  }

  // 看板三列计数即时刷新（删除后不整列重建，单独同步徽标数字）
  function refreshLaneCounts() {
    STATUS.forEach((status) => {
      const el = document.querySelector('[data-role="count-' + status + '"]');
      if (!el) return;
      const n = state.tasks.filter((task) =>
        task.status === status && (status === 'done' || !isToday(task))).length;
      setAnimatedNumber(el, n);
    });
  }

  // —— 共享滑动选中环：不再给每张卡硬描边，而是一个浮层环滑到选中卡上（跨列也滑）——
  function updateSelectionRing() {
    const ring = selectionRing;
    if (!ring) return;
    // 拖拽中 / 落定飞行中：选中框一律隐藏，等卡片完全落地后由 revealLandingCard 在最终位淡入，
    // 避免选中框跟着幽灵卡飞、与还没落地的卡片错位。
    if ((drag && drag.active) || landingFlightId) { ring.classList.remove('show'); return; }
    if (selectionRingFlight) return; // 松手后由选中环自己的飞行动画接管，避免提前跳到落点
    const board = document.querySelector('.study-board');
    const card = (state.selectedId && board)
      ? board.querySelector('.study-task-card[data-id="' + state.selectedId + '"]')
      : null;
    if (!board || !card) { ring.classList.remove('show'); return; }
    const br = board.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const wasShown = ring.classList.contains('show');
    if (!wasShown) ring.style.transition = 'none';   // 首次出现：直接定位，不从旧处长距离滑
    ring.style.width = cr.width + 'px';
    ring.style.height = cr.height + 'px';
    ring.style.transform = 'translate(' + (cr.left - br.left) + 'px,' + (cr.top - br.top) + 'px)';
    if (!wasShown) { void ring.offsetWidth; ring.style.transition = ''; }
    ring.classList.add('show');
  }

  function positionSelectionRingAtRect(rect) {
    const ring = selectionRing;
    const board = document.querySelector('.study-board');
    if (!ring || !board || !rect) return;
    const br = (drag && drag.active && drag.boardRect) ? drag.boardRect : board.getBoundingClientRect();
    const scale = rect.scale || 1;
    const width = rect.width * scale;
    const height = rect.height * scale;
    ring.style.width = width + 'px';
    ring.style.height = height + 'px';
    ring.style.transform = 'translate3d(' + (rect.left - br.left - (width - rect.width) / 2) + 'px,'
      + (rect.top - br.top - (height - rect.height) / 2) + 'px,0)';
    ring.classList.add('show', 'tracking');
  }

  function flySelectionRingToRect(rect, duration, middleRect) {
    const ring = selectionRing;
    const board = document.querySelector('.study-board');
    if (!ring || !board || !rect || prefersReduced) return;
    if (selectionRingFlight) selectionRingFlight.cancel();
    const br = board.getBoundingClientRect();
    const start = ring.style.transform || getComputedStyle(ring).transform;
    const target = 'translate3d(' + (rect.left - br.left) + 'px,' + (rect.top - br.top) + 'px,0)';
    const startWidth = ring.getBoundingClientRect().width;
    const startHeight = ring.getBoundingClientRect().height;
    ring.style.width = rect.width + 'px';
    ring.style.height = rect.height + 'px';
    ring.classList.add('show', 'tracking');
    const frames = [{ transform: start, width: startWidth + 'px', height: startHeight + 'px' }];
    if (middleRect) {
      const middleScale = middleRect.scale || 1;
      const middleWidth = rect.width * middleScale;
      const middleHeight = rect.height * middleScale;
      frames.push({
        transform: 'translate3d(' + (middleRect.left - br.left - (middleWidth - rect.width) / 2) + 'px,'
          + (middleRect.top - br.top - (middleHeight - rect.height) / 2) + 'px,0)',
        width: middleWidth + 'px',
        height: middleHeight + 'px',
        offset: 0.68,
      });
    }
    frames.push({ transform: target, width: rect.width + 'px', height: rect.height + 'px' });
    const animation = ring.animate(frames, {
      duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards',
    });
    selectionRingFlight = animation;
    animation.finished.catch(() => undefined).then(() => {
      if (selectionRingFlight !== animation) return;
      ring.style.transform = target;
      animation.cancel();
      selectionRingFlight = null;
      ring.classList.remove('tracking');
      updateSelectionRing(); // 幽灵卡移除后再硬校准到真实卡
    });
  }

  // 卡片、栏位和滚动容器都有独立动画。环在动画期间逐帧复位，避免只记住中途坐标。
  function followSelectionRing(duration) {
    if (!selectionRing) return;
    selectionFollowUntil = Math.max(selectionFollowUntil, performance.now() + (duration || 0));
    selectionRing.classList.add('tracking');
    if (selectionFollowRaf) return;
    function frame(now) {
      selectionFollowRaf = 0;
      updateSelectionRing();
      if (now < selectionFollowUntil) {
        selectionFollowRaf = requestAnimationFrame(frame);
      } else {
        selectionRing.classList.remove('tracking');
        updateSelectionRing(); // 动画收束后再硬校准一次
      }
    }
    selectionFollowRaf = requestAnimationFrame(frame);
  }

  function dismissArchivedSelection(archivedIds) {
    if (!state.selectedId || !archivedIds.has(state.selectedId)) return Promise.resolve();
    state.selectedId = '';
    selectionFollowUntil = 0;
    if (selectionFollowRaf) cancelAnimationFrame(selectionFollowRaf);
    selectionFollowRaf = 0;
    if (selectionRingFlight) selectionRingFlight.cancel();
    selectionRingFlight = null;
    if (!selectionRing) return Promise.resolve();
    selectionRing.classList.remove('tracking');
    selectionRing.classList.add('dismissing');
    selectionRing.classList.remove('show');
    if (prefersReduced) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, 240));
  }

  function renderBoard() {
    STATUS.forEach((status) => {
      const list = document.querySelector('[data-role="lane-' + status + '"]');
      // 待办/进行中列隐藏「今日专注」任务（它们端到今日区了）；已完成列照常显示
      const tasks = state.tasks.filter((task) =>
        task.status === status && (status === 'done' || !isToday(task)));
      setAnimatedNumber(document.querySelector('[data-role="count-' + status + '"]'), tasks.length);
      list.innerHTML = '';
      if (!tasks.length) {
        list.innerHTML = '<p class="study-lane-empty soft-enter">暂无任务</p>';
      } else {
        tasks.forEach((task) => {
          const card = taskCard(task, false);
          if (task.id === landingFlightId || (drag && drag.active && task.id === drag.id)) {
            card.classList.add('drag-source');
          }
          list.appendChild(card);
        });
      }
    });
    if (state.selectedId && !findTask(state.selectedId)) state.selectedId = '';
    applySelected();   // 末尾同步定位选中环（此刻卡片在最终布局位，尚未加 FLIP 偏移）
  }

  // ============ 极简清单视图（mode=list；方案 A：只勾完成 / 双击改名 / + 新建）============
  // 分组照搬看板那套（今日/待办/进行中/已完成），不按截止日重排；只是换成干净的英文清单。
  function renderList() {
    const host = document.querySelector('[data-role="study-list"]');
    if (!host) return;
    const groups = [
      { status: 'today', label: 'Today',       match: (t) => isToday(t) && t.status !== 'done' },
      { status: 'todo', label: 'To Do',       match: (t) => t.status === 'todo' && !isToday(t), add: true },
      { status: 'doing', label: 'In Progress', match: (t) => t.status === 'doing' && !isToday(t) },
      { status: 'done', label: 'Done',        match: (t) => t.status === 'done' },
    ];
    host.innerHTML = '';
    groups.forEach((group) => {
      const tasks = state.tasks.filter(group.match);
      if (!tasks.length && !group.add) return;   // 空分组不显示大标题；To Do 例外，留着放「+」
      const section = document.createElement('section');
      section.className = 'study-list-group';
      section.dataset.status = group.status;
      const head = document.createElement('div');
      head.className = 'study-list-head';
      head.innerHTML = '<h2>' + group.label + '</h2>'
        + (tasks.length ? '<span class="study-list-count">' + tasks.length + '</span>' : '');
      if (group.add) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'study-list-add';
        addBtn.title = '新建任务';
        addBtn.setAttribute('aria-label', '新建任务');
        addBtn.textContent = '+';
        addBtn.addEventListener('click', (event) => { event.stopPropagation(); listQuickAdd(); });
        head.appendChild(addBtn);
      }
      section.appendChild(head);
      tasks.forEach((task) => section.appendChild(taskRow(task)));
      host.appendChild(section);
    });
  }

  function taskRow(task) {
    const row = document.createElement('div');
    row.className = 'study-list-row' + (task.status === 'done' ? ' is-done' : '');
    row.dataset.id = task.id;
    const checked = task.status === 'done';
    row.innerHTML = '<button type="button" class="study-list-check' + (checked ? ' on' : '')
      + '" aria-label="标记完成">' + (checked ? '✓' : '') + '</button>'
      + '<span class="study-list-title">' + escapeHtml(task.title) + '</span>';
    // 只点左边小方框 = 完成（再点 = 取消完成）；阻断冒泡，不触发改名
    row.querySelector('.study-list-check').addEventListener('click', (event) => {
      event.stopPropagation();
      moveTask(task.id, task.status === 'done' ? 'todo' : 'done');
    });
    // 双击行 = 就地改名，复用看板那套 beginRename
    const titleEl = row.querySelector('.study-list-title');
    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('.study-list-check')) return;
      if (row.classList.contains('renaming')) return;
      beginRename(row, task, titleEl);
    });
    return row;
  }

  function listQuickAdd() {
    if (!studyLoaded) {
      ensureStudyLoaded().then((loaded) => { if (loaded) listQuickAdd(); });
      return;
    }
    const task = createOptimisticTask({ title: '未命名', status: 'todo' });
    render();
    scheduleStudyReorder();
    const row = document.querySelector('.study-list ' + taskSelector(task.id));
    if (row) {
      row.classList.add('quick-enter');
      setTimeout(() => row.classList.remove('quick-enter'), 300);
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
    const rects = new Map();
    if (!list) return rects;
    list.querySelectorAll(selector).forEach((item) => {
      if (item.dataset.id) rects.set(item.dataset.id, item.getBoundingClientRect());
    });
    return rects;
  }

  function animateListMoves(list, selector, prevRects) {
    if (prefersReduced || !list || !prevRects || !prevRects.size) return;
    list.querySelectorAll(selector).forEach((item) => {
      const prev = prevRects.get(item.dataset.id);
      if (!prev) return;
      const now = item.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const duration = Math.max(190, Math.min(360, 180 + Math.hypot(dx, dy) * 0.28));
      item.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
    });
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

  function render() {
    applyViewMode();
    if (viewMode === 'list') {
      const listHost = document.querySelector('[data-role="study-list"]');
      const prevListRects = captureListRects(listHost, '.study-list-row');
      renderList();
      renderTrash();
      if (focusOpen) renderFocus();
      requestAnimationFrame(() => animateListMoves(listHost, '.study-list-row', prevListRects));
      return;
    }
    const prevRects = suppressFlip ? null : captureCardRects();
    renderStats();
    renderToday();
    renderBoard();
    renderTrash();
    renderCarryover();
    if (focusOpen) renderFocus();   // 沉浸页打开时同步刷新
    if (prevRects) requestAnimationFrame(() => animateCardMoves(prevRects));
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
        button.addEventListener('click', () => gotoCanvas(button.dataset.canvasPath, false));
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
      button.addEventListener('click', () => gotoCanvas(button.dataset.canvasPath, false));
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
      if (starInstance && starInstance.setActive) starInstance.setActive(cadenceShown);
      // 每次翻进活跃页都重播生长：重新武装进场（节点先隐形预置），由引擎的可见性自然触发——
      // 星图在视野内就地长出，仍在折叠线以下则等你滚动到它再长。首访时实例尚未建好（下方加载后挂载，
      // 其自带 intro 同样由可见性触发），故这里只重播已存在的实例。
      if (cadenceShown && starInstance && starInstance.replayIntro) starInstance.replayIntro();
      if (cadenceShown && (!activityPayload || activityDirty)) queueActivityLoad();
    },
    awaitReady() {
      if (activityLoadPromise) return activityLoadPromise;
      if (activityPayload && !activityDirty) return Promise.resolve(true);
      return queueActivityLoad();
    },
    isReady() {
      return !!(activityPayload && !activityDirty);
    },
  };

  function fillCanvasOptions(value) {
    canvasSelect.innerHTML = '<option value="">不关联画布</option>';
    state.canvases.forEach((canvas) => {
      const option = document.createElement('option');
      option.value = canvas.path;
      option.textContent = canvas.title;
      canvasSelect.appendChild(option);
    });
    if (value && !state.canvases.some((canvas) => canvas.path === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = '已移动或外部画布 · ' + canvasName(value);
      canvasSelect.appendChild(option);
    }
    canvasSelect.value = value || '';
    syncCanvasButtons();
  }

  function syncCanvasButtons() {
    // 关联锁定：任务一旦「已保存」关联某画布，就不可在详情里改/解除/再新建（真正的 1:1 绑定）。
    // 以任务持久化的 linkedCanvas 为准，而非下拉框当前值——这样未保存前仍可自由挑选。
    const task = findTask(state.dialogTaskId);
    const locked = !!(task && task.linkedCanvas);
    canvasSelect.disabled = locked;
    const createBtn = document.querySelector('[data-action="create-canvas"]');
    if (createBtn) createBtn.disabled = locked;
    document.querySelector('[data-action="open-canvas"]').disabled = !canvasSelect.value;
  }

  function openDialog(id) {
    const task = findTask(id);
    if (!task) return;
    state.dialogTaskId = id;
    form.elements.id.value = task.id;
    form.elements.title.value = task.title;
    form.elements.status.value = task.status;
    form.elements.due.value = task.due || '';
    form.elements.tags.value = (task.tags || []).join(', ');
    form.elements.memo.value = task.memo || '';
    fillCanvasOptions(task.linkedCanvas);
    renderTaskFocusSummary(task);
    dialog.hidden = false;
    requestAnimationFrame(() => dialog.classList.add('show'));
    form.elements.title.focus();
    form.elements.title.select();
  }

  function renderTaskFocusSummary(task) {
    const totalEl = document.querySelector('[data-role="task-focus-total"]');
    const recentEl = document.querySelector('[data-role="task-focus-recent"]');
    const summary = state.focusByTask[task.id] || { durationSec: 0, count: 0 };
    if (totalEl) {
      totalEl.textContent = summary.count
        ? focusDurationLabel(summary.durationSec) + ' · ' + summary.count + ' 段'
        : '尚无记录';
    }
    if (!recentEl) return;
    const recent = state.focusSessions.filter((session) => session.taskId === task.id).slice(0, 4);
    recentEl.innerHTML = recent.length ? recent.map((session) => {
      const main = session.outcome || session.goal || '这一段没有留下文字';
      const prefix = session.outcome ? '成果' : (session.goal ? '目标' : '记录');
      return '<article><span>' + escapeHtml(String(session.day || '').slice(5))
        + ' · ' + focusDurationLabel(session.durationSec) + '</span><p><b>'
        + prefix + '：</b>' + escapeHtml(main) + '</p></article>';
    }).join('') : '<p class="study-task-focus-empty">从专注页绑定这个任务后，记录会出现在这里。</p>';
  }

  function closeDialog() {
    dialog.classList.remove('show');
    state.dialogTaskId = '';
    setTimeout(() => { dialog.hidden = true; }, 180);
  }

  function formPayload() {
    return {
      id: form.elements.id.value,
      title: form.elements.title.value.trim() || '未命名任务',
      status: form.elements.status.value,
      due: form.elements.due.value,
      tags: form.elements.tags.value,
      memo: form.elements.memo.value,
      linkedCanvas: form.elements.linkedCanvas.value,
    };
  }

  async function saveDialog(options) {
    const payload = formPayload();
    const task = findTask(payload.id);
    if (taskSaveButton) {
      taskSaveButton.disabled = true;
      taskSaveButton.classList.add('is-saving');
      taskSaveButton.textContent = '保存中';
    }
    try {
      const saved = await queueTaskPatch(task, {
        title: payload.title, status: payload.status, due: payload.due,
        tags: payload.tags, memo: payload.memo, linkedCanvas: payload.linkedCanvas,
      });
      render();
      if (!(options && options.keepOpen)) closeDialog();
      return saved;
    } finally {
      if (taskSaveButton) {
        taskSaveButton.disabled = false;
        taskSaveButton.classList.remove('is-saving');
        taskSaveButton.textContent = '保存';
      }
    }
  }

  async function createTask() {
    if (!studyLoaded && !(await ensureStudyLoaded())) return;
    try {
      const json = await post('/api/study-task-create', { title: '未命名任务', status: 'todo' });
      state.tasks.push(json.task);
      render();
      openDialog(json.task.id);
    } catch (error) {
      showToast(error.message);
    }
  }

  function quickAdd(status, button) {
    if (!studyLoaded) {
      ensureStudyLoaded().then((loaded) => { if (loaded) quickAdd(status, button); });
      return;
    }
    const task = createOptimisticTask({ title: '未命名', status: status || 'todo' });
    state.selectedId = task.id;
    render();
    scheduleStudyReorder();
    if (button) {
      button.classList.remove('just-added');
      void button.offsetWidth;
      button.classList.add('just-added');
      setTimeout(() => button.classList.remove('just-added'), 240);
    }
    // 新任务只进入选中态；用户主动点标题时才开始改名。
    const card = document.querySelector('.study-lane-list ' + taskSelector(task.id));
    if (card) {
      card.classList.add('quick-enter');
      setTimeout(() => card.classList.remove('quick-enter'), 300);
      card.focus({ preventScroll: true });
    }
  }

  // —— 选中任务 + 键盘导航 ——
  function applySelected() {
    // 看板卡 + 今日卡都参与选中高亮。看板卡另有浮动选中环；今日卡在 study-board 外，
    // 环无法跨容器定位，故今日卡用自带的 .is-selected 描边（见 styles.css）。
    document.querySelectorAll('.study-lane-list .study-task-card, .study-today-list .study-task-card').forEach((card) =>
      card.classList.toggle('is-selected', !!state.selectedId && card.dataset.id === state.selectedId));
    updateSelectionRing();
    followSelectionRing(520);
  }

  function selectTask(id, scroll) {
    state.selectedId = id || '';
    applySelected();
    if (scroll && id) {
      const card = document.querySelector('.study-lane-list [data-id="' + id + '"]');
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function tasksInStatus(status) {
    return state.tasks.filter((task) => task.status === status);
  }

  // ↑/↓：在选中任务所在列内上下移动高亮
  function moveSelectionVertical(dir) {
    const sel = findTask(state.selectedId);
    const status = sel ? sel.status : 'todo';
    const list = tasksInStatus(status);
    if (!list.length) return;
    const idx = list.findIndex((task) => task.id === state.selectedId);
    if (idx < 0) { selectTask(list[0].id, true); return; }
    const next = (idx + dir + list.length) % list.length;
    selectTask(list[next].id, true);
  }

  // ←/→：把选中任务搬到相邻列（待办↔进行中↔已完成），保留选中并回弹
  function moveSelectedTaskHorizontal(dir) {
    const sel = findTask(state.selectedId);
    if (!sel) {
      const first = tasksInStatus('todo')[0] || state.tasks[0];
      if (first) selectTask(first.id, true);
      return;
    }
    const cur = COLUMN_ORDER.indexOf(sel.status);
    const ni = cur + dir;
    if (ni < 0 || ni >= COLUMN_ORDER.length) return; // 到头不绕回
    moveTask(sel.id, COLUMN_ORDER[ni]);   // FLIP 让卡片滑到新列，选中环随之滑过去
  }

  // G 键：选中的看板任务 → 加入今日专注；选中的今日任务 → 放回「待办」（清专注+设 todo，风险小）
  function toggleSelectedTodayFocus() {
    const task = findTask(state.selectedId);
    if (!task) return;
    if (isToday(task)) {
      task.focusDay = '';
      task.status = 'todo';
      render();
      queueTaskPatch(task, { focusDay: '', status: 'todo' })
        .catch((error) => { showToast(error.message); refresh(); });
      showToast('已放回待办');
    } else {
      task.focusDay = today;
      render();
      queueTaskPatch(task, { focusDay: today })
        .catch((error) => { showToast(error.message); refresh(); });
      showToast('已加入今日专注');
    }
    applySelected();   // 任务在看板↔今日间移动后，选中高亮跟着它
  }

  // —— 指针拖拽（带惯性倾斜 + 落入回弹）——
  function onCardPointerDown(event, card, task) {
    if (event.button !== 0) return;
    if (card.classList.contains('renaming')) return;
    event.preventDefault();                                // 卡片拖拽不触发浏览器原生文字框选
    const rect = card.getBoundingClientRect();
    const board = document.querySelector('.study-board');
    const originList = card.parentNode;                    // 卡片只在自己所属的容器内排序
    drag = {
      id: task.id, task, card, ghost: null,
      pointerId: event.pointerId, active: false,
      originList,                                          // 待办/进行中/已完成列 或 今日栏
      horizontal: !!(originList && originList.classList
        && originList.classList.contains('study-today-list')),  // 今日栏横向、看板列纵向
      startX: event.clientX, startY: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      width: rect.width, height: rect.height,
      originLeft: rect.left, originTop: rect.top,
      ghostLeft: rect.left, ghostTop: rect.top,
      boardRect: board ? board.getBoundingClientRect() : null,
      targetRaf: 0, pendingX: event.clientX, pendingY: event.clientY,
    };
    // 不在此处 setPointerCapture——否则浏览器会把随后的 click 重定向到卡片本身，标题的
    // 单击改名监听就收不到事件。改在 activateDrag（确实越过拖拽阈值）里再捕获指针。
    window.addEventListener('pointermove', onCardPointerMove);
    window.addEventListener('pointerup', onCardPointerUp);
  }

  function activateDrag() {
    try { drag.card.setPointerCapture(drag.pointerId); } catch (e) {}  // 确实开始拖动后才捕获指针
    const ghost = drag.card.cloneNode(true);
    ghost.classList.add('study-task-ghost');
    ghost.classList.remove('is-selected', 'quick-enter', 'drag-source');
    ghost.style.animation = 'none'; // 克隆卡只走幽灵层动画，不继承原卡尚未收束的入场动画
    ghost.style.width = drag.width + 'px';
    ghost.style.height = drag.height + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.card.classList.add('drag-source');
    document.body.classList.add('study-dragging');
    if (selectionRing) selectionRing.classList.remove('show'); // 起拖即藏选中框，落地后再淡入
    drag.active = true;
    state.selectedId = drag.id;
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges(); // 清掉超过拖拽阈值前可能产生的残留选区
    // 清掉各列「暂无任务」占位文本：实时让位只在卡片之间移动占位卡，落定后整体 render 会还原
    document.querySelectorAll('.study-lane-list .study-lane-empty').forEach((el) => el.remove());
    positionGhost(drag.startX, drag.startY);
  }

  function positionGhost(x, y) {
    const tx = x - drag.offsetX;
    const ty = y - drag.offsetY;
    drag.ghostLeft = tx;
    drag.ghostTop = ty;
    drag.ghost.style.transform =
      'translate3d(' + tx + 'px,' + ty + 'px,0) scale(1.035)';
    drag.ghost.dataset.dragLeft = String(tx);
    drag.ghost.dataset.dragTop = String(ty);
    // 选中框不再跟随幽灵卡飞行（见 updateSelectionRing）：避免与落定卡错位
  }

  // 列内排序落定：按某容器当前 DOM 顺序，把其中这些任务在 state.tasks 里重排成同样的相对
  // 顺序，其余任务原位不动。纯列内排序——status / 今日标记都不变，无需改任何字段。
  function reorderTasksByDom(list) {
    if (!list) return;
    const domIds = Array.from(list.querySelectorAll('.study-task-card')).map((c) => c.dataset.id);
    const inGroup = new Set(domIds);
    const ordered = domIds.map((id) => findTask(id)).filter(Boolean);
    let gi = 0;
    state.tasks = state.tasks.map((t) => (inGroup.has(t.id) ? ordered[gi++] : t));
  }

  // —— 实时让位：只移动占位节点 + 复用节点跑 FLIP，绝不重建 DOM ——
  // 占位卡（被拖卡本身，隐形）作为「洞」，用 insertBefore 在本列已有卡之间移动；其它卡读
  // 「当前视觉位置」接着滑，节点全程复用，物理上不再瞬移。

  // 只在「卡片自己所属的容器」里算插入点（不跨列、不跨今日栏）。横向今日栏按 x 中线、
  // 纵向看板列按 y 中线；指针落到容器外也夹取到首/末位，保证卡片始终留在本列。
  function computeInsertPoint(x, y) {
    const list = drag.originList;
    if (!list) return null;
    const cards = Array.from(list.querySelectorAll('.study-task-card')).filter((c) => c !== drag.card);
    let beforeNode = null;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const past = drag.horizontal ? (x < r.left + r.width / 2) : (y < r.top + r.height / 2);
      if (past) { beforeNode = cards[i]; break; }   // 过卡片中线才让位
    }
    return { list, beforeNode };
  }

  // 可中断 FLIP：先记各卡「当前视觉位置」→ mutate 移动占位卡 → 取消在飞的旧动画（清掉残留
  // transform，读到干净的新布局位）→ 从视觉位平滑滑到新布局位。节点全程复用，快拖也不掐断。
  function flipBoardReorder(mutate) {
    if (prefersReduced) { mutate(); return; }
    const cards = Array.from((drag.originList || document).querySelectorAll('.study-task-card'));
    const before = new Map();
    cards.forEach((c) => before.set(c, c.getBoundingClientRect()));   // 含在飞 transform=视觉位
    mutate();
    cards.forEach((c) => { const p = liveFlipAnims.get(c); if (p) p.cancel(); }); // 统一清残留 transform
    cards.forEach((c) => {
      if (c === drag.card) return;                 // 占位卡隐形，不参与让位动画
      const b = before.get(c);
      if (!b) return;
      const now = c.getBoundingClientRect();        // 取消旧动画后 = 干净新布局位
      const dx = b.left - now.left;
      const dy = b.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const distance = Math.hypot(dx, dy);
      const duration = Math.max(190, Math.min(360, 180 + distance * 0.3));
      const anim = c.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
      liveFlipAnims.set(c, anim);
      anim.finished.catch(() => undefined).then(() => {
        if (liveFlipAnims.get(c) === anim) liveFlipAnims.delete(c);
      });
    });
  }

  // 实时让位：把占位卡（被拖卡本身）移到本列指针所指插入点；位置没变则跳过
  function liveReorderTo(x, y) {
    const ins = computeInsertPoint(x, y);
    if (!ins) return;
    if (drag.card.parentNode === ins.list && drag.card.nextElementSibling === ins.beforeNode) return; // 已在该位
    flipBoardReorder(() => {
      const empty = ins.list.querySelector('.study-lane-empty');
      if (empty) empty.remove();
      ins.list.insertBefore(drag.card, ins.beforeNode);
    });
  }

  // 指针可能一帧触发多次：幽灵卡即时跟手，布局读取与让位排序合并到每帧最多一次。
  // 只做本列内让位——不再检测跨列 / 今日栏落入。
  function applyDragTarget(x, y) {
    if (!drag) return;
    liveReorderTo(x, y);
  }

  function scheduleDragTarget(x, y) {
    drag.pendingX = x;
    drag.pendingY = y;
    if (drag.targetRaf) return;
    drag.targetRaf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.targetRaf = 0;
      applyDragTarget(drag.pendingX, drag.pendingY);
    });
  }

  function onCardPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      activateDrag();
    }
    positionGhost(event.clientX, event.clientY);
    scheduleDragTarget(event.clientX, event.clientY);
  }

  // 幽灵卡飞向某元素位置再淡出（el 为空则原地淡出）
  function flyGhostTo(ghost, el, done) {
    if (!ghost) {
      if (done) done();
      return 0;
    }
    if (el) {
      const r = el.getBoundingClientRect();
      const gr = ghost.getBoundingClientRect();
      const startLeft = Number(ghost.dataset.dragLeft);
      const startTop = Number(ghost.dataset.dragTop);
      const fromLeft = Number.isFinite(startLeft) ? startLeft : gr.left;
      const fromTop = Number.isFinite(startTop) ? startTop : gr.top;
      const dx = r.left - fromLeft;
      const dy = r.top - fromTop;
      const distance = Math.hypot(dx, dy);
      const duration = Math.max(400, Math.min(680, 350 + distance * 0.19));
      const start = ghost.style.transform || ('translate3d(' + fromLeft + 'px,' + fromTop + 'px,0) scale(1.035)');
      const middleRect = { left: fromLeft + dx * 0.68, top: fromTop + dy * 0.68, scale: 1.018 };
      const middle = 'translate3d(' + middleRect.left + 'px,' + middleRect.top + 'px,0) scale(1.018)';
      const target = 'translate3d(' + r.left + 'px,' + r.top + 'px,0) scale(1)';
      // 幽灵卡尺寸随飞行渐变到落定卡尺寸：今日卡(compact 240px)飞进满宽列时不再"啪"地跳变；
      // 同列/跨列普通拖拽尺寸本就一致，此处为恒等变换、无副作用。
      const startW = parseFloat(ghost.style.width) || gr.width;
      const startH = parseFloat(ghost.style.height) || gr.height;
      const midW = startW + (r.width - startW) * 0.66;
      const midH = startH + (r.height - startH) * 0.66;
      const animation = ghost.animate([
        { transform: start, opacity: 1, width: startW + 'px', height: startH + 'px', offset: 0 },
        { transform: middle, opacity: 1, width: midW + 'px', height: midH + 'px', offset: 0.66 },
        { transform: target, opacity: 1, width: r.width + 'px', height: r.height + 'px', offset: 1 },
      ], { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' });
      const finish = () => {
        ghost.remove();
        if (done) done();
      };
      animation.finished.catch(() => undefined).then(finish);
      return duration;
    } else {
      const gr = ghost.getBoundingClientRect();
      const start = ghost.style.transform || ('translate3d(' + gr.left + 'px,' + gr.top + 'px,0) scale(1.035)');
      const animation = ghost.animate([
        { transform: start, opacity: 1, offset: 0 },
        { transform: 'translate3d(' + gr.left + 'px,' + (gr.top - 3) + 'px,0) scale(0.985)', opacity: 0, offset: 1 },
      ], { duration: 230, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
      animation.finished.catch(() => undefined).then(() => {
        ghost.remove();
        if (done) done();
      });
      return 230;
    }
  }

  // 单一拖动层：幽灵卡移除后真卡才接管，彻底避免两张卡重叠形成残影。
  function revealLandingCard(card) {
    landingFlightId = '';
    if (!card) return;
    card.classList.remove('drag-source');
    updateSelectionRing();
    followSelectionRing(140);
  }

  function onCardPointerUp(event) {
    if (!drag) return;
    window.removeEventListener('pointermove', onCardPointerMove);
    window.removeEventListener('pointerup', onCardPointerUp);
    if (drag.active) {
      if (drag.targetRaf) cancelAnimationFrame(drag.targetRaf);
      drag.targetRaf = 0;
      applyDragTarget(event.clientX, event.clientY); // 快速甩动松手时，最后一个落点也必须生效
    }
    const d = drag;
    drag = null;
    try { d.card.releasePointerCapture(d.pointerId); } catch (e) {}

    if (!d.active) {            // 没移动 → 单击：选中高亮（今日卡与看板卡一致；双击才开详情）
      selectTask(d.id);
      return;
    }

    document.body.classList.remove('study-dragging');
    state.selectedId = d.id;    // 落定后保持选中
    suppressRenameClickId = d.id;
    setTimeout(() => {
      if (suppressRenameClickId === d.id) suppressRenameClickId = '';
    }, 0);

    // 列内落定：占位卡此刻已在本列目标位（实时让位只动 DOM、没动数据），按它在本列的
    // DOM 顺序把数据排好 → 整体 render 物化落定卡 → 幽灵卡滑入显形。状态/今日标记都不变。
    liveFlipAnims.forEach((anim) => anim.cancel());   // 收掉在飞的让位动画，避免与 render 打架
    liveFlipAnims.clear();
    landingFlightId = d.id;
    reorderTasksByDom(d.originList);
    render();
    const placeholder = (d.originList && d.originList.querySelector(taskSelector(d.id)))
      || document.querySelector(taskSelector(d.id));
    flyGhostTo(d.ghost, placeholder, () => revealLandingCard(placeholder));
    applySelected();            // 选中环回到落定卡
    scheduleStudyReorder();     // 列内顺序持久化（状态未变，无需发 update）
  }

  function moveTask(id, status) {
    const task = findTask(id);
    if (!task || task.status === status) return;
    const old = task.status;
    task.status = status;
    render();
    queueTaskPatch(task, { status }).catch((error) => {
      task.status = old;
      render();
      showToast(error.message);
    });
  }

  // 删除任务（移到学习回收站）。若关联了画布：入回收站即「解除绑定」，并把画布一并移入
  // 画布回收站（可恢复、非物理删除）。任务与画布从此各自独立，恢复互不牵连——风险低。
  function trashTaskById(id, card) {
    const task = findTask(id);
    if (!task) return;
    const canvasPath = task.linkedCanvas || '';
    const index = state.tasks.indexOf(task);
    if (index < 0) return;

    // 与快速创建一致：界面先响应，后台随后按顺序持久化。连续点 × 时每张卡独立收起。
    const trashedTask = Object.assign({}, task, { linkedCanvas: '' });
    state.tasks.splice(index, 1);
    state.trash.unshift({ task: trashedTask, deletedAt: new Date().toISOString() });
    trashEnterId = task.id;
    if (state.selectedId === id) state.selectedId = '';
    if (card && !prefersReduced) {
      const button = card.querySelector('.study-task-del');
      if (button) button.disabled = true;
      // 离场卡淡出 + 余下卡即时 FLIP 滑动补位（绝不整列重建，故不会掐断在飞动画 → 无残影）。
      animateCardRemoval(card);
      // 计数 / 统计 / 回收站即时同步；离场动画播完后再做一次「对账式」render——届时 DOM
      // 已与 state 一致（卡片就地滑到位、离场卡已移除），重建无缝、FLIP 为空操作。
      refreshLaneCounts();
      renderTrash();
      clearTimeout(deleteFlushTimer);
      deleteFlushTimer = setTimeout(() => { deleteFlushTimer = null; render(); }, 300);
    } else {
      render();
    }
    renderStats();
    updateSelectionRing();

    trashChain = trashChain.catch(() => undefined).then(async () => {
      await ensureTaskCreated(task);
      trashedTask.id = task.id; // 刚快速创建又立刻删除时，回收站记录同步后端分配的真实 id
      const pendingUpdate = taskUpdateChains.get(task);
      if (pendingUpdate) await pendingUpdate.catch(() => undefined);
      if (canvasPath) {
        // 解除绑定：先清掉任务上的关联，回收站里的任务不再指向任何画布
        await post('/api/study-task-update', { id: task.id, linkedCanvas: '' });
      }
      await post('/api/study-task-trash', { id: task.id });
      if (canvasPath) {
        // 关联画布移入画布回收站（canvases/回收站/，连同 .assets，可在画布回收站恢复）
        post('/api/trash', { path: canvasPath }).then(() => {
          state.canvases = state.canvases.filter((canvas) => canvas.path !== canvasPath);
        }).catch((error) => showToast('任务已删除，但关联画布移入回收站失败：' + error.message));
      }
    }).catch((error) => {
      showToast('删除任务失败，正在恢复：' + error.message);
      refresh();
    });
    showToast(canvasPath ? '任务与关联画布将移到回收站' : '任务已移到回收站');
  }

  function trashTask() {            // 弹窗「移到回收站」按钮
    const id = state.dialogTaskId;
    if (!id) return;
    closeDialog();
    trashTaskById(id);
  }

  async function restoreTask(id) {
    lockTrashItem(id, true);
    try {
      const json = await post('/api/study-task-restore', { id });
      animateDetachedExit(document.querySelector('.study-trash-item' + taskSelector(id)), 'study-trash-exit-ghost');
      state.trash = state.trash.filter((entry) => entry.task.id !== id);
      state.tasks.push(json.task);
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
    if (!window.confirm('永久移除这条任务？此操作不可恢复（关联画布已在删除时单独进入画布回收站）。')) return;
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

  function gotoCanvas(path, fresh) {
    if (!path) return;
    document.body.classList.add('canvas-route-leaving');
    try { sessionStorage.setItem('canvas:route-from-start', '1'); } catch (e) {}
    setTimeout(() => {
      window.location.href = 'editor.html?file=' + encodeURIComponent(path)
        + '&from=study' + (fresh ? '&fresh=1' : '');
    }, 150);
  }

  async function createCanvas() {
    const task = findTask(state.dialogTaskId);
    if (!task) return;
    try {
      await saveDialog({ keepOpen: true });
      await ensureTaskCreated(task);
      const json = await post('/api/study-task-create-canvas', { id: task.id });
      const index = state.tasks.indexOf(task);
      if (index >= 0) Object.assign(state.tasks[index], json.task);
      gotoCanvas(json.path, true);
    } catch (error) {
      showToast(error.message);
    }
  }

  function openCanvas() {
    const path = canvasSelect.value;
    if (path) gotoCanvas(path, false);
  }

  function resetCanvasPanelMode() {
    try {
      const shell = canvasFrame.contentWindow && canvasFrame.contentWindow.EditorShell;
      if (shell && typeof shell.setMode === 'function') shell.setMode('normal');
    } catch (e) {}
  }

  // —— 迷你画布浮窗（Tab 滑出，内嵌 editor.html?embed=1）——
  // 任务↔画布强关联：选中任务按 Tab，没画布就自动建一张并关联（不跳转），有就直接载入。
  async function openCanvasPanel(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    try {
      await ensureTaskCreated(task);
    } catch (error) {
      return;
    }
    let path = task.linkedCanvas;
    if (!path) {
      try {
        const json = await post('/api/study-task-create-canvas', { id: task.id });
        const idx = state.tasks.findIndex((t) => t.id === json.task.id);
        if (idx >= 0) Object.assign(state.tasks[idx], json.task);
        path = json.path;
        state.canvases.push({ path: json.path, title: json.title });
        showToast('已为该任务新建画布');
      } catch (error) {
        showToast(error.message);
        return;
      }
    }
    canvasPanelTitle.textContent = task.title || '任务画布';
    if (path !== panelPath) {
      // 切换任务：先淡出，新画布 load 完再淡入，遮住 iframe reload 的白闪
      canvasFrame.classList.add('switching');
      if (canvasLoading) canvasLoading.classList.add('show');
      canvasFrame.addEventListener('load', () => {
        resetCanvasPanelMode();
        requestAnimationFrame(() => {
          canvasFrame.classList.remove('switching');
          if (canvasLoading) canvasLoading.classList.remove('show');
        });
      }, { once: true });
      canvasFrame.src = 'editor.html?file=' + encodeURIComponent(path) + '&embed=1';
      panelPath = path;
    }
    resetCanvasPanelMode();
    clearTimeout(panelHideTimer);
    canvasPanel.hidden = false;
    requestAnimationFrame(() => canvasPanel.classList.add('open'));
    panelOpen = true;
  }

  function closeCanvasPanel() {
    if (!panelOpen) return;
    canvasPanel.classList.remove('open');
    panelOpen = false;
    panelHideTimer = setTimeout(() => { canvasPanel.hidden = true; }, 320);
  }

  function canvasPanelFullscreen() {
    if (panelPath) gotoCanvas(panelPath, false);
  }

  // 拖左缘调宽，宽度记 localStorage
  function setupCanvasPanelResize() {
    const handle = document.querySelector('[data-role="canvas-resize"]');
    if (!handle) return;
    try {
      const saved = parseInt(localStorage.getItem('study:canvasPanelW'), 10);
      if (saved >= 380) canvasPanel.style.setProperty('--panel-w', saved + 'px');
    } catch (e) {}
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvasPanel.classList.add('resizing');
      try { handle.setPointerCapture(event.pointerId); } catch (e) {}
      const onMove = (e) => {
        const w = Math.max(380, Math.min(window.innerWidth * 0.96, window.innerWidth - e.clientX));
        canvasPanel.style.setProperty('--panel-w', w + 'px');
      };
      const onUp = () => {
        canvasPanel.classList.remove('resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const cur = canvasPanel.style.getPropertyValue('--panel-w');
        try { localStorage.setItem('study:canvasPanelW', parseInt(cur, 10) || 760); } catch (e) {}
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
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
    const button = document.querySelector('[data-action="archive-done"]');
    const lane = document.querySelector('.study-lane[data-status="done"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await Promise.all(done.map(async (task) => {
        await ensureTaskCreated(task);
        const pendingUpdate = taskUpdateChains.get(task);
        if (pendingUpdate) await pendingUpdate;
      }));
      const json = await post('/api/study-archive-done');
      const archivedIds = new Set(json.archivedIds || []);
      const trashedCanvasPaths = new Set((json.trashedCanvases || []).map((item) => item.from));
      lane.classList.add('archive-success');
      button.classList.add('archive-success');
      await dismissArchivedSelection(archivedIds);
      if (viewMode === 'board') {
        await animateArchiveCards(Array.from(lane.querySelectorAll('.study-task-card')));
      } else {
        const doneGroup = document.querySelector('.study-list-group[data-status="done"]');
        await animateArchiveRows(doneGroup);
      }
      state.tasks = state.tasks.filter((task) => !archivedIds.has(task.id));
      state.canvases = state.canvases.filter((canvas) => !trashedCanvasPaths.has(canvas.path));
      render();
      if (selectionRing) selectionRing.classList.remove('dismissing');
      const empty = lane.querySelector('.study-lane-empty');
      if (empty) empty.classList.add('archive-empty-enter');
      invalidateActivity();   // 归档只是搬走数据，完成历史仍按完成日留在活跃图上
      showToast('已归档 ' + json.count + ' 件任务，关联画布已移到回收站 · data/学习归档/' + json.folder);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      setTimeout(() => {
        lane.classList.remove('archive-success');
        button.classList.remove('archive-success');
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
    render();
    openDialog(id);
    return true;
  };

  async function performStudyRefresh() {
    const requestId = ++studyRefreshSeq;
    try {
      const json = await api('/api/study');
      if (requestId !== studyRefreshSeq) return false;
      state.tasks = json.tasks || [];
      state.trash = json.trash || [];
      state.canvases = json.canvases || [];
      state.focusByTask = json.focusByTask || {};
      state.focusSessions = json.focusSessions || [];
      studyLoaded = true;
      render();
      if (state.dialogTaskId) {
        const task = findTask(state.dialogTaskId);
        if (task) renderTaskFocusSummary(task);
      }
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

  document.querySelector('[data-action="new-task"]').addEventListener('click', createTask);
  document.querySelectorAll('[data-action="quick-add"]').forEach((button) =>
    button.addEventListener('click', () => quickAdd(button.dataset.status, button)));
  document.querySelector('[data-action="study-trash"]').addEventListener('click', openTrash);
  document.querySelectorAll('[data-action="close-dialog"]').forEach((button) => button.addEventListener('click', closeDialog));
  document.querySelectorAll('[data-action="close-trash"]').forEach((button) => button.addEventListener('click', closeTrash));
  document.querySelector('[data-action="trash-task"]').addEventListener('click', trashTask);
  document.querySelector('[data-action="create-canvas"]').addEventListener('click', createCanvas);
  document.querySelector('[data-action="open-canvas"]').addEventListener('click', openCanvas);
  document.querySelector('[data-action="start-task-focus"]').addEventListener('click', () => {
    const task = findTask(state.dialogTaskId);
    if (!task) return;
    closeDialog();
    prepareTaskFocus(task);
  });
  document.querySelector('[data-action="empty-trash"]').addEventListener('click', openTrashConfirm);
  document.querySelector('[data-action="study-trash-empty-cancel"]').addEventListener('click', closeTrashConfirm);
  document.querySelector('[data-action="study-trash-empty-confirm"]').addEventListener('click', emptyTrash);
  if (trashConfirm) {
    trashConfirm.addEventListener('mousedown', (event) => {
      if (event.target === trashConfirm) closeTrashConfirm();
    });
  }
  document.querySelector('[data-action="archive-done"]').addEventListener('click', archiveDone);
  document.querySelector('[data-action="close-canvas"]').addEventListener('click', closeCanvasPanel);
  document.querySelector('[data-action="canvas-fullscreen"]').addEventListener('click', canvasPanelFullscreen);
  setupCanvasPanelResize();
  const studyView = document.querySelector('[data-role="study-view"]');
  if (studyView) {
    studyView.addEventListener('click', (event) => {
      if (event.target.closest('.study-task-card, button, input, textarea, select, a')) return;
      selectTask('');
    });
  }
  canvasSelect.addEventListener('change', syncCanvasButtons);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveDialog().catch((error) => showToast(error.message));
  });

  // ============ 今日专注 · 沉浸页 ============
  const focusOverlay = document.querySelector('[data-role="focus-overlay"]');
  const focusListEl = document.querySelector('[data-role="focus-list"]');
  const focusConfetti = document.querySelector('[data-role="focus-confetti"]');

  function cancelFocusCelebration() {
    if (focusCelebrationRaf) cancelAnimationFrame(focusCelebrationRaf);
    focusCelebrationRaf = 0;
    if (!focusConfetti || !focusConfetti.width || !focusConfetti.height) return;
    const ctx = focusConfetti.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, focusConfetti.width, focusConfetti.height);
  }

  function focusDateLabel() {
    const d = new Date();
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + wk;
  }

  function openFocus() {
    if (focusOpen || !focusOverlay) return;
    focusOpen = true;
    celebrated = false;
    document.querySelector('[data-role="focus-date"]').textContent = focusDateLabel();
    focusOverlay.hidden = false;
    renderFocus();
    requestAnimationFrame(() => focusOverlay.classList.add('show'));
  }

  function closeFocus() {
    if (!focusOpen || !focusOverlay) return;
    focusOpen = false;
    cancelFocusCelebration();
    focusOverlay.classList.remove('show');
    if (prefersReduced) focusOverlay.hidden = true;
    else setTimeout(() => { if (!focusOpen) focusOverlay.hidden = true; }, 360);
  }

  function renderFocus() {
    if (!focusOpen || !focusOverlay) return;
    const prevRects = captureListRects(focusListEl, '.study-focus-card');
    const tasks = todayTasks();
    const done = tasks.filter((t) => t.status === 'done').length;
    const total = tasks.length;
    // 进度环 + 计数
    const fill = document.querySelector('[data-role="focus-ring-fill"]');
    const C = 2 * Math.PI * 31;
    const ratio = total ? done / total : 0;
    if (fill) { fill.style.strokeDasharray = C.toFixed(1); fill.style.strokeDashoffset = (C * (1 - ratio)).toFixed(1); }
    setAnimatedNumber(document.querySelector('[data-role="focus-done"]'), done);
    document.querySelector('[data-role="focus-total"]').textContent = '/ ' + total;
    // 列表
    focusListEl.innerHTML = '';
    if (!total) {
      focusListEl.innerHTML = '<div class="study-focus-empty soft-enter">还没有今日任务。点下面的 ＋ 加一件，或回看板选中任务后按 G。</div>';
    } else {
      tasks.forEach((task) => focusListEl.appendChild(focusCard(task)));
    }
    requestAnimationFrame(() => animateListMoves(focusListEl, '.study-focus-card', prevRects));
    focusStatusPopId = '';
    renderCarryover();   // 沉浸页顶的顺延提醒
    // 全部完成 → 庆祝
    const allDone = total > 0 && done === total;
    const celebrateEl = document.querySelector('[data-role="focus-celebrate"]');
    if (allDone) {
      celebrateEl.hidden = false;
      if (!celebrated) { celebrated = true; burstConfetti(); }
    } else {
      celebrateEl.hidden = true;
      celebrated = false;
    }
  }

  function focusCard(task) {
    const card = document.createElement('div');
    card.className = 'study-focus-card' + (task.status === 'done' ? ' is-done' : '')
      + (task.id === focusStatusPopId ? ' status-pop' : '');
    card.dataset.id = task.id;
    const checked = task.status === 'done';
    card.innerHTML = [
      '<button type="button" class="study-focus-check' + (checked ? ' on' : '') + '" aria-label="标记完成">' + (checked ? '✓' : '') + '</button>',
      '<div class="study-focus-card-body">',
      '<strong class="study-task-title">' + escapeHtml(task.title) + '</strong>',
      '<div class="study-focus-card-meta">' + escapeHtml(STATUS_LABEL[task.status] || '')
        + (task.linkedCanvas ? ' · 画布 ' + escapeHtml(canvasName(task.linkedCanvas)) : '') + '</div>',
      '</div>',
      '<button type="button" class="study-focus-start" aria-label="开始专注">专注</button>',
      '<button type="button" class="study-focus-drop" aria-label="移出今日">移出</button>',
    ].join('');
    card.querySelector('.study-focus-check').addEventListener('click', (e) => {
      e.stopPropagation();
      focusStatusPopId = task.id;
      moveTask(task.id, task.status === 'done' ? 'todo' : 'done');   // render() 会刷新沉浸页
    });
    card.querySelector('.study-focus-drop').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromToday(task);
    });
    card.querySelector('.study-focus-start').addEventListener('click', (e) => {
      e.stopPropagation();
      closeFocus();
      prepareTaskFocus(task);
    });
    const titleEl = card.querySelector('.study-task-title');
    titleEl.addEventListener('click', (e) => { e.stopPropagation(); beginRename(card, task, titleEl); });
    return card;
  }

  function removeFromToday(task) {
    const wasFocus = task.focusDay === today;
    if (wasFocus) {
      animateDetachedExit(focusListEl.querySelector('.study-focus-card' + taskSelector(task.id)), 'study-focus-exit-ghost');
      task.focusDay = '';
      render();
      queueTaskPatch(task, { focusDay: '' })
        .then(() => undefined)
        .catch((err) => { showToast(err.message); refresh(); });
    }
  }

  function quickAddFocus() {
    if (!studyLoaded) {
      ensureStudyLoaded().then((loaded) => { if (loaded) quickAddFocus(); });
      return;
    }
    const task = createOptimisticTask({ title: '未命名', status: 'todo', focusDay: today });
    render();   // focusOpen 时会刷新沉浸页列表
    scheduleStudyReorder();
    const card = focusListEl.querySelector('.study-focus-card' + taskSelector(task.id));
    const titleEl = card && card.querySelector('.study-task-title');
    if (card && titleEl) {
      card.classList.add('quick-enter');
      setTimeout(() => card.classList.remove('quick-enter'), 300);
      beginRename(card, task, titleEl);   // 建完直接改名
    }
  }

  // 庆祝彩带：纯 canvas 粒子，无依赖；暖色系无蓝，尊重 reduced-motion
  function burstConfetti() {
    if (prefersReduced || !focusConfetti) return;
    const cv = focusConfetti;
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = rect.width * dpr;
    cv.height = rect.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const colors = ['#e8b84b', '#6d9d78', '#d98b6a', '#9a7bc8', '#e07a8b', '#cfa45b'];
    const parts = [];
    for (let i = 0; i < 140; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * 140, y: H * 0.40,
        vx: (Math.random() - 0.5) * 10, vy: -7 - Math.random() * 9,
        g: 0.16 + Math.random() * 0.13, s: 5 + Math.random() * 6,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
        color: colors[i % colors.length], life: 1,
      });
    }
    cancelFocusCelebration();
    const start = performance.now();
    function frame(now) {
      focusCelebrationRaf = 0;
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of parts) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
        if (t > 1700) p.life -= 0.02;
        if (p.life > 0 && p.y < H + 24) {
          alive = true;
          ctx.save();
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62);
          ctx.restore();
        }
      }
      if (alive && focusOpen) focusCelebrationRaf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    focusCelebrationRaf = requestAnimationFrame(frame);
  }

  document.querySelectorAll('[data-action="focus-close"]').forEach((b) => b.addEventListener('click', closeFocus));
  document.querySelectorAll('[data-action="focus-add"]').forEach((b) => b.addEventListener('click', quickAddFocus));
  document.querySelectorAll('[data-action="carryover-pull"]').forEach((b) => b.addEventListener('click', carryoverPull));
  document.querySelectorAll('[data-action="carryover-dismiss"]').forEach((b) => b.addEventListener('click', carryoverDismiss));

  document.addEventListener('keydown', (event) => {
    // 沉浸页打开时优先接管：F/Esc 退出；输入态（改名）放行；其它键吞掉不驱动看板
    if (focusOpen) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
        || (document.activeElement && document.activeElement.isContentEditable);
      if (typing) return;
      if (event.key === 'f' || event.key === 'F' || event.key === 'Escape') { event.preventDefault(); closeFocus(); }
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
      if (panelOpen) { event.preventDefault(); closeCanvasPanel(); return; }
      if (!dialog.hidden) closeDialog();
      else if (!trashPanel.hidden) closeTrash();
    }
    const boardKeysReady = studyVisible() && viewMode === 'board' && dialog.hidden && trashPanel.hidden && !panelOpen
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      && !(document.activeElement && document.activeElement.isContentEditable);

    // Tab：选中任务 → 滑出迷你画布浮窗（再按 Tab 关闭）
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (panelOpen) { event.preventDefault(); closeCanvasPanel(); return; }
      if (boardKeysReady && state.selectedId && findTask(state.selectedId)) {
        event.preventDefault();
        openCanvasPanel(state.selectedId);
        return;
      }
    }

    if ((event.key === 'n' || event.key === 'N') && boardKeysReady) {
      event.preventDefault();
      createTask();
      return;
    }

    if ((event.key === 'f' || event.key === 'F') && boardKeysReady) {
      event.preventDefault();
      openFocus();
      return;
    }

    // G：选中任务在「今日专注」与看板之间切换（看板→今日 / 今日→放回待办）
    if ((event.key === 'g' || event.key === 'G') && boardKeysReady) {
      if (state.selectedId && findTask(state.selectedId)) {
        event.preventDefault();
        toggleSelectedTodayFocus();
      }
      return;
    }

    if (boardKeysReady && !event.altKey && !event.ctrlKey && !event.metaKey) {
      switch (event.key) {
        case 'ArrowUp':    event.preventDefault(); moveSelectionVertical(-1); return;
        case 'ArrowDown':  event.preventDefault(); moveSelectionVertical(1); return;
        case 'ArrowLeft':  event.preventDefault(); moveSelectedTaskHorizontal(-1); return;
        case 'ArrowRight': event.preventDefault(); moveSelectedTaskHorizontal(1); return;
        case 'Enter':
          if (state.selectedId && findTask(state.selectedId)) { event.preventDefault(); openDialog(state.selectedId); }
          return;
        default: break;
      }
    }
  });

  // 滚动、尺寸变化与浏览器布局抖动：持续把选中环复位到真实卡片位置。
  const studyMain = document.querySelector('.study-main');
  if (studyMain) studyMain.addEventListener('scroll', () => followSelectionRing(120), { passive: true });
  window.addEventListener('resize', () => {
    if (selectionRing && selectionRing.classList.contains('show')) followSelectionRing(260);
  });
  let selectionSafetyTimer = 0;
  function syncSelectionSafetyTimer(active) {
    if (active && !selectionSafetyTimer) {
      selectionSafetyTimer = window.setInterval(() => {
        if (document.hidden) return;
        if (selectionRing && selectionRing.classList.contains('show')) updateSelectionRing();
      }, 900); // 保险复位：即使遇到未监听到的布局变化，最迟 0.9 秒自动贴回
    } else if (!active && selectionSafetyTimer) {
      window.clearInterval(selectionSafetyTimer);
      selectionSafetyTimer = 0;
    }
  }
  function stopStudyBackgroundWork() {
    syncSelectionSafetyTimer(false);
    selectionFollowUntil = 0;
    if (selectionFollowRaf) cancelAnimationFrame(selectionFollowRaf);
    selectionFollowRaf = 0;
    if (cadenceInteractionCleanup) cadenceInteractionCleanup();
    cancelFocusCelebration();
  }
  syncSelectionSafetyTimer(studyVisible() && !document.hidden);
  document.addEventListener('start:viewchange', (event) => {
    const current = event.detail && event.detail.current;
    syncSelectionSafetyTimer(current === 'study' && !document.hidden);
    if (current === 'study') ensureStudyLoaded();
    else {
      selectionFollowUntil = 0;
      if (selectionFollowRaf) cancelAnimationFrame(selectionFollowRaf);
      selectionFollowRaf = 0;
      cancelFocusCelebration();
    }
    if (current !== 'cadence' && cadenceInteractionCleanup) cadenceInteractionCleanup();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStudyBackgroundWork();
    else syncSelectionSafetyTimer(studyVisible());
  });
  window.addEventListener('pagehide', stopStudyBackgroundWork);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) syncSelectionSafetyTimer(studyVisible());
  });

  window.addEventListener('canvas:starmap-motion-change', () => {
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) mountStarGraph(host, activityPayload, { intro: true });
  });
  document.addEventListener('relatum:languagechange', () => {
    if (!activityPayload) return;
    const host = document.querySelector('[data-role="study-cadence"]');
    if (host) renderCadence(activityPayload, { intro: false });
  });
})();

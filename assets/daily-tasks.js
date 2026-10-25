(function () {
  'use strict';
  window.RelatumDailyTasks = function (root, host) {
    const scope = host.createScope();
    const { listen, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame } = scope;
const DAILY_REVIEWED_KEY = 'daily:reviewedDate';
const DAILY_DEPTH_MAX = 12;
const DAILY_MILESTONES_MAX = 50;
const deferredMutations = new Set();
function deferMutation(callback, delay) {
  let timer;
  const run = () => { deferredMutations.delete(run); clearTimeout(timer); callback(); };
  deferredMutations.add(run); timer = setTimeout(run, delay);
}
const prefersReduced = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();
const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
const dailyRoot = root.querySelector('[data-role="focus-daily"]');
const dailyScrollEl = root.querySelector('[data-role="focus-daily-scroll"]');
const dailyCountEl = root.querySelector('[data-role="focus-daily-count"]');
const dailyCreateBtn = root.querySelector('[data-action="daily-compose-toggle"]');
const dailySkeletonEl = root.querySelector('[data-role="focus-daily-skeleton"]');
const dailyComposerEl = root.querySelector('[data-role="focus-daily-composer"]');
const dailyListEl = root.querySelector('[data-role="focus-daily-list"]');
const dailyAddForm = root.querySelector('[data-role="focus-daily-add"]');
const dailyInputEl = root.querySelector('[data-role="focus-daily-input"]');
const dailySubmitBtn = dailyAddForm && dailyAddForm.querySelector('button[type="submit"]');
const dailyFootEl = root.querySelector('[data-role="focus-daily-foot"]');
const dailyCelebrateEl = root.querySelector('[data-role="focus-daily-celebrate"]');
const dailyCelebrateTitleEl = dailyCelebrateEl && dailyCelebrateEl.querySelector('strong');
const dailyCelebrateSubEl = root.querySelector('[data-role="focus-daily-celebrate-sub"]');
const dailyReviewBtn = root.querySelector('[data-action="daily-review-today"]');
const dailyComposeTaskBtn = root.querySelector('[data-role="daily-compose-task"]');
const dailyComposeGroupBtn = root.querySelector('[data-role="daily-compose-group"]');
const dailyComposeTargetBtn = root.querySelector('[data-role="daily-compose-target"]');
let dailyTasks = [];
let dailyGroups = [];
const dailyGroupsById = new Map();
const dailyTasksByGroup = new Map();
const dailyGroupsByParent = new Map();
const dailyProgressCache = new Map();
function rebuildDailyIndexes() {
    dailyGroupsById.clear(); dailyTasksByGroup.clear(); dailyGroupsByParent.clear(); dailyProgressCache.clear();
    function add(map, id, item) { if (!map.has(id)) map.set(id, []); map.get(id).push(item); }
    dailyGroups.forEach(function (group) { dailyGroupsById.set(group.id, group); add(dailyGroupsByParent, group.parentId || '', group); });
    dailyTasks.forEach(function (task) { add(dailyTasksByGroup, task.groupId || '', task); });
  }
function invalidateDailyProgress(groupId) {
    dailyGroupChain(groupId).forEach(function (id) { dailyProgressCache.delete(id); });
    dailyProgressCache.delete('');
  }
let dailyLoaded = false;
let dailySignature = '';
let dailyRequestSeq = 0;
let dailyRequestController = null;
let dailyRevealKey = '';
let taskLifecycleActive = false;
let taskActivationSeq = 0;
let dailyComposerOpen = false;
let dailyComposerCloseTimer = 0;
let dailyComposerCloseSeq = 0;
let dailyCreatePending = false;
let dailyEditId = '';
let dailyEditMilestones = null;
let dailyMilestoneDialog = null;
let dailyMilestoneDialogDraft = [];
let dailyMilestoneReturnEl = null;
let dailyMilestoneTipSeq = 0;
let dailyConfirmDeleteId = '';
let dailyGroupEditId = '';
let dailyGroupConfirmDeleteId = '';
const dailyExpandTimers = new WeakMap();
const replayCleanupTimers = new WeakMap();
let dailyComposeMode = 'task';
let dailyAddTargetGroup = '';
const DAILY_TARGET_UI_HIDDEN = true;
let dailyEnterId = '';
let dailyWasAllDone = false;
let dailyDrag = null;
let dailySuppressClick = false;
let dailyRevealTimer = 0;
let dailyRevealWaitingForData = false;
let dailyDataRevealTimer = 0;
let dailyCelebrateMotionTimer = 0;
let dailyCelebrateHideTimer = 0;
let dailyCelebrateGeneration = 0;
let dailyCelebratePhase = 'hidden';
let dailyCelebrateFocusTimer = 0;
let dailyCelebrateReturnId = '';
const dailyToggleStates = new Map();
let dailyDetailTaskId = '';
let dailyDetailMonth = '';
let dailyDetailReturnEl = null;
let dailyDetailCloseTimer = 0;
let dailyDetailMonthMotionTimer = 0;
function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
function isoDayFromDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
function monthKeyFromDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day.slice(0, 7) : todayStr().slice(0, 7);
  }
function shiftMonthKey(monthKey, delta) {
    const parts = /^(\d{4})-(\d{2})$/.exec(monthKey || '') || /^(\d{4})-(\d{2})$/.exec(todayStr().slice(0, 7));
    const d = new Date(Number(parts[1]), Number(parts[2]) - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
function monthLabel(monthKey) {
    const parts = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    if (!parts) return '';
    return Number(parts[1]) + ' 年 ' + Number(parts[2]) + ' 月';
  }
function monthCells(monthKey) {
    const parts = /^(\d{4})-(\d{2})$/.exec(monthKey || '') || /^(\d{4})-(\d{2})$/.exec(todayStr().slice(0, 7));
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const first = new Date(year, month - 1, 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const value = new Date(start);
      value.setDate(start.getDate() + i);
      cells.push({
        date: isoDayFromDate(value),
        number: value.getDate(),
        current: value.getMonth() === month - 1,
      });
    }
    return cells;
  }
function toast(message) {
    host.toast(message);
  }
function pageActive() { return host.isActive(); }
function dailyReviewedToday() {
    const today = todayStr();
    try {
      const stored = localStorage.getItem(DAILY_REVIEWED_KEY) || '';
      if (stored && stored !== today) localStorage.removeItem(DAILY_REVIEWED_KEY);
      return stored === today;
    } catch (e) {
      return false;
    }
  }
function setDailyReviewedToday(reviewed) {
    try {
      if (reviewed) localStorage.setItem(DAILY_REVIEWED_KEY, todayStr());
      else localStorage.removeItem(DAILY_REVIEWED_KEY);
    } catch (e) {}
  }
function replayClass(element, className, cleanupMs) {
    if (!element || prefersReduced) return;
    const cleanupByClass = replayCleanupTimers.get(element) || new Map();
    clearTimeout(cleanupByClass.get(className));
    cleanupByClass.delete(className);
    replayCleanupTimers.set(element, cleanupByClass);
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
    if (Number(cleanupMs) > 0) {
      cleanupByClass.set(className, setTimeout(() => {
        element.classList.remove(className);
        cleanupByClass.delete(className);
      }, Number(cleanupMs)));
    }
  }
function cancelDailyRead() {
    if (!dailyRequestController) return;
    dailyRequestSeq += 1;
    dailyRequestController.abort();
    dailyRequestController = null;
  }
function post(path, body) {
    // A mutation is newer than any background snapshot requested before it.
    // Abort that read so a slow GET can never repaint stale task state over the mutation.
    if (String(path || '').startsWith('/api/daily-')) cancelDailyRead();
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(async (response) => {
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || '操作失败');
      return json;
    });
  }
function dailyPayload(json) {
    const payload = json && json.daily ? json.daily : json;
    return payload && typeof payload === 'object' ? payload : {};
  }
function dailyPayloadSignature(payload) {
    return JSON.stringify({
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      groups: Array.isArray(payload.groups) ? payload.groups : [],
    });
  }
function applyDailyPayload(json) {
    const payload = dailyPayload(json);
    if (Array.isArray(payload.tasks)) dailyTasks = payload.tasks;
    if (Array.isArray(payload.groups)) dailyGroups = payload.groups;
    rebuildDailyIndexes();
    dailySignature = dailyPayloadSignature({ tasks: dailyTasks, groups: dailyGroups });
  }
function setDailyLoading(loading, reveal) {
    if (!dailyRoot) return;
    clearTimeout(dailyDataRevealTimer);
    dailyDataRevealTimer = 0;
    dailyRoot.classList.toggle('is-loading', !!loading);
    if (dailyListEl) dailyListEl.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (!dailySkeletonEl) return;
    if (loading) {
      dailyRoot.classList.remove('is-data-revealing');
      dailySkeletonEl.hidden = false;
      return;
    }
    if (reveal && !prefersReduced && !dailySkeletonEl.hidden && pageActive()) {
      dailyRoot.classList.add('is-data-revealing');
      dailyDataRevealTimer = setTimeout(() => {
        dailyRoot.classList.remove('is-data-revealing');
        dailySkeletonEl.hidden = true;
        dailyDataRevealTimer = 0;
      }, 520);
    } else {
      dailyRoot.classList.remove('is-data-revealing');
      dailySkeletonEl.hidden = true;
    }
  }
function armDailyViewEntranceCleanup() {
    clearTimeout(dailyRevealTimer);
    dailyRevealTimer = setTimeout(() => {
      if (dailyRoot) dailyRoot.classList.remove('is-revealing');
      dailyRevealTimer = 0;
      dailyRevealWaitingForData = false;
    }, 1450);
  }
function replayDailyViewEntrance(key, options) {
    if (!dailyRoot || prefersReduced || !pageActive()) return;
    const opts = options || {};
    const revealKey = String(key || 'manual');
    if (dailyRevealKey === revealKey) {
      if (dailyRevealWaitingForData && !opts.waitForData) {
        dailyRevealWaitingForData = false;
        armDailyViewEntranceCleanup();
      }
      return;
    }
    dailyRevealKey = revealKey;
    clearTimeout(dailyRevealTimer);
    dailyRoot.classList.remove('is-revealing');
    void dailyRoot.offsetWidth;
    dailyRoot.classList.add('is-revealing');
    dailyRevealWaitingForData = !!opts.waitForData;
    if (!dailyRevealWaitingForData) armDailyViewEntranceCleanup();
  }
function showTimerView() { return host.navigate('focus'); }
function allDailyDone() {
    return dailyTasks.length > 0 && dailyTasks.every((task) => task.doneToday);
  }
function dailyTodayMinutesTotal() {
    return dailyTasks.reduce((sum, task) => sum + (Number(task.todayMinutes) || 0), 0);
  }
function loadDaily(options) {
    const opts = options || {};
    const requestId = ++dailyRequestSeq;
    if (dailyRequestController) dailyRequestController.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    dailyRequestController = controller;
    const wasLoaded = dailyLoaded;
    if (!wasLoaded) setDailyLoading(true);
    const fetchOptions = controller ? { signal: controller.signal } : undefined;
    return host.read('/api/daily', fetchOptions).then((json) => {
      if (requestId !== dailyRequestSeq) return false;
      const payload = dailyPayload(json);
      const nextSignature = dailyPayloadSignature(payload);
      const changed = !wasLoaded || nextSignature !== dailySignature;
      if (changed) {
        applyDailyPayload(payload);
        dailyLoaded = true;
        dailyWasAllDone = allDailyDone();
        renderDaily({ initial: !wasLoaded, flip: wasLoaded });
      }

      setDailyLoading(false, !wasLoaded && opts.reveal !== false);
      if (!wasLoaded && taskLifecycleActive
        && opts.reveal !== false && opts.entrance !== false) {
        replayDailyViewEntrance(opts.revealKey || ('load-' + taskActivationSeq), { waitForData: false });
      }
      return changed;
    }).catch((error) => {
      if (error && error.name === 'AbortError') return false;
      if (requestId === dailyRequestSeq) {
        setDailyLoading(false, false);
        if (!wasLoaded && opts.entrance !== false) {
          replayDailyViewEntrance(opts.revealKey || ('load-' + taskActivationSeq), { waitForData: false });
        }
        if (!dailyLoaded && !opts.quiet) toast(error.message || '每日任务载入失败');
      }
      return false;
    }).finally(() => {
      if (requestId === dailyRequestSeq) dailyRequestController = null;
    });
  }
function renderDaily(opts) {
    if (!scope.alive) return;
    opts = opts || {};
    if (!dailyListEl) return;
    rebuildDailyRows({ flip: opts.flip !== false && !opts.initial });

    if (dailyCountEl) dailyCountEl.textContent = String(dailyTasks.length);
    updateDailyFoot();
    updateDailyComposeUI();
    renderDailyDetail();
    dailyCelebrationCheck({ animate: !!opts.celebrate && !opts.initial });
  }
function dailyFlipKey(el) {
    return el.dataset.id ? ('t:' + el.dataset.id) : ('g:' + (el.dataset.groupId || ''));
  }
function captureDailyRowRects() {
    if (!dailyListEl || prefersReduced) return null;
    const rects = new Map();
    dailyListEl.querySelectorAll('.focus-daily-row, .focus-daily-group').forEach((row) => {
      rects.set(dailyFlipKey(row), row.getBoundingClientRect());
    });
    return rects;
  }
function animateDailyListMoves(previous, options) {
    if (!previous || prefersReduced || !dailyListEl) return;
    const opts = options || {};
    const duration = opts.duration || 300;
    const all = Array.prototype.slice.call(dailyListEl.querySelectorAll('.focus-daily-row, .focus-daily-group'));
    const moving = [];
    all.forEach((row) => {
      if (row.classList.contains('is-dragging')) return;
      const before = previous.get(dailyFlipKey(row));
      if (!before) {
        // 新冒出来的行（如新建）：没有旧位置可补间，给个入场动画而不是硬蹦出来
        if (!row.classList.contains('is-entering')) row.classList.add('is-entering');
        return;
      }
      if (row.classList.contains('is-entering')) return;
      const now = row.getBoundingClientRect();
      const dx = before.left - now.left;
      const dy = before.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      moving.push({ row: row, dx: dx, dy: dy });
    });
    const movingSet = new Set(moving.map((m) => m.row));
    moving.forEach((m) => {
      // 祖先也在位移时，子元素随祖先 transform 一起走，别再自己叠一次（嵌套下避免位移翻倍）
      let p = m.row.parentElement;
      while (p && p !== dailyListEl) {
        if (movingSet.has(p)) return;
        p = p.parentElement;
      }
      if (m.row.getAnimations) {
        m.row.getAnimations().forEach((animation) => {
          if (animation.effect && animation.effect.target === m.row) animation.cancel();
        });
      }
      m.row.animate([
        { transform: 'translate3d(' + m.dx.toFixed(1) + 'px,' + m.dy.toFixed(1) + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], {
        duration: duration,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    });
  }
function rebuildDailyRows(options) {
    const opts = options || {};
    const previous = opts.flip ? captureDailyRowRects() : null;
    buildDailyRows();
    animateDailyListMoves(previous, opts);
  }
function dailyGroupById(id) { return dailyGroupsById.get(id) || null; }
function dailyChildGroups(parentId) {
    const pid = parentId || '';
    return dailyGroupsByParent.get(pid) || [];
  }
function dailyDirectTasks(groupId) {
    const gid = groupId || '';
    return dailyTasksByGroup.get(gid) || [];
  }
function dailyGroupProgress(groupId, visiting = new Set()) {
    if (dailyProgressCache.has(groupId)) return dailyProgressCache.get(groupId);
    if (visiting.has(groupId)) return { done: 0, total: 0 };
    visiting.add(groupId);
    let done = 0;
    let total = 0;
    dailyDirectTasks(groupId).forEach((t) => { total += 1; if (t.doneToday) done += 1; });
    dailyChildGroups(groupId).forEach((g) => {
      const sub = dailyGroupProgress(g.id, visiting);
      done += sub.done;
      total += sub.total;
    });
    visiting.delete(groupId);
    const result = { done: done, total: total };
    dailyProgressCache.set(groupId, result);
    return result;
  }
function dailyGroupChain(groupId) {
    const ids = [];
    const guard = new Set();
    let cur = groupId || '';
    while (cur && !guard.has(cur)) {
      const group = dailyGroupById(cur);
      if (!group) break;
      guard.add(cur);
      ids.push(cur);
      cur = group.parentId || '';
    }
    return ids;
  }
function refreshDailyGroupProgress(groupId) {
    invalidateDailyProgress(groupId);
    if (!dailyListEl || !groupId) return;
    dailyGroupChain(groupId).forEach((gid) => {
      const wrap = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"]');
      const progEl = wrap
        ? wrap.querySelector(':scope > .focus-daily-group-head .focus-daily-group-progress')
        : null;
      if (!progEl) return;
      const prog = dailyGroupProgress(gid);
      const next = prog.total > 0 ? prog.done + '/' + prog.total : '空';
      if (progEl.textContent !== next) replayClass(progEl, 'is-updating');
      if (prog.total > 0) {
        progEl.textContent = next;
        progEl.classList.toggle('is-complete', prog.done === prog.total);
        progEl.classList.remove('is-empty');
      } else {
        progEl.textContent = '空';
        progEl.classList.remove('is-complete');
        progEl.classList.add('is-empty');
      }
    });
  }
function dailyGroupPathLabel(group) {
    const parts = [];
    const guard = new Set();
    let cur = group;
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.name || '未命名分组');
      cur = cur.parentId ? dailyGroupById(cur.parentId) : null;
    }
    return parts.join(' / ');
  }
function buildDailyRows() {
    rebuildDailyIndexes();
    dailyListEl.innerHTML = '';
    if (dailyRoot) dailyRoot.style.setProperty('--daily-exit-tail', '0');
    if (!dailyTasks.length && !dailyGroups.length) {
      const empty = document.createElement('p');
      empty.className = 'focus-daily-empty';
      empty.textContent = '还没有每日任务 · 点右上角“＋”加一件想每天坚持的事';
      dailyListEl.appendChild(empty);
      return;
    }
    // 借鉴博客分类树：每层先列子分组，再列本层任务。子树渲进 .focus-daily-group-children 容器，
    // 始终渲染（即便折叠），折叠交给 CSS grid-rows 平滑收合——不再靠重建，避免子项瞬移。
    let index = 0;
    const visibleExitNodes = [];
    const renderInto = (container, parentId, depth, visible) => {
      dailyChildGroups(parentId).forEach((group) => {
        const wrap = buildDailyGroupRow(group, depth);
        wrap.style.setProperty('--daily-row-index', String(Math.min(index++, 7)));
        if (visible) visibleExitNodes.push(wrap);
        container.appendChild(wrap);
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'focus-daily-group-children';
        const inner = document.createElement('div');
        inner.className = 'focus-daily-group-children-inner';
        if (group.collapsed) inner.setAttribute('inert', '');   // 折叠子树不可聚焦/点击
        childrenWrap.appendChild(inner);
        wrap.appendChild(childrenWrap);
        renderInto(inner, group.id, depth + 1, visible && !group.collapsed);
      });
      dailyDirectTasks(parentId).forEach((task) => {
        const row = buildDailyRow(task, depth);
        row.style.setProperty('--daily-row-index', String(Math.min(index++, 7)));
        if (visible) visibleExitNodes.push(row);
        container.appendChild(row);
      });
    };
    renderInto(dailyListEl, '', 0, true);
    const exitTail = Math.min(Math.max(visibleExitNodes.length - 1, 0), 8);
    visibleExitNodes.forEach((element, visibleIndex) => {
      element.style.setProperty('--daily-exit-order', String(Math.min(
        Math.max(visibleExitNodes.length - 1 - visibleIndex, 0), 8
      )));
    });
    if (dailyRoot) dailyRoot.style.setProperty('--daily-exit-tail', String(exitTail));
    dailyEnterId = '';   // 入场动画只播一次
  }
function buildDailyGroupRow(group, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'focus-daily-group';
    wrap.dataset.groupId = group.id;
    wrap.style.setProperty('--daily-depth', String(Math.min(depth || 0, 5)));
    if (group.collapsed) wrap.classList.add('is-collapsed');
    if (dailyGroupEditId === group.id) wrap.classList.add('is-editing');
    if (group.id === dailyEnterId && !prefersReduced) wrap.classList.add('is-entering');

    const head = document.createElement('div');
    head.className = 'focus-daily-group-head';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'focus-daily-group-toggle';
    toggle.dataset.role = 'daily-group-toggle';
    toggle.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', (group.collapsed ? '展开' : '折叠') + '分组 · ' + (group.name || '分组'));
    head.appendChild(toggle);

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'focus-daily-group-name';
    name.textContent = group.name || '未命名分组';
    head.appendChild(name);

    const prog = dailyGroupProgress(group.id);
    const progEl = document.createElement('span');
    progEl.className = 'focus-daily-group-progress';
    if (prog.total > 0) {
      progEl.textContent = prog.done + '/' + prog.total;
      if (prog.done === prog.total) progEl.classList.add('is-complete');
    } else {
      progEl.textContent = '空';
      progEl.classList.add('is-empty');
    }
    head.appendChild(progEl);

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'focus-daily-group-menu';
    menu.dataset.role = 'daily-group-menu';
    menu.setAttribute('aria-label', '分组选项 · ' + (group.name || '分组'));
    menu.textContent = '⋯';
    head.appendChild(menu);

    wrap.appendChild(head);
    if (dailyGroupEditId === group.id) wrap.appendChild(buildDailyGroupEditor(group));
    return wrap;
  }
function buildDailyGroupEditor(group) {
    const box = document.createElement('div');
    box.className = 'focus-daily-edit focus-daily-group-edit';
    if (dailyGroupConfirmDeleteId === group.id) {
      box.classList.add('is-confirming');
      const warn = document.createElement('p');
      warn.className = 'focus-daily-confirm-text';
      warn.textContent = '删除分组「' + (group.name || '未命名分组') + '」？里面的任务和子分组会移到上一层，不会被删除。';
      const acts = document.createElement('div');
      acts.className = 'focus-daily-edit-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'focus-daily-confirm-cancel';
      cancel.dataset.role = 'daily-group-delete-cancel';
      cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'focus-daily-confirm-ok';
      ok.dataset.role = 'daily-group-delete-confirm';
      ok.textContent = '删除';
      acts.append(cancel, ok);
      box.append(warn, acts);
      return box;
    }
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.maxLength = 60;
    nameIn.className = 'focus-daily-edit-name';
    nameIn.dataset.role = 'daily-group-edit-name';
    nameIn.value = group.name || '';
    nameIn.setAttribute('aria-label', '分组名称');

    const subacts = document.createElement('div');
    subacts.className = 'focus-daily-group-subacts';
    const addSub = document.createElement('button');
    addSub.type = 'button';
    addSub.className = 'focus-daily-subact';
    addSub.dataset.role = 'daily-group-add-sub';
    addSub.textContent = '＋ 子分组';
    const addTask = document.createElement('button');
    addTask.type = 'button';
    addTask.className = 'focus-daily-subact';
    addTask.dataset.role = 'daily-group-add-task';
    addTask.textContent = '＋ 在此加任务';
    subacts.append(addSub, addTask);

    const actions = document.createElement('div');
    actions.className = 'focus-daily-edit-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'focus-daily-edit-del';
    del.dataset.role = 'daily-group-edit-delete';
    del.textContent = '删除';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'focus-daily-edit-save';
    save.dataset.role = 'daily-group-edit-save';
    save.textContent = '完成';
    actions.append(del, save);

    box.append(nameIn, subacts, actions);
    return box;
  }
function buildDailyGroupSelect(task) {
    if (!dailyGroups.length) return null;
    const wrap = document.createElement('label');
    wrap.className = 'focus-daily-edit-group';
    const span = document.createElement('span');
    span.textContent = '分组';
    const select = document.createElement('select');
    select.className = 'focus-daily-edit-group-select';
    select.dataset.role = 'daily-edit-group';
    select.setAttribute('aria-label', '所属分组');
    fillDailyGroupSelect(select, task.groupId || '');
    wrap.append(span, select);
    return wrap;
  }
function fillDailyGroupSelect(select, selectedId) {
    const root = document.createElement('option');
    root.value = '';
    root.textContent = '（不分组）';
    select.appendChild(root);
    dailyGroups
      .map((g) => ({ g: g, label: dailyGroupPathLabel(g) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
      .forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.g.id;
        opt.textContent = item.label;
        select.appendChild(opt);
      });
    select.value = selectedId || '';
  }
function dailyStatText(task) {
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    const parts = [];
    const streak = Number(task.streak) || 0;
    const totalDays = Number(task.totalDays) || 0;
    const totalMinutes = Number(task.totalMinutes) || 0;
    if (streak > 0) parts.push(T('连续 ' + streak + ' 天'));
    if (totalDays > 0) parts.push(T('共 ' + totalDays + ' 天'));
    if (totalMinutes > 0) parts.push(T('累计 ' + totalMinutes + ' 分'));
    const today = Number(task.todayMinutes) || 0;
    if (!(Number(task.targetMinutes) > 0) && today > 0) parts.push(T('今天 ' + today + ' 分'));
    return parts.length ? parts.join(' · ') : T('今天还没开始');
  }
function dailyGoalState(task) {
    const target = Math.max(0, Math.min(3660, Number(task && task.targetDays) || 0));
    const total = Math.max(0, Number(task && task.totalDays) || 0);
    return {
      target: target,
      total: total,
      progress: target > 0 ? Math.max(0, Math.min(1, total / target)) : 0,
      reached: target > 0 && total >= target,
    };
  }
function dailyGoalProgressText(task) {
    const goal = dailyGoalState(task);
    if (!goal.target) return '';
    return T('累计 ' + goal.total + ' / ' + goal.target + ' 天' + (goal.reached ? ' · 已达成' : ''));
  }
function dailyMilestoneList(task) {
    const goal = dailyGoalState(task);
    const seen = new Set();
    return (Array.isArray(task && task.milestones) ? task.milestones : [])
      .filter((item) => {
        const days = Number(item && item.days);
        const name = typeof (item && item.name) === 'string' ? item.name.trim() : '';
        if (!name || !Number.isInteger(days) || days < 1 || days > goal.target || seen.has(days)) return false;
        seen.add(days);
        return true;
      })
      .slice(0, DAILY_MILESTONES_MAX)
      .map((item, index) => ({
        id: String(item.id || ('dm_' + item.days + '_' + index)),
        name: item.name.trim(),
        days: Number(item.days),
      }))
      .sort((a, b) => a.days - b.days);
  }
function dailyMilestoneText(milestone, reached) {
    return milestone.name + ' · ' + T('累计目标') + ' ' + milestone.days + T('天')
      + ' · ' + T(reached ? '已达成' : '未达成');
  }
function dailyMilestoneLanes(milestones, target) {
    const lanes = [[], [], []];
    return milestones.map((milestone) => {
      const position = target > 0 ? Math.max(0, Math.min(100, milestone.days / target * 100)) : 0;
      let lane = lanes.findIndex((positions) => positions.every((value) => Math.abs(value - position) >= 4.5));
      if (lane < 0) lane = lanes.reduce((best, positions, index) => positions.length < lanes[best].length ? index : best, 0);
      lanes[lane].push(position);
      return { milestone: milestone, position: position, lane: [0, -1, 1][lane] };
    });
  }
function syncDailyMilestones(shell, task, options) {
    const layer = shell && shell.querySelector('[data-role="daily-goal-milestones"]');
    if (!layer) return;
    const opts = options || {};
    const goal = dailyGoalState(task);
    const crossed = new Set(Array.isArray(opts.milestoneIds) ? opts.milestoneIds : []);
    const layout = dailyMilestoneLanes(dailyMilestoneList(task), goal.target);
    layer.classList.toggle('is-dense', layout.length > 12);
    layer.classList.toggle('is-very-dense', layout.length > 24);
    const keep = new Set(layout.map((entry) => entry.milestone.id));
    layer.querySelectorAll('.focus-daily-milestone').forEach((marker) => {
      if (keep.has(marker.dataset.milestoneId)) return;
      if (prefersReduced) marker.remove();
      else {
        marker.classList.add('is-leaving');
        setTimeout(() => marker.remove(), 220);
      }
    });
    layout.forEach((entry) => {
      const milestone = entry.milestone;
      const reached = goal.total >= milestone.days;
      let marker = Array.prototype.find.call(layer.children, (item) => item.dataset.milestoneId === milestone.id);
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'focus-daily-milestone is-entering';
        marker.dataset.milestoneId = milestone.id;
        marker.tabIndex = 0;
        marker.setAttribute('role', 'img');
        const stamp = document.createElement('span');
        stamp.className = 'focus-daily-milestone-stamp';
        stamp.setAttribute('aria-hidden', 'true');
        const tip = document.createElement('span');
        tip.className = 'focus-daily-milestone-tip';
        tip.setAttribute('role', 'tooltip');
        dailyMilestoneTipSeq += 1;
        tip.id = 'daily-milestone-tip-' + dailyMilestoneTipSeq;
        marker.setAttribute('aria-describedby', tip.id);
        marker.append(stamp, tip);
        layer.appendChild(marker);
        if (!prefersReduced) setTimeout(() => marker.classList.remove('is-entering'), 260);
        else marker.classList.remove('is-entering');
      }
      const text = dailyMilestoneText(milestone, reached);
      marker.style.setProperty('--milestone-position', entry.position.toFixed(3) + '%');
      marker.style.setProperty('--milestone-lane', String(entry.lane));
      marker.classList.toggle('is-edge-start', entry.position < 12);
      marker.classList.toggle('is-edge-end', entry.position > 88);
      marker.classList.toggle('is-reached', reached);
      marker.setAttribute('aria-label', text);
      marker.querySelector('.focus-daily-milestone-tip').textContent = text;
      if (crossed.has(milestone.id) && !prefersReduced) replayClass(marker, 'is-just-reached');
    });
  }
function syncDailyGoalProgress(shell, task, options) {
    if (!shell) return;
    const opts = options || {};
    const goal = dailyGoalState(task);
    const text = dailyGoalProgressText(task);
    const bar = shell.querySelector('[data-role="daily-goal-track"]');
    const fill = shell.querySelector('[data-role="daily-goal-fill"]');
    if (!bar) return;
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(goal.target));
    bar.setAttribute('aria-valuenow', String(Math.min(goal.total, goal.target)));
    bar.setAttribute('aria-valuetext', text);
    bar.setAttribute('data-ui-tooltip', text);
    bar.classList.toggle('is-full', goal.reached);
    if (fill) fill.style.width = (goal.progress * 100).toFixed(2) + '%';
    if (opts.glow && !prefersReduced) {
      replayClass(bar, opts.reached ? 'is-goal-reached' : 'is-advancing');
    }
    syncDailyMilestones(shell, task, opts);
  }
function buildDailyGoalProgress(task, className) {
    const shell = document.createElement('div');
    shell.className = 'focus-daily-goal-shell';
    const bar = document.createElement('div');
    bar.className = (className || 'focus-daily-goal') + ' focus-daily-goal-track';
    bar.dataset.role = 'daily-goal-track';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', T('累计打卡目标'));
    const fill = document.createElement('span');
    fill.className = 'focus-daily-goal-fill';
    fill.dataset.role = 'daily-goal-fill';
    bar.appendChild(fill);
    const markers = document.createElement('div');
    markers.className = 'focus-daily-milestones';
    markers.dataset.role = 'daily-goal-milestones';
    shell.append(bar, markers);
    syncDailyGoalProgress(shell, task);
    return shell;
  }
function dailyDoneDateSet(task) {
    return new Set(Array.isArray(task && task.doneDates) ? task.doneDates : []);
  }
function dailyMinutesMap(task) {
    const raw = task && task.minutesByDate;
    return raw && typeof raw === 'object' ? raw : {};
  }
function getDailyDetailShell() {
    return document.querySelector('[data-role="daily-detail"]');
  }
function closeDailyDetail(options) {
    const opts = options || {};
    const old = getDailyDetailShell();
    const returnEl = dailyDetailReturnEl;
    clearTimeout(dailyDetailCloseTimer);
    clearTimeout(dailyDetailMonthMotionTimer);
    dailyDetailCloseTimer = 0;
    dailyDetailMonthMotionTimer = 0;
    if (old) {
      const grid = old.querySelector('[data-role="daily-detail-grid"]');
      const monthEl = old.querySelector('[data-role="daily-detail-month"]');
      if (grid) grid.classList.remove('is-entering', 'is-month-settling', 'is-next', 'is-prev', 'is-today');
      if (monthEl) monthEl.classList.remove('is-month-settling');
    }
    dailyDetailTaskId = '';
    dailyDetailMonth = '';
    dailyDetailReturnEl = null;
    const restore = () => {
      if (opts.restore !== false && returnEl && typeof returnEl.focus === 'function') {
        try { returnEl.focus({ preventScroll: true }); } catch (e) {}
      }
    };
    if (!old) { restore(); return; }
    if (opts.instant || prefersReduced) {
      old.remove();
      restore();
      return;
    }
    if (old.getAnimations) {
      try { old.getAnimations({ subtree: true }).forEach((animation) => animation.cancel()); } catch (e) {}
    }
    old.classList.remove('is-closing');
    void old.offsetWidth;
    old.classList.add('is-closing');
    old.setAttribute('aria-hidden', 'true');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(dailyDetailCloseTimer);
      old.removeEventListener('animationend', onEnd);
      if (old.isConnected) old.remove();
      dailyDetailCloseTimer = 0;
      restore();
    };
    const onEnd = (event) => {
      if (event.target === old || event.target.classList.contains('focus-daily-detail')) finish();
    };
    old.addEventListener('animationend', onEnd);
    dailyDetailCloseTimer = setTimeout(finish, 350);
  }
function openDailyDetail(id, returnEl) {
    const task = dailyTasks.find((item) => item.id === id);
    if (!task) return;
    clearTimeout(dailyDetailCloseTimer);
    dailyDetailCloseTimer = 0;
    dailyDetailTaskId = id;
    dailyDetailMonth = monthKeyFromDay(task.lastDoneDate || todayStr());
    dailyDetailReturnEl = returnEl || document.activeElement;
    renderDailyDetail();
  }
function moveDailyDetailMonth(delta) {
    if (!dailyDetailTaskId) return;
    dailyDetailMonth = shiftMonthKey(dailyDetailMonth || todayStr().slice(0, 7), delta);
    renderDailyDetailCalendar(delta);
  }
function handleDailyDetailClick(event) {
    const shell = event.currentTarget;
    if (event.target === shell) { closeDailyDetail({ restore: false }); return; }
    const action = event.target.closest('[data-action]');
    if (!action || !shell.contains(action)) return;
    if (action.dataset.action === 'daily-detail-close') { closeDailyDetail(); return; }
    if (action.dataset.action === 'daily-detail-prev') { moveDailyDetailMonth(-1); return; }
    if (action.dataset.action === 'daily-detail-next') { moveDailyDetailMonth(1); return; }
    if (action.dataset.action === 'daily-detail-today') {
      dailyDetailMonth = todayStr().slice(0, 7);
      renderDailyDetailCalendar(0);
      return;
    }
    if (action.dataset.action === 'daily-detail-toggle' && dailyDetailTaskId) {
      const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
      if (task) toggleDailyTask(task.id);
      return;
    }
    if(action.dataset.action==='daily-detail-bind'&&dailyDetailTaskId){const task=dailyTasks.find(item=>item.id===dailyDetailTaskId);if(task)host.bindTask(task);return;}
    if (action.dataset.action === 'daily-detail-edit' && dailyDetailTaskId) {
      const id = dailyDetailTaskId;
      closeDailyDetail({ restore: false, instant: true });
      openDailyEdit(id);
    }
  }
function dailyDetailStat(key, label, value, hint) {
    const item = document.createElement('div');
    item.className = 'focus-daily-detail-stat';
    const small = document.createElement('span');
    small.textContent = label;
    const strong = document.createElement('strong');
    strong.dataset.role = 'daily-detail-stat-' + key;
    strong.textContent = value;
    item.append(small, strong);
    if (hint) {
      const em = document.createElement('em');
      em.textContent = hint;
      item.appendChild(em);
    }
    return item;
  }
function dailyDetailBlock(titleText) {
    const block = document.createElement('section');
    block.className = 'focus-daily-detail-block';
    const title = document.createElement('h3');
    title.textContent = titleText;
    block.appendChild(title);
    return block;
  }
function playDailyDetailMonthMotion(grid, monthEl, direction) {
    if (prefersReduced || !grid) return;
    clearTimeout(dailyDetailMonthMotionTimer);
    grid.classList.remove('is-entering', 'is-month-settling', 'is-next', 'is-prev', 'is-today');
    if (monthEl) monthEl.classList.remove('is-month-settling');
    void grid.offsetWidth;
    grid.classList.add('is-entering');
    if (monthEl) monthEl.classList.add('is-month-settling');
    dailyDetailMonthMotionTimer = setTimeout(() => {
      if (grid.isConnected) grid.classList.remove('is-entering');
      if (monthEl && monthEl.isConnected) monthEl.classList.remove('is-month-settling');
      dailyDetailMonthMotionTimer = 0;
    }, 980);
  }
function fillDailyDetailCalendar(grid, task) {
    if (!grid || !task) return;
    const today = todayStr();
    const doneDates = dailyDoneDateSet(task);
    const minutesByDate = dailyMinutesMap(task);
    monthCells(dailyDetailMonth).forEach((cell, index) => {
      let day = grid.children[index];
      if (!day) {
        day = document.createElement('span');
        grid.appendChild(day);
      }
      day.className = 'focus-daily-detail-day';
      if (!cell.current) day.classList.add('outside');
      if (cell.date === today) day.classList.add('today');
      if (doneDates.has(cell.date)) day.classList.add('is-done');
      day.style.setProperty('--daily-detail-row-delay', Math.floor(index / 7) * 80 + (index % 7) * 6 + 'ms');
      let num = day.querySelector('b');
      if (!num) {
        num = document.createElement('b');
        day.appendChild(num);
      }
      num.textContent = String(cell.number);
      Array.prototype.slice.call(day.querySelectorAll('small')).forEach((el) => el.remove());
      const mins = Number(minutesByDate[cell.date]) || 0;
      if (mins > 0) {
        day.classList.add('has-minutes');
        const small = document.createElement('small');
        small.textContent = mins + 'm';
        day.appendChild(small);
      }
      day.title = cell.date + (doneDates.has(cell.date) ? ' · 已打卡' : '') + (mins > 0 ? ' · ' + mins + ' 分钟' : '');
    });
    while (grid.children.length > 42) grid.removeChild(grid.lastElementChild);
  }
function fillDailyDetailHistorySummary(recent, note, task) {
    if (!recent || !note || !task) return;
    const today = todayStr();
    const orderedDates = Array.from(dailyDoneDateSet(task)).sort();
    recent.innerHTML = '';
    orderedDates.slice(-10).reverse().forEach((day) => {
      const chip = document.createElement('span');
      chip.textContent = day.slice(5);
      if (day === today) chip.classList.add('today');
      recent.appendChild(chip);
    });
    if (!recent.childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = T('还没有历史打卡');
      recent.appendChild(empty);
    }
    note.textContent = orderedDates.length
      ? '已记录 ' + orderedDates.length + ' 个打卡日，最近一次是 ' + orderedDates[orderedDates.length - 1] + '。'
      : T('完成第一次打卡后，这里会开始沉淀它的日历轨迹。');
  }
function renderDailyDetailCalendar(direction) {
    if (!dailyDetailTaskId) return;
    const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
    const shell = getDailyDetailShell();
    if (!task || !shell) { renderDailyDetail(); return; }
    const monthEl = shell.querySelector('[data-role="daily-detail-month"]');
    const grid = shell.querySelector('[data-role="daily-detail-grid"]');
    if (!monthEl || !grid) { renderDailyDetail(); return; }
    monthEl.textContent = monthLabel(dailyDetailMonth);
    fillDailyDetailCalendar(grid, task);
    playDailyDetailMonthMotion(grid, monthEl, direction);
  }
function renderDailyDetail() {
    clearTimeout(dailyDetailMonthMotionTimer);
    dailyDetailMonthMotionTimer = 0;
    const old = getDailyDetailShell();
    const shouldFocus = !old;
    if (old) old.remove();
    if (!dailyDetailTaskId) return;
    const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
    if (!task) { dailyDetailTaskId = ''; dailyDetailMonth = ''; return; }
    if (!dailyDetailMonth) dailyDetailMonth = monthKeyFromDay(task.lastDoneDate || todayStr());

    const today = todayStr();
    const doneDates = dailyDoneDateSet(task);
    const minutesByDate = dailyMinutesMap(task);
    const todayMinutes = Number(task.todayMinutes) || 0;
    const target = DAILY_TARGET_UI_HIDDEN ? 0 : (Number(task.targetMinutes) || 0);
    const dayGoal = dailyGoalState(task);
    const recorded = doneDates.size;
    const group = task.groupId ? dailyGroupById(task.groupId) : null;
    const groupLabel = group ? dailyGroupPathLabel(group) : T('未分组');
    const boundHere = window.RelatumFocusService?.boundKind === 'daily' && window.RelatumFocusService?.boundTaskId === task.id;

    const shell = document.createElement('div');
    shell.className = 'focus-daily-detail-shell';
    shell.dataset.role = 'daily-detail';
    shell.addEventListener('click', handleDailyDetailClick);
    const panel = document.createElement('section');
    panel.className = 'focus-daily-detail';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'focus-daily-detail-title');

    const head = document.createElement('header');
    head.className = 'focus-daily-detail-head';
    const copy = document.createElement('div');
    copy.className = 'focus-daily-detail-copy';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'study-eyebrow';
    eyebrow.textContent = 'DAILY TASK';
    const title = document.createElement('h2');
    title.id = 'focus-daily-detail-title';
    title.textContent = task.name || '每日任务';
    const meta = document.createElement('span');
    meta.dataset.role = 'daily-detail-meta';
    meta.textContent = groupLabel + ' · ' + dailyStatText(task);
    copy.append(eyebrow, title, meta);

    const actions = document.createElement('div');
    actions.className = 'focus-daily-detail-actions';
    const bind = document.createElement('button');
    bind.type = 'button';
    bind.className = 'focus-daily-detail-btn';
    bind.dataset.action = 'daily-detail-bind';
    bind.textContent = boundHere ? '已绑定本段' : '设为本段专注';
    if (boundHere) bind.classList.add('is-active');
    if (window.RelatumFocusService?.running || window.RelatumFocusService?.pendingSession) bind.disabled = true;
    bind.hidden = !window.RelatumFeatureRuntime.enabled('daily.focus');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'focus-daily-detail-btn is-primary';
    toggle.dataset.action = 'daily-detail-toggle';
    toggle.setAttribute('aria-pressed', task.doneToday ? 'true' : 'false');
    toggle.textContent = task.doneToday ? '取消今日打卡' : '今日打卡';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'focus-daily-detail-btn';
    edit.dataset.action = 'daily-detail-edit';
    edit.textContent = '编辑';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'focus-daily-detail-close';
    close.dataset.action = 'daily-detail-close';
    close.setAttribute('aria-label', '关闭每日任务详情');
    close.textContent = '×';
    actions.append(toggle, bind, edit, close);
    head.append(copy, actions);
    panel.appendChild(head);

    const stats = document.createElement('div');
    stats.className = 'focus-daily-detail-stats';
    stats.append(
      dailyDetailStat('streak', '连续', String(Number(task.streak) || 0), '天'),
      dailyDetailStat('total', '累计', String(Number(task.totalDays) || recorded), '天'),
      dailyDetailStat('best', '最佳', String(Number(task.bestStreak) || 0), '天')
    );
    panel.appendChild(stats);

    const body = document.createElement('div');
    body.className = 'focus-daily-detail-body';

    const calendar = document.createElement('section');
    calendar.className = 'focus-daily-detail-calendar';
    const calHead = document.createElement('div');
    calHead.className = 'focus-daily-detail-calendar-head';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.dataset.action = 'daily-detail-prev';
    prev.setAttribute('aria-label', '上个月');
    prev.textContent = '‹';
    const month = document.createElement('strong');
    month.dataset.role = 'daily-detail-month';
    month.textContent = monthLabel(dailyDetailMonth);
    const next = document.createElement('button');
    next.type = 'button';
    next.dataset.action = 'daily-detail-next';
    next.setAttribute('aria-label', '下个月');
    next.textContent = '›';
    const now = document.createElement('button');
    now.type = 'button';
    now.dataset.action = 'daily-detail-today';
    now.textContent = '今天';
    calHead.append(prev, month, next, now);
    calendar.appendChild(calHead);

    const weekdays = document.createElement('div');
    weekdays.className = 'focus-daily-detail-weekdays';
    ['一', '二', '三', '四', '五', '六', '日'].forEach((label) => {
      const span = document.createElement('span');
      span.textContent = label;
      weekdays.appendChild(span);
    });
    calendar.appendChild(weekdays);

    const grid = document.createElement('div');
    grid.className = 'focus-daily-detail-grid';
    grid.dataset.role = 'daily-detail-grid';
    monthCells(dailyDetailMonth).forEach((cell, index) => {
      const day = document.createElement('span');
      day.className = 'focus-daily-detail-day';
      if (!cell.current) day.classList.add('outside');
      if (cell.date === today) day.classList.add('today');
      if (doneDates.has(cell.date)) day.classList.add('is-done');
      day.style.setProperty('--daily-detail-row-delay', Math.floor(index / 7) * 80 + (index % 7) * 6 + 'ms');
      const num = document.createElement('b');
      num.textContent = String(cell.number);
      day.appendChild(num);
      const mins = Number(minutesByDate[cell.date]) || 0;
      if (mins > 0) {
        day.classList.add('has-minutes');
        const small = document.createElement('small');
        small.textContent = mins + 'm';
        day.appendChild(small);
      }
      day.title = cell.date + (doneDates.has(cell.date) ? ' · 已打卡' : '') + (mins > 0 ? ' · ' + mins + ' 分钟' : '');
      grid.appendChild(day);
    });
    calendar.appendChild(grid);
    body.appendChild(calendar);

    const side = document.createElement('aside');
    side.className = 'focus-daily-detail-side';
    if (dayGoal.target > 0) {
      const goalBlock = dailyDetailBlock(T('累计目标'));
      const goalText = document.createElement('p');
      goalText.className = 'focus-daily-detail-progress-text';
      goalText.dataset.role = 'daily-detail-goal-text';
      goalText.textContent = dailyGoalProgressText(task);
      goalBlock.appendChild(goalText);
      const goalBar = buildDailyGoalProgress(task, 'focus-daily-detail-progress is-cumulative');
      goalBlock.appendChild(goalBar);
      side.appendChild(goalBlock);
    }
    if (!DAILY_TARGET_UI_HIDDEN) {
      const progressBlock = dailyDetailBlock('今日进度');
      const progressText = document.createElement('p');
      progressText.className = 'focus-daily-detail-progress-text';
      progressText.textContent = target > 0
        ? todayMinutes + ' / ' + target + ' 分钟' + (todayMinutes >= target ? ' · 已达标' : '')
        : (todayMinutes > 0 ? '今天已专注 ' + todayMinutes + ' 分钟' : '今天还没有专注分钟');
      progressBlock.appendChild(progressText);
      const bar = document.createElement('div');
      bar.className = 'focus-daily-detail-progress';
      const fill = document.createElement('span');
      const pct = target > 0 ? Math.max(0, Math.min(1, todayMinutes / target)) : (todayMinutes > 0 ? 1 : 0);
      fill.style.width = (pct * 100).toFixed(0) + '%';
      if (pct >= 1 && target > 0) fill.classList.add('is-full');
      bar.appendChild(fill);
      progressBlock.appendChild(bar);
      side.appendChild(progressBlock);
    }

    const recentBlock = dailyDetailBlock('最近打卡');
    const recent = document.createElement('div');
    recent.className = 'focus-daily-detail-recent';
    recent.dataset.role = 'daily-detail-recent';
    recentBlock.appendChild(recent);
    side.appendChild(recentBlock);

    const noteBlock = dailyDetailBlock('记录');
    const note = document.createElement('p');
    note.className = 'focus-daily-detail-note';
    note.dataset.role = 'daily-detail-note';
    fillDailyDetailHistorySummary(recent, note, task);
    noteBlock.appendChild(note);
    side.appendChild(noteBlock);

    body.appendChild(side);
    panel.appendChild(body);
    shell.appendChild(panel);
    document.body.appendChild(shell);
    if (shouldFocus) {
      requestAnimationFrame(() => {
        if (!toggle.isConnected) return;
        try { toggle.focus({ preventScroll: true }); } catch (e) { toggle.focus(); }
      });
    }
    if (!prefersReduced) {
      grid.classList.add('is-entering');
      clearTimeout(dailyDetailMonthMotionTimer);
      dailyDetailMonthMotionTimer = setTimeout(() => {
        if (grid.isConnected) grid.classList.remove('is-entering');
        dailyDetailMonthMotionTimer = 0;
      }, 980);
    }
  }
function buildDailyRow(task, depth) {
    const row = document.createElement('div');
    row.className = 'focus-daily-row';
    row.dataset.id = task.id;
    row.dataset.groupId = task.groupId || '';
    row.style.setProperty('--daily-depth', String(Math.min(depth || 0, 5)));
    if (task.doneToday) row.classList.add('is-done');
    if (dailyEditId === task.id) row.classList.add('is-editing');
    if (task.id === dailyEnterId && !prefersReduced) row.classList.add('is-entering');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'focus-daily-check';
    check.dataset.role = 'daily-check';
    check.setAttribute('aria-pressed', task.doneToday ? 'true' : 'false');
    const checkLabel = (task.doneToday ? '取消完成 · ' : '标记完成 · ') + (task.name || '每日任务');
    check.setAttribute('data-i18n-source-aria-label', checkLabel);
    check.setAttribute('aria-label', T(checkLabel));
    row.appendChild(check);

    const main = document.createElement('div');
    main.className = 'focus-daily-main';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'focus-daily-name';
    name.dataset.action = 'daily-detail-open';
    const detailLabel = '查看任务详情 · ' + (task.name || '每日任务');
    name.setAttribute('data-i18n-source-aria-label', detailLabel);
    name.setAttribute('aria-label', T(detailLabel));
    name.textContent = task.name || '未命名';
    main.appendChild(name);

    const stat = document.createElement('div');
    stat.className = 'focus-daily-stat';
    stat.textContent = dailyStatText(task);
    main.appendChild(stat);

    if (dailyGoalState(task).target > 0) main.appendChild(buildDailyGoalProgress(task));

    if (dailyEditId === task.id) main.appendChild(buildDailyEditor(task));
    row.appendChild(main);

    const detailCue = document.createElement('span');
    detailCue.className = 'focus-daily-detail-cue';
    detailCue.setAttribute('aria-hidden', 'true');
    detailCue.textContent = '›';
    row.appendChild(detailCue);

    // 右侧 ⋯ 选项按钮：平时透明，悬停该行/编辑态才浮现；只有它能进编辑（对齐分组组头的 ⋯）
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'focus-daily-menu';
    menu.dataset.role = 'daily-menu';
    menu.setAttribute('aria-label', '任务选项 · ' + (task.name || '每日任务'));
    menu.setAttribute('aria-haspopup', 'true');
    menu.textContent = '⋯';
    row.appendChild(menu);
    return row;
  }
function buildDailyEditor(task) {
    const box = document.createElement('div');
    box.className = 'focus-daily-edit';
    if (dailyConfirmDeleteId === task.id) {
      box.classList.add('is-confirming');
      const warn = document.createElement('p');
      warn.className = 'focus-daily-confirm-text';
      warn.textContent = '删除「' + (task.name || '未命名') + '」？它的累计天数与分钟会一起清掉。';
      const acts = document.createElement('div');
      acts.className = 'focus-daily-edit-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'focus-daily-confirm-cancel';
      cancel.dataset.role = 'daily-delete-cancel';
      cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'focus-daily-confirm-ok';
      ok.dataset.role = 'daily-delete-confirm';
      ok.textContent = '删除';
      acts.append(cancel, ok);
      box.append(warn, acts);
      return box;
    }
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.maxLength = 80;
    nameIn.className = 'focus-daily-edit-name';
    nameIn.dataset.role = 'daily-edit-name';
    nameIn.value = task.name || '';
    nameIn.setAttribute('aria-label', '每日任务名称');
    let targetWrap = null;
    if (!DAILY_TARGET_UI_HIDDEN) {
      targetWrap = document.createElement('label');
      targetWrap.className = 'focus-daily-edit-target';
      const tspan = document.createElement('span');
      tspan.textContent = '今日目标';
      const targetIn = document.createElement('input');
      targetIn.type = 'number';
      targetIn.min = '0';
      targetIn.max = '600';
      targetIn.step = '5';
      targetIn.className = 'focus-daily-edit-min';
      targetIn.dataset.role = 'daily-edit-target';
      targetIn.placeholder = '分钟 · 可选';
      targetIn.value = Number(task.targetMinutes) > 0 ? String(task.targetMinutes) : '';
      targetWrap.append(tspan, targetIn);
    }
    const goalWrap = document.createElement('div');
    goalWrap.className = 'focus-daily-edit-target';
    const goalField = document.createElement('label');
    goalField.className = 'focus-daily-edit-target-field';
    const goalSpan = document.createElement('span');
    goalSpan.textContent = T('累计目标');
    const goalIn = document.createElement('input');
    goalIn.type = 'number';
    goalIn.min = '0';
    goalIn.max = '3660';
    goalIn.step = '1';
    goalIn.className = 'focus-daily-edit-days';
    goalIn.dataset.role = 'daily-edit-days';
    goalIn.placeholder = T('天 · 可选');
    goalIn.setAttribute('aria-label', T('累计打卡目标天数'));
    goalIn.value = Number(task.targetDays) > 0 ? String(task.targetDays) : '';
    const advanced = document.createElement('button');
    advanced.type = 'button';
    advanced.className = 'focus-daily-edit-advanced';
    advanced.dataset.role = 'daily-edit-advanced';
    advanced.textContent = T('高级设置');
    advanced.setAttribute('aria-haspopup', 'dialog');
    const updateAdvanced = () => {
      const value = Number(goalIn.value);
      const enabled = Number.isInteger(value) && value > 0 && value <= 3660;
      advanced.disabled = !enabled;
      advanced.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      advanced.setAttribute('data-ui-tooltip', enabled ? T('设置累计小目标') : T('请先设置累计目标'));
      const count = Array.isArray(dailyEditMilestones) ? dailyEditMilestones.length : 0;
      advanced.textContent = T('高级设置') + (count ? ' · ' + count : '');
    };
    goalIn.addEventListener('input', updateAdvanced);
    goalField.append(goalSpan, goalIn);
    goalWrap.append(goalField, advanced);
    updateAdvanced();
    const actions = document.createElement('div');
    actions.className = 'focus-daily-edit-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'focus-daily-edit-del';
    del.dataset.role = 'daily-edit-delete';
    del.textContent = '删除';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'focus-daily-edit-save';
    save.dataset.role = 'daily-edit-save';
    save.textContent = '完成';
    actions.append(del, save);
    const groupRow = buildDailyGroupSelect(task);
    // 拼装时跳过空块：隐藏的 targetWrap 为 null，不传给 append（避免被渲染成 "null" 文本）
    const editParts = [nameIn];
    if (targetWrap) editParts.push(targetWrap);
    editParts.push(goalWrap);
    if (groupRow) editParts.push(groupRow);
    editParts.push(actions);
    box.append(...editParts);
    return box;
  }
function cloneDailyMilestones(items) {
    return (Array.isArray(items) ? items : []).slice(0, DAILY_MILESTONES_MAX).map((item, index) => ({
      id: String(item && item.id || ('dm_draft_' + Date.now().toString(36) + '_' + index)),
      name: String(item && item.name || ''),
      days: Number(item && item.days) || 0,
    }));
  }
function dailyMilestoneDraftId() {
    return 'dm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }
function dailyEditTargetDays(id) {
    const row = dailyListEl && dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    const input = row && row.querySelector('[data-role="daily-edit-days"]');
    const value = Number(input && input.value);
    return Number.isInteger(value) && value > 0 && value <= 3660 ? value : 0;
  }
function setDailyMilestoneDialogError(message) {
    if (!dailyMilestoneDialog) return;
    const error = dailyMilestoneDialog.querySelector('[data-role="daily-milestone-error"]');
    if (error) error.textContent = message || '';
  }
function updateDailyMilestoneAddState() {
    if (!dailyMilestoneDialog) return;
    const count = dailyMilestoneDialog.querySelectorAll('.focus-daily-milestone-row:not(.is-leaving)').length;
    const add = dailyMilestoneDialog.querySelector('[data-action="daily-milestone-add"]');
    if (add) {
      add.disabled = count >= DAILY_MILESTONES_MAX;
      add.textContent = count >= DAILY_MILESTONES_MAX ? T('已达到 50 个安全上限') : T('添加小目标') + ' · ' + count;
    }
  }
function appendDailyMilestoneDraftRow(item, animate) {
    if (!dailyMilestoneDialog) return null;
    const list = dailyMilestoneDialog.querySelector('[data-role="daily-milestone-list"]');
    if (!list) return null;
    const row = document.createElement('div');
    row.className = 'focus-daily-milestone-row' + (animate && !prefersReduced ? ' is-entering' : '');
    row.dataset.milestoneId = item.id || dailyMilestoneDraftId();
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 40;
    name.className = 'focus-daily-milestone-name';
    name.dataset.role = 'daily-milestone-name';
    name.placeholder = T('小目标名称');
    name.setAttribute('aria-label', T('小目标名称'));
    name.value = item.name || '';
    const daysWrap = document.createElement('label');
    daysWrap.className = 'focus-daily-milestone-days-wrap';
    const days = document.createElement('input');
    days.type = 'number';
    days.min = '1';
    days.max = String(dailyEditTargetDays(dailyEditId) || 3660);
    days.step = '1';
    days.className = 'focus-daily-milestone-days';
    days.dataset.role = 'daily-milestone-days';
    days.setAttribute('aria-label', T('累计天数'));
    days.value = Number(item.days) > 0 ? String(item.days) : '';
    const unit = document.createElement('span');
    unit.textContent = T('天');
    daysWrap.append(days, unit);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'focus-daily-milestone-remove';
    remove.dataset.action = 'daily-milestone-remove';
    remove.setAttribute('aria-label', T('删除这个小目标'));
    remove.textContent = '×';
    row.append(name, daysWrap, remove);
    list.appendChild(row);
    if (row.classList.contains('is-entering')) setTimeout(() => row.classList.remove('is-entering'), 260);
    updateDailyMilestoneAddState();
    return row;
  }
function readDailyMilestoneDialog() {
    const targetDays = dailyEditTargetDays(dailyEditId);
    if (!targetDays) return { error: T('请先设置累计目标') };
    const rows = Array.from(dailyMilestoneDialog.querySelectorAll('.focus-daily-milestone-row:not(.is-leaving)'));
    const result = [];
    const seenDays = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const nameInput = row.querySelector('[data-role="daily-milestone-name"]');
      const daysInput = row.querySelector('[data-role="daily-milestone-days"]');
      const name = String(nameInput && nameInput.value || '').trim();
      const rawDays = String(daysInput && daysInput.value || '').trim();
      const days = /^\d+$/.test(rawDays) ? Number(rawDays) : 0;
      row.classList.remove('has-error');
      if (!name) {
        row.classList.add('has-error');
        if (nameInput) nameInput.focus();
        return { error: T('请填写小目标名称') };
      }
      if (name.length > 40) {
        row.classList.add('has-error');
        if (nameInput) nameInput.focus();
        return { error: T('小目标名称不能超过 40 个字符') };
      }
      if (!days || days > targetDays) {
        row.classList.add('has-error');
        if (daysInput) daysInput.focus();
        return { error: T('小目标天数必须在 1 到累计目标之间') };
      }
      if (seenDays.has(days)) {
        row.classList.add('has-error');
        if (daysInput) daysInput.focus();
        return { error: T('同一天只能设置一个小目标') };
      }
      seenDays.add(days);
      result.push({ id: row.dataset.milestoneId || dailyMilestoneDraftId(), name: name, days: days });
    }
    result.sort((a, b) => a.days - b.days);
    return { milestones: result };
  }
function openDailyMilestoneDialog(id, returnElement) {
    const targetDays = dailyEditTargetDays(id);
    if (!targetDays) { toast(T('请先设置累计目标')); return; }
    if (dailyMilestoneDialog) closeDailyMilestoneDialog(false, true);
    dailyMilestoneDialogDraft = cloneDailyMilestones(dailyEditMilestones);
    dailyMilestoneReturnEl = returnElement || null;
    const shell = document.createElement('div');
    shell.className = 'focus-daily-milestone-shell';
    shell.dataset.role = 'daily-milestone-dialog';
    const dialog = document.createElement('section');
    dialog.className = 'focus-daily-milestone-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'focus-daily-milestone-title');
    const head = document.createElement('header');
    const heading = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.textContent = T('累计目标') + ' · ' + targetDays + T('天');
    const title = document.createElement('h2');
    title.id = 'focus-daily-milestone-title';
    title.textContent = T('高级设置');
    heading.append(eyebrow, title);
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.action = 'daily-milestone-cancel';
    close.setAttribute('aria-label', T('关闭高级设置'));
    close.textContent = '×';
    head.append(heading, close);
    const intro = document.createElement('p');
    intro.className = 'focus-daily-milestone-intro';
    intro.textContent = T('把累计目标拆成有名字的小目标。达成状态会根据累计打卡天数自动点亮。');
    const list = document.createElement('div');
    list.className = 'focus-daily-milestone-list';
    list.dataset.role = 'daily-milestone-list';
    const error = document.createElement('p');
    error.className = 'focus-daily-milestone-error';
    error.dataset.role = 'daily-milestone-error';
    error.setAttribute('aria-live', 'polite');
    const footer = document.createElement('footer');
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'focus-daily-milestone-add';
    add.dataset.action = 'daily-milestone-add';
    const footerActions = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'focus-daily-milestone-cancel';
    cancel.dataset.action = 'daily-milestone-cancel';
    cancel.textContent = T('取消');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'focus-daily-milestone-confirm';
    confirm.dataset.action = 'daily-milestone-confirm';
    confirm.textContent = T('确定');
    footerActions.append(cancel, confirm);
    footer.append(add, footerActions);
    dialog.append(head, intro, list, error, footer);
    shell.appendChild(dialog);
    root.appendChild(shell);
    dailyMilestoneDialog = shell;
    dailyMilestoneDialogDraft.forEach((item) => appendDailyMilestoneDraftRow(item, false));
    updateDailyMilestoneAddState();
    requestAnimationFrame(() => shell.classList.add('is-open'));
    const first = shell.querySelector('input, [data-action="daily-milestone-add"]');
    if (first) first.focus();
  }
function closeDailyMilestoneDialog(apply, instant) {
    const shell = dailyMilestoneDialog;
    if (!shell) return;
    if (apply) {
      const result = readDailyMilestoneDialog();
      if (result.error) { setDailyMilestoneDialogError(result.error); return; }
      dailyEditMilestones = result.milestones;
    }
    const returnEl = dailyMilestoneReturnEl;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (shell.isConnected) shell.remove();
      if (dailyMilestoneDialog === shell) dailyMilestoneDialog = null;
      dailyMilestoneDialogDraft = [];
      dailyMilestoneReturnEl = null;
      const row = dailyListEl && dailyListEl.querySelector('.focus-daily-row[data-id="' + dailyEditId + '"]');
      const button = row && row.querySelector('[data-role="daily-edit-advanced"]');
      if (button) button.textContent = T('高级设置') + (dailyEditMilestones && dailyEditMilestones.length ? ' · ' + dailyEditMilestones.length : '');
      if (!instant && returnEl && returnEl.isConnected) returnEl.focus();
    };
    if (instant || prefersReduced) { finish(); return; }
    shell.classList.remove('is-open');
    shell.classList.add('is-closing');
    shell.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 260);
  }
function updateDailyFoot() {
    if (!dailyFootEl) return;
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    if (!dailyTasks.length || (allDailyDone() && !dailyReviewedToday())) {
      dailyFootEl.textContent = '';
      dailyFootEl.hidden = true;
      return;
    }
    const done = dailyTasks.filter((task) => task.doneToday).length;
    const mins = dailyTodayMinutesTotal();
    dailyFootEl.textContent = T('今天 ' + done + ' / ' + dailyTasks.length + ' 完成'
      + (mins > 0 ? ' · 今日已专注 ' + mins + ' 分' : ''));
    // 撤销最后一项完成时，先让完成落款自然收拢，再接回普通汇总，避免两份统计短暂叠在一起。
    dailyFootEl.hidden = dailyCelebratePhase !== 'hidden';
  }
function pulseDailyFoot() {
    if (!dailyFootEl || prefersReduced) return;
    replayClass(dailyFootEl, 'is-updating');
  }
function updateDailyCelebrateCopy() {
    if (!dailyCelebrateEl) return;
    if (dailyCelebrateTitleEl) dailyCelebrateTitleEl.textContent = T('今日清单已全部完成');
    if (dailyCelebrateSubEl) {
      const count = dailyTasks.length;
      const mins = dailyTodayMinutesTotal();
      dailyCelebrateSubEl.textContent = T('今天做完了 ' + count + ' 件事'
        + (mins > 0 ? ' · 专注 ' + mins + ' 分钟' : ''));
    }
  }
function commitDailyCelebratePhase(phase) {
    if (!dailyCelebrateEl) return;
    dailyCelebratePhase = phase;
    dailyCelebrateEl.dataset.phase = phase;
    dailyCelebrateEl.setAttribute('aria-hidden', phase === 'hidden' ? 'true' : 'false');
    if (dailyRoot) {
      dailyRoot.classList.toggle('is-celebration-open', phase === 'entering' || phase === 'visible');
      dailyRoot.classList.toggle('is-celebration-entering', phase === 'entering');
      dailyRoot.classList.toggle('is-celebration-leaving', phase === 'leaving');
    }
    if (dailyScrollEl) {
      const blocked = phase !== 'hidden';
      dailyScrollEl.toggleAttribute('inert', blocked);
      dailyScrollEl.setAttribute('aria-hidden', blocked ? 'true' : 'false');
    }
  }
function dailyCelebrateReturnTarget() {
    if (dailyCelebrateReturnId && dailyListEl) {
      const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + dailyCelebrateReturnId + '"]');
      const check = row && row.querySelector('.focus-daily-check');
      if (check) return check;
    }
    return dailyScrollEl || dailyCreateBtn || null;
  }
function focusDailyCelebrateAction(delay) {
    clearTimeout(dailyCelebrateFocusTimer);
    dailyCelebrateFocusTimer = setTimeout(() => {
      dailyCelebrateFocusTimer = 0;
      if (dailyCelebratePhase === 'hidden' || !pageActive()) return;
      if (dailyReviewBtn) {
        try { dailyReviewBtn.focus({ preventScroll: true }); }
        catch (e) { dailyReviewBtn.focus(); }
      }
    }, Math.max(0, Number(delay) || 0));
  }
function restoreDailyCelebrateFocus() {
    const target = dailyCelebrateReturnTarget();
    dailyCelebrateReturnId = '';
    if (!target || !target.isConnected || !pageActive()) return;
    try { target.focus({ preventScroll: true }); }
    catch (e) { target.focus(); }
  }
function showDailyCelebrate(animate) {
    if (!dailyCelebrateEl) return;
    updateDailyCelebrateCopy();
    if (dailyReviewedToday()) {
      hideDailyCelebrate({ instant: true, restoreFocus: false });
      return;
    }

    // 接口回包会再次同步同一份完成态。进入动画尚未结束时只更新文案，
    // 不能递增 generation、清计时器或移除 is-entering，否则动画会被截成硬切。
    if (dailyCelebratePhase === 'entering' || dailyCelebratePhase === 'visible') return;

    const generation = ++dailyCelebrateGeneration;
    clearTimeout(dailyCelebrateMotionTimer);
    clearTimeout(dailyCelebrateHideTimer);
    clearTimeout(dailyCelebrateFocusTimer);
    dailyCelebrateMotionTimer = 0;
    dailyCelebrateHideTimer = 0;
    dailyCelebrateFocusTimer = 0;
    dailyCelebrateEl.classList.remove('is-leaving', 'is-static');

    if (!animate || prefersReduced) {
      dailyCelebrateEl.classList.remove('is-entering');
      dailyCelebrateEl.classList.add('is-visible', 'is-static');
      commitDailyCelebratePhase('visible');
      // is-static 只屏蔽这一次恢复的 transition；可见状态不变后再移除不会补播动画。
      requestAnimationFrame(() => {
        if (generation !== dailyCelebrateGeneration || !dailyCelebrateEl) return;
        dailyCelebrateEl.classList.remove('is-static');
      });
      return;
    }

    dailyCelebrateEl.classList.remove('is-entering');
    void dailyCelebrateEl.offsetWidth;
    dailyCelebrateEl.classList.add('is-visible', 'is-entering');
    commitDailyCelebratePhase('entering');
    focusDailyCelebrateAction(1720);
    dailyCelebrateMotionTimer = setTimeout(() => {
      if (generation !== dailyCelebrateGeneration || !dailyCelebrateEl) return;
      dailyCelebrateEl.classList.remove('is-entering');
      commitDailyCelebratePhase('visible');
      dailyCelebrateMotionTimer = 0;
    }, 2360);
  }
function hideDailyCelebrate(options) {
    const opts = options || {};
    if (!dailyCelebrateEl) return;
    if (dailyCelebratePhase === 'hidden') {
      commitDailyCelebratePhase('hidden');
      updateDailyFoot();
      if (opts.restoreFocus) restoreDailyCelebrateFocus();
      return;
    }
    const generation = ++dailyCelebrateGeneration;
    clearTimeout(dailyCelebrateMotionTimer);
    clearTimeout(dailyCelebrateHideTimer);
    clearTimeout(dailyCelebrateFocusTimer);
    dailyCelebrateMotionTimer = 0;
    dailyCelebrateHideTimer = 0;
    dailyCelebrateFocusTimer = 0;
    dailyCelebrateEl.classList.remove('is-entering', 'is-static');
    if (prefersReduced || opts.instant) {
      dailyCelebrateEl.classList.remove('is-visible', 'is-leaving');
      commitDailyCelebratePhase('hidden');
      updateDailyFoot();
      if (opts.restoreFocus) restoreDailyCelebrateFocus();
      return;
    }
    dailyCelebrateEl.classList.add('is-leaving');
    dailyCelebrateEl.classList.remove('is-visible');
    commitDailyCelebratePhase('leaving');
    dailyCelebrateHideTimer = setTimeout(() => {
      if (generation !== dailyCelebrateGeneration || !dailyCelebrateEl) return;
      dailyCelebrateEl.classList.remove('is-leaving');
      commitDailyCelebratePhase('hidden');
      dailyCelebrateHideTimer = 0;
      updateDailyFoot();
      if (opts.restoreFocus) restoreDailyCelebrateFocus();
    }, 280);
  }
function reviewDailyCelebration() {
    if (!allDailyDone()) {
      hideDailyCelebrate({ restoreFocus: true });
      return;
    }
    setDailyReviewedToday(true);
    hideDailyCelebrate({ restoreFocus: true });
  }
function makeDailyDragGhost(row, rect) {
    const ghost = row.cloneNode(true);
    ghost.classList.add('focus-daily-ghost');
    ghost.classList.remove('is-dragging', 'is-entering', 'is-complete-pop', 'is-reopen-pop');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    return ghost;
  }
function positionDailyDragGhost(x, y) {
    if (!dailyDrag || !dailyDrag.ghost) return;
    const left = x - dailyDrag.offsetX;
    const top = y - dailyDrag.offsetY;
    dailyDrag.ghost.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale(1.025)';
    dailyDrag.ghost.dataset.dragLeft = String(left);
    dailyDrag.ghost.dataset.dragTop = String(top);
  }
function activateDailyPointerDrag() {
    if (!dailyDrag || dailyDrag.active) return;
    const d = dailyDrag;
    try { d.row.setPointerCapture(d.pointerId); } catch (e) {}
    d.ghost = makeDailyDragGhost(d.row, d.rect);
    d.row.classList.add('is-dragging');
    if (d.kind === 'group') {
      // 拖整组时把它的子树一并淡出，暗示「整块在搬」
      dailyListEl.querySelectorAll('.focus-daily-row, .focus-daily-group').forEach((row) => {
        if (row === d.row) return;
        const gid = dailyRowIsGroup(row) ? row.dataset.groupId : (row.dataset.groupId || '');
        if (d.subtree.has(gid)) row.classList.add('is-drag-subtree');
      });
    }
    if (document.body) document.body.classList.add('focus-daily-dragging');
    d.active = true;
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    positionDailyDragGhost(d.startX, d.startY);
  }
function dailyRowIsGroup(el) { return !!el && el.classList.contains('focus-daily-group'); }
function dailyResolvedParent(el) {
    if (!el) return '';
    return dailyRowIsGroup(el) ? ((dailyGroupById(el.dataset.groupId) || {}).parentId || '') : (el.dataset.groupId || '');
  }
function dailyDepthOf(parentId) {
    let d = 0;
    let cur = parentId || '';
    const guard = new Set();
    while (cur && !guard.has(cur)) { guard.add(cur); d += 1; cur = (dailyGroupById(cur) || {}).parentId || ''; }
    return d;   // = 子项的渲染缩进层级（根的子项 = 0）
  }
function dailyGroupSubtreeIds(gid) {
    const set = new Set([gid]);
    const stack = [gid];
    while (stack.length) {
      const cur = stack.pop();
      dailyChildGroups(cur).forEach((g) => { if (!set.has(g.id)) { set.add(g.id); stack.push(g.id); } });
    }
    return set;
  }
function dailyGroupSubtreeHeight(gid) {
    let h = 1;
    dailyChildGroups(gid).forEach((g) => { h = Math.max(h, 1 + dailyGroupSubtreeHeight(g.id)); });
    return h;
  }
function dailyDragRows() {
    // 参与命中计算的可见行：排除被拖项；拖整组时连它整棵子树一起排除（天然防成环）
    return Array.prototype.slice.call(dailyListEl.querySelectorAll('.focus-daily-row, .focus-daily-group'))
      .filter((row) => {
        if (row === dailyDrag.row) return false;
        if (row.closest('.focus-daily-group-children-inner[inert]')) return false;   // 折叠分组里的隐藏行不参与命中
        if (dailyDrag.kind === 'group') {
          const gid = dailyRowIsGroup(row) ? row.dataset.groupId : (row.dataset.groupId || '');
          if (dailyDrag.subtree.has(gid)) return false;
        }
        return true;
      });
  }
const DAILY_INDENT_PX = 16;
function dailyRowDepth(el) { return el ? dailyDepthOf(dailyResolvedParent(el)) : 0; }
function dailyParentAtDepth(prevEl, depth) {
    if (depth <= 0 || !prevEl) return '';
    let gid = dailyRowIsGroup(prevEl) ? prevEl.dataset.groupId : (prevEl.dataset.groupId || '');
    let guard = 0;
    while (gid && guard++ < 64) {
      const cd = dailyDepthOf(gid);   // gid 的子项所在层级
      if (cd === depth) return gid;
      if (cd < depth) break;
      gid = (dailyGroupById(gid) || {}).parentId || '';
    }
    return '';
  }
function computeDailyDropTarget(x, y) {
    if (!dailyDrag || !dailyListEl) return null;
    const rows = dailyDragRows();
    let slot = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { slot = i; break; }
    }
    const prev = slot > 0 ? rows[slot - 1] : null;       // 间隙上方行 → 定层级上限与父级链
    const next = slot < rows.length ? rows[slot] : null; // 间隙下方行 → 定层级下限与同级后继
    const draggingGroup = dailyDrag.kind === 'group';
    // 合法层级区间：上限看 prev（组→层级+1=进组；任务→其层级=同级），下限看 next（其层级；末尾=0）
    let maxDepth = !prev ? 0 : (dailyRowIsGroup(prev) ? dailyRowDepth(prev) + 1 : dailyRowDepth(prev));
    let minDepth = next ? dailyRowDepth(next) : 0;
    if (draggingGroup) {   // 拖整组：目标层级 + 子树高度不得超过总深限
      const room = DAILY_DEPTH_MAX - dailyGroupSubtreeHeight(dailyDrag.id);
      if (maxDepth > room) maxDepth = room;
    }
    if (minDepth > maxDepth) minDepth = maxDepth;
    const valid = maxDepth >= 0 && minDepth <= maxDepth;
    // 横向位移（相对按下点）定层级，夹进区间
    const dx = (Number.isFinite(x) ? x : dailyDrag.startX) - dailyDrag.startX;
    const want = dailyRowDepth(dailyDrag.row) + Math.round(dx / DAILY_INDENT_PX);
    const depth = Math.max(minDepth, Math.min(maxDepth, want));
    const parentId = dailyParentAtDepth(prev, depth);
    // beforeId：slot 起往后找「同类型 + 同父级」最近一行 = 落点的后一个同级；找不到 = 并到该父级同类末尾
    let beforeId = '';
    for (let i = slot; i < rows.length; i++) {
      const r = rows[i];
      if (dailyRowIsGroup(r) === draggingGroup && dailyResolvedParent(r) === parentId) {
        beforeId = draggingGroup ? r.dataset.groupId : r.dataset.id;
        break;
      }
    }
    return { parentId: parentId, beforeId: beforeId, depth: depth, valid: valid, next: next };
  }
function ensureDailyDropLine() {
    if (dailyDrag && dailyDrag.line) return dailyDrag.line;
    const line = document.createElement('div');
    line.className = 'focus-daily-drop-line';
    if (dailyDrag) dailyDrag.line = line;
    return line;
  }
function clearDailyDropInto() {
    if (dailyDrag && dailyDrag.intoEl) { dailyDrag.intoEl.classList.remove('is-drop-into'); dailyDrag.intoEl = null; }
  }
function dailyFirstVisibleTaskEl(parentId) {
    const tasks = dailyDirectTasks(parentId);
    for (let i = 0; i < tasks.length; i++) {
      const el = dailyListEl.querySelector('.focus-daily-row[data-id="' + tasks[i].id + '"]');
      if (el && !el.closest('.focus-daily-group-children-inner[inert]')) return el;
    }
    return null;
  }
function dailyDropLineAnchor(t) {
    const draggingGroup = dailyDrag.kind === 'group';
    if (t.beforeId) {
      return dailyListEl.querySelector(draggingGroup
        ? '.focus-daily-group[data-group-id="' + t.beforeId + '"]'
        : '.focus-daily-row[data-id="' + t.beforeId + '"]');
    }
    // 并到父级同类末尾：拖组排在父级「任务区之前」→ 锚到父级首个可见任务；否则锚到父级子树之后那行
    if (draggingGroup) {
      const ft = dailyFirstVisibleTaskEl(t.parentId);
      if (ft) return ft;
    }
    return t.next || null;
  }
function updateDailyDropIndicator() {
    if (!dailyDrag || !dailyDrag.active) return;
    if (dailyDrag.line && dailyDrag.line.parentNode) dailyDrag.line.parentNode.removeChild(dailyDrag.line); // 先摘，免得影响测量
    clearDailyDropInto();
    const t = computeDailyDropTarget(dailyDrag.pendingX, dailyDrag.pendingY);
    dailyDrag.drop = t;
    if (!t || !t.valid) return;
    if (t.parentId) {   // 强反馈：高亮「将落入」的分组头
      const head = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + t.parentId + '"]');
      if (head) { head.classList.add('is-drop-into'); dailyDrag.intoEl = head; }
    }
    const line = ensureDailyDropLine();
    line.style.setProperty('--daily-depth', String(Math.min(t.depth, 5)));
    line.classList.toggle('is-into', !!t.parentId);
    const anchor = dailyDropLineAnchor(t);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(line, anchor);   // 锚点可能在嵌套容器里
    else dailyListEl.appendChild(line);
  }
function scheduleDailyDragTarget(x, y) {
    if (!dailyDrag) return;
    dailyDrag.pendingX = x;
    dailyDrag.pendingY = y;
    if (dailyDrag.targetRaf) return;
    dailyDrag.targetRaf = requestAnimationFrame(() => {
      if (!dailyDrag) return;
      dailyDrag.targetRaf = 0;
      updateDailyDropIndicator();
    });
  }
function dailyReorderLocal(arr, item, parentId, beforeId, parentKey) {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
    if (beforeId) {
      const bi = arr.findIndex((x) => x.id === beforeId);
      if (bi >= 0) { arr.splice(bi, 0, item); return; }
    }
    let lastIdx = -1;   // 没有精确锚点：并到该父级下同类的末尾
    arr.forEach((x, idx) => { if ((x[parentKey] || '') === (parentId || '')) lastIdx = idx; });
    if (lastIdx >= 0) arr.splice(lastIdx + 1, 0, item);
    else arr.push(item);
  }
function applyDailyDrop(d, t) {
    if (d.kind === 'task') {
      const task = dailyTasks.find((x) => x.id === d.id);
      if (!task) return false;
      task.groupId = t.parentId;
      dailyReorderLocal(dailyTasks, task, t.parentId, t.beforeId, 'groupId');
    } else {
      const group = dailyGroupById(d.id);
      if (!group) return false;
      group.parentId = t.parentId;
      dailyReorderLocal(dailyGroups, group, t.parentId, t.beforeId, 'parentId');
    }
    // 拖入折叠分组「不」自动展开（用户偏好）：项已入组、进度徽标会更新，展开即见
    return true;
  }
function postDailyTree() {
    const groups = dailyGroups.map((g) => ({ id: g.id, parentId: g.parentId || '', collapsed: !!g.collapsed }));
    const tasks = dailyTasks.map((t) => ({ id: t.id, groupId: t.groupId || '' }));
    post('/api/daily-tree', { groups: groups, tasks: tasks })
      .then((json) => { applyDailyPayload(json); })
      .catch((error) => { toast(error.message || '移动失败'); loadDaily(); });   // 失败就从服务端拉回真值还原
  }
function finishDailyDragVisual(d, targetRow) {
    const row = targetRow && targetRow.isConnected ? targetRow : null;
    // 真身淡入：WAAPI 补间 opacity 0.18→1 与幽灵淡出交叉，消除瞬跳
    if (row) {
      row.classList.remove('is-dragging');
      if (!prefersReduced) {
        row.animate([{ opacity: 0.18 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
      }
    }
    const cleanup = () => { if (d && d.ghost) d.ghost.remove(); };
    if (!d || !d.ghost || !row || prefersReduced) { cleanup(); return; }
    const target = row.getBoundingClientRect();
    const startLeft = Number(d.ghost.dataset.dragLeft);
    const startTop = Number(d.ghost.dataset.dragTop);
    const fromL = Number.isFinite(startLeft) ? startLeft : target.left;
    const fromT = Number.isFinite(startTop) ? startTop : target.top;
    const start = d.ghost.style.transform || ('translate3d(' + fromL + 'px,' + fromT + 'px,0) scale(1.025)');
    const end = 'translate3d(' + target.left + 'px,' + target.top + 'px,0) scale(1)';
    const dist = Math.hypot(target.left - fromL, target.top - fromT);
    const duration = Math.max(220, Math.min(420, 180 + dist * 0.22));
    // 幽灵：先飞到落点（~62%），再就地淡出；和真身淡入交叉 → 不再「瞬间消失」
    const animation = d.ghost.animate([
      { transform: start, opacity: 1 },
      { transform: end, opacity: 1, offset: 0.62 },
      { transform: end, opacity: 0 },
    ], { duration: duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
    animation.finished.catch(() => undefined).then(cleanup);
  }
function endDailyPointerDrag(event, commit) {
    if (!dailyDrag) return;
    window.removeEventListener('pointermove', onDailyPointerMove);
    window.removeEventListener('pointerup', onDailyPointerUp);
    window.removeEventListener('pointercancel', onDailyPointerCancel);
    const d = dailyDrag;
    if (d.targetRaf) cancelAnimationFrame(d.targetRaf);
    let t = null;
    if (d.active && commit) {
      if (event && Number.isFinite(event.clientY)) { d.pendingX = event.clientX; d.pendingY = event.clientY; }
      t = d.drop || computeDailyDropTarget(d.pendingX, d.pendingY);   // 用最后一帧预览的落点=松手即所见；无预览才退而重算
    }
    if (d.line && d.line.parentNode) d.line.parentNode.removeChild(d.line);
    clearDailyDropInto();
    dailyDrag = null;
    try { d.row.releasePointerCapture(d.pointerId); } catch (e) {}
    if (!d.active) {
      if (d.ghost) d.ghost.remove();
      return;
    }
    if (event && event.preventDefault) event.preventDefault();
    if (document.body) document.body.classList.remove('focus-daily-dragging');
    if (!commit && !event) {
      if (d.ghost) d.ghost.remove();
      if (dailyListEl) {
        dailyListEl.querySelectorAll('.is-dragging, .is-drag-subtree').forEach((element) => {
          element.classList.remove('is-dragging', 'is-drag-subtree');
        });
      }
      return;
    }
    dailySuppressClick = true;
    setTimeout(() => { dailySuppressClick = false; }, 0);
    const changed = !!(t && t.valid) && applyDailyDrop(d, t);
    const previous = captureDailyRowRects();
    rebuildDailyRows({ flip: false });
    const sel = d.kind === 'group'
      ? '.focus-daily-group[data-group-id="' + d.id + '"]'
      : '.focus-daily-row[data-id="' + d.id + '"]';
    const newRow = dailyListEl.querySelector(sel);
    if (newRow) newRow.classList.add('is-dragging');   // 飞行期间藏住真身，避免重影；下方行照常 FLIP
    animateDailyListMoves(previous, { duration: 280 });
    if (changed) { updateDailyFoot(); pulseDailyFoot(); updateDailyComposeUI(); postDailyTree(); }
    finishDailyDragVisual(d, newRow);
  }
function onDailyPointerMove(event) {
    if (!dailyDrag || event.pointerId !== dailyDrag.pointerId) return;
    const dx = event.clientX - dailyDrag.startX;
    const dy = event.clientY - dailyDrag.startY;
    if (!dailyDrag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      activateDailyPointerDrag();
    }
    event.preventDefault();
    positionDailyDragGhost(event.clientX, event.clientY);
    scheduleDailyDragTarget(event.clientX, event.clientY);
  }
function onDailyPointerUp(event) {
    endDailyPointerDrag(event, true);
  }
function onDailyPointerCancel(event) {
    endDailyPointerDrag(event, false);
  }
function onDailyPointerDown(event) {
    const milestone = event.target.closest('.focus-daily-milestone');
    if (milestone) {
      event.stopPropagation();
      if (event.pointerType === 'mouse') event.preventDefault();
      return;
    }
    if (event.button !== 0 || dailyEditId || dailyGroupEditId || dailyConfirmDeleteId
        || dailyGroupConfirmDeleteId || dailyDrag) return;
    // 这些控件是纯点击，不从它们起拖（勾选 / 编辑器内部 / 折叠箭头 / ⋯菜单）
    if (event.target.closest('[data-role="daily-check"], [data-role="daily-menu"], .focus-daily-edit, .focus-daily-milestone, [data-role="daily-group-toggle"], [data-role="daily-group-menu"]')) return;
    const taskRow = event.target.closest('.focus-daily-row');
    const groupRow = taskRow ? null : event.target.closest('.focus-daily-group');
    const el = taskRow || groupRow;
    if (!el || !dailyListEl || !dailyListEl.contains(el)) return;
    const kind = taskRow ? 'task' : 'group';
    const rect = el.getBoundingClientRect();
    dailyDrag = {
      kind: kind,
      id: kind === 'task' ? el.dataset.id : el.dataset.groupId,
      subtree: kind === 'group' ? dailyGroupSubtreeIds(el.dataset.groupId) : null,
      row: el,
      ghost: null,
      line: null,
      drop: null,
      pointerId: event.pointerId,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      rect: rect,
      targetRaf: 0,
      pendingX: event.clientX,
      pendingY: event.clientY,
    };
    listen(window, 'pointermove', onDailyPointerMove);
    listen(window, 'pointerup', onDailyPointerUp);
    listen(window, 'pointercancel', onDailyPointerCancel);
  }
function openDailyEdit(id) {
    const task = dailyTasks.find((item) => item.id === id);
    dailyEditId = id;
    dailyEditMilestones = cloneDailyMilestones(task && task.milestones);
    dailyConfirmDeleteId = '';
    rebuildDailyRows({ flip: true });
    const input = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"] .focus-daily-edit-name');
    if (input) { input.focus(); input.select(); }
  }
function closeDailyEdit() {
    if (!dailyEditId) return;
    if (dailyMilestoneDialog) closeDailyMilestoneDialog(false, true);
    const id = dailyEditId;
    const edit = dailyListEl
      ? dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"] .focus-daily-edit')
      : null;
    const finish = () => {
      if (dailyEditId !== id) return;
      dailyEditId = '';
      dailyEditMilestones = null;
      dailyConfirmDeleteId = '';
      rebuildDailyRows({ flip: true });
    };
    if (!edit || prefersReduced) { finish(); return; }
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      edit.removeEventListener('animationend', complete);
      finish();
    };
    edit.classList.add('is-closing');
    edit.addEventListener('animationend', complete);
    setTimeout(complete, 310);
  }
function commitDailyEdit(id) {
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    if (!row) { dailyEditId = ''; return; }
    const nameIn = row.querySelector('.focus-daily-edit-name');
    const targetIn = row.querySelector('.focus-daily-edit-min');
    const goalIn = row.querySelector('.focus-daily-edit-days');
    const name = (nameIn ? nameIn.value : '').trim();
    if (!name) { if (nameIn) nameIn.focus(); toast('名称不能为空'); return; }
    const task = dailyTasks.find((item) => item.id === id);
    // 「今日目标」输入隐藏时沿用已有值，避免编辑其他字段误把目标清零（开关见 DAILY_TARGET_UI_HIDDEN）
    const target = Math.max(0, Math.min(600, parseInt(
      targetIn ? targetIn.value : String(Number(task && task.targetMinutes) || 0), 10) || 0));
    const targetDays = Math.max(0, Math.min(3660, parseInt(goalIn ? goalIn.value : '0', 10) || 0));
    const milestones = cloneDailyMilestones(dailyEditMilestones);
    if (milestones.length && !targetDays) {
      if (goalIn) goalIn.focus();
      toast(T('请先移除小目标，再清除累计目标'));
      return;
    }
    const over = milestones.find((item) => item.days > targetDays);
    if (over) {
      if (goalIn) goalIn.focus();
      toast('「' + over.name + '」' + T('不能超过累计目标'));
      return;
    }
    const groupSel = row.querySelector('[data-role="daily-edit-group"]');
    const body = { id: id, name: name, targetMinutes: target, targetDays: targetDays, milestones: milestones };
    if (groupSel) body.groupId = groupSel.value || '';
    const edit = row.querySelector('.focus-daily-edit');
    if (edit && edit.classList.contains('is-saving')) return;
    if (edit) edit.classList.add('is-saving');
    post('/api/daily-update', body)
      .then((json) => {
        dailyEditId = '';
        dailyEditMilestones = null;
        dailyConfirmDeleteId = '';
        applyDailyPayload(json);
        renderDaily();

      })
      .catch((error) => {
        if (edit) edit.classList.remove('is-saving');
        toast(error.message);
      });
  }
function requestDeleteDaily(id) {
    // 二次确认：把编辑器就地切到「确认删除？」，不弹原生 confirm
    dailyConfirmDeleteId = id;
    rebuildDailyRows({ flip: true });
  }
function cancelDeleteDaily() {
    dailyConfirmDeleteId = '';
    rebuildDailyRows({ flip: true });
  }
function performDeleteDaily(id) {
    if (dailyMilestoneDialog) closeDailyMilestoneDialog(false, true);
    dailyConfirmDeleteId = '';
    dailyEditId = '';
    dailyEditMilestones = null;
    rebuildDailyRows({ flip: true });   // 先收起确认编辑器，行回到常态，再滑出收拢
    const send = () => post('/api/daily-delete', { id: id })
      .then((json) => { applyDailyPayload(json); renderDaily(); toast('已删除'); })
      .catch((error) => { renderDaily(); toast(error.message); });
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    if (row && !prefersReduced) {
      row.classList.add('is-removing');
      let sent = false;
      const fire = () => { if (!sent) { sent = true; send(); } };
      row.addEventListener('animationend', fire, { once: true });
      deferMutation(fire, 400);
    } else {
      send();
    }
  }
function createDailyTask(name, groupId) {
    name = (name || '').trim();
    if (!name || dailyCreatePending) return;
    setDailyCreatePending(true);
    const prevIds = dailyTasks.map((task) => task.id);
    post('/api/daily-create', { name: name, groupId: groupId || '' })
      .then((json) => {
        applyDailyPayload(json);
        const fresh = dailyTasks.find((task) => prevIds.indexOf(task.id) < 0);
        dailyEnterId = fresh ? fresh.id : '';
        if (dailyInputEl) dailyInputEl.value = '';
        setDailyCreatePending(false);
        closeDailyComposer({ focus: true });
        renderDaily();

      })
      .catch((error) => {
        setDailyCreatePending(false);
        toast(error.message);
        if (dailyInputEl) dailyInputEl.focus();
      });
  }
function playGroupExpandStagger(wrap) {
    if (!wrap || prefersReduced) return;
    const inner = wrap.querySelector(':scope > .focus-daily-group-children > .focus-daily-group-children-inner');
    if (!inner) return;
    const kids = Array.prototype.slice.call(inner.children)
      .filter((el) => el.classList.contains('focus-daily-row') || el.classList.contains('focus-daily-group'));
    if (!kids.length) return;
    kids.forEach((el, i) => el.style.setProperty('--daily-expand-index', String(i)));
    wrap.classList.add('is-expanding');
    clearTimeout(dailyExpandTimers.get(wrap));
    dailyExpandTimers.set(wrap, setTimeout(() => {
      wrap.classList.remove('is-expanding');
      kids.forEach((el) => el.style.removeProperty('--daily-expand-index'));
    }, 460 + kids.length * 66));
  }
function playGroupCollapseStagger(wrap) {
    if (!wrap || prefersReduced) return;
    const inner = wrap.querySelector(':scope > .focus-daily-group-children > .focus-daily-group-children-inner');
    if (!inner) return;
    const kids = Array.prototype.slice.call(inner.children)
      .filter((el) => el.classList.contains('focus-daily-row') || el.classList.contains('focus-daily-group'));
    if (!kids.length) return;
    // 反向交错：最深的子项先走
    kids.reverse().forEach((el, i) => el.style.setProperty('--daily-collapse-index', String(i)));
    wrap.classList.add('is-collapsing');
    clearTimeout(dailyExpandTimers.get(wrap));
    dailyExpandTimers.set(wrap, setTimeout(() => {
      wrap.classList.remove('is-collapsing');
      kids.forEach((el) => el.style.removeProperty('--daily-collapse-index'));
    }, 220 + kids.length * 40));
  }
function setDailyGroupCollapsed(gid, collapsed) {
    const group = dailyGroupById(gid);
    if (!group) return;
    const previous = !!group.collapsed;
    group.collapsed = collapsed;
    const wrap = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"]');
    if (wrap) {
      // 只切 class，让 CSS grid-rows 平滑收合（不重建 → 不瞬移，箭头也随常驻元素平滑旋转）
      wrap.classList.toggle('is-collapsed', collapsed);
      const toggle = wrap.querySelector(':scope > .focus-daily-group-head [data-role="daily-group-toggle"]');
      if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const inner = wrap.querySelector(':scope > .focus-daily-group-children > .focus-daily-group-children-inner');
      if (inner) inner.toggleAttribute('inert', collapsed);
      if (collapsed) {
        wrap.classList.remove('is-expanding');
        clearTimeout(dailyExpandTimers.get(wrap));
        playGroupCollapseStagger(wrap);
      } else {
        playGroupExpandStagger(wrap);
      }
    } else {
      rebuildDailyRows({ flip: false });
    }

    post('/api/daily-group-update', { id: gid, collapsed: collapsed })
      .then((json) => applyDailyPayload(json))
      .catch((error) => {
        const current = dailyGroupById(gid);
        if (current) current.collapsed = previous;
        rebuildDailyRows({ flip: true });
        toast(error.message || '分组状态保存失败');
      });
  }
function toggleDailyGroupCollapse(gid) {
    const group = dailyGroupById(gid);
    if (group) setDailyGroupCollapsed(gid, !group.collapsed);
  }
function openDailyGroupEdit(gid) {
    dailyEditId = '';
    dailyConfirmDeleteId = '';
    dailyGroupConfirmDeleteId = '';
    dailyGroupEditId = gid;
    rebuildDailyRows({ flip: true });
    const input = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"] [data-role="daily-group-edit-name"]');
    if (input) { input.focus(); input.select(); }
  }
function toggleDailyGroupEdit(gid) {
    if (dailyGroupEditId === gid) closeDailyGroupEdit();
    else openDailyGroupEdit(gid);
  }
function closeDailyGroupEdit() {
    if (!dailyGroupEditId) return;
    const gid = dailyGroupEditId;
    const edit = dailyListEl
      ? dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"] .focus-daily-group-edit')
      : null;
    const finish = () => {
      if (dailyGroupEditId !== gid) return;
      dailyGroupEditId = '';
      dailyGroupConfirmDeleteId = '';
      rebuildDailyRows({ flip: true });
    };
    if (!edit || prefersReduced) { finish(); return; }
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      edit.removeEventListener('animationend', complete);
      finish();
    };
    edit.classList.add('is-closing');
    edit.addEventListener('animationend', complete);
    setTimeout(complete, 310);
  }
function commitDailyGroupEdit(gid) {
    const wrap = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"]');
    if (!wrap) { dailyGroupEditId = ''; return; }
    const nameIn = wrap.querySelector('[data-role="daily-group-edit-name"]');
    const name = (nameIn ? nameIn.value : '').trim();
    if (!name) { if (nameIn) nameIn.focus(); toast('分组名不能为空'); return; }
    const edit = wrap.querySelector('.focus-daily-group-edit');
    if (edit && edit.classList.contains('is-saving')) return;
    if (edit) edit.classList.add('is-saving');
    post('/api/daily-group-update', { id: gid, name: name })
      .then((json) => {
        dailyGroupEditId = '';
        dailyGroupConfirmDeleteId = '';
        applyDailyPayload(json);
        renderDaily();

      })
      .catch((error) => {
        if (edit) edit.classList.remove('is-saving');
        toast(error.message);
        if (nameIn) nameIn.focus();
      });
  }
function requestDeleteDailyGroup(gid) {
    dailyGroupConfirmDeleteId = gid;
    rebuildDailyRows({ flip: true });
  }
function cancelDeleteDailyGroup() {
    dailyGroupConfirmDeleteId = '';
    rebuildDailyRows({ flip: true });
  }
function performDeleteDailyGroup(gid) {
    dailyGroupConfirmDeleteId = '';
    dailyGroupEditId = '';
    if (dailyAddTargetGroup === gid) { dailyAddTargetGroup = ''; updateDailyComposeUI(); }
    const send = () => post('/api/daily-group-delete', { id: gid })
      .then((json) => { applyDailyPayload(json); renderDaily(); toast('已删除分组'); })
      .catch((error) => { renderDaily(); toast(error.message); });
    const wrap = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"]');
    if (wrap && !prefersReduced) {
      wrap.classList.add('is-removing');   // 组头滑出收拢，落库后子项 FLIP 上提
      deferMutation(send, 300);
    } else {
      send();
    }
  }
function createDailyGroup(name, parentId) {
    name = (name || '').trim();
    if (!name || dailyCreatePending) return;
    setDailyCreatePending(true);
    const prevIds = dailyGroups.map((g) => g.id);
    post('/api/daily-group-create', { name: name, parentId: parentId || '' })
      .then((json) => {
        applyDailyPayload(json);
        const fresh = dailyGroups.find((g) => prevIds.indexOf(g.id) < 0);
        dailyEnterId = fresh ? fresh.id : '';
        if (dailyInputEl) dailyInputEl.value = '';
        dailyComposeMode = 'task';
        dailyAddTargetGroup = '';
        setDailyCreatePending(false);
        closeDailyComposer({ focus: true });
        renderDaily();

      })
      .catch((error) => {
        setDailyCreatePending(false);
        toast(error.message);
        if (dailyInputEl) dailyInputEl.focus();
      });
  }
function openDailyComposer(mode, targetGroupId) {
    dailyComposerOpen = true;
    dailyComposerCloseSeq += 1;
    clearTimeout(dailyComposerCloseTimer);
    dailyComposerCloseTimer = 0;
    if (dailyComposerEl) {
      dailyComposerEl.classList.remove('is-closing');
      dailyComposerEl.style.removeProperty('--daily-composer-height');
      dailyComposerEl.style.removeProperty('--daily-composer-margin-top');
      dailyComposerEl.hidden = false;
    }
    if (dailyCreateBtn) dailyCreateBtn.setAttribute('aria-expanded', 'true');
    setDailyCompose(mode || dailyComposeMode, targetGroupId == null ? dailyAddTargetGroup : targetGroupId);
  }
function closeDailyComposer(options) {
    const opts = options || {};
    const composer = dailyComposerEl;
    const closeSeq = ++dailyComposerCloseSeq;
    dailyComposerOpen = false;
    dailyAddTargetGroup = '';
    dailyComposeMode = 'task';
    if (dailyCreateBtn) dailyCreateBtn.setAttribute('aria-expanded', 'false');
    clearTimeout(dailyComposerCloseTimer);
    const finish = () => {
      if (composer) composer.removeEventListener('animationend', onEnd);
      if (closeSeq !== dailyComposerCloseSeq) return;
      clearTimeout(dailyComposerCloseTimer);
      dailyComposerCloseTimer = 0;
      if (composer) {
        composer.classList.remove('is-closing');
        composer.style.removeProperty('--daily-composer-height');
        composer.style.removeProperty('--daily-composer-margin-top');
        composer.hidden = true;
      }
      if (dailyInputEl) dailyInputEl.value = '';
      updateDailyComposeUI();
      if (opts.focus !== false && dailyCreateBtn && dailyCreateBtn.isConnected) {
        try { dailyCreateBtn.focus({ preventScroll: true }); } catch (e) { dailyCreateBtn.focus(); }
      }
    };
    const onEnd = (event) => {
      if (event.target === composer) finish();
    };
    if (!composer || composer.hidden || prefersReduced || opts.instant) {
      finish();
      return;
    }
    const composerStyle = window.getComputedStyle(composer);
    composer.style.setProperty('--daily-composer-height', composer.offsetHeight + 'px');
    composer.style.setProperty('--daily-composer-margin-top', composerStyle.marginTop);
    composer.classList.add('is-closing');
    composer.addEventListener('animationend', onEnd);
    dailyComposerCloseTimer = setTimeout(finish, 300);
  }
function toggleDailyComposer() {
    if (dailyCreatePending) return;
    if (dailyComposerOpen) closeDailyComposer({ focus: true });
    else openDailyComposer('task', '');
  }
function setDailyCompose(mode, targetGroupId) {
    dailyComposerOpen = true;
    if (dailyComposerEl) dailyComposerEl.hidden = false;
    if (dailyCreateBtn) dailyCreateBtn.setAttribute('aria-expanded', 'true');
    dailyComposeMode = mode === 'group' ? 'group' : 'task';
    dailyAddTargetGroup = targetGroupId || '';
    let needRebuild = false;
    if (dailyGroupEditId || dailyEditId) {
      dailyGroupEditId = '';
      dailyEditId = '';
      dailyGroupConfirmDeleteId = '';
      dailyConfirmDeleteId = '';
      needRebuild = true;
    }
    if (dailyAddTargetGroup) {
      const g = dailyGroupById(dailyAddTargetGroup);
      if (g && g.collapsed) {            // 目标分组折叠着就先展开，让新建项可见
        g.collapsed = false;
        needRebuild = true;
        post('/api/daily-group-update', { id: g.id, collapsed: false }).catch(() => {});
      }
    }
    if (needRebuild) rebuildDailyRows({ flip: true });
    updateDailyComposeUI();
    if (dailyInputEl) dailyInputEl.focus();
  }
function updateDailyComposeUI() {
    if (dailyComposerEl) dailyComposerEl.hidden = !dailyComposerOpen;
    if (dailyCreateBtn) dailyCreateBtn.setAttribute('aria-expanded', dailyComposerOpen ? 'true' : 'false');
    const isGroup = dailyComposeMode === 'group';
    if (dailyComposeTaskBtn) {
      dailyComposeTaskBtn.classList.toggle('is-active', !isGroup);
      dailyComposeTaskBtn.setAttribute('aria-pressed', String(!isGroup));
    }
    if (dailyComposeGroupBtn) {
      dailyComposeGroupBtn.classList.toggle('is-active', isGroup);
      dailyComposeGroupBtn.setAttribute('aria-pressed', String(isGroup));
    }
    let target = dailyAddTargetGroup ? dailyGroupById(dailyAddTargetGroup) : null;
    if (dailyAddTargetGroup && !target) dailyAddTargetGroup = '';   // 目标分组已被删 → 回根
    if (dailyComposeTargetBtn) {
      if (target) {
        dailyComposeTargetBtn.hidden = false;
        dailyComposeTargetBtn.innerHTML = '';
        const label = document.createElement('span');
        label.textContent = '→ ' + dailyGroupPathLabel(target);
        const x = document.createElement('span');
        x.className = 'chip-x';
        x.textContent = '✕';
        dailyComposeTargetBtn.append(label, x);
        dailyComposeTargetBtn.setAttribute('aria-label', '取消目标分组 ' + dailyGroupPathLabel(target));
      } else {
        dailyComposeTargetBtn.hidden = true;
        dailyComposeTargetBtn.textContent = '';
      }
    }
    if (dailyInputEl) {
      dailyInputEl.placeholder = isGroup
        ? (target ? '在「' + (target.name || '分组') + '」下新建子分组…' : '新建分组名称…')
        : (target ? '在「' + (target.name || '分组') + '」下添加任务…' : '添加一件今天想坚持的事…');
    }
    if (dailySubmitBtn) dailySubmitBtn.setAttribute('aria-label', isGroup ? '添加分组' : '添加每日任务');
  }
function setDailyCreatePending(pending) {
    dailyCreatePending = !!pending;
    if (dailyComposerEl) dailyComposerEl.classList.toggle('is-pending', dailyCreatePending);
    if (dailyInputEl) dailyInputEl.disabled = dailyCreatePending;
    if (dailySubmitBtn) {
      dailySubmitBtn.disabled = dailyCreatePending;
      dailySubmitBtn.setAttribute('aria-busy', dailyCreatePending ? 'true' : 'false');
    }
    if (dailyCreateBtn) dailyCreateBtn.disabled = dailyCreatePending;
    [dailyComposeTaskBtn, dailyComposeGroupBtn, dailyComposeTargetBtn].forEach((button) => {
      if (button) button.disabled = dailyCreatePending;
    });
  }
function dailyCelebrationCheck(options) {
    const opts = options || {};
    const allDone = allDailyDone();
    const became = allDone && !dailyWasAllDone;
    dailyWasAllDone = allDone;
    if (!allDone) {
      setDailyReviewedToday(false);
      hideDailyCelebrate();
      return;
    }
    if (dailyReviewedToday()) {
      if (dailyCelebratePhase !== 'leaving') {
        hideDailyCelebrate({ instant: dailyCelebratePhase === 'hidden', restoreFocus: false });
      }
      return;
    }
    showDailyCelebrate(opts.animate === false ? false : became);
  }
function setRowDone(row, done) {
    if (!row) return;
    row.classList.toggle('is-done', done);
    const check = row.querySelector('.focus-daily-check');
    if (check) {
      const task = dailyTasks.find((item) => item.id === row.dataset.id);
      const checkLabel = (done ? '取消完成 · ' : '标记完成 · ') + (task && task.name || '每日任务');
      check.setAttribute('aria-pressed', done ? 'true' : 'false');
      // i18n 的属性观察器会保留首次见到的中文源文本；同步更新源值，
      // 避免快速勾选后把新的按钮状态翻译回旧的 “Undo / Mark done”。
      check.setAttribute('data-i18n-source-aria-label', checkLabel);
      check.setAttribute('aria-label', T(checkLabel));
    }
    if (!prefersReduced) {
      row.classList.remove('is-complete-pop', 'is-reopen-pop');
      replayClass(row, done ? 'is-complete-pop' : 'is-reopen-pop', 520);
    }
  }
function refreshDailyRowStats(task, options) {
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + task.id + '"]');
    if (!row) return;
    const stat = row.querySelector('.focus-daily-stat');
    if (stat) stat.textContent = dailyStatText(task);
    syncDailyGoalProgress(row.querySelector('.focus-daily-goal-shell'), task, options);
  }
function refreshDailyDetailGoal(task, options) {
    if (!task || dailyDetailTaskId !== task.id) return;
    const shell = getDailyDetailShell();
    if (!shell) return;
    const text = shell.querySelector('[data-role="daily-detail-goal-text"]');
    if (text) text.textContent = dailyGoalProgressText(task);
    syncDailyGoalProgress(shell.querySelector('.focus-daily-goal-shell'), task, options);
    const toggle = shell.querySelector('[data-action="daily-detail-toggle"]');
    if (toggle) {
      toggle.setAttribute('aria-pressed', task.doneToday ? 'true' : 'false');
      toggle.textContent = task.doneToday ? T('取消今日打卡') : T('今日打卡');
    }
  }
function refreshDailyDetail(task, options) {
    if (!task || dailyDetailTaskId !== task.id) return;
    const shell = getDailyDetailShell();
    if (!shell) return;
    const group = task.groupId ? dailyGroupById(task.groupId) : null;
    const meta = shell.querySelector('[data-role="daily-detail-meta"]');
    if (meta) meta.textContent = (group ? dailyGroupPathLabel(group) : T('未分组')) + ' · ' + dailyStatText(task);
    const values = {
      streak: String(Number(task.streak) || 0),
      total: String(Number(task.totalDays) || dailyDoneDateSet(task).size),
      best: String(Number(task.bestStreak) || 0),
    };
    Object.keys(values).forEach((key) => {
      const element = shell.querySelector('[data-role="daily-detail-stat-' + key + '"]');
      if (element) element.textContent = values[key];
    });
    fillDailyDetailCalendar(shell.querySelector('[data-role="daily-detail-grid"]'), task);
    fillDailyDetailHistorySummary(
      shell.querySelector('[data-role="daily-detail-recent"]'),
      shell.querySelector('[data-role="daily-detail-note"]'),
      task
    );
    refreshDailyDetailGoal(task, options);
  }
function syncDailyToggleResult(id, task) {
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    setRowDone(row, !!task.doneToday);
    refreshDailyRowStats(task);
    refreshDailyDetail(task);
    refreshDailyGroupProgress(task.groupId);
    updateDailyFoot();
    dailyCelebrationCheck();

  }
function finishDailyToggleState(id, state) {
    if (dailyToggleStates.get(id) === state) dailyToggleStates.delete(id);
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    if (row) row.classList.remove('is-syncing');
  }
function drainDailyToggle(id, state) {
    if (!state || state.inFlight || dailyToggleStates.get(id) !== state) return;
    if (!!state.desired === !!state.confirmedTask.doneToday) {
      const current = dailyTasks.find((item) => item.id === id);
      if (current) Object.assign(current, JSON.parse(JSON.stringify(state.confirmedTask)));
      dailySignature = dailyPayloadSignature({ tasks: dailyTasks, groups: dailyGroups });
      if (current) syncDailyToggleResult(id, current);
      finishDailyToggleState(id, state);
      return;
    }
    const target = !!state.desired;
    state.inFlight = true;
    post('/api/daily-toggle', { id: id, done: target }).then((json) => {
      if (dailyToggleStates.get(id) !== state) return;
      const payload = dailyPayload(json);
      const confirmed = Array.isArray(payload.tasks) ? payload.tasks.find((item) => item.id === id) : null;
      if (confirmed) state.confirmedTask = JSON.parse(JSON.stringify(confirmed));
      else state.confirmedTask.doneToday = target;
      state.inFlight = false;
      if (!!state.desired !== target) {
        drainDailyToggle(id, state);
        return;
      }
      applyDailyPayload(payload);
      const fresh = dailyTasks.find((item) => item.id === id);
      if (fresh) syncDailyToggleResult(id, fresh);
      finishDailyToggleState(id, state);
    }).catch((error) => {
      if (dailyToggleStates.get(id) !== state) return;
      state.inFlight = false;
      if (!!state.desired !== target) {
        drainDailyToggle(id, state);
        return;
      }
      const current = dailyTasks.find((item) => item.id === id);
      if (current) {
        Object.assign(current, JSON.parse(JSON.stringify(state.confirmedTask)));
        dailySignature = dailyPayloadSignature({ tasks: dailyTasks, groups: dailyGroups });
        syncDailyToggleResult(id, current);
      }
      finishDailyToggleState(id, state);
      toast(error.message);
    });
  }
function toggleDailyTask(id) {
    const task = dailyTasks.find((item) => item.id === id);
    if (!task) return;
    let state = dailyToggleStates.get(id);
    if (!state) {
      state = {
        confirmedTask: JSON.parse(JSON.stringify(task)),
        desired: !!task.doneToday,
        inFlight: false,
      };
      dailyToggleStates.set(id, state);
    }
    const want = !state.desired;
    state.desired = want;
    const prevTotalDays = Math.max(0, Number(task.totalDays) || 0);
    const targetDays = dailyGoalState(task).target;
    task.doneToday = want;
    const today = todayStr();
    const prevDates = Array.isArray(task.doneDates) ? task.doneDates.slice() : [];
    const nextDates = prevDates.slice();
    if (want && nextDates.indexOf(today) < 0) nextDates.push(today);
    task.doneDates = want ? nextDates.sort() : nextDates.filter((day) => day !== today);
    task.totalDays = want ? prevTotalDays + 1 : Math.max(0, prevTotalDays - 1);
    const reachedNow = want && targetDays > 0 && prevTotalDays < targetDays && task.totalDays >= targetDays;
    const crossedMilestones = want ? dailyMilestoneList(task)
      .filter((milestone) => prevTotalDays < milestone.days && task.totalDays >= milestone.days)
      .map((milestone) => milestone.id) : [];
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    setRowDone(row, want);
    const goalMotion = { glow: want && targetDays > 0, reached: reachedNow, milestoneIds: crossedMilestones };
    refreshDailyRowStats(task, goalMotion);
    refreshDailyDetail(task, goalMotion);
    refreshDailyGroupProgress(task.groupId);
    updateDailyFoot();
    pulseDailyFoot();
    if (want && allDailyDone()) dailyCelebrateReturnId = id;
    dailyCelebrationCheck();
    if (row) row.classList.add('is-syncing');
    drainDailyToggle(id, state);
  }
  root.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.focus-daily-milestone')) return;
    event.stopPropagation();
    if (event.pointerType === 'mouse') event.preventDefault();
  });
  root.addEventListener('click', (event) => {
    const marker = event.target.closest('.focus-daily-milestone');
    if (marker) {
      event.preventDefault();
      event.stopPropagation();
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (coarse) {
        root.querySelectorAll('.focus-daily-milestone.is-tip-pinned').forEach((item) => {
          if (item !== marker) item.classList.remove('is-tip-pinned');
        });
        marker.classList.toggle('is-tip-pinned');
      }
      return;
    }
    if (dailyMilestoneDialog && event.target === dailyMilestoneDialog) {
      closeDailyMilestoneDialog(false);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'daily-milestone-add') {
      if (!action.disabled) {
        const row = appendDailyMilestoneDraftRow({ id: dailyMilestoneDraftId(), name: '', days: 0 }, true);
        const input = row && row.querySelector('[data-role="daily-milestone-name"]');
        if (input) input.focus();
        setDailyMilestoneDialogError('');
      }
      return;
    }
    if (action.dataset.action === 'daily-milestone-remove') {
      const row = action.closest('.focus-daily-milestone-row');
      if (!row) return;
      const finish = () => { if (row.isConnected) row.remove(); updateDailyMilestoneAddState(); };
      if (prefersReduced) finish();
      else {
        row.classList.add('is-leaving');
        row.addEventListener('animationend', finish, { once: true });
        setTimeout(finish, 220);
      }
      setDailyMilestoneDialogError('');
      return;
    }
    if (action.dataset.action === 'daily-milestone-cancel') { closeDailyMilestoneDialog(false); return; }
    if (action.dataset.action === 'daily-milestone-confirm') { closeDailyMilestoneDialog(true); return; }
    if (action.dataset.action === 'daily-review-today') { reviewDailyCelebration(); return; }
    if (action.dataset.action === 'daily-compose-toggle') toggleDailyComposer();
  });

  if (dailyListEl) {
    dailyListEl.addEventListener('click', (event) => {
      if (dailySuppressClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const milestone = event.target.closest('.focus-daily-milestone');
      if (milestone) {
        event.preventDefault();
        event.stopPropagation();
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (coarse) {
          dailyListEl.querySelectorAll('.focus-daily-milestone.is-tip-pinned').forEach((item) => {
            if (item !== milestone) item.classList.remove('is-tip-pinned');
          });
          milestone.classList.toggle('is-tip-pinned');
        }
        return;
      }
      // 任务行优先：任务现在嵌在 .focus-daily-group 里，必须先判任务，否则点勾选会被外层分组分支吃掉
      const row = event.target.closest('.focus-daily-row');
      if (row) {
        const id = row.dataset.id;
        if (event.target.closest('[data-role="daily-check"]')) { toggleDailyTask(id); return; }
        const detailTrigger = event.target.closest('[data-action="daily-detail-open"]');
        if (detailTrigger) { openDailyDetail(id, detailTrigger); return; }
        if (event.target.closest('[data-role="daily-edit-advanced"]')) {
          openDailyMilestoneDialog(id, event.target.closest('[data-role="daily-edit-advanced"]'));
          return;
        }
        if (event.target.closest('[data-role="daily-edit-save"]')) { commitDailyEdit(id); return; }
        if (event.target.closest('[data-role="daily-edit-delete"]')) { requestDeleteDaily(id); return; }
        if (event.target.closest('[data-role="daily-delete-cancel"]')) { cancelDeleteDaily(); return; }
        if (event.target.closest('[data-role="daily-delete-confirm"]')) { performDeleteDaily(id); return; }
        // 编辑器内部（输入框/按钮）不触发开合
        if (event.target.closest('.focus-daily-edit')) return;
        // 只有 ⋯ 才进编辑/重命名（命中区收小，避免随手一点就重命名）
        if (event.target.closest('[data-role="daily-menu"]')) {
          if (dailyEditId === id) closeDailyEdit(); else openDailyEdit(id);
          return;
        }
        // 点名字或行内非控件区域统一进入详情；编辑、打卡和拖拽入口已在上方提前截断。
        openDailyDetail(id, row.querySelector('[data-action="daily-detail-open"]'));
        return;
      }
      // 分组：只在点到「组头」或「组编辑器」时才处理，子项区域的空隙不误触折叠
      const groupHead = event.target.closest('.focus-daily-group-head');
      const groupEdit = event.target.closest('.focus-daily-group-edit');
      if (groupHead || groupEdit) {
        const groupEl = event.target.closest('.focus-daily-group');
        if (!groupEl) return;
        const gid = groupEl.dataset.groupId;
        if (event.target.closest('[data-role="daily-group-toggle"]')) { toggleDailyGroupCollapse(gid); return; }
        if (event.target.closest('[data-role="daily-group-menu"]')) { toggleDailyGroupEdit(gid); return; }
        if (event.target.closest('[data-role="daily-group-edit-save"]')) { commitDailyGroupEdit(gid); return; }
        if (event.target.closest('[data-role="daily-group-add-sub"]')) { setDailyCompose('group', gid); return; }
        if (event.target.closest('[data-role="daily-group-add-task"]')) { setDailyCompose('task', gid); return; }
        if (event.target.closest('[data-role="daily-group-edit-delete"]')) { requestDeleteDailyGroup(gid); return; }
        if (event.target.closest('[data-role="daily-group-delete-cancel"]')) { cancelDeleteDailyGroup(); return; }
        if (event.target.closest('[data-role="daily-group-delete-confirm"]')) { performDeleteDailyGroup(gid); return; }
        if (groupEdit) return;   // 编辑器内其余区域不触发开合
        toggleDailyGroupCollapse(gid);   // 点组头任意处（含组名）：折叠 / 展开；编辑只走 ⋯
      }
    });
    dailyListEl.addEventListener('keydown', (event) => {
      if (event.target.matches('[data-role="daily-group-edit-name"]')) {
        const wrap = event.target.closest('.focus-daily-group');
        if (!wrap) return;
        if (event.key === 'Enter') { event.preventDefault(); commitDailyGroupEdit(wrap.dataset.groupId); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDailyGroupEdit(); }
        return;
      }
      if (!event.target.matches('.focus-daily-edit-name, .focus-daily-edit-min, .focus-daily-edit-days')) return;
      const row = event.target.closest('.focus-daily-row');
      if (!row) return;
      if (event.key === 'Enter') { event.preventDefault(); commitDailyEdit(row.dataset.id); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDailyEdit(); }
    });
    dailyListEl.addEventListener('pointerdown', onDailyPointerDown);
  }
  if (dailyAddForm) dailyAddForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!dailyInputEl) return;
    if (dailyComposeMode === 'group') createDailyGroup(dailyInputEl.value, dailyAddTargetGroup);
    else createDailyTask(dailyInputEl.value, dailyAddTargetGroup);
  });
  if (dailyComposeTaskBtn) dailyComposeTaskBtn.addEventListener('click', () => setDailyCompose('task', dailyAddTargetGroup));
  if (dailyComposeGroupBtn) dailyComposeGroupBtn.addEventListener('click', () => setDailyCompose('group', dailyAddTargetGroup));
  if (dailyComposeTargetBtn) dailyComposeTargetBtn.addEventListener('click', () => setDailyCompose(dailyComposeMode, ''));
  listen(document, 'click', (event) => {
    if (!event.target.closest('.focus-daily-milestone')) {
      root.querySelectorAll('.focus-daily-milestone.is-tip-pinned').forEach((item) => item.classList.remove('is-tip-pinned'));
    }
  });

listen(document,'keydown',event=>{if(!host.isActive()||event.key!=='Escape')return; if(dailyMilestoneDialog)closeDailyMilestoneDialog(false,true);else if(dailyDetailTaskId)closeDailyDetail({restore:false,instant:true});else if(dailyEditId)closeDailyEdit();else closeDailyComposer({focus:false});});
return {
  async activate() {
    taskLifecycleActive = true; taskActivationSeq++;
    const key = 'activation-' + taskActivationSeq;
    replayDailyViewEntrance(key, { waitForData: !dailyLoaded });
    await loadDaily({ reveal: !dailyLoaded, revealKey: key });
  },
  deactivate({ freeze = false } = {}) {
    taskLifecycleActive = false; taskActivationSeq++;
    deferredMutations.forEach(run => run());
    cancelDailyRead(); endDailyPointerDrag(null, false);
    closeDailyDetail({ restore: false, instant: true }); closeDailyMilestoneDialog(false, true); closeDailyComposer({ focus: false });
    scope.stop({ freeze });
  },
  destroy() { this.deactivate(); scope.destroy(); dailyListEl?.replaceChildren(); dailyTasks = []; dailyGroups = []; },
};
  };
})();

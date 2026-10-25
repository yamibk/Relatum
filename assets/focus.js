(function () {
  'use strict';
  window.RelatumDailyFocus = function (root, host) {
    const scope = host.createScope();
    const { listen, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame } = scope;
const service=window.RelatumFocusService;
const workspace = host.element;
if (!window.RelatumFeatureRuntime.enabled('daily.tasks')) root.querySelector('.focus-bind').hidden = true;
const RING_R = 108;
const RING_C = 2 * Math.PI * RING_R;
const prefersReduced = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();
const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
const ringWrap = root.querySelector('[data-role="focus-ring-wrap"]');
const ringFill = root.querySelector('[data-role="focus-ring-fill"]');
const timeEl = root.querySelector('[data-role="focus-time"]');
const timeEditEl = root.querySelector('[data-role="focus-time-edit"]');
const phaseEl = root.querySelector('[data-role="focus-phase"]');
const captionEl = root.querySelector('[data-role="focus-caption"]');
const cockpitEl = root.querySelector('[data-role="focus-cockpit"]');
const cockpitTaskEl = root.querySelector('[data-role="focus-cockpit-task"]');
const cockpitGoalEl = root.querySelector('[data-role="focus-cockpit-goal"]');
const cockpitGoalEditEl = root.querySelector('[data-role="focus-cockpit-goal-edit"]');
const cockpitRoundsEl = root.querySelector('[data-role="focus-cockpit-rounds"]');
const modeSwitch = root.querySelector('[data-role="focus-mode-switch"]');
const modeSlider = root.querySelector('[data-role="focus-mode-slider"]');
const taskSelect = root.querySelector('[data-role="focus-task"]');
const goalEl = root.querySelector('[data-role="focus-goal"]');
const primaryBtn = root.querySelector('[data-role="focus-primary"]');
const finishBtn = root.querySelector('[data-role="focus-finish"]');
const resetBtn = root.querySelector('[data-role="focus-reset"]');
const dotsEl = root.querySelector('[data-role="focus-dots"]');
const footnoteEl = root.querySelector('[data-role="focus-footprint-note"]');
const todayCountEl = root.querySelector('[data-role="focus-today-count"]');
const todayTimeEl = root.querySelector('[data-role="focus-today-time"]');
const gearBtn = root.querySelector('[data-action="focus-settings"]');
const helpBtn = root.querySelector('[data-action="focus-help"]');
const refreshBtn = root.querySelector('[data-action="focus-refresh"]');
const settingsPop = root.querySelector('[data-role="focus-settings-pop"]');
const helpPop = root.querySelector('[data-role="focus-help-pop"]');
const setFocusEl = root.querySelector('[data-role="focus-set-focus"]');
const setBreakEl = root.querySelector('[data-role="focus-set-break"]');
const setLongEl = root.querySelector('[data-role="focus-set-long"]');
const setRoundsEl = root.querySelector('[data-role="focus-set-rounds"]');
const setSoundEl = root.querySelector('[data-role="focus-set-sound"]');
const setNoiseEl = root.querySelector('[data-role="focus-set-noise"]');
const setNoiseVolEl = root.querySelector('[data-role="focus-set-noise-vol"]');
const noiseVolRow = root.querySelector('[data-role="focus-noise-vol-row"]');
const wrapupEl = root.querySelector('[data-role="focus-wrapup"]');
const wrapupTitleEl = root.querySelector('[data-role="focus-wrapup-title"]');
const wrapupGoalEl = root.querySelector('[data-role="focus-wrapup-goal"]');
const outcomeEl = root.querySelector('[data-role="focus-outcome"]');
const wrapupDoneBtn = root.querySelector('[data-action="focus-wrapup-done"]');
const sessionEditor = root.querySelector('[data-role="focus-session-editor"]');
const sessionTitleEl = root.querySelector('[data-role="focus-session-title"]');
const sessionGoalEl = root.querySelector('[data-role="focus-session-goal"]');
const sessionOutcomeEl = root.querySelector('[data-role="focus-session-outcome"]');
const sessionSourceEl = root.querySelector('[data-role="focus-session-source"]');















let dailyTasks = [];
let dailyGroups = [];
const dailyGroupsById = new Map();
let dailyRequestSeq = 0;
let dailyRequestController = null;
const replayCleanupTimers = new WeakMap();
let sessions = [];
let loadedSessions = false;
let footprintDay = todayStr();
let footprintSessionId = '';

let editingSessionId = '';
let editingTime = false;
let cancelTimeCommit = false;
let cockpitSig = '';
let editingCockpitGoal = false;
let cancelCockpitGoalCommit = false;
let zenActive = false;
function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
function clampInt(value, lo, hi, fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(lo, Math.min(hi, number)) : fallback;
  }
function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    return hours ? hours + ':' + String(mins).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
      : String(mins).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }
function fmtShort(sec) {
    const mins = Math.round(sec / 60);
    if (mins < 60) return mins + 'm';
    const rem = mins % 60;
    return Math.floor(mins / 60) + 'h' + (rem ? rem + 'm' : '');
  }
function fmtLong(mins) {
    if (mins < 60) return mins + ' 分钟';
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return hours + ' 小时' + (rem ? ' ' + rem + ' 分' : '');
  }
function toast(message) {
    host.toast(message);
  }
function isTypingTarget(target) {
    return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
  }
function beginTimeEdit() {
    if (!timeEl || !timeEditEl || editingTime) return;
    if (service.mode !== 'pomodoro') {
      toast('正计时从 00:00 开始，不需要设定结束时间');
      return;
    }
    if (service.running || service.pendingSession) {
      toast('计时运行中不能修改时长');
      return;
    }
    editingTime = true;
    cancelTimeCommit = false;
    timeEditEl.value = String(service.durations.focus);
    timeEl.hidden = true;
    timeEditEl.hidden = false;
    timeEditEl.focus();
    timeEditEl.select();
    root.classList.add('focus-time-editing');
  }
function finishTimeEdit(save) {
    if (!editingTime) return;
    if (save) {
      service.durations.focus = clampInt(timeEditEl.value, 1, 180, service.durations.focus);
      service.remaining = service.durations.focus * 60;
      if (setFocusEl) setFocusEl.value = service.durations.focus;
      savePreferences();
    }
    editingTime = false;
    timeEditEl.hidden = true;
    timeEl.hidden = false;
    root.classList.remove('focus-time-editing');
    syncDisplay();
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
function replayEntrance() {
    if (prefersReduced) return;
    root.classList.remove('focus-reentering');
    ringFill?.style.setProperty('--focus-ring-empty', RING_C.toFixed(1));
    ringFill?.style.setProperty('--focus-ring-target', ringFill.style.strokeDashoffset || '0');
    replayClass(root, 'focus-reentering', 1250);
    try {
      if (localStorage.getItem('daily:focusHelpSeen') !== '1') replayClass(helpBtn, 'is-inviting', 2600);
    } catch (_) {}
  }
function dismiss(element, exitClass, after) {
    if (!element || element.hidden) { if (after) after(); return; }
    if (prefersReduced) {
      element.classList.remove(exitClass);
      element.hidden = true;
      if (after) after();
      return;
    }
    element.classList.remove('focus-card-entering', 'focus-pop-entering');
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      element.removeEventListener('animationend', onEnd);
      // 退场途中又被重新打开（开场逻辑会移除 exitClass）时，别再把它藏起来。
      if (!element.classList.contains(exitClass)) return;
      element.classList.remove(exitClass);
      element.hidden = true;
      if (after) after();
    };
    const onEnd = (event) => { if (event.target === element) finish(); };
    element.classList.add(exitClass);
    element.addEventListener('animationend', onEnd);
    timer = setTimeout(finish, 360);
  }
function pulseStats() {
    root.querySelectorAll('.focus-stats strong').forEach((element) => {
      replayClass(element, 'focus-stat-updated');
    });
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
function loadDurations(...args) { return service.loadDurations(...args); }
function loadSound(...args) { return service.loadSound(...args); }
function loadNoiseOn(...args) { return service.loadNoiseOn(...args); }
function loadNoiseVol(...args) { return service.loadNoiseVol(...args); }
function loadMode(...args) { return service.loadMode(...args); }
function savePreferences(...args) { return service.savePreferences(...args); }
function persistRuntime(){ service.goal=goalEl?.value||"";service.outcome=outcomeEl?.value||"";service.persistRuntime(); }
function noiseTarget(...args) { return service.noiseTarget(...args); }
function rampNoise(...args) { return service.rampNoise(...args); }
function updateNoise(...args) { return service.updateNoise(...args); }
function updateNoiseVolRow() {
    if (noiseVolRow) noiseVolRow.hidden = !service.noiseOn;
  }
function totalForPhase(...args) { return service.totalForPhase(...args); }
function start(...args) { return service.start(...args); }
function pause(...args) { return service.pause(...args); }
function reset(...args) { return service.reset(...args); }
function finishSegment(...args) { return service.finishSegment(...args); }
function renderPendingWrapup() {
    if (!service.pendingSession) return;
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    if (wrapupTitleEl) {
      wrapupTitleEl.textContent = T('专注了 '
        + fmtLong(Math.max(1, Math.round(service.pendingSession.durationSec / 60))));
    }
    if (wrapupGoalEl) {
      wrapupGoalEl.textContent = service.pendingSession.goal
        ? T('目标：') + service.pendingSession.goal
        : T('这一段没有填写目标。');
    }
    if (wrapupDoneBtn) {
      wrapupDoneBtn.hidden = !service.boundTaskId || !window.RelatumFeatureRuntime.enabled('daily.tasks');
      wrapupDoneBtn.textContent = T('保存并完成这件每日任务');
    }
    if (wrapupEl) {
      wrapupEl.classList.remove('focus-card-exiting');
      wrapupEl.hidden = false;
      replayClass(wrapupEl, 'focus-card-entering');
    }
  }
function setRingProgress(progress) {
    if (!ringFill) return;
    const fraction = Math.max(0, Math.min(1, progress));
    ringFill.style.strokeDasharray = RING_C.toFixed(1);
    ringFill.style.strokeDashoffset = (RING_C * (1 - fraction)).toFixed(1);
  }
function renderCockpit() {
    if (!cockpitEl) return;
    const show = service.running && !service.pendingSession;
    const goal = goalEl ? goalEl.value.trim() : '';
    const sig = [show ? 1 : 0, service.boundTaskId, service.boundTaskTitle, service.boundKind, goal, service.mode, service.completedFocus, service.phase, service.durations.rounds].join('|');
    if (sig === cockpitSig) return;
    const wasHidden = cockpitEl.hidden;
    cockpitSig = sig;
    cockpitEl.hidden = !show;
    if (!show) {
      if (editingCockpitGoal) {
        editingCockpitGoal = false;
        if (cockpitGoalEditEl) cockpitGoalEditEl.hidden = true;
      }
      return;
    }
    if (cockpitTaskEl) {
      cockpitTaskEl.innerHTML = '';
      if (service.boundTaskId) {
        const label = document.createElement('span');
        label.textContent = '正在做';
        const name = document.createElement('strong');
        name.textContent = T('［每日］') + (service.boundTaskTitle || T('未命名任务'));
        cockpitTaskEl.append(label, name);
      } else {
        const name = document.createElement('strong');
        name.textContent = '自由专注';
        cockpitTaskEl.appendChild(name);
      }
    }
    if (cockpitGoalEl && !editingCockpitGoal) {
      cockpitGoalEl.hidden = false;
      cockpitGoalEl.classList.toggle('is-empty', !goal);
      cockpitGoalEl.textContent = goal ? '目标 · ' + goal : '＋ 为这一段写个目标';
    }
    if (cockpitRoundsEl) {
      if (service.mode !== 'pomodoro') {
        cockpitRoundsEl.hidden = true;
        cockpitRoundsEl.innerHTML = '';
      } else {
        const rounds = service.durations.rounds;
        const doneInCycle = service.completedFocus % rounds;
        cockpitRoundsEl.innerHTML = '';
        for (let i = 0; i < rounds; i += 1) {
          const pip = document.createElement('span');
          pip.className = 'focus-round-pip';
          if (i < doneInCycle) pip.classList.add('is-done');
          else if (i === doneInCycle && service.phase === 'focus') pip.classList.add('is-current');
          cockpitRoundsEl.appendChild(pip);
        }
        cockpitRoundsEl.setAttribute('aria-label', '番茄轮次 第 ' + (doneInCycle + 1) + ' / ' + rounds + ' 段');
        cockpitRoundsEl.hidden = false;
      }
    }
    if (wasHidden) replayClass(cockpitEl, 'focus-cockpit-in');
  }
function beginCockpitGoalEdit() {
    if (!cockpitGoalEditEl || !cockpitGoalEl || editingCockpitGoal) return;
    if (!service.running || service.pendingSession) return;
    editingCockpitGoal = true;
    cancelCockpitGoalCommit = false;
    cockpitGoalEditEl.value = goalEl ? goalEl.value : '';
    cockpitGoalEl.hidden = true;
    cockpitGoalEditEl.hidden = false;
    cockpitGoalEditEl.focus();
    cockpitGoalEditEl.select();
  }
function finishCockpitGoalEdit(save) {
    if (!editingCockpitGoal) return;
    editingCockpitGoal = false;
    if (save && goalEl) {
      goalEl.value = cockpitGoalEditEl.value.slice(0, 500);
      persistRuntime();
    }
    cockpitGoalEditEl.hidden = true;
    cockpitGoalEl.hidden = false;
    cockpitSig = '';
    renderCockpit();
  }
function syncDisplay() {
    if (service.mode === 'countup') {
      if (timeEl && !editingTime) timeEl.textContent = fmt(service.elapsed);
      setRingProgress(service.running ? (service.elapsed % 60) / 60 : 0);
    } else {
      const total = totalForPhase() || 1;
      const shown = service.running ? service.remaining : service.durations.focus * 60;
      if (timeEl && !editingTime) timeEl.textContent = fmt(shown);
      setRingProgress(service.running ? service.remaining / total : 1);
    }
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    let phaseText = T('准备开始');
    let dataPhase = 'idle';
    let viewState = 'ready';
    if (service.pendingSession) {
      phaseText = T('等待收尾');
      viewState = 'wrapup';
    }
    else if (service.running) {
      if (service.mode === 'countup') {
        phaseText = service.paused ? T('已暂停') : T('专注中');
        dataPhase = service.paused ? 'paused' : 'focus';
        viewState = service.paused ? 'paused' : 'focus';
      } else if (service.phase === 'break') {
        phaseText = service.paused ? T('休息（暂停）') : T('休息一下');
        dataPhase = service.paused ? 'paused' : 'break';
        viewState = service.paused ? 'paused' : 'break';
      } else {
        phaseText = service.paused ? T('已暂停') : T('专注 · 第 ' + (service.completedFocus + 1) + ' 段');
        dataPhase = service.paused ? 'paused' : 'focus';
        viewState = service.paused ? 'paused' : 'focus';
      }
    }
    if (phaseEl) phaseEl.textContent = phaseText;
    if (ringWrap) ringWrap.dataset.phase = dataPhase;
    if (captionEl) captionEl.textContent = service.mode === 'countup'
      ? T('正计时 · 自由专注，按「完成」记一段')
      : T('番茄钟 · 专注 ' + service.durations.focus + ' / 休息 ' + service.durations.brk + ' 分');
    if (primaryBtn) {
      primaryBtn.textContent = service.running ? (service.paused ? T('继续') : T('暂停')) : T('开始');
      primaryBtn.disabled = !!service.pendingSession;
    }
    if (finishBtn) {
      finishBtn.hidden = !service.running || !!service.pendingSession;
      finishBtn.textContent = service.mode === 'countup' ? T('完成') : (service.phase === 'break' ? T('跳过休息') : T('完成本段'));
    }
    if (resetBtn) resetBtn.hidden = !service.running || !!service.pendingSession;
    if (taskSelect) taskSelect.disabled = service.running || !!service.pendingSession;
    if (goalEl) goalEl.disabled = service.running || !!service.pendingSession;
    root.dataset.running = service.running && !service.paused && !service.pendingSession ? '1' : '0';
    root.dataset.state = viewState;
    root.dataset.hasSessions = sessions.some((session) => sessionDay(session) === (footprintDay || todayStr())) ? '1' : '0';
    if (timeEl) {
      timeEl.classList.toggle('is-editable', service.mode === 'pomodoro' && !service.running && !service.pendingSession);
      timeEl.title = service.mode === 'pomodoro' ? T('双击修改专注时长') : T('正计时从 00:00 开始');
    }
    renderCockpit();
    updateNoise();
  }
function sessionDay(session) {
    const explicit = String(session && session.day || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
    const ended = new Date(session && session.endedAt || '');
    if (Number.isNaN(ended.getTime())) return '';
    return ended.getFullYear() + '-' + String(ended.getMonth() + 1).padStart(2, '0')
      + '-' + String(ended.getDate()).padStart(2, '0');
  }
function renderFootprint() {
    if (!scope.alive || !host.isActive()) return;
    const day = footprintDay || todayStr();
    const daySessions = sessions.filter((session) => sessionDay(session) === day);
    const totalSec = daySessions.reduce((sum, session) => sum + (Number(session.durationSec) || 0), 0);
    const dayDate = new Date(day + 'T00:00:00');
    const dayLabel = day === todayStr() ? '今日' : (dayDate.getMonth() + 1) + '月' + dayDate.getDate() + '日';
    if (todayCountEl) todayCountEl.textContent = String(daySessions.length);
    if (todayTimeEl) todayTimeEl.textContent = daySessions.length ? fmtShort(totalSec) : '0m';
    const labels = root.querySelectorAll('.focus-stats span');
    if (labels[0]) labels[0].textContent = dayLabel + '段数';
    if (labels[1]) labels[1].textContent = dayLabel + '专注';
    if (dotsEl) {
      dotsEl.innerHTML = '';
      daySessions.slice(-36).forEach((session, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'focus-dot';
        dot.dataset.sessionId = session.id || '';
        if (footprintSessionId && session.id === footprintSessionId) dot.classList.add('is-located');
        if (editingSessionId && session.id === editingSessionId) dot.classList.add('is-active');
        dot.title = Math.max(1, Math.round((Number(session.durationSec) || 0) / 60)) + ' 分'
          + (session.taskTitle ? ' · ' + session.taskTitle : '')
          + (session.goal ? ' · ' + session.goal : '');
        dot.setAttribute('aria-label', dot.title + '，打开记录');
        dot.style.setProperty('--focus-dot-delay', Math.min(index, 12) * 24 + 'ms');
        dot.addEventListener('click', () => openSessionEditor(session.id));
        dotsEl.appendChild(dot);
      });
    }
    pulseStats();
    if (footnoteEl) {
      const noteText = daySessions.length
        ? dayLabel + ' ' + daySessions.length + ' 段 · ' + fmtLong(Math.round(totalSec / 60)) + ' · 点击圆点可回看'
        : dayLabel + '没有专注记录';
      if (footnoteEl.textContent !== noteText) {
        footnoteEl.textContent = noteText;
        replayClass(footnoteEl, 'focus-note-flip');
      }
    }
    root.dataset.hasSessions = daySessions.length ? '1' : '0';
    if (footprintSessionId && dotsEl) {
      requestAnimationFrame(() => {
        const located = dotsEl.querySelector('.focus-dot.is-located');
        if (located) located.scrollIntoView({ block: 'nearest', inline: 'center', behavior: prefersReduced ? 'auto' : 'smooth' });
      });
    }
  }
function setDotActive(id) {
    if (!dotsEl) return;
    dotsEl.querySelectorAll('.focus-dot').forEach((dot) => {
      dot.classList.toggle('is-active', dot.dataset.sessionId === String(id || ''));
    });
  }
function clearDotActive() {
    if (!dotsEl) return;
    dotsEl.querySelectorAll('.focus-dot.is-active').forEach((dot) => dot.classList.remove('is-active'));
  }
function openSessionEditor(id) {
    const session = sessions.find((item) => item.id === id);
    if (!session || !sessionEditor) return;
    editingSessionId = id;
    setDotActive(id);
    if (sessionTitleEl) {
      sessionTitleEl.textContent = (session.taskTitle || '自由专注') + ' · '
        + fmtLong(Math.max(1, Math.round((Number(session.durationSec) || 0) / 60)));
    }
    if (sessionGoalEl) sessionGoalEl.value = session.goal || '';
    if (sessionOutcomeEl) sessionOutcomeEl.value = session.outcome || '';
    if (sessionSourceEl) {
      const source = session.source;
      const isTaskbook = source && source.kind === 'taskbook'
        && source.canvasPath && source.rootId && window.RelatumFeatureRuntime.enabled('canvas.editor');
      sessionSourceEl.hidden = !isTaskbook;
      sessionSourceEl.dataset.canvasPath = isTaskbook ? source.canvasPath : '';
      sessionSourceEl.dataset.rootId = isTaskbook ? source.rootId : '';
      sessionSourceEl.dataset.nodeId = isTaskbook ? (source.nodeId || '') : '';
    }
    sessionEditor.classList.remove('focus-card-exiting');
    sessionEditor.hidden = false;
    replayClass(sessionEditor, 'focus-card-entering');
  }
function closeSessionEditor() {
    editingSessionId = '';
    clearDotActive();
    dismiss(sessionEditor, 'focus-card-exiting');
  }
async function saveSessionEdit() {
    const session = sessions.find((item) => item.id === editingSessionId);
    if (!session) return;
    try {
      const json = await post('/api/focus-session-update', {
        id: session.id,
        goal: sessionGoalEl ? sessionGoalEl.value : '',
        outcome: sessionOutcomeEl ? sessionOutcomeEl.value : '',
      });
      Object.assign(session, json.session || {});
      closeSessionEditor();
      renderFootprint();
      document.dispatchEvent(new CustomEvent('canvas:data-changed', {
        detail: { source: 'focus', path: '/api/focus-session-update' },
      }));
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
      toast('专注记录已更新');
    } catch (error) { toast(error.message); }
  }
async function deleteSessionEdit() {
    const session = sessions.find((item) => item.id === editingSessionId);
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    if (!session || !window.confirm(T('删除这段专注记录？当天与长期统计会同步扣除。'))) return;
    try {
      await post('/api/focus-session-delete', { id: session.id });
      sessions = sessions.filter((item) => item.id !== session.id);
      closeSessionEditor();
      renderFootprint();
      document.dispatchEvent(new CustomEvent('canvas:data-changed', {
        detail: { source: 'focus', path: '/api/focus-session-delete' },
      }));
      if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
      toast('专注记录已删除');
    } catch (error) { toast(error.message); }
  }
function setMode(...args) { service.setMode(...args); syncModeUI(); syncDisplay(); }
function syncModeUI() {
    if (!modeSwitch) return;
    modeSwitch.querySelectorAll('button[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === service.mode);
    });
    if (modeSlider) modeSlider.style.transform = service.mode === 'countup' ? 'translateX(100%)' : 'translateX(0)';
  }
function focusJsonSource(source,path,options) { return host.read(path,options); }
async function refreshFocus(btn) {
    if (btn) btn.classList.add('is-refreshing');
    try {
      await Promise.all([loadDaily(), loadSessions()]);
      toast('专注数据已更新');
    } finally {
      if (btn) btn.classList.remove('is-refreshing');
    }
  }
function renderTaskOptions() {
    if (!taskSelect) return;
    taskSelect.innerHTML = '<option value="">' + T('不绑定 · 只是专注') + '</option>';
    if (dailyTasks.length) {
      const group = document.createElement('optgroup');
      group.label = T('每日任务');
      dailyTasks.forEach((task) => {
        const option = document.createElement('option');
        option.value = 'daily:' + task.id;
        const g = task.groupId ? dailyGroupById(task.groupId) : null;
        const prefix = g ? dailyGroupPathLabel(g) + ' · ' : '';
        option.textContent = (task.doneToday ? '✓ ' : '') + prefix + (task.name || T('未命名'));
        group.appendChild(option);
      });
      taskSelect.appendChild(group);
    }
    // 还原当前绑定的选中态；绑定的目标若已不存在且未在计时，则解绑
    if (service.boundKind === 'daily') {
      const task = dailyTasks.find((item) => item.id === service.boundTaskId);
      if (task) {
        taskSelect.value = 'daily:' + service.boundTaskId;
        service.boundTaskTitle = task.name || '';
      } else if (!service.running) {
        service.boundKind = ''; service.boundTaskId = ''; service.boundTaskTitle = ''; taskSelect.value = '';
      }
    } else if (service.boundTaskId && !service.running) {
      service.boundKind = ''; service.boundTaskId = ''; service.boundTaskTitle = ''; taskSelect.value = '';
    }
  }
function bindTask(...args) { const result=service.bindTask(...args);renderTaskOptions();return result; }
function onTaskChange() {
    const value = taskSelect.value || '';
    if (value.indexOf('daily:') === 0) {
      const id = value.slice(6);
      const task = dailyTasks.find((item) => item.id === id);
      bindTask(task ? task.id : '', task ? task.name || '' : '', task ? 'daily' : '');
    } else bindTask('', '', '');
  }
function loadSessions(options) {
    const opts = options || {};
    return focusJsonSource(opts.source, '/api/focus').then((json) => {
      if (!scope.alive || !host.isActive()) return;
      if (opts.isCurrent && !opts.isCurrent()) return;
      sessions = json && Array.isArray(json.sessions) ? json.sessions : [];
      loadedSessions = true;
      renderFootprint();
    }).catch(() => { if (!opts.isCurrent || opts.isCurrent()) renderFootprint(); });
  }
async function loadDaily() {
  const json = await host.read('/api/daily');
  if (!scope.alive || !host.isActive()) return;
  dailyTasks = json.daily?.tasks || json.tasks || [];
  dailyGroups = json.daily?.groups || json.groups || [];
  dailyGroupsById.clear(); dailyGroups.forEach(group => dailyGroupsById.set(group.id, group));
  renderTaskOptions();
}
function dailyGroupById(id) { return dailyGroupsById.get(id) || null; }
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
function syncSettingsInputs() {
    if (setFocusEl) setFocusEl.value = service.durations.focus;
    if (setBreakEl) setBreakEl.value = service.durations.brk;
    if (setLongEl) setLongEl.value = service.durations.long;
    if (setRoundsEl) setRoundsEl.value = service.durations.rounds;
    if (setSoundEl) setSoundEl.checked = service.soundOn;
    if (setNoiseEl) setNoiseEl.checked = service.noiseOn;
    if (setNoiseVolEl) setNoiseVolEl.value = Math.round(service.noiseVol * 100);
    updateNoiseVolRow();
  }
function toggleSettings(force) {
    if (!settingsPop) return;
    const open = typeof force === 'boolean' ? force : settingsPop.hidden;
    if (gearBtn) gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      settingsPop.classList.remove('focus-pop-exiting');
      settingsPop.hidden = false;
      toggleHelp(false);
      syncSettingsInputs();
      replayClass(settingsPop, 'focus-pop-entering');
    } else {
      dismiss(settingsPop, 'focus-pop-exiting');
    }
  }
function toggleHelp(force) {
    if (!helpPop) return;
    const open = typeof force === 'boolean' ? force : helpPop.hidden;
    if (helpBtn) {
      helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      helpBtn.classList.remove('is-inviting');
    }
    if (open) {
      helpPop.classList.remove('focus-pop-exiting');
      helpPop.hidden = false;
      toggleSettings(false);
      try { localStorage.setItem('daily:focusHelpSeen', '1'); } catch (e) {}
      replayClass(helpPop, 'focus-pop-entering');
    } else {
      dismiss(helpPop, 'focus-pop-exiting');
    }
  }
function enterZen() {
    if (zenActive || !workspace || !service.running || service.pendingSession) return;
    toggleSettings(false);
    toggleHelp(false);
    closeSessionEditor();
    zenActive = true;
    workspace.classList.add('focus-zen');
  }
function exitZen() {
    if (!zenActive || !workspace) return;
    zenActive = false;
    workspace.classList.remove('focus-zen');
  }
function onDurationInput() {
    service.durations.focus = clampInt(setFocusEl && setFocusEl.value, 1, 180, service.durations.focus);
    service.durations.brk = clampInt(setBreakEl && setBreakEl.value, 1, 60, service.durations.brk);
    service.durations.long = clampInt(setLongEl && setLongEl.value, 1, 90, service.durations.long);
    service.durations.rounds = clampInt(setRoundsEl && setRoundsEl.value, 2, 12, service.durations.rounds);
    savePreferences();
    if (!service.running && service.mode === 'pomodoro') service.remaining = service.durations.focus * 60;
    syncDisplay();
  }
  if (primaryBtn) primaryBtn.addEventListener('click', () => {
    if (!service.running || service.paused) start(); else pause();
  });
  if (finishBtn) finishBtn.addEventListener('click', finishSegment);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!service.running || window.confirm(T('重置当前计时？未满一段的时间不会记入记录。'))) reset();
  });
  if (modeSwitch) modeSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (button) setMode(button.dataset.mode);
  });
  if (taskSelect) taskSelect.addEventListener('change', onTaskChange);
  if (timeEl) {
    timeEl.addEventListener('dblclick', beginTimeEdit);
    timeEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        beginTimeEdit();
      }
    });
  }
  if (timeEditEl) {
    timeEditEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishTimeEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelTimeCommit = true;
        finishTimeEdit(false);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const delta = event.shiftKey ? 1 : 5;
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        timeEditEl.value = String(clampInt(Number(timeEditEl.value) + direction * delta, 1, 180, service.durations.focus));
        timeEditEl.select();
      }
    });
    timeEditEl.addEventListener('blur', () => {
      const save = !cancelTimeCommit;
      cancelTimeCommit = false;
      finishTimeEdit(save);
    });
  }
  if (goalEl) goalEl.addEventListener('input', persistRuntime);
  if (cockpitGoalEl) cockpitGoalEl.addEventListener('click', beginCockpitGoalEdit);
  if (cockpitGoalEditEl) {
    cockpitGoalEditEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishCockpitGoalEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelCockpitGoalCommit = true;
        finishCockpitGoalEdit(false);
      }
    });
    cockpitGoalEditEl.addEventListener('blur', () => {
      const save = !cancelCockpitGoalCommit;
      cancelCockpitGoalCommit = false;
      finishCockpitGoalEdit(save);
    });
  }
  if (outcomeEl) outcomeEl.addEventListener('input', persistRuntime);
  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshFocus(refreshBtn));
  if (gearBtn) gearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSettings();
  });
  if (helpBtn) helpBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleHelp();
  });
  [setFocusEl, setBreakEl, setLongEl, setRoundsEl].forEach((element) => {
    if (element) {
      element.addEventListener('change', onDurationInput);
      element.addEventListener('input', onDurationInput);
    }
  });
  // 点击浮窗半透明背板（卡片以外）关闭专注记录；收尾卡不走背板关闭，必须选一个动作。
  if (sessionEditor) sessionEditor.addEventListener('click', (event) => {
    if (event.target === sessionEditor) closeSessionEditor();
  });
  if (setSoundEl) setSoundEl.addEventListener('change', () => {
    service.soundOn = setSoundEl.checked;
    savePreferences();
  });
  if (setNoiseEl) setNoiseEl.addEventListener('change', () => {
    service.noiseOn = setNoiseEl.checked;
    savePreferences();
    updateNoiseVolRow();
    updateNoise();
  });
  if (setNoiseVolEl) setNoiseVolEl.addEventListener('input', () => {
    service.noiseVol = Math.max(0, Math.min(1, (Number(setNoiseVolEl.value) || 0) / 100));
    savePreferences();
    if (service.noisePlaying) rampNoise(noiseTarget());
  });

root.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action?.startsWith('focus-wrapup-'))service.finishWrapup(action.slice(13)).catch(error=>toast(error.message));if(action==='focus-session-save')saveSessionEdit();if(action==='focus-session-delete')deleteSessionEdit();if(action==='focus-session-close')closeSessionEditor();if(action==='focus-session-open-source'){const session=sessions.find(item=>item.id===editingSessionId);if(session?.source)host.openSource(session.source);}if(action==='focus-zen-enter')enterZen();});
listen(document,'keydown',event=>{if(!host.isActive()||isTypingTarget(event.target))return;if(event.key==='Escape'){exitZen();toggleSettings(false);toggleHelp(false);closeSessionEditor();}else if(event.code==='Space'&&!service.pendingSession){event.preventDefault();if(!service.running||service.paused)start();else pause();}});
const unsubscribe = service.subscribe(() => {
  if (!host.isActive()) return;
  if (goalEl.value !== service.goal) goalEl.value = service.goal;
  if (outcomeEl.value !== service.outcome) outcomeEl.value = service.outcome;
  if (service.pendingSession) { exitZen(); renderPendingWrapup(); }
  else if (wrapupEl) wrapupEl.hidden = true;
  syncDisplay();
});
listen(document, 'canvas:data-changed', () => { if (host.isActive()) loadSessions(); });
goalEl.value=service.goal;outcomeEl.value=service.outcome;syncSettingsInputs();syncModeUI();updateNoiseVolRow();
return {
  activate() { syncDisplay(); if (service.pendingSession) renderPendingWrapup(); replayEntrance(); return Promise.allSettled([loadDaily(), loadSessions()]); },
  deactivate({ freeze = false } = {}) { service.goal = goalEl.value; service.outcome = outcomeEl.value; exitZen(); toggleSettings(false); toggleHelp(false); closeSessionEditor(); scope.stop({ freeze }); service.releaseIdleAudio(); },
  showDay(day, id) { footprintDay = day; footprintSessionId = id || ''; return loadSessions().then(() => { if (id && host.isActive()) openSessionEditor(id); }); },
  destroy() { this.deactivate(); unsubscribe(); scope.destroy(); },
};
  };
})();

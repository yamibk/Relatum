// 起步页「专注钟」：番茄钟 / 正计时、学习任务绑定、目标成果、可靠恢复与记录回看。
(function () {
  'use strict';

  const root = document.querySelector('[data-role="focus-view"]');
  if (!root) return;
  const bookView = root.closest('.book-view');

  const DUR_KEY = 'canvas:focusDurations';
  const SOUND_KEY = 'canvas:focusSound';
  const NOISE_KEY = 'canvas:focusNoise';
  const NOISE_VOL_KEY = 'canvas:focusNoiseVol';
  const NOISE_SRC_URL = '/audio/rain.mp3';   // 打包内的真实雨声循环音源
  const NOISE_XFADE_SEC = 3;                 // 循环接缝交叉淡化时长（秒）
  const NOISE_MAX_GAIN = 0.9;                // 音量滑块满格时的增益上限（留峰值余量）
  const MODE_KEY = 'canvas:focusMode';
  const TASK_KEY = 'canvas:focusTask';
  const KIND_KEY = 'canvas:focusTaskKind';
  const STATE_KEY = 'canvas:focusRuntime';
  const RUNTIME_PERSIST_MS = 5000;
  const DUR_DEFAULT = { focus: 25, brk: 5, long: 15, rounds: 4 };
  const LOG_MIN_SEC = 60;
  const DAILY_DEPTH_MAX = 12;
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
  const bindFeedbackEl = root.querySelector('[data-role="focus-bind-feedback"]');
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
  const dailyRoot = root.querySelector('[data-role="focus-daily"]');
  const dailyHandle = root.querySelector('.focus-daily-handle');
  const dailyListEl = root.querySelector('[data-role="focus-daily-list"]');
  const dailyAddForm = root.querySelector('[data-role="focus-daily-add"]');
  const dailyInputEl = root.querySelector('[data-role="focus-daily-input"]');
  const dailyFootEl = root.querySelector('[data-role="focus-daily-foot"]');
  const dailyCelebrateEl = root.querySelector('[data-role="focus-daily-celebrate"]');
  const dailyCelebrateSubEl = root.querySelector('[data-role="focus-daily-celebrate-sub"]');
  const dailyComposeEl = root.querySelector('[data-role="focus-daily-compose"]');
  const dailyComposeTaskBtn = root.querySelector('[data-role="daily-compose-task"]');
  const dailyComposeGroupBtn = root.querySelector('[data-role="daily-compose-group"]');
  const dailyComposeTargetBtn = root.querySelector('[data-role="daily-compose-target"]');
  const dailyFocusableSelector = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]';

  let durations = loadDurations();
  let soundOn = loadSound();
  let noiseOn = loadNoiseOn();
  let noiseVol = loadNoiseVol();
  let noiseNodes = null;
  let noisePlaying = false;
  let noiseBuffer = null;     // 解码并接缝处理后的无缝雨声缓冲
  let noiseLoading = false;   // 防止重复发起加载
  let mode = loadMode();
  let running = false;
  let paused = false;
  let phase = 'focus';
  let remaining = durations.focus * 60;
  let elapsed = 0;
  let completedFocus = 0;
  let ticker = null;
  let lastTickAt = 0;
  let lastRuntimePersistAt = 0;
  let boundTaskId = '';
  let boundTaskTitle = '';
  let boundKind = '';   // '' | 'study' | 'daily'：这一段专注绑的是学习任务还是每日任务
  let tasks = [];
  let dailyTasks = [];
  let dailyGroups = [];           // 分组树：每个 {id,name,parentId,collapsed}，parentId:'' = 根
  let dailyLoaded = false;
  let dailyOpen = false;
  let dailyEditId = '';
  let dailyEditMilestones = null;
  let dailyMilestoneDialog = null;
  let dailyMilestoneDialogDraft = [];
  let dailyMilestoneReturnEl = null;
  let dailyMilestoneTipSeq = 0;
  let dailyConfirmDeleteId = '';  // 删除二次确认：编辑器内就地变「确认删除？」，不弹原生 confirm
  let dailyGroupEditId = '';      // 正在展开菜单/改名的分组 id
  let dailyGroupConfirmDeleteId = '';
  const dailyExpandTimers = new WeakMap();  // 分组就地展开的逐项交错收尾计时器，按 wrap 元素索引
  const dailyHintTimers = new WeakMap();    // 点任务名/空白的「⋯ 提示」收尾计时器，按 row 元素索引
  let dailyComposeMode = 'task';  // 新增控制条当前模式：'task' | 'group'
  let dailyAddTargetGroup = '';   // 新增项的目标父分组；'' = 根
  let dailyEnterId = '';          // 刚新增的任务/分组 id：仅这一行播放入场动画
  let dailyPeek = false;          // 全部完成后用户主动「查看清单」，临时展开供取消勾选
  let dailyWasAllDone = false;
  let dailyClearing = false;      // 清场动画进行中：别让异步刷新打断
  let dailyClearTimer = 0;
  let dailyDrag = null;
  let dailySuppressClick = false;
  let dailyRevealTimer = 0;
  let dailyFocusReturnEl = null;
  let dailyHistoryTaskId = '';
  let dailyHistoryMonth = '';
  let dailyDetailTaskId = '';
  let dailyDetailMonth = '';
  let dailyDetailReturnEl = null;
  let dailyDetailCloseTimer = 0;
  let dailyDetailMonthMotionTimer = 0;
  let dailyHistoryCloseTimer = 0;
  let sessions = [];
  let loadedSessions = false;
  let footprintDay = todayStr();
  let footprintSessionId = '';
  let audioCtx = null;
  let pendingSession = null;
  let editingSessionId = '';
  let expiredRestore = null;
  let restorePrompted = false;
  let editingTime = false;
  let cancelTimeCommit = false;
  let bindFeedbackTimer = 0;
  let entranceTimer = 0;
  let modeCueTimer = 0;
  let cockpitSig = '';
  let editingCockpitGoal = false;
  let cancelCockpitGoalCommit = false;
  let zenActive = false;

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
    const el = document.querySelector('[data-role="study-toast"]') || document.querySelector('[data-role="toast"]');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function focusPageActive() {
    const book = root.closest('.book-view');
    return !!(book && book.classList.contains('focus-active'));
  }
  function isTypingTarget(target) {
    return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
  }
  function rememberDailyFocus() {
    dailyFocusReturnEl = null;
  }
  function restoreDailyFocus() {
    const active = document.activeElement;
    if (active && dailyRoot && dailyRoot.contains(active) && active.blur) active.blur();
    if (active && dailyHandle && dailyHandle.contains(active) && active.blur) active.blur();
    dailyFocusReturnEl = null;
    if (document.activeElement && document.activeElement !== document.body
      && document.activeElement !== document.documentElement
      && !isTypingTarget(document.activeElement)
      && document.activeElement.blur) document.activeElement.blur();
  }
  function settleDailyPanelFocus() {
    if (!dailyRoot || !dailyOpen) return;
    const active = document.activeElement;
    if (active && dailyRoot.contains(active)) return;
    if (active && active.blur && !isTypingTarget(active)) active.blur();
  }
  function syncDailyPanelFocusability() {
    if (!dailyRoot) return;
    const enabled = !!dailyOpen;
    dailyRoot.toggleAttribute('inert', !enabled);
    dailyRoot.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    dailyRoot.querySelectorAll(dailyFocusableSelector).forEach((element) => {
      if (enabled) {
        if (element.dataset.dailySavedTabindex !== undefined) {
          const saved = element.dataset.dailySavedTabindex;
          delete element.dataset.dailySavedTabindex;
          if (saved === '') element.removeAttribute('tabindex');
          else element.setAttribute('tabindex', saved);
        }
      } else {
        if (element.dataset.dailySavedTabindex === undefined) {
          element.dataset.dailySavedTabindex = element.getAttribute('tabindex') || '';
        }
        element.setAttribute('tabindex', '-1');
      }
    });
  }

  function beginTimeEdit() {
    if (!timeEl || !timeEditEl || editingTime) return;
    if (mode !== 'pomodoro') {
      toast('正计时从 00:00 开始，不需要设定结束时间');
      return;
    }
    if (running || pendingSession) {
      toast('计时运行中不能修改时长');
      return;
    }
    editingTime = true;
    cancelTimeCommit = false;
    timeEditEl.value = String(durations.focus);
    timeEl.hidden = true;
    timeEditEl.hidden = false;
    timeEditEl.focus();
    timeEditEl.select();
    root.classList.add('focus-time-editing');
  }

  function finishTimeEdit(save) {
    if (!editingTime) return;
    if (save) {
      durations.focus = clampInt(timeEditEl.value, 1, 180, durations.focus);
      remaining = durations.focus * 60;
      if (setFocusEl) setFocusEl.value = durations.focus;
      savePreferences();
    }
    editingTime = false;
    timeEditEl.hidden = true;
    timeEl.hidden = false;
    root.classList.remove('focus-time-editing');
    syncDisplay();
  }

  function showBindFeedback() {
    if (!bindFeedbackEl) return;
    clearTimeout(bindFeedbackTimer);
    if (!boundTaskId) {
      bindFeedbackEl.hidden = true;
      return;
    }
    bindFeedbackEl.textContent = '本段将计入「' + boundTaskTitle + '」';
    bindFeedbackEl.hidden = false;
    bindFeedbackEl.classList.remove('show');
    void bindFeedbackEl.offsetWidth;
    bindFeedbackEl.classList.add('show');
    bindFeedbackTimer = setTimeout(() => {
      bindFeedbackEl.classList.remove('show');
      bindFeedbackEl.hidden = true;
    }, 2200);
  }

  function replayClass(element, className) {
    if (!element || prefersReduced) return;
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }
  // 收起浮层/卡片时先播放退场动画，动画结束（或兜底超时）再真正 hidden。
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

  function replayFocusEntrance() {
    if (prefersReduced) return;
    clearTimeout(entranceTimer);
    root.classList.remove('focus-reentering');
    if (ringFill) {
      ringFill.style.setProperty('--focus-ring-empty', RING_C.toFixed(1));
      ringFill.style.setProperty('--focus-ring-target', ringFill.style.strokeDashoffset || '0');
    }
    void root.offsetWidth;
    root.classList.add('focus-reentering');
    entranceTimer = setTimeout(() => {
      root.classList.remove('focus-reentering');
      entranceTimer = 0;
    }, 1250);
  }

  function replayModeCue() {
    if (prefersReduced) return;
    clearTimeout(modeCueTimer);
    root.classList.remove('focus-mode-changing');
    void root.offsetWidth;
    root.classList.add('focus-mode-changing');
    modeCueTimer = setTimeout(() => {
      root.classList.remove('focus-mode-changing');
      modeCueTimer = 0;
    }, 360);
  }

  function pulseStats() {
    root.querySelectorAll('.focus-stats strong').forEach((element) => {
      replayClass(element, 'focus-stat-updated');
    });
  }
  function post(path, body) {
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

  function loadDurations() {
    try {
      const raw = JSON.parse(localStorage.getItem(DUR_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        return {
          focus: clampInt(raw.focus, 1, 180, DUR_DEFAULT.focus),
          brk: clampInt(raw.brk, 1, 60, DUR_DEFAULT.brk),
          long: clampInt(raw.long, 1, 90, DUR_DEFAULT.long),
          rounds: clampInt(raw.rounds, 2, 12, DUR_DEFAULT.rounds),
        };
      }
    } catch (e) {}
    return Object.assign({}, DUR_DEFAULT);
  }
  function loadSound() {
    try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) { return true; }
  }
  function loadNoiseOn() {
    try { return localStorage.getItem(NOISE_KEY) === '1'; } catch (e) { return false; }
  }
  function loadNoiseVol() {
    try {
      const raw = parseFloat(localStorage.getItem(NOISE_VOL_KEY));
      return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
    } catch (e) { return 0.5; }
  }
  function loadMode() {
    try { return localStorage.getItem(MODE_KEY) === 'countup' ? 'countup' : 'pomodoro'; }
    catch (e) { return 'pomodoro'; }
  }
  function savePreferences() {
    try {
      localStorage.setItem(DUR_KEY, JSON.stringify(durations));
      localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
      localStorage.setItem(NOISE_KEY, noiseOn ? '1' : '0');
      localStorage.setItem(NOISE_VOL_KEY, String(noiseVol));
      localStorage.setItem(MODE_KEY, mode);
      if (boundTaskId) {
        localStorage.setItem(TASK_KEY, boundTaskId);
        localStorage.setItem(KIND_KEY, boundKind || 'study');
      } else {
        localStorage.removeItem(TASK_KEY);
        localStorage.removeItem(KIND_KEY);
      }
    } catch (e) {}
  }
  function persistRuntime() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        version: 1,
        running, paused, mode, phase, remaining, elapsed, completedFocus,
        boundTaskId, boundTaskTitle, boundKind,
        goal: goalEl ? goalEl.value : '',
        pendingSession,
        outcome: outcomeEl ? outcomeEl.value : '',
        savedAt: Date.now(),
      }));
      lastRuntimePersistAt = Date.now();
    } catch (e) {}
  }
  function clearRuntime() {
    try { localStorage.removeItem(STATE_KEY); } catch (e) {}
  }
  function restoreRuntime() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || raw.version !== 1 || !raw.running) return;
    mode = raw.mode === 'countup' ? 'countup' : 'pomodoro';
    phase = raw.phase === 'break' ? 'break' : 'focus';
    running = true;
    paused = !!raw.paused;
    remaining = Math.max(0, Number(raw.remaining) || durations.focus * 60);
    elapsed = Math.max(0, Number(raw.elapsed) || 0);
    completedFocus = Math.max(0, Number(raw.completedFocus) || 0);
    boundTaskId = String(raw.boundTaskId || '');
    boundTaskTitle = String(raw.boundTaskTitle || '');
    boundKind = raw.boundKind === 'daily' ? 'daily' : (boundTaskId ? 'study' : '');
    if (goalEl) goalEl.value = String(raw.goal || '');
    if (raw.pendingSession && Number(raw.pendingSession.durationSec) >= LOG_MIN_SEC) {
      pendingSession = {
        durationSec: Math.round(Number(raw.pendingSession.durationSec)),
        goal: String(raw.pendingSession.goal || ''),
      };
      paused = true;
      if (outcomeEl) outcomeEl.value = String(raw.outcome || '');
      renderPendingWrapup();
      return;
    }
    const passed = paused ? 0 : Math.max(0, Math.floor((Date.now() - Number(raw.savedAt || Date.now())) / 1000));
    if (mode === 'countup') {
      elapsed += passed;
    } else if (passed >= remaining) {
      expiredRestore = {
        phase,
        durationSec: phase === 'focus' ? durations.focus * 60 : 0,
      };
      paused = true;
      remaining = 0;
    } else {
      remaining -= passed;
    }
    if (!paused && !expiredRestore) {
      lastTickAt = Date.now();
      startInterval();
    }
  }

  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    } catch (e) { audioCtx = null; }
  }
  function chime(kind) {
    if (!soundOn || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      const notes = kind === 'break' ? [523.25] : [523.25, 783.99];
      notes.forEach((frequency, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const startAt = now + index * 0.18;
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(0.14, startAt + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.9);
        osc.connect(gain).connect(audioCtx.destination);
        osc.onended = function () {
          try { osc.disconnect(); } catch (e) {}
          try { gain.disconnect(); } catch (e) {}
        };
        osc.start(startAt);
        osc.stop(startAt + 1);
      });
    } catch (e) {}
  }

  // 柔和噪音：循环播放打包内的真实雨声录音（assets/audio/rain.mp3）。
  // 解码后做一次「自交叉淡化」让首尾无缝，再以 loop=true 播放，避免接缝爆音。
  function makeSeamlessBuffer(decoded) {
    try {
      const sr = decoded.sampleRate;
      const ch = decoded.numberOfChannels;
      const n = decoded.length;
      let x = Math.floor(NOISE_XFADE_SEC * sr);
      if (x > Math.floor(n / 2)) x = Math.floor(n / 2);
      if (x < 1 || n <= x) return decoded;
      const outLen = n - x;
      const out = audioCtx.createBuffer(ch, outLen, sr);
      for (let c = 0; c < ch; c += 1) {
        const src = decoded.getChannelData(c);
        const dst = out.getChannelData(c);
        for (let i = x; i < outLen; i += 1) dst[i] = src[i];
        // 接缝区：头部淡入 + 尾部淡出（等功率），令循环点两端都平滑衔接
        for (let i = 0; i < x; i += 1) {
          const t = (i + 1) / (x + 1);
          const gIn = Math.sin(t * Math.PI / 2);
          const gOut = Math.cos(t * Math.PI / 2);
          dst[i] = src[i] * gIn + src[outLen + i] * gOut;
        }
      }
      return out;
    } catch (e) { return decoded; }
  }
  function startNoiseSource() {
    if (noiseNodes || !audioCtx || !noiseBuffer) return;
    try {
      const source = audioCtx.createBufferSource();
      source.buffer = noiseBuffer;
      source.loop = true;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(audioCtx.destination);
      source.start();
      noiseNodes = { source, gain };
    } catch (e) { noiseNodes = null; }
  }
  function ensureNoiseChain() {
    if (noiseNodes || !audioCtx) return;
    if (noiseBuffer) { startNoiseSource(); return; }
    if (noiseLoading) return;
    noiseLoading = true;
    fetch(NOISE_SRC_URL)
      .then((r) => { if (!r.ok) throw new Error('noise ' + r.status); return r.arrayBuffer(); })
      .then((ab) => audioCtx.decodeAudioData(ab))
      .then((decoded) => {
        noiseBuffer = makeSeamlessBuffer(decoded);
        noiseLoading = false;
        // 解码期间若已切到「应播放」，补建链并淡入
        if (noisePlaying) { startNoiseSource(); rampNoise(noiseTarget()); }
      })
      .catch(() => { noiseLoading = false; });
  }
  function noiseTarget() { return Math.max(0, Math.min(NOISE_MAX_GAIN, noiseVol * NOISE_MAX_GAIN)); }
  function rampNoise(target) {
    if (!noiseNodes || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      noiseNodes.gain.gain.cancelScheduledValues(now);
      noiseNodes.gain.gain.setTargetAtTime(target, now, 0.4);
    } catch (e) {}
  }
  // 仅在「专注阶段 · 运行中 · 未暂停 · 未到收尾」播放；其余状态淡出。
  function updateNoise() {
    const shouldPlay = noiseOn && running && !paused && !pendingSession && phase === 'focus';
    if (shouldPlay) { ensureAudio(); ensureNoiseChain(); }
    if (shouldPlay === noisePlaying) return;
    noisePlaying = shouldPlay;
    rampNoise(shouldPlay ? noiseTarget() : 0);
  }
  function updateNoiseVolRow() {
    if (noiseVolRow) noiseVolRow.hidden = !noiseOn;
  }
  function totalForPhase() {
    if (mode === 'countup') return 0;
    if (phase === 'break') {
      const longBreak = completedFocus > 0 && completedFocus % durations.rounds === 0;
      return (longBreak ? durations.long : durations.brk) * 60;
    }
    return durations.focus * 60;
  }
  function startInterval() {
    if (!ticker) ticker = setInterval(onTick, 1000);
  }
  function stopInterval() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    lastTickAt = 0;
  }
  function onTick() {
    if (paused || !running || pendingSession) return;
    const now = Date.now();
    if (!lastTickAt) { lastTickAt = now; return; }
    const delta = Math.floor((now - lastTickAt) / 1000);
    if (delta < 1) return;
    lastTickAt += delta * 1000;
    if (mode === 'countup') {
      elapsed += delta;
    } else {
      remaining -= delta;
      if (remaining <= 0) {
        remaining = 0;
        endPhase();
        return;
      }
    }
    syncDisplay();
    // savedAt 足以在恢复时补算经过时间；无需每秒做一次同步 localStorage 写入。
    if (now - lastRuntimePersistAt >= RUNTIME_PERSIST_MS) persistRuntime();
  }
  function start() {
    ensureAudio();
    if (!running) {
      running = true;
      paused = false;
      phase = 'focus';
      elapsed = 0;
      if (mode === 'pomodoro') remaining = durations.focus * 60;
    } else {
      paused = false;
    }
    lastTickAt = Date.now();
    startInterval();
    syncDisplay();
    persistRuntime();
    replayClass(primaryBtn, 'focus-control-cue');
    replayClass(phaseEl, 'focus-phase-changing');
  }
  function pause() {
    onTick();
    paused = true;
    lastTickAt = 0;
    syncDisplay();
    persistRuntime();
    replayClass(primaryBtn, 'focus-control-cue');
    replayClass(phaseEl, 'focus-phase-changing');
  }
  function reset() {
    exitZen();
    stopInterval();
    running = false;
    paused = false;
    phase = 'focus';
    completedFocus = 0;
    remaining = durations.focus * 60;
    elapsed = 0;
    pendingSession = null;
    if (goalEl) goalEl.value = '';
    clearRuntime();
    syncDisplay();
  }
  function pulseRing() {
    if (!ringWrap || prefersReduced) return;
    ringWrap.classList.remove('focus-pulse');
    void ringWrap.offsetWidth;
    ringWrap.classList.add('focus-pulse');
  }
  function endPhase() {
    if (phase === 'break') {
      chime('break');
      phase = 'focus';
      remaining = durations.focus * 60;
      syncDisplay();
      persistRuntime();
      replayClass(phaseEl, 'focus-phase-changing');
      return;
    }
    chime('focus');
    pulseRing();
    beginWrapup(mode === 'countup' ? elapsed : durations.focus * 60);
  }
  function finishSegment() {
    onTick();
    if (mode === 'countup') {
      if (elapsed >= LOG_MIN_SEC) beginWrapup(elapsed);
      else reset();
      return;
    }
    if (phase === 'break') {
      phase = 'focus';
      remaining = durations.focus * 60;
      syncDisplay();
      persistRuntime();
      replayClass(phaseEl, 'focus-phase-changing');
      return;
    }
    const done = durations.focus * 60 - remaining;
    if (done >= LOG_MIN_SEC) beginWrapup(done);
    else {
      phase = 'break';
      remaining = totalForPhase();
      syncDisplay();
      persistRuntime();
      replayClass(phaseEl, 'focus-phase-changing');
    }
  }

  function beginWrapup(durationSec) {
    exitZen();
    pendingSession = {
      durationSec: Math.max(LOG_MIN_SEC, Math.round(durationSec)),
      goal: goalEl ? goalEl.value.trim() : '',
    };
    paused = true;
    lastTickAt = 0;
    if (outcomeEl) outcomeEl.value = '';
    renderPendingWrapup();
    syncDisplay();
    persistRuntime();
    replayClass(phaseEl, 'focus-phase-changing');
  }
  function renderPendingWrapup() {
    if (!pendingSession) return;
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    if (wrapupTitleEl) {
      wrapupTitleEl.textContent = T('专注了 '
        + fmtLong(Math.max(1, Math.round(pendingSession.durationSec / 60))));
    }
    if (wrapupGoalEl) {
      wrapupGoalEl.textContent = pendingSession.goal
        ? T('目标：') + pendingSession.goal
        : T('这一段没有填写目标。');
    }
    if (wrapupDoneBtn) {
      wrapupDoneBtn.hidden = !boundTaskId;
      wrapupDoneBtn.textContent = boundKind === 'daily' ? T('保存并完成这件每日任务') : T('保存并完成任务');
    }
    if (wrapupEl) {
      wrapupEl.classList.remove('focus-card-exiting');
      wrapupEl.hidden = false;
      replayClass(wrapupEl, 'focus-card-entering');
    }
  }
  async function finishWrapup(action) {
    if (!pendingSession) return;
    const taskId = boundTaskId;
    const taskTitle = boundTaskTitle;
    const kind = boundKind;
    const durationSec = pendingSession.durationSec;
    const goal = pendingSession.goal;
    const outcome = outcomeEl ? outcomeEl.value.trim() : '';
    await logSession(durationSec, goal, outcome);
    if (action === 'done' && taskId) {
      if (kind === 'daily') {
        try {
          await completeDailyTask(taskId);
          toast('已保存专注记录，并完成今天的「' + taskTitle + '」');
        } catch (error) {
          toast('专注记录已保存，每日任务未更新 · ' + error.message);
        }
      } else {
        try {
          await post('/api/study-task-update', { id: taskId, status: 'done' });
          document.dispatchEvent(new CustomEvent('canvas:data-changed', {
            detail: { source: 'study', path: '/api/study-task-update' },
          }));
          if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
          toast('已保存专注记录，并完成任务 · ' + taskTitle);
        } catch (error) {
          toast('专注记录已保存，任务状态未更新 · ' + error.message);
        }
      }
    }
    pendingSession = null;
    dismiss(wrapupEl, 'focus-card-exiting');
    if (goalEl) goalEl.value = '';
    if (action === 'next') {
      if (mode === 'pomodoro') {
        completedFocus += 1;
        phase = 'break';
        remaining = totalForPhase();
      } else {
        elapsed = 0;
        phase = 'focus';
      }
      running = true;
      paused = false;
      lastTickAt = Date.now();
      startInterval();
      syncDisplay();
      persistRuntime();
      replayClass(phaseEl, 'focus-phase-changing');
    } else {
      reset();
    }
  }

  function logSession(durationSec, goal, outcome) {
    // 绑的是每日任务时：focus.json 不按学习任务汇总（taskId 留空，免污染学习统计），
    // 分钟另走 /api/daily-add-minutes 累计到每日任务；taskTitle 仍留作足迹圆点的显示名。
    const kind = boundKind;
    const dailyId = kind === 'daily' ? boundTaskId : '';
    const session = {
      id: 'fs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      mode,
      durationSec: Math.round(durationSec),
      taskId: kind === 'study' ? (boundTaskId || '') : '',
      taskTitle: boundTaskTitle || '',
      goal: String(goal || ''),
      outcome: String(outcome || ''),
      day: todayStr(),
      endedAt: new Date().toISOString(),
    };
    sessions.push(session);
    renderFootprint();
    const mins = Math.max(1, Math.round(session.durationSec / 60));
    toast(session.taskTitle ? '专注 ' + mins + ' 分 · ' + session.taskTitle + ' ✦ 已记下' : '专注 ' + mins + ' 分 ✦ 已记下');
    return post('/api/focus-log', session).then(() => {
      const dailyUpdate = dailyId ? addDailyMinutes(dailyId, mins) : Promise.resolve();
      return dailyUpdate.then(() => {
        document.dispatchEvent(new CustomEvent('canvas:data-changed', {
          detail: { source: 'focus', path: '/api/focus-log' },
        }));
        if (window.StudyView && window.StudyView.refresh) window.StudyView.refresh();
        return session;
      });
    }).catch((error) => {
      sessions = sessions.filter((item) => item.id !== session.id);
      renderFootprint();
      toast('专注记录未保存 · ' + error.message);
      throw error;
    });
  }

  function setRingProgress(progress) {
    if (!ringFill) return;
    const fraction = Math.max(0, Math.min(1, progress));
    ringFill.style.strokeDasharray = RING_C.toFixed(1);
    ringFill.style.strokeDashoffset = (RING_C * (1 - fraction)).toFixed(1);
  }
  function taskTagFor(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return '';
    if (task.focusDay === todayStr()) return T('［今日］');
    if (task.status === 'doing') return T('［进行中］');
    return '';
  }
  // 运行时在环下方常驻「正在做 + 目标 + 番茄轮次」；按签名跳过无变化的重建，避免每秒刷 DOM。
  function renderCockpit() {
    if (!cockpitEl) return;
    const show = running && !pendingSession;
    const goal = goalEl ? goalEl.value.trim() : '';
    const sig = [show ? 1 : 0, boundTaskId, boundTaskTitle, boundKind, goal, mode, completedFocus, phase, durations.rounds].join('|');
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
      if (boundTaskId) {
        const label = document.createElement('span');
        label.textContent = '正在做';
        const name = document.createElement('strong');
        const tag = boundKind === 'daily' ? T('［每日］') : taskTagFor(boundTaskId);
        name.textContent = tag + (boundTaskTitle || T('未命名任务'));
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
      if (mode !== 'pomodoro') {
        cockpitRoundsEl.hidden = true;
        cockpitRoundsEl.innerHTML = '';
      } else {
        const rounds = durations.rounds;
        const doneInCycle = completedFocus % rounds;
        cockpitRoundsEl.innerHTML = '';
        for (let i = 0; i < rounds; i += 1) {
          const pip = document.createElement('span');
          pip.className = 'focus-round-pip';
          if (i < doneInCycle) pip.classList.add('is-done');
          else if (i === doneInCycle && phase === 'focus') pip.classList.add('is-current');
          cockpitRoundsEl.appendChild(pip);
        }
        cockpitRoundsEl.setAttribute('aria-label', '番茄轮次 第 ' + (doneInCycle + 1) + ' / ' + rounds + ' 段');
        cockpitRoundsEl.hidden = false;
      }
    }
    if (wasHidden) replayClass(cockpitEl, 'focus-cockpit-in');
  }
  // 运行中（准备区已收起）也能补/改这一段的目标：点击座舱目标行就地编辑，写回 goalEl。
  function beginCockpitGoalEdit() {
    if (!cockpitGoalEditEl || !cockpitGoalEl || editingCockpitGoal) return;
    if (!running || pendingSession) return;
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
    if (mode === 'countup') {
      if (timeEl && !editingTime) timeEl.textContent = fmt(elapsed);
      setRingProgress(running ? (elapsed % 60) / 60 : 0);
    } else {
      const total = totalForPhase() || 1;
      const shown = running ? remaining : durations.focus * 60;
      if (timeEl && !editingTime) timeEl.textContent = fmt(shown);
      setRingProgress(running ? remaining / total : 1);
    }
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    let phaseText = T('准备开始');
    let dataPhase = 'idle';
    let viewState = 'ready';
    if (pendingSession) {
      phaseText = T('等待收尾');
      viewState = 'wrapup';
    }
    else if (running) {
      if (mode === 'countup') {
        phaseText = paused ? T('已暂停') : T('专注中');
        dataPhase = paused ? 'paused' : 'focus';
        viewState = paused ? 'paused' : 'focus';
      } else if (phase === 'break') {
        phaseText = paused ? T('休息（暂停）') : T('休息一下');
        dataPhase = paused ? 'paused' : 'break';
        viewState = paused ? 'paused' : 'break';
      } else {
        phaseText = paused ? T('已暂停') : T('专注 · 第 ' + (completedFocus + 1) + ' 段');
        dataPhase = paused ? 'paused' : 'focus';
        viewState = paused ? 'paused' : 'focus';
      }
    }
    if (phaseEl) phaseEl.textContent = phaseText;
    if (ringWrap) ringWrap.dataset.phase = dataPhase;
    if (captionEl) captionEl.textContent = mode === 'countup'
      ? T('正计时 · 自由专注，按「完成」记一段')
      : T('番茄钟 · 专注 ' + durations.focus + ' / 休息 ' + durations.brk + ' 分');
    if (primaryBtn) {
      primaryBtn.textContent = running ? (paused ? T('继续') : T('暂停')) : T('开始');
      primaryBtn.disabled = !!pendingSession;
    }
    if (finishBtn) {
      finishBtn.hidden = !running || !!pendingSession;
      finishBtn.textContent = mode === 'countup' ? T('完成') : (phase === 'break' ? T('跳过休息') : T('完成本段'));
    }
    if (resetBtn) resetBtn.hidden = !running || !!pendingSession;
    if (taskSelect) taskSelect.disabled = running || !!pendingSession;
    if (goalEl) goalEl.disabled = running || !!pendingSession;
    root.dataset.running = running && !paused && !pendingSession ? '1' : '0';
    root.dataset.state = viewState;
    root.dataset.hasSessions = sessions.some((session) => sessionDay(session) === (footprintDay || todayStr())) ? '1' : '0';
    if (timeEl) {
      timeEl.classList.toggle('is-editable', mode === 'pomodoro' && !running && !pendingSession);
      timeEl.title = mode === 'pomodoro' ? T('双击修改专注时长') : T('正计时从 00:00 开始');
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
        && source.canvasPath && source.rootId;
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

  function setMode(next) {
    if ((next !== 'pomodoro' && next !== 'countup') || next === mode || running) return;
    mode = next;
    elapsed = 0;
    remaining = durations.focus * 60;
    savePreferences();
    syncModeUI();
    syncDisplay();
    replayModeCue();
  }
  function syncModeUI() {
    if (!modeSwitch) return;
    modeSwitch.querySelectorAll('button[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });
    if (modeSlider) modeSlider.style.transform = mode === 'countup' ? 'translateX(100%)' : 'translateX(0)';
  }
  function loadTasks() {
    return fetch('/api/study').then((response) => response.json()).then((json) => {
      tasks = json && Array.isArray(json.tasks) ? json.tasks : [];
      renderTaskOptions();
    }).catch(() => {});
  }

  // 「更新」按钮：强制重读任务/每日/记录。平时翻进专注页用缓存，不重读。
  async function refreshFocus(btn) {
    if (btn) btn.classList.add('is-refreshing');
    try {
      await Promise.all([loadTasks(), loadDaily(), loadSessions()]);
      toast('专注数据已更新');
    } finally {
      if (btn) btn.classList.remove('is-refreshing');
    }
  }
  function renderTaskOptions() {
    if (!taskSelect) return;
    const today = todayStr();
    const active = tasks.filter((task) => task && task.status !== 'done');
    const rank = { doing: 0, todo: 1 };
    active.sort((a, b) => {
      const ax = a.focusDay === today ? -1 : (rank[a.status] ?? 2);
      const bx = b.focusDay === today ? -1 : (rank[b.status] ?? 2);
      return ax - bx;
    });
    taskSelect.innerHTML = '<option value="">' + T('不绑定 · 只是专注') + '</option>';
    if (active.length) {
      const group = document.createElement('optgroup');
      group.label = T('学习任务');
      active.forEach((task) => {
        const option = document.createElement('option');
        option.value = task.id;
        const tag = task.focusDay === today ? T('［今日］') : (task.status === 'doing' ? T('［进行中］') : '');
        option.textContent = tag + (task.title || T('未命名任务'));
        group.appendChild(option);
      });
      taskSelect.appendChild(group);
    }
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
    if (boundKind === 'daily') {
      const task = dailyTasks.find((item) => item.id === boundTaskId);
      if (task) {
        taskSelect.value = 'daily:' + boundTaskId;
        boundTaskTitle = task.name || '';
      } else if (!running) {
        boundKind = ''; boundTaskId = ''; boundTaskTitle = ''; taskSelect.value = '';
      }
    } else if (boundTaskId && active.some((task) => task.id === boundTaskId)) {
      boundKind = 'study';
      taskSelect.value = boundTaskId;
      const task = tasks.find((item) => item.id === boundTaskId);
      boundTaskTitle = task ? task.title || '' : boundTaskTitle;
    } else if (boundTaskId && !running) {
      boundKind = ''; boundTaskId = ''; boundTaskTitle = ''; taskSelect.value = '';
    }
  }
  function bindTask(id, title, kind) {
    if (running || pendingSession) {
      toast('请先完成或重置当前专注段');
      return false;
    }
    boundTaskId = String(id || '');
    boundTaskTitle = String(title || '');
    boundKind = id ? (kind || 'study') : '';
    if (taskSelect) taskSelect.value = boundKind === 'daily' ? 'daily:' + boundTaskId : boundTaskId;
    savePreferences();
    showBindFeedback();
    return true;
  }
  function onTaskChange() {
    const value = taskSelect.value || '';
    if (value.indexOf('daily:') === 0) {
      const id = value.slice(6);
      const task = dailyTasks.find((item) => item.id === id);
      bindTask(task ? task.id : '', task ? task.name || '' : '', task ? 'daily' : '');
    } else {
      const task = tasks.find((item) => item.id === value);
      bindTask(task ? task.id : '', task ? task.title || '' : '', task ? 'study' : '');
    }
  }
  function loadSessions() {
    return fetch('/api/focus').then((response) => response.json()).then((json) => {
      sessions = json && Array.isArray(json.sessions) ? json.sessions : [];
      loadedSessions = true;
      renderFootprint();
    }).catch(() => renderFootprint());
  }

  // ── 每日任务侧栏（习惯清单，Tab 开合；与学习任务、.canvas 完全解耦）─────────────
  function replayDailyPanelEntrance() {
    if (!dailyRoot || prefersReduced || !dailyOpen) return;
    clearTimeout(dailyRevealTimer);
    dailyRoot.classList.remove('is-revealing');
    void dailyRoot.offsetWidth;
    dailyRoot.classList.add('is-revealing');
    dailyRevealTimer = setTimeout(() => {
      if (dailyRoot) dailyRoot.classList.remove('is-revealing');
      dailyRevealTimer = 0;
    }, 980);
  }
  function setDailyOpen(open) {
    const wasOpen = dailyOpen;
    if (open && !wasOpen) rememberDailyFocus();
    dailyOpen = !!open;
    if (dailyRoot) {
      if (dailyOpen) {
        dailyRoot.hidden = false; void dailyRoot.offsetWidth;
        dailyRoot.classList.remove('is-closing');
        dailyRoot.classList.add('is-open');
      } else if (wasOpen) {
        endDailyPointerDrag(null, false);
        clearTimeout(dailyRevealTimer);
        dailyRoot.classList.remove('is-revealing', 'is-peeking');
        closeDailyHistory();
        closeDailyDetail({ restore: false });
        if (prefersReduced) {
          dailyRoot.classList.remove('is-open');
        } else {
          dailyRoot.classList.add('is-closing');
          const finish = () => {
            dailyRoot.classList.remove('is-open', 'is-closing');
            dailyRoot.removeEventListener('animationend', finish);
          };
          dailyRoot.addEventListener('animationend', finish, { once: true });
          clearTimeout(dailyRevealTimer);
          dailyRevealTimer = setTimeout(finish, 400);
        }
      }
      syncDailyPanelFocusability();
    }
    if (bookView) bookView.classList.toggle('focus-daily-open', dailyOpen);
    if (dailyHandle) dailyHandle.setAttribute('aria-expanded', dailyOpen ? 'true' : 'false');
    if (dailyOpen) {
      if (!dailyLoaded) {
        loadDaily().then(() => replayDailyPanelEntrance());
      } else {
        renderDaily({ opening: true });
        replayDailyPanelEntrance();
      }
      if (dailyInputEl && !dailyTasks.length) setTimeout(() => dailyInputEl.focus(), 220);
      else setTimeout(settleDailyPanelFocus, 80);
    } else if (wasOpen) {
      restoreDailyFocus();
    }
  }
  function toggleDaily(force) {
    setDailyOpen(typeof force === 'boolean' ? force : !dailyOpen);
  }
  function allDailyDone() {
    return dailyTasks.length > 0 && dailyTasks.every((task) => task.doneToday);
  }
  function dailyTodayMinutesTotal() {
    return dailyTasks.reduce((sum, task) => sum + (Number(task.todayMinutes) || 0), 0);
  }
  function applyDailyPayload(json) {
    const payload = json && json.daily ? json.daily : json;
    if (payload && Array.isArray(payload.tasks)) dailyTasks = payload.tasks;
    if (payload && Array.isArray(payload.groups)) dailyGroups = payload.groups;
  }
  function loadDaily() {
    return fetch('/api/daily').then((response) => response.json()).then((json) => {
      dailyTasks = json && Array.isArray(json.tasks) ? json.tasks : [];
      dailyGroups = json && Array.isArray(json.groups) ? json.groups : [];
      dailyLoaded = true;
      dailyWasAllDone = allDailyDone();
      renderDaily({ initial: true });
      renderTaskOptions();
    }).catch(() => {});
  }

  function renderDaily(opts) {
    opts = opts || {};
    if (!dailyListEl || dailyClearing) return;
    const allDone = allDailyDone();
    if (!allDone) dailyPeek = false;
    const became = allDone && !dailyWasAllDone && !opts.initial;
    dailyWasAllDone = allDone;
    rebuildDailyRows({ flip: !opts.initial && dailyOpen });
    syncDailyPanelFocusability();
    updateDailyFoot();
    updateDailyComposeUI();
    renderDailyHistory();
    renderDailyDetail();
    if (allDone && !dailyPeek) {
      if (became && !prefersReduced) startDailyClear();
      else showDailyCelebrate(false);
    } else {
      hideDailyCelebrate();
    }
  }
  // FLIP 的身份键：任务用 t:id，分组头用 g:id，二者同列参与位移动画（折叠/重排都顺滑）
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

  // —— 分组树工具：分组与任务各自扁平存储，靠 parentId / groupId 现推出层级 ——
  function dailyGroupById(id) { return dailyGroups.find((g) => g.id === id) || null; }
  function dailyChildGroups(parentId) {
    const pid = parentId || '';
    return dailyGroups.filter((g) => (g.parentId || '') === pid);
  }
  function dailyDirectTasks(groupId) {
    const gid = groupId || '';
    return dailyTasks.filter((t) => (t.groupId || '') === gid);
  }
  function dailyGroupProgress(groupId) {
    let done = 0;
    let total = 0;
    dailyDirectTasks(groupId).forEach((t) => { total += 1; if (t.doneToday) done += 1; });
    dailyChildGroups(groupId).forEach((g) => {
      const sub = dailyGroupProgress(g.id);
      done += sub.done;
      total += sub.total;
    });
    return { done: done, total: total };
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
    dailyListEl.innerHTML = '';
    if (!dailyTasks.length && !dailyGroups.length) {
      const empty = document.createElement('p');
      empty.className = 'focus-daily-empty';
      empty.textContent = '还没有每日任务 · 在下面加一件想每天坚持的事';
      dailyListEl.appendChild(empty);
      return;
    }
    // 借鉴博客分类树：每层先列子分组，再列本层任务。子树渲进 .focus-daily-group-children 容器，
    // 始终渲染（即便折叠），折叠交给 CSS grid-rows 平滑收合——不再靠重建，避免子项瞬移。
    let index = 0;
    const renderInto = (container, parentId, depth) => {
      dailyChildGroups(parentId).forEach((group) => {
        const wrap = buildDailyGroupRow(group, depth);
        wrap.style.setProperty('--daily-row-index', String(index++));
        container.appendChild(wrap);
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'focus-daily-group-children';
        const inner = document.createElement('div');
        inner.className = 'focus-daily-group-children-inner';
        if (group.collapsed) inner.setAttribute('inert', '');   // 折叠子树不可聚焦/点击
        childrenWrap.appendChild(inner);
        wrap.appendChild(childrenWrap);
        renderInto(inner, group.id, depth + 1);
      });
      dailyDirectTasks(parentId).forEach((task) => {
        const row = buildDailyRow(task, depth);
        row.style.setProperty('--daily-row-index', String(index++));
        container.appendChild(row);
      });
    };
    renderInto(dailyListEl, '', 0);
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
      .slice(0, 6)
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
    const keep = new Set(layout.map((entry) => entry.milestone.id));
    layer.querySelectorAll('.focus-daily-milestone').forEach((marker) => {
      if (keep.has(marker.dataset.milestoneId)) return;
      if (prefersReduced) marker.remove();
      else {
        marker.classList.add('is-leaving');
        window.setTimeout(() => marker.remove(), 220);
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
        if (!prefersReduced) window.setTimeout(() => marker.classList.remove('is-entering'), 260);
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
  function closeDailyHistory() {
    dailyHistoryTaskId = '';
    dailyHistoryMonth = '';
    if (!dailyRoot) return;
    const old = dailyRoot.querySelector('[data-role="daily-history-pop"]');
    if (!old) return;
    window.clearTimeout(dailyHistoryCloseTimer);
    if (prefersReduced) { old.remove(); dailyHistoryCloseTimer = 0; return; }
    old.classList.add('is-closing');
    const finish = () => {
      if (old.isConnected) old.remove();
      dailyHistoryCloseTimer = 0;
    };
    old.addEventListener('animationend', finish, { once: true });
    dailyHistoryCloseTimer = window.setTimeout(finish, 260);
  }
  function openDailyHistory(id) {
    const task = dailyTasks.find((item) => item.id === id);
    if (!task || !dailyRoot) return;
    dailyHistoryTaskId = id;
    dailyHistoryMonth = monthKeyFromDay(task.lastDoneDate || todayStr());
    renderDailyHistory();
  }
  function moveDailyHistoryMonth(delta) {
    if (!dailyHistoryTaskId) return;
    dailyHistoryMonth = shiftMonthKey(dailyHistoryMonth || todayStr().slice(0, 7), delta);
    renderDailyHistory();
  }
  function renderDailyHistory() {
    if (!dailyRoot) return;
    const old = dailyRoot.querySelector('[data-role="daily-history-pop"]');
    if (old && !prefersReduced) {
      window.clearTimeout(dailyHistoryCloseTimer);
      old.classList.add('is-closing');
      const proceed = () => {
        if (old.isConnected) old.remove();
        dailyHistoryCloseTimer = 0;
        renderDailyHistory();
      };
      old.addEventListener('animationend', proceed, { once: true });
      dailyHistoryCloseTimer = window.setTimeout(proceed, 260);
      return;
    }
    if (old) old.remove();
    if (!dailyHistoryTaskId) return;
    const task = dailyTasks.find((item) => item.id === dailyHistoryTaskId);
    if (!task) { dailyHistoryTaskId = ''; dailyHistoryMonth = ''; return; }
    if (!dailyHistoryMonth) dailyHistoryMonth = monthKeyFromDay(task.lastDoneDate || todayStr());
    const doneDates = dailyDoneDateSet(task);
    const minutesByDate = dailyMinutesMap(task);
    const today = todayStr();

    const panel = document.createElement('section');
    panel.className = 'focus-daily-history';
    panel.dataset.role = 'daily-history-pop';
    panel.setAttribute('aria-label', '打卡日历 · ' + (task.name || '每日任务'));

    const head = document.createElement('header');
    const copy = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'study-eyebrow';
    eyebrow.textContent = 'HABIT';
    const title = document.createElement('h3');
    title.textContent = task.name || '每日任务';
    const stat = document.createElement('span');
    stat.textContent = dailyStatText(task);
    copy.append(eyebrow, title, stat);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'focus-daily-history-close';
    close.dataset.action = 'daily-history-close';
    close.setAttribute('aria-label', '关闭打卡日历');
    close.textContent = '×';
    head.append(copy, close);
    panel.appendChild(head);

    const nav = document.createElement('div');
    nav.className = 'focus-daily-history-nav';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.dataset.action = 'daily-history-prev';
    prev.setAttribute('aria-label', '上个月');
    prev.textContent = '‹';
    const month = document.createElement('strong');
    month.textContent = monthLabel(dailyHistoryMonth);
    const next = document.createElement('button');
    next.type = 'button';
    next.dataset.action = 'daily-history-next';
    next.setAttribute('aria-label', '下个月');
    next.textContent = '›';
    const now = document.createElement('button');
    now.type = 'button';
    now.className = 'focus-daily-history-today';
    now.dataset.action = 'daily-history-today';
    now.textContent = '今天';
    nav.append(prev, month, next, now);
    panel.appendChild(nav);

    const weekdays = document.createElement('div');
    weekdays.className = 'focus-daily-history-weekdays';
    ['一', '二', '三', '四', '五', '六', '日'].forEach((label) => {
      const span = document.createElement('span');
      span.textContent = label;
      weekdays.appendChild(span);
    });
    panel.appendChild(weekdays);

    const grid = document.createElement('div');
    grid.className = 'focus-daily-history-grid';
    monthCells(dailyHistoryMonth).forEach((cell, index) => {
      const day = document.createElement('span');
      day.className = 'focus-daily-history-day';
      if (!cell.current) day.classList.add('outside');
      if (cell.date === today) day.classList.add('today');
      if (doneDates.has(cell.date)) day.classList.add('is-done');
      day.style.setProperty('--daily-history-delay', Math.min(index, 24) * 4 + 'ms');
      const num = document.createElement('b');
      num.textContent = String(cell.number);
      day.appendChild(num);
      const mins = Number(minutesByDate[cell.date]) || 0;
      if (mins > 0) {
        const small = document.createElement('small');
        small.textContent = mins + 'm';
        day.appendChild(small);
      }
      day.title = cell.date + (doneDates.has(cell.date) ? ' · 已打卡' : '') + (mins > 0 ? ' · ' + mins + ' 分钟' : '');
      grid.appendChild(day);
    });
    panel.appendChild(grid);

    const foot = document.createElement('footer');
    const recorded = doneDates.size;
    const totalDays = Number(task.totalDays) || 0;
    const best = Number(task.bestStreak) || 0;
    foot.innerHTML = '<span><i></i>已打卡 ' + recorded + ' 天</span>'
      + (totalDays && totalDays !== recorded ? '<span>累计 ' + totalDays + ' 天</span>' : '')
      + (best ? '<span>最佳连续 ' + best + ' 天</span>' : '');
    panel.appendChild(foot);

    dailyRoot.appendChild(panel);
  }
  function getDailyDetailShell() {
    return root.querySelector('[data-role="daily-detail"]');
  }
  function closeDailyDetail(options) {
    const opts = options || {};
    const old = getDailyDetailShell();
    const returnEl = dailyDetailReturnEl;
    window.clearTimeout(dailyDetailCloseTimer);
    window.clearTimeout(dailyDetailMonthMotionTimer);
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
      window.clearTimeout(dailyDetailCloseTimer);
      old.removeEventListener('animationend', onEnd);
      if (old.isConnected) old.remove();
      dailyDetailCloseTimer = 0;
      restore();
    };
    const onEnd = (event) => {
      if (event.target === old || event.target.classList.contains('focus-daily-detail')) finish();
    };
    old.addEventListener('animationend', onEnd);
    dailyDetailCloseTimer = window.setTimeout(finish, 350);
  }
  function openDailyDetail(id, returnEl) {
    const task = dailyTasks.find((item) => item.id === id);
    if (!task) return;
    window.clearTimeout(dailyDetailCloseTimer);
    dailyDetailCloseTimer = 0;
    closeDailyHistory();
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
  function dailyDetailStat(label, value, hint) {
    const item = document.createElement('div');
    item.className = 'focus-daily-detail-stat';
    const small = document.createElement('span');
    small.textContent = label;
    const strong = document.createElement('strong');
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
    window.clearTimeout(dailyDetailMonthMotionTimer);
    grid.classList.remove('is-entering', 'is-month-settling', 'is-next', 'is-prev', 'is-today');
    if (monthEl) monthEl.classList.remove('is-month-settling');
    void grid.offsetWidth;
    grid.classList.add('is-entering');
    if (monthEl) monthEl.classList.add('is-month-settling');
    dailyDetailMonthMotionTimer = window.setTimeout(() => {
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
  function renderDailyDetailCalendar(direction) {
    if (!dailyDetailTaskId) return;
    const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
    const shell = root.querySelector('[data-role="daily-detail"]');
    if (!task || !shell) { renderDailyDetail(); return; }
    const monthEl = shell.querySelector('[data-role="daily-detail-month"]');
    const grid = shell.querySelector('[data-role="daily-detail-grid"]');
    if (!monthEl || !grid) { renderDailyDetail(); return; }
    monthEl.textContent = monthLabel(dailyDetailMonth);
    fillDailyDetailCalendar(grid, task);
    playDailyDetailMonthMotion(grid, monthEl, direction);
  }
  function renderDailyDetail() {
    window.clearTimeout(dailyDetailMonthMotionTimer);
    dailyDetailMonthMotionTimer = 0;
    const old = root.querySelector('[data-role="daily-detail"]');
    if (old) old.remove();
    if (!dailyDetailTaskId) return;
    const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
    if (!task) { dailyDetailTaskId = ''; dailyDetailMonth = ''; return; }
    if (!dailyDetailMonth) dailyDetailMonth = monthKeyFromDay(task.lastDoneDate || todayStr());

    const today = todayStr();
    const doneDates = dailyDoneDateSet(task);
    const minutesByDate = dailyMinutesMap(task);
    const orderedDates = Array.from(doneDates).sort();
    const todayMinutes = Number(task.todayMinutes) || 0;
    const target = Number(task.targetMinutes) || 0;
    const totalMinutes = Number(task.totalMinutes) || 0;
    const dayGoal = dailyGoalState(task);
    const recorded = doneDates.size;
    const group = task.groupId ? dailyGroupById(task.groupId) : null;
    const groupLabel = group ? dailyGroupPathLabel(group) : T('未分组');
    const boundHere = boundKind === 'daily' && boundTaskId === task.id;

    const shell = document.createElement('div');
    shell.className = 'focus-daily-detail-shell';
    shell.dataset.role = 'daily-detail';
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
    if (running || pendingSession) bind.disabled = true;
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
    actions.append(bind, toggle, edit, close);
    head.append(copy, actions);
    panel.appendChild(head);

    const stats = document.createElement('div');
    stats.className = 'focus-daily-detail-stats';
    stats.append(
      dailyDetailStat('今天', target > 0 ? todayMinutes + ' / ' + target : String(todayMinutes), '分钟'),
      dailyDetailStat('连续', String(Number(task.streak) || 0), '天'),
      dailyDetailStat('累计', String(Number(task.totalDays) || recorded), '天'),
      dailyDetailStat('最佳', String(Number(task.bestStreak) || 0), '天'),
      dailyDetailStat('专注', String(totalMinutes), '分钟')
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

    const recentBlock = dailyDetailBlock('最近打卡');
    const recent = document.createElement('div');
    recent.className = 'focus-daily-detail-recent';
    orderedDates.slice(-10).reverse().forEach((day) => {
      const chip = document.createElement('span');
      chip.textContent = day.slice(5);
      if (day === today) chip.classList.add('today');
      recent.appendChild(chip);
    });
    if (!recent.childElementCount) {
      const empty = document.createElement('p');
      empty.textContent = '还没有历史打卡';
      recent.appendChild(empty);
    }
    recentBlock.appendChild(recent);
    side.appendChild(recentBlock);

    const noteBlock = dailyDetailBlock('记录');
    const note = document.createElement('p');
    note.className = 'focus-daily-detail-note';
    note.textContent = recorded
      ? '已记录 ' + recorded + ' 个打卡日，最近一次是 ' + orderedDates[orderedDates.length - 1] + '。'
      : '完成第一次打卡后，这里会开始沉淀它的日历轨迹。';
    noteBlock.appendChild(note);
    side.appendChild(noteBlock);

    body.appendChild(side);
    panel.appendChild(body);
    shell.appendChild(panel);
    root.appendChild(shell);
    if (!prefersReduced) {
      grid.classList.add('is-entering');
      window.clearTimeout(dailyDetailMonthMotionTimer);
      dailyDetailMonthMotionTimer = window.setTimeout(() => {
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
    check.setAttribute('aria-label', (task.doneToday ? '取消完成 · ' : '标记完成 · ') + (task.name || '每日任务'));
    row.appendChild(check);

    const main = document.createElement('div');
    main.className = 'focus-daily-main';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'focus-daily-name';
    name.textContent = task.name || '未命名';
    main.appendChild(name);

    const stat = document.createElement('div');
    stat.className = 'focus-daily-stat';
    stat.textContent = dailyStatText(task);
    main.appendChild(stat);

    if (dailyGoalState(task).target > 0) main.appendChild(buildDailyGoalProgress(task));

    if (dailyEditId === task.id) main.appendChild(buildDailyEditor(task));
    row.appendChild(main);

    const history = document.createElement('button');
    history.type = 'button';
    history.className = 'focus-daily-history-btn';
    history.dataset.role = 'daily-history';
    history.setAttribute('aria-label', '查看打卡日历 · ' + (task.name || '每日任务'));
    history.textContent = '日';
    row.appendChild(history);

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
    const targetWrap = document.createElement('label');
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
      advanced.textContent = T('高级设置') + (count ? ' · ' + count + '/6' : '');
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
    if (groupRow) box.append(nameIn, targetWrap, goalWrap, groupRow, actions);
    else box.append(nameIn, targetWrap, goalWrap, actions);
    return box;
  }
  function cloneDailyMilestones(items) {
    return (Array.isArray(items) ? items : []).slice(0, 6).map((item, index) => ({
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
      add.disabled = count >= 6;
      add.textContent = count >= 6 ? T('已达到 6 个上限') : T('添加小目标') + ' · ' + count + '/6';
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
    if (row.classList.contains('is-entering')) window.setTimeout(() => row.classList.remove('is-entering'), 260);
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
    intro.textContent = T('把累计目标拆成最多 6 个有名字的小目标。达成状态会根据累计打卡天数自动点亮。');
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
      if (button) button.textContent = T('高级设置') + (dailyEditMilestones && dailyEditMilestones.length ? ' · ' + dailyEditMilestones.length + '/6' : '');
      if (!instant && returnEl && returnEl.isConnected) returnEl.focus();
    };
    if (instant || prefersReduced) { finish(); return; }
    shell.classList.remove('is-open');
    shell.classList.add('is-closing');
    shell.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 260);
  }
  function updateDailyFoot() {
    if (!dailyFootEl) return;
    const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
    if (!dailyTasks.length) { dailyFootEl.textContent = ''; return; }
    const done = dailyTasks.filter((task) => task.doneToday).length;
    const mins = dailyTodayMinutesTotal();
    dailyFootEl.textContent = T('今天 ' + done + ' / ' + dailyTasks.length + ' 完成'
      + (mins > 0 ? ' · 今日已专注 ' + mins + ' 分' : ''));
  }
  function pulseDailyFoot() {
    if (!dailyFootEl || prefersReduced) return;
    replayClass(dailyFootEl, 'is-updating');
  }
  function startDailyClear(settleDelay) {
    clearTimeout(dailyClearTimer);
    dailyClearing = true;
    if (dailyRoot) dailyRoot.classList.add('is-completing');
    const items = Array.prototype.slice.call(dailyListEl.children).filter((el) =>
      el.classList.contains('focus-daily-row') || el.classList.contains('focus-daily-group'));
    dailyClearTimer = setTimeout(() => {
      items.forEach((el, index) => {
        el.classList.remove('is-complete-pop', 'is-reopen-pop');
        el.style.setProperty('--daily-clear-delay', (index * 76) + 'ms');
        el.classList.add('is-clearing');
      });
      // 末项滑完即触发庆祝，animationend 为主、setTimeout 兜底
      const last = items[items.length - 1];
      let fired = false;
      const reveal = () => { if (!fired) { fired = true; dailyClearing = false; showDailyCelebrate(true); } };
      if (last && !prefersReduced) last.addEventListener('animationend', reveal, { once: true });
      dailyClearTimer = setTimeout(reveal, items.length * 76 + 460);
    }, Math.max(0, Number(settleDelay) || 240));
  }
  function showDailyCelebrate(animate) {
    if (!dailyCelebrateEl) return;
    if (dailyRoot) dailyRoot.classList.remove('is-completing');
    if (dailyListEl) dailyListEl.hidden = true;
    if (dailyAddForm) dailyAddForm.classList.add('is-dimmed');
    if (dailyFootEl) dailyFootEl.hidden = true;
    if (dailyCelebrateSubEl) {
      const count = dailyTasks.length;
      const mins = dailyTodayMinutesTotal();
      dailyCelebrateSubEl.textContent = count + ' 件全部完成'
        + (mins > 0 ? ' · 专注 ' + mins + ' 分钟' : '') + ' · 明天见';
    }
    dailyCelebrateEl.hidden = false;
    if (animate && !prefersReduced) {
      if (dailyRoot) replayClass(dailyRoot, 'is-celebrate-ready');
      replayClass(dailyCelebrateEl, 'is-celebrating');
    }
  }
  function hideDailyCelebrate() {
    clearTimeout(dailyClearTimer);
    dailyClearing = false;
    if (dailyRoot) dailyRoot.classList.remove('is-completing', 'is-celebrate-ready');
    if (dailyCelebrateEl) dailyCelebrateEl.hidden = true;
    if (dailyListEl) dailyListEl.hidden = false;
    if (dailyAddForm) dailyAddForm.classList.remove('is-dimmed');
    if (dailyFootEl) dailyFootEl.hidden = false;
  }
  function dailyPeekList() {
    dailyPeek = true;
    if (dailyRoot && !prefersReduced) {
      clearTimeout(dailyRevealTimer);
      dailyRoot.classList.remove('is-peeking');
      void dailyRoot.offsetWidth;
      dailyRoot.classList.add('is-peeking');
      dailyRevealTimer = setTimeout(() => {
        if (dailyRoot) dailyRoot.classList.remove('is-peeking');
        dailyRevealTimer = 0;
      }, 820);
    }
    hideDailyCelebrate();
    renderDaily();
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
  const DAILY_INDENT_PX = 16;   // 横向每 16px = 一个层级，与渲染缩进步长一致
  // 一行的真实层级（不夹取；区别于渲染缩进用的 --daily-depth 上限 5）
  function dailyRowDepth(el) { return el ? dailyDepthOf(dailyResolvedParent(el)) : 0; }
  // 从间隙上方那行 prev 沿祖先链，找出「子项层级 == depth」的分组 id（depth=0 → 根 ''）
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
  // 落点判定（v1 重做）：纵向选间隙；横向（相对按下点位移，每 16px 一级）选层级，夹进该间隙的合法层级区间。
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
  // 落点线锚点 = 拖拽项「真正会渲染到的位置」前的那个元素 → 线画在哪就落在哪（所见即所得）
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
  // 落点指示（v1·稳）：纵向选间隙、横向（相对按下点位移）定层级 → 画一条「缩进到目标层级」的落点线 +
  // 高亮「将落入」的分组头；线画在真实落点前 = 所见即所得。**不挪占位行**（拖动期 DOM 不变 → 命中稳、预览==落点）。
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
      .then((json) => { applyDailyPayload(json); renderTaskOptions(); })
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
    if (!d.active) return;
    if (event && event.preventDefault) event.preventDefault();
    if (document.body) document.body.classList.remove('focus-daily-dragging');
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
        || dailyGroupConfirmDeleteId || dailyClearing || dailyDrag) return;
    // 这些控件是纯点击，不从它们起拖（勾选 / 编辑器内部 / 折叠箭头 / ⋯菜单）
    if (event.target.closest('[data-role="daily-check"], [data-role="daily-history"], [data-role="daily-menu"], .focus-daily-edit, .focus-daily-milestone, [data-role="daily-group-toggle"], [data-role="daily-group-menu"]')) return;
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
    window.addEventListener('pointermove', onDailyPointerMove);
    window.addEventListener('pointerup', onDailyPointerUp);
    window.addEventListener('pointercancel', onDailyPointerCancel);
  }

  // 点任务名/空白处的轻反馈：不改状态，只让 ⋯ 轻跳一下（提示编辑入口），尊重 reduced-motion。
  function hintDailyRow(row) {
    if (!row || prefersReduced) return;
    row.classList.remove('is-hint');
    void row.offsetWidth;   // 重启动画
    row.classList.add('is-hint');
    window.clearTimeout(dailyHintTimers.get(row));
    dailyHintTimers.set(row, window.setTimeout(() => row.classList.remove('is-hint'), 640));
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
    const target = Math.max(0, Math.min(600, parseInt(targetIn ? targetIn.value : '0', 10) || 0));
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
        renderTaskOptions();
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
      .then((json) => { applyDailyPayload(json); renderDaily(); renderTaskOptions(); toast('已删除'); })
      .catch((error) => { renderDaily(); toast(error.message); });
    const row = dailyListEl.querySelector('.focus-daily-row[data-id="' + id + '"]');
    if (row && !prefersReduced) {
      row.classList.add('is-removing');
      let sent = false;
      const fire = () => { if (!sent) { sent = true; send(); } };
      row.addEventListener('animationend', fire, { once: true });
      setTimeout(fire, 400);
    } else {
      send();
    }
  }
  function createDailyTask(name, groupId) {
    name = (name || '').trim();
    if (!name) return;
    const prevIds = dailyTasks.map((task) => task.id);
    post('/api/daily-create', { name: name, groupId: groupId || '' })
      .then((json) => {
        applyDailyPayload(json);
        const fresh = dailyTasks.find((task) => prevIds.indexOf(task.id) < 0);
        dailyEnterId = fresh ? fresh.id : '';
        if (dailyInputEl) { dailyInputEl.value = ''; dailyInputEl.focus(); }
        renderDaily();
        renderTaskOptions();
      })
      .catch((error) => toast(error.message));
  }
  // 分组就地展开时让直接子项「一个一个」逐步揭示（与面板打开的逐行入场同手法），
  // 而非整块一起冒出。临时加 .is-expanding + 逐项 --daily-expand-index 驱动交错，结束后清理。
  function playGroupExpandStagger(wrap) {
    if (!wrap || prefersReduced) return;
    const inner = wrap.querySelector(':scope > .focus-daily-group-children > .focus-daily-group-children-inner');
    if (!inner) return;
    const kids = Array.prototype.slice.call(inner.children)
      .filter((el) => el.classList.contains('focus-daily-row') || el.classList.contains('focus-daily-group'));
    if (!kids.length) return;
    kids.forEach((el, i) => el.style.setProperty('--daily-expand-index', String(i)));
    wrap.classList.add('is-expanding');
    window.clearTimeout(dailyExpandTimers.get(wrap));
    dailyExpandTimers.set(wrap, window.setTimeout(() => {
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
    window.clearTimeout(dailyExpandTimers.get(wrap));
    dailyExpandTimers.set(wrap, window.setTimeout(() => {
      wrap.classList.remove('is-collapsing');
      kids.forEach((el) => el.style.removeProperty('--daily-collapse-index'));
    }, 220 + kids.length * 40));
  }
  function setDailyGroupCollapsed(gid, collapsed) {
    const group = dailyGroupById(gid);
    if (!group) return;
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
        window.clearTimeout(dailyExpandTimers.get(wrap));
        playGroupCollapseStagger(wrap);
      } else {
        playGroupExpandStagger(wrap);
      }
    } else {
      rebuildDailyRows({ flip: false });
    }
    syncDailyPanelFocusability();
    post('/api/daily-group-update', { id: gid, collapsed: collapsed }).catch(() => {});
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
    dailyGroupEditId = '';
    dailyGroupConfirmDeleteId = '';
    rebuildDailyRows({ flip: true });
    post('/api/daily-group-update', { id: gid, name: name })
      .then((json) => { applyDailyPayload(json); renderDaily(); renderTaskOptions(); })
      .catch((error) => toast(error.message));
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
      .then((json) => { applyDailyPayload(json); renderDaily(); renderTaskOptions(); toast('已删除分组'); })
      .catch((error) => { renderDaily(); toast(error.message); });
    const wrap = dailyListEl.querySelector('.focus-daily-group[data-group-id="' + gid + '"]');
    if (wrap && !prefersReduced) {
      wrap.classList.add('is-removing');   // 组头滑出收拢，落库后子项 FLIP 上提
      setTimeout(send, 300);
    } else {
      send();
    }
  }
  function createDailyGroup(name, parentId) {
    name = (name || '').trim();
    if (!name) return;
    const prevIds = dailyGroups.map((g) => g.id);
    post('/api/daily-group-create', { name: name, parentId: parentId || '' })
      .then((json) => {
        applyDailyPayload(json);
        const fresh = dailyGroups.find((g) => prevIds.indexOf(g.id) < 0);
        dailyEnterId = fresh ? fresh.id : '';
        if (dailyInputEl) { dailyInputEl.value = ''; dailyInputEl.focus(); }
        setDailyCompose('task', '');   // 建完分组回到「任务」模式
        renderDaily();
        renderTaskOptions();
      })
      .catch((error) => toast(error.message));
  }
  // 新增控制条：在「任务 / 分组」两种模式 + 目标父分组之间切换，复用同一个输入框
  function setDailyCompose(mode, targetGroupId) {
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
  }
  // 勾选只切换该行的完成态（不整列重建），对勾弹入与删除线生长才有过渡；
  // 统计数字等服务端真值回来后就地补，不打断动画。全部完成的清场/庆祝照旧判定。
  function dailyCelebrationCheck(options) {
    const opts = options || {};
    const allDone = allDailyDone();
    if (!allDone) dailyPeek = false;
    const became = allDone && !dailyWasAllDone;
    dailyWasAllDone = allDone;
    if (allDone && !dailyPeek) {
      if (became && !prefersReduced) startDailyClear(opts.waitForMilestone ? 1420 : (opts.waitForGoal ? 860 : 240));
      else showDailyCelebrate(false);
    } else {
      hideDailyCelebrate();
    }
  }
  function setRowDone(row, done) {
    if (!row) return;
    row.classList.toggle('is-done', done);
    const check = row.querySelector('.focus-daily-check');
    if (check) {
      const task = dailyTasks.find((item) => item.id === row.dataset.id);
      check.setAttribute('aria-pressed', done ? 'true' : 'false');
      check.setAttribute('aria-label', (done ? '取消完成 · ' : '标记完成 · ') + (task && task.name || '每日任务'));
    }
    if (!prefersReduced) {
      replayClass(row, done ? 'is-complete-pop' : 'is-reopen-pop');
      const stat = row.querySelector('.focus-daily-stat');
      replayClass(stat, 'is-updating');
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
    const shell = root.querySelector('[data-role="daily-detail"]');
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
  // 三期：把刚因这次勾选而「整组完成」的最高祖先组自动收起。延迟到对勾/删除线动画走完；
  // 期间被改动或正在拖拽就放弃，手动展开不打扰（全清则交给庆祝流程）。
  function maybeAutoCollapseCompletedGroup(taskId) {
    if (allDailyDone()) return;
    const task = dailyTasks.find((t) => t.id === taskId);
    if (!task || !task.doneToday || !task.groupId) return;
    let target = '';
    let cur = task.groupId;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const prog = dailyGroupProgress(cur);
      if (prog.total > 0 && prog.done === prog.total) target = cur; else break;
      cur = (dailyGroupById(cur) || {}).parentId || '';
    }
    if (!target) return;
    const g = dailyGroupById(target);
    if (!g || g.collapsed) return;
    setTimeout(() => {
      const gg = dailyGroupById(target);
      if (!gg || gg.collapsed || dailyClearing || dailyDrag) return;
      const prog = dailyGroupProgress(target);
      if (!(prog.total > 0 && prog.done === prog.total)) return;
      setDailyGroupCollapsed(target, true);   // 走 CSS 平滑收合
    }, 480);
  }
  function toggleDailyTask(id) {
    const task = dailyTasks.find((item) => item.id === id);
    if (!task) return;
    const want = !task.doneToday;
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
    refreshDailyDetailGoal(task, goalMotion);
    refreshDailyGroupProgress(task.groupId);
    updateDailyFoot();
    pulseDailyFoot();
    renderDailyHistory();
    dailyCelebrationCheck({
      waitForGoal: want && targetDays > 0,
      waitForMilestone: want && crossedMilestones.length > 0,
    });
    maybeAutoCollapseCompletedGroup(id);
    post('/api/daily-toggle', { id: id, done: want })
      .then((json) => {
        applyDailyPayload(json);
        const fresh = dailyTasks.find((item) => item.id === id);
        if (fresh) {
          if (!dailyClearing) refreshDailyRowStats(fresh);
          refreshDailyDetailGoal(fresh);
          refreshDailyGroupProgress(fresh.groupId);
        }
        renderDailyHistory();
        renderTaskOptions();
      })
      .catch((error) => {
        task.doneToday = !want;
        task.doneDates = prevDates;
        task.totalDays = prevTotalDays;
        setRowDone(row, !want);
        refreshDailyRowStats(task);
        refreshDailyDetailGoal(task);
        refreshDailyGroupProgress(task.groupId);
        updateDailyFoot();
        pulseDailyFoot();
        hideDailyCelebrate();
        renderDaily();
        toast(error.message);
      });
  }
  function completeDailyTask(id) {
    return post('/api/daily-toggle', { id: id, done: true }).then((json) => {
      applyDailyPayload(json);
      dailyLoaded = true;
      if (dailyOpen && !dailyClearing) renderDaily();
      renderTaskOptions();
    });
  }
  function addDailyMinutes(id, minutes) {
    if (!id || minutes <= 0) return Promise.resolve();
    return post('/api/daily-add-minutes', { id: id, minutes: minutes })
      .then((json) => {
        applyDailyPayload(json);
        if (dailyLoaded && !dailyClearing) renderDaily();
        renderTaskOptions();
      })
      .catch(() => {});
  }
  // 旧的 commitDailyReorder（仅重排任务）已被组感知拖拽的 postDailyTree 取代，见 endDailyPointerDrag。

  function syncSettingsInputs() {
    if (setFocusEl) setFocusEl.value = durations.focus;
    if (setBreakEl) setBreakEl.value = durations.brk;
    if (setLongEl) setLongEl.value = durations.long;
    if (setRoundsEl) setRoundsEl.value = durations.rounds;
    if (setSoundEl) setSoundEl.checked = soundOn;
    if (setNoiseEl) setNoiseEl.checked = noiseOn;
    if (setNoiseVolEl) setNoiseVolEl.value = Math.round(noiseVol * 100);
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
      try { localStorage.setItem('canvas:focusHelpSeen', '1'); } catch (e) {}
      replayClass(helpPop, 'focus-pop-entering');
    } else {
      dismiss(helpPop, 'focus-pop-exiting');
    }
  }
  // 深度专注：在 .book-view 上挂 focus-zen，靠 CSS 藏掉书脊与页面 chrome，全窗只留环+座舱。
  function enterZen() {
    if (zenActive || !bookView || !running || pendingSession) return;
    toggleSettings(false);
    toggleHelp(false);
    closeSessionEditor();
    zenActive = true;
    bookView.classList.add('focus-zen');
  }
  function exitZen() {
    if (!zenActive || !bookView) return;
    zenActive = false;
    bookView.classList.remove('focus-zen');
  }
  function toggleZen() {
    if (zenActive) exitZen(); else enterZen();
  }
  function onDurationInput() {
    durations.focus = clampInt(setFocusEl && setFocusEl.value, 1, 180, durations.focus);
    durations.brk = clampInt(setBreakEl && setBreakEl.value, 1, 60, durations.brk);
    durations.long = clampInt(setLongEl && setLongEl.value, 1, 90, durations.long);
    durations.rounds = clampInt(setRoundsEl && setRoundsEl.value, 2, 12, durations.rounds);
    savePreferences();
    if (!running && mode === 'pomodoro') remaining = durations.focus * 60;
    syncDisplay();
  }
  function handleExpiredRestore() {
    if (!expiredRestore || restorePrompted) return;
    restorePrompted = true;
    const expired = expiredRestore;
    expiredRestore = null;
    if (expired.phase === 'focus') {
      const T = (window.RelatumI18n && window.RelatumI18n.t) || function (s) { return s; };
      if (window.confirm(T('上次离开时，这段专注已经走完。要进入收尾并记下这一段吗？'))) {
        ensureAudio();
        beginWrapup(expired.durationSec);
      } else {
        reset();
      }
    } else {
      phase = 'focus';
      remaining = durations.focus * 60;
      paused = true;
      syncDisplay();
      persistRuntime();
      toast('上次休息已经结束，可以开始下一段');
    }
  }

  if (primaryBtn) primaryBtn.addEventListener('click', () => {
    if (!running || paused) start(); else pause();
  });
  if (finishBtn) finishBtn.addEventListener('click', finishSegment);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!running || window.confirm(T('重置当前计时？未满一段的时间不会记入记录。'))) reset();
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
        timeEditEl.value = String(clampInt(Number(timeEditEl.value) + direction * delta, 1, 180, durations.focus));
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
    soundOn = setSoundEl.checked;
    savePreferences();
  });
  if (setNoiseEl) setNoiseEl.addEventListener('change', () => {
    noiseOn = setNoiseEl.checked;
    savePreferences();
    updateNoiseVolRow();
    updateNoise();
  });
  if (setNoiseVolEl) setNoiseVolEl.addEventListener('input', () => {
    noiseVol = Math.max(0, Math.min(1, (Number(setNoiseVolEl.value) || 0) / 100));
    savePreferences();
    if (noisePlaying) rampNoise(noiseTarget());
  });
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
    const detailShell = event.target.closest('[data-role="daily-detail"]');
    if (detailShell && event.target === detailShell) {
      closeDailyDetail();
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
        window.setTimeout(finish, 220);
      }
      setDailyMilestoneDialogError('');
      return;
    }
    if (action.dataset.action === 'daily-milestone-cancel') { closeDailyMilestoneDialog(false); return; }
    if (action.dataset.action === 'daily-milestone-confirm') { closeDailyMilestoneDialog(true); return; }
    if (action.dataset.action === 'focus-wrapup-next') finishWrapup('next').catch(() => {});
    if (action.dataset.action === 'focus-wrapup-stop') finishWrapup('stop').catch(() => {});
    if (action.dataset.action === 'focus-wrapup-done') finishWrapup('done').catch(() => {});
    if (action.dataset.action === 'focus-session-close') closeSessionEditor();
    if (action.dataset.action === 'focus-session-save') saveSessionEdit();
    if (action.dataset.action === 'focus-session-delete') deleteSessionEdit();
    if (action.dataset.action === 'focus-session-open-source' && sessionSourceEl) {
      const canvasPath = sessionSourceEl.dataset.canvasPath || '';
      const rootId = sessionSourceEl.dataset.rootId || '';
      const nodeId = sessionSourceEl.dataset.nodeId || '';
      if (canvasPath && rootId) {
        window.location.href = 'editor.html?file=' + encodeURIComponent(canvasPath)
          + (nodeId ? '&node=' + encodeURIComponent(nodeId) : '')
          + '&taskRoot=' + encodeURIComponent(rootId);
      }
    }
    if (action.dataset.action === 'focus-help-close') toggleHelp(false);
    if (action.dataset.action === 'focus-zen-enter') toggleZen();
    if (action.dataset.action === 'daily-toggle') toggleDaily();
    if (action.dataset.action === 'daily-close') toggleDaily(false);
    if (action.dataset.action === 'daily-peek') dailyPeekList();
    if (action.dataset.action === 'daily-history-close') closeDailyHistory();
    if (action.dataset.action === 'daily-history-prev') moveDailyHistoryMonth(-1);
    if (action.dataset.action === 'daily-history-next') moveDailyHistoryMonth(1);
    if (action.dataset.action === 'daily-history-today') {
      dailyHistoryMonth = todayStr().slice(0, 7);
      renderDailyHistory();
    }
    if (action.dataset.action === 'daily-detail-close') closeDailyDetail();
    if (action.dataset.action === 'daily-detail-prev') moveDailyDetailMonth(-1);
    if (action.dataset.action === 'daily-detail-next') moveDailyDetailMonth(1);
    if (action.dataset.action === 'daily-detail-today') {
      dailyDetailMonth = todayStr().slice(0, 7);
      renderDailyDetailCalendar(0);
    }
    if (action.dataset.action === 'daily-detail-toggle' && dailyDetailTaskId) {
      const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
      if (task) toggleDailyTask(task.id);
    }
    if (action.dataset.action === 'daily-detail-bind' && dailyDetailTaskId) {
      const task = dailyTasks.find((item) => item.id === dailyDetailTaskId);
      if (task && bindTask(task.id, task.name || '', 'daily')) {
        renderTaskOptions();
        syncDisplay();
        renderDailyDetail();
      }
    }
    if (action.dataset.action === 'daily-detail-edit' && dailyDetailTaskId) {
      const id = dailyDetailTaskId;
      closeDailyDetail({ restore: false, instant: true });
      openDailyEdit(id);
    }
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
        if (event.target.closest('[data-role="daily-history"]')) { openDailyHistory(id); return; }
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
        // 点名字 / 空白：不改任何状态，只给一点反馈（⋯ 轻跳，提示编辑入口在这）
        openDailyDetail(id, row);
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
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.focus-daily-milestone')) {
      root.querySelectorAll('.focus-daily-milestone.is-tip-pinned').forEach((item) => item.classList.remove('is-tip-pinned'));
    }
    if (settingsPop && !settingsPop.hidden
      && !settingsPop.contains(event.target) && !(gearBtn && gearBtn.contains(event.target))) {
      toggleSettings(false);
    }
    if (helpPop && !helpPop.hidden
      && !helpPop.contains(event.target) && !(helpBtn && helpBtn.contains(event.target))) {
      toggleHelp(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (dailyMilestoneDialog) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDailyMilestoneDialog(false);
        return;
      }
      if (event.key === 'Tab') {
        const focusables = Array.from(dailyMilestoneDialog.querySelectorAll(dailyFocusableSelector))
          .filter((item) => !item.disabled && item.getAttribute('aria-hidden') !== 'true');
        if (focusables.length) {
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
      return;
    }
    if (event.key === 'Escape') {
      const pinned = root.querySelector('.focus-daily-milestone.is-tip-pinned');
      if (pinned) {
        event.preventDefault();
        pinned.classList.remove('is-tip-pinned');
        return;
      }
    }
    if (!focusPageActive()) return;
    const target = event.target;
    const typing = isTypingTarget(target);
    const dailyDetailShell = getDailyDetailShell();
    const dailyDetailOpen = !!dailyDetailTaskId || !!dailyDetailShell;
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && !zenActive) {
      const blocked = (helpPop && !helpPop.hidden) || (settingsPop && !settingsPop.hidden)
        || (sessionEditor && !sessionEditor.hidden) || (wrapupEl && !wrapupEl.hidden) || dailyDetailOpen;
      if (dailyDetailOpen) {
        event.preventDefault();
        event.stopPropagation();
        if (!dailyDetailShell || !dailyDetailShell.classList.contains('is-closing')) closeDailyDetail();
        return;
      }
      if (!blocked && dailyOpen) {
        event.preventDefault();
        event.stopPropagation();
        toggleDaily(false);
        return;
      }
      if (typing) return;
      if (!blocked) {
        event.preventDefault();
        event.stopPropagation();
        toggleDaily();
        return;
      }
    }
    if (typing) return;
    if (event.key === '?') {
      event.preventDefault();
      if (!zenActive) toggleHelp();
      return;
    }
    if (event.key === 'Escape') {
      if (zenActive) { event.preventDefault(); exitZen(); return; }
      if (helpPop && !helpPop.hidden) { event.preventDefault(); toggleHelp(false); return; }
      if (settingsPop && !settingsPop.hidden) { event.preventDefault(); toggleSettings(false); return; }
      if (sessionEditor && !sessionEditor.hidden) { event.preventDefault(); closeSessionEditor(); return; }
      if (dailyDetailOpen) {
        event.preventDefault();
        if (!dailyDetailShell || !dailyDetailShell.classList.contains('is-closing')) closeDailyDetail();
        return;
      }
      if (dailyHistoryTaskId) { event.preventDefault(); closeDailyHistory(); return; }
      if (dailyGroupConfirmDeleteId) { event.preventDefault(); cancelDeleteDailyGroup(); return; }
      if (dailyGroupEditId) { event.preventDefault(); closeDailyGroupEdit(); return; }
      if (dailyConfirmDeleteId) { event.preventDefault(); cancelDeleteDaily(); return; }
      if (dailyEditId) { event.preventDefault(); closeDailyEdit(); return; }
      if (dailyOpen) { event.preventDefault(); toggleDaily(false); return; }
    }
    const overlayOpen = (helpPop && !helpPop.hidden) || (settingsPop && !settingsPop.hidden)
      || (sessionEditor && !sessionEditor.hidden) || dailyDetailOpen;
    if (event.code === 'Space' && !overlayOpen && !pendingSession && !(wrapupEl && !wrapupEl.hidden)) {
      event.preventDefault();
      if (!running || paused) start(); else pause();
    }
    if ((event.key === 'z' || event.key === 'Z') && !overlayOpen && running && !pendingSession) {
      event.preventDefault();
      toggleZen();
    }
  }, true);
  window.addEventListener('pagehide', () => {
    persistRuntime();
    stopInterval();
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    restoreRuntime();
    syncModeUI();
    syncDisplay();
    handleExpiredRestore();
    updateNoise();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onTick();
  });

  try { boundTaskId = localStorage.getItem(TASK_KEY) || ''; } catch (e) {}
  try { boundKind = boundTaskId ? (localStorage.getItem(KIND_KEY) || 'study') : ''; } catch (e) {}
  restoreRuntime();
  syncModeUI();
  syncDisplay();
  syncDailyPanelFocusability();

  window.CanvasFocus = {
    activate() {
      footprintDay = todayStr();
      footprintSessionId = '';
      loadTasks();   // 任务下拉框每次重读，和学习页实时同步（任务联动敏感，不缓存）
      loadDaily();   // 每日任务每次重读：跨天重置要靠它，开销也小
      if (!loadedSessions) loadSessions(); else renderFootprint();
      syncDisplay();
      handleExpiredRestore();
      requestAnimationFrame(replayFocusEntrance);
      if (helpBtn) {
        try {
          if (localStorage.getItem('canvas:focusHelpSeen') !== '1') {
            helpBtn.classList.add('is-inviting');
            setTimeout(() => helpBtn.classList.remove('is-inviting'), 2600);
          }
        } catch (e) {}
      }
    },
    prepareTask(id, title) {
      if (!bindTask(id, title)) return false;
      loadTasks().then(() => {
        if (taskSelect) taskSelect.value = boundTaskId;
      });
      if (goalEl) goalEl.focus();
      return true;
    },
    showDay(day, sessionId) {
      footprintDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : todayStr();
      footprintSessionId = String(sessionId || '');
      return loadSessions().then(() => {
        renderFootprint();
        const footprint = root.querySelector('.focus-footprint');
        if (footprint) footprint.scrollIntoView({ block: 'center', behavior: prefersReduced ? 'auto' : 'smooth' });
        if (footprintSessionId) openSessionEditor(footprintSessionId);
      });
    },
  };
})();

(function () {
  'use strict';

  const root = document.querySelector('[data-role="calendar-shell"]');
  if (!root) return;
  const COUNTDOWN_ENABLED_KEY = 'canvas:calendarCountdownEnabled';
  const MONTH_CACHE_MAX = 24;
  const DAY_CACHE_MAX = 96;
  const DRAFT_CACHE_MAX = 96;
  let initialCountdownEnabled = true;
  try { initialCountdownEnabled = localStorage.getItem(COUNTDOWN_ENABLED_KEY) !== '0'; } catch (e) {}

  const state = {
    active: false,
    loaded: false,
    stale: false,
    loading: false,
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: localDay(new Date()),
    payload: null,
    reloadTimer: 0,
    requestSeq: 0,
    requestController: null,
    monthCache: new Map(),
    dayCache: new Map(),
    drafts: new Map(),
    diaries: [],
    prefetching: new Set(),
    prefetchControllers: new Map(),
    neighborPrefetchHandle: 0,
    neighborPrefetchUsesIdle: false,
    keyboardFocusDay: '',
    lastDayMotionAt: 0,
    lastNavAt: 0,
    preview: false,
    diaryExpanded: false,
    countdown: null,
    countdownEnabled: initialCountdownEnabled,
    countdownRevealPending: false,
    countdownRevealPlayed: false,
    countdownSaveSeq: 0,
    countdownClockTimer: 0,
    countdownClockCloseTimer: 0,
    countdownClockUnits: {},
    resumeAfterPageShow: false,
    expandedDays: new Set(),  // 当天任务超过 10 条时，记录哪些天被展开过；换天自动收起
  };
  const prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (error) { return false; }
  })();

  function localDay(value) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uiText(value) {
    return window.RelatumI18n ? window.RelatumI18n.t(value) : value;
  }

  function formatDay(day) {
    const value = new Date(day + 'T00:00:00');
    return (value.getMonth() + 1) + '月' + value.getDate() + '日 · '
      + ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][value.getDay()];
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    return hours ? hours + '小时' + (minutes ? ' ' + minutes + '分' : '') : minutes + '分';
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || '读取失败');
    return json;
  }

  function showToast(message) {
    const toast = document.querySelector('[data-role="study-toast"]')
      || document.querySelector('[data-role="toast"]');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function monthKey(year, month) {
    return String(year) + '-' + String(month).padStart(2, '0');
  }

  function trimMap(map, max, preserveKey) {
    if (map.size <= max) return;
    for (const key of map.keys()) {
      if (map.size <= max) break;
      if (key === preserveKey) continue;
      map.delete(key);
    }
  }

  function trimCalendarCaches() {
    trimMap(state.monthCache, MONTH_CACHE_MAX, monthKey(state.year, state.month));
    trimMap(state.dayCache, DAY_CACHE_MAX, state.day);
    if (state.drafts.size <= DRAFT_CACHE_MAX) return;
    for (const [day, draft] of state.drafts) {
      if (state.drafts.size <= DRAFT_CACHE_MAX) break;
      if (day === state.day || draft.timer || draft.deleting
          || draft.version > draft.savedVersion) continue;
      state.drafts.delete(day);
    }
  }

  function blankDay(day) {
    return {
      date: day,
      diary: null,
      tasks: [],
      overdue: [],
      focus: { count: 0, durationSec: 0, sessions: [] },
      archives: [],
      loading: true,
    };
  }

  function diaryDraft(day, source) {
    let draft = state.drafts.get(day);
    if (!draft) {
      const diary = source || null;
      draft = {
        day,
        title: diary ? diary.title || '' : '',
        tags: diary && Array.isArray(diary.tags) ? diary.tags.join(', ') : '',
        body: diary ? diary.body || '' : '',
        updatedAt: diary ? diary.updatedAt || '' : '',
        exists: !!diary,
        touched: false,
        version: 0,
        savedVersion: 0,
        status: diary ? 'saved' : 'idle',
        error: '',
        deleted: false,
        timer: 0,
        chain: Promise.resolve(),
      };
      state.drafts.set(day, draft);
    } else if (source && !draft.touched && draft.version === draft.savedVersion) {
      draft.title = source.title || '';
      draft.tags = Array.isArray(source.tags) ? source.tags.join(', ') : '';
      draft.body = source.body || '';
      draft.updatedAt = source.updatedAt || '';
      draft.exists = true;
      draft.status = 'saved';
      draft.error = '';
    }
    return draft;
  }

  function currentDraft() {
    const source = state.payload && state.payload.day ? state.payload.day.diary : null;
    return diaryDraft(state.day, source);
  }

  function captureCurrentDraft() {
    if (!state.loaded) return;
    const title = root.querySelector('[data-diary-title]');
    const tags = root.querySelector('[data-diary-tags]');
    const body = root.querySelector('[data-diary-body]');
    if (!title || !tags || !body) return;
    const draft = currentDraft();
    draft.title = title.value;
    draft.tags = tags.value;
    draft.body = body.value;
  }

  function absorbPayload(payload, includeDiaryIndex) {
    if (includeDiaryIndex !== false && Array.isArray(payload.diaries)) {
      state.diaries = payload.diaries.slice();
      state.drafts.forEach((draft) => {
        const index = state.diaries.findIndex((item) => item.date === draft.day);
        if (draft.deleting || draft.deleted) {
          if (index >= 0) state.diaries.splice(index, 1);
          return;
        }
        if (!draft.exists && !draft.touched) return;
        const local = {
          date: draft.day,
          title: draft.title,
          tags: draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          updatedAt: draft.updatedAt,
          excerpt: draft.body.replace(/\s+/g, ' ').slice(0, 100),
        };
        if (index >= 0) Object.assign(state.diaries[index], local);
        else state.diaries.push(local);
      });
    }
    state.monthCache.set(monthKey(payload.year, payload.month), {
      year: payload.year,
      month: payload.month,
      today: payload.today,
      days: payload.days || {},
    });
    state.dayCache.set(payload.day.date, payload.day);
    diaryDraft(payload.day.date, payload.day.diary);
    if (includeDiaryIndex !== false && payload.countdown) {
      state.countdown = Object.assign({}, payload.countdown);
    }
    trimCalendarCaches();
  }

  function prefetchMonth(year, month) {
    if (!state.active) return;
    const value = new Date(year, month - 1, 1);
    const key = monthKey(value.getFullYear(), value.getMonth() + 1);
    if (state.monthCache.has(key) || state.prefetching.has(key)) return;
    state.prefetching.add(key);
    const controller = new AbortController();
    state.prefetchControllers.set(key, controller);
    const day = localDay(value);
    const query = new URLSearchParams({
      year: String(value.getFullYear()),
      month: String(value.getMonth() + 1),
      day,
    });
    request('/api/calendar?' + query.toString(), { signal: controller.signal }).then((payload) => {
      absorbPayload(payload, false);
    }).catch(() => {}).finally(() => {
      if (state.prefetchControllers.get(key) === controller) {
        state.prefetchControllers.delete(key);
        state.prefetching.delete(key);
      }
    });
  }

  function scheduleNeighborPrefetch(year, month) {
    cancelNeighborPrefetch();
    const run = () => {
      state.neighborPrefetchHandle = 0;
      if (!state.active) return;
      prefetchMonth(year, month - 1);
      prefetchMonth(year, month + 1);
    };
    state.neighborPrefetchUsesIdle = 'requestIdleCallback' in window;
    state.neighborPrefetchHandle = state.neighborPrefetchUsesIdle
      ? window.requestIdleCallback(run, { timeout: 1200 })
      : window.setTimeout(run, 240);
  }

  function cancelNeighborPrefetch() {
    if (!state.neighborPrefetchHandle) return;
    if (state.neighborPrefetchUsesIdle && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(state.neighborPrefetchHandle);
    } else {
      window.clearTimeout(state.neighborPrefetchHandle);
    }
    state.neighborPrefetchHandle = 0;
  }

  function cancelCalendarNetworkWork() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = 0;
    cancelNeighborPrefetch();
    if (state.loading) state.stale = true;
    if (state.requestController) {
      state.requestSeq += 1;
      state.requestController.abort();
      state.requestController = null;
    }
    state.loading = false;
    root.classList.remove('is-loading');
    state.prefetchControllers.forEach((controller) => controller.abort());
    state.prefetchControllers.clear();
    state.prefetching.clear();
  }

  function cachedPayload(day, year, month) {
    const cachedMonth = state.monthCache.get(monthKey(year, month));
    const sourceDay = state.dayCache.get(day);
    const cachedDay = sourceDay ? Object.assign({}, sourceDay) : blankDay(day);
    const draft = state.drafts.get(day);
    if (draft) {
      cachedDay.diary = draft.exists || draft.touched ? {
        date: day,
        title: draft.title,
        tags: draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        body: draft.body,
        updatedAt: draft.updatedAt,
      } : null;
    }
    return {
      year,
      month,
      today: cachedMonth ? cachedMonth.today : (state.payload ? state.payload.today : localDay(new Date())),
      days: cachedMonth ? cachedMonth.days : {},
      countdown: state.countdown,
      diaries: state.diaries,
      day: cachedDay,
    };
  }

  function transitionDirection(nextDay) {
    return String(nextDay || '').localeCompare(state.day) >= 0 ? 1 : -1;
  }

  async function load(day, motion) {
    captureCurrentDraft();
    const previousDay = state.day;
    const previousDraft = state.drafts.get(previousDay);
    if (previousDraft && previousDraft.version > previousDraft.savedVersion) queueDiarySave(previousDay, true);
    const wasLoaded = state.loaded;
    const requestId = ++state.requestSeq;
    if (state.requestController) state.requestController.abort();
    const controller = new AbortController();
    state.requestController = controller;
    state.loading = true;
    root.classList.add('is-loading');
    const requestedDate = new Date((day || state.day) + 'T00:00:00');
    const requestedDay = day || state.day;
    const requestedYear = requestedDate.getFullYear();
    const requestedMonth = requestedDate.getMonth() + 1;
    const previousYear = state.year;
    const previousMonth = state.month;
    if (requestedDay !== previousDay) state.expandedDays.clear();
    const sameDayRefresh = wasLoaded && requestedDay === previousDay
      && motion && motion.kind === 'refresh';
    try {
      const query = new URLSearchParams({
        year: String(requestedYear),
        month: String(requestedMonth),
        day: requestedDay,
      });
      const payloadPromise = request('/api/calendar?' + query.toString(), { signal: controller.signal });
      if (!wasLoaded) {
        state.year = requestedYear;
        state.month = requestedMonth;
        state.day = requestedDay;
        state.payload = cachedPayload(requestedDay, requestedYear, requestedMonth);
        state.loaded = true;
        render({ kind: 'initial', direction: 0 });
      }
      // 切天 / 翻月：退场动画在点击瞬间就起跑、与后端请求并行（退场不需要新数据），把等待藏在退场后面。
      // navFinish=未缓存时留到数据到达再写入；navCached=已缓存则乐观阶段直接揭示、完全不等后端，
      // 数据到达后跳过日栏重绘以免打断动画。
      let navFinish = null;
      let navCached = false;
      if (wasLoaded && !sameDayRefresh) {
        state.year = requestedYear;
        state.month = requestedMonth;
        state.day = requestedDay;
        state.payload = cachedPayload(requestedDay, requestedYear, requestedMonth);
        state.loaded = true;
        if (previousYear === requestedYear && previousMonth === requestedMonth) {
          syncCalendarSelection(true);
        } else {
          renderCalendarPanel(motion);
        }
        const finish = beginColumnExit(requestId);
        if (!state.payload.day.loading) {
          // 重访秒开：这一天已缓存（数据一变更就清缓存，所以缓存即新鲜），立刻揭示、不等后端
          finish();
          navCached = true;
        } else {
          navFinish = finish;  // 未缓存：退场已起，写入留到数据到达
        }
      }
      const payload = await payloadPromise;
      if (requestId !== state.requestSeq) return;
      absorbPayload(payload);
      scheduleNeighborPrefetch(payload.year, payload.month);
      state.year = payload.year;
      state.month = payload.month;
      state.day = payload.day.date;
      state.payload = cachedPayload(payload.day.date, payload.year, payload.month);
      state.loaded = true;
      state.stale = false;
      reconcileCalendarPanel();
      if (!wasLoaded) revealColumnFirstOpen(requestId);
      else if (sameDayRefresh) renderDayPanel();
      else if (navFinish) navFinish();        // 未缓存：退场跑完后写入新一天
      else if (!navCached) renderDayPanel();   // 兜底；navCached 已在乐观阶段揭示，跳过
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (!wasLoaded) {
        state.loaded = false;
        root.innerHTML = '<div class="calendar-error"><strong>日历没有加载成功</strong><span>'
          + escapeHtml(error.message) + '</span></div>';
      } else {
        showToast('日历同步失败 · ' + error.message);
        root.classList.add('calendar-sync-failed');
        window.setTimeout(() => root.classList.remove('calendar-sync-failed'), 900);
      }
    } finally {
      if (requestId === state.requestSeq) {
        state.loading = false;
        state.requestController = null;
        root.classList.remove('is-loading');
      }
    }
  }

  function monthCells() {
    const first = new Date(state.year, state.month - 1, 1);
    const start = new Date(state.year, state.month - 1, 1 - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const value = new Date(start);
      value.setDate(start.getDate() + index);
      cells.push({
        date: localDay(value),
        number: value.getDate(),
        current: value.getMonth() === state.month - 1,
      });
    }
    return cells;
  }

  function renderCalendarDots(marks) {
    return [
      marks.diary ? '<i class="diary"></i>' : '',
      (marks.due || marks.focusTask) ? '<i class="task"></i>' : '',
      marks.focusSessions ? '<i class="focus"></i>' : '',
      (marks.completed || marks.archives) ? '<i class="done"></i>' : '',
    ].join('');
  }

  function renderCalendar() {
    const weekdays = [
      ['weekdayMon', '一'], ['weekdayTue', '二'], ['weekdayWed', '三'],
      ['weekdayThu', '四'], ['weekdayFri', '五'], ['weekdaySat', '六'],
      ['weekdaySun', '日']
    ].map(([key, label]) => '<span data-i18n="' + key + '" data-i18n-zh="'
      + label + '">' + label + '</span>').join('');
    const cells = monthCells().map((cell, index) => {
      const marks = (state.payload.days || {})[cell.date] || {};
      const dots = renderCalendarDots(marks);
      const classes = [
        'calendar-day',
        cell.current ? '' : 'outside',
        cell.date === state.day ? 'selected' : '',
        cell.date === state.payload.today ? 'today' : '',
      ].filter(Boolean).join(' ');
      return '<button type="button" class="' + classes + '" tabindex="'
        + (cell.date === state.day ? '0' : '-1') + '" style="--calendar-cell-delay:'
        + (Math.min(index, 24) * 4) + 'ms" data-calendar-day="' + cell.date + '"'
        + (cell.date === state.day ? ' aria-current="date"' : '') + '>'
        + '<span>' + cell.number + '</span><b>' + dots + '</b></button>';
    }).join('');
    return '<section class="calendar-month-card">'
      + '<header class="calendar-month-head">'
      + '<button type="button" data-calendar-month="-1" aria-label="上个月">‹</button>'
      + '<h1><span>' + state.year + ' 年 ' + state.month + ' 月</span></h1>'
      + '<button type="button" data-calendar-month="1" aria-label="下个月">›</button>'
      + '<button type="button" class="calendar-today" data-calendar-today>今天</button>'
      + '</header><div class="calendar-weekdays">' + weekdays + '</div>'
      + '<div class="calendar-grid">' + cells + '</div>'
      + '<footer class="calendar-legend"><span><i class="diary"></i>日记</span>'
      + '<span><i class="focus"></i>专注</span><span><i class="done"></i>完成</span></footer></section>';
  }

  function countdownDistance() {
    if (!state.countdown || !state.countdown.date) return null;
    const today = state.payload && state.payload.today
      ? state.payload.today : localDay(new Date());
    const from = new Date(today + 'T00:00:00');
    const target = new Date(state.countdown.date + 'T00:00:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(target.getTime())) return null;
    return Math.round((target.getTime() - from.getTime()) / 86400000);
  }

  function renderCountdown() {
    const countdown = state.countdown;
    const hasCountdown = !!(countdown && countdown.event && countdown.date);
    const hidden = !state.countdownEnabled;
    const distance = countdownDistance();
    let line = '';
    if (!hasCountdown) {
      line = '<button type="button" class="calendar-countdown-empty-action" data-countdown-clock>'
        + '创建第一个倒数日</button>';
    } else if (distance != null && distance < 0) {
      line = '距离<span data-countdown-event role="button" tabindex="0" title="双击编辑目标事件">'
        + escapeHtml(countdown.event) + '</span><em>已经过去</em>'
        + '<span data-countdown-date role="button" tabindex="0" title="双击编辑目标日期"><strong>'
        + Math.abs(distance) + '</strong>天</span>';
    } else if (distance === 0) {
      line = '<span data-countdown-event role="button" tabindex="0" title="双击编辑目标事件">'
        + escapeHtml(countdown.event) + '</span><em data-countdown-date role="button" tabindex="0"'
        + ' title="双击编辑目标日期">就是今天</em>';
    } else {
      line = '距离<span data-countdown-event role="button" tabindex="0" title="双击编辑目标事件">'
        + escapeHtml(countdown.event) + '</span><em>还有</em>'
        + '<span data-countdown-date role="button" tabindex="0" title="双击编辑目标日期"><strong>'
        + distance + '</strong>天</span>';
    }
    return '<section class="calendar-countdown" data-calendar-countdown'
      + (hidden ? ' hidden' : '') + '><button class="calendar-countdown-clock-button" type="button"'
      + ' data-countdown-clock aria-label="打开翻页时钟">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h12v14H6z"/>'
      + '<path d="M6 12h12M9 8h6M9 16h6"/></svg></button><p>COUNTDOWN</p><div>'
      + line + '</div></section>';
  }

  function countdownClockParts() {
    if (!state.countdown || !state.countdown.date) return null;
    const target = new Date(state.countdown.date + 'T00:00:00').getTime();
    if (!Number.isFinite(target)) return null;
    let delta = target - Date.now();
    const future = delta >= 0;
    delta = Math.abs(delta);
    const seconds = Math.floor(delta / 1000);
    return {
      future,
      days: Math.floor(seconds / 86400),
      hours: Math.floor((seconds % 86400) / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: seconds % 60,
    };
  }

  function renderCountdownClockUnit(key, label) {
    return '<div class="calendar-flip-unit"><div class="calendar-flip" data-flip-key="' + key + '">'
      + '<div class="calendar-flip-half calendar-flip-top"><span></span></div>'
      + '<div class="calendar-flip-half calendar-flip-bottom"><span></span></div>'
      + '<div class="calendar-flip-half calendar-flip-flap calendar-flip-flap-top"><span></span></div>'
      + '<div class="calendar-flip-half calendar-flip-flap calendar-flip-flap-bottom"><span></span></div>'
      + '</div><div class="calendar-flip-label">' + label + '</div></div>';
  }

  function cloneCountdown(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function ensureCountdownEvents() {
    if (!state.countdown) return [];
    if (!Array.isArray(state.countdown.events) || !state.countdown.events.length) {
      state.countdown.events = [{
        id: state.countdown.id || 'legacy',
        event: state.countdown.event || '目标事件',
        date: state.countdown.date || localDay(new Date()),
      }];
    }
    let selected = state.countdown.events.find((item) => item.id === state.countdown.selectedId);
    if (!selected) selected = state.countdown.events[0];
    state.countdown.version = 2;
    state.countdown.selectedId = selected.id;
    state.countdown.event = selected.event;
    state.countdown.date = selected.date;
    return state.countdown.events;
  }

  function selectedCountdownEvent() {
    const events = ensureCountdownEvents();
    return events.find((item) => item.id === state.countdown.selectedId) || events[0] || null;
  }

  function countdownEventId() {
    return 'event-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function renderCountdownClockEvents() {
    const events = ensureCountdownEvents();
    return events.map((item) => '<div class="calendar-flip-event-row'
      + (item.id === state.countdown.selectedId ? ' is-active' : '') + '" data-flip-event-row="'
      + escapeHtml(item.id) + '"><button type="button" class="calendar-flip-event-select"'
      + ' data-flip-event-select="' + escapeHtml(item.id) + '"><span data-user-content>'
      + escapeHtml(item.event) + '</span><small>' + escapeHtml(item.date.replace(/-/g, ' · '))
      + '</small></button><button type="button" class="calendar-flip-event-action"'
      + ' data-flip-event-edit="' + escapeHtml(item.id) + '" aria-label="编辑倒数事件" title="编辑倒数事件">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19l3.5-.8L18 8.7 15.3 6 5.8 15.5zM14 7.3l2.7 2.7"/></svg></button>'
      + '<button type="button" class="calendar-flip-event-action is-delete" data-flip-event-delete="'
      + escapeHtml(item.id) + '" aria-label="删除倒数事件" title="删除倒数事件">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M9 8V6h6v2m-7 0l.7 10h6.6L16 8"/></svg></button></div>')
      .join('');
  }

  function syncCountdownSelection(id) {
    const selected = ensureCountdownEvents().find((item) => item.id === id);
    if (!selected) return false;
    state.countdown.selectedId = selected.id;
    state.countdown.event = selected.event;
    state.countdown.date = selected.date;
    if (state.payload) state.payload.countdown = state.countdown;
    return true;
  }

  function closeCountdownEventEditor(editor, immediate) {
    if (!editor) return;
    editor.classList.remove('is-visible');
    if (immediate || prefersReduced) editor.remove();
    else window.setTimeout(() => { if (editor.isConnected) editor.remove(); }, 220);
  }

  function refreshCountdownClock() {
    const overlay = document.querySelector('[data-calendar-flip-clock]');
    const selected = selectedCountdownEvent();
    if (!overlay || !selected) return;
    const title = overlay.querySelector('.calendar-flip-clock-stage h1');
    const dateLabel = overlay.querySelector('[data-flip-current-date]');
    const list = overlay.querySelector('[data-flip-event-list]');
    if (title) title.textContent = selected.event;
    if (dateLabel) dateLabel.textContent = selected.date.replace(/-/g, ' · ');
    if (list) {
      list.innerHTML = renderCountdownClockEvents();
      bindCountdownEventList(list);
    }
    tickCountdownClock();
  }

  function updateCountdownEverywhere(previous, updated) {
    if (state.payload) state.payload.countdown = state.countdown;
    syncCountdownCard({ updated: updated !== false });
    refreshCountdownClock();
    saveCountdown(previous);
  }

  function openCountdownEventEditor(id) {
    const overlay = document.querySelector('[data-calendar-flip-clock]');
    const card = overlay && overlay.querySelector('.calendar-flip-clock-card');
    if (!card) return;
    const existingEditor = card.querySelector('[data-flip-event-editor]');
    if (existingEditor) existingEditor.remove();
    const item = id ? ensureCountdownEvents().find((entry) => entry.id === id) : null;
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const editor = document.createElement('div');
    editor.className = 'calendar-flip-event-editor-mask';
    editor.setAttribute('data-flip-event-editor', '');
    editor.innerHTML = '<section class="calendar-flip-event-editor" role="dialog" aria-label="'
      + (item ? '编辑倒数事件' : '新建倒数日') + '"><header><div><span>COUNTDOWN</span><h2>'
      + (item ? '编辑倒数事件' : '新建倒数日') + '</h2></div><button type="button" data-flip-editor-cancel'
      + ' aria-label="取消">×</button></header><label><span>事件名称</span><input type="text"'
      + ' data-flip-editor-name maxlength="80" value="' + escapeHtml(item ? item.event : '')
      + '" placeholder="准备迎接什么？"></label><label><span>目标日期</span><input type="date"'
      + ' data-flip-editor-date value="' + escapeHtml(item ? item.date : localDay(future))
      + '"></label><footer><button type="button" data-flip-editor-cancel>取消</button>'
      + '<button type="button" class="is-primary" data-flip-editor-save>保存</button></footer></section>';
    card.appendChild(editor);
    const nameInput = editor.querySelector('[data-flip-editor-name]');
    const dateInput = editor.querySelector('[data-flip-editor-date]');
    const cancel = () => closeCountdownEventEditor(editor);
    editor.querySelectorAll('[data-flip-editor-cancel]').forEach((button) =>
      button.addEventListener('click', cancel));
    editor.addEventListener('pointerdown', (pointerEvent) => {
      if (pointerEvent.target === editor) cancel();
    });
    const save = () => {
      const eventName = nameInput.value.trim();
      const targetDate = dateInput.value;
      if (!eventName) { nameInput.focus(); return; }
      if (!targetDate) { dateInput.focus(); return; }
      const previous = cloneCountdown(state.countdown);
      let target = item && ensureCountdownEvents().find((entry) => entry.id === item.id);
      if (!target) {
        if (ensureCountdownEvents().length >= 100) {
          showToast(uiText('倒数事件最多保存 100 条'));
          return;
        }
        target = { id: countdownEventId(), event: eventName.slice(0, 80), date: targetDate };
        ensureCountdownEvents().push(target);
      } else {
        target.event = eventName.slice(0, 80);
        target.date = targetDate;
      }
      syncCountdownSelection(target.id);
      closeCountdownEventEditor(editor, true);
      updateCountdownEverywhere(previous, true);
    };
    editor.querySelector('[data-flip-editor-save]').addEventListener('click', save);
    editor.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Escape') { keyEvent.stopPropagation(); cancel(); }
      else if (keyEvent.key === 'Enter' && !keyEvent.isComposing) {
        keyEvent.preventDefault(); save();
      }
    });
    requestAnimationFrame(() => {
      editor.classList.add('is-visible');
      nameInput.focus();
      nameInput.select();
    });
  }

  function bindCountdownEventList(scope) {
    scope.querySelectorAll('[data-flip-event-select]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.flipEventSelect === state.countdown.selectedId) return;
        const previous = cloneCountdown(state.countdown);
        if (syncCountdownSelection(button.dataset.flipEventSelect)) {
          updateCountdownEverywhere(previous, true);
        }
      });
    });
    scope.querySelectorAll('[data-flip-event-edit]').forEach((button) => {
      button.addEventListener('click', () => openCountdownEventEditor(button.dataset.flipEventEdit));
    });
    scope.querySelectorAll('[data-flip-event-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const events = ensureCountdownEvents();
        if (events.length <= 1) { showToast(uiText('至少保留一个倒数日')); return; }
        const target = events.find((item) => item.id === button.dataset.flipEventDelete);
        if (!target) return;
        const confirmText = window.RelatumI18n && window.RelatumI18n.language === 'en'
          ? 'Delete countdown “' + target.event + '”?' : '删除倒数日“' + target.event + '”？';
        if (!window.confirm(confirmText)) return;
        const previous = cloneCountdown(state.countdown);
        state.countdown.events = events.filter((item) => item.id !== target.id);
        if (state.countdown.selectedId === target.id) {
          syncCountdownSelection(state.countdown.events[0].id);
        }
        updateCountdownEverywhere(previous, true);
      });
    });
  }

  function setCountdownFlip(flip, value) {
    if (!flip) return;
    const top = flip.querySelector('.calendar-flip-top span');
    const bottom = flip.querySelector('.calendar-flip-bottom span');
    const flapTop = flip.querySelector('.calendar-flip-flap-top span');
    const flapBottom = flip.querySelector('.calendar-flip-flap-bottom span');
    const current = top.textContent;
    if (current === value) return;
    flip.dataset.length = String(value.length);
    if (!current || prefersReduced) {
      top.textContent = value;
      bottom.textContent = value;
      flapTop.textContent = value;
      flapBottom.textContent = value;
      flip.classList.remove('is-flipping');
      return;
    }
    flip._generation = (flip._generation || 0) + 1;
    const generation = flip._generation;
    flapTop.textContent = current;
    flapBottom.textContent = value;
    top.textContent = value;
    bottom.textContent = current;
    flip.classList.remove('is-flipping');
    void flip.offsetWidth;
    flip.classList.add('is-flipping');
    window.setTimeout(() => {
      if (flip._generation !== generation || !flip.isConnected) return;
      flip.classList.remove('is-flipping');
      bottom.textContent = value;
    }, 600);
  }

  function tickCountdownClock() {
    const overlay = document.querySelector('[data-calendar-flip-clock]');
    const parts = countdownClockParts();
    if (!overlay || !parts) return;
    const subtitle = overlay.querySelector('[data-flip-subtitle]');
    if (subtitle) subtitle.textContent = parts.future ? '还有' : '已经过去';
    setCountdownFlip(state.countdownClockUnits.days, String(parts.days));
    setCountdownFlip(state.countdownClockUnits.hours, String(parts.hours).padStart(2, '0'));
    setCountdownFlip(state.countdownClockUnits.minutes, String(parts.minutes).padStart(2, '0'));
    setCountdownFlip(state.countdownClockUnits.seconds, String(parts.seconds).padStart(2, '0'));
  }

  function closeCountdownClock() {
    window.clearInterval(state.countdownClockTimer);
    window.clearTimeout(state.countdownClockCloseTimer);
    state.countdownClockTimer = 0;
    state.countdownClockCloseTimer = 0;
    state.countdownClockUnits = {};
    const overlay = document.querySelector('[data-calendar-flip-clock]');
    document.body.classList.remove('calendar-flip-clock-open');
    if (overlay && overlay.isConnected) overlay.remove();
  }

  function openCountdownClock(event) {
    if (event) event.preventDefault();
    const params = new URLSearchParams(window.location.search);
    const destination = 'countdown.html' + (params.get('desktop') === '1' ? '?desktop=1' : '');
    document.body.classList.add('canvas-route-leaving');
    window.setTimeout(() => { window.location.href = destination; }, prefersReduced ? 0 : 180);
  }

  async function saveCountdown(previous) {
    const seq = ++state.countdownSaveSeq;
    const payload = cloneCountdown(state.countdown);
    try {
      const json = await request('/api/countdown-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (seq !== state.countdownSaveSeq) return;
      if (json.countdown) {
        state.countdown = json.countdown;
        if (state.payload) state.payload.countdown = state.countdown;
      }
      showToast(uiText('已保存'));
    } catch (error) {
      if (seq !== state.countdownSaveSeq) return;
      state.countdown = previous;
      if (state.payload) state.payload.countdown = state.countdown;
      syncCountdownCard();
      showToast(uiText('保存失败') + ' · ' + error.message);
    }
  }

  function beginCountdownInlineEdit(field, target) {
    const card = target && target.closest('[data-calendar-countdown]');
    if (!card || card.classList.contains('is-editing') || !state.countdown) return;
    const selected = Array.isArray(state.countdown.events)
      ? state.countdown.events.find((item) => item.id === state.countdown.selectedId) : null;
    const original = String(field === 'event'
      ? (selected ? selected.event : state.countdown.event || '')
      : (selected ? selected.date : state.countdown.date || ''));
    if (!original) return;
    const input = document.createElement('input');
    input.type = field === 'event' ? 'text' : 'date';
    input.className = 'calendar-countdown-input calendar-countdown-input-'
      + (field === 'event' ? 'event' : 'date');
    input.value = original;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', uiText(field === 'event' ? '事件名称' : '目标日期'));
    if (field === 'event') input.maxLength = 80;
    else input.step = '1';
    card.classList.add('is-editing');
    const line = target.parentElement;
    line.classList.add('is-inline-editor');
    line.replaceChildren(input);
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      const valid = field === 'event'
        ? !!value
        : /^\d{4}-\d{2}-\d{2}$/.test(value)
          && !Number.isNaN(new Date(value + 'T00:00:00').getTime());
      if (!commit || !valid || value === original) {
        syncCountdownCard();
        return;
      }
      const previous = cloneCountdown(state.countdown);
      const nextValue = field === 'event' ? value.slice(0, 80) : value;
      if (selected) selected[field] = nextValue;
      state.countdown[field] = nextValue;
      if (state.payload) state.payload.countdown = state.countdown;
      syncCountdownCard({ updated: true });
      saveCountdown(previous);
    };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true), { once: true });
    input.focus({ preventScroll: true });
    input.select();
  }

  function renderSearch() {
    return '<div class="calendar-search-wrap">'
      + '<input type="search" data-calendar-search placeholder="搜索日记标题、标签或正文摘要">'
      + '<div class="calendar-search-results" data-calendar-search-results hidden></div></div>';
  }

  function draftStatus(draft) {
    if (draft.status === 'saving') return { key: 'saving', text: '正在保存' };
    if (draft.status === 'error') return { key: 'error', text: '保存失败 · 点击重试' };
    if (draft.version > draft.savedVersion) return { key: 'pending', text: '正在记录…' };
    if (draft.exists) return { key: 'saved', text: '已保存' };
    return { key: 'idle', text: '等待书写' };
  }

  function renderDiary() {
    const draft = currentDraft();
    const status = draftStatus(draft);
    const diaries = state.payload.diaries || [];
    const chronological = diaries.slice().sort((a, b) => a.date.localeCompare(b.date));
    const current = chronological.findIndex((item) => item.date === state.day);
    const previous = current > 0 ? chronological[current - 1].date : '';
    const next = current >= 0 && current < chronological.length - 1 ? chronological[current + 1].date : '';
    const loadingClass = state.payload && state.payload.day && state.payload.day.loading
      ? ' calendar-diary-card--loading' : '';
    return '<section class="calendar-diary-card' + loadingClass
      + (state.diaryExpanded ? ' is-expanded' : '') + '" data-calendar-diary-day="' + state.day + '">'
      + '<header class="calendar-diary-head"><div><p>DIARY</p><h2>' + formatDay(state.day) + '</h2></div>'
      + '<div class="calendar-diary-nav">'
      + '<button type="button" data-calendar-jump="' + previous + '" ' + (previous ? '' : 'disabled') + '>上一篇</button>'
      + '<button type="button" data-calendar-jump="' + next + '" ' + (next ? '' : 'disabled') + '>下一篇</button>'
      + '</div></header>'
      + '<div class="calendar-diary-fields">'
      + '<input class="calendar-diary-title" data-diary-title value="' + escapeHtml(draft.title) + '" placeholder="今天，发生了什么？">'
      + '<input class="calendar-diary-tags" data-diary-tags value="' + escapeHtml(draft.tags) + '" placeholder="标签，用逗号分隔">'
      + '</div><div class="calendar-editor-tabs" data-preview="' + (state.preview ? '1' : '0') + '">'
      + '<i class="calendar-editor-slider" aria-hidden="true"></i>'
      + '<button type="button" data-calendar-mode="write" class="' + (!state.preview ? 'active' : '') + '">书写</button>'
      + '<button type="button" data-calendar-mode="preview" class="' + (state.preview ? 'active' : '') + '">阅读</button>'
      + '<button type="button" class="calendar-diary-status" data-diary-status aria-live="polite" data-status="'
      + status.key + '">' + status.text + '</button>'
      + '<button type="button" class="calendar-diary-expand" data-diary-expand>'
      + (state.diaryExpanded ? '收起' : '展开书写') + '</button></div>'
      + '<textarea class="calendar-diary-body" data-diary-body ' + (state.preview ? 'hidden' : '')
      + ' placeholder="支持 Markdown。这里适合留下当天的思考、过程和结论。">'
      + escapeHtml(draft.body) + '</textarea>'
      + '<article class="calendar-diary-preview markdown-body" data-diary-preview '
      + (state.preview ? '' : 'hidden') + '></article>'
      + '<footer class="calendar-diary-foot"><span>自动保存到 data/diary/' + state.day + '.md</span>'
      + '<button type="button" class="calendar-delete" data-diary-delete '
      + (draft.exists ? '' : 'hidden') + '>删除这篇</button></footer></section>';
  }

  function renderFocusItems() {
    const focus = state.payload.day.focus || {};
    const sessions = focus.sessions || [];
    if (!sessions.length) return '<p class="calendar-empty-line">这一天还没有专注记录。</p>';
    return sessions.map((session, index) => {
      const note = session.outcome
        ? '<em>成果：' + escapeHtml(session.outcome) + '</em>'
        : (session.goal ? '<em>目标：' + escapeHtml(session.goal) + '</em>' : '');
      return '<button type="button" class="calendar-record-item calendar-record-link calendar-focus-record"'
        + ' style="--calendar-item-delay:' + (Math.min(index, 4) * 18) + 'ms"'
        + ' data-calendar-record-key="focus:' + escapeHtml(session.id) + '"'
        + ' data-calendar-focus="' + escapeHtml(session.id) + '" data-calendar-focus-day="' + state.day + '"><div><strong>'
        + escapeHtml(session.taskTitle || '自由专注') + '</strong><span>'
        + escapeHtml(formatSessionTime(session.endedAt)) + '</span>' + note + '</div><b>'
        + formatDuration(session.durationSec) + '</b></button>';
    }).join('');
  }

  function formatSessionTime(value) {
    const parsed = new Date(value || '');
    if (Number.isNaN(parsed.getTime())) return '';
    return String(parsed.getHours()).padStart(2, '0') + ':'
      + String(parsed.getMinutes()).padStart(2, '0');
  }

  function renderArchives() {
    const archives = state.payload.day.archives || [];
    if (!archives.length) return '<p class="calendar-empty-line">这一天没有归档成果。</p>';
    return archives.map((item, index) => '<div class="calendar-record-item" style="--calendar-item-delay:'
      + (Math.min(index, 3) * 12) + 'ms" data-calendar-record-key="archive:'
      + escapeHtml(item.id || item.path || item.at || item.title + ':' + index) + '"><div><strong>'
      + escapeHtml(item.title) + '</strong><span>已沉淀进活跃足迹</span></div><b>完成</b></div>').join('');
  }

  function renderDayRecords(animateEntrance) {
    if (state.payload.day.loading) {
      return '<section class="calendar-records calendar-records-loading" aria-label="正在同步当天档案">'
        + '<article><i></i><i></i></article>'
        + '<article><i></i><i></i></article></section>';
    }
    const focus = state.payload.day.focus || {};
    return '<section class="calendar-records' + (animateEntrance ? ' calendar-records-enter' : '') + '">'
      + '<article style="--calendar-card-delay:16ms"><header><div><p>FOCUS</p><h3>专注记录</h3></div>'
      + '<span>' + (focus.count || 0) + ' 段 · ' + formatDuration(focus.durationSec) + '</span></header>'
      + renderFocusItems() + '</article>'
      + '<article style="--calendar-card-delay:38ms"><header><div><p>ARCHIVE</p><h3>当天成果</h3></div>'
      + '<button type="button" data-calendar-go="cadence">查看活跃</button></header>' + renderArchives() + '</article>'
      + '</section>';
  }

  // 「更新」按钮 HTML：放在头部工具区末尾。平时翻进日历用缓存，不重读；点它才强制重读当前月。
  function renderRefresh() {
    return '<button type="button" class="page-refresh" data-calendar-refresh'
      + ' aria-label="重新读取日历" title="重新读取日历数据（平时翻进来用上次结果；在别处改了任务/日记，点这里才更新）">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
      + '<span>更新</span></button>';
  }
  async function refreshCalendar(btn) {
    if (btn) btn.classList.add('is-refreshing');
    try {
      state.stale = true;
      await load(state.day, { kind: 'refresh', direction: 0 });   // 强制重读当前月（load 完成会整页重绘）
    } catch (e) {
      // load 自身已处理错误展示，这里只兜底，避免 rejection 冒泡
    } finally {
      if (btn) btn.classList.remove('is-refreshing');
    }
  }

  function render(motion) {
    root.innerHTML = '<div class="calendar-page-head"><div><p class="study-eyebrow">CALENDAR</p>'
      + '<h1>日历</h1><span>把临时想法、学习过程和完成的事，放回它们发生的那一天。</span></div>'
      + '<div class="calendar-head-tools">' + renderCountdown() + renderSearch() + renderRefresh()
      + '</div></div><div class="calendar-layout"><div>' + renderCalendar()
      + '</div><div class="calendar-day-column">' + renderDiary() + renderDayRecords(true) + '</div></div>';
    bindCalendarControls();
    bindDayControls();
    if (state.preview) renderPreview();
    activateMonthMotion(root, motion);
    activateEntranceMotion(motion);
    requestAnimationFrame(() => restoreKeyboardDayFocus());
  }

  function activateMonthMotion(host, motion) {
    if (prefersReduced || !motion || motion.kind !== 'month') return;
    const grid = host.querySelector('.calendar-grid');
    const title = host.querySelector('.calendar-month-head h1 span');
    if (!grid) return;
    const direction = motion.direction < 0 ? 'prev' : 'next';
    grid.classList.add('calendar-grid-from-' + direction);
    if (title) title.classList.add('calendar-month-title-enter');
    window.setTimeout(() => {
      grid.classList.remove('calendar-grid-from-next', 'calendar-grid-from-prev');
      if (title) title.classList.remove('calendar-month-title-enter');
    }, 620);
  }

  function clearEntranceMotion() {
    const head = root.querySelector('.calendar-page-head');
    const card = root.querySelector('.calendar-month-card');
    if (head) head.classList.remove('calendar-page-head-enter');
    if (card) card.classList.remove('calendar-card-enter');
  }

  function replayEntranceMotion() {
    if (prefersReduced || !state.loaded) return;
    clearEntranceMotion();
    // 强制结算一次 class 移除，下一帧重新添加即可重播；不重建 DOM、不重新读取数据。
    void root.offsetWidth;
    requestAnimationFrame(() => {
      if (!state.active) return;
      const head = root.querySelector('.calendar-page-head');
      const card = root.querySelector('.calendar-month-card');
      if (head) head.classList.add('calendar-page-head-enter');
      if (card) card.classList.add('calendar-card-enter');
    });
  }

  // 首次加载入场：页头错峰淡入 + 左侧网格格子错峰浮现。
  // 后续重新进入由 replayEntranceMotion 复用同一套 class，不重建页面。
  function activateEntranceMotion(motion) {
    if (prefersReduced || !motion || motion.kind !== 'initial') return;
    const head = root.querySelector('.calendar-page-head');
    const card = root.querySelector('.calendar-month-card');
    if (head) head.classList.add('calendar-page-head-enter');
    if (card) card.classList.add('calendar-card-enter');
    playCountdownRevealOnce(root.querySelector('[data-calendar-countdown]'), 260);
  }

  function renderCalendarPanel(motion) {
    const layout = root.querySelector('.calendar-layout');
    const panel = layout && layout.firstElementChild;
    if (!panel) return render(motion);
    panel.innerHTML = renderCalendar();
    bindMonthControls(panel);
    activateMonthMotion(panel, motion);
    requestAnimationFrame(() => restoreKeyboardDayFocus());
  }

  function syncCalendarSelection(animate) {
    root.querySelectorAll('[data-calendar-day]').forEach((button) => {
      const selected = button.dataset.calendarDay === state.day;
      button.classList.toggle('selected', selected);
      button.classList.remove('calendar-day-arrived');
      button.tabIndex = selected ? 0 : -1;
      if (selected) button.setAttribute('aria-current', 'date');
      else button.removeAttribute('aria-current');
      if (selected && animate && !prefersReduced) {
        void button.offsetWidth;
        button.classList.add('calendar-day-arrived');
        window.setTimeout(() => button.classList.remove('calendar-day-arrived'), 540);
      }
    });
  }

  function reconcileCalendarPanel() {
    const card = root.querySelector('.calendar-month-card');
    if (!card) return;
    const countdownCard = root.querySelector('[data-calendar-countdown]');
    const revealCountdown = !!(countdownCard && countdownCard.hidden
      && state.countdownEnabled && state.countdown);
    const title = card.querySelector('.calendar-month-head h1 span');
    if (title) title.textContent = state.year + ' 年 ' + state.month + ' 月';
    root.querySelectorAll('[data-calendar-day]').forEach((button) => {
      const marks = (state.payload.days || {})[button.dataset.calendarDay] || {};
      const dots = button.querySelector('b');
      if (dots) dots.innerHTML = renderCalendarDots(marks);
      button.classList.toggle('today', button.dataset.calendarDay === state.payload.today);
    });
    syncCalendarSelection();
    syncCountdownCard({ reveal: revealCountdown });
    restoreKeyboardDayFocus();
  }

  function renderRecordsPanel() {
    const oldRecords = root.querySelector('.calendar-records');
    if (!oldRecords) return;
    const previous = new Map();
    oldRecords.querySelectorAll('[data-calendar-record-key]').forEach((item) => {
      previous.set(item.dataset.calendarRecordKey, item.getBoundingClientRect());
    });
    const holder = document.createElement('div');
    holder.innerHTML = renderDayRecords(false);
    const nextRecords = holder.firstElementChild;
    oldRecords.replaceWith(nextRecords);
    bindRecordControls(nextRecords);
    if (prefersReduced) return;
    nextRecords.querySelectorAll('[data-calendar-record-key]').forEach((item) => {
      const key = item.dataset.calendarRecordKey;
      const before = previous.get(key);
      if (!before) {
        item.classList.add('calendar-record-added');
        item.addEventListener('animationend', () => item.classList.remove('calendar-record-added'), { once: true });
        return;
      }
      const now = item.getBoundingClientRect();
      const dx = before.left - now.left;
      const dy = before.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      item.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration: 220, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
    });
  }

  function reconcileDiaryCard(oldDiary) {
    const holder = document.createElement('div');
    holder.innerHTML = renderDiary();
    const nextDiary = holder.firstElementChild;
    if (oldDiary.dataset.calendarDiaryDay !== state.day) {
      oldDiary.replaceWith(nextDiary);
      bindDiaryControls();
      if (state.preview) renderPreview();
      return;
    }
    const draft = currentDraft();
    // 有未落盘改动时整篇字段都保留本地输入，避免后台刷新用旧版本覆盖正在编辑的内容
    const hasUnsavedEdits = draft.version > draft.savedVersion;
    ['[data-diary-title]', '[data-diary-tags]', '[data-diary-body]'].forEach((selector) => {
      const current = oldDiary.querySelector(selector);
      const next = nextDiary.querySelector(selector);
      if (current && next && !hasUnsavedEdits && (!draft.touched || document.activeElement !== current)) current.value = next.value;
    });
    const currentHeading = oldDiary.querySelector('.calendar-diary-head h2');
    const nextHeading = nextDiary.querySelector('.calendar-diary-head h2');
    if (currentHeading && nextHeading) currentHeading.textContent = nextHeading.textContent;
    const currentNav = oldDiary.querySelectorAll('[data-calendar-jump]');
    const nextNav = nextDiary.querySelectorAll('[data-calendar-jump]');
    currentNav.forEach((button, index) => {
      const source = nextNav[index];
      if (!source) return;
      button.dataset.calendarJump = source.dataset.calendarJump;
      button.disabled = source.disabled;
    });
    const currentFoot = oldDiary.querySelector('.calendar-diary-foot span');
    const nextFoot = nextDiary.querySelector('.calendar-diary-foot span');
    if (currentFoot && nextFoot) currentFoot.textContent = nextFoot.textContent;
    const currentDelete = oldDiary.querySelector('[data-diary-delete]');
    const nextDelete = nextDiary.querySelector('[data-diary-delete]');
    if (currentDelete && nextDelete) currentDelete.hidden = nextDelete.hidden;
    // 数据已到则务必摘掉「加载隐藏」类，否则减少动态下（无动画兜底）正文会一直被压成透明
    oldDiary.classList.toggle('calendar-diary-card--loading',
      !!(state.payload && state.payload.day && state.payload.day.loading));
    oldDiary.classList.toggle('is-expanded', state.diaryExpanded);
    const expand = oldDiary.querySelector('[data-diary-expand]');
    if (expand) expand.textContent = state.diaryExpanded ? '收起' : '展开书写';
    syncDiaryStatus();
    if (state.preview) renderPreview();
  }

  function renderDayPanel() {
    const oldDiary = root.querySelector('.calendar-diary-card');
    if (oldDiary) reconcileDiaryCard(oldDiary);
    renderRecordsPanel();
    syncDiaryStatus();
  }

  // 首次进日历页：数据到达后，先让右栏骨架柔和淡出，再整列重建并「缓缓写入」（见 revealDayColumnEnter）。
  // 只跑一次；若期间被新导航顶替（requestId 失效）就让位，绝不重放。
  function revealColumnFirstOpen(requestId) {
    const column = root.querySelector('.calendar-day-column');
    if (!column) { renderDayPanel(); return; }
    let done = false;
    const proceed = () => {
      if (done) return;
      done = true;
      if (requestId !== state.requestSeq) return;
      renderDayColumn({ kind: 'enter', direction: 0 });
    };
    const skeleton = column.querySelector('.calendar-records-loading');
    if (prefersReduced || !skeleton || !skeleton.animate) { proceed(); return; }
    const fade = skeleton.animate(
      [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }],
      { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
    );
    fade.onfinish = proceed;
    fade.oncancel = proceed;
    window.setTimeout(proceed, 380);  // 兜底：动画事件没触发也要继续，绝不卡在骨架上
  }

  // 旧内容退场：淡出当前一天，返回「退场已完成」Promise。退场不需要新数据，可在点击瞬间就起跑。
  function exitColumnContent(column) {
    return new Promise((resolve) => {
      const leaving = column.querySelectorAll(
        '.calendar-diary-head h2, .calendar-diary-fields, .calendar-editor-tabs,'
        + ' .calendar-diary-body, .calendar-diary-foot, .calendar-records > article'
      );
      let last = null;
      leaving.forEach((el) => {
        last = el.animate(
          [{ opacity: 1 }, { opacity: 0, transform: 'translateY(5px)' }],
          { duration: 190, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        );
      });
      if (!last) { resolve(); return; }
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      last.onfinish = done;
      last.oncancel = done;
      window.setTimeout(done, 260);  // 兜底：动画事件没触发也要继续
    });
  }

  // 切天 / 翻月：点击瞬间就让旧内容退场（与后端请求并行）。返回 finish()——调用后等退场跑完，
  // 再整列「缓缓写入」新的一天（speed 0.62、日期标题也一起淡入）。
  //   · 重访（已缓存）：乐观阶段立刻调用 finish，数据来自缓存、完全不等后端。
  //   · 未缓存：乐观阶段先起退场，把 finish 留到数据到达后调用，等待被退场盖住。
  // 连续快翻（200ms 内再次导航）跳过退场、直接换内容，避免来回重启。
  function beginColumnExit(requestId) {
    const column = root.querySelector('.calendar-day-column');
    const writeIn = () => {
      if (requestId !== state.requestSeq) return;  // 期间被新导航顶替则让位
      if (!root.querySelector('.calendar-day-column')) { renderDayPanel(); return; }
      renderDayColumn({ kind: 'enter', direction: 0, speed: 0.62, withHeading: true });
    };
    const now = performance.now();
    const rapid = now - state.lastNavAt < 200;
    state.lastNavAt = now;
    if (!column || prefersReduced || rapid) return writeIn;  // 不退场，调用即写入
    const exitDone = exitColumnContent(column);
    return () => { exitDone.then(writeIn); };
  }

  function animateDayColumn(column, motion) {
    const isEnter = !!(motion && motion.kind === 'enter');
    if (prefersReduced || !motion
        || (motion.kind !== 'day' && motion.kind !== 'month' && !isEnter)) return;
    const animated = [column].concat(Array.from(column.querySelectorAll('*')));
    animated.forEach((element) => {
      if (!element.getAnimations) return;
      element.getAnimations().forEach((animation) => animation.cancel());
    });
    const now = performance.now();
    const rapid = now - state.lastDayMotionAt < 180;
    state.lastDayMotionAt = now;
    if (rapid) return;  // 连续快翻时跳过（首开 lastDayMotionAt=0，永不算 rapid，照常揭示）
    const play = (element, frames, duration, delay, easing) => {
      if (!element) return;
      element.animate(frames, {
        duration,
        delay: delay || 0,
        easing: easing || 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both',
      });
    };
    if (isEnter) { revealDayColumnEnter(column, play, motion); return; }
    const offset = motion.direction < 0 ? -10 : 10;
    const diary = column.querySelector('.calendar-diary-card');
    play(diary, [
      { opacity: 0.84, transform: 'translate3d(' + offset + 'px,0,0) scale(0.994)' },
      { opacity: 1, transform: 'translate3d(' + (-offset * 0.04) + 'px,0,0) scale(1.001)', offset: 0.76 },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
    ], 390, 0);
    play(diary && diary.querySelector('.calendar-diary-head h2'), [
      { opacity: 0.28, transform: 'translate3d(' + (offset * 1.45) + 'px,0,0)' },
      { opacity: 1, transform: 'translate3d(' + (-offset * 0.08) + 'px,0,0)', offset: 0.74 },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], 440, 28);
    const diaryPieces = diary ? diary.querySelectorAll(
      '.calendar-diary-fields input, .calendar-editor-tabs, .calendar-diary-body, .calendar-diary-preview'
    ) : [];
    diaryPieces.forEach((piece, index) => play(piece, [
      { opacity: 0.48, transform: 'translate3d(0,7px,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ], 360, 62 + index * 22));
    column.querySelectorAll('.calendar-records > article').forEach((article, index) => play(article, [
      { opacity: 0.46, transform: 'translate3d(' + (offset * 0.68) + 'px,10px,0) scale(0.992)' },
      { opacity: 1, transform: 'translate3d(' + (-offset * 0.03) + 'px,-1px,0) scale(1.001)', offset: 0.78 },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
    ], 420, 118 + index * 38));
  }

  // 首开右栏「缓缓写入」：纯竖向、放慢、强减速。日记可编辑区逐行写入；随后档案卡逐张淡入、
  // 卡内任务 / 记录逐条上滑。卡片整体淡入、行只做位移（不再叠第二层透明，避免发灰）。
  function revealDayColumnEnter(column, play, motion) {
    const speed = (motion && motion.speed) || 1;          // 1=首开（舒缓）；<1=切天（更轻快）
    const withHeading = !!(motion && motion.withHeading); // 切天时日期变了，标题也一起淡入
    const ms = (v) => Math.round(v * speed);
    const silk = 'cubic-bezier(0.16, 1, 0.3, 1)';
    const riseFade = (dy) => [
      { opacity: 0, transform: 'translate3d(0,' + dy + 'px,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)' },
    ];
    const diary = column.querySelector('.calendar-diary-card');
    if (withHeading && diary) {
      play(diary.querySelector('.calendar-diary-head h2'), riseFade(8), ms(560), ms(40), silk);
    }
    const diaryPieces = diary ? diary.querySelectorAll(
      '.calendar-diary-fields input, .calendar-editor-tabs, .calendar-diary-body, .calendar-diary-preview, .calendar-diary-foot'
    ) : [];
    diaryPieces.forEach((piece, i) => play(piece, riseFade(10), ms(640), ms(120 + i * 70), silk));
    const recordsStart = 360;
    column.querySelectorAll('.calendar-records > article').forEach((article, ai) => {
      const base = recordsStart + ai * 150;
      play(article, riseFade(14), ms(720), ms(base), silk);
      const rows = article.querySelectorAll(
        '.calendar-record-item, .calendar-empty-line, .calendar-record-more'
      );
      rows.forEach((row, ri) => play(row, [
        { transform: 'translate3d(0,10px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], ms(520), ms(base + 110 + ri * 80), silk));
    });
  }

  function renderDayColumn(motion, animateSelection) {
    const column = root.querySelector('.calendar-day-column');
    if (!column) return render(motion);
    syncCalendarSelection(animateSelection);
    column.innerHTML = renderDiary() + renderDayRecords(false);
    bindDayControls();
    if (state.preview) renderPreview();
    restoreKeyboardDayFocus();
    animateDayColumn(column, motion);
  }

  function syncDiaryStatus() {
    const status = root.querySelector('[data-diary-status]');
    if (!status) return;
    const value = draftStatus(currentDraft());
    status.dataset.status = value.key;
    status.textContent = value.text;
  }

  function renderPreview() {
    const preview = root.querySelector('[data-diary-preview]');
    const body = root.querySelector('[data-diary-body]');
    if (!preview || !body) return;
    const markdown = window.MarkdownMini;
    const rendered = markdown && typeof markdown.renderResult === 'function'
      ? markdown.renderResult(body.value) : null;
    preview.innerHTML = rendered
      ? rendered.html
      : (markdown && markdown.render
        ? markdown.render(body.value)
        : '<pre>' + escapeHtml(body.value) + '</pre>');
    if ((!rendered || rendered.features.mermaid) && window.MermaidRenderer) {
      window.MermaidRenderer.renderAll(preview);
    }
    if ((!rendered || rendered.features.math) && window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([preview]).catch(() => {});
    }
  }

  function markDirty() {
    captureCurrentDraft();
    const draft = currentDraft();
    const firstLocalEntry = !draft.exists;
    draft.touched = true;
    draft.exists = true;
    draft.deleted = false;
    draft.version += 1;
    draft.status = 'pending';
    draft.error = '';
    const tags = draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    const summary = {
      date: draft.day,
      title: draft.title,
      tags,
      updatedAt: draft.updatedAt,
      excerpt: draft.body.replace(/\s+/g, ' ').slice(0, 100),
    };
    const existing = state.diaries.find((item) => item.date === draft.day);
    if (existing) Object.assign(existing, summary);
    else state.diaries.push(summary);
    state.monthCache.forEach((month) => {
      if (!draft.day.startsWith(monthKey(month.year, month.month) + '-')) return;
      const marks = month.days[draft.day] || (month.days[draft.day] = {});
      marks.diary = 1;
    });
    if (state.payload) {
      state.payload.diaries = state.diaries;
      state.payload.day.diary = {
        date: draft.day, title: draft.title, tags, body: draft.body, updatedAt: draft.updatedAt,
      };
      const marks = state.payload.days[draft.day] || (state.payload.days[draft.day] = {});
      marks.diary = 1;
    }
    if (firstLocalEntry) {
      const remove = root.querySelector('[data-diary-delete]');
      if (remove) remove.hidden = false;
      reconcileCalendarPanel();
    }
    syncDiaryStatus();
    queueDiarySave(draft.day, false);
  }

  function updateSavedDiary(day, diary) {
    const existing = state.diaries.find((item) => item.date === day);
    const summary = {
      date: day, title: diary.title, tags: diary.tags,
      updatedAt: diary.updatedAt, excerpt: diary.body.replace(/\s+/g, ' ').slice(0, 100),
    };
    if (existing) Object.assign(existing, summary);
    else state.diaries.push(summary);
    const cachedDay = state.dayCache.get(day);
    if (cachedDay) cachedDay.diary = diary;
    state.monthCache.forEach((month) => {
      if (!day.startsWith(monthKey(month.year, month.month) + '-')) return;
      const marks = month.days[day] || (month.days[day] = {});
      marks.diary = 1;
    });
    if (state.payload && state.day === day) {
      state.payload.diaries = state.diaries;
      state.payload.day.diary = diary;
      const marks = state.payload.days[day] || (state.payload.days[day] = {});
      marks.diary = 1;
      const remove = root.querySelector('[data-diary-delete]');
      if (remove) remove.hidden = false;
      reconcileCalendarPanel();
    }
  }

  function queueDiarySave(day, immediate) {
    const draft = state.drafts.get(day);
    if (!draft) return Promise.resolve(true);
    clearTimeout(draft.timer);
    draft.timer = 0;
    const run = () => {
      const version = draft.version;
      if (version <= draft.savedVersion || version <= (draft.queuedVersion || 0)) return draft.chain;
      draft.queuedVersion = version;
      const snapshot = { date: day, title: draft.title, tags: draft.tags, body: draft.body };
      draft.status = 'saving';
      if (state.day === day) syncDiaryStatus();
      const operation = draft.chain.catch(() => undefined).then(() =>
        request('/api/diary-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        })
      ).then((json) => {
        if (!draft.deleting) {
          updateSavedDiary(day, json.diary);
          draft.updatedAt = json.diary.updatedAt || draft.updatedAt;
          draft.exists = true;
          draft.deleted = false;
        }
        draft.savedVersion = Math.max(draft.savedVersion, version);
        draft.error = '';
        draft.status = draft.deleting
          ? 'idle'
          : (draft.version > draft.savedVersion ? 'pending' : 'saved');
        if (state.day === day) syncDiaryStatus();
        return true;
      }).catch((error) => {
        draft.queuedVersion = draft.savedVersion;
        draft.status = 'error';
        draft.error = error.message;
        if (state.day === day) syncDiaryStatus();
        return false;
      });
      draft.chain = operation;
      return operation;
    };
    if (immediate) return run();
    draft.timer = window.setTimeout(run, 700);
    return draft.chain;
  }

  function saveNow(day) {
    captureCurrentDraft();
    return queueDiarySave(day || state.day, true);
  }

  function changeMonth(delta) {
    const value = new Date(state.year, state.month - 1 + delta, 1);
    state.keyboardFocusDay = '';
    load(localDay(value), { kind: 'month', direction: delta });
  }

  function showSearch(value) {
    const panel = root.querySelector('[data-calendar-search-results]');
    if (!panel) return;
    const query = value.trim().toLocaleLowerCase();
    if (!query) {
      closeSearch(panel);
      return;
    }
    const matches = (state.payload.diaries || []).filter((item) =>
      [item.title, item.excerpt, (item.tags || []).join(' ')].join(' ').toLocaleLowerCase().includes(query)
    ).slice(0, 8);
    panel.innerHTML = matches.length ? matches.map((item) =>
      '<button type="button" data-calendar-search-day="' + item.date + '"><strong>'
      + escapeHtml(item.title || item.date) + '</strong><span>' + item.date + ' · '
      + escapeHtml(item.excerpt || '空白日记') + '</span></button>').join('')
      : '<p>没有找到日记</p>';
    panel.hidden = false;
    panel.classList.remove('closing');
    requestAnimationFrame(() => panel.classList.add('open'));
  }

  function closeSearch(panel) {
    if (!panel || panel.hidden) return;
    panel.classList.remove('open');
    panel.classList.add('closing');
    window.setTimeout(() => {
      if (panel.classList.contains('open')) return;
      panel.hidden = true;
      panel.classList.remove('closing');
      panel.innerHTML = '';
    }, prefersReduced ? 0 : 120);
  }

  function selectDayButton(button) {
    const selected = button.dataset.calendarDay;
    if (!selected || selected === state.day) return;
    state.keyboardFocusDay = '';
    const parsed = new Date(selected + 'T00:00:00');
    const sameMonth = parsed.getFullYear() === state.year && parsed.getMonth() + 1 === state.month;
    const direction = transitionDirection(selected);
    load(selected, { kind: sameMonth ? 'day' : 'month', direction });
  }

  function restoreKeyboardDayFocus() {
    if (!state.keyboardFocusDay) return;
    const active = document.activeElement;
    if (active && active !== document.body
        && !(active.matches && active.matches('[data-calendar-day]'))) return;
    const button = root.querySelector('[data-calendar-day="' + state.keyboardFocusDay + '"]');
    if (!button) return;
    button.focus({ preventScroll: true });
  }

  function navigateCalendarByDays(delta) {
    const base = state.keyboardFocusDay || state.day;
    const value = new Date(base + 'T00:00:00');
    value.setDate(value.getDate() + delta);
    const target = localDay(value);
    const sameMonth = value.getFullYear() === state.year && value.getMonth() + 1 === state.month;
    state.keyboardFocusDay = target;
    load(target, { kind: sameMonth ? 'day' : 'month', direction: delta >= 0 ? 1 : -1 });
  }

  function navigateCalendarToday() {
    const value = new Date();
    const target = localDay(value);
    if (target === state.day) {
      state.keyboardFocusDay = target;
      restoreKeyboardDayFocus();
      return;
    }
    const sameMonth = value.getFullYear() === state.year && value.getMonth() + 1 === state.month;
    state.keyboardFocusDay = target;
    load(target, { kind: sameMonth ? 'day' : 'month', direction: transitionDirection(target) });
  }

  function syncCountdownCard(options) {
    const current = root.querySelector('[data-calendar-countdown]');
    const holder = document.createElement('div');
    holder.innerHTML = renderCountdown();
    const next = holder.firstElementChild;
    if (!next) return;
    if (current) current.replaceWith(next);
    else {
      const tools = root.querySelector('.calendar-head-tools');
      if (tools) tools.insertBefore(next, tools.firstChild);
    }
    bindCountdownControls(next);
    if (next.hidden || prefersReduced) return;
    if (options && options.reveal) {
      playCountdownRevealOnce(next);
    }
    if (options && options.updated) {
      next.classList.add('calendar-countdown-updated');
      window.setTimeout(() => next.classList.remove('calendar-countdown-updated'), 420);
    }
  }

  function playCountdownRevealOnce(card, delay) {
    if (!card || card.hidden || prefersReduced
      || state.countdownRevealPlayed || state.countdownRevealPending) return;
    state.countdownRevealPending = true;
    window.setTimeout(() => {
      state.countdownRevealPending = false;
      if (!state.active || !card.isConnected || card.hidden || state.countdownRevealPlayed) return;
      state.countdownRevealPlayed = true;
      card.classList.add('calendar-countdown-revealing');
      window.setTimeout(() => card.classList.remove('calendar-countdown-revealing'), 360);
    }, Math.max(0, delay || 0));
  }

  function bindCountdownControls(scope) {
    const host = scope || root;
    const buttons = host.matches && host.matches('[data-countdown-clock]')
      ? [host] : host.querySelectorAll('[data-countdown-clock]');
    buttons.forEach((button) => button.addEventListener('click', openCountdownClock));
    host.querySelectorAll('[data-countdown-event],[data-countdown-date]').forEach((target) => {
      const field = target.hasAttribute('data-countdown-event') ? 'event' : 'date';
      target.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        beginCountdownInlineEdit(field, target);
      });
      target.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== 'F2') return;
        event.preventDefault();
        event.stopPropagation();
        beginCountdownInlineEdit(field, target);
      });
    });
  }

  function bindMonthControls(host) {
    host.querySelectorAll('[data-calendar-day]').forEach((button) => {
      button.addEventListener('click', () => selectDayButton(button));
    });
    host.querySelectorAll('[data-calendar-month]').forEach((button) => {
      button.addEventListener('click', () => changeMonth(Number(button.dataset.calendarMonth)));
    });
    const today = host.querySelector('[data-calendar-today]');
    if (today) today.addEventListener('click', () => {
      const value = new Date();
      const target = localDay(value);
      const sameMonth = value.getFullYear() === state.year && value.getMonth() + 1 === state.month;
      const direction = transitionDirection(target);
      state.keyboardFocusDay = '';
      load(target, { kind: sameMonth ? 'day' : 'month', direction });
    });
  }

  function bindCalendarControls() {
    bindMonthControls(root);
    bindCountdownControls(root);
    const refresh = root.querySelector('[data-calendar-refresh]');
    if (refresh) refresh.addEventListener('click', () => refreshCalendar(refresh));
    const search = root.querySelector('[data-calendar-search]');
    if (search) {
      search.addEventListener('input', () => showSearch(search.value));
      search.addEventListener('keydown', (event) => {
        const panel = root.querySelector('[data-calendar-search-results]');
        if (!panel || panel.hidden) return;
        const items = Array.from(panel.querySelectorAll('button'));
        const current = items.findIndex((item) => item.classList.contains('active'));
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSearch(panel);
          return;
        }
        if (!items.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current <= 0 ? items.length - 1 : current - 1);
          items.forEach((item, index) => item.classList.toggle('active', index === next));
          items[next].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && current >= 0) {
          event.preventDefault();
          items[current].click();
        }
      });
    }
    const results = root.querySelector('[data-calendar-search-results]');
    if (results) results.addEventListener('click', (event) => {
      const button = event.target.closest('[data-calendar-search-day]');
      if (!button) return;
      const day = button.dataset.calendarSearchDay;
      const parsed = new Date(day + 'T00:00:00');
      const sameMonth = parsed.getFullYear() === state.year && parsed.getMonth() + 1 === state.month;
      const direction = transitionDirection(day);
      closeSearch(results);
      state.keyboardFocusDay = '';
      load(day, { kind: sameMonth ? 'day' : 'month', direction });
    });
  }

  function launchAfterFeedback(button, detail) {
    button.classList.add('is-launching');
    requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent('calendar:navigate', { detail }));
    });
  }

  function removeDiaryFromLocal(day) {
    const draft = diaryDraft(day, state.payload && state.payload.day.diary);
    const summary = state.diaries.find((item) => item.date === day);
    const cachedDay = state.dayCache.get(day);
    const snapshot = {
      summary: summary ? Object.assign({}, summary) : null,
      diary: cachedDay && cachedDay.diary ? Object.assign({}, cachedDay.diary) : null,
      draft: {
        title: draft.title, tags: draft.tags, body: draft.body,
        updatedAt: draft.updatedAt, exists: draft.exists,
      },
    };
    state.diaries = state.diaries.filter((item) => item.date !== day);
    if (cachedDay) cachedDay.diary = null;
    state.monthCache.forEach((month) => {
      if (month.days[day]) month.days[day].diary = 0;
    });
    clearTimeout(draft.timer);
    draft.timer = 0;
    draft.deleting = true;
    draft.deleted = false;
    draft.title = '';
    draft.tags = '';
    draft.body = '';
    draft.updatedAt = '';
    draft.exists = false;
    draft.touched = false;
    draft.version += 1;
    draft.savedVersion = draft.version;
    draft.status = 'idle';
    draft.error = '';
    if (state.payload && state.day === day) {
      state.payload.diaries = state.diaries;
      state.payload.day.diary = null;
      if (state.payload.days[day]) state.payload.days[day].diary = 0;
    }
    return { draft, snapshot, deleteVersion: draft.version };
  }

  function restoreDeletedDiary(day, operation) {
    const draft = operation.draft;
    const snapshot = operation.snapshot;
    draft.deleting = false;
    draft.deleted = false;
    if (draft.version !== operation.deleteVersion) {
      queueDiarySave(day, true);
      return;
    }
    Object.assign(draft, snapshot.draft, {
      touched: false,
      status: snapshot.draft.exists ? 'saved' : 'idle',
      error: '',
    });
    if (snapshot.summary) state.diaries.push(snapshot.summary);
    const cachedDay = state.dayCache.get(day);
    if (cachedDay) cachedDay.diary = snapshot.diary;
    state.monthCache.forEach((month) => {
      if (!day.startsWith(monthKey(month.year, month.month) + '-')) return;
      const marks = month.days[day] || (month.days[day] = {});
      marks.diary = snapshot.diary ? 1 : 0;
    });
    if (state.day === day) {
      state.payload = cachedPayload(day, state.year, state.month);
      if (snapshot.diary) {
        const marks = state.payload.days[day] || (state.payload.days[day] = {});
        marks.diary = 1;
      }
      reconcileCalendarPanel();
      renderDayColumn({ kind: 'refresh', direction: 0 });
    }
  }

  function deleteDiaryOptimistically(button) {
    const day = state.day;
    const operation = removeDiaryFromLocal(day);
    const card = button.closest('.calendar-diary-card');
    if (card && !prefersReduced) card.classList.add('calendar-diary-removing');
    window.setTimeout(() => {
      if (state.day !== day) return;
      state.payload = cachedPayload(day, state.year, state.month);
      reconcileCalendarPanel();
      renderDayColumn({ kind: 'refresh', direction: 0 });
    }, prefersReduced ? 0 : 110);
    const deletion = operation.draft.chain.catch(() => undefined).then(() =>
      request('/api/diary-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day }),
      })
    ).then(() => {
      operation.draft.deleting = false;
      operation.draft.deleted = operation.draft.version === operation.deleteVersion;
      if (operation.draft.version > operation.deleteVersion) queueDiarySave(day, true);
    }).catch((error) => {
      restoreDeletedDiary(day, operation);
      showToast('删除失败 · ' + error.message);
    });
    operation.draft.chain = deletion;
  }

  function bindDiaryControls() {
    root.querySelectorAll('[data-calendar-jump]').forEach((button) => {
      button.addEventListener('click', () => {
        const day = button.dataset.calendarJump;
        if (!day) return;
        const parsed = new Date(day + 'T00:00:00');
        const sameMonth = parsed.getFullYear() === state.year && parsed.getMonth() + 1 === state.month;
        const direction = transitionDirection(day);
        state.keyboardFocusDay = '';
        load(day, { kind: sameMonth ? 'day' : 'month', direction });
      });
    });
    root.querySelectorAll('[data-diary-title],[data-diary-tags],[data-diary-body]').forEach((field) => {
      field.addEventListener('input', () => {
        markDirty();
        if (field.matches('[data-diary-body]') && state.preview) renderPreview();
      });
    });
    root.querySelectorAll('[data-calendar-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.preview = button.dataset.calendarMode === 'preview';
        const body = root.querySelector('[data-diary-body]');
        const preview = root.querySelector('[data-diary-preview]');
        root.querySelectorAll('[data-calendar-mode]').forEach((item) =>
          item.classList.toggle('active', item === button));
        const tabs = root.querySelector('.calendar-editor-tabs');
        if (tabs) tabs.dataset.preview = state.preview ? '1' : '0';
        if (body) body.hidden = state.preview;
        if (preview) preview.hidden = !state.preview;
        const entering = state.preview ? preview : body;
        if (state.preview && preview) {
          preview.classList.add('is-rendering');
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!state.preview || !preview.isConnected) return;
            renderPreview();
            preview.classList.remove('is-rendering');
          }));
        }
        if (entering && !prefersReduced) {
          entering.classList.remove('calendar-editor-enter');
          void entering.offsetWidth;
          entering.classList.add('calendar-editor-enter');
          window.setTimeout(() => entering.classList.remove('calendar-editor-enter'), 190);
        }
      });
    });
    const status = root.querySelector('[data-diary-status]');
    if (status) status.addEventListener('click', () => {
      const draft = currentDraft();
      if (draft.status === 'error' || draft.version > draft.savedVersion) saveNow(state.day);
    });
    const remove = root.querySelector('[data-diary-delete]');
    if (remove) remove.addEventListener('click', () => {
      if (!window.confirm('删除 ' + state.day + ' 的日记？这不会影响当天的学习与专注记录。')) return;
      deleteDiaryOptimistically(remove);
    });
    const expand = root.querySelector('[data-diary-expand]');
    if (expand) expand.addEventListener('click', () => {
      state.diaryExpanded = !state.diaryExpanded;
      const card = root.querySelector('.calendar-diary-card');
      if (!card) return;
      card.classList.toggle('is-expanded', state.diaryExpanded);
      expand.textContent = state.diaryExpanded ? '收起' : '展开书写';
    });
  }

  function bindDayControls() {
    bindDiaryControls();
    bindRecordControls(root);
  }

  function bindRecordControls(scope) {
    const host = scope || root;
    host.querySelectorAll('[data-calendar-go]').forEach((button) => {
      button.addEventListener('click', () => {
        launchAfterFeedback(button, { view: button.dataset.calendarGo });
      });
    });
    host.querySelectorAll('[data-calendar-expand]').forEach((button) => {
      button.addEventListener('click', () => {
        const collapsed = button.dataset.calendarExpand !== '1';
        if (collapsed) state.expandedDays.add(state.day);
        else state.expandedDays.delete(state.day);
        renderRecordsPanel();
      });
    });
    host.querySelectorAll('[data-calendar-focus]').forEach((button) => {
      button.addEventListener('click', () => {
        launchAfterFeedback(button, {
          view: 'focus',
          day: button.dataset.calendarFocusDay,
          sessionId: button.dataset.calendarFocus,
        });
      });
    });
  }

  document.addEventListener('canvas:data-changed', () => {
    state.stale = true;
    state.monthCache.clear();
    state.dayCache.clear();
    if (!state.active) return;
    clearTimeout(state.reloadTimer);
    state.reloadTimer = window.setTimeout(() => load(state.day, { kind: 'refresh', direction: 0 }), 180);
  });

  document.addEventListener('calendar:countdown-visibility', (event) => {
    state.countdownEnabled = !(event.detail && event.detail.enabled === false);
    if (!state.loaded) return;
    syncCountdownCard({ reveal: state.countdownEnabled });
  });

  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest && event.target.closest('.calendar-search-wrap')) return;
    closeSearch(root.querySelector('[data-calendar-search-results]'));
  });

  document.addEventListener('keydown', (event) => {
    if (!state.active || event.defaultPrevented) return;
    const flipClock = document.querySelector('[data-calendar-flip-clock]');
    if (flipClock) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCountdownClock();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const editor = flipClock.querySelector('[data-flip-event-editor]');
        const focusables = Array.from((editor || flipClock).querySelectorAll(
          'button:not([disabled]), input:not([disabled])'
        )).filter((item) => item.offsetParent !== null);
        if (focusables.length) {
          const current = focusables.indexOf(document.activeElement);
          const next = event.shiftKey
            ? (current <= 0 ? focusables.length - 1 : current - 1)
            : (current + 1) % focusables.length;
          focusables[next].focus({ preventScroll: true });
        }
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const typing = target && target.matches
      && (target.matches('input, textarea, [contenteditable="true"]')
        || target.closest('[contenteditable="true"]'));
    if (typing) return;
    const dayButton = target && target.closest && target.closest('[data-calendar-day]');
    const inCalendar = target === document.body || dayButton;
    if (!inCalendar) return;
    const moves = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (Object.prototype.hasOwnProperty.call(moves, event.key)) {
      event.preventDefault();
      navigateCalendarByDays(moves[event.key]);
    } else if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      navigateCalendarToday();
    }
  });

  window.addEventListener('pagehide', () => {
    state.resumeAfterPageShow = state.active;
    state.active = false;
    cancelCalendarNetworkWork();
    captureCurrentDraft();
    state.drafts.forEach((draft) => {
      if (draft.deleting || draft.version <= draft.savedVersion) return;
      fetch('/api/diary-save', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: draft.day, title: draft.title, tags: draft.tags, body: draft.body,
        }),
      }).catch(() => {});
    });
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !state.resumeAfterPageShow) return;
    state.resumeAfterPageShow = false;
    window.CanvasCalendar.activate();
  });
  window.CanvasCalendar = {
    activate() {
      state.active = true;
      if (!state.loaded || state.stale) {
        load(state.day, { kind: state.loaded ? 'refresh' : 'initial', direction: 0 });
      } else {
        replayEntranceMotion();
      }
    },
    deactivate() {
      state.active = false;
      state.resumeAfterPageShow = false;
      cancelCalendarNetworkWork();
      closeCountdownClock();
      clearEntranceMotion();
      captureCurrentDraft();
      state.drafts.forEach((draft) => {
        if (!draft.deleting && draft.version > draft.savedVersion) queueDiarySave(draft.day, true);
      });
    },
    reload() {
      state.stale = true;
      if (state.active) load(state.day, { kind: 'refresh', direction: 0 });
    },
  };
})();

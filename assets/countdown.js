(function () {
  'use strict';

  const root = document.querySelector('[data-countdown-root]');
  const list = document.querySelector('[data-countdown-list]');
  const stage = document.querySelector('[data-countdown-stage]');
  const empty = document.querySelector('[data-countdown-empty]');
  const editorMask = document.querySelector('[data-countdown-editor]');
  const form = document.querySelector('[data-countdown-form]');
  const toast = document.querySelector('[data-countdown-toast]');
  const titleDisplay = document.querySelector('[data-countdown-title]');
  const dateDisplay = document.querySelector('[data-countdown-date]');
  const focusButton = document.querySelector('[data-countdown-focus]');
  const focusExit = document.querySelector('[data-countdown-focus-exit]');
  const wallpaperButton = document.querySelector('[data-countdown-wallpaper]');
  const topBar = document.querySelector('.countdown-top-bar');
  const eventsPanel = root && root.querySelector('.countdown-events');
  const stageHead = stage && stage.querySelector('.countdown-stage-head');
  const pageParams = new URLSearchParams(window.location.search);
  const wallpaperMode = pageParams.get('wallpaper') === '1';
  const wallpaperEventId = wallpaperMode ? String(pageParams.get('event') || '') : '';
  const wallpaperLanguage = wallpaperMode && pageParams.get('lang') === 'en' ? 'en' : 'zh-CN';
  if (!root || !list || !stage || !empty || !editorMask || !form || !titleDisplay || !dateDisplay
      || !focusButton || !focusExit || !wallpaperButton || !topBar || !eventsPanel || !stageHead) return;
  if (wallpaperMode) document.body.classList.add('countdown-wallpaper-mode');

  const reducedMotion = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (error) { return false; }
  })();
  const COPY = {
    'zh-CN': {
      back: '返回日历', eventsTitle: '倒数日', eventsHint: '选择一个日子，让时间有一个方向。',
      edit: '编辑', expand: '放大', exitExpand: '退出放大', days: '天', hours: '时', minutes: '分', seconds: '秒', exitHint: '返回日历', focusHint: '放大/取消放大',
      emptyTitle: '还没有倒数日', emptyBody: '写下一个值得期待的日子，时钟会从这一秒开始陪你靠近它。',
      emptyAction: '创建第一个倒数日', eventName: '事件名称', targetDate: '目标日期',
      delete: '删除', deleteAgain: '再次点击删除', cancel: '取消', save: '保存',
      newTitle: '新建倒数日', editTitle: '编辑倒数日', future: '距离目标还有', past: '已经过去', today: '就是今天',
      quickName: '双击快速重命名；Enter 保存，Esc 取消', quickDate: '双击快速修改日期；Enter 保存，Esc 取消',
      setWallpaper: '设为桌面背景', replaceWallpaper: '替换桌面背景', stopWallpaper: '取消桌面背景',
      wallpaperStarting: '正在连接桌面…', wallpaperFailed: '动态背景启动失败',
      loadFailed: '倒数日读取失败', saveFailed: '保存失败', saved: '已保存', unnamed: '未命名倒数日',
    },
    en: {
      back: 'Back to Calendar', eventsTitle: 'Countdowns', eventsHint: 'Choose a day and give time a direction.',
      edit: 'Edit', expand: 'Enlarge', exitExpand: 'Exit enlarged view', days: 'days', hours: 'hr', minutes: 'min', seconds: 'sec', exitHint: 'Back to Calendar', focusHint: 'Enlarge / Exit',
      emptyTitle: 'No countdowns yet', emptyBody: 'Write down a day worth anticipating. The clock will stay with you from this second on.',
      emptyAction: 'Create first countdown', eventName: 'Event name', targetDate: 'Target date',
      delete: 'Delete', deleteAgain: 'Click again to delete', cancel: 'Cancel', save: 'Save',
      newTitle: 'New countdown', editTitle: 'Edit countdown', future: 'Time remaining', past: 'Time since', today: 'Today',
      quickName: 'Double-click to rename · Enter saves · Esc cancels', quickDate: 'Double-click to change date · Enter saves · Esc cancels',
      setWallpaper: 'Set as Desktop', replaceWallpaper: 'Replace Desktop', stopWallpaper: 'Stop Desktop',
      wallpaperStarting: 'Connecting to desktop…', wallpaperFailed: 'Could not start desktop wallpaper',
      loadFailed: 'Could not load countdowns', saveFailed: 'Could not save', saved: 'Saved', unnamed: 'Untitled countdown',
    },
  };
  const state = {
    data: { version: 2, selectedId: '', events: [], event: '', date: '' },
    timer: 0,
    saveSeq: 0,
    editingId: '',
    deleteArmed: false,
    deleteTimer: 0,
    leaving: false,
    loaded: false,
    inlineEdit: null,
    focusMode: false,
    wallpaper: { supported: false, active: false, eventId: '', busy: false },
    wallpaperSyncTimer: 0,
    wallpaperSyncBusy: false,
    wallpaperMissingNotified: false,
  };

  function language() {
    if (wallpaperMode) return wallpaperLanguage;
    return window.RelatumI18n && window.RelatumI18n.language === 'en' ? 'en' : 'zh-CN';
  }

  function text(key) {
    return COPY[language()][key] || COPY['zh-CN'][key] || key;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalize(payload, preferredId) {
    const events = Array.isArray(payload && payload.events) ? payload.events.filter((item) =>
      item && item.id && item.event && item.date).slice(0, 100).map((item) => {
      const clean = { id: String(item.id), event: String(item.event), date: String(item.date) };
      // 日历页进度条的可选窗口长度（天）：保留合法整数，非法即视为未设置。
      const lengthDays = Number(item.lengthDays);
      if (Number.isInteger(lengthDays) && lengthDays >= 1 && lengthDays <= 9999) {
        clean.lengthDays = lengthDays;
      }
      return clean;
    }) : [];
    const selected = events.find((item) => item.id === String(preferredId || ''))
      || events.find((item) => item.id === String(payload && payload.selectedId || '')) || events[0] || null;
    return {
      version: 2,
      selectedId: selected ? selected.id : '',
      events,
      event: selected ? selected.event : '',
      date: selected ? selected.date : '',
    };
  }

  function selectedEvent() {
    return state.data.events.find((item) => item.id === state.data.selectedId) || null;
  }

  function cloneData() {
    return JSON.parse(JSON.stringify(state.data));
  }

  function restoreInlineTarget(target) {
    const isTitle = target === titleDisplay;
    target.setAttribute('role', 'button');
    target.tabIndex = 0;
    target.title = text(isTitle ? 'quickName' : 'quickDate');
    target.setAttribute('aria-label', text(isTitle ? 'quickName' : 'quickDate'));
  }

  function eventId() {
    return 'event-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(value) {
    const parsed = new Date(value + 'T00:00:00');
    if (Number.isNaN(parsed.getTime())) return value;
    try {
      return new Intl.DateTimeFormat(language() === 'en' ? 'en-US' : 'zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      }).format(parsed);
    } catch (error) {
      return value;
    }
  }

  function parts() {
    const selected = selectedEvent();
    if (!selected) return null;
    const target = new Date(selected.date + 'T00:00:00').getTime();
    if (!Number.isFinite(target)) return null;
    const raw = target - Date.now();
    const absoluteSeconds = Math.floor(Math.abs(raw) / 1000);
    return {
      future: raw > 0,
      today: Math.abs(raw) < 86400000 && new Date().toDateString() === new Date(target).toDateString(),
      days: Math.floor(absoluteSeconds / 86400),
      hours: Math.floor((absoluteSeconds % 86400) / 3600),
      minutes: Math.floor((absoluteSeconds % 3600) / 60),
      seconds: absoluteSeconds % 60,
    };
  }

  function setFlip(unit, value, animate) {
    if (!unit) return;
    const flip = unit.querySelector('.countdown-flip');
    const top = flip.querySelector('.countdown-half-top span');
    const bottom = flip.querySelector('.countdown-half-bottom span');
    const flapTop = flip.querySelector('.countdown-flap-top span');
    const flapBottom = flip.querySelector('.countdown-flap-bottom span');
    const current = top.textContent;
    if (current === value) return;
    window.clearTimeout(flip._cleanupTimer || 0);
    flip.dataset.value = value;
    flip.dataset.length = String(value.length);
    if (!current || !animate || reducedMotion) {
      flip.classList.remove('go');
      top.textContent = value;
      bottom.textContent = value;
      flapTop.textContent = value;
      flapBottom.textContent = value;
      return;
    }

    // 与 daoshu 参考项目保持同一套四层常驻结构和状态切换：
    // 旧上叶片折走，新下叶片随后落下；动画期间不创建或删除任何 DOM。
    flip._generation = (flip._generation || 0) + 1;
    const generation = flip._generation;
    flapTop.textContent = current;
    flapBottom.textContent = value;
    top.textContent = value;
    bottom.textContent = current;

    flip.classList.remove('go');
    void flip.offsetWidth;
    flip.classList.add('go');
    flip._cleanupTimer = window.setTimeout(() => {
      if (flip._generation !== generation) return;
      flip.classList.remove('go');
      bottom.textContent = value;
    }, 600);
  }

  function updateClock(animate) {
    const value = parts();
    if (!value) return;
    const status = document.querySelector('[data-countdown-status]');
    status.textContent = value.today ? text('today') : (value.future ? text('future') : text('past'));
    setFlip(stage.querySelector('[data-unit="days"]'), String(value.days), animate);
    setFlip(stage.querySelector('[data-unit="hours"]'), String(value.hours).padStart(2, '0'), animate);
    setFlip(stage.querySelector('[data-unit="minutes"]'), String(value.minutes).padStart(2, '0'), animate);
    setFlip(stage.querySelector('[data-unit="seconds"]'), String(value.seconds).padStart(2, '0'), animate);
  }

  function scheduleClock() {
    window.clearTimeout(state.timer);
    if ((document.hidden && !wallpaperMode) || !selectedEvent()) return;
    updateClock(true);
    const delay = Math.max(80, 1016 - (Date.now() % 1000));
    state.timer = window.setTimeout(scheduleClock, delay);
  }

  function renderList() {
    list.innerHTML = state.data.events.map((item) => '<button type="button" class="countdown-event'
      + (item.id === state.data.selectedId ? ' is-active' : '') + '" data-countdown-event="'
      + escapeHtml(item.id) + '"><span data-user-content>' + escapeHtml(item.event) + '</span><time>'
      + escapeHtml(formatDate(item.date)) + '</time><i aria-hidden="true"></i></button>').join('');
    list.querySelectorAll('[data-countdown-event]').forEach((button) => {
      button.addEventListener('click', () => select(button.dataset.countdownEvent));
    });
  }

  function render(options) {
    if (state.inlineEdit) {
      state.inlineEdit.finishing = true;
      state.inlineEdit = null;
      titleDisplay.classList.remove('is-editing');
      dateDisplay.classList.remove('is-editing');
      restoreInlineTarget(titleDisplay);
      restoreInlineTarget(dateDisplay);
    }
    if (!state.loaded) {
      empty.hidden = true;
      stage.hidden = true;
      root.setAttribute('aria-busy', 'true');
      return;
    }
    const selected = selectedEvent();
    const hasEvents = !!selected;
    empty.hidden = hasEvents;
    stage.hidden = !hasEvents;
    if (!wallpaperMode) renderList();
    if (hasEvents) {
      titleDisplay.textContent = selected.event || text('unnamed');
      dateDisplay.dateTime = selected.date;
      dateDisplay.textContent = formatDate(selected.date);
      if (wallpaperMode) {
        titleDisplay.removeAttribute('role');
        titleDisplay.removeAttribute('tabindex');
        titleDisplay.removeAttribute('title');
        dateDisplay.removeAttribute('role');
        dateDisplay.removeAttribute('tabindex');
        dateDisplay.removeAttribute('title');
      }
      updateClock(!(options && options.immediate));
      scheduleClock();
    } else {
      window.clearTimeout(state.timer);
      state.timer = 0;
      if (wallpaperMode && state.loaded) notifyWallpaperMissing();
    }
    root.setAttribute('aria-busy', 'false');
    updateWallpaperButton();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function updateWallpaperButton() {
    if (wallpaperMode) return;
    const selected = selectedEvent();
    const wallpaper = state.wallpaper;
    wallpaperButton.hidden = !wallpaper.supported || !selected;
    wallpaperButton.disabled = wallpaper.busy || !selected;
    wallpaperButton.classList.toggle('is-busy', wallpaper.busy);
    wallpaperButton.classList.toggle('is-active', !!selected && wallpaper.active
      && wallpaper.eventId === selected.id);
    wallpaperButton.setAttribute('aria-pressed', String(!!selected && wallpaper.active
      && wallpaper.eventId === selected.id));
    const label = wallpaperButton.querySelector('[data-countdown-wallpaper-label]');
    if (!label) return;
    if (wallpaper.busy) label.textContent = text('wallpaperStarting');
    else if (wallpaper.active && selected && wallpaper.eventId === selected.id) {
      label.textContent = text('stopWallpaper');
    } else if (wallpaper.active) label.textContent = text('replaceWallpaper');
    else label.textContent = text('setWallpaper');
  }

  function applyWallpaperState(result) {
    const next = result && typeof result === 'object' ? result : {};
    state.wallpaper.supported = !!next.supported;
    state.wallpaper.active = !!next.active;
    state.wallpaper.eventId = next.active ? String(next.eventId || '') : '';
    updateWallpaperButton();
  }

  async function refreshWallpaperState() {
    if (wallpaperMode || !window.CanvasDesktop
        || typeof window.CanvasDesktop.getCountdownWallpaperState !== 'function') return;
    try {
      applyWallpaperState(await window.CanvasDesktop.getCountdownWallpaperState());
    } catch (error) {
      state.wallpaper.supported = false;
      updateWallpaperButton();
    }
  }

  async function toggleDesktopWallpaper() {
    const selected = selectedEvent();
    if (!selected || state.wallpaper.busy || !window.CanvasDesktop) return;
    state.wallpaper.busy = true;
    updateWallpaperButton();
    try {
      const sameEvent = state.wallpaper.active && state.wallpaper.eventId === selected.id;
      const result = sameEvent
        ? await window.CanvasDesktop.stopCountdownWallpaper()
        : await window.CanvasDesktop.startCountdownWallpaper(selected.id, language());
      applyWallpaperState(result);
      if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : text('wallpaperFailed'));
      }
    } catch (error) {
      showToast(text('wallpaperFailed') + ' · ' + error.message);
      await refreshWallpaperState();
    } finally {
      state.wallpaper.busy = false;
      updateWallpaperButton();
    }
  }

  function callWallpaperApi(method, ...args) {
    const invoke = () => {
      try {
        const api = window.pywebview && window.pywebview.api;
        if (api && typeof api[method] === 'function') api[method](...args);
      } catch (error) {}
    };
    try {
      const api = window.pywebview && window.pywebview.api;
      if (api && typeof api[method] === 'function') invoke();
      else window.addEventListener('pywebviewready', invoke, { once: true });
    } catch (error) {
      window.addEventListener('pywebviewready', invoke, { once: true });
    }
  }

  function notifyWallpaperMissing() {
    if (!wallpaperMode || state.wallpaperMissingNotified) return;
    state.wallpaperMissingNotified = true;
    callWallpaperApi('countdown_wallpaper_event_missing', wallpaperEventId);
  }

  function scheduleWallpaperSync(delay) {
    window.clearTimeout(state.wallpaperSyncTimer);
    if (!wallpaperMode || state.wallpaperMissingNotified) return;
    state.wallpaperSyncTimer = window.setTimeout(syncWallpaperData, delay == null ? 3000 : delay);
  }

  async function syncWallpaperData() {
    if (!wallpaperMode || state.wallpaperSyncBusy) return;
    state.wallpaperSyncBusy = true;
    try {
      const response = await fetch('/api/countdown', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || text('loadFailed'));
      const events = Array.isArray(payload && payload.events) ? payload.events : [];
      const pinned = events.find((item) => item && String(item.id || '') === wallpaperEventId);
      if (!pinned) {
        notifyWallpaperMissing();
        return;
      }
      const next = normalize(payload, wallpaperEventId);
      const current = selectedEvent();
      const changed = !current || current.id !== wallpaperEventId
        || current.event !== String(pinned.event || '') || current.date !== String(pinned.date || '');
      if (changed) {
        state.data = next;
        state.loaded = true;
        render({ immediate: true });
      }
      callWallpaperApi('update_countdown_wallpaper_event', wallpaperEventId, String(pinned.event || ''));
    } catch (error) {
      // A transient local-server failure should not tear down a healthy desktop.
    } finally {
      state.wallpaperSyncBusy = false;
      scheduleWallpaperSync(3000);
    }
  }

  async function save(previous) {
    const seq = ++state.saveSeq;
    const payload = JSON.parse(JSON.stringify(state.data));
    try {
      const response = await fetch('/api/countdown-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true,
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || text('saveFailed'));
      if (seq !== state.saveSeq) return;
      const normalized = normalize(json.countdown);
      if (JSON.stringify(normalized) !== JSON.stringify(state.data)) {
        state.data = normalized;
        render({ immediate: true });
      }
      showToast(text('saved'));
      refreshWallpaperState();
    } catch (error) {
      if (seq !== state.saveSeq) return;
      state.data = previous;
      render({ immediate: true });
      showToast(text('saveFailed') + ' · ' + error.message);
    }
  }

  function select(id) {
    if (!id || id === state.data.selectedId) return;
    const selected = state.data.events.find((item) => item.id === id);
    if (!selected) return;
    const previous = cloneData();
    state.data.selectedId = selected.id;
    state.data.event = selected.event;
    state.data.date = selected.date;
    render({ immediate: true });
    save(previous);
  }

  function refreshSelectedMetadata(dateChanged) {
    const selected = selectedEvent();
    if (!selected) return;
    titleDisplay.textContent = selected.event || text('unnamed');
    dateDisplay.dateTime = selected.date;
    dateDisplay.textContent = formatDate(selected.date);
    const active = Array.from(list.querySelectorAll('[data-countdown-event]'))
      .find((button) => button.dataset.countdownEvent === selected.id);
    if (active) {
      const name = active.querySelector('span');
      const date = active.querySelector('time');
      if (name) name.textContent = selected.event;
      if (date) date.textContent = formatDate(selected.date);
    }
    if (dateChanged) updateClock(false);
    scheduleClock();
  }

  function finishInlineEdit(commit) {
    const session = state.inlineEdit;
    if (!session || session.finishing) return;
    session.finishing = true;
    state.inlineEdit = null;
    session.target.classList.remove('is-editing');
    restoreInlineTarget(session.target);
    const selected = selectedEvent();
    if (!selected || selected.id !== session.eventId) {
      render({ immediate: true });
      return;
    }
    const value = session.input.value.trim();
    const valid = session.type === 'title'
      ? !!value
      : /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + 'T00:00:00').getTime());
    const previousValue = session.type === 'title' ? selected.event : selected.date;
    const nextValue = session.type === 'title' ? value.slice(0, 80) : value;
    if (!commit || !valid || nextValue === previousValue) {
      refreshSelectedMetadata(false);
      return;
    }
    const previous = cloneData();
    if (session.type === 'title') selected.event = nextValue;
    else selected.date = nextValue;
    state.data.event = selected.event;
    state.data.date = selected.date;
    refreshSelectedMetadata(session.type === 'date');
    save(previous);
  }

  function beginInlineEdit(type) {
    const selected = selectedEvent();
    if (!selected || !editorMask.hidden || state.leaving) return;
    if (state.inlineEdit) {
      if (state.inlineEdit.type === type) {
        state.inlineEdit.input.focus();
        state.inlineEdit.input.select();
        return;
      }
      finishInlineEdit(true);
    }
    const target = type === 'title' ? titleDisplay : dateDisplay;
    const input = document.createElement('input');
    input.className = 'countdown-inline-input countdown-inline-' + type;
    input.type = type === 'title' ? 'text' : 'date';
    input.value = type === 'title' ? selected.event : selected.date;
    input.setAttribute('aria-label', text(type === 'title' ? 'eventName' : 'targetDate'));
    input.autocomplete = 'off';
    if (type === 'title') input.maxLength = 80;
    else input.step = '1';
    target.classList.add('is-editing');
    target.removeAttribute('role');
    target.removeAttribute('tabindex');
    target.removeAttribute('title');
    target.removeAttribute('aria-label');
    target.replaceChildren(input);
    const session = { type, target, input, eventId: selected.id, finishing: false };
    state.inlineEdit = session;
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finishInlineEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finishInlineEdit(false);
        target.focus();
      }
    });
    input.addEventListener('blur', () => finishInlineEdit(true), { once: true });
    input.focus({ preventScroll: true });
    input.select();
  }

  function resetDeleteArm() {
    state.deleteArmed = false;
    window.clearTimeout(state.deleteTimer);
    const button = document.querySelector('[data-countdown-delete]');
    button.textContent = text('delete');
    button.classList.remove('is-armed');
  }

  function updateFocusControls() {
    const expandLabel = document.querySelector('[data-countdown-focus-label]');
    const exitLabel = document.querySelector('[data-countdown-focus-exit-label]');
    if (expandLabel) expandLabel.textContent = text('expand');
    if (exitLabel) exitLabel.textContent = text('exitExpand');
    focusButton.setAttribute('aria-label', text('expand'));
    focusButton.removeAttribute('title');
    focusButton.setAttribute('aria-pressed', String(state.focusMode));
    focusExit.setAttribute('aria-label', text('exitExpand'));
    focusExit.removeAttribute('title');
    focusExit.setAttribute('aria-hidden', String(!state.focusMode));
    focusExit.tabIndex = state.focusMode ? 0 : -1;
  }

  function setFocusMode(enabled, restoreFocus) {
    const next = !!enabled && !!selectedEvent();
    if (state.focusMode === next) return;
    finishInlineEdit(true);
    if (next && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    state.focusMode = next;
    document.body.classList.toggle('countdown-focus-mode', next);
    [topBar, eventsPanel, stageHead].forEach((region) => {
      region.toggleAttribute('inert', next);
      region.setAttribute('aria-hidden', String(next));
    });
    updateFocusControls();
    if (!next && restoreFocus) {
      requestAnimationFrame(() => focusButton.focus({ preventScroll: true }));
    }
  }

  function openEditor(id) {
    finishInlineEdit(true);
    resetDeleteArm();
    const item = id ? state.data.events.find((event) => event.id === id) : null;
    state.editingId = item ? item.id : '';
    form.elements.event.value = item ? item.event : '';
    const future = new Date();
    future.setDate(future.getDate() + 30);
    form.elements.date.value = item ? item.date : future.getFullYear() + '-'
      + String(future.getMonth() + 1).padStart(2, '0') + '-' + String(future.getDate()).padStart(2, '0');
    document.querySelector('[data-countdown-editor-title]').textContent = text(item ? 'editTitle' : 'newTitle');
    document.querySelector('[data-countdown-delete]').hidden = !item;
    editorMask.hidden = false;
    requestAnimationFrame(() => {
      editorMask.classList.add('is-visible');
      form.elements.event.focus();
      form.elements.event.select();
    });
  }

  function closeEditor(immediate) {
    if (editorMask.hidden) return;
    resetDeleteArm();
    editorMask.classList.remove('is-visible');
    const finish = () => {
      editorMask.hidden = true;
      state.editingId = '';
    };
    if (immediate || reducedMotion) finish();
    else window.setTimeout(finish, 220);
  }

  function deleteEditingEvent() {
    if (!state.editingId) return;
    const button = document.querySelector('[data-countdown-delete]');
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      button.textContent = text('deleteAgain');
      button.classList.add('is-armed');
      state.deleteTimer = window.setTimeout(resetDeleteArm, 2400);
      return;
    }
    const previous = cloneData();
    state.data.events = state.data.events.filter((item) => item.id !== state.editingId);
    const selected = state.data.events[0] || null;
    state.data.selectedId = selected ? selected.id : '';
    state.data.event = selected ? selected.event : '';
    state.data.date = selected ? selected.date : '';
    closeEditor(true);
    render({ immediate: true });
    save(previous);
  }

  function applyLanguage() {
    document.documentElement.lang = language();
    document.title = (language() === 'en' ? 'Countdown · Relatum' : '倒数日 · Relatum');
    document.querySelectorAll('[data-copy]').forEach((element) => {
      element.textContent = text(element.dataset.copy);
    });
    document.querySelector('[data-countdown-back]').setAttribute('aria-label', text('back'));
    document.querySelector('[data-countdown-new]').setAttribute('aria-label', text('newTitle'));
    if (!wallpaperMode) {
      restoreInlineTarget(titleDisplay);
      restoreInlineTarget(dateDisplay);
    }
    updateFocusControls();
    updateWallpaperButton();
    if (!editorMask.hidden) {
      document.querySelector('[data-countdown-editor-title]').textContent = text(state.editingId ? 'editTitle' : 'newTitle');
    }
    render({ immediate: true });
  }

  function leave() {
    if (state.leaving) return;
    state.leaving = true;
    window.clearTimeout(state.timer);
    document.body.classList.add('is-leaving');
    const params = new URLSearchParams(window.location.search);
    const destination = 'index.html?view=calendar' + (params.get('desktop') === '1' ? '&desktop=1' : '');
    window.setTimeout(() => { window.location.href = destination; }, reducedMotion ? 0 : 240);
  }

  document.querySelectorAll('[data-countdown-new],[data-countdown-empty-new]').forEach((button) => {
    button.addEventListener('click', () => openEditor(''));
  });
  document.querySelector('[data-countdown-edit]').addEventListener('click', () => {
    const selected = selectedEvent();
    if (selected) openEditor(selected.id);
  });
  focusButton.addEventListener('click', () => setFocusMode(true));
  focusExit.addEventListener('click', () => setFocusMode(false, true));
  wallpaperButton.addEventListener('click', toggleDesktopWallpaper);
  titleDisplay.addEventListener('dblclick', () => beginInlineEdit('title'));
  dateDisplay.addEventListener('dblclick', () => beginInlineEdit('date'));
  [titleDisplay, dateDisplay].forEach((target) => {
    target.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'F2') return;
      event.preventDefault();
      beginInlineEdit(target === titleDisplay ? 'title' : 'date');
    });
  });
  document.querySelectorAll('[data-countdown-editor-close]').forEach((button) => {
    button.addEventListener('click', () => closeEditor());
  });
  editorMask.addEventListener('pointerdown', (event) => {
    if (event.target === editorMask) closeEditor();
  });
  document.querySelector('[data-countdown-delete]').addEventListener('click', deleteEditingEvent);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = form.elements.event.value.trim();
    const date = form.elements.date.value;
    if (!name) { form.elements.event.focus(); return; }
    if (!date) { form.elements.date.focus(); return; }
    const previous = cloneData();
    let item = state.editingId ? state.data.events.find((candidate) => candidate.id === state.editingId) : null;
    if (item) {
      item.event = name.slice(0, 80);
      item.date = date;
    } else {
      item = { id: eventId(), event: name.slice(0, 80), date };
      state.data.events.push(item);
    }
    state.data.selectedId = item.id;
    state.data.event = item.event;
    state.data.date = item.date;
    closeEditor(true);
    render({ immediate: true });
    save(previous);
  });
  document.querySelector('[data-countdown-back]').addEventListener('click', leave);
  document.addEventListener('keydown', (event) => {
    if (wallpaperMode) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!editorMask.hidden) closeEditor();
      else if (state.focusMode) setFocusMode(false, true);
      else leave();
      return;
    }
    if (event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey
        || event.key.toLowerCase() !== 'f' || !editorMask.hidden || state.inlineEdit || state.leaving) return;
    const target = event.target;
    if (target instanceof HTMLElement
        && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (!selectedEvent()) return;
    event.preventDefault();
    setFocusMode(!state.focusMode, false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !wallpaperMode) {
      window.clearTimeout(state.timer);
      state.timer = 0;
      window.clearTimeout(state.wallpaperSyncTimer);
      state.wallpaperSyncTimer = 0;
    } else {
      scheduleClock();
      scheduleWallpaperSync(0);
    }
  });
  window.addEventListener('pagehide', () => {
    window.clearTimeout(state.timer);
    window.clearTimeout(state.wallpaperSyncTimer);
  });
  window.addEventListener('pageshow', () => {
    if (state.loaded) {
      scheduleClock();
      scheduleWallpaperSync(0);
    }
  });

  fetch('/api/countdown').then(async (response) => {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || text('loadFailed'));
    if (wallpaperMode) {
      const events = Array.isArray(payload && payload.events) ? payload.events : [];
      if (!events.some((item) => item && String(item.id || '') === wallpaperEventId)) {
        state.data = normalize({ events: [], selectedId: '' });
        state.loaded = true;
        render({ immediate: true });
        notifyWallpaperMissing();
        return;
      }
    }
    state.data = normalize(payload, wallpaperMode ? wallpaperEventId : '');
    state.loaded = true;
    render({ immediate: true });
    if (wallpaperMode) {
      const selected = selectedEvent();
      if (selected) callWallpaperApi('update_countdown_wallpaper_event', selected.id, selected.event);
      scheduleWallpaperSync(3000);
    } else {
      refreshWallpaperState();
    }
  }).catch((error) => {
    if (wallpaperMode) {
      state.loaded = false;
      scheduleWallpaperSync(1200);
      return;
    }
    state.loaded = true;
    showToast(text('loadFailed') + ' · ' + error.message);
    render({ immediate: true });
  });

  if (window.RelatumI18n && window.RelatumI18n.onChange) {
    window.RelatumI18n.onChange(applyLanguage);
  }
  applyLanguage();
  window.addEventListener('DOMContentLoaded', applyLanguage, { once: true });
  requestAnimationFrame(() => document.body.classList.add('is-ready'));
})();

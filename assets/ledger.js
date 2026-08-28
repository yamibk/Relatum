(function () {
  'use strict';

  const root = document.querySelector('[data-role="ledger-shell"]');
  if (!root) return;
  const pageHost = root.closest('.calendar-embedded') || root;

  const LEGEND_KEY = 'ledger:legend:v1';
  const PAGE_KEY = 'ledger:page:v1';
  const VIEW_KEY = 'ledger:view:v1';
  const DRAFT_ID = 'ledger-local-draft';
  const PAGE_MAX = 99;
  const PAGE_EDGE_PX = 84;
  const CACHE_MAX = 24;
  const reducedMotion = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (error) { return false; }
  })();
  const now = new Date();
  const initialPage = loadCurrentPage();
  const state = {
    active: false, activatedOnce: false, mounted: false,
    year: now.getFullYear(), month: now.getMonth() + 1, page: initialPage, highestPage: 1,
    viewMode: loadViewMode(),
    payload: null, draft: null, cache: new Map(),
    requestSeq: 0, controller: null, prefetching: new Map(),
    prefetchHandle: 0, prefetchUsesIdle: false,
    warmupHandle: 0, warmupUsesIdle: false, warmupKey: '', warmupController: null, warmupPromise: null,
    settings: null, settingsPopover: null, settingsTrigger: null,
    settingsPositionFrame: 0, deleteTimer: 0,
    unitPopover: null, unitTrigger: null, unitSaving: false,
    highlightId: '', entranceAnimations: [], exitFrozen: false,
    monthMotionTimer: 0, mutationSeq: new Map(), mutationChains: new Map(),
    pageRailOver: false, pageRailVisible: false, pageWheelAccum: 0, pageWheelTimer: 0,
    pageOrbSettleUntil: 0,
  };
  const dom = {};
  let legendColors = loadLegend();
  const paletteController = window.RelatumStudyPalette
    && typeof window.RelatumStudyPalette.createPopoverController === 'function'
    ? window.RelatumStudyPalette.createPopoverController({ reducedMotion, translate: T })
    : null;

  function T(value) {
    return window.RelatumI18n ? window.RelatumI18n.t(value) : value;
  }

  function monthKey(year, month) {
    return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
  }

  function normalizePage(value) {
    const page = Number(value);
    return Number.isInteger(page) && page >= 1 && page <= PAGE_MAX ? page : 1;
  }

  function loadCurrentPage() {
    try { return normalizePage(localStorage.getItem(PAGE_KEY)); }
    catch (error) { return 1; }
  }

  function saveCurrentPage() {
    try { localStorage.setItem(PAGE_KEY, String(state.page)); }
    catch (error) {}
  }

  function normalizeViewMode(value) {
    return value === 'cumulative' ? 'cumulative' : 'month';
  }

  function loadViewMode() {
    try { return normalizeViewMode(localStorage.getItem(VIEW_KEY)); }
    catch (error) { return 'month'; }
  }

  function saveViewMode() {
    try { localStorage.setItem(VIEW_KEY, state.viewMode); }
    catch (error) {}
  }

  function ledgerCacheKey(year, month, page, viewMode) {
    const view = normalizeViewMode(viewMode == null ? state.viewMode : viewMode);
    return (view === 'cumulative' ? 'all' : monthKey(year, month)) + '@' + normalizePage(page);
  }

  function ledgerUrl(year, month, page, viewMode) {
    const view = normalizeViewMode(viewMode == null ? state.viewMode : viewMode);
    return '/api/ledger?year=' + year + '&month=' + month + '&page=' + normalizePage(page)
      + (view === 'cumulative' ? '&scope=all' : '');
  }

  function dateParts(day) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!match) return null;
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const value = new Date(parts.year, parts.month - 1, parts.day);
    return value.getFullYear() === parts.year && value.getMonth() + 1 === parts.month
      && value.getDate() === parts.day ? parts : null;
  }

  function currentMonthDefaultDate(year, month) {
    const today = new Date();
    const last = new Date(year, month, 0).getDate();
    const day = Math.min(today.getDate(), last);
    return monthKey(year, month) + '-' + String(day).padStart(2, '0');
  }

  function shiftedMonth(year, month, delta) {
    const value = new Date(year, month - 1 + delta, 1);
    return { year: value.getFullYear(), month: value.getMonth() + 1 };
  }

  function monthFromDay(day) {
    const parts = dateParts(day);
    return parts ? { year: parts.year, month: parts.month } : null;
  }

  function monthTitle() {
    if (document.documentElement.dataset.uiLanguage === 'en') {
      return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' })
        .format(new Date(state.year, state.month - 1, 1));
    }
    return state.year + ' 年 ' + state.month + ' 月';
  }

  function formatDayHeading(day) {
    const parts = dateParts(day);
    if (!parts) return day;
    const locale = document.documentElement.dataset.uiLanguage === 'en' ? 'en-US' : 'zh-CN';
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' })
      .format(new Date(parts.year, parts.month - 1, parts.day));
  }

  function currentUnit() {
    return state.payload && typeof state.payload.unit === 'string' ? state.payload.unit : '';
  }

  function formatMoney(cents, signed, unit) {
    const value = Number(cents) || 0;
    const locale = document.documentElement.dataset.uiLanguage === 'en' ? 'en-US' : 'zh-CN';
    const formatted = (Math.abs(value) / 100).toLocaleString(locale, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    const sign = signed && value !== 0 ? (value < 0 ? '−' : '+') : (value < 0 ? '−' : '');
    const customUnit = typeof unit === 'string' ? unit : currentUnit();
    return customUnit ? sign + formatted + customUnit : sign + '¥' + formatted;
  }

  function amountInputValue(cents) {
    return Number.isInteger(cents) && cents > 0 ? (cents / 100).toFixed(2) : '';
  }

  function parseAmountCents(value) {
    const raw = String(value || '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error(T('请输入有效金额，最多两位小数'));
    const parts = raw.split('.');
    const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(T('请输入大于零的有效金额'));
    return cents;
  }

  function multiplierInputValue(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0 ? String(Number(value)) : '';
  }

  function parseMultiplier(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) throw new Error(T('请输入有效倍率，最多四位小数'));
    const multiplier = Number(raw);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1000000) {
      throw new Error(T('倍率必须大于零且不超过 1000000'));
    }
    return multiplier;
  }

  function effectiveAmountCents(entry) {
    const amount = Number(entry && entry.amountCents) || 0;
    const multiplier = Number(entry && entry.multiplier);
    const result = Math.round(amount * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1));
    return Number.isSafeInteger(result) && result > 0 ? result : 0;
  }

  function emptyPayload(year, month, page, viewMode) {
    const view = normalizeViewMode(viewMode == null ? state.viewMode : viewMode);
    return { version: 1, year, month, page: normalizePage(page), highestPage: state.highestPage,
      scope: view === 'cumulative' ? 'all' : 'month', unit: '',
      summary: { incomeCents: 0, expenseCents: 0, balanceCents: 0, count: 0 }, entries: [] };
  }

  function clonePayload(payload) { return JSON.parse(JSON.stringify(payload)); }

  function normalizePayload(payload) {
    const result = payload || emptyPayload(state.year, state.month, state.page);
    result.entries = Array.isArray(result.entries) ? result.entries : [];
    result.entries.sort((left, right) => String(right.date).localeCompare(String(left.date))
      || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      || String(right.id).localeCompare(String(left.id)));
    let incomeCents = 0;
    let expenseCents = 0;
    result.entries.forEach((entry) => {
      if (entry.type === 'income') incomeCents += effectiveAmountCents(entry);
      else expenseCents += effectiveAmountCents(entry);
    });
    result.summary = { incomeCents, expenseCents,
      balanceCents: incomeCents - expenseCents, count: result.entries.length };
    return result;
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || T('账本同步失败'));
    return json;
  }

  function post(path, body) {
    return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  }

  function postInOrder(id, path, body) {
    const previous = state.mutationChains.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => post(path, body));
    state.mutationChains.set(id, next);
    next.finally(() => {
      if (state.mutationChains.get(id) === next) state.mutationChains.delete(id);
    }).catch(() => {});
    return next;
  }

  function showToast(message) {
    const toast = document.querySelector('[data-role="study-toast"]')
      || document.querySelector('[data-role="toast"]');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function loadLegend() {
    const fallback = ['', '', '', ''];
    try {
      const raw = JSON.parse(localStorage.getItem(LEGEND_KEY) || 'null');
      if (!raw || raw.version !== 1 || !Array.isArray(raw.colors) || raw.colors.length !== 4) return fallback;
      return raw.colors.map((color) => typeof color === 'string'
        && (color === '' || /^#[0-9a-fA-F]{6}$/.test(color)) ? color.toLowerCase() : '');
    } catch (error) { return fallback; }
  }

  function saveLegend() {
    try { localStorage.setItem(LEGEND_KEY, JSON.stringify({ version: 1, colors: legendColors })); }
    catch (error) {}
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    const template = document.createElement('template');
    template.innerHTML = '<div class="ledger-page">'
      + '<header class="ledger-head"><div><p class="study-eyebrow">LEDGER</p><h1 data-ledger-title></h1></div>'
      + '<div class="ledger-head-actions"><div class="ledger-legend" data-ledger-legend></div>'
      + '<div class="ledger-month-nav" data-ledger-month-nav>'
      + '<button type="button" data-ledger-month="-1">‹</button><strong aria-live="polite" data-ledger-month-title></strong>'
      + '<button type="button" data-ledger-month="1">›</button></div>'
      + '<button type="button" class="ledger-page-settings" data-ledger-page-settings aria-haspopup="dialog">…</button>'
      + '<button type="button" class="ledger-add" data-ledger-add><span aria-hidden="true">＋</span><span data-ledger-add-label></span></button>'
      + '</div></header><section class="ledger-summary" data-ledger-summary></section>'
      + '<main class="ledger-flow"><section class="ledger-groups" data-ledger-groups></section>'
      + '<section class="ledger-empty" data-ledger-empty><span aria-hidden="true">¥</span><strong></strong><p></p></section>'
      + '</main></div>'
      + '<nav class="study-task-page-rail ledger-page-rail auto-hide" data-ledger-page-rail>'
      + '<span class="study-task-page-orb" data-ledger-page-orb aria-hidden="true"></span>'
      + '<div class="study-task-page-scroll" data-ledger-page-scroll>'
      + '<div class="study-task-page-list" data-ledger-page-list></div></div></nav>';
    root.appendChild(template.content);
    dom.page = root.querySelector('.ledger-page');
    dom.title = root.querySelector('[data-ledger-title]');
    dom.legend = root.querySelector('[data-ledger-legend]');
    dom.monthNav = root.querySelector('[data-ledger-month-nav]');
    dom.monthTitle = root.querySelector('[data-ledger-month-title]');
    dom.add = root.querySelector('[data-ledger-add]');
    dom.pageSettings = root.querySelector('[data-ledger-page-settings]');
    dom.addLabel = root.querySelector('[data-ledger-add-label]');
    dom.summary = root.querySelector('[data-ledger-summary]');
    dom.flow = root.querySelector('.ledger-flow');
    dom.groups = root.querySelector('[data-ledger-groups]');
    dom.empty = root.querySelector('[data-ledger-empty]');
    dom.pageRail = root.querySelector('[data-ledger-page-rail]');
    dom.pageOrb = root.querySelector('[data-ledger-page-orb]');
    dom.pageScroll = root.querySelector('[data-ledger-page-scroll]');
    dom.pageList = root.querySelector('[data-ledger-page-list]');
    buildLegend(); buildSummaryCards(); bindControls(); renderPageRail(); syncLanguage();
  }

  function buildLegend() {
    for (let index = 0; index < 4; index += 1) {
      const chip = document.createElement('span');
      chip.className = 'ledger-legend-chip';
      chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      chip.dataset.ledgerLegendIndex = String(index);
      dom.legend.appendChild(chip);
    }
    syncLegend();
  }

  function syncLegend() {
    dom.legend.querySelectorAll('[data-ledger-legend-index]').forEach((chip) => {
      const index = Number(chip.dataset.ledgerLegendIndex);
      const color = legendColors[index] || '';
      chip.classList.toggle('is-default', !color);
      if (color) chip.style.setProperty('--ledger-legend-color', color);
      else chip.style.removeProperty('--ledger-legend-color');
      chip.setAttribute('aria-label', T('图例色') + ' ' + (index + 1));
    });
  }

  function buildSummaryCards() {
    ['balance', 'income', 'expense'].forEach((kind, index) => {
      const card = document.createElement('article');
      card.className = 'ledger-summary-card ledger-summary-' + kind;
      card.dataset.ledgerSummaryKind = kind;
      card.style.setProperty('--ledger-stagger', (index * 34) + 'ms');
      card.append(document.createElement('span'), document.createElement('strong'), document.createElement('small'));
      dom.summary.appendChild(card);
    });
  }

  function syncLanguage() {
    dom.title.textContent = T('记账');
    dom.addLabel.textContent = T('记一笔');
    dom.pageSettings.setAttribute('aria-label', T('设置当前账本页'));
    dom.legend.setAttribute('aria-label', T('颜色图例'));
    dom.monthNav.setAttribute('aria-label', T('账本月份'));
    const monthButtons = dom.monthNav.querySelectorAll('[data-ledger-month]');
    monthButtons[0].setAttribute('aria-label', T('上个月'));
    monthButtons[1].setAttribute('aria-label', T('下个月'));
    dom.summary.setAttribute('aria-label', T(state.viewMode === 'cumulative' ? '累计汇总' : '本月汇总'));
    dom.empty.querySelector('strong').textContent = T(state.viewMode === 'cumulative'
      ? '这一页还没有账目' : '这个月还没有账目');
    dom.empty.querySelector('p').textContent = T('点击右上角记下第一笔收支。');
    dom.pageRail.setAttribute('aria-label', T('账本页面切换'));
    syncLegend(); renderPageRail(); syncLedger({ skipFlip: true });
  }

  function syncViewMode() {
    const cumulative = state.viewMode === 'cumulative';
    root.classList.toggle('ledger-cumulative-view', cumulative);
    dom.monthNav.hidden = cumulative;
    dom.summary.setAttribute('aria-label', T(cumulative ? '累计汇总' : '本月汇总'));
    dom.empty.querySelector('strong').textContent = T(cumulative
      ? '这一页还没有账目' : '这个月还没有账目');
  }

  function pageRailCapacity() {
    if (!dom.pageScroll) return 3;
    return Math.max(3, Math.floor((dom.pageScroll.clientHeight + 6) / 40));
  }

  function createPageButton(page) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'study-task-page-button' + (page === state.page ? ' is-active' : '');
    button.dataset.ledgerPage = String(page);
    button.textContent = String(page);
    button.setAttribute('aria-label', T('账本第 {page} 页').replace('{page}', page));
    if (page === state.page) button.setAttribute('aria-current', 'page');
    return button;
  }

  function scrollActivePageIntoView(button) {
    if (!button || !dom.pageScroll) return;
    const top = button.offsetTop; const bottom = top + button.offsetHeight;
    if (top < dom.pageScroll.scrollTop) dom.pageScroll.scrollTop = top;
    else if (bottom > dom.pageScroll.scrollTop + dom.pageScroll.clientHeight) {
      dom.pageScroll.scrollTop = bottom - dom.pageScroll.clientHeight;
    }
  }

  function positionPageOrb(fromScroll) {
    if (!dom.pageRail || !dom.pageOrb) return;
    if (fromScroll && performance.now() < state.pageOrbSettleUntil) return;
    const active = dom.pageRail.querySelector('.study-task-page-button.is-active');
    if (!active) { dom.pageOrb.style.opacity = '0'; return; }
    const railRect = dom.pageRail.getBoundingClientRect();
    const buttonRect = active.getBoundingClientRect();
    const visible = buttonRect.bottom > railRect.top && buttonRect.top < railRect.bottom;
    dom.pageOrb.style.opacity = visible ? '1' : '0';
    dom.pageOrb.style.transform = 'translate3d(0,' + (buttonRect.top - railRect.top) + 'px,0)';
  }

  function renderPageRail() {
    if (!dom.pageList) return;
    const focusedPage = dom.pageRail.contains(document.activeElement)
      && document.activeElement.dataset ? document.activeElement.dataset.ledgerPage : '';
    const total = Math.min(PAGE_MAX, Math.max(pageRailCapacity(), state.page, state.highestPage));
    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= total; page += 1) fragment.appendChild(createPageButton(page));
    dom.pageList.replaceChildren(fragment);
    const active = dom.pageList.querySelector('.study-task-page-button.is-active');
    scrollActivePageIntoView(active);
    if (focusedPage) {
      const focusTarget = dom.pageList.querySelector('[data-ledger-page="' + focusedPage + '"]') || active;
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
    const orbMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--start-orb-ms')) || 239;
    window.requestAnimationFrame(() => {
      state.pageOrbSettleUntil = performance.now() + orbMs + 10;
      positionPageOrb(false);
      window.setTimeout(() => positionPageOrb(false), orbMs + 20);
    });
  }

  function setPageRailVisible(visible) {
    if (!dom.pageRail) return;
    state.pageRailVisible = !!visible && state.active;
    dom.pageRail.classList.toggle('revealed', state.pageRailVisible);
  }

  function acceptHighestPage(payload) {
    if (!payload) return;
    state.highestPage = normalizePage(payload.highestPage);
    renderPageRail();
  }

  function syncSummary() {
    const summary = state.payload ? state.payload.summary : emptyPayload(state.year, state.month, state.page).summary;
    const values = {
      balance: [T(state.viewMode === 'cumulative' ? '总结余' : '结余'), summary.balanceCents,
        summary.count + ' ' + T('笔记录')],
      income: [T(state.viewMode === 'cumulative' ? '总收入' : '收入'), summary.incomeCents,
        state.viewMode === 'cumulative' ? '' : monthTitle()],
      expense: [T(state.viewMode === 'cumulative' ? '总支出' : '支出'), summary.expenseCents,
        state.viewMode === 'cumulative' ? '' : monthTitle()],
    };
    dom.summary.querySelectorAll('[data-ledger-summary-kind]').forEach((card) => {
      const data = values[card.dataset.ledgerSummaryKind];
      const amount = card.querySelector('strong');
      card.querySelector('span').textContent = data[0];
      const nextAmount = formatMoney(data[1], false);
      if (amount.textContent !== nextAmount) {
        amount.textContent = nextAmount;
        replayClass(amount, 'ledger-summary-updated', 360);
      }
      card.querySelector('small').textContent = data[2];
    });
  }

  function displayEntries() {
    const entries = (state.payload && state.payload.entries || []).slice();
    if (state.draft) entries.push(state.draft);
    entries.sort((left, right) => String(right.date).localeCompare(String(left.date))
      || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      || String(right.id).localeCompare(String(left.id)));
    return entries;
  }

  function groupedEntries() {
    if (state.viewMode === 'cumulative') {
      const entries = displayEntries();
      return entries.length ? [{ day: 'cumulative', entries }] : [];
    }
    const groups = [];
    displayEntries().forEach((entry) => {
      let group = groups[groups.length - 1];
      if (!group || group.day !== entry.date) {
        group = { day: entry.date, entries: [] }; groups.push(group);
      }
      group.entries.push(entry);
    });
    return groups;
  }

  function captureEntryRects() {
    const result = new Map();
    dom.groups.querySelectorAll('[data-ledger-entry]').forEach((entry) => {
      result.set(entry.dataset.ledgerEntry, entry.getBoundingClientRect());
    });
    return result;
  }

  function animateEntryChanges(previous) {
    if (reducedMotion || !previous || !previous.size) return;
    dom.groups.querySelectorAll('[data-ledger-entry]').forEach((entry) => {
      const before = previous.get(entry.dataset.ledgerEntry);
      if (!before) return;
      const after = entry.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      entry.animate([{ transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' }],
      { duration: 260, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
    });
  }

  function replayClass(element, className, cleanupMs) {
    if (!element || reducedMotion) return;
    window.clearTimeout(element.__ledgerReplayTimer);
    element.classList.remove(className); void element.offsetWidth; element.classList.add(className);
    element.__ledgerReplayTimer = window.setTimeout(() => {
      element.classList.remove(className); element.__ledgerReplayTimer = 0;
    }, cleanupMs);
  }

  function createDayGroup(day) {
    const group = document.createElement('section');
    group.className = 'ledger-day-group'; group.dataset.ledgerDay = day;
    const header = document.createElement('header');
    header.append(document.createElement('strong'), document.createElement('span'));
    const rows = document.createElement('div'); rows.dataset.ledgerDayRows = '';
    group.append(header, rows); return group;
  }

  function createEntryRow(entry) {
    const row = document.createElement('article');
    row.className = 'ledger-entry'; row.setAttribute('role', 'button'); row.tabIndex = 0;
    const mark = document.createElement('span');
    mark.className = 'ledger-entry-mark'; mark.setAttribute('aria-hidden', 'true');
    const main = document.createElement('div'); main.className = 'ledger-entry-main';
    main.append(document.createElement('strong'), document.createElement('small'));
    const amount = document.createElement('b'); amount.className = 'ledger-entry-amount';
    const detail = document.createElement('span'); detail.className = 'ledger-entry-detail-group';
    const cue = document.createElement('span');
    cue.className = 'ledger-entry-detail-cue'; cue.setAttribute('aria-hidden', 'true'); cue.textContent = '›';
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'ledger-entry-menu'; menu.dataset.ledgerEntryMenu = '';
    menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-controls', 'ledger-settings-popover');
    menu.textContent = '⋯'; detail.append(cue, menu); row.append(mark, main, amount, detail);
    syncEntryRow(row, entry); return row;
  }

  function syncEntryRow(row, entry) {
    const income = entry.type === 'income';
    const draft = entry.id === DRAFT_ID;
    const label = income ? T('收入') : T('支出');
    const signedCents = income ? entry.amountCents : -entry.amountCents;
    const effectiveCents = effectiveAmountCents(entry);
    const signedEffectiveCents = income ? effectiveCents : -effectiveCents;
    row.dataset.ledgerEntry = entry.id;
    row.classList.toggle('ledger-entry-income', income);
    row.classList.toggle('ledger-entry-expense', !income);
    row.classList.toggle('is-draft', draft);
    row.classList.toggle('is-pending', !!entry.pending);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(entry.color || '')) ? entry.color : '';
    if (color) row.style.setProperty('--ledger-entry-color', color);
    else row.style.removeProperty('--ledger-entry-color');
    const amount = row.querySelector('.ledger-entry-amount');
    row.querySelector('.ledger-entry-main strong').textContent = entry.note
      || (draft ? T('待填写的账目') : label);
    row.querySelector('.ledger-entry-main small').textContent = draft ? T('本地草稿') + ' · ' + label : label;
    if (Number.isInteger(entry.amountCents) && entry.amountCents > 0) {
      const base = formatMoney(signedCents, true);
      amount.textContent = entry.multiplier == null
        ? base
        : base + ' × ' + multiplierInputValue(entry.multiplier) + ' = '
          + formatMoney(signedEffectiveCents, true);
    } else {
      amount.textContent = currentUnit() ? '—' + currentUnit() : '¥—';
    }
    row.setAttribute('aria-label', label + ' ' + amount.textContent + (entry.note ? ' · ' + entry.note : ''));
    const menu = row.querySelector('[data-ledger-entry-menu]');
    menu.setAttribute('aria-label', T('账目选项'));
    menu.setAttribute('aria-expanded', state.settings && state.settings.id === entry.id ? 'true' : 'false');
  }

  function syncEntries(options) {
    const opts = options || {};
    const previous = opts.previousRects || (opts.skipFlip ? null : captureEntryRects());
    const desiredIds = new Set(); const desiredDays = new Set();
    groupedEntries().forEach((groupData) => {
      desiredDays.add(groupData.day);
      let group = dom.groups.querySelector('[data-ledger-day="' + CSS.escape(groupData.day) + '"]');
      const newGroup = !group;
      if (!group) group = createDayGroup(groupData.day);
      const header = group.querySelector('header');
      header.hidden = state.viewMode === 'cumulative';
      header.querySelector('strong').textContent = state.viewMode === 'cumulative'
        ? '' : formatDayHeading(groupData.day);
      header.querySelector('span').textContent = state.viewMode === 'cumulative'
        ? '' : groupData.entries.length + ' ' + T('笔');
      const rows = group.querySelector('[data-ledger-day-rows]');
      groupData.entries.forEach((entry) => {
        desiredIds.add(entry.id);
        let row = dom.groups.querySelector('[data-ledger-entry="' + CSS.escape(entry.id) + '"]');
        const isNew = !row;
        if (!row) row = createEntryRow(entry); else syncEntryRow(row, entry);
        rows.appendChild(row);
        if (isNew || opts.newIds && opts.newIds.has(entry.id)) replayClass(row, 'quick-enter', 320);
      });
      dom.groups.appendChild(group);
      if (newGroup) replayClass(group, 'ledger-day-entering', 320);
    });
    dom.groups.querySelectorAll('[data-ledger-entry]').forEach((row) => {
      if (!desiredIds.has(row.dataset.ledgerEntry)) row.remove();
    });
    dom.groups.querySelectorAll('[data-ledger-day]').forEach((group) => {
      if (!desiredDays.has(group.dataset.ledgerDay)) group.remove();
    });
    const hasEntries = desiredIds.size > 0;
    dom.groups.hidden = !hasEntries; dom.empty.hidden = hasEntries;
    window.requestAnimationFrame(() => animateEntryChanges(previous));
    revealHighlightedEntry();
  }

  function syncLedger(options) {
    if (!state.mounted) return;
    syncViewMode(); dom.monthTitle.textContent = monthTitle();
    dom.empty.querySelector('span').textContent = currentUnit() || '¥';
    syncSummary(); syncEntries(options);
  }

  function revealHighlightedEntry() {
    if (!state.highlightId) return;
    const highlighted = dom.groups.querySelector('[data-ledger-entry="' + CSS.escape(state.highlightId) + '"]');
    if (!highlighted) return;
    state.highlightId = '';
    highlighted.classList.add('is-highlighted');
    highlighted.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    window.setTimeout(() => highlighted.classList.remove('is-highlighted'), reducedMotion ? 0 : 900);
  }

  function trimCache() {
    if (state.cache.size <= CACHE_MAX) return;
    const preserve = ledgerCacheKey(state.year, state.month, state.page);
    for (const key of state.cache.keys()) {
      if (state.cache.size <= CACHE_MAX) break;
      if (key !== preserve) state.cache.delete(key);
    }
  }

  function absorbMonths(months) {
    if (!months || typeof months !== 'object') return;
    let highestPage = null;
    Object.keys(months).forEach((month) => {
      const payload = months[month];
      if (payload && Array.isArray(payload.entries) && payload.summary) {
        state.cache.set(ledgerCacheKey(payload.year, payload.month, payload.page, 'month'), payload);
        highestPage = normalizePage(payload.highestPage);
      }
    });
    if (highestPage !== null) {
      state.cache.forEach((cached) => { cached.highestPage = highestPage; });
      acceptHighestPage({ highestPage });
    }
    trimCache();
  }

  function absorbMutation(result) {
    absorbMonths(result && result.months);
    const cumulative = result && result.cumulative;
    if (cumulative && Array.isArray(cumulative.entries) && cumulative.summary) {
      state.cache.set(ledgerCacheKey(cumulative.year, cumulative.month, cumulative.page, 'cumulative'), cumulative);
      state.cache.forEach((cached) => { cached.highestPage = cumulative.highestPage; });
      acceptHighestPage(cumulative); trimCache();
    }
  }

  function currentCachePayload() {
    const key = ledgerCacheKey(state.year, state.month, state.page);
    const current = state.payload;
    const currentMatches = current && Number(current.year) === state.year
      && (state.viewMode === 'cumulative' || Number(current.month) === state.month)
      && normalizePage(current.page) === state.page
      && String(current.scope || 'month') === (state.viewMode === 'cumulative' ? 'all' : 'month');
    state.payload = state.cache.get(key) || (currentMatches ? current : null)
      || emptyPayload(state.year, state.month, state.page);
    return state.payload;
  }

  function cancelMainRequest() {
    if (state.controller) state.controller.abort();
    state.controller = null; state.requestSeq += 1;
  }

  function cancelPrefetch() {
    if (state.prefetchHandle) {
      if (state.prefetchUsesIdle && 'cancelIdleCallback' in window) window.cancelIdleCallback(state.prefetchHandle);
      else window.clearTimeout(state.prefetchHandle);
    }
    state.prefetchHandle = 0;
    state.prefetching.forEach((controller) => controller.abort()); state.prefetching.clear();
  }

  function prefetchMonth(year, month) {
    if (!state.active || state.viewMode === 'cumulative') return;
    const page = state.page; const key = ledgerCacheKey(year, month, page, 'month');
    if (state.cache.has(key) || state.prefetching.has(key)) return;
    const controller = new AbortController(); state.prefetching.set(key, controller);
    request(ledgerUrl(year, month, page, 'month'), { signal: controller.signal })
      .then((payload) => { state.cache.set(key, payload); trimCache(); }).catch(() => {})
      .finally(() => { if (state.prefetching.get(key) === controller) state.prefetching.delete(key); });
  }

  function scheduleNeighborPrefetch() {
    cancelPrefetch();
    if (state.viewMode === 'cumulative') return;
    const run = () => {
      state.prefetchHandle = 0;
      if (!state.active) return;
      const previous = shiftedMonth(state.year, state.month, -1);
      const next = shiftedMonth(state.year, state.month, 1);
      prefetchMonth(previous.year, previous.month); prefetchMonth(next.year, next.month);
    };
    state.prefetchUsesIdle = 'requestIdleCallback' in window;
    state.prefetchHandle = state.prefetchUsesIdle
      ? window.requestIdleCallback(run, { timeout: 1200 }) : window.setTimeout(run, 220);
  }

  function loadMonth(year, month, options) {
    const opts = options || {}; const page = state.page;
    const viewMode = state.viewMode;
    const key = ledgerCacheKey(year, month, page, viewMode);
    const cached = opts.force ? null : state.cache.get(key);
    state.year = year; state.month = month; state.payload = cached || emptyPayload(year, month, page);
    if (cached) acceptHighestPage(cached);
    root.classList.toggle('is-loading', !cached);
    if (opts.sync !== false) syncLedger({ skipFlip: !!opts.skipFlip });
    if (!cached && state.warmupHandle && state.warmupKey === key) {
      if (state.warmupUsesIdle && 'cancelIdleCallback' in window) window.cancelIdleCallback(state.warmupHandle);
      else window.clearTimeout(state.warmupHandle);
      state.warmupHandle = 0;
    }
    if (!cached && state.warmupPromise && state.warmupKey === key) {
      const warmupPromise = state.warmupPromise;
      const requestId = ++state.requestSeq;
      return warmupPromise.then((payload) => {
        if (!payload || requestId !== state.requestSeq) return null;
        state.cache.set(key, payload); trimCache();
        if (state.year === year && state.month === month && state.page === page && state.viewMode === viewMode) {
          state.payload = payload; root.classList.remove('is-loading'); acceptHighestPage(payload); syncLedger();
        }
        scheduleNeighborPrefetch();
        return payload;
      });
    }
    const requestId = ++state.requestSeq;
    if (state.controller) state.controller.abort();
    const controller = new AbortController(); state.controller = controller;
    return request(ledgerUrl(year, month, page, viewMode), { signal: controller.signal })
      .then((payload) => {
        if (requestId !== state.requestSeq) return null;
        state.cache.set(key, payload); trimCache();
        if (state.year === year && state.month === month && state.page === page && state.viewMode === viewMode) {
          state.payload = payload; root.classList.remove('is-loading'); acceptHighestPage(payload); syncLedger();
        }
        scheduleNeighborPrefetch(); return payload;
      }).catch((error) => {
        if (error && error.name === 'AbortError') return null;
        if (requestId === state.requestSeq) { root.classList.remove('is-loading'); showToast(error.message); }
        return null;
      }).finally(() => { if (requestId === state.requestSeq) state.controller = null; });
  }

  function createDraft() {
    if (state.draft) {
      const existing = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
      if (existing) {
        existing.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        existing.focus({ preventScroll: true }); replayClass(existing, 'ledger-entry-attention', 420);
      }
      return;
    }
    const previous = captureEntryRects();
    const today = new Date();
    state.draft = { id: DRAFT_ID, type: 'expense', amountCents: null, multiplier: null,
      ledgerPage: state.page, date: state.viewMode === 'cumulative'
        ? monthKey(today.getFullYear(), today.getMonth() + 1) + '-' + String(today.getDate()).padStart(2, '0')
        : currentMonthDefaultDate(state.year, state.month), note: '', color: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    syncEntries({ previousRects: previous, newIds: new Set([DRAFT_ID]) });
    window.requestAnimationFrame(() => {
      const row = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
        row.focus({ preventScroll: true });
      }
    });
  }

  function discardDraft(options) {
    if (!state.draft) return;
    if (state.settings && state.settings.id === DRAFT_ID) closeSettings(false, true);
    const row = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
    const previous = captureEntryRects(); state.draft = null;
    if (options && options.instant || reducedMotion || !row) {
      syncEntries({ previousRects: previous }); return;
    }
    row.classList.add('is-leaving');
    window.setTimeout(() => syncEntries({ previousRects: previous }), 300);
  }

  function findEntry(id) {
    if (id === DRAFT_ID) return state.draft;
    return (state.payload && state.payload.entries || []).find((entry) => entry.id === id) || null;
  }

  function buildSettingsField(labelText, type, role, value, placeholder) {
    const label = document.createElement('label'); label.className = 'ledger-settings-field';
    const labelSpan = document.createElement('span'); labelSpan.textContent = labelText;
    const input = document.createElement('input');
    input.type = type; input.value = value; input.placeholder = placeholder; input.autocomplete = 'off';
    input.dataset[role] = '';
    if (role === 'ledgerAmount' || role === 'ledgerMultiplier') input.inputMode = 'decimal';
    label.append(labelSpan, input); return label;
  }

  function buildSettings(entry) {
    const draft = entry.id === DRAFT_ID;
    const box = document.createElement('form');
    box.id = 'ledger-settings-popover';
    box.className = 'study-progress-settings-popover ledger-settings-popover';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', draft ? T('新账目') : T('账目选项'));
    const title = document.createElement('strong');
    title.className = 'study-progress-settings-title'; title.textContent = draft ? T('新账目') : T('编辑账目');
    const fields = document.createElement('div'); fields.className = 'ledger-settings-fields';
    const type = document.createElement('div');
    type.className = 'ledger-type-switch'; type.setAttribute('role', 'group'); type.setAttribute('aria-label', T('收支类型'));
    ['expense', 'income'].forEach((value) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.ledgerType = value;
      button.textContent = value === 'income' ? T('收入') : T('支出');
      button.classList.toggle('is-active', entry.type === value);
      button.setAttribute('aria-pressed', entry.type === value ? 'true' : 'false'); type.appendChild(button);
    });
    const dateField = buildSettingsField(T('日期'), 'date', 'ledgerDate', entry.date, '');
    dateField.classList.add('ledger-settings-date-field');
    dateField.hidden = state.viewMode === 'cumulative';
    fields.append(type,
      buildSettingsField(T('金额'), 'text', 'ledgerAmount', amountInputValue(entry.amountCents), '0.00'),
      buildSettingsField(T('倍率'), 'text', 'ledgerMultiplier', multiplierInputValue(entry.multiplier), T('可选')),
      dateField,
      buildSettingsField(T('备注'), 'text', 'ledgerNote', entry.note || '', T('可选')));
    const error = document.createElement('p');
    error.className = 'study-progress-settings-error ledger-settings-error';
    error.dataset.role = 'ledger-settings-error'; error.setAttribute('role', 'alert');
    const actions = document.createElement('div'); actions.className = 'study-progress-settings-actions';
    const remove = document.createElement('button'); remove.type = 'button';
    remove.className = 'study-progress-settings-trash'; remove.dataset.ledgerDelete = ''; remove.textContent = T('删除');
    actions.appendChild(remove);
    const actionGroup = document.createElement('span');
    const cancel = document.createElement('button'); cancel.type = 'button';
    cancel.className = 'study-progress-settings-cancel'; cancel.dataset.ledgerCancel = ''; cancel.textContent = T('取消');
    const save = document.createElement('button'); save.type = 'submit';
    save.className = 'study-progress-settings-save'; save.dataset.ledgerSave = ''; save.textContent = T('保存');
    actionGroup.append(cancel, save); actions.appendChild(actionGroup); box.append(title, fields, error, actions);
    box.addEventListener('submit', (event) => { event.preventDefault(); submitSettings(); });
    box.addEventListener('click', handleSettingsClick); return box;
  }

  function positionSettings() {
    const box = state.settingsPopover; const trigger = state.settingsTrigger;
    if (!box || !trigger || !trigger.isConnected) return;
    const triggerRect = trigger.getBoundingClientRect(); const boxRect = box.getBoundingClientRect();
    const edge = 12; const gap = 8; const roomBelow = window.innerHeight - triggerRect.bottom - edge;
    const placement = roomBelow >= boxRect.height + gap || triggerRect.top < boxRect.height + gap ? 'below' : 'above';
    const left = Math.min(window.innerWidth - boxRect.width - edge, Math.max(edge, triggerRect.right - boxRect.width));
    const top = placement === 'above' ? Math.max(edge, triggerRect.top - boxRect.height - gap)
      : Math.min(window.innerHeight - boxRect.height - edge, triggerRect.bottom + gap);
    box.dataset.placement = placement;
    box.style.left = Math.round(left) + 'px'; box.style.top = Math.round(top) + 'px';
  }

  function scheduleSettingsPosition() {
    if (!state.settingsPopover || state.settingsPositionFrame) return;
    state.settingsPositionFrame = window.requestAnimationFrame(() => {
      state.settingsPositionFrame = 0;
      if (!state.settingsTrigger || !state.settingsTrigger.isConnected) closeSettings(false, true);
      else positionSettings();
    });
  }

  function openSettings(id, trigger) {
    const entry = findEntry(id); if (!entry || !trigger) return;
    if (state.settingsPopover) closeSettings(false, true);
    state.settings = { id, saving: false, deleteArmed: false };
    state.settingsTrigger = trigger; state.settingsPopover = buildSettings(entry);
    trigger.setAttribute('aria-expanded', 'true'); document.body.appendChild(state.settingsPopover); positionSettings();
    window.requestAnimationFrame(() => {
      if (!state.settingsPopover) return;
      state.settingsPopover.classList.add('is-open'); positionSettings();
    });
    window.setTimeout(() => {
      const input = state.settingsPopover && state.settingsPopover.querySelector('[data-ledger-amount]');
      if (input) { input.focus(); input.select(); }
    }, reducedMotion ? 0 : 80);
    const row = trigger.closest('[data-ledger-entry]'); if (row) syncEntryRow(row, entry);
  }

  function closeSettings(restoreFocus, instant) {
    const popover = state.settingsPopover; const trigger = state.settingsTrigger;
    if (!popover) return;
    window.clearTimeout(state.deleteTimer); state.deleteTimer = 0;
    if (state.settingsPositionFrame) window.cancelAnimationFrame(state.settingsPositionFrame);
    state.settingsPositionFrame = 0; state.settings = null; state.settingsPopover = null; state.settingsTrigger = null;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    const finish = () => {
      if (popover.isConnected) popover.remove();
      if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    if (instant || reducedMotion) finish();
    else {
      popover.classList.remove('is-open'); popover.classList.add('is-closing'); window.setTimeout(finish, 190);
    }
  }

  function buildUnitSettings() {
    const box = document.createElement('form');
    box.className = 'study-progress-settings-popover ledger-unit-popover';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', T('当前账本页设置'));
    const title = document.createElement('strong');
    title.className = 'study-progress-settings-title'; title.textContent = T('当前账本页设置');
    const fields = document.createElement('div'); fields.className = 'ledger-settings-fields';
    const field = buildSettingsField(T('单位'), 'text', 'ledgerUnit', currentUnit(), T('留空使用人民币'));
    const input = field.querySelector('input'); input.maxLength = 12;
    const viewField = document.createElement('div'); viewField.className = 'ledger-settings-field ledger-view-field';
    const viewLabel = document.createElement('span'); viewLabel.textContent = T('视图');
    const viewSwitch = document.createElement('div');
    viewSwitch.className = 'ledger-type-switch'; viewSwitch.setAttribute('role', 'group');
    viewSwitch.setAttribute('aria-label', T('账本视图'));
    [['month', '月份'], ['cumulative', '累计']].forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.ledgerView = item[0];
      button.textContent = T(item[1]); button.classList.toggle('is-active', state.viewMode === item[0]);
      button.setAttribute('aria-pressed', state.viewMode === item[0] ? 'true' : 'false'); viewSwitch.appendChild(button);
    });
    viewField.append(viewLabel, viewSwitch); fields.append(field, viewField);
    const error = document.createElement('p');
    error.className = 'study-progress-settings-error ledger-settings-error';
    error.dataset.role = 'ledger-unit-error'; error.setAttribute('role', 'alert');
    const actions = document.createElement('div'); actions.className = 'study-progress-settings-actions ledger-unit-actions';
    const group = document.createElement('span');
    const cancel = document.createElement('button'); cancel.type = 'button';
    cancel.className = 'study-progress-settings-cancel'; cancel.dataset.ledgerUnitCancel = ''; cancel.textContent = T('取消');
    const save = document.createElement('button'); save.type = 'submit';
    save.className = 'study-progress-settings-save'; save.dataset.ledgerUnitSave = ''; save.textContent = T('保存');
    group.append(cancel, save); actions.appendChild(group); box.append(title, fields, error, actions);
    box.addEventListener('submit', (event) => { event.preventDefault(); saveUnitSettings(); });
    box.addEventListener('click', (event) => {
      const view = event.target.closest('[data-ledger-view]');
      if (view) {
        box.querySelectorAll('[data-ledger-view]').forEach((button) => {
          const active = button === view; button.classList.toggle('is-active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        return;
      }
      if (event.target.closest('[data-ledger-unit-cancel]')) closeUnitSettings(true);
    });
    return box;
  }

  function positionUnitSettings() {
    const box = state.unitPopover; const trigger = state.unitTrigger;
    if (!box || !trigger || !trigger.isConnected) return;
    const triggerRect = trigger.getBoundingClientRect(); const boxRect = box.getBoundingClientRect();
    const edge = 12; const gap = 8; const roomBelow = window.innerHeight - triggerRect.bottom - edge;
    const placement = roomBelow >= boxRect.height + gap || triggerRect.top < boxRect.height + gap ? 'below' : 'above';
    const left = Math.min(window.innerWidth - boxRect.width - edge, Math.max(edge, triggerRect.right - boxRect.width));
    const top = placement === 'above' ? Math.max(edge, triggerRect.top - boxRect.height - gap)
      : Math.min(window.innerHeight - boxRect.height - edge, triggerRect.bottom + gap);
    box.dataset.placement = placement;
    box.style.left = Math.round(left) + 'px'; box.style.top = Math.round(top) + 'px';
  }

  function openUnitSettings() {
    if (state.unitPopover || !dom.pageSettings) return;
    closeSettings(false, true); if (paletteController) paletteController.close(false, true);
    state.unitTrigger = dom.pageSettings; state.unitPopover = buildUnitSettings(); state.unitSaving = false;
    dom.pageSettings.setAttribute('aria-expanded', 'true');
    document.body.appendChild(state.unitPopover); positionUnitSettings();
    window.requestAnimationFrame(() => {
      if (!state.unitPopover) return;
      state.unitPopover.classList.add('is-open'); positionUnitSettings();
    });
    window.setTimeout(() => {
      const input = state.unitPopover && state.unitPopover.querySelector('[data-ledger-unit]');
      if (input) { input.focus(); input.select(); }
    }, reducedMotion ? 0 : 80);
  }

  function closeUnitSettings(restoreFocus, instant) {
    const box = state.unitPopover; const trigger = state.unitTrigger;
    if (!box) return;
    state.unitPopover = null; state.unitTrigger = null; state.unitSaving = false;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    const finish = () => {
      if (box.isConnected) box.remove();
      if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    if (instant || reducedMotion) finish();
    else { box.classList.remove('is-open'); box.classList.add('is-closing'); window.setTimeout(finish, 190); }
  }

  function saveUnitSettings() {
    const box = state.unitPopover;
    if (!box || state.unitSaving) return;
    const input = box.querySelector('[data-ledger-unit]');
    const unit = String(input && input.value || '').trim();
    const activeView = box.querySelector('[data-ledger-view].is-active');
    const nextViewMode = normalizeViewMode(activeView && activeView.dataset.ledgerView);
    const error = box.querySelector('[data-role="ledger-unit-error"]');
    if (unit.length > 12) { error.textContent = T('金额单位最多 12 个字符'); input.focus(); return; }
    state.unitSaving = true; box.classList.add('is-saving');
    box.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    const save = box.querySelector('[data-ledger-unit-save]'); if (save) save.textContent = T('正在保存');
    post('/api/ledger-page-unit', { page: state.page, year: state.year, month: state.month,
      unit, scope: nextViewMode === 'cumulative' ? 'all' : 'month' }).then((result) => {
      if (!result.payload) throw new Error(T('账本同步失败'));
      const payload = result.payload;
      state.cache.forEach((cached) => {
        cached.highestPage = payload.highestPage;
        if (normalizePage(cached.page) === state.page) {
          cached.unit = payload.unit;
        }
      });
      state.viewMode = nextViewMode; saveViewMode();
      state.cache.set(ledgerCacheKey(payload.year, payload.month, payload.page, nextViewMode), payload);
      state.payload = payload; acceptHighestPage(payload); closeUnitSettings(false);
      discardDraft({ instant: true }); cancelPrefetch(); syncLedger({ skipFlip: true });
      scheduleNeighborPrefetch();
    }).catch((requestError) => {
      if (!state.unitPopover) return;
      state.unitSaving = false; box.classList.remove('is-saving');
      box.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
      if (save) save.textContent = T('保存');
      error.textContent = requestError.message; if (input) input.focus();
    });
  }

  function setSettingsError(message) {
    const error = state.settingsPopover && state.settingsPopover.querySelector('[data-role="ledger-settings-error"]');
    if (error) error.textContent = message || '';
  }

  function setSettingsSaving(saving) {
    if (!state.settings || !state.settingsPopover) return;
    state.settings.saving = saving; state.settingsPopover.classList.toggle('is-saving', saving);
    state.settingsPopover.querySelectorAll('button, input').forEach((control) => { control.disabled = saving; });
    const save = state.settingsPopover.querySelector('[data-ledger-save]');
    if (save) save.textContent = saving ? T('正在保存') : T('保存');
  }

  function readSettingsValues() {
    const box = state.settingsPopover; if (!box || !state.settings) return null;
    const activeType = box.querySelector('[data-ledger-type].is-active');
    const amount = box.querySelector('[data-ledger-amount]');
    const multiplier = box.querySelector('[data-ledger-multiplier]');
    const date = box.querySelector('[data-ledger-date]');
    const note = box.querySelector('[data-ledger-note]');
    let amountCents;
    try { amountCents = parseAmountCents(amount && amount.value); }
    catch (error) { setSettingsError(error.message); if (amount) amount.focus(); return null; }
    let multiplierValue;
    try { multiplierValue = parseMultiplier(multiplier && multiplier.value); }
    catch (error) { setSettingsError(error.message); if (multiplier) multiplier.focus(); return null; }
    if (!effectiveAmountCents({ amountCents, multiplier: multiplierValue })) {
      setSettingsError(T('应用倍率后的金额超出有效范围')); if (multiplier) multiplier.focus(); return null;
    }
    if (!dateParts(date && date.value)) {
      setSettingsError(T('请选择有效日期')); if (date) date.focus(); return null;
    }
    return { type: activeType && activeType.dataset.ledgerType === 'income' ? 'income' : 'expense',
      amountCents, multiplier: multiplierValue, date: date.value,
      note: String(note && note.value || '').trim() };
  }

  function cacheSnapshots(keys) {
    const snapshots = new Map();
    keys.forEach((key) => snapshots.set(key, state.cache.has(key) ? clonePayload(state.cache.get(key)) : null));
    return snapshots;
  }

  function restoreSnapshots(snapshots) {
    snapshots.forEach((payload, key) => { if (payload) state.cache.set(key, payload); else state.cache.delete(key); });
  }

  function applyLocalEntry(previousEntry, nextEntry) {
    if (state.viewMode === 'cumulative') {
      const key = ledgerCacheKey(state.year, state.month, state.page, 'cumulative');
      const payload = state.cache.get(key) || state.payload
        || emptyPayload(state.year, state.month, state.page, 'cumulative');
      payload.entries = payload.entries.filter((entry) => entry.id !== previousEntry.id);
      payload.entries.push(nextEntry); normalizePayload(payload); state.cache.set(key, payload);
      currentCachePayload(); return;
    }
    const previousMonth = monthFromDay(previousEntry.date); const nextMonth = monthFromDay(nextEntry.date);
    const ledgerPage = normalizePage(previousEntry.ledgerPage);
    const previousKey = ledgerCacheKey(previousMonth.year, previousMonth.month, ledgerPage);
    const nextKey = ledgerCacheKey(nextMonth.year, nextMonth.month, ledgerPage);
    const previousPayload = state.cache.get(previousKey)
      || (ledgerCacheKey(state.year, state.month, state.page) === previousKey
        ? state.payload : emptyPayload(previousMonth.year, previousMonth.month, ledgerPage));
    previousPayload.entries = previousPayload.entries.filter((entry) => entry.id !== previousEntry.id);
    normalizePayload(previousPayload); state.cache.set(previousKey, previousPayload);
    const targetPayload = nextKey === previousKey ? previousPayload
      : state.cache.get(nextKey) || emptyPayload(nextMonth.year, nextMonth.month, ledgerPage);
    targetPayload.entries = targetPayload.entries.filter((entry) => entry.id !== nextEntry.id);
    targetPayload.entries.push(nextEntry); normalizePayload(targetPayload); state.cache.set(nextKey, targetPayload);
    currentCachePayload();
  }

  function removeLocalEntry(entry) {
    if (state.viewMode === 'cumulative') {
      const key = ledgerCacheKey(state.year, state.month, state.page, 'cumulative');
      const payload = state.cache.get(key) || state.payload;
      payload.entries = payload.entries.filter((item) => item.id !== entry.id);
      normalizePayload(payload); state.cache.set(key, payload); currentCachePayload(); return;
    }
    const parts = monthFromDay(entry.date);
    const key = ledgerCacheKey(parts.year, parts.month, entry.ledgerPage);
    const payload = state.cache.get(key) || state.payload;
    payload.entries = payload.entries.filter((item) => item.id !== entry.id);
    normalizePayload(payload); state.cache.set(key, payload); currentCachePayload();
  }

  function nextMutation(id) {
    const seq = (state.mutationSeq.get(id) || 0) + 1; state.mutationSeq.set(id, seq); return seq;
  }
  function mutationCurrent(id, seq) { return state.mutationSeq.get(id) === seq; }

  function submitSettings() {
    if (!state.settings || state.settings.saving) return;
    const id = state.settings.id; const entry = findEntry(id); const values = readSettingsValues();
    if (!entry || !values) return;
    setSettingsError('');
    if (id === DRAFT_ID) {
      state.draft.type = values.type; state.draft.amountCents = values.amountCents;
      state.draft.multiplier = values.multiplier;
      state.draft.note = values.note; state.draft.pending = true;
      const row = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
      if (row) syncEntryRow(row, state.draft);
      setSettingsSaving(true);
      post('/api/ledger-entry-create', { ...values, ledgerPage: state.draft.ledgerPage,
        color: state.draft.color || '' }).then((result) => {
        absorbMutation(result);
        const target = monthFromDay(result.entry.date);
        closeSettings(false); state.draft = null;
        if (state.viewMode !== 'cumulative') { state.year = target.year; state.month = target.month; }
        state.page = normalizePage(result.entry.ledgerPage); saveCurrentPage(); renderPageRail();
        state.payload = state.cache.get(ledgerCacheKey(state.year, state.month, state.page))
          || emptyPayload(state.year, state.month, state.page);
        state.highlightId = result.entry.id;
        syncLedger({ newIds: new Set([result.entry.id]) }); scheduleNeighborPrefetch();
      }).catch((error) => {
        if (!state.draft) return;
        state.draft.pending = false;
        const currentRow = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
        if (currentRow) syncEntryRow(currentRow, state.draft);
        setSettingsSaving(false); setSettingsError(error.message);
      });
      return;
    }

    const oldEntry = { ...entry }; const nextEntry = { ...entry, ...values, updatedAt: new Date().toISOString() };
    const oldMonth = monthFromDay(oldEntry.date); const nextMonth = monthFromDay(nextEntry.date);
    const ledgerPage = normalizePage(oldEntry.ledgerPage);
    const keys = state.viewMode === 'cumulative'
      ? new Set([ledgerCacheKey(state.year, state.month, ledgerPage, 'cumulative')])
      : new Set([ledgerCacheKey(oldMonth.year, oldMonth.month, ledgerPage, 'month'),
        ledgerCacheKey(nextMonth.year, nextMonth.month, ledgerPage, 'month')]);
    const snapshots = cacheSnapshots(keys); const previousRects = captureEntryRects(); const seq = nextMutation(id);
    applyLocalEntry(oldEntry, nextEntry); closeSettings(false);
    if (state.viewMode !== 'cumulative'
        && (nextMonth.year !== state.year || nextMonth.month !== state.month)) {
      state.year = nextMonth.year; state.month = nextMonth.month; currentCachePayload();
      beginMonthMotion(nextMonth.year * 12 + nextMonth.month > oldMonth.year * 12 + oldMonth.month ? 1 : -1);
    }
    state.highlightId = id; syncLedger({ previousRects });
    postInOrder(id, '/api/ledger-entry-update', { id, ...values }).then((result) => {
      if (!mutationCurrent(id, seq)) return;
      absorbMutation(result); currentCachePayload(); syncLedger();
    }).catch((error) => {
      if (!mutationCurrent(id, seq)) return;
      restoreSnapshots(snapshots);
      if (state.viewMode !== 'cumulative') { state.year = oldMonth.year; state.month = oldMonth.month; }
      currentCachePayload(); state.highlightId = id; syncLedger({ newIds: new Set([id]) }); showToast(error.message);
    });
  }

  function handleSettingsClick(event) {
    const type = event.target.closest('[data-ledger-type]');
    if (type && state.settingsPopover) {
      state.settingsPopover.querySelectorAll('[data-ledger-type]').forEach((button) => {
        const active = button === type; button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      setSettingsError(''); return;
    }
    if (event.target.closest('[data-ledger-cancel]')) closeSettings(true);
    else if (event.target.closest('[data-ledger-delete]')) deleteSettingsEntry();
  }

  function deleteSettingsEntry() {
    if (!state.settings || state.settings.saving) return;
    if (state.settings.id === DRAFT_ID) {
      closeSettings(false);
      discardDraft();
      return;
    }
    const button = state.settingsPopover.querySelector('[data-ledger-delete]');
    if (!state.settings.deleteArmed) {
      state.settings.deleteArmed = true; button.classList.add('is-armed'); button.textContent = T('确认删除');
      window.clearTimeout(state.deleteTimer);
      state.deleteTimer = window.setTimeout(() => {
        if (!state.settings || !state.settingsPopover) return;
        state.settings.deleteArmed = false; button.classList.remove('is-armed'); button.textContent = T('删除');
      }, 3200); return;
    }
    const id = state.settings.id; const entry = findEntry(id); if (!entry) return;
    const parts = monthFromDay(entry.date);
    const key = state.viewMode === 'cumulative'
      ? ledgerCacheKey(state.year, state.month, entry.ledgerPage, 'cumulative')
      : ledgerCacheKey(parts.year, parts.month, entry.ledgerPage, 'month');
    const snapshots = cacheSnapshots(new Set([key])); const previousRects = captureEntryRects();
    const row = dom.groups.querySelector('[data-ledger-entry="' + CSS.escape(id) + '"]'); const seq = nextMutation(id);
    closeSettings(false); removeLocalEntry(entry); syncSummary();
    if (row && !reducedMotion) {
      row.classList.add('is-leaving'); window.setTimeout(() => syncEntries({ previousRects }), 300);
    } else syncEntries({ previousRects });
    postInOrder(id, '/api/ledger-entry-delete', { id }).then((result) => {
      if (!mutationCurrent(id, seq)) return;
      absorbMutation(result); currentCachePayload(); syncLedger();
    }).catch((error) => {
      if (!mutationCurrent(id, seq)) return;
      restoreSnapshots(snapshots); currentCachePayload(); state.highlightId = id;
      syncLedger({ newIds: new Set([id]) }); showToast(error.message);
    });
  }

  function setEntryColor(entry, value) {
    if (entry.id === DRAFT_ID) {
      entry.color = value;
      const draftRow = dom.groups.querySelector('[data-ledger-entry="' + DRAFT_ID + '"]');
      if (draftRow) { syncEntryRow(draftRow, entry); replayClass(draftRow, 'ledger-entry-color-updated', 380); }
      return;
    }
    const oldColor = entry.color || ''; const seq = nextMutation(entry.id); entry.color = value;
    const row = dom.groups.querySelector('[data-ledger-entry="' + CSS.escape(entry.id) + '"]');
    if (row) { syncEntryRow(row, entry); replayClass(row, 'ledger-entry-color-updated', 380); }
    postInOrder(entry.id, '/api/ledger-entry-update', { id: entry.id, color: value }).then((result) => {
      if (!mutationCurrent(entry.id, seq)) return;
      absorbMutation(result); currentCachePayload();
    }).catch((error) => {
      if (!mutationCurrent(entry.id, seq)) return;
      entry.color = oldColor; if (row) syncEntryRow(row, entry); showToast(error.message);
    });
  }

  function openEntryPalette(row, event) {
    const entry = findEntry(row.dataset.ledgerEntry); if (!entry || !paletteController) return;
    const rect = row.getBoundingClientRect();
    paletteController.open(row,
      event && Number.isFinite(event.clientX) ? event.clientX : rect.right,
      event && Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2, {
        currentColor: entry.color || '', label: T('选择颜色'),
        pick: (value) => setEntryColor(entry, value),
      });
  }

  function openLegendPalette(chip, event) {
    if (!paletteController) return;
    const index = Number(chip.dataset.ledgerLegendIndex); const rect = chip.getBoundingClientRect();
    paletteController.open(chip,
      event && Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2,
      event && Number.isFinite(event.clientY) ? event.clientY : rect.bottom, {
        currentColor: legendColors[index] || '', label: T('选择颜色'),
        pick: (value) => { legendColors[index] = value; saveLegend(); syncLegend(); },
      });
  }

  function beginMonthMotion(delta) {
    dom.flow.classList.remove('ledger-month-next', 'ledger-month-previous'); void dom.flow.offsetWidth;
    dom.flow.classList.add(delta > 0 ? 'ledger-month-next' : 'ledger-month-previous');
    window.clearTimeout(state.monthMotionTimer);
    state.monthMotionTimer = window.setTimeout(() => {
      dom.flow.classList.remove('ledger-month-next', 'ledger-month-previous'); state.monthMotionTimer = 0;
    }, reducedMotion ? 0 : 380);
  }

  function changeMonth(delta) {
    discardDraft({ instant: true }); closeSettings(false, true); closeUnitSettings(false, true);
    if (paletteController) paletteController.close(false, true);
    const next = shiftedMonth(state.year, state.month, delta); beginMonthMotion(delta);
    loadMonth(next.year, next.month, { skipFlip: true });
  }

  function changePage(page) {
    const next = normalizePage(page);
    if (next === state.page) { renderPageRail(); return; }
    const direction = next > state.page ? 1 : -1;
    discardDraft({ instant: true }); closeSettings(false, true); closeUnitSettings(false, true);
    if (paletteController) paletteController.close(false, true);
    cancelPrefetch();
    state.page = next; state.highlightId = ''; saveCurrentPage(); renderPageRail();
    beginMonthMotion(direction);
    loadMonth(state.year, state.month, { skipFlip: true });
  }

  function bindPageRail() {
    if (!dom.pageRail) return;
    dom.pageRail.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ledger-page]');
      if (!button) return;
      event.preventDefault(); changePage(Number(button.dataset.ledgerPage));
    });
    dom.pageRail.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const direction = event.deltaY > 0 ? 1 : -1;
      const maxScroll = dom.pageScroll.scrollHeight - dom.pageScroll.clientHeight;
      const atEdge = direction > 0
        ? dom.pageScroll.scrollTop >= maxScroll - 1 : dom.pageScroll.scrollTop <= 1;
      if (!atEdge) { event.stopPropagation(); return; }
      event.preventDefault(); event.stopPropagation();
      state.pageWheelAccum += event.deltaY;
      window.clearTimeout(state.pageWheelTimer);
      state.pageWheelTimer = window.setTimeout(() => { state.pageWheelAccum = 0; }, 200);
      if (Math.abs(state.pageWheelAccum) < 24) return;
      const next = state.page + (state.pageWheelAccum > 0 ? 1 : -1);
      state.pageWheelAccum = 0;
      if (next >= 1 && next <= PAGE_MAX) changePage(next);
    }, { passive: false });
    dom.pageRail.addEventListener('pointerenter', () => {
      state.pageRailOver = true; setPageRailVisible(true);
    });
    dom.pageRail.addEventListener('pointerleave', () => {
      state.pageRailOver = false; setPageRailVisible(false);
    });
    dom.pageRail.addEventListener('focusin', () => setPageRailVisible(true));
    dom.pageRail.addEventListener('focusout', (event) => {
      if (!dom.pageRail.contains(event.relatedTarget)) setPageRailVisible(state.pageRailOver);
    });
    dom.pageScroll.addEventListener('scroll', () => positionPageOrb(true), { passive: true });
    pageHost.addEventListener('pointermove', (event) => {
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      const rect = pageHost.getBoundingClientRect();
      setPageRailVisible(rect.right - event.clientX <= PAGE_EDGE_PX || state.pageRailOver);
    }, { passive: true });
    pageHost.addEventListener('pointerleave', () => {
      if (!state.pageRailOver) setPageRailVisible(false);
    });
  }

  function bindControls() {
    bindPageRail();
    root.addEventListener('click', (event) => {
      const month = event.target.closest('[data-ledger-month]');
      if (month) { changeMonth(Number(month.dataset.ledgerMonth)); return; }
      if (event.target.closest('[data-ledger-page-settings]')) { openUnitSettings(); return; }
      if (event.target.closest('[data-ledger-add]')) { createDraft(); return; }
      const menu = event.target.closest('[data-ledger-entry-menu]');
      if (menu) {
        event.stopPropagation(); const row = menu.closest('[data-ledger-entry]');
        if (state.settings && state.settings.id === row.dataset.ledgerEntry) closeSettings(true);
        else openSettings(row.dataset.ledgerEntry, menu);
      }
    });
    root.addEventListener('contextmenu', (event) => {
      const chip = event.target.closest('[data-ledger-legend-index]');
      if (chip) { event.preventDefault(); event.stopPropagation(); openLegendPalette(chip, event); return; }
      const row = event.target.closest('[data-ledger-entry]');
      if (!row || event.target.closest('button, input, a')) return;
      event.preventDefault(); event.stopPropagation(); openEntryPalette(row, event);
    });
    root.addEventListener('keydown', (event) => {
      const chip = event.target.closest('[data-ledger-legend-index]');
      if (chip && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); openLegendPalette(chip, null); return;
      }
      const row = event.target.closest('[data-ledger-entry]');
      if (!row || event.target.closest('[data-ledger-entry-menu]')) return;
      if (event.key === 'Enter') {
        event.preventDefault(); openSettings(row.dataset.ledgerEntry, row.querySelector('[data-ledger-entry-menu]'));
      } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault(); openEntryPalette(row, null);
      }
    });
  }

  function clearEntranceAnimations() {
    state.entranceAnimations.forEach((animation) => { try { animation.cancel(); } catch (error) {} });
    state.entranceAnimations = []; state.exitFrozen = false; root.classList.remove('ledger-entering');
  }

  function replayEntrance() {
    clearEntranceAnimations(); if (reducedMotion || !state.active) return;
    root.classList.add('ledger-entering');
    root.querySelectorAll('.ledger-head, .ledger-summary-card, .ledger-day-group, .ledger-empty')
      .forEach((element, index) => {
        const animation = element.animate([{ opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'translateY(0)' }], {
          duration: 300, delay: Math.min(index, 9) * 34,
          easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)', fill: 'both',
        });
        state.entranceAnimations.push(animation);
      });
    window.setTimeout(() => {
      if (!state.active || state.exitFrozen) return;
      state.entranceAnimations = []; root.classList.remove('ledger-entering');
    }, 700);
  }

  function warmup() {
    const page = state.page; const year = state.year; const month = state.month; const viewMode = state.viewMode;
    const key = ledgerCacheKey(year, month, page, viewMode);
    if (state.cache.has(key) || state.warmupHandle || state.warmupPromise) return state.warmupPromise;
    state.warmupKey = key;
    const run = () => {
      state.warmupHandle = 0;
      if (state.cache.has(key)) return;
      const controller = new AbortController();
      state.warmupController = controller;
      state.warmupPromise = request(ledgerUrl(year, month, page, viewMode),
        { signal: controller.signal })
        .then((payload) => { state.cache.set(key, payload); trimCache(); return payload; })
        .catch(() => null)
        .finally(() => {
          if (state.warmupController === controller) state.warmupController = null;
          state.warmupPromise = null;
          state.warmupKey = '';
        });
    };
    state.warmupUsesIdle = 'requestIdleCallback' in window;
    if (state.warmupUsesIdle) state.warmupHandle = window.requestIdleCallback(run, { timeout: 1400 });
    else state.warmupHandle = window.setTimeout(run, 260);
    return state.warmupPromise;
  }

  document.addEventListener('click', (event) => {
    if (state.settingsPopover && !state.settingsPopover.contains(event.target)
        && !(state.settingsTrigger && state.settingsTrigger.contains(event.target))) closeSettings(true);
    const palette = paletteController && paletteController.getElement();
    const paletteTrigger = paletteController && paletteController.getTrigger();
    if (palette && !palette.contains(event.target)
        && !(paletteTrigger && paletteTrigger.contains(event.target))) paletteController.close(true);
    if (state.unitPopover && !state.unitPopover.contains(event.target)
        && !(state.unitTrigger && state.unitTrigger.contains(event.target))) closeUnitSettings(true);
  });
  document.addEventListener('keydown', (event) => {
    if (!state.active || event.key !== 'Escape') return;
    if (paletteController && paletteController.isOpen()) { event.preventDefault(); paletteController.close(true); }
    else if (state.unitPopover) { event.preventDefault(); closeUnitSettings(true); }
    else if (state.settingsPopover) { event.preventDefault(); closeSettings(true); }
  });
  window.addEventListener('resize', () => {
    scheduleSettingsPosition(); positionUnitSettings(); renderPageRail();
    if (paletteController) paletteController.schedulePosition();
  });
  window.addEventListener('scroll', () => {
    scheduleSettingsPosition(); positionUnitSettings(); if (paletteController) paletteController.schedulePosition();
  }, true);
  document.addEventListener('relatum:languagechange', () => {
    if (!state.mounted) return;
    if (state.settingsPopover) closeSettings(false, true);
    if (state.unitPopover) closeUnitSettings(false, true); syncLanguage();
  });
  window.addEventListener('pagehide', () => {
    state.active = false; discardDraft({ instant: true }); cancelMainRequest(); cancelPrefetch();
    closeSettings(false, true); closeUnitSettings(false, true);
    if (paletteController) paletteController.close(false, true);
  });

  mount();
  // 与起步页其他重页一样，首屏空闲时就读取本月账本，
  // 用户第一次翻到记账视图时直接消费内存快照。
  warmup();
  window.CanvasLedger = {
    activate() {
      state.active = true; state.exitFrozen = false;
      if (!state.activatedOnce) {
        const today = new Date(); state.year = today.getFullYear(); state.month = today.getMonth() + 1;
        state.activatedOnce = true;
      }
      renderPageRail(); window.requestAnimationFrame(renderPageRail);
      const cached = state.cache.get(ledgerCacheKey(state.year, state.month, state.page));
      if (cached) {
        state.payload = cached; root.classList.remove('is-loading'); acceptHighestPage(cached);
        syncLedger({ skipFlip: true }); replayEntrance(); loadMonth(state.year, state.month, { sync: false });
      } else {
        state.payload = emptyPayload(state.year, state.month, state.page);
        syncLedger({ skipFlip: true }); replayEntrance(); loadMonth(state.year, state.month, { sync: false });
      }
    },
    deactivate() {
      state.active = false; state.exitFrozen = true;
      setPageRailVisible(false);
      state.entranceAnimations.forEach((animation) => { try { animation.pause(); } catch (error) {} });
      discardDraft({ instant: true }); cancelMainRequest(); cancelPrefetch(); closeSettings(false, true);
      closeUnitSettings(false, true);
      if (paletteController) paletteController.close(false, true);
    },
    finalizeExitMotion() { if (!state.active) clearEntranceAnimations(); },
    warmup,
    getMonth() { return { year: state.year, month: state.month }; },
  };
})();

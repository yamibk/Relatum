(function () {
  'use strict';

  const root = document.querySelector('[data-role="ledger-shell"]');
  if (!root) return;
  const model = window.RelatumLedgerModel;
  if (!model) return;
  const pageHost = root.closest('.calendar-embedded') || root;

  const LEGEND_KEY = 'ledger:legend:v1';
  const PAGE_KEY = 'ledger:page:v1';
  const VIEW_KEY = 'ledger:viewByPage:v1';
  const HIDE_KEY = 'ledger:hideDecimalsByPage:v1';
  const DRAFT_ID = 'ledger-local-draft';
  const PAGE_MAX = model.PAGE_MAX;
  const PAGE_EDGE_PX = 84;
  const PAGE_SWITCH_MS = 220;
  const reducedMotion = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (error) { return false; }
  })();
  const now = new Date();
  const initialPage = loadCurrentPage();
  const state = {
    active: false, activatedOnce: false, mounted: false,
    year: now.getFullYear(), month: now.getMonth() + 1, page: initialPage, highestPage: 1,
    viewByPage: loadViewByPage(), viewMode: 'month',
    hideByPage: loadHideByPage(), hideDecimals: false,
    // 与学习页同款模型：一次全量加载整本账本，当前视图（月/页/累计）由本地派生。
    ledger: null, payload: null, draft: null,
    requestSeq: 0, controller: null,
    warmupPromise: null,
    settings: null, settingsPopover: null, settingsTrigger: null,
    settingsPositionFrame: 0, deleteTimer: 0,
    unitPopover: null, unitTrigger: null, unitSaving: false,
    highlightId: '', entranceTimer: 0,
    monthMotionTimer: 0, mutationSeq: new Map(), mutationChains: new Map(),
    pendingMutations: 0, needsReload: false, reloadPromise: null,
    pageRailOver: false, pageRailVisible: false, pageWheelAccum: 0, pageWheelTimer: 0,
    pageOrbSettleUntil: 0,
    pageSwitchSeq: 0, pageSwitchTimer: 0, pageSwitchFrame: 0,
    pageCrossfading: false, flowHeightFloor: 0,
  };
  const entryRows = new Map();
  const dayGroups = new Map();
  // 视图按页独立：viewMode 只镜像当前页，切页与保存视图时同步；
  // 隐藏小数点同样按页独立，hideDecimals 只镜像当前页。
  state.viewMode = viewForPage(state.page);
  state.hideDecimals = hideDecimalsForPage(state.page);
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
    return model.normalizePage(value);
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

  // 视图按页独立：ledger:viewByPage:v1 的 views 只保存显式设为「累计」的页，
  // 未记录的页（含全部「月份」页）一律回退「月份」。
  function loadViewByPage() {
    const fallback = { version: 1, views: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
      if (!raw || raw.version !== 1 || !raw.views || typeof raw.views !== 'object') return fallback;
      const views = {};
      Object.keys(raw.views).forEach((page) => {
        if (normalizeViewMode(raw.views[page]) === 'cumulative') views[page] = 'cumulative';
      });
      return { version: 1, views };
    } catch (error) { return fallback; }
  }

  function saveViewByPage() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.viewByPage)); }
    catch (error) {}
  }

  // 指定页的视图；state.viewMode 始终镜像「当前页」，初始化和每次切页时同步。
  function viewForPage(page) {
    const store = state.viewByPage && state.viewByPage.views || {};
    return normalizeViewMode(store[String(normalizePage(page))]);
  }

  function setViewForPage(page, mode) {
    const key = String(normalizePage(page));
    if (normalizeViewMode(mode) === 'cumulative') state.viewByPage.views[key] = 'cumulative';
    else delete state.viewByPage.views[key];
    saveViewByPage();
  }

  // 隐藏小数点按页独立：ledger:hideDecimalsByPage:v1 的 pages 只保存开启的页，
  // 未记录的页显示完整小数。只改变显示，账目金额数据（分）不变。
  function loadHideByPage() {
    const fallback = { version: 1, pages: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(HIDE_KEY) || 'null');
      if (!raw || raw.version !== 1 || !raw.pages || typeof raw.pages !== 'object') return fallback;
      const pages = {};
      Object.keys(raw.pages).forEach((page) => { if (raw.pages[page] === true) pages[page] = true; });
      return { version: 1, pages };
    } catch (error) { return fallback; }
  }

  function saveHideByPage() {
    try { localStorage.setItem(HIDE_KEY, JSON.stringify(state.hideByPage)); }
    catch (error) {}
  }

  function hideDecimalsForPage(page) {
    const store = state.hideByPage && state.hideByPage.pages || {};
    return store[String(normalizePage(page))] === true;
  }

  function setHideForPage(page, hidden) {
    const key = String(normalizePage(page));
    if (hidden) state.hideByPage.pages[key] = true;
    else delete state.hideByPage.pages[key];
    saveHideByPage();
  }

  function dateParts(day) {
    return model.dateParts(day);
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
    let value;
    try { value = typeof cents === 'bigint' ? cents : BigInt(cents || 0); }
    catch (error) { value = 0n; }
    const locale = document.documentElement.dataset.uiLanguage === 'en' ? 'en-US' : 'zh-CN';
    // 当前页开启「隐藏小数点」时只显示整数（直接截断，不四舍五入）；数据仍按分完整保存。
    const absolute = value < 0n ? -value : value;
    const integer = absolute / 100n;
    const formatted = state.hideDecimals
      ? integer.toLocaleString(locale)
      : integer.toLocaleString(locale) + '.' + String(absolute % 100n).padStart(2, '0');
    const sign = signed && value !== 0n ? (value < 0n ? '−' : '+') : (value < 0n ? '−' : '');
    const customUnit = typeof unit === 'string' ? unit : currentUnit();
    return customUnit ? sign + formatted + customUnit : sign + '¥' + formatted;
  }

  function amountInputValue(cents) {
    return Number.isInteger(cents) && cents > 0 ? (cents / 100).toFixed(2) : '';
  }

  function parseAmountCents(value) {
    try { return model.parseAmountCents(value); }
    catch (error) { throw new Error(T(error.message)); }
  }

  function multiplierInputValue(value) {
    return typeof value === 'string' ? value : '';
  }

  function parseMultiplier(value) {
    try { return model.normalizeMultiplier(value); }
    catch (error) { throw new Error(T(error.message)); }
  }

  function effectiveAmountCents(entry) {
    return model.effectiveAmountCents(entry);
  }

  function emptyPayload(year, month, page, viewMode) {
    return model.derivePayload(null, { year, month, page,
      viewMode: normalizeViewMode(viewMode == null ? state.viewMode : viewMode) });
  }

  // 从全量账本派生当前视图（月/累计 × 当前页）的 payload；渲染层继续读 state.payload。
  function computePayload() {
    return model.derivePayload(state.ledger, { year: state.year, month: state.month,
      page: state.page, viewMode: state.viewMode });
  }

  // 只有 GET /api/ledger 的权威快照整体替换本地账本；mutation 响应只走目标增量合并。
  function applyLedgerPayload(payload) {
    if (!payload || payload.version !== 2 || !Number.isSafeInteger(payload.revision)
        || !Array.isArray(payload.entries)) return;
    state.ledger = payload;
    if (state.draft && state.draft.clientId
        && payload.entries.some((entry) => entry.id === state.draft.clientId)) {
      state.highlightId = state.draft.clientId; state.draft = null;
      if (state.settings && state.settings.id === DRAFT_ID) closeSettings(false, true);
    }
    state.highestPage = normalizePage(payload.highestPage);
    acceptHighestPage(payload);
  }

  function normalizePayload(payload) {
    return payload || emptyPayload(state.year, state.month, state.page);
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || T('账本同步失败'));
      error.status = response.status; error.payload = json; throw error;
    }
    return json;
  }

  function post(path, body) {
    return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  }

  function postInOrder(id, path, body) {
    const previous = state.mutationChains.get(id) || Promise.resolve();
    state.pendingMutations += 1;
    const next = previous.catch(() => {}).then(() => post(path, body));
    state.mutationChains.set(id, next);
    next.finally(() => {
      if (state.mutationChains.get(id) === next) state.mutationChains.delete(id);
      state.pendingMutations = Math.max(0, state.pendingMutations - 1);
      flushScheduledReload();
    }).catch(() => {});
    return next;
  }

  function postTracked(path, body) {
    state.pendingMutations += 1;
    const pending = post(path, body);
    pending.finally(() => {
      state.pendingMutations = Math.max(0, state.pendingMutations - 1);
      flushScheduledReload();
    }).catch(() => {});
    return pending;
  }

  function acceptMutationRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) { scheduleLedgerReload(); return; }
    if (!state.ledger) state.ledger = { version: 2, revision: value,
      highestPage: 1, pageUnits: {}, entries: [] };
    const result = model.acceptRevision(state.ledger, value);
    if (!result.valid || result.gap) state.needsReload = true;
    flushScheduledReload();
  }

  function scheduleLedgerReload() {
    state.needsReload = true;
    flushScheduledReload();
  }

  function flushScheduledReload() {
    if (!state.needsReload || state.pendingMutations || state.reloadPromise) return;
    state.needsReload = false;
    state.reloadPromise = loadLedger({ force: true, skipFlip: true })
      .finally(() => { state.reloadPromise = null; if (state.needsReload) flushScheduledReload(); });
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

  function recomputeHighestPage() {
    if (!state.ledger) return;
    const highest = model.recomputeHighestPage(state.ledger);
    const changed = state.highestPage !== highest;
    state.ledger.highestPage = highest; state.highestPage = highest;
    if (changed) renderPageRail();
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
        if (!state.pageCrossfading) replayClass(amount, 'ledger-summary-updated', 360);
      }
      card.querySelector('small').textContent = data[2];
    });
  }

  // 草稿跨页保留：只在创建它的页（且月视图时日期属于当前月）显示，切页不丢弃。
  function draftVisible() {
    if (!state.draft) return null;
    if (normalizePage(state.draft.ledgerPage) !== state.page) return null;
    if (state.viewMode !== 'cumulative') {
      const parts = monthFromDay(state.draft.date);
      if (!parts || parts.year !== state.year || parts.month !== state.month) return null;
    }
    return state.draft;
  }

  function displayEntries() {
    const entries = (state.payload && state.payload.entries || []).slice();
    const draft = draftVisible();
    if (draft) entries.push(draft);
    entries.sort(model.entrySort);
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
    entryRows.forEach((entry, id) => {
      if (entry.isConnected) result.set(id, entry.getBoundingClientRect());
    });
    return result;
  }

  function animateEntryChanges(previous) {
    if (reducedMotion || !previous || !previous.size) return;
    entryRows.forEach((entry, id) => {
      if (!entry.isConnected) return;
      const before = previous.get(id);
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
    group.append(header, rows); dayGroups.set(day, group); return group;
  }

  function createEntryRow(entry) {
    const row = document.createElement('article');
    row.className = 'ledger-entry';
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'ledger-entry-open'; open.dataset.ledgerEntryOpen = '';
    open.setAttribute('aria-haspopup', 'dialog'); open.setAttribute('aria-controls', 'ledger-settings-popover');
    const mark = document.createElement('span');
    mark.className = 'ledger-entry-mark'; mark.setAttribute('aria-hidden', 'true');
    const main = document.createElement('div'); main.className = 'ledger-entry-main';
    main.append(document.createElement('strong'), document.createElement('small'));
    const amount = document.createElement('b'); amount.className = 'ledger-entry-amount';
    const cue = document.createElement('span');
    cue.className = 'ledger-entry-detail-cue'; cue.setAttribute('aria-hidden', 'true'); cue.textContent = '›';
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'ledger-entry-menu'; menu.dataset.ledgerEntryMenu = '';
    menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-controls', 'ledger-settings-popover');
    menu.textContent = '⋯'; open.append(mark, main, amount, cue); row.append(open, menu);
    entryRows.set(entry.id, row); syncEntryRow(row, entry); return row;
  }

  function syncEntryRow(row, entry) {
    const income = entry.type === 'income';
    const draft = entry.id === DRAFT_ID;
    const label = income ? T('收入') : T('支出');
    const signedCents = income ? entry.amountCents : -entry.amountCents;
    const effectiveCents = effectiveAmountCents(entry);
    const signedEffectiveCents = income ? effectiveCents : -effectiveCents;
    const fingerprint = [entry.type, entry.amountCents, entry.multiplier || '', entry.note || '',
      entry.color || '', entry.pending ? 1 : 0, currentUnit(), state.hideDecimals ? 1 : 0,
      document.documentElement.dataset.uiLanguage || '',
      state.settings && state.settings.id === entry.id ? 1 : 0].join('\u001f');
    if (row.dataset.ledgerFingerprint === fingerprint) return;
    row.dataset.ledgerFingerprint = fingerprint;
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
    const open = row.querySelector('[data-ledger-entry-open]');
    open.setAttribute('aria-label', row.getAttribute('aria-label'));
    open.setAttribute('aria-expanded', state.settings && state.settings.id === entry.id
      && state.settingsTrigger === open ? 'true' : 'false');
    const menu = row.querySelector('[data-ledger-entry-menu]');
    menu.setAttribute('aria-label', T('账目选项'));
    menu.setAttribute('aria-expanded', state.settings && state.settings.id === entry.id
      && state.settingsTrigger === menu ? 'true' : 'false');
  }

  function syncEntries(options) {
    const opts = options || {};
    const previous = opts.previousRects || (opts.skipFlip ? null : captureEntryRects());
    const desiredIds = new Set(); const desiredDays = new Set();
    groupedEntries().forEach((groupData, index) => {
      desiredDays.add(groupData.day);
      let group = dayGroups.get(groupData.day);
      const newGroup = !group;
      if (!group) group = createDayGroup(groupData.day);
      // 错峰入场 stagger：日期组按序号延迟（与学习页卡片 --study-row-index 一致）
      group.style.setProperty('--ledger-row-index', String(Math.min(index, 7)));
      const header = group.querySelector('header');
      header.hidden = state.viewMode === 'cumulative';
      header.querySelector('strong').textContent = state.viewMode === 'cumulative'
        ? '' : formatDayHeading(groupData.day);
      header.querySelector('span').textContent = state.viewMode === 'cumulative'
        ? '' : groupData.entries.length + ' ' + T('笔');
      const rows = group.querySelector('[data-ledger-day-rows]');
      groupData.entries.forEach((entry, rowIndex) => {
        desiredIds.add(entry.id);
        let row = entryRows.get(entry.id);
        const isNew = !row;
        if (!row) row = createEntryRow(entry); else syncEntryRow(row, entry);
        const expected = rows.children[rowIndex] || null;
        if (expected !== row) rows.insertBefore(row, expected);
        // 切页静音：整版淡出入场期间不叠加条目级入场动画，新条目直接就位
        // （与学习页 incrementalSyncCardList 的 pageSwitch silent 一致）。
        if (!opts.silent && (isNew || opts.newIds && opts.newIds.has(entry.id))) {
          replayClass(row, 'quick-enter', 320);
        }
      });
      const expectedGroup = dom.groups.children[index] || null;
      if (expectedGroup !== group) dom.groups.insertBefore(group, expectedGroup);
      // 切页静音：整版淡出入场期间不叠加组级入场动画（与学习页 pageSwitch silent 一致）
      if (newGroup && !opts.silent) replayClass(group, 'ledger-day-entering', 320);
    });
    entryRows.forEach((row, id) => {
      if (!desiredIds.has(id)) { row.remove(); entryRows.delete(id); }
    });
    dayGroups.forEach((group, day) => {
      if (!desiredDays.has(day)) { group.remove(); dayGroups.delete(day); }
    });
    const hasEntries = desiredIds.size > 0;
    dom.groups.hidden = !hasEntries; dom.empty.hidden = hasEntries;
    window.requestAnimationFrame(() => animateEntryChanges(previous));
    revealHighlightedEntry();
  }

  function syncLedger(options) {
    if (!state.mounted) return;
    state.payload = computePayload();
    syncViewMode(); dom.monthTitle.textContent = monthTitle();
    dom.empty.querySelector('span').textContent = currentUnit() || '¥';
    syncSummary(); syncEntries(options);
  }
  function revealHighlightedEntry() {
    if (!state.highlightId) return;
    const highlighted = entryRows.get(state.highlightId);
    if (!highlighted) return;
    state.highlightId = '';
    highlighted.classList.add('is-highlighted');
    highlighted.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    window.setTimeout(() => highlighted.classList.remove('is-highlighted'), reducedMotion ? 0 : 900);
  }

  function cancelMainRequest() {
    if (state.controller) state.controller.abort();
    state.controller = null; state.requestSeq += 1;
  }

  // 整本账本只取一次：未加载时请求（复用空闲预热 promise），已加载直接返回并同步渲染。
  function loadLedger(options) {
    const opts = options || {};
    if (state.ledger && !opts.force) {
      if (opts.sync !== false) syncLedger({ skipFlip: !!opts.skipFlip, silent: !!opts.entrance });
      if (opts.entrance) startPageEntrance();
      return Promise.resolve(state.ledger);
    }
    root.classList.add('is-loading');
    if (opts.sync !== false) syncLedger({ skipFlip: true, silent: !!opts.entrance });
    const requestId = ++state.requestSeq;
    const pending = !opts.force && state.warmupPromise
      ? state.warmupPromise
      : (() => {
        if (state.controller) state.controller.abort();
        const controller = new AbortController(); state.controller = controller;
        return request('/api/ledger', { signal: controller.signal });
      })();
    return pending.then((payload) => {
      if (requestId !== state.requestSeq) return null;
      applyLedgerPayload(payload);
      root.classList.remove('is-loading');
      syncLedger({ skipFlip: true });
      if (opts.entrance) startPageEntrance();
      return payload;
    }).catch((error) => {
      if (error && error.name === 'AbortError') return null;
      if (requestId === state.requestSeq) {
        root.classList.remove('is-loading');
        // 请求失败也要把内容恢复可见，不能停在整体淡出的透明态。
        if (opts.entrance) startPageEntrance();
        showToast(error.message);
      }
      return null;
    }).finally(() => { if (requestId === state.requestSeq) state.controller = null; });
  }

  function createDraft() {
    if (state.draft) {
      // 单例草稿：在其他页时把它搬回当前页（切页不丢草稿，点 ＋ 只认当前页）。
      if (normalizePage(state.draft.ledgerPage) !== state.page) {
        state.draft.ledgerPage = state.page;
        const today = new Date();
        state.draft.date = state.viewMode === 'cumulative'
          ? monthKey(today.getFullYear(), today.getMonth() + 1) + '-' + String(today.getDate()).padStart(2, '0')
          : currentMonthDefaultDate(state.year, state.month);
        const previous = captureEntryRects();
        syncEntries({ previousRects: previous });
      }
      const existing = entryRows.get(DRAFT_ID);
      if (existing) {
        existing.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        existing.focus({ preventScroll: true }); replayClass(existing, 'ledger-entry-attention', 420);
      }
      return;
    }
    const previous = captureEntryRects();
    const today = new Date();
    const clientId = 'le_' + window.crypto.randomUUID().replace(/-/g, '');
    state.draft = { id: DRAFT_ID, clientId, type: 'expense', amountCents: null, multiplier: null,
      ledgerPage: state.page, date: state.viewMode === 'cumulative'
        ? monthKey(today.getFullYear(), today.getMonth() + 1) + '-' + String(today.getDate()).padStart(2, '0')
        : currentMonthDefaultDate(state.year, state.month), note: '', color: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    syncEntries({ previousRects: previous, newIds: new Set([DRAFT_ID]) });
    window.requestAnimationFrame(() => {
      const row = entryRows.get(DRAFT_ID);
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
        row.focus({ preventScroll: true });
      }
    });
  }

  function discardDraft(options) {
    if (!state.draft) return;
    if (state.settings && state.settings.id === DRAFT_ID) closeSettings(false, true);
    const row = entryRows.get(DRAFT_ID);
    const previous = captureEntryRects(); state.draft = null;
    if (options && options.instant || reducedMotion || !row) {
      syncEntries({ previousRects: previous }); return;
    }
    row.classList.add('is-leaving');
    window.setTimeout(() => syncEntries({ previousRects: previous }), 300);
  }

  function findEntry(id) {
    if (id === DRAFT_ID) return state.draft;
    return (state.ledger && state.ledger.entries || []).find((entry) => entry.id === id) || null;
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
    viewField.append(viewLabel, viewSwitch);
    const hideField = document.createElement('div'); hideField.className = 'ledger-settings-field ledger-view-field';
    const hideLabel = document.createElement('span'); hideLabel.textContent = T('金额显示');
    const hideSwitch = document.createElement('div');
    hideSwitch.className = 'ledger-type-switch'; hideSwitch.setAttribute('role', 'group');
    hideSwitch.setAttribute('aria-label', T('金额小数'));
    [['shown', '含小数'], ['hidden', '隐藏小数']].forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.ledgerHideDecimals = item[0];
      const active = state.hideDecimals === (item[0] === 'hidden');
      button.textContent = T(item[1]); button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false'); hideSwitch.appendChild(button);
    });
    hideField.append(hideLabel, hideSwitch); fields.append(field, viewField, hideField);
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
      const hide = event.target.closest('[data-ledger-hide-decimals]');
      if (hide) {
        box.querySelectorAll('[data-ledger-hide-decimals]').forEach((button) => {
          const active = button === hide; button.classList.toggle('is-active', active);
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
    // 已打开时再点同一按钮收回（与账目行「⋯」一致）；弹层打开期间点按钮本身不关闭。
    if (state.unitPopover) { closeUnitSettings(true); return; }
    if (!dom.pageSettings) return;
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
    const activeHide = box.querySelector('[data-ledger-hide-decimals].is-active');
    const nextHideDecimals = !!(activeHide && activeHide.dataset.ledgerHideDecimals === 'hidden');
    const error = box.querySelector('[data-role="ledger-unit-error"]');
    if (unit.length > 12) { error.textContent = T('金额单位最多 12 个字符'); input.focus(); return; }
    const page = state.page;
    const previousUnit = currentUnit();
    state.viewMode = nextViewMode; setViewForPage(page, nextViewMode);
    state.hideDecimals = nextHideDecimals; setHideForPage(page, nextHideDecimals);
    if (unit === previousUnit) {
      closeUnitSettings(false); syncLedger({ skipFlip: true }); return;
    }
    state.unitSaving = true; box.classList.add('is-saving');
    box.querySelectorAll('button, input').forEach((control) => { control.disabled = true; });
    const save = box.querySelector('[data-ledger-unit-save]'); if (save) save.textContent = T('正在保存');
    applyLocalPageUnit(page, unit); syncLedger({ skipFlip: true });
    const seq = nextMutation('unit:' + page);
    postInOrder('unit:' + page, '/api/ledger-page-unit', { page, unit }).then((result) => {
      acceptMutationRevision(result.revision);
      if (!mutationCurrent('unit:' + page, seq)) return;
      applyLocalPageUnit(result.page, result.unit); closeUnitSettings(false);
      syncLedger({ skipFlip: true });
    }).catch((requestError) => {
      scheduleLedgerReload();
      if (!mutationCurrent('unit:' + page, seq)) return;
      applyLocalPageUnit(page, previousUnit);
      if (!state.unitPopover) { syncLedger({ skipFlip: true }); showToast(requestError.message); return; }
      state.unitSaving = false; box.classList.remove('is-saving');
      box.querySelectorAll('button, input').forEach((control) => { control.disabled = false; });
      if (save) save.textContent = T('保存');
      error.textContent = requestError.message; if (input) input.focus(); syncLedger({ skipFlip: true });
    });
  }

  function setSettingsError(message) {
    const error = state.settingsPopover && state.settingsPopover.querySelector('[data-role="ledger-settings-error"]');
    if (error) error.textContent = message || '';
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

  // 乐观更新只改目标账目；mutation 成功合并服务端增量，失败也只回滚该目标。
  function applyLocalEntry(previousEntry, nextEntry) {
    if (!state.ledger) state.ledger = { version: 2, revision: 0,
      highestPage: 1, pageUnits: {}, entries: [] };
    model.upsertEntry(state.ledger, previousEntry.id, nextEntry);
    recomputeHighestPage();
  }

  function applyLocalPageUnit(page, unit) {
    if (!state.ledger) state.ledger = { version: 2, revision: 0,
      highestPage: 1, pageUnits: {}, entries: [] };
    model.setPageUnit(state.ledger, page, unit);
    recomputeHighestPage();
  }

  function removeLocalEntry(entry) {
    if (!state.ledger) return;
    model.removeEntry(state.ledger, entry.id);
    recomputeHighestPage();
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
      const draft = state.draft;
      const now = new Date().toISOString();
      const optimisticEntry = { id: draft.clientId, ...values,
        ledgerPage: draft.ledgerPage, color: draft.color || '',
        createdAt: draft.createdAt || now, updatedAt: now, pending: true };
      const retryDraft = { ...draft, ...values, id: DRAFT_ID, pending: false, updatedAt: now };
      const target = monthFromDay(optimisticEntry.date);
      const previousRects = captureEntryRects();
      applyLocalEntry({ id: optimisticEntry.id }, optimisticEntry);
      state.draft = null; closeSettings(false);
      if (state.viewMode !== 'cumulative') { state.year = target.year; state.month = target.month; }
      state.page = normalizePage(optimisticEntry.ledgerPage);
      state.viewMode = viewForPage(state.page);
      state.hideDecimals = hideDecimalsForPage(state.page); saveCurrentPage(); renderPageRail();
      state.highlightId = optimisticEntry.id;
      syncLedger({ previousRects, newIds: new Set([optimisticEntry.id]) });
      postTracked('/api/ledger-entry-create', { id: optimisticEntry.id, ...values,
        ledgerPage: optimisticEntry.ledgerPage,
        color: optimisticEntry.color }).then((result) => {
        acceptMutationRevision(result.revision);
        applyLocalEntry(optimisticEntry, result.entry);
        syncLedger();
      }).catch((error) => {
        scheduleLedgerReload();
        const current = findEntry(optimisticEntry.id);
        if (current && current.pending) removeLocalEntry(current);
        if (!state.draft) state.draft = retryDraft;
        syncLedger({ newIds: new Set([DRAFT_ID]) });
        showToast(error.message);
      });
      return;
    }

    const oldEntry = { ...entry }; const nextEntry = { ...entry, ...values, updatedAt: new Date().toISOString() };
    const oldMonth = monthFromDay(oldEntry.date); const nextMonth = monthFromDay(nextEntry.date);
    const previousRects = captureEntryRects(); const seq = nextMutation(id);
    applyLocalEntry(oldEntry, nextEntry); closeSettings(false);
    if (state.viewMode !== 'cumulative'
        && (nextMonth.year !== state.year || nextMonth.month !== state.month)) {
      state.year = nextMonth.year; state.month = nextMonth.month;
      beginMonthMotion(nextMonth.year * 12 + nextMonth.month > oldMonth.year * 12 + oldMonth.month ? 1 : -1);
    }
    state.highlightId = id; syncLedger({ previousRects });
    postInOrder(id, '/api/ledger-entry-update', { id, ...values }).then((result) => {
      acceptMutationRevision(result.revision);
      if (!mutationCurrent(id, seq)) return;
      applyLocalEntry(nextEntry, result.entry); syncLedger();
    }).catch((error) => {
      scheduleLedgerReload();
      if (!mutationCurrent(id, seq)) return;
      applyLocalEntry(nextEntry, oldEntry);
      if (state.viewMode !== 'cumulative') { state.year = oldMonth.year; state.month = oldMonth.month; }
      state.highlightId = id; syncLedger({ newIds: new Set([id]) }); showToast(error.message);
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
    const oldEntry = { ...entry }; const previousRects = captureEntryRects();
    const row = entryRows.get(id); const seq = nextMutation(id);
    closeSettings(false); removeLocalEntry(entry);
    state.payload = computePayload(); syncSummary();
    if (row && !reducedMotion) {
      row.classList.add('is-leaving'); window.setTimeout(() => syncEntries({ previousRects }), 300);
    } else syncEntries({ previousRects });
    postInOrder(id, '/api/ledger-entry-delete', { id }).then((result) => {
      acceptMutationRevision(result.revision);
      if (!mutationCurrent(id, seq)) return;
      removeLocalEntry(oldEntry); syncLedger();
    }).catch((error) => {
      scheduleLedgerReload();
      if (!mutationCurrent(id, seq)) return;
      applyLocalEntry(oldEntry, oldEntry); state.highlightId = id;
      syncLedger({ newIds: new Set([id]) }); showToast(error.message);
    });
  }

  function setEntryColor(entry, value) {
    if (entry.id === DRAFT_ID) {
      entry.color = value;
      const draftRow = entryRows.get(DRAFT_ID);
      if (draftRow) { syncEntryRow(draftRow, entry); replayClass(draftRow, 'ledger-entry-color-updated', 380); }
      return;
    }
    const oldEntry = { ...entry }; const nextEntry = { ...entry, color: value,
      updatedAt: new Date().toISOString() }; const seq = nextMutation(entry.id);
    applyLocalEntry(entry, nextEntry);
    const row = entryRows.get(entry.id);
    if (row) { syncEntryRow(row, nextEntry); replayClass(row, 'ledger-entry-color-updated', 380); }
    postInOrder(entry.id, '/api/ledger-entry-update', { id: entry.id, color: value }).then((result) => {
      acceptMutationRevision(result.revision);
      if (!mutationCurrent(entry.id, seq)) return;
      applyLocalEntry(nextEntry, result.entry); if (row) syncEntryRow(row, result.entry);
    }).catch((error) => {
      scheduleLedgerReload();
      if (!mutationCurrent(entry.id, seq)) return;
      applyLocalEntry(nextEntry, oldEntry); if (row) syncEntryRow(row, oldEntry); showToast(error.message);
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
    // 打断挂起的切页交接：切月走自己的滑动动画，不能让账目区残留位移。
    state.pageSwitchSeq += 1;
    clearPageSwitchMotion();
    const next = shiftedMonth(state.year, state.month, delta);
    state.year = next.year; state.month = next.month; beginMonthMotion(delta);
    syncLedger({ skipFlip: true });
  }

  // 切页保持页头、卡片外壳和纸面稳定：旧/新汇总文字与流水在原位双层交叉淡化。
  // 流水舞台在当前可见会话内只增高不缩短，避免不同页内容长度让底边跳动。
  function changePage(page) {
    const next = normalizePage(page);
    if (next === state.page) { renderPageRail(); return; }
    closeSettings(false, true); closeUnitSettings(false, true);
    if (paletteController) paletteController.close(false, true);
    stopPageEntrance();
    clearPageSwitchMotion();
    const animate = !reducedMotion && state.active && dom.page;
    if (animate) preparePageCrossfade();
    state.page = next; state.viewMode = viewForPage(next);
    state.hideDecimals = hideDecimalsForPage(next);
    state.highlightId = ''; saveCurrentPage(); renderPageRail();
    state.pageSwitchSeq += 1;
    syncLedger({ skipFlip: true, silent: true });
    if (animate) startPageCrossfade();
  }

  function preparePageCrossfade() {
    if (!dom.page || !dom.flow) return;
    state.pageCrossfading = true;
    const outgoing = document.createElement('div');
    outgoing.className = 'ledger-flow-outgoing';
    outgoing.setAttribute('aria-hidden', 'true'); outgoing.toggleAttribute('inert', true);
    outgoing.append(dom.groups.cloneNode(true), dom.empty.cloneNode(true));
    dom.flow.appendChild(outgoing);
    dom.summary.querySelectorAll('[data-ledger-summary-kind]').forEach((card) => {
      const clone = document.createElement('div'); clone.className = 'ledger-summary-outgoing';
      clone.setAttribute('aria-hidden', 'true'); clone.toggleAttribute('inert', true);
      Array.from(card.children).forEach((child) => clone.appendChild(child.cloneNode(true)));
      card.appendChild(clone);
    });
    const oldHeight = dom.flow.getBoundingClientRect().height;
    state.flowHeightFloor = Math.max(state.flowHeightFloor, oldHeight);
    dom.flow.style.minHeight = state.flowHeightFloor + 'px';
    dom.flow.style.height = oldHeight + 'px';
    dom.page.classList.add('ledger-page-crossfade-ready');
  }

  function startPageCrossfade() {
    if (!dom.page || !dom.flow) return;
    // 同一事件任务内短暂释放高度以测量新内容，不会产生可见布局帧。
    dom.flow.style.height = '';
    const newHeight = dom.flow.getBoundingClientRect().height;
    state.flowHeightFloor = Math.max(state.flowHeightFloor, newHeight);
    dom.flow.style.minHeight = state.flowHeightFloor + 'px';
    dom.flow.style.height = state.flowHeightFloor + 'px';
    void dom.flow.offsetWidth;
    window.cancelAnimationFrame(state.pageSwitchFrame);
    state.pageSwitchFrame = window.requestAnimationFrame(() => {
      state.pageSwitchFrame = 0;
      if (!dom.page) return;
      dom.page.classList.remove('ledger-page-crossfade-ready');
      dom.page.classList.add('ledger-page-crossfade-active');
    });
    state.pageSwitchTimer = window.setTimeout(() => {
      state.pageSwitchTimer = 0; clearPageSwitchMotion();
    }, PAGE_SWITCH_MS + 40);
  }

  function clearPageSwitchMotion() {
    window.clearTimeout(state.pageSwitchTimer); state.pageSwitchTimer = 0;
    window.cancelAnimationFrame(state.pageSwitchFrame); state.pageSwitchFrame = 0;
    if (dom.page) dom.page.classList.remove('ledger-page-crossfade-ready', 'ledger-page-crossfade-active');
    root.querySelectorAll('.ledger-flow-outgoing, .ledger-summary-outgoing').forEach((item) => item.remove());
    if (dom.flow) {
      dom.flow.style.height = '';
      dom.flow.style.minHeight = state.flowHeightFloor ? state.flowHeightFloor + 'px' : '';
    }
    state.pageCrossfading = false;
  }

  function resetFlowHeightFloor() {
    clearPageSwitchMotion(); state.flowHeightFloor = 0;
    if (dom.flow) dom.flow.style.minHeight = '';
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
      const open = event.target.closest('[data-ledger-entry-open]');
      if (open) {
        const row = open.closest('[data-ledger-entry]'); openSettings(row.dataset.ledgerEntry, open); return;
      }
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
      if (!row || event.target.closest('[data-ledger-entry-menu], input, a')) return;
      event.preventDefault(); event.stopPropagation(); openEntryPalette(row, event);
    });
    root.addEventListener('keydown', (event) => {
      const chip = event.target.closest('[data-ledger-legend-index]');
      if (chip && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); openLegendPalette(chip, null); return;
      }
      const open = event.target.closest('[data-ledger-entry-open]');
      const row = open && open.closest('[data-ledger-entry]');
      if (!row) return;
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        event.preventDefault(); openEntryPalette(row, null);
      }
    });
  }

  // —— 整版错峰入场：与学习页一致，纯 CSS class（.is-revealing）驱动，
  //    不使用 WAAPI element.animate（其 pending 帧会造成“完整内容闪一帧”的闪烁）。
  function startPageEntrance() {
    if (!dom.page || reducedMotion || !state.active) return;
    window.clearTimeout(state.entranceTimer);
    void dom.page.offsetWidth;
    dom.page.classList.add('is-revealing');
    state.entranceTimer = window.setTimeout(() => {
      state.entranceTimer = 0;
      if (dom.page) dom.page.classList.remove('is-revealing');
    }, 1450);
  }

  function stopPageEntrance() {
    window.clearTimeout(state.entranceTimer);
    state.entranceTimer = 0;
    if (dom.page) dom.page.classList.remove('is-revealing');
  }

  // 首屏空闲时预取整本账本：用户第一次翻进记账视图直接消费内存快照。
  function warmup() {
    if (state.ledger || state.warmupPromise) return state.warmupPromise;
    const run = () => {
      if (state.ledger) return;
      state.warmupPromise = request('/api/ledger')
        .then((payload) => { applyLedgerPayload(payload); return payload; })
        .catch(() => null)
        .finally(() => { state.warmupPromise = null; });
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1400 });
    else window.setTimeout(run, 260);
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
    resetFlowHeightFloor();
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
    state.active = false; discardDraft({ instant: true }); cancelMainRequest();
    resetFlowHeightFloor();
    closeSettings(false, true); closeUnitSettings(false, true);
    if (paletteController) paletteController.close(false, true);
  });

  mount();
  // 与起步页其他重页一样，首屏空闲时就预取整本账本，
  // 用户第一次翻到记账视图时直接消费内存快照。
  warmup();
  window.CanvasLedger = {
    activate() {
      state.active = true;
      // 保险清理：切页交接若被离页/重入打断，不能残留透明度、位移或入场动画。
      clearPageSwitchMotion();
      if (dom.page) {
        dom.page.classList.remove('is-revealing');
      }
      if (!state.activatedOnce) {
        const today = new Date(); state.year = today.getFullYear(); state.month = today.getMonth() + 1;
        state.activatedOnce = true;
      }
      renderPageRail(); window.requestAnimationFrame(renderPageRail);
      syncLedger({ skipFlip: true }); startPageEntrance();
      loadLedger({ sync: false });
    },
    deactivate() {
      state.active = false;
      resetFlowHeightFloor();
      if (dom.page) {
        dom.page.classList.remove('is-revealing');
      }
      setPageRailVisible(false);
      stopPageEntrance();
      discardDraft({ instant: true }); cancelMainRequest(); closeSettings(false, true);
      closeUnitSettings(false, true);
      if (paletteController) paletteController.close(false, true);
    },
    finalizeExitMotion() { if (!state.active) stopPageEntrance(); },
    warmup,
    getMonth() { return { year: state.year, month: state.month }; },
  };
})();

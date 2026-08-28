const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('assets/index.html');
const start = read('assets/start.js');
const calendar = read('assets/calendar.js');
const ledger = read('assets/ledger.js');
const styles = read('assets/styles.css');
const backend = read('app.py');

// 日历和记账必须是同一页内两个真正隔离的叠层，隐藏层不参与布局、焦点或辅助技术。
assert(index.includes('data-role="calendar-shell"'), 'calendar layer is missing');
assert(index.includes('data-role="ledger-shell"'), 'ledger layer is missing');
assert(index.includes('aria-hidden="true" inert hidden'), 'ledger starts hidden and inert');
assert(index.includes('<script src="ledger.js" defer></script>'), 'ledger runtime is not loaded');
assert(styles.includes('.calendar-mode-stage') && styles.includes('grid-area: 1 / 1'), 'internal layers are not overlaid');

// 再次点击已激活的书脊只委托给日历协调层，内部模式和无障碍状态由一处维护。
assert(start.includes('window.CanvasCalendar.toggleMode()'), 'repeat spine click does not toggle calendar mode');
assert(calendar.includes("const VIEW_MODE_KEY = 'calendar:viewMode:v1'"), 'view preference key is missing');
assert(calendar.includes('toggleMode()') && calendar.includes('getViewMode()'), 'calendar public mode contract is incomplete');
assert(calendar.includes("layer.toggleAttribute('inert', !active)"), 'hidden mode is not made inert');
assert(calendar.includes("layer.setAttribute('aria-hidden', active ? 'false' : 'true')"), 'mode aria-hidden is not synchronized');
assert(calendar.includes('api.activate()') && calendar.includes('api.deactivate()'), 'ledger lifecycle is not coordinated');

// 锚定设置卡包含收支、金额、可选倍率、日期和可选备注；已有流水支持进入编辑和同槽二次删除。
for (const marker of ["['expense', 'income']", 'ledgerAmount', 'ledgerMultiplier', 'ledgerDate', 'ledgerNote']) {
  assert(ledger.includes(marker), `missing compact editor field: ${marker}`);
}
assert(ledger.includes('dataset.ledgerEntry = entry.id') && ledger.includes("event.key === 'Enter'"), 'entries are not keyboard editable');
assert(ledger.includes("' × '") && ledger.includes("' = '") && ledger.includes('effectiveAmountCents(entry)'),
  'multiplier expression or final-amount calculation is missing');
assert(ledger.includes('deleteArmed') && ledger.includes("T('确认删除')"), 'same-slot delete confirmation is missing');
assert(ledger.includes("event.key !== 'Escape'") && ledger.includes('closeSettings(true)'), 'Escape does not close settings');

// 页壳只 mount 一次；交互后只按 ID 移动/更新卡片，不得整页重建。
assert(ledger.includes('function mount()') && ledger.includes('root.appendChild(template.content)'), 'persistent ledger shell is missing');
assert(!ledger.includes('root.innerHTML'), 'ledger interactions still replace the full page');
assert(ledger.includes('function syncEntryRow(') && ledger.includes('function syncEntries('), 'keyed incremental card sync is missing');
assert(ledger.includes('captureEntryRects') && ledger.includes('animateEntryChanges'), 'ledger FLIP motion is missing');
assert(ledger.includes("row.classList.add('is-leaving')") && ledger.includes("'quick-enter'"), 'study-style card enter/exit motion is missing');

// ＋ 只创建一张本地草稿，保存前不发起创建请求；切月和离页丢弃。
const createDraftSection = ledger.slice(ledger.indexOf('function createDraft()'), ledger.indexOf('function discardDraft'));
assert(createDraftSection.includes('if (state.draft)') && createDraftSection.includes('amountCents: null'), 'single local draft is missing');
assert(createDraftSection.includes('DRAFT_ID') && !createDraftSection.includes('/api/ledger-entry-create'), 'plus persists before the draft is valid');
assert(ledger.includes("currentUnit() ? '—' + currentUnit() : '¥—'"), 'draft amount placeholder is missing');
assert(ledger.includes("discardDraft({ instant: true })"), 'draft is not discarded on month/page exit');
assert(ledger.includes('if (state.settings.id === DRAFT_ID)') && ledger.includes('discardDraft();'), 'draft settings cannot delete the local draft');
assert(!ledger.includes('draggable'), 'ledger must keep deterministic date ordering without drag state');

// 记账只保留月导航、四个无文字色块和单一新增入口，不混入首版明确排除的复杂功能。
assert(ledger.includes("const fallback = ['', '', '', '']") && ledger.includes('raw.colors.length !== 4'), 'four visual legend chips are missing');
assert(ledger.includes("const LEGEND_KEY = 'ledger:legend:v1'"), 'legend preference key is missing');
assert(ledger.includes("const PAGE_KEY = 'ledger:page:v1'") && ledger.includes('const PAGE_MAX = 99'),
  'ledger page preference or range is missing');
assert(ledger.includes('data-ledger-page-rail') && ledger.includes('data-ledger-page-orb')
  && ledger.includes('data-ledger-page-list'), 'right-edge ledger page rail is missing');
assert(ledger.includes('PAGE_EDGE_PX') && ledger.includes('setPageRailVisible')
  && ledger.includes("closest('[data-ledger-page]')"), 'ledger page hover or click switching is missing');
assert(ledger.includes('function ledgerCacheKey(year, month, page, viewMode)') && ledger.includes("'&page='"),
  'ledger cache and requests are not page-aware');
assert(ledger.includes('data-ledger-page-settings') && ledger.includes('data-ledger-unit')
  && ledger.includes("'/api/ledger-page-unit'"), 'per-page amount unit editor is missing');
assert(ledger.includes("const VIEW_KEY = 'ledger:view:v1'") && ledger.includes('data-ledger-view')
  && ledger.includes("'cumulative'") && ledger.includes("'&scope=all'"),
  'remembered monthly/cumulative ledger view is missing');
assert(ledger.includes("dateField.hidden = state.viewMode === 'cumulative'")
  && ledger.includes("header.hidden = state.viewMode === 'cumulative'")
  && styles.includes('.ledger-cumulative-view .ledger-summary-card small'),
  'cumulative view does not hide date/month-only UI');
assert(ledger.includes("customUnit ? sign + formatted + customUnit")
  && ledger.includes("sign + '¥' + formatted"), 'custom suffix unit or RMB fallback formatting is missing');
assert(ledger.includes('data-ledger-month="-1"') && ledger.includes('data-ledger-month="1"'), 'month navigation is missing');
assert(ledger.includes('data-ledger-add') && ledger.includes("closest('[data-ledger-add]')"), 'single add entry point is missing');
for (const forbidden of ['月预算', '趋势图', '搜索账', '批量账', '账目分类', '多账户', '周期账单']) {
  assert(!ledger.includes(forbidden), `forbidden first-version feature leaked into ledger: ${forbidden}`);
}

// 自定义色不替代收入/支出语义；数据请求具备乱序保护、取消、缓存与空闲相邻月预取。
assert(ledger.includes("entry.type === 'income'") && ledger.includes("income ? T('收入') : T('支出')")
  && ledger.includes('const signedCents = income ? entry.amountCents : -entry.amountCents'), 'income/expense text and sign semantics are missing');
assert(ledger.includes('RelatumStudyPalette.createPopoverController'), 'shared animated palette controller is not reused');
assert(styles.includes('.study-route-color-palette') && styles.includes('grid-template-columns: repeat(4, 1fr)'), 'shared palette is not 4 by 3');
assert(!styles.includes('.ledger-color-popover'), 'duplicate ledger-only palette remains');
assert(ledger.includes('new AbortController()') && ledger.includes('requestSeq'), 'stale month response protection is missing');
assert(ledger.includes('requestIdleCallback') && ledger.includes('scheduleNeighborPrefetch'), 'adjacent month idle prefetch is missing');
assert(ledger.includes('mount();') && ledger.includes('warmup();'), 'current-month ledger is not warmed during start-page idle time');
assert(styles.includes('@media (prefers-reduced-motion: reduce)') && styles.includes('.ledger-shell'), 'reduced-motion fallback is missing');

// 前后端接口与 v1 文件、备份/损坏隔离和原子替换契约必须同时存在。
assert(backend.includes('LEDGER_FILE = DATA / "ledger.json"'), 'ledger data file is missing');
assert(backend.includes('LEDGER_BACKUP_FILE = DATA / "ledger.backup.json"'), 'ledger backup file is missing');
assert(backend.includes('ledger.corrupt-'), 'corrupt ledger isolation is missing');
assert(backend.includes('_atomic_write_json(LEDGER_FILE, payload)'), 'ledger does not use the shared atomic writer');
assert(backend.includes('def _ledger_multiplier(') && backend.includes('def _ledger_effective_amount('),
  'ledger multiplier validation or effective amount calculation is missing');
assert(backend.includes('LEDGER_PAGE_MAX = 99') && backend.includes('def _ledger_page(')
  && backend.includes('q.get("page", [None])[0]'), 'ledger page validation or GET parameter is missing');
assert(backend.includes('"ledgerPage"') && backend.includes('"highestPage"'),
  'ledger entry page or highest-page metadata is missing');
assert(backend.includes('def _ledger_page_unit(') && backend.includes('def ledger_page_unit_update(')
  && backend.includes('"pageUnits"'), 'per-page amount unit persistence is missing');
assert(backend.includes('scope_value not in {"month", "all"}')
  && backend.includes('"cumulative": ledger_month_payload('),
  'backend cumulative page snapshot is missing');
for (const route of ['/api/ledger', '/api/ledger-entry-create', '/api/ledger-entry-update',
  '/api/ledger-entry-delete', '/api/ledger-page-unit']) {
  assert(backend.includes(route), `missing ledger route: ${route}`);
}

console.log('calendar ledger contract tests passed');

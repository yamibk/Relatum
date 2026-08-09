const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('assets', 'index.html');
const focus = read('assets', 'focus.js');
const start = read('assets', 'start.js');
const styles = read('assets', 'styles.css');
const i18n = read('assets', 'i18n.js');

assert(html.includes('<link rel="preload" href="focus.js" as="script">')
  && html.includes('window.RelatumBoot.focus = {')
  && html.includes("daily: preloadJson('/api/daily')")
  && html.includes("sessions: preloadJson('/api/focus')")
  && html.includes("study: preloadJson('/api/study')"),
  'the start document must begin loading the Focus module and its small datasets during parsing');

[
  'data-role="focus-timer-view"',
  'class="focus-daily focus-daily-view"',
  'data-role="focus-daily-count"',
  'data-action="daily-compose-toggle"',
  'data-role="focus-daily-skeleton"',
  'class="focus-daily-content"',
  'class="focus-daily-scroll" data-role="focus-daily-scroll" tabindex="-1"',
  'data-role="focus-daily-composer" hidden',
  'data-phase="hidden" aria-hidden="true"',
  'class="focus-daily-celebrate-inner"',
  'class="focus-daily-star-gather"',
  'class="focus-daily-star-halo"',
  'class="focus-daily-star-dot dot-far-left"',
  'class="focus-daily-star-dot dot-near-left"',
  'class="focus-daily-star-main"',
  'class="focus-daily-star-dot dot-near-right"',
  'class="focus-daily-star-dot dot-far-right"',
  'class="focus-daily-celebrate-copy"',
  'aria-atomic="true"',
  'id="focus-daily-celebrate-title">今日清单已全部完成</strong>',
  'class="focus-daily-review-today" data-action="daily-review-today">回顾今日</button>',
].forEach((needle) => assert(html.includes(needle), 'missing focus dual-view markup: ' + needle));

[
  'focus-daily-handle',
  'data-action="daily-toggle"',
  'data-action="daily-close"',
  'data-action="daily-peek"',
  'focus-daily-celebrate-burst',
  'focus-daily-star-trail',
  'focus-daily-star-path',
  'focus-daily-star-particles',
  '每日任务（Tab 开合）',
].forEach((needle) => assert(!html.includes(needle), 'legacy daily sidebar markup remains: ' + needle));

[
  "const VIEW_MODE_KEY = 'focus:viewMode'",
  "const DAILY_REVIEWED_KEY = 'focus:dailyReviewedDate'",
  "localStorage.getItem(VIEW_MODE_KEY) === 'timer' ? 'timer' : 'daily'",
  "localStorage.setItem(VIEW_MODE_KEY, viewMode)",
  'function sessionLocksView()',
  'return !!(running || pendingSession);',
  "toast('请先完成收尾或重置当前专注段，再查看每日任务')",
  'function toggleViewMode()',
  'function showTimerView(options)',
  'function prepareFocusActivation(options)',
  'function deactivateFocusView()',
  'prepareActivate(options)',
  'deactivate: deactivateFocusView',
  'const controller = typeof AbortController',
  "if (String(path || '').startsWith('/api/daily-')) cancelDailyRead();",
  'if (requestId !== dailyRequestSeq) return false;',
  'nextSignature !== dailySignature',
  'const dailyToggleStates = new Map();',
  'function drainDailyToggle(id, state)',
  'if (dailyCreatePending) return;',
  'const replayCleanupTimers = new WeakMap();',
  'let dailyCelebrateMotionTimer = 0;',
  'let dailyCelebrateHideTimer = 0;',
  'let dailyCelebrateGeneration = 0;',
  "let dailyCelebratePhase = 'hidden';",
  'let dailyCelebrateFocusTimer = 0;',
  'let dailyCelebrateReturnId = \'\';',
  'const generation = ++dailyCelebrateGeneration;',
  'function updateDailyCelebrateCopy()',
  'function commitDailyCelebratePhase(phase)',
  'function dailyReviewedToday()',
  'function setDailyReviewedToday(reviewed)',
  'function reviewDailyCelebration()',
  "dailyScrollEl.toggleAttribute('inert', blocked);",
  "dailyScrollEl.setAttribute('aria-hidden', blocked ? 'true' : 'false');",
  "dailyRoot.classList.toggle('is-celebration-entering', phase === 'entering');",
  "element.style.setProperty('--daily-exit-order'",
  "if (action.dataset.action === 'daily-review-today') { reviewDailyCelebration(); return; }",
  "if (dailyCelebratePhase === 'entering' || dailyCelebratePhase === 'visible') return;",
  "dailyCelebrateEl.classList.add('is-visible', 'is-entering');",
  "commitDailyCelebratePhase('entering');",
  "commitDailyCelebratePhase('visible');",
  "commitDailyCelebratePhase('leaving');",
  "commitDailyCelebratePhase('hidden');",
  "dailyCelebrateEl.classList.add('is-leaving');",
  "T('今日清单已全部完成')",
  "T('今天做完了 ' + count + ' 件事'",
  'let dailyRevealWaitingForData = false;',
  'function armDailyViewEntranceCleanup()',
  "check.setAttribute('data-i18n-source-aria-label', checkLabel);",
  "loadDaily({ reveal: true, entrance: false });",
  "if (edit) edit.classList.remove('is-saving');",
  "dailyListEl.querySelectorAll('.is-dragging, .is-drag-subtree')",
  "showTimerView({ persist: false, animate: false });",
  "if (action.dataset.action === 'daily-detail-bind' && dailyDetailTaskId)",
  "name.dataset.action = 'daily-detail-open';",
  "name.setAttribute('data-i18n-source-aria-label', detailLabel);",
  "detailCue.className = 'focus-daily-detail-cue';",
  "detailCue.setAttribute('aria-hidden', 'true');",
  'function fillDailyDetailHistorySummary(recent, note, task)',
  'function refreshDailyDetail(task, options)',
  'function handleDailyDetailClick(event)',
  'document.body.appendChild(shell);',
  'toggleMode: toggleViewMode',
  'showTimer(options) { return showTimerView(options); }',
].forEach((needle) => assert(focus.includes(needle), 'missing focus view-state contract: ' + needle));

assert(start.includes("focusActive && window.CanvasFocus && typeof window.CanvasFocus.toggleMode === 'function'"),
  'active Focus spine click must toggle the internal view');
assert(start.includes('window.CanvasFocus.toggleMode();'),
  'Focus spine must delegate view switching to CanvasFocus');
assert(start.includes("typeof window.CanvasFocus.prepareActivate === 'function'"),
  'Focus must prepare its internal view before the outer page becomes visible');
assert(start.indexOf('window.CanvasFocus.prepareActivate(options || {});') < start.indexOf("showView('focus');"),
  'Focus preparation must run before the outer page transition');
assert(start.includes("setFocusActive(true, { forceTimer: true });"),
  'external Focus entries must force the timer before the page transition');
assert(start.includes("typeof window.CanvasFocus.deactivate === 'function'"),
  'leaving Focus must cancel transient view work');
assert(start.includes("document.addEventListener('canvasfocus:ready', finishPendingFocusActivation);"),
  'the start page must replay a first Focus activation once its deferred module is ready');
assert(start.includes('pendingFocusActivation = { options: Object.assign({}, options || {}) };')
  && start.includes('window.CanvasFocus.prepareActivate(pending.options || {});')
  && start.includes('window.CanvasFocus.activate();'),
  'a pre-ready Focus request must preserve its options and perform one complete activation');
assert(start.includes("focusRoot.dataset.pendingForceTimer = options && options.forceTimer ? '1' : '0';")
  && focus.includes("root.dataset.pendingForceTimer === '1' || sessionLocksView()"),
  'pre-ready external entries must force the timer before the Focus module exposes its first frame');
assert(focus.includes("document.dispatchEvent(new CustomEvent('canvasfocus:ready'));"),
  'CanvasFocus must announce readiness after publishing its complete public interface');
assert(focus.includes('function preloadFocusView()')
  && focus.includes('loadDaily({ source: bootFocusData.daily, reveal: false, entrance: false, quiet: true })')
  && focus.includes('preloadFocusView().finally(() => {')
  && focus.indexOf('window.CanvasFocus = canvasFocusApi;') > focus.indexOf('preloadFocusView().finally(() => {'),
  'CanvasFocus must hydrate hidden data before exposing itself as ready');
const pendingFocusBranch = start.slice(
  start.indexOf('pendingFocusActivation = { options: Object.assign({}, options || {}) };'),
  start.indexOf('function runWhenCanvasFocusReady(action)'),
);
assert(!pendingFocusBranch.includes("showView('focus');"),
  'a pre-ready first click must keep the previous page visible instead of showing an empty Focus shell');
const pendingFocusFinish = start.slice(
  start.indexOf('function finishPendingFocusActivation()'),
  start.indexOf("document.addEventListener('canvasfocus:ready'"),
);
assert(pendingFocusFinish.indexOf('window.CanvasFocus.prepareActivate(pending.options || {});')
    < pendingFocusFinish.indexOf("showView('focus');")
  && pendingFocusFinish.indexOf("showView('focus');")
    < pendingFocusFinish.indexOf('window.CanvasFocus.activate();'),
  'the delayed first flip must prepare hydrated DOM, then turn the page, then play one entrance');
assert(start.includes('runWhenCanvasFocusReady((focus) => {')
  && start.includes('if (event.detail.day && focus.showDay)')
  && start.includes('if (focus.prepareTask) focus.prepareTask'),
  'calendar and study Focus intents must survive the same first-load readiness race');
assert(!focus.includes("event.key === 'Tab' && !event.ctrlKey"),
  'Tab must no longer toggle a daily sidebar');
assert(!styles.includes('.focus-daily-handle'),
  'legacy daily sidebar handle styles must be removed');
assert(!styles.includes('.focus-daily.is-open'),
  'legacy daily sidebar open-state styles must be removed');
assert(!focus.includes('function startDailyClear('),
  'all-complete state must not clear the daily list');
[
  'dailyHistoryTaskId',
  'dailyHistoryMonth',
  'daily-history-pop',
  'daily-history-close',
  'daily-history-prev',
  'daily-history-next',
  'daily-history-today',
  "history.textContent = '日'",
].forEach((needle) => assert(!focus.includes(needle), 'legacy daily history entry remains: ' + needle));
assert(!styles.includes('.focus-daily-history'),
  'legacy daily history overlay styles must be removed');
assert(i18n.includes("'查看任务详情 · ': 'View task details · '")
  && i18n.includes("source.match(/^查看任务详情\\s*·\\s*(.+)$/)")
  && !i18n.includes('查看打卡日历'),
  'the unified detail entry must keep an explicit bilingual accessible name and remove the old calendar label');
assert(styles.includes('width: min(1080px, calc(100vw - 96px));')
  && styles.includes('grid-auto-rows: clamp(48px, 5.2vh, 58px);')
  && styles.includes('@media (max-width: 640px)'),
  'unified daily detail must keep the bounded desktop and responsive calendar layout');
assert(styles.includes('grid-template-columns: repeat(3, minmax(0, 1fr));')
  && !focus.includes("dailyDetailStat('today'")
  && !focus.includes("dailyDetailStat('focus'"),
  'daily detail must show only streak, total days, and best streak in its summary row');
assert(focus.includes('closeDailyDetail({ restore: false });'),
  'Escape must close daily detail without forcing focus back onto the task title');
assert(focus.includes("if (event.target === shell) { closeDailyDetail({ restore: false }); return; }"),
  'backdrop dismissal must not force focus back onto the task title');
assert(styles.includes('color-mix(in srgb, var(--bg) 64%, transparent)')
  && styles.includes('rgba(18, 20, 21, 0.7)'),
  'the completion celebration must remain translucent in both light and dark themes');
assert(focus.includes('dailyCelebrationCheck({ animate: !!opts.celebrate && !opts.initial });'),
  'all-complete feedback must remain non-destructive and use the shared state entry');
assert(focus.includes('dailyWasAllDone = allDailyDone();')
  && focus.includes('const became = allDone && !dailyWasAllDone;')
  && focus.includes('renderDaily({ celebrate: true });'),
  'initial all-complete data must render statically while an incomplete-to-complete interaction celebrates once');
assert(focus.includes('if (!dailyTasks.length || (allDailyDone() && !dailyReviewedToday()))')
  && focus.includes('dailyFootEl.hidden = true;'),
  'the ordinary today summary must hide behind an unreviewed completion screen and return after review');
assert(focus.includes("dailyFootEl.hidden = dailyCelebratePhase !== 'hidden';")
  && focus.includes("commitDailyCelebratePhase('hidden');\n      dailyCelebrateHideTimer = 0;\n      updateDailyFoot();"),
  'the ordinary summary must wait for the cancellable signature collapse instead of overlapping it');
assert(focus.includes('if (generation !== dailyCelebrateGeneration || !dailyCelebrateEl) return;')
  && focus.includes('focusDailyCelebrateAction(1720);')
  && focus.includes('}, 2360);') && focus.includes('}, 280);'),
  'celebration and collapse timers must be cancellable and guarded by the latest state generation');
const showCelebrate = focus.slice(
  focus.indexOf('function showDailyCelebrate(animate)'),
  focus.indexOf('function hideDailyCelebrate(options)'),
);
assert(showCelebrate.indexOf("if (dailyCelebratePhase === 'entering' || dailyCelebratePhase === 'visible') return;")
    < showCelebrate.indexOf('const generation = ++dailyCelebrateGeneration;'),
  'a confirming server render must leave an in-flight celebration generation and its timers intact');
const staticCelebrate = showCelebrate.slice(
  showCelebrate.indexOf('if (!animate || prefersReduced)'),
  showCelebrate.indexOf("dailyCelebrateEl.classList.remove('is-entering');", showCelebrate.indexOf('if (!animate || prefersReduced)') + 1),
);
assert(!staticCelebrate.includes('focusDailyCelebrateAction(')
  && !focus.slice(focus.indexOf('activate() {'), focus.indexOf('loadDaily({ reveal: !hadDaily')).includes('focusDailyCelebrateAction('),
  'a restored completion screen must not steal focus when the page is first opened or revisited');
assert(!focus.includes('dailyCelebrateEl.hidden ='),
  'celebration visibility must use reversible layout state instead of display-none hard cuts');

[
  '.focus-daily.focus-daily-view {',
  'backdrop-filter: none;',
  '.focus-daily-view .focus-daily-row {',
  '.focus-daily-view .focus-daily-stat {',
  '.focus-daily-view .focus-daily-group-head {',
  '.focus-daily-skeleton span {',
  'flex: 0 0 auto;',
  '.focus-embedded.focus-view-transition',
  '.focus-embedded > .focus-timer-view,',
  '.focus-embedded > .focus-timer-view {',
  'left: clamp(10px, 0.75vw, 16px);',
  'top: clamp(8px, 1vh, 12px);',
  'grid-template-rows: minmax(0, 1fr);',
  'grid-area: 1 / 1;',
  'height: 100%;',
  'overflow-y: auto;',
  'scrollbar-gutter: auto;',
  'box-sizing: border-box;',
  'animation-delay: calc(150ms + var(--daily-row-index, 0) * 72ms);',
  '@keyframes focus-daily-heading-spring-in',
  '@keyframes focus-daily-card-spring-in',
  '@keyframes focus-daily-support-spring-in',
  '.focus-daily-row.is-complete-pop::after',
  '.focus-daily-composer[hidden]',
  '.focus-daily-create[aria-expanded="true"]',
  '.focus-daily-celebrate-inner {',
  '.focus-daily-star-gather {',
  '.focus-daily-star-dot {',
  '.focus-daily-star-main {',
  '.focus-daily-star-halo {',
  'position: absolute;',
  'place-items: center;',
  '.focus-daily-celebrate.is-visible {',
  '.focus-daily-review-today {',
  '.focus-daily-scroll {',
  'scrollbar-width: none;',
  '.focus-daily-scroll::-webkit-scrollbar',
  '.focus-daily-view.is-celebration-open .focus-daily-scroll',
  '.focus-daily-view.is-celebration-entering .focus-daily-scroll',
  "animation-delay: calc(var(--daily-exit-order, 0) * 48ms);",
  '@keyframes focus-daily-celebration-card-out',
  '@keyframes focus-daily-celebration-support-out',
  '@keyframes focus-daily-star-gather-dot',
  '@keyframes focus-daily-star-gather-main',
  '@keyframes focus-daily-star-gather-halo',
  '.focus-daily-celebrate.is-leaving',
  'body.start-page[data-start-theme="dark"] .focus-daily.focus-daily-view',
  '@media (prefers-reduced-motion: reduce)',
].forEach((needle) => assert(styles.includes(needle), 'missing focus daily-view style: ' + needle));

const focusRootRules = [...styles.matchAll(/\.focus-embedded\s*\{([\s\S]*?)\n\}/g)];
const stableFocusRootRule = focusRootRules.find((match) => match[1].includes('grid-template-rows: minmax(0, 1fr);'));
assert(stableFocusRootRule && stableFocusRootRule[1].includes('grid-template-rows: minmax(0, 1fr);')
  && stableFocusRootRule[1].includes('overflow: hidden;'),
  'focus root must use a fixed grid track and must not own view scrolling');
const focusLayerRule = styles.match(/\.focus-embedded > \.focus-timer-view,\s*\n\.focus-embedded > \.focus-daily-view\s*\{([\s\S]*?)\n\}/);
assert(focusLayerRule && focusLayerRule[1].includes('height: 100%;')
  && focusLayerRule[1].includes('min-height: 0;')
  && !focusLayerRule[1].includes('overflow-y: auto;'),
  'the daily view layer must be a fixed-height non-scrolling overlay host');
const dailyScrollRule = styles.match(/\.focus-daily-scroll\s*\{([\s\S]*?)\n\}/);
assert(dailyScrollRule && dailyScrollRule[1].includes('overflow-y: auto;')
  && dailyScrollRule[1].includes('scrollbar-width: none;')
  && dailyScrollRule[1].includes('width: min(800px, 100%);'),
  'only the centered daily scroll port may scroll, and its native scrollbar must stay hidden');

const viewInKeyframes = styles.match(/@keyframes focus-view-layer-in\s*\{([\s\S]*?)\n\}/);
assert(viewInKeyframes && !viewInKeyframes[1].includes('transform'),
  'internal view crossfade must not move or scale text');
const dailyEntranceKeyframes = styles.match(/@keyframes focus-daily-card-spring-in\s*\{([\s\S]*?)\n\}/);
assert(dailyEntranceKeyframes && dailyEntranceKeyframes[1].includes('translateY(18px) scale(0.975)')
  && dailyEntranceKeyframes[1].includes('translateY(-3px) scale(1.012)')
  && dailyEntranceKeyframes[1].includes('translateY(0) scale(1)'),
  'daily stagger must keep the restored elastic card entrance and settle at identity');
assert(!styles.includes('focus-daily-data-in'),
  'first data reveal must not run a second list-level entrance animation');
assert(focus.includes("replayDailyViewEntrance(dailyEntranceKey, { waitForData: !hadDaily });")
  && focus.includes("replayDailyViewEntrance(opts.revealKey || ('load-' + focusActivationSeq), { waitForData: false });"),
  'first activation and data arrival must share one entrance generation');
const timerSectionKeyframes = styles.match(/@keyframes focus-section-enter\s*\{([\s\S]*?)\n\}/);
assert(timerSectionKeyframes && !timerSectionKeyframes[1].includes('transform'),
  'timer section entrance must preserve the stable layout position');
const timerRingKeyframes = styles.match(/@keyframes focus-ring-wake\s*\{([\s\S]*?)\n\}/);
assert(timerRingKeyframes && !timerRingKeyframes[1].includes('transform'),
  'timer ring entrance must not scale and appear to jump');
assert(!styles.includes('.focus-daily.is-peeking') && !styles.includes('.focus-daily.is-completing'),
  'removed daily sidebar completion states must not compete with V2 animations');
assert(!styles.includes('.focus-daily-stat.is-updating'),
  'task summary text must not blink during rapid completion toggles');
assert(!styles.includes('.focus-daily.is-revealing .focus-daily-foot,\n.focus-daily.is-revealing .focus-daily-celebrate'),
  'an already-complete initial load must keep the signature static instead of replaying a page-entrance flourish');
assert(!styles.includes('.focus-daily-celebrate-burst')
  && !styles.includes('.focus-daily-celebrate-peek')
  && !styles.includes('.focus-daily-star-trail')
  && !styles.includes('.focus-daily-star-path')
  && !styles.includes('.focus-daily-star-particles')
  && !styles.includes('--daily-star-soft'),
  'legacy completion-card and long star-trail decoration must be fully removed');
const celebrationRule = styles.match(/\.focus-daily-celebrate\s*\{([\s\S]*?)\n\}/);
assert(celebrationRule && celebrationRule[1].includes('position: absolute;')
  && celebrationRule[1].includes('inset: 0;')
  && celebrationRule[1].includes('visibility: hidden;')
  && celebrationRule[1].includes('color-mix(in srgb, var(--bg) 64%, transparent)'),
  'the completion celebration must cover the focus content independently of list height or scroll position');
const celebrationOpenScrollRule = styles.match(/\.focus-daily-view\.is-celebration-open \.focus-daily-scroll\s*\{([\s\S]*?)\n\}/);
assert(celebrationOpenScrollRule && celebrationOpenScrollRule[1].includes('opacity: 0;')
  && celebrationOpenScrollRule[1].includes('transition: none;'),
  'the completed list must stay hidden when entering hands off to the visible celebration phase');
assert(styles.includes('.focus-daily-celebrate.is-visible,')
  && styles.includes('.focus-daily-celebrate.is-entering .focus-daily-star-dot,'),
  'reduced-motion mode must disable the flexible reveal and gathering animations');
const dailyViewRule = styles.match(/\.focus-daily\.focus-daily-view\s*\{([\s\S]*?)\n\}/);
assert(dailyViewRule && dailyViewRule[1].includes('box-sizing: border-box;')
  && dailyViewRule[1].includes('overflow: hidden;'),
  'the daily view must clip only its own full-size layers while delegating scrolling to the inner port');

[
  "'每日任务视图': 'Daily tasks view'",
  "'新增每日任务或分组': 'Add a daily task or group'",
  "'请先完成收尾或重置当前专注段，再查看每日任务'",
  "'今日清单已全部完成': \"Today's list is complete.\"",
  "'回顾今日': 'Review today'",
  'source.match(/^今天做完了\\s*(\\d+)\\s*件事',
  'Finished ${match[1]} ${noun} today',
].forEach((needle) => assert(i18n.includes(needle), 'missing focus daily-view translation: ' + needle));

console.log('focus dual-view contract: ok');

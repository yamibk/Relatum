'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'assets', name), 'utf8');

const html = read('index.html');
const study = read('study.js');
const i18n = read('i18n.js');
const focus = read('focus.js');
const calendar = read('calendar.js');
const editor = read('editor.js');
const styles = read('styles.css');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

[
  'data-role="study-progress-view"',
  'data-role="study-progress-list"',
  'data-role="study-progress-completed-column"',
  'data-role="study-completed-list"',
  'data-action="study-goal-tree-open"',
  'data-role="study-route-overlay"',
  'data-action="study-temporary-toggle"',
  'data-role="study-temporary-layer"',
  'data-role="study-temporary-panel"',
  'data-role="study-temporary-list"',
].forEach((needle) => assert(html.includes(needle), 'missing study progress markup: ' + needle));

const studyListMarker = html.indexOf('data-role="study-list"');
const studyContainerEnd = html.indexOf('</section>', studyListMarker);
const temporaryLayerMarker = html.indexOf('data-role="study-temporary-layer"');
assert(studyListMarker >= 0 && studyContainerEnd >= 0 && temporaryLayerMarker > studyContainerEnd,
  'the temporary task layer must be a sibling outside the scrolling Study container');
assert(/data-role="study-temporary-panel"[\s\S]*?aria-hidden="true" inert/.test(html),
  'the closed temporary panel must start inert and hidden from assistive technology');

[
  "const VIEW_MODE_KEY = 'study:viewMode:v2'",
  "viewMode === 'list' ? 'progress' : 'list'",
  "post('/api/study-task-progress'",
  'function buildProgressCard(task, completed)',
  "box.className = 'study-progress-settings-popover'",
  "box.setAttribute('aria-modal', 'false')",
  "progressSettingsPopover.classList.add('is-suspended')",
  "menu.setAttribute('aria-expanded', progressSettingsId === task.id ? 'true' : 'false')",
  'function positionProgressSettings()',
  'function commitProgressSettings(id, box)',
  'function renderProgress()',
  'function studyGoalReady(task, progress)',
  'function buildStudyProgressValue(progress, goalReady)',
  'function syncStudyProgressValue(value, progress, goalReady)',
  "label.setAttribute('aria-hidden', 'true')",
  "card.classList.toggle('is-goal-ready', goalReady)",
  "track.setAttribute('aria-valuemin', '0')",
  "track.setAttribute('aria-valuemax', String(progress.target))",
  "track.setAttribute('aria-valuenow', String(progress.current))",
  "track.setAttribute('aria-valuetext', goalReady",
  "card.classList.add('is-goal-pending')",
  "reachedCard.classList.remove('is-goal-pending')",
  "cancelReplayClass(reachedCard, 'is-goal-breathing')",
  "replayClass(reachedCard, 'is-goal-celebrating', 1480)",
  'function cancelReplayClass(element, className)',
  'function stopStudyGoalBreath()',
  'function visibleStudyGoalCards()',
  '.is-goal-ready:not(.is-goal-pending):not(.is-goal-celebrating)',
  'function scheduleStudyGoalBreath(delay)',
  "replayClass(card, 'is-goal-breathing', 2540)",
  'scheduleStudyGoalBreath(2800)',
  'scheduleStudyGoalBreath(1560)',
  'function stopStudyGoalCheckFlow()',
  'function nudgeStudyGoalChecks()',
  'function scheduleStudyGoalCheckFlow(delay)',
  "check.style.setProperty('--study-check-speck-' + name + '-x'",
  "var names = ['a', 'b', 'c', 'd']",
  '[names[first], names[second]].forEach',
  'scheduleStudyGoalCheckFlow(3400)',
  'scheduleStudyGoalCheckFlow(1560)',
  "window.addEventListener('pagehide', stopStudyGoalCheckFlow)",
  "document.addEventListener('visibilitychange'",
  "window.addEventListener('pagehide', stopStudyGoalBreath)",
  'const taskMutationChains = new WeakMap()',
  'queueTaskMutation(task, function ()',
  'function reconcileStudyTaskSnapshots(snapshots)',
  'state.tasks = reconcileStudyTaskSnapshots(payload.tasks)',
  'data-role="study-milestone-list"',
  'const STUDY_MILESTONES_MAX = 50',
  "layer.classList.toggle('is-dense', layout.length > 12)",
  "layer.classList.toggle('is-very-dense', layout.length > 24)",
  'state.trash = state.trash.slice(0, STUDY_TRASH_LIMIT)',
  "window.StudyRoute.open(taskId || '', trigger, treeId || '')",
  'openGoalTree(origin, task.id, owner && owner.tree.id)',
  'const TEMPORARY_EDGE_DWELL_MS = 120',
  'const TEMPORARY_EDGE_ZONE_PX = 36',
  'function setTemporaryMembership(task, included, options)',
  'function removeTemporaryTask(task, card)',
  'function animateTemporaryCardReflow(beforeRects)',
  "card.classList.add('is-removing')",
  "replayClass(restored, 'is-restoring', 240)",
  'removeTemporaryTask(task, temporaryCard)',
  "post('/api/study-temporary-update'",
  'function renderTemporaryPanel()',
  'function resetStudyHorizontalOffset()',
  'function syncTemporaryLayerAvailability()',
  "temporaryLayerEl.classList.toggle('is-open', temporaryPanelOpen)",
  'temporaryPanelEl.inert = !temporaryPanelOpen',
  "temporaryToggleEl.focus({ preventScroll: true })",
  'event.detail > 0 && document.activeElement === temporaryToggleEl',
  'temporaryToggleEl.blur()',
  "closeButton.focus({ preventScroll: true })",
  "event.target.closest('[data-action=\"study-goal-tree-open\"]')",
  "function openTrash() {\n    setTemporaryPanelOpen(false)",
  "function openStudyMilestoneDialog(targetValue, returnElement) {\n    if (!targetValue) { showToast('请先设置任务长度'); return; }\n    setTemporaryPanelOpen(false)",
  'function updateTemporaryDragTarget(clientX, clientY)',
  'var wasTemporaryAttempt = drag.overTemporaryPanel || drag.edgeHovering || drag.edgeArmed',
  'restoreProgressOrder(drag)',
  'options.temporaryDrop',
  "temporaryCard.classList.add('drag-handoff')",
  'function temporaryLandingRect(card)',
  'function flyGhostToTemporaryCard(ghost, row, done, targetRect)',
  "proxy.classList.add('study-temporary-transfer-proxy')",
  'var scaleX = source.width / target.width',
  'scale3d(',
  '{ opacity: 0, offset: 0.68 }',
  'revealLandingCard(liveTemporaryCard || temporaryCard)',
  "event.key === 'Tab' && !event.shiftKey",
  "target.closest('input, textarea, select, button, a, [contenteditable=\"true\"], [tabindex]')",
].forEach((needle) => assert(study.includes(needle), 'missing study progress behavior: ' + needle));

assert(!study.includes('if (progressListRows().length < 2) return;'),
  'a single active task must still be draggable into the temporary panel');
assert(!study.includes("studyViewEl.classList.toggle('temporary-panel-open'"),
  'opening the temporary panel must never mutate the Study layout container');
assert(i18n.includes("'临时任务': 'Temporary tasks'")
  && i18n.includes("'加入临时任务': 'Add to temporary tasks'")
  && i18n.includes("'移出临时任务': 'Remove from temporary tasks'"),
  'temporary-task interface text must remain bilingual');
assert(!html.includes('study-temporary-drop-cue')
  && !html.includes('松手加入临时任务')
  && !study.includes('temporaryDropCueEl')
  && !styles.includes('.study-temporary-drop-cue'),
  'the edge drop gesture must not render a separate release prompt');

assert(!study.includes('taskProgressChains') && !study.includes('taskUpdateChains'),
  'Study task writes still use independent queues that can race each other');

const studyPayloadSection = study.slice(study.indexOf('function reconcileStudyTaskSnapshots'), study.indexOf('function openGoalTree'));
assert(studyPayloadSection.includes('currentById.get(snapshot.id)')
  && studyPayloadSection.includes('Object.assign(current, snapshot)')
  && !studyPayloadSection.includes('state.tasks = Array.isArray(payload.tasks) ? payload.tasks : []'),
  'Study snapshots must preserve task object identity for event handlers on reused cards');
const makeSnapshotReconciler = new Function('state', studyPayloadSection
  + '\nreturn reconcileStudyTaskSnapshots;');
const retainedTask = { id: 'task-a', title: '旧标题', progress: { current: 0, target: 10 }, obsolete: true };
const snapshotState = { tasks: [retainedTask] };
const reconciledTasks = makeSnapshotReconciler(snapshotState)([
  { id: 'task-a', title: '新标题', progress: { current: 1, target: 10 } },
  { id: 'task-b', title: '新任务', progress: { current: 0, target: 3 } },
]);
assert.strictEqual(reconciledTasks[0], retainedTask,
  'a refreshed task must keep the object captured by existing card event handlers');
assert.strictEqual(retainedTask.progress.current, 1,
  'the retained task object must receive progress changed from the goal tree');
assert(!Object.prototype.hasOwnProperty.call(retainedTask, 'obsolete'),
  'fields absent from an authoritative task snapshot must not linger');
assert.strictEqual(reconciledTasks[1].id, 'task-b', 'new tasks must still enter the Study snapshot');

const taskRowSection = study.slice(study.indexOf('function taskRow(task)'), study.indexOf('function listQuickAdd()'));
const progressCardSection = study.slice(study.indexOf('function buildProgressCard(task, completed)'), study.indexOf('function cardProgressStructureOk'));
const listQuickAddSection = study.slice(study.indexOf('function listQuickAdd()'), study.indexOf('function renderTrash()'));
const progressQuickAddSection = study.slice(study.indexOf('function progressQuickAdd()'), study.indexOf('function syncProgressCardFromTask'));
const progressSyncSection = study.slice(study.indexOf('function syncProgressCardFromTask'), study.indexOf('function incrementalSyncCardList'));
const settingsCommitSection = study.slice(study.indexOf('function commitProgressSettings(id, box)'), study.indexOf('function progressQuickAdd()'));
const progressMutationSection = study.slice(study.indexOf('function changeTaskProgress(task, delta)'), study.indexOf('function renderProgress()'));
assert(taskRowSection.includes("titleEl.addEventListener('dblclick'")
  && !taskRowSection.includes("row.addEventListener('dblclick'"),
  'compact Study rename must only start from the task title');
assert(progressCardSection.includes("title.addEventListener('dblclick'")
  && !progressCardSection.includes("card.addEventListener('dblclick'"),
  'progress-card rename must only start from the task title');
assert(!listQuickAddSection.includes('beginRename(') && !progressQuickAddSection.includes('beginRename('),
  'new Study tasks must remain unnamed until their title is double-clicked');
assert(settingsCommitSection.includes('progress: { target: target, milestones: milestones }')
  && !settingsCommitSection.includes('title:'),
  'the progress settings popover must not provide another task rename path');
assert(!study.includes('study-progress-edit-name') && !study.includes('buildProgressEditor('),
  'the card-expanding inline editor must be removed');
const pendingBreathCancelAt = progressMutationSection.indexOf("cancelReplayClass(card, 'is-goal-breathing')");
const pendingGoalAt = progressMutationSection.indexOf("card.classList.add('is-goal-pending')");
const reachedBreathCancelAt = progressMutationSection.indexOf("cancelReplayClass(reachedCard, 'is-goal-breathing')");
const celebrationAt = progressMutationSection.indexOf("replayClass(reachedCard, 'is-goal-celebrating', 1480)");
assert(pendingBreathCancelAt >= 0 && pendingBreathCancelAt < pendingGoalAt
  && reachedBreathCancelAt >= 0 && reachedBreathCancelAt < celebrationAt,
  'Goal celebration must cancel any periodic breathing before pending or celebration can begin');
assert(!progressCardSection.includes('study-progress-goal-check'),
  'goal-ready cards must reuse the completion control instead of rendering a second check');
assert(progressCardSection.includes('buildStudyProgressValue(progress, goalReady)')
  && progressSyncSection.includes('syncStudyProgressValue(value, progress, goalReady)')
  && !progressSyncSection.includes('value.textContent'),
  'Study progress values must preserve separate goal-label and numeric DOM nodes during updates');
assert(i18n.includes("'目标已达成，可以手动标记完成': 'Goal reached · You can mark it complete'")
  && i18n.includes("'目标已达': 'Goal reached'"),
  'Study goal-ready text must remain translatable in both its compact and accessible forms');

assert(!html.includes('data-role="focus-overlay"'), 'legacy study Today overlay remains');
assert(!html.includes('study-today-placeholder') && !study.includes('今日任务面板将在后续版本开放'),
  'legacy Today placeholder remains');
assert(!html.includes('data-role="canvas-panel"'), 'legacy linked canvas panel remains');
assert(!html.includes('data-role="calendar-task-panel"'), 'legacy calendar task drawer remains');
assert(!calendar.includes('学习安排') && !calendar.includes('data-calendar-task="'),
  'calendar day detail still renders live Study tasks');
assert(!html.includes('data-action="export-tasks"'), 'canvas-to-study export button remains');
assert(!focus.includes("'/api/study'"), 'focus still loads study tasks');
assert(!calendar.includes("'/api/calendar-pins-save'"), 'calendar still saves study task pins');
assert(!editor.includes("'/api/export-canvas-to-tasks'"), 'editor still calls canvas-to-study export');
assert(backend.includes('tally({**task, "kind": "study"})')
  && backend.includes('record.get("kind") != "study"'),
  'Study archives must remain in Activity while Calendar filters them out');
assert(!backend.includes('if path == "/api/study-task-create-canvas"')
  && !backend.includes('if path == "/api/export-canvas-to-tasks"')
  && !backend.includes('if path == "/api/calendar-pins-save"'),
  'removed Study integration routes remain reachable');
assert(backend.includes('def _study_temporary_task_ids(value: object, tasks: list[dict])')
  && backend.includes('"temporaryTaskIds": temporary_task_ids')
  && backend.includes('if path == "/api/study-temporary-update"')
  && backend.includes('def _api_study_temporary_update(self, body: dict):'),
  'temporary-task references must be normalized and persisted through the Study API');

[
  '.study-progress-card {',
  '.study-progress-view { width: min(1440px, 100%);',
  'grid-template-columns: minmax(0, 27fr) minmax(0, 23fr);',
  'gap: 28px;',
  'min-height: 110px;',
  '.study-progress-card.is-completed { min-height: 78px;',
  '@media (max-width: 940px)',
  '.study-progress-settings-popover {',
  '.study-progress-settings-popover.is-suspended {',
  'position: fixed; z-index: 70;',
  '.study-progress-menu[aria-expanded="true"]',
  '.study-progress-fill {',
  '@property --study-progress-fill-start',
  '@property --study-progress-fill-end',
  '@property --study-goal-flow-x',
  '@property --study-check-speck-a-x',
  '@property --study-check-speck-a-y',
  '@property --study-check-speck-b-x',
  '@property --study-check-speck-b-y',
  '@property --study-check-speck-c-x',
  '@property --study-check-speck-c-y',
  '@property --study-check-speck-d-x',
  '@property --study-check-speck-d-y',
  'linear-gradient(90deg, var(--study-progress-fill-start), var(--study-progress-fill-end))',
  '--study-progress-fill-start 520ms',
  '--study-progress-fill-end 520ms',
  '.study-progress-card.is-goal-ready .study-progress-check',
  '.study-progress-check::before {',
  'overflow: hidden',
  'inset: -2px',
  'background-color: rgba(111, 158, 121, .24)',
  'radial-gradient(circle at var(--study-check-speck-a-x) var(--study-check-speck-a-y)',
  'radial-gradient(circle at var(--study-check-speck-b-x) var(--study-check-speck-b-y)',
  'radial-gradient(circle at var(--study-check-speck-c-x) var(--study-check-speck-c-y)',
  'radial-gradient(circle at var(--study-check-speck-d-x) var(--study-check-speck-d-y)',
  '--study-check-speck-a-x 3200ms cubic-bezier(.42, 0, .58, 1)',
  '--study-check-speck-d-x 4800ms cubic-bezier(.42, 0, .58, 1)',
  'transition: clip-path 520ms cubic-bezier(0.22, 1, 0.36, 1), opacity 360ms var(--easing-soft)',
  '.study-progress-card.is-goal-ready .study-progress-check::before',
  'clip-path: circle(0% at 50% 50%)',
  'clip-path: circle(150% at 50% 50%)',
  '.study-progress-goal-label {',
  '.study-progress-value-number {',
  '.study-progress-card.is-goal-ready .study-progress-goal-label',
  '.study-progress-card.is-goal-ready .study-progress-value-number',
  '.study-progress-track.is-full .study-progress-fill',
  '.study-progress-track.is-full { background: rgba(246, 213, 119, .18); }',
  '--study-progress-fill-start: #efcf72',
  '--study-progress-fill-end: #f6e09c',
  'rgba(255, 232, 154, .5) 34%',
  '.study-progress-fill::before',
  '.study-progress-fill::after',
  '.study-progress-card.is-goal-ready .study-progress-fill::before',
  '.study-progress-card.is-goal-ready .study-progress-fill::after',
  'opacity: .67',
  'filter: brightness(1.05)',
  '.study-progress-card.is-goal-pending .study-progress-fill::before',
  '.study-progress-card.is-goal-celebrating .study-progress-fill::before',
  '.study-progress-card.is-goal-celebrating .study-progress-fill::after',
  'animation: studyGoalMaterialReveal 1300ms 60ms',
  'animation: studyGoalAuraReveal 1300ms 60ms',
  '84% { --study-goal-flow-x: 124%; opacity: 1; clip-path: inset(0 0 0 0 round 999px); filter: brightness(1.12) saturate(1.1); }',
  '84% { --study-goal-flow-x: 124%; width: 100%; opacity: .76; filter: blur(12px) saturate(1.28); }',
  'filter: blur(8px) saturate(1.18) brightness(1.05)',
  'radial-gradient(ellipse 30% 230% at var(--study-goal-flow-x) 50%',
  'radial-gradient(ellipse 25% 170% at var(--study-goal-flow-x) 50%',
  'radial-gradient(circle at 9% 32%',
  'width: 0',
  'width: 100%',
  'clip-path: inset(0 100% 0 0 round 999px)',
  'clip-path: inset(0 0 0 0 round 999px)',
  '@keyframes studyGoalMaterialReveal',
  '@keyframes studyGoalAuraReveal',
  '.study-progress-card.is-goal-ready.is-goal-breathing:not(.is-goal-pending):not(.is-goal-celebrating) .study-progress-fill::before',
  '.study-progress-card.is-goal-ready.is-goal-breathing:not(.is-goal-pending):not(.is-goal-celebrating) .study-progress-fill::after',
  '--study-goal-aura-core: rgba(252, 221, 130, .88)',
  '--study-goal-sheen-core: rgba(255, 228, 143, .86)',
  'animation: studyGoalRestAura 2400ms linear both',
  'animation: studyGoalRestSheen 2400ms linear both',
  '@keyframes studyGoalRestAura',
  '@keyframes studyGoalRestSheen',
  '50% { --study-goal-flow-x: 50%; }',
  '100% { --study-goal-flow-x: 124%; }',
  '--study-goal-flow-x: 124%',
  '.study-progress-milestone.is-just-reached .study-progress-milestone-stamp',
  'body.start-page[data-start-theme="dark"] .study-progress-card',
  '@media (prefers-reduced-motion: reduce)',
  '--study-temporary-width: clamp(400px, 26vw, 480px)',
  '.study-temporary-layer {',
  '.study-temporary-layer.is-available { visibility: visible; }',
  '.study-temporary-layer.is-open .study-temporary-panel',
  '.study-temporary-layer.is-open .study-temporary-head',
  '.study-temporary-layer.is-open .study-temporary-list',
  '.study-temporary-panel {',
  '.study-temporary-card {',
  '.study-temporary-card.drag-handoff {',
  '.study-temporary-transfer-proxy {',
  '.study-temporary-card.is-removing {',
  '@keyframes studyTemporaryRemove',
  '.study-temporary-card.is-restoring',
  '.study-temporary-card.is-completing {',
  '@media (max-width: 700px)',
  '--study-temporary-width: calc(100vw - 12px)',
  '.study-temporary-layer.is-open .study-temporary-tab {',
  '.study-temporary-panel { transform: none; transition: opacity 120ms linear',
].forEach((needle) => assert(styles.includes(needle), 'missing study progress style: ' + needle));

const temporaryTransferSection = study.slice(
  study.indexOf('function flyGhostToTemporaryCard'),
  study.indexOf('function flyGhostToCard'));
assert(!temporaryTransferSection.includes('fromFrame.width')
  && !temporaryTransferSection.includes('toFrame.width'),
  'temporary-task transfer must not animate width or height through layout');
assert(study.includes('flyGhostToCard(drag.ghost, landingCard'),
  'the existing in-list Study landing path must remain separate');
const temporaryHandoffStyle = styles.slice(
  styles.indexOf('.study-temporary-card.drag-handoff {'),
  styles.indexOf('.study-temporary-transfer-proxy {'));
assert(temporaryHandoffStyle.includes('visibility: hidden; opacity: 1'),
  'the hidden target must hand off at full opacity without a blank transition frame');
const temporaryTabOpenStyle = styles.slice(
  styles.indexOf('.study-temporary-layer.is-open .study-temporary-tab {'),
  styles.indexOf('.study-temporary-panel {'));
assert(temporaryTabOpenStyle.includes('opacity: 0')
  && temporaryTabOpenStyle.includes('pointer-events: none')
  && !temporaryTabOpenStyle.includes('right: var(--study-temporary-width)'),
  'the temporary tab must retreat instead of protruding beside the open panel');

assert(!styles.includes('.study-embedded.temporary-panel-open')
  && !styles.includes('padding-right: calc(var(--study-temporary-width)'),
  'the floating temporary panel must not resize or re-layer the Study layout');

const temporaryStyleSection = styles.slice(styles.indexOf('/* 临时任务：'), styles.indexOf('/* —— 浮窗叠加层'));
assert(temporaryStyleSection && !temporaryStyleSection.includes('backdrop-filter'),
  'the temporary panel must use an opaque surface without continuous backdrop blur');

const studyStyleSection = styles.slice(styles.indexOf('.study-progress-card {'), styles.indexOf('/* ── 任务簿 V2'));
const goalLabelStyleSection = styles.slice(styles.indexOf('.study-progress-goal-label {'), styles.indexOf('.study-progress-value-number {'));
assert(!studyStyleSection.includes('studyTargetGlow')
  && !studyStyleSection.includes('.study-progress-card.is-target-reached')
  && !studyStyleSection.includes('.is-goal-celebrating .study-progress-value {')
  && !studyStyleSection.includes('transform: translateX(-125%)')
  && !studyStyleSection.includes('.study-progress-track-shell::before')
  && !studyStyleSection.includes('.study-progress-track::before')
  && !studyStyleSection.includes('filter: drop-shadow(0 0 2px')
  && !studyStyleSection.includes('transform: scaleX(')
  && !studyStyleSection.includes('clip-path: inset(0 0 0 100%')
  && !studyStyleSection.includes('transition: width 520ms cubic-bezier(0.22, 1, 0.36, 1), background')
  && !studyStyleSection.includes('--study-goal-gold')
  && !studyStyleSection.includes('rgba(236, 190, 68')
  && !studyStyleSection.includes('rgba(202, 148, 31'),
  'Study goal completion still uses the narrow moving band or reanimates the entire value block');
assert(!goalLabelStyleSection.includes('max-width')
  && !goalLabelStyleSection.includes('overflow: hidden')
  && !goalLabelStyleSection.includes('transform:'),
  'The goal-ready label must fade in place without width clipping or directional movement');
assert(!studyStyleSection.includes('animation: studyGoalRestAura 3600ms cubic-bezier(0.45, 0, 0.55, 1) infinite')
  && !studyStyleSection.includes('studyGoalRestBody')
  && !studyStyleSection.includes('studyGoalRestGlint')
  && !studyStyleSection.includes('studyGoalReadyCue'),
  'Goal-ready breathing must remain a finite, visibility-aware effect rather than an infinite CSS animation');

console.log('study progress contract: ok');

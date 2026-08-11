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
  'data-action="study-today-placeholder"',
].forEach((needle) => assert(html.includes(needle), 'missing study progress markup: ' + needle));

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
  'data-role="study-milestone-list"',
  'state.trash = state.trash.slice(0, STUDY_TRASH_LIMIT)',
].forEach((needle) => assert(study.includes(needle), 'missing study progress behavior: ' + needle));

assert(!study.includes('taskProgressChains') && !study.includes('taskUpdateChains'),
  'Study task writes still use independent queues that can race each other');

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

[
  '.study-progress-card {',
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
].forEach((needle) => assert(styles.includes(needle), 'missing study progress style: ' + needle));

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

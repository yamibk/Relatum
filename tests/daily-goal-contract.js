const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const focus = fs.readFileSync(path.join(root, 'assets', 'focus.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

[
  'DAILY_GOAL_DAYS_MAX = 3660',
  'DAILY_MILESTONES_MAX = 6',
  'DAILY_MILESTONE_NAME_MAX = 40',
  'def _sanitize_daily_milestones(value: object, target_days: int)',
  'def _validate_daily_milestones(value: object, target_days: int)',
  '"milestones": _sanitize_daily_milestones(item.get("milestones"), target_days)',
  '"milestones": [dict(item) for item in task.get("milestones", [])]',
  'if "targetDays" in body:',
  'next_milestones = _validate_daily_milestones(milestone_source, next_target_days)',
].forEach((needle) => assert(backend.includes(needle), 'missing backend daily-goal contract: ' + needle));

[
  'function dailyGoalState(task)',
  'function dailyMilestoneList(task)',
  'function dailyMilestoneLanes(milestones, target)',
  'function syncDailyMilestones(shell, task, options)',
  "shell.className = 'focus-daily-goal-shell'",
  "bar.dataset.role = 'daily-goal-track'",
  "bar.setAttribute('role', 'progressbar')",
  "bar.setAttribute('aria-valuetext', text)",
  "marker.setAttribute('role', 'img')",
  "tip.setAttribute('role', 'tooltip')",
  "if (dailyGoalState(task).target > 0) main.appendChild(buildDailyGoalProgress(task))",
  "goalIn.max = '3660'",
  "advanced.dataset.role = 'daily-edit-advanced'",
  'function openDailyMilestoneDialog(id, returnElement)',
  "dialog.setAttribute('aria-modal', 'true')",
  'dailyEditMilestones = result.milestones',
  'milestones: milestones',
  'task.totalDays = want ? prevTotalDays + 1 : Math.max(0, prevTotalDays - 1)',
  'milestoneIds: crossedMilestones',
  'refreshDailyRowStats(task, goalMotion)',
  'Object.assign(current, JSON.parse(JSON.stringify(state.confirmedTask)))',
  'dailyCelebrationCheck();',
  'function refreshDailyDetailGoal(task, options)',
  "dailyDetailBlock(T('累计目标'))",
  "dailyDetailBlock('今日进度')",
  "event.target.closest('.focus-daily-milestone')",
  "window.matchMedia('(pointer: coarse)').matches",
].forEach((needle) => assert(focus.includes(needle), 'missing frontend daily-goal contract: ' + needle));

assert(!focus.includes('function startDailyClear('),
  'completed daily tasks must remain visible instead of clearing the list');

assert(!focus.includes("bar.className = 'focus-daily-bar'"),
  'daily cards must no longer render the old per-day minute bar');
assert(focus.includes('task.targetMinutes'),
  'daily minute targets must remain available outside the compact card bar');
assert(!focus.includes('bar.title = text'),
  'milestone progress must not depend on the delayed global title tooltip');

[
  '.focus-daily-goal {',
  '.focus-daily-goal-shell {',
  '.focus-daily-milestones {',
  '.focus-daily-milestone-stamp {',
  '.focus-daily-milestone-tip {',
  '.focus-daily-milestone-shell {',
  '.focus-daily-milestone-row.is-leaving',
  'height: 6px;',
  'transition: width 620ms',
  '@keyframes focus-daily-goal-glow',
  '@keyframes focus-daily-goal-reached',
  '@keyframes focus-daily-goal-sheen',
  '@keyframes focus-daily-milestone-reached',
  '@keyframes focus-daily-milestone-row-out',
  'body.start-page[data-start-theme="dark"] .focus-daily-goal',
  'body.start-page[data-start-theme="dark"] .focus-daily-milestone-dialog',
  '@media (prefers-reduced-motion: reduce)',
  '.focus-daily-goal::after,',
].forEach((needle) => assert(styles.includes(needle), 'missing daily-goal style contract: ' + needle));

[
  "'累计目标': 'Cumulative goal'",
  "'累计打卡目标': 'Cumulative check-in goal'",
  "'高级设置': 'Advanced settings'",
  "'小目标名称': 'Milestone name'",
  "'未达成': 'Upcoming'",
  "'天 · 可选': 'Days · optional'",
  'days total · goal met',
].forEach((needle) => assert(i18n.includes(needle), 'missing daily-goal translation contract: ' + needle));

console.log('daily goal contract: ok');

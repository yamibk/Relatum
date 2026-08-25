'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('assets', 'index.html');
const start = read('assets', 'start.js');
const study = read('assets', 'study.js');
const styles = read('assets', 'styles.css');
const i18n = read('assets', 'i18n.js');
const backend = read('app.py');

assert(html.includes('data-role="start-page-activity-toggle"')
  && !html.includes('data-role="start-page-activity-toggle" checked')
  && html.includes('学习、树状、速记计时'), 'the settings toggle must be visible and off by default');
assert(start.includes("localStorage.getItem(START_PAGE_ACTIVITY_ENABLED_KEY) === '1'"),
  'timing must remain off until the user explicitly enables it');
assert(start.includes("localStorage.setItem(START_PAGE_ACTIVITY_ENABLED_KEY, startPageActivityEnabled ? '1' : '0')"),
  'both user choices must persist locally');
assert(start.includes("document.body.dataset.startPageActivityEnabled = startPageActivityEnabled ? '1' : '0'"),
  'the timer preference must also control whether add-on values are shown');
[
  "new Set(['study', 'tree', 'notes'])",
  "fetch('/api/start-page-activity'",
  'document.hasFocus()',
  "window.addEventListener('blur'",
  "window.addEventListener('pagehide'",
  "document.addEventListener('visibilitychange'",
  'keepalive: !!keepalive',
  '30000',
  "activeStartWorkspace !== 'canvas'",
  'window.RelatumStartPageActivity = Object.freeze({',
  'waitForStartPageActivityIdle(3000)',
].forEach((needle) => assert(start.includes(needle), 'missing start-page timer contract: ' + needle));
assert(!start.includes('invalidateActivityAfterStartPageWrite'),
  'successful timer writes must not automatically invalidate or redraw Activity');
assert(start.includes('timer = window.setTimeout(() => finish(false), wait);')
  && start.includes('return waitForStartPageActivityIdle(3000);'),
  'manual refresh must stop waiting for timer writes after three seconds');
assert(study.includes('await startPageActivity.waitForIdle()')
  && study.indexOf('await startPageActivity.waitForIdle()') < study.indexOf('activityDirty = true', study.indexOf('async function refreshCadence')),
  'manual refresh must wait for pending timer writes before reading Activity data');

[
  'payload.startPageStats',
  'startPageStats.monthSec',
  'startPageStats.yearSec',
  'startPageStats.streak',
  'startPageStats.longestStreak',
  'startPageStats.activePageCount',
  'startPageStats.totalSec',
  'cadence-stat-addon',
  '学习、树状、速记合计',
].forEach((needle) => assert(study.includes(needle), 'missing split-stat UI contract: ' + needle));
assert(styles.includes('body.start-page[data-start-page-activity-enabled="0"] .cadence-stat-addon'),
  'disabling the timer must hide all green add-on values');
assert(study.includes("return { num: '&lt;1', unit: '分钟' }"),
  'positive durations below one minute must retain the existing natural unit');
assert(styles.includes('--cadence-page-addon: #337a6b')
  && styles.includes('--cadence-page-addon: #70b9a6'), 'light and dark themes need semantic green values');
assert(/\.cadence-stat-pair\s*\{[\s\S]*?flex-wrap:\s*wrap/.test(styles),
  'the add-on measure must wrap as a whole instead of overlapping units');
assert(/\.cadence-stat-measure\s*\{[\s\S]*?white-space:\s*nowrap/.test(styles),
  'each value-unit measure must stay intact');
assert(i18n.includes("'学习、树状、速记合计': 'Study, Tree, and Quick Notes combined'"));
assert(i18n.includes("'开启后记录这三页的前台使用时长': 'When enabled, foreground time on these three pages is recorded.'"));
assert(i18n.includes("'手动重新读取活跃数据（包括画布、学习、树状、速记、完成任务和专注）'"),
  'manual refresh guidance must be translated');

[
  'START_PAGE_ACTIVITY_FILE',
  'START_PAGE_ACTIVITY_PAGES = ("study", "tree", "notes")',
  'def record_start_page_activity_interval',
  '"/api/start-page-activity"',
  '"startPageStats"',
].forEach((needle) => assert(backend.includes(needle), 'missing backend contract: ' + needle));

console.log('start page activity contract passed');

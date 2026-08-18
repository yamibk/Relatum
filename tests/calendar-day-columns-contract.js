'use strict';

// 日历页右侧三栏合约：画布活动 → 每日打卡 → 学习任务（替换原专注记录/当天成果）。
// 只做源码级静态断言。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const calendar = fs.readFileSync(path.join(root, 'assets', 'calendar.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

// —— 三栏渲染：画布活动置顶，每日打卡、学习任务依次错峰 ——
assert(calendar.includes('function renderCanvasActivity()'));
assert(calendar.includes('function renderDailySummary()'));
assert(calendar.includes('function renderStudyCompleted()'));
assert(calendar.includes('画布活动'));
assert(calendar.includes('每日打卡'));
assert(calendar.includes('学习任务'));
assert(calendar.includes('--calendar-card-delay:8ms'));   // 画布活动最先
assert(calendar.includes('--calendar-card-delay:16ms'));  // 每日打卡
assert(calendar.includes('--calendar-card-delay:38ms'));  // 学习任务
assert(calendar.includes('data-calendar-record-key="canvas:'));
assert(calendar.includes('data-calendar-record-key="daily:'));
assert(calendar.includes('data-calendar-record-key="study:'));

// —— 旧两栏渲染已移除 ——
assert(!calendar.includes('renderFocusItems'));
assert(!calendar.includes('renderArchives'));
assert(!calendar.includes('formatSessionTime'));
assert(!calendar.includes('data-calendar-focus='));

// —— 每日打卡只记录已打卡任务（过滤未打卡，摘要只显示已打卡数）——
assert(calendar.includes(' 项打卡'));
assert(calendar.includes('这一天还没有打卡。'));
assert(appPy.includes('if day not in done_dates:'));
assert(appPy.includes('continue'));

// —— 动画机制复用：卡片错峰 + 条目错峰 ——
assert(calendar.includes('--calendar-item-delay:'));
assert(styles.includes('.calendar-records { display: grid; gap: 12px;'));

// —— 每次翻进日历页完整重播错峰入场（页头/月卡 CSS 类 + 右侧整列 WAAPI）——
assert(calendar.includes("animateDayColumn(column, { kind: 'enter', direction: 0 })"));
assert(calendar.includes('function enterAfterRefresh()'));   // stale 刷新：渲染与入场同帧生效
assert(calendar.includes("root.classList.add('calendar-refreshing')"));  // 等待期隐藏内容
assert(calendar.includes("root.classList.remove('calendar-refreshing')"));
assert(styles.includes('.calendar-refreshing .calendar-page-head,'));
assert(styles.includes('.calendar-refreshing .calendar-layout {'));
assert(calendar.includes("records.classList.remove('calendar-records-enter')"));
// 倒数日数据未到时卡片隐藏（不渲染占位按钮），避免占位→重建闪现
assert(calendar.includes('const hidden = !state.countdownEnabled || !countdown;'));

// —— 加载期完全隐藏右侧三栏（不渲染骨架白块）；旧骨架淡出逻辑保留 null 兜底 ——
assert(!calendar.includes("'<article><i></i><i></i></article>'"));
assert(calendar.includes('!skeleton || !skeleton.animate'));

// —— 后端聚合 ——
assert(appPy.includes('def _calendar_canvas_activity'));
assert(appPy.includes('def _calendar_daily_summary'));
assert(appPy.includes('def _calendar_study_completed'));
assert(appPy.includes('"canvasActivity": _calendar_canvas_activity(selected, canvas_data)'));
assert(appPy.includes('"daily": _calendar_daily_summary(selected, daily_data)'));
assert(appPy.includes('_calendar_study_completed(selected, all_archive_records)'));
// 学习任务栏只读归档（kind=study），archive_records 仍排除 study
assert(appPy.includes('record.get("kind") != "study"'));
assert(appPy.includes('record.get("kind") != "study" or record.get("day") != day'));

// —— 月历圆点与图例：与右侧三栏一一对应（画布活动 / 每日打卡 / 学习任务）——
assert(calendar.includes("marks.canvas ? '<i class=\"canvas\"></i>'"));
assert(calendar.includes("marks.daily ? '<i class=\"daily\"></i>'"));
assert(calendar.includes("marks.study ? '<i class=\"study\"></i>'"));
assert(calendar.includes('<i class="canvas"></i>画布活动'));
assert(calendar.includes('<i class="daily"></i>每日打卡'));
assert(calendar.includes('<i class="study"></i>学习任务'));
assert(styles.includes('.calendar-day i.canvas, .calendar-legend i.canvas'));
assert(styles.includes('.calendar-day i.daily, .calendar-legend i.daily'));
assert(styles.includes('.calendar-day i.study, .calendar-legend i.study'));
assert(appPy.includes('"canvas": 0, "daily": 0, "study": 0,'));
assert(appPy.includes('bucket(day)["canvas"] = 1'));
assert(appPy.includes('bucket(done_day)["daily"] = 1'));
assert(appPy.includes('bucket(record_day)["study"] = 1'));

// —— 文案键 ——
assert(i18n.includes("'画布活动': 'Canvas activity'"));
assert(i18n.includes("'每日打卡': 'Daily check-in'"));
assert(i18n.includes("'已打卡': 'Checked in'"));
assert(i18n.includes("'完成于': 'Completed at'"));

console.log('calendar day columns contract passed');

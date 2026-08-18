'use strict';

// 日历页倒数日进度条合约：进度条 + 「⋯」长度设置 + 已过事件金色达成态。
// 只做源码级静态断言，避免耦合 DOM 运行时细节。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const calendar = fs.readFileSync(path.join(root, 'assets', 'calendar.js'), 'utf8');
const countdown = fs.readFileSync(path.join(root, 'assets', 'countdown.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

// —— 进度条渲染与计算 ——
assert(calendar.includes('renderCountdownProgress'));
assert(calendar.includes('data-calendar-countdown-progress'));
assert(calendar.includes('calendar-title-row'));  // 位于“日历”大标题同一行
assert(calendar.includes('calendar-head-main'));  // 左侧标题区由 flex 分配宽度，防换行
assert(calendar.includes('data-countdown-progress-bar'));
assert(calendar.includes('data-countdown-progress-settings'));
assert(calendar.includes('data-countdown-progress-value'));
assert(calendar.includes('countdownProgressValue'));
assert(calendar.includes('selectedCountdownLengthDays'));
assert(calendar.includes("(lengthDays - distance) / lengthDays * 100"));  // 60 天剩 18 → 42/60
assert(calendar.includes('is-overdue'));
assert(calendar.includes("track.classList.toggle('is-full', overdue)"));

// —— 设置弹层：复用学习页样式，只保留长度输入 ——
assert(calendar.includes("box.className = 'study-progress-settings-popover'"));
assert(calendar.includes("dataset.role = 'countdown-progress-length'"));
assert(calendar.includes("uiText('长度')"));
assert(calendar.includes("uiText('长度需要是 1 到 9999 之间的整数')"));
assert(calendar.includes("delete selected.lengthDays"));  // 清空输入 = 移除长度
assert(calendar.includes('commitCountdownProgressSettings(box)'));
assert(calendar.includes('closeCountdownProgressSettings(true)'));

// —— 金色达成态：复用学习页有限重播的光雾动画 ——
assert(calendar.includes("classList.add('is-breathing')"));
assert(calendar.includes('scheduleCountdownProgressBreath'));
assert(calendar.includes('stopCountdownProgressBreath'));
assert(calendar.includes('visibleCountdownProgressBar'));

// —— 同步钩子：切换事件 / 编辑 / 数据到达 / 显隐开关都会刷新进度条 ——
assert(calendar.includes('syncCountdownProgress()'));
assert(calendar.includes('updateCountdownEverywhere'));
assert(calendar.includes('reconcileCalendarPanel'));
assert(calendar.includes("document.addEventListener('calendar:countdown-visibility'"));

// —— countdown.js 规范化保留 lengthDays ——
assert(countdown.includes('Number.isInteger(lengthDays) && lengthDays >= 1 && lengthDays <= 9999'));
assert(countdown.includes('clean.lengthDays = lengthDays'));

// —— app.py 白名单保留可选 lengthDays，非法丢弃 ——
assert(appPy.includes('raw.get("lengthDays")'));
assert(appPy.includes('clean["lengthDays"] = length_days'));

// —— 常驻占位：进度条只在“日历倒数日”开关关闭时隐藏；无事件时「⋯」禁用 ——
assert(calendar.includes('const hidden = !state.countdownEnabled'));
assert(calendar.includes('menu.disabled = !hasCountdown'));
assert(calendar.includes("uiText('请先创建倒数日')"));

// —— 样式：进度条行、金色达成态、低动态降级、错峰入场 ——
assert(styles.includes('.calendar-head-main { flex: 1 1 auto; min-width: 0; }'));
assert(styles.includes('.calendar-title-row {'));
assert(styles.includes('.calendar-countdown-progress {'));
assert(styles.includes('.calendar-countdown-progress.is-overdue .study-progress-fill::before'));
assert(styles.includes('.calendar-countdown-progress.is-overdue.is-breathing .study-progress-fill::before'));
assert(styles.includes('animation: studyGoalRestAura 2400ms linear both;'));
assert(styles.includes('.calendar-countdown-progress .study-progress-fill { transition: none; }'));
assert(styles.includes('.calendar-page-head-enter .calendar-countdown-progress { animation: calendarHeadIn'));
assert(styles.includes('body.start-page[data-start-theme="dark"] .calendar-countdown-progress'));

// —— 文案键（中英文）——
assert(i18n.includes("'倒数日进度': 'Countdown progress'"));
assert(i18n.includes("'设置倒数日进度长度': 'Set countdown progress length'"));
assert(i18n.includes("'长度': 'Length'"));
assert(i18n.includes("'长度需要是 1 到 9999 之间的整数': 'Length must be an integer from 1 to 9999'"));

console.log('calendar countdown progress contract passed');

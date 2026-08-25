'use strict';

// 直接执行 calendar.js 中的纯日期辅助函数，覆盖跨月/年、闰日与长区间。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'calendar.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf('  function ' + from + '(');
  const end = source.indexOf('  function ' + to + '(', start + 1);
  assert(start >= 0 && end > start, 'missing calendar date helper: ' + from);
  return source.slice(start, end);
}

const context = {};
vm.runInNewContext(
  section('parseCalendarDate', 'shiftCalendarDate')
    + section('shiftCalendarDate', 'calendarDateDistance')
    + section('calendarDateDistance', 'formatCountdownProgressDate')
    + '\nthis.helpers = { parseCalendarDate, shiftCalendarDate, calendarDateDistance };',
  context,
);

const { parseCalendarDate, shiftCalendarDate, calendarDateDistance } = context.helpers;

assert.strictEqual(shiftCalendarDate('2026-12-31', -100), '2026-09-22');
assert.strictEqual(calendarDateDistance('2026-10-01', '2026-12-31'), 91);
assert.strictEqual(shiftCalendarDate('2024-03-01', -1), '2024-02-29');
assert.strictEqual(calendarDateDistance('2024-02-29', '2024-03-01'), 1);
assert.strictEqual(calendarDateDistance('2025-12-31', '2026-01-01'), 1);
assert.strictEqual(parseCalendarDate('2026-02-29'), null);
assert.strictEqual(parseCalendarDate('not-a-date'), null);
assert.strictEqual(shiftCalendarDate('0001-01-02', -1), '0001-01-01');

const longStart = shiftCalendarDate('2040-01-01', -9999);
assert.strictEqual(calendarDateDistance(longStart, '2040-01-01'), 9999);

console.log('calendar countdown progress date regression passed');

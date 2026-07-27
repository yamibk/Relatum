'use strict';

const assert = require('assert');
const Timer = require('../assets/canvas-timer.js');

function timer(overrides) {
  return Object.assign({
    id: 'timer-1',
    x: 10,
    y: -20,
    mode: 'countdown',
    label: '阅读',
    durationMs: 25 * 60 * 1000,
    elapsedMs: 0,
  }, overrides || {});
}

assert.deepStrictEqual(Timer.durationParts(25 * 60 * 1000), {
  hours: 0,
  minutes: 25,
  seconds: 0,
});
assert.strictEqual(Timer.durationFromParts(99, 59, 59), Timer.MAX_DURATION_MS);
assert.strictEqual(Timer.durationFromParts(0, 0, 0), null);
assert.strictEqual(Timer.durationFromParts(100, 0, 0), null);

assert.strictEqual(Timer.format(timer(), 0), '00:25:00');
assert.strictEqual(Timer.format(timer(), 1), '00:25:00');
assert.strictEqual(Timer.format(timer(), 1000), '00:24:59');
assert.strictEqual(Timer.format(timer(), 25 * 60 * 1000), '00:00:00');
assert.strictEqual(Timer.format(timer({ mode: 'countup', durationMs: undefined }), 1001), '00:00:01');
assert.strictEqual(
  Timer.format(timer({ mode: 'countup', durationMs: undefined }), (123 * 3600 + 4 * 60 + 5) * 1000),
  '123:04:05'
);

const running = { running: true, startedAt: 1000 };
assert.strictEqual(Timer.effectiveElapsed(timer({ elapsedMs: 5000 }), running, 4000), 8000);
assert.strictEqual(Timer.effectiveElapsed(timer({ elapsedMs: 5000 }), running, 500), 5000);

const paused = Timer.toggle(timer({ elapsedMs: 5000 }), running, 4000);
assert.strictEqual(paused.running, false);
assert.strictEqual(paused.timer.elapsedMs, 8000);

const restarted = Timer.toggle(timer({ elapsedMs: 25 * 60 * 1000 }), null, 9000);
assert.strictEqual(restarted.running, true);
assert.strictEqual(restarted.timer.elapsedMs, 0);
assert.deepStrictEqual(restarted.runtime, { running: true, startedAt: 9000 });

const batch = Timer.toggleBatch([
  { timer: timer({ id: 'running', elapsedMs: 2000 }), runtime: { running: true, startedAt: 1000 } },
  { timer: timer({ id: 'stopped', elapsedMs: 3000 }), runtime: null },
  { timer: timer({ id: 'complete', elapsedMs: 25 * 60 * 1000 }), runtime: null },
], 5000);
assert.strictEqual(batch.length, 3);
assert.strictEqual(batch[0].running, false);
assert.strictEqual(batch[0].timer.elapsedMs, 6000);
assert.strictEqual(batch[1].running, true);
assert.deepStrictEqual(batch[1].runtime, { running: true, startedAt: 5000 });
assert.strictEqual(batch[2].running, true);
assert.strictEqual(batch[2].timer.elapsedMs, 0);

const reset = Timer.reset(timer({ elapsedMs: 12345 }));
assert.strictEqual(reset.elapsedMs, 0);
assert.strictEqual(Timer.isComplete(timer({ elapsedMs: 25 * 60 * 1000 })), true);
assert.strictEqual(Timer.isComplete(timer({ mode: 'countup', durationMs: undefined, elapsedMs: 999999 })), false);

const normalized = Timer.normalizeList([
  timer({ id: 'one', label: 'x'.repeat(80), elapsedMs: -1 }),
  timer({ id: 'one' }),
  timer({ id: '', x: 0, y: 0 }),
  timer({ id: 'two', mode: 'countup', durationMs: 1234 }),
]);
assert.strictEqual(normalized.length, 2);
assert.strictEqual(normalized[0].label.length, 60);
assert.strictEqual(normalized[0].elapsedMs, 0);
assert.strictEqual(Object.prototype.hasOwnProperty.call(normalized[1], 'durationMs'), false);

console.log('canvas timer regression tests passed');

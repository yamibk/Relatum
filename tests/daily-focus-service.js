'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/focus-service.js'), 'utf8');
function create(saved = null, respond = async () => ({ ok: true })) {
  let now = 1800000000000, serial = 0;
  const storage = new Map(saved ? [['daily:focusRuntime', JSON.stringify(saved)]] : []), intervals = new Map(), events = new Map(), calls = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const window = { RelatumFeatureRuntime: { enabled: () => true }, addEventListener(name, fn) { events.set(name, fn); } };
  const document = { hidden: false, querySelector: () => null, dispatchEvent() {}, addEventListener(name, fn) { events.set(name, fn); } };
  const context = { window, document, Date: Clock, Set, Map, Math, JSON, String, Number, Object, Promise, Error, AbortController,
    CustomEvent: class { constructor(name, options) { this.type = name; this.detail = options?.detail; } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setInterval(fn) { const id = ++serial; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout: () => ++serial, clearTimeout() {},
    async fetch(url, options) { const body = JSON.parse(options?.body || '{}'); calls.push({ url, body }); const value = await respond(url, body); return { ok: value.ok !== false, json: async () => value }; },
  };
  window.setTimeout = context.setTimeout; window.clearTimeout = context.clearTimeout;
  vm.runInNewContext(source, context);
  return { api: window.RelatumFocusService, calls, intervals, storage, events, advance(ms) { now += ms; [...intervals.values()].forEach(fn => fn()); }, now: () => now };
}
(async () => {
  const clock = create();
  assert.equal(clock.calls.length, 0, 'idle service must not fetch data');
  assert.equal(clock.intervals.size, 0);
  clock.api.start(); clock.advance(7300); assert.equal(clock.api.remaining, 1493);
  clock.api.pause(); assert.equal(clock.intervals.size, 0, 'paused clock has no idle ticker');
  clock.advance(60000); assert.equal(clock.api.remaining, 1493);
  clock.api.start(); clock.advance(2300); assert.equal(clock.api.remaining, 1491);
  clock.api.goal = '保留目标'; clock.api.beginWrapup(91); clock.api.outcome = '保留成果';
  assert.equal(clock.intervals.size, 0, 'pending wrapup has no idle ticker');
  const pending = JSON.parse(clock.storage.get('daily:focusRuntime'));
  const restored = create(pending);
  assert.equal(restored.api.pendingSession.id, pending.pendingSession.id);
  assert.equal(restored.api.outcome, '保留成果');
  const first = restored.api.finishWrapup('stop'), second = restored.api.finishWrapup('stop');
  assert.strictEqual(first, second, 'save is single-flight'); await first;
  assert.equal(restored.calls.filter(c => c.url === '/api/focus-log').length, 1);
  assert.equal(restored.api.running, false); assert.equal(restored.api.pendingSession, null);
  let rejectMinutes = true;
  const retry = create(null, async url => {
    if (url === '/api/daily-add-minutes' && rejectMinutes) { rejectMinutes = false; return { ok: false, error: '模拟回应失败' }; }
    return { ok: true };
  });
  retry.api.bindTask('daily-task', '阅读', 'daily'); retry.api.start(); retry.api.beginWrapup(120);
  await assert.rejects(retry.api.finishWrapup('stop'));
  await retry.api.finishWrapup('stop');
  const logs = retry.calls.filter(c => c.url === '/api/focus-log'), minutes = retry.calls.filter(c => c.url === '/api/daily-add-minutes');
  assert.equal(logs[0].body.id, logs[1].body.id, 'retries keep the same record identity');
  assert.equal(logs[0].body.endedAt, logs[1].body.endedAt, 'retries keep the exact record');
  assert.equal(minutes[0].body.requestId, minutes[1].body.requestId, 'minutes have a stable receipt');
  const expired = create({ version: 1, running: true, paused: false, phase: 'focus', remaining: 1, mode: 'pomodoro', savedAt: 1799999990000 });
  assert(expired.api.pendingSession, 'expired countdown restores to pending results without a dialog');
  const elapsed = create({ version: 1, running: true, paused: false, phase: 'focus', mode: 'countup', elapsed: 60, savedAt: 1799999990000 });
  assert.equal(elapsed.api.elapsed, 70);
  elapsed.events.get('pagehide')(); assert.equal(elapsed.intervals.size, 0);
  elapsed.advance(10000); elapsed.events.get('pageshow')({ persisted: true }); assert.equal(elapsed.api.elapsed, 80);
  elapsed.api.reset(); assert.equal(elapsed.intervals.size, 0);
  console.log('Daily focus service: elapsed time, pause, wrapup, single-flight save, stable retry and restore passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

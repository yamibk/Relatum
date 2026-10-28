'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/feature-runtime.js'), 'utf8');
const key = 'canvas:globalSystem:v1', bootKey = 'relatum:globalSystemBoot:v1';
function storage(initial = {}) {
  const values = { ...initial };
  return { values, fail: false, writes: 0,
    getItem(key) { return values[key] ?? null; },
    setItem(key, value) { if (this.fail) throw Error('storage unavailable'); this.writes++; values[key] = String(value); },
    removeItem(key) { if (this.fail) throw Error('storage unavailable'); this.writes++; delete values[key]; } };
}
function run(local = storage(), session = storage(), launchId = null, allowed = true) {
  const listeners = {}, events = [];
  const window = { RelatumFeatures: { workspaces: [], restricted: true, features: { 'runtime.preload': allowed } },
    ...(launchId ? { RelatumDesktopPreferencesSeed: { sessionKey: 'full', launchId } } : {}),
    addEventListener(name, callback) { listeners[name] = callback; }, dispatchEvent(event) { events.push(event); } };
  const document = { head: { appendChild() {} }, documentElement: { style: { setProperty() {} } }, createElement() { return {}; }, addEventListener() {} };
  vm.runInNewContext(source, { window, document, localStorage: local, sessionStorage: session,
    location: { search: '' }, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { policy: window.RelatumGlobalSystem, features: window.RelatumFeatureRuntime, events, listeners };
}
const plain = value => JSON.parse(JSON.stringify(value));
for (const raw of [undefined, 'null', '{bad', '[]', '{"preload":1,"dailyRetention":"forever"}']) {
  const local = storage(raw === undefined ? {} : { [key]: raw });
  assert.deepEqual(plain(run(local).policy.read()), { preload: true, dailyRetention: 'immediate' });
  assert.equal(local.writes, 0, 'startup never rewrites resource preferences');
}
const local = storage(), session = storage(), first = run(local, session, 'first');
assert(first.features.preloadEnabled);
assert(first.policy.update({ preload: false, dailyRetention: 'session' }));
assert(first.features.preloadEnabled, 'changing preferences leaves the current launch unchanged');
assert(Object.isFrozen(first.policy.read()));
assert.equal(run(local, session, 'first').features.preloadEnabled, true, 'same launch survives reload and navigation');
assert.equal(run(local, session, 'second').features.preloadEnabled, false, 'new launch adopts the saved choice');
assert.equal(run(storage(), storage(), 'first', false).features.preloadEnabled, false, 'preferences cannot override launch permissions');
const browserSession = storage(), browser = run(local, browserSession);
assert.equal(browser.features.preloadEnabled, false);
browser.policy.update({ preload: true });
assert.equal(run(local, browserSession).features.preloadEnabled, false, 'browser tab keeps its startup snapshot');
assert.equal(run(local, storage()).features.preloadEnabled, true, 'a fresh tab adopts the saved choice');
for (const value of ['immediate', '30s', '5m', 'session']) {
  assert(first.policy.update({ dailyRetention: value }));
  assert.equal(first.policy.read().dailyRetention, value);
}
const previous = first.policy.read(), count = first.events.length;
local.fail = true;
assert.equal(first.policy.update({ dailyRetention: '5m' }), false);
assert.equal(first.policy.reset(), false);
assert.equal(first.policy.read(), previous, 'failed saves preserve the current policy');
assert.equal(first.events.length, count, 'failed saves never publish a new policy');
local.fail = false;
assert(first.policy.reset());
assert.equal(local.getItem(key), null);
assert.deepEqual(plain(first.policy.read()), { preload: true, dailyRetention: 'immediate' });
assert.equal(first.features.preloadEnabled, true);
assert(session.getItem(bootKey), 'launch snapshots live in session storage');
local.setItem(key, JSON.stringify({ preload: false, dailyRetention: '30s' }));
first.listeners.storage({ key });
assert.equal(first.policy.read().dailyRetention, '30s');
assert.equal(first.features.preloadEnabled, true, 'storage notifications also preserve startup preloading');
console.log('Global resource policy: defaults, validation, permissions, launch/tab snapshots, live retention and storage failures passed');
// Exercise the production scope wrapper: repeated drag setup must keep native
// listener deduplication, including once/capture behavior and background guards.
const dailySource = fs.readFileSync(path.join(__dirname, '../assets/daily-workspace.js'), 'utf8');
const scopeSource = dailySource.slice(dailySource.indexOf('  function createScope(root)'), dailySource.indexOf('  async function css(src)'));
const scopeRoot = { hidden: false, getAnimations: () => [] }, visibility = { active: true };
const scope = vm.runInNewContext(scopeSource + '\ncreateScope(root)', { root: scopeRoot, AbortController,
  visible: () => visibility.active, window: { setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {} } });
const target = new EventTarget(); let calls = 0, dirty = 0;
function callback() { assert.equal(this, target); calls++; }
scope.listen(target, 'click', callback); scope.listen(target, 'click', callback);
target.dispatchEvent(new Event('click')); assert.equal(calls, 1, 'duplicate listener registration stays deduplicated');
scope.listen(target, 'click', callback, true);
target.dispatchEvent(new Event('click')); assert.equal(calls, 3, 'capture has its own identity');
visibility.active = false; target.dispatchEvent(new Event('click')); assert.equal(calls, 3);
scope.listen(target, 'canvas:data-changed', () => dirty++);
target.dispatchEvent(new Event('canvas:data-changed')); assert.equal(dirty, 1, 'background invalidation still works');
visibility.active = true; scopeRoot.hidden = true;
target.dispatchEvent(new Event('click')); assert.equal(calls, 3);
scopeRoot.hidden = false;
scope.listen(target, 'resize', callback, { once: true }); target.dispatchEvent(new Event('resize'));
scope.listen(target, 'resize', callback, { once: true }); target.dispatchEvent(new Event('resize'));
assert.equal(calls, 5, 'once listeners can be registered again after firing');
scope.destroy(); target.dispatchEvent(new Event('click')); assert.equal(calls, 5);
console.log('Daily scopes: foreground guards, invalidation, listener deduplication, once/capture and destruction passed');

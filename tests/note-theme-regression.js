'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/note-theme.js'), 'utf8'), key = 'canvas:noteTheme:v1';
function boot(raw) {
  const values = new Map(raw === undefined ? [] : [[key, raw]]), events = [], writes = [];
  let failing = false;
  const localStorage = { getItem: k => values.get(k) ?? null,
    setItem(k, v) { if (failing) throw Error('quota'); writes.push(k); values.set(k, v); },
    removeItem(k) { if (failing) throw Error('denied'); writes.push(k); values.delete(k); } };
  const document = { documentElement: { dataset: {} } };
  const window = { dispatchEvent(event) { events.push([event.type, document.documentElement.dataset.noteTheme, event.detail]); } };
  vm.runInNewContext(source, { localStorage, document, window, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { api: window.RelatumNoteTheme, document, values, events, writes, fail: value => { failing = value; } };
}
for (const raw of [undefined, '', 'unknown', '{broken', 'default', 'claude', 'sky', 'apple']) {
  const c = boot(raw);
  assert.equal(c.api.read(), ['claude', 'sky', 'apple'].includes(raw) ? raw : 'default');
  assert.equal(c.writes.length, 0, 'boot never rewrites stored values');
}
const c = boot();
assert.deepEqual(Array.from(c.api.list(), item => item.id), ['default', 'claude', 'sky', 'apple']);
assert(Object.isFrozen(c.api.list()) && c.api.list().every(item => Object.isFrozen(item) && Object.isFrozen(item.label)));
c.fail(true);
assert.equal(c.api.apply('claude'), false); assert.equal(c.api.read(), 'default'); assert.equal(c.events.length, 0);
c.fail(false);
assert(c.api.apply('claude')); assert.equal(c.values.get(key), 'claude');
assert.deepEqual(c.events.map(event => event.slice(0, 2)), [['relatum:note-theme-beforechange', 'default'], ['relatum:note-theme', 'claude']]);
assert(c.api.apply('claude')); assert.equal(c.events.length, 2, 'same theme does no layout work');
c.fail(true); assert.equal(c.api.reset(), false); assert.equal(c.api.read(), 'claude');
c.fail(false); assert(c.api.reset()); assert.equal(c.values.has(key), false);
assert.equal(c.api.apply('missing'), false); assert.equal(c.api.read(), 'default');
for (const previous of ['default', 'claude', 'sky', 'apple']) {
  const sky = boot(previous);
  sky.fail(true); assert.equal(sky.api.apply('sky'), previous === 'sky'); assert.equal(sky.api.read(), previous);
  assert.equal(sky.events.length, 0);
  sky.fail(false); assert(sky.api.apply('sky')); assert.equal(sky.document.documentElement.dataset.noteTheme, 'sky');
  assert.equal(sky.values.get(key), 'sky');
  assert.equal(sky.events.length, previous === 'sky' ? 0 : 2);
  if (previous !== 'sky') assert.deepEqual(sky.events.map(event => event.slice(0, 2)), [['relatum:note-theme-beforechange', previous], ['relatum:note-theme', 'sky']]);
  const count = sky.events.length; assert(sky.api.apply('sky')); assert.equal(sky.events.length, count);
  sky.fail(true); assert.equal(sky.api.reset(), false); assert.equal(sky.api.read(), 'sky');
  sky.fail(false); assert(sky.api.reset()); assert.equal(sky.api.read(), 'default'); assert.equal(sky.values.has(key), false);
}
const transient = boot('claude'); transient.fail(true);
assert(transient.api.apply('sky', { persist: false })); assert.equal(transient.api.read(), 'sky');
assert.equal(transient.values.get(key), 'claude'); assert.equal(transient.writes.length, 0);
for (const previous of ['default', 'claude', 'sky', 'apple']) {
  const apple = boot(previous);
  apple.fail(true); assert.equal(apple.api.apply('apple'), previous === 'apple'); assert.equal(apple.api.read(), previous);
  assert.equal(apple.events.length, 0);
  apple.fail(false); assert(apple.api.apply('apple')); assert.equal(apple.values.get(key), 'apple');
  assert.equal(apple.document.documentElement.dataset.noteTheme, 'apple');
  assert.deepEqual(apple.events.map(event => event.slice(0, 2)), previous === 'apple' ? [] :
    [['relatum:note-theme-beforechange', previous], ['relatum:note-theme', 'apple']]);
  const count = apple.events.length; assert(apple.api.apply('apple')); assert.equal(apple.events.length, count);
  apple.fail(true); assert.equal(apple.api.reset(), false); assert.equal(apple.api.read(), 'apple');
  assert(apple.api.apply('sky', { persist: false })); assert.equal(apple.values.get(key), 'apple');
  apple.fail(false); assert(apple.api.reset()); assert.equal(apple.api.read(), 'default'); assert.equal(apple.values.has(key), false);
}
console.log('note theme preferences: passed');

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
for (const raw of [undefined, '', 'unknown', '{broken', 'default', 'claude']) {
  const c = boot(raw);
  assert.equal(c.api.read(), raw === 'claude' ? 'claude' : 'default');
  assert.equal(c.writes.length, 0, 'boot never rewrites stored values');
}
const c = boot();
assert.deepEqual(Array.from(c.api.list(), item => item.id), ['default', 'claude']);
c.fail(true);
assert.equal(c.api.apply('claude'), false); assert.equal(c.api.read(), 'default'); assert.equal(c.events.length, 0);
c.fail(false);
assert(c.api.apply('claude')); assert.equal(c.values.get(key), 'claude');
assert.deepEqual(c.events.map(event => event.slice(0, 2)), [['relatum:note-theme-beforechange', 'default'], ['relatum:note-theme', 'claude']]);
assert(c.api.apply('claude')); assert.equal(c.events.length, 2, 'same theme does no layout work');
c.fail(true); assert.equal(c.api.reset(), false); assert.equal(c.api.read(), 'claude');
c.fail(false); assert(c.api.reset()); assert.equal(c.values.has(key), false);
assert.equal(c.api.apply('missing'), false); assert.equal(c.api.read(), 'default');
console.log('note theme preferences: passed');

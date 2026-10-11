'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const key = 'canvas:noteGraphSpacing:v1';
// Exercise the actual lightweight preference functions in both startup paths.
// No graph runtime, editor, backend or user preferences are loaded.
for (const filename of ['start.js', 'start-shell.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../assets', filename), 'utf8');
  const begin = source.indexOf('const NOTE_GRAPH_SPACING_KEY'), end = source.indexOf('function applyCanvasNodeScale', begin);
  assert(begin > 0 && end > begin);
  for (const [raw, expected] of [[null, 125], ['', 125], ['bad', 125], ['Infinity', 125], ['0', 125], ['-1', 125], ['83', 85], ['999', 200], ['1', 80], ['165', 165]]) {
    const storage = new Map(raw === null ? [] : [[key, raw]]), writes = [], events = [];
    const input = {}, output = {}, query = role => role.endsWith('-value') ? output : input;
    const sandbox = { query, document: { querySelector(selector) { return query(selector.match(/data-role="([^"]+)"/)[1]); } },
      localStorage: { getItem: name => storage.get(name) ?? null, setItem(name, value) { writes.push([name, value]); storage.set(name, value); } },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
      window: { dispatchEvent(event) { events.push(event); } } };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(begin, end) + '\nglobalThis.pref = { read: () => noteGraphSpacing, apply: applyGraphSpacing };', sandbox);
    assert.equal(sandbox.pref.read(), expected, filename + ': stored preference normalization');
    sandbox.pref.apply(expected, false); assert.equal(input.value, String(expected)); assert.equal(output.textContent, expected + '%');
    sandbox.pref.apply(expected, true); assert.equal(writes.length, 0); assert.equal(events.length, 0, 'same value creates no update');
    sandbox.pref.apply(130, true); assert.equal(storage.get(key), '130'); assert.equal(writes.length, 1);
    sandbox.pref.apply(130, true); assert.equal(writes.length, 1); assert.equal(events.length, 1);
    assert.equal(events[0].type, 'relatum:note-graph-spacing'); assert.equal(events[0].detail, 130);
    sandbox.pref.apply(185, false); sandbox.pref.apply(185, true); assert.equal(storage.get(key), '185', 'optional preview can be persisted later');
    sandbox.pref.apply(NaN, true); assert.equal(sandbox.pref.read(), 125);
  }
  assert(source.includes('readGraphSpacing()') && source.includes('resetGraphSpacing()'), 'same public methods in both startup modes');
}
console.log('note graph: both preference paths, bounds/defaults, step rounding and duplicate-write/event suppression passed');

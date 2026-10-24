'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
let parses = 0;
const messages = [];
const scope = { console, OffscreenCanvas: class { getContext() { return {}; } },
  importScripts() {}, pele: { parse(source) { parses++; return source; }, render(source) { return { svg: '<svg>' + source + '</svg>', width: 20, height: 20 }; } },
  postMessage(message) { messages.push(message); } };
scope.self = scope;
vm.createContext(scope);
const source = fs.readFileSync(path.join(__dirname, '../assets/note-mermaid-worker.js'), 'utf8')
  .replace('    self.onmessage = async event => {', '    self.inspect = () => ({ size:cache.size, bytes, cacheEpoch });\n    self.onmessage = async event => {');
vm.runInContext(source, scope);
const send = data => scope.onmessage({ data });
const render = (source, epoch) => send({ id: messages.length, source, cacheEpoch: epoch, fontRevision: 0, layoutKey: 'fixed', options: { fontFamily: 'sans-serif', fontFamilyMono: 'monospace' } });
(async () => {
  await send({ kind: 'cache', items: 8, bytes: 2 * 1024 * 1024, epoch: 1, clear: true });
  await render('old task submitted after clearing', 0);
  assert.equal(scope.inspect().size, 0, 'an old main-thread task cannot repopulate a newer worker cache');
  assert(messages.at(-1).result, 'the old valid task may still deliver its result');
  await render('current', 1); const before = parses;
  await render('current', 1); assert.equal(parses, before, 'current-generation rendering still reuses a model');
  const pending = render('in flight', 1);
  await send({ kind: 'cache', items: 8, bytes: 2 * 1024 * 1024, epoch: 2, clear: true });
  await pending; assert.equal(scope.inspect().size, 0, 'clearing during font preparation blocks late cache writes');
  for (let i = 0; i < 12; i++) await render('diagram-' + i, 2);
  assert.equal(scope.inspect().size, 8, 'small cache keeps its configured item bound');
  await send({ kind: 'cache', items: 3, bytes: 2 * 1024 * 1024, epoch: 2 });
  assert.equal(scope.inspect().size, 3, 'lowering the budget trims existing worker models immediately');
  await render('x'.repeat(600000), 2);
  assert(scope.inspect().bytes <= 2 * 1024 * 1024, 'oversized results cannot exceed the byte budget');
  console.log('note system worker: generation isolation, model reuse, resizing and byte budgets passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

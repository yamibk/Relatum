'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/feature-catalog.json'), 'utf8'));
const source = fs.readFileSync(path.join(__dirname, '../assets/feature-runtime.js'), 'utf8');
function run(workspaces, stored, allowed = null) {
  let writes = 0;
  const listeners = {}, styles = {};
  const document = { head: { appendChild() {} }, documentElement: { style: { setProperty(key, value) { styles[key] = value; } } },
    createElement() { return {}; }, addEventListener(name, fn) { listeners[name] = fn; } };
  const window = { RelatumFeatures: { workspaces, restricted: !!allowed, canvasHome: !allowed || allowed.includes('canvas'),
    features: Object.fromEntries(catalog.features.map(item => [item.id, !allowed || allowed.includes(item.id)])) } };
  const context = { window, document, location: { search: '' }, URLSearchParams, localStorage: { getItem: () => stored, setItem() { writes++; } } };
  vm.runInNewContext(source, context);
  return { api: window.RelatumFeatureRuntime, writes: () => writes, styles };
}
const plain = value => JSON.parse(JSON.stringify(value));
const ids = catalog.workspaces.map(item => item.id);
const defaults = run(catalog.workspaces, null);
assert.deepEqual(plain(defaults.api.visibleWorkspaces()), ids);
assert.equal(defaults.api.workspace('unknown'), ids[0]);
assert.equal(defaults.writes(), 0, 'reading defaults does not persist preferences');
const reordered = { order: ['career', 'notes', 'canvas', 'research'], hidden: ['notes'] };
const selected = run(catalog.workspaces, JSON.stringify(reordered));
assert.equal(selected.api.workspace('notes'), 'career');
assert.equal(selected.api.workspace('research'), 'research');
assert.deepEqual(plain(selected.api.readLayout()), reordered);
const restricted = run(catalog.workspaces, JSON.stringify(reordered), ['notes', 'research']);
assert.deepEqual(plain(restricted.api.readLayout()), reordered, 'unavailable slots and visibility are retained');
assert.deepEqual(plain(restricted.api.visibleWorkspaces()), ['research']);
assert.equal(restricted.api.workspaceEnabled('unregistered'), false);
const empty = run(catalog.workspaces, JSON.stringify({ order: ids, hidden: ids }));
assert.equal(empty.api.workspace('canvas'), 'none');
assert.equal(empty.styles['--start-workspace-slider-width'], '0px');
const extended = [...catalog.workspaces, { id: 'future', label: ['新工作区', 'Future'], panel: 'future-panel' }];
for (const stored of [null, JSON.stringify(reordered), JSON.stringify({ order: ids, hidden: ids })]) {
  const next = run(extended, stored);
  assert.equal(next.api.readLayout().order.at(-1), 'future');
  assert(next.api.readLayout().hidden.includes('future'), 'new workspace defaults to hidden');
}
for (const invalid of ['{bad', 'null', '[]', '{"order":1,"hidden":[]}']) assert.deepEqual(plain(run(catalog.workspaces, invalid).api.visibleWorkspaces()), ids);
assert.deepEqual(plain(defaults.api.normalizeLayout({ order: ['notes', 'notes', 'missing'], hidden: ['notes', 'missing'] })), { order: ['notes', 'canvas', 'research', 'career'], hidden: ['notes'] });
console.log('Workspace defaults, normalization, unavailable slots, empty state and future registration passed');

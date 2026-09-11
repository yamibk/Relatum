'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const values = new Map();
const sandbox = {
  window: {},
  navigator: { platform: 'Win32' },
  localStorage: {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'note-shortcuts.js'), 'utf8'), sandbox);
const shortcuts = sandbox.window.RelatumNoteShortcuts;

assert(shortcuts && shortcuts.STORAGE_KEY === 'canvas:noteShortcuts:v1', 'the local shortcut registry must be available');
assert.deepStrictEqual(JSON.parse(JSON.stringify(shortcuts.defaultBindings())), {
  save: ['Mod-s'], bold: ['Mod-b'], italic: ['Mod-i'], strike: [], highlight: [], link: ['Mod-k'],
  'inline-code': ['Mod-`'], 'code-block': ['Mod-Shift-k'],
}, 'every initial Note command must keep its existing default binding');
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(shortcuts.COMMANDS.map((command) => command.id))),
  ['save', 'bold', 'italic', 'strike', 'highlight', 'link', 'inline-code', 'code-block'],
  'formatting commands must appear in the intended settings order',
);
assert.strictEqual(shortcuts.normalizeBinding('Shift-Mod-K'), 'Mod-Shift-k', 'modifier order must normalize before persistence');
assert.strictEqual(shortcuts.normalizeBinding('ctrl-Alt-F2'), 'Mod-Alt-F2', 'primary modifiers must persist as portable Mod bindings');
assert.strictEqual(shortcuts.isAllowedBinding('x'), false, 'plain printable keys must never be claimed from note typing');
assert.strictEqual(shortcuts.isAllowedBinding('F2'), true, 'function keys may be bound without a modifier');

const bindings = shortcuts.defaultBindings();
bindings.bold.push('Alt-b');
bindings.strike.push('Alt-Shift-5');
shortcuts.save(bindings, sandbox.localStorage);
const reloaded = shortcuts.load(sandbox.localStorage);
assert.deepStrictEqual(JSON.parse(JSON.stringify(reloaded.bold)), ['Mod-b', 'Alt-b'], 'multiple command bindings must persist');
assert.deepStrictEqual(JSON.parse(JSON.stringify(reloaded.strike)), ['Alt-Shift-5'], 'an initially unassigned command must persist a user binding');
assert.strictEqual(shortcuts.conflictFor('Mod-s', 'bold', reloaded).command.id, 'save', 'command conflicts must be rejected');
assert.strictEqual(shortcuts.conflictFor('Mod-n', 'bold', reloaded).command.id, 'new-note', 'workspace conflicts must be rejected');

const cancelled = shortcuts.defaultBindings();
cancelled.link = [];
cancelled['code-block'] = [];
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(shortcuts.inactiveDefaultBindings(cancelled))),
  ['Mod-k', 'Mod-Shift-k'],
  'cancelled factory bindings must be consumed before CodeMirror defaults',
);
cancelled.highlight = ['Mod-Shift-k'];
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(shortcuts.inactiveDefaultBindings(cancelled))),
  ['Mod-k'],
  'a factory chord reassigned to another command must remain active',
);

values.set(shortcuts.STORAGE_KEY, JSON.stringify({
  version: 1,
  commands: { link: [], 'code-block': [] },
}));
const legacyV1 = shortcuts.load(sandbox.localStorage);
assert.deepStrictEqual(JSON.parse(JSON.stringify(legacyV1.strike)), [], 'older v1 preferences must add strike as unassigned');
assert.deepStrictEqual(JSON.parse(JSON.stringify(legacyV1.highlight)), [], 'older v1 preferences must add highlight as unassigned');
assert.deepStrictEqual(JSON.parse(JSON.stringify(shortcuts.inactiveDefaultBindings(legacyV1))), ['Mod-k', 'Mod-Shift-k']);

values.set(shortcuts.STORAGE_KEY, '{broken');
assert.deepStrictEqual(JSON.parse(JSON.stringify(shortcuts.load(sandbox.localStorage))), JSON.parse(JSON.stringify(shortcuts.defaultBindings())),
  'malformed stored preferences must safely fall back to defaults');
shortcuts.reset(sandbox.localStorage);
assert.strictEqual(values.has(shortcuts.STORAGE_KEY), false, 'reset must remove only the shortcut preference key');

console.log('note shortcuts contract: ok');

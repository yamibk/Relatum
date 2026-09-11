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
  save: ['Mod-s'], bold: ['Mod-b'], italic: ['Mod-i'], link: ['Mod-k'],
  'inline-code': ['Mod-`'], 'code-block': ['Mod-Shift-k'],
}, 'every initial Note command must keep its existing default binding');
assert.strictEqual(shortcuts.normalizeBinding('Shift-Mod-K'), 'Mod-Shift-k', 'modifier order must normalize before persistence');
assert.strictEqual(shortcuts.normalizeBinding('ctrl-Alt-F2'), 'Mod-Alt-F2', 'primary modifiers must persist as portable Mod bindings');
assert.strictEqual(shortcuts.isAllowedBinding('x'), false, 'plain printable keys must never be claimed from note typing');
assert.strictEqual(shortcuts.isAllowedBinding('F2'), true, 'function keys may be bound without a modifier');

const bindings = shortcuts.defaultBindings();
bindings.bold.push('Alt-b');
shortcuts.save(bindings, sandbox.localStorage);
const reloaded = shortcuts.load(sandbox.localStorage);
assert.deepStrictEqual(JSON.parse(JSON.stringify(reloaded.bold)), ['Mod-b', 'Alt-b'], 'multiple command bindings must persist');
assert.strictEqual(shortcuts.conflictFor('Mod-s', 'bold', reloaded).command.id, 'save', 'command conflicts must be rejected');
assert.strictEqual(shortcuts.conflictFor('Mod-n', 'bold', reloaded).command.id, 'new-note', 'workspace conflicts must be rejected');

values.set(shortcuts.STORAGE_KEY, '{broken');
assert.deepStrictEqual(JSON.parse(JSON.stringify(shortcuts.load(sandbox.localStorage))), JSON.parse(JSON.stringify(shortcuts.defaultBindings())),
  'malformed stored preferences must safely fall back to defaults');
shortcuts.reset(sandbox.localStorage);
assert.strictEqual(values.has(shortcuts.STORAGE_KEY), false, 'reset must remove only the shortcut preference key');

console.log('note shortcuts contract: ok');

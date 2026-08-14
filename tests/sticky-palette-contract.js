const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const palettePath = path.join(root, 'assets', 'sticky-palette.js');
const indexHtml = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const editorHtml = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const dualHtml = fs.readFileSync(path.join(root, 'assets', 'dual-viewer.html'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const notes = fs.readFileSync(path.join(root, 'assets', 'notes.js'), 'utf8');
const startSticky = fs.readFileSync(path.join(root, 'assets', 'start-sticky-notes.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');

const values = new Map();
const events = [];
global.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); },
};
global.CustomEvent = class CustomEvent {
  constructor(type, options) {
    this.type = type;
    this.detail = options && options.detail;
  }
};
global.dispatchEvent = (event) => { events.push(event); return true; };
global.addEventListener = () => {};
delete require.cache[require.resolve(palettePath)];
require(palettePath);

const palette = global.RelatumStickyPalette;
assert(palette, 'shared sticky palette must publish a global API');
assert.strictEqual(palette.swatches.length, 20, 'shared sticky palette must contain exactly 20 colors');
assert.strictEqual(new Set(palette.keys).size, 20, 'sticky color keys must be unique');
assert.strictEqual(new Set(palette.swatches.map((item) => item.hex)).size, 20,
  'sticky color hex values must be unique');
assert.deepStrictEqual(new Set(palette.swatches.map((item) => item.family)),
  new Set(['rose', 'amber', 'leaf', 'aqua', 'blue', 'violet', 'neutral']),
  'sticky colors must cover the seven balanced color families');

assert.deepStrictEqual(palette.getEnabledKeys(), palette.keys,
  'missing preference must enable all colors');
assert.deepStrictEqual(palette.getSelectedKeys(), palette.keys,
  'missing preference must visually select all colors');
palette.setEnabledKeys(['pink', 'paper', 'not-a-color']);
assert.deepStrictEqual(palette.getEnabledKeys(), ['pink', 'paper'],
  'enabled colors must be normalized to known palette order');
const stored = JSON.parse(values.get(palette.storageKey));
assert.strictEqual(stored.version, 1, 'palette preference must keep schema version 1');
assert(!stored.disabled.includes('pink') && !stored.disabled.includes('paper'),
  'enabled colors must not be persisted as disabled');
assert.strictEqual(stored.disabled.length, 18,
  'preference must persist only the disabled complement');
assert(events.some((event) => event.type === 'relatum:sticky-palette-change'),
  'palette changes must notify all three note systems');

values.set(palette.storageKey, JSON.stringify({
  version: 1,
  disabled: palette.keys.concat(['future-color']),
}));
assert.deepStrictEqual(palette.getEnabledKeys(), palette.keys,
  'all-disabled preferences must safely fall back to all colors for generation');
assert.deepStrictEqual(palette.getSelectedKeys(), [],
  'all-disabled preferences must preserve the visual none-selected state');
palette.setEnabledKeys([]);
assert.deepStrictEqual(palette.getEnabledKeys(), palette.keys,
  'the public setter must never leave random generation without a candidate');
assert.deepStrictEqual(palette.getSelectedKeys(), [],
  'the public setter must preserve an explicit none-selected state');
const noneSelectedStored = JSON.parse(values.get(palette.storageKey));
assert.strictEqual(noneSelectedStored.disabled.length, 20,
  'the none-selected state must persist every color as disabled');
palette.setEnabledKeys(palette.keys);
assert(!values.has(palette.storageKey), 'all-selected state should use the missing-key default');

const withoutRose = palette.pick({ random: () => 0, excludeFamily: 'rose' });
assert.notStrictEqual(withoutRose.family, 'rose',
  'family selection must avoid the previous family when another family is available');
const amberOnly = palette.pick({ enabledKeys: ['yellow', 'orange'], random: () => 0.999, excludeKey: 'orange' });
assert.strictEqual(amberOnly.key, 'yellow',
  'single-family selection must still avoid the previous exact color');

function assertBefore(source, first, second, message) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert(a >= 0 && b >= 0 && a < b, message);
}
assertBefore(indexHtml, '<script src="sticky-palette.js" defer></script>', '<script src="start.js" defer></script>',
  'start page must load the palette before control setup');
assertBefore(indexHtml, '<script src="sticky-palette.js" defer></script>', '<script src="start-sticky-notes.js" defer></script>',
  'start page must load the palette before cross-page notes');
assertBefore(indexHtml, '<script src="sticky-palette.js" defer></script>', '<script src="notes.js" defer></script>',
  'start page must load the palette before Quick Notes');
assertBefore(editorHtml, '<script src="sticky-palette.js" defer></script>', '<script src="canvas.js" defer></script>',
  'editor must load the palette before the canvas engine');
assertBefore(dualHtml, '<script src="sticky-palette.js" defer></script>', '<script src="canvas.js" defer></script>',
  'dual viewer must load the palette before the canvas engine');

[
  'data-role="notes-console-trigger"',
  'data-role="notes-console-panel"',
  'data-role="notes-console-colors"',
  'data-role="notes-console-help-trigger"',
  'data-role="notes-console-help-panel"',
  'data-action="notes-fit-all"',
  'data-action="notes-reset-view"',
  'hidden inert',
].forEach((needle) => assert(indexHtml.includes(needle), 'missing Quick Notes console contract: ' + needle));
assert(!indexHtml.includes('class="start-speed-section start-note-settings"'),
  'Quick Notes controls must not remain duplicated in the global settings popover');
assert(start.includes("notesConsolePanel.addEventListener('wheel'"),
  'console wheel input must be isolated from the note wall');
assert(start.includes('const NOTES_CONSOLE_HOTSPOT_WIDTH = 48;')
  && start.includes('const NOTES_CONSOLE_HOTSPOT_HEIGHT = 72;')
  && start.includes('event.clientY >= centerY - NOTES_CONSOLE_HOTSPOT_HEIGHT / 2')
  && start.includes('event.clientY <= centerY + NOTES_CONSOLE_HOTSPOT_HEIGHT / 2'),
  'console reveal must use a compact center-right hotspot instead of the full right edge');
assert(start.includes("event.key === 'Escape'") && start.includes('setOpen(false, true)'),
  'Escape must close the console and restore focus to its trigger');
assert(start.includes('setHelpOpen(false, true)'),
  'Escape must close the shortcut card before closing the console');
assert(start.includes('palette.getSelectedKeys') && start.includes("'取消全选'"),
  'console must distinguish a visual none-selected state and toggle Select all / Clear all');
assert(start.includes("event.detail.current !== 'notes'") && start.includes('setOpen(false, false)'),
  'leaving Quick Notes must close the console');
assert(notes.includes('const stickyPalette = window.RelatumStickyPalette')
  && startSticky.includes('const stickyPalette = window.RelatumStickyPalette')
  && canvas.includes('const STICKY_PALETTE_API = global.RelatumStickyPalette'),
  'all three note systems must consume the shared palette');
assert(!canvas.includes('const STICKY_SWATCHES = ['),
  'canvas must not keep a duplicated sticky color table');
assert(/\.notes-console-panel\s*\{[\s\S]*?backdrop-filter:\s*none;/.test(styles),
  'Quick Notes console must avoid continuous backdrop blur');
assert(notes.includes('const NOTE_TYPOGRAPHY_SHORT_MAX = 18;')
  && notes.includes('const NOTE_TYPOGRAPHY_MEDIUM_MAX = 48;')
  && notes.includes("el.dataset.typography = noteTypographyTier(value);"),
  'Quick Notes must classify transient short, medium, and long typography without persisting style fields');
assert(notes.includes('applyNoteTypography(el, data.text);')
  && notes.includes('applyNoteTypography(el, next);')
  && notes.includes('requestAnimationFrame(renderEdges);'),
  'Quick Notes must apply typography on render/edit and realign connected edges after text layout changes');
[
  ['short', '20px', '650', '1.46'],
  ['medium', '18px', '600', '1.55'],
  ['long', '16.5px', '560', '1.62'],
].forEach(([tier, size, weight, lineHeight]) => {
  const pattern = new RegExp('\\.sticky-note\\[data-typography="' + tier + '"\\] \\.sticky-note-body\\s*\\{'
    + '[\\s\\S]*?font-size:\\s*' + size.replace('.', '\\.') + ';'
    + '[\\s\\S]*?font-weight:\\s*' + weight + ';'
    + '[\\s\\S]*?line-height:\\s*' + lineHeight.replace('.', '\\.') + ';');
  assert(pattern.test(styles), 'missing Quick Notes ' + tier + ' typography tier');
});
assert(/\.sticky-note-body\s*\{[\s\S]*?font-family:\s*"Segoe UI Variable Text"[^;]*"Noto Sans SC"[\s\S]*?font-synthesis:\s*none;[\s\S]*?font-variant-numeric:\s*proportional-nums;/.test(styles),
  'Quick Notes must use the editorial Latin/CJK font stack, real weights, and proportional numerals');
assert(styles.includes('@media (hover: none), (pointer: coarse)'),
  'touch and non-hover devices must keep the console entry visible');
['速记控制台', '生成颜色', '总览便签', '重置视野', '取消全选', '速记快捷键', '创建与连接'].forEach((text) => {
  assert(i18n.includes("'" + text + "':"), 'missing Quick Notes console translation: ' + text);
});

delete global.RelatumStickyPalette;
delete global.localStorage;
delete global.CustomEvent;
delete global.dispatchEvent;
delete global.addEventListener;

console.log('sticky palette and Quick Notes console contract: ok');

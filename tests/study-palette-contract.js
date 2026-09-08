'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const readAsset = (name) => fs.readFileSync(path.join(root, 'assets', name), 'utf8');
const paletteSource = readAsset('study-palette.js');
const study = readAsset('study.js');
const route = readAsset('study-route.js');
const tree = readAsset('tree-page.js');
const css = readAsset('styles.css');

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first, second) {
  const high = Math.max(relativeLuminance(first), relativeLuminance(second));
  const low = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

global.window = global;
vm.runInThisContext(paletteSource, { filename: 'study-palette.js' });

const colors = window.RelatumStudyPalette.COLORS;
assert.strictEqual(colors.length, 12, 'the shared palette must remain a 4 by 3 set');
const tinted = colors.filter((item) => item.value);
const warmGold = tinted.find((item) => item.label === '暖金');
assert.strictEqual(new Set(tinted.map((item) => item.value)).size, 11, 'persisted palette values must stay unique');
assert.strictEqual(new Set(tinted.map((item) => item.light)).size, 11, 'light surfaces must remain visually distinct');
assert.strictEqual(new Set(tinted.map((item) => item.dark)).size, 11, 'dark surfaces must remain visually distinct');
tinted.forEach((item) => {
  assert(/^#[0-9a-f]{6}$/i.test(item.light) && /^#[0-9a-f]{6}$/i.test(item.dark),
    'palette tones must use stable six-digit hex colors: ' + item.label);
  assert.deepStrictEqual(window.RelatumStudyPalette.toneFor(item.value),
    { light: item.light, lightAccent: item.lightAccent, dark: item.dark, darkInk: '#172033' },
    'persisted colors must resolve to paired theme surfaces, accents and foregrounds');
  assert(contrastRatio(item.light, '#292c27') >= 4.5,
    'light palette surfaces must keep readable dark text: ' + item.label);
  assert(contrastRatio(item.dark, window.RelatumStudyPalette.toneFor(item.value).darkInk) >= 4.5,
    'dark palette surfaces must keep their paired foreground readable: ' + item.label);
});
assert(warmGold && parseInt(warmGold.light.slice(3, 5), 16) - parseInt(warmGold.light.slice(5, 7), 16) >= 50,
  'warm gold must read as a clear golden yellow rather than a low-chroma brown');

const properties = new Map();
const element = { style: {
  setProperty(name, value) { properties.set(name, value); },
  removeProperty(name) { properties.delete(name); },
} };
window.RelatumStudyPalette.applyColorTones(element, 'task-color', tinted[0].value);
assert.strictEqual(properties.get('--task-color-light'), tinted[0].light);
assert.strictEqual(properties.get('--task-color-dark'), tinted[0].dark);
assert.strictEqual(properties.get('--task-color-light-accent'), tinted[0].lightAccent);
assert.strictEqual(properties.get('--task-color-dark-ink'), '#172033');
window.RelatumStudyPalette.applyColorTones(element, 'task-color', '');
assert.strictEqual(properties.size, 0,
  'removing a task color must also remove its theme tones');

assert(study.includes("applyColorTones(el, 'task-color', color)"),
  'Study cards must receive the shared light and dark presentation tones');
[route, tree].forEach((source) => {
  assert(source.includes("applyColorTones(element, 'branch-color', routeNodeColor)"),
    'goal-tree cards must receive the shared light and dark presentation tones');
  assert(source.includes('--palette-swatch-light:') && source.includes('--palette-swatch-dark:'),
    'goal-tree palettes must preview the theme-specific tones');
});
[
  '--task-color-light', '--task-color-dark', '--branch-color-light', '--branch-color-dark',
  '--palette-swatch-light', '--palette-swatch-dark',
  'body.start-page[data-start-theme="dark"] .study-list-row[data-task-color]',
  'body.start-page[data-start-theme="dark"] .study-route-node.is-branch[data-branch-color]',
  'body.start-page[data-start-theme="dark"] .tree-page-route-rail',
  'body.start-page[data-start-theme="dark"] .tree-page-route-rail .study-route-rail-orb',
].forEach((needle) => assert(css.includes(needle), 'missing palette presentation rule: ' + needle));

console.log('shared study palette theme contract passed');

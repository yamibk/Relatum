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

function mixHex(first, second, amount) {
  const a = first.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  const b = second.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  const channels = a.map((value, index) => Math.round(value * amount + b[index] * (1 - amount)));
  return '#' + channels.map((value) => value.toString(16).padStart(2, '0')).join('');
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

function presentationElement(classNames) {
  const scopedProperties = new Map();
  const classes = new Set(classNames);
  return {
    properties: scopedProperties,
    element: {
      dataset: {},
      classList: { contains(name) { return classes.has(name); } },
      style: {
        setProperty(name, value) { scopedProperties.set(name, value); },
        removeProperty(name) { scopedProperties.delete(name); },
      },
    },
  };
}

window.RelatumBoot = { darkCardPresentation: {
  version: 1,
  tree: { fill: 60, accent: 60, ink: 'auto' },
  study: { fill: 60, accent: 60, ink: 'auto' },
} };
const presentationContexts = [
  { scope: 'study', name: 'task-color', classes: ['study-progress-card'], base: '#1c1e1d', tone: 'dark' },
  { scope: 'study', name: 'task-color', classes: ['study-temporary-card'], base: '#242725', tone: 'dark' },
  { scope: 'study', name: 'task-color', classes: ['study-list-row'], base: '#111213', tone: 'dark' },
  { scope: 'study', name: 'branch-color', classes: ['study-route-node', 'is-branch'], base: '#242a26', tone: 'dark' },
  { scope: 'tree', name: 'branch-color', classes: ['study-route-node', 'is-branch'], base: '#242a26', tone: 'dark' },
  { scope: 'tree', name: 'branch-color', classes: ['study-route-node', 'is-root'], base: '#f0eee7', tone: 'light' },
];
presentationContexts.forEach((context) => {
  [0, 60, 100].forEach((fill) => {
    window.RelatumBoot.darkCardPresentation[context.scope].fill = fill;
    tinted.forEach((item) => {
      const target = presentationElement(context.classes);
      window.RelatumStudyPalette.applyColorTones(
        target.element, context.name, item.value, { scope: context.scope },
      );
      const foreground = target.properties.get('--' + context.name + '-dark-ink');
      const surface = mixHex(item[context.tone], context.base, fill / 100);
      assert(contrastRatio(surface, foreground) >= 4.5,
        context.scope + ' ' + context.name + ' foreground must remain readable at '
          + fill + '%: ' + item.label);
    });
  });
});
['tree', 'study'].forEach((scope) => {
  const context = presentationContexts.find((item) => item.scope === scope);
  const target = presentationElement(context.classes);
  window.RelatumBoot.darkCardPresentation[scope].ink = 'light';
  window.RelatumStudyPalette.applyColorTones(
    target.element, context.name, tinted[0].value, { scope },
  );
  assert.strictEqual(target.properties.get('--' + context.name + '-dark-ink'), '#ffffff',
    scope + ' must support forced white card text');
  window.RelatumBoot.darkCardPresentation[scope].ink = 'dark';
  window.RelatumStudyPalette.applyColorTones(
    target.element, context.name, tinted[0].value, { scope },
  );
  assert.strictEqual(target.properties.get('--' + context.name + '-dark-ink'), '#000000',
    scope + ' must support forced black card text');
  window.RelatumBoot.darkCardPresentation[scope].ink = 'auto';
});
window.RelatumBoot.darkCardPresentation.tree.fill = 0;
window.RelatumBoot.darkCardPresentation.study.fill = 100;
const treeTarget = presentationElement(['study-route-node', 'is-branch']);
const studyTarget = presentationElement(['study-progress-card']);
window.RelatumStudyPalette.applyColorTones(treeTarget.element, 'branch-color', tinted[0].value, { scope: 'tree' });
window.RelatumStudyPalette.applyColorTones(studyTarget.element, 'task-color', tinted[0].value, { scope: 'study' });
assert.notStrictEqual(
  treeTarget.properties.get('--branch-color-dark-ink'),
  studyTarget.properties.get('--task-color-dark-ink'),
  'Tree and Study must resolve foregrounds from their independent fill preferences',
);

assert(study.includes("applyColorTones(el, 'task-color', color, { scope: 'study' })"),
  'Study cards must receive the shared light and dark presentation tones');
assert(route.includes("applyColorTones(element, 'branch-color', routeNodeColor, { scope: 'study' })"),
  'Study goal-tree cards must use the Study presentation preference');
assert(tree.includes("applyColorTones(element, 'branch-color', routeNodeColor, { scope: 'tree' })"),
  'independent Tree cards must use the Tree presentation preference');
[route, tree].forEach((source) => assert(source.includes('--palette-swatch-light:') && source.includes('--palette-swatch-dark:'),
  'goal-tree palettes must preview the theme-specific tones'));
[
  '--task-color-light', '--task-color-dark', '--branch-color-light', '--branch-color-dark',
  '--palette-swatch-light', '--palette-swatch-dark',
  '--study-dark-card-fill-strength', '--study-dark-card-accent-strength',
  '--tree-dark-card-fill-strength', '--tree-dark-card-accent-strength',
  'body.start-page[data-start-theme="dark"] .study-list-row[data-task-color]',
  'body.start-page[data-start-theme="dark"] .study-route-node.is-branch[data-branch-color]',
  'body.start-page[data-start-theme="dark"] .tree-page-route-rail',
  'body.start-page[data-start-theme="dark"] .tree-page-route-rail .study-route-rail-orb',
].forEach((needle) => assert(css.includes(needle), 'missing palette presentation rule: ' + needle));

console.log('shared study palette theme contract passed');

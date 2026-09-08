'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const palette = read('assets/study-palette.js');
const styles = read('assets/styles.css');
const i18n = read('assets/i18n.js');

assert(html.includes('data-role="dark-card-presentation-settings"'),
  'the start-page settings panel must expose the dark-card section');
const ranges = html.match(/data-role="dark-card-presentation-range"/g) || [];
assert.strictEqual(ranges.length, 4, 'Tree and Study must each expose fill and accent sliders');
const inkSwitches = html.match(/data-role="dark-card-ink-switch"/g) || [];
assert.strictEqual(inkSwitches.length, 2, 'Tree and Study must each expose a text-color segmented switch');
['tree', 'study'].forEach((page) => {
  const pattern = new RegExp('data-role="dark-card-ink-switch"\\s+data-page="' + page + '" data-value="light"');
  assert(pattern.test(html), page + ' text-color switch must default to white');
});
assert.strictEqual((html.match(/data-ink="auto"/g) || []).length, 2);
assert.strictEqual((html.match(/data-ink="light"/g) || []).length, 2);
assert.strictEqual((html.match(/data-ink="dark"/g) || []).length, 2);
[
  ['tree', 'fill', 15], ['tree', 'accent', 100],
  ['study', 'fill', 15], ['study', 'accent', 100],
].forEach(([page, setting, defaultValue]) => {
  const pattern = new RegExp(
    '<input[^>]+type="range"[^>]+min="0"[^>]+max="100"[^>]+step="5"[^>]+value="' + defaultValue + '"[^>]+'
      + 'data-role="dark-card-presentation-range"[^>]+data-page="' + page + '"[^>]+'
      + 'data-setting="' + setting + '"',
  );
  assert(pattern.test(html), page + ' ' + setting + ' slider must use its agreed factory default');
});
assert(html.indexOf("localStorage.getItem('canvas:darkCardPresentation:v1')") < html.indexOf('href="styles.css"'),
  'the saved strengths must be restored before the external stylesheet loads');

[
  "const DARK_CARD_PRESENTATION_KEY = 'canvas:darkCardPresentation:v1'",
  'const DARK_CARD_FILL_DEFAULT = 15',
  'const DARK_CARD_ACCENT_DEFAULT = 100',
  "const DARK_CARD_INK_DEFAULT = 'light'",
  'function normalizeDarkCardInk(value)',
  'function normalizeDarkCardPresentation(value)',
  'function applyDarkCardPresentation(value, persist)',
  "localStorage.setItem(DARK_CARD_PRESENTATION_KEY, JSON.stringify(darkCardPresentation))",
  "document.dispatchEvent(new CustomEvent('relatum:dark-card-presentation-change'",
  "darkCardPresentationSettings.setAttribute('aria-disabled', dark ? 'false' : 'true')",
  'input.disabled = !dark',
  'button.disabled = !dark',
  "next[page].ink = normalizeDarkCardInk(value)",
  'applyDarkCardPresentation(null, false)',
].forEach((needle) => assert(start.includes(needle), 'missing start-page preference behavior: ' + needle));
[
  ['--tree-dark-card-fill-strength', '15%'], ['--tree-dark-card-accent-strength', '100%'],
  ['--study-dark-card-fill-strength', '15%'], ['--study-dark-card-accent-strength', '100%'],
].forEach(([name, fallback]) => {
  assert(start.includes("setProperty('" + name + "'"), 'start.js must publish ' + name);
  assert(styles.includes('var(' + name + ', ' + fallback + ')'),
    'dark card CSS must consume ' + name + ' with its factory fallback');
});
assert(palette.includes("document.addEventListener('relatum:dark-card-presentation-change'"),
  'the palette must refresh existing card foregrounds when a slider moves');
assert(styles.includes('.start-dark-card-settings.is-disabled')
  && styles.includes('.start-dark-card-settings.is-disabled :is(input, button)'),
  'light-mode disabled controls need a visible disabled treatment');
assert(styles.includes('.start-dark-card-ink-slider')
  && styles.includes('transition: transform 430ms cubic-bezier(.22, 1, .36, 1)')
  && styles.includes('.start-dark-card-ink-switch[data-value="dark"]'),
  'text-color choices must reuse a sliding segmented selection animation');
[
  '深色彩色卡片', '仅深色模式生效', '彩色底不透明度', '彩色边框与侧条',
  '字体颜色', '智能', '白', '黑',
  '树状页彩色底不透明度', '学习页彩色底不透明度',
  '树状页卡片字体颜色', '学习页卡片字体颜色',
].forEach((label) => assert(i18n.includes("'" + label + "':"), 'missing English UI copy for ' + label));

console.log('start dark-card presentation contract passed');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.js'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');

[
  'data-role="settings-reset-open"',
  'data-role="settings-reset-confirm"',
  'data-role="settings-reset-cancel"',
  'data-role="settings-reset-accept"',
  'role="alertdialog"',
].forEach((needle) => assert(html.includes(needle), 'missing reset UI contract: ' + needle));

assert(html.indexOf('class="settings-pop-head"') < html.indexOf('class="settings-select toolbar-language-select"'),
  'reset entry must live in the compact settings header');
assert(!html.includes('settings-reset-copy'),
  'reset trigger must not grow into a title-and-description card');

[
  "toolbarCopy('settingsResetDone')",
  "document.dispatchEvent(new CustomEvent('editor:settings-reset-cancel'",
  "localStorage.removeItem(preference.key)",
  "{ role: 'pan-speed', value: '8'",
  "{ role: 'enable-mindmap-inspector', checked: false",
  "{ role: 'enable-autosave', checked: true",
].forEach((needle) => assert(editor.includes(needle), 'missing reset behavior contract: ' + needle));

const removedZoomPreferenceSurface = html + '\n' + editor + '\n' + canvas + '\n' + styles;
[
  'data-role="zoom-preset"',
  'data-role="zoom-pref"',
  'canvas:zoomPref',
  'zoomPrefInput',
  'zoomPresetBtn',
  'settings-zoom-row',
  'editor-zoom-pref',
].forEach((needle) => assert(!removedZoomPreferenceSurface.includes(needle),
  'removed preferred zoom feature must not leave implementation residue: ' + needle));

const popupStart = editor.indexOf('(function setupSettingsPopup()');
const popupEnd = editor.indexOf('// 小手电筒', popupStart);
assert(popupStart >= 0 && popupEnd > popupStart, 'missing bounded settings popup implementation');
const popupBlock = editor.slice(popupStart, popupEnd);
assert(popupBlock.includes("pop.addEventListener('wheel'"),
  'settings panel must intercept wheel events before they reach the canvas');
assert(popupBlock.includes('event.stopPropagation();'),
  'settings panel wheel handling must preserve panel scrolling while preventing canvas zoom');
assert(popupBlock.includes("pop.classList.add('is-closing')"),
  'settings panel must play a finite exit transition before hiding');
assert(popupBlock.includes("pop.classList.toggle('is-scrolled', pop.scrollTop > 4)"),
  'settings panel must expose a scrolled state for the sticky header');

const resetStart = editor.indexOf('(function setupSettingsReset()');
const resetEnd = editor.indexOf('// ── 正常普通模式', resetStart);
assert(resetStart >= 0 && resetEnd > resetStart, 'missing bounded settings reset implementation');
const resetBlock = editor.slice(resetStart, resetEnd);
assert(!resetBlock.includes('canvas:toolbarLanguage'),
  'reset behavior must preserve the interface language preference');
assert(styles.includes('.settings-reset-confirm[hidden]'),
  'reset confirmation must have a hidden state');
assert(styles.includes('.settings-reset-confirm.is-visible'),
  'reset confirmation must use a finite visible transition state');
assert(styles.includes('.settings-reset-area.is-restored .settings-reset-btn'),
  'reset success feedback must replace instead of overlap the trigger');
assert(!resetBlock.includes('openBtn.hidden = confirming'),
  'reset confirmation must not make the compact header jump');
assert(resetBlock.includes("element.focus({ preventScroll: true })"),
  'reset confirmation focus must not change the settings scroll position');
assert(resetBlock.includes('settingsPanel.scrollTop = previousScrollTop'),
  'reset confirmation must explicitly preserve the sticky panel scroll position');
assert(resetBlock.includes("openBtn.addEventListener('mousedown', (event) => event.preventDefault())"),
  'mouse focus on the sticky reset trigger must not scroll back to its DOM origin');
assert(styles.includes('.editor-page[data-background-tone="dark"] .settings-reset-confirm'),
  'reset confirmation must support dark semantic UI');
assert(/\.settings-pop-head\s*\{\s*position:\s*sticky;/.test(styles),
  'compact settings header must stay available while the panel scrolls');
assert(/\.settings-reset-confirm\s*\{\s*position:\s*absolute;/.test(styles),
  'reset confirmation must float without increasing panel content height');
assert(styles.includes('min-height: 26px;'),
  'reset controls must keep the compact 26px height');
assert(styles.includes('@keyframes settings-panel-in') && styles.includes('@keyframes settings-panel-out'),
  'settings panel must provide matched finite enter and exit transitions');
assert(/\.settings-pop\s*\{[\s\S]*?backdrop-filter:\s*none;/.test(styles),
  'settings panel must avoid a continuous backdrop blur');
assert(/\.settings-pop \.settings-slider\s*\{\s*display:\s*flex;/.test(styles),
  'settings panel sliders must remain visible below the top-bar responsive breakpoint');
assert(/\.settings-pop \.settings-slider \.editor-slider-label\s*\{\s*display:\s*block;/.test(styles),
  'settings panel slider labels must remain visible below the top-bar responsive breakpoint');
assert(!styles.includes('#705443') && !styles.includes('#a26842'),
  'reset UI must remain monochrome');

console.log('editor settings reset contract: ok');

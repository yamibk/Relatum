const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const notes = fs.readFileSync(path.join(root, 'assets', 'notes.js'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'assets', 'i18n.js'), 'utf8');
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

const wheelHandler = notes.match(/surface\.addEventListener\('wheel',[\s\S]*?\}, \{ passive: false \}\);/);
assert(wheelHandler, 'Quick Notes must install a non-passive wheel handler');
assert(wheelHandler[0].includes('zoomViewTo(targetViewScale * factor, e.clientX, e.clientY);'),
  'wheel input must zoom around the pointer');
assert(!wheelHandler[0].includes('editingEl'),
  'wheel zoom must remain available while editing a sticky note');
assert(!wheelHandler[0].includes("closest('.sticky-note')") && !wheelHandler[0].includes('isMultiPile'),
  'sticky notes and stacks must not intercept camera wheel zoom');

[
  'NOTES_WHEEL_PAN',
  'NOTES_WHEEL_EASE',
  'wheelPanBy',
  'wheelPanTick',
  'stackWheelAccum',
  'STACK_WHEEL_THRESHOLD',
  'STACK_WHEEL_COOLDOWN',
  'flipStack(',
].forEach((legacy) => assert(!notes.includes(legacy), 'legacy wheel behavior must be removed: ' + legacy));

assert(notes.includes('const NOTES_VIEW_MIN = 0.45;') && notes.includes('const NOTES_VIEW_MAX = 2.35;'),
  'Quick Notes must retain its established zoom bounds');
assert(notes.includes("const NOTES_VIEW_KEY = 'canvas:notesView';")
  && notes.includes('localStorage.setItem(NOTES_VIEW_KEY'),
  'Quick Notes must retain its existing camera persistence key and format');
assert(notes.includes('if (spaceHeld)') && notes.includes('startViewPanInertia(panState);'),
  'Space-drag panning and its inertia must remain available');
assert(notes.includes("points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }]")
  && notes.includes('finishSlash(st);'),
  'blank-surface slash deletion must remain available');
assert(start.includes("if (notesActive && window.CanvasNotes && typeof window.CanvasNotes.resetView === 'function')")
  && start.includes('window.CanvasNotes.resetView();'),
  'clicking the active Quick Notes spine must retain default-camera reset');
assert(start.includes("notesConsolePanel.addEventListener('wheel', (event) => event.stopPropagation()"),
  'the Quick Notes console must isolate its own wheel input');
assert(indexHtml.includes('<kbd>滚轮</kbd></dt><dd>以鼠标位置为中心缩放视野</dd>'),
  'Quick Notes help must document pointer-anchored wheel zoom');
assert(i18n.includes("'以鼠标位置为中心缩放视野': 'Zoom the view around the pointer'"),
  'Quick Notes wheel help must include its English translation');
assert(agents.includes('普通滚轮在空白、普通便签和叠摞便签上都以鼠标位置为锚点连续缩放'),
  'AGENTS.md must describe the current Quick Notes camera behavior');

console.log('Quick Notes camera contract: ok');

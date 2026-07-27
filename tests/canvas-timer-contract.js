'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/editor.html');
const editor = read('assets/editor.js');
const canvas = read('assets/canvas.js');
const styles = read('assets/styles.css');
const i18n = read('assets/i18n.js');
const agents = read('AGENTS.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0, 'missing section start: ' + start);
  assert(to > from, 'missing section end: ' + end);
  return source.slice(from, to);
}

assert(
  html.indexOf('<script src="canvas-timer.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'the pure timer module must load before canvas.js',
);
assert(/data-action="canvas-timer"[\s\S]*?data-toolbar-i18n="canvasTimer"/.test(html));
assert(/data-role="canvas-timer-dialog"[\s\S]*?aria-modal="true"/.test(html));
assert.strictEqual((html.match(/name="canvas-timer-mode"/g) || []).length, 2);
assert.strictEqual((html.match(/data-timer-minutes=/g) || []).length, 4);
assert(html.includes('data-role="canvas-timer-hours"'));
assert(html.includes('data-role="canvas-timer-submit"'));

assert(editor.includes("document.addEventListener('editor:open-canvas-timer'"));
assert(editor.includes("document.addEventListener('editor:edit-canvas-timer'"));
assert(editor.includes('window.CanvasModule.createCanvasTimer(config)'));
assert(editor.includes('window.CanvasModule.updateCanvasTimer(editingTimer.id, config)'));
assert(
  editor.indexOf('window.CanvasModule.createCanvasTimer(config)')
    < editor.indexOf("window.EditorShell.setMode('normal')", editor.indexOf('function submit()', editor.indexOf('setupCanvasTimerDialog'))),
  'canvas mode must change only after timer creation succeeds',
);

const timerRuntime = section(canvas, '// ── 工具 · 倒计时 / 正计时', '// ── 工具 · 尺子');
assert(timerRuntime.includes('const timerRuntime = new Map') || canvas.includes('const timerRuntime = new Map'));
assert(timerRuntime.includes("mode: 'timer'"));
assert(timerRuntime.includes('function toggleSelectedTimers()'));
assert(timerRuntime.includes('function checkpointCanvasTimers()'));
assert(timerRuntime.includes('function timerIdsInFrame(rect)'));
assert(timerRuntime.includes('function frameTouchesOtherObject(rect, nodeSizes)') || canvas.includes('function frameTouchesOtherObject(rect, nodeSizes)'));
assert(canvas.includes('selectedTimerIds'));
assert(canvas.includes("delete data.timers"));
assert(canvas.includes('global.CanvasModule.createCanvasTimer = createCanvasTimer'));
assert(canvas.includes('global.CanvasModule.updateCanvasTimer = updateCanvasTimer'));
assert(canvas.includes('global.CanvasModule.toggleSelectedTimers = toggleSelectedTimers'));
assert(canvas.includes('global.CanvasModule.resetSelectedTimers = resetSelectedTimers'));
assert(canvas.includes('global.CanvasModule.checkpointCanvasTimers = checkpointCanvasTimers'));
assert(canvas.includes("clone.querySelectorAll('[data-canvas-timer-layer]')"));
assert(!timerRuntime.includes('setInterval('), 'timers should share an aligned timeout loop');

const toggle = section(canvas, 'function toggleSelectedTimers()', 'function resetSelectedTimers()');
assert.strictEqual((toggle.match(/const now = Date\.now\(\)/g) || []).length, 1);
assert(toggle.includes('Timer.toggleBatch(entries, now)'));
assert.strictEqual((toggle.match(/notify\(\)/g) || []).length, 1);
assert.strictEqual((toggle.match(/pushHistory\(\)/g) || []).length, 0);

const create = section(canvas, 'function createCanvasTimer(config)', 'function updateCanvasTimer(id, config)');
assert.strictEqual((create.match(/pushHistory\(\)/g) || []).length, 1);
assert.strictEqual((create.match(/notify\(\)/g) || []).length, 1);

assert(styles.includes('.canvas-timer-layer'));
assert(styles.includes('.canvas-timer-toolbar'));
assert(styles.includes('.canvas-timer-dialog-card'));
const timerCardRule = /\.canvas-timer-dialog-card\s*\{([\s\S]*?)\}/.exec(styles);
assert(timerCardRule);
assert(!/backdrop-filter/.test(timerCardRule[1]));
assert(i18n.includes("'工具 → 倒计时 / 正计时': 'Tools → Countdown / Stopwatch'"));
assert(agents.includes('`assets/canvas-timer.js`'));
assert(agents.includes('`timers[]`'));

console.log('canvas timer interaction contract passed');

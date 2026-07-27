const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/editor.html');
const editor = read('assets/editor.js');
const canvas = read('assets/canvas.js');
const ruler = read('assets/ruler.js');
const styles = read('assets/styles.css');
const i18n = read('assets/i18n.js');

assert(
  html.indexOf('<script src="ruler.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'ruler geometry must load before canvas.js',
);
assert(
  /data-action="tools"[\s\S]*?data-toolbar-i18n="tools"/.test(html),
  'the top bar must expose a translated transient Tools entry',
);
assert(
  /<div class="editor-mode-switch"[\s\S]*?data-action="tools"[\s\S]*?<\/div>/.test(html),
  'Tools must reuse the same segmented-control shell as the three mode buttons',
);
assert(
  /data-action="tools"[^>]*>/.exec(html)[0].indexOf('data-mode=') < 0,
  'Tools must not become a persisted canvas mode',
);
assert.strictEqual(
  (html.match(/data-ruler-angle-preset="/g) || []).length,
  8,
  'the ruler angle menu must expose eight presets',
);
assert(html.includes('data-role="ruler-angle-input"'));
assert(editor.includes("rulerMenu: document.querySelector('[data-role=\"ruler-angle-menu\"]')"));
assert(
  editor.includes("querySelectorAll('.editor-mode-btn[data-mode]')"),
  'mode switching must only bind buttons with a real data-mode',
);
assert(
  editor.includes("const VALID = ['normal', 'mindmap', 'decor'];"),
  'the persisted mode set must remain normal / mindmap / decor',
);
assert(editor.includes('embed: EMBED'), 'embedded editors must explicitly disable the ruler');
assert(canvas.includes('cloneState(data.nodes, data.edges, data.ink, data.ruler, snapshotTimers())'));
assert(canvas.includes('data.ruler = snapshotRuler'));
assert(canvas.includes('Ruler.canConstrainSelection(candidateRects, data.ruler'));
assert(canvas.includes('Ruler.constrainTranslation('));
assert(canvas.includes('if (altKey) {'), 'node drag must support gesture-scoped Alt bypass');
assert(canvas.includes('Ruler.nearestEdge(p, data.ruler, { scale: curScale })'));
assert(canvas.includes('Ruler.projectPointToEdge(raw, data.ruler, drag.rulerEdgeSign)'));
assert(ruler.includes('function captureEdgeAlongSegment('));
assert(ruler.includes('captureEdgeAlongSegment: captureEdgeAlongSegment'));
const predictedStart = canvas.indexOf('function predictedTailPoints(');
const appendStart = canvas.indexOf('function appendInkPointFromEvent(', predictedStart);
const appendEnd = canvas.indexOf('function appendInkPointsFromPointerEvent(', appendStart);
const predictedSection = canvas.slice(predictedStart, appendStart);
const appendSection = canvas.slice(appendStart, appendEnd);
assert(
  !predictedSection.includes('captureEdgeAlongSegment'),
  'speculative predicted points must never acquire the ruler',
);
assert(appendSection.includes('if (!drag.rulerEdgeSign && rulerAvailable()'));
assert(appendSection.includes('Ruler.captureEdgeAlongSegment('));
assert(appendSection.includes('drag.lastInkRawPoint || confirmedRaw'));
assert(appendSection.includes('drag.rulerEdgeSign = captured.edgeSign'));
assert(appendSection.includes('stroke.points.push(contact)'));
assert(appendSection.includes('drag.lastInkPoint = contact'));
assert(appendSection.includes('showRulerContact()'));
assert(!appendSection.includes('drag.rulerEdgeSign = 0'));
assert(canvas.includes('lastInkRawPoint: { x: rawStart.x, y: rawStart.y }'));
assert(canvas.includes('Ruler.containsPoint(clientToSurface(clientX, clientY), data.ruler'));
const contextMenuStart = canvas.indexOf('function onContextMenu(e)');
const rulerContextHit = canvas.indexOf('rulerHitAtClient(e.clientX, e.clientY)', contextMenuStart);
const drawToolContextGate = canvas.indexOf("if (drawTool !== 'select')", contextMenuStart);
assert(
  contextMenuStart >= 0 && rulerContextHit > contextMenuStart && rulerContextHit < drawToolContextGate,
  'ruler right-click handling must run before the active drawing-tool gate',
);
const rulerPointerHandler = canvas.indexOf("rulerEl.addEventListener('pointerdown'");
const primaryButtonGuard = canvas.indexOf('if (event.button !== 0) return;', rulerPointerHandler);
const removeAction = canvas.indexOf("event.target.closest('[data-ruler-action=\"remove\"]')", rulerPointerHandler);
assert(
  rulerPointerHandler >= 0 && primaryButtonGuard > rulerPointerHandler && primaryButtonGuard < removeAction,
  'right-clicking the ruler remove button must not delete the ruler',
);
const surfaceMouseDownStart = canvas.indexOf('function onSurfaceMouseDown(e)');
const rightButtonBranch = canvas.indexOf('if (e.button === 2)', surfaceMouseDownStart);
const rulerMouseDownHit = canvas.indexOf('rulerHitAtClient(e.clientX, e.clientY)', rightButtonBranch);
const colorBlockStart = canvas.indexOf('startColorBlockCreate(e)', rightButtonBranch);
assert(
  surfaceMouseDownStart >= 0
    && rightButtonBranch > surfaceMouseDownStart
    && rulerMouseDownHit > rightButtonBranch
    && rulerMouseDownHit < colorBlockStart,
  'right-button ruler mousedown must bypass the blank-canvas color-block gesture',
);
assert(canvas.includes('Number.isInteger(number)'));
assert(canvas.includes('const angle = Ruler.normalizeAngle(number)'));
assert(canvas.includes('rulerMenu && !rulerMenu.hidden && e.key === \'Escape\''));
assert(canvas.includes('rulerMenu && !rulerMenu.hidden && !rulerMenu.contains(e.target)'));
assert(
  canvas.includes("window.addEventListener('pointerup', onRulerPointerUp, true)"),
  'ruler gestures must finish even after rotation moves the ruler away from the pointer',
);
assert(canvas.includes("clone.querySelectorAll('.canvas-ruler')"));
assert(canvas.includes('global.CanvasModule.ensureRuler = ensureRuler'));
assert(canvas.includes('global.CanvasModule.focusRuler = focusRuler'));
assert(canvas.includes('global.CanvasModule.removeRuler'));
assert(canvas.includes('global.CanvasModule.hasRuler = hasRuler'));
assert(
  canvas.includes('data.ruler = { cx: center.x, cy: center.y, angle: 90 };'),
  'a newly placed ruler must start vertically at 90 degrees',
);
assert(styles.includes('.canvas-ruler.pen-pass-through'));
assert(
  /\.canvas-ruler-remove\s*\{\s*top:\s*-13px;\s*left:\s*-13px;/.test(styles),
  'the remove control must appear at the screen upper-right when the ruler is at 90 degrees',
);
assert(styles.includes('.editor-tools-pop'));
assert(styles.includes('.ruler-angle-menu'));
assert(i18n.includes("'工具 → 尺子': 'Tools → Ruler'"));
assert(i18n.includes("'右键尺身': 'Right-click the ruler'"));
assert(i18n.includes("'画笔起笔或书写中靠近尺子长边'"));

console.log('ruler interaction contract passed');

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
const agents = read('AGENTS.md');

assert(
  html.indexOf('<script src="canvas-scenes.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'the zero-DOM scenes data layer must load before canvas.js',
);

const toolOrder = [
  'data-action="use-ruler"',
  'data-action="markdown-notebook"',
  'data-action="canvas-scenes"',
  'data-action="import-canvas"',
  'data-action="node-matrix"',
  'data-action="canvas-timer"',
];
let previous = -1;
toolOrder.forEach((needle) => {
  const index = html.indexOf(needle);
  assert(index > previous, 'tool menu order is wrong at ' + needle);
  previous = index;
});

assert(html.includes('data-role="canvas-scenes-panel"'));
assert(html.includes('data-editor-i18n-title="canvasScenesMoveHint"'));
assert(html.includes('data-action="capture-camera-scene"'));
assert(html.includes('data-action="capture-selection-scene"'));
assert(html.includes('data-action="capture-group-scenes"'));
assert(html.includes('data-role="canvas-scenes-presentation"'));
assert(html.includes('data-action="restart-canvas-scenes-presentation"'));
assert(html.includes('data-editor-i18n-aria="canvasScenesRestart"'));
assert(
  html.indexOf('data-action="restart-canvas-scenes-presentation"')
    < html.indexOf('data-action="previous-canvas-scene"'),
  'the restart control must be the leftmost presentation navigation button',
);
assert(html.includes('data-role="canvas-scenes-undo"'));
const panelTag = html.match(/<aside[^>]+data-role="canvas-scenes-panel"[^>]*>/);
assert(panelTag && !panelTag[0].includes('aria-modal'), 'Scenes must remain non-modal');

[
  'global.CanvasModule.captureScene = captureScene',
  'global.CanvasModule.navigateToScene = navigateToScene',
  'global.CanvasModule.getScenePreviewGeometry = getScenePreviewGeometry',
  'global.CanvasModule.captureSelectedGroupsAsScenes = captureSelectedGroupsAsScenes',
  'global.CanvasModule.setScenePresentationMode = setScenePresentationMode',
].forEach((needle) => assert(canvas.includes(needle), 'missing CanvasModule scene API: ' + needle));

assert(canvas.includes('const immediate = !!(options && options.immediate)'));
assert(canvas.includes('semanticGroupMembers(group)'));
assert(canvas.includes('usedFallback: true'));
assert(canvas.includes("viewport.classList.toggle('scene-presentation-active', next)"));
assert(canvas.includes("document.dispatchEvent(new CustomEvent('canvas:scene-geometry-change'))"));

const start = editor.indexOf('(function setupCanvasScenes()');
const end = editor.indexOf('// ── 节点矩阵', start);
assert(start >= 0 && end > start, 'missing Scenes editor controller');
const controller = editor.slice(start, end);
assert(controller.includes("document.addEventListener('editor:open-canvas-scenes', open)"));
assert(controller.includes("list.addEventListener('pointerdown'"));
assert(controller.includes('Math.hypot(dx, dy) < 6'));
assert(controller.includes('function flipSceneRows(mutate)'));
assert(controller.includes('function flySceneGhostTo(ghost, row, done)'));
assert(controller.includes('row.animate(['), 'sorting must use live FLIP displacement');
assert(controller.includes('canvas-scene-drag-ghost'));
assert(controller.includes("state.handle.setPointerCapture(state.pointerId)"));
assert(controller.includes("ghost.style.transition = 'none'"));
assert(
  controller.indexOf('positionSceneDragGhost(state, state.startX, state.startY)')
    < controller.indexOf('document.body.appendChild(ghost)'),
  'the scene ghost must be positioned before insertion',
);
assert(controller.includes("row.classList.add('is-drag-handoff')"));
assert(controller.includes("dragState.row.nextElementSibling === beforeNode"));
assert(controller.includes("list.addEventListener('dragstart', (event) => event.preventDefault())"));
assert(!controller.includes('DataTransfer'));
assert(!controller.includes('.draggable ='));
assert(!controller.includes("addEventListener('drop'"));
assert(controller.includes('Scenes.reorderScenes(currentBook(), orderedIds)'));
assert(controller.includes('if (changed) {'), 'unchanged sorting must not dirty data');
assert(controller.includes("const PANEL_POSITION_KEY = 'canvas:sceneBookPanelPosition:v1'"));
assert(controller.includes('const PANEL_SNAP_DISTANCE = 24'));
assert(controller.includes("panelHead.addEventListener('pointerdown', beginPanelDrag)"));
assert(controller.includes("panelHead.addEventListener('dblclick', resetPanelPosition)"));
assert(controller.includes("panelHead.setPointerCapture(state.pointerId)"));
assert(controller.includes("panel.style.setProperty('--canvas-scenes-left'"));
assert(controller.includes("panel.style.setProperty('--canvas-scenes-top'"));
assert(controller.includes("localStorage.removeItem(PANEL_POSITION_KEY)"));
assert(controller.includes("sequence.textContent = String(index + 1).padStart(2, '0')"));
assert(controller.includes('function syncSceneSequenceLabels()'));
assert(controller.includes("main.setAttribute('aria-current', 'true')"));
assert(controller.includes('undoState = { scene: book.scenes[index], index: index }'));
assert(controller.includes("event.key === 'PageDown' || event.key === ' '"));
assert(controller.includes("event.key === 'Escape'"));
assert(controller.includes('focusViewport()'));
assert(controller.includes('presentationIndexValue = selectedIndex >= 0 ? selectedIndex : 0'));
assert(controller.includes(
  "presentation.querySelector('[data-action=\"restart-canvas-scenes-presentation\"]')",
));
assert(controller.includes('if (restartButton) restartButton.disabled = presentationIndexValue === 0'));
assert(controller.includes("restartButton.addEventListener('click'"));
assert(controller.includes('goToPresentationScene(0)'));
assert(editor.includes("canvasScenesRestart: '回到第一个镜头'"));
assert(editor.includes("canvasScenesRestart: 'Restart from the first scene'"));

assert(styles.includes('.canvas-scenes-panel'));
assert(styles.includes('.canvas-scene-drag-ghost'));
assert(styles.includes('body.canvas-scenes-presenting .editor-top-bar'));
assert(styles.includes('@media (max-width: 760px)'));
assert(styles.includes('@media (prefers-reduced-motion: reduce)'));
const panelRule = /\.canvas-scenes-panel\s*\{([\s\S]*?)\}/.exec(styles);
assert(panelRule && !/backdrop-filter/.test(panelRule[1]));
assert(/height:\s*min\(82vh,\s*calc\(100vh - 32px\)\)/.test(panelRule[1]));
assert(/left:\s*var\(--canvas-scenes-left,\s*92px\)/.test(panelRule[1]));
assert(/top:\s*var\(--canvas-scenes-top,\s*76px\)/.test(panelRule[1]));
assert(/\.canvas-scene-drag-ghost\s*\{[\s\S]*?transition:\s*none !important;/.test(styles));
assert(/body\.canvas-scene-dragging \.canvas-scene-card\s*\{[\s\S]*?transition:\s*none !important;/.test(styles));
assert(/\.canvas-scene-card\.is-drag-placeholder\s*\{[\s\S]*?visibility:\s*hidden;/.test(styles));
assert(styles.includes('.canvas-scenes-panel.is-resetting'));
assert(styles.includes('.canvas-scene-sequence'));
assert(styles.includes('.canvas-scene-card.active .canvas-scene-sequence::before'));
assert(!/canvasData\.(?:scenePreview|sceneThumbnail|sceneScreenshot)/.test(editor + canvas));

assert(agents.includes('`assets/canvas-scenes.js`'));
assert(agents.includes('`sceneBook:{version:1,scenes[]}`'));
assert(agents.includes('Pointer Events 阈值'));
assert(agents.includes('WAAPI 落位交接'));

console.log('canvas scenes interaction contract passed');

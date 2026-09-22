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

[
  'data-role="canvas-coordinate-canvas"',
  'data-role="coordinates-visible"',
  'data-role="axis-opacity"',
  'data-role="axis-opacity-val"',
  'data-role="coordinate-labels-visible"',
  'data-role="canvas-origin-btn"',
  'data-role="background-guides"',
  'data-role="background-guide-hint"',
].forEach((token) => assert(html.includes(token), 'missing coordinate editor control: ' + token));

assert(html.indexOf('data-role="canvas-coordinate-canvas"') < html.indexOf('data-role="canvas-edges-canvas"'),
  'the coordinate canvas must stay beneath the edge canvas');
assert(/data-role="axis-opacity"[\s\S]*?min="0"[\s\S]*?max="1"[\s\S]*?step="0\.05"[\s\S]*?value="1"[\s\S]*?disabled/.test(html),
  'axis opacity must keep the Research range and disabled default');

[
  "'canvas:coordinatesVisible:v1'",
  "'canvas:axisOpacity:v1'",
  "'canvas:coordinateLabelsVisible:v1'",
  'function coordinateStep(scale, targetPixels)',
  'function formatCoordinate(value, step)',
  'function renderCoordinatePlane()',
  'function centerCoordinateOrigin()',
  'const coordinateCtx = coordinateCanvas ? coordinateCanvas.getContext(\'2d\') : null',
  'targetPanX = panX',
  'targetPanY = panY',
  'setViewportImmediate(targetScale, panX, panY)',
  'onCoordinatesVisibilityChange(coordinatesVisible)',
].forEach((token) => assert(canvas.includes(token), 'missing coordinate canvas behavior: ' + token));

assert(canvas.includes('const raw = Math.max(Number.MIN_VALUE, (Number(targetPixels) || 80) / safeScale)'),
  'coordinate spacing must retain the adaptive 1/2/5 algorithm');
assert(canvas.includes('coordinateCtx.fillText(formatCoordinate(-y, step), labelX, screenY)'),
  'vertical labels must use mathematical positive-up coordinates');
assert(!/function renderCoordinatePlane\(\)[\s\S]{0,500}EDGE_CANVAS_ON/.test(canvas),
  'coordinate rendering must not depend on the optimized edge canvas');

[
  'coordinateCanvas:',
  'coordinatesVisibleInput:',
  'axisOpacityInput:',
  'axisOpacityValue:',
  'coordinateLabelsVisibleInput:',
  'centerOriginButton:',
  'onCoordinatesVisibilityChange: setCoordinateTakeoverActive',
  'guideLayerEl.hidden = coordinatesTakeoverActive || guide.type === \'none\'',
  'topbarGuideLayerEl.hidden = coordinatesTakeoverActive || guide.type === \'none\'',
  'button.disabled = coordinatesTakeoverActive',
  'coordinateGuideTakeoverHint',
  'Center the coordinate origin',
].forEach((token) => assert(editor.includes(token), 'missing editor coordinate integration: ' + token));

assert(styles.includes('.canvas-origin-fab') && styles.includes('right: 162px'),
  'the origin button must reserve a slot left of the cleanup button');
assert(/\.assets-clean-btn\[hidden\]\s*~\s*\.canvas-origin-fab\s*\{\s*right:\s*126px/.test(styles),
  'the origin button must collapse into the cleanup slot when cleanup is hidden');
assert(styles.includes('.canvas-coordinate-canvas') && styles.includes('--canvas-coordinate-grid'),
  'the coordinate layer needs dedicated light/dark visual tokens');
assert(styles.includes('.background-guide-choice:disabled'),
  'guide choices must visibly disable while coordinate mode owns the backdrop');

console.log('editor coordinate controls contract passed');

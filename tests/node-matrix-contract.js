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
  html.indexOf('<script src="node-matrix.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'the pure matrix module must load before canvas.js',
);
assert(/data-action="node-matrix"[\s\S]*?data-toolbar-i18n="nodeMatrix"/.test(html));
assert(/data-role="node-matrix-dialog"[\s\S]*?aria-modal="true"/.test(html));
assert.strictEqual((html.match(/name="node-matrix-kind"/g) || []).length, 5);
assert.strictEqual((html.match(/name="node-matrix-content"/g) || []).length, 3);
assert(html.includes('data-role="node-matrix-preview-grid"'));
assert(html.includes('data-role="node-matrix-paste-text"'));
assert(html.includes('data-action="create-node-matrix"'));

assert(editor.includes("const STORAGE_KEY = 'canvas:nodeMatrixDefaults:v1'"));
assert(editor.includes("document.addEventListener('editor:open-node-matrix', open)"));
assert(editor.includes("window.EditorShell.setMode('normal')"));
assert(editor.includes('window.CanvasModule.createNodeMatrix(collectConfig())'));
assert(
  editor.indexOf('window.CanvasModule.createNodeMatrix(collectConfig())')
    < editor.indexOf("window.EditorShell.setMode('normal')", editor.indexOf('function submit()')),
  'the editor must switch to canvas mode only after matrix creation succeeds',
);
assert(editor.includes("event.key === 'Enter' && (event.ctrlKey || event.metaKey)"));
assert(editor.includes('window.CanvasModule.setExternalOverlayOpen(true)'));
assert(editor.includes('window.CanvasModule.setExternalOverlayOpen(false)'));

const createData = section(canvas, 'function createMatrixNodeData(', 'function createNodeMatrix(');
const createMatrix = section(canvas, 'function createNodeMatrix(', 'function defaultTableMarkdown(');
assert(createMatrix.includes('Matrix.buildCells(rawConfig)'));
assert(createMatrix.includes('Matrix.resolveUniformWidth(naturalWidths, config'));
assert(createMatrix.includes('Matrix.layout(sizes, config, viewportCenterInSurface())'));
assert(createData.includes("applyProDefaults(node, kind)"));
assert(createData.includes("if (kind === 'sticky')"));
assert(createData.includes("else if (kind === 'code')"));
assert(canvas.includes("localStorage.getItem('canvas:normalSubmode') === 'full' ? 'full' : 'clean'"));
assert(createMatrix.includes('selectedNodeIds.add(node.id)'));
assert.strictEqual((createMatrix.match(/pushHistory\(\)/g) || []).length, 1);
assert.strictEqual((createMatrix.match(/notify\(\)/g) || []).length, 1);
assert(!createMatrix.includes('newEdgeId('), 'matrix generation must not create edges');
assert(!createMatrix.includes('groupMemberIds'), 'matrix generation must not create semantic groups');
assert(canvas.includes('global.CanvasModule.createNodeMatrix = createNodeMatrix'));

const overlayRule = /\.node-matrix-card\s*\{([\s\S]*?)\}/.exec(styles);
assert(overlayRule, 'node matrix paper panel styles must exist');
assert(!/backdrop-filter/.test(overlayRule[1]), 'the matrix panel must use an opaque paper surface');
assert(styles.includes('.matrix-node-measuring'));
assert(styles.includes('.editor-page[data-background-tone="dark"] .node-matrix-card'));
assert(styles.includes('@media (prefers-reduced-motion: reduce)'));
assert(i18n.includes("'工具 → 节点矩阵': 'Tools → Node Matrix'"));
assert(agents.includes('`assets/node-matrix.js`'));
assert(agents.includes('canvas:nodeMatrixDefaults:v1'));

console.log('node matrix interaction contract passed');

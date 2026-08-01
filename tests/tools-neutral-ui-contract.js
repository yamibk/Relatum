'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.js'), 'utf8');

const marker = '/* ── 画布工具 · 中性黑白视觉系统';
const from = styles.indexOf(marker);
assert(from >= 0, 'the neutral tools visual system must exist');
const neutral = styles.slice(from);

[
  '--tool-surface: #ffffff',
  '--tool-text: #111111',
  '--tool-border: #e7e7e7',
  '--tool-surface: #171717',
  '--tool-text: #f5f5f5',
  '.editor-tools-pop',
  '.canvas-import-library-card',
  '.node-matrix-card',
  '.ruler-angle-menu',
  '.canvas-ruler',
  '.canvas-timer-dialog-card',
].forEach((token) => assert(neutral.includes(token), 'missing neutral tools token: ' + token));
assert(styles.includes('.markdown-notebook-card'));

assert(/\.editor-tools-pop,[\s\S]*?width:\s*292px;/.test(neutral));
assert(/\.editor-tool-card,[\s\S]*?min-height:\s*58px;/.test(neutral));
assert(/\.editor-tool-icon,[\s\S]*?width:\s*32px;/.test(neutral));
assert(neutral.includes('body.editor-tools-open .editor-top-bar'));
assert(neutral.includes('.editor-tools-pop.tool-layer-entering'));
assert(neutral.includes('.canvas-import-library-overlay.tool-layer-leaving'));
assert(neutral.includes('.node-matrix-overlay.tool-layer-entering'));
assert(neutral.includes('.canvas-timer-dialog-overlay.tool-layer-leaving'));
assert(neutral.includes('.ruler-angle-menu.tool-layer-entering'));
assert(neutral.includes('@media (prefers-reduced-motion: reduce)'));
assert(!/blur\(/.test(neutral), 'tool surfaces must not add persistent blur');
assert(
  !/(#faf9f4|#efede5|#315d47|#fbfaf5|#18221c|#315c43|#466b56|#fbf5e9)/i.test(neutral),
  'the neutral tools override must not reintroduce warm, green, or amber legacy colors',
);

assert.strictEqual((html.match(/class="editor-tool-icon/g) || []).length, 8);
assert(editor.includes("rulerHint: '对齐笔迹与节点'"));
assert(editor.includes("markdownNotebookHint: '长期笔记与导图快照'"));
assert(editor.includes("canvasScenesHint: '保存视角并组织演示'"));
assert(editor.includes("canvasTaskbookHint: '管理顶级任务与任务树'"));
assert(editor.includes("importCanvasHint: '合并另一张画布的内容'"));
assert(editor.includes("dualScreenHint: '打开只读参考画布'"));
assert(editor.includes("nodeMatrixHint: '批量创建规则排列的节点'"));
assert(editor.includes("canvasTimerHint: '添加独立计时器'"));
assert(editor.includes("rulerHint: 'Align strokes and nodes'"));
assert(editor.includes("canvasTaskbookHint: 'Manage top-level tasks and task trees'"));
assert(editor.includes("dualScreenHint: 'Open a read-only reference canvas'"));
assert(editor.includes("canvasTimerHint: 'Add an independent timer'"));
assert(editor.includes("document.body.classList.add('editor-tools-open')"));
assert(editor.includes("document.body.classList.remove('editor-tools-open')"));
assert(editor.includes('function revealToolLayer(layer)'));
assert(editor.includes('function concealToolLayer(layer, onHidden, duration)'));
assert(editor.includes("layer.classList.add('tool-layer-entering')"));
assert(editor.includes("layer.classList.add('tool-layer-leaving')"));
assert(editor.includes('layer.hidden = true'));

const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
assert(canvas.includes("rulerMenu.classList.add('tool-layer-entering')"));
assert(canvas.includes("rulerMenu.classList.add('tool-layer-leaving')"));
assert(canvas.includes('rulerMenu.hidden = true'));

console.log('neutral tools UI contract passed');

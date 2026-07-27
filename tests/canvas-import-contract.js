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
const app = read('app.py');

assert(
  html.indexOf('<script src="canvas-import.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'the pure canvas import module must load before canvas.js',
);
assert(
  /data-action="import-canvas"[\s\S]*?data-toolbar-i18n="importCanvas"/.test(html),
  'the Tools popover must expose the translated Import Canvas card',
);
assert(
  /data-role="canvas-import-library"[\s\S]*?aria-modal="true"/.test(html),
  'the editor shell must contain a modal managed-canvas library',
);
assert(html.includes('data-role="canvas-import-groups"'));
assert(html.includes('data-role="canvas-import-files"'));
assert(html.includes('data-role="canvas-import-search"'));
assert(html.includes('data-action="confirm-canvas-import"'));
assert(
  !html.includes('data-role="canvas-import-input"'),
  'the operating-system file picker must be removed from the editor',
);
assert(
  editor.includes('/api/canvas-import-library?current='),
  'the picker must load its choices from the managed canvas library API',
);
assert(editor.includes('window.CanvasModule.importManagedCanvas(importSelectedId)'));
assert(editor.includes("json.currentGroupId === '__inbox__'"));
assert(editor.includes("importView = 'group:' + json.currentGroupId"));
assert(editor.includes("event.key === 'Enter'"));
assert(canvas.includes("assetPolicy: 'include'"), 'managed import must retain asset nodes');
assert(canvas.includes('/api/canvas-import-source?id='));
assert(canvas.includes("canvasImportRequest('/api/canvas-import-assets'"));
assert(canvas.includes('revision: source.revision'));
assert(canvas.includes('global.CanvasModule.importManagedCanvas = importManagedCanvas'));
assert(!canvas.includes('global.CanvasModule.chooseCanvasImport'));
assert(!canvas.includes('addCanvasFromFile('));
assert(
  canvas.includes('请从“工具 → 导入画布”的画布库中选择来源。'),
  'Explorer .canvas drops must be redirected to the managed picker',
);
assert(canvas.includes('const mergedInk = cloneInk(data.ink)'), 'ink must be prepared before committing');
assert(canvas.includes('const before = {'), 'the commit path must retain rollback state');
assert(canvas.includes('data.nodes.length = before.nodeLength'));
assert(canvas.includes('data.edges.length = before.edgeLength'));
assert(canvas.includes('data.ink = before.ink'));
assert(!canvas.includes("window.alert('拖入画布失败"), 'canvas import feedback must use the canvas toast');
assert(app.includes('"/api/canvas-import-library"'));
assert(app.includes('"/api/canvas-import-source"'));
assert(app.includes('"/api/canvas-import-assets"'));
assert(app.includes('def canvas_import_library_payload('));
assert(app.includes('def copy_canvas_import_assets('));
assert(app.includes('def _api_import_canvas('), 'the start-page external import-as-new flow must remain');
assert(styles.includes('.canvas-viewport.file-drag-over::after'));
const dropRule = /\.canvas-viewport\.file-drag-over::after\s*\{([\s\S]*?)\}/.exec(styles);
assert(dropRule && !/backdrop-filter/.test(dropRule[1]), 'the file drop affordance must not use sustained blur');
const pickerRule = /\.canvas-import-library-card\s*\{([\s\S]*?)\}/.exec(styles);
assert(pickerRule && !/backdrop-filter/.test(pickerRule[1]), 'the library card must use an opaque paper surface');
assert(styles.includes('@media (prefers-reduced-motion: reduce)'));
assert(i18n.includes("'工具 → 导入画布': 'Tools → Import Canvas'"));

console.log('canvas import interaction contract passed');

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
const viewerHtml = read('assets/dual-viewer.html');
const viewer = read('assets/dual-viewer.js');

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
  /data-action="dual-screen"[\s\S]*?data-toolbar-i18n="dualScreen"/.test(html),
  'the Tools popover must expose the translated Dual Screen card',
);
assert(
  /data-role="canvas-import-library"[\s\S]*?aria-modal="true"/.test(html),
  'the editor shell must contain a modal managed-canvas library',
);
assert(html.includes('data-role="canvas-import-groups"'));
assert(html.includes('data-role="canvas-import-files"'));
assert(html.includes('data-role="canvas-import-search"'));
assert(html.includes('data-action="confirm-canvas-import"'));
assert(html.includes('data-role="dual-pane"'));
assert(html.includes('data-role="dual-shared-background"'));
assert(html.includes('data-role="dual-picker"'));
assert(html.includes('data-role="dual-search"'));
assert(html.includes('data-role="dual-files"'));
assert(html.includes('data-role="dual-scrollbar"'));
assert(html.includes('data-role="dual-scrollbar-thumb"'));
assert(html.includes('data-role="dual-shortcut-hint"'));
assert(html.includes('data-role="dual-copy-shortcut"'));
assert(html.includes('data-role="dual-paste-shortcut"'));
assert(html.includes('data-action="dual-open-picker"'));
assert(!html.includes('data-action="dual-copy-left-to-right"'));
assert(!html.includes('data-action="dual-copy-right-to-left"'));
assert(
  !html.includes('data-role="canvas-import-input"'),
  'the operating-system file picker must be removed from the editor',
);
assert(
  editor.includes('/api/canvas-import-library?current='),
  'the picker must load its choices from the managed canvas library API',
);
assert(editor.includes('const managedCanvasLibrarySession = (() => {'));
assert(editor.includes('const snapshots = new Map()'));
assert(editor.includes('const inFlight = new Map()'));
assert(editor.includes('const freshForMs = 2000'));
assert.strictEqual((editor.match(/\/api\/canvas-import-library\?current=/g) || []).length, 1);
assert(editor.includes("document.addEventListener('editor:canvasready'"));
assert(editor.includes('window.requestIdleCallback(warmLibrary'));
assert(editor.includes('managedCanvasLibrarySession.peek(filePath)'));
assert(editor.includes('managedCanvasLibrarySession.refresh(filePath)'));
assert(editor.includes("frame.src = 'dual-viewer.html?id='"));
assert(editor.includes('relatum:dual:ready'));
assert(editor.includes('relatum:dual:copy'));
assert(editor.includes('relatum:dual:paste-to-main'));
assert(editor.includes('RelatumDualClipboard'));
assert(editor.includes("surfaceMode: surfaceMode"));
assert(editor.includes('sharedBackground: true'));
assert(editor.includes("sharedBackground.style.setProperty('--dual-shared-background-fill'"));
assert(editor.includes('baseFill: pageStyle.backgroundColor'));
assert(editor.includes('readVars(immersiveBackgroundEl'));
assert(!editor.includes("document.querySelector('[data-role=\"immersive-background\"]')"));
assert(editor.includes("frame.addEventListener('load', () => sendAppearance(frame)"));
assert(editor.includes('function updateDualScrollbar()'));
assert(editor.includes('new ResizeObserver(queueDualScrollbarUpdate)'));
assert(editor.includes("macPlatform ? '⌘C' : 'Ctrl+C'"));
const showDualPickerRule = /async function showDualPicker\(\)\s*\{([\s\S]*?)\n\s*function hideDualPicker/.exec(editor);
assert(showDualPickerRule && !showDualPickerRule[1].includes("toolbarCopy('canvasLibraryLoading')"));
assert(showDualPickerRule && showDualPickerRule[1].includes("filesList.setAttribute('aria-busy', 'true')"));
assert(showDualPickerRule && showDualPickerRule[1].includes('reuseExisting: true'));
assert(showDualPickerRule && !showDualPickerRule[1].includes('await loadDualLibrary()'));
assert(editor.includes('window.EditorShell.saveNow = save'));
assert(!editor.includes('relatum:dual:request'));
assert(!editor.includes('relatum:dual:hotkey'));
assert(!editor.includes("action === 'saveNow'"));
assert(!editor.includes('Ctrl+Shift+D'));
assert(editor.includes('window.CanvasModule.importDualSelectionPayload'));
assert(editor.includes('window.CanvasModule.importManagedCanvas(importSelectedId)'));
assert(editor.includes("json.currentGroupId === '__inbox__'"));
assert(editor.includes("importView = 'group:' + json.currentGroupId"));
assert(editor.includes("event.key === 'Enter'"));
assert(canvas.includes("assetPolicy: 'include'"), 'managed import must retain asset nodes');
assert(canvas.includes('/api/canvas-import-source?id='));
assert(canvas.includes("canvasImportRequest('/api/canvas-import-assets'"));
assert(canvas.includes('revision: source.revision'));
assert(canvas.includes('global.CanvasModule.importManagedCanvas = importManagedCanvas'));
assert(canvas.includes('function getDualSelectionPayload()'));
assert(canvas.includes('function importDualSelectionPayload(options)'));
assert(/pickedIds\.has\(edge\.from\)[\s\S]*?pickedIds\.has\(edge\.to\)/.test(canvas));
assert(canvas.includes('global.CanvasModule.getDualSelectionPayload = getDualSelectionPayload'));
assert(canvas.includes('global.CanvasModule.importDualSelectionPayload = importDualSelectionPayload'));
assert(canvas.includes('const referenceOnlyCanvas = !!opts.referenceOnly'));
assert(canvas.includes('function preferredDualPastePoint()'));
assert(canvas.includes('const readOnlyCanvas = !!opts.readonly'));
assert(canvas.includes('if (readOnlyCanvas) return;'));
assert(canvas.includes('const viewportSizeObserver = (typeof ResizeObserver'));
assert(canvas.includes('viewportSizeObserver.observe(viewport)'));
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
assert(app.includes('"/api/canvas-dual-open"'));
assert(app.includes('def canvas_import_library_payload('));
assert(app.includes('def canvas_dual_open_payload('));
assert(app.includes('def copy_canvas_import_assets('));
assert(app.includes('"data": payload'));
assert(app.includes('def _api_import_canvas('), 'the start-page external import-as-new flow must remain');
assert(styles.includes('.canvas-viewport.file-drag-over::after'));
const dropRule = /\.canvas-viewport\.file-drag-over::after\s*\{([\s\S]*?)\}/.exec(styles);
assert(dropRule && !/backdrop-filter/.test(dropRule[1]), 'the file drop affordance must not use sustained blur');
const pickerRule = /\.canvas-import-library-card\s*\{([\s\S]*?)\}/.exec(styles);
assert(pickerRule && !/backdrop-filter/.test(pickerRule[1]), 'the library card must use an opaque paper surface');
const dualRule = /\.canvas-dual-pane\s*\{([\s\S]*?)\}/.exec(styles);
assert(dualRule && !/backdrop-filter/.test(dualRule[1]), 'the dual pane must use an opaque surface');
assert(styles.includes('body.dual-screen-open .canvas-viewport'));
assert(styles.includes('.canvas-dual-shared-background'));
assert(styles.includes('.canvas-dual-frame-wrap::before'));
assert(styles.includes('.dual-reference-page.shared-dual-background'));
assert(styles.includes('body.dual-screen-resizing .canvas-dual-frame'));
assert(styles.includes('.canvas-dual-picker-layer.tool-layer-entering'));
assert(styles.includes('.canvas-dual-picker-layer.content-entering'));
assert(styles.includes('.canvas-dual-file.is-entering'));
assert(/\.canvas-dual-file\.is-entering\s*\{[\s\S]*?animation:\s*canvas-dual-file-enter 300ms/.test(styles));
assert(styles.includes('.canvas-dual-scrollbar-thumb'));
assert(styles.includes('scrollbar-width: none'));
assert(styles.includes('@media (forced-colors: active)'));
assert(styles.includes('@media (prefers-reduced-motion: reduce)'));
const dualPickerCardRule = /\.canvas-dual-picker-card\s*\{([\s\S]*?)\}/.exec(styles);
assert(dualPickerCardRule && /height:\s*min\(560px,\s*calc\(100vh - 86px\)\)/.test(dualPickerCardRule[1]));
assert(i18n.includes("'工具 → 导入画布': 'Tools → Import Canvas'"));
assert(viewerHtml.includes('<script src="canvas.js" defer></script>'));
assert(viewerHtml.includes('<script src="dual-viewer.js" defer></script>'));
assert(!viewerHtml.includes('<script src="editor.js"'));
assert(!viewerHtml.includes('<script src="ai.js"'));
assert(!viewerHtml.includes('<script src="graph-view.js"'));
assert(!viewerHtml.includes('<script src="ruler.js"'));
assert(!viewerHtml.includes('<script src="canvas-timer.js"'));
assert(!viewerHtml.includes('<script src="canvas-taskbook.js"'));
assert(viewer.includes('/api/canvas-dual-open?id='));
assert(viewer.includes('lastAppearance = detail'));
assert(viewer.includes("document.body.classList.toggle('shared-dual-background'"));
assert(viewer.includes("viewport.classList.toggle('flowing-background'"));
assert(viewer.includes("viewport.classList.toggle('image-background'"));
assert(viewer.includes('referenceOnly: true'));
assert(viewer.includes('readonly: true'));
assert(viewer.includes("document.addEventListener('copy', copySelection)"));
assert(!viewer.includes('selectedCopyMessage'));
assert(!viewer.includes('已复制 '));
assert(canvas.includes('readOnly: readOnlyCanvas'));

console.log('canvas import interaction contract passed');

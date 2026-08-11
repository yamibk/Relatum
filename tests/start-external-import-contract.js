'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/index.html');
const start = read('assets/start.js');
const i18n = read('assets/i18n.js');
const app = read('app.py');

assert(html.includes('data-action="import-canvas-file">导入画布</button>'));
assert(html.includes('data-action="import-canvas-folder">导入文件夹</button>'));
assert(html.includes('data-action="import-canvas-file">\n          导入已有画布'));
assert(html.includes('data-action="import-canvas-folder">\n          导入画布文件夹'));
assert(!html.includes('data-action="open"'), 'the start page must not expose temporary external open');

assert(start.includes("fetch('/api/import-canvas-file'"));
assert(start.includes("fetch('/api/import-canvas-folder'"));
assert(!start.includes("fetch('/api/pick'"), 'the start page must no longer call the legacy picker');
assert(start.includes('gotoEditor(json.path);'), 'a single imported copy must open immediately');
assert(start.includes('const flashImportPaths = new Set()'));
assert(start.includes("if (activeGroup === FAVORITES_PAGE)"));
assert(start.includes('json.missingAssetCount > 0'));
assert(start.includes('同名 .assets 文件夹'));

assert(app.includes('"/api/import-canvas-file"'));
assert(app.includes('"/api/import-canvas-folder"'));
assert(app.includes('def _api_import_canvas_file('));
assert(app.includes('def _api_import_canvas_folder('));
assert(app.includes('def import_external_canvas_copies('));
assert(app.includes('def _scan_external_canvas_folder('));
assert(app.includes('if entry.name == "回收站"'));
assert(app.includes('folder_signature=signature'));

assert(i18n.includes("'导入画布': 'Import canvas'"));
assert(i18n.includes("'导入文件夹': 'Import folder'"));
assert(i18n.includes("'导入画布文件夹': 'Import canvas folder'"));

console.log('start external canvas import contract passed');

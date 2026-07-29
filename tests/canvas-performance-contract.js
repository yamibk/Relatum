'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');

assert(
  /new IntersectionObserver\([\s\S]*?\{\s*root:\s*viewport,\s*rootMargin:\s*'150% 125%'\s*\}/.test(canvas),
  'attachments must use the outer canvas viewport with the agreed preload margin',
);
assert(
  /const ATTACH_DEACTIVATE_MS\s*=\s*8000/.test(canvas)
    && /setTimeout\(function \(\) \{[\s\S]*?deactivateAttachment\(id\)[\s\S]*?\}, ATTACH_DEACTIVATE_MS\)/.test(canvas),
  'far attachments must use the delayed eight-second release path',
);
assert(
  /const ATTACH_ACTIVATE_DELAY_MS\s*=\s*120/.test(canvas)
    && /function scheduleAttachmentActivate\(id\)/.test(canvas),
  'viewport activation must ignore attachments crossed only briefly during a long camera glide',
);
assert(
  /runtime\.generation\s*\+=\s*1/.test(canvas)
    && /runtime\.src === src[\s\S]*?runtime\.generation === generation/.test(canvas),
  'attachment async commits must be guarded by URL and generation',
);
assert(
  /const markdownInflight = new Map\(\)/.test(canvas)
    && /markdownInflight\.set\(src, pending\)/.test(canvas)
    && /markdownInflight\.delete\(src\)/.test(canvas),
  'Markdown requests may share only their in-flight promise',
);
assert(
  /function deactivateAttachment\(id\)[\s\S]*?flushMdAnnotSave\(id\)[\s\S]*?releaseAttachmentBody/.test(canvas),
  'Markdown annotations must flush before the heavy body is released',
);
assert(
  /const imageRuntime = new Map\(\)/.test(canvas)
    && /function renderCanvasImage\(content, el, node\)/.test(canvas)
    && /renderCanvasImage\(content, el, node\)/.test(canvas),
  'canvas images must use their own viewport-managed runtime',
);
assert(
  /const imageObserver = [\s\S]*?root:\s*viewport,\s*rootMargin:\s*'150% 125%'/.test(canvas)
    && /function scheduleCanvasImageActivate\(id\)/.test(canvas)
    && /function scheduleCanvasImageDeactivate\(id\)/.test(canvas),
  'canvas images must use delayed activation and release at the outer viewport boundary',
);
assert(
  /function detachCanvasImage\(runtime\)[\s\S]*?removeAttribute\('src'\)[\s\S]*?img\.remove\(\)/.test(canvas)
    && /runtime\.generation === generation[\s\S]*?decorationAssetUrl\(currentNode\) === runtime\.src/.test(canvas),
  'far images must release their decoded element and ignore stale async load callbacks',
);
assert(
  /function syncSelectedAttachmentLifecycle\(\)[\s\S]*?imageRuntime\.forEach[\s\S]*?activateCanvasImage/.test(canvas)
    && /if \(isImageNode\(n\)\) activateCanvasImage\(id\)/.test(canvas),
  'selected or explicitly located images must activate immediately',
);
assert(
  /materializeExportImages\(clone\)/.test(canvas)
    && /img\.dataset\.exportSrc = decorationAssetUrl\(node\)/.test(canvas)
    && /const workerCount = Math\.min\(4, imgs\.length\)/.test(canvas)
    && /classList\.remove\('selected', 'is-selected', 'editing', 'dragging', 'culled'\)/.test(canvas),
  'PNG export must materialize virtualized images without restoring culled state or unbounded fetch concurrency',
);
assert(
  /const EDGE_GRID_SIZE\s*=\s*512/.test(canvas)
    && /function queryEdgeGeometry\(bounds\)/.test(canvas)
    && /const visibleItems = queryEdgeGeometry/.test(canvas),
  'static edge rendering must query the 512-unit spatial grid',
);
assert(
  /const edgePathCache = new Map\(\);[\s\S]*?path, geom, midpoint, points, bounds/.test(canvas)
    || /id → \{ edge, d, path, geom, midpoint, points, bounds, order \}/.test(canvas),
  'the edge cache contract must retain complete geometry, not only Path2D',
);
assert(
  /const refs = \{ path: path, hit: hit, labelEl: null/.test(canvas)
    && /if \(edge\.text\) ensureEdgeLabel\(edge, refs\)/.test(canvas)
    && /if \(!newText\) removeEmptyEdgeLabel\(edge, refs\)/.test(canvas),
  'empty edge labels must be created only for editing and removed when still empty',
);
assert(
  /get\('perf'\) === '1'/.test(canvas)
    && /global\.__relatumPerfSnapshot = function/.test(canvas)
    && /id = 'relatum-perf-snapshot'/.test(canvas)
    && /images:\s*\{[\s\S]*?registered:\s*imageRuntime\.size/.test(canvas),
  'performance snapshots must stay behind the explicit perf=1 query',
);

console.log('canvas performance contract: ok');

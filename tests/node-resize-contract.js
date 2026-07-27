'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');

const cssMinMatch = /\.node\s*\{[\s\S]*?min-width:\s*calc\((\d+)px\s*\*\s*var\(--node-scale,\s*1\)\)/.exec(css);
const dragMinMatch = /const\s+BODY_MIN_W\s*=\s*(\d+)\s*;/.exec(canvas);

assert(cssMinMatch, 'base node minimum width must remain discoverable');
assert(dragMinMatch, 'drag minimum width must remain discoverable');
assert.strictEqual(
  Number(dragMinMatch[1]),
  Number(cssMinMatch[1]),
  'horizontal resize must be able to return to the same minimum width as a fresh node',
);
assert(
  /function\s+bodyMinWidth\(node\)[\s\S]*?return\s+isMindmapWidthNode\(node\)\s*\?\s*72\s*:\s*BODY_MIN_W\s*;/.test(canvas),
  'ordinary body nodes must use the shared drag minimum',
);
assert(
  /function\s+bodyDragMinWidth\(node,\s*el\)[\s\S]*?removeProperty\('width'\)[\s\S]*?const\s+compactWidth\s*=\s*el\.offsetWidth[\s\S]*?Math\.min\(BODY_COMPACT_MIN_CAP,\s*Math\.round\(compactWidth\)\)/.test(canvas),
  'short nodes must recover their natural compact width without mutating saved data',
);
assert(
  /minW:\s*minW/.test(canvas)
    && /nextW\s*=\s*Math\.max\(drag\.minW,\s*Math\.min\(BODY_MAX_W,\s*Math\.round\(nextW\)\)\)/.test(canvas),
  'horizontal resize must clamp through the per-gesture compact minimum',
);

console.log('node resize contract: ok');

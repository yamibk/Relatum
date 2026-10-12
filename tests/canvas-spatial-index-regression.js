'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../assets/canvas.js'), 'utf8');

function functionSource(text, name) {
  const start = text.indexOf('    function ' + name + '(');
  assert(start >= 0, name);
  const open = text.indexOf('{', start);
  let depth = 0, quote = '';
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw Error(name + ' boundary');
}

function fixture(text = source) {
  let gridReads = 0;
  class CountMap extends Map {
    get(key) { gridReads++; return super.get(key); }
  }
  const context = { EDGE_GRID_SIZE: 512, EDGE_GRID_MAX_CELLS: 256,
    edgeSpatialGrid: new CountMap(), edgeSpatialCells: new Map(),
    edgeSpatialOverflow: new Set(), edgePathCache: new Map(), ensureEdgeGeometryCache() {} };
  vm.createContext(context);
  for (const name of ['edgeGridKeys', 'removeEdgeFromSpatialIndex', 'indexEdgeGeometry', 'queryEdgeGeometry']) {
    vm.runInContext(functionSource(text, name), context);
  }
  function add(id, bounds, order) {
    const item = { edge: { id }, bounds, order };
    context.edgePathCache.set(id, item); context.indexEdgeGeometry(item);
    return item;
  }
  function brute(bounds) {
    return Array.from(context.edgePathCache.values()).filter(item => {
      const b = item.bounds;
      return !(b.maxX < bounds.minX || b.minX > bounds.maxX || b.maxY < bounds.minY || b.minY > bounds.maxY);
    }).sort((a, b) => a.order - b.order).map(item => item.edge.id);
  }
  function query(bounds) { return Array.from(context.queryEdgeGeometry(bounds), item => item.edge.id); }
  function counts() {
    return { buckets: context.edgeSpatialGrid.size,
      refs: Array.from(context.edgeSpatialGrid.values()).reduce((sum, bucket) => sum + bucket.size, 0),
      overflow: context.edgeSpatialOverflow.size, gridReads };
  }
  return { context, add, query, brute, counts, resetReads() { gridReads = 0; } };
}

const f = fixture();
let seed = 7;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < 1800; i++) {
  const x = (random() - .5) * 80000, y = (random() - .5) * 80000;
  f.add(String(i), { minX: x, minY: y, maxX: x + random() * 1500, maxY: y + random() * 1500 }, 1800 - i);
}
f.add('long', { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }, 1801);
f.add('overlap', { minX: -512, minY: -512, maxX: 512, maxY: 512 }, 1802);
assert.equal(f.counts().overflow, 1, 'a huge edge retains one overflow identity');
assert(!f.context.edgeSpatialCells.has('long'), 'a huge edge allocates no per-cell keys');
assert(f.counts().refs <= 1801 * 256, 'index memory has a finite per-edge bound');
for (let i = 0; i < 900; i++) {
  const x = (random() - .5) * 100000, y = (random() - .5) * 100000;
  const extent = [0, 11, 512, 1500, 80000, 2e9][i % 6];
  const bounds = { minX: x, minY: y, maxX: x + extent, maxY: y + extent };
  assert.deepEqual(f.query(bounds), f.brute(bounds), 'grid and fallback must preserve bounds and stacking order');
}
const boundary = { minX: -512, minY: -512, maxX: -512, maxY: -512 };
assert.deepEqual(f.query(boundary), f.brute(boundary), 'negative cell boundaries are inclusive');
f.add('long', { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1801);
assert.equal(f.counts().overflow, 0, 'geometry changes must remove the old overflow identity');
f.add('overlap', { minX: -1e9, minY: 0, maxX: 1e9, maxY: 10 }, 1802);
assert(!Array.from(f.context.edgeSpatialGrid.values()).some(bucket => bucket.has('overlap')), 'grid-to-overflow removes old cell memberships');
f.context.removeEdgeFromSpatialIndex('overlap'); f.context.edgePathCache.delete('overlap');
assert.equal(f.counts().overflow, 0, 'deletion must release overflow identities');
f.resetReads();
const distant = { minX: 1e12, minY: 1e12, maxX: 1e12 + 1e8, maxY: 1e12 + 1e8 };
assert.deepEqual(f.query(distant), []);
assert.equal(f.counts().gridReads, 0, 'huge empty queries must not walk empty cells');
assert.equal(f.context.edgeGridKeys({ minX: 0, minY: 0, maxX: Infinity, maxY: 1 }, 256), null);
assert.equal(f.context.edgeGridKeys({ minX: 20, minY: 0, maxX: -20, maxY: 1 }, 256), null);
console.log('canvas: bounded spatial index, huge/sparse queries, ordering, geometry changes and deletion passed');

if (process.argv.includes('--benchmark')) {
  const baselineRef = process.env.RELATUM_CANVAS_BASELINE_REF || 'HEAD';
  const baseline = execFileSync('git', ['show', baselineRef + ':assets/canvas.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  function measure(text) {
    const results = [];
    for (let run = 0; run < 5; run++) {
      const sample = fixture(text), start = performance.now();
      for (let i = 0; i < 16; i++) {
        sample.add('e' + i, { minX: i * 100, minY: i * 100, maxX: 65536 + i * 100, maxY: 65536 + i * 100 }, i);
      }
      const indexMs = performance.now() - start, counts = sample.counts();
      sample.resetReads();
      const queryStart = performance.now();
      for (let i = 0; i < 30; i++) {
        const bounds = { minX: -20000 + i * 20, minY: -20000, maxX: 90000 + i * 20, maxY: 90000 };
        assert.deepEqual(sample.query(bounds), sample.brute(bounds));
      }
      results.push({ indexMs, queryMs: performance.now() - queryStart, buckets: counts.buckets, refs: counts.refs,
        overflow: counts.overflow, queryGridReads: sample.counts().gridReads });
    }
    return results;
  }
  console.log(JSON.stringify({ baseline: measure(baseline), current: measure(source) }, null, 2));
}

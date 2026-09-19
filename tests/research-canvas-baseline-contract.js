'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/research.html');
const styles = read('assets/research/research.css');
const workspace = read('assets/research/research-workspace.js');
const editor = read('assets/research/research-editor.js');
const canvas = read('assets/research/research-canvas.js');
const modelSource = read('assets/research/research-model.js');

[
  'data-research-viewport',
  'data-research-edges',
  'data-research-surface',
  'data-research-active-edges',
  'data-research-selection-frame',
  'data-research-minimap',
].forEach((needle) => assert(html.includes(needle), 'missing Research canvas layer: ' + needle));
assert(!/<(?:h[1-6]|p|button|input|textarea)\b/i.test(html),
  'the in-memory baseline must not add visible copy or controls');

assert(workspace.includes("import('./research-editor.js')"),
  'the lifecycle shell must load the editor inside the iframe only');
assert(editor.includes("import { createResearchModel } from './research-model.js'")
  && editor.includes("import { createResearchCanvas } from './research-canvas.js'"),
  'the editor must keep the model and projection separated');

[
  'const EDGE_GRID_SIZE = 512',
  'const edgePathCache = new Map()',
  'const edgeSpatialGrid = new Map()',
  "gesture.type === 'node-drag'",
  "gesture.type === 'edge-create'",
  "gesture.type === 'box'",
  'function fitToContent()',
  'function redrawMinimap()',
  'model.undo()',
  'model.redo()',
  "event.code === 'Space'",
].forEach((needle) => assert(canvas.includes(needle), 'missing Research canvas baseline: ' + needle));
assert(styles.includes('.research-node') && styles.includes('.research-active-edges')
  && styles.includes('.research-minimap'), 'the Research styles must remain independently scoped');

const runtimeSources = [workspace, editor, canvas, modelSource].join('\n');
[
  'fetch(',
  'XMLHttpRequest',
  'localStorage',
  'sessionStorage',
  '/api/',
  'GraphGL',
  'WebGL',
  'CanvasModule',
].forEach((needle) => assert(!runtimeSources.includes(needle), 'forbidden M1 dependency: ' + needle));

async function verifyModel() {
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(modelSource, 'utf8').toString('base64');
  const { createResearchModel } = await import(moduleUrl);
  const model = createResearchModel({ nodes: [], edges: [] });
  const first = model.createNode({ id: 'a', x: 10, y: 20, text: 'A' });
  const second = model.createNode({ id: 'b', x: 220, y: 20, text: 'B' });
  assert(first && second && model.node('a') && model.node('b'), 'nodes must be indexed by id');
  const edge = model.createEdge('a', 'b', { id: 'ab' });
  assert(edge && edge.fromPort === 'out' && edge.toPort === 'in', 'edges must keep explicit ports');
  assert(model.incidentEdgeIds(new Set(['a'])).has('ab'), 'incident edges must use the adjacency index');
  const linked = model.createLinkedNode('b', { id: 'c', x: 430, y: 20, text: 'C' }, { id: 'bc' });
  assert(linked && model.edge('bc') && model.edge('bc').to === 'c', 'linked node creation must be one model transaction');

  const beforeMove = model.capture();
  model.moveNodes({ a: { x: 90, y: 110 } }, { live: true });
  model.commitFrom(beforeMove, { kind: 'node-move', alreadyEmitted: true });
  assert.strictEqual(model.node('a').x, 90, 'live movement must update the canonical model');
  assert(model.undo() && model.node('a').x === 10, 'undo must restore the previous model snapshot');
  assert(model.redo() && model.node('a').x === 90, 'redo must restore the moved model snapshot');

  model.remove(new Set(['a']), new Set());
  assert(!model.node('a') && !model.edge('ab'), 'removing a node must remove incident edges');
  assert(model.undo() && model.node('a') && model.edge('ab'), 'removal must be undoable');
}

verifyModel()
  .then(() => console.log('research canvas baseline contract passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

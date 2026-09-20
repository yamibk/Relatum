'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/research.html');
const styles = read('assets/research/research.css');
const workspace = read('assets/research/research-workspace.js');
const editor = read('assets/research/research-editor.js');
const canvas = read('assets/research/research-canvas.js');
const modelSource = read('assets/research/research-model.js');
const pagesSource = read('assets/research/research-pages.js');
const schemaSource = read('assets/research/research-schema.js');
const computeSource = read('assets/research/research-compute.js');
const runtimeSource = read('assets/research/research-runtime.js');
const registrySource = read('assets/research/research-registry.js');
const persistenceSource = read('assets/research/research-persistence.js');

[
  'data-research-viewport', 'data-research-edges', 'data-research-surface', 'data-research-active-edges',
  'data-research-selection-frame', 'data-research-minimap', 'data-research-page-rail', 'data-research-page-hotspot',
  'data-research-trace', 'data-research-trace-list', 'data-research-trace-clear',
  'data-research-page-list', 'data-research-page-add', 'data-research-page-delete',
  'data-research-compute-dock', 'data-research-add-palette', 'data-research-add-search',
  'data-research-inspector', 'data-research-run', 'data-research-pause', 'data-research-step',
  'data-research-reset', 'data-research-speed', 'data-research-help-open', 'data-research-help-overlay',
  'data-research-persistence-status',
].forEach((needle) => assert(html.includes(needle), 'missing Research V2 shell element: ' + needle));
assert(html.includes('持续值') && html.includes('事件 Pulse') && html.includes('两种连线')
  && html.includes('组合逻辑始终自动更新'), 'help must describe V2 values, pulses, wiring, and simulation');
assert(!html.includes('data-research-creation-tool="countdown"') && !html.includes('data-research-creation-tool="countup"')
  && !html.includes('data-research-creation-tool="delay"'), 'legacy timer and Delay tools must be removed');

assert(workspace.includes("import('./research-editor.js')") && workspace.includes('runtime = await module.createResearchEditor(stage)'));
[
  "import { createResearchModel } from './research-model.js'",
  "import { createResearchPageSession } from './research-pages.js'",
  "import { loadResearchRegistry } from './research-registry.js'",
  'createResearchComputeRuntime', 'updateResearchComputeRuntime', 'createResearchSimulationController',
  "import { createResearchCanvas } from './research-canvas.js'",
  "import { loadResearchWorkspace, saveResearchWorkspace } from './research-persistence.js'",
  'snapshotPersistentResearchState',
].forEach((needle) => assert(editor.includes(needle), 'missing editor V2 integration: ' + needle));

[
  'const EDGE_GRID_SIZE = 512', 'const edgePathCache = new Map()', 'const edgeSpatialGrid = new Map()',
  "gesture.type === 'node-drag'", "gesture.type === 'edge-create'", "gesture.type === 'data-edge-create'",
  "gesture.type === 'box'", 'function fitToContent()', 'function redrawMinimap()', 'model.undo()', 'model.redo()',
  "event.code === 'Space'", 'function getViewState()', 'function setModel(nextModel, viewState = {})',
  'drawEdgesImmediately();', 'refreshEdgeCache(state.edgeIds);', 'const minimapNodeElements = new Map()',
  'const nodeLayoutCache = new Map()', 'new ResizeObserver(handleNodeResize)', 'function normalizeWireCandidate(start, target)',
  'function animateRemoval(nodeIds, edgeIds)', 'function setComputeProjection(nextProjection)',
  'function createTypedNode(type, worldPoint)', 'function setCreationTool(nextType)', 'function getCreationTool()',
  'function setInteractionMode(nextMode)', 'createNodeOfType: createTypedNode',
].forEach((needle) => assert(canvas.includes(needle), 'missing Research canvas behavior: ' + needle));
assert(!canvas.includes('if (event.altKey') && !canvas.includes('Alt +'), 'hidden Alt-drag relation creation must be gone');
assert(styles.includes('.research-node') && styles.includes('.research-active-edges')
  && styles.includes('.research-minimap') && styles.includes('.research-add-palette')
  && styles.includes('.research-inspector') && styles.includes('.research-port.is-compatible')
  && styles.includes('.research-active-edges line.is-invalid'),
  'V2 surfaces and compatibility highlighting must remain independently scoped');

[
  'function scheduleCompute(pageId = renderedPageId)', 'page.runtime.topologyDirty = true',
  'page.runtime.dirtyNodeIds.add(String(id))', 'simulation.setVisible(!document.hidden)',
  'simulation.activate()', 'simulation.suspend()', 'simulation.dispose()',
  'session.toDocument((record) =>', 'flushSave({ force: true, keepalive: true })',
].forEach((needle) => assert(editor.includes(needle), 'missing V2 editor lifecycle: ' + needle));
assert(persistenceSource.includes("const WORKSPACE_ENDPOINT = '/api/research/workspace'")
  && persistenceSource.includes('keepalive: options.keepalive === true'));

const computeCoreSources = [schemaSource, computeSource, runtimeSource].join('\n');
['document.', 'window.', 'fetch(', 'localStorage', 'sessionStorage', '/api/', 'eval(', 'new Function']
  .forEach((needle) => assert(!computeCoreSources.includes(needle), 'forbidden compute-core dependency: ' + needle));
const modelCore = [modelSource, pagesSource, schemaSource, computeSource].join('\n');
['fetch(', 'localStorage', 'sessionStorage', '/api/']
  .forEach((needle) => assert(!modelCore.includes(needle), 'persistent core must stay transport-independent: ' + needle));
assert(registrySource.includes("fetch(new URL('./research-node-definitions.json', import.meta.url))"),
  'the frontend registry must load the shared declarative definition file');

async function verifyModel() {
  const definitions = JSON.parse(read('assets/research/research-node-definitions.json'));
  const [{ createResearchRegistry }, { createResearchModel }, { researchRectBoundaryPoint }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'assets/research/research-registry.js')).href),
    import(pathToFileURL(path.join(root, 'assets/research/research-model.js')).href),
    import(pathToFileURL(path.join(root, 'assets/research/research-canvas.js')).href),
  ]);
  assert.deepStrictEqual(researchRectBoundaryPoint(
    { left: 10, top: 20, right: 110, bottom: 80 }, { x: 210, y: 50 },
  ), { x: 110, y: 50 }, 'horizontal relations must stop at the node border');
  assert.deepStrictEqual(researchRectBoundaryPoint(
    { left: 10, top: 20, right: 110, bottom: 80 }, { x: 60, y: 140 },
  ), { x: 60, y: 80 }, 'vertical relations must stop at the node border');
  const diagonal = researchRectBoundaryPoint(
    { left: 10, top: 20, right: 110, bottom: 80 }, { x: 160, y: 110 },
  );
  assert.strictEqual(diagonal.x, 110);
  assert.strictEqual(diagonal.y, 80);
  const registry = createResearchRegistry(definitions);
  const model = createResearchModel({ nodes: [], edges: [] }, registry);
  const make = (id, type, x) => ({ id, x, y: 20, width: 176, height: 72, ...registry.createNode(type) });
  const constant = model.createNode({ ...make('constant', 'constant', 10), config: { value: { type: 'number', value: 1 } } });
  const alternate = model.createNode({ ...make('alternate', 'constant', 120), config: { value: { type: 'number', value: 2 } } });
  const math = model.createNode(make('math', 'math', 220));
  const button = model.createNode(make('button', 'button', 430));
  assert(constant && math && button && model.node('math'));
  const firstWire = model.createEdge('constant', 'math', {
    id: 'wire-a', kind: 'wire', fromPortId: 'out', toPortId: 'a',
  });
  assert(firstWire && firstWire.kind === 'wire');
  assert(!model.createEdge('button', 'math', {
    id: 'wrong-channel', kind: 'wire', fromPortId: 'fire', toPortId: 'b',
  }), 'event-to-value wires must be rejected before history');
  assert(!model.createEdge('constant', 'math', {
    id: 'occupied', kind: 'wire', fromPortId: 'out', toPortId: 'a',
  }), 'occupied value input must reject a second wire');
  const reconnected = model.reconnectWire('wire-a', 'alternate', 'out', 'math', 'a');
  assert(reconnected && reconnected.id === 'wire-a' && reconnected.from.nodeId === 'alternate',
    'reconnecting a value input must preserve the edge identity');
  assert(model.undo() && model.edge('wire-a').from.nodeId === 'constant',
    'one undo must restore the original wire source');
  assert(model.redo() && model.edge('wire-a').from.nodeId === 'alternate',
    'one redo must restore the replacement source');
  const beforeInvalidReconnect = model.capture();
  const beforeInvalidHistory = model.historyIndex;
  assert(!model.reconnectWire('wire-a', 'button', 'fire', 'math', 'a'),
    'invalid reconnections must be rejected');
  assert.deepStrictEqual(model.capture(), beforeInvalidReconnect,
    'invalid reconnections must not mutate the model');
  assert.strictEqual(model.historyIndex, beforeInvalidHistory,
    'invalid reconnections must not enter history');
  assert(model.reconnectWire('wire-a', 'constant', 'out', 'math', 'a'));
  const relation = model.createEdge('constant', 'button', { id: 'relation', kind: 'relation' });
  assert(relation && relation.kind === 'relation');
  const beforeMove = model.capture();
  model.moveNodes({ constant: { x: 90, y: 110 } }, { live: true });
  model.commitFrom(beforeMove, { kind: 'node-move', alreadyEmitted: true });
  assert.strictEqual(model.node('constant').x, 90);
  assert(model.undo() && model.node('constant').x === 10);
  assert(model.redo() && model.node('constant').x === 90);
  model.remove(new Set(['constant']), new Set());
  assert(!model.node('constant') && !model.edge('wire-a') && !model.edge('relation'));
  assert(model.undo() && model.node('constant') && model.edge('wire-a'));
}

verifyModel().then(() => console.log('research canvas baseline contract passed')).catch((error) => {
  console.error(error); process.exitCode = 1;
});

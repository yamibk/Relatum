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
  'data-research-compute-dock', 'data-research-dock-collapse', 'data-research-side-panel',
  'data-research-zoom-indicator', 'data-research-settings-open', 'data-research-settings-panel',
  'data-research-pan-speed', 'data-research-pan-inertia', 'data-research-zoom-speed',
  'data-research-node-library', 'data-research-add-search',
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
  "gesture.type === 'box'", 'function fitToContent()', 'function redrawMinimap(', 'model.undo()', 'model.redo()',
  "event.code === 'Space'", 'function getViewState()', 'function setModel(nextModel, viewState = {})',
  'drawEdgesImmediately();', 'refreshEdgeCache(state.edgeIds);', 'const minimapNodeElements = new Map()',
  'const nodeLayoutCache = new Map()', 'new ResizeObserver(handleNodeResize)', 'function normalizeWireCandidate(start, target)',
  'function animateRemoval(nodeIds, edgeIds)', 'function setComputeProjection(nextProjection, options = {})',
  'const PROJECTION_NODES_PER_FRAME = 128', 'function renderProjectionSlice()',
  'function createTypedNode(type, worldPoint)', 'function setCreationTool(nextCreation)', 'function getCreationTool()',
  'function setConnectionKind(nextKind)', 'function getConnectionKind()', 'createNodeOfType: createTypedNode',
  'let targetCamera = { ...camera }', 'function tickCamera(timestamp)', 'function startPanInertia(state)',
  'function updateMinimapViewport()', 'const minimapNodeElements = new Map()',
  "localStorage.getItem('research:panSpeed:v1')", "localStorage.getItem('research:panInertia:v1')",
  "localStorage.getItem('research:zoomSpeed:v1')", 'resetInteractionPreferences',
].forEach((needle) => assert(canvas.includes(needle), 'missing Research canvas behavior: ' + needle));
assert(canvas.includes("event.altKey && connectionKind === 'wire'")
  && canvas.includes("event.altKey && connectionKind === 'relation'")
  && canvas.includes('stableBlankDoubleClick(event)'),
  'Alt-drag must use the selected connection kind and blank double-clicks must be stable');
assert(!canvas.includes("event.key === 'Tab' && !event.altKey"), 'bare Tab must no longer create a relation child');
assert(styles.includes('.research-node') && styles.includes('.research-active-edges')
  && styles.includes('.research-minimap') && styles.includes('.research-side-panel')
  && styles.includes('.research-viewport-hud') && styles.includes('.research-settings-panel')
  && styles.includes('.research-compute-dock.is-collapsed')
  && styles.includes('height: min(615px, calc(100% - 88px))')
  && styles.includes('.research-side-panel-content-ghost')
  && styles.includes('@keyframes research-panel-content-out')
  && styles.includes('.research-node { border-color: rgba(242, 242, 242, .68); }')
  && styles.includes('.research-inspector') && styles.includes('.research-port.is-compatible')
  && styles.includes('.research-active-edges line.is-invalid'),
  'V2 surfaces and compatibility highlighting must remain independently scoped');

[
  'function scheduleCompute(pageId = renderedPageId)', 'page.runtime.topologyDirty = true',
  'page.runtime.dirtyNodeIds.add(String(id))', 'simulation.setVisible(!document.hidden)',
  'simulation.activate()', 'simulation.suspend()', 'simulation.dispose()',
  'session.toDocument((record) =>', 'flushSave({ force: true, keepalive: true })',
].forEach((needle) => assert(editor.includes(needle), 'missing V2 editor lifecycle: ' + needle));
[
  "const SIDE_PANEL_COLLAPSED_KEY = 'research:sidePanelCollapsed:v1'",
  "const COMPUTE_DOCK_COLLAPSED_KEY = 'research:computeDockCollapsed:v1'",
  "const CONNECTION_KIND_KEY = 'research:connectionKind:v1'",
  'function renderEdgeInspector(edge)', 'function renderSelectionSummary(selection)',
  'function guardPanelHitTesting()', 'function finishPanelContentTransition()',
  'function openSettingsPanel()', 'function closeSettingsPanel(options = {})',
  "'node:' + node.id", "'edge:' + edge.id", "event.key === 'Tab'",
].forEach((needle) => assert(editor.includes(needle), 'missing M5.1 interaction contract: ' + needle));
assert(editor.includes('deferred: !!meta.simulation && !meta.step && !meta.reset'),
  'continuous simulation projection rendering must be coalesced without delaying Step or Reset');
[
  "rail.addEventListener('wheel'", "rail.classList.add('is-flipping')",
  "element.classList.add('is-flip')", "ghost.classList.add('is-ghost')",
  "viewport.classList.add('is-page-switching')", 'function tickPageSwitchMotion(',
  'function previewRailTarget(', 'prefers-reduced-motion: reduce',
].forEach((needle) => assert(editor.includes(needle), 'missing Research page-rail interaction: ' + needle));
assert(styles.includes('.research-page-orb.no-transition')
  && styles.includes('.research-page-rail.is-flipping')
  && styles.includes('.research-page-button.is-ghost')
  && styles.includes('.research-viewport.is-page-switching'),
  'Research page-rail animation classes must remain independently scoped');
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

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const moduleUrl = (name) => pathToFileURL(path.join(root, name)).href;
const definitions = JSON.parse(fs.readFileSync(
  path.join(root, 'assets/research/research-node-definitions.json'), 'utf8',
));

function wire(id, fromNodeId, fromPortId, toNodeId, toPortId) {
  return {
    id, kind: 'wire',
    from: { nodeId: fromNodeId, portId: fromPortId },
    to: { nodeId: toNodeId, portId: toPortId },
  };
}

async function run() {
  const [{ createResearchRegistry }, { createResearchModel }] = await Promise.all([
    import(moduleUrl('assets/research/research-registry.js')),
    import(moduleUrl('assets/research/research-model.js')),
  ]);
  const registry = createResearchRegistry(definitions);
  const model = createResearchModel({
    nodes: [
      {
        id: 'source', type: 'constant', label: '输入 7', x: 10, y: 20, width: 176, height: 72,
        config: { value: { type: 'number', value: 7 } }, statePolicy: 'reset',
      },
      {
        id: 'counter', type: 'counter', label: '计数状态', x: 240, y: 40, width: 188, height: 96,
        config: { initial: { type: 'number', value: 2 }, overflow: 'saturate' },
        statePolicy: 'persist', savedState: { current: { type: 'number', value: 9 } },
      },
      {
        id: 'module', type: 'subcircuit', label: '固定模块', x: 480, y: 80, width: 192, height: 80,
        config: { definitionId: 'cpu-core', revision: 2 }, statePolicy: 'reset',
        savedState: { instances: { nested: { current: { type: 'bits', width: 4, value: '0x3' } } } },
      },
      {
        id: 'outside', type: 'monitor', label: '外部监视', x: 760, y: 20, width: 176, height: 72,
        config: {}, statePolicy: 'reset',
      },
    ],
    edges: [
      wire('internal-wire', 'source', 'out', 'counter', 'loadValue'),
      { id: 'internal-relation', kind: 'relation', fromNodeId: 'counter', toNodeId: 'module' },
      wire('crossing-wire', 'source', 'out', 'outside', 'in'),
    ],
  }, registry);

  const before = model.capture();
  const beforeHistory = model.historyIndex;
  const result = model.duplicateNodes(['source', 'counter', 'module', 'missing'], { dx: 50, dy: 70 });
  assert(result, 'a non-empty live node selection must duplicate');
  assert.equal(result.nodeIds.length, 3);
  assert.equal(result.edgeIds.length, 2, 'only edges whose endpoints are both selected must duplicate');
  assert.equal(model.historyIndex, beforeHistory + 1, 'duplication must create exactly one history entry');
  assert(result.nodeIds.every((id) => !['source', 'counter', 'module'].includes(id)), 'all node ids must be remapped');

  const copiedSource = model.node(result.idMap.source);
  const copiedCounter = model.node(result.idMap.counter);
  const copiedModule = model.node(result.idMap.module);
  assert.deepEqual(
    { x: copiedSource.x, y: copiedSource.y, label: copiedSource.label, config: copiedSource.config },
    { x: 60, y: 90, label: '输入 7', config: { value: { type: 'number', value: 7 } } },
  );
  assert.deepEqual(
    { x: copiedCounter.x, y: copiedCounter.y, width: copiedCounter.width, height: copiedCounter.height,
      config: copiedCounter.config, statePolicy: copiedCounter.statePolicy },
    { x: 290, y: 110, width: 188, height: 96,
      config: { initial: { type: 'number', value: 2 }, overflow: 'saturate' }, statePolicy: 'persist' },
  );
  assert.equal(Object.hasOwn(copiedCounter, 'savedState'), false, 'stateful copies must start without saved state');
  assert.deepEqual(copiedModule.config, { definitionId: 'cpu-core', revision: 2 },
    'subcircuit copies must stay pinned to the same immutable revision');
  assert.equal(Object.hasOwn(copiedModule, 'savedState'), false,
    'subcircuit copies must drop the complete recursive saved-state tree');

  const copiedIds = new Set(result.nodeIds);
  const copiedEdges = result.edgeIds.map((edgeId) => model.edge(edgeId));
  assert(copiedEdges.every((edge) => {
    const endpoints = edge.kind === 'wire'
      ? [edge.from.nodeId, edge.to.nodeId] : [edge.fromNodeId, edge.toNodeId];
    return endpoints.every((nodeId) => copiedIds.has(nodeId));
  }), 'duplicated edges must only connect duplicated nodes');
  assert.equal(model.edges().filter((edge) => edge.kind === 'wire'
    && edge.to.nodeId === 'outside').length, 1, 'cross-boundary wires must not duplicate');

  const after = model.capture();
  assert(model.undo(), 'one undo must remove the complete duplicate');
  assert.deepEqual(model.capture(), before);
  assert(model.redo(), 'one redo must restore the complete duplicate');
  assert.deepEqual(model.capture(), after);

  const stableHistory = model.historyIndex;
  assert.equal(model.duplicateNodes([], { dx: 1, dy: 1 }), null);
  assert.equal(model.duplicateNodes(['missing'], { dx: 1, dy: 1 }), null);
  assert.equal(model.historyIndex, stableHistory, 'empty or stale selections must not enter history');
  const fallback = model.duplicateNodes(['source']);
  assert.deepEqual(
    { x: model.node(fallback.idMap.source).x, y: model.node(fallback.idMap.source).y },
    { x: 38, y: 48 },
    'model duplication must use the 28px fallback offset when no placement delta is supplied',
  );
  assert(model.undo());
  console.log('research model regression passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

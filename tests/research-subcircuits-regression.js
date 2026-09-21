'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, name)).href);
const wire = (id, fromNodeId, fromPortId, toNodeId, toPortId) => ({
  id, kind: 'wire', from: { nodeId: fromNodeId, portId: fromPortId }, to: { nodeId: toNodeId, portId: toPortId },
});

async function main() {
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8'));
  const [{ createResearchRegistry }, { createResearchModel }, compute, subcircuits, schema] = await Promise.all([
    moduleAt('assets/research/research-registry.js'),
    moduleAt('assets/research/research-model.js'),
    moduleAt('assets/research/research-compute.js'),
    moduleAt('assets/research/research-subcircuits.js'),
    moduleAt('assets/research/research-schema.js'),
  ]);
  const registry = createResearchRegistry(definitions);
  const builtin = (id, type, config = {}, extra = {}) => ({
    id, x: 0, y: 0, width: 176, height: 72, ...registry.createNode(type, { config, ...extra }),
  });
  const instance = (id, definitionId, revision) => ({
    id, x: 0, y: 0, width: 192, height: 90,
    ...registry.createNode('subcircuit', { config: { definitionId, revision } }),
  });

  const catalog = subcircuits.createResearchSubcircuitCatalog([{
    id: 'adder', name: 'Adder', latestRevision: 2, revisions: [
      {
        revision: 1,
        ports: [
          { id: 'a', name: 'a', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'a' },
          { id: 'b', name: 'b', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'b' },
          { id: 'out', name: 'out', direction: 'output', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'out' },
        ],
        nodes: [builtin('op', 'math', { operation: 'add' })], edges: [],
      },
      {
        revision: 2,
        ports: [
          { id: 'a', name: 'a', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'a' },
          { id: 'b', name: 'b', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'b' },
          { id: 'out', name: 'out', direction: 'output', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'out' },
        ],
        nodes: [builtin('op', 'math', { operation: 'multiply' })], edges: [],
      },
    ],
  }, {
    id: 'wrapper', name: 'Wrapper', latestRevision: 1, revisions: [{
      revision: 1,
      ports: [
        { id: 'a', name: 'a', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'child', portId: 'a' },
        { id: 'b', name: 'b', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'child', portId: 'b' },
        { id: 'out', name: 'out', direction: 'output', channel: 'value', valueType: 'number', nodeId: 'child', portId: 'out' },
      ],
      nodes: [instance('child', 'adder', 1)], edges: [],
    }],
  }, {
    id: 'counter-module', name: 'Counter module', latestRevision: 1, revisions: [{
      revision: 1,
      ports: [
        { id: 'inc', name: 'inc', direction: 'input', channel: 'event', valueType: 'pulse', nodeId: 'counter', portId: 'inc' },
        { id: 'out', name: 'out', direction: 'output', channel: 'value', valueType: 'number', nodeId: 'counter', portId: 'out' },
      ],
      nodes: [builtin('counter', 'counter', { initial: { type: 'number', value: 0 }, overflow: 'wrap' }, { statePolicy: 'persist' })],
      edges: [],
    }],
  }]);
  registry.setSubcircuitCatalog(catalog);
  const schemaResult = schema.validateResearchDocument({
    researchVersion: 3, subcircuits: catalog.snapshot(),
    pages: [{ id: 'page', title: '', nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 } }],
    activePageId: 'page',
  }, registry);
  assert(schemaResult.ok, schemaResult.errors.map((error) => error.code + ':' + error.path).join(', '));
  const staleLatest = catalog.snapshot(); staleLatest[0].latestRevision = 1;
  const staleLatestResult = schema.validateResearchDocument({
    researchVersion: 3, subcircuits: staleLatest,
    pages: [{ id: 'page', title: '', nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 }, simulation: { speed: 1 } }],
    activePageId: 'page',
  }, registry);
  assert(staleLatestResult.errors.some((error) => error.code === 'invalid-latest-revision'));
  registry.setSubcircuitCatalog(catalog);

  const numbers = [
    builtin('two', 'constant', { value: { type: 'number', value: 2 } }),
    builtin('three', 'constant', { value: { type: 'number', value: 3 } }),
    instance('add-v1', 'adder', 1), instance('add-v2', 'adder', 2), instance('nested', 'wrapper', 1),
  ];
  const numericEdges = [];
  ['add-v1', 'add-v2', 'nested'].forEach((id) => {
    numericEdges.push(wire('two-' + id, 'two', 'out', id, 'a'), wire('three-' + id, 'three', 'out', id, 'b'));
  });
  const numericRuntime = compute.createResearchComputeRuntime({ nodes: numbers, edges: numericEdges }, { registry });
  assert.deepStrictEqual(numericRuntime.projection['add-v1'].outputs.out, { type: 'number', value: 5 });
  assert.deepStrictEqual(numericRuntime.projection['add-v2'].outputs.out, { type: 'number', value: 6 });
  assert.deepStrictEqual(numericRuntime.projection.nested.outputs.out, { type: 'number', value: 5 }, 'nested instances must resolve through pinned child revisions');

  const stateNodes = [builtin('button', 'button'), instance('left', 'counter-module', 1), instance('right', 'counter-module', 1)];
  const stateRuntime = compute.createResearchComputeRuntime({ nodes: stateNodes, edges: [wire('inc-left', 'button', 'fire', 'left', 'inc')] }, { registry });
  compute.activateResearchNode(stateRuntime, 'button');
  assert.strictEqual(stateRuntime.projection.left.outputs.out.value, 1);
  assert.strictEqual(stateRuntime.projection.right.outputs.out.value, 0, 'instances must not share internal state');
  const persisted = compute.snapshotPersistentResearchState(stateRuntime);
  assert.strictEqual(persisted.left.nodes.counter.current.value, 1);
  assert.strictEqual(persisted.right.nodes.counter.current.value, 0);
  const restoredNodes = stateNodes.map((node) => node.id === 'left' ? { ...node, savedState: persisted.left }
    : node.id === 'right' ? { ...node, savedState: persisted.right } : node);
  const restored = compute.createResearchComputeRuntime({ nodes: restoredNodes, edges: [wire('inc-left', 'button', 'fire', 'left', 'inc')] }, { registry });
  assert.strictEqual(restored.projection.left.outputs.out.value, 1, 'nested persistent state must restore per instance');

  const pageModel = createResearchModel({
    nodes: [
      builtin('one', 'constant', { value: { type: 'number', value: 1 } }),
      builtin('four', 'constant', { value: { type: 'number', value: 4 } }),
      builtin('sum', 'math', { operation: 'add' }), builtin('monitor', 'monitor'),
    ],
    edges: [wire('one-sum', 'one', 'out', 'sum', 'a'), wire('four-sum', 'four', 'out', 'sum', 'b'), wire('sum-monitor', 'sum', 'out', 'monitor', 'in')],
  }, registry);
  const built = subcircuits.buildSubcircuitRevisionFromSelection(pageModel, ['sum'], registry);
  assert.strictEqual(built.revision.ports.length, 3);
  const unresolvedModel = createResearchModel({
    nodes: [builtin('unknown-source', 'select'), builtin('unknown-target', 'monitor')],
    edges: [wire('unknown-wire', 'unknown-source', 'out', 'unknown-target', 'in')],
  }, registry);
  const unresolved = subcircuits.buildSubcircuitRevisionFromSelection(unresolvedModel, ['unknown-target'], registry, {
    ports: [{ id: 'old-number', name: 'unknown-target.in', direction: 'input', channel: 'value', valueType: 'number' }],
  });
  assert.strictEqual(unresolved.unresolvedPortIds.length, 1, 'unknown boundary values must require an explicit type choice');
  assert.notStrictEqual(unresolved.revision.ports[0].id, 'old-number', 'unresolved values must not guess an old stable port ID');
  const created = catalog.addDefinition('Selected sum', built.revision);
  const selectedDefinition = catalog.definition(created.id);
  const replacement = subcircuits.replaceSelectionWithSubcircuit(pageModel, ['sum'], selectedDefinition, selectedDefinition.revisions[0]);
  assert(replacement && pageModel.edges().every((edge) => ['one-sum', 'four-sum', 'sum-monitor'].includes(edge.id)), 'boundary wires must retain edge IDs');
  assert(pageModel.undo() && pageModel.node('sum'), 'encapsulation must be a single undoable page change');
  assert(catalog.definition(created.id), 'undo keeps the reusable definition');

  const upgradeModel = createResearchModel({
    nodes: [instance('upgrade-me', 'adder', 1), builtin('upgrade-monitor', 'monitor')],
    edges: [wire('upgrade-edge', 'upgrade-me', 'out', 'upgrade-monitor', 'in')],
  }, registry);
  assert(subcircuits.canUpgradeSubcircuitInstance(upgradeModel, upgradeModel.node('upgrade-me'), catalog.revision('adder', 2), registry).ok,
    'compatible stable ports must allow manual upgrade');
  const incompatible = catalog.addRevision('adder', {
    ports: [
      { id: 'a', name: 'a', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'a' },
      { id: 'b', name: 'b', direction: 'input', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'b' },
      { id: 'renamed-out', name: 'out', direction: 'output', channel: 'value', valueType: 'number', nodeId: 'op', portId: 'out' },
    ],
    nodes: [builtin('op', 'math', { operation: 'add' })], edges: [],
  });
  assert(!subcircuits.canUpgradeSubcircuitInstance(upgradeModel, upgradeModel.node('upgrade-me'), incompatible, registry).ok,
    'connected removed ports must block upgrade');
  const references = subcircuits.collectSubcircuitReferences([{ nodes: [upgradeModel.node('upgrade-me')] }], catalog);
  assert(!catalog.removeRevision('adder', 1, references), 'referenced revisions must not be deleted');
  assert(catalog.removeRevision('adder', incompatible.revision, references), 'unreferenced revisions may be deleted');

  const cyclic = subcircuits.createResearchSubcircuitCatalog([{
    id: 'a', name: 'A', latestRevision: 1, revisions: [{ revision: 1, ports: [], nodes: [instance('b-ref', 'b', 1)], edges: [] }],
  }, {
    id: 'b', name: 'B', latestRevision: 1, revisions: [{ revision: 1, ports: [], nodes: [instance('a-ref', 'a', 1)], edges: [] }],
  }]);
  assert(subcircuits.validateSubcircuitDependencies(cyclic).some((error) => error.code === 'subcircuit-cycle'));
}

main().then(() => console.log('research subcircuits regression passed')).catch((error) => {
  console.error(error); process.exitCode = 1;
});

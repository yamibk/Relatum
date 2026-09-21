'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const moduleUrl = (name) => pathToFileURL(path.join(root, name)).href;
const definitions = JSON.parse(fs.readFileSync(
  path.join(root, 'assets/research/research-node-definitions.json'), 'utf8',
));

async function verifyTutorial() {
  const [{ createResearchRegistry }, { createResearchModel }, content, examples] = await Promise.all([
    import(moduleUrl('assets/research/research-registry.js')),
    import(moduleUrl('assets/research/research-model.js')),
    import(moduleUrl('assets/research/research-tutorial-content.js')),
    import(moduleUrl('assets/research/research-tutorial-examples.js')),
  ]);
  const { RESEARCH_TUTORIAL_CHAPTERS, RESEARCH_TUTORIAL_PAGES } = content;
  const { RESEARCH_TUTORIAL_EXAMPLE_IDS, buildResearchTutorialExample } = examples;
  assert.strictEqual(RESEARCH_TUTORIAL_CHAPTERS.length, 4, 'tutorial must have four chapters');
  assert.strictEqual(RESEARCH_TUTORIAL_PAGES.length, 39, 'tutorial must have 39 pages');
  assert.deepStrictEqual(
    RESEARCH_TUTORIAL_CHAPTERS.map((chapter) => [
      chapter.id,
      RESEARCH_TUTORIAL_PAGES.filter((page) => page.chapter === chapter.id).length,
    ]),
    [['intro', 6], ['nodes', 20], ['cases', 8], ['advanced', 5]],
    'chapter page counts must stay at 6/20/8/5',
  );

  const nodeTypes = RESEARCH_TUTORIAL_PAGES.filter((page) => page.nodeType).map((page) => page.nodeType);
  assert.strictEqual(new Set(nodeTypes).size, 20, 'each node type needs exactly one tutorial page');
  assert.deepStrictEqual(
    [...nodeTypes].sort(), definitions.nodes.map((item) => item.type).sort(),
    'node tutorial pages must exactly match the shared registry',
  );
  const pageExampleIds = RESEARCH_TUTORIAL_PAGES.filter((page) => page.exampleId).map((page) => page.exampleId);
  assert.strictEqual(RESEARCH_TUTORIAL_EXAMPLE_IDS.length, 8, 'there must be eight example templates');
  assert.deepStrictEqual([...pageExampleIds].sort(), [...RESEARCH_TUTORIAL_EXAMPLE_IDS].sort(),
    'each template must have exactly one generation entry');

  const registry = createResearchRegistry(definitions);
  for (const exampleId of RESEARCH_TUTORIAL_EXAMPLE_IDS) {
    const template = buildResearchTutorialExample(exampleId);
    assert(template && template.nodes.length && template.edges.length, 'empty example: ' + exampleId);
    assert.strictEqual(new Set(template.nodes.map((node) => node.id)).size, template.nodes.length,
      'duplicate local node id: ' + exampleId);
    assert.strictEqual(new Set(template.edges.map((edge) => edge.id)).size, template.edges.length,
      'duplicate local edge id: ' + exampleId);
    const existing = registry.createNode('note', { label: '保留的节点' });
    const model = createResearchModel({
      nodes: [{ id: 'existing', x: 0, y: 0, width: 176, height: 72, ...existing }],
      edges: [],
    }, registry);
    const before = model.capture();
    const beforeHistory = model.historyIndex;
    const result = model.insertGraph(template, { kind: 'tutorial-example-insert', tutorialExampleId: exampleId });
    assert(result, 'template must pass real registry and port validation: ' + exampleId);
    assert.strictEqual(model.historyIndex, beforeHistory + 1, 'example must create one history entry: ' + exampleId);
    assert.strictEqual(model.nodes().length, before.nodes.length + template.nodes.length);
    assert.strictEqual(model.edges().length, template.edges.length);
    assert(result.nodeIds.every((id) => id !== 'existing' && !template.nodes.some((node) => node.id === id)),
      'inserted node ids must be remapped: ' + exampleId);
    assert(model.node('existing'), 'existing page content must survive insertion');
    assert(model.undo(), 'one undo must remove the whole example: ' + exampleId);
    assert.deepStrictEqual(model.capture(), before, 'undo must restore the exact prior page: ' + exampleId);
    assert(model.redo(), 'one redo must restore the whole example: ' + exampleId);
    assert.strictEqual(model.nodes().length, before.nodes.length + template.nodes.length);
    assert.strictEqual(model.edges().length, template.edges.length);
  }

  const model = createResearchModel({ nodes: [], edges: [] }, registry);
  const before = model.capture();
  const beforeHistory = model.historyIndex;
  assert.strictEqual(model.insertGraph({
    nodes: [{ id: 'bad', type: 'missing-node-type', x: 0, y: 0 }], edges: [],
  }), null, 'unknown node types must reject the whole batch');
  assert.strictEqual(model.insertGraph({
    nodes: [
      { id: 'source', type: 'constant', x: 0, y: 0 },
      { id: 'target', type: 'monitor', x: 200, y: 0 },
    ],
    edges: [{ id: 'bad-wire', kind: 'wire', from: { nodeId: 'source', portId: 'missing' }, to: { nodeId: 'target', portId: 'in' } }],
  }), null, 'unknown ports must reject the whole batch');
  assert.strictEqual(model.insertGraph({
    nodes: [{ id: 'a', type: 'note', x: 0, y: 0 }, { id: 'b', type: 'note', x: 200, y: 0 }],
    edges: [{ id: 'bad-kind', kind: 'mystery', fromNodeId: 'a', toNodeId: 'b' }],
  }), null, 'unknown edge kinds must reject the whole batch');
  assert.deepStrictEqual(model.capture(), before, 'invalid templates must not leave partial content');
  assert.strictEqual(model.historyIndex, beforeHistory, 'invalid templates must not enter history');
}

verifyTutorial().then(() => console.log('research tutorial regression passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

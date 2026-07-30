const assert = require('assert');
const aiCanvas = require('../assets/ai-canvas-plan.js');

function createNode(id, body) {
  return {
    id,
    kind: 'card',
    title: '标题 ' + id,
    body: body || '',
    x: Number(id.replace(/\D/g, '')) || 0,
    y: 20,
  };
}

function createPlanNode(ref) {
  return { op: 'create', ref, kind: 'card', title: ref, body: '' };
}

function newEdge(from, to) {
  return {
    op: 'create',
    from: { kind: 'new', ref: from },
    to: { kind: 'new', ref: to },
    text: '',
  };
}

const original = createNode('n1', '正文');
assert.strictEqual(
  aiCanvas.nodeFingerprint(original),
  aiCanvas.nodeFingerprint(Object.assign({}, original)),
  '同一语义节点的指纹必须稳定',
);
assert.strictEqual(
  aiCanvas.nodeFingerprint(original),
  aiCanvas.nodeFingerprint(Object.assign({}, original, { x: 99 })),
  '只移动节点不应让内容计划过期',
);
assert.notStrictEqual(
  aiCanvas.nodeFingerprint(original),
  aiCanvas.nodeFingerprint(Object.assign({}, original, { body: '已修改' })),
  '正文变化必须让预览指纹失效',
);

const manyNodes = [];
for (let index = 0; index < 110; index++) {
  manyNodes.push(createNode('node-' + index, 'x'.repeat(2500)));
}
const selectionContext = aiCanvas.describeContext({
  nodes: manyNodes,
  edges: [],
  selectedIds: manyNodes.map((node) => node.id),
}, { scope: 'selection' });
assert(selectionContext.nodes.length <= 60, '选区上下文不得超过 60 个节点');
assert(selectionContext.truncation.totalChars <= 60000, '正文总量不得超过 60000 字');
selectionContext.nodes.forEach((node) => {
  assert(node.title.length + node.body.length <= 2000, '选区单节点不得超过 2000 字');
});
assert.strictEqual(selectionContext.truncation.truncated, true);

const canvasEdges = [];
for (let index = 0; index < 220; index++) {
  canvasEdges.push({
    id: 'edge-' + index,
    from: 'node-' + (index % 80),
    to: 'node-' + ((index + 1) % 80),
    text: '关系',
  });
}
const canvasContext = aiCanvas.describeContext({
  nodes: manyNodes,
  edges: canvasEdges,
}, { scope: 'canvas' });
assert(canvasContext.nodes.length <= 100, '整张画布上下文不得超过 100 个节点');
assert.strictEqual(canvasContext.edges.length, 200, '连线必须截断到 200 条');
canvasContext.nodes.forEach((node) => {
  assert(node.title.length + node.body.length <= 600, '整张画布单节点不得超过 600 字');
});

const treeContext = aiCanvas.describeContext({
  nodes: [
    Object.assign(createNode('root'), { mindmapRoot: true, mindmapMember: true }),
    Object.assign(createNode('child'), { mindmapMember: true }),
    createNode('leaf'),
  ],
  edges: [
    { id: 'e1', from: 'root', to: 'child', text: '' },
    { id: 'e2', from: 'child', to: 'leaf', text: '' },
  ],
  selectedIds: ['root', 'child', 'leaf'],
}, { scope: 'selection' });
assert.strictEqual(treeContext.mindmap.valid, true);
assert.strictEqual(treeContext.mindmap.rootId, 'root');
assert.strictEqual(treeContext.mindmap.maxDepth, 2);
assert.deepStrictEqual(treeContext.mindmap.parents, [
  { parentId: 'root', childId: 'child' },
  { parentId: 'child', childId: 'leaf' },
]);
assert.strictEqual(treeContext.nodes[0].mindmapMember, true);
assert.strictEqual(treeContext.nodes[1].mindmapMember, true);
assert.strictEqual(treeContext.nodes[2].mindmapMember, false);
assert.strictEqual(aiCanvas.mindmapReport(
  [{ id: 'root' }, { id: 'child', mindmapRoot: true }],
  [{ from: 'root', to: 'child' }],
).reason, 'root-marker-mismatch');

const previewPlan = {
  version: 2,
  action: 'refine',
  nodes: [createPlanNode('n1'), createPlanNode('n2')],
  edges: [
    newEdge('n1', 'n2'),
    { op: 'remove', id: 'old', from: { kind: 'existing', id: 'a' }, to: { kind: 'existing', id: 'b' } },
  ],
};
const defaultSelection = aiCanvas.selectOperations(previewPlan, {});
assert.strictEqual(defaultSelection.nodes.length, 2);
assert.strictEqual(defaultSelection.edges.length, 1, '移除连线默认不得勾选');
const withoutSecondNode = aiCanvas.selectOperations(previewPlan, {
  nodeIndexes: [0],
  edgeIndexes: [0, 1],
});
assert.strictEqual(withoutSecondNode.edges.length, 1, '仍应保留显式勾选的已有连线移除');
assert.deepStrictEqual(withoutSecondNode.droppedEdgeIndexes, [0], '依赖已取消新节点的连线必须自动取消');

const mindmapPlan = {
  version: 2,
  action: 'create_mindmap',
  mindmap: { rootRef: 'n1' },
  nodes: [createPlanNode('n1'), createPlanNode('n2'), createPlanNode('n3'), createPlanNode('n4')],
  edges: [newEdge('n1', 'n2'), newEdge('n2', 'n3'), newEdge('n1', 'n4')],
};
const cascaded = aiCanvas.selectOperations(mindmapPlan, {
  nodeIndexes: [0, 2, 3],
  edgeIndexes: [0, 1, 2],
});
assert.deepStrictEqual(
  cascaded.nodes.map((entry) => entry.item.ref),
  ['n1', 'n4'],
  '取消导图父节点时必须级联取消它的子树',
);
assert.deepStrictEqual(cascaded.droppedEdgeIndexes, [0, 1]);
const outline = aiCanvas.mindmapOutline(mindmapPlan, cascaded);
assert.strictEqual(outline.ok, true);
assert.deepStrictEqual(outline.refs, ['n1', 'n4']);
assert.deepStrictEqual(outline.nodes.map((node) => node.depth), [0, 1]);
const rootOnly = aiCanvas.selectOperations(mindmapPlan, {
  nodeIndexes: [0],
  edgeIndexes: [0, 1, 2],
});
assert.strictEqual(aiCanvas.mindmapOutline(mindmapPlan, rootOnly).reason, 'too-small');

const invalidMindmap = Object.assign({}, mindmapPlan, {
  nodes: [createPlanNode('n1'), createPlanNode('n2'), createPlanNode('n3')],
  edges: [newEdge('n1', 'n3'), newEdge('n2', 'n3')],
});
assert.strictEqual(aiCanvas.mindmapOutline(invalidMindmap).ok, false);

const extensionPlan = {
  version: 2,
  action: 'extend_branch',
  mindmap: { rootRef: 'n1', anchorId: 'existing-parent' },
  nodes: [createPlanNode('n1'), createPlanNode('n2')],
  edges: [
    {
      op: 'create',
      from: { kind: 'existing', id: 'existing-parent' },
      to: { kind: 'new', ref: 'n1' },
      text: '',
    },
    newEdge('n1', 'n2'),
  ],
};
const extension = aiCanvas.extensionSubtree(extensionPlan);
assert.strictEqual(extension.ok, true);
assert.strictEqual(extension.anchorId, 'existing-parent');
assert.deepStrictEqual(extension.refs, ['n1', 'n2']);

const layoutInput = {
  nodes: [
    { id: 'fixed', x: 360, y: 300 },
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 0 },
    { id: 'c', x: 0, y: 0 },
  ],
  edges: [
    { from: 'fixed', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
  ],
  movableIds: ['a', 'b', 'c'],
  center: { x: 500, y: 300 },
};
const layoutA = aiCanvas.deterministicLayout(layoutInput);
const layoutB = aiCanvas.deterministicLayout(JSON.parse(JSON.stringify(layoutInput)));
assert.deepStrictEqual(layoutA, layoutB, '普通网络局部布局必须确定');
assert.strictEqual(layoutA.fixed, undefined, '范围外节点不得进入移动结果');
assert(layoutA.b.x > layoutA.a.x, '子节点应排在父节点之后');
assert.notDeepStrictEqual(layoutA.a, { x: 360, y: 300 }, '新增节点不得压在固定节点上');

console.log('ai canvas plan regression passed');

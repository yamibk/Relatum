const assert = require('assert');
const canvasImport = require('../assets/canvas-import.js');

function ids(prefix) {
  let value = 0;
  return function () {
    value += 1;
    return prefix + value;
  };
}

function prepare(payload, assetPolicy) {
  return canvasImport.prepare(payload, {
    assetPolicy: assetPolicy || 'skip',
    dropPoint: { x: 1000, y: 500 },
    newNodeId: ids('new-node-'),
    newEdgeId: ids('new-edge-'),
    newInkId: ids('new-ink-'),
    reservedNodeIds: new Set(),
    reservedEdgeIds: new Set(),
    reservedInkIds: new Set(),
  });
}

const source = {
  version: 2,
  nodes: [
    { id: 'a', kind: 'card', x: 0, y: 0, width: 100, height: 40, text: 'A' },
    { id: 'b', kind: 'shape', shapeType: 'ellipse', x: 200, y: 100, width: 80, height: 60 },
    {
      id: 'group',
      kind: 'shape',
      shapeType: 'group-box',
      x: -50,
      y: -50,
      width: 400,
      height: 250,
      groupMemberIds: ['a', 'b', 'asset'],
    },
    { id: 'asset', kind: 'image', x: 500, y: 0, assetPath: 'attachments/example.png' },
  ],
  edges: [
    { id: 'edge-ab', from: 'a', to: 'b', waypoints: [{ x: 120, y: 45 }] },
    { id: 'edge-asset', from: 'b', to: 'asset' },
  ],
  ink: {
    version: 1,
    strokes: [
      {
        id: 'stroke-old',
        color: '#111111',
        points: [{ x: -100, y: 300, p: 0.65 }, { x: 0, y: 300, p: 0.8 }],
      },
    ],
    arrows: [
      {
        id: 'arrow-old',
        start: { x: 10, y: 20 },
        end: { x: 30, y: 40 },
        control: { x: 15, y: 35 },
      },
      {
        id: 'poly-old',
        kind: 'poly',
        start: { x: 40, y: 50 },
        end: { x: 90, y: 80 },
        waypoints: [{ x: 65, y: 55 }],
      },
    ],
  },
  ruler: { cx: 200, cy: 100, angle: 45 },
  background: { kind: 'legacy' },
};

const frozenSource = JSON.parse(JSON.stringify(source));
const plan = prepare(source, 'skip');
assert.deepStrictEqual(source, frozenSource, 'preparing an import must not mutate its source');
assert.strictEqual(plan.nodes.length, 3);
assert.strictEqual(plan.edges.length, 1);
assert.strictEqual(plan.ink.strokes.length, 1);
assert.strictEqual(plan.ink.arrows.length, 2);
assert.strictEqual(plan.meta.skippedAssets, 1);
assert.strictEqual(plan.meta.skippedEdges, 1);
assert.deepStrictEqual(plan.meta.offset, { x: 875, y: 375 });
assert.strictEqual(plan.nodes[0].x, 875);
assert.strictEqual(plan.nodes[0].y, 375);
assert.deepStrictEqual(plan.nodes[2].groupMemberIds, ['new-node-1', 'new-node-2']);
assert.deepStrictEqual(plan.edges[0].waypoints, [{ x: 995, y: 420 }]);
assert.strictEqual(plan.ink.strokes[0].id, 'new-ink-1');
assert.strictEqual(plan.ink.strokes[0].points[0].x, 775);
assert.strictEqual(plan.ink.strokes[0].points[0].y, 675);
assert.strictEqual(plan.ink.strokes[0].points[0].p, 0.65);
assert.deepStrictEqual(plan.ink.arrows[0].control, { x: 890, y: 410 });
assert.deepStrictEqual(plan.ink.arrows[1].waypoints, [{ x: 940, y: 430 }]);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plan, 'ruler'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(plan, 'background'), false);

const included = prepare(source, 'include');
assert.strictEqual(included.nodes.length, 4);
assert.strictEqual(included.edges.length, 2);
assert.strictEqual(included.meta.assetCount, 1);
assert.strictEqual(included.meta.skippedAssets, 0);
assert.strictEqual(included.nodes[3].assetPath, 'attachments/example.png');
assert.deepStrictEqual(
  included.nodes[2].groupMemberIds,
  ['new-node-1', 'new-node-2', 'new-node-4'],
);
assert.strictEqual(included.edges[1].to, 'new-node-4');
assert.notStrictEqual(included.nodes[3], source.nodes[3]);

assert.throws(
  () => prepare(source, 'reject'),
  (error) => error.code === 'ASSETS_UNSUPPORTED' && error.details.assetCount === 1,
);
assert.throws(
  () => prepare({ nodes: [{ id: 'broken-asset', kind: 'image', assetPath: '' }] }, 'reject'),
  (error) => error.code === 'ASSETS_UNSUPPORTED' && error.details.assetCount === 1,
);
assert.throws(
  () => prepare({ nodes: [{ kind: 'card' }], edges: [] }),
  (error) => error.code === 'MISSING_NODE_ID',
);
assert.throws(
  () => prepare({ nodes: [{ id: 'same' }, { id: 'same' }], edges: [] }),
  (error) => error.code === 'DUPLICATE_NODE_ID',
);
assert.throws(
  () => prepare({ nodes: [], edges: [], ink: { strokes: [], arrows: [] } }),
  (error) => error.code === 'EMPTY_IMPORT',
);
assert.throws(
  () => prepare({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b', waypoints: [{ x: 'bad', y: 2 }] }],
  }),
  (error) => error.code === 'INVALID_EDGE',
);

const bindingPlan = prepare({
  nodes: [
    { id: 'target', kind: 'card', x: 0, y: 0 },
    {
      id: 'label',
      kind: 'textBox',
      x: 20,
      y: 30,
      textBindTarget: 'target',
      textBindDx: 20,
      textBindDy: 30,
    },
    {
      id: 'orphan-label',
      kind: 'textBox',
      x: 40,
      y: 60,
      textBindTarget: 'missing',
      textBindDx: 40,
      textBindDy: 60,
    },
  ],
  edges: [],
});
assert.strictEqual(bindingPlan.nodes[1].textBindTarget, 'new-node-1');
assert.strictEqual(bindingPlan.nodes[1].textBindDx, 20);
assert.strictEqual(bindingPlan.nodes[1].textBindDy, 30);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bindingPlan.nodes[2], 'textBindTarget'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bindingPlan.nodes[2], 'textBindDx'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(bindingPlan.nodes[2], 'textBindDy'), false);

const inkOnly = prepare({
  nodes: [],
  edges: [],
  ink: {
    strokes: [{ id: 'old', points: [[-10, -10], [10, 10]] }],
    arrows: [],
  },
});
assert.strictEqual(inkOnly.nodes.length, 0);
assert.strictEqual(inkOnly.ink.strokes.length, 1);
assert.deepStrictEqual(inkOnly.ink.strokes[0].points, [
  { x: 990, y: 490 },
  { x: 1010, y: 510 },
]);

let reservedCounter = 0;
const collisionPlan = canvasImport.prepare(
  { nodes: [{ id: 'source', x: 0, y: 0 }], edges: [] },
  {
    dropPoint: { x: 0, y: 0 },
    assetPolicy: 'skip',
    newNodeId: () => {
      reservedCounter += 1;
      return reservedCounter === 1 ? 'existing' : 'fresh';
    },
    newEdgeId: ids('edge-'),
    newInkId: ids('ink-'),
    reservedNodeIds: new Set(['existing']),
    reservedEdgeIds: new Set(),
    reservedInkIds: new Set(),
  },
);
assert.strictEqual(collisionPlan.nodes[0].id, 'fresh');
assert.strictEqual(canvasImport.MAX_FILE_BYTES, 160 * 1024 * 1024);

console.log('canvas import regression tests passed');

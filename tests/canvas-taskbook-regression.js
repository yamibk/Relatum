'use strict';

const assert = require('assert');
const Taskbooks = require('../assets/canvas-taskbook.js');

const stamp = '2026-07-28T00:00:00.000Z';
const root = Taskbooks.createRoot({
  id: 'task-root-a',
  title: '论文初稿',
  order: 0,
}, stamp);
const canvas = {
  version: 2,
  nodes: [
    { id: 'a', kind: 'card', text: '资料', strike: true, x: 300, y: 20 },
    { id: 'b', kind: 'preview', text: '写作', x: 300, y: 180 },
    { id: 'c', kind: 'card', text: '第一节', x: 620, y: 140 },
  ],
  edges: [],
  taskbook: { version: 2, roots: [root] },
};

assert.strictEqual(canvas.nodes.some(Taskbooks.isTaskRootNode), false, 'creating metadata must not place a canvas projection');

const projection = Taskbooks.createProjection({
  id: 'projection-a',
  taskRootId: root.id,
  x: 20,
  y: 40,
});
canvas.nodes.push(projection);
root.canvasNodeId = projection.id;

assert.deepStrictEqual(
  Taskbooks.resolveConnection(canvas, 'a', projection.id),
  { ok: true, rootId: root.id, parentNodeId: null, nodeId: 'a' },
  'node → projection must be recognized regardless of drag direction',
);
assert(Taskbooks.attachMember(canvas, root.id, null, 'a').ok);
assert(Taskbooks.attachMember(canvas, root.id, null, 'b').ok);
assert.deepStrictEqual(
  Taskbooks.resolveConnection(canvas, 'c', 'b'),
  { ok: true, rootId: root.id, parentNodeId: 'b', nodeId: 'c' },
  'unmanaged node → managed node must become a child regardless of direction',
);
assert(Taskbooks.attachMember(canvas, root.id, 'b', 'c').ok);

canvas.nodes.push(
  { id: 'batch-1', kind: 'card', text: '并行一', x: 860, y: 20 },
  { id: 'batch-2', kind: 'card', text: '并行二', x: 860, y: 100 },
  { id: 'batch-3', kind: 'preview', text: '并行三', x: 860, y: 180 },
);
const batch = Taskbooks.resolveConnectionBatch(
  canvas,
  ['batch-1', 'batch-2', 'batch-3'],
  'b',
  'batch-1',
);
assert.deepStrictEqual(
  batch.workflows.map((item) => item.workflow.nodeId),
  ['batch-1', 'batch-2', 'batch-3'],
  'one multi-selection gesture must collect every unmanaged node under the same task parent',
);
batch.workflows.forEach((item) => {
  assert(Taskbooks.attachMember(
    canvas,
    item.workflow.rootId,
    item.workflow.parentNodeId,
    item.workflow.nodeId,
  ).ok);
});

canvas.nodes.push({ id: 'ambiguous-target', kind: 'card', text: '只能归一个父级', x: 1100, y: 100 });
const ambiguous = Taskbooks.resolveConnectionBatch(
  canvas,
  ['a', 'b'],
  'ambiguous-target',
  'b',
);
assert.strictEqual(ambiguous.workflows.length, 1);
assert.strictEqual(ambiguous.workflows[0].firstId, 'b');
assert.strictEqual(
  ambiguous.workflows[0].workflow.nodeId,
  'ambiguous-target',
  'an ambiguous multi-parent gesture keeps the actual initiating parent only',
);
canvas.nodes = canvas.nodes.filter((node) => node.id !== 'ambiguous-target');

let model = Taskbooks.buildModel(canvas, root.id);
assert.strictEqual(model.ok, true);
assert.deepStrictEqual(model.roots, ['a', 'b']);
assert.deepStrictEqual(model.leaves, ['a', 'c', 'batch-1', 'batch-2', 'batch-3']);
assert.strictEqual(model.doneLeaves, 1);
assert.strictEqual(model.totalLeaves, 5);
assert.strictEqual(model.nextTaskId, 'c');
assert.strictEqual(model.completed, false);

const workflow = canvas.edges.filter(Taskbooks.isWorkflowEdge);
assert.strictEqual(workflow.length, 6, 'workflow edges are rebuilt as visual mirrors');
assert(workflow.some((edge) => edge.from === projection.id && edge.to === 'a'));
assert(workflow.some((edge) => edge.from === projection.id && edge.to === 'b'));
assert(workflow.some((edge) => edge.from === 'b' && edge.to === 'c'));
assert(workflow.every((edge) => edge.role === 'task-workflow' && edge.taskRootId === root.id));
assert(workflow.every((edge) => edge.curve === 'branch'));
assert(workflow.every((edge) => edge.arrow === 'end'));
assert(workflow.every((edge) => edge.lineStyle === 'solid'));
assert(workflow.every((edge) => edge.color === '#737373' && edge.width === 1.5));

assert.deepStrictEqual(Taskbooks.canAttach(canvas, root.id, 'b', 'a'), {
  ok: false,
  reason: 'owned',
});
assert.strictEqual(Taskbooks.owningTaskbookId(canvas, 'c'), root.id);
assert.strictEqual(Taskbooks.moveMember(canvas, root.id, 'b', 'c', '').reason, 'cycle');

canvas.nodes.find((node) => node.id === 'c').strike = true;
canvas.nodes.find((node) => node.id === 'batch-1').strike = true;
canvas.nodes.find((node) => node.id === 'batch-2').strike = true;
canvas.nodes.find((node) => node.id === 'batch-3').strike = true;
Taskbooks.synchronizeCompletion(canvas);
model = Taskbooks.buildModel(canvas, root.id);
assert.strictEqual(model.completed, true);
assert.strictEqual(root.completed, true);

const archived = Taskbooks.prepareArchive(
  JSON.parse(JSON.stringify(canvas)),
  root.id,
  { retainSnapshot: true, originX: 100, originY: 200 },
);
assert.strictEqual(archived.ok, true);
assert.strictEqual(archived.archive.leafCount, 5);
assert.strictEqual(archived.archive.copiedNodeIds.length, 7);
assert(!archived.data.taskbook, 'archiving the final root removes taskbook metadata');
archived.archive.removedNodeIds.forEach((id) => {
  assert(!archived.data.nodes.some((node) => node.id === id), 'original task node must be removed: ' + id);
});
const copiedNodes = archived.data.nodes.filter((node) => archived.archive.copiedNodeIds.includes(node.id));
assert.strictEqual(copiedNodes.length, 7);
const copiedRoot = copiedNodes.find((node) => node.id === archived.archive.snapshotRootNodeId);
assert(copiedRoot, 'archive snapshot must retain a root cover card');
assert(copiedNodes.filter((node) => node.id !== copiedRoot.id).every((node) => node.strike === true));
assert.notStrictEqual(copiedRoot.strike, true, 'the archive cover title stays readable');
assert(copiedNodes.every((node) => !node.taskRootId && node.kind !== 'task-root'));
const copiedEdges = archived.data.edges.filter((edge) => (
  archived.archive.copiedNodeIds.includes(edge.from)
  && archived.archive.copiedNodeIds.includes(edge.to)
));
assert.strictEqual(copiedEdges.length, 6);
assert(copiedEdges.every((edge) => (
  edge.curve === 'branch'
  && edge.arrow === 'end'
  && edge.lineStyle === 'solid'
  && !edge.role
  && !edge.taskRootId
)));
assert.strictEqual(copiedRoot.archiveCover, true);
assert.strictEqual(copiedRoot.bgColor, '#f2f4ef');
assert.strictEqual(copiedRoot.borderColor, '#667169');
assert.strictEqual(copiedRoot.width, 176);
assert.strictEqual(copiedRoot.radius, 14);
assert(copiedRoot.body.includes('5 / 5'));
assert(copiedRoot.body.includes('00:00'));
assert.strictEqual(copiedRoot.bodyMarks[0].color, 'green');
assert.strictEqual(copiedRoot.bodyMarks[1].color, 'gray');
assert(copiedNodes.filter((node) => node.id !== copiedRoot.id).every((node) => node.x > copiedRoot.x));

const archivedWithoutCopy = Taskbooks.prepareArchive(
  JSON.parse(JSON.stringify(canvas)),
  root.id,
  { retainSnapshot: false, originX: 100, originY: 200 },
);
assert.strictEqual(archivedWithoutCopy.ok, true);
assert.strictEqual(archivedWithoutCopy.archive.snapshotRootNodeId, null);
assert.deepStrictEqual(archivedWithoutCopy.archive.copiedNodeIds, []);
assert.strictEqual(archivedWithoutCopy.data.nodes.length, 0);
assert.strictEqual(archivedWithoutCopy.data.edges.length, 0);

const released = Taskbooks.releaseRoot(canvas, root.id);
assert.strictEqual(released.ok, true);
assert.deepStrictEqual(
  released.releasedNodeIds.sort(),
  ['a', 'b', 'batch-1', 'batch-2', 'batch-3', 'c'],
);
assert.strictEqual(canvas.taskbook, undefined);
assert(!canvas.nodes.some(Taskbooks.isTaskRootNode));
const formerChildEdge = canvas.edges.find((edge) => edge.from === 'b' && edge.to === 'c');
assert(formerChildEdge && !formerChildEdge.role, 'child workflow becomes an ordinary edge');
assert(!canvas.edges.some((edge) => edge.from === projection.id), 'projection edges are removed');

const legacy = Taskbooks.normalizeCanvas({
  version: 2,
  nodes: [{ id: 'old', kind: 'taskbook' }, { id: 'kept', kind: 'card', text: '保留' }],
  edges: [{ id: 'old-edge', role: 'taskbook-workflow', from: 'old', to: 'kept' }],
  taskbook: { version: 1, roots: [] },
});
assert.deepStrictEqual(legacy.nodes.map((node) => node.id), ['kept']);
assert.deepStrictEqual(legacy.edges, []);
assert.strictEqual(legacy.taskbook, undefined);

const emptyRoot = Taskbooks.createRoot({ id: 'task-root-empty', completed: true }, stamp);
const emptyCanvas = {
  nodes: [],
  edges: [],
  taskbook: { version: 2, roots: [emptyRoot] },
};
const emptyModel = Taskbooks.buildModel(emptyCanvas, emptyRoot.id);
assert.strictEqual(emptyModel.totalLeaves, 1);
assert.strictEqual(emptyModel.doneLeaves, 1);
assert.strictEqual(emptyModel.completed, true);
const emptyArchive = Taskbooks.prepareArchive(
  JSON.parse(JSON.stringify(emptyCanvas)),
  emptyRoot.id,
  { retainSnapshot: true, originX: 0, originY: 0 },
);
assert.strictEqual(emptyArchive.ok, true);
assert.strictEqual(emptyArchive.archive.leafCount, 1);
assert.strictEqual(emptyArchive.archive.copiedNodeIds.length, 1);
assert.strictEqual(
  emptyArchive.data.nodes.find((node) => node.id === emptyArchive.archive.snapshotRootNodeId).archiveCover,
  true,
);

const timedRoot = Taskbooks.createRoot({ id: 'task-root-timed', title: '计时任务' }, stamp);
const timedCanvas = {
  nodes: [
    Taskbooks.createProjection({ id: 'timed-projection', taskRootId: timedRoot.id, x: 0, y: 0 }),
    { id: 'timed-parent', kind: 'card', text: '父任务', x: 260, y: 0 },
    { id: 'timed-leaf', kind: 'preview', text: '叶子任务', x: 520, y: 0 },
  ],
  edges: [],
  taskbook: { version: 2, roots: [timedRoot] },
};
timedRoot.canvasNodeId = 'timed-projection';
assert(Taskbooks.attachMember(timedCanvas, timedRoot.id, null, 'timed-parent').ok);
assert(Taskbooks.attachMember(timedCanvas, timedRoot.id, 'timed-parent', 'timed-leaf').ok);
timedRoot.sessions.push(
  Taskbooks.normalizeSession({
    id: 'timed-segment',
    nodeId: 'timed-leaf',
    taskTitle: '叶子任务',
    durationMs: 65000,
    startedAt: stamp,
    endedAt: '2026-07-28T00:01:05.000Z',
    focusLogged: true,
  }, stamp),
);
const timedBefore = Taskbooks.buildModel(timedCanvas, timedRoot.id);
const deletedTimedIds = new Set(Taskbooks.subtreeIds(timedCanvas, timedRoot.id, 'timed-parent'));
assert.deepStrictEqual([...deletedTimedIds], ['timed-parent', 'timed-leaf']);
timedRoot.members = timedRoot.members.filter((member) => !deletedTimedIds.has(member.nodeId));
timedCanvas.nodes = timedCanvas.nodes.filter((node) => !deletedTimedIds.has(node.id));
timedCanvas.edges = timedCanvas.edges.filter((edge) => (
  !deletedTimedIds.has(edge.from) && !deletedTimedIds.has(edge.to)
));
Taskbooks.rebuildWorkflowEdges(timedCanvas);
const timedAfter = Taskbooks.buildModel(timedCanvas, timedRoot.id);
assert.strictEqual(timedBefore.actualMs, 65000);
assert.strictEqual(timedAfter.actualMs, timedBefore.actualMs, 'subtree deletion must retain root tracked time');
assert.strictEqual(timedRoot.sessions.length, 1);
assert.strictEqual(timedRoot.sessions[0].nodeId, 'timed-leaf', 'session attribution remains restorable by undo');
assert.strictEqual(timedRoot.sessions[0].focusLogged, true, 'deletion must not duplicate an existing focus log');

console.log('canvas taskbook V3 regression tests passed');

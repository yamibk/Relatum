'use strict';
const assert = require('node:assert/strict');
const changes = require('../assets/canvas-changes.js');
const copy = (value) => JSON.parse(JSON.stringify(value));
const before = {
  nodes: [{ id: 'a', kind: 'card', text: '中文', x: 1, y: 2, textMarks: [{ from: 0, to: 1, bold: true }] },
    { id: 'image', kind: 'image', x: 30, y: 40, assetPath: 'images/a.png' }],
  edges: [{ id: 'e', from: 'a', to: 'image', waypoints: [{ x: 6, y: 7 }] }],
};
const moved = copy(before);
moved.nodes[0].x = 50;
const move = changes.diff(before, moved);
assert.deepEqual([...move.nodeIds], ['a']);
assert.equal(move.contentNodeIds.size, 0);
assert.equal(move.topology, false);
assert.equal(move.ink, false);

const edited = copy(moved);
edited.nodes[0].textMarks[0].bold = false;
edited.edges[0].waypoints[0].x = 30;
const edit = changes.diff(moved, edited);
assert.deepEqual([...edit.contentNodeIds], ['a']);
assert.deepEqual([...edit.edgeIds], ['e']);
assert.equal(edit.topology, false);

const current = copy(edited);
const originalNode = current.nodes[0], image = current.nodes[1], edge = current.edges[0];
current.nodes[0].temporary = true;
const restored = changes.restoreRecords(current.nodes, before.nodes, copy);
const restoredEdges = changes.restoreRecords(current.edges, before.edges, copy);
assert.equal(restored[0], originalNode, 'event handlers must retain the same record');
assert.equal(restored[1], image, 'unchanged attachment identity must survive undo');
assert.equal(restoredEdges[0], edge);
assert.deepEqual(restored, before.nodes);
assert.equal('temporary' in restored[0], false);
restored[0].textMarks[0].from = 9;
restoredEdges[0].waypoints[0].x = 999;
assert.equal(before.nodes[0].textMarks[0].from, 0, 'live rich text cannot mutate history');
assert.equal(before.edges[0].waypoints[0].x, 6, 'live bending cannot mutate history');

const folded = copy(before);
folded.nodes[0].mindmapCollapsed = true;
assert(changes.diff(before, folded).topology);
const completed = copy(before);
completed.nodes[0].strike = true;
assert(changes.diff(before, completed).taskbook, 'a task card completion invalidates its derived root');
folded.edges[0].from = 'image';
assert(changes.diff(before, folded).topology);
const removed = copy(before);
removed.nodes.shift();
assert.deepEqual([...changes.diff(before, removed).removedNodeIds], ['a']);
const reordered = copy(before);
reordered.nodes.reverse();
assert(changes.diff(before, reordered).topology, 'stack order changes must be restored');
const timers = changes.diff({}, { timers: [{ id: 'timer', elapsedMs: 20 }], taskbook: { version: 2 } });
assert(timers.timers && timers.taskbook);
const merged = changes.merge(move, edit);
assert.deepEqual([...merged.nodeIds], ['a']);
assert.deepEqual([...merged.edgeIds], ['e']);
assert.deepEqual(changes.diff(before, copy(before)).nodeIds, new Set());
console.log('canvas changes regression: ok');

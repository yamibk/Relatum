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

const state = Object.assign(copy(before), { ink: { version: 1, strokes: [{ id: 'stroke', points: [{ x: 1, y: 2, p: .7, tilt: 20 }] }], arrows: [] } });
const cloners = { state: copy, nodes: copy, edges: copy, timers: copy, strokes: copy, arrows: copy, ruler: copy, taskbook: copy };
const journal = changes.createHistory(copy(state), { clone: cloners, limit: 50 });
const inkHead = journal.head().ink;
const livePoints = state.ink.strokes[0].points;
Object.defineProperty(state.ink.strokes[0], 'points', { configurable: true, get() { throw new Error('node history visited unrelated ink'); } });
state.nodes[0].x = 100;
const publicChange = journal.commit(state, { nodes: true, edges: true });
publicChange.nodeIds.add('unrelated'); publicChange.ink = true;
assert.equal(journal.head().ink, inkHead);
const scopedUndo = journal.undo();
assert.equal(scopedUndo.snapshot.nodes[0].x, 1);
assert.equal(scopedUndo.changes.nodeIds.has('unrelated'), false, 'notification batching must not mutate saved transactions');
assert.equal(scopedUndo.changes.ink, false);
assert.equal(journal.redo().snapshot.nodes[0].x, 100);
Object.defineProperty(state.ink.strokes[0], 'points', { configurable: true, writable: true, value: livePoints });
state.nodes[0].textMarks[0].bold = false;
state.nodes.reverse();
journal.commit(state, { nodes: true });
state.nodes[1].textMarks[0].from = 999;
const reversed = journal.undo();
assert.deepEqual(reversed.snapshot.nodes.map(n => n.id), ['a', 'image']);
assert.equal(reversed.snapshot.nodes[0].textMarks[0].from, 0);
assert.deepEqual(journal.redo().snapshot.nodes.map(n => n.id), ['image', 'a']);
state.ink.strokes.push({ id: 'fragment', points: [{ x: 3, y: 4, p: .8 }] });
journal.commit(state, { strokes: new Set(['fragment']) });
assert.equal(journal.head().ink.strokes[0], inkHead.strokes[0]);
assert.equal(journal.undo().snapshot.ink.strokes.length, 1);
assert.equal(journal.redo().snapshot.ink.strokes[1].points[0].p, .8);
state.ink.strokes[0].points[0].p = .2;
journal.commit(state); // Unknown compatibility calls still capture all fields.
assert.equal(journal.undo().snapshot.ink.strokes[0].points[0].p, .7);
assert.equal(journal.redo().snapshot.ink.strokes[0].points[0].p, .2);
for (let i = 0; i < 60; i++) { state.nodes[0].x = i; journal.commit(state, { nodes: true }); }
let count = 0;
while (journal.canUndo()) { journal.undo(); count++; }
assert.equal(count, 49);
assert(journal.canRedo());
journal.commit(state, { nodes: true });
assert.equal(journal.canRedo(), false);
console.log('canvas entity history regression: ok');

import assert from 'node:assert/strict';
import { ResearchModel } from '../assets/research/core/model.js';
import { createSaveQueue } from '../assets/research/core/persistence.js';
import { branchIds, hiddenBranches, layoutBranch } from '../assets/research/core/tree.js';

const blank = () => ({ format: 'relatum-research', formatVersion: 1, projectId: 'project-main', revision: 0,
  title: 'Test', objects: [], relations: [], views: [{ id: 'view-main', type: 'core.canvas', representations: [] }],
  resources: [], pluginRequirements: [], future: { payload: ['preserve'] } });
const model = new ResearchModel(blank());
const add = id => model.dispatch({ type: 'createObject', objectType: 'core.variable', objectId: id, viewId: 'view-main', x: 10, y: 20 });
add('var-a');
assert.equal(model.revision, 1);
const rep = model.snapshot().views[0].representations[0].id;
model.dispatch({ type: 'updateObject', objectId: 'var-a', changes: { label: '出力' } });
model.dispatch({ type: 'addRepresentation', objectId: 'var-a', viewId: 'view-main', x: 50, y: 60 });
model.dispatch({ type: 'moveRepresentation', viewId: 'view-main', representationId: rep, x: 99, y: 88 });
model.undo(); assert.equal(model.snapshot().views[0].representations[0].x, 10);
model.redo(); assert.equal(model.snapshot().views[0].representations[0].x, 99);
model.dispatch({ type: 'removeRepresentation', viewId: 'view-main', representationId: rep });
assert.equal(model.snapshot().objects[0].payload.label, '出力');
assert.equal(model.snapshot().views[0].representations.length, 1);
model.undo(); assert.equal(model.snapshot().views[0].representations.length, 2);
model.dispatch({ type: 'updateObject', objectId: 'var-a', changes: { label: 'a' } }, 'typing');
model.dispatch({ type: 'updateObject', objectId: 'var-a', changes: { label: 'ab' } }, 'typing');
model.undo(); assert.equal(model.snapshot().objects[0].payload.label, '出力');
const before = model.snapshot();
assert.throws(() => model.dispatch({ type: 'updateObject', objectId: 'var-a', changes: { id: 'changed' } }));
assert.throws(() => model.dispatch({ type: 'moveRepresentation', viewId: 'view-main', representationId: rep, x: NaN, y: 1 }));
assert.throws(() => add('var-a'));
assert.deepEqual(before, model.snapshot());
const outside = model.snapshot(); outside.objects[0].payload.label = 'mutated';
assert.deepEqual(before, model.snapshot());
assert.deepEqual(model.snapshot().future, { payload: ['preserve'] });
while (model.canUndo) model.undo();
assert.equal(model.snapshot().objects.length, 0);
assert.equal(model.snapshot().views[0].representations.length, 0);
assert(model.revision > 0, 'undo advances revision');

// Clean flush must not poison future saves; edits arriving during save are drained.
const loaded = { project: model.snapshot(), fingerprint: 'fp0' };
let release, calls = [];
const queue = createSaveQueue(model, loaded, () => {}, async (_, body) => {
  calls.push(structuredClone(body));
  if (calls.length === 1) await new Promise(resolve => { release = resolve; });
  return { revision: body.project.revision, fingerprint: `fp${calls.length}` };
});
assert.equal(await queue.flush(), true);
add('var-b'); const saving = queue.flush();
add('var-c'); release(); assert.equal(await saving, true);
assert.equal(calls.length, 2); assert.equal(calls[1].expectedRevision, calls[0].project.revision);
assert.equal(queue.dirty, false);
queue.dispose();

let attempts = [], fail = true;
const retry = createSaveQueue(model, { project: model.snapshot(), fingerprint: 'fp2' }, () => {}, async (_, body) => {
  attempts.push(structuredClone(body));
  if (fail) { fail = false; throw new Error('response lost'); }
  return { revision: body.project.revision, fingerprint: 'fp3' };
});
add('var-d'); assert.equal(await retry.flush(), false);
assert(retry.dirty); assert.equal(await retry.flush(), true);
assert.deepEqual(attempts[0], attempts[1]); retry.dispose();
console.log('Research model and save queue regression passed');

const drafts = new ResearchModel(blank());
for (const kind of ['note', 'formula']) {
  drafts.dispatch({ type: 'createObject', objectType: `core.${kind}`, objectId: kind, viewId: 'view-main', x: 0, y: 0 });
  drafts.dispatch({ type: 'updateObject', objectId: kind, changes: { source: '中文\n\\frac{1}{2} <script>draft</script>' } }, kind);
  drafts.dispatch({ type: 'updateObject', objectId: kind, changes: { source: '最终内容😀' } }, kind);
  drafts.undo(); assert.equal(drafts.snapshot().objects.find(obj => obj.id === kind).payload.source, '');
  drafts.redo(); assert.equal(drafts.snapshot().objects.find(obj => obj.id === kind).payload.source, '最终内容😀');
  const before = drafts.snapshot();
  for (const changes of [{ source: 123 }, { source: 'x'.repeat(100001) }, { symbol: 'q' }]) {
    assert.throws(() => drafts.dispatch({ type: 'updateObject', objectId: kind, changes }));
    assert.deepEqual(drafts.snapshot(), before);
  }
}
console.log('Research draft types and grouped history passed');

const graph = new ResearchModel(blank());
for (const id of ['a', 'b']) graph.dispatch({ type: 'createObject', objectType: 'core.note', objectId: id, viewId: 'view-main', x: 0, y: 0 });
graph.dispatch({ type: 'addRepresentation', objectId: 'a', viewId: 'view-main', x: 200, y: 0 });
const [a, b, alias] = graph.snapshot().views[0].representations;
const connect = { type: 'createRelation', viewId: 'view-main', relationId: 'association', sourceId: a.id, targetId: b.id };
for (const invalid of [{ targetId: 'missing' }, { targetId: alias.id }, { label: 123 }]) {
  const before = graph.snapshot();
  assert.throws(() => graph.dispatch({ ...connect, ...invalid })); assert.deepEqual(graph.snapshot(), before);
}
graph.dispatch(connect); graph.undo();
assert.equal(graph.snapshot().relations.length, 0); assert.equal(graph.snapshot().views[0].links?.length || 0, 0);
graph.redo();
graph.dispatch({ type: 'renameRelation', relationId: 'association', label: '证据 → 假设' });
graph.dispatch({ type: 'removeRepresentation', viewId: 'view-main', representationId: a.id });
assert.equal(graph.snapshot().relations[0].label, '证据 → 假设');
assert.equal(graph.snapshot().views[0].links.length, 0);
graph.undo(); assert.equal(graph.snapshot().views[0].links.length, 1);
graph.dispatch({ type: 'removeRelation', relationId: 'association' });
assert.equal(graph.snapshot().relations.length, 0); assert.equal(graph.snapshot().views[0].links.length, 0);
graph.undo(); assert.equal(graph.snapshot().relations[0].label, '证据 → 假设');
assert.equal(graph.snapshot().views[0].links[0].sourceId, a.id);
assert.equal(new ResearchModel(graph.snapshot()).snapshot().relations[0].ends[1].objectId, 'b');
console.log('Research relationship identity, atomic history and visual removal passed');

const tree = new ResearchModel(graph.snapshot());
const command = (type, extra = {}) => tree.dispatch({ type, viewId: 'view-main', representationId: a.id, ...extra });
command('createBranch', { objectType: 'core.note', objectId: 'child', parentId: a.id, x: 400, y: 40 });
const child = tree.snapshot().views[0].representations.at(-1);
command('createBranch', { objectType: 'core.note', objectId: 'grandchild', parentId: child.id, x: 800, y: 50 });
const grand = tree.snapshot().views[0].representations.at(-1);
const initialTree = tree.snapshot();
assert.deepEqual(new Set(branchIds(initialTree.views[0].representations, a.id)), new Set([a.id, child.id, grand.id]));
for (const parentId of [grand.id, a.id, 'missing']) {
  assert.throws(() => command('setBranchParent', { parentId }));
  assert.deepEqual(tree.snapshot(), initialTree);
}
command('moveRepresentation', { x: 100, y: 80 });
assert.equal(tree.snapshot().views[0].representations.find(rep => rep.id === grand.id).x, 900);
assert.equal(tree.snapshot().views[0].representations.find(rep => rep.id === alias.id).x, alias.x);
assert.deepEqual(tree.snapshot().relations, initialTree.relations);
tree.undo(); assert.deepEqual(tree.snapshot().views, initialTree.views);
command('toggleBranch');
assert.deepEqual(hiddenBranches(tree.snapshot().views[0].representations), new Set([child.id, grand.id]));
command('revealRepresentation', { representationId: grand.id });
assert.equal(hiddenBranches(tree.snapshot().views[0].representations).size, 0);
const beforeLayout = tree.snapshot();
command('layoutBranch');
assert.equal(tree.snapshot().views[0].representations.find(rep => rep.id === grand.id).x, 720);
tree.undo(); assert.deepEqual(tree.snapshot().views, beforeLayout.views);
command('removeRepresentation', { representationId: child.id });
assert.equal(tree.snapshot().views[0].representations.find(rep => rep.id === grand.id).parentId, undefined);
assert.equal(tree.snapshot().objects.length, beforeLayout.objects.length);
tree.undo(); assert.deepEqual(tree.snapshot().views, beforeLayout.views);
command('setBranchParent', { representationId: child.id, parentId: null });
assert.equal(branchIds(tree.snapshot().views[0].representations, a.id).length, 1);
tree.undo();
const persistedTree = new ResearchModel(tree.snapshot());
assert.deepEqual(persistedTree.snapshot(), tree.snapshot());
// Unequal card heights and multiple sibling subtrees must not overlap.
const fixture = [{ id: 'r', x: 10, y: 20 }, { id: 'c1', parentId: 'r' }, { id: 'c2', parentId: 'r' }, { id: 'g', parentId: 'c1' }];
const dimensions = { r: { width: 180, height: 90 }, c1: { width: 280, height: 340 }, c2: { width: 280, height: 300 }, g: { width: 180, height: 400 } };
const layout = layoutBranch(fixture, 'r', dimensions);
assert.deepEqual(layout.get('r'), { x: 10, y: 20 });
assert(layout.get('c2').y >= layout.get('c1').y + 340 + 32);
const deep = Array.from({ length: 12000 }, (_, n) => ({ id: String(n), ...(n ? { parentId: String(n - 1) } : {}), x: 0, y: 0 }));
assert.equal(branchIds(deep, '0').length, 12000);
assert.equal(layoutBranch(deep, '0').size, 12000);
console.log('Research branch hierarchy, layout, deep traversal, history and relationship isolation passed');

const deletingModel = new ResearchModel(graph.snapshot());
deletingModel.dispatch({ type: 'updateObject', objectId: 'a', changes: { label: 'unsaved' } });
let deletionAttempts = 0, deletionBody;
const deletingQueue = createSaveQueue(deletingModel, { project: graph.snapshot(), fingerprint: 'before' }, () => {}, async (route, body) => {
  if (route === 'save') return { revision: body.project.revision, fingerprint: 'flushed' };
  assert.equal(body.expectedFingerprint, 'flushed');
  if (!deletionAttempts++) { deletionBody = structuredClone(body); throw new Error('response lost'); }
  assert.deepEqual(body, deletionBody);
  const project = blank(); project.revision = 99;
  return { project, fingerprint: 'deleted' };
});
assert.equal(await deletingQueue.deleteObject('a'), false);
assert(deletingQueue.deleting); assert(deletingQueue.dirty);
assert.equal(await deletingQueue.flush(), true);
assert.equal(deletingModel.canUndo, false); assert.equal(deletingModel.canRedo, false);
deletingModel.undo(); assert.equal(deletingModel.snapshot().objects.length, 0);
assert.equal(deletingQueue.dirty, false); deletingQueue.dispose();
console.log('Permanent deletion flush, uncertain retry and history removal passed');

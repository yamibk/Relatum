import assert from 'node:assert/strict';
import { ResearchModel } from '../assets/research/core/model.js';
import { createSaveQueue } from '../assets/research/core/persistence.js';

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

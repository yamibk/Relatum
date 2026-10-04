'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const moduleAt = (name) => import(pathToFileURL(path.join(root, 'assets/research', name)).href);
const line = (id, x = 0, y = 0, units = 5) => ({ id, kind: 'line', x, y, direction: 0, units,
  unitLength: 40, width: 2, lineStyle: 'solid', color: 'mono', arrowhead: 'none' });
async function main() {
  const [geometry, { createResearchModel }, { createResearchRegistry }, { createResearchPageSession }, { validateResearchDocument }] = await Promise.all([
    moduleAt('research-orthogonal.js'), moduleAt('research-model.js'), moduleAt('research-registry.js'),
    moduleAt('research-pages.js'), moduleAt('research-schema.js'),
  ]);
  const { quantizeLine, linePoint, DecorationIndex, quantizeWithSnap, normalizeDecorations, hitDecoration, subtractLineSpan } = geometry;
  geometry.DIRECTIONS.forEach(([dx, dy], direction) => {
    const q = quantizeLine({ x: 12, y: 18 }, { x: 12 + dx * 121, y: 18 + dy * 121 }, 40);
    assert.equal(q.direction, direction); assert.equal(q.units, 3);
    assert.deepEqual(linePoint(q), { x: 12 + dx * 120, y: 18 + dy * 120 });
  });
  assert.equal(quantizeLine({ x: 0, y: 0 }, { x: 19, y: 0 }, 40).units, 0);
  assert.equal(quantizeLine({ x: 0, y: 0 }, { x: 0, y: 0 }, 40).units, 0);
  const index = new DecorationIndex([line('a')]);
  assert.deepEqual(index.nearestEndpoint({ x: 82, y: 3 }, 12), { x: 80, y: 0 });
  assert.equal(index.nearestEndpoint({ x: 92, y: 3 }, 6), null);
  assert.equal(quantizeWithSnap({ x: 1, y: 0 }, { x: 81, y: 0 }, 40, index).snap, null);
  assert.deepEqual(quantizeWithSnap({ x: 0, y: 0 }, { x: 81, y: 1 }, 40, index).snap, { x: 80, y: 0 });
  assert.deepEqual(quantizeWithSnap({ x: 0, y: 0 }, { x: 88, y: 0 }, 40, index, 1).snap, { x: 80, y: 0 });
  assert.equal(quantizeWithSnap({ x: 0, y: 0 }, { x: 88, y: 0 }, 40, index, 2).snap, null);
  const replacement = geometry.replacementWithSnap({ x: 40, y: 0 }, { x: 81, y: 1 }, index);
  assert.equal(replacement.line.unitLength, 40); assert.equal(replacement.line.units, 1);
  assert(hitDecoration(line('a'), { x: 90, y: 4 }, 6));
  const errors = []; assert.equal(normalizeDecorations([{ ...line('bad'), units: 1.5 }], errors).length, 0); assert.equal(errors.length, 1);
  assert.equal(normalizeDecorations([line('a'), line('a')], []).length, 1);
  const huge = new DecorationIndex([{ ...line('long'), units: 100000 }]);
  assert.equal(huge.large.size, 1);
  assert.deepEqual(huge.nearestEndpoint({ x: 3999999, y: 1 }, 12), { x: 4000000, y: 0 });
  const span = { ...line('new', 40, 0, 2), color: 'red', lineStyle: 'dashed' };
  const tails = subtractLineSpan({ ...line('a'), arrowhead: 'end' }, span);
  assert.deepEqual(tails.map((d) => [d.x, d.units, d.arrowhead]), [[0, 1, 'none'], [120, 2, 'end']]);
  assert.equal(subtractLineSpan({ ...line('cross'), direction: 2 }, span), null);
  assert.equal(subtractLineSpan(line('a'), { ...span, x: 41 }), null);
  const registry = createResearchRegistry(JSON.parse(fs.readFileSync(path.join(root, 'assets/research/research-node-definitions.json'), 'utf8')));
  const model = createResearchModel({}, registry), changes = [];
  model.subscribe((change) => changes.push(change));
  const oldNode = model.createNode({ type: 'note', label: 'original' });
  model.createDecoration(line('a'));
  const before = model.snapshot(), history = model.historyIndex;
  model.replaceDecorationSpan(span);
  assert.equal(model.historyIndex, history + 1); assert.equal(model.decorations().length, 3);
  assert(model.undo()); assert.deepEqual(model.snapshot(), before);
  assert(changes.at(-1).decorationsOnly, 'decoration undo must not invalidate computation');
  assert(model.redo());
  const committedPosition = model.decorations()[0].x;
  model.updateDecorations({ [model.decorations()[0].id]: { x: committedPosition + 15 } }, { live: true });
  assert.equal(model.persistenceSnapshot().decorations[0].x, committedPosition, 'saving during a live drag must use committed geometry');
  model.restore(model.history[model.historyIndex], true);
  const copies = model.duplicateDecorations(model.decorations().map((d) => d.id), 100, 200);
  assert.equal(copies.length, 3); assert.equal(new Set(model.decorations().map((d) => d.id)).size, 6);
  const existing = model.decorations().length;
  model.duplicateNodes([oldNode.id]);
  assert.equal(model.decorations().length, existing, 'default graph duplication must preserve decorations');
  const session = createResearchPageSession({ createModel: (state) => createResearchModel(state, registry),
    document: { pages: [{ id: 'first' }, { id: 'second', decorations: [line('persist')] }], activePageId: 'second' } });
  assert.equal(session.canDeleteActivePage(), false);
  const serialized = session.toDocument();
  assert.equal(serialized.pages[1].decorations.length, 1);
  assert(validateResearchDocument(serialized, registry).ok);
  const corrupt = structuredClone(serialized); corrupt.pages[1].decorations[0].direction = 8;
  assert.equal(validateResearchDocument(corrupt, registry).ok, false);
  console.log('research orthogonal geometry/model regression passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('assert');
const Scenes = require('../assets/canvas-scenes.js');

const camera = { centerX: 1200, centerY: 680, scale: 0.85 };
const fixed = Scenes.createScene({
  id: 'scene-fixed',
  title: '研究框架',
  kind: 'camera',
  camera,
}, '2026-07-28T00:00:00.000Z');

assert.strictEqual(fixed.id, 'scene-fixed');
assert.strictEqual(fixed.kind, 'camera');
assert.deepStrictEqual(fixed.camera, camera);
assert.strictEqual(Object.prototype.hasOwnProperty.call(fixed, 'anchorNodeIds'), false);
assert.strictEqual(fixed.createdAt, '2026-07-28T00:00:00.000Z');

const following = Scenes.createScene({
  id: 'scene-follow',
  title: '核心结论',
  kind: 'selection',
  camera: { centerX: -10, centerY: 20, scale: 100 },
  anchorNodeIds: ['node-a', 'node-a', '', 'node-b'],
  anchorGroupIds: ['group-a', 'group-a'],
}, '2026-07-28T00:01:00.000Z');

assert.strictEqual(following.kind, 'selection');
assert.strictEqual(following.camera.scale, Scenes.MAX_SCALE);
assert.deepStrictEqual(following.anchorNodeIds, ['node-a', 'node-b']);
assert.deepStrictEqual(following.anchorGroupIds, ['group-a']);

const normalized = Scenes.normalizeBook({
  version: 99,
  scenes: [
    fixed,
    Object.assign({}, following, { id: 'scene-fixed' }),
    null,
    { id: '', title: '', kind: 'unknown', camera: { scale: 0 } },
  ],
});
assert.strictEqual(normalized.version, 1);
assert.strictEqual(normalized.scenes.length, 3);
assert.strictEqual(new Set(normalized.scenes.map((scene) => scene.id)).size, 3);
assert.strictEqual(normalized.scenes[2].kind, 'camera');
assert.strictEqual(normalized.scenes[2].camera.scale, Scenes.MIN_SCALE);
assert(normalized.scenes[2].title);

const updated = Scenes.updateScene(following, {
  title: '新标题',
  anchorNodeIds: ['node-c'],
}, '2026-07-28T00:02:00.000Z');
assert.strictEqual(updated.id, following.id);
assert.strictEqual(updated.createdAt, following.createdAt);
assert.strictEqual(updated.updatedAt, '2026-07-28T00:02:00.000Z');
assert.deepStrictEqual(updated.anchorNodeIds, ['node-c']);

const third = Scenes.createScene({
  id: 'scene-third',
  title: '第三幕',
  kind: 'camera',
  camera: { centerX: 0, centerY: 0, scale: 1 },
}, '2026-07-28T00:03:00.000Z');
const book = { version: 1, scenes: [fixed, following, third] };
const reordered = Scenes.reorderScenes(book, [third.id, fixed.id, 'missing']);
assert.deepStrictEqual(
  reordered.scenes.map((scene) => scene.id),
  [third.id, fixed.id, following.id],
);
assert.deepStrictEqual(
  book.scenes.map((scene) => scene.id),
  [fixed.id, following.id, third.id],
  'sorting must not mutate its input book',
);

const removed = Scenes.removeScene(reordered, fixed.id);
assert.deepStrictEqual(
  removed.scenes.map((scene) => scene.id),
  [third.id, following.id],
);

const cleaned = Scenes.cleanMissingReferences(
  { version: 1, scenes: [fixed, following] },
  new Set(['node-b']),
  new Set(),
);
assert.strictEqual(cleaned.scenes[0].kind, 'camera');
assert.deepStrictEqual(cleaned.scenes[1].anchorNodeIds, ['node-b']);
assert.deepStrictEqual(cleaned.scenes[1].anchorGroupIds, []);
assert.deepStrictEqual(following.anchorNodeIds, ['node-a', 'node-b']);

console.log('canvas scenes regression tests passed');

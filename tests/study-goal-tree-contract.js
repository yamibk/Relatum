'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = process.cwd();
const GoalTree = require(path.join(root, 'assets', 'study-goal-tree.js'));
const read = (name) => fs.readFileSync(path.join(root, 'assets', name), 'utf8');

const html = read('index.html');
const route = read('study-route.js');
const study = read('study.js');
const styles = read('styles.css');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

[
  'data-role="study-route-overlay"',
  'data-role="study-route-viewport"',
  'data-role="study-route-summary"',
  'data-role="study-route-popover"',
  'study-route.js',
].forEach((needle) => assert(html.includes(needle), 'missing route markup: ' + needle));
[
  'data-role="study-goal-tree-detail"',
  'data-role="study-goal-tree-select"',
  'study-goal-tree-archives',
  'study-goal-tree-new',
].forEach((needle) => assert(!html.includes(needle), 'obsolete panel control remains: ' + needle));
[
  'data-route-action="complete"',
  'data-route-action="progress"',
  'data-route-action="settings"',
  'data-route-pop="new-task"',
  'data-route-pop="attach-task"',
  "command: 'detach-task'",
  "command: 'delete-branch'",
  "command: 'move-node'",
  'function syncProgress(taskId)',
  'function animateLayout(previous, next, duration, excluded)',
  'function positionDraggedSubtree(clientX, clientY)',
  'function updateDragCandidate(clientX, clientY)',
  'GoalTree.previewMove',
  'GoalTree.prepareDropContext',
  'GoalTree.structureDropCandidate',
  'candidate.taskSlot',
  'candidate.side',
  'function tickView(timestamp)',
  'setZoom(viewTarget.zoom * Math.exp(-event.deltaY * .00115)',
  'window.StudyRoute',
  'routeRequestId',
  "overlay.classList.add('is-closing')",
  "popover.classList.add('is-closing')",
  "confirmBox.classList.add('is-closing')",
].forEach((needle) => assert(route.includes(needle), 'missing route behavior: ' + needle));
assert(!route.includes('drag.previewTree') && !route.includes('drag.previewLayout'),
  'dragging must not live-sort or relayout the route');
const candidateSource = route.slice(route.indexOf('function updateDragCandidate'), route.indexOf('function flushDragFrame'));
assert(!candidateSource.includes('animateLayout') && !candidateSource.includes('GoalTree.previewMove'),
  'candidate updates must only update the frozen-layout hint');
assert(!route.includes('set-focus') && !route.includes('archive-tree'),
  'removed focus and tree archive behavior must stay removed');
[
  '.study-route-panel',
  '.study-route-node.is-task',
  '.study-route-node.is-milestone',
  '.study-route-milestone-dot',
  '.study-route-task-check.is-ready',
  '.study-route-node.is-drag-anchor',
  '.study-route-drop-slot',
  '.study-route-reparent-badge',
  '.study-route-popover',
  '.study-route-popover.is-visible',
  '.study-route-confirm.is-visible',
  '.study-route-overlay.is-closing',
  'body.start-page[data-start-theme="dark"] .study-route-panel',
  '@media (max-width: 700px)',
  '@media (prefers-reduced-motion: reduce)',
].forEach((needle) => assert(styles.includes(needle), 'missing route style: ' + needle));
const routeStyles = styles.slice(styles.indexOf('.study-route-overlay'), styles.indexOf('/* /'));
assert(!routeStyles.includes('backdrop-filter'), 'route must not run persistent backdrop blur');
assert(!routeStyles.includes('infinite'), 'route must not use infinite animation');
assert(routeStyles.includes('background: #fff;'), 'light route surfaces must remain pure white');
assert(routeStyles.includes('border-bottom: 0;'), 'route header divider must stay removed');
assert(routeStyles.includes('width 520ms cubic-bezier(.22,1,.36,1)'),
  'route progress bars must retain forward/reverse easing');
assert(routeStyles.includes('will-change: transform'), 'active drag must bypass CSS lag');

[
  '"version": 5',
  '"goalTree": tree',
  'def _study_goal_normalize_tree',
  'def apply_study_goal_tree_command',
  'if command == "rename-root"',
  'elif command == "delete-branch"',
  'elif command == "move-node"',
].forEach((needle) => assert(backend.includes(needle), 'missing v5 backend contract: ' + needle));
assert(!backend.includes('if parsed.path == "/api/study-goal-tree-archive"'),
  'goal-tree archive route must be removed');
assert(study.includes('state.goalTree = payload.goalTree'),
  'learning page must retain the singular goalTree payload');

const tasks = [
  { id: 'a', title: 'A', status: 'active', progress: { current: 2, target: 4, milestones: [{ id: 'm2', name: 'Half', at: 2 }] } },
  { id: 'b', title: 'B', status: 'done', progress: { current: 0, target: 0 } },
];
const tree = {
  version: 1,
  title: 'Route',
  nodes: [
    { id: 'branch', kind: 'branch', parentId: null, order: 0, side: 'right', title: 'Foundation' },
    { id: 'nested', kind: 'branch', parentId: 'branch', order: 0, title: 'Nested' },
    { id: 'task-a', kind: 'task', parentId: 'nested', order: 0, taskId: 'a' },
    { id: 'task-b', kind: 'task', parentId: 'branch', order: 1, taskId: 'b' },
  ],
};
const model = GoalTree.buildModel(tree, tasks);
assert.strictEqual(model.rootMetrics.count, 2);
assert.strictEqual(model.metrics.get('nested').progress, .5);
assert.strictEqual(model.rootMetrics.progress, .75);
assert.strictEqual(GoalTree.taskOwner(tree, 'a').node.id, 'task-a');
assert(GoalTree.canMove(tree, 'task-b', 'nested'));
assert(GoalTree.canMove(tree, 'task-b', 'task-a'), 'tasks can follow tasks');
assert(!GoalTree.canMove(tree, 'branch', 'task-a'), 'branches cannot be children of tasks');
assert(!GoalTree.canMove(tree, 'branch', 'nested'), 'a branch cannot move into its own subtree');

const laidOut = GoalTree.layout(tree, tasks);
const byId = new Map(laidOut.nodes.map((node) => [node.id, node]));
assert(byId.get('root').x < byId.get('branch').x);
assert(byId.get('branch').x < byId.get('nested').x);
assert(byId.get('nested').x < byId.get('task-a').x);
const milestoneId = GoalTree.milestonePlacementId('task-a', 'm2');
assert(byId.has(milestoneId), 'task milestones must render as route points');
assert.strictEqual(laidOut.edges.length, 5);

const moved = GoalTree.previewMove(tree, 'task-b', 'nested', 'task-a');
assert(moved, 'valid moves should produce an optimistic preview tree');
assert.deepStrictEqual(
  moved.nodes.filter((node) => node.parentId === 'nested').sort((a, b) => a.order - b.order).map((node) => node.id),
  ['task-b', 'task-a'],
  'preview move must preserve beforeId ordering',
);
assert.strictEqual(GoalTree.previewMove(tree, 'branch', 'nested', ''), null,
  'preview move must reject subtree cycles');

const nestedPlacement = byId.get('nested');
const reparent = GoalTree.structureDropCandidate(
  laidOut, tree, 'task-b',
  { x: nestedPlacement.x + nestedPlacement.width * .8, y: nestedPlacement.y },
  { targetId: 'nested', context: GoalTree.prepareDropContext(laidOut, tree, 'task-b') },
);
assert.strictEqual(reparent.type, 'reparent');
assert.strictEqual(reparent.parentId, 'nested');

const taskAPlacement = byId.get('task-a');
const chainCandidate = GoalTree.structureDropCandidate(
  laidOut, tree, 'task-b',
  { x: taskAPlacement.x + taskAPlacement.width * .8, y: taskAPlacement.y },
  { targetId: 'task-a', context: GoalTree.prepareDropContext(laidOut, tree, 'task-b') },
);
assert.strictEqual(chainCandidate.type, 'reparent');
assert.strictEqual(chainCandidate.parentId, 'task-a');
assert.deepStrictEqual(chainCandidate.taskSlot, { kind: 'end' });
const chained = GoalTree.previewMove(tree, 'task-b', 'task-a', '', chainCandidate.taskSlot);
assert.strictEqual(chained.nodes.find((node) => node.id === 'task-b').parentId, 'task-a');

const milestoneCandidate = GoalTree.structureDropCandidate(
  laidOut, tree, 'task-b', { x: byId.get(milestoneId).x, y: byId.get(milestoneId).y },
  { targetId: milestoneId, context: GoalTree.prepareDropContext(laidOut, tree, 'task-b') },
);
assert.deepStrictEqual(milestoneCandidate.taskSlot, { kind: 'milestone', milestoneId: 'm2' });

const bothSides = GoalTree.normalizeTree({ version: 1, title: 'Both sides', nodes: [
  { id: 'left', kind: 'branch', parentId: null, order: 0, side: 'left', title: 'Left' },
  { id: 'right', kind: 'branch', parentId: null, order: 0, side: 'right', title: 'Right' },
] }, tasks);
const bothLayout = GoalTree.layout(bothSides, tasks);
const bothById = new Map(bothLayout.nodes.map((node) => [node.id, node]));
assert(bothById.get('left').x + bothById.get('left').width < bothById.get('root').x,
  'left root branches must stay to the left of the root');
assert(bothById.get('right').x > bothById.get('root').x + bothById.get('root').width,
  'right root branches must stay to the right of the root');

const orderTasks = tasks.concat([{ id: 'c', title: 'C', status: 'active', progress: {} }]);
const orderTree = {
  version: 1, title: 'Order', nodes: [
    { id: 'order-branch', kind: 'branch', parentId: null, order: 0, title: 'Branch' },
    { id: 'order-a', kind: 'task', parentId: 'order-branch', order: 0, taskId: 'a' },
    { id: 'order-b', kind: 'task', parentId: 'order-branch', order: 1, taskId: 'b' },
    { id: 'order-c', kind: 'task', parentId: 'order-branch', order: 2, taskId: 'c' },
  ],
};
const orderLayout = GoalTree.layout(orderTree, orderTasks);
const orderById = new Map(orderLayout.nodes.map((node) => [node.id, node]));
const orderContext = GoalTree.prepareDropContext(orderLayout, orderTree, 'order-b');
const upward = GoalTree.structureDropCandidate(orderLayout, orderTree, 'order-b', {
  x: orderById.get('order-a').x,
  y: orderById.get('order-a').y - 1,
}, { targetId: '', context: orderContext, rowGap: 30, levelGap: 92 });
assert.strictEqual(upward.type, 'insert');
assert.strictEqual(upward.beforeId, 'order-a', 'dragging upward must insert before the first sibling');
const downward = GoalTree.structureDropCandidate(orderLayout, orderTree, 'order-b', {
  x: orderById.get('order-c').x,
  y: orderById.get('order-c').y + 1,
}, { targetId: '', context: orderContext, rowGap: 30, levelGap: 92 });
assert.strictEqual(downward.type, 'insert');
assert.strictEqual(downward.beforeId, '', 'dragging downward must append after the last sibling');
assert(upward.slotCoord < downward.slotCoord, 'the guide must work in both vertical directions');

const malformed = GoalTree.normalizeTree({
  title: 'Bad data',
  nodes: [
    { id: 'task', kind: 'task', taskId: 'a', parentId: null },
    { id: 'task-duplicate', kind: 'task', taskId: 'a', parentId: null },
    { id: 'archive', kind: 'archive', title: 'Legacy snapshot' },
    { id: 'child', kind: 'branch', parentId: 'task', title: 'Invalid branch parent' },
  ],
}, tasks);
assert.strictEqual(malformed.nodes.length, 2);
assert.strictEqual(malformed.nodes.find((node) => node.id === 'child').parentId, null);
assert(!malformed.nodes.some((node) => node.kind === 'archive'));

console.log('study goal-tree v3 contract: ok');

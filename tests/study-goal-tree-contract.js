'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = process.cwd();
const GoalTree = require(path.join(root, 'assets', 'study-goal-tree.js'));
const readAsset = (name) => fs.readFileSync(path.join(root, 'assets', name), 'utf8');

const html = readAsset('index.html');
const route = readAsset('study-route.js');
const styles = readAsset('styles.css');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

[
  'data-role="study-route-overlay"',
  'data-role="study-route-viewport"',
  'data-role="study-route-summary"',
  'data-role="study-route-popover"',
  'data-role="study-route-rail"',
  'data-role="study-route-guide"',
  'data-role="goal-tree-simple-toggle"',
  'data-action="study-goal-tree-help"',
].forEach((needle) => assert(html.includes(needle), 'missing route markup: ' + needle));

[
  "data-route-pop=\"new-stage\"",
  "data-route-pop=\"requirements\"",
  "command: 'add-requirement'",
  "command: 'remove-requirement'",
  "command: 'clear-primary-requirement'",
  'canvas:studyGoalTreeSimpleMode:v1',
  "anchor.dataset.kind !== 'task' || !simpleModeEnabled()",
  'progressBreakdownPopover',
  'study-route-branch-meta-row',
  "popover.querySelector('.study-route-progress-detail')",
  "popover.querySelector('form[data-route-form=\"settings\"]')",
  'blockersPopover',
  'goalTreeId: state.activeTreeId',
  "command: 'move-node', nodeId: current.nodeId, primaryLink:",
  'GoalTree.nextTasks',
  'collapsedIds: Array.from(collapsedIds)',
  "dataset.routeAction = 'next-task'",
  'function transitionFill',
  'oldFillPercent',
  'transitionTaskCheck',
  '&& !isComplete && !isBlocked',
  'function syncStudyCacheFromState()',
  'function focusRequestedTask(requestId, taskId)',
  'function applyStudyPayload(json, requestId, taskId, requestedTreeId)',
  'switchTree(requestedTree.id).then(function ()',
  'var routeReturnFocus = null',
  'returnFocus.focus({ preventScroll: true })',
  "closeRoute(false)",
  'shared !== studyCache',
  'function beginTreeSwitchMotion',
  'var TREE_SWITCH_OUT_MS = 80',
  'function toggleBranchCollapse(nodeId)',
  "classList.add('is-collapsing')",
  'window.setTimeout(finishCollapseMotion, 190)',
  "element.classList.remove('is-entering', 'is-expanding')",
  'newNodesAtDestination',
  'function setCollapseControlExpanded(nodeId, expanded)',
  "title: '一分钟开始使用'",
  "title: '下一步做什么'",
  "title: '阶段与进度'",
  "title: '箭头、解锁与高级编辑'",
  "document.querySelectorAll('[data-action=\"study-goal-tree-help\"]')",
  'help: function (trigger)',
  'expandingControlIds: new Set([nodeId])',
  'revealingHiddenCountIds: new Set([motion.nodeId])',
  'hidingHiddenCountById: hidingHiddenCountById',
].forEach((needle) => assert(route.includes(needle), 'missing V4 route contract: ' + needle));
const guideTitles = ['一分钟开始使用', '下一步做什么', '阶段与进度', '箭头、解锁与高级编辑'];
guideTitles.slice(1).forEach((title, index) => {
  assert(route.indexOf(guideTitles[index]) < route.indexOf(title), 'guide must put core actions before advanced concepts');
});
const openRouteSection = route.slice(route.indexOf('function openRoute('), route.indexOf('function closeRoute('));
assert(openRouteSection.indexOf('var epoch = treeEpoch;') < openRouteSection.indexOf('applyStudyPayload(studyCache'),
  'opening a requested tree must invalidate the background snapshot captured before its switch starts');
const resizeViewSection = route.slice(route.indexOf('function preserveViewOnResize()'), route.indexOf('function edgePath('));
assert(resizeViewSection.includes('deltaX = (next.width - viewportSize.width) / 2')
  && resizeViewSection.includes('deltaY = (next.height - viewportSize.height) / 2')
  && resizeViewSection.includes('view.x += deltaX')
  && resizeViewSection.includes('viewTarget.x += deltaX')
  && resizeViewSection.includes('saveViewSoon()')
  && !resizeViewSection.includes('fit('),
  'resizing the route viewport must preserve its visual center and zoom instead of fitting the whole tree');
assert(route.includes("window.addEventListener('resize', preserveViewOnResize)"),
  'the route resize handler must use center-preserving camera adjustment');

[
  '.study-route-edge.is-requires',
  '.study-route-edge.is-requires.is-secondary',
  '.study-route-node.is-ready',
  '.study-route-node.is-unlocking',
  'transition: width 520ms',
  '.study-route-next',
  '.study-route-requirements',
  '.study-route-progress-detail',
  '.study-route-guide',
  '.study-goal-tree-help',
  '.study-goal-tree-help.is-list-view',
  '.study-route-node.is-collapsing',
  '.study-route-edge.is-collapsing',
  '.study-route-node.is-expanding',
  '@keyframes studyRouteNodeExpand',
  '@keyframes studyRouteCollapseIconExpand',
  '@keyframes studyRouteHiddenCountIn',
  '@keyframes studyRouteHiddenCountOut',
  '@media (prefers-reduced-motion: reduce)',
].forEach((needle) => assert(styles.includes(needle), 'missing V4 style contract: ' + needle));

[
  '"version": 6',
  'raw_tree.get("version") != 2',
  'STUDY_GOAL_TREE_LINKS_MAX = 6000',
  'elif command == "add-requirement"',
  'elif command == "remove-requirement"',
  'elif command == "clear-primary-requirement"',
  '_study_goal_assert_task_available',
  '学习数据版本不兼容',
].forEach((needle) => assert(backend.includes(needle), 'missing V6 backend contract: ' + needle));

const tasks = [
  { id: 'a', title: 'A', status: 'active', progress: { current: 5, target: 10, milestones: [{ id: 'half', name: '一半', at: 5 }] } },
  { id: 'b', title: 'B', status: 'active', progress: { current: 0, target: 0, milestones: [] } },
  { id: 'c', title: 'C', status: 'active', progress: { current: 0, target: 0, milestones: [] } },
];
const tree = {
  version: 2, id: 'tree', title: '路线',
  nodes: [
    { id: 'na', kind: 'task', taskId: 'a' },
    { id: 'stage', kind: 'branch', title: '阶段' },
    { id: 'nb', kind: 'task', taskId: 'b' },
    { id: 'nc', kind: 'task', taskId: 'c' },
  ],
  links: [
    { id: 'l1', from: null, to: 'na', type: 'contains', primary: true, order: 0, side: 'right' },
    { id: 'l2', from: 'na', to: 'stage', type: 'requires', primary: true, order: 0, trigger: { kind: 'milestone', milestoneId: 'half' } },
    { id: 'l3', from: 'stage', to: 'nb', type: 'contains', primary: true, order: 0 },
    { id: 'l4', from: 'stage', to: 'nc', type: 'contains', primary: true, order: 1 },
    { id: 'l5', from: 'na', to: 'nc', type: 'requires', primary: false, trigger: { kind: 'complete' } },
  ],
};

let model = GoalTree.buildModel(tree, tasks);
assert.strictEqual(model.availability.get('stage').available, true, 'milestone should unlock following stage');
assert.strictEqual(model.availability.get('nb').available, true, 'contained task inherits available stage');
assert.strictEqual(model.availability.get('nc').available, false, 'all inbound requirements must be satisfied');
assert.strictEqual(model.availability.get('nc').reasons.length, 1);
assert.strictEqual(model.metrics.get('stage').count, 2, 'stage only aggregates contained tasks');
assert.strictEqual(model.rootMetrics.count, 3, 'root counts unique route tasks');
const stageProgress = GoalTree.progressBreakdown(model, 'stage');
assert.strictEqual(stageProgress.percent, 0, 'both contained tasks begin at zero');
const mixedTasks = tasks.map((task) => task.id === 'b' ? { ...task, progress: { current: 5, target: 10, milestones: [] } } : task);
const mixedModel = GoalTree.buildModel(tree, mixedTasks);
assert.strictEqual(GoalTree.progressBreakdown(mixedModel, 'stage').percent, 25, '50% and 0% must average to 25%');
assert.strictEqual(GoalTree.progressBreakdown(mixedModel, 'root').percent, 33, 'root includes all unique route tasks');
const fourTasks = mixedTasks.concat({ id: 'd', title: 'D', status: 'active', progress: { current: 0, target: 0, milestones: [] } });
const fourTree = { ...tree, nodes: tree.nodes.concat({ id: 'nd', kind: 'task', taskId: 'd' }), links: tree.links.concat({ id: 'l6', from: null, to: 'nd', type: 'contains', primary: true, order: 2, side: 'right' }) };
assert.strictEqual(GoalTree.progressBreakdown(GoalTree.buildModel(fourTree, fourTasks), 'root').percent, 25);
const oneHalfFourTasks = fourTasks.map((task) => task.id === 'a' ? { ...task, progress: { current: 0, target: 0, milestones: [] } } : task);
assert.strictEqual(GoalTree.progressBreakdown(GoalTree.buildModel(fourTree, oneHalfFourTasks), 'root').percent, 13, '12.5% displays as 13%');
assert.strictEqual(GoalTree.requirementCount(model, 'nc'), 1);
assert.strictEqual(GoalTree.canAddRequirement(model, 'na', 'nc', { kind: 'complete' }), false, 'semantic duplicate must be hidden');
assert.strictEqual(GoalTree.canAddRequirement(model, 'nc', 'na', { kind: 'complete' }), false, 'cycle candidate must be hidden');

const completeTasks = tasks.map((task) => task.id === 'a' ? { ...task, status: 'done' } : task);
model = GoalTree.buildModel(tree, completeTasks);
assert.strictEqual(model.availability.get('nc').available, true, 'second prerequisite should unlock after completion');

const expanded = GoalTree.layout(tree, tasks);
const collapsed = GoalTree.layout(tree, tasks, { collapsedIds: new Set(['stage']) });
assert(expanded.nodes.some((node) => node.id === 'nb'));
assert(!collapsed.nodes.some((node) => node.id === 'nb'));
assert.strictEqual(collapsed.nodes.find((node) => node.id === 'stage').hiddenCount, 2);
assert(collapsed.edges.every((edge) => edge.from !== 'stage' || edge.to !== 'nb'));

const withoutSecondary = { ...tree, links: tree.links.filter((link) => link.primary) };
const basePositions = new Map(GoalTree.layout(withoutSecondary, tasks).nodes.map((node) => [node.id, [node.x, node.y]]));
GoalTree.layout(tree, tasks).nodes.forEach((node) => {
  assert.deepStrictEqual([node.x, node.y], basePositions.get(node.id), 'secondary dependency must not affect layout');
});

const layout = GoalTree.layout(tree, tasks);
const context = GoalTree.prepareDropContext(layout, tree, 'nb');
const taskPlacement = layout.nodes.find((node) => node.id === 'na');
const taskDrop = GoalTree.structureDropCandidate(layout, tree, 'nb', { x: taskPlacement.x, y: taskPlacement.y }, { targetId: 'na', context });
assert.strictEqual(taskDrop.primaryLink.type, 'requires');
assert.strictEqual(taskDrop.primaryLink.trigger.kind, 'complete');
const milestoneId = GoalTree.milestonePlacementId('na', 'half');
const milestonePlacement = layout.nodes.find((node) => node.id === milestoneId);
const pointDrop = GoalTree.structureDropCandidate(layout, tree, 'nb', { x: milestonePlacement.x, y: milestonePlacement.y }, { targetId: milestoneId, context });
assert.strictEqual(pointDrop.primaryLink.trigger.kind, 'milestone');
assert.strictEqual(pointDrop.primaryLink.trigger.milestoneId, 'half');

const next = GoalTree.nextTasks(model);
assert(next.every((node) => model.availability.get(node.id).available));

console.log('study goal tree V4 contract ok');

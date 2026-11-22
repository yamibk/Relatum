'use strict';

const assert = require('assert');
const GoalTree = require('../assets/study-goal-tree.js');

const tasks = [
  { id: 'a', title: '先做', status: 'done', progress: { current: 1, target: 1, milestones: [] } },
  { id: 'b', title: '后做', status: 'active', progress: { current: 1, target: 4, milestones: [] } },
];
const tree = {
  version: 2, id: 'goal_tree', title: '树',
  nodes: [
    { id: 'stage', kind: 'branch', title: '阶段' },
    { id: 'na', kind: 'task', taskId: 'a' },
    { id: 'nb', kind: 'task', taskId: 'b' },
  ],
  links: [
    { id: 'l1', from: null, to: 'stage', type: 'contains', primary: true, order: 0, side: 'left' },
    { id: 'l2', from: 'stage', to: 'na', type: 'contains', primary: true, order: 0 },
    { id: 'l3', from: 'na', to: 'nb', type: 'requires', primary: true, order: 0, trigger: { kind: 'complete' } },
  ],
};

const blankTitleTree = Object.assign({}, tree, { title: '' });
assert.strictEqual(GoalTree.normalizeTree(blankTitleTree, tasks).title, '我的学习路线',
  'shared Study normalization must keep its non-empty fallback');
assert.strictEqual(GoalTree.normalizeTree(blankTitleTree, tasks, { allowBlankTitle: true }).title, '',
  'Tree page normalization must preserve an intentionally blank root title');
assert.strictEqual(GoalTree.buildModel(blankTitleTree, tasks, { allowBlankTitle: true }).tree.title, '',
  'Tree page model construction must not reintroduce the shared Study fallback');

const model = GoalTree.buildModel(tree, tasks);
assert(model.byId.has('stage') && model.byId.has('nb'));
assert.strictEqual(model.metrics.get('stage').count, 2, 'tree page stage recursively aggregates primary descendant tasks');
assert.strictEqual(GoalTree.progressBreakdown(model, 'stage').percent, 63, 'done plus 25% task rounds to 63%');
assert.strictEqual(GoalTree.progressBreakdown(model, 'stage').rows.length, 2, 'tree page detail uses the same recursive scope');
assert.strictEqual(model.availability.get('nb').available, true, 'completed prerequisite unlocks target');
const layout = GoalTree.layout(tree, tasks, { collapsedIds: new Set() });
assert(layout.nodes.find((node) => node.id === 'stage').x < layout.nodes.find((node) => node.id === 'root').x);
assert(GoalTree.prepareDropContext(layout, tree, 'stage').structuralExcluded.has('na'));
assert.strictEqual(GoalTree.nextTasks(model)[0].id, 'nb');

const scopedTasks = tasks.concat(
  { id: 'c', title: '后续阶段任务', status: 'active' },
  { id: 'd', title: '解锁后任务', status: 'active' },
);
const scopedTree = structuredClone(tree);
scopedTree.nodes.push(
  { id: 'next', kind: 'branch', title: '下一阶段', independentProgress: true },
  { id: 'nested', kind: 'branch', title: '独立子阶段', independentProgress: true },
  { id: 'nc', kind: 'task', taskId: 'c' },
  { id: 'nd', kind: 'task', taskId: 'd' },
);
scopedTree.links[2].to = 'next';
scopedTree.links.push(
  { id: 'l4', from: 'next', to: 'nb', type: 'contains', primary: true },
  { id: 'l5', from: 'next', to: 'nested', type: 'contains', primary: true },
  { id: 'l6', from: 'nested', to: 'nc', type: 'contains', primary: true },
  { id: 'l7', from: null, to: 'nd', type: 'contains', primary: true },
  { id: 'l8', from: 'stage', to: 'nd', type: 'requires', primary: false, trigger: { kind: 'complete' } },
);
const independent = GoalTree.buildModel(scopedTree, scopedTasks, { independentProgress: true });
const countedTasks = (model, id) => GoalTree.progressBreakdown(model, id).rows.map(row => row.taskId);
assert.deepStrictEqual(countedTasks(independent, 'root'), ['a', 'd']);
assert.deepStrictEqual(countedTasks(independent, 'stage'), ['a']);
assert.deepStrictEqual(countedTasks(independent, 'next'), ['b']);
assert.deepStrictEqual(countedTasks(independent, 'nested'), ['c']);
assert.strictEqual(independent.rootMetrics.progress, .5);
assert.strictEqual(independent.metrics.get('next').progress, .25);
assert.strictEqual(independent.availability.get('nd').available, true, 'stage unlock uses its new scope');
const study = GoalTree.buildModel(scopedTree, scopedTasks);
assert.deepStrictEqual(countedTasks(study, 'root'), ['a', 'b', 'c', 'd']);
assert.strictEqual(study.availability.get('nd').available, false);
const unfinished = scopedTasks.map(task => task.id === 'a' ? { ...task, status: 'active' } : task);
const locked = GoalTree.buildModel(scopedTree, unfinished, { independentProgress: true });
assert.strictEqual(locked.availability.get('nb').available, false, 'incoming requirement still gates the stage');
assert.strictEqual(locked.availability.get('nc').available, false, 'nested stages still inherit the requirement');

console.log('tree page shared goal-tree model contract passed');

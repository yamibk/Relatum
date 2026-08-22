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

console.log('tree page shared goal-tree model contract passed');

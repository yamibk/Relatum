'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'index.html'), 'utf8');
const start = fs.readFileSync(path.join(root, 'assets', 'start.js'), 'utf8');
const study = fs.readFileSync(path.join(root, 'assets', 'study.js'), 'utf8');

[
  'data-action="tree-page-view"',
  'data-role="tree-page-view"',
  'src="study-goal-tree.js"',
  'src="tree-page.js"',
].forEach((needle) => assert(html.includes(needle), 'missing tree page shell: ' + needle));
assert(!html.includes('src="tree-page-model.js"'), 'discarded generic model must not load');

const calendarTab = html.indexOf('data-action="calendar-view"');
const cadenceTab = html.indexOf('data-action="cadence-view"');
const notesTab = html.indexOf('data-action="notes-view"');
const treeTab = html.indexOf('data-action="tree-page-view"');
const studyTab = html.indexOf('data-action="study-view"', treeTab);
assert(calendarTab >= 0 && cadenceTab > calendarTab && notesTab > cadenceTab
  && treeTab > notesTab && studyTab > treeTab,
  'the spine must place Activity before Notes and Tree immediately after Notes');

assert(start.includes('const START_VIEW_ORDER = { review: 0, calendar: 1, cadence: 2, notes: 3, tree: 4, study: 5, focus: 6, recent: 7'),
  'tree page must occupy the fifth special-page position');
assert(start.includes('7 张前置页') && start.includes('if (specialPagesHidden)'),
  'Hide utility pages must skip all seven special pages');
assert(start.includes("if (delta > 0) setTreePageActive(true); // 速记 → 树状")
  && start.includes("else setNotesActive(true);             // 树状 → 速记")
  && start.includes("else setTreePageActive(true);          // 学习 → 树状"),
  'wheel navigation must place Notes immediately before Tree');
assert(start.includes("['tree', document.querySelector('.tree-page-embedded')]")
  && start.includes('element.inert = !active')
  && start.includes('window.CanvasTreePage.activate()')
  && start.includes('window.CanvasTreePage.deactivate()'),
  'Tree must participate in inert and lifecycle management');
assert(start.includes('e.clientX > spineRect.right + reach')
  && start.includes("bookView.addEventListener('wheel'"),
  'far-left wheel hot zone must remain available');
assert(study.includes('function scheduleActivityPreload()')
  && study.includes('window.requestIdleCallback(warmActivity, { timeout: 1500 })')
  && study.includes('scheduleActivityPreload();')
  && study.includes('awaitReady()'),
  'Activity must keep its idle data preload and share it with first entry');

console.log('start tree page contract passed');

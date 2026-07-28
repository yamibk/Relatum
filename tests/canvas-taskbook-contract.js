'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('assets/editor.html');
const editor = read('assets/editor.js');
const canvas = read('assets/canvas.js');
const styles = read('assets/styles.css');
const backend = read('app.py');
const study = read('assets/study.js');
const startPage = read('assets/start.js');
const agents = read('AGENTS.md');

assert(
  html.indexOf('<script src="canvas-taskbook.js" defer></script>')
    < html.indexOf('<script src="canvas.js" defer></script>'),
  'the zero-DOM Taskbook data layer must load before canvas.js',
);

const toolOrder = [
  'data-action="use-ruler"',
  'data-action="markdown-notebook"',
  'data-action="canvas-scenes"',
  'data-action="canvas-taskbook"',
  'data-action="import-canvas"',
  'data-action="node-matrix"',
  'data-action="canvas-timer"',
];
let previous = -1;
toolOrder.forEach((needle) => {
  const index = html.indexOf(needle);
  assert(index > previous, 'tool menu order is wrong at ' + needle);
  previous = index;
});

[
  'data-role="canvas-taskbook-dialog"',
  'data-action="taskbook-shortcut"',
  'data-role="taskbook-topbar-toggle"',
  'data-action="toggle-taskbook-help"',
  'data-role="taskbook-help"',
  'data-action="new-top-level-task"',
  'data-role="taskbook-active-list"',
  'data-role="taskbook-completed-list"',
  'data-role="task-root-dialog"',
  'data-role="task-root-tree"',
  'data-role="task-root-detail-form"',
  'data-action="toggle-task-root-task"',
  'data-action="archive-current-task-root"',
  'data-action="delete-current-task-root"',
  'data-role="taskbook-archive-snapshot"',
  'data-role="canvas-taskbook-confirm"',
  'data-role="task-root-confirm"',
].forEach((needle) => assert(html.includes(needle), 'missing Taskbook V3 UI hook: ' + needle));

[
  'data-action="add-root-task"',
  'data-role="task-root-tabs"',
  'data-action="task-root-tab"',
].forEach((needle) => assert(!html.includes(needle), 'removed Taskbook control remains: ' + needle));

[
  'global.CanvasModule.createTopLevelTask = createTopLevelTask',
  'global.CanvasModule.getTaskbookSnapshot = taskbookSnapshot',
  'global.CanvasModule.placeTaskRoot = placeTaskRoot',
  'global.CanvasModule.removeTaskRootProjection = removeTaskRootProjection',
  'global.CanvasModule.moveTaskbookTask = moveTaskbookTask',
  'global.CanvasModule.toggleTaskbookTask = toggleTaskbookTask',
  'global.CanvasModule.deleteTopLevelTask = deleteTopLevelTask',
  'global.CanvasModule.prepareTaskbookArchive = prepareTaskbookArchive',
  'global.CanvasModule.applyTaskbookArchive = applyTaskbookArchive',
  'global.CanvasModule.settleTaskbookForArchive = settleTaskbookForArchive',
].forEach((needle) => assert(canvas.includes(needle), 'missing CanvasModule Taskbook V3 API: ' + needle));

const start = editor.indexOf('(function setupTaskbookV3()');
const end = editor.indexOf('// ── 节点矩阵', start);
assert(start >= 0 && end > start, 'missing Taskbook V3 editor controller');
const controller = editor.slice(start, end);
assert(controller.includes("action.dataset.action = 'archive-task-root'"));
assert(controller.includes("remove.dataset.action = 'delete-task-root'"));
assert(controller.includes("case 'delete-task-root': if (rootId) showRootDeleteConfirm(rootId, 'library');"));
assert(controller.includes("const fromLibrary = source === 'library';"));
assert(controller.includes("case 'archive-current-task-root': showArchiveConfirm(activeRootId, 'manager');"));
assert(controller.includes("const fromManager = source === 'manager';"));
assert(controller.includes('if (fromManager) closeManager(true);'));
assert(controller.includes("row.className = 'task-root-tree-row'"));
assert(controller.includes("add.className = 'task-root-tree-add'"));
assert(controller.includes("remove.className = 'task-root-tree-remove'"));
assert(controller.includes("event.key === 'Enter'"));
assert(controller.includes("event.key !== 'Tab'"));
assert(controller.includes("event.key === 'Escape'"));
assert(controller.includes('setLibraryHelpOpen(false, true)'));
assert(controller.includes("case 'toggle-taskbook-help':"));
assert(controller.includes("event.key === 'f' || event.key === 'F'"));
assert(controller.includes("layer.classList.add('open')"));
assert(controller.includes("layer.classList.remove('open')"));
assert(controller.includes('function closeConfirm(layer)'));
assert(controller.includes('canvas:taskbookTopbarShortcut'));
assert(controller.includes('syncTaskbookTopbarShortcut(taskbookTopbarShortcutEnabled())'));
assert(controller.includes("fetch('/api/taskbook-archive'"));
assert(controller.includes('canvas:taskbookArchiveSnapshotEnabled'));
assert(controller.includes('focusViewport()'));
assert(!controller.includes("addEventListener('pointerdown'"));
assert(!controller.includes('Math.hypot('));
assert(!controller.includes('taskbook-root-drag-ghost'));
assert(!controller.includes('task-root-tree-ghost'));
assert(!controller.includes('flipRows('));
assert(!controller.includes('DataTransfer'));
assert(!controller.includes('.draggable ='));
assert(!controller.includes("addEventListener('drop'"));
assert(!editor.includes('setupCanvasTaskbook'));
assert(!editor.includes('setupTaskbookV2'));
assert(!editor.includes("fetch('/api/taskbook-complete'"));
assert(!editor.includes('beginLibraryDrag'));
assert(!editor.includes('beginTreeDrag'));
assert(!editor.includes('canvas:showNodeChecklists'));
assert(!editor.includes('canvas:checklistDelay'));
assert(!editor.includes('setupChecklistDelay'));

assert(canvas.includes("control.className = 'taskbook-task-hover-control'"));
assert(canvas.includes("button.className = 'taskbook-task-hover-toggle'"));
assert(canvas.includes('data-taskbook-action="complete"'));
assert(canvas.includes('updateTaskbook(node.taskRootId, { completed: !model.completed })'));
assert(canvas.includes("el.classList.toggle('taskbook-standalone-root', standalone)"));
assert(canvas.includes('!Array.isArray(root.members) || root.members.length === 0'));
assert(canvas.includes("el.classList.toggle('archive-cover-node'"));
assert(canvas.includes('model.leaves.includes(node.id)'));
assert(canvas.includes('toggleTaskbookTask(currentRootId, node.id)'));
assert(canvas.includes('function buildTaskbookDeletionPlan('));
assert(canvas.includes('function executeTaskbookDeletionPlan('));
assert(canvas.includes('累计用时会保留在顶级任务中'));
assert(!canvas.includes('任务节点只能在任务管理页中删除'));
assert(!canvas.includes('function nodeChecklistArr('));
assert(!canvas.includes("className = 'node-checklist'"));
assert((canvas.match(/delete node\.checklist;/g) || []).length >= 2);

assert(!html.includes('data-role="show-node-checklists"'));
assert(!html.includes('data-role="checklist-delay"'));
assert(!html.includes('显示节点任务清单'));
assert(!startPage.includes('节点旁的任务清单'));
assert(!startPage.includes('任务清单出现延迟'));
assert(startPage.includes('任务簿节点计时'));

assert(styles.includes('.taskbook-library {'));
assert(styles.includes('.taskbook-help-toggle {'));
assert(styles.includes('.taskbook-help-card {'));
assert(styles.includes('.taskbook-help-card[hidden]'));
const finalTaskbookStyles = styles.slice(styles.lastIndexOf('任务簿 V3 最终级联'));
assert(finalTaskbookStyles.includes('width: min(1320px'));
assert(finalTaskbookStyles.includes('height: min(840px'));
assert(styles.includes('.task-root-manager {'));
assert(styles.includes('.task-root-tree-root'));
assert(styles.includes('.task-root-archive-root {'));
assert(styles.includes('.task-root-archive-root[hidden]'));
assert(styles.includes('::-webkit-scrollbar-button'));
assert(
  styles.lastIndexOf('任务簿 V3 最终级联') > styles.lastIndexOf('任务簿 V2：顶级任务库'),
  'the V3 sizing/layout contract must win the final CSS cascade',
);
const overlayRule = /\.taskbook-library-overlay,\s*\.task-root-overlay\s*\{([\s\S]*?)\}/.exec(styles);
assert(overlayRule && !/backdrop-filter/.test(overlayRule[1]));
assert(!styles.includes('.taskbook-root-drag-ghost'));
assert(!styles.includes('.task-root-tree-ghost'));
assert(!styles.includes('.taskbook-root-more'));
assert(!styles.includes('.task-root-tree-more'));
assert(styles.includes('.taskbook-task-hover-control {'));
assert(styles.includes('.taskbook-root-complete-toggle[aria-pressed="true"]'));
assert(styles.includes('right: calc(100% + 4px)'));
assert(styles.includes('.taskbook-root-complete-toggle::before'));
assert(styles.includes('.task-root-node:not(.taskbook-standalone-root) > .taskbook-root-complete-toggle'));
assert(styles.includes('.task-root-node.taskbook-standalone-root:hover > .taskbook-root-complete-toggle'));
assert(styles.includes('.task-root-node.taskbook-standalone-root.selected > .taskbook-root-complete-toggle'));
const legacyTaskbookNodeRule = styles.indexOf('.node.taskbook-node {');
const finalTaskRootNodeRule = styles.indexOf('\n.node.taskbook-node.task-root-node {', legacyTaskbookNodeRule);
assert(legacyTaskbookNodeRule >= 0 && finalTaskRootNodeRule > legacyTaskbookNodeRule);
assert(styles.slice(finalTaskRootNodeRule, styles.indexOf('}', finalTaskRootNodeRule)).includes('overflow: visible'));
assert(styles.includes('.taskbook-root-actions {'));
assert(styles.includes('.taskbook-root-delete {'));
assert(styles.includes('scrollbar-width: none'));
assert(styles.includes('.taskbook-library-body::-webkit-scrollbar'));
assert(styles.includes('.node[data-kind="card"].archive-cover-node {'));
assert(styles.includes('.node[data-kind="card"].archive-cover-node::before'));
assert(styles.includes('.node:hover > .taskbook-task-hover-control'));
assert(styles.includes('.taskbook-task-hover-control.running .taskbook-task-hover-toggle'));
assert(!styles.includes('.node-checklist'));
assert(!styles.includes('.checklist-item'));
assert(canvas.includes('Taskbooks.resolveConnectionBatch(data, fromIds, targetId, drag.fromId)'));

assert(backend.includes('"/api/taskbook-archive"'));
assert(backend.includes('def _api_taskbook_archive'));
assert(backend.includes('def archive_taskbook_canvas'));
assert(backend.includes('def _taskbook_archive_source_summary'));
assert(backend.includes('root_copy.get("archiveCover") is not True'));
assert(backend.includes('folder / "taskbook.json"'));
assert(backend.includes('CANVAS_AND_DATA_POST_ROUTES'));
assert(!backend.includes('"/api/taskbook-complete"'));
assert(study.includes("item.kind !== 'taskbook'"));
assert(study.includes('cadence-taskbook-meta'));

assert(!/\bTimebox\b|时间盒/i.test(html + editor + canvas + backend));
assert(agents.includes('`assets/canvas-taskbook.js`'));
assert(agents.includes('任务簿 / Taskbook'));
assert(agents.includes('父节点按整棵子树删除'));
assert(agents.includes('旧的普通节点悬停任务清单'));

console.log('canvas taskbook V3 interaction contract passed');

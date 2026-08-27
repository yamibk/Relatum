'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const readAsset = (name) => fs.readFileSync(path.join(root, 'assets', name), 'utf8');
const html = readAsset('index.html');
const route = readAsset('study-route.js');
const tree = readAsset('tree-page.js');
const css = readAsset('styles.css');

[
  'study-route-panel tree-page-route-panel', 'study-route-stage tree-page-route-stage',
  'data-role="study-route-viewport"', 'data-role="study-route-scene"',
  'data-role="study-route-edges"', 'data-role="study-route-nodes"',
  'data-role="study-route-rail"', 'data-role="rail-active-orb"',
  'data-role="study-route-popover"', 'data-role="study-route-confirm"',
  'data-role="study-route-guide"',
].forEach((needle) => assert(html.includes(needle), 'missing cloned goal-tree DOM: ' + needle));

assert(!html.includes('tree-page-head'), 'tree page must not render a visible title header');
assert(!html.includes('data-tree-action="next"'), 'tree page must not render a Next button');
assert(!html.includes('tree-page-model.js'), 'the discarded generic model must not load');

const dockStart = html.indexOf('<div class="tree-page-item-dock is-collapsed"');
const dockEnd = html.indexOf('<nav class="study-route-rail', dockStart);
assert(dockStart >= 0 && dockEnd > dockStart, 'missing initially collapsed Tree free-item toolbar');
const dockHtml = html.slice(dockStart, dockEnd);
assert.strictEqual((dockHtml.match(/data-tree-item-create=/g) || []).length, 2,
  'Tree free-item toolbar must expose only note and text creation');
assert(dockHtml.includes('data-tree-item-create="note"') && dockHtml.includes('data-tree-item-create="text"'),
  'Tree free-item toolbar must contain note and text buttons');
assert.strictEqual((dockHtml.match(/data-tree-item-tone=/g) || []).length, 10,
  'Tree free-item toolbar must contain exactly ten text tones');
assert(dockHtml.indexOf('data-tree-item-tone="black"') > dockHtml.indexOf('data-tree-item-tone="white"'),
  'Tree free-item toolbar must place black at the far right of the tone choices');
assert.deepStrictEqual(Array.from(dockHtml.matchAll(/data-tree-item-size="(\d+)"/g), (match) => Number(match[1])),
  [22, 34, 48, 64], 'Tree free-item toolbar must reuse the four Canvas text sizes');
assert.strictEqual((dockHtml.match(/data-tree-item-clear-empty/g) || []).length, 1,
  'Tree free-item toolbar must end with one blank-object cleanup action');
[
  'data-tree-item-bold', 'data-tree-item-align', 'data-tree-item-highlight',
  'data-tree-item-rotate', 'data-tree-item-layer', 'data-tree-item-link',
].forEach((needle) => assert(!dockHtml.includes(needle), 'extra Tree free-item control leaked in: ' + needle));
assert(html.includes('data-role="tree-page-free-items"') && html.includes('<script src="font-loader.js" defer></script>'),
  'Tree free items need their own scene layer and the shared lazy font loader');

function functionSource(source, name) {
  const start = source.indexOf('  function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1).trim();
  }
  throw new Error('unterminated function ' + name);
}

const declaredFunctions = (source) => new Set(
  Array.from(source.matchAll(/^  function ([A-Za-z0-9_]+)\(/gm), (match) => match[1]),
);
const routeFunctions = declaredFunctions(route);
const treeFunctions = declaredFunctions(tree);
routeFunctions.forEach((name) => {
  assert(treeFunctions.has(name), 'cloned runtime omitted goal-tree function: ' + name);
});

[
  'clearRailTransients', 'railSnapshot', 'renderRail', 'animateRailChange', 'setRailVisible',
  'sceneTransform', 'applyView', 'stopViewAnimation', 'stopPanInertia', 'startPanInertia',
  'requestViewAnimation', 'tickView', 'setViewTarget', 'fit', 'setZoom',
  'preserveViewOnResize', 'edgePath', 'animateLayout', 'settleNodeFills',
  'transitionFill', 'transitionTaskCheck', 'preserveViewAnchor', 'positionPopover',
  'beginTreeTransition', 'endTreeTransition', 'animateRootEntrance', 'settleViewThenSave',
  'finishTreeSwitchMotion', 'cancelTreeSwitchMotion', 'requestTreeSwitchFrame',
  'tickTreeSwitchMotion', 'beginTreeSwitchMotion', 'collapseVisibleDescendants',
  'cleanupCollapseMotion', 'cancelCollapseMotion', 'finishCollapseMotion',
  'setCollapseControlExpanded', 'toggleBranchCollapse', 'clearDropPreview', 'showDropPreview',
  'dragHitId', 'activateDrag', 'autoPanDrag', 'updateDragCandidate', 'flushDragFrame',
  'onDragMove', 'onDragEnd', 'onDragCancel', 'endPan',
].forEach((name) => {
  assert.strictEqual(functionSource(tree, name), functionSource(route, name),
    'goal-tree runtime drifted in critical function: ' + name);
});

[
  "GOAL_TREE_SIMPLE_KEY = 'canvas:studyGoalTreeSimpleMode:v1'",
  "post('/api/tree-page-command'", "api('/api/tree-page')",
  "anchor.setPointerCapture(event.pointerId)", "lostpointercapture", "onDragLostCapture",
  "window.addEventListener('blur', cancelActivePointerGestures)",
  "command: 'delete-task'", "body.command = 'update-root-appearance'",
  "window.CanvasTreePage =", 'activate: function', 'deactivate: function',
  'resetView: resetView',
  'TREE_PAGE_SHAPES',
  'function createOptimistically(body)', "createClientId('tree_task_')",
  'function deleteTaskOptimistically(taskId)', "return deleteTaskOptimistically(task.id)",
  'progressCommandQueue', 'function drainProgressCommands()', 'function applyProgressCommandPayload(json, context)',
  'appearanceCommandQueue', 'function drainAppearanceCommands()', 'function updateAppearanceOptimistically(anchor, patch)',
  "createClientId('goal_node_')", "createClientId('goal_link_')",
  "command: 'create-task', primaryLink: primaryLinkForAnchor(anchor)",
  "command: 'create-branch', primaryLink: primaryLinkForAnchor(anchor)",
  'function finishRouteCloseVisuals()', "overlay.classList.contains('view-leaving')",
  "overlay.addEventListener('animationend', routeCloseAnimationHandler)",
  'function ensureTreePageData()', 'if (studyPrefetchPromise) return studyPrefetchPromise',
  'function scheduleTreePagePreload()', 'window.requestIdleCallback(warmTreePage, { timeout: 1500 })',
  'function applyStudyPayloadAfterFont(', 'Promise.all([ensureTreePageData(), ensureFreeItemFont()])',
  'scheduleTreePagePreload();',
].forEach((needle) => assert(tree.includes(needle), 'missing tree runtime contract: ' + needle));

[
  "boxStyle = 'emphasis-card'", "item.boxStyle === 'emphasis-card'",
  "['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']",
  'function createFreeItemAt(kind, point)', 'function beginFreeItemMoveOrResize(event)',
  'function clearEmptyFreeItems()', "event.target.closest('[data-tree-item-clear-empty]')",
  'createFreeItemAt(gesture.kind, routeScenePoint(event.clientX, event.clientY))',
  "createFreeItemAt(kind, routeScenePoint(event.clientX, event.clientY))",
  "command: 'create-free-item'", "command: 'update-free-item'", "command: 'delete-free-item'",
  'freeItemCommandQueue', 'function drainFreeItemCommands()', 'function flushFreeItemCommands()',
  'freeItemTextSaveTimer = window.setTimeout', '}, 350);',
  "FREE_ITEM_DOCK_COLLAPSED_KEY = 'tree-page:itemToolbarCollapsed:v1'",
  "FREE_ITEM_DEFAULTS_KEY = 'tree-page:itemToolbarDefaults:v1'",
  "text: { tone: 'black', fontSize: 34 }", "note: { tone: 'black', fontSize: 34 }",
  'FREE_ITEM_SIZES.includes(savedFontSize)',
  'freeItemDockPreference === null ? activeFreeItems().length === 0 : freeItemDockPreference',
  "localStorage.setItem(FREE_ITEM_DOCK_COLLAPSED_KEY, collapsed ? '1' : '0')",
  "text.contentEditable = 'plaintext-only'", 'text.textContent = item.text ||',
  "event.key === 'Delete' || event.key === 'Backspace'",
  "event.key === 'Enter' && (event.ctrlKey || event.metaKey)",
  'if (editingFreeItemId) commitFreeItemEdit();', 'ensureFreeItemFont()',
].forEach((needle) => assert(tree.includes(needle), 'missing Tree free-item contract: ' + needle));
assert(functionSource(tree, 'createFreeItemData').includes('width = note ? 344 : 118')
  && functionSource(tree, 'createFreeItemData').includes('height = note ? 283 : 54')
  && functionSource(tree, 'createFreeItemData').includes("text: ''"),
  'Tree notes/text boxes must use the agreed default dimensions and start with blank text');
assert(functionSource(tree, 'beginFreeItemMoveOrResize').includes('if (editingFreeItemId) commitFreeItemEdit();'),
  'Tree free-item drag/resize must persist a newly edited item before updating its geometry');
assert(functionSource(tree, 'applyFreeItemTone').includes('item.fillColor = FREE_ITEM_NOTE_FILL;')
  && functionSource(tree, 'applyFreeItemTone').includes('item.borderColor = FREE_ITEM_NOTE_BORDER;')
  && functionSource(tree, 'applyFreeItemTone').includes('item.color = tone.text;'),
  'Tree note tone changes must affect text while keeping the note paper yellow');
assert(functionSource(tree, 'applyFreeItemSizeChoice').includes('freeItemDefaults[kind].fontSize = size; persistFreeItemDefaults();'),
  'Tree text boxes and notes must remember the last explicitly selected size for their kind');
assert(functionSource(tree, 'clearEmptyFreeItems').includes("String(item.text || '').trim()")
  && functionSource(tree, 'clearEmptyFreeItems').includes('queueFreeItemDelete(entry.item, entry.index)')
  && !functionSource(tree, 'clearEmptyFreeItems').includes('openConfirm('),
  'Tree blank-object cleanup must delete only blank text without confirmation');
assert(functionSource(tree, 'finishFreeItemPointer').includes('active.moved && item')
  && functionSource(tree, 'finishFreeItemPointer').includes('queueFreeItemUpdate(item, active.before)'),
  'Tree free-item drag/resize must persist once when the pointer is released');
assert(css.includes('.tree-page-free-item[data-box-style="emphasis-card"]')
  && css.includes('.tree-page-free-item.is-selected:not(.is-editing) .decor-resize-handle')
  && css.includes('.tree-page-item-dock.is-collapsed .tree-page-item-dock-row'),
  'Tree free-item note, eight-way resize, and collapsible toolbar styles are required');
assert(/\.tree-page-free-item:not\(\[data-box-style\]\) \.text-box-content\s*\{[^}]*display:\s*block;[^}]*height:\s*auto;/s.test(css),
  'Tree text editing must keep the editable as a normal line box so its empty caret stays vertically centered');
assert(/\.tree-page-free-item \.text-box-content::?-webkit-scrollbar\s*\{[^}]*display:\s*none;/s.test(css)
  && /\.tree-page-free-item \.text-box-content\s*\{[^}]*scrollbar-width:\s*none;/s.test(css),
  'Tree free-item text must hide native scrollbar chrome while preserving overflow scrolling');
const resetViewSource = functionSource(tree, 'resetView');
assert(resetViewSource.includes("scene.classList.contains('is-loading')")
  && resetViewSource.includes('resetViewPending = true')
  && resetViewSource.includes('fit();'),
  'Tree camera reset must fit immediately when ready and defer while the first layout is loading');
assert(functionSource(tree, 'consumePendingViewReset').includes('resetViewPending = false')
  && tree.includes('if (!consumePendingViewReset() && !restored) fit(true);')
  && functionSource(tree, 'closeRoute').includes('resetViewPending = false'),
  'a deferred Tree camera reset must run once after layout and be discarded when leaving the page');

[
  'if (event.altKey)', "command: 'create-reference'", "command: 'delete-reference'",
  'referenceDrag', 'referencePreview', 'referenceElements', 'tree-page-reference',
].forEach((needle) => assert(!tree.includes(needle), 'removed Alt-reference feature leaked into tree runtime: ' + needle));
assert(!css.includes('.tree-page-reference'), 'removed Alt-reference styles must not remain');
assert(tree.includes("window.addEventListener('mouseup', onDragMouseUp, true)"),
  'task drag must capture on pointerdown and keep a mouseup fallback');
assert(!functionSource(tree, 'activateDrag').includes('setPointerCapture'),
  'task drag activation must not recapture the pointer after movement has begun');
const gestureCancelSource = functionSource(tree, 'cancelActivePointerGestures');
assert(gestureCancelSource.includes('finishDrag(true)'),
  'window blur and backgrounding must cancel task dragging');
const treeDataSource = functionSource(tree, 'ensureTreePageData');
assert(treeDataSource.indexOf('if (studyPrefetchPromise) return studyPrefetchPromise')
  < treeDataSource.indexOf("api('/api/tree-page')"),
  'Tree entry must reuse an idle prefetch already in flight');

const progressSource = functionSource(tree, 'changeProgress');
assert(progressSource.indexOf('state.tasks = state.tasks.map') < progressSource.indexOf('progressCommandQueue.push'),
  'progress controls must update local task state before enqueueing the server command');
assert(progressSource.includes('if (busy && !joiningQueue) return;'),
  'progress controls must accept consecutive clicks only while their own queue is active');
assert(progressSource.includes('queuedProgress.delta += delta')
  && progressSource.includes('if (!queuedProgress.delta) progressCommandQueue.pop()'),
  'rapid progress clicks must coalesce instead of accumulating one full POST per click');
const commandSource = functionSource(tree, 'command');
assert(commandSource.includes('applyAuthorityAfterGenerationChange(json)')
  && commandSource.includes('refreshAuthorityAfterGenerationChange()'),
  'commands completed after close/reopen must reconcile authoritative state');
const renderSource = functionSource(tree, 'render');
assert(tree.includes('var nodeSizeCache = new Map()')
  && tree.includes('var TREE_MODEL_OPTIONS = { allowBlankTitle: true };')
  && renderSource.includes('GoalTree.normalizeTree(state.tree, state.tasks, TREE_MODEL_OPTIONS)')
  && renderSource.includes('var model = GoalTree.buildModel(state.tree, state.tasks, TREE_MODEL_OPTIONS)')
  && renderSource.includes('model: model, sizes: nodeSizeCache')
  && renderSource.includes('var next = sizesChanged ? GoalTree.layout'),
  'Tree renders must reuse one model and cached DOM geometry until a node size changes');
assert(functionSource(tree, 'animateLayout').includes('if (!geometryChanged')
  && functionSource(route, 'animateLayout').includes('if (!geometryChanged'),
  'unchanged geometry must not run a full FLIP animation on every data-only update');
assert(tree.includes('tree-page-root-progress-value')
  && tree.includes('tree-page-root-title')
  && tree.includes("ROOT_TITLE_HIDDEN_KEY = 'canvas:treePageRootTitleHidden:v1'")
  && tree.includes("window.addEventListener('relatum:tree-page-root-title-change'"),
  'Tree roots must render a preference-controlled title beside the animated percentage');
assert(tree.includes("GOAL_TREE_ENFORCE_UNLOCK_KEY = 'canvas:goalTreeEnforceUnlock:v1'")
  && tree.includes('enforceGoalTreeUnlock: unlockEnforcementEnabled()')
  && tree.includes("window.addEventListener('relatum:goal-tree-unlock-enforcement-change'"),
  'Tree-page locking must be optional, shared, and included in protected mutations');
assert(css.includes('display: inline-block;')
  && css.includes('flex: 0 0 4ch;')
  && css.includes('inline-size: 4ch;')
  && css.includes('text-align: left;')
  && css.includes('.tree-page-root-title {')
  && css.includes('font-size: var(--tree-page-root-title-size, 25px);')
  && css.includes('text-overflow: ellipsis;'),
  'Tree root titles must stay fixed while the percentage grows into its reserved slot on the right');
assert(tree.includes("window.addEventListener('relatum:tree-page-root-title-size-change'")
  && tree.includes('if (!open || rootTitleSizeFrame) return;')
  && tree.includes('rootTitleSizeFrame = requestAnimationFrame(function ()')
  && tree.includes('render({ animateLayout: false, suppressEntrance: true })'),
  'root title slider input must remeasure the open tree at most once per animation frame');
assert(tree.includes("var required = node && node.kind === 'root' ? '' : ' required';")
  && tree.includes("!rootTitleHidden && rootTreeTitle"),
  'only Tree root titles may be blank, and blank titles must not render a fallback beside the percentage');
[
  'study-progress-track-shell tree-page-task-progress', 'study-progress-track', 'study-progress-fill',
  'is-goal-pending', 'is-goal-celebrating', 'is-goal-breathing',
  'function scheduleTreeGoalBreath(delay)', "replayClass(node, 'is-goal-celebrating', 1480)",
  'scheduleTreeGoalBreath(1560)', 'function syncExistingTaskMarkup(element, placement)',
  "currentTrack.classList.toggle('is-full'", 'currentFill.style.width = nextFill.style.width',
  'tree-page-root-progress-track', 'function syncExistingRootMarkup(element, placement)',
].forEach((needle) => assert(tree.includes(needle), 'missing copied study progress motion: ' + needle));
assert(!tree.includes('nextProgressShell.replaceWith(oldProgressShell)'),
  'the progress fill must never be detached and reattached during +/- updates');
[
  '.tree-page-route-panel .study-route-node.is-task.is-goal-ready .study-progress-fill::before',
  '.tree-page-route-panel .study-route-node.is-task.is-goal-celebrating .study-progress-fill::after',
  '.tree-page-route-panel .study-route-node.is-task.is-goal-ready.is-goal-breathing',
  '.tree-page-route-panel .tree-page-task-progress .study-progress-track',
  '.tree-page-route-panel .study-route-node.is-root.is-goal-ready .study-progress-fill::before',
  '.tree-page-route-panel .tree-page-root-progress-track .study-progress-track',
].forEach((needle) => assert(css.includes(needle), 'missing copied study progress style: ' + needle));

const appearanceSource = functionSource(tree, 'updateAppearanceOptimistically');
assert(appearanceSource.indexOf('syncAppearancePaletteSelection(patch)') < appearanceSource.indexOf('appearanceCommandQueue.push'),
  'appearance controls must update local visuals before enqueueing the server command');
assert(appearanceSource.includes('Object.assign(queuedBody, body)'),
  'rapid appearance changes for one node must coalesce in the pending queue');
assert(tree.includes("return updateAppearanceOptimistically(anchor, { color: control.dataset.color || '' })"),
  'color controls must use optimistic appearance updates');
assert(tree.includes('return updateAppearanceOptimistically(anchor, { shape: shape })'),
  'shape controls must use optimistic appearance updates');
assert(tree.includes('data-route-pop="clear-progress"')
  && tree.includes("T('取消进度条')")
  && tree.includes('progress: { current: 0, target: 0, milestones: [] }')
  && tree.includes('}, { optimistic: true }).catch(showError)'),
  'tasks with numeric progress must offer an immediate, rollback-safe way to remove the progress bar');
assert(tree.includes('current = Math.min(current, target)')
  && tree.includes("T('当前进度和目标总量都需要是 0–9999 的整数')")
  && !tree.includes("return showError(new Error(T('进度需要满足 0 ≤ 当前进度 ≤ 目标总量 ≤ 9999')))"),
  'lowering a goal total must clamp current progress instead of warning');
assert(!tree.includes('data-route-form="new-task"') && !tree.includes('data-route-form="new-branch"')
  && !tree.includes('data-route-form="new-stage"'),
  'new tasks and branches must not open naming forms');
assert(/command: 'create-task'[\s\S]{0,180}title: T\('未命名'\), target: 1/.test(tree),
  'one-click task creation must use an untitled 0/1 task');
assert(/command: 'create-branch'[\s\S]{0,180}title: T\('未命名'\)/.test(tree),
  'one-click branch creation must use an untitled branch');

assert(!tree.includes("data-route-pop=\"attach\""), 'Select existing task must be absent');
assert(!tree.includes("command: 'attach-task'"), 'attach-task must be absent');
assert(!tree.includes("command: 'detach-task'"), 'detach-task must be absent');
assert(!tree.includes('选择已有任务'), 'existing-task copy must be absent');
assert(!tree.includes('移出路线'), 'detach copy must be absent');
assert(tree.includes('return deleteTaskOptimistically(task.id).catch(ignoreBusy)')
  && !tree.includes("openConfirm(T('删除这个任务？')"),
  'task deletion must start immediately without a second confirmation dialog');
assert(functionSource(tree, 'deleteTaskOptimistically').includes('createTaskDeleteGhost(owner.id)')
  && css.includes('@keyframes studyRouteNodeDelete'),
  'task deletion must leave a short non-interactive fade ghost');

['rounded', 'rectangle', 'pill', 'diamond', 'circle'].forEach((shape) => {
  assert(tree.includes("value: '" + shape + "'"), 'missing shape option: ' + shape);
  assert(shape === 'rounded' ? css.includes('.study-route-node {') : css.includes('.tree-page-shape-' + shape),
    'missing shape CSS: ' + shape);
});
assert(css.includes('.tree-page-route-panel') && css.includes('border-radius: 0')
  && css.includes('.tree-page-route-stage'), 'tree page must use the fullscreen modifier');
assert(css.includes('body.start-page[data-start-theme="dark"] .tree-page-route-stage'),
  'tree page needs dark theme styling');
assert(css.includes('--tree-diamond-fill') && css.includes('--tree-diamond-stroke')
  && css.includes('.study-route-node.tree-page-shape-diamond::after'),
  'diamond nodes need independent fill and outline layers');
assert(!/^\.tree-page-shape-diamond i \{/m.test(css)
  && css.includes('.tree-page-shape-choice.tree-page-shape-diamond i {'),
  'shape-picker icon rules must not transform node content');
assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tree-page-embedded/.test(css),
  'tree page needs reduced-motion fallback');

console.log('tree page cloned-runtime UI contract passed');

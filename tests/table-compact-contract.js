const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to >= 0, `missing section end: ${end}`);
  return source.slice(from, to);
}

const canvas = read('assets/canvas.js');
const defaultTable = section(canvas, 'function defaultTableMarkdown', 'function createTableNode');
const createNode = section(canvas, 'function createTableNode', 'function createTableAtViewportCenter');
const createAtCenter = section(canvas, 'function createTableAtViewportCenter', 'function setupTableCreateButtons');
const createButtons = section(canvas, 'function setupTableCreateButtons', 'function buildMindmapChildrenIndex');
const surfaceDoubleClick = section(canvas, 'function onSurfaceDblClick', 'function onSurfaceMouseDown');
const resizeHandles = section(canvas, 'function ensureBodyResizeHandles', 'function bodyResizeContentEl');

assert(defaultTable.includes("createDefault(3, 3, '')"), 'new table headers must start blank');
assert(!defaultTable.includes('列 1') && !defaultTable.includes('Column 1'), 'new tables must not contain generated labels');
assert(!createNode.includes('bodyHeight'), 'new tables must not persist a fixed bodyHeight');
assert(!createNode.includes('width:'), 'new tables must not persist a separate fixed width');
assert(!createAtCenter.includes('openTableStudio'), 'creating a table must not open the modal studio');
assert(createButtons.includes("setDrawTool('table')"), 'single-clicking the table entry must only select the tool');
assert(!createButtons.includes('createTableAtViewportCenter();'), 'single click must not create a table');
assert(surfaceDoubleClick.includes("if (drawTool === 'table')"), 'double-clicking blank canvas must create the selected table type');
assert(resizeHandles.includes("if (isTableNode(node)) dirs = ['n', 's', 'e']"), 'table left edge is reserved for dragging');
assert(canvas.includes("closest('.table-drag-strip')"), 'table movement must use the left drag strip');
assert(canvas.includes("el.style.setProperty('--table-scale', normalizedTableScale(node.tableScale))"));
assert(canvas.includes("delete node.bodyHeight"));
assert(canvas.includes("const horizontalTable = drag.dir === 'e' || drag.dir === 'w'"));

const migrationContext = {};
vm.runInNewContext(
  section(canvas, 'function normalizedTableScale', 'function richSource')
    + '\nthis.normalizeTableNodeLayout = normalizeTableNodeLayout;',
  migrationContext
);
const legacyTable = { kind: 'table', width: 720, bodyHeight: 320 };
assert.strictEqual(migrationContext.normalizeTableNodeLayout(legacyTable), true);
assert.strictEqual(legacyTable.width, undefined);
assert.strictEqual(legacyTable.bodyHeight, undefined);
assert.strictEqual(legacyTable.tableScale, 1.16);
const scaledLegacyTable = { kind: 'table', width: 620, tableScale: 1.5 };
migrationContext.normalizeTableNodeLayout(scaledLegacyTable);
assert.strictEqual(scaledLegacyTable.width, undefined);
assert.strictEqual(scaledLegacyTable.tableScale, 1.5);
const invalidTableView = {
  kind: 'table',
  tableChrome: 'visible',
  tableAppearance: 'spreadsheet',
  tableBracket: 'triangle',
};
migrationContext.normalizeTableNodeLayout(invalidTableView);
assert.strictEqual(invalidTableView.tableChrome, undefined);
assert.strictEqual(invalidTableView.tableAppearance, undefined);
assert.strictEqual(invalidTableView.tableBracket, undefined);
const matrixTableView = {
  kind: 'table',
  tableChrome: 'hidden',
  tableAppearance: 'matrix',
  tableBracket: 'square',
};
assert.strictEqual(migrationContext.normalizeTableNodeLayout(matrixTableView), false);
assert.strictEqual(matrixTableView.tableChrome, 'hidden');
assert.strictEqual(matrixTableView.tableAppearance, 'matrix');
assert.strictEqual(matrixTableView.tableBracket, 'square');

const editor = read('assets/table-editor.js');
assert(editor.includes("syntax.createDefault(3, 3, '')"), 'invalid table fallback must also stay blank');
assert(!editor.includes('ensureBodyRow: true'), 'the last body row must remain deletable');
assert(!editor.includes("if (this.model.rows.length === 0) this.model.rows.push"), 'deleting rows must not recreate a body row');
const compactHeader = section(editor, 'if (this.options.compact)', '} else {\n      this.renderToolbar(root);');
assert(!compactHeader.includes('table-compact-actions'), 'compact header must not restore the five-button action strip');
assert(compactHeader.includes('table-open-studio'), 'compact table still needs an explicit studio entry');
assert(compactHeader.includes('table-drag-strip'), 'compact table needs the invisible left drag strip');
assert(!compactHeader.includes('table-node-grip'), 'compact table must not depend on the old corner grip');
assert(compactHeader.includes('title.readOnly = true'), 'compact title must default to drag mode');
assert(compactHeader.includes("title.addEventListener('dblclick'"), 'compact title must require a double click to edit');
assert(compactHeader.includes("title.classList.add('is-editing')"));
assert(compactHeader.includes('event.detail > 1'), 'the second title press must not start another table drag');
assert(compactHeader.includes('const selectionStart = title.selectionStart'));
assert(compactHeader.includes('title.setSelectionRange(selectionStart, selectionEnd)'),
  'double-clicking a title must preserve the native word selection');
assert(editor.includes("root.addEventListener('contextmenu'"), 'compact cells need a table-specific context menu');
assert(editor.includes("event.code === 'Minus'"), 'Ctrl+- must open the compact table delete menu');
assert(editor.includes("deleteSelectedRows"));
assert(editor.includes("deleteSelectedColumns"));
assert(editor.includes("bounds.r2 < 1"), 'header-only selections must not delete rows');
assert(editor.includes("this.colCount() <= 1"), 'the last remaining column must not be deletable');
assert(editor.includes("root.classList.toggle('table-chrome-hidden', !!this.options.chromeHidden)"));
assert(editor.includes("root.dataset.tableAppearance = appearance"));
assert(editor.includes("root.dataset.tableBracket = bracket"));
assert(editor.includes("if (options.viewOptionsEditable)"));
assert(editor.includes("options.onViewCommit"));
assert(editor.includes("group === 'appearance' && value === 'matrix'"));
assert(editor.includes("chromeCheckbox.checked = false"));
assert(canvas.includes("tableChrome = chrome"));
assert(canvas.includes("node.tableAppearance = 'matrix'"));
assert(canvas.includes("node.tableBracket = bracket"));
assert(canvas.includes("e.target.closest('.table-object-head')"), 'the visible title row must drag the table');
assert(canvas.includes("titleInput && !titleInput.readOnly"), 'an actively edited title must not start dragging');

const css = read('assets/styles.css');
assert(/\.table-grid-root\.compact \.table-grid-scroll\s*\{[^}]*height:\s*auto;/s.test(css));
assert(/\.table-grid-root\.compact \.table-grid-scroll\s*\{[^}]*overflow:\s*visible;/s.test(css));
assert(/\.node\[data-kind="table"\]\s*\{[^}]*width:\s*max-content;/s.test(css));
assert(/\.node:not\(\[data-kind="card"\]\):not\(\[data-kind="preview"\]\):not\(\[data-kind="table"\]\) > \.node-text:first-child/s.test(css));
assert(/\.node\[data-kind="table"\] > \.node-text\.table-node-shell:first-child\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s.test(css));
assert(/\.table-grid-root\.compact :is\([^}]+\)\s*\{[^}]*display:\s*none;/s.test(css));
assert(/\.table-grid-root\.compact \.table-grid\s*\{[^}]*font-size:\s*calc\(14\.5px \* var\(--table-scale, 1\)\)/s.test(css));
assert(/\.table-drag-strip\s*\{[^}]*left:\s*calc\(-15px[^}]*width:\s*calc\(16px/s.test(css));
assert(/\.table-drag-strip::after\s*\{[^}]*height:\s*calc\(30px[^}]*opacity:\s*0;/s.test(css));
assert(!editor.includes("td.title = t('editCell')"), 'table cells must not create repeated edit tooltips');
assert(/\.table-node-title:read-only\s*\{[^}]*cursor:\s*grab;/s.test(css));
assert(/\.table-node-title:not\(:read-only\)\s*\{[^}]*cursor:\s*text;/s.test(css));
assert(/\.node\[data-kind="table"\]\.dragging \.table-edge-add\s*\{[^}]*pointer-events:\s*none;[^}]*opacity:\s*0;/s.test(css));
assert(css.includes('.node[data-kind="table"].selected .table-grid-root.compact .table-grid td.selected'),
  'compact cell selection must only be visible while the table node is selected');
assert(css.includes('.node[data-kind="table"].selected .table-grid-root.compact .table-grid td.active'),
  'compact active-cell outline must only be visible while the table node is selected');
assert(!/^\.table-grid td\.selected\s*\{/m.test(css),
  'compact tables must not inherit an unconditional selected-cell background');
assert(!/^\.table-grid td\.active\s*\{/m.test(css),
  'compact tables must not inherit an unconditional active-cell outline');
assert(/\.table-grid-root\.compact\.table-chrome-hidden \.table-object-head\s*\{[^}]*display:\s*none;/s.test(css));
assert(/\.node\[data-kind="table"\]\[data-table-appearance="matrix"\]\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s.test(css));
assert(css.includes('[data-table-bracket="round"]'));
assert(css.includes('[data-table-bracket="square"]'));
assert(css.includes('[data-table-bracket="determinant"]'));
assert(css.includes('.table-grid-context-menu'));

const editorHtml = read('assets/editor.html');
assert(editorHtml.includes('<h3>独立表格</h3>'), 'the help panel must document standalone tables');
assert(editorHtml.includes('<kbd>Ctrl</kbd>+<kbd>-</kbd>'), 'the help panel must document Ctrl+-');
assert(editorHtml.includes('只清空所选内容，不删除行列'), 'the help panel must distinguish clearing from structural deletion');

console.log('table compact contract: ok');

'use strict';

const assert = require('assert');
const matrix = require('../assets/node-matrix.js');

const defaults = matrix.normalizeConfig({});
assert.strictEqual(defaults.rows, 3);
assert.strictEqual(defaults.columns, 3);
assert.strictEqual(defaults.kind, 'card');
assert.strictEqual(defaults.contentMode, 'sequence');
assert.strictEqual(defaults.suffix, '.');
assert.strictEqual(defaults.gapX, 48);
assert.strictEqual(defaults.gapY, 36);

const rowSequence = matrix.buildCells({
  rows: 2,
  columns: 3,
  contentMode: 'sequence',
  start: -2,
  prefix: 'Q',
  suffix: '?',
  order: 'row',
});
assert.deepStrictEqual(
  rowSequence.cells.map((cell) => cell.text),
  ['Q-2?', 'Q-1?', 'Q0?', 'Q1?', 'Q2?', 'Q3?'],
);

const columnSequence = matrix.buildCells({
  rows: 2,
  columns: 3,
  contentMode: 'sequence',
  start: 1,
  prefix: '',
  suffix: '.',
  order: 'column',
});
assert.deepStrictEqual(
  columnSequence.cells.map((cell) => cell.text),
  ['1.', '3.', '5.', '2.', '4.', '6.'],
);

const blank = matrix.buildCells({ rows: 1, columns: 2, contentMode: 'blank' });
assert.deepStrictEqual(blank.cells.map((cell) => cell.text), ['', '']);

const pasted = matrix.parsePastedGrid('A\t\tC\r\nD\tE\r\n\r\n');
assert.strictEqual(pasted.rows, 2);
assert.strictEqual(pasted.columns, 3);
assert.deepStrictEqual(pasted.values, [['A', '', 'C'], ['D', 'E', '']]);
const pastedCells = matrix.buildCells({
  contentMode: 'paste',
  pasteText: 'A\t\tC\nD\tE\n',
});
assert.strictEqual(pastedCells.config.rows, 2);
assert.strictEqual(pastedCells.config.columns, 3);
assert.deepStrictEqual(
  pastedCells.cells.map((cell) => cell.text),
  ['A', '', 'C', 'D', 'E', ''],
);

assert.throws(
  () => matrix.normalizeConfig({ rows: 20, columns: 20 }),
  (error) => error.code === 'TOO_MANY_CELLS',
);
assert.throws(
  () => matrix.normalizeConfig({ contentMode: 'paste', pasteText: '' }),
  (error) => error.code === 'EMPTY_PASTE',
);
assert.throws(
  () => matrix.normalizeConfig({ rows: 2.5, columns: 2 }),
  (error) => error.code === 'INVALID_ROWS',
);
assert.throws(
  () => matrix.normalizeConfig({
    rows: 1,
    columns: 1,
    widthMode: 'custom',
    width: 79,
  }),
  (error) => error.code === 'INVALID_WIDTH',
);

const autoWidth = matrix.resolveUniformWidth(
  [94.2, 180.1, 120],
  matrix.normalizeConfig({ rows: 1, columns: 3 }),
  { min: 100, max: 160 },
);
assert.strictEqual(autoWidth, 160);
const manualWidth = matrix.resolveUniformWidth(
  [400],
  matrix.normalizeConfig({
    rows: 1,
    columns: 1,
    widthMode: 'custom',
    width: 90,
  }),
  { min: 150, max: 360 },
);
assert.strictEqual(manualWidth, 150);

const layout = matrix.layout(
  [
    { width: 100, height: 40 },
    { width: 100, height: 60 },
    { width: 100, height: 30 },
    { width: 100, height: 50 },
  ],
  matrix.normalizeConfig({
    rows: 2,
    columns: 2,
    gapPreset: 'custom',
    gapX: 20,
    gapY: 10,
  }),
  { x: 1000, y: -200 },
);
assert.deepStrictEqual(layout.columnWidths, [100, 100]);
assert.deepStrictEqual(layout.rowHeights, [60, 50]);
assert.strictEqual(layout.width, 220);
assert.strictEqual(layout.height, 120);
assert.strictEqual(layout.bounds.x, 890);
assert.strictEqual(layout.bounds.y, -260);
assert.deepStrictEqual(
  layout.items.map((item) => ({ x: item.x, y: item.y })),
  [
    { x: 890, y: -250 },
    { x: 1010, y: -260 },
    { x: 890, y: -180 },
    { x: 1010, y: -190 },
  ],
);

console.log('node matrix regression tests passed');

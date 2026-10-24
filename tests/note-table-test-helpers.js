'use strict';

// Source value is independent of the projected contenteditable text. Keep the
// locator's native fill/press/geometry methods; read Markdown from its owner.
exports.tableInput = page => {
  const locator = page.locator('.note-table-cell-editor');
  locator.inputValue = () => locator.evaluate(node => node.__noteCellInput ? node.__noteCellInput.value : node.value);
  return locator;
};

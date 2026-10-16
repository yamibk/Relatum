/* Runs only while the import dialog needs parsing. All scripts and data stay local. */
'use strict';
importScripts('review-import-model.js');
const model = self.RelatumReviewImportModel;

function spreadsheet(bytes, selected) {
  if (!self.XLSX) importScripts('vendor/sheetjs/xlsx.full.min.js');
  const options = { type: 'array', cellHTML: false, cellFormula: true, sheetStubs: true, dense: false };
  const metadata = XLSX.read(bytes, Object.assign({}, options, { sheets: [] }));
  const sheets = metadata.SheetNames.map((name, index) => ({ name, hidden: !!metadata.Workbook?.Sheets?.[index]?.Hidden }));
  const sheet = selected || sheets.find(item => !item.hidden)?.name || sheets[0]?.name;
  if (!sheet || !sheets.some(item => item.name === sheet)) throw model.failure('empty-input');
  const workbook = XLSX.read(bytes, Object.assign({}, options, { sheets: [sheet] }));
  const worksheet = workbook.Sheets[sheet];
  const byRow = new Map(), errors = {};
  for (const address of Object.keys(worksheet)) {
    if (address[0] === '!') continue;
    const cell = worksheet[address];
    const missing = cell.f && (cell.v === undefined || cell.t === 'z');
    if (!missing && cell.t !== 'e' && (cell.v === undefined || cell.v === '')) continue;
    const point = XLSX.utils.decode_cell(address), sourceRow = point.r + 1;
    // Empty formatted cells do not inflate the preview or its column controls.
    if (point.c >= 256) throw model.failure('column-limit');
    let row = byRow.get(sourceRow);
    if (!row) { row = []; byRow.set(sourceRow, row); }
    row[point.c] = missing ? '' : XLSX.utils.format_cell(cell);
    if (missing || cell.t === 'e') errors[sourceRow + ':' + point.c] = missing ? 'formula-cache' : 'cell-error';
  }
  const numbers = Array.from(byRow.keys()).sort((a, b) => a - b);
  if (!numbers.length) throw model.failure('empty-input');
  if (numbers[numbers.length - 1] - numbers[0] + 1 > model.MAX_ROWS + 100) throw model.failure('row-limit');
  const rows = [];
  for (let number = numbers[0]; number <= numbers[numbers.length - 1]; number++) {
    const cells = byRow.get(number) || [];
    rows.push({ sourceRow: number, cells: Array.from(cells, cell => cell == null ? '' : String(cell)) });
  }
  return { rows, errors, sheets, sheet, separator: 'auto' };
}
self.onmessage = function (event) {
  const { id, text, bytes, name, sheet, encoding, separator } = event.data;
  try {
    if (event.data.action === 'map') {
      self.postMessage({ id, rows: model.mapRows(event.data.table, event.data.config) });
      return;
    }
    if (bytes && bytes.byteLength > model.MAX_BYTES) throw model.failure('input-limit');
    let decoded = text;
    if (bytes && !/\.xlsx$/i.test(name || '')) {
      try { decoded = model.decode(bytes, encoding); }
      catch (_) { throw model.failure('encoding-failed'); }
    }
    const table = name && /\.xlsx$/i.test(name) ? spreadsheet(bytes, sheet) : model.parseText(decoded, separator);
    if (table.rows.some(row => row.cells.length > 256)) throw model.failure('column-limit');
    self.postMessage({ id, table });
  } catch (error) {
    self.postMessage({ id, error: { code: error.code || 'parse-failed', detail: error.detail || '' } });
  }
};

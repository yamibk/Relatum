// Pure import model shared by the worker, dialog, and isolated Node tests.
(function (global) {
  'use strict';
  const MAX_ROWS = 10000;
  const MAX_BYTES = 20 * 1024 * 1024;
  const HEADERS = {
    prompt: ['问题', '单词', '词汇', '正面', '题目', 'prompt', 'question', 'front', 'term', 'word', 'vocabulary'],
    answer: ['答案', '释义', '解释', '背面', '含义', 'answer', 'back', 'meaning', 'definition', 'translation'],
    notes: ['补充说明', '说明', '备注', '例句', 'notes', 'note', 'example', 'examples', 'context'],
    deckName: ['卡组', '分组', 'deck', 'group'], tags: ['标签', 'tags', 'tag'],
  };
  function failure(code, detail) {
    const error = new Error(code);
    error.code = code;
    error.detail = detail || '';
    return error;
  }
  function parseWithSeparator(text, separator, sample) {
    const rows = [];
    let cells = [], field = '', quoted = false, closed = false, line = 1, start = 1;
    function cell() { cells.push(field); field = ''; closed = false; }
    function row() {
      cell(); rows.push({ sourceRow: start, cells }); cells = [];
      if (rows.length > MAX_ROWS + 100) throw failure('row-limit');
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          field += '\n'; line++;
        } else field += ch;
      } else if (ch === separator) cell();
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row(); line++; start = line;
        if (sample && rows.length >= sample) return rows;
      } else if (ch === '"' && field === '' && !closed) quoted = true;
      else if (closed) {
        if (ch !== ' ' && ch !== '\t') throw failure('malformed-text', String(line));
      } else field += ch;
    }
    if (quoted) throw failure('unclosed-quote', String(start));
    if (field !== '' || cells.length || closed) row();
    return rows;
  }
  function parseText(value, separator) {
    let text = String(value || '').replace(/^\uFEFF/, '');
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw failure('input-limit');
    if (!separator || separator === 'auto') {
      let best = -1;
      for (const candidate of ['\t', ',', ';']) {
        try {
          const sample = parseWithSeparator(text, candidate, 25).filter(row => row.cells.some(cell => cell.trim()));
          const widths = sample.map(row => row.cells.length);
          const counts = new Map();
          widths.forEach(width => counts.set(width, (counts.get(width) || 0) + 1));
          let score = 0;
          counts.forEach((count, width) => { if (width > 1) score = Math.max(score, count / Math.max(1, sample.length) * 100 + Math.min(width, 20)); });
          if (candidate === '\t' && widths.length && widths.every(width => width > 1)) score += 25;
          if (score > best) { best = score; separator = candidate; }
        } catch (_) {
          // A malformed CSV must not silently become a valid one-column TSV.
          if (best < 1 && text.includes(candidate)) { best = 1; separator = candidate; }
        }
      }
      if (!separator || separator === 'auto') separator = '\t';
    }
    if (!['\t', ',', ';'].includes(separator)) throw failure('separator');
    const rows = parseWithSeparator(text, separator);
    if (!rows.some(row => row.cells.some(cell => cell.trim()))) throw failure('empty-input');
    return { rows, separator, errors: {}, sheets: [], sheet: '' };
  }
  function decode(bytes, encoding) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (input.byteLength > MAX_BYTES) throw failure('input-limit');
    if (encoding && encoding !== 'auto') return new TextDecoder(encoding, { fatal: true }).decode(input);
    if (input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(input);
    if (input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(input);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch (_) { return new TextDecoder('gb18030', { fatal: true }).decode(input); }
  }
  function headerField(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[\s_\-]/g, '');
    return Object.keys(HEADERS).find(field => HEADERS[field].includes(key)) || '';
  }
  function defaults(table) {
    const errorRows = new Set(Object.keys(table.errors || {}).map(key => Number(key.split(':')[0])));
    const first = table.rows.find(row => row.cells.some(cell => String(cell).trim()) || errorRows.has(row.sourceRow));
    if (!first) throw failure('empty-input');
    const recognized = first.cells.map(headerField);
    const hasHeader = recognized.filter(Boolean).length >= 2 || (first.cells.length === 1 && recognized[0] === 'prompt');
    const config = { headerRow: hasHeader ? first.sourceRow : 0, startRow: hasHeader ? first.sourceRow + 1 : first.sourceRow,
      prompt: { columns: [], separator: '\n', labels: false }, answer: { columns: [], separator: '\n', labels: false },
      notes: { columns: [], separator: '\n', labels: false }, deckColumn: -1, tagColumn: -1, deckName: '', tags: '', duplicateMode: 'skip' };
    if (hasHeader) recognized.forEach((field, index) => {
      if (config[field] && Array.isArray(config[field].columns)) config[field].columns.push(index);
      if (field === 'deckName') config.deckColumn = index;
      if (field === 'tags') config.tagColumn = index;
    });
    if (!config.prompt.columns.length) config.prompt.columns = [0];
    if (!config.answer.columns.length && first.cells.length > 1 && !recognized[1]) config.answer.columns = [1];
    if (!hasHeader && first.cells.length > 1) config.answer.columns = [1];
    return config;
  }
  function columnName(index) {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }
  function headings(table, config) {
    const header = table.rows.find(row => row.sourceRow === Number(config.headerRow));
    const width = table.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
    return Array.from({ length: width }, (_, index) => header && String(header.cells[index] || '').trim() || columnName(index));
  }
  function mapRows(table, config, page) {
    const names = headings(table, config);
    const source = table.rows.filter(row => row.sourceRow >= Number(config.startRow) && row.sourceRow !== Number(config.headerRow));
    if (source.length > MAX_ROWS) throw failure('row-limit');
    if (!source.length) throw failure('empty-input');
    const errorRows = new Set(Object.keys(table.errors || {}).map(key => Number(key.split(':')[0])));
    return (page ? source.slice(page.offset, page.offset + page.limit) : source).map(row => {
      const blank = !row.cells.some(value => String(value).trim()) && !errorRows.has(row.sourceRow);
      const result = { sourceRow: row.sourceRow, blank, prompt: '', answer: '', notes: '', deckName: '', tags: [] };
      if (blank) return result;
      const used = new Set();
      for (const field of ['prompt', 'answer', 'notes']) {
        const setting = config[field];
        result[field] = setting.columns.map(index => {
          used.add(index);
          const value = String(row.cells[index] == null ? '' : row.cells[index]).trim();
          return value && (setting.labels ? names[index] + ': ' : '') + value;
        }).filter(Boolean).join(setting.separator === '\n' && field !== 'prompt' ? '  \n' : setting.separator);
      }
      if (config.deckColumn >= 0) used.add(config.deckColumn);
      if (config.tagColumn >= 0) used.add(config.tagColumn);
      result.deckName = String(config.deckColumn >= 0 ? row.cells[config.deckColumn] || '' : '').trim() || String(config.deckName || '').trim();
      const tags = String(config.tags || '') + '\n' + String(config.tagColumn >= 0 ? row.cells[config.tagColumn] || '' : '');
      result.tags = tags.split(/[,，\r\n]/).map(value => value.trim()).filter(Boolean);
      const errorColumn = Array.from(used).find(index => table.errors && table.errors[row.sourceRow + ':' + index]);
      if (errorColumn !== undefined) result.sourceError = table.errors[row.sourceRow + ':' + errorColumn];
      return result;
    });
  }
  const api = { MAX_ROWS, MAX_BYTES, parseText, decode, defaults, headings, mapRows, columnName, failure };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.RelatumReviewImportModel = api;
})(typeof self !== 'undefined' ? self : globalThis);

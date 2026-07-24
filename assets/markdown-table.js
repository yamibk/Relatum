// Markdown 表格的单一语法层。
// 画布独立表格、普通节点里的表格编辑以及 MarkdownMini 渲染必须共用这里，
// 避免出现“看起来能渲染，但重新编辑后列错位”的两套解析规则。
(function (global) {
  'use strict';

  function normalizeNewlines(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  }

  function cloneModel(model) {
    const source = model || {};
    return {
      header: Array.isArray(source.header) ? source.header.map(String) : [''],
      rows: Array.isArray(source.rows)
        ? source.rows.map(function (row) { return Array.isArray(row) ? row.map(String) : []; })
        : [],
      align: Array.isArray(source.align) ? source.align.map(normalizeAlign) : [],
    };
  }

  function normalizeAlign(value) {
    return value === 'left' || value === 'center' || value === 'right' ? value : '';
  }

  function rowHasDelimiter(line) {
    const text = String(line || '');
    let escaped = false;
    let ticks = 0;
    let math = 0;
    let square = 0;
    let round = 0;
    let curly = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        ticks = ticks === run ? 0 : (ticks ? ticks : run);
        i += run - 1;
        continue;
      }
      if (ticks) continue;
      if (ch === '$') {
        let run = 1;
        while (text[i + run] === '$') run++;
        math = math === run ? 0 : (math ? math : run);
        i += run - 1;
        continue;
      }
      if (math) continue;
      if (ch === '[') square++;
      else if (ch === ']' && square) square--;
      else if (ch === '(') round++;
      else if (ch === ')' && round) round--;
      else if (ch === '{') curly++;
      else if (ch === '}' && curly) curly--;
      else if (ch === '|' && square === 0 && round === 0 && curly === 0) return true;
    }
    return false;
  }

  // 只把语法顶层的 | 当作列分隔符。公式、代码、链接、自定义富文本标记里的 |
  // 都属于单元格内容；\| 会还原成用户真正想输入的竖线。
  function splitRow(line) {
    const text = String(line == null ? '' : line).trim();
    const cells = [];
    let buf = '';
    let ticks = 0;
    let math = 0;
    let square = 0;
    let round = 0;
    let curly = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '|') {
          buf += '|';
          i++;
          continue;
        }
        buf += ch;
        continue;
      }
      if (ch === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        const marks = '`'.repeat(run);
        buf += marks;
        ticks = ticks === run ? 0 : (ticks ? ticks : run);
        i += run - 1;
        continue;
      }
      if (!ticks && ch === '$') {
        let run = 1;
        while (text[i + run] === '$') run++;
        const marks = '$'.repeat(run);
        buf += marks;
        math = math === run ? 0 : (math ? math : run);
        i += run - 1;
        continue;
      }
      if (!ticks && !math) {
        if (ch === '[') square++;
        else if (ch === ']' && square) square--;
        else if (ch === '(') round++;
        else if (ch === ')' && round) round--;
        else if (ch === '{') curly++;
        else if (ch === '}' && curly) curly--;
        else if (ch === '|' && square === 0 && round === 0 && curly === 0) {
          cells.push(buf.trim());
          buf = '';
          continue;
        }
      }
      buf += ch;
    }
    cells.push(buf.trim());
    if (cells.length > 1 && cells[0] === '' && text.charAt(0) === '|') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1] === '' && text.charAt(text.length - 1) === '|') cells.pop();
    return cells;
  }

  function separatorAlign(cell) {
    const value = String(cell || '').trim();
    const left = value.charAt(0) === ':';
    const right = value.charAt(value.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  function isSeparatorLine(line) {
    if (!rowHasDelimiter(line)) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every(function (cell) {
      return /^:?-{1,}:?$/.test(String(cell || '').trim());
    });
  }

  function tableWidth(model) {
    let width = Math.max(1, Array.isArray(model.header) ? model.header.length : 0);
    (model.rows || []).forEach(function (row) {
      if (Array.isArray(row)) width = Math.max(width, row.length);
    });
    return width;
  }

  function normalizeModel(model, options) {
    const out = cloneModel(model);
    const width = tableWidth(out);
    while (out.header.length < width) out.header.push('');
    if (out.header.length > width) out.header.length = width;
    out.rows = out.rows.map(function (row) {
      const next = row.slice(0, width);
      while (next.length < width) next.push('');
      return next;
    });
    while (out.align.length < width) out.align.push('');
    if (out.align.length > width) out.align.length = width;
    out.align = out.align.map(normalizeAlign);
    if (options && options.ensureBodyRow && out.rows.length === 0) {
      out.rows.push(new Array(width).fill(''));
    }
    return out;
  }

  function parseLines(lines, startLine, options) {
    const start = Math.max(0, Number(startLine) || 0);
    if (start + 1 >= lines.length || !rowHasDelimiter(lines[start]) || !isSeparatorLine(lines[start + 1])) {
      return { ok: false, error: '这里不是有效的 Markdown 表格' };
    }
    const header = splitRow(lines[start]);
    const align = splitRow(lines[start + 1]).map(separatorAlign);
    const rows = [];
    let endLine = start + 2;
    while (endLine < lines.length) {
      const line = lines[endLine];
      if (!String(line).trim() || !rowHasDelimiter(line) || isSeparatorLine(line)) break;
      rows.push(splitRow(line));
      endLine++;
    }
    const model = normalizeModel({ header: header, rows: rows, align: align }, {
      ensureBodyRow: !!(options && options.ensureBodyRow),
    });
    return {
      ok: true,
      model: model,
      startLine: start,
      endLine: endLine,
    };
  }

  function parse(markdown, options) {
    const source = normalizeNewlines(markdown);
    const all = source.split('\n');
    let first = 0;
    let last = all.length;
    while (first < last && !all[first].trim()) first++;
    while (last > first && !all[last - 1].trim()) last--;
    const lines = all.slice(first, last);
    const parsed = parseLines(lines, 0, options);
    if (!parsed.ok) return parsed;
    if (!(options && options.allowTrailingContent) && parsed.endLine !== lines.length) {
      return { ok: false, error: '独立表格对象只能包含一个 Markdown 表格' };
    }
    parsed.leadingBlankLines = first;
    return parsed;
  }

  function escapeCell(value) {
    const text = normalizeNewlines(value).replace(/\n+/g, ' ');
    let out = '';
    let ticks = 0;
    let math = 0;
    let square = 0;
    let round = 0;
    let curly = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\' && text[i + 1] === '|') {
        out += '\\|';
        i++;
        continue;
      }
      if (ch === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        out += '`'.repeat(run);
        ticks = ticks === run ? 0 : (ticks ? ticks : run);
        i += run - 1;
        continue;
      }
      if (!ticks && ch === '$') {
        let run = 1;
        while (text[i + run] === '$') run++;
        out += '$'.repeat(run);
        math = math === run ? 0 : (math ? math : run);
        i += run - 1;
        continue;
      }
      if (!ticks && !math) {
        if (ch === '[') square++;
        else if (ch === ']' && square) square--;
        else if (ch === '(') round++;
        else if (ch === ')' && round) round--;
        else if (ch === '{') curly++;
        else if (ch === '}' && curly) curly--;
        if (ch === '|' && square === 0 && round === 0 && curly === 0) out += '\\';
      }
      out += ch;
    }
    return out.trim();
  }

  function separatorFor(align) {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  }

  function serialize(model) {
    const clean = normalizeModel(model, { ensureBodyRow: false });
    const width = clean.header.length;
    function line(cells) {
      const values = [];
      for (let i = 0; i < width; i++) values.push(escapeCell(cells[i] || ''));
      return '| ' + values.join(' | ') + ' |';
    }
    const output = [
      line(clean.header),
      '| ' + clean.align.map(separatorFor).join(' | ') + ' |',
    ];
    clean.rows.forEach(function (row) { output.push(line(row)); });
    return output.join('\n');
  }

  function createDefault(columns, totalRows, headerPrefix) {
    const colCount = Math.max(1, Math.min(40, Number(columns) || 3));
    const rowCount = Math.max(2, Math.min(200, Number(totalRows) || 3));
    const prefix = headerPrefix === undefined || headerPrefix === null
      ? '列'
      : String(headerPrefix);
    const header = [];
    for (let i = 0; i < colCount; i++) {
      header.push(prefix ? prefix + ' ' + (i + 1) : '');
    }
    const rows = [];
    for (let r = 1; r < rowCount; r++) rows.push(new Array(colCount).fill(''));
    return { header: header, rows: rows, align: new Array(colCount).fill('') };
  }

  function parseCsvLine(line, delimiter) {
    const out = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === delimiter && !quoted) {
        out.push(value);
        value = '';
      } else {
        value += ch;
      }
    }
    out.push(value);
    return out;
  }

  function parseDelimited(value) {
    const source = normalizeNewlines(value).replace(/\n+$/, '');
    const markdown = parse(source, { allowTrailingContent: false, ensureBodyRow: false });
    if (markdown.ok) return markdown.model;
    const lines = source.split('\n');
    const delimiter = source.indexOf('\t') >= 0 ? '\t' : (source.indexOf(',') >= 0 ? ',' : null);
    const rows = lines.map(function (line) {
      return delimiter ? parseCsvLine(line, delimiter) : [line];
    });
    return normalizeModel({
      header: rows.shift() || [''],
      rows: rows,
      align: [],
    }, { ensureBodyRow: false });
  }

  function findTables(value) {
    const source = normalizeNewlines(value);
    const lines = source.split('\n');
    const offsets = [];
    let cursor = 0;
    lines.forEach(function (line) {
      offsets.push(cursor);
      cursor += line.length + 1;
    });
    const found = [];
    let i = 0;
    while (i + 1 < lines.length) {
      const parsed = parseLines(lines, i, { ensureBodyRow: false });
      if (!parsed.ok) { i++; continue; }
      const endLine = parsed.endLine;
      const endOffset = endLine >= lines.length ? source.length : Math.max(0, offsets[endLine] - 1);
      found.push({
        startLine: i,
        endLine: endLine,
        startOffset: offsets[i],
        endOffset: endOffset,
        markdown: source.slice(offsets[i], endOffset),
        model: parsed.model,
      });
      i = endLine;
    }
    return found;
  }

  global.MarkdownTable = {
    normalizeNewlines: normalizeNewlines,
    cloneModel: cloneModel,
    normalizeModel: normalizeModel,
    splitRow: splitRow,
    rowHasDelimiter: rowHasDelimiter,
    isSeparatorLine: isSeparatorLine,
    parseLines: parseLines,
    parse: parse,
    serialize: serialize,
    createDefault: createDefault,
    parseDelimited: parseDelimited,
    findTables: findTables,
  };
})(window);

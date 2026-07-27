(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumNodeMatrix = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_ROWS = 20;
  const MAX_COLUMNS = 20;
  const MAX_CELLS = 100;
  const MIN_NODE_WIDTH = 80;
  const MAX_NODE_WIDTH = 1180;
  const MAX_AFFIX_LENGTH = 40;
  const ALLOWED_KINDS = new Set(['card', 'sticky', 'index', 'preview', 'code']);
  const GAP_PRESETS = {
    compact: { x: 24, y: 20 },
    standard: { x: 48, y: 36 },
    loose: { x: 80, y: 60 },
  };

  function matrixError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details || {};
    return error;
  }

  function integer(value, code, message) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw matrixError(code, message);
    return number;
  }

  function boundedInteger(value, min, max, code, message) {
    const number = integer(value, code, message);
    if (number < min || number > max) {
      throw matrixError(code, message, { min: min, max: max, value: number });
    }
    return number;
  }

  function rowIsEmpty(cells) {
    return cells.every(function (cell) { return cell === ''; });
  }

  function parsePastedGrid(value) {
    const normalized = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    if (!normalized) return { rows: 0, columns: 0, values: [] };
    const rows = normalized.split('\n').map(function (line) { return line.split('\t'); });
    while (rows.length && rowIsEmpty(rows[rows.length - 1])) rows.pop();
    if (!rows.length) return { rows: 0, columns: 0, values: [] };
    const columns = rows.reduce(function (max, row) {
      return Math.max(max, row.length);
    }, 0);
    const values = rows.map(function (row) {
      const next = row.slice();
      while (next.length < columns) next.push('');
      return next;
    });
    return { rows: values.length, columns: columns, values: values };
  }

  function normalizeConfig(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const contentMode = input.contentMode === 'blank' || input.contentMode === 'paste'
      ? input.contentMode
      : 'sequence';
    let pasted = null;
    let rows;
    let columns;
    if (contentMode === 'paste') {
      pasted = parsePastedGrid(input.pasteText);
      if (!pasted.rows || !pasted.columns) {
        throw matrixError('EMPTY_PASTE', '请粘贴至少一个单元格。');
      }
      rows = pasted.rows;
      columns = pasted.columns;
    } else {
      rows = boundedInteger(
        input.rows == null ? 3 : input.rows,
        1,
        MAX_ROWS,
        'INVALID_ROWS',
        '行数必须是 1–20 之间的整数。',
      );
      columns = boundedInteger(
        input.columns == null ? 3 : input.columns,
        1,
        MAX_COLUMNS,
        'INVALID_COLUMNS',
        '列数必须是 1–20 之间的整数。',
      );
    }
    if (rows > MAX_ROWS || columns > MAX_COLUMNS) {
      throw matrixError('GRID_TOO_LARGE', '粘贴内容最多支持 20 行、20 列。', {
        rows: rows,
        columns: columns,
      });
    }
    const count = rows * columns;
    if (count > MAX_CELLS) {
      throw matrixError('TOO_MANY_CELLS', '一次最多生成 100 个节点。', {
        rows: rows,
        columns: columns,
        count: count,
      });
    }

    const kind = ALLOWED_KINDS.has(input.kind) ? input.kind : 'card';
    const order = input.order === 'column' ? 'column' : 'row';
    const start = integer(
      input.start == null ? 1 : input.start,
      'INVALID_START',
      '起始编号必须是整数。',
    );
    const prefix = String(input.prefix == null ? '' : input.prefix);
    const suffix = String(input.suffix == null ? '.' : input.suffix);
    if (prefix.length > MAX_AFFIX_LENGTH || suffix.length > MAX_AFFIX_LENGTH) {
      throw matrixError('AFFIX_TOO_LONG', '编号前缀和后缀最多各 40 个字符。');
    }

    const gapPreset = Object.prototype.hasOwnProperty.call(GAP_PRESETS, input.gapPreset)
      ? input.gapPreset
      : 'standard';
    let gapX = GAP_PRESETS[gapPreset].x;
    let gapY = GAP_PRESETS[gapPreset].y;
    if (input.gapPreset === 'custom') {
      gapX = boundedInteger(
        input.gapX,
        0,
        400,
        'INVALID_GAP_X',
        '水平间距必须是 0–400 之间的整数。',
      );
      gapY = boundedInteger(
        input.gapY,
        0,
        400,
        'INVALID_GAP_Y',
        '垂直间距必须是 0–400 之间的整数。',
      );
    }

    const widthMode = input.widthMode === 'custom' ? 'custom' : 'auto';
    const width = widthMode === 'custom'
      ? boundedInteger(
        input.width,
        MIN_NODE_WIDTH,
        MAX_NODE_WIDTH,
        'INVALID_WIDTH',
        '节点宽度必须是 80–1180 之间的整数。',
      )
      : null;

    return {
      rows: rows,
      columns: columns,
      count: count,
      kind: kind,
      contentMode: contentMode,
      order: order,
      start: start,
      prefix: prefix,
      suffix: suffix,
      pasted: pasted,
      gapPreset: input.gapPreset === 'custom' ? 'custom' : gapPreset,
      gapX: gapX,
      gapY: gapY,
      widthMode: widthMode,
      width: width,
    };
  }

  function buildCells(raw) {
    const config = normalizeConfig(raw);
    const cells = [];
    for (let row = 0; row < config.rows; row += 1) {
      for (let column = 0; column < config.columns; column += 1) {
        let text = '';
        if (config.contentMode === 'sequence') {
          const offset = config.order === 'column'
            ? column * config.rows + row
            : row * config.columns + column;
          text = config.prefix + String(config.start + offset) + config.suffix;
        } else if (config.contentMode === 'paste') {
          text = config.pasted.values[row][column];
        }
        cells.push({ row: row, column: column, text: text });
      }
    }
    return { config: config, cells: cells };
  }

  function resolveUniformWidth(widths, rawConfig, limits) {
    const config = rawConfig && rawConfig.count ? rawConfig : normalizeConfig(rawConfig);
    const min = Math.max(
      MIN_NODE_WIDTH,
      Number(limits && limits.min) || MIN_NODE_WIDTH,
    );
    const max = Math.min(
      MAX_NODE_WIDTH,
      Number(limits && limits.max) || MAX_NODE_WIDTH,
    );
    if (config.widthMode === 'custom') return Math.max(min, Math.min(max, config.width));
    const measured = (Array.isArray(widths) ? widths : []).reduce(function (largest, value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(largest, number) : largest;
    }, min);
    return Math.max(min, Math.min(max, Math.ceil(measured)));
  }

  function layout(sizes, rawConfig, center) {
    const config = rawConfig && rawConfig.count ? rawConfig : normalizeConfig(rawConfig);
    if (!Array.isArray(sizes) || sizes.length !== config.count) {
      throw matrixError('INVALID_SIZES', '节点尺寸数量与矩阵不一致。');
    }
    const point = center && Number.isFinite(Number(center.x)) && Number.isFinite(Number(center.y))
      ? { x: Number(center.x), y: Number(center.y) }
      : { x: 0, y: 0 };
    const columnWidths = new Array(config.columns).fill(0);
    const rowHeights = new Array(config.rows).fill(0);
    const normalizedSizes = sizes.map(function (size, index) {
      const width = Number(size && size.width);
      const height = Number(size && size.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw matrixError('INVALID_SIZE', '节点尺寸必须是正数。', { index: index });
      }
      const row = Math.floor(index / config.columns);
      const column = index % config.columns;
      columnWidths[column] = Math.max(columnWidths[column], width);
      rowHeights[row] = Math.max(rowHeights[row], height);
      return { width: width, height: height };
    });
    const totalWidth = columnWidths.reduce(function (sum, width) { return sum + width; }, 0)
      + config.gapX * Math.max(0, config.columns - 1);
    const totalHeight = rowHeights.reduce(function (sum, height) { return sum + height; }, 0)
      + config.gapY * Math.max(0, config.rows - 1);
    const columnStarts = [];
    const rowStarts = [];
    let cursor = point.x - totalWidth / 2;
    columnWidths.forEach(function (width, index) {
      columnStarts[index] = cursor;
      cursor += width + config.gapX;
    });
    cursor = point.y - totalHeight / 2;
    rowHeights.forEach(function (height, index) {
      rowStarts[index] = cursor;
      cursor += height + config.gapY;
    });
    const items = normalizedSizes.map(function (size, index) {
      const row = Math.floor(index / config.columns);
      const column = index % config.columns;
      return {
        row: row,
        column: column,
        x: columnStarts[column] + (columnWidths[column] - size.width) / 2,
        y: rowStarts[row] + (rowHeights[row] - size.height) / 2,
        width: size.width,
        height: size.height,
      };
    });
    return {
      items: items,
      width: totalWidth,
      height: totalHeight,
      bounds: {
        x: point.x - totalWidth / 2,
        y: point.y - totalHeight / 2,
        width: totalWidth,
        height: totalHeight,
      },
      columnWidths: columnWidths,
      rowHeights: rowHeights,
    };
  }

  return {
    MAX_ROWS: MAX_ROWS,
    MAX_COLUMNS: MAX_COLUMNS,
    MAX_CELLS: MAX_CELLS,
    MIN_NODE_WIDTH: MIN_NODE_WIDTH,
    MAX_NODE_WIDTH: MAX_NODE_WIDTH,
    GAP_PRESETS: GAP_PRESETS,
    normalizeConfig: normalizeConfig,
    parsePastedGrid: parsePastedGrid,
    buildCells: buildCells,
    resolveUniformWidth: resolveUniformWidth,
    layout: layout,
  };
});

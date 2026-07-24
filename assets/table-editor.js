// 可复用二维网格编辑器。
// 当前适配 Markdown 表格；未来矩阵工具只需替换 parse / serialize 适配器。
(function (global) {
  'use strict';

  const controllers = new Set();
  let dragController = null;
  let contextMenuController = null;

  function language() {
    return document.documentElement.dataset.uiLanguage === 'en' ? 'en' : 'zh-CN';
  }

  const COPY = {
    'zh-CN': {
      table: '表格', title: '表格标题（可选）', open: '放大编辑（F）',
      addRow: '增加行', addCol: '增加列', deleteRow: '删除行', deleteCol: '删除列',
      clear: '清空', left: '左对齐', center: '居中', right: '右对齐',
      source: 'Markdown 源码', grid: '返回网格', copyMd: '复制 Markdown',
      extract: '提取为独立表格', close: '完成', invalid: '源码不是有效的 Markdown 表格',
      editCell: '双击编辑单元格', row: '行', column: '列',
      canvasDisplay: '画布显示', showTitleBar: '显示标题栏', appearance: '外观',
      standard: '默认表格', matrix: '矩阵', matrixBracket: '矩阵边框',
      roundBracket: '圆括号', squareBracket: '方括号', determinantBracket: '行列式',
      titleDragHint: '拖动表格；双击编辑标题',
      deleteSelectedRows: '删除所选行', deleteSelectedColumns: '删除所选列',
      deleteMenu: '删除表格行或列',
    },
    en: {
      table: 'Table', title: 'Table title (optional)', open: 'Open table studio (F)',
      addRow: 'Add row', addCol: 'Add column', deleteRow: 'Delete row', deleteCol: 'Delete column',
      clear: 'Clear', left: 'Align left', center: 'Center', right: 'Align right',
      source: 'Markdown source', grid: 'Back to grid', copyMd: 'Copy Markdown',
      extract: 'Extract as standalone table', close: 'Done', invalid: 'This is not a valid Markdown table',
      editCell: 'Double-click to edit cell', row: 'Row', column: 'Column',
      canvasDisplay: 'Canvas display', showTitleBar: 'Show title bar', appearance: 'Appearance',
      standard: 'Standard', matrix: 'Matrix', matrixBracket: 'Matrix brackets',
      roundBracket: 'Parentheses', squareBracket: 'Square brackets', determinantBracket: 'Determinant',
      titleDragHint: 'Drag table; double-click to edit title',
      deleteSelectedRows: 'Delete selected rows', deleteSelectedColumns: 'Delete selected columns',
      deleteMenu: 'Delete table rows or columns',
    },
  };

  function t(key) {
    const lang = language();
    return (COPY[lang] && COPY[lang][key]) || COPY['zh-CN'][key] || key;
  }

  function cellName(index) {
    let n = Math.max(0, Number(index) || 0);
    let out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderInline(value) {
    const source = String(value == null ? '' : value);
    const md = global.MarkdownMini;
    if (md && typeof md.render === 'function') {
      const wrap = document.createElement('div');
      wrap.innerHTML = md.render(source);
      if (wrap.children.length === 1 && wrap.firstElementChild
          && wrap.firstElementChild.tagName === 'P') {
        return wrap.firstElementChild.innerHTML;
      }
      // 单元格只允许行内语义；若完整解析器识别成标题/列表等块结构，
      // 回退为安全行内渲染，不把块级 Markdown 偷渡进网格。
      if (typeof md.renderInline === 'function') return md.renderInline(source);
      return escapeHtml(source);
    }
    if (md && typeof md.renderInline === 'function') return md.renderInline(source);
    return escapeHtml(value);
  }

  function clearHostMath(host) {
    const canvas = global.CanvasModule;
    if (!host || !canvas || typeof canvas.clearMarkdownMath !== 'function') return;
    host.querySelectorAll('[data-has-math="1"]').forEach(function (el) {
      canvas.clearMarkdownMath(el);
    });
  }

  function scheduleInlineMath(el, source) {
    const canvas = global.CanvasModule;
    if (!el || !canvas || typeof canvas.scheduleMarkdownMath !== 'function') return;
    canvas.scheduleMarkdownMath(el, source);
  }

  function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () { return true; }).catch(function () { return false; });
    }
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    area.remove();
    return Promise.resolve(ok);
  }

  function normalizeSelection(selection, rows, cols) {
    const source = selection || { r1: 0, c1: 0, r2: 0, c2: 0 };
    const maxRow = Math.max(0, rows - 1);
    const maxCol = Math.max(0, cols - 1);
    const r1 = Math.max(0, Math.min(maxRow, Number(source.r1) || 0));
    const r2 = Math.max(0, Math.min(maxRow, Number(source.r2) || 0));
    const c1 = Math.max(0, Math.min(maxCol, Number(source.c1) || 0));
    const c2 = Math.max(0, Math.min(maxCol, Number(source.c2) || 0));
    return {
      r1: Math.min(r1, r2), r2: Math.max(r1, r2),
      c1: Math.min(c1, c2), c2: Math.max(c1, c2),
    };
  }

  function TableGrid(host, options) {
    this.host = host;
    this.options = options || {};
    const syntax = global.MarkdownTable;
    const parsed = syntax && syntax.parse(this.options.markdown || '', { ensureBodyRow: false });
    this.model = parsed && parsed.ok
      ? parsed.model
      : (syntax ? syntax.createDefault(3, 3, '')
        : { header: ['', '', ''], rows: [['', '', ''], ['', '', '']], align: ['', '', ''] });
    this.selection = { r1: 0, c1: 0, r2: 0, c2: 0 };
    this.anchor = { row: 0, col: 0 };
    this.editing = null;
    this.destroyed = false;
    this.lastCommitted = syntax ? syntax.serialize(this.model) : String(this.options.markdown || '');
    this.sourceMode = false;
    controllers.add(this);
    this.render();
  }

  TableGrid.prototype.rows = function () {
    return [this.model.header].concat(this.model.rows);
  };

  TableGrid.prototype.rowCount = function () {
    return this.model.rows.length + 1;
  };

  TableGrid.prototype.colCount = function () {
    return Math.max(1, this.model.header.length);
  };

  TableGrid.prototype.cell = function (row, col) {
    const target = row === 0 ? this.model.header : this.model.rows[row - 1];
    return target && target[col] != null ? String(target[col]) : '';
  };

  TableGrid.prototype.setCell = function (row, col, value) {
    const target = row === 0 ? this.model.header : this.model.rows[row - 1];
    if (target) target[col] = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
  };

  TableGrid.prototype.bounds = function () {
    return normalizeSelection(this.selection, this.rowCount(), this.colCount());
  };

  TableGrid.prototype.markSelection = function () {
    const bounds = this.bounds();
    this.root.querySelectorAll('[data-table-cell]').forEach(function (cell) {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      cell.classList.toggle('selected', row >= bounds.r1 && row <= bounds.r2 && col >= bounds.c1 && col <= bounds.c2);
      cell.classList.toggle('active', row === bounds.r1 && col === bounds.c1);
    });
    this.root.querySelectorAll('[data-table-row-head]').forEach(function (head) {
      const row = Number(head.dataset.tableRowHead);
      head.classList.toggle('selected', bounds.c1 === 0 && bounds.c2 === this.colCount() - 1
        && row >= bounds.r1 && row <= bounds.r2);
    }, this);
    this.root.querySelectorAll('[data-table-col-head]').forEach(function (head) {
      const col = Number(head.dataset.tableColHead);
      head.classList.toggle('selected', bounds.r1 === 0 && bounds.r2 === this.rowCount() - 1
        && col >= bounds.c1 && col <= bounds.c2);
    }, this);
  };

  TableGrid.prototype.select = function (row, col, extend) {
    this.finishCellEdit('selection');
    if (extend) {
      this.selection = { r1: this.anchor.row, c1: this.anchor.col, r2: row, c2: col };
    } else {
      this.anchor = { row: row, col: col };
      this.selection = { r1: row, c1: col, r2: row, c2: col };
    }
    this.selection = normalizeSelection(this.selection, this.rowCount(), this.colCount());
    this.markSelection();
    if (this.root && document.activeElement !== this.root) this.root.focus({ preventScroll: true });
    if (typeof this.options.onSelect === 'function') this.options.onSelect();
  };

  TableGrid.prototype.selectRow = function (row, extend) {
    this.finishCellEdit('selection');
    if (extend) {
      this.selection = {
        r1: this.anchor.row,
        c1: 0,
        r2: row,
        c2: this.colCount() - 1,
      };
    } else {
      this.anchor = { row: row, col: 0 };
      this.selection = { r1: row, c1: 0, r2: row, c2: this.colCount() - 1 };
    }
    this.selection = normalizeSelection(this.selection, this.rowCount(), this.colCount());
    this.markSelection();
    this.root.focus({ preventScroll: true });
  };

  TableGrid.prototype.selectColumn = function (col, extend) {
    this.finishCellEdit('selection');
    if (extend) {
      this.selection = {
        r1: 0,
        c1: this.anchor.col,
        r2: this.rowCount() - 1,
        c2: col,
      };
    } else {
      this.anchor = { row: 0, col: col };
      this.selection = { r1: 0, c1: col, r2: this.rowCount() - 1, c2: col };
    }
    this.selection = normalizeSelection(this.selection, this.rowCount(), this.colCount());
    this.markSelection();
    this.root.focus({ preventScroll: true });
  };

  TableGrid.prototype.startCellEdit = function (row, col, replaceText) {
    this.finishCellEdit('switch');
    const cell = this.root.querySelector('[data-table-cell][data-row="' + row + '"][data-col="' + col + '"]');
    if (!cell) return;
    this.anchor = { row: row, col: col };
    this.selection = { r1: row, c1: col, r2: row, c2: col };
    this.markSelection();
    const display = cell.querySelector('.table-cell-value');
    const input = document.createElement('textarea');
    input.className = 'table-cell-input';
    input.rows = 1;
    input.spellcheck = false;
    input.value = replaceText == null ? this.cell(row, col) : String(replaceText);
    if (display) display.hidden = true;
    cell.appendChild(input);
    cell.classList.add('editing');
    this.editing = { row: row, col: col, input: input, original: this.cell(row, col) };
    input.addEventListener('input', function () {
      this.setCell(row, col, input.value);
    }.bind(this));
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.setCell(row, col, this.editing.original);
        this.finishCellEdit('cancel', false);
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.finishCellEdit('keyboard');
        const delta = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : (event.shiftKey ? -this.colCount() : this.colCount());
        this.moveLinear(delta, true);
      }
    }.bind(this));
    input.addEventListener('blur', function () {
      if (this.editing && this.editing.input === input) this.finishCellEdit('blur');
    }.bind(this));
    input.focus({ preventScroll: true });
    if (replaceText == null) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  };

  TableGrid.prototype.finishCellEdit = function (reason, shouldCommit) {
    if (!this.editing) return;
    const state = this.editing;
    this.setCell(state.row, state.col, state.input.value);
    const cell = state.input.closest('[data-table-cell]');
    const display = cell && cell.querySelector('.table-cell-value');
    if (display) {
      display.innerHTML = renderInline(this.cell(state.row, state.col));
      display.hidden = false;
      scheduleInlineMath(display, this.cell(state.row, state.col));
    }
    if (cell) cell.classList.remove('editing');
    // remove() 会同步触发 blur；先清空状态，让 blur 路径成为安全的空操作。
    this.editing = null;
    if (state.input.isConnected) state.input.remove();
    if (shouldCommit !== false) this.commit(reason || 'cell');
  };

  TableGrid.prototype.moveLinear = function (delta, edit) {
    const bounds = this.bounds();
    let index = bounds.r1 * this.colCount() + bounds.c1 + delta;
    if (index >= this.rowCount() * this.colCount()) {
      this.addRow(false);
    }
    index = Math.max(0, Math.min(this.rowCount() * this.colCount() - 1, index));
    const row = Math.floor(index / this.colCount());
    const col = index % this.colCount();
    this.select(row, col, false);
    const cell = this.root.querySelector('[data-table-cell][data-row="' + row + '"][data-col="' + col + '"]');
    if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (edit) this.startCellEdit(row, col);
  };

  TableGrid.prototype.commit = function (reason) {
    const syntax = global.MarkdownTable;
    if (!syntax) return;
    const markdown = syntax.serialize(this.model);
    if (markdown === this.lastCommitted) return;
    const previous = this.lastCommitted;
    this.lastCommitted = markdown;
    if (typeof this.options.onCommit === 'function') {
      this.options.onCommit(markdown, { reason: reason || 'edit', previous: previous });
    }
  };

  TableGrid.prototype.addRow = function (afterSelection) {
    this.finishCellEdit('structure');
    const bounds = this.bounds();
    const at = afterSelection === false ? this.model.rows.length : Math.max(0, bounds.r2);
    this.model.rows.splice(at, 0, new Array(this.colCount()).fill(''));
    this.selection = { r1: at + 1, c1: bounds.c1, r2: at + 1, c2: bounds.c1 };
    this.anchor = { row: at + 1, col: bounds.c1 };
    this.render();
    this.commit('add-row');
  };

  TableGrid.prototype.addColumn = function (atEnd) {
    this.finishCellEdit('structure');
    const bounds = this.bounds();
    const at = atEnd ? this.colCount() : Math.min(this.colCount(), bounds.c2 + 1);
    this.model.header.splice(at, 0, '');
    this.model.rows.forEach(function (row) { row.splice(at, 0, ''); });
    this.model.align.splice(at, 0, '');
    this.selection = { r1: bounds.r1, c1: at, r2: bounds.r1, c2: at };
    this.anchor = { row: bounds.r1, col: at };
    this.render();
    this.commit('add-column');
  };

  TableGrid.prototype.deleteRows = function () {
    this.finishCellEdit('structure');
    const bounds = this.bounds();
    const first = Math.max(1, bounds.r1);
    const last = Math.max(first, bounds.r2);
    if (bounds.r2 < 1) return;
    this.model.rows.splice(first - 1, last - first + 1);
    const row = Math.min(first, this.rowCount() - 1);
    this.selection = { r1: row, c1: bounds.c1, r2: row, c2: bounds.c1 };
    this.anchor = { row: row, col: bounds.c1 };
    this.render();
    this.commit('delete-row');
  };

  TableGrid.prototype.deleteColumns = function () {
    this.finishCellEdit('structure');
    if (this.colCount() <= 1) return;
    const bounds = this.bounds();
    const count = Math.min(this.colCount() - 1, bounds.c2 - bounds.c1 + 1);
    this.model.header.splice(bounds.c1, count);
    this.model.rows.forEach(function (row) { row.splice(bounds.c1, count); });
    this.model.align.splice(bounds.c1, count);
    const col = Math.min(bounds.c1, this.colCount() - 1);
    this.selection = { r1: bounds.r1, c1: col, r2: bounds.r1, c2: col };
    this.anchor = { row: bounds.r1, col: col };
    this.render();
    this.commit('delete-column');
  };

  TableGrid.prototype.clearSelection = function () {
    this.finishCellEdit('clear');
    const bounds = this.bounds();
    for (let row = bounds.r1; row <= bounds.r2; row++) {
      for (let col = bounds.c1; col <= bounds.c2; col++) this.setCell(row, col, '');
    }
    this.render();
    this.commit('clear');
  };

  TableGrid.prototype.alignSelection = function (align) {
    this.finishCellEdit('align');
    const bounds = this.bounds();
    for (let col = bounds.c1; col <= bounds.c2; col++) this.model.align[col] = align;
    this.render();
    this.commit('align');
  };

  TableGrid.prototype.selectionText = function () {
    const bounds = this.bounds();
    const rows = this.rows();
    const output = [];
    for (let row = bounds.r1; row <= bounds.r2; row++) {
      const line = [];
      for (let col = bounds.c1; col <= bounds.c2; col++) line.push(rows[row][col] || '');
      output.push(line.join('\t'));
    }
    return output.join('\n');
  };

  TableGrid.prototype.pasteText = function (value) {
    this.finishCellEdit('paste');
    const syntax = global.MarkdownTable;
    if (!syntax) return;
    const incoming = syntax.parseDelimited(value);
    const rows = [incoming.header].concat(incoming.rows);
    const bounds = this.bounds();
    const neededRows = bounds.r1 + rows.length;
    const neededCols = bounds.c1 + (rows.reduce(function (max, row) { return Math.max(max, row.length); }, 0));
    while (this.rowCount() < neededRows) this.model.rows.push(new Array(this.colCount()).fill(''));
    while (this.colCount() < neededCols) {
      this.model.header.push('');
      this.model.rows.forEach(function (row) { row.push(''); });
      this.model.align.push('');
    }
    rows.forEach(function (row, rowIndex) {
      row.forEach(function (cell, colIndex) {
        this.setCell(bounds.r1 + rowIndex, bounds.c1 + colIndex, cell);
      }, this);
    }, this);
    this.selection = {
      r1: bounds.r1,
      c1: bounds.c1,
      r2: bounds.r1 + rows.length - 1,
      c2: bounds.c1 + Math.max(0, neededCols - bounds.c1 - 1),
    };
    this.render();
    this.commit('paste');
  };

  TableGrid.prototype.closeContextMenu = function (restoreFocus) {
    const menu = this.contextMenu;
    if (!menu) return;
    document.removeEventListener('pointerdown', this.contextMenuPointerHandler, true);
    document.removeEventListener('scroll', this.contextMenuViewportHandler, true);
    window.removeEventListener('resize', this.contextMenuViewportHandler);
    menu.remove();
    this.contextMenu = null;
    this.contextMenuPointerHandler = null;
    this.contextMenuViewportHandler = null;
    if (contextMenuController === this) contextMenuController = null;
    if (restoreFocus && this.root && this.root.isConnected) this.root.focus({ preventScroll: true });
  };

  TableGrid.prototype.openContextMenu = function (clientX, clientY) {
    if (!this.options.compact || this.destroyed) return;
    if (contextMenuController && contextMenuController !== this) {
      contextMenuController.closeContextMenu(false);
    }
    this.closeContextMenu(false);

    const bounds = this.bounds();
    const menu = document.createElement('div');
    menu.className = 'table-grid-context-menu';
    menu.tabIndex = -1;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('deleteMenu'));

    const actions = [
      {
        label: t('deleteSelectedRows'),
        disabled: bounds.r2 < 1,
        run: this.deleteRows.bind(this),
      },
      {
        label: t('deleteSelectedColumns'),
        disabled: this.colCount() <= 1,
        run: this.deleteColumns.bind(this),
      },
    ];
    actions.forEach(function (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = action.label;
      button.disabled = action.disabled;
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        this.closeContextMenu(false);
        action.run();
        if (this.root && this.root.isConnected) this.root.focus({ preventScroll: true });
      }.bind(this));
      menu.appendChild(button);
    }, this);
    menu.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    menu.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
    menu.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeContextMenu(true);
    }.bind(this));

    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(Number(clientX) || margin, window.innerWidth - menuRect.width - margin));
    const top = Math.max(margin, Math.min(Number(clientY) || margin, window.innerHeight - menuRect.height - margin));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    this.contextMenu = menu;
    contextMenuController = this;
    this.contextMenuPointerHandler = function (event) {
      if (!menu.contains(event.target)) this.closeContextMenu(false);
    }.bind(this);
    this.contextMenuViewportHandler = this.closeContextMenu.bind(this, false);
    document.addEventListener('pointerdown', this.contextMenuPointerHandler, true);
    document.addEventListener('scroll', this.contextMenuViewportHandler, true);
    window.addEventListener('resize', this.contextMenuViewportHandler);

    const firstEnabled = menu.querySelector('button:not(:disabled)');
    (firstEnabled || menu).focus({ preventScroll: true });
  };

  TableGrid.prototype.onKeyDown = function (event) {
    if (this.editing || this.sourceMode) return;
    const bounds = this.bounds();
    const ctrl = event.ctrlKey || event.metaKey;
    const deleteMenuKey = event.key === '-' || event.key === '_'
      || event.code === 'Minus' || event.code === 'NumpadSubtract';
    if (this.options.compact && ctrl && !event.altKey && deleteMenuKey) {
      event.preventDefault();
      event.stopPropagation();
      const cell = this.root.querySelector('[data-table-cell][data-row="' + bounds.r1
        + '"][data-col="' + bounds.c1 + '"]');
      const rect = cell ? cell.getBoundingClientRect() : this.root.getBoundingClientRect();
      this.openContextMenu(rect.left + Math.min(24, rect.width / 2), rect.bottom + 5);
      return;
    }
    if (ctrl && !event.shiftKey && (event.key === 'z' || event.key === 'Z')
        && typeof this.options.onUndo === 'function') {
      event.preventDefault();
      event.stopPropagation();
      this.options.onUndo();
      return;
    }
    if (ctrl && ((event.key === 'y' || event.key === 'Y')
        || (event.shiftKey && (event.key === 'z' || event.key === 'Z')))
        && typeof this.options.onRedo === 'function') {
      event.preventDefault();
      event.stopPropagation();
      this.options.onRedo();
      return;
    }
    if (ctrl && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      copyText(this.selectionText());
      return;
    }
    if (ctrl && (event.key === 'x' || event.key === 'X')) {
      event.preventDefault();
      copyText(this.selectionText());
      this.clearSelection();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !ctrl) {
      event.preventDefault();
      event.stopPropagation();
      this.clearSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      this.startCellEdit(bounds.r1, bounds.c1);
      return;
    }
    if ((event.key === 'f' || event.key === 'F') && !ctrl && !event.altKey && typeof this.options.onOpenStudio === 'function') {
      event.preventDefault();
      event.stopPropagation();
      this.options.onOpenStudio();
      return;
    }
    const moves = {
      ArrowLeft: [0, -1], ArrowRight: [0, 1],
      ArrowUp: [-1, 0], ArrowDown: [1, 0],
    };
    if (moves[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      const move = moves[event.key];
      const row = Math.max(0, Math.min(this.rowCount() - 1, bounds.r1 + move[0]));
      const col = Math.max(0, Math.min(this.colCount() - 1, bounds.c1 + move[1]));
      this.select(row, col, event.shiftKey);
      return;
    }
    if (!ctrl && !event.altKey && event.key.length === 1 && event.key !== ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.startCellEdit(bounds.r1, bounds.c1, event.key);
    }
  };

  TableGrid.prototype.renderToolbar = function (root) {
    const toolbar = document.createElement('div');
    toolbar.className = 'table-grid-toolbar';
    const actions = [
      ['add-row', '+ ' + t('addRow'), this.addRow.bind(this, true)],
      ['add-col', '+ ' + t('addCol'), this.addColumn.bind(this)],
      ['delete-row', t('deleteRow'), this.deleteRows.bind(this)],
      ['delete-col', t('deleteCol'), this.deleteColumns.bind(this)],
      ['clear', t('clear'), this.clearSelection.bind(this)],
      ['align-left', t('left'), this.alignSelection.bind(this, 'left')],
      ['align-center', t('center'), this.alignSelection.bind(this, 'center')],
      ['align-right', t('right'), this.alignSelection.bind(this, 'right')],
    ];
    actions.forEach(function (entry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tableAction = entry[0];
      button.textContent = entry[1];
      button.addEventListener('mousedown', function (event) { event.stopPropagation(); });
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        entry[2]();
      });
      toolbar.appendChild(button);
    });
    if (this.options.studio) {
      const source = document.createElement('button');
      source.type = 'button';
      source.dataset.tableAction = 'source';
      source.textContent = this.sourceMode ? t('grid') : t('source');
      source.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleSource();
      }.bind(this));
      toolbar.appendChild(source);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.dataset.tableAction = 'copy-markdown';
      copy.textContent = t('copyMd');
      copy.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        this.finishCellEdit('copy');
        copyText(global.MarkdownTable.serialize(this.model));
      }.bind(this));
      toolbar.appendChild(copy);
      if (typeof this.options.onExtract === 'function') {
        const extract = document.createElement('button');
        extract.type = 'button';
        extract.dataset.tableAction = 'extract';
        extract.textContent = t('extract');
        extract.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          this.finishCellEdit('extract');
          this.options.onExtract(global.MarkdownTable.serialize(this.model));
        }.bind(this));
        toolbar.appendChild(extract);
      }
    }
    root.appendChild(toolbar);
  };

  TableGrid.prototype.render = function () {
    if (this.destroyed) return;
    this.closeContextMenu(false);
    const host = this.host;
    clearHostMath(host);
    host.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'table-grid-root' + (this.options.compact ? ' compact' : ' studio');
    if (this.options.compact) {
      const appearance = this.options.appearance === 'matrix' ? 'matrix' : 'standard';
      const bracket = this.options.bracket === 'square' || this.options.bracket === 'determinant'
        ? this.options.bracket : 'round';
      root.dataset.tableAppearance = appearance;
      root.dataset.tableBracket = bracket;
      root.classList.toggle('table-chrome-hidden', !!this.options.chromeHidden);
    }
    root.tabIndex = 0;
    root.addEventListener('keydown', this.onKeyDown.bind(this));
    root.addEventListener('contextmenu', function (event) {
      if (!this.options.compact || this.editing || this.sourceMode) return;
      const cell = event.target.closest('[data-table-cell]');
      if (!cell || !root.contains(cell)) return;
      event.preventDefault();
      event.stopPropagation();
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      const bounds = this.bounds();
      const insideSelection = row >= bounds.r1 && row <= bounds.r2
        && col >= bounds.c1 && col <= bounds.c2;
      if (!insideSelection) this.select(row, col, false);
      else root.focus({ preventScroll: true });
      this.openContextMenu(event.clientX, event.clientY);
    }.bind(this));
    root.addEventListener('copy', function (event) {
      if (this.editing || this.sourceMode || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', this.selectionText());
    }.bind(this));
    root.addEventListener('cut', function (event) {
      if (this.editing || this.sourceMode || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', this.selectionText());
      this.clearSelection();
    }.bind(this));
    root.addEventListener('paste', function (event) {
      if (this.editing || this.sourceMode || !event.clipboardData) return;
      const value = event.clipboardData.getData('text/plain');
      if (!value) return;
      event.preventDefault();
      this.pasteText(value);
    }.bind(this));
    this.root = root;
    host.appendChild(root);

    if (this.options.compact) {
      const dragStrip = document.createElement('span');
      dragStrip.className = 'table-drag-strip';
      dragStrip.setAttribute('aria-hidden', 'true');
      root.appendChild(dragStrip);
      const head = document.createElement('div');
      head.className = 'table-object-head';
      const title = document.createElement('input');
      title.type = 'text';
      title.className = 'table-node-title';
      title.value = this.options.title || '';
      title.placeholder = t('title');
      title.title = t('titleDragHint');
      title.setAttribute('aria-label', t('title'));
      title.spellcheck = false;
      title.readOnly = true;
      title.addEventListener('mousedown', function (event) {
        if (!title.readOnly || event.detail > 1) event.stopPropagation();
      });
      title.addEventListener('dblclick', function (event) {
        event.preventDefault();
        event.stopPropagation();
        const selectionStart = title.selectionStart;
        const selectionEnd = title.selectionEnd;
        title.readOnly = false;
        title.classList.add('is-editing');
        title.focus({ preventScroll: true });
        if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd) && selectionEnd > selectionStart) {
          try { title.setSelectionRange(selectionStart, selectionEnd); } catch (e) {}
        } else {
          const end = title.value.length;
          try { title.setSelectionRange(end, end); } catch (e) {}
        }
      });
      title.addEventListener('keydown', function (event) {
        if (title.readOnly) return;
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
        else if (event.key === 'Escape') {
          event.preventDefault();
          title.value = String(this.options.title || '');
          title.blur();
        }
      }.bind(this));
      title.addEventListener('blur', function () {
        if (title.readOnly) return;
        const value = title.value.trim();
        if (value !== String(this.options.title || '').trim() && typeof this.options.onTitleCommit === 'function') {
          this.options.onTitleCommit(value);
          this.options.title = value;
        }
        title.readOnly = true;
        title.classList.remove('is-editing');
      }.bind(this));
      head.appendChild(title);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'table-open-studio';
      open.textContent = '↗';
      open.title = t('open');
      open.setAttribute('aria-label', t('open'));
      open.addEventListener('mousedown', function (event) { event.stopPropagation(); });
      open.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof this.options.onOpenStudio === 'function') this.options.onOpenStudio();
      }.bind(this));
      head.appendChild(open);
      root.appendChild(head);
    } else {
      this.renderToolbar(root);
    }

    const pane = document.createElement('div');
    pane.className = 'table-grid-pane';
    root.appendChild(pane);
    this.pane = pane;

    if (this.sourceMode) {
      this.renderSource(pane);
      return;
    }

    const scroll = document.createElement('div');
    scroll.className = 'table-grid-scroll';
    pane.appendChild(scroll);
    const table = document.createElement('table');
    table.className = 'table-grid';
    table.setAttribute('role', 'grid');
    scroll.appendChild(table);

    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'table-grid-corner';
    headRow.appendChild(corner);
    for (let col = 0; col < this.colCount(); col++) {
      const th = document.createElement('th');
      th.className = 'table-column-head';
      th.dataset.tableColHead = col;
      th.textContent = cellName(col);
      th.title = t('column') + ' ' + (col + 1);
      th.addEventListener('mousedown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        this.selectColumn(col, event.shiftKey);
        dragController = this;
      }.bind(this));
      headRow.appendChild(th);
    }
    table.appendChild(headRow);

    const rows = this.rows();
    rows.forEach(function (row, rowIndex) {
      const tr = document.createElement('tr');
      if (rowIndex === 0) tr.className = 'table-header-row';
      const rowHead = document.createElement('th');
      rowHead.className = 'table-row-head';
      rowHead.dataset.tableRowHead = rowIndex;
      rowHead.textContent = rowIndex === 0 ? 'H' : String(rowIndex);
      rowHead.title = rowIndex === 0 ? t('table') : t('row') + ' ' + rowIndex;
      rowHead.addEventListener('mousedown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        this.selectRow(rowIndex, event.shiftKey);
        dragController = this;
      }.bind(this));
      tr.appendChild(rowHead);
      for (let col = 0; col < this.colCount(); col++) {
        const td = document.createElement('td');
        td.dataset.tableCell = '1';
        td.dataset.row = rowIndex;
        td.dataset.col = col;
        td.style.textAlign = this.model.align[col] || '';
        const display = document.createElement('div');
        display.className = 'table-cell-value';
        display.innerHTML = renderInline(row[col] || '');
        td.appendChild(display);
        scheduleInlineMath(display, row[col] || '');
        td.addEventListener('mousedown', function (event) {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          this.select(rowIndex, col, event.shiftKey);
          dragController = this;
        }.bind(this));
        td.addEventListener('mouseenter', function () {
          if (dragController !== this) return;
          this.selection = { r1: this.anchor.row, c1: this.anchor.col, r2: rowIndex, c2: col };
          this.markSelection();
        }.bind(this));
        td.addEventListener('dblclick', function (event) {
          event.preventDefault();
          event.stopPropagation();
          this.startCellEdit(rowIndex, col);
        }.bind(this));
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }, this);

    const addColumn = document.createElement('button');
    addColumn.type = 'button';
    addColumn.className = 'table-edge-add table-edge-add-column';
    addColumn.textContent = '+';
    addColumn.title = t('addCol');
    addColumn.addEventListener('mousedown', function (event) { event.stopPropagation(); });
    addColumn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      this.addColumn(true);
    }.bind(this));
    pane.appendChild(addColumn);

    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'table-edge-add table-edge-add-row';
    addRow.textContent = '+';
    addRow.title = t('addRow');
    addRow.addEventListener('mousedown', function (event) { event.stopPropagation(); });
    addRow.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      this.addRow(false);
    }.bind(this));
    pane.appendChild(addRow);
    this.markSelection();
  };

  TableGrid.prototype.renderSource = function (pane) {
    const wrap = document.createElement('div');
    wrap.className = 'table-source-wrap';
    const area = document.createElement('textarea');
    area.className = 'table-source-editor';
    area.spellcheck = false;
    area.value = global.MarkdownTable.serialize(this.model);
    const error = document.createElement('div');
    error.className = 'table-source-error';
    error.hidden = true;
    area.addEventListener('input', function () { error.hidden = true; });
    area.addEventListener('keydown', function (event) { event.stopPropagation(); });
    wrap.appendChild(area);
    wrap.appendChild(error);
    pane.appendChild(wrap);
    this.sourceEditor = area;
    this.sourceError = error;
    area.focus({ preventScroll: true });
  };

  TableGrid.prototype.toggleSource = function () {
    this.finishCellEdit('source');
    if (!this.sourceMode) {
      this.sourceMode = true;
      this.render();
      return;
    }
    const value = this.sourceEditor ? this.sourceEditor.value : '';
    const parsed = global.MarkdownTable.parse(value, { ensureBodyRow: false });
    if (!parsed.ok) {
      if (this.sourceError) {
        this.sourceError.textContent = parsed.error || t('invalid');
        this.sourceError.hidden = false;
      }
      return;
    }
    this.model = parsed.model;
    this.sourceMode = false;
    this.render();
    this.commit('source');
  };

  TableGrid.prototype.destroy = function (commit) {
    if (this.destroyed) return;
    if (commit !== false) {
      if (this.sourceMode && this.sourceEditor) {
        const parsed = global.MarkdownTable.parse(this.sourceEditor.value, { ensureBodyRow: false });
        if (parsed.ok) this.model = parsed.model;
      }
      this.finishCellEdit('close');
      this.commit('close');
    }
    this.closeContextMenu(false);
    clearHostMath(this.host);
    this.destroyed = true;
    controllers.delete(this);
    if (dragController === this) dragController = null;
    if (this.host && this.host.__relatumTableGrid === this) delete this.host.__relatumTableGrid;
  };

  function mount(host, options) {
    if (!host) return null;
    if (host.__relatumTableGrid) host.__relatumTableGrid.destroy(false);
    const controller = new TableGrid(host, options || {});
    host.__relatumTableGrid = controller;
    return controller;
  }

  function openStudio(options) {
    options = options || {};
    const overlay = document.createElement('div');
    overlay.className = 'table-studio-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = document.createElement('section');
    card.className = 'table-studio-card';
    const head = document.createElement('header');
    head.className = 'table-studio-head';
    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'table-studio-title';
    title.value = options.title || '';
    title.placeholder = t('title');
    title.spellcheck = false;
    title.readOnly = options.titleEditable === false;
    if (title.readOnly) title.classList.add('readonly');
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'table-studio-close';
    close.textContent = t('close');
    head.appendChild(close);
    card.appendChild(head);

    if (options.viewOptionsEditable) {
      const viewState = {
        chromeHidden: !!options.chromeHidden,
        appearance: options.appearance === 'matrix' ? 'matrix' : 'standard',
        bracket: options.bracket === 'square' || options.bracket === 'determinant'
          ? options.bracket : 'round',
      };
      const controls = document.createElement('section');
      controls.className = 'table-studio-view-options';
      controls.setAttribute('aria-label', t('canvasDisplay'));

      const chromeLabel = document.createElement('label');
      chromeLabel.className = 'table-studio-chrome-toggle';
      const chromeCheckbox = document.createElement('input');
      chromeCheckbox.type = 'checkbox';
      chromeCheckbox.checked = !viewState.chromeHidden;
      const chromeText = document.createElement('span');
      chromeText.textContent = t('showTitleBar');
      chromeLabel.appendChild(chromeCheckbox);
      chromeLabel.appendChild(chromeText);
      controls.appendChild(chromeLabel);

      function makeChoice(value, label, group) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.value = value;
        button.textContent = label;
        button.addEventListener('click', function () {
          viewState[group] = value;
          if (group === 'appearance' && value === 'matrix') {
            viewState.chromeHidden = true;
            chromeCheckbox.checked = false;
          }
          syncChoices();
          if (typeof options.onViewCommit === 'function') {
            options.onViewCommit({
              chromeHidden: viewState.chromeHidden,
              appearance: viewState.appearance,
              bracket: viewState.bracket,
            });
          }
        });
        return button;
      }

      const appearanceGroup = document.createElement('div');
      appearanceGroup.className = 'table-studio-view-group';
      const appearanceLabel = document.createElement('span');
      appearanceLabel.className = 'table-studio-view-label';
      appearanceLabel.textContent = t('appearance');
      const appearanceChoices = document.createElement('div');
      appearanceChoices.className = 'table-studio-segmented';
      const standardButton = makeChoice('standard', t('standard'), 'appearance');
      const matrixButton = makeChoice('matrix', t('matrix'), 'appearance');
      appearanceChoices.appendChild(standardButton);
      appearanceChoices.appendChild(matrixButton);
      appearanceGroup.appendChild(appearanceLabel);
      appearanceGroup.appendChild(appearanceChoices);
      controls.appendChild(appearanceGroup);

      const bracketGroup = document.createElement('div');
      bracketGroup.className = 'table-studio-view-group table-studio-bracket-group';
      const bracketLabel = document.createElement('span');
      bracketLabel.className = 'table-studio-view-label';
      bracketLabel.textContent = t('matrixBracket');
      const bracketChoices = document.createElement('div');
      bracketChoices.className = 'table-studio-segmented table-studio-bracket-choices';
      const roundButton = makeChoice('round', t('roundBracket'), 'bracket');
      const squareButton = makeChoice('square', t('squareBracket'), 'bracket');
      const determinantButton = makeChoice('determinant', t('determinantBracket'), 'bracket');
      bracketChoices.appendChild(roundButton);
      bracketChoices.appendChild(squareButton);
      bracketChoices.appendChild(determinantButton);
      bracketGroup.appendChild(bracketLabel);
      bracketGroup.appendChild(bracketChoices);
      controls.appendChild(bracketGroup);

      function syncChoices() {
        [standardButton, matrixButton].forEach(function (button) {
          const selected = button.dataset.value === viewState.appearance;
          button.classList.toggle('selected', selected);
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        [roundButton, squareButton, determinantButton].forEach(function (button) {
          const selected = button.dataset.value === viewState.bracket;
          button.classList.toggle('selected', selected);
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        bracketGroup.hidden = viewState.appearance !== 'matrix';
      }

      chromeCheckbox.addEventListener('change', function () {
        viewState.chromeHidden = !chromeCheckbox.checked;
        if (typeof options.onViewCommit === 'function') {
          options.onViewCommit({
            chromeHidden: viewState.chromeHidden,
            appearance: viewState.appearance,
            bracket: viewState.bracket,
          });
        }
      });
      syncChoices();
      card.appendChild(controls);
    }

    const host = document.createElement('div');
    host.className = 'table-studio-grid-host';
    card.appendChild(host);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let closed = false;
    const controller = mount(host, {
      markdown: options.markdown,
      studio: true,
      onCommit: options.onCommit,
      onExtract: options.onExtract,
      onUndo: options.onUndo,
      onRedo: options.onRedo,
    });
    function finish() {
      if (closed) return;
      closed = true;
      controller.destroy(true);
      const nextTitle = title.value.trim();
      if (nextTitle !== String(options.title || '').trim() && typeof options.onTitleCommit === 'function') {
        options.onTitleCommit(nextTitle);
      }
      overlay.remove();
      if (typeof options.onClose === 'function') options.onClose();
    }
    close.addEventListener('click', finish);
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) finish();
    });
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !controller.editing && !controller.sourceMode) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    });
    requestAnimationFrame(function () {
      overlay.classList.add('visible');
      if (controller.root) controller.root.focus({ preventScroll: true });
    });
    return { overlay: overlay, controller: controller, close: finish };
  }

  function pruneControllers() {
    controllers.forEach(function (controller) {
      if (!controller.host || (!controller.host.isConnected && !controller.destroyed)) controller.destroy(false);
    });
  }

  document.addEventListener('mouseup', function () { dragController = null; }, true);
  global.RelatumTableGrid = {
    mount: mount,
    openStudio: openStudio,
    commitAll: function () {
      pruneControllers();
      controllers.forEach(function (controller) {
        if (controller.sourceMode && controller.sourceEditor) {
          const parsed = global.MarkdownTable.parse(controller.sourceEditor.value, { ensureBodyRow: false });
          if (parsed.ok) controller.model = parsed.model;
        }
        controller.finishCellEdit('save');
        controller.commit('save');
      });
    },
    isEditing: function () {
      pruneControllers();
      let active = false;
      controllers.forEach(function (controller) {
        if (controller.editing || controller.sourceMode || controller.options.studio) active = true;
      });
      return active;
    },
  };
})(window);

// Database views share the current note's query, data, and pending edit.
(function () {
  'use strict';

  const snapshotRoute = '/api/note-database';
  const actionRoute = snapshotRoute + '/action';
  const importRoute = snapshotRoute + '/attachment/import';
  const fileExtensions = /\.(?:pdf|md|markdown|csv|tsv|docx?|xlsx?|pptx?|odt|ods|odp|txt|rtf)$/i;
  const maxFileSize = 100 * 1024 * 1024;
  const columnTypes = {
    text: ['文本', 'Text'], number: ['数字', 'Number'], date: ['日期', 'Date'],
    checkbox: ['勾选', 'Checkbox'], attachment: ['附件', 'Attachment'],
    select: ['单选', 'Select'], multiSelect: ['多选', 'Multi-select'], status: ['状态', 'Status'],
  };
  const typeSymbols = { text: 'Aa', number: '#', date: '▦', checkbox: '☑', attachment: '↗',
    select: '◉', multiSelect: '≡', status: '◐' };
  const choiceType = type => ['select', 'multiSelect', 'status'].includes(type);
  const shownColumns = page => page.columns.filter(column => !column.hidden);
  const clampWidth = width => Math.round(Math.min(640, Math.max(96, width)));
  const sameCell = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
  const iconPaths = { plus: 'M8 3.5v9M3.5 8h9', search: 'M10.3 10.3l3.1 3.1M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
    view: 'M2.5 4h11m-9 4h7m-5 4h3', more: 'M3.5 8h.2M7.9 8h.2M12.3 8h.2', prev: 'm10 4-4 4 4 4',
    next: 'm6 4 4 4-4 4', '×': 'm5 5 6 6m0-6-6 6' };
  let listSequence = 0;

  const translate = (language, pair) => pair[language === 'en' ? 1 : 0];
  const label = (zh, en) => [zh, en];
  const makeQuery = () => ({ page: 1, search: '', sort: null, filters: [] });
  const acceptsFile = file => fileExtensions.test(file?.name || '');
  const composing = event => event.isComposing || event.keyCode === 229;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, onClick, role) {
    const node = element('button', '', text);
    node.type = 'button';
    if (role) node.dataset.dbRole = role;
    node.addEventListener('click', onClick);
    return node;
  }

  async function request(url, body, signal) {
    const response = await fetch(url, body === undefined ? { signal, cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || response.statusText);
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }

  function loadPage(path, query, signal) {
    const parameters = new URLSearchParams({ path, query: JSON.stringify(query) });
    return request(snapshotRoute + '?' + parameters, undefined, signal);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new DOMException('File read cancelled', 'AbortError'));
      reader.readAsDataURL(file);
    });
  }

  function input(type, name, value = '') {
    const node = element('input');
    node.type = type;
    node.setAttribute('aria-label', name);
    node.value = value;
    return node;
  }

  function select(name, options, value) {
    const node = element('select');
    node.setAttribute('aria-label', name);
    for (const [key, text] of options) node.add(new Option(text, key));
    node.value = value;
    return node;
  }

  function display(value, column, tr) {
    if (value === null || value === undefined) return '';
    if (column.type === 'attachment') return value.name || '';
    if (column.type === 'checkbox') return tr(value ? label('已勾选', 'Checked') : label('未勾选', 'Unchecked'));
    if (choiceType(column.type)) {
      const ids = Array.isArray(value) ? value : [value];
      return ids.map(id => column.choices?.find(option => option.id === id)?.name || '').filter(Boolean).join('、');
    }
    return String(value);
  }

  function parseClipboard(text) {
    const lines = [[]];
    let value = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') value += ch;
        else if (text[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (ch === '\t' || ch === '\r' || ch === '\n') {
        lines.at(-1).push(value);
        value = ''; closed = false;
        if (ch !== '\t') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          if (i + 1 < text.length) lines.push([]);
          else return lines;
        }
      } else if (!value && !closed && ch === '"') quoted = true;
      else {
        if (closed) throw new Error('clipboard');
        value += ch;
      }
    }
    if (quoted) throw new Error('clipboard');
    lines.at(-1).push(value);
    return lines;
  }

  function clipboardValue(value, column) {
    if (value === '') return null;
    if (column.type === 'text') {
      if ([...value].length > 4096) throw new Error('text');
      return value.replace(/\r\n?/g, '\n');
    }
    if (column.type === 'number' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const number = Number(value);
      if (Number.isFinite(number) && Math.abs(number) <= 1e308) return number;
    }
    if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01') {
      const date = new Date(value + 'T00:00:00Z');
      if (!isNaN(date) && date.toISOString().slice(0, 10) === value) return value;
    }
    if (column.type === 'checkbox') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', '☑', '已勾选', 'checked'].includes(normalized)) return true;
      if (['false', '0', '☐', '未勾选', 'unchecked'].includes(normalized)) return false;
    }
    if (choiceType(column.type)) {
      const find = name => column.choices?.find(option => option.name === name)?.id;
      const exact = find(value);
      if (exact) return column.type === 'multiSelect' ? [exact] : exact;
      if (column.type === 'multiSelect') {
        const ids = value.split('、').map(find);
        if (ids.every(Boolean)) return ids;
      }
    }
    throw new Error(column.type);
  }

  function rememberHistory(stack, changes) {
    const size = JSON.stringify(changes).length;
    stack.push({ changes, size });
    let units = size;
    let keep = stack.length - 1;
    while (keep > 0 && stack.length - keep < 50 && units + stack[keep - 1].size <= 4 * 1024 * 1024) {
      units += stack[--keep].size;
    }
    if (keep) stack.splice(0, keep);
  }

  async function renderPrint(host, path, language) {
    const tr = pair => translate(language, pair);
    try {
      const page = await loadPage(path, makeQuery(), AbortSignal.timeout(10000));
      if (!page.exists) {
        host.textContent = tr(label('数据库尚未创建', 'Database not created'));
        return 0;
      }
      const table = element('table', 'md-table note-database-print-table');
      const header = table.createTHead().insertRow();
      const columns = shownColumns(page);
      for (const column of columns) header.append(element('th', '', column.name));
      const body = table.createTBody();
      for (const row of page.rows) {
        const line = body.insertRow();
        for (const column of columns) line.insertCell().textContent = display(row.values[column.id], column, tr);
      }
      host.replaceChildren(table);
      const remaining = page.total - page.rows.length;
      if (remaining > 0) host.append(element('p', '', tr(label(`另有 ${remaining} 行`, `${remaining} more rows`))));
      return 0;
    } catch (_) {
      host.textContent = tr(label('数据库读取失败', 'Database unavailable'));
      return 1;
    }
  }

  function create(options = {}) {
    const tr = pair => translate(options.language?.(), pair);
    const sessions = new Map();
    const observed = new Map();
    let observer = null;
    let activePath = null;
    let activeVisible = true;
    let destroyed = false;
    let channel = null;
    let lastDirty = false;
    try { channel = new BroadcastChannel('relatum:note-database:v1'); } catch (_) {}

    function dirty() {
      return Array.from(sessions.values()).some(session => session.draft?.changed || session.draft?.composition || session.write);
    }

    function notifyDirty() {
      const value = dirty();
      if (value === lastDirty) return;
      lastDirty = value;
      options.onDirtyChange?.(value);
    }

    function getSession(path) {
      if (!sessions.has(path)) sessions.set(path, {
        path, page: null, query: makeQuery(), views: new Set(), draft: null, status: '', stale: true,
        read: null, write: null, timer: 0, undo: [], redo: [],
      });
      return sessions.get(path);
    }

    function isVisible(session) {
      return !destroyed && activeVisible && activePath === session.path && !document.hidden
        && document.documentElement.dataset.desktopMinimized !== '1';
    }

    function canRead(session) {
      return isVisible(session) && Array.from(session.views).some(view => view.visible && view.host.isConnected);
    }

    function announce(session, message) {
      if (session.status === message) return;
      session.status = message;
      for (const view of session.views) {
        view.status.textContent = message;
        view.status.hidden = !message;
        view.onLayout?.();
      }
    }

    function applyPage(session, page, ownWrite = false) {
      const { inverse, addedId, addedRow, updatedRow, addedColumn, deletedCount, ...snapshot } = page;
      page = snapshot;
      if (!ownWrite && session.page && session.page.revision !== page.revision) {
        session.undo.length = 0;
        session.redo.length = 0;
      }
      session.page = page;
      if (page.exists) {
        session.query.page = page.page;
        const columns = new Map(page.columns.map(column => [column.id, column]));
        if (!columns.has(session.query.sort?.column)) session.query.sort = null;
        session.query.filters = session.query.filters.filter(filter => {
          const column = columns.get(filter.column);
          return column && (!choiceType(column.type) || ['empty', 'notEmpty'].includes(filter.operator)
            || column.choices?.some(option => option.id === filter.value));
        });
      }
      session.renderedQuery = JSON.stringify(session.query);
      for (const view of session.views) if (view.visible) draw(view);
    }

    function markChanged(session) {
      try { channel?.postMessage({ path: session.path }); } catch (_) {}
    }

    async function refresh(path = activePath, followRead = false) {
      const session = sessions.get(path);
      if (!session) return;
      if (session.read && !followRead) return;
      session.stale = true;
      return read(session);
    }

    function stopRead(session) {
      clearTimeout(session.timer);
      session.timer = 0;
      session.read?.abort();
      session.read = null;
    }

    function read(session) {
      if (session.read) return session.readDone;
      if (!session.stale || !canRead(session) || session.write) return;
      session.stale = false;
      const controller = new AbortController();
      session.read = controller;
      const task = async () => {
        try {
          const page = await loadPage(session.path, session.query, controller.signal);
          if (!controller.signal.aborted && canRead(session)) {
            if (!session.draft?.error) announce(session, '');
            if (session.renderedQuery !== JSON.stringify(session.query) || JSON.stringify(session.page) !== JSON.stringify(page)) applyPage(session, page);
          } else if (!controller.signal.aborted) session.stale = true;
        } catch (error) {
          if (!controller.signal.aborted && canRead(session)) {
            announce(session, tr(label('读取数据库失败', 'Could not load database')));
            for (const view of session.views) if (!session.page && view.visible) draw(view);
          }
        } finally {
          if (session.read === controller) {
            session.read = null;
            session.readDone = null;
            if (session.stale) void read(session);
          }
        }
      };
      return (session.readDone = task());
    }

    async function write(session, action, replay = '') {
      if (session.write) {
        try { await session.write; } catch (_) { return false; }
        if (session.write) return false;
      }
      if (destroyed || sessions.get(session.path) !== session) return false;
      stopRead(session);
      session.stale = false;
      const requestedQuery = JSON.stringify(session.query);
      const task = request(actionRoute, {
        path: session.path, query: session.query, action: { revision: session.page?.revision, ...action },
      });
      session.write = task;
      notifyDirty();
      try {
        const page = await task;
        if (!destroyed && sessions.get(session.path) === session) {
          announce(session, '');
          if (page.inverse?.length) {
            if (replay) {
              const source = replay === 'undo' ? session.undo : session.redo;
              const target = replay === 'undo' ? session.redo : session.undo;
              source.pop();
              rememberHistory(target, page.inverse);
            } else {
              rememberHistory(session.undo, page.inverse);
              session.redo.length = 0;
            }
          } else if (['create', 'delete', 'cleanup', 'deleteColumn', 'setChoices'].includes(action.type)) {
            session.undo.length = 0;
            session.redo.length = 0;
          }
          if (page.updatedRow) for (const view of session.views) {
            if (view.pinned?.id === page.updatedRow.id) view.pinned = page.updatedRow;
          }
          if (JSON.stringify(session.query) === requestedQuery) applyPage(session, page, true);
          else {
            if (session.page) session.page = { ...session.page, revision: page.revision };
            session.stale = true;
          }
          markChanged(session);
        }
        return page;
      } catch (error) {
        if (destroyed || sessions.get(session.path) !== session) return false;
        if (session.draft) session.draft.error = true;
        announce(session, error.code === 'options_in_use' ? error.message : error.status === 409
          ? tr(label('数据库已修改，已保留当前输入。请确认后重试。', 'The database changed. Your edit is kept. Review it and retry.'))
          : error.message || tr(label('操作失败，请重试。', 'Could not save. Please try again.')));
        if (['delete', 'cleanup'].includes(action.type)) options.onError?.(error);
        if (error.status === 409 && error.code !== 'options_in_use') session.stale = true;
        return false;
      } finally {
        if (session.write === task) {
          session.write = null;
          notifyDirty();
          if (session.stale) void read(session);
        }
      }
    }

    async function commitDraft(draft, nextCell, restoreFocus = false) {
      if (draft.composition || draft.session.draft !== draft) return false;
      if (draft.saving) return draft.saving;
      const { session } = draft;
      dismissSuggestions(draft);
      const value = draft.value;
      if (draft.input && !draft.input.validity.valid) {
        draft.input.reportValidity();
        return false;
      }
      const job = async () => {
        if (draft.error) {
          if (!canRead(session)) return false;
          await read(session);
        }
        if (!draft.changed) return true;
        return await saveCell(draft.view, draft.row, draft.column, value);
      };
      draft.saving = job().then(ok => {
        draft.saving = null;
        if (!ok || session.draft !== draft) return ok;
        session.draft = null;
        notifyDirty();
        if (draft.view.visible) draw(draft.view);
        if (restoreFocus && draft.view.visible && isVisible(session)) focusCell(draft.view, nextCell || [draft.row.id, draft.column.id]);
        else if (!draft.view.root.contains(document.activeElement)) releasePinned(draft.view);
        return true;
      });
      return draft.saving;
    }

    function abandonDraft(draft) {
      if (draft.saving) return;
      dismissSuggestions(draft);
      const { session, row, column, view } = draft;
      if (session.draft !== draft) return;
      session.draft = null;
      notifyDirty();
      announce(session, '');
      if (view.visible) draw(view);
      if (isVisible(session)) focusCell(view, [row.id, column.id]);
    }

    function focusCell(view, [row, column]) {
      selectCell(view, [row, column], false, true, true);
    }

    function revealCell(view, control) {
      let rect = control.getBoundingClientRect();
      const scroller = view.overflow;
      const box = scroller.getBoundingClientRect();
      const editor = control.closest('.cm-scroller');
      const editorBox = editor?.getBoundingClientRect();
      if (rect.top < Math.max(0, editorBox?.top || 0) || rect.bottom > Math.min(innerHeight, editorBox?.bottom || innerHeight)) {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        rect = control.getBoundingClientRect();
      }
      const right = box.left + scroller.clientWidth - (view.lane?.offsetWidth || 0);
      if (rect.left < box.left) scroller.scrollLeft -= box.left - rect.left;
      else if (rect.right > right) scroller.scrollLeft += rect.right - right;
    }

    function visibleRows(view) {
      const rows = view.session.page?.rows || [];
      return view.pinned && !rows.some(row => row.id === view.pinned.id) ? [...rows, view.pinned] : rows;
    }

    function bounds(view) {
      if (!view.selection) return null;
      const rows = visibleRows(view), columns = shownColumns(view.session.page);
      const { anchor, head } = view.selection;
      const r0 = rows.findIndex(row => row.id === anchor[0]), r1 = rows.findIndex(row => row.id === head[0]);
      const c0 = columns.findIndex(column => column.id === anchor[1]), c1 = columns.findIndex(column => column.id === head[1]);
      if ([r0, r1, c0, c1].includes(-1)) return null;
      return { rows, columns, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
    }

    function paintSelection(view) {
      const range = bounds(view), current = new Set();
      if (range && !view.readOnly) {
        for (let row = range.r0; row <= range.r1; row++) {
          for (let col = range.c0; col <= range.c1; col++) {
            const target = view.cells.get(range.rows[row].id)?.get(range.columns[col].id);
            if (target) current.add(target);
          }
        }
      }
      for (const cell of view.painted || []) if (!current.has(cell)) cell.classList.remove('is-selected');
      for (const cell of current) if (!view.painted?.has(cell)) cell.classList.add('is-selected');
      view.painted = current;
      const head = view.selection?.head;
      const active = head && view.cells.get(head[0])?.get(head[1]);
      if (active !== view.activeCell) view.activeCell?.classList.remove('is-active');
      active?.classList.add('is-active');
      view.activeCell = active;
      const tabStop = active || view.cells.values().next().value?.values().next().value;
      if (!view.readOnly && tabStop !== view.tabStop) {
        if (view.tabStop) view.tabStop.tabIndex = -1;
        if (tabStop) tabStop.tabIndex = 0;
      }
      view.tabStop = tabStop;
    }

    function selectCell(view, cell, extend, focus, reveal = false) {
      if (!view.cells?.get(cell[0])?.has(cell[1])) return;
      const anchor = extend && view.selection ? view.selection.anchor : cell;
      if (!sameCell(view.selection?.head, cell) || !sameCell(view.selection?.anchor, anchor)) {
        view.selection = { anchor, head: cell };
        paintSelection(view);
      }
      if (focus) {
        const control = view.cells.get(cell[0])?.get(cell[1]);
        control?.focus({ preventScroll: true });
        if (reveal && control?.isConnected) revealCell(view, control);
      }
      releasePinned(view, cell[0]);
    }

    function clipboard(view, event, clear = false) {
      const range = bounds(view);
      if (!range || event.target.closest('input,textarea,select') || view.readOnly) return;
      if (view.session.draft || view.session.write) return;
      if (event.type === 'copy') {
        if (!event.clipboardData) return;
        const columns = range.columns.slice(range.c0, range.c1 + 1);
        const encode = value => /["\t\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        const text = range.rows.slice(range.r0, range.r1 + 1).map(row =>
          columns.map(column => encode(display(row.values[column.id], column, tr))).join('\t')).join('\r\n');
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const text = clear ? '' : event.clipboardData?.getData('text/plain');
      if (text === undefined || (!clear && !text)) return;
      event.preventDefault();
      event.stopPropagation();
      if (view.session.renderedQuery !== JSON.stringify(view.session.query)) {
        announce(view.session, tr(label('视图正在更新，更新后可继续编辑范围。', 'The view is updating. Try again when the rows are ready.')));
        return;
      }
      let matrix;
      try {
        if (text.length > 4 * 1024 * 1024) throw new Error('length');
        matrix = clear ? Array.from({ length: range.r1 - range.r0 + 1 }, () => Array(range.c1 - range.c0 + 1).fill('')) : parseClipboard(text);
      } catch (_) {
        announce(view.session, tr(label('无法读取粘贴内容。', 'Could not read the pasted data.')));
        return;
      }
      if (matrix.length > 200) {
        announce(view.session, tr(label('一次最多粘贴 200 行。', 'Paste up to 200 rows at a time.')));
        return;
      }
      const changes = [];
      const { query, page } = view.session;
      const canAppend = !query.search && !query.sort && !query.filters.length && page.page * page.pageSize >= page.total;
      for (const [r, values] of matrix.entries()) {
        const row = range.rows[range.r0 + r];
        if ((!row && !canAppend) || (row && !page.rows.some(item => item.id === row.id))) {
          announce(view.session, tr(label('粘贴超出当前页，表格未修改。', 'The paste extends beyond the current page. No cells changed.')));
          return;
        }
        const parsed = {};
        for (const [c, value] of values.entries()) {
          const column = range.columns[range.c0 + c];
          try {
            if (!column) throw new Error('column');
            parsed[column.id] = clipboardValue(value, column);
          } catch (_) {
            const target = range.columns[Math.min(range.c0 + c, range.columns.length - 1)];
            focusCell(view, [(row || range.rows.at(-1)).id, target.id]);
            announce(view.session, tr(label(
              `粘贴内容第 ${r + 1} 行、第 ${c + 1} 列超出范围或类型不符，表格未修改。`,
              `Pasted row ${r + 1}, column ${c + 1} is out of range or has the wrong type. No cells changed.`)));
            return;
          }
        }
        changes.push({ row: row?.id ?? null, values: parsed });
      }
      void write(view.session, { type: 'batchCells', changes });
    }

    function afterCellSave(view, callback) {
      const { session } = view;
      const saving = session.draft?.saving;
      if (!saving) return callback();
      return saving.then(ok => {
        if (ok && view.host.isConnected && isVisible(session)) return callback();
      });
    }

    function adjacentCell(view, row, column, key, shift) {
      const rows = visibleRows(view), columns = shownColumns(view.session.page);
      const rowIndex = rows.findIndex(item => item.id === row.id);
      const columnIndex = columns.findIndex(item => item.id === column.id);
      const width = columns.length;
      if (key === 'Tab') {
        const next = rowIndex * width + columnIndex + (shift ? -1 : 1);
        if (next < 0 || next >= width * rows.length) return null;
        return [rows[Math.floor(next / width)].id, columns[next % width].id];
      }
      const vertical = { ArrowUp: -1, ArrowDown: 1 }[key] || 0;
      const horizontal = { ArrowLeft: -1, ArrowRight: 1 }[key] || 0;
      const targetRow = rows[rowIndex + vertical], targetColumn = columns[columnIndex + horizontal];
      return targetRow && targetColumn ? [targetRow.id, targetColumn.id] : null;
    }

    function dismissSuggestions(draft) {
      clearTimeout(draft.suggestionTimer);
      draft.suggestionFetch?.abort();
      draft.suggestionFetch = null;
      draft.removePopupListeners?.();
      draft.removePopupListeners = null;
      draft.popup?.remove();
      draft.popup = null;
      draft.input?.setAttribute('aria-expanded', 'false');
      draft.input?.removeAttribute('aria-activedescendant');
    }

    function pickAttachment(draft, item) {
      draft.value = item ? item.kind === 'note' ? { kind: 'note', path: item.path } : { kind: 'attachment', id: item.id } : null;
      draft.term = item?.name || '';
      draft.input.value = draft.term;
      draft.changed = true;
      notifyDirty();
      void commitDraft(draft, null, true);
    }

    function selectSuggestion(draft, index) {
      const items = draft.popup?.querySelectorAll('[role="option"]');
      if (!items?.length) return;
      draft.suggestionIndex = (index + items.length) % items.length;
      items.forEach((item, index) => item.setAttribute('aria-selected', String(index === draft.suggestionIndex)));
      const active = items[draft.suggestionIndex];
      draft.input.setAttribute('aria-activedescendant', active.id);
      const bounds = active.getBoundingClientRect(), viewport = draft.popup.getBoundingClientRect();
      if (bounds.top < viewport.top) draft.popup.scrollTop -= viewport.top - bounds.top;
      else if (bounds.bottom > viewport.bottom) draft.popup.scrollTop += bounds.bottom - viewport.bottom;
    }

    function suggestions(draft) {
      dismissSuggestions(draft);
      if (draft.composition || !draft.input || !isVisible(draft.session)) return;
      const query = draft.input.value.trim();
      const load = async () => {
        const controller = new AbortController();
        draft.suggestionFetch = controller;
        try {
          const result = await request(actionRoute, {
            path: draft.session.path, action: { type: 'searchAttachments', query },
          }, controller.signal);
          if (controller.signal.aborted || draft.session.draft !== draft || draft.composition
              || document.activeElement !== draft.input || !isVisible(draft.session)) return;
          const popup = element('div', 'note-database-suggestions');
          popup.id = draft.input.getAttribute('aria-controls');
          popup.setAttribute('role', 'listbox');
          const items = result.items.filter(item => item.exists !== false);
          if (draft.value) items.push(null);
          draft.suggestionItems = items;
          draft.suggestionIndex = -1;
          items.forEach((item, index) => {
            const option = button(item?.name || tr(label('清除链接', 'Clear link')), () => pickAttachment(draft, item));
            option.tabIndex = -1;
            option.id = popup.id + '-' + index;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.addEventListener('pointerdown', event => event.preventDefault());
            if (item) option.append(element('small', '', item.kind === 'note' ? item.path : tr(label('已导入附件', 'Imported attachment'))));
            popup.append(option);
          });
          if (!items.length) popup.append(element('div', 'note-database-suggestion-empty', tr(label('没有匹配文件', 'No matching files'))));
          // Use the top layer when available so a scrolling table never clips the list.
          if (popup.showPopover) popup.setAttribute('popover', 'manual');
          draft.view.root.append(popup);
          draft.popup = popup;
          if (popup.showPopover) popup.showPopover();
          const rect = draft.input.getBoundingClientRect();
          const viewportWidth = document.documentElement.clientWidth;
          const viewportHeight = document.documentElement.clientHeight;
          const width = Math.min(Math.max(rect.width, 224), viewportWidth - 16);
          const below = viewportHeight - rect.bottom - 8;
          popup.style.width = width + 'px';
          popup.style.left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8)) + 'px';
          popup.style.maxHeight = Math.max(70, Math.min(240, below < 140 ? rect.top - 8 : below)) + 'px';
          if (below < 140) popup.style.bottom = viewportHeight - rect.top + 'px';
          else popup.style.top = rect.bottom + 'px';
          draft.input.setAttribute('aria-expanded', 'true');
          const onScroll = event => { if (!popup.contains(event.target)) dismissSuggestions(draft); };
          const onResize = () => dismissSuggestions(draft);
          document.addEventListener('scroll', onScroll, { capture: true, passive: true });
          window.addEventListener('resize', onResize);
          draft.removePopupListeners = () => {
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
          };
        } catch (error) {
          if (!controller.signal.aborted && isVisible(draft.session) && document.activeElement === draft.input)
            announce(draft.session, tr(label('文件搜索失败，请重试。', 'Could not find files. Please try again.')));
        }
      };
      draft.suggestionTimer = setTimeout(load, query ? 150 : 0);
    }

    function editorFor(draft) {
      const { view, session, column, row } = draft;
      const attachment = column.type === 'attachment';
      const type = { date: 'date', number: 'number' }[column.type] || 'text';
      const field = column.type === 'text' ? element('textarea') : input(type, column.name);
      field.setAttribute('aria-label', column.name);
      field.value = attachment ? draft.term ?? draft.value?.name ?? '' : draft.value ?? '';
      if (field instanceof HTMLTextAreaElement) field.rows = 1;
      field.className = 'note-database-cell-input';
      if (type === 'number') field.step = 'any';
      draft.input = field;
      if (attachment) {
        field.setAttribute('role', 'combobox');
        field.setAttribute('aria-autocomplete', 'list');
        field.setAttribute('aria-expanded', 'false');
        field.setAttribute('aria-controls', 'note-database-suggestions-' + ++listSequence);
        field.placeholder = tr(label('搜索文件名', 'Find a file'));
        field.maxLength = 256;
      } else if (type === 'text') {
        field.maxLength = 4096;
      }
      const update = () => {
        if (attachment) {
          draft.term = field.value;
          suggestions(draft);
        } else {
          draft.value = field.value === '' ? null : type === 'number' ? field.valueAsNumber : field.value;
          draft.changed = true;
          notifyDirty();
        }
      };
      field.addEventListener('input', event => { if (!draft.composition && !composing(event)) update(); });
      field.addEventListener('compositionstart', () => {
        dismissSuggestions(draft);
        draft.composition = new Promise(resolve => { draft.endComposition = resolve; });
        notifyDirty();
      });
      field.addEventListener('compositionend', () => {
        // The final input event can arrive after compositionend in WebView2.
        setTimeout(() => {
          draft.composition = null;
          if (session.draft === draft && draft.input === field) update();
          draft.endComposition?.();
          notifyDirty();
          if (!draft.error && session.draft === draft && document.activeElement !== field) void commitDraft(draft);
        }, 0);
      });
      field.addEventListener('focus', () => { if (attachment) suggestions(draft); });
      field.addEventListener('blur', () => {
        dismissSuggestions(draft);
        if (!draft.composition && !draft.error) void commitDraft(draft);
      });
      field.addEventListener('keydown', event => {
        event.stopPropagation();
        if (draft.composition || composing(event)) return;
        if (attachment && draft.popup && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          selectSuggestion(draft, draft.suggestionIndex < 0 ? event.key === 'ArrowDown' ? 0 : -1
            : draft.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (draft.popup) dismissSuggestions(draft);
          else abandonDraft(draft);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          if (event.key === 'Enter' && event.shiftKey && field instanceof HTMLTextAreaElement) return;
          if (attachment && draft.popup && draft.suggestionIndex >= 0) {
            event.preventDefault();
            pickAttachment(draft, draft.suggestionItems[draft.suggestionIndex]);
            return;
          }
          const next = event.key === 'Tab' && adjacentCell(view, row, column, 'Tab', event.shiftKey);
          if (event.key === 'Enter' || next) event.preventDefault();
          void commitDraft(draft, next, event.key === 'Enter' || Boolean(next));
        }
      });
      return field;
    }

    function beginEdit(view, row, column, value) {
      const { session } = view;
      if (session.write || session.draft || !isVisible(session)) return;
      if (column.type === 'checkbox') {
        void saveCell(view, row, column, !row.values[column.id]);
        return;
      }
      const control = view.cells.get(row.id)?.get(column.id);
      const cell = control?.parentElement;
      if (!cell) return;
      if (choiceType(column.type)) { choiceEditor(view, control, row, column); return; }
      const draft = { session, view, row, column, value: row.values[column.id] ?? null, changed: false };
      if (value !== undefined && (column.type === 'text' || column.type === 'number' && /^\d$/.test(value))) {
        draft.value = column.type === 'number' ? Number(value) : value;
        draft.changed = true;
      }
      session.draft = draft;
      const field = editorFor(draft);
      cell.replaceChildren(field);
      view.cells.get(row.id).set(column.id, field);
      field.focus();
      if (draft.changed) notifyDirty();
      else if ('select' in field && ['textarea', 'text'].includes(field.type)) field.select();
    }

    function saveCell(view, row, column, value) {
      return write(view.session, { type: 'setCell', row: row.id, column: column.id, value,
        includeRow: view.pinned?.id === row.id });
    }

    async function openLink(view, row, column, value) {
      const session = view.session;
      const visiblyCurrent = () => view.host.isConnected && isVisible(session);
      try {
        if (value.kind === 'note') {
          const originalPage = session.page;
          const originalQuery = JSON.stringify(session.query);
          const page = await loadPage(session.path, session.query, AbortSignal.timeout(10000));
          if (!visiblyCurrent() || session.write || session.page !== originalPage || JSON.stringify(session.query) !== originalQuery) return;
          const current = page.rows.find(item => item.id === row.id)?.values[column.id];
          if (JSON.stringify(originalPage) !== JSON.stringify(page)) applyPage(session, page);
          if (current?.exists && current.kind === 'note' && current.path === value.path) await options.onOpenNote?.(current.path);
        } else {
          await request('/api/open-external', { note: session.path, target: value.id, kind: 'note-database-attachment' });
        }
      } catch (error) {
        if (!visiblyCurrent()) return;
        if (error.status === 404) void refresh(session.path);
        else options.onError?.(error);
      }
    }

    function cellControl(view, row, column) {
      const value = row.values[column.id];
      const name = display(value, column, tr);
      const liveLink = column.type === 'attachment' && value?.exists;
      if (view.readOnly && !liveLink) return element('span', 'note-database-cell-value', name);
      const control = button(name, event => {
        const open = liveLink && (view.readOnly || event.ctrlKey || event.metaKey);
        void afterCellSave(view, () => {
          if (open) return openLink(view, row, column, value);
          if (!view.readOnly) {
            selectCell(view, [row.id, column.id], event.shiftKey, true);
            if (column.type === 'checkbox') beginEdit(view, row, column);
          }
        });
      });
      control.className = 'note-database-cell-value' + (liveLink ? ' is-link' : '');
      control.setAttribute('aria-label', name ? column.name + ' · ' + name : column.name);
      if (name) control.title = name;
      if (!view.readOnly) control.tabIndex = -1;
      if (choiceType(column.type) && name) control.replaceChildren(element('span', 'note-database-choice', name));
      if (column.type === 'checkbox') {
        control.setAttribute('role', 'checkbox');
        control.setAttribute('aria-checked', String(Boolean(value)));
        control.textContent = value ? '☑' : '☐';
      }
      control.addEventListener('keydown', event => {
        if (view.readOnly || composing(event)) return;
        const mod = event.ctrlKey || event.metaKey;
        if (liveLink && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          void openLink(view, row, column, value);
        } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.key)) {
          const next = adjacentCell(view, row, column, event.key, event.shiftKey);
          if (!next && event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (next) selectCell(view, next, event.shiftKey && event.key !== 'Tab', true, true);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          clipboard(view, event, true);
        } else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          event.preventDefault(); event.stopPropagation();
          const menu = view.rowEntries.get(row.id)?.menu;
          if (menu) showRowMenu(view, menu, row);
        } else if (event.key === 'Escape') {
          selectCell(view, [row.id, column.id], false, true);
          event.stopPropagation();
        } else if (event.key === 'Enter' || (!mod && !event.altKey && [...event.key].length === 1)) {
          event.preventDefault();
          event.stopPropagation();
          const literal = event.key === 'Enter' ? undefined : event.key;
          beginEdit(view, row, column, literal);
        }
      });
      if (!view.readOnly) {
        control.addEventListener('dblclick', event => {
          if (column.type !== 'checkbox' && !event.ctrlKey && !event.metaKey) beginEdit(view, row, column);
        });
        control.addEventListener('focus', () => {
          if (!sameCell(view.selection?.head, [row.id, column.id])) selectCell(view, [row.id, column.id], false, false);
        });
        control.addEventListener('pointerdown', event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
          view.dragCell = true;
          selectCell(view, [row.id, column.id], event.shiftKey, false);
        });
        control.addEventListener('pointerenter', event => {
          if (view.dragCell && event.buttons === 1) selectCell(view, [row.id, column.id], true, true);
        });
      }
      return control;
    }

    function changeQuery(session, patch, delay = 0) {
      stopRead(session);
      for (const view of session.views) view.pinned = null;
      Object.assign(session.query, { page: 1 }, patch);
      session.stale = true;
      if (delay) session.timer = setTimeout(() => { session.timer = 0; void read(session); }, delay);
      else void read(session);
    }

    function panelAt(view, anchor, kind, content) {
      const same = view.panel?.kind === kind && view.panel.anchor === anchor;
      view.panel?.close();
      if (same || !anchor?.isConnected) return;
      const panel = element('div', 'note-database-panel');
      const surface = element('div', 'note-database-panel-content');
      const choicesPortal = element('div', 'note-database-choice-portal');
      panel.append(surface, choicesPortal);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', anchor.getAttribute('aria-label') || anchor.textContent);
      if (panel.showPopover) panel.setAttribute('popover', 'manual');
      const controller = new AbortController();
      const choices = window.RelatumReviewControls?.createManager(surface, choicesPortal);
      const close = (restore = false) => {
        controller.abort();
        choices?.dispose();
        panel.remove();
        if (view.panel?.close === close) view.panel = null;
        if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
      };
      view.panel = { anchor, kind, close, choices };
      const initial = content(surface, close);
      view.root.append(panel);
      panel.showPopover?.();
      const rect = anchor.getBoundingClientRect(), width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      panel.style.left = Math.max(8, Math.min(rect.left, width - panel.offsetWidth - 8)) + 'px';
      const top = rect.bottom + panel.offsetHeight + 8 > height && rect.top > height - rect.bottom;
      surface.style.maxHeight = Math.max(80, Math.min(384, top ? rect.top - 12 : height - rect.bottom - 12)) + 'px';
      if (top) panel.style.bottom = height - rect.top + 4 + 'px';
      else panel.style.top = rect.bottom + 4 + 'px';
      const { signal } = controller;
      document.addEventListener('pointerdown', event => {
        if (!panel.contains(event.target) && !anchor.contains(event.target)) close();
      }, { signal });
      document.addEventListener('scroll', event => {
        if (!panel.contains(event.target)) close();
      }, { signal, capture: true, passive: true });
      window.addEventListener('resize', close.bind(null, false), { signal });
      panel.addEventListener('keydown', event => {
        if (composing(event)) return;
        if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
        if (event.target.closest('.review-choice-trigger') || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        if (event.target.closest('input,textarea,select') && (kind !== 'addColumn' || event.key !== 'ArrowDown')) return;
        const buttons = Array.from(surface.querySelectorAll('button:not(:disabled):not(.review-choice-trigger)'));
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); event.stopPropagation(); buttons[next].focus();
      });
      choices?.enhanceAll();
      const focus = initial instanceof HTMLSelectElement ? choices?.enhance(initial).anchor || initial : initial;
      (focus || surface.querySelector('button,input,select'))?.focus({ preventScroll: true });
    }

    function addColumn(view, anchor) {
      panelAt(view, anchor, 'addColumn', (panel, close) => {
        const name = input('text', tr(label('字段名称', 'Field name')));
        name.placeholder = tr(label('字段名称（可选）', 'Field name (optional)'));
        name.maxLength = 120;
        const types = element('div', 'note-database-types');
        for (const [type, names] of Object.entries(columnTypes)) {
          const option = button(tr(names), () => {
            const base = tr(names);
            const namesInUse = new Set(view.session.page.columns.map(column => column.name.toLocaleLowerCase()));
            let generated = base, number = 2;
            while (namesInUse.has(generated.toLocaleLowerCase())) generated = base + ' ' + number++;
            close(true);
            void write(view.session, { type: 'addColumn', name: name.value.trim() || generated,
              columnType: type, language: options.language?.() });
          }, 'type-' + type);
          option.prepend(element('span', 'note-database-type', typeSymbols[type]));
          types.append(option);
        }
        panel.append(name, types);
        return name;
      });
    }

    function moveColumn(view, source, target) {
      const order = view.session.page.columns.map(column => column.id);
      const from = order.indexOf(source), to = order.indexOf(target);
      if (from < 0 || to < 0 || from === to) return;
      order.splice(from, 1);
      order.splice(to, 0, source);
      return write(view.session, { type: 'columnLayout', column: source, order });
    }

    function choiceEditor(view, anchor, row, column) {
      panelAt(view, anchor, 'cellChoices', (panel, close) => {
        const current = row.values[column.id];
        const multi = column.type === 'multiSelect';
        const choices = new Set(multi ? current || [] : current ? [current] : []);
        const save = async value => {
          close(true);
          await saveCell(view, row, column, value);
        };
        for (const option of column.choices || []) {
          const item = button(option.name, () => {
            if (!multi) { void save(option.id); return; }
            if (!choices.delete(option.id)) choices.add(option.id);
            item.setAttribute('aria-pressed', String(choices.has(option.id)));
          });
          item.className = 'note-database-menu-option';
          item.setAttribute('aria-pressed', String(choices.has(option.id)));
          panel.append(item);
        }
        if (multi) panel.append(button(tr(label('完成', 'Done')), () => save(Array.from(choices))));
        panel.append(button(tr(label('清空', 'Clear')), () => save(null)));
        if (!column.choices?.length) panel.append(button(tr(label('管理选项', 'Manage options')), () => {
          close();
          editChoices(view, anchor, column);
        }));
      });
    }

    function editChoices(view, anchor, column) {
      panelAt(view, anchor, 'fieldChoices', (panel, close) => {
        const list = element('div', 'note-database-option-list');
        const fields = new Map();
        const add = option => {
          const row = element('div', 'note-database-form');
          const name = input('text', tr(label('选项名称', 'Option name')), option?.name);
          name.maxLength = 120;
          const remove = iconButton('×', tr(label('移除选项', 'Remove option')), () => {
            fields.delete(name); row.remove();
          });
          fields.set(name, option?.id);
          row.append(name, remove); list.append(row);
          return name;
        };
        for (const option of column.choices || []) add(option);
        panel.append(list, button(tr(label('＋ 选项', '+ Option')), () => add().focus()));
        panel.append(button(tr(label('保存选项', 'Save options')), async () => {
          const choices = Array.from(fields, ([field, id]) => ({ id, name: field.value.trim() })).filter(option => option.name);
          const removed = column.choices?.some(option => !choices.some(item => item.id === option.id));
          if (removed) {
            close(true);
            if (!await confirmEdit(view, label('移除选项会清除记录中对应的值。继续？', 'Removing options clears their values in records. Continue?'))) return;
          }
          if (await write(view.session, { type: 'setChoices', column: column.id, choices, clearRemoved: !!removed })) close(true);
        }));
        return fields.keys().next().value;
      });
    }

    function iconButton(symbol, name, action, role) {
      const node = button('', action, role);
      node.className = 'note-database-icon';
      node.dataset.glyph = symbol;
      node.title = name;
      node.setAttribute('aria-label', name);
      if (iconPaths[symbol]) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('d', iconPaths[symbol]);
        svg.append(path); node.append(svg);
      }
      return node;
    }

    function columnMenu(view, anchor, column) {
      panelAt(view, anchor, 'column', (panel, close) => {
        const { session } = view, columns = shownColumns(session.page), index = columns.findIndex(item => item.id === column.id);
        const name = input('text', tr(label('字段名称', 'Field name')), column.name);
        name.maxLength = 120;
        const rename = () => {
          const value = name.value.trim();
          close(true);
          if (value && value !== column.name) void write(session, { type: 'renameColumn', column: column.id, name: value });
        };
        name.addEventListener('keydown', event => { if (!composing(event) && event.key === 'Enter') rename(); });
        panel.append(name, button(tr(label('重命名', 'Rename')), rename));
        if (choiceType(column.type)) panel.append(button(tr(label('管理选项', 'Manage options')), () => { close(); editChoices(view, anchor, column); }));
        for (const [offset, msg] of [[-1, label('左移', 'Move left')], [1, label('右移', 'Move right')]]) {
          const item = button(tr(msg), () => { close(true); void moveColumn(view, column.id, columns[index + offset]?.id); });
          item.disabled = !columns[index + offset];
          panel.append(item);
        }
        const hide = button(tr(label('隐藏字段', 'Hide field')), () => { close(); void write(session, { type: 'columnLayout', column: column.id, hidden: true }); });
        const remove = button(tr(label('删除字段', 'Delete field')), async () => {
          close(true);
          if (await confirmEdit(view, label('删除这一列及其中的值？', 'Delete this field and its values?'))) {
            void write(session, { type: 'deleteColumn', column: column.id });
          }
        });
        hide.disabled = remove.disabled = columns.length <= 1;
        panel.append(hide, remove);
      });
    }

    async function confirmEdit(view, message) {
      const current = () => view.root.isConnected && isVisible(view.session);
      return current() && (options.confirmEdit ? await options.confirmEdit(message, current) : window.confirm(tr(message))) && current();
    }

    function filterForm(view, container, index) {
      const { page, query } = view.session;
      const panel = element('form', 'note-database-form');
      const current = query.filters[index];
      const column = select(tr(label('筛选列', 'Filter column')), page.columns.map(item => [item.id, item.name]),
        current?.column || page.columns[0]?.id);
      const operators = {
        text: ['contains', 'equals', 'empty', 'notEmpty'], number: ['equals', 'gt', 'lt', 'empty', 'notEmpty'],
        date: ['equals', 'gt', 'lt', 'empty', 'notEmpty'], checkbox: ['equals', 'empty', 'notEmpty'],
        attachment: ['contains', 'empty', 'notEmpty'], select: ['equals', 'empty', 'notEmpty'],
        multiSelect: ['contains', 'empty', 'notEmpty'], status: ['equals', 'empty', 'notEmpty'],
      };
      const names = { contains: label('包含', 'Contains'), equals: label('等于', 'Equals'), gt: label('大于', 'Greater than'),
        lt: label('小于', 'Less than'), empty: label('为空', 'Is empty'), notEmpty: label('不为空', 'Is not empty') };
      const operator = select(tr(label('筛选条件', 'Filter condition')), [], '');
      const valueHost = element('span');
      let value;
      function showValue(initial) {
        valueHost.replaceChildren();
        value = null;
        if (operator.value === 'empty' || operator.value === 'notEmpty') {
          if (panel.isConnected) view.panel?.choices?.enhanceAll();
          return;
        }
        const selected = page.columns.find(item => item.id === column.value);
        const type = selected?.type;
        const name = tr(label('筛选值', 'Filter value'));
        value = choiceType(type) ? select(name, (selected.choices || []).map(item => [item.id, item.name]), initial ?? selected.choices?.[0]?.id)
          : type === 'checkbox' ? select(name, [['true', tr(label('已勾选', 'Checked'))], ['false', tr(label('未勾选', 'Unchecked'))]], String(initial ?? true))
          : input({ date: 'date', number: 'number' }[type] || 'text', name, initial);
        if (type === 'number') value.step = 'any';
        value.required = true;
        if (value instanceof HTMLInputElement) value.placeholder = name;
        valueHost.append(value);
        if (panel.isConnected) view.panel?.choices?.enhanceAll();
      }
      function showOperators(initial) {
        operator.replaceChildren();
        const type = page.columns.find(item => item.id === column.value)?.type;
        for (const key of operators[type] || []) operator.add(new Option(tr(names[key]), key));
        if (initial) operator.value = initial.operator;
        showValue(initial?.value);
        if (panel.isConnected) view.panel?.choices?.refresh(operator);
      }
      column.addEventListener('change', () => showOperators());
      operator.addEventListener('change', () => showValue());
      showOperators(current);
      const apply = element('button', '', tr(label('应用筛选', 'Apply filter')));
      apply.type = 'submit';
      panel.append(column, operator, valueHost, apply, button(tr(label('移除条件', 'Remove rule')), () => {
        view.panel?.close(true);
        changeQuery(view.session, { filters: query.filters.filter((_, position) => position !== index) });
      }));
      panel.addEventListener('submit', event => {
        event.preventDefault();
        const type = page.columns.find(item => item.id === column.value)?.type;
        const raw = value?.value ?? null;
        const filterValue = raw === null ? null : type === 'number' ? Number(raw) : type === 'checkbox' ? raw === 'true' : raw;
        const filters = query.filters.slice();
        filters[index] = { column: column.value, operator: operator.value, value: filterValue };
        view.panel?.close(true);
        changeQuery(view.session, { filters });
      });
      container.append(panel);
      view.panel?.choices?.enhanceAll();
      (view.panel?.choices?.enhance(column).anchor || column).focus();
    }

    function viewMenu(view, anchor) {
      panelAt(view, anchor, 'view', (panel, close) => {
        const { page, query } = view.session;
        const sortValues = [['', tr(label('默认顺序', 'Default order'))]];
        for (const column of page.columns) {
          sortValues.push([column.id + ':asc', column.name + ' ↑'], [column.id + ':desc', column.name + ' ↓']);
        }
        const sort = select(tr(label('排序', 'Sort')), sortValues, query.sort ? query.sort.column + ':' + query.sort.direction : '');
        sort.addEventListener('change', () => {
          const [column, direction] = sort.value.split(':');
          close(true);
          changeQuery(view.session, { sort: column ? { column, direction } : null });
        });
        panel.append(sort);
        const rules = element('div', 'note-database-view-rules');
        query.filters.forEach((rule, index) => {
          const column = page.columns.find(item => item.id === rule.column);
          if (column) {
            const value = display(rule.value, column, tr);
            rules.append(button(column.name + (value ? ' · ' + value : ''), () => {
              rules.replaceChildren(); filterForm(view, rules, index);
            }));
          }
        });
        const add = button(tr(label('＋ 筛选条件', '+ Filter rule')), () => {
          rules.replaceChildren(); filterForm(view, rules, query.filters.length);
        }, 'filter');
        add.disabled = query.filters.length >= 32;
        rules.append(add);
        panel.append(rules);
        const fields = element('fieldset', 'note-database-visible-fields');
        fields.append(element('legend', '', tr(label('显示字段', 'Visible fields'))));
        const visible = shownColumns(page).length;
        for (const column of page.columns) {
          const item = element('label'), toggle = element('input');
          toggle.type = 'checkbox';
          toggle.checked = !column.hidden;
          toggle.disabled = view.readOnly || (visible <= 1 && !column.hidden);
          toggle.addEventListener('change', async () => {
            const saved = await write(view.session, { type: 'columnLayout', column: column.id, hidden: !toggle.checked });
            if (saved) close(true);
            else toggle.checked = !column.hidden;
          });
          item.append(toggle, document.createTextNode(column.name));
          fields.append(item);
        }
        panel.append(fields);
        return sort;
      });
    }

    function draw(view) {
      if (view.session.draft?.view === view && view.body.contains(view.session.draft.input)) return;
      renderView(view);
      view.onLayout?.();
    }

    function releasePinned(view, nextRow) {
      if (!view.pinned || view.pinned.id === nextRow || view.session.draft?.view === view || view.panel) return;
      view.pinned = null;
      queueMicrotask(() => { if (view.visible && view.host.isConnected) draw(view); });
    }

    async function addRow(view) {
      const { session } = view;
      if (view.addingRow) return;
      view.addingRow = true;
      view.addRow.disabled = true;
      try {
        const page = await write(session, { type: 'addRow', focusAdded: true });
        if (!page?.addedRow || session.renderedQuery !== JSON.stringify(session.query)
            || !view.host.isConnected || !isVisible(session)) return;
        const previousPin = view.pinned?.id;
        view.pinned = page.rows.some(row => row.id === page.addedRow.id) ? null : page.addedRow;
        if (view.pinned || previousPin) draw(view);
        const columns = shownColumns(page);
        const column = columns.find(item => item.type === 'text') || columns[0];
        if (column) {
          focusCell(view, [page.addedRow.id, column.id]);
          view.cells.get(page.addedRow.id)?.get(column.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      } finally {
        view.addingRow = false;
        if (view.addRow) view.addRow.disabled = false;
      }
    }

    function orderNodes(parent, nodes) {
      const wanted = new Set(nodes);
      for (const child of Array.from(parent.children)) if (!wanted.has(child)) child.remove();
      let previous = null;
      for (const node of nodes) {
        const next = previous ? previous.nextElementSibling : parent.firstElementChild;
        if (node !== next) parent.insertBefore(node, next);
        previous = node;
      }
    }

    function widthOf(column) { return column.width || 176; }

    function resizeColumn(view, column, handle, event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.panel?.close();
      const track = view.headers.get(column.id)?.track;
      if (!track) return;
      const start = event.clientX, original = widthOf(column);
      let width = original;
      const controller = new AbortController(), { signal } = controller;
      const finish = commit => {
        controller.abort();
        view.stopResize = null;
        view.root.classList.remove('is-resizing');
        if (commit && width !== original) {
          void write(view.session, { type: 'columnLayout', column: column.id, width }).then(page => {
            if (!page && track.isConnected) draw(view);
          });
        } else if (track.isConnected) draw(view);
      };
      view.stopResize?.(false);
      view.stopResize = finish;
      view.root.classList.add('is-resizing');
      handle.setPointerCapture?.(event.pointerId);
      handle.addEventListener('pointermove', move => {
        if (move.pointerId !== event.pointerId) return;
        width = clampWidth(original + move.clientX - start);
        track.style.width = width + 'px';
        view.grid.style.width = 'max(100%, ' + (view.gridWidth - original + width) + 'px)';
      }, { signal });
      handle.addEventListener('pointerup', up => {
        if (up.pointerId === event.pointerId) finish(true);
      }, { signal });
      handle.addEventListener('lostpointercapture', () => finish(false), { signal });
      window.addEventListener('blur', () => finish(false), { signal });
    }

    function buildHeader(view, column) {
      const track = element('col'), cell = element('th', 'note-database-field');
      cell.scope = 'col';
      const shell = element('div', 'note-database-field-inner');
      if (view.readOnly) shell.append(element('span', 'note-database-type', typeSymbols[column.type]), element('span', '', column.name));
      else {
        const title = button(column.name, event => afterCellSave(view, () => columnMenu(view, event.currentTarget || title, column)), 'edit-' + column.id);
        title.className = 'note-database-field-title';
        title.title = column.name;
        title.prepend(element('span', 'note-database-type', typeSymbols[column.type]));
        const handle = iconButton('', tr(label('调整列宽', 'Resize field')), () => {}, 'size-' + column.id);
        handle.className = 'note-database-resize';
        handle.addEventListener('pointerdown', event => resizeColumn(view, column, handle, event));
        handle.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const width = clampWidth(widthOf(column) + (event.key === 'ArrowRight' ? 16 : -16));
          void write(view.session, { type: 'columnLayout', column: column.id, width });
        });
        title.draggable = true;
        title.addEventListener('dragstart', event => {
          view.dragColumn = column.id;
          event.dataTransfer?.setData('application/x-relatum-database-field', column.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        title.addEventListener('dragend', () => { view.dragColumn = null; cell.classList.remove('is-drop-target'); });
        cell.addEventListener('dragover', event => {
          if (!view.dragColumn || view.dragColumn === column.id) return;
          event.preventDefault(); event.stopPropagation();
          cell.classList.add('is-drop-target');
        });
        cell.addEventListener('dragleave', event => { if (!cell.contains(event.relatedTarget)) cell.classList.remove('is-drop-target'); });
        cell.addEventListener('drop', event => {
          const dragged = view.dragColumn;
          if (!dragged) return;
          event.preventDefault(); event.stopPropagation();
          view.dragColumn = null;
          cell.classList.remove('is-drop-target');
          void moveColumn(view, dragged, column.id);
        });
        shell.append(title, handle);
      }
      cell.append(shell);
      return { cell, track };
    }

    function showRowMenu(view, anchor, row) {
      panelAt(view, anchor, 'row', (panel, close) => {
        panel.append(button(tr(label('删除记录', 'Delete row')), () => {
          const index = visibleRows(view).findIndex(item => item.id === row.id);
          close();
          void write(view.session, { type: 'deleteRow', row: row.id }).then(saved => {
            if (saved && view.pinned?.id === row.id) { view.pinned = null; draw(view); }
            if (!saved || !view.host.isConnected || !isVisible(view.session)) return;
            const neighbor = visibleRows(view)[Math.max(0, Math.min(index, visibleRows(view).length - 1))];
            const first = shownColumns(view.session.page)[0];
            if (neighbor && first) focusCell(view, [neighbor.id, first.id]);
            else view.addRow?.focus({ preventScroll: true });
          });
        }));
      });
    }

    function buildGrid(view) {
      const { session, body } = view;
      body.replaceChildren();
      view.bar = element('div', 'note-database-toolbar');
      view.search = input('search', tr(label('搜索数据库', 'Search database')), session.query.search);
      view.search.dataset.dbRole = 'search';
      view.search.placeholder = tr(label('搜索', 'Search'));
      view.search.maxLength = 256;
      view.search.hidden = true;
      view.search.addEventListener('input', event => {
        if (!composing(event)) changeQuery(session, { search: view.search.value }, 120);
      });
      view.search.addEventListener('compositionstart', () => { view.searchComposing = true; });
      view.search.addEventListener('compositionend', () => {
        view.searchComposing = false;
        changeQuery(session, { search: view.search.value }, 120);
      });
      view.search.addEventListener('keydown', event => {
        if (!composing(event) && event.key === 'Escape') {
          view.searchOpen = false;
          if (session.query.search) changeQuery(session, { search: '' });
          view.search.hidden = true;
          view.searchToggle.focus();
        }
      });
      view.searchToggle = iconButton('search', tr(label('搜索', 'Search')), () => {
        view.searchOpen = view.search.hidden;
        view.search.hidden = !view.searchOpen;
        view.searchToggle.setAttribute('aria-expanded', String(view.searchOpen));
        if (view.searchOpen) view.search.focus();
      }, 'search-toggle');
      view.viewToggle = iconButton('view', tr(label('视图选项', 'View options')), () =>
        afterCellSave(view, () => viewMenu(view, view.viewToggle)), 'view');
      view.bar.append(view.search, view.searchToggle, view.viewToggle);

      view.overflow = element('div', 'note-database-overflow');
      view.grid = element('table', 'note-database-grid');
      view.tracks = element('colgroup');
      view.grid.append(view.tracks);
      view.header = view.grid.createTHead().insertRow();
      view.rows = view.grid.createTBody();
      view.headers = new Map();
      view.rowEntries = new Map();
      view.fillerTrack = element('col');
      view.fillerHeader = element('th', 'note-database-filler');
      view.fillerHeader.setAttribute('aria-hidden', 'true');
      view.laneTrack = element('col', 'note-database-lane-track');
      view.lane = element('th', 'note-database-lane');
      view.lane.scope = 'col';
      const plus = tr(label('添加字段', 'Add field'));
      view.addColumn = iconButton('plus', plus, () => afterCellSave(view, () => addColumn(view, view.addColumn)), 'add-column');
      view.lane.append(view.addColumn);
      view.overflow.append(view.grid);
      view.addRow = iconButton('plus', tr(label('添加记录', 'Add row')), () => afterCellSave(view, () => addRow(view)), 'add-row');
      view.addRow.classList.add('note-database-add-row');
      view.pager = element('div', 'note-database-pagination');
      view.prev = iconButton('prev', tr(label('上一页', 'Previous')), () => changeQuery(session, { page: session.page.page - 1 }), 'prev');
      view.next = iconButton('next', tr(label('下一页', 'Next')), () => changeQuery(session, { page: session.page.page + 1 }), 'next');
      view.pageText = element('span');
      view.pager.append(view.prev, view.pageText, view.next);
      body.append(view.bar, view.overflow);
      if (!view.readOnly) body.append(view.addRow);
      body.append(view.pager);
    }

    function renderView(view) {
      const { session, body } = view;
      const page = session.page;
      if (!page?.exists) {
        view.panel?.close();
        view.grid = null;
        body.replaceChildren();
        if (!page && session.status) body.append(button(tr(label('重试', 'Retry')), () => refresh(session.path)));
        if (page && view.readOnly) body.append(element('span', 'note-database-placeholder', tr(label('数据库尚未创建', 'Database not created'))));
        if (page && !view.readOnly) body.append(button(tr(label('创建数据库', 'Create database')), () => write(session, { type: 'create' }), 'create'));
        return;
      }
      if (!view.grid) buildGrid(view);
      const { query } = session;
      const columns = shownColumns(page);
      const language = options.language?.() || 'zh';
      if (view.language !== language) {
        view.language = language;
        view.root.setAttribute('aria-label', tr(label('数据库', 'Database')));
        view.search.placeholder = tr(label('搜索', 'Search'));
        view.search.setAttribute('aria-label', tr(label('搜索数据库', 'Search database')));
        const controls = [[view.searchToggle, label('搜索', 'Search')], [view.viewToggle, label('视图选项', 'View options')],
          [view.addColumn, label('添加字段', 'Add field')], [view.addRow, label('添加记录', 'Add row')],
          [view.prev, label('上一页', 'Previous')], [view.next, label('下一页', 'Next')]];
        for (const [control, names] of controls) {
          control.title = tr(names);
          control.setAttribute('aria-label', control.title);
        }
      }
      const activeBefore = document.activeElement;
      const focusedCell = view.grid.contains(activeBefore) && activeBefore.classList.contains('note-database-cell-value');
      const focusedHeader = view.header.contains(activeBefore) && activeBefore.dataset.dbRole;
      if (!view.searchComposing && view.search.value !== query.search) view.search.value = query.search;
      view.search.hidden = !(view.searchOpen ?? Boolean(query.search));
      view.searchToggle.setAttribute('aria-expanded', String(!view.search.hidden));
      view.searchToggle.classList.toggle('is-engaged', Boolean(query.search));
      view.viewToggle.classList.toggle('is-engaged', Boolean(query.sort || query.filters.length || page.columns.some(column => column.hidden)));
      const headers = new Map();
      let width = view.readOnly ? 0 : 34;
      for (const column of columns) {
        const contentKey = JSON.stringify([column.name, column.type, column.choices, language]);
        const existing = view.headers.get(column.id);
        const header = existing?.contentKey === contentKey && existing.width === column.width
          ? existing : { ...buildHeader(view, column), contentKey, width: column.width };
        const sort = query.sort?.column === column.id ? query.sort.direction : null;
        header.cell.setAttribute('aria-sort', sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none');
        header.track.style.width = widthOf(column) + 'px';
        width += widthOf(column);
        headers.set(column.id, header);
      }
      view.headers = headers;
      view.gridWidth = width;
      view.grid.style.width = 'max(100%, ' + width + 'px)';
      view.addColumn.disabled = page.columns.length >= 32;
      const heads = Array.from(headers.values());
      orderNodes(view.tracks, [...heads.map(header => header.track), view.fillerTrack, ...(view.readOnly ? [] : [view.laneTrack])]);
      orderNodes(view.header, [...heads.map(header => header.cell), view.fillerHeader, ...(view.readOnly ? [] : [view.lane])]);
      const nextRows = new Map(), focused = view.selection?.head;
      view.cells = new Map();
      for (const row of visibleRows(view)) {
        const entry = view.rowEntries.get(row.id) || { line: element('tr'), entries: new Map(),
          filler: element('td', 'note-database-filler') };
        const { line } = entry, nextCells = new Map(), controls = new Map();
        line.dataset.record = row.id;
        line.classList.toggle('is-pinned', view.pinned?.id === row.id);
        for (const column of columns) {
          const saved = entry.entries.get(column.id);
          const cell = saved?.cell || element('td');
          const value = row.values[column.id];
          const valueKey = value && typeof value === 'object' ? JSON.stringify(value) : value;
          const contentKey = headers.get(column.id).contentKey;
          const draft = session.draft;
          let control = saved?.control;
          if (!view.readOnly && draft?.detached && draft.row.id === row.id && draft.column.id === column.id) {
            draft.view = view;
            draft.detached = false;
            control = editorFor(draft);
          } else if (saved?.contentKey !== contentKey || saved.valueKey !== valueKey || !control?.isConnected
              || !cell.contains(control) || control.classList.contains('note-database-cell-input')) {
            control = cellControl(view, row, column);
          }
          if (cell.firstChild !== control) cell.replaceChildren(control);
          nextCells.set(column.id, { cell, control, contentKey, valueKey });
          controls.set(column.id, control);
        }
        if (!view.readOnly) {
          if (!entry.lane) {
            entry.lane = element('td', 'note-database-lane note-database-row-action');
            entry.menu = iconButton('more', '', () => showRowMenu(view, entry.menu, row), 'row-menu');
            entry.menu.tabIndex = -1;
            entry.lane.append(entry.menu);
            line.addEventListener('contextmenu', event => {
              event.preventDefault(); event.stopPropagation(); showRowMenu(view, entry.menu, row);
            });
          }
          if (entry.language !== language) {
            entry.language = language;
            entry.menu.title = tr(label('记录操作', 'Row actions'));
            entry.menu.setAttribute('aria-label', entry.menu.title);
          }
        }
        entry.filler.setAttribute('aria-hidden', 'true');
        orderNodes(line, [...Array.from(nextCells.values(), item => item.cell), entry.filler, ...(view.readOnly ? [] : [entry.lane])]);
        entry.entries = nextCells;
        nextRows.set(row.id, entry);
        view.cells.set(row.id, controls);
      }
      view.rowEntries = nextRows;
      orderNodes(view.rows, Array.from(nextRows.values(), item => item.line));
      if (view.panel && !view.panel.anchor.isConnected) view.panel.close();
      if (!bounds(view)) view.selection = null;
      paintSelection(view);
      const count = Math.max(1, Math.ceil(page.total / page.pageSize));
      view.pager.hidden = count <= 1;
      view.prev.disabled = page.page <= 1;
      view.next.disabled = page.page >= count;
      view.pageText.textContent = page.page + ' / ' + count;
      if (focusedCell && focused && activeBefore !== document.activeElement) {
        (view.cells.get(focused[0])?.get(focused[1]) || view.tabStop || view.addRow)?.focus({ preventScroll: true });
      } else if (focusedHeader && !activeBefore.isConnected) {
        view.header.querySelector('[data-db-role="' + CSS.escape(focusedHeader) + '"]')?.focus({ preventScroll: true });
      }
    }

    function stopObserving(view) {
      if (!observed.delete(view.root)) return;
      observer.unobserve(view.root);
      if (!observed.size) {
        observer.disconnect();
        observer = null;
      }
    }

    function watch(view) {
      if (!observer) observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const current = observed.get(entry.target);
          if (!current || current.visible === entry.isIntersecting) continue;
          current.visible = entry.isIntersecting;
          if (current.visible) {
            draw(current);
            void read(current.session);
          } else if (current.session.draft?.view === current) dismissSuggestions(current.session.draft);
        }
      });
      observed.set(view.root, view);
      observer.observe(view.root);
    }

    function mount(host, { path, readOnly = false, observe = false, onLayout } = {}) {
      if (destroyed || !path) return () => {};
      const session = getSession(path);
      const root = element('section', 'note-database');
      root.contentEditable = 'false';
      root.setAttribute('aria-label', tr(label('数据库', 'Database')));
      const body = element('div', 'note-database-body');
      const status = element('div', 'note-database-status', session.status);
      status.hidden = !session.status;
      status.setAttribute('role', 'status');
      root.append(body, status);
      host.append(root);
      const view = { session, host, root, body, status, readOnly, onLayout, visible: !observe || !window.IntersectionObserver };
      root.addEventListener('copy', event => clipboard(view, event));
      root.addEventListener('paste', event => clipboard(view, event));
      root.addEventListener('keydown', event => {
        if (readOnly || composing(event) || !(event.ctrlKey || event.metaKey) || event.altKey
            || event.target.closest('input,textarea,select') || view.panel || session.draft) return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault(); event.stopPropagation();
        const replay = key === 'y' || event.shiftKey ? 'redo' : 'undo';
        const changes = session[replay].at(-1)?.changes;
        if (changes && !session.write) void write(session, { type: 'applyRecords', changes }, replay);
      });
      root.addEventListener('pointerup', () => { view.dragCell = false; });
      root.addEventListener('pointercancel', () => { view.dragCell = false; });
      root.addEventListener('focusout', () => queueMicrotask(() => {
        if (!view.visible || !root.isConnected) return;
        const next = document.activeElement?.closest('[data-record]')?.dataset.record;
        if (!view.addingRow) releasePinned(view, next);
      }));
      session.views.add(view);
      if (view.visible) { draw(view); void read(session); }
      else watch(view);
      return () => {
        view.panel?.close();
        view.stopResize?.(false);
        stopObserving(view);
        view.visible = false;
        session.views.delete(view);
        const draft = session.draft;
        if (draft?.view === view) {
          dismissSuggestions(draft);
          draft.detached = true;
          if (!draft.composition && !draft.error && !destroyed && isVisible(session)) void commitDraft(draft);
        }
        root.remove();
      };
    }

    async function confirm(message, callback = options.confirm) {
      return callback ? await callback(message) : window.confirm(tr(message));
    }

    async function actionFromTree(path, kind, callback) {
      const session = getSession(path);
      try {
        const page = await loadPage(path, session.query, AbortSignal.timeout(10000));
        if (destroyed || sessions.get(path) !== session) return false;
        applyPage(session, page);
        if (!page.exists) {
          options.onNotice?.(tr(label('这篇笔记没有数据库。', 'This note has no database.')));
          return false;
        }
        let action = { type: 'delete', revision: page.revision };
        let count = 0;
        let message = label('将数据库和其中的附件移到系统回收站？正文中的占位会保留。',
          'Move this database and its attachments to the Recycle Bin? Its placeholders stay in the note.');
        if (kind === 'cleanup') {
          const preview = await request(actionRoute, { path, action: { type: 'previewCleanup', revision: page.revision } });
          if (!preview.count) {
            options.onNotice?.(tr(label('没有可清理的附件。', 'There are no unused attachments.')));
            return false;
          }
          count = preview.count;
          action = { type: 'cleanup', revision: preview.revision, candidateToken: preview.candidateToken };
          message = label(`将 ${preview.count} 个未使用附件移到系统回收站？`, `Move ${preview.count} unused attachment(s) to the Recycle Bin?`);
        }
        if (destroyed || !await confirm(message, callback) || sessions.get(path) !== session) return false;
        const written = await write(session, action);
        if (written && kind === 'cleanup') options.onNotice?.(tr(label(`已回收 ${count} 个未使用附件。`, `Moved ${count} unused attachment(s) to the Recycle Bin.`)));
        return written;
      } catch (error) {
        if (!destroyed) options.onError?.(error);
        return false;
      }
    }

    async function importFiles(path, files) {
      if (destroyed) return 0;
      const session = getSession(path);
      let imported = 0;
      let error = null;
      let lastResponse = null;
      for (const file of files) {
        if (destroyed || sessions.get(path) !== session) break;
        if (!acceptsFile(file)) continue;
        if (file.size > maxFileSize) { error = new Error(tr(label('单个附件不能超过 100 MiB。', 'An attachment cannot exceed 100 MiB.'))); continue; }
        try {
          const data = await readFile(file);
          if (destroyed || sessions.get(path) !== session) break;
          const currentPage = session.page;
          const query = JSON.stringify(session.query);
          const page = await request(importRoute, { path, name: file.name, data, query: session.query });
          lastResponse = { currentPage, page, query };
          imported++;
        } catch (failure) { error = failure; }
      }
      if (imported && !destroyed && sessions.get(path) === session) {
        markChanged(session);
        if (!session.read && !session.write && session.page === lastResponse.currentPage && JSON.stringify(session.query) === lastResponse.query) {
          session.stale = false;
          applyPage(session, lastResponse.page);
        } else {
          void refresh(path, true);
        }
        if (isVisible(session)) options.onNotice?.(tr(label(`已导入 ${imported} 个附件。`, `Imported ${imported} attachment(s).`)));
      }
      if (error && isVisible(session)) options.onError?.(error);
      return imported;
    }

    function setActive(path, visible = true) {
      if (activePath === path && activeVisible === visible) return;
      const previous = sessions.get(activePath);
      if (previous) {
        stopRead(previous);
        previous.stale = true;
        if (previous.draft) dismissSuggestions(previous.draft);
        for (const view of previous.views) {
          view.panel?.close();
          view.stopResize?.(false);
          view.pinned = null;
        }
      }
      activePath = path;
      activeVisible = visible;
      if (visible) void refresh(path);
    }

    function clear(path, force = false) {
      const session = sessions.get(path);
      if (!session) return;
      stopRead(session);
      if (session.draft) dismissSuggestions(session.draft);
      for (const view of session.views) {
        view.panel?.close();
        view.stopResize?.(false);
        stopObserving(view);
        view.visible = false;
        view.root.remove();
      }
      session.views.clear();
      if (!force && (session.draft?.changed || session.draft?.composition || session.write)) {
        if (session.draft) session.draft.detached = true;
        session.stale = true;
        return;
      }
      sessions.delete(path);
      notifyDirty();
    }

    function remap(source, destination) {
      if (!source || !destination || source === destination) return;
      const movedPath = path => path === source || path?.startsWith(source + '/') ? destination + path.slice(source.length) : path;
      for (const [path, session] of Array.from(sessions)) {
        const moved = movedPath(path);
        if (moved === path) continue;
        stopRead(session);
        if (session.draft) dismissSuggestions(session.draft);
        sessions.delete(path);
        session.path = moved;
        session.stale = true;
        sessions.set(moved, session);
      }
      activePath = movedPath(activePath);
      void refresh();
    }

    const focus = () => { if (activeVisible) void refresh(); };
    const dismiss = () => {
      const session = sessions.get(activePath);
      if (session?.draft) dismissSuggestions(session.draft);
    };
    const languageChange = () => {
      const session = sessions.get(activePath);
      if (session) for (const view of session.views) if (view.visible) { view.panel?.close(); draw(view); }
    };
    window.addEventListener('focus', focus);
    window.addEventListener('blur', dismiss);
    document.addEventListener('relatum:languagechange', languageChange);
    if (channel) channel.onmessage = event => { if (event.data?.path === activePath) void refresh(activePath, true); };

    return {
      mount, setActive, refresh, clear, remap, acceptsFile, importFiles,
      noteSaved: path => { const session = sessions.get(path); if (session) markChanged(session); void refresh(path, true); },
      cleanup: (path, callback) => actionFromTree(path, 'cleanup', callback),
      remove: (path, callback) => actionFromTree(path, 'delete', callback),
      inputPending: () => Boolean(sessions.get(activePath)?.draft || sessions.get(activePath)?.write),
      get dirty() { return dirty(); },
      async whenInputSettled(path) {
        const targets = path ? [sessions.get(path)] : sessions.values();
        for (const session of targets) {
          if (session?.write) {
            try { await session.write; } catch (_) { return false; }
          }
          const draft = session?.draft;
          if (!draft) continue;
          await draft.composition;
          if (draft.error) return false;
          if (session.draft === draft && !await commitDraft(draft)) return false;
        }
        return true;
      },
      destroy() {
        destroyed = true;
        for (const path of sessions.keys()) clear(path, true);
        channel?.close();
        window.removeEventListener('focus', focus);
        window.removeEventListener('blur', dismiss);
        document.removeEventListener('relatum:languagechange', languageChange);
      },
    };
  }

  window.RelatumNoteDatabase = { create, renderPrint, acceptsFile };
})();

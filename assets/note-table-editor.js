// Native cell input inside a stable Markdown projection. The document, history
// and saving remain owned by the parent CodeMirror; preedit stays in textarea.
(function () {
  'use strict';
  const CM = window.RelatumCodeMirror;
  const syntax = window.MarkdownTable;
  if (!CM || !syntax) return;
  const text = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const matrix = (model) => [model.header, ...model.rows].map((row) => row.slice());
  const modelOf = (rows, align) => syntax.normalizeModel({ header: rows[0] || [''], rows: rows.slice(1), align }, { ensureBodyRow: false });
  // CSS viewport coordinates, never document/source positions. Only grip
  // reorders use this one-axis mapping; text and cell hit testing stay separate.
  const inWindow = point => point.clientX >= 0 && point.clientX < window.innerWidth
    && point.clientY >= 0 && point.clientY < window.innerHeight;
  function axisGap(rects, kind, position) {
    const gap = rects.findIndex(rect => position < (kind === 'row' ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2));
    return gap < 0 ? rects.length : gap;
  }

  function createController(options) {
    let active = null;
    let operation = 0;
    const surfaces = new Set();
    const scrollers = new Map();
    let scrollLock = null;
    let measureFrame = 0;
    let measureWaiting = false, disposed = false;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => controller.measure()) : null;
    const controller = {
      options,
      route(surface, callback) {
        const id = surface.widget.spec.id, epoch = surface.widget.epoch, path = surface.widget.notePath;
        const seq = ++operation;
        this.bodyPosition = null;
        const run = () => {
          if (seq !== operation) return;
          const latest = Array.from(surfaces).find((candidate) => candidate.widget.spec.id === id
            && candidate.widget.epoch === epoch && candidate.widget.notePath === path && candidate.current());
          if (latest) callback(latest);
        };
        if (this.pending()) this.whenSettled().then(run);
        else if (surface.view.__relatumInputSession && surface.view.__relatumInputSession.pending()) surface.view.__relatumInputSession.whenSettled().then(run);
        else run();
      },
      pending() { return Array.from(surfaces).some((surface) => surface.pending()); },
      spec(id) { const surface = Array.from(surfaces).find((candidate) => candidate.widget.spec.id === id && candidate.current()); return surface && surface.current(); },
      boundary(view) {
        const main = view.state.selection.main; if (!main.empty) return null;
        for (const surface of surfaces) {
          const spec = surface.current();
          if (spec && main.head >= spec.from && main.head <= spec.to) return { id: spec.id, side: main.head === spec.from ? 'before' : 'after' };
        }
        return null;
      },
      editAtSelection(view) {
        const head = view.state.selection.main.head;
        const surface = Array.from(surfaces).find(candidate => { const spec = candidate.current(); return spec && head >= spec.from && head <= spec.to; });
        if (surface) this.route(surface, latest => latest.open(0, 0));
      },
      routeBody(callback, view, position) {
        const seq = ++operation;
        this.bodyPosition = position == null ? null : { seq, position };
        const run = () => {
          if (seq !== operation) return;
          if (active) { active.cancelGesture(); active.cancelReorderIntent(); active.close(); active.selection = null; active.paintSelection(); active.hideEdges(); }
          const target = this.bodyPosition && this.bodyPosition.seq === seq ? this.bodyPosition.position : null;
          this.bodyPosition = null; callback(target);
        };
        const session = (view || active && active.view || Array.from(surfaces)[0]?.view)?.__relatumInputSession;
        if (this.pending()) this.whenSettled().then(run);
        else if (session && session.pending()) session.whenSettled().then(run); else run();
      },
      mapBodyPosition(changes) { if (this.bodyPosition) this.bodyPosition.position = changes.mapPos(this.bodyPosition.position, 1); },
      bodyHit(point, position) {
        for (const surface of surfaces) {
          const spec = surface.current(); if (!spec) continue;
          const rect = surface.table.getBoundingClientRect();
          if ((position === spec.to || position == null && /^\n*$/.test(surface.view.state.doc.sliceString(spec.to)))
              && point.clientY >= rect.bottom) return { id: spec.id, side: 'after' };
          if (position === spec.from && point.clientY <= rect.top) return { id: spec.id, side: 'before' };
        }
        return null;
      },
      whenSettled() { return Promise.all(Array.from(surfaces, (surface) => surface.whenSettled())); },
      close() { operation++; this.bodyPosition = null; if (active) { active.cancelGesture(); active.cancelReorderIntent(); active.close(); } },
      activate(surface) { if (active && active !== surface) active.close(); active = surface; },
      attach(surface) {
        surfaces.add(surface); if (observer) { observer.observe(surface.table); observer.observe(surface.wrap); }
        const scroller = surface.view.scrollDOM;
        if (!scrollers.has(scroller)) {
          const handler = () => surfaces.forEach(candidate => { candidate.geometryCache = null; if (!candidate.gesture) candidate.hideEdges(); if (!candidate.pending()) candidate.paintSelection(); candidate.refreshReorder(); });
          // Observe the surrounding paper too, so an outer-edge handle can be
          // approached without first hitting a narrow strip inside a cell.
          const pointer = event => {
            if (Array.from(surfaces).some(candidate => candidate.gesture)) return;
            surfaces.forEach(candidate => candidate.hover(event));
          };
          const leave = () => surfaces.forEach(candidate => { if (!candidate.gesture) candidate.hideEdges(); });
          scrollers.set(scroller, { handler, pointer, leave });
          scroller.addEventListener('scroll', handler, { passive: true });
          scroller.addEventListener('pointermove', pointer, { passive: true });
          scroller.addEventListener('pointerleave', leave);
        }
      },
      detach(surface) { surfaces.delete(surface); if (observer) { observer.unobserve(surface.table); observer.unobserve(surface.wrap); } if (active === surface) active = null; },
      measure() {
        if (measureFrame || disposed) return;
        measureFrame = requestAnimationFrame(() => {
          measureFrame = 0;
          if (this.pending()) {
            if (!measureWaiting) { measureWaiting = true; this.whenSettled().then(() => { measureWaiting = false; this.measure(); }); }
            return;
          }
          surfaces.forEach((surface) => {
            surface.sizeEditor();
            surface.geometryCache = null; surface.paintSelection();
            surface.refreshReorder();
            const rect = surface.table.getBoundingClientRect(), wrap = surface.wrap.getBoundingClientRect();
            const size = rect.width + ':' + rect.height + ':' + wrap.width + ':' + wrap.height;
            if (size !== surface.measuredSize) { surface.measuredSize = size; surface.view.requestMeasure(); }
          });
        });
      },
      lockScroll(surface) {
        if (scrollLock) return;
        const scroller = surface.view.scrollDOM;
        const lock = scrollLock = { surface, scroller, top: scroller.scrollTop, left: scroller.scrollLeft, target: null };
        lock.handler = () => {
          if (scroller.scrollTop === lock.top && scroller.scrollLeft === lock.left) return;
          lock.target = { top: scroller.scrollTop, left: scroller.scrollLeft };
          // Keep the browser-owned IME host in the mounted viewport. Reparenting
          // a focused textarea would make Chromium commit provisional Pinyin.
          scroller.scrollTop = lock.top; scroller.scrollLeft = lock.left;
        };
        scroller.addEventListener('scroll', lock.handler, { capture: true, passive: true });
      },
      unlockScroll(surface, apply) {
        if (!scrollLock || scrollLock.surface !== surface) return;
        const lock = scrollLock; scrollLock = null;
        lock.scroller.removeEventListener('scroll', lock.handler, true);
        if (apply && lock.target && lock.scroller.isConnected) {
          lock.scroller.scrollTop = lock.target.top; lock.scroller.scrollLeft = lock.target.left;
        }
      },
      destroy() { disposed = true; operation++; if (observer) observer.disconnect(); if (measureFrame) cancelAnimationFrame(measureFrame); scrollers.forEach(({ handler, pointer, leave }, scroller) => { scroller.removeEventListener('scroll', handler); scroller.removeEventListener('pointermove', pointer); scroller.removeEventListener('pointerleave', leave); }); scrollers.clear(); surfaces.forEach((surface) => surface.destroy()); surfaces.clear(); active = null; },
      widget(spec, notePath, coordinator) { return new TableWidget(spec, notePath, coordinator, this); },
    };
    return controller;
  }

  class TableWidget extends CM.WidgetType {
    constructor(spec, notePath, coordinator, controller) {
      super(); this.spec = spec; this.notePath = notePath; this.coordinator = coordinator;
      this.controller = controller; this.epoch = coordinator.epoch;
    }
    eq(other) {
      return other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint
        && other.notePath === this.notePath && other.epoch === this.epoch;
    }
    toDOM(view) { return new TableSurface(this, view).wrap; }
    updateDOM(dom) {
      const surface = dom.__noteTableSurface;
      if (!surface || surface.widget.spec.id !== this.spec.id || surface.widget.epoch !== this.epoch
          || surface.widget.notePath !== this.notePath) return false;
      surface.sync(this);
      return true;
    }
    destroy(dom) { if (dom.__noteTableSurface) dom.__noteTableSurface.destroy(); }
    ignoreEvent() { return true; }
  }

  class TableSurface {
    constructor(widget, view) {
      this.widget = widget; this.view = view; this.controller = widget.controller;
      this.model = syntax.parse(widget.spec.source, { ensureBodyRow: false }).model;
      this.selection = null; this.edit = null; this.phase = 'idle';
      this.frame = 0; this.sequence = 0; this.waiters = []; this.disposed = false;
      this.dragCleanup = null;
      const wrap = this.wrap = document.createElement('div');
      wrap.className = 'note-live-rich-block is-table note-table';
      wrap.tabIndex = 0; wrap.contentEditable = 'false';
      wrap.setAttribute('aria-label', text('表格：单击编辑，内部拖选，边缘手柄移动行列', 'Table: click to edit, drag cells to select, drag edge grips to reorder'));
      wrap.__noteTableSurface = this;
      this.scroll = document.createElement('div'); this.scroll.className = 'note-table-scroll';
      this.table = document.createElement('table');
      this.body = document.createElement('tbody'); this.table.appendChild(this.body);
      this.scroll.appendChild(this.table); wrap.append(this.scroll);
      this.grip = this.button('', ''); this.grip.classList.add('note-table-grip'); this.grip.hidden = true;
      for (let i = 0; i < 6; i++) this.grip.appendChild(document.createElement('i'));
      this.add = this.button('', '+'); this.add.classList.add('note-table-add'); this.add.hidden = true;
      this.outline = document.createElement('div'); this.outline.className = 'note-table-selection'; this.outline.hidden = true;
      this.drop = document.createElement('div'); this.drop.className = 'note-table-drop'; this.drop.hidden = true;
      this.outline.setAttribute('aria-hidden', 'true'); this.drop.setAttribute('aria-hidden', 'true');
      wrap.append(this.grip, this.add, this.outline, this.drop);
      wrap.addEventListener('pointerdown', (event) => this.pointerDown(event));
      wrap.addEventListener('mousedown', (event) => event.stopPropagation());
      this.scroll.addEventListener('scroll', () => { this.geometryCache = null; if (!this.gesture) this.hideEdges(); this.paintSelection(); this.refreshReorder(); });
      wrap.addEventListener('click', (event) => this.click(event));
      wrap.addEventListener('dragstart', (event) => { event.preventDefault(); event.stopPropagation(); });
      wrap.addEventListener('keydown', (event) => this.keydown(event));
      wrap.addEventListener('copy', (event) => this.copy(event, false));
      wrap.addEventListener('cut', (event) => this.copy(event, true));
      wrap.addEventListener('paste', (event) => this.paste(event));
      wrap.addEventListener('contextmenu', (event) => { event.stopPropagation(); if (event.target.tagName !== 'TEXTAREA') event.preventDefault(); });
      // These must never join the parent contenteditable's IME or clipboard chain.
      for (const name of ['beforeinput', 'input', 'compositionstart', 'compositionend', 'keyup', 'focusin', 'focusout']) {
        wrap.addEventListener(name, (event) => event.stopPropagation());
      }
      this.controller.attach(this); this.render();
    }
    button(label, glyph) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'note-table-control'; button.title = label;
      button.setAttribute('aria-label', label); button.textContent = glyph;
      return button;
    }
    current() {
      if (this.disposed || this.widget.coordinator.epoch !== this.widget.epoch || !this.wrap.isConnected) return null;
      return this.widget.coordinator.spec(this.view, this.widget.spec.id);
    }
    sync(widget) {
      this.widget = widget;
      const parsed = syntax.parse(widget.spec.source, { ensureBodyRow: false });
      if (!parsed.ok) return;
      this.model = parsed.model;
      this.render();
    }
    render() {
      const rows = matrix(this.model), columns = this.model.header.length;
      const shape = rows.length + ':' + columns;
      if (shape !== this.shape) {
        // Shape changes only happen after cell composition has settled.
        if (this.pending()) return;
        this.cancelGesture(); this.cancelReorderIntent();
        this.removeEditor(); this.selection = null; this.clearMath(this.body); this.shape = shape; this.body.replaceChildren();
        for (let r = 0; r < rows.length; r++) {
          const tr = document.createElement('tr'); tr.dataset.tableDataRow = r;
          for (let c = 0; c < columns; c++) {
            const cell = document.createElement('td'); cell.dataset.tableRow = r; cell.dataset.tableCol = c;
            cell.style.textAlign = this.model.align[c] || 'left';
            const content = document.createElement('div'); content.className = 'note-table-cell-content';
            cell.appendChild(content); tr.appendChild(cell);
          }
          this.body.appendChild(tr);
        }
        this.hideEdges();
      }
      this.body.querySelectorAll('td[data-table-row]').forEach((cell) => {
        const r = Number(cell.dataset.tableRow), c = Number(cell.dataset.tableCol);
        const value = rows[r][c] || '';
        const content = cell.firstElementChild;
        if (content.dataset.source !== value) {
          this.clearMath(content);
          content.dataset.source = value;
          const result = this.controller.options.renderTableCell(value);
          const renderedContent = document.createElement('span'); renderedContent.dataset.source = value;
          if (result) {
            const template = document.createElement('template'); template.innerHTML = result.html;
            const rendered = template.content.querySelector('th,td');
            renderedContent.innerHTML = rendered ? rendered.innerHTML : '';
          }
          else renderedContent.textContent = value;
          renderedContent.querySelectorAll('input,button,textarea,iframe').forEach((node) => node.remove());
          content.replaceChildren(renderedContent);
          this.controller.options.prepareTableCell(this, renderedContent, result || {}, value);
        }
        cell.style.textAlign = this.model.align[c] || 'left';
        if (this.edit && this.edit.row === r && this.edit.col === c && !this.pending()
            && !this.committing && this.edit.input.value !== value) this.edit.input.value = value;
      });
      this.geometryCache = null; this.paintSelection(); this.sizeEditor(); this.controller.measure();
    }
    cell(row, col) { return this.body.querySelector('td[data-table-row="' + row + '"][data-table-col="' + col + '"]'); }
    bounds() {
      const s = this.selection;
      return s ? { r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) } : null;
    }
    geometry() {
      if (this.geometryCache) return this.geometryCache;
      const rows = Array.from(this.body.rows, (row) => row.getBoundingClientRect());
      const cols = Array.from(this.body.rows[0] ? this.body.rows[0].cells : [], (cell) => cell.getBoundingClientRect());
      return this.geometryCache = { rows, cols, rect: this.table.getBoundingClientRect(), wrap: this.wrap.getBoundingClientRect() };
    }
    hit(point, clamp) {
      const g = this.geometry(), x = point.clientX, y = point.clientY;
      if (!g.rows.length || !g.cols.length || !clamp && (x < g.rect.left || x > g.rect.right || y < g.rect.top || y > g.rect.bottom)) return null;
      let row = g.rows.findIndex(rect => y < rect.bottom), col = g.cols.findIndex(rect => x < rect.right);
      if (row < 0) row = g.rows.length - 1; if (col < 0) col = g.cols.length - 1;
      return { row, col };
    }
    positionOverlay(node, x, y, width, height) {
      const rect = this.wrap.getBoundingClientRect();
      node.style.left = (x - rect.left) + 'px'; node.style.top = (y - rect.top) + 'px';
      if (width !== undefined) node.style.width = width + 'px';
      if (height !== undefined) node.style.height = height + 'px';
    }
    hideEdges() { this.add.hidden = true; this.grip.hidden = true; }
    hover(event) {
      if (this.wrap.contains(event.target) && event.target.closest('.note-table-control')) return;
      const g = this.geometry(), x = event.clientX, y = event.clientY, band = 20, outside = 32, size = 26;
      this.hideEdges();
      if (!g.rows.length || !g.cols.length || x < g.rect.left - outside || x > g.rect.right + outside || y < g.rect.top - outside || y > g.rect.bottom + outside) return;
      let edge, distance = Infinity;
      const choose = (name, delta, within) => { if (within && Math.abs(delta) < distance) { edge = name; distance = Math.abs(delta); } };
      choose('left', x - g.rect.left, x >= g.rect.left - outside && x <= g.rect.left + band && y >= g.rect.top && y <= g.rect.bottom);
      choose('top', y - g.rect.top, y >= g.rect.top - outside && y <= g.rect.top + band && x >= g.rect.left && x <= g.rect.right);
      choose('right', x - g.rect.right, x >= g.rect.right - band && x <= g.rect.right + outside && y >= g.rect.top && y <= g.rect.bottom);
      choose('bottom', y - g.rect.bottom, y >= g.rect.bottom - band && y <= g.rect.bottom + outside && x >= g.rect.left && x <= g.rect.right);
      let kind, index, control, left, top, width, height, label;
      if (edge === 'right') {
        kind = 'column'; index = g.cols.length; control = this.add;
        left = g.rect.right; top = g.rect.top; width = size; height = g.rect.height;
        label = text('在右侧新增列', 'Add column on the right');
      } else if (edge === 'bottom') {
        kind = 'row'; index = g.rows.length; control = this.add;
        left = g.rect.left; top = g.rect.bottom; width = g.rect.width; height = size;
        label = text('在下方新增行', 'Add row below');
      } else if (edge === 'left') {
        kind = 'row'; index = this.hit(event, true).row; control = this.grip;
        left = g.rect.left - size; top = g.rows[index].top; width = size; height = g.rows[index].height;
      } else if (edge === 'top') {
        kind = 'column'; index = this.hit(event, true).col; control = this.grip;
        left = g.cols[index].left; top = g.rect.top - size; width = g.cols[index].width; height = size;
      }
      if (!control) return;
      control.hidden = false; control.dataset.tableKind = kind; control.dataset.tableIndex = index;
      control.setAttribute('aria-label', control.title = label || (control === this.add
        ? text('在此插入' + (kind === 'row' ? '行' : '列'), 'Insert ' + kind + ' here')
        : text('选择或拖动移动' + (kind === 'row' ? '行' : '列'), 'Select or drag to move ' + kind)));
      this.positionOverlay(control, left, top, width, height);
    }
    paintSelection() {
      const s = this.bounds();
      this.wrap.classList.toggle('has-table-selection', !!s);
      this.body.querySelectorAll('td[data-table-row]').forEach((cell) => {
        const r = Number(cell.dataset.tableRow), c = Number(cell.dataset.tableCol);
        cell.classList.toggle('is-table-selected', !!s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1);
        cell.setAttribute('aria-selected', String(!!s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1));
      });
      this.outline.hidden = !s;
      if (s) {
        const g = this.geometry(), first = g.rows[s.r0], last = g.rows[s.r1], left = g.cols[s.c0], right = g.cols[s.c1];
        if (!first || !last || !left || !right) { this.selection = null; this.outline.hidden = true; return; }
        const x0 = Math.max(left.left, g.rect.left), x1 = Math.min(right.right, this.scroll.getBoundingClientRect().right);
        this.positionOverlay(this.outline, x0, first.top, Math.max(0, x1 - x0), last.bottom - first.top);
      }
    }
    select(kind, index, extend) {
      this.controller.activate(this); this.close();
      const rows = this.model.rows.length + 1, cols = this.model.header.length;
      const previous = extend && this.selection && this.selection.kind === kind ? this.selection : null;
      this.selection = kind === 'row'
        ? { kind, r0: previous ? previous.r0 : index, r1: index, c0: 0, c1: cols - 1 }
        : { kind, r0: 0, r1: rows - 1, c0: previous ? previous.c0 : index, c1: index };
      this.paintSelection(); this.wrap.focus({ preventScroll: true });
    }
    // Textarea does not expose text nodes. This inert mirror gives real wrapped
    // character rectangles without replacing, moving or blurring its IME host.
    inputPoint(point) {
      if (!this.edit) return { offset: 0, text: false };
      const input = this.edit.input, style = getComputedStyle(input), rect = input.getBoundingClientRect();
      const mirror = document.createElement('div'), span = document.createElement('span');
      for (const key of ['font', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'tabSize']) mirror.style[key] = style[key];
      const px = parseFloat(style.paddingLeft) || 0, py = parseFloat(style.paddingTop) || 0;
      Object.assign(mirror.style, { position: 'fixed', left: rect.left + px + 'px', top: rect.top + py - input.scrollTop + 'px',
        width: Math.max(1, input.clientWidth - px - (parseFloat(style.paddingRight) || 0)) + 'px',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', pointerEvents: 'none', opacity: '0' });
      mirror.setAttribute('aria-hidden', 'true'); span.textContent = input.value || ' '; mirror.appendChild(span); document.body.appendChild(mirror);
      const node = span.firstChild, range = document.createRange(), length = input.value.length;
      let low = 0, high = length, offset = length, textHit = false;
      try {
        while (low < high) {
          let mid = (low + high) >>> 1;
          if (mid && /[\uDC00-\uDFFF]/.test(node.textContent[mid])) mid--;
          range.setStart(node, mid); range.setEnd(node, Math.min(node.length, mid + (/[\uD800-\uDBFF]/.test(node.textContent[mid]) ? 2 : 1)));
          const box = range.getBoundingClientRect();
          if (point.clientY > box.bottom || point.clientY >= box.top && point.clientX > (box.left + box.right) / 2) low = Math.max(low + 1, range.endOffset);
          else high = mid;
        }
        offset = Math.min(length, low);
        for (const index of [offset, offset - 1]) {
          if (index < 0 || index >= length) continue;
          range.setStart(node, index); range.setEnd(node, index + 1); const box = range.getBoundingClientRect();
          if (point.clientX >= box.left && point.clientX <= box.right && point.clientY >= box.top && point.clientY <= box.bottom) textHit = true;
        }
      } finally { mirror.remove(); }
      return { offset, text: textHit };
    }
    renderedTextHit(cell, point) {
      const root = cell.querySelector('.note-table-cell-content'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode);
        if (Array.from(range.getClientRects()).some(rect => point.clientX >= rect.left && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom)) return true;
      }
      return false;
    }
    pointerDown(event) {
      event.stopPropagation(); if (event.button !== 0) return;
      this.cancelGesture(); this.suppressClick = false;
      const control = event.target.closest('.note-table-control');
      if (control === this.add) { event.preventDefault(); return; }
      const cell = event.target.closest('td[data-table-row]');
      if (!cell && control !== this.grip) {
        const g = this.geometry();
        if (event.clientY >= g.rect.bottom || event.clientY <= g.rect.top) {
          event.preventDefault(); this.controller.options.onTableBodyRequest(this.widget.spec.id, event.clientY >= g.rect.bottom ? 'after' : 'before');
        }
        return;
      }
      const blocked = this.controller.pending() || this.view.__relatumInputSession && this.view.__relatumInputSession.pending();
      const start = cell ? { row: Number(cell.dataset.tableRow), col: Number(cell.dataset.tableCol) } : null;
      const gesture = this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, point: event,
        start, blocked, mode: control === this.grip ? 'reorder' : 'press', moved: false, shift: event.shiftKey,
        shape: this.shape, anchor: this.selection || this.edit && { r0: this.edit.row, c0: this.edit.col } };
      this.cancelReorderIntent();
      if (control === this.grip) {
        event.preventDefault(); gesture.kind = control.dataset.tableKind; gesture.index = Number(control.dataset.tableIndex);
        const s = this.bounds();
        gesture.bounds = this.selection && this.selection.kind === gesture.kind && s && gesture.index >= (gesture.kind === 'row' ? s.r0 : s.c0)
          && gesture.index <= (gesture.kind === 'row' ? s.r1 : s.c1) ? s : null;
        if (!blocked && !gesture.bounds) { this.select(gesture.kind, gesture.index, event.shiftKey); gesture.bounds = this.bounds(); }
      } else if (blocked || event.shiftKey) event.preventDefault();
      else if (this.edit && event.target === this.edit.input && this.inputPoint(event).text) gesture.mode = 'native-text';
      else if (event.target !== (this.edit && this.edit.input) && this.renderedTextHit(cell, event)) {
        event.preventDefault(); this.open(start.row, start.col, event); gesture.mode = 'text'; gesture.textAnchor = this.edit ? this.edit.input.selectionStart : 0;
      } else event.preventDefault();
      const move = e => { if (e.pointerId === gesture.id) this.pointerMove(e); };
      const up = e => { if (e.pointerId === gesture.id) this.pointerUp(e); };
      const cancel = () => this.cancelGesture();
      const escape = e => {
        if (e.key !== 'Escape') return;
        this.cancelGesture(); this.suppressClick = true;
        // Let the native IME handle Escape without forcing a blur/commit.
        if (!e.isComposing && e.keyCode !== 229 && !blocked) { e.preventDefault(); e.stopPropagation(); }
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
      if (gesture.mode === 'reorder') {
        this.grip.addEventListener('lostpointercapture', cancel);
        window.addEventListener('keydown', escape, true);
        // Capture only grips: a textarea must retain native text selection.
        this.grip.setPointerCapture(gesture.id);
      }
      this.dragCleanup = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
        this.grip.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('keydown', escape, true);
        if (this.grip.hasPointerCapture(gesture.id)) this.grip.releasePointerCapture(gesture.id);
      };
    }
    pointerMove(event) {
      const gesture = this.gesture; if (!gesture) return;
      gesture.point = event;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4 && !gesture.moved) return;
      gesture.moved = true; this.suppressClick = true;
      if (gesture.mode === 'reorder') { this.previewReorder(event, gesture); return; }
      const hit = this.hit(event, true); if (!hit) return;
      gesture.end = hit;
      if (gesture.blocked) return;
      if ((gesture.mode === 'text' || gesture.mode === 'native-text') && hit.row === gesture.start.row && hit.col === gesture.start.col) {
        if (gesture.mode === 'text' && this.edit) {
          const end = this.inputPoint(event).offset, anchor = gesture.textAnchor;
          this.edit.input.setSelectionRange(Math.min(anchor, end), Math.max(anchor, end), end < anchor ? 'backward' : 'forward');
        }
        return;
      }
      gesture.mode = 'grid'; event.preventDefault(); this.close();
      const anchor = gesture.shift && gesture.anchor || { r0: gesture.start.row, c0: gesture.start.col };
      this.selection = { kind: 'cell', r0: anchor.r0, c0: anchor.c0, r1: hit.row, c1: hit.col };
      this.promoteSelection(); this.paintSelection(); this.wrap.focus({ preventScroll: true }); this.autoScroll();
    }
    promoteSelection() {
      const s = this.bounds(), rows = this.model.rows.length + 1, cols = this.model.header.length;
      if (!s) return;
      const fullRows = s.c0 === 0 && s.c1 === cols - 1, fullCols = s.r0 === 0 && s.r1 === rows - 1;
      this.selection.kind = fullRows && fullCols ? 'table' : fullRows ? 'row' : fullCols ? 'column' : 'cell';
    }
    autoScroll() {
      if (this.scrollFrame || this.pending()) return;
      const tick = () => {
        this.scrollFrame = 0;
        const gesture = this.gesture; if (!gesture || !gesture.moved || gesture.blocked) return;
        const point = gesture.point, scroller = this.view.scrollDOM, rect = scroller.getBoundingClientRect(), horizontal = this.scroll.getBoundingClientRect();
        const delta = (position, low, high) => position < low + 24 ? -Math.min(12, (low + 24 - position) / 2) : position > high - 24 ? Math.min(12, (position - high + 24) / 2) : 0;
        const reorder = gesture.mode === 'reorder';
        const dy = (reorder && gesture.kind === 'column') || !inWindow(point) ? 0 : delta(point.clientY, rect.top, rect.bottom);
        const dx = (reorder && gesture.kind === 'row') || !inWindow(point) ? 0 : delta(point.clientX, horizontal.left, horizontal.right);
        const top = scroller.scrollTop, left = this.scroll.scrollLeft;
        scroller.scrollTop += dy; this.scroll.scrollLeft += dx; this.geometryCache = null;
        if (reorder) {
          // Keep the overlay at the real gap even when async layout changes
          // above the table without another pointermove.
          this.previewReorder(point, gesture, false);
          if (this.gesture === gesture) this.scrollFrame = requestAnimationFrame(tick);
        } else if (top !== scroller.scrollTop || left !== this.scroll.scrollLeft) this.pointerMove(point);
      };
      this.scrollFrame = requestAnimationFrame(tick);
    }
    reorderGap(point, gesture) {
      this.geometryCache = null;
      const g = this.geometry(), rects = gesture.kind === 'row' ? g.rows : g.cols;
      if (!this.current() || gesture.shape !== this.shape || !rects.length || !inWindow(point)) return null;
      let gap = axisGap(rects, gesture.kind, gesture.kind === 'row' ? point.clientY : point.clientX);
      const from = gesture.bounds ? (gesture.kind === 'row' ? gesture.bounds.r0 : gesture.bounds.c0) : gesture.index;
      const to = gesture.bounds ? (gesture.kind === 'row' ? gesture.bounds.r1 : gesture.bounds.c1) : gesture.index;
      // All gaps within the moving range have the same no-op result.
      if (gap >= from && gap <= to + 1) gap = from;
      return gap;
    }
    refreshReorder() {
      const gesture = this.gesture;
      if (gesture && gesture.mode === 'reorder' && gesture.moved) this.previewReorder(gesture.point, gesture);
    }
    previewReorder(point, gesture, scroll = true) {
      const gap = this.reorderGap(point, gesture);
      this.drop.hidden = gap === null;
      if (gap === null) return;
      gesture.gap = gap;
      const g = this.geometry(), rects = gesture.kind === 'row' ? g.rows : g.cols;
      const edge = gap === rects.length ? (gesture.kind === 'row' ? g.rect.bottom : g.rect.right) : (gesture.kind === 'row' ? rects[gap].top : rects[gap].left);
      this.positionOverlay(this.drop, gesture.kind === 'row' ? g.rect.left : edge - 2, gesture.kind === 'row' ? edge - 2 : g.rect.top,
        gesture.kind === 'row' ? g.rect.width : 4, gesture.kind === 'row' ? 4 : g.rect.height);
      this.wrap.classList.add('is-table-reordering'); if (scroll) this.autoScroll();
    }
    pointerUp(event) {
      const gesture = this.gesture; if (!gesture) return;
      if (gesture.mode === 'reorder' && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 4) {
        gesture.moved = true; this.suppressClick = true;
      }
      const hit = gesture.mode === 'reorder' ? null : this.hit(event, false);
      const gap = gesture.mode === 'reorder' ? this.reorderGap(event, gesture) : null;
      this.cancelGesture(false);
      if (gesture.mode === 'reorder') {
        if (gap !== null) {
          this.reorderIntent = gesture;
          // A drop may wait for compositionend. Keep cancellation live during
          // that wait too, without restarting pointer capture or the drag.
          const cancel = () => this.cancelReorderIntent();
          const escape = e => { if (e.key === 'Escape') cancel(); };
          const hide = () => { if (document.hidden) cancel(); };
          window.addEventListener('blur', cancel);
          window.addEventListener('keydown', escape, true);
          document.addEventListener('visibilitychange', hide);
          this.reorderCleanup = () => {
            window.removeEventListener('blur', cancel);
            window.removeEventListener('keydown', escape, true);
            document.removeEventListener('visibilitychange', hide);
          };
          this.afterSettled(surface => {
            this.cancelReorderIntent(false);
            if (gesture.cancelled || surface.shape !== gesture.shape) return;
            if (!gesture.moved) surface.select(gesture.kind, gesture.index, gesture.shift);
            else surface.reorder(gesture.kind, gesture.bounds, gesture.index, gap);
          });
        }
        return;
      }
      if (gesture.mode === 'native-text' || gesture.mode === 'text') return;
      const end = gesture.end || hit || gesture.start;
      this.afterSettled(surface => {
        if (gesture.moved || gesture.shift && gesture.anchor) {
          surface.close(); const anchor = gesture.shift && gesture.anchor || { r0: gesture.start.row, c0: gesture.start.col };
          surface.selection = { kind: 'cell', r0: anchor.r0, c0: anchor.c0, r1: end.row, c1: end.col };
          surface.promoteSelection();
          surface.paintSelection(); surface.wrap.focus({ preventScroll: true });
        } else surface.open(gesture.start.row, gesture.start.col, event);
      });
    }
    cancelReorderIntent(cancelled = true) {
      if (this.reorderIntent && cancelled) this.reorderIntent.cancelled = true;
      this.reorderIntent = null;
      if (this.reorderCleanup) this.reorderCleanup(); this.reorderCleanup = null;
    }
    cancelGesture(cancelled = true) {
      if (this.gesture && cancelled) { this.gesture.cancelled = true; if (this.gesture.moved) this.suppressClick = true; }
      if (this.dragCleanup) this.dragCleanup(); this.dragCleanup = null; this.gesture = null;
      if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame); this.scrollFrame = 0;
      this.drop.hidden = true; this.wrap.classList.remove('is-table-reordering');
    }
    reorder(kind, bounds, index, gap) {
      const from = bounds ? (kind === 'row' ? bounds.r0 : bounds.c0) : index;
      const to = bounds ? (kind === 'row' ? bounds.r1 : bounds.c1) : index, count = to - from + 1;
      if (gap >= from && gap <= to + 1) return;
      this.close();
      const rows = matrix(this.model), align = this.model.align.slice();
      const target = gap > to ? gap - count : gap;
      if (kind === 'row') { const moved = rows.splice(from, count); rows.splice(target, 0, ...moved); }
      else { rows.forEach(row => { const moved = row.splice(from, count); row.splice(target, 0, ...moved); }); const moved = align.splice(from, count); align.splice(target, 0, ...moved); }
      this.selection = null;
      this.write(modelOf(rows, align), 'input.table-reorder');
      this.selection = kind === 'row' ? { kind, r0: target, r1: target + count - 1, c0: 0, c1: align.length - 1 }
        : { kind, r0: 0, r1: rows.length - 1, c0: target, c1: target + count - 1 };
      this.geometryCache = null; this.paintSelection(); this.wrap.focus({ preventScroll: true }); this.hideEdges();
    }
    click(event) {
      event.stopPropagation();
      if (this.suppressClick) { this.suppressClick = false; event.preventDefault(); return; }
      const control = event.target.closest('button'); if (!control) return;
      const kind = control.dataset.tableKind, index = Number(control.dataset.tableIndex);
      if (control === this.add) { event.preventDefault(); this.afterSettled(surface => surface.insert(kind, index)); }
      else if (control === this.grip && event.detail === 0) this.afterSettled(surface => surface.select(kind, index, event.shiftKey));
    }
    pending() { return this.phase !== 'idle'; }
    afterSettled(callback) {
      this.controller.route(this, callback);
    }
    whenSettled() { return this.pending() ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve(true); }
    open(row, col, point) {
      if (!this.current()) return;
      if (this.edit && this.edit.row === row && this.edit.col === col) {
        this.edit.input.focus(); if (point) { const offset = this.inputPoint(point).offset; this.edit.input.setSelectionRange(offset, offset); } return;
      }
      this.controller.activate(this); this.close(); this.selection = null;
      const cell = this.cell(row, col); if (!cell) return;
      const input = document.createElement('textarea');
      input.className = 'note-table-cell-editor'; input.rows = 1; input.spellcheck = false;
      input.setAttribute('aria-label', text('第 ' + (row + 1) + ' 行，第 ' + (col + 1) + ' 列', 'Row ' + (row + 1) + ', column ' + (col + 1)));
      input.value = matrix(this.model)[row][col];
      const measurer = document.createElement('div'); measurer.setAttribute('aria-hidden', 'true');
      measurer.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere';
      document.body.appendChild(measurer);
      this.edit = { row, col, input, cell, measurer }; cell.classList.add('is-table-editing'); cell.appendChild(input);
      input.addEventListener('input', () => { this.sizeEditor(); if (!this.pending()) this.commit(); });
      input.addEventListener('beforeinput', (event) => {
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo' || this.pending()) return;
        event.preventDefault(); this.history(event.inputType === 'historyRedo');
      });
      input.addEventListener('compositionstart', () => { this.cancelGesture(); this.cancelFrame(); this.phase = 'composing'; this.controller.lockScroll(this); });
      input.addEventListener('compositionend', () => this.endComposition());
      input.addEventListener('blur', () => {
        if (this.pending()) { this.blurQueued = true; return; }
        this.commit(); this.removeEditor(); this.paintSelection();
      });
      this.paintSelection(); this.sizeEditor();
      input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
      if (point) { const offset = this.inputPoint(point).offset; input.setSelectionRange(offset, offset); }
    }
    sizeEditor() {
      if (!this.edit) return;
      const { input, cell, measurer } = this.edit, style = getComputedStyle(input);
      for (const key of ['font', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'tabSize', 'padding']) measurer.style[key] = style[key];
      measurer.style.width = input.getBoundingClientRect().width + 'px';
      measurer.textContent = input.value + '\u200b';
      // Never collapse the browser's native input, even briefly. WebView2 can
      // cache the previous host's IME caret bounds during that zero-height box.
      const height = Math.max(parseFloat(style.minHeight) || 38, Math.ceil(measurer.getBoundingClientRect().height)) + 'px';
      if (input.style.height !== height) input.style.height = height;
      cell.style.minHeight = height;
      this.geometryCache = null;
    }
    cancelFrame() { this.sequence++; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }
    endComposition() {
      this.cancelFrame(); this.phase = 'settling'; const seq = this.sequence;
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = 0; if (seq !== this.sequence || this.disposed) return;
          this.phase = 'idle'; this.controller.unlockScroll(this, true); this.commit(true);
          if (this.blurQueued) { this.blurQueued = false; this.removeEditor(); }
          this.waiters.splice(0).forEach((resolve) => resolve(true));
        });
      });
    }
    commit(composed) {
      if (!this.edit || this.pending()) return;
      const current = this.current(); if (!current) return;
      const rows = matrix(this.model), { row, col, input } = this.edit;
      if (!rows[row]) return;
      // A Markdown table row cannot contain a physical newline.
      const value = input.value.replace(/\r?\n/g, ' ');
      if (rows[row][col] === value) return;
      rows[row][col] = value;
      this.committing = true;
      try { this.write(modelOf(rows, this.model.align), composed ? 'input.table-compose' : 'input.table-cell'); }
      finally { this.committing = false; }
    }
    write(model, userEvent) {
      const current = this.current(); if (!current) return false;
      const source = model ? syntax.serialize(model) : '';
      if (current.source === source) return true;
      const changes = this.view.state.changes({ from: current.from, to: current.to, insert: source });
      this.controller.mapBodyPosition(changes);
      this.view.dispatch({ changes, selection: this.view.state.selection.map(changes), userEvent });
      return true;
    }
    removeEditor() {
      if (!this.edit || this.pending()) return;
      const edit = this.edit; this.edit = null;
      edit.cell.classList.remove('is-table-editing'); edit.cell.style.minHeight = '';
      edit.input.remove(); edit.measurer.remove(); this.view.requestMeasure();
    }
    close() { if (this.pending()) return; this.commit(); this.removeEditor(); }
    insert(kind, index) {
      this.close(); const rows = matrix(this.model), align = this.model.align.slice();
      if (kind === 'row') rows.splice(index, 0, new Array(align.length).fill(''));
      else { rows.forEach((row) => row.splice(index, 0, '')); align.splice(index, 0, ''); }
      this.selection = null;
      if (this.write(modelOf(rows, align), 'input.table-structure')) this.open(kind === 'row' ? index : 0, kind === 'column' ? index : 0);
    }
    action(action) {
      const s = this.bounds(), edit = this.edit;
      if (action === 'add-row') this.insert('row', s ? s.r1 + 1 : this.model.rows.length + 1);
      else if (action === 'add-column') this.insert('column', s ? s.c1 + 1 : this.model.header.length);
      else if (action.startsWith('delete-') && (s || edit)) {
        const bounds = s || { r0: edit.row, r1: edit.row, c0: edit.col, c1: edit.col };
        const rows = matrix(this.model), align = this.model.align.slice(); this.close(); this.selection = null;
        if (action === 'delete-row') rows.splice(bounds.r0, bounds.r1 - bounds.r0 + 1);
        else { rows.forEach((row) => row.splice(bounds.c0, bounds.c1 - bounds.c0 + 1)); align.splice(bounds.c0, bounds.c1 - bounds.c0 + 1); }
        this.write(rows.length && rows[0].length ? modelOf(rows, align) : null, 'delete.table-structure');
        if (this.wrap.isConnected) { this.paintSelection(); this.wrap.focus({ preventScroll: true }); }
        else this.view.focus();
      }
    }
    keydown(event) {
      event.stopPropagation();
      if (event.key === 'Escape' && (this.gesture || this.reorderIntent)) {
        this.cancelGesture(); this.cancelReorderIntent(); this.suppressClick = true;
        if (!event.isComposing && event.keyCode !== 229 && !this.pending()) event.preventDefault();
        return;
      }
      if (event.isComposing || event.keyCode === 229 || this.pending()) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (mod && key === 's') { event.preventDefault(); this.controller.options.onSaveRequest(); return; }
      if (mod && (key === 'z' || key === 'y')) {
        event.preventDefault(); this.history(key === 'y' || event.shiftKey); return;
      }
      if (this.edit && event.target === this.edit.input) {
        if (mod && event.key === 'Enter') {
          event.preventDefault(); this.controller.options.onTableBodyRequest(this.widget.spec.id, event.shiftKey ? 'before' : 'after'); return;
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          event.preventDefault(); const { row, col } = this.edit;
          this.close(); const cols = this.model.header.length, count = this.model.rows.length + 1;
          let r = row, c = col;
          if (event.key === 'Enter') r += event.shiftKey ? -1 : 1;
          else { c += event.shiftKey ? -1 : 1; if (c >= cols) { c = 0; r++; } if (c < 0) { c = cols - 1; r--; } }
          if (r >= count) this.insert('row', count);
          else if (r >= 0) this.open(r, c);
          else this.open(0, 0);
        } else if (event.key === 'Escape') { event.preventDefault(); this.close(); this.wrap.focus({ preventScroll: true }); }
        return;
      }
      if (mod && key === 'a') {
        event.preventDefault(); this.selection = { kind: 'table', r0: 0, r1: this.model.rows.length, c0: 0, c1: this.model.header.length - 1 }; this.paintSelection();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!this.selection) return; event.preventDefault();
        if (this.selection.kind === 'table') { this.selection = null; this.write(null, 'delete.table-structure'); this.view.focus(); }
        else if (this.selection.kind === 'row') this.action('delete-row');
        else if (this.selection.kind === 'column') this.action('delete-column');
        else {
          const rows = matrix(this.model), s = this.bounds();
          for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) rows[r][c] = '';
          this.write(modelOf(rows, this.model.align), 'delete.table-cells');
        }
      } else if (event.key === 'Escape') { this.selection = null; this.paintSelection(); }
      else if (event.key === 'Enter' && this.selection) { event.preventDefault(); const s = this.bounds(); this.open(s.r0, s.c0); }
    }
    history(redo) {
      this.cancelGesture(); this.cancelReorderIntent();
      this.close(); (redo ? CM.redo : CM.undo)(this.view);
      if (this.wrap.isConnected) this.wrap.focus({ preventScroll: true });
      else this.view.focus();
    }
    copy(event, cut) {
      event.stopPropagation(); if (!this.selection || this.pending()) return;
      event.preventDefault(); const s = this.bounds(), rows = matrix(this.model);
      const value = rows.slice(s.r0, s.r1 + 1).map((row) => row.slice(s.c0, s.c1 + 1).join('\t')).join('\n');
      try { if (!event.clipboardData) return; event.clipboardData.setData('text/plain', value); }
      catch (_) { return; }
      if (cut) {
        if (this.selection.kind === 'table') { this.selection = null; this.write(null, 'delete.table-structure'); this.view.focus(); }
        else if (this.selection.kind === 'row') this.action('delete-row');
        else if (this.selection.kind === 'column') this.action('delete-column');
        else { for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) rows[r][c] = '';
          this.write(modelOf(rows, this.model.align), 'delete.table-cells'); }
      }
    }
    paste(event) {
      event.stopPropagation(); if (this.pending() || !event.clipboardData) return;
      const value = event.clipboardData.getData('text/plain');
      if (!this.selection && (!this.edit || !/[\t\r\n]/.test(value))) return;
      event.preventDefault(); if (!value) return;
      const data = syntax.parseDelimited(value), incoming = matrix(data);
      const s = this.bounds(), edit = this.edit;
      const r0 = s ? s.r0 : edit.row, c0 = s ? s.c0 : edit.col;
      this.close(); const rows = matrix(this.model), align = this.model.align.slice();
      if (this.selection && this.selection.kind === 'row' && c0 === 0) rows.splice(r0, s.r1 - s.r0 + 1, ...incoming);
      else {
        const width = Math.max(align.length, c0 + data.header.length);
        while (align.length < width) align.push('');
        while (rows.length < r0 + incoming.length) rows.push(new Array(width).fill(''));
        rows.forEach((row) => { while (row.length < width) row.push(''); });
        incoming.forEach((row, r) => row.forEach((cell, c) => { rows[r0 + r][c0 + c] = cell; }));
      }
      this.selection = { kind: 'cell', r0, r1: r0 + incoming.length - 1, c0, c1: c0 + data.header.length - 1 };
      this.write(modelOf(rows, align), 'input.table-paste'); this.paintSelection(); this.wrap.focus({ preventScroll: true });
    }
    destroy() {
      if (this.disposed) return; this.disposed = true; this.cancelFrame();
      if (this.edit) this.edit.measurer.remove();
      this.controller.unlockScroll(this, false);
      this.clearMath(this.body);
      this.cancelGesture(); this.cancelReorderIntent();
      this.waiters.splice(0).forEach((resolve) => resolve(false));
      this.controller.detach(this); delete this.wrap.__noteTableSurface;
    }
    clearMath(content) {
      const math = window.MathJax;
      if (math && typeof math.typesetClear === 'function') math.typesetClear([content]);
    }
  }
  window.RelatumNoteTableEditor = { createController };
})();

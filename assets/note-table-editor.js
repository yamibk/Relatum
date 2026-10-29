// One stable, text-only CodeMirror inside the active Markdown table cell.
// The parent owns committed Markdown/history; preedit stays in the cell view.
(function () {
  'use strict';
  const CM = window.RelatumCodeMirror;
  const syntax = window.MarkdownTable;
  if (!CM || !syntax) return;
  const cellUpdateEffect = CM.StateEffect.define();
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
  const textHitPadding = style => Math.min(8, Math.max(4, (parseFloat(style.fontSize) || 16) * .4));
  // Rendered text and native-input mirrors share the same per-line tolerance.
  // Only the added halo excludes cell edges; exact text hits keep their bounds.
  function textPoint(rects, point, bounds, padding, expand) {
    const x = point.clientX, y = point.clientY;
    const inside = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    const halo = expand && x >= bounds.left + 2 && x <= bounds.right - 2 && y >= bounds.top + 2 && y <= bounds.bottom - 2;
    let closest = null, vertical = Infinity, horizontal = Infinity, exact = false, nearby = false;
    for (const rect of rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const dy = Math.max(rect.top - y, 0, y - rect.bottom), dx = Math.max(rect.left - x, 0, x - rect.right);
      if (dy < vertical || dy === vertical && dx < horizontal) { closest = rect; vertical = dy; horizontal = dx; }
      if (inside && dx === 0 && dy === 0) exact = true;
      if (halo && dx <= padding && dy <= padding) nearby = true;
    }
    return { exact, text: exact || nearby,
      x: closest ? Math.max(closest.left, Math.min(x, closest.right)) : x,
      y: closest ? (closest.top + closest.bottom) / 2 : y };
  }

  const reconcileCell = CM.StateEffect.define();
  class CellInput {
    constructor(surface, cell, value, label) {
      this.surface = surface;
      const input = this;
      const projection = CM.ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = surface.controller.options.tableInlineDecorations(view); }
        update(update) {
          if (surface.pending() || update.view.composing || update.view.compositionStarted) {
            this.decorations = this.decorations.map(update.changes); return;
          }
          if (update.docChanged || update.selectionSet || update.focusChanged
              || update.transactions.some(tr => tr.effects.some(effect => effect.is(reconcileCell)))) {
            this.decorations = surface.controller.options.tableInlineDecorations(update.view);
          }
        }
      }, { decorations: plugin => plugin.decorations });
      this.view = new CM.EditorView({ parent: cell, state: CM.EditorState.create({ doc: value, extensions: [
        CM.EditorView.editorAttributes.of({ class: 'note-table-cell-input' }),
        CM.EditorView.contentAttributes.of({ class: 'note-table-cell-editor', 'aria-label': label, spellcheck: 'false' }),
        CM.EditorView.lineWrapping, projection,
        surface.controller.options.createHighlightExtension?.(() => surface.pending()) || [],
        CM.EditorView.domEventHandlers({
          keydown(event) { surface.keydown(event); return event.defaultPrevented; },
          copy(event) { surface.copy(event, false); return event.defaultPrevented; },
          cut(event) { surface.copy(event, true); return event.defaultPrevented; },
          paste(event) { surface.paste(event); return event.defaultPrevented; },
          beforeinput(event) {
            if (!/^(?:historyUndo|historyRedo)$/.test(event.inputType) || surface.pending()) return false;
            event.preventDefault(); surface.history(event.inputType === 'historyRedo'); return true;
          },
        }),
        CM.keymap.of(CM.defaultKeymap),
        CM.EditorView.updateListener.of(update => {
          if (surface.edit?.input !== input) return;
          if (update.docChanged && !input.syncing) {
            surface.edit.emptyFormat = null;
            if (!surface.pending()) surface.commit(false, update.transactions.some(tr => tr.isUserEvent('input.note-highlight') || tr.isUserEvent('delete.note-highlight')) ? 'input.note-highlight' : undefined);
          }
          if (update.docChanged || update.geometryChanged) surface.controller.measure();
        }),
      ] }) });
      this.dom = this.view.contentDOM;
      // Local owner for source/selection access; never serialized with a note.
      this.dom.__noteCellInput = this;
    }
    get value() { return this.view.state.doc.toString(); }
    set value(value) {
      if (value === this.value) return;
      this.syncing = true;
      try { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } }); }
      finally { this.syncing = false; }
    }
    get selectionStart() { return this.view.state.selection.main.from; }
    get selectionEnd() { return this.view.state.selection.main.to; }
    get selectionDirection() { const range = this.view.state.selection.main; return range.anchor > range.head ? 'backward' : 'forward'; }
    setSelectionRange(from, to, direction) {
      const length = this.view.state.doc.length;
      from = Math.max(0, Math.min(length, from)); to = Math.max(0, Math.min(length, to));
      this.view.dispatch({ selection: CM.EditorSelection.range(direction === 'backward' ? to : from, direction === 'backward' ? from : to) });
    }
    contains(target) { return this.dom.contains(target); }
    focus() { this.view.focus(); }
    reconcile() { this.view.dispatch({ effects: reconcileCell.of(null) }); }
    remove() { delete this.dom.__noteCellInput; this.view.destroy(); this.view.dom.remove(); }
  }

  function createController(options) {
    let active = null;
    let operation = 0;
    const surfaces = new Set();
    const scrollers = new Map();
    let scrollLock = null;
    let measureFrame = 0;
    let measureWaiting = false, disposed = false;
    let alignmentToolbar = null;
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
      refreshNoteSyntax() {
        // Definitions rarely change. Only dependent rendered fragments are
        // invalidated; normal input, scrolling and selection never enter here.
        for (const surface of surfaces) {
          if (!surface.current() || surface.pending()) continue;
          surface.body.querySelectorAll('td[data-table-row]').forEach(cell => {
            const content = cell.firstElementChild;
            if (!content || !/\[[^\]]+\]/.test(content.dataset.source || '')) return;
            if (surface.edit?.cell === cell) { surface.edit.contentDirty = true; return; }
            if (content.firstElementChild) content.firstElementChild.dataset.source = '';
            surface.renderCell(cell, Number(cell.dataset.tableRow), Number(cell.dataset.tableCol));
          });
        }
      },
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
      close() { operation++; this.bodyPosition = null; alignmentToolbar?.hide(); if (active) { active.cancelGesture(); active.cancelReorderIntent(); active.close(); } },
      activate(surface) {
        if (active && active !== surface) active.close(); active = surface;
        if (!alignmentToolbar) alignmentToolbar = new AlignmentToolbar(this);
        alignmentToolbar.show(surface);
      },
      updateAlignment(surface) { if (alignmentToolbar?.surface === surface) alignmentToolbar.refresh(); },
      focusAlignment(surface) { if (alignmentToolbar?.surface !== surface) return false; alignmentToolbar.focus(); return true; },
      dismissAlignment() { operation++; alignmentToolbar?.hide(); },
      attach(surface) {
        surfaces.add(surface); if (observer) { observer.observe(surface.table); observer.observe(surface.wrap); }
        const scroller = surface.view.scrollDOM;
        if (observer) observer.observe(scroller);
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
      detach(surface) { surfaces.delete(surface); if (observer) { observer.unobserve(surface.table); observer.unobserve(surface.wrap); } if (active === surface) active = null; if (alignmentToolbar?.surface === surface) alignmentToolbar.hide(); },
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
          alignmentToolbar?.refresh();
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
          // a focused cell would make Chromium commit provisional Pinyin.
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
      destroy() { disposed = true; operation++; alignmentToolbar?.destroy(); if (observer) observer.disconnect(); if (measureFrame) cancelAnimationFrame(measureFrame); scrollers.forEach(({ handler, pointer, leave }, scroller) => { scroller.removeEventListener('scroll', handler); scroller.removeEventListener('pointermove', pointer); scroller.removeEventListener('pointerleave', leave); }); scrollers.clear(); surfaces.forEach((surface) => surface.destroy()); surfaces.clear(); active = null; },
      widget(spec, notePath, coordinator) { return new TableWidget(spec, notePath, coordinator, this); },
    };
    return controller;
  }

  // One portal per editor. Its temporary listeners exist only while a table is
  // active; positioning uses the controller's existing coalesced measurement.
  class AlignmentToolbar {
    constructor(controller) {
      this.controller = controller;
      this.root = document.createElement('div'); this.root.className = 'note-table-alignment'; this.root.hidden = true;
      this.root.setAttribute('role', 'toolbar');
      this.toggle = document.createElement('button'); this.toggle.type = 'button'; this.toggle.className = 'note-table-alignment-toggle';
      this.toggle.setAttribute('aria-haspopup', 'true'); this.toggle.setAttribute('aria-expanded', 'false');
      this.group = document.createElement('div'); this.group.className = 'note-table-alignment-options';
      this.buttons = ['left', 'center', 'right'].map((value, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.tableAlign = value;
        button.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 4h14M'
          + [3, 6, 9][index] + ' 8h8M3 12h14M' + [3, 6, 9][index] + ' 16h8"/></svg>';
        this.group.appendChild(button); return button;
      });
      this.root.append(this.toggle, this.group); document.body.appendChild(this.root);
      this.root.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
      this.root.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
      this.root.addEventListener('click', event => {
        event.stopPropagation();
        if (event.target.closest('button') === this.toggle) { this.menu(!this.expanded); return; }
        const button = event.target.closest('[data-table-align]'); if (!button || !this.surface) return;
        const surface = this.surface, bounds = surface.alignmentBounds(); if (!bounds) return;
        const keyboard = event.detail === 0;
        surface.afterSettled(latest => {
          if (this.surface !== latest) return;
          latest.alignColumns(bounds.c0, bounds.c1, button.dataset.tableAlign);
          this.refresh(); this.menu(false);
          if (keyboard) this.focus();
        });
      });
      this.root.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault(); event.stopPropagation();
          this.surface?.afterSettled(surface => surface.history(event.key.toLowerCase() === 'y' || event.shiftKey)); return;
        }
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (keys.includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (this.compact && !this.expanded) this.menu(true);
          let index = this.buttons.indexOf(document.activeElement);
          index = event.key === 'Home' ? 0 : event.key === 'End' ? 2
            : index < 0 ? (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 2 : 0)
              : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 2 : 1)) % 3;
          this.buttons.forEach((button, i) => button.tabIndex = i === index ? 0 : -1); this.buttons[index].focus();
        } else if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); this.menu(false); this.surface?.wrap.focus({ preventScroll: true });
        }
      });
      this.outside = event => {
        if (!this.root.contains(event.target) && !this.surface?.wrap.contains(event.target)) this.controller.dismissAlignment();
      };
      this.visibility = () => { if (document.hidden || document.documentElement.dataset.desktopMinimized === '1') this.controller.dismissAlignment(); };
      this.pagehide = () => this.controller.dismissAlignment();
      this.position = () => this.controller.measure();
      this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.target === this.surface?.wrap && !entry.isIntersecting)) this.controller.dismissAlignment();
      }) : null;
    }
    show(surface) {
      if (this.surface === surface) return;
      this.hide(); this.surface = surface; this.root.hidden = false;
      document.addEventListener('pointerdown', this.outside, true); document.addEventListener('focusin', this.outside, true);
      document.addEventListener('scroll', this.position, true); document.addEventListener('visibilitychange', this.visibility);
      window.addEventListener('resize', this.position); window.addEventListener('canvasdesktop:visibility', this.visibility);
      window.addEventListener('pagehide', this.pagehide); this.observer?.observe(surface.wrap);
      this.controller.measure();
    }
    menu(open) {
      this.expanded = !!open; this.root.classList.toggle('is-expanded', this.expanded);
      this.toggle.setAttribute('aria-expanded', String(this.expanded));
      this.group.style.top = ''; this.group.style.right = '';
      if (this.expanded && this.compact) {
        const box = this.group.getBoundingClientRect();
        if (box.bottom > window.innerHeight - 8) this.group.style.top = -box.height - 5 + 'px';
        if (box.left < 8) this.group.style.right = this.root.getBoundingClientRect().right - box.width - 8 + 'px';
      }
    }
    focus() {
      if (this.compact) this.toggle.focus({ preventScroll: true });
      else (this.buttons.find(button => button.getAttribute('aria-pressed') === 'true') || this.buttons[0]).focus({ preventScroll: true });
    }
    refresh() {
      const surface = this.surface, bounds = surface?.alignmentBounds();
      if (!surface) return;
      if (!surface.current() || !surface.wrap.getClientRects().length || document.hidden || document.documentElement.dataset.desktopMinimized === '1') { this.hide(); return; }
      if (!bounds) { this.hide(); return; }
      const c0 = bounds.c0, c1 = bounds.c1;
      const align = surface.model.align[c0] || 'left';
      const same = surface.model.align.slice(c0, c1 + 1).every(value => (value || 'left') === align);
      const scope = c0 === 0 && c1 === surface.model.header.length - 1
        ? text('所有列', 'All columns') : c0 === c1 ? text('第 ' + (c0 + 1) + ' 列', 'Column ' + (c0 + 1))
          : text('第 ' + (c0 + 1) + '–' + (c1 + 1) + ' 列', 'Columns ' + (c0 + 1) + '–' + (c1 + 1));
      const label = scope + (same ? '' : text(' · 混合对齐', ' · Mixed alignment'));
      const set = (node, key, value) => { if (node.getAttribute(key) !== value) node.setAttribute(key, value); };
      set(this.root, 'aria-label', text('表格对齐：', 'Table alignment: ') + label);
      const names = [text('左对齐', 'Align left'), text('居中', 'Align center'), text('右对齐', 'Align right')];
      this.buttons.forEach((button, index) => {
        set(button, 'aria-label', names[index] + ' · ' + scope); set(button, 'title', names[index] + ' · ' + label);
        set(button, 'aria-pressed', String(same && align === button.dataset.tableAlign));
        if (!this.root.contains(document.activeElement)) set(button, 'tabindex', (same ? align === button.dataset.tableAlign : index === 0) ? '0' : '-1');
      });
      const toggleLabel = text('对齐', 'Align'); if (this.toggle.textContent !== toggleLabel) this.toggle.textContent = toggleLabel;
      set(this.toggle, 'aria-label', toggleLabel + ' · ' + label); set(this.toggle, 'title', toggleLabel + ' · ' + label);
      const viewport = surface.view.scrollDOM.getBoundingClientRect(), rect = surface.table.getBoundingClientRect();
      const compact = Math.min(viewport.width, rect.width) < 480;
      if (this.compact !== compact) { this.compact = compact; this.root.classList.toggle('is-compact', compact); this.menu(false); }
      const box = this.root.getBoundingClientRect();
      const left = Math.max(8, viewport.left + 8), right = Math.min(window.innerWidth - 8, viewport.right - 8);
      const top = Math.max(8, viewport.top + 8), bottom = Math.min(window.innerHeight - 8, viewport.bottom - 8);
      const x = Math.max(left, Math.min(rect.right - box.width, right - box.width));
      // Leave the 22px edge-grip/append strip fully approachable.
      const gap = 30;
      const y = rect.top - box.height - gap >= top ? rect.top - box.height - gap
        : rect.bottom + box.height + gap <= bottom ? rect.bottom + gap : top;
      for (const [key, value] of [['left', x], ['top', y]]) {
        const px = Math.round(value) + 'px'; if (this.root.style[key] !== px) this.root.style[key] = px;
      }
      if (this.expanded) this.menu(true);
    }
    hide() {
      this.surface = null; this.root.hidden = true; this.menu(false); this.observer?.disconnect();
      document.removeEventListener('pointerdown', this.outside, true); document.removeEventListener('focusin', this.outside, true);
      document.removeEventListener('scroll', this.position, true); document.removeEventListener('visibilitychange', this.visibility);
      window.removeEventListener('resize', this.position); window.removeEventListener('canvasdesktop:visibility', this.visibility);
      window.removeEventListener('pagehide', this.pagehide);
    }
    destroy() { this.hide(); this.root.remove(); }
  }

  class TableWidget extends CM.WidgetType {
    constructor(spec, notePath, coordinator, controller) {
      super(); this.spec = spec; this.notePath = notePath; this.coordinator = coordinator;
      this.controller = controller; this.epoch = coordinator.epoch;
    }
    eq(other) {
      return other.spec.id === this.spec.id && other.spec.fingerprint === this.spec.fingerprint && other.spec.source === this.spec.source
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
      this.model = widget.spec.tableModel || syntax.parse(widget.spec.source, { ensureBodyRow: false }).model;
      this.selection = null; this.edit = null; this.phase = 'idle';
      this.paintedSelection = null;
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
      wrap.addEventListener('keyup', () => { this.pastePlain = false; });
      wrap.addEventListener('focusout', () => { this.pastePlain = false; });
      wrap.addEventListener('contextmenu', (event) => { event.stopPropagation(); if (!this.edit?.input.contains(event.target)) event.preventDefault(); });
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
      const oldSource = this.widget.spec.source;
      this.widget = widget;
      if (oldSource === widget.spec.source) return;
      const alignment = widget.spec.alignmentDelta;
      if (alignment && alignment.previous === this.model && widget.spec.tableModel) {
        this.model = widget.spec.tableModel;
        for (const col of alignment.columns) for (const row of this.body.rows) {
          const cell = row.cells[col]; if (cell) cell.style.textAlign = this.model.align[col] || 'left';
        }
        this.controller.updateAlignment(this); this.controller.measure(); return;
      }
      const delta = widget.spec.cellDelta;
      if (delta && delta.previous === this.model && widget.spec.tableModel) {
        this.model = widget.spec.tableModel;
        if (this.edit?.row === delta.row && this.edit.col === delta.col && this.committing) {
          if (!this.edit.contentDirty) {
            const content = this.edit.cell.firstElementChild;
            this.clearMath(content);
            if (content.firstElementChild) content.firstElementChild.dataset.source = '';
          }
          this.edit.contentDirty = true;
        } else this.renderCell(this.cell(delta.row, delta.col), delta.row, delta.col);
        this.geometryCache = null; this.controller.measure();
        return;
      }
      const parsed = widget.spec.tableModel ? { ok: true, model: widget.spec.tableModel }
        : syntax.parse(widget.spec.source, { ensureBodyRow: false });
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
        this.paintedSelection = null; this.wrap.classList.remove('has-table-selection');
        for (let r = 0; r < rows.length; r++) {
          const tr = document.createElement('tr'); tr.dataset.tableDataRow = r;
          for (let c = 0; c < columns; c++) {
            const cell = document.createElement('td'); cell.dataset.tableRow = r; cell.dataset.tableCol = c;
            cell.setAttribute('aria-selected', 'false');
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
        this.renderCell(cell, r, c);
      });
      this.geometryCache = null; this.paintSelection(); this.sizeEditor(); this.controller.measure();
    }
    renderCell(cell, r, c) {
        if (!cell) return;
        const value = (r ? this.model.rows[r - 1] : this.model.header)[c] || '';
        const content = cell.firstElementChild;
        if (content.dataset.source !== value || content.firstElementChild?.dataset.source !== value) {
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
        const align = this.model.align[c] || 'left';
        if (cell.style.textAlign !== align) cell.style.textAlign = align;
        if (this.edit && this.edit.row === r && this.edit.col === c && !this.pending()
            && !this.committing && this.edit.input.value !== value) this.edit.input.value = value;
        if (this.edit?.row === r && this.edit.col === c) this.edit.contentDirty = false;
    }
    cell(row, col) { return this.body.children[row]?.children[col] || null; }
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
      let s = this.bounds();
      if (s && (s.r0 < 0 || s.c0 < 0 || s.r1 >= this.body.rows.length || s.c1 >= (this.body.rows[0]?.cells.length || 0))) {
        this.selection = null; s = null;
      }
      const previous = this.paintedSelection;
      const same = s === previous || !!s && !!previous && s.r0 === previous.r0 && s.r1 === previous.r1
        && s.c0 === previous.c0 && s.c1 === previous.c1;
      if (!same) {
        // Paint only the symmetric difference. Extending a large rectangle by
        // one cell must not revisit all of its already-selected cells.
        this.paintSelectionDifference(previous, s, false);
        this.paintSelectionDifference(s, previous, true);
        this.paintedSelection = s;
        if (!!previous !== !!s) this.wrap.classList.toggle('has-table-selection', !!s);
      }
      this.positionSelectionOutline(s);
      this.controller.updateAlignment(this);
    }
    paintSelectionDifference(bounds, other, selected) {
      if (!bounds) return;
      const paint = (r0, r1, c0, c1) => {
        for (let r = r0; r <= r1; r++) {
          const row = this.body.rows[r]; if (!row) continue;
          for (let c = c0; c <= c1; c++) {
            const cell = row.cells[c]; if (!cell) continue;
            cell.classList.toggle('is-table-selected', selected);
            cell.setAttribute('aria-selected', String(selected));
          }
        }
      };
      const r0 = other ? Math.max(bounds.r0, other.r0) : 1, r1 = other ? Math.min(bounds.r1, other.r1) : 0;
      const c0 = other ? Math.max(bounds.c0, other.c0) : 1, c1 = other ? Math.min(bounds.c1, other.c1) : 0;
      if (r0 > r1 || c0 > c1) { paint(bounds.r0, bounds.r1, bounds.c0, bounds.c1); return; }
      paint(bounds.r0, r0 - 1, bounds.c0, bounds.c1);
      paint(r1 + 1, bounds.r1, bounds.c0, bounds.c1);
      paint(r0, r1, bounds.c0, c0 - 1);
      paint(r0, r1, c1 + 1, bounds.c1);
    }
    positionSelectionOutline(s) {
      if (this.outline.hidden !== !s) this.outline.hidden = !s;
      if (s) {
        const g = this.geometry(), first = g.rows[s.r0], last = g.rows[s.r1], left = g.cols[s.c0], right = g.cols[s.c1];
        if (!first || !last || !left || !right) { this.selection = null; this.paintSelection(); return; }
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
    alignmentBounds() {
      const col = this.edit?.col ?? this.activeColumn;
      return this.bounds() || (Number.isInteger(col) && col >= 0 && col < this.model.header.length ? { c0: col, c1: col } : null);
    }
    alignColumns(c0, c1, align) {
      if (this.pending() || !this.current() || !this.wrap.getClientRects().length
          || document.hidden || document.documentElement.dataset.desktopMinimized === '1'
          || !['left', 'center', 'right'].includes(align)) return;
      // Flush an ordinary cell edit separately. Alignment itself never closes,
      // replaces or reparents the browser-owned input host.
      this.commit();
      const current = this.current(); if (!current) return;
      const line = this.view.state.doc.line(this.view.state.doc.lineAt(current.from).number + 1);
      let index = 0; const columns = [];
      const insert = line.text.replace(/:?-+:?/g, token => {
        const col = index++;
        if (col < c0 || col > c1 || (this.model.align[col] || 'left') === align) return token;
        columns.push(col); const dashes = token.replace(/:/g, '');
        return (align !== 'right' ? ':' : '') + dashes + (align !== 'left' ? ':' : '');
      });
      if (!columns.length || index !== this.model.header.length) return;
      const update = { kind: 'alignment', id: current.id, epoch: this.widget.epoch, from: current.from, to: current.to,
        source: current.source, baseModel: this.model, columns, align, lineFrom: line.from, lineTo: line.to, insert };
      const changes = this.view.state.changes({ from: line.from, to: line.to, insert });
      this.controller.mapBodyPosition(changes);
      this.view.dispatch({ changes, selection: this.view.state.selection.map(changes), effects: cellUpdateEffect.of(update),
        userEvent: 'input.table-alignment', annotations: CM.isolateHistory ? CM.isolateHistory.of('full') : [] });
    }
    // Use actual projected glyphs, including variable-width bold/code and hidden
    // delimiters. A plain-text mirror cannot match this geometry.
    inputPoint(point) {
      if (!this.edit) return { offset: 0, text: false, exact: false };
      const { input, cell } = this.edit, rects = [], range = document.createRange();
      const walker = document.createTreeWalker(input.dom, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) { range.selectNodeContents(walker.currentNode); rects.push(...range.getClientRects()); }
      const hit = textPoint(rects, point, cell.getBoundingClientRect(), textHitPadding(getComputedStyle(input.dom)), /\S/.test(input.value));
      return { offset: input.view.posAtCoords({ x: hit.x, y: hit.y }, false) ?? input.value.length, text: hit.text, exact: hit.exact };
    }
    renderedTextHit(cell, point) {
      const root = cell.querySelector('.note-table-cell-content'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const range = document.createRange(), bounds = cell.getBoundingClientRect(), padding = textHitPadding(getComputedStyle(cell));
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode);
        if (textPoint(range.getClientRects(), point, bounds, padding, /\S/.test(walker.currentNode.textContent)).text) return true;
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
      else {
        const inputHit = this.edit && this.edit.input.contains(event.target) ? this.inputPoint(event) : null;
        if (inputHit && inputHit.exact) gesture.mode = 'native-text';
        else if (inputHit ? inputHit.text : this.renderedTextHit(cell, event)) {
          event.preventDefault(); this.open(start.row, start.col, event); gesture.mode = 'text'; gesture.textAnchor = this.edit ? this.edit.input.selectionStart : 0;
        } else event.preventDefault();
      }
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
        // Capture only grips: the cell must retain browser text selection.
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
      if (gesture.mode !== 'grid') this.controller.activate(this);
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
      this.activeColumn = col;
      if (this.edit && this.edit.row === row && this.edit.col === col) {
        this.edit.input.focus(); if (point) { const offset = this.inputPoint(point).offset; this.edit.input.setSelectionRange(offset, offset); } return;
      }
      this.controller.activate(this); this.close(); this.selection = null;
      const cell = this.cell(row, col); if (!cell) return;
      cell.classList.add('is-table-editing');
      const input = new CellInput(this, cell, (row ? this.model.rows[row - 1] : this.model.header)[col],
        text('第 ' + (row + 1) + ' 行，第 ' + (col + 1) + ' 列', 'Row ' + (row + 1) + ', column ' + (col + 1)));
      this.edit = { row, col, input, cell };
      input.dom.addEventListener('compositionstart', () => { this.cancelGesture(); this.cancelFrame(); this.phase = 'composing'; this.controller.lockScroll(this); }, true);
      input.dom.addEventListener('compositionend', () => this.endComposition(), true);
      input.dom.addEventListener('blur', () => {
        if (this.pending()) { this.blurQueued = true; return; }
        this.commit(); this.removeEditor(); this.paintSelection();
      });
      this.paintSelection(); this.sizeEditor();
      input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
      if (point) { const offset = this.inputPoint(point).offset; input.setSelectionRange(offset, offset); }
    }
    sizeEditor() {
      if (!this.edit) return;
      this.geometryCache = null;
    }
    cancelFrame() { this.sequence++; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }
    endComposition() {
      this.cancelFrame(); this.phase = 'settling'; const seq = this.sequence;
      this.frame = requestAnimationFrame(() => {
        const finish = () => {
          this.frame = 0; if (seq !== this.sequence || this.disposed) return;
          if (this.edit?.input.view.composing || this.edit?.input.view.compositionStarted) { this.frame = requestAnimationFrame(finish); return; }
          this.phase = 'idle'; this.edit?.input.reconcile(); this.controller.unlockScroll(this, true); this.commit(true);
          if (this.blurQueued) { this.blurQueued = false; this.removeEditor(); }
          this.waiters.splice(0).forEach((resolve) => resolve(true));
        };
        this.frame = requestAnimationFrame(finish);
      });
    }
    commit(composed, userEvent) {
      if (!this.edit || this.pending()) return;
      const current = this.current(); if (!current) return;
      const { row, col, input } = this.edit;
      const cells = row ? this.model.rows[row - 1] : this.model.header;
      if (!cells) return;
      // A Markdown table row cannot contain a physical newline.
      const value = input.value.replace(/\r?\n/g, ' ');
      if (cells[col] === value) return;
      const next = cells.slice(); next[col] = value;
      const first = this.view.state.doc.lineAt(current.from);
      const line = this.view.state.doc.line(first.number + (row ? row + 1 : 0));
      const insert = syntax.serializeRow(next, this.model.header.length);
      if (line.text === insert) return;
      const changes = this.view.state.changes({ from: line.from, to: line.to, insert });
      const update = { id: current.id, epoch: this.widget.epoch, from: current.from, to: current.to, source: current.source,
        baseModel: this.model, row, col, cells: next, lineFrom: line.from, lineTo: line.to, insert };
      this.committing = true;
      try {
        this.controller.mapBodyPosition(changes);
        this.view.dispatch({ changes, selection: this.view.state.selection.map(changes), effects: cellUpdateEffect.of(update),
          ...(userEvent === 'input.note-highlight' ? { annotations: CM.isolateHistory.of('full') } : {}),
          userEvent: userEvent || (composed ? 'input.table-compose' : 'input.table-cell') });
      }
      finally { this.committing = false; }
    }
    format(kind, transform) {
      if (!this.edit || this.pending() || !this.current()) return false;
      const { input } = this.edit;
      const anchor = input.selectionDirection === 'backward' ? input.selectionEnd : input.selectionStart;
      const head = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
      const owner = this.edit.emptyFormat;
      const ownedEmpty = owner?.value === input.value && owner.kind === kind && anchor === head && head === owner.position;
      const edit = transform(input.value, anchor, head, ownedEmpty); if (!edit) return true;
      const change = edit.changes;
      if (Array.isArray(change)) { input.setSelectionRange(edit.anchor, edit.head); return true; }
      input.value = input.value.slice(0, change.from) + change.insert + input.value.slice(change.to == null ? change.from : change.to);
      input.setSelectionRange(Math.min(edit.anchor, edit.head), Math.max(edit.anchor, edit.head), edit.anchor > edit.head ? 'backward' : 'forward');
      this.edit.emptyFormat = anchor === head && !ownedEmpty ? { value: input.value, kind, position: edit.head } : null;
      this.commit(false, 'input.table-format'); this.sizeEditor();
      return true;
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
      edit.input.remove(); this.view.requestMeasure();
      if (edit.contentDirty && this.current() && this.shape === (this.model.rows.length + 1) + ':' + this.model.header.length) this.renderCell(edit.cell, edit.row, edit.col);
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
      this.pastePlain = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';
      if (event.key === 'Escape' && (this.gesture || this.reorderIntent)) {
        this.cancelGesture(); this.cancelReorderIntent(); this.suppressClick = true;
        if (!event.isComposing && event.keyCode !== 229 && !this.pending()) event.preventDefault();
        return;
      }
      if (event.isComposing || event.keyCode === 229 || this.pending()) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (event.key === 'Tab' && !event.shiftKey && !this.edit && this.controller.focusAlignment(this)) { event.preventDefault(); return; }
      if (this.edit && this.edit.input.contains(event.target) && this.controller.options.onTableShortcut?.(event, this)) { event.preventDefault(); return; }
      if (mod && key === 's') { event.preventDefault(); this.controller.options.onSaveRequest(); return; }
      if (mod && (key === 'z' || key === 'y')) {
        event.preventDefault(); this.history(key === 'y' || event.shiftKey); return;
      }
      if (this.edit && this.edit.input.contains(event.target)) {
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
      event.stopPropagation(); const plain = this.pastePlain; this.pastePlain = false;
      if (this.pending() || !event.clipboardData || event.defaultPrevented) return;
      const original = event.clipboardData.getData('text/plain'), input = this.edit?.input;
      const value = plain || !/\\\\[[(]/.test(original) ? original : this.controller.options.clipboardText?.(original, '', () => ({
        before: input ? input.value.slice(0, input.selectionStart) : '', after: input ? input.value.slice(input.selectionEnd) : '',
      }), true) ?? original;
      if (!this.selection && (!this.edit || !/[\t\r\n]/.test(value))) {
        if (input && value !== original) {
          event.preventDefault();
          input.view.dispatch(Object.assign({}, input.view.state.replaceSelection(value), { userEvent: 'input.paste', scrollIntoView: true }));
        }
        return;
      }
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
      if (this.edit) { const edit = this.edit; this.edit = null; edit.input.remove(); }
      this.controller.unlockScroll(this, false);
      this.clearMath(this.body);
      this.cancelGesture(); this.cancelReorderIntent();
      this.waiters.splice(0).forEach((resolve) => resolve(false));
      this.controller.detach(this); delete this.wrap.__noteTableSurface;
    }
    clearMath(content) {
      this.controller.options.releaseTableCell?.(content);
      const math = window.MathJax;
      if (math && typeof math.typesetClear === 'function') math.typesetClear([content]);
    }
  }
  window.RelatumNoteTableEditor = { createController, cellUpdateEffect };
})();

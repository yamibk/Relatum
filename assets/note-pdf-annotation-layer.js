import { placeStickyBox, resizeStickyBox, stickyBounds } from './note-pdf-sticky-box.js';

const svgNS = 'http://www.w3.org/2000/svg';
const palette = [
  ['#f4b740', '黄', 'Yellow'], ['#e8482f', '红', 'Red'], ['#3aa66e', '绿', 'Green'],
  ['#4a8fe0', '蓝', 'Blue'], ['#9b6dd6', '紫', 'Purple'], ['#e15fd0', '洋红', 'Magenta'],
  ['#ef8a3c', '橙', 'Orange'], ['#9aa0a6', '灰', 'Gray'], ['#1a1a1a', '墨', 'Ink'],
];
const modes = [
  ['', '选择批注', 'Select annotations', 'pdf-select'],
  ['highlight', '划词高亮', 'Highlight text', 'pdf-highlight-text'], ['underline', '下划线', 'Underline', 'pdf-underline'],
  ['pen', '钢笔', 'Pen', 'pdf-pen'], ['highlighter', '荧光笔', 'Highlighter', 'pdf-marker'],
  ['box', '框选', 'Box', 'pdf-box'], ['note', '便签', 'Sticky note', 'pdf-sticky'], ['eraser', '橡皮', 'Eraser', 'pdf-eraser'],
];
const drawModes = new Set(['pen', 'highlighter', 'box', 'eraser', 'note']);
const textModes = new Set(['highlight', 'underline']);
const clamp = (n, max) => Math.min(max, Math.max(0, n));
const round = n => Math.round(n * 1000) / 1000;
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const editable = node => node?.closest?.('input, textarea, select, [contenteditable="true"]');

function html(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function shape(tag, attributes) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function selectionQuads(range, textLayer, project) {
  const quads = [], walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const caret = document.createRange();
  const layerTransform = getComputedStyle(textLayer).transform;
  const view = new DOMMatrixReadOnly(layerTransform === 'none' ? undefined : layerTransform);
  for (let node = walker.nextNode(); node && quads.length < 4096; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const from = range.startContainer === node ? range.startOffset : 0;
    const to = range.endContainer === node ? range.endOffset : node.length;
    if (from >= to || !node.data.slice(from, to).trim()) continue;
    caret.setStart(node, from); caret.collapse(true);
    const start = caret.getBoundingClientRect();
    caret.setStart(node, to); caret.collapse(true);
    const end = caret.getBoundingClientRect();
    const local = getComputedStyle(node.parentElement).transform;
    const { a, b } = local === 'none' ? view : view.multiply(new DOMMatrixReadOnly(local));
    const length = Math.hypot(a, b);
    if (!length || Math.hypot(start.x - end.x, start.y - end.y) < 1) continue;
    // The caret's center and length recover the selected run's corners even
    // when the browser reports only axis-aligned rectangles for rotated text.
    function edge(rect, direction) {
      const half = direction * Math.hypot(rect.width, rect.height) / (2 * length);
      return project(rect.x + rect.width / 2 - b * half, rect.y + rect.height / 2 + a * half);
    }
    quads.push([edge(start, -1), edge(end, -1), edge(end, 1), edge(start, 1)]);
  }
  return quads;
}

function textLineQuads(quads, heightScale = 1) {
  const directions = new Map();
  for (const points of quads) {
    const [top, , , base] = points;
    // Use the side edge to keep the same baseline for LTR and RTL fragments.
    const angle = Math.atan2(top[0] - base[0], base[1] - top[1]);
    const key = (Math.round(angle * 180 / Math.PI) + 360) % 360;
    if (!directions.has(key)) directions.set(key, { angle, fragments: [] });
    const { angle: basis, fragments } = directions.get(key);
    const cos = Math.cos(basis), sin = Math.sin(basis);
    const along = points.map(([x, y]) => x * cos + y * sin);
    const across = points.map(([x, y]) => y * cos - x * sin);
    const start = Math.min(...along), end = Math.max(...along);
    const min = Math.min(...across), max = Math.max(...across);
    if (end > start && max > min) fragments.push({ start, end, center: (min + max) / 2, height: max - min });
  }
  const bands = [];
  for (const { angle, fragments } of directions.values()) {
    const lines = [];
    for (const fragment of fragments.sort((a, b) => a.center - b.center)) {
      const line = lines.at(-1), reference = line?.[0];
      if (reference) {
        const height = Math.max(reference.height, fragment.height);
        const script = Math.min(reference.height, fragment.height) < height * .8;
        if (fragment.center - reference.center <= height * (script ? .5 : .3)) {
          if (fragment.height > reference.height * 1.05) line.unshift(fragment);
          else line.push(fragment);
          continue;
        }
      }
      lines.push([fragment]);
    }
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const project = (x, y) => [x * cos - y * sin, x * sin + y * cos];
    const rows = [];
    for (const line of lines) {
      const { center, height } = line[0];
      line.sort((a, b) => a.start - b.start);
      const runs = [];
      for (const { start, end } of line) {
        const run = runs.at(-1);
        if (run && start - run.end <= height * .45) run.end = Math.max(run.end, end);
        else runs.push({ start, end });
      }
      const halfHeight = height * heightScale / 2;
      rows.push({ center, height, top: center - halfHeight, bottom: center + halfHeight, runs });
    }
    // Font bounding boxes can overlap even on two distinct lines. Leave a
    // narrow seam where their runs share horizontal space.
    for (let index = 1; index < rows.length; index++) {
      const upper = rows[index - 1], lower = rows[index];
      const halfGap = Math.min(upper.height, lower.height) * .04;
      if (upper.bottom + 2 * halfGap < lower.top || !overlapRuns(upper.runs, lower.runs)) continue;
      const middle = (upper.center + lower.center) / 2;
      upper.bottom = Math.min(upper.bottom, middle - halfGap);
      lower.top = Math.max(lower.top, middle + halfGap);
    }
    for (const { top, bottom, runs } of rows) {
      for (const { start, end } of runs) bands.push([project(start, top), project(end, top), project(end, bottom), project(start, bottom)]);
    }
  }
  return bands;
}

function overlapRuns(left, right) {
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    if (left[a].end <= right[b].start) a++;
    else if (right[b].end <= left[a].start) b++;
    else return true;
  }
  return false;
}

function quadsPath(quads) {
  return quads.map(points => 'M' + points.map(point => point.map(round).join(' ')).join('L') + 'Z').join('');
}

export function mountTextSelection(host, textLayer, viewport) {
  const overlay = shape('svg', { class: 'note-pdf-selection', 'aria-hidden': 'true',
    viewBox: '0 0 ' + viewport.width + ' ' + viewport.height });
  const highlight = shape('path', {});
  overlay.append(highlight); host.append(overlay);
  textLayer.classList.add('has-selection-overlay');
  return range => {
    let path = '';
    if (range?.intersectsNode(textLayer)) {
      const bounds = host.getBoundingClientRect();
      if (bounds.width && bounds.height) {
        path = quadsPath(textLineQuads(selectionQuads(range, textLayer, (x, y) => [
          (x - bounds.left) * viewport.width / bounds.width, (y - bounds.top) * viewport.height / bounds.height,
        ])));
      }
    }
    if (highlight.getAttribute('d') !== path) highlight.setAttribute('d', path);
  };
}

function smooth(points) {
  if (points.length < 3) return points.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
  let path = 'M' + points[0].join(' ');
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [nextX, nextY] = points[i + 1];
    path += ' Q' + x + ' ' + y + ' ' + (x + nextX) / 2 + ' ' + (y + nextY) / 2;
  }
  return path + ' L' + points.at(-1).join(' ');
}

function stroke(record, viewport, group) {
  const points = record.points.map(([x, y, p]) => [...viewport.convertToViewportPoint(x, y), p]);
  const width = record.width * viewport.scale;
  const { color, kind } = record;
  if (points.length === 1) {
    const [cx, cy, pressure] = points[0];
    const r = Math.max(.6, width * (kind === 'pen' ? .22 + .78 * pressure : 1) / 2);
    group.append(shape('circle', { cx, cy, r, fill: color, opacity: kind === 'pen' ? 1 : .32 }));
  } else if (kind === 'highlighter') {
    group.append(shape('path', { d: smooth(points.map(point => point.slice(0, 2))), fill: 'none',
      stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .32 }));
  } else {
    const left = [], right = [];
    // As on the canvas, average neighboring pressure and taper the ends.
    points.forEach(([x, y, p], i) => {
      const before = points[Math.max(i - 1, 0)], after = points[Math.min(i + 1, points.length - 1)];
      const length = distance(before, after) || 1, pressure = (before[2] + 2 * p + after[2]) / 4;
      const taper = .55 + .45 * Math.min(i, points.length - 1 - i, 2) / 2;
      const radius = width / 2 * (.22 + .78 * pressure) * taper;
      const dx = (after[1] - before[1]) * radius / length, dy = (after[0] - before[0]) * radius / length;
      left.push([x - dx, y + dy]); right.push([x + dx, y - dy]);
    });
    group.append(shape('path', { d: smooth(left) + smooth(right.reverse()).replace(/^M/, ' L') + ' Z', fill: color }));
  }
}

function draw(record, viewport, group) {
  if (record.points) { stroke(record, viewport, group); return; }
  const project = quad => quad.map(point => viewport.convertToViewportPoint(...point));
  if (record.quads) {
    const bands = textLineQuads(record.quads.map(project), record.kind === 'highlight' ? .8 : 1);
    if (record.kind === 'underline') {
      const d = bands.map(([, , end, start]) => smooth([start.map(round), end.map(round)])).join('');
      group.append(shape('path', { d, fill: 'none', stroke: record.color, 'stroke-width': viewport.scale }));
    } else {
      group.append(shape('path', { d: quadsPath(bands), fill: record.color }));
    }
    return;
  }
  const points = project(record.quad).map(point => point.join(',')).join(' ');
  group.append(shape('polygon', { points, fill: 'none', stroke: record.color, 'stroke-width': 2 }));
}

export function createAnnotationTools({ copy, button, current, confirmReload, notify, signal }) {
  const toggle = button(copy('批注', 'Annotate'), () => chooseTool(!open), '', 'file-pen-line');
  toggle.append(copy('批注', 'Annotate'));
  const bar = html('div', 'note-pdf-annotation-tools');
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', copy('PDF 批注工具', 'PDF annotation tools'));
  const status = html('div', 'note-pdf-annotation-status');
  status.setAttribute('role', 'status');
  const message = html('span');
  const listeners = new Set(), textSelections = new Set();
  const locks = ['pdf_changed', 'annotation_conflict', 'annotation_unreadable'];
  let open = false, tool = '', selected = '', session, unsubscribe, working = false, draft, cancelResize, toolIntent = 0;
  const canChoose = () => !!session && !locks.includes(session.error);
  const canEdit = () => canChoose() && session.ready && !session.loading;
  function update(affected) {
    const error = session?.error;
    toggle.setAttribute('aria-pressed', String(open));
    buttons.forEach(([mode, control]) => {
      control.disabled = !canChoose();
      control.setAttribute('aria-pressed', String(open && mode === tool));
    });
    undo.disabled = !canEdit() || !session.canUndo; redo.disabled = !canEdit() || !session.canRedo;
    remove.disabled = !canEdit() || !session.get(selected);
    thickness.disabled = !canChoose() || !open || (tool !== 'pen' && tool !== 'highlighter');
    color.disabled = !canChoose();
    colorControl.sync();
    colors.style.setProperty('--pdf-annotation-color', palette[color.selectedIndex][0]);
    retry.hidden = !error || (error === 'pdf_changed' && !session.dirty) || error === 'annotation_unreadable';
    retry.disabled = working;
    const retryLabel = error === 'annotation_conflict' ? copy('重新载入', 'Reload')
      : error === 'pdf_changed' ? copy('放弃未保存草稿', 'Discard unsaved draft') : copy('重试', 'Retry');
    retry.textContent = retry.title = retryLabel;
    retry.setAttribute('aria-label', retryLabel);
    const messages = {
      pdf_changed: copy('PDF 内容已变化，原有批注已保留。', 'The PDF changed. Its previous annotations were kept.'),
      annotation_conflict: copy('其他窗口已修改批注，本地草稿已保留。', 'Annotations changed in another window. Your draft is still here.'),
      annotation_unreadable: copy('无法读取批注文件，原有数据已保留。', 'The annotation file could not be read. Its data was kept.'),
      too_large: copy('批注已达到大小上限。请删减批注后重试。', 'Annotations exceeded the size limit. Remove some and retry.'),
    };
    message.textContent = error ? messages[error] || copy('批注暂时无法保存或读取。', 'Unable to save or read annotations.') : '';
    status.hidden = !message.textContent;
    listeners.forEach(listener => listener(affected));
  }
  async function chooseTool(show, next = '') {
    const intent = ++toolIntent;
    settle();
    open = show; tool = next; selected = '';
    if (!show) choices.close();
    update();
    if (show && !canEdit()) await session?.load({ edit: true });
    if (intent === toolIntent && current() && open && textModes.has(tool)) {
      for (const annotate of textSelections) if (annotate(tool)) break;
    }
  }
  function select(id) {
    selected = id;
    const value = session?.get(id)?.color;
    if (palette.some(([hex]) => hex === value)) color.value = value;
    update();
  }
  function settle() { cancelResize?.(); draft?.(); }
  const modesGroup = html('div', 'note-pdf-annotation-group');
  const buttons = modes.map(([key, zh, en, glyph]) => [key, button(copy(zh, en),
    () => chooseTool(true, open && tool === key ? '' : key), 'note-pdf-annotation-tool', glyph)]);
  modesGroup.append(...buttons.map(([, control]) => control));
  const optionsGroup = html('div', 'note-pdf-annotation-group note-pdf-annotation-options');
  const colors = html('div', 'note-pdf-annotation-colors');
  const portal = html('div', 'note-pdf-color-portal');
  portal.setAttribute('data-ui-tooltip-disabled', '');
  document.body.append(portal);
  const choices = window.RelatumReviewControls.createManager(bar, portal);
  const color = html('select');
  color.setAttribute('aria-label', copy('批注颜色', 'Annotation color'));
  color.append(...palette.map(([hex, zh, en]) => {
    const item = html('option', '', copy(zh, en)); item.value = hex; return item;
  }));
  colors.append(color);
  const colorControl = choices.enhance(color, { searchable: false, swatch: value => value });
  color.onchange = () => {
    settle();
    const record = session?.get(selected);
    if (record) session.commit(new Map([[selected, { ...record, color: color.value }]]));
    update();
  };
  const thickness = html('input', 'note-pdf-annotation-width');
  thickness.type = 'range'; thickness.min = 1; thickness.max = 5; thickness.step = 1; thickness.value = 2;
  thickness.title = copy('笔画粗细', 'Stroke width'); thickness.setAttribute('aria-label', thickness.title);
  const undo = button(copy('撤销批注', 'Undo annotation'), () => { settle(); session?.undo(); }, '', 'pdf-undo');
  const redo = button(copy('重做批注', 'Redo annotation'), () => { settle(); session?.redo(); }, '', 'pdf-redo');
  const remove = button(copy('删除选中批注', 'Delete selected annotation'), () => {
    settle();
    if (!selected || !session?.get(selected) || !session.commit(new Map([[selected, null]]))) return;
    select(''); undo.focus({ preventScroll: true });
    notify?.(copy('已删除批注，可撤销', 'Annotation deleted. Undo is available.'));
  }, 'note-pdf-annotation-delete', 'trash');
  remove.append(copy('删除', 'Delete'));
  const retry = button(copy('重试', 'Retry'), async () => {
    const active = session;
    if (!active || working) return;
    working = true; update(new Set());
    try {
      if (active.error === 'annotation_conflict') {
        if (await confirmReload(current) && current() && active === session) await active.load({ reload: true });
      } else if (active.error === 'pdf_changed') {
        if (await confirmReload(current) && current() && active === session) await active.discardChangedDraft();
      } else if (active.dirty) await active.flush({ retry: true });
      else await active.load({ edit: open, reload: true });
    } finally { working = false; update(); }
  });
  optionsGroup.append(colors, thickness);
  const historyGroup = html('div', 'note-pdf-annotation-group note-pdf-annotation-history');
  historyGroup.append(undo, redo, remove);
  bar.append(modesGroup, optionsGroup, historyGroup);
  status.append(message, retry);
  window.addEventListener('keydown', event => {
    if (!current() || !open || colorControl.isOpen || event.defaultPrevented || event.isComposing || editable(event.target)
        || event.target?.closest?.('[role="dialog"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      event.preventDefault(); event.stopPropagation();
      if (cancelResize) cancelResize();
      else { void chooseTool(false); toggle.focus(); }
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[zy]$/.test(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'y' || event.shiftKey) { if (!redo.disabled) redo.click(); }
      else if (!undo.disabled) undo.click();
    } else if (key === 'delete' && !remove.disabled) {
      event.preventDefault(); event.stopPropagation(); remove.click();
    }
  }, { signal, capture: true });
  signal.addEventListener('abort', () => { choices.dispose(); portal.remove(); }, { once: true });
  update();
  return {
    toggle, bar, status, settle, select,
    switchToSelection(event) {
      if (event.button !== 2 || event.defaultPrevented || editable(event.target)
          || !current() || !open || !tool || !canChoose()) return;
      event.preventDefault();
      event.stopPropagation();
      void chooseTool(true);
    },
    attach(value) {
      settle(); unsubscribe?.(); session = value;
      unsubscribe = session?.subscribe(update);
      if (open && session) void session.load({ edit: true });
      update();
    },
    reset() { void chooseTool(false); this.attach(null); },
    get active() { return open && canEdit(); },
    get mode() { return this.active ? tool : ''; },
    get color() { return color.value; },
    get width() { return Number(thickness.value); },
    get selected() { return selected; },
    setDraft(commit) { settle(); draft = commit; },
    clearDraft(commit) { if (draft === commit) draft = null; },
    setResizeCancel(cancel) { cancelResize = cancel; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onTextSelection(annotate) { textSelections.add(annotate); return () => textSelections.delete(annotate); },
  };
}

export function mountAnnotationPage(host, page, viewport, session, tools, copy, button) {
  const lifetime = new AbortController(), { signal } = lifetime;
  const layer = html('div', 'note-pdf-annotations');
  const svgAttributes = { viewBox: '0 0 ' + viewport.width + ' ' + viewport.height, 'aria-hidden': 'true' };
  const markup = html('div', 'note-pdf-text-marks');
  const textVector = shape('svg', svgAttributes);
  // Composite the finished highlight layer once so overlapping marks do not darken.
  const highlights = shape('g', { opacity: .4 }), underlines = shape('g', {});
  textVector.append(highlights, underlines);
  const vector = shape('svg', svgAttributes);
  const saved = shape('g', {}), preview = shape('g', { 'pointer-events': 'none' });
  const notes = html('div', 'note-pdf-sticky-layer');
  markup.append(textVector); vector.append(saved, preview); layer.append(markup, vector, notes); host.append(layer);
  const stickyViews = new Map();
  const stage = host.closest('.note-pdf-scroll');
  let gesture, frame, textPointer, noteDrag, noteResize, draggedHandle;
  const selecting = () => !!tools?.active && !tools.mode;
  const editingNote = () => selecting() || (tools?.active && tools.mode === 'note');

  function measureNote(view, width) {
    const text = view.input?.value ?? view.text;
    if (!view.measured || view.measure.value !== text) {
      view.measured = new Map();
      view.measure.value = text;
    }
    if (!view.measured.has(width)) {
      view.measure.style.width = Math.max(1, width - view.insetX) + 'px';
      view.measured.set(width, Math.max(60, view.measure.scrollHeight + view.insetY + 1));
    }
    return view.measured.get(width);
  }

  function showNoteBox(view, box) {
    for (const [key, value] of Object.entries(box)) {
      if (view.box?.[key] !== value) view.popup.style[key] = value + 'px';
    }
    view.box = box;
  }

  function positionNote(view, x, y, paper = host.getBoundingClientRect()) {
    view.pin.style.left = x + 'px'; view.pin.style.top = y + 'px';
    if (!view.popup || !paper.width || !paper.height) return;
    const reader = stage.getBoundingClientRect();
    const anchorVisible = paper.left + x >= reader.left && paper.left + x <= reader.right
      && paper.top + y >= reader.top && paper.top + y <= reader.bottom;
    const visible = anchorVisible && stickyBounds(paper, reader);
    const bounds = visible || { left: 0, top: 0, right: Math.floor(paper.width), bottom: Math.floor(paper.height) };
    showNoteBox(view, placeStickyBox(x, y, bounds, view.cardBox, width => measureNote(view, width)));
  }

  function toggleNote(id, open, focusText = false) {
    const view = stickyViews.get(id);
    if (!view) return;
    if (editingNote()) {
      tools.settle();
      tools.select(id);
    }
    session.setNoteExpanded(id, open);
    if (open && focusText) view.input?.focus({ preventScroll: true });
    if (!open) view.pin.focus({ preventScroll: true });
  }

  function mountNote(view, record) {
    const popup = view.popup = html('div', 'note-pdf-sticky');
    popup.setAttribute('aria-label', copy('PDF 便签', 'PDF sticky note'));
    popup.dataset.annotationId = record.id;
    const header = html('div', 'note-pdf-sticky-head');
    header.append(button(copy('关闭便签', 'Close note'), () => toggleNote(record.id, false), '', 'x'));
    header.onclick = event => {
      if (selecting() && !event.target.closest('button')) toggleNote(record.id, false);
    };
    popup.append(header);
    if (!tools) {
      view.content = html('p', '', record.text);
    } else {
      const input = view.content = view.input = html('textarea');
      input.maxLength = 64_000;
      input.setAttribute('aria-label', copy('便签内容', 'Sticky note text'));
      function writeText(group) {
        const previous = session.get(record.id);
        if (previous && input.value !== previous.text) commit({ ...previous, text: input.value }, group);
      }
      const finishEdit = view.finishEdit = () => {
        const group = view.editGroup;
        if (!group) return;
        view.editGroup = null;
        tools.clearDraft(finishEdit);
        if (document.activeElement === input) input.blur();
        writeText(group);
      };
      input.onfocus = () => {
        if (input.readOnly) return;
        tools.setDraft(finishEdit);
        view.editGroup = Symbol('sticky note input');
        tools.select(record.id);
      };
      input.onblur = finishEdit;
      input.oninput = event => { if (view.editGroup && !event.isComposing) writeText(view.editGroup); };
      input.oncompositionend = () => { if (view.editGroup) writeText(view.editGroup); };
      input.onkeydown = event => {
        if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); toggleNote(record.id, false); }
      };
    }
    const measure = view.measure = html('textarea', 'note-pdf-sticky-measure');
    measure.tabIndex = -1;
    measure.setAttribute('aria-hidden', 'true');
    popup.append(view.content, measure);
    if (tools) {
      for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
        const handle = html('span', 'note-pdf-sticky-resize');
        handle.dataset.edge = edge;
        handle.setAttribute('aria-hidden', 'true');
        popup.append(handle);
      }
    }
    notes.append(popup);
    view.insetX = popup.offsetWidth - view.content.offsetWidth;
    view.insetY = popup.offsetHeight - view.content.offsetHeight + measure.offsetHeight - measure.clientHeight;
  }

  function closeNote(view) {
    if (noteResize?.view === view) finishNoteResize(null, false);
    view.finishEdit?.();
    view.popup?.remove();
    view.popup = view.content = view.input = view.finishEdit = null;
    view.box = view.measure = view.measured = null;
  }

  function syncNote(record, expanded) {
    let view = stickyViews.get(record.id);
    if (!view) {
      const pin = button(copy('查看便签', 'Open sticky note'), () => {
        if (!drawModes.has(tools?.mode) || tools.mode === 'note') toggleNote(record.id, !view.popup, editingNote());
      }, 'note-pdf-sticky-pin', 'file-text');
      pin.dataset.annotationId = record.id;
      view = { pin }; stickyViews.set(record.id, view);
      notes.append(pin);
    }
    const opening = expanded && !view.popup;
    if (opening) mountNote(view, record);
    else if (!expanded && view.popup) closeNote(view);
    if (view.expanded !== expanded) {
      view.expanded = expanded;
      const label = expanded ? copy('收起便签', 'Collapse sticky note') : copy('查看便签', 'Open sticky note');
      view.pin.setAttribute('aria-label', label);
      view.pin.setAttribute('aria-expanded', String(expanded));
    }
    if (view.color !== record.color) view.pin.style.setProperty('--pdf-annotation-color', record.color);
    if (view.popup) {
      if (opening || view.color !== record.color) view.popup.style.setProperty('--pdf-annotation-color', record.color);
      if (view.input) {
        view.input.readOnly = !editingNote();
        if (!view.editGroup && view.input.value !== record.text) view.input.value = record.text;
      } else if (view.content.textContent !== record.text) view.content.textContent = record.text;
    }
    const pointChanged = view.point !== record.point;
    const layoutChanged = opening || pointChanged || (expanded && (view.text !== record.text || view.cardBox !== record.cardBox));
    view.point = record.point; view.text = record.text; view.cardBox = record.cardBox;
    if (layoutChanged) {
      if (noteResize?.view === view) finishNoteResize(null, false);
      if (noteDrag?.view !== view || !noteDrag.moved) positionNote(view, ...viewport.convertToViewportPoint(...record.point));
    }
    view.color = record.color;
    view.pin.classList.toggle('is-selected', record.id === tools?.selected);
  }

  function render(affected) {
    if (noteResize && !selecting()) finishNoteResize(null, false);
    if (affected && !affected.has(page)) return;
    saved.replaceChildren();
    highlights.replaceChildren();
    underlines.replaceChildren();
    const mode = tools?.mode || '';
    if (noteDrag && !selecting()) finishNoteDrag(null, false);
    if (gesture && mode !== gesture.kind) finish(null, false);
    layer.dataset.tool = mode;
    layer.classList.toggle('is-drawing', drawModes.has(mode));
    layer.classList.toggle('is-selecting', selecting());
    const expanded = session.expandedNotes(), present = new Set();
    for (const record of session.onPage(page)) {
      if (record.kind === 'note') {
        present.add(record.id);
        syncNote(record, expanded.has(record.id));
      } else {
        const group = shape('g', {});
        group.dataset.annotationId = record.id;
        draw(record, viewport, group);
        group.classList.toggle('is-selected', record.id === tools?.selected);
        const target = record.kind === 'highlight' ? highlights : record.kind === 'underline' ? underlines : saved;
        target.append(group);
      }
    }
    for (const [id, view] of stickyViews) {
      if (present.has(id)) continue;
      if (noteDrag?.view === view) finishNoteDrag(null, false);
      closeNote(view); view.pin.remove(); stickyViews.delete(id);
    }
  }
  const offSession = tools ? () => {} : session.subscribe(render);
  const offTools = tools?.subscribe(render);
  function layout() {
    finishNoteResize(null, false);
    const paper = host.getBoundingClientRect();
    for (const view of stickyViews.values()) {
      if (view.popup) positionNote(view, ...viewport.convertToViewportPoint(...view.point), paper);
    }
  }
  render();
  if (!tools) return { layout, dispose() { offSession(); lifetime.abort(); layer.remove(); } };

  function point(x, y) {
    return viewport.convertToPdfPoint(clamp(x, viewport.width), clamp(y, viewport.height)).map(round);
  }
  function fromClient(x, y, bounds = host.getBoundingClientRect()) {
    return point((x - bounds.left) * viewport.width / bounds.width, (y - bounds.top) * viewport.height / bounds.height);
  }
  function rectQuad(x1, y1, x2, y2) {
    const bounds = host.getBoundingClientRect();
    return [fromClient(x1, y1, bounds), fromClient(x2, y1, bounds), fromClient(x2, y2, bounds), fromClient(x1, y2, bounds)];
  }
  function dimensions(start, end) {
    return [Math.min(start.clientX, end.clientX), Math.min(start.clientY, end.clientY),
      Math.max(start.clientX, end.clientX), Math.max(start.clientY, end.clientY)];
  }
  function fresh(kind) { return { id: crypto.randomUUID(), page, kind, color: tools.color }; }
  function commit(record, group) { return session.commit(new Map([[record.id, record]]), group); }

  function beginNoteResize(event, handle) {
    const id = handle.parentElement.dataset.annotationId;
    const view = stickyViews.get(id);
    const bounds = stickyBounds(host.getBoundingClientRect(), stage.getBoundingClientRect());
    if (!view?.box || !bounds) return;
    event.preventDefault(); event.stopPropagation();
    tools.settle(); tools.select(id);
    const [x, y] = viewport.convertToViewportPoint(...view.point);
    const { left, top, width, height } = view.box;
    const measure = width => measureNote(view, width);
    const start = placeStickyBox(x, y, bounds, { width, height, offsetX: left - x, offsetY: top - y }, measure);
    const events = new AbortController();
    noteResize = { id, view, bounds, start, x, y, measure, handle, events, pointer: event.pointerId,
      clientX: event.clientX, clientY: event.clientY, last: event, frame: 0 };
    tools.setResizeCancel(() => finishNoteResize(null, false));
    stage.addEventListener('scroll', () => finishNoteResize(null, false), { passive: true, signal: events.signal });
    handle.setPointerCapture(event.pointerId);
  }

  function paintNoteResize(resize) {
    resize.frame = 0;
    const dx = Math.round(resize.last.clientX - resize.clientX), dy = Math.round(resize.last.clientY - resize.clientY);
    const box = resizeStickyBox(resize.start, resize.bounds, resize.handle.dataset.edge, dx, dy, resize.measure);
    showNoteBox(resize.view, box);
    return box;
  }

  function finishNoteResize(event, accept) {
    const resize = noteResize;
    if (!resize || (event && resize.pointer !== event.pointerId)) return;
    noteResize = null;
    tools.setResizeCancel(null);
    resize.events.abort();
    cancelAnimationFrame(resize.frame);
    if (resize.handle.hasPointerCapture(resize.pointer)) resize.handle.releasePointerCapture(resize.pointer);
    const record = session.get(resize.id);
    if (accept && selecting() && record?.kind === 'note') {
      resize.last = event;
      const { left, top, width, height } = paintNoteResize(resize);
      if (width !== resize.start.width || height !== resize.start.height) {
        const cardBox = { width, height, offsetX: Math.round(left - resize.x), offsetY: Math.round(top - resize.y) };
        if (commit({ ...record, cardBox })) return;
      }
    }
    positionNote(resize.view, resize.x, resize.y);
  }

  function beginNoteDrag(event, handle) {
    if (noteDrag) return;
    const id = handle.closest('[data-annotation-id]').dataset.annotationId;
    const view = stickyViews.get(id);
    if (!view) return;
    const paper = host.getBoundingClientRect();
    const [x, y] = viewport.convertToViewportPoint(...view.point);
    const offset = [x - (event.clientX - paper.left) * viewport.width / paper.width,
      y - (event.clientY - paper.top) * viewport.height / paper.height];
    tools.settle();
    tools.select(id);
    draggedHandle = null;
    noteDrag = { id, view, handle, pointer: event.pointerId, offset,
      start: [event.clientX, event.clientY], last: null, moved: false, frame: 0 };
    handle.setPointerCapture(event.pointerId);
  }

  function sampleNoteDrag(drag, event) {
    drag.last = [event.clientX, event.clientY];
    if (!drag.moved && distance(drag.start, drag.last) >= 4) {
      drag.moved = true;
      layer.classList.add('is-moving-sticky');
    }
  }

  function paintNoteDrag(drag) {
    drag.frame = 0;
    const paper = host.getBoundingClientRect();
    const within = (value, extent) => {
      const inset = Math.min(11, extent / 2);
      return Math.min(extent - inset, Math.max(inset, value));
    };
    const x = within((drag.last[0] - paper.left) * viewport.width / paper.width + drag.offset[0], viewport.width);
    const y = within((drag.last[1] - paper.top) * viewport.height / paper.height + drag.offset[1], viewport.height);
    positionNote(drag.view, x, y, paper);
    return point(x, y);
  }

  function finishNoteDrag(event, accept) {
    const drag = noteDrag;
    if (!drag || (event && drag.pointer !== event.pointerId)) return;
    if (accept) sampleNoteDrag(drag, event);
    cancelAnimationFrame(drag.frame);
    noteDrag = null;
    layer.classList.remove('is-moving-sticky');
    if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    if (!drag.moved) return;
    draggedHandle = drag.handle;
    const record = session.get(drag.id);
    if (accept && selecting() && record?.kind === 'note') {
      const destination = paintNoteDrag(drag);
      if (destination.some((part, axis) => part !== record.point[axis]) && commit({ ...record, point: destination })) return;
    }
    positionNote(drag.view, ...viewport.convertToViewportPoint(...drag.view.point));
  }

  function ownsText(node) {
    const textLayer = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('.note-pdf-text');
    return textLayer?.parentElement === host;
  }
  function annotateSelection(kind) {
    if (signal.aborted || tools.mode !== kind) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !ownsText(selection.anchorNode) || !ownsText(selection.focusNode)) return false;
    const bounds = host.getBoundingClientRect();
    const quads = selectionQuads(selection.getRangeAt(0), host.querySelector('.note-pdf-text'),
      (x, y) => fromClient(x, y, bounds));
    if (!quads.length || !commit({ ...fresh(kind), quads, text: selection.toString().slice(0, 64_000) })) return false;
    selection.removeAllRanges();
    return true;
  }
  const offSelection = tools.onTextSelection(annotateSelection);
  host.addEventListener('pointerdown', event => {
    if (event.button === 0 && ownsText(event.target) && textModes.has(tools.mode)) textPointer = event.pointerId;
  }, { signal });
  window.addEventListener('pointerup', event => {
    if (textPointer !== event.pointerId) return;
    textPointer = undefined;
    const kind = tools.mode;
    if (textModes.has(kind)) requestAnimationFrame(() => annotateSelection(kind));
  }, { capture: true, signal });
  window.addEventListener('pointercancel', event => { if (textPointer === event.pointerId) textPointer = undefined; }, { signal });

  function sample(event, bounds) {
    const current = gesture;
    current.end = event;
    if (current.kind === 'eraser') {
      const hit = document.elementsFromPoint(event.clientX, event.clientY)
        .map(node => node.closest('[data-annotation-id]')).find(node => node && layer.contains(node) && !current.erased.has(node.dataset.annotationId));
      if (hit) { current.erased.set(hit.dataset.annotationId, null); hit.classList.add('is-erasing'); }
    } else if (current.record?.points && current.record.points.length < 8192) {
      const value = fromClient(event.clientX, event.clientY, bounds);
      if (current.record.points.length && distance(value, current.record.points.at(-1)) < .32) return;
      let pressure = .5;
      if (current.kind === 'pen' && event.pointerType === 'pen' && event.pressure > 0) {
        try { if (localStorage.getItem('canvas:penPressure') !== '0') pressure = event.pressure; } catch {}
      }
      current.record.points.push([...value, round(pressure)]);
    }
  }
  function paintPreview() {
    frame = 0;
    if (!gesture?.record) return;
    preview.replaceChildren();
    if (gesture.kind === 'box') gesture.record.quad = rectQuad(...dimensions(gesture.start, gesture.end));
    draw(gesture.record, viewport, preview);
  }
  function finish(event, accept) {
    if (!gesture || (event?.pointerId != null && event.pointerId !== gesture.pointer)) return;
    if (accept) sample(event);
    const current = gesture; gesture = null;
    cancelAnimationFrame(frame); frame = 0; preview.replaceChildren();
    if (vector.hasPointerCapture(current.pointer)) vector.releasePointerCapture(current.pointer);
    layer.querySelectorAll('.is-erasing').forEach(item => item.classList.remove('is-erasing'));
    if (!accept || tools.mode !== current.kind) return;
    if (current.kind === 'eraser') { session.commit(current.erased); return; }
    if (current.kind === 'box') {
      const rect = dimensions(current.start, current.end);
      if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return;
      current.record.quad = rectQuad(...rect);
    }
    commit(current.record);
  }
  layer.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture || noteDrag || noteResize) return;
    const kind = tools.mode;
    const resize = event.target.closest('.note-pdf-sticky-resize');
    const pin = event.target.closest('.note-pdf-sticky-pin');
    const header = event.target.closest('.note-pdf-sticky-head');
    draggedHandle = null;
    if (selecting() && resize) { beginNoteResize(event, resize); return; }
    if (selecting() && (pin || (header && !event.target.closest('button')))) {
      beginNoteDrag(event, pin || header);
      return;
    }
    if (event.target.closest('.note-pdf-sticky') || (pin && kind === 'note')) return;
    if (!drawModes.has(kind)) {
      if (tools.active && (vector.contains(event.target) || textVector.contains(event.target))) {
        tools.select(event.target.closest('[data-annotation-id]')?.dataset.annotationId || '');
      }
      return;
    }
    event.preventDefault();
    tools.settle();
    if (kind === 'note') {
      const record = { ...fresh(kind), point: fromClient(event.clientX, event.clientY), text: '' };
      if (commit(record)) toggleNote(record.id, true, true);
      return;
    }
    const record = kind === 'eraser' ? null : fresh(kind);
    if (record && kind !== 'box') {
      record.points = [];
      record.width = (kind === 'pen' ? 1.8 : 8) * tools.width / 2;
    }
    gesture = { kind, record, pointer: event.pointerId, start: event, end: event, erased: new Map() };
    vector.setPointerCapture(event.pointerId);
    sample(event); paintPreview();
  }, { signal });
  vector.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const events = event.getCoalescedEvents?.();
    const bounds = gesture.record?.points ? host.getBoundingClientRect() : undefined;
    (events?.length ? events : [event]).forEach(point => sample(point, bounds));
    if (!frame) frame = requestAnimationFrame(paintPreview);
  }, { signal });
  vector.addEventListener('pointerup', event => finish(event, true), { signal });
  for (const name of ['pointercancel', 'lostpointercapture']) vector.addEventListener(name, event => finish(event, false), { signal });
  layer.addEventListener('pointermove', event => {
    const resize = noteResize;
    if (resize?.pointer === event.pointerId) {
      resize.last = event;
      if (!resize.frame) resize.frame = requestAnimationFrame(() => paintNoteResize(resize));
      return;
    }
    const drag = noteDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    sampleNoteDrag(drag, event);
    if (drag.moved && !drag.frame) drag.frame = requestAnimationFrame(() => paintNoteDrag(drag));
  }, { signal });
  layer.addEventListener('pointerup', event => {
    finishNoteResize(event, true); finishNoteDrag(event, true);
  }, { signal });
  layer.addEventListener('click', event => {
    if (!event.detail || !draggedHandle?.contains(event.target)) return;
    draggedHandle = null;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, signal });
  for (const name of ['pointercancel', 'lostpointercapture']) layer.addEventListener(name, event => {
    finishNoteResize(event, false); finishNoteDrag(event, false);
  }, { signal });
  window.addEventListener('blur', () => {
    textPointer = undefined; finish(null, false); finishNoteDrag(null, false); finishNoteResize(null, false);
  }, { signal });
  return { layout, dispose() {
    offSelection(); offTools?.(); offSession();
    finish(null, false);
    finishNoteDrag(null, false);
    finishNoteResize(null, false);
    for (const view of stickyViews.values()) closeNote(view);
    lifetime.abort(); layer.remove();
  } };
}

const svgNS = 'http://www.w3.org/2000/svg';
const palette = [
  ['#f4b740', '黄', 'Yellow'], ['#e8482f', '红', 'Red'], ['#3aa66e', '绿', 'Green'],
  ['#4a8fe0', '蓝', 'Blue'], ['#9b6dd6', '紫', 'Purple'], ['#e15fd0', '洋红', 'Magenta'],
  ['#ef8a3c', '橙', 'Orange'], ['#9aa0a6', '灰', 'Gray'], ['#1a1a1a', '墨', 'Ink'],
];
const modes = [
  ['highlight', '划词高亮', 'Highlight text'], ['underline', '下划线', 'Underline'],
  ['pen', '钢笔', 'Pen'], ['highlighter', '荧光笔', 'Highlighter'], ['box', '框选', 'Box'],
  ['note', '便签', 'Sticky note'], ['eraser', '橡皮', 'Eraser'],
];
const drawModes = new Set(['pen', 'highlighter', 'box', 'eraser', 'note']);
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

function selectionQuads(range, textLayer, toPdf) {
  const quads = [], walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const caret = document.createRange();
  const layerTransform = getComputedStyle(textLayer).transform;
  const view = new DOMMatrixReadOnly(layerTransform === 'none' ? undefined : layerTransform);
  for (let node = walker.nextNode(); node && quads.length < 4096; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const from = range.startContainer === node ? range.startOffset : 0;
    const to = range.endContainer === node ? range.endOffset : node.length;
    if (from >= to) continue;
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
      return toPdf(rect.x + rect.width / 2 - b * half, rect.y + rect.height / 2 + a * half);
    }
    quads.push([edge(start, -1), edge(end, -1), edge(end, 1), edge(start, 1)]);
  }
  return quads;
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
  for (const quad of record.quads || [record.quad]) {
    const points = quad.map(point => viewport.convertToViewportPoint(...point));
    if (record.kind === 'underline') {
      const [end, start] = points.slice(2);
      group.append(shape('path', { d: smooth([start, end]), fill: 'none', stroke: record.color, 'stroke-width': 1.8 }));
    } else {
      const attributes = { points: points.map(point => point.join(',')).join(' ') };
      if (record.kind === 'box') Object.assign(attributes, { fill: 'none', stroke: record.color, 'stroke-width': 2 });
      else Object.assign(attributes, { fill: record.color, opacity: .34 });
      group.append(shape('polygon', attributes));
    }
  }
}

export function createAnnotationTools({ copy, button, current, confirmReload, signal }) {
  const toggle = button(copy('批注', 'Annotate'), () => changeOpen(!open));
  toggle.setAttribute('aria-expanded', 'false');
  const bar = html('div', 'note-pdf-annotation-tools');
  bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', copy('PDF 批注工具', 'PDF annotation tools'));
  const status = html('div', 'note-pdf-annotation-status');
  status.setAttribute('role', 'status');
  const message = html('span');
  const listeners = new Set();
  let open = false, tool = '', selected = '', session, unsubscribe, working = false, draft;
  function update(affected) {
    const error = session?.error;
    toggle.setAttribute('aria-expanded', String(open));
    bar.hidden = !open;
    const enabled = session?.ready && !session.loading && !['pdf_changed', 'annotation_conflict', 'annotation_unreadable'].includes(error);
    buttons.forEach(([mode, control]) => {
      control.disabled = !enabled;
      control.setAttribute('aria-pressed', String(mode === tool));
    });
    undo.disabled = !enabled || !session?.canUndo; redo.disabled = !enabled || !session?.canRedo;
    remove.disabled = !enabled || !session?.get(selected);
    thickness.hidden = tool !== 'pen' && tool !== 'highlighter';
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
    message.textContent = error ? messages[error] || copy('批注暂时无法保存或读取。', 'Unable to save or read annotations.')
      : open && session?.loading ? copy('正在载入批注…', 'Loading annotations…')
        : session?.dirty ? copy('正在保存批注…', 'Saving annotations…') : '';
    status.hidden = !message.textContent;
    listeners.forEach(listener => listener(affected));
  }
  async function changeOpen(show) {
    settle();
    open = show; tool = ''; selected = '';
    update();
    if (show) await session?.load({ edit: true });
  }
  function select(id) { selected = id; update(); }
  function settle() { draft?.(); }
  const buttons = modes.map(([key, zh, en]) => [key, button(copy(zh, en), () => {
    settle(); tool = tool === key ? '' : key; selected = ''; update();
  }, 'note-pdf-annotation-tool')]);
  const colors = html('label', 'note-pdf-annotation-colors');
  const color = html('select');
  color.setAttribute('aria-label', copy('批注颜色', 'Annotation color'));
  color.append(...palette.map(([hex, zh, en]) => {
    const item = html('option', '', copy(zh, en)); item.value = hex; return item;
  }));
  colors.append(color);
  color.onchange = () => {
    settle();
    const record = session?.get(selected);
    if (record) session.commit(new Map([[selected, { ...record, color: color.value }]]));
    update();
  };
  const thickness = html('input', 'note-pdf-annotation-width');
  thickness.type = 'range'; thickness.min = 1; thickness.max = 5; thickness.step = 1; thickness.value = 2;
  thickness.title = copy('笔画粗细', 'Stroke width'); thickness.setAttribute('aria-label', thickness.title);
  const undo = button(copy('撤销批注', 'Undo annotation'), () => { settle(); session?.undo(); });
  const redo = button(copy('重做批注', 'Redo annotation'), () => { settle(); session?.redo(); });
  undo.textContent = '↶'; redo.textContent = '↷';
  const remove = button(copy('删除选中批注', 'Delete selected annotation'), () => {
    settle();
    if (selected) session?.commit(new Map([[selected, null]]));
    select('');
  }, '', 'trash');
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
  bar.append(...buttons.map(([, control]) => control), colors, thickness, undo, redo, remove);
  status.append(message, retry);
  window.addEventListener('keydown', event => {
    if (!current() || !open || event.defaultPrevented || event.isComposing || editable(event.target)
        || event.target?.closest?.('[role="dialog"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      event.preventDefault(); event.stopPropagation(); void changeOpen(false); toggle.focus();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[zy]$/.test(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'y' || event.shiftKey) { if (!redo.disabled) redo.click(); }
      else if (!undo.disabled) undo.click();
    } else if (key === 'delete' && !remove.disabled) {
      event.preventDefault(); event.stopPropagation(); remove.click();
    }
  }, { signal, capture: true });
  update();
  return {
    toggle, bar, status, settle, select,
    attach(value) {
      settle(); unsubscribe?.(); session = value;
      unsubscribe = session?.subscribe(update);
      if (open && session) void session.load({ edit: true });
      update();
    },
    reset() { void changeOpen(false); this.attach(null); },
    get active() { return open && session?.ready && !session.loading && !['annotation_conflict', 'pdf_changed', 'annotation_unreadable'].includes(session.error); },
    get mode() { return this.active ? tool : ''; },
    get color() { return color.value; },
    get width() { return Number(thickness.value); },
    get selected() { return selected; },
    setDraft(commit) { settle(); draft = commit; },
    clearDraft(commit) { if (draft === commit) draft = null; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function mountAnnotationPage(host, page, viewport, session, tools, copy, button) {
  const lifetime = new AbortController(), { signal } = lifetime;
  const layer = html('div', 'note-pdf-annotations');
  const vector = shape('svg', { viewBox: '0 0 ' + viewport.width + ' ' + viewport.height, 'aria-hidden': 'true' });
  const saved = shape('g', {}), preview = shape('g', { 'pointer-events': 'none' });
  const notes = html('div', 'note-pdf-sticky-layer');
  vector.append(saved, preview); layer.append(vector, notes); host.append(layer);
  let gesture, frame, notePopup, commitDraft, textPointer;

  function hideNote() {
    commitDraft?.();
    notePopup?.remove();
    notePopup = null;
  }

  function openNote(record, editing) {
    hideNote();
    if (editing) tools.select(record.id);
    const popup = notePopup = html('div', 'note-pdf-sticky');
    popup.setAttribute('aria-label', copy('PDF 便签', 'PDF sticky note'));
    const [x, y] = viewport.convertToViewportPoint(...record.point);
    popup.style.setProperty('--pdf-annotation-color', record.color);
    const label = copy('关闭便签', 'Close note');
    const done = button(label, () => hideNote(), '', 'x');
    if (!editing) {
      popup.append(done, html('p', '', record.text));
    } else {
      const input = html('textarea');
      input.value = record.text; input.maxLength = 64_000;
      input.setAttribute('aria-label', copy('便签内容', 'Sticky note text'));
      const group = Symbol('sticky note input');
      const updateText = () => {
        const previous = session.get(record.id);
        if (previous && input.value !== previous.text) session.commit(new Map([[record.id, { ...previous, text: input.value }]]), group);
      };
      input.oninput = event => { if (!event.isComposing) updateText(); };
      input.oncompositionend = updateText;
      commitDraft = () => {
        tools.clearDraft(commitDraft);
        commitDraft = null;
        input.blur();
        updateText();
        popup.remove();
        if (notePopup === popup) notePopup = null;
      };
      tools.setDraft(commitDraft);
      popup.append(done, input);
      input.onkeydown = event => {
        if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); hideNote(); }
      };
      queueMicrotask(() => { if (popup.isConnected) input.focus({ preventScroll: true }); });
    }
    layer.append(popup);
    const view = host.closest('.note-pdf-scroll').getBoundingClientRect();
    const paper = host.getBoundingClientRect();
    const place = (pin, start, end, size, pageSize) => {
      const available = Math.max(0, pageSize - size);
      const min = clamp(start, available);
      const max = Math.max(min, clamp(end - size, available));
      const position = pin + 10 <= max ? pin + 10 : pin - 10 - size;
      return Math.max(min, Math.min(max, position)) + 'px';
    };
    popup.style.left = place(x, view.left - paper.left + 4, view.right - paper.left - 4, popup.offsetWidth, host.clientWidth);
    popup.style.top = place(y, view.top - paper.top + 4, view.bottom - paper.top - 4, popup.offsetHeight, host.clientHeight);
  }

  function render(affected) {
    if (affected && !affected.has(page)) return;
    saved.replaceChildren(); notes.replaceChildren();
    const mode = tools?.mode || '';
    layer.dataset.tool = mode;
    layer.classList.toggle('is-drawing', drawModes.has(mode));
    layer.classList.toggle('is-selecting', !!tools?.active && !mode);
    for (const record of session.onPage(page)) {
      if (record.kind === 'note') {
        const pin = button(copy('查看便签', 'Open sticky note'), () => {
          if (!drawModes.has(tools?.mode) || tools.mode === 'note') openNote(record, !!tools?.active);
        }, 'note-pdf-sticky-pin', 'file-text');
        const [x, y] = viewport.convertToViewportPoint(...record.point);
        pin.style.left = x + 'px'; pin.style.top = y + 'px';
        pin.style.setProperty('--pdf-annotation-color', record.color);
        pin.dataset.annotationId = record.id;
        notes.append(pin);
      } else {
        const group = shape('g', {});
        group.dataset.annotationId = record.id;
        draw(record, viewport, group);
        saved.append(group);
      }
    }
    for (const item of layer.querySelectorAll('[data-annotation-id]')) {
      item.classList.toggle('is-selected', item.dataset.annotationId === tools?.selected);
    }
  }
  const offSession = tools ? () => {} : session.subscribe(render);
  const offTools = tools?.subscribe(render);
  render();
  if (!tools) return () => { offSession(); layer.remove(); };

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
  function commit(record) { return session.commit(new Map([[record.id, record]])); }
  function ownsText(node) {
    const textLayer = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('.note-pdf-text');
    return textLayer?.parentElement === host;
  }
  host.addEventListener('pointerdown', event => {
    if (event.button === 0 && ownsText(event.target) && /^(highlight|underline)$/.test(tools.mode)) textPointer = event.pointerId;
    if (!layer.contains(event.target)) hideNote();
  }, { signal });
  window.addEventListener('pointerup', event => {
    if (textPointer !== event.pointerId) return;
    textPointer = undefined;
    const kind = tools.mode;
    if (!/^(highlight|underline)$/.test(kind)) return;
    requestAnimationFrame(() => {
      if (signal.aborted || tools.mode !== kind) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !ownsText(selection.anchorNode) || !ownsText(selection.focusNode)) return;
      const bounds = host.getBoundingClientRect();
      const quads = selectionQuads(selection.getRangeAt(0), host.querySelector('.note-pdf-text'),
        (x, y) => fromClient(x, y, bounds));
      if (!quads.length) return;
      if (commit({ ...fresh(kind), quads, text: selection.toString().slice(0, 64_000) })) selection.removeAllRanges();
    });
  }, { signal });
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
    if (event.target.closest('.note-pdf-sticky')) return;
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    const kind = tools.mode;
    if (!drawModes.has(kind)) {
      if (tools.active && vector.contains(event.target)) tools.select(event.target.closest('[data-annotation-id]')?.dataset.annotationId || '');
      return;
    }
    event.preventDefault();
    hideNote(); tools.settle();
    if (kind === 'note') {
      const record = { ...fresh(kind), point: fromClient(event.clientX, event.clientY), text: '' };
      if (commit(record)) openNote(record, true);
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
  window.addEventListener('blur', () => { textPointer = undefined; finish(null, false); }, { signal });
  return () => {
    hideNote();
    finish(null, false);
    lifetime.abort(); offTools?.(); offSession(); layer.remove();
  };
}

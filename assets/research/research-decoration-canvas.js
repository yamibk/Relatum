import { DecorationIndex, decorationBounds, hitDecoration, intersects, linePoint,
  quantizeWithSnap, replacementWithSnap, SYMBOL_TYPES } from './research-orthogonal.js';
import { defaultSymbol, symbolGeometry, symbolAngle, symbolColor, symbolTextMetrics, setSymbolTextMeasurer } from './research-symbols.js';
import { createDecorationPresetStore } from './research-decoration-presets.js';

const DEFAULTS = Object.freeze({ symbol: 'rectangle', arrowhead: 'none', lineStyle: 'solid',
  color: 'mono', unitLength: 40, width: 2, presetId: '', endpointDiameter: 4 });
const KEY = 'research:decorationTools:v1';
const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDecorationCanvas(options) {
  const { viewport, screenToWorld, eventPoint, getCamera, scheduleDraw, onSelectionChange } = options;
  const canvas = document.createElement('canvas');
  canvas.className = 'research-decorations'; canvas.dataset.researchDecorations = '';
  canvas.setAttribute('aria-hidden', 'true'); viewport.appendChild(canvas);
  const context = canvas.getContext('2d');
  const measureContext = document.createElement('canvas').getContext('2d');
  setSymbolTextMeasurer((text, size) => {
    measureContext.font = `${size}px ui-sans-serif, system-ui`;
    const m = measureContext.measureText(text);
    return { width: m.width, ascent: m.actualBoundingBoxAscent ?? size * .8, descent: m.actualBoundingBoxDescent ?? size * .2 };
  });
  const presets = createDecorationPresetStore(), pathCache = new Map();
  const lines = document.createElement('canvas'), lineContext = lines.getContext('2d');
  let model = options.model, index = new DecorationIndex(model.decorations());
  let enabled = false, selected = new Set(), gesture = null, snap = null, lastPointer = null;
  let presses = [], tools = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (SYMBOL_TYPES.includes(saved.symbol)) tools.symbol = saved.symbol;
    if (['none', 'end'].includes(saved.arrowhead)) tools.arrowhead = saved.arrowhead;
    if (['solid', 'dashed'].includes(saved.lineStyle)) tools.lineStyle = saved.lineStyle;
    if (['mono', 'blue', 'red', 'green'].includes(saved.color)) tools.color = saved.color;
    if (Number.isFinite(saved.unitLength) && saved.unitLength >= 16 && saved.unitLength <= 160) tools.unitLength = saved.unitLength;
    if (Number.isFinite(saved.width) && saved.width >= 1 && saved.width <= 6) tools.width = saved.width;
    if (presets.find(saved.presetId)) tools.presetId = saved.presetId;
    else if (saved.presetId) tools.symbol = 'rectangle';
    if (Number.isFinite(saved.endpointDiameter) && saved.endpointDiameter >= 2 && saved.endpointDiameter <= 5.5) tools.endpointDiameter = saved.endpointDiameter;
  } catch (_error) {}

  const world = (event) => screenToWorld(eventPoint(event));
  function selection() {
    return { nodeIds: [], edgeIds: [], decorationIds: [...selected],
      primaryDecoration: selected.size === 1 ? model.decoration([...selected][0]) : null };
  }
  function notify() { scheduleDraw(); if (onSelectionChange) onSelectionChange(selection()); }
  function setTools(patch) {
    tools = { ...tools, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(tools)); } catch (_error) {}
    scheduleDraw();
    return { ...tools };
  }
  function cancel() {
    if (gesture) {
      const previous = gesture; gesture = null;
      if (viewport.hasPointerCapture(previous.pointerId)) viewport.releasePointerCapture(previous.pointerId);
      if (previous.moved && previous.before) model.restore(previous.before, true);
    }
    snap = null; presses = []; scheduleDraw();
  }
  function clear() { selected.clear(); notify(); }
  function modelChanged(change) {
    if (!change.decorationsOnly && !change.topology) return;
    index.rebuild(model.decorations());
    selected = new Set([...selected].filter((id) => model.decoration(id)));
    if (enabled && !change.live) notify();
    scheduleDraw();
  }
  function setModel(next) { cancel(); model = next; index.rebuild(model.decorations()); selected.clear(); presses = []; }
  function setEnabled(next) {
    cancel(); enabled = !!next; selected.clear();
    viewport.dataset.researchEditorMode = enabled ? 'orthogonal' : 'default';
    scheduleDraw();
  }
  function nearest(point, exclude = new Set()) {
    return index.nearestEndpoint(point, 12 / getCamera().scale, exclude);
  }
  function hit(point) {
    const tolerance = 6 / getCamera().scale;
    const candidates = index.query({ left: point.x - tolerance, right: point.x + tolerance,
      top: point.y - tolerance, bottom: point.y + tolerance });
    // Symbols are painted above every line.
    return candidates.reverse().find((d) => d.kind === 'symbol' && hitDecoration(d, point, tolerance))
      || candidates.find((d) => d.kind === 'line' && hitDecoration(d, point, tolerance));
  }
  function pointerDown(event) {
    if (!enabled) return false;
    event.preventDefault();
    const point = world(event); lastPointer = point;
    const object = hit(point);
    presses.push({ kind: object && object.kind === 'symbol' ? 'symbol' : 'blank', at: performance.now() });
    if (presses.length > 2) presses.shift();
    if (event.altKey) {
      if (object && object.kind === 'symbol') return true;
      snap = nearest(point);
      const start = snap || point;
      gesture = { type: 'create', pointerId: event.pointerId, start, startSnapped: !!snap, preview: null, style: { ...tools } };
    } else {
      let handle = null;
      if (selected.size === 1) {
        const current = model.decoration([...selected][0]);
        if (current && current.kind === 'line') {
          const radius = 9 / getCamera().scale;
          if (Math.hypot(point.x - current.x, point.y - current.y) <= radius) handle = { current, start: true };
          else { const end = linePoint(current); if (Math.hypot(point.x - end.x, point.y - end.y) <= radius) handle = { current, start: false }; }
        }
      }
      if (handle && !event.shiftKey) {
        gesture = { type: 'resize', pointerId: event.pointerId, before: model.capture(),
          object: clone(handle.current), fixed: handle.start ? linePoint(handle.current) : { x: handle.current.x, y: handle.current.y },
          reverse: handle.start, moved: false, press: eventPoint(event) };
      } else if (object) {
        if (event.shiftKey) {
          if (selected.has(object.id)) { selected.delete(object.id); notify(); return true; }
          selected.add(object.id);
        } else if (!selected.has(object.id)) selected = new Set([object.id]);
        notify();
        gesture = { type: 'move', pointerId: event.pointerId, start: point, press: eventPoint(event),
          before: model.capture(), objects: [...selected].map((id) => clone(model.decoration(id))),
          anchorId: object.id, moved: false };
      } else {
        const baseline = event.shiftKey ? new Set(selected) : new Set();
        selected = new Set(baseline); notify();
        gesture = { type: 'box', pointerId: event.pointerId, start: point, current: point, baseline };
      }
    }
    viewport.setPointerCapture(event.pointerId); scheduleDraw(); return true;
  }
  function pointerMove(event) {
    if (!enabled) return false;
    lastPointer = world(event);
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    const point = lastPointer, scale = getCamera().scale;
    if (gesture.type === 'create') {
      // Restyling an existing span keeps its unit grid, even if the default for
      // newly drawn lines has changed since that span was created.
      const next = gesture.startSnapped && replacementWithSnap(gesture.start, point, index, scale)
        || quantizeWithSnap(gesture.start, point, gesture.style.unitLength, index, scale);
      snap = next.snap; gesture.endSnapped = !!snap; gesture.preview = { ...gesture.style, ...next.line, kind: 'line' };
    } else if (gesture.type === 'resize') {
      const next = quantizeWithSnap(gesture.fixed, point, gesture.object.unitLength, index, scale, selected);
      snap = next.snap;
      if (!next.line.units) return true;
      if (Math.hypot(eventPoint(event).x - gesture.press.x, eventPoint(event).y - gesture.press.y) < 4 && !gesture.moved) return true;
      gesture.moved = true;
      const patch = gesture.reverse ? { ...next.line, ...linePoint(next.line), direction: (next.line.direction + 4) % 8 } : next.line;
      model.updateDecorations({ [gesture.object.id]: patch }, { live: true });
    } else if (gesture.type === 'move') {
      if (Math.hypot(eventPoint(event).x - gesture.press.x, eventPoint(event).y - gesture.press.y) < 4 && !gesture.moved) return true;
      gesture.moved = true;
      let dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      const anchor = gesture.objects.find((d) => d.id === gesture.anchorId);
      snap = nearest({ x: anchor.x + dx, y: anchor.y + dy }, selected);
      if (snap) { dx = snap.x - anchor.x; dy = snap.y - anchor.y; }
      const patches = {};
      gesture.objects.forEach((d) => { patches[d.id] = { x: d.x + dx, y: d.y + dy }; });
      model.updateDecorations(patches, { live: true });
    } else {
      gesture.current = point;
      const b = { left: Math.min(point.x, gesture.start.x), right: Math.max(point.x, gesture.start.x),
        top: Math.min(point.y, gesture.start.y), bottom: Math.max(point.y, gesture.start.y) };
      selected = new Set(gesture.baseline);
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) * scale >= 4)
        index.query(b).forEach((d) => { if (intersects(decorationBounds(d), b)) selected.add(d.id); });
    }
    scheduleDraw(); return true;
  }
  function pointerUp(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    pointerMove(event);
    const previous = gesture; gesture = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (previous.type === 'create' && previous.preview && previous.preview.units > 0) {
      const created = previous.startSnapped && previous.endSnapped
        ? model.replaceDecorationSpan(previous.preview) : model.createDecoration(previous.preview);
      if (created) selected = new Set([created.id]);
    } else if (previous.moved && previous.before) model.commitFrom(previous.before, { kind: 'decoration-edit', decorationsOnly: true });
    snap = null; notify(); return true;
  }
  function doubleClick(event) {
    if (!enabled) return false;
    event.preventDefault();
    const object = hit(world(event));
    if (object && object.kind === 'symbol') {
      selected = new Set([object.id]); notify();
      if (options.onEditLabel) options.onEditLabel(); return true;
    }
    if (event.detail !== 0 && (presses.length !== 2 || !presses.every((p) => p.kind === 'blank')
      || presses[1].at - presses[0].at > 650)) return true;
    const point = world(event), center = nearest(point) || point;
    const created = model.createDecoration({ ...getSymbolTemplate(), kind: 'symbol', ...center });
    if (created) selected = new Set([created.id]); notify(); return true;
  }
  function duplicate() {
    const objects = [...selected].map((id) => model.decoration(id)).filter(Boolean);
    if (!objects.length) return null;
    cancel();
    const left = objects.reduce((value, d) => Math.min(value, decorationBounds(d).left), Infinity);
    const top = objects.reduce((value, d) => Math.min(value, decorationBounds(d).top), Infinity);
    selected = new Set(model.duplicateDecorations(selected, lastPointer ? lastPointer.x - left : 28,
      lastPointer ? lastPointer.y - top : 28)); notify(); return selection();
  }
  function keyDown(event) {
    if (!enabled) return false;
    const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (modifier && ['z', 'y', 'd', 'a'].includes(key)) {
      event.preventDefault(); cancel();
      if (key === 'z') event.shiftKey ? model.redo() : model.undo();
      else if (key === 'y') model.redo();
      else if (key === 'd') duplicate();
      else { selected = new Set(model.decorations().map((d) => d.id)); notify(); }
      return true;
    }
    if (event.key === 'Escape') { event.preventDefault(); if (gesture) cancel(); else clear(); return true; }
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); cancel(); model.removeDecorations(selected); clear(); return true; }
    if (event.key === 'F2' || event.key === 'Enter') {
      event.preventDefault(); if (selected.size === 1 && options.onEditLabel) options.onEditLabel(); return true;
    }
    // Keep shared camera shortcuts; never fall through to default-mode creation.
    return !modifier && !['Alt', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd'].includes(event.key);
  }

  function getSymbolTemplate() { return presets.find(tools.presetId)?.template || defaultSymbol(tools.symbol); }
  function pathsFor(d) {
    const key = `${d.type}:${d.width}:${d.height}`;
    if (!pathCache.has(key)) {
      const g = symbolGeometry(d);
      if (pathCache.size >= 1024) pathCache.delete(pathCache.keys().next().value);
      pathCache.set(key, { ...g, mask: new Path2D(g.mask), paths: g.paths.map((path) => new Path2D(path)) });
    }
    return pathCache.get(key);
  }
  function symbolFrame(ctx, d, fn) {
    ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(symbolAngle(d)); fn(); ctx.restore();
  }
  function drawLine(ctx, d, ink, paper, visible) {
    const end = linePoint(d); ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = d.width;
    ctx.setLineDash(d.lineStyle === 'dashed' ? [6, 5] : []);
    ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(end.x, end.y); ctx.stroke(); ctx.setLineDash([]);
    const unit = linePoint(d, 1), dx = unit.x - d.x, dy = unit.y - d.y;
    let low = 0, high = d.units;
    if (dx) { low = Math.max(low, Math.min((visible.left - 8 - d.x) / dx, (visible.right + 8 - d.x) / dx));
      high = Math.min(high, Math.max((visible.left - 8 - d.x) / dx, (visible.right + 8 - d.x) / dx)); }
    if (dy) { low = Math.max(low, Math.min((visible.top - 8 - d.y) / dy, (visible.bottom + 8 - d.y) / dy));
      high = Math.min(high, Math.max((visible.top - 8 - d.y) / dy, (visible.bottom + 8 - d.y) / dy)); }
    ctx.lineWidth = 1; ctx.strokeStyle = paper;
    for (let i = Math.max(0, Math.ceil(low)); i <= Math.min(d.units, Math.floor(high)); i++) {
      const p = linePoint(d, i); ctx.beginPath(); ctx.arc(p.x, p.y, (tools.endpointDiameter - 1) / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (d.arrowhead === 'end') {
      const angle = Math.atan2(end.y - d.y, end.x - d.x);
      ctx.fillStyle = ink; ctx.beginPath(); ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - 11 * Math.cos(angle - .45), end.y - 11 * Math.sin(angle - .45));
      ctx.lineTo(end.x - 11 * Math.cos(angle + .45), end.y - 11 * Math.sin(angle + .45)); ctx.closePath(); ctx.fill();
    }
  }
  function drawSymbol(ctx, d, ink, dark) {
    const color = symbolColor(d.color || 'mono', ink, dark), geometry = pathsFor(d);
    symbolFrame(ctx, d, () => {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = d.strokeWidth ?? 2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      geometry.paths.forEach((path) => { if (geometry.filled) ctx.fill(path); else ctx.stroke(path); });
    });
    if (d.label) {
      const m = symbolTextMetrics(d);
      ctx.save();
      ctx.fillStyle = !d.labelColor || d.labelColor === 'inherit' ? color : symbolColor(d.labelColor, ink, dark);
      ctx.font = `${d.labelFontSize ?? 14}px ui-sans-serif, system-ui`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
      ctx.fillText(d.label, d.x + (d.labelOffsetX ?? 0), d.y - (d.labelOffsetY ?? 0) + (m.ascent - m.descent) / 2);
      ctx.restore();
    }
  }
  function draw() {
    const rect = viewport.getBoundingClientRect(), ratio = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.round(rect.width * ratio), h = Math.round(rect.height * ratio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = lines.width = w; canvas.height = lines.height = h; }
    const camera = getCamera();
    const visible = { left: -camera.x / camera.scale, top: -camera.y / camera.scale,
      right: (rect.width - camera.x) / camera.scale, bottom: (rect.height - camera.y) / camera.scale };
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue('--research-ink').trim() || '#202020';
    const paper = styles.getPropertyValue('--research-paper').trim() || '#fff';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const colors = { mono: ink, blue: dark ? '#87b6e8' : '#4279b0', red: dark ? '#ee9692' : '#b8524d', green: dark ? '#96c5a1' : '#648f6b' };
    [context, lineContext].forEach((ctx) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.setTransform(ratio * camera.scale, 0, 0, ratio * camera.scale, ratio * camera.x, ratio * camera.y);
    });
    const objects = index.query(visible), symbols = objects.filter((d) => d.kind === 'symbol');
    objects.forEach((d) => { if (d.kind === 'line') drawLine(lineContext, d, colors[d.color], paper, visible); });
    if (gesture && gesture.preview && gesture.preview.units) {
      lineContext.globalAlpha = .7; drawLine(lineContext, gesture.preview, colors[gesture.preview.color], paper, visible); lineContext.globalAlpha = 1;
    }
    lineContext.globalCompositeOperation = 'destination-out';
    symbols.forEach((d) => symbolFrame(lineContext, d, () => { lineContext.fill(pathsFor(d).mask); }));
    lineContext.globalCompositeOperation = 'source-over';
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(lines, 0, 0); context.restore();
    symbols.forEach((d) => drawSymbol(context, d, ink, dark));
    if (!enabled) return;
    context.strokeStyle = ink; context.lineWidth = 1 / camera.scale; context.setLineDash([4 / camera.scale, 3 / camera.scale]);
    objects.forEach((d) => {
      if (!selected.has(d.id)) return;
      const b = decorationBounds(d); context.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    });
    if (gesture && gesture.type === 'box') {
      const a = gesture.start, b = gesture.current; context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    context.setLineDash([]);
    if (selected.size === 1) {
      const d = model.decoration([...selected][0]);
      if (d && d.kind === 'line') [d, linePoint(d)].forEach((p) => {
        context.fillStyle = paper; context.beginPath(); context.arc(p.x, p.y, 6 / camera.scale, 0, Math.PI * 2); context.fill(); context.stroke();
      });
    }
    if (snap) { context.beginPath(); context.arc(snap.x, snap.y, 10 / camera.scale, 0, Math.PI * 2); context.stroke(); }
  }
  return { draw, pointerDown, pointerMove, pointerUp, doubleClick, keyDown, cancel,
    setModel, setEnabled, modelChanged, clear, duplicate, selection,
    getTools: () => ({ ...tools }), setTools,
    getSymbolTemplate, getPresetStore: () => presets,
    resetTools: () => setTools({ ...DEFAULTS }),
    isEnabled: () => enabled,
    dispose: () => { cancel(); canvas.remove(); },
  };
}

// Pure session/geometry helpers and one renderer for both preview and PNG.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelatumImageMarkupCore = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const LIMITS = Object.freeze({ bytes: 40 * 1024 * 1024, side: 16384, pixels: 64 * 1024 * 1024, history: 100 });
  const FONT = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const cloneObject = value => JSON.parse(JSON.stringify(value));
  const snapshot = scene => scene && { source: scene.source, crop: { ...scene.crop }, objects: cloneObject(scene.objects) };
  const initial = source => ({ source, crop: { x: 0, y: 0, w: source.width, h: source.height }, objects: [] });
  function createSession() {
    return { scene: null, past: [], future: [], settings: { tool: 'rect', color: '#ef4444', width: 4, size: 28, block: 16 }, view: null };
  }
  function commit(session, next) {
    const previous = session.scene;
    session.past.push(snapshot(previous));
    session.scene = snapshot(next); session.future = [];
    if (next && next.source !== previous?.source) {
      const old = previous || [...session.past].reverse().find(Boolean);
      const allowed = new Set([next.source.id, old?.source.id]);
      session.past = session.past.filter(scene => !scene || allowed.has(scene.source.id));
    }
    session.past = session.past.slice(-LIMITS.history);
    return session.scene;
  }
  function travel(session, redo = false) {
    const from = redo ? session.future : session.past, to = redo ? session.past : session.future;
    if (!from.length) return false;
    to.push(snapshot(session.scene)); session.scene = from.pop(); return true;
  }
  function dimensionsValid(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
      && width <= LIMITS.side && height <= LIMITS.side && width * height <= LIMITS.pixels;
  }
  // Bounded header inspection, following the existing notes image readers.
  function imageHeader(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer), length = bytes.length;
    const tag = (offset, value) => offset + value.length <= length && [...value].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
    const result = (media, width, height) => ({ media, width, height });
    if (length >= 24 && tag(0, '\x89PNG\r\n\x1a\n') && tag(12, 'IHDR')) return result('image/png', view.getUint32(16), view.getUint32(20));
    if (length >= 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) return result('image/gif', view.getUint16(6, true), view.getUint16(8, true));
    if (length >= 26 && tag(0, 'BM')) {
      const size = view.getUint32(14, true);
      if (size === 12) return result('image/bmp', view.getUint16(18, true), view.getUint16(20, true));
      if (size >= 40) return result('image/bmp', view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
    }
    if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
      for (let offset = 12; offset + 8 <= length;) {
        const size = view.getUint32(offset + 4, true), start = offset + 8;
        if (tag(offset, 'VP8X') && size >= 10 && start + 10 <= length) {
          const u24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
          return result('image/webp', 1 + u24(start + 4), 1 + u24(start + 7));
        }
        if (tag(offset, 'VP8L') && size >= 5 && start + 5 <= length && bytes[start] === 0x2f) {
          const bits = view.getUint32(start + 1, true);
          return result('image/webp', 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
        }
        if (tag(offset, 'VP8 ') && size >= 10 && start + 10 <= length && tag(start + 3, '\x9d\x01\x2a')) return result('image/webp', view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
        offset = start + size + (size & 1);
      }
    }
    if (tag(0, '\xff\xd8\xff')) {
      let offset = 2;
      while (offset < length && bytes[offset] === 0xff) {
        while (offset < length && bytes[offset] === 0xff) offset++;
        if (offset >= length) break;
        const marker = bytes[offset++];
        if ([0, 0xd9, 0xda].includes(marker)) break;
        if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue;
        if (offset + 2 > length) break;
        const size = view.getUint16(offset);
        if (size < 2 || offset + size > length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) return result('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
        offset += size;
      }
    }
    return null;
  }
  function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function intersect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
  }
  function cropRect(rect, source) {
    const box = intersect(rect, { x: 0, y: 0, w: source.width, h: source.height });
    const x = clamp(Math.floor(box.x), 0, source.width), y = clamp(Math.floor(box.y), 0, source.height);
    return { x, y, w: Math.max(0, Math.min(source.width - x, Math.ceil(box.x + box.w) - x)), h: Math.max(0, Math.min(source.height - y, Math.ceil(box.y + box.h) - y)) };
  }
  function bounds(object) {
    if (object.type === 'line' || object.type === 'arrow') return rectangle(object, { x: object.x2, y: object.y2 });
    if (object.type === 'pen') {
      let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
      for (const p of object.points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
      return { x, y, w: right - x, h: bottom - y };
    }
    return { x: object.x, y: object.y, w: object.w, h: object.h };
  }
  function moved(object, dx, dy) {
    const next = cloneObject(object);
    if (next.type === 'pen') next.points.forEach(p => { p.x += dx; p.y += dy; });
    else {
      next.x += dx; next.y += dy;
      if (next.type === 'line' || next.type === 'arrow') { next.x2 += dx; next.y2 += dy; }
    }
    return next;
  }
  function resized(object, box) {
    const before = bounds(object), next = cloneObject(object);
    const point = p => ({ x: box.x + (before.w ? (p.x - before.x) / before.w : .5) * box.w, y: box.y + (before.h ? (p.y - before.y) / before.h : .5) * box.h });
    if (next.type === 'pen') next.points = next.points.map(point);
    else if (next.type === 'line' || next.type === 'arrow') {
      const end = point({ x: next.x2, y: next.y2 }); Object.assign(next, point(next), { x2: end.x, y2: end.y });
    } else {
      Object.assign(next, box);
      if (next.type === 'text') next.size = Math.max(4, next.size * box.h / Math.max(1, before.h));
    }
    return next;
  }
  function distance(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1) : 0;
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
  }
  function arrowHead(object) {
    const angle = Math.atan2(object.y2 - object.y, object.x2 - object.x), length = Math.max(object.width * 3.5, 12);
    return [-.48, .48].map(delta => ({ x: object.x2 - length * Math.cos(angle + delta), y: object.y2 - length * Math.sin(angle + delta) }));
  }
  function hit(object, point, tolerance) {
    const radius = tolerance + (object.width || 0) / 2;
    if (object.type === 'line' || object.type === 'arrow') {
      const end = { x: object.x2, y: object.y2 };
      return distance(point, object, end) <= radius || object.type === 'arrow' && arrowHead(object).some(p => distance(point, end, p) <= radius);
    }
    if (object.type === 'pen') return object.points.some((p, i, points) => distance(point, p, points[Math.max(0, i - 1)]) <= radius);
    const b = bounds(object);
    if (object.type === 'ellipse') return ((point.x - b.x - b.w / 2) / (b.w / 2 + tolerance)) ** 2 + ((point.y - b.y - b.h / 2) / (b.h / 2 + tolerance)) ** 2 <= 1;
    return point.x >= b.x - tolerance && point.x <= b.x + b.w + tolerance && point.y >= b.y - tolerance && point.y <= b.y + b.h + tolerance;
  }
  function pick(objects, point, tolerance) { for (let i = objects.length - 1; i >= 0; i--) if (hit(objects[i], point, tolerance)) return objects[i]; return null; }
  function textLines(context, object) {
    context.font = object.size + 'px ' + FONT;
    const lines = [];
    for (const paragraph of object.text.split('\n')) {
      let line = '';
      for (const c of paragraph) {
        if (line && context.measureText(line + c).width > object.w) { lines.push(line); line = ''; }
        line += c;
      }
      lines.push(line);
    }
    return lines;
  }
  function drawObject(context, object) {
    context.save(); context.strokeStyle = context.fillStyle = object.color; context.lineWidth = object.width;
    context.lineCap = context.lineJoin = 'round'; context.beginPath();
    if (object.type === 'rect') context.rect(object.x, object.y, object.w, object.h);
    else if (object.type === 'ellipse') context.ellipse(object.x + object.w / 2, object.y + object.h / 2, object.w / 2, object.h / 2, 0, 0, Math.PI * 2);
    else if (object.type === 'line' || object.type === 'arrow') {
      context.moveTo(object.x, object.y); context.lineTo(object.x2, object.y2);
      if (object.type === 'arrow') for (const p of arrowHead(object)) { context.moveTo(object.x2, object.y2); context.lineTo(p.x, p.y); }
    } else if (object.type === 'pen') {
      const points = object.points; context.moveTo(points[0].x, points[0].y);
      if (points.length === 1) context.lineTo(points[0].x + .01, points[0].y);
      else for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
    } else if (object.type === 'text') {
      context.beginPath(); context.rect(object.x, object.y, object.w, object.h); context.clip();
      context.textBaseline = 'top';
      textLines(context, object).forEach((line, i) => context.fillText(line, object.x, object.y + i * object.size * 1.35));
      context.restore(); return;
    }
    context.stroke(); context.restore();
  }
  function clearCache(cache) { if (cache) { cache.forEach(canvas => { canvas.width = canvas.height = 0; }); cache.clear(); } }
  function render(context, scene, source, options = {}) {
    const factory = options.createCanvas || (() => document.createElement('canvas')), cache = options.cache, used = new Set();
    context.save(); context.beginPath(); context.rect(scene.crop.x, scene.crop.y, scene.crop.w, scene.crop.h); context.clip();
    context.drawImage(source, 0, 0);
    // Pixelate the source first, so later labels remain legible over redacted areas.
    for (const object of scene.objects) {
      if (object.type !== 'mosaic') continue;
      const b = intersect(bounds(object), { x: 0, y: 0, w: scene.source.width, h: scene.source.height });
      if (!b.w || !b.h) continue;
      const key = [scene.source.id, b.x, b.y, b.w, b.h, object.block].join(':'); used.add(key);
      let small = cache?.get(key);
      if (!small) {
        small = factory(); small.width = Math.max(1, Math.ceil(b.w / object.block)); small.height = Math.max(1, Math.ceil(b.h / object.block));
        const drawing = small.getContext('2d'); drawing.drawImage(source, b.x, b.y, b.w, b.h, 0, 0, small.width, small.height);
        cache?.set(key, small);
      }
      context.save(); context.imageSmoothingEnabled = false; context.drawImage(small, 0, 0, small.width, small.height, b.x, b.y, b.w, b.h); context.restore();
      if (!cache) small.width = small.height = 0;
    }
    cache?.forEach((canvas, key) => { if (!used.has(key)) { canvas.width = canvas.height = 0; cache.delete(key); } });
    if (cache) {
      let bytes = 0; cache.forEach(canvas => { bytes += canvas.width * canvas.height * 4; });
      for (const [key, canvas] of cache) {
        if (bytes <= 8 * 1024 * 1024) break;
        bytes -= canvas.width * canvas.height * 4; canvas.width = canvas.height = 0; cache.delete(key);
      }
    }
    for (const object of scene.objects) if (object.type !== 'mosaic' && object.id !== options.skipText) drawObject(context, object);
    context.restore();
  }
  return Object.freeze({ LIMITS, FONT, clamp, cloneObject, snapshot, initial, createSession, commit, travel, dimensionsValid, imageHeader,
    rectangle, intersect, cropRect, bounds, moved, resized, distance, hit, pick, textLines, render, clearCache });
});

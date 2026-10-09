// Port of canvas.js sideOfExit/bezierBetween/smoothD and 512-unit edge grid.
// Independent fork: do not import CanvasModule or document-wide editor state.
(function () {
  'use strict';
  const GRID = 512;
  function exit(rect, target) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = target.x - cx, dy = target.y - cy;
    const hw = rect.w / 2, hh = rect.h / 2;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    if (!Number.isFinite(t)) return { x: cx, y: cy, nx: 1, ny: 0 };
    let x = cx + dx * t, y = cy + dy * t;
    const horizontal = Math.abs(x - cx) >= hw - .001;
    const nx = horizontal ? Math.sign(dx) : 0, ny = horizontal ? 0 : Math.sign(dy);
    const radius = Math.min(rect.r || 0, hw, hh);
    if (radius && Math.abs(x - cx) > hw - radius && Math.abs(y - cy) > hh - radius) {
      const cornerX = cx + Math.sign(dx) * (hw - radius), cornerY = cy + Math.sign(dy) * (hh - radius);
      const ox = cx - cornerX, oy = cy - cornerY;
      const a = dx * dx + dy * dy, b = 2 * (dx * ox + dy * oy), c = ox * ox + oy * oy - radius * radius;
      const disc = b * b - 4 * a * c;
      if (disc >= 0 && a) {
        const arcT = (-b + Math.sqrt(disc)) / (2 * a);
        const ax = cx + dx * arcT, ay = cy + dy * arcT;
        if (Math.sign(ax - cornerX) === Math.sign(dx) && Math.sign(ay - cornerY) === Math.sign(dy)) { x = ax; y = ay; }
      }
    }
    return { x, y, nx, ny };
  }
  function build(edge, source, target) {
    const bends = edge.waypoints || [];
    const s = exit(source, bends[0] || { x: target.x + target.w / 2, y: target.y + target.h / 2 });
    const t = exit(target, bends[bends.length - 1] || { x: source.x + source.w / 2, y: source.y + source.h / 2 });
    const points = [s, ...(edge.waypoints || []), t];
    let d = 'M ' + s.x + ' ' + s.y, midpoint;
    let controls = points;
    if (edge.curve === 'straight' || edge.curve === 'elbow') {
      points.slice(1).forEach(p => { d += ' L ' + p.x + ' ' + p.y; });
      const k = Math.floor((points.length - 1) / 2);
      midpoint = { x: (points[k].x + points[k + 1].x) / 2, y: (points[k].y + points[k + 1].y) / 2 };
    } else if (points.length === 2) {
      const dist = Math.hypot(target.x + target.w / 2 - source.x - source.w / 2,
        target.y + target.h / 2 - source.y - source.h / 2);
      const offset = Math.max(30, Math.min(dist * .4, 120));
      const c1 = { x: s.x + s.nx * offset, y: s.y + s.ny * offset };
      const c2 = { x: t.x + t.nx * offset, y: t.y + t.ny * offset };
      controls = [s, c1, c2, t];
      d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${t.x} ${t.y}`;
      midpoint = { x: .125 * s.x + .375 * c1.x + .375 * c2.x + .125 * t.x,
        y: .125 * s.y + .375 * c1.y + .375 * c2.y + .125 * t.y };
    } else {
      controls = [];
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
        const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
        controls.push(p1, c1, c2, p2);
        d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
      }
      const k = Math.floor((points.length - 1) / 2);
      const segment = controls.slice(k * 4, k * 4 + 4);
      midpoint = { x: .125 * segment[0].x + .375 * segment[1].x + .375 * segment[2].x + .125 * segment[3].x,
        y: .125 * segment[0].y + .375 * segment[1].y + .375 * segment[2].y + .125 * segment[3].y };
    }
    const bounds = { left: Math.min(...controls.map(p => p.x)), right: Math.max(...controls.map(p => p.x)),
      top: Math.min(...controls.map(p => p.y)), bottom: Math.max(...controls.map(p => p.y)) };
    const angle = Math.atan2(t.y - controls[controls.length - 2].y, t.x - controls[controls.length - 2].x);
    const size = 9;
    const arrow = [t, { x: t.x - Math.cos(angle - .45) * size, y: t.y - Math.sin(angle - .45) * size },
      { x: t.x - Math.cos(angle + .45) * size, y: t.y - Math.sin(angle + .45) * size }];
    return { d, path: typeof Path2D === 'function' ? new Path2D(d) : null, bounds, midpoint, arrow, points: controls };
  }
  class SpatialGrid {
    constructor() { this.buckets = new Map(); this.keys = new Map(); this.large = new Set(); }
    remove(id) {
      (this.keys.get(id) || []).forEach(key => { const bucket = this.buckets.get(key); bucket.delete(id); if (!bucket.size) this.buckets.delete(key); });
      this.keys.delete(id); this.large.delete(id);
    }
    insert(id, bounds) {
      this.remove(id);
      const x0 = Math.floor(bounds.left / GRID), x1 = Math.floor(bounds.right / GRID);
      const y0 = Math.floor(bounds.top / GRID), y1 = Math.floor(bounds.bottom / GRID);
      if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.large.add(id); return; }
      const keys = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x + ':' + y;
        if (!this.buckets.has(key)) this.buckets.set(key, new Set());
        this.buckets.get(key).add(id); keys.push(key);
      }
      this.keys.set(id, keys);
    }
    query(bounds) {
      const result = new Set(this.large);
      const x0 = Math.floor(bounds.left / GRID), x1 = Math.floor(bounds.right / GRID);
      const y0 = Math.floor(bounds.top / GRID), y1 = Math.floor(bounds.bottom / GRID);
      if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this.keys.forEach((_, id) => result.add(id)); return result; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const bucket = this.buckets.get(x + ':' + y); if (bucket) bucket.forEach(id => result.add(id));
      }
      return result;
    }
    clear() { this.buckets.clear(); this.keys.clear(); this.large.clear(); }
  }
  window.RelatumNoteCanvasGeometry = Object.freeze({ build, exit, SpatialGrid });
})();

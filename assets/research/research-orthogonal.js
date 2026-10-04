// Pure decoration geometry. Coordinates are world pixels, never simulation ports.
import { SYMBOL_TYPES, SYMBOL_STYLE_KEYS, validSymbolStyle, symbolAngle, symbolShapeBounds, symbolLabelBounds } from './research-symbols.js';
export { SYMBOL_TYPES } from './research-symbols.js';
export const LINE_COLORS = ['mono', 'blue', 'red', 'green'];
export const MAX_UNITS = 100000;
export const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const between = (n, a, b) => finite(n) && n >= a && n <= b;

export function normalizeDecorations(source = [], issues = [], path = 'decorations') {
  if (!Array.isArray(source)) {
    issues.push({ code: 'invalid-decorations', path, message: '装饰对象必须是数组' });
    return [];
  }
  if (source.length > 300000) {
    issues.push({ code: 'too-many-decorations', path, message: '装饰对象数量超过安全上限' });
    return [];
  }
  const ids = new Set();
  const result = [];
  source.forEach((d, index) => {
    let valid = d && typeof d === 'object' && typeof d.id === 'string' && d.id.length > 0
      && d.id.length <= 256 && !ids.has(d.id) && between(d.x, -1e9, 1e9) && between(d.y, -1e9, 1e9);
    if (valid && d.kind === 'line') {
      valid = Number.isInteger(d.direction) && between(d.direction, 0, 7)
        && Number.isInteger(d.units) && between(d.units, 1, MAX_UNITS)
        && between(d.unitLength, 16, 160) && between(d.width, 1, 6)
        && ['solid', 'dashed'].includes(d.lineStyle) && LINE_COLORS.includes(d.color)
        && ['none', 'end'].includes(d.arrowhead);
      if (valid) result.push({ id: d.id, kind: 'line', x: d.x, y: d.y, direction: d.direction,
        units: d.units, unitLength: d.unitLength, width: d.width, lineStyle: d.lineStyle,
        color: d.color, arrowhead: d.arrowhead });
    } else if (valid && d.kind === 'symbol') {
      valid = SYMBOL_TYPES.includes(d.type) && between(d.width, d.type === 'dot' ? 6 : 8, 640)
        && between(d.height, d.type === 'dot' ? 6 : 8, 640)
        && Number.isInteger(d.rotation) && between(d.rotation, 0, 7)
        && typeof d.label === 'string' && d.label.length <= 10000 && validSymbolStyle(d);
      if (valid) {
        const item = { id: d.id, kind: 'symbol', type: d.type, x: d.x, y: d.y,
          width: d.width, height: d.height, rotation: d.rotation, label: d.label };
        SYMBOL_STYLE_KEYS.forEach((key) => { if (d[key] !== undefined) item[key] = d[key]; }); result.push(item);
      }
    } else valid = false;
    if (!valid) issues.push({ code: 'invalid-decoration', path: `${path}[${index}]`, message: '装饰对象数据无效' });
    if (d && d.id) ids.add(d.id);
  });
  return result;
}

export function linePoint(line, index = line.units) {
  const [dx, dy] = DIRECTIONS[line.direction];
  return { x: line.x + dx * line.unitLength * index, y: line.y + dy * line.unitLength * index };
}

export function quantizeLine(start, target, unitLength) {
  const x = target.x - start.x, y = target.y - start.y;
  const direction = (Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8;
  const [dx, dy] = DIRECTIONS[direction];
  const units = Math.min(MAX_UNITS, Math.max(0, Math.round((x * dx + y * dy) / ((dx * dx + dy * dy) * unitLength))));
  return { x: start.x, y: start.y, direction, units, unitLength };
}

export function decorationBounds(d) {
  if (d.kind === 'line') {
    const end = linePoint(d), margin = 10;
    return { left: Math.min(d.x, end.x) - margin, top: Math.min(d.y, end.y) - margin,
      right: Math.max(d.x, end.x) + margin, bottom: Math.max(d.y, end.y) + margin };
  }
  const b = symbolShapeBounds(d);
  if (d.label) { const label = symbolLabelBounds(d);
    b.left = Math.min(b.left, label.left); b.right = Math.max(b.right, label.right);
    b.top = Math.min(b.top, label.top); b.bottom = Math.max(b.bottom, label.bottom); }
  return b;
}

export function intersects(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function hitDecoration(d, p, tolerance) {
  if (d.kind === 'line') {
    const end = linePoint(d), dx = end.x - d.x, dy = end.y - d.y;
    const t = Math.max(0, Math.min(1, ((p.x - d.x) * dx + (p.y - d.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - d.x - dx * t, p.y - d.y - dy * t) <= Math.max(tolerance, d.width / 2);
  }
  const angle = -symbolAngle(d), dx = p.x - d.x, dy = p.y - d.y;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle), y = dx * Math.sin(angle) + dy * Math.cos(angle);
  if (Math.abs(x) <= d.width / 2 + tolerance && Math.abs(y) <= d.height / 2 + tolerance) return true;
  const b = d.label ? symbolLabelBounds(d) : null;
  return !!b && p.x >= b.left - tolerance && p.x <= b.right + tolerance
    && p.y >= b.top - tolerance && p.y <= b.bottom + tolerance;
}

// Index object bounds, not every unit endpoint. Very long objects stay in a
// separate bucket so neither loading nor a zoomed-out camera allocates a huge grid.
export class DecorationIndex {
  constructor(objects = []) { this.rebuild(objects); }
  rebuild(objects) {
    this.objects = objects;
    this.grid = new Map(); this.large = new Set(); this.bounds = new Map(); this.order = new Map();
    objects.forEach((d, order) => {
      const b = decorationBounds(d); this.bounds.set(d.id, b); this.order.set(d.id, order);
      const x0 = Math.floor(b.left / 512), x1 = Math.floor(b.right / 512);
      const y0 = Math.floor(b.top / 512), y1 = Math.floor(b.bottom / 512);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { this.large.add(d); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x + ':' + y;
        if (!this.grid.has(key)) this.grid.set(key, new Set());
        this.grid.get(key).add(d);
      }
    });
  }
  query(b) {
    const found = new Set(this.large);
    const x0 = Math.floor(b.left / 512), x1 = Math.floor(b.right / 512);
    const y0 = Math.floor(b.top / 512), y1 = Math.floor(b.bottom / 512);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) this.objects.forEach((d) => found.add(d));
    else for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const cell = this.grid.get(x + ':' + y); if (cell) cell.forEach((d) => found.add(d));
    }
    return Array.from(found).filter((d) => intersects(this.bounds.get(d.id), b))
      .sort((a, c) => this.order.get(a.id) - this.order.get(c.id));
  }
  nearestEndpoint(p, radius, exclude = new Set(), compatible = null) {
    const candidates = this.query({ left: p.x - radius, right: p.x + radius, top: p.y - radius, bottom: p.y + radius });
    let best = null, distance = radius;
    candidates.forEach((d) => {
      if (d.kind !== 'line' || exclude.has(d.id)) return;
      const [dx, dy] = DIRECTIONS[d.direction];
      const t = ((p.x - d.x) * dx + (p.y - d.y) * dy) / (d.unitLength * (dx * dx + dy * dy));
      // Nearest few endpoints suffice; do not enumerate a long line.
      const nearest = Math.round(t), reach = Math.ceil(radius / d.unitLength) + 1;
      for (let i = Math.max(0, nearest - reach); i <= Math.min(d.units, nearest + reach); i++) {
        const point = linePoint(d, i), delta = Math.hypot(point.x - p.x, point.y - p.y);
        if (delta <= distance && (!compatible || compatible(point))) { best = point; distance = delta; }
      }
    });
    return best;
  }
}

export function quantizeWithSnap(start, target, unitLength, index, scale = 1, exclude = new Set()) {
  const snap = index.nearestEndpoint(target, 12 / scale, exclude, (point) => {
    const q = quantizeLine(start, point, unitLength);
    const end = linePoint(q);
    return q.units > 0 && Math.hypot(end.x - point.x, end.y - point.y) < .00001;
  });
  return { line: quantizeLine(start, snap || target, unitLength), snap };
}

// Replace only collinear spans bounded by existing unit endpoints. Crossings
// and uncovered tails keep their original appearance and direction.
export function cutLineSpan(original, replacement) {
  if (original.kind !== 'line') return null;
  const [dx, dy] = DIRECTIONS[original.direction];
  const end = linePoint(replacement);
  const step = original.unitLength, denominator = (dx * dx + dy * dy) * step;
  const offset = (p) => ((p.x - original.x) * dx + (p.y - original.y) * dy) / denominator;
  const onAxis = (p) => Math.abs((p.x - original.x) * dy - (p.y - original.y) * dx) < .00001;
  if (!onAxis(replacement) || !onAxis(end)) return null;
  const low = Math.max(0, Math.min(offset(replacement), offset(end)));
  const high = Math.min(original.units, Math.max(offset(replacement), offset(end)));
  if (high - low < .00001 || Math.abs(low - Math.round(low)) > .00001 || Math.abs(high - Math.round(high)) > .00001) return null;
  const first = Math.round(low), last = Math.round(high), tails = [];
  if (first > 0) tails.push({ ...original, units: first, arrowhead: 'none' });
  if (last < original.units) tails.push({ ...original, ...linePoint(original, last), units: original.units - last });
  return { tails, removed: { ...original, ...linePoint(original, first), units: last - first, arrowhead: 'none' } };
}

export function subtractLineSpan(original, replacement) {
  return cutLineSpan(original, replacement)?.tails ?? null;
}

export function replacementWithSnap(start, target, index, scale = 1) {
  const end = index.nearestEndpoint(target, 12 / scale);
  if (!end) return null;
  const bounds = { left: Math.min(start.x, end.x) - 1, right: Math.max(start.x, end.x) + 1,
    top: Math.min(start.y, end.y) - 1, bottom: Math.max(start.y, end.y) + 1 };
  for (const original of index.query(bounds)) {
    if (original.kind !== 'line') continue;
    const q = quantizeLine(start, end, original.unitLength), point = linePoint(q);
    if (q.units > 0 && Math.hypot(point.x - end.x, point.y - end.y) < .00001
      && subtractLineSpan(original, q) !== null) return { line: q, snap: end };
  }
  return null;
}

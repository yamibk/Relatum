// Shared, offline symbol geometry for Canvas and SVG. No ports or computation.
export const SYMBOL_LABELS = Object.freeze({ rectangle: '矩形／电阻', 'current-source': '电流源',
  'voltage-source': '电压源', lamp: '灯泡', dot: '圆点', capacitor: '电容', inductor: '电感',
  switch: '电路开关', ground: '接地', 'ac-voltage-source': '交流电压源', diode: '二极管',
  'op-amp': '运放', transformer: '变压器', 'controlled-voltage-source': '受控电压源',
  'controlled-current-source': '受控电流源' });
export const SYMBOL_TYPES = Object.freeze(Object.keys(SYMBOL_LABELS));
const SIZES = { rectangle: [32, 14], dot: [8, 8], capacitor: [32, 24], inductor: [40, 16],
  switch: [32, 16], ground: [24, 24], diode: [32, 24], 'op-amp': [40, 32], transformer: [40, 40] };
export const SYMBOL_STYLE_DEFAULTS = Object.freeze({ color: 'mono', strokeWidth: 2,
  labelColor: 'inherit', labelFontSize: 14, labelOffsetX: 0, labelOffsetY: 0 });
export function defaultSymbol(type = 'rectangle') {
  const [width, height] = SIZES[type] || [32, 32];
  return { type, width, height, rotation: 0, rotationDegrees: 0, label: '', ...SYMBOL_STYLE_DEFAULTS };
}
export function symbolTemplateDefaults(raw) {
  return { ...defaultSymbol(raw.type), ...raw, rotationDegrees: raw.rotationDegrees ?? (raw.rotation ?? 0) * 45 };
}
export const symbolAngle = (d) => (d.rotationDegrees ?? d.rotation * 45) * Math.PI / 180;
export const validSymbolColor = (value, inherit = false) =>
  ['mono', 'blue', 'red', 'green', ...(inherit ? ['inherit'] : [])].includes(value)
  || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value));
export function validSymbolStyle(d) {
  const number = (key, low, high) => d[key] === undefined ||
    (typeof d[key] === 'number' && Number.isFinite(d[key]) && d[key] >= low && d[key] <= high);
  return (d.color === undefined || validSymbolColor(d.color))
    && (d.labelColor === undefined || validSymbolColor(d.labelColor, true))
    && number('strokeWidth', 1, 6) && number('rotationDegrees', 0, 359.999999999)
    && number('labelFontSize', 8, 72) && number('labelOffsetX', -1e9, 1e9) && number('labelOffsetY', -1e9, 1e9);
}
export const SYMBOL_STYLE_KEYS = [...Object.keys(SYMBOL_STYLE_DEFAULTS), 'rotationDegrees'];
export function symbolColor(value, ink = 'currentColor', dark = false) {
  return ({ mono: ink, blue: dark ? '#87b6e8' : '#4279b0', red: dark ? '#ee9692' : '#b8524d',
    green: dark ? '#96c5a1' : '#648f6b' })[value] || value || ink;
}

// Browser installs a Canvas measureText adapter once; geometry tests use the
// conservative fallback. Measurements are reused across indexing and drawing.
let textMeasurer = null;
const textCache = new Map();
export function setSymbolTextMeasurer(measure) { textMeasurer = measure; textCache.clear(); }
export function symbolTextMetrics(d) {
  const size = d.labelFontSize ?? 14, key = size + ':' + d.label;
  if (!textCache.has(key)) {
    const metrics = textMeasurer ? textMeasurer(d.label, size) : { width: d.label.length * size * .7, ascent: size * .8, descent: size * .2 };
    if (textCache.size >= 2048) textCache.delete(textCache.keys().next().value);
    textCache.set(key, metrics);
  }
  return textCache.get(key);
}
export function symbolLabelBounds(d) {
  const m = symbolTextMetrics(d), x = d.x + (d.labelOffsetX ?? 0), y = d.y - (d.labelOffsetY ?? 0);
  return { left: x - m.width / 2, right: x + m.width / 2,
    top: y - (m.ascent + m.descent) / 2, bottom: y + (m.ascent + m.descent) / 2 };
}
export function symbolShapeBounds(d) {
  const angle = symbolAngle(d), pad = (d.strokeWidth ?? 2) / 2 + 1;
  const x = (Math.abs(Math.cos(angle)) * d.width + Math.abs(Math.sin(angle)) * d.height) / 2 + pad;
  const y = (Math.abs(Math.sin(angle)) * d.width + Math.abs(Math.cos(angle)) * d.height) / 2 + pad;
  return { left: d.x - x, right: d.x + x, top: d.y - y, bottom: d.y + y };
}

// Paths use actual world dimensions. Each body has an independent closed mask,
// so open symbols (capacitors, switches, coils) also erase underlying wire ink.
export function symbolGeometry(d) {
  const w = d.width, h = d.height;
  const point = (x, y) => `${x * w} ${y * h}`;
  const segment = (x1, y1, x2, y2) => `M${point(x1, y1)} L${point(x2, y2)} `;
  const rectangle = (x, y, width, height) => `M${point(x, y)} h${width * w} v${height * h} h${-width * w} Z`;
  const ellipse = (x = 0, y = 0, rx = .5, ry = .5) =>
    `M${point(x - rx, y)} a${rx * w} ${ry * h} 0 1 0 ${2 * rx * w} 0 a${rx * w} ${ry * h} 0 1 0 ${-2 * rx * w} 0 Z`;
  const plus = (x, y, size = .07) => segment(x - size, y, x + size, y) + segment(x, y - size, x, y + size);
  const diamond = `M${point(0, -.5)} L${point(.5, 0)} L${point(0, .5)} L${point(-.5, 0)} Z`;
  const circle = ellipse(), box = rectangle(-.5, -.5, 1, 1);
  let mask = circle, paths = [], filled = d.type === 'dot';
  switch (d.type) {
    case 'rectangle': mask = box; paths = [box]; break;
    case 'dot': paths = [circle]; break;
    case 'current-source': paths = [circle, segment(-.5, 0, .5, 0)]; break;
    case 'voltage-source': paths = [circle, plus(0, -.22, .1) + segment(-.1, .22, .1, .22)]; break;
    case 'lamp': paths = [circle, segment(-.35, -.35, .35, .35) + segment(.35, -.35, -.35, .35)]; break;
    case 'ac-voltage-source': paths = [circle, `M${point(-.32, 0)} C${point(-.2, -.36)} ${point(-.12, -.36)} ${point(0, 0)} C${point(.12, .36)} ${point(.2, .36)} ${point(.32, 0)}`]; break;
    case 'capacitor':
      mask = rectangle(-.15, -.5, .3, 1);
      paths = [segment(-.5, 0, -.1, 0) + segment(.1, 0, .5, 0) + segment(-.1, -.5, -.1, .5) + segment(.1, -.5, .1, .5)]; break;
    case 'inductor': {
      mask = rectangle(-.36, -.5, .72, 1);
      let coil = `M${point(-.5, 0)} L${point(-.35, 0)}`;
      for (let i = 0; i < 4; i++) { const x = -.35 + i * .175;
        coil += ` C${point(x, -.5)} ${point(x + .175, -.5)} ${point(x + .175, 0)}`; }
      paths = [coil + ` L${point(.5, 0)}`]; break;
    }
    case 'switch':
      mask = rectangle(-.36, -.5, .72, 1);
      paths = [segment(-.5, 0, -.3, 0) + segment(.3, 0, .5, 0) + segment(-.3, 0, .25, -.45),
        ellipse(-.3, 0, .035, .07) + ellipse(.3, 0, .035, .07)]; break;
    case 'ground': mask = box; paths = [segment(0, -.5, 0, 0) + segment(-.5, 0, .5, 0)
      + segment(-.3, .23, .3, .23) + segment(-.12, .46, .12, .46)]; break;
    case 'diode':
      mask = rectangle(-.26, -.5, .52, 1);
      paths = [`M${point(-.22, -.5)} L${point(.22, 0)} L${point(-.22, .5)} Z`,
        segment(.22, -.5, .22, .5) + segment(-.5, 0, -.22, 0) + segment(.22, 0, .5, 0)]; break;
    case 'op-amp':
      mask = `M${point(-.3, -.5)} L${point(.3, 0)} L${point(-.3, .5)} Z`;
      paths = [mask, segment(-.5, -.22, -.3, -.22) + segment(-.5, .22, -.3, .22)
        + segment(.3, 0, .5, 0) + segment(-.24, -.22, -.12, -.22) + plus(-.18, .22, .06)]; break;
    case 'transformer': {
      mask = rectangle(-.3, -.5, .6, 1);
      let coils = '';
      for (const sign of [-1, 1]) {
        coils += `M${point(sign * .5, -.4)} L${point(sign * .24, -.4)}`;
        for (let i = 0; i < 4; i++) { const y = -.4 + i * .2;
          coils += ` C${point(sign * .1, y)} ${point(sign * .1, y + .2)} ${point(sign * .24, y + .2)}`; }
        coils += ` L${point(sign * .5, .4)}`;
      }
      paths = [coils, segment(-.04, -.5, -.04, .5) + segment(.04, -.5, .04, .5)]; break;
    }
    case 'controlled-voltage-source': mask = diamond; paths = [diamond, plus(0, -.2) + segment(-.07, .2, .07, .2)]; break;
    case 'controlled-current-source': mask = diamond; paths = [diamond, segment(0, .25, 0, -.25)
      + segment(-.09, -.1, 0, -.25) + segment(.09, -.1, 0, -.25)]; break;
  }
  return { paths, mask, filled };
}

const escapeText = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function symbolSvgMarkup(template, dark = false) {
  const d = { ...symbolTemplateDefaults(template), x: 0, y: 0 };
  const geometry = symbolGeometry(d), b = symbolShapeBounds(d);
  if (d.label) { const label = symbolLabelBounds(d);
    b.left = Math.min(b.left, label.left); b.right = Math.max(b.right, label.right);
    b.top = Math.min(b.top, label.top); b.bottom = Math.max(b.bottom, label.bottom); }
  const ink = symbolColor(d.color, 'currentColor', dark), labelInk = d.labelColor === 'inherit' ? ink : symbolColor(d.labelColor, 'currentColor', dark);
  const paths = geometry.paths.map((p) => `<path d="${p}"/>`).join('');
  const m = d.label ? symbolTextMetrics(d) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.left - 4} ${b.top - 4} ${b.right - b.left + 8} ${b.bottom - b.top + 8}" aria-hidden="true"><g transform="rotate(${d.rotationDegrees})" stroke="${ink}" stroke-width="${d.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="${geometry.filled ? ink : 'none'}">${paths}</g>${d.label ? `<text x="${d.labelOffsetX}" y="${-d.labelOffsetY + (m.ascent - m.descent) / 2}" text-anchor="middle" fill="${labelInk}" font-size="${d.labelFontSize}" font-family="ui-sans-serif, system-ui">${escapeText(d.label)}</text>` : ''}</svg>`;
}

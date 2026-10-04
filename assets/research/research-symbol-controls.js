import { defaultSymbol, SYMBOL_LABELS, SYMBOL_TYPES, symbolSvgMarkup } from './research-symbols.js';

export function renderSymbolPreview(container, template) {
  container.innerHTML = symbolSvgMarkup(template, matchMedia('(prefers-color-scheme: dark)').matches);
}

// Live offsets and colors share the instance/preset preview path. Only a
// completed edit commits, so typing never creates a history entry per digit.
export function buildSymbolControls(container, template, options) {
  const { T, onChange, onPreview, onCancelPreview } = options;
  const state = { ...defaultSymbol(template.type), ...template };
  const text = (element, source) => { element.dataset.i18nSourceText = source; element.textContent = T(source); };
  const field = (parent, title, control, hint = '') => {
    const row = document.createElement('label'); row.className = 'research-decoration-field';
    const label = document.createElement('span'); text(label, title);
    if (hint) label.setAttribute('aria-description', T(hint));
    row.append(label, control); parent.appendChild(row); return row;
  };
  const group = (title) => {
    const section = document.createElement('section'); section.className = 'research-symbol-property-group';
    const heading = document.createElement('strong'); text(heading, title); section.appendChild(heading); container.appendChild(section); return section;
  };
  const pair = (parent) => { const row = document.createElement('div'); row.className = 'research-decoration-pair'; parent.appendChild(row); return row; };
  const commit = (patch) => { Object.assign(state, patch); onChange(patch); };
  function numeric(parent, title, key, low, high, step = 1, hint = '') {
    const input = document.createElement('input'); input.type = 'number'; input.min = low; input.max = high;
    input.step = key === 'rotationDegrees' ? step : 'any';
    input.value = state[key]; input.dataset.symbolField = key;
    const live = key === 'labelOffsetX' || key === 'labelOffsetY';
    let previewing = false, cancelling = false;
    const valid = () => input.value.trim() && Number.isFinite(Number(input.value)) && Number(input.value) >= low && Number(input.value) <= high;
    const cancel = () => {
      const hadPreview = previewing;
      previewing = false; input.value = state[key];
      // Restoring an instance can remove the focused control. Its blur/change
      // must not resubmit the cancelled value while the inspector rebuilds.
      cancelling = true;
      try { if (hadPreview && onCancelPreview) onCancelPreview(); }
      finally { cancelling = false; }
    };
    if (live) input.addEventListener('input', () => {
      if (valid() && onPreview) { previewing = true; onPreview({ [key]: Number(input.value) }, input); }
    });
    input.addEventListener('change', () => {
      if (cancelling) return;
      let value = Number(input.value);
      if (!valid()) { cancel(); return; }
      previewing = false;
      if (key === 'rotationDegrees') { value = (Math.round(value * 10) % 3600) / 10; commit({ rotationDegrees: value, rotation: Math.round(value / 45) % 8 }); }
      else commit({ [key]: value });
      input.value = value;
    });
    input.addEventListener('blur', () => { if (previewing) cancel(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && live && previewing) { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === 'Enter' && !event.isComposing && !options.inDialog) { event.preventDefault(); input.blur(); }
    });
    field(parent, title, input, hint); return input;
  }
  function color(parent, title, key, inherit = false) {
    const controls = document.createElement('div'); controls.className = 'research-decoration-color-control';
    const select = document.createElement('select'); select.dataset.symbolField = key;
    const names = { inherit: '跟随符号', mono: '黑白色', blue: '蓝色', red: '红色', green: '绿色', custom: '自定义颜色' };
    for (const value of [...(inherit ? ['inherit'] : []), 'mono', 'blue', 'red', 'green', 'custom']) {
      const option = document.createElement('option'); option.value = value; text(option, names[value]); select.appendChild(option);
    }
    const picker = document.createElement('input'); picker.type = 'color'; picker.dataset.symbolColor = key;
    picker.value = state[key]?.startsWith('#') ? state[key] : '#202020';
    picker.setAttribute('aria-label', T(title)); picker.dataset.i18nSourceAriaLabel = title;
    select.value = state[key]?.startsWith('#') ? 'custom' : state[key]; picker.hidden = select.value !== 'custom';
    select.addEventListener('change', () => { picker.hidden = select.value !== 'custom'; commit({ [key]: picker.hidden ? select.value : picker.value }); });
    picker.addEventListener('input', () => { if (onPreview) onPreview({ [key]: picker.value }, picker); });
    picker.addEventListener('change', () => commit({ [key]: picker.value }));
    const cancel = () => { if (onCancelPreview) onCancelPreview(); picker.value = state[key]?.startsWith('#') ? state[key] : '#202020'; };
    picker.addEventListener('blur', cancel);
    picker.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } });
    controls.append(select, picker); field(parent, title, controls);
  }
  const symbol = group('符号');
  if (options.allowType) {
    const select = document.createElement('select'); select.dataset.symbolField = 'type';
    SYMBOL_TYPES.forEach((type) => { const option = document.createElement('option'); option.value = type; text(option, SYMBOL_LABELS[type]); select.appendChild(option); });
    select.value = state.type;
    select.addEventListener('change', () => options.onTypeChange(select.value)); field(symbol, '类型', select);
  }
  const dimensions = pair(symbol);
  numeric(dimensions, '宽度', 'width', state.type === 'dot' ? 6 : 8, 640);
  numeric(dimensions, '高度', 'height', state.type === 'dot' ? 6 : 8, 640);
  const appearance = pair(symbol); color(appearance, '颜色', 'color'); numeric(appearance, '线宽', 'strokeWidth', 1, 6, .5);
  state.rotationDegrees = template.rotationDegrees ?? template.rotation * 45;
  const angle = pair(symbol);
  const input = numeric(angle, '旋转', 'rotationDegrees', 0, 360, .1, '正角度顺时针；文字保持正向。');
  const actions = document.createElement('div'); actions.className = 'research-rotation-actions';
  for (const delta of [-45, 45]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = `${delta > 0 ? '+' : '−'}45°`;
    button.addEventListener('click', () => { input.value = ((state.rotationDegrees + delta + 360) % 360); input.dispatchEvent(new Event('change')); }); actions.appendChild(button);
  }
  angle.appendChild(actions);
  const label = group('标注'), value = document.createElement('input'); value.type = 'text'; value.value = state.label; value.maxLength = 10000;
  value.dataset.researchDecorationLabel = ''; value.dataset.symbolField = 'label';
  value.addEventListener('change', () => commit({ label: value.value }));
  value.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing && !options.inDialog) { event.preventDefault(); value.blur(); } });
  field(label, '文字', value);
  const typography = pair(label); color(typography, '文字颜色', 'labelColor', true); numeric(typography, '字号', 'labelFontSize', 8, 72);
  const offsets = pair(label);
  const x = numeric(offsets, 'X 偏移', 'labelOffsetX', -1e9, 1e9, 1, '以符号中心为原点，X 向右为正。');
  const y = numeric(offsets, 'Y 偏移', 'labelOffsetY', -1e9, 1e9, 1, '以符号中心为原点，Y 向上为正。');
  const center = document.createElement('button'); center.type = 'button'; center.className = 'research-label-center'; text(center, '居中');
  center.addEventListener('click', () => { x.value = y.value = 0; commit({ labelOffsetX: 0, labelOffsetY: 0 }); }); label.appendChild(center);
}

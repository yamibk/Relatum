import { defaultSymbol, SYMBOL_LABELS, SYMBOL_TYPES, symbolSvgMarkup, symbolBounds } from './research-symbols.js';
import { createResearchLabelLayer } from './research-label-renderer.js';

const previews = new WeakMap();
export function disposeSymbolPreviews(root) {
  for (const container of [root, ...root.querySelectorAll('[data-research-symbol-preview]')]) {
    const preview = previews.get(container);
    if (preview) { preview.labels.dispose(); preview.observer.disconnect(); cancelAnimationFrame(preview.frame); previews.delete(container); }
  }
}
export function suspendSymbolPreviews(root) {
  for (const container of root.querySelectorAll('[data-research-symbol-preview]')) {
    const preview = previews.get(container);
    if (preview) { preview.labels.suspend(); preview.observer.disconnect(); cancelAnimationFrame(preview.frame); preview.frame = 0; }
  }
}

export function renderSymbolPreview(container, template) {
  let preview = previews.get(container);
  if (!preview) {
    container.dataset.researchSymbolPreview = '';
    const shape = document.createElement('div'); shape.className = 'research-symbol-preview-shape';
    shape.dataset.userContent = '';
    container.replaceChildren(shape);
    preview = { shape, frame: 0, template };
    const schedule = () => {
      if (!preview.frame) preview.frame = requestAnimationFrame(() => {
        preview.frame = 0; if (container.isConnected) draw();
      });
    };
    const draw = () => {
      const d = { ...defaultSymbol(preview.template.type), ...preview.template, x: 0, y: 0, id: 'preview' };
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      const b = symbolBounds(d);
      b.left -= 4; b.top -= 4; b.right += 4; b.bottom += 4;
      const markup = symbolSvgMarkup(d.labelMarkdown === false || !preview.labels.hasLabel('preview') ? d : { ...d, label: '' }, dark);
      if (preview.markup !== markup) { shape.innerHTML = markup; preview.markup = markup; }
      const w = b.right - b.left, h = b.bottom - b.top;
      shape.firstElementChild.setAttribute('viewBox', `${b.left} ${b.top} ${w} ${h}`);
      const width = container.clientWidth, height = container.clientHeight, scale = Math.min(width / w, height / h) || 1;
      preview.labels.sync(width > 0 && height > 0 && container.isConnected ? [d] : [], { scale, x: (width - w * scale) / 2 - b.left * scale,
        y: (height - h * scale) / 2 - b.top * scale }, dark);
    };
    preview.draw = draw;
    preview.labels = createResearchLabelLayer(container, { scheduleDraw: schedule, onMetricsChange: schedule });
    preview.observer = new ResizeObserver(schedule); preview.observer.observe(container);
    previews.set(container, preview);
  }
  preview.template = template; preview.observer.observe(container); preview.labels.activate(); preview.draw();
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
  const textOnly = state.type === 'text';
  const symbol = !textOnly || options.allowType ? group('符号') : null;
  if (options.allowType) {
    const select = document.createElement('select'); select.dataset.symbolField = 'type';
    SYMBOL_TYPES.forEach((type) => { const option = document.createElement('option'); option.value = type; text(option, SYMBOL_LABELS[type]); select.appendChild(option); });
    select.value = state.type;
    select.addEventListener('change', () => options.onTypeChange(select.value)); field(symbol, '类型', select);
  }
  if (!textOnly) {
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
  }
  const label = group('标注'), value = document.createElement('textarea'); value.rows = 3; value.value = state.label; value.maxLength = 10000;
  value.dataset.researchDecorationLabel = ''; value.dataset.symbolField = 'label';
  let composing = false, dirty = false, previewing = false, pendingCommit = false, lastPreview = state.label;
  const waiters = [];
  const previewLabel = () => {
    if (composing || value.value === lastPreview) return;
    lastPreview = value.value; previewing = true;
    onPreview?.({ label: value.value }, value);
  };
  const labelEditor = {
    isComposing: () => composing,
    commit() {
      if (composing) { pendingCommit = true; return new Promise((resolve) => waiters.push(resolve)); }
      if (dirty) { dirty = previewing = false; lastPreview = value.value; commit({ label: value.value }); }
      return Promise.resolve();
    },
    cancel() {
      const hadPreview = previewing; dirty = previewing = pendingCommit = false;
      value.value = lastPreview = state.label;
      if (hadPreview) onCancelPreview?.();
    },
  };
  value.addEventListener('compositionstart', () => { composing = true; });
  value.addEventListener('compositionend', () => {
    composing = false; dirty = true; previewLabel();
    if (pendingCommit) { pendingCommit = false; labelEditor.commit(); }
    for (const resolve of waiters.splice(0)) resolve();
  });
  value.addEventListener('input', (event) => { dirty = true; if (!event.isComposing) previewLabel(); });
  value.addEventListener('blur', () => labelEditor.commit());
  value.addEventListener('keydown', (event) => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); labelEditor.cancel(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); labelEditor.commit(); value.blur();
    }
  });
  field(label, '文字', value);
  const markdownRow = document.createElement('label'); markdownRow.className = 'research-label-markdown';
  const markdown = document.createElement('input'); markdown.type = 'checkbox'; markdown.checked = state.labelMarkdown !== false;
  markdown.dataset.symbolField = 'labelMarkdown';
  markdown.addEventListener('change', () => commit({ labelMarkdown: markdown.checked }));
  const markdownText = document.createElement('span'); text(markdownText, '开启 Markdown 渲染');
  markdownRow.append(markdown, markdownText); label.appendChild(markdownRow);
  if (textOnly && state.labelColor === 'inherit') state.labelColor = state.color;
  const typography = pair(label); color(typography, '文字颜色', 'labelColor', !textOnly); numeric(typography, '字号', 'labelFontSize', 8, 72);
  const offsets = pair(label);
  const x = numeric(offsets, 'X 偏移', 'labelOffsetX', -1e9, 1e9, 1, '以符号中心为原点，X 向右为正。');
  const y = numeric(offsets, 'Y 偏移', 'labelOffsetY', -1e9, 1e9, 1, '以符号中心为原点，Y 向上为正。');
  const center = document.createElement('button'); center.type = 'button'; center.className = 'research-label-center'; text(center, '居中');
  center.addEventListener('click', () => { x.value = y.value = 0; commit({ labelOffsetX: 0, labelOffsetY: 0 }); }); label.appendChild(center);
  return labelEditor;
}

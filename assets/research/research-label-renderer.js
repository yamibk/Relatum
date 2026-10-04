import { symbolColor, symbolLabelKey, setSymbolLabelMetrics } from './research-symbols.js';

let markdownPromise = null, mathPromise = null, mathQueue = Promise.resolve();
const parsed = new Map();
function ensureMarkdown() {
  if (window.MarkdownMini?.renderLabelResult) return Promise.resolve(window.MarkdownMini);
  if (!markdownPromise) markdownPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../markdown.js', import.meta.url).href; script.async = true;
    script.onload = () => resolve(window.MarkdownMini);
    script.onerror = () => { markdownPromise = null; reject(new Error('Markdown unavailable')); };
    document.head.appendChild(script);
  });
  return markdownPromise;
}
function ensureMath() {
  if (window.MathJax?.typesetPromise) return Promise.resolve(window.MathJax);
  if (!mathPromise) mathPromise = new Promise((resolve, reject) => {
    window.MathJax = { tex: { inlineMath: [['$', '$'], ['\\(', '\\)']],
      displayMath: [['$$', '$$'], ['\\[', '\\]']], processEscapes: true },
      // A diagram label's explicit world-space font size is also its math
      // size; matching the surrounding font's x-height would enlarge it.
      chtml: { matchFontHeight: false, scale: 1 }, startup: { typeset: false } };
    const script = document.createElement('script');
    script.src = new URL('../vendor/mathjax/tex-mml-chtml.js', import.meta.url).href; script.async = true;
    script.dataset.researchMathjax = '1';
    script.onload = () => Promise.resolve(window.MathJax.startup?.promise)
      .then(() => resolve(window.MathJax), reject);
    script.onerror = () => { mathPromise = null; reject(new Error('MathJax unavailable')); };
    document.head.appendChild(script);
  });
  return mathPromise;
}
function clearMath(node) {
  if (node && window.MathJax?.typesetClear) window.MathJax.typesetClear([node]);
}

// One world-space layer per canvas/preview. The DOM and typeset math survive
// camera changes; only source/font changes invalidate a label's render token.
export function createResearchLabelLayer(parent, options = {}) {
  const root = document.createElement('div'); root.className = 'research-label-layer';
  root.dataset.userContent = '';
  root.setAttribute('aria-hidden', 'true'); parent.appendChild(root);
  const entries = new Map(), queue = [], changed = new Set();
  let activeIds = new Set(), observer = null, frame = 0, measureFrame = 0;
  let paused = false, disposed = false, epoch = 0, scale = 1;
  const current = (entry, token, generation) => !disposed && !paused && generation === epoch
    && entries.get(entry.id) === entry && entry.token === token && entry.visible && entry.node?.isConnected;
  function measure(entry) {
    if (!entry.visible || !entry.node?.isConnected || paused || disposed) return;
    const b = entry.node.getBoundingClientRect();
    const width = b.width / scale, height = b.height / scale;
    if (!(width > 0 && height > 0)) return;
    setSymbolLabelMetrics(entry.d, width, height);
    if (!entry.measured || Math.abs(entry.measured.width - width) >= .1 || Math.abs(entry.measured.height - height) >= .1) {
      entry.measured = { width, height };
      changed.add(entry.id);
      if (!measureFrame) measureFrame = requestAnimationFrame(() => {
        measureFrame = 0; const ids = [...changed]; changed.clear();
        if (!paused && !disposed) options.onMetricsChange?.(ids);
      });
    }
  }
  function observe() {
    if (observer || paused || disposed) return;
    observer = new ResizeObserver((records) => {
      for (const record of records) { const entry = entries.get(record.target.dataset.researchLabelId); if (entry) measure(entry); }
    });
    for (const entry of entries.values()) if (entry.node) observer.observe(entry.node);
  }
  function style(entry) {
    if (!entry.node) return;
    const d = entry.d, s = entry.node.style;
    const values = { left: d.x + (d.labelOffsetX ?? 0) + 'px', top: d.y - (d.labelOffsetY ?? 0) + 'px',
      fontSize: (d.labelFontSize ?? 14) + 'px',
      color: symbolColor(!d.labelColor || d.labelColor === 'inherit' ? d.color || 'mono' : d.labelColor,
        'var(--research-ink)', entry.dark) };
    for (const [key, value] of Object.entries(values)) if (entry.style[key] !== value) { s[key] = value; entry.style[key] = value; }
    entry.node.hidden = !entry.visible;
  }
  function enqueue(entry) {
    if (entry.queued || entry.pending || entry.ready || !entry.visible || paused || disposed) return;
    entry.queued = true; queue.push(entry);
    if (!frame) frame = requestAnimationFrame(process);
  }
  function process() {
    frame = 0;
    if (paused || disposed) return;
    ensureMarkdown().then((markdown) => {
      if (paused || disposed) return;
      const started = performance.now();
      while (queue.length && performance.now() - started < 4) {
        const entry = queue.shift(); entry.queued = false;
        if (entries.get(entry.id) !== entry || !entry.visible || entry.ready || entry.pending) continue;
        if (!entry.node) {
          entry.node = document.createElement('div'); entry.node.className = 'research-symbol-label';
          entry.node.dataset.researchLabelId = entry.id; root.appendChild(entry.node);
          style(entry); observer?.observe(entry.node);
        }
        clearMath(entry.content);
        let result = parsed.get(entry.key);
        if (!result) {
          result = markdown.renderLabelResult(entry.d.label);
          if (parsed.size >= 2048) parsed.delete(parsed.keys().next().value);
          parsed.set(entry.key, result);
        }
        const content = document.createElement('div'); content.innerHTML = result.html;
        entry.content = content; entry.node.replaceChildren(content); entry.ready = true;
        // ResizeObserver measures the completed batch. Measuring each newly
        // inserted node here would force a fresh layout for every label.
        options.scheduleDraw?.();
        if (result.features.math) {
          const token = entry.token, generation = epoch; entry.pending = true; entry.ready = false;
          mathQueue = mathQueue.catch(() => {}).then(async () => {
            if (!current(entry, token, generation)) return;
            const math = await ensureMath();
            if (!current(entry, token, generation)) return;
            await math.typesetPromise([content]);
            if (current(entry, token, generation)) { entry.ready = true; measure(entry); }
          }).catch(() => {
            if (current(entry, token, generation)) {
              clearMath(content); content.textContent = entry.d.label;
              entry.ready = true; measure(entry);
            }
          }).finally(() => {
            if (entry.token === token) { entry.pending = false; options.scheduleDraw?.(); }
          });
        }
      }
      if (queue.length && !frame) frame = requestAnimationFrame(process);
    }).catch(() => {
      for (const entry of queue.splice(0)) {
        entry.queued = false; entry.ready = true;
        // Canvas keeps the readable source when loading fails.
      }
      options.scheduleDraw?.();
    });
  }
  function remove(entry) {
    entry.token++; if (entry.node) observer?.unobserve(entry.node);
    clearMath(entry.content); entry.node?.remove(); entries.delete(entry.id);
  }
  function sync(objects, camera, dark = false) {
    if (disposed) return;
    scale = camera.scale;
    const transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    if (root.style.transform !== transform) root.style.transform = transform;
    const nextIds = new Set();
    for (const d of objects) {
      if (!d.label || d.labelMarkdown === false) continue;
      nextIds.add(d.id); const key = symbolLabelKey(d);
      let entry = entries.get(d.id);
      if (!entry) { entry = { id: d.id, token: 0, style: {}, node: null }; entries.set(d.id, entry); }
      if (entry.key !== key) {
        entry.token++; entry.key = key; entry.ready = false; entry.pending = false; entry.measured = null;
      }
      entry.d = d; entry.dark = dark; entry.visible = true; style(entry); enqueue(entry);
    }
    for (const id of activeIds) if (!nextIds.has(id)) {
      const entry = entries.get(id); if (entry) { entry.visible = false; style(entry); }
    }
    activeIds = nextIds;
    if (entries.size > 2048) for (const entry of entries.values()) {
      if (!entry.visible) remove(entry);
      if (entries.size <= 2048) break;
    }
    observe();
  }
  function clear() {
    epoch++; queue.length = 0;
    for (const entry of entries.values()) remove(entry);
    activeIds.clear(); changed.clear();
  }
  function suspend() {
    paused = true; epoch++;
    cancelAnimationFrame(frame); cancelAnimationFrame(measureFrame); frame = measureFrame = 0;
    queue.length = 0; changed.clear(); observer?.disconnect(); observer = null;
    for (const entry of entries.values()) { entry.token++; entry.queued = entry.pending = false; }
  }
  return { sync, clear, suspend,
    hasLabel: (id) => !!entries.get(id)?.node && !!entries.get(id)?.visible,
    retain(objects) { const ids = new Set(objects.filter((d) => d.label && d.labelMarkdown !== false).map((d) => d.id));
      for (const entry of entries.values()) if (!ids.has(entry.id)) remove(entry); },
    activate() { paused = false; observe(); options.scheduleDraw?.(); },
    dispose() { suspend(); disposed = true; clear(); root.remove(); },
  };
}

/** Safe, bounded display projections. Source text is always kept in the object. */
let mathPromise = null, mathQueue = Promise.resolve();
function mathRuntime() {
  if (window.MathJax?.typesetPromise) return Promise.resolve(window.MathJax);
  if (mathPromise) return mathPromise;
  mathPromise = (async () => {
    let script = document.querySelector('script[src$="vendor/mathjax/tex-mml-chtml.js"]');
    if (!script) {
      window.MathJax ||= {
        tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']], processEscapes: true },
        startup: { typeset: false },
      };
      script = document.createElement('script'); script.src = 'vendor/mathjax/tex-mml-chtml.js'; script.async = true;
      const loaded = new Promise((resolve, reject) => {
        script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('Math runtime unavailable')); };
      });
      document.head.append(script); await loaded;
    } else if (!window.MathJax?.startup?.promise) {
      await new Promise((resolve, reject) => {
        script.addEventListener('load', resolve, { once: true }); script.addEventListener('error', reject, { once: true });
      });
    }
    await window.MathJax?.startup?.promise;
    if (!window.MathJax?.typesetPromise) throw new Error('Math runtime unavailable');
    return window.MathJax;
  })().catch(error => { mathPromise = null; throw error; });
  return mathPromise;
}

export function createContentRenderer(active) {
  const pending = new Map();
  const running = new Map();
  const keys = new WeakMap();
  let generation = 0;
  function render(host, object, limit = 12000) {
    const source = object.payload.source || '';
    const key = `${object.type}:${source}`;
    if (keys.get(host) === key) return;
    keys.set(host, key);
    const token = generation;
    clearTimeout(pending.get(host));
    pending.delete(host);
    const text = source.slice(0, limit);
    // Immediate readable fallback; delayed parsing never changes an editor's text or focus.
    host.textContent = text;
    if (!text) return;
    pending.set(host, setTimeout(async () => {
      pending.delete(host);
      const job = {}; running.set(host, job);
      try {
        const current = () => generation === token && active() && host.isConnected && keys.get(host) === key;
        if (!current()) { keys.delete(host); return; }
        const content = document.createElement('div');
        let hasMath = object.type === 'core.formula';
        let hasMermaid = false;
        if (hasMath) content.textContent = `$$${text}$$`;
        else {
          const result = window.MarkdownMini.renderResult(text);
          content.innerHTML = result.html; hasMath = result.features.math; hasMermaid = result.features.mermaid;
          // Preview links are readable text; this surface does not navigate away from drafts.
          for (const link of content.querySelectorAll('a')) link.removeAttribute('href');
          for (const input of content.querySelectorAll('input')) input.disabled = true;
        }
        // Keep TeX's optional resource/HTML commands out of research draft projections.
        if (hasMath && !/\\(?:require|href|url|style|class|cssId|html\w*|includegraphics)\b/.test(text)) {
          const math = await mathRuntime();
          const job = mathQueue.catch(() => {}).then(async () => {
            if (!current()) return;
            try { await math.typesetPromise([content]); } finally { math.typesetClear?.([content]); }
          });
          mathQueue = job; await job;
        }
        if (!current()) { if (generation === token && keys.get(host) === key) keys.delete(host); return; }
        if (source.length > limit) {
          const more = document.createElement('p'); more.textContent = '…'; content.append(more);
        }
        host.replaceChildren(content);
        if (hasMermaid) window.MermaidRenderer?.renderAll(content);
      } catch { /* Source fallback remains readable; no source is discarded. */ }
      finally { if (running.get(host) === job) running.delete(host); }
    }, 180));
  }
  return { render, cancel() {
    generation++;
    for (const [host, timer] of pending) { clearTimeout(timer); keys.delete(host); }
    for (const host of running.keys()) keys.delete(host);
    running.clear();
    pending.clear();
  } };
}

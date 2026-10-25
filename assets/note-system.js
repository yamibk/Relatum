// Local Notes resource policy. Budgets describe caches, never process memory.
(function () {
  'use strict';
  const KEY = 'canvas:noteSystem:v1';
  const defaults = Object.freeze({ animations: true, prefetch: true, cache: 'standard', renderScale: 1 });
  const presets = Object.freeze({ balanced: defaults,
    economy: { animations: false, prefetch: false, cache: 'small', renderScale: .75 },
    switching: { animations: true, prefetch: true, cache: 'large', renderScale: 1 } });
  const budgets = { tiny: { documents: [3, 2], graph: [3, 2], mermaid: [4, 1] },
    small: { documents: [6, 4], graph: [6, 4], mermaid: [8, 2] },
    standard: { documents: [24, 16], graph: [24, 16], mermaid: [32, 8] },
    large: { documents: [48, 32], graph: [48, 32], mermaid: [64, 16] },
    xlarge: { documents: [96, 64], graph: [96, 64], mermaid: [128, 32] } };
  const cacheLevels = Object.keys(budgets), renderScales = Array.from({ length: 11 }, (_, index) => (50 + index * 5) / 100);
  function normalize(raw) {
    return Object.freeze({ animations: typeof raw?.animations === 'boolean' ? raw.animations : true,
      prefetch: typeof raw?.prefetch === 'boolean' ? raw.prefetch : true,
      cache: Object.hasOwn(budgets, raw?.cache) ? raw.cache : 'standard',
      renderScale: renderScales.includes(raw?.renderScale) ? raw.renderScale : 1 });
  }
  let value = defaults;
  try { value = normalize(JSON.parse(localStorage.getItem(KEY))); } catch (_) {}
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)'), motion = new EventTarget();
  let reduced = systemMotion.matches || !value.animations;
  Object.defineProperty(motion, 'matches', { get: () => reduced });
  function syncMotion() {
    const next = systemMotion.matches || !value.animations, changed = next !== reduced;
    reduced = next; document.documentElement.dataset.noteReducedMotion = next ? '1' : '0';
    if (changed) motion.dispatchEvent(new Event('change'));
  }
  systemMotion.addEventListener('change', syncMotion); syncMotion();
  function publish(previous, clear = false, reset = false) {
    syncMotion(); window.dispatchEvent(new CustomEvent('relatum:note-system', { detail: { previous, value, clear, reset } }));
  }
  function update(delta) {
    const next = normalize({ ...value, ...delta });
    if (JSON.stringify(next) === JSON.stringify(value)) return;
    const previous = value; value = next;
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (_) {}
    publish(previous);
  }
  function reset() {
    const previous = value; value = defaults;
    try { localStorage.removeItem(KEY); } catch (_) {}
    publish(previous, false, true);
  }
  function budget(kind) {
    const [items, mib] = budgets[value.cache][kind]; return { items, bytes: mib * 1024 * 1024 };
  }
  function preset() {
    return Object.keys(presets).find(id => Object.keys(defaults).every(key => presets[id][key] === value[key])) || 'custom';
  }
  function createPanel(options) {
    const panel = document.createElement('section'); panel.className = 'note-system-settings'; panel.dataset.i18nManaged = 'true';
    const text = (zh, en) => options.language() === 'en' ? en : zh;
    const intro = document.createElement('p'), choices = document.createElement('div'); choices.className = 'note-system-presets';
    const names = { balanced: ['均衡', 'Balanced'], economy: ['节省资源', 'Save resources'], switching: ['切换优先', 'Faster switching'] };
    const descriptions = { balanced: ['保持现有体验', 'Keep the current experience'], economy: ['减少动效、预读与缓存', 'Less motion, prefetching and caching'], switching: ['增加缓存，减少重复读取', 'More caching, fewer repeated reads'] };
    const buttons = new Map();
    Object.keys(presets).forEach(id => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.systemPreset = id;
      button.dataset.settingsKeywords = '';
      button.innerHTML = '<strong></strong><small></small>'; button.addEventListener('click', () => update(presets[id]));
      choices.append(button); buttons.set(id, button);
    });
    const current = document.createElement('p'); current.className = 'note-system-current'; current.setAttribute('role', 'status');
    const controls = document.createElement('div'); controls.className = 'note-system-controls';
    const fields = new Map();
    function toggle(key) {
      const label = document.createElement('label'); label.className = 'note-system-toggle';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.systemField = key;
      const body = document.createElement('span'); body.innerHTML = '<strong></strong><small></small>';
      label.append(input, body); controls.append(label); fields.set(key, label);
      input.addEventListener('change', () => update({ [key]: input.checked }));
    }
    function range(key, min, max, step) {
      const label = document.createElement('label'); label.className = 'note-system-range';
      label.innerHTML = '<span><strong></strong><output></output></span><input type="range"><small></small>';
      const input = label.querySelector('input'); Object.assign(input, { min, max, step }); input.dataset.systemField = key;
      input.addEventListener('input', () => refreshRange(key, input.value));
      input.addEventListener('change', () => update({ [key]: key === 'cache' ? cacheLevels[Number(input.value)] : Number(input.value) / 100 }));
      controls.append(label); fields.set(key, label);
    }
    toggle('animations'); toggle('prefetch'); range('cache', 0, cacheLevels.length - 1, 1);
    if (options.graph) range('renderScale', 50, 100, 5);
    const budgetHint = document.createElement('p'); controls.append(budgetHint);
    if (options.preload) controls.append(options.preload);
    const overview = document.createElement('section'); overview.className = 'note-system-overview';
    overview.dataset.settingsKeywords = '缓存 用量 数量 占用 预算 cache usage count budget';
    const overviewHead = document.createElement('div'); overviewHead.className = 'note-system-overview-head';
    const overviewTitle = document.createElement('h3'), refreshButton = document.createElement('button');
    refreshButton.type = 'button'; refreshButton.dataset.systemRefresh = '';
    overviewHead.append(overviewTitle, refreshButton);
    const rows = new Map(), overviewHint = document.createElement('p');
    for (const key of ['documents', ...(options.graph ? ['graph'] : []), ...(options.mermaid ? ['mermaid', 'worker'] : [])]) {
      const row = document.createElement('div'); row.className = 'note-system-cache-row'; row.dataset.systemCache = key;
      row.innerHTML = '<strong></strong><span data-cache-usage></span><small data-cache-budget></small>';
      rows.set(key, row);
    }
    const overviewBody = document.createElement('div'); overviewBody.setAttribute('aria-live', 'polite');
    overviewBody.append(...rows.values()); overview.append(overviewHead, overviewBody, overviewHint);
    let active = false, statsRevision = 0, statsController = null, snapshot = null, loading = false;
    function cancelStats() {
      statsRevision++; statsController?.abort(); statsController = null; loading = false;
    }
    function renderStats() {
      const names = { documents: text('正文', 'Notes'), graph: text('图谱场景', 'Graph scenes'),
        mermaid: text('Mermaid 主线程', 'Mermaid main thread'), worker: 'Mermaid Worker' };
      const formatBytes = bytes => bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MiB' : (bytes / 1024).toFixed(1) + ' KiB';
      rows.forEach((row, key) => {
        row.querySelector('strong').textContent = names[key];
        const item = key === 'worker' ? snapshot?.mermaid?.worker : key === 'mermaid' ? snapshot?.mermaid?.main : snapshot?.[key];
        const b = budget(key === 'worker' || key === 'mermaid' ? 'mermaid' : key);
        row.querySelector('[data-cache-budget]').textContent = text('预算：', 'Budget: ') + b.items + text(' 项 / ', ' items / ') + formatBytes(b.bytes);
        const output = row.querySelector('[data-cache-usage]');
        if (loading) output.textContent = text('读取中…', 'Reading…');
        else if (!item) output.textContent = text('尚未加载', 'Not loaded');
        else if (item.state === 'stopped') output.textContent = text('未运行', 'Not running');
        else if (item.state === 'unavailable') output.textContent = text('暂不可用', 'Temporarily unavailable');
        else output.textContent = item.items + text(' 项 · 估算 ', ' items · estimated ') + formatBytes(item.bytes);
        row.dataset.cacheState = loading ? 'loading' : item?.state || (item ? 'ready' : 'not-loaded');
      });
    }
    async function refreshStats() {
      if (!active) return;
      cancelStats(); const revision = statsRevision, controller = new AbortController(); statsController = controller;
      loading = true; renderStats();
      // Policy listeners trim their caches synchronously; sample only after all of them have run.
      await Promise.resolve();
      if (!active || revision !== statsRevision) return;
      let result;
      try { result = await options.getCacheStats({ signal: controller.signal }); }
      catch (_) {
        const unavailable = { state: 'unavailable' };
        result = { documents: unavailable, graph: unavailable, mermaid: { main: unavailable, worker: unavailable } };
      }
      if (!active || revision !== statsRevision || controller.signal.aborted) return;
      snapshot = result; loading = false; statsController = null; renderStats();
    }
    refreshButton.addEventListener('click', refreshStats);
    const clean = document.createElement('div'); clean.className = 'note-system-clean';
    const cleanButton = document.createElement('button'); cleanButton.type = 'button'; cleanButton.dataset.systemClear = '';
    cleanButton.dataset.settingsKeywords = '清理 未使用 缓存 clear unused cache';
    const cleanHint = document.createElement('p'), status = document.createElement('p'); status.setAttribute('role', 'status');
    cleanButton.addEventListener('click', () => { publish(value, true); status.textContent = text('已清理未使用的缓存。当前内容保持不变。', 'Unused caches cleared. Current content is preserved.'); });
    clean.append(cleanButton, cleanHint, status); panel.append(intro, choices, current, controls, overview, clean);
    function cacheName(key) { return { tiny: text('极小', 'Minimal'), small: text('较小', 'Small'), standard: text('标准', 'Standard'), large: text('较大', 'Large'), xlarge: text('更大', 'Extra large') }[key]; }
    function refreshRange(key, raw) {
      const label = fields.get(key); if (!label) return;
      const selected = key === 'cache' ? cacheLevels[Number(raw)] : null;
      label.querySelector('output').textContent = key === 'cache' ? cacheName(selected) : raw + '%';
      label.querySelector('input').setAttribute('aria-valuetext', label.querySelector('output').textContent);
      if (key === 'cache') {
        const b = budgets[selected], parts = [text('正文 ', 'Notes ') + b.documents[0] + text(' 篇 / ', ' / ') + b.documents[1] + ' MiB'];
        if (options.graph) parts.push(text('图谱 ', 'Graph ') + b.graph[0] + text(' 本 / ', ' / ') + b.graph[1] + ' MiB');
        if (options.mermaid) parts.push('Mermaid ' + b.mermaid[0] + text(' 项 / ', ' / ') + b.mermaid[1] + text(' MiB（主线程与 Worker 各自）', ' MiB each for main thread and worker'));
        label.querySelector('small').textContent = parts.join('；');
      }
    }
    function refresh() {
      intro.textContent = text('平衡动画体验、切换速度与资源占用。更改自动保存，除启动预加载外立即生效。', 'Balance motion, switching speed and resource use. Changes save automatically and apply immediately, except startup preloading.');
      buttons.forEach((button, id) => {
        button.querySelector('strong').textContent = names[id][options.language() === 'en' ? 1 : 0];
        button.setAttribute('aria-label', names[id][options.language() === 'en' ? 1 : 0]);
        button.querySelector('small').textContent = descriptions[id][options.language() === 'en' ? 1 : 0];
        button.setAttribute('aria-pressed', String(preset() === id));
      });
      current.textContent = text('当前：', 'Current: ') + (preset() === 'custom' ? text('自定义', 'Custom') : names[preset()][options.language() === 'en' ? 1 : 0]);
      const labels = { animations: [text('交互动画', 'Interaction animations'), text('取消勾选后关闭交互动效；勾选时仍遵循系统的“减少动态效果”设置。', 'Uncheck to turn off interaction animations. When checked, the system’s reduced-motion setting still applies.')],
        prefetch: [text('正文预读', 'Prefetch notes'), text('提前读取文件树中可见或悬停的笔记，提高打开速度；会增加后台读取与缓存。', 'Read visible or hovered notes ahead of time for faster opening, using additional background reads and cache.')],
        cache: [text('缓存档位', 'Cache size')], renderScale: [text('图谱清晰度', 'Graph resolution'), text('较低清晰度可减少绘图开销；文字大小、节点位置和镜头不变。', 'Lower resolution reduces drawing work while preserving text size, node positions and camera.')] };
      fields.forEach((label, key) => {
        label.querySelector('strong').textContent = labels[key][0];
        const input = label.querySelector('input'); input.setAttribute('aria-label', labels[key][0]);
        if (input.type === 'checkbox') { input.checked = value[key]; label.querySelector('small').textContent = labels[key][1]; }
        else { input.value = key === 'cache' ? cacheLevels.indexOf(value.cache) : Math.round(value.renderScale * 100); refreshRange(key, input.value); if (key === 'renderScale') label.querySelector('small').textContent = labels[key][1]; }
      });
      budgetHint.textContent = text('容量越大，重复读取可能越少。以上为缓存计量预算，不是应用内存上限；当前内容和待保存内容可能使其暂时超出预算。', 'Larger caches may reduce repeated reads. These are cache accounting budgets, not application memory limits; current and unsaved content may exceed them.');
      if (options.preload) {
        options.preload.querySelector('strong').textContent = text('图谱启动预加载', 'Preload graph at startup');
        options.preload.querySelector('.note-graph-preload-hint:not([data-role])').textContent = text('下次启动生效。空闲时准备当前笔记本的图谱脚本、数据和布局；会增加后台读取和缓存。此项独立于上方预设。', 'Applies at next startup. Prepare graph scripts, data and layout while idle, using additional background reads and cache. Independent of the presets above.');
        options.preload.querySelector('[data-role="note-graph-preload-paused"]').textContent = text('本次启动已关闭后台预加载', 'Background preloading is disabled for this launch');
      }
      cleanButton.textContent = text('清理未使用缓存', 'Clear unused caches');
      cleanButton.setAttribute('aria-label', cleanButton.textContent);
      cleanHint.textContent = text('保留当前正文、撤销历史、AI 对话、活动图谱和阅读位置。重新打开内容时可能需要再次读取或渲染。', 'Keep the current note, undo history, AI chat, active graph and reading position. Reopening content may require another read or render.');
      overviewTitle.textContent = text('缓存概览', 'Cache overview'); refreshButton.textContent = text('刷新', 'Refresh');
      refreshButton.setAttribute('aria-label', text('刷新缓存概览', 'Refresh cache overview'));
      overviewHint.textContent = text('显示最近一次读取的缓存数量与估算用量，包含受保护项，可能暂时超过预算；不代表应用实际内存或 GPU 占用。', 'A snapshot of cache counts and estimated usage, including protected entries that may temporarily exceed budgets. This does not measure application memory or GPU usage.');
      renderStats();
    }
    window.addEventListener('relatum:note-system', event => {
      refresh();
      if (event.detail.clear || event.detail.reset || event.detail.previous.cache !== event.detail.value.cache) refreshStats();
    }); refresh();
    return { panel, refresh, setActive(next) {
      if (active === next) return;
      active = next;
      if (active) refreshStats(); else cancelStats();
    } };
  }
  window.RelatumNoteSystem = Object.freeze({ read: () => value, update, reset, budget, motion, createPanel });
})();

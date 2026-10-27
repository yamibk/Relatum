// Sparse file-tree decoration. No editor state, observers, timers or render loop.
(function () {
  'use strict';
  window.RelatumNoteExtensions.registerRuntime('file-colors', context => {
    const cache = new Map(), writes = new Map();
    let destroyed = false, scheduled = false, running = false, rerun = false, revision = 0, generation = null, controller = null, lastError = '';
    const current = () => !destroyed && context.isCurrent();
    function decorate(row, path) {
      const color = cache.get(path);
      if (color) { if (row.dataset.fileColor !== color) row.dataset.fileColor = color; }
      else if (row.hasAttribute('data-file-color')) row.removeAttribute('data-file-color');
    }
    function paint(path) { const row = context.rows().get(path); if (row) decorate(row, path); }
    function report(error) {
      const message = error?.message || (context.language() === 'en' ? 'Could not read file colors.' : '无法读取文件颜色。');
      if (message !== lastError && current()) { lastError = message; context.notify(message, 'error'); }
    }
    function schedule() {
      if (running) { rerun = true; return; }
      if (!current() || scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (current() && !running) load(); });
    }
    async function load() {
      running = true;
      const token = revision; controller = new AbortController();
      const paths = Array.from(context.entries().keys()).filter(path => !cache.has(path) && !writes.has(path));
      try {
        for (let offset = 0; offset < paths.length && current() && token === revision; offset += 512) {
          const batch = paths.slice(offset, offset + 512);
          const result = await context.post('/api/note-file-colors/query', { paths: batch }, { signal: controller.signal });
          if (!current() || token !== revision) return;
          if (generation !== null && result.generation !== generation) {
            generation = result.generation; cache.clear(); revision++; schedule(); return;
          }
          generation = result.generation;
          batch.forEach(path => {
            if (!context.entries().has(path) || writes.has(path)) return;
            const value = result.colors?.[path]; cache.set(path, context.colors.includes(value) ? value : null); paint(path);
          });
          lastError = '';
        }
      } catch (error) { if (error.name !== 'AbortError' && token === revision) report(error); }
      finally { running = false; controller = null; if (current() && (token !== revision || rerun)) { rerun = false; schedule(); } }
    }
    function sync(remoteGeneration) {
      if (!current()) return;
      if (Number.isInteger(remoteGeneration) && remoteGeneration === generation) return;
      if (Number.isInteger(remoteGeneration) && generation !== null && remoteGeneration !== generation) {
        generation = remoteGeneration; revision++; controller?.abort(); cache.clear();
      }
      for (const path of cache.keys()) if (!context.entries().has(path)) cache.delete(path);
      schedule();
    }
    async function set(path, color) {
      // A path's requests are ordered; each response may only update its own
      // latest selection. A failed earlier click cannot undo a later choice.
      const pending = writes.get(path);
      const operation = { previous: pending ? pending.previous : cache.get(path) || null, color, task: null };
      revision++; controller?.abort();
      cache.set(path, color); paint(path);
      operation.task = Promise.resolve(pending?.task).catch(() => {}).then(() =>
        context.post('/api/note-file-colors/set', { path, color })).then(result => {
        if (!current()) return;
        const latest = writes.get(path);
        if (latest !== operation) { if (latest) latest.previous = result.color; return; }
        if (generation !== null && result.generation > generation + 1) {
          cache.clear(); for (const [key, write] of writes) cache.set(key, write.color);
        }
        generation = Math.max(generation || 0, result.generation); cache.set(path, result.color); paint(path); lastError = '';
      }).catch(error => {
        if (current() && writes.get(path) === operation) { cache.set(path, operation.previous); paint(path); report(error); }
      }).finally(() => { if (writes.get(path) === operation) writes.delete(path); if (current()) schedule(); });
      writes.set(path, operation); return operation.task;
    }
    function invalidate() { if (!current()) return; generation = null; revision++; controller?.abort(); cache.clear(); sync(); }
    for (const [path, row] of context.rows()) decorate(row, path);
    context.host.dataset.fileColorsEnabled = 'true';
    sync();
    return { decorate, sync, set, invalidate, get: path => cache.get(path) || null,
      destroy() {
        if (destroyed) return;
        destroyed = true; revision++; controller?.abort(); cache.clear(); writes.clear();
        delete context.host.dataset.fileColorsEnabled;
      },
    };
  });
})();

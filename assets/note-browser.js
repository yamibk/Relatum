// Built-in note discovery providers. The host owns documents and persistence;
// providers own navigation and pages, never editor instances or note bodies.
(function () {
  'use strict';
  const providers = new Map();
  function registerProvider(provider) {
    if (!provider || !provider.id || providers.has(provider.id) || typeof provider.loadPage !== 'function') throw new Error('Invalid note browser provider');
    providers.set(provider.id, provider);
  }
  const words = {
    'zh-CN': { recent: '最近文件', tags: '标签', empty: '没有匹配的笔记', more: '加载更多', loading: '正在读取…', failed: '读取失败，点击重试', count: '{count} 篇笔记', return: '返回结果', untitled: '笔记浏览' },
    en: { recent: 'Recent files', tags: 'Tags', empty: 'No matching notes', more: 'Load more', loading: 'Loading…', failed: 'Could not load. Click to retry', count: '{count} notes', return: 'Back to results', untitled: 'Browse notes' },
  };
  Object.assign(words['zh-CN'], { canvas: '画布', canvasCount: '{count} 张画布', all: '全部', unused: '未引用', missing: '文件缺失', referenced: '被 {count} 篇笔记引用', canvasEmpty: '没有匹配的画布', reveal: '在资源管理器中显示', incomplete: '统计未完成，请点击重试', refresh: '刷新', noReferences: '没有引用笔记' });
  Object.assign(words.en, { canvas: 'Canvas', canvasCount: '{count} canvases', canvasCountOne: '1 canvas', all: 'All', unused: 'Unreferenced', missing: 'File missing', referenced: 'Referenced by {count} notes', referencedOne: 'Referenced by 1 note', canvasEmpty: 'No matching canvases', reveal: 'Show in File Explorer', incomplete: 'Statistics incomplete. Click to retry', refresh: 'Refresh', noReferences: 'No referencing notes' });
  registerProvider({ id: 'recent', label: 'recent', async loadPage(ctx, selection, offset) {
    const recent = ctx.getRecent();
    const files = ctx.getEntries().filter((entry) => entry.kind === 'note');
    files.sort((a, b) => Math.max(Number(b.modifiedNs) / 1e6, recent[b.path] || 0) - Math.max(Number(a.modifiedNs) / 1e6, recent[a.path] || 0) || a.path.localeCompare(b.path));
    const result = await ctx.query({ paths: files.slice(offset, offset + 50).map((entry) => entry.path) });
    return Object.assign(result, { total: files.length, hasMore: offset + 50 < files.length, consumed: Math.min(50, files.length - offset) });
  } });
  registerProvider({ id: 'tags', label: 'tags', async loadNavigation(ctx) { return (await ctx.request('/api/note-tags')).items || []; },
    loadPage(ctx, selection, offset) { return ctx.query({ tag: selection.key, offset, limit: 50 }); } });
  registerProvider({ id: 'canvas', label: 'canvas', enabled: ctx => !!ctx.canvasEnabled?.(),
    loadPage(ctx, selection, offset) { return ctx.request('/api/notes-canvas/list?filter=' + (selection.key || 'all') + '&offset=' + offset + '&limit=50'); } });

  function create(ctx) {
    const root = ctx.root, nav = ctx.navigation, results = ctx.results, back = ctx.back;
    let active = false, disposed = false;
    const expanded = new Set(), navigation = new Map(), navigationDirty = new Set(providers.keys()), navigationSequences = new Map();
    const navigationGroups = new Map();
    let providerId = 'recent', selection = {}, rows = [], offset = 0, total = 0, hasMore = false, selectedPath = '';
    let pageSequence = 0, actionSequence = 0, loading = false, failed = false, dirty = true;
    let resultProviderId = providerId, resultSelection = selection, hasResult = false, resetting = false, preservingScroll = false, failedReset = false;
    let resultScroll = 0;
    let canvasSignature = '', failureCode = '', referenceEpoch = 0, checkingCanvases = false;
    let referenceHostId = 0;
    const canvasReferences = new Map();
    const copy = (key) => (words[ctx.language()] || words['zh-CN'])[key] || key;
    function button(label, handler, className) {
      const node = document.createElement('button'); node.type = 'button'; node.className = className || 'note-browser-nav-row';
      node.textContent = label; node.addEventListener('click', handler); return node;
    }
    function showResults() {
      const wasHidden = results.hidden;
      root.classList.remove('tree-overlay-open');
      ctx.showResults(true); back.hidden = true;
      results.hidden = false; results.inert = false;
      if (wasHidden) results.scrollTop = resultScroll;
    }
    function showDocument() {
      cancelReferenceRequests();
      if (loading) { pageSequence++; dirty = true; loading = false; resetting = false; results.setAttribute('aria-busy', 'false'); }
      if (!results.hidden) resultScroll = results.scrollTop;
      ctx.showResults(false); results.hidden = true; results.inert = true;
      back.hidden = !active; updateBackLabel();
    }
    function updateBackLabel() { back.replaceChildren(...(ctx.icon ? [ctx.icon('arrow-left')] : []), document.createTextNode(copy('return'))); }
    function renderNavigation(animateId) {
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      nav.setAttribute('aria-label', copy('untitled'));
      providers.forEach((provider) => {
        if (provider.enabled && !provider.enabled(ctx)) return;
        const hierarchical = typeof provider.loadNavigation === 'function';
        let group = navigationGroups.get(provider.id);
        if (!group) {
          const wrapper = document.createElement('div'); wrapper.className = 'note-tree-entry';
          const heading = button('', async () => {
            if (!active) return;
            if (hierarchical) {
              if (expanded.has(provider.id)) expanded.delete(provider.id); else expanded.add(provider.id);
              renderNavigation(provider.id); if (expanded.has(provider.id)) await loadNavigation(provider.id);
            } else await select(provider.id, {});
          });
          const label = document.createElement('span');
          if (hierarchical) {
            heading.classList.add('note-tree-row');
            const toggle = document.createElement('span'); toggle.className = 'note-tree-toggle'; toggle.setAttribute('aria-hidden', 'true');
            heading.appendChild(toggle);
          }
          heading.dataset.noteBrowserProvider = provider.id;
          if (ctx.icon) heading.appendChild(ctx.icon(provider.id === 'canvas' ? 'square-pen' : provider.id === 'tags' ? 'hash' : hierarchical ? 'folder' : 'clock-3', 'note-browser-icon'));
          heading.appendChild(label); wrapper.appendChild(heading);
          const shell = document.createElement('div'); shell.className = 'note-tree-children-shell';
          const children = document.createElement('div'); children.className = 'note-tree-children'; shell.appendChild(children);
          if (hierarchical) wrapper.appendChild(shell);
          group = { wrapper, heading, label, shell, children, rows: new Map(), open: false, items: null, frame: 0, timer: 0 };
          navigationGroups.set(provider.id, group); nav.appendChild(wrapper);
        }
        const { heading, shell, children } = group;
        group.label.textContent = copy(provider.label);
        heading.classList.toggle('is-selected', providerId === provider.id && !hierarchical);
        if (!hierarchical) return;
        const items = navigation.get(provider.id) || [];
        const changedItems = group.items !== items, open = expanded.has(provider.id), changedOpen = group.open !== open;
        if (changedOpen) group.waitingOnOpen = open && !items.length;
        let next = children.firstElementChild;
        const keys = new Set();
        items.forEach((tag, index) => {
          keys.add(tag.key);
          let item = group.rows.get(tag.key);
          if (!item) {
            const wrapper = document.createElement('div'); wrapper.className = 'note-tree-entry';
            const row = button('', () => select(provider.id, item.tag)); row.classList.add('note-browser-tag-row');
            const label = document.createElement('span'), count = document.createElement('small');
            if (ctx.icon && provider.id === 'tags') row.appendChild(ctx.icon('hash', 'note-browser-icon'));
            row.append(label, count); wrapper.appendChild(row);
            item = { wrapper, row, label, count, tag }; group.rows.set(tag.key, item);
          }
          item.tag = tag;
          if (provider.id === 'tags') item.row.dataset.noteBrowserTag = tag.key;
          item.row.style.setProperty('--tag-depth', provider.id === 'tags' ? tag.key.split('/').length - 1 : tag.depth || 0);
          item.wrapper.style.setProperty('--note-child-index', Math.min(index, 7));
          item.row.classList.toggle('is-selected', providerId === provider.id && selection.key === tag.key);
          item.label.textContent = provider.id === 'tags' ? tag.label.split('/').pop() : tag.label;
          item.count.textContent = tag.count ?? '';
          if (next === item.wrapper) next = next.nextElementSibling; else children.insertBefore(item.wrapper, next);
        });
        group.rows.forEach((item, key) => { if (!keys.has(key)) { item.wrapper.remove(); group.rows.delete(key); } });
        heading.setAttribute('aria-expanded', String(open)); shell.setAttribute('aria-hidden', String(!open)); shell.inert = !open;
        if (animateId === provider.id && !reduced && open && (changedOpen || changedItems)) {
          cancelAnimationFrame(group.frame); clearTimeout(group.timer);
          shell.classList.remove('is-open', 'is-collapsing', 'is-expanding');
          if (changedOpen) heading.classList.add('is-expanding');
          void shell.offsetHeight;
          group.frame = requestAnimationFrame(() => {
            group.frame = 0;
            if (!active || !expanded.has(provider.id)) return;
            shell.classList.add('is-open', 'is-expanding');
            group.timer = setTimeout(() => { heading.classList.remove('is-expanding'); shell.classList.remove('is-expanding'); }, 300);
          });
        } else if (changedOpen || reduced || !animateId) {
          cancelAnimationFrame(group.frame); clearTimeout(group.timer);
          shell.classList.toggle('is-open', open); shell.classList.toggle('is-collapsing', !open); shell.classList.remove('is-expanding'); heading.classList.remove('is-expanding');
        }
        group.open = open; group.items = items;
      });
    }
    async function loadNavigation(id) {
      if (!id) { await Promise.all(Array.from(expanded, (key) => loadNavigation(key))); return; }
      if (!active || !expanded.has(id) || !navigationDirty.has(id)) return;
      const sequence = (navigationSequences.get(id) || 0) + 1; navigationSequences.set(id, sequence);
      const group = navigationGroups.get(id);
      if (group && group.error) { group.error.remove(); group.error = null; }
      try {
        const items = await providers.get(id).loadNavigation(ctx);
        if (!active || disposed || sequence !== navigationSequences.get(id)) return;
        navigation.set(id, items); navigationDirty.delete(id); renderNavigation(group && group.waitingOnOpen ? id : undefined);
        if (group) group.waitingOnOpen = false;
      } catch (error) {
        if (active && sequence === navigationSequences.get(id) && group) {
          group.error = button(copy('failed'), () => loadNavigation(id), 'note-browser-message'); group.wrapper.appendChild(group.error);
        }
      }
    }
    function cancelReferenceRequests() {
      referenceEpoch++;
      canvasReferences.forEach(state => { if (state.loading) dirty = true; state.sequence++; state.loading = false; });
    }
    function canvasInteractive() {
      return active && !disposed && !results.hidden && providerId === 'canvas' && resultProviderId === 'canvas' && !resetting;
    }
    async function openResultNote(note) {
      if (!active || (loading && resetting)) return;
      const sequence = ++actionSequence, page = pageSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence || page !== pageSequence || (loading && resetting)) return;
      if (await ctx.openNote(note.path)) { selectedPath = note.path; showDocument(); root.classList.remove('tree-overlay-open'); }
    }
    function referenceState(path) {
      if (!canvasReferences.has(path)) canvasReferences.set(path, { open: false, items: [], offset: 0, hasMore: false, loaded: false, loading: false, error: '', sequence: 0, signature: '' });
      return canvasReferences.get(path);
    }
    function renderReferences(path, state, host) {
      const fragment = document.createDocumentFragment();
      state.items.forEach(note => {
        const row = button('', () => openResultNote(note), 'note-browser-reference');
        row.dataset.noteBrowserPath = note.path;
        row.classList.toggle('is-selected', note.path === selectedPath);
        const title = document.createElement('strong'); title.textContent = note.title;
        const location = document.createElement('small'); location.textContent = note.path;
        row.append(title, location); fragment.appendChild(row);
      });
      if (state.error) fragment.appendChild(button(copy(state.error === 'statistics_incomplete' ? 'incomplete' : 'failed'), () => loadReferences(path, state, host, true), 'note-browser-message'));
      else if (state.loading) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('loading'); fragment.appendChild(message); }
      else if (state.loaded && !state.items.length) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('noReferences'); fragment.appendChild(message); }
      else if (state.hasMore) fragment.appendChild(button(copy('more'), () => loadReferences(path, state, host, false), 'note-browser-more'));
      host.replaceChildren(fragment);
    }
    async function loadReferences(path, state, host, reset) {
      if (!canvasInteractive() || !state.open || state.loading || !host.isConnected) return;
      const sequence = ++state.sequence, epoch = referenceEpoch, requestOffset = reset ? 0 : state.offset;
      state.loading = true; state.error = ''; renderReferences(path, state, host);
      try {
        const result = await ctx.request('/api/notes-canvas/references?path=' + encodeURIComponent(path) + '&offset=' + requestOffset + '&limit=50');
        if (!canvasInteractive() || epoch !== referenceEpoch || sequence !== state.sequence || !state.open || !host.isConnected) return;
        state.items = reset ? result.items : state.items.concat(result.items);
        state.offset = requestOffset + result.items.length; state.hasMore = result.hasMore;
        state.signature = result.signature; state.loaded = true; state.loading = false;
        renderReferences(path, state, host);
      } catch (error) {
        if (!canvasInteractive() || epoch !== referenceEpoch || sequence !== state.sequence || !host.isConnected) return;
        state.loading = false; state.error = error.code || 'failed'; renderReferences(path, state, host);
      }
    }
    function renderCanvas(canvas) {
      const wrapper = document.createElement('section'); wrapper.className = 'note-browser-canvas'; wrapper.dataset.noteBrowserCanvas = canvas.path;
      const state = referenceState(canvas.path);
      const row = button('', () => {
        if (!canvasInteractive()) return;
        state.open = !state.open; row.setAttribute('aria-expanded', String(state.open)); host.hidden = !state.open;
        if (!state.open) { state.sequence++; state.loading = false; }
        else if (!state.loaded || state.signature !== canvasSignature) loadReferences(canvas.path, state, host, true);
      }, 'note-browser-result note-browser-canvas-heading');
      row.setAttribute('aria-expanded', String(state.open));
      if (ctx.icon) row.appendChild(ctx.icon('chevron-right', 'note-browser-canvas-chevron'));
      const title = document.createElement('strong'); title.textContent = canvas.name;
      const status = document.createElement('p');
      status.textContent = canvas.referenceCount ? copy(canvas.referenceCount === 1 && ctx.language() === 'en' ? 'referencedOne' : 'referenced').replace('{count}', canvas.referenceCount) : copy('unused');
      if (!canvas.exists) { const missing = document.createElement('span'); missing.className = 'note-browser-missing'; missing.textContent = copy('missing'); status.append(' · ', missing); }
      const path = document.createElement('small'); path.textContent = canvas.path;
      row.append(title, status, path);
      const reveal = button(copy('reveal'), async () => {
        if (!canvasInteractive() || !canvas.exists) return;
        try { await ctx.revealCanvas(canvas.path); } catch (error) { ctx.showError?.(error.message); }
      }, 'note-browser-canvas-reveal'); reveal.disabled = !canvas.exists;
      const host = document.createElement('div'); host.className = 'note-browser-references'; host.hidden = !state.open;
      host.id = 'note-browser-references-' + (++referenceHostId); row.setAttribute('aria-controls', host.id);
      wrapper.append(row, reveal, host); renderReferences(canvas.path, state, host);
      if (state.open && (!state.loaded || state.signature !== canvasSignature)) {
        // The row must be attached before requesting its references.
        queueMicrotask(() => loadReferences(canvas.path, state, host, true));
      }
      return wrapper;
    }
    function renderResults() {
      cancelReferenceRequests();
      const scroll = results.scrollTop;
      const fragment = document.createDocumentFragment();
      const heading = document.createElement('header'); heading.className = 'note-browser-results-head';
      const title = document.createElement('h2'); title.textContent = resultProviderId === 'tags' ? '#' + (resultSelection.label || resultSelection.key) : resultSelection.label || copy(providers.get(resultProviderId).label);
      const count = document.createElement('span'); count.textContent = copy(resultProviderId === 'canvas' ? total === 1 && ctx.language() === 'en' ? 'canvasCountOne' : 'canvasCount' : 'count').replace('{count}', total);
      heading.append(title, count); fragment.appendChild(heading);
      if (resultProviderId === 'canvas') {
        const filters = document.createElement('div'); filters.className = 'note-browser-canvas-filters'; filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', copy('canvas'));
        ['all', 'unused', 'missing'].forEach(key => {
          const filter = button(copy(key), () => select('canvas', { key }), 'note-browser-canvas-filter');
          filter.dataset.canvasFilter = key; filter.setAttribute('aria-pressed', String((selection.key || 'all') === key)); filters.appendChild(filter);
        });
        const refresh = button(copy('refresh'), () => { if (!loading) refreshResults(); }, 'note-browser-canvas-filter'); filters.appendChild(refresh);
        fragment.appendChild(filters);
      }
      rows.forEach((note) => {
        if (resultProviderId === 'canvas') { fragment.appendChild(renderCanvas(note)); return; }
        const row = button('', () => openResultNote(note), 'note-browser-result');
        row.dataset.noteBrowserPath = note.path; row.classList.toggle('is-selected', note.path === selectedPath);
        const title = document.createElement('strong'); title.textContent = note.title;
        const excerpt = document.createElement('p'); excerpt.textContent = note.excerpt;
        const path = document.createElement('small'); path.textContent = note.path;
        const tags = document.createElement('span'); tags.className = 'note-browser-result-tags';
        (note.tags || []).forEach((tag) => { const item = document.createElement('span'); item.textContent = '#' + tag.label; tags.appendChild(item); });
        row.append(title, excerpt, tags, path); fragment.appendChild(row);
      });
      if (failed) fragment.appendChild(button(copy(failureCode === 'statistics_incomplete' ? 'incomplete' : 'failed'), () => { if (!loading) loadPage(failedReset); }, 'note-browser-message'));
      else if (loading && (!resetting || !hasResult)) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('loading'); fragment.appendChild(message); }
      else if (!rows.length) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy(resultProviderId === 'canvas' ? 'canvasEmpty' : 'empty'); fragment.appendChild(message); }
      else if (hasMore) fragment.appendChild(button(copy('more'), () => loadPage(false), 'note-browser-more'));
      results.replaceChildren(fragment); results.scrollTop = scroll;
    }
    async function loadPage(reset, preserveScroll) {
      if (!active || disposed || (!reset && loading)) return false;
      const sequence = ++pageSequence;
      const requestProviderId = providerId, requestSelection = selection, requestOffset = reset ? 0 : offset;
      cancelReferenceRequests();
      loading = true; resetting = reset; preservingScroll = !!preserveScroll; failed = false; failureCode = '';
      if (reset) dirty = true;
      results.setAttribute('aria-busy', 'true');
      // Keep the committed view intact until the replacement page is ready.
      if (!hasResult) { resultProviderId = requestProviderId; resultSelection = requestSelection; }
      if (!reset || !hasResult) renderResults();
      try {
        const result = await providers.get(requestProviderId).loadPage(ctx, requestSelection, requestOffset);
        if (!active || disposed || sequence !== pageSequence) return false;
        if (requestProviderId === 'canvas') canvasSignature = result.signature;
        rows = reset ? result.items || [] : rows.concat(result.items || []); total = result.total; hasMore = !!result.hasMore;
        resultProviderId = requestProviderId; resultSelection = requestSelection; hasResult = true;
        offset = requestOffset + (result.consumed ?? (result.items || []).length); dirty = false; loading = false; resetting = false;
        results.setAttribute('aria-busy', 'false'); renderResults();
        if (reset && !preserveScroll) { resultScroll = 0; results.scrollTop = 0; }
        return true;
      } catch (error) {
        if (!active || disposed || sequence !== pageSequence) return;
        failureCode = error.code || '';
        if (reset) {
          rows = []; offset = 0; total = 0; hasMore = false;
          resultProviderId = requestProviderId; resultSelection = requestSelection;
        }
        hasResult = true; loading = false; resetting = false; failed = true; failedReset = reset;
        results.setAttribute('aria-busy', 'false'); renderResults();
        if (reset && !preserveScroll) { resultScroll = 0; results.scrollTop = 0; }
        return false;
      }
    }
    async function refreshResults() {
      const preserveScroll = (!resetting || preservingScroll) && resultProviderId === providerId && resultSelection.key === selection.key;
      const pages = preserveScroll ? Math.max(1, Math.ceil(offset / 50)) : 1, scroll = preserveScroll ? (results.hidden ? resultScroll : results.scrollTop) : 0;
      let sequence = pageSequence + 1;
      if (!(await loadPage(true, preserveScroll)) || sequence !== pageSequence) return;
      for (let page = 1; page < pages && hasMore; page++) {
        sequence++;
        if (!(await loadPage(false)) || sequence !== pageSequence) return;
      }
      resultScroll = scroll; results.scrollTop = scroll;
    }
    async function select(id, next) {
      if (providers.get(id)?.enabled && !providers.get(id).enabled(ctx)) return;
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      cancelReferenceRequests();
      providerId = id; selection = next; selectedPath = ''; showResults(); renderNavigation();
      await loadPage(true);
    }
    const onBack = async () => {
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      showResults(); renderResults(); results.scrollTop = resultScroll;
      if (dirty || providerId === 'canvas') await refreshResults();
    };
    async function checkExternalCanvases() {
      if (!canvasInteractive() || loading || checkingCanvases || !ctx.canvasEnabled?.()) return;
      checkingCanvases = true;
      const sequence = pageSequence, key = selection.key || 'all';
      try {
        const result = await ctx.request('/api/notes-canvas/list?filter=' + key + '&limit=50');
        if (!canvasInteractive() || loading || sequence !== pageSequence || key !== (selection.key || 'all')) return;
        if (result.signature !== canvasSignature || failed) await refreshResults();
      } catch (error) {
        if (!canvasInteractive() || loading || sequence !== pageSequence) return;
        if (!failed || failureCode !== error.code) {
          rows = []; total = 0; offset = 0; hasMore = false; dirty = true;
          failed = true; failedReset = true; failureCode = error.code || ''; renderResults();
        }
      } finally { checkingCanvases = false; }
    }
    back.addEventListener('click', onBack);
    return {
      async activate(options) {
        if (disposed) return;
        active = true;
        if (options && options.tag) { providerId = 'tags'; selection = { key: options.tag, label: options.tag }; expanded.add('tags'); dirty = true; }
        renderNavigation(); showResults();
        if (providerId === 'canvas' && hasResult) await refreshResults();
        else if (dirty || !rows.length) await loadPage(true); else renderResults();
        await loadNavigation();
      },
      suspend(options) { active = false; cancelReferenceRequests(); pageSequence++; navigationSequences.forEach((value, key) => navigationSequences.set(key, value + 1)); actionSequence++; navigationGroups.forEach((group) => { cancelAnimationFrame(group.frame); clearTimeout(group.timer); }); if (loading) dirty = true; loading = false; resetting = false; results.setAttribute('aria-busy', 'false'); if (!(options && options.keepView)) { showDocument(); back.hidden = true; } },
      resume() { active = true; renderNavigation(); if (!results.hidden && dirty) refreshResults(); loadNavigation(); },
      dispose() { this.suspend(); disposed = true; back.removeEventListener('click', onBack); nav.replaceChildren(); results.replaceChildren(); },
      setLanguage() { renderNavigation(); renderResults(); updateBackLabel(); },
      showDocument,
      checkExternalCanvases,
      invalidate() { dirty = true; providers.forEach((provider) => navigationDirty.add(provider.id)); if (active) { if (!results.hidden) refreshResults(); loadNavigation(); } },
    };
  }
  window.RelatumNoteBrowser = { create, registerProvider };
})();

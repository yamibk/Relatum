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
  Object.assign(words['zh-CN'], { search: '搜索', searchHint: '搜索笔记、代码或短语…', allBooks: '全部笔记本', filters: '筛选', folder: '文件夹', tagFilter: '标签', after: '修改于', before: '截至', relevance: '相关性', modified: '最近修改', preparing: '正在整理笔记', typeToSearch: '输入关键词，或设置筛选条件', phraseHint: '空格分隔的关键词要求全部命中；双引号查找连续短语', clearFilters: '清除筛选' });
  Object.assign(words.en, { search: 'Search', searchHint: 'Search notes, code or phrases…', allBooks: 'All notebooks', filters: 'Filters', folder: 'Folder', tagFilter: 'Tags', after: 'Modified after', before: 'Through', relevance: 'Relevance', modified: 'Recently modified', preparing: 'Preparing notes', typeToSearch: 'Enter keywords or choose filters', phraseHint: 'All keywords must match. Use double quotes for a phrase.', clearFilters: 'Clear filters' });
  words.en.countOne = '1 note';
  words['zh-CN'].partialIndex = '部分笔记无法读取，结果不完整';
  words.en.partialIndex = 'Some notes could not be read. Results are incomplete.';
  registerProvider({ id: 'recent', label: 'recent', async loadPage(ctx, selection, offset, cursor) {
    return ctx.query({ mode: 'recent', recent: ctx.getRecent(), offset, cursor, limit: 50 });
  } });
  registerProvider({ id: 'tags', label: 'tags', async loadNavigation(ctx) { return (await ctx.request('/api/note-tags')).items || []; },
    loadPage(ctx, selection, offset, cursor) { return ctx.query({ tag: selection.key, offset, cursor, limit: 50 }); } });
  registerProvider({ id: 'canvas', label: 'canvas', enabled: ctx => !!ctx.canvasEnabled?.(),
    loadPage(ctx, selection, offset) { return ctx.request('/api/notes-canvas/list?filter=' + (selection.key || 'all') + '&offset=' + offset + '&limit=50'); } });
  registerProvider({ id: 'search', label: 'search', loadPage(ctx, selection, offset, cursor) {
    if (!selection.q?.trim() && !selection.tags?.length && !selection.modified?.after && !selection.modified?.before && selection.scope?.kind !== 'folder') {
      return Promise.resolve({ items: [], total: 0, hasMore: false });
    }
    const { signal, q, scope, tags, modified, sort } = selection;
    return ctx.query({ mode: 'search', limit: 50, offset, cursor, q, scope, tags, modified, sort }, { signal });
  } });

  function createFolderPicker(input, getLabel, isActive) {
    const host = input.parentElement;
    host.classList.add('note-search-folder-field');
    input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'note-search-folder-list'); input.setAttribute('aria-expanded', 'false');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'note-search-folder-toggle'; toggle.tabIndex = -1;
    toggle.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'note-search-folder-menu'; menu.hidden = true;
    const rows = document.createElement('div'); rows.id = 'note-search-folder-list'; rows.setAttribute('role', 'listbox');
    menu.appendChild(rows); host.append(toggle, menu);
    let availablePaths = [], paths = [], activeIndex = -1, activeRow = null, list = null, optionId = 0;
    let wheelTarget = null, wheelDirection = 0;
    let anchorTop = 0, anchorLeft = 0;
    const indexes = new Map(), mounted = new Map();
    function stopWheel() {
      menu.scrollTo({ top: menu.scrollTop, behavior: 'instant' }); wheelTarget = null; wheelDirection = 0;
    }
    function close() {
      if (menu.hidden) return;
      stopWheel(); menu.hidden = true; list?.dispose(); list = null;
      rows.replaceChildren(); paths = []; indexes.clear(); mounted.clear(); activeRow = null; activeIndex = -1;
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', close); window.removeEventListener('scroll', ancestorScroll, true);
    }
    function outside(event) { if (!host.contains(event.target)) close(); }
    function ancestorScroll(event) {
      if (!event.target.contains?.(host)) return;
      const anchor = input.getBoundingClientRect();
      if (Math.abs(anchor.top - anchorTop) > .5 || Math.abs(anchor.left - anchorLeft) > .5) close();
    }
    function syncActive() {
      const next = activeIndex < 0 ? null : (list?.row(paths[activeIndex]) || mounted.get(paths[activeIndex]));
      if (next === activeRow) return;
      if (activeRow) activeRow.setAttribute('aria-selected', 'false');
      activeRow = next;
      if (next) { next.setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', next.id); }
      else input.removeAttribute('aria-activedescendant');
    }
    function option(path) {
      const row = document.createElement('div'); row.className = 'note-search-folder-option'; row.id = 'note-search-folder-option-' + (++optionId);
      row.dataset.folderPath = path; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false'); row.textContent = path;
      if (!list) mounted.set(path, row);
      return row;
    }
    function open() {
      if (!isActive() || !host.isConnected || document.hidden || document.documentElement.dataset.desktopMinimized === '1') { close(); return; }
      const value = input.value.trim().toLocaleLowerCase();
      const next = availablePaths.filter(path => !value || path.toLocaleLowerCase().includes(value));
      if (!next.length) { close(); return; }
      if (!menu.hidden && paths.length === next.length && paths.every((path, i) => path === next[i])) return;
      stopWheel(); paths = next; indexes.clear(); paths.forEach((path, i) => indexes.set(path, i));
      if (activeRow) activeRow.setAttribute('aria-selected', 'false');
      activeIndex = paths.indexOf(input.value); activeRow = null; input.removeAttribute('aria-activedescendant');
      menu.hidden = false;
      const anchor = input.getBoundingClientRect(), viewport = input.closest('.note-browser-results').getBoundingClientRect();
      anchorTop = anchor.top; anchorLeft = anchor.left;
      const below = viewport.bottom - anchor.bottom - 8, above = anchor.top - viewport.top - 8;
      const upwards = below < 160 && above > below;
      menu.classList.toggle('opens-up', upwards);
      menu.style.maxHeight = Math.max(32, Math.min(240, upwards ? above : below)) + 'px';
      if (paths.length > 200 && window.RelatumWindowedList) {
        if (!list) { mounted.clear(); rows.replaceChildren(); list = window.RelatumWindowedList.create({ host: rows, scroller: menu,
          estimate: 32, reuseRows: true, key: path => path, render: option, onMount: syncActive }); }
        list.setItems(paths);
      } else {
        list?.dispose(); list = null; mounted.clear(); rows.replaceChildren(...paths.map(option));
      }
      syncActive(); input.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
      window.addEventListener('resize', close); window.addEventListener('scroll', ancestorScroll, true);
    }
    function activate(index, reveal) {
      stopWheel(); activeIndex = Math.max(0, Math.min(paths.length - 1, index));
      if (reveal) {
        if (list) list.scrollToKey(paths[activeIndex]);
        else {
          const row = mounted.get(paths[activeIndex]);
          if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
          else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
        }
      }
      syncActive();
    }
    function choose(path) { input.value = path; close(); input.dispatchEvent(new Event('change', { bubbles: true })); }
    toggle.addEventListener('click', event => { event.preventDefault(); if (menu.hidden) { input.focus(); open(); } else close(); });
    input.addEventListener('click', open);
    input.addEventListener('input', event => { if (!event.isComposing) open(); });
    input.addEventListener('compositionstart', close); input.addEventListener('compositionend', open);
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Enter' && !menu.hidden && activeIndex >= 0) { event.preventDefault(); choose(paths[activeIndex]); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); open();
      if (!menu.hidden) activate(activeIndex < 0 ? event.key === 'ArrowDown' ? 0 : paths.length - 1 : activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
    });
    menu.addEventListener('pointerdown', event => { if (event.target.closest('[data-folder-path]')) event.preventDefault(); else stopWheel(); });
    menu.addEventListener('click', event => { const row = event.target.closest('[data-folder-path]'); if (row) { event.preventDefault(); choose(row.dataset.folderPath); } });
    menu.addEventListener('pointermove', event => { const row = event.target.closest('[data-folder-path]'); const index = row && indexes.get(row.dataset.folderPath); if (index !== undefined && row) { activeIndex = index; syncActive(); } });
    menu.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey || !event.deltaY) return;
      // Fine touchpad samples retain native scrolling; wheel detents accumulate
      // one target and use the browser's finite smooth-scroll animation.
      if (!event.deltaMode && Math.abs(event.deltaY) < 40) { stopWheel(); return; }
      event.preventDefault();
      const direction = Math.sign(event.deltaY), amount = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? menu.clientHeight : 1);
      if (wheelTarget === null || direction !== wheelDirection) wheelTarget = menu.scrollTop;
      wheelDirection = direction; wheelTarget = Math.max(0, Math.min(menu.scrollHeight - menu.clientHeight, wheelTarget + amount));
      menu.scrollTo({ top: wheelTarget, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, { passive: false });
    menu.addEventListener('scrollend', () => { if (wheelTarget !== null && Math.abs(menu.scrollTop - wheelTarget) < 1) { wheelTarget = null; wheelDirection = 0; } });
    return { close, setPaths(next) {
      if (availablePaths.length === next.length && availablePaths.every((path, i) => path === next[i])) return;
      availablePaths = next; if (!menu.hidden) open();
    }, setLanguage() { toggle.setAttribute('aria-label', getLabel()); rows.setAttribute('aria-label', getLabel()); } };
  }

  function create(ctx) {
    const root = ctx.root, nav = ctx.navigation, results = ctx.results, back = ctx.back;
    let active = false, navigationOpen = false, disposed = false;
    const expanded = new Set(), navigation = new Map(), navigationDirty = new Set(providers.keys()), navigationSequences = new Map();
    const navigationLoading = new Set();
    const navigationGroups = new Map();
    let providerId = 'recent', selection = {}, rows = [], offset = 0, total = 0, hasMore = false, selectedPath = '';
    let pageSequence = 0, actionSequence = 0, loading = false, failed = false, dirty = true;
    let resultProviderId = providerId, resultSelection = selection, hasResult = false, resetting = false, preservingScroll = false, failedReset = false;
    let resultScroll = 0;
    let resultCursor = null;
    let canvasSignature = '', failureCode = '', referenceEpoch = 0, checkingCanvases = false;
    let referenceHostId = 0;
    let searchTimer = 0, searchAbort = null, resultList = null, indexState = null;
    const searchState = { q: '', scope: { kind: 'all' }, tags: [], modified: {}, sort: 'relevance' };
    let controls = null, searchInput = null, scopeInput = null, filterPanel = null, sortInput = null;
    let folderInput = null, tagsInput = null, afterInput = null, beforeInput = null, filtersButton = null;
    let searchComposing = false;
    let folderPicker = null;
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
    function showDocument(options) {
      folderPicker?.close();
      if (!options?.keepAction) actionSequence++;
      cancelReferenceRequests();
      if (loading) { pageSequence++; dirty = true; loading = false; resetting = false; results.setAttribute('aria-busy', 'false'); }
      if (!results.hidden) resultScroll = results.scrollTop;
      ctx.showResults(false); results.hidden = true; results.inert = true;
      back.hidden = !active || !hasResult; updateBackLabel();
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
            if (!active || !navigationOpen) return;
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
          if (ctx.icon) heading.appendChild(ctx.icon(provider.id === 'search' ? 'search' : provider.id === 'canvas' ? 'square-pen' : provider.id === 'tags' ? 'hash' : hierarchical ? 'folder' : 'clock-3', 'note-browser-icon'));
          heading.appendChild(label); wrapper.appendChild(heading);
          const shell = document.createElement('div'); shell.className = 'note-tree-children-shell';
          const children = document.createElement('div'); children.className = 'note-tree-children'; shell.appendChild(children);
          if (hierarchical) wrapper.appendChild(shell);
          group = { wrapper, heading, label, shell, children, rows: new Map(), open: false, items: null, frame: 0, timer: 0 };
          navigationGroups.set(provider.id, group); nav.appendChild(wrapper);
        }
        const { heading, shell, children } = group;
        group.label.textContent = copy(provider.label);
        heading.classList.toggle('is-selected', (hasResult || !results.hidden) && providerId === provider.id && !hierarchical);
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
            const row = button('', () => { if (navigationOpen) select(provider.id, item.tag); }); row.classList.add('note-browser-tag-row');
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
            if (!active || !navigationOpen || !expanded.has(provider.id)) return;
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
      if (!active || !navigationOpen || !expanded.has(id) || !navigationDirty.has(id) || navigationLoading.has(id)) return;
      const sequence = (navigationSequences.get(id) || 0) + 1; navigationSequences.set(id, sequence);
      navigationLoading.add(id);
      const group = navigationGroups.get(id);
      if (group && group.error) { group.error.remove(); group.error = null; }
      try {
        const items = await providers.get(id).loadNavigation(ctx);
        if (!active || !navigationOpen || disposed || sequence !== navigationSequences.get(id)) return;
        navigation.set(id, items); navigationDirty.delete(id); renderNavigation(group && group.waitingOnOpen ? id : undefined);
        if (group) group.waitingOnOpen = false;
      } catch (error) {
        if (active && navigationOpen && sequence === navigationSequences.get(id) && group) {
          group.error = button(copy('failed'), () => loadNavigation(id), 'note-browser-message'); group.wrapper.appendChild(group.error);
        }
      } finally { if (sequence === navigationSequences.get(id)) navigationLoading.delete(id); }
    }
    function cancelNavigation() {
      navigationSequences.forEach((value, key) => navigationSequences.set(key, value + 1)); navigationLoading.clear();
      navigationGroups.forEach((group) => { cancelAnimationFrame(group.frame); clearTimeout(group.timer); });
    }
    function setNavigationOpen(open) {
      navigationOpen = !!open;
      if (!navigationOpen) cancelNavigation();
      else if (active) { renderNavigation(); loadNavigation(); }
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
      const target = resultProviderId === 'search' ? Object.assign({}, note, { searchQuery: {
        q: resultSelection.q, scope: resultSelection.scope, tags: resultSelection.tags,
        modified: resultSelection.modified, sort: resultSelection.sort,
      } }) : note;
      if (await ctx.openNote(note.path, target) && active && sequence === actionSequence) {
        selectedPath = note.path; showDocument({ keepAction: true }); root.classList.remove('tree-overlay-open');
      }
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
    function searchControls() {
      if (!controls) {
        controls = document.createElement('div'); controls.className = 'note-search-controls';
        const field = document.createElement('div'); field.className = 'note-search-field';
        if (ctx.icon) field.appendChild(ctx.icon('search'));
        searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.dataset.noteSearch = 'query';
        searchInput.autocomplete = 'off'; searchInput.spellcheck = false;
        field.appendChild(searchInput);
        const tools = document.createElement('div'); tools.className = 'note-search-tools';
        scopeInput = document.createElement('select'); scopeInput.dataset.noteSearch = 'scope';
        sortInput = document.createElement('select'); sortInput.dataset.noteSearch = 'sort';
        filtersButton = button('', () => {
          filterPanel.hidden = !filterPanel.hidden;
          if (filterPanel.hidden) folderPicker?.close();
          filtersButton.setAttribute('aria-expanded', String(!filterPanel.hidden));
          if (!filterPanel.hidden) tagsInput.focus();
        }, 'note-search-filter-button'); filtersButton.setAttribute('aria-expanded', 'false');
        tools.append(scopeInput, sortInput, filtersButton);
        filterPanel = document.createElement('div'); filterPanel.className = 'note-search-filters'; filterPanel.hidden = true;
        const input = (name, type = 'text') => {
          const label = document.createElement('label'), span = document.createElement('span'), field = document.createElement('input');
          field.type = type; field.dataset.noteSearch = name; label.append(span, field); filterPanel.appendChild(label); return field;
        };
        folderInput = input('folder'); tagsInput = input('tags'); afterInput = input('after', 'date'); beforeInput = input('before', 'date');
        folderPicker = createFolderPicker(folderInput, () => copy('folder'),
          () => active && !disposed && !results.hidden && !filterPanel.hidden);
        const clear = button('', () => {
          folderPicker.close();
          for (const input of [folderInput, tagsInput, afterInput, beforeInput]) input.value = '';
          syncSearchFilters(); runSearch(0);
        }, 'note-search-clear'); clear.dataset.noteSearch = 'clear'; filterPanel.appendChild(clear);
        controls.append(field, tools, filterPanel);
        searchInput.addEventListener('compositionstart', () => { searchComposing = true; clearTimeout(searchTimer); searchAbort?.abort(); });
        searchInput.addEventListener('compositionend', () => { searchComposing = false; searchState.q = searchInput.value; runSearch(150); });
        searchInput.addEventListener('input', () => { searchState.q = searchInput.value; if (!searchComposing) runSearch(150); });
        searchInput.addEventListener('keydown', event => {
          if (event.isComposing || searchComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); runSearch(0); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('.note-browser-result')?.focus(); }
          else if (event.key === 'Escape') { event.preventDefault(); if (!filterPanel.hidden) { folderPicker.close(); filterPanel.hidden = true; filtersButton.setAttribute('aria-expanded', 'false'); } else { searchInput.value = ''; searchState.q = ''; runSearch(0); } }
        });
        for (const input of [scopeInput, sortInput, folderInput, tagsInput, afterInput, beforeInput]) {
          input.addEventListener('change', () => { if (input === scopeInput) { folderPicker.close(); folderInput.value = ''; } syncSearchFilters(); if (!searchComposing) runSearch(0); });
          if (input.type === 'text') {
            input.addEventListener('input', () => { syncSearchFilters(); if (!searchComposing) runSearch(150); });
            input.addEventListener('compositionstart', () => { searchComposing = true; clearTimeout(searchTimer); searchAbort?.abort(); });
            input.addEventListener('compositionend', () => { searchComposing = false; syncSearchFilters(); runSearch(150); });
          }
        }
      }
      searchInput.placeholder = copy('searchHint'); searchInput.title = copy('phraseHint'); searchInput.setAttribute('aria-label', copy('search'));
      const selected = scopeInput.value || 'all';
      scopeInput.replaceChildren();
      const add = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; scopeInput.appendChild(option); };
      add('all', copy('allBooks'));
      (ctx.getNotebooks?.() || []).forEach(book => add('b:' + book.path, book.name));
      scopeInput.value = Array.from(scopeInput.options).some(option => option.value === selected) ? selected : 'all';
      scopeInput.setAttribute('aria-label', copy('allBooks'));
      folderPicker.setLanguage();
      folderPicker.setPaths((ctx.getEntries?.() || []).filter(item => item.kind === 'folder' && item.path !== 'CustomNotebook').map(item => item.path));
      sortInput.replaceChildren(...['relevance', 'modified'].map(key => { const option = document.createElement('option'); option.value = key === 'modified' ? 'modified-desc' : key; option.textContent = copy(key); return option; }));
      sortInput.value = searchState.sort; sortInput.setAttribute('aria-label', copy('relevance'));
      filtersButton.textContent = copy('filters');
      for (const [input, label] of [[folderInput, 'folder'], [tagsInput, 'tagFilter'], [afterInput, 'after'], [beforeInput, 'before']]) {
        input.previousSibling.textContent = copy(label); input.setAttribute('aria-label', copy(label));
      }
      filterPanel.querySelector('[data-note-search="clear"]').textContent = copy('clearFilters');
      return controls;
    }
    function syncSearchFilters() {
      let folder = folderInput.value.trim().replace(/\\/g, '/');
      const notebook = scopeInput.value.startsWith('b:') ? scopeInput.value.slice(2) : '';
      if (folder && notebook && !/^CustomNotebook(?:\/|$)/i.test(folder)) folder = notebook + '/' + folder;
      searchState.scope = folder ? { kind: 'folder', path: folder }
        : scopeInput.value.startsWith('b:') ? { kind: 'notebook', path: scopeInput.value.slice(2) } : { kind: 'all' };
      searchState.tags = tagsInput.value.split(/[\s,，]+/).map(tag => tag.replace(/^#/, '')).filter(Boolean);
      searchState.sort = sortInput.value;
      searchState.modified = {};
      if (afterInput.value) searchState.modified.after = new Date(afterInput.value + 'T00:00:00').getTime() * 1e6;
      if (beforeInput.value) { const date = new Date(beforeInput.value + 'T00:00:00'); date.setDate(date.getDate() + 1); searchState.modified.before = date.getTime() * 1e6; }
    }
    function runSearch(delay) {
      clearTimeout(searchTimer); searchAbort?.abort(); pageSequence++;
      searchTimer = setTimeout(() => {
        searchTimer = 0;
        if (!active || disposed || providerId !== 'search' || searchComposing) return;
        searchAbort = new AbortController();
        selection = Object.assign({}, searchState, { signal: searchAbort.signal });
        loadPage(true);
      }, delay);
    }
    function noteRow(note) {
      const row = button('', () => openResultNote(note), 'note-browser-result');
      row.dataset.noteBrowserPath = note.path; row.classList.toggle('is-selected', note.path === selectedPath);
      const highlight = (target, value, ranges) => {
        let position = 0;
        for (const [from, to] of (ranges || []).slice().sort((a, b) => a[0] - b[0])) {
          if (from < position) continue;
          target.append(document.createTextNode(value.slice(position, from)));
          const mark = document.createElement('mark'); mark.textContent = value.slice(from, to); target.append(mark); position = to;
        }
        target.append(document.createTextNode(value.slice(position)));
      };
      const title = document.createElement('strong'); highlight(title, note.title, note.titleHighlights);
      const excerpt = document.createElement('p');
      const ranges = (note.highlights || []).slice().sort((a, b) => a[0] - b[0]); let position = 0;
      for (const [from, to] of ranges) {
        if (from < position) continue;
        excerpt.appendChild(document.createTextNode(note.excerpt.slice(position, from)));
        const mark = document.createElement('mark'); mark.textContent = note.excerpt.slice(from, to); excerpt.appendChild(mark); position = to;
      }
      excerpt.appendChild(document.createTextNode((note.excerpt || '').slice(position)));
      const path = document.createElement('small'); highlight(path, note.path, note.pathHighlights);
      const tags = document.createElement('span'); tags.className = 'note-browser-result-tags';
      (note.tags || []).forEach(tag => { const item = document.createElement('span'); item.textContent = '#' + tag.label; tags.appendChild(item); });
      row.append(title, excerpt, tags, path); return row;
    }
    function renderResults() {
      cancelReferenceRequests();
      const scroll = results.scrollTop;
      const fragment = document.createDocumentFragment();
      const heading = document.createElement('header'); heading.className = 'note-browser-results-head';
      const title = document.createElement('h2'); title.textContent = resultProviderId === 'tags' ? '#' + (resultSelection.label || resultSelection.key) : resultSelection.label || copy(providers.get(resultProviderId).label);
      const count = document.createElement('span'); count.textContent = copy(resultProviderId === 'canvas' ? total === 1 && ctx.language() === 'en' ? 'canvasCountOne' : 'canvasCount' : total === 1 && ctx.language() === 'en' ? 'countOne' : 'count').replace('{count}', total);
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
      const listHost = document.createElement('div'); listHost.className = 'note-browser-list'; fragment.appendChild(listHost);
      resultList?.dispose(); resultList = null;
      if (rows.length > 200 && resultProviderId !== 'canvas' && window.RelatumWindowedList) {
        resultList = window.RelatumWindowedList.create({ host: listHost, scroller: results, estimate: 118, key: note => note.path, render: noteRow });
      } else rows.forEach((note) => {
        if (resultProviderId === 'canvas') { fragment.appendChild(renderCanvas(note)); return; }
        listHost.appendChild(noteRow(note));
      });
      if (failed) fragment.appendChild(button(copy(failureCode === 'statistics_incomplete' ? 'incomplete' : 'failed'), () => { if (!loading) loadPage(failedReset); }, 'note-browser-message'));
      else if (loading && (!resetting || !hasResult)) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('loading'); fragment.appendChild(message); }
      else if (!rows.length) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy(resultProviderId === 'search' && !searchState.q.trim() && !searchState.tags.length ? 'typeToSearch' : resultProviderId === 'canvas' ? 'canvasEmpty' : 'empty'); fragment.appendChild(message); }
      else if (hasMore) fragment.appendChild(button(copy('more'), () => loadPage(false), 'note-browser-more'));
      if (indexState && indexState.phase !== 'ready') { const message = document.createElement('p'); message.className = 'note-search-progress'; message.setAttribute('role', 'status'); message.textContent = indexState.phase === 'partial' ? copy('partialIndex') : copy('preparing') + ' · ' + indexState.indexed + ' / ' + indexState.total; fragment.appendChild(message); }
      if (resultProviderId === 'search') {
        const control = searchControls();
        let shell = results.querySelector('.note-search-result-shell');
        if (!shell) { shell = document.createElement('div'); shell.className = 'note-search-result-shell'; results.replaceChildren(control, shell); }
        shell.replaceChildren(fragment);
      } else results.replaceChildren(fragment);
      resultList?.setItems(rows); results.scrollTop = scroll;
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
        const result = await providers.get(requestProviderId).loadPage(ctx, requestSelection, requestOffset, reset ? null : resultCursor);
        if (!active || disposed || sequence !== pageSequence) return false;
        if (requestProviderId === 'canvas') canvasSignature = result.signature;
        indexState = result.index || ctx.getIndexState?.();
        if (result.missingRecent) ctx.pruneRecent?.(result.missingRecent);
        resultCursor = result.cursor || null;
        rows = reset ? result.items || [] : rows.concat(result.items || []); total = result.total; hasMore = !!result.hasMore;
        resultProviderId = requestProviderId; resultSelection = requestSelection; hasResult = true;
        offset = requestOffset + (result.consumed ?? (result.items || []).length); dirty = false; loading = false; resetting = false;
        results.setAttribute('aria-busy', 'false'); renderResults();
        if (reset && !preserveScroll) { resultScroll = 0; results.scrollTop = 0; }
        return true;
      } catch (error) {
        if (!active || disposed || sequence !== pageSequence) return;
        if (error.name === 'AbortError') { loading = false; return; }
        if (error.code === 'query_changed' && !reset) { loading = false; return loadPage(true, true); }
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
      folderPicker?.close();
      if (!active || disposed) return;
      if (providers.get(id)?.enabled && !providers.get(id).enabled(ctx)) return;
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      cancelReferenceRequests();
      providerId = id; selection = id === 'search' ? Object.assign({}, searchState, next) : next; selectedPath = ''; showResults(); renderNavigation();
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
      activate(options) {
        if (disposed) return;
        active = true;
        setNavigationOpen(!!options?.navigationOpen);
      },
      async browseTag(tag) { expanded.add('tags'); if (navigationOpen) { renderNavigation(); loadNavigation(); } await select('tags', { key: tag, label: tag }); },
      async search() { await select('search', Object.assign({}, searchState)); searchInput?.focus(); },
      setNavigationOpen,
      suspend(options) { folderPicker?.close(); active = false; clearTimeout(searchTimer); searchAbort?.abort(); resultList?.suspend(); cancelReferenceRequests(); pageSequence++; cancelNavigation(); actionSequence++; if (loading) dirty = true; loading = false; resetting = false; results.setAttribute('aria-busy', 'false'); if (!(options && options.keepView)) { showDocument(); back.hidden = true; } },
      resume() { active = true; resultList?.resume(); if (navigationOpen) renderNavigation(); if (!results.hidden && dirty) refreshResults(); loadNavigation(); },
      dispose() { this.suspend(); resultList?.dispose(); disposed = true; back.removeEventListener('click', onBack); nav.replaceChildren(); results.replaceChildren(); },
      setLanguage() { renderNavigation(); if (hasResult) renderResults(); updateBackLabel(); },
      showDocument,
      checkExternalCanvases,
      invalidate() { dirty = true; providers.forEach((provider) => navigationDirty.add(provider.id)); if (active) { if (!results.hidden) refreshResults(); loadNavigation(); } },
    };
  }
  window.RelatumNoteBrowser = { create, registerProvider };
})();

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
  registerProvider({ id: 'recent', label: 'recent', async loadPage(ctx, selection, offset) {
    const recent = ctx.getRecent();
    const files = ctx.getEntries().filter((entry) => entry.kind === 'note');
    files.sort((a, b) => Math.max(Number(b.modifiedNs) / 1e6, recent[b.path] || 0) - Math.max(Number(a.modifiedNs) / 1e6, recent[a.path] || 0) || a.path.localeCompare(b.path));
    const result = await ctx.query({ paths: files.slice(offset, offset + 50).map((entry) => entry.path) });
    return Object.assign(result, { total: files.length, hasMore: offset + 50 < files.length, consumed: Math.min(50, files.length - offset) });
  } });
  registerProvider({ id: 'tags', label: 'tags', async loadNavigation(ctx) { return (await ctx.request('/api/note-tags')).items || []; },
    loadPage(ctx, selection, offset) { return ctx.query({ tag: selection.key, offset, limit: 50 }); } });

  function create(ctx) {
    const root = ctx.root, nav = ctx.navigation, results = ctx.results, back = ctx.back;
    let active = false, disposed = false;
    const expanded = new Set(), navigation = new Map(), navigationDirty = new Set(providers.keys()), navigationSequences = new Map();
    const navigationGroups = new Map();
    let providerId = 'recent', selection = {}, rows = [], offset = 0, total = 0, hasMore = false, selectedPath = '';
    let pageSequence = 0, actionSequence = 0, loading = false, failed = false, dirty = true;
    let resultScroll = 0;
    const copy = (key) => (words[ctx.language()] || words['zh-CN'])[key] || key;
    function button(label, handler, className) {
      const node = document.createElement('button'); node.type = 'button'; node.className = className || 'note-browser-nav-row';
      node.textContent = label; node.addEventListener('click', handler); return node;
    }
    function showResults() {
      root.classList.remove('tree-overlay-open');
      ctx.showResults(true); back.hidden = true;
      results.hidden = false; results.inert = false;
      results.scrollTop = resultScroll;
    }
    function showDocument() {
      if (!results.hidden) resultScroll = results.scrollTop;
      ctx.showResults(false); results.hidden = true; results.inert = true;
      back.hidden = !active; updateBackLabel();
    }
    function updateBackLabel() { back.replaceChildren(...(ctx.icon ? [ctx.icon('arrow-left')] : []), document.createTextNode(copy('return'))); }
    function renderNavigation(animateId) {
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      nav.setAttribute('aria-label', copy('untitled'));
      providers.forEach((provider) => {
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
          if (ctx.icon) heading.appendChild(ctx.icon(provider.id === 'tags' ? 'hash' : hierarchical ? 'folder' : 'clock-3', 'note-browser-icon'));
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
    function renderResults() {
      const scroll = results.scrollTop;
      const fragment = document.createDocumentFragment();
      const heading = document.createElement('header'); heading.className = 'note-browser-results-head';
      const mobile = button('', () => root.classList.toggle('tree-overlay-open'), 'note-mobile-pane-button');
      if (ctx.icon) mobile.appendChild(ctx.icon('panel-left'));
      mobile.setAttribute('aria-label', ctx.language() === 'en' ? 'Show note navigation' : '显示笔记导航');
      mobile.title = mobile.getAttribute('aria-label');
      const title = document.createElement('h2'); title.textContent = providerId === 'tags' ? '#' + (selection.label || selection.key) : selection.label || copy(providers.get(providerId).label);
      const count = document.createElement('span'); count.textContent = copy('count').replace('{count}', total);
      heading.append(mobile, title, count); fragment.appendChild(heading);
      rows.forEach((note) => {
        const row = button('', async () => {
          const sequence = ++actionSequence;
          if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
          if (await ctx.openNote(note.path)) { selectedPath = note.path; showDocument(); root.classList.remove('tree-overlay-open'); }
        }, 'note-browser-result');
        row.dataset.noteBrowserPath = note.path; row.classList.toggle('is-selected', note.path === selectedPath);
        const title = document.createElement('strong'); title.textContent = note.title;
        const excerpt = document.createElement('p'); excerpt.textContent = note.excerpt;
        const path = document.createElement('small'); path.textContent = note.path;
        const tags = document.createElement('span'); tags.className = 'note-browser-result-tags';
        (note.tags || []).forEach((tag) => { const item = document.createElement('span'); item.textContent = '#' + tag.label; tags.appendChild(item); });
        row.append(title, excerpt, tags, path); fragment.appendChild(row);
      });
      if (failed) fragment.appendChild(button(copy('failed'), () => loadPage(offset === 0), 'note-browser-message'));
      else if (loading) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('loading'); fragment.appendChild(message); }
      else if (!rows.length) { const message = document.createElement('p'); message.className = 'note-browser-message'; message.textContent = copy('empty'); fragment.appendChild(message); }
      else if (hasMore) fragment.appendChild(button(copy('more'), () => loadPage(false), 'note-browser-more'));
      results.replaceChildren(fragment); results.scrollTop = scroll;
    }
    async function loadPage(reset, preserveScroll) {
      const sequence = ++pageSequence;
      if (reset) { offset = 0; rows = []; total = 0; if (!preserveScroll) { resultScroll = 0; results.scrollTop = 0; } }
      loading = true; failed = false; renderResults();
      try {
        const result = await providers.get(providerId).loadPage(ctx, selection, offset);
        if (!active || disposed || sequence !== pageSequence) return false;
        rows = rows.concat(result.items || []); total = result.total; hasMore = !!result.hasMore;
        offset += result.consumed ?? (result.items || []).length; dirty = false; loading = false; renderResults();
        return true;
      } catch (error) {
        if (!active || disposed || sequence !== pageSequence) return;
        loading = false; failed = true; renderResults();
        return false;
      }
    }
    async function refreshResults() {
      const pages = Math.max(1, Math.ceil(offset / 50)), scroll = results.hidden ? resultScroll : results.scrollTop;
      if (!(await loadPage(true, true))) return;
      for (let page = 1; page < pages && hasMore; page++) if (!(await loadPage(false))) return;
      resultScroll = scroll; results.scrollTop = scroll;
    }
    async function select(id, next) {
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      providerId = id; selection = next; selectedPath = ''; showResults(); renderNavigation();
      await loadPage(true);
    }
    const onBack = async () => {
      if (!(await ctx.beforeBrowse()) || !active) return;
      showResults(); renderResults(); results.scrollTop = resultScroll;
      if (dirty) await refreshResults();
    };
    back.addEventListener('click', onBack);
    return {
      async activate(options) {
        if (disposed) return;
        active = true;
        if (options && options.tag) { providerId = 'tags'; selection = { key: options.tag, label: options.tag }; expanded.add('tags'); dirty = true; }
        renderNavigation(); showResults();
        if (dirty || !rows.length) await loadPage(true); else renderResults();
        await loadNavigation();
      },
      suspend(options) { active = false; pageSequence++; navigationSequences.forEach((value, key) => navigationSequences.set(key, value + 1)); actionSequence++; navigationGroups.forEach((group) => { cancelAnimationFrame(group.frame); clearTimeout(group.timer); }); if (loading) dirty = true; loading = false; if (!(options && options.keepView)) { showDocument(); back.hidden = true; } },
      resume() { active = true; renderNavigation(); if (!results.hidden && dirty) refreshResults(); loadNavigation(); },
      dispose() { this.suspend(); disposed = true; back.removeEventListener('click', onBack); nav.replaceChildren(); results.replaceChildren(); },
      setLanguage() { renderNavigation(); renderResults(); updateBackLabel(); },
      showDocument,
      invalidate() { dirty = true; providers.forEach((provider) => navigationDirty.add(provider.id)); if (active) { if (!results.hidden) refreshResults(); loadNavigation(); } },
    };
  }
  window.RelatumNoteBrowser = { create, registerProvider };
})();

// Current-note navigation. Loaded only when the Outline sidebar is visible.
(function () {
  'use strict';
  const copy = {
    title: ['大纲', 'Outline'], open: ['打开笔记以查看大纲', 'Open a note to view its outline'],
    empty: ['当前笔记没有标题', 'This note has no headings'], loading: ['正在生成大纲…', 'Building outline…'],
    failed: ['大纲暂时无法加载，点击重试', 'Outline unavailable. Click to retry'],
    expand: ['展开子标题', 'Expand subheadings'], collapse: ['收起子标题', 'Collapse subheadings'],
  };

  function headingAt(headings, position) {
    let low = 0, high = headings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (headings[middle].from <= position) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  // Conservatively map an unchanged heading across native input settlement.
  // If the target itself changed, abandon the old click instead of guessing by
  // title text (which is not unique).
  function mapHeadingPosition(heading, before, after) {
    if (before === after) return heading.from;
    let prefix = 0, suffix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    while (suffix < before.length - prefix && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    let from;
    if (heading.to <= prefix) from = heading.from;
    else if (heading.from >= before.length - suffix) from = heading.from + after.length - before.length;
    else return null;
    return after.slice(from, from + heading.to - heading.from) === before.slice(heading.from, heading.to) ? from : null;
  }

  function create(host, options) {
    let active = false, epoch = 0, navigationEpoch = 0, timer = 0, frame = 0;
    let documentState = null, headings = [], rows = new Map(), structure = '', currentKey = '', focusedKey = '';
    let surface = null, readingPositions = null, resizeObserver = null, mutationObserver = null;
    const sessions = new Map();
    const text = key => copy[key][options.language() === 'en' ? 1 : 0];
    const pending = () => options.inputPending && options.inputPending();
    const session = path => {
      if (!sessions.has(path)) sessions.set(path, { collapsed: new Set(), scrollTop: 0 });
      const value = sessions.get(path); sessions.delete(path); sessions.set(path, value);
      while (sessions.size > 24) sessions.delete(sessions.keys().next().value);
      return value;
    };
    function cancel() {
      epoch++; clearTimeout(timer); timer = 0;
      host.removeAttribute('aria-busy');
    }
    function status(kind) {
      const value = text(kind);
      if (host.dataset.outlineStatus === kind && host.firstChild?.textContent === value) return;
      const item = document.createElement(kind === 'failed' ? 'button' : 'p');
      item.className = 'note-outline-status'; item.textContent = value;
      if (kind === 'failed') { item.type = 'button'; item.addEventListener('click', () => refresh(0)); }
      host.replaceChildren(item); host.dataset.outlineStatus = kind;
      rows.clear(); structure = ''; currentKey = ''; focusedKey = '';
    }
    function detachSurface() {
      if (surface?.scroller) {
        surface.scroller.removeEventListener('scroll', scheduleHighlight);
        surface.scroller.removeEventListener('load', geometryChanged, true);
      }
      resizeObserver?.disconnect(); mutationObserver?.disconnect();
      resizeObserver = null; mutationObserver = null; surface = null; readingPositions = null;
    }
    function geometryChanged() { readingPositions = null; scheduleHighlight(); }
    function bindSurface() {
      const next = options.getSurface();
      if (next?.scroller === surface?.scroller && next?.kind === surface?.kind) return;
      detachSurface(); surface = next;
      if (!surface?.scroller) return;
      surface.scroller.addEventListener('scroll', scheduleHighlight, { passive: true });
      surface.scroller.addEventListener('load', geometryChanged, true);
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(geometryChanged);
        resizeObserver.observe(surface.scroller);
        if (surface.scroller.firstElementChild) resizeObserver.observe(surface.scroller.firstElementChild);
      }
      if (surface.kind === 'reading') {
        mutationObserver = new MutationObserver(() => {
          resizeObserver?.disconnect();
          resizeObserver?.observe(surface.scroller);
          if (surface.scroller.firstElementChild) resizeObserver?.observe(surface.scroller.firstElementChild);
          geometryChanged();
        });
        mutationObserver.observe(surface.scroller, { childList: true });
      }
    }
    function visiblePosition() {
      if (!surface?.scroller || !headings.length) return -1;
      const scroller = surface.scroller, rect = scroller.getBoundingClientRect();
      if (surface.kind === 'reading') {
        if (!readingPositions) readingPositions = Array.from(scroller.querySelectorAll('[data-note-heading-from]'), element => ({
          from: element.getBoundingClientRect().top - rect.top + scroller.scrollTop,
          sourceFrom: Number(element.dataset.noteHeadingFrom),
        }));
        const index = headingAt(readingPositions, scroller.scrollTop + 16);
        return index < 0 ? -1 : readingPositions[index].sourceFrom;
      }
      if (surface.view) {
        try { return surface.view.lineBlockAtHeight(Math.max(0, rect.top + 16 - surface.view.documentTop)).from; }
        catch (_) { return surface.view.viewport.from; }
      }
      const lineHeight = parseFloat(getComputedStyle(scroller).lineHeight) || 24;
      const lines = Math.floor(scroller.scrollTop / lineHeight), source = documentState?.source || '';
      let position = 0;
      for (let line = 0; line < lines; line++) { const end = source.indexOf('\n', position); if (end < 0) break; position = end + 1; }
      return position;
    }
    function highlight() {
      frame = 0;
      if (!active || !documentState || !rows.size) return;
      let index = headingAt(headings, visiblePosition());
      const collapsed = session(documentState.path).collapsed;
      if (index >= 0) {
        let ancestor = headings[index].parent;
        while (ancestor >= 0) {
          if (collapsed.has(headings[ancestor].key)) index = ancestor;
          ancestor = headings[ancestor].parent;
        }
      }
      const nextKey = index < 0 ? '' : headings[index].key;
      if (nextKey === currentKey) return;
      const previous = rows.get(currentKey)?.row, next = rows.get(nextKey)?.row;
      if (previous) { previous.classList.remove('is-current'); previous.removeAttribute('aria-current'); }
      if (next) { next.classList.add('is-current'); next.setAttribute('aria-current', 'location'); }
      currentKey = nextKey;
    }
    function scheduleHighlight() { if (active && !frame) frame = requestAnimationFrame(highlight); }
    function updateLabels() {
      host.setAttribute('aria-label', text('title'));
      const collapsed = documentState ? session(documentState.path).collapsed : new Set();
      rows.forEach(record => {
        if (record.group) record.toggle.setAttribute('aria-label', text(collapsed.has(record.key) ? 'expand' : 'collapse'));
      });
    }
    function commit(sourceDocument, entries) {
      const counts = new Map(), stack = [];
      headings = entries.map((entry, index) => {
        const base = JSON.stringify([entry.level, entry.label]), occurrence = counts.get(base) || 0;
        counts.set(base, occurrence + 1);
        while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].index : -1;
        const item = Object.assign({}, entry, { key: base + ':' + occurrence, parent, depth: stack.length, index });
        stack.push(item); return item;
      });
      const signature = JSON.stringify(headings.map(entry => [entry.key, entry.parent]));
      const samePath = documentState?.path === sourceDocument.path;
      const saved = session(sourceDocument.path), scrollTop = samePath && rows.size ? host.scrollTop : saved.scrollTop;
      documentState = sourceDocument;
      host.removeAttribute('aria-busy'); delete host.dataset.outlineStatus;
      if (!headings.length) { status('empty'); return; }
      if (signature !== structure || !samePath || !rows.size) {
        const hadFocus = host.contains(document.activeElement), oldFocus = focusedKey;
        const tree = document.createElement('ul'); tree.className = 'note-outline-tree'; tree.setAttribute('role', 'tree');
        rows = new Map();
        headings.forEach(entry => {
          const item = document.createElement('li'); item.setAttribute('role', 'none');
          const row = document.createElement('div'); row.className = 'note-outline-row'; row.dataset.outlineKey = entry.key;
          row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(entry.depth + 1)); row.tabIndex = entry.index ? -1 : 0;
          const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'note-outline-toggle'; toggle.tabIndex = -1;
          const title = document.createElement('button'); title.type = 'button'; title.className = 'note-outline-title'; title.tabIndex = -1;
          title.textContent = entry.label; title.title = entry.label; row.setAttribute('aria-label', entry.label);
          row.append(toggle, title); item.appendChild(row);
          const record = { key: entry.key, item, row, toggle, title, group: null }; rows.set(entry.key, record);
          if (entry.parent >= 0) {
            const parent = rows.get(headings[entry.parent].key);
            if (!parent.group) {
              parent.group = document.createElement('ul'); parent.group.setAttribute('role', 'group');
              parent.group.hidden = saved.collapsed.has(parent.key); parent.item.appendChild(parent.group);
              parent.row.setAttribute('aria-expanded', String(!parent.group.hidden)); parent.toggle.classList.add('has-children');
            }
            parent.group.appendChild(item);
          } else tree.appendChild(item);
        });
        rows.forEach(record => { if (!record.group) { record.toggle.disabled = true; record.toggle.setAttribute('aria-hidden', 'true'); } });
        host.replaceChildren(tree); structure = signature; currentKey = ''; focusedKey = '';
        host.scrollTop = scrollTop;
        if (hadFocus && rows.has(oldFocus)) focusRow(oldFocus);
      }
      headings.forEach(entry => {
        const row = rows.get(entry.key).row;
        if (row.dataset.outlineFrom !== String(entry.from)) row.dataset.outlineFrom = String(entry.from);
      });
      updateLabels(); readingPositions = null; scheduleHighlight();
    }
    function refresh(delay) {
      cancel();
      if (!active) return;
      const token = epoch;
      timer = setTimeout(() => {
        timer = 0;
        if (!active || token !== epoch) return;
        bindSurface(); updateLabels();
        const next = options.getDocument();
        if (!next) { documentState = null; headings = []; status('open'); return; }
        if (pending()) {
          options.whenInputSettled().then(() => { if (active && token === epoch) refresh(0); });
          return;
        }
        if (documentState?.path === next.path && documentState.source === next.source
            && (rows.size || host.dataset.outlineStatus === 'empty')) { documentState = next; if (!rows.size) status('empty'); scheduleHighlight(); return; }
        if (documentState && documentState.path !== next.path) session(documentState.path).scrollTop = host.scrollTop;
        if (documentState?.path !== next.path || !rows.size) status('loading');
        host.setAttribute('aria-busy', 'true');
        const scan = window.RelatumNoteLiveSyntax.scanNoteHeadings(next.source);
        const advance = () => {
          timer = 0;
          if (!active || token !== epoch) return;
          try {
            const deadline = performance.now() + 8; let result;
            do { result = scan.next(); } while (!result.done && performance.now() < deadline);
            if (!result.done) { timer = setTimeout(advance, 0); return; }
            const current = options.getDocument();
            if (current?.identity !== next.identity || current.source !== next.source) { refresh(0); return; }
            commit(next, result.value);
          } catch (_) { host.removeAttribute('aria-busy'); status('failed'); }
        };
        advance();
      }, delay || 0);
    }
    function fold(key) {
      const record = rows.get(key);
      if (!record?.group || !documentState) return;
      navigationEpoch++;
      const collapsed = session(documentState.path).collapsed;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      record.group.hidden = collapsed.has(key); record.row.setAttribute('aria-expanded', String(!record.group.hidden));
      updateLabels(); scheduleHighlight();
    }
    function navigate(key) {
      const heading = headings.find(entry => entry.key === key);
      if (!heading || !documentState) return;
      const token = ++navigationEpoch, sourceDocument = documentState;
      Promise.resolve(options.navigate(heading, sourceDocument, () => active && token === navigationEpoch))
        .then(() => { if (active && token === navigationEpoch) { refresh(0); scheduleHighlight(); } }).catch(() => {});
    }
    function focusRow(key) {
      const row = rows.get(key)?.row;
      if (!row) return;
      const old = rows.get(focusedKey)?.row;
      if (old && old !== row) old.tabIndex = -1;
      if (!focusedKey && headings.length && key !== headings[0].key) rows.get(headings[0].key).row.tabIndex = -1;
      focusedKey = key; row.tabIndex = 0; row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    }
    host.addEventListener('pointerdown', event => {
      if (event.button === 0 && event.target.closest('.note-outline-row')) { event.preventDefault(); event.stopPropagation(); }
    });
    host.addEventListener('click', event => {
      const row = event.target.closest('[data-outline-key]');
      if (!active || !row || !host.contains(row)) return;
      if (event.target.closest('.note-outline-toggle')) fold(row.dataset.outlineKey);
      else navigate(row.dataset.outlineKey);
    });
    host.addEventListener('keydown', event => {
      const row = event.target.closest('[data-outline-key]');
      if (!active || !row || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const entry = headings.find(item => item.key === row.dataset.outlineKey), record = rows.get(entry?.key);
      if (!entry || !record) return;
      const visible = headings.filter(item => {
        let parent = item.parent;
        while (parent >= 0) { if (rows.get(headings[parent].key).group.hidden) return false; parent = headings[parent].parent; }
        return true;
      });
      const index = visible.indexOf(entry);
      if (event.key === 'ArrowDown') focusRow(visible[Math.min(visible.length - 1, index + 1)].key);
      else if (event.key === 'ArrowUp') focusRow(visible[Math.max(0, index - 1)].key);
      else if (event.key === 'Home') focusRow(visible[0].key);
      else if (event.key === 'End') focusRow(visible[visible.length - 1].key);
      else if (event.key === 'ArrowRight') { if (record.group?.hidden) fold(entry.key); else if (record.group) focusRow(headings[entry.index + 1].key); }
      else if (event.key === 'ArrowLeft') { if (record.group && !record.group.hidden) fold(entry.key); else if (entry.parent >= 0) focusRow(headings[entry.parent].key); }
      else if (event.key === 'Enter') navigate(entry.key);
      else if (event.key === ' ') { if (record.group) fold(entry.key); else navigate(entry.key); }
      else return;
      event.preventDefault(); event.stopPropagation();
    });
    return {
      resume() { active = true; refresh(0); },
      suspend() {
        if (documentState) session(documentState.path).scrollTop = host.scrollTop;
        active = false; navigationEpoch++; cancel();
        if (frame) cancelAnimationFrame(frame); frame = 0; detachSurface();
      },
      documentChanged() { if (active) refresh(120); },
    };
  }
  window.RelatumNoteOutline = { create, headingAt, mapHeadingPosition };
})();

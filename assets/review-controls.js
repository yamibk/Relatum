(function () {
  'use strict';
  let active = null, serial = 0;
  const ui = (zh, en) => window.RelatumI18n?.language === 'en' ? en : zh;
  const attr = (node, name, value) => {
    if (value == null) { if (node.hasAttribute(name)) node.removeAttribute(name); }
    else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  };
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const style = (node, name, value) => { if (node.style[name] !== value) node.style[name] = value; };
  const toggleClass = (node, name, enabled) => { if (node.classList.contains(name) !== enabled) node.classList.toggle(name, enabled); };
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  };
  function createManager(owner, portal = document.body) {
    const controls = new Set(), enhanced = new WeakMap();
    function attach(anchor, source) {
      let popup = null, search = null, listbox = null, host = null, empty = null, list = null;
      let choices = [], items = [], indexes = new Map(), index = -1, activeRow = null;
      let value = '', focus = anchor, rowSerial = 0, version = 0, renderedVersion = -1, queryKey = null;
      let positionFrame = 0, hoverFrame = 0, hoverKey = null, opening = false, clipping = [];
      let layoutObserver = null, clippingDirty = false;
      const layoutSizes = new Map();
      const mounted = new Map(), id = 'review-choice-' + (++serial), handlers = [];
      function bind(target, type, callback, options) {
        target.addEventListener(type, callback, options);
        handlers.push(() => target.removeEventListener(type, callback, options));
      }
      function contains(target) { return anchor.contains(target) || !!popup?.contains(target); }
      function rowFor(key) { return list ? list.row(key) : mounted.get(key); }
      function cancelHover() { cancelAnimationFrame(hoverFrame); hoverFrame = 0; hoverKey = null; }
      function collectClipping() {
        clipping = [];
        for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
          const css = getComputedStyle(node);
          if (/(auto|scroll|hidden|clip)/.test(css.overflowY + css.overflowX)) clipping.push(node);
        }
        if (layoutObserver) {
          layoutObserver.disconnect(); layoutSizes.clear();
          [anchor, ...clipping].forEach(node => layoutObserver.observe(node));
        }
      }
      function measure() {
        if (!popup) return null;
        if (!anchor.isConnected || !anchor.getClientRects().length || anchor.closest('[hidden],[inert]')) { close(); return null; }
        const rect = anchor.getBoundingClientRect(), edge = 10, gap = 6;
        if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) { close(); return null; }
        for (const node of clipping) {
          const box = node.getBoundingClientRect();
          if (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) { close(); return null; }
        }
        const below = innerHeight - rect.bottom - edge - gap, above = rect.top - edge - gap;
        const up = below < 280 && above > below;
        return { rect, up, height: Math.max(0, Math.min(340, up ? above : below)),
          width: Math.min(innerWidth - edge * 2, Math.max(rect.width, source.searchable || source.input ? 270 : 190)) };
      }
      function constrain(box) {
        // The scroller must already be bounded when windowed-list reads its height.
        style(popup, 'width', box.width + 'px'); style(popup, 'maxHeight', box.height + 'px');
        style(listbox, 'maxHeight', Math.max(0, box.height - 12 - (search ? 49 : 0)) + 'px');
        sizeScroller();
      }
      function sizeScroller() {
        const windowed = choices.length > 200 && !!window.RelatumWindowedList;
        // An empty scroller has clientHeight=0; give the first render its real viewport.
        const height = windowed && items.length ? Math.min(items.length * 36, parseFloat(listbox.style.maxHeight)) + 'px' : '';
        style(listbox, 'height', height);
      }
      function position(box) {
        positionFrame = 0;
        if (clippingDirty) { clippingDirty = false; collectClipping(); }
        box = box || measure(); if (!box || !popup) return;
        constrain(box);
        const height = popup.getBoundingClientRect().height;
        style(popup, 'left', Math.max(10, Math.min(box.rect.left, innerWidth - box.width - 10)) + 'px');
        style(popup, 'top', Math.max(10, Math.min(box.up ? box.rect.top - 6 - height : box.rect.bottom + 6, innerHeight - height - 10)) + 'px');
        toggleClass(popup, 'opens-up', box.up);
      }
      function schedulePosition(refreshClipping = false) {
        clippingDirty = clippingDirty || refreshClipping;
        if (!positionFrame) positionFrame = requestAnimationFrame(() => position());
      }
      function syncActive() {
        const row = items[index] ? rowFor(items[index].key) : null;
        if (activeRow !== row) {
          activeRow?.classList.remove('is-highlighted'); activeRow = row || null;
          activeRow?.classList.add('is-highlighted');
        }
        attr(focus, 'aria-activedescendant', activeRow?.id);
      }
      function highlight(next, reveal) {
        index = items.length ? Math.max(0, Math.min(items.length - 1, next)) : -1;
        if (!popup) return;
        if (reveal && items[index]) {
          if (list) list.scrollToKey(items[index].key);
          else {
            const row = rowFor(items[index].key);
            const top = row?.offsetTop || 0, height = row?.offsetHeight || 0;
            if (top < listbox.scrollTop) listbox.scrollTop = top;
            else if (top + height > listbox.scrollTop + listbox.clientHeight) listbox.scrollTop = top + height - listbox.clientHeight;
          }
        }
        syncActive();
      }
      function patchRow(row, item, itemIndex) {
        attr(row, 'data-index', itemIndex); attr(row, 'aria-label', item.label);
        const selected = item.value === value;
        attr(row, 'aria-selected', selected); toggleClass(row, 'is-selected', selected);
        text(row.firstElementChild, item.label); attr(row.firstElementChild, 'title', item.label);
        const hint = item.create ? ((typeof source.createHint === 'function' ? source.createHint() : source.createHint) || ui('保存时创建', 'Created when saved')) : '';
        if (hint) {
          if (!row.querySelector('small')) row.append(element('small'));
          text(row.lastElementChild, hint);
        } else row.querySelector('small')?.remove();
      }
      function option(item, itemIndex) {
        const row = element('div', 'review-choice-option');
        row.id = id + '-row-' + (++rowSerial); row.__choiceKey = item.key;
        row.setAttribute('role', 'option'); row.append(element('span'));
        patchRow(row, item, itemIndex); return row;
      }
      function syncSelection() {
        const next = String(source.value()); if (next === value) return;
        const previous = rowFor('value:' + value); value = next;
        if (previous) { attr(previous, 'aria-selected', false); previous.classList.remove('is-selected'); }
        const row = rowFor('value:' + value);
        if (row) { attr(row, 'aria-selected', true); row.classList.add('is-selected'); }
      }
      function refreshChoices() {
        const raw = source.choices(), previous = new Map(choices.map(item => [item.value, item]));
        const next = raw.map(item => {
          const old = previous.get(String(item.value)), label = String(item.label);
          return old?.label === label ? old : { value: String(item.value), label, key: 'value:' + item.value, search: label.toLocaleLowerCase() };
        });
        const changed = next.length !== choices.length || next.some((item, i) => item !== choices[i]);
        if (changed) { choices = next; version++; }
        return changed;
      }
      function renderChoices(preserve = false, box) {
        if (!popup) return;
        const query = (source.input ? anchor.value : search?.value || '').trim(), key = query.toLocaleLowerCase();
        syncSelection();
        if (renderedVersion === version && queryKey === query) { syncActive(); return; }
        cancelHover();
        const previous = items[index]?.key;
        items = key ? choices.filter(item => item.value === '' || item.search.includes(key)) : choices;
        if (source.allowCreate && query && !choices.some(item => item.value.trim().toLocaleLowerCase() === key)) {
          items = [...items, { value: query, key: 'create:' + query, label: ui('新建卡组', 'New deck') + ' “' + query + '”', create: true }];
        }
        indexes = new Map(items.map((item, i) => [item.key, i]));
        const retained = previous == null || (key && previous === 'value:') ? undefined : indexes.get(previous);
        index = retained ?? (key ? (items[0]?.value === '' && items.length > 1 ? 1 : 0) : indexes.get('value:' + value) ?? 0);
        if (!items.length) index = -1;
        const windowed = choices.length > 200 && !!window.RelatumWindowedList;
        sizeScroller();
        if (windowed) {
          if (!list) {
            host.replaceChildren(); mounted.clear(); activeRow = null;
            list = window.RelatumWindowedList.create({ host, scroller: listbox, estimate: 36, reuseRows: true,
              key: item => item.key, render: option, update: patchRow, onMount: syncActive });
          }
          if (!preserve) listbox.scrollTop = 0;
          list.setItems(items);
        } else {
          if (list) { list.dispose(); list = null; host.replaceChildren(); activeRow = null; }
          const wanted = new Set(items.map(item => item.key));
          mounted.forEach((row, itemKey) => { if (!wanted.has(itemKey)) { row.remove(); mounted.delete(itemKey); } });
          let cursor = host.firstChild;
          items.forEach((item, i) => {
            let row = mounted.get(item.key);
            if (!row) { row = option(item, i); mounted.set(item.key, row); } else patchRow(row, item, i);
            if (row !== cursor) host.insertBefore(row, cursor); else cursor = cursor.nextSibling;
          });
          if (!preserve) listbox.scrollTop = 0;
        }
        empty.hidden = items.length > 0;
        renderedVersion = version; queryKey = query;
        highlight(index, true); position(box);
      }
      function choose() {
        const item = items[index]; if (!item) return;
        cancelHover(); source.choose(item.value); close(); source.sync?.();
        if (anchor.isConnected) anchor.focus({ preventScroll: true });
      }
      function close(restore = false) {
        if (!popup) return;
        const dialog = anchor.closest('[aria-modal="true"]');
        if (dialog?.getAttribute('aria-owns') === popup.id) attr(dialog, 'aria-owns', null);
        const returnFocus = popup.contains(document.activeElement);
        if (active === control) active = null;
        cancelAnimationFrame(positionFrame); positionFrame = 0; cancelHover();
        layoutObserver?.disconnect(); layoutObserver = null; layoutSizes.clear();
        list?.dispose(); list = null; mounted.clear();
        handlers.splice(0).forEach(remove => remove());
        popup.remove(); popup = search = listbox = host = empty = activeRow = null;
        items = []; indexes.clear(); index = -1; clipping = []; clippingDirty = false; queryKey = null; renderedVersion = -1;
        attr(anchor, 'aria-expanded', false); attr(anchor, 'aria-activedescendant', null);
        attr(focus, 'aria-activedescendant', null); focus = anchor;
        if ((restore || returnFocus) && anchor.isConnected && !anchor.closest('[hidden],[inert]')) anchor.focus({ preventScroll: true });
      }
      function open() {
        if (popup || opening || source.disabled?.() || !anchor.isConnected || anchor.closest('[hidden],[inert]') || document.hidden || document.documentElement.dataset.desktopMinimized === '1') return;
        opening = true; active?.close(); active = control; value = String(source.value());
        popup = element('div', 'review-choice-popup'); popup.dataset.i18nManaged = '';
        popup.dataset.startTheme = document.body.dataset.startTheme || 'light';
        listbox = element('div', 'review-choice-list'); listbox.id = id; attr(listbox, 'role', 'listbox');
        attr(listbox, 'aria-label', source.label()); host = element('div'); empty = element('p', 'review-choice-empty', ui('没有匹配项', 'No matches')); empty.hidden = true;
        listbox.append(host, empty);
        if (!source.input && (source.searchable || choices.length > 8)) {
          search = element('input', 'review-choice-search'); search.type = 'search'; search.autocomplete = 'off'; search.spellcheck = false;
          search.placeholder = source.allowCreate ? ui('搜索或输入新卡组', 'Search or enter a new deck') : ui('搜索选项', 'Search options');
          attr(search, 'aria-label', search.placeholder); attr(search, 'role', 'combobox'); attr(search, 'aria-autocomplete', 'list');
          attr(search, 'aria-expanded', true); attr(search, 'aria-controls', id); search.maxLength = source.allowCreate ? 80 : 256;
          bind(search, 'input', event => { if (!event.isComposing) renderChoices(); });
          bind(search, 'compositionend', () => renderChoices()); popup.append(search); focus = search;
        }
        popup.append(listbox); portal.append(popup); attr(anchor, 'aria-expanded', true);
        const dialog = anchor.closest('[aria-modal="true"]');
        if (dialog) { popup.id = id + '-popup'; attr(dialog, 'aria-owns', popup.id); }
        collectClipping(); const box = measure();
        if (!box) { opening = false; return; }
        constrain(box); renderChoices(false, box);
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(entries => {
            if (!popup || layoutObserver !== observer) return;
            let changed = false;
            entries.forEach(entry => {
              const size = entry.borderBoxSize?.[0] || entry.contentRect, width = size.inlineSize ?? size.width, height = size.blockSize ?? size.height;
              const previous = layoutSizes.get(entry.target);
              if (previous && (previous.width !== width || previous.height !== height)) changed = true;
              layoutSizes.set(entry.target, { width, height });
            });
            if (changed) schedulePosition();
          });
          layoutObserver = observer;
          [anchor, ...clipping].forEach(node => layoutObserver.observe(node));
        }
        bind(host, 'pointerdown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
        bind(host, 'click', event => { const row = event.target.closest('[role="option"]'); if (row) { index = indexes.get(row.__choiceKey) ?? -1; choose(); } });
        bind(host, 'pointermove', event => {
          const row = event.target.closest('[role="option"]');
          if (!row || (!event.movementX && !event.movementY)) return;
          if (row.__choiceKey === items[index]?.key) { cancelHover(); return; }
          hoverKey = row.__choiceKey;
          if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
            hoverFrame = 0; const next = indexes.get(hoverKey); hoverKey = null;
            if (popup && next != null) highlight(next, false);
          });
        });
        bind(host, 'pointerleave', cancelHover);
        bind(listbox, 'wheel', cancelHover, { passive: true }); bind(listbox, 'scroll', cancelHover, { passive: true });
        bind(document, 'pointerdown', event => { if (!contains(event.target)) close(); }, true);
        bind(document, 'focusin', event => { if (!contains(event.target)) close(); }, true);
        bind(document, 'keydown', event => { if (control.handleKey(event)) event.stopImmediatePropagation(); }, true);
        bind(window, 'scroll', event => { if (event.target === document || clipping.includes(event.target)) schedulePosition(); }, true);
        bind(window, 'resize', () => schedulePosition(true));
        const settled = event => {
          if (event.type === 'transitionend' && /(?:color|opacity|shadow)$/.test(event.propertyName)) return;
          if (event.target.contains?.(anchor)) schedulePosition(true);
        };
        bind(document, 'transitionend', settled); bind(document, 'animationend', settled);
        bind(window, 'blur', () => close()); opening = false; focus.focus({ preventScroll: true });
      }
      const control = { anchor, contains, open, close, get isOpen() { return !!popup; },
        sync() {
          source.sync?.();
          if (popup && source.disabled?.()) close();
          else if (popup) { attr(listbox, 'aria-label', source.label()); syncSelection(); syncActive(); }
        },
        refresh() { const changed = refreshChoices(); control.sync(); if (popup && changed) renderChoices(true); },
        handleKey(event) {
          if (!popup || !contains(event.target)) return false;
          if (event.isComposing || event.keyCode === 229) return true;
          if ((event.target === anchor || event.target === search) && focus !== event.target) { attr(focus, 'aria-activedescendant', null); focus = event.target; }
          cancelHover();
          if (event.key === 'Escape') { event.preventDefault(); close(true); return true; }
          if (event.key === 'Tab') { close(true); return false; }
          const editing = event.target === search || source.input;
          if (['ArrowDown', 'ArrowUp'].includes(event.key) || (!editing && ['Home', 'End'].includes(event.key))) {
            event.preventDefault(); highlight(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1), true); return true;
          }
          if (event.key === 'Enter' || (!editing && event.key === ' ')) { event.preventDefault(); choose(); return true; }
          return true;
        },
        dispose() { close(); anchor.removeEventListener('click', toggle); anchor.removeEventListener('keydown', keydown); anchor.removeEventListener('input', input); anchor.removeEventListener('compositionend', input); anchor.removeEventListener('focus', openOnFocus); controls.delete(control); source.dispose?.(); },
      };
      function toggle() { if (popup) close(); else open(); }
      function keydown(event) {
        if (event.isComposing || event.keyCode === 229) return;
        if (!popup && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
      }
      function input(event) { source.onInput?.(); if (!event.isComposing) { if (!popup) open(); else renderChoices(); } }
      function openOnFocus() { if (source.input) open(); }
      attr(anchor, 'role', 'combobox'); attr(anchor, 'aria-haspopup', 'listbox'); attr(anchor, 'aria-controls', id); attr(anchor, 'aria-expanded', false);
      if (source.input) { anchor.addEventListener('focus', openOnFocus); anchor.addEventListener('input', input); anchor.addEventListener('compositionend', input); }
      else anchor.addEventListener('click', toggle);
      anchor.addEventListener('keydown', keydown); controls.add(control); refreshChoices(); return control;
    }
    function enhance(select, options = {}) {
      if (enhanced.has(select)) return enhanced.get(select);
      const wrapper = element('span', 'review-choice'), trigger = element('button', 'review-choice-trigger');
      trigger.type = 'button'; trigger.dataset.i18nManaged = '';
      const title = element('span', 'review-choice-value'); trigger.append(title, element('span', 'review-choice-chevron'));
      const label = select.getAttribute('aria-label') || select.labels?.[0]?.querySelector('span')?.textContent.trim() || '';
      const getLabel = () => select.getAttribute('aria-label') || select.labels?.[0]?.querySelector('span')?.textContent.trim() || label;
      if (select.parentNode) select.before(wrapper);
      select.hidden = true; select.classList.add('review-select-native'); wrapper.append(select, trigger);
      const sync = () => {
        attr(trigger, 'aria-label', getLabel()); if (trigger.disabled !== select.disabled) trigger.disabled = select.disabled;
        const next = select.selectedOptions[0]?.textContent || ''; text(title, next); attr(trigger, 'title', next);
      };
      const control = attach(trigger, { ...options, label: getLabel,
        choices: () => Array.from(select.options).filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent })),
        value: () => select.value, disabled: () => select.disabled, sync,
        choose(value) {
          if (!Array.from(select.options).some(option => option.value === value)) { select.add(new Option(value, value)); control.refresh(); }
          select.value = value; sync(); select.dispatchEvent(new Event('change', { bubbles: true }));
        }, dispose: () => { enhanced.delete(select); } });
      const change = () => control.sync(); select.addEventListener('change', change);
      const dispose = control.dispose; control.dispose = () => { select.removeEventListener('change', change); dispose(); };
      control.element = wrapper; enhanced.set(select, control); sync(); return control;
    }
    function setOptions(select, entries, value) {
      if (!select) return;
      const control = enhance(select), previous = new Map(Array.from(select.options, option => [option.value, option]));
      let cursor = select.firstChild, changed = false;
      for (const item of entries) {
        const key = String(item.value), label = String(item.label);
        let option = previous.get(key); previous.delete(key);
        if (!option) { option = new Option(label, key); changed = true; }
        else if (option.textContent !== label) { option.textContent = label; changed = true; }
        if (option !== cursor) { select.insertBefore(option, cursor); changed = true; } else cursor = cursor.nextSibling;
      }
      previous.forEach(option => { option.remove(); changed = true; });
      const next = entries.some(item => String(item.value) === String(value)) ? String(value) : String(entries[0]?.value ?? '');
      if (select.value !== next) select.value = next;
      if (changed) control.refresh(); else control.sync();
    }
    function visit(target, callback) {
      if (!target) controls.forEach(callback);
      else (Array.isArray(target) ? target : [target]).forEach(node => { const control = enhanced.get(node); if (control) callback(control); });
    }
    function close() { controls.forEach(control => control.close()); }
    const leave = event => { if (event.type !== 'start:viewchange' || event.detail?.current !== 'review') close(); };
    const visibility = () => { if (document.hidden || document.documentElement.dataset.desktopMinimized === '1') close(); };
    document.addEventListener('start:viewchange', leave); window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('canvasdesktop:visibility', visibility);
    return { enhance, setOptions,
      bindInput(input, options) {
        const control = attach(input, { ...options, input: true, dispose() { enhanced.delete(input); options.dispose?.(); } });
        enhanced.set(input, control); return control;
      },
      enhanceAll(scope = owner) {
        controls.forEach(control => { if (!owner.contains(control.anchor)) control.dispose(); });
        scope.querySelectorAll('select').forEach(select => enhance(select)); visit(null, control => control.sync());
      },
      sync(target) { visit(target, control => control.sync()); }, refresh(target) { visit(target, control => control.refresh()); }, close,
      handleKey(event) {
        if (active && controls.has(active)) return active.handleKey(event);
        if (!event.isComposing && event.keyCode !== 229 && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          const control = Array.from(controls).find(item => item.anchor.contains(event.target));
          if (control) { event.preventDefault(); control.open(); return true; }
        }
        return false;
      },
      contains(target) { return !!active && controls.has(active) && active.contains(target); },
      dispose() { Array.from(controls).forEach(control => control.dispose()); document.removeEventListener('start:viewchange', leave); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('canvasdesktop:visibility', visibility); },
    };
  }
  window.RelatumReviewControls = { createManager };
})();

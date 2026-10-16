(function () {
  'use strict';
  let active = null, serial = 0;
  const ui = (zh, en) => window.RelatumI18n?.language === 'en' ? en : zh;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  function createManager(owner, portal = document.body) {
    const controls = new Set(), enhanced = new WeakMap();
    function attach(anchor, source) {
      let popup = null, search = null, listbox = null, host = null, list = null;
      let items = [], index = -1, focus = anchor, positionFrame = 0, opening = false, signature = '';
      const id = 'review-choice-' + (++serial);
      const handlers = [];
      function bind(target, type, callback, options) {
        target.addEventListener(type, callback, options);
        handlers.push(() => target.removeEventListener(type, callback, options));
      }
      function contains(target) { return anchor.contains(target) || !!popup?.contains(target); }
      function position() {
        positionFrame = 0;
        if (!popup) return;
        if (!anchor.isConnected || !anchor.getClientRects().length || anchor.closest('[hidden],[inert]')) { close(); return; }
        const rect = anchor.getBoundingClientRect(), edge = 10, gap = 6;
        if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) { close(); return; }
        for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY + style.overflowX)) {
            const box = parent.getBoundingClientRect();
            if (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) { close(); return; }
          }
        }
        const below = innerHeight - rect.bottom - edge - gap, above = rect.top - edge - gap;
        const up = below < 280 && above > below;
        popup.style.width = Math.min(innerWidth - edge * 2, Math.max(rect.width, source.searchable || source.input ? 270 : 190)) + 'px';
        popup.style.maxHeight = Math.max(0, Math.min(340, up ? above : below)) + 'px';
        const box = popup.getBoundingClientRect();
        popup.style.left = Math.max(edge, Math.min(rect.left, innerWidth - box.width - edge)) + 'px';
        popup.style.top = Math.max(edge, Math.min(up ? rect.top - gap - box.height : rect.bottom + gap, innerHeight - box.height - edge)) + 'px';
        popup.classList.toggle('opens-up', up);
      }
      function schedulePosition(event) {
        if (popup?.contains(event.target)) return;
        if (!positionFrame) positionFrame = requestAnimationFrame(position);
      }
      function highlight(next, reveal) {
        index = Math.max(0, Math.min(items.length - 1, next));
        if (!popup) return;
        if (reveal && items[index]) {
          if (list) list.scrollToKey(items[index].key);
          else {
            const row = host.children[index];
            if (row && row.offsetTop < listbox.scrollTop) listbox.scrollTop = row.offsetTop;
            else if (row && row.offsetTop + row.offsetHeight > listbox.scrollTop + listbox.clientHeight) listbox.scrollTop = row.offsetTop + row.offsetHeight - listbox.clientHeight;
          }
        }
        host.querySelectorAll('[role="option"]').forEach(row => {
          const highlighted = Number(row.dataset.index) === index;
          row.classList.toggle('is-highlighted', highlighted);
        });
        const row = items[index] && (list ? list.row(items[index].key) : host.children[index]);
        if (row) focus.setAttribute('aria-activedescendant', row.id);
        else focus.removeAttribute('aria-activedescendant');
      }
      function option(item, itemIndex) {
        const row = element('div', 'review-choice-option');
        row.id = id + '-option-' + itemIndex; row.dataset.index = String(itemIndex);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-label', item.label);
        row.setAttribute('aria-selected', String(item.value === source.value()));
        row.classList.toggle('is-selected', item.value === source.value());
        const title = element('span', '', item.label); title.title = item.label; row.append(title);
        if (item.create) row.append(element('small', '', (typeof source.createHint === 'function' ? source.createHint() : source.createHint) || ui('保存时创建', 'Created when saved')));
        return row;
      }
      function renderChoices(preserve = false) {
        if (!popup) return;
        const previous = preserve ? items[index]?.key : null;
        const query = (source.input ? anchor.value : search?.value || '').trim();
        const key = query.toLocaleLowerCase(), choices = source.choices();
        items = choices.filter(item => !key || item.value === '' || item.label.toLocaleLowerCase().includes(key))
          .map(item => ({ ...item, key: 'value:' + item.value }));
        if (source.allowCreate && query && !choices.some(item => item.value.trim().toLocaleLowerCase() === key)) {
          items.push({ value: query, key: 'create:' + query, label: ui('新建卡组', 'New deck') + ' “' + query + '”', create: true });
        }
        list?.dispose(); list = null; host.replaceChildren(); listbox.scrollTop = 0;
        if (items.length > 200 && window.RelatumWindowedList) {
          list = window.RelatumWindowedList.create({ host, scroller: listbox, estimate: 36, key: item => item.key, render: option,
            onMount: () => highlight(index, false) });
          list.setItems(items);
        } else host.append(...items.map(option));
        if (!items.length) host.append(element('p', 'review-choice-empty', ui('没有匹配项', 'No matches')));
        const selected = items.findIndex(item => item.value === source.value());
        const retained = previous == null ? -1 : items.findIndex(item => item.key === previous);
        highlight(retained >= 0 ? retained : key ? (items[0]?.value === '' && items.length > 1 ? 1 : 0) : Math.max(0, selected), true);
        signature = JSON.stringify([choices, source.value(), source.label()]);
        position();
      }
      function choose() {
        const item = items[index]; if (!item) return;
        source.choose(item.value);
        close(); source.sync?.();
        if (anchor.isConnected) anchor.focus({ preventScroll: true });
      }
      function close(restore = false) {
        if (!popup) return;
        const dialog = anchor.closest('[aria-modal="true"]');
        if (dialog?.getAttribute('aria-owns') === popup.id) dialog.removeAttribute('aria-owns');
        const returnFocus = popup.contains(document.activeElement);
        if (active === control) active = null;
        cancelAnimationFrame(positionFrame); positionFrame = 0;
        list?.dispose(); list = null;
        handlers.splice(0).forEach(remove => remove());
        popup.remove(); popup = search = listbox = host = null; items = []; index = -1;
        anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-activedescendant');
        focus.removeAttribute('aria-activedescendant'); focus = anchor;
        if ((restore || returnFocus) && anchor.isConnected && !anchor.closest('[hidden],[inert]')) anchor.focus({ preventScroll: true });
      }
      function open() {
        if (popup || opening || source.disabled?.() || !anchor.isConnected || anchor.closest('[hidden],[inert]') || document.hidden || document.documentElement.dataset.desktopMinimized === '1') return;
        opening = true; active?.close(); active = control;
        popup = element('div', 'review-choice-popup'); popup.dataset.i18nManaged = '';
        popup.dataset.startTheme = document.body.dataset.startTheme || 'light';
        listbox = element('div', 'review-choice-list'); listbox.id = id; listbox.setAttribute('role', 'listbox');
        listbox.setAttribute('aria-label', source.label()); host = element('div'); listbox.append(host);
        if (!source.input && (source.searchable || source.choices().length > 8)) {
          search = element('input', 'review-choice-search'); search.type = 'search'; search.autocomplete = 'off'; search.spellcheck = false;
          search.placeholder = source.allowCreate ? ui('搜索或输入新卡组', 'Search or enter a new deck') : ui('搜索选项', 'Search options');
          search.setAttribute('aria-label', search.placeholder); search.setAttribute('role', 'combobox');
          search.setAttribute('aria-autocomplete', 'list');
          search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-controls', id); search.maxLength = source.allowCreate ? 80 : 256;
          bind(search, 'input', event => { if (!event.isComposing) renderChoices(); });
          bind(search, 'compositionend', () => renderChoices()); popup.append(search); focus = search;
        }
        popup.append(listbox); portal.append(popup); anchor.setAttribute('aria-expanded', 'true');
        const dialog = anchor.closest('[aria-modal="true"]');
        if (dialog) { popup.id = id + '-popup'; dialog.setAttribute('aria-owns', popup.id); }
        renderChoices();
        if (!popup) { opening = false; return; }
        bind(host, 'pointerdown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
        bind(host, 'click', event => { const row = event.target.closest('[role="option"]'); if (row) { index = Number(row.dataset.index); choose(); } });
        bind(host, 'pointermove', event => { const row = event.target.closest('[role="option"]'); if (row && (event.movementX || event.movementY)) highlight(Number(row.dataset.index), false); });
        bind(document, 'pointerdown', event => { if (!contains(event.target)) close(); }, true);
        bind(document, 'focusin', event => { if (!contains(event.target)) close(); }, true);
        bind(document, 'keydown', event => { if (control.handleKey(event)) event.stopImmediatePropagation(); }, true);
        bind(window, 'scroll', schedulePosition, true); bind(window, 'resize', position);
        const settled = event => { if (event.target.contains?.(anchor)) schedulePosition(event); };
        bind(document, 'transitionend', settled); bind(document, 'animationend', settled);
        bind(window, 'blur', () => close());
        opening = false;
        focus.focus({ preventScroll: true });
      }
      const control = { anchor, contains, open, close, get isOpen() { return !!popup; },
        sync() {
          source.sync?.();
          if (popup && source.disabled?.()) close();
          else if (popup && signature !== JSON.stringify([source.choices(), source.value(), source.label()])) renderChoices(true);
        },
        handleKey(event) {
          if (!popup || !contains(event.target)) return false;
          if (event.isComposing || event.keyCode === 229) return true;
          if ((event.target === anchor || event.target === search) && focus !== event.target) { focus.removeAttribute('aria-activedescendant'); focus = event.target; }
          if (event.key === 'Escape') { event.preventDefault(); close(true); return true; }
          if (event.key === 'Tab') { close(true); return false; }
          const editing = event.target === search || source.input;
          if (['ArrowDown', 'ArrowUp'].includes(event.key) || (!editing && ['Home', 'End'].includes(event.key))) {
            event.preventDefault(); highlight(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1), true); return true;
          }
          if (event.key === 'Enter' || (!editing && event.key === ' ')) { event.preventDefault(); choose(); return true; }
          // Keep review shortcuts away from an open picker while preserving native text editing.
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
      anchor.setAttribute('role', 'combobox'); anchor.setAttribute('aria-haspopup', 'listbox');
      anchor.setAttribute('aria-controls', id); anchor.setAttribute('aria-expanded', 'false');
      if (source.input) { anchor.addEventListener('focus', openOnFocus); anchor.addEventListener('input', input); anchor.addEventListener('compositionend', input); }
      else anchor.addEventListener('click', toggle);
      anchor.addEventListener('keydown', keydown); controls.add(control); return control;
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
        const name = getLabel();
        trigger.setAttribute('aria-label', name); trigger.disabled = select.disabled;
        title.textContent = select.selectedOptions[0]?.textContent || '';
        trigger.title = title.textContent;
      };
      const control = attach(trigger, { ...options, label: getLabel,
        choices: () => Array.from(select.options).filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent })),
        value: () => select.value, disabled: () => select.disabled, sync,
        choose(value) {
          if (!Array.from(select.options).some(option => option.value === value)) select.add(new Option(value, value));
          select.value = value; sync(); select.dispatchEvent(new Event('change', { bubbles: true }));
        }, dispose: () => { enhanced.delete(select); } });
      select.addEventListener('change', sync);
      const dispose = control.dispose; control.dispose = () => { select.removeEventListener('change', sync); dispose(); };
      control.element = wrapper; enhanced.set(select, control); sync(); return control;
    }
    function close() { controls.forEach(control => control.close()); }
    const leave = event => { if (event.type !== 'start:viewchange' || event.detail?.current !== 'review') close(); };
    const visibility = () => { if (document.hidden || document.documentElement.dataset.desktopMinimized === '1') close(); };
    document.addEventListener('start:viewchange', leave); window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('canvasdesktop:visibility', visibility);
    return { enhance,
      bindInput(input, options) { return attach(input, { ...options, input: true }); },
      enhanceAll(scope = owner) {
        controls.forEach(control => { if (!owner.contains(control.anchor)) control.dispose(); });
        scope.querySelectorAll('select').forEach(select => enhance(select));
        controls.forEach(control => control.sync());
      },
      sync() { controls.forEach(control => control.sync()); }, close,
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

// Reusable local settings shell. Preferences and feature behavior belong to callers.
(function () {
  'use strict';
  function create(options) {
    const { content, categories } = options;
    const dialog = document.createElement('dialog');
    dialog.className = 'relatum-settings'; dialog.id = 'note-settings-dialog'; dialog.dataset.role = 'note-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'relatum-settings-title'); dialog.hidden = true;
    dialog.innerHTML = `<aside class="relatum-settings-sidebar">
      <h2 id="relatum-settings-title"></h2>
      <label class="relatum-settings-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" autocomplete="off" data-settings-search></label>
      <nav class="relatum-settings-nav"></nav>
      <button type="button" class="relatum-settings-reset-all" data-settings-action="reset-all"></button>
    </aside><main class="relatum-settings-main">
      <header class="relatum-settings-header"><div><p data-settings-eyebrow></p><h3 data-settings-title></h3></div>
        <button type="button" class="relatum-settings-close" data-settings-action="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header><div class="relatum-settings-scroll"><div class="relatum-settings-results" role="region" aria-live="polite" hidden></div></div>
      <footer class="relatum-settings-footer"><span data-settings-status role="status" aria-live="polite"></span><button type="button" data-settings-action="reset-category"></button></footer>
    </main><div class="relatum-settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby="relatum-settings-confirm-title" hidden>
      <div><h3 id="relatum-settings-confirm-title"></h3><p></p><footer><button type="button" data-settings-action="cancel-reset"></button><button type="button" data-settings-action="accept-reset"></button></footer></div>
    </div>`;
    const find = selector => dialog.querySelector(selector);
    const nav = find('nav'), search = find('input'), scroll = find('.relatum-settings-scroll');
    const results = find('.relatum-settings-results'), confirm = find('.relatum-settings-confirm');
    const title = find('[data-settings-title]'), reset = find('[data-settings-action="reset-category"]');
    const status = find('[data-settings-status]');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let selected = categories[0].id, trigger = null, closing = 0, statusTimer = 0, resetTarget = '', backdropDown = false, disposed = false;
    const positions = new Map(), buttons = new Map(), lifetime = new AbortController();
    const listen = (el, event, fn, extra = {}) => el.addEventListener(event, fn, { ...extra, signal: lifetime.signal });
    const english = () => options.language() === 'en';
    const text = (zh, en) => english() ? en : zh;
    const label = category => category.label[english() ? 1 : 0];
    content.className = 'relatum-settings-pages'; content.removeAttribute('inert'); content.removeAttribute('role');
    scroll.append(content); document.body.append(dialog);
    categories.forEach(category => {
      category.panel.dataset.settingsCategory = category.id;
      category.panel.classList.add('relatum-settings-page'); content.append(category.panel);
      const button = document.createElement('button'); button.type = 'button'; button.dataset.settingsCategory = category.id;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${category.icon}"/></svg><span></span>`;
      nav.append(button); buttons.set(category.id, button);
      listen(button, 'click', () => { search.value = ''; show(category.id); button.focus({ preventScroll: true }); });
    });
    // Chrome translates through this controller; existing preference DOM keeps its own translator.
    [find('aside'), find('header'), find('.relatum-settings-footer'), confirm, results].forEach(el => el.dataset.i18nManaged = 'true');
    function show(id, target) {
      const category = categories.find(item => item.id === id) || categories[0];
      if (selected && !search.value && !content.hidden) positions.set(selected, scroll.scrollTop);
      selected = category.id; results.hidden = true; content.hidden = false; reset.hidden = false;
      categories.forEach(item => {
        const active = item.id === selected; item.panel.hidden = !active; item.panel.inert = !active;
        buttons.get(item.id).setAttribute('aria-current', active ? 'page' : 'false');
      });
      title.textContent = label(category); scroll.scrollTop = positions.get(selected) || 0;
      options.onCategoryChange?.(selected);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        const control = target.matches('input,button,select') ? target : target.querySelector('input,button,select');
        if (control) control.focus({ preventScroll: true });
        else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }
    }
    function searchSettings() {
      if (search.isComposing) return;
      const query = search.value.trim().toLocaleLowerCase();
      if (!query) { show(selected); return; }
      options.onCategoryChange?.('');
      content.hidden = true; results.hidden = false; reset.hidden = true; results.replaceChildren();
      title.textContent = text('搜索结果', 'Search results');
      categories.forEach(category => {
        const targets = category.panel.querySelectorAll('label, [data-settings-keywords], .note-canvas-default-tabs button, .note-shortcut-row');
        const matches = Array.from(targets).filter(element => {
          const described = element.querySelector('[aria-describedby]')?.getAttribute('aria-describedby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || '';
          const hint = element.nextElementSibling?.matches('p') ? element.nextElementSibling.textContent : '';
          const value = [label(category), category.keywords || '', element.textContent, described, hint, element.getAttribute('aria-label'), element.dataset.settingsKeywords].join(' ').toLocaleLowerCase();
          return query.split(/\s+/).every(part => value.includes(part));
        });
        if (!matches.length && [label(category), category.keywords || '', category.panel.textContent].join(' ').toLocaleLowerCase().includes(query)) matches.push(category.panel);
        matches.forEach(element => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'relatum-settings-result';
          const name = document.createElement('strong'), path = document.createElement('span');
          name.textContent = (element.querySelector('strong, :scope > span, h3')?.textContent || element.getAttribute('aria-label') || label(category)).trim();
          path.textContent = label(category); button.append(name, path); results.append(button);
          button.addEventListener('click', () => { search.value = ''; show(category.id, element); });
        });
      });
      if (!results.childElementCount) results.textContent = text('没有找到相关设置', 'No matching settings');
      scroll.scrollTop = 0;
    }
    function cancelReset() {
      confirm.hidden = true; resetTarget = '';
      find('.relatum-settings-sidebar').inert = false; find('.relatum-settings-main').inert = false;
    }
    function askReset(all) {
      resetTarget = all ? 'all' : selected;
      find('#relatum-settings-confirm-title').textContent = all ? text('恢复全部笔记设置？', 'Reset all note settings?') : text('恢复此分类的默认设置？', 'Reset this category?');
      confirm.querySelector('p').textContent = all
        ? text('恢复外观、编辑、文件命名、引导、图谱、画布默认样式和快捷键。笔记内容保持原样。', 'Restore appearance, editing, naming, guide, graph, canvas defaults and shortcuts. Your notes stay unchanged.')
        : text('将“' + label(categories.find(item => item.id === selected)) + '”恢复为默认值。', 'Restore defaults for “' + label(categories.find(item => item.id === selected)) + '”.');
      confirm.hidden = false; find('.relatum-settings-sidebar').inert = true; find('.relatum-settings-main').inert = true;
      find('[data-settings-action="cancel-reset"]').focus();
    }
    function close({ restoreFocus = true, instant = false } = {}) {
      if (!dialog.open) return;
      clearTimeout(closing); cancelReset(); dialog.inert = true; dialog.classList.add('is-closing');
      clearTimeout(statusTimer); status.textContent = ''; results.replaceChildren(); search.value = '';
      options.onClose?.();
      const finish = () => {
        closing = 0; dialog.close(); dialog.hidden = true; content.hidden = true; dialog.classList.remove('is-closing');
        if (restoreFocus && trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus({ preventScroll: true });
      };
      if (instant || motion.matches) finish(); else closing = setTimeout(finish, 140);
    }
    function setLanguage() {
      status.textContent = '';
      find('h2').textContent = text('笔记设置', 'Note settings');
      find('[data-settings-eyebrow]').textContent = text('偏好设置', 'PREFERENCES');
      search.placeholder = text('搜索设置', 'Search settings'); search.setAttribute('aria-label', search.placeholder);
      nav.setAttribute('aria-label', text('设置分类', 'Settings categories'));
      categories.forEach(category => buttons.get(category.id).querySelector('span').textContent = label(category));
      const labels = { close: ['关闭设置', 'Close settings'], 'reset-all': ['恢复全部笔记设置', 'Reset all note settings'], 'reset-category': ['恢复此分类默认值', 'Reset category'], 'cancel-reset': ['取消', 'Cancel'], 'accept-reset': ['恢复默认', 'Restore defaults'] };
      Object.entries(labels).forEach(([action, values]) => {
        const button = find('[data-settings-action="' + action + '"]');
        if (action === 'close') button.setAttribute('aria-label', values[english() ? 1 : 0]); else button.textContent = values[english() ? 1 : 0];
      });
      if (search.value) searchSettings(); else title.textContent = label(categories.find(category => category.id === selected));
      if (resetTarget) askReset(resetTarget === 'all');
    }
    listen(search, 'compositionstart', () => { search.isComposing = true; });
    listen(search, 'compositionend', () => { search.isComposing = false; searchSettings(); });
    listen(search, 'input', searchSettings);
    listen(dialog, 'pointerdown', event => { backdropDown = event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom); });
    listen(dialog, 'click', async event => {
      if (event.target === dialog && backdropDown) { backdropDown = false; close(); return; }
      const action = event.target.closest('[data-settings-action]')?.dataset.settingsAction;
      if (action === 'close') close();
      else if (action === 'reset-category' || action === 'reset-all') askReset(action === 'reset-all');
      else if (action === 'cancel-reset') { cancelReset(); reset.focus(); }
      else if (action === 'accept-reset') {
        const target = resetTarget; cancelReset();
        try { if (target === 'all') await options.resetAll(); else await categories.find(item => item.id === target)?.reset?.(); }
        catch (_) { if (dialog.open && !dialog.inert) { status.textContent = text('恢复失败，请重试', 'Could not restore defaults. Please retry.'); reset.focus(); } return; }
        if (!dialog.open || dialog.inert) return;
        status.textContent = text('已恢复默认', 'Defaults restored'); clearTimeout(statusTimer); statusTimer = setTimeout(() => { status.textContent = ''; }, 1800);
        reset.focus();
      }
    });
    listen(dialog, 'keydown', event => {
      // Keep native input and IME behavior while preventing document/workspace commands.
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (options.onKeyDown?.(event)) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!confirm.hidden) { cancelReset(); reset.focus(); } else if (search.value) { search.value = ''; show(selected); } else close(); }
      if (event.key === 'Tab') {
        const scope = confirm.hidden ? dialog : confirm;
        const focusable = Array.from(scope.querySelectorAll('button,input,select,textarea,[tabindex="0"]')).filter(el => !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    listen(dialog, 'cancel', event => { event.preventDefault(); });
    listen(nav, 'keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const items = Array.from(buttons.values()), index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + items.length) % items.length;
      items[next].click();
    });
    setLanguage(); content.hidden = true;
    return { dialog, setLanguage, get isOpen() { return dialog.open && !dialog.inert; },
      open({ category = selected, trigger: source } = {}) {
        if (disposed) return;
        clearTimeout(closing); closing = 0; clearTimeout(statusTimer); status.textContent = '';
        trigger = source || trigger || document.activeElement; dialog.hidden = false; dialog.inert = false; dialog.classList.remove('is-closing');
        cancelReset(); search.value = ''; content.hidden = false;
        if (!dialog.open) dialog.showModal(); show(category); buttons.get(selected).focus({ preventScroll: true }); options.onOpen?.();
      }, close,
      destroy() { close({ restoreFocus: false, instant: true }); disposed = true; lifetime.abort(); clearTimeout(statusTimer); dialog.remove(); },
    };
  }
  window.RelatumSettingsDialog = Object.freeze({ create });
})();

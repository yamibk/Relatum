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
  Object.assign(words['zh-CN'], { today: '今天', clearDate: '清除', previousMonth: '上个月', nextMonth: '下个月', chooseMonth: '选择年月', year: '年份', invalidDate: '请输入有效日期，例如 2026-10-13', invalidRange: '“截至”日期不能早于“修改于”日期', emptyHint: '试试其他关键词，或减少筛选条件', tagHint: '标签之间用空格或逗号分隔' });
  Object.assign(words.en, { today: 'Today', clearDate: 'Clear', previousMonth: 'Previous month', nextMonth: 'Next month', chooseMonth: 'Choose month and year', year: 'Year', invalidDate: 'Enter a valid date, such as 2026-10-13', invalidRange: 'The end date must be on or after the start date', emptyHint: 'Try another keyword or fewer filters', tagHint: 'Separate tags with spaces or commas' });
  registerProvider({ id: 'recent', label: 'recent', async loadPage(ctx, selection, offset, cursor) {
    return ctx.query({ mode: 'recent', recent: ctx.getRecent(), offset, cursor, limit: 50 });
  } });
  registerProvider({ id: 'tags', label: 'tags', async loadNavigation(ctx) { return (await ctx.request('/api/note-tags')).items || []; },
    loadPage(ctx, selection, offset, cursor) { return ctx.query({ tag: selection.key, offset, cursor, limit: 50 }); } });
  registerProvider({ id: 'canvas', label: 'canvas', enabled: ctx => !!ctx.canvasEnabled?.(),
    loadPage(ctx, selection, offset) { return ctx.request('/api/notes-canvas/list?filter=' + (selection.key || 'all') + '&offset=' + offset + '&limit=50'); } });
  registerProvider({ id: 'search', label: 'search', loadPage(ctx, selection, offset, cursor) {
    if (!selection.q?.trim() && !selection.tags?.length && selection.modified?.after == null && selection.modified?.before == null && selection.scope?.kind !== 'folder') {
      return Promise.resolve({ items: [], total: 0, hasMore: false });
    }
    const { signal, q, scope, tags, modified, sort } = selection;
    return ctx.query({ mode: 'search', limit: 50, offset, cursor, q, scope, tags, modified, sort }, { signal });
  } });

  const motion = window.RelatumNoteSystem?.motion || window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => motion.matches;
  let popupId = 0;
  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number), date = new Date(0);
    date.setFullYear(year, month - 1, day); date.setHours(0, 0, 0, 0);
    return year > 0 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  function dateValue(date) {
    return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function bindSmoothWheel(menu) {
    let target = null, direction = 0;
    function stop() { menu.scrollTo({ top: menu.scrollTop, behavior: 'instant' }); target = null; direction = 0; }
    menu.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey || !event.deltaY) return;
      if (!event.deltaMode && Math.abs(event.deltaY) < 40) { stop(); return; }
      event.preventDefault();
      const nextDirection = Math.sign(event.deltaY), amount = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? menu.clientHeight : 1);
      if (target === null || nextDirection !== direction) target = menu.scrollTop;
      direction = nextDirection; target = Math.max(0, Math.min(menu.scrollHeight - menu.clientHeight, target + amount));
      menu.scrollTo({ top: target, behavior: reducedMotion() ? 'instant' : 'smooth' });
    }, { passive: false });
    menu.addEventListener('scrollend', () => { if (target !== null && Math.abs(menu.scrollTop - target) < 1) { target = null; direction = 0; } });
    return stop;
  }
  // Only the open popup owns document listeners. Motion uses one cancellable
  // entry frame and one finite close task; no polling or persistent RAF.
  function createSearchPopovers(isActive, onOpen) {
    const popups = new Set();
    let current = null, positionFrame = 0;
    function outside(event) {
      if (current && !current.menu.contains(event.target) && !current.anchor.contains(event.target)) current.close();
    }
    function scroll(event) {
      if (!current || !event.target.contains?.(current.anchor) || positionFrame) return;
      const popup = current;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0; if (current !== popup) return;
        const rect = popup.anchor.getBoundingClientRect();
        if (Math.abs(rect.top - popup.top) <= .5 && Math.abs(rect.left - popup.left) <= .5) return;
        const viewport = popup.anchor.closest('.note-browser-results').getBoundingClientRect();
        const focused = popup.anchor.contains(document.activeElement) || popup.menu.contains(document.activeElement);
        if (!focused && (rect.bottom < viewport.top || rect.top > viewport.bottom)) popup.close({ instant: true });
        else popup.position();
      });
    }
    function closeCurrent() { current?.close({ instant: true }); }
    function outsideWheel(event) {
      if (current && !current.menu.contains(event.target) && event.target.closest?.('.note-browser-results')?.contains(current.anchor)) closeCurrent();
    }
    function listen(open) {
      if (!open) { cancelAnimationFrame(positionFrame); positionFrame = 0; }
      const method = open ? 'addEventListener' : 'removeEventListener';
      document[method]('pointerdown', outside); document[method]('focusin', outside);
      document[method]('wheel', outsideWheel, { passive: true });
      window[method]('scroll', scroll, true); window[method]('resize', closeCurrent); window[method]('blur', closeCurrent);
    }
    function register(menu, anchor, options = {}) {
      menu.classList.add('note-search-popover'); menu.hidden = true; menu.inert = true;
      menu.id = 'note-search-popup-' + (++popupId); document.body.appendChild(menu);
      let opened = false, frame = 0, timer = 0, generation = 0;
      const expanded = options.expanded || [anchor];
      expanded.forEach(node => { node.setAttribute('aria-controls', menu.id); node.setAttribute('aria-expanded', 'false'); });
      function cancel() { generation++; cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; }
      function finish() { menu.hidden = true; menu.classList.remove('is-closing'); options.onFinish?.(); }
      const popup = { menu, anchor, top: 0, left: 0, isOpen: () => opened,
        position() {
          const rect = (options.field || anchor).getBoundingClientRect();
          popup.top = anchor.getBoundingClientRect().top; popup.left = anchor.getBoundingClientRect().left;
          const edge = 8, gap = 6, below = window.innerHeight - rect.bottom - gap - edge, above = rect.top - gap - edge;
          const up = below < 240 && above > below;
          menu.classList.toggle('opens-up', up);
          menu.style.width = Math.min(window.innerWidth - edge * 2, options.width || Math.max(180, rect.width)) + 'px';
          menu.style.maxHeight = Math.max(40, Math.min(options.maxHeight || 320, up ? above : below)) + 'px';
          const box = menu.getBoundingClientRect();
          menu.style.left = Math.max(edge, Math.min(rect.left, window.innerWidth - box.width - edge)) + 'px';
          menu.style.top = Math.max(edge, Math.min(up ? rect.top - gap - box.height : rect.bottom + gap, window.innerHeight - box.height - edge)) + 'px';
          options.onPosition?.();
        },
        open() {
          if (!isActive() || !anchor.isConnected || anchor.closest('[hidden], [inert]') || document.hidden || document.documentElement.dataset.desktopMinimized === '1') return false;
          if (opened) { popup.position(); return true; }
          popups.forEach(other => { if (other !== popup && !other.menu.hidden) other.close({ instant: true }); });
          onOpen?.(); cancel(); opened = true; current = popup;
          menu.hidden = false; menu.inert = false; menu.classList.remove('is-closing');
          expanded.forEach(node => node.setAttribute('aria-expanded', 'true'));
          popup.position(); listen(true);
          const sequence = generation;
          if (reducedMotion()) menu.classList.add('is-open');
          else frame = requestAnimationFrame(() => { frame = 0; if (sequence === generation && opened) menu.classList.add('is-open'); });
          return true;
        },
        close(closeOptions = {}) {
          cancel();
          if (opened) {
            opened = false; if (current === popup) { current = null; listen(false); }
            expanded.forEach(node => node.setAttribute('aria-expanded', 'false')); options.onClose?.();
          }
          menu.inert = true; menu.classList.remove('is-open');
          if (menu.hidden) return;
          if (closeOptions.instant || reducedMotion()) finish();
          else {
            menu.classList.add('is-closing');
            const sequence = generation;
            timer = setTimeout(() => { timer = 0; if (sequence === generation && !opened) finish(); }, 170);
          }
          if (closeOptions.restoreFocus) (options.focus || anchor).focus({ preventScroll: true });
        },
        dispose() { popup.close({ instant: true }); popups.delete(popup); menu.remove(); },
      };
      menu.addEventListener('transitionend', event => {
        if (!opened && !menu.hidden && event.target === menu && event.propertyName === 'opacity' && Number(getComputedStyle(menu).opacity) < .001) {
          clearTimeout(timer); timer = 0; finish();
        }
      });
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popup.close({ restoreFocus: true }); }
      });
      popups.add(popup); return popup;
    }
    const motionChanged = () => { if (motion.matches) popups.forEach(popup => popup.close({ instant: true })); };
    motion.addEventListener('change', motionChanged);
    return { register, close(options = {}) { popups.forEach(popup => popup.close(options)); }, dispose() { motion.removeEventListener('change', motionChanged); Array.from(popups).forEach(popup => popup.dispose()); } };
  }
  function createSelectPicker(input, manager) {
    input.type = 'button'; input.className = 'note-search-select'; input.setAttribute('role', 'combobox'); input.setAttribute('aria-haspopup', 'listbox');
    const label = document.createElement('span'); input.appendChild(label);
    const menu = document.createElement('div'); menu.className = 'note-search-select-menu'; menu.setAttribute('role', 'listbox');
    const host = document.createElement('div'); menu.appendChild(host);
    let choices = [], index = -1, signature = '', activeRow = null, list = null, keyboardActive = false, pointer = null;
    const mounted = new Map(), indexes = new Map(), stopWheel = bindSmoothWheel(menu);
    const popup = manager.register(menu, input, { width: 250,
      onClose() { stopWheel(); keyboardActive = false; input.removeAttribute('aria-activedescendant'); list?.dispose(); list = null; },
      onFinish() { if (choices.length > 200) { host.replaceChildren(); mounted.clear(); activeRow = null; } },
      onPosition() { if (keyboardActive && index >= 0) highlight(index, true); },
    });
    function syncActive() {
      const value = choices[index]?.value, row = list?.row(value) || mounted.get(value);
      if (row === activeRow) return;
      activeRow?.setAttribute('aria-selected', 'false'); activeRow = row || null;
      if (row) { row.setAttribute('aria-selected', 'true'); input.setAttribute('aria-activedescendant', row.id); }
      else input.removeAttribute('aria-activedescendant');
    }
    function option(item) {
      const row = document.createElement('div'); row.className = 'note-search-folder-option'; row.dataset.value = item.value;
      row.id = menu.id + '-' + indexes.get(item.value); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false'); row.textContent = item.label;
      if (!list) mounted.set(item.value, row); return row;
    }
    function renderChoices() {
      activeRow = null;
      if (choices.length > 200 && window.RelatumWindowedList) {
        if (!popup.isOpen()) { host.replaceChildren(); mounted.clear(); return; }
        if (!list) { host.replaceChildren(); mounted.clear(); list = window.RelatumWindowedList.create({ host, scroller: menu, estimate: 32, reuseRows: true,
          key: item => item.value, render: option, onMount: syncActive }); }
        list.setItems(choices);
      } else { list?.dispose(); list = null; mounted.clear(); host.replaceChildren(...choices.map(option)); }
    }
    function highlight(next, reveal) {
      index = Math.max(0, Math.min(choices.length - 1, next));
      if (reveal) {
        stopWheel();
        if (list) list.scrollToKey(choices[index]?.value);
        else {
          const row = mounted.get(choices[index]?.value);
          if (row && row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
          else if (row && row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
        }
      }
      syncActive();
    }
    function choose(value) {
      input.value = value; label.textContent = choices.find(item => item.value === value)?.label || '';
      popup.close(); input.removeAttribute('aria-activedescendant'); input.focus({ preventScroll: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function open() {
      if (!popup.open()) return;
      if (choices.length > 200 && !list) renderChoices();
      popup.position(); highlight(Math.max(0, indexes.get(input.value) || 0), true);
    }
    input.addEventListener('click', event => { pointer = { x: event.clientX, y: event.clientY }; if (popup.isOpen()) popup.close(); else open(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' && popup.isOpen()) { event.preventDefault(); event.stopPropagation(); popup.close(); }
      else if (event.key === 'Tab') popup.close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); keyboardActive = true; if (!popup.isOpen()) open();
        highlight(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1), true);
      } else if (event.key === 'Enter' && popup.isOpen()) { event.preventDefault(); choose(choices[index].value); }
    });
    menu.addEventListener('pointerdown', event => { if (event.target.closest('[data-value]')) event.preventDefault(); else stopWheel(); });
    menu.addEventListener('click', event => { const row = event.target.closest('[data-value]'); if (row) choose(row.dataset.value); });
    menu.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse' && !event.movementX && !event.movementY) return;
      if (pointer && pointer.x === event.clientX && pointer.y === event.clientY) return;
      pointer = { x: event.clientX, y: event.clientY }; keyboardActive = false;
      const row = event.target.closest('[data-value]'); if (row) highlight(indexes.get(row.dataset.value), false);
    });
    menu.addEventListener('wheel', () => { keyboardActive = false; }, { passive: true });
    return { setOptions(next, value, name) {
      const nextSignature = JSON.stringify(next), activeValue = choices[index]?.value, previousValue = input.value;
      const changed = signature !== nextSignature;
      if (changed) {
        signature = nextSignature; choices = next; indexes.clear(); choices.forEach((item, i) => indexes.set(item.value, i)); renderChoices();
        if (popup.isOpen()) popup.position();
      }
      input.value = indexes.has(value) ? value : choices[0]?.value || '';
      const text = choices[indexes.get(input.value)]?.label || ''; if (label.textContent !== text) label.textContent = text;
      input.setAttribute('aria-label', name); menu.setAttribute('aria-label', name);
      if (popup.isOpen() && (changed || previousValue !== input.value)) {
        highlight(indexes.get(previousValue !== input.value ? input.value : activeValue) ?? indexes.get(input.value) ?? 0, true);
      }
    } };
  }
  function createDatePicker(input, getLabel, copy, language, manager) {
    const host = input.parentElement; host.classList.add('note-search-date-field');
    input.placeholder = 'YYYY-MM-DD'; input.autocomplete = 'off'; input.spellcheck = false; input.inputMode = 'numeric';
    input.setAttribute('aria-haspopup', 'dialog');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'note-search-date-toggle';
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/></svg>';
    host.appendChild(toggle);
    const menu = document.createElement('div'); menu.className = 'note-search-calendar'; menu.setAttribute('role', 'dialog');
    let monthAnimation = null;
    const popup = manager.register(menu, host, { field: input, width: 286, maxHeight: 370, expanded: [input, toggle], focus: input,
      onClose() { monthAnimation?.cancel(); monthAnimation = null; },
    });
    const header = document.createElement('header'), previous = document.createElement('button'), next = document.createElement('button'), title = document.createElement('button');
    header.className = 'note-search-calendar-head'; previous.textContent = '‹'; next.textContent = '›'; title.className = 'note-search-calendar-title';
    [previous, next, title].forEach(node => node.type = 'button'); header.append(title, previous, next);
    const weekdays = document.createElement('div'); weekdays.className = 'note-search-calendar-weekdays';
    const grid = document.createElement('div'); grid.className = 'note-search-calendar-days'; grid.setAttribute('role', 'grid');
    const jump = document.createElement('div'); jump.className = 'note-search-calendar-jump'; jump.hidden = true;
    const year = document.createElement('input'); year.type = 'number'; year.min = '1'; year.max = '9999'; year.className = 'note-search-calendar-year';
    const months = document.createElement('div'); months.className = 'note-search-calendar-months'; jump.append(year, months);
    const footer = document.createElement('footer'), clear = document.createElement('button'), today = document.createElement('button');
    clear.type = today.type = 'button'; clear.dataset.calendarAction = 'clear'; today.dataset.calendarAction = 'today'; footer.append(clear, today);
    menu.append(header, weekdays, grid, jump, footer);
    let week = null;
    const cells = Array.from({ length: 42 }, (_, index) => {
      if (index % 7 === 0) { week = document.createElement('div'); week.className = 'note-search-calendar-week'; week.setAttribute('role', 'row'); grid.appendChild(week); }
      const cell = document.createElement('button'); cell.type = 'button'; cell.setAttribute('role', 'gridcell'); week.appendChild(cell); return cell;
    });
    let view = new Date(), focusDate = dateValue(view), pickingMonth = false;
    function render(focus, animate = false) {
      const locale = language() === 'en' ? 'en-US' : 'zh-CN', selected = input.value, todayValue = dateValue(new Date());
      title.textContent = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(view);
      title.setAttribute('aria-label', copy('chooseMonth')); title.setAttribute('aria-expanded', String(pickingMonth));
      previous.setAttribute('aria-label', copy('previousMonth')); next.setAttribute('aria-label', copy('nextMonth'));
      toggle.setAttribute('aria-label', getLabel()); menu.setAttribute('aria-label', getLabel()); grid.setAttribute('aria-label', title.textContent);
      clear.textContent = copy('clearDate'); today.textContent = copy('today'); year.setAttribute('aria-label', copy('year'));
      weekdays.replaceChildren(...(language() === 'en' ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['一', '二', '三', '四', '五', '六', '日']).map(text => { const node = document.createElement('span'); node.textContent = text; return node; }));
      grid.hidden = weekdays.hidden = pickingMonth; jump.hidden = !pickingMonth;
      if (pickingMonth) {
        year.value = view.getFullYear();
        if (!months.childElementCount) for (let i = 0; i < 12; i++) {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.month = i; months.appendChild(button);
        }
        Array.from(months.children).forEach((node, i) => {
          const date = new Date(view); date.setDate(1); date.setMonth(i);
          node.textContent = new Intl.DateTimeFormat(locale, { month: 'short' }).format(date); node.classList.toggle('is-selected', i === view.getMonth());
        });
      } else {
        const date = new Date(view); date.setDate(1); date.setDate(1 - (date.getDay() + 6) % 7);
        cells.forEach(cell => {
          const value = dateValue(date); cell.textContent = date.getDate(); cell.dataset.date = value; cell.tabIndex = value === focusDate ? 0 : -1;
          cell.classList.toggle('is-other-month', date.getMonth() !== view.getMonth()); cell.classList.toggle('is-today', value === todayValue);
          cell.setAttribute('aria-selected', String(value === selected)); cell.setAttribute('aria-label', value);
          cell.disabled = date.getFullYear() < 1 || date.getFullYear() > 9999;
          if (value === todayValue) cell.setAttribute('aria-current', 'date'); else cell.removeAttribute('aria-current');
          date.setDate(date.getDate() + 1);
        });
      }
      if (popup.isOpen()) popup.position();
      if (focus) cells.find(cell => cell.dataset.date === focusDate)?.focus({ preventScroll: true });
      monthAnimation?.cancel(); monthAnimation = null;
      if (animate && popup.isOpen() && !reducedMotion() && grid.animate) {
        const animation = (pickingMonth ? jump : grid).animate([{ opacity: .5 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
        monthAnimation = animation; animation.onfinish = () => { if (monthAnimation === animation) monthAnimation = null; };
      }
    }
    function open() {
      view = parseDate(input.value) || new Date(); focusDate = dateValue(view); view.setDate(1); pickingMonth = false; render(false);
      if (popup.open()) cells.find(cell => cell.dataset.date === focusDate)?.focus({ preventScroll: true });
    }
    function choose(value) { input.value = value; popup.close({ restoreFocus: true }); input.dispatchEvent(new Event('change', { bubbles: true })); }
    function shiftMonth(amount) {
      const date = new Date(view); date.setMonth(date.getMonth() + amount);
      if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
      view = date; focusDate = dateValue(view); render(false, true);
    }
    toggle.addEventListener('click', () => popup.isOpen() ? popup.close() : open());
    input.addEventListener('input', () => popup.close());
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && !event.isComposing) { event.preventDefault(); open(); }
      else if (event.key === 'Escape' && popup.isOpen()) { event.preventDefault(); event.stopPropagation(); popup.close(); }
    });
    previous.addEventListener('click', () => shiftMonth(-1)); next.addEventListener('click', () => shiftMonth(1));
    title.addEventListener('click', () => { pickingMonth = !pickingMonth; render(false, true); if (pickingMonth) year.focus({ preventScroll: true }); });
    clear.addEventListener('click', () => choose('')); today.addEventListener('click', () => choose(dateValue(new Date())));
    menu.addEventListener('click', event => {
      const day = event.target.closest('[data-date]'), month = event.target.closest('[data-month]');
      if (day && !day.disabled) choose(day.dataset.date);
      else if (month) {
        const value = Number(year.value);
        if (!Number.isInteger(value) || value < 1 || value > 9999) { year.focus(); return; }
        view.setFullYear(value, Number(month.dataset.month), 1); focusDate = dateValue(view); pickingMonth = false; render(true, true);
      }
    });
    grid.addEventListener('keydown', event => {
      const cell = event.target.closest('[data-date]'); if (!cell) return;
      const date = parseDate(cell.dataset.date); if (!date) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (step) date.setDate(date.getDate() + step);
      else if (event.key === 'Home') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      else if (event.key === 'End') date.setDate(date.getDate() + 6 - (date.getDay() + 6) % 7);
      else if (event.key === 'PageUp' || event.key === 'PageDown') {
        const day = date.getDate(); date.setDate(1); date.setMonth(date.getMonth() + (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
        const end = new Date(date); end.setMonth(end.getMonth() + 1, 0); date.setDate(Math.min(day, end.getDate()));
      } else return;
      event.preventDefault();
      if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
      const changedMonth = date.getMonth() !== view.getMonth() || date.getFullYear() !== view.getFullYear();
      focusDate = dateValue(date); view = new Date(date); view.setDate(1); render(true, changedMonth);
    });
    return { setLanguage() { toggle.setAttribute('aria-label', getLabel()); if (popup.isOpen()) render(false); } };
  }
  function createFolderPicker(input, getLabel, manager) {
    const host = input.parentElement;
    host.classList.add('note-search-folder-field');
    input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'note-search-folder-list'); input.setAttribute('aria-expanded', 'false');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'note-search-folder-toggle'; toggle.tabIndex = -1;
    toggle.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'note-search-folder-menu'; menu.hidden = true;
    const rows = document.createElement('div'); rows.id = 'note-search-folder-list'; rows.setAttribute('role', 'listbox');
    menu.appendChild(rows); host.append(toggle);
    let availablePaths = [], normalizedPaths = [], paths = [], activeIndex = -1, activeRow = null, list = null, optionId = 0;
    const indexes = new Map(), mounted = new Map();
    const stopWheel = bindSmoothWheel(menu);
    const popup = manager.register(menu, host, { field: input, maxHeight: 240, expanded: [input, toggle], focus: input,
      onClose() { stopWheel(); list?.dispose(); list = null; input.removeAttribute('aria-activedescendant'); },
      onFinish() { rows.replaceChildren(); paths = []; indexes.clear(); mounted.clear(); activeRow = null; activeIndex = -1; },
    });
    const close = options => popup.close(options);
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
      const value = input.value.trim().toLocaleLowerCase();
      const next = availablePaths.filter((path, i) => !value || normalizedPaths[i].includes(value));
      if (!next.length) { close(); return; }
      if (popup.isOpen() && paths.length === next.length && paths.every((path, i) => path === next[i])) return;
      if (!popup.open()) return;
      stopWheel(); paths = next; indexes.clear(); paths.forEach((path, i) => indexes.set(path, i));
      if (activeRow) activeRow.setAttribute('aria-selected', 'false');
      activeIndex = paths.indexOf(input.value); activeRow = null; input.removeAttribute('aria-activedescendant');
      if (paths.length > 200 && window.RelatumWindowedList) {
        if (!list) { mounted.clear(); rows.replaceChildren(); list = window.RelatumWindowedList.create({ host: rows, scroller: menu,
          estimate: 32, reuseRows: true, key: path => path, render: option, onMount: syncActive }); }
        list.setItems(paths);
      } else {
        list?.dispose(); list = null; mounted.clear(); rows.replaceChildren(...paths.map(option));
      }
      syncActive(); popup.position();
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
    toggle.addEventListener('click', event => { event.preventDefault(); if (!popup.isOpen()) { input.focus({ preventScroll: true }); open(); } else close(); });
    input.addEventListener('click', open);
    input.addEventListener('input', event => { if (!event.isComposing) open(); });
    input.addEventListener('compositionstart', close); input.addEventListener('compositionend', open);
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape' && popup.isOpen()) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Enter' && popup.isOpen() && activeIndex >= 0) { event.preventDefault(); choose(paths[activeIndex]); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault(); open();
      if (popup.isOpen()) activate(activeIndex < 0 ? event.key === 'ArrowDown' ? 0 : paths.length - 1 : activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
    });
    menu.addEventListener('pointerdown', event => { if (event.target.closest('[data-folder-path]')) event.preventDefault(); else stopWheel(); });
    menu.addEventListener('click', event => { const row = event.target.closest('[data-folder-path]'); if (row) { event.preventDefault(); choose(row.dataset.folderPath); } });
    menu.addEventListener('pointermove', event => { const row = event.target.closest('[data-folder-path]'); const index = row && indexes.get(row.dataset.folderPath); if (index !== undefined && row) { activeIndex = index; syncActive(); } });
    return { close, setPaths(next) {
      if (availablePaths === next || availablePaths.length === next.length && availablePaths.every((path, i) => path === next[i])) return;
      availablePaths = next; normalizedPaths = next.map(path => path.toLocaleLowerCase()); if (popup.isOpen()) open();
    }, setLanguage() { toggle.setAttribute('aria-label', getLabel()); rows.setAttribute('aria-label', getLabel()); } };
  }

  function create(ctx) {
    const root = ctx.root, nav = ctx.navigation, results = ctx.results, back = ctx.back;
    let active = false, navigationOpen = false, disposed = false;
    const expanded = new Set(), navigation = new Map(), navigationDirty = new Set(providers.keys()), navigationSequences = new Map();
    const navigationLoading = new Set();
    const navigationGroups = new Map();
    let providerId = 'recent', selection = {}, rows = [], offset = 0, total = 0, hasMore = false, selectedPath = '';
    let pageSequence = 0, actionSequence = 0, loading = false, failed = false, dirty = true, refreshQueued = false;
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
    let folderPicker = null, scopePicker = null, sortPicker = null, datePickers = [];
    let filterShell = null, filterOpen = false, filterFrame = 0, filterTimer = 0, filterSequence = 0, dateError = null;
    let searchPendingKey = '', lastSearchKey = '';
    let searchView = null;
    const displayKeys = new WeakMap();
    const searchPopovers = createSearchPopovers(() => active && !disposed && !results.hidden && providerId === 'search', ctx.onPopoverOpen);
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
      if (wasHidden) { resultList?.resume(); results.scrollTop = resultScroll; }
    }
    function showDocument(options) {
      closePopovers({ instant: true });
      if (!options?.keepAction) actionSequence++;
      cancelReferenceRequests();
      const pending = loading || !!searchTimer;
      cancelSearch(); if (pending) dirty = true; resultList?.suspend();
      if (!results.hidden) resultScroll = results.scrollTop;
      ctx.showResults(false); results.hidden = true; results.inert = true;
      back.hidden = !active || !hasResult; updateBackLabel();
    }
    function updateBackLabel() { back.replaceChildren(...(ctx.icon ? [ctx.icon('arrow-left')] : []), document.createTextNode(copy('return'))); }
    function renderNavigation(animateId) {
      const reduced = motion.matches;
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
      ctx.closeCanvasContextMenu?.();
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
      row.dataset.noteBrowserPath = canvas.path;
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
      const contextMenu = (event, keyboard) => {
        if (host.contains(event.target) || !canvasInteractive() || !ctx.onCanvasContextMenu) return;
        event.preventDefault(); event.stopPropagation();
        const page = pageSequence, rect = row.getBoundingClientRect();
        ctx.onCanvasContextMenu({ browser: true, path: canvas.path, exists: canvas.exists, keyboard,
          x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY,
          isCurrent: () => canvasInteractive() && page === pageSequence && wrapper.isConnected });
      };
      wrapper.addEventListener('contextmenu', event => contextMenu(event, false));
      wrapper.addEventListener('keydown', event => {
        if (!event.isComposing && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) contextMenu(event, true);
      });
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
        scopeInput = document.createElement('button'); scopeInput.dataset.noteSearch = 'scope';
        sortInput = document.createElement('button'); sortInput.dataset.noteSearch = 'sort';
        scopePicker = createSelectPicker(scopeInput, searchPopovers); sortPicker = createSelectPicker(sortInput, searchPopovers);
        filtersButton = button('', () => {
          setFilterOpen(!filterOpen);
          if (filterOpen) tagsInput.focus({ preventScroll: true });
        }, 'note-search-filter-button'); filtersButton.setAttribute('aria-expanded', 'false');
        tools.append(scopeInput, sortInput, filtersButton);
        filterPanel = document.createElement('div'); filterPanel.className = 'note-search-filters'; filterPanel.hidden = true;
        filterShell = document.createElement('div'); filterShell.className = 'note-search-filter-disclosure'; filterShell.hidden = true; filterShell.inert = true;
        const clip = document.createElement('div'); clip.className = 'note-search-filter-clip'; clip.appendChild(filterPanel); filterShell.appendChild(clip);
        filterShell.addEventListener('transitionend', event => {
          if (!filterOpen && event.target === filterShell && event.propertyName === 'opacity' && Number(getComputedStyle(filterShell).opacity) < .001) settleFilters();
        });
        const input = name => {
          const label = document.createElement('label'), span = document.createElement('span'), field = document.createElement('input');
          field.type = 'text'; field.dataset.noteSearch = name; span.className = 'note-search-filter-label';
          label.append(span, field); filterPanel.appendChild(label); return field;
        };
        folderInput = input('folder'); tagsInput = input('tags'); afterInput = input('after'); beforeInput = input('before');
        folderPicker = createFolderPicker(folderInput, () => copy('folder'), searchPopovers);
        datePickers = [[afterInput, 'after'], [beforeInput, 'before']].map(([field, key]) => createDatePicker(field, () => copy(key), copy, ctx.language, searchPopovers));
        dateError = document.createElement('p'); dateError.className = 'note-search-date-error'; dateError.id = 'note-search-date-error'; dateError.hidden = true; dateError.setAttribute('role', 'status');
        [afterInput, beforeInput].forEach(field => field.setAttribute('aria-describedby', dateError.id));
        const clear = button('', () => {
          searchPopovers.close({ instant: true });
          for (const input of [folderInput, tagsInput, afterInput, beforeInput]) input.value = '';
          syncSearchFilters(); runSearch(0);
        }, 'note-search-clear'); clear.dataset.noteSearch = 'clear'; filterPanel.append(dateError, clear);
        controls.append(field, tools, filterShell);
        searchInput.addEventListener('compositionstart', () => { searchComposing = true; cancelSearch(); });
        searchInput.addEventListener('compositionend', () => { searchComposing = false; searchState.q = searchInput.value; runSearch(150); });
        searchInput.addEventListener('input', () => { searchState.q = searchInput.value; if (!searchComposing) runSearch(150); });
        searchInput.addEventListener('keydown', event => {
          if (event.isComposing || searchComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); runSearch(0); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('.note-browser-result')?.focus(); }
          else if (event.key === 'Escape') { event.preventDefault(); if (filterOpen) setFilterOpen(false); else { searchInput.value = ''; searchState.q = ''; runSearch(0); } }
        });
        for (const input of [scopeInput, sortInput, folderInput, tagsInput, afterInput, beforeInput]) {
          input.addEventListener('change', () => { if (input === scopeInput) { searchPopovers.close(); folderInput.value = ''; } syncSearchFilters(); if (!searchComposing) runSearch(0); });
          if (input.type === 'text') {
            input.addEventListener('input', () => { syncSearchFilters(); if (!searchComposing) runSearch(150); });
            input.addEventListener('compositionstart', () => { searchComposing = true; cancelSearch(); });
            input.addEventListener('compositionend', () => { searchComposing = false; syncSearchFilters(); runSearch(150); });
            input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !searchComposing) { event.preventDefault(); runSearch(0); } });
          }
        }
      }
      searchInput.placeholder = copy('searchHint'); searchInput.title = copy('phraseHint'); searchInput.setAttribute('aria-label', copy('search'));
      const selected = scopeInput.value || 'all';
      scopePicker.setOptions([{ value: 'all', label: copy('allBooks') }, ...(ctx.getNotebooks?.() || []).map(book => ({ value: 'b:' + book.path, label: book.name }))], selected, copy('allBooks'));
      folderPicker.setLanguage();
      folderPicker.setPaths(ctx.getFolderPaths?.() || (ctx.getEntries?.() || []).filter(item => item.kind === 'folder' && item.path !== 'CustomNotebook').map(item => item.path));
      sortPicker.setOptions(['relevance', 'modified'].map(key => ({ value: key === 'modified' ? 'modified-desc' : key, label: copy(key) })), searchState.sort, copy('relevance'));
      datePickers.forEach(picker => picker.setLanguage()); tagsInput.placeholder = copy('tagHint');
      for (const [input, label] of [[folderInput, 'folder'], [tagsInput, 'tagFilter'], [afterInput, 'after'], [beforeInput, 'before']]) {
        input.parentElement.querySelector('.note-search-filter-label').textContent = copy(label); input.setAttribute('aria-label', copy(label));
      }
      filterPanel.querySelector('[data-note-search="clear"]').textContent = copy('clearFilters');
      syncSearchFilters();
      return controls;
    }
    function settleFilters() {
      filterSequence++; cancelAnimationFrame(filterFrame); clearTimeout(filterTimer); filterFrame = filterTimer = 0;
      if (!filterShell) return;
      filterShell.classList.toggle('is-open', filterOpen); filterShell.hidden = filterPanel.hidden = !filterOpen; filterShell.inert = !filterOpen;
    }
    function closePopovers(options = {}) { searchPopovers.close(options); settleFilters(); }
    function setFilterOpen(next) {
      filterOpen = next; filterSequence++; cancelAnimationFrame(filterFrame); clearTimeout(filterTimer); filterFrame = filterTimer = 0;
      filtersButton.setAttribute('aria-expanded', String(next));
      if (!next) searchPopovers.close({ instant: true });
      filterShell.inert = !next;
      if (reducedMotion()) { settleFilters(); return; }
      const sequence = filterSequence;
      if (next) {
        filterShell.hidden = filterPanel.hidden = false;
        void filterShell.offsetHeight;
        filterFrame = requestAnimationFrame(() => { filterFrame = 0; if (sequence === filterSequence && filterOpen) filterShell.classList.add('is-open'); });
      } else {
        filterShell.classList.remove('is-open');
        filterTimer = setTimeout(() => { if (sequence === filterSequence && !filterOpen) settleFilters(); }, 230);
      }
    }
    function syncSearchFilters() {
      if (!controls) return true;
      const after = afterInput.value.trim(), before = beforeInput.value.trim();
      const afterDate = after ? parseDate(after) : null, beforeDate = before ? parseDate(before) : null;
      const invalidAfter = !!after && !afterDate, invalidBefore = !!before && !beforeDate;
      const reversed = afterDate && beforeDate && afterDate > beforeDate;
      afterInput.setAttribute('aria-invalid', String(invalidAfter || !!reversed)); beforeInput.setAttribute('aria-invalid', String(invalidBefore || !!reversed));
      dateError.hidden = !invalidAfter && !invalidBefore && !reversed;
      const errorText = copy(invalidAfter || invalidBefore ? 'invalidDate' : 'invalidRange');
      if (dateError.textContent !== errorText) dateError.textContent = errorText;
      const filterCount = [folderInput, tagsInput, afterInput, beforeInput].filter(input => input.value.trim()).length;
      const filterLabel = copy('filters') + (filterCount ? ' · ' + filterCount : '');
      if (filtersButton.textContent !== filterLabel) filtersButton.textContent = filterLabel;
      filterPanel.querySelector('[data-note-search="clear"]').disabled = !filterCount;
      if (!dateError.hidden) { if (searchView) searchView.more.disabled = true; return false; }
      let folder = folderInput.value.trim().replace(/\\/g, '/');
      const notebook = scopeInput.value.startsWith('b:') ? scopeInput.value.slice(2) : '';
      if (folder && notebook && !/^CustomNotebook(?:\/|$)/i.test(folder)) folder = notebook + '/' + folder;
      searchState.scope = folder ? { kind: 'folder', path: folder }
        : scopeInput.value.startsWith('b:') ? { kind: 'notebook', path: scopeInput.value.slice(2) } : { kind: 'all' };
      searchState.tags = tagsInput.value.split(/[\s,，]+/).map(tag => tag.replace(/^#/, '')).filter(Boolean);
      searchState.sort = sortInput.value;
      searchState.modified = {};
      if (afterDate) searchState.modified.after = afterDate.getTime() * 1e6;
      if (beforeDate) { beforeDate.setDate(beforeDate.getDate() + 1); searchState.modified.before = beforeDate.getTime() * 1e6; }
      return true;
    }
    function queryKey(state) { return JSON.stringify([state.q, state.scope, state.tags, state.modified, state.sort]); }
    function cancelSearch() {
      clearTimeout(searchTimer); searchTimer = 0; searchAbort?.abort(); searchPendingKey = ''; pageSequence++;
      if (loading) dirty = true;
      loading = false; resetting = false; refreshQueued = false; results.setAttribute('aria-busy', 'false');
    }
    function runSearch(delay) {
      const valid = syncSearchFilters(), key = queryKey(searchState);
      if (valid && searchPendingKey === key && !(delay === 0 && searchTimer)) return;
      if (valid && lastSearchKey === key && hasResult && resultProviderId === 'search' && !dirty && !failed && !searchPendingKey) return;
      cancelSearch();
      if (!valid) return;
      searchPendingKey = key;
      searchTimer = setTimeout(() => {
        searchTimer = 0;
        if (!active || disposed || providerId !== 'search' || searchComposing) return;
        selection = Object.assign({}, searchState);
        loadPage(true);
      }, delay);
    }
    function noteRow(note) {
      const row = button('', () => openResultNote(row.__note), 'note-browser-result');
      row.dataset.noteBrowserPath = note.path; updateNoteRow(row, note); return row;
    }
    function updateNoteRow(row, note) {
      row.classList.toggle('is-selected', note.path === selectedPath);
      if (row.__note === note) return;
      row.__note = note;
      if (!displayKeys.has(note)) displayKeys.set(note, JSON.stringify([note.title, note.excerpt, note.path, note.titleHighlights, note.pathHighlights, note.highlights, (note.tags || []).map(tag => tag.label)]));
      const key = displayKeys.get(note); if (row.__displayKey === key) return; row.__displayKey = key;
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
      row.replaceChildren(title, excerpt, tags, path);
    }
    function renderSearchResults() {
      const control = searchControls(), scroll = results.scrollTop;
      if (!searchView) {
        const shell = document.createElement('div'); shell.className = 'note-search-result-shell';
        const heading = document.createElement('header'); heading.className = 'note-browser-results-head';
        const title = document.createElement('h2'), count = document.createElement('span'); heading.append(title, count);
        const host = document.createElement('div'); host.className = 'note-browser-list';
        const message = document.createElement('div'); message.className = 'note-search-empty';
        if (ctx.icon) message.appendChild(ctx.icon('search'));
        const messageTitle = document.createElement('strong'), hint = document.createElement('p'); message.append(messageTitle, hint);
        const retry = button('', () => { if (!loading) loadPage(failedReset); }, 'note-browser-message');
        const more = button('', () => loadPage(false), 'note-browser-more');
        const status = document.createElement('p'); status.className = 'note-search-progress'; status.setAttribute('role', 'status');
        shell.append(heading, status, host, message, retry, more);
        searchView = { shell, title, count, host, message, messageTitle, hint, retry, more, status, nodes: new Map(), list: null, items: null };
      }
      const view = searchView, text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
      if (view.shell.parentElement !== results) results.replaceChildren(control, view.shell);
      text(view.title, copy('search')); text(view.count, copy(total === 1 && ctx.language() === 'en' ? 'countOne' : 'count').replace('{count}', total));
      const windowed = rows.length > 200 && !!window.RelatumWindowedList;
      const focusedPath = view.host.contains(document.activeElement) ? document.activeElement.dataset.noteBrowserPath : '';
      if (view.list && resultList !== view.list) { view.list = null; view.items = null; }
      if (windowed) {
        if (!view.list) {
          resultList?.dispose();
          view.list = window.RelatumWindowedList.create({ host: view.host, scroller: results, estimate: 118, reuseRows: true,
            key: note => note.path, render: note => view.nodes.get(note.path) || noteRow(note), update: updateNoteRow });
          resultList = view.list; view.items = null;
        }
        if (view.items !== rows) { view.list.setItems(rows); view.items = rows; }
        view.nodes.clear();
        if (focusedPath && !view.host.contains(document.activeElement)) {
          const row = view.list.row(focusedPath) || view.list.scrollToKey(focusedPath); row?.focus({ preventScroll: true });
        }
      } else {
        if (view.list) { view.list.dispose(); resultList = view.list = null; view.host.replaceChildren(); view.nodes.clear(); }
        const keys = new Set(rows.map(note => note.path));
        let next = view.host.firstElementChild;
        rows.forEach(note => {
          let row = view.nodes.get(note.path); if (!row) { row = noteRow(note); view.nodes.set(note.path, row); }
          else updateNoteRow(row, note);
          if (row !== next) {
            if (view.host.moveBefore && row.isConnected === view.host.isConnected) view.host.moveBefore(row, next);
            else view.host.insertBefore(row, next);
          }
          next = row.nextElementSibling;
        });
        view.nodes.forEach((row, key) => { if (!keys.has(key)) { row.remove(); view.nodes.delete(key); } });
        if (focusedPath && view.nodes.has(focusedPath) && document.activeElement?.dataset.noteBrowserPath !== focusedPath) view.nodes.get(focusedPath).focus({ preventScroll: true });
      }
      const meaningful = searchState.q.trim() || searchState.tags.length || searchState.scope.kind === 'folder' || Object.keys(searchState.modified).length;
      view.message.hidden = failed || !!rows.length;
      text(view.messageTitle, loading && !hasResult ? copy('loading') : meaningful ? copy('empty') : copy('typeToSearch'));
      text(view.hint, meaningful ? copy('emptyHint') : copy('phraseHint'));
      view.hint.hidden = loading && !hasResult;
      view.retry.hidden = !failed; text(view.retry, copy(failureCode === 'statistics_incomplete' ? 'incomplete' : 'failed'));
      view.more.hidden = !hasMore || failed || !rows.length; view.more.disabled = loading;
      text(view.more, copy(loading ? 'loading' : 'more'));
      view.status.hidden = !indexState || indexState.phase === 'ready';
      text(view.status, indexState?.phase === 'partial' ? copy('partialIndex') : copy('preparing') + ' · ' + (indexState?.indexed || 0) + ' / ' + (indexState?.total || 0));
      results.scrollTop = scroll;
    }
    function renderResults() {
      cancelReferenceRequests();
      if (resultProviderId === 'search') { renderSearchResults(); return; }
      if (searchView?.list) {
        searchView.list.dispose(); if (resultList === searchView.list) resultList = null;
        searchView.list = null; searchView.items = null; searchView.nodes.clear(); searchView.host.replaceChildren();
      }
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
      results.replaceChildren(fragment);
      resultList?.setItems(rows); results.scrollTop = scroll;
    }
    async function loadPage(reset, preserveScroll, pageCount = 1) {
      if (!active || disposed || (!reset && (loading || searchTimer))) return false;
      if (providerId === 'search' && !syncSearchFilters()) return false;
      const sequence = ++pageSequence;
      if (reset && providerId === 'search') {
        searchAbort?.abort(); searchAbort = new AbortController();
        selection = Object.assign({}, selection, { signal: searchAbort.signal });
      }
      const requestProviderId = providerId, requestSelection = selection, requestOffset = reset ? 0 : offset;
      cancelReferenceRequests();
      loading = true; resetting = reset; preservingScroll = !!preserveScroll; failed = false; failureCode = '';
      if (reset) dirty = true;
      results.setAttribute('aria-busy', 'true');
      // Keep the committed view intact until the replacement page is ready.
      if (!hasResult) { resultProviderId = requestProviderId; resultSelection = requestSelection; }
      if (requestProviderId === 'search' && searchView) searchView.more.disabled = true;
      if (!reset || !hasResult) renderResults();
      try {
        let result, nextOffset = requestOffset, nextCursor = reset ? null : resultCursor;
        const nextItems = [];
        for (let page = 0; page < pageCount; page++) {
          result = await providers.get(requestProviderId).loadPage(ctx, requestSelection, nextOffset, nextCursor);
          if (!active || disposed || sequence !== pageSequence) return false;
          const items = result.items || [];
          nextItems.push(...items);
          nextOffset += result.consumed ?? items.length; nextCursor = result.cursor || null;
          if (result.missingRecent) ctx.pruneRecent?.(result.missingRecent);
          if (!result.hasMore) break;
        }
        if (requestProviderId === 'canvas') canvasSignature = result.signature;
        indexState = result.index || ctx.getIndexState?.();
        resultCursor = nextCursor;
        rows = reset ? nextItems : rows.concat(nextItems); total = result.total; hasMore = !!result.hasMore;
        resultProviderId = requestProviderId; resultSelection = requestSelection; hasResult = true;
        offset = nextOffset; dirty = refreshQueued; loading = false; resetting = false;
        if (requestProviderId === 'search') { lastSearchKey = queryKey(requestSelection); searchPendingKey = ''; }
        results.setAttribute('aria-busy', 'false'); renderResults();
        if (reset && !preserveScroll) { resultScroll = 0; results.scrollTop = 0; }
        if (refreshQueued && !results.hidden) { refreshQueued = false; await refreshResults(); }
        return true;
      } catch (error) {
        if (!active || disposed || sequence !== pageSequence) return;
        if (error.name === 'AbortError') { loading = false; searchPendingKey = ''; return; }
        if (error.code === 'query_changed' && !reset) {
          loading = false;
          return loadPage(true, true, Math.max(1, Math.ceil((requestOffset + 50) / 50)));
        }
        failureCode = error.code || '';
        if (reset && !preserveScroll) {
          rows = []; offset = 0; total = 0; hasMore = false;
          resultProviderId = requestProviderId; resultSelection = requestSelection;
        }
        hasResult = true; loading = false; resetting = false; failed = true; failedReset = reset; searchPendingKey = ''; refreshQueued = false;
        results.setAttribute('aria-busy', 'false'); renderResults();
        if (reset && !preserveScroll) { resultScroll = 0; results.scrollTop = 0; }
        return false;
      }
    }
    async function refreshResults() {
      if (!active || disposed) return;
      if (loading || searchTimer || searchComposing) { refreshQueued = true; return; }
      if (providerId === 'search' && !syncSearchFilters()) return;
      refreshQueued = false;
      const preserveScroll = (!resetting || preservingScroll) && resultProviderId === providerId && resultSelection.key === selection.key;
      const pages = preserveScroll ? Math.max(1, Math.ceil(offset / 50)) : 1, scroll = preserveScroll ? (results.hidden ? resultScroll : results.scrollTop) : 0;
      const focused = results.contains(document.activeElement) ? document.activeElement : null;
      const focusedPath = focused?.dataset.noteBrowserPath;
      const sequence = pageSequence + 1;
      if (!(await loadPage(true, preserveScroll, pages)) || sequence !== pageSequence) return;
      const movedToControls = focused && document.activeElement !== focused && controls?.contains(document.activeElement);
      resultScroll = movedToControls ? results.scrollTop : scroll; results.scrollTop = resultScroll;
      // A retained item can fall outside the first refreshed page. Restore it
      // after all saved pages return, without stealing a newly moved focus.
      if (focusedPath && !results.hidden && (document.activeElement === focused || document.activeElement === document.body)) {
        const row = resultList?.row(focusedPath) || resultList?.scrollToKey(focusedPath)
          || searchView?.nodes.get(focusedPath) || Array.from(results.querySelectorAll('.note-browser-result')).find(node => node.dataset.noteBrowserPath === focusedPath);
        row?.focus({ preventScroll: true }); results.scrollTop = scroll;
      }
    }
    async function select(id, next) {
      closePopovers({ instant: true });
      if (!active || disposed) return;
      if (providers.get(id)?.enabled && !providers.get(id).enabled(ctx)) return;
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      cancelSearch();
      cancelReferenceRequests();
      providerId = id; selection = id === 'search' ? Object.assign({}, searchState, next) : next; selectedPath = ''; showResults(); renderNavigation();
      await loadPage(true);
    }
    const onBack = async () => {
      const sequence = ++actionSequence;
      if (!(await ctx.beforeBrowse()) || !active || sequence !== actionSequence) return;
      showResults(); renderResults(); results.scrollTop = resultScroll;
      if (providerId === 'search' && queryKey(searchState) !== lastSearchKey) { runSearch(0); return; }
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
      closePopovers,
      suspend(options) { closePopovers({ instant: true }); active = false; clearTimeout(searchTimer); searchTimer = 0; searchAbort?.abort(); searchPendingKey = ''; refreshQueued = false; resultList?.suspend(); cancelReferenceRequests(); pageSequence++; cancelNavigation(); actionSequence++; if (loading) dirty = true; loading = false; resetting = false; results.setAttribute('aria-busy', 'false'); if (!(options && options.keepView)) { showDocument(); back.hidden = true; } },
      resume() { active = true; resultList?.resume(); if (navigationOpen) renderNavigation(); if (!results.hidden && dirty) refreshResults(); loadNavigation(); },
      dispose() { this.suspend(); resultList?.dispose(); searchPopovers.dispose(); disposed = true; back.removeEventListener('click', onBack); nav.replaceChildren(); results.replaceChildren(); searchView = null; },
      setLanguage() { closePopovers({ instant: true }); renderNavigation(); if (hasResult) renderResults(); updateBackLabel(); },
      showDocument,
      checkExternalCanvases,
      invalidate() { dirty = true; providers.forEach((provider) => navigationDirty.add(provider.id)); if (active) { if (!results.hidden) refreshResults(); loadNavigation(); } },
    };
  }
  window.RelatumNoteBrowser = { create, registerProvider };
})();

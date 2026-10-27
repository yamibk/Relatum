// Extension overview and detail navigation. Settings never load an editor runtime.
(function () {
  'use strict';
  function createPanel({ language }) {
    const registry = window.RelatumNoteExtensions;
    const panel = document.createElement('section'); panel.className = 'note-extension-settings'; panel.dataset.i18nManaged = 'true';
    const overview = document.createElement('div'); overview.className = 'note-extension-overview';
    const intro = document.createElement('p'); overview.append(intro);
    const detail = document.createElement('div'); detail.className = 'note-extension-detail'; detail.hidden = true;
    const back = document.createElement('button'); back.type = 'button'; back.className = 'note-extension-back'; back.dataset.extensionAction = 'back';
    const heading = document.createElement('div'); heading.className = 'note-extension-detail-head';
    const identity = document.createElement('div'), name = document.createElement('h3'), version = document.createElement('span'), description = document.createElement('p');
    const title = document.createElement('span'); name.append(title, version); identity.append(name, description);
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'note-extension-detail-toggle';
    const enabled = document.createElement('input'); enabled.type = 'checkbox';
    const enabledText = document.createElement('span'); enabledLabel.append(enabled, enabledText); heading.append(identity, enabledLabel);
    const body = document.createElement('div'); body.className = 'note-extension-detail-body';
    const detailStatus = document.createElement('div'); detailStatus.className = 'note-extension-status'; detailStatus.setAttribute('role', 'status');
    detail.append(back, heading, detailStatus, body);
    const searchIndex = document.createElement('div'); searchIndex.hidden = true;
    panel.append(overview, detail, searchIndex);
    let selected = null, active = false;
    const rows = registry.list().map(definition => {
      const card = document.createElement('article'); card.className = 'note-extension-card'; card.dataset.extensionId = definition.id;
      const label = document.createElement('label'); label.className = 'note-extension-toggle';
      const text = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small');
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.extensionEnabled = definition.id;
      text.append(title, description); label.append(text, input); card.append(label);
      input.addEventListener('change', () => registry.set(definition.id, { enabled: input.checked }));
      const status = document.createElement('div'); status.className = 'note-extension-status'; status.setAttribute('role', 'status');
      const configure = document.createElement('button'); configure.type = 'button'; configure.className = 'note-extension-configure'; configure.dataset.extensionConfigure = definition.id;
      configure.addEventListener('click', () => open(row, true));
      const row = { definition, input, title, description, status, configure, settings: null };
      if (definition.createSettings) card.append(configure);
      card.append(status); overview.append(card); return row;
    });
    function errorStatus(root, id) {
      const english = language() === 'en', error = registry.error(id); root.hidden = !error; root.replaceChildren();
      if (!error) return;
      const text = document.createElement('span'); text.textContent = error === 'storage' ? (english ? 'Could not save the setting.' : '设置保存失败。')
        : (english ? 'Extension could not start. ' : '扩展暂未启动。') + error;
      root.append(text);
      if (error !== 'storage') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.dataset.extensionRetry = id; retry.textContent = english ? 'Retry' : '重试';
        retry.addEventListener('click', () => registry.retry(id)); root.append(retry);
      }
    }
    function open(row, focus = false) {
      if (!row.settings) row.settings = row.definition.createSettings({ language,
        read: () => registry.read(row.definition.id).options, update: options => registry.set(row.definition.id, { options }) });
      selected?.settings?.setActive?.(false);
      selected = row; panel.dataset.detail = row.definition.id;
      overview.hidden = true; detail.hidden = false; body.replaceChildren(row.settings.panel);
      enabled.dataset.extensionEnabled = row.definition.id; row.settings.setActive?.(active); refresh();
      if (focus) back.focus({ preventScroll: true });
      return row.settings;
    }
    function showOverview(focus = false) {
      const previous = selected; previous?.settings?.setActive?.(false); selected = null;
      delete panel.dataset.detail; overview.hidden = false; detail.hidden = true; enabled.removeAttribute('data-extension-enabled');
      if (focus) previous?.configure.focus({ preventScroll: true });
    }
    back.addEventListener('click', () => showOverview(true));
    enabled.addEventListener('change', () => { if (selected) registry.set(selected.definition.id, { enabled: enabled.checked }); });
    function refresh() {
      const english = language() === 'en', index = english ? 1 : 0;
      intro.textContent = english ? 'Built-in offline extensions. Configure the tools you need.' : '随软件附带的离线扩展，按需开启与配置。';
      back.textContent = english ? '← Extensions' : '← 扩展';
      rows.forEach(row => {
        row.input.checked = registry.read(row.definition.id).enabled;
        row.title.textContent = row.definition.name[index] + ' ' + (row.definition.displayVersion || row.definition.version);
        row.description.textContent = row.definition.description[index]; row.configure.textContent = english ? 'Configure' : '配置';
        errorStatus(row.status, row.definition.id); row.settings?.refresh();
      });
      if (selected) {
        const definition = selected.definition;
        title.textContent = definition.name[index]; version.textContent = definition.displayVersion || definition.version;
        description.textContent = definition.description[index]; enabled.checked = registry.read(definition.id).enabled;
        enabledText.textContent = enabled.checked ? (english ? 'Enabled' : '已启用') : (english ? 'Disabled' : '已关闭');
        errorStatus(detailStatus, definition.id);
      }
    }
    const unsubscribe = registry.subscribe(refresh); refresh();
    return { panel, refresh,
      setActive(value) { active = value === true; selected?.settings?.setActive?.(active); },
      searchTargets(query) {
        searchIndex.replaceChildren();
        const english = language() === 'en', index = english ? 1 : 0, terms = query.split(/\s+/).filter(Boolean);
        rows.forEach(row => {
          const definition = row.definition;
          const context = [definition.name.join(' '), '扩展 extensions'].join(' ');
          const entries = typeof definition.settingsSearch === 'function' ? definition.settingsSearch(registry.read(definition.id).options, language()) : [];
          const generic = [context, definition.description.join(' '), definition.keywords || ''].join(' ').toLocaleLowerCase();
          const exactName = terms.every(term => context.toLocaleLowerCase().includes(term));
          const matches = exactName ? [] : entries.filter(entry => terms.every(term => [context, entry.name, entry.keywords].join(' ').toLocaleLowerCase().includes(term)));
          if (!matches.length && terms.every(term => generic.includes(term))) matches.push({ name: definition.name[index], key: '' });
          matches.forEach(entry => {
            const proxy = document.createElement('button'); proxy.type = 'button'; proxy.dataset.extensionSearch = definition.id; proxy.dataset.extensionTarget = entry.key || '';
            proxy.setAttribute('aria-label', entry.name); proxy.dataset.settingsKeywords = [context, entry.name, entry.keywords, query].join(' ');
            const title = document.createElement('strong'); title.textContent = entry.name; proxy.append(title); searchIndex.append(proxy);
          });
        });
        return Array.from(searchIndex.children);
      },
      reveal(target) {
        const id = target.dataset.extensionSearch;
        const row = rows.find(item => item.definition.id === id);
        if (!row) { showOverview(); return target === panel ? rows[0]?.configure || panel : target; }
        const settings = open(row);
        return settings.reveal?.(target.dataset.extensionTarget) || back;
      },
      reset() { rows.forEach(row => row.settings?.reset?.()); refresh(); },
      close() { active = false; showOverview(); rows.forEach(row => row.settings?.close?.()); searchIndex.replaceChildren(); },
      destroy() { unsubscribe(); rows.forEach(row => row.settings?.destroy?.()); },
    };
  }
  function createLatexPanel({ language, read, update }) {
    const definition = window.RelatumNoteExtensions.list().find(item => item.id === 'latex-input');
    const panel = document.createElement('div'); panel.className = 'note-latex-settings'; panel.dataset.snippetView = 'list';
    const tr = (cn, en) => language() === 'en' ? en : cn;
    const make = (tag, className, parent) => { const element = document.createElement(tag); if (className) element.className = className; parent?.append(element); return element; };
    const button = (parent, action, className = '') => { const element = make('button', className, parent); element.type = 'button'; if (action) element.dataset.latexAction = action; return element; };
    const tabs = make('div', 'note-latex-tabs', panel); tabs.setAttribute('role', 'tablist');
    const pages = make('div', 'note-latex-pages', panel), tabButtons = new Map(), tabPages = new Map();
    for (const id of ['basic', 'snippets', 'guide']) {
      const entry = button(tabs); entry.dataset.latexTab = id; entry.id = 'note-latex-tab-' + id; entry.setAttribute('role', 'tab');
      entry.setAttribute('aria-controls', 'note-latex-page-' + id); tabButtons.set(id, entry);
      const page = make('section', 'note-latex-page', pages); page.id = 'note-latex-page-' + id; page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', entry.id); tabPages.set(id, page);
      entry.addEventListener('click', () => setTab(id));
    }
    const controls = definition.settingsControls.map(item => {
      const label = make('label', 'note-latex-option', tabPages.get('basic'));
      const text = make('span', '', label), name = make('strong', '', text), hint = make('small', '', text);
      const input = make('input', '', label); input.type = 'checkbox'; input.dataset.extensionOption = item.id;
      input.addEventListener('change', () => update({ [item.id]: input.checked }));
      return { item, input, label, name, hint };
    });
    const snippetPage = tabPages.get('snippets'); snippetPage.classList.add('note-latex-snippets');
    const toolbar = make('div', 'note-latex-toolbar', snippetPage);
    const search = make('input', 'note-latex-search', toolbar); search.type = 'search'; search.dataset.latexSearch = '';
    const add = button(toolbar, 'add', 'note-latex-add');
    const filters = make('div', 'note-latex-filters', snippetPage), groupButtons = new Map();
    definition.settingsGroups.forEach(([id]) => {
      const entry = button(filters); entry.dataset.latexGroup = id; groupButtons.set(id, entry);
      entry.addEventListener('click', () => { group = id; if (fresh?.id === selected) selected = ''; panel.dataset.snippetView = 'list'; renderList(); });
    });
    const workspace = make('div', 'note-latex-workspace', snippetPage);
    const library = make('div', 'note-latex-library', workspace), list = make('div', 'note-latex-list', library);
    list.setAttribute('role', 'listbox');
    const empty = make('p', 'note-latex-empty', library); empty.setAttribute('role', 'status');
    const editor = make('div', 'note-latex-editor', workspace);
    const editorEmpty = make('p', 'note-latex-empty', editor);
    const form = make('form', 'note-latex-form', editor); form.hidden = true;
    const listBack = button(form, 'list', 'note-latex-list-back');
    const editorHead = make('header', 'note-latex-editor-head', form), identity = make('div', '', editorHead);
    const editorName = make('h4', '', identity), source = make('small', '', identity), dirty = make('small', 'note-latex-dirty', identity);
    const enabledLabel = make('label', 'note-latex-enabled', editorHead), enabled = make('input', '', enabledLabel), enabledText = make('span', '', enabledLabel);
    enabled.type = 'checkbox'; enabled.dataset.latexEnabled = '';
    const fieldArea = make('div', 'note-latex-editor-fields', form), fields = {};
    for (const key of ['trigger', 'replacement', 'boundary']) {
      const label = make('label', 'note-latex-field', fieldArea), name = make('span', '', label);
      const input = make(key === 'replacement' ? 'textarea' : key === 'boundary' ? 'select' : 'input', '', label); input.dataset.latexField = key;
      if (key === 'boundary') ['start', 'suffix', 'any'].forEach(value => { const option = make('option', '', input); option.value = value; });
      else { input.maxLength = key === 'trigger' ? 64 : 4096; input.spellcheck = false; }
      fields[key] = { input, name };
      if (key === 'replacement') make('small', 'note-latex-placeholder-help', label);
      input.addEventListener('input', () => {
        const item = current(); if (!item) return;
        const draft = getDraft(item); Object.keys(fields).forEach(key => { draft[key] = fields[key].input.value; });
        clearMessage(); updateDirty(item, draft);
      });
    }
    const error = make('p', 'note-latex-error', fieldArea); error.setAttribute('role', 'alert');
    const footer = make('footer', 'note-latex-editor-footer', form), actions = make('div', '', footer);
    const save = make('button', 'note-latex-save', actions); save.type = 'submit'; save.dataset.latexAction = 'save';
    const cancel = button(actions, 'cancel');
    const restore = button(footer, 'restore', 'note-latex-restore');
    const status = make('p', 'note-latex-status', footer); status.setAttribute('role', 'status');
    const guide = make('div', 'note-latex-guide', tabPages.get('guide'));
    const guideRows = [ ['平方根', 'Square root', 'sq → \\sqrt{…}'], ['分式', 'Fraction', 'x/ → \\frac{x}{…}'],
      ['连续命令', 'Continuous commands', '@asr → \\alpha^{2}'], ['向量', 'Vector', 'xvec → \\vec{x}'],
      ['下一占位', 'Next placeholder', 'Tab'], ['上一占位', 'Previous placeholder', 'Shift+Tab'], ['结束占位', 'End placeholders', 'Escape'],
      ['矩阵分列', 'Matrix cell', 'Tab → &'], ['矩阵换行', 'Matrix row', 'Enter → \\\\'], ['跳出矩阵', 'Exit matrix', 'Shift+Enter'] ];
    const guideElements = guideRows.map(row => { const container = make('div', '', guide); return { row, name: make('strong', '', container), code: make('code', '', container) }; });
    const guideNote = make('p', 'note-latex-guide-note', tabPages.get('guide'));
    const drafts = new Map();
    let tab = 'basic', group = 'common', selected = '', fresh = null, query = '', composing = false, saving = false, signature = '', renderedLanguage = '', errorKey = '';
    const entries = () => definition.effectiveSnippets(read());
    const current = () => fresh?.id === selected ? fresh : entries().find(item => item.id === selected);
    const getDraft = item => {
      if (!drafts.has(item.id)) drafts.set(item.id, { ...item });
      return drafts.get(item.id);
    };
    const isDirty = (item, draft) => item === fresh || Object.keys(fields).some(key => item[key] !== draft[key]);
    function updateDirty(item, draft) { const changed = isDirty(item, draft); dirty.hidden = !changed; save.disabled = !changed; cancel.disabled = !changed; }
    function message(key) {
      return ({ trigger: tr('触发词须为 1–64 个非空白字符，不能包含反斜杠或 $。', 'Use 1–64 non-whitespace characters without backslashes or $.'),
        replacement: tr('替换内容须为 1–4096 个字符。', 'Use 1–4096 characters for the replacement.'),
        placeholder: tr('占位只支持 $1–$9 和 $0，每个编号只能出现一次。', 'Use $1–$9 and $0, each at most once.'),
        boundary: tr('请选择匹配方式。', 'Choose a match boundary.'), duplicate: tr('该触发词已被其他片段使用。', 'Another snippet already uses this trigger.'),
        limit: tr('最多添加 128 条自定义片段。', 'Up to 128 custom snippets are supported.'), storage: tr('保存失败，请重试。', 'Could not save. Please retry.') })[key] || '';
    }
    function clearMessage() { errorKey = ''; error.textContent = ''; status.textContent = ''; }
    function fail(key) { errorKey = key; error.textContent = message(key); error.scrollIntoView({ block: 'nearest' }); }
    function persist(item, remove = false) {
      const key = definition.snippets.some(base => base.id === item.id) ? 'overrides' : 'custom';
      const items = read()[key].filter(other => other.id !== item.id); if (!remove) items.push(item);
      saving = true;
      try { return update({ [key]: items }); } finally { saving = false; }
    }
    function setTab(id, focus = false) {
      tab = tabButtons.has(id) ? id : 'basic';
      tabPages.forEach((page, key) => { page.hidden = key !== tab; });
      tabButtons.forEach((entry, key) => { entry.setAttribute('aria-selected', String(key === tab)); entry.tabIndex = key === tab ? 0 : -1; });
      panel.dataset.tab = tab;
      if (tab === 'snippets') renderList();
      if (focus) tabButtons.get(tab).focus({ preventScroll: true });
    }
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const ids = Array.from(tabButtons.keys()), index = ids.indexOf(tab);
      setTab(event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(index + (event.key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length], true);
    });
    function renderList() {
      const all = entries(), terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = all.filter(item => {
        const info = definition.snippetInfo(item, language());
        return (group === 'all' || info.group === group) && terms.every(term =>
          [item.trigger, item.replacement, info.name, definition.snippetInfo(item, 'en').name, definition.snippetInfo(item, 'zh').name].join(' ').toLocaleLowerCase().includes(term));
      });
      if (!fresh || selected !== fresh.id) { if (!matches.some(item => item.id === selected)) selected = matches[0]?.id || ''; }
      const scrollTop = library.scrollTop, focused = document.activeElement?.closest('[data-latex-snippet]')?.dataset.latexSnippet;
      list.replaceChildren();
      matches.forEach(item => {
        const entry = button(list); entry.dataset.latexSnippet = item.id; entry.setAttribute('role', 'option');
        entry.setAttribute('aria-selected', String(item.id === selected)); entry.tabIndex = item.id === selected ? 0 : -1;
        entry.setAttribute('aria-label', item.trigger + ' · ' + definition.snippetInfo(item, language()).name + (item.enabled ? '' : tr('，已关闭', ', disabled')));
        const identity = make('span', '', entry), trigger = make('code', '', identity), name = make('small', '', identity);
        trigger.textContent = item.trigger; trigger.title = item.trigger; name.textContent = definition.snippetInfo(item, language()).name;
        const preview = make('code', 'note-latex-preview', entry); preview.textContent = item.replacement.replace(/\$[1-9]/g, '…').replace(/\$0/g, ''); preview.title = preview.textContent;
        entry.classList.toggle('is-disabled', !item.enabled);
        entry.addEventListener('click', () => {
          selected = item.id; panel.dataset.snippetView = 'editor'; clearMessage(); renderList();
          if (!library.getClientRects().length) fields.trigger.input.focus({ preventScroll: true });
        });
      });
      groupButtons.forEach((entry, id) => entry.setAttribute('aria-pressed', String(group === id)));
      empty.hidden = matches.length > 0;
      empty.textContent = query ? tr('没有匹配的片段。', 'No matching snippets.') : tr('还没有自定义片段，点击“添加片段”开始。', 'No custom snippets yet. Choose Add snippet to start.');
      library.scrollTop = scrollTop;
      if (focused) Array.from(list.children).find(entry => entry.dataset.latexSnippet === focused)?.focus({ preventScroll: true });
      renderEditor();
    }
    list.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(list.children); if (!items.length) return;
      event.preventDefault(); const index = items.findIndex(entry => entry.dataset.latexSnippet === selected);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      selected = items[next].dataset.latexSnippet; clearMessage(); renderList();
      const target = Array.from(list.children).find(entry => entry.dataset.latexSnippet === selected); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
    });
    function renderEditor() {
      const item = current(); form.hidden = !item; editorEmpty.hidden = !!item;
      if (!item) { panel.dataset.snippetView = 'list'; return; }
      const draft = getDraft(item), info = definition.snippetInfo(item, language()), builtIn = definition.snippets.some(base => base.id === item.id);
      editorName.textContent = info.name; source.textContent = builtIn ? tr('内置片段', 'Built-in snippet') : tr('自定义片段', 'Custom snippet');
      enabled.checked = item === fresh ? draft.enabled : item.enabled;
      Object.keys(fields).forEach(key => { if (fields[key].input.value !== draft[key]) fields[key].input.value = draft[key]; });
      restore.dataset.latexAction = builtIn ? 'restore' : 'delete'; restore.hidden = item === fresh;
      restore.textContent = builtIn ? tr('恢复此片段默认值', 'Restore this snippet') : tr('删除片段', 'Delete snippet');
      updateDirty(item, draft);
    }
    search.addEventListener('compositionstart', () => { composing = true; });
    const applySearch = () => { query = search.value; if (fresh?.id === selected) selected = ''; panel.dataset.snippetView = 'list'; renderList(); };
    search.addEventListener('compositionend', () => { composing = false; applySearch(); });
    search.addEventListener('input', () => { if (!composing) applySearch(); });
    add.addEventListener('click', () => {
      if (!fresh) fresh = { id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10), trigger: '', replacement: '', boundary: 'start', enabled: true };
      selected = fresh.id; group = 'custom'; query = ''; search.value = ''; panel.dataset.snippetView = 'editor'; clearMessage(); setTab('snippets');
      if (read().custom.length >= 128) fail('limit'); fields.trigger.input.focus({ preventScroll: true });
    });
    listBack.addEventListener('click', () => { panel.dataset.snippetView = 'list';
      (Array.from(list.children).find(entry => entry.dataset.latexSnippet === selected) || add).focus({ preventScroll: true }); });
    enabled.addEventListener('change', () => {
      const item = current(); if (!item) return;
      if (item === fresh) { getDraft(item).enabled = enabled.checked; updateDirty(item, getDraft(item)); return; }
      if (!persist({ ...item, enabled: enabled.checked })) { enabled.checked = item.enabled; fail('storage'); }
      else { signature = ''; refresh(); }
    });
    form.addEventListener('submit', event => {
      event.preventDefault(); const item = current(); if (!item) return;
      const draft = getDraft(item), value = { id: item.id, trigger: draft.trigger, replacement: draft.replacement, boundary: draft.boundary,
        enabled: item === fresh ? draft.enabled !== false : item.enabled !== false };
      const issue = definition.snippetProblem(value) || (entries().some(other => other.id !== item.id && other.trigger === value.trigger) ? 'duplicate' : '')
        || (item === fresh && read().custom.length >= 128 ? 'limit' : '');
      if (issue) { fail(issue); return; }
      if (!persist(value)) { fail('storage'); return; }
      drafts.delete(item.id); if (item === fresh) fresh = null; clearMessage(); signature = ''; refresh(); status.textContent = tr('已保存', 'Saved');
    });
    cancel.addEventListener('click', () => {
      drafts.delete(selected); if (fresh?.id === selected) { fresh = null; selected = ''; panel.dataset.snippetView = 'list'; }
      clearMessage(); renderList(); if (!current()) add.focus({ preventScroll: true });
    });
    restore.addEventListener('click', () => {
      const item = current(); if (!item || item === fresh) return;
      const base = definition.snippets.find(other => other.id === item.id);
      if (base && entries().some(other => other.id !== item.id && other.trigger === base.trigger)) { fail('duplicate'); return; }
      if (!persist(item, true)) { fail('storage'); return; }
      drafts.delete(item.id); clearMessage(); signature = ''; refresh();
    });
    function refresh() {
      const english = language() === 'en', index = english ? 1 : 0, options = read();
      tabButtons.get('basic').textContent = tr('基础设置', 'Basics'); tabButtons.get('snippets').textContent = tr('片段管理', 'Snippets'); tabButtons.get('guide').textContent = tr('使用说明', 'Usage');
      tabs.setAttribute('aria-label', tr('latex 辅助输入设置', 'LaTeX input settings'));
      controls.forEach(row => { row.input.checked = options[row.item.id]; row.name.textContent = row.item.name[index]; row.hint.textContent = row.item.description[index]; });
      search.placeholder = tr('搜索触发词或替换内容', 'Search triggers or replacements'); search.setAttribute('aria-label', tr('搜索片段', 'Search snippets'));
      add.textContent = tr('+ 添加片段', '+ Add snippet');
      definition.settingsGroups.forEach(([id, cn, en]) => { groupButtons.get(id).textContent = english ? en : cn; });
      list.setAttribute('aria-label', tr('公式片段', 'Math snippets')); editorEmpty.textContent = tr('选择一个片段查看与编辑。', 'Choose a snippet to view and edit.');
      listBack.textContent = tr('← 片段列表', '← Snippet list'); enabledText.textContent = tr('启用', 'Enable'); dirty.textContent = tr('未保存', 'Unsaved');
      fields.trigger.name.textContent = tr('触发词', 'Trigger'); fields.replacement.name.textContent = tr('替换模板', 'Replacement'); fields.boundary.name.textContent = tr('匹配方式', 'Match boundary');
      fieldArea.querySelector('.note-latex-placeholder-help').textContent = tr('$1–$9：占位 · $0：退出位置', '$1–$9: placeholders · $0: exit position');
      Array.from(fields.boundary.input.options).forEach((entry, index) => { entry.textContent = tr(['词首', '后缀', '任意位置'][index], ['Start', 'Suffix', 'Anywhere'][index]); });
      save.textContent = tr('保存更改', 'Save changes'); cancel.textContent = tr('取消', 'Cancel'); error.textContent = message(errorKey);
      guideElements.forEach(({ row, name, code }) => { name.textContent = row[index]; code.textContent = row[2]; });
      guideNote.textContent = tr('仅在已闭合公式内生效。粘贴、输入法候选与多光标不自动展开；嵌套片段完成后继续返回外层占位。',
        'Works inside closed equations. Paste, IME composition and multiple cursors do not expand automatically. Nested snippets return to outer placeholders.');
      const next = JSON.stringify([options.overrides, options.custom]);
      if (!saving && (next !== signature || language() !== renderedLanguage)) {
        if (language() !== renderedLanguage) status.textContent = '';
        const ids = new Set(entries().map(item => item.id));
        drafts.forEach((_, id) => { if (!ids.has(id) && fresh?.id !== id) drafts.delete(id); });
        signature = next; renderedLanguage = language(); if (tab === 'snippets') renderList();
      }
    }
    refresh(); setTab('basic');
    return { panel, refresh,
      setActive(value) { if (!value) composing = false; },
      reveal(key) {
        if (key?.startsWith('option:')) { setTab('basic'); return controls.find(row => row.item.id === key.slice(7))?.label || tabButtons.get('basic'); }
        if (key?.startsWith('snippet:')) {
          const id = key.slice(8), known = entries().some(item => item.id === id);
          selected = known ? id : ''; group = 'all'; query = ''; search.value = ''; panel.dataset.snippetView = known ? 'editor' : 'list';
          clearMessage(); setTab('snippets'); return known ? fields.trigger.input : search;
        }
        if (key === 'snippets') { setTab('snippets'); return search; }
        if (key === 'guide') { setTab('guide'); return tabButtons.get('guide'); }
        setTab('basic'); return tabButtons.get('basic');
      },
      reset() { drafts.clear(); fresh = null; selected = ''; clearMessage(); signature = ''; refresh(); },
      close() { drafts.clear(); fresh = null; selected = ''; group = 'common'; query = ''; search.value = ''; composing = false; panel.dataset.snippetView = 'list'; clearMessage(); setTab('basic'); },
    };
  }
  window.RelatumNoteExtensionSettings = Object.freeze({ createPanel, createLatexPanel });
})();

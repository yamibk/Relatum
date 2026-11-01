(function () {
  'use strict';
  const $ = role => document.querySelector('[data-role="' + role + '"]');
  const text = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const api = () => window.pywebview?.api;
  const icons = {
    open: '<path d="M3 7V5h6l2 2h10v13H3zM3 10h18"/>',
    new: '<path d="M14 2H5v20h14V7zM14 2v5h5M8 13h8M12 9v8"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V3h15l3 3v13a2 2 0 0 1-2 2zM7 3v6h10V3M7 21v-8h10v8"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    source: '<g class="note-view-icon note-view-icon-source"><use href="#note-icon-code-xml"/></g><g class="note-view-icon note-view-icon-live"><use href="#note-icon-file-pen-line"/></g>',
    outline: '<path d="M8 5h14M8 12h14M8 19h14M2 5h1M2 12h1M2 19h1"/>',
    settings: '<path d="m10 2-.7 3-2 .9-2.8-.9-2 3.5 2.2 2.1v2.8L2.5 16l2 3.5 2.8-.9 2 .9.7 2.5h4l.7-2.5 2-.9 2.8.9 2-3.5-2.2-2.6v-2.8l2.2-2.1-2-3.5-2.8.9-2-.9L14 2z"/><circle cx="12" cy="12" r="3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  let editor, outline, current = null, generation = 0, savedGeneration = 0, saving = null, timer = 0, statsTimer = 0;
  let settings = { autoSave: true, outline: false }, outlineOpen = false, sourceMode = false, initialized = false, closing = false, hidden = false, failed = false, authorizedClose = false;
  let disposed = false, sourceIntent = false, sourceSequence = 0, outlineSequence = 0, outlineCloseTask = null;
  const outlinePane = document.querySelector('.markdown-outline');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  function icon(id, zh, en, parent, handler) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'markdown-icon'; button.dataset.action = id;
    button.title = button.ariaLabel = text(zh, en); button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[id] + '</svg>';
    button.addEventListener('click', () => Promise.resolve(handler()).catch(error => showError(error.message))); parent.append(button); return button;
  }
  function showError(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
  function check(result) { if (!result?.ok) { const error = new Error(result?.error || text('操作未完成。', 'Could not complete the action.')); error.code = result?.code; throw error; } return result; }
  const dirty = () => generation !== savedGeneration;
  function syncDocumentState() {
    const filename = $('filename'), name = current?.name || 'Untitled.md';
    if (filename.textContent !== name) filename.textContent = name;
    filename.title = current?.path || name;
    api()?.set_dirty?.(dirty())?.catch(() => {});
  }
  function updateStats() { clearTimeout(statsTimer); statsTimer = setTimeout(() => {
    statsTimer = 0; if (editor) $('count').textContent = editor.view.state.doc.length.toLocaleString() + text(' 字符', ' characters');
  }, 400); }
  function scheduleSave() {
    clearTimeout(timer); timer = 0;
    if (settings.autoSave && current?.path && dirty() && !failed) timer = setTimeout(() => { timer = 0; save().catch(error => showError(error.message)); }, 750);
  }
  async function save(as = false) {
    clearTimeout(timer); timer = 0;
    if (!editor) return false;
    await editor.whenInputSettled();
    if (saving) { await saving; return save(as); }
    if (!as && !dirty() && current?.path) return true;
    const at = generation, snapshot = editor.snapshot();
    const action = as || !current?.path ? 'save-as' : 'save';
    saving = (async () => {
      try {
        const result = check(await api().markdown_document(action, snapshot.value, current?.revision));
        if (result.cancelled) { syncDocumentState(); return false; }
        const previousPath = current?.path;
        current = result.document; savedGeneration = at; failed = false;
        if (previousPath !== current.path) editor.setNotePath(current.path);
        showError(''); syncDocumentState(); scheduleSave(); return true;
      } catch (error) { failed = true; syncDocumentState(); throw error; }
    })();
    try { return await saving; } finally { saving = null; }
  }
  async function choose(title, message, choices) {
    const dialog = document.createElement('dialog'); dialog.className = 'markdown-close-dialog';
    const heading = document.createElement('h2'); heading.textContent = title;
    const copy = document.createElement('p'); copy.textContent = message;
    const form = document.createElement('form'); form.method = 'dialog';
    choices.forEach(([value, name]) => { const button = document.createElement('button'); button.value = value; button.textContent = name; form.append(button); });
    dialog.append(heading, copy, form); document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => { dialog.addEventListener('close', () => { const value = dialog.returnValue; dialog.remove(); resolve(value); }, { once: true }); });
  }
  async function reload() {
    await editor.whenInputSettled();
    if (dirty() && await choose(text('重新载入文件？', 'Reload this file?'), text('窗口中的修改将被磁盘上的内容替换。可以先另存为保留修改。', 'Replace your changes with the file on disk. Save a copy first if you want to keep your changes.'), [['cancel', text('取消', 'Cancel')], ['reload', text('重新载入', 'Reload')]]) !== 'reload') return;
    const at = generation, result = check(await api().markdown_document('read'));
    if (at !== generation) return;
    current = result.document; failed = false; generation++; savedGeneration = generation;
    editor.setDocument({ value: current.content, notePath: current.path }); outline.documentChanged(); updateStats(); syncDocumentState(); showError('');
  }
  function cancelOutlineClose() {
    outlineSequence++;
    if (!outlineCloseTask) return;
    clearTimeout(outlineCloseTask.timer); outlinePane.removeEventListener('transitionend', outlineCloseTask.end); outlineCloseTask = null;
  }
  function settleOutline() {
    cancelOutlineClose(); outlinePane.classList.add('is-instant');
    const visible = outlineOpen && !hidden;
    outlinePane.hidden = !visible; outlinePane.classList.toggle('is-open', visible); outlinePane.inert = !visible;
    outlinePane.setAttribute('aria-hidden', String(!visible));
    outlinePane.getBoundingClientRect(); outlinePane.classList.remove('is-instant');
    if (visible) outline?.resume(); else outline?.suspend();
  }
  function setOutline(open, { instant = false } = {}) {
    const changed = outlineOpen !== !!open; outlineOpen = !!open;
    const button = document.querySelector('[data-action="outline"]');
    button.setAttribute('aria-pressed', String(outlineOpen)); button.setAttribute('aria-expanded', String(outlineOpen));
    button.title = button.ariaLabel = text(outlineOpen ? '收起大纲' : '显示大纲', outlineOpen ? 'Hide outline' : 'Show outline');
    if (!outlineOpen && outlinePane.contains(document.activeElement)) button.focus({ preventScroll: true });
    if (instant || hidden || motion.matches) { settleOutline(); return; }
    if (!changed) return;
    cancelOutlineClose();
    outlinePane.inert = !outlineOpen; outlinePane.setAttribute('aria-hidden', String(!outlineOpen));
    if (outlineOpen) {
      if (outlinePane.hidden) { outlinePane.hidden = false; outlinePane.getBoundingClientRect(); }
      outlinePane.classList.add('is-open'); outline?.resume();
    } else {
      outlinePane.classList.remove('is-open'); outline?.suspend();
      const sequence = outlineSequence;
      const finish = () => {
        if (outlineCloseTask !== task || sequence !== outlineSequence || outlineOpen) return;
        cancelOutlineClose(); outlinePane.hidden = true;
      };
      const task = outlineCloseTask = { timer: 0, end(event) { if (event.target === outlinePane && event.propertyName === 'transform' && getComputedStyle(outlinePane).visibility === 'hidden') finish(); } };
      outlinePane.addEventListener('transitionend', task.end); task.timer = setTimeout(finish, 270);
    }
  }
  function updateSourceButton() {
    const button = document.querySelector('[data-action="source"]');
    button.setAttribute('aria-pressed', String(sourceMode));
    button.title = button.ariaLabel = text(sourceMode ? '切换到实时预览' : '切换到源码模式', sourceMode ? 'Switch to live preview' : 'Switch to source mode');
  }
  async function toggleSource() {
    if (!editor || disposed) return;
    sourceIntent = !sourceIntent;
    const sequence = ++sourceSequence, instance = editor, path = current.path;
    await instance.whenInputSettled();
    if (disposed || instance !== editor || sequence !== sourceSequence || path !== current.path) return;
    const anchor = editor.captureViewport();
    editor.setSourceMode(sourceIntent);
    sourceMode = $('editor').classList.contains('is-source-mode'); updateSourceButton();
    if (anchor) editor.restoreViewport(anchor, { isCurrent: () => !disposed && sequence === sourceSequence });
  }
  const filesPanel = RelatumMarkdownFilesSettings.createPanel({ language: () => document.documentElement.lang,
    onChange(value) { settings = value; scheduleSave(); },
    confirmAction: async value => (await choose(value.title, value.message, [['cancel', text('取消', 'Cancel')], ['yes', value.confirmLabel]])) === 'yes' });
  const appearance = document.createElement('section'); appearance.className = 'markdown-appearance';
  const darkLabel = document.createElement('label'); darkLabel.textContent = text('深色外观', 'Dark appearance'); const dark = document.createElement('input'); dark.type = 'checkbox';
  dark.dataset.role = 'markdown-dark'; dark.checked = document.documentElement.dataset.markdownDark === '1';
  function syncNativeAppearance() { api()?.markdown_set_appearance?.(dark.checked)?.catch(() => {}); }
  function setDark() {
    document.documentElement.dataset.markdownDark = dark.checked ? '1' : '0';
    document.body.dataset.startTheme = dark.checked ? 'dark' : 'light'; syncNativeAppearance();
  }
  setDark(); dark.addEventListener('change', () => {
    try { localStorage.setItem('canvas:markdownDark:v1', dark.checked ? '1' : '0'); }
    catch (_) { dark.checked = document.documentElement.dataset.markdownDark === '1'; showError(text('外观保存失败，请重试。', 'Could not save appearance. Please retry.')); return; }
    setDark();
  }); darkLabel.append(dark); appearance.append(darkLabel);
  function resetAppearance() {
    localStorage.removeItem('canvas:markdownDark:v1'); dark.checked = false; setDark();
  }
  const settingsHost = document.createElement('div');
  const dialog = RelatumSettingsDialog.create({ content: settingsHost, language: () => document.documentElement.lang,
    labels: { 'reset-all': ['恢复简洁窗口设置', 'Reset simple editor settings'], confirmAll: ['恢复简洁窗口的设置？', 'Reset simple editor settings?'],
      confirmDescription: ['恢复自动保存、大纲默认值和此窗口外观。保留磁盘文件、最近列表和 Windows 文件关联。', 'Restore automatic saving, the outline default and this window’s appearance. Keep files, recent entries and Windows file associations.'] },
    categories: [{ id: 'markdown-files', label: ['Markdown 文件', 'Markdown files'], icon: 'note-icon-file-text', panel: filesPanel.panel, reset: () => filesPanel.reset() },
      { id: 'appearance', label: ['外观', 'Appearance'], icon: 'note-icon-laptop-minimal', panel: appearance, reset: resetAppearance }],
    async resetAll() { if (!await filesPanel.reset()) throw new Error('Could not save preferences'); resetAppearance(); },
    onCategoryChange(id) { filesPanel.setActive(id === 'markdown-files'); }, onOpen() { filesPanel.setActive(true); }, onClose() { filesPanel.setActive(false); } });
  icon('open', '打开文件 (Ctrl+O)', 'Open files (Ctrl+O)', $('file-tools'), () => api().markdown_files('open').then(check));
  icon('new', '新建文档 (Ctrl+N)', 'New document (Ctrl+N)', $('file-tools'), () => api().markdown_files('new').then(check));
  icon('save', '保存 (Ctrl+S)', 'Save (Ctrl+S)', $('file-tools'), () => save());
  const menu = $('more');
  const contextMenu = document.createElement('menu'); contextMenu.className = 'markdown-more'; contextMenu.hidden = true;
  document.querySelector('.markdown-root').append(contextMenu);
  function openContextMenu(request) {
    menu.hidden = true; contextMenu.replaceChildren();
    for (const [command, zh, en] of [['copy', '复制', 'Copy'], ['cut', '剪切', 'Cut'], ['paste', '粘贴', 'Paste'], ['select-all', '全选', 'Select all'],
      ['bold', '加粗', 'Bold'], ['italic', '斜体', 'Italic'], ['highlight', '高亮', 'Highlight'], ['insert:table', '插入表格', 'Insert table']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text(zh, en);
      button.disabled = !editor.queryCommand(command, request.context).enabled;
      button.addEventListener('click', async () => {
        contextMenu.hidden = true;
        try {
          if (!editor.queryCommand(command, request.context).enabled) return;
          if (command === 'copy' || command === 'cut') {
            const value = editor.view.state.selection.ranges.map(range => editor.view.state.sliceDoc(range.from, range.to)).join('\n');
            await navigator.clipboard.writeText(value);
            if (command === 'cut') editor.executeCommand(command, request.context, '');
          } else if (command === 'paste') {
            const value = await navigator.clipboard.readText();
            editor.executeCommand(command, request.context, value);
          } else editor.executeCommand(command, request.context);
          editor.focus();
        } catch (error) { showError(error.message); }
      });
      contextMenu.append(button);
    }
    contextMenu.hidden = false;
    contextMenu.style.left = Math.max(8, Math.min(request.x, innerWidth - contextMenu.offsetWidth - 8)) + 'px';
    contextMenu.style.top = Math.max(8, Math.min(request.y, innerHeight - contextMenu.offsetHeight - 8)) + 'px';
    if (request.keyboard) contextMenu.querySelector('button:not(:disabled)')?.focus();
  }
  icon('more', '更多操作', 'More actions', $('file-tools'), () => { menu.hidden = !menu.hidden; });
  for (const [label, action] of [[text('另存为…  Ctrl+Shift+S', 'Save as…  Ctrl+Shift+S'), () => save(true)], [text('重新载入磁盘文件', 'Reload from disk'), reload],
    [text('撤销  Ctrl+Z', 'Undo  Ctrl+Z'), () => { RelatumCodeMirror.undo(editor.view); editor.focus(); }], [text('重做  Ctrl+Y', 'Redo  Ctrl+Y'), () => { RelatumCodeMirror.redo(editor.view); editor.focus(); }]]) {
    const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => { menu.hidden = true; Promise.resolve(action()).catch(error => showError(error.message)); }); menu.append(button);
  }
  const sourceButton = icon('source', '切换到源码模式', 'Switch to source mode', $('view-tools'), toggleSource);
  sourceButton.classList.add('note-view-toggle'); updateSourceButton();
  const outlineButton = icon('outline', '显示大纲', 'Show outline', $('view-tools'), () => setOutline(!outlineOpen));
  outlineButton.setAttribute('aria-controls', outlinePane.id);
  icon('close', '收起大纲', 'Hide outline', document.querySelector('.markdown-outline-head'), () => setOutline(false));
  icon('settings', '笔记设置', 'Note settings', $('view-tools'), () => { menu.hidden = true; dialog.open(); });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && !event.target.closest('[data-action="more"]')) menu.hidden = true;
    if (!contextMenu.contains(event.target)) contextMenu.hidden = true;
  });
  window.addEventListener('blur', () => { menu.hidden = true; contextMenu.hidden = true; });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      const menuWasOpen = !menu.hidden || !contextMenu.hidden; menu.hidden = true; contextMenu.hidden = true;
      if (!menuWasOpen && !dialog.isOpen && outlineOpen && !editor?.inputPending) { event.preventDefault(); setOutline(false); }
    }
    if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || dialog.isOpen) return;
    const key = event.key.toLowerCase();
    const action = key === 's' ? () => save(event.shiftKey) : key === 'o' ? () => api().markdown_files('open').then(check) : key === 'n' ? () => api().markdown_files('new').then(check) : null;
    if (action) { event.preventDefault(); event.stopPropagation(); action().catch(error => showError(error.message)); }
  }, true);
  async function imageFiles(files) {
    if (!current?.path && !await save()) return;
    for (const file of files) {
      if (file.size > 40 * 1024 * 1024) { showError(text('图片超过 40 MiB。', 'The image exceeds 40 MiB.')); continue; }
      const insertion = editor.createImageInsertion();
      if (!insertion) return;
      try {
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        const response = check(await api().markdown_image(file.name, base64));
        insertion.insert('![](<'+ response.source + '>)');
      } catch (error) { showError(error.message); } finally { insertion.dispose(); }
    }
  }
  async function boot() {
    if (initialized || !api()?.markdown_document) return;
    initialized = true;
    try {
      const result = check(await api().markdown_document('read')); current = result.document; settings = result.settings;
      editor = RelatumNoteLiveEditor.create($('editor'), { value: current.content, notePath: current.path || 'Untitled.md',
        shortcutBindings: window.RelatumNoteShortcuts?.load(),
        imageUrl: (_path, source) => '/api/markdown-file-asset?token=' + encodeURIComponent(current.token) + '&src=' + encodeURIComponent(source),
        onDocChanged() { generation++; syncDocumentState(); updateStats(); outline?.documentChanged(); scheduleSave(); },
        onSaveRequest: () => save().catch(error => showError(error.message)),
        onOpenExternal: target => api().markdown_open_link(target).then(check).catch(error => showError(error.message)),
        onOpenLocalFile: target => api().markdown_open_link(target).then(check).catch(error => showError(error.message)),
        onOpenWiki: target => api().markdown_open_link(target.endsWith('.md') ? target : target + '.md').then(check).catch(error => showError(error.message)),
        onImageFiles: files => imageFiles(files).catch(error => showError(error.message)),
        onContextMenu: openContextMenu,
      });
      outline = RelatumNoteOutline.create($('outline'), { language: () => document.documentElement.lang,
        inputPending: () => editor.inputPending, whenInputSettled: () => editor.whenInputSettled(),
        getDocument: () => ({ path: current.path || 'Untitled.md', source: editor.snapshot().value, identity: editor.view.state.doc }),
        getSurface: () => ({ kind: 'live', scroller: editor.view.scrollDOM, view: editor.view }),
        navigate: heading => editor.revealPosition(heading.from, { align: 'start', unfold: true }) });
      $('outline-title').textContent = text('大纲', 'Outline'); setOutline(settings.outline, { instant: true }); updateStats(); syncDocumentState(); editor.focus(); syncNativeAppearance();
    } catch (error) { initialized = false; showError(error.message); }
  }
  async function checkExternal() {
    if (!editor || hidden || saving || editor.inputPending) return;
    try {
      const result = check(await api().markdown_document('changed', null, current.revision));
      if (result.settings) { settings = result.settings; scheduleSave(); }
      if (result.changed) {
        if (dirty()) { failed = true; clearTimeout(timer); showError(text('磁盘文件已变化。你的修改仍在窗口中，请另存为或重新载入。', 'The file changed on disk. Your changes are kept here; save as or reload.')); }
        else await reload();
      }
    } catch (error) { failed = true; showError(error.message); }
  }
  function visibility() {
    hidden = document.hidden || document.documentElement.dataset.desktopMinimized === '1';
    editor?.setExtensionsActive(!hidden);
    settleOutline();
    if (hidden) { sourceSequence++; sourceIntent = sourceMode; dialog.close({ instant: true, restoreFocus: false, reason: 'hidden' }); menu.hidden = true; contextMenu.hidden = true; }
    else checkExternal();
  }
  window.addEventListener('focus', checkExternal);
  document.addEventListener('visibilitychange', visibility); window.addEventListener('canvasdesktop:visibility', visibility);
  function motionChanged() { if (motion.matches) settleOutline(); }
  motion.addEventListener('change', motionChanged);
  window.addEventListener('pagehide', () => { disposed = true; sourceSequence++; cancelOutlineClose(); motion.removeEventListener('change', motionChanged); clearTimeout(timer); clearTimeout(statsTimer); outline?.suspend(); editor?.destroy(); });
  window.addEventListener('beforeunload', event => { if (dirty() && !authorizedClose) { event.preventDefault(); event.returnValue = ''; } });
  window.RelatumMarkdownWindow = { async close() {
    if (closing) return;
    closing = true; clearTimeout(timer); menu.hidden = true;
    try {
      await editor?.whenInputSettled(); if (saving) await saving.catch(() => {});
      if (dirty()) {
        const choice = await choose(text('保存修改后关闭？', 'Save changes before closing?'), current?.name || 'Untitled.md',
          [['cancel', text('取消', 'Cancel')], ['discard', text('不保存', 'Discard')], ['save', text('保存', 'Save')]]);
        if (choice !== 'discard' && (choice !== 'save' || !await save())) return;
      }
      if (window.RelatumDesktopPreferences && !await window.RelatumDesktopPreferences.flush()) {
        throw new Error(text('设置保存失败，请重试关闭。', 'Could not save settings. Please try closing again.'));
      }
      authorizedClose = true;
      await api().close_after_flush();
    } catch (error) { authorizedClose = false; showError(error.message); } finally { closing = false; }
  }, get editor() { return editor; } };
  window.addEventListener('pywebviewready', boot, { once: true }); boot();
})();

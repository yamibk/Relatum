// 起步页托管 Markdown 笔记库。文件树和编辑器保持直接、无感，首次进入时按需加载。
(function () {
  'use strict';
  const root = document.querySelector('[data-start-workspace-panel="notes"]');
  if (!root) return;
  const $ = (selector, scope) => (scope || root).querySelector(selector);
  const treeEl = $('[data-role="note-tree"]');
  const tabsEl = $('[data-role="note-tabs"]');
  const newTabButton = $('[data-note-action="new-tab"]');
  const closeAllTabsButton = $('[data-note-action="close-all-tabs"]');
  const editorHost = $('[data-role="note-editor"]');
  const fallbackEditor = $('[data-role="note-editor-fallback"]');
  const readingHost = $('[data-role="note-reading-view"]');
  const empty = $('[data-role="note-empty"]');
  const inlineTitleShell = $('[data-role="note-inline-title-shell"]');
  const inlineTitleEl = $('[data-role="note-inline-title"]');
  const focusToggle = $('[data-note-action="toggle-focus"]');
  const expandAllButton = $('[data-note-action="toggle-all-folders"]');
  const viewToggle = $('[data-role="note-view-toggle"]');
  const documentStatusEl = $('[data-role="note-document-status"]');
  const wordCountEl = $('[data-role="note-word-count"]');
  const characterCountEl = $('[data-role="note-character-count"]');
  const currentPathEl = $('[data-role="note-current-path"]');
  const outgoingEl = $('[data-role="note-outgoing"]');
  const backlinksEl = $('[data-role="note-backlinks"]');
  const outgoingCountEl = $('[data-role="note-outgoing-count"]');
  const backlinksCountEl = $('[data-role="note-backlink-count"]');
  const contextMenu = $('[data-role="note-context-menu"]', document);
  const toastEl = $('[data-role="note-toast"]', document);
  const modalHost = $('[data-role="note-modal-host"]', document);
  const errorBar = $('[data-role="note-error"]');
  const sideTitle = $('[data-role="note-side-title"]');
  const linksContent = $('[data-role="note-links-content"]');
  const historyContent = $('[data-role="note-history-content"]');
  const historyList = $('[data-role="note-history-list"]');
  const historyPreview = $('[data-role="note-history-preview"]');
  const historyRestore = $('[data-note-action="history-restore"]');
  const historyCopy = $('[data-note-action="history-copy"]');
  let liveEditor = null;

  const ACTIVE_PATH_KEY = 'canvas:noteActivePath:v1';
  const ACTIVE_TAB_KEY = 'canvas:noteActiveTab:v1';
  const OPEN_TABS_KEY = 'canvas:noteOpenTabs:v1';
  const EXPANDED_KEY = 'canvas:noteExpandedFolders:v1';
  const LINKS_OPEN_KEY = 'canvas:noteLinksOpen:v1';
  const NOTE_VIEW_KEY = 'canvas:noteView:v1';
  const SAVE_DELAY = 350;
  const RETRY_DELAY = 2200;
  const TREE_MOTION_MS = 220;
  const FOCUS_MOTION_MS = 320;
  const DOCUMENT_CACHE_LIMIT = 24;
  const BLANK_TAB_PREFIX = 'relatum:blank-tab:';
  const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const COPY = {
    'zh-CN': {
      loading: '正在读取笔记库…', emptyTree: '还没有笔记', select: '选择一篇笔记', readFailed: '读取笔记失败',
      saveFailed: '保存失败，请检查磁盘空间或目录权限', newNote: '新建笔记', newFolder: '新建文件夹', rename: '重命名',
      moveFailed: '移动失败', explorer: '在系统资源管理器中显示', openLibrary: '在资源管理器中打开笔记库',
      assets: '打开伴生素材目录', recycle: '移到系统回收站', recycled: '已移到系统回收站', refresh: '刷新',
      refreshed: '笔记库已刷新', copyPath: '复制库内路径', copied: '路径已复制', open: '打开', createHere: '在此新建笔记',
      createFolderHere: '新建子文件夹', history: '历史版本', noHistory: '还没有可恢复的历史版本', restore: '恢复此版本',
      copyContent: '复制内容', restored: '已恢复历史版本', noAssets: '当前笔记还没有伴生素材', revealFailed: '无法在资源管理器中显示',
      importFailed: '导入失败', imported: '已导入 {count} 篇笔记', unsupportedSkipped: '已跳过 {count} 个不支持的文件',
      uploadFailed: '图片保存失败', linkWarnings: '已移动；{count} 个歧义双链保持原样', ambiguous: '同名笔记不唯一',
      missing: '尚未创建', noOutgoing: '当前笔记没有出链', noBacklinks: '当前笔记没有反向链接',
      unresolvedTitle: '创建这篇笔记？', unresolvedCopy: '“[[{target}]]”尚不存在。', cancel: '取消', create: '创建',
      versionUnavailable: '历史版本无法读取', externalOpenFailed: '无法打开外部链接',
      expandFolder: '展开文件夹', collapseFolder: '收起文件夹', duplicateTitle: '已经存在一个同名文件',
      expandAll: '全部展开', collapseAll: '全部收起',
      titleRequired: '文件名不能为空', words: '{count} 个词', characters: '{count} 个字符', newTab: '新标签页', closeTab: '关闭标签页', closeAllTabs: '关闭所有笔记标签',
      enterFocus: '隐藏顶部栏', exitFocus: '显示顶部栏',
      livePreview: '实时预览', sourceMode: '源码模式', readingMode: '阅读模式',
      switchToSource: '切换到源码模式', switchToLive: '切换到实时预览',
    },
    en: {
      loading: 'Reading notes…', emptyTree: 'No notes yet', select: 'Select a note', readFailed: 'Could not read notes',
      saveFailed: 'Could not save. Check disk space and folder permissions.', newNote: 'New note', newFolder: 'New folder', rename: 'Rename',
      moveFailed: 'Move failed', explorer: 'Show in File Explorer', openLibrary: 'Open notes folder in File Explorer',
      assets: 'Open companion assets', recycle: 'Move to Recycle Bin', recycled: 'Moved to Recycle Bin', refresh: 'Refresh',
      refreshed: 'Notes refreshed', copyPath: 'Copy vault path', copied: 'Path copied', open: 'Open', createHere: 'New note here',
      createFolderHere: 'New subfolder', history: 'Version history', noHistory: 'No recoverable versions yet', restore: 'Restore version',
      copyContent: 'Copy content', restored: 'Version restored', noAssets: 'This note has no companion assets',
      revealFailed: 'Could not show this item in File Explorer', importFailed: 'Import failed', imported: 'Imported {count} notes',
      unsupportedSkipped: 'Skipped {count} unsupported files', uploadFailed: 'Could not save image',
      linkWarnings: 'Moved; {count} ambiguous links were unchanged', ambiguous: 'Duplicate note name', missing: 'Not created',
      noOutgoing: 'No outgoing links', noBacklinks: 'No backlinks', unresolvedTitle: 'Create this note?',
      unresolvedCopy: '“[[{target}]]” does not exist yet.', cancel: 'Cancel', create: 'Create', versionUnavailable: 'Could not read this version',
      externalOpenFailed: 'Could not open external link',
      expandFolder: 'Expand folder', collapseFolder: 'Collapse folder', duplicateTitle: 'A file with the same name already exists',
      expandAll: 'Expand all', collapseAll: 'Collapse all',
      titleRequired: 'A filename is required', words: '{count} words', characters: '{count} characters', newTab: 'New tab', closeTab: 'Close tab', closeAllTabs: 'Close all note tabs',
      enterFocus: 'Hide top bar', exitFocus: 'Show top bar',
      livePreview: 'Live Preview', sourceMode: 'Source mode', readingMode: 'Reading mode',
      switchToSource: 'Switch to source mode', switchToLive: 'Switch to Live Preview',
    },
  };
  const state = {
    active: false, initialized: false, entries: [], current: null, selectedFolder: '', selectedPath: '', expanded: new Set(), sideMode: 'links',
    editGeneration: 0, saveTimer: 0, retryTimer: 0, saveChain: Promise.resolve(true), saveRunning: false,
    openSeq: 0, refreshSeq: 0, externalSeq: 0, linksSeq: 0, draggedPath: '', renamePath: '', renameOriginal: '',
    historyPath: '', historyVersion: null, importRunning: false, renameError: '', renameDraft: null, renameCommitPromise: null, lastMoveError: '',
    openingPath: '', documentGeneration: 0, documentCache: new Map(), loadPromises: new Map(), entryIndex: new Map(), prefetchTimer: 0,
    initializePromise: null, tabs: [], activeTab: '', renderedActiveTab: '', draggedTabPath: '', titleRenamePromise: null, lastMoveCode: '',
    focusMode: false, focusMotionTimer: 0, titleScrollFrame: 0, titleResizeObserver: null,
    viewMode: 'live',
  };
  try { const stored = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); if (Array.isArray(stored)) state.expanded = new Set(stored); } catch (error) {}
  try { const stored = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '[]'); if (Array.isArray(stored)) state.tabs = stored.filter((path) => typeof path === 'string'); } catch (error) {}
  try { const stored = localStorage.getItem(ACTIVE_TAB_KEY) || ''; if (state.tabs.includes(stored)) state.activeTab = stored; } catch (error) {}
  try { if (localStorage.getItem(LINKS_OPEN_KEY) === '1') root.classList.add('links-overlay-open'); } catch (error) {}
  try { state.viewMode = normalizeViewMode(localStorage.getItem(NOTE_VIEW_KEY)); } catch (error) {}

  function editorSnapshot() {
    if (state.viewMode === 'reading' && state.current) {
      return {
        value: state.current.content || '',
        anchor: state.current.selectionStart || 0,
        head: state.current.selectionEnd || state.current.selectionStart || 0,
        scrollTop: readingHost && readingHost.scrollTop || 0,
      };
    }
    if (liveEditor) return liveEditor.snapshot();
    return {
      value: fallbackEditor.value,
      anchor: fallbackEditor.selectionStart || 0,
      head: fallbackEditor.selectionEnd || fallbackEditor.selectionStart || 0,
      scrollTop: fallbackEditor.scrollTop || 0,
    };
  }

  function editorScrollElement() {
    if (state.viewMode === 'reading' && readingHost) return readingHost;
    if (!liveEditor) return fallbackEditor;
    return liveEditor.view && liveEditor.view.scrollDOM || fallbackEditor;
  }

  function syncInlineTitleScroll(scrollTop) {
    const maximum = inlineTitleShell && !inlineTitleShell.hidden ? inlineTitleShell.offsetHeight : 0;
    const offset = Math.min(Math.max(0, Number(scrollTop) || 0), maximum);
    root.style.setProperty('--note-title-scroll-offset', offset + 'px');
  }

  function scheduleInlineTitleScroll() {
    if (state.titleScrollFrame) return;
    state.titleScrollFrame = requestAnimationFrame(() => {
      state.titleScrollFrame = 0;
      const scroller = editorScrollElement();
      syncInlineTitleScroll(scroller && scroller.scrollTop);
    });
  }

  function updateFocusToggle() {
    if (!focusToggle) return;
    const label = tr(state.focusMode ? 'exitFocus' : 'enterFocus');
    focusToggle.setAttribute('aria-pressed', state.focusMode ? 'true' : 'false');
    focusToggle.setAttribute('aria-label', label);
    focusToggle.title = label;
  }

  function requestEditorMeasure() {
    if (liveEditor && liveEditor.view) liveEditor.view.requestMeasure();
  }

  function setFocusMode(active) {
    state.focusMode = !!active;
    document.body.classList.add('note-focus-transitioning');
    document.body.classList.toggle('note-focus-mode', state.focusMode);
    updateFocusToggle();
    clearTimeout(state.focusMotionTimer);
    requestAnimationFrame(requestEditorMeasure);
    state.focusMotionTimer = setTimeout(() => {
      document.body.classList.remove('note-focus-transitioning');
      requestEditorMeasure();
    }, FOCUS_MOTION_MS + 40);
  }

  function setEditorDocument(documentState) {
    const payload = {
      value: documentState && documentState.content || '',
      notePath: documentState && documentState.path || '',
      anchor: documentState && documentState.selectionStart || 0,
      head: documentState && (documentState.selectionEnd || documentState.selectionStart) || 0,
      scrollTop: documentState && documentState.scrollTop || 0,
    };
    if (state.titleScrollFrame) {
      cancelAnimationFrame(state.titleScrollFrame);
      state.titleScrollFrame = 0;
    }
    syncInlineTitleScroll(payload.scrollTop);
    if (liveEditor) liveEditor.setDocument(payload);
    fallbackEditor.value = payload.value;
    fallbackEditor.scrollTop = payload.scrollTop;
    requestAnimationFrame(() => fallbackEditor.setSelectionRange(payload.anchor, payload.head));
    if (state.viewMode === 'reading') renderReadingDocument(payload);
    requestAnimationFrame(() => requestAnimationFrame(scheduleInlineTitleScroll));
  }

  function focusEditor() {
    if (state.viewMode === 'reading' && readingHost) readingHost.focus();
    else if (!liveEditor) fallbackEditor.focus();
    else liveEditor.focus();
  }
  function focusInlineTitle() {
    if (!inlineTitleEl || !state.current) { focusEditor(); return; }
    inlineTitleEl.focus();
    inlineTitleEl.select();
  }
  function replaceEditorSelection(text) {
    if (liveEditor) { liveEditor.replaceSelection(text); return; }
    fallbackEditor.setRangeText(text, fallbackEditor.selectionStart, fallbackEditor.selectionEnd, 'end');
    markChanged(editorSnapshot());
  }

  async function openWikiFromEditor(rawTarget) {
    await ensureLinks();
    const outgoing = outgoingForWiki(rawTarget);
    if (outgoing && outgoing.path) { openNote(outgoing.path); return; }
    if (outgoing && outgoing.state === 'ambiguous') { showToast(tr('ambiguous'), 'warning'); return; }
    confirmCreateWiki(rawTarget);
  }

  function normalizeViewMode(mode) {
    return mode === 'source' || mode === 'reading' ? mode : 'live';
  }

  function updateViewToggle() {
    if (!viewToggle) return;
    const sourceMode = state.viewMode === 'source';
    const label = tr(sourceMode ? 'switchToLive' : 'switchToSource');
    viewToggle.disabled = !state.current;
    viewToggle.setAttribute('aria-pressed', sourceMode ? 'true' : 'false');
    viewToggle.setAttribute('aria-label', label);
    viewToggle.setAttribute('data-ui-tooltip', label);
  }

  function readingPayload(documentState) {
    const target = documentState || state.current;
    return {
      value: target && target.content || '',
      notePath: target && target.path || '',
      anchor: target && target.selectionStart || 0,
      head: target && (target.selectionEnd || target.selectionStart) || 0,
      scrollTop: target && target.scrollTop || 0,
    };
  }

  function renderReadingDocument(payload) {
    if (!readingHost) return;
    const documentState = payload || readingPayload();
    if (window.RelatumNoteLiveEditor && typeof window.RelatumNoteLiveEditor.renderMarkdown === 'function') {
      window.RelatumNoteLiveEditor.renderMarkdown(readingHost, documentState.value || '', documentState.notePath || '');
    } else {
      const result = window.MarkdownMini && window.MarkdownMini.renderResult
        ? window.MarkdownMini.renderResult(documentState.value || '', { localImages: true })
        : { html: '' };
      readingHost.innerHTML = '<article class="note-reading-content node-text">' + (result.html || '') + '</article>';
    }
    requestAnimationFrame(() => { readingHost.scrollTop = Math.max(0, Number(documentState.scrollTop) || 0); });
  }

  function setViewMode(mode) {
    const next = normalizeViewMode(mode);
    if (next === state.viewMode) return;
    if (state.current) rememberEditorState(state.current);
    if (next === 'reading' && state.current) flushSave(state.current);
    state.viewMode = next;
    try { localStorage.setItem(NOTE_VIEW_KEY, next); } catch (error) {}
    if (liveEditor) liveEditor.setSourceMode(next === 'source');
    if (state.current) {
      const payload = readingPayload(state.current);
      if (next === 'source' && !liveEditor) {
        fallbackEditor.value = payload.value;
        fallbackEditor.scrollTop = payload.scrollTop;
        requestAnimationFrame(() => fallbackEditor.setSelectionRange(payload.anchor, payload.head));
      } else if (next === 'reading') {
        renderReadingDocument(payload);
      } else if (liveEditor) {
        requestAnimationFrame(() => {
          liveEditor.view.scrollDOM.scrollTop = payload.scrollTop;
          liveEditor.view.requestMeasure();
        });
      }
    }
    updateEditorVisibility();
    updateViewToggle();
    scheduleInlineTitleScroll();
  }

  function initializeEditor() {
    if (window.RelatumNoteLiveEditor && typeof window.RelatumNoteLiveEditor.create === 'function') {
      try {
        liveEditor = window.RelatumNoteLiveEditor.create(editorHost, {
          value: '', notePath: '', sourceMode: state.viewMode === 'source',
          onDocChanged: (meta) => markChanged(meta),
          onSaveRequest: () => flushSave(),
          onOpenWiki: (target) => openWikiFromEditor(target),
          onOpenExternal: (target) => post('/api/open-external', { kind: 'url', target }).catch(() => showToast(tr('externalOpenFailed'), 'error')),
          onImageFiles: (files) => uploadImages(files),
        });
        liveEditor.view.scrollDOM.addEventListener('scroll', scheduleInlineTitleScroll, { passive: true });
      } catch (error) {
        liveEditor = null;
        showSaveError(language() === 'en' ? 'Live Preview failed to start; source editor is active.' : '实时预览启动失败，已启用源码编辑器。');
      }
    }
    fallbackEditor.addEventListener('scroll', scheduleInlineTitleScroll, { passive: true });
    if (readingHost) {
      readingHost.addEventListener('scroll', scheduleInlineTitleScroll, { passive: true });
      readingHost.addEventListener('click', (event) => {
        const wiki = event.target.closest('[data-wikilink]');
        if (wiki) { event.preventDefault(); openWikiFromEditor(wiki.dataset.wikilink || ''); return; }
        const link = event.target.closest('[data-href]');
        if (link) {
          event.preventDefault();
          post('/api/open-external', { kind: 'url', target: link.dataset.href || '' }).catch(() => showToast(tr('externalOpenFailed'), 'error'));
        }
      });
    }
    if (inlineTitleShell && window.ResizeObserver) {
      state.titleResizeObserver = new ResizeObserver(scheduleInlineTitleScroll);
      state.titleResizeObserver.observe(inlineTitleShell);
    }
    fallbackEditor.addEventListener('input', () => markChanged(editorSnapshot()));
    fallbackEditor.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); flushSave(); } });
    fallbackEditor.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData && event.clipboardData.items || []).filter((item) => item.kind === 'file' && /^image\//i.test(item.type || '')).map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); uploadImages(files); }
    });
    fallbackEditor.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer && event.dataTransfer.files || []).some((file) => /^image\//i.test(file.type || '') || IMAGE_RE.test(file.name || ''))) event.preventDefault(); });
    fallbackEditor.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer && event.dataTransfer.files || []).filter((file) => /^image\//i.test(file.type || '') || IMAGE_RE.test(file.name || ''));
      if (files.length) { event.preventDefault(); uploadImages(files); }
    });
  }

  function language() { return window.RelatumI18n && window.RelatumI18n.language === 'en' ? 'en' : 'zh-CN'; }
  function tr(key, values) { let text = COPY[language()][key] || COPY['zh-CN'][key] || key; Object.keys(values || {}).forEach((name) => { text = text.replaceAll('{' + name + '}', String(values[name])); }); return text; }
  function parentPath(path) { const parts = String(path || '').split('/'); parts.pop(); return parts.join('/'); }
  function baseName(path) { return String(path || '').split('/').pop() || ''; }
  function noteTitle(path) { return baseName(path).replace(/\.md$/i, ''); }
  function joinPath(parent, name) { return parent ? parent.replace(/\/$/, '') + '/' + name : name; }
  function mapPath(path, source, destination) {
    if (path === source) return destination;
    return String(path || '').startsWith(source + '/') ? destination + String(path).slice(source.length) : path;
  }
  function isCjkCodePoint(codePoint) {
    return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
      || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
      || (codePoint >= 0x3040 && codePoint <= 0x30ff)
      || (codePoint >= 0x31f0 && codePoint <= 0x31ff)
      || (codePoint >= 0xff66 && codePoint <= 0xff9d)
      || (codePoint >= 0x1100 && codePoint <= 0x11ff)
      || (codePoint >= 0x3130 && codePoint <= 0x318f)
      || (codePoint >= 0xa960 && codePoint <= 0xa97f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7ff);
  }
  function wordCount(value) {
    const text = String(value || '');
    const unicodeWord = /[\p{L}\p{N}]/u;
    let count = 0;
    let inWord = false;
    let pendingJoiner = false;
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      const size = codePoint > 0xffff ? 2 : 1;
      if (isCjkCodePoint(codePoint)) {
        if (inWord) count += 1;
        count += 1;
        inWord = false;
        pendingJoiner = false;
      } else {
        const asciiWord = (codePoint >= 48 && codePoint <= 57)
          || (codePoint >= 65 && codePoint <= 90)
          || (codePoint >= 97 && codePoint <= 122);
        const isWord = asciiWord || (codePoint > 127 && unicodeWord.test(String.fromCodePoint(codePoint)));
        const isJoiner = codePoint === 39 || codePoint === 0x2019 || codePoint === 45 || codePoint === 95;
        if (isWord) {
          inWord = true;
          pendingJoiner = false;
        } else if (isJoiner && inWord && !pendingJoiner) {
          pendingJoiner = true;
        } else {
          if (inWord) count += 1;
          inWord = false;
          pendingJoiner = false;
        }
      }
      index += size;
    }
    return count + (inWord ? 1 : 0);
  }
  function updateDocumentStats(value, knownLength, knownWords) {
    const text = typeof value === 'string' ? value : '';
    const characters = Number.isFinite(knownLength) ? knownLength : text.length;
    const words = Number.isFinite(knownWords) ? knownWords : typeof value === 'string' ? wordCount(text) : null;
    if (wordCountEl && Number.isFinite(words)) wordCountEl.textContent = tr('words', { count: words.toLocaleString() });
    if (characterCountEl) characterCountEl.textContent = tr('characters', { count: Math.max(0, characters).toLocaleString() });
  }
  function desktopDirty(value) { if (window.CanvasDesktop && typeof window.CanvasDesktop.setDirty === 'function') window.CanvasDesktop.setDirty(!!value); }
  async function request(url, options) {
    let response;
    try { response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {})); }
    catch (cause) { const error = new Error(language() === 'en' ? 'Local service is unavailable' : '无法连接本地服务'); error.cause = cause; error.code = cause && cause.name === 'AbortError' ? 'aborted' : 'network_error'; throw error; }
    let data = null; try { data = await response.json(); } catch (error) {}
    if (!response.ok) { const error = new Error((data && data.error) || (language() === 'en' ? 'Request failed' : '请求失败')); error.status = response.status; error.code = data && data.code; throw error; }
    return data || {};
  }
  function post(url, payload) { return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }); }
  function showToast(message, tone) { if (!toastEl || !message) return; toastEl.textContent = message; toastEl.dataset.tone = tone || ''; toastEl.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2600); }
  function showSaveError(message) { if (errorBar) { errorBar.textContent = message || tr('saveFailed'); errorBar.hidden = false; } }
  function clearSaveError() { if (errorBar) { errorBar.textContent = ''; errorBar.hidden = true; } }
  function revealColdBoot() {
    if (window.RelatumBoot && window.RelatumBoot.noteRevealTimer) {
      clearTimeout(window.RelatumBoot.noteRevealTimer);
      window.RelatumBoot.noteRevealTimer = 0;
    }
    document.documentElement.classList.remove('note-boot-pending');
  }
  function closeContextMenu() { if (contextMenu) { contextMenu.hidden = true; contextMenu.replaceChildren(); } }
  function persistExpanded() { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(state.expanded))); } catch (error) {} }
  function expandTreePath(path, includeSelf) {
    const parts = String(path || '').split('/').filter(Boolean);
    const folderCount = includeSelf ? parts.length : Math.max(0, parts.length - 1);
    let current = ''; let changed = false;
    for (let index = 0; index < folderCount; index += 1) {
      current = joinPath(current, parts[index]);
      if (!state.expanded.has(current)) { state.expanded.add(current); changed = true; }
    }
    if (changed) persistExpanded();
    return changed;
  }
  function flattenEntries(entries, output) { (entries || []).forEach((entry) => { output.push(entry); if (entry.kind === 'folder') flattenEntries(entry.children, output); }); return output; }
  function folderPaths() { return flattenEntries(state.entries, []).filter((entry) => entry.kind === 'folder').map((entry) => entry.path); }
  function updateExpandAllButton() {
    if (!expandAllButton) return;
    const paths = folderPaths();
    const anyExpanded = paths.some((path) => state.expanded.has(path));
    const label = tr(anyExpanded ? 'collapseAll' : 'expandAll');
    expandAllButton.disabled = !paths.length;
    expandAllButton.dataset.allExpanded = anyExpanded ? 'true' : 'false';
    expandAllButton.dataset.uiTooltip = label;
    expandAllButton.setAttribute('aria-label', label);
    expandAllButton.setAttribute('aria-pressed', anyExpanded ? 'true' : 'false');
  }
  function toggleAllFolders() {
    const paths = folderPaths();
    if (!paths.length) return false;
    const collapse = paths.some((path) => state.expanded.has(path));
    if (collapse) state.expanded.clear();
    else paths.forEach((path) => state.expanded.add(path));
    persistExpanded(); renderTree();
    return true;
  }
  function rebuildEntryIndex() { state.entryIndex = new Map(flattenEntries(state.entries, []).map((entry) => [entry.path, entry])); }
  function findEntry(path) { return state.entryIndex.get(path) || null; }
  function folderTarget() { return state.selectedFolder && findEntry(state.selectedFolder) ? state.selectedFolder : state.current ? parentPath(state.current.path) : ''; }
  function treeIcon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('note-tree-icon', kind === 'folder' ? 'is-folder' : 'is-note');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'folder'
      ? 'M2.25 5.15V3.9c0-.75.6-1.35 1.35-1.35h2.55l1.55 1.6h4.7c.75 0 1.35.6 1.35 1.35v6.05c0 .75-.6 1.35-1.35 1.35H3.6c-.75 0-1.35-.6-1.35-1.35v-6.4Z'
      : 'M4 2.4h5.05l2.95 2.95v8.25H4V2.4Zm5 0v3h3');
    svg.appendChild(path);
    return svg;
  }
  function naturalSort(entries) { entries.sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, language(), { numeric: true, sensitivity: 'base' })); }
  function makeDocument(data) {
    const generation = ++state.documentGeneration;
    const entry = findEntry(data.path);
    const content = data.content || '';
    return {
      path: data.path, content, revision: data.revision || '', outgoing: [], backlinks: [],
      editGeneration: generation, persistedGeneration: generation, selectionStart: 0, selectionEnd: 0, scrollTop: 0,
      wordCount: wordCount(content), countedGeneration: generation,
      treeModifiedNs: entry && entry.modifiedNs || 0, treeSize: entry && entry.size || 0,
    };
  }
  function cacheDocument(documentState) {
    if (!documentState || !documentState.path) return;
    state.documentCache.delete(documentState.path);
    state.documentCache.set(documentState.path, documentState);
    if (state.documentCache.size <= DOCUMENT_CACHE_LIMIT) return;
    for (const [path, candidate] of state.documentCache) {
      if (state.documentCache.size <= DOCUMENT_CACHE_LIMIT) break;
      if (candidate === state.current || hasPendingEdits(candidate)) continue;
      state.documentCache.delete(path);
    }
  }
  function fetchDocument(path) {
    if (state.loadPromises.has(path)) return state.loadPromises.get(path);
    const promise = request('/api/note?path=' + encodeURIComponent(path)).finally(() => state.loadPromises.delete(path));
    state.loadPromises.set(path, promise);
    return promise;
  }
  function rememberEditorState(documentState) {
    if (!documentState || state.current !== documentState) return;
    const snapshot = editorSnapshot();
    documentState.content = snapshot.value;
    documentState.selectionStart = snapshot.anchor || 0;
    documentState.selectionEnd = snapshot.head || snapshot.anchor || 0;
    documentState.scrollTop = snapshot.scrollTop || 0;
    if (documentState.countedGeneration !== documentState.editGeneration) {
      documentState.wordCount = wordCount(snapshot.value);
      documentState.countedGeneration = documentState.editGeneration;
    }
    cacheDocument(documentState);
    updateDocumentStats(null, snapshot.value.length, documentState.wordCount);
  }
  function renderCurrentPath(path) {
    currentPathEl.replaceChildren();
    if (!path) { currentPathEl.textContent = tr('select'); currentPathEl.title = ''; return; }
    currentPathEl.title = path;
    const parts = String(path).split('/').filter(Boolean);
    const rootPart = document.createElement('span'); rootPart.className = 'note-path-crumb is-root'; rootPart.textContent = 'notes'; currentPathEl.appendChild(rootPart);
    parts.forEach((part, index) => {
      const separator = document.createElement('span'); separator.className = 'note-path-separator'; separator.textContent = '›';
      const crumb = document.createElement('span'); crumb.className = 'note-path-crumb' + (index === parts.length - 1 ? ' is-file' : ' is-folder'); crumb.textContent = part;
      currentPathEl.append(separator, crumb);
    });
  }
  function persistTabs() {
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(state.tabs));
      if (state.activeTab && state.tabs.includes(state.activeTab)) localStorage.setItem(ACTIVE_TAB_KEY, state.activeTab);
      else localStorage.removeItem(ACTIVE_TAB_KEY);
    } catch (error) {}
  }
  function isBlankTab(tab) { return String(tab || '').startsWith(BLANK_TAB_PREFIX); }
  function newBlankTabToken() { return BLANK_TAB_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function selectNoteTab(path, reuseActive) {
    if (!path) return false;
    const existing = state.tabs.indexOf(path);
    if (existing >= 0) {
      if (state.activeTab !== path) { state.activeTab = path; persistTabs(); }
      return false;
    }
    const activeIndex = state.tabs.indexOf(state.activeTab);
    if (reuseActive && activeIndex >= 0) state.tabs.splice(activeIndex, 1, path);
    else state.tabs.push(path);
    state.activeTab = path;
    persistTabs();
    return true;
  }
  function renderTabs() {
    if (!tabsEl) return;
    const activeTab = state.activeTab || state.openingPath || (state.current && state.current.path) || '';
    const existing = new Map(Array.from(tabsEl.children).map((tab) => [tab.dataset.noteTabPath || '', tab]));
    state.tabs.forEach((tabPath, index) => {
      const blank = isBlankTab(tabPath);
      let tab = existing.get(tabPath);
      if (!tab) {
        tab = document.createElement('div');
        const label = document.createElement('span');
        label.className = 'note-tab-label';
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'note-tab-close'; close.textContent = '×';
        tab.append(label, close);
      }
      existing.delete(tabPath);
      tab.className = 'note-tab' + (tabPath === activeTab ? ' active' : '') + (blank ? ' is-blank' : '');
      tab.dataset.noteTabPath = tabPath;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tabPath === activeTab ? 'true' : 'false');
      tab.tabIndex = tabPath === activeTab ? 0 : -1;
      tab.draggable = true;
      const label = tab.querySelector('.note-tab-label');
      label.textContent = blank ? tr('newTab') : noteTitle(tabPath);
      const close = tab.querySelector('.note-tab-close');
      close.dataset.noteTabClose = tabPath;
      close.setAttribute('aria-label', tr('closeTab') + ' · ' + (blank ? tr('newTab') : noteTitle(tabPath)));
      const current = tabsEl.children[index];
      if (current !== tab) tabsEl.insertBefore(tab, current || null);
    });
    existing.forEach((tab) => tab.remove());
    if (newTabButton) {
      const label = tr('newTab');
      newTabButton.dataset.uiTooltip = label;
      newTabButton.setAttribute('aria-label', label);
    }
    if (closeAllTabsButton) {
      const label = tr('closeAllTabs');
      closeAllTabsButton.disabled = !state.tabs.length;
      closeAllTabsButton.dataset.uiTooltip = label;
      closeAllTabsButton.setAttribute('aria-label', label);
    }
    const active = tabsEl.querySelector('.note-tab.active');
    if (active && state.renderedActiveTab !== activeTab) requestAnimationFrame(() => active.isConnected && active.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    state.renderedActiveTab = activeTab;
  }
  function remapTabs(source, destination) {
    state.tabs = Array.from(new Set(state.tabs.map((path) => isBlankTab(path) ? path : mapPath(path, source, destination))));
    state.activeTab = isBlankTab(state.activeTab) ? state.activeTab : mapPath(state.activeTab, source, destination);
    state.openingPath = mapPath(state.openingPath, source, destination);
    persistTabs();
    renderTabs();
  }
  function renderInlineTitle(path, force) {
    if (!inlineTitleEl || !inlineTitleShell) return;
    const titlePath = path || '';
    inlineTitleShell.hidden = !titlePath;
    inlineTitleEl.dataset.notePath = titlePath;
    if (!titlePath) {
      inlineTitleEl.value = '';
      inlineTitleEl.classList.remove('is-invalid');
      return;
    }
    if (force || document.activeElement !== inlineTitleEl) {
      inlineTitleEl.value = noteTitle(titlePath);
      inlineTitleEl.classList.remove('is-invalid');
    }
  }
  async function commitInlineTitle() {
    if (!inlineTitleEl || !state.current) return true;
    if (state.titleRenamePromise) return state.titleRenamePromise;
    const source = inlineTitleEl.dataset.notePath || state.current.path;
    if (!source) return true;
    const rawValue = inlineTitleEl.value.trim().replace(/\.md$/i, '').trim();
    if (!rawValue) {
      inlineTitleEl.classList.add('is-invalid');
      showToast(tr('titleRequired'), 'error');
      return false;
    }
    if (rawValue === noteTitle(source)) {
      renderInlineTitle(source, true);
      return true;
    }
    const destination = joinPath(parentPath(source), rawValue + '.md');
    inlineTitleEl.disabled = true;
    const operation = (async () => {
      const ok = await movePath(source, destination, true);
      if (ok) {
        renderInlineTitle(destination, true);
        return true;
      }
      if ((inlineTitleEl.dataset.notePath || '') === source) {
        inlineTitleEl.disabled = false;
        inlineTitleEl.classList.add('is-invalid');
        showToast(state.lastMoveCode === 'exists' ? tr('duplicateTitle') : state.lastMoveError || tr('moveFailed'), 'error');
      }
      return false;
    })();
    state.titleRenamePromise = operation.finally(() => {
      state.titleRenamePromise = null;
      inlineTitleEl.disabled = false;
    });
    return state.titleRenamePromise;
  }
  async function finishInlineTitle() {
    if (state.titleRenamePromise) return state.titleRenamePromise;
    if (inlineTitleEl && document.activeElement === inlineTitleEl) return commitInlineTitle();
    return true;
  }
  async function openBlankTab(options) {
    const previous = state.current;
    rememberEditorState(previous);
    if (previous && !(options && options.skipSave)) flushSave(previous);
    const tabPath = newBlankTabToken();
    state.tabs.push(tabPath);
    state.activeTab = tabPath;
    persistTabs();
    clearCurrent({ keepTabs: true, keepActiveTab: true, keepCache: true });
    if (!(options && options.noFocus)) requestAnimationFrame(() => tabsEl && tabsEl.querySelector('.note-tab.active')?.focus());
    return true;
  }
  async function activateTab(tabPath, options) {
    if (!tabPath || !state.tabs.includes(tabPath)) return false;
    if (isBlankTab(tabPath)) {
      const previous = state.current;
      rememberEditorState(previous);
      if (previous && !(options && options.skipSave)) flushSave(previous);
      state.activeTab = tabPath;
      persistTabs();
      clearCurrent({ keepTabs: true, keepActiveTab: true, keepCache: true });
      return true;
    }
    return openNote(tabPath, { reuseActiveTab: false, skipSave: !!(options && options.skipSave), noFocus: !!(options && options.noFocus) });
  }
  async function closeTab(tabPath, options) {
    const index = state.tabs.indexOf(tabPath);
    if (index < 0) return false;
    const active = state.activeTab === tabPath;
    const cached = isBlankTab(tabPath) ? null : state.documentCache.get(tabPath);
    if (!(options && options.skipSave) && cached) flushSave(cached);
    state.tabs.splice(index, 1);
    persistTabs();
    if (!active) { renderTabs(); return true; }
    const nextPath = state.tabs[Math.min(index, state.tabs.length - 1)] || state.tabs[index - 1] || '';
    if (nextPath) return activateTab(nextPath, { noFocus: !!(options && options.noFocus) });
    state.activeTab = '';
    clearCurrent({ keepTabs: true });
    return true;
  }
  async function closeAllTabs() {
    if (!state.tabs.length) return false;
    const current = state.current;
    if (current && !(await flushSave(current))) return false;
    for (const path of state.tabs) {
      if (isBlankTab(path)) continue;
      const cached = state.documentCache.get(path);
      if (cached && cached !== current && !(await flushSave(cached))) return false;
    }
    state.tabs = [];
    state.activeTab = '';
    persistTabs();
    clearCurrent({ keepTabs: true });
    return true;
  }
  function switchTab(offset) {
    if (!state.tabs.length) return;
    const index = Math.max(0, state.tabs.indexOf(state.activeTab));
    const next = state.tabs[(index + offset + state.tabs.length) % state.tabs.length];
    if (next) activateTab(next);
  }
  function updateTreeSelection() {
    const activePath = state.openingPath || (state.current && state.current.path) || '';
    treeEl.querySelectorAll('.note-tree-row').forEach((row) => {
      const path = row.dataset.notePath || '';
      const entry = findEntry(path);
      row.classList.toggle('active', !!activePath && path === activePath);
      if (activePath && path === activePath) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
      row.classList.toggle('opening', !!state.openingPath && path === state.openingPath);
      row.classList.toggle('selected-folder', !!entry && entry.kind === 'folder' && path === state.selectedFolder);
      row.classList.toggle('active-ancestor', !!entry && entry.kind === 'folder' && !!activePath && activePath.startsWith(path + '/'));
    });
  }
  function scheduleDocumentPrefetch() {
    clearTimeout(state.prefetchTimer);
    const candidates = flattenEntries(state.entries, []).filter((entry) => entry.kind === 'note' && Number(entry.size || 0) <= 512 * 1024 && !state.documentCache.has(entry.path)).slice(0, 12);
    if (!candidates.length) return;
    state.prefetchTimer = setTimeout(async () => {
      for (const entry of candidates) {
        if (!state.active || state.documentCache.has(entry.path)) continue;
        try { const data = await fetchDocument(entry.path); if (!state.documentCache.has(entry.path)) cacheDocument(makeDocument(data)); }
        catch (error) {}
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }, 40);
  }
  function rewriteEntryPaths(entry, source, destination) { if (entry.path === source) entry.path = destination; else if (entry.path.startsWith(source + '/')) entry.path = destination + entry.path.slice(source.length); if (entry.kind === 'folder') (entry.children || []).forEach((child) => rewriteEntryPaths(child, source, destination)); }
  function remapCachedPaths(source, destination) { const remapped = new Map(); state.documentCache.forEach((documentState, cachedPath) => { let nextPath = cachedPath; if (cachedPath === source) nextPath = destination; else if (cachedPath.startsWith(source + '/')) nextPath = destination + cachedPath.slice(source.length); documentState.path = nextPath; remapped.set(nextPath, documentState); }); state.documentCache = remapped; }
  function optimisticMove(source, destination) {
    const folderPath = parentPath(destination);
    if (folderPath === source || folderPath.startsWith(source + '/')) return false;
    if (folderPath && !findEntry(folderPath)) return false;
    let extracted = null;
    function remove(entries) { for (let index = 0; index < entries.length; index += 1) { if (entries[index].path === source) { extracted = entries.splice(index, 1)[0]; return true; } if (entries[index].kind === 'folder' && remove(entries[index].children || [])) return true; } return false; }
    if (!remove(state.entries) || !extracted) return false;
    let target = state.entries;
    if (folderPath) { const folder = findEntry(folderPath); target = folder.children || (folder.children = []); }
    rewriteEntryPaths(extracted, source, destination); target.push(extracted); naturalSort(target); return true;
  }

  function beginInlineRename(path) { const entry = findEntry(path); if (!entry) return; state.renamePath = path; state.renameOriginal = entry.kind === 'note' ? noteTitle(path) : entry.name; state.renameDraft = state.renameOriginal; state.renameError = ''; renderTree(); }
  function commitInlineRename(entry, input, cancel) {
    if (state.renameCommitPromise) return state.renameCommitPromise;
    if (!entry || state.renamePath !== entry.path) return Promise.resolve(!state.renamePath);
    input.dataset.committing = '1'; const originalPath = entry.path; const value = input.value.trim(); state.renameDraft = value;
    const operation = (async () => {
      if (cancel || value === state.renameOriginal) { state.renamePath = ''; state.renameDraft = null; state.renameError = ''; renderTree(); return true; }
      if (!value) { state.renameError = language() === 'en' ? 'A name is required' : '名称不能为空'; input.dataset.committing = ''; renderTree(); return false; }
      const name = entry.kind === 'note' && !/\.md$/i.test(value) ? value + '.md' : value;
      const ok = await movePath(originalPath, joinPath(parentPath(originalPath), name), true);
      if (ok) { state.renamePath = ''; state.renameDraft = null; state.renameError = ''; }
      else { state.renamePath = originalPath; state.renameError = state.lastMoveError || tr('moveFailed'); input.dataset.committing = ''; }
      renderTree();
      return ok;
    })();
    state.renameCommitPromise = operation.finally(() => { state.renameCommitPromise = null; });
    return state.renameCommitPromise;
  }
  async function finishInlineRename() {
    if (!state.renamePath) return true;
    if (state.renameCommitPromise) { await state.renameCommitPromise; return !state.renamePath; }
    const entry = findEntry(state.renamePath);
    const input = treeEl.querySelector('.note-tree-rename');
    if (!entry || !input) return false;
    await commitInlineRename(entry, input, false);
    return !state.renamePath;
  }
  function renderTree() {
    rebuildEntryIndex();
    const fragment = document.createDocumentFragment();
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const folderLabel = (entry, expanded) => entry.path + ' · ' + tr(expanded ? 'collapseFolder' : 'expandFolder');
    const directChild = (wrapper, className) => Array.from(wrapper.children).find((child) => child.classList && child.classList.contains(className)) || null;
    const liveWrapper = (path) => Array.from(treeEl.querySelectorAll('.note-tree-entry')).find((item) => item.dataset.path === path) || null;

    function createChildrenShell(entry, depth, wrapper, animate) {
      if (!entry.children || !entry.children.length) return null;
      const shell = document.createElement('div'); shell.className = 'note-tree-children-shell'; shell.setAttribute('aria-hidden', animate ? 'true' : 'false');
      const children = document.createElement('div'); children.className = 'note-tree-children';
      renderLevel(entry.children, depth + 1, children); shell.appendChild(children); wrapper.appendChild(shell);
      if (!animate) shell.classList.add('is-open');
      else {
        Array.from(children.children).forEach((child, index) => child.style.setProperty('--note-child-index', Math.min(index, 7)));
        void shell.offsetHeight;
        requestAnimationFrame(() => {
          if (!shell.isConnected || !state.expanded.has(entry.path)) return;
          shell.classList.add('is-open', 'is-expanding'); shell.setAttribute('aria-hidden', 'false');
          window.setTimeout(() => shell.classList.remove('is-expanding'), TREE_MOTION_MS + 80);
        });
      }
      return shell;
    }

    function setFolderExpanded(path, expanded) {
      const entry = findEntry(path); const wrapper = liveWrapper(path);
      if (!entry || entry.kind !== 'folder' || !wrapper) return;
      const row = directChild(wrapper, 'note-tree-row');
      if (!row) return;
      if (expanded) state.expanded.add(path); else state.expanded.delete(path);
      persistExpanded(); row.setAttribute('aria-expanded', expanded ? 'true' : 'false'); row.setAttribute('aria-label', folderLabel(entry, expanded));
      updateExpandAllButton();
      row.classList.toggle('is-expanding', expanded); window.setTimeout(() => row.classList.remove('is-expanding'), TREE_MOTION_MS + 40);
      let shell = directChild(wrapper, 'note-tree-children-shell');
      if (expanded) {
        if (!shell) shell = createChildrenShell(entry, Number(wrapper.style.getPropertyValue('--note-depth')) || 0, wrapper, !reducedMotion());
        if (shell && reducedMotion()) { shell.classList.add('is-open'); shell.setAttribute('aria-hidden', 'false'); }
        else if (shell) {
          shell.inert = false; shell.classList.remove('is-collapsing'); void shell.offsetHeight;
          requestAnimationFrame(() => {
            if (!state.expanded.has(path)) return;
            shell.classList.add('is-open', 'is-expanding'); shell.setAttribute('aria-hidden', 'false');
            window.setTimeout(() => shell.classList.remove('is-expanding'), TREE_MOTION_MS + 80);
          });
        }
      } else if (shell) {
        shell.classList.remove('is-open', 'is-expanding'); shell.classList.add('is-collapsing'); shell.setAttribute('aria-hidden', 'true'); shell.inert = true;
        if (reducedMotion()) shell.remove();
        else window.setTimeout(() => { if (shell.isConnected && !state.expanded.has(path)) shell.remove(); }, TREE_MOTION_MS + 40);
      }
      updateTreeSelection();
    }

    function renderLevel(entries, depth, host) { (entries || []).forEach((entry) => {
      const wrapper = document.createElement('div'); wrapper.className = 'note-tree-entry'; wrapper.dataset.path = entry.path; wrapper.style.setProperty('--note-depth', depth);
      const row = document.createElement('button'); row.type = 'button'; row.className = 'note-tree-row'; row.style.setProperty('--note-depth', depth); row.draggable = state.renamePath !== entry.path; row.dataset.notePath = entry.path;
      row.title = entry.path; row.setAttribute('aria-label', entry.path);
      const toggle = document.createElement('span'); toggle.className = 'note-tree-toggle'; toggle.setAttribute('aria-hidden', 'true');
      if (entry.kind === 'folder') { const expanded = state.expanded.has(entry.path); row.setAttribute('aria-expanded', expanded ? 'true' : 'false'); row.setAttribute('aria-label', folderLabel(entry, expanded)); }
      const label = document.createElement('span'); label.className = 'note-tree-label';
      if (state.renamePath === entry.path) {
        const input = document.createElement('input'); input.className = 'note-tree-rename'; input.value = state.renameDraft === null ? state.renameOriginal : state.renameDraft; input.setAttribute('aria-label', tr('rename')); label.appendChild(input);
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitInlineRename(entry, input, false); } else if (event.key === 'Escape') { event.preventDefault(); commitInlineRename(entry, input, true); } });
        input.addEventListener('blur', () => commitInlineRename(entry, input, false)); requestAnimationFrame(() => { input.focus(); input.select(); });
      } else label.textContent = entry.name;
      row.append(toggle, treeIcon(entry.kind), label);
      row.addEventListener('click', async () => { const clickedPath = entry.path; if (!(await finishInlineTitle())) return; if (state.renamePath && !(await finishInlineRename())) return; closeContextMenu(); const liveEntry = findEntry(clickedPath); if (!liveEntry) return; state.selectedPath = liveEntry.path; if (liveEntry.kind === 'folder') { state.selectedFolder = liveEntry.path; setFolderExpanded(liveEntry.path, !state.expanded.has(liveEntry.path)); } else { state.selectedFolder = parentPath(liveEntry.path); state.openingPath = liveEntry.path; renderCurrentPath(liveEntry.path); updateTreeSelection(); openNote(liveEntry.path, { selectionPrimed: true }); } });
      row.addEventListener('pointerenter', () => { if (entry.kind !== 'note' || state.documentCache.has(entry.path)) return; fetchDocument(entry.path).then((data) => { if (!state.documentCache.has(entry.path)) cacheDocument(makeDocument(data)); }).catch(() => {}); });
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); state.selectedPath = entry.path; state.selectedFolder = entry.kind === 'folder' ? entry.path : parentPath(entry.path); updateTreeSelection(); openContextMenu(entry, event.clientX, event.clientY); });
      row.addEventListener('dragstart', (event) => { state.draggedPath = entry.path; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-relatum-note-path', entry.path); });
      row.addEventListener('dragend', () => { state.draggedPath = ''; row.classList.remove('dragging'); root.querySelectorAll('.note-drop-target').forEach((item) => item.classList.remove('note-drop-target')); });
      row.addEventListener('dragover', (event) => { const external = !state.draggedPath && Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file'); if (!state.draggedPath && !external) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = external ? 'copy' : 'move'; row.classList.add('note-drop-target'); });
      row.addEventListener('dragleave', () => row.classList.remove('note-drop-target'));
      row.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); row.classList.remove('note-drop-target'); const destination = entry.kind === 'folder' ? entry.path : parentPath(entry.path); if (state.draggedPath) moveEntry(state.draggedPath, destination); else importDataTransfer(event.dataTransfer, destination); });
      wrapper.appendChild(row);
      if (state.renamePath === entry.path && state.renameError) { const error = document.createElement('small'); error.className = 'note-tree-inline-error'; error.textContent = state.renameError; wrapper.appendChild(error); }
      if (entry.kind === 'folder' && state.expanded.has(entry.path)) createChildrenShell(entry, depth, wrapper, false);
      host.appendChild(wrapper);
    }); }
    renderLevel(state.entries, 0, fragment);
    if (!fragment.childNodes.length) { const message = document.createElement('p'); message.className = 'note-tree-empty'; message.textContent = tr('emptyTree'); fragment.appendChild(message); }
    treeEl.replaceChildren(fragment); updateTreeSelection(); updateExpandAllButton();
  }
  async function refreshTree(announce) {
    const seq = ++state.refreshSeq; if (!state.initialized) treeEl.textContent = tr('loading');
    try {
      const result = await request('/api/notes-tree'); if (seq !== state.refreshSeq) return false;
      state.entries = Array.isArray(result.entries) ? result.entries : [];
      const flat = flattenEntries(state.entries, []); rebuildEntryIndex();
      state.documentCache.forEach((documentState, path) => { const entry = findEntry(path); if (!entry) { if (state.current !== documentState) state.documentCache.delete(path); return; } if (state.current !== documentState && documentState.treeModifiedNs && (documentState.treeModifiedNs !== entry.modifiedNs || documentState.treeSize !== entry.size)) state.documentCache.delete(path); });
      state.tabs = state.tabs.filter((path) => isBlankTab(path) || !!findEntry(path) || !!(state.current && state.current.path === path));
      if (!state.tabs.includes(state.activeTab)) state.activeTab = '';
      persistTabs(); renderTabs();
      const folders = new Set(flat.filter((entry) => entry.kind === 'folder').map((entry) => entry.path));
      state.expanded.forEach((path) => { if (!folders.has(path)) state.expanded.delete(path); });
      if (state.selectedFolder && !folders.has(state.selectedFolder)) state.selectedFolder = '';
      if (state.selectedPath && !flat.some((entry) => entry.path === state.selectedPath)) state.selectedPath = '';
      renderTree(); scheduleDocumentPrefetch(); if (announce) showToast(tr('refreshed')); return true;
    }
    catch (error) { if (seq === state.refreshSeq) treeEl.textContent = error.message || tr('readFailed'); showToast(error.message || tr('readFailed'), 'error'); return false; }
  }

  function renderLinks() {
    const outgoing = state.current && Array.isArray(state.current.outgoing) ? state.current.outgoing : [];
    const backlinks = state.current && Array.isArray(state.current.backlinks) ? state.current.backlinks : [];
    outgoingCountEl.textContent = String(outgoing.length); backlinksCountEl.textContent = String(backlinks.length);
    function list(target, items, kind) {
      const fragment = document.createDocumentFragment();
      items.forEach((item) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'note-link-card'; if (kind === 'outgoing') button.dataset.state = item.state || ''; const title = document.createElement('strong'); title.textContent = item.label || noteTitle(item.path || item.rawTarget); const meta = document.createElement('span'); meta.textContent = kind === 'backlink' ? item.path + (item.line ? ' · L' + item.line : '') : item.state === 'ambiguous' ? tr('ambiguous') : item.state !== 'resolved' ? tr('missing') : item.path; const excerpt = document.createElement('small'); excerpt.textContent = item.excerpt || ''; button.append(title, meta, excerpt); if (item.path) button.addEventListener('click', () => openNote(item.path)); else if (item.state === 'missing') button.addEventListener('click', () => confirmCreateWiki(item.rawTarget)); else button.disabled = true; fragment.appendChild(button); });
      if (!items.length) { const message = document.createElement('p'); message.className = 'note-link-empty'; message.textContent = kind === 'outgoing' ? tr('noOutgoing') : tr('noBacklinks'); fragment.appendChild(message); }
      target.replaceChildren(fragment);
    }
    list(outgoingEl, outgoing, 'outgoing'); list(backlinksEl, backlinks, 'backlink');
  }
  async function ensureLinks() { if (!state.current) return false; const path = state.current.path; const seq = ++state.linksSeq; try { const result = await request('/api/note-links?path=' + encodeURIComponent(path)); if (seq !== state.linksSeq || !state.current || state.current.path !== path) return false; state.current.outgoing = result.outgoing || []; state.current.backlinks = result.backlinks || []; renderLinks(); return true; } catch (error) { return false; } }
  function normalizedWikiTarget(value) { const target = String(value || '').split('|', 1)[0].trim(); const marks = [target.indexOf('#'), target.indexOf('^')].filter((index) => index >= 0); return (marks.length ? target.slice(0, Math.min.apply(Math, marks)) : target).replace(/\.md$/i, '').trim(); }
  function outgoingForWiki(value) { const wanted = normalizedWikiTarget(value).toLocaleLowerCase(); return (state.current && state.current.outgoing || []).find((item) => String(item.rawTarget || '').replace(/\.md$/i, '').toLocaleLowerCase() === wanted) || null; }
  function updateEditorVisibility() {
    const hasNote = !!state.current;
    empty.hidden = hasNote;
    if (inlineTitleShell) inlineTitleShell.hidden = !hasNote;
    if (documentStatusEl) documentStatusEl.hidden = !hasNote;
    editorHost.hidden = !hasNote || !liveEditor || state.viewMode === 'reading';
    fallbackEditor.hidden = !hasNote || state.viewMode === 'reading' || !!liveEditor;
    if (readingHost) readingHost.hidden = !hasNote || state.viewMode !== 'reading';
    updateViewToggle();
  }
  function setDocumentSwitchPending(active) {
    root.classList.toggle('note-document-switch-pending', !!active);
    if (editorHost) editorHost.toggleAttribute('inert', !!active);
    if (fallbackEditor) fallbackEditor.toggleAttribute('inert', !!active);
    if (readingHost) readingHost.toggleAttribute('inert', !!active);
  }

  function applyDocument(data) {
    clearTimeout(state.saveTimer); clearTimeout(state.retryTimer); state.editGeneration += 1;
    const documentState = typeof data.editGeneration === 'number' ? data : makeDocument(data);
    setDocumentSwitchPending(false);
    state.current = documentState; cacheDocument(documentState); state.openingPath = '';
    if (!state.tabs.includes(documentState.path)) selectNoteTab(documentState.path, true);
    else if (state.activeTab !== documentState.path) { state.activeTab = documentState.path; persistTabs(); }
    setEditorDocument(documentState);
    renderCurrentPath(documentState.path); state.selectedPath = documentState.path; state.selectedFolder = parentPath(documentState.path);
    renderInlineTitle(documentState.path, true); updateDocumentStats(null, documentState.content.length, documentState.wordCount); renderTabs();
    const treeExpanded = expandTreePath(documentState.path, false);
    clearSaveError(); desktopDirty(hasPendingEdits(documentState));
    try { localStorage.setItem(ACTIVE_PATH_KEY, documentState.path); } catch (error) {}
    if (treeExpanded) renderTree(); else updateTreeSelection(); renderLinks(); updateEditorVisibility();
    if (root.classList.contains('links-overlay-open')) ensureLinks();
  }
  function clearCurrent(options) { clearTimeout(state.saveTimer); const oldPath = state.current && state.current.path; state.openSeq += 1; state.editGeneration += 1; state.openingPath = ''; setDocumentSwitchPending(false); state.current = null; if (oldPath && !(options && options.keepCache)) state.documentCache.delete(oldPath); if (oldPath && !(options && options.keepTabs)) state.tabs = state.tabs.filter((path) => path !== oldPath); if (!(options && options.keepActiveTab)) state.activeTab = ''; persistTabs(); setEditorDocument(null); renderCurrentPath(''); renderInlineTitle('', true); clearSaveError(); desktopDirty(false); try { localStorage.removeItem(ACTIVE_PATH_KEY); } catch (error) {} updateTreeSelection(); renderTabs(); renderLinks(); updateEditorVisibility(); }
  function hasPendingEdits(documentState) { const target = documentState || state.current; return !!target && target.persistedGeneration < target.editGeneration; }
  function scheduleSave(delay) { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => flushSave(), typeof delay === 'number' ? delay : SAVE_DELAY); }
  function markChanged(meta) { if (!state.current) return; const changeMeta = meta || {}; state.editGeneration += 1; state.current.editGeneration = ++state.documentGeneration; if (typeof changeMeta.value === 'string') { state.current.content = changeMeta.value; state.current.wordCount = wordCount(changeMeta.value); state.current.countedGeneration = state.current.editGeneration; } if (Number.isFinite(changeMeta.anchor)) state.current.selectionStart = changeMeta.anchor; if (Number.isFinite(changeMeta.head)) state.current.selectionEnd = changeMeta.head; else if (Number.isFinite(changeMeta.anchor)) state.current.selectionEnd = changeMeta.anchor; if (Number.isFinite(changeMeta.scrollTop)) state.current.scrollTop = changeMeta.scrollTop; cacheDocument(state.current); if (typeof changeMeta.value === 'string') updateDocumentStats(null, changeMeta.value.length, state.current.wordCount); else if (Number.isFinite(changeMeta.length)) updateDocumentStats(null, changeMeta.length); desktopDirty(true); scheduleSave(); }
  async function flushSave(documentState) {
    const target = documentState || state.current;
    if (target === state.current) { clearTimeout(state.saveTimer); rememberEditorState(target); }
    if (!target || !hasPendingEdits(target)) return state.saveChain;
    const path = target.path; const generation = target.editGeneration; const content = target.content;
    state.saveChain = state.saveChain.catch(() => false).then(async () => {
      if (target.persistedGeneration >= generation) return true;
      state.saveRunning = true;
      try { const result = await post('/api/note-save', { path, content, revision: target.revision }); target.revision = result.revision || target.revision; target.persistedGeneration = Math.max(target.persistedGeneration, generation); if (target.editGeneration <= generation) target.content = content; cacheDocument(target); if (state.current === target) { clearSaveError(); if (!hasPendingEdits(target)) desktopDirty(false); else scheduleSave(0); if (root.classList.contains('links-overlay-open')) setTimeout(() => ensureLinks(), 500); } return true; }
      catch (error) { showSaveError(error.message || tr('saveFailed')); desktopDirty(true); clearTimeout(state.retryTimer); state.retryTimer = setTimeout(() => flushSave(), RETRY_DELAY); return false; }
      finally { state.saveRunning = false; }
    });
    const ok = await state.saveChain; if (ok && hasPendingEdits(target)) return flushSave(target); return ok;
  }
  async function openNote(path, options) {
    if (!path) return false;
    selectNoteTab(path, !(options && options.reuseActiveTab === false));
    if (state.current && state.current.path === path && !(options && options.force)) { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); renderTabs(); return true; }
    const previous = state.current; rememberEditorState(previous);
    const seq = ++state.openSeq; state.openingPath = path; state.selectedPath = path; state.selectedFolder = parentPath(path);
    renderTabs();
    const treeExpanded = expandTreePath(path, false);
    if (!(options && options.selectionPrimed)) { renderCurrentPath(path); if (treeExpanded) renderTree(); else updateTreeSelection(); }
    const cached = state.documentCache.get(path);
    if (cached && !(options && options.force)) {
      if (!(options && options.skipSave) && previous) flushSave(previous);
      applyDocument(cached);
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current === cached) focusEditor(); });
      return true;
    }
    setDocumentSwitchPending(true);
    const loadPromise = fetchDocument(path);
    if (!(options && options.skipSave) && previous) flushSave(previous);
    try {
      const data = await loadPromise; if (seq !== state.openSeq) return false;
      const shown = state.current && state.current.path === path ? state.current : null;
      if (!shown || (!hasPendingEdits(shown) && shown.revision !== data.revision)) applyDocument(data);
      else { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); }
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current && state.current.path === path) focusEditor(); });
      return true;
    } catch (error) {
      if (seq === state.openSeq) { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); renderTabs(); if (error.code !== 'aborted') showToast(error.message || tr('readFailed'), 'error'); }
      if (error.code !== 'aborted') await refreshTree(false); return false;
    }
  }
  async function createEntry(kind, options) {
    const parent = options && Object.prototype.hasOwnProperty.call(options, 'parent') ? options.parent : folderTarget();
    if (state.current) flushSave(state.current);
    try {
      const payload = { parent, kind, content: options && options.content || '' };
      const hasExplicitName = !!(options && options.name);
      if (hasExplicitName) {
        payload.name = options.name;
        payload.createParents = !!options.createParents;
      } else {
        payload.autoName = kind === 'folder' ? 'folder' : 'timestamp';
        payload.language = language();
      }
      const result = await post('/api/note-create', payload);
      state.entries = result.tree && result.tree.entries || state.entries;
      state.selectedPath = result.path;
      rebuildEntryIndex();
      if (kind === 'folder') {
        state.selectedFolder = result.path;
        expandTreePath(result.path, true);
        renderTree();
        beginInlineRename(result.path);
      } else {
        state.selectedFolder = parentPath(result.path);
        expandTreePath(result.path, false);
        renderTree();
        if (typeof result.content === 'string') applyDocument(result);
        else await openNote(result.path, { skipSave: true, force: true });
        if (!(options && options.noFocus)) requestAnimationFrame(() => hasExplicitName ? focusEditor() : focusInlineTitle());
      }
      scheduleDocumentPrefetch();
      return result;
    } catch (error) {
      showToast(error.message || tr('readFailed'), 'error');
      return null;
    }
  }
  async function movePath(source, destination, quiet) {
    if (!source || !destination || source === destination) return true;
    state.lastMoveError = ''; state.lastMoveCode = '';
    const entriesSnapshot = JSON.parse(JSON.stringify(state.entries)); const oldTabs = state.tabs.slice(); const oldActiveTab = state.activeTab; const oldSelectedPath = state.selectedPath; const oldSelectedFolder = state.selectedFolder; const flushPromise = flushSave();
    if (!optimisticMove(source, destination)) { state.lastMoveError = language() === 'en' ? 'A folder cannot be moved into itself' : '文件夹不能移入自己'; return false; }
    remapCachedPaths(source, destination);
    remapTabs(source, destination);
    if (liveEditor && typeof liveEditor.setNotePath === 'function' && state.current) liveEditor.setNotePath(state.current.path);
    state.selectedPath = mapPath(state.selectedPath, source, destination);
    state.selectedFolder = mapPath(state.selectedFolder, source, destination);
    state.expanded = new Set(Array.from(state.expanded).map((path) => mapPath(path, source, destination)));
    if (state.current) { renderCurrentPath(state.current.path); renderInlineTitle(state.current.path, true); }
    renderTree();
    const rollback = () => {
      state.entries = entriesSnapshot; state.tabs = oldTabs; state.activeTab = oldActiveTab; state.selectedPath = oldSelectedPath; state.selectedFolder = oldSelectedFolder;
      remapCachedPaths(destination, source); state.openingPath = mapPath(state.openingPath, destination, source);
      if (liveEditor && typeof liveEditor.setNotePath === 'function' && state.current) liveEditor.setNotePath(state.current.path);
      persistTabs(); if (state.current) { renderCurrentPath(state.current.path); renderInlineTitle(state.current.path, true); }
      renderTabs(); renderTree();
    };
    if (!(await flushPromise)) { rollback(); state.lastMoveError = tr('saveFailed'); state.lastMoveCode = 'save_failed'; return false; }
    try { const result = await post('/api/note-move', { path: source, destination }); if (state.current) try { localStorage.setItem(ACTIVE_PATH_KEY, state.current.path); } catch (error) {} if (result.warnings && result.warnings.length) showToast(tr('linkWarnings', { count: result.warnings.length }), 'warning'); refreshTree(false); return true; }
    catch (error) { state.lastMoveError = error.message || tr('moveFailed'); state.lastMoveCode = error.code || ''; rollback(); if (!quiet) showToast(state.lastMoveError, 'error'); return false; }
  }
  function moveEntry(source, folder) { const destination = joinPath(folder || '', baseName(source)); if (destination !== source) movePath(source, destination); }
  async function recycleEntry(entry) { const affects = state.current && (state.current.path === entry.path || state.current.path.startsWith(entry.path + '/')); if (affects && !(await flushSave())) return; try { const result = await post('/api/note-trash', { path: entry.path }); state.entries = result.tree && result.tree.entries || state.entries; const removed = (path) => !isBlankTab(path) && (path === entry.path || path.startsWith(entry.path + '/')); Array.from(state.documentCache.keys()).forEach((path) => { if (removed(path)) state.documentCache.delete(path); }); state.tabs = state.tabs.filter((path) => !removed(path)); if (!state.tabs.includes(state.activeTab)) state.activeTab = ''; persistTabs(); if (affects) { const next = state.tabs[0] || ''; if (next) await activateTab(next, { skipSave: true }); else clearCurrent({ keepTabs: true }); } else { renderTabs(); renderTree(); } showToast(tr('recycled')); } catch (error) { showToast(error.message || tr('recycle'), 'error'); } }
  async function reveal(path, assets) { try { await post(assets ? '/api/note-reveal-assets' : '/api/note-reveal', { path: path || '' }); } catch (error) { showToast(assets && error.status === 404 ? tr('noAssets') : error.message || tr('revealFailed'), 'error'); } }
  async function copyText(value) { try { await navigator.clipboard.writeText(value); } catch (error) { const area = document.createElement('textarea'); area.value = value; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } showToast(tr('copied')); }
  function contextButton(label, action, danger) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (danger) button.className = 'danger'; button.addEventListener('click', () => { closeContextMenu(); action(); }); return button; }
  function viewModeButton(mode, label) {
    const button = contextButton(label, () => setViewMode(mode));
    const active = state.viewMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', active ? 'true' : 'false');
    return button;
  }
  function separator() { const line = document.createElement('span'); line.className = 'note-context-separator'; return line; }
  function showContext(items, x, y) { contextMenu.replaceChildren(...items); contextMenu.hidden = false; contextMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - 250)) + 'px'; contextMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 8)) + 'px'; }
  function openContextMenu(entry, x, y, options) {
    if (!entry) { showContext([contextButton(tr('newNote'), () => createEntry('note', { parent: '' })), contextButton(tr('newFolder'), () => createEntry('folder', { parent: '' })), separator(), contextButton(tr('refresh'), () => checkExternalChanges(true)), contextButton(tr('openLibrary'), () => reveal('', false))], x, y); return; }
    state.selectedPath = entry.path;
    const items = [];
    if (entry.kind === 'note' && options && options.viewModes) {
      items.push(
        viewModeButton('live', tr('livePreview')),
        viewModeButton('source', tr('sourceMode')),
        viewModeButton('reading', tr('readingMode')),
        separator(),
      );
    }
    if (entry.kind === 'folder') items.push(contextButton(tr('createHere'), () => createEntry('note', { parent: entry.path })), contextButton(tr('createFolderHere'), () => createEntry('folder', { parent: entry.path })), separator()); else items.push(contextButton(tr('open'), () => openNote(entry.path)));
    items.push(contextButton(tr('rename'), () => beginInlineRename(entry.path))); if (entry.kind === 'note') items.push(contextButton(tr('copyPath'), () => copyText(entry.path))); items.push(contextButton(tr('explorer'), () => reveal(entry.path, false))); if (entry.kind === 'note') items.push(contextButton(tr('assets'), () => reveal(entry.path, true)), contextButton(tr('history'), () => openHistory(entry.path))); items.push(separator(), contextButton(tr('recycle'), () => recycleEntry(entry), true)); showContext(items, x, y);
  }

  function modalConfirm(title, copy) { if (!modalHost) return Promise.resolve(false); return new Promise((resolve) => { const overlay = document.createElement('div'); overlay.className = 'note-modal-overlay'; const dialog = document.createElement('section'); dialog.className = 'note-modal-card'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); const heading = document.createElement('h2'); heading.textContent = title; const paragraph = document.createElement('p'); paragraph.textContent = copy; const actions = document.createElement('footer'); actions.className = 'note-modal-actions'; const finish = (value) => { overlay.remove(); resolve(value); }; actions.append(contextButton(tr('cancel'), () => finish(false)), contextButton(tr('create'), () => finish(true))); dialog.append(heading, paragraph, actions); overlay.appendChild(dialog); modalHost.replaceChildren(overlay); requestAnimationFrame(() => overlay.classList.add('visible')); }); }
  async function confirmCreateWiki(rawTarget) { const target = normalizedWikiTarget(rawTarget); if (!target || !(await modalConfirm(tr('unresolvedTitle'), tr('unresolvedCopy', { target })))) return; const parts = target.replace(/\\/g, '/').split('/').filter(Boolean); const name = parts.pop(); const hasPath = parts.length > 0; await createEntry('note', { parent: hasPath ? parts.join('/') : state.current ? parentPath(state.current.path) : '', name, createParents: hasPath }); }

  function setSideMode(mode) { state.sideMode = mode === 'history' ? 'history' : 'links'; root.classList.add('links-overlay-open'); try { localStorage.setItem(LINKS_OPEN_KEY, '1'); } catch (error) {} if (sideTitle) sideTitle.textContent = state.sideMode === 'history' ? tr('history') : language() === 'en' ? 'Links' : '链接'; if (linksContent) linksContent.hidden = state.sideMode !== 'links'; if (historyContent) historyContent.hidden = state.sideMode !== 'history'; if (state.sideMode === 'links') ensureLinks(); }
  async function openHistory(path) { state.historyPath = path; state.historyVersion = null; setSideMode('history'); historyPreview.textContent = ''; historyRestore.disabled = true; historyCopy.disabled = true; try { const result = await request('/api/note-history?path=' + encodeURIComponent(path)); const fragment = document.createDocumentFragment(); (result.versions || []).forEach((version) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'note-history-item'; const date = new Date(version.createdAt); button.textContent = Number.isNaN(date.getTime()) ? version.createdAt : date.toLocaleString(); button.addEventListener('click', () => loadHistoryVersion(path, version.id, button)); fragment.appendChild(button); }); if (!fragment.childNodes.length) { const message = document.createElement('p'); message.className = 'note-link-empty'; message.textContent = tr('noHistory'); fragment.appendChild(message); } historyList.replaceChildren(fragment); } catch (error) { historyList.textContent = error.message || tr('versionUnavailable'); } }
  async function loadHistoryVersion(path, id, button) { try { const version = await request('/api/note-history?path=' + encodeURIComponent(path) + '&version=' + encodeURIComponent(id)); state.historyVersion = version; historyPreview.textContent = version.content || ''; historyList.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button)); historyRestore.disabled = false; historyCopy.disabled = false; } catch (error) { showToast(error.message || tr('versionUnavailable'), 'error'); } }
  async function restoreHistory() { if (!state.historyVersion) return; try { const result = await post('/api/note-history-restore', { path: state.historyPath, version: state.historyVersion.id }); if (state.current && state.current.path === result.path) applyDocument(result); showToast(tr('restored')); openHistory(result.path); } catch (error) { showToast(error.message || tr('versionUnavailable'), 'error'); } }

  function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || ''); reader.onerror = () => reject(reader.error || new Error('FileReader failed')); reader.readAsDataURL(file); }); }
  async function uploadImages(files) { if (!state.current || !files.length) return; for (const file of files) { try { const result = await post('/api/note-upload-image', { path: state.current.path, name: file.name || 'image.png', mediaType: file.type || '', data: await fileToBase64(file) }); const insertion = '![' + (result.name || file.name || 'image') + '](' + result.path + ')'; replaceEditorSelection(insertion); } catch (error) { showToast(error.message || tr('uploadFailed'), 'error'); } } }
  function entryFiles(entry, prefix) { return new Promise((resolve) => { if (entry.isFile) { entry.file((file) => resolve([{ path: prefix + file.name, file }]), () => resolve([])); return; } if (!entry.isDirectory) { resolve([]); return; } const reader = entry.createReader(); const children = []; const read = () => reader.readEntries(async (batch) => { if (!batch.length) { resolve((await Promise.all(children.map((child) => entryFiles(child, prefix + entry.name + '/')))).flat()); return; } children.push(...batch); read(); }, () => resolve([])); read(); }); }
  async function filesFromTransfer(transfer) { const items = Array.from(transfer && transfer.items || []); const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean); if (entries.length) return (await Promise.all(entries.map((entry) => entryFiles(entry, '')))).flat(); return Array.from(transfer && transfer.files || []).map((file) => ({ path: file.name, file })); }
  async function importDataTransfer(transfer, destination) { if (state.importRunning) return; state.importRunning = true; let token = ''; try { const all = await filesFromTransfer(transfer); const accepted = all.filter((item) => /\.md$/i.test(item.path) || IMAGE_RE.test(item.path)); const skipped = all.length - accepted.length; if (!accepted.length) return; token = (await post('/api/note-import-begin', { destination: destination || '' })).token; for (const item of accepted) await post('/api/note-import-upload', { token, path: item.path.replace(/\\/g, '/'), mediaType: item.file.type || '', data: await fileToBase64(item.file) }); const result = await post('/api/note-import-commit', { token }); token = ''; state.entries = result.tree && result.tree.entries || state.entries; renderTree(); if (result.notes && result.notes.length) { showToast(tr('imported', { count: result.notes.length })); await openNote(result.notes[0]); } if (skipped) setTimeout(() => showToast(tr('unsupportedSkipped', { count: skipped }), 'warning'), 350); } catch (error) { showToast(error.message || tr('importFailed'), 'error'); } finally { if (token) post('/api/note-import-abort', { token }).catch(() => {}); state.importRunning = false; } }

  async function checkExternalChanges(announce) { if (!state.active) return false; const seq = ++state.externalSeq; const path = state.current && state.current.path; const generation = state.editGeneration; const revision = state.current && state.current.revision; await refreshTree(announce); if (seq !== state.externalSeq || !path || !state.current || state.current.path !== path || state.editGeneration !== generation || state.saveRunning || hasPendingEdits()) return true; try { const disk = await request('/api/note?path=' + encodeURIComponent(path)); if (seq !== state.externalSeq || !state.current || state.current.path !== path || state.editGeneration !== generation || state.current.revision !== revision || hasPendingEdits()) return true; if (disk.revision !== revision) applyDocument(disk); return true; } catch (error) { if (seq === state.externalSeq && state.current && state.current.path === path && !hasPendingEdits() && (error.status === 404 || error.code === 'not_found')) await closeTab(path, { skipSave: true, noFocus: true }); return false; } }
  function initializeWorkspace() {
    if (state.initialized) return Promise.resolve(true);
    if (state.initializePromise) return state.initializePromise;
    const initialize = (async () => {
      if (!(await refreshTree(false))) return false;
      state.initialized = true;
      let path = ''; try { path = localStorage.getItem(ACTIVE_PATH_KEY) || ''; } catch (error) {}
      let activeTab = state.tabs.includes(state.activeTab) ? state.activeTab : '';
      if (!activeTab && path && findEntry(path) && state.tabs.includes(path)) activeTab = path;
      if (!activeTab) activeTab = state.tabs.find((tabPath) => isBlankTab(tabPath) || !!findEntry(tabPath)) || '';
      if (activeTab && isBlankTab(activeTab)) { state.activeTab = activeTab; persistTabs(); renderTabs(); updateEditorVisibility(); }
      else if (activeTab) await openNote(activeTab, { reuseActiveTab: false, skipSave: true, noFocus: true });
      else { renderTabs(); updateEditorVisibility(); }
      return true;
    })();
    state.initializePromise = initialize.finally(() => { state.initializePromise = null; });
    return state.initializePromise;
  }
  async function preload() { return initializeWorkspace(); }
  async function activate() { const wasInitialized = state.initialized; state.active = true; if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(true); root.classList.add('active'); const initialized = await initializeWorkspace(); revealColdBoot(); if (!initialized) return false; if (wasInitialized) await checkExternalChanges(false); return true; }
  async function deactivate() { if (!(await flushSave())) return false; state.active = false; if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(false); root.classList.remove('tree-overlay-open'); closeContextMenu(); desktopDirty(false); return true; }

  root.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-note-action]');
    if (!action) return;
    const name = action.dataset.noteAction;
    if (name === 'new-note') createEntry('note');
    else if (name === 'new-tab') openBlankTab();
    else if (name === 'close-all-tabs') { if (await finishInlineTitle()) await closeAllTabs(); }
    else if (name === 'new-folder') createEntry('folder');
    else if (name === 'refresh') checkExternalChanges(true);
    else if (name === 'toggle-all-folders') toggleAllFolders();
    else if (name === 'reveal-root') reveal('', false);
    else if (name === 'toggle-focus') setFocusMode(!state.focusMode);
    else if (name === 'toggle-source' && state.current) setViewMode(state.viewMode === 'source' ? 'live' : 'source');
    else if (name === 'current-menu' && state.current) {
      const entry = findEntry(state.current.path) || { kind: 'note', path: state.current.path, name: noteTitle(state.current.path) };
      const rect = action.getBoundingClientRect();
      openContextMenu(entry, rect.right - 220, rect.bottom + 6, { viewModes: true });
    } else if (name === 'toggle-tree') root.classList.toggle('tree-overlay-open');
    else if (name === 'toggle-links') {
      if (root.classList.contains('links-overlay-open') && state.sideMode === 'links') {
        root.classList.remove('links-overlay-open');
        try { localStorage.setItem(LINKS_OPEN_KEY, '0'); } catch (error) {}
      } else setSideMode('links');
    } else if (name === 'close-links') {
      root.classList.remove('links-overlay-open');
      try { localStorage.setItem(LINKS_OPEN_KEY, '0'); } catch (error) {}
    } else if (name === 'history-restore') restoreHistory();
    else if (name === 'history-copy' && state.historyVersion) copyText(state.historyVersion.content || '');
  });
  if (inlineTitleEl) {
    inlineTitleEl.addEventListener('input', () => inlineTitleEl.classList.remove('is-invalid'));
    inlineTitleEl.addEventListener('blur', () => commitInlineTitle());
    inlineTitleEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitInlineTitle().then((ok) => { if (ok) focusEditor(); }); }
      else if (event.key === 'Escape') { event.preventDefault(); renderInlineTitle(state.current && state.current.path || '', true); focusEditor(); }
    });
  }
  if (tabsEl) {
    tabsEl.addEventListener('click', async (event) => {
      const close = event.target.closest('[data-note-tab-close]');
      if (close) { event.preventDefault(); event.stopPropagation(); if (await finishInlineTitle()) closeTab(close.dataset.noteTabClose); return; }
      const tab = event.target.closest('[data-note-tab-path]');
      if (tab && await finishInlineTitle()) activateTab(tab.dataset.noteTabPath);
    });
    tabsEl.addEventListener('dragstart', (event) => {
      const tab = event.target.closest('[data-note-tab-path]'); if (!tab) return;
      state.draggedTabPath = tab.dataset.noteTabPath; event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-relatum-note-tab', state.draggedTabPath);
    });
    tabsEl.addEventListener('dragover', (event) => { if (state.draggedTabPath && event.target.closest('[data-note-tab-path]')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    tabsEl.addEventListener('drop', (event) => {
      const target = event.target.closest('[data-note-tab-path]'); const source = state.draggedTabPath;
      state.draggedTabPath = ''; if (!target || !source || target.dataset.noteTabPath === source) return;
      event.preventDefault(); const from = state.tabs.indexOf(source); const to = state.tabs.indexOf(target.dataset.noteTabPath);
      if (from < 0 || to < 0) return; state.tabs.splice(from, 1); state.tabs.splice(to, 0, source); persistTabs(); renderTabs();
    });
    tabsEl.addEventListener('dragend', () => { state.draggedTabPath = ''; });
  }
  treeEl.addEventListener('contextmenu', (event) => { if (event.target.closest('.note-tree-row')) return; event.preventDefault(); state.selectedPath = ''; openContextMenu(null, event.clientX, event.clientY); });
  treeEl.addEventListener('dragover', (event) => { if (event.target.closest('.note-tree-row')) return; const external = Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file'); if (!state.draggedPath && !external) return; event.preventDefault(); event.dataTransfer.dropEffect = state.draggedPath ? 'move' : 'copy'; treeEl.classList.add('note-drop-root'); });
  treeEl.addEventListener('dragleave', (event) => { if (!treeEl.contains(event.relatedTarget)) treeEl.classList.remove('note-drop-root'); });
  treeEl.addEventListener('drop', (event) => { if (event.target.closest('.note-tree-row')) return; event.preventDefault(); treeEl.classList.remove('note-drop-root'); if (state.draggedPath) moveEntry(state.draggedPath, ''); else importDataTransfer(event.dataTransfer, ''); });
  document.addEventListener('pointerdown', (event) => { if (contextMenu && !contextMenu.hidden && !contextMenu.contains(event.target) && !event.target.closest('[data-note-action="current-menu"]')) closeContextMenu(); });
  document.addEventListener('keydown', (event) => {
    if (!state.active) return;
    const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
    if (mod && key === 'n') { event.preventDefault(); createEntry('note'); }
    else if (mod && key === 't') { event.preventDefault(); openBlankTab(); }
    else if (mod && key === 'w' && state.activeTab) { event.preventDefault(); closeTab(state.activeTab); }
    else if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); switchTab(event.shiftKey ? -1 : 1); }
    else if (mod && /^[1-9]$/.test(event.key) && state.tabs.length) { event.preventDefault(); const index = event.key === '9' ? state.tabs.length - 1 : Math.min(Number(event.key) - 1, state.tabs.length - 1); activateTab(state.tabs[index]); }
    else if (event.key === 'F2' && (state.selectedPath || state.current)) { event.preventDefault(); beginInlineRename(state.selectedPath || state.current.path); }
    else if (event.key === 'Escape') { closeContextMenu(); root.classList.remove('tree-overlay-open'); }
  });
  window.addEventListener('blur', () => { if (state.active) flushSave(); });
  window.addEventListener('focus', () => { if (state.active) checkExternalChanges(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.active) flushSave(); });
  document.addEventListener('relatum:languagechange', () => { renderTree(); renderTabs(); renderLinks(); renderCurrentPath(state.openingPath || (state.current && state.current.path) || ''); updateFocusToggle(); updateViewToggle(); if (state.current) { rememberEditorState(state.current); updateDocumentStats(null, state.current.content.length, state.current.wordCount); } });
  if (window.CanvasDesktop && typeof window.CanvasDesktop.setBeforeCloseHandler === 'function') window.CanvasDesktop.setBeforeCloseHandler(() => state.active ? flushSave() : true);
  initializeEditor(); renderTabs(); updateEditorVisibility(); renderLinks(); updateFocusToggle();
  window.CanvasNoteWorkspace = { activate, deactivate, preload, flushSave, refresh: checkExternalChanges, get dirty() { return hasPendingEdits(); }, get currentPath() { return state.current ? state.current.path : ''; } };
})();

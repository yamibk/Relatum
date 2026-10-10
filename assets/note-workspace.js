// 起步页托管 Markdown 笔记库。文件树和编辑器保持直接、无感，首次进入时按需加载。
(function () {
  'use strict';
  const root = document.querySelector('[data-start-workspace-panel="notes"]');
  if (!root) return;
  const $ = (selector, scope) => (scope || root).querySelector(selector);
  const treeEl = $('[data-role="note-tree"]');
  const notebookTreeEl = $('[data-role="note-notebook-tree"]');
  const treeRowIndexes = new Map([treeEl, notebookTreeEl].filter(Boolean).map((host) =>
    [host, { rows: new Map(), selectionPaths: new Set(), selectionKey: null }]));
  const notebooksContent = $('[data-role="note-notebooks-content"]');
  const sidePane = $('.note-links-pane');
  const NOTEBOOK_CONTAINER = 'CustomNotebook';
  const NOTEBOOK_COLORS = ['gray', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'purple'];
  let notebookSettingsTimer = 0, notebookSettingsChain = Promise.resolve(true), notebookSettingsPending = {};
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
  const currentMenuButton = $('[data-note-action="current-menu"]');
  const imageTextToggle = $('[data-role="note-image-text-toggle"]');
  const imageTextTools = $('[data-role="note-image-text-tools"]');
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
  const canvasSettingsContent = $('[data-role="note-canvas-settings"]');
  const guideContent = $('[data-role="note-guide"]');
  const settingsTrigger = $('[data-note-action="toggle-settings"]');
  const settingsPop = $('[data-role="note-settings-pop"]');
  const settingsShortcutList = $('[data-role="note-shortcut-list"]');
  const settingsShortcutStatus = $('[data-role="note-shortcut-status"]');
  const settingsResetArea = $('[data-role="note-settings-reset-area"]');
  const settingsResetButton = $('[data-note-settings-action="reset-open"]');
  const settingsResetConfirm = $('[data-role="note-settings-reset-confirm"]');
  const settingsResetStatus = $('[data-role="note-settings-reset-status"]');
  const sortTrigger = $('[data-note-action="toggle-sort"]');
  const sortMenu = $('[data-role="note-sort-menu"]');
  const libraryTrigger = $('[data-note-action="toggle-library-settings"]');
  const librarySettings = $('[data-role="note-library-settings"]');
  const librarySortOptions = $('[data-role="note-library-sort-options"]');
  const libraryNameOptions = $('[data-role="note-library-name-options"]');
  const libraryNameField = $('[data-role="note-library-name-field"]');
  const libraryNameInput = $('[data-role="note-library-name-input"]');
  const libraryNamePreview = $('[data-role="note-library-name-preview"]');
  const libraryNameError = $('[data-role="note-library-name-error"]');
  const libraryResetButton = $('[data-note-library-action="reset-open"]');
  const libraryResetConfirm = $('[data-role="note-library-reset-confirm"]');
  let liveEditor = null;
  let noteBrowser = null, browserLoader = null, browserSequence = 0, browserIntent = false;
  let noteMovePromise = null, noteMovePaths = null;
  const canvasEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.canvas');
  if (canvasEnabled()) window.RelatumNoteCanvasStyle?.initPanel(canvasSettingsContent, () => window.RelatumNotePreferences?.resetCanvasNodeScale?.());
  async function flushCanvases(background) {
    if (!window.RelatumNoteCanvas) return true;
    const ok = await window.RelatumNoteCanvas.flushAll({ settle: !background });
    if (!ok) showSaveError(language() === 'en' ? 'Canvas changes could not be saved.' : '画布保存失败，草稿已保留。');
    return ok;
  }
  async function waitForNoteMove(path) {
    while (noteMovePromise) {
      const operation = noteMovePromise, paths = noteMovePaths;
      if (await operation && paths && typeof path === 'string') path = mapPath(path, paths.source, paths.destination);
    }
    return path;
  }
  const browserNavigation = $('[data-role="note-browser-navigation"]');
  const browserResults = $('[data-role="note-browser-results"]');
  const browserBack = $('[data-role="note-browser-back"]');
  const browserToggle = $('[data-note-action="toggle-browser"]');
  function browserModeActive() {
    return root.classList.contains('note-browser-mode') || document.documentElement.classList.contains('note-browser-restoring');
  }
  function browserResultsActive() {
    return root.classList.contains('note-browser-showing-results') || document.documentElement.classList.contains('note-browser-restoring');
  }
  function noteActionAvailable(name) {
    if (browserModeActive() && ['new-note', 'new-folder', 'toggle-sort', 'toggle-all-folders'].includes(name)) return false;
    if (browserResultsActive() && ['toggle-source', 'toggle-notebooks', 'current-menu'].includes(name)) return false;
    return true;
  }
  function updateBrowserControls() {
    updateNotebookRootLabel();
    updateExpandAllButton();
    updateViewToggle();
    if (sortTrigger) sortTrigger.disabled = !noteActionAvailable('toggle-sort');
  }
  const recentFiles = new Map();
  try { JSON.parse(localStorage.getItem('canvas:noteRecentFiles:v1') || '[]').slice(-200).forEach(([path, time]) => { if (typeof path === 'string' && Number.isFinite(time)) recentFiles.set(path, time); }); } catch (error) {}
  function persistRecent() {
    const entries = Array.from(recentFiles).sort((a, b) => b[1] - a[1]).slice(0, 200);
    recentFiles.clear(); entries.forEach(([path, time]) => recentFiles.set(path, time));
    try { localStorage.setItem('canvas:noteRecentFiles:v1', JSON.stringify(entries)); } catch (error) {}
  }
  function recordRecent(path) { recentFiles.set(path, Date.now()); persistRecent(); }
  async function beforeBrowse() {
    if (!(await finishInlineTitle())) return false;
    if (state.renamePath && !(await finishInlineRename())) return false;
    if (editorInputPending()) await whenEditorInputSettled();
    if (!(await flushSave())) return false;
    rememberEditorState(state.current);
    closeContextMenu(); setNoteSettingsOpen(false, { restoreFocus: false }); setLibraryPanel('', { restoreFocus: false });
    if (liveEditor) liveEditor.setImageTextMode(false);
    return true;
  }
  function showBrowserResults(show) {
    root.classList.toggle('note-browser-showing-results', show);
    $('.note-document-body')?.toggleAttribute('inert', show || !!noteMovePromise);
    updateBrowserControls();
  }
  async function loadNoteBrowser() {
    if (noteBrowser) return noteBrowser;
    if (!browserLoader) browserLoader = (async () => {
      if (!window.RelatumNoteBrowser) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = 'note-browser.js'; script.async = true;
        script.onload = resolve; script.onerror = () => reject(new Error(tr('readFailed'))); document.head.appendChild(script);
      });
      noteBrowser = window.RelatumNoteBrowser.create({ root, navigation: browserNavigation, results: browserResults, back: browserBack,
        request, query: (query) => post('/api/note-query', query), language, icon: noteIcon,
        getEntries: () => flattenEntries(state.entries, []), getRecent: () => Object.fromEntries(recentFiles),
        beforeBrowse, showResults: showBrowserResults, openNote: (path) => openNote(path),
        canvasEnabled, revealCanvas: (path) => post('/api/notes-canvas/reveal', { path }), showError: (message) => showToast(message, 'error'),
      });
      return noteBrowser;
    })().catch((error) => { browserLoader = null; throw error; });
    return browserLoader;
  }
  function updateBrowserToggle() {
    if (!browserToggle) return;
    const label = language() === 'en' ? (browserIntent ? 'Back to file tree' : 'Browse notes') : (browserIntent ? '返回文件树' : '浏览笔记');
    browserToggle.setAttribute('aria-label', label); browserToggle.title = label; browserToggle.setAttribute('aria-pressed', String(browserIntent));
  }
  async function setBrowserMode(enabled, tag) {
    if (!state.active) return;
    const sequence = ++browserSequence; browserIntent = enabled;
    if (!(await beforeBrowse()) || sequence !== browserSequence) { if (sequence === browserSequence) { browserIntent = root.classList.contains('note-browser-mode'); updateBrowserToggle(); } return; }
    try {
      const browser = enabled ? await loadNoteBrowser() : noteBrowser;
      if (sequence !== browserSequence || !state.active) return;
      root.classList.toggle('note-browser-mode', enabled);
      browserNavigation.hidden = !enabled;
      treeEl.inert = enabled;
      try { localStorage.setItem('canvas:noteSidebarView:v1', enabled ? 'browse' : 'tree'); } catch (error) {}
      document.documentElement.classList.remove('note-browser-restoring'); updateBrowserToggle(); updateBrowserControls();
      if (enabled) await browser.activate({ tag });
      else if (browser) browser.suspend();
      if (!enabled) scheduleInlineTitleScroll();
    } catch (error) {
      if (sequence !== browserSequence || !state.active) return;
      document.documentElement.classList.remove('note-browser-restoring');
      browserIntent = false; root.classList.remove('note-browser-mode'); browserNavigation.hidden = true; treeEl.inert = false;
      if (noteBrowser) noteBrowser.suspend();
      updateBrowserControls();
      updateBrowserToggle(); showToast(error.message || tr('readFailed'), 'error');
    }
  }
  let bodyMenuContext = null, bodyMenuSubmenu = null, bodyMenuParent = null;
  let statisticsTimer = 0, statisticsFrame = 0, statisticsJob = null;
  let prefetchEpoch = 0, prefetchRunning = false, hoverPrefetchTimer = 0, hoverPrefetchPath = '';

  const ACTIVE_PATH_KEY = 'canvas:noteActivePath:v1';
  const ACTIVE_TAB_KEY = 'canvas:noteActiveTab:v1';
  const OPEN_TABS_KEY = 'canvas:noteOpenTabs:v1';
  const EXPANDED_KEY = 'canvas:noteExpandedFolders:v1';
  const NOTE_VIEW_KEY = 'canvas:noteView:v1';
  const VIEW_STATES_KEY = 'canvas:noteViewStates:v1';
  const IMAGE_TEXT_DEFAULTS_KEY = 'canvas:noteImageTextDefaults:v1';
  const NOTE_FOCUS_KEY = 'canvas:noteFocusMode:v1';
  const TREE_SORT_KEY = 'canvas:noteTreeSort:v1';
  const NEW_NAME_KEY = 'canvas:noteNewName:v1';
  const SORT_MODES = ['name-asc', 'name-desc', 'modified-desc', 'modified-asc', 'created-desc', 'created-asc'];
  const IMAGE_TEXT_SIZES = ['sm', 'md', 'lg', 'xl', 'xxl', 'xxxl'];
  const IMAGE_TEXT_COLORS = ['black', 'white', 'yellow', 'orange', 'red', 'purple', 'blue', 'cyan', 'green', 'gray'];
  const NOTE_SHORTCUTS = window.RelatumNoteShortcuts || null;
  const VIEW_STATES_LIMIT = 200;
  const VIEW_STATES_DELAY = 750;
  const viewStates = new Map();
  let viewStatesTimer = 0;
  let viewStatesDirty = false;
  const SAVE_DELAY = 350;
  const RETRY_DELAY = 2200;
  const EXTERNAL_SYNC_DELAYS = [2000, 4000, 8000, 16000, 30000];
  const TREE_MOTION_MS = 220;
  const FOCUS_MOTION_MS = 320;
  const DOCUMENT_CACHE_LIMIT = 24;
  const DOCUMENT_CACHE_BYTES = 16 * 1024 * 1024;
  const BLANK_TAB_PREFIX = 'relatum:blank-tab:';
  const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const COPY = {
    'zh-CN': {
      loading: '正在读取笔记库…', emptyTree: '还没有笔记', select: '选择一篇笔记', readFailed: '读取笔记失败',
      saveFailed: '保存失败，请检查磁盘空间或目录权限', newNote: '新建笔记', newFolder: '新建文件夹', rename: '重命名',
      moveFailed: '移动失败', explorer: '在系统资源管理器中显示', openLibrary: '在资源管理器中打开笔记库',
      canvasExplorer: '在系统资源管理器中打开',
      assets: '打开伴生素材目录', recycle: '移到系统回收站', recycled: '已移到系统回收站', refresh: '刷新',
      refreshed: '笔记库已刷新', copyPath: '复制库内路径', copied: '路径已复制', open: '打开', createHere: '在此新建笔记',
      createFolderHere: '新建子文件夹', noAssets: '当前笔记还没有伴生素材', revealFailed: '无法在资源管理器中显示',
      importFailed: '导入失败', imported: '已导入 {count} 篇笔记', unsupportedSkipped: '已跳过 {count} 个不支持的文件',
      uploadFailed: '图片保存失败', linkWarnings: '已移动；{count} 个歧义双链保持原样', ambiguous: '同名笔记不唯一',
      missing: '尚未创建', noOutgoing: '当前笔记没有出链', noBacklinks: '当前笔记没有反向链接',
      unresolvedTitle: '创建这篇笔记？', unresolvedCopy: '“[[{target}]]”尚不存在。', cancel: '取消', create: '创建',
      externalOpenFailed: '无法打开外部链接',
      expandFolder: '展开文件夹', collapseFolder: '收起文件夹', duplicateTitle: '已经存在一个同名文件',
      expandAll: '全部展开', collapseAll: '全部收起',
      titleRequired: '文件名不能为空', words: '{count} 个词', characters: '{count} 个字符', newTab: '新标签页', closeTab: '关闭标签页', closeAllTabs: '关闭所有笔记标签',
      enterFocus: '隐藏顶部栏', exitFocus: '显示顶部栏',
      livePreview: '实时预览', sourceMode: '源码模式', readingMode: '阅读模式',
      switchToSource: '切换到源码模式', switchToLive: '切换到实时预览',
      imageText: '图片文字', addImageText: '添加文字', editImageText: '编辑文字框', deleteImageText: '删除文字框', mergeImageText: '合并为图片',
      sort: '排序', librarySettings: '笔记库设置', librarySort: '文件树排序', newNameSetting: '新建笔记命名',
      sortNameAsc: '文件名 (A-Z)', sortNameDesc: '文件名 (Z-A)', sortModifiedDesc: '编辑时间（从新到旧）', sortModifiedAsc: '编辑时间（从旧到新）',
      sortCreatedDesc: '创建时间（从新到旧）', sortCreatedAsc: '创建时间（从旧到新）',
      timestampName: '日期 + 时间', customName: '自定义名称', customNameLabel: '名称（不含 .md）', defaultCustomName: '未命名笔记',
      namePreview: '新建示例：{name}', invalidNewName: '请输入有效文件名；不能包含路径或 Windows 禁用字符',
      libraryReset: '恢复默认', libraryResetTitle: '恢复笔记库设置默认值？',
      libraryResetCopy: '重置文件树排序和新建笔记命名。',
    },
    en: {
      loading: 'Reading notes…', emptyTree: 'No notes yet', select: 'Select a note', readFailed: 'Could not read notes',
      saveFailed: 'Could not save. Check disk space and folder permissions.', newNote: 'New note', newFolder: 'New folder', rename: 'Rename',
      moveFailed: 'Move failed', explorer: 'Show in File Explorer', openLibrary: 'Open notes folder in File Explorer',
      canvasExplorer: 'Open in File Explorer',
      assets: 'Open companion assets', recycle: 'Move to Recycle Bin', recycled: 'Moved to Recycle Bin', refresh: 'Refresh',
      refreshed: 'Notes refreshed', copyPath: 'Copy vault path', copied: 'Path copied', open: 'Open', createHere: 'New note here',
      createFolderHere: 'New subfolder', noAssets: 'This note has no companion assets',
      revealFailed: 'Could not show this item in File Explorer', importFailed: 'Import failed', imported: 'Imported {count} notes',
      unsupportedSkipped: 'Skipped {count} unsupported files', uploadFailed: 'Could not save image',
      linkWarnings: 'Moved; {count} ambiguous links were unchanged', ambiguous: 'Duplicate note name', missing: 'Not created',
      noOutgoing: 'No outgoing links', noBacklinks: 'No backlinks', unresolvedTitle: 'Create this note?',
      unresolvedCopy: '“[[{target}]]” does not exist yet.', cancel: 'Cancel', create: 'Create',
      externalOpenFailed: 'Could not open external link',
      expandFolder: 'Expand folder', collapseFolder: 'Collapse folder', duplicateTitle: 'A file with the same name already exists',
      expandAll: 'Expand all', collapseAll: 'Collapse all',
      titleRequired: 'A filename is required', words: '{count} words', characters: '{count} characters', newTab: 'New tab', closeTab: 'Close tab', closeAllTabs: 'Close all note tabs',
      enterFocus: 'Hide top bar', exitFocus: 'Show top bar',
      livePreview: 'Live Preview', sourceMode: 'Source mode', readingMode: 'Reading mode',
      switchToSource: 'Switch to source mode', switchToLive: 'Switch to Live Preview',
      imageText: 'Image text', addImageText: 'Add text', editImageText: 'Edit text box', deleteImageText: 'Delete text box', mergeImageText: 'Merge into image',
      sort: 'Sort', librarySettings: 'Library settings', librarySort: 'File tree sorting', newNameSetting: 'New note naming',
      sortNameAsc: 'File name (A-Z)', sortNameDesc: 'File name (Z-A)', sortModifiedDesc: 'Modified (newest first)', sortModifiedAsc: 'Modified (oldest first)',
      sortCreatedDesc: 'Created (newest first)', sortCreatedAsc: 'Created (oldest first)',
      timestampName: 'Date + time', customName: 'Custom name', customNameLabel: 'Name (without .md)', defaultCustomName: 'Untitled',
      namePreview: 'Example: {name}', invalidNewName: 'Enter a valid file name without paths or Windows-reserved characters',
      libraryReset: 'Reset', libraryResetTitle: 'Restore default Library settings?',
      libraryResetCopy: 'Reset file tree sorting and new note naming.',
    },
  };
  const state = {
    active: false, initialized: false, treeRendered: false, entries: [], current: null, selectedFolder: '', selectedPath: '', rootTargeted: false, expanded: new Set(), sideMode: 'notebooks',
    notebookRoot: '', notebookExpanded: new Set(), notebookColors: {}, notebookSettingsLoaded: false, notebookTreeDirty: true, notebookPruning: new Map(),
    editGeneration: 0, saveTimer: 0, retryTimer: 0, saveChain: Promise.resolve(true), saveRunning: false,
    openSeq: 0, refreshSeq: 0, externalSeq: 0, linksSeq: 0, linksRefreshTimer: 0, linksRefreshSuspended: false, draggedPath: '', renamePath: '', renameOriginal: '',
    importRunning: false, renameError: '', renameDraft: null, renameCommitPromise: null, lastMoveError: '',
    openingPath: '', documentGeneration: 0, documentCache: new Map(), loadPromises: new Map(), entryIndex: new Map(), prefetchTimer: 0,
    initializePromise: null, tabs: [], activeTab: '', renderedActiveTab: '', draggedTabPath: '', titleRenamePromise: null, lastMoveCode: '',
    externalSyncTimer: 0, externalSyncFailures: 0, externalSyncUnchanged: 0, treeMetadataSignature: '', externalSyncChain: Promise.resolve(true), recycleRunning: false,
    focusMode: document.body.classList.contains('note-focus-mode'), focusMotionTimer: 0, focusMotionSeq: 0, titleScrollFrame: 0, titleResizeObserver: null,
    viewMode: 'live', settingsOpen: false, recordingShortcutCommand: '', settingsCloseTimer: 0, settingsResetTimer: 0,
    treeSort: 'modified-desc', newName: { mode: 'timestamp', baseName: '' }, libraryPanel: '', libraryPanelTimers: {}, pendingTreeReorder: false, renderedOrder: '',
    imageText: {
      available: false, active: false, armed: false, selectedId: '', size: 'md', color: 'white', canDelete: false,
      toggleSeq: 0, toggleIntent: null,
    },
    shortcutBindings: NOTE_SHORTCUTS ? NOTE_SHORTCUTS.load() : {},
  };
  try { const stored = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); if (Array.isArray(stored)) state.expanded = new Set(stored); } catch (error) {}
  try { const stored = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '[]'); if (Array.isArray(stored)) state.tabs = stored.filter((path) => typeof path === 'string'); } catch (error) {}
  try { const stored = localStorage.getItem(ACTIVE_TAB_KEY) || ''; if (state.tabs.includes(stored)) state.activeTab = stored; } catch (error) {}
  try { state.viewMode = normalizeViewMode(localStorage.getItem(NOTE_VIEW_KEY)); } catch (error) {}
  try { const savedSort = localStorage.getItem(TREE_SORT_KEY); if (SORT_MODES.includes(savedSort)) state.treeSort = savedSort; } catch (error) {}
  try {
    const savedName = JSON.parse(localStorage.getItem(NEW_NAME_KEY) || '{}');
    const baseName = savedName && normalizeCustomBase(savedName.baseName);
    if (baseName) state.newName = { mode: savedName.mode === 'custom' ? 'custom' : 'timestamp', baseName };
  } catch (error) {}
  try {
    const stored = JSON.parse(localStorage.getItem(IMAGE_TEXT_DEFAULTS_KEY) || '{}');
    if (IMAGE_TEXT_SIZES.includes(stored.size)) state.imageText.size = stored.size;
    if (IMAGE_TEXT_COLORS.includes(stored.color)) state.imageText.color = stored.color;
  } catch (error) {}
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_STATES_KEY) || '[]');
    if (Array.isArray(stored)) stored.slice(-VIEW_STATES_LIMIT).forEach((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0] || !entry[1]) return;
      const view = entry[1];
      if (![view.anchor, view.head, view.scrollTop].every((value) => Number.isFinite(value) && value >= 0)) return;
      viewStates.set(entry[0], { anchor: Math.floor(view.anchor), head: Math.floor(view.head), scrollTop: view.scrollTop });
    });
  } catch (error) {}

  function noteSettingsCopy(key) {
    const english = language() === 'en';
    const copy = {
      listen: ['按下快捷键', 'Press shortcut'],
      unassigned: ['未设置', 'Unassigned'],
      duplicate: ['该快捷键已在此命令中', 'This shortcut is already assigned here'],
      invalid: ['请使用 Ctrl/Cmd、Alt，或独立功能键', 'Use Ctrl/Cmd, Alt, or a function key'],
      restored: ['已恢复', 'Restored'],
      conflict: ['与“{name}”冲突', 'Conflicts with “{name}”'],
      resetTitle: ['恢复笔记设置默认值？', 'Restore default Note settings?'],
      resetCopy: ['重置正文字号、图片文字和编辑器快捷键。', 'Reset text size, image text scale and editor shortcuts.'],
      reset: ['恢复默认', 'Reset'], cancel: ['取消', 'Cancel'],
    };
    return (copy[key] || ['', ''])[english ? 1 : 0];
  }

  function notebookCopy(key) {
    const labels = {
      notebooks: ['笔记本', 'Notebooks'], links: ['链接', 'Links'], canvas: ['画布', 'Canvas'], guide: ['引导', 'Guide'],
      create: ['新建笔记本', 'New notebook'], close: ['关闭侧栏', 'Close sidebar'],
      gray: ['灰色', 'Gray'], blue: ['蓝色', 'Blue'], cyan: ['青色', 'Cyan'], green: ['绿色', 'Green'],
      yellow: ['黄色', 'Yellow'], orange: ['橙色', 'Orange'], red: ['红色', 'Red'], purple: ['紫色', 'Purple'],
      settingsFailed: ['笔记本配置保存失败', 'Could not save notebook settings'],
    };
    return (labels[key] || [key, key])[language() === 'en' ? 1 : 0];
  }
  function isNotebookContainer(path) { return String(path).toLowerCase() === NOTEBOOK_CONTAINER.toLowerCase(); }
  function isNotebookRoot(path) { const parts = String(path).split('/'); return parts.length === 2 && isNotebookContainer(parts[0]); }
  function notebookRootForPath(path) {
    const parts = String(path || '').split('/');
    const candidate = parts.length >= 2 && isNotebookContainer(parts[0]) ? parts.slice(0, 2).join('/') : '';
    return candidate && findEntry(candidate)?.kind === 'folder' ? candidate : '';
  }
  function visibleTreeEntries() {
    if (state.notebookRoot === null) return [];
    if (state.notebookRoot) return findEntry(state.notebookRoot)?.children || [];
    return state.entries.filter((entry) => !isNotebookContainer(entry.path));
  }
  function notebookRoots() {
    const container = state.entries.find((entry) => entry.kind === 'folder' && isNotebookContainer(entry.path));
    return [{ kind: 'folder', name: 'notes', path: '', notebook: true, children: state.entries.filter((entry) => !isNotebookContainer(entry.path)) },
      ...(container?.children || []).filter((entry) => entry.kind === 'folder').slice().sort((a, b) => a.name.localeCompare(b.name, language(), { numeric: true, sensitivity: 'base' }))
        .map((entry) => ({ ...entry, notebook: true }))];
  }
  function notebookUi() {
    return { open: root.classList.contains('links-overlay-open'), mode: state.sideMode, selectedRoot: state.notebookRoot, expanded: Array.from(state.notebookExpanded) };
  }
  function queueNotebookSettings(patch) {
    if (!state.notebookSettingsLoaded) return;
    if (patch.ui) notebookSettingsPending.ui = { ...(notebookSettingsPending.ui || {}), ...patch.ui };
    if (patch.colors) notebookSettingsPending.colors = { ...(notebookSettingsPending.colors || {}), ...patch.colors };
    if (patch.pruneMissing) notebookSettingsPending.pruneMissing = Array.from(new Set([...(notebookSettingsPending.pruneMissing || []), ...patch.pruneMissing]));
    clearTimeout(notebookSettingsTimer);
    notebookSettingsTimer = setTimeout(flushNotebookSettings, 350);
  }
  function flushNotebookSettings(keepalive) {
    clearTimeout(notebookSettingsTimer); notebookSettingsTimer = 0;
    if (!Object.keys(notebookSettingsPending).length) return notebookSettingsChain;
    const patch = notebookSettingsPending; notebookSettingsPending = {};
    const send = async () => {
      // 颜色点击后目录可能被外部删除；不让失效颜色阻塞后续状态保存/清理。
      if (patch.colors) {
        Object.keys(patch.colors).forEach((path) => { if (findEntry(path)?.kind !== 'folder') delete patch.colors[path]; });
        if (!Object.keys(patch.colors).length) delete patch.colors;
      }
      try {
        const response = await fetch('/api/note-notebooks-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: keepalive === true });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || notebookCopy('settingsFailed'));
        (result.prunedPaths || []).forEach((path) => {
          delete state.notebookColors[path]; state.notebookPruning.delete(path);
          state.notebookExpanded.forEach((expanded) => { if (expanded === path || expanded.startsWith(path + '/')) state.notebookExpanded.delete(expanded); });
        });
        updateNotebookExpandButton();
        return true;
      } catch (error) {
        // 保留较新的操作，失败配置不阻断正文保存，也不启动额外重试计时器。
        if (patch.ui) notebookSettingsPending.ui = { ...patch.ui, ...(notebookSettingsPending.ui || {}) };
        if (patch.colors) notebookSettingsPending.colors = { ...patch.colors, ...(notebookSettingsPending.colors || {}) };
        if (patch.pruneMissing) notebookSettingsPending.pruneMissing = Array.from(new Set([...patch.pruneMissing, ...(notebookSettingsPending.pruneMissing || [])]));
        if (patch.ui || patch.colors) showToast(error.message || notebookCopy('settingsFailed'), 'error');
        return false;
      }
    };
    notebookSettingsChain = notebookSettingsChain.catch(() => false).then(send);
    return notebookSettingsChain;
  }
  function restoreNotebookSettings(settings) {
    const ui = settings?.ui || {};
    state.notebookColors = settings?.colors || {};
    state.notebookRoot = ui.selectedRoot === null ? null : typeof ui.selectedRoot === 'string' ? ui.selectedRoot : '';
    state.selectedFolder = state.notebookRoot; state.rootTargeted = true;
    state.notebookExpanded = new Set(Array.isArray(ui.expanded) ? ui.expanded : []);
    state.sideMode = ['notebooks', 'links', 'guide', ...(canvasEnabled() ? ['canvas'] : [])].includes(ui.mode) ? ui.mode : 'notebooks';
    root.classList.toggle('links-overlay-open', ui.open === true);
    state.notebookSettingsLoaded = true;
    updateSidePanel();
  }
  function reconcileNotebooks() {
    const roots = new Set(notebookRoots().map((entry) => entry.path));
    const missing = new Set(Object.keys(state.notebookColors).filter((path) => !roots.has(path)));
    state.notebookExpanded.forEach((path) => { if (path && !findEntry(path)) missing.add(path); });
    const selectedMissing = !!state.notebookRoot && !roots.has(state.notebookRoot);
    if (selectedMissing) {
      missing.add(state.notebookRoot); state.notebookRoot = ''; state.selectedFolder = ''; state.selectedPath = ''; state.rootTargeted = true;
    }
    state.notebookPruning.forEach((time, path) => { if (findEntry(path)) state.notebookPruning.delete(path); });
    const now = Date.now();
    const paths = Array.from(missing).filter((path) => !state.notebookPruning.has(path) || now - state.notebookPruning.get(path) >= 30000);
    if (paths.length) {
      paths.forEach((path) => state.notebookPruning.set(path, now));
      queueNotebookSettings({ pruneMissing: paths });
    }
    return selectedMissing;
  }
  let notebookSelectionSequence = 0;
  function selectNotebook(path, options) {
    if (path !== null && typeof path !== 'string') return false;
    if (path && (!isNotebookRoot(path) || findEntry(path)?.kind !== 'folder')) return false;
    notebookSelectionSequence += 1;
    const changed = state.notebookRoot !== path;
    state.notebookRoot = path;
    if (changed || options?.rootTarget) { state.selectedFolder = path; state.selectedPath = path; state.rootTargeted = true; }
    if (changed) { stopDocumentPrefetch(); queueNotebookSettings({ ui: notebookUi() }); }
    if (changed && !options?.noRender) renderTree({ keepNotebookTree: true });
    updateTreeSelection(); updateNotebookSelection(); updateNotebookRootLabel();
    return changed;
  }
  function updateNotebookRootLabel() {
    const selected = state.notebookRoot !== null;
    const footer = $('.note-tree-foot'); if (footer) footer.hidden = !selected;
    const label = $('.note-tree-foot > span');
    if (label) label.textContent = !selected ? '' : (language() === 'en' ? 'Local folder · ' : '本地目录 · ') + (state.notebookRoot ? 'notes/' + state.notebookRoot + '/' : 'notes/');
    root.querySelectorAll('[data-note-action="new-note"], [data-note-action="new-folder"], [data-note-action="reveal-root"]').forEach((button) => {
      const key = button.dataset.noteAction === 'new-note' ? 'newNote' : button.dataset.noteAction === 'new-folder' ? 'newFolder' : 'openLibrary';
      const copy = selected ? tr(key) : language() === 'en' ? 'Select a notebook first' : '请先选择笔记本';
      button.disabled = !selected || !noteActionAvailable(button.dataset.noteAction); button.removeAttribute('title');
      button.dataset.uiTooltip = copy; button.dataset.uiTooltipSource = copy; button.setAttribute('aria-label', copy);
    });
  }
  function updateNotebookSelection() {
    updateTreeSelection();
  }
  function notebookIcon(path) {
    const svg = noteIcon('notebook-filled', 'note-notebook-icon');
    svg.dataset.color = state.notebookColors[path] || 'gray';
    return svg;
  }
  function noteIcon(name, className) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('class', 'note-icon' + (className ? ' ' + className : ''));
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(namespace, 'use'); use.setAttribute('href', '#note-icon-' + name); svg.appendChild(use);
    return svg;
  }
  function updateNotebookExpandButton() {
    const button = $('[data-note-action="toggle-all-notebooks"]');
    if (!button) return;
    const any = state.notebookExpanded.size > 0;
    button.dataset.allExpanded = String(any); button.setAttribute('aria-pressed', String(any));
    button.title = tr(any ? 'collapseAll' : 'expandAll'); button.setAttribute('aria-label', button.title);
  }
  function toggleAllNotebooks() {
    if (state.notebookExpanded.size) state.notebookExpanded.clear();
    else state.notebookExpanded = new Set(flattenEntries(notebookRoots(), []).filter((entry) => entry.kind === 'folder').map((entry) => entry.path));
    queueNotebookSettings({ ui: notebookUi() }); state.notebookTreeDirty = true; renderNotebookTree();
  }

  function commandName(command) {
    return language() === 'en' ? command.en : command.zh;
  }

  function setShortcutStatus(text, type) {
    if (!settingsShortcutStatus) return;
    settingsShortcutStatus.textContent = text || '';
    settingsShortcutStatus.classList.toggle('is-ok', type === 'ok');
  }

  function renderNoteShortcutSettings() {
    if (!settingsShortcutList || !NOTE_SHORTCUTS) return;
    settingsShortcutList.replaceChildren();
    NOTE_SHORTCUTS.COMMANDS.forEach((command) => {
      const row = document.createElement('div');
      row.className = 'note-shortcut-row' + (state.recordingShortcutCommand === command.id ? ' is-recording' : '');
      const name = document.createElement('span');
      name.className = 'note-shortcut-command';
      name.textContent = commandName(command);
      const bindings = document.createElement('div');
      bindings.className = 'note-shortcut-bindings';
      const assigned = state.shortcutBindings[command.id] || [];
      if (!assigned.length && state.recordingShortcutCommand !== command.id) {
        const emptyLabel = document.createElement('span');
        emptyLabel.className = 'note-shortcut-empty';
        emptyLabel.textContent = noteSettingsCopy('unassigned');
        bindings.append(emptyLabel);
      }
      assigned.forEach((binding) => {
        const chip = document.createElement('span');
        chip.className = 'note-shortcut-chip';
        const label = document.createElement('kbd');
        label.textContent = NOTE_SHORTCUTS.displayBinding(binding);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.noteShortcutAction = 'remove';
        remove.dataset.noteShortcutCommand = command.id;
        remove.dataset.noteShortcutBinding = binding;
        remove.setAttribute('aria-label', (language() === 'en' ? 'Remove ' : '移除 ') + NOTE_SHORTCUTS.displayBinding(binding));
        remove.appendChild(noteIcon('x'));
        chip.append(label, remove);
        bindings.append(chip);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.dataset.noteShortcutAction = 'record';
      add.dataset.noteShortcutCommand = command.id;
      if (state.recordingShortcutCommand === command.id) {
        add.className = 'note-shortcut-add is-recording';
        add.textContent = noteSettingsCopy('listen');
        add.setAttribute('aria-label', noteSettingsCopy('listen'));
      } else {
        add.className = 'note-shortcut-add';
        add.appendChild(noteIcon('plus'));
        add.setAttribute('aria-label', (language() === 'en' ? 'Add shortcut for ' : '为此命令添加快捷键：') + commandName(command));
      }
      bindings.append(add);
      row.append(name, bindings);
      settingsShortcutList.append(row);
    });
  }

  function applyShortcutBindings() {
    if (liveEditor && typeof liveEditor.setShortcutBindings === 'function') liveEditor.setShortcutBindings(state.shortcutBindings);
  }

  function persistShortcutBindings() {
    if (NOTE_SHORTCUTS) state.shortcutBindings = NOTE_SHORTCUTS.save(state.shortcutBindings);
    applyShortcutBindings();
    renderNoteShortcutSettings();
  }

  function stopShortcutRecording(clearStatus) {
    if (!state.recordingShortcutCommand) return false;
    state.recordingShortcutCommand = '';
    if (clearStatus) setShortcutStatus('');
    renderNoteShortcutSettings();
    return true;
  }

  function beginShortcutRecording(commandId) {
    if (!NOTE_SHORTCUTS || !NOTE_SHORTCUTS.COMMANDS.some((command) => command.id === commandId)) return;
    state.recordingShortcutCommand = commandId;
    setShortcutStatus('');
    renderNoteShortcutSettings();
  }

  function acceptShortcutBinding(commandId, binding) {
    if (!NOTE_SHORTCUTS) return;
    const normalized = NOTE_SHORTCUTS.normalizeBinding(binding);
    if (!NOTE_SHORTCUTS.isAllowedBinding(normalized)) {
      setShortcutStatus(noteSettingsCopy('invalid'));
      return;
    }
    const assigned = state.shortcutBindings[commandId] || [];
    if (assigned.includes(normalized)) {
      setShortcutStatus(noteSettingsCopy('duplicate'));
      return;
    }
    const conflict = NOTE_SHORTCUTS.conflictFor(normalized, commandId, state.shortcutBindings);
    if (conflict) {
      setShortcutStatus(noteSettingsCopy('conflict').replace('{name}', commandName(conflict.command)));
      return;
    }
    state.shortcutBindings[commandId] = assigned.concat(normalized);
    state.recordingShortcutCommand = '';
    setShortcutStatus('');
    persistShortcutBindings();
  }

  function removeShortcutBinding(commandId, binding) {
    if (!NOTE_SHORTCUTS) return;
    state.shortcutBindings[commandId] = (state.shortcutBindings[commandId] || []).filter((item) => item !== binding);
    setShortcutStatus('');
    persistShortcutBindings();
  }

  function syncNoteSettingsFontScale() {
    const preference = window.RelatumNotePreferences;
    const input = $('[data-role="note-font-scale"]');
    const output = $('[data-role="note-font-scale-value"]');
    const scale = preference && typeof preference.readFontScale === 'function' ? preference.readFontScale() : 100;
    if (input) input.value = String(scale);
    if (output) output.textContent = scale + '%';
    const imageInput = $('[data-role="note-image-text-scale"]');
    const imageOutput = $('[data-role="note-image-text-scale-value"]');
    const imageScale = preference ? preference.readImageTextScale() : 100;
    if (imageInput) imageInput.value = String(imageScale);
    if (imageOutput) imageOutput.textContent = imageScale + '%';
  }

  function setNoteSettingsOpen(open, options) {
    if (!settingsPop || !settingsTrigger) return;
    const next = !!open;
    const restoreFocus = !options || options.restoreFocus !== false;
    if (!next && settingsPop.classList.contains('is-closing')) return;
    clearTimeout(state.settingsCloseTimer); state.settingsCloseTimer = 0;
    state.settingsOpen = next;
    settingsTrigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      settingsPop.classList.remove('is-closing');
      settingsPop.hidden = false;
      settingsPop.removeAttribute('inert');
      syncNoteSettingsFontScale();
      renderNoteShortcutSettings();
      positionSidePopover(settingsPop, settingsTrigger);
      scheduleSidePopoverPosition();
      return;
    }
    stopShortcutRecording(true);
    if (settingsResetConfirm) settingsResetConfirm.hidden = true;
    if (settingsResetButton) settingsResetButton.setAttribute('aria-expanded', 'false');
    settingsPop.setAttribute('inert', '');
    if (settingsPop.hidden) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settingsPop.hidden = true;
      settingsPop.classList.remove('is-closing');
      if (restoreFocus && document.contains(settingsTrigger)) settingsTrigger.focus();
      return;
    }
    settingsPop.classList.add('is-closing');
    state.settingsCloseTimer = window.setTimeout(() => {
      state.settingsCloseTimer = 0;
      if (state.settingsOpen) return;
      settingsPop.hidden = true;
      settingsPop.classList.remove('is-closing');
      if (restoreFocus && document.contains(settingsTrigger)) settingsTrigger.focus();
    }, 180);
  }

  function toggleNoteSettingsReset(open) {
    if (!settingsResetConfirm || !settingsResetButton) return;
    settingsResetConfirm.hidden = !open;
    settingsResetButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function resetNoteSettings() {
    const preference = window.RelatumNotePreferences;
    if (preference) preference.resetImageTextScale();
    if (preference && typeof preference.resetFontScale === 'function') preference.resetFontScale();
    else {
      try { localStorage.removeItem('canvas:noteFontScale:v1'); } catch (error) {}
      document.documentElement.style.setProperty('--note-font-scale', '1');
    }
    if (NOTE_SHORTCUTS) state.shortcutBindings = NOTE_SHORTCUTS.reset();
    applyShortcutBindings();
    syncNoteSettingsFontScale();
    renderNoteShortcutSettings();
    toggleNoteSettingsReset(false);
    if (settingsResetArea && settingsResetStatus) {
      clearTimeout(state.settingsResetTimer);
      settingsResetStatus.textContent = noteSettingsCopy('restored');
      settingsResetArea.classList.add('is-restored');
      state.settingsResetTimer = window.setTimeout(() => {
        settingsResetArea.classList.remove('is-restored');
        settingsResetStatus.textContent = '';
      }, 1300);
    }
  }

  function replaceFallbackSelection(prefix, suffix, placeholder) {
    if (!fallbackEditor) return false;
    const start = fallbackEditor.selectionStart;
    const end = fallbackEditor.selectionEnd;
    const selected = fallbackEditor.value.slice(start, end) || placeholder || '';
    const insert = prefix + selected + suffix;
    fallbackEditor.setRangeText(insert, start, end, 'end');
    if (start === end && selected) fallbackEditor.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    markChanged(editorSnapshot());
    return true;
  }

  function runFallbackShortcut(event) {
    if (!NOTE_SHORTCUTS || !fallbackEditor || event.defaultPrevented) return false;
    const binding = NOTE_SHORTCUTS.bindingFromEvent(event);
    if (!binding) return false;
    const command = NOTE_SHORTCUTS.COMMANDS.find((entry) => (state.shortcutBindings[entry.id] || []).includes(binding));
    if (!command) {
      if (!NOTE_SHORTCUTS.inactiveDefaultBindings(state.shortcutBindings).includes(binding)) return false;
      event.preventDefault();
      return true;
    }
    event.preventDefault();
    if (command.id === 'save') flushSave();
    else if (command.id === 'bold') replaceFallbackSelection('**', '**', '粗体');
    else if (command.id === 'italic') replaceFallbackSelection('*', '*', '斜体');
    else if (command.id === 'strike') replaceFallbackSelection('~~', '~~', '删除线');
    else if (command.id === 'highlight') replaceFallbackSelection('==', '==', '高光');
    else if (command.id === 'inline-code') replaceFallbackSelection('`', '`', '代码');
    else if (command.id === 'code-block') replaceFallbackSelection('```\n', '\n```', '');
    else if (command.id === 'link') replaceFallbackSelection('[', '](https://)', '链接文字');
    return true;
  }

  function persistViewStates() {
    clearTimeout(viewStatesTimer); viewStatesTimer = 0;
    if (!viewStatesDirty) return;
    try {
      localStorage.setItem(VIEW_STATES_KEY, JSON.stringify(Array.from(viewStates)));
      viewStatesDirty = false;
    } catch (error) {} // Position memory must never prevent editing or saving the note.
  }

  function rememberViewState(path, view) {
    if (!path) return;
    const normalized = {
      anchor: Math.max(0, Math.floor(Number(view.anchor) || 0)),
      head: Math.max(0, Math.floor(Number(view.head) || 0)),
      scrollTop: Math.max(0, Number(view.scrollTop) || 0),
    };
    const previous = viewStates.get(path);
    if (previous && previous.anchor === normalized.anchor && previous.head === normalized.head
      && previous.scrollTop === normalized.scrollTop && Array.from(viewStates.keys()).pop() === path) return;
    viewStates.delete(path); viewStates.set(path, normalized);
    while (viewStates.size > VIEW_STATES_LIMIT) viewStates.delete(viewStates.keys().next().value);
    viewStatesDirty = true;
    if (!viewStatesTimer) viewStatesTimer = setTimeout(persistViewStates, VIEW_STATES_DELAY);
  }

  function remapViewStates(source, destination) {
    Array.from(recentFiles).forEach(([path, time]) => { const next = mapPath(path, source, destination); if (next !== path) { recentFiles.delete(path); recentFiles.set(next, time); } });
    persistRecent(); if (noteBrowser) noteBrowser.invalidate();
    const entries = Array.from(viewStates);
    entries.forEach(([path]) => { if (mapPath(path, source, destination) !== path) viewStates.delete(path); });
    entries.forEach(([path, view]) => {
      const next = mapPath(path, source, destination);
      if (next !== path) rememberViewState(next, view);
    });
    if (state.current && (state.current.path === destination || state.current.path.startsWith(destination + '/'))) {
      rememberEditorState(state.current);
    }
    persistViewStates();
  }

  function editorSnapshot() {
    if (state.viewMode === 'reading' && state.current) {
      return {
        value: state.current.content || '',
        anchor: state.current.selectionStart || 0,
        head: state.current.selectionEnd ?? state.current.selectionStart ?? 0,
        scrollTop: readingHost && readingHost.scrollTop || 0,
      };
    }
    if (liveEditor) return liveEditor.snapshot();
    return {
      value: fallbackEditor.value,
      anchor: fallbackEditor.selectionStart || 0,
      head: fallbackEditor.selectionEnd ?? fallbackEditor.selectionStart ?? 0,
      scrollTop: fallbackEditor.scrollTop || 0,
    };
  }

  function whenEditorInputSettled() {
    return liveEditor && typeof liveEditor.whenInputSettled === 'function'
      ? liveEditor.whenInputSettled()
      : Promise.resolve(true);
  }

  function editorInputPending() {
    return !!(liveEditor && liveEditor.inputPending);
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
    const next = !!active;
    if (state.focusMode === next) return;
    state.focusMode = next;
    const seq = ++state.focusMotionSeq;
    clearTimeout(state.focusMotionTimer);
    document.body.classList.remove('note-focus-restoring');
    document.body.classList.add('note-focus-transitioning');
    document.body.classList.toggle('note-focus-mode', state.focusMode);
    try { localStorage.setItem(NOTE_FOCUS_KEY, state.focusMode ? '1' : '0'); } catch (error) {}
    updateFocusToggle();
    document.dispatchEvent(new CustomEvent('relatum:note-focuschange', { detail: { active: state.focusMode } }));
    requestAnimationFrame(() => { if (seq === state.focusMotionSeq) requestEditorMeasure(); });
    state.focusMotionTimer = setTimeout(() => {
      if (seq !== state.focusMotionSeq) return;
      state.focusMotionTimer = 0;
      document.body.classList.remove('note-focus-transitioning');
      requestEditorMeasure();
    }, FOCUS_MOTION_MS + 40);
  }

  function setEditorDocument(documentState) {
    closeContextMenu();
    if (!documentState) {
      cancelStatistics();
      if (window.RelatumNoteLiveEditor) window.RelatumNoteLiveEditor.releaseReadingDocument(readingHost);
    }
    const payload = {
      value: documentState && documentState.content || '',
      notePath: documentState && documentState.path || '',
      anchor: documentState && documentState.selectionStart || 0,
      head: documentState ? (documentState.selectionEnd ?? documentState.selectionStart ?? 0) : 0,
      scrollTop: documentState && documentState.scrollTop || 0,
    };
    if (state.titleScrollFrame) {
      cancelAnimationFrame(state.titleScrollFrame);
      state.titleScrollFrame = 0;
    }
    syncInlineTitleScroll(payload.scrollTop);
    if (liveEditor) liveEditor.setDocument(payload);
    if (!liveEditor) {
      fallbackEditor.value = payload.value;
      fallbackEditor.scrollTop = payload.scrollTop;
      requestAnimationFrame(() => fallbackEditor.setSelectionRange(payload.anchor, payload.head));
    } else fallbackEditor.value = '';
    if (state.viewMode === 'reading' && documentState) renderReadingDocument(payload);
    requestAnimationFrame(() => requestAnimationFrame(scheduleInlineTitleScroll));
  }

  function focusEditor() {
    if (root.classList.contains('note-browser-showing-results')) return;
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

  function clipboardLinkMarkdown(text, html) {
    const address = String(text || '').trim();
    if (!/^https?:\/\/[^\s<>]+$/i.test(address) || !html || html.length > 128 * 1024) return text;
    try {
      // Template contents stay inert, including scripts and external resources.
      const template = document.createElement('template');
      template.innerHTML = html;
      const links = template.content.querySelectorAll('a[href]');
      if (links.length !== 1) return text;
      const link = links[0];
      const target = new URL(link.getAttribute('href'));
      if (target.href !== new URL(address).href) return text;
      const title = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title || title === address || title.length > 4096) return text;
      const label = title.replace(/[\\\[\]`*_~<>]/g, '\\$&');
      const destination = address.replace(/[\\()]/g, (character) => ({ '\\': '%5C', '(': '%28', ')': '%29' })[character]);
      return '[' + label + '](' + destination + ')';
    } catch (error) { return text; }
  }

  async function openWikiFromEditor(rawTarget) {
    await ensureLinks();
    const outgoing = outgoingForWiki(rawTarget);
    if (outgoing && outgoing.path) {
      const writtenTarget = String(rawTarget || '').split('|', 1)[0];
      const hashAt = writtenTarget.indexOf('#');
      const fragment = hashAt >= 0 ? writtenTarget.slice(hashAt + 1) : '';
      if (await openNote(outgoing.path)) scheduleHeadingJump(fragment);
      return;
    }
    if (outgoing && outgoing.state === 'ambiguous') { showToast(tr('ambiguous'), 'warning'); return; }
    confirmCreateWiki(rawTarget);
  }

  function normalizedLinkTarget(rawTarget) {
    let target = String(rawTarget || '').trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
    const titled = /^(\S+)[ \t]+(?:"[^"]*"|'[^']*')$/.exec(target);
    return titled ? titled[1] : target;
  }

  function decodedLinkPart(value) {
    try { return decodeURIComponent(String(value || '')); }
    catch (error) { return String(value || ''); }
  }

  function resolveRelativeNotePath(notePath, rawPath) {
    const parts = parentPath(notePath).split('/').filter(Boolean);
    for (const rawPart of decodedLinkPart(rawPath).replace(/\\/g, '/').split('/')) {
      const part = rawPart.trim();
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return ''; parts.pop(); }
      else parts.push(part);
    }
    return parts.join('/');
  }

  function headingPosition(source, rawFragment) {
    const wanted = decodedLinkPart(rawFragment).replace(/^#/, '').trim().toLocaleLowerCase();
    if (!wanted) return { offset: 0, line: 0 };
    const slug = (value) => String(value || '').trim().toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = window.MarkdownMini && window.MarkdownMini.structure
        ? window.MarkdownMini.structure.parseHeading(lines[index]) : null;
      if (parsed && (parsed.text.trim().toLocaleLowerCase() === wanted || slug(parsed.text) === wanted)) {
        return { offset, line: index };
      }
      offset += lines[index].length + 1;
    }
    return null;
  }

  function jumpToHeading(fragment) {
    if (!state.current || !fragment) return false;
    const position = headingPosition(state.current.content, fragment);
    if (!position) return false;
    if (state.viewMode === 'reading' && readingHost) {
      const heading = readingHost.querySelector('[data-ln="' + position.line + '"]');
      if (heading) heading.scrollIntoView({ block: 'start' });
      return !!heading;
    }
    if (liveEditor && typeof liveEditor.revealPosition === 'function') {
      liveEditor.revealPosition(position.offset);
      return true;
    }
    fallbackEditor.focus();
    fallbackEditor.setSelectionRange(position.offset, position.offset);
    return true;
  }

  function scheduleHeadingJump(fragment) {
    if (!fragment) return;
    requestAnimationFrame(() => requestAnimationFrame(() => jumpToHeading(fragment)));
  }

  async function openLocalNoteFile(target, imageSyntax) {
    if (!state.current) return false;
    try {
      await post('/api/open-external', { kind: 'note-file', note: state.current.path, target, imageSyntax });
      return true;
    } catch (error) {
      showToast(error.message || tr('externalOpenFailed'), 'error');
      return false;
    }
  }

  async function openMarkdownTarget(rawTarget) {
    const target = normalizedLinkTarget(rawTarget);
    if (!target || !state.current) return false;
    if (/^(?:https?:|mailto:)/i.test(target)) {
      try { await post('/api/open-external', { kind: 'url', target }); return true; }
      catch (error) { showToast(error.message || tr('externalOpenFailed'), 'error'); return false; }
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
      showToast(tr('externalOpenFailed'), 'error');
      return false;
    }
    const hashAt = target.indexOf('#');
    const pathPart = (hashAt >= 0 ? target.slice(0, hashAt) : target).split('?', 1)[0];
    const fragment = hashAt >= 0 ? target.slice(hashAt + 1) : '';
    if (!pathPart) return jumpToHeading(fragment);
    const resolved = resolveRelativeNotePath(state.current.path, pathPart);
    const entry = findEntry(resolved);
    if (/\.md$/i.test(resolved) && entry && entry.kind === 'note') {
      if (await openNote(resolved)) scheduleHeadingJump(fragment);
      return true;
    }
    return openLocalNoteFile(pathPart);
  }

  function normalizeViewMode(mode) {
    return mode === 'source' || mode === 'reading' ? mode : 'live';
  }

  function updateViewToggle() {
    if (currentMenuButton) currentMenuButton.disabled = !state.current || !noteActionAvailable('current-menu');
    const notebooksToggle = $('[data-note-action="toggle-notebooks"]');
    if (notebooksToggle) notebooksToggle.disabled = !noteActionAvailable('toggle-notebooks');
    if (!viewToggle) return;
    const sourceMode = state.viewMode === 'source';
    const label = tr(sourceMode ? 'switchToLive' : 'switchToSource');
    viewToggle.disabled = !state.current || !noteActionAvailable('toggle-source');
    viewToggle.setAttribute('aria-pressed', sourceMode ? 'true' : 'false');
    viewToggle.setAttribute('aria-label', label);
    viewToggle.setAttribute('data-ui-tooltip', label);
  }

  function updateImageTextTools(nextState) {
    if (nextState && typeof nextState === 'object') Object.assign(state.imageText, nextState);
    const enabled = !!(state.current && liveEditor && state.viewMode === 'live');
    if (!enabled || state.imageText.available || state.imageTextCleanupPath !== state.current.path) state.imageTextCleanupPath = '';
    if (!enabled || !state.imageText.available) state.imageText.active = false;
    const open = enabled && root.classList.contains('links-overlay-open') && (!!state.imageText.active || !!state.imageTextCleanupPath);
    if (imageTextToggle) {
      const label = tr('imageText');
      imageTextToggle.disabled = !enabled || !!state.imageTextBusy;
      imageTextToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      imageTextToggle.setAttribute('aria-label', label);
      imageTextToggle.setAttribute('data-ui-tooltip', label);
      imageTextToggle.classList.toggle('is-active', open);
    }
    if (!imageTextTools) return;
    imageTextTools.hidden = !open;
    imageTextTools.toggleAttribute('inert', !open);
    if (open) { positionSidePopover(imageTextTools, imageTextToggle); scheduleSidePopoverPosition(); }
    imageTextTools.querySelectorAll('[data-image-text-action="size"]').forEach((button) => {
      const selected = button.dataset.imageTextValue === state.imageText.size;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    imageTextTools.querySelectorAll('[data-image-text-action="color"]').forEach((button) => {
      const selected = button.dataset.imageTextValue === state.imageText.color;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const add = imageTextTools.querySelector('[data-image-text-action="add"]');
    if (add) {
      add.classList.toggle('is-selected', !!state.imageText.armed);
      add.setAttribute('aria-pressed', state.imageText.armed ? 'true' : 'false');
      add.title = tr('addImageText');
    }
    const edit = imageTextTools.querySelector('[data-image-text-action="edit"]');
    if (edit) {
      edit.disabled = !state.imageText.canDelete;
      edit.title = tr('editImageText');
      edit.setAttribute('aria-label', tr('editImageText'));
    }
    const remove = imageTextTools.querySelector('[data-image-text-action="delete"]');
    if (remove) { remove.disabled = !state.imageText.canDelete; remove.title = tr('deleteImageText'); }
    const merge = imageTextTools.querySelector('[data-image-text-action="merge"]');
    if (merge) { merge.textContent = tr('mergeImageText'); merge.title = tr('mergeImageText'); }
    const cleanup = imageTextTools.querySelector('[data-image-text-action="cleanup"]');
    if (cleanup) {
      cleanup.textContent = language() === 'en' ? 'Delete text box data' : '删除文本框数据';
      cleanup.title = language() === 'en' ? 'Permanently clear this image’s text and unused text data in this note' : '永久删除选中图片的文字框及本篇未使用的文字框数据';
    }
    const busy = !!(state.imageTextBusy || state.assetCleanupBusy);
    const hasImage = enabled && !!state.imageText.available && !state.imageTextCleanupPath;
    const hasBox = hasImage && !!state.imageText.canDelete;
    const english = language() === 'en';
    const copy = (zh, en) => english ? en : zh;
    const sizes = { sm: ['小字号', 'Small text'], md: ['中字号', 'Medium text'], lg: ['大字号', 'Large text'], xl: ['特大字号', 'Extra-large text'], xxl: ['超大字号', 'Huge text'], xxxl: ['巨大字号', 'Giant text'] };
    const colors = { black: ['黑色', 'Black'], white: ['白色', 'White'], yellow: ['黄色', 'Yellow'], orange: ['橙色', 'Orange'], red: ['红色', 'Red'], purple: ['紫色', 'Purple'], blue: ['蓝色', 'Blue'], cyan: ['青色', 'Cyan'], green: ['绿色', 'Green'], gray: ['灰色', 'Gray'] };
    imageTextTools.setAttribute('aria-busy', String(busy));
    imageTextTools.querySelectorAll('button').forEach((button) => {
      const action = button.dataset.imageTextAction;
      let label = button.title || button.getAttribute('aria-label') || '';
      if (action === 'size' || action === 'color') {
        const names = (action === 'size' ? sizes : colors)[button.dataset.imageTextValue];
        label = names ? copy(...names) : label;
      }
      let reason = '';
      if (busy) reason = copy('正在处理，请稍候', 'Processing, please wait');
      else if (action !== 'cleanup' && !hasImage) reason = copy('请先选中图片', 'Select an image first');
      else if (['edit', 'delete'].includes(action) && !hasBox) reason = copy('请先选中文字框', 'Select a text box first');
      else if (action === 'merge' && !state.imageText.hasText) reason = copy('请先在图片上添加文字', 'Add text to the image first');
      else if (action === 'cleanup' && !hasImage && !state.imageTextCleanupPath) reason = copy('没有可删除的文字框数据', 'No text box data to delete');
      button.disabled = !!reason;
      let hint = reason;
      if (!hint && ['size', 'color'].includes(action)) hint = hasBox
        ? copy('应用于选中文字框，并用于新建文字框', 'Apply to the selected text box and new text boxes')
        : copy('用于接下来新建的文字框', 'Use for new text boxes');
      if (!hint && action === 'add') hint = state.imageText.armed
        ? copy('点击图片放置文字；再次点击取消', 'Click the image to place text; click again to cancel')
        : copy('点击后，在图片上选择文字位置', 'Click, then choose a position on the image');
      if (!hint && action === 'edit') hint = copy('Enter 或双击编辑；直接打字在末尾追加；编辑时单击另一框继续编辑，右键提交并退出编辑', 'Enter or double-click to edit; typing appends; click another box to continue editing, or right-click to save and exit editing');
      if (!hint && action === 'delete') hint = copy('删除选中文字框及其数据，可撤销；编辑中 Delete 只删除文字', 'Delete the selected text box and its data; undo is available. While editing, Delete removes characters');
      if (!hint && action === 'merge') hint = copy('将文字合并为新的 PNG，保留原图；文字将不可单独编辑', 'Merge text into a new PNG and keep the original; text will no longer be editable');
      if (!hint && action === 'cleanup') hint = hasImage
        ? copy('永久删除选中图片文字及本篇未使用的文字框数据，不创建备份', 'Permanently delete this image’s text and unused text data in this note, without a backup')
        : copy('永久清理本篇未使用的文字框数据，不创建备份', 'Permanently clear unused text data in this note, without a backup');
      button.removeAttribute('title');
      button.setAttribute('aria-label', label);
      button.setAttribute('data-ui-tooltip', label + (hint ? ' · ' + hint : ''));
      button.setAttribute('data-ui-tooltip-source', label + (hint ? ' · ' + hint : ''));
    });
  }

  let imageTextOperationPromise = null;
  function runImageTextOperation(kind) {
    if (state.imageTextBusy || state.assetCleanupBusy || !state.current || !liveEditor) return imageTextOperationPromise;
    const target = state.current;
    state.imageTextBusy = true;
    state.imageTextEpoch = (state.imageTextEpoch || 0) + 1;
    clearTimeout(state.saveTimer); clearTimeout(state.retryTimer); stopExternalSync();
    updateImageTextTools();
    imageTextOperationPromise = (async () => {
      try {
        await whenEditorInputSettled();
        root.inert = true;
        await state.saveChain;
        await state.externalSyncChain;
        if (state.current !== target) throw new Error('笔记已经切换，请重新选择图片');
        const selected = liveEditor.imageTextTarget();
        if (!selected && kind === 'merge') throw new Error('请先选中图片');
        rememberEditorState(target);
        const payload = { path: target.path, content: target.content, revision: target.revision, selected,
          renderedLines: liveEditor.imageTextRenderedLines() };
        if (kind === 'merge') payload.data = await fileToBase64(await liveEditor.exportImageTextPng());
        const result = await post('/api/note-image-text-' + kind, payload);
        target.persistedGeneration = target.editGeneration;
        state.documentCache.delete(target.path);
        state.loadPromises.delete(target.path);
        applyDocument(result, { preserveViewState: true });
        showToast(language() === 'en' ? (kind === 'merge' ? 'Merged into PNG' : 'Text box data deleted')
          : (kind === 'merge' ? '已合并为 PNG 图片' : '文本框数据已删除'));
        return true;
      } catch (error) {
        showToast(error.message || tr('saveFailed'), 'error');
        return false;
      } finally {
        root.inert = false;
        state.imageTextBusy = false;
        updateImageTextTools();
        scheduleExternalSync();
      }
    })();
    return imageTextOperationPromise;
  }

  function persistImageTextDefaults(defaults) {
    if (!defaults || typeof defaults !== 'object') return;
    if (IMAGE_TEXT_SIZES.includes(defaults.size)) state.imageText.size = defaults.size;
    if (IMAGE_TEXT_COLORS.includes(defaults.color)) state.imageText.color = defaults.color;
    try {
      localStorage.setItem(IMAGE_TEXT_DEFAULTS_KEY, JSON.stringify({
        size: state.imageText.size,
        color: state.imageText.color,
      }));
    } catch (error) {}
  }

  async function toggleImageTextMode(action) {
    if (!liveEditor || !action || action.disabled) return;
    const base = typeof state.imageText.toggleIntent === 'boolean'
      ? state.imageText.toggleIntent : !!(state.imageText.active || state.imageTextCleanupPath);
    const requested = !base;
    const seq = ++state.imageText.toggleSeq;
    state.imageText.toggleIntent = requested;
    if (editorInputPending()) await whenEditorInputSettled();
    if (seq !== state.imageText.toggleSeq) return;
    state.imageText.toggleIntent = null;
    if (!liveEditor || action.disabled) return;
    if (!state.imageText.available) {
      // This check runs only on an explicit toolbar click, never on input,
      // selection updates, timers or background sync.
      state.imageTextCleanupPath = requested && liveEditor.snapshot().value.includes('<!--relatum:image-text:')
        ? state.current.path : '';
      updateImageTextTools();
      if (requested && !state.imageTextCleanupPath) showToast(language() === 'en' ? 'No text box data in this note' : '本篇没有文本框数据');
      return;
    }
    state.imageTextCleanupPath = '';
    liveEditor.setImageTextMode(requested);
  }

  function readingPayload(documentState) {
    const target = documentState || state.current;
    return {
      value: target && target.content || '',
      notePath: target && target.path || '',
      anchor: target && target.selectionStart || 0,
      head: target ? (target.selectionEnd ?? target.selectionStart ?? 0) : 0,
      scrollTop: target && target.scrollTop || 0,
    };
  }

  function renderReadingDocument(payload) {
    if (!readingHost) return;
    const documentState = payload || readingPayload();
    if (window.RelatumNoteLiveEditor && typeof window.RelatumNoteLiveEditor.renderMarkdown === 'function') {
      window.RelatumNoteLiveEditor.renderMarkdown(readingHost, documentState.value || '', documentState.notePath || '', { calloutSession: liveEditor?.calloutSession });
    } else {
      const result = window.MarkdownMini && window.MarkdownMini.renderResult
        ? window.MarkdownMini.renderResult(documentState.value || '', { localImages: true, noteBlocks: true })
        : { html: '' };
      readingHost.innerHTML = '<article class="note-reading-content node-text">' + (result.html || '') + '</article>';
    }
    requestAnimationFrame(() => { readingHost.scrollTop = Math.max(0, Number(documentState.scrollTop) || 0); });
  }

  async function setViewMode(mode) {
    if (noteMovePromise) await waitForNoteMove();
    const next = normalizeViewMode(mode);
    if (next === state.viewMode) return;
    if (!(await flushCanvases())) return false;
    closeContextMenu();
    if (editorInputPending()) await whenEditorInputSettled();
    if (next === state.viewMode) return;
    if (liveEditor) liveEditor.setImageTextMode(false);
    if (state.current) rememberEditorState(state.current);
    if (next === 'reading' && state.current) flushSave(state.current);
    state.viewMode = next;
    if (next !== 'reading' && window.RelatumNoteLiveEditor) window.RelatumNoteLiveEditor.releaseReadingDocument(readingHost);
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
          value: '', notePath: '', sourceMode: state.viewMode === 'source', shortcutBindings: state.shortcutBindings,
          onDocChanged: (meta) => markChanged(meta),
          onSaveRequest: () => flushSave(),
          onOpenWiki: (target) => openWikiFromEditor(target),
          onOpenTag: (tag) => setBrowserMode(true, tag),
          onOpenExternal: (target) => openMarkdownTarget(target),
          onOpenLocalFile: (target, syntax) => openLocalNoteFile(target, syntax),
          onImageFiles: (files) => uploadImages(files),
          clipboardText: clipboardLinkMarkdown,
          onImageSelectionChange: (selection) => updateImageTextTools(selection),
          imageTextDefaults: { size: state.imageText.size, color: state.imageText.color },
          onImageTextDefaultsChange: (defaults) => persistImageTextDefaults(defaults),
          onContextMenu: (payload) => openBodyContextMenu(payload),
          onCanvasContextMenu: (payload) => openCanvasContextMenu(payload),
          onCommandContextChanged: () => { if (bodyMenuContext) closeContextMenu(); },
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
        const tag = event.target.closest('[data-note-tag]');
        if (tag) { event.preventDefault(); setBrowserMode(true, tag.dataset.noteTag); return; }
        const wiki = event.target.closest('[data-wikilink]');
        if (wiki) { event.preventDefault(); openWikiFromEditor(wiki.dataset.wikilink || ''); return; }
        const imageFrame = event.target.closest('.md-local-image');
        const image = imageFrame && imageFrame.querySelector('[data-note-image]');
        if (image) { event.preventDefault(); openLocalNoteFile(image.dataset.noteImage || '', image.dataset.noteImageSyntax); return; }
        const link = event.target.closest('[data-href]');
        if (link) {
          event.preventDefault();
          openMarkdownTarget(link.dataset.href || '');
        }
      });
    }
    if (inlineTitleShell && window.ResizeObserver) {
      state.titleResizeObserver = new ResizeObserver(scheduleInlineTitleScroll);
      state.titleResizeObserver.observe(inlineTitleShell);
    }
    fallbackEditor.addEventListener('input', () => markChanged(editorSnapshot()));
    let fallbackPastePlain = false;
    fallbackEditor.addEventListener('keydown', (event) => {
      fallbackPastePlain = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';
      if (runFallbackShortcut(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); flushSave(); }
    });
    fallbackEditor.addEventListener('keyup', () => { fallbackPastePlain = false; });
    fallbackEditor.addEventListener('blur', () => { fallbackPastePlain = false; });
    fallbackEditor.addEventListener('paste', (event) => {
      const plain = fallbackPastePlain;
      fallbackPastePlain = false;
      const files = Array.from(event.clipboardData && event.clipboardData.items || []).filter((item) => item.kind === 'file' && /^image\//i.test(item.type || '')).map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); uploadImages(files); return; }
      if (plain || !event.clipboardData) return;
      const text = event.clipboardData.getData('text/plain');
      const markdown = clipboardLinkMarkdown(text, event.clipboardData.getData('text/html'));
      if (markdown !== text) { event.preventDefault(); replaceEditorSelection(markdown); }
    });
    fallbackEditor.addEventListener('dragover', (event) => { if (Array.from(event.dataTransfer && event.dataTransfer.files || []).some((file) => /^image\//i.test(file.type || '') || IMAGE_RE.test(file.name || ''))) event.preventDefault(); });
    fallbackEditor.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer && event.dataTransfer.files || []).filter((file) => /^image\//i.test(file.type || '') || IMAGE_RE.test(file.name || ''));
      if (files.length) { event.preventDefault(); uploadImages(files); }
    });
  }

  function language() { return window.RelatumI18n && window.RelatumI18n.language === 'en' ? 'en' : 'zh-CN'; }
  function tr(key, values) { let text = COPY[language()][key] || COPY['zh-CN'][key] || key; Object.keys(values || {}).forEach((name) => { text = text.replaceAll('{' + name + '}', String(values[name])); }); return text; }
  const SORT_LABELS = {
    'name-asc': 'sortNameAsc', 'name-desc': 'sortNameDesc',
    'modified-desc': 'sortModifiedDesc', 'modified-asc': 'sortModifiedAsc',
    'created-desc': 'sortCreatedDesc', 'created-asc': 'sortCreatedAsc',
  };
  function nameCompare(left, right) {
    return left.name.localeCompare(right.name, language(), { numeric: true, sensitivity: 'base' }) || left.path.localeCompare(right.path);
  }
  function sortedTreeEntries(entries) {
    const mode = state.treeSort;
    return (entries || []).slice().sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      if (left.kind === 'folder') return nameCompare(left, right);
      if (mode === 'name-asc' || mode === 'name-desc') return nameCompare(left, right) * (mode === 'name-desc' ? -1 : 1);
      const key = mode.startsWith('created-') ? 'createdNs' : 'modifiedNs';
      const delta = (Number(left[key]) || 0) - (Number(right[key]) || 0);
      return (mode.endsWith('-desc') ? -delta : delta) || nameCompare(left, right);
    });
  }
  function treeOrderSignature(entries) {
    const paths = [];
    const visit = (items) => sortedTreeEntries(items).forEach((entry) => {
      paths.push(entry.path);
      if (entry.kind === 'folder') visit(entry.children);
    });
    visit(entries);
    return JSON.stringify(paths);
  }
  function normalizeCustomBase(raw) {
    if (typeof raw !== 'string') return '';
    let base = raw.trim().normalize('NFC');
    if (/\.md$/i.test(base)) base = base.slice(0, -3);
    if (!base || /[<>:"/\\|?*\x00-\x1f]/.test(base) || /[. ]$/.test(base)) return '';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) || /^\.relatum-/i.test(base)) return '';
    return base;
  }
  function persistNewName() { try { localStorage.setItem(NEW_NAME_KEY, JSON.stringify(state.newName)); } catch (error) {} }
  function timestampNamePreview() {
    const now = new Date();
    const part = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}.md`;
  }
  function updateNamePreview() {
    if (!libraryNameInput || !libraryNamePreview) return;
    const custom = state.newName.mode === 'custom';
    libraryNameInput.disabled = !custom;
    libraryNameField.classList.toggle('is-disabled', !custom);
    const base = custom ? normalizeCustomBase(libraryNameInput.value) : '';
    libraryNamePreview.textContent = tr('namePreview', { name: custom && base ? base + '.md' : timestampNamePreview() });
    libraryNameError.textContent = custom && !base ? tr('invalidNewName') : '';
  }
  function renderLibraryPreferences() {
    if (!sortMenu || !librarySettings) return;
    const focusedChoice = document.activeElement && (document.activeElement.dataset.noteSortMode || document.activeElement.dataset.noteNameMode);
    const focusedHost = focusedChoice && (sortMenu.contains(document.activeElement) ? sortMenu : librarySettings.contains(document.activeElement) ? librarySettings : null);
    sortTrigger.title = tr('sort'); sortTrigger.setAttribute('aria-label', tr('sort'));
    libraryTrigger.title = tr('librarySettings'); libraryTrigger.setAttribute('aria-label', tr('librarySettings'));
    sortMenu.setAttribute('aria-label', tr('librarySort'));
    librarySettings.setAttribute('aria-label', tr('librarySettings'));
    $('[data-role="note-library-settings-title"]').textContent = tr('librarySettings');
    $('[data-role="note-library-sort-title"]').textContent = tr('librarySort');
    $('[data-role="note-library-name-title"]').textContent = tr('newNameSetting');
    $('[data-role="note-library-name-label"]').textContent = tr('customNameLabel');
    $('[data-role="note-library-reset-label"]').textContent = tr('libraryReset');
    $('[data-role="note-library-reset-title"]').textContent = tr('libraryResetTitle');
    $('[data-role="note-library-reset-copy"]').textContent = tr('libraryResetCopy');
    $('[data-role="note-library-reset-cancel"]').textContent = tr('cancel');
    $('[data-role="note-library-reset-accept"]').textContent = tr('libraryReset');
    libraryResetConfirm.setAttribute('aria-label', tr('libraryResetTitle'));
    const makeSortButton = (mode, inMenu) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.noteSortMode = mode;
      button.textContent = tr(SORT_LABELS[mode]);
      button.className = 'note-sort-option' + (mode === state.treeSort ? ' is-selected' : '');
      if (inMenu) { button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(mode === state.treeSort)); }
      else button.setAttribute('aria-pressed', String(mode === state.treeSort));
      return button;
    };
    sortMenu.replaceChildren(...SORT_MODES.map((mode) => makeSortButton(mode, true)));
    librarySortOptions.replaceChildren(...SORT_MODES.map((mode) => makeSortButton(mode, false)));
    libraryNameOptions.replaceChildren(...['timestamp', 'custom'].map((mode) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.noteNameMode = mode;
      button.className = 'note-name-option' + (state.newName.mode === mode ? ' is-selected' : '');
      button.setAttribute('aria-pressed', String(state.newName.mode === mode));
      button.textContent = tr(mode === 'custom' ? 'customName' : 'timestampName');
      return button;
    }));
    libraryNameInput.value = state.newName.baseName || '';
    updateNamePreview();
    if (focusedHost) {
      const replacement = Array.from(focusedHost.querySelectorAll('[data-note-sort-mode], [data-note-name-mode]'))
        .find((button) => button.dataset.noteSortMode === focusedChoice || button.dataset.noteNameMode === focusedChoice);
      if (replacement) replacement.focus();
    }
  }
  function setTreeSort(mode) {
    if (!SORT_MODES.includes(mode)) return;
    if (state.treeSort !== mode) {
      state.treeSort = mode;
      try { localStorage.setItem(TREE_SORT_KEY, mode); } catch (error) {}
      renderTree();
    }
    renderLibraryPreferences();
  }
  function toggleLibraryReset(open, restoreFocus) {
    if (!libraryResetConfirm || !libraryResetButton) return;
    libraryResetConfirm.hidden = !open;
    libraryResetButton.setAttribute('aria-expanded', String(open));
    if (open) $('[data-role="note-library-reset-cancel"]').focus();
    else if (restoreFocus) libraryResetButton.focus();
  }
  function resetLibraryPreferences() {
    const orderChanged = state.treeSort !== 'modified-desc';
    [TREE_SORT_KEY, NEW_NAME_KEY].forEach((key) => {
      try { localStorage.removeItem(key); } catch (error) {}
    });
    state.treeSort = 'modified-desc';
    state.newName = { mode: 'timestamp', baseName: '' };
    toggleLibraryReset(false, true);
    if (orderChanged) renderTree();
    renderLibraryPreferences();
  }
  function setLibraryPanel(kind, options) {
    const panels = { sort: [sortMenu, sortTrigger], settings: [librarySettings, libraryTrigger] };
    const restoreFocus = !options || options.restoreFocus !== false;
    Object.entries(panels).forEach(([name, [panel, trigger]]) => {
      if (!panel || !trigger) return;
      clearTimeout(state.libraryPanelTimers[name]);
      const open = name === kind;
      trigger.setAttribute('aria-expanded', String(open));
      if (name === 'settings' && !open) toggleLibraryReset(false);
      if (open) {
        panel.hidden = false; panel.inert = false; panel.classList.remove('is-closing');
      } else if (!panel.hidden) {
        panel.inert = true;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) panel.hidden = true;
        else {
          panel.classList.add('is-closing');
          state.libraryPanelTimers[name] = window.setTimeout(() => {
            if (state.libraryPanel !== name) { panel.hidden = true; panel.classList.remove('is-closing'); }
          }, 160);
        }
        if (restoreFocus && !kind && state.libraryPanel === name) trigger.focus();
      }
    });
    state.libraryPanel = kind;
    if (kind) { setNoteSettingsOpen(false, { restoreFocus: false }); closeContextMenu(); renderLibraryPreferences(); }
  }
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
  function visibleNoteSource(value) {
    const source = String(value || '');
    return window.MarkdownMini && typeof window.MarkdownMini.imageTextVisibleSource === 'function'
      ? window.MarkdownMini.imageTextVisibleSource(source) : source;
  }
  function noteStatistics(value) {
    const visible = visibleNoteSource(value);
    return { words: wordCount(visible), characters: visible.length };
  }
  function cancelStatistics() {
    clearTimeout(statisticsTimer); statisticsTimer = 0;
    if (statisticsFrame) cancelAnimationFrame(statisticsFrame);
    statisticsFrame = 0; statisticsJob = null;
  }
  function scheduleStatistics(target, delay) {
    if (!target || target.countedGeneration === target.editGeneration || !state.active || document.hidden) return;
    if (statisticsJob && statisticsJob.target === target && statisticsJob.generation === target.editGeneration) return;
    cancelStatistics();
    const job = statisticsJob = { target, generation: target.editGeneration, index: 0, count: 0, characters: 0,
      inWord: false, joiner: false, line: '', lineIndex: 0, unicodeWord: /[\p{L}\p{N}]/u };
    statisticsTimer = setTimeout(() => {
      statisticsTimer = 0;
      if (statisticsJob !== job || target !== state.current || !state.active || document.hidden || editorInputPending()) { cancelStatistics(); return; }
      job.source = editorSnapshot().value;
      const step = () => {
        statisticsFrame = 0;
        if (statisticsJob !== job || target !== state.current || target.editGeneration !== job.generation || !state.active || document.hidden) return;
        const deadline = performance.now() + 4;
        let processed = 0;
        while (job.lineIndex < job.line.length || job.index < job.source.length) {
          if (job.lineIndex >= job.line.length) {
            const end = job.source.indexOf('\n', job.index);
            const to = end < 0 ? job.source.length : end;
            const line = job.source.slice(job.index, to);
            job.line = line.includes('<!--relatum:image-text:') ? visibleNoteSource(line) : line;
            if (end >= 0) job.line += '\n';
            job.lineIndex = 0; job.index = end < 0 ? job.source.length : end + 1;
            if (!job.line.length) continue;
          }
          const code = job.line.codePointAt(job.lineIndex);
          const size = code > 0xffff ? 2 : 1;
          job.characters += size; job.lineIndex += size;
          if (isCjkCodePoint(code)) {
            if (job.inWord) job.count += 1;
            job.count += 1; job.inWord = false; job.joiner = false;
          } else {
            const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
              || (code > 127 && job.unicodeWord.test(String.fromCodePoint(code)));
            const joiner = code === 39 || code === 0x2019 || code === 45 || code === 95;
            if (word) { job.inWord = true; job.joiner = false; }
            else if (joiner && job.inWord && !job.joiner) job.joiner = true;
            else { if (job.inWord) job.count += 1; job.inWord = false; job.joiner = false; }
          }
          if (++processed % 256 === 0 && performance.now() >= deadline) { statisticsFrame = requestAnimationFrame(step); return; }
        }
        target.wordCount = job.count + (job.inWord ? 1 : 0); target.characterCount = job.characters;
        target.countedGeneration = job.generation; statisticsJob = null;
        updateDocumentStats(null, target.characterCount, target.wordCount);
      };
      statisticsFrame = requestAnimationFrame(step);
    }, delay == null ? 500 : delay);
  }
  function updateDocumentStats(value, knownLength, knownWords) {
    const statistics = typeof value === 'string' ? noteStatistics(value) : null;
    const characters = Number.isFinite(knownLength) ? knownLength : statistics ? statistics.characters : 0;
    const words = Number.isFinite(knownWords) ? knownWords : statistics ? statistics.words : null;
    if (wordCountEl && (statistics || knownWords !== undefined)) wordCountEl.textContent = tr('words', { count: Number.isFinite(words) ? words.toLocaleString() : '—' });
    if (characterCountEl) characterCountEl.textContent = tr('characters', { count: Math.max(0, characters).toLocaleString() });
  }
  function desktopDirty(value) { if (window.CanvasDesktop && typeof window.CanvasDesktop.setDirty === 'function') window.CanvasDesktop.setDirty(!!value || !!window.RelatumNoteCanvas?.dirty); }
  async function request(url, options) {
    let response;
    try { response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {})); }
    catch (cause) { const error = new Error(language() === 'en' ? 'Local service is unavailable' : '无法连接本地服务'); error.cause = cause; error.code = cause && cause.name === 'AbortError' ? 'aborted' : 'network_error'; throw error; }
    let data = null; try { data = await response.json(); } catch (error) {}
    if (!response.ok) { const error = new Error((data && data.error) || (language() === 'en' ? 'Request failed' : '请求失败')); error.status = response.status; error.code = data && data.code; throw error; }
    return data || {};
  }
  function isMissingError(error) { return !!error && (error.status === 404 || error.code === 'not_found'); }
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
  function closeContextMenu() {
    bodyMenuContext = null; bodyMenuParent = null;
    if (bodyMenuSubmenu) bodyMenuSubmenu.remove();
    bodyMenuSubmenu = null;
    if (contextMenu) { contextMenu.hidden = true; contextMenu.dataset.source = ''; contextMenu.replaceChildren(); }
  }
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
  function sameTreeStructure(previous, next) {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
      const left = previous[index]; const right = next[index];
      if (left.path !== right.path || left.name !== right.name || left.kind !== right.kind) return false;
      if (left.kind === 'folder' && !sameTreeStructure(left.children || [], right.children || [])) return false;
    }
    return true;
  }
  function folderPaths() { return flattenEntries(visibleTreeEntries(), []).filter((entry) => entry.kind === 'folder').map((entry) => entry.path); }
  function updateExpandAllButton() {
    if (!expandAllButton) return;
    const paths = folderPaths();
    const anyExpanded = paths.some((path) => state.expanded.has(path));
    const label = tr(anyExpanded ? 'collapseAll' : 'expandAll');
    expandAllButton.disabled = !paths.length || !noteActionAvailable('toggle-all-folders');
    expandAllButton.dataset.allExpanded = anyExpanded ? 'true' : 'false';
    expandAllButton.dataset.uiTooltip = label;
    expandAllButton.setAttribute('aria-label', label);
    expandAllButton.setAttribute('aria-pressed', anyExpanded ? 'true' : 'false');
  }
  function toggleAllFolders() {
    const paths = folderPaths();
    if (!paths.length) return false;
    const collapse = paths.some((path) => state.expanded.has(path));
    if (collapse) paths.forEach((path) => state.expanded.delete(path));
    else paths.forEach((path) => state.expanded.add(path));
    persistExpanded(); renderTree();
    return true;
  }
  function rebuildEntryIndex(flat) { state.entryIndex = new Map((flat || flattenEntries(state.entries, [])).map((entry) => [entry.path, entry])); }
  function findEntry(path) { return state.entryIndex.get(path) || null; }
  function folderTarget() {
    if (state.notebookRoot === null) return null;
    if (state.rootTargeted) return state.notebookRoot;
    if (state.selectedFolder && findEntry(state.selectedFolder) && notebookRootForPath(state.selectedFolder) === state.notebookRoot) return state.selectedFolder;
    return state.current && notebookRootForPath(state.current.path) === state.notebookRoot ? parentPath(state.current.path) : state.notebookRoot;
  }
  function treeIcon(kind) {
    return noteIcon(kind === 'folder' ? 'folder' : 'file-text', 'note-tree-icon ' + (kind === 'folder' ? 'is-folder' : 'is-note'));
  }
  function naturalSort(entries) { entries.sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, language(), { numeric: true, sensitivity: 'base' })); }
  function makeDocument(data) {
    const generation = ++state.documentGeneration;
    const entry = findEntry(data.path);
    const content = data.content || '';
    return {
      path: data.path, content, revision: data.revision || '', outgoing: [], backlinks: [],
      hasImageText: content.includes('<!--relatum:image-text:'),
      editGeneration: generation, persistedGeneration: generation, selectionStart: 0, selectionEnd: 0, scrollTop: 0,
      wordCount: null, characterCount: content.length, countedGeneration: 0,
      treeModifiedNs: entry && entry.modifiedNs || 0, treeSize: entry && entry.size || 0,
    };
  }
  function cacheDocument(documentState) {
    if (!documentState || !documentState.path) return;
    state.documentCache.delete(documentState.path);
    state.documentCache.set(documentState.path, documentState);
    let bytes = Array.from(state.documentCache.values()).reduce((sum, item) => sum + item.content.length * 2, 0);
    if (state.documentCache.size <= DOCUMENT_CACHE_LIMIT && bytes <= DOCUMENT_CACHE_BYTES) return;
    for (const [path, candidate] of state.documentCache) {
      if (state.documentCache.size <= DOCUMENT_CACHE_LIMIT && bytes <= DOCUMENT_CACHE_BYTES) break;
      if (candidate === state.current || hasPendingEdits(candidate)) continue;
      state.documentCache.delete(path);
      bytes -= candidate.content.length * 2;
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
    documentState.hasImageText = snapshot.value.includes('<!--relatum:image-text:');
    documentState.selectionStart = snapshot.anchor || 0;
    documentState.selectionEnd = snapshot.head ?? snapshot.anchor ?? 0;
    documentState.scrollTop = snapshot.scrollTop || 0;
    rememberViewState(documentState.path, snapshot);
    scheduleStatistics(documentState);
    cacheDocument(documentState);
    updateDocumentStats(null, documentState.characterCount, documentState.wordCount);
  }
  function renderCurrentPath(path) {
    currentPathEl.replaceChildren();
    if (!path) { currentPathEl.textContent = tr('select'); currentPathEl.title = ''; return; }
    currentPathEl.title = path;
    const parts = String(path).split('/').filter(Boolean);
    const notebookPath = notebookRootForPath(path);
    const rootPart = document.createElement('span'); rootPart.className = 'note-path-crumb is-root'; rootPart.textContent = notebookPath ? parts[1] : 'notes'; currentPathEl.appendChild(rootPart);
    if (notebookPath) parts.splice(0, 2);
    parts.forEach((part, index) => {
      const separator = noteIcon('chevron-right', 'note-path-separator');
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
        close.type = 'button'; close.className = 'note-tab-close'; close.appendChild(noteIcon('x'));
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
    if (noteMovePromise) await waitForNoteMove();
    if (!(await flushCanvases())) return false;
    if (noteBrowser) noteBrowser.showDocument();
    const previous = state.current;
    if (previous && editorInputPending()) await whenEditorInputSettled();
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
    if (noteMovePromise) tabPath = await waitForNoteMove(tabPath);
    if (!tabPath || !state.tabs.includes(tabPath)) return false;
    if (isBlankTab(tabPath)) {
      if (!(await flushCanvases())) return false;
      if (noteBrowser) noteBrowser.showDocument();
      const previous = state.current;
      if (previous && editorInputPending()) await whenEditorInputSettled();
      rememberEditorState(previous);
      if (previous && !(options && options.skipSave)) flushSave(previous);
      state.activeTab = tabPath;
      persistTabs();
      clearCurrent({ keepTabs: true, keepActiveTab: true, keepCache: true });
      return true;
    }
    return openNote(tabPath, { reuseActiveTab: false, skipSave: !!(options && options.skipSave), noFocus: !!(options && options.noFocus), preserveNotebook: !!options?.preserveNotebook });
  }
  async function closeTab(tabPath, options) {
    if (noteMovePromise) tabPath = await waitForNoteMove(tabPath);
    if (!(await flushCanvases())) return false;
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
  function clearTreeRowIndex(host) {
    const index = treeRowIndexes.get(host);
    index.rows.clear(); index.selectionPaths = new Set(); index.selectionKey = null;
  }
  function updateTreeSelection() {
    const activePath = state.openingPath || (state.current && state.current.path) || '';
    const key = JSON.stringify([activePath, state.openingPath, state.selectedFolder, state.notebookRoot]);
    if (treeRowIndexes.get(treeEl).selectionKey === key
        && (!notebookTreeEl || treeRowIndexes.get(notebookTreeEl).selectionKey === key)) return;
    const nextPaths = new Set([activePath, state.selectedFolder]);
    if (state.notebookRoot !== null) nextPaths.add(state.notebookRoot);
    for (let path = parentPath(activePath); path; path = parentPath(path)) nextPaths.add(path);
    treeRowIndexes.forEach((index, host) => {
      if (index.selectionKey === key) return;
      const changedPaths = new Set([...index.selectionPaths, ...nextPaths]);
      changedPaths.forEach((path) => {
        const row = index.rows.get(path);
        if (!row) return;
        const entry = findEntry(path);
        const active = !!activePath && path === activePath;
        row.classList.toggle('active', active);
        if (active) { if (row.getAttribute('aria-current') !== 'page') row.setAttribute('aria-current', 'page'); }
        else if (row.hasAttribute('aria-current')) row.removeAttribute('aria-current');
        row.classList.toggle('opening', !!state.openingPath && path === state.openingPath);
        row.classList.toggle('selected-folder', !!entry && entry.kind === 'folder' && path === state.selectedFolder);
        row.classList.toggle('active-ancestor', !!entry && entry.kind === 'folder' && !!activePath && activePath.startsWith(path + '/'));
        if (host === notebookTreeEl && row.parentElement?.classList.contains('note-notebook-root')) {
          row.classList.toggle('selected-notebook', path === state.notebookRoot);
        }
      });
      index.selectionPaths = nextPaths;
      index.selectionKey = key;
    });
  }
  function scheduleDocumentPrefetch() {
    clearTimeout(state.prefetchTimer);
    if (!state.active || document.hidden || noteMovePromise) return;
    state.prefetchTimer = setTimeout(runDocumentPrefetch, 350);
  }
  function stopDocumentPrefetch() {
    prefetchEpoch += 1; clearTimeout(state.prefetchTimer); clearTimeout(hoverPrefetchTimer);
    state.prefetchTimer = 0; hoverPrefetchTimer = 0; hoverPrefetchPath = '';
  }
  async function runDocumentPrefetch() {
    state.prefetchTimer = 0;
    if (prefetchRunning || !state.active || document.hidden || editorInputPending() || noteMovePromise) return;
    const epoch = prefetchEpoch;
    const viewport = treeEl.getBoundingClientRect();
    const paths = Array.from(treeEl.querySelectorAll('.note-tree-row')).filter((row) => {
      const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    }).map((row) => row.dataset.notePath);
    if (hoverPrefetchPath) paths.unshift(hoverPrefetchPath);
    const candidates = Array.from(new Set(paths)).map(findEntry).filter((entry) => entry && entry.kind === 'note'
      && Number(entry.size || 0) <= 512 * 1024 && !state.documentCache.has(entry.path)).slice(0, 4);
    prefetchRunning = true;
    try {
      for (const entry of candidates) {
        if (epoch !== prefetchEpoch || !state.active || document.hidden || editorInputPending()) break;
        if (state.documentCache.has(entry.path)) continue;
        try {
          const data = await fetchDocument(entry.path);
          if (epoch === prefetchEpoch && state.active && !document.hidden && !state.documentCache.has(entry.path)
              && findEntry(entry.path)?.modifiedNs === entry.modifiedNs) cacheDocument(makeDocument(data));
        } catch (error) {}
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally { prefetchRunning = false; }
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

  function beginInlineRename(path) { const entry = findEntry(path); if (!entry || !path || isNotebookContainer(path)) return; selectNotebook(notebookRootForPath(path)); state.renamePath = path; state.renameOriginal = entry.kind === 'note' ? noteTitle(path) : entry.name; state.renameDraft = state.renameOriginal; state.renameError = ''; renderTree(); }
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
    const input = root.querySelector('.note-tree-rename');
    if (!entry || !input) return false;
    await commitInlineRename(entry, input, false);
    return !state.renamePath;
  }
  function renderTree(options) {
    if (!options?.entryIndexReady) rebuildEntryIndex();
    renderTreeInto(treeEl, visibleTreeEntries(), state.expanded, false);
    state.treeRendered = true;
    state.renderedOrder = options?.orderSignature ?? treeOrderSignature(state.entries);
    state.pendingTreeReorder = false;
    updateNotebookRootLabel();
    if (!options?.keepNotebookTree) { state.notebookTreeDirty = true; renderNotebookTree(); }
  }
  function renderNotebookTree() {
    if (!notebookTreeEl || !root.classList.contains('links-overlay-open') || state.sideMode !== 'notebooks') return;
    if (state.notebookTreeDirty) {
      renderTreeInto(notebookTreeEl, notebookRoots(), state.notebookExpanded, true);
      state.notebookTreeDirty = false;
    }
    updateNotebookSelection(); updateNotebookExpandButton();
  }
  function renderTreeInto(treeEl, treeEntries, expandedPaths, notebookTree) {
    clearTreeRowIndex(treeEl);
    const rowIndex = treeRowIndexes.get(treeEl);
    const fragment = document.createDocumentFragment();
    const getEntry = (path) => notebookTree && (path === '' || isNotebookRoot(path)) ? notebookRoots().find((entry) => entry.path === path) : findEntry(path);
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const folderLabel = (entry, expanded) => entry.path + ' · ' + tr(expanded ? 'collapseFolder' : 'expandFolder');
    const directChild = (wrapper, className) => Array.from(wrapper.children).find((child) => child.classList && child.classList.contains(className)) || null;
    const liveWrapper = (path) => rowIndex.rows.get(path)?.parentElement || null;

    function removeChildrenShell(shell) {
      shell.querySelectorAll('.note-tree-row').forEach((row) => {
        if (rowIndex.rows.get(row.dataset.notePath) === row) rowIndex.rows.delete(row.dataset.notePath);
      });
      rowIndex.selectionKey = null;
      shell.remove();
    }

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
          if (!shell.isConnected || !expandedPaths.has(entry.path)) return;
          shell.classList.add('is-open', 'is-expanding'); shell.setAttribute('aria-hidden', 'false');
          window.setTimeout(() => shell.classList.remove('is-expanding'), TREE_MOTION_MS + 80);
        });
      }
      return shell;
    }

    function setFolderExpanded(path, expanded) {
      const entry = getEntry(path); const wrapper = liveWrapper(path);
      if (!entry || entry.kind !== 'folder' || !wrapper) return;
      const row = directChild(wrapper, 'note-tree-row');
      if (!row) return;
      if (expanded) expandedPaths.add(path); else expandedPaths.delete(path);
      if (notebookTree) { queueNotebookSettings({ ui: notebookUi() }); updateNotebookExpandButton(); } else { persistExpanded(); updateExpandAllButton(); }
      row.setAttribute('aria-expanded', expanded ? 'true' : 'false'); row.setAttribute('aria-label', folderLabel(entry, expanded));
      row.classList.toggle('is-expanding', expanded); window.setTimeout(() => row.classList.remove('is-expanding'), TREE_MOTION_MS + 40);
      let shell = directChild(wrapper, 'note-tree-children-shell');
      if (expanded) {
        if (!shell) shell = createChildrenShell(entry, Number(wrapper.style.getPropertyValue('--note-depth')) || 0, wrapper, !reducedMotion());
        if (shell && reducedMotion()) { shell.classList.add('is-open'); shell.setAttribute('aria-hidden', 'false'); }
        else if (shell) {
          shell.inert = false; shell.classList.remove('is-collapsing'); void shell.offsetHeight;
          requestAnimationFrame(() => {
            if (!expandedPaths.has(path)) return;
            shell.classList.add('is-open', 'is-expanding'); shell.setAttribute('aria-hidden', 'false');
            window.setTimeout(() => shell.classList.remove('is-expanding'), TREE_MOTION_MS + 80);
          });
        }
      } else if (shell) {
        shell.classList.remove('is-open', 'is-expanding'); shell.classList.add('is-collapsing'); shell.setAttribute('aria-hidden', 'true'); shell.inert = true;
        if (reducedMotion()) removeChildrenShell(shell);
        else window.setTimeout(() => { if (shell.isConnected && !expandedPaths.has(path)) removeChildrenShell(shell); }, TREE_MOTION_MS + 40);
      }
      updateTreeSelection();
    }

    function renderLevel(entries, depth, host) { (notebookTree && depth === 0 ? entries : sortedTreeEntries(entries)).forEach((entry) => {
      const wrapper = document.createElement('div'); wrapper.className = 'note-tree-entry'; wrapper.dataset.path = entry.path; wrapper.style.setProperty('--note-depth', depth);
      if (entry.notebook) wrapper.classList.add('note-notebook-root');
      const row = document.createElement('button'); row.type = 'button'; row.className = 'note-tree-row'; row.style.setProperty('--note-depth', depth); row.draggable = !notebookTree && state.renamePath !== entry.path; row.dataset.notePath = entry.path;
      rowIndex.rows.set(entry.path, row); rowIndex.selectionKey = null;
      row.title = entry.path; row.setAttribute('aria-label', entry.path);
      const toggle = document.createElement('span'); toggle.className = 'note-tree-toggle'; toggle.setAttribute('aria-hidden', 'true');
      if (entry.kind === 'folder') { const expanded = expandedPaths.has(entry.path); row.setAttribute('aria-expanded', expanded ? 'true' : 'false'); row.setAttribute('aria-label', folderLabel(entry, expanded)); }
      const label = document.createElement('span'); label.className = 'note-tree-label';
      if (entry.path && state.renamePath === entry.path) {
        const input = document.createElement('input'); input.className = 'note-tree-rename'; input.value = state.renameDraft === null ? state.renameOriginal : state.renameDraft; input.setAttribute('aria-label', tr('rename')); label.appendChild(input);
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitInlineRename(entry, input, false); } else if (event.key === 'Escape') { event.preventDefault(); commitInlineRename(entry, input, true); } });
        input.addEventListener('blur', () => commitInlineRename(entry, input, false)); requestAnimationFrame(() => { input.focus(); input.select(); });
      } else label.textContent = entry.name;
      row.append(toggle, entry.notebook ? notebookIcon(entry.path) : treeIcon(entry.kind), label);
      async function activateRow(expansion) {
        const clickedPath = entry.path;
        if (!(await finishInlineTitle())) return;
        if (state.renamePath && !(await finishInlineRename())) return;
        if (editorInputPending()) await whenEditorInputSettled();
        closeContextMenu(); const liveEntry = getEntry(clickedPath); if (!liveEntry) return;
        if (notebookTree) selectNotebook(liveEntry.notebook ? liveEntry.path : notebookRootForPath(liveEntry.path), { rootTarget: !!liveEntry.notebook });
        state.rootTargeted = !!liveEntry.notebook; state.selectedPath = liveEntry.path;
        if (liveEntry.kind === 'folder') {
          state.selectedFolder = liveEntry.path;
          if (!liveEntry.notebook || expansion !== null) {
            const expanded = typeof expansion === 'boolean' ? expansion : !expandedPaths.has(liveEntry.path);
            if (expanded !== expandedPaths.has(liveEntry.path)) setFolderExpanded(liveEntry.path, expanded);
          }
          if (notebookTree && !liveEntry.notebook && expandTreePath(liveEntry.path, false)) renderTree({ keepNotebookTree: true });
          updateTreeSelection();
        } else { state.selectedFolder = parentPath(liveEntry.path); state.openingPath = liveEntry.path; renderCurrentPath(liveEntry.path); updateTreeSelection(); openNote(liveEntry.path, { selectionPrimed: true }); }
      }
      row.addEventListener('click', (event) => activateRow(entry.notebook && !toggle.contains(event.target) ? null : undefined));
      if (entry.notebook && entry.path) label.addEventListener('dblclick', async (event) => {
        if (event.target.closest('input')) return;
        event.preventDefault(); event.stopPropagation();
        if (!(await finishInlineTitle()) || state.renamePath && !(await finishInlineRename())) return;
        if (editorInputPending()) await whenEditorInputSettled();
        if (state.active && state.sideMode === 'notebooks' && root.classList.contains('links-overlay-open') && findEntry(entry.path)?.kind === 'folder') beginInlineRename(entry.path);
      });
      if (entry.notebook) row.addEventListener('keydown', (event) => {
        if (event.target !== row || event.isComposing || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
        event.preventDefault(); event.stopPropagation(); activateRow(event.key === 'ArrowRight');
      });
      row.addEventListener('pointerenter', () => {
        if (entry.kind !== 'note' || Number(entry.size || 0) > 512 * 1024 || state.documentCache.has(entry.path)) return;
        clearTimeout(hoverPrefetchTimer);
        hoverPrefetchTimer = setTimeout(() => { hoverPrefetchPath = entry.path; runDocumentPrefetch(); }, 150);
      });
      row.addEventListener('pointerleave', () => { clearTimeout(hoverPrefetchTimer); hoverPrefetchPath = ''; });
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); if (entry.notebook) { openNotebookContext(entry, event.clientX, event.clientY); return; } if (notebookTree) selectNotebook(notebookRootForPath(entry.path)); state.rootTargeted = false; state.selectedPath = entry.path; state.selectedFolder = entry.kind === 'folder' ? entry.path : parentPath(entry.path); updateTreeSelection(); openContextMenu(entry, event.clientX, event.clientY); });
      row.addEventListener('dragstart', (event) => { state.draggedPath = entry.path; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-relatum-note-path', entry.path); });
      row.addEventListener('dragend', () => { state.draggedPath = ''; row.classList.remove('dragging'); root.querySelectorAll('.note-drop-target').forEach((item) => item.classList.remove('note-drop-target')); });
      row.addEventListener('dragover', (event) => { if (notebookTree) return; const external = !state.draggedPath && Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file'); if (!state.draggedPath && !external) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = external ? 'copy' : 'move'; row.classList.add('note-drop-target'); });
      row.addEventListener('dragleave', () => row.classList.remove('note-drop-target'));
      row.addEventListener('drop', (event) => { if (notebookTree) return; event.preventDefault(); event.stopPropagation(); row.classList.remove('note-drop-target'); const destination = entry.kind === 'folder' ? entry.path : parentPath(entry.path); if (state.draggedPath) moveEntry(state.draggedPath, destination); else importDataTransfer(event.dataTransfer, destination); });
      wrapper.appendChild(row);
      if (entry.path && state.renamePath === entry.path && state.renameError) { const error = document.createElement('small'); error.className = 'note-tree-inline-error'; error.textContent = state.renameError; wrapper.appendChild(error); }
      if (entry.kind === 'folder' && expandedPaths.has(entry.path)) createChildrenShell(entry, depth, wrapper, false);
      host.appendChild(wrapper);
    }); }
    renderLevel(treeEntries, 0, fragment);
    if (!fragment.childNodes.length && (notebookTree || state.notebookRoot !== null)) { const message = document.createElement('p'); message.className = 'note-tree-empty'; message.textContent = tr('emptyTree'); fragment.appendChild(message); }
    treeEl.replaceChildren(fragment); updateTreeSelection(); if (!notebookTree) updateExpandAllButton();
  }
  function samePathList(left, right) {
    return left.length === right.length && left.every((path, index) => path === right[index]);
  }
  function removeTreeEntry(entries, targetPath) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.path === targetPath) { entries.splice(index, 1); return true; }
      if (entry.kind === 'folder' && removeTreeEntry(entry.children || [], targetPath)) return true;
    }
    return false;
  }
  async function reconcileExternalTree(previousTabs) {
    const oldTabs = Array.isArray(previousTabs) ? previousTabs : state.tabs.slice();
    const oldActivePath = state.activeTab || (state.current && state.current.path) || '';
    const oldActiveIndex = Math.max(0, oldTabs.indexOf(oldActivePath));
    const isLiveTab = (path) => isBlankTab(path) || !!findEntry(path);
    const nextTabs = oldTabs.filter(isLiveTab);
    const currentMissing = !!state.current && !findEntry(state.current.path);
    const openingMissing = !!state.openingPath && !findEntry(state.openingPath);

    Array.from(state.documentCache.keys()).forEach((path) => {
      if (!findEntry(path)) state.documentCache.delete(path);
    });
    state.tabs = nextTabs;

    if (openingMissing) {
      state.openSeq += 1;
      state.openingPath = '';
      setDocumentSwitchPending(false);
    }
    if (!currentMissing) {
      if (state.current && !state.tabs.includes(state.current.path)) {
        state.tabs.splice(Math.min(oldActiveIndex, state.tabs.length), 0, state.current.path);
      }
      if (!state.tabs.includes(state.activeTab)) state.activeTab = state.current && state.current.path || state.tabs[0] || '';
      if (!samePathList(oldTabs, state.tabs) || openingMissing) {
        persistTabs();
        renderTabs();
        updateTreeSelection();
      }
      return false;
    }

    const removedDocument = state.current;
    clearTimeout(state.saveTimer);
    clearTimeout(state.retryTimer);
    if (removedDocument) removedDocument.persistedGeneration = removedDocument.editGeneration;
    const after = oldTabs.slice(oldActiveIndex + 1).find(isLiveTab);
    const before = oldTabs.slice(0, oldActiveIndex).reverse().find(isLiveTab);
    const nextPath = after || before || state.tabs[0] || '';
    state.activeTab = nextPath;
    closeContextMenu();
    clearCurrent({ keepTabs: true, keepActiveTab: !!nextPath });
    if (nextPath) await activateTab(nextPath, { skipSave: true, noFocus: true, preserveNotebook: true });
    return true;
  }
  async function refreshTree(announce, options) {
    if (noteMovePromise) return false;
    const seq = ++state.refreshSeq; if (!state.initialized) treeEl.textContent = tr('loading');
    try {
      const result = await request('/api/notes-tree' + (state.notebookSettingsLoaded ? '' : '?notebookSettings=1')); if (seq !== state.refreshSeq || noteMovePromise) return false;
      const entries = Array.isArray(result.entries) ? result.entries : [];
      const flat = flattenEntries(entries, []);
      const signature = JSON.stringify(flat.map((entry) => [entry.path, entry.modifiedNs, entry.size]));
      const browserChanged = signature !== state.treeMetadataSignature;
      if (signature !== state.treeMetadataSignature) { state.externalSyncUnchanged = 0; state.treeMetadataSignature = signature; }
      else if (options && options.background) state.externalSyncUnchanged = Math.min(EXTERNAL_SYNC_DELAYS.length - 1, state.externalSyncUnchanged + 1);
      const structureChanged = !state.treeRendered || !sameTreeStructure(state.entries, entries);
      const orderSignature = treeOrderSignature(entries);
      const orderChanged = state.renderedOrder !== orderSignature;
      const previousTabs = state.tabs.slice();
      // Always refresh metadata for cache validation; unchanged rows retain focus,
      // inline rename drafts and any folder transition already in progress.
      state.entries = entries;
      rebuildEntryIndex(flat);
      if (!state.notebookSettingsLoaded) restoreNotebookSettings(result.notebookSettings);
      const previousNotebookRoot = state.notebookRoot;
      const notebookMissing = reconcileNotebooks();
      let prunedRecent = false;
      recentFiles.forEach((time, path) => { if (!state.entryIndex.has(path)) { recentFiles.delete(path); prunedRecent = true; } });
      if (prunedRecent) persistRecent();
      if (browserChanged && noteBrowser) noteBrowser.invalidate();
      state.documentCache.forEach((documentState, path) => { const entry = findEntry(path); if (!entry) { if (state.current !== documentState) state.documentCache.delete(path); return; } if (state.current !== documentState && documentState.treeModifiedNs && (documentState.treeModifiedNs !== entry.modifiedNs || documentState.treeSize !== entry.size)) state.documentCache.delete(path); });
      const folders = new Set(flat.filter((entry) => entry.kind === 'folder').map((entry) => entry.path));
      state.expanded.forEach((path) => { if (!folders.has(path)) state.expanded.delete(path); });
      if (state.selectedFolder && !folders.has(state.selectedFolder)) state.selectedFolder = '';
      if (state.selectedPath && !state.entryIndex.has(state.selectedPath)) state.selectedPath = '';
      if (structureChanged || orderChanged || previousNotebookRoot !== state.notebookRoot) {
        if (state.renamePath && !structureChanged) state.pendingTreeReorder = true;
        else renderTree({ entryIndexReady: true, orderSignature });
      }
      await reconcileExternalTree(previousTabs);
      if (notebookMissing) selectNotebook('', { rootTarget: true });
      if (structureChanged) scheduleDocumentPrefetch();
      if (announce) showToast(tr('refreshed'));
      return true;
    }
    catch (error) {
      if (seq === state.refreshSeq && !state.treeRendered) treeEl.textContent = error.message || tr('readFailed');
      if (!(options && options.silentErrors)) showToast(error.message || tr('readFailed'), 'error');
      return false;
    }
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
  async function ensureLinks() {
    if (!state.current) return false;
    const documentState = state.current; const path = documentState.path; const revision = documentState.revision;
    const seq = ++state.linksSeq;
    try {
      const result = await request('/api/note-links?path=' + encodeURIComponent(path));
      if (seq !== state.linksSeq || state.current !== documentState || documentState.path !== path) return false;
      documentState.outgoing = result.outgoing || []; documentState.backlinks = result.backlinks || [];
      if (documentState.revision === revision) documentState.linksRefreshNeeded = false;
      renderLinks(); return true;
    } catch (error) { return false; }
  }
  function cancelLinksRefresh() {
    clearTimeout(state.linksRefreshTimer);
    state.linksRefreshTimer = 0;
  }
  function linksRefreshVisible(documentState) {
    return !!documentState && state.current === documentState && state.active && !document.hidden
      && !state.linksRefreshSuspended && !state.openingPath && !noteMovePromise
      && state.sideMode === 'links' && root.classList.contains('links-overlay-open');
  }
  function scheduleLinksRefresh(documentState) {
    cancelLinksRefresh();
    if (documentState) documentState.linksRefreshNeeded = true;
    if (!linksRefreshVisible(documentState)) return;
    const timer = setTimeout(() => {
      if (state.linksRefreshTimer !== timer) return;
      state.linksRefreshTimer = 0;
      if (documentState.linksRefreshNeeded && linksRefreshVisible(documentState)) ensureLinks();
    }, 500);
    state.linksRefreshTimer = timer;
  }
  function resumeLinksRefresh() {
    if (state.current?.linksRefreshNeeded) scheduleLinksRefresh(state.current);
  }
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
    updateImageTextTools();
  }
  function setDocumentSwitchPending(active) {
    root.classList.toggle('note-document-switch-pending', !!active);
    if (editorHost) editorHost.toggleAttribute('inert', !!active);
    if (fallbackEditor) fallbackEditor.toggleAttribute('inert', !!active);
    if (readingHost) readingHost.toggleAttribute('inert', !!active);
  }
  function setNoteMoveInputLocked(locked) {
    $('.note-document-body')?.toggleAttribute('inert', locked || root.classList.contains('note-browser-showing-results'));
  }

  function applyDocument(data, options) {
    cancelLinksRefresh();
    closeContextMenu(); resetExternalSyncActivity(); cancelStatistics();
    state.imageTextCleanupPath = '';
    const preservedView = options && options.preserveViewState && state.current && state.current.path === data.path
      ? editorSnapshot()
      : viewStates.get(data.path);
    clearTimeout(state.saveTimer); clearTimeout(state.retryTimer); state.editGeneration += 1;
    const documentState = typeof data.editGeneration === 'number' ? data : makeDocument(data);
    if (preservedView) {
      const end = documentState.content.length;
      documentState.selectionStart = Math.max(0, Math.min(end, Number(preservedView.anchor) || 0));
      documentState.selectionEnd = Math.max(0, Math.min(end, Number(preservedView.head) || 0));
      documentState.scrollTop = Math.max(0, Number(preservedView.scrollTop) || 0);
    }
    rememberViewState(documentState.path, {
      anchor: documentState.selectionStart, head: documentState.selectionEnd, scrollTop: documentState.scrollTop,
    });
    setDocumentSwitchPending(false);
    state.current = documentState; cacheDocument(documentState); state.openingPath = '';
    if (!state.tabs.includes(documentState.path)) selectNoteTab(documentState.path, true);
    else if (state.activeTab !== documentState.path) { state.activeTab = documentState.path; persistTabs(); }
    setEditorDocument(documentState);
    renderCurrentPath(documentState.path);
    if (!state.rootTargeted) { state.selectedPath = documentState.path; state.selectedFolder = parentPath(documentState.path); }
    renderInlineTitle(documentState.path, true); updateDocumentStats(null, documentState.characterCount, documentState.wordCount); renderTabs();
    const treeExpanded = state.notebookRoot === notebookRootForPath(documentState.path) && expandTreePath(documentState.path, false);
    clearSaveError(); desktopDirty(hasPendingEdits(documentState));
    try { localStorage.setItem(ACTIVE_PATH_KEY, documentState.path); } catch (error) {}
    if (treeExpanded) renderTree({ keepNotebookTree: true }); else updateTreeSelection(); renderLinks(); updateEditorVisibility();
    if (root.classList.contains('links-overlay-open') && state.sideMode === 'links') ensureLinks();
    scheduleStatistics(documentState); scheduleDocumentPrefetch();
  }
  function clearCurrent(options) { cancelLinksRefresh(); clearTimeout(state.saveTimer); const oldPath = state.current && state.current.path; if (oldPath) window.RelatumNoteCanvas?.releaseNote(oldPath); state.openSeq += 1; state.editGeneration += 1; state.openingPath = ''; setDocumentSwitchPending(false); state.current = null; if (oldPath && !(options && options.keepCache)) state.documentCache.delete(oldPath); if (oldPath && !(options && options.keepTabs)) state.tabs = state.tabs.filter((path) => path !== oldPath); if (!(options && options.keepActiveTab)) state.activeTab = ''; persistTabs(); setEditorDocument(null); renderCurrentPath(''); renderInlineTitle('', true); clearSaveError(); desktopDirty(false); try { localStorage.removeItem(ACTIVE_PATH_KEY); } catch (error) {} updateTreeSelection(); renderTabs(); renderLinks(); updateEditorVisibility(); }
  function hasPendingEdits(documentState) { const target = documentState || state.current; return !!target && target.persistedGeneration < target.editGeneration; }
  function scheduleSave(delay) { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => flushSave(undefined, false, true), typeof delay === 'number' ? delay : SAVE_DELAY); }
  function markChanged(meta) {
    if (!state.current) return;
    resetExternalSyncActivity();
    const changeMeta = meta || {};
    state.editGeneration += 1;
    state.current.editGeneration = ++state.documentGeneration;
    if (typeof changeMeta.value === 'string') {
      state.current.content = changeMeta.value;
      state.current.hasImageText = changeMeta.value.includes('<!--relatum:image-text:');
      if (!state.current.hasImageText) state.current.characterCount = changeMeta.value.length;
    }
    if (Number.isFinite(changeMeta.anchor)) state.current.selectionStart = changeMeta.anchor;
    if (Number.isFinite(changeMeta.head)) state.current.selectionEnd = changeMeta.head;
    else if (Number.isFinite(changeMeta.anchor)) state.current.selectionEnd = changeMeta.anchor;
    if (Number.isFinite(changeMeta.scrollTop)) state.current.scrollTop = changeMeta.scrollTop;
    if (Number.isFinite(changeMeta.length) && !state.current.hasImageText) state.current.characterCount = changeMeta.length;
    cacheDocument(state.current);
    if (typeof changeMeta.value === 'string') updateDocumentStats(null, state.current.characterCount, state.current.wordCount);
    else if (Number.isFinite(changeMeta.length) && !state.current.hasImageText) updateDocumentStats(null, changeMeta.length);
    scheduleStatistics(state.current);
    desktopDirty(true);
    scheduleSave();
  }
  async function flushSave(documentState, duringMove, background) {
    if (noteMovePromise && !duringMove) await waitForNoteMove();
    if (!(await flushCanvases(background))) return false;
    if (state.imageTextBusy) return imageTextOperationPromise;
    const target = documentState || state.current;
    if (target && target === state.current && editorInputPending()) await whenEditorInputSettled();
    if (target === state.current) { clearTimeout(state.saveTimer); rememberEditorState(target); }
    if (!target || !hasPendingEdits(target)) return state.saveChain;
    const path = target.path; const generation = target.editGeneration; const content = target.content;
    state.saveChain = state.saveChain.catch(() => false).then(async () => {
      if (target.persistedGeneration >= generation) return true;
      state.saveRunning = true;
      try {
        const result = await post('/api/note-save', { path, content, revision: target.revision });
        target.revision = result.revision || target.revision;
        recordRecent(path); if (noteBrowser) noteBrowser.invalidate();
        target.persistedGeneration = Math.max(target.persistedGeneration, generation);
        if (target.editGeneration <= generation) target.content = content;
        cacheDocument(target);
        if (state.current === target) {
          clearSaveError();
          if (!hasPendingEdits(target)) desktopDirty(false); else scheduleSave(0);
          scheduleLinksRefresh(target);
        }
        return true;
      } catch (error) {
        if (isMissingError(error)) {
          target.persistedGeneration = target.editGeneration;
          state.documentCache.delete(path);
          clearTimeout(state.retryTimer);
          clearSaveError();
          await refreshTree(false, { silentErrors: true });
          return true;
        }
        showSaveError(error.message || tr('saveFailed'));
        desktopDirty(true);
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(() => flushSave(undefined, false, true), RETRY_DELAY);
        return false;
      }
      finally { state.saveRunning = false; }
    });
    const ok = await state.saveChain; if (ok && hasPendingEdits(target)) return flushSave(target, duringMove, background); return ok;
  }
  async function openNote(path, options) {
    if (noteMovePromise) path = await waitForNoteMove(path);
    if (!(await flushCanvases())) return false;
    if (noteBrowser) noteBrowser.showDocument();
    if (state.imageTextBusy && !(await imageTextOperationPromise)) return false;
    if (!path) return false;
    if (state.current && state.current.path !== path && editorInputPending()) await whenEditorInputSettled();
    selectNoteTab(path, !(options && options.reuseActiveTab === false));
    if (!state.restoringNotebookSelection && !options?.preserveNotebook) {
      selectNotebook(notebookRootForPath(path));
      state.rootTargeted = false; state.selectedPath = path; state.selectedFolder = parentPath(path);
    }
    if (state.current && state.current.path === path && !(options && options.force)) { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); renderTabs(); if (!(options && (options.noRecent || options.force))) recordRecent(path); return true; }
    cancelLinksRefresh();
    const previous = state.current; rememberEditorState(previous);
    const seq = ++state.openSeq; state.openingPath = path; state.rootTargeted = false; state.selectedPath = path; state.selectedFolder = parentPath(path);
    renderTabs();
    const treeExpanded = state.notebookRoot === notebookRootForPath(path) && expandTreePath(path, false);
    if (!(options && options.selectionPrimed)) { renderCurrentPath(path); if (treeExpanded) renderTree(); else updateTreeSelection(); }
    const cached = state.documentCache.get(path);
    if (cached && !(options && options.force)) {
      if (!(options && options.skipSave) && previous) flushSave(previous);
      if (previous) await window.RelatumNoteCanvas?.releaseNote(previous.path);
      applyDocument(cached);
      if (!(options && (options.noRecent || options.force))) recordRecent(path);
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current === cached) focusEditor(); });
      return true;
    }
    setDocumentSwitchPending(true);
    const loadPromise = fetchDocument(path);
    if (!(options && options.skipSave) && previous) flushSave(previous);
    try {
      const data = await loadPromise; if (seq !== state.openSeq) return false;
      const shown = state.current && state.current.path === path ? state.current : null;
      if (!shown || (!hasPendingEdits(shown) && shown.revision !== data.revision)) {
        if (previous) await window.RelatumNoteCanvas?.releaseNote(previous.path);
        if (seq !== state.openSeq) return false;
        applyDocument(data);
      }
      else { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); resumeLinksRefresh(); }
      if (!(options && (options.noRecent || options.force))) recordRecent(path);
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current && state.current.path === path) focusEditor(); });
      return true;
    } catch (error) {
      const missing = isMissingError(error);
      if (seq === state.openSeq) {
        state.openingPath = '';
        setDocumentSwitchPending(false);
        updateTreeSelection();
        renderTabs();
        if (error.code !== 'aborted' && !missing) showToast(error.message || tr('readFailed'), 'error');
      }
      if (error.code !== 'aborted') await refreshTree(false, { silentErrors: missing });
      if (seq === state.openSeq) resumeLinksRefresh();
      return false;
    }
  }
  async function createEntry(kind, options) {
    if (noteMovePromise) await waitForNoteMove();
    const parent = options && Object.prototype.hasOwnProperty.call(options, 'parent') ? options.parent : folderTarget();
    if (parent === null) return;
    if (state.current) flushSave(state.current);
    try {
      const payload = { parent, kind, content: options && options.content || '' };
      const hasExplicitName = !!(options && options.name);
      if (hasExplicitName) {
        payload.name = options.name;
        payload.createParents = !!options.createParents;
      } else {
        payload.autoName = kind === 'folder' ? 'folder' : state.newName.mode === 'custom' ? 'custom' : 'timestamp';
        if (payload.autoName === 'custom') payload.name = state.newName.baseName;
        payload.language = language();
      }
      const result = await post('/api/note-create', payload);
      if (kind === 'note' && noteBrowser) noteBrowser.showDocument();
      state.entries = result.tree && result.tree.entries || state.entries;
      rebuildEntryIndex();
      selectNotebook(notebookRootForPath(result.path), { noRender: true });
      state.rootTargeted = false; state.selectedPath = result.path;
      if (kind === 'folder') {
        state.selectedFolder = result.path;
        expandTreePath(result.path, true);
        renderTree();
        beginInlineRename(result.path);
      } else {
        state.selectedFolder = parentPath(result.path);
        expandTreePath(result.path, false);
        renderTree();
        // A newly created file may reuse a deleted note's name, but not its position.
        if (viewStates.delete(result.path)) viewStatesDirty = true;
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
    while (noteMovePromise) {
      const paths = noteMovePaths;
      if (await noteMovePromise && paths) {
        source = mapPath(source, paths.source, paths.destination);
        destination = mapPath(destination, paths.source, paths.destination);
      }
    }
    const operation = performMove(source, destination, quiet);
    noteMovePromise = operation;
    noteMovePaths = { source, destination };
    try { return await operation; }
    finally {
      if (noteMovePromise === operation) {
        noteMovePromise = null; noteMovePaths = null;
        setNoteMoveInputLocked(false);
        refreshTree(false, { silentErrors: true });
        scheduleExternalSync();
        scheduleDocumentPrefetch();
      }
    }
  }
  async function syncMovedDocument(renamed) {
    const current = state.current;
    if (!current) return;
    const path = current.path, generation = current.editGeneration;
    const disk = await request('/api/note?path=' + encodeURIComponent(path));
    if (state.current !== current || current.path !== path || current.editGeneration !== generation || hasPendingEdits(current)) return;
    const previous = editorSnapshot();
    if (liveEditor) {
      if (renamed) await liveEditor.rewriteCanvasHistory(renamed, path, disk.content);
      else await liveEditor.setNotePath(path, disk.content);
    }
    else {
      fallbackEditor.value = disk.content;
      fallbackEditor.setSelectionRange(Math.min(previous.anchor, disk.content.length), Math.min(previous.head, disk.content.length));
      fallbackEditor.scrollTop = previous.scrollTop;
    }
    const snapshot = liveEditor ? liveEditor.snapshot() : editorSnapshot();
    current.content = disk.content; current.revision = disk.revision;
    current.hasImageText = disk.content.includes('<!--relatum:image-text:');
    if (!current.hasImageText) current.characterCount = disk.content.length;
    current.selectionStart = snapshot.anchor; current.selectionEnd = snapshot.head;
    current.scrollTop = state.viewMode === 'reading' ? previous.scrollTop : snapshot.scrollTop;
    current.editGeneration = ++state.documentGeneration; current.persistedGeneration = current.editGeneration;
    current.countedGeneration = 0; current.outgoing = []; current.backlinks = [];
    state.editGeneration += 1;
    cacheDocument(current);
    rememberViewState(path, { anchor: current.selectionStart, head: current.selectionEnd, scrollTop: current.scrollTop });
    if (state.viewMode === 'reading') renderReadingDocument(readingPayload(current));
    updateDocumentStats(null, current.characterCount, current.wordCount);
    scheduleStatistics(current); clearSaveError(); desktopDirty(false); renderLinks();
    if (root.classList.contains('links-overlay-open') && state.sideMode === 'links') ensureLinks();
  }
  async function performMove(source, destination, quiet) {
    state.lastMoveError = ''; state.lastMoveCode = '';
    if (state.imageTextBusy && !(await imageTextOperationPromise)) return false;
    if (editorInputPending()) await whenEditorInputSettled();
    stopExternalSync(); stopDocumentPrefetch(); state.externalSeq += 1; state.refreshSeq += 1;
    setNoteMoveInputLocked(true);
    if (!(await flushSave(state.current, true))) { state.lastMoveError = tr('saveFailed'); state.lastMoveCode = 'save_failed'; return false; }
    for (const cached of Array.from(state.documentCache.values())) {
      if (cached !== state.current && hasPendingEdits(cached) && !(await flushSave(cached, true))) {
        state.lastMoveError = tr('saveFailed'); state.lastMoveCode = 'save_failed'; return false;
      }
    }
    const entriesSnapshot = JSON.parse(JSON.stringify(state.entries)); const oldTabs = state.tabs.slice(); const oldActiveTab = state.activeTab; const oldSelectedPath = state.selectedPath; const oldSelectedFolder = state.selectedFolder;
    const oldNotebookRoot = state.notebookRoot; const oldNotebookExpanded = state.notebookExpanded; const oldExpanded = state.expanded;
    if (!optimisticMove(source, destination)) { state.lastMoveError = language() === 'en' ? 'A folder cannot be moved into itself' : '文件夹不能移入自己'; return false; }
    remapCachedPaths(source, destination);
    remapTabs(source, destination);
    state.selectedPath = mapPath(state.selectedPath, source, destination);
    state.selectedFolder = mapPath(state.selectedFolder, source, destination);
    state.expanded = new Set(Array.from(state.expanded).map((path) => mapPath(path, source, destination)));
    state.notebookRoot = mapPath(state.notebookRoot, source, destination);
    state.notebookExpanded = new Set(Array.from(state.notebookExpanded).map((path) => mapPath(path, source, destination)));
    if (state.current) { renderCurrentPath(state.current.path); renderInlineTitle(state.current.path, true); }
    renderTree();
    const rollback = () => {
      state.entries = entriesSnapshot; state.tabs = oldTabs; state.activeTab = oldActiveTab; state.selectedPath = oldSelectedPath; state.selectedFolder = oldSelectedFolder;
      state.notebookRoot = oldNotebookRoot; state.notebookExpanded = oldNotebookExpanded; state.expanded = oldExpanded;
      remapCachedPaths(destination, source); state.openingPath = mapPath(state.openingPath, destination, source);
      persistTabs(); if (state.current) { renderCurrentPath(state.current.path); renderInlineTitle(state.current.path, true); }
      renderTabs(); renderTree();
    };
    let result;
    try {
      result = await post('/api/note-move', { path: source, destination });
    }
    catch (error) { state.lastMoveError = error.message || tr('moveFailed'); state.lastMoveCode = error.code || ''; rollback(); if (!quiet) showToast(state.lastMoveError, 'error'); return false; }
    // The disk transaction has committed. Read its rewritten references before
    // changing the editor's asset base; a later read failure must not undo the UI path.
    window.RelatumNoteCanvas?.remapViews(source, destination, true);
    try { await syncMovedDocument(); }
    catch (error) { showToast(error.message || tr('readFailed'), 'error'); }
    if (result.rewritten) {
      state.documentCache.forEach((cached, path) => { if (cached !== state.current && !hasPendingEdits(cached)) state.documentCache.delete(path); });
    }
    if (Object.prototype.hasOwnProperty.call(state.notebookColors, source)) {
      const color = state.notebookColors[source]; delete state.notebookColors[source]; state.notebookColors[destination] = color;
      queueNotebookSettings({ colors: { [destination]: color }, pruneMissing: [source] });
    }
    queueNotebookSettings({ ui: notebookUi() });
    remapViewStates(source, destination); if (state.current) try { localStorage.setItem(ACTIVE_PATH_KEY, state.current.path); } catch (error) {} if (result.warnings && result.warnings.length) showToast(tr('linkWarnings', { count: result.warnings.length }), 'warning'); return true;
  }
  function moveEntry(source, folder) { if (state.notebookRoot === null || folder === null || notebookRootForPath(source) !== notebookRootForPath(folder)) return; const destination = joinPath(folder || '', baseName(source)); if (destination !== source) movePath(source, destination); }
  async function recycleEntry(entry) {
    if (noteMovePromise) await waitForNoteMove();
    if (!entry || state.recycleRunning) return;
    state.recycleRunning = true;
    stopExternalSync();
    state.externalSeq += 1;
    state.refreshSeq += 1;
    const previousEntries = state.entries;
    const previousTabs = state.tabs.slice();
    const previousSelectedPath = state.selectedPath;
    const previousSelectedFolder = state.selectedFolder;
    const previousExpanded = new Set(state.expanded);
    const affects = !!state.current && (state.current.path === entry.path || state.current.path.startsWith(entry.path + '/'));
    const flushPromise = (async () => {
      if (affects && !(await flushSave())) return false;
      for (const documentState of state.documentCache.values()) {
        if (documentState !== state.current && (documentState.path === entry.path || documentState.path.startsWith(entry.path + '/'))
            && hasPendingEdits(documentState) && !(await flushSave(documentState))) return false;
      }
      return true;
    })();
    const optimisticEntries = JSON.parse(JSON.stringify(state.entries));
    if (!removeTreeEntry(optimisticEntries, entry.path)) {
      state.recycleRunning = false;
      triggerExternalSync({ silentErrors: true });
      return;
    }
    state.entries = optimisticEntries;
    rebuildEntryIndex();
    if (state.selectedPath === entry.path || state.selectedPath.startsWith(entry.path + '/')) state.selectedPath = '';
    if (state.selectedFolder === entry.path || state.selectedFolder.startsWith(entry.path + '/')) state.selectedFolder = parentPath(entry.path);
    state.expanded = new Set(Array.from(state.expanded).filter((path) => path !== entry.path && !path.startsWith(entry.path + '/')));
    persistExpanded();
    renderTree();

    const rollback = () => {
      state.entries = previousEntries;
      state.selectedPath = previousSelectedPath;
      state.selectedFolder = previousSelectedFolder;
      state.expanded = previousExpanded;
      persistExpanded();
      rebuildEntryIndex();
      renderTree();
    };
    try {
      if (!(await flushPromise)) { rollback(); return; }
      const result = await post('/api/note-trash', { path: entry.path });
      const serverEntries = result.tree && Array.isArray(result.tree.entries) ? result.tree.entries : state.entries;
      const treeChanged = !sameTreeStructure(state.entries, serverEntries);
      state.entries = serverEntries;
      rebuildEntryIndex();
      const previousNotebookRoot = state.notebookRoot;
      const notebookMissing = reconcileNotebooks();
      if (treeChanged || previousNotebookRoot !== state.notebookRoot) renderTree();
      await reconcileExternalTree(previousTabs);
      if (notebookMissing) selectNotebook('', { rootTarget: true });
      showToast(tr('recycled'));
    } catch (error) {
      if (isMissingError(error)) await refreshTree(false, { silentErrors: true });
      else { rollback(); showToast(error.message || tr('recycle'), 'error'); }
    } finally {
      state.recycleRunning = false;
      scheduleExternalSync();
    }
  }
  async function reveal(path, assets) { try { await post(assets ? '/api/note-reveal-assets' : '/api/note-reveal', { path: path || '' }); } catch (error) { showToast(assets && error.status === 404 ? tr('noAssets') : error.message || tr('revealFailed'), 'error'); } }
  async function copyText(value) { try { await navigator.clipboard.writeText(value); } catch (error) { const area = document.createElement('textarea'); area.value = value; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } showToast(tr('copied')); }
  async function cleanupUnusedImages(path) {
    if (state.assetCleanupBusy || state.imageTextBusy) return;
    state.assetCleanupBusy = true;
    stopExternalSync();
    try {
      await whenEditorInputSettled();
      root.inert = true;
      // Flush all cached drafts as another open note may use a shared image.
      if (!(await flushSave())) throw new Error(tr('saveFailed'));
      for (const documentState of state.documentCache.values()) {
        if (hasPendingEdits(documentState) && !(await flushSave(documentState))) throw new Error(tr('saveFailed'));
      }
      state.imageTextBusy = true;
      updateImageTextTools();
      imageTextOperationPromise = (async () => {
        const note = await request('/api/note?path=' + encodeURIComponent(path));
        return post('/api/note-cleanup-unused-images', { path, revision: note.revision });
      })();
      const result = await imageTextOperationPromise;
      const count = Number(result.deletedCount) || 0;
      const failed = Number(result.failedCount) || 0;
      const size = Number(result.deletedBytes) || 0;
      const freed = size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + ' MB' : (size / 1024).toFixed(1) + ' KB';
      const message = language() === 'en'
        ? (count ? `Deleted ${count} unused image(s), freed ${freed}` : 'No unused images to clean up')
        : (count ? `已清理 ${count} 张未使用图片，释放 ${freed}` : '没有需要清理的未使用图片');
      showToast(message + (failed ? (language() === 'en' ? `; ${failed} file(s) could not be deleted. Retry later.` : `；${failed} 个文件未能删除，请重试`) : ''), failed ? 'warning' : '');
    } catch (error) {
      showToast(error.message || tr('saveFailed'), 'error');
    } finally {
      root.inert = false;
      state.assetCleanupBusy = false;
      state.imageTextBusy = false;
      updateImageTextTools();
      scheduleExternalSync();
    }
  }

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
  function showContext(items, x, y, source) { contextMenu.replaceChildren(...items); contextMenu.dataset.source = source || ''; contextMenu.hidden = false; contextMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - 250)) + 'px'; contextMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 8)) + 'px'; }
  const BODY_COMMAND_LABELS = {
    bullet: ['无序列表', 'Bulleted list'], ordered: ['有序列表', 'Numbered list'], task: ['任务列表', 'Task list'],
    body: ['正文', 'Normal text'], quote: ['引用', 'Quote'], table: ['表格', 'Table'], callout: ['标注', 'Callout'],
    rule: ['分隔线', 'Horizontal rule'], 'code-block': ['代码块', 'Code block'], math: ['数学块', 'Math block'],
    canvas: ['画布', 'Canvas'],
    cut: ['剪切', 'Cut'], copy: ['复制', 'Copy'], paste: ['粘贴', 'Paste'], 'paste-plain': ['以纯文本形式粘贴', 'Paste as plain text'],
    'select-all': ['全选', 'Select all'], paragraph: ['段落设置', 'Paragraph'], insert: ['插入', 'Insert'],
  };
  function bodyCommandLabel(name) {
    const kind = name.split(':').pop();
    if (/^heading-[1-6]$/.test(kind)) return language() === 'en' ? 'Heading ' + kind.slice(-1) : kind.slice(-1) + '级标题';
    return BODY_COMMAND_LABELS[kind][language() === 'en' ? 1 : 0];
  }
  function openCanvasContextMenu(payload) {
    if (!canvasEnabled() || !state.active || !state.current || state.viewMode !== 'live') return;
    closeContextMenu();
    const explorer = contextButton(tr('canvasExplorer'), () => revealCanvas(payload.adapter));
    explorer.disabled = !payload.adapter?.session;
    showContext([contextButton(tr('rename'), () => renameCanvas(payload.adapter)), explorer], payload.x, payload.y, 'canvas');
  }
  async function revealCanvas(adapter) {
    const session = adapter?.session;
    if (!session) return;
    try { await post('/api/notes-canvas/reveal', { path: session.path }); }
    catch (error) { showToast(error.message || tr('revealFailed'), 'error'); }
  }
  function canvasNameInput(name) {
    return new Promise(resolve => {
      const overlay = document.createElement('div'); overlay.className = 'note-modal-overlay';
      const dialog = document.createElement('section'); dialog.className = 'note-modal-card';
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h2'); heading.textContent = tr('rename');
      const input = document.createElement('input'); input.className = 'note-tree-rename'; input.value = name.replace(/\.canvas$/i, ''); input.setAttribute('aria-label', tr('rename'));
      const actions = document.createElement('footer'); actions.className = 'note-modal-actions';
      const finish = value => { overlay.remove(); resolve(value); };
      actions.append(contextButton(tr('cancel'), () => finish(null)), contextButton(tr('rename'), () => { if (input.value.trim()) finish(input.value.trim()); }));
      input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') finish(null); else if (event.key === 'Enter' && !event.isComposing && input.value.trim()) finish(input.value.trim()); });
      dialog.append(heading, input, actions); overlay.append(dialog); modalHost.replaceChildren(overlay);
      requestAnimationFrame(() => { overlay.classList.add('visible'); input.focus(); input.select(); });
    });
  }
  async function renameCanvas(adapter) {
    const session = adapter?.session;
    if (!session || noteMovePromise) return;
    const name = await canvasNameInput(baseName(session.path));
    if (!name) return;
    const operation = (async () => {
      if (editorInputPending()) await whenEditorInputSettled();
      if (!(await flushCanvases())) return false;
      stopExternalSync(); stopDocumentPrefetch(); state.externalSeq++; state.refreshSeq++;
      setNoteMoveInputLocked(true);
      if (!(await flushSave(state.current, true))) return false;
      for (const cached of state.documentCache.values()) if (cached !== state.current && hasPendingEdits(cached) && !(await flushSave(cached, true))) return false;
      const source = session.path;
      const result = await post('/api/notes-canvas/rename', { path: source, name, revision: session.revision });
      window.RelatumNoteCanvas.renameSession(source, result);
      // Project every history branch even when the current note has no reference:
      // its redo branch may still contain an inserted canvas.
      if (liveEditor && state.current) {
        await liveEditor.rewriteCanvasHistory(result.renamed, state.current.path);
        if (result.noteRevisions?.[state.current.path]) state.current.revision = result.noteRevisions[state.current.path];
        state.current.countedGeneration = 0;
        rememberEditorState(state.current);
      }
      state.documentCache.forEach((cached, path) => { if (cached !== state.current && result.rewritten.includes(path) && !hasPendingEdits(cached)) state.documentCache.delete(path); });
      try { await syncMovedDocument(); }
      catch (error) { showToast(error.message || tr('readFailed'), 'error'); }
      if (noteBrowser) noteBrowser.invalidate();
      return true;
    })();
    noteMovePromise = operation; noteMovePaths = null;
    try { return await operation; }
    catch (error) { showToast(error.message || tr('moveFailed'), 'error'); return false; }
    finally {
      if (noteMovePromise === operation) { noteMovePromise = null; setNoteMoveInputLocked(false); scheduleExternalSync(); scheduleDocumentPrefetch(); }
    }
  }
  function fitBodyMenu(menu, x, y) {
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function menuButtons(menu) { return Array.from(menu.children).filter((item) => item.tagName === 'BUTTON' && !item.disabled); }
  function closeBodySubmenu() {
    if (bodyMenuParent) { bodyMenuParent.setAttribute('aria-expanded', 'false'); bodyMenuParent.classList.remove('is-open'); }
    if (bodyMenuSubmenu) bodyMenuSubmenu.remove();
    bodyMenuSubmenu = null; bodyMenuParent = null;
  }
  async function runBodyCommand(name) {
    const context = bodyMenuContext;
    if (!context || !liveEditor || !liveEditor.queryCommand(name, context).enabled || contextMenu.getAttribute('aria-busy') === 'true') return;
    contextMenu.setAttribute('aria-busy', 'true');
    try {
      if (name === 'insert:canvas') {
        const note = state.current;
        const result = await post('/api/notes-canvas/create', { note: note.path });
        if (state.current !== note || bodyMenuContext !== context) return;
        const label = baseName(result.path).replace(/[\\\[\]]/g, '\\$&');
        const source = result.source.split('/').map(part => encodeURIComponent(part)).join('/');
        liveEditor.executeCommand(name, context, '![' + label + '|640x360](' + source + ')');
      } else if (name === 'copy' || name === 'cut') {
        const text = context.selection.ranges.map((range) => context.doc.sliceString(range.from, range.to)).join('\n');
        await navigator.clipboard.writeText(text);
        if (bodyMenuContext !== context) return;
        if (name === 'cut') liveEditor.executeCommand(name, context, '');
        else liveEditor.focus();
      } else if (name === 'paste' || name === 'paste-plain') {
        let clipboardText = null, clipboardHtml = '';
        if (name === 'paste' && navigator.clipboard.read) {
          let items = [];
          try { items = await navigator.clipboard.read(); } catch (error) { /* Text-only hosts still support readText. */ }
          if (bodyMenuContext !== context) return;
          const images = [];
          for (const item of items) {
            const type = item.types.find((candidate) => /^image\//.test(candidate));
            if (type) images.push(new File([await item.getType(type)], 'image.' + (type === 'image/jpeg' ? 'jpg' : 'png'), { type }));
          }
          if (images.length) {
            await uploadImages(images, context);
            if (bodyMenuContext === context) closeContextMenu();
            return;
          }
          for (const item of items) {
            if (!item.types.includes('text/plain')) continue;
            try {
              clipboardText = await (await item.getType('text/plain')).text();
              if (item.types.includes('text/html')) clipboardHtml = await (await item.getType('text/html')).text();
            } catch (error) { /* Preserve available text when rich clipboard data is unavailable. */ }
            break;
          }
        }
        const rawText = clipboardText == null ? await navigator.clipboard.readText() : clipboardText;
        const text = name === 'paste' ? clipboardLinkMarkdown(rawText, clipboardHtml) : rawText;
        if (bodyMenuContext !== context) return;
        if (text) liveEditor.executeCommand(name, context, text);
      } else liveEditor.executeCommand(name, context);
      if (bodyMenuContext === context) closeContextMenu();
    } catch (error) {
      showToast(name === 'insert:canvas' ? error.message : language() === 'en' ? 'Clipboard unavailable. Use the keyboard shortcut.' : '无法访问剪贴板，请使用键盘快捷键。', 'error');
    } finally { contextMenu.removeAttribute('aria-busy'); }
  }
  function bodyCommandButton(name) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = bodyCommandLabel(name); button.dataset.noteCommand = name;
    const status = liveEditor.queryCommand(name, bodyMenuContext);
    button.disabled = !status.enabled;
    button.setAttribute('role', name.startsWith('paragraph:') ? 'menuitemradio' : 'menuitem');
    if (name.startsWith('paragraph:')) { button.setAttribute('aria-checked', String(status.checked)); button.classList.toggle('active', status.checked); }
    button.addEventListener('click', () => runBodyCommand(name));
    return button;
  }
  function openBodySubmenu(parent, focusFirst) {
    if (bodyMenuParent === parent) { if (focusFirst) menuButtons(bodyMenuSubmenu)[0]?.focus(); return; }
    closeBodySubmenu();
    const paragraph = parent.dataset.noteSubmenu === 'paragraph';
    const commands = paragraph ? ['bullet', 'ordered', 'task', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'body', 'quote']
      : ['table', 'callout', 'rule', 'code-block', 'math'];
    if (!paragraph && canvasEnabled()) commands.splice(3, 0, 'canvas');
    const submenu = document.createElement('div'); submenu.className = 'note-context-menu note-context-submenu';
    submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', parent.textContent);
    commands.forEach((kind, index) => {
      if ((paragraph && (index === 3 || index === 10)) || (!paragraph && index === 3)) submenu.appendChild(separator());
      submenu.appendChild(bodyCommandButton((paragraph ? 'paragraph:' : 'insert:') + kind));
    });
    contextMenu.appendChild(submenu); bodyMenuSubmenu = submenu; bodyMenuParent = parent;
    parent.setAttribute('aria-expanded', 'true'); parent.classList.add('is-open');
    const rect = parent.getBoundingClientRect(), rootRect = contextMenu.getBoundingClientRect();
    const x = rootRect.right + submenu.offsetWidth <= window.innerWidth - 8 ? rootRect.right - 2 : rootRect.left - submenu.offsetWidth + 2;
    fitBodyMenu(submenu, x, rect.top - 6);
    if (focusFirst) menuButtons(submenu)[0]?.focus();
  }
  function openBodyContextMenu(payload) {
    if (!state.active || !state.current || state.viewMode === 'reading' || state.imageTextBusy || state.assetCleanupBusy) return;
    closeContextMenu(); bodyMenuContext = payload.context;
    const items = ['paragraph', 'insert'].map((kind) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = bodyCommandLabel(kind);
      button.dataset.noteSubmenu = kind; button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.addEventListener('pointerenter', () => openBodySubmenu(button, false));
      button.addEventListener('click', (event) => openBodySubmenu(button, event.detail === 0));
      return button;
    });
    items.push(separator(), ...['cut', 'copy', 'paste', 'paste-plain', 'select-all'].map(bodyCommandButton));
    showContext(items, payload.x, payload.y, 'body'); fitBodyMenu(contextMenu, payload.x, payload.y);
    if (payload.keyboard) menuButtons(contextMenu)[0]?.focus({ preventScroll: true });
  }
  if (contextMenu) {
    contextMenu.addEventListener('pointerdown', (event) => { if (bodyMenuContext) event.preventDefault(); });
    contextMenu.addEventListener('pointerover', (event) => {
      if (bodyMenuContext && event.target.closest('[data-note-command]')?.parentElement === contextMenu) closeBodySubmenu();
    });
    contextMenu.addEventListener('keydown', (event) => {
      if (!bodyMenuContext) return;
      const current = document.activeElement, menu = current && current.parentElement;
      const buttons = menuButtons(menu === bodyMenuSubmenu ? bodyMenuSubmenu : contextMenu);
      const index = buttons.indexOf(current);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
      } else if (event.key === 'ArrowRight' && current?.dataset.noteSubmenu) {
        event.preventDefault(); openBodySubmenu(current, true);
      } else if (event.key === 'ArrowLeft' && bodyMenuSubmenu) {
        event.preventDefault(); const parent = bodyMenuParent; closeBodySubmenu(); parent.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); closeContextMenu(); liveEditor.focus();
      }
    });
  }
  function openContextMenu(entry, x, y, options) {
    if (!entry) { showContext([contextButton(tr('newNote'), () => createEntry('note', { parent: state.notebookRoot })), contextButton(tr('newFolder'), () => createEntry('folder', { parent: state.notebookRoot })), separator(), contextButton(tr('refresh'), () => triggerExternalSync({ announce: true })), contextButton(tr('openLibrary'), () => reveal(state.notebookRoot, false))], x, y); return; }
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
    items.push(contextButton(tr('rename'), () => beginInlineRename(entry.path)));
    if (entry.kind === 'note') items.push(contextButton(tr('copyPath'), () => copyText(entry.path)));
    items.push(contextButton(tr('explorer'), () => reveal(entry.path, false)));
    if (entry.kind === 'note') {
      const cleanup = contextButton(language() === 'en' ? 'Clean up unused images' : '清理未使用图片', () => cleanupUnusedImages(entry.path));
      cleanup.title = language() === 'en' ? 'Permanently delete unused images in this note’s attachment folder; preserve images used by other notes'
        : '永久删除本篇笔记附件目录中未使用的图片文件；其他笔记仍在使用的图片会保留';
      cleanup.dataset.noteAction = 'cleanup-unused-images';
      cleanup.disabled = !!(state.assetCleanupBusy || state.imageTextBusy);
      items.push(contextButton(tr('assets'), () => reveal(entry.path, true)), cleanup);
    }
    items.push(separator(), contextButton(tr('recycle'), () => recycleEntry(entry), true));
    showContext(items, x, y, options && options.source);
  }

  function openNotebookContext(entry, x, y) {
    closeContextMenu();
    if (!entry.path) return;
    const colors = document.createElement('div'); colors.className = 'note-notebook-colors';
    colors.setAttribute('role', 'group'); colors.setAttribute('aria-label', language() === 'en' ? 'Notebook color' : '笔记本颜色');
    NOTEBOOK_COLORS.forEach((color) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-notebook-icon'; button.dataset.color = color;
      button.title = notebookCopy(color); button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String((state.notebookColors[entry.path] || 'gray') === color));
      button.addEventListener('click', () => {
        closeContextMenu(); state.notebookColors[entry.path] = color;
        notebookTreeEl.querySelectorAll('.note-notebook-root > .note-tree-row').forEach((row) => {
          if (row.dataset.notePath === entry.path) row.querySelector('.note-notebook-icon').dataset.color = color;
        });
        queueNotebookSettings({ colors: { [entry.path]: color } });
      });
      colors.appendChild(button);
    });
    showContext([colors, separator(), contextButton(tr('rename'), () => beginInlineRename(entry.path)), contextButton(tr('recycle'), () => recycleEntry(entry), true)], x, y);
  }
  let notebookCreateRunning = false;
  async function createNotebook() {
    if (notebookCreateRunning) return;
    notebookCreateRunning = true;
    try {
      if (!(await finishInlineTitle()) || state.renamePath && !(await finishInlineRename())) return;
      const names = new Set((findEntry(NOTEBOOK_CONTAINER)?.children || []).map((entry) => entry.name.toLowerCase()));
      let number = 1;
      while (true) {
        const name = 'Untitled' + number++;
        if (names.has(name.toLowerCase())) continue;
        let result;
        try { result = await post('/api/note-create', { kind: 'folder', parent: NOTEBOOK_CONTAINER, name, createParents: true }); }
        catch (error) { if (error.code === 'exists') continue; throw error; }
        state.entries = result.tree?.entries || state.entries; rebuildEntryIndex();
        selectNotebook(result.path, { rootTarget: true, noRender: true });
        renderTree(); break;
      }
    } catch (error) { showToast(error.message || tr('readFailed'), 'error'); }
    finally { notebookCreateRunning = false; }
  }
  function modalConfirm(title, copy) { if (!modalHost) return Promise.resolve(false); return new Promise((resolve) => { const overlay = document.createElement('div'); overlay.className = 'note-modal-overlay'; const dialog = document.createElement('section'); dialog.className = 'note-modal-card'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); const heading = document.createElement('h2'); heading.textContent = title; const paragraph = document.createElement('p'); paragraph.textContent = copy; const actions = document.createElement('footer'); actions.className = 'note-modal-actions'; const finish = (value) => { overlay.remove(); resolve(value); }; actions.append(contextButton(tr('cancel'), () => finish(false)), contextButton(tr('create'), () => finish(true))); dialog.append(heading, paragraph, actions); overlay.appendChild(dialog); modalHost.replaceChildren(overlay); requestAnimationFrame(() => overlay.classList.add('visible')); }); }
  async function confirmCreateWiki(rawTarget) { const target = normalizedWikiTarget(rawTarget); if (!target || !(await modalConfirm(tr('unresolvedTitle'), tr('unresolvedCopy', { target })))) return; const parts = target.replace(/\\/g, '/').split('/').filter(Boolean); const name = parts.pop(); const hasPath = parts.length > 0; await createEntry('note', { parent: hasPath ? parts.join('/') : state.current ? parentPath(state.current.path) : '', name, createParents: hasPath }); }

  function renderGuide() {
    if (!guideContent || !window.MarkdownMini?.noteBlockCatalog) return;
    const lang = language();
    if (guideContent.dataset.language === lang) return;
    const english = lang === 'en';
    const scroll = guideContent.scrollTop;
    guideContent.replaceChildren(); guideContent.dataset.language = lang;
    const catalog = window.MarkdownMini.noteBlockCatalog;
    const heading = (zh, en) => { const item = document.createElement('h3'); item.textContent = english ? en : zh; guideContent.appendChild(item); };
    const example = (source, preview, detail) => {
      const item = document.createElement('div'); item.className = 'note-guide-example';
      if (preview) {
        const content = document.createElement('div'); content.className = 'node-text';
        content.innerHTML = window.MarkdownMini.renderResult(preview, { noteBlocks: true }).html;
        content.querySelectorAll('.note-callout-fold').forEach(button => button.addEventListener('click', () => {
          const body = button.closest('.md-callout').querySelector('.md-callout-body');
          if (body) { body.hidden = !body.hidden; button.setAttribute('aria-expanded', String(!body.hidden)); }
        }));
        item.appendChild(content);
      }
      if (detail) { const text = document.createElement('small'); text.textContent = detail; item.appendChild(text); }
      const code = document.createElement('pre'); code.textContent = source; item.appendChild(code);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-guide-copy';
      const label = english ? 'Copy syntax' : '复制语法'; button.setAttribute('data-ui-tooltip', label); button.setAttribute('aria-label', label);
      button.innerHTML = '<svg class="note-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#note-icon-copy"/></svg>';
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', async () => {
        let copied = false;
        try { await navigator.clipboard.writeText(source); copied = true; } catch (error) {
          await liveEditor?.whenInputSettled();
          const active = document.activeElement;
          const selection = window.getSelection();
          const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
          const inputSelection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
          const area = document.createElement('textarea'); area.value = source; area.readOnly = true;
          area.style.cssText = 'position:fixed;left:-9999px;opacity:0'; document.body.appendChild(area); area.select();
          try { copied = !!document.execCommand('copy'); } catch (copyError) {}
          area.remove();
          active?.focus({ preventScroll: true });
          if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
          if (inputSelection) active.setSelectionRange(...inputSelection);
        }
        const feedback = copied ? english ? 'Syntax copied' : '语法已复制' : english ? 'Could not copy syntax' : '语法复制失败';
        if (button.isConnected) { button.setAttribute('data-ui-tooltip', feedback); button.setAttribute('aria-label', feedback); window.setTimeout(() => { if (button.isConnected) { button.setAttribute('data-ui-tooltip', label); button.setAttribute('aria-label', label); } }, 1800); }
        showToast(feedback, copied ? undefined : 'error');
      });
      item.appendChild(button); guideContent.appendChild(item);
    };
    const body = english ? 'Callout content.' : 'Callout 正文。';
    heading('Callout 与别名', 'Callouts and aliases');
    catalog.types.forEach(type => {
      const source = '> [!' + type.name + ']\n> ' + body;
      example(source, source, type.aliases.length ? (english ? 'Aliases: ' : '别名：') + type.aliases.join(', ') : '');
    });
    heading('标题与折叠', 'Titles and folding');
    const custom = '> [!note] ' + (english ? 'Custom title' : '自定义标题') + '\n> ' + body;
    example(custom, custom);
    ['+', '-'].forEach(suffix => {
      const source = '> [!' + (suffix === '+' ? 'tip' : 'warning') + ']' + suffix + ' ' + (english ? suffix === '+' ? 'Expanded by default' : 'Collapsed by default' : suffix === '+' ? '默认展开' : '默认折叠') + '\n> ' + body;
      example(source, source);
    });
    heading('块公式', 'Display math');
    example('> [!info]\n> $$a^2+b^2$$\n> ' + body, null);
    example('> [!info]\n> $$\n> a^2+b^2\n> $$\n> ' + body, null);
    example('> [!info]\n> \\[\n> E=mc^2\n> \\]\n> ' + body, null);
    heading('纯色块', 'Color blocks');
    const groups = { cool: ['冷色', 'Cool'], green: ['绿色', 'Green'], warm: ['暖色', 'Warm'], pink: ['粉紫', 'Pink and purple'], neutral: ['中性', 'Neutral'] };
    Object.entries(groups).forEach(([group, names]) => {
      heading(...names);
      catalog.colors.filter(color => color.group === group).forEach(color => {
        const source = '> [!' + color.name + ']\n> ' + (english ? 'Color block content.' : '纯色块正文。');
        example(source, source);
      });
    });
    const titled = '> [!Lavender] ' + (english ? 'Custom title' : '自定义标题') + '\n> ' + (english ? 'Color block content.' : '纯色块正文。');
    example(titled, titled, english ? 'Color names are case-insensitive.' : '颜色名不区分大小写。');
    guideContent.scrollTop = scroll;
  }

  function updateSidePanel() {
    const open = root.classList.contains('links-overlay-open');
    if (sidePane) { sidePane.inert = !open; sidePane.setAttribute('aria-label', language() === 'en' ? 'Note sidebar' : '笔记侧栏'); }
    $('.note-side-modes')?.setAttribute('aria-label', language() === 'en' ? 'Sidebar view' : '侧栏视图');
    if (sideTitle) sideTitle.textContent = notebookCopy(state.sideMode);
    if (notebooksContent) notebooksContent.hidden = state.sideMode !== 'notebooks';
    if (linksContent) linksContent.hidden = state.sideMode !== 'links';
    if (canvasSettingsContent) canvasSettingsContent.hidden = state.sideMode !== 'canvas';
    if (guideContent) { guideContent.hidden = state.sideMode !== 'guide'; if (open && state.sideMode === 'guide') renderGuide(); }
    ['notebooks', 'links', 'canvas', 'guide'].forEach((mode) => {
      const button = $('[data-note-action="side-' + mode + '"]');
      if (button) { button.textContent = notebookCopy(mode); button.setAttribute('aria-pressed', String(state.sideMode === mode)); }
    });
    if (open) {
      const button = $('[data-note-action="side-' + state.sideMode + '"]');
      if (button) {
        const nav = button.parentElement, parent = nav.getBoundingClientRect(), rect = button.getBoundingClientRect();
        if (rect.left < parent.left) nav.scrollLeft += rect.left - parent.left;
        else if (rect.right > parent.right) nav.scrollLeft += rect.right - parent.right;
      }
    }
    const toggle = $('[data-note-action="toggle-notebooks"]');
    if (toggle) { toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', notebookCopy('notebooks')); toggle.title = notebookCopy('notebooks'); }
    $('[data-role="note-side-toolbar"]')?.setAttribute('aria-label', language() === 'en' ? 'Note tools' : '笔记工具');
    ['new-notebook', 'toggle-all-notebooks'].forEach((action) => {
      const button = $('[data-note-action="' + action + '"]'); if (button) button.hidden = state.sideMode !== 'notebooks';
    });
    const add = $('[data-note-action="new-notebook"]');
    if (add) { add.title = notebookCopy('create'); add.setAttribute('aria-label', add.title); }
    $('[data-note-action="close-links"]')?.setAttribute('aria-label', notebookCopy('close'));
    if (state.sideMode === 'notebooks') renderNotebookTree();
  }
  let sidePopoverFrame = 0;
  let sideMotionUntil = 0;
  function positionSidePopover(popover, trigger) {
    if (!popover || popover.hidden || !trigger || !root.classList.contains('links-overlay-open')) return;
    const surface = root.getBoundingClientRect(); const anchor = trigger.getBoundingClientRect();
    const below = Math.max(0, surface.bottom - anchor.bottom - 20);
    const above = Math.max(0, anchor.top - surface.top - 20);
    const placeAbove = below < 120 && above > below;
    const available = placeAbove ? above : below;
    const setStyle = (name, value) => { if (popover.style[name] !== value) popover.style[name] = value; };
    setStyle('maxHeight', Math.min(popover === settingsPop ? 690 : 780, available) + 'px');
    const left = Math.max(12, Math.min(anchor.right - surface.left - root.clientLeft - popover.offsetWidth, root.clientWidth - popover.offsetWidth - 12));
    const wantedTop = placeAbove ? anchor.top - surface.top - root.clientTop - popover.offsetHeight - 8 : anchor.bottom - surface.top - root.clientTop + 8;
    const top = Math.max(12, Math.min(wantedTop, root.clientHeight - popover.offsetHeight - 12));
    setStyle('left', left + 'px'); setStyle('top', top + 'px');
  }
  function scheduleSidePopoverPosition() {
    if (sidePopoverFrame) return;
    sidePopoverFrame = requestAnimationFrame(() => {
      sidePopoverFrame = 0;
      if (!state.active || !root.classList.contains('links-overlay-open')) return;
      positionSidePopover(settingsPop, settingsTrigger); positionSidePopover(imageTextTools, imageTextToggle);
      if (performance.now() < sideMotionUntil && ((!settingsPop?.hidden && state.settingsOpen) || !imageTextTools?.hidden)) scheduleSidePopoverPosition();
    });
  }
  window.addEventListener('resize', () => { sideMotionUntil = performance.now() + 270; scheduleSidePopoverPosition(); });
  if (window.ResizeObserver) {
    const sidePopoverObserver = new ResizeObserver(scheduleSidePopoverPosition);
    [root, settingsPop, imageTextTools].filter(Boolean).forEach((element) => sidePopoverObserver.observe(element));
  }
  function setSideOpen(open) {
    cancelLinksRefresh();
    sideMotionUntil = performance.now() + 270;
    if (!open) {
      const focusWasInside = sidePane?.contains(document.activeElement) || settingsPop?.contains(document.activeElement) || imageTextTools?.contains(document.activeElement);
      setNoteSettingsOpen(false, { restoreFocus: false });
      state.imageText.toggleSeq += 1; state.imageText.toggleIntent = null; state.imageTextCleanupPath = '';
      state.imageText.active = false;
      if (liveEditor) liveEditor.setImageTextMode(false);
      if (imageTextTools) { imageTextTools.hidden = true; imageTextTools.inert = true; }
      if (sidePopoverFrame) cancelAnimationFrame(sidePopoverFrame); sidePopoverFrame = 0;
      if (focusWasInside) $('[data-note-action="toggle-notebooks"]')?.focus({ preventScroll: true });
    }
    root.classList.toggle('links-overlay-open', open); updateSidePanel(); queueNotebookSettings({ ui: notebookUi() });
    updateImageTextTools();
    if (open) { if (state.sideMode === 'links') ensureLinks(); scheduleSidePopoverPosition(); }
    if (!open) window.setTimeout(() => {
      if (!root.classList.contains('links-overlay-open') && notebookTreeEl) { clearTreeRowIndex(notebookTreeEl); notebookTreeEl.replaceChildren(); state.notebookTreeDirty = true; }
    }, 270);
  }
  function setSideMode(mode) {
    state.sideMode = ['notebooks', 'links', 'guide', ...(canvasEnabled() ? ['canvas'] : [])].includes(mode) ? mode : 'notebooks';
    setNoteSettingsOpen(false, { restoreFocus: false });
    setSideOpen(true);
  }
  function toggleCanvasPanel(engine) {
    if (!state.active || !state.current || !canvasEnabled() || !engine || window.RelatumNoteCanvas?.getActive() !== engine) return false;
    if (root.classList.contains('links-overlay-open')) setSideOpen(false);
    else setSideMode('canvas');
    return true;
  }
  function canToggleSideByTab(event) {
    if (event.defaultPrevented || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
        event.isComposing || event.keyCode === 229 || document.hidden || editorInputPending() ||
        state.settingsOpen || state.libraryPanel || state.imageTextBusy || state.assetCleanupBusy ||
        state.openingPath || noteMovePromise || root.classList.contains('note-document-switch-pending') ||
        modalHost?.childElementCount || contextMenu && !contextMenu.hidden || imageTextTools && !imageTextTools.hidden) return false;
    const controls = 'input, textarea, select, button, a[href], area[href], summary, iframe, audio[controls], video[controls], ' +
      '.note-canvas-viewport, [role="button"], [role="link"], [role="textbox"], [role="combobox"], ' +
      '[role="slider"], [role="spinbutton"], [role="checkbox"], [role="radio"], [role="switch"], ' +
      '[role="tab"], [role="tree"], [role="treeitem"], [role="listbox"], [role="option"], [role="menu"], [role^="menuitem"], [role="dialog"], [role="alertdialog"]';
    return [event.target, document.activeElement].every((element) => {
      if (!(element instanceof Element)) return false;
      if (element === document.body || element === document.documentElement) return true;
      if (!root.contains(element) || element.isContentEditable || element.closest(controls + ', [inert]') ||
          editorHost?.contains(element) || fallbackEditor?.contains(element) || sidePane?.contains(element)) return false;
      const tabStop = element.closest('[tabindex]');
      return !tabStop || tabStop === readingHost || tabStop === root;
    });
  }
  function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || ''); reader.onerror = () => reject(reader.error || new Error('FileReader failed')); reader.readAsDataURL(file); }); }
  async function uploadImages(files, commandContext) {
    if (!state.current || !files.length) return;
    const path = state.current.path;
    const insertions = [];
    for (const file of files) {
      try {
        const result = await post('/api/note-upload-image', { path, name: file.name || 'image.png', mediaType: file.type || '', data: await fileToBase64(file) });
        if (!state.current || state.current.path !== path) return;
        const insertion = '![' + (result.name || file.name || 'image') + '](' + result.path + ')\n';
        if (commandContext) {
          if (bodyMenuContext !== commandContext || !liveEditor.queryCommand('paste', commandContext).enabled) return;
          insertions.push(insertion);
        } else replaceEditorSelection(insertion);
      } catch (error) { showToast(error.message || tr('uploadFailed'), 'error'); }
    }
    if (insertions.length && bodyMenuContext === commandContext) liveEditor.executeCommand('paste', commandContext, insertions.join(''));
  }
  function entryFiles(entry, prefix) { return new Promise((resolve) => { if (entry.isFile) { entry.file((file) => resolve([{ path: prefix + file.name, file }]), () => resolve([])); return; } if (!entry.isDirectory) { resolve([]); return; } const reader = entry.createReader(); const children = []; const read = () => reader.readEntries(async (batch) => { if (!batch.length) { resolve((await Promise.all(children.map((child) => entryFiles(child, prefix + entry.name + '/')))).flat()); return; } children.push(...batch); read(); }, () => resolve([])); read(); }); }
  async function filesFromTransfer(transfer) { const items = Array.from(transfer && transfer.items || []); const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean); if (entries.length) return (await Promise.all(entries.map((entry) => entryFiles(entry, '')))).flat(); return Array.from(transfer && transfer.files || []).map((file) => ({ path: file.name, file })); }
  async function importDataTransfer(transfer, destination) { if (destination === null || state.importRunning) return; state.importRunning = true; let token = ''; try { const all = await filesFromTransfer(transfer); const accepted = all.filter((item) => /\.md$/i.test(item.path) || IMAGE_RE.test(item.path)); const skipped = all.length - accepted.length; if (!accepted.length) return; token = (await post('/api/note-import-begin', { destination: destination || '' })).token; for (const item of accepted) await post('/api/note-import-upload', { token, path: item.path.replace(/\\/g, '/'), mediaType: item.file.type || '', data: await fileToBase64(item.file) }); const result = await post('/api/note-import-commit', { token }); token = ''; state.entries = result.tree && result.tree.entries || state.entries; renderTree(); if (result.notes && result.notes.length) { showToast(tr('imported', { count: result.notes.length })); await openNote(result.notes[0]); } if (skipped) setTimeout(() => showToast(tr('unsupportedSkipped', { count: skipped }), 'warning'), 350); } catch (error) { showToast(error.message || tr('importFailed'), 'error'); } finally { if (token) post('/api/note-import-abort', { token }).catch(() => {}); state.importRunning = false; } }

  async function checkExternalChanges(announce, options) {
    if (!state.active || state.imageTextBusy || noteMovePromise) return false;
    if (state.recycleRunning) return true;
    const settings = options || {};
    const seq = ++state.externalSeq;
    const path = state.current && state.current.path;
    const generation = state.editGeneration;
    const revision = state.current && state.current.revision;
    const previousModifiedNs = state.current && state.current.treeModifiedNs || 0;
    const previousSize = state.current && state.current.treeSize || 0;
    const refreshed = await refreshTree(announce, { silentErrors: !!settings.silentErrors, background: !!settings.background });
    if (!refreshed) return false;
    await noteBrowser?.checkExternalCanvases();
    if (state.imageTextBusy || seq !== state.externalSeq || !path || !state.current || state.current.path !== path || state.editGeneration !== generation) return true;
    const entry = findEntry(path);
    if (!entry) return true;
    const metadataChanged = previousModifiedNs !== entry.modifiedNs || previousSize !== entry.size;
    if (settings.metadataOnly && !metadataChanged) return true;
    if (state.saveRunning || hasPendingEdits() || window.RelatumNoteCanvas?.dirty) return true;
    try {
      const disk = await request('/api/note?path=' + encodeURIComponent(path));
      if (state.imageTextBusy || seq !== state.externalSeq || !state.current || state.current.path !== path || state.editGeneration !== generation || state.current.revision !== revision || hasPendingEdits()) return true;
      if (disk.revision !== revision) applyDocument(disk, { preserveViewState: true });
      else {
        state.current.treeModifiedNs = entry.modifiedNs || 0;
        state.current.treeSize = entry.size || 0;
        cacheDocument(state.current);
      }
      return true;
    } catch (error) {
      if (isMissingError(error)) {
        await refreshTree(false, { silentErrors: true });
        return true;
      }
      if (announce) showToast(error.message || tr('readFailed'), 'error');
      return false;
    }
  }
  function stopExternalSync() {
    clearTimeout(state.externalSyncTimer);
    state.externalSyncTimer = 0;
  }
  function externalSyncDelay() {
    const index = state.externalSyncFailures ? Math.min(state.externalSyncFailures - 1, EXTERNAL_SYNC_DELAYS.length - 1) : state.externalSyncUnchanged;
    return EXTERNAL_SYNC_DELAYS[index];
  }
  function resetExternalSyncActivity() {
    const slowed = state.externalSyncUnchanged > 0;
    state.externalSyncUnchanged = 0;
    if (state.active && !document.hidden && (slowed || !state.externalSyncTimer)) scheduleExternalSync();
  }
  function scheduleExternalSync(delay) {
    stopExternalSync();
    if (!state.active || document.hidden || state.imageTextBusy || noteMovePromise) return;
    if (state.assetCleanupBusy) return;
    state.externalSyncTimer = setTimeout(() => {
      state.externalSyncTimer = 0;
      triggerExternalSync({ background: true, metadataOnly: true, silentErrors: true });
    }, Number.isFinite(delay) ? delay : externalSyncDelay());
  }
  function triggerExternalSync(options) {
    const settings = options || {};
    stopExternalSync();
    let ran = false;
    const task = state.externalSyncChain.catch(() => false).then(async () => {
      if (!state.active || state.imageTextBusy || state.assetCleanupBusy || noteMovePromise || (settings.background && document.hidden)) return false;
      ran = true;
      return checkExternalChanges(!!settings.announce, settings);
    });
    state.externalSyncChain = task;
    task.then((ok) => {
      if (!ran) return;
      state.externalSyncFailures = ok ? 0 : Math.min(EXTERNAL_SYNC_DELAYS.length, state.externalSyncFailures + 1);
    }, () => {
      if (ran) state.externalSyncFailures = Math.min(EXTERNAL_SYNC_DELAYS.length, state.externalSyncFailures + 1);
    }).finally(() => {
      if (state.externalSyncChain === task) scheduleExternalSync();
    });
    return task;
  }
  function initializeWorkspace() {
    if (state.initialized) return Promise.resolve(true);
    if (state.initializePromise) return state.initializePromise;
    window.RelatumStartupMark?.('notes-initialize-start');
    const initialize = (async () => {
      if (!(await refreshTree(false))) return false;
      window.RelatumStartupMark?.('notes-tree-ready');
      state.initialized = true;
      let path = ''; try { path = localStorage.getItem(ACTIVE_PATH_KEY) || ''; } catch (error) {}
      let activeTab = state.tabs.includes(state.activeTab) ? state.activeTab : '';
      if (!activeTab && path && findEntry(path) && state.tabs.includes(path)) activeTab = path;
      if (!activeTab) activeTab = state.tabs.find((tabPath) => isBlankTab(tabPath) || !!findEntry(tabPath)) || '';
      if (activeTab && isBlankTab(activeTab)) { state.activeTab = activeTab; persistTabs(); renderTabs(); updateEditorVisibility(); }
      else if (activeTab) {
        state.restoringNotebookSelection = true;
        try { await openNote(activeTab, { reuseActiveTab: false, skipSave: true, noFocus: true, noRecent: true }); }
        finally { state.restoringNotebookSelection = false; }
      }
      else { renderTabs(); updateEditorVisibility(); }
      if (state.active && localStorage.getItem('canvas:noteSidebarView:v1') === 'browse') await setBrowserMode(true);
      document.documentElement.classList.remove('note-browser-restoring');
      updateBrowserControls();
      return true;
    })();
    state.initializePromise = initialize.finally(() => { state.initializePromise = null; });
    return state.initializePromise;
  }
  async function preload() { return initializeWorkspace(); }
  async function activate() {
    state.linksRefreshSuspended = false;
    const wasInitialized = state.initialized;
    state.active = true;
    if (noteBrowser && browserIntent) noteBrowser.resume();
    state.externalSyncUnchanged = 0;
    if (state.current && state.viewMode === 'reading' && !readingHost.firstChild) renderReadingDocument();
    if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(true);
    root.classList.add('active');
    const initialized = await initializeWorkspace();
    revealColdBoot();
    if (!initialized) return false;
    if (!root.classList.contains('note-browser-mode') && localStorage.getItem('canvas:noteSidebarView:v1') === 'browse') await setBrowserMode(true);
    window.RelatumStartupMark?.('notes-ready');
    if (wasInitialized) await triggerExternalSync({ silentErrors: true });
    else scheduleExternalSync();
    if (state.current) {
      resumeLinksRefresh();
      scheduleStatistics(state.current); scheduleDocumentPrefetch();
      if (state.viewMode === 'reading' && !readingHost.firstChild) renderReadingDocument();
      requestAnimationFrame(() => {
        if (state.active && state.current) focusEditor();
      });
    }
    return true;
  }
  async function deactivate() {
    state.linksRefreshSuspended = true; cancelLinksRefresh(); stopExternalSync();
    if (!(await flushSave())) { state.linksRefreshSuspended = false; resumeLinksRefresh(); scheduleExternalSync(); return false; }
    await flushNotebookSettings(); browserSequence++; browserIntent = root.classList.contains('note-browser-mode'); updateBrowserToggle();
    stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); persistViewStates();
    setNoteSettingsOpen(false, { restoreFocus: false }); setLibraryPanel('', { restoreFocus: false });
    if (noteBrowser) noteBrowser.suspend({ keepView: true });
    state.active = false;
    if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(false);
    root.classList.remove('tree-overlay-open'); closeContextMenu(); desktopDirty(false); return true;
  }
  // Retain the outgoing page until the workspace's slide finishes, then release
  // the reading DOM. Rapidly switching back must not clear the newly active page.
  new MutationObserver(() => {
    if (root.hidden && !state.active && window.RelatumNoteLiveEditor) window.RelatumNoteLiveEditor.releaseReadingDocument(readingHost);
  }).observe(root, { attributes: true, attributeFilter: ['hidden'] });

  root.addEventListener('click', async (event) => {
    if (state.imageTextBusy) return;
    const libraryAction = event.target.closest('[data-note-library-action]');
    if (libraryAction && librarySettings.contains(libraryAction)) {
      const command = libraryAction.dataset.noteLibraryAction;
      if (command === 'reset-open') toggleLibraryReset(libraryResetConfirm.hidden, true);
      else if (command === 'reset-cancel') toggleLibraryReset(false, true);
      else if (command === 'reset-accept') {
        if (state.renamePath && !(await finishInlineRename())) return;
        resetLibraryPreferences();
      }
      return;
    }
    const sortChoice = event.target.closest('[data-note-sort-mode]');
    if (sortChoice && root.contains(sortChoice)) {
      const fromMenu = sortMenu.contains(sortChoice);
      if (state.renamePath && !(await finishInlineRename())) return;
      setTreeSort(sortChoice.dataset.noteSortMode);
      if (fromMenu) setLibraryPanel('');
      return;
    }
    const nameChoice = event.target.closest('[data-note-name-mode]');
    if (nameChoice && librarySettings.contains(nameChoice)) {
      const mode = nameChoice.dataset.noteNameMode;
      if (mode === 'timestamp' || mode === 'custom') {
        state.newName.mode = mode;
        if (mode === 'custom' && !normalizeCustomBase(state.newName.baseName)) state.newName.baseName = tr('defaultCustomName');
        persistNewName(); renderLibraryPreferences();
        if (mode === 'custom') { libraryNameInput.focus(); libraryNameInput.select(); }
      }
      return;
    }
    const imageTextAction = event.target.closest('[data-image-text-action]');
    if (imageTextAction && imageTextTools && imageTextTools.contains(imageTextAction) && liveEditor) {
      if (imageTextAction.disabled) return;
      if (['merge', 'cleanup'].includes(imageTextAction.dataset.imageTextAction)) {
        await runImageTextOperation(imageTextAction.dataset.imageTextAction);
        return;
      }
      if (editorInputPending()) await whenEditorInputSettled();
      if (imageTextAction.disabled || !liveEditor || state.imageTextBusy) return;
      liveEditor.imageTextCommand(imageTextAction.dataset.imageTextAction, imageTextAction.dataset.imageTextValue || '');
      return;
    }
    const action = event.target.closest('[data-note-action]');
    if (!action) return;
    const name = action.dataset.noteAction;
    if (noteMovePromise) await waitForNoteMove();
    if (action.disabled || !noteActionAvailable(name)) return;
    if (name === 'toggle-browser') { setBrowserMode(!browserIntent); return; }
    if (name === 'toggle-image-text') {
      toggleImageTextMode(action);
      return;
    }
    if (editorInputPending()) await whenEditorInputSettled();
    if (action.disabled || !noteActionAvailable(name)) return;
    if (name === 'new-note') createEntry('note');
    else if (name === 'new-tab') openBlankTab();
    else if (name === 'close-all-tabs') { if (await finishInlineTitle()) await closeAllTabs(); }
    else if (name === 'new-folder') createEntry('folder');
    else if (name === 'refresh') triggerExternalSync({ announce: true });
    else if (name === 'toggle-sort') setLibraryPanel(state.libraryPanel === 'sort' ? '' : 'sort', { restoreFocus: false });
    else if (name === 'toggle-library-settings') setLibraryPanel(state.libraryPanel === 'settings' ? '' : 'settings', { restoreFocus: false });
    else if (name === 'toggle-all-folders') toggleAllFolders();
    else if (name === 'toggle-all-notebooks') toggleAllNotebooks();
    else if (name === 'new-notebook') createNotebook();
    else if (name === 'reveal-root' && state.notebookRoot !== null) reveal(state.notebookRoot, false);
    else if (name === 'toggle-focus') setFocusMode(!state.focusMode);
    else if (name === 'toggle-source' && state.current) await setViewMode(state.viewMode === 'source' ? 'live' : 'source');
    else if (name === 'toggle-settings') { if (!state.settingsOpen) setLibraryPanel('', { restoreFocus: false }); setNoteSettingsOpen(!state.settingsOpen); }
    else if (name === 'current-menu' && state.current) {
      if (contextMenu && !contextMenu.hidden && contextMenu.dataset.source === 'current-menu') {
        closeContextMenu();
        return;
      }
      const entry = findEntry(state.current.path) || { kind: 'note', path: state.current.path, name: noteTitle(state.current.path) };
      const rect = action.getBoundingClientRect();
      openContextMenu(entry, rect.right - 220, rect.bottom + 6, { viewModes: true, source: 'current-menu' });
    } else if (name === 'toggle-tree') root.classList.toggle('tree-overlay-open');
    else if (name === 'toggle-notebooks') setSideOpen(!root.classList.contains('links-overlay-open'));
    else if (name === 'side-notebooks') setSideMode('notebooks');
    else if (name === 'side-links') setSideMode('links');
    else if (name === 'side-canvas') setSideMode('canvas');
    else if (name === 'side-guide') setSideMode('guide');
    else if (name === 'close-links') setSideOpen(false);
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!state.active || !target
        || target.closest('[data-role="note-image-text-tools"], [data-role="note-image-text-toggle"]')) return;
    // Any newer page interaction supersedes a toggle that may still be waiting
    // for the native input chain. Otherwise that stale click can reopen or
    // close the toolbar after the user has already moved on.
    state.imageText.toggleSeq += 1;
    state.imageText.toggleIntent = null;
    if (state.imageTextCleanupPath) { state.imageTextCleanupPath = ''; updateImageTextTools(); }
    if (!state.imageText.active || !liveEditor || editorInputPending()) return;
    const selectedFrame = editorHost && editorHost.querySelector('.note-live-image-frame.is-selected');
    if (selectedFrame && selectedFrame.contains(target)) return;
    // The editor content does not cover the complete document width. Treat
    // the surrounding page, including the far-right blank strip, as a real
    // outside click instead of relying on CodeMirror to move its selection.
    liveEditor.setImageTextMode(false);
  }, true);
  if (settingsShortcutList) {
    settingsShortcutList.addEventListener('click', (event) => {
      const action = event.target.closest('[data-note-shortcut-action]');
      if (!action) return;
      const commandId = action.dataset.noteShortcutCommand || '';
      if (action.dataset.noteShortcutAction === 'record') beginShortcutRecording(commandId);
      else if (action.dataset.noteShortcutAction === 'remove') removeShortcutBinding(commandId, action.dataset.noteShortcutBinding || '');
    });
  }
  if (settingsPop) {
    settingsPop.addEventListener('scroll', () => settingsPop.classList.toggle('is-scrolled', settingsPop.scrollTop > 3), { passive: true });
    settingsPop.addEventListener('click', (event) => {
      const action = event.target.closest('[data-note-settings-action]');
      if (!action) return;
      if (action.dataset.noteSettingsAction === 'reset-open') toggleNoteSettingsReset(settingsResetConfirm && settingsResetConfirm.hidden);
      else if (action.dataset.noteSettingsAction === 'reset-cancel') toggleNoteSettingsReset(false);
      else if (action.dataset.noteSettingsAction === 'reset-accept') resetNoteSettings();
    });
  }
  if (libraryNameInput) {
    libraryNameInput.addEventListener('input', () => {
      const base = normalizeCustomBase(libraryNameInput.value);
      if (base) { state.newName.baseName = base; persistNewName(); }
      updateNamePreview();
    });
    libraryNameInput.addEventListener('blur', () => {
      if (!normalizeCustomBase(libraryNameInput.value)) {
        libraryNameInput.value = state.newName.baseName || tr('defaultCustomName');
        updateNamePreview();
      }
    });
  }
  if (sortMenu) sortMenu.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(sortMenu.querySelectorAll('[data-note-sort-mode]'));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
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
  function selectTreeRoot() {
    state.rootTargeted = true;
    state.selectedPath = '';
    state.selectedFolder = state.notebookRoot;
    updateTreeSelection();
  }
  async function finishNotebookInteraction() {
    if (!(await finishInlineTitle())) return false;
    if (state.renamePath && !(await finishInlineRename())) return false;
    if (editorInputPending()) await whenEditorInputSettled();
    return state.active && state.sideMode === 'notebooks';
  }
  notebooksContent?.addEventListener('click', async (event) => {
    if (event.target.closest('.note-tree-row, .note-tree-inline-error')) return;
    const sequence = ++notebookSelectionSequence;
    if (!(await finishNotebookInteraction()) || sequence !== notebookSelectionSequence) return;
    if (browserIntent || root.classList.contains('note-browser-mode')) {
      await setBrowserMode(false);
      if (root.classList.contains('note-browser-mode') || sequence !== notebookSelectionSequence) return;
    }
    closeContextMenu(); selectNotebook(null, { rootTarget: true });
    state.selectedPath = ''; treeEl.classList.remove('note-drop-root'); updateTreeSelection();
  });
  notebooksContent?.addEventListener('contextmenu', async (event) => {
    if (event.target.closest('.note-tree-row, .note-tree-inline-error')) return;
    event.preventDefault(); event.stopPropagation();
    const sequence = ++notebookSelectionSequence;
    if (!(await finishNotebookInteraction()) || sequence !== notebookSelectionSequence) return;
    showContext([contextButton(notebookCopy('create'), createNotebook), contextButton(tr('explorer'), () => reveal('', false))], event.clientX, event.clientY);
  });
  treeEl.addEventListener('click', async (event) => {
    if (event.target.closest('.note-tree-row')) return;
    if (!(await finishInlineTitle())) return;
    if (state.renamePath && !(await finishInlineRename())) return;
    closeContextMenu();
    selectTreeRoot();
  });
  treeEl.addEventListener('contextmenu', async (event) => {
    if (event.target.closest('.note-tree-row')) return;
    event.preventDefault();
    if (!(await finishInlineTitle())) return;
    if (state.renamePath && !(await finishInlineRename())) return;
    selectTreeRoot();
    if (state.notebookRoot === null) return;
    openContextMenu(null, event.clientX, event.clientY);
  });
  treeEl.addEventListener('dragover', (event) => { if (event.target.closest('.note-tree-row')) return; if (state.notebookRoot === null) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; return; } const external = Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file'); if (!state.draggedPath && !external) return; event.preventDefault(); event.dataTransfer.dropEffect = state.draggedPath ? 'move' : 'copy'; treeEl.classList.add('note-drop-root'); });
  treeEl.addEventListener('dragleave', (event) => { if (!treeEl.contains(event.relatedTarget)) treeEl.classList.remove('note-drop-root'); });
  treeEl.addEventListener('drop', (event) => { if (event.target.closest('.note-tree-row')) return; event.preventDefault(); treeEl.classList.remove('note-drop-root'); if (state.notebookRoot === null) return; if (state.draggedPath) moveEntry(state.draggedPath, state.notebookRoot); else importDataTransfer(event.dataTransfer, state.notebookRoot); });
  document.addEventListener('pointerdown', (event) => {
    const dismissCanvasByRightClick = event.button === 2 && contextMenu?.dataset.source === 'canvas';
    if (contextMenu && !contextMenu.hidden && !dismissCanvasByRightClick && !contextMenu.contains(event.target) && !event.target.closest('[data-note-action="current-menu"]')) closeContextMenu();
    if (state.libraryPanel && !event.target.closest('.note-library-popover') && !event.target.closest('[data-note-action="toggle-sort"]') && !event.target.closest('[data-note-action="toggle-library-settings"]')) {
      setLibraryPanel('', { restoreFocus: false });
    }
    if (state.settingsOpen && settingsPop && settingsTrigger && !settingsPop.contains(event.target) && !settingsTrigger.contains(event.target)) {
      setNoteSettingsOpen(false, { restoreFocus: false });
    }
  });
  document.addEventListener('contextmenu', (event) => {
    if (!contextMenu || contextMenu.hidden || contextMenu.dataset.source !== 'canvas') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeContextMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if ((state.imageTextBusy || state.assetCleanupBusy) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); return; }
    if (!state.active) return;
    if (state.recordingShortcutCommand && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { stopShortcutRecording(true); return; }
      const binding = NOTE_SHORTCUTS && NOTE_SHORTCUTS.bindingFromEvent(event);
      if (binding) acceptShortcutBinding(state.recordingShortcutCommand, binding);
      else setShortcutStatus(noteSettingsCopy('invalid'));
      return;
    }
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab' && canToggleSideByTab(event)) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) setSideOpen(!root.classList.contains('links-overlay-open'));
      return;
    }
    if (state.libraryPanel && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (libraryResetConfirm && !libraryResetConfirm.hidden) toggleLibraryReset(false, true);
      else setLibraryPanel('');
      return;
    }
    if (state.settingsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (settingsResetConfirm && !settingsResetConfirm.hidden) toggleNoteSettingsReset(false);
      else setNoteSettingsOpen(false);
      return;
    }
    if ((state.imageText.active || state.imageTextCleanupPath) && event.key === 'Escape') {
      event.preventDefault();
      state.imageTextCleanupPath = '';
      liveEditor.setImageTextMode(false);
      updateImageTextTools();
      return;
    }
    const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
    if (mod && key === 'n') { event.preventDefault(); if (noteActionAvailable('new-note')) createEntry('note'); }
    else if (mod && key === 't') { event.preventDefault(); openBlankTab(); }
    else if (mod && key === 'w' && state.activeTab) { event.preventDefault(); closeTab(state.activeTab); }
    else if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); switchTab(event.shiftKey ? -1 : 1); }
    else if (mod && /^[1-9]$/.test(event.key) && state.tabs.length) { event.preventDefault(); const index = event.key === '9' ? state.tabs.length - 1 : Math.min(Number(event.key) - 1, state.tabs.length - 1); activateTab(state.tabs[index]); }
    else if (event.key === 'F2' && (state.selectedPath || state.current)) { event.preventDefault(); if (!browserResultsActive()) beginInlineRename(state.selectedPath || state.current.path); }
    else if (event.key === 'Escape') { closeContextMenu(); root.classList.remove('tree-overlay-open'); }
  });
  function flushWorkspaceState(keepalive) {
    const save = (async () => {
      if (!(await flushCanvases())) return false;
      if (state.current && !(await flushSave())) return false;
      for (const cached of state.documentCache.values()) if (cached !== state.current && hasPendingEdits(cached) && !(await flushSave(cached))) return false;
      return true;
    })();
    persistViewStates();
    const settings = flushNotebookSettings(keepalive);
    return Promise.all([save, settings]).then(([saved]) => saved);
  }
  window.addEventListener('blur', () => { closeContextMenu(); flushWorkspaceState(); });
  window.addEventListener('relatum:note-canvas-dirty', () => desktopDirty(hasPendingEdits()));
  window.addEventListener('relatum:note-canvas-error', event => { showSaveError(event.detail); desktopDirty(true); });
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('relatum:languagechange', closeContextMenu);
  window.addEventListener('focus', () => { if (state.active && !document.hidden) { state.externalSyncUnchanged = 0; scheduleStatistics(state.current); scheduleDocumentPrefetch(); triggerExternalSync({ silentErrors: true }); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelLinksRefresh(); if (noteBrowser) noteBrowser.suspend({ keepView: true }); closeContextMenu(); stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); flushWorkspaceState(); }
    else if (state.active) { if (noteBrowser && browserIntent) noteBrowser.resume(); state.externalSyncUnchanged = 0; resumeLinksRefresh(); scheduleStatistics(state.current); scheduleDocumentPrefetch(); triggerExternalSync({ silentErrors: true }); }
  });
  window.addEventListener('pagehide', () => { state.linksRefreshSuspended = true; cancelLinksRefresh(); if (noteBrowser) noteBrowser.suspend({ keepView: true }); closeContextMenu(); stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); flushWorkspaceState(true); });
  window.addEventListener('pageshow', () => { state.linksRefreshSuspended = false; resumeLinksRefresh(); });
  window.addEventListener('beforeunload', () => { cancelLinksRefresh(); stopExternalSync(); flushWorkspaceState(true); });
  document.addEventListener('relatum:languagechange', () => { updateSidePanel(); updateBrowserToggle(); if (noteBrowser) noteBrowser.setLanguage(); renderTree(); renderTabs(); renderLinks(); renderLibraryPreferences(); renderCurrentPath(state.openingPath || (state.current && state.current.path) || ''); updateFocusToggle(); updateViewToggle(); updateImageTextTools(); if (state.settingsOpen) renderNoteShortcutSettings(); if (state.current) { rememberEditorState(state.current); updateDocumentStats(null, state.current.characterCount, state.current.wordCount); } });
  if (window.CanvasDesktop && typeof window.CanvasDesktop.setBeforeCloseHandler === 'function') window.CanvasDesktop.setBeforeCloseHandler(flushWorkspaceState);
  initializeEditor(); renderTabs(); updateEditorVisibility(); renderLinks(); renderLibraryPreferences(); updateSidePanel(); updateFocusToggle(); updateImageTextTools(); syncNoteSettingsFontScale(); renderNoteShortcutSettings();
  updateBrowserControls();
  window.CanvasNoteWorkspace = { activate, deactivate, preload, flushSave, toggleCanvasPanel, refresh: (announce) => triggerExternalSync({ announce: !!announce }), get dirty() { return hasPendingEdits() || !!window.RelatumNoteCanvas?.dirty; }, get currentPath() { return state.current ? state.current.path : ''; } };
})();

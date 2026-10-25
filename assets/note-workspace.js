// 起步页托管 Markdown 笔记库。文件树和编辑器保持直接、无感，首次进入时按需加载。
(function () {
  'use strict';
  const root = document.querySelector('[data-start-workspace-panel="notes"]');
  if (!root) return;
  function notePageVisible() {
    return !document.hidden && document.documentElement.dataset.desktopMinimized !== '1';
  }
  function noteWorkspaceVisible() { return state.active && !root.hidden && notePageVisible(); }
  let noteVisibilityEpoch = 0, notePageWasVisible = notePageVisible();
  // Settings keep their unique data-role after moving into the top-layer dialog.
  const $ = (selector, scope) => (scope || root).querySelector(selector)
    || (!scope ? document.querySelector('[data-role="note-settings-dialog"]')?.querySelector(selector) : null);
  const treeEl = $('[data-role="note-tree"]');
  const sidebarScroll = $('[data-role="note-sidebar-scroll"]');
  const notebookTreeEl = $('[data-role="note-notebook-tree"]');
  const treeRowIndexes = new Map([treeEl, notebookTreeEl].filter(Boolean).map((host) =>
    [host, { rows: new Map(), selectionPaths: new Set(), selectionKey: null }]));
  const notebooksContent = $('[data-role="note-notebooks-content"]');
  const sidePane = $('.note-links-pane');
  const NOTEBOOK_CONTAINER = 'CustomNotebook';
  const NOTEBOOK_COLORS = ['gray', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'purple'];
  let notebookSettingsTimer = 0, notebookSettingsChain = Promise.resolve(true), notebookSettingsPending = {};
  const tabsEl = $('[data-role="note-tabs"]');
  const tabBar = $('.note-tab-bar');
  const tabActions = $('.note-tab-actions');
  const newTabButton = $('[data-note-action="new-tab"]');
  const closeAllTabsButton = $('[data-note-action="close-all-tabs"]');
  const noteSystem = window.RelatumNoteSystem;
  const tabMotionPreference = noteSystem?.motion || window.matchMedia('(prefers-reduced-motion: reduce)');
  const tabCloseAnimations = new Map();
  let tabCloseMotionPending = false, tabCloseClipActive = false, tabScrollFrame = 0, tabCloseMotionScrollLeft = 0;
  let tabCloseMotionUntil = 0, tabCloseScrollPending = null;
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
  let activeNoteModal = null;
  const errorBar = $('[data-role="note-error"]');
  const sideTitle = $('[data-role="note-side-title"]');
  const linksContent = $('[data-role="note-links-content"]');
  const canvasSettingsContent = $('[data-role="note-canvas-settings"]');
  const guideContent = $('[data-role="note-guide"]');
  const outlineContent = $('[data-role="note-outline"]');
  const aiContent = $('[data-role="note-ai"]');
  let aiController = null, aiLoader = null, aiSequence = 0, aiSettingsHost = null, aiChatHost = null, sidePreferences = null;
  let aiSettingsCategory = '', aiDialogReturning = false, aiPageHiding = false;
  let noteOutline = null, outlineLoader = null, outlineLoadSequence = 0;
  const settingsTrigger = $('[data-note-action="toggle-settings"]');
  const settingsPop = $('[data-role="note-settings-pop"]');
  const settingsShortcutList = $('[data-role="note-shortcut-list"]');
  const settingsShortcutStatus = $('[data-role="note-shortcut-status"]');
  const selectionMatchHighlightToggle = $('[data-role="note-selection-match-highlight"]');
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
  let settingsDialog = null, canvasStylePanel = null, guideController = null, guideLoader = null, guideSequence = 0;
  const GUIDE_TOPIC_KEY = 'canvas:noteGuideTopic:v1';
  let guideTopic = 'callout';
  try { const saved = localStorage.getItem(GUIDE_TOPIC_KEY); if (['callout', 'markdown', 'mermaid'].includes(saved)) guideTopic = saved; } catch (_) {}
  let liveEditor = null;
  let noteBrowser = null, browserLoader = null, browserSequence = 0, browserIntent = false;
  let browserFolderIndex = null, browserFolderSize = -1, browserFolderPaths = [];
  let treeNameLocale = '', treeNameComparator = null;
  function browserFolders() {
    const index = state.entryIndex;
    if (browserFolderIndex !== index || browserFolderSize !== index.size) {
      browserFolderIndex = index; browserFolderSize = index.size;
      browserFolderPaths = Array.from(index.values()).filter(entry => entry.kind === 'folder' && entry.path !== NOTEBOOK_CONTAINER).map(entry => entry.path);
    }
    return browserFolderPaths;
  }
  let noteGraph = null, noteGraphLoader = null, noteGraphIntentSequence = 0;
  let noteGraphForeground = false;
  function backgroundTargetChanged(cancel = false) {
    document.dispatchEvent(new CustomEvent('relatum:note-graph-target', { detail: { cancel } }));
  }
  async function withNoteBusy(task) {
    const release = window.RelatumBackgroundPreparation?.beginBusy();
    try { return await task(); } finally { release?.(); }
  }
  const GRAPH_TAB = 'relatum:graph-tab:v1';
  const graphHost = $('[data-role="note-graph-panel"]');
  const graphEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.graph');
  let graphPresentation = false, graphSidebar = null;
  let sideCloseTask = null, sideMotionSequence = 0;
  let noteMovePromise = null, noteMovePaths = null;
  let noteTreeDragRow = null, notebookDropRunning = false;
  let noteOpenAttempt = null;
  const canvasEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.canvas');
  const aiEnabled = () => !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.ai');
  const sideAvailable = id => (id !== 'canvas' || canvasEnabled()) && (id !== 'ai' || aiEnabled());
  const sidePages = () => sidePreferences?.visible() || ['notebooks', 'outline', 'canvas', 'guide', 'links', 'ai'].filter(sideAvailable);
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
  const browserDisclosure = $('[data-role="note-browser-disclosure"]');
  const browserResults = $('[data-role="note-browser-results"]');
  const browserBack = $('[data-role="note-browser-back"]');
  const browserToggle = $('[data-note-action="toggle-browser"]');
  const graphToggle = $('[data-note-action="toggle-graph"]');
  function updateNoteGraphSession(source, destination) {
    if (destination === undefined) noteGraph?.prune(source);
    else noteGraph?.remap(source, destination);
  }
  function isGraphTab(tab) { return tab === GRAPH_TAB; }
  function isSpecialTab(tab) { return isGraphTab(tab) || isBlankTab(tab); }
  function graphContentActive() {
    return graphEnabled() && graphPresentation && isGraphTab(state.activeTab) && noteWorkspaceVisible()
      && !browserResultsActive();
  }
  function effectiveSideMode() { return graphPresentation ? 'notebooks' : state.sideMode; }
  function setGraphPresentation(show) {
    if (graphPresentation === show) return;
    const tabMotion = tabCloseAnimations.size ? captureTabCloseMotion(true) : null;
    cancelSideClose();
    graphPresentation = show;
    if (show) {
      graphSidebar = { open: root.classList.contains('links-overlay-open'), mode: state.sideMode };
      root.classList.remove('links-overlay-open');
    } else {
      noteGraphIntentSequence++; noteGraph?.deactivate();
      if (graphSidebar) root.classList.toggle('links-overlay-open', graphSidebar.open);
      graphSidebar = null;
    }
    root.classList.toggle('note-graph-active', show);
    if (graphHost) { graphHost.hidden = !show; graphHost.inert = !show; }
    updateSidePanel(); updateGraphToggle();
    scheduleSideClose();
    playTabCloseMotion(tabMotion);
    document.dispatchEvent(new Event('relatum:usage-target'));
  }
  function graphLoadStatus(error) {
    const message = graphHost?.querySelector('[data-role="note-graph-load-message"]');
    if (!message) return;
    message.querySelector('span').textContent = error ? (error.message || tr('readFailed'))
      : language() === 'en' ? 'Loading notebook graph…' : '正在读取笔记图谱…';
    const retry = message.querySelector('button'); retry.hidden = !error; retry.textContent = language() === 'en' ? 'Retry' : '重试';
  }
  async function resumeNoteGraph() {
    if (!graphContentActive()) return false;
    const sequence = noteGraphIntentSequence, scope = state.notebookRoot;
    graphLoadStatus();
    try {
      const graph = await loadNoteGraph();
      if (sequence !== noteGraphIntentSequence || !graphContentActive() || scope !== state.notebookRoot) return false;
      return await graph.activate();
    } catch (error) {
      if (sequence === noteGraphIntentSequence && graphContentActive()) graphLoadStatus(error);
      return false;
    }
  }
  function updateGraphToggle() {
    if (!graphToggle) return;
    const selected = state.notebookRoot !== null;
    const label = selected ? (language() === 'en' ? 'Notebook graph' : '笔记本图谱')
      : (language() === 'en' ? 'Select a notebook first' : '请先选择笔记本');
    graphToggle.hidden = !graphEnabled(); graphToggle.disabled = !selected || !graphEnabled();
    graphToggle.removeAttribute('title');
    graphToggle.dataset.uiTooltip = label; graphToggle.dataset.uiTooltipSource = label;
    graphToggle.setAttribute('aria-label', label);
    graphToggle.setAttribute('aria-controls', 'note-graph-panel');
    graphToggle.setAttribute('aria-expanded', String(graphPresentation));
  }
  async function prepareNoteGraph() {
    await waitForNoteMove();
    if (!(await beforeBrowse())) return false;
    const scope = state.notebookRoot;
    for (const cached of Array.from(state.documentCache.values())) {
      if (cached !== state.current && notebookRootForPath(cached.path) === scope
          && hasPendingEdits(cached) && !(await flushSave(cached))) return false;
    }
    return noteWorkspaceVisible() && scope === state.notebookRoot;
  }
  async function loadNoteGraph(settings = {}) {
    if (!settings.waitForIdle) { noteGraphForeground = true; window.RelatumBackgroundPreparation?.wake(); }
    if (!graphEnabled()) return null;
    if (noteGraph) return noteGraph;
    if (!noteGraphLoader) noteGraphLoader = (async () => {
      for (const [name, exported] of [['graph-gl.js', 'GraphGL'], ['graph-engine.js', 'GraphEngine'],
        ['note-graph.js', 'RelatumNoteGraph']]) {
        if (window[exported]) continue;
        if (settings.waitForIdle) await settings.waitForIdle(window.RelatumBackgroundPreparation?.signal,
          () => noteGraphForeground);
        await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = name; script.async = true;
          script.onload = () => {
            if (window[exported]) resolve();
            else { script.remove(); reject(new Error(tr('readFailed'))); }
          };
          script.onerror = () => { script.remove(); reject(new Error(tr('readFailed'))); };
          document.head.appendChild(script);
        });
      }
      noteGraph = window.RelatumNoteGraph.create({ host: graphHost, request, language,
        getRoot: () => state.notebookRoot, isActive: graphContentActive,
        onSelect: (path, valid) => openNote(path, { reuseActiveTab: false, graphGuard: valid }),
        showError: (message) => showToast(message || tr('readFailed'), 'error'),
      });
      if (!noteGraph) throw new Error(tr('readFailed'));
      return noteGraph;
    })().catch((error) => { noteGraphLoader = null; noteGraphForeground = false; throw error; });
    return noteGraphLoader;
  }
  async function activateGraphTab(options) {
    if (!graphEnabled()) return false;
    if (!noteWorkspaceVisible()) return false;
    if (graphPresentation && !browserResultsActive()) {
      await resumeNoteGraph();
      if (!options?.noFocus && graphContentActive()) graphHost?.focus({ preventScroll: true });
      return true;
    }
    const sequence = ++noteGraphIntentSequence;
    const scope = state.notebookRoot, previousTab = state.activeTab, previousDocument = state.current;
    try {
      await loadNoteGraph();
      if (!(await prepareNoteGraph())) return false;
      if (sequence !== noteGraphIntentSequence || !noteWorkspaceVisible() || scope !== state.notebookRoot
          || state.activeTab !== previousTab || state.current !== previousDocument) return false;
      if (noteBrowser) noteBrowser.showDocument();
      if (!state.tabs.includes(GRAPH_TAB)) state.tabs.push(GRAPH_TAB);
      state.activeTab = GRAPH_TAB;
      clearCurrent({ keepTabs: true, keepActiveTab: true, keepCache: true });
      await resumeNoteGraph();
      if (!options?.noFocus && graphContentActive()) graphHost?.focus({ preventScroll: true });
      return true;
    } catch (error) { if (sequence === noteGraphIntentSequence) showToast(error.message || tr('readFailed'), 'error'); return false; }
  }
  function toggleNoteGraph() {
    if (state.notebookRoot !== null) activateGraphTab();
  }
  function browserResultsActive() {
    return root.classList.contains('note-browser-showing-results');
  }
  function noteActionAvailable(name) {
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
    closeWorkspacePopovers();
    if (liveEditor) liveEditor.setImageTextMode(false);
    return true;
  }
  function showBrowserResults(show) {
    root.classList.toggle('note-browser-showing-results', show);
    $('.note-document-body')?.toggleAttribute('inert', show || !!noteMovePromise);
    updateBrowserControls();
    updateEditorVisibility();
    if (!show && graphPresentation) resumeNoteGraph();
    syncOutline();
  }
  async function loadNoteBrowser() {
    if (noteBrowser) return noteBrowser;
    if (!browserLoader) browserLoader = (async () => {
      if (!window.RelatumNoteBrowser) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = 'note-browser.js'; script.async = true;
        script.onload = resolve; script.onerror = () => reject(new Error(tr('readFailed'))); document.head.appendChild(script);
      });
      noteBrowser = window.RelatumNoteBrowser.create({ root, navigation: browserNavigation, results: browserResults, back: browserBack,
        request, query: (query, options) => post('/api/note-query', query, options), language, icon: noteIcon,
        getEntries: () => flattenEntries(state.entries, []), getRecent: () => Object.fromEntries(recentFiles),
        getFolderPaths: browserFolders,
        pruneRecent: (paths) => {
          const missing = new Set(paths.map(path => path.normalize('NFC').toLocaleLowerCase()));
          let changed = false;
          for (const path of recentFiles.keys()) if (missing.has(path.normalize('NFC').toLocaleLowerCase())) { recentFiles.delete(path); changed = true; }
          if (changed) persistRecent();
        },
        getNotebooks: () => notebookRoots().map(entry => ({ path: entry.path, name: entry.name })), getIndexState: () => state.indexState,
        beforeBrowse, showResults: showBrowserResults, openNote: openSearchNote,
        onPopoverOpen: () => closeWorkspacePopovers(),
        canvasEnabled, revealCanvas: (path) => post('/api/notes-canvas/reveal', { path }), showError: (message) => showToast(message, 'error'),
      });
      return noteBrowser;
    })().catch((error) => { browserLoader = null; throw error; });
    return browserLoader;
  }
  function updateBrowserToggle() {
    if (!browserToggle) return;
    const label = language() === 'en' ? (browserIntent ? 'Collapse note browsing' : 'Expand note browsing') : (browserIntent ? '收起笔记浏览' : '展开笔记浏览');
    browserToggle.setAttribute('aria-label', label); browserToggle.removeAttribute('title');
    browserToggle.dataset.uiTooltip = label; browserToggle.dataset.uiTooltipSource = label;
    browserToggle.setAttribute('aria-pressed', String(browserIntent)); browserToggle.setAttribute('aria-expanded', String(browserIntent));
  }
  let browserCloseTimer = 0;
  const browserMotion = tabMotionPreference;
  function finishBrowserCollapse() {
    if (!browserIntent) browserDisclosure.hidden = true;
  }
  function setBrowserDisclosure(open) {
    clearTimeout(browserCloseTimer);
    browserDisclosure.inert = !open; browserDisclosure.setAttribute('aria-hidden', String(!open));
    if (!open && browserDisclosure.contains(document.activeElement)) browserToggle.focus({ preventScroll: true });
    if (open && browserDisclosure.hidden) {
      browserDisclosure.hidden = false;
      // Establish the collapsed height once. CSS reverses ongoing transitions
      // from their current progress; neither navigation nor tree rows remount.
      if (!browserMotion.matches) void browserDisclosure.offsetHeight;
    }
    browserDisclosure.classList.toggle('is-open', open);
    if (!open) {
      if (browserMotion.matches) finishBrowserCollapse();
      else browserCloseTimer = setTimeout(finishBrowserCollapse, 240);
    }
  }
  browserDisclosure.addEventListener('transitionend', (event) => {
    if (event.target === browserDisclosure && event.propertyName === 'grid-template-rows') finishBrowserCollapse();
  });
  browserMotion.addEventListener('change', () => { if (browserMotion.matches) { clearTimeout(browserCloseTimer); finishBrowserCollapse(); } });
  // A disclosure click must leave the current native input/IME host focused.
  // Capture before editor outside-click handlers can settle their drafts.
  window.addEventListener('pointerdown', (event) => {
    if (event.button === 0 && browserToggle.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  async function setBrowserMode(enabled, tag) {
    if (!state.active) return;
    const sequence = ++browserSequence; browserIntent = enabled;
    root.classList.toggle('note-browser-mode', enabled);
    try { localStorage.setItem('canvas:noteSidebarView:v1', enabled ? 'browse' : 'tree'); } catch (error) {}
    updateBrowserToggle();
    if (noteBrowser) noteBrowser.setNavigationOpen(enabled);
    if (!enabled) { setBrowserDisclosure(false); return; }
    if (!noteWorkspaceVisible()) return;
    try {
      const browser = await loadNoteBrowser();
      if (sequence !== browserSequence || !noteWorkspaceVisible()) return;
      browser.activate({ navigationOpen: true }); setBrowserDisclosure(true);
      if (tag) await browser.browseTag(tag);
    } catch (error) {
      if (sequence !== browserSequence || !noteWorkspaceVisible()) return;
      browserIntent = false; root.classList.remove('note-browser-mode'); setBrowserDisclosure(false);
      if (noteBrowser) noteBrowser.setNavigationOpen(false);
      try { localStorage.setItem('canvas:noteSidebarView:v1', 'tree'); } catch (storageError) {}
      updateBrowserToggle(); showToast(error.message || tr('readFailed'), 'error');
    }
  }
  let bodyMenuContext = null, bodyMenuSubmenu = null, bodyMenuParent = null;
  let imageCopyController = null;
  let contextOpen = false, contextFrame = 0, contextTimer = 0, contextSequence = 0, contextReturnFocus = null;
  let contextTooltipBlocked = false;
  let submenuFrame = 0, submenuTimer = 0, closingSubmenu = null;
  let settingsMotionSequence = 0, libraryMotionSequence = 0;
  let statisticsTimer = 0, statisticsFrame = 0, statisticsJob = null;
  let prefetchEpoch = 0, prefetchRunning = false, hoverPrefetchTimer = 0, hoverPrefetchPath = '';

  const ACTIVE_PATH_KEY = 'canvas:noteActivePath:v1';
  const ACTIVE_TAB_KEY = 'canvas:noteActiveTab:v1';
  const OPEN_TABS_KEY = 'canvas:noteOpenTabs:v1';
  const EXPANDED_KEY = 'canvas:noteExpandedFolders:v1';
  const NOTE_VIEW_KEY = 'canvas:noteView:v1';
  const SELECTION_MATCH_HIGHLIGHT_KEY = 'canvas:noteSelectionMatchHighlight:v1';
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
  const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
  const COPY = {
    'zh-CN': {
      loading: '正在读取笔记库…', emptyTree: '还没有笔记', select: '选择一篇笔记', readFailed: '读取笔记失败',
      saveFailed: '保存失败，请检查磁盘空间或目录权限', newNote: '新建笔记', newFolder: '新建文件夹', rename: '重命名',
      moveFailed: '移动失败', explorer: '在系统资源管理器中显示', openLibrary: '在资源管理器中打开笔记库',
      canvasExplorer: '在系统资源管理器中打开',
      openExplorer: '在资源管理器中打开',
      assets: '打开伴生素材目录', recycle: '移到系统回收站', recycled: '已移到系统回收站', refresh: '刷新',
      refreshed: '笔记库已刷新', copyPath: '复制库内路径', copied: '路径已复制', open: '打开', createHere: '在此新建笔记',
      createFolderHere: '新建子文件夹', noAssets: '当前笔记还没有伴生素材', revealFailed: '无法在资源管理器中显示',
      importFailed: '导入失败', imported: '已导入 {count} 篇笔记', unsupportedSkipped: '已跳过 {count} 个不支持的文件',
      uploadFailed: '图片保存失败', imageUploadTooLarge: '图片过大（上限 40MB）', svgUploadTooLarge: 'SVG 图片过大（上限 4MiB）', linkWarnings: '已移动；{count} 个歧义双链保持原样', ambiguous: '同名笔记不唯一',
      imageCopyFailed: '复制图片失败，请检查图片是否可读取及剪贴板权限。', imageCopyTooLarge: '图片尺寸过大，无法复制。',
      missing: '尚未创建', noOutgoing: '当前笔记没有出链', noBacklinks: '当前笔记没有反向链接',
      cancel: '取消',
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
      openExplorer: 'Open in File Explorer',
      assets: 'Open companion assets', recycle: 'Move to Recycle Bin', recycled: 'Moved to Recycle Bin', refresh: 'Refresh',
      refreshed: 'Notes refreshed', copyPath: 'Copy vault path', copied: 'Path copied', open: 'Open', createHere: 'New note here',
      createFolderHere: 'New subfolder', noAssets: 'This note has no companion assets',
      revealFailed: 'Could not show this item in File Explorer', importFailed: 'Import failed', imported: 'Imported {count} notes',
      unsupportedSkipped: 'Skipped {count} unsupported files', uploadFailed: 'Could not save image', imageUploadTooLarge: 'Image is too large (40MB limit)', svgUploadTooLarge: 'SVG image is too large (4MiB limit)',
      imageCopyFailed: 'Could not copy image. Check that the image is readable and clipboard access is allowed.', imageCopyTooLarge: 'This image is too large to copy.',
      linkWarnings: 'Moved; {count} ambiguous links were unchanged', ambiguous: 'Duplicate note name', missing: 'Not created',
      noOutgoing: 'No outgoing links', noBacklinks: 'No backlinks', cancel: 'Cancel',
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
    viewMode: 'live', selectionMatchHighlight: false, settingsOpen: false, recordingShortcutCommand: '',
    treeSort: 'modified-desc', newName: { mode: 'timestamp', baseName: '' }, libraryPanel: '', libraryPanelTimers: {}, pendingTreeReorder: false, renderedOrder: '',
    imageText: {
      available: false, active: false, armed: false, selectedId: '', size: 'md', color: 'white', canDelete: false,
      toggleSeq: 0, toggleIntent: null,
    },
    shortcutBindings: NOTE_SHORTCUTS ? NOTE_SHORTCUTS.load() : {},
  };
  try { const stored = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); if (Array.isArray(stored)) state.expanded = new Set(stored); } catch (error) {}
  try { const stored = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '[]'); if (Array.isArray(stored)) state.tabs = Array.from(new Set(stored.filter((path) => typeof path === 'string'))); } catch (error) {}
  if (!graphEnabled()) state.tabs = state.tabs.filter(path => !isGraphTab(path));
  try { const stored = localStorage.getItem(ACTIVE_TAB_KEY) || ''; if (state.tabs.includes(stored)) state.activeTab = stored; } catch (error) {}
  try { state.viewMode = normalizeViewMode(localStorage.getItem(NOTE_VIEW_KEY)); } catch (error) {}
  try { state.selectionMatchHighlight = localStorage.getItem(SELECTION_MATCH_HIGHLIGHT_KEY) === '1'; } catch (error) {}
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
      conflict: ['与“{name}”冲突', 'Conflicts with “{name}”'],
    };
    return (copy[key] || ['', ''])[english ? 1 : 0];
  }

  function notebookCopy(key) {
    const labels = {
      notebooks: ['笔记本', 'Notebooks'], links: ['链接', 'Links'], canvas: ['画布', 'Canvas'], guide: ['引导', 'Guide'], outline: ['大纲', 'Outline'], ai: ['AI', 'AI'],
      create: ['新建笔记本', 'New notebook'], close: ['关闭侧栏', 'Close sidebar'],
      expandSide: ['展开', 'Expand'], collapseSide: ['收起', 'Collapse'],
      expandSideLabel: ['展开右侧面板', 'Expand right sidebar'], collapseSideLabel: ['收起右侧面板', 'Collapse right sidebar'],
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
      ...(container?.children || []).filter((entry) => entry.kind === 'folder').slice().sort((a, b) => compareTreeNames(a.name, b.name))
        .map((entry) => ({ ...entry, notebook: true }))];
  }
  function notebookUi() {
    return { open: graphSidebar ? graphSidebar.open : root.classList.contains('links-overlay-open'),
      mode: graphSidebar ? graphSidebar.mode : state.sideMode, selectedRoot: state.notebookRoot, expanded: Array.from(state.notebookExpanded) };
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
    state.sideMode = sidePages().includes(ui.mode) ? ui.mode : sidePages()[0] || 'notebooks';
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
      noteGraphIntentSequence++; noteGraph?.deactivate(); updateNoteGraphSession(state.notebookRoot);
      missing.add(state.notebookRoot); state.notebookRoot = ''; state.selectedFolder = ''; state.selectedPath = ''; state.rootTargeted = true;
      backgroundTargetChanged();
    }
    state.notebookPruning.forEach((time, path) => { if (findEntry(path)) state.notebookPruning.delete(path); });
    const now = Date.now();
    const paths = Array.from(missing).filter((path) => !state.notebookPruning.has(path) || now - state.notebookPruning.get(path) >= 30000);
    if (paths.length) {
      paths.forEach((path) => state.notebookPruning.set(path, now));
      queueNotebookSettings({ pruneMissing: paths });
    }
    if (selectedMissing && graphPresentation) { renderTabs(); resumeNoteGraph(); }
    return selectedMissing;
  }
  let notebookSelectionSequence = 0;
  function selectNotebook(path, options) {
    if (path !== null && typeof path !== 'string') return false;
    if (path && (!isNotebookRoot(path) || findEntry(path)?.kind !== 'folder')) return false;
    notebookSelectionSequence += 1;
    const changed = state.notebookRoot !== path;
    if (changed) {
      noteGraphIntentSequence++; noteGraph?.deactivate();
      if (graphPresentation) { state.openSeq++; state.openingPath = ''; setDocumentSwitchPending(false); }
    }
    state.notebookRoot = path;
    if (changed) backgroundTargetChanged();
    if (changed || options?.rootTarget) { state.selectedFolder = path; state.selectedPath = path; state.rootTargeted = true; }
    if (changed) { stopDocumentPrefetch(); queueNotebookSettings({ ui: notebookUi() }); }
    if (changed && !options?.noRender) renderTree({ keepNotebookTree: true });
    updateTreeSelection(); updateNotebookSelection(); updateNotebookRootLabel();
    if (changed) { renderTabs(); if (graphPresentation) resumeNoteGraph(); }
    return changed;
  }
  function updateNotebookRootLabel() {
    updateGraphToggle();
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

  function applySelectionMatchHighlight(enabled, persist) {
    state.selectionMatchHighlight = enabled === true;
    if (selectionMatchHighlightToggle) selectionMatchHighlightToggle.checked = state.selectionMatchHighlight;
    liveEditor?.setSelectionMatchHighlight(state.selectionMatchHighlight);
    if (persist) {
      const value = state.selectionMatchHighlight ? '1' : '0';
      try {
        if (localStorage.getItem(SELECTION_MATCH_HIGHLIGHT_KEY) !== value) localStorage.setItem(SELECTION_MATCH_HIGHLIGHT_KEY, value);
      } catch (error) {}
    }
  }

  function syncNoteSettingsFontScale() {
    const preference = window.RelatumNotePreferences;
    const spacing = preference?.readGraphSpacing?.() ?? 125;
    const spacingInput = $('[data-role="note-graph-spacing"]'), spacingOutput = $('[data-role="note-graph-spacing-value"]');
    if (spacingInput) spacingInput.value = String(spacing);
    if (spacingOutput) spacingOutput.textContent = spacing + '%';
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
    if (selectionMatchHighlightToggle) selectionMatchHighlightToggle.checked = state.selectionMatchHighlight;
  }

  function setNoteSettingsOpen(open, options) {
    if (!settingsDialog) return;
    if (!open) { settingsMotionSequence++; settingsDialog.close({ reason: 'programmatic', ...options }); return; }
    const sequence = ++settingsMotionSequence, epoch = noteVisibilityEpoch;
    const current = state.current, tab = state.activeTab, openSequence = state.openSeq;
    const commit = () => {
      if (sequence !== settingsMotionSequence || epoch !== noteVisibilityEpoch || !noteWorkspaceVisible()
          || current !== state.current || tab !== state.activeTab || openSequence !== state.openSeq || activeNoteModal) return;
      prepareWorkspacePopover('settings');
      syncNoteSettingsFontScale(); renderNoteShortcutSettings();
      settingsDialog.open({ category: options?.category, trigger: options?.trigger || settingsTrigger });
    };
    if (editorInputPending()) whenEditorInputSettled().then(commit); else commit();
  }

  function applyGuideTopic(value, persist) {
    const next = ['callout', 'markdown', 'mermaid'].includes(value) ? value : 'callout';
    guideTopic = next;
    if (persist) try { if (localStorage.getItem(GUIDE_TOPIC_KEY) !== next) localStorage.setItem(GUIDE_TOPIC_KEY, next); } catch (_) {}
    settingsPop?.querySelectorAll('[name="note-guide-topic"]').forEach(input => { input.checked = input.value === next; });
    renderGuide();
  }

  function initializeSettingsDialog() {
    if (!settingsPop || !window.RelatumSettingsDialog) return;
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'settings-dialog.css'; document.head.append(style);
    const sections = Array.from(settingsPop.querySelectorAll(':scope > .note-settings-section'));
    const appearance = sections.find(section => section.querySelector('[data-role="note-font-scale"]'));
    const editing = sections.find(section => section.querySelector('[data-role="note-selection-match-highlight"]'));
    const shortcuts = sections.find(section => section.querySelector('[data-role="note-shortcut-list"]'));
    const graph = sections.find(section => section.querySelector('[data-role="note-graph-preload"]'));
    if (graph) graph.prepend(appearance.querySelector('[data-role="note-graph-spacing"]')?.closest('label'));
    const guide = document.createElement('section'); guide.dataset.i18nManaged = 'true';
    const defaultsHost = document.createElement('section'); defaultsHost.className = 'note-canvas-settings'; defaultsHost.dataset.i18nManaged = 'true';
    const sidebar = document.createElement('section'); sidebar.dataset.i18nManaged = 'true';
    const sidebarHint = document.createElement('p'), sidebarRows = document.createElement('div');
    sidebar.append(sidebarHint, sidebarRows);
    sidePreferences = window.RelatumNoteSidebarSettings.create({ language, available: sideAvailable, onChange() {
      updateSidePanel(); if (!graphPresentation) queueNotebookSettings({ ui: notebookUi() });
    } });
    sidePreferences.initPanel(sidebarRows);
    aiSettingsHost = document.createElement('section'); aiSettingsHost.dataset.i18nManaged = 'true'; aiSettingsHost.className = 'note-ai-settings';
    aiChatHost = document.createElement('section'); aiChatHost.dataset.i18nManaged = 'true'; aiChatHost.className = 'note-ai-dialog-host';
    const translateSidebar = () => { sidebarHint.textContent = language() === 'en' ? 'Choose the sidebar pages you use. Drag the handles or use the arrows to reorder them.' : '勾选你需要的侧栏页，拖动手柄或使用箭头调整顺序。'; sidePreferences.refresh(); };
    translateSidebar();
    const resetAI = async () => { if (aiEnabled()) { const ai = await ensureAI(); await ai.resetSettings(); } };
    const labels = {
      callout: ['提示、折叠与学习组合', 'Callouts, folding and study combinations'],
      markdown: ['常用排版与笔记语法', 'Everyday formatting and note syntax'],
      mermaid: ['用文字绘制常用图表', 'Create diagrams using text'],
    };
    function translateGuideOptions() {
      const focusedTopic = guide.contains(document.activeElement) ? document.activeElement.value : '';
      guide.replaceChildren();
      Object.entries(labels).forEach(([id, names]) => {
        const label = document.createElement('label'); label.className = 'relatum-settings-guide-option';
        const input = document.createElement('input'); input.type = 'radio'; input.name = 'note-guide-topic'; input.value = id; input.checked = guideTopic === id;
        const body = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small');
        title.textContent = { callout: 'Callout', markdown: 'Markdown', mermaid: 'Mermaid' }[id]; description.textContent = names[language() === 'en' ? 1 : 0];
        body.append(title, description); label.append(input, body); guide.append(label);
      });
      const hint = document.createElement('p'); hint.textContent = language() === 'en' ? 'Choose what the Guide sidebar displays. Changes apply immediately.' : '选择右侧“引导”面板展示的内容，更改立即生效。'; guide.append(hint);
      if (focusedTopic) guide.querySelector('input[value="' + focusedTopic + '"]')?.focus({ preventScroll: true });
    }
    translateGuideOptions(); guide.addEventListener('change', event => { if (event.target.name === 'note-guide-topic') applyGuideTopic(event.target.value, true); });
    const pref = window.RelatumNotePreferences;
    const preloadPanel = graphEnabled() && graph ? document.createElement('div') : null;
    if (preloadPanel) graph.querySelectorAll('.note-graph-preload-setting, .note-graph-preload-hint').forEach(el => preloadPanel.append(el));
    const systemSettings = noteSystem.createPanel({ language, graph: graphEnabled(), mermaid: !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid'), preload: preloadPanel,
      async getCacheStats({ signal }) {
        const documents = { items: state.documentCache.size, bytes: 0 };
        state.documentCache.forEach(item => { documents.bytes += item.content.length * 2; });
        const graph = noteGraph?.getCacheStats();
        const mermaid = await window.RelatumNoteMermaid?.getCacheStats({ signal });
        return { documents, graph, mermaid };
      } });
    const resetGuide = () => { try { localStorage.removeItem(GUIDE_TOPIC_KEY); } catch (_) {} applyGuideTopic('callout', false); };
    const resetCanvas = () => { try { localStorage.removeItem('canvas:noteCanvasDefaults:v1'); } catch (_) {} pref?.resetCanvasNodeScale?.(); canvasStylePanel?.refresh(); };
    const categories = [
      { id: 'appearance', label: ['外观', 'Appearance'], icon: 'note-icon-laptop-minimal', panel: appearance, keywords: '字体 font size image text scale', reset: () => { pref?.resetFontScale?.(); pref?.resetImageTextScale?.(); syncNoteSettingsFontScale(); } },
      { id: 'editing', label: ['编辑', 'Editing'], icon: 'note-icon-square-pen', panel: editing, keywords: 'highlight selection 高亮', reset: () => { try { localStorage.removeItem(SELECTION_MATCH_HIGHLIGHT_KEY); } catch (_) {} applySelectionMatchHighlight(false, false); } },
      { id: 'files', label: ['文件与笔记库', 'Files & library'], icon: 'note-icon-folder', panel: librarySettings, keywords: '排序 命名 sort name timestamp', reset: resetLibraryPreferences },
      { id: 'sidebar', label: ['侧栏', 'Sidebar'], icon: 'note-icon-panel-right-frame', panel: sidebar, keywords: '页签 显示 隐藏 顺序 拖拽 tabs visibility reorder sidebar', reset: () => sidePreferences.reset() },
      { id: 'guide', label: ['引导', 'Guide'], icon: 'note-icon-file-text', panel: guide, keywords: 'callout markdown mermaid 教程 语法 syntax tutorial', reset: resetGuide },
      ...(aiEnabled() ? [
        { id: 'ai', label: ['AI设置', 'AI settings'], icon: 'note-icon-sparkles', panel: aiSettingsHost, keywords: 'deepseek api key model preset prompt token temperature stream timeout effort base url 思考 强度 模型 预设 提示词 温度 连接 接口 地址 流式 输出 超时', reset: resetAI },
        { id: 'ai-chat', label: ['AI对话', 'AI chat'], icon: 'note-icon-ai-chat', panel: aiChatHost, layout: 'fill', searchMode: 'category', keywords: 'AI 对话 聊天 消息 图片 chat conversation message image' },
      ] : []),
      ...(graphEnabled() && graph ? [{ id: 'graph', label: ['图谱', 'Graph'], icon: 'note-icon-graph', panel: graph, keywords: 'spacing 间距', reset: () => { pref?.resetGraphSpacing?.(); syncNoteSettingsFontScale(); } }] : []),
      ...(canvasEnabled() ? [{ id: 'canvas', label: ['内嵌画布', 'Embedded canvas'], icon: 'note-icon-panel-right-frame', panel: defaultsHost, keywords: '默认 样式 节点 连线 default node edge styles', reset: resetCanvas }] : []),
      { id: 'shortcuts', label: ['快捷键', 'Shortcuts'], icon: 'note-icon-code-xml', panel: shortcuts, keywords: '键盘 keyboard bindings', reset: () => { stopShortcutRecording(true); if (NOTE_SHORTCUTS) state.shortcutBindings = NOTE_SHORTCUTS.reset(); applyShortcutBindings(); renderNoteShortcutSettings(); } },
      { id: 'system', label: ['系统', 'System'], icon: 'note-icon-settings', panel: systemSettings.panel, keywords: '性能 内存 动画 预读 预加载 缓存 清理 清晰度 启动 performance memory animation prefetch preload cache clear resolution startup', reset: () => { noteSystem.reset(); pref?.resetGraphPreload?.(); } },
    ];
    settingsDialog = window.RelatumSettingsDialog.create({ content: settingsPop, categories, language,
      onSearch(query) { if (aiEnabled() && !aiSettingsHost.querySelector('[data-ai-field]') && /deepseek|api|模型|预设|提示词|思考|强度|温度|连接|接口|地址|流式|输出|超时|token|top.?p|model|preset|prompt|temperature|stream|timeout|effort|base.?url|\bkey\b|\bai\b/.test(query)) return ensureAI().then(ai => ai.prepareSettings()); },
      async resetAll() { resetNoteSettings(); noteSystem.reset(); resetLibraryPreferences(); resetGuide(); sidePreferences.reset(); if (canvasEnabled()) resetCanvas(); await resetAI(); },
      onOpen() {
        state.settingsOpen = true; aiDialogReturning = false;
        settingsTrigger.setAttribute('aria-expanded', 'true'); libraryTrigger.setAttribute('aria-expanded', 'true'); renderAI();
      },
      onClose({ reason }) {
        aiSequence++;
        systemSettings.setActive(false);
        aiDialogReturning = reason === 'user' && aiSettingsCategory === 'ai-chat' && !aiPageHiding && noteWorkspaceVisible()
          && !graphPresentation && aiEnabled() && sidePages().includes('ai');
        state.settingsOpen = false; settingsTrigger.setAttribute('aria-expanded', 'false'); libraryTrigger.setAttribute('aria-expanded', 'false');
        stopShortcutRecording(true); canvasStylePanel?.suspend(); sidePreferences.suspend(); aiController?.closeSettings();
        if (aiDialogReturning) aiController?.holdPresentation(); else aiController?.suspend();
      },
      onClosed({ reason }) {
        const returning = aiDialogReturning; aiDialogReturning = false;
        if (returning && reason === 'user' && !aiPageHiding && noteWorkspaceVisible() && !graphPresentation && aiEnabled() && sidePages().includes('ai')) {
          state.sideMode = 'ai'; setSideOpen(true);
        } else { aiController?.suspend(); renderAI(); }
      },
      onCategoryChange(category) {
        aiSettingsCategory = category; aiDialogReturning = false;
        systemSettings.setActive(category === 'system' && !!settingsDialog?.isOpen && noteWorkspaceVisible());
        stopShortcutRecording(true); canvasStylePanel?.suspend(); sidePreferences.suspend();
        if (category === 'ai') ensureAI().then(ai => { if (settingsDialog?.isOpen && aiSettingsCategory === 'ai' && noteWorkspaceVisible()) ai.settings(); }).catch(error => showToast(error.message, 'error'));
        else aiController?.closeSettings();
        renderAI();
      },
      onKeyDown(event) {
        if (!state.recordingShortcutCommand) return false;
        event.preventDefault();
        if (event.key === 'Escape') stopShortcutRecording(true);
        else { const binding = NOTE_SHORTCUTS?.bindingFromEvent(event); if (binding) acceptShortcutBinding(state.recordingShortcutCommand, binding); else setShortcutStatus(noteSettingsCopy('invalid')); }
        return true;
      },
    });
    settingsDialog.dialog.addEventListener('click', handleWorkspaceClick);
    settingsTrigger.setAttribute('aria-controls', 'note-settings-dialog');
    libraryTrigger.setAttribute('aria-controls', 'note-settings-dialog');
    if (canvasEnabled()) canvasStylePanel = window.RelatumNoteCanvasStyle?.initPanel(canvasSettingsContent, () => pref?.resetCanvasNodeScale?.(), { defaultsHost });
    document.addEventListener('relatum:languagechange', () => { translateGuideOptions(); translateSidebar(); systemSettings.refresh(); aiController?.setLanguage(); settingsDialog.setLanguage(); });
  }

  function resetNoteSettings() {
    try { localStorage.removeItem(SELECTION_MATCH_HIGHLIGHT_KEY); } catch (error) {}
    applySelectionMatchHighlight(false, false);
    const preference = window.RelatumNotePreferences;
    preference?.resetGraphSpacing?.();
    preference?.resetGraphPreload?.();
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
    noteOutline?.documentChanged();
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

  let wikiOpenTask = null;
  async function openWikiFromEditor(rawTarget) {
    const documentState = state.current, target = normalizedWikiTarget(rawTarget);
    if (!documentState || !target || !noteWorkspaceVisible()) return;
    const path = documentState.path, tab = state.activeTab, sequence = state.openSeq, visibility = noteVisibilityEpoch;
    if (wikiOpenTask?.document === documentState && wikiOpenTask.target === target
        && wikiOpenTask.sequence === sequence && wikiOpenTask.visibility === visibility) return wikiOpenTask.promise;
    const task = { document: documentState, target, sequence, visibility };
    const valid = () => wikiOpenTask === task && noteWorkspaceVisible() && visibility === noteVisibilityEpoch
      && state.current === documentState && documentState.path === path && state.activeTab === tab && state.openSeq === sequence;
    wikiOpenTask = task;
    task.promise = (async () => {
      if (!(await flushSave(documentState)) || !valid()) return;
      if (!(await ensureLinks()) || !valid()) return;
      const outgoing = outgoingForWiki(rawTarget);
      if (outgoing && outgoing.path) {
        const writtenTarget = String(rawTarget || '').split('|', 1)[0];
        const hashAt = writtenTarget.indexOf('#');
        const fragment = hashAt >= 0 ? writtenTarget.slice(hashAt + 1) : '';
        if (await openNote(outgoing.path)) scheduleHeadingJump(fragment);
        return;
      }
      if (outgoing && outgoing.state === 'ambiguous') { showToast(tr('ambiguous'), 'warning'); return; }
      const parts = target.replace(/\\/g, '/').split('/').filter(Boolean);
      const name = parts.pop(), hasPath = parts.length > 0;
      if (!name) return;
      return createEntry('note', { parent: hasPath ? parts.join('/') : parentPath(path), name, createParents: hasPath, guard: valid });
    })();
    try { return await task.promise; }
    finally { if (wikiOpenTask === task) wikiOpenTask = null; }
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

  function outlineVisible() {
    return !!outlineContent && noteWorkspaceVisible()
      && state.sideMode === 'outline' && root.classList.contains('links-overlay-open');
  }
  function outlineDocument() {
    if (!state.current || browserResultsActive()) return null;
    const source = liveEditor ? liveEditor.snapshot().value
      : window.MarkdownMini.structure.normalizeSource(state.viewMode === 'reading' ? state.current.content : fallbackEditor.value);
    return { identity: state.current, path: state.current.path, source };
  }
  async function navigateOutline(heading, documentState, currentOperation) {
    const mode = state.viewMode;
    const valid = () => currentOperation() && outlineVisible() && !browserResultsActive()
      && state.current === documentState.identity && state.current?.path === documentState.path && state.viewMode === mode;
    if (!valid()) return false;
    if (editorInputPending()) await whenEditorInputSettled();
    if (!valid() || !(await flushCanvases())) return false;
    if (!valid()) return false;
    const source = outlineDocument()?.source;
    if (typeof source !== 'string') return false;
    const position = window.RelatumNoteOutline.mapHeadingPosition(heading, documentState.source, source);
    if (position === null) return false;
    // Native input can shift a target or turn the surrounding text into a code
    // block. Recheck changed source without blocking one large parser pass.
    if (source !== documentState.source) {
      const scan = window.RelatumNoteLiveSyntax.scanNoteHeadings(source); let result;
      do {
        const deadline = performance.now() + 8;
        do { result = scan.next(); } while (!result.done && performance.now() < deadline);
        if (!result.done) await new Promise(resolve => setTimeout(resolve, 0));
        if (!valid() || outlineDocument()?.source !== source) return false;
      } while (!result.done);
      if (!result.value.some(item => item.from === position && item.level === heading.level)) return false;
    }
    if (mode === 'reading') {
      const target = readingHost.querySelector('[data-note-heading-from="' + position + '"]');
      if (!target) return false;
      readingHost.scrollTop += target.getBoundingClientRect().top - readingHost.getBoundingClientRect().top - 12;
    } else if (liveEditor) liveEditor.revealPosition(position, { align: 'start' });
    else {
      fallbackEditor.focus(); fallbackEditor.setSelectionRange(position, position);
      const lineHeight = parseFloat(getComputedStyle(fallbackEditor).lineHeight) || 24;
      fallbackEditor.scrollTop = Math.max(0, (source.slice(0, position).split('\n').length - 1) * lineHeight - 12);
    }
    return true;
  }
  function syncOutline() {
    const sequence = ++outlineLoadSequence;
    if (!outlineVisible()) { noteOutline?.suspend(); return; }
    if (noteOutline) { noteOutline.resume(); return; }
    if (!outlineLoader) outlineLoader = (async () => {
      if (!window.RelatumNoteOutline) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = 'note-outline.js'; script.async = true;
        const failed = () => { script.remove(); reject(new Error(tr('readFailed'))); };
        script.onload = () => window.RelatumNoteOutline ? resolve() : failed(); script.onerror = failed;
        document.head.appendChild(script);
      });
    })().catch(error => { outlineLoader = null; throw error; });
    outlineLoader.then(() => {
      if (sequence !== outlineLoadSequence || !outlineVisible()) return;
      if (!noteOutline) noteOutline = window.RelatumNoteOutline.create(outlineContent, {
        language, getDocument: outlineDocument, inputPending: editorInputPending, whenInputSettled: whenEditorInputSettled,
        getSurface: () => ({ kind: state.viewMode === 'reading' ? 'reading' : liveEditor ? 'editor' : 'fallback',
          scroller: editorScrollElement(), view: state.viewMode === 'reading' ? null : liveEditor?.view }),
        navigate: navigateOutline,
      });
      noteOutline.resume();
    }).catch(() => {
      if (sequence !== outlineLoadSequence || !outlineVisible()) return;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'note-outline-status';
      retry.textContent = language() === 'en' ? 'Outline unavailable. Click to retry' : '大纲暂时无法加载，点击重试';
      retry.addEventListener('click', syncOutline); outlineContent.replaceChildren(retry);
    });
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
    if (/\.md$/i.test(resolved) && (!entry || entry.kind === 'note')) {
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
    const release = window.RelatumBackgroundPreparation?.beginBusy();
    try { renderReadingDocumentNow(payload); } finally { release?.(); }
  }
  function renderReadingDocumentNow(payload) {
    const documentState = payload || readingPayload();
    if (window.RelatumNoteLiveEditor && typeof window.RelatumNoteLiveEditor.renderMarkdown === 'function') {
      window.RelatumNoteLiveEditor.renderMarkdown(readingHost, documentState.value || '', documentState.notePath || '', { calloutSession: liveEditor?.calloutSession });
    } else {
      const result = window.MarkdownMini && window.MarkdownMini.renderResult
        ? window.MarkdownMini.renderResult(documentState.value || '', { localImages: true, noteBlocks: true, noteSyntax: true, mermaid: !window.RelatumFeatureRuntime || window.RelatumFeatureRuntime.enabled('notes.mermaid') })
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
          selectionMatchHighlight: state.selectionMatchHighlight,
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
      readingHost.addEventListener('contextmenu', (event) => {
        const image = event.target.closest('.md-local-image')?.querySelector('[data-note-image]');
        if (!image || !state.active || !state.current || state.viewMode !== 'reading') return;
        event.preventDefault(); event.stopPropagation();
        if (contextOpen) { closeContextMenu(); return; }
        closeContextMenu({ instant: true });
        showContext([imageRevealButton({ target: image.dataset.noteImage, syntax: image.dataset.noteImageSyntax })],
          event.clientX, event.clientY, 'image');
      });
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
  function compareTreeNames(left, right) {
    const locale = language();
    if (treeNameLocale !== locale) {
      treeNameLocale = locale;
      treeNameComparator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
    }
    return treeNameComparator(left, right);
  }
  function nameCompare(left, right) {
    return compareTreeNames(left.name, right.name) || left.path.localeCompare(right.path);
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
    $('[data-role="note-library-sort-title"]').textContent = tr('librarySort');
    $('[data-role="note-library-name-title"]').textContent = tr('newNameSetting');
    $('[data-role="note-library-name-label"]').textContent = tr('customNameLabel');
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
      refreshTree(false, { reset: true, reconcile: false, silentErrors: true });
    }
    renderLibraryPreferences();
  }
  function resetLibraryPreferences() {
    const orderChanged = state.treeSort !== 'modified-desc';
    [TREE_SORT_KEY, NEW_NAME_KEY].forEach((key) => {
      try { localStorage.removeItem(key); } catch (error) {}
    });
    state.treeSort = 'modified-desc';
    state.newName = { mode: 'timestamp', baseName: '' };
    if (orderChanged) { renderTree(); refreshTree(false, { reset: true, reconcile: false, silentErrors: true }); }
    renderLibraryPreferences();
  }
  function setLibraryPanel(kind, options) {
    if (kind) prepareWorkspacePopover('library');
    const sequence = ++libraryMotionSequence;
    const panels = { sort: [sortMenu, sortTrigger] };
    const restoreFocus = !options || options.restoreFocus !== false;
    Object.entries(panels).forEach(([name, [panel, trigger]]) => {
      if (!panel || !trigger) return;
      clearTimeout(state.libraryPanelTimers[name]); state.libraryPanelTimers[name] = 0;
      const open = name === kind;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        panel.hidden = false; panel.inert = false; panel.classList.remove('is-closing');
      } else if (!panel.hidden) {
        panel.inert = true;
        if (options?.instant || !noteWorkspaceVisible() || tabMotionPreference.matches) { panel.hidden = true; panel.classList.remove('is-closing'); }
        else {
          panel.classList.add('is-closing');
          state.libraryPanelTimers[name] = window.setTimeout(() => {
            if (sequence === libraryMotionSequence && state.libraryPanel !== name) { panel.hidden = true; panel.classList.remove('is-closing'); state.libraryPanelTimers[name] = 0; }
          }, 170);
        }
        if (restoreFocus && !kind && state.libraryPanel === name) trigger.focus();
      }
    });
    state.libraryPanel = kind;
    if (kind) renderLibraryPreferences();
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
    if (!target || target.countedGeneration === target.editGeneration || !noteWorkspaceVisible()) return;
    if (statisticsJob && statisticsJob.target === target && statisticsJob.generation === target.editGeneration) return;
    cancelStatistics();
    const job = statisticsJob = { target, generation: target.editGeneration, index: 0, count: 0, characters: 0,
      inWord: false, joiner: false, line: '', lineIndex: 0, unicodeWord: /[\p{L}\p{N}]/u };
    statisticsTimer = setTimeout(() => {
      statisticsTimer = 0;
      if (statisticsJob !== job || target !== state.current || !noteWorkspaceVisible() || editorInputPending()) { cancelStatistics(); return; }
      job.source = editorSnapshot().value;
      const step = () => {
        statisticsFrame = 0;
        if (statisticsJob !== job || target !== state.current || target.editGeneration !== job.generation || !noteWorkspaceVisible()) return;
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
    catch (cause) { if (cause.name === 'AbortError') throw cause; const error = new Error(language() === 'en' ? 'Local service is unavailable' : '无法连接本地服务'); error.cause = cause; error.code = 'network_error'; throw error; }
    let data = null; try { data = await response.json(); } catch (error) { if (error.name === 'AbortError') throw error; }
    if (!response.ok) { const error = new Error((data && data.error) || (language() === 'en' ? 'Request failed' : '请求失败')); error.status = response.status; error.code = data && data.code; throw error; }
    return data || {};
  }
  function isMissingError(error) { return !!error && (error.status === 404 || error.code === 'not_found'); }
  function treeView() {
    let saved = ''; try { saved = localStorage.getItem(ACTIVE_PATH_KEY) || ''; } catch (error) {}
    return { expanded: Array.from(new Set([state.notebookRoot || '', ...state.expanded, ...state.notebookExpanded])).slice(0, 4096),
      pins: Array.from(new Set([state.selectedFolder, ...state.tabs, saved, state.current?.path || ''].filter(path => path && !isSpecialTab(path)))).slice(0, 256), sort: state.treeSort };
  }
  function post(url, payload, options) {
    if (['/api/note-create', '/api/note-move', '/api/note-trash', '/api/note-import-commit'].includes(url)) payload = Object.assign({}, payload, { _tree: treeView() });
    return request(url, Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }, options));
  }
  let indexHeartbeat = 0;
  function indexActivity(visible, keepalive) {
    if (!visible) { cancelTabCloseMotion(); cancelTabScroll(); }
    clearTimeout(indexHeartbeat); indexHeartbeat = 0;
    request('/api/note-index-activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible }), keepalive: !!keepalive }).catch(() => {});
    if (visible) indexHeartbeat = setTimeout(() => indexActivity(noteWorkspaceVisible()), 15000);
    for (const tree of [treeEl, notebookTreeEl]) {
      if (visible) { tree.__noteWindow?.resume(); tree.querySelectorAll('[data-note-more]').forEach(row => tree.__noteMoreObserver?.observe(row)); }
      else { tree.__noteFinishMotion?.(); tree.__noteWindow?.suspend(); tree.__noteMoreObserver?.disconnect(); }
    }
  }
  function mergeTreeItem(item) {
    const existing = state.entryIndex.get(item.path);
    if (existing) {
      if (existing.kind !== item.kind) browserFolderIndex = null;
      const sortKey = state.treeSort.startsWith('created-') ? 'createdNs' : 'modifiedNs';
      const changed = existing.name !== item.name || existing.kind !== item.kind
        || existing.kind === 'note' && !state.treeSort.startsWith('name-') && existing[sortKey] !== item[sortKey];
      const children = existing.children; Object.assign(existing, item);
      if (children) existing.children = children;
      return changed;
    }
    if (item.contentChanged) return false;
    const parent = parentPath(item.path);
    let host = parent ? state.entryIndex.get(parent)?.children : state.entries;
    if (!host) return false;
    const next = Object.assign({}, item); if (next.kind === 'folder') next.children = [];
    host.push(next); state.entryIndex.set(next.path, next);
    return true;
  }
  const directoryLoads = new Map();
  async function loadDirectory(parent, reset) {
    if (directoryLoads.has(parent) || !noteWorkspaceVisible()) return;
    const epoch = noteVisibilityEpoch, paging = state.treePagination?.[parent];
    const offset = reset ? 0 : paging?.offset || 0;
    const sort = state.treeSort;
    const task = request('/api/note-children?parent=' + encodeURIComponent(parent) + '&offset=' + offset + '&sort=' + sort
      + (offset && paging?.generation !== undefined ? '&generation=' + paging.generation : ''));
    directoryLoads.set(parent, task);
    try {
      const result = await task;
      if (!noteWorkspaceVisible() || epoch !== noteVisibilityEpoch || sort !== state.treeSort) return;
      let changed = false;
      (result.items || []).forEach(item => { changed = mergeTreeItem(item) || changed; });
      state.treePagination ||= {}; state.treePagination[parent] = { offset: offset + result.items.length, hasMore: result.hasMore, total: result.total, generation: result.generation };
      if (changed || !!paging?.hasMore !== !!result.hasMore) renderTree({ entryIndexReady: true });
    } catch (error) { if (error.code === 'query_changed') refreshTree(false, { reset: true, reconcile: false, silentErrors: true }); else if (noteWorkspaceVisible()) showToast(error.message, 'error'); }
    finally { if (directoryLoads.get(parent) === task) directoryLoads.delete(parent); }
  }
  async function openSearchNote(path, result) {
    if (!(await openNote(path, { browserAction: true, force: !!result?.searchQuery }))) return false;
    if (result?.searchQuery) recordRecent(path);
    const target = state.current, sequence = state.openSeq, visibility = noteVisibilityEpoch;
    if (!result?.sourceRange) return true;
    if (editorInputPending()) await whenEditorInputSettled();
    if (!(await flushCanvases()) || state.current !== target || sequence !== state.openSeq || visibility !== noteVisibilityEpoch) return false;
    let range = result.sourceRange;
    if (target.revision !== result.revision) {
      if (!result.searchQuery) return true;
      let refreshed;
      try { refreshed = await post('/api/note-query', Object.assign({ mode: 'search', paths: [path], expectedRevision: target.revision }, result.searchQuery)); }
      catch (error) { return true; }
      if (state.current !== target || sequence !== state.openSeq || visibility !== noteVisibilityEpoch) return false;
      result = refreshed.items?.find(item => item.path === path);
      range = result?.revision === target.revision ? result.sourceRange : null;
      if (!range) return true;
    }
    if (state.viewMode !== 'reading') {
      if (liveEditor) liveEditor.revealPosition(range[0], { align: 'start', end: range[1], unfold: true });
      else { fallbackEditor.focus(); fallbackEditor.setSelectionRange(...range); }
    } else {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (state.current !== target || sequence !== state.openSeq || visibility !== noteVisibilityEpoch) return false;
      const highlight = result.highlights?.[0];
      const needle = (highlight ? result.excerpt.slice(...highlight) : target.content.slice(range[0], range[1]).replace(/[*~`]/g, '')).normalize('NFC').toLocaleLowerCase();
      const elements = readingHost.querySelectorAll('p,pre,li,td,th,h1,h2,h3,h4,h5,h6,.note-image-text-box');
      for (const element of elements) {
        if (!needle || element.closest('.note-frontmatter') || !element.textContent.normalize('NFC').toLocaleLowerCase().includes(needle)) continue;
        for (let parent = element; parent && parent !== readingHost; parent = parent.parentElement) {
          if (parent.classList.contains('md-callout-body') && parent.hidden) parent.closest('.md-callout')?.querySelector('.note-callout-fold')?.click();
        }
        readingHost.scrollTop += element.getBoundingClientRect().top - readingHost.getBoundingClientRect().top - 12;
        break;
      }
    }
    return true;
  }
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
  function closeWorkspacePopovers() {
    aiController?.closePopovers();
    closeContextMenu({ instant: true });
    setNoteSettingsOpen(false, { restoreFocus: false, instant: true });
    setLibraryPanel('', { restoreFocus: false, instant: true });
  }
  function prepareWorkspacePopover(kind) {
    noteBrowser?.closePopovers({ instant: true });
    if (kind !== 'ai') aiController?.closePopovers();
    if (kind !== 'context') closeContextMenu({ instant: true });
    if (kind !== 'settings') setNoteSettingsOpen(false, { restoreFocus: false, instant: true });
    if (kind !== 'library') setLibraryPanel('', { restoreFocus: false, instant: true });
  }
  function cancelContextMotion() {
    contextSequence++; cancelAnimationFrame(contextFrame); clearTimeout(contextTimer); contextFrame = contextTimer = 0;
  }
  function blockContextTooltip(blocked) {
    if (contextTooltipBlocked === blocked) return;
    contextTooltipBlocked = blocked;
    document.dispatchEvent(new CustomEvent('canvas:tooltip-block', { detail: { owner: contextMenu, blocked } }));
  }
  function finishContextClose() {
    clearTimeout(contextTimer); contextTimer = 0;
    if (contextOpen || !contextMenu) return;
    contextMenu.hidden = true; contextMenu.classList.remove('is-closing'); contextMenu.dataset.source = ''; contextMenu.replaceChildren(); contextReturnFocus = null;
    blockContextTooltip(false);
  }
  function closeContextMenu(options = {}) {
    imageCopyController?.abort(); imageCopyController = null;
    cancelContextMotion(); contextOpen = false; bodyMenuContext = null; closeBodySubmenu({ instant: true });
    if (!contextMenu) return;
    contextMenu.inert = true; contextMenu.removeAttribute('aria-busy'); contextMenu.classList.remove('is-open');
    currentMenuButton?.setAttribute('aria-expanded', 'false');
    if (contextMenu.hidden || options.instant || options instanceof Event || !noteWorkspaceVisible() || tabMotionPreference.matches) {
      finishContextClose(); return;
    }
    contextMenu.classList.add('is-closing');
    const sequence = contextSequence;
    contextTimer = setTimeout(() => { if (sequence === contextSequence) finishContextClose(); }, 170);
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
  let expandAllSequence = 0;
  async function toggleAllFolders() {
    const sequence = ++expandAllSequence, notebook = state.notebookRoot, visibility = noteVisibilityEpoch;
    const paths = folderPaths();
    const collapse = paths.some((path) => state.expanded.has(path));
    if (collapse) paths.forEach((path) => state.expanded.delete(path));
    else paths.forEach((path) => state.expanded.add(path));
    persistExpanded(); renderTree();
    if (!collapse && notebook !== null) {
      const queue = [notebook], valid = () => sequence === expandAllSequence && notebook === state.notebookRoot && visibility === noteVisibilityEpoch && noteWorkspaceVisible();
      try {
        while (queue.length && valid()) {
          const parent = queue.shift(); let offset = 0, generation;
          do {
            const page = await request('/api/note-children?folders=1&parent=' + encodeURIComponent(parent) + '&offset=' + offset
              + (generation !== undefined ? '&generation=' + generation : ''));
            if (!valid()) return false;
            generation = page.generation;
            for (const item of page.items) {
              if (!notebook && /^CustomNotebook(?:\/|$)/i.test(item.path)) continue;
              mergeTreeItem(item); state.expanded.add(item.path); queue.push(item.path);
            }
            offset += page.items.length;
            if (!page.hasMore) break;
          } while (valid());
          if (!state.treePagination?.[parent]) await loadDirectory(parent);
        }
        if (valid()) { persistExpanded(); renderTree(); }
      } catch (error) { if (valid()) showToast(error.message, 'error'); }
    }
    return true;
  }
  function rebuildEntryIndex(flat) {
    state.entryIndex = new Map((flat || flattenEntries(state.entries, [])).map((entry) => [entry.path, entry]));
    browserFolderIndex = null; browserFolderSize = -1; browserFolderPaths = [];
  }
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
  function naturalSort(entries) { entries.sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : compareTreeNames(a.name, b.name)); }
  function makeDocument(data) {
    (data.ancestors || []).forEach(mergeTreeItem);
    if (data.entry && !findEntry(data.path)) { mergeTreeItem(data.entry); rebuildEntryIndex(); }
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
    trimDocumentCache();
  }
  function trimDocumentCache(clear = false) {
    const budget = noteSystem?.budget('documents') || { items: DOCUMENT_CACHE_LIMIT, bytes: DOCUMENT_CACHE_BYTES };
    let bytes = Array.from(state.documentCache.values()).reduce((sum, item) => sum + item.content.length * 2, 0);
    if (!clear && state.documentCache.size <= budget.items && bytes <= budget.bytes) return;
    for (const [path, candidate] of state.documentCache) {
      if (!clear && state.documentCache.size <= budget.items && bytes <= budget.bytes) break;
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
    if (reuseActive && activeIndex >= 0 && !isGraphTab(state.activeTab)) state.tabs.splice(activeIndex, 1, path);
    else state.tabs.push(path);
    state.activeTab = path;
    persistTabs();
    return true;
  }
  function releaseTabCloseClip() {
    if (!tabCloseClipActive) return;
    tabCloseClipActive = false;
    tabsEl.classList.remove('is-close-motion');
    tabsEl.style.removeProperty('--note-tab-motion-width');
    tabsEl.style.removeProperty('--note-tab-motion-final-width');
  }
  function cancelTabScroll() {
    if (tabScrollFrame) cancelAnimationFrame(tabScrollFrame);
    tabScrollFrame = 0;
    tabCloseScrollPending = null;
  }
  function requestTabScroll(active, path) {
    cancelTabScroll();
    tabScrollFrame = requestAnimationFrame(() => {
      tabScrollFrame = 0;
      if (!active.isConnected || state.renderedActiveTab !== path || !noteWorkspaceVisible()) return;
      // Animated bounds describe the old slot, not the final active-tab position.
      if (tabCloseAnimations.size) { tabCloseScrollPending = { active, path }; return; }
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function resumeTabCloseScroll() {
    const pending = tabCloseScrollPending;
    tabCloseScrollPending = null;
    if (pending) requestTabScroll(pending.active, pending.path);
  }
  function cancelTabCloseMotion() {
    tabCloseMotionPending = false;
    tabCloseMotionUntil = 0; tabCloseScrollPending = null;
    for (const animation of tabCloseAnimations.values()) {
      animation.onfinish = null; animation.oncancel = null;
      animation.cancel();
    }
    tabCloseAnimations.clear();
    releaseTabCloseClip();
  }
  function captureTabCloseMotion(continuing) {
    if (!tabCloseMotionPending && !(continuing && tabCloseAnimations.size)) return null;
    const deadline = continuing ? tabCloseMotionUntil : 0, deferredScroll = tabCloseScrollPending;
    tabCloseMotionPending = false;
    if (!noteWorkspaceVisible() || state.draggedTabPath || tabMotionPreference.matches
        || !tabBar || typeof tabsEl?.animate !== 'function') {
      cancelTabCloseMotion(); return null;
    }
    const bar = tabBar.getBoundingClientRect(), strip = tabsEl.getBoundingClientRect();
    const survivors = new Set(state.tabs), positions = new Map();
    // Read current visual positions before cancelling an interrupted animation.
    for (const tab of tabsEl.children) {
      if (!survivors.has(tab.dataset.noteTabPath)) continue;
      const rect = tab.getBoundingClientRect();
      positions.set(tab, { x: rect.left - bar.left, visible: rect.right > strip.left && rect.left < strip.right });
    }
    if (tabActions) {
      const rect = tabActions.getBoundingClientRect();
      positions.set(tabActions, { x: rect.left - bar.left, visible: true });
    }
    cancelTabCloseMotion();
    tabCloseScrollPending = deferredScroll;
    return { positions, width: strip.width, deadline };
  }
  function playTabCloseMotion(snapshot) {
    if (!snapshot || !noteWorkspaceVisible() || state.draggedTabPath || tabMotionPreference.matches) return;
    const bar = tabBar.getBoundingClientRect(), strip = tabsEl.getBoundingClientRect(), moves = [];
    // Batch all final reads before starting compositor-friendly transforms.
    for (const [element, previous] of snapshot.positions) {
      if (!element.isConnected) continue;
      const rect = element.getBoundingClientRect(), delta = previous.x - (rect.left - bar.left);
      const visible = element === tabActions || rect.right > strip.left && rect.left < strip.right;
      if ((previous.visible || visible) && Number.isFinite(delta) && Math.abs(delta) > .5) moves.push({ element, delta });
    }
    tabCloseMotionScrollLeft = tabsEl.scrollLeft;
    const now = performance.now(), until = snapshot.deadline || now + 230, duration = until - now;
    if (!moves.length || duration <= 0) { resumeTabCloseScroll(); return; }
    tabCloseMotionUntil = until;
    if (moves.length && snapshot.width - strip.width > .5) {
      // Keep trailing tabs inside the old clip without moving the final action slot.
      tabsEl.style.setProperty('--note-tab-motion-width', snapshot.width + 'px');
      tabsEl.style.setProperty('--note-tab-motion-final-width', strip.width + 'px');
      tabsEl.classList.add('is-close-motion'); tabCloseClipActive = true;
    }
    for (const { element, delta } of moves) {
      let animation;
      try {
        animation = element.animate([{ transform: 'translateX(' + delta + 'px)' }, { transform: 'translateX(0)' }],
          { duration, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      } catch (error) {
        const deferredScroll = tabCloseScrollPending;
        cancelTabCloseMotion(); tabCloseScrollPending = deferredScroll; resumeTabCloseScroll(); return;
      }
      tabCloseAnimations.set(element, animation);
      const finish = () => {
        if (tabCloseAnimations.get(element) !== animation) return;
        tabCloseAnimations.delete(element);
        animation.onfinish = null; animation.oncancel = null;
        if (!tabCloseAnimations.size) { tabCloseMotionUntil = 0; releaseTabCloseClip(); resumeTabCloseScroll(); }
      };
      animation.onfinish = finish; animation.oncancel = finish;
    }
  }
  function handleTabCloseScroll() {
    if (!tabCloseAnimations.size || tabsEl.scrollLeft === tabCloseMotionScrollLeft) return;
    const maximum = Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth);
    // Removing tabs or changing graph layout can clamp the native scroll range.
    if (tabCloseMotionScrollLeft > maximum && Math.abs(tabsEl.scrollLeft - maximum) <= .5) {
      tabCloseMotionScrollLeft = tabsEl.scrollLeft; return;
    }
    cancelTabCloseMotion(); cancelTabScroll();
  }
  function noteTabTitle(path) {
    return isGraphTab(path) ? (language() === 'en' ? 'Graph' : '关系图谱')
      + ' · ' + (state.notebookRoot ? state.notebookRoot.split('/').pop() : 'notes') : isBlankTab(path) ? tr('newTab') : noteTitle(path);
  }
  function renderTabs() {
    if (!tabsEl) return;
    let motionPositions = captureTabCloseMotion();
    const activeTab = state.activeTab || state.openingPath || (state.current && state.current.path) || '';
    const existing = new Map(Array.from(tabsEl.children).map((tab) => [tab.dataset.noteTabPath || '', tab]));
    if (!motionPositions && tabCloseAnimations.size) {
      if (existing.size !== state.tabs.length
          || state.tabs.some((path, index) => tabsEl.children[index]?.dataset.noteTabPath !== path)) cancelTabCloseMotion();
      else if (state.tabs.some(path => existing.get(path)?.title !== noteTabTitle(path))) motionPositions = captureTabCloseMotion(true);
    }
    state.tabs.forEach((tabPath, index) => {
      const blank = isBlankTab(tabPath), graph = isGraphTab(tabPath);
      const title = noteTabTitle(tabPath);
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
      tab.className = 'note-tab' + (tabPath === activeTab ? ' active' : '') + (blank ? ' is-blank' : '') + (graph ? ' is-graph' : '');
      tab.dataset.noteTabPath = tabPath;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tabPath === activeTab ? 'true' : 'false');
      if (graph) tab.setAttribute('aria-controls', 'note-graph-panel'); else tab.removeAttribute('aria-controls');
      tab.title = title;
      tab.tabIndex = tabPath === activeTab ? 0 : -1;
      tab.draggable = true;
      const label = tab.querySelector('.note-tab-label');
      if (graph && !tab.querySelector('.note-tab-graph-icon')) tab.insertBefore(noteIcon('graph', 'note-tab-graph-icon'), label);
      if (!graph) tab.querySelector('.note-tab-graph-icon')?.remove();
      label.textContent = title;
      const close = tab.querySelector('.note-tab-close');
      close.dataset.noteTabClose = tabPath;
      close.setAttribute('aria-label', tr('closeTab') + ' · ' + title);
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
    if (active && state.renderedActiveTab !== activeTab) requestTabScroll(active, activeTab);
    state.renderedActiveTab = activeTab;
    playTabCloseMotion(motionPositions);
  }
  function remapTabs(source, destination) {
    state.tabs = Array.from(new Set(state.tabs.map((path) => isSpecialTab(path) ? path : mapPath(path, source, destination))));
    state.activeTab = isSpecialTab(state.activeTab) ? state.activeTab : mapPath(state.activeTab, source, destination);
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
    if (isGraphTab(tabPath)) return activateGraphTab(options);
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
    if (!state.tabs.includes(tabPath)) return false;
    const cached = isSpecialTab(tabPath) ? null : state.documentCache.get(tabPath);
    if (!(options && options.skipSave) && cached && !(await flushSave(cached))) return false;
    // Saving can yield to another close or tab switch; use the current identity.
    const index = state.tabs.indexOf(tabPath);
    if (index < 0) return false;
    const active = state.activeTab === tabPath;
    tabCloseMotionPending = true;
    state.tabs.splice(index, 1);
    if (isGraphTab(tabPath)) {
      noteGraphIntentSequence++; noteGraph?.deactivate({ clearCache: true }); backgroundTargetChanged(true);
    }
    persistTabs();
    renderTabs();
    if (!active) return true;
    // A failed read of the next file must not leave a closed graph occupying the pane.
    if (isGraphTab(tabPath)) clearCurrent({ keepTabs: true, keepCache: true });
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
      if (isSpecialTab(path)) continue;
      const cached = state.documentCache.get(path);
      if (cached && cached !== current && !(await flushSave(cached))) return false;
    }
    tabCloseMotionPending = true;
    state.tabs = [];
    state.activeTab = '';
    noteGraphIntentSequence++; noteGraph?.deactivate({ clearCache: true });
    backgroundTargetChanged(true);
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
    host.__noteTreeDispose?.(); host.__noteTreeDispose = null; host.__noteTreeRender = null; host.__noteFinishMotion = null;
    host.__noteWindow?.dispose(); host.__noteWindow = null;
    host.__noteMoreObserver?.disconnect(); host.__noteMoreObserver = null;
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
    if (noteSystem?.read().prefetch === false || !noteWorkspaceVisible() || noteMovePromise) return;
    state.prefetchTimer = setTimeout(runDocumentPrefetch, 350);
  }
  function stopDocumentPrefetch() {
    prefetchEpoch += 1; clearTimeout(state.prefetchTimer); clearTimeout(hoverPrefetchTimer);
    state.prefetchTimer = 0; hoverPrefetchTimer = 0; hoverPrefetchPath = '';
  }
  async function runDocumentPrefetch() {
    state.prefetchTimer = 0;
    if (noteSystem?.read().prefetch === false || prefetchRunning || !noteWorkspaceVisible() || editorInputPending() || noteMovePromise) return;
    const epoch = prefetchEpoch;
    const viewport = sidebarScroll.getBoundingClientRect();
    const paths = Array.from(treeEl.querySelectorAll('.note-tree-row')).filter((row) => {
      const rect = row.getBoundingClientRect(); return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    }).map((row) => row.dataset.notePath);
    if (hoverPrefetchPath) paths.unshift(hoverPrefetchPath);
    const candidates = Array.from(new Set(paths)).map(findEntry).filter((entry) => entry && entry.kind === 'note'
      && Number(entry.size || 0) <= 512 * 1024 && !state.documentCache.has(entry.path)).slice(0, 4);
    prefetchRunning = true;
    try {
      for (const entry of candidates) {
        if (epoch !== prefetchEpoch || !noteWorkspaceVisible() || editorInputPending()) break;
        if (state.documentCache.has(entry.path)) continue;
        try {
          const data = await fetchDocument(entry.path);
          if (epoch === prefetchEpoch && noteWorkspaceVisible() && !state.documentCache.has(entry.path)
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
    if (state.renamePath && findEntry(state.renamePath) && treeEl.contains(document.activeElement) && document.activeElement.classList.contains('note-tree-rename')) {
      state.pendingTreeReorder = true; updateTreeSelection(); return;
    }
    if (!options?.entryIndexReady) rebuildEntryIndex();
    renderTreeInto(treeEl, visibleTreeEntries(), state.expanded, false);
    state.treeRendered = true;
    state.renderedOrder = options?.orderSignature ?? treeOrderSignature(state.entries);
    state.pendingTreeReorder = false;
    updateNotebookRootLabel();
    if (!options?.keepNotebookTree) { state.notebookTreeDirty = true; renderNotebookTree(); }
    const parent = state.notebookRoot;
    if (parent !== null && !state.treePagination?.[parent]) loadDirectory(parent);
  }
  function renderNotebookTree() {
    if (!notebookTreeEl || !root.classList.contains('links-overlay-open') || effectiveSideMode() !== 'notebooks') return;
    if (state.notebookTreeDirty) {
      renderTreeInto(notebookTreeEl, notebookRoots(), state.notebookExpanded, true);
      state.notebookTreeDirty = false;
    }
    updateNotebookSelection(); updateNotebookExpandButton();
  }
  function renderTreeInto(treeEl, treeEntries, expandedPaths, notebookTree) {
    if (treeEl.__noteTreeRender) { treeEl.__noteTreeRender(treeEntries, expandedPaths); return; }
    clearTreeRowIndex(treeEl);
    const rowIndex = treeRowIndexes.get(treeEl);
    const motions = new Map(), moreRows = new Map();
    let orderedLevels = new Map(), visibleCount = 0;
    const getEntry = (path) => notebookTree && (path === '' || isNotebookRoot(path)) ? notebookRoots().find((entry) => entry.path === path) : findEntry(path);
    const reducedMotion = () => tabMotionPreference.matches;
    const folderLabel = (entry, expanded) => entry.path + ' · ' + tr(expanded ? 'collapseFolder' : 'expandFolder');
    const directChild = (wrapper, className) => Array.from(wrapper.children).find((child) => child.classList && child.classList.contains(className)) || null;
    const liveWrapper = (path) => rowIndex.rows.get(path)?.parentElement || null;

    function cancelMotion(shell) {
      const task = motions.get(shell);
      if (!task) return;
      if (task.frame) cancelAnimationFrame(task.frame);
      clearTimeout(task.timer); shell.removeEventListener('transitionend', task.onEnd);
      motions.delete(shell);
    }
    function removeTreeNode(node) {
      if (node.nodeType !== 1) { node.remove(); return; }
      for (const shell of motions.keys()) if (node === shell || node.contains(shell)) cancelMotion(shell);
      node.querySelectorAll('.note-tree-row').forEach((row) => {
        if (rowIndex.rows.get(row.dataset.notePath) === row) rowIndex.rows.delete(row.dataset.notePath);
      });
      rowIndex.selectionKey = null;
      node.remove();
    }
    function removeChildrenShell(shell) { cancelMotion(shell); removeTreeNode(shell); }
    function setShellExpanded(shell, expanded, animate, initial) {
      if (shell.__noteExpanded === expanded && !initial) return;
      cancelMotion(shell); shell.__noteExpanded = expanded;
      shell.inert = !expanded;
      shell.setAttribute('aria-hidden', String(!expanded));
      shell.classList.toggle('is-collapsing', !expanded);
      if (!animate || reducedMotion() || !noteWorkspaceVisible()) {
        shell.classList.toggle('is-open', expanded);
        if (!expanded) removeChildrenShell(shell);
        return;
      }
      const finish = () => {
        if (motions.get(shell) !== task) return;
        cancelMotion(shell);
        shell.classList.toggle('is-open', shell.__noteExpanded);
        if (!shell.__noteExpanded) removeChildrenShell(shell);
      };
      const task = { frame: 0, timer: 0, finish, onEnd(event) {
        if (event.target !== shell || event.propertyName !== 'grid-template-rows' || task.frame) return;
        // An already queued end event from the previous direction cannot finish
        // the current transition. The timeout also covers older CSS engines.
        if ((shell.getAnimations?.() || []).some(animation => animation.transitionProperty === 'grid-template-rows' && animation.playState === 'running')) return;
        finish();
      } };
      motions.set(shell, task); shell.addEventListener('transitionend', task.onEnd);
      const apply = () => {
        task.frame = 0;
        if (!shell.isConnected) { cancelMotion(shell); return; }
        shell.classList.toggle('is-open', expanded);
        task.timer = window.setTimeout(finish, TREE_MOTION_MS + 60);
      };
      if (initial) {
        // Only newly attached shells need an initial collapsed layout. Reversals
        // use the current CSS transition without another forced measurement.
        void shell.offsetHeight;
        task.frame = requestAnimationFrame(apply);
      } else apply();
    }

    function createChildrenShell(entry, depth, wrapper, animate) {
      if (!entry.children?.length && !state.treePagination?.[entry.path]?.hasMore) return null;
      const shell = document.createElement('div'); shell.className = 'note-tree-children-shell';
      const children = document.createElement('div'); children.className = 'note-tree-children';
      shell.appendChild(children); wrapper.appendChild(shell);
      renderLevel(entry.children || [], depth + 1, children, false, entry.path);
      setShellExpanded(shell, true, animate, true);
      return shell;
    }

    function syncChildren(entry, depth, wrapper, flat, animate) {
      const shell = directChild(wrapper, 'note-tree-children-shell');
      if (flat || entry.kind !== 'folder') { if (shell) removeChildrenShell(shell); return; }
      if (expandedPaths.has(entry.path)) {
        if (shell) {
          renderLevel(entry.children || [], depth + 1, shell.firstChild, false, entry.path);
          setShellExpanded(shell, true, animate);
        } else createChildrenShell(entry, depth, wrapper, animate);
      } else if (shell) setShellExpanded(shell, false, animate);
    }
    function syncRow(entry, depth, wrapper) {
      const row = directChild(wrapper, 'note-tree-row');
      const set = (name, value) => { if (row.getAttribute(name) !== value) row.setAttribute(name, value); };
      const depthValue = String(depth);
      for (const element of [wrapper, row]) if (element.style.getPropertyValue('--note-depth') !== depthValue) element.style.setProperty('--note-depth', depthValue);
      const draggable = !notebookTree && state.renamePath !== entry.path;
      if (row.draggable !== draggable) row.draggable = draggable;
      if (row.title !== entry.path) row.title = entry.path;
      const expanded = expandedPaths.has(entry.path);
      if (entry.kind === 'folder') set('aria-expanded', String(expanded));
      set('aria-label', entry.kind === 'folder' ? folderLabel(entry, expanded) : entry.path);
      const label = row.querySelector('.note-tree-label');
      if (!wrapper.__noteRenaming && label.textContent !== entry.name) label.textContent = entry.name;
      const icon = row.querySelector('.note-notebook-icon');
      const color = state.notebookColors[entry.path] || 'gray';
      if (icon && icon.dataset.color !== color) icon.dataset.color = color;
      if (rowIndex.rows.get(entry.path) !== row) { rowIndex.rows.set(entry.path, row); rowIndex.selectionKey = null; }
    }
    function ordered(entries, depth) {
      if (notebookTree && depth === 0) return entries;
      if (!orderedLevels.has(entries)) orderedLevels.set(entries, sortedTreeEntries(entries));
      return orderedLevels.get(entries);
    }
    function syncLevel(host, children) {
      const kept = new Set(children);
      for (const child of Array.from(host.childNodes)) if (!kept.has(child)) removeTreeNode(child);
      const focusIndex = children.findIndex(child => child.contains(document.activeElement));
      if (!host.moveBefore && focusIndex >= 0) {
        // Keep the focused row attached in older WebView2 when its siblings move.
        let anchor = null;
        for (let i = children.length - 1; i > focusIndex; i--) {
          const child = children[i];
          if (child.parentNode !== host || child.nextSibling !== anchor) host.insertBefore(child, anchor);
          anchor = child;
        }
        anchor = children[focusIndex];
        if (anchor.parentNode !== host) host.appendChild(anchor);
        for (let i = focusIndex - 1; i >= 0; i--) {
          const child = children[i];
          if (child.parentNode !== host || child.nextSibling !== anchor) host.insertBefore(child, anchor);
          anchor = child;
        }
        return;
      }
      let next = host.firstChild;
      for (const child of children) {
        if (child === next) next = next.nextSibling;
        else if (host.moveBefore && child.parentNode === host) host.moveBefore(child, next);
        else host.insertBefore(child, next);
      }
    }
    function descendantCount(entry) {
      let count = state.treePagination?.[entry.path]?.hasMore ? 1 : 0;
      for (const child of entry.children || []) {
        count++;
        if (child.kind === 'folder' && expandedPaths.has(child.path)) count += descendantCount(child);
        if (count > 200) break;
      }
      return count;
    }
    function setFolderExpanded(path, expanded) {
      const entry = getEntry(path); const wrapper = liveWrapper(path);
      if (!entry || entry.kind !== 'folder' || !wrapper) return;
      const row = directChild(wrapper, 'note-tree-row');
      if (!row) return;
      const descendants = descendantCount(entry);
      if (expanded) expandedPaths.add(path); else expandedPaths.delete(path);
      if (expanded && !state.treePagination?.[path]) loadDirectory(path);
      if (notebookTree) { queueNotebookSettings({ ui: notebookUi() }); updateNotebookExpandButton(); } else { persistExpanded(); updateExpandAllButton(); }
      if (treeEl.__noteWindow || expanded && visibleCount + descendants > 200) renderView(treeEntries, expandedPaths);
      else {
        visibleCount += expanded ? descendants : -descendants;
        syncRow(entry, Number(wrapper.style.getPropertyValue('--note-depth')) || 0, wrapper);
        syncChildren(entry, Number(wrapper.style.getPropertyValue('--note-depth')) || 0, wrapper, false, true);
      }
      updateTreeSelection();
    }

    function reusableWrapper(wrapper, entry) {
      const renaming = !!entry.path && state.renamePath === entry.path;
      return !!wrapper && wrapper.__noteKind === entry.kind && wrapper.__noteNotebook === !!entry.notebook
        && wrapper.__noteRenaming === renaming && wrapper.__noteRenameError === (renaming ? state.renameError : '');
    }
    function createEntryWrapper(entry, depth, flat) {
      const renaming = !!entry.path && state.renamePath === entry.path;
      // Reused rows retain only their identity, never an old directory snapshot.
      const rowPath = entry.path, notebookEntry = !!entry.notebook;
      const wrapper = document.createElement('div'); wrapper.className = 'note-tree-entry'; wrapper.dataset.path = entry.path; wrapper.style.setProperty('--note-depth', depth);
      wrapper.__noteKind = entry.kind; wrapper.__noteNotebook = !!entry.notebook;
      wrapper.__noteRenaming = renaming; wrapper.__noteRenameError = renaming ? state.renameError : '';
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
        input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitInlineRename(getEntry(rowPath), input, false); } else if (event.key === 'Escape') { event.preventDefault(); commitInlineRename(getEntry(rowPath), input, true); } });
        input.addEventListener('blur', () => commitInlineRename(getEntry(rowPath), input, false)); requestAnimationFrame(() => { input.focus(); input.select(); });
      } else label.textContent = entry.name;
      row.append(toggle, entry.notebook ? notebookIcon(entry.path) : treeIcon(entry.kind), label);
      async function activateRow(expansion) {
        const clickedPath = rowPath;
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
      row.addEventListener('click', (event) => activateRow(notebookEntry && !toggle.contains(event.target) ? null : undefined));
      if (entry.notebook && entry.path) label.addEventListener('dblclick', async (event) => {
        if (event.target.closest('input')) return;
        event.preventDefault(); event.stopPropagation();
        if (!(await finishInlineTitle()) || state.renamePath && !(await finishInlineRename())) return;
        if (editorInputPending()) await whenEditorInputSettled();
        if (state.active && effectiveSideMode() === 'notebooks' && root.classList.contains('links-overlay-open') && findEntry(rowPath)?.kind === 'folder') beginInlineRename(rowPath);
      });
      if (entry.notebook) row.addEventListener('keydown', (event) => {
        if (event.target !== row || event.isComposing || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
        event.preventDefault(); event.stopPropagation(); activateRow(event.key === 'ArrowRight');
      });
      row.addEventListener('pointerenter', () => {
        if (noteSystem?.read().prefetch === false) return;
        const liveEntry = getEntry(rowPath);
        if (liveEntry?.kind !== 'note' || Number(liveEntry.size || 0) > 512 * 1024 || state.documentCache.has(rowPath)) return;
        clearTimeout(hoverPrefetchTimer);
        hoverPrefetchTimer = setTimeout(() => { hoverPrefetchPath = rowPath; runDocumentPrefetch(); }, 150);
      });
      row.addEventListener('pointerleave', () => { clearTimeout(hoverPrefetchTimer); hoverPrefetchPath = ''; });
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); const liveEntry = getEntry(rowPath); if (!liveEntry) return; if (notebookEntry) { openNotebookContext(liveEntry, event.clientX, event.clientY); return; } if (notebookTree) selectNotebook(notebookRootForPath(rowPath)); state.rootTargeted = false; state.selectedPath = rowPath; state.selectedFolder = liveEntry.kind === 'folder' ? rowPath : parentPath(rowPath); updateTreeSelection(); openContextMenu(liveEntry, event.clientX, event.clientY); });
      row.addEventListener('dragstart', (event) => {
        if (notebookTree || !row.draggable || !noteWorkspaceVisible() || noteMovePromise || notebookDropRunning) { event.preventDefault(); return; }
        clearNoteTreeDrag(); state.draggedPath = rowPath; noteTreeDragRow = row; row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-relatum-note-path', rowPath);
      });
      row.addEventListener('dragend', clearNoteTreeDrag);
      row.addEventListener('dragover', (event) => {
        if (notebookTree) {
          if (!notebookEntry || !notebookDropSource(rowPath)) return;
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; row.classList.add('note-drop-target'); return;
        }
        const external = !state.draggedPath && Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file');
        if (!state.draggedPath && !external) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = external ? 'copy' : 'move'; row.classList.add('note-drop-target');
      });
      row.addEventListener('dragleave', (event) => { if (!row.contains(event.relatedTarget)) row.classList.remove('note-drop-target'); });
      row.addEventListener('drop', (event) => {
        if (notebookTree) {
          const source = notebookEntry ? notebookDropSource(rowPath) : '';
          if (!source) return;
          event.preventDefault(); event.stopPropagation(); clearNoteTreeDrag(); moveFolderToNotebook(source, rowPath); return;
        }
        event.preventDefault(); event.stopPropagation(); row.classList.remove('note-drop-target');
        const liveEntry = getEntry(rowPath); if (!liveEntry) return;
        const destination = liveEntry.kind === 'folder' ? rowPath : parentPath(rowPath);
        if (state.draggedPath) moveEntry(state.draggedPath, destination); else importDataTransfer(event.dataTransfer, destination);
      });
      wrapper.appendChild(row);
      if (entry.path && state.renamePath === entry.path && state.renameError) { const error = document.createElement('small'); error.className = 'note-tree-inline-error'; error.textContent = state.renameError; wrapper.appendChild(error); }
      syncChildren(entry, depth, wrapper, flat, false);
      return wrapper;
    }
    function renderLevel(entries, depth, host, flat, parent) {
      const next = ordered(entries, depth).map(entry => {
        if (entry.kind === 'more') return moreRow(entry.moreParent, depth);
        const previous = liveWrapper(entry.path);
        if (!reusableWrapper(previous, entry)) return createEntryWrapper(entry, depth, flat);
        syncRow(entry, depth, previous); syncChildren(entry, depth, previous, flat, true);
        return previous;
      });
      if (parent !== undefined && state.treePagination?.[parent]?.hasMore) next.push(moreRow(parent, depth));
      syncLevel(host, next);
    }
    function moreRow(parent, depth) {
      const previous = moreRows.get(parent);
      if (previous) {
        const label = language() === 'en' ? 'Load more' : '加载更多';
        if (previous.textContent !== label) previous.textContent = label;
        if (previous.style.getPropertyValue('--note-depth') !== String(depth)) previous.style.setProperty('--note-depth', depth);
        treeEl.__noteMoreObserver?.observe(previous); return previous;
      }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-tree-more';
      button.textContent = language() === 'en' ? 'Load more' : '加载更多'; button.dataset.noteMore = parent; button.style.setProperty('--note-depth', depth);
      button.addEventListener('click', () => loadDirectory(parent));
      if (!treeEl.__noteMoreObserver && typeof IntersectionObserver === 'function') treeEl.__noteMoreObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting && entry.target.isConnected) loadDirectory(entry.target.dataset.noteMore);
      }, { root: notebookTree ? treeEl : sidebarScroll, rootMargin: '150px' });
      moreRows.set(parent, button); treeEl.__noteMoreObserver?.observe(button); return button;
    }
    function renderView(entries, paths) {
      treeEntries = entries; expandedPaths = paths; orderedLevels = new Map();
      treeEl.__noteMoreObserver?.disconnect();
      const flatRows = [];
      function flattenVisible(entries, depth, parent) {
        ordered(entries, depth).forEach(entry => {
          flatRows.push({ entry, depth });
          if (entry.kind === 'folder' && expandedPaths.has(entry.path)) flattenVisible(entry.children || [], depth + 1, entry.path);
        });
        if (state.treePagination?.[parent]?.hasMore) flatRows.push({ entry: { kind: 'more', path: 'relatum:more:' + parent, moreParent: parent }, depth });
      }
      flattenVisible(treeEntries, 0, notebookTree ? null : state.notebookRoot || '');
      visibleCount = flatRows.length;
      if (flatRows.length > 200 && window.RelatumWindowedList) {
        if (!treeEl.__noteWindow) treeEl.__noteWindow = window.RelatumWindowedList.create({ host: treeEl, scroller: notebookTree ? treeEl : sidebarScroll,
          estimate: 31, reuseRows: (wrapper, item) => item.entry.kind === 'more' || reusableWrapper(wrapper, item.entry),
          key: item => item.entry.path, render: item => {
            if (item.entry.kind === 'more') return moreRow(item.entry.moreParent, item.depth);
            const previous = liveWrapper(item.entry.path);
            if (reusableWrapper(previous, item.entry)) {
              syncChildren(item.entry, item.depth, previous, true, false); return previous;
            }
            return createEntryWrapper(item.entry, item.depth, true);
          }, update(wrapper, item) {
            if (wrapper.__noteItem === item) return;
            wrapper.__noteItem = item;
            if (item.entry.kind === 'more') { moreRows.set(item.entry.moreParent, wrapper); moreRow(item.entry.moreParent, item.depth); return; }
            syncRow(item.entry, item.depth, wrapper);
          }, onMount() {
            for (const [path, row] of rowIndex.rows) if (!row.isConnected) { rowIndex.rows.delete(path); rowIndex.selectionKey = null; }
            updateTreeSelection();
          } });
        treeEl.__noteWindow.setItems(flatRows);
      } else {
        treeEl.__noteWindow?.dispose(); treeEl.__noteWindow = null;
        renderLevel(treeEntries, 0, treeEl, false, notebookTree ? undefined : state.notebookRoot || '');
        if (!treeEntries.length && (notebookTree || state.notebookRoot !== null) && !treeEl.childNodes.length) {
          const message = document.createElement('p'); message.className = 'note-tree-empty';
          message.textContent = state.indexState?.incomplete ? tr('readFailed') : tr('emptyTree'); treeEl.appendChild(message);
        }
      }
      for (const [parent, row] of moreRows) if (!row.isConnected) moreRows.delete(parent);
      updateTreeSelection(); if (!notebookTree) updateExpandAllButton();
    }
    treeEl.__noteTreeRender = renderView;
    treeEl.__noteFinishMotion = () => { for (const task of Array.from(motions.values())) task.finish(); };
    treeEl.__noteTreeDispose = () => { for (const shell of motions.keys()) cancelMotion(shell); moreRows.clear(); orderedLevels.clear(); };
    renderView(treeEntries, expandedPaths);
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
    const isLiveTab = (path) => isSpecialTab(path) || !!findEntry(path);
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
    const current = () => seq === state.refreshSeq && !noteMovePromise
      && (options?.externalSeq === undefined || options.externalSeq === state.externalSeq && noteWorkspaceVisible());
    try {
      indexActivity(noteWorkspaceVisible());
      let result;
      let indexChanged = false;
      let graphRetired = false;
      const reconcile = state.initialized && !options?.background && options?.reconcile !== false && noteWorkspaceVisible();
      if (state.indexGeneration !== undefined && !options?.reset && !reconcile) {
        const delta = await request('/api/note-changes?since=' + state.indexGeneration); if (!current()) return false;
        indexChanged = delta.changes?.length > 0 || state.indexState?.phase !== delta.index?.phase;
        state.indexState = delta.index;
        if (!delta.reset && !delta.hasMore) {
          if (!delta.changes.length && !announce) { if (indexChanged) noteBrowser?.invalidate(); state.externalSyncUnchanged = Math.min(EXTERNAL_SYNC_DELAYS.length - 1, state.externalSyncUnchanged + 1); return true; }
          for (const change of delta.changes) {
            if (change.removed) {
              if (change.path === '' || isNotebookRoot(change.path)) { updateNoteGraphSession(change.path); graphRetired = true; }
              if (change.path === '') state.entries = []; else removeTreeEntry(state.entries, change.path);
              for (const path of state.entryIndex.keys()) if (path === change.path || path.startsWith(change.path + '/')) state.entryIndex.delete(path);
              let changed = false;
              for (const path of recentFiles.keys()) if (path === change.path || path.startsWith(change.path + '/')) { recentFiles.delete(path); changed = true; }
              if (changed) persistRecent();
            } else mergeTreeItem(change.item);
          }
          result = { entries: state.entries, generation: delta.cursor, index: delta.index, pagination: state.treePagination };
        }
      }
      if (!result) {
        result = await request('/api/notes-tree?view=' + encodeURIComponent(JSON.stringify(treeView())) + (state.notebookSettingsLoaded ? '' : '&notebookSettings=1') + '&visible=' + (noteWorkspaceVisible() ? '1' : '0') + (reconcile ? '&reconcile=1' : ''));
        if (!current()) return false;
        if (!state.treeRendered && !result.entries?.length && (result.index?.phase === 'scanning' || result.index?.total > 0) && noteWorkspaceVisible()) {
          await new Promise(resolve => setTimeout(resolve, 60)); return refreshTree(announce, options);
        }
      }
      state.indexGeneration = result.generation; state.indexState = result.index; state.treePagination = result.pagination || state.treePagination || {};
      const entries = Array.isArray(result.entries) ? result.entries : [];
      const flat = flattenEntries(entries, []);
      const signature = JSON.stringify(flat.map((entry) => [entry.path, entry.modifiedNs, entry.size, entry.revision]));
      const browserChanged = signature !== state.treeMetadataSignature;
      if (signature !== state.treeMetadataSignature) { state.externalSyncUnchanged = 0; state.treeMetadataSignature = signature; }
      else if (options && options.background) state.externalSyncUnchanged = Math.min(EXTERNAL_SYNC_DELAYS.length - 1, state.externalSyncUnchanged + 1);
      const structureChanged = !state.treeRendered || !sameTreeStructure(state.entries, entries);
      const orderSignature = treeOrderSignature(entries);
      const orderChanged = state.renderedOrder !== orderSignature;
      const previousTabs = state.tabs.slice();
      // Always refresh metadata for cache validation; unchanged rows retain focus,
      // inline rename drafts and any folder transition already in progress.
      const previousNotebookRoots = notebookRoots().map(entry => entry.path);
      state.entries = entries;
      rebuildEntryIndex(flat);
      if (!state.notebookSettingsLoaded) restoreNotebookSettings(result.notebookSettings);
      const previousNotebookRoot = state.notebookRoot;
      const notebookMissing = reconcileNotebooks();
      const liveRoots = new Set(notebookRoots().map(entry => entry.path));
      previousNotebookRoots.forEach(path => { if (path && !liveRoots.has(path)) updateNoteGraphSession(path); });
      if (browserChanged || indexChanged) { noteBrowser?.invalidate(); noteGraph?.checkExternalChanges(); }
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
      if (graphRetired && graphContentActive()) await resumeNoteGraph();
      if (structureChanged) scheduleDocumentPrefetch();
      if (announce) showToast(tr('refreshed'));
      return true;
    }
    catch (error) {
      if (!current()) return false;
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
      items.forEach((item) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'note-link-card'; if (kind === 'outgoing') button.dataset.state = item.state || ''; const title = document.createElement('strong'); title.textContent = item.label || noteTitle(item.path || item.rawTarget); const meta = document.createElement('span'); meta.textContent = kind === 'backlink' ? item.path + (item.line ? ' · L' + item.line : '') : item.state === 'ambiguous' ? tr('ambiguous') : item.state !== 'resolved' ? tr('missing') : item.path; const excerpt = document.createElement('small'); excerpt.textContent = item.excerpt || ''; button.append(title, meta, excerpt); if (item.path) button.addEventListener('click', () => openNote(item.path)); else if (item.state === 'missing') button.addEventListener('click', () => openWikiFromEditor(item.rawTarget)); else button.disabled = true; fragment.appendChild(button); });
      if (!items.length) { const message = document.createElement('p'); message.className = 'note-link-empty'; message.textContent = kind === 'outgoing' ? tr('noOutgoing') : tr('noBacklinks'); fragment.appendChild(message); }
      target.replaceChildren(fragment);
    }
    list(outgoingEl, outgoing, 'outgoing'); list(backlinksEl, backlinks, 'backlink');
  }
  async function ensureLinks() {
    if (!state.current || !noteWorkspaceVisible()) return false;
    const documentState = state.current; const path = documentState.path; const revision = documentState.revision;
    documentState.linksRefreshNeeded = true;
    const seq = ++state.linksSeq;
    try {
      const result = await request('/api/note-links?path=' + encodeURIComponent(path));
      if (seq !== state.linksSeq || !noteWorkspaceVisible() || state.current !== documentState || documentState.path !== path) return false;
      documentState.outgoing = result.outgoing || []; documentState.backlinks = result.backlinks || [];
      if (documentState.revision === revision && result.revision === revision) documentState.linksRefreshNeeded = false;
      else scheduleLinksRefresh(documentState);
      renderLinks(); return true;
    } catch (error) { return false; }
  }
  function cancelLinksRefresh() {
    clearTimeout(state.linksRefreshTimer);
    state.linksRefreshTimer = 0;
  }
  function linksRefreshVisible(documentState) {
    return !!documentState && state.current === documentState && noteWorkspaceVisible()
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
    setGraphPresentation(graphEnabled() && state.initialized && isGraphTab(state.activeTab) && !browserResultsActive());
    const hasNote = !!state.current;
    empty.hidden = hasNote;
    if (inlineTitleShell) inlineTitleShell.hidden = !hasNote;
    if (documentStatusEl) documentStatusEl.hidden = !hasNote;
    editorHost.hidden = !hasNote || !liveEditor || state.viewMode === 'reading';
    fallbackEditor.hidden = !hasNote || state.viewMode === 'reading' || !!liveEditor;
    if (readingHost) readingHost.hidden = !hasNote || state.viewMode !== 'reading';
    updateViewToggle();
    updateImageTextTools();
    syncOutline();
    document.dispatchEvent(new Event('relatum:usage-target'));
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
    closeNoteModal();
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
    document.dispatchEvent(new Event('relatum:usage-target'));
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
  function clearCurrent(options) { closeNoteModal(); cancelLinksRefresh(); clearTimeout(state.saveTimer); const oldPath = state.current && state.current.path; if (oldPath) window.RelatumNoteCanvas?.releaseNote(oldPath); state.openSeq += 1; state.editGeneration += 1; state.openingPath = ''; setDocumentSwitchPending(false); state.current = null; if (oldPath && !(options && options.keepCache)) state.documentCache.delete(oldPath); if (oldPath && !(options && options.keepTabs)) state.tabs = state.tabs.filter((path) => path !== oldPath); if (!(options && options.keepActiveTab)) state.activeTab = ''; persistTabs(); setEditorDocument(null); renderCurrentPath(''); renderInlineTitle('', true); clearSaveError(); desktopDirty(false); try { localStorage.removeItem(ACTIVE_PATH_KEY); } catch (error) {} updateTreeSelection(); renderTabs(); renderLinks(); updateEditorVisibility(); }
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
    noteOutline?.documentChanged();
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
        recordRecent(path); if (noteBrowser) noteBrowser.invalidate(); noteGraph?.invalidate(notebookRootForPath(path));
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
  function clearNoteOpenPending(attempt) {
    if (noteOpenAttempt !== attempt || attempt.sequence !== state.openSeq
        || !state.openingPath && !root.classList.contains('note-document-switch-pending')) return;
    state.openingPath = '';
    setDocumentSwitchPending(false);
    renderCurrentPath(state.current?.path || '');
    updateTreeSelection(); renderTabs(); resumeLinksRefresh();
  }
  async function openNote(path, options) {
    const attempt = { sequence: state.openSeq };
    noteOpenAttempt = attempt;
    try {
      return await withNoteBusy(() => openNoteNow(path, options, attempt));
    } catch (error) {
      if (noteOpenAttempt === attempt && attempt.sequence === state.openSeq) showToast(error.message || tr('readFailed'), 'error');
      return false;
    } finally {
      if (noteOpenAttempt === attempt) {
        // Tree clicks prime their feedback before saving. Every exit, including
        // a rejected preparation, must release only this open's pending state.
        clearNoteOpenPending(attempt);
        noteOpenAttempt = null;
      }
    }
  }
  async function openNoteNow(path, options, attempt) {
    const fromGraph = graphPresentation, graphRoot = state.notebookRoot, graphIntent = noteGraphIntentSequence;
    const graphValid = () => (!options?.graphGuard || options.graphGuard()) && (!fromGraph ||
      (graphPresentation && state.notebookRoot === graphRoot && noteGraphIntentSequence === graphIntent));
    const current = () => noteOpenAttempt === attempt && attempt.sequence === state.openSeq && graphValid();
    if (noteMovePromise) path = await waitForNoteMove(path);
    if (!current() || !(await flushCanvases()) || !current()) return false;
    if (!fromGraph && noteBrowser) noteBrowser.showDocument({ keepAction: !!options?.browserAction });
    if (state.imageTextBusy && !(await imageTextOperationPromise)) return false;
    if (!current() || !path) return false;
    if (state.current && state.current.path !== path && editorInputPending()) await whenEditorInputSettled();
    if (!current()) return false;
    const commitSelection = () => {
      selectNoteTab(path, !(options && options.reuseActiveTab === false));
      if (fromGraph) setGraphPresentation(false);
      if (noteBrowser) noteBrowser.showDocument({ keepAction: !!options?.browserAction });
      if (!state.restoringNotebookSelection && !options?.preserveNotebook) selectNotebook(notebookRootForPath(path));
      state.rootTargeted = false; state.selectedPath = path; state.selectedFolder = parentPath(path);
    };
    if (!fromGraph) commitSelection();
    if (state.current && state.current.path === path && !(options && options.force)) { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); renderTabs(); updateEditorVisibility(); if (!(options && (options.noRecent || options.force))) recordRecent(path); return true; }
    cancelLinksRefresh();
    const previous = state.current; rememberEditorState(previous);
    attempt.sequence = ++state.openSeq; state.openingPath = path;
    if (!fromGraph) { state.rootTargeted = false; state.selectedPath = path; state.selectedFolder = parentPath(path); }
    renderTabs();
    const treeExpanded = state.notebookRoot === notebookRootForPath(path) && expandTreePath(path, false);
    if (!fromGraph && !(options && options.selectionPrimed)) { renderCurrentPath(path); if (treeExpanded) renderTree(); else updateTreeSelection(); }
    const cached = state.documentCache.get(path);
    if (cached && !(options && options.force)) {
      if (!(options && options.skipSave) && previous) flushSave(previous);
      if (previous) await window.RelatumNoteCanvas?.releaseNote(previous.path);
      if (!current()) return false;
      if (fromGraph) commitSelection();
      applyDocument(cached);
      if (!(options && (options.noRecent || options.force))) recordRecent(path);
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current === cached) focusEditor(); });
      return true;
    }
    setDocumentSwitchPending(true);
    const loadPromise = fetchDocument(path);
    if (!(options && options.skipSave) && previous) flushSave(previous);
    try {
      const data = await loadPromise; if (!current()) return false;
      const shown = state.current && state.current.path === path ? state.current : null;
      if (!shown || (!hasPendingEdits(shown) && shown.revision !== data.revision)) {
        if (previous) await window.RelatumNoteCanvas?.releaseNote(previous.path);
        if (!current()) return false;
        if (fromGraph) commitSelection();
        applyDocument(data);
      }
      else { state.openingPath = ''; setDocumentSwitchPending(false); updateTreeSelection(); resumeLinksRefresh(); }
      if (!(options && (options.noRecent || options.force))) recordRecent(path);
      if (!(options && options.noFocus)) requestAnimationFrame(() => { if (state.current && state.current.path === path) focusEditor(); });
      return true;
    } catch (error) {
      if (!current()) return false;
      const missing = isMissingError(error);
      clearNoteOpenPending(attempt);
      if (error.code !== 'aborted' && !missing) showToast(error.message || tr('readFailed'), 'error');
      if (error.code !== 'aborted') await refreshTree(false, { silentErrors: missing });
      return false;
    }
  }
  async function createEntry(kind, options) {
    if (noteMovePromise) await waitForNoteMove();
    if (options?.guard && !options.guard()) return;
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
      if (options?.guard && !options.guard()) return result;
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
  async function movePath(source, destination, quiet, options) {
    return withNoteBusy(() => movePathNow(source, destination, quiet, options));
  }
  async function movePathNow(source, destination, quiet, options) {
    if (!source || !destination || source === destination) return true;
    while (noteMovePromise) {
      const paths = noteMovePaths;
      if (await noteMovePromise && paths) {
        source = mapPath(source, paths.source, paths.destination);
        destination = mapPath(destination, paths.source, paths.destination);
      }
    }
    const operation = performMove(source, destination, quiet, options);
    noteMovePromise = operation;
    noteMovePaths = { source, destination };
    try {
      const ok = await operation;
      options?.onResult?.(ok, state.lastMoveCode, state.lastMoveError);
      return ok;
    }
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
  async function performMove(source, destination, quiet, options) {
    state.lastMoveError = ''; state.lastMoveCode = '';
    if (options?.guard && !options.guard()) return false;
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
    if (options?.prepare && !(await options.prepare())) return false;
    if (options?.guard && !options.guard()) return false;
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
      // A failed cross-tree drop must not undo a later notebook/tree selection.
      const selection = options && (state.notebookRoot !== mapPath(oldNotebookRoot, source, destination)
        || state.selectedPath !== mapPath(oldSelectedPath, source, destination)
        || state.selectedFolder !== mapPath(oldSelectedFolder, source, destination))
        ? { root: state.notebookRoot, path: mapPath(state.selectedPath, destination, source), folder: mapPath(state.selectedFolder, destination, source) } : null;
      state.entries = entriesSnapshot; state.tabs = oldTabs; state.activeTab = oldActiveTab; state.selectedPath = oldSelectedPath; state.selectedFolder = oldSelectedFolder;
      state.notebookRoot = oldNotebookRoot; state.notebookExpanded = oldNotebookExpanded; state.expanded = oldExpanded;
      if (selection) { state.notebookRoot = selection.root; state.selectedPath = selection.path; state.selectedFolder = selection.folder; }
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
    updateNoteGraphSession(source, destination);
    noteGraph?.invalidate(notebookRootForPath(source));
    if (notebookRootForPath(source) !== notebookRootForPath(destination)) noteGraph?.invalidate(notebookRootForPath(destination));
    backgroundTargetChanged();
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
  function clearNoteTreeDrag() {
    state.draggedPath = '';
    noteTreeDragRow?.classList.remove('dragging'); noteTreeDragRow = null;
    for (const host of [treeEl, notebookTreeEl]) host?.querySelectorAll('.note-drop-target').forEach(row => row.classList.remove('note-drop-target'));
    treeEl.classList.remove('note-drop-root');
  }
  function notebookDropSource(target) {
    if (!noteWorkspaceVisible() || effectiveSideMode() !== 'notebooks' || !root.classList.contains('links-overlay-open')
        || noteMovePromise || notebookDropRunning || !noteTreeDragRow || !treeEl.contains(noteTreeDragRow)) return '';
    const source = state.draggedPath;
    if (!source || noteTreeDragRow.dataset.notePath !== source || findEntry(source)?.kind !== 'folder'
        || isNotebookRoot(source) || isNotebookContainer(source)) return '';
    return target === '' || isNotebookRoot(target) && findEntry(target)?.kind === 'folder' ? source : '';
  }
  async function moveFolderToNotebook(source, target) {
    if (notebookDropRunning) return;
    const destination = joinPath(target, baseName(source));
    if (source === destination) return;
    const selection = notebookSelectionSequence, visibility = noteVisibilityEpoch, sequence = state.openSeq;
    const documentState = state.current, tab = state.activeTab, selectedPath = state.selectedPath;
    const current = moved => noteWorkspaceVisible() && visibility === noteVisibilityEpoch
      && selection === notebookSelectionSequence && sequence === state.openSeq && state.current === documentState
      && state.activeTab === (moved ? mapPath(tab, source, destination) : tab)
      && state.selectedPath === (moved ? mapPath(selectedPath, source, destination) : selectedPath);
    const validPaths = () => findEntry(source)?.kind === 'folder' && !isNotebookRoot(source) && !isNotebookContainer(source)
      && (target === '' || isNotebookRoot(target) && findEntry(target)?.kind === 'folder');
    notebookDropRunning = true;
    try {
      if (!(await finishNotebookInteraction()) || !current(false) || !validPaths()) return;
      await movePath(source, destination, true, {
        guard: () => current(false) && validPaths(),
        // A just-saved note is indexed after the existing 250ms quiet period.
        // Poll only for this drop; a partial/slow index keeps the API's error.
        async prepare() {
          for (let attempt = 0; attempt < 250; attempt++) {
            if (!current(false) || !validPaths()) return false;
            const index = await request('/api/note-index-state');
            if (index.phase === 'ready' || index.phase === 'partial') return true;
            await new Promise(resolve => setTimeout(resolve, 120));
          }
          return current(false) && validPaths();
        },
        onResult(ok, code, message) {
          if (!current(ok)) return;
          if (!ok) {
            if (message) showToast(code === 'exists'
              ? (language() === 'en' ? 'The target notebook already has a folder with this name' : '目标笔记本有重名文件夹') : message, 'error');
            return;
          }
          selectNotebook(target, { noRender: true });
          state.rootTargeted = false; state.selectedPath = destination; state.selectedFolder = destination;
          expandTreePath(destination, false); renderTree();
          const row = treeEl.__noteWindow?.scrollToKey(destination) || treeRowIndexes.get(treeEl).rows.get(destination);
          row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        },
      });
    } catch (error) { if (current(false)) showToast(error.message || tr('moveFailed'), 'error'); }
    finally { notebookDropRunning = false; }
  }
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
      updateNoteGraphSession(entry.path); noteGraph?.invalidate(notebookRootForPath(entry.path));
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
  function showContext(items, x, y, source) {
    if (!contextMenu || !noteWorkspaceVisible()) return;
    prepareWorkspacePopover('context'); cancelContextMotion();
    if (source !== 'body') { bodyMenuContext = null; closeBodySubmenu({ instant: true }); }
    contextReturnFocus = document.activeElement;
    contextMenu.replaceChildren(...items); contextMenu.dataset.source = source || '';
    blockContextTooltip(!!contextMenu.querySelector('.note-notebook-colors'));
    contextOpen = true; contextMenu.inert = false; contextMenu.hidden = false; contextMenu.removeAttribute('aria-busy');
    contextMenu.classList.remove('is-closing');
    currentMenuButton?.setAttribute('aria-expanded', String(source === 'current-menu'));
    fitBodyMenu(contextMenu, x, y);
    const sequence = contextSequence;
    if (tabMotionPreference.matches) contextMenu.classList.add('is-open');
    else contextFrame = requestAnimationFrame(() => { contextFrame = 0; if (sequence === contextSequence && contextOpen) contextMenu.classList.add('is-open'); });
  }
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
    // Events originating in an embedded canvas do not bubble to this document.
    if (contextOpen) { closeContextMenu(); return; }
    closeContextMenu({ instant: true });
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
  function closeNoteModal() { activeNoteModal?.cancel(false); }
  function promptNoteModal(title, cancelValue, content) {
    if (!modalHost || !noteWorkspaceVisible()) return Promise.resolve(cancelValue);
    closeNoteModal();
    const previousFocus = document.activeElement, previousDocument = state.current, previousTab = state.activeTab;
    return new Promise(resolve => {
      const overlay = document.createElement('div'); overlay.className = 'note-modal-overlay';
      const dialog = document.createElement('section'); dialog.className = 'note-modal-card';
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h2'); heading.id = 'relatum-note-modal-title'; heading.textContent = title;
      dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading);
      let finished = false, frame = 0, initialFocus;
      const valid = () => noteWorkspaceVisible() && state.current === previousDocument && state.activeTab === previousTab;
      const finish = (value, restoreFocus = true) => {
        if (finished) return;
        finished = true; cancelAnimationFrame(frame);
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('focusin', focusin, true);
        if (activeNoteModal === session) activeNoteModal = null;
        overlay.remove();
        const current = valid();
        if (restoreFocus && current && previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
        resolve(current ? value : cancelValue);
      };
      const session = { cancel: restoreFocus => finish(cancelValue, restoreFocus) };
      const focusin = event => {
        if (activeNoteModal === session && noteWorkspaceVisible() && !dialog.contains(event.target)) initialFocus.focus({ preventScroll: true });
      };
      const keydown = event => {
        if (activeNoteModal !== session) return;
        if (!dialog.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); initialFocus.focus({ preventScroll: true }); return; }
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(cancelValue); }
        else if (event.key === 'Tab') {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const fields = Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(node => node.getClientRects().length);
          const index = fields.indexOf(document.activeElement);
          fields[(index + (event.shiftKey ? -1 : 1) + fields.length) % fields.length]?.focus();
        } else if (event.key === 'F2' || (event.ctrlKey || event.metaKey) && !event.altKey
            && (/^[ntws1-9]$/i.test(event.key) || event.shiftKey && event.key.toLowerCase() === 'f')) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      initialFocus = content(dialog, finish);
      overlay.append(dialog); modalHost.replaceChildren(overlay); activeNoteModal = session;
      // Focus immediately: waiting for the entrance frame lets typing reach the note.
      document.addEventListener('keydown', keydown, true);
      document.addEventListener('focusin', focusin, true);
      overlay.addEventListener('keydown', event => event.stopPropagation());
      initialFocus.focus({ preventScroll: true });
      if (initialFocus.tagName === 'INPUT') initialFocus.select();
      frame = requestAnimationFrame(() => { if (activeNoteModal === session) overlay.classList.add('visible'); });
    });
  }
  function canvasNameInput(name) {
    return promptNoteModal(tr('rename'), null, (dialog, finish) => {
      const input = document.createElement('input'); input.className = 'note-tree-rename'; input.value = name.replace(/\.canvas$/i, ''); input.setAttribute('aria-label', tr('rename'));
      const actions = document.createElement('footer'); actions.className = 'note-modal-actions';
      actions.append(contextButton(tr('cancel'), () => finish(null)), contextButton(tr('rename'), () => { if (input.value.trim()) finish(input.value.trim()); }));
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey && input.value.trim()) { event.preventDefault(); finish(input.value.trim()); } });
      dialog.append(input, actions); return input;
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
  function closeBodySubmenu(options = {}) {
    cancelAnimationFrame(submenuFrame); clearTimeout(submenuTimer); submenuFrame = submenuTimer = 0;
    closingSubmenu?.remove(); closingSubmenu = null;
    if (bodyMenuParent) { bodyMenuParent.setAttribute('aria-expanded', 'false'); bodyMenuParent.classList.remove('is-open'); }
    const submenu = bodyMenuSubmenu;
    bodyMenuSubmenu = null; bodyMenuParent = null;
    if (!submenu) return;
    submenu.inert = true; submenu.classList.remove('is-open');
    if (options.instant || !noteWorkspaceVisible() || tabMotionPreference.matches) submenu.remove();
    else {
      closingSubmenu = submenu; submenu.classList.add('is-closing');
      submenuTimer = setTimeout(() => { submenu.remove(); if (closingSubmenu === submenu) closingSubmenu = null; submenuTimer = 0; }, 170);
    }
  }
  async function noteImageClipboardPng(context, signal) {
    const check = () => {
      if (signal.aborted || bodyMenuContext !== context || !noteWorkspaceVisible() || state.viewMode !== 'live'
          || state.current?.path !== context.path || !liveEditor?.queryCommand('copy', context).enabled) {
        throw new DOMException('Image copy cancelled', 'AbortError');
      }
    };
    check();
    const query = new URLSearchParams({ note: context.path, src: context.image.target, syntax: context.image.syntax || 'markdown' });
    const response = await fetch('/api/note-asset?' + query, { signal });
    check();
    if (!response.ok) throw new Error('Image unavailable');
    const blob = await response.blob();
    check();
    // PNG already has the clipboard format: do not decode or re-encode it.
    if (blob.type === 'image/png') return blob;
    if (!/^image\/(?:jpeg|webp|bmp|gif)$/.test(blob.type)) throw new Error('Unsupported image type');
    const image = await createImageBitmap(blob);
    let canvas;
    try {
      check();
      const { width, height } = image;
      if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
        throw new RangeError(tr('imageCopyTooLarge'));
      }
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const drawing = canvas.getContext('2d');
      if (!drawing) throw new Error('Canvas unavailable');
      drawing.drawImage(image, 0, 0);
      const png = await new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob); else reject(new Error('PNG conversion failed'));
      }, 'image/png'));
      check();
      return png;
    } finally {
      image.close();
      if (canvas) canvas.width = canvas.height = 0;
    }
  }
  async function copyBodyImage(context) {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function'
        || typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png')) {
      throw new Error('Image clipboard unavailable');
    }
    const controller = imageCopyController = new AbortController();
    try {
      let preparationError;
      const png = noteImageClipboardPng(context, controller.signal).catch(error => { preparationError = error; throw error; });
      // A host may reject write() without consuming the promised data.
      png.catch(() => {});
      // Start write() in the click handler, before fetching/decoding loses activation.
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); }
      catch (error) { throw preparationError || error; }
    } finally {
      controller.abort();
      if (imageCopyController === controller) imageCopyController = null;
    }
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
        if (name === 'copy' && context.image) await copyBodyImage(context);
        else {
          const text = context.selection.ranges.map((range) => context.doc.sliceString(range.from, range.to)).join('\n');
          await navigator.clipboard.writeText(text);
        }
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
      if (name === 'copy' && context.image) {
        if (bodyMenuContext === context && noteWorkspaceVisible()) showToast(error instanceof RangeError ? error.message : tr('imageCopyFailed'), 'error');
      } else showToast(name === 'insert:canvas' ? error.message : language() === 'en' ? 'Clipboard unavailable. Use the keyboard shortcut.' : '无法访问剪贴板，请使用键盘快捷键。', 'error');
    } finally { if (bodyMenuContext === context) contextMenu.removeAttribute('aria-busy'); }
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
    closeBodySubmenu({ instant: true });
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
    if (tabMotionPreference.matches) submenu.classList.add('is-open');
    else submenuFrame = requestAnimationFrame(() => { submenuFrame = 0; if (bodyMenuSubmenu === submenu && contextOpen) submenu.classList.add('is-open'); });
    if (focusFirst) menuButtons(submenu)[0]?.focus();
  }
  function openBodyContextMenu(payload) {
    if (!state.active || !state.current || state.viewMode === 'reading' || state.imageTextBusy || state.assetCleanupBusy) return;
    if (contextOpen) { closeContextMenu(); return; }
    closeContextMenu({ instant: true }); bodyMenuContext = Object.assign({}, payload.context, { image: payload.image || null });
    const items = ['paragraph', 'insert'].map((kind) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = bodyCommandLabel(kind);
      button.dataset.noteSubmenu = kind; button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.addEventListener('pointerenter', () => openBodySubmenu(button, false));
      button.addEventListener('click', (event) => openBodySubmenu(button, event.detail === 0));
      return button;
    });
    items.push(separator(), ...['cut', 'copy', 'paste', 'paste-plain', 'select-all'].map(bodyCommandButton));
    if (payload.image) items.push(separator(), imageRevealButton(payload.image, payload.context));
    showContext(items, payload.x, payload.y, 'body'); fitBodyMenu(contextMenu, payload.x, payload.y);
    if (payload.keyboard) menuButtons(contextMenu)[0]?.focus({ preventScroll: true });
  }
  function imageRevealButton(image, context) {
    const documentState = state.current, path = documentState.path;
    const readingEpoch = readingHost?.dataset.noteReadingEpoch;
    const button = contextButton(tr('openExplorer'), async () => {
      if (!noteWorkspaceVisible() || state.current !== documentState || state.current.path !== path) return;
      if (context ? state.viewMode === 'reading' || !liveEditor?.queryCommand('select-all', context).enabled
        : state.viewMode !== 'reading' || readingHost?.dataset.noteReadingEpoch !== readingEpoch) return;
      try { await post('/api/note-reveal', { kind: 'image', path, target: image.target, imageSyntax: image.syntax || 'markdown' }); }
      catch (error) { showToast(error.message || tr('revealFailed'), 'error'); }
    });
    button.setAttribute('role', 'menuitem');
    button.addEventListener('pointerenter', () => closeBodySubmenu());
    return button;
  }
  if (contextMenu) {
    contextMenu.addEventListener('transitionend', event => {
      if (!contextOpen && event.target === contextMenu && event.propertyName === 'opacity' && Number(getComputedStyle(contextMenu).opacity) < .001) finishContextClose();
    });
    contextMenu.addEventListener('pointerdown', (event) => { if (bodyMenuContext) event.preventDefault(); });
    contextMenu.addEventListener('pointerover', (event) => {
      if (bodyMenuContext && event.target.closest('[data-note-command]')?.parentElement === contextMenu) closeBodySubmenu();
    });
    contextMenu.addEventListener('keydown', (event) => {
      if (!contextOpen) return;
      const current = document.activeElement, menu = current && current.parentElement;
      const colors = current?.closest('.note-notebook-colors');
      const buttons = menuButtons(menu === bodyMenuSubmenu ? bodyMenuSubmenu : colors || contextMenu);
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
        event.preventDefault(); event.stopPropagation();
        const body = !!bodyMenuContext, returnFocus = contextReturnFocus;
        closeContextMenu();
        if (body) liveEditor.focus(); else if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
    });
  }
  function openContextMenu(entry, x, y, options) {
    closeContextMenu({ instant: true });
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
    closeContextMenu({ instant: true });
    if (!entry.path) return;
    const colors = document.createElement('div'); colors.className = 'note-notebook-colors';
    colors.setAttribute('role', 'group'); colors.setAttribute('aria-label', language() === 'en' ? 'Notebook color' : '笔记本颜色');
    NOTEBOOK_COLORS.forEach((color) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-notebook-icon'; button.dataset.color = color;
      button.setAttribute('aria-label', notebookCopy(color));
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
    showContext([colors, separator(), contextButton(tr('rename'), () => beginInlineRename(entry.path)),
      contextButton(tr('openExplorer'), () => reveal(entry.path, false)), contextButton(tr('recycle'), () => recycleEntry(entry), true)], x, y);
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
  function renderGuide() {
    const visible = guideContent && !guideContent.hidden && root.classList.contains('links-overlay-open') && noteWorkspaceVisible();
    if (!visible) { guideSequence++; guideController?.suspend(); return; }
    if (guideController) { guideController.show(guideTopic); return; }
    const sequence = ++guideSequence;
    if (!guideLoader) guideLoader = new Promise((resolve, reject) => {
      if (window.RelatumNoteGuide) { resolve(); return; }
      const script = document.createElement('script'); script.src = 'note-guide.js';
      const timer = setTimeout(() => finish(new Error(tr('readFailed'))), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error || !window.RelatumNoteGuide) { script.remove(); reject(error || new Error(tr('readFailed'))); } else resolve(); }
      script.onload = () => finish(); script.onerror = () => finish(new Error(tr('readFailed'))); document.head.append(script);
    }).catch(error => { guideLoader = null; throw error; });
    guideLoader.then(() => {
      if (sequence !== guideSequence || !noteWorkspaceVisible() || guideContent.hidden || !root.classList.contains('links-overlay-open')) return;
      guideController ||= window.RelatumNoteGuide.create({ host: guideContent, language, isCurrent: () => noteWorkspaceVisible() && !guideContent.hidden && root.classList.contains('links-overlay-open'), whenSettled: whenEditorInputSettled, notify: showToast });
      guideController.show(guideTopic);
    }).catch(error => { if (sequence === guideSequence && noteWorkspaceVisible()) showToast(error.message, 'error'); });
  }

  function ensureAI() {
    if (!aiEnabled() || !aiContent) return Promise.reject(new Error(tr('readFailed')));
    if (aiController) return Promise.resolve(aiController);
    if (!aiLoader) aiLoader = new Promise((resolve, reject) => {
      const create = () => {
        if (!window.RelatumNoteAI) { reject(new Error(tr('readFailed'))); return; }
        aiController = window.RelatumNoteAI.create({ host: aiContent, settingsHost: aiSettingsHost, language,
          isVisible: aiPresentationVisible,
          onPopoverOpen: () => {
            if (aiDialogChatVisible()) { settingsDialog.finishContentMotion(); prepareWorkspacePopover('settings'); }
            else prepareWorkspacePopover('ai');
          },
          openSettings: trigger => setNoteSettingsOpen(true, { category: 'ai', trigger }), notify: showToast });
        resolve(aiController);
      };
      function load(name, css, ready) {
        if (ready?.() || css && document.querySelector('link[href="' + name + '"]')?.sheet) return Promise.resolve();
        return new Promise((done, failed) => {
          const element = document.createElement(css ? 'link' : 'script');
          if (css) { element.rel = 'stylesheet'; element.href = name; } else element.src = name;
          const finish = error => { clearTimeout(timer); element.onload = element.onerror = null; if (error) { element.remove(); failed(new Error(tr('readFailed'))); } else done(); };
          const timer = setTimeout(() => finish(true), 10000);
          element.onload = () => finish(false); element.onerror = () => finish(true); document.head.append(element);
        });
      }
      Promise.all([load('review-controls.js', false, () => !!window.RelatumReviewControls), load('review-controls.css', true),
        load('note-ai.js', false, () => !!window.RelatumNoteAI), load('note-ai.css', true)]).then(create).catch(reject);
    }).catch(error => { aiLoader = null; throw error; });
    return aiLoader;
  }
  function aiDialogChatVisible() {
    return !!(settingsDialog?.isOpen && aiSettingsCategory === 'ai-chat' && aiChatHost && !aiChatHost.hidden);
  }
  function aiPresentationVisible() {
    return !aiPageHiding && aiEnabled() && noteWorkspaceVisible() && (aiDialogChatVisible()
      || !settingsDialog?.dialog.open && aiContent && !aiContent.hidden && root.classList.contains('links-overlay-open'));
  }
  function renderAI() {
    const sequence = ++aiSequence;
    if (aiDialogReturning && settingsDialog?.dialog.open && !aiPageHiding && noteWorkspaceVisible()) return;
    if (!aiPresentationVisible()) { aiController?.suspend(); return; }
    const inDialog = aiDialogChatVisible();
    const isCurrent = () => sequence === aiSequence && aiPresentationVisible() && aiDialogChatVisible() === inDialog;
    ensureAI().then(ai => {
      if (isCurrent()) return ai.present({ container: inDialog ? aiChatHost : aiContent,
        portal: inDialog ? settingsDialog.dialog : document.body, isCurrent,
        whenSettled: () => inDialog ? settingsDialog.whenContentSettled() : Promise.resolve() });
    })
      .catch(error => { if (sequence === aiSequence && noteWorkspaceVisible()) showToast(error.message, 'error'); });
  }
  function updateSidePanel() {
    const pages = sidePages();
    if (!graphPresentation && !pages.includes(state.sideMode)) state.sideMode = pages[0] || 'notebooks';
    if (!pages.length || graphPresentation && !pages.includes('notebooks')) root.classList.remove('links-overlay-open');
    const open = root.classList.contains('links-overlay-open');
    const selectedMode = effectiveSideMode();
    if (sidePane) { sidePane.inert = !open; sidePane.setAttribute('aria-label', language() === 'en' ? 'Note sidebar' : '笔记侧栏'); }
    $('.note-side-modes')?.setAttribute('aria-label', language() === 'en' ? 'Sidebar view' : '侧栏视图');
    if (sideTitle) sideTitle.textContent = notebookCopy(selectedMode);
    if (notebooksContent) notebooksContent.hidden = selectedMode !== 'notebooks';
    if (linksContent) linksContent.hidden = selectedMode !== 'links';
    if (canvasSettingsContent) canvasSettingsContent.hidden = selectedMode !== 'canvas';
    if (guideContent) { guideContent.hidden = selectedMode !== 'guide'; renderGuide(); }
    if (aiContent) { aiContent.hidden = selectedMode !== 'ai'; renderAI(); }
    if (outlineContent) { outlineContent.hidden = selectedMode !== 'outline'; outlineContent.setAttribute('aria-label', notebookCopy('outline')); }
    ['notebooks', 'links', 'canvas', 'guide', 'outline', 'ai'].forEach((mode) => {
      const button = $('[data-note-action="side-' + mode + '"]');
      if (button) { button.textContent = notebookCopy(mode); button.setAttribute('aria-pressed', String(selectedMode === mode)); button.hidden = graphPresentation && mode !== 'notebooks' || !pages.includes(mode); }
    });
    const nav = $('.note-side-modes');
    const ordered = sidePreferences?.available() || pages;
    ordered.forEach((mode, index) => {
      const button = $('[data-note-action="side-' + mode + '"]');
      if (button && nav.children[index] !== button) nav.insertBefore(button, nav.children[index] || null);
    });
    if (open) {
      const button = $('[data-note-action="side-' + selectedMode + '"]');
      if (button) {
        const nav = button.parentElement, parent = nav.getBoundingClientRect(), rect = button.getBoundingClientRect();
        if (rect.left < parent.left) nav.scrollLeft += rect.left - parent.left;
        else if (rect.right > parent.right) nav.scrollLeft += rect.right - parent.right;
      }
    }
    const toggle = $('[data-note-action="toggle-notebooks"]');
    if (toggle) { toggle.hidden = !pages.length || graphPresentation && !pages.includes('notebooks'); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', notebookCopy(open ? 'collapseSideLabel' : 'expandSideLabel')); toggle.title = notebookCopy(open ? 'collapseSide' : 'expandSide'); }
    const graphNotebooks = $('[data-note-action="graph-notebooks"]'); if (graphNotebooks) graphNotebooks.hidden = !pages.includes('notebooks');
    $('[data-note-action="graph-notebooks"]')?.setAttribute('aria-expanded', String(open));
    $('[data-role="note-side-toolbar"]')?.setAttribute('aria-label', language() === 'en' ? 'Note tools' : '笔记工具');
    ['new-notebook', 'toggle-all-notebooks'].forEach((action) => {
      const button = $('[data-note-action="' + action + '"]'); if (button) button.hidden = selectedMode !== 'notebooks';
    });
    const add = $('[data-note-action="new-notebook"]');
    if (add) { add.title = notebookCopy('create'); add.setAttribute('aria-label', add.title); }
    $('[data-note-action="close-links"]')?.setAttribute('aria-label', notebookCopy('close'));
    if (selectedMode === 'notebooks') renderNotebookTree();
    syncOutline();
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
    setStyle('maxHeight', Math.min(780, available) + 'px');
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
      positionSidePopover(imageTextTools, imageTextToggle);
      if (performance.now() < sideMotionUntil && !imageTextTools?.hidden) scheduleSidePopoverPosition();
    });
  }
  window.addEventListener('resize', () => { sideMotionUntil = performance.now() + 270; scheduleSidePopoverPosition(); });
  if (window.ResizeObserver) {
    const sidePopoverObserver = new ResizeObserver(scheduleSidePopoverPosition);
    [root, imageTextTools].filter(Boolean).forEach((element) => sidePopoverObserver.observe(element));
  }
  function clearClosedNotebookTree() {
    if (root.classList.contains('links-overlay-open') || !notebookTreeEl) return;
    clearTreeRowIndex(notebookTreeEl); notebookTreeEl.replaceChildren(); state.notebookTreeDirty = true;
  }
  function cancelSideClose() {
    sideMotionSequence++;
    if (!sideCloseTask) return;
    clearTimeout(sideCloseTask.timer);
    root.removeEventListener('transitionend', sideCloseTask.onEnd);
    sidePane?.removeEventListener('transitionend', sideCloseTask.onEnd);
    sideCloseTask = null;
  }
  function scheduleSideClose() {
    if (root.classList.contains('links-overlay-open') || !notebookTreeEl) return;
    const sequence = sideMotionSequence;
    const finish = () => {
      if (sideCloseTask !== task || sequence !== sideMotionSequence) return;
      cancelSideClose(); clearClosedNotebookTree();
    };
    const task = sideCloseTask = { timer: 0, onEnd(event) {
      if (event.target !== root && event.target !== sidePane) return;
      if (!['transform', 'visibility', 'grid-template-columns'].includes(event.propertyName)) return;
      // A queued end event from a reversed transition cannot clear visible content.
      if (!sidePane || getComputedStyle(sidePane).visibility === 'hidden') finish();
    } };
    if (!sidePane || root.hidden || document.hidden || tabMotionPreference.matches
        || getComputedStyle(sidePane).visibility === 'hidden') { finish(); return; }
    root.addEventListener('transitionend', task.onEnd);
    sidePane.addEventListener('transitionend', task.onEnd);
    task.timer = window.setTimeout(finish, 270);
  }
  function scrollTabAfterSideOpen(changed) {
    if (!window.matchMedia('(min-width: 1121px)').matches) return;
    const sequence = sideMotionSequence;
    const motions = (tabBar?.getAnimations?.() || []).filter(animation => animation.transitionProperty === 'padding-right');
    if (!changed && !motions.length) return;
    Promise.allSettled(motions.map(animation => animation.finished)).then(() => {
      if (sequence !== sideMotionSequence || !noteWorkspaceVisible() || state.draggedTabPath
          || !root.classList.contains('links-overlay-open')) return;
      const active = tabsEl?.querySelector('.note-tab.active');
      if (active) requestTabScroll(active, state.activeTab);
    });
  }
  function setSideOpen(open) {
    if (!sidePages().length || graphPresentation && !sidePages().includes('notebooks')) open = false;
    const changed = !!open !== root.classList.contains('links-overlay-open');
    if (changed) { cancelTabCloseMotion(); cancelTabScroll(); }
    cancelSideClose();
    cancelLinksRefresh();
    sideMotionUntil = performance.now() + 270;
    if (!open) {
      const focusWasInside = sidePane?.contains(document.activeElement) || settingsDialog?.dialog.contains(document.activeElement) || imageTextTools?.contains(document.activeElement);
      setNoteSettingsOpen(false, { restoreFocus: false, instant: true });
      state.imageText.toggleSeq += 1; state.imageText.toggleIntent = null; state.imageTextCleanupPath = '';
      state.imageText.active = false;
      if (liveEditor) liveEditor.setImageTextMode(false);
      if (imageTextTools) { imageTextTools.hidden = true; imageTextTools.inert = true; }
      if (sidePopoverFrame) cancelAnimationFrame(sidePopoverFrame); sidePopoverFrame = 0;
      if (focusWasInside) $(graphPresentation ? '[data-note-action="graph-notebooks"]' : '[data-note-action="toggle-notebooks"]')?.focus({ preventScroll: true });
    }
    root.classList.toggle('links-overlay-open', open); updateSidePanel();
    if (!graphPresentation) queueNotebookSettings({ ui: notebookUi() });
    updateImageTextTools();
    if (open) { if (effectiveSideMode() === 'links') ensureLinks(); scheduleSidePopoverPosition(); }
    if (!open) scheduleSideClose();
    if (open) scrollTabAfterSideOpen(changed);
  }
  function setSideMode(mode) {
    if (graphPresentation) { if (mode === 'notebooks') setSideOpen(true); return; }
    state.sideMode = sidePages().includes(mode) ? mode : sidePages()[0] || 'notebooks';
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
        noteOpenAttempt || state.openingPath || noteMovePromise || root.classList.contains('note-document-switch-pending') ||
        modalHost?.childElementCount || (contextMenu && !contextMenu.hidden) || (imageTextTools && !imageTextTools.hidden)) return false;
    const focused = document.activeElement;
    // A retained Markdown selection is not an input caret once the editor loses focus.
    if (liveEditor?.view?.hasFocus) return false;
    const inputs = 'input, textarea, select, [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"]';
    return [event.target, focused].every((element) => {
      if (!(element instanceof Element)) return false;
      return !element.isContentEditable && !element.closest(inputs + ', [inert], [role="menu"], [role^="menuitem"], [role="dialog"], [role="alertdialog"]');
    });
  }
  function fileToBase64(file) {
    if (/\.svg$/i.test(file.name || '') && file.size > 4 * 1024 * 1024) return Promise.reject(new Error(tr('svgUploadTooLarge')));
    if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error(tr('imageUploadTooLarge')));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '');
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.onabort = () => reject(new DOMException('File read cancelled', 'AbortError'));
      reader.readAsDataURL(file);
    });
  }
  async function uploadImageFile(path, file, data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      return await post('/api/note-upload-image', { path, name: file.name || 'image.png', mediaType: file.type || '', data }, { signal: controller.signal });
    } finally { clearTimeout(timeout); }
  }
  let imageUploadChain = Promise.resolve();
  async function uploadImages(files, commandContext) {
    if (!state.current || !files.length || !noteWorkspaceVisible() || state.viewMode === 'reading') return;
    const documentState = state.current, path = documentState.path, sequence = state.openSeq;
    const visibility = noteVisibilityEpoch, mode = state.viewMode;
    const current = () => state.current === documentState && state.openSeq === sequence && state.viewMode === mode
      && visibility === noteVisibilityEpoch && noteWorkspaceVisible()
      && (!commandContext || bodyMenuContext === commandContext && liveEditor?.queryCommand('paste', commandContext).enabled);
    if (editorInputPending()) await whenEditorInputSettled();
    if (!current()) return;
    const insertion = !commandContext && liveEditor ? liveEditor.createImageInsertion() : null;
    if (!commandContext && liveEditor && !insertion) return;
    const fallback = !liveEditor ? { value: fallbackEditor.value, from: fallbackEditor.selectionStart, to: fallbackEditor.selectionEnd } : null;
    const valid = () => current() && (!insertion || insertion.valid()) && (!fallback || fallbackEditor.value === fallback.value);
    const operation = imageUploadChain.catch(() => {}).then(async () => {
      const insertions = [];
      try {
        for (const file of files) {
          if (!valid()) return;
          try {
            const data = await fileToBase64(file);
            if (!valid()) return;
            const result = await uploadImageFile(path, file, data);
            if (!valid()) return;
            const alt = String(result.name || file.name || 'image').replace(/[\\\[\]]/g, '\\$&');
            const target = String(result.path).replace(/[()\s<>]/g, character => character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character));
            insertions.push('![' + alt + '](' + target + ')\n');
          } catch (error) { if (valid()) showToast(error.message || tr('uploadFailed'), 'error'); }
        }
        if (!insertions.length || !valid()) return;
        if (editorInputPending()) await whenEditorInputSettled();
        if (!valid()) return;
        const text = insertions.join('');
        if (commandContext) liveEditor.executeCommand('paste', commandContext, text);
        else if (insertion) insertion.insert(text);
        else { fallbackEditor.setSelectionRange(fallback.from, fallback.to); replaceEditorSelection(text); }
      } catch (error) {
        if (current()) showToast(error.message || tr('uploadFailed'), 'error');
      } finally { insertion?.dispose(); }
    });
    imageUploadChain = operation;
    return operation;
  }
  function entryFiles(entry, prefix) { return new Promise((resolve) => { if (entry.isFile) { entry.file((file) => resolve([{ path: prefix + file.name, file }]), () => resolve([])); return; } if (!entry.isDirectory) { resolve([]); return; } const reader = entry.createReader(); const children = []; const read = () => reader.readEntries(async (batch) => { if (!batch.length) { resolve((await Promise.all(children.map((child) => entryFiles(child, prefix + entry.name + '/')))).flat()); return; } children.push(...batch); read(); }, () => resolve([])); read(); }); }
  async function filesFromTransfer(transfer) { const items = Array.from(transfer && transfer.items || []); const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean); if (entries.length) return (await Promise.all(entries.map((entry) => entryFiles(entry, '')))).flat(); return Array.from(transfer && transfer.files || []).map((file) => ({ path: file.name, file })); }
  async function importDataTransfer(transfer, destination) {
    return withNoteBusy(() => importDataTransferNow(transfer, destination));
  }
  async function importDataTransferNow(transfer, destination) { if (destination === null || state.importRunning) return; state.importRunning = true; let token = ''; try { const all = await filesFromTransfer(transfer); const accepted = all.filter((item) => /\.md$/i.test(item.path) || IMAGE_RE.test(item.path)); const skipped = all.length - accepted.length; if (!accepted.length) return; token = (await post('/api/note-import-begin', { destination: destination || '' })).token; for (const item of accepted) await post('/api/note-import-upload', { token, path: item.path.replace(/\\/g, '/'), mediaType: item.file.type || '', data: await fileToBase64(item.file) }); const result = await post('/api/note-import-commit', { token }); token = ''; state.entries = result.tree && result.tree.entries || state.entries; renderTree(); if (result.notes && result.notes.length) { showToast(tr('imported', { count: result.notes.length })); await openNote(result.notes[0]); } if (skipped) setTimeout(() => showToast(tr('unsupportedSkipped', { count: skipped }), 'warning'), 350); } catch (error) { showToast(error.message || tr('importFailed'), 'error'); } finally { if (token) post('/api/note-import-abort', { token }).catch(() => {}); state.importRunning = false; } }

  async function checkExternalChanges(announce, options) {
    if (!noteWorkspaceVisible() || state.imageTextBusy || noteMovePromise) return false;
    if (state.recycleRunning) return true;
    const settings = options || {};
    const seq = ++state.externalSeq;
    const current = () => seq === state.externalSeq && noteWorkspaceVisible();
    const path = state.current && state.current.path;
    const generation = state.editGeneration;
    const revision = state.current && state.current.revision;
    const previousModifiedNs = state.current && state.current.treeModifiedNs || 0;
    const previousSize = state.current && state.current.treeSize || 0;
    const refreshed = await refreshTree(announce, { silentErrors: !!settings.silentErrors, background: !!settings.background, externalSeq: seq });
    if (!refreshed || !current()) return false;
    await noteBrowser?.checkExternalCanvases();
    if (!current()) return false;
    await noteGraph?.checkExternalChanges();
    if (!current() || state.imageTextBusy || !path || !state.current || state.current.path !== path || state.editGeneration !== generation) return true;
    const entry = findEntry(path);
    if (!entry) return true;
    const metadataChanged = previousModifiedNs !== entry.modifiedNs || previousSize !== entry.size || entry.revision && entry.revision !== revision;
    if (settings.metadataOnly && !metadataChanged) return true;
    if (state.saveRunning || hasPendingEdits() || window.RelatumNoteCanvas?.dirty) return true;
    try {
      const disk = await request('/api/note?path=' + encodeURIComponent(path));
      if (!current() || state.imageTextBusy || !state.current || state.current.path !== path || state.editGeneration !== generation || state.current.revision !== revision || hasPendingEdits()) return true;
      if (disk.revision !== revision) applyDocument(disk, { preserveViewState: true });
      else {
        state.current.treeModifiedNs = entry.modifiedNs || 0;
        state.current.treeSize = entry.size || 0;
        cacheDocument(state.current);
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      if (isMissingError(error)) {
        await refreshTree(false, { silentErrors: true, externalSeq: seq });
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
    if (noteWorkspaceVisible() && (slowed || !state.externalSyncTimer)) scheduleExternalSync();
  }
  function scheduleExternalSync(delay) {
    stopExternalSync();
    if (!noteWorkspaceVisible() || state.imageTextBusy || noteMovePromise) return;
    if (state.assetCleanupBusy) return;
    state.externalSyncTimer = setTimeout(() => {
      state.externalSyncTimer = 0;
      triggerExternalSync({ background: true, metadataOnly: true, silentErrors: true });
    }, Number.isFinite(delay) ? delay : externalSyncDelay());
  }
  function triggerExternalSync(options) {
    const settings = options || {};
    const visibilityEpoch = noteVisibilityEpoch;
    stopExternalSync();
    let ran = false;
    const task = state.externalSyncChain.catch(() => false).then(async () => {
      if (visibilityEpoch !== noteVisibilityEpoch || !noteWorkspaceVisible() || state.imageTextBusy || state.assetCleanupBusy || noteMovePromise) return false;
      ran = true;
      return checkExternalChanges(!!settings.announce, settings);
    });
    state.externalSyncChain = task;
    task.then((ok) => {
      if (!ran || visibilityEpoch !== noteVisibilityEpoch) return;
      state.externalSyncFailures = ok ? 0 : Math.min(EXTERNAL_SYNC_DELAYS.length, state.externalSyncFailures + 1);
    }, () => {
      if (ran && visibilityEpoch === noteVisibilityEpoch) state.externalSyncFailures = Math.min(EXTERNAL_SYNC_DELAYS.length, state.externalSyncFailures + 1);
    }).finally(() => {
      if (state.externalSyncChain === task && visibilityEpoch === noteVisibilityEpoch) scheduleExternalSync();
    });
    return task;
  }
  function initializeWorkspace() {
    if (state.initialized) return Promise.resolve(true);
    if (state.initializePromise) return state.initializePromise;
    window.RelatumStartupMark?.('notes-initialize-start');
    const initialize = withNoteBusy(async () => {
      if (!(await refreshTree(false))) return false;
      window.RelatumStartupMark?.('notes-tree-ready');
      state.initialized = true;
      let path = ''; try { path = localStorage.getItem(ACTIVE_PATH_KEY) || ''; } catch (error) {}
      let activeTab = state.tabs.includes(state.activeTab) ? state.activeTab : '';
      if (!activeTab && path && findEntry(path) && state.tabs.includes(path)) activeTab = path;
      if (!activeTab) activeTab = state.tabs.find((tabPath) => isSpecialTab(tabPath) || !!findEntry(tabPath)) || '';
      if (activeTab && isSpecialTab(activeTab)) { state.activeTab = activeTab; persistTabs(); renderTabs(); updateEditorVisibility(); }
      else if (activeTab) {
        state.restoringNotebookSelection = true;
        try { await openNote(activeTab, { reuseActiveTab: false, skipSave: true, noFocus: true, noRecent: true }); }
        finally { state.restoringNotebookSelection = false; }
      }
      else { renderTabs(); updateEditorVisibility(); }
      if (state.active && localStorage.getItem('canvas:noteSidebarView:v1') === 'browse') await setBrowserMode(true);
      updateBrowserToggle();
      updateBrowserControls();
      return true;
    });
    state.initializePromise = initialize.finally(() => { state.initializePromise = null; });
    return state.initializePromise;
  }
  async function preload() { return initializeWorkspace(); }
  async function preloadGraph(settings = {}) {
    if (!graphEnabled() || settings.signal?.aborted) return false;
    if (settings.waitForIdle) await settings.waitForIdle(settings.signal);
    if (!(await initializeWorkspace()) || settings.signal?.aborted) return false;
    const scope = state.notebookRoot, sequence = noteGraphIntentSequence;
    const graph = await loadNoteGraph(settings);
    if (!graph || settings.signal?.aborted || sequence !== noteGraphIntentSequence || scope !== state.notebookRoot) return false;
    return graph.preload(scope, settings);
  }
  async function activate() {
    state.linksRefreshSuspended = false;
    const wasInitialized = state.initialized;
    state.active = true;
    indexActivity(noteWorkspaceVisible());
    if (noteBrowser && noteWorkspaceVisible()) noteBrowser.resume();
    state.externalSyncUnchanged = 0;
    if (state.current && state.viewMode === 'reading' && !readingHost.firstChild) renderReadingDocument();
    if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(true);
    root.classList.add('active');
    const initialized = await initializeWorkspace();
    revealColdBoot();
    syncOutline();
    renderGuide();
    if (!initialized) return false;
    await resumeNoteGraph();
    if (browserDisclosure.hidden && localStorage.getItem('canvas:noteSidebarView:v1') === 'browse') await setBrowserMode(true);
    window.RelatumStartupMark?.('notes-ready');
    if (wasInitialized) await triggerExternalSync({ silentErrors: true });
    else scheduleExternalSync();
    if (state.current) {
      resumeLinksRefresh();
      scheduleStatistics(state.current); scheduleDocumentPrefetch();
      if (state.viewMode === 'reading' && !readingHost.firstChild) renderReadingDocument();
      requestAnimationFrame(() => {
        if (noteWorkspaceVisible() && state.current && !graphPresentation) focusEditor();
      });
    }
    return true;
  }
  async function deactivate() {
    clearNoteTreeDrag();
    cancelTabCloseMotion(); cancelTabScroll();
    state.linksRefreshSuspended = true; cancelLinksRefresh(); stopExternalSync();
    if (!(await flushSave())) { state.linksRefreshSuspended = false; resumeLinksRefresh(); scheduleExternalSync(); return false; }
    noteGraphIntentSequence++; noteGraph?.deactivate();
    await flushNotebookSettings(); browserSequence++; browserIntent = root.classList.contains('note-browser-mode'); updateBrowserToggle();
    stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); persistViewStates();
    setNoteSettingsOpen(false, { restoreFocus: false, instant: true }); setLibraryPanel('', { restoreFocus: false });
    if (noteBrowser) noteBrowser.suspend({ keepView: true });
    closeNoteModal(); wikiOpenTask = null;
    state.active = false;
    renderGuide();
    renderAI();
    indexActivity(false);
    cancelSideClose();
    if (!sidePane || root.hidden || getComputedStyle(sidePane).visibility === 'hidden') clearClosedNotebookTree();
    syncOutline();
    if (window.CanvasDesktop && typeof window.CanvasDesktop.setNoteWorkspaceActive === 'function') window.CanvasDesktop.setNoteWorkspaceActive(false);
    root.classList.remove('tree-overlay-open'); closeContextMenu(); desktopDirty(false); return true;
  }
  // Retain the outgoing page until the workspace's slide finishes, then release
  // the reading DOM. Rapidly switching back must not clear the newly active page.
  new MutationObserver(() => {
    syncOutline();
    renderGuide();
    renderAI();
    indexActivity(noteWorkspaceVisible());
    if (!root.hidden && state.active && noteWorkspaceVisible()) {
      resumeLinksRefresh(); scheduleStatistics(state.current); scheduleDocumentPrefetch();
    }
    if (root.hidden) { closeNoteModal(); wikiOpenTask = null; noteGraphIntentSequence++; noteGraph?.deactivate(); cancelSideClose(); clearClosedNotebookTree(); }
    else if (state.active && graphPresentation) resumeNoteGraph();
    if (root.hidden && !state.active && window.RelatumNoteLiveEditor) window.RelatumNoteLiveEditor.releaseReadingDocument(readingHost);
  }).observe(root, { attributes: true, attributeFilter: ['hidden'] });

  async function handleWorkspaceClick(event) {
    if (event.target.closest('[data-note-action="toggle-graph"]')) { toggleNoteGraph(); return; }
    if (event.target.closest('[data-note-action="retry-graph"]')) { resumeNoteGraph(); return; }
    if (event.target.closest('[data-note-action="graph-notebooks"]')) { setSideOpen(!root.classList.contains('links-overlay-open')); return; }
    if (event.target.closest('[data-note-action="toggle-browser"]')) { setBrowserMode(!browserIntent); return; }
    if (state.imageTextBusy) return;
    // Capture settings identity before the common command path waits for IME.
    const settingsAction = event.target.closest('[data-note-action]');
    const settingsName = settingsAction?.dataset.noteAction;
    if (['toggle-settings', 'toggle-library-settings', 'canvas-default-settings', 'guide-settings'].includes(settingsName)) {
      if (settingsAction.disabled || !noteActionAvailable(settingsName)) return;
      const category = { 'toggle-library-settings': 'files', 'canvas-default-settings': 'canvas', 'guide-settings': 'guide' }[settingsName];
      setNoteSettingsOpen(settingsName === 'toggle-settings' ? !state.settingsOpen : true, { category, trigger: settingsAction });
      return;
    }
    const sortChoice = event.target.closest('[data-note-sort-mode]');
    if (sortChoice && (root.contains(sortChoice) || settingsPop.contains(sortChoice))) {
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
    else if (name === 'toggle-all-folders') toggleAllFolders();
    else if (name === 'toggle-all-notebooks') toggleAllNotebooks();
    else if (name === 'new-notebook') createNotebook();
    else if (name === 'reveal-root' && state.notebookRoot !== null) reveal(state.notebookRoot, false);
    else if (name === 'toggle-focus') setFocusMode(!state.focusMode);
    else if (name === 'toggle-source' && state.current) await setViewMode(state.viewMode === 'source' ? 'live' : 'source');
    else if (name === 'current-menu' && state.current) {
      if (contextOpen && contextMenu.dataset.source === 'current-menu') {
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
    else if (name === 'side-outline') setSideMode('outline');
    else if (name === 'side-ai') setSideMode('ai');
    else if (name === 'close-links') setSideOpen(false);
  }
  root.addEventListener('click', handleWorkspaceClick);

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
  selectionMatchHighlightToggle?.addEventListener('change', () => applySelectionMatchHighlight(selectionMatchHighlightToggle.checked, true));
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
    tabsEl.addEventListener('scroll', handleTabCloseScroll, { passive: true });
    tabsEl.addEventListener('click', async (event) => {
      const close = event.target.closest('[data-note-tab-close]');
      if (close) { event.preventDefault(); event.stopPropagation(); if (await finishInlineTitle()) closeTab(close.dataset.noteTabClose); return; }
      const tab = event.target.closest('[data-note-tab-path]');
      if (tab && await finishInlineTitle()) activateTab(tab.dataset.noteTabPath);
    });
    tabsEl.addEventListener('dragstart', (event) => {
      const tab = event.target.closest('[data-note-tab-path]'); if (!tab) return;
      cancelTabCloseMotion(); cancelTabScroll();
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
    return state.active && effectiveSideMode() === 'notebooks';
  }
  notebooksContent?.addEventListener('click', async (event) => {
    if (event.target.closest('.note-tree-row, .note-tree-inline-error')) return;
    const sequence = ++notebookSelectionSequence;
    if (!(await finishNotebookInteraction()) || sequence !== notebookSelectionSequence) return;
    closeContextMenu(); selectNotebook(null, { rootTarget: true });
    state.selectedPath = ''; treeEl.classList.remove('note-drop-root'); updateTreeSelection();
  });
  notebooksContent?.addEventListener('contextmenu', async (event) => {
    if (event.target.closest('.note-tree-row, .note-tree-inline-error')) return;
    event.preventDefault(); event.stopPropagation();
    const sequence = ++notebookSelectionSequence;
    const menuSequence = ++contextSequence;
    if (!(await finishNotebookInteraction()) || sequence !== notebookSelectionSequence || menuSequence !== contextSequence || !noteWorkspaceVisible()) return;
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
    const menuSequence = ++contextSequence;
    if (!(await finishInlineTitle())) return;
    if (state.renamePath && !(await finishInlineRename())) return;
    if (menuSequence !== contextSequence || !noteWorkspaceVisible()) return;
    selectTreeRoot();
    if (state.notebookRoot === null) return;
    openContextMenu(null, event.clientX, event.clientY);
  });
  treeEl.addEventListener('dragover', (event) => { if (event.target.closest('.note-tree-row')) return; if (state.notebookRoot === null) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; return; } const external = Array.from(event.dataTransfer && event.dataTransfer.items || []).some((item) => item.kind === 'file'); if (!state.draggedPath && !external) return; event.preventDefault(); event.dataTransfer.dropEffect = state.draggedPath ? 'move' : 'copy'; treeEl.classList.add('note-drop-root'); });
  treeEl.addEventListener('dragleave', (event) => { if (!treeEl.contains(event.relatedTarget)) treeEl.classList.remove('note-drop-root'); });
  treeEl.addEventListener('drop', (event) => { if (event.target.closest('.note-tree-row')) return; event.preventDefault(); treeEl.classList.remove('note-drop-root'); if (state.notebookRoot === null) return; if (state.draggedPath) moveEntry(state.draggedPath, state.notebookRoot); else importDataTransfer(event.dataTransfer, state.notebookRoot); });
  document.addEventListener('pointerdown', (event) => {
    if (contextOpen && event.button !== 2 && !contextMenu.contains(event.target) && !event.target.closest('[data-note-action="current-menu"]')) closeContextMenu();
    if (state.libraryPanel && !event.target.closest('.note-library-popover') && !event.target.closest('[data-note-action="toggle-sort"]') && !event.target.closest('[data-note-action="toggle-library-settings"]')) {
      setLibraryPanel('', { restoreFocus: false });
    }
  });
  document.addEventListener('contextmenu', (event) => {
    if (!contextOpen || !state.active || (!root.contains(event.target) && !contextMenu.contains(event.target))) return;
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
      setLibraryPanel('');
      return;
    }
    if (state.settingsOpen) return;
    if ((state.imageText.active || state.imageTextCleanupPath) && event.key === 'Escape') {
      event.preventDefault();
      state.imageTextCleanupPath = '';
      liveEditor.setImageTextMode(false);
      updateImageTextTools();
      return;
    }
    const mod = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase();
    if (mod && event.shiftKey && key === 'f' && !event.altKey && !event.repeat) {
      event.preventDefault(); (async () => { await setBrowserMode(true); (await loadNoteBrowser()).search(); })();
    }
    else if (mod && key === 'n') { event.preventDefault(); if (noteActionAvailable('new-note')) createEntry('note'); }
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
  window.addEventListener('blur', () => { clearNoteTreeDrag(); closeContextMenu({ instant: true }); setLibraryPanel('', { restoreFocus: false, instant: true }); stopShortcutRecording(true); noteBrowser?.closePopovers({ instant: true }); flushWorkspaceState(); });
  window.addEventListener('relatum:note-canvas-dirty', () => desktopDirty(hasPendingEdits()));
  window.addEventListener('relatum:note-canvas-error', event => { showSaveError(event.detail); desktopDirty(true); });
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('resize', cancelTabCloseMotion);
  document.addEventListener('relatum:note-focuschange', cancelTabCloseMotion);
  tabMotionPreference.addEventListener?.('change', () => {
    if (!tabMotionPreference.matches) return;
    cancelTabCloseMotion();
    treeEl.__noteFinishMotion?.(); notebookTreeEl?.__noteFinishMotion?.();
    cancelSideClose(); clearClosedNotebookTree();
    sideMotionUntil = 0;
    clearTimeout(state.focusMotionTimer); state.focusMotionTimer = 0;
    document.body.classList.remove('note-focus-transitioning', 'note-focus-restoring');
    noteBrowser?.closePopovers({ instant: true });
    closeContextMenu({ instant: true });
  });
  window.addEventListener('relatum:note-system', event => {
    const { previous, value, clear } = event.detail;
    if (clear || !value.prefetch) stopDocumentPrefetch();
    else if (!previous.prefetch) scheduleDocumentPrefetch();
    if (clear || previous.cache !== value.cache) trimDocumentCache(clear);
  });
  document.addEventListener('relatum:languagechange', closeContextMenu);
  window.addEventListener('focus', () => { if (noteWorkspaceVisible()) { state.externalSyncUnchanged = 0; scheduleStatistics(state.current); scheduleDocumentPrefetch(); triggerExternalSync({ silentErrors: true }); } });
  function syncNotePageVisibility() {
    const visible = notePageVisible();
    if (visible === notePageWasVisible) return;
    notePageWasVisible = visible;
    if (!visible) { aiSequence++; aiController?.suspend(); sidePreferences?.suspend(); } else renderAI();
    indexActivity(visible && state.active);
    if (!visible) {
      clearNoteTreeDrag();
      // Native WebView2 minimization need not change document.hidden or focus.
      // Invalidate reads, but let the existing save/IME handoff finish normally.
      noteVisibilityEpoch++; state.externalSeq++; state.linksSeq++; browserSequence++;
      noteGraphIntentSequence++; noteGraph?.deactivate();
      cancelSideClose(); clearClosedNotebookTree(); cancelLinksRefresh();
      noteBrowser?.suspend({ keepView: true }); closeWorkspacePopovers();
      renderGuide();
      cancelAnimationFrame(sidePopoverFrame); sidePopoverFrame = 0;
      stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); syncOutline();
      flushWorkspaceState();
    } else if (noteWorkspaceVisible()) {
      renderGuide();
      syncOutline(); resumeNoteGraph(); noteBrowser?.resume();
      if (browserIntent && browserDisclosure.hidden) setBrowserMode(true);
      state.externalSyncUnchanged = 0; resumeLinksRefresh();
      scheduleStatistics(state.current); scheduleDocumentPrefetch();
      triggerExternalSync({ silentErrors: true });
    }
  }
  document.addEventListener('visibilitychange', syncNotePageVisibility);
  window.addEventListener('pagehide', () => { clearNoteTreeDrag(); aiPageHiding = true; closeNoteModal(); guideSequence++; guideController?.suspend(); aiSequence++; aiController?.suspend(true); indexActivity(false, true); });
  window.addEventListener('canvasdesktop:visibility', syncNotePageVisibility);
  window.addEventListener('pagehide', () => { notePageWasVisible = false; noteVisibilityEpoch++; state.externalSeq++; state.linksSeq++; browserSequence++; noteGraphIntentSequence++; noteGraph?.deactivate({ clearCache: true }); cancelSideClose(); clearClosedNotebookTree(); noteOutline?.suspend(); outlineLoadSequence++; state.linksRefreshSuspended = true; cancelLinksRefresh(); if (noteBrowser) noteBrowser.suspend({ keepView: true }); closeWorkspacePopovers(); cancelAnimationFrame(sidePopoverFrame); sidePopoverFrame = 0; stopExternalSync(); stopDocumentPrefetch(); cancelStatistics(); flushWorkspaceState(true); });
  window.addEventListener('pageshow', () => { aiPageHiding = false; state.linksRefreshSuspended = false; syncNotePageVisibility(); });
  window.addEventListener('beforeunload', () => { cancelTabCloseMotion(); cancelTabScroll(); cancelLinksRefresh(); stopExternalSync(); flushWorkspaceState(true); });
  document.addEventListener('relatum:languagechange', () => { updateSidePanel(); updateBrowserToggle(); noteGraph?.setLanguage(); if (noteBrowser) noteBrowser.setLanguage(); renderTree(); renderTabs(); renderLinks(); renderLibraryPreferences(); renderCurrentPath(state.openingPath || (state.current && state.current.path) || ''); updateFocusToggle(); updateViewToggle(); updateImageTextTools(); if (state.settingsOpen) renderNoteShortcutSettings(); if (state.current) { rememberEditorState(state.current); updateDocumentStats(null, state.current.characterCount, state.current.wordCount); } });
  if (window.CanvasDesktop && typeof window.CanvasDesktop.setBeforeCloseHandler === 'function') window.CanvasDesktop.setBeforeCloseHandler(flushWorkspaceState);
  initializeSettingsDialog();
  initializeEditor(); renderTabs(); updateEditorVisibility(); renderLinks(); renderLibraryPreferences(); updateSidePanel(); updateFocusToggle(); updateImageTextTools(); syncNoteSettingsFontScale(); renderNoteShortcutSettings();
  updateBrowserControls();
  window.CanvasNoteWorkspace = { activate, deactivate, preload, preloadGraph, flushSave, toggleCanvasPanel,
    refresh: (announce) => triggerExternalSync({ announce: !!announce }),
    get backgroundBusy() { return !!(state.importRunning || state.openingPath || noteMovePromise || editorInputPending()); },
    get dirty() { return hasPendingEdits() || !!window.RelatumNoteCanvas?.dirty; },
    get currentPath() { return state.current ? state.current.path : ''; },
    get usagePath() { return graphPresentation || browserResultsActive() ? '' : state.current?.path || ''; } };
})();

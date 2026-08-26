// 起步页 — 阶段 3b（自定义分组）+ 左侧分组栏布局
// - /api/recent 返回 {groups, files}
// - 左栏：最近 + 各分组（带数量），点选某组；底部"+ 新建分组"；组右键 改名/删除
// - 右栏：当前选中组的画布列表（点击打开 / 右键 重命名·资源管理器·移除·移动到）
// - 选中的组记在 localStorage；失效文件标记并提示移除

(function () {
  'use strict';

  const main = document.querySelector('.start-main');
  const workspacePanels = Array.from(document.querySelectorAll('[data-start-workspace-panel]'));
  const workspaceButtons = Array.from(document.querySelectorAll('button[data-start-workspace]'));
  const loadingView = document.querySelector('[data-view="loading"]');
  const emptyView = document.querySelector('[data-view="empty"]');
  const recentView = document.querySelector('[data-view="recent"]');
  const dots = document.querySelector('[data-role="page-dots"]');
  const trashEntry = document.querySelector('[data-role="trash-entry"]');
  const bookView = document.querySelector('.book-view');
  const bookStage = document.querySelector('[data-role="book-stage"]');
  const bookPage = document.querySelector('[data-role="book-page"]');
  const spineActiveOrb = document.querySelector('[data-role="spine-active-orb"]');
  const spineHoverRail = document.querySelector('[data-role="spine-hover-rail"]');
  const spineHoverOrb = document.querySelector('[data-role="spine-hover-orb"]');
  let spineBreatheTimer = 0;
  let spineMarkerSettleTimer = 0;
  let spineMarkerTransitionFrame = 0;
  let spinePreviewTarget = null;
  let spineMarkerState = 'hidden';
  let spineMarkerTargetKey = '';
  let spineMarkerReady = false;
  const fileList = document.querySelector('[data-role="file-list"]');
  const panelTitle = document.querySelector('[data-role="panel-title"]');
  const recentSyncButton = document.querySelector('[data-action="recent-sync"]');
  const librarySearch = document.querySelector('[data-role="library-search"]');
  const librarySearchInput = document.querySelector('[data-role="library-search-input"]');
  const librarySearchScope = document.querySelector('[data-role="library-search-scope"]');
  const librarySearchCount = document.querySelector('[data-role="library-search-count"]');
  const librarySearchClear = document.querySelector('[data-action="library-search-clear"]');
  const librarySearchStatus = document.querySelector('[data-role="library-search-status"]');
  const ctxMenu = document.querySelector('[data-role="context-menu"]');
  const toastEl = document.querySelector('[data-role="toast"]');
  const startNotice = document.querySelector('[data-role="start-notice"]');
  const startHelp = document.querySelector('[data-role="start-help"]');
  const startHelpTrigger = document.querySelector('[data-action="start-help-open"]');
  const startThemeToggle = document.querySelector('[data-action="start-theme-toggle"]');
  const startSpeedControl = document.querySelector('.start-speed-control');
  const startSpeedTrigger = document.querySelector('[data-action="start-speed-toggle"]');
  const startSpeedPop = document.querySelector('[data-role="start-speed-pop"]');
  const startSpeedRange = document.querySelector('[data-role="start-speed-range"]');
  const startSpeedValue = document.querySelector('[data-role="start-speed-value"]');
  const notesInertiaRange = document.querySelector('[data-role="notes-inertia-range"]');
  const notesInertiaValue = document.querySelector('[data-role="notes-inertia-value"]');
  const notesStackHoverDelayRange = document.querySelector('[data-role="notes-stack-hover-delay-range"]');
  const notesStackHoverDelayValue = document.querySelector('[data-role="notes-stack-hover-delay-value"]');
  const notesConsole = document.querySelector('[data-role="notes-console"]');
  const notesConsoleTrigger = document.querySelector('[data-role="notes-console-trigger"]');
  const notesConsolePanel = document.querySelector('[data-role="notes-console-panel"]');
  const notesConsoleColors = document.querySelector('[data-role="notes-console-colors"]');
  const notesConsoleReset = document.querySelector('[data-role="notes-console-reset"]');
  const notesConsoleHelpTrigger = document.querySelector('[data-role="notes-console-help-trigger"]');
  const notesConsoleHelpPanel = document.querySelector('[data-role="notes-console-help-panel"]');
  const calendarCountdownToggle = document.querySelector('[data-role="calendar-countdown-toggle"]');
  const startPageActivityToggle = document.querySelector('[data-role="start-page-activity-toggle"]');
  const startPageActivityStatsToggle = document.querySelector('[data-role="start-page-activity-stats-toggle"]');
  const hideSpecialToggle = document.querySelector('[data-role="hide-special-toggle"]');
  const goalTreeSimpleToggle = document.querySelector('[data-role="goal-tree-simple-toggle"]');
  const goalTreeUnlockToggle = document.querySelector('[data-role="goal-tree-unlock-toggle"]');
  const treePageRootTitleToggle = document.querySelector('[data-role="tree-page-root-title-toggle"]');
  const treePageRootTitleSizeRange = document.querySelector('[data-role="tree-page-root-title-size-range"]');
  const treePageRootTitleSizeValue = document.querySelector('[data-role="tree-page-root-title-size-value"]');
  const librarySearchToggle = document.querySelector('[data-role="library-search-toggle"]');
  const initialView = new URLSearchParams(window.location.search).get('view') || '';
  let initialStudy = initialView === 'study';
  let initialCalendar = initialView === 'calendar';

  if (!main || !emptyView || !recentView || !dots || !fileList || !ctxMenu) return;

  let lastGroups = [];
  let lastFiles = [];
  let recentLimit = 30;
  let validGroupIds = new Set();
  let fileBuckets = new Map();
  let recentRefreshSeq = 0;
  let fileStatsRequestSeq = 0;
  const fileStatsCache = new Map();
  let fileStatsObserver = null;
  let librarySearchQuery = '';
  let librarySearchMode = 'current';
  let librarySearchEnabled = false;
  let librarySearchFrame = 0;
  let librarySearchRenderSeq = 0;
  let librarySearchAnnounceTimer = 0;
  let librarySearchRestoreScroll = null;
  let draggingPath = null;   // 3c：正在拖拽的文件路径（dataTransfer 的兜底）
  const flashImportPaths = new Set(); // 新导入画布的路径，渲染后各播一次入场动画
  // 3d：键盘归类
  let panelFiles = [];       // 右栏当前显示的文件（= filesOf(activeGroup)）
  let selectedIndex = -1;    // 右栏键盘选中项下标（-1=未选）
  let pendingDeleteIndex = -1; // 右方向键：待确认删除（再按一次右键执行）
  const trashingPaths = new Set(); // 防止右键菜单与键盘对同一画布重复提交
  let studyActive = false;
  let cadenceActive = false;   // 活跃热力图前置页（位于日历与速记之间）是否展开
  let treePageActive = false;  // 独立树状页（位于速记与学习之间；不读取目标树数据）
  let notesActive = false;     // 速记便签墙前置页（位于活跃与树状之间）是否展开
  let calendarActive = false;  // 日历与日记前置页（在复习与活跃之间）是否展开
  let reviewActive = false;    // 复习卡片前置页（最左一格）是否展开
  let focusActive = false;     // 专注钟前置页（学习更右一格、紧邻书页）是否展开
  let pendingFocusActivation = null;
  let pendingFocusReadyActions = [];
  let specialPagesHidden = false; // 「隐藏特殊页」开启：书脊只留普通书页，7 张前置页既不显示也不可翻入
  const FAVORITES_PAGE = '__favorites__';
  const INBOX_PAGE = '__inbox__';
  const LARGE_LIST_THRESHOLD = 80;
  const STAGGER_LIST_LIMIT = 40;
  // 当前选中的分组 id（''=最近），记住上次选择
  let activeGroup = '';
  try { activeGroup = localStorage.getItem('canvas:activeGroup') || ''; } catch (e) {}
  const START_THEME_KEY = 'canvas:startTheme';
  const START_BACKGROUND_KEY = 'canvas:startBackgroundStyle';
  let startTheme = 'light';
  let startBackgroundStyle = 'simple';
  let startThemeButtonTimer = 0;
  let startThemeApplyFrame = 0;
  const START_SPEED_KEY = 'canvas:startTurnMs';
  const START_SPEED_MIN = 180;
  const START_SPEED_MAX = 500;
  const START_SPEED_DEFAULT = 260;
  const EXPECTED_RUNTIME_SCHEMA = 3;
  const NOTES_INERTIA_KEY = 'canvas:notesInertia';
  const NOTES_INERTIA_DEFAULT = 0.45;
  const NOTES_STACK_HOVER_DELAY_KEY = 'canvas:notesStackHoverDelay';
  const NOTES_STACK_HOVER_DELAY_DEFAULT = 320;
  const NOTES_CONSOLE_HOTSPOT_WIDTH = 48;
  const NOTES_CONSOLE_HOTSPOT_HEIGHT = 72;
  const CALENDAR_COUNTDOWN_KEY = 'canvas:calendarCountdownEnabled';
  const START_PAGE_ACTIVITY_ENABLED_KEY = 'canvas:startPageActivityEnabled:v1';
  const START_PAGE_ACTIVITY_STATS_VISIBLE_KEY = 'canvas:startPageActivityStatsVisible:v1';
  const HIDE_SPECIAL_KEY = 'canvas:hideSpecialPages';
  const GOAL_TREE_SIMPLE_KEY = 'canvas:studyGoalTreeSimpleMode:v1';
  const GOAL_TREE_ENFORCE_UNLOCK_KEY = 'canvas:goalTreeEnforceUnlock:v1';
  const TREE_PAGE_ROOT_TITLE_HIDDEN_KEY = 'canvas:treePageRootTitleHidden:v1';
  const TREE_PAGE_ROOT_TITLE_SIZE_KEY = 'canvas:treePageRootTitleSize:v1';
  const TREE_PAGE_ROOT_TITLE_SIZE_DEFAULT = 25;
  const TREE_PAGE_ROOT_TITLE_SIZE_MIN = 16;
  const TREE_PAGE_ROOT_TITLE_SIZE_MAX = 36;
  const LIBRARY_SEARCH_ENABLED_KEY = 'canvas:librarySearchEnabled';
  let startTurnSpeed = START_SPEED_DEFAULT;
  const START_WORKSPACE_KEY = 'canvas:startWorkspace:v1';
  const START_WORKSPACE_ORDER = { canvas: 0, notes: 1, career: 2 };
  let activeStartWorkspace = Object.prototype.hasOwnProperty.call(
    START_WORKSPACE_ORDER, document.body.dataset.startWorkspace,
  ) ? document.body.dataset.startWorkspace : 'canvas';
  let workspaceSwitchPromise = Promise.resolve(true);
  let noteWorkspaceLoader = null;
  let careerWorkspaceLoader = null;
  let noteWorkspaceWarmupHandle = 0;
  let noteWorkspaceWarmupScheduled = false;
  let careerWorkspaceWarmupHandle = 0;
  let careerWorkspaceWarmupScheduled = false;
  let workspaceTransitionTimer = 0;
  let notesInertia = NOTES_INERTIA_DEFAULT;
  let startViewTransitionTimer = 0;
  const START_VIEW_ORDER = { review: 0, calendar: 1, cadence: 2, notes: 3, tree: 4, study: 5, focus: 6, recent: 7, empty: 7, loading: 7 };
  const START_VIEW_MOTION_CLASSES = ['view-entering', 'view-leaving', 'view-motion-forward', 'view-motion-back'];
  const START_PAGE_ACTIVITY_VIEWS = new Set(['study', 'tree', 'notes']);
  let startPageActivityEnabled = false;
  let startPageActivityStatsVisible = false;
  let startPageActivityActive = false;
  let startPageActivityPage = '';
  let startPageActivityLastCapturedAt = 0;
  let startPageActivityHeartbeat = 0;
  let startPageActivitySending = null;
  const startPageActivityPending = [];
  const startPageActivityIdleWaiters = new Set();
  const startPageActivitySessionId = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : 'start-page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

  function englishUI() {
    return !!(window.RelatumI18n && window.RelatumI18n.language === 'en');
  }

  function loadNoteWorkspace() {
    if (window.CanvasNoteWorkspace) return Promise.resolve(window.CanvasNoteWorkspace);
    if (noteWorkspaceLoader) return noteWorkspaceLoader;
    const loadScript = (src, ready) => {
      if (ready()) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => ready() ? resolve(true) : reject(new Error(src + ' 没有完成初始化'));
        script.onerror = () => reject(new Error(src + ' 加载失败'));
        document.head.appendChild(script);
      });
    };
    noteWorkspaceLoader = loadScript('vendor/codemirror/relatum-codemirror.min.js', () => !!window.RelatumCodeMirror)
      .then(() => loadScript('note-live-editor.js', () => !!window.RelatumNoteLiveEditor))
      .then(() => loadScript('note-workspace.js', () => !!window.CanvasNoteWorkspace))
      .then(() => window.CanvasNoteWorkspace);
    return noteWorkspaceLoader;
  }

  function loadCareerWorkspace() {
    if (window.RelatumCareerReport) return Promise.resolve(window.RelatumCareerReport);
    if (careerWorkspaceLoader) return careerWorkspaceLoader;
    careerWorkspaceLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'career-report.js';
      script.async = true;
      script.onload = () => window.RelatumCareerReport
        ? resolve(window.RelatumCareerReport)
        : reject(new Error('career-report.js 没有完成初始化'));
      script.onerror = () => reject(new Error('career-report.js 加载失败'));
      document.head.appendChild(script);
    });
    return careerWorkspaceLoader;
  }

  function scheduleNoteWorkspaceIdleWarmup() {
    if (activeStartWorkspace !== 'canvas' || noteWorkspaceWarmupScheduled || window.CanvasNoteWorkspace) return;
    noteWorkspaceWarmupScheduled = true;
    const warmup = () => {
      noteWorkspaceWarmupHandle = 0;
      if (activeStartWorkspace !== 'canvas') return;
      loadNoteWorkspace()
        .then((workspace) => typeof workspace.preload === 'function' ? workspace.preload() : true)
        .catch(() => {});
    };
    const queueWarmup = () => {
      if (typeof window.requestIdleCallback === 'function') {
        noteWorkspaceWarmupHandle = window.requestIdleCallback(warmup, { timeout: 2400 });
      } else {
        noteWorkspaceWarmupHandle = window.setTimeout(warmup, 900);
      }
    };
    if (document.readyState === 'complete') queueWarmup();
    else window.addEventListener('load', queueWarmup, { once: true });
  }

  // 生涯报告本身已经是冻结磁盘快照。首屏稳定后在空闲时间提前加载轻量运行时
  // 和快照，避免用户第一次切换到第三工作区时再看到本地读取占位。
  function scheduleCareerWorkspaceIdleWarmup() {
    if (careerWorkspaceWarmupScheduled || (window.RelatumCareerReport && window.RelatumCareerReport.report)) return;
    careerWorkspaceWarmupScheduled = true;
    const warmup = () => {
      careerWorkspaceWarmupHandle = 0;
      loadCareerWorkspace()
        .then((workspace) => typeof workspace.preload === 'function' ? workspace.preload() : true)
        .catch(() => { careerWorkspaceWarmupScheduled = false; });
    };
    const queueWarmup = () => {
      if (typeof window.requestIdleCallback === 'function') {
        careerWorkspaceWarmupHandle = window.requestIdleCallback(warmup, { timeout: 1600 });
      } else {
        careerWorkspaceWarmupHandle = window.setTimeout(warmup, 700);
      }
    };
    if (document.readyState === 'complete') queueWarmup();
    else window.addEventListener('load', queueWarmup, { once: true });
  }

  function syncWorkspaceControls(name) {
    document.documentElement.dataset.startWorkspace = name;
    document.body.dataset.startWorkspace = name;
    if (name !== 'notes') {
      document.documentElement.classList.remove('note-boot-pending');
      if (window.RelatumBoot && window.RelatumBoot.noteRevealTimer) {
        clearTimeout(window.RelatumBoot.noteRevealTimer);
        window.RelatumBoot.noteRevealTimer = 0;
      }
    }
    workspaceButtons.forEach((button) => {
      const active = button.dataset.startWorkspace === name;
      button.classList.toggle('active', active);
      if (button.getAttribute('role') === 'tab') {
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.tabIndex = active ? 0 : -1;
      }
    });
  }

  function showWorkspacePanel(name, previous, animate) {
    clearTimeout(workspaceTransitionTimer);
    const nextPanel = workspacePanels.find((panel) => panel.dataset.startWorkspacePanel === name);
    const previousPanel = workspacePanels.find((panel) => panel.dataset.startWorkspacePanel === previous);
    if (!nextPanel) return;
    workspacePanels.forEach((panel) => {
      if (panel !== nextPanel && panel !== previousPanel) {
        panel.hidden = true;
        panel.classList.remove('workspace-entering', 'workspace-leaving', 'workspace-forward', 'workspace-back');
      }
    });
    nextPanel.hidden = false;
    nextPanel.inert = false;
    if (!animate || !previousPanel || previousPanel === nextPanel
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (previousPanel && previousPanel !== nextPanel) previousPanel.hidden = true;
      nextPanel.classList.remove('workspace-entering', 'workspace-leaving', 'workspace-forward', 'workspace-back');
      if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
      return;
    }
    const forward = START_WORKSPACE_ORDER[name] > START_WORKSPACE_ORDER[previous];
    const directionClass = forward ? 'workspace-forward' : 'workspace-back';
    previousPanel.hidden = false;
    previousPanel.inert = true;
    previousPanel.classList.add('workspace-leaving', directionClass);
    nextPanel.classList.add('workspace-entering', directionClass);
    requestAnimationFrame(() => document.body.classList.add('start-workspace-turning'));
    workspaceTransitionTimer = window.setTimeout(() => {
      previousPanel.hidden = true;
      previousPanel.inert = false;
      previousPanel.classList.remove('workspace-leaving', directionClass);
      nextPanel.classList.remove('workspace-entering', directionClass);
      document.body.classList.remove('start-workspace-turning');
      if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
    }, Math.max(180, startTurnSpeed) + 60);
    if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
  }

  // 画布工作区隐藏时，书脊目标的 DOMRect 会退化为零尺寸；此时留下的游标形状
  // 不能复用于再次进入画布。等待共享网格完成两帧布局后，重新同步黑色游标与
  // 彩色跟随层；动画收尾处还会再校准一次，避免过渡结束后出现一帧跳位。
  function syncCanvasWorkspaceSpineAfterReveal() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (activeStartWorkspace !== 'canvas') return;
      syncActiveSpineOrb({ animate: false });
    }));
  }

  async function performStartWorkspace(next, options = {}) {
    const name = Object.prototype.hasOwnProperty.call(START_WORKSPACE_ORDER, next) ? next : 'canvas';
    const previous = activeStartWorkspace;
    if (name !== previous && previous === 'notes' && window.CanvasNoteWorkspace
      && typeof window.CanvasNoteWorkspace.deactivate === 'function') {
      const canLeave = await window.CanvasNoteWorkspace.deactivate();
      if (canLeave === false) return false;
    }
    activeStartWorkspace = name;
    syncWorkspaceControls(name);
    syncStartPageActivity();
    showWorkspacePanel(name, previous, options.animate !== false && name !== previous);
    if (options.persist !== false) {
      try { localStorage.setItem(START_WORKSPACE_KEY, name); } catch (e) {}
    }
    if (name === 'notes') {
      try {
        const notesWorkspace = await loadNoteWorkspace();
        if (activeStartWorkspace === 'notes') await notesWorkspace.activate();
      } catch (error) {
        if (activeStartWorkspace === 'notes') {
          activeStartWorkspace = 'canvas';
          syncWorkspaceControls('canvas');
          syncStartPageActivity();
          showWorkspacePanel('canvas', 'notes', false);
          showNotice(englishUI() ? 'Notes unavailable' : '笔记工作区暂时无法打开', error.message || String(error));
        }
        return false;
      }
    } else if (name === 'career') {
      try {
        const careerWorkspace = await loadCareerWorkspace();
        if (activeStartWorkspace === 'career') await careerWorkspace.activate();
      } catch (error) {
        if (activeStartWorkspace === 'career') {
          activeStartWorkspace = 'canvas';
          syncWorkspaceControls('canvas');
          syncStartPageActivity();
          showWorkspacePanel('canvas', 'career', false);
          showNotice(englishUI() ? 'Career report unavailable' : '生涯报告暂时无法打开', error.message || String(error));
        }
        return false;
      }
    } else if (name === 'canvas') {
      scheduleCareerWorkspaceIdleWarmup();
      scheduleNoteWorkspaceIdleWarmup();
    }
    document.dispatchEvent(new CustomEvent('relatum:start-workspacechange', {
      detail: { workspace: name, previous },
    }));
    return true;
  }

  function setStartWorkspace(next, options = {}) {
    workspaceSwitchPromise = workspaceSwitchPromise
      .catch(() => false)
      .then(() => performStartWorkspace(next, options));
    return workspaceSwitchPromise;
  }

  workspaceButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const workspace = button.dataset.startWorkspace;
      setStartWorkspace(workspace);
      // 鼠标 / 触控点击进入生涯后释放按钮焦点，否则 :focus-visible 会让
      // 带全宽模糊层的顶栏持续展开。键盘激活的 click.detail 为 0，继续
      // 保留焦点，供键盘用户通过顶栏切换工作区。
      if (workspace === 'career' && event.detail > 0) button.blur();
    });
  });
  syncWorkspaceControls(activeStartWorkspace);
  workspacePanels.forEach((panel) => {
    const active = panel.dataset.startWorkspacePanel === activeStartWorkspace;
    panel.hidden = !active;
    panel.inert = !active;
  });
  window.RelatumStartWorkspace = {
    get current() { return activeStartWorkspace; },
    set: setStartWorkspace,
  };
  if (activeStartWorkspace === 'notes' || activeStartWorkspace === 'career') {
    setStartWorkspace(activeStartWorkspace, { animate: false, persist: false });
  }
  else {
    scheduleCareerWorkspaceIdleWarmup();
    scheduleNoteWorkspaceIdleWarmup();
  }
  if (activeStartWorkspace === 'notes') scheduleCareerWorkspaceIdleWarmup();

  function preloadEditorBackground(background) {
    if (!background || typeof background !== 'object') return;
    let source = '';
    if (background.type === 'image' && background.path) {
      source = '/api/background-image?path=' + encodeURIComponent(background.path);
    } else if (background.type === 'gradient' && background.preset === 'polar-light') {
      source = '/sky-dark.png';
    }
    if (!source) return;
    // 背景偏好返回后立即以低优先级预热。此前放进 requestIdleCallback，用户在
    // 一秒内打开画布时导航往往先发生，预热还没开始；现在配合 ETag 缓存可跨页复用。
    const image = new Image();
    image.decoding = 'async';
    try { image.fetchPriority = 'low'; } catch (e) {}
    image.src = source;
  }

  // 编辑器首帧需要在 /api/load 返回前选好深浅等待底色。起步页提前同步语义，
  // 并在空闲时预热当前背景，让进入编辑器时尽量直接命中浏览器缓存。
  fetch('/api/background-preference', { cache: 'no-store' })
    .then((resp) => resp.ok ? resp.json() : null)
    .then((json) => {
      const tone = json && json.configured && json.background && json.background.tone === 'dark'
        ? 'dark' : 'light';
      try { localStorage.setItem('canvas:backgroundTone', tone); } catch (e) {}
      if (json && json.configured) preloadEditorBackground(json.background);
    })
    .catch(() => {});

  function applyStartTheme(theme) {
    startTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.startTheme = startTheme;
    document.body.dataset.startTheme = startTheme;
    if (startThemeToggle) {
      const dark = startTheme === 'dark';
      startThemeToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
      startThemeToggle.setAttribute('aria-label', dark ? '切换为浅色起始页' : '切换为深色起始页');
    }
  }

  function applyStartBackgroundStyle(style, persist) {
    startBackgroundStyle = style === 'scenic' ? 'scenic' : 'simple';
    document.body.dataset.startBackground = startBackgroundStyle;
    document.documentElement.dataset.startBackground = startBackgroundStyle;
    document.querySelectorAll('[data-role="start-background-switch"] button').forEach((button) => {
      const active = button.dataset.backgroundStyle === startBackgroundStyle;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (persist) {
      try { localStorage.setItem(START_BACKGROUND_KEY, startBackgroundStyle); } catch (e) {}
    }
  }

  function transitionStartTheme(next) {
    const nextTheme = next === 'dark' ? 'dark' : 'light';
    if (startThemeToggle) {
      startThemeToggle.classList.add('is-switching');
      clearTimeout(startThemeButtonTimer);
      startThemeButtonTimer = window.setTimeout(() => {
        startThemeToggle.classList.remove('is-switching');
        startThemeButtonTimer = 0;
      }, 360);
    }
    // 硬切主题：先在这一帧禁掉起始页所有过渡（.theme-instant），让整页一次性翻成目标主题，
    // 不做颜色渐变、不盖蒙版——点一下就是它，最跟手；下一帧再恢复过渡。
    document.body.classList.add('theme-instant');
    applyStartTheme(nextTheme);
    void document.body.offsetWidth;   // 强制同步提交“无过渡 + 新主题”这一帧
    if (startThemeApplyFrame) cancelAnimationFrame(startThemeApplyFrame);
    startThemeApplyFrame = requestAnimationFrame(() => {
      startThemeApplyFrame = 0;
      document.body.classList.remove('theme-instant');
    });
  }

  function clampStartSpeed(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return START_SPEED_DEFAULT;
    const rounded = Math.round(n / 10) * 10;
    return Math.max(START_SPEED_MIN, Math.min(START_SPEED_MAX, rounded));
  }

  function setStartMsVar(name, value) {
    document.documentElement.style.setProperty(name, Math.round(value) + 'ms');
  }

  function applyStartSpeed(value, persist) {
    const ms = clampStartSpeed(value);
    startTurnSpeed = ms;
    setStartMsVar('--start-turn-ms', ms);
    setStartMsVar('--start-turn-leave-ms', Math.max(165, ms * 0.92));
    setStartMsVar('--start-turn-fade-ms', Math.max(110, ms * 0.6));
    setStartMsVar('--start-turn-out-fade-ms', Math.max(80, ms * 0.38));
    setStartMsVar('--start-rest-fade-ms', Math.max(240, ms * 1.36));
    setStartMsVar('--start-stage-fade-ms', Math.max(230, ms * 1.28));
    setStartMsVar('--start-orb-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-shape-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-clip-ms', Math.max(180, ms * 0.92));
    setStartMsVar('--start-orb-fade-ms', Math.max(70, ms * 0.32));
    if (startSpeedRange && startSpeedRange.value !== String(ms)) startSpeedRange.value = String(ms);
    if (startSpeedValue) startSpeedValue.textContent = ms + 'ms';
    if (startSpeedRange) startSpeedRange.setAttribute('aria-valuetext', ms + 'ms');
    if (persist) {
      try { localStorage.setItem(START_SPEED_KEY, String(ms)); } catch (e) {}
    }
  }

  function clampNotesInertia(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NOTES_INERTIA_DEFAULT;
    return Math.round(Math.max(0, Math.min(1.2, n)) * 20) / 20;
  }

  function applyNotesInertia(value, persist) {
    const v = clampNotesInertia(value);
    notesInertia = v;
    if (notesInertiaRange && notesInertiaRange.value !== String(v)) notesInertiaRange.value = String(v);
    if (notesInertiaValue) notesInertiaValue.textContent = Math.round(v * 100) + '%';
    if (notesInertiaRange) notesInertiaRange.setAttribute('aria-valuetext', Math.round(v * 100) + '%');
    if (persist) {
      try { localStorage.setItem(NOTES_INERTIA_KEY, String(v)); } catch (e) {}
      if (window.CanvasNotes && typeof window.CanvasNotes.setInertia === 'function') {
        window.CanvasNotes.setInertia(v);
      }
    }
  }

  function clampNotesStackHoverDelay(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NOTES_STACK_HOVER_DELAY_DEFAULT;
    return Math.max(0, Math.min(1200, Math.round(n / 20) * 20));
  }

  function applyNotesStackHoverDelay(value, persist) {
    const v = clampNotesStackHoverDelay(value);
    if (notesStackHoverDelayRange && notesStackHoverDelayRange.value !== String(v)) notesStackHoverDelayRange.value = String(v);
    if (notesStackHoverDelayValue) notesStackHoverDelayValue.textContent = v + 'ms';
    if (notesStackHoverDelayRange) notesStackHoverDelayRange.setAttribute('aria-valuetext', v + 'ms');
    if (persist) {
      try { localStorage.setItem(NOTES_STACK_HOVER_DELAY_KEY, String(v)); } catch (e) {}
      if (window.CanvasNotes && typeof window.CanvasNotes.setStackHoverDelay === 'function') {
        window.CanvasNotes.setStackHoverDelay(v);
      }
    }
  }

  function applyCalendarCountdownEnabled(enabled, persist) {
    const active = enabled !== false;
    if (calendarCountdownToggle) calendarCountdownToggle.checked = active;
    if (persist) {
      try { localStorage.setItem(CALENDAR_COUNTDOWN_KEY, active ? '1' : '0'); } catch (e) {}
    }
    document.dispatchEvent(new CustomEvent('calendar:countdown-visibility', {
      detail: { enabled: active },
    }));
  }

  function applyStartPageActivityEnabled(enabled, persist) {
    startPageActivityEnabled = enabled !== false;
    if (startPageActivityToggle) startPageActivityToggle.checked = startPageActivityEnabled;
    document.body.dataset.startPageActivityEnabled = startPageActivityEnabled ? '1' : '0';
    if (persist) {
      try {
        localStorage.setItem(START_PAGE_ACTIVITY_ENABLED_KEY, startPageActivityEnabled ? '1' : '0');
      } catch (e) {}
    }
    syncStartPageActivity();
  }

  function applyStartPageActivityStatsVisible(visible, persist) {
    startPageActivityStatsVisible = visible === true;
    if (startPageActivityStatsToggle) startPageActivityStatsToggle.checked = startPageActivityStatsVisible;
    document.body.dataset.startPageActivityStatsVisible = startPageActivityStatsVisible ? '1' : '0';
    if (persist) {
      try {
        localStorage.setItem(START_PAGE_ACTIVITY_STATS_VISIBLE_KEY, startPageActivityStatsVisible ? '1' : '0');
      } catch (e) {}
    }
  }

  // 「隐藏特殊页」：开启后书脊只剩普通书页（最近 / 收藏 / 自定义分组）的圆点，
  // 7 张前置页（复习/日历/活跃/速记/树状/学习/专注）的入口被 CSS 收起，滚轮翻页也跳过它们。
  function applyHideSpecialPages(hidden, persist) {
    specialPagesHidden = !!hidden;
    if (hideSpecialToggle) hideSpecialToggle.checked = specialPagesHidden;
    document.body.dataset.hideSpecial = specialPagesHidden ? '1' : '0';
    if (persist) {
      try { localStorage.setItem(HIDE_SPECIAL_KEY, specialPagesHidden ? '1' : '0'); } catch (e) {}
    }
    // 若开启时正停在某张特殊页，立刻退回「最近」，避免卡在已被隐藏、又翻不动的页面上。
    if (specialPagesHidden && (studyActive || cadenceActive || treePageActive || notesActive
        || calendarActive || reviewActive || focusActive)) {
      navigateTo('');
    }
  }

  function applyGoalTreeSimpleMode(simple, persist) {
    const active = simple !== false;
    if (goalTreeSimpleToggle) goalTreeSimpleToggle.checked = active;
    if (persist) {
      try { localStorage.setItem(GOAL_TREE_SIMPLE_KEY, active ? '1' : '0'); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('relatum:goal-tree-simple-mode-change', {
      detail: { simple: active },
    }));
  }

  function applyGoalTreeUnlockEnforcement(enforced, persist) {
    const active = enforced === true;
    if (goalTreeUnlockToggle) goalTreeUnlockToggle.checked = active;
    if (persist) {
      try { localStorage.setItem(GOAL_TREE_ENFORCE_UNLOCK_KEY, active ? '1' : '0'); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('relatum:goal-tree-unlock-enforcement-change', {
      detail: { enforced: active },
    }));
  }

  function applyTreePageRootTitleHidden(hidden, persist) {
    const active = hidden === true;
    if (treePageRootTitleToggle) treePageRootTitleToggle.checked = active;
    if (persist) {
      try { localStorage.setItem(TREE_PAGE_ROOT_TITLE_HIDDEN_KEY, active ? '1' : '0'); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('relatum:tree-page-root-title-change', {
      detail: { hidden: active },
    }));
  }

  function clampTreePageRootTitleSize(value) {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size)) return TREE_PAGE_ROOT_TITLE_SIZE_DEFAULT;
    return Math.max(TREE_PAGE_ROOT_TITLE_SIZE_MIN, Math.min(TREE_PAGE_ROOT_TITLE_SIZE_MAX, size));
  }

  function applyTreePageRootTitleSize(value, persist) {
    const size = clampTreePageRootTitleSize(value);
    if (treePageRootTitleSizeRange) treePageRootTitleSizeRange.value = String(size);
    if (treePageRootTitleSizeValue) treePageRootTitleSizeValue.textContent = size + 'px';
    document.documentElement.style.setProperty('--tree-page-root-title-size', size + 'px');
    if (persist) {
      try { localStorage.setItem(TREE_PAGE_ROOT_TITLE_SIZE_KEY, String(size)); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('relatum:tree-page-root-title-size-change', {
      detail: { size: size },
    }));
  }

  function applyLibrarySearchEnabled(enabled, persist) {
    const active = enabled === true;
    const wasEnabled = librarySearchEnabled;
    const hadQuery = !!String(librarySearchQuery || (librarySearchInput && librarySearchInput.value) || '').trim();
    librarySearchEnabled = active;
    if (librarySearchToggle) librarySearchToggle.checked = active;
    document.body.dataset.librarySearchEnabled = active ? '1' : '0';
    if (librarySearch) {
      librarySearch.toggleAttribute('inert', !active);
      librarySearch.setAttribute('aria-hidden', String(!active));
    }
    if (!active) {
      if (librarySearchFrame) {
        cancelAnimationFrame(librarySearchFrame);
        librarySearchFrame = 0;
      }
      if (librarySearchInput) librarySearchInput.value = '';
      librarySearchQuery = '';
      clearTimeout(librarySearchAnnounceTimer);
      if (librarySearchStatus) librarySearchStatus.textContent = '';
      if (hadQuery && fileList.childElementCount) {
        renderPanel({ searchUpdate: true });
        if (bookStage && librarySearchRestoreScroll != null) {
          const restore = librarySearchRestoreScroll;
          librarySearchRestoreScroll = null;
          requestAnimationFrame(() => { bookStage.scrollTop = restore; });
        }
      } else if (wasEnabled || fileList.childElementCount) {
        syncLibrarySearchChrome(panelFiles.length);
      }
    } else if (!wasEnabled) {
      syncLibrarySearchChrome(panelFiles.length);
    }
    if (persist) {
      try { localStorage.setItem(LIBRARY_SEARCH_ENABLED_KEY, active ? '1' : '0'); } catch (e) {}
    }
  }

  function startViewCleanupDelay(previous, next) {
    const calendarMotion = previous === 'calendar' || next === 'calendar';
    if (next === 'review') return Math.max(760, startTurnSpeed + 500);
    if (previous === 'review') return Math.max(480, startTurnSpeed + 220);
    return Math.max(calendarMotion ? 480 : 280, startTurnSpeed + (calendarMotion ? 220 : 140));
  }

  function startBookSwapDelay() {
    return Math.max(90, Math.round(startTurnSpeed * 0.4));
  }

  function startBookFlipDoneDelay() {
    return Math.max(220, Math.round(startTurnSpeed * 1.08));
  }

  function setStartSpeedOpen(open) {
    if (!startSpeedPop || !startSpeedTrigger) return;
    startSpeedPop.hidden = !open;
    startSpeedTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  try { startTurnSpeed = clampStartSpeed(localStorage.getItem(START_SPEED_KEY) || START_SPEED_DEFAULT); } catch (e) {
    startTurnSpeed = START_SPEED_DEFAULT;
  }
  applyStartSpeed(startTurnSpeed, false);
  try { notesInertia = clampNotesInertia(localStorage.getItem(NOTES_INERTIA_KEY) || NOTES_INERTIA_DEFAULT); } catch (e) {
    notesInertia = NOTES_INERTIA_DEFAULT;
  }
  applyNotesInertia(notesInertia, false);
  let notesStackHoverDelay = NOTES_STACK_HOVER_DELAY_DEFAULT;
  try { notesStackHoverDelay = clampNotesStackHoverDelay(localStorage.getItem(NOTES_STACK_HOVER_DELAY_KEY) || NOTES_STACK_HOVER_DELAY_DEFAULT); } catch (e) {
    notesStackHoverDelay = NOTES_STACK_HOVER_DELAY_DEFAULT;
  }
  applyNotesStackHoverDelay(notesStackHoverDelay, false);
  let calendarCountdownEnabled = true;
  try { calendarCountdownEnabled = localStorage.getItem(CALENDAR_COUNTDOWN_KEY) !== '0'; } catch (e) {}
  applyCalendarCountdownEnabled(calendarCountdownEnabled, false);
  let startPageActivityEnabledInit = false;
  try { startPageActivityEnabledInit = localStorage.getItem(START_PAGE_ACTIVITY_ENABLED_KEY) === '1'; } catch (e) {}
  applyStartPageActivityEnabled(startPageActivityEnabledInit, false);
  let startPageActivityStatsVisibleInit = startPageActivityEnabledInit;
  try {
    const storedStartPageActivityStatsVisible = localStorage.getItem(START_PAGE_ACTIVITY_STATS_VISIBLE_KEY);
    if (storedStartPageActivityStatsVisible === '1' || storedStartPageActivityStatsVisible === '0') {
      startPageActivityStatsVisibleInit = storedStartPageActivityStatsVisible === '1';
    } else {
      localStorage.setItem(START_PAGE_ACTIVITY_STATS_VISIBLE_KEY, startPageActivityStatsVisibleInit ? '1' : '0');
    }
  } catch (e) {}
  applyStartPageActivityStatsVisible(startPageActivityStatsVisibleInit, false);
  let hideSpecialInit = false;  // 默认关闭：出厂即显示特殊页，只有显式存过 '1' 才隐藏
  try { hideSpecialInit = localStorage.getItem(HIDE_SPECIAL_KEY) === '1'; } catch (e) {}
  applyHideSpecialPages(hideSpecialInit, false);
  let goalTreeSimpleInit = true;
  try { goalTreeSimpleInit = localStorage.getItem(GOAL_TREE_SIMPLE_KEY) !== '0'; } catch (e) {}
  applyGoalTreeSimpleMode(goalTreeSimpleInit, false);
  let goalTreeUnlockEnforcedInit = false;
  try { goalTreeUnlockEnforcedInit = localStorage.getItem(GOAL_TREE_ENFORCE_UNLOCK_KEY) === '1'; } catch (e) {}
  applyGoalTreeUnlockEnforcement(goalTreeUnlockEnforcedInit, false);
  let treePageRootTitleHiddenInit = false;
  try { treePageRootTitleHiddenInit = localStorage.getItem(TREE_PAGE_ROOT_TITLE_HIDDEN_KEY) === '1'; } catch (e) {}
  applyTreePageRootTitleHidden(treePageRootTitleHiddenInit, false);
  let treePageRootTitleSizeInit = TREE_PAGE_ROOT_TITLE_SIZE_DEFAULT;
  try { treePageRootTitleSizeInit = localStorage.getItem(TREE_PAGE_ROOT_TITLE_SIZE_KEY) || TREE_PAGE_ROOT_TITLE_SIZE_DEFAULT; } catch (e) {}
  applyTreePageRootTitleSize(treePageRootTitleSizeInit, false);
  let librarySearchEnabledInit = false;
  try { librarySearchEnabledInit = localStorage.getItem(LIBRARY_SEARCH_ENABLED_KEY) === '1'; } catch (e) {}
  applyLibrarySearchEnabled(librarySearchEnabledInit, false);
  if (startSpeedTrigger && startSpeedPop) {
    startSpeedTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      setStartSpeedOpen(startSpeedPop.hidden);
    });
    if (startSpeedControl) {
      startSpeedControl.addEventListener('click', (event) => event.stopPropagation());
    }
    document.addEventListener('click', () => setStartSpeedOpen(false));
    document.addEventListener('keydown', (event) => {
      if (!startSpeedPop.hidden && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setStartSpeedOpen(false);
      }
    });
  }
  if (startSpeedRange) {
    startSpeedRange.addEventListener('input', () => applyStartSpeed(startSpeedRange.value, true));
  }
  if (notesInertiaRange) {
    notesInertiaRange.addEventListener('input', () => applyNotesInertia(notesInertiaRange.value, true));
  }
  if (notesStackHoverDelayRange) {
    notesStackHoverDelayRange.addEventListener('input', () => applyNotesStackHoverDelay(notesStackHoverDelayRange.value, true));
  }
  (function setupNotesConsole() {
    const notesView = document.querySelector('[data-role="notes-view"]');
    const palette = window.RelatumStickyPalette;
    if (!notesView || !notesConsole || !notesConsoleTrigger || !notesConsolePanel || !palette) return;
    let open = false;
    let nearTrigger = false;
    let resetTimer = 0;
    let consoleCloseTimer = 0;
    let helpCloseTimer = 0;
    let helpOpen = false;
    const allColors = notesConsolePanel.querySelector('[data-action="notes-colors-all"]');

    function setRevealed(revealed) {
      notesConsole.classList.toggle('is-revealed', !!revealed || open);
    }

    function setOpen(next, restoreFocus) {
      if (!next && !open && notesConsolePanel.classList.contains('is-closing')) {
        if (restoreFocus) notesConsoleTrigger.focus({ preventScroll: true });
        return;
      }
      const shouldAnimateClose = !next && !notesConsolePanel.hidden
        && !notesConsolePanel.classList.contains('is-closing') && !prefersReduced;
      clearTimeout(consoleCloseTimer);
      open = !!next;
      if (!open) setHelpOpen(false, false);
      notesConsole.classList.toggle('is-open', open);
      notesConsoleTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      notesConsolePanel.inert = !open;
      if (open) {
        notesConsolePanel.classList.remove('is-closing');
        notesConsolePanel.hidden = false;
        notesConsolePanel.removeAttribute('inert');
      } else {
        notesConsolePanel.setAttribute('inert', '');
        if (shouldAnimateClose) {
          notesConsolePanel.classList.add('is-closing');
          consoleCloseTimer = window.setTimeout(() => {
            if (open) return;
            notesConsolePanel.hidden = true;
            notesConsolePanel.classList.remove('is-closing');
          }, 160);
        } else if (!notesConsolePanel.classList.contains('is-closing')) {
          notesConsolePanel.hidden = true;
        }
      }
      setRevealed(open || nearTrigger || notesConsole.matches(':focus-within'));
      if (!open && restoreFocus) notesConsoleTrigger.focus({ preventScroll: true });
    }

    function setHelpOpen(next, restoreFocus) {
      if (!notesConsoleHelpTrigger || !notesConsoleHelpPanel) return;
      if (!next && !helpOpen && notesConsoleHelpPanel.classList.contains('is-closing')) {
        if (restoreFocus) notesConsoleHelpTrigger.focus({ preventScroll: true });
        return;
      }
      const shouldAnimateClose = !next && !notesConsoleHelpPanel.hidden
        && !notesConsoleHelpPanel.classList.contains('is-closing') && !prefersReduced;
      clearTimeout(helpCloseTimer);
      helpOpen = !!next;
      notesConsole.classList.toggle('is-help-open', helpOpen);
      notesConsoleHelpTrigger.setAttribute('aria-expanded', helpOpen ? 'true' : 'false');
      notesConsoleHelpPanel.inert = !helpOpen;
      if (helpOpen) {
        notesConsoleHelpPanel.classList.remove('is-closing');
        notesConsoleHelpPanel.hidden = false;
        notesConsoleHelpPanel.removeAttribute('inert');
      } else {
        notesConsoleHelpPanel.setAttribute('inert', '');
        if (shouldAnimateClose) {
          notesConsoleHelpPanel.classList.add('is-closing');
          helpCloseTimer = window.setTimeout(() => {
            if (helpOpen) return;
            notesConsoleHelpPanel.hidden = true;
            notesConsoleHelpPanel.classList.remove('is-closing');
          }, 160);
        } else if (!notesConsoleHelpPanel.classList.contains('is-closing')) {
          notesConsoleHelpPanel.hidden = true;
        }
      }
      if (!helpOpen && restoreFocus) notesConsoleHelpTrigger.focus({ preventScroll: true });
    }

    function localizedSwatchLabel(item) {
      return englishUI() ? item.en : item.zh;
    }

    function syncPaletteButtons() {
      const selected = new Set(typeof palette.getSelectedKeys === 'function'
        ? palette.getSelectedKeys() : palette.getEnabledKeys());
      notesConsoleColors.querySelectorAll('[data-notes-color]').forEach((button) => {
        const active = selected.has(button.dataset.notesColor);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        const item = palette.byKey(button.dataset.notesColor);
        if (item) {
          const label = localizedSwatchLabel(item);
          button.title = label;
          button.setAttribute('aria-label', (englishUI() ? 'Use ' : '参与随机生成：') + label);
        }
      });
      if (allColors) {
        const allSelected = selected.size === palette.keys.length;
        const label = englishUI()
          ? (allSelected ? 'Clear all' : 'Select all')
          : (allSelected ? '取消全选' : '全选');
        allColors.textContent = label;
        allColors.title = label;
        allColors.setAttribute('aria-label', label);
      }
    }

    palette.swatches.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notes-console-color';
      button.dataset.notesColor = item.key;
      button.style.setProperty('--notes-console-swatch', item.hex);
      notesConsoleColors.appendChild(button);
    });
    syncPaletteButtons();

    notesConsoleColors.addEventListener('click', (event) => {
      const button = event.target.closest('[data-notes-color]');
      if (!button) return;
      const selected = new Set(typeof palette.getSelectedKeys === 'function'
        ? palette.getSelectedKeys() : palette.getEnabledKeys());
      const key = button.dataset.notesColor;
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      palette.setEnabledKeys(Array.from(selected));
    });

    if (allColors) allColors.addEventListener('click', () => {
      const selected = typeof palette.getSelectedKeys === 'function'
        ? palette.getSelectedKeys() : palette.getEnabledKeys();
      palette.setEnabledKeys(selected.length === palette.keys.length ? [] : palette.keys);
    });
    if (notesConsoleHelpTrigger && notesConsoleHelpPanel) {
      notesConsoleHelpTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        setHelpOpen(!helpOpen, false);
      });
    }
    notesConsolePanel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]');
      if (!action || !window.CanvasNotes) return;
      if (action.dataset.action === 'notes-fit-all' && typeof window.CanvasNotes.fitAll === 'function') {
        window.CanvasNotes.fitAll();
      } else if (action.dataset.action === 'notes-reset-view' && typeof window.CanvasNotes.resetView === 'function') {
        window.CanvasNotes.resetView();
      }
    });

    if (notesConsoleReset) {
      notesConsoleReset.addEventListener('click', () => {
        palette.reset();
        applyNotesInertia(NOTES_INERTIA_DEFAULT, true);
        applyNotesStackHoverDelay(NOTES_STACK_HOVER_DELAY_DEFAULT, true);
        notesConsoleReset.classList.add('is-restored');
        notesConsoleReset.textContent = englishUI() ? 'Restored' : '已恢复';
        clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          notesConsoleReset.classList.remove('is-restored');
          notesConsoleReset.textContent = englishUI() ? 'Reset' : '恢复默认';
        }, 1200);
      });
    }

    notesView.addEventListener('pointermove', (event) => {
      if (open || notesConsole.contains(event.target)) return;
      const rect = notesView.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      nearTrigger = event.clientX >= rect.right - NOTES_CONSOLE_HOTSPOT_WIDTH
        && event.clientX <= rect.right
        && event.clientY >= centerY - NOTES_CONSOLE_HOTSPOT_HEIGHT / 2
        && event.clientY <= centerY + NOTES_CONSOLE_HOTSPOT_HEIGHT / 2;
      setRevealed(nearTrigger || notesConsole.matches(':focus-within'));
    });
    notesView.addEventListener('pointerleave', () => {
      nearTrigger = false;
      if (!open && !notesConsole.matches(':focus-within')) setRevealed(false);
    });
    notesConsoleTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(!open, false);
    });
    notesConsoleTrigger.addEventListener('focus', () => setRevealed(true));
    notesConsole.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!open && !nearTrigger && !notesConsole.matches(':focus-within')) setRevealed(false);
      });
    });
    notesConsolePanel.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    document.addEventListener('pointerdown', (event) => {
      if (helpOpen && !notesConsoleHelpPanel.contains(event.target)
        && !notesConsoleHelpTrigger.contains(event.target)) {
        setHelpOpen(false, false);
      }
      if (open && !notesConsole.contains(event.target)) setOpen(false, false);
    });
    document.addEventListener('keydown', (event) => {
      if (helpOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setHelpOpen(false, true);
      } else if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false, true);
      }
    }, true);
    document.addEventListener('relatum:languagechange', () => {
      syncPaletteButtons();
      if (notesConsoleReset && !notesConsoleReset.classList.contains('is-restored')) {
        notesConsoleReset.textContent = englishUI() ? 'Reset' : '恢复默认';
      }
    });
    window.addEventListener('relatum:sticky-palette-change', syncPaletteButtons);
    document.addEventListener('start:viewchange', (event) => {
      if (!event.detail || event.detail.current !== 'notes') {
        nearTrigger = false;
        setHelpOpen(false, false);
        setOpen(false, false);
        setRevealed(false);
      }
    });
  })();
  if (calendarCountdownToggle) {
    calendarCountdownToggle.addEventListener('change', () => {
      applyCalendarCountdownEnabled(calendarCountdownToggle.checked, true);
    });
  }
  if (startPageActivityToggle) {
    startPageActivityToggle.addEventListener('change', () => {
      applyStartPageActivityEnabled(startPageActivityToggle.checked, true);
    });
  }
  if (startPageActivityStatsToggle) {
    startPageActivityStatsToggle.addEventListener('change', () => {
      applyStartPageActivityStatsVisible(startPageActivityStatsToggle.checked, true);
    });
  }
  if (hideSpecialToggle) {
    hideSpecialToggle.addEventListener('change', () => {
      applyHideSpecialPages(hideSpecialToggle.checked, true);
    });
  }
  if (goalTreeSimpleToggle) {
    goalTreeSimpleToggle.addEventListener('change', () => {
      applyGoalTreeSimpleMode(goalTreeSimpleToggle.checked, true);
    });
  }
  if (goalTreeUnlockToggle) {
    goalTreeUnlockToggle.addEventListener('change', () => {
      applyGoalTreeUnlockEnforcement(goalTreeUnlockToggle.checked, true);
    });
  }
  if (treePageRootTitleToggle) {
    treePageRootTitleToggle.addEventListener('change', () => {
      applyTreePageRootTitleHidden(treePageRootTitleToggle.checked, true);
    });
  }
  if (treePageRootTitleSizeRange) {
    treePageRootTitleSizeRange.addEventListener('input', () => {
      applyTreePageRootTitleSize(treePageRootTitleSizeRange.value, true);
    });
  }
  if (librarySearchToggle) {
    librarySearchToggle.addEventListener('change', () => {
      applyLibrarySearchEnabled(librarySearchToggle.checked, true);
    });
  }

  try { startTheme = localStorage.getItem(START_THEME_KEY) || 'light'; } catch (e) {}
  applyStartTheme(startTheme);
  try { startBackgroundStyle = localStorage.getItem(START_BACKGROUND_KEY) || 'simple'; } catch (e) {}
  applyStartBackgroundStyle(startBackgroundStyle, false);

  document.querySelectorAll('[data-role="start-background-switch"] button').forEach((button) => {
    button.addEventListener('click', () => {
      applyStartBackgroundStyle(button.dataset.backgroundStyle, true);
    });
  });

  if (startThemeToggle) {
    startThemeToggle.addEventListener('click', () => {
      const next = startTheme === 'dark' ? 'light' : 'dark';
      transitionStartTheme(next);
      try { localStorage.setItem(START_THEME_KEY, next); } catch (e) {}
    });
  }


  // 起步页「?」只承担本地数据说明；旧的功能教程留给编辑器内的新手引导。
  const START_HELP_PAGES_ZH = [
    {
      id: 'safety', eyebrow: '01 · BEFORE DELETING', title: '删除前，先看这里',
      subtitle: 'Relatum 的画布、笔记和长期记录保存在用户数据目录里的 <code>canvases</code>、<code>notes</code> 和 <code>data</code> 中；界面偏好和部分临时运行态另存在本机浏览器存储中。',
      sections: [
        ['三个文件夹与一组本机偏好', '前三项保存用户内容和长期记录；本机偏好记住界面与当前会话状态。', [
          ['<code>canvases</code>', '保存每张画布及其图片、PDF、Markdown 附件和批注。这里通常最占空间，也是最不能随便拆开删除的部分。'],
          ['<code>notes</code>', '保存笔记工作区的 <code>.md</code> 正文、任意层级文件夹和 <code>&lt;笔记名&gt;.assets</code> 图片。它是可直接备份的真实笔记库，不是缓存。'],
          ['<code>data</code>', '保存画布列表、分组收藏、学习任务、独立树状页、复习卡片、速记、日记、专注记录、背景和少量文件型设置。这里的 JSON 文件通常很小。'],
          ['本机偏好', '保存主题、工作区、视图、镜头、工具默认和运行中的专注计时等状态。它不在 <code>data</code> 文件夹中，删除后主要表现为界面重置。'],
        ]],
        ['真正容易占空间的地方', '如果只是想腾出磁盘空间，优先检查素材和回收站；不要为了几 KB 的 JSON 文件丢掉长期记录。', [
          ['<code>*.assets</code>', '画布使用的图片、PDF 和 Markdown 附件。先在对应画布里使用“清理附件”，只删没有被引用的素材。'],
          ['<code>回收站</code>', '已从起步页删除、但仍可恢复的画布和素材。确认不再需要后，用 Relatum 的回收站页面清空。'],
          ['<code>data/backgrounds</code>', '自己上传的全局背景图片。先换成内置背景，再删除不再使用的图片。'],
          ['归档与数据库', '学习归档、画布归档和 <code>review.db</code> 是历史记录，不是缓存；只有确定不再需要这些历史时才删除。'],
        ]],
        ['安全整理顺序', '建议按下面的顺序操作，出了问题也更容易恢复。', [
          ['1. 退出 Relatum', '避免程序正在保存时，文件被删掉、重建或只写入一半。'],
          ['2. 复制一份备份', '至少备份准备删除的文件；如果拿不准，直接备份整个 <code>canvases</code>、<code>notes</code> 和 <code>data</code>。'],
          ['3. 优先用应用内功能', '画布重命名、回收和清理附件，以及笔记重命名、移动与删除，尽量在 Relatum 内完成。'],
          ['4. 再手动删除', '只删除已经确认用途的条目。删除后重新打开 Relatum，检查画布、附件和记录是否正常。'],
        ]],
        ['一个重要区别', '“文件会重新出现”不等于“数据会恢复”。很多文件缺失后，Relatum 会创建一份新的空文件或使用默认设置；原来的内容仍然已经丢失。'],
      ],
    },
    {
      id: 'canvases', eyebrow: '02 · CONTENT', title: 'canvases 与 notes：作品正文',
      subtitle: '<code>canvases</code> 保存画布，<code>notes</code> 保存普通 Markdown 笔记库；两者都是用户正文。',
      sections: [
        ['顶层会看到什么', '每张画布至少有一个 <code>.canvas</code> 文件；使用过图片或附件时，还会出现同名的 <code>.assets</code> 文件夹。', [
          ['<code>名称.canvas</code>', '画布本体，包含节点、文字、连线、手写、表格、计时器、镜头册、任务簿和笔记坞等内容。删除后，这张画布本身就丢失；起步页可能暂时留下一个打不开的登记项。'],
          ['<code>名称.assets</code>', '这张画布的素材目录。删除后画布文字和节点仍可能打开，但图片、PDF、Markdown 附件及部分批注会显示缺失。'],
          ['<code>回收站</code>', '从 Relatum 删除的画布和同名素材会先移到这里。删除其中内容或清空文件夹后，将无法再从应用内恢复。'],
        ]],
        ['<code>.assets</code> 里面的文件', '素材目录内部的文件常常比画布 JSON 大得多，但不能仅凭文件名判断是否无用。', [
          ['图片与背景素材', '删除后，对应图片节点或旧画布背景会缺图；画布结构和文字仍保留。'],
          ['<code>attachments</code>', '保存插入画布的 PDF、Markdown 等附件副本。删除某个附件后，对应附件节点还在，但正文无法读取。'],
          ['<code>*.annot.json</code>', '某个 PDF 或 Markdown 附件旁的批注。只删它会清除该附件的高光、下划线、手写和便签，不会删除附件原文。'],
          ['<code>node-annotations.json</code>', '保存画布正文阅读器里的手写与空间批注。删除后只丢这些批注，节点正文仍在。'],
        ]],
        ['不要拆散同名的一对', '例如 <code>课程.canvas</code> 应与 <code>课程.assets</code> 保持同名。手动只改其中一个名字，会让画布找不到素材；手动把画布移出目录，也可能让起步页登记失效。请优先使用 Relatum 的重命名、导入和回收站功能。'],
        ['想腾空间时怎么做', '先打开目标画布，在顶部使用“清理附件”，它会按实际引用删除孤儿素材。仍需继续清理时，再检查回收站和已经确认不需要的整张画布；不要随意逐个删除素材文件。'],
        ['<code>notes</code> 笔记库', '每篇笔记是普通 <code>.md</code> 文件，可在文件树右键选择“在系统资源管理器中显示”后复制进来，也可从 Explorer 直接拖入。粘贴图片保存在同层 <code>&lt;笔记名&gt;.assets/images</code> 中，会随应用内重命名、移动或移入 Windows 系统回收站。手工改动后回到 Relatum 即会静默同步，也可点击刷新。'],
      ],
    },
    {
      id: 'data', eyebrow: '03 · DATA', title: 'data：记录、设置和索引',
      subtitle: '这些文件大多不占多少空间，却决定起步页如何组织画布，以及树状、学习、日历、复习和专注页能看到哪些长期记录。界面偏好另见“本机偏好”。',
      sections: [
        ['画布列表与显示设置', '删除设置文件通常不会删除画布本体，但会让界面恢复默认或失去整理信息。', [
          ['<code>recent.json</code>', '保存最近画布、分组、收藏和排序。删除后 <code>.canvas</code> 文件仍在，但起步页列表会变空，分组、收藏和顺序丢失；之后可手动扫描重新登记顶层画布。'],
          ['<code>recent.backup.json</code>', '最近列表的上一份有效快照。删除后界面暂时不变，但失去损坏时的自动恢复来源；它不是手动删除 <code>recent.json</code> 后的自动还原按钮。'],
          ['<code>recent.corrupt-*.json</code>', '曾损坏而被隔离的旧列表。确认当前列表正常且不需要人工找回旧分组后可以删除。'],
          ['<code>background.json</code>', '全局背景和辅助底纹设置。删除后恢复出厂背景；上传的图片文件可能仍留在 <code>backgrounds</code> 中。'],
          ['<code>backgrounds</code>', '自己上传的背景图片。删除正在使用的图片会使背景缺失；先切换到内置背景，再清理不用的图片。'],
          ['<code>viewport.json</code>', '各画布上次的视野位置和缩放。删除后画布内容不受影响，只会丢失上次观看位置。'],
          ['<code>window-state.json</code>', '桌面窗口的大小、位置和最大化状态。删除后窗口恢复默认，不影响任何内容。'],
          ['<code>note-recovery</code>', '笔记的本地恢复快照；外部改写与正在输入的内容碰撞、或恢复历史前会强制保留一份。普通快照最短间隔 5 分钟，保留 7 天。'],
        ]],
        ['树状页、学习、每日任务与活动足迹', '下面这些都是长期记录，不属于缓存。', [
          ['<code>tree-page.json</code>', '独立树状页的任务、阶段、连接、外观和当前树。它与学习页的目标树完全分开；删除后树状页会从空白重新开始，不影响 <code>study.json</code>、画布或学习页，也不能从学习页自动恢复。'],
          ['<code>study.json</code>', '当前学习任务、任务回收站、进度和多棵目标树。删除后这些当前数据全部重置；已经归档的历史仍单独留在“学习归档”。'],
          ['<code>学习归档</code>', '已完成学习任务、归档速记和任务簿完成副本。删除后对应历史、活跃统计和星图回顾会减少或消失，当前未完成任务不受影响。'],
          ['<code>画布归档</code>', '画布归档动作留下的轻量历史记录。删除后原画布通常仍在，但活跃页里的归档足迹和统计会减少。'],
          ['<code>daily.json</code>', '每日任务、累计打卡天数、分钟和里程碑。删除后每日任务系统从空白开始。'],
          ['<code>daily.backup.json</code>', '每日任务的上一份有效快照。删除后当前内容不变，但损坏时少一层恢复保障。'],
          ['<code>daily.corrupt-*.json</code>', '损坏后隔离的旧每日任务。确认当前每日任务正常且不需要人工抢救旧数据后可以删除。'],
          ['<code>canvas-activity.json</code>', '画布创建、修改和前台使用时长账本。删除后画布仍在，但年度足迹、使用时长和相关活跃统计会丢失并从今重新记录。'],
          ['<code>start-page-activity.json</code>', '学习、树状和速记三页的前台使用时长账本。删除后页面内容不受影响，但活跃页中的绿色附加统计会清空并从今重新记录。'],
        ]],
        ['速记、日历、专注与复习', '删除哪一项，就会清空对应页面的数据。', [
          ['<code>notes.json</code>', '速记墙的便签、连线和视野。删除后当前速记墙清空；此前主动归档的速记仍在“学习归档”。'],
          ['<code>start-sticky-notes.json</code>', '起步页各页面上跨页显示的小便签。删除后这些便签全部消失，不影响速记墙。'],
          ['<code>focus.json</code>', '专注记录及相关状态。删除后日历和活跃页中的专注历史、累计时长会随之消失。'],
          ['<code>diary</code>', '日历日记，每天一份 Markdown。删除某一天的文件只丢当天日记；删除整个文件夹会丢全部日记。'],
          ['<code>countdown.json</code>', '倒数日事件和当前选择。删除后倒数日清空，可重新创建。'],
          ['<code>review.db</code>', '复习卡片、卡组、标签、复习计划和每次评分的完整数据库。删除后复习系统全部清空，不能从画布自动重建。'],
          ['<code>review.db-wal / -shm</code>', '数据库运行时可能出现的临时文件。不要单独删除；先正常退出 Relatum，它们通常会自动合并或消失。'],
          ['<code>career-report.json</code>', '“生涯”页最近一次手动生成的冻结统计快照。删除后只会清除报告，不会删除画布、笔记或其它原始记录；下次生成会重新读取当时可用的数据。'],
        ]],
        ['其它可能出现的文件', '这些项目不一定每台电脑都有。', [
          ['<code>templates.json</code>', '所有画布共用的节点模板库。删除后自建模板消失，现有画布不受影响。'],
          ['<code>ai.json</code>', 'AI 助手的 API Key、模型和接口地址。删除后需要重新配置；已有画布内容不受影响。该文件含密钥，备份或分享时注意保密。'],
          ['<code>calendar-pins.json</code>', '旧版本遗留的日历任务便签，当前版本已不再读取。确认不需要回旧版本查看后可以备份并删除。'],
        ]],
        ['不建议整包删除 <code>data</code>', '整包删除相当于重置 Relatum 除画布正文和画布素材之外的大部分状态：画布文件还在，但列表整理、学习、速记、复习、日记、专注、模板和设置会一起消失。'],
      ],
    },
    {
      id: 'storage', eyebrow: '04 · ON-DEVICE', title: '本机存储：偏好、视图与运行态',
      subtitle: '这些状态保存在 Relatum 的 WebView2 用户数据或浏览器的网站数据中，不在 <code>canvases</code>、<code>notes</code> 或 <code>data</code> 文件夹里。实际位置会随电脑、安装方式和浏览器而变。',
      sections: [
        ['起步页、语言与笔记工作区', '这一组主要记住你上次看到的界面，不代替真正的内容文件。', [
          ['主题与工作区', '<code>canvas:startTheme</code>、<code>canvas:startWorkspace:v1</code> 和 <code>canvas:toolbarLanguage</code> 等保存主题、上次工作区、界面语言、搜索与页面显示偏好。删除后恢复默认，不删画布或记录。'],
          ['笔记工作区', '<code>canvas:note*</code> 记住打开标签、当前笔记、文件夹展开状态、视图和字号。删除后工作区会重置，<code>.md</code> 正文和笔记图片仍在。'],
        ]],
        ['学习、树状、速记与复习', '这些页面的长期内容在 <code>data</code> 中，但一些“怎么看”只存在本机。', [
          ['视图与镜头', '<code>study:*</code>、<code>canvas:notesView</code>、<code>canvas:cadenceLens:v2</code>、<code>canvas:reviewMode:v1</code> 和 <code>relatum.*.view.&lt;树 ID&gt;</code> 记住页面、复习模式、镜头与折叠状态。删除后任务、树和便签仍在，但视图会回到默认。'],
          ['任务页颜色与图例', '<code>study:taskPageColors:v1</code> 和 <code>study:legend:v1</code> 只存在本机。删除后颜色恢复默认，不能从 <code>study.json</code> 自动恢复，只能重新设置。'],
        ]],
        ['画布编辑器', '模式、面板位置、工具参数、新建节点/连线的默认样式、自动保存和引导状态等以 <code>canvas:*</code> 偏好保存。删除后已有 <code>.canvas</code> 内容不会改变，但编辑器偏好与新建默认会重置，首次引导也可能再次出现。'],
        ['专注钟与当前会话', '两者都不应当作已完成的长期记录。', [
          ['<code>canvas:focus*</code>', '保存未完成计时的恢复状态、模式、时长、声音、噪音和任务绑定。删除后这些状态丢失；已写入 <code>data/focus.json</code> 的专注历史仍保留。'],
          ['<code>sessionStorage</code>', '只保存本次会话的桌面识别和返回路径标记。关闭会话或清除它，不会删除用户内容。'],
        ]],
        ['如果要整理这部分', '先退出 Relatum，不要逐个删除 WebView2 内部的数据库文件。清除整个应用或网站存储会重置所有本机偏好，但不会删除 <code>canvases</code>、<code>notes</code> 或 <code>data</code>。AI 助手的 API Key 另存在 <code>data/ai.json</code>，不属于浏览器存储。'],
      ],
    },
  ];

  const START_HELP_PAGES_EN = [
    {
      id: 'safety', eyebrow: '01 · BEFORE DELETING', title: 'Before deleting, read this',
      subtitle: 'Relatum stores canvases, notes, and long-term records in the <code>canvases</code>, <code>notes</code>, and <code>data</code> folders inside the user data directory. Interface preferences and some temporary runtime state live separately in on-device browser storage.',
      sections: [
        ['Three folders and one set of on-device preferences', 'The folders hold user content and long-term records; on-device preferences remember the interface and current-session state.', [
          ['<code>canvases</code>', 'Stores every canvas together with its images, PDFs, Markdown attachments, and annotations. This folder usually uses the most space and should not be split up or cleaned blindly.'],
          ['<code>notes</code>', 'Stores the Notes workspace as ordinary <code>.md</code> files, nested folders, and <code>&lt;note name&gt;.assets</code> images. It is your real, directly backupable notes library, not a cache.'],
          ['<code>data</code>', 'Stores the canvas library, groups and favorites, study tasks, the independent Tree page, review cards, quick notes, journals, focus history, backgrounds, and a small set of file-backed settings. Its JSON files are usually very small.'],
          ['On-device preferences', 'Stores themes, workspaces, views, cameras, tool defaults, and runtime state such as an unfinished focus timer. It is outside the <code>data</code> folder, and deleting it mainly resets the interface.'],
        ]],
        ['What actually uses disk space', 'If you only want to free disk space, inspect assets and Trash first. Do not sacrifice long-term records to save a few KB of JSON.', [
          ['<code>*.assets</code>', 'Images, PDFs, and Markdown attachments used by a canvas. Use “Clean attachments” inside that canvas first so only unreferenced files are removed.'],
          ['<code>Trash</code>', 'Canvases and assets removed from Home but still recoverable. Once you are sure, empty them from Relatum’s Trash page.'],
          ['<code>data/backgrounds</code>', 'Global background images you uploaded. Switch to a built-in background before deleting images you no longer use.'],
          ['Archives and databases', 'Study archives, canvas archives, and <code>review.db</code> are history, not cache. Delete them only when you no longer need that history.'],
        ]],
        ['A safer cleanup order', 'Follow this order so a mistake is easier to recover from.', [
          ['1. Quit Relatum', 'This prevents files from being deleted, recreated, or only partly written while the app is saving.'],
          ['2. Make a backup', 'Back up at least the items you plan to delete. If you are unsure, copy the entire <code>canvases</code>, <code>notes</code>, and <code>data</code> folders.'],
          ['3. Prefer in-app actions', 'Use Relatum for canvas renaming, Trash, and asset cleanup, and for note renaming, moving, and deletion whenever possible.'],
          ['4. Delete manually only after that', 'Delete only items whose purpose you have confirmed. Reopen Relatum afterward and check canvases, attachments, and records.'],
        ]],
        ['One important distinction', 'A file being recreated does not mean its data was recovered. When a file is missing, Relatum may create a new empty file or use defaults; the original content is still gone.'],
      ],
    },
    {
      id: 'canvases', eyebrow: '02 · CONTENT', title: 'canvases and notes: your content',
      subtitle: '<code>canvases</code> stores canvases and <code>notes</code> is an ordinary Markdown library. Both folders contain user-authored content.',
      sections: [
        ['What appears at the top level', 'Every canvas has a <code>.canvas</code> file. If it uses images or attachments, it also has a matching <code>.assets</code> folder.', [
          ['<code>Name.canvas</code>', 'The canvas itself: nodes, text, edges, ink, tables, timers, scenes, taskbooks, notebooks, and more. Deleting it loses that canvas; Home may temporarily keep an entry that can no longer open.'],
          ['<code>Name.assets</code>', 'The asset folder for that canvas. If deleted, text and nodes may still open, but images, PDFs, Markdown attachments, and some annotations will be missing.'],
          ['<code>Trash</code>', 'Canvases deleted in Relatum, with matching assets, are moved here first. Deleting its contents or emptying the folder prevents recovery from inside the app.'],
        ]],
        ['Files inside <code>.assets</code>', 'These files are often much larger than the canvas JSON, but a filename alone cannot tell you whether a file is unused.', [
          ['Images and background assets', 'Deleting one makes the matching image node or an older canvas background go missing; the canvas structure and text remain.'],
          ['<code>attachments</code>', 'Copies of PDFs, Markdown, and other attachments inserted into the canvas. If one is deleted, its node remains but its content cannot be read.'],
          ['<code>*.annot.json</code>', 'Annotations beside a PDF or Markdown attachment. Deleting only this file removes that attachment’s highlights, underlines, ink, and notes, but not its source content.'],
          ['<code>node-annotations.json</code>', 'Ink and spatial annotations made in the canvas text reader. Deleting it removes only those annotations; node text remains.'],
        ]],
        ['Keep matching names together', 'For example, <code>Course.canvas</code> must stay paired with <code>Course.assets</code>. Renaming only one breaks asset links, and moving a canvas out manually can invalidate its Home entry. Prefer Relatum’s rename, import, and Trash actions.'],
        ['How to free space', 'Open the target canvas and use “Clean attachments” from the top bar; it removes orphaned assets according to actual references. If you still need space, inspect Trash and entire canvases you no longer need. Do not delete asset files one by one at random.'],
        ['The <code>notes</code> library', 'Each note is an ordinary <code>.md</code> file. Right-click it and choose “Show in File Explorer”, or drag files and folders directly from Explorer. Pasted images live under <code>&lt;note name&gt;.assets/images</code>; Relatum moves that folder with the note and sends both to the Windows Recycle Bin together. Returning to Relatum after a manual file change silently refreshes it.'],
      ],
    },
    {
      id: 'data', eyebrow: '03 · DATA', title: 'data: records, settings, and indexes',
      subtitle: 'Most of these files use little space, but they determine how Home organizes canvases and which long-term records appear in Tree, Study, Calendar, Review, and Focus. See On-device preferences for interface settings.',
      sections: [
        ['Canvas library and display settings', 'Deleting a settings file usually leaves the canvas itself intact, but resets the interface or removes organization data.', [
          ['<code>recent.json</code>', 'Recent canvases, groups, favorites, and ordering. The <code>.canvas</code> files remain after deletion, but Home becomes empty and organization is lost; you can later scan the top-level canvases folder to register files again.'],
          ['<code>recent.backup.json</code>', 'The previous valid library snapshot. Deleting it changes nothing immediately, but removes an automatic recovery source if the library becomes corrupt. It is not an undo button for manually deleting <code>recent.json</code>.'],
          ['<code>recent.corrupt-*.json</code>', 'Old library files quarantined after corruption. They can be deleted after you confirm the current library is healthy and you do not need to recover old groups manually.'],
          ['<code>background.json</code>', 'Global background and guide-pattern settings. Deleting it restores factory defaults; uploaded image files may remain in <code>backgrounds</code>.'],
          ['<code>backgrounds</code>', 'Background images you uploaded. Deleting an image still in use makes the background disappear; switch to a built-in background first.'],
          ['<code>viewport.json</code>', 'The last position and zoom for each canvas. Deleting it does not affect content, only the last viewing position.'],
          ['<code>window-state.json</code>', 'Desktop window size, position, and maximized state. Deleting it restores the default window without affecting content.'],
          ['<code>note-recovery</code>', 'Local note recovery snapshots. Relatum forces one before an external edit collides with active typing and before restoring history. Ordinary snapshots are at least five minutes apart and are kept for seven days.'],
        ]],
        ['Tree, Study, daily tasks, and activity', 'These are long-term records, not cache files.', [
          ['<code>tree-page.json</code>', 'Tasks, stages, links, appearance, and the active tree for the independent Tree page. It is completely separate from Study Goal Trees. Deleting it starts Tree from blank without affecting <code>study.json</code>, canvases, or Study, and it cannot be rebuilt automatically from Study.'],
          ['<code>study.json</code>', 'Current study tasks, task Trash, progress, and Goal Trees. Deleting it resets all current study data; previously archived history remains separately in the Study archive.'],
          ['<code>Study archive</code>', 'Completed study tasks, archived quick notes, and completed taskbook snapshots. Deleting it removes that history and reduces or removes related activity statistics and constellation history; current active tasks remain.'],
          ['<code>Canvas archive</code>', 'Lightweight history created by canvas archive actions. Deleting it usually leaves original canvases intact, but removes related archive events and statistics from Activity.'],
          ['<code>daily.json</code>', 'Daily tasks, streak days, minutes, and milestones. Deleting it starts the daily-task system from empty.'],
          ['<code>daily.backup.json</code>', 'The previous valid daily-task snapshot. Deleting it leaves current content unchanged but removes one recovery layer.'],
          ['<code>daily.corrupt-*.json</code>', 'Old daily-task data quarantined after corruption. Delete it only after confirming current data is healthy and no manual recovery is needed.'],
          ['<code>canvas-activity.json</code>', 'Canvas creation, editing, and foreground-usage history. Deleting it leaves canvases intact, but removes yearly activity, usage time, and related statistics; recording then starts over.'],
          ['<code>start-page-activity.json</code>', 'Foreground-usage history for Study, Tree, and Quick Notes. Deleting it leaves page content intact, but clears the green add-on statistics in Activity and starts recording over.'],
        ]],
        ['Quick notes, Calendar, Focus, and Review', 'Deleting an item clears the data for its corresponding page.', [
          ['<code>notes.json</code>', 'Quick Notes cards, connections, and viewport. Deleting it clears the current wall; notes you explicitly archived remain in the Study archive.'],
          ['<code>start-sticky-notes.json</code>', 'Small sticky notes shown across Home pages. Deleting it removes all of them without affecting Quick Notes.'],
          ['<code>focus.json</code>', 'Focus sessions and related state. Deleting it removes focus history and accumulated time from Calendar and Activity.'],
          ['<code>diary</code>', 'Calendar journals, one Markdown file per day. Deleting one file loses only that day; deleting the folder loses every journal entry.'],
          ['<code>countdown.json</code>', 'Countdown events and the selected event. Deleting it clears Countdown; events can be created again.'],
          ['<code>review.db</code>', 'The complete database of review cards, decks, tags, schedules, and every rating. Deleting it empties Review and it cannot be rebuilt automatically from canvases.'],
          ['<code>review.db-wal / -shm</code>', 'Temporary files that may appear while the database is in use. Do not delete them separately; quit Relatum normally and they will usually merge or disappear.'],
          ['<code>career-report.json</code>', 'The frozen snapshot from the most recent manual Career report generation. Deleting it removes only the report, not canvases, notes, or source records; generating again reads the data available at that time.'],
        ]],
        ['Other files you may see', 'Not every computer will have all of these.', [
          ['<code>templates.json</code>', 'The node template library shared by all canvases. Deleting it removes custom templates without changing existing canvases.'],
          ['<code>ai.json</code>', 'The AI assistant API key, model, and endpoint. Deleting it requires configuration again but does not affect canvas content. It contains a secret, so keep backups and shared copies private.'],
          ['<code>calendar-pins.json</code>', 'Calendar task notes left by older versions and no longer read by the current version. Back it up before deleting if you may return to an older version.'],
        ]],
        ['Do not delete the whole <code>data</code> folder', 'Deleting it resets almost everything except canvas bodies and their assets: the files still exist, but library organization, Study, Quick Notes, Review, journals, Focus, templates, and settings disappear together.'],
      ],
    },
    {
      id: 'storage', eyebrow: '04 · ON-DEVICE', title: 'On-device storage: preferences, views, and runtime state',
      subtitle: 'This state lives in Relatum’s WebView2 user data or in the browser’s site data, outside the <code>canvases</code>, <code>notes</code>, and <code>data</code> folders. Its actual location varies by computer, installation method, and browser.',
      sections: [
        ['Home, language, and the Notes workspace', 'These settings mainly remember the interface you last saw; they do not replace the real content files.', [
          ['Theme and workspace', '<code>canvas:startTheme</code>, <code>canvas:startWorkspace:v1</code>, <code>canvas:toolbarLanguage</code>, and related keys store the theme, last workspace, interface language, search, and page-display preferences. Deleting them restores defaults without deleting canvases or records.'],
          ['Notes workspace', '<code>canvas:note*</code> remembers open tabs, the current note, expanded folders, the view, and text size. Deleting it resets the workspace, while <code>.md</code> files and note images remain.'],
        ]],
        ['Study, Tree, Quick Notes, and Review', 'Long-term content for these pages lives in <code>data</code>, but some details about how it is viewed exist only on this device.', [
          ['Views and cameras', '<code>study:*</code>, <code>canvas:notesView</code>, <code>canvas:cadenceLens:v2</code>, <code>canvas:reviewMode:v1</code>, and <code>relatum.*.view.&lt;tree ID&gt;</code> remember pages, review mode, cameras, and collapsed branches. Tasks, trees, and notes remain after deletion, but their views return to defaults.'],
          ['Task-page colors and legend', '<code>study:taskPageColors:v1</code> and <code>study:legend:v1</code> exist only on this device. Deleting them restores default colors; they cannot be recovered automatically from <code>study.json</code> and must be set again.'],
        ]],
        ['Canvas editor', 'Modes, panel positions, tool parameters, default styles for new nodes and edges, autosave, and onboarding state are stored as <code>canvas:*</code> preferences. Deleting them does not change existing <code>.canvas</code> content, but editor preferences and creation defaults reset, and onboarding may appear again.'],
        ['Focus and the current session', 'Neither should be confused with completed long-term records.', [
          ['<code>canvas:focus*</code>', 'Stores recovery state for an unfinished timer, mode, durations, sound, noise, and task binding. Deleting it loses those settings and the unfinished timer state; completed history already written to <code>data/focus.json</code> remains.'],
          ['<code>sessionStorage</code>', 'Stores only current-session desktop detection and return-route markers. Closing the session or clearing it does not delete user content.'],
        ]],
        ['If you need to manage this storage', 'Quit Relatum first, and do not delete individual database files inside WebView2 user data. Clearing all app or site storage resets every on-device preference but does not delete <code>canvases</code>, <code>notes</code>, or <code>data</code>. The AI assistant API key lives separately in <code>data/ai.json</code>, not in browser storage.'],
      ],
    },
  ];

  function startHelpPages() {
    return englishUI() ? START_HELP_PAGES_EN : START_HELP_PAGES_ZH;
  }
  let startHelpPageIndex = 0;
  let startHelpFlipping = false;
  let startHelpDemoObserver = null;

  // 让指引面板里「滚出视野」的小演示暂停动画（省电 + 安静）。每次换页重渲染后重挂。
  function observeStartHelpDemos() {
    if (!startHelp || typeof IntersectionObserver !== 'function') return;
    const book = startHelp.querySelector('.start-help-book');
    const copy = startHelp.querySelector('[data-role="start-help-page-copy"]');
    if (!book || !copy) return;
    if (startHelpDemoObserver) startHelpDemoObserver.disconnect();
    const demos = copy.querySelectorAll('.start-help-demo');
    if (!demos.length) { startHelpDemoObserver = null; return; }
    startHelpDemoObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle('demo-paused', !entry.isIntersecting);
      });
    }, { root: book, threshold: 0.01 });
    demos.forEach((demo) => startHelpDemoObserver.observe(demo));
  }
  let startHelpWheelAccum = 0;
  let startHelpWheelResetTimer = null;
  let startHelpNavReady = false;
  let startHelpScrollVelocity = 0;
  let startHelpScrollFrame = 0;
  let startHelpScrollLastAt = 0;
  let startHelpCloseTimer = 0;

  function syncStartHelpNav(index, animate) {
    if (!startHelp) return;
    const item = startHelpPages()[index];
    const nav = startHelp.querySelector('.start-help-nav');
    const slider = startHelp.querySelector('[data-role="start-help-nav-slider"]');
    const spine = startHelp.querySelector('.start-help-spine');
    const spineSlider = startHelp.querySelector('[data-role="start-help-spine-slider"]');
    if (!item || !nav || !slider || !spine || !spineSlider) return;
    let active = null;
    let activeSpine = null;
    startHelp.querySelectorAll('[data-help-page]').forEach((button) => {
      const selected = button.dataset.helpPage === item.id;
      button.classList.toggle('active', selected);
      if (selected && button.closest('.start-help-nav')) active = button;
      if (selected && button.closest('.start-help-spine')) activeSpine = button;
    });
    if (!active || !activeSpine) return;
    if (!animate || !startHelpNavReady) {
      slider.classList.add('no-transition');
      spineSlider.classList.add('no-transition');
    }
    slider.style.width = active.offsetWidth + 'px';
    slider.style.height = active.offsetHeight + 'px';
    slider.style.transform = 'translate3d(' + active.offsetLeft + 'px,' + active.offsetTop + 'px,0)';
    slider.classList.add('show');
    spineSlider.style.transform = 'translate3d(0,'
      + (activeSpine.offsetTop + (activeSpine.offsetHeight - spineSlider.offsetHeight) / 2) + 'px,0)';
    spineSlider.classList.add('show');
    if (!animate || !startHelpNavReady) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          slider.classList.remove('no-transition');
          spineSlider.classList.remove('no-transition');
        });
      });
    }
    startHelpNavReady = true;
  }

  function stopStartHelpInertia() {
    startHelpScrollVelocity = 0;
    if (startHelpScrollFrame) cancelAnimationFrame(startHelpScrollFrame);
    startHelpScrollFrame = 0;
    startHelpScrollLastAt = 0;
  }

  function startHelpInertiaStep(now) {
    const book = startHelp && startHelp.querySelector('.start-help-book');
    if (!book || Math.abs(startHelpScrollVelocity) < 0.06) {
      stopStartHelpInertia();
      return;
    }
    const dt = startHelpScrollLastAt
      ? Math.max(0.45, Math.min(2.4, (now - startHelpScrollLastAt) / 16.667))
      : 1;
    startHelpScrollLastAt = now;
    const before = book.scrollTop;
    book.scrollTop += startHelpScrollVelocity * dt;
    if (book.scrollTop === before) {
      stopStartHelpInertia();
      return;
    }
    startHelpScrollVelocity *= Math.pow(0.9, dt);
    startHelpScrollFrame = requestAnimationFrame(startHelpInertiaStep);
  }

  function renderStartHelpPage(index, direction) {
    if (!startHelp) return;
    const pages = startHelpPages();
    const page = startHelp.querySelector('[data-role="start-help-page"]');
    const copy = startHelp.querySelector('[data-role="start-help-page-copy"]');
    const position = startHelp.querySelector('[data-role="start-help-position"]');
    const book = startHelp.querySelector('.start-help-book');
    const item = pages[index];
    if (!page || !copy || !item) return;
    const apply = () => {
      copy.innerHTML = '<div class="start-help-page-intro"><p>' + item.eyebrow + '</p><h3>' + item.title
        + '</h3>' + (item.subtitle ? '<span>' + item.subtitle + '</span>' : '') + '</div>'
        + item.sections.map((section) => '<section class="start-help-section"><h4>' + section[0] + '</h4><p>'
          + section[1] + '</p>' + (section[2] ? '<dl class="start-help-list">'
            + section[2].map((row) => '<div><dt>' + row[0] + '</dt><dd>' + row[1] + '</dd></div>').join('')
            + '</dl>' : '') + '</section>').join('');
      if (position) position.textContent = String(index + 1).padStart(2, '0') + ' / '
        + String(pages.length).padStart(2, '0');
      if (book) {
        stopStartHelpInertia();
        book.scrollTop = 0;
      }
      observeStartHelpDemos();
    };
    syncStartHelpNav(index, !!direction);
    if (!direction || prefersReduced || typeof page.animate !== 'function') { apply(); return; }
    startHelpFlipping = true;
    const outgoingX = direction > 0 ? -32 : 32;
    const incomingX = -outgoingX;
    const easing = 'cubic-bezier(0.16, 1, 0.3, 1)';   // 与整页丝滑横滑同一缓动
    const outgoing = page.animate([
      { opacity: 1, transform: 'translate3d(0,0,0)' },
      { opacity: 0, transform: 'translate3d(' + outgoingX + 'px,0,0)' },
    ], { duration: 150, easing, fill: 'forwards' });
    outgoing.finished.catch(() => {}).then(() => {
      apply();
      outgoing.cancel();
      const incoming = page.animate([
        { opacity: 0, transform: 'translate3d(' + incomingX + 'px,0,0)' },
        { opacity: 1, transform: 'translate3d(0,0,0)' },
      ], { duration: 320, easing, fill: 'both' });
      incoming.finished.catch(() => {}).then(() => {
        incoming.cancel();
        startHelpFlipping = false;
      });
    });
  }

  function gotoStartHelpPage(index) {
    if (startHelpFlipping || index === startHelpPageIndex) return;
    const total = startHelpPages().length;
    const next = ((index % total) + total) % total;
    if (next === startHelpPageIndex) return;
    const direction = index > startHelpPageIndex ? 1 : -1;
    startHelpPageIndex = next;
    renderStartHelpPage(startHelpPageIndex, direction);
  }

  // B1：help 浮层进场期只挂 blur(0)（纯 transform 动画最轻），进场动画 start-help-enter 结束后
  // 加 .help-ready 让毛玻璃 transition 到满值，避免「重模糊 + 位移」同帧硬碰。reduced-motion 下
  // 动画被禁用、animationend 不触发 → CSS 直接给满 blur；setTimeout 仅作动画被打断时的兜底。
  function armStartHelpBlur() {
    if (!startHelp) return;
    const panel = startHelp.querySelector('.start-help-panel');
    if (!panel) return;
    panel.classList.remove('help-ready');
    if (panel.__blurEnd) { panel.removeEventListener('animationend', panel.__blurEnd); panel.__blurEnd = null; }
    if (panel.__blurTimer) { clearTimeout(panel.__blurTimer); panel.__blurTimer = null; }
    const reveal = function () {
      if (panel.__blurEnd) { panel.removeEventListener('animationend', panel.__blurEnd); panel.__blurEnd = null; }
      if (panel.__blurTimer) { clearTimeout(panel.__blurTimer); panel.__blurTimer = null; }
      panel.classList.add('help-ready');
    };
    const onEnd = function (e) { if (e.animationName === 'start-help-enter') reveal(); };
    panel.__blurEnd = onEnd;
    panel.addEventListener('animationend', onEnd);
    panel.__blurTimer = setTimeout(reveal, 520);
  }

  function finishStartHelpClose() {
    if (!startHelp) return;
    if (startHelpCloseTimer) clearTimeout(startHelpCloseTimer);
    startHelpCloseTimer = 0;
    startHelp.classList.remove('is-closing');
    startHelp.hidden = true;
    document.body.classList.remove('start-help-open');
    if (startHelpTrigger) startHelpTrigger.focus({ preventScroll: true });
  }

  function setStartHelpOpen(open) {
    if (!startHelp) return;
    if (open) {
      if (startHelpCloseTimer) clearTimeout(startHelpCloseTimer);
      startHelpCloseTimer = 0;
      startHelp.classList.remove('is-closing');
      startHelp.hidden = false;
      if (startHelpTrigger) startHelpTrigger.setAttribute('aria-expanded', 'true');
      document.body.classList.add('start-help-open');
      closeContextMenu();
      startHelpNavReady = false;
      renderStartHelpPage(startHelpPageIndex);
      armStartHelpBlur();
      const close = startHelp.querySelector('[data-action="start-help-close"]');
      if (close) close.focus();
    } else {
      if (startHelp.hidden || startHelp.classList.contains('is-closing')) return;
      if (startHelpTrigger) startHelpTrigger.setAttribute('aria-expanded', 'false');
      stopStartHelpInertia();
      if (startHelpDemoObserver) { startHelpDemoObserver.disconnect(); startHelpDemoObserver = null; }
      if (prefersReduced) {
        finishStartHelpClose();
        return;
      }
      startHelp.classList.add('is-closing');
      startHelpCloseTimer = window.setTimeout(finishStartHelpClose, 260);
    }
  }

  window.CanvasStartHelp = {
    open(pageId) {
      const index = startHelpPages().findIndex((item) => item.id === pageId);
      if (index >= 0) startHelpPageIndex = index;
      setStartHelpOpen(true);
    },
  };

  const START_HELP_SEEN_KEY = 'canvas:dataGuideClicked:v1';

  function markStartHelpSeen() {
    try { localStorage.setItem(START_HELP_SEEN_KEY, '1'); } catch (e) {}
    if (startHelpTrigger) startHelpTrigger.classList.remove('has-unread');
  }

  if (startHelpTrigger) {
    startHelpTrigger.addEventListener('click', () => {
      markStartHelpSeen();
      setStartHelpOpen(true);
    });
  }
  if (startHelp) {
    startHelp.querySelectorAll('[data-action="start-help-close"]').forEach((button) => {
      button.addEventListener('click', () => setStartHelpOpen(false));
    });
    startHelp.querySelectorAll('[data-help-page]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = startHelpPages().findIndex((item) => item.id === button.dataset.helpPage);
        if (index >= 0) gotoStartHelpPage(index);
      });
    });
    const prev = startHelp.querySelector('[data-action="start-help-prev"]');
    const next = startHelp.querySelector('[data-action="start-help-next"]');
    if (prev) prev.addEventListener('click', () => gotoStartHelpPage(startHelpPageIndex - 1));
    if (next) next.addEventListener('click', () => gotoStartHelpPage(startHelpPageIndex + 1));
    const queueStartHelpPageWheel = (event) => {
      event.preventDefault();
      if (startHelpFlipping) return;
      startHelpWheelAccum += event.deltaY;
      clearTimeout(startHelpWheelResetTimer);
      startHelpWheelResetTimer = window.setTimeout(() => { startHelpWheelAccum = 0; }, 200);
      if (Math.abs(startHelpWheelAccum) < 24) return;
      const direction = startHelpWheelAccum > 0 ? 1 : -1;
      startHelpWheelAccum = 0;
      gotoStartHelpPage(startHelpPageIndex + direction);
    };
    const helpSpine = startHelp.querySelector('.start-help-spine');
    if (helpSpine) helpSpine.addEventListener('wheel', queueStartHelpPageWheel, { passive: false });
    const helpBook = startHelp.querySelector('.start-help-book');
    if (helpBook) helpBook.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      const bounds = helpBook.getBoundingClientRect();
      // 把正文滚动区左侧的一条宽带也划给翻页：桌面约 88px，窄窗口约 64px。
      // 书脊圆点仍留在原位，不扩大 DOM 遮罩，避免挡住顶部目录按钮。
      const pageTurnZone = Math.min(88, Math.max(64, helpBook.clientWidth * 0.1));
      if (event.clientX - bounds.left <= pageTurnZone) {
        queueStartHelpPageWheel(event);
        return;
      }
      if (prefersReduced) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? helpBook.clientHeight : 1);
      startHelpScrollVelocity += event.deltaY * unit * 0.2;
      startHelpScrollVelocity = Math.max(-44, Math.min(44, startHelpScrollVelocity));
      if (!startHelpScrollFrame) startHelpScrollFrame = requestAnimationFrame(startHelpInertiaStep);
    }, { passive: false });
    window.addEventListener('resize', () => syncStartHelpNav(startHelpPageIndex, false));
  }

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT' || target.isContentEditable);
    if (startHelp && !startHelp.hidden) {
      if (event.key === 'Escape' || (!typing && event.key === '?')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setStartHelpOpen(false);
      } else if (!typing && event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        gotoStartHelpPage(startHelpPageIndex - 1);
      } else if (!typing && event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        gotoStartHelpPage(startHelpPageIndex + 1);
      }
      return;
    }
    if (!typing && event.key === '?') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setStartHelpOpen(true);
    }
  }, true);

  function closeStartNotice() {
    if (startNotice) startNotice.hidden = true;
  }

  function showStartNotice(message) {
    if (!startNotice) {
      window.alert(message);
      return;
    }
    const detail = startNotice.querySelector('[data-role="start-notice-detail"]');
    if (detail) detail.textContent = message || '重命名失败';
    startNotice.hidden = false;
  }

  if (startNotice) {
    const closeBtn = startNotice.querySelector('[data-action="close-start-notice"]');
    if (closeBtn) closeBtn.addEventListener('click', closeStartNotice);
    startNotice.addEventListener('mousedown', (event) => {
      if (event.target === startNotice) closeStartNotice();
    });
    document.addEventListener('keydown', (event) => {
      if (!startNotice.hidden && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeStartNotice();
      }
    });
  }

  const desktopSettings = document.querySelector('[data-role="desktop-settings"]');
  const desktopSettingsOpen = document.querySelector('[data-action="desktop-settings-open"]');
  const noteFontScaleRange = document.querySelector('[data-role="note-font-scale"]');
  const noteFontScaleValue = document.querySelector('[data-role="note-font-scale-value"]');
  const desktopSizeForm = document.querySelector('[data-role="desktop-size-form"]');
  const desktopSizeHint = document.querySelector('[data-role="desktop-size-hint"]');
  const desktopPresetButtons = Array.from(document.querySelectorAll('[data-role="desktop-size-presets"] button'));
  const starmapMotionRanges = Array.from(document.querySelectorAll('[data-role="starmap-motion-range"]'));
  const starmapMotionToggles = Array.from(document.querySelectorAll('[data-role="starmap-motion-toggle"]'));
  const starmapMotionResets = Array.from(document.querySelectorAll('[data-action="starmap-motion-reset"]'));
  const starmapMotionValues = Array.from(document.querySelectorAll('[data-role="starmap-motion-value"]'));
  const STARMAP_MOTION_KEY = 'canvas:starmapMotion:v1';
  const NOTE_FONT_SCALE_KEY = 'canvas:noteFontScale:v1';
  const STARMAP_MOTION_DEFAULTS = Object.freeze({
    introMs: 1080,
    introStagger: 60,
    alphaReheat: 0.20,
    velocityDamp: 0.88,
    introVelocityClamp: 10,
    finalFitOnConverge: false,
  });
  let starmapMotionNotifyTimer = 0;

  function readNoteFontScale() {
    let value = 100;
    try { value = Number(localStorage.getItem(NOTE_FONT_SCALE_KEY) || 100); } catch (e) {}
    return Math.max(80, Math.min(140, Math.round(value / 5) * 5 || 100));
  }

  function applyNoteFontScale(value, persist) {
    const scale = Math.max(80, Math.min(140, Math.round(Number(value) / 5) * 5 || 100));
    document.documentElement.style.setProperty('--note-font-scale', String(scale / 100));
    if (noteFontScaleRange) noteFontScaleRange.value = String(scale);
    if (noteFontScaleValue) noteFontScaleValue.textContent = scale + '%';
    if (persist) {
      try { localStorage.setItem(NOTE_FONT_SCALE_KEY, String(scale)); } catch (e) {}
    }
    return scale;
  }

  function readStarmapMotionSettings() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STARMAP_MOTION_KEY) || 'null'); } catch (e) {}
    const next = Object.assign({}, STARMAP_MOTION_DEFAULTS, raw || {});
    next.introMs = Math.max(240, Math.min(1800, Number(next.introMs) || STARMAP_MOTION_DEFAULTS.introMs));
    next.introStagger = Math.max(0, Math.min(60, Number(next.introStagger) || STARMAP_MOTION_DEFAULTS.introStagger));
    next.alphaReheat = Math.max(0.05, Math.min(0.60, Number(next.alphaReheat) || STARMAP_MOTION_DEFAULTS.alphaReheat));
    next.velocityDamp = Math.max(0.60, Math.min(0.98, Number(next.velocityDamp) || STARMAP_MOTION_DEFAULTS.velocityDamp));
    next.introVelocityClamp = Math.max(2, Math.min(60, Number(next.introVelocityClamp) || STARMAP_MOTION_DEFAULTS.introVelocityClamp));
    next.finalFitOnConverge = !!next.finalFitOnConverge;
    return next;
  }

  function starmapMotionLabel(key, value) {
    if (key === 'introMs' || key === 'introStagger') return Math.round(value) + 'ms';
    if (key === 'alphaReheat' || key === 'velocityDamp') return Number(value).toFixed(2);
    return String(Math.round(value));
  }

  function syncStarmapMotionForm(settings) {
    const s = settings || readStarmapMotionSettings();
    starmapMotionRanges.forEach((input) => {
      const key = input.dataset.setting;
      if (key && s[key] != null) input.value = String(s[key]);
    });
    starmapMotionValues.forEach((out) => {
      const key = out.dataset.setting;
      if (key && s[key] != null) out.textContent = starmapMotionLabel(key, s[key]);
    });
    starmapMotionToggles.forEach((input) => { input.checked = !!s.finalFitOnConverge; });
  }

  function saveStarmapMotionSettings(settings) {
    try { localStorage.setItem(STARMAP_MOTION_KEY, JSON.stringify(settings)); } catch (e) {}
    syncStarmapMotionForm(settings);
    clearTimeout(starmapMotionNotifyTimer);
    starmapMotionNotifyTimer = window.setTimeout(() => {
      starmapMotionNotifyTimer = 0;
      window.dispatchEvent(new CustomEvent('canvas:starmap-motion-change', { detail: settings }));
    }, 140);
  }

  function syncDesktopSizeForm(size) {
    if (!desktopSizeForm || !size) return;
    const limits = size.limits || {};
    const widthInput = desktopSizeForm.elements.width;
    const heightInput = desktopSizeForm.elements.height;
    if (limits.minWidth) widthInput.min = limits.minWidth;
    if (limits.maxWidth) widthInput.max = limits.maxWidth;
    if (limits.minHeight) heightInput.min = limits.minHeight;
    if (limits.maxHeight) heightInput.max = limits.maxHeight;
    desktopSizeForm.elements.width.value = size.width;
    desktopSizeForm.elements.height.value = size.height;
    if (desktopSizeHint && limits.minWidth && limits.maxWidth && limits.minHeight && limits.maxHeight) {
      desktopSizeHint.textContent = '当前显示器可选范围：'
        + limits.minWidth + ' × ' + limits.minHeight + ' 至 '
        + limits.maxWidth + ' × ' + limits.maxHeight;
    }
    desktopPresetButtons.forEach((button) => {
      const unavailable = Number(button.dataset.width) > Number(limits.maxWidth || Infinity)
        || Number(button.dataset.height) > Number(limits.maxHeight || Infinity);
      button.disabled = unavailable;
      button.title = unavailable ? '当前显示器可用区域不足' : '';
      button.classList.toggle(
        'active',
        Number(button.dataset.width) === Number(size.width)
          && Number(button.dataset.height) === Number(size.height),
      );
    });
  }

  async function applyDesktopSize(width, height) {
    if (!window.CanvasDesktop) return;
    try {
      const size = await window.CanvasDesktop.setRestoredSize(Number(width), Number(height));
      syncDesktopSizeForm(size);
    } catch (e) {
      window.alert('调整窗口大小失败，请重试。');
    }
  }

  async function openDesktopSettings() {
    if (!desktopSettings) return;
    desktopSettings.hidden = false;
    applyNoteFontScale(readNoteFontScale(), false);
    syncStarmapMotionForm();
    if (window.CanvasDesktop) {
      try { syncDesktopSizeForm(await window.CanvasDesktop.getRestoredSize()); } catch (e) {}
    }
  }

  function closeDesktopSettings() {
    if (desktopSettings) desktopSettings.hidden = true;
  }

  if (desktopSettingsOpen) desktopSettingsOpen.addEventListener('click', openDesktopSettings);
  applyNoteFontScale(readNoteFontScale(), false);
  if (noteFontScaleRange) noteFontScaleRange.addEventListener('input', () => applyNoteFontScale(noteFontScaleRange.value, true));
  document.querySelectorAll('[data-action="desktop-settings-close"]').forEach((button) => {
    button.addEventListener('click', closeDesktopSettings);
  });
  desktopPresetButtons.forEach((button) => {
    button.addEventListener('click', () => applyDesktopSize(button.dataset.width, button.dataset.height));
  });
  syncStarmapMotionForm();
  starmapMotionRanges.forEach((input) => {
    input.addEventListener('input', () => {
      const next = readStarmapMotionSettings();
      next[input.dataset.setting] = Number(input.value);
      saveStarmapMotionSettings(next);
    });
  });
  starmapMotionToggles.forEach((toggle) => {
    toggle.addEventListener('change', () => {
      const next = readStarmapMotionSettings();
      next.finalFitOnConverge = !!toggle.checked;
      saveStarmapMotionSettings(next);
    });
  });
  starmapMotionResets.forEach((button) => {
    button.addEventListener('click', () => saveStarmapMotionSettings(Object.assign({}, STARMAP_MOTION_DEFAULTS)));
  });
  if (desktopSizeForm) {
    desktopSizeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      applyDesktopSize(desktopSizeForm.elements.width.value, desktopSizeForm.elements.height.value);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (desktopSettings && !desktopSettings.hidden && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDesktopSettings();
    }
  });

  function saveActive() {
    try { localStorage.setItem('canvas:activeGroup', activeGroup); } catch (e) {}
  }

  function getStartViewElement(name) {
    if (name === 'review') return document.querySelector('.review-embedded');
    if (name === 'calendar') return document.querySelector('.calendar-embedded');
    if (name === 'focus') return document.querySelector('.focus-embedded');
    if (name === 'study') return document.querySelector('.study-embedded');
    if (name === 'cadence') return document.querySelector('.cadence-embedded');
    if (name === 'tree') return document.querySelector('.tree-page-embedded');
    if (name === 'notes') return document.querySelector('.notes-embedded');
    return bookStage;
  }

  function syncStartViewLifecycle(name, previous) {
    const layers = [
      ['recent', bookStage],
      ['study', document.querySelector('.study-embedded')],
      ['cadence', document.querySelector('.cadence-embedded')],
      ['tree', document.querySelector('.tree-page-embedded')],
      ['notes', document.querySelector('.notes-embedded')],
      ['calendar', document.querySelector('.calendar-embedded')],
      ['review', document.querySelector('.review-embedded')],
      ['focus', document.querySelector('.focus-embedded')],
    ];
    layers.forEach(([viewName, element]) => {
      if (!element) return;
      const active = viewName === name;
      element.setAttribute('aria-hidden', active ? 'false' : 'true');
      element.inert = !active;
      if (active) element.removeAttribute('inert');
      else element.setAttribute('inert', '');
    });
    if (previous !== name) {
      document.dispatchEvent(new CustomEvent('start:viewchange', {
        detail: { previous: previous || '', current: name || '' },
      }));
    }
  }

  function currentStartPageActivityTarget() {
    if (!startPageActivityEnabled || activeStartWorkspace !== 'canvas') return '';
    const view = bookView ? String(bookView.dataset.viewName || '') : '';
    return START_PAGE_ACTIVITY_VIEWS.has(view) ? view : '';
  }

  function captureStartPageActivity(endAt) {
    if (!startPageActivityActive || !startPageActivityPage || !startPageActivityLastCapturedAt) return;
    const endedAt = Math.max(startPageActivityLastCapturedAt, Number(endAt) || Date.now());
    let cursor = startPageActivityLastCapturedAt;
    while (endedAt - cursor >= 250) {
      const chunkEnd = Math.min(endedAt, cursor + 9 * 60 * 1000);
      startPageActivityPending.push({
        page: startPageActivityPage,
        startedAt: cursor,
        endedAt: chunkEnd,
      });
      cursor = chunkEnd;
    }
    startPageActivityLastCapturedAt = endedAt;
  }

  function postStartPageActivity(interval, keepalive) {
    return fetch('/api/start-page-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: !!keepalive,
      body: JSON.stringify({
        page: interval.page,
        sessionId: startPageActivitySessionId,
        startedAt: new Date(interval.startedAt).toISOString(),
        endedAt: new Date(interval.endedAt).toISOString(),
      }),
    }).then((response) => response.json().then((json) => ({ response, json })));
  }

  function resolveStartPageActivityIdleWaiters() {
    if (startPageActivitySending || startPageActivityPending.length) return;
    startPageActivityIdleWaiters.forEach((resolve) => resolve(true));
    startPageActivityIdleWaiters.clear();
  }

  function waitForStartPageActivityIdle(timeoutMs) {
    sendNextStartPageActivity(false);
    if (!startPageActivitySending && !startPageActivityPending.length) return Promise.resolve(true);
    const wait = Math.max(0, Number(timeoutMs) || 0);
    return new Promise((resolve) => {
      let done = false;
      let timer = 0;
      const finish = (idle) => {
        if (done) return;
        done = true;
        if (timer) window.clearTimeout(timer);
        startPageActivityIdleWaiters.delete(finish);
        resolve(!!idle);
      };
      startPageActivityIdleWaiters.add(finish);
      timer = window.setTimeout(() => finish(false), wait);
      resolveStartPageActivityIdleWaiters();
    });
  }

  function sendNextStartPageActivity(keepalive) {
    if (startPageActivitySending || !startPageActivityPending.length) return;
    const interval = startPageActivityPending[0];
    startPageActivitySending = interval;
    postStartPageActivity(interval, keepalive)
      .then(({ response, json }) => {
        if (!response.ok) throw new Error(json.error || 'start page activity failed');
        const index = startPageActivityPending.indexOf(interval);
        if (index >= 0) startPageActivityPending.splice(index, 1);
      })
      .catch((error) => {
        console.warn('[起步页] 前台时间暂未写入，将稍后重试', error);
      })
      .finally(() => {
        if (startPageActivitySending === interval) startPageActivitySending = null;
        if (startPageActivityPending.length) {
          window.setTimeout(() => sendNextStartPageActivity(false), 1200);
        } else {
          resolveStartPageActivityIdleWaiters();
        }
      });
  }

  function flushStartPageActivityKeepalive() {
    startPageActivityPending.slice().forEach((interval) => {
      postStartPageActivity(interval, true)
        .then(({ response, json }) => {
          if (!response.ok) throw new Error(json.error || 'start page activity failed');
          const index = startPageActivityPending.indexOf(interval);
          if (index >= 0) startPageActivityPending.splice(index, 1);
        })
        .catch(() => {})
        .finally(resolveStartPageActivityIdleWaiters);
    });
  }

  function pauseStartPageActivity(keepalive) {
    if (!startPageActivityActive) return;
    captureStartPageActivity(Date.now());
    startPageActivityActive = false;
    startPageActivityPage = '';
    startPageActivityLastCapturedAt = 0;
    if (startPageActivityHeartbeat) window.clearInterval(startPageActivityHeartbeat);
    startPageActivityHeartbeat = 0;
    if (keepalive) flushStartPageActivityKeepalive();
    else sendNextStartPageActivity(false);
  }

  function resumeStartPageActivity() {
    const target = currentStartPageActivityTarget();
    if (!target || document.hidden || !document.hasFocus()) {
      pauseStartPageActivity(false);
      return;
    }
    if (startPageActivityActive && startPageActivityPage === target) return;
    if (startPageActivityActive) pauseStartPageActivity(false);
    startPageActivityActive = true;
    startPageActivityPage = target;
    startPageActivityLastCapturedAt = Date.now();
    if (startPageActivityHeartbeat) window.clearInterval(startPageActivityHeartbeat);
    startPageActivityHeartbeat = window.setInterval(() => {
      captureStartPageActivity(Date.now());
      sendNextStartPageActivity(false);
    }, 30000);
    sendNextStartPageActivity(false);
  }

  function syncStartPageActivity() {
    const target = currentStartPageActivityTarget();
    if (!target) {
      pauseStartPageActivity(false);
      return;
    }
    resumeStartPageActivity();
  }

  function setupStartPageActivityTracker() {
    document.addEventListener('start:viewchange', syncStartPageActivity);
    document.addEventListener('relatum:start-workspacechange', syncStartPageActivity);
    window.addEventListener('focus', resumeStartPageActivity);
    window.addEventListener('blur', () => pauseStartPageActivity(true));
    window.addEventListener('pagehide', () => pauseStartPageActivity(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseStartPageActivity(true);
      else resumeStartPageActivity();
    });
  }

  window.RelatumStartPageActivity = Object.freeze({
    waitForIdle() {
      return waitForStartPageActivityIdle(3000);
    },
  });

  function clearStartViewMotion() {
    [bookStage, document.querySelector('.study-embedded'), document.querySelector('.cadence-embedded'), document.querySelector('.tree-page-embedded'),
      document.querySelector('.notes-embedded'), document.querySelector('.calendar-embedded'),
      document.querySelector('.review-embedded'),
      document.querySelector('.focus-embedded')].forEach((el) => {
      if (el) el.classList.remove(...START_VIEW_MOTION_CLASSES);
    });
  }

  function finalizeDeferredStartViewExitMotion() {
    finalizeCadenceEntranceExit(false);
    if (window.CanvasCalendar && typeof window.CanvasCalendar.finalizeExitMotion === 'function') {
      window.CanvasCalendar.finalizeExitMotion();
    }
  }

  function markStartViewTransition(name) {
    if (!bookView) return;
    const previous = bookView.dataset.viewName || '';
    bookView.dataset.viewName = name;
    if (!previous || previous === name) return;
    const previousOrder = START_VIEW_ORDER[previous] ?? START_VIEW_ORDER.recent;
    const nextOrder = START_VIEW_ORDER[name] ?? START_VIEW_ORDER.recent;
    if (previousOrder === nextOrder) return;
    bookView.classList.remove('view-switching', 'view-forward', 'view-back');
    clearStartViewMotion();
    finalizeDeferredStartViewExitMotion();
    const directionClass = nextOrder < previousOrder ? 'view-back' : 'view-forward';
    const motionClass = nextOrder < previousOrder ? 'view-motion-back' : 'view-motion-forward';
    const previousEl = getStartViewElement(previous);
    const nextEl = getStartViewElement(name);
    if (previousEl) previousEl.classList.add('view-leaving', motionClass);
    if (nextEl) nextEl.classList.add('view-entering', motionClass);
    bookView.classList.add('view-switching', directionClass);
    clearTimeout(startViewTransitionTimer);
    startViewTransitionTimer = window.setTimeout(() => {
      bookView.classList.remove('view-switching', 'view-forward', 'view-back');
      clearStartViewMotion();
      finalizeDeferredStartViewExitMotion();
      startViewTransitionTimer = 0;
    }, startViewCleanupDelay(previous, name));
  }

  function showView(name) {
    // 'cadence'（活跃热力图页）与 'study' 共用同一套书页舞台布局壳，只用 cadence-active 切换浮层，
    // 这样 [data-start-state="study"] 那批布局 CSS 仍然生效，无需为 cadence 再写一套。
    const previous = bookView ? (bookView.dataset.viewName || '') : '';
    if (name !== 'focus') {
      pendingFocusActivation = null;
      pendingFocusReadyActions = [];
      const focusRoot = document.querySelector('.focus-embedded');
      if (focusRoot) delete focusRoot.dataset.pendingForceTimer;
    }
    if (previous === 'focus' && name !== 'focus'
      && window.CanvasFocus && typeof window.CanvasFocus.deactivate === 'function') {
      window.CanvasFocus.deactivate();
    }
    const layout = (name === 'cadence' || name === 'tree' || name === 'notes' || name === 'calendar'
      || name === 'review' || name === 'focus') ? 'study' : name;
    main.dataset.state = layout;
    document.body.dataset.startState = layout;   // 顶部常驻操作条按视图显隐（CSS 控制）
    if (loadingView) loadingView.hidden = layout !== 'loading';
    emptyView.hidden = layout !== 'empty';
    recentView.hidden = layout !== 'recent' && layout !== 'study';
    if (bookView) {
      markStartViewTransition(name);
      bookView.classList.toggle('study-active', name === 'study');
      bookView.classList.toggle('cadence-active', name === 'cadence');
      bookView.classList.toggle('tree-page-active', name === 'tree');
      bookView.classList.toggle('notes-active', name === 'notes');
      bookView.classList.toggle('calendar-active', name === 'calendar');
      bookView.classList.toggle('review-active', name === 'review');
      bookView.classList.toggle('focus-active', name === 'focus');
    }
    document.querySelectorAll('.study-spine-tab:not(.cadence-spine-tab):not(.tree-page-spine-tab):not(.notes-spine-tab):not(.calendar-spine-tab):not(.review-spine-tab):not(.focus-spine-tab)').forEach((button) => {
      button.classList.toggle('active', name === 'study');
    });
    document.querySelectorAll('.focus-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'focus');
    });
    document.querySelectorAll('.cadence-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'cadence');
    });
    document.querySelectorAll('.tree-page-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'tree');
    });
    document.querySelectorAll('.notes-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'notes');
    });
    document.querySelectorAll('.calendar-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'calendar');
    });
    document.querySelectorAll('.review-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'review');
    });
    dots.querySelectorAll('.page-dot:not(.dot-add)').forEach((dot) => {
      dot.classList.toggle('active', name !== 'study' && name !== 'cadence' && name !== 'tree' && name !== 'notes'
        && name !== 'calendar' && name !== 'review'
        && name !== 'focus' && dot.dataset.groupId === activeGroup);
    });
    requestAnimationFrame(syncActiveSpineOrb);
    // 足迹星图只在活跃页是当前前置页时才跑动画循环；切到别的页就挂起，避免隐藏页 60fps 空转拖慢全局。
    if (window.StudyActivity && window.StudyActivity.setActive) {
      window.StudyActivity.setActive(name === 'cadence');
    }
    if (name !== 'cadence') {
      cadenceEntranceSeq++;
      if (previous === 'cadence') freezeCadenceEntranceForExit();
    }
    if (name !== 'calendar' && window.CanvasCalendar && window.CanvasCalendar.deactivate) {
      window.CanvasCalendar.deactivate();
    }
    if (name !== 'tree' && window.CanvasTreePage && window.CanvasTreePage.deactivate) {
      window.CanvasTreePage.deactivate();
    }
    syncStartViewLifecycle(name, previous);
  }

  // 书脊滑块的两种形状（都是 10 个顶点、角度一一对应，故能平滑形变）：
  // 普通页 = 正十边形（小尺寸下就是个圆点）；收藏页 = 五角星。
  const ORB_DOT_CLIP = 'polygon(50% 0%, 79.39% 9.55%, 97.55% 34.55%, 97.55% 65.45%, '
    + '79.39% 90.45%, 50% 100%, 20.61% 90.45%, 2.45% 65.45%, 2.45% 34.55%, 20.61% 9.55%)';
  const ORB_STAR_CLIP = 'polygon(50% 0%, 61.76% 33.82%, 97.55% 34.55%, 69.02% 56.18%, '
    + '79.39% 90.45%, 50% 70%, 20.61% 90.45%, 30.98% 56.18%, 2.45% 34.55%, 38.24% 33.82%)';

  const SPINE_HOVER_COLORS = {
    review: ['#d8796d', 'rgba(216, 121, 109, 0.3)'],
    calendar: ['#b6814d', 'rgba(182, 129, 77, 0.3)'],
    notes: ['#c4a143', 'rgba(196, 161, 67, 0.3)'],
    cadence: ['#6f987a', 'rgba(111, 152, 122, 0.3)'],
    tree: ['#4f8b76', 'rgba(79, 139, 118, 0.3)'],
    study: ['#8b74ad', 'rgba(139, 116, 173, 0.3)'],
    focus: ['#87915b', 'rgba(135, 145, 91, 0.3)'],
    recent: ['#847a71', 'rgba(132, 122, 113, 0.3)'],
    favorite: ['#d28b55', 'rgba(210, 139, 85, 0.3)'],
    inbox: ['#76858a', 'rgba(118, 133, 138, 0.3)']
  };
  const SPINE_GROUP_COLORS = [
    ['#9f7188', 'rgba(159, 113, 136, 0.3)'],
    ['#a36f5d', 'rgba(163, 111, 93, 0.3)'],
    ['#7d8f68', 'rgba(125, 143, 104, 0.3)'],
    ['#9a805d', 'rgba(154, 128, 93, 0.3)'],
    ['#806f91', 'rgba(128, 111, 145, 0.3)']
  ];

  function spineHoverKind(target) {
    if (target.classList.contains('review-spine-tab')) return 'review';
    if (target.classList.contains('calendar-spine-tab')) return 'calendar';
    if (target.classList.contains('notes-spine-tab')) return 'notes';
    if (target.classList.contains('cadence-spine-tab')) return 'cadence';
    if (target.classList.contains('tree-page-spine-tab')) return 'tree';
    if (target.classList.contains('focus-spine-tab')) return 'focus';
    if (target.classList.contains('study-spine-tab')) return 'study';
    if (target.dataset.groupId === FAVORITES_PAGE) return 'favorite';
    if (target.dataset.groupId === INBOX_PAGE) return 'inbox';
    if (target.dataset.groupId === '') return 'recent';
    return 'group';
  }

  function spineHoverColor(target, kind) {
    if (kind !== 'group') return SPINE_HOVER_COLORS[kind] || SPINE_HOVER_COLORS.recent;
    const id = target.dataset.groupId || '';
    const groupIndex = lastGroups.findIndex((group) => group.id === id);
    if (groupIndex >= 0) return SPINE_GROUP_COLORS[groupIndex % SPINE_GROUP_COLORS.length];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash * 31) + id.charCodeAt(i)) >>> 0;
    return SPINE_GROUP_COLORS[hash % SPINE_GROUP_COLORS.length];
  }

  function activeSpineTarget() {
    return document.querySelector('.study-spine-tab.active')
      || (!studyActive && !cadenceActive && !treePageActive && !notesActive && !calendarActive
        && !reviewActive && !focusActive ? dots.querySelector('.page-dot.active') : null);
  }

  function spineTargetKey(target) {
    if (!target) return '';
    if (target.classList.contains('page-dot')) return 'page:' + (target.dataset.groupId || 'recent');
    return 'tab:' + (target.dataset.action || spineHoverKind(target));
  }

  function clearSpineMarkerSettle() {
    if (!spineMarkerSettleTimer) return;
    clearTimeout(spineMarkerSettleTimer);
    spineMarkerSettleTimer = 0;
  }

  function setSpineMarkerTransition(spine, animate) {
    if (spineMarkerTransitionFrame) cancelAnimationFrame(spineMarkerTransitionFrame);
    spineMarkerTransitionFrame = 0;
    spine.classList.remove('spine-marker-no-transition');
    if (animate && spineMarkerReady && spine.classList.contains('spine-marker-visible')) return;
    spine.classList.add('spine-marker-no-transition');
    spineMarkerTransitionFrame = requestAnimationFrame(() => {
      spineMarkerTransitionFrame = 0;
      spine.classList.remove('spine-marker-no-transition');
    });
  }

  function setSpineMarkerState(spine, state, target) {
    spineMarkerState = state;
    spine.classList.add('spine-marker-visible');
    spine.classList.toggle('spine-hovering', state === 'preview');
    spine.classList.toggle('spine-marker-previewing', state === 'preview');
    spine.classList.toggle('spine-marker-returning', state === 'returning');
    spine.classList.toggle('spine-marker-resting', state === 'resting');
    spine.classList.toggle('spine-hover-current', target.classList.contains('active') || state !== 'preview');
  }

  function hideSpineMarker() {
    clearSpineMarkerSettle();
    spineMarkerState = 'hidden';
    spineMarkerTargetKey = '';
    spineMarkerReady = false;
    const spine = document.querySelector('.left-spine');
    if (!spine) return;
    spine.classList.remove('spine-marker-visible', 'spine-hovering', 'spine-marker-previewing',
      'spine-marker-returning', 'spine-marker-resting', 'spine-hover-current');
  }

  function placeSpineHover(target, options) {
    if (!target) return;
    const opts = options || {};
    const state = opts.state || 'preview';
    const bubble = target.querySelector('.dot-bubble');
    if (bubble && state === 'preview') {
      const targetRect = target.getBoundingClientRect();
      bubble.style.left = Math.round(targetRect.right + 8) + 'px';
      bubble.style.top = Math.round(targetRect.top + targetRect.height / 2) + 'px';
    }
    if (!spineHoverOrb || !spineHoverRail || target.classList.contains('dot-add')) return;
    const spine = target.closest('.left-spine');
    if (!spine) return;
    const spineRect = spine.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const isTab = target.classList.contains('study-spine-tab');
    const isFav = !isTab && target.dataset.groupId === FAVORITES_PAGE;
    const size = isTab ? 38 : (isFav ? 21 : 16);
    const x = rect.left - spineRect.left + (rect.width - size) / 2;
    const y = rect.top - spineRect.top + spine.scrollTop + (rect.height - size) / 2;
    const kind = spineHoverKind(target);
    const color = spineHoverColor(target, kind);

    clearSpineMarkerSettle();
    setSpineMarkerTransition(spine, opts.animate !== false);
    spine.style.setProperty('--spine-hover-color', color[0]);
    spine.style.setProperty('--spine-hover-glow', color[1]);
    setSpineMarkerState(spine, state, target);
    if (spineBreatheTimer) clearTimeout(spineBreatheTimer);
    spineBreatheTimer = 0;
    if (spineActiveOrb) spineActiveOrb.classList.remove('orb-breathing');
    spineHoverOrb.style.width = size + 'px';
    spineHoverOrb.style.height = size + 'px';
    spineHoverOrb.style.borderRadius = isTab ? '14px' : '0';
    spineHoverOrb.style.clipPath = isTab ? 'none' : (isFav ? ORB_STAR_CLIP : ORB_DOT_CLIP);
    spineHoverOrb.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    spineHoverRail.style.transform = 'translate3d(0,'
      + (rect.top - spineRect.top + spine.scrollTop + rect.height / 2 - 9) + 'px,0)';
    spineMarkerTargetKey = spineTargetKey(target);
    spineMarkerReady = true;
  }

  function finishSpineMarkerReturn(expectedKey) {
    spineMarkerSettleTimer = 0;
    const spine = document.querySelector('.left-spine');
    if (!spine || spinePreviewTarget || spineMarkerState !== 'returning'
      || spineMarkerTargetKey !== expectedKey) return;
    const active = activeSpineTarget();
    if (!active || spineTargetKey(active) !== expectedKey) return;
    setSpineMarkerState(spine, 'resting', active);
    scheduleSpineBreathe();
  }

  function returnSpineHover(options) {
    const opts = options || {};
    spinePreviewTarget = null;
    const active = activeSpineTarget();
    if (!active) {
      hideSpineMarker();
      return;
    }
    const key = spineTargetKey(active);
    const alreadyResting = spineMarkerState === 'resting' && spineMarkerTargetKey === key;
    const reducedMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = opts.animate !== false && !reducedMotion && !alreadyResting;
    const state = animate ? 'returning' : 'resting';
    placeSpineHover(active, { state, animate });
    if (state === 'resting') {
      scheduleSpineBreathe();
      return;
    }
    spineMarkerSettleTimer = window.setTimeout(() => finishSpineMarkerReturn(key), 360);
  }

  function clearSpineHover(options) {
    returnSpineHover(options);
  }

  function scheduleSpineBreathe() {
    if (!spineActiveOrb) return;
    if (spineBreatheTimer) clearTimeout(spineBreatheTimer);
    spineActiveOrb.classList.remove('orb-breathing');
    spineBreatheTimer = window.setTimeout(() => {
      spineBreatheTimer = 0;
      const spine = spineActiveOrb.closest('.left-spine');
      if (!spine || spineMarkerState !== 'resting') return;
      spineActiveOrb.classList.add('orb-breathing');
    }, 2800);
  }

  function bindSpineHoverTarget(target) {
    if (!target || target.dataset.spineHoverBound === '1') return;
    target.dataset.spineHoverBound = '1';
    target.addEventListener('pointerenter', () => {
      if (target.classList.contains('dot-add')) {
        placeSpineHover(target);
        return;
      }
      spinePreviewTarget = target;
      placeSpineHover(target, { state: 'preview', animate: true });
    });
    target.addEventListener('focus', () => {
      if (target.classList.contains('dot-add')) return;
      spinePreviewTarget = target;
      placeSpineHover(target, { state: 'preview', animate: true });
    });
  }

  function bindStaticSpineHoverTargets() {
    document.querySelectorAll('.left-spine .study-spine-tab').forEach(bindSpineHoverTarget);
  }

  function syncActiveSpineOrb(options) {
    if (!spineActiveOrb) return;
    const opts = options || {};
    if (spineBreatheTimer) clearTimeout(spineBreatheTimer);
    spineBreatheTimer = 0;
    spineActiveOrb.classList.remove('orb-breathing');
    const active = activeSpineTarget();
    if (!active) {
      spineActiveOrb.classList.remove('show');
      hideSpineMarker();
      return;
    }
    const spine = active.closest('.left-spine');
    const spineRect = spine.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const isTab = active.classList.contains('study-spine-tab');
    const isFav = !isTab && active.dataset.groupId === FAVORITES_PAGE;
    const size = isTab ? 34 : (isFav ? 18 : 12);
    spineActiveOrb.dataset.shape = isTab ? 'tab' : (isFav ? 'star' : 'dot');
    spineActiveOrb.style.width = size + 'px';
    spineActiveOrb.style.height = size + 'px';
    if (isTab) {
      spineActiveOrb.style.borderRadius = '13px';
      spineActiveOrb.style.clipPath = 'none';
    } else {
      // 星形与圆点都保持 polygon 轮廓，浏览器才能连续插值，避免中途闪成矩形。
      spineActiveOrb.style.borderRadius = '0';
      spineActiveOrb.style.clipPath = isFav ? ORB_STAR_CLIP : ORB_DOT_CLIP;
    }
    spineActiveOrb.style.transform = 'translate3d('
      + (rect.left - spineRect.left + (rect.width - size) / 2) + 'px,'
      + (rect.top - spineRect.top + spine.scrollTop + (rect.height - size) / 2) + 'px,0)';
    spineActiveOrb.classList.add('show');
    if (spinePreviewTarget && spinePreviewTarget.isConnected
      && spinePreviewTarget.closest('.left-spine') === spine) {
      placeSpineHover(spinePreviewTarget, { state: 'preview', animate: opts.animate !== false });
    } else {
      spinePreviewTarget = null;
      returnSpineHover({ animate: opts.animate !== false });
    }
  }

  // 桌面客户端最大化 / 还原会改变书脊的垂直居中位置。
  // 合并连续 resize，确保滑动高亮块始终贴住当前入口。
  let spineOrbResizeFrame = 0;
  window.addEventListener('resize', () => {
    if (spineOrbResizeFrame) cancelAnimationFrame(spineOrbResizeFrame);
    spineOrbResizeFrame = requestAnimationFrame(() => {
      spineOrbResizeFrame = 0;
      syncActiveSpineOrb({ animate: false });
    });
  });

  function listViewName() {
    return lastFiles.length === 0 && lastGroups.length === 0 ? 'empty' : 'recent';
  }

  let cadenceEnterTimer = 0;
  let cadenceEnterDelayTimer = 0;
  let cadenceEnterFrame = 0;
  let cadenceEntranceSeq = 0;
  let cadenceEntranceExitFrozen = false;
  let cadenceEntranceExitAnimations = [];

  function releaseCadenceEntranceExitAnimations() {
    cadenceEntranceExitAnimations.forEach((animation) => {
      try { animation.cancel(); } catch (error) {}
    });
    cadenceEntranceExitAnimations = [];
    cadenceEntranceExitFrozen = false;
  }

  function freezeCadenceEntranceForExit() {
    clearCadenceEntrance(false);
    if (cadenceEntranceExitFrozen) return;
    const cadence = document.querySelector('[data-role="study-cadence"]');
    if (!cadence) return;
    cadenceEntranceExitFrozen = true;
    if (typeof cadence.getAnimations !== 'function') return;
    try {
      cadenceEntranceExitAnimations = cadence.getAnimations({ subtree: true }).filter((animation) => {
        return animation.playState === 'running' || animation.playState === 'pending';
      });
      cadenceEntranceExitAnimations.forEach((animation) => {
        try { animation.pause(); } catch (error) {}
      });
    } catch (error) {
      cadenceEntranceExitAnimations = [];
    }
  }

  function finalizeCadenceEntranceExit(force) {
    if (!cadenceEntranceExitFrozen || (!force && cadenceActive)) return;
    clearCadenceEntrance(true);
    releaseCadenceEntranceExitAnimations();
  }

  function clearCadenceEntrance(resetClass) {
    if (cadenceEnterDelayTimer) {
      clearTimeout(cadenceEnterDelayTimer);
      cadenceEnterDelayTimer = 0;
    }
    if (cadenceEnterTimer) {
      clearTimeout(cadenceEnterTimer);
      cadenceEnterTimer = 0;
    }
    if (cadenceEnterFrame) {
      cancelAnimationFrame(cadenceEnterFrame);
      cadenceEnterFrame = 0;
    }
    if (resetClass) {
      const cadence = document.querySelector('[data-role="study-cadence"]');
      if (cadence) {
        cadence.classList.remove('cadence-entering', 'cadence-staging');
        // 镜头或日期切换会留下局部刷新动画类，它在当前页内用来避免
        // 整页与局部动画重叠；离页或重新武装入场时必须清掉，否则详情栏会被
        // .cadence-entering ... :not(.is-refreshing) 永久排除。
        const detail = cadence.querySelector('[data-role="cadence-day-detail"]');
        if (detail) detail.classList.remove('is-refreshing');
      }
    }
  }
  function stageCadenceEntrance() {
    finalizeCadenceEntranceExit(true);
    clearCadenceEntrance(true);
    const cadence = document.querySelector('[data-role="study-cadence"]');
    if (cadence) cadence.classList.add('cadence-staging');
  }
  function startCadenceEntrance() {
    clearCadenceEntrance(false);
    const cadence = document.querySelector('[data-role="study-cadence"]');
    if (!cadence || !cadence.childElementCount) return false;
    cadence.classList.remove('cadence-entering');
    void cadence.offsetWidth;
    cadence.classList.remove('cadence-staging');
    cadence.classList.add('cadence-entering');
    cadenceEnterTimer = setTimeout(() => {
      cadence.classList.remove('cadence-entering');
      cadenceEnterTimer = 0;
    }, 4200);
    return true;
  }
  function replayCadenceEntrance(delay) {
    clearCadenceEntrance(false);
    const wait = Math.max(0, Number(delay) || 0);
    const run = () => {
      cadenceEnterDelayTimer = 0;
      cadenceEnterFrame = requestAnimationFrame(() => {
        cadenceEnterFrame = requestAnimationFrame(() => {
          cadenceEnterFrame = 0;
          if (!cadenceActive) return;
          if (!startCadenceEntrance()) clearCadenceEntrance(true);
        });
      });
    };
    if (wait) {
      cadenceEnterDelayTimer = setTimeout(run, wait);
      return;
    }
    run();
  }
  function armCadenceEntrance() {
    const token = ++cadenceEntranceSeq;
    const fallbackDelay = Math.max(260, Math.round(startTurnSpeed * 0.84));
    if (window.StudyActivity && typeof window.StudyActivity.isReady === 'function'
        && window.StudyActivity.isReady()) {
      startCadenceEntrance();
      return;
    }
    if (window.StudyActivity && typeof window.StudyActivity.awaitReady === 'function') {
      window.StudyActivity.awaitReady().then(() => {
        if (!cadenceActive || token !== cadenceEntranceSeq) return;
        replayCadenceEntrance(0);
      }).catch(() => {
        if (!cadenceActive || token !== cadenceEntranceSeq) return;
        replayCadenceEntrance(fallbackDelay);
      });
      return;
    }
    replayCadenceEntrance(fallbackDelay);
  }

  function setStudyActive(active) {
    studyActive = !!active;
    if (studyActive) {
      cadenceActive = false;
      treePageActive = false;
      notesActive = false;
      calendarActive = false;
      reviewActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      showView('study');
      if (window.StudyView && typeof window.StudyView.activate === 'function') {
        window.StudyView.activate();
      }
      return;
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setCadenceActive(active) {
    cadenceActive = !!active;
    if (cadenceActive) {
      studyActive = false;
      treePageActive = false;
      notesActive = false;
      calendarActive = false;
      reviewActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      stageCadenceEntrance();
      showView('cadence');
      armCadenceEntrance();
      return;
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setTreePageActive(active) {
    treePageActive = !!active;
    if (treePageActive) {
      studyActive = false;
      cadenceActive = false;
      notesActive = false;
      calendarActive = false;
      reviewActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      showView('tree');
      if (window.CanvasTreePage && typeof window.CanvasTreePage.activate === 'function') {
        window.CanvasTreePage.activate();
      }
      return;
    }
    if (window.CanvasTreePage && typeof window.CanvasTreePage.deactivate === 'function') {
      window.CanvasTreePage.deactivate();
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setNotesActive(active) {
    notesActive = !!active;
    if (notesActive) {
      studyActive = false;
      cadenceActive = false;
      treePageActive = false;
      calendarActive = false;
      reviewActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      showView('notes');
      // 通知便签墙模块：本页刚展开（首次进入时拉数据、重算坐标基准）
      if (window.CanvasNotes && window.CanvasNotes.activate) window.CanvasNotes.activate();
      return;
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setReviewActive(active) {
    reviewActive = !!active;
    if (reviewActive) {
      studyActive = false;
      cadenceActive = false;
      treePageActive = false;
      notesActive = false;
      calendarActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      showView('review');
      if (window.CanvasReview && window.CanvasReview.activate) window.CanvasReview.activate();
      return;
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setCalendarActive(active) {
    calendarActive = !!active;
    if (calendarActive) {
      studyActive = false;
      cadenceActive = false;
      treePageActive = false;
      notesActive = false;
      reviewActive = false;
      focusActive = false;
      cancelPendingDelete();
      closeContextMenu();
      if (window.CanvasCalendar && window.CanvasCalendar.activate) window.CanvasCalendar.activate();
      // 首次进入先同步画出日历骨架，再把已有内容交给起始页翻页动画。
      showView('calendar');
      return;
    }
    if (window.CanvasCalendar && window.CanvasCalendar.deactivate) window.CanvasCalendar.deactivate();
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setFocusActive(active, options) {
    focusActive = !!active;
    if (focusActive) {
      studyActive = false;
      cadenceActive = false;
      treePageActive = false;
      notesActive = false;
      calendarActive = false;
      reviewActive = false;
      cancelPendingDelete();
      closeContextMenu();
      if (window.CanvasFocus && typeof window.CanvasFocus.prepareActivate === 'function') {
        pendingFocusActivation = null;
        pendingFocusReadyActions = [];
        window.CanvasFocus.prepareActivate(options || {});
        const focusRoot = document.querySelector('.focus-embedded');
        if (focusRoot) delete focusRoot.dataset.pendingForceTimer;
        showView('focus');
        if (window.CanvasFocus.activate) window.CanvasFocus.activate();
        return;
      }
      pendingFocusActivation = { options: Object.assign({}, options || {}) };
      pendingFocusReadyActions = [];
      const focusRoot = document.querySelector('.focus-embedded');
      if (focusRoot) focusRoot.dataset.pendingForceTimer = options && options.forceTimer ? '1' : '0';
      return;
    }
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function runWhenCanvasFocusReady(action) {
    if (typeof action !== 'function' || !focusActive) return;
    if (window.CanvasFocus) {
      action(window.CanvasFocus);
      return;
    }
    pendingFocusReadyActions.push(action);
  }

  function finishPendingFocusActivation() {
    if (!focusActive || !pendingFocusActivation || !window.CanvasFocus) return;
    const pending = pendingFocusActivation;
    const actions = pendingFocusReadyActions.slice();
    pendingFocusActivation = null;
    pendingFocusReadyActions = [];
    const focusRoot = document.querySelector('.focus-embedded');
    if (focusRoot) delete focusRoot.dataset.pendingForceTimer;
    if (typeof window.CanvasFocus.prepareActivate === 'function') {
      window.CanvasFocus.prepareActivate(pending.options || {});
    }
    showView('focus');
    if (typeof window.CanvasFocus.activate === 'function') window.CanvasFocus.activate();
    actions.forEach((action) => action(window.CanvasFocus));
  }

  document.addEventListener('canvasfocus:ready', finishPendingFocusActivation);

  function gotoEditor(path, sourceItem, fresh) {
    if (document.body.classList.contains('canvas-route-leaving')) return;
    let nextUrl = 'editor.html?file=' + encodeURIComponent(path);
    if (fresh) nextUrl += '&fresh=1';   // 新建画布首次打开：编辑器据此进简洁模式 + 弹提示
    let reducedMotion = false;
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      sessionStorage.setItem('canvas:route-from-start', '1');
    } catch (e) {}
    if (reducedMotion) {
      window.location.href = nextUrl;
      return;
    }
    document.body.classList.add('canvas-route-leaving');
    if (sourceItem) sourceItem.classList.add('opening');
    window.setTimeout(function () {
      window.location.href = nextUrl;
    }, 150);
  }

  // 暴露给活跃页等其它前置页：点「打开画布」直接进编辑器（与最近列表共用同一路由）。
  window.gotoEditor = gotoEditor;

  // ── 相对时间 ──────────────────────────────────
  function formatRelTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const now = new Date();
    const diffMs = now - then;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diffMs < min) return '刚刚';
    if (diffMs < hour) return Math.floor(diffMs / min) + ' 分钟前';
    if (diffMs < day) return Math.floor(diffMs / hour) + ' 小时前';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (then.toDateString() === yesterday.toDateString()) return '昨天';
    if (diffMs < 7 * day) return Math.floor(diffMs / day) + ' 天前';
    return then.getFullYear() + '-'
      + String(then.getMonth() + 1).padStart(2, '0') + '-'
      + String(then.getDate()).padStart(2, '0');
  }

  // ── 文件统计（节点数 + 大小）─────────────────────
  function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function formatFileStats(f) {
    const parts = [];
    if (typeof f.nodeCount === 'number') parts.push(f.nodeCount + ' 个节点');
    const size = formatSize(f.sizeBytes);
    if (size) parts.push(size);
    return parts.join(' · ');
  }

  function formatCanvasActivity(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (!sec) return '';
    if (sec < 60) return '累计不足 1 分钟';
    const min = Math.floor(sec / 60);
    if (min < 60) return '累计 ' + min + ' 分钟';
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    return '累计 ' + hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
  }

  function updateFileItemStats(li, f) {
    if (!li || !f) return;
    const missing = f.exists === false;
    li.classList.toggle('recent-item-missing', missing);
    li.draggable = !missing;

    const title = li.querySelector('.recent-item-title');
    let tag = title && title.querySelector('.recent-item-tag');
    if (missing && title && !tag) {
      tag = document.createElement('span');
      tag.className = 'recent-item-tag';
      tag.textContent = '文件已不在';
      title.appendChild(tag);
    } else if (!missing && tag) {
      tag.remove();
    }

    const meta = li.querySelector('.recent-item-meta');
    let duration = meta && meta.querySelector('.recent-item-duration');
    const durationText = formatCanvasActivity(f.canvasActivitySec);
    if (durationText && meta) {
      if (!duration) {
        duration = document.createElement('span');
        duration.className = 'recent-item-duration';
        meta.appendChild(duration);
      }
      duration.textContent = durationText;
    } else if (duration) {
      duration.remove();
    }
    let stats = meta && meta.querySelector('.recent-item-stats');
    const statsText = formatFileStats(f);
    if (statsText && meta) {
      if (!stats) {
        stats = document.createElement('span');
        stats.className = 'recent-item-stats';
        meta.appendChild(stats);
      }
      stats.textContent = statsText;
    } else if (stats) {
      stats.remove();
    }
    // 节点数和文件大小可能稍后异步补回；每次更新后都把累计时长重新放到末尾。
    if (duration && durationText && meta) meta.appendChild(duration);
  }

  async function requestFileStats(paths, requestId) {
    const unique = [...new Set((paths || []).filter(Boolean))]
      .filter((path) => !fileStatsCache.has(path))
      .slice(0, 200);
    if (!unique.length) return;
    try {
      const response = await fetch('/api/file-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: unique }),
      });
      const json = await response.json();
      if (!response.ok || requestId !== fileStatsRequestSeq) return;
      const visibleItems = new Map(Array.from(fileList.querySelectorAll(
        '.recent-item:not(.leaving):not(.search-leaving)'
      ))
        .map((item) => [item.dataset.path, item]));
      (json.files || []).forEach((stats) => {
        if (!stats || !stats.path) return;
        fileStatsCache.set(stats.path, stats);
        const file = lastFiles.find((item) => item.path === stats.path);
        if (file) Object.assign(file, stats);
        const li = visibleItems.get(stats.path);
        if (li && file) updateFileItemStats(li, file);
      });
    } catch (err) {
      console.warn('[画布] 文件统计读取失败', err);
    }
  }

  function observeVisibleFileStats() {
    if (fileStatsObserver) fileStatsObserver.disconnect();
    const items = Array.from(fileList.querySelectorAll(
      '.recent-item:not(.leaving):not(.search-leaving)'
    ));
    const requestId = fileStatsRequestSeq;
    if (!('IntersectionObserver' in window)) {
      requestFileStats(items.slice(0, 200).map((item) => item.dataset.path), requestId);
      return;
    }
    fileStatsObserver = new IntersectionObserver((entries) => {
      const paths = [];
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        fileStatsObserver.unobserve(entry.target);
        paths.push(entry.target.dataset.path);
      });
      requestFileStats(paths, requestId);
    }, { root: bookStage || null, rootMargin: '240px 0px' });
    items.forEach((item) => {
      if (!fileStatsCache.has(item.dataset.path)) fileStatsObserver.observe(item);
    });
  }

  // ── 数据分桶 ──────────────────────────────────
  function validIds() { return validGroupIds; }

  function rankOf(file, field) {
    const value = Number(file && file[field]);
    return Number.isFinite(value) ? value : 0;
  }

  function openedAtValue(file) {
    const value = Date.parse(file && file.lastOpenedAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function byRank(field) {
    return (a, b) => rankOf(a, field) - rankOf(b, field)
      || openedAtValue(b) - openedAtValue(a)
      || String(a.id || a.path).localeCompare(String(b.id || b.path));
  }

  function rebuildFileIndex() {
    validGroupIds = new Set(lastGroups.map((group) => group.id));
    const buckets = new Map();
    lastGroups.forEach((group) => buckets.set(group.id, []));
    const favorites = [];
    const inbox = [];
    lastFiles.forEach((file) => {
      if (!file || !file.path) return;
      const cached = fileStatsCache.get(file.path);
      if (cached) Object.assign(file, cached);
      if (file.favorite) favorites.push(file);
      const groupId = file.groupId || '';
      if (groupId && validGroupIds.has(groupId)) buckets.get(groupId).push(file);
      else inbox.push(file);
    });
    buckets.forEach((files) => files.sort(byRank('groupRank')));
    inbox.sort(byRank('groupRank'));
    favorites.sort(byRank('favoriteRank'));
    const recent = lastFiles.slice().filter((file) => file && file.path
      && typeof file.lastOpenedAt === 'string' && file.lastOpenedAt.trim())
      .sort((a, b) => openedAtValue(b) - openedAtValue(a)
        || String(a.id || a.path).localeCompare(String(b.id || b.path)))
      .slice(0, recentLimit);
    buckets.set('', recent);
    buckets.set(FAVORITES_PAGE, favorites);
    buckets.set(INBOX_PAGE, inbox);
    fileBuckets = buckets;
  }

  // “最近”按打开时间自动计算；收藏、未分组与自定义分组各自保持独立顺序。
  function filesOf(gid) {
    return fileBuckets.get(gid) || [];
  }

  function nameOf(gid) {
    if (gid === '') return '最近';
    if (gid === FAVORITES_PAGE) return '收藏';
    if (gid === INBOX_PAGE) return '未分组';
    const g = lastGroups.find((x) => x.id === gid);
    return g ? g.name : '最近';
  }

  function localizedPanelName(gid) {
    if (!englishUI()) return nameOf(gid);
    if (gid === '') return 'Recent';
    if (gid === FAVORITES_PAGE) return 'Favorites';
    if (gid === INBOX_PAGE) return 'Ungrouped';
    return nameOf(gid);
  }

  function normalizeLibrarySearch(value) {
    const raw = String(value || '');
    try { return raw.normalize('NFKC').toLocaleLowerCase(); }
    catch (err) { return raw.toLocaleLowerCase(); }
  }

  function librarySearchTokens() {
    return normalizeLibrarySearch(librarySearchQuery).trim().split(/\s+/).filter(Boolean);
  }

  function librarySearchActive() {
    return librarySearchEnabled && librarySearchTokens().length > 0;
  }

  function librarySearchAllActive() {
    return librarySearchActive() && librarySearchMode === 'all';
  }

  function stableAllCanvasFiles() {
    return lastFiles.slice().filter((file) => file && file.path).sort((a, b) => {
      const at = openedAtValue(a);
      const bt = openedAtValue(b);
      if (!!at !== !!bt) return at ? -1 : 1;
      if (at !== bt) return bt - at;
      const titleOrder = String(a.title || '').localeCompare(String(b.title || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      return titleOrder || String(a.id || a.path).localeCompare(String(b.id || b.path));
    });
  }

  function visibleLibraryFiles() {
    const tokens = librarySearchEnabled ? librarySearchTokens() : [];
    const base = tokens.length && librarySearchMode === 'all'
      ? stableAllCanvasFiles()
      : filesOf(activeGroup);
    if (!tokens.length) return base;
    return base.filter((file) => {
      const title = normalizeLibrarySearch(file && file.title || '');
      return tokens.every((token) => title.includes(token));
    });
  }

  function fileGroupName(file) {
    const gid = file && file.groupId || '';
    if (!gid || !validIds().has(gid)) return englishUI() ? 'Ungrouped' : '未分组';
    const group = lastGroups.find((item) => item.id === gid);
    return group ? group.name : (englishUI() ? 'Ungrouped' : '未分组');
  }

  function emptyPanelMessage() {
    if (librarySearchActive()) {
      const query = String(librarySearchQuery || '').trim().slice(0, 80);
      return englishUI()
        ? 'No canvases match “' + query + '”'
        : '没有匹配“' + query + '”的画布';
    }
    return activeGroup === ''
      ? '（还没有最近打开的画布）'
      : activeGroup === FAVORITES_PAGE
        ? '（还没有收藏的画布）'
        : activeGroup === INBOX_PAGE
          ? '（还没有未分组的画布）'
          : '（空 — 拖文件进来，或右键画布选「移动到」）';
  }

  function announceLibrarySearch(count) {
    if (!librarySearchStatus) return;
    clearTimeout(librarySearchAnnounceTimer);
    librarySearchAnnounceTimer = window.setTimeout(() => {
      librarySearchStatus.textContent = librarySearchActive()
        ? (englishUI() ? count + ' canvases found' : '找到 ' + count + ' 张画布')
        : '';
    }, 220);
  }

  function syncLibrarySearchChrome(count) {
    const active = librarySearchActive();
    const hasInput = String(librarySearchQuery || '').length > 0;
    const all = active && librarySearchMode === 'all';
    if (panelTitle) {
      panelTitle.toggleAttribute('data-user-content', !all && activeGroup !== ''
        && activeGroup !== FAVORITES_PAGE && activeGroup !== INBOX_PAGE);
      panelTitle.textContent = all
        ? (englishUI() ? 'Search results · ' : '搜索结果 · ') + count
        : localizedPanelName(activeGroup);
    }
    if (recentSyncButton) recentSyncButton.hidden = activeGroup !== INBOX_PAGE;
    if (librarySearchScope) {
      librarySearchScope.dataset.scope = librarySearchMode;
      librarySearchScope.querySelectorAll('[data-search-scope]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.searchScope === librarySearchMode));
      });
    }
    if (librarySearchCount) {
      const next = active ? String(count) : '';
      if (librarySearchCount.textContent !== next) {
        librarySearchCount.classList.remove('is-changing');
        void librarySearchCount.offsetWidth;
        librarySearchCount.textContent = next;
        if (next) librarySearchCount.classList.add('is-changing');
      }
      librarySearchCount.classList.toggle('show', active);
    }
    if (librarySearchClear) {
      librarySearchClear.classList.toggle('show', hasInput);
      librarySearchClear.setAttribute('aria-hidden', String(!hasInput));
      librarySearchClear.tabIndex = hasInput ? 0 : -1;
    }
    announceLibrarySearch(count);
  }

  // ── 渲染：左栏 + 右栏 ─────────────────────────
  function render(options) {
    // 选中的用户组若已被删 → 回到最近。
    if (activeGroup && activeGroup !== FAVORITES_PAGE && activeGroup !== INBOX_PAGE
      && !validIds().has(activeGroup)) {
      activeGroup = '';
    }
    rebuildFileIndex();
    renderDots();
    renderPanel(options);
  }

  // 页圆点（最近 + 收藏 + 各自定义分组 + 未分组）+ 末尾「+」新建分组。
  function renderDots() {
    dots.innerHTML = '';
    const pages = pageOrder().map((id) => ({ id, name: nameOf(id) }));
    pages.forEach((g) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'page-dot';
      if (!studyActive && !cadenceActive && !treePageActive && !notesActive && !calendarActive
        && !reviewActive && !focusActive && g.id === activeGroup) dot.classList.add('active');
      dot.dataset.groupId = g.id;
      if (g.id !== '' && g.id !== FAVORITES_PAGE && g.id !== INBOX_PAGE) {
        dot.setAttribute('data-user-content', '');
      }
      dot.setAttribute('aria-label', g.name);

      const bubble = document.createElement('span');
      bubble.className = 'dot-bubble';
      bubble.textContent = g.name + '  ' + filesOf(g.id).length;
      dot.appendChild(bubble);

      dot.addEventListener('click', () => navigateTo(g.id));
      // 自定义组：右键 改名/删除
      if (g.id !== '' && g.id !== FAVORITES_PAGE && g.id !== INBOX_PAGE) {
        dot.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const grp = lastGroups.find((x) => x.id === g.id);
          if (grp) openGroupMenu(e.clientX, e.clientY, grp, dot);
        });
      }
      // 3c：拖拽归类——把文件拖到圆点 = 移到该组
      dot.addEventListener('dragover', (e) => {
        if (g.id === FAVORITES_PAGE || g.id === '') return;
        const files = !draggingPath && dtHasFiles(e.dataTransfer);
        if (!draggingPath && !files) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = files ? 'copy' : 'move';
        dot.classList.add('drag-over');
      });
      dot.addEventListener('dragleave', () => dot.classList.remove('drag-over'));
      dot.addEventListener('drop', (e) => {
        if (g.id === FAVORITES_PAGE || g.id === '') return;
        dot.classList.remove('drag-over');
        if (!draggingPath && dtHasFiles(e.dataTransfer)) {   // 外部拖入 .canvas → 复制导入到该组
          e.preventDefault();
          e.stopPropagation();                               // 别让窗口级 drop 再导入一次到当前组
          importCanvasFiles(e.dataTransfer.files, g.id);
          return;
        }
        e.preventDefault();
        const path = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || draggingPath;
        draggingPath = null;
        if (path) moveFileToGroup(path, g.id === INBOX_PAGE ? '' : g.id);
      });
      dots.appendChild(dot);
      bindSpineHoverTarget(dot);
    });

    // 「+」新建分组（加一页）
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'page-dot dot-add';
    add.setAttribute('aria-label', '新建分组');
    add.textContent = '+';
    const addBubble = document.createElement('span');
    addBubble.className = 'dot-bubble';
    addBubble.textContent = '新建分组';
    add.appendChild(addBubble);
    add.addEventListener('click', () => {
      floatingInput({ placeholder: '分组名称', anchor: add, onCommit: (name) => createGroup(name) });
    });
    dots.appendChild(add);
    bindSpineHoverTarget(add);
    requestAnimationFrame(syncActiveSpineOrb);
  }

  // 浮动单行输入（新建分组 / 重命名分组），锚定到书脊上的圆点右侧
  function floatingInput(opts) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spine-float-input';
    input.value = opts.value || '';
    input.placeholder = opts.placeholder || '';
    input.spellcheck = false;
    document.body.appendChild(input);
    const r = opts.anchor.getBoundingClientRect();
    input.style.left = Math.round(r.right + 12) + 'px';
    input.style.top = Math.round(r.top + r.height / 2 - 17) + 'px';
    input.focus();
    input.select();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      const v = input.value.trim();
      input.remove();
      if (ok && v) opts.onCommit(v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
  }

  async function commitGroupRename(group, newName) {
    const n = (newName || '').trim();
    if (!n || n === group.name) return;
    try {
      const resp = await fetch('/api/group-rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: group.id, name: n }),
      });
      const json = await resp.json();
      if (!resp.ok) alert(json.error || '重命名失败');
    } catch (err) { alert('重命名失败：' + err.message); }
    refresh();
  }

  function renderPanel(options) {
    const prevRects = (options && options.animateMoves) ? captureRecentRects() : null;
    const staggerEnter = !!(options && options.staggerEnter);
    const incrementalSearch = !!(options && options.searchUpdate);
    const selectedPath = selectedIndex >= 0 && panelFiles[selectedIndex]
      ? panelFiles[selectedIndex].path : '';
    const nextFiles = visibleLibraryFiles();
    panelFiles = nextFiles;
    selectedIndex = selectedPath
      ? panelFiles.findIndex((file) => file.path === selectedPath)
      : -1;
    syncLibrarySearchChrome(panelFiles.length);
    if (incrementalSearch) {
      reconcileLibrarySearchResults(panelFiles, options);
      return;
    }
    if (fileStatsObserver) fileStatsObserver.disconnect();
    fileList.querySelectorAll('.recent-item').forEach(resetLibrarySearchItem);
    fileList.innerHTML = '';
    fileList.classList.toggle('is-large-list', panelFiles.length > LARGE_LIST_THRESHOLD);
    if (panelFiles.length === 0) {
      selectedIndex = -1;
      const empty = document.createElement('li');
      empty.className = 'group-empty soft-enter';
      empty.textContent = emptyPanelMessage();
      fileList.appendChild(empty);
      return;
    }
    panelFiles.forEach((f, i) => {
      const li = buildFileItem(f);
      updateFileItemSearchContext(li, f);
      if (i === selectedIndex) li.classList.add('file-selected');
      if (staggerEnter && panelFiles.length <= STAGGER_LIST_LIMIT) {
        li.classList.add('recent-enter');
        li.style.setProperty('--enter-delay', Math.min(i * 46, 368) + 'ms');
        li.addEventListener('animationend', () => {
          li.classList.remove('recent-enter');
          li.style.removeProperty('--enter-delay');
        }, { once: true });
      }
      fileList.appendChild(li);
    });
    observeVisibleFileStats();
    if (flashImportPaths.size) {
      const flashItems = [];
      fileList.querySelectorAll('.recent-item').forEach((li) => {
        if (flashImportPaths.has(li.dataset.path)) flashItems.push(li);
      });
      flashImportPaths.clear();
      if (!prefersReduced) {
        flashItems.forEach((item, index) => {
          item.animate([
            { opacity: 0, transform: 'translateY(-7px) scale(0.97)' },
            { opacity: 1, transform: 'translateY(0) scale(1)' },
          ], {
            duration: 340,
            delay: Math.min(index * 34, 238),
            easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)',
          });
        });
      }
    }
    if (prevRects) requestAnimationFrame(() => animateRecentMoves(prevRects));
  }

  function captureRecentRects() {
    const rects = new Map();
    activeItems().forEach((li) => rects.set(li.dataset.path, li.getBoundingClientRect()));
    return rects;
  }

  function animateRecentMoves(prevRects) {
    if (prefersReduced || !prevRects) return;
    activeItems().forEach((li) => {
      const prev = prevRects.get(li.dataset.path);
      if (!prev) return;
      const now = li.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      li.animate([
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)' },
        { transform: 'translate3d(0,0,0)' },
      ], { duration: 260, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
    });
  }

  function settleLibrarySearchItem(li) {
    if (!li) return null;
    let rect = li.getBoundingClientRect();
    const animation = li.__librarySearchAnimation;
    if (animation) {
      try {
        if (typeof animation.commitStyles === 'function') animation.commitStyles();
        rect = li.getBoundingClientRect();
      } catch (err) {}
      try { animation.cancel(); } catch (err) {}
      li.__librarySearchAnimation = null;
    }
    return rect;
  }

  function resetLibrarySearchItem(li) {
    if (!li) return;
    const animation = li.__librarySearchAnimation;
    if (animation) {
      try { animation.cancel(); } catch (err) {}
      li.__librarySearchAnimation = null;
    }
    li.classList.remove('search-entering', 'search-leaving', 'search-moving');
    [
      'position', 'left', 'top', 'width', 'height', 'z-index', 'pointer-events',
      'opacity', 'transform', 'margin', 'max-height',
    ].forEach((property) => li.style.removeProperty(property));
  }

  function playLibrarySearchAnimation(li, keyframes, options) {
    if (!li || prefersReduced || typeof li.animate !== 'function') return null;
    const animation = li.animate(keyframes, options);
    li.__librarySearchAnimation = animation;
    const clear = () => {
      if (li.__librarySearchAnimation === animation) li.__librarySearchAnimation = null;
    };
    animation.addEventListener('finish', clear, { once: true });
    animation.addEventListener('cancel', clear, { once: true });
    return animation;
  }

  function updateFileItemSearchContext(li, file) {
    if (!li || !file) return;
    const meta = li.querySelector('.recent-item-meta');
    if (!meta) return;
    let where = meta.querySelector('.recent-item-where');
    if (librarySearchAllActive()) {
      if (!where) {
        where = document.createElement('span');
        where.className = 'recent-item-where';
        where.setAttribute('data-user-content', '');
        const stats = meta.querySelector('.recent-item-stats');
        meta.insertBefore(where, stats || meta.querySelector('.recent-item-duration'));
      }
      where.textContent = fileGroupName(file);
    } else if (where) {
      where.remove();
    }
  }

  function syncFileItemForSearch(li, file) {
    if (!li || !file) return;
    const title = li.querySelector('.recent-item-name');
    if (title) {
      title.textContent = file.title || '(未命名)';
      title.toggleAttribute('data-user-content', !!file.title);
    }
    const when = li.querySelector('.recent-item-when');
    if (when) when.textContent = formatRelTime(file.lastOpenedAt);
    const favorite = li.querySelector('.recent-favorite');
    if (favorite) {
      const active = !!file.favorite;
      favorite.classList.toggle('active', active);
      favorite.setAttribute('aria-label', active ? '取消收藏' : '收藏');
      const icon = favorite.querySelector('.recent-favorite-icon');
      const tooltip = favorite.querySelector('.recent-favorite-tooltip');
      if (icon) icon.textContent = active ? '★' : '☆';
      if (tooltip) tooltip.textContent = active ? '取消收藏' : '收藏';
    }
    updateFileItemStats(li, file);
    updateFileItemSearchContext(li, file);
  }

  function reconcileLibrarySearchResults(nextFiles, options) {
    const generation = ++librarySearchRenderSeq;
    const noMotion = prefersReduced || !!(options && options.noMotion);
    const selectedPath = selectedIndex >= 0 && nextFiles[selectedIndex]
      ? nextFiles[selectedIndex].path : '';
    cancelPendingDelete();
    if (fileStatsObserver) fileStatsObserver.disconnect();

    const nextPaths = new Set(nextFiles.map((file) => file.path));
    const existing = new Map(Array.from(fileList.querySelectorAll('.recent-item'))
      .map((li) => [li.dataset.path, li]));
    const beforeRects = new Map();
    const resumeOpacities = new Map();
    const listRect = fileList.getBoundingClientRect();

    existing.forEach((li, path) => {
      if (nextPaths.has(path)) {
        const wasLeaving = li.classList.contains('search-leaving');
        const resumeOpacity = wasLeaving ? Number.parseFloat(getComputedStyle(li).opacity) : 1;
        beforeRects.set(path, settleLibrarySearchItem(li));
        if (wasLeaving && Number.isFinite(resumeOpacity)) {
          resumeOpacities.set(path, Math.max(0, Math.min(1, resumeOpacity)));
        }
        resetLibrarySearchItem(li);
        return;
      }
      if (noMotion) {
        resetLibrarySearchItem(li);
        li.remove();
        existing.delete(path);
        return;
      }
      if (li.classList.contains('search-leaving')) return;
      const rect = settleLibrarySearchItem(li) || li.getBoundingClientRect();
      resetLibrarySearchItem(li);
      li.classList.add('search-leaving');
      li.style.position = 'absolute';
      li.style.left = Math.round(rect.left - listRect.left) + 'px';
      li.style.top = Math.round(rect.top - listRect.top) + 'px';
      li.style.width = Math.round(rect.width) + 'px';
      li.style.height = Math.round(rect.height) + 'px';
      li.style.zIndex = '2';
      li.style.pointerEvents = 'none';
      const animation = playLibrarySearchAnimation(li, [
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
        { opacity: 0, transform: 'translate3d(0,-6px,0) scale(0.988)' },
      ], { duration: 170, easing: 'cubic-bezier(0.4, 0, 0.7, 0.2)', fill: 'forwards' });
      if (animation) {
        animation.addEventListener('finish', () => {
          if (li.classList.contains('search-leaving')) li.remove();
        }, { once: true });
      } else {
        li.remove();
      }
    });

    const empty = fileList.querySelector('.group-empty');
    if (empty) empty.remove();

    const orderedItems = [];
    nextFiles.forEach((file) => {
      let li = existing.get(file.path);
      const isNew = !li;
      if (!li) {
        li = buildFileItem(file);
        li.dataset.searchNew = '1';
      }
      syncFileItemForSearch(li, file);
      fileList.appendChild(li);
      orderedItems.push(li);
      if (isNew) existing.set(file.path, li);
    });

    if (!nextFiles.length) {
      const nextEmpty = document.createElement('li');
      nextEmpty.className = 'group-empty library-search-empty';
      nextEmpty.textContent = emptyPanelMessage();
      fileList.appendChild(nextEmpty);
      if (!noMotion && typeof nextEmpty.animate === 'function') {
        nextEmpty.animate([
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: 170, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
      }
    }

    fileList.classList.toggle('is-large-list', nextFiles.length > LARGE_LIST_THRESHOLD);
    orderedItems.forEach((li, index) => {
      li.classList.toggle('file-selected', index === selectedIndex);
    });
    observeVisibleFileStats();

    if (noMotion) {
      orderedItems.forEach((li) => {
        li.removeAttribute('data-search-new');
        resetLibrarySearchItem(li);
      });
      return;
    }

    requestAnimationFrame(() => {
      if (generation !== librarySearchRenderSeq) return;
      orderedItems.forEach((li) => {
        const path = li.dataset.path;
        const wasNew = li.dataset.searchNew === '1';
        li.removeAttribute('data-search-new');
        if (wasNew) {
          li.classList.add('search-entering');
          const animation = playLibrarySearchAnimation(li, [
            { opacity: 0, transform: 'translate3d(0,8px,0) scale(0.992)' },
            { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
          ], { duration: 190, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
          if (animation) animation.addEventListener('finish', () => {
            li.classList.remove('search-entering');
          }, { once: true });
          return;
        }
        const before = beforeRects.get(path);
        if (!before) return;
        const after = li.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        const resumeOpacity = resumeOpacities.get(path);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !(resumeOpacity < 0.99)) return;
        li.classList.add('search-moving');
        const animation = playLibrarySearchAnimation(li, [
          {
            opacity: Number.isFinite(resumeOpacity) ? resumeOpacity : 1,
            transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)',
          },
          { opacity: 1, transform: 'translate3d(0,0,0)' },
        ], { duration: 210, easing: 'cubic-bezier(0.22, 0.9, 0.26, 1)' });
        if (animation) animation.addEventListener('finish', () => {
          li.classList.remove('search-moving');
        }, { once: true });
      });
    });

    if (selectedPath) {
      selectedIndex = nextFiles.findIndex((file) => file.path === selectedPath);
    }
  }

  function applyLibrarySearchInput() {
    librarySearchFrame = 0;
    if (!librarySearchInput) return;
    const wasActive = librarySearchActive();
    librarySearchQuery = librarySearchInput.value || '';
    const active = librarySearchActive();
    if (!wasActive && active && bookStage) librarySearchRestoreScroll = bookStage.scrollTop;
    renderPanel({ searchUpdate: true });
    if (wasActive && !active && bookStage && librarySearchRestoreScroll != null) {
      const restore = librarySearchRestoreScroll;
      librarySearchRestoreScroll = null;
      requestAnimationFrame(() => { bookStage.scrollTop = restore; });
    }
  }

  function scheduleLibrarySearchInput() {
    if (!librarySearchEnabled) return;
    if (librarySearchFrame) cancelAnimationFrame(librarySearchFrame);
    librarySearchFrame = requestAnimationFrame(applyLibrarySearchInput);
  }

  function clearLibrarySearch(options) {
    if (!librarySearchInput) return;
    if (librarySearchFrame) {
      cancelAnimationFrame(librarySearchFrame);
      librarySearchFrame = 0;
    }
    librarySearchInput.value = '';
    applyLibrarySearchInput();
    if (!options || options.focus !== false) librarySearchInput.focus();
  }

  // 当前"活跃"文件项（排除正在飞出动画的），其顺序与 panelFiles 对齐
  function activeItems() {
    return fileList.querySelectorAll('.recent-item:not(.leaving):not(.search-leaving)');
  }
  function refreshSelectionHighlight() {
    const items = activeItems();
    items.forEach((li, i) => li.classList.toggle('file-selected', i === selectedIndex));
    if (selectedIndex >= 0 && items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  // 通用「飞出」动画：向左滑 + 淡出 + 高度收缩（下方靠文档流平滑补位）。
  // 不依赖动画完成——逻辑层已即时处理，动画并行播放，故连续操作不卡。
  function animateOut(li) {
    if (!li) return;
    li.style.height = li.offsetHeight + 'px';
    li.classList.remove('file-selected', 'pending-delete');
    li.classList.add('leaving');
    void li.offsetHeight;          // 强制 reflow，让 height 起始值生效
    li.style.height = '0px';
    let done = false;
    const fin = () => { if (done) return; done = true; li.remove(); };
    li.addEventListener('transitionend', (e) => { if (e.propertyName === 'height') fin(); });
    setTimeout(fin, 420);          // 兜底，防 transitionend 未触发
  }

  // 3d：键盘选中右栏文件（↑↓）
  function setSelected(i) {
    cancelPendingDelete();
    const items = activeItems();
    if (items.length === 0) { selectedIndex = -1; return; }
    selectedIndex = Math.max(0, Math.min(i, items.length - 1));
    refreshSelectionHighlight();
  }

  // 右方向键删除：第一下进入待删态（右滑+红框），再按一下执行（移到回收站）
  function enterPendingDelete() {
    if (selectedIndex < 0 || !panelFiles[selectedIndex]) {
      showToast('先用 ↑↓ 选中一个画布');
      return;
    }
    pendingDeleteIndex = selectedIndex;
    const li = activeItems()[selectedIndex];
    if (li) li.classList.add('pending-delete');
  }
  function cancelPendingDelete() {
    if (pendingDeleteIndex < 0) return;
    const li = activeItems()[pendingDeleteIndex];
    if (li) li.classList.remove('pending-delete');
    pendingDeleteIndex = -1;
  }
  async function confirmDelete() {
    const idx = pendingDeleteIndex;
    pendingDeleteIndex = -1;
    const f = panelFiles[idx];
    if (!f) return;
    const li = activeItems()[idx];
    await trashCanvas(f, li, true);
  }
  // 3d：顶部轻提示（淡入，~1.2s 后淡出）
  let toastTimer = null;
  let runtimeMismatch = false;
  function showToast(msg) {
    if (!toastEl || runtimeMismatch) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  function showRuntimeWarning() {
    if (!toastEl) return;
    runtimeMismatch = true;
    clearTimeout(toastTimer);
    toastTimer = null;
    toastEl.textContent = '当前标签连接的是旧后台，请关闭旧的源码启动窗口，再重新打开网页端';
    toastEl.classList.add('show', 'runtime-warning');
  }

  function verifyRuntimeCompatibility() {
    fetch('/api/runtime', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('runtime unavailable');
        return response.json();
      })
      .then((runtime) => {
        if (!runtime || runtime.schema !== EXPECTED_RUNTIME_SCHEMA) showRuntimeWarning();
      })
      .catch(showRuntimeWarning);
  }

  function nextLocalGroupRank(gid) {
    const ranks = lastFiles
      .filter((file) => (file.groupId || '') === gid)
      .map((file) => rankOf(file, 'groupRank'));
    return (ranks.length ? Math.max(...ranks) : 0) + 1024;
  }

  function staysInActiveView(file, gid) {
    if (activeGroup === '') return true;
    if (activeGroup === FAVORITES_PAGE) return !!file.favorite;
    if (activeGroup === INBOX_PAGE) return !gid;
    return activeGroup === gid;
  }

  // 把某下标的文件移到分组 gid（''=未分组）：智能页保留卡片，普通分组离开时沿用原飞出动画
  function doMoveAnimated(idx, gid, toastMsg) {
    const f = panelFiles[idx];
    if (!f) return;
    const li = activeItems()[idx];
    const lf = lastFiles.find((x) => x.path === f.path);
    if (lf) {
      lf.groupId = gid || '';
      lf.groupRank = nextLocalGroupRank(gid || '');
    }
    if (librarySearchActive()) {
      pendingDeleteIndex = -1;
      rebuildFileIndex();
      renderDots();
      renderPanel({ searchUpdate: true });
      if (toastMsg) showToast(toastMsg);
      fetch('/api/file-set-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: f.path, group: gid }),
      }).then((r) => { if (!r.ok) refresh(); }).catch(() => refresh());
      return;
    }
    const remainsVisible = staysInActiveView(f, gid || '');
    pendingDeleteIndex = -1;
    if (!remainsVisible) animateOut(li);
    rebuildFileIndex();
    panelFiles = filesOf(activeGroup);
    renderDots();
    if (toastMsg) showToast(toastMsg);
    fetch('/api/file-set-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, group: gid }),
    }).then((r) => { if (!r.ok) refresh(); }).catch(() => refresh());
    selectedIndex = Math.min(idx, panelFiles.length - 1);
    if (remainsVisible) renderPanel({ animateMoves: true });
    else refreshSelectionHighlight();
    if (!remainsVisible && panelFiles.length === 0) {
      setTimeout(() => { if (panelFiles.length === 0) renderPanel(); }, 280);
    }
  }

  // 3d：把选中文件移到第 n 个自定义分组（n 从 1 起）
  function moveSelectedToIndex(n) {
    const f = panelFiles[selectedIndex];
    if (!f) { showToast('先用 ↑↓ 选中一个画布'); return; }
    if (n > lastGroups.length) { showToast('没有第 ' + n + ' 个分组'); return; }
    const g = lastGroups[n - 1];
    if ((f.groupId || '') === g.id) { showToast('已经在「' + g.name + '」'); return; }
    doMoveAnimated(selectedIndex, g.id, '已移到「' + g.name + '」');
  }

  // 3c-2：组内手动排序——把选中文件上移(-1)/下移(+1)一位
  function reorderSelected(dir) {
    if (selectedIndex < 0) return;
    if (librarySearchActive()) {
      showToast(englishUI() ? 'Clear search before reordering' : '清除搜索后再调整顺序');
      return;
    }
    if (activeGroup === '') { showToast('「最近」按打开时间自动排序'); return; }
    const j = selectedIndex + dir;
    if (j < 0 || j >= panelFiles.length) return;
    const tmp = panelFiles[selectedIndex];
    panelFiles[selectedIndex] = panelFiles[j];
    panelFiles[j] = tmp;
    selectedIndex = j;
    syncPanelRanks();
    renderPanel({ animateMoves: true }); // 重建后用 FLIP 让卡片滑到新顺序
    refreshSelectionHighlight();
    fetch('/api/reorder-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: panelFiles.map((f) => f.path), view: activeGroup }),
    }).then((response) => { if (!response.ok) refresh(); }).catch(() => refresh());
  }

  // 3c-2 拖拽版：把 srcPath 拖到 targetPath 的前(before=true)/后，组内调序
  function reorderByDrag(srcPath, targetPath, before) {
    if (librarySearchActive()) {
      showToast(englishUI() ? 'Clear search before reordering' : '清除搜索后再调整顺序');
      return;
    }
    if (activeGroup === '') { showToast('「最近」按打开时间自动排序'); return; }
    const srcIdx = panelFiles.findIndex((x) => x.path === srcPath);
    if (srcIdx < 0 || srcPath === targetPath) return;
    const src = panelFiles.splice(srcIdx, 1)[0];
    let tIdx = panelFiles.findIndex((x) => x.path === targetPath);
    if (tIdx < 0) { panelFiles.splice(srcIdx, 0, src); return; }   // 目标没了→还原
    const insertAt = before ? tIdx : tIdx + 1;
    panelFiles.splice(insertAt, 0, src);
    selectedIndex = insertAt;
    syncPanelRanks();
    renderPanel({ animateMoves: true }); // 重建后用 FLIP 让卡片滑到新顺序
    refreshSelectionHighlight();
    fetch('/api/reorder-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: panelFiles.map((f) => f.path), view: activeGroup }),
    }).then((response) => { if (!response.ok) refresh(); }).catch(() => refresh());
  }

  // 清掉右栏所有拖拽插入指示线
  function clearDropIndicators() {
    fileList.querySelectorAll('.drop-before, .drop-after')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  // 收藏页与分组页各自维护 rank，不再通过重排全局数组相互干扰。
  function syncPanelRanks() {
    const field = activeGroup === FAVORITES_PAGE ? 'favoriteRank' : 'groupRank';
    panelFiles.forEach((file, index) => { file[field] = index * 1024; });
  }

  // 3d：把选中文件移回“未分组”
  function moveSelectedToInbox() {
    const f = panelFiles[selectedIndex];
    if (!f) { showToast('先用 ↑↓ 选中一个画布'); return; }
    const inInbox = !f.groupId || !validIds().has(f.groupId);
    if (inInbox) { showToast('已经在「未分组」'); return; }
    doMoveAnimated(selectedIndex, '', '已移到「未分组」');
  }

  async function activateFileItem(f, li) {
    if (!f) return;
    if (f.exists !== false && !fileStatsCache.has(f.path)) {
      await requestFileStats([f.path], fileStatsRequestSeq);
    }
    if (f.exists !== false) { gotoEditor(f.path, li); return; }
    const ok = window.confirm(englishUI()
      ? 'This file was moved or deleted:\n' + f.path + '\n\nRemove it from the list?'
      : '这个文件已被移动或删除：\n' + f.path + '\n\n要从列表移除吗？');
    if (ok) removeRecent(f.path);
  }

  // ── 单个文件项 ────────────────────────────────
  function buildFileItem(f) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.dataset.path = f.path;
    li.tabIndex = 0;
    const currentFile = () => lastFiles.find((item) => item.path === li.dataset.path) || f;

    const title = document.createElement('div');
    title.className = 'recent-item-title';
    const titleText = document.createElement('span');
    titleText.className = 'recent-item-name';
    titleText.textContent = f.title || '(未命名)';
    if (f.title) titleText.setAttribute('data-user-content', '');
    title.appendChild(titleText);

    const meta = document.createElement('div');
    meta.className = 'recent-item-meta';
    const when = document.createElement('span');
    when.className = 'recent-item-when';
    when.textContent = formatRelTime(f.lastOpenedAt);
    meta.appendChild(when);
    // 取代原路径行：节点个数 · 文件大小（缺数据时自动省略）
    const statsText = formatFileStats(f);
    if (statsText) {
      const stats = document.createElement('span');
      stats.className = 'recent-item-stats';
      stats.textContent = statsText;
      meta.appendChild(stats);
    }
    const durationText = formatCanvasActivity(f.canvasActivitySec);
    if (durationText) {
      const duration = document.createElement('span');
      duration.className = 'recent-item-duration';
      duration.textContent = durationText;
      meta.appendChild(duration);
    }
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'recent-favorite';
    favorite.classList.toggle('active', !!f.favorite);
    favorite.setAttribute('aria-label', f.favorite ? '取消收藏' : '收藏');
    const favoriteIcon = document.createElement('span');
    favoriteIcon.className = 'recent-favorite-icon';
    favoriteIcon.setAttribute('aria-hidden', 'true');
    favoriteIcon.textContent = f.favorite ? '★' : '☆';
    const favoriteSparkles = document.createElement('span');
    favoriteSparkles.className = 'recent-favorite-sparkles';
    favoriteSparkles.setAttribute('aria-hidden', 'true');
    favoriteSparkles.innerHTML = '<i></i><i></i><i></i>';
    const favoriteTooltip = document.createElement('span');
    favoriteTooltip.className = 'recent-favorite-tooltip';
    favoriteTooltip.textContent = f.favorite ? '取消收藏' : '收藏';
    favorite.append(favoriteIcon, favoriteSparkles, favoriteTooltip);
    favorite.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(currentFile(), li);
    });
    favorite.addEventListener('keydown', (e) => e.stopPropagation());
    li.append(title, meta, favorite);

    const activate = () => activateFileItem(currentFile(), li);

    li.addEventListener('click', activate);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingDelete();
      const file = currentFile();
      const index = panelFiles.findIndex((item) => item.path === file.path);
      if (index >= 0) {
        selectedIndex = index;
        refreshSelectionHighlight();
      }
      openFileMenu(e.clientX, e.clientY, file, li);
    });

    // 3c：拖拽到左栏某个分组 → 移动；文件状态由懒加载统计动态更新。
    li.addEventListener('dragstart', (e) => {
      const file = currentFile();
      if (file.exists === false) { e.preventDefault(); return; }
      draggingPath = file.path;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', file.path); } catch (err) {}
      li.classList.add('dragging');
      closeContextMenu();
    });
    li.addEventListener('dragend', () => {
      draggingPath = null;
      li.classList.remove('dragging');
      dots.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      clearDropIndicators();
    });
    // 3c-2 拖拽排序：拖到另一文件的上半/下半 → 插到它前/后（“最近”除外）。
    li.addEventListener('dragover', (e) => {
      const targetPath = li.dataset.path;
      if (librarySearchActive() || activeGroup === '' || !draggingPath || draggingPath === targetPath) return;
      if (panelFiles.findIndex((x) => x.path === draggingPath) < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      li.classList.toggle('drop-before', before);
      li.classList.toggle('drop-after', !before);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-before', 'drop-after');
    });
    li.addEventListener('drop', (e) => {
      const targetPath = li.dataset.path;
      if (librarySearchActive() || activeGroup === '' || !draggingPath || draggingPath === targetPath) return;
      e.preventDefault();
      e.stopPropagation();
      const before = li.classList.contains('drop-before');
      li.classList.remove('drop-before', 'drop-after');
      const src = draggingPath;
      draggingPath = null;
      reorderByDrag(src, targetPath, before);
    });
    updateFileItemStats(li, f);
    return li;
  }

  function toggleFavorite(f, li) {
    const next = !f.favorite;
    f.favorite = next;
    if (next) {
      const ranks = lastFiles.filter((item) => item.favorite && item !== f)
        .map((item) => rankOf(item, 'favoriteRank'));
      f.favoriteRank = (ranks.length ? Math.min(...ranks) : 0) - 1024;
    } else {
      delete f.favorite;
      delete f.favoriteRank;
    }
    const button = li && li.querySelector('.recent-favorite');
    if (button) {
      const icon = button.querySelector('.recent-favorite-icon');
      const tooltip = button.querySelector('.recent-favorite-tooltip');
      button.classList.toggle('active', next);
      button.classList.remove('favorite-just-on', 'favorite-just-off');
      void button.offsetWidth;
      button.classList.add(next ? 'favorite-just-on' : 'favorite-just-off');
      button.setAttribute('aria-label', next ? '取消收藏' : '收藏');
      if (icon) icon.textContent = next ? '★' : '☆';
      if (tooltip) tooltip.textContent = next ? '取消收藏' : '收藏';
      window.setTimeout(() => {
        button.classList.remove('favorite-just-on', 'favorite-just-off');
      }, 620);
    }
    showToast(next ? '已收藏' : '已取消收藏');
    if (librarySearchActive()) {
      rebuildFileIndex();
      renderDots();
      renderPanel({ searchUpdate: true });
    } else if (activeGroup === FAVORITES_PAGE && !next) {
      const idx = panelFiles.findIndex((x) => x.path === f.path);
      if (idx >= 0) panelFiles.splice(idx, 1);
      animateOut(li);
      rebuildFileIndex();
      panelFiles = filesOf(activeGroup);
      renderDots();
      selectedIndex = Math.min(selectedIndex, panelFiles.length - 1);
      refreshSelectionHighlight();
      if (panelFiles.length === 0) {
        setTimeout(() => { if (panelFiles.length === 0) renderPanel(); }, 280);
      }
    } else {
      rebuildFileIndex();
      renderDots();
    }
    fetch('/api/favorite-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.path, favorite: next }),
    }).then((r) => { if (!r.ok) refresh(); }).catch(() => refresh());
  }

  // ── 行内重命名（文件）─────────────────────────
  function startRename(li, f) {
    if (li.dataset.renaming === '1') return;
    li.dataset.renaming = '1';
    const titleEl = li.querySelector('.recent-item-title');
    if (!titleEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'recent-rename-input';
    input.value = f.title || '';
    input.spellcheck = false;
    titleEl.style.display = 'none';
    li.insertBefore(input, titleEl);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.focus();
    input.select();

    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      const newName = input.value.trim();
      if (!newName || newName === (f.title || '')) { refresh(); return; }
      try {
        const resp = await fetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path, newName }),
        });
        const json = await resp.json();
        if (!resp.ok) showStartNotice(json.error || '重命名失败');
      } catch (err) {
        showStartNotice('重命名失败：' + err.message);
      }
      refresh();
    };
    const cancel = () => { if (settled) return; settled = true; refresh(); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  // ── 分组 / 文件操作 ───────────────────────────
  // 拖拽 / 右键"移动到" 共用。若文件正显示在右栏（且目标不是当前组）→ 走飞出动画；
  // 否则静默调接口 + 刷新。
  // ── 外部拖入 .canvas 文件 → 复制导入到分组（和拖图片进编辑器同构：读字节上传）──
  function dtHasFiles(dt) {
    if (!dt) return false;
    if (dt.files && dt.files.length) return true;
    return [...(dt.types || [])].indexOf('Files') >= 0;
  }
  function canvasFilesFrom(dt) {
    if (!dt || !dt.files) return [];
    return [...dt.files].filter((f) => /\.canvas$/i.test(f.name || ''));
  }

  async function importOneCanvas(file, gid) {
    let text;
    try { text = await file.text(); }
    catch (e) { showToast('读取「' + file.name + '」失败'); return null; }
    let ok = true;
    try { const j = JSON.parse(text); if (!j || !Array.isArray(j.nodes)) ok = false; }
    catch (e) { ok = false; }
    if (!ok) { showToast('「' + file.name + '」不是有效的画布文件'); return null; }
    try {
      const resp = await fetch('/api/import-canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: text, group: gid || '' }),
      });
      const json = await resp.json();
      if (!resp.ok) { showToast((json && json.error) || '导入失败'); return null; }
      return json;   // {path, title, group, hasAssets}
    } catch (e) { showToast('导入失败：' + e.message); return null; }
  }

  async function importCanvasFiles(fileListLike, gid) {
    const list = [...(fileListLike || [])].filter((f) => /\.canvas$/i.test(f.name || ''));
    if (!list.length) { showToast('只能拖入 .canvas 画布文件'); return; }
    let lastPath = null, count = 0, assetsWarned = false;
    for (const file of list) {
      const res = await importOneCanvas(file, gid);
      if (res) { lastPath = res.path; count += 1; if (res.hasAssets) assetsWarned = true; }
    }
    if (!count) return;
    flashImportPaths.add(lastPath);
    if (gid && gid !== activeGroup) { activeGroup = gid; saveActive(); }
    await refresh();
    if (assetsWarned) {
      showToast(count > 1 ? ('已导入 ' + count + ' 个画布（附件/图片未一起带入）')
        : '已导入（图片/附件未一起带入）');
    } else {
      showToast(count > 1 ? ('已导入 ' + count + ' 个画布到「' + (nameOf(gid) || '最近') + '」')
        : '已导入到「' + (nameOf(gid) || '最近') + '」');
    }
  }

  function groupDestinationName(gid) {
    return gid ? nameOf(gid) : nameOf(INBOX_PAGE);
  }

  function targetGroupForActivePage() {
    return validIds().has(activeGroup) ? activeGroup : '';
  }

  function moveFileToGroup(path, gid) {
    const idx = panelFiles.findIndex((x) => x.path === path);
    const file = idx >= 0 ? panelFiles[idx] : lastFiles.find((item) => item.path === path);
    if (file && (file.groupId || '') === (gid || '')) {
      showToast('已经在「' + groupDestinationName(gid) + '」');
      return;
    }
    if (idx >= 0) {
      doMoveAnimated(idx, gid, '已移到「' + groupDestinationName(gid) + '」');
      return;
    }
    fetch('/api/file-set-group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, group: gid }),
    }).then(() => refresh()).catch((err) => console.warn('[画布] 移动失败', err));
  }

  async function deleteGroup(group) {
    const ok = window.confirm(englishUI()
      ? 'Delete the group “' + group.name + '”?\nIts canvases will become ungrouped; the canvas files themselves will not be deleted.'
      : '删除分组「' + group.name + '」？\n组里的画布会移到「未分组」（画布文件本身不会删）。');
    if (!ok) return;
    try {
      await fetch('/api/group-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: group.id }),
      });
      if (activeGroup === group.id) { activeGroup = INBOX_PAGE; saveActive(); }
      await refresh();
    } catch (err) { console.warn('[画布] 删除分组失败', err); }
  }

  async function createGroup(name) {
    const n = (name || '').trim();
    if (!n) return;
    try {
      const resp = await fetch('/api/group-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n }),
      });
      const json = await resp.json();
      if (!resp.ok) { alert(json.error || '新建分组失败'); return; }
      if (json.id) { activeGroup = json.id; saveActive(); }  // 建完跳到新组
      await refresh();
    } catch (err) { alert('新建分组失败：' + err.message); }
  }

  async function removeRecent(path) {
    try {
      await fetch('/api/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      await refresh();
    } catch (err) { console.warn('[画布] 移除失败', err); }
  }

  function recentSyncResultMessage(result) {
    const added = Number(result && result.addedCount) || 0;
    const removed = Number(result && result.removedCount) || 0;
    const skipped = Number(result && result.skippedInvalidCount) || 0;
    const remaining = Number(result && result.remainingMissingCount) || 0;
    if (!added && !removed && !skipped && !remaining) {
      return englishUI() ? 'Canvas library is already up to date' : '画布库已是最新';
    }
    const parts = englishUI()
      ? [
        added ? ('Added ' + added) : '',
        removed ? ('removed ' + removed + ' missing') : '',
        skipped ? ('skipped ' + skipped + ' invalid') : '',
        remaining ? (remaining + ' newly missing left unchanged') : '',
      ]
      : [
        added ? ('新增 ' + added + ' 张') : '',
        removed ? ('移除 ' + removed + ' 个失效项') : '',
        skipped ? ('跳过 ' + skipped + ' 个异常文件') : '',
        remaining ? ('另有 ' + remaining + ' 个新失效项未清理') : '',
      ];
    return parts.filter(Boolean).join(' · ');
  }

  async function requestRecentSync(confirmRemoveIds) {
    const body = Array.isArray(confirmRemoveIds) ? { confirmRemoveIds } : {};
    const response = await fetch('/api/recent-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = {};
    try { json = await response.json(); } catch (err) {}
    if (!response.ok) throw new Error(json.error || (englishUI() ? 'Scan failed' : '扫描失败'));
    return json;
  }

  if (recentSyncButton) {
    recentSyncButton.addEventListener('click', async () => {
      if (recentSyncButton.disabled) return;
      recentSyncButton.disabled = true;
      recentSyncButton.classList.add('is-refreshing');
      recentSyncButton.setAttribute('aria-busy', 'true');
      try {
        let result = await requestRecentSync();
        if (result.needsConfirmation) {
          const added = Number(result.pendingAddedCount) || 0;
          const removed = Number(result.pendingRemovedCount) || 0;
          const skipped = Number(result.skippedInvalidCount) || 0;
          const message = englishUI()
            ? ('Found ' + added + ' new canvas(es) and ' + removed + ' missing list item(s).'
              + (skipped ? (' ' + skipped + ' invalid file(s) will be skipped.') : '')
              + '\n\nRemove the missing items from the list and continue? No canvas files will be deleted.')
            : ('发现 ' + added + ' 张新画布和 ' + removed + ' 个失效登记。'
              + (skipped ? ('另有 ' + skipped + ' 个异常文件会被跳过。') : '')
              + '\n\n是否从列表移除失效登记并继续？不会删除任何画布文件。');
          if (!window.confirm(message)) return;
          result = await requestRecentSync(result.removeIds || []);
        }
        (result.addedPaths || []).forEach((path) => {
          if (path) flashImportPaths.add(path);
        });
        await refresh();
        showToast(recentSyncResultMessage(result));
      } catch (err) {
        showToast((englishUI() ? 'Scan failed: ' : '扫描失败：') + err.message);
      } finally {
        recentSyncButton.disabled = false;
        recentSyncButton.classList.remove('is-refreshing');
        recentSyncButton.removeAttribute('aria-busy');
      }
    });
  }

  if (librarySearchInput) {
    librarySearchInput.addEventListener('input', (event) => {
      if (event.isComposing) return;
      scheduleLibrarySearchInput();
    });
    librarySearchInput.addEventListener('compositionend', scheduleLibrarySearchInput);
    librarySearchInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = event.key === 'ArrowDown'
          ? (selectedIndex < 0 ? 0 : selectedIndex + 1)
          : (selectedIndex < 0 ? panelFiles.length - 1 : selectedIndex - 1);
        setSelected(next);
        const item = activeItems()[selectedIndex];
        if (item) item.focus();
      } else if (event.key === 'Enter') {
        const index = selectedIndex >= 0 ? selectedIndex : 0;
        const file = panelFiles[index];
        const item = activeItems()[index];
        if (file) {
          event.preventDefault();
          activateFileItem(file, item);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (librarySearchInput.value) clearLibrarySearch();
        else librarySearchInput.blur();
      }
    });
  }

  if (librarySearchClear) {
    librarySearchClear.addEventListener('click', (event) => {
      event.preventDefault();
      clearLibrarySearch();
    });
  }

  if (librarySearchScope) {
    librarySearchScope.querySelectorAll('[data-search-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        const next = button.dataset.searchScope === 'all' ? 'all' : 'current';
        if (next === librarySearchMode) return;
        librarySearchMode = next;
        renderPanel({ searchUpdate: true });
      });
    });
  }

  document.addEventListener('relatum:languagechange', () => {
    if (librarySearchActive()) renderPanel({ searchUpdate: true, noMotion: true });
    else syncLibrarySearchChrome(panelFiles.length);
  });

  async function trashCanvas(f, li, armNext) {
    if (!f || !f.path || trashingPaths.has(f.path)) return false;
    trashingPaths.add(f.path);
    try {
      const resp = await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: f.path }),
      });
      let json = {};
      try { json = await resp.json(); } catch (err) {}
      if (!resp.ok) throw new Error(json.error || '移到回收站失败');

      const idx = panelFiles.findIndex((item) => item.path === f.path);
      const currentLi = Array.from(activeItems()).find((item) => item.dataset.path === f.path) || li;
      lastFiles = lastFiles.filter((item) => item.path !== f.path);
      if (librarySearchActive()) {
        rebuildFileIndex();
        renderDots();
        renderPanel({ searchUpdate: true });
        showToast(json.missing ? '文件已不存在，已从列表移除' : '已移到回收站');
        selectedIndex = Math.min(idx, panelFiles.length - 1);
        refreshSelectionHighlight();
        if (armNext && selectedIndex >= 0) {
          pendingDeleteIndex = selectedIndex;
          const next = activeItems()[selectedIndex];
          if (next) next.classList.add('pending-delete');
        }
        return true;
      }
      if (idx >= 0) panelFiles.splice(idx, 1);
      animateOut(currentLi);
      renderDots();
      showToast(json.missing ? '文件已不存在，已从列表移除' : '已移到回收站');

      if (idx >= 0) selectedIndex = Math.min(idx, panelFiles.length - 1);
      else if (selectedIndex >= panelFiles.length) selectedIndex = panelFiles.length - 1;
      refreshSelectionHighlight();
      if (armNext && selectedIndex >= 0) {
        pendingDeleteIndex = selectedIndex;
        const next = activeItems()[selectedIndex];
        if (next) next.classList.add('pending-delete');
      } else if (panelFiles.length === 0) {
        setTimeout(() => { if (panelFiles.length === 0) renderPanel(); }, 280);
      }
      return true;
    } catch (err) {
      showToast(err && err.message ? err.message : '移到回收站失败');
      await refresh();
      return false;
    } finally {
      trashingPaths.delete(f.path);
    }
  }

  function revealPath(path) {
    fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch((err) => console.warn('[画布] 打开资源管理器失败', err));
  }

  // ── 右键菜单（动态构建）───────────────────────
  function clearMenu() { ctxMenu.innerHTML = ''; }
  function addMenuItem(label, fn, danger) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (danger) b.className = 'ctx-danger';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      fn();
    });
    ctxMenu.appendChild(b);
    return b;
  }
  function addMenuLabel(text) {
    const d = document.createElement('div');
    d.className = 'ctx-label';
    d.textContent = text;
    ctxMenu.appendChild(d);
  }
  function addMenuSep() {
    const d = document.createElement('div');
    d.className = 'ctx-sep';
    ctxMenu.appendChild(d);
  }
  function showMenuAt(x, y) {
    ctxMenu.hidden = false;
    ctxMenu.style.left = '0px';
    ctxMenu.style.top = '0px';
    const rect = ctxMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    ctxMenu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    ctxMenu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
  }
  function closeContextMenu() {
    ctxMenu.hidden = true;
    clearMenu();
  }

  function openFileMenu(x, y, f, li) {
    clearMenu();
    addMenuItem(f.favorite ? '取消收藏' : '收藏', () => toggleFavorite(f, li));
    addMenuSep();
    addMenuItem('重命名', () => startRename(li, f));
    addMenuItem('在文件资源管理器打开', () => revealPath(f.path));
    addMenuItem('从列表移除', () => removeRecent(f.path));
    addMenuSep();
    addMenuLabel('移动到');
    const cur = f.groupId || '';
    if (cur !== '') addMenuItem('未分组', () => moveFileToGroup(f.path, ''));
    lastGroups.forEach((g) => {
      if (g.id !== cur) {
        const groupItem = addMenuItem(g.name, () => moveFileToGroup(f.path, g.id));
        groupItem.setAttribute('data-user-content', '');
      }
    });
    if (lastGroups.length === 0) {
      const d = document.createElement('div');
      d.className = 'ctx-hint';
      d.textContent = '（还没有分组，先在左栏新建一个）';
      ctxMenu.appendChild(d);
    }
    addMenuSep();
    addMenuItem('移到回收站', () => trashCanvas(f, li, false), true);
    showMenuAt(x, y);
  }

  function openGroupMenu(x, y, group, anchorEl) {
    clearMenu();
    addMenuItem('重命名分组', () => floatingInput({
      value: group.name,
      placeholder: '分组名称',
      anchor: anchorEl,
      onCommit: (name) => commitGroupRename(group, name),
    }));
    const index = lastGroups.findIndex((item) => item.id === group.id);
    if (index > 0) addMenuItem('向上移动', () => moveGroupBy(group.id, -1));
    if (index >= 0 && index < lastGroups.length - 1) {
      addMenuItem('向下移动', () => moveGroupBy(group.id, 1));
    }
    addMenuItem('删除分组', () => deleteGroup(group), true);
    showMenuAt(x, y);
  }

  async function moveGroupBy(groupId, delta) {
    const index = lastGroups.findIndex((group) => group.id === groupId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= lastGroups.length) return;
    const moved = lastGroups.splice(index, 1)[0];
    lastGroups.splice(next, 0, moved);
    renderDots();
    try {
      const response = await fetch('/api/groups-reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: lastGroups.map((group) => group.id) }),
      });
      if (!response.ok) await refresh();
    } catch (err) {
      await refresh();
    }
  }

  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  ctxMenu.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('keydown', (e) => {
    if (main.dataset.state !== 'recent' || !librarySearchInput || !librarySearchEnabled) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
    e.preventDefault();
    librarySearchInput.focus();
    librarySearchInput.select();
  });

  // ── 3d：键盘归类（↑↓ 选中、数字键移动、Enter 打开）──
  document.addEventListener('keydown', (e) => {
    if (main.dataset.state !== 'recent') return;             // 只在画布列表视图
    if (startNotice && !startNotice.hidden) return;           // 提示层显示时暂停底层快捷键
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!ctxMenu.hidden) return;                             // 菜单开着不抢键
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown' && e.shiftKey) {
      e.preventDefault();
      reorderSelected(1);
    } else if (e.key === 'ArrowUp' && e.shiftKey) {
      e.preventDefault();
      reorderSelected(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(selectedIndex < 0 ? 0 : selectedIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(selectedIndex < 0 ? 0 : selectedIndex - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      // 已在待删态且还是同一项 → 确认删除；否则进入待删态
      if (pendingDeleteIndex === selectedIndex && selectedIndex >= 0) confirmDelete();
      else { cancelPendingDelete(); enterPendingDelete(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      cancelPendingDelete();
    } else if (e.key === 'Enter') {
      cancelPendingDelete();
      const f = panelFiles[selectedIndex];
      if (f) {
        e.preventDefault();
        activateFileItem(f, activeItems()[selectedIndex]);
      }
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      cancelPendingDelete();
      moveSelectedToIndex(parseInt(e.key, 10));
    } else if (e.key === '0' || e.key === 'Backspace') {
      e.preventDefault();
      cancelPendingDelete();
      moveSelectedToInbox();
    }
  });

  // ── 顶层按钮 ───────────────────────────────────
  document.querySelectorAll('[data-action="new"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const resp = await fetch('/api/new', { method: 'POST' });
        const json = await resp.json();
        if (resp.ok && json.path) {
          // 在某个自定义分组页新建 → 把新画布直接归入当前分组；收藏页/最近页仍留在「最近」
          // （与拖入导入同一约定，见 drop 处理处）。归类失败不阻断进入画布，大不了留在「最近」。
          const gid = targetGroupForActivePage();
          if (gid) {
            try {
              await fetch('/api/file-set-group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: json.path, group: gid }),
              });
            } catch (e) { console.warn('[画布] 新建画布归类失败', e); }
          }
          gotoEditor(json.path, null, true);   // 新建 = fresh
        } else {
          alert(json.error || '新建失败');
        }
      } catch (err) {
        alert('新建失败：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="import-canvas-file"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const resp = await fetch('/api/import-canvas-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: targetGroupForActivePage() }),
        });
        const json = await resp.json();
        if (json.cancelled) return;
        if (resp.ok && json.path) {
          if (json.missingAssetCount > 0) {
            window.alert(englishUI()
              ? ('The canvas was imported, but ' + json.missingAssetCount
                + ' referenced asset(s) are missing. Ask the sender for the matching .assets folder.')
              : ('画布已导入，但有 ' + json.missingAssetCount
                + ' 个引用素材缺失。请让发送方一并提供同名 .assets 文件夹。'));
          }
          gotoEditor(json.path);
        } else {
          window.alert(json.error || '导入失败');
        }
      } catch (err) {
        window.alert('导入失败：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="import-canvas-folder"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const resp = await fetch('/api/import-canvas-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: targetGroupForActivePage() }),
        });
        const json = await resp.json();
        if (json.cancelled) return;
        if (!resp.ok || !json.ok) {
          window.alert(json.error || '导入失败');
          return;
        }
        (json.items || []).forEach((item) => {
          if (item && item.path) flashImportPaths.add(item.path);
        });
        if (activeGroup === FAVORITES_PAGE) {
          activeGroup = '';
          saveActive();
        }
        await refresh();
        const renamed = Number(json.renamedCount) || 0;
        const assets = Number(json.assetCount) || 0;
        showToast(englishUI()
          ? ('Imported ' + json.count + ' canvases'
            + (assets ? (' with ' + assets + ' asset files') : '')
            + (renamed ? ('; renamed ' + renamed + ' conflicts') : ''))
          : ('已导入 ' + json.count + ' 张画布'
            + (assets ? ('、' + assets + ' 个素材文件') : '')
            + (renamed ? ('，' + renamed + ' 张因同名已改名') : '')));
      } catch (err) {
        window.alert('导入失败：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="import-md"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const resp = await fetch('/api/import-markdown', { method: 'POST' });
        const json = await resp.json();
        if (json.cancelled) return;
        if (resp.ok && json.path) {
          window.alert(
            '导入完成：' + json.nodes + ' 个节点，'
            + json.edges + ' 条连线\n\n新画布：' + json.title,
          );
          gotoEditor(json.path);
        } else {
          window.alert(json.error || '导入失败');
        }
      } catch (err) {
        window.alert('导入失败：' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-action="study-view"]').forEach((btn) => {
    const supportsArchiveHold = btn.classList.contains('study-spine-tab');
    const HOLD_MS = 700;
    let holdTimer = null;
    let holdFired = false;
    let startX = 0;
    let startY = 0;
    function cancelHold() {
      clearTimeout(holdTimer);
      holdTimer = null;
      btn.classList.remove('holding');
    }
    function fireArchive() {
      cancelHold();
      holdFired = true;
      btn.classList.add('archived-flash');
      setTimeout(() => btn.classList.remove('archived-flash'), 480);
      if (window.StudyView && typeof window.StudyView.archiveDone === 'function') {
        window.StudyView.archiveDone();
      }
    }
    if (supportsArchiveHold) {
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        holdFired = false;
        startX = e.clientX;
        startY = e.clientY;
        btn.classList.add('holding');
        clearTimeout(holdTimer);
        holdTimer = setTimeout(fireArchive, HOLD_MS);
      });
      btn.addEventListener('pointermove', (e) => {
        if (holdTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancelHold();
      });
      btn.addEventListener('pointerup', cancelHold);
      btn.addEventListener('pointerleave', cancelHold);
      btn.addEventListener('pointercancel', cancelHold);
    }
    btn.addEventListener('click', (e) => {
      if (holdFired) { e.preventDefault(); e.stopPropagation(); holdFired = false; return; }
      // 已在学习页 → 再点一次「学」在看板/清单两种呈现间切换；否则照常进入学习页
      if (studyActive && window.StudyView && typeof window.StudyView.toggleMode === 'function') {
        window.StudyView.toggleMode();
      } else {
        setStudyActive(true);
      }
    });
  });
  document.querySelectorAll('[data-action="cadence-view"]').forEach((btn) => {
    btn.addEventListener('click', () => { setCadenceActive(true); });
  });
  document.querySelectorAll('[data-action="tree-page-view"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (treePageActive && window.CanvasTreePage && typeof window.CanvasTreePage.resetView === 'function') {
        window.CanvasTreePage.resetView();
      }
      setTreePageActive(true);
    });
  });
  document.querySelectorAll('[data-action="review-view"]').forEach((btn) => {
    btn.addEventListener('click', () => { setReviewActive(true); });
  });
  document.querySelectorAll('[data-action="calendar-view"]').forEach((btn) => {
    btn.addEventListener('click', () => { setCalendarActive(true); });
  });
  document.querySelectorAll('[data-action="focus-view"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (focusActive && window.CanvasFocus && typeof window.CanvasFocus.toggleMode === 'function') {
        window.CanvasFocus.toggleMode();
      } else {
        setFocusActive(true);
      }
    });
  });
  // 速记归档：把整墙便签里「有名字」的搬进 data/学习归档/<日期>+<N>条速记/，
  // 无名便签随之清空但不归档；归档后刷新活跃页统计。由长按速记图标触发。
  function archiveNotes() {
    if (!window.CanvasNotes || !window.CanvasNotes.archive) return;
    window.CanvasNotes.archive().then((res) => {
      if (!res || res.empty) { showToast('速记墙还是空的'); return; }
      if (window.StudyActivity && window.StudyActivity.reload) window.StudyActivity.reload();
      if (res.count > 0) showToast('已归档 ' + res.count + ' 条速记 · data/学习归档/' + res.folder);
      else showToast('便签都没写字，已清空（未归档）');
    }).catch((err) => showToast((err && err.message) || '归档失败'));
  }

  document.querySelectorAll('[data-action="notes-view"]').forEach((btn) => {
    // 普通点击 = 进入速记页；长按（蓄力环填满）= 归档整墙。两者靠 holdFired 区分，
    // 长按完成后吞掉随之而来的 click，避免归档同时又跳进速记页。
    const HOLD_MS = 700;
    let holdTimer = null;
    let holdFired = false;
    let startX = 0;
    let startY = 0;
    function cancelHold() {
      clearTimeout(holdTimer);
      holdTimer = null;
      btn.classList.remove('holding');
    }
    function fireArchive() {
      cancelHold();
      holdFired = true;
      btn.classList.add('archived-flash');
      setTimeout(() => btn.classList.remove('archived-flash'), 480);
      archiveNotes();
    }
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      holdFired = false;
      startX = e.clientX;
      startY = e.clientY;
      btn.classList.add('holding');
      clearTimeout(holdTimer);
      holdTimer = setTimeout(fireArchive, HOLD_MS);
    });
    btn.addEventListener('pointermove', (e) => {
      if (holdTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancelHold();
    });
    btn.addEventListener('pointerup', cancelHold);
    btn.addEventListener('pointerleave', cancelHold);
    btn.addEventListener('pointercancel', cancelHold);
    btn.addEventListener('click', (e) => {
      if (holdFired) { e.preventDefault(); e.stopPropagation(); holdFired = false; return; }
      if (notesActive && window.CanvasNotes && typeof window.CanvasNotes.resetView === 'function') {
        window.CanvasNotes.resetView();
      }
      setNotesActive(true);
    });
  });

  document.addEventListener('calendar:navigate', (event) => {
    const view = event.detail && event.detail.view;
    if (view === 'cadence') setCadenceActive(true);
    if (view === 'focus') {
      setFocusActive(true, { forceTimer: true });
      runWhenCanvasFocusReady((focus) => {
        if (event.detail.day && focus.showDay) focus.showDay(event.detail.day, event.detail.sessionId);
      });
    }
  });

  // ── 翻书式翻页 ────────────────────────────────
  // 「页」= [复习, 日历, 活跃, 速记, 树状, 学习, 专注, 最近, 收藏, ...自定义分组]。
  let flipping = false;
  let wheelAccum = 0;
  let wheelResetTimer = null;
  const prefersReduced = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  })();

  function pageOrder() {
    return ['', FAVORITES_PAGE]
      .concat(lastGroups.map((g) => g.id), [INBOX_PAGE]);
  }
  function pageIndexOf(gid) {
    const i = pageOrder().indexOf(gid);
    return i < 0 ? 0 : i;
  }

  // 翻到某页（带整页横滑 + 淡入淡出；方向由页序决定，循环翻页时由 forwardHint 指定）
  function navigateTo(gid, forwardHint) {
    if (librarySearchActive()) librarySearchRestoreScroll = 0;
    if (studyActive || cadenceActive || treePageActive || notesActive || calendarActive || reviewActive || focusActive) {
      activeGroup = gid; saveActive(); selectedIndex = -1;
      studyActive = false;
      cadenceActive = false;
      treePageActive = false;
      notesActive = false;
      calendarActive = false;
      reviewActive = false;
      focusActive = false;
      render({ staggerEnter: true });
      showView(listViewName());
      if (bookStage) bookStage.scrollTop = 0;
      return;
    }
    if (gid === activeGroup) return;
    const forward = (typeof forwardHint === 'boolean')
      ? forwardHint
      : (pageIndexOf(gid) >= pageIndexOf(activeGroup));
    if (prefersReduced || !bookPage) {
      activeGroup = gid; saveActive(); selectedIndex = -1;
      render({ staggerEnter: true });
      if (bookStage) bookStage.scrollTop = 0;
      return;
    }
    flipping = true;
    bookPage.classList.remove('flip-in-l', 'flip-in-r');
    bookPage.classList.add(forward ? 'flip-out-l' : 'flip-out-r');   // 旧页滑出
    window.setTimeout(() => {
      activeGroup = gid; saveActive(); selectedIndex = -1;
      render({ staggerEnter: true });
      if (bookStage) bookStage.scrollTop = 0;
      // 新页从另一侧滑入
      bookPage.classList.remove('flip-out-l', 'flip-out-r');
      bookPage.classList.add(forward ? 'flip-in-r' : 'flip-in-l');
      void bookPage.offsetHeight;                                    // 强制 reflow 让起始态生效
      bookPage.classList.remove('flip-in-r', 'flip-in-l');           // → 过渡回静止态
      window.setTimeout(() => { flipping = false; }, startBookFlipDoneDelay());
    }, startBookSwapDelay());
  }

  // 相对当前页循环翻 ±1（到尾翻回头、到头翻到尾）。
  function flipBy(delta) {
    // 隐藏特殊页：滚轮只在普通书页（最近 / 收藏 / 自定义分组 / 未分组）之间循环，前置页一律跳过。
    if (specialPagesHidden) {
      const order = pageOrder();
      const N = order.length;
      if (N === 0) return;
      let cur = order.indexOf(activeGroup);
      if (cur < 0) cur = 0;
      let next = (cur + delta) % N;
      if (next < 0) next += N;
      navigateTo(order[next], delta > 0);
      return;
    }
    // 页序（左→右）：复习 ← 日历 ← 活跃热力图 ← 速记 ← 树状 ← 学习 ← 专注 ← 最近 ← 自定义分组…
    if (reviewActive) {
      if (delta > 0) {
        setCalendarActive(true);             // 复习 → 日历
      } else {
        const order = pageOrder();           // 复习 → 最后一张书页，补齐首尾循环
        reviewActive = false;
        calendarActive = false;
        notesActive = false;
        cadenceActive = false;
        treePageActive = false;
        studyActive = false;
        focusActive = false;
        activeGroup = order[order.length - 1] || '';
        saveActive();
        selectedIndex = -1;
        render({ staggerEnter: true });
        showView(listViewName());
        if (bookStage) bookStage.scrollTop = 0;
      }
      return;
    }
    if (calendarActive) {
      if (delta > 0) setCadenceActive(true); // 日历 → 活跃热力图
      else setReviewActive(true);            // 日历 → 复习
      return;
    }
    if (cadenceActive) {
      if (delta > 0) setNotesActive(true);   // 活跃热力图 → 速记
      else setCalendarActive(true);          // 活跃热力图 → 日历
      return;
    }
    if (notesActive) {
      if (delta > 0) setTreePageActive(true); // 速记 → 树状
      else setCadenceActive(true);            // 速记 → 活跃热力图
      return;
    }
    if (treePageActive) {
      if (delta > 0) setStudyActive(true);   // 树状 → 学习
      else setNotesActive(true);             // 树状 → 速记
      return;
    }
    if (studyActive) {
      if (delta > 0) setFocusActive(true);   // 学习 → 专注
      else setTreePageActive(true);          // 学习 → 树状
      return;
    }
    if (focusActive) {
      if (delta > 0) navigateTo('', true);   // 专注 → 最近
      else setStudyActive(true);             // 专注 → 学习
      return;
    }
    if (activeGroup === '' && delta < 0) {
      setFocusActive(true);                  // 最近 → 专注
      return;
    }
    const order = pageOrder();
    const N = order.length;
    if (N === 0) return;
    let cur = order.indexOf(activeGroup);
    if (cur < 0) cur = 0;
    let next = (cur + delta) % N;
    if (next < 0) next += N;
    navigateTo(order[next], delta > 0);     // 动画方向跟随滚动方向，循环也不突兀
  }

  // 两套滚动系统：
  //  · 鼠标在「书页内容区」→ 浏览器原生滚动该组的画布文件（不翻页）
  //  · 鼠标在「左侧书脊附近」→ 滚轮循环翻页
  const spineEl = document.querySelector('.left-spine');
  bindStaticSpineHoverTargets();
  if (spineEl) {
    spineEl.addEventListener('pointerleave', clearSpineHover);
    spineEl.addEventListener('scroll', () => {
      clearSpineHover({ animate: false });
      syncActiveSpineOrb({ animate: false });
    }, { passive: true });
    spineEl.addEventListener('focusout', (event) => {
      if (!spineEl.contains(event.relatedTarget)) clearSpineHover();
    });
  }
  const SPINE_WHEEL_REACH = 140;        // 普通页面：书脊右侧保留一段克制的无形翻页热区
  const NOTES_SPINE_WHEEL_REACH = 224;  // 速记墙会接管滚轮，左侧留出更宽的翻页手势区
  if (spineEl && bookView) {
    bookView.addEventListener('wheel', (e) => {
      if (main.dataset.state !== 'recent' && main.dataset.state !== 'study') return;
      // 缩放和明显的横向手势属于当前页面内容，不参与书脊翻页。
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const spineRect = spineEl.getBoundingClientRect();
      const reach = notesActive ? NOTES_SPINE_WHEEL_REACH : SPINE_WHEEL_REACH;
      if (e.clientX > spineRect.right + reach) return;
      // 速记便签摞自身支持滚轮换张；即使靠近书脊，也优先保留这项局部交互。
      if (notesActive && e.target.closest && e.target.closest('.sticky-note')) return;
      if (e.clientX >= spineRect.left && e.clientX <= spineRect.right
        && spineEl.scrollHeight > spineEl.clientHeight) return;
      e.preventDefault();
      if (flipping) return;
      wheelAccum += e.deltaY;
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => { wheelAccum = 0; }, 200);
      if (Math.abs(wheelAccum) < 24) return;   // 阈值，触控板友好、防误触
      const dir = wheelAccum > 0 ? 1 : -1;
      wheelAccum = 0;
      flipBy(dir);
    }, { passive: false, capture: true });
  }

  if (trashEntry) trashEntry.addEventListener('click', () => { window.location.href = 'trash.html'; });

  // ── 拉取数据 ───────────────────────────────────
  async function refresh() {
    const requestId = ++recentRefreshSeq;
    const preserveSearchResults = librarySearchActive() && fileList.querySelector('.recent-item, .group-empty');
    try {
      const resp = await fetch('/api/recent');
      const json = await resp.json();
      if (requestId !== recentRefreshSeq) return false;
      lastFiles = (json && json.files) || [];
      lastGroups = (json && json.groups) || [];
      recentLimit = Number.isFinite(Number(json && json.recentLimit))
        ? Math.max(1, Number(json.recentLimit)) : 30;
      fileStatsRequestSeq += 1;
      fileStatsCache.clear();
      render(preserveSearchResults ? { searchUpdate: true } : undefined);
      const shouldShowStudy = (initialStudy || studyActive) && !specialPagesHidden;
      const shouldShowCalendar = (initialCalendar || calendarActive) && !specialPagesHidden;
      if (shouldShowCalendar) {
        studyActive = false;
        cadenceActive = false;
        treePageActive = false;
        notesActive = false;
        reviewActive = false;
        focusActive = false;
        calendarActive = true;
        const activateCalendar = () => {
          if (calendarActive && window.CanvasCalendar && window.CanvasCalendar.activate) {
            window.CanvasCalendar.activate();
          }
        };
        if (window.CanvasCalendar) activateCalendar();
        else window.addEventListener('load', activateCalendar, { once: true });
      }
      showView(reviewActive ? 'review'
        : shouldShowCalendar ? 'calendar'
        : notesActive ? 'notes'
        : cadenceActive ? 'cadence'
        : treePageActive ? 'tree'
        : focusActive ? 'focus'
        : shouldShowStudy ? 'study'
        : listViewName());
      studyActive = shouldShowStudy;
      if (shouldShowStudy && window.StudyView && typeof window.StudyView.activate === 'function') {
        window.StudyView.activate();
      }
      if (initialStudy || initialCalendar) {
        try { history.replaceState(null, '', 'index.html'); } catch (e) {}
        initialStudy = false;
        initialCalendar = false;
      }
      return true;
    } catch (err) {
      if (requestId === recentRefreshSeq) showView('empty');
      return false;
    }
  }

  // 整个起步页窗口都是 .canvas 接收区（命中率最大化）：拖到页面任意处 → 导入当前打开的分组；
  // 拖到书脊的分组圆点 → 导入那个组（圆点 drop 会 stopPropagation，不会被这里重复处理）。
  // 内部组间/组内调序拖动用 text/plain，dtHasFiles 为假，完全不受影响。
  function startPageAcceptsCanvasDrop() {
    return activeStartWorkspace === 'canvas'
      && !studyActive && !cadenceActive && !treePageActive && !notesActive && !calendarActive
      && !reviewActive && !focusActive;   // 仅在「最近/分组」列表视图接收
  }
  function setCanvasDropHint(on) {
    if (bookPage) bookPage.classList.toggle('canvas-drop-over', !!on);
  }
  window.addEventListener('dragover', (e) => {
    if (draggingPath || !dtHasFiles(e.dataTransfer)) return;
    e.preventDefault();                                      // 始终拦截，别让浏览器把文件当网页打开
    if (!startPageAcceptsCanvasDrop()) return;
    e.dataTransfer.dropEffect = 'copy';
    setCanvasDropHint(true);
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return;                             // 真正离开窗口才清提示
    setCanvasDropHint(false);
  });
  window.addEventListener('drop', (e) => {
    if (draggingPath || !dtHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setCanvasDropHint(false);
    if (!startPageAcceptsCanvasDrop()) return;
    const gid = targetGroupForActivePage();
    importCanvasFiles(e.dataTransfer.files, gid);
  });

  verifyRuntimeCompatibility();
  setupStartPageActivityTracker();
  refresh();
})();

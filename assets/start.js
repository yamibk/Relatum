// 起步页 — 阶段 3b（自定义分组）+ 左侧分组栏布局
// - /api/recent 返回 {groups, files}
// - 左栏：最近 + 各分组（带数量），点选某组；底部"+ 新建分组"；组右键 改名/删除
// - 右栏：当前选中组的画布列表（点击打开 / 右键 重命名·资源管理器·移除·移动到）
// - 选中的组记在 localStorage；失效文件标记并提示移除

(function () {
  'use strict';

  const main = document.querySelector('.start-main');
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
  const fileList = document.querySelector('[data-role="file-list"]');
  const panelTitle = document.querySelector('[data-role="panel-title"]');
  const recentSyncButton = document.querySelector('[data-action="recent-sync"]');
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
  const calendarCountdownToggle = document.querySelector('[data-role="calendar-countdown-toggle"]');
  const hideSpecialToggle = document.querySelector('[data-role="hide-special-toggle"]');
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
  let draggingPath = null;   // 3c：正在拖拽的文件路径（dataTransfer 的兜底）
  const flashImportPaths = new Set(); // 新导入画布的路径，渲染后各播一次入场动画
  // 3d：键盘归类
  let panelFiles = [];       // 右栏当前显示的文件（= filesOf(activeGroup)）
  let selectedIndex = -1;    // 右栏键盘选中项下标（-1=未选）
  let pendingDeleteIndex = -1; // 右方向键：待确认删除（再按一次右键执行）
  const trashingPaths = new Set(); // 防止右键菜单与键盘对同一画布重复提交
  let studyActive = false;
  let cadenceActive = false;   // 活跃热力图前置页（在学习页更左一格）是否展开
  let notesActive = false;     // 速记便签墙前置页（在活跃页更左一格）是否展开
  let calendarActive = false;  // 日历与日记前置页（在复习与速记之间）是否展开
  let reviewActive = false;    // 复习卡片前置页（最左一格）是否展开
  let focusActive = false;     // 专注钟前置页（学习更右一格、紧邻书页）是否展开
  let pendingFocusActivation = null;
  let pendingFocusReadyActions = [];
  let specialPagesHidden = false; // 「隐藏特殊页」开启：书脊只留普通书页，6 张前置页既不显示也不可翻入
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
  const CALENDAR_COUNTDOWN_KEY = 'canvas:calendarCountdownEnabled';
  const HIDE_SPECIAL_KEY = 'canvas:hideSpecialPages';
  let startTurnSpeed = START_SPEED_DEFAULT;
  let notesInertia = NOTES_INERTIA_DEFAULT;
  let startViewTransitionTimer = 0;
  const START_VIEW_ORDER = { review: 0, calendar: 1, notes: 2, cadence: 3, study: 4, focus: 5, recent: 6, empty: 6, loading: 6 };
  const START_VIEW_MOTION_CLASSES = ['view-entering', 'view-leaving', 'view-motion-forward', 'view-motion-back'];

  function englishUI() {
    return !!(window.RelatumI18n && window.RelatumI18n.language === 'en');
  }

  function preloadEditorBackground(background) {
    if (!background || typeof background !== 'object') return;
    let source = '';
    if (background.type === 'image' && background.path) {
      source = '/api/background-image?path=' + encodeURIComponent(background.path);
    } else if (background.type === 'gradient' && background.preset === 'polar-light') {
      source = '/sky-dark.png';
    }
    if (!source) return;
    const preload = () => {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(preload, { timeout: 1000 });
    } else {
      window.setTimeout(preload, 0);
    }
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

  // 「隐藏特殊页」：开启后书脊只剩普通书页（最近 / 收藏 / 自定义分组）的圆点，
  // 6 张前置页（复习/日历/速记/活跃/学习/专注）的入口被 CSS 收起，滚轮翻页也跳过它们。
  function applyHideSpecialPages(hidden, persist) {
    specialPagesHidden = !!hidden;
    if (hideSpecialToggle) hideSpecialToggle.checked = specialPagesHidden;
    document.body.dataset.hideSpecial = specialPagesHidden ? '1' : '0';
    if (persist) {
      try { localStorage.setItem(HIDE_SPECIAL_KEY, specialPagesHidden ? '1' : '0'); } catch (e) {}
    }
    // 若开启时正停在某张特殊页，立刻退回「最近」，避免卡在已被隐藏、又翻不动的页面上。
    if (specialPagesHidden && (studyActive || cadenceActive || notesActive
        || calendarActive || reviewActive || focusActive)) {
      navigateTo('');
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
  let hideSpecialInit = false;  // 默认关闭：出厂即显示特殊页，只有显式存过 '1' 才隐藏
  try { hideSpecialInit = localStorage.getItem(HIDE_SPECIAL_KEY) === '1'; } catch (e) {}
  applyHideSpecialPages(hideSpecialInit, false);
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
  if (calendarCountdownToggle) {
    calendarCountdownToggle.addEventListener('change', () => {
      applyCalendarCountdownEnabled(calendarCountdownToggle.checked, true);
    });
  }
  if (hideSpecialToggle) {
    hideSpecialToggle.addEventListener('change', () => {
      applyHideSpecialPages(hideSpecialToggle.checked, true);
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

  const START_HELP_PAGES = [
    { id: 'start', eyebrow: '01 · START', title: '起始页', sections: [
      ['开始第一张画布', '右上角可以新建空白画布，也可以把外部 <code>.canvas</code> 或整个画布文件夹复制导入本项目。', [['新建画布', '进入空白画布，在空白处双击创建第一张卡片。'], ['导入画布', '复制一张 <code>.canvas</code> 和同名素材目录，然后打开项目内副本。'], ['导入文件夹', '严格检查并整批导入顶层画布与同名素材。']]],
      ['书脊与翻页', '左侧像书脊一样的入口连接不同页面。最顶端是「速记」灵感墙，往下小矩形是活跃热力图，「学」是学习页，黑色圆点是当前画布页，浅色圆点是其它分组，<strong>+</strong> 用来新建分组。', [['鼠标放在左侧书脊滚轮', '在速记、活跃页、学习页、最近和各分组之间循环翻页。'], ['鼠标放在右侧画布列表滚轮', '只滚动当前页里的文件列表，不会误翻页。'], ['点击圆点', '直接进入对应分组。']]],
      ['速记灵感墙', '书脊最顶端的「速记」是一面与画布、学习任务完全独立的无界面灵感墙。便签、连线、视野会自动保存；深色模式下连线会显示为蓝色荧光。', [['双击空白处', '在落点生成一张随机果冻色便签。'], ['双击便签', '进入文字编辑；按 <kbd>Esc</kbd> 或点到别处结束。'], ['拖动便签', '自由摆放；压到另一张上会叠成一摞，悬停时扇形展开，滚轮可翻动最上面一张。'], ['左键在空白处快速划一刀', '划过便签、连线或箭头即可删除。'], ['右键拖动', '拖出自由箭头；端点落在便签上后会跟随便签移动。'], ['<kbd>Alt</kbd> + 拖动便签', '把一张便签连接到另一张便签。']]],
      ['速记创建与关联', '无需寻找按钮，鼠标位置和当前便签就是新内容的落点。新建后会直接进入输入。', [['<kbd>N</kbd>', '在鼠标位置新建便签；鼠标不在墙面时在视野中央新建。'], ['<kbd>Enter</kbd>', '在当前便签右侧续写一张便签。'], ['<kbd>Shift</kbd> + <kbd>Enter</kbd>', '在当前便签下方续写。'], ['<kbd>Tab</kbd>', '在右侧新建便签并自动连接当前便签。'], ['<kbd>Shift</kbd> + <kbd>Tab</kbd>', '在下方新建便签并自动连接。']]],
      ['速记墙视野', '速记墙可以像画布一样平移、缩放和惯性滑行。左上角齿轮里的「速记惯性」同时控制便签拖动与整面墙拖动的滑行强度。', [['空白处滚轮', '平滑移动整面速记墙。'], ['<kbd>Ctrl</kbd> + 滚轮', '以鼠标所在位置为中心缩放。'], ['<kbd>Shift</kbd> + 滚轮', '横向移动视野。'], ['<kbd>Space</kbd> + 拖动空白处', '抓住整面墙平移，松手后按惯性滑行。'], ['<kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>←</kbd> / <kbd>→</kbd>', '移动视野；按住 <kbd>Shift</kbd> 会更快。'], ['<kbd>0</kbd>', '缩放到可以总览全部便签。'], ['<kbd>F</kbd>', '聚焦当前便签。'], ['再次点击「速记」图标', '回到默认缩放与位置。']]],
      ['速记搜索与键盘整理', '鼠标悬停、最近操作或键盘轮廓所指的便签会成为当前便签。搜索和浏览都不显示工具栏。', [['<kbd>/</kbd>', '进入搜索并直接输入关键词；左侧速记图标会亮起黄色呼吸光圈。'], ['搜索中 <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd>', '跳到下一条 / 上一条匹配结果。'], ['搜索中 <kbd>Esc</kbd>', '退出搜索并恢复全部便签。'], ['<kbd>J</kbd> / <kbd>K</kbd>', '切换下一张 / 上一张便签；屏幕外的便签会自动进入视野。'], ['<kbd>Esc</kbd>', '取消当前便签的键盘轮廓。'], ['<kbd>C</kbd>', '切换当前便签颜色。'], ['<kbd>R</kbd> / <kbd>Shift</kbd> + <kbd>R</kbd>', '随机轻旋 / 摆正当前便签。'], ['<kbd>D</kbd>', '复制当前便签。'], ['<kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Y</kbd>', '撤销 / 重做速记墙操作。']]],
      ['分组与文件整理', '画布卡片不仅可以打开，也可以像桌面文件一样整理。', [['拖动画布卡片到圆点', '把文件归入对应分组。'], ['拖到另一张卡片附近', '调整当前分组里的文件顺序。'], ['右键画布卡片', '重命名、在资源管理器中查看、移动到分组、移到回收站或从列表移除。'], ['右键分组圆点', '重命名或删除分组；删除分组不会删除画布文件。'], ['左侧回收站', '恢复误删画布，或手动清空回收站。']]],
      ['键盘整理', '先按方向键选中一张画布，再继续操作。', [['<kbd>↑</kbd> / <kbd>↓</kbd>', '选择上一张 / 下一张画布。'], ['<kbd>Shift</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd>', '把选中的画布向上 / 向下调整顺序（「最近」自动排序）。'], ['<kbd>Enter</kbd>', '打开选中的画布。'], ['<kbd>1</kbd>–<kbd>9</kbd>', '移到第 1–9 个自定义分组。'], ['<kbd>0</kbd> 或 <kbd>Backspace</kbd>', '移到「未分组」。'], ['<kbd>→</kbd> 再按一次 <kbd>→</kbd>', '二次确认后移到回收站。'], ['<kbd>←</kbd> 或 <kbd>Esc</kbd>', '取消待删除状态。']]],
      ['客户端设置', '起始页右下角齿轮用于设置桌面客户端从最大化恢复后的窗口尺寸。可以选择紧凑、均衡、宽敞，也可以填写自定义宽高。设置会按当前显示器可用区域自动约束。'],
    ]},
    { id: 'study', eyebrow: '02 · STUDY', title: '学习页', sections: [
      ['学习页入口', '点击左侧书脊里的「学」进入学习页；再次点击可以在极简清单和单位进度面板之间切换。左侧书脊最上方的小矩形仍可进入活跃热力图。'],
      ['新建与推进任务', '进度面板右上角的 <strong>+</strong> 可以快速写下任务。进入详情后设置目标总量、单位和任务点，再用卡片上的 −1 / +1 推进；达到目标后仍由你手动标记完成。', [['单击任务卡', '设置或编辑目标与任务点。'], ['左侧圆圈', '手动完成或恢复任务。'], ['已完成', '展开完成区后可以归档。'], ['今日任务', '入口已经预留，面板将在后续版本开放。']]],
      ['轻量详情', '学习任务只保留标题、目标、单位和任务点。专注钟、日历与画布不再绑定学习任务，让这里保持成一张独立、安静的进度清单。'],
      ['归档与回收站', '完成区的「归档」会保存完成记录并清空已完成任务；归档仍计入活跃页。任务回收站支持恢复和永久清空。'],
      ['活跃页与足迹星图', '左侧书脊上方的小矩形进入活跃页：一年完成节奏的热力图，下方还有本月完成、连续推进、累计归档三枚小统计，以及最近归档的任务。再往下是一张「足迹星图」，把已归档的完成任务连成一片个人星空。', [['年份圆点 / 滚轮', '按自然年翻页，分别回看每一年的记录。'], ['正常 / 总览', '正常星图是「我 → 月 → 任务」三层；总览是「我 → 年 → 月 → 任务」四层。'], ['纯回望', '星图只用于回看，不跳转画布——归档后画布已经在回收站里。']]],
    ]},
    { id: 'normal', eyebrow: '03 · NORMAL', title: '普通模式', sections: [
      ['两种普通模式', '新建画布默认进入「简洁普通模式」：顶部只保留最常用入口，让空白更安静。再次点击顶部「普通」，会切换到完整普通模式，显示图谱、脑图、背景、导出 PNG 等按钮。', [['简洁普通模式', '适合专注记录，不被额外控件打扰。'], ['完整普通模式', '适合整理、导出和调用辅助视图。']]],
      ['创建、连接与移动', '普通模式已经覆盖大多数日常操作。', [['双击空白处', '新建卡片节点。'], ['右侧「卡片 / 便签」小浮窗', '完整普通模式下切换接下来新建卡片还是便签；便签正文常驻显示，适合一小段灵感。'], ['<kbd>N</kbd>', '在鼠标附近或视野中心新建节点。'], ['<kbd>Tab</kbd>', '为当前节点创建子节点。'], ['<kbd>Enter</kbd>', '为当前节点创建兄弟节点。'], ['<kbd>Alt</kbd> + 从节点拖动', '创建连线。'], ['<kbd>Space</kbd> + 拖动', '平移视野；滚轮用于锚点缩放。'], ['方向键', '平移视野。']]],
      ['编辑、搜索与保存', '卡片标题适合短句，正文可以承接 Markdown、公式和较长笔记。改动默认会自动保存，右下角齿轮里可以关掉、回到纯手动。', [['<kbd>F2</kbd>', '编辑选中节点标题。'], ['<kbd>F</kbd>', '阅读并编辑正文节点（索引 / 预览 / 卡片 / 便签 / 代码）；选中 PDF 时打开阅读批注浮层。'], ['正文阅读浮层里 <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd>', '钢笔 / 盒子 / 橡皮，在正文上做空间批注；独立保存，不进导出。'], ['<kbd>Ctrl</kbd> + <kbd>F</kbd>', '搜索节点。'], ['<kbd>Ctrl</kbd> + <kbd>S</kbd>', '立即保存（自动保存已开时也可随时手动存）。'], ['<kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Y</kbd>', '撤销 / 重做。'], ['<kbd>Delete</kbd>', '删除选中的节点、连线或装饰。'], ['顶部「清理附件」', '删除当前画布资源文件夹里没有被任何节点引用的图片 / 附件。']]],
      ['正文、公式与选区标注', '正文支持轻量 Markdown 和本地数学公式。编辑节点文字或正文时，选中一段文字会浮出工具栏，可以添加高光、字色和字号；这些标记会随画布保存。', [['<code>## 标题</code>', '二级标题；<code>###</code> 是三级标题。'], ['<code>**加粗**</code> / <code>*斜体*</code>', '基础强调。'], ['<code>- 列表项</code> / <code>1. 列表项</code>', '无序与有序列表。'], ['<code>$E=mc^2$</code> / <code>$$…$$</code>', '行内公式与块级公式。'], ['<code>==高光==</code> / <code>{hl:red|文字}</code>', '默认黄色高光；选区工具栏可切换多种颜色。'], ['<code>{tc:red|文字}</code> / <code>{fs:lg|文字}</code>', '字色与字号标记。'], ['右下角 <strong>fx</strong> 面板', '打开公式 / 符号面板，向正在编辑的标题或正文插入 LaTeX 片段；先选中文字再点结构键会包裹选区。'], ['<code>\\label</code> / <code>\\eqref</code>', '同一段正文里点击公式引用，会跳转并闪烁目标公式。']]],
      ['任务簿节点计时', '任务簿里的叶子任务放到画布后，把鼠标停在节点上，会从节点左侧浮出 <strong>▶</strong>。点击即可开始该节点计时，运行时同一位置显示 <strong>Ⅱ</strong> 用于暂停。'],
      ['左侧工具栏与右下角设置', '鼠标移到画布左缘，会浮出自由书写、橡皮、文字、三种箭头和三种手绘图形。右下角齿轮可以调节方向键平移速度、滚轮缩放速度和手写笔压感。右下角 <strong>?</strong> 仍保留编辑器快捷键速查。'],
      ['脑图自动整理', '在完整普通模式里，先选中需要整理的节点，再点顶部「脑图」。可以选择向右树形、向左树形、向下树形或放射星形。中心节点会优先选择连线最多的那个；没有连线的散节点会自动连接到中心。'],
      ['关系图谱', '顶部「图谱」打开当前画布的只读关系视图。节点会以柔和的力导向动画舒展开，可以拖动、滚轮缩放、双击空白适配视野，也可以点击图谱节点回到原画布位置。顶部还能调透明度、重新舒展或复位。'],
      ['全局背景', '顶部「背景」设置的是所有画布共用的外观，不会改动节点样式。', [['恢复默认纸白', '回到安静的暖纸白。'], ['柔和纯色与渐变', '快速切换低饱和背景。'], ['本地图片', '可调整展示范围、透明度、缩放和构图中心。'], ['标题栏可读性保护', '全屏沉浸背景下，为顶部工具栏增加极淡保护层。']]],
      ['导入与导出', '起始页可以从 Markdown 文件夹导入一张新画布；完整普通模式顶部可以把当前画布导出为一组互相关联的 Markdown 文件，或导出为一张 PNG 图片（PDF 附件不进 PNG）。图案、图片和附件不会进入 Markdown 正文导出。'],
    ]},
    { id: 'pro', eyebrow: '04 · PRO', title: '专业模式', sections: [
      ['它适合什么时候', '专业模式用来设置「接下来新建」的节点与连线默认外观。它不会改动已经存在的对象，适合连续制作同一类内容，例如一组课程概念、一套论文线索或一张流程图。'],
      ['节点类型', '右侧面板可以先选定正文呈现方式。新建节点默认就是卡片。', [['索引', '自动读取相连节点生成目录，适合章节入口与结构导航；按 <kbd>F</kbd> 打开阅读浮层查看目录与正文。'], ['预览', '平时保持简洁，鼠标悬停时展开正文预览；同样支持 <kbd>F</kbd> 阅读。'], ['卡片', '正文常驻显示；适合需要随时扫读的内容。'], ['代码', '直接记录 C / Python / MATLAB 源码，只做语法着色，不解析 Markdown 或公式；节点内、放大浮层、编辑正文都支持 <kbd>Tab</kbd> 缩进、<kbd>Shift</kbd> + <kbd>Tab</kbd> 减少缩进。右下角齿轮可设默认语言。']]],
      ['节点外观', '可以设置矩形、正方形或圆形，并调整边框颜色、背景颜色、透明度与「隐藏节点背景」。这些选择只会套用到之后新建的节点。', [['隐藏节点背景', '适合把文字轻轻放进背景图或大色块上。'], ['背景透明度', '适合做层级更柔和的辅助信息。']]],
      ['连线外观', '连线也有自己的新建默认值。', [['线型', '曲线、直线、折线、圆角折线、S 曲线、平滑曲线。'], ['线条样式', '实线、虚线、点线、荧光。'], ['箭头', '无箭头、单向或双向。'], ['线条粗细与箭头大小', '用于区分主干、辅助关系和强调关系。']]],
      ['一个实用流程', '先在专业模式配好一类节点和连线，再回到画布连续创建。需要修改已经存在的内容时，切到「编辑模式」。面板底部的「全部重置为朴素默认」可以快速回到基础样式。'],
    ]},
    { id: 'edit', eyebrow: '05 · EDIT', title: '编辑模式', sections: [
      ['它适合什么时候', '编辑模式用于精修已经存在的对象。进入后先选中一个或多个节点、连线，再在右侧面板调整。多选时，修改会批量应用。编辑模式不用于新建节点。'],
      ['调整节点', '选中节点后，可以修改形状、边框颜色、背景颜色、透明度、隐藏背景与整体大小。正文节点还可以在索引、预览、卡片之间转换，标题与正文会保留。', [['普通节点转正文节点', '当前内容会完整保存为正文，首行成为可见标题，可撤销。'], ['正文节点转普通节点', '只保留标题并清除正文；操作前会确认。'], ['代码节点语言', '选中代码节点后，可以在面板里把它改成 C / Python / MATLAB；只影响这一个节点。'], ['阅读（F）', '在面板里也可以直接打开正文阅读窗口。']]],
      ['调整连线', '选中连线后，可以修改线型、线条样式、颜色、箭头、粗细和箭头大小。', [['在线身上拖动', '为连线增加拐点。'], ['双击拐点', '删除这个拐点。'], ['清除所有拐点', '让连线恢复为不带手动路径的状态。']]],
      ['批量整理', '先多选同一层级的节点，再统一背景、边框或大小，可以快速建立清晰的信息层级。线条也可以批量统一样式。'],
      ['与专业模式的区别', '专业模式决定「以后新建什么样」；编辑模式负责「把已经存在的内容改成什么样」。'],
    ]},
    { id: 'decor', eyebrow: '06 · DECOR', title: '图案模式', sections: [
      ['插入图案与图片', '右侧面板可以插入虚线框、手绘圆角矩形、手绘菱形和手绘椭圆，也可以选择本地图片。图片还可以直接从电脑拖进画布。', [['图片默认顶层', '新插入图片默认覆盖在文字节点上方。'], ['跨模式移动图片', '图片在普通、专业、编辑、图案模式都可选中、拖动和删除；精细属性仍在图案模式调整。']]],
      ['盒子与色块', '两种快捷装饰适合快速划分区域。', [['空白处左键框选', '框选结束后点击浮动的「+ 盒子」，生成带标题的底层盒子。'], ['空白处右键拖动', '直接创建底层纯色色块。'], ['盒子标题', '可以点击改名、拖动盒子；长按标题可以调整配色与字色。']]],
      ['调整装饰对象', '选中图案或图片后，右侧面板可以调整宽度、高度、旋转角度、透明度和显示图层。图案还能设置边框与填充颜色。', [['底层', '会被文字节点覆盖，适合作为背景分区。'], ['顶层', '覆盖文字节点，适合图片贴纸或需要突出展示的素材。']]],
      ['插入 PDF 与 Markdown 附件', '右侧「插入 PDF / Markdown 附件」按钮可以选择文件，也可以直接把文件拖进画布。附件会复制到当前画布旁的资源文件夹，同一文档按内容去重。', [['拖标题栏', '移动附件节点。'], ['滚动正文区', '在画布内的小框阅读 PDF 或 Markdown 内容。'], ['图案模式', '调整附件节点大小。'], ['双击附件或选中后按 <kbd>F</kbd>', '打开适合长时间阅读的大版浮层。']]],
      ['PDF 阅读与批注', 'PDF 大版阅读浮层支持原文划词、手写和便签。批注会自动保存到 PDF 旁的伴生文件，不会触发画布未保存状态。', [['<kbd>1</kbd>', '只读；此时点击已有标注，可以改色或删除。'], ['<kbd>2</kbd>', '压感钢笔。'], ['<kbd>3</kbd>', '荧光笔。'], ['<kbd>4</kbd>', '橡皮擦，整笔擦除。'], ['<kbd>5</kbd>', '划词高光：选中 PDF 原文添加高光。'], ['<kbd>6</kbd>', '便签：点击页面空白处贴一张便签。'], ['<kbd>7</kbd>', '划词下划线。'], ['<kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Y</kbd>', '撤销 / 重做 PDF 批注。'], ['颜色与粗细', '顶部色点菜单可以调整颜色和笔画大小。'], ['清空本页', '只清除当前页批注。']]],
      ['Markdown 附件阅读与标注', 'Markdown 附件也支持双击或按 <kbd>F</kbd> 打开大版阅读。选中文字可以添加高光、字色和字号；还可以用钢笔手绘，用橡皮擦掉笔迹或文字标注。批注同样保存到附件旁的伴生文件。', [['外部打开', '可以用系统默认程序打开这份 Markdown 副本编辑。'], ['<kbd>1</kbd>', '只读。'], ['<kbd>2</kbd>', '钢笔。'], ['<kbd>3</kbd>', '橡皮擦。'], ['正文变化', '如果在外部改了正文，旧文字标注会自动失效，避免错位。']]],
      ['装饰不会改变内容结构', '图案、图片、盒子、色块与附件不会参与 Markdown 导出。盒子只是视觉分区，不会自动绑定框内节点。'],
    ]},
  ];
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

  function syncStartHelpNav(index, animate) {
    if (!startHelp) return;
    const item = START_HELP_PAGES[index];
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
    const page = startHelp.querySelector('[data-role="start-help-page"]');
    const copy = startHelp.querySelector('[data-role="start-help-page-copy"]');
    const position = startHelp.querySelector('[data-role="start-help-position"]');
    const book = startHelp.querySelector('.start-help-book');
    const item = START_HELP_PAGES[index];
    if (!page || !copy || !item) return;
    const apply = () => {
      copy.innerHTML = '<div class="start-help-page-intro"><p>' + item.eyebrow + '</p><h3>' + item.title
        + '</h3>' + (item.subtitle ? '<span>' + item.subtitle + '</span>' : '') + '</div>'
        + helpDemo(item.id)
        + item.sections.map((section) => '<section class="start-help-section"><h4>' + section[0] + '</h4><p>'
          + section[1] + '</p>' + (section[2] ? '<dl class="start-help-list">'
            + section[2].map((row) => '<div><dt>' + row[0] + '</dt><dd>' + row[1] + '</dd></div>').join('')
            + '</dl>' : '') + '</section>').join('');
      if (position) position.textContent = String(index + 1).padStart(2, '0') + ' / '
        + String(START_HELP_PAGES.length).padStart(2, '0');
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
    const total = START_HELP_PAGES.length;
    const next = ((index % total) + total) % total;
    if (next === startHelpPageIndex) return;
    const direction = index > startHelpPageIndex ? 1 : -1;
    startHelpPageIndex = next;
    renderStartHelpPage(startHelpPageIndex, direction);
  }

  function helpDemo(id) {
    if (id === 'start') {
      return '<div class="start-help-demo demo-start" aria-label="示意动画：书脊滚轮翻页">'
        + '<div class="demo-caption"><strong>左侧滚轮翻页</strong><span>右侧列表仍可独立滚动</span></div>'
        + '<div class="demo-scene"><div class="demo-book-spine"><i></i><i></i><i></i><i></i></div>'
        + '<div class="demo-page-stack"><div class="demo-page demo-page-back"></div><div class="demo-page demo-page-front">'
        + '<b></b><b></b><b></b></div></div><div class="demo-wheel"><em></em></div></div></div>'
        + '<div class="start-help-demo demo-notes" aria-label="示意动画：速记墙划一刀删除便签">'
        + '<div class="demo-caption"><strong>速记墙：划一刀删便签</strong><span>想法随手记，划掉就走</span></div>'
        + '<div class="demo-scene"><div class="demo-note demo-note-a"></div><div class="demo-note demo-note-b"></div>'
        + '<div class="demo-note demo-note-c"></div><div class="demo-slash"></div></div></div>';
    }
    if (id === 'study') {
      return '<div class="start-help-demo demo-study" aria-label="示意动画：拖动任务卡调整顺序">'
        + '<div class="demo-caption"><strong>拖动任务排序</strong><span>相邻任务会安静地为它让位</span></div>'
        + '<div class="demo-scene"><div class="demo-sort-list"><i></i><i></i><i></i></div>'
        + '<div class="demo-task-card"><b></b><small></small></div></div></div>'
        + '<div class="start-help-demo demo-starmap" aria-label="示意动画：足迹星图放射展开">'
        + '<div class="demo-caption"><strong>足迹星图</strong><span>完成的任务连成一片星空</span></div>'
        + '<div class="demo-scene"><span class="demo-star-link demo-star-link-1"></span>'
        + '<span class="demo-star-link demo-star-link-2"></span><span class="demo-star-link demo-star-link-3"></span>'
        + '<div class="demo-star-month demo-star-m1"></div><div class="demo-star-month demo-star-m2"></div>'
        + '<div class="demo-star-month demo-star-m3"></div>'
        + '<i class="demo-star-leaf demo-star-leaf-1"></i><i class="demo-star-leaf demo-star-leaf-2"></i>'
        + '<i class="demo-star-leaf demo-star-leaf-3"></i><i class="demo-star-leaf demo-star-leaf-4"></i>'
        + '<div class="demo-star-core">我</div></div></div>';
    }
    if (id === 'normal') {
      return '<div class="start-help-demo demo-pan-canvas" aria-label="示意动画：按住空格拖动或用方向键移动画布">'
        + '<div class="demo-caption"><strong>按住空格拖动，或用方向键移动画布</strong><span>节点会作为参照一起移动</span></div>'
        + '<div class="demo-scene"><div class="demo-pan-stage">'
        + '<div class="demo-pan-node demo-pan-a">定义</div><div class="demo-pan-node demo-pan-b">例题</div>'
        + '<div class="demo-pan-node demo-pan-c">总结</div><i></i><i></i></div>'
        + '<div class="demo-pan-cursor"></div><div class="demo-pan-space">Space</div>'
        + '<div class="demo-pan-keys"><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd></div></div></div>'
        + '<div class="start-help-demo demo-normal" aria-label="示意动画：创建卡片并连接子节点">'
        + '<div class="demo-caption"><strong>双击创建，Alt 拖动连线</strong><span>先记下一点，再把思路连起来</span></div>'
        + '<div class="demo-scene"><div class="demo-normal-edge" aria-hidden="true"></div>'
        + '<div class="demo-canvas-node demo-normal-main"><b>课程重点</b><small></small></div>'
        + '<div class="demo-canvas-node demo-normal-child"><b>补充笔记</b><small></small></div>'
        + '<div class="demo-normal-cursor"></div><div class="demo-normal-hint">Alt</div></div></div>'
        + '<div class="start-help-demo demo-node-task" aria-label="示意动画：悬停节点后浮出添加任务入口">'
        + '<div class="demo-caption"><strong>悬停节点，快速补一条任务</strong><span>不用离开当前思路</span></div>'
        + '<div class="demo-scene"><div class="demo-task-node"><b>复习线性代数</b><small></small></div>'
        + '<div class="demo-task-hover">+ 任务</div><div class="demo-task-cursor"></div>'
        + '<div class="demo-task-added"><i></i><span>整理例题</span></div></div></div>'
        + '<div class="start-help-demo demo-formula" aria-label="示意动画：fx 面板插入公式">'
        + '<div class="demo-caption"><strong>fx 面板，插入公式</strong><span>选中文字再点，会包住选区</span></div>'
        + '<div class="demo-scene"><div class="demo-fx-node"><u></u><span class="demo-fx-eq">E=mc²</span></div>'
        + '<div class="demo-fx-panel"><b>fx</b><i></i><i></i><i></i></div>'
        + '<div class="demo-fx-cursor"></div></div></div>';
    }
    if (id === 'pro') {
      return '<div class="start-help-demo demo-pro" aria-label="示意动画：设置样式后连续创建同类节点">'
        + '<div class="demo-caption"><strong>先定风格，再连续创建</strong><span>新节点会沿用同一套外观</span></div>'
        + '<div class="demo-scene"><div class="demo-pro-panel"><i></i><i></i><i></i><i></i></div>'
        + '<div class="demo-pro-arrow">→</div><div class="demo-pro-stage">'
        + '<div class="demo-pro-node"><b></b><small></small></div><div class="demo-pro-node"><b></b><small></small></div>'
        + '<div class="demo-pro-node"><b></b><small></small></div></div></div></div>'
        + '<div class="start-help-demo demo-code" aria-label="示意动画：代码节点逐行着色">'
        + '<div class="demo-caption"><strong>代码节点，自动着色</strong><span>只高亮语法，不解析 Markdown 或公式</span></div>'
        + '<div class="demo-scene"><div class="demo-code-card"><span class="demo-code-lang">C</span>'
        + '<div class="demo-code-body"><u class="demo-code-row"><i></i><i></i><i></i></u>'
        + '<u class="demo-code-row"><i></i><i></i></u><u class="demo-code-row"><i></i><i></i><i></i></u>'
        + '<u class="demo-code-row"><i></i></u></div><em class="demo-code-caret"></em></div></div></div>';
    }
    if (id === 'edit') {
      return '<div class="start-help-demo demo-edit" aria-label="示意动画：多选节点后批量调整样式">'
        + '<div class="demo-caption"><strong>多选后一起精修</strong><span>一次调整，统一同层级信息</span></div>'
        + '<div class="demo-scene"><div class="demo-edit-select"></div><div class="demo-edit-stage">'
        + '<div class="demo-edit-node"><b></b></div><div class="demo-edit-node"><b></b></div>'
        + '<div class="demo-edit-node"><b></b></div></div><div class="demo-edit-panel"><span></span><i></i><i></i><i></i></div>'
        + '<div class="demo-edit-cursor"></div></div></div>';
    }
    if (id === 'decor') {
      return '<div class="start-help-demo demo-image-drop" aria-label="示意动画：把本地图片拖入画布">'
        + '<div class="demo-caption"><strong>把本地图片直接拖进画布</strong><span>松手后自动放在鼠标落点</span></div>'
        + '<div class="demo-scene"><div class="demo-image-file"><i></i><b></b><small>图片</small></div>'
        + '<div class="demo-image-cursor"></div><div class="demo-image-dropzone"></div>'
        + '<div class="demo-image-result"><i></i><b></b></div></div></div>'
        + '<div class="start-help-demo demo-box-create" aria-label="示意动画：框选生成盒子，右键拖出色块">'
        + '<div class="demo-caption"><strong>框选变盒子，右键拖出色块</strong><span>快速划分一块视觉区域</span></div>'
        + '<div class="demo-scene"><div class="demo-box-selection"></div><div class="demo-box-button">+ 盒子</div>'
        + '<div class="demo-box-result"><b>本周重点</b></div><div class="demo-color-block"></div>'
        + '<div class="demo-box-cursor"></div><div class="demo-box-mouse">右键</div></div></div>'
        + '<div class="start-help-demo demo-pdf" aria-label="示意动画：PDF 划词高光与便签">'
        + '<div class="demo-caption"><strong>PDF 划词与便签</strong><span>标注随附件自动保存</span></div>'
        + '<div class="demo-scene"><div class="demo-pdf-page"><i></i><i></i><i></i><i></i><span></span></div>'
        + '<div class="demo-pdf-note">下一步</div><div class="demo-pdf-cursor"></div></div></div>';
    }
    return '';
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

  function setStartHelpOpen(open) {
    if (!startHelp) return;
    startHelp.hidden = !open;
    if (startHelpTrigger) startHelpTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('start-help-open', open);
    if (open) {
      closeContextMenu();
      startHelpNavReady = false;
      renderStartHelpPage(startHelpPageIndex);
      armStartHelpBlur();
      const close = startHelp.querySelector('[data-action="start-help-close"]');
      if (close) close.focus();
    } else {
      stopStartHelpInertia();
      if (startHelpDemoObserver) { startHelpDemoObserver.disconnect(); startHelpDemoObserver = null; }
      if (startHelpTrigger) startHelpTrigger.focus();
    }
  }

  window.CanvasStartHelp = {
    open(pageId) {
      const index = START_HELP_PAGES.findIndex((item) => item.id === pageId);
      if (index >= 0) startHelpPageIndex = index;
      setStartHelpOpen(true);
    },
  };

  const START_HELP_SEEN_KEY = 'canvas:startHelpClicked:v1';

  function markStartHelpSeen() {
    try { localStorage.setItem(START_HELP_SEEN_KEY, '1'); } catch (e) {}
    if (startHelpTrigger) startHelpTrigger.classList.remove('has-unread');
  }

  if (startHelpTrigger) {
    // TODO: 新手指引已过时暂时禁用，红点也一并屏蔽；后续重做后恢复原逻辑
    // let startHelpSeen = false;
    // try { startHelpSeen = localStorage.getItem(START_HELP_SEEN_KEY) === '1'; } catch (e) {}
    // startHelpTrigger.classList.toggle('has-unread', !startHelpSeen);
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
        const index = START_HELP_PAGES.findIndex((item) => item.id === button.dataset.helpPage);
        if (index >= 0) gotoStartHelpPage(index);
      });
    });
    const prev = startHelp.querySelector('[data-action="start-help-prev"]');
    const next = startHelp.querySelector('[data-action="start-help-next"]');
    if (prev) prev.addEventListener('click', () => gotoStartHelpPage(startHelpPageIndex - 1));
    if (next) next.addEventListener('click', () => gotoStartHelpPage(startHelpPageIndex + 1));
    const helpSpine = startHelp.querySelector('.start-help-spine');
    if (helpSpine) helpSpine.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (startHelpFlipping) return;
      startHelpWheelAccum += event.deltaY;
      clearTimeout(startHelpWheelResetTimer);
      startHelpWheelResetTimer = window.setTimeout(() => { startHelpWheelAccum = 0; }, 200);
      if (Math.abs(startHelpWheelAccum) < 24) return;
      const direction = startHelpWheelAccum > 0 ? 1 : -1;
      startHelpWheelAccum = 0;
      gotoStartHelpPage(startHelpPageIndex + direction);
    }, { passive: false });
    const helpBook = startHelp.querySelector('.start-help-book');
    if (helpBook) helpBook.addEventListener('wheel', (event) => {
      if (prefersReduced || event.ctrlKey) return;
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
    // TODO: 新手指引已过时，暂时禁用 ? 快捷键，后续重做后再启用
    // if (!typing && event.key === '?') {
    //   event.preventDefault();
    //   event.stopImmediatePropagation();
    //   setStartHelpOpen(true);
    // }
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
  const desktopSizeForm = document.querySelector('[data-role="desktop-size-form"]');
  const desktopSizeHint = document.querySelector('[data-role="desktop-size-hint"]');
  const desktopPresetButtons = Array.from(document.querySelectorAll('[data-role="desktop-size-presets"] button'));
  const starmapMotionRanges = Array.from(document.querySelectorAll('[data-role="starmap-motion-range"]'));
  const starmapMotionToggles = Array.from(document.querySelectorAll('[data-role="starmap-motion-toggle"]'));
  const starmapMotionResets = Array.from(document.querySelectorAll('[data-action="starmap-motion-reset"]'));
  const starmapMotionValues = Array.from(document.querySelectorAll('[data-role="starmap-motion-value"]'));
  const STARMAP_MOTION_KEY = 'canvas:starmapMotion:v1';
  const STARMAP_MOTION_DEFAULTS = Object.freeze({
    introMs: 1080,
    introStagger: 60,
    alphaReheat: 0.20,
    velocityDamp: 0.88,
    introVelocityClamp: 10,
    finalFitOnConverge: false,
  });
  let starmapMotionNotifyTimer = 0;

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
    if (!desktopSettings || !window.CanvasDesktop) return;
    desktopSettings.hidden = false;
    syncStarmapMotionForm();
    try {
      syncDesktopSizeForm(await window.CanvasDesktop.getRestoredSize());
    } catch (e) {}
  }

  function closeDesktopSettings() {
    if (desktopSettings) desktopSettings.hidden = true;
  }

  if (desktopSettingsOpen) desktopSettingsOpen.addEventListener('click', openDesktopSettings);
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
    if (name === 'notes') return document.querySelector('.notes-embedded');
    return bookStage;
  }

  function syncStartViewLifecycle(name, previous) {
    const layers = [
      ['recent', bookStage],
      ['study', document.querySelector('.study-embedded')],
      ['cadence', document.querySelector('.cadence-embedded')],
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

  function clearStartViewMotion() {
    [bookStage, document.querySelector('.study-embedded'), document.querySelector('.cadence-embedded'),
      document.querySelector('.notes-embedded'), document.querySelector('.calendar-embedded'),
      document.querySelector('.review-embedded'),
      document.querySelector('.focus-embedded')].forEach((el) => {
      if (el) el.classList.remove(...START_VIEW_MOTION_CLASSES);
    });
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
    const layout = (name === 'cadence' || name === 'notes' || name === 'calendar'
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
      bookView.classList.toggle('notes-active', name === 'notes');
      bookView.classList.toggle('calendar-active', name === 'calendar');
      bookView.classList.toggle('review-active', name === 'review');
      bookView.classList.toggle('focus-active', name === 'focus');
    }
    document.querySelectorAll('.study-spine-tab:not(.cadence-spine-tab):not(.notes-spine-tab):not(.calendar-spine-tab):not(.review-spine-tab):not(.focus-spine-tab)').forEach((button) => {
      button.classList.toggle('active', name === 'study');
    });
    document.querySelectorAll('.focus-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'focus');
    });
    document.querySelectorAll('.cadence-spine-tab').forEach((button) => {
      button.classList.toggle('active', name === 'cadence');
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
      dot.classList.toggle('active', name !== 'study' && name !== 'cadence' && name !== 'notes'
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
      clearCadenceEntrance(true);
    }
    if (name !== 'calendar' && window.CanvasCalendar && window.CanvasCalendar.deactivate) {
      window.CanvasCalendar.deactivate();
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

  function placeSpineHover(target) {
    if (!target) return;
    const bubble = target.querySelector('.dot-bubble');
    if (bubble) {
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

    spine.style.setProperty('--spine-hover-color', color[0]);
    spine.style.setProperty('--spine-hover-glow', color[1]);
    spine.classList.toggle('spine-hover-current', target.classList.contains('active'));
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
    spine.classList.add('spine-hovering');
  }

  function clearSpineHover() {
    const spine = document.querySelector('.left-spine');
    if (spine) spine.classList.remove('spine-hovering', 'spine-hover-current');
    scheduleSpineBreathe();
  }

  function scheduleSpineBreathe() {
    if (!spineActiveOrb) return;
    if (spineBreatheTimer) clearTimeout(spineBreatheTimer);
    spineActiveOrb.classList.remove('orb-breathing');
    spineBreatheTimer = window.setTimeout(() => {
      spineBreatheTimer = 0;
      const spine = spineActiveOrb.closest('.left-spine');
      if (!spine || spine.classList.contains('spine-hovering')) return;
      spineActiveOrb.classList.add('orb-breathing');
    }, 2800);
  }

  function bindSpineHoverTarget(target) {
    if (!target || target.dataset.spineHoverBound === '1') return;
    target.dataset.spineHoverBound = '1';
    target.addEventListener('pointerenter', () => placeSpineHover(target));
    target.addEventListener('focus', () => placeSpineHover(target));
  }

  function bindStaticSpineHoverTargets() {
    document.querySelectorAll('.left-spine .study-spine-tab').forEach(bindSpineHoverTarget);
  }

  function syncActiveSpineOrb() {
    if (!spineActiveOrb) return;
    if (spineBreatheTimer) clearTimeout(spineBreatheTimer);
    spineBreatheTimer = 0;
    spineActiveOrb.classList.remove('orb-breathing');
    const active = document.querySelector('.study-spine-tab.active')
      || (!studyActive && !cadenceActive && !notesActive && !calendarActive
        && !reviewActive && !focusActive ? dots.querySelector('.page-dot.active') : null);
    if (!active) {
      spineActiveOrb.classList.remove('show');
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
    scheduleSpineBreathe();
  }

  // 桌面客户端最大化 / 还原会改变书脊的垂直居中位置。
  // 合并连续 resize，确保滑动高亮块始终贴住当前入口。
  let spineOrbResizeFrame = 0;
  window.addEventListener('resize', () => {
    if (spineOrbResizeFrame) cancelAnimationFrame(spineOrbResizeFrame);
    spineOrbResizeFrame = requestAnimationFrame(() => {
      spineOrbResizeFrame = 0;
      syncActiveSpineOrb();
    });
  });

  function listViewName() {
    return lastFiles.length === 0 && lastGroups.length === 0 ? 'empty' : 'recent';
  }

  let cadenceEnterTimer = 0;
  let cadenceEnterDelayTimer = 0;
  let cadenceEnterFrame = 0;
  let cadenceEntranceSeq = 0;
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
      if (cadence) cadence.classList.remove('cadence-entering', 'cadence-staging');
    }
  }
  function stageCadenceEntrance() {
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
    cadenceEntranceSeq++;
    clearCadenceEntrance(true);
    showView(listViewName());
    if (bookStage) bookStage.scrollTop = 0;
  }

  function setNotesActive(active) {
    notesActive = !!active;
    if (notesActive) {
      studyActive = false;
      cadenceActive = false;
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
      const visibleItems = new Map(Array.from(fileList.querySelectorAll('.recent-item'))
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
    const items = Array.from(fileList.querySelectorAll('.recent-item'));
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
      if (!studyActive && !cadenceActive && !notesActive && !calendarActive
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
    if (panelTitle) {
      panelTitle.toggleAttribute('data-user-content', activeGroup !== ''
        && activeGroup !== FAVORITES_PAGE && activeGroup !== INBOX_PAGE);
      panelTitle.textContent = nameOf(activeGroup);
    }
    if (recentSyncButton) recentSyncButton.hidden = activeGroup !== INBOX_PAGE;
    if (fileStatsObserver) fileStatsObserver.disconnect();
    fileList.innerHTML = '';
    panelFiles = filesOf(activeGroup);
    fileList.classList.toggle('is-large-list', panelFiles.length > LARGE_LIST_THRESHOLD);
    if (panelFiles.length === 0) {
      selectedIndex = -1;
      const empty = document.createElement('li');
      empty.className = 'group-empty soft-enter';
      empty.textContent = activeGroup === ''
        ? '（还没有最近打开的画布）'
        : activeGroup === FAVORITES_PAGE
          ? '（还没有收藏的画布）'
          : activeGroup === INBOX_PAGE
            ? '（还没有未分组的画布）'
            : '（空 — 拖文件进来，或右键画布选「移动到」）';
      fileList.appendChild(empty);
      return;
    }
    if (selectedIndex >= panelFiles.length) selectedIndex = panelFiles.length - 1;
    panelFiles.forEach((f, i) => {
      const li = buildFileItem(f);
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

  // 当前"活跃"文件项（排除正在飞出动画的），其顺序与 panelFiles 对齐
  function activeItems() {
    return fileList.querySelectorAll('.recent-item:not(.leaving)');
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
      toggleFavorite(f, li);
    });
    favorite.addEventListener('keydown', (e) => e.stopPropagation());
    li.append(title, meta, favorite);

    const activate = () => activateFileItem(f, li);

    li.addEventListener('click', activate);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelPendingDelete();
      const index = panelFiles.findIndex((item) => item.path === f.path);
      if (index >= 0) {
        selectedIndex = index;
        refreshSelectionHighlight();
      }
      openFileMenu(e.clientX, e.clientY, f, li);
    });

    // 3c：拖拽到左栏某个分组 → 移动；文件状态由懒加载统计动态更新。
    li.addEventListener('dragstart', (e) => {
      if (f.exists === false) { e.preventDefault(); return; }
      draggingPath = f.path;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', f.path); } catch (err) {}
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
      if (activeGroup === '' || !draggingPath || draggingPath === f.path) return;
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
      if (activeGroup === '' || !draggingPath || draggingPath === f.path) return;
      e.preventDefault();
      e.stopPropagation();
      const before = li.classList.contains('drop-before');
      li.classList.remove('drop-before', 'drop-after');
      const src = draggingPath;
      draggingPath = null;
      reorderByDrag(src, f.path, before);
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
    if (activeGroup === FAVORITES_PAGE && !next) {
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
  // 「页」= [复习, 日历, 速记, 活跃, 学习, 专注, 最近, 收藏, ...自定义分组]。
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
    if (studyActive || cadenceActive || notesActive || calendarActive || reviewActive || focusActive) {
      activeGroup = gid; saveActive(); selectedIndex = -1;
      studyActive = false;
      cadenceActive = false;
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
    // 页序（左→右）：复习 ← 日历 ← 速记 ← 活跃热力图 ← 学习 ← 专注 ← 最近 ← 自定义分组…
    if (reviewActive) {
      if (delta > 0) {
        setCalendarActive(true);             // 复习 → 日历
      } else {
        const order = pageOrder();           // 复习 → 最后一张书页，补齐首尾循环
        reviewActive = false;
        calendarActive = false;
        notesActive = false;
        cadenceActive = false;
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
      if (delta > 0) setNotesActive(true);   // 日历 → 速记
      else setReviewActive(true);            // 日历 → 复习
      return;
    }
    if (notesActive) {
      if (delta > 0) setCadenceActive(true); // 速记 → 活跃热力图
      else setCalendarActive(true);          // 速记 → 日历
      return;
    }
    if (cadenceActive) {
      if (delta > 0) setStudyActive(true);   // 热力图 → 学习
      else setNotesActive(true);             // 热力图 → 速记
      return;
    }
    if (studyActive) {
      if (delta > 0) setFocusActive(true);   // 学习 → 专注
      else setCadenceActive(true);           // 学习 → 活跃热力图
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
      clearSpineHover();
      syncActiveSpineOrb();
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
      render();
      const shouldShowStudy = (initialStudy || studyActive) && !specialPagesHidden;
      const shouldShowCalendar = (initialCalendar || calendarActive) && !specialPagesHidden;
      if (shouldShowCalendar) {
        studyActive = false;
        cadenceActive = false;
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
    return !studyActive && !cadenceActive && !notesActive && !calendarActive
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
  refresh();
})();

// 桌面版窗口外壳：仅在 desktop=1 的 pywebview 窗口中显示。
// 页面内容和画布交互保持原样，只将已有顶栏变成可拖动的无边框标题栏。
(function () {
  'use strict';

  // Ambient backgrounds should rest while the page is hidden. Browsers usually
  // throttle background tabs already, but the explicit state also covers desktop WebView2.
  function syncAmbientMotion() {
    document.documentElement.classList.toggle('ambient-motion-paused', document.hidden);
  }
  syncAmbientMotion();
  document.addEventListener('visibilitychange', syncAmbientMotion);

  const params = new URLSearchParams(window.location.search);
  let desktop = params.get('desktop') === '1';
  try {
    if (desktop) sessionStorage.setItem('canvas:desktop', '1');
    else desktop = sessionStorage.getItem('canvas:desktop') === '1';
  } catch (e) {}
  if (!desktop) return;

  document.documentElement.classList.add('desktop-host');
  document.body.classList.add('desktop-host');

  const bar = document.querySelector('.editor-top-bar, .top-bar');
  if (!bar) return;
  bar.classList.add('desktop-title-bar', 'pywebview-drag-region');

  let pendingDirty = false;
  const apiWaiters = [];

  // pywebview 桥接「真正就绪」的判定：EXE 冷启动有一小段 window.pywebview.api 已存在、
  // 但具体方法尚未注入的窗口期；只判断 api 是否存在会误判为就绪，调用方法时同步抛
  // TypeError(api.xxx is not a function)，异常冒泡会打断画布加载收尾（markClean →
  // setupRename 被跳过 → 误报「加载失败」且标题改不了名）。必须探到真实方法已是函数才算就绪。
  function bridgeReady() {
    try {
      return !!(window.pywebview && window.pywebview.api
        && typeof window.pywebview.api.set_dirty === 'function');
    } catch (e) { return false; }  // 连访问 api 都出错时按「未就绪」处理，绝不抛
  }

  function flushApiWaiters() {
    const waiters = apiWaiters.splice(0, apiWaiters.length);
    waiters.forEach((fn) => {
      try { fn(window.pywebview.api); } catch (e) { /* 桥接调用失败不应中断页面 */ }
    });
  }
  window.addEventListener('pywebviewready', flushApiWaiters, { once: true });

  // 桥就绪才直接调用；未就绪先排队，等 pywebviewready 再统一冲刷。即便就绪判断有偏差，
  // try/catch 也兜底，绝不让桥接异常冒泡到调用方（如加载收尾里的 markClean）。
  function withApi(fn) {
    if (bridgeReady()) {
      try { fn(window.pywebview.api); } catch (e) { /* 同上：静默吞掉，避免打断页面 */ }
      return;
    }
    apiWaiters.push(fn);
  }

  function callApi(method, ...args) {
    return new Promise((resolve, reject) => {
      withApi((api) => {
        try { Promise.resolve(api[method](...args)).then(resolve, reject); }
        catch (e) { reject(e); }
      });
    });
  }

  window.CanvasDesktop = {
    setDirty(value) {
      pendingDirty = !!value;
      // 冷启动期间 dirty 会高频变化，只保留最终值；pywebviewready 处理器会统一同步。
      // 否则每次键入都排一个闭包，桥接就绪时又集中发出数百次重复调用。
      if (bridgeReady()) withApi((api) => api.set_dirty(pendingDirty));
    },
    getRestoredSize() {
      return callApi('get_restored_size');
    },
    setRestoredSize(width, height) {
      return callApi('set_restored_size', width, height);
    },
    getCountdownWallpaperState() {
      return callApi('get_countdown_wallpaper_state');
    },
    startCountdownWallpaper(eventId, language) {
      return callApi('start_countdown_wallpaper', eventId, language);
    },
    stopCountdownWallpaper() {
      return callApi('stop_countdown_wallpaper');
    },
  };

  const controls = document.createElement('div');
  controls.className = 'desktop-window-controls';
  controls.setAttribute('aria-label', '窗口控制');
  controls.innerHTML = [
    '<button type="button" class="desktop-window-btn" data-window-action="minimize" title="最小化" aria-label="最小化"><span class="desktop-minus"></span></button>',
    '<button type="button" class="desktop-window-btn" data-window-action="maximize" title="最大化或还原" aria-label="最大化或还原"><span class="desktop-square"></span></button>',
    '<button type="button" class="desktop-window-btn desktop-window-close" data-window-action="close" title="关闭" aria-label="关闭"><span class="desktop-cross"></span></button>',
  ].join('');
  bar.appendChild(controls);

  // pywebview 会沿祖先向上寻找拖动区，顶栏内的交互元素需要拦住冒泡，否则在桌面 EXE 里
  // 按住它们拖动会变成拖动整个窗口。除了常规控件，还要拦顶栏里的浮层弹窗（如「模板」下拉
  // role="menu"）——其内部卡片是自定义指针拖拽的 <div>，不在标签白名单里，必须按 role 一并拦住，
  // 否则拖模板卡片会拖动窗口。
  bar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button, input, select, textarea, a, [contenteditable], .editor-file-name, [role="menu"], [role="dialog"], [role="listbox"]')) {
      event.stopPropagation();
    }
  });

  let windowTransitioning = false;

  function setMaximized(maximized) {
    document.documentElement.classList.toggle('desktop-maximized', maximized);
    document.body.classList.toggle('desktop-maximized', maximized);
  }

  function setWindowTransitioning(value) {
    windowTransitioning = value;
    document.documentElement.classList.toggle('desktop-window-transitioning', value);
    document.body.classList.toggle('desktop-window-transitioning', value);
  }

  function toggleMaximize() {
    if (windowTransitioning) return;
    setWindowTransitioning(true);
    withApi((api) => {
      api.toggle_maximize().then((state) => {
        const maximized = !!(state && state.maximized);
        setMaximized(maximized);
      }).finally(() => setWindowTransitioning(false));
    });
  }

  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-window-action]');
    if (!button) return;
    const action = button.dataset.windowAction;
    if (action === 'minimize') withApi((api) => api.minimize());
    else if (action === 'maximize') toggleMaximize();
    else if (action === 'close') withApi((api) => api.close_window());
  });

  bar.addEventListener('dblclick', (event) => {
    if (!event.target.closest('button, input, select, textarea, a, [contenteditable], .editor-file-name')) {
      toggleMaximize();
    }
  });

  window.addEventListener('pywebviewready', () => {
    if (window.pywebview && window.pywebview.api) {
      window.pywebview.api.set_dirty(pendingDirty);
      window.pywebview.api.get_window_state().then((state) => {
        setMaximized(!!(state && state.maximized));
      });
    }
  }, { once: true });
})();

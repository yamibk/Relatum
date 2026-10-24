// Shared workspace lifecycle; used with and without the canvas homepage.
(function () {
  'use strict';
  // One scheduler for both homepage shells. It sleeps entirely when nobody is waiting.
  function createBackgroundPreparation() {
    const lifetime = new AbortController(), waiters = new Set(), documents = new Set();
    const events = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'scroll', 'keydown',
      'input', 'compositionstart', 'compositionupdate', 'compositionend', 'touchstart', 'touchmove'];
    let lastActivity = performance.now(), busy = 0, timer = 0, idleHandle = 0, observer = null;
    const abortError = () => new DOMException('Background preparation cancelled', 'AbortError');
    function cancelWake() {
      clearTimeout(timer); timer = 0;
      if (idleHandle) window.cancelIdleCallback(idleHandle);
      idleHandle = 0;
    }
    function quiet() {
      return !lifetime.signal.aborted && document.readyState === 'complete'
        && !document.hidden && document.documentElement.dataset.desktopMinimized !== '1'
        && document.hasFocus() && !busy && !window.CanvasNoteWorkspace?.backgroundBusy
        && performance.now() - lastActivity >= 1500
        && !navigator.scheduling?.isInputPending?.({ includeContinuous: true });
    }
    function settle(entry, error, deadline) {
      waiters.delete(entry); entry.signal?.removeEventListener('abort', entry.abort);
      if (error) entry.reject(error); else entry.resolve(deadline);
    }
    function pump(deadline) {
      idleHandle = 0; timer = 0;
      for (const entry of Array.from(waiters)) {
        if (lifetime.signal.aborted || entry.signal?.aborted) settle(entry, abortError());
        else if (entry.foreground?.()) settle(entry, null, deadline);
        else if (quiet() && deadline && deadline.timeRemaining() >= 1) settle(entry, null, deadline);
      }
      wake();
    }
    function wake() {
      cancelWake();
      if (!waiters.size || lifetime.signal.aborted) return;
      for (const entry of Array.from(waiters)) {
        if (entry.foreground?.()) settle(entry, null, null);
      }
      if (!waiters.size || document.hidden || document.documentElement.dataset.desktopMinimized === '1'
          || !document.hasFocus() || busy) return;
      if (window.CanvasNoteWorkspace?.backgroundBusy) {
        timer = setTimeout(() => pump(null), 250); return;
      }
      const delay = Math.max(0, 1500 - (performance.now() - lastActivity));
      if (delay || document.readyState !== 'complete') {
        timer = setTimeout(() => pump(null), Math.max(100, delay)); return;
      }
      if (window.requestIdleCallback) idleHandle = window.requestIdleCallback(pump);
      else timer = setTimeout(() => {
        const end = performance.now() + 4;
        pump({ timeRemaining: () => Math.max(0, end - performance.now()) });
      }, 250);
    }
    function touch() { lastActivity = performance.now(); wake(); }
    function beginBusy() {
      busy++; touch();
      let released = false;
      return () => { if (!released) { released = true; busy--; touch(); } };
    }
    function waitForIdle(signal, foreground) {
      if (lifetime.signal.aborted || signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const entry = { signal, foreground, resolve, reject, abort: null };
        entry.abort = () => { settle(entry, abortError()); wake(); };
        signal?.addEventListener('abort', entry.abort, { once: true });
        waiters.add(entry); wake();
      });
    }
    function observeDocument(target) {
      if (documents.has(target)) return;
      documents.add(target);
      events.forEach(name => target.addEventListener(name, touch, { capture: true, passive: true, signal: lifetime.signal }));
    }
    observeDocument(document);
    ['focus', 'blur', 'load'].forEach(name => window.addEventListener(name, touch, { signal: lifetime.signal }));
    document.addEventListener('visibilitychange', touch, { signal: lifetime.signal });
    window.addEventListener('canvasdesktop:visibility', touch, { signal: lifetime.signal });
    try {
      observer = new PerformanceObserver(() => touch());
      observer.observe({ type: 'longtask', buffered: false });
    } catch (_) {}
    window.addEventListener('pagehide', () => {
      lifetime.abort(); cancelWake(); observer?.disconnect(); documents.clear();
      for (const entry of Array.from(waiters)) settle(entry, abortError());
    }, { once: true });
    return Object.freeze({ waitForIdle, beginBusy, touch, wake, observeDocument, signal: lifetime.signal });
  }
  window.RelatumWorkspaceRuntime = Object.freeze({ create(config) {
  const features = window.RelatumFeatureRuntime;
  const preparation = window.RelatumBoot?.noteGraphPreloadRequested
    ? (window.RelatumBackgroundPreparation ||= createBackgroundPreparation()) : null;
  const workspacePanels = Array.from(document.querySelectorAll('[data-start-workspace-panel]'));
  const workspaceButtons = Array.from(document.querySelectorAll('button[data-start-workspace]'));
  const workspaceStage = document.querySelector('.start-workspace-stage');
  const header = document.querySelector('body > .top-bar');
  function syncHeaderAccess() {
    if (!header) return;
    const hidden = document.body.dataset.startWorkspace === 'notes' && document.body.classList.contains('note-focus-mode');
    header.inert = hidden;
    header.setAttribute('aria-hidden', String(hidden));
  }
  document.addEventListener('relatum:note-focuschange', syncHeaderAccess);
  if (header) {
    // Touch has no hover. Keep the edge bar open until the next outside press.
    header.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') header.classList.add('top-edge-revealed');
    });
    header.addEventListener('pointerleave', event => {
      if (event.pointerType === 'mouse') header.classList.remove('top-edge-revealed');
    });
    document.addEventListener('pointerdown', event => {
      if (!header.contains(event.target)) header.classList.remove('top-edge-revealed');
    });
    header.addEventListener('keydown', event => {
      if (event.key === 'Escape') { header.classList.remove('top-edge-revealed'); event.target.blur(); }
    });
  }
  const START_WORKSPACE_KEY = 'canvas:startWorkspace:v1';
  const START_WORKSPACE_ORDER = { canvas: 0, notes: 1, research: 2, career: 3 };
  let activeStartWorkspace = features.workspace(document.body.dataset.startWorkspace);
  let workspaceSwitchPromise = Promise.resolve(true);
  let noteWorkspaceLoader = null, researchWorkspaceLoader = null, careerWorkspaceLoader = null;
  let noteWorkspaceForeground = false;
  let researchWorkspaceFrame = null, researchWorkspaceApi = null;
  let noteWorkspaceWarmupHandle = 0, careerWorkspaceWarmupHandle = 0;
  let noteWorkspaceWarmupScheduled = false, careerWorkspaceWarmupScheduled = false;
  let workspaceTransitionTimer = 0;
  function englishUI() { return !!(window.RelatumI18n && window.RelatumI18n.language === 'en'); }
  function loadNoteWorkspace(background = false) {
    if (!background) { noteWorkspaceForeground = true; preparation?.wake(); }
    if (!features.enabled('notes')) return Promise.reject(new Error('本次启动未启用笔记'));
    if (window.CanvasNoteWorkspace) return Promise.resolve(window.CanvasNoteWorkspace);
    if (noteWorkspaceLoader) return noteWorkspaceLoader;
    window.RelatumStartupMark?.('notes-load-start');
    const loadScript = async (src, ready) => {
      if (ready()) return Promise.resolve(true);
      if (background && preparation) await preparation.waitForIdle(preparation.signal, () => noteWorkspaceForeground);
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        const fail = message => { script.remove(); reject(new Error(message)); };
        script.onload = () => ready() ? resolve(true) : fail(src + ' 没有完成初始化');
        script.onerror = () => fail(src + ' 加载失败');
        document.head.appendChild(script);
      });
    };
    noteWorkspaceLoader = loadScript('note-system.js', () => !!window.RelatumNoteSystem)
      .then(() => loadScript('vendor/codemirror/relatum-codemirror.min.js', () => !!window.RelatumCodeMirror))
      .then(() => loadScript('markdown-table.js', () => !!window.MarkdownTable))
      .then(() => loadScript('markdown.js', () => !!window.MarkdownMini?.quoteLine))
      .then(() => loadScript('note-table-editor.js', () => !!window.RelatumNoteTableEditor))
      .then(() => loadScript('note-shortcuts.js', () => !!window.RelatumNoteShortcuts))
      .then(() => loadScript('windowed-list.js', () => !!window.RelatumWindowedList))
      .then(() => loadScript('note-media-frame.js', () => !!window.RelatumNoteMediaFrame))
      .then(() => loadScript('note-live-editor.js', () => !!window.RelatumNoteLiveEditor))
      .then(() => features.enabled('notes.canvas') ? loadScript('note-canvas-style.js', () => !!window.RelatumNoteCanvasStyle) : true)
      .then(() => loadScript('settings-dialog.js', () => !!window.RelatumSettingsDialog))
      .then(() => loadScript('note-sidebar-settings.js', () => !!window.RelatumNoteSidebarSettings))
      .then(() => loadScript('note-workspace.js', () => !!window.CanvasNoteWorkspace))
      .then(() => { window.RelatumStartupMark?.('notes-scripts-ready'); return window.CanvasNoteWorkspace; })
      .catch(error => { noteWorkspaceLoader = null; throw error; });
    return noteWorkspaceLoader;
  }

  function disposeResearchWorkspace() {
    const workspace = researchWorkspaceApi;
    const frame = researchWorkspaceFrame;
    researchWorkspaceApi = null;
    researchWorkspaceFrame = null;
    researchWorkspaceLoader = null;
    if (workspace && typeof workspace.dispose === 'function') {
      try { workspace.dispose(); } catch (e) {}
    }
    if (frame && frame.isConnected) frame.remove();
  }

  function loadResearchWorkspace() {
    if (!features.enabled('research')) return Promise.reject(new Error('本次启动未启用研究'));
    if (researchWorkspaceApi) return Promise.resolve(researchWorkspaceApi);
    if (researchWorkspaceLoader) return researchWorkspaceLoader;
    const host = document.querySelector('#start-research-workspace');
    if (!host) return Promise.reject(new Error('研究工作区容器不存在'));

    researchWorkspaceLoader = new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      researchWorkspaceFrame = frame;
      frame.className = 'research-workspace-frame';
      frame.src = 'research.html';
      frame.setAttribute('aria-label', englishUI() ? 'Research workspace' : '研究工作区');

      const fail = (error) => {
        if (researchWorkspaceFrame === frame) disposeResearchWorkspace();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      frame.addEventListener('load', () => {
        let workspace = null;
        try { workspace = frame.contentWindow && frame.contentWindow.RelatumResearchWorkspace; } catch (e) {}
        if (!workspace || typeof workspace.activate !== 'function'
          || typeof workspace.suspend !== 'function' || typeof workspace.dispose !== 'function') {
          fail(new Error('research.html 没有完成初始化'));
          return;
        }
        researchWorkspaceApi = workspace;
        // Events inside an iframe do not bubble to the homepage document.
        frame.contentDocument.addEventListener('pointerdown', () => header?.classList.remove('top-edge-revealed'));
        preparation?.observeDocument(frame.contentDocument);
        if (typeof workspace.setLanguage === 'function') {
          workspace.setLanguage(englishUI() ? 'en' : 'zh-CN');
        }
        resolve(workspace);
      }, { once: true });
      frame.addEventListener('error', () => fail(new Error('research.html 加载失败')), { once: true });
      host.appendChild(frame);
    });
    return researchWorkspaceLoader;
  }

  document.addEventListener('relatum:languagechange', () => {
    if (researchWorkspaceFrame) {
      researchWorkspaceFrame.setAttribute('aria-label', englishUI() ? 'Research workspace' : '研究工作区');
    }
    if (researchWorkspaceApi && typeof researchWorkspaceApi.setLanguage === 'function') {
      researchWorkspaceApi.setLanguage(englishUI() ? 'en' : 'zh-CN');
    }
  });

  function loadCareerWorkspace() {
    if (!features.enabled('career')) return Promise.reject(new Error('本次启动未启用生涯'));
    if (window.RelatumCareerReport) return Promise.resolve(window.RelatumCareerReport);
    if (careerWorkspaceLoader) return careerWorkspaceLoader;
    careerWorkspaceLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'career-report.js';
      script.async = true;
      const fail = message => { script.remove(); reject(new Error(message)); };
      script.onload = () => window.RelatumCareerReport
        ? resolve(window.RelatumCareerReport)
        : fail('career-report.js 没有完成初始化');
      script.onerror = () => fail('career-report.js 加载失败');
      document.head.appendChild(script);
    }).catch(error => { careerWorkspaceLoader = null; throw error; });
    return careerWorkspaceLoader;
  }

  function scheduleNoteWorkspaceIdleWarmup() {
    if (features.preloadEnabled === false) return;
    if (!features.enabled('notes') || activeStartWorkspace !== 'canvas' || noteWorkspaceWarmupScheduled || window.CanvasNoteWorkspace) return;
    noteWorkspaceWarmupScheduled = true;
    const warmup = () => {
      noteWorkspaceWarmupHandle = 0;
      if (activeStartWorkspace !== 'canvas') return;
      loadNoteWorkspace(!!preparation)
        .then((workspace) => typeof workspace.preload === 'function' ? workspace.preload() : true)
        .catch(() => { noteWorkspaceWarmupScheduled = false; });
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
    if (features.preloadEnabled === false) return;
    if (!features.enabled('career') || careerWorkspaceWarmupScheduled || (window.RelatumCareerReport && window.RelatumCareerReport.report)) return;
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
    syncHeaderAccess();
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

  function showWorkspacePanel(name, previous, animate, previousStageTop) {
    clearTimeout(workspaceTransitionTimer);
    document.body.classList.remove('start-workspace-turning');
    const nextPanel = workspacePanels.find((panel) => panel.dataset.startWorkspacePanel === name);
    const previousPanel = workspacePanels.find((panel) => panel.dataset.startWorkspacePanel === previous);
    if (!nextPanel) return;
    workspacePanels.forEach((panel) => {
      panel.classList.remove('workspace-entering', 'workspace-leaving', 'workspace-forward', 'workspace-back');
      panel.style.removeProperty('--workspace-layout-shift-y');
      if (panel !== nextPanel && panel !== previousPanel) {
        panel.hidden = true;
      }
    });
    nextPanel.hidden = false;
    nextPanel.inert = false;
    if (!animate || !previousPanel || previousPanel === nextPanel
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (previousPanel && previousPanel !== nextPanel) {
        previousPanel.hidden = true;
        previousPanel.inert = false;
      }
      if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
      return;
    }
    const forward = START_WORKSPACE_ORDER[name] > START_WORKSPACE_ORDER[previous];
    const directionClass = forward ? 'workspace-forward' : 'workspace-back';
    if (workspaceStage && Number.isFinite(previousStageTop)) {
      const layoutShiftY = previousStageTop - workspaceStage.getBoundingClientRect().top;
      if (Math.abs(layoutShiftY) > 0.5) {
        previousPanel.style.setProperty('--workspace-layout-shift-y', `${layoutShiftY}px`);
      }
    }
    previousPanel.hidden = false;
    previousPanel.inert = true;
    previousPanel.classList.add('workspace-leaving', directionClass);
    nextPanel.classList.add('workspace-entering', directionClass);
    document.body.classList.add('start-workspace-turning');
    workspaceTransitionTimer = window.setTimeout(() => {
      previousPanel.hidden = true;
      previousPanel.inert = false;
      previousPanel.classList.remove('workspace-entering', 'workspace-leaving', 'workspace-forward', 'workspace-back');
      nextPanel.classList.remove('workspace-entering', 'workspace-leaving', 'workspace-forward', 'workspace-back');
      previousPanel.style.removeProperty('--workspace-layout-shift-y');
      document.body.classList.remove('start-workspace-turning');
      if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
    }, Math.max(220, config.turnSpeed()) + 140);
    if (name === 'canvas') syncCanvasWorkspaceSpineAfterReveal();
  }

  // 画布工作区隐藏时，书脊目标的 DOMRect 会退化为零尺寸；此时留下的游标形状
  // 不能复用于再次进入画布。宿主统一在下一显示帧读取布局并无过渡地校准两层；
  // 动画收尾处还会再校准一次，避免过渡结束后出现一帧跳位。
  function syncCanvasWorkspaceSpineAfterReveal() { config.onCanvasReveal(); }

  async function performStartWorkspace(next, options = {}) {
    if (!features.workspaceEnabled(next)) return false;
    const name = Object.prototype.hasOwnProperty.call(START_WORKSPACE_ORDER, next) ? next : features.workspace('');
    const previous = activeStartWorkspace;
    const previousStageTop = workspaceStage ? workspaceStage.getBoundingClientRect().top : 0;
    if (name !== previous && previous === 'notes' && window.CanvasNoteWorkspace
      && typeof window.CanvasNoteWorkspace.deactivate === 'function') {
      const canLeave = await window.CanvasNoteWorkspace.deactivate();
      if (canLeave === false) return false;
    }
    if (name !== previous && previous === 'research' && researchWorkspaceApi
      && typeof researchWorkspaceApi.suspend === 'function') {
      await researchWorkspaceApi.suspend();
    }
    activeStartWorkspace = name;
    syncWorkspaceControls(name);
    config.onChange();
    showWorkspacePanel(name, previous, options.animate !== false && name !== previous, previousStageTop);
    if (options.persist !== false) {
      try { localStorage.setItem(START_WORKSPACE_KEY, name); } catch (e) {}
    }
    if (name === 'notes') {
      try {
        const notesWorkspace = await loadNoteWorkspace();
        if (activeStartWorkspace === 'notes') await notesWorkspace.activate();
      } catch (error) {
        if (activeStartWorkspace === 'notes') {
          const fallback = ['canvas', 'notes', 'research', 'career'].find(item => item !== 'notes' && features.workspaceEnabled(item));
          if (fallback) { activeStartWorkspace = fallback; syncWorkspaceControls(fallback); config.onChange(); showWorkspacePanel(fallback, 'notes', false); setStartWorkspace(fallback, { animate: false, persist: false }); }
          config.notice(englishUI() ? 'Notes unavailable' : '笔记工作区暂时无法打开', error.message || String(error));
        }
        return false;
      }
    } else if (name === 'research') {
      try {
        const researchWorkspace = await loadResearchWorkspace();
        if (activeStartWorkspace === 'research') await researchWorkspace.activate();
        else await researchWorkspace.suspend();
      } catch (error) {
        if (activeStartWorkspace === 'research') {
          const fallback = ['canvas', 'notes', 'research', 'career'].find(item => item !== 'research' && features.workspaceEnabled(item));
          if (fallback) { activeStartWorkspace = fallback; syncWorkspaceControls(fallback); config.onChange(); showWorkspacePanel(fallback, 'research', false); setStartWorkspace(fallback, { animate: false, persist: false }); }
          config.notice(englishUI() ? 'Research workspace unavailable' : '研究工作区暂时无法打开', error.message || String(error));
        }
        return false;
      }
    } else if (name === 'career') {
      try {
        const careerWorkspace = await loadCareerWorkspace();
        if (activeStartWorkspace === 'career') await careerWorkspace.activate();
      } catch (error) {
        if (activeStartWorkspace === 'career') {
          const fallback = ['canvas', 'notes', 'research', 'career'].find(item => item !== 'career' && features.workspaceEnabled(item));
          if (fallback) { activeStartWorkspace = fallback; syncWorkspaceControls(fallback); config.onChange(); showWorkspacePanel(fallback, 'career', false); setStartWorkspace(fallback, { animate: false, persist: false }); }
          config.notice(englishUI() ? 'Career report unavailable' : '生涯报告暂时无法打开', error.message || String(error));
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
    const release = preparation?.beginBusy();
    workspaceSwitchPromise = workspaceSwitchPromise
      .catch(() => false)
      .then(() => performStartWorkspace(next, options)).finally(() => release?.());
    return workspaceSwitchPromise;
  }

  workspaceButtons.forEach((button) => {
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const reachable = workspaceButtons.filter((item) => !item.disabled);
      if (!reachable.length) return;
      const index = reachable.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? reachable.length - 1
        : ((index < 0 ? 0 : index) + (event.key === 'ArrowRight' ? 1 : -1)
          + reachable.length) % reachable.length;
      reachable[next].focus(); setStartWorkspace(reachable[next].dataset.startWorkspace);
    });
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
  let graphPreparation = null, graphPreparationSequence = 0, resumeGraphPreparation = false;
  function scheduleGraphPreparation(event) {
    if (!preparation || preparation.signal.aborted) return;
    graphPreparation?.abort();
    if (event?.detail?.cancel) {
      graphPreparationSequence++; graphPreparation = null; resumeGraphPreparation = false; return;
    }
    const controller = new AbortController(), sequence = ++graphPreparationSequence;
    graphPreparation = controller;
    const abort = () => controller.abort();
    preparation.signal.addEventListener('abort', abort, { once: true });
    (async () => {
      await preparation.waitForIdle(controller.signal);
      window.RelatumStartupMark?.('note-graph-preload-start');
      const workspace = await loadNoteWorkspace(true);
      if (controller.signal.aborted || sequence !== graphPreparationSequence) return;
      const ok = await workspace.preloadGraph({ signal: controller.signal, waitForIdle: preparation.waitForIdle });
      if (!controller.signal.aborted && sequence === graphPreparationSequence)
        window.RelatumStartupMark?.(ok ? 'note-graph-preload-ready' : 'note-graph-preload-skipped');
    })().catch(() => {
      if (!controller.signal.aborted && sequence === graphPreparationSequence)
        window.RelatumStartupMark?.('note-graph-preload-skipped');
    }).finally(() => {
      preparation.signal.removeEventListener('abort', abort);
      if (graphPreparation === controller) graphPreparation = null;
    });
  }
  document.addEventListener('relatum:note-graph-target', scheduleGraphPreparation);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resumeGraphPreparation = !!graphPreparation;
      graphPreparation?.abort();
    } else if (resumeGraphPreparation) {
      resumeGraphPreparation = false; scheduleGraphPreparation();
    }
  });
  if (activeStartWorkspace === 'notes' || activeStartWorkspace === 'research'
    || activeStartWorkspace === 'career') {
    setStartWorkspace(activeStartWorkspace, { animate: false, persist: false });
  }
  else {
    workspaceSwitchPromise.then(() => { scheduleCareerWorkspaceIdleWarmup(); scheduleNoteWorkspaceIdleWarmup(); });
  }
  if (activeStartWorkspace === 'notes') workspaceSwitchPromise.then(scheduleCareerWorkspaceIdleWarmup);
  workspaceSwitchPromise.then(scheduleGraphPreparation);
  window.addEventListener('pagehide', disposeResearchWorkspace, { once: true });

  return window.RelatumStartWorkspace;
  } });
})();

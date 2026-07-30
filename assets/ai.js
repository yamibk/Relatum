// AI 助手 V2 — 聊天与受控画布计划。
// 聊天走 /api/ai-chat；五种画布动作走 /api/ai-plan，逐项预览后才由 CanvasModule.applyAIPlan 原子应用。
// 配置（Key/模型/接口地址）经后端 /api/ai-config 存 data/ai.json，前端不长期保存。

(function () {
  'use strict';

  const panel = document.querySelector('[data-role="ai-panel"]');
  if (!panel) return;

  const toggleBtn = document.querySelector('[data-role="ai-toggle"]');
  const resizeHandle = panel.querySelector('[data-role="ai-resize-handle"]');
  const workspace = panel.querySelector('[data-role="ai-workspace"]');
  const conversation = panel.querySelector('[data-role="ai-conversation"]');
  const closeBtn = panel.querySelector('[data-role="ai-close"]');
  const helpBtn = panel.querySelector('[data-role="ai-help"]');
  const helpPanel = panel.querySelector('[data-role="ai-help-panel"]');
  const gearBtn = panel.querySelector('[data-role="ai-gear"]');
  const settings = panel.querySelector('[data-role="ai-settings"]');
  const keyInput = panel.querySelector('[data-role="ai-key"]');
  const modelInput = panel.querySelector('[data-role="ai-model"]');
  const baseInput = panel.querySelector('[data-role="ai-base"]');
  const saveCfgBtn = panel.querySelector('[data-role="ai-save-config"]');
  const testCfgBtn = panel.querySelector('[data-role="ai-test"]');
  const clearBtn = panel.querySelector('[data-role="ai-clear"]');
  const clearKeyBtn = panel.querySelector('[data-role="ai-clear-key"]');
  const keyHint = panel.querySelector('[data-role="ai-key-hint"]');
  const cfgFeedback = panel.querySelector('[data-role="ai-config-feedback"]');
  const messagesEl = panel.querySelector('[data-role="ai-messages"]');
  const emptyEl = panel.querySelector('[data-role="ai-empty"]');
  const form = panel.querySelector('[data-role="ai-composer"]');
  const input = panel.querySelector('[data-role="ai-input"]');
  const sendBtn = panel.querySelector('[data-role="ai-send"]');
  const submitIcon = panel.querySelector('[data-role="ai-submit-icon"]');
  const submitLabel = panel.querySelector('[data-role="ai-submit-label"]');
  const composerTip = panel.querySelector('[data-role="ai-composer-tip"]');
  const cancelBtn = panel.querySelector('[data-role="ai-cancel"]');
  const actionPicker = panel.querySelector('[data-role="ai-action-picker"]');
  const actionBtns = panel.querySelectorAll('[data-ai-action]');
  const actionRecommendation = panel.querySelector('[data-role="ai-action-recommendation"]');
  const actionDescription = panel.querySelector('[data-role="ai-action-description"]');
  const targetRow = panel.querySelector('[data-role="ai-target-row"]');
  const targetBtns = panel.querySelectorAll('[data-ai-target]');
  const targetSelectionBtn = panel.querySelector('[data-ai-target="selection"]');
  const selectionCountEl = panel.querySelector('[data-role="ai-selection-count"]');
  const contextToggle = panel.querySelector('[data-role="ai-context-toggle"]');
  const contextMenu = panel.querySelector('[data-role="ai-context-menu"]');
  const contextLabel = panel.querySelector('[data-role="ai-context-label"]');
  const contextCount = panel.querySelector('[data-role="ai-context-count"]');
  const contextHint = panel.querySelector('[data-role="ai-context-hint"]');
  const contextClearBtn = panel.querySelector('[data-role="ai-context-clear"]');
  const contextCloseBtn = panel.querySelector('[data-role="ai-context-close"]');
  const contextModeBtns = panel.querySelectorAll('[data-ai-context-mode]');

  function currentLanguage() {
    const api = window.RelatumI18n;
    if (api && api.language) return api.language;
    return document.documentElement.dataset.uiLanguage === 'en' ? 'en' : 'zh-CN';
  }
  function ui(zh, en) { return currentLanguage() === 'en' ? en : zh; }
  function localize(value) {
    return Array.isArray(value) ? ui(value[0], value[1]) : String(value == null ? '' : value);
  }

  // 聊天不预设角色、语气、语言或输出格式；只发送用户输入和可选的近期对话。
  // 五种画布操作仍由后端各自的 V2 计划提示词约束。
  let history = [];
  let sending = false;
  let configLoaded = false;
  let lastRun = null;          // 上一次请求 { kind:'chat'|'plan', action?, scope? }，供失败重试
  let activeRequest = null;    // 当前可取消请求 { controller, kind, pending, cancelled }
  let selectedAction = 'chat';
  let recommendedAction = 'create_graph';
  let actionUserChosen = false;
  let targetScope = 'canvas';
  let targetUserChosen = false;
  let selectedContentCount = 0;
  let currentEditorMode = 'normal';

  const md = window.MarkdownMini;
  const HISTORY_LIMIT = 40;    // 与后端单次上下文上限一致，避免长会话请求体和内存无界增长
  const TRANSCRIPT_LIMIT = 120;
  const CLOSE_MS = 240;   // 与 CSS 过渡时长一致
  const PANELLET_CLOSE_MS = 190;
  const CONTEXT_MODE_KEY = 'canvas:ai-context-mode:v1';
  const PANEL_WIDTH_KEY = 'canvas:ai-panel-width:v1';
  const PANEL_DEFAULT_WIDTH = 520;
  const PANEL_MIN_WIDTH = 440;
  const PANEL_MAX_WIDTH = 820;
  const PANEL_MAX_VIEWPORT_RATIO = 0.72;
  const PANEL_NARROW_BREAKPOINT = 640;
  const INPUT_MIN_HEIGHT = 84;
  const INPUT_MAX_HEIGHT = 240;
  const prefersReduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let contextMode = loadContextMode();
  let preferredPanelWidth = loadPanelWidth();
  let panelResizeState = null;
  const scrollbarTimers = new WeakMap();
  const scrollbarIndicators = new WeakMap();
  const installedScrollers = [];
  let scrollbarDragState = null;

  const ACTION_META = {
    chat: {
      icon: '↗',
      label: ['聊天', 'Chat'],
      description: ['只在侧栏回复，不改动画布。', 'Reply in the panel without changing the canvas.'],
      guide: {
        fit: ['只想提问、解释概念或继续追问，不需要改动画布。', 'Ask a question, explain a concept, or follow up without changing the canvas.'],
        before: ['在输入框写下问题即可，不需要选中节点。', 'Type your question. No canvas selection is needed.'],
        result: ['答案只显示在侧栏，不会生成节点或连线。', 'The answer stays in the panel and creates no nodes or links.'],
      },
    },
    create_graph: {
      icon: '⌘',
      label: ['生成卡片网络', 'Create Graph'],
      description: ['从零生成 6–12 个节点的自由关系网络。', 'Create a free-form network of 6–12 nodes.'],
      guide: {
        fit: ['从零整理知识、方案或复习内容，关系可以交叉连接。', 'Build knowledge, plans, or revision material from scratch with cross-links.'],
        before: ['写清主题和用途；无需先选节点。', 'Describe the topic and purpose. No selection is needed.'],
        result: ['默认新增 6–12 个节点并连接成自由关系网络。', 'Adds 6–12 new nodes by default and connects them as a free network.'],
        examples: [
          ['把“牛顿第二定律”整理成 8 个复习节点，包含定义、公式、变量、例题和易错点。',
            'Turn “Newton’s second law” into eight revision nodes covering the definition, formula, variables, examples, and common mistakes.'],
          ['围绕“C 语言指针”建立知识网络，连接概念、语法、内存模型和常见错误。',
            'Build a knowledge network for “C pointers” linking concepts, syntax, memory models, and common mistakes.'],
        ],
      },
    },
    create_mindmap: {
      icon: '⌁',
      label: ['生成导图', 'Create Mind Map'],
      description: ['生成严格单根导图，确认后切到导图模式。', 'Create a strict single-root map and switch modes after confirmation.'],
      guide: {
        fit: ['从零生成“一个中心主题向下分层”的严格结构。', 'Create a strict hierarchy that branches from one central topic.'],
        before: ['写清中心主题和需要的层级；无需先选节点。', 'Describe the central topic and desired levels. No selection is needed.'],
        result: ['生成单根父子导图，确认应用后进入导图模式。', 'Creates a single-root parent-child map and enters Mind Map mode after applying.'],
        examples: [
          ['以“毕业论文计划”为中心，分成选题、文献、方法、写作和答辩五个一级分支。',
            'Create a mind map for “Thesis plan” with five main branches: topic, literature, methods, writing, and defense.'],
          ['用导图拆解“产品发布”，包含准备、内容、渠道、时间线和复盘，每项再列 2–3 个子项。',
            'Break down “Product launch” into preparation, content, channels, timeline, and review, with 2–3 child items each.'],
        ],
      },
    },
    extend_branch: {
      icon: '↳',
      label: ['扩展导图分支', 'Extend Branch'],
      description: ['把严格子树接到一个选中的导图节点。', 'Attach a strict subtree to one selected mind-map node.'],
      guide: {
        fit: ['继续展开现有导图中的某一个分支。', 'Continue one branch of an existing mind map.'],
        before: ['必须先恰好选中 1 个有效导图节点。', 'Select exactly one valid mind-map node first.'],
        result: ['把新子树接到该节点，只重新整理受影响的分支。', 'Attaches a new subtree and rearranges only the affected branch.'],
        examples: [
          ['为选中的“实验方法”分支补充步骤、变量、风险和验证指标。',
            'Expand the selected “Experiment method” branch with steps, variables, risks, and validation metrics.'],
          ['把选中的章节继续展开为关键概念、实际例子和自测问题。',
            'Expand the selected chapter into key concepts, practical examples, and self-check questions.'],
        ],
      },
    },
    supplement: {
      icon: '＋',
      label: ['基于画布补充', 'Supplement'],
      description: ['查漏补缺，并把新增内容接回相关节点。', 'Fill gaps and connect new material to relevant nodes.'],
      guide: {
        fit: ['检查已有内容还缺哪些概念、例子、推导或对比。', 'Find missing concepts, examples, derivations, or comparisons in existing content.'],
        before: ['选择局部节点，或把目标切换为整张画布。', 'Select local nodes or target the entire canvas.'],
        result: ['只新增缺失节点和连接，不改原节点文字。', 'Adds missing nodes and links without rewriting existing node text.'],
        examples: [
          ['检查目标范围缺少的定义、例子和连接，只补充缺失内容。',
            'Find missing definitions, examples, and links in the target, and add only what is absent.'],
          ['为现有知识补充必要的前置概念、实际应用和常见误区。',
            'Add the necessary prerequisites, real-world applications, and common misconceptions to the existing material.'],
        ],
      },
    },
    refine: {
      icon: '✦',
      label: ['整理精炼', 'Refine'],
      description: ['预览后更新原节点与连接，不删除节点。', 'Update original nodes and links after preview, without deleting nodes.'],
      guide: {
        fit: ['压缩重复内容、改进标题正文，或梳理已有连接。', 'Condense repetition, improve titles and bodies, or clean up existing links.'],
        before: ['选择局部节点，或把目标切换为整张画布。', 'Select local nodes or target the entire canvas.'],
        result: ['可更新标题、正文和连接；不删除节点、不改变节点类型。', 'May update titles, bodies, and links without deleting nodes or changing their types.'],
        examples: [
          ['压缩重复表述，统一标题，并梳理必要连接；不要删除节点。',
            'Condense repeated wording, standardize titles, and clean up necessary links without deleting nodes.'],
          ['把目标范围整理成适合复习的短标题和要点，保持节点类型不变。',
            'Rewrite the target into concise revision titles and key points while preserving every node type.'],
        ],
      },
    },
  };

  const AI_HELP_PAGES = [
    {
      id: 'start',
      layout: 'steps',
      eyebrow: ['01 · 3 步上手', '01 · 3-STEP START'],
      title: ['第一次用，只做这三步', 'Start with these three steps'],
      subtitle: ['先写需求，再选操作；只有确认应用后，画布才会变化。', 'Describe what you need, choose an action, and apply only after reviewing.'],
      sections: [
        [['设置 API Key', 'Set up your API key'], ['点右上角齿轮，填写 API Key 并测试连接。Key 只保存在本机。', 'Open Settings, add your API key, and test the connection. The key stays on this device.']],
        [['输入你想做什么', 'Describe what you need'], ['在底部输入框写清主题、用途和限制，例如“整理牛顿第二定律，生成 8 个复习节点”。', 'Describe the topic, purpose, and limits, such as “Create eight revision nodes for Newton’s second law.”']],
        [['选择操作并提交', 'Choose an action and submit'], ['底部主按钮会跟着操作变化：聊天显示发送箭头，其他五项显示“生成预览”。预览逐项确认后才会应用。', 'The primary button follows the selected action: Chat shows the send arrow; the other five show “Generate preview.” Previewed changes are applied only after review.']],
      ],
    },
    {
      id: 'actions',
      layout: 'actions',
      eyebrow: ['02 · 六个按钮', '02 · SIX ACTIONS'],
      title: ['按你现在想做的事来选', 'Choose by what you want to do now'],
      subtitle: ['“推荐”只根据当前模式和选区给提示，不会自动执行。', 'Recommended actions are suggestions based on mode and selection; nothing runs automatically.'],
      actionIds: ['chat', 'create_graph', 'create_mindmap', 'extend_branch', 'supplement', 'refine'],
    },
    {
      id: 'preview',
      layout: 'sections',
      eyebrow: ['03 · 选区与预览', '03 · SCOPE & PREVIEW'],
      title: ['先确定目标，再逐项确认', 'Choose the target, then review each change'],
      subtitle: ['生成预览不会写入画布；只有点击“应用选中项”才会真正修改。', 'Generating a preview does not write to the canvas; only applying selected items makes changes.'],
      sections: [
        [['哪些操作需要选区', 'Which actions need a selection'], ['扩展分支必须选中 1 个导图节点；补充和整理可选“选区”或“整张画布”；从零生成和聊天无需选节点。', 'Extend Branch needs one mind-map node. Supplement and Refine can target a selection or the entire canvas. Creation and chat need no selection.']],
        [['预览里可以取消什么', 'What you can uncheck'], ['新增或更新默认勾选；连线移除默认不勾选。取消新节点会同步取消依赖连线，导图父节点会连同子树一起取消。', 'Creates and updates start checked; link removals do not. Unchecking a new node also drops dependent links, and mind-map parents cascade to their subtree.']],
        [['应用后的安全边界', 'Safety after applying'], ['预览后画布若发生变化，会要求重新生成；成功应用只产生一条历史记录，可用 Ctrl+Z 整批撤销。', 'If the canvas changes after preview, regeneration is required. A successful apply creates one history entry and can be undone as a batch with Ctrl+Z.']],
      ],
    },
    {
      id: 'trouble',
      layout: 'sections',
      eyebrow: ['04 · 设置与排错', '04 · SETUP & HELP'],
      title: ['常见问题都在这里', 'Fix the common issues here'],
      subtitle: ['对话历史、画布目标和网络请求是三件分开控制的事。', 'Chat history, canvas scope, and network requests are controlled separately.'],
      sections: [
        [['连续对话与单次请求', 'Continuous vs single request'], ['“上下文”只决定下一次是否携带侧栏聊天历史，不决定发送哪些画布节点；画布范围由操作和目标按钮决定。', 'Context only controls whether panel history is included next time. Canvas content is controlled by the action and target buttons.']],
        [['为什么不能扩展或整理', 'Why an action cannot run'], ['扩展失败通常是没有恰好选中 1 个有效导图节点；补充或整理失败通常是目标范围里没有可发送的正文节点。', 'Extension usually fails without exactly one valid mind-map node. Supplement or Refine usually fails when the target has no eligible content nodes.']],
        [['取消、过期与撤销', 'Cancel, stale preview, and undo'], ['“取消”只停止当前网络请求；预览过期请重新生成；应用成功后按 Ctrl+Z 可整批撤销。', 'Cancel only stops the current request. Regenerate stale previews, and use Ctrl+Z to undo a successful apply as one batch.']],
      ],
    },
  ];

  // ── 面板尺寸：桌面端从左侧拖宽，偏好只存在 localStorage ──
  function narrowPanelLayout() {
    return window.innerWidth <= PANEL_NARROW_BREAKPOINT;
  }
  function panelWidthLimits() {
    const viewportMax = Math.floor(window.innerWidth * PANEL_MAX_VIEWPORT_RATIO);
    return {
      min: PANEL_MIN_WIDTH,
      max: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewportMax)),
    };
  }
  function clampPanelWidth(width) {
    const limits = panelWidthLimits();
    const value = Number(width);
    const safe = Number.isFinite(value) ? value : PANEL_DEFAULT_WIDTH;
    return Math.max(limits.min, Math.min(limits.max, Math.round(safe)));
  }
  function loadPanelWidth() {
    try {
      const saved = Number(window.localStorage && window.localStorage.getItem(PANEL_WIDTH_KEY));
      return Number.isFinite(saved) && saved > 0 ? saved : PANEL_DEFAULT_WIDTH;
    } catch (error) {
      return PANEL_DEFAULT_WIDTH;
    }
  }
  function savePanelWidth(width) {
    try {
      if (window.localStorage) window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
    } catch (error) {}
  }
  function syncResizeHandle(width) {
    if (!resizeHandle) return;
    const limits = panelWidthLimits();
    resizeHandle.setAttribute('aria-valuemin', String(limits.min));
    resizeHandle.setAttribute('aria-valuemax', String(limits.max));
    resizeHandle.setAttribute('aria-valuenow', String(Math.round(width)));
    resizeHandle.setAttribute('aria-label', ui('调整 AI 助手宽度', 'Resize AI Assistant'));
    resizeHandle.setAttribute('title', ui(
      '拖动调整宽度，双击恢复默认',
      'Drag to resize. Double-click to restore the default width.',
    ));
  }
  function applyPanelWidth(width, options) {
    const opts = options || {};
    if (narrowPanelLayout()) {
      panel.style.removeProperty('--ai-panel-width');
      syncResizeHandle(window.innerWidth);
      return window.innerWidth;
    }
    const next = clampPanelWidth(width);
    panel.style.setProperty('--ai-panel-width', next + 'px');
    syncResizeHandle(next);
    updateAllScrollbarIndicators();
    if (opts.remember) preferredPanelWidth = next;
    if (opts.persist) savePanelWidth(next);
    return next;
  }
  function restorePanelWidth() {
    return applyPanelWidth(preferredPanelWidth);
  }
  function runPanelResizeFrame() {
    const state = panelResizeState;
    if (!state) return;
    state.frame = 0;
    state.renderedWidth = applyPanelWidth(
      state.startWidth + state.startX - state.pendingX,
    );
  }
  function schedulePanelResize(clientX) {
    if (!panelResizeState) return;
    panelResizeState.pendingX = clientX;
    if (!panelResizeState.frame) {
      panelResizeState.frame = window.requestAnimationFrame(runPanelResizeFrame);
    }
  }
  function onPanelResizeMove(event) {
    if (!panelResizeState || event.pointerId !== panelResizeState.pointerId) return;
    event.preventDefault();
    schedulePanelResize(event.clientX);
  }
  function clearPanelResizeListeners(state) {
    window.removeEventListener('pointermove', onPanelResizeMove);
    window.removeEventListener('pointerup', onPanelResizeEnd);
    window.removeEventListener('pointercancel', onPanelResizeCancel);
    if (state && state.frame) window.cancelAnimationFrame(state.frame);
    try {
      if (state && resizeHandle) resizeHandle.releasePointerCapture(state.pointerId);
    } catch (error) {}
  }
  function finishPanelResize(cancel) {
    const state = panelResizeState;
    if (!state) return;
    panelResizeState = null;
    clearPanelResizeListeners(state);
    document.body.classList.remove('ai-panel-resizing');
    panel.classList.remove('is-resizing');
    const next = cancel
      ? applyPanelWidth(state.startWidth)
      : applyPanelWidth(state.renderedWidth || state.startWidth, { remember: true, persist: true });
    syncResizeHandle(next);
  }
  function onPanelResizeEnd(event) {
    if (!panelResizeState || event.pointerId !== panelResizeState.pointerId) return;
    if (panelResizeState.frame) {
      window.cancelAnimationFrame(panelResizeState.frame);
      panelResizeState.frame = 0;
    }
    panelResizeState.pendingX = event.clientX;
    panelResizeState.renderedWidth = applyPanelWidth(
      panelResizeState.startWidth + panelResizeState.startX - event.clientX,
    );
    finishPanelResize(false);
  }
  function onPanelResizeCancel(event) {
    if (!panelResizeState || event.pointerId !== panelResizeState.pointerId) return;
    finishPanelResize(true);
  }
  function onPanelResizeStart(event) {
    if (!resizeHandle || narrowPanelLayout() || event.button !== 0 || panelResizeState) return;
    event.preventDefault();
    event.stopPropagation();
    const startWidth = panel.getBoundingClientRect().width;
    panelResizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      pendingX: event.clientX,
      startWidth: startWidth,
      renderedWidth: startWidth,
      frame: 0,
    };
    try { resizeHandle.setPointerCapture(event.pointerId); } catch (error) {}
    panel.classList.add('is-resizing');
    document.body.classList.add('ai-panel-resizing');
    window.addEventListener('pointermove', onPanelResizeMove, { passive: false });
    window.addEventListener('pointerup', onPanelResizeEnd);
    window.addEventListener('pointercancel', onPanelResizeCancel);
  }
  function resetPanelWidth() {
    if (narrowPanelLayout()) return;
    applyPanelWidth(PANEL_DEFAULT_WIDTH, { remember: true, persist: true });
  }
  function onPanelResizeKeydown(event) {
    if (narrowPanelLayout()) return;
    const current = panel.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    let next = null;
    if (event.key === 'ArrowLeft') next = current + step;
    if (event.key === 'ArrowRight') next = current - step;
    if (event.key === 'Home') next = PANEL_DEFAULT_WIDTH;
    if (event.key === 'End') next = panelWidthLimits().max;
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    applyPanelWidth(next, { remember: true, persist: true });
  }

  function markScrollbarActive(element) {
    if (!element) return;
    element.classList.add('ai-scroll-active');
    const indicator = scrollbarIndicators.get(element);
    if (indicator) {
      indicator.rail.classList.add('is-active');
      updateScrollbarIndicator(element);
    }
    const oldTimer = scrollbarTimers.get(element);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(function () {
      const focused = element === document.activeElement
        || (element.contains && element.contains(document.activeElement));
      if (focused || element.matches(':hover')) {
        scrollbarTimers.delete(element);
        return;
      }
      element.classList.remove('ai-scroll-active');
      const current = scrollbarIndicators.get(element);
      if (current && (!scrollbarDragState || scrollbarDragState.element !== element)) {
        current.rail.classList.remove('is-active');
      }
      scrollbarTimers.delete(element);
    }, 760);
    scrollbarTimers.set(element, timer);
  }
  function updateScrollbarIndicator(element) {
    const indicator = scrollbarIndicators.get(element);
    if (!indicator) return;
    const panelRect = panel.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const clientHeight = element.clientHeight;
    const scrollHeight = element.scrollHeight;
    const scrollable = !panel.hidden
      && rect.width > 0
      && rect.height > 0
      && clientHeight > 0
      && scrollHeight > clientHeight + 1;
    indicator.rail.classList.toggle('is-scrollable', scrollable);
    if (!scrollable) {
      indicator.rail.classList.remove('is-active');
      return;
    }
    const railInset = Math.min(7, Math.max(3, rect.height * 0.04));
    const railHeight = Math.max(18, rect.height - railInset * 2);
    const thumbHeight = Math.min(
      railHeight,
      Math.max(32, railHeight * (clientHeight / scrollHeight)),
    );
    const travel = Math.max(0, railHeight - thumbHeight);
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const thumbTop = travel * Math.max(0, Math.min(1, element.scrollTop / maxScroll));
    indicator.rail.style.left = Math.round(rect.right - panelRect.left - 9) + 'px';
    indicator.rail.style.top = Math.round(rect.top - panelRect.top + railInset) + 'px';
    indicator.rail.style.height = Math.round(railHeight) + 'px';
    indicator.thumb.style.height = Math.round(thumbHeight) + 'px';
    indicator.thumb.style.transform = 'translate3d(0,' + Math.round(thumbTop) + 'px,0)';
    indicator.travel = travel;
    indicator.maxScroll = maxScroll;
  }
  function updateAllScrollbarIndicators() {
    installedScrollers.forEach(updateScrollbarIndicator);
  }
  function moveScrollbarDrag(clientY) {
    const state = scrollbarDragState;
    if (!state) return;
    const indicator = scrollbarIndicators.get(state.element);
    if (!indicator || !indicator.travel) return;
    const railRect = indicator.rail.getBoundingClientRect();
    const next = Math.max(0, Math.min(
      indicator.travel,
      clientY - railRect.top - state.pointerOffset,
    ));
    state.element.scrollTop = (next / indicator.travel) * indicator.maxScroll;
    markScrollbarActive(state.element);
  }
  function onScrollbarDragMove(event) {
    if (!scrollbarDragState || event.pointerId !== scrollbarDragState.pointerId) return;
    event.preventDefault();
    moveScrollbarDrag(event.clientY);
  }
  function finishScrollbarDrag(event) {
    const state = scrollbarDragState;
    if (!state) return;
    if (event && event.pointerId != null && event.pointerId !== state.pointerId) return;
    scrollbarDragState = null;
    window.removeEventListener('pointermove', onScrollbarDragMove);
    window.removeEventListener('pointerup', finishScrollbarDrag);
    window.removeEventListener('pointercancel', finishScrollbarDrag);
    try { state.rail.releasePointerCapture(state.pointerId); } catch (error) {}
    state.rail.classList.remove('is-dragging');
    markScrollbarActive(state.element);
  }
  function startScrollbarDrag(event, element) {
    if (event.button !== 0 || scrollbarDragState) return;
    const indicator = scrollbarIndicators.get(element);
    if (!indicator || !indicator.rail.classList.contains('is-scrollable')) return;
    event.preventDefault();
    event.stopPropagation();
    updateScrollbarIndicator(element);
    const thumbRect = indicator.thumb.getBoundingClientRect();
    const onThumb = event.target === indicator.thumb;
    scrollbarDragState = {
      element: element,
      rail: indicator.rail,
      pointerId: event.pointerId,
      pointerOffset: onThumb
        ? event.clientY - thumbRect.top
        : thumbRect.height / 2,
    };
    try { indicator.rail.setPointerCapture(event.pointerId); } catch (error) {}
    indicator.rail.classList.add('is-dragging', 'is-active');
    window.addEventListener('pointermove', onScrollbarDragMove, { passive: false });
    window.addEventListener('pointerup', finishScrollbarDrag);
    window.addEventListener('pointercancel', finishScrollbarDrag);
    if (!onThumb) moveScrollbarDrag(event.clientY);
  }
  function installAutoScrollbar(element) {
    if (!element || scrollbarIndicators.has(element)) return;
    element.classList.add('ai-custom-scroll');
    const rail = document.createElement('span');
    const thumb = document.createElement('span');
    rail.className = 'ai-scroll-indicator';
    rail.setAttribute('aria-hidden', 'true');
    thumb.className = 'ai-scroll-indicator-thumb';
    rail.appendChild(thumb);
    panel.appendChild(rail);
    scrollbarIndicators.set(element, {
      rail: rail,
      thumb: thumb,
      travel: 0,
      maxScroll: 0,
    });
    installedScrollers.push(element);
    element.addEventListener('scroll', function () {
      markScrollbarActive(element);
      updateScrollbarIndicator(element);
    }, { passive: true });
    element.addEventListener('mouseenter', function () { markScrollbarActive(element); });
    element.addEventListener('mouseleave', function () { markScrollbarActive(element); });
    element.addEventListener('focusin', function () { markScrollbarActive(element); });
    element.addEventListener('focusout', function () { markScrollbarActive(element); });
    rail.addEventListener('pointerdown', function (event) { startScrollbarDrag(event, element); });
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(function () { updateScrollbarIndicator(element); });
      observer.observe(element);
    }
    if (window.MutationObserver) {
      const observer = new MutationObserver(function () { updateScrollbarIndicator(element); });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
    }
    updateScrollbarIndicator(element);
  }

  function syncWorkspaceSheetState() {
    const sheetOpen = panelletOpen(helpPanel) || panelletOpen(settings);
    panel.classList.toggle('ai-sheet-open', sheetOpen);
    if (conversation) {
      conversation.toggleAttribute('inert', sheetOpen);
      if (sheetOpen) conversation.setAttribute('aria-hidden', 'true');
      else conversation.removeAttribute('aria-hidden');
    }
    if (workspace) workspace.dataset.activeSheet = helpOpen()
      ? 'help' : (settingsOpen() ? 'settings' : '');
    window.requestAnimationFrame(updateAllScrollbarIndicators);
  }

  // ── 面板开关 ──
  function panelOpen() { return panel.classList.contains('open'); }
  function openPanel() {
    restorePanelWidth();
    panel.hidden = false;
    void panel.offsetWidth;                 // 触发过渡
    panel.classList.add('open');
    document.body.classList.add('ai-panel-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    if (!configLoaded) loadConfig();
    syncContextStatus();
    window.requestAnimationFrame(updateAllScrollbarIndicators);
    setTimeout(function () { if (input) input.focus(); }, 60);
  }
  function closePanel() {
    if (panelResizeState) finishPanelResize(true);
    panel.classList.remove('open');
    document.body.classList.remove('ai-panel-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (!panelOpen()) panel.hidden = true; }, CLOSE_MS);
  }
  function togglePanel() { if (panelOpen()) closePanel(); else openPanel(); }

  // ── 问号教程 / 齿轮设置开关 ──
  let helpPageIndex = 0;
  let helpFlipping = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function validContextMode(mode) {
    return mode === 'single' || mode === 'continuous';
  }
  function loadContextMode() {
    try {
      const saved = window.localStorage && window.localStorage.getItem(CONTEXT_MODE_KEY);
      return validContextMode(saved) ? saved : 'continuous';
    } catch (e) {
      return 'continuous';
    }
  }
  function saveContextMode(mode) {
    try {
      if (window.localStorage) window.localStorage.setItem(CONTEXT_MODE_KEY, mode);
    } catch (e) {}
  }
  function historyCount() {
    return history.length;
  }
  function pushHistory(message) {
    history.push(message);
    const overflow = history.length - HISTORY_LIMIT;
    if (overflow > 0) history.splice(0, overflow);
  }
  function requestMessages() {
    if (contextMode === 'continuous') return history.slice();
    const lastUser = history.slice().reverse().find(function (m) { return m && m.role === 'user'; });
    return lastUser ? [lastUser] : [];
  }
  function syncContextStatus() {
    const count = historyCount();
    const continuous = contextMode === 'continuous';
    if (contextLabel) contextLabel.textContent = continuous
      ? ui('上下文：连续对话', 'Context: continuous')
      : ui('上下文：单次请求', 'Context: single request');
    if (contextCount) contextCount.textContent = continuous
      ? ui(count + ' 条', count + ' items')
      : ui('不带历史', 'No history');
    if (contextHint) {
      contextHint.textContent = continuous
        ? ui(
          '下一次请求会带上右侧聊天历史。关闭 AI 侧栏不会清空；刷新或关闭画布页面会重新开始。',
          'The next request includes recent panel history. Closing the panel keeps it; reloading the canvas starts over.',
        )
        : ui(
          '下一次请求只带当前输入，不带旧聊天。右侧记录仍会显示，你也可以随时清空。',
          'The next request includes only the current input. The transcript remains visible and can be cleared anytime.',
        );
    }
    contextModeBtns.forEach(function (btn) {
      const active = btn.dataset.aiContextMode === contextMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  function setContextMode(mode) {
    if (!validContextMode(mode) || mode === contextMode) { syncContextStatus(); return; }
    contextMode = mode;
    saveContextMode(mode);
    syncContextStatus();
  }
  function panelletOpen(el) {
    return !!(el && !el.hidden && !el.classList.contains('ai-panellet-closing'));
  }
  function openPanellet(el, button) {
    if (!el) return;
    el.dataset.aiPanelletState = 'open';
    el.hidden = false;
    el.classList.remove('ai-panellet-closing');
    requestAnimationFrame(function () {
      if (el.dataset.aiPanelletState === 'open') el.classList.add('open');
    });
    if (button) button.setAttribute('aria-expanded', 'true');
    syncWorkspaceSheetState();
  }
  function closePanellet(el, button, immediate) {
    if (!el || el.hidden) return;
    el.dataset.aiPanelletState = 'closed';
    el.classList.remove('open');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (prefersReduced || immediate) {
      el.hidden = true;
      el.classList.remove('ai-panellet-closing');
      syncWorkspaceSheetState();
      return;
    }
    el.classList.add('ai-panellet-closing');
    setTimeout(function () {
      if (!el.classList.contains('open')) {
        el.hidden = true;
        el.classList.remove('ai-panellet-closing');
        syncWorkspaceSheetState();
      }
    }, PANELLET_CLOSE_MS);
    syncWorkspaceSheetState();
  }
  function syncHelpNav(index) {
    if (!helpPanel) return;
    const item = AI_HELP_PAGES[index];
    const page = helpPanel.querySelector('[data-role="ai-help-page"]');
    if (!item) return;
    let active = null;
    helpPanel.querySelectorAll('[data-ai-help-page]').forEach(function (button) {
      const selected = button.dataset.aiHelpPage === item.id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) active = button;
    });
    if (page && active && active.id) page.setAttribute('aria-labelledby', active.id);
  }

  function helpSections(sections, layout) {
    return '<div class="ai-help-sections">'
      + (Array.isArray(sections) ? sections : []).map(function (section, index) {
        const step = layout === 'steps' ? ' data-step="' + String(index + 1) + '"' : '';
        return '<section class="ai-help-section"' + step + '><h4>'
          + esc(localize(section[0])) + '</h4><p>' + esc(localize(section[1])) + '</p></section>';
      }).join('') + '</div>';
  }

  function helpActionCards(actionIds) {
    const fitLabel = ui('适合', 'Best for');
    const beforeLabel = ui('使用前', 'Before');
    const resultLabel = ui('结果', 'Result');
    const useLabel = ui('使用这个', 'Use this');
    const exampleLabel = ui('示例指令', 'Example prompts');
    const exampleHint = ui('点击带入输入框，不会自动发送', 'Click to fill the input; nothing is sent');
    return '<div class="ai-help-action-list">'
      + (Array.isArray(actionIds) ? actionIds : []).map(function (action) {
        const meta = ACTION_META[action];
        if (!meta || !meta.guide) return '';
        const name = localize(meta.label);
        const headingId = 'ai-help-action-' + action;
        const examples = Array.isArray(meta.guide.examples) ? meta.guide.examples : [];
        const examplesHtml = examples.length
          ? '<div class="ai-help-action-examples"><div class="ai-help-example-head"><b>' + esc(exampleLabel)
            + '</b><span>' + esc(exampleHint) + '</span></div><div class="ai-help-example-list">'
            + examples.map(function (example, index) {
              const prompt = localize(example);
              return '<button type="button" data-ai-help-example="' + esc(action)
                + '" data-example-index="' + String(index) + '" aria-label="'
                + esc(ui('带入示例：' + prompt, 'Use example: ' + prompt)) + '"><span aria-hidden="true">↳</span>'
                + esc(prompt) + '</button>';
            }).join('') + '</div></div>'
          : '';
        return '<article class="ai-help-action-card" aria-labelledby="' + headingId + '">'
          + '<header><span class="ai-help-action-icon" aria-hidden="true">' + esc(meta.icon) + '</span>'
          + '<h4 id="' + headingId + '">' + esc(name) + '</h4>'
          + '<button type="button" class="ai-help-action-use" data-ai-help-action="' + esc(action)
          + '" aria-label="' + esc(ui('使用：' + name, 'Use ' + name)) + '">' + esc(useLabel) + '</button></header>'
          + '<dl><div><dt>' + esc(fitLabel) + '</dt><dd>' + esc(localize(meta.guide.fit)) + '</dd></div>'
          + '<div><dt>' + esc(beforeLabel) + '</dt><dd>' + esc(localize(meta.guide.before)) + '</dd></div>'
          + '<div><dt>' + esc(resultLabel) + '</dt><dd>' + esc(localize(meta.guide.result)) + '</dd></div></dl>'
          + examplesHtml
          + '</article>';
      }).join('') + '</div>';
  }

  function syncHelpPager(index) {
    if (!helpPanel) return;
    const total = AI_HELP_PAGES.length;
    const prev = helpPanel.querySelector('[data-action="ai-help-prev"]');
    const next = helpPanel.querySelector('[data-action="ai-help-next"]');
    const nextLabel = helpPanel.querySelector('[data-role="ai-help-next-label"]');
    const last = index >= total - 1;
    if (prev) prev.disabled = index <= 0;
    if (next) next.setAttribute('aria-label', last ? ui('收起教程', 'Close guide') : ui('下一步', 'Next'));
    if (nextLabel) nextLabel.textContent = last ? ui('收起教程', 'Close guide') : ui('下一步', 'Next');
  }

  function renderHelpPage(index, direction) {
    if (!helpPanel) return;
    const page = helpPanel.querySelector('[data-role="ai-help-page"]');
    const copy = helpPanel.querySelector('[data-role="ai-help-page-copy"]');
    const position = helpPanel.querySelector('[data-role="ai-help-position"]');
    const book = helpPanel.querySelector('.ai-help-book');
    const item = AI_HELP_PAGES[index];
    if (!page || !copy || !item) return;
    const apply = function () {
      copy.dataset.helpLayout = item.layout || 'sections';
      copy.innerHTML = '<div class="ai-help-page-intro"><p>' + esc(localize(item.eyebrow)) + '</p><h3>'
        + esc(localize(item.title)) + '</h3><span>' + esc(localize(item.subtitle)) + '</span></div>'
        + (item.layout === 'actions'
          ? helpActionCards(item.actionIds)
          : helpSections(item.sections, item.layout));
      if (position) position.textContent = String(index + 1).padStart(2, '0') + ' / '
        + String(AI_HELP_PAGES.length).padStart(2, '0');
      syncHelpPager(index);
      if (book) book.scrollTop = 0;
    };
    syncHelpNav(index);
    if (!direction || prefersReduced || typeof page.animate !== 'function') { apply(); return; }
    helpFlipping = true;
    const outgoingX = direction > 0 ? -26 : 26;
    const incomingX = -outgoingX;
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const outgoing = page.animate([
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      { opacity: 0, transform: 'translate3d(' + outgoingX + 'px,0,0) scale(0.992)' },
    ], { duration: 135, easing: easing, fill: 'forwards' });
    outgoing.finished.catch(function () {}).then(function () {
      apply();
      outgoing.cancel();
      const incoming = page.animate([
        { opacity: 0, transform: 'translate3d(' + incomingX + 'px,0,0) scale(0.992)' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      ], { duration: 260, easing: easing, fill: 'both' });
      incoming.finished.catch(function () {}).then(function () {
        incoming.cancel();
        helpFlipping = false;
      });
    });
  }
  function gotoHelpPage(index) {
    if (helpFlipping) return;
    const total = AI_HELP_PAGES.length;
    const next = Math.max(0, Math.min(total - 1, index));
    if (next === helpPageIndex) return;
    const direction = index > helpPageIndex ? 1 : -1;
    helpPageIndex = next;
    renderHelpPage(helpPageIndex, direction);
  }
  function helpOpen() { return panelletOpen(helpPanel); }
  function openHelp() {
    if (!helpPanel) return;
    closeSettings(true);
    closeContextMenu(true);
    openPanellet(helpPanel, helpBtn);
    renderHelpPage(helpPageIndex, 0);
  }
  function closeHelp(immediate) { closePanellet(helpPanel, helpBtn, immediate); }
  function toggleHelp() { if (helpOpen()) closeHelp(); else openHelp(); }
  function settingsOpen() { return panelletOpen(settings); }
  function openSettings() {
    if (!settings) return;
    closeHelp(true);
    closeContextMenu(true);
    openPanellet(settings, gearBtn);
    if (keyInput) setTimeout(function () { keyInput.focus(); }, 80);
  }
  function closeSettings(immediate) { closePanellet(settings, gearBtn, immediate); }
  function toggleSettings() { if (settingsOpen()) closeSettings(); else openSettings(); }
  function contextOpen() { return panelletOpen(contextMenu); }
  function openContextMenu() {
    if (!contextMenu) return;
    closeHelp(true);
    closeSettings(true);
    syncContextStatus();
    openPanellet(contextMenu, contextToggle);
  }
  function closeContextMenu(immediate) { closePanellet(contextMenu, contextToggle, immediate); }
  function toggleContextMenu() { if (contextOpen()) closeContextMenu(); else openContextMenu(); }

  // ── 配置读写 ──
  function loadConfig() {
    fetch('/api/ai-config').then(function (r) { return r.json(); }).then(function (cfg) {
      configLoaded = true;
      if (modelInput) modelInput.value = cfg.model || '';
      if (baseInput) baseInput.value = cfg.baseUrl || '';
      updateKeyHint(cfg);
    }).catch(function () {});
  }
  function updateKeyHint(cfg) {
    if (!keyHint) return;
    if (cfg && cfg.hasKey) {
      keyHint.textContent = ui('已设置 ', 'Configured ') + (cfg.keyHint || '');
      keyHint.classList.remove('ai-key-missing');
    } else {
      keyHint.textContent = ui('尚未设置', 'Not configured');
      keyHint.classList.add('ai-key-missing');
    }
  }
  function setConfigFeedback(t) { if (cfgFeedback) cfgFeedback.textContent = t || ''; }
  function responseErrorMessage(data, status) {
    if (currentLanguage() !== 'en') {
      return (data && data.error) || ('请求失败（' + status + '）');
    }
    const code = data && data.code ? String(data.code) : '';
    const messages = {
      PLAN_MESSAGES_INVALID: 'The request has no usable conversation content.',
      PLAN_ACTION_INVALID: 'This canvas action is not supported.',
      PLAN_TRUNCATED: 'The generated plan reached the output limit. Ask for fewer or shorter nodes.',
      PLAN_BRANCH_ANCHOR_INVALID: 'Select exactly one mind-map node before extending a branch.',
      PLAN_BRANCH_ANCHOR_NOT_MINDMAP: 'The selected node is not part of a valid mind map.',
      PLAN_CONTEXT_REQUIRED: 'This action needs eligible canvas content.',
      PLAN_EMPTY: 'The model proposed no usable changes.',
    };
    if (messages[code]) return messages[code];
    return code
      ? 'The request failed safely (' + code + '). Try regenerating or narrowing the target.'
      : 'Request failed (' + status + '). Check the AI settings and try again.';
  }
  function readJsonOrThrow(r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(responseErrorMessage(data, r.status));
      return data;
    });
  }
  function saveConfig() {
    const patch = {
      model: modelInput ? modelInput.value.trim() : '',
      baseUrl: baseInput ? baseInput.value.trim() : '',
    };
    const k = keyInput ? keyInput.value.trim() : '';
    if (k) patch.apiKey = k;                 // 留空 = 不修改已存的 Key
    setConfigFeedback(ui('保存中…', 'Saving…'));
    fetch('/api/ai-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(readJsonOrThrow).then(function (cfg) {
      configLoaded = true;
      updateKeyHint(cfg);
      if (keyInput) keyInput.value = '';     // 不在输入框里留明文
      if (modelInput && cfg.model) modelInput.value = cfg.model;
      if (baseInput && cfg.baseUrl) baseInput.value = cfg.baseUrl;
      setConfigFeedback(ui('已保存', 'Saved'));
      setTimeout(function () { setConfigFeedback(''); }, 1600);
    }).catch(function () { setConfigFeedback(ui('保存失败，请重试', 'Save failed. Try again.')); });
  }
  function testConfig() {
    const patch = {
      model: modelInput ? modelInput.value.trim() : '',
      baseUrl: baseInput ? baseInput.value.trim() : '',
    };
    const k = keyInput ? keyInput.value.trim() : '';
    if (k) patch.apiKey = k;                 // 可测试尚未保存的新 Key
    setConfigFeedback(ui('测试中…', 'Testing…'));
    if (testCfgBtn) testCfgBtn.disabled = true;
    fetch('/api/ai-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(readJsonOrThrow).then(function (data) {
      const model = data && data.model ? data.model : ui('当前模型', 'Current model');
      setConfigFeedback(ui('连接正常：', 'Connected: ') + model);
      setTimeout(function () { setConfigFeedback(''); }, 2200);
    }).catch(function (err) {
      setConfigFeedback(err && err.message ? err.message : ui('测试失败', 'Connection test failed'));
    }).finally(function () {
      if (testCfgBtn) testCfgBtn.disabled = false;
    });
  }

  // ── 消息渲染 ──
  function syncEmpty() {
    const has = history.length > 0 || !!(messagesEl && messagesEl.querySelector('.ai-msg'));
    if (emptyEl) emptyEl.hidden = has;
  }
  function hasMathSource(source) {
    if (md && md.structure && typeof md.structure.scanFeatures === 'function') {
      return md.structure.scanFeatures(source || '').math;
    }
    return /(?:\$|\\\(|\\\[|\\begin\{|\\ref\{|\\eqref\{)/.test(source || '');
  }
  function typeset(el) {
    const mj = window.MathJax;
    if (!mj || typeof mj.typesetPromise !== 'function') {
      const ensure = window.CanvasModule && window.CanvasModule.ensureMathJax;
      if (typeof ensure !== 'function' || el.dataset.aiMathPending === '1') return;
      el.dataset.aiMathPending = '1';
      ensure(function () {
        if (el.dataset.aiMathPending !== '1') return;
        delete el.dataset.aiMathPending;
        if (el.isConnected) typeset(el);
      });
      return;
    }
    try {
      const pending = mj.typesetPromise([el]);
      if (pending && typeof pending.then === 'function') {
        el.__mathJaxTypesetPromise = pending;
        pending.then(function () {
          if (el.__mathJaxTypesetPromise === pending) el.__mathJaxTypesetPromise = null;
          // 若消息在异步排版完成前已被裁掉，补清 MathJax 内部 MathItem 引用。
          if (!el.isConnected) clearTypeset(el);
        }, function () {
          if (el.__mathJaxTypesetPromise === pending) el.__mathJaxTypesetPromise = null;
        });
      }
    } catch (e) {}
  }
  function clearTypeset(el) {
    if (el && el.dataset) delete el.dataset.aiMathPending;
    if (el && el.querySelectorAll) {
      el.querySelectorAll('[data-ai-math-pending]').forEach(function (pending) {
        delete pending.dataset.aiMathPending;
      });
    }
    if (!el || !window.MathJax || typeof window.MathJax.typesetClear !== 'function') return;
    try { window.MathJax.typesetClear([el]); } catch (e) {}
  }
  function removeMessageRow(row) {
    if (!row) return;
    clearTypeset(row);
    row.remove();
  }
  function scrollToBottom() {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateScrollbarIndicator(messagesEl);
  }

  // 复制回复原文：优先原生剪贴板（WebView2 支持），失败再退回 execCommand。
  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy failed');
      return true;
    } catch (e) {
      return Promise.reject(e);
    }
  }
  // 给 AI 回复气泡挂一个悬停浮现的「复制」按钮，复制这条回复的 Markdown 原文。
  // 复制成功/失败时弹一下（果冻 pop + 图标回弹 + 成功涟漪），停留 0.8s 后渐隐复位。
  function addCopyButton(bubble, text) {
    if (!bubble || !text) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-copy-btn';
    btn.title = ui('复制这条回复', 'Copy this reply');
    btn.setAttribute('aria-label', ui('复制这条回复', 'Copy this reply'));
    const ico = document.createElement('span');
    ico.className = 'ai-copy-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '⧉';
    const label = document.createElement('span');
    label.className = 'ai-copy-label';
    label.textContent = ui('复制', 'Copy');
    btn.appendChild(ico);
    btn.appendChild(label);
    let holdTimer = null, outTimer = null;
    function resetIdle() {
      btn.classList.remove('copied', 'copy-failed', 'ai-copy-out');
      ico.textContent = '⧉';
      label.textContent = ui('复制', 'Copy');
    }
    function flash(ok) {
      if (holdTimer) clearTimeout(holdTimer);
      if (outTimer) clearTimeout(outTimer);
      btn.classList.remove('ai-copy-out', 'copied', 'copy-failed');
      // 重启 pop 动画：先抹掉 animation，强制回流，再让 class 触发
      void btn.offsetWidth;
      btn.classList.add(ok ? 'copied' : 'copy-failed');
      ico.textContent = ok ? '✓' : '✕';
      label.textContent = ok ? ui('已复制', 'Copied') : ui('复制失败', 'Copy failed');
      holdTimer = setTimeout(function () {
        btn.classList.add('ai-copy-out');           // 0.8s 后开始渐隐
        outTimer = setTimeout(resetIdle, 400);      // 与渐隐过渡时长一致
      }, 800);
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      Promise.resolve(copyTextToClipboard(text))
        .then(function () { flash(true); })
        .catch(function () { flash(false); });
    });
    bubble.appendChild(btn);
  }
  function renderMarkdownInto(bubble, text, opts) {
    if (md && typeof md.render === 'function') {
      const rendered = typeof md.renderResult === 'function' ? md.renderResult(text) : null;
      bubble.innerHTML = rendered ? rendered.html : md.render(text);
      if (rendered ? rendered.features.math : hasMathSource(text)) typeset(bubble);
      if ((!rendered || rendered.features.mermaid) && window.MermaidRenderer) {
        window.MermaidRenderer.renderAll(bubble);
      }
    }
    else bubble.textContent = text;
    if (!opts || opts.copyable !== false) addCopyButton(bubble, text);
  }
  function appendMessage(role, content, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'ai-msg ai-msg-' + role;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.setAttribute('data-user-content', '');
    if (role === 'assistant' && !opts.plain) renderMarkdownInto(bubble, content);
    else bubble.textContent = content;       // 用户消息 / 占位文本：纯文本，绝不当 HTML
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    const transcript = messagesEl.querySelectorAll('.ai-msg');
    const overflow = transcript.length - TRANSCRIPT_LIMIT;
    for (let i = 0; i < overflow; i++) {
      if (transcript[i] === row) break;
      removeMessageRow(transcript[i]);
    }
    scrollToBottom();
    return { row: row, bubble: bubble };
  }

  // 模型写到长度上限被截断时，在气泡末尾挂一行温和提示，免得用户以为内容天然就这么短。
  function appendTruncatedNote(bubble) {
    if (!bubble) return;
    const note = document.createElement('div');
    note.className = 'ai-truncated-note';
    note.textContent = ui(
      '⚠ 这次回复写到长度上限被截断了，内容可能不完整。可让我「接着上面继续写」，或拆成更少/更短的卡片再试。',
      '⚠ This reply reached the output limit and may be incomplete. Ask me to continue, or request fewer and shorter items.',
    );
    bubble.appendChild(note);
  }

  // ── 发送 / 生成 ──
  function setActionControlsDisabled(on) {
    actionBtns.forEach(function (button) { button.disabled = on; });
    targetBtns.forEach(function (button) {
      button.disabled = on || (button === targetSelectionBtn && selectedContentCount < 1);
    });
  }
  function syncSubmitControl() {
    if (!sendBtn) return;
    const chatMode = selectedAction === 'chat';
    sendBtn.disabled = sending;
    sendBtn.classList.toggle('ai-send-preview', !chatMode);
    sendBtn.title = chatMode
      ? ui('发送聊天（Enter）', 'Send chat (Enter)')
      : ui('生成画布预览（Enter）', 'Generate canvas preview (Enter)');
    sendBtn.setAttribute('aria-label', chatMode
      ? ui('发送聊天', 'Send chat')
      : ui('生成画布预览', 'Generate canvas preview'));
    if (submitIcon) submitIcon.toggleAttribute('hidden', !chatMode);
    if (submitLabel) {
      submitLabel.hidden = chatMode;
      submitLabel.textContent = ui('生成预览', 'Generate preview');
    }
    if (input) {
      input.placeholder = chatMode
        ? ui('输入消息，Enter 发送，Shift+Enter 换行', 'Type a message. Enter to send; Shift+Enter for a new line.')
        : ui('输入画布需求，Enter 生成预览，Shift+Enter 换行', 'Describe the canvas change. Enter to preview; Shift+Enter for a new line.');
    }
    if (composerTip) {
      composerTip.textContent = chatMode
        ? ui('Enter / → 发送聊天', 'Enter / → sends chat')
        : ui('Enter / 生成预览 · 确认后才改动画布', 'Enter / Generate preview · the canvas changes only after confirmation');
    }
  }
  function setSending(on) {
    sending = on;
    if (cancelBtn) {
      cancelBtn.hidden = !on;
      cancelBtn.disabled = !on;
    }
    setActionControlsDisabled(on);
    syncSubmitControl();
    panel.classList.toggle('ai-sending', on);
  }
  function beginRequest(kind, pending) {
    if (activeRequest && activeRequest.controller) {
      activeRequest.cancelled = true;
      try { activeRequest.controller.abort(); } catch (e) {}
    }
    const controller = new AbortController();
    activeRequest = { controller: controller, kind: kind, pending: pending, cancelled: false };
    return activeRequest;
  }
  function finishRequest(req) {
    if (activeRequest === req) activeRequest = null;
  }
  function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 20);
  }
  function markRequestCanceled(pending, kind) {
    if (!pending || !pending.row || !pending.bubble) return;
    pending.row.classList.remove('ai-msg-pending', 'ai-msg-error');
    pending.row.classList.add('ai-msg-hint');
    pending.bubble.textContent = kind === 'plan'
      ? ui('已取消生成，没有改动画布。', 'Generation canceled. The canvas was not changed.')
      : ui('已取消本次回复。', 'This reply was canceled.');
    syncEmpty();
  }
  function cancelActiveRequest() {
    if (!activeRequest || !activeRequest.controller) return;
    activeRequest.cancelled = true;
    try { activeRequest.controller.abort(); } catch (e) {}
  }

  // 失败重试：把「重试」按钮挂到出错/未生成的气泡里，点它重跑上一次请求（不重复押入用户消息）。
  function addRetryButton(row) {
    if (!row || !lastRun) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-retry-btn';
    btn.textContent = ui('↻ 重试', '↻ Retry');
    btn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(row);  // 去掉这条失败气泡再重跑
      rerun();
    });
    (row.querySelector('.ai-bubble') || row).appendChild(btn);
  }
  function rerun() {
    if (!lastRun) return;
    if (lastRun.kind === 'plan') runPlan(lastRun.action, lastRun.scope);
    else runChat();
  }
  // 纯聊天的请求部分（不押入用户消息，便于重试复用）。
  function runChat() {
    setSending(true);
    const pending = appendMessage('assistant', ui('正在思考…', 'Thinking…'), { plain: true });
    pending.row.classList.add('ai-msg-pending');
    const req = beginRequest('chat', pending);
    fetch('/api/ai-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: requestMessages() }),
      signal: req.controller.signal,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(responseErrorMessage(data, r.status));
        return data;
      });
    }).then(function (data) {
      const reply = ((data.reply || '').trim()) || '（空回复）';
      pushHistory({ role: 'assistant', content: reply });
      syncContextStatus();
      pending.row.classList.remove('ai-msg-pending');
      renderMarkdownInto(pending.bubble, reply);
      if (data.truncated) appendTruncatedNote(pending.bubble);
      scrollToBottom();
    }).catch(function (err) {
      if (req.cancelled || isAbortError(err)) {
        markRequestCanceled(pending, 'chat');
        return;
      }
      pending.row.classList.remove('ai-msg-pending');
      pending.row.classList.add('ai-msg-error');
      pending.bubble.textContent = '⚠ ' + (err && err.message ? err.message : ui('出错了', 'Something went wrong'));
      addRetryButton(pending.row);
    }).finally(function () {
      finishRequest(req);
      setSending(false);
      scrollToBottom();
      if (input) input.focus();
    });
  }
  function send() {
    if (sending || !input) return;
    const text = (input.value || '').trim();
    if (!text) return;
    clearPlanHint();
    pushHistory({ role: 'user', content: text });
    syncContextStatus();
    appendMessage('user', text);
    syncEmpty();
    input.value = '';
    autoGrow();
    lastRun = { kind: 'chat' };
    runChat();
  }

  const CURVE_LABELS = {
    bezier: ['曲线', 'Curve'],
    straight: ['直线', 'Straight'],
    elbow: ['折线', 'Elbow'],
    'rounded-elbow': ['圆角折线', 'Rounded elbow'],
    's-curve': ['S 曲线', 'S curve'],
    smooth: ['平滑曲线', 'Smooth curve'],
    branch: ['枝桠曲线', 'Branch curve'],
    arc: ['弧线', 'Arc'],
    organic: ['自然曲线', 'Organic curve'],
  };

  function actionLabel(action) {
    return localize((ACTION_META[action] || ACTION_META.chat).label);
  }
  function curveLabel(curve) {
    return localize(CURVE_LABELS[curve] || [curve || '枝桠曲线', curve || 'Branch curve']);
  }
  function selectedContext() {
    const mod = window.CanvasModule;
    try {
      return mod && typeof mod.describeAIContext === 'function'
        ? mod.describeAIContext({ scope: 'selection' }) : null;
    } catch (error) { return null; }
  }
  function syncCanvasAwareness() {
    const mod = window.CanvasModule;
    let selection = selectedContext();
    let presentation = null;
    try {
      presentation = mod && typeof mod.describeAIPresentation === 'function'
        ? mod.describeAIPresentation() : null;
    } catch (error) {}
    if (presentation && presentation.mode) currentEditorMode = presentation.mode;
    selectedContentCount = selection && Array.isArray(selection.nodes) ? selection.nodes.length : 0;
    const oneMindmapNode = selectedContentCount === 1 && !!selection.nodes[0].mindmapMember;
    if (currentEditorMode === 'mindmap') {
      recommendedAction = oneMindmapNode ? 'extend_branch' : 'create_mindmap';
    } else if (selectedContentCount > 1) {
      recommendedAction = 'refine';
    } else if (selectedContentCount === 1) {
      recommendedAction = 'supplement';
    } else {
      recommendedAction = 'create_graph';
    }
    if (!actionUserChosen) selectedAction = recommendedAction;
    if (!targetUserChosen) targetScope = selectedContentCount ? 'selection' : 'canvas';
    if (!selectedContentCount && targetScope === 'selection') targetScope = 'canvas';
    syncActionPicker();
  }
  function syncActionPicker() {
    actionBtns.forEach(function (button) {
      const action = button.dataset.aiAction;
      const active = action === selectedAction;
      button.classList.toggle('active', active);
      button.classList.toggle('recommended', action === recommendedAction);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
      const icon = button.querySelector('.ai-action-icon');
      const label = button.querySelector('span:last-child');
      if (icon && ACTION_META[action]) icon.textContent = ACTION_META[action].icon;
      if (label) label.textContent = actionLabel(action);
    });
    if (actionRecommendation) {
      actionRecommendation.textContent = ui('推荐：', 'Recommended: ') + actionLabel(recommendedAction);
    }
    const targeted = selectedAction === 'supplement' || selectedAction === 'refine';
    if (targetRow) targetRow.hidden = !targeted;
    if (targetSelectionBtn) {
      targetSelectionBtn.disabled = sending || selectedContentCount < 1;
      if (selectionCountEl) {
        selectionCountEl.textContent = String(selectedContentCount);
        targetSelectionBtn.replaceChildren(
          document.createTextNode(ui('选区 ', 'Selection · ')),
          selectionCountEl,
          document.createTextNode(ui(' 个节点', selectedContentCount === 1 ? ' node' : ' nodes')),
        );
      }
    }
    targetBtns.forEach(function (button) {
      const active = button.dataset.aiTarget === targetScope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    if (actionDescription) {
      actionDescription.textContent = localize((ACTION_META[selectedAction] || ACTION_META.chat).description);
    }
    syncSubmitControl();
  }

  function useHelpAction(action) {
    if (!ACTION_META[action] || sending) return;
    selectedAction = action;
    actionUserChosen = true;
    syncActionPicker();
    closeHelp();
    const actionButton = panel.querySelector('[data-ai-action="' + action + '"]');
    const delay = prefersReduced ? 0 : PANELLET_CLOSE_MS + 20;
    setTimeout(function () {
      if (actionButton) {
        actionButton.classList.remove('ai-action-guided');
        void actionButton.offsetWidth;
        actionButton.classList.add('ai-action-guided');
        setTimeout(function () { actionButton.classList.remove('ai-action-guided'); }, 920);
      }
      if (input) input.focus();
    }, delay);
  }
  function useHelpExample(action, index) {
    const meta = ACTION_META[action];
    const examples = meta && meta.guide && Array.isArray(meta.guide.examples)
      ? meta.guide.examples : [];
    const example = examples[index];
    if (!example || sending || !input) return;
    useHelpAction(action);
    input.value = localize(example);
    autoGrow();
  }

  // 输入或画布状态不满足动作要求时，给一条会自动去重的教学提示。
  function clearPlanHint() {
    if (!messagesEl) return;
    const old = messagesEl.querySelector('.ai-msg-hint');
    if (old) old.remove();
  }
  function showPlanHint(msg) {
    clearPlanHint();
    const m = appendMessage('assistant',
      msg || ui(
        '💡 请先在输入框写清主题与用途，再选择一个画布操作生成预览。',
        '💡 Describe the topic and purpose first, then choose a canvas action to generate a preview.',
      ),
      { plain: true });
    m.row.classList.add('ai-msg-hint');
    syncEmpty();
    scrollToBottom();
  }

  function disablePreviewButtons(row) {
    row.querySelectorAll('button').forEach(function (btn) { btn.disabled = true; });
    row.querySelectorAll('input').forEach(function (control) { control.disabled = true; });
  }
  function defaultPlanText(action, scope) {
    const selection = scope === 'selection';
    if (action === 'extend_branch') return ui(
      '围绕选中的导图节点继续扩展一个清晰、互不重复的子分支。',
      'Extend the selected mind-map node with a clear subtree of non-duplicative ideas.',
    );
    if (action === 'supplement') return selection
      ? ui('检查选区还缺什么，补充相关概念、例子或推导并连接回去。', 'Find gaps in the selection, add relevant concepts, examples, or derivations, and connect them back.')
      : ui('检查整张画布还缺什么，补充相关概念、例子或推导并连接回去。', 'Find gaps across the canvas, add relevant concepts, examples, or derivations, and connect them back.');
    if (action === 'refine') return selection
      ? ui('整理精炼选区：压缩重复表述，改进标题与正文，并梳理必要连接。', 'Refine the selection: condense repetition, improve titles and bodies, and clean up necessary links.')
      : ui('整理精炼整张画布：压缩重复表述，改进标题与正文，并梳理必要连接。', 'Refine the entire canvas: condense repetition, improve titles and bodies, and clean up necessary links.');
    return '';
  }
  function planScope(action, requestedScope) {
    if (action === 'extend_branch') return 'selection';
    if (action === 'supplement' || action === 'refine') {
      return requestedScope === 'selection' ? 'selection' : 'canvas';
    }
    return 'canvas';
  }
  function readPlanSnapshot(action, requestedScope) {
    const mod = window.CanvasModule;
    if (!mod || typeof mod.describeAIContext !== 'function'
        || typeof mod.describeAIPresentation !== 'function'
        || typeof mod.applyAIPlan !== 'function') {
      return { error: ui('当前页面没有可用的 V2 画布执行器。', 'The V2 canvas executor is unavailable on this page.') };
    }
    try {
      if (typeof mod.commitPendingEdits === 'function') mod.commitPendingEdits();
      const scope = planScope(action, requestedScope);
      const canvas = mod.describeAIContext({ scope: scope });
      const editor = mod.describeAIPresentation();
      const nodes = canvas && Array.isArray(canvas.nodes) ? canvas.nodes : [];
      if (action === 'extend_branch') {
        if (nodes.length !== 1) {
          return { error: ui('扩展导图分支需要恰好选中一个有效导图节点。', 'Extend Branch requires exactly one valid mind-map node.') };
        }
        if (!nodes[0].mindmapMember) {
          return { error: ui('选中的节点不属于有效导图，请先选择一个导图节点。', 'The selected node is not part of a valid mind map.') };
        }
      }
      if ((action === 'supplement' || action === 'refine') && !nodes.length) {
        return { error: scope === 'selection'
          ? ui('选区里没有可发送的正文节点，请重新选择或改用整张画布。', 'The selection has no eligible content nodes. Select again or target the entire canvas.')
          : ui('画布里还没有可发送的正文节点，请先创建内容。', 'The canvas has no eligible content nodes yet.') };
      }
      return { scope: scope, canvas: canvas, editor: editor };
    } catch (error) {
      return { error: error && error.message ? error.message : ui('读取画布失败。', 'Could not read the canvas.') };
    }
  }
  function planLineTypes(plan) {
    const presentation = plan && plan.presentation;
    if (plan && (plan.action === 'create_mindmap' || plan.action === 'extend_branch')) {
      const curves = presentation && presentation.mindmap && presentation.mindmap.resolvedCurves;
      const branch = curves && curves.branch ? curves.branch : 'branch';
      const leaf = curves && curves.leaf ? curves.leaf : branch;
      return branch === leaf
        ? curveLabel(branch)
        : ui('主枝 ', 'Branch ') + curveLabel(branch) + ui(' · 叶枝 ', ' · Leaf ') + curveLabel(leaf);
    }
    const curve = presentation && presentation.normal && presentation.normal.resolvedEdge
      && presentation.normal.resolvedEdge.curve;
    return curveLabel(curve || 'branch');
  }
  function planTreeMeta(plan, operations) {
    const helpers = window.RelatumAIPlanCanvas;
    if (!helpers) return null;
    const tree = plan.action === 'create_mindmap'
      ? helpers.mindmapOutline(plan, operations)
      : (plan.action === 'extend_branch' ? helpers.extensionSubtree(plan, operations) : null);
    if (!tree || !tree.ok) return null;
    const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    const maxDepth = nodes.reduce(function (value, node) {
      return Math.max(value, Number(node.depth) || 0);
    }, 0);
    const root = nodes.find(function (node) { return node.ref === tree.rootRef; });
    return {
      rootRef: tree.rootRef,
      rootTitle: root && root.title ? root.title : tree.rootRef,
      levels: maxDepth + 1,
    };
  }
  function previewOperationLabel(op, kind) {
    const labels = kind === 'node'
      ? {
        create: ['新增节点', 'Create node'],
        update: ['更新节点', 'Update node'],
      }
      : {
        create: ['新增连线', 'Create edge'],
        update: ['更新连线', 'Update edge'],
        remove: ['移除连线', 'Remove edge'],
      };
    return localize(labels[op] || [op, op]);
  }
  function renderPlanPreview(pending, plan, context, repaired, initialState) {
    const helpers = window.RelatumAIPlanCanvas;
    const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
    const edges = Array.isArray(plan.edges) ? plan.edges : [];
    if (!helpers || typeof helpers.selectOperations !== 'function') {
      throw new Error(ui('计划预览组件未加载。', 'The plan preview component is unavailable.'));
    }
    pending.row.classList.add('ai-msg-preview');
    pending.bubble.textContent = '';

    let operations = helpers.selectOperations(plan, {
      nodeIndexes: initialState && initialState.nodeIndexes,
      edgeIndexes: initialState && initialState.edgeIndexes,
    });
    let nodeIndexes = new Set();
    let edgeIndexes = new Set();
    nodeIndexes = new Set(operations.nodes.map(function (entry) { return entry.index; }));
    edgeIndexes = new Set(operations.edges.map(function (entry) { return entry.index; }));
    const rootRef = plan.mindmap && plan.mindmap.rootRef;
    const rootIndex = nodes.findIndex(function (node) {
      return node && node.op === 'create' && node.ref === rootRef;
    });
    const existingTitles = {};
    (context && Array.isArray(context.nodes) ? context.nodes : []).forEach(function (node) {
      existingTitles[node.id] = node.title || node.id;
    });
    const existingEdgeLabels = {};
    (context && Array.isArray(context.edges) ? context.edges : []).forEach(function (edge) {
      existingEdgeLabels[edge.id] = (existingTitles[edge.from] || edge.from) + ' → '
        + (existingTitles[edge.to] || edge.to)
        + (edge.text ? ' · ' + String(edge.text).slice(0, 48) : '');
    });
    const newTitles = {};
    nodes.forEach(function (node) {
      if (node && node.op === 'create') newTitles[node.ref] = node.title || node.body || node.ref;
    });
    function endpointLabel(endpoint) {
      if (!endpoint) return ui('未知', 'Unknown');
      if (endpoint.kind === 'new') return newTitles[endpoint.ref] || endpoint.ref;
      return existingTitles[endpoint.id] || endpoint.id;
    }
    function nodeLabel(node) {
      const fallback = node.op === 'update' ? existingTitles[node.id] : '';
      return String(node.title || node.body || fallback || node.ref || node.id || ui('未命名', 'Untitled')).slice(0, 100);
    }
    function edgeLabel(edge) {
      if (edge.op === 'create') {
        return endpointLabel(edge.from) + ' → ' + endpointLabel(edge.to)
          + (edge.text ? ' · ' + String(edge.text).slice(0, 48) : '');
      }
      return existingEdgeLabels[edge.id] || edge.text || edge.id;
    }

    const heading = document.createElement('div');
    heading.className = 'ai-preview-heading';
    const title = document.createElement('div');
    title.className = 'ai-preview-title';
    title.textContent = ui('画布计划预览', 'Canvas plan preview');
    const actionBadge = document.createElement('span');
    actionBadge.className = 'ai-preview-action-badge';
    actionBadge.textContent = actionLabel(plan.action);
    heading.appendChild(title);
    heading.appendChild(actionBadge);
    pending.bubble.appendChild(heading);

    const summary = document.createElement('p');
    summary.className = 'ai-preview-summary';
    summary.textContent = plan.summary || actionLabel(plan.action);
    pending.bubble.appendChild(summary);

    const allOperations = helpers.selectOperations(plan, {
      nodeIndexes: nodes.map(function (_node, index) { return index; }),
      edgeIndexes: edges.map(function (_edge, index) { return index; }),
    });
    const treeMeta = planTreeMeta(plan, allOperations);
    const facts = document.createElement('dl');
    facts.className = 'ai-preview-facts';
    [
      [ui('目标', 'Target'), plan.scope === 'selection'
        ? ui('选区 · ', 'Selection · ') + ((context.selectedIds || []).length) + ui(' 个节点', ' nodes')
        : ui('整张画布', 'Entire canvas')],
      [ui('变化', 'Changes'), nodes.length + ui(' 个节点 · ', ' nodes · ') + edges.length + ui(' 条连线', ' edges')],
      [ui('最终线型', 'Final curves'), planLineTypes(plan)],
    ].concat(treeMeta ? [
      [ui('导图根', 'Mind-map root'), treeMeta.rootTitle],
      [ui('层级', 'Levels'), String(treeMeta.levels)],
    ] : []).forEach(function (fact) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = fact[0];
      dd.textContent = fact[1];
      facts.appendChild(dt);
      facts.appendChild(dd);
    });
    pending.bubble.appendChild(facts);

    const truncation = context && context.truncation;
    if (truncation && truncation.truncated) {
      const warning = document.createElement('div');
      warning.className = 'ai-preview-warning';
      warning.textContent = ui(
        '⚠ 画布上下文已截断：省略 ' + truncation.omittedNodes + ' 个节点、'
          + truncation.omittedEdges + ' 条连线，' + truncation.fieldTruncations + ' 个文本字段被裁短。',
        '⚠ Canvas context was truncated: ' + truncation.omittedNodes + ' nodes and '
          + truncation.omittedEdges + ' edges were omitted; ' + truncation.fieldTruncations + ' text fields were clipped.',
      );
      pending.bubble.appendChild(warning);
    }
    if (repaired) {
      const repairedNote = document.createElement('div');
      repairedNote.className = 'ai-preview-note';
      repairedNote.textContent = ui('结构已由后端自动修复并重新校验。', 'The structure was repaired and revalidated by the server.');
      pending.bubble.appendChild(repairedNote);
    }

    function makeSection(titleText, items, kind) {
      if (!items.length) return null;
      const details = document.createElement('details');
      details.className = 'ai-preview-section';
      details.open = true;
      const sectionTitle = document.createElement('summary');
      sectionTitle.textContent = titleText;
      details.appendChild(sectionTitle);
      const list = document.createElement('div');
      list.className = 'ai-preview-checklist';
      items.forEach(function (item, index) {
        const label = document.createElement('label');
        label.className = 'ai-preview-check';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.aiPreviewKind = kind;
        checkbox.dataset.aiPreviewIndex = String(index);
        checkbox.checked = kind === 'node' ? nodeIndexes.has(index) : edgeIndexes.has(index);
        if (kind === 'node' && index === rootIndex) {
          checkbox.checked = true;
          checkbox.disabled = true;
          label.classList.add('root-locked');
        }
        const copy = document.createElement('span');
        const badge = document.createElement('b');
        badge.textContent = previewOperationLabel(item.op, kind);
        const text = document.createElement('span');
        text.textContent = kind === 'node' ? nodeLabel(item) : edgeLabel(item);
        copy.appendChild(badge);
        copy.appendChild(text);
        label.appendChild(checkbox);
        label.appendChild(copy);
        list.appendChild(label);
      });
      details.appendChild(list);
      return details;
    }
    const nodeSection = makeSection(ui('节点变化', 'Node changes'), nodes, 'node');
    const edgeSection = makeSection(ui('连线变化', 'Edge changes'), edges, 'edge');
    if (nodeSection) pending.bubble.appendChild(nodeSection);
    if (edgeSection) pending.bubble.appendChild(edgeSection);

    let relayoutCheckbox = null;
    if (plan.scope === 'selection'
        && plan.action !== 'create_mindmap' && plan.action !== 'extend_branch') {
      const relayout = document.createElement('label');
      relayout.className = 'ai-preview-relayout';
      relayoutCheckbox = document.createElement('input');
      relayoutCheckbox.type = 'checkbox';
      relayoutCheckbox.checked = !!(initialState && initialState.relayoutSelection);
      const relayoutCopy = document.createElement('span');
      relayoutCopy.textContent = ui(
        '重新排版所选范围（范围外节点固定）',
        'Relayout the selected area (nodes outside stay fixed)',
      );
      relayout.appendChild(relayoutCheckbox);
      relayout.appendChild(relayoutCopy);
      pending.bubble.appendChild(relayout);
    }

    const selectionStatus = document.createElement('div');
    selectionStatus.className = 'ai-preview-selection-status';
    pending.bubble.appendChild(selectionStatus);
    const notice = document.createElement('div');
    notice.className = 'ai-preview-apply-notice';
    notice.hidden = true;
    pending.bubble.appendChild(notice);

    const actions = document.createElement('div');
    actions.className = 'ai-preview-actions';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ai-btn-primary';
    applyBtn.textContent = ui('应用所选变化', 'Apply selected changes');
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'ai-btn-secondary';
    retryBtn.textContent = ui('重生成', 'Regenerate');
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'ai-btn-secondary';
    discardBtn.textContent = ui('取消预览', 'Discard preview');
    actions.appendChild(applyBtn);
    actions.appendChild(retryBtn);
    actions.appendChild(discardBtn);
    pending.bubble.appendChild(actions);

    function syncPreviewSelection() {
      operations = helpers.selectOperations(plan, {
        nodeIndexes: Array.from(nodeIndexes),
        edgeIndexes: Array.from(edgeIndexes),
      });
      nodeIndexes = new Set(operations.nodes.map(function (entry) { return entry.index; }));
      edgeIndexes = new Set(operations.edges.map(function (entry) { return entry.index; }));
      pending.bubble.querySelectorAll('[data-ai-preview-kind]').forEach(function (checkbox) {
        const index = Number(checkbox.dataset.aiPreviewIndex);
        checkbox.checked = checkbox.dataset.aiPreviewKind === 'node'
          ? nodeIndexes.has(index) : edgeIndexes.has(index);
      });
      const total = operations.nodes.length + operations.edges.length;
      selectionStatus.textContent = ui(
        '已选 ' + operations.nodes.length + ' 个节点变化、' + operations.edges.length + ' 个连线变化',
        operations.nodes.length + ' node changes and ' + operations.edges.length + ' edge changes selected',
      );
      applyBtn.disabled = total < 1;
    }
    pending.bubble.addEventListener('change', function (event) {
      const checkbox = event.target.closest('[data-ai-preview-kind]');
      if (!checkbox) return;
      const index = Number(checkbox.dataset.aiPreviewIndex);
      const set = checkbox.dataset.aiPreviewKind === 'node' ? nodeIndexes : edgeIndexes;
      if (checkbox.checked) set.add(index);
      else set.delete(index);
      syncPreviewSelection();
    });
    syncPreviewSelection();

    applyBtn.addEventListener('click', function () {
      if (sending) return;
      const mod = window.CanvasModule;
      let result = null;
      try {
        result = mod && typeof mod.applyAIPlan === 'function'
          ? mod.applyAIPlan(plan, {
            nodeIndexes: Array.from(nodeIndexes),
            edgeIndexes: Array.from(edgeIndexes),
            relayoutSelection: !!(relayoutCheckbox && relayoutCheckbox.checked),
          }) : null;
      } catch (error) {
        result = { ok: false, reason: 'apply-failed', detail: error.message };
      }
      if (!result || !result.ok) {
        notice.hidden = false;
        notice.classList.add('error');
        if (result && result.reason === 'preview-stale') {
          notice.textContent = ui(
            '⚠ 画布内容或连接已经变化，这份预览已过期。请重生成后再应用。',
            '⚠ Canvas content or connections changed. This preview is stale; regenerate it before applying.',
          );
          applyBtn.disabled = true;
          pending.row.classList.add('ai-msg-preview-stale');
        } else {
          notice.textContent = ui('⚠ 应用失败：', '⚠ Apply failed: ')
            + ((result && (result.detail || result.reason)) || ui('未知错误', 'Unknown error'));
        }
        return;
      }
      disablePreviewButtons(pending.row);
      pending.row.classList.remove('ai-msg-preview', 'ai-msg-preview-stale');
      pending.row.classList.add('ai-msg-plan-done');
      const curves = result.finalLineTypes
        ? (result.finalLineTypes.branch === result.finalLineTypes.leaf
          ? curveLabel(result.finalLineTypes.branch)
          : curveLabel(result.finalLineTypes.branch) + ' / ' + curveLabel(result.finalLineTypes.leaf))
        : curveLabel(result.finalLineType || 'branch');
      pending.bubble.textContent = ui(
        '✦ 已应用 ' + operations.nodes.length + ' 个节点变化、' + operations.edges.length
          + ' 个连线变化；最终线型：' + curves + '。不满意可按 Ctrl+Z 整批撤销。',
        '✦ Applied ' + operations.nodes.length + ' node changes and ' + operations.edges.length
          + ' edge changes. Final curve: ' + curves + '. Press Ctrl+Z to undo the whole batch.',
      );
      pushHistory({
        role: 'assistant',
        content: ui('（已确认并应用画布计划：', '(Canvas plan confirmed and applied: ')
          + actionLabel(plan.action) + ui('）', ')'),
      });
      syncContextStatus();
      syncCanvasAwareness();
      scrollToBottom();
    });
    retryBtn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(pending.row);
      runPlan(plan.action, plan.scope);
    });
    discardBtn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(pending.row);
      syncEmpty();
      scrollToBottom();
      if (input) input.focus();
    });
    pending.row.__aiRefreshLanguage = function () {
      const bubble = document.createElement('div');
      bubble.className = 'ai-bubble';
      bubble.setAttribute('data-user-content', '');
      pending.row.replaceChildren(bubble);
      pending.bubble = bubble;
      renderPlanPreview(pending, plan, context, repaired, {
        nodeIndexes: Array.from(nodeIndexes),
        edgeIndexes: Array.from(edgeIndexes),
        relayoutSelection: !!(relayoutCheckbox && relayoutCheckbox.checked),
      });
    };
    syncEmpty();
    scrollToBottom();
  }

  // 计划请求不重复押入用户消息，供重试复用；每次重试重新抓取上下文与表现快照。
  function runPlan(action, requestedScope) {
    const snapshot = readPlanSnapshot(action, requestedScope);
    if (snapshot.error) {
      const failure = appendMessage('assistant', '⚠ ' + snapshot.error, { plain: true });
      failure.row.classList.add('ai-msg-error');
      addRetryButton(failure.row);
      return;
    }
    const payload = {
      action: action,
      messages: requestMessages(),
      language: currentLanguage() === 'en' ? 'en' : 'zh-CN',
      canvas: snapshot.canvas,
      editor: snapshot.editor,
    };
    setSending(true);
    const pending = appendMessage('assistant', ui(
      '正在生成并校验画布计划… 可点底部“取消”停止等待。',
      'Generating and validating a canvas plan… Use Cancel below to stop waiting.',
    ), { plain: true });
    pending.row.classList.add('ai-msg-pending');
    const req = beginRequest('plan', pending);
    fetch('/api/ai-plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: req.controller.signal,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(responseErrorMessage(data, r.status));
        return data;
      });
    }).then(function (data) {
      pending.row.classList.remove('ai-msg-pending');
      if (!data || !data.ok || !data.plan || data.plan.version !== 2) {
        throw new Error(ui('服务器没有返回有效的 V2 计划。', 'The server did not return a valid V2 plan.'));
      }
      renderPlanPreview(pending, data.plan, snapshot.canvas, !!data.repaired);
      scrollToBottom();
    }).catch(function (err) {
      if (req.cancelled || isAbortError(err)) {
        markRequestCanceled(pending, 'plan');
        return;
      }
      pending.row.classList.remove('ai-msg-pending');
      pending.row.classList.add('ai-msg-error');
      pending.bubble.textContent = '⚠ ' + (err && err.message ? err.message : ui('出错了', 'Something went wrong'));
      addRetryButton(pending.row);
    }).finally(function () {
      finishRequest(req);
      setSending(false);
      scrollToBottom();
      if (input) input.focus();
    });
  }
  function onRunAction() {
    if (sending || !input) return;
    if (selectedAction === 'chat') return;
    const scope = planScope(selectedAction, targetScope);
    let text = (input.value || '').trim();
    if (!text && (selectedAction === 'create_graph' || selectedAction === 'create_mindmap')) {
      showPlanHint(ui(
        '请先输入要生成的主题，再点“生成预览”。',
        'Enter a topic before generating a preview.',
      ));
      if (input) input.focus();
      return;
    }
    const snapshot = readPlanSnapshot(selectedAction, scope);
    if (snapshot.error) { showPlanHint('⚠ ' + snapshot.error); return; }
    if (!text) text = defaultPlanText(selectedAction, scope);
    clearPlanHint();
    pushHistory({ role: 'user', content: text });
    syncContextStatus();
    appendMessage('user', text);
    syncEmpty();
    input.value = '';
    autoGrow();
    lastRun = { kind: 'plan', action: selectedAction, scope: scope };
    runPlan(selectedAction, scope);
  }
  function submitSelectedAction() {
    if (selectedAction === 'chat') send();
    else onRunAction();
  }

  function clearContext() {
    history = [];
    if (messagesEl) {
      messagesEl.querySelectorAll('.ai-msg').forEach(removeMessageRow);
    }
    syncEmpty();
    syncContextStatus();
    setConfigFeedback(ui('上下文已清空', 'Context cleared'));
    setTimeout(function () { setConfigFeedback(''); }, 1600);
  }

  function autoGrow() {
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = Math.max(INPUT_MIN_HEIGHT, Math.min(INPUT_MAX_HEIGHT, window.innerHeight * 0.28));
    const nextHeight = Math.max(INPUT_MIN_HEIGHT, Math.min(maxHeight, input.scrollHeight));
    const scrollable = input.scrollHeight > maxHeight + 1;
    input.style.height = Math.ceil(nextHeight) + 'px';
    input.style.overflowY = scrollable ? 'auto' : 'hidden';
    input.classList.toggle('ai-input-scrollable', scrollable);
    updateScrollbarIndicator(input);
  }

  // ── 绑定 ──
  if (resizeHandle) {
    resizeHandle.addEventListener('pointerdown', onPanelResizeStart);
    resizeHandle.addEventListener('keydown', onPanelResizeKeydown);
    resizeHandle.addEventListener('dblclick', resetPanelWidth);
  }
  if (toggleBtn) toggleBtn.addEventListener('click', togglePanel);
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (helpBtn) helpBtn.addEventListener('click', toggleHelp);
  if (gearBtn) gearBtn.addEventListener('click', toggleSettings);
  if (contextToggle) contextToggle.addEventListener('click', toggleContextMenu);
  if (contextCloseBtn) contextCloseBtn.addEventListener('click', function () { closeContextMenu(); });
  if (contextClearBtn) contextClearBtn.addEventListener('click', clearContext);
  contextModeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { setContextMode(btn.dataset.aiContextMode); });
  });
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', saveConfig);
  if (testCfgBtn) testCfgBtn.addEventListener('click', testConfig);
  if (clearBtn) clearBtn.addEventListener('click', clearContext);
  if (cancelBtn) cancelBtn.addEventListener('click', cancelActiveRequest);
  // 「清除我的 Key」：二次确认后让后端把 data/ai.json 里的 Key 清空（分发前防误带）
  let clearKeyArmed = false, clearKeyTimer = null;
  function resetClearKeyBtn() {
    clearKeyArmed = false;
    if (clearKeyTimer) { clearTimeout(clearKeyTimer); clearKeyTimer = null; }
    if (clearKeyBtn) {
      clearKeyBtn.textContent = ui('清除我的 Key', 'Clear my key');
      clearKeyBtn.classList.remove('armed');
    }
  }
  function onClearKey() {
    if (!clearKeyArmed) {                       // 第一次点：进入确认态，3 秒内不再点就还原
      clearKeyArmed = true;
      if (clearKeyBtn) {
        clearKeyBtn.textContent = ui('再点一次确认清除', 'Click again to confirm');
        clearKeyBtn.classList.add('armed');
      }
      clearKeyTimer = setTimeout(resetClearKeyBtn, 3000);
      return;
    }
    resetClearKeyBtn();                          // 第二次点：真的清
    setConfigFeedback(ui('清除中…', 'Clearing…'));
    fetch('/api/ai-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),     // 显式空串 = 清空（与"留空不改"区分：那种情况根本不发 apiKey）
    }).then(readJsonOrThrow).then(function (cfg) {
      configLoaded = true;
      updateKeyHint(cfg);
      if (keyInput) keyInput.value = '';
      setConfigFeedback(ui('Key 已清除', 'Key cleared'));
      setTimeout(function () { setConfigFeedback(''); }, 1800);
    }).catch(function () { setConfigFeedback(ui('清除失败，请重试', 'Could not clear the key. Try again.')); });
  }
  if (clearKeyBtn) clearKeyBtn.addEventListener('click', onClearKey);
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    submitSelectedAction();
  });
  if (actionPicker) actionPicker.addEventListener('click', function (e) {
    const actionBtn = e.target.closest('[data-ai-action]');
    if (actionBtn && actionPicker.contains(actionBtn)) {
      selectedAction = actionBtn.dataset.aiAction;
      actionUserChosen = true;
      syncActionPicker();
      return;
    }
    const targetBtn = e.target.closest('[data-ai-target]');
    if (targetBtn && actionPicker.contains(targetBtn) && !targetBtn.disabled) {
      targetScope = targetBtn.dataset.aiTarget;
      targetUserChosen = true;
      syncActionPicker();
    }
  });
  if (actionPicker) actionPicker.addEventListener('keydown', function (e) {
    const current = e.target.closest('[data-ai-action]');
    if (!current || !/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(e.key)) return;
    const buttons = Array.from(actionBtns).filter(function (button) { return !button.disabled; });
    const index = buttons.indexOf(current);
    if (index < 0) return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    selectedAction = next.dataset.aiAction;
    actionUserChosen = true;
    syncActionPicker();
    next.focus();
  });
  if (input) {
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      // Enter 执行当前操作，Shift+Enter 换行（输入法组字中的 Enter 不拦截）。
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitSelectedAction();
      }
    });
  }
  [
    messagesEl,
    helpPanel && helpPanel.querySelector('.ai-help-book'),
    settings,
    input,
  ].forEach(installAutoScrollbar);
  // 把模板文字填进输入框（帮助书模板 / 空状态「快速开始」共用），不直接发送，留给用户挑动作。
  function fillInputWithPrompt(text) {
    if (!input) return;
    input.value = text || '';
    autoGrow();
    input.focus();
  }
  // 空状态的「快速开始」范例：点一下填进输入框，再由用户点「✦ 生成到画布」或发送。
  if (emptyEl) emptyEl.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-prompt]');
    if (!btn) return;
    fillInputWithPrompt(currentLanguage() === 'en'
      ? (btn.getAttribute('data-prompt-en') || btn.getAttribute('data-prompt') || '')
      : (btn.getAttribute('data-prompt') || ''));
  });
  if (helpPanel) {
    helpPanel.addEventListener('click', function (e) {
      const pageBtn = e.target.closest('[data-ai-help-page]');
      if (pageBtn && helpPanel.contains(pageBtn)) {
        const index = AI_HELP_PAGES.findIndex(function (item) { return item.id === pageBtn.dataset.aiHelpPage; });
        if (index >= 0) gotoHelpPage(index);
        return;
      }
      const helpAction = e.target.closest('[data-ai-help-action]');
      if (helpAction && helpPanel.contains(helpAction)) {
        useHelpAction(helpAction.dataset.aiHelpAction);
        return;
      }
      const helpExample = e.target.closest('[data-ai-help-example]');
      if (helpExample && helpPanel.contains(helpExample)) {
        useHelpExample(
          helpExample.dataset.aiHelpExample,
          Number(helpExample.dataset.exampleIndex),
        );
        return;
      }
      const action = e.target.closest('[data-action]');
      if (action && helpPanel.contains(action)) {
        if (action.dataset.action === 'ai-help-prev') gotoHelpPage(helpPageIndex - 1);
        if (action.dataset.action === 'ai-help-next') {
          if (helpPageIndex >= AI_HELP_PAGES.length - 1) closeHelp();
          else gotoHelpPage(helpPageIndex + 1);
        }
        return;
      }
    });
  }
  document.addEventListener('editor:selectionchange', syncCanvasAwareness);
  document.addEventListener('editor:modechange', function (event) {
    if (event.detail && event.detail.mode) currentEditorMode = event.detail.mode;
    syncCanvasAwareness();
  });
  document.addEventListener('relatum:languagechange', function () {
    syncResizeHandle(panel.getBoundingClientRect().width || preferredPanelWidth);
    syncContextStatus();
    syncActionPicker();
    if (helpOpen()) renderHelpPage(helpPageIndex, 0);
    if (messagesEl) {
      messagesEl.querySelectorAll('.ai-msg-preview').forEach(function (row) {
        if (typeof row.__aiRefreshLanguage === 'function') row.__aiRefreshLanguage();
      });
    }
  });
  // Esc：焦点在面板内时，先收设置弹窗，再关面板；不绑 document，避免干扰画布快捷键。
  panel.addEventListener('keydown', function (e) {
    const typing = e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '') || e.target.isContentEditable);
    if (helpOpen() && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      gotoHelpPage(helpPageIndex + (e.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (e.key !== 'Escape') return;
    if (helpOpen()) { closeHelp(); e.stopPropagation(); e.preventDefault(); return; }
    if (settingsOpen()) { closeSettings(); e.stopPropagation(); e.preventDefault(); return; }
    if (contextOpen()) { closeContextMenu(); e.stopPropagation(); e.preventDefault(); return; }
    if (panelOpen()) { closePanel(); e.stopPropagation(); e.preventDefault(); }
  });
  window.addEventListener('resize', function () {
    if (panelResizeState) finishPanelResize(true);
    restorePanelWidth();
    autoGrow();
    updateAllScrollbarIndicators();
  });
  window.addEventListener('blur', function () {
    if (panelResizeState) finishPanelResize(true);
    if (scrollbarDragState) finishScrollbarDrag();
  });

  restorePanelWidth();
  autoGrow();
  syncEmpty();
  syncContextStatus();
  syncCanvasAwareness();
})();

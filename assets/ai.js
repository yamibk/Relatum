// AI 助手 — 右侧滑出对话栏，代理后端调 DeepSeek。
// 故意写得小、零依赖：复用 MarkdownMini 渲染回复、MathJax（若已加载）排版公式。
// 配置（Key/模型/接口地址）经后端 /api/ai-config 存 data/ai.json，前端不长期保存。
// 阶段 1：纯对话 /api/ai-chat。
// 阶段 2：「生成到画布」按钮 /api/ai-compose —— 后端按《创作指南》让模型吐卡片+连线、
//   排好坐标，前端先给预览，用户确认后再调 CanvasModule.injectCanvas 注入当前画布（可整体 Ctrl+Z 撤销）。

(function () {
  'use strict';

  const panel = document.querySelector('[data-role="ai-panel"]');
  if (!panel) return;

  const toggleBtn = document.querySelector('[data-role="ai-toggle"]');
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
  const cancelBtn = panel.querySelector('[data-role="ai-cancel"]');
  const chipsEl = panel.querySelector('[data-role="ai-chips"]');   // 预设快捷按钮容器
  const contextToggle = panel.querySelector('[data-role="ai-context-toggle"]');
  const contextMenu = panel.querySelector('[data-role="ai-context-menu"]');
  const contextLabel = panel.querySelector('[data-role="ai-context-label"]');
  const contextCount = panel.querySelector('[data-role="ai-context-count"]');
  const contextHint = panel.querySelector('[data-role="ai-context-hint"]');
  const contextClearBtn = panel.querySelector('[data-role="ai-context-clear"]');
  const contextCloseBtn = panel.querySelector('[data-role="ai-context-close"]');
  const contextModeBtns = panel.querySelectorAll('[data-ai-context-mode]');

  // 阶段 1 的轻量人设；阶段 2 会换成《AI 笔记创作指南》并接入"注入画布"。
  const SYSTEM_PROMPT = '你是嵌入在一款中文本地知识画布工具里的 AI 助手，帮用户生成、整理、润色学习与科研笔记。'
    + '请用简洁清楚的中文回答；数学公式用 $...$ 或 $$...$$ 包裹，代码放进围栏代码块。';

  let history = [{ role: 'system', content: SYSTEM_PROMPT }];   // 内存对话（含开头 system）
  let sending = false;
  let configLoaded = false;
  let lastRun = null;          // 上一次请求 { kind:'chat'|'compose', mode? }，供失败重试
  let activeRequest = null;    // 当前可取消请求 { controller, kind, pending, cancelled }

  const md = window.MarkdownMini;
  const HISTORY_LIMIT = 40;    // 与后端单次上下文上限一致，避免长会话请求体和内存无界增长
  const TRANSCRIPT_LIMIT = 120;
  const CLOSE_MS = 240;   // 与 CSS 过渡时长一致
  const PANELLET_CLOSE_MS = 190;
  const CONTEXT_MODE_KEY = 'canvas:ai-context-mode:v1';
  const prefersReduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let contextMode = loadContextMode();

  const AI_HELP_PAGES = [
    {
      id: 'start',
      eyebrow: '01 · START',
      title: '先分清：聊天和画图',
      subtitle: '输入框不是唯一入口。发送是聊天，快捷按钮才会把内容变成卡片。',
      sections: [
        ['发送箭头', '适合问概念、让它改写一段话、帮你想结构。它只在右侧对话区回复，不会改动画布。'],
        ['上方快捷按钮', '生成到画布、挂到选中、基于画布补充、整理精炼，都会先生成预览；你点“放进画布”后才真正写入。'],
        ['第一次使用', '先点右上角齿轮填 API Key，再点“测试连接”。Key 只保存在本机。'],
      ],
      prompts: [
        ['问概念', '用高中生能听懂的方式解释惯性，并给 2 个生活例子。'],
        ['改写', '把这段笔记改成更适合复习的短句：'],
      ],
    },
    {
      id: 'generate',
      eyebrow: '02 · CREATE',
      title: '从零生成一张画布',
      subtitle: '主题、数量、用途写清楚，比“随便生成一下”稳定很多。',
      sections: [
        ['好提示词公式', '主题 + 卡片数量 + 卡片类型 + 读者/用途。例：给我 8 张卡片，适合考前复习。'],
        ['结果怎么进画布', '先点“生成到画布”，看预览；满意再点“放进画布”。不满意可重生成或取消。'],
        ['数量要明确', '写“只要 3 张”“生成 1 张总结卡”会比“简单整理一下”更可控。'],
      ],
      prompts: [
        ['知识点卡组', '整理牛顿第二定律：生成 6 张卡片，包含定义、公式、变量含义、生活例子、典型题、易错点。'],
        ['论文导读', '把“机器学习中的过拟合”整理成 7 张入门卡片：定义、原因、表现、检测、解决方法、例子、复习总结。'],
        ['代码笔记', '整理 C 语言指针：生成 5 张卡片，包含概念、内存示意、常见错误、代码例子、练习题。'],
      ],
    },
    {
      id: 'attach',
      eyebrow: '03 · ATTACH',
      title: '挂到当前选中节点',
      subtitle: '先在画布里点选一张卡片，再让 AI 生成新内容并连回它。',
      sections: [
        ['什么时候用', '你已经有一张中心卡，想往下接例题、前置概念、易错提醒、拓展阅读。'],
        ['怎么操作', '选中那张卡片，在输入框写“补什么”，点“挂到选中”。AI 会优先把新卡片连到选中的卡片。'],
        ['多选也可以', '框选几张相关卡片后使用，会把它们作为当前关注范围；新内容不会围绕整张画布乱发散。'],
      ],
      prompts: [
        ['补三张', '围绕我选中的卡片，补充 3 张相关卡片：前置概念、典型例题、易错提醒。'],
        ['加例题', '给我选中的卡片补 2 张例题卡：一张基础题，一张容易出错的变式题。'],
        ['接下一层', '把我选中的卡片继续展开成下一层知识树，生成 4 张子卡片并连回选中卡片。'],
      ],
    },
    {
      id: 'polish',
      eyebrow: '04 · REFINE',
      title: '基于画布补充 / 整理精炼',
      subtitle: '它会读当前画布或当前选区，只新增卡片，不改你原来的卡片。',
      sections: [
        ['基于画布补充', '查漏补缺：找出还缺的背景知识、对比例子、推导步骤、常见误区，帮你补上并连到相关卡片。'],
        ['整理精炼', '把已有内容重新整理成更有条理的一套卡片：目录卡、定义卡、例题卡、易错卡，配 Callout 和语义配色。'],
        ['两者区别', '补充＝把“缺的”补进来；整理精炼＝把“已有的”重排得更清楚。两者都只新增、不动你的原卡片。'],
        ['选区优先', '如果你选中了卡片，它会优先读选区；没有选区才读整张画布。'],
      ],
      prompts: [
        ['查漏补缺', '检查当前画布还缺哪些关键概念，补充 5 张卡片，并连到最相关的已有卡片。'],
        ['复习结构', '把当前内容整理成更适合复习的结构：目录卡、定义卡、例题卡、易错卡。'],
        ['整理表达', '把当前画布内容做成更清晰的版本：标题更短，正文分层，易错点用 warning Callout。'],
      ],
    },
    {
      id: 'context',
      eyebrow: '05 · CONTEXT',
      title: '上下文：你说了算',
      subtitle: '对话上下文是右侧聊天历史，不等于整张画布。你可以连续追问，也可以每次只发当前输入。',
      sections: [
        ['连续对话', '默认模式。AI 会参考右侧之前的问答，适合追问、让它“按刚才的版本再改”。关闭 AI 侧栏不会清空它。'],
        ['单次请求', '只把当前这条输入发给 AI，不带旧聊天。适合换主题、怕旧问题干扰、或者想让结果更干净。'],
        ['清空上下文', '点上下文条或齿轮里的“清空上下文”会清掉右侧聊天记录。刷新/关闭这张画布页面后，内存上下文也会重新开始。'],
      ],
      prompts: [
        ['连续追问', '沿用刚才的主题，把内容改成更适合画布卡片的结构：标题短一点，层级清楚一点。'],
        ['换主题前', '从现在开始忽略前面的聊天，只围绕【新主题】生成 5 张复习卡。'],
        ['少受干扰', '不要参考前面的例子。只根据这条要求回答：把【主题】拆成定义、公式、例题、易错点。'],
      ],
    },
    {
      id: 'templates',
      eyebrow: '06 · PROMPTS',
      title: '常用提示词模板',
      subtitle: '点一下会填进输入框，你可以把主题名替换掉再生成。',
      sections: [
        ['学习笔记', '适合数学、物理、C 语言、论文阅读、课程复习。'],
        ['科研想法', '适合把一个问题拆成假设、证据、方法、风险、下一步。'],
        ['别只写闲聊', '少写“随便聊聊”，多写“生成几张、给谁看、用来干嘛、要什么结构”。'],
      ],
      prompts: [
        ['一章课', '把【主题】整理成一章课的画布：1 张目录卡、5 张概念卡、2 张例题卡、1 张总结卡。'],
        ['公式推导', '整理【公式/定理】：生成定义、适用条件、推导链、变量解释、例题、易错提醒。'],
        ['论文精读', '把【论文主题】拆成：研究问题、核心方法、关键实验、创新点、局限、我可以借鉴的地方。'],
        ['科研想法', '围绕【想法】生成一张研究计划画布：问题、假设、现有证据、实验设计、风险、下一步。'],
        ['考试复盘', '围绕【错题/知识点】生成 5 张复盘卡：错因、正确思路、同类题、记忆钩子、下次检查清单。'],
      ],
    },
    {
      id: 'trouble',
      eyebrow: '07 · SAFE',
      title: '取消、预览和排错',
      subtitle: 'AI 生成慢或方向不对，可以中途取消；结果进画布前也能放弃。',
      sections: [
        ['取消生成', '底部出现“取消”时，说明前端正在等待模型回复。点它会停止本次等待，不会改动画布。'],
        ['预览取消', '生成完成后，如果预览不满意，点“重生成”或“取消生成”；只有“放进画布”才真正添加卡片。'],
        ['常见问题', '提示没反应，多半是没填 API Key；挂到选中失败，多半是没有先选中正文卡片。'],
      ],
      prompts: [
        ['更严格', '只生成 3 张卡片，不要扩展到其它主题；每张正文不超过 80 字。'],
        ['更细', '刚才太粗略了。请保留主题，但增加公式解释和一个具体例题。'],
        ['更清爽', '刚才太长了。请改成更适合扫读的卡片：短标题、短段落、重点用 Callout。'],
      ],
    },
  ];

  // ── 面板开关 ──
  function panelOpen() { return panel.classList.contains('open'); }
  function openPanel() {
    panel.hidden = false;
    void panel.offsetWidth;                 // 触发过渡
    panel.classList.add('open');
    document.body.classList.add('ai-panel-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    if (!configLoaded) loadConfig();
    syncContextStatus();
    setTimeout(function () { if (input) input.focus(); }, 60);
  }
  function closePanel() {
    panel.classList.remove('open');
    document.body.classList.remove('ai-panel-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (!panelOpen()) panel.hidden = true; }, CLOSE_MS);
  }
  function togglePanel() { if (panelOpen()) closePanel(); else openPanel(); }

  // ── 问号教程 / 齿轮设置开关 ──
  let helpPageIndex = 0;
  let helpFlipping = false;
  let helpNavReady = false;
  let helpWheelAccum = 0;
  let helpWheelResetTimer = null;

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
    return history.filter(function (m) { return m && m.role !== 'system'; }).length;
  }
  function pushHistory(message) {
    history.push(message);
    const overflow = history.length - (HISTORY_LIMIT + 1);
    if (overflow > 0) history.splice(1, overflow);  // 固定保留开头 system + 最近消息
  }
  function requestMessages() {
    if (contextMode === 'continuous') return history.slice();
    const lastUser = history.slice().reverse().find(function (m) { return m && m.role === 'user'; });
    return lastUser ? [history[0], lastUser] : [history[0]];
  }
  function syncContextStatus() {
    const count = historyCount();
    const continuous = contextMode === 'continuous';
    if (contextLabel) contextLabel.textContent = continuous ? '上下文：连续对话' : '上下文：单次请求';
    if (contextCount) contextCount.textContent = continuous ? (count + ' 条') : '不带历史';
    if (contextHint) {
      contextHint.textContent = continuous
        ? '下一次请求会带上右侧聊天历史。关闭 AI 侧栏不会清空；刷新或关闭画布页面会重新开始。'
        : '下一次请求只带当前输入，不带旧聊天。右侧记录仍会显示，你也可以随时清空。';
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
  }
  function closePanellet(el, button, immediate) {
    if (!el || el.hidden) return;
    el.dataset.aiPanelletState = 'closed';
    el.classList.remove('open');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (prefersReduced || immediate) {
      el.hidden = true;
      el.classList.remove('ai-panellet-closing');
      return;
    }
    el.classList.add('ai-panellet-closing');
    setTimeout(function () {
      if (!el.classList.contains('open')) {
        el.hidden = true;
        el.classList.remove('ai-panellet-closing');
      }
    }, PANELLET_CLOSE_MS);
  }
  function syncHelpNav(index, animate) {
    if (!helpPanel) return;
    const item = AI_HELP_PAGES[index];
    const nav = helpPanel.querySelector('.ai-help-nav');
    const slider = helpPanel.querySelector('[data-role="ai-help-nav-slider"]');
    const spineSlider = helpPanel.querySelector('[data-role="ai-help-spine-slider"]');
    if (!item || !nav || !slider || !spineSlider) return;
    let active = null;
    let activeSpine = null;
    helpPanel.querySelectorAll('[data-ai-help-page]').forEach(function (button) {
      const selected = button.dataset.aiHelpPage === item.id;
      button.classList.toggle('active', selected);
      if (selected && button.closest('.ai-help-nav')) active = button;
      if (selected && button.closest('.ai-help-spine')) activeSpine = button;
    });
    if (!active || !activeSpine) return;
    if (!animate || !helpNavReady) {
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
    if (!animate || !helpNavReady) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          slider.classList.remove('no-transition');
          spineSlider.classList.remove('no-transition');
        });
      });
    }
    helpNavReady = true;
  }
  function helpPromptButtons(prompts) {
    if (!Array.isArray(prompts) || !prompts.length) return '';
    return '<div class="ai-help-template-list">'
      + prompts.map(function (item) {
        return '<button type="button" data-prompt="' + esc(item[1]) + '"><b>'
          + esc(item[0]) + '</b><span>' + esc(item[1]) + '</span></button>';
      }).join('') + '</div>';
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
      copy.innerHTML = '<div class="ai-help-page-intro"><p>' + esc(item.eyebrow) + '</p><h3>'
        + esc(item.title) + '</h3><span>' + esc(item.subtitle) + '</span></div>'
        + '<div class="ai-help-sections">'
        + item.sections.map(function (section) {
          return '<section class="ai-help-section"><h4>' + esc(section[0]) + '</h4><p>'
            + esc(section[1]) + '</p></section>';
        }).join('') + '</div>'
        + helpPromptButtons(item.prompts);
      if (position) position.textContent = String(index + 1).padStart(2, '0') + ' / '
        + String(AI_HELP_PAGES.length).padStart(2, '0');
      if (book) book.scrollTop = 0;
    };
    syncHelpNav(index, !!direction);
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
    const next = ((index % total) + total) % total;
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
    requestAnimationFrame(function () { syncHelpNav(helpPageIndex, false); });
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
      keyHint.textContent = '已设置 ' + (cfg.keyHint || '');
      keyHint.classList.remove('ai-key-missing');
    } else {
      keyHint.textContent = '尚未设置';
      keyHint.classList.add('ai-key-missing');
    }
  }
  function setConfigFeedback(t) { if (cfgFeedback) cfgFeedback.textContent = t || ''; }
  function readJsonOrThrow(r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || ('请求失败（' + r.status + '）'));
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
    setConfigFeedback('保存中…');
    fetch('/api/ai-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(readJsonOrThrow).then(function (cfg) {
      configLoaded = true;
      updateKeyHint(cfg);
      if (keyInput) keyInput.value = '';     // 不在输入框里留明文
      if (modelInput && cfg.model) modelInput.value = cfg.model;
      if (baseInput && cfg.baseUrl) baseInput.value = cfg.baseUrl;
      setConfigFeedback('已保存');
      setTimeout(function () { setConfigFeedback(''); }, 1600);
    }).catch(function () { setConfigFeedback('保存失败，请重试'); });
  }
  function testConfig() {
    const patch = {
      model: modelInput ? modelInput.value.trim() : '',
      baseUrl: baseInput ? baseInput.value.trim() : '',
    };
    const k = keyInput ? keyInput.value.trim() : '';
    if (k) patch.apiKey = k;                 // 可测试尚未保存的新 Key
    setConfigFeedback('测试中…');
    if (testCfgBtn) testCfgBtn.disabled = true;
    fetch('/api/ai-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(readJsonOrThrow).then(function (data) {
      const model = data && data.model ? data.model : '当前模型';
      setConfigFeedback('连接正常：' + model);
      setTimeout(function () { setConfigFeedback(''); }, 2200);
    }).catch(function (err) {
      setConfigFeedback(err && err.message ? err.message : '测试失败');
    }).finally(function () {
      if (testCfgBtn) testCfgBtn.disabled = false;
    });
  }

  // ── 消息渲染 ──
  function syncEmpty() {
    const has = history.some(function (m) { return m.role !== 'system'; })
      || !!(messagesEl && messagesEl.querySelector('.ai-msg'));
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
  function scrollToBottom() { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; }

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
    btn.title = '复制这条回复';
    btn.setAttribute('aria-label', '复制这条回复');
    const ico = document.createElement('span');
    ico.className = 'ai-copy-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '⧉';
    const label = document.createElement('span');
    label.className = 'ai-copy-label';
    label.textContent = '复制';
    btn.appendChild(ico);
    btn.appendChild(label);
    let holdTimer = null, outTimer = null;
    function resetIdle() {
      btn.classList.remove('copied', 'copy-failed', 'ai-copy-out');
      ico.textContent = '⧉';
      label.textContent = '复制';
    }
    function flash(ok) {
      if (holdTimer) clearTimeout(holdTimer);
      if (outTimer) clearTimeout(outTimer);
      btn.classList.remove('ai-copy-out', 'copied', 'copy-failed');
      // 重启 pop 动画：先抹掉 animation，强制回流，再让 class 触发
      void btn.offsetWidth;
      btn.classList.add(ok ? 'copied' : 'copy-failed');
      ico.textContent = ok ? '✓' : '✕';
      label.textContent = ok ? '已复制' : '复制失败';
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
    note.textContent = '⚠ 这次回复写到长度上限被截断了，内容可能不完整。可让我「接着上面继续写」，或拆成更少/更短的卡片再试。';
    bubble.appendChild(note);
  }

  // ── 发送 / 生成 ──
  function setChipsDisabled(on) {
    if (!chipsEl) return;
    chipsEl.querySelectorAll('.ai-chip').forEach(function (b) { b.disabled = on; });
  }
  function setSending(on) {
    sending = on;
    if (sendBtn) sendBtn.disabled = on;
    if (cancelBtn) {
      cancelBtn.hidden = !on;
      cancelBtn.disabled = !on;
    }
    setChipsDisabled(on);
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
    pending.bubble.textContent = kind === 'compose'
      ? '已取消生成，没有改动画布。'
      : '已取消本次回复。';
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
    btn.textContent = '↻ 重试';
    btn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(row);  // 去掉这条失败气泡再重跑
      rerun();
    });
    (row.querySelector('.ai-bubble') || row).appendChild(btn);
  }
  function rerun() {
    if (!lastRun) return;
    if (lastRun.kind === 'compose') runCompose(lastRun.mode);
    else runChat();
  }
  // 纯聊天的请求部分（不押入用户消息，便于重试复用）。
  function runChat() {
    setSending(true);
    const pending = appendMessage('assistant', '正在思考…', { plain: true });
    pending.row.classList.add('ai-msg-pending');
    const req = beginRequest('chat', pending);
    fetch('/api/ai-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: requestMessages() }),
      signal: req.controller.signal,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('请求失败（' + r.status + '）'));
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
      pending.bubble.textContent = '⚠ ' + (err && err.message ? err.message : '出错了');
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
    clearComposeHint();
    pushHistory({ role: 'user', content: text });
    syncContextStatus();
    appendMessage('user', text);
    syncEmpty();
    input.value = '';
    autoGrow();
    lastRun = { kind: 'chat' };
    runChat();
  }

  // 预设按钮空着点 / 画布为空时：给一条会自动去重的教学提示，而不是静默无反应
  //（用户反馈过"点了一点反馈都没有、不知道有啥用"）。
  function clearComposeHint() {
    if (!messagesEl) return;
    const old = messagesEl.querySelector('.ai-msg-hint');
    if (old) old.remove();
  }
  function showComposeHint(msg) {
    clearComposeHint();
    const m = appendMessage('assistant',
      msg || '💡「✦ 生成到画布」会把你的需求做成一张张卡片，直接画进当前画布。先在下面输入框写要点'
      + '（例：「整理傅里叶变换：定义、性质、典型例子」），再点上面的按钮。',
      { plain: true });
    m.row.classList.add('ai-msg-hint');
    syncEmpty();
    scrollToBottom();
  }

  // 「生成到画布」：generate / attach / supplement / beautify。与「发送」分流——发送=纯聊天，
  // 这些=产出笔记画进画布。attach/supplement/beautify 会把当前画布内容随请求发给后端。
  // 没按格式输出时降级成普通回复，不乱注入。
  const COMPOSE_DEFAULTS = {
    attach: '请围绕当前选中的卡片生成新的下级卡片，并把新卡片连回选中的卡片。',
    supplement: '请基于当前画布已有的内容，补充相关的概念、例子或推导，并连到相关的卡片。',
    beautify: '请基于当前画布已有的内容，生成更清晰、更美观的改进版本（作为新增卡片，别改我的原卡片）。',
  };
  function readSelectedComposeContext(mod) {
    try { return mod.describeCanvas ? mod.describeCanvas({ selectedOnly: true }) : null; } catch (e) {}
    return null;
  }
  function readComposeContext(mod) {
    const selected = readSelectedComposeContext(mod);
    if (selected && selected.nodes && selected.nodes.length) return selected;
    try { return mod.describeCanvas ? mod.describeCanvas() : null; } catch (e) {}
    return null;
  }
  function defaultComposeText(mode, desc) {
    const scope = desc && desc.scope === 'selection' ? '当前选中的卡片' : '当前画布已有的内容';
    if (mode === 'attach') return '请围绕当前选中的卡片生成新的下级卡片，并把新卡片连回选中的卡片。';
    if (mode === 'supplement') return '请基于' + scope + '，补充相关的概念、例子或推导，并连到相关的卡片。';
    if (mode === 'beautify') return '请基于' + scope + '，生成更清晰、更美观的改进版本（作为新增卡片，别改我的原卡片）。';
    return COMPOSE_DEFAULTS[mode] || '';
  }
  function composeScopeText(desc) {
    return desc && desc.scope === 'selection' ? '当前选中的卡片' : '当前画布';
  }
  function selectedAnchorIds(context) {
    if (!context || context.scope !== 'selection' || !Array.isArray(context.nodes)) return [];
    const out = [];
    context.nodes.forEach(function (n) {
      const id = n && n.id ? String(n.id) : '';
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out.slice(0, 3);
  }
  function hasSelectedAnchorEdge(edges, anchors) {
    return edges.some(function (e) {
      if (!e) return false;
      const fromOld = typeof e.from === 'string' && anchors.indexOf(e.from) >= 0 && typeof e.to === 'number';
      const toOld = typeof e.to === 'string' && anchors.indexOf(e.to) >= 0 && typeof e.from === 'number';
      return fromOld || toOld;
    });
  }
  function ensureSelectedAnchors(data, context) {
    if (!data || !data.canvas) return data;
    const canvas = data.canvas;
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    if (!nodes.length) return data;
    const anchors = selectedAnchorIds(context);
    if (!anchors.length) return data;
    const edges = Array.isArray(canvas.edges) ? canvas.edges.slice() : [];
    if (hasSelectedAnchorEdge(edges, anchors)) return data;
    anchors.forEach(function (id, i) {
      edges.push({ from: id, to: Math.min(i, nodes.length - 1), text: '补充' });
    });
    canvas.edges = edges;
    data.edgeCount = edges.length;
    data.anchorFixed = true;
    return data;
  }
  function disablePreviewButtons(row) {
    row.querySelectorAll('button').forEach(function (btn) { btn.disabled = true; });
  }
  function applyComposePreview(pending, data) {
    const mod = window.CanvasModule;
    if (!mod || typeof mod.injectCanvas !== 'function') return;
    disablePreviewButtons(pending.row);
    let result = null;
    try {
      const rightInset = panelOpen() ? (panel.offsetWidth || 0) : 0;
      result = mod.injectCanvas(data.canvas, { rightInset: rightInset });
    } catch (e) { result = null; }
    const count = result && result.ok ? (result.count || 0) : 0;
    pending.row.classList.remove('ai-msg-preview');
    if (count > 0) {
      const edges = data.edgeCount || 0;
      pending.bubble.textContent = '✦ 已在画布中添加 ' + count + ' 张卡片'
        + (edges ? '、' + edges + ' 条连线' : '') + '。不满意可按 Ctrl+Z 整批撤销。';
      pending.row.classList.add('ai-msg-compose-done');
      pushHistory({ role: 'assistant', content: '（已生成 ' + count + ' 张卡片注入画布）' });
      syncContextStatus();
    } else {
      pending.row.classList.add('ai-msg-error');
      pending.bubble.textContent = '⚠ 没能把回复变成画布卡片，请重试或换个说法';
      addRetryButton(pending.row);
    }
    syncEmpty();
    scrollToBottom();
  }
  function renderComposePreview(pending, data, mode, context) {
    const canvas = data.canvas || {};
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const rawEdges = Array.isArray(canvas.edges) ? canvas.edges : [];
    const edges = Number.isFinite(data.edgeCount) ? data.edgeCount : rawEdges.length;
    pending.row.classList.add('ai-msg-preview');
    pending.bubble.textContent = '';

    const title = document.createElement('div');
    title.className = 'ai-preview-title';
    title.textContent = '已生成预览';
    pending.bubble.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'ai-preview-meta';
    meta.textContent = '将基于' + composeScopeText(context) + '添加 ' + nodes.length + ' 张卡片'
      + (edges ? '、' + edges + ' 条连线' : '') + '。满意再放进画布。'
      + (data.anchorFixed ? ' 已自动补上与选中卡片的连接。' : '');
    pending.bubble.appendChild(meta);
    if (data.truncated) appendTruncatedNote(pending.bubble);

    const list = document.createElement('ol');
    list.className = 'ai-preview-list';
    nodes.slice(0, 5).forEach(function (n) {
      const li = document.createElement('li');
      li.textContent = String(n.text || n.title || '未命名').slice(0, 80);
      list.appendChild(li);
    });
    if (nodes.length > 5) {
      const li = document.createElement('li');
      li.textContent = '… 还有 ' + (nodes.length - 5) + ' 张';
      list.appendChild(li);
    }
    if (nodes.length) pending.bubble.appendChild(list);

    const existingTitleById = {};
    if (context && Array.isArray(context.nodes)) {
      context.nodes.forEach(function (n) {
        if (n && n.id) existingTitleById[String(n.id)] = String(n.title || n.id);
      });
    }
    function endpointLabel(ep) {
      if (typeof ep === 'number' && nodes[ep]) return String(nodes[ep].text || nodes[ep].title || '未命名');
      if (typeof ep === 'string') return existingTitleById[ep] ? ('已有：' + existingTitleById[ep]) : ('已有：' + ep);
      return '';
    }
    const linkLines = [];
    rawEdges.slice(0, 5).forEach(function (e) {
      if (!e) return;
      const from = endpointLabel(e.from);
      const to = endpointLabel(e.to);
      if (!from || !to) return;
      const text = String(e.text || '').trim();
      linkLines.push(from.slice(0, 48) + ' → ' + to.slice(0, 48) + (text ? '（' + text.slice(0, 24) + '）' : ''));
    });
    if (linkLines.length) {
      const linkTitle = document.createElement('div');
      linkTitle.className = 'ai-preview-section-title';
      linkTitle.textContent = '连线预览';
      pending.bubble.appendChild(linkTitle);
      const linkList = document.createElement('ul');
      linkList.className = 'ai-preview-list ai-preview-links';
      linkLines.forEach(function (line) {
        const li = document.createElement('li');
        li.textContent = line;
        linkList.appendChild(li);
      });
      if (rawEdges.length > linkLines.length) {
        const li = document.createElement('li');
        li.textContent = '… 还有 ' + (rawEdges.length - linkLines.length) + ' 条';
        linkList.appendChild(li);
      }
      pending.bubble.appendChild(linkList);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-preview-actions';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ai-btn-primary';
    applyBtn.textContent = '放进画布';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'ai-btn-secondary';
    retryBtn.textContent = '重生成';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ai-btn-secondary';
    cancelBtn.textContent = '取消生成';
    actions.appendChild(applyBtn);
    actions.appendChild(retryBtn);
    actions.appendChild(cancelBtn);
    pending.bubble.appendChild(actions);

    applyBtn.addEventListener('click', function () {
      if (sending) return;
      applyComposePreview(pending, data);
    });
    retryBtn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(pending.row);
      runCompose(mode);
    });
    cancelBtn.addEventListener('click', function () {
      if (sending) return;
      removeMessageRow(pending.row);
      syncEmpty();
      scrollToBottom();
      if (input) input.focus();
    });
    syncEmpty();
    scrollToBottom();
  }
  // 请求部分（不押入用户消息，便于重试复用）。
  function runCompose(mode) {
    const mod = window.CanvasModule;
    if (!mod || typeof mod.injectCanvas !== 'function') {
      appendMessage('assistant', '⚠ 当前页面没有可注入的画布', { plain: true })
        .row.classList.add('ai-msg-error');
      return;
    }
    const payload = { messages: requestMessages(), mode: mode };
    if (mode === 'attach') {
      payload.canvas = readSelectedComposeContext(mod);
    } else if (mode === 'supplement' || mode === 'beautify') {
      payload.canvas = readComposeContext(mod);
    }
    if (mode === 'attach' && (!payload.canvas || !payload.canvas.nodes || !payload.canvas.nodes.length)) {
      appendMessage('assistant', '⚠ 现在没有选中的正文卡片，请先选中一张卡片再挂接。', { plain: true })
        .row.classList.add('ai-msg-error');
      return;
    }
    setSending(true);
    const pending = appendMessage('assistant', '正在生成笔记… 可点底部“取消”停止等待。', { plain: true });
    pending.row.classList.add('ai-msg-pending');
    const req = beginRequest('compose', pending);
    fetch('/api/ai-compose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: req.controller.signal,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('请求失败（' + r.status + '）'));
        return data;
      });
    }).then(function (data) {
      pending.row.classList.remove('ai-msg-pending');
      if (data && data.ok && data.canvas) {
        ensureSelectedAnchors(data, payload.canvas);
        renderComposePreview(pending, data, mode, payload.canvas);
      } else {
        // 模型没按格式输出 → 当普通回复展示，不注入。
        const reply = ((data && data.reply) || '').trim() || '（空回复）';
        pushHistory({ role: 'assistant', content: reply });
        syncContextStatus();
        renderMarkdownInto(pending.bubble, reply);
        if (data && data.truncated) appendTruncatedNote(pending.bubble);
      }
      scrollToBottom();
    }).catch(function (err) {
      if (req.cancelled || isAbortError(err)) {
        markRequestCanceled(pending, 'compose');
        return;
      }
      pending.row.classList.remove('ai-msg-pending');
      pending.row.classList.add('ai-msg-error');
      pending.bubble.textContent = '⚠ ' + (err && err.message ? err.message : '出错了');
      addRetryButton(pending.row);
    }).finally(function () {
      finishRequest(req);
      setSending(false);
      scrollToBottom();
      if (input) input.focus();
    });
  }
  // 点预设按钮：校验 → 押入用户消息（generate 必填正文；补充/美化正文可空、以画布为输入）→ 发起。
  function onChip(mode) {
    if (sending || !input) return;
    const mod = window.CanvasModule;
    if (!mod || typeof mod.injectCanvas !== 'function') {
      appendMessage('assistant', '⚠ 当前页面没有可注入的画布', { plain: true })
        .row.classList.add('ai-msg-error');
      return;
    }
    let text = (input.value || '').trim();
    if (mode === 'generate') {
      if (!text) { showComposeHint(); if (input) input.focus(); return; }
    } else if (mode === 'attach') {
      const desc = readSelectedComposeContext(mod);
      if (!desc || !desc.nodes || !desc.nodes.length) {
        showComposeHint('先在画布里选中一张正文卡片，再点「↳ 挂到选中」。'
          + '这样 AI 才知道新内容要接到哪里。');
        return;
      }
      if (!text) text = defaultComposeText(mode, desc);
    } else {
      let desc = null;
      desc = readComposeContext(mod);
      if (!desc || !desc.nodes || !desc.nodes.length) {
        showComposeHint('当前画布还是空的——「↳ 挂到选中 / 🔗 基于画布补充 / ✨ 整理精炼」需要画布上先有卡片。'
          + '可以先用「✦ 生成到画布」从零生成，或自己建几张卡片。');
        return;
      }
      if (!text) text = defaultComposeText(mode, desc);
    }
    clearComposeHint();
    pushHistory({ role: 'user', content: text });
    syncContextStatus();
    appendMessage('user', text);
    syncEmpty();
    input.value = '';
    autoGrow();
    lastRun = { kind: 'compose', mode: mode };
    runCompose(mode);
  }

  function clearContext() {
    history = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (messagesEl) {
      messagesEl.querySelectorAll('.ai-msg').forEach(removeMessageRow);
    }
    syncEmpty();
    syncContextStatus();
    setConfigFeedback('上下文已清空');
    setTimeout(function () { setConfigFeedback(''); }, 1600);
  }

  function autoGrow() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  }

  // ── 绑定 ──
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
    if (clearKeyBtn) { clearKeyBtn.textContent = '清除我的 Key'; clearKeyBtn.classList.remove('armed'); }
  }
  function onClearKey() {
    if (!clearKeyArmed) {                       // 第一次点：进入确认态，3 秒内不再点就还原
      clearKeyArmed = true;
      if (clearKeyBtn) { clearKeyBtn.textContent = '再点一次确认清除'; clearKeyBtn.classList.add('armed'); }
      clearKeyTimer = setTimeout(resetClearKeyBtn, 3000);
      return;
    }
    resetClearKeyBtn();                          // 第二次点：真的清
    setConfigFeedback('清除中…');
    fetch('/api/ai-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),     // 显式空串 = 清空（与"留空不改"区分：那种情况根本不发 apiKey）
    }).then(readJsonOrThrow).then(function (cfg) {
      configLoaded = true;
      updateKeyHint(cfg);
      if (keyInput) keyInput.value = '';
      setConfigFeedback('Key 已清除');
      setTimeout(function () { setConfigFeedback(''); }, 1800);
    }).catch(function () { setConfigFeedback('清除失败，请重试'); });
  }
  if (clearKeyBtn) clearKeyBtn.addEventListener('click', onClearKey);
  if (form) form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  if (chipsEl) chipsEl.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-mode]');
    if (btn && chipsEl.contains(btn)) onChip(btn.getAttribute('data-mode'));
  });
  if (input) {
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      // Enter 发送，Shift+Enter 换行（输入法组字中的 Enter 不拦截）
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
  }
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
    fillInputWithPrompt(btn.getAttribute('data-prompt') || '');
  });
  if (helpPanel) {
    helpPanel.addEventListener('click', function (e) {
      const pageBtn = e.target.closest('[data-ai-help-page]');
      if (pageBtn && helpPanel.contains(pageBtn)) {
        const index = AI_HELP_PAGES.findIndex(function (item) { return item.id === pageBtn.dataset.aiHelpPage; });
        if (index >= 0) gotoHelpPage(index);
        return;
      }
      const action = e.target.closest('[data-action]');
      if (action && helpPanel.contains(action)) {
        if (action.dataset.action === 'ai-help-prev') gotoHelpPage(helpPageIndex - 1);
        if (action.dataset.action === 'ai-help-next') gotoHelpPage(helpPageIndex + 1);
        return;
      }
      const btn = e.target.closest('[data-prompt]');
      if (!btn || !helpPanel.contains(btn) || !input) return;
      closeHelp();
      fillInputWithPrompt(btn.getAttribute('data-prompt') || '');
    });
    const helpSpine = helpPanel.querySelector('.ai-help-spine');
    if (helpSpine) helpSpine.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (helpFlipping) return;
      helpWheelAccum += e.deltaY;
      clearTimeout(helpWheelResetTimer);
      helpWheelResetTimer = window.setTimeout(function () { helpWheelAccum = 0; }, 200);
      if (Math.abs(helpWheelAccum) < 24) return;
      const direction = helpWheelAccum > 0 ? 1 : -1;
      helpWheelAccum = 0;
      gotoHelpPage(helpPageIndex + direction);
    }, { passive: false });
  }
  window.addEventListener('resize', function () { if (helpOpen()) syncHelpNav(helpPageIndex, false); });
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

  syncEmpty();
  syncContextStatus();
})();

(function () {
  'use strict';

  const STORAGE_KEY = 'canvas:editorOnboarding:v2';
  const INITIAL_LANGUAGE_STORAGE_KEY = 'canvas:initialLanguageChosen:v1';
  const LANGUAGE_STORAGE_KEY = 'canvas:toolbarLanguage';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const replayButton = document.querySelector('[data-role="onboarding-reset"]');
  const editorPage = document.querySelector('.editor-page');
  let overlay = null;
  let pageIndex = 0;
  let flipping = false;
  let restoreFocus = null;
  let practice = null;
  let readyState = null;
  let languagePicker = null;
  let choosingInitialLanguage = false;

  const COPY = {
    'zh-CN': {
      eyebrow: 'RELATUM · FIRST STEPS',
      title: '认识你的画布',
      skip: '跳过引导',
      previous: '上一步',
      next: '下一步',
      replay: '重播演示',
      replayEntry: '重新学习画布编辑器',
      replayEntryHint: '11 个动画演示 · 随时重新上手',
      close: '关闭新手引导',
      position: (index, total) => String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0'),
      pages: [
        {
          kicker: '01 · CREATE', title: '双击空白处，新建一张卡片',
          body: '想记什么，就在空白处双击。输入内容后点一下外面，卡片就建好了。',
          note: '卡片适合较完整的内容；便签适合记一个短想法。', scene: 'create',
        },
        {
          kicker: '02 · CONNECT', title: '按住 Alt，拖出一条连线',
          body: '从一个节点拖向另一个节点，就能把两条内容连起来。',
          note: '选中节点后，Tab 新建子节点，Enter 新建同级节点。', scene: 'connect',
        },
        {
          kicker: '03 · NAVIGATE', title: '按住空格拖动，滚轮缩放',
          body: '内容太多时，按住空格拖动画布。使用滚轮缩放，方向键也可以移动视野。',
          note: '左下角会显示当前缩放比例。', scene: 'navigate',
        },
        {
          kicker: '04 · CANVAS', title: '画布模式：自由记录和连接',
          body: '双击新建内容，把卡片拖到任意位置，再用连线建立关系。',
          note: '右键点击节点，可以快速换颜色、复制或删除。顶栏“工具”是临时入口，不是第四种工作模式。', scene: 'canvas-mode',
        },
        {
          kicker: '05 · MIND MAP', title: '导图模式：一键排版和换样式',
          body: '选中一组相连的节点，点击导图预设，就能自动整理位置、节点样式和连线。',
          note: '还可以调整层距、分支距离、线型和配色。', scene: 'mindmap-mode',
        },
        {
          kicker: '06 · SHAPES', title: '图案模式：给内容加分区和重点',
          body: '用盒子划分区域，用色块做背景，再加重点便签、旁注和文字说明。',
          note: '图案只负责视觉整理，不会改变节点和连线关系。', scene: 'decor-mode',
        },
        {
          kicker: '07 · PANEL', title: '按 Tab，自由收起和展开面板',
          body: '右侧面板挡住内容时，按一下 Tab 就能收起；再按一次，面板会重新展开。',
          note: '点击面板右上角的“手电筒”，还能把面板熄灭成几乎透明的状态；再点一次即可恢复。', scene: 'panel-control',
        },
        {
          kicker: '08 · COLOR BLOCK', title: '按住鼠标右键，拖出纯色色块',
          body: '在画布空白处按住鼠标右键，拖出需要的大小，松开就会生成一个纯色色块。',
          note: '纯色色块适合做背景和分区；右键单击空白处会切回“选择”工具。', scene: 'color-block',
        },
        {
          kicker: '09 · READER', title: '选中节点，按 F 打开放大阅读',
          body: '先点一下节点，再按 F。正文会在阅读浮层里打开，适合阅读、编辑和批注。',
          note: '再按 F、按 Esc，或点右上角关闭，都能回到画布。', scene: 'reader',
        },
        {
          kicker: '10 · GROUP', title: '框选节点，点击“+ 分组”',
          body: '从空白处拖出选框，把一组节点框起来。右下角出现“+ 分组”后，点一下就能创建分组。',
          note: '分组不会打乱节点位置；拖动分组标题，可以带着全部成员一起移动。', scene: 'group',
        },
        {
          kicker: '11 · BEGIN', title: '现在自己试一遍',
          body: '双击创建两个节点，写下内容，再按住 Alt 从一个节点拖向另一个节点。',
          note: '以后可以从编辑器右下角的“？”重新打开这份引导。', scene: 'begin',
          action: '开始我的第一张画布',
        },
      ],
      practice: [
        ['创建第一个节点', '在呼吸光圈附近双击空白处。'],
        ['写下一个想法', '编辑刚建的节点或画布上的任意其他节点，然后点击节点外结束编辑。'],
        ['创建第二个节点', '在第一个节点旁边的空白处双击，再建一个节点。'],
        ['连接两个节点', '按住 Alt，从一个节点拖向任意另一个节点。'],
      ],
      practiceLabel: '亲手试试', cancelPractice: '退出练习',
      doneTitle: '完成：你已经创建、编辑并连接了节点',
      doneBody: '以后想再练一遍，可以点击右下角的“？”重新打开引导。',
      done: '知道了', showModes: '看看三种模式',
    },
    en: {
      eyebrow: 'RELATUM · FIRST STEPS', title: 'Meet your canvas', skip: 'Skip guide', previous: 'Back', next: 'Next',
      replay: 'Replay demo', replayEntry: 'Replay editor guide', replayEntryHint: '11 animated demos · Refresh anytime', close: 'Close onboarding',
      position: (index, total) => String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0'),
      pages: [
        { kicker: '01 · CREATE', title: 'Double-click empty space to create a card', body: 'Double-click wherever you want to write. Type your content, then click outside the card to finish.', note: 'Use cards for fuller notes and sticky notes for short ideas.', scene: 'create' },
        { kicker: '02 · CONNECT', title: 'Hold Alt and drag a connection', body: 'Drag from one node to another to connect their content.', note: 'With a node selected, Tab creates a child and Enter creates a sibling.', scene: 'connect' },
        { kicker: '03 · NAVIGATE', title: 'Hold Space to pan; use the wheel to zoom', body: 'When the canvas grows, hold Space and drag it. The wheel zooms, and arrow keys move the view.', note: 'The bottom-left corner shows the current zoom level.', scene: 'navigate' },
        { kicker: '04 · CANVAS', title: 'Canvas mode: place and connect freely', body: 'Double-click to add content, drag cards anywhere, and connect related notes.', note: 'Right-click a node to recolor, duplicate, or delete it. Tools is a temporary entry, not a fourth workspace mode.', scene: 'canvas-mode' },
        { kicker: '05 · MIND MAP', title: 'Mind Map mode: arrange and style in one click', body: 'Select connected nodes and click a preset to arrange their positions, node styles, and lines.', note: 'You can also change level spacing, branch spacing, line shapes, and colors.', scene: 'mindmap-mode' },
        { kicker: '06 · SHAPES', title: 'Shapes mode: add sections and emphasis', body: 'Use boxes to group areas, color blocks as backgrounds, and notes or text for extra explanation.', note: 'Shapes change the visual layout, not the node relationships.', scene: 'decor-mode' },
        { kicker: '07 · PANEL', title: 'Press Tab to hide or restore the panel', body: 'When the right panel covers your work, press Tab to hide it. Press Tab again to bring it back.', note: 'Click the flashlight at the panel’s top-right to dim it until it is almost transparent; click again to restore it.', scene: 'panel-control' },
        { kicker: '08 · COLOR BLOCK', title: 'Hold the right mouse button and drag a color block', body: 'Hold the right mouse button on empty canvas space, drag to the size you need, then release to create a solid color block.', note: 'Use color blocks for backgrounds and sections. Right-click empty space without dragging to return to Select.', scene: 'color-block' },
        { kicker: '09 · READER', title: 'Select a node and press F to open the reader', body: 'Select a node, then press F. Its content opens in a larger reader for reading, editing, and annotation.', note: 'Press F or Esc again, or use the top-right close button, to return to the canvas.', scene: 'reader' },
        { kicker: '10 · GROUP', title: 'Box-select nodes, then click “+ Group”', body: 'Drag a selection box around several nodes. When “+ Group” appears at the bottom-right, click it to create a group.', note: 'Grouping keeps every node in place. Drag the group title to move all members together.', scene: 'group' },
        { kicker: '11 · BEGIN', title: 'Now try it yourself', body: 'Create two nodes, write something, then hold Alt and drag from one node to any other node.', note: 'You can replay this guide from the editor’s ? menu.', scene: 'begin', action: 'Start my first canvas' },
      ],
      practice: [
        ['Create the first node', 'Double-click empty space near the breathing ring.'],
        ['Write one idea', 'Edit the new node or any other node on the canvas, then click outside it to finish.'],
        ['Create the second node', 'Double-click empty space beside the first node.'],
        ['Connect two nodes', 'Hold Alt and drag from one node to any other node.'],
      ],
      practiceLabel: 'Try it yourself', cancelPractice: 'Exit practice', doneTitle: 'Done: you created, edited, and connected nodes',
      doneBody: 'Use the “?” button at the bottom-right whenever you want to replay this guide.', done: 'Got it', showModes: 'Show the three modes',
    },
  };

  function language() {
    return document.documentElement.dataset.uiLanguage === 'en'
      || (window.RelatumI18n && window.RelatumI18n.language === 'en') ? 'en' : 'zh-CN';
  }

  function copy() { return COPY[language()]; }

  function suggestedLanguage() {
    const languages = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages : [navigator.language || ''];
    return languages.some(function (value) {
      return String(value || '').toLowerCase().startsWith('zh');
    }) ? 'zh-CN' : 'en';
  }

  function persistInitialLanguage(next) {
    try { localStorage.setItem(INITIAL_LANGUAGE_STORAGE_KEY, next); } catch (e) {}
  }

  function applyInitialLanguage(next) {
    if (window.RelatumI18n && typeof window.RelatumI18n.setLanguage === 'function') {
      window.RelatumI18n.setLanguage(next, true);
      return;
    }
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch (e) {}
    document.documentElement.lang = next;
    document.documentElement.dataset.uiLanguage = next;
    if (document.body) document.body.dataset.uiLanguage = next;
  }

  function trapLanguagePickerFocus(event) {
    if (!languagePicker || event.key !== 'Tab') return;
    const choices = Array.from(languagePicker.querySelectorAll('[data-language-choice]'));
    if (!choices.length) return;
    const first = choices[0];
    const last = choices[choices.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function chooseInitialLanguage(next) {
    if (choosingInitialLanguage || !languagePicker) return;
    choosingInitialLanguage = true;
    const normalized = next === 'en' ? 'en' : 'zh-CN';
    applyInitialLanguage(normalized);
    persistInitialLanguage(normalized);
    languagePicker.querySelectorAll('[data-language-choice]').forEach(function (button) {
      button.disabled = true;
      button.classList.toggle('selected', button.dataset.languageChoice === normalized);
    });
    languagePicker.classList.remove('open');
    window.setTimeout(function () {
      if (languagePicker) {
        languagePicker.remove();
        languagePicker = null;
      }
      choosingInitialLanguage = false;
      openGuide({ page: 0 });
    }, reduceMotion ? 0 : 230);
  }

  function openLanguagePicker() {
    if (languagePicker) return;
    const suggested = suggestedLanguage();
    const el = document.createElement('div');
    el.className = 'editor-onboarding editor-language-welcome';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="editor-onboarding-backdrop" aria-hidden="true"></div>'
      + '<section class="editor-onboarding-panel editor-language-panel" role="dialog" aria-modal="true" aria-labelledby="editor-language-title" aria-describedby="editor-language-description">'
      + '<header class="editor-language-head"><div class="editor-language-mark" aria-hidden="true"><svg viewBox="0 0 72 52"><path d="M18 15 C30 15 30 35 43 35 M18 15 C34 15 39 15 54 15"/></svg><i></i><i></i><i></i></div>'
      + '<p>RELATUM · WELCOME</p><h2 id="editor-language-title"><span lang="zh-CN">选择你的语言</span><span lang="en">Choose your language</span></h2></header>'
      + '<div class="editor-language-choices">'
      + '<button type="button" data-language-choice="zh-CN" class="' + (suggested === 'zh-CN' ? 'suggested' : '') + '" aria-label="中文，Chinese"><span class="editor-language-code">ZH</span><span class="editor-language-name"><strong lang="zh-CN">中文</strong><small lang="en">Chinese</small></span><span class="editor-language-arrow" aria-hidden="true">→</span><em class="editor-language-suggested">系统建议 · Suggested</em></button>'
      + '<button type="button" data-language-choice="en" class="' + (suggested === 'en' ? 'suggested' : '') + '" aria-label="English，英文"><span class="editor-language-code">EN</span><span class="editor-language-name"><strong lang="en">English</strong><small lang="zh-CN">英文</small></span><span class="editor-language-arrow" aria-hidden="true">→</span><em class="editor-language-suggested">Suggested · 系统建议</em></button>'
      + '</div><footer id="editor-language-description" class="editor-language-foot"><span lang="zh-CN">以后可以在右下角的设置中更改</span><i aria-hidden="true"></i><span lang="en">You can change this later in Settings.</span></footer></section>';
    document.body.appendChild(el);
    languagePicker = el;
    el.addEventListener('click', function (event) {
      const choice = event.target.closest('[data-language-choice]');
      if (choice) chooseInitialLanguage(choice.dataset.languageChoice);
    });
    el.addEventListener('keydown', trapLanguagePickerFocus);
    document.body.classList.add('editor-onboarding-open');
    setCanvasSuspended(true);
    requestAnimationFrame(function () {
      if (!languagePicker) return;
      languagePicker.setAttribute('aria-hidden', 'false');
      languagePicker.classList.add('open');
      const suggestedChoice = languagePicker.querySelector('.suggested');
      if (suggestedChoice) suggestedChoice.focus({ preventScroll: true });
    });
  }

  function renderReplayEntry() {
    if (!replayButton) return;
    const c = copy();
    const label = replayButton.querySelector('[data-role="onboarding-reset-label"]');
    const hint = replayButton.querySelector('[data-role="onboarding-reset-hint"]');
    if (label) label.textContent = c.replayEntry;
    else replayButton.textContent = c.replayEntry;
    if (hint) hint.textContent = c.replayEntryHint;
  }

  function sceneMarkup(scene) {
    const en = language() === 'en';
    const labels = en
      ? { core: 'Core idea', clue: 'Key clue', expand: 'Keep growing', define: 'Define', example: 'Example', summary: 'Summary', canvas: 'Canvas', mindmap: 'Mind Map', shapes: 'Shapes', structure: 'Thinking', mine: 'My theme', idea: 'Course notes', reference: 'Reference', insight: 'New thought', full: 'Full tools', preset: 'Clear branches', arrange: 'Auto arrange', nodeStyle: 'Node styles', edgeStyle: 'Line styles', root: 'Research topic', concept: 'Concept', case: 'Cases', weekly: 'This week', note: 'Side note', emphasis: 'Key point', reader: 'Reading view', body: 'Write and read the full note here.', selection: 'Selected 4 nodes', groupName: 'Study materials', plusGroup: '+ Group', rightDrag: 'Right-drag', solidBlock: 'Solid color block', panelTitle: 'Mind Map mode', panelPresets: 'Presets', panelLayout: 'Layout', panelFollow: 'Follow branch' }
      : { core: '核心想法', clue: '关键线索', expand: '继续展开', define: '定义', example: '例题', summary: '总结', canvas: '画布', mindmap: '导图', shapes: '图案', structure: '思考结构', mine: '我的主题', idea: '课程笔记', reference: '参考资料', insight: '补充想法', full: '完整工具', preset: '清晰分支', arrange: '自动排版', nodeStyle: '节点样式', edgeStyle: '连线样式', root: '研究主题', concept: '概念', case: '案例', weekly: '本周重点', note: '旁注', emphasis: '重点', reader: '放大阅读', body: '在这里阅读和编辑完整正文。', selection: '已选中 4 个节点', groupName: '学习资料', plusGroup: '+ 分组', rightDrag: '右键拖动', solidBlock: '纯色色块', panelTitle: '思维导图模式', panelPresets: '预设', panelLayout: '排版', panelFollow: '跟随分支' };
    if (scene === 'create') return '<div class="ob-scene ob-create"><div class="ob-grid"></div><div class="ob-click-ring"></div><div class="ob-demo-cursor"></div><div class="ob-demo-node ob-created-card"><b></b><i></i><i></i><span></span></div><div class="ob-demo-sticky"><i></i><i></i></div></div>';
    if (scene === 'connect') return '<div class="ob-scene ob-connect"><div class="ob-grid"></div><svg viewBox="0 0 520 300" aria-hidden="true"><path class="ob-edge ob-edge-a" d="M160 146 C220 146 244 92 340 92"/><path class="ob-edge ob-edge-b" d="M160 146 C222 146 250 218 356 218"/></svg><div class="ob-demo-node ob-connect-main"><b>' + labels.core + '</b><i></i></div><div class="ob-demo-node ob-connect-child"><b>' + labels.clue + '</b></div><div class="ob-demo-node ob-connect-peer"><b>' + labels.expand + '</b></div><kbd class="ob-alt-key">Alt</kbd><div class="ob-demo-cursor"></div></div>';
    if (scene === 'navigate') return '<div class="ob-scene ob-navigate"><div class="ob-grid"></div><div class="ob-pan-world"><svg viewBox="0 0 520 300" aria-hidden="true"><path d="M154 132 C220 132 236 86 302 86"/><path d="M154 132 C226 132 250 210 330 210"/></svg><div class="ob-demo-node ob-pan-a"><b>' + labels.define + '</b></div><div class="ob-demo-node ob-pan-b"><b>' + labels.example + '</b></div><div class="ob-demo-node ob-pan-c"><b>' + labels.summary + '</b></div></div><kbd class="ob-space-key">Space</kbd><div class="ob-pan-cursor"></div><div class="ob-zoom-readout">100%</div></div>';
    if (scene === 'canvas-mode') return '<div class="ob-scene ob-canvas-mode"><div class="ob-grid"></div><div class="ob-scene-badge"><b>' + labels.canvas + '</b><span>' + labels.full + '</span></div><svg viewBox="0 0 520 300" aria-hidden="true"><path class="ob-canvas-edge" d="M153 180 C226 180 263 102 341 102"/></svg><div class="ob-demo-node ob-canvas-a"><b>' + labels.idea + '</b><i></i></div><div class="ob-demo-node ob-canvas-b"><b>' + labels.reference + '</b><i></i></div><div class="ob-demo-sticky ob-canvas-note"><b>' + labels.insight + '</b><i></i></div><div class="ob-canvas-context"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><span class="ob-canvas-click"></span><span class="ob-canvas-right-click"></span><div class="ob-demo-cursor ob-canvas-cursor"></div></div>';
    if (scene === 'mindmap-mode') return '<div class="ob-scene ob-mindmap-mode"><div class="ob-grid"></div><div class="ob-scene-badge"><b>' + labels.mindmap + '</b><span>' + labels.preset + '</span></div><svg class="ob-mm-lines-before" viewBox="0 0 520 300" aria-hidden="true"><path d="M276 89 C217 94 191 214 116 219"/><path d="M276 89 C342 98 341 123 413 126"/><path d="M116 219 C201 223 277 80 342 80"/><path d="M413 126 C351 137 264 210 195 220"/></svg><svg class="ob-mm-lines-after" viewBox="0 0 520 300" aria-hidden="true"><path class="ob-mm-edge-a" d="M120 146 C174 146 178 80 240 80"/><path class="ob-mm-edge-b" d="M120 146 C174 146 178 220 240 220"/><path class="ob-mm-edge-c" d="M280 80 C338 80 352 47 420 47"/><path class="ob-mm-edge-d" d="M280 220 C338 220 352 253 420 253"/></svg><div class="ob-mm-node ob-mm-root"><b>' + labels.root + '</b></div><div class="ob-mm-node ob-mm-branch-a"><b>' + labels.concept + '</b></div><div class="ob-mm-node ob-mm-child-a"><b>' + labels.define + '</b></div><div class="ob-mm-node ob-mm-branch-b"><b>' + labels.case + '</b></div><div class="ob-mm-node ob-mm-child-b"><b>' + labels.example + '</b></div><div class="ob-mm-panel"><small>' + labels.preset + '</small><div class="ob-mm-preset"><i></i><i></i><i></i><span>✓</span></div></div><div class="ob-mm-result-tags"><span>' + labels.arrange + '</span><span>' + labels.nodeStyle + '</span><span>' + labels.edgeStyle + '</span></div><div class="ob-demo-cursor ob-mm-cursor"></div><span class="ob-mm-click"></span></div>';
    if (scene === 'decor-mode') return '<div class="ob-scene ob-decor-mode"><div class="ob-grid"></div><div class="ob-scene-badge"><b>' + labels.shapes + '</b><span>' + labels.weekly + '</span></div><svg viewBox="0 0 520 300" aria-hidden="true"><path d="M163 153 C218 153 235 114 288 114"/></svg><div class="ob-decor-color-block"></div><div class="ob-decor-selection"></div><div class="ob-decor-group-box"><b>' + labels.weekly + '</b></div><div class="ob-demo-node ob-decor-a"><b>' + labels.idea + '</b><i></i></div><div class="ob-demo-node ob-decor-b"><b>' + labels.reference + '</b><i></i></div><div class="ob-demo-sticky ob-decor-note"><b>' + labels.emphasis + '</b><i></i></div><div class="ob-decor-textbox"><b>' + labels.note + '</b><i></i><i></i></div><div class="ob-demo-cursor ob-decor-cursor"></div></div>';
    if (scene === 'panel-control') return '<div class="ob-scene ob-panel-control"><div class="ob-grid"></div><div class="ob-panel-canvas-copy"><i></i><i></i><i></i></div><kbd class="ob-panel-tab">Tab</kbd><aside class="ob-panel-shell"><header><b>' + labels.panelTitle + '</b><span class="ob-panel-flashlight"><svg viewBox="0 0 24 24" aria-hidden="true"><g class="ob-panel-beam"><line x1="12" y1="2" x2="12" y2=".8"/><line x1="8.2" y1="2.4" x2="7.2" y2="1.1"/><line x1="15.8" y1="2.4" x2="16.8" y2="1.1"/></g><path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12v4Z"/><line x1="6" y1="6" x2="18" y2="6"/></svg></span></header><div class="ob-panel-content"><small>' + labels.panelPresets + '</small><div class="ob-panel-presets"><i></i><i></i><i></i><i></i></div><small>' + labels.panelLayout + '</small><div class="ob-panel-rule"></div><div class="ob-panel-action">' + labels.panelFollow + '</div><div class="ob-panel-lines"><i></i><i></i></div></div></aside><div class="ob-demo-cursor ob-panel-cursor"></div><span class="ob-panel-click"></span></div>';
    if (scene === 'color-block') return '<div class="ob-scene ob-color-block"><div class="ob-grid"></div><div class="ob-scene-badge"><b>' + labels.shapes + '</b><span>' + labels.rightDrag + '</span></div><div class="ob-color-draft"></div><div class="ob-color-shape"><b>' + labels.solidBlock + '</b><span></span><span></span><span></span><span></span></div><div class="ob-right-mouse"><i></i><b>' + labels.rightDrag + '</b></div><div class="ob-demo-cursor ob-color-cursor"></div><span class="ob-color-origin"></span><div class="ob-color-chips"><i></i><i></i><i></i></div></div>';
    if (scene === 'reader') return '<div class="ob-scene ob-reader"><div class="ob-grid"></div><div class="ob-reader-dim"></div><div class="ob-demo-node ob-reader-node"><b>' + labels.idea + '</b><i></i><span></span></div><kbd class="ob-reader-key">F</kbd><div class="ob-reader-shell"><header><small>' + labels.reader + '</small><b>' + labels.idea + '</b><span>×</span></header><div class="ob-reader-tools"><i></i><i></i><i></i><i></i><em>100%</em></div><div class="ob-reader-body"><strong>' + labels.body + '</strong><i></i><i></i><i></i></div><footer><kbd>F</kbd><span>/</span><kbd>Esc</kbd></footer></div><div class="ob-demo-cursor ob-reader-cursor"></div><span class="ob-reader-click"></span></div>';
    if (scene === 'group') return '<div class="ob-scene ob-group"><div class="ob-grid"></div><div class="ob-group-box"><b>' + labels.groupName + '</b><span>− 4</span></div><div class="ob-group-selection"></div><div class="ob-demo-node ob-group-a"><b>' + labels.idea + '</b></div><div class="ob-demo-node ob-group-b"><b>' + labels.reference + '</b></div><div class="ob-demo-node ob-group-c"><b>' + labels.insight + '</b></div><div class="ob-demo-node ob-group-d"><b>' + labels.summary + '</b></div><div class="ob-group-action">' + labels.plusGroup + '</div><small class="ob-group-status">' + labels.selection + '</small><div class="ob-demo-cursor ob-group-cursor"></div><span class="ob-group-click"></span></div>';
    return '<div class="ob-scene ob-begin"><div class="ob-grid"></div><svg viewBox="0 0 520 300" aria-hidden="true"><path d="M236 142 C176 142 166 86 120 86"/><path d="M236 142 C302 142 318 90 420 90"/><path d="M236 142 C300 142 326 218 440 218"/></svg><div class="ob-final-group"><b>' + labels.structure + '</b></div><div class="ob-demo-node ob-final-center"><b>' + labels.mine + '</b></div><div class="ob-demo-node ob-final-a"><b>' + labels.define + '</b></div><div class="ob-demo-node ob-final-b"><b>' + labels.example + '</b></div><div class="ob-demo-sticky ob-final-note"><i></i><i></i></div><span class="ob-final-pulse"></span></div>';
  }

  function createOverlay() {
    const el = document.createElement('div');
    el.className = 'editor-onboarding';
    el.hidden = true;
    el.innerHTML = '<button type="button" class="editor-onboarding-backdrop" data-ob="close" tabindex="-1"></button>'
      + '<section class="editor-onboarding-panel" role="dialog" aria-modal="true" aria-labelledby="editor-onboarding-title">'
      + '<header class="editor-onboarding-head"><div><p data-ob-copy="eyebrow"></p><h2 id="editor-onboarding-title" data-ob-copy="title"></h2></div>'
      + '<button type="button" class="editor-onboarding-close" data-ob="close" aria-label=""></button></header>'
      + '<div class="editor-onboarding-body"><div class="editor-onboarding-stage"><div class="editor-onboarding-scene" data-ob="scene"></div>'
      + '<button type="button" class="editor-onboarding-replay" data-ob="replay"><span aria-hidden="true">↻</span><em></em></button></div>'
      + '<article class="editor-onboarding-copy" data-ob="copy"><p class="editor-onboarding-kicker" data-ob="kicker"></p><h3 data-ob="page-title"></h3>'
      + '<p class="editor-onboarding-description" data-ob="body"></p><p class="editor-onboarding-note" data-ob="note"></p></article></div>'
      + '<footer class="editor-onboarding-foot"><button type="button" class="editor-onboarding-skip" data-ob="skip"></button>'
      + '<div class="editor-onboarding-progress" data-ob="progress" aria-label="Tutorial progress"></div>'
      + '<div class="editor-onboarding-actions"><span data-ob="position"></span><button type="button" class="editor-onboarding-back" data-ob="previous"></button>'
      + '<button type="button" class="editor-onboarding-next" data-ob="next"><span></span><i aria-hidden="true">→</i></button></div></footer></section>';
    document.body.appendChild(el);
    el.addEventListener('click', onOverlayClick);
    el.addEventListener('keydown', trapFocus);
    overlay = el;
    renderLanguage();
    renderPage(false);
  }

  function renderLanguage() {
    if (!overlay) return;
    const c = copy();
    overlay.querySelector('[data-ob-copy="eyebrow"]').textContent = c.eyebrow;
    overlay.querySelector('[data-ob-copy="title"]').textContent = c.title;
    overlay.querySelector('[data-ob="skip"]').textContent = c.skip;
    overlay.querySelector('[data-ob="previous"]').textContent = c.previous;
    overlay.querySelector('[data-ob="replay"] em').textContent = c.replay;
    overlay.querySelectorAll('[data-ob="close"]').forEach(function (button) { button.setAttribute('aria-label', c.close); });
    if (replayButton) replayButton.textContent = c.replayEntry;
  }

  function renderPage(animate, direction) {
    if (!overlay) return;
    const c = copy();
    const page = c.pages[pageIndex];
    const copyEl = overlay.querySelector('[data-ob="copy"]');
    const sceneEl = overlay.querySelector('[data-ob="scene"]');
    const apply = function () {
      overlay.querySelector('[data-ob="kicker"]').textContent = page.kicker;
      overlay.querySelector('[data-ob="page-title"]').textContent = page.title;
      overlay.querySelector('[data-ob="body"]').textContent = page.body;
      overlay.querySelector('[data-ob="note"]').textContent = page.note;
      overlay.querySelector('[data-ob="position"]').textContent = c.position(pageIndex, c.pages.length);
      const next = overlay.querySelector('[data-ob="next"] span');
      next.textContent = page.action || c.next;
      overlay.querySelector('[data-ob="previous"]').disabled = pageIndex === 0;
      overlay.querySelector('[data-ob="next"]').classList.toggle('is-final', pageIndex === c.pages.length - 1);
      sceneEl.innerHTML = sceneMarkup(page.scene);
      buildProgress();
      playScene();
    };
    if (!animate || reduceMotion || !copyEl.animate) { apply(); return; }
    flipping = true;
    const outX = direction > 0 ? -28 : 28;
    Promise.all([copyEl, sceneEl].map((node, index) => node.animate([
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      { opacity: 0, transform: 'translate3d(' + outX + 'px,0,0) scale(' + (index ? '.985' : '1') + ')' },
    ], { duration: 140, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished.catch(function () {}))).then(function () {
      apply();
      const inX = -outX;
      return Promise.all([copyEl, sceneEl].map((node, index) => node.animate([
        { opacity: 0, transform: 'translate3d(' + inX + 'px,0,0) scale(' + (index ? '.985' : '1') + ')' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      ], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' }).finished.catch(function () {})));
    }).then(function () { flipping = false; });
  }

  function buildProgress() {
    const host = overlay.querySelector('[data-ob="progress"]');
    const pages = copy().pages;
    host.innerHTML = pages.map(function (_, index) {
      return '<button type="button" data-ob-page="' + index + '" class="' + (index === pageIndex ? 'active' : '')
        + '" aria-label="' + (index + 1) + '"><span></span></button>';
    }).join('');
  }

  function playScene() {
    const scene = overlay && overlay.querySelector('.ob-scene');
    if (!scene || reduceMotion) return;
    scene.classList.remove('is-playing');
    void scene.offsetWidth;
    scene.classList.add('is-playing');
  }

  function gotoPage(next) {
    if (flipping || !overlay) return;
    const total = copy().pages.length;
    const target = Math.max(0, Math.min(total - 1, next));
    if (target === pageIndex) return;
    const direction = target > pageIndex ? 1 : -1;
    pageIndex = target;
    renderPage(true, direction);
  }

  function setCanvasSuspended(suspended) {
    if (window.CanvasModule && typeof window.CanvasModule.setExternalOverlayOpen === 'function') {
      try { window.CanvasModule.setExternalOverlayOpen(!!suspended); } catch (e) {}
    }
  }

  function openGuide(options) {
    options = options || {};
    if (!overlay) createOverlay();
    stopPractice(false);
    const shortcutsClose = document.querySelector('[data-role="shortcuts-close"]');
    if (shortcutsClose && shortcutsClose.offsetParent) shortcutsClose.click();
    pageIndex = Number.isFinite(options.page) ? options.page : 0;
    renderLanguage();
    renderPage(false);
    restoreFocus = document.activeElement;
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('editor-onboarding-open');
    setCanvasSuspended(true);
    requestAnimationFrame(function () {
      overlay.classList.add('open');
      const close = overlay.querySelector('.editor-onboarding-close');
      if (close) close.focus({ preventScroll: true });
    });
  }

  function closeGuide(state, startPractice) {
    if (!overlay || overlay.hidden) return;
    if (state) {
      try { localStorage.setItem(STORAGE_KEY, state); } catch (e) {}
    }
    overlay.classList.remove('open');
    document.body.classList.remove('editor-onboarding-open');
    window.setTimeout(function () {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
      setCanvasSuspended(false);
      if (startPractice) beginPractice();
      else if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
    }, reduceMotion ? 0 : 230);
  }

  function onOverlayClick(event) {
    const action = event.target.closest('[data-ob]');
    const page = event.target.closest('[data-ob-page]');
    if (page) { gotoPage(Number(page.dataset.obPage)); return; }
    if (!action) return;
    const name = action.dataset.ob;
    if (name === 'close' || name === 'skip') closeGuide('skipped', false);
    else if (name === 'previous') gotoPage(pageIndex - 1);
    else if (name === 'next') {
      if (pageIndex === copy().pages.length - 1) closeGuide('in-progress', true);
      else gotoPage(pageIndex + 1);
    } else if (name === 'replay') playScene();
  }

  function trapFocus(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeGuide('skipped', false); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); gotoPage(pageIndex - 1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); gotoPage(pageIndex + 1); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(overlay.querySelectorAll('button:not([disabled])')).filter(function (el) { return el.offsetParent !== null; });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function canvasSnapshot() {
    if (!window.CanvasModule || typeof window.CanvasModule.describeCanvas !== 'function') return { nodes: [], edges: [] };
    try { return window.CanvasModule.describeCanvas({ maxNodes: 999, excerptLen: 2048 }); } catch (e) { return { nodes: [], edges: [] }; }
  }

  function practiceNodeTextKey(node) {
    return String(node && node.title || '').trim() + '\u241e' + String(node && node.excerpt || '').trim();
  }

  function beginPractice() {
    const c = copy();
    const snap = canvasSnapshot();
    const el = document.createElement('div');
    el.className = 'editor-practice';
    el.innerHTML = '<div class="editor-practice-target" aria-hidden="true"></div><aside class="editor-practice-card" role="status">'
      + '<header><span data-practice="label"></span><b data-practice="count"></b><button type="button" data-practice="close" aria-label="' + c.cancelPractice + '">×</button></header>'
      + '<h3 data-practice="title"></h3><p data-practice="body"></p><div class="editor-practice-progress"><i></i><i></i><i></i><i></i></div>'
      + '<footer class="editor-practice-done-actions" hidden><button type="button" data-practice="modes"></button><button type="button" data-practice="done"></button></footer></aside>';
    document.body.appendChild(el);
    practice = {
      el: el,
      step: 0,
      baseNodeIds: new Set(snap.nodes.map(function (node) { return String(node.id); })),
      baseNodeText: new Map(snap.nodes.map(function (node) { return [String(node.id), practiceNodeTextKey(node)]; })),
      baseEdgeKeys: new Set(snap.edges.map(practiceEdgeKey)),
      firstNodeId: '',
      secondNodeId: '',
      observer: null,
      timer: 0,
    };
    el.addEventListener('click', onPracticeClick);
    const surface = document.querySelector('[data-role="canvas-surface"]');
    if (surface && window.MutationObserver) {
      practice.observer = new MutationObserver(schedulePracticeEvaluation);
      practice.observer.observe(surface, { childList: true, subtree: true });
    }
    document.addEventListener('canvas:mutated', schedulePracticeEvaluation);
    window.addEventListener('resize', positionPracticeTarget);
    renderPractice();
    requestAnimationFrame(function () { if (practice) practice.el.classList.add('show'); });
  }

  function schedulePracticeEvaluation() {
    if (!practice || practice.timer) return;
    practice.timer = window.setTimeout(function () {
      if (!practice) return;
      practice.timer = 0;
      evaluatePractice();
    }, 60);
  }

  function evaluatePractice() {
    if (!practice || practice.step >= 4) return;
    const snap = canvasSnapshot();
    const newNodes = snap.nodes.filter(function (node) { return !practice.baseNodeIds.has(String(node.id)); });
    if (practice.step === 0 && newNodes.length) {
      practice.firstNodeId = String(newNodes[0].id);
      practice.step = 1;
      renderPractice();
      schedulePracticeEvaluation();
      return;
    } else if (practice.step === 1) {
      const writtenNode = snap.nodes.find(function (node) {
        const id = String(node && node.id || '');
        const title = String(node && node.title || '').trim();
        const excerpt = String(node && node.excerpt || '').trim();
        const newNodeHasText = !practice.baseNodeIds.has(id)
          && (!!excerpt || (!!title && !/^Untitled$/i.test(title)));
        const existingNodeChanged = practice.baseNodeText.has(id)
          && practice.baseNodeText.get(id) !== practiceNodeTextKey(node);
        return newNodeHasText || existingNodeChanged;
      });
      if (!writtenNode) return;
      practice.step = 2;
      renderPractice();
      schedulePracticeEvaluation();
      return;
    } else if (practice.step === 2) {
      const secondNode = newNodes.find(function (node) { return String(node.id) !== practice.firstNodeId; });
      if (!secondNode) return;
      practice.secondNodeId = String(secondNode.id);
      practice.step = 3;
      renderPractice();
      schedulePracticeEvaluation();
      return;
    } else if (practice.step === 3) {
      const connected = snap.edges.some(function (edge) { return !practice.baseEdgeKeys.has(practiceEdgeKey(edge)); });
      if (connected) completePractice();
    }
    positionPracticeTarget();
  }

  function practiceEdgeKey(edge) {
    return String(edge && edge.from || '') + '→' + String(edge && edge.to || '');
  }

  function renderPractice() {
    if (!practice) return;
    const c = copy();
    const step = Math.min(practice.step, 3);
    const item = c.practice[step];
    practice.el.querySelector('[data-practice="label"]').textContent = c.practiceLabel;
    practice.el.querySelector('[data-practice="count"]').textContent = (step + 1) + ' / 4';
    practice.el.querySelector('[data-practice="title"]').textContent = item[0];
    practice.el.querySelector('[data-practice="body"]').textContent = item[1];
    practice.el.querySelectorAll('.editor-practice-progress i').forEach(function (dot, index) {
      dot.classList.toggle('active', index === step);
      dot.classList.toggle('done', index < step);
    });
    practice.el.dataset.step = String(step);
    positionPracticeTarget();
  }

  function positionPracticeTarget() {
    if (!practice) return;
    const target = practice.el.querySelector('.editor-practice-target');
    const viewport = document.querySelector('[data-role="canvas-viewport"]') || document.querySelector('.canvas-viewport');
    const vr = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const nodes = Array.from(document.querySelectorAll('.canvas-surface .node'));
    const nodeRects = nodes.map(function (node) { return node.getBoundingClientRect(); });
    const findElement = function (id) {
      return id ? nodes.find(function (node) { return String(node.dataset.id || '') === String(id); }) : null;
    };
    const rightEdge = vr.right || (vr.left + vr.width);
    const bottomEdge = vr.bottom || (vr.top + vr.height);
    const clearPoint = function (candidates, boxWidth, boxHeight) {
      const halfW = boxWidth / 2;
      const halfH = boxHeight / 2;
      let fallback = candidates[0];
      for (let i = 0; i < candidates.length; i++) {
        const px = Math.max(vr.left + halfW + 18, Math.min(rightEdge - halfW - 18, candidates[i][0]));
        const py = Math.max(vr.top + halfH + 18, Math.min(bottomEdge - halfH - 150, candidates[i][1]));
        if (i === 0) fallback = [px, py];
        const occupied = nodeRects.some(function (rect) {
          return px + halfW + 22 > rect.left && px - halfW - 22 < rect.right
            && py + halfH + 18 > rect.top && py - halfH - 18 < rect.bottom;
        });
        if (!occupied) return [px, py];
      }
      return fallback;
    };
    const first = findElement(practice.firstNodeId);
    const second = findElement(practice.secondNodeId);
    const centerX = vr.left + vr.width * .5;
    const centerY = vr.top + vr.height * .48;
    const initialPoint = clearPoint([
      [centerX, centerY], [centerX + 220, centerY], [centerX - 220, centerY],
      [centerX, centerY - 145], [centerX + 220, centerY - 145], [centerX - 220, centerY - 145],
      [centerX + 320, centerY + 120], [centerX - 320, centerY + 120],
    ], 92, 68);
    let x = initialPoint[0];
    let y = initialPoint[1];
    let width = 92;
    let height = 68;
    if (practice.step === 1 && first) {
      const rect = first.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
      width = rect.width + 28;
      height = rect.height + 24;
    } else if (practice.step === 2 && first) {
      const rect = first.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const emptyPoint = clearPoint([
        [rect.right + 125, centerY], [rect.left - 125, centerY],
        [rect.left + rect.width / 2, rect.bottom + 105], [rect.left + rect.width / 2, rect.top - 105],
      ], 92, 68);
      x = emptyPoint[0];
      y = emptyPoint[1];
    } else if (practice.step >= 3 && first && second) {
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      const right = Math.max(a.right, b.right);
      const bottom = Math.max(a.bottom, b.bottom);
      x = (left + right) / 2;
      y = (top + bottom) / 2;
      width = right - left + 34;
      height = bottom - top + 30;
    }
    target.style.setProperty('--practice-x', x + 'px');
    target.style.setProperty('--practice-y', y + 'px');
    target.style.setProperty('--practice-w', width + 'px');
    target.style.setProperty('--practice-h', height + 'px');
  }

  function completePractice() {
    if (!practice) return;
    const c = copy();
    practice.step = 4;
    practice.el.classList.add('complete');
    practice.el.querySelector('[data-practice="count"]').textContent = '4 / 4';
    practice.el.querySelector('[data-practice="title"]').textContent = c.doneTitle;
    practice.el.querySelector('[data-practice="body"]').textContent = c.doneBody;
    practice.el.querySelector('[data-practice="modes"]').textContent = c.showModes;
    practice.el.querySelector('[data-practice="done"]').textContent = c.done;
    practice.el.querySelector('.editor-practice-done-actions').hidden = false;
    practice.el.querySelectorAll('.editor-practice-progress i').forEach(function (dot) { dot.classList.add('done'); dot.classList.remove('active'); });
    try { localStorage.setItem(STORAGE_KEY, 'completed'); } catch (e) {}
  }

  function onPracticeClick(event) {
    const action = event.target.closest('[data-practice]');
    if (!action) return;
    if (action.dataset.practice === 'close') stopPractice(true);
    else if (action.dataset.practice === 'done') {
      stopPractice(false);
      highlightHelpButton();
    }
    else if (action.dataset.practice === 'modes') {
      stopPractice(false);
      const modes = document.querySelector('[data-role="mode-switch"]');
      if (modes) {
        modes.classList.remove('onboarding-attention');
        void modes.offsetWidth;
        modes.classList.add('onboarding-attention');
        window.setTimeout(function () { modes.classList.remove('onboarding-attention'); }, 3200);
      }
    }
  }

  function highlightHelpButton() {
    const help = document.querySelector('[data-role="help-btn"]');
    if (!help) return;
    help.classList.remove('onboarding-attention');
    void help.offsetWidth;
    help.classList.add('onboarding-attention');
    const clear = function () { help.classList.remove('onboarding-attention'); };
    help.addEventListener('animationend', clear, { once: true });
    window.setTimeout(clear, reduceMotion ? 1100 : 3400);
  }

  function stopPractice(markSkipped) {
    if (!practice) return;
    if (markSkipped) {
      try { localStorage.setItem(STORAGE_KEY, 'skipped'); } catch (e) {}
    }
    const current = practice;
    practice = null;
    if (current.timer) window.clearTimeout(current.timer);
    if (current.observer) current.observer.disconnect();
    document.removeEventListener('canvas:mutated', schedulePracticeEvaluation);
    window.removeEventListener('resize', positionPracticeTarget);
    current.el.classList.remove('show');
    window.setTimeout(function () { current.el.remove(); }, reduceMotion ? 0 : 220);
  }

  document.addEventListener('editor:ready', function (event) {
    readyState = event.detail || {};
    if (!readyState.fresh || readyState.embed) return;
    let state = '';
    let initialLanguage = '';
    let savedLanguage = '';
    try {
      state = localStorage.getItem(STORAGE_KEY) || '';
      initialLanguage = localStorage.getItem(INITIAL_LANGUAGE_STORAGE_KEY) || '';
      savedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY) || '';
    } catch (e) {}
    if (state) return;
    if (!initialLanguage && savedLanguage) persistInitialLanguage(savedLanguage === 'en' ? 'en' : 'zh-CN');
    window.setTimeout(function () {
      if (!initialLanguage && !savedLanguage) openLanguagePicker();
      else openGuide({ page: 0 });
    }, reduceMotion ? 180 : 620);
  });

  document.addEventListener('relatum:languagechange', function () {
    renderReplayEntry();
    if (overlay && !overlay.hidden) { renderLanguage(); renderPage(false); }
    if (practice) renderPractice();
  });
  document.addEventListener('editor:languagechange', function () {
    renderReplayEntry();
    if (overlay && !overlay.hidden) { renderLanguage(); renderPage(false); }
    if (practice) renderPractice();
  });

  renderReplayEntry();
  if (replayButton) replayButton.addEventListener('click', function (event) {
    event.preventDefault();
    window.setTimeout(function () { openGuide({ page: 0 }); }, 80);
  });

  window.RelatumEditorOnboarding = { open: openGuide, stopPractice: stopPractice };
})();

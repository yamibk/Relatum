const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const editor = fs.readFileSync(path.join(root, 'assets', 'editor.html'), 'utf8');
const ai = fs.readFileSync(path.join(root, 'assets', 'ai.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const canvas = fs.readFileSync(path.join(root, 'assets', 'canvas.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
const packaging = fs.readFileSync(path.join(root, 'build-desktop.ps1'), 'utf8');
const externalGuide = fs.readFileSync(path.join(root, 'AI笔记创作指南.md'), 'utf8');
const planHelpers = require(path.join(root, 'assets', 'ai-canvas-plan.js'));
const chatHandler = backend.slice(
  backend.indexOf('    def _api_ai_chat('),
  backend.indexOf('    def _api_ai_test('),
);

const actions = Array.from(editor.matchAll(/data-ai-action="([^"]+)"/g), (match) => match[1]);
assert.deepStrictEqual(actions, [
  'chat',
  'create_graph',
  'create_mindmap',
  'extend_branch',
  'supplement',
  'refine',
], 'AI 面板必须固定展示六种 V2 操作');
assert(!editor.includes('data-role="ai-run-action"'),
  '聊天发送与画布预览不得保留两个并列提交按钮');
assert.strictEqual((editor.match(/data-role="ai-send"/g) || []).length, 1,
  '输入区必须只保留一个随操作切换的主按钮');
assert(editor.includes('data-role="ai-submit-icon"')
  && editor.includes('data-role="ai-submit-label"'),
  '统一主按钮必须能在发送箭头与生成预览文字之间切换');
[
  "sendBtn.classList.toggle('ai-send-preview', !chatMode);",
  "submitIcon.toggleAttribute('hidden', !chatMode);",
  "submitLabel.hidden = chatMode;",
  "submitLabel.textContent = ui('生成预览', 'Generate preview');",
  "if (selectedAction === 'chat') send();",
  'else onRunAction();',
].forEach((needle) => {
  assert(ai.includes(needle), '统一主按钮缺少模式联动：' + needle);
});
assert(ai.includes('submitSelectedAction();')
  && ai.includes('Enter 执行当前操作，Shift+Enter 换行'),
  'Enter 必须跟随当前所选操作，Shift+Enter 仍用于换行');
assert(styles.includes('.ai-send.ai-send-preview'),
  '统一主按钮必须为“生成预览”文字态提供自适应宽度');

assert(editor.includes('data-role="ai-resize-handle"')
  && editor.includes('role="separator"')
  && editor.includes('aria-orientation="vertical"'),
  'AI 工作台必须提供可访问的纵向调宽轨道');
assert(editor.includes('data-role="ai-workspace"')
  && editor.includes('data-role="ai-conversation"'),
  '设置/帮助必须位于独立工作区，不能继续向下挤压整张侧栏');
assert(editor.includes('class="ai-compose-box"') && /class="ai-input"[^>]+rows="3"/.test(editor),
  '底部编辑器必须使用统一卡片，并默认提供三行输入空间');
[
  "const PANEL_WIDTH_KEY = 'canvas:ai-panel-width:v1';",
  'const PANEL_DEFAULT_WIDTH = 520;',
  'const PANEL_MIN_WIDTH = 440;',
  'const PANEL_MAX_WIDTH = 820;',
  'const PANEL_MAX_VIEWPORT_RATIO = 0.72;',
  'const PANEL_NARROW_BREAKPOINT = 640;',
  'window.requestAnimationFrame(runPanelResizeFrame)',
  'resizeHandle.setPointerCapture(event.pointerId)',
  "if (event.key === 'ArrowLeft') next = current + step;",
  "if (event.key === 'ArrowRight') next = current - step;",
  "resizeHandle.addEventListener('dblclick', resetPanelWidth);",
  'window.localStorage.setItem(PANEL_WIDTH_KEY',
  "panel.style.setProperty('--ai-panel-width', next + 'px');",
].forEach((needle) => {
  assert(ai.includes(needle), 'AI 面板调宽交互缺少契约：' + needle);
});
assert(ai.includes("conversation.toggleAttribute('inert', sheetOpen)"),
  '设置/帮助覆盖工作区时必须阻止焦点落到被遮住的对话区');
assert(ai.includes('Math.min(INPUT_MAX_HEIGHT, window.innerHeight * 0.28)'),
  '输入框自动增高必须同时尊重 240px 和视口比例上限');
assert(ai.includes("input.classList.toggle('ai-input-scrollable', scrollable)"),
  '输入框只有达到高度上限后才能进入内部滚动状态');
assert(ai.includes("element.classList.add('ai-scroll-active')"),
  '自定义滚动条必须在真实滚动时短暂显现');
assert(ai.includes("rail.className = 'ai-scroll-indicator'")
  && ai.includes('startScrollbarDrag(event, element)')
  && ai.includes('state.element.scrollTop = (next / indicator.travel) * indicator.maxScroll;'),
  'WebView2 原生轨道必须由可拖动的独立细滑块替代');

assert(/\.ai-panel\s*\{[\s\S]*?top:\s*12px;[\s\S]*?right:\s*12px;[\s\S]*?bottom:\s*12px;/.test(styles),
  '桌面 AI 工作台必须保留 12px 悬浮边距');
assert(/\.ai-panel\s*\{[\s\S]*?border-radius:\s*24px;/.test(styles),
  'AI 工作台必须使用 24px 外框圆角');
assert(/\.ai-action-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/.test(styles),
  '桌面六操作必须使用三列两行布局');
assert(/\.ai-input\s*\{[\s\S]*?min-height:\s*84px;[\s\S]*?max-height:\s*min\(240px,\s*28vh\);/.test(styles),
  '输入框必须默认约三行，并限制最大高度');
assert(/\.ai-preview-checklist\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/.test(styles),
  '预览清单不得再建立独立纵向滚动区');
assert(styles.includes('.ai-panel .ai-custom-scroll::-webkit-scrollbar-button')
  && /::-webkit-scrollbar-button[\s\S]*?display:\s*none;[\s\S]*?width:\s*0;[\s\S]*?height:\s*0;/.test(styles),
  'AI 自定义滚动条必须移除 WebView2/Windows 箭头按钮');
assert(styles.includes('.ai-custom-scroll.ai-scroll-active')
  && styles.includes('@media (forced-colors: active)'),
  '细滚动条必须支持自动显现与强制高对比度降级');
assert(styles.includes('.ai-scroll-indicator-thumb')
  && /\.ai-panel \.ai-custom-scroll::[\s\S]*?-webkit-scrollbar[\s\S]*?\{[\s\S]*?width:\s*0;/.test(styles),
  '普通模式必须完全隐藏 Windows 原生轨道并显示独立细滑块');
assert(/@media \(max-width:\s*640px\)[\s\S]*?\.ai-panel\s*\{[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100vw;/.test(styles),
  '≤640px 时 AI 面板必须退化为不可拖宽的全屏侧栏');

const helpPages = Array.from(editor.matchAll(/data-ai-help-page="([^"]+)"/g), (match) => match[1]);
assert.deepStrictEqual(helpPages, [
  'start',
  'actions',
  'preview',
  'trouble',
], 'AI 操作速查必须只保留四个清晰页面');
assert(!editor.includes('ai-help-spine'), '操作速查不得恢复重复的左侧圆点导航');
assert(!editor.includes('ai-help-nav-slider'), '操作速查顶栏不得恢复横向滑块或滚动导航');
assert(editor.includes('role="tablist"') && editor.includes('role="tabpanel"'),
  '操作速查目录必须暴露可访问的标签页关系');
assert(editor.includes('01 / 04'), '操作速查页码必须与四页结构一致');
assert(editor.includes('上一步') && editor.includes('下一步'), '操作速查必须使用明确的文字分页按钮');

const guideActionMatch = ai.match(/actionIds:\s*\[([^\]]+)\]/);
assert(guideActionMatch, '六个按钮页必须声明真实操作列表');
const guideActions = Array.from(guideActionMatch[1].matchAll(/'([^']+)'/g), (match) => match[1]);
assert.deepStrictEqual(guideActions, actions, '教程操作卡片必须与真实六按钮一一对应');
assert(ai.includes('data-ai-help-action="'), '教程操作卡片必须提供“使用这个”联动入口');
assert.strictEqual((ai.match(/examples:\s*\[/g) || []).length, 5,
  '除聊天外的五种画布操作都必须提供示例指令');
assert(ai.includes('data-ai-help-example="') && ai.includes('data-example-index="'),
  '教程示例必须提供可访问的带入入口，并按操作与序号读取元数据');
assert(ai.includes("layout: 'steps'") && ai.includes("layout: 'actions'"),
  '操作速查必须分别提供三步上手与六按钮布局');
assert(ai.includes('生成预览不会写入画布；只有点击“应用选中项”才会真正修改。'),
  '预览页必须明确生成与写入的安全边界');
assert(ai.includes('只新增缺失节点和连接，不改原节点文字。'),
  '补充操作必须明确不会改写原节点');
assert(ai.includes('不删除节点、不改变节点类型。'),
  '整理操作必须明确节点安全边界');
assert(ai.includes('连线移除默认不勾选。'), '预览说明必须提醒危险连线移除默认不选');

const helpActionStart = ai.indexOf('function useHelpAction(action)');
const helpActionEnd = ai.indexOf('function useHelpExample(action, index)', helpActionStart);
const helpActionHandler = ai.slice(helpActionStart, helpActionEnd);
assert(helpActionStart >= 0 && helpActionEnd > helpActionStart, '缺少教程操作联动处理器');
[
  'selectedAction = action;',
  'actionUserChosen = true;',
  'syncActionPicker();',
  'closeHelp();',
  'input.focus();',
].forEach((needle) => {
  assert(helpActionHandler.includes(needle), '教程操作联动缺少行为：' + needle);
});
assert(!helpActionHandler.includes('fillInputWithPrompt'), '“使用这个”不得自动填入示例');
assert(!helpActionHandler.includes('input.value ='), '“使用这个”不得改写当前输入');
assert(!helpActionHandler.includes('fetch('), '“使用这个”不得发送网络请求');
assert(!helpActionHandler.includes('runPlan('), '“使用这个”不得直接生成或应用计划');

const helpExampleStart = helpActionEnd;
const helpExampleEnd = ai.indexOf('// 输入或画布状态不满足动作要求时', helpExampleStart);
const helpExampleHandler = ai.slice(helpExampleStart, helpExampleEnd);
[
  'useHelpAction(action);',
  'input.value = localize(example);',
  'autoGrow();',
].forEach((needle) => {
  assert(helpExampleHandler.includes(needle), '教程示例缺少安全带入行为：' + needle);
});
assert(!helpExampleHandler.includes('fetch('), '教程示例不得自动发送网络请求');
assert(!helpExampleHandler.includes('runPlan('), '教程示例不得自动生成或应用计划');
assert(ai.includes('Math.max(0, Math.min(total - 1, index))'),
  '教程分页必须在首尾停止，不得循环跳页');
assert(ai.includes("ui('收起教程', 'Close guide')"), '最后一页必须把下一步改为收起教程');

assert(styles.includes('max-height: min(680px, 72vh);'), '教程必须获得足够的纵向阅读空间');
assert(styles.includes('grid-template-columns: repeat(4, minmax(0, 1fr));'),
  '四页目录必须固定为无横向滚动的四栏布局');
assert(styles.includes('.ai-help-action-list') && styles.includes('.ai-help-action-card'),
  '六个操作必须使用紧凑的单列卡片布局');
assert(styles.includes('.ai-help-action-examples') && styles.includes('.ai-help-example-list'),
  '后五种操作的示例指令必须有清晰、可点击的卡片底栏');
assert(styles.includes('.ai-action-option.ai-action-guided'),
  '从教程返回操作区时必须提供有限高亮反馈');
assert(styles.includes('@media (prefers-reduced-motion: reduce)'),
  '教程与联动反馈必须保留低动态降级');

assert(editor.includes('data-ai-target="selection"'), '补充与整理必须提供选区目标');
assert(editor.includes('data-ai-target="canvas"'), '补充与整理必须提供整张画布目标');
assert(!editor.includes('data-role="ai-chips"'), '旧四快捷按钮容器必须退出新版面板');
assert(!ai.includes('/api/ai-compose'), '新版面板不得再调用旧 compose 接口');
assert(!ai.includes('injectCanvas'), '新版面板不得再调用旧通用 AI 注入器');
assert(!ai.includes('chatSystemPrompt'), '聊天不得保留内置 system 提示词');
assert(!ai.includes("role: 'system'"), '聊天历史不得自动插入 system 消息');
assert(ai.includes('let history = [];'), '聊天历史必须从真正的空对话开始');
assert(ai.includes('return lastUser ? [lastUser] : [];'), '单次请求只能发送当前用户输入');
assert(ai.includes('if (overflow > 0) history.splice(0, overflow);'),
  '无 system 消息后，历史截断必须从最旧消息开始');
assert(chatHandler && !chatHandler.includes('{"role": "system"'),
  '后端聊天处理器不得自行追加 system 提示词');
assert(!canvas.includes('CanvasModule.injectCanvas'), '画布核心不得保留旧通用 AI 注入器');
assert(!backend.includes('/api/ai-compose'), '后端不得再暴露旧 compose 路由');
assert(!backend.includes('AI_COMPOSE_'), '后端不得保留旧 compose 提示词或解析器');
assert(!packaging.includes('AI*.md'), '桌面构建不得再收集外部 AI 创作指南');
assert(!packaging.includes('AI笔记创作指南'), '桌面构建不得依赖中文指南文件名');
assert(
  externalGuide.includes('不是** Relatum 内置 AI 助手的 system prompt')
    && externalGuide.includes('不参与内置 AI 助手运行或桌面打包'),
  '外部创作指南必须明确声明运行时边界',
);

[
  "fetch('/api/ai-plan'",
  'mod.describeAIContext({ scope: scope })',
  'mod.describeAIPresentation()',
  'mod.applyAIPlan(plan, {',
  'nodeIndexes: Array.from(nodeIndexes)',
  'edgeIndexes: Array.from(edgeIndexes)',
  'relayoutSelection:',
].forEach((needle) => {
  assert(ai.includes(needle), 'AI V2 面板缺少契约：' + needle);
});

assert(ai.includes("result.reason === 'preview-stale'"), '预览过期必须有明确处理');
assert(ai.includes('checkbox.disabled = true;'), '导图根节点必须在预览中锁定');
assert(ai.includes("document.addEventListener('relatum:languagechange'"), '动态预览必须响应界面语言变化');
assert(ai.includes("document.addEventListener('editor:selectionchange'"), '操作推荐必须响应选区变化');
assert(ai.includes("document.addEventListener('editor:modechange'"), '操作推荐必须响应模式变化');
assert(!ai.includes('只新增、不动你的原卡片'), '新版帮助不得保留旧版“整理只新增”错误说明');

assert(
  canvas.includes('mindmapMember: editIsMindmapNode(node)'),
  '扩展分支上下文必须报告节点是否属于导图',
);

function node(ref) {
  return { op: 'create', ref, kind: 'card', title: ref, body: '' };
}
function edge(from, to) {
  return {
    op: 'create',
    from: { kind: 'new', ref: from },
    to: { kind: 'new', ref: to },
    text: '',
  };
}

const mindmapPlan = {
  version: 2,
  action: 'create_mindmap',
  mindmap: { rootRef: 'root' },
  nodes: [node('root'), node('branch'), node('leaf')],
  edges: [edge('root', 'branch'), edge('branch', 'leaf')],
};

const removalDefaults = planHelpers.selectOperations({
  version: 2,
  action: 'refine',
  nodes: [],
  edges: [{
    op: 'remove',
    id: 'existing-edge',
    from: { kind: 'existing', id: 'a' },
    to: { kind: 'existing', id: 'b' },
  }],
}, {});
assert.strictEqual(removalDefaults.edges.length, 0, '连线移除必须默认不勾选');

const protectedRoot = planHelpers.selectOperations(mindmapPlan, {
  nodeIndexes: [1, 2],
  edgeIndexes: [0, 1],
});
assert.deepStrictEqual(
  protectedRoot.nodes.map((entry) => entry.item.ref),
  ['root', 'branch', 'leaf'],
  '即使调用方漏传，导图根也必须自动保留',
);

const cascaded = planHelpers.selectOperations(mindmapPlan, {
  nodeIndexes: [0, 2],
  edgeIndexes: [0, 1],
});
assert.deepStrictEqual(
  cascaded.nodes.map((entry) => entry.item.ref),
  ['root'],
  '取消导图父节点必须级联取消整棵子树',
);
assert.deepStrictEqual(cascaded.droppedEdgeIndexes, [0, 1]);

console.log('ai panel v2 contract passed');

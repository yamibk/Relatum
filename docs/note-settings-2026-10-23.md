# 笔记设置与语法引导

## 用户行为

右侧工具行的设置入口使用齿轮，打开应用内居中的原生 `dialog`。
左侧笔记库入口打开同一个弹窗的“文件与笔记库”。画布侧栏保留当前对象属性，
未选择对象时直接提供节点、连线、节点正文、连线标注四个默认样式分页，另可进入设置。
双击新建节点并开始首次输入时属性面板回顶；编辑已有正文或标注仍定位对应排版区域，
同类对象切换及样式更新保留用户滚动。

弹窗包含外观、编辑、文件与笔记库、侧栏、引导、AI设置、AI对话、图谱、内嵌画布、快捷键。
关闭的功能不显示分类或搜索结果。设置搜索在本地匹配分类、说明和关键词，
结果跳转并聚焦现有控件，不复制控件或偏好状态。
自制下拉保留隐藏表单字段时，结果跳转聚焦可见触发按钮。AI设置保留 `ai` ID 并使用星芒图标，
按当前对话预设、连接、生成参数和预设管理组织紧凑表单，其他分类外观保持原有规则；
下拉复用复习批量导入的共享控件，弹层仍属于当前原生 dialog，随分类/搜索/关闭清理。
紧接其后的 AI对话使用 `ai-chat` ID 与路径绘制的 AI 字母图标，填满内容区并隐藏分类恢复和
空白页脚；搜索仅按分类名称和关键词命中，不扫描对话。禁用笔记 AI 同时隐藏这两个分类，右栏仍叫 AI。
AI对话与右栏移动同一聊天 DOM，消息独立滚动、输入区固定底部；生成中直接交接和正常关闭后
返回右栏继续接收同一请求。切其他分类或搜索则停止并保留草稿；隐藏、最小化和离场不自动打开右栏。
用户隐藏 AI 侧栏页时保留该偏好并停止生成。具体交接边界见 `note-ai-sidebar-2026-10-23.md`。

设置沿用原本即时生效的保存路径；有业务偏好的分类可单独恢复默认，全部恢复需要二次确认。
恢复只操作相应本机偏好，不写 Markdown、已有画布对象或编辑历史。
普通失焦保留弹窗并停止快捷键录制，离场、隐藏、原生最小化和 pagehide 关闭。
弹窗内保留原生表单、输入法和文本撤销，Tab 循环，Escape 优先处理录制、确认和搜索。

1200×820 CSS px 是所有分类共用的常规尺寸，四周保留留白，窗口不足时缩小。720px 以下改为顶部横向分类导航。
内容单独滚动，标题及关闭入口固定；深浅主题使用独立黑白灰表面，无背景模糊。
正文、分类导航及文本框与 AI 聊天共用 6px 细圆角滚动条，横纵轨道透明、无两端三角按钮，
颜色跟随主题；样式位于 `assets/styles.css`，不增加 JS 或改变原生滚动行为。
动效只在真实交互时播放：弹窗入场 180ms、退场 140ms，分类内容 160ms、标题 140ms，
搜索结果仅首次进入时淡入，后续输入即时更新。重复激活同一分类不重播。
导航选中、单选卡、按钮悬停/按下、搜索聚焦和恢复反馈使用 120–160ms 的局部反馈；
快捷键录制改为一次反馈加静态选中状态，不沿用旧面板的无限呼吸动画。

重置确认的遮罩/卡片入场 160/180ms、退场 120ms，取消时立即 inert 并交还底层交互，
视觉退场完成才隐藏；再次打开取消旧收尾，从当前透明度/位移接续。弹窗快速反向开合同样
读取当前显示状态接续。每个表面最多一个 Web Animation，完成或取消立即清理，
没有逐帧 JS、持续合成提示、尺寸动画或新偏好。分类只动画已有当前面板，不复制表单。

窗口尺寸变化、失焦、语言切换结束进行中的动画；低动态实时生效，缺少动画 API 时直接完成。
关闭、离场、隐藏、原生最小化和销毁取消所有临时效果。输入控件的 pointerdown 捕获阶段先提交
弹窗及内容过渡的最终几何，避免滑块或颜色弹层使用动画中的坐标；正文不参与这些变换。

## 模块边界

- `assets/settings-dialog.js` / `.css`：通用弹窗框架，独立于笔记持久化与编辑器。
  `RelatumSettingsDialog.create({content,categories,language,resetAll,onOpen,onClose,onClosed,onCategoryChange,onKeyDown})`
  返回 `open({category,trigger})`、`close({restoreFocus,instant,reason})`、`setLanguage()`、`destroy()` 和 `isOpen`，
  另有 `whenContentSettled()/finishContentMotion()` 协调聊天排版及弹层几何。
  分类注册包含稳定 id、双语 label、图标、panel、搜索 keywords 和可选 reset 回调；可声明
  `layout:'fill'` 与 `searchMode:'category'`。`onClose({reason})` 在关闭开始交接，
  `onClosed({reason})` 在真正关闭后收尾，快速重开的旧回调失效。
- `assets/note-workspace.js`：装配可用分类、接入原设置读写与输入交接，核对正文、标签、
  打开序号和可见生命周期；已有表单节点只移动一次，完整与轻量外壳共用。
- `assets/note-canvas-style.js`：`initPanel(host,resetScale,{defaultsHost})` 在原 host 和
  弹窗分别创建默认样式四分页。两处独立 DOM、唯一 tab/tabpanel ID 和会话分页状态，
  共享字段定义、默认值校验、颜色工具、新建尺寸和撤销边界。选区属性留在原 host，
  重建前释放两处旧默认 DOM；默认样式编辑始终与真实选区写入分离。
- `assets/note-guide.js`：首次查看引导时才加载，`create({host,language,isCurrent,whenSettled,notify})`
  返回 `show(topic)`、`suspend()`、`destroy()`。主题切换记住各自会话滚动位置。

新资源归 `notes` 所有；Mermaid 的适配器、Worker、样式和 Pele 仍由 `notes.mermaid` 独占。
不新增后端路由、依赖或配置文件，不修改 vendor。

## 引导偏好及资源

`canvas:noteGuideTopic:v1` 仅存 `callout`、`markdown` 或 `mermaid`，默认 Callout。
缺失或无效值只在内存回退，启动不写入默认值。显式选择即时保存，纳入现有桌面偏好快照。
恢复“引导”默认值删除该键。分类、搜索和教程滚动位置不新增持久化键。

Callout 沿用 `MarkdownMini.noteBlockCatalog` 全部类型、别名、折叠和色块。
Markdown 提供常用排版与链接、图片、代码、表格示例；教程链接不导航或创建文件。
图片使用内联本地图形示意，不下载外部图片。所有复制仅写剪贴板，并保留编辑现场。
公式组合示例保持源码，不启动 MathJax。

Mermaid 覆盖流程、时序、状态、类、ER、甘特、饼图和思维导图。只在主题可见时
加载原笔记适配器，以 reading 模式渲染视口附近示例。切主题、关闭右栏、离场、隐藏、
原生最小化或 pagehide 取消任务并释放交互；共享 Worker 沿用已有宿主计数和缓存预算。
禁用 `notes.mermaid` 时仍可选教程，但只显示说明与可复制源码，不请求专属资源。

## 验证

此次扩大设置与共用 AI对话改动按用户要求未运行测试、浏览器验证或构建，也未新增测试文件。
后续人工验收应关注大小窗口滚动、图片/公式长回答跨宿主接续、关闭返回右栏、切分类停止、
快速开合、真实输入法候选、下拉定位、焦点循环与隐藏后的资源释放。下列为已有回归入口。

使用已有 `RELATUM_PLAYWRIGHT / RELATUM_PYTHON / RELATUM_EDGE_PATH`：

```powershell
node tests/note-settings-browser.js
node tests/note-settings-browser.js --motion
node tests/note-ui-browser.js
node tests/note-canvas-style-browser.js
node tests/note-graph-browser.js
node tests/note-mermaid-workspace-browser.js
node tests/note-scrollbar-browser.js
node tests/note-visibility-browser.js
node tests/note-workspace-contract.js
node tests/note-shortcuts-contract.js
node tests/note-graph-preferences-regression.js
node tests/desktop-preferences-regression.js
```

设置测试自行创建并清理临时库与服务。`--smoke` 仅验证完整首页；默认再验证仅笔记、
禁用图谱、禁用画布、禁用 Mermaid 和最小组合。截图输出到临时目录或 `RELATUM_ARTIFACT_DIR`。
`--motion` 额外在深浅/宽窄布局验证真实中间帧、快速分类反转、重复激活、连续搜索、
确认与弹窗反转、录制无循环、低动态切换、最小化、尺寸变化和动画 API 缺失回退，
记录结束后零动画、闲置零 JS RAF 及原编辑器/正文不变，报告与截图同样写入临时目录。
浏览器合成候选事件不替代 Windows WebView2 与真实微软拼音候选窗人工验收。

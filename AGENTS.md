# AGENTS.md - Relatum / 画布项目 AI 接手指南

> 最后按源码校准：2026-08-26。
> 这份文件是给后续 AI agent 的“接手地图”，不是历史任务流水账。若本文与源码冲突，以源码为准；改动功能后，要同步更新本文对应章节。

## 0. 先读这里

- 项目显示名是 **Relatum**，仓库目录仍叫“画布”。它是本地知识画布 + 学习工作台 + 桌面壳，不是 Web SaaS。
- 维护时默认用中文与用户沟通；解释要清楚、谨慎，不要假设用户知道内部实现。
- 只改当前任务真正需要的文件。用户数据目录、示例画布、已有配置不要随手改、删、格式化。
- 手动编辑文件时使用 `apply_patch`。运行格式化、检查、构建可以用命令，但不要用脚本偷偷重写源文件。
- 这个项目没有 npm 构建链。前端是原生 HTML/CSS/JS，后端主体是 Python 标准库；桌面包才依赖 pywebview / PyInstaller / Pillow。
- 不要把这份文档继续堆成杂乱备忘录。新增功能时，把“真实行为、数据位置、入口文件、验证方式”补到对应章节。

## 1. 项目一句话

Relatum 是一个离线优先的本地学习与知识组织工具：

- `editor.html` + `assets/canvas.js` 提供无限画布、卡片/索引/代码/便签/附件、手写、连线、模板、导图和受控 AI 计划执行等核心编辑能力。
- `index.html` + 多个页面模块提供最近画布、分组、收藏、回收站、学习任务、活跃星图、速记墙、日历日记、复习池、专注钟和每日任务。
- `app.py` 是本地 HTTP 服务和所有持久化逻辑，监听 `127.0.0.1`，默认端口 `8765`，自动寻找空闲端口。
- `desktop.py` 是 pywebview / WebView2 桌面外壳，启动同一个本地服务并打开桌面窗口。

## 2. 绝对边界

### 用户数据优先

- `canvases/`、`canvases/回收站/`、`data/` 是用户数据。除非任务明确要求，不要批量改写。
- `/api/new` 的默认文件名固定为 `Untitled-YYYY-MM-DD[-N].canvas`，与界面语言无关；不要改回中文前缀，也不要自动重命名旧画布。
- 删除画布应走回收站逻辑：画布文件和同名 `.assets` 目录一起移动。
- 保存 JSON / 文本时沿用后端已有的原子写入：在目标同目录写短名、进程/线程唯一的临时文件，再 `os.replace`；不要改回固定 `.tmp`，也不要给频繁自动保存额外加同步 `fsync`。
- 打开外部文件、恢复、重命名、导入、导出都必须尊重路径授权。`app.py` 只允许 `canvases/`、回收站、最近列表里的路径、以及命令行 `--allow-dir` 传入的目录。
- `open-external` 有危险扩展黑名单，不能为了“方便打开”绕开它。

### 零依赖和离线优先

- 不要引入 npm、CDN、Electron、Tauri 或前端框架。
- 已有第三方前端库放在 `assets/vendor/`，包括 MathJax、PDF.js、Mermaid。它们是离线资产，不要把页面改成在线加载。
- AI 是唯一主动出站能力：后端用标准库 `urllib` 调 OpenAI 兼容 `/chat/completions`，默认 DeepSeek。不要新增对外开放的 HTTP 控制面。

### 协议 A / 外部打开

- 外部程序若要打开画布，只传 `.canvas` 文件路径给 `app.py` 或 `desktop.py` 的命令行参数。
- 不要新增“后台常驻远程 API”“局域网同步”“自动监听外部命令”等能力，除非用户明确要求并重新设计安全边界。

### 前端性能和视觉

- `styles.css` 很大，视觉语言是纸张、墨色、温和强调色。不要把界面改回大面积科技蓝、紫蓝渐变或重毛玻璃风格。
- 避免持续 `backdrop-filter`、大面积 blur、无限 keyframe 动画、滥用 `will-change`。这些在旧优化记录里明确踩过坑。
- 编辑器启用深色语义且背景判定为深色时，右侧完整面板、简洁样式面板与简洁节点入口统一使用高不透明度的墨绿黑表面、细亮边框和暖白选中态；这些常驻面板不使用 `backdrop-filter`，避免背景透亮发白和持续模糊开销。
- 大画布、图谱、PDF、MathJax、Mermaid 都在热路径附近。改动 `canvas.js`、`graph-engine.js`、`graph-gl.js` 前先定位最小区域。
- MathJax 与 Mermaid 都是本地按需运行时：前者只由真实公式源触发，后者只由 Mermaid fence 触发。普通文字/普通 Markdown 不应加载它们，也不要恢复全 `document.body` 的 Mermaid MutationObserver；所有生成 Markdown DOM 的入口必须显式调用对应渲染器。
- 画布节点按 id 使用常驻索引供连线热路径查询；静态连线由 Canvas 绘制，拖节点和脑图滑行期间临时切到 SVG 增量更新，收尾后一次性重建 Canvas。`edgePathCache` 保存 Path2D、端点/箭头点、中点和边界，512 画布单位空间网格只查询视口附近连线；平移/缩放不得退回逐边重算几何。当前静态态仍保留 SVG 路径与命中路径作为交互兼容层，但空名称连线不创建标签 DOM，进入名称编辑时才按需创建。删除或快照重建连线时必须同步清理 SVG marker、完整几何缓存与空间索引。
- `prefers-reduced-motion` 已在多处使用；新增动画要考虑降级。

## 3. 源码地图

| 路径 | 责任 |
| --- | --- |
| `app.py` | 本地 HTTP 服务、路由、持久化、导入导出、AI 代理、托管笔记库接口、独立复习卡片数据库、学习/日历/速记/专注数据。 |
| `notes_library.py` | `ROOT/notes/` 托管 Markdown 笔记库的无 HTTP 数据层；负责安全相对路径、增量文档/双链索引、无感修订保存、库外恢复历史、移动改写与回滚、伴生图片、回收站目标校验和外部拖入暂存。 |
| `ai_plan.py` | AI 助手 V2 的纯标准库计划层；集中维护紧凑提示词、JSON 提取、动作协议、安全校验和结构修复提示，不写用户数据。 |
| `desktop.py` | pywebview 桌面壳、WebView2 检测、无边框窗口、窗口状态、未保存关闭确认和动态背景生命周期协调；最大化/还原状态会同步到前端标题栏，最大化时由前端拖拽标记与 Win32 位移拦截共同禁止窗口拖移。 |
| `desktop_instance.py` | Windows 桌面主程序单实例协调；按数据根持有命名互斥锁，通过带认证的本地命名管道转交窗口激活或 `.canvas` 打开请求，并管理 `%TEMP%` 中的短期状态文件。 |
| `windows_wallpaper.py` | Windows 倒数日动态桌面背景宿主；由主进程管理托盘与生命周期，并从同一个 `Relatum.exe` 启动隔离的只读 WebView2 子进程，严格挂载到 Explorer 的专用全屏 `WorkerW`，同时负责主屏尺寸跟踪、单背景互斥、进程间通信和安全清理。 |
| `build-desktop.ps1` | PyInstaller onedir 便携版打包，输出 `Relatum-release/Relatum.exe`。脚本保持 ASCII。 |
| `build-msix.ps1` | Microsoft Store x64 MSIX 打包；复用便携版产物，生成匹配商店身份的清单与图标，输出 `Relatum-store/*.msixupload`。脚本保持 ASCII。 |
| `start.ps1`、`打开画布.bat` | 源码模式启动器，查找 Python 并运行 `app.py`。 |
| `index.html` | 起步页壳，书脊导航、最近画布、树状/学习/速记/日历/复习/专注入口。 |
| `editor.html` | 画布编辑器壳，工具栏、各模式面板、读者浮层、AI 面板、图谱浮层。 |
| `trash.html` | 回收站管理页。 |
| `assets/start.js` | 起步页状态、顶层“画布 / 笔记 / 生涯”工作区切换、最近/分组/收藏、页面切换、主题/背景/翻页速度，以及学习/树状/速记三页的可选前台计时；笔记和生涯运行时均按需加载，首屏稳定后的空闲阶段会预载生涯轻量运行时与冻结快照，首次切换通常直接显示结果。活跃页在内部错峰入场未完成时离页，会先冻结当前内部动画帧，等外层退场隐藏后再清理，避免元素瞬间补齐。 |
| `assets/note-workspace.js` | 起步页多标签笔记工作区适配层；与顶栏同底色的两栏、右侧覆盖式链接/历史栏、带持久化全部展开/收起入口的文件树（只要任一文件夹已展开，入口即显示并执行“全部收起”；仅全部收起时显示“全部展开”）、共享实时预览/源码编辑表面、右上角实时预览/源码一键切换、按需安全阅读面、350ms 串行自动保存、外部修订、拖放导入、图片粘贴和系统资源管理器/回收站操作。主页背景为“沉浸”时，笔记壳、文件树、标签栏和正文使用分层的高不透明度纸面露出环境背景，常驻表面不使用 `backdrop-filter`；“简洁”保持全窗口实色纸面。文件树普通单击在当前标签中切换笔记；标签栏 `+` 只创建可恢复的空白标签，不创建 `.md`，用户随后点击文件才在该标签打开；`Ctrl/Cmd+N` 新建笔记，`Ctrl/Cmd+T` 新建标签。标签栏按路径复用常驻 DOM，只增删和移动真实变化的标签；切换文件时标签标题立即更新，不使用淡入或位移动画。未命中正文缓存时先更新树、路径与标签反馈，再暂时淡化并锁住旧编辑表面，等本地读取完成立即恢复。标签栏提供常驻的一键关闭全部入口，必须等待当前及缓存待保存文档沿既有保存链落盘，失败时保留全部标签。“笔记库”旁的专注按钮只在当前会话收起全局顶栏并保留可恢复入口。每篇正文上方的行内标题直接编辑 `.md` 文件名，重名由非遮挡警告提示；标题及其占位随正文滚走，不能固定挤占视口。词数/字符数以正文右下角悬浮层显示，不独占布局行。文件创建或恢复当前文档时必须自动展开完整父级路径；行内改名提交不得吞掉紧接的一次树点击。 |
| `assets/career-report.js` | 起步页「生涯」冻结使用报告适配层；首次进入时按需加载，只读 `data/career-report.json` 快照并用原生 HTML/CSS/SVG 绘制使用概况、画布、笔记、学习、使用习惯与数据范围六章。“使用习惯”复用已有快照展示月度画布时长、当前笔记最后修改月份、双链/孤立笔记以及打卡/日记日期；专注和复习仍保留在快照与数据来源状态中，但不占主要图表。“月度使用”和“使用时间较多的画布”使用普通纸面，不使用深色强调面板。进入生涯后全局顶栏自动收至窗口上沿，鼠标或触控点击入口时释放工作区按钮焦点，鼠标移入顶部感应区或键盘焦点进入时临时展开。传统离散鼠标滚轮可由左上角齿轮的“生涯滚动手感”启用 RAF 惯性，触控板、键盘、滚动条、横向手势和缩放手势保持原生；低动态偏好、0% 惯性、离开工作区、页面隐藏、语言重绘或重新生成时必须停止惯性。“滚动时暂停揭示”默认关闭：关闭时元素进入视口便立即揭示；开启时惯性停止且连续 50ms（默认，“揭示等待”滑条 20–160ms 可调）无滚动后才批量揭示并恢复数字动画。快速越过的屏外章节不会空播，首次进入仍保留完整错峰。统计数字共用一条动画帧、按显示刷新率逐帧更新，折线、柱形、星期分布、节点类型与篇幅分布点阵、月度矩阵、关系图和时间线保留有限错峰动画；其他高密度每日条码与热力格使用整组展开，且有 `prefers-reduced-motion` 静态降级。离开工作区、语言重绘或重新生成时必须清理观察器、计时器和动画任务。图表可悬停/键盘聚焦，但数值只能由页底“重新生成”替换。不调用 AI、不联网、不保存正文或绝对路径。 |
| `assets/note-live-editor.js` | 基于离线 CodeMirror 6 / Lezer 的源码保真 Markdown Live Preview；负责分帧补齐当前视口语法树、可见富块增量重扫、Obsidian 式源码标记染色、围栏代码语言高亮与语言标签复制、当前语法单元显露、Callout/任务/双链/图片/行内与块公式/Mermaid/表格/derive 组件、IME、括号自动闭合、最高优先级空引用退出、加粗/围栏代码等快捷键与编辑器快照接口，并向阅读模式提供同一安全 Markdown/本地资源渲染入口。实时预览与源码模式通过 CodeMirror `Compartment` 原位重配置，不能重建文档状态或清空撤销历史。Markdown 字符串始终是唯一真源，原始 HTML/SVG 只显示源码。 |
| `assets/vendor/codemirror/` | 固定版本的 CodeMirror 6 / Lezer 离线浏览器 bundle、完整依赖锁和第三方许可证；只在笔记工作区首次交互或空闲预热时加载，运行和桌面打包均不需要 Node/npm 或网络。 |
| `assets/editor.js` | 编辑器页面编排：加载/保存、模式切换、模板、导出、背景、AI/图谱入口和参考画布父页协调。 |
| `assets/editor-lazy.js` | 编辑器非首屏运行时协调：AI/图谱首次交互可立即抢先加载，未交互时在揭幕后空闲补载；新手引导/说明框揭幕后补载，并在揭幕后空闲触发 KoseFont 补齐；不得让这些资源重新进入首屏阻塞链。 |
| `assets/font-loader.js` | 主编辑器与双屏参考查看器共用的大字体按需注册层；只有真实手写文字/文字框画布或编辑器揭幕后空闲补齐时才注册并加载 KoseFont。 |
| `assets/editor-onboarding.js` | 编辑器首次使用引导：十一页 CSS 演示浮窗、翻页/重播、中英文案和真实画布四步练习。 |
| `assets/i18n.js` | 起始页与编辑器共用的界面语言层；保存语言偏好、翻译静态/动态 UI，并保护用户内容区。 |
| `assets/tooltip.js` | 全局自定义说明框层；接管静态与动态 `title`，同步中英文文案，并处理悬停/键盘焦点与视口避让。 |
| `assets/canvas.js` | 核心画布引擎，节点/边/手写/附件/批注/选择/历史/导图/独立表格/AI 计划执行和双屏选区导入导出。 |
| `assets/ruler.js` | 画布尺子的无 DOM 几何层；负责数据归一化、坐标旋转、有限长边投影、笔迹线段捕获与节点扫掠碰撞。 |
| `assets/canvas-import.js` | `.canvas` 内容合并的无 DOM 数据层；负责结构校验、深拷贝、ID/引用重映射、附件策略与节点/墨迹联合边界偏移。 |
| `assets/dual-viewer.html`、`assets/dual-viewer.js` | 双屏右侧的轻量只读参考查看器；只加载画布渲染与选择所需运行时，不加载完整编辑器、AI、图谱或保存逻辑。 |
| `assets/dual-clipboard.js` | 双屏会话剪贴板标记与可读纯文本序列化；供右侧复制和主画布粘贴识别共用。 |
| `assets/node-matrix.js` | “节点矩阵”的无 DOM 数据层；负责行列与数量校验、连续编号、Tab/换行二维粘贴、统一宽度解析和居中网格布局。 |
| `assets/canvas-timer.js` | 画布倒计时/正计时的无 DOM 数据层；负责数据规范化、真实时间差、格式化、完成判定、复位与状态取反。 |
| `assets/canvas-scenes.js` | “镜头册”的无 DOM 数据层；负责固定/跟随镜头规范化、创建、更新、删除、排序和失效引用清理。 |
| `assets/canvas-taskbook.js` | “任务簿” V3 界面的无 DOM 数据层（盘面仍为 `taskbook.version:2`）；负责顶级任务与成员树规范化、独占归属、叶子进度、计时段、枝桠工作流镜像和归档完成副本。 |
| `assets/markdown-notebook.js` | “笔记坞”的无 DOM 数据层；负责多页笔记规范化、复用共享 Markdown 结构规则生成导图层级、结构统计、画布选区反向序列化和 Enter 列表续写。 |
| `assets/ai.js` | 右侧 AI 助手 V2 面板、聊天、操作推荐、上下文模式、逐项预览和确认应用。 |
| `assets/ai-canvas-plan.js` | AI 助手 V2 的无 DOM 画布数据层；负责上下文截断与指纹、预览操作依赖、严格导图/扩展子树转换和普通网络的确定性局部布局。 |
| `AI笔记创作指南.md` | 外部 AI agent / 人工准备 `.canvas` 或 Markdown 笔记时的创作参考；不参与内置 AI 运行，也不打进桌面包。 |
| `assets/richtext.js` | 画布文字的结构化局部格式层；管理 `textMarks` / `bodyMarks`、旧内联语法迁移、编辑 DOM 与导出序列化。 |
| `assets/markdown-table.js` | Markdown 表格的无 DOM 数据层；负责解析、规范化、序列化、CSV/TSV 粘贴与正文内表格定位。 |
| `assets/markdown.js` | 零依赖 Markdown 结构层与安全渲染器；统一标题、列表/任务项、引用、围栏、公式和段落分类，提供 `renderResult()` 的 HTML + Math/Mermaid 特征结果，并保留 `render()` 兼容入口。只有笔记工作区显式传入 `localImages:true` 时才生成无 `src` 的本地图片占位，其余调用保持既有安全行为。 |
| `assets/table-editor.js` | 通用二维网格交互层；负责单元格/行列选择、增删、粘贴、对齐、源码切换与表格工作室。 |
| `assets/mermaid-renderer.js` | 统一离线 Mermaid 渲染队列。 |
| `assets/graph-engine.js` | 通用关系图引擎，Canvas2D + 可选 WebGL 几何后端。 |
| `assets/graph-gl.js` | WebGL2 实例化渲染后端，暴露 `window.GraphGL`；只画节点/边几何，文字仍走 2D/DOM。 |
| `assets/graph-view.js` | 当前画布关系图浮层。 |
| `assets/study.js` | 独立学习任务系统：极简清单、单位进度面板、自适应数字任务页、每页可选说明、引用式临时任务侧栏、回收站与完成归档；任务数据与总路线共用。任务卡片颜色存在任务的 `color` 字段，进度卡/清单行/临时侧栏右键弹出同款 12 色调色盘。 |
| `assets/study-goal-tree.js`、`assets/study-route.js` | 学习页“目标树”V4 的无 DOM 链接模型与交互层；阶段递归等权汇总整棵主路线后代中的任务，但由该阶段自身完成条件解锁的后续分支会作为阶段边界截断，避免后续任务反向自锁；任务/阶段用 `requires` 解锁后续，多个入站依赖按 AND 判定。主链接驱动双向自由布局和整棵子树拖动，附加依赖不影响排版；还负责阻塞原因、“下一步”定位、阶段折叠和每树独立镜头。阶段右键直接弹调色盘，任务节点右键菜单含“颜色”项，颜色都写任务或阶段节点的 `color` 字段。 |
| `assets/study-palette.js` | 目标树阶段与学习任务卡片共用的 12 色粉彩色库（单一事实来源）；只提供 `window.RelatumStudyPalette.COLORS`，不写用户内容。 |
| `assets/tree-page.js` | 起步页独立“树状页”的交互层；直接使用 `study-goal-tree.js` 的目标树模型，并以 `study-route.js` 为运行时母版保留布局、常驻 DOM、FLIP、整枝拖动、相机、编号栏、弹层与教程手感。它只调用树状页独立 API，另加卡片形状，不读取学习页数据，也不提供接入已有任务。树状页调用共享目标树模型时必须显式启用空根标题；学习页仍保留“我的学习路线”的缺省名，不能用共享规范化再把树状页的空标题回填。任务与黑色根节点的进度条复用学习任务的宽度/颜色缓动、达标材质揭示、有限光流与低动态降级；有量化进度的任务会常驻固定宽度的控制槽和独立完成材质层，手动勾选不改真实数值，而从当前比例揭示到持久 100% 金色完成态，恢复任务后重新露出原进度；未设置量化进度时卡片不显示“设置进度”占位文字。卡片右键调色盘覆盖卡片内部的文字与按钮子控件，里程碑仍不提供外观菜单。树状页只适配卡片尺寸和独立请求队列。 |
| `assets/study-graph.js` | 活跃页/学习页星图，可视化学习活动和任务结构。 |
| `assets/sticky-palette.js` | 速记墙、起步页跨页便签与画布便签共用的20色色库和随机候选偏好；负责按色系均衡抽色，不写用户内容。 |
| `assets/notes.js` | 起步页速记墙，独立便签数据、拖拽、连线、箭头、归档与按纯文本视觉长度分档的正文排版。 |
| `assets/start-sticky-notes.js` | 起步页跨页便签：安全空白创建、纯文本编辑、轻量拖动、键盘换色/旋转/删除。 |
| `assets/calendar.js` | 日历、日记、右侧三栏（画布活动 / 每日打卡 / 学习任务，替换原专注记录与归档成果）、倒数日与日历页倒数日进度条（每事件可选 `lengthDays` 窗口长度，已过事件显示学习页同款金色达成态）。内部错峰入场未完成时离页会冻结 CSS / WAAPI 当前帧，外层退场隐藏后再清理，保证再次进入仍从头重播。 |
| `assets/countdown.html`、`assets/countdown.js` | 独立倒数日页面；事件管理、轻量翻页时钟、空状态、返回日历过渡与桌面背景只读模式。 |
| `assets/review.js` | 独立复习卡片页面，负责计划复习、无限随机自由复习、卡片库、卡组/标签、批量管理和评分。 |
| `assets/focus.js` | 专注钟、正计时/番茄钟、每日任务绑定、音效/噪音、记录编辑。 |
| `assets/trash.js` | 回收站页面，按目标分组恢复、键盘恢复、一键清空确认。 |
| `assets/desktop-shell.js` | 前端到 pywebview 的桥接、窗口按钮、dirty 标记；桌面关闭按钮支持注册异步保存前置钩子。 |
| `assets/styles.css` | 全局视觉系统和所有页面样式。 |
| `assets/editor-onboarding.css` | 编辑器新手引导的纸页浮窗、十一组有限播放演示、按钮反馈、深色与低动态适配。 |
| `assets/vendor/` | 离线 MathJax / PDF.js / Mermaid。一般不要人工改。 |
| `packaging/make_icon.py` | 用 Pillow 从源图生成 `assets/app-icon.ico`。 |
| `packaging/make_font_subset.py` | 可选的 Noto Sans SC 字体子集再生成工具。 |

## 4. 运行时和数据位置

### 根目录选择

- 源码运行时，`ROOT` 是源码目录。
- PyInstaller 冻结运行时，静态资源来自 `_internal`。无包身份的 GitHub 便携版仍在 exe 同级创建用户数据；具有 MSIX 包身份的商店版改在 `%LOCALAPPDATA%/Relatum` 创建，不能向只读安装目录写入。
- `SOURCE_ROOT` 表示源码目录，`RESOURCE_ROOT` 表示源码或 PyInstaller `_internal` 的只读资源目录；运行时静态资产从 `RESOURCE_ROOT/assets` 读取。外部《AI笔记创作指南》不属于运行时资源。

### 用户数据文件

| 数据 | 路径 |
| --- | --- |
| 画布 | `canvases/*.canvas` |
| 回收站 | `canvases/回收站/` |
| 画布附件 | 与画布同名的 `<stem>.assets/` |
| Markdown 笔记库 | `notes/`；普通文件夹和 `.md` 是正文，粘贴图片位于同目录 `<笔记名>.assets/images/`。伴生目录默认不显示在文件树，但与笔记一起移动、重命名和移入 Windows 系统回收站。没有正文数据库或发布索引。 |
| 笔记恢复历史 | `data/note-recovery/`；按逻辑笔记路径保存完整 Markdown 快照，普通快照最短间隔 5 分钟，保留 7 天；外部碰撞、历史恢复和高风险覆盖前强制快照。 |
| 最近、分组、收藏 | `data/recent.json`（v3）；上一次有效快照为 `data/recent.backup.json`，损坏原件隔离成 `data/recent.corrupt-<时间>.json` |
| 背景偏好、辅助底纹与上传背景 | `data/background.json`（v2：`background` + 可选 `guide`）、`data/backgrounds/` |
| 画布视口 | `data/viewport.json` |
| 学习任务 | `data/study.json`（v6）；任务含标题、`active/done` 状态、单位进度、任务点、时间戳与 `taskPage`（1–99，旧 v6 缺失时归入第 1 页）；可选 `color` 保存任务卡片颜色，只允许严格 `#rrggbb`，空串为默认色，缺失时缺省为空串，旧数据无需迁移；可选 `taskPageNotes` 按页码保存非空的单行说明。`temporaryTaskIds[]` 按加入顺序全局引用临时任务侧栏中的未完成任务，完成、回收、归档或悬空引用在规范化时自动清理；`goalTrees[]` 保存多棵 `{version:2,id,title,nodes[],links[]}` 路线，`activeTreeId` 保存当前树。数字任务页只分组显示与排序，临时任务、回收站、活跃统计和目标树继续跨页共享，归档只处理当前页。每个目标树节点恰有一条主链接，附加解锁条件使用非主 `requires`；不再写入 `goalTree` 兼容镜像。v6 不迁移旧学习数据，读到旧版本只报不兼容且不覆盖原文件。 |
| 独立树状页 | `data/tree-page.json`（v2）；顶层保存独立 `tasks[]`、`goalTrees[]` 与 `activeTreeId`，目标树结构对齐学习目标树 v2，每树另存根外观，阶段/任务可选保存 `shape`。根标题允许保存为空字符串，空值在保存、其他树命令规范化、页面重载和共享前端模型构建后都不得被回填。每个任务必须只在一棵树出现一次，不允许跨树共享或成为孤儿；删任务、阶段或树会级联清理其任务和依赖。缺失文件及旧实验 v1 均返回同一个未落盘的稳定空白 v2，首次命令才原子写入；损坏或其他不兼容版本报错且不覆盖。它绝不读取、迁移或同步 `study.json`。 |
| 学习归档 | `data/学习归档/`；学习任务使用 `tasks.json`、速记使用 `notes.json`、任务簿完成归档使用单条 `taskbook.json` marker。 |
| 画布归档轻量记录 | `data/画布归档/` |
| 速记墙 | `data/notes.json` |
| 起步页跨页便签 | `data/start-sticky-notes.json`，按 `recent/study/cadence/calendar/review/focus` 页面归属保存；树状页不创建跨页便签，也不进入速记墙归档 |
| 速记归档 | `data/学习归档/<时间>-速记归档/notes.json` |
| 专注记录 | `data/focus.json` |
| 画布活动账本 | `data/canvas-activity.json`（v1）；独立保存稳定画布 ID、受管路径变更、创建/修改历史标记和按本地日期拆分并合并去重的前台使用时间段，不写入 `.canvas`。首次建立时只从 `createdAt` / `updatedAt` 或文件时间回填事件，不伪造历史时长。 |
| 起步页活动账本 | `data/start-page-activity.json`（v1）；只保存学习、树状、速记三页按本地日期拆分并合并去重的前台时间段，不回填历史，不读取或改写三页各自的内容文件。 |
| 每日任务 | `data/daily.json`，含汇总字段、可选累计打卡目标 `targetDays`、命名里程碑 `milestones[]`（用户侧不设小额限制，异常数据安全上限 50）与逐日历史 `doneDates` / `minutesByDate`；上一份有效快照为 `data/daily.backup.json`，损坏原件隔离成 `data/daily.corrupt-<时间>.json` |
| 日记 | `data/diary/YYYY-MM-DD.md` |
| 旧日历任务便签 | `data/calendar-pins.json`；仅保留旧文件，不再读取、写入或展示 |
| 倒数日 | `data/countdown.json`，v2 为 `events[] + selectedId`，并镜像当前 `event/date`；允许零事件，零事件时文件不存在；旧版单事件自动兼容迁移。每个事件可选保存 `lengthDays`（1–9999 整数），是日历页倒数日进度条的窗口长度（天），缺省即未设置，非法值在净化时丢弃 |
| 模板库 | `data/templates.json` |
| 复习卡片 | `data/review.db`，SQLite；`review_cards` 保存内容、卡组关联与调度，`review_decks` / `review_tags` / `review_card_tags` 管理组织关系，`review_events` 保存每次评分，`review_settings` 保存复习范围与会话偏好。“今日已复习”必须使用 `reviewed_at` 的半开时间范围查询，保持命中时间索引，不得对整列使用 `substr` 等函数 |
| 生涯使用报告 | `data/career-report.json`（v1）；只在用户首次生成或页底“重新生成”时扫描现有本地账本与内容库，以原子替换保存统计期、数据源状态、图表序列、聚合值和少量项目名称。普通打开只读快照，不会重新统计；生成失败时保留旧快照。画布、专注和起步页三类真实计时始终独立保存，不合并成可能重叠的“总时长”；当前库存、完成记录和推断日期也保持分开。快照中的专注与复习字段继续用于兼容和来源状态，当前主要报告不为其保留独立图表。快照不保存 Markdown/日记/速记正文、绝对路径或素材，不调用 AI 也不联网 |
| AI 配置 | `data/ai.json`，含 Key、模型、baseUrl |
| 桌面窗口状态 | `data/window-state.json` |

全新用户尚无 `data/background.json` 且当前画布也没有旧版背景字段时，编辑器出厂默认使用“月灰”纯色、横线纸底纹、全屏沉浸、浅色背景语义，并关闭标题栏可读性保护；首次加载后会把这组全局背景偏好写入 `data/background.json`。辅助底纹是独立的全局可选偏好；新用户缺省为横线纸，迁移只有旧版背景字段的画布时仍保持无底纹；可选无底纹、横线、点格、方格或主次方格，与原背景共存而不写入 `.canvas`。

起步页拿到全局背景偏好后会立即用低请求优先级预热图片背景并同步深浅语义。`/api/background-image` 允许浏览器私有保存响应字节，但每次通过基于文件修改时间与大小的 ETag 向本地服务复检；画布附件仍保持 `no-store`。编辑器揭幕只等待最终背景底色、画布与标题，不等待位图下载；图片完成后在背景层淡入。纯色背景不产生图片请求。

`editor.html` 在 `<head>` 里声明首屏核心 `defer` 脚本，使下载与大型编辑器 DOM 解析重叠；同一阶段通过 `window.__relatumOpeningRequests` 提前并行启动 `/api/load` 与 `/api/background-preference`，`editor.js` 必须复用这两个 Promise，不能重复请求。AI、图谱、新手引导、说明框与 KoseFont 不属于普通画布揭幕的阻塞链；AI 与图谱在揭幕后空闲补载，首次交互可抢先复用同一个加载 Promise。

### `.canvas` 和 `.assets`

- `.canvas` 是 JSON，当前新建数据为 `version: 2`，核心字段是 `createdAt`、`updatedAt`、`nodes`、`edges`，手写数据也随画布保存。节点与文本框的局部字号/字色/高光/粗体使用 `textMarks` / `bodyMarks` 区间数组保存，文字本身始终是纯文字；代码节点不使用 `bodyMarks`。独立表格使用 `kind:"table"`，可选标题保存在 `text`，规范 Markdown 表格保存在 `body`，可选 `tableScale` 保存画布紧凑态 72%–180% 的整体缩放；可选 `tableLayout.columnWidths` / `tableLayout.rowHeights` 只保存用户调整过的列宽和行高，数组中的 `null` 表示该位置使用缺省尺寸，末尾缺省项会裁掉，全部缺省时删除整个 `tableLayout`。`tableChrome:"hidden"` 隐藏画布上的完整标题栏，`tableHeader:"emphasized"` 启用表头加粗与底色，`tableAppearance:"matrix"` 使用透明矩阵外观，矩阵括号缺省为圆括号，可选 `tableBracket:"square"` / `"determinant"`。表头缺省为普通样式，其余缺省显示状态不落冗余字段。表格不保存 `width` / `bodyHeight`，运行时网格内容模型也不落盘，不使用 `textMarks` / `bodyMarks`；`tableLayout` 是展示元数据，不得复制单元格内容。早期表格的 `width` 会在加载时折算为 `tableScale` 后删除。
- 每张画布可选保存一把尺子为顶层 `ruler:{cx,cy,angle}`：中心使用画布坐标，角度归一化到 `[0,360)`；固定的 720×52 画布单位尺寸不写盘。删除尺子即删除整个字段，不提升 `.canvas` 版本。
- 每张画布可选保存多个独立计时器为顶层 `timers[]`：保存 `id/x/y/mode/label/elapsedMs`，倒计时另存 `durationMs`；运行状态和起始时间只存在当前编辑会话，重开画布一律停止。无计时器时删除整个字段，不提升 `.canvas` 版本。
- 每张画布可选保存镜头册为顶层 `sceneBook:{version:1,scenes[]}`。固定镜头保存 `kind:"camera"` 与相机中心/缩放，跟随镜头保存 `kind:"selection"`、`anchorNodeIds` / `anchorGroupIds` 和内容全部缺失时使用的备用相机；数组顺序就是演示顺序。镜头缩略图、当前镜头和演示位置均不落盘。最后一个镜头删除后移除整个字段，不提升 `.canvas` 版本；镜头元数据变化不进入节点 Ctrl+Z 历史。
- 每张画布可选保存任务簿顶层字段 `taskbook:{version:2,roots:[]}`。每个 root 保存 `id/title/body/completed/order/canvasNodeId/members/sessions/activeSession/createdAt/updatedAt`，隐藏投影时另存可选的 `hiddenCanvasPosition:{x,y}` 供再次放回原位；`members[]` 是唯一任务树来源，成员引用普通卡片/预览节点并保存 `nodeId/parentNodeId/order`。画布上的顶级任务只是可移除、可重建的轻量投影节点 `kind:"task-root"` + `taskRootId`；层级视觉边固定为父→子的 `role:"task-workflow"`、`curve:"branch"`、`arrow:"end"`、中性灰 1.5px 实线，并可从成员树重建。一个普通节点只能属于一个顶级任务并只有一个父级，必须拒绝循环与跨树暗中转移。删除最后一个顶级任务后移除整个字段；旧实验版 `kind:"taskbook"` 节点和 `taskbook-workflow` 边在规范化时直接清除，不迁移。
- 每张画布可选保存笔记坞为顶层 `markdownNotebook:{version:1,notes[]}`；每篇笔记保存 `id/title/markdown/createdAt/updatedAt`，数组顺序就是用户排序。首次打开的空白笔记是会话虚拟页，只有输入正文或修改标题后才落盘；最后一篇删除后移除整个字段，不提升 `.canvas` 版本。笔记编辑不进入画布撤销历史。
- 每个画布的资源目录是同名 `<stem>.assets/`。移动、重命名、删除画布时必须同步处理这个目录。
- 图片和背景资源按后端上传接口管理。画布附件位于 `.assets/attachments/`。
- Markdown 附件批注保存在附件旁的 `<asset>.annot.json`。文本区/阅读器手写批注保存在 `.assets/node-annotations.json`。
- `clean-assets` 会根据画布中仍引用的资源清理孤儿文件；不要手写另一个清理逻辑。
- 起步页“导入画布”通过服务端原生选择器把一张外部 `.canvas` 复制到 `canvases/`，同名时加 `-2/-3`，并复制实际引用的素材与批注；缺失素材只警告，导入后立即打开项目内副本。“导入文件夹”只接受顶层 `.canvas` 和对应 `.assets`；回收站、未知顶层条目、孤立/未知/缺失素材、损坏批注或链接/重解析点都拒绝整批。批量导入先暂存和复检来源，再一次提交画布、素材、最近索引与活动账本；任一步失败都回滚。外部目录的分组、收藏、排序和回收站不导入。若用户已经手工把文件复制进当前 `canvases/`，可在起步页“未分组”标题旁手动扫描：只登记合法的顶层 `.canvas`，不复制素材、不伪造打开时间；失效登记必须预览确认后才从 `recent.json` 清理。

### `notes/` 托管 Markdown 笔记库

- 笔记库是起步页顶层“笔记”工作区，不是画布内 `markdownNotebook` 笔记坞，也不读取 `data/notes.json` 速记墙。默认只显示文件树与多标签编辑区，所有标签共用一个 CodeMirror 实例与现有保存链；链接/历史从右侧覆盖展开而不挤压正文，不建立常驻第三列。
- 所有笔记 API 只接受相对 `notes/` 的 POSIX 路径。绝对路径、反斜杠、`.` / `..`、Windows 保留名、大小写冲突、内部 `.relatum-*`、符号链接和 Windows 重解析点都拒绝；不能处理笔记根。图片 `src` 可在解析后仍留在库内的前提下使用 `../`。外部直接复制/删除 `.md` 后，窗口重新聚焦或手动刷新会同步树；外部删除在本地无新编辑时静默关闭当前文档，若删除与输入同时发生则保留编辑器内容并重建文件。
- 编辑器每次输入立即更新 CodeMirror 内存文档与原生撤销栈，`onDocChanged` 只回传选区/滚动元数据，不得在每次按键时 `doc.toString()`。350ms 空闲保存、`Ctrl+S`、切文档、失焦和关闭冲刷才通过 `snapshot()` 取完整 Markdown，再用 SHA-256 修订号、同目录唯一临时文件和 `os.replace` 串行落盘。切文档时点击帧先更新树选中态和路径面包屑，并先发起目标读取；上一文档的快照保存只在后台队列继续，不能阻塞下一篇的显示。当前会话缓存最近打开正文，并在空闲时预读最多 12 篇不超过 512KB 的笔记；缓存只是切换加速层，后台磁盘复检仍是事实来源。只有真实 I/O 错误显示非遮挡错误条并重试。
- 外部修订在本地无新编辑时静默载入；与本地编辑碰撞时先强制把磁盘内容写入 `data/note-recovery/`，再以当前编辑器内容为准，不显示冲突弹窗。正常快照最短间隔 5 分钟，保留 7 天，历史恢复前先快照当前版本。
- 双链先按精确库内相对路径解析，再按唯一文件名解析；重名或缺失不猜目标。移动/重命名只改写操作前能够唯一指向目标的 `[[双链]]`，保留别名、标题锚点和块引用；短链接移动后仍唯一时保持短写法，否则写新库内路径。文件/目录、伴生素材和引用改写共同暂存并在失败时回滚，歧义链接只返回警告。Relatum 插入到 `<笔记名>.assets/images/` 的图片会随 `.md` 跨文件夹移动并保持可解析；用户手写的库内共享相对路径（例如 `../shared.png`）仍按移动后的笔记位置解释，移动后是否有效取决于目标相对位置。
- 当前笔记的 `•••` 菜单提供“实时预览 / 源码模式 / 阅读模式”，右上角常驻按钮在实时预览与源码模式之间一键往返；选择保存在本地偏好且切换标签后沿用，三种模式始终共享同一 Markdown 字符串与现有保存链。源码模式继续复用同一个 CodeMirror，只通过 `Compartment.reconfigure()` 原位移除或恢复块组件与行内投影，必须保留正文对象、选区、滚动和原生撤销历史，不能重建编辑器状态或退回逐键复制全文的 textarea；阅读模式必须通过 `MarkdownMini.renderResult(..., {localImages:true})` 的安全结果和 `/api/note-asset` 显示本地图片，公式与 Mermaid 仍走离线按需运行时，不能执行原始 HTML/SVG。实时预览与源码模式都使用 CodeMirror 原生语言感知配对：`[]`、`()`、`{}`、单双引号自动闭合，输入已有闭合符时越过，空配对退格同时删除；`Ctrl/Cmd+B` 包裹选区为加粗，`Ctrl/Cmd+Shift+K` 把选区包成围栏代码块或在光标处插入空围栏；阅读模式不响应编辑键。Markdown 默认续行之前以最高优先级先处理只有引用标记的当前行：单层 `> ` 第二次回车清除标记并退出引用/Callout，嵌套引用每次只退出最深一层，含正文的引用、列表和任务列表仍走默认续行。单表面 Live Preview 由 CodeMirror 6 / Lezer 保持 Markdown 源码与光标位置，只在光标不位于完整语法单元时用 decorations/widgets 显示排版结果；活动单元的定界符由 Relatum 自有标记层染成浅灰/语义色，不得恢复 CodeMirror `defaultHighlightStyle`。有效 Markdown 转义只按 Lezer `Escape` 语法节点把反斜杠染灰，读取渲染仅移除可转义 ASCII 标点前的反斜杠；无效转义、行内代码和围栏代码必须保持原文，不能用全局正则把所有反斜杠当成转义。CodeMirror 初始语法树可能只覆盖长文档前段，因此编辑器必须以短时间片补解析当前视口；滚动恢复、滚动与富块高度变化后要按帧合并刷新，并在有界的前后字符缓冲区内发现附近富块，待组件几何稳定后再补一帧当前可见装饰；不得改回每次滚动扫描整篇。表格、公式等块级替换会把 CodeMirror 的 `visibleRanges` 切成多段；每段都必须继续遍历语法树，跨段重复出现的祖先节点只能去重自身装饰，不能剪掉后一段尚未访问的子树。围栏代码使用离线内置的 C/C++/Arduino、Python、JavaScript/TypeScript、JSON、HTML/CSS、Java、Shell/PowerShell、SQL、LaTeX、MATLAB/Octave、Markdown 解析器和仅作用于代码 token 的自有 HighlightStyle；即使视口从围栏中段开始，可见代码行也必须通过边界祖先解析保留连续底色，活动代码行不得掉色，未知语言退化为普通等宽源码。非活动且带语言的围栏在首行右上角显示作者原样输入的语言标签，点击只复制不含围栏的代码正文并短暂反馈，不能移动选区；光标进入代码单元后隐藏标签，避免遮挡围栏源码。任何富块间距都不得通过 CSS 强改 `.cm-line` 的高度或行高，否则会破坏 CodeMirror 高度图并使后续代码鼠标坐标错行。非活动 ATX 标题必须把开头 `#` 与其后的分隔空白作为同一个隐藏范围，保证 H1–H6 与普通正文严格共用左边缘；光标进入标题后只恢复并染色 `#`，分隔空白保持普通排版。表格和 Obsidian Callout 卡点击后回到原位源码，Callout `-` 缺省折叠正文；Callout 类型、别名、图标与色板按 Obsidian 官方语义区分，未知类型安全退化为 Note，实时预览与阅读模式共用同一视觉。原始 HTML/SVG 始终只显示源码。复杂隔离块可复用 `MarkdownMini` 的安全 HTML，但不能整篇重渲染或回写 HTML。图片只交给 `/api/note-asset`，粘贴/拖入的栅格图片写入 `<stem>.assets/images/` 并插入标准相对 Markdown；公式同时支持 `$...$`、独占行的 `$$...$$` 和多行 `$$` 块，只在闭合、非活动、可见且未超限时按需运行，Mermaid 遵循同一边界；异步结果回写前必须同时校验笔记世代、组件 ID、源码指纹和 DOM 存活。
- Live Preview 的块替换组件不得使用 CodeMirror 测量矩形之外的垂直 `margin`，留白只能用会计入组件高度的内部 `padding`；否则每个表格、分隔线、公式等组件都会累积屏幕坐标偏差，使后续代码行点击落到其他行。Callout 不再整段替换为块组件，而是保留每一条 CodeMirror 源码行，并在非活动时逐行投影标题、图标、色板和连续圆角，确保点击卡片上下行不会落入 Callout 源码。
- 笔记正文基线为 16px / 1.5 行高，最大有效行宽 1040px，宽窗左边距最多 112px；正文和行内文件标题优先使用系统 UI 字体栈，Noto Sans SC / 微软雅黑只作跨机器后备，且禁用伪造字重。行内文件标题保持 32px，Markdown H1 为 1.75em 并逐级收敛，不能让 H1 与文件标题同大；齿轮中的百分比滑条只缩放正文与行内文件标题。文件路径栏保持固定，行内文件标题及其顶部占位属于正文滚动内容：滚动时通过共享编辑表面的 `scrollTop` 同步移出并裁切，不能常驻挤压正文。词数/字符数统计定位为正文右下角的无交互悬浮层，不得作为 flex 子项独占一行；字符数可用 CodeMirror 文档长度随输入即时更新，词数在 350ms 快照或其他既有保存边界更新，不能为了统计恢复逐键全文 `toString()`。
- 新建笔记用本地时间戳直接创建，创建接口直接回传空白正文和修订号，不追加一次 GET；普通新建会聚焦并全选正文上方的行内文件标题，用户改名时只移动 `.md` 与伴生素材，不把标题写入 Markdown 正文，重名返回浮动警告并保留原名。新建文件夹、`F2` 和右键重命名继续共用树内输入。文件树使用常驻路径索引更新选中态，只有目录展开/结构变化才重建树；展开子目录必须保留缩进和竖向层级线，正文顶栏用 `notes › 文件夹 › 文件.md` 面包屑显示归属。文件树内拖放乐观移动，Windows Explorer 拖入使用 begin/upload/commit/abort 暂存会话复制 Markdown、目录和安全栅格图片。
- 右键笔记或文件夹都有“在系统资源管理器中显示”：文件使用 Explorer `/select` 选中，文件夹直接打开；笔记另有“打开伴生素材目录”。删除走 Windows 系统回收站，笔记与同名 `.assets` 一次移入，不在应用内弹确认框。

### 浏览器本地偏好

很多 UI 偏好存在 `localStorage` / `sessionStorage`，不进 `.canvas`：

- 学习目标树与独立树状页共用 `canvas:goalTreeEnforceUnlock:v1`：默认关闭，解锁关系只作为路线提示，任务可自由完成或修改进度；只有齿轮开关显式存为 `'1'` 时，两页才禁止未解锁任务的完成和进度变更。偏好不改变 `requires` 连线、解锁计算或用户数据；前端在受保护的变更请求中显式传送 `enforceGoalTreeUnlock`，后端不信任纯 UI 禁用状态。

- 顶层工作区使用 `canvas:startWorkspace:v1` 记住最后一次“画布”、“笔记”或“生涯”。笔记工作区另用 `canvas:noteActivePath:v1`、`canvas:noteOpenTabs:v1`、`canvas:noteExpandedFolders:v1`、`canvas:noteLinksOpen:v1` 和 `canvas:noteView:v1` 记住当前文档、打开标签、展开文件夹、覆盖侧栏开关与实时预览/源码/阅读视图；`canvas:noteFontScale:v1` 保存齿轮设置里的 80%–140% 正文字号比例，100% 对应 16px，仅存在本机。收起全局顶栏的专注态只保存在当前页面会话，不写持久偏好；这些偏好不替代磁盘修订校验。
- 以“画布”启动时，首屏和画布数据完成竞争后才用 `requestIdleCallback`（无支持时短延时降级）加载笔记运行时，并预取文件树与上次文档；不得把笔记脚本或 `/api/notes-tree` 放回画布首屏阻塞链。用户在空闲预热完成后首次切入“笔记”应直接看到文件树与正文，不出现一次额外的加载页。
- 以上次“笔记”工作区冷启动时，`index.html` 在首帧同步添加 `note-boot-pending`，只隐藏尚未初始化的笔记面板，不缓存或伪造正文；`note-workspace.js` 完成文件树与上次文档的真实磁盘读取后一次性揭示。揭示门最长 4 秒，读取失败或用户中途切回画布时必须解除，不能形成永久空白页。

- 起步页：当前分组、主题、背景风格（`canvas:startBackgroundStyle`，unset 时默认“简洁”）、翻页速度、速记页拖拽惯性、叠放展开延迟、日历倒数日开关、生涯揭示等待（`canvas:careerScrollIdleMs:v1`，20–160ms，默认 50ms，生涯页滚动停稳到批量揭示的等待）、学习/树状/速记前台计时开关（`canvas:startPageActivityEnabled:v1`，**默认关闭**：只有显式存为 `'1'` 才开始记录）及绿色附加统计显示开关（`canvas:startPageActivityStatsVisible:v1`）；两项独立保存 `'1'` / `'0'`，新增显示偏好首次读取时继承旧计时开关状态并立即保存，之后互不影响。画布名称搜索开关（`canvas:librarySearchEnabled`，**默认关闭**：只有显式存为 `'1'` 才在画布列表标题旁显示搜索工具）、树状页根标题隐藏开关（`canvas:treePageRootTitleHidden:v1`，**默认关闭**：仅显式 `'1'` 隐藏）与根标题字号（`canvas:treePageRootTitleSize:v1`，16–36px，默认 25px；滑条在 45% 位置显示灰色默认值提示线）、隐藏特殊页开关（`canvas:hideSpecialPages`，**默认关闭**：只有显式存为 `'1'` 才隐藏，unset 或其他值都正常显示全部页面；开启后书脊只留最近/收藏/分组，滚轮翻页与点击都不进 7 张前置页）、本地数据说明看过状态 `canvas:dataGuideClicked:v1`。左下角 `?` 打开中英文各四页的本地数据说明，解释 `canvases/`、`notes/`、`data/` 中各类文件和浏览器/WebView2 本机偏好的用途、删除后果与安全清理顺序；其中将独立树状页的 `tree-page.json` 与学习页的 `study.json` 明确区分，并说明任务页颜色、树镜头和未完成专注计时等只存在本机的状态。说明中不展示盘符、用户名或固定绝对路径，仅使用相对数据目录和便携式存储名称。它不再承载旧版功能教程。说明浮层打开和关闭都使用一次有限过渡，低动态偏好下立即完成；除了细书脊本身，还把正文滚动区最左侧约 64–88px 作为滚轮翻页热区，右侧其余区域继续纵向惯性滚动，且不通过扩大书脊 DOM 遮罩阻挡顶部目录按钮。右侧正文滚动条使用无原生上下按钮的细圆角滑块，深浅主题分别控制对比度。三类便签共用 `canvas:stickyPalette:v1`，以 `{version:1,disabled:[]}` 只保存不参与随机生成/换色的色名；缺失或非法值启用全部20色。全部禁用会保留为控制台“视觉全不选”状态，但随机生成/换色仍安全使用全部20色；新颜色未来默认加入，不写 `.canvas` 或便签数据。
- 生涯滚动手感另存 `canvas:careerScrollFeel:v1`：滚轮力度 50–200%、惯性 0–100%、连滚加速 0–100%、速度上限 600–3600px/s 与“滚动时暂停揭示”开关，默认分别为 100%、45%、60%、2400px/s、关闭；只影响生涯的传统离散鼠标滚轮与揭示时序。`canvas:careerScrollIdleMs:v1` 继续独立保存 20–160ms、默认 50ms 的揭示等待，旧偏好不能因新增手感 JSON 缺失或损坏而丢失。
- 编辑器：顶栏“画布 / 导图 / 图案”（内部 `canvas:mode` 仍只支持 `normal` / `mindmap` / `decor`；旧 `pro` / `edit` 读取时迁移为 `normal`）以及不持久化为模式的临时“工具”入口、节点矩阵上次成功使用的结构设置 `canvas:nodeMatrixDefaults:v1`（行列、类型、内容模式、编号、间距和宽度，不保存粘贴正文）、笔记坞导图上次使用的样式与布局 `canvas:notebookMindmapDefaults:v1`、任务簿归档完成副本开关 `canvas:taskbookArchiveSnapshotEnabled`（默认开启，仅显式 `'0'` 关闭）、AI 助手宽度 `canvas:ai-panel-width:v1`（桌面默认 520px、从左边缘拖动并记住，窄窗口仅临时夹紧且不覆盖偏好，≤640px 改为全屏侧栏）、全应用中英语言偏好 `canvas:toolbarLanguage`（由 `i18n.js` 在起始页、学习、活跃、日历、复习、专注与编辑器间共用；只翻译界面，不翻译文件名、任务名、便签、日记和画布内容）、首次语言确认 `canvas:initialLanguageChosen:v1`（只在全新用户第一次打开新画布且既无语言偏好也无引导状态时写入 `zh-CN` / `en`）、新手引导状态 `canvas:editorOnboarding:v2`（`in-progress` / `completed` / `skipped`）、三种模式各自的 `canvas:normalSubmode` / `canvas:mindmapSubmode` / `canvas:decorSubmode` 双模式偏好、右侧面板最后一次 Tab 收放选择 `canvas:sidePanelsCollapsed`（主编辑器全局共用，内嵌编辑器不读取也不改写）、镜头册浮窗位置 `canvas:sceneBookPanelPosition:v1`（仅桌面宽屏读取和更新；固定尺寸不随镜头数量变化，窗口尺寸变化时夹回可视区）、底部文字属性带的全局收起偏好 `canvas:textToolbarCollapsed`（未设置时默认收起；显式 `'0'` 展开、`'1'` 收起）、普通画布属性检查器开关 `canvas:inspectorEnabled`、导图属性检查器开关 `canvas:mindmapInspectorEnabled`、图案属性检查器开关 `canvas:decorInspectorEnabled`（三个独立偏好；画布与图案默认开启，导图默认关闭）、文本框拖动自动对齐开关 `canvas:textSnapEnabled`（默认关闭，仅显式 `'1'` 开启）、完整画布模式的 `canvas:proNodeDefaults` / `canvas:proEdgeDefaults` 与简洁画布模式独立的 `canvas:cleanNodeDefaults` / `canvas:cleanEdgeDefaults` 新建默认、文本框新建默认 `canvas:textDefaults` 以及共享柔和色栏镜像保存的高光/字色 `canvas:textHighlightColor` / `canvas:textInlineColor`、自动保存、暗色连线优化、平移/缩放/读者透明度、索引/脑图悬停延迟等。右下角设置面板标题栏提供常驻的小型黑白“恢复默认”入口，确认步骤使用不占面板高度的悬浮卡；操作只清除该面板负责的显式偏好并即时恢复出厂值，界面语言、画布内容、新手引导和其他编辑器偏好不受影响。设置面板会拦截自身的滚轮事件冒泡，面板内滚动不得触发底层画布缩放。
- 双屏画布的打开状态、右侧来源、结构化剪贴板和拖拽宽度只存在当前编辑器会话里，不写 `localStorage`、`sessionStorage` 或 `.canvas`；关闭双屏后主画布恢复正常 flex 宽度。
- 双屏与“导入画布”共用当前编辑器会话内的受管画布目录缓存和进行中请求；主画布就绪后只在浏览器空闲时预读标题元数据，不预读完整画布。参考列表每次打开先立即复用缓存与既有 DOM，再静默刷新；响应签名没有变化时不重绘，快速开关也不重复请求。列表每次打开仍重播约 300ms、总尾长约 450ms 的 opacity/transform 错峰动画，低动态模式关闭动画。关闭双屏继续保留当前参考 iframe，切换来源只在交叉过渡期间同时保留新旧两帧，结束后删除旧帧，禁止常驻预载多张完整画布。
- 右下角设置面板使用高不透明度纸白/墨黑表面，不运行持续背景模糊；开合、恢复确认和完成反馈都是一次有限过渡，“已恢复”在同一按钮槽位交叉替换，不得与恢复按钮叠字。
- 右下角设置面板的“视图”区只保留“定位最近节点”和对应空格键开关；已删除独立的偏好缩放比例与“偏好缩放并居中”，正常滚轮缩放、左下角实时缩放读数和画布视口保存不受影响。
- 笔记坞顶栏快捷入口偏好使用 `canvas:notebookTopbarShortcut`，未设置时默认关闭；开启后在“工具 / Tools”右侧显示“笔记 / Notes”，取消后立即隐藏。它只是一项全局编辑器 UI 偏好，不写入 `.canvas`。
- 任务簿顶栏快捷入口偏好使用 `canvas:taskbookTopbarShortcut`，未设置时默认关闭；开启后显示“任务 / Tasks”，取消后立即隐藏。叶子任务悬停计时按钮偏好使用 `canvas:taskbookLeafTimerButtonsEnabled`，默认开启，仅显式 `'0'` 隐藏画布节点左侧的 `▶ / Ⅱ`，不影响顶级任务卡片、计时状态或任务数据。两者与任务簿归档副本偏好相互独立，均不写入 `.canvas`。
- 空白框选创建盒子与框选节点创建分组分别由 `canvas:boxCreateEnabled` / `canvas:groupCreateEnabled` 控制，两个开关默认开启且彼此独立；`canvas:genIndexEnabled` 也必须独立判断，不能因关闭盒子或分组而隐藏框选生成索引入口。
- 学习页两种视图共用 `study:taskPage:v1` 记住当前数字任务页，缺失或非法时为第 1 页。右侧页栏按可用高度提供虚拟空页，有内容、已染色或当前选中的高编号页在缩窗后仍可通过隐藏滚动条的滚动区访问；页号右键复用学习页 12 色调色盘，颜色用 `study:taskPageColors:v1` 的 `{version:1,colors:{页码:"#rrggbb"}}` 保存在 `localStorage`，只接受共享色库中的非空颜色，默认色不保存且不写入 `study.json`。有颜色的当前页滑块采用页色，无颜色时保持原有黑白主题滑块。完整进度标题右侧空白可双击编辑当前页的可选单行说明，空说明不显示提示或占位。
- 速记、学习、复习、专注各自有视图偏好和临时运行状态；专注页使用 `focus:viewMode` 记住 `timer` / `daily`，未保存偏好或偏好值无效时默认 `daily`（每日任务）。学习页使用 `study:viewMode:v2` 记住 `list` / `progress`，未保存偏好或偏好值无效时默认 `list`（极简清单）；再次点击“学”切换视图。极简清单按 `To Do / Done` 分组，保留快速新建、改名、完成、回收、同状态拖拽排序和归档。完整进度视图为未完成/已完成双列，并提供不复制任务数据、始终覆盖显示且不参与主布局的非模态临时任务浮层；浮层开合只存在当前会话，成员引用跨重启保存在 `temporaryTaskIds[]`。两种学习视图都能打开同一套多目标树路线；从任务设置点击“在树中查看”会切换并持久化到实际包含该任务的目标树，关闭路线面板后把键盘焦点还给原入口。活动树由 `data/study.json` 的 `activeTreeId` 持久化，每棵树的相机与折叠阶段 ID 通过 `relatum.goal-tree-route.view.<treeId>` 独立保存在 `localStorage`；路线面板打开期间窗口尺寸变化只按新旧视口尺寸差补偿平移，以保持原画面中心和缩放，不自动执行全树适配。弹层、拖拽和“下一步”循环位置只存在当前会话。任务点若仍被任一目标树解锁条件引用，学习任务更新接口会拒绝删除并保留原任务与依赖。`canvas:studyGoalTreeSimpleMode:v1` 控制目标树高级解锁编辑，未设置时默认精简，仅显式 `'0'` 显示解锁条件入口、添加解锁条件和阶段到任务/任务点的高级拖放；新建后续任务与新建后续阶段始终可用，切换不改目标树数据。完整视图右上角 4 个圆角色块是颜色图例，右键/Enter 调色，用 `study:legend:v1`（`{version:1,colors:[4 个 #rrggbb]}`）保存在 `localStorage`，损坏或非法值回退 4 个「无」空位（斜纹格），≤700px 隐藏，不写入 study.json。每日任务完成页另用 `focus:dailyReviewedDate` 记住当天是否已经点击“回顾今日”（本地日期变化或当天撤销任一任务后失效）。起始文档解析时会预载 `focus.js`，并行读取 `/api/daily` 与 `/api/focus`；`focus.js` 不读取学习任务，先填好隐藏 DOM，再发布 `CanvasFocus` 和 `canvasfocus:ready`。年度足迹使用 `canvas:cadenceLens:v2` 记住 `canvas` / `complete` / `focus`，没有 v2 偏好时默认“画布”；复习方式使用 `canvas:reviewMode:v1` 记住 `scheduled` / `free`。
- 独立树状页沿用目标树镜头格式，每棵树的相机与折叠节点只用 `relatum.tree-page.view.<treeId>` 保存；首次进入恢复当前树已保存的镜头，再次点击已激活的树状页书脊图标则复用“适应”算法，把当前可见树完整居中并保存新镜头。多树活动项保存在 `tree-page.json`，目标树内部“下一步”循环位置、结构拖拽和浮层均为当前会话状态。根节点百分比使用固定 4ch 左对齐数字槽：两位数从左起排，到 `100%` 时第三位只向右占用预留位，标题起点不移动。两页共用 `canvas:studyGoalTreeSimpleMode:v1`，但树状页不加入跨页便签、活跃统计或学习归档。
- `sessionStorage` 的 `canvas:route-from-start` 用于从起步页进入编辑器后的返回/过渡体验。

不要把这些偏好混进 `.canvas`，除非用户明确要求改变持久化设计。

## 5. 后端路由总览

### GET

- 运行时与首页：`/api/runtime`、`/api/recent`
- Markdown 笔记库：`/api/notes-tree` 返回隐藏伴生目录的嵌套树；`/api/note?path=` 只返回正文与强修订号；`/api/note-links?path=` 按需返回出链/反链；`/api/note-history?path=&version=` 读取恢复历史；`/api/note-asset?note=&src=` 只流式返回库内授权栅格图片。
- AI 配置安全视图：`/api/ai-config`
- 学习/活跃：`/api/study`、`/api/study-activity`；`/api/study` 只返回 v6 学习任务、回收站、`goalTrees[]` 与 `activeTreeId`，不再返回单树 `goalTree` 别名或读取目标树归档；活跃接口保留完成/专注数据，并返回 `canvasDays`、`canvasEntries`、`canvasStats`、`canvasGraph`、`canvasOverviewGraph` 与三页汇总 `startPageStats`，年份是画布、三页计时、完成归档和专注记录的并集。
- 独立树状页：`/api/tree-page`；缺失文件或旧实验 v1 返回稳定 ID 的未落盘空白 v2，损坏或其他非 v2 文件返回明确错误且不覆盖原件。
- 复习：`/api/review-pool`、`/api/review-cards`
- 速记/跨页便签/专注/每日任务：`/api/notes`、`/api/start-sticky-notes`、`/api/focus`、`/api/daily`
- 日历与倒数日：`/api/calendar`、`/api/countdown`
- 模板：`/api/templates`
- 生涯报告：`/api/career-report` 只读取已有 `data/career-report.json` 冻结快照；不存在时返回 `{version:1, exists:false}`，普通读取不扫描业务文件。
- 画布和资源读取：`/api/load`、`/api/background-image`、`/api/canvas-asset`、`/api/canvas-annotation`、`/api/node-annotations`、`/api/background-preference`
- 内部画布内容导入：`/api/canvas-import-library` 只列出最近索引中有效的顶层 `canvases/*.canvas`，`/api/canvas-import-source` 通过不透明文件 ID 读取并预检来源；双屏右侧打开使用 `/api/canvas-dual-open` 一次返回同一安全来源的 `data`、路径、标题和 revision，并拒绝当前画布；这些接口都不接受客户端来源路径，也不刷新来源最近时间或视口

### POST

- 生涯报告：`/api/career-report-generate` 无筛选参数，读取全部可用历史并在完整成功后原子替换快照；单项数据源损坏会进入来源状态而不中断其余统计，整体写入失败会保留旧快照。
- Markdown 笔记库：`/api/note-create`、`/api/note-save`、`/api/note-move`、`/api/note-trash`、`/api/note-upload-image`、`/api/note-history-restore`、`/api/note-import-begin|upload|commit|abort`、`/api/note-reveal`、`/api/note-reveal-assets`。`note-trash` 只校验库内精确目标并交给 Windows 系统回收站；`note-reveal` 接受空路径打开根目录，文件路径会在 Explorer 中被选中。
- 画布文件：`/api/new`、`/api/open`、`/api/pick`、`/api/save`、`/api/remove`、`/api/rename`、`/api/clean-assets`
- 分组/收藏/排序与画布库维护：`/api/group-create`、`/api/group-rename`、`/api/group-delete`、`/api/file-set-group`、`/api/favorite-toggle`、`/api/groups-reorder`、`/api/reorder-files`、`/api/file-stats`、`/api/recent-sync`
- 回收站：`/api/trash`、`/api/trash-list`、`/api/trash-empty`、`/api/restore`
- 文件系统交互：`/api/reveal`、`/api/open-external`、`/api/open-attachment`
- 导入导出：`/api/export-markdown`、`/api/export-png`、`/api/import-markdown`、`/api/import-canvas`（起步页拖入内容导入）、`/api/import-canvas-file`（原生单画布复制导入）、`/api/import-canvas-folder`（原生严格文件夹导入）、`/api/canvas-import-assets`（编辑器内部内容导入的受管素材复制）
- 背景/图片/附件：`/api/pick-background-image`、`/api/upload-background-image`、`/api/import-canvas-image`、`/api/upload-canvas-image`、`/api/upload-canvas-attachment`
- 批注与视口：`/api/save-canvas-annotation`、`/api/save-node-annotations`、`/api/background-preference`、`/api/viewport`
- 学习任务：`/api/study-task-create`、`/api/study-task-update`、`/api/study-task-progress`、`/api/study-temporary-update`、`/api/study-task-trash`、`/api/study-task-restore`、`/api/study-task-delete`、`/api/study-trash-empty`、`/api/study-archive-done`、`/api/study-reorder`；临时任务接口接收 `{id,included}` 并只允许加入现存未完成任务；目标树发出的 update/progress 可携带 `goalTreeId`，后端据此拒绝未解锁任务的完成和进度写入，普通学习清单不携带该字段。`/api/study-goal-tree-command` 的节点命令统一接收 `primaryLink`，并提供 `add-requirement` / `remove-requirement` / `clear-primary-requirement` 管理解锁条件。
- 独立树状页：`/api/tree-page-command`；命令语义对齐 `/api/study-goal-tree-command` 的建树/切树/删树、阶段与任务创建更新、进度/完成/任务点、折叠和结构/依赖移动，另有永久 `delete-task` 及根/阶段/任务外观。明确拒绝 `attach-task` / `detach-task`，每个任务必须唯一归属；删除任务、阶段或树级联清理任务记录和依赖。后端继续执行目标树的 ID、链接、循环、任务点、层数和数量校验。
- 跨功能：`/api/archive-canvas`、`/api/taskbook-archive`
- 复习：`/api/review-card-create`、`/api/review-card-update`、`/api/review-card-delete`、`/api/review-cards-batch`、`/api/review-cards-batch-delete`、`/api/review-deck-create`、`/api/review-deck-update`、`/api/review-deck-delete`、`/api/review-settings`、`/api/review-mark`
- 速记、跨页便签和模板：`/api/notes-save`、`/api/notes-archive`、`/api/start-sticky-notes-save`、`/api/templates-save`
- 专注：`/api/focus-log`、`/api/focus-session-update`、`/api/focus-session-delete`
- 画布活动：`/api/canvas-activity` 接收已授权画布、会话 ID 与前台时间段；校验后按本地午夜拆分、与既有区间取并集，再返回本画布今日及累计秒数。
- 起步页活动：`/api/start-page-activity` 只接受 `study` / `tree` / `notes`、会话 ID 与前台时间段；按画布计时相同的时长上限、本地午夜拆分和区间合并规则写入独立账本，再返回该页今日及累计秒数。
- 每日任务：`/api/daily-create`、`/api/daily-update`、`/api/daily-delete`、`/api/daily-toggle`、`/api/daily-add-minutes`、`/api/daily-reorder`、`/api/daily-group-create`、`/api/daily-group-update`、`/api/daily-group-delete`、`/api/daily-tree`
- 日历：`/api/diary-save`、`/api/diary-delete`、`/api/countdown-save`
- AI：`/api/ai-chat`、`/api/ai-plan`、`/api/ai-test`、`/api/ai-config`

### HTTP 与并发边界

- JSON 请求体硬上限是 160MiB；超过 8MiB 的 JSON 同一时刻只接纳一个，保存时走流式原子 JSON 编码；图片/附件仍各自执行 40MiB / 100MiB 的解码后限制。Base64 协议会产生高于请求体大小的瞬时内存峰值，不要把 160MiB 误解成进程内存上限。
- 画布资源读取由 `_send_local_file` 分块发送并支持单段 `Range`，不要重新改成 `read_bytes()` 整文件进内存。
- 小型 `data/*.json` 读改写与画布/附件文件操作使用两把进程内锁；跨两类数据的路由固定先拿画布锁、再拿数据锁。不要倒置锁顺序，也不要让原生选择器打开期间持锁。
- 笔记写操作使用独立 `NOTES_MUTATION_LOCK`，同时进入现有跨进程写锁；资源管理器打开接口不在持锁期间等待 Explorer。笔记正文和图片沿用同目录唯一临时文件 + `os.replace`，不要改成固定 `.tmp`。
- 视口状态 `data/viewport.json` 最多保留 500 张画布记录，写入时按 `updatedAt` 淘汰旧项，避免长期使用后无界增长。
- Windows 上，共用同一 `ROOT` 的多个 Relatum 服务还会通过命名互斥锁串行化写操作，避免两个实例把同一份 JSON 相互覆盖；进程内仍使用上述两把细分锁。非 Windows 源码运行目前只有进程内锁，不要误写成全平台单实例机制。

## 6. 画布编辑器契约

### 前台使用时间

- 主编辑器和学习页内嵌编辑器在画布完成初始化后开始累计当前画布前台时间；页面可见且窗口有焦点时持续计时，不设键鼠闲置超时。`blur`、页面隐藏、`pagehide`、离开或关闭时立即暂停并用 keepalive 结算，恢复前台后开启新时间段；平时每 30 秒向 `/api/canvas-activity` 提交增量，异常退出最多损失一个心跳周期。双屏只读参考查看器不单独计时。累计时长不占用编辑器顶栏，起步页“最近 / 收藏 / 分组”画布卡片只在悬停、键盘聚焦或键盘选中时于右下侧显示该画布累计前台时长。
- 时间段由后端按会话 ID 接收并合并取并集；重复心跳、重试和多个窗口的重叠区间不得重复累计。新建、导入、保存只登记创建/修改事件，不按自动保存次数增加热力图时长；Relatum 内重命名、移入回收站和恢复要迁移同一账本身份。

### 首次使用引导

- 起步页新建画布传入 `fresh=1`，编辑器背景、画布与顶栏完全就位后，只在 `canvas:editorOnboarding:v2` 未设置时进入首次引导流程；内嵌学习页编辑器不触发。全新用户同时缺少 `canvas:initialLanguageChosen:v1` 和 `canvas:toolbarLanguage` 时，先显示独立的双语语言选择纸页，按系统语言轻量标注建议项，用户点击中文或 English 后立即保存全应用语言并进入原有十一页引导；语言选择不计入教程页数。已有语言偏好者直接沿用，已有引导状态的升级用户完全不弹语言选择，避免打扰老用户。
- 浮窗只讲编辑器核心：创建内容、连接想法、平移/缩放、画布、导图、图案、右侧面板的 `Tab` 收放与手电筒熄灭、空白处右键拖动创建纯色色块、选中节点后按 `F` 打开放大阅读、框选节点后通过右下角“+ 分组”创建语义分组，以及进入真实画布的四步练习。四步依次要求创建一个新节点、让任意内容节点的文字发生变化、再创建一个新节点、按住 `Alt` 完成一条新的节点间连线；连线可以落到画布上的任意其他节点，不强制连接教程追踪的两个节点。三种模式各占一页；导图演示固定按“旧线退场 → 节点排版并换样式 → 重绘终态连线”的顺序执行，避免节点移动时连线乱飞。起步页学习/日历/速记等不进首次引导。
- CSS 演示进页自动播放一次后停在终态，可手动重播；不使用常驻模糊，并在 `prefers-reduced-motion` 下改为静态终态。创建页卡片内的标题线固定最终宽度并通过 `scaleX` 连续展开，不使用离散 `steps()` 或直接动画 `width`。连接页的三个节点必须从第一帧就存在，动画只演示按住 `Alt` 从左侧节点依次连向两个已有节点；`Tab` / `Enter` 只留在说明文字中，不能让右侧节点以“快捷键创建”的方式入场。面板页先用两次 `Tab` 演示收起与展开，再点击右上角手电筒把面板熄灭到近乎透明，低动态模式直接显示熄灭终态。画布模式页不展示虚构的左侧滑条工具，改为演示右键节点弹出调色板并选色；各模式演示的 SVG 连线端点要轻微伸入节点底层，不能在节点边框前留下白缝。深色画布使用高不透明度墨绿黑表面。
- 真实练习按“新节点数量、任意内容节点文字发生变化、第二个新节点、新增任意节点间连线”依次推进；判定应允许用户偏离呼吸光圈、编辑已有节点或另一个新节点、把连线落到其他节点，只确认相应动作是否真实发生。点击完成卡片的“知道了”后，编辑器右下角“？”只播放一次有限的绿色荧光提示，随后恢复静止。该“？”快捷键面板顶部使用墨绿色主按钮重播完整引导；面板保留滚轮/触控板滚动，但隐藏浏览器原生竖向滚动条。速查内容必须使用“画布 / 导图 / 图案”和“简洁 / 完整”的现行名称，并覆盖框选分组、右键拖色块、附件阅读批注、独立表格的选区与行列删除、模式子状态、右栏 Tab 收放等当前行为，不能重新出现旧“普通 / 正常”叫法。该面板也是中英界面的一部分：英文模式下，标题、操作说明、Markdown 示例与无障碍标签都由 `i18n.js` 翻译，不得混留中文界面文案。

### 坐标与视口

- 屏幕坐标转画布坐标只能走 `canvas.js` 的 `clientToSurface(clientX, clientY)`。不要在新代码里手写 `(client - pan) / scale`。
- 双击普通内容节点或文字框进入编辑时，光标落在双击对应的文字位置，不默认全选全文；键盘进入编辑仍沿用各自既有的选区规则。
- 视口由 `curPan/curScale` 与目标值驱动，保存到 `/api/viewport`。
- 改动缩放、平移、定位、脑图、框选、拖拽、附件放置时，优先复用已有坐标工具函数。
- 空格平移的光标是全局瞬时状态：按住空格但尚未拖动时，画布及其节点/连线统一显示开放抓手 `grab`；拖动期间显示闭合抓手 `grabbing`。它必须覆盖当前绘图工具的十字光标和对象自身光标，松开、鼠标抬起或窗口失焦后必须恢复，不能残留平移态。
- 连线名称与选中锚点必须共用 SVG 真实路径的半程点，不能拿控制折线中点代替；选中锚点使用菱形，可拖拐点使用圆形。修改路径、节点拖动、导出或 Canvas/SVG 双渲染时要保持两者坐标一致。
- 普通内容节点的新建基础最小宽度与左右尺寸手柄的硬下限统一为 `80px`；每次横向手势开始时会在不改数据的前提下测量节点的自动宽度，并在最多 `120px` 范围内把短标题的自然宽度作为本次拖拽下限，所以空卡片写入显式 `width` 后仍能缩回刚创建时的紧凑单行尺寸，长标题仍可继续压窄换行。脑图继续使用自己的 `72px` 下限与预设尺寸，双击尺寸手柄继续恢复自动宽度。
- 顶栏模式目前显示为“画布 / 导图 / 图案”（英文偏好下为 “Canvas / Mind Map / Shapes”，内部值仍是 `normal` / `mindmap` / `decor`）。编辑器右下角齿轮与起始页客户端设置都可切换中英语言，偏好键是 `canvas:toolbarLanguage`；`i18n.js` 负责起始页各功能页与编辑器的共用界面文案，文件名、任务名、便签、日记和画布内容保持原文。右下角 `fx`、齿轮和 `?` 三个入口始终固定在画布角落，不随右侧面板展开向左避让；右栏层级更高，展开时允许直接覆盖这些入口。三个模式按钮都可在当前模式下重复点击，在各自独立记忆的 `full` / `clean` 子模式间切换；切到其他模式时恢复该模式上次子模式。缺少偏好数据时，画布与导图默认 `clean`，图案默认 `full`；已有 `canvas:*Submode` 偏好始终优先。移动胶囊与下沿短线在浅色界面统一纯黑、深色沉浸界面统一纯白，不再用三档灰色区分模式；`full` 常驻短线，`clean` 离开按钮组时隐藏短线，鼠标悬停或键盘聚焦任一模式时短线必须出现并跟随预览位置，离开后恢复当前模式与子模式对应的显示规则。`full` 允许属性检查器随选择出现，`clean` 隐藏顶栏动作区且禁止属性检查器，但导图/图案自身的模式面板仍保留；内嵌编辑器例外，强制完整画布模式以保留编辑能力。完整画布模式常驻大型“新建样式”面板，支持类型、形状、配色、透明度、整体缩放、圆角、字重、文字比例/对齐以及完整线条默认；选中对象时自动切为属性检查器，清选后自动回到新建样式，两者不再提供重复的手动页签。简洁画布模式显示卡片/便签高频入口与独立“样式”面板；该面板不切换 `full`，支持索引、预览、卡片、便签、代码五种节点类型、三种形状、节点外观和连线默认，使用独立 clean 默认键。连线线型以三列两行显示：第一行是曲线、枝桠曲线、S 曲线，第二行是圆角折线、直线、自然曲线；折线、平滑曲线与弧线仍只在完整模式提供。无单选时，简洁“样式”面板编辑之后的新建默认；单选一个内容节点时，同一组节点控件改为读取并直接编辑所选节点，类型按钮执行内容安全迁移，清除或形成非单选后立即回到默认值；连线区始终编辑 clean 新建默认。面板保持打开以便用户在选择与默认语义间切换，不因此进入 `full` 或启用属性检查器。画布全局快捷键中，`1` 始终回到选择工具，主键区 `Shift+1` 进入文本框工具，`2` 在画笔与橡皮间切换；长按产生的重复事件不再次切换。简洁与完整画布统一使用 `3/4/5/6/7` 切换接下来新建的卡片/便签/索引/预览/代码默认类型，即使已有单选也不转换现有节点。画布按下期间的选择变化要等本次 click/drag 完成后再移动检查器，禁止侧栏在 `mousedown` 与 `mouseup` 之间抢走指针。未激活面板使用 `transform` / `opacity` / 延迟 `visibility` 完成退场，期间容器和子控件都必须禁止命中；不能用 `display:none` 截断过渡动画。属性检查器出现时优先占用当前右栏并让导图排版面板退场，清除选择后导图面板自动恢复；Tab 仍控制当前唯一右栏的收起/展开，模式切换、延迟打开检查器和 Tab 折叠状态必须同步闭环。导图模式复用 `applyMindmap` 排版和滑行动画，提供 10 套按结构效果命名的预设，并允许覆盖线型/线条样式。单选时作用于与该节点相连的整张结构，多选时只作用于所选节点；保持既有左右分支和按层级区分节点大小均为自动行为，不再暴露开关。`applyMindmap` 支持跟随分支、稳定均衡左右布局、层距/分支距/放射半径参数；`alignMindmapLevels` 只修正层级轴并保留用户手排的同层顺序。导图模式下 Tab 新建会沿当前分支方向继续向外生长，并继承当前预设的节点尺寸、颜色、线型和线条样式。
- 顶栏“工具 / Tools”与三个模式按钮共用同一个分段控件外壳和按钮基础样式，但仍是临时入口：不写 `canvas:mode`，没有 `data-mode`，也没有简洁/完整子模式。工具菜单当前依次提供尺子、“笔记坞”、“镜头册”、“任务簿”、“导入画布”、“双屏”、“节点矩阵”和“倒计时 / 正计时”；展开层使用单一不透明表面与八行紧凑命令，不再为每项套独立卡片。双屏采用左右可调分屏，右侧由 `dual-viewer.html` 打开另一张 recent 管理的顶层画布，只允许选择、框选、平移和缩放；双屏打开时图片、纯色、渐变和流动背景只由父页共享层跨左右区域绘制，主画布与参考 iframe 透明承载内容，避免同一图片按两侧容器重复 `cover`，辅助底纹仍由两侧各自按画布坐标绘制。右侧始终镜像主画布当前的全局背景、深浅语义和辅助底纹，搜索浮层单击结果即切换，切换失败时保留旧画布。搜索器使用不随加载/结果/空状态改变的固定外框，标题、搜索框、列表区、提示与首屏结果依次错峰入场；底部常驻平台对应的复制/粘贴快捷键提示，文件列表隐藏 Windows/WebView2 原生轨道和箭头，改用仅在滚动、悬停、聚焦或拖动时出现的独立细滑块；高对比度强制颜色模式恢复系统滚动条。双屏开合、搜索器进退场、参考画布交叉切换和控件反馈只使用一次有限的 opacity/transform 过渡，拖动分隔线本身不增加缓动，`prefers-reduced-motion` 下立即切换。主画布与参考查看器都通过 viewport `ResizeObserver` 在分屏开合或拖宽后按动画帧重绘 Canvas 连线层，禁止继续依赖只在窗口整体变化时触发的 `window.resize`。数据只从右向左：右侧 `Ctrl/Cmd+C`、左侧 `Ctrl/Cmd+V` 通过会话标记粘贴结构化选区，右键“复制到主画布”提供一步式鼠标入口；右侧不编辑、不保存，也不存在方向按钮或 `Ctrl+Shift+D`。选区快照排除任务簿投影、尺子、计时器和手写，只保留两端都在选区内的普通连线；粘贴前使用 source ID 与 revision 校验来源并通过受管接口复制素材。整套工具 UI（入口、笔记坞、镜头册、任务簿、导入/双屏/矩阵/计时器弹层、尺子角度浮窗及画布实体）统一使用纯白/石墨黑和中性灰，深色语义下黑白反转；除错误与删除外不使用绿色、米黄或琥珀色，也不使用持续 `backdrop-filter`。工具菜单、配置弹层和尺子角度浮窗使用一次有限的遮罩淡入/淡出、轻微上浮与缩放过渡，退场完成后才恢复 `hidden`；按钮只使用短促的悬停、按下与主操作抬升反馈，`prefers-reduced-motion` 下全部立即切换。尺子每张画布最多一把，点击会在可见区域中心以 `90°` 放置新尺子，或定位已有尺子并回到该画布上次子模式；`90°` 时删除按钮位于屏幕右上角。拖尺身移动、拖中央角度环旋转，`Shift` 按 15° 吸附；右键尺身会打开角度浮窗，可选 `0/30/45/60/90/120/135/150°` 或输入任意整数，提交后归一化到 `[0,360)`。画笔激活时右键尺身仍能打开浮窗且不切换画笔；`×` / `Delete` / 工具面板均可移除，放置、移动、旋转、精确设角与删除都进入画布历史。
- “镜头册 / Scenes”是非模态画布取景工具。固定镜头记录扣除镜头栏后的安全可见区中心和缩放；跟随镜头绑定节点、连线端点或语义分组，回访时按内容最新位置取景，全部引用缺失才退回创建时的备用相机。镜头栏宽屏使用固定宽度和固定视口比例高度，镜头数量只让内部列表滚动；可从标题栏拖到可视区任意位置并用 `canvas:sceneBookPanelPosition:v1` 记住坐标，靠近左右边缘 24px 内实时磁吸，双击标题栏清除位置偏好并短促回到默认位置。移到画布右半侧后安全取景区也改从右侧扣除。窄屏仍为不可移动的底部抽屉。缩略图只按共享节点/连线几何绘制黑白轮廓，不保存截图或加载图片。镜头卡显示随 DOM 顺序实时更新的两位序号，当前镜头用序号前的小圆点、细描边与 `aria-current` 同步标记。排序必须使用与笔记坞相同的约 6px Pointer Events 阈值、插入前完成定位且关闭 transition 的实色幽灵卡、实时 DOM 占位、可中断且按距离调时的 FLIP 让位、渐进边缘滚动和 WAAPI 落位交接；禁止 `draggable`、`DataTransfer` 和原生 `drop`，真实源卡只隐藏但保留布局，幽灵卡移入 `body` 后必须显式继承镜头栏表面变量。只有最终顺序变化才写一次 dirty。点击镜头只移动相机，不改变模式、子模式或选区。演示模式隐藏编辑 UI 并锁节点创建/选择/编辑/拖动/删除，但保留背景平移与滚轮缩放；控制条最左侧的环形箭头直接回到序号 01，位于第一个镜头时禁用；方向键、PageUp/Down、Space、Home/End 导航，Esc 退出并把焦点交还画布视口，快速导航只重定向当前相机动画。
- “任务簿 / Taskbook”只是所有顶级任务的管理入口，不是画布对象或日历排程。入口使用与笔记坞一致的 `1320×840px` 响应式固定工作室，列表数量变化不得改变外框尺寸；列表保留滚轮/触控板滚动但隐藏原生滚动条。标题旁的圆形“？”打开一张不透明的新手说明卡，简要覆盖新建与放置、连线收为子任务、叶子计时、双击或按 `F` 进入管理页、完成归档以及隐藏与删除的区别；再次点击、点说明卡外或按 Esc 只关闭说明卡。标题栏复选框可按本地偏好把“任务 / Tasks”快捷入口加到编辑器顶栏。右上角“+”只新建记录，不自动落到画布。顶级任务保持创建顺序，不支持拖动；行内只显示标题、叶子进度、实际用时、“放到画布 / 定位 / 归档”主操作与独立删除按钮，不得恢复拖动手柄、三点菜单、行内计时或完成按钮；删除复用任务簿自定义确认层，普通成员节点保留并解除管理。用户通过“放到画布”创建唯一 `task-root` 投影，已有投影时同一操作改为定位；投影悬停 `×` 会把投影、全部成员节点及所有相邻连线一起从画布视觉上隐藏，节点位置、任务树、累计时间和普通连线数据仍保留，再次“放到画布”后恢复整棵树。双击投影或选中后按 `F` 打开独立全高管理页；页内非文字输入焦点再次按 `F` 可直接退出，Esc 同样关闭并把焦点交还画布视口。
- 管理页以纵向任务树为核心，打开即选择根任务；顶栏只保留返回、标题、进度、总用时和开始/暂停。根行悬停“+”创建一级任务，普通行悬停“+”创建子任务，Enter 建同级、Tab/Shift+Tab 调层级；不支持鼠标拖动、幽灵行或三点菜单。详情只显示名称、Markdown 说明、实际用时、开始/暂停和定位，窄屏自然落为底部详情抽屉，不增加分段按钮；选中已完成根任务时在详情底部显示“归档这个顶级任务”，与任务簿完成列表共用同一确认文案、归档事务和失败处理，成功后返回任务簿列表；任务/子树删除走行内入口与自定义确认。顶级任务投影与未受管卡片/预览相连、或受管节点与未受管节点相连时，不论拖线方向，分别收录为一级任务或子任务；多选节点一起向同一个投影或受管父节点拖线时，所有合法的未受管节点必须在一次提交中全部收录，若同一手势会造成多父级歧义则只采用实际发起父级。内部始终规范为父→子枝桠曲线、末端单向箭头、中性灰 1.5px 实线。同树两个已受管节点或跨树节点间的新连线保持普通连线，改父级只允许键盘操作。受管节点允许在画布通过节点“×”或 Delete 删除：父节点按整棵子树删除，空白无计时叶子直接执行，有子项、历史用时或活动计时则走确认；活动段先结算，历史计时段继续留在顶级任务 `sessions` 中，整个事务只提交一次历史和一次工作流重建。任务工作流边仍禁止脱离任务结构单独删除；受管节点继续禁止剪切、转换、归档或转为学习任务，投影本身允许移除。
- 只有叶子计入进度；无子项时顶级任务自身是可执行叶子，新增子项会把已完成父项恢复为汇总状态。父任务不能手动勾选，也不保存 `strike`；当其全部后代叶子完成时，画布节点与管理树自动显示只读的删除线和淡化汇总态，任一叶子恢复未完成或新增未完成子项后立即取消。受管叶子节点悬停时在左侧显示精确计时按钮，`▶` 启动该节点、`Ⅱ` 暂停，父任务不显示，完成叶子禁用；按钮不因选中或运行而常驻。所有叶子完成后 root 自动进入“已完成”，顶级任务投影右上角用一次短促渐显显示绿色完成勾，动画结束后只保留静态 DOM，不运行循环动画或计时器；任一叶子取消完成或新增未完成子项后返回“进行中”并隐藏完成勾。全局同时只运行一个任务；切换时立即结算前一段，并通过 `/api/focus-log` 以稳定段 ID 幂等写入专注记录。完成顶级任务只能通过 `/api/taskbook-archive` 归档：后端在“画布锁 → 数据锁”内重新验证完成条件，用稳定 `archiveId` 幂等写入 `data/学习归档/<日期>+1项任务簿/taskbook.json` 并原子替换画布；活跃页每个 marker 只记一条任务簿来源记录，不重复累计专注时长。归档删除 root、原投影、全部受管原节点、相关连线与分组引用且不进入画布 Ctrl+Z；默认按 `canvas:taskbookArchiveSnapshotEnabled` 在原位置留下全新 ID、向右枝桠布局和末端单向箭头的普通节点副本，副本不携带任何任务归属。子节点统一保留删除线；根副本改为浅灰绿、非删除线的归档封面卡，正文显示本地化的归档状态、叶子进度和总用时，右上角保留静态绿色勾，并可继续按普通卡片编辑。已移除旧 `/api/taskbook-complete`、预算/估时、释放任务和“完成并沉淀”。旧的普通节点悬停任务清单、`node.checklist`、`canvas:showNodeChecklists` 与 `canvas:checklistDelay` 已删除，加载或导入时直接丢弃旧字段。
- 零成员的顶级任务在数据模型中视为唯一叶子；画布投影必须直接以 root 的真实 `members` 数组判定零成员，不能依赖可能暂含失效引用的派生任务数组。投影悬停、被选中或完成控件获焦时，左侧显示一个直属于投影节点的高对比空心完成圆圈；顶级任务投影必须在最终级联中覆盖旧 `.node.taskbook-node` 为 `overflow:visible`，否则外置圆钮会被圆角卡片裁掉。圆钮与卡片左缘留 4px 视觉间距，并用透明伪元素覆盖间距作为连续悬停桥；透明热区还要向圆钮上、下各扩展 8px，靠近圆钮边缘移动时不能闪退。点击后先结算本 root 的活动计时，再显式切换 `root.completed`，已完成态显示白色勾与绿色底。右上角常驻完成勾继续负责离开悬停后的状态反馈；再次点击左侧圆圈可恢复未完成。添加第一个成员时 `root.completed` 自动清零、圆圈立即退出，之后完成度只由成员叶子汇总。该入口不受“显示子任务悬停计时按钮”偏好影响。
- “笔记坞 / Notebook”在主编辑器中提供多页 Markdown 长期笔记、标题编辑、删除与拖动排序；桌面宽度采用左侧浅色浮起笔记栏 + 源码/预览双卡工作区 + 底部操作坞，窄窗口收为顶部笔记选择器和编辑/预览分段切换。浅色语义下，笔记坞拥有自己的乳白渐变遮罩和 `#fbfbfc` 近白工作台，不能改动其他工具共用的 `--tool-overlay`；标题区到工作台使用顶部圆角与白到近白的短渐变过渡。源码与预览卡片的标题条必须和正文共用纯白表面，底部分隔只能使用两端透明的低对比渐隐线，不得恢复贯穿整卡的灰条或硬实线；深色语义保留黑灰反转，但沿用相同的圆角和弱分隔结构。笔记排序只能从左侧点阵手柄发起，使用约 6px 阈值的 Pointer Events、自定义幽灵卡、实时 DOM 占位与可中断 FLIP 让位；不得恢复 `draggable` / `DataTransfer` 原生拖放。拖动与落位提交均不重建列表、不更新预览，落位直接复用已经排好的 DOM；只有顺序真实变化后才按最终 DOM 顺序写回一次 `notes[]`、局部同步窄屏选择器并标记一次 dirty。幽灵卡必须在插入 `body` 前完成初始定位，跟随阶段禁用自身和真实卡片的 CSS transition，由 WAAPI 独占位移；落位时先把表面、描边和阴影收敛为真实卡片的最终外观，再通过无过渡 `drag-handoff` 交接，禁止恢复焦点后首次拖动乱飞或最终显形闪烁。Esc、指针取消、窗口失焦和弹窗关闭恢复原顺序，长列表支持边缘滚动，低动态模式关闭抬升、让位和落位动画。删除必须使用笔记坞内部无模糊的 `alertdialog` 确认卡，明确已生成导图不受影响，并保留焦点圈定、Esc/遮罩取消、删除行收起与相邻内容补位；不得重新调用原生 `window.confirm`。生成按钮旁的“？”打开锚定说明卡，固定解释标题/列表/正文归属、独立快照和 200 节点上限，并直接复用当前 `parseOutline()` 结果展示节点数、层级与不可生成原因，不能另写第二套结构判断。标题和嵌套列表会被解析为导图层级，普通段落、引用、Callout、代码、公式和表格进入最近结构节点正文；任务列表标题转为可见 `☐/☑`。单次最多生成 200 个节点，样式复用 10 套现有脑图预设，布局支持左右平衡、向右、向左、向下和放射。生成通过 `CanvasModule.createMindmapFromOutline()` 一次创建、排版、选中和聚焦，只写一次历史与一次保存，随后切到导图模式；生成节点不保存笔记 ID 或来源行号，之后与笔记永不暗中同步。打开弹窗时通过 `CanvasModule.getSelectedMarkdownOutline()` 捕获选区，卡片/索引/预览/便签/代码/表格可一次追加回当前笔记，交叉结构退化为按位置排序的平级列表并提示，装饰/图片/附件/尺子/计时器忽略并计数。笔记源码输入只局部更新当前列表项，预览、帮助摘要与结构统计共用约 100ms 尾随调度和修订号丢弃过期异步结果；只有 `renderResult()` 报告真实公式或 Mermaid fence 时才启动对应离线运行时。新建、排序、删除、帮助与确认卡只使用一次有限的局部过渡，笔记页切换与源码输入都不触发整区动画，`prefers-reduced-motion` 下其余动画也立即切换。Enter 只续写无序、有序和任务列表或退出空列表项，不接管 Tab，不在输入法组合期间拦截；文本撤销仍使用浏览器原生历史，不进入画布 Ctrl+Z 历史。
- 笔记坞标题栏的“将笔记坞添加到编辑器顶栏”复选框即时控制上述快捷入口；快捷按钮必须保留 `data-action` / ARIA 钩子，但不得带 `data-mode`，点击只打开笔记坞。点击关闭按钮时焦点可归还触发入口；`Esc` 退出则不聚焦“笔记”或“工具”，避免顶栏按钮残留键盘焦点环。笔记坞打开期间由捕获阶段统一接管 `Esc`：拖拽、删除确认和帮助卡依次优先取消，均未打开时关闭整个笔记坞，不能依赖焦点仍留在弹窗内部。
- 尺子只在主编辑器的画布模式显示并生效，导图、图案与内嵌学习编辑器隐藏。节点障碍只接入 `card/index/preview/sticky/code` 的直接拖动；全部成员均合格且起点未与尺子物理重叠的多选才受约束，其他对象和布局链路绕过。扫掠碰撞阻止快速穿透并保留沿长边滑动；拖动开始后按 `Alt` 可让本次手势余下阶段穿过。画笔在任一长边 14 屏幕像素内起笔会立即沿边绘制；从远处自由起笔后，真实采样线段首次接触有限长边吸附带时会保留前半段、插入精确接触点，并把本次抬笔前的后续确认点与预测尾段锁到同一条尺边。预测点本身不能触发吸附；橡皮、箭头和手绘图形不受影响，画笔激活时尺子不接管指针。
- “导入画布”只从 Relatum 管理的内部画布库选择来源，不创建文件、不切换工作模式，也不接触起步页 `/api/import-canvas`。居中选择器复用最近、收藏、未分组和自定义分组语义，当前画布不列出；来源必须同时登记在 `recent.json`、物理位于顶层 `canvases/*.canvas` 且仍存在。纯导入层校验并深拷贝普通节点、表格、文字框、图案、语义分组、连线、手写笔画和自由箭头，重建全部 ID 与引用，再按节点和墨迹联合边界移动到当前视口中心。图片、PDF 与 Markdown 原文件按来源修订指纹复制到目标 `.assets` 并重写 `assetPath`，但不复制 `<asset>.annot.json`、`node-annotations.json`、尺子、背景、视口或其他画布级状态；任一素材失败时回滚本次文件复制且不提交可见内容。成功后选中全部新节点，只写一条历史并触发一次保存；撤销保留素材供重做和现有孤儿清理使用。编辑器不再读取资源管理器拖入的外部 `.canvas`，只提示从工具中的画布库导入；图片/PDF/Markdown 拖入与起步页外部导入为新画布保持原行为。
- “节点矩阵”是一次性普通节点生成器，不写新的 `.canvas` 字段或持久矩阵关系。面板支持 1–20 行、1–20 列且单批最多 100 个节点，类型限定为 `card/sticky/index/preview/code`；内容可为空、按行/按列连续编号，或按 Tab/换行粘贴二维文本并自动同步行列。间距可选紧凑 `24×20`、标准 `48×36`、宽松 `80×60` 画布单位或自定义，节点默认按真实内容测量后统一宽度，也可手工指定。确认前不切模式；成功时进入用户上次的画布子模式，把联合边界居中到当前视口并整体选中新节点，不建立连线或语义分组，只写一条历史和一次保存。
- “倒计时 / 正计时”在同一画布可保存多个固定尺寸实体，只在主编辑器画布模式显示；导图、图案和内嵌编辑器隐藏但当前会话继续计时。计时器拥有独立选择域，不能与节点、边或尺子混选；框选只命中计时器时可多选，但框内一旦接触任何可见普通对象就完全忽略计时器并沿用节点框选。多选“切换状态”对每个实体逐个取反，运行中的暂停、停止中的启动；创建、移动、编辑和删除进入历史，开始/暂停/复位/完成不进历史。保存前结算有效读数但不打断运行，重开后全部停止；计时器不进入 Markdown、PNG、模板、内容导入、AI、图谱、小地图或适配内容边界。
- 脑图预设只是外观，不可用颜色/尺寸反推节点是否属于脑图。完整套用脑图样式或排版时，中心节点写入可选字段 `mindmapRoot: true`，树边统一为 `parent → child`；同一连通结构只保留一个中心标记。脑图节点的持久外观由节点上的 `mindmap*` 字段决定，切到普通模式或打开属性检查器后仍保持圆角、尺寸、字重和文字排版。思维导图模式下拖动非中心节点会移动整棵子树：插槽用于同级排序，节点高亮与加号用于把整枝改挂为该节点的子节点；一级分支可跨中心换边，中心节点拖动整图，无效落点回原位。拖动收尾必须在无 `transform` 过渡的状态下同步提交节点终点与连线，再恢复普通过渡，避免线先到而节点随后漂移；任何顶栏模式切换也必须先结算尚未完成的脑图滑行动画。改挂会复用原父子连线、清除旧拐点，并在节点仍匹配内置预设尺寸时自动切换分支/叶级尺寸；手工改过的尺寸保留。循环、多父级、交叉连接和跨两张独立脑图不会自动改挂，普通模式仍保持自由拖动。
- 脑图改挂默认只重排旧父分支和目标分支，其他一级分支保持原位；局部结果与其他分支碰撞时才回退为整图排版。预设节点用 `mindmapStylePreset`、`mindmapColorMode`、`mindmapBranchColor` 和 `mindmapStyleRole` 记录配色来源：`auto` 节点改挂后跟随新分支，并同步恢复新层级预设的 `hideChrome`；`custom` 节点保留用户颜色和背景显隐。实心脑图节点会按填充色与透明度自动选择墨色或暖白前景，`hideChrome` 节点仍跟随画布文字语义。配色刷只复制节点填充、边框和透明度，不修改尺寸、背景显隐或连线；“匹配父分支”把所选非中心节点恢复为自动配色与该层级的背景显隐。
- 脑图“圆角折线”仍使用 `curve:"rounded-elbow"`；路径先正交路由，再用二次曲线圆滑转角。连线可选字段 `cornerRadius` 限制在 2–48px，缺省为 18px；脑图预设的 `branch` / `leaf` 可指定该值，Tab 新建、改挂和恢复连线样式都要继承它。
- 10 套脑图预设都显式声明三个层级的 `hideChrome`；“中心聚焦”使用深色中心、浅色一级分支和 `hideChrome:true` 的透明叶节点，并用 20px / 14px 圆角折线；“圆角树枝”保留三层柔和卡片，一级与叶级分别使用 30px / 22px 圆角折线。旧“高对比折线”的叶级也显式使用默认 18px 圆角，其他旧预设保持原有线型与视觉结果。
- 导图右栏顶部的三层实时预览通过 `CanvasModule.getMindmapPresetPreview` 读取同一份内置预设定义，显示中心/一级/二级的深浅或透明关系、两级连线的线型/线条样式与圆角半径；线型覆盖、线条样式覆盖和三档节点尺寸会即时反映在预览中。点击预设卡只切换预览与待应用选择，不写画布；仍需点击卡片勾选或“应用预设并整理”才真正套用。
- 脑图节点尺寸默认由文字和预设层级共同决定；中心节点、一级分支、二级及以后节点三条尺寸滑条分别写入当前预设比例，内置默认依次为 110% / 100% / 85%，无选中或当前结构缺少对应层级时保持已有面板值，不把空状态当成最小值。三条轨道在各自默认值处显示无交互的灰色提示线。`mindmapSizeMode: "auto"` 不保留固定 `width`，短标题不拆字、长标题在预设最大宽度内换行；左右边缘拖宽、角点调整宽度与最小高度后改为 `custom`，双击手柄或“恢复自动”会清除手工尺寸。`mindmapSizeFactor` 和 `mindmapMinWidth`/`mindmapMaxWidth`/`mindmapFontWeight`/`mindmapRadius`/`mindmapTextAlign` 保存预设排版语义，`mindmapMinHeight` 只保存用户角点调整的最小高度。尺寸变化必须让 ResizeObserver 刷新相邻连线锚点；自动避让只整理发生碰撞的一级分支。预设卡片点击只选择，悬停后右上角勾选会立即套用并整理。
- 属性检查器是持续工作的上下文面板，不是顶栏模式，并且只在当前顶栏模式处于 `full` 且对应偏好未关闭时启用：普通画布由 `canvas:inspectorEnabled` 控制，导图由 `canvas:mindmapInspectorEnabled` 控制，图案由 `canvas:decorInspectorEnabled` 控制；内容节点/连线选中后自动出现，装饰对象选中后显示其图案属性。切到 `clean` 或关闭当前模式的开关时不显示对象属性，恢复 `full` / 重新开启开关后若仍有选择则重新出现；导图排版与图案新建预设等模式自身面板不受对象检查器开关影响。完整画布模式的“新建样式”同样不受属性检查器开关影响：无选择、清选或关闭开关时都回到它；新建样式与当前所选之间不提供手动切换页签。完整画布右栏的“节点内容”区首次默认收起，`canvas:proContentExpanded` 只记录用户通过标题箭头选择的展开状态；单选与取消选择不能替用户展开或收起，无选择时只把内容控件置灰禁用，从而保持右栏高度稳定。简洁画布的“样式”是独立上下文浮层，不是完整属性检查器；打开时保持 `clean`，点击画布空白会清选并让面板回到新建默认，关闭按钮、Esc 或切换模式才关闭面板。单选显示对象类型，多选必须逐属性判断并显示“混合”，不可拿第一个对象的值冒充全部；选中对象时仍允许双击/N/粘贴新建、Ctrl+D 复制、Tab/Enter 连续录入和 Alt 拖线，只有图案模式禁止创建内容节点。Alt 拖线成功后保留发起前的节点选择，不自动选中新连线或把右栏切到连线属性；用户主动点选连线时才显示连线检查器。普通节点的圆角/字重/文字比例/对齐分别保存为 `radius`、`fontWeight`、`fontScale`、`textAlign`；脑图节点改这些值时写入对应 `mindmap*` 字段并把 `mindmapSizeMode` 标为 `custom`，改配色或隐藏背景时把 `mindmapColorMode` 标为 `custom`。检查器的“恢复预设配色/自动尺寸/外观”按节点自己的脑图预设和分支层级恢复；脑图连线“恢复样式”也恢复所在分支预设，不回退成普通黑线。范围控件实时预览只走轻量样式通知，鼠标释放/`change` 只产生一条历史记录。三个字重入口共用离散滑条视觉层：100–900 范围内按十位档调节，方向键每次移动 10，PageUp / PageDown 每次移动 100，轨道只绘制整百主刻度；当前节点类型或脑图预设的默认字重另用无交互的动态提示线标出。拖动期间连续预览，并在 `prefers-reduced-motion` 下关闭吸附动画。`fontWeight` 缺失表示“沿用类型默认”，不是显式 `400`：普通/代码为 440，索引为 600，预览为标题 580 / 正文 400，卡片为标题 620 / 正文 400，便签为 460，文字框为 400；脑图缺少 `mindmapFontWeight` 时回退 500。右栏必须以“默认 · …”显示这类语义默认，用户拖到 400 后则保存并显示显式 400。底部粗体入口已移除；原有选区粗体与整节点字重切换逻辑仍保留。

- 完整画布“新建样式”和节点/连线属性检查器共用普通画布快速配色：节点预设是一组“较深边框 + 柔和浅背景”，连线预设只改颜色；无选择时写入 `canvas:proNodeDefaults` / `canvas:proEdgeDefaults`，单选或多选时只改所选对象，且一次预设点击只产生一条历史。节点配色不夹带形状、透明度、文字或类型；脑图节点使用快速配色后转为手工配色，仍可恢复所属分支预设。普通节点支持分别恢复配色、形状与缩放、文字与轮廓；“应用当前新建样式”只复制外观字段，绝不修改节点类型、内容、位置和连接，脑图对象会跳过。整套恢复明确称为“恢复内置朴素外观/连线”，普通对象回程序内置值，脑图对象仍回自己的脑图预设。画布属性面板不再提供加入复习、复习问题或答案入口；复习卡片只在起步页独立管理。
- 右下角齿轮面板的全部数值滑条、完整画布“新建样式”的七个数值滑条、简洁画布“样式”的背景透明度/圆角/字重/文字比例/线条粗细滑条，以及思维导图的三档节点尺寸滑条，都在轨道上显示内置默认值提示线；完整画布的“整体缩放”位于“文字与轮廓”，范围为 50%–200%，无选择时写入 `canvas:proNodeDefaults.scale` 并作用于之后新建的节点，单选时读取并实时修改当前节点的 `scale`，释放后只产生一条历史；“恢复形状与缩放”仍负责恢复它。普通原生滑条的提示线按滑块中心实际可移动范围定位；字重复用离散滑条自己的整百主刻度，默认提示线随节点类型或脑图预设移动。所有默认提示线都只是无交互的视觉装饰，不跟随已保存偏好移动，也不修改画布或本地偏好；不能再给字重外包会参与 flex 布局的普通滑条容器。
- 完整画布“新建样式”在无选择且类型为便签时，以及单选已有便签时，“快速配色”都改用与节点右键菜单相同的20种果冻色，第一格统一为白底黑色粗体“？”。无选择时“？”是会高亮的未来新建随机色状态，固定色分别保存为 `canvas:proNodeDefaults` 内的 `stickyColorMode` / `stickyBgColor`，不覆盖卡片等类型继续使用的普通 `bgColor`；单选已有便签时“？”执行一次随机换色，随后高亮实际抽中的固定色。速记墙、起步页跨页便签、画布创建与两处画布调色入口统一读取 `assets/sticky-palette.js`，不得再复制色表；随机动作遵守全局候选偏好并先均衡抽色系，显式调色板始终展示全部20色。卡片等节点转为便签且原来没有底色时必须立即写入随机果冻色；便签执行“恢复配色”或“恢复内置朴素外观”时仍重新随机取色。便签缺少 `bgColor` 时的基础兜底是白色，不再是旧黄色；普通配色面板混选多种节点后应用“黑框白底”时，便签必须显式保存白色，不能因普通节点的默认字段清理逻辑退回另一种颜色。单行便签进入与退出文字编辑时必须保持相同外框尺寸：编辑区最小高度不能把默认 `64px` 便签撑高；多行内容仍按文字自然增长，手动正文高度仍优先。便签选中态不得使用向外扩散的多层粗焦点环，避免在高画布缩放下造成外框膨胀错觉；以原边界内的深色细边、内高光和尺寸手柄表达选择。
- 语义分组复用 `kind:"shape"` + `shapeType:"group-box"`，普通盒子与分组共用同一套图案默认和右栏预设；新建盒子/分组的默认标题固定为 `Untitled`，与界面语言无关。没有选中盒子/分组时，分组预设写入 `canvas:decorShapeDefaults` 的 `group-box` 项并跨画布影响后续新建；选中一个或多个盒子/分组时，同一组预设和“标题文字语义”只修改选中对象并写入一条画布历史，不得反向污染新建预设。拖拽矩形仍决定实际尺寸；浅色标题字用于较深标题底，深色字适合柠檬黄等明亮标题底。空白框选生成盒子与框选节点生成分组的门槛统一为盒子实际最小尺寸 `20×8`，不得再另设更大的旧阈值。成员 ID 保存在 `groupMemberIds`，折叠状态和展开高度分别保存在 `groupCollapsed` / `groupExpandedHeight`。建立分组不能修改成员坐标；拖动分组标题必须让分组与全部成员使用同一屏幕增量，折叠隐藏成员及其相邻连线，展开恢复原高度。分组框视觉层可高于内容，但框体必须 `pointer-events:none`，只让标题、折叠按钮和尺寸手柄命中，不能挡住成员节点；脑图模式选中内容或分组时由对应属性检查器替换脑图面板，清选后再恢复脑图面板。

- 完整画布右栏的“新建样式”标题与选中节点类型标题属于动态界面文案，切换 `canvas:toolbarLanguage` 时必须立即按当前语言刷新，不能缓存初始标题或依赖重新打开画布。

- 顶栏模板库打开时可复用已渲染列表并在后台拉取最新数据；接口返回内容未变化时不得清空重绘，确有变化时也要整批一次性替换，避免旧卡片先显示、随后消失并重播入场动画。模板库用半透明叠色、高光细边和静态阴影形成轻玻璃层次，不使用 `backdrop-filter`；深色语义下使用高不透明度墨绿黑表面。普通关闭先播放一次快速淡出、轻微上移/缩小的有限退场，完成后再设置 `hidden`；拖动模板时为及时露出画布仍立即收起，低动态模式直接切换。当前画布图谱浮层打开时使用一次有限的遮罩淡入与窗口上浮缩放动画，不使用模糊，并在 `prefers-reduced-motion` 下静态出现。

- 图谱关闭统一走 `graph-view.js` 的有限退场：先停渲染并让窗口轻微下沉缩小、遮罩淡出，动画完成后才设置 `hidden` 与解除外部浮层状态；重复关闭不得产生竞态，`prefers-reduced-motion` 下直接收起。右上角工具区不再包裹额外的灰色托盘/外框，只保留带读数的自绘透明度滑杆、线性图标按钮与克制的黑白悬停反馈；所有控件无模糊，并保持浅色和深色语义一致。

- 顶栏“背景”面板与浅色右栏共用轻透玻璃表面，深色语义下改用高不透明度墨绿黑表面且不使用模糊；面板滚动区保留滚轮/触控板滚动但隐藏原生滚动条。打开与关闭使用一次有限的淡入、轻微位移/缩放过渡，退场完成后才设置 `hidden`；`prefers-reduced-motion` 下直接切换。
- 背景面板在“柔和渐变”与浅色沉浸预设之间提供独立“辅助底纹（可叠加）”：无底纹、横线纸、点格纸、方格纸、主次方格。底纹只用一个视口覆盖层绘制，按 `curPan/curScale` 与画布原点对齐；平移只更新合成位移，低缩放时减少细格密度，不生成逐格 DOM 或巨大 surface 背景。“全屏沉浸”时另用一条低强度、向顶部渐隐的窄层把底纹连续延伸到标题栏，“柔和工具栏”仍保持纯净顶栏。底纹不参与吸附、历史和 PNG 导出，关闭时不进入视口更新热路径。

### 节点类型

| kind | 行为 |
| --- | --- |
| `index` | 索引/目录节点。旧数据里缺 `kind` 或 `kind:"text"` 会迁移为索引语义。 |
| `preview` | 正文悬停展开。 |
| `card` | 卡片节点，标题 + 常驻正文。 |
| `sticky` | 便签节点，正文即主体，常驻显示，可随机便签色。 |
| `code` | 代码节点，整块按代码渲染，不走普通 Markdown/MathJax。 |
| `table` | 独立 Markdown 表格对象；`text` 是可选标题，`body` 是唯一持久化真源，可连线、可进图谱，但不参加脑图自动布局。 |
| `textBox` | 装饰文字框，自身不参与连线；通用外观字段含 `fontSize`、`color`、`fontWeight`、`textAlign`，`boxStyle:"emphasis-card"` / `"note-bubble"` 另支持边框色、背景色、`borderWidth` 与 `borderStyle`。`emphasis-card` 使用直角纸面，并真实裁掉右下外角，让画布背景从缺口透出；折片位于轻微倾斜的直线折痕内侧，并按纸角反射关系偏移尖端。折片带约 2px 的同色系轮廓，折痕使用细实线与窄幅局部阴影；基础样式及八套颜色预设的纸面边框粗细统一为 2.5px。纸面与折片使用独立 DOM 图层，落地阴影跟随裁切后的纸张轮廓，不再由完整矩形或旧伪元素产生。八套样式预设只提供底色、边色、字色与边线参数，共用同一套轮廓。可通过 `textBindTarget` + `textBindDx` / `textBindDy` 持久跟随一个内容节点，也可显式转为该节点的标准导图子节点。 |
| `shape` | 装饰形状：分组框、色块、虚线框、括号/大括号标记、分隔线、角标框、手绘圆角矩形/菱形/椭圆/箭头、起止胶囊、输入输出平行四边形、问号，以及克制的信息/灵感/完成/错误/旗标/警告/时间/实验/文献/引用/观察/接口/数据库/数据集/筛选符号；另有 `shapeType:"edge-anchor"` 连接锚点。连接锚点是唯一可连线的形状。 |
| `image` | 画布图片资源。 |
| `pdf` | PDF 附件节点，可连线，可放大阅读和批注。 |
| `md` | Markdown 附件节点，可连线，可阅读和批注。 |

关键判断函数在 `canvas.js` 中：`isIndexNode`、`isBodyNode`、`isReadableNode`、`isTableNode`、`isDecorationNode`、`isEdgeAnchorNode`、`isLinkable`。当前规则是：普通 `shape`、`image`、`textBox` 不可连线；独立表格与 PDF/MD 附件可连线并进入图谱；表格明确退出脑图子树、邻居生成与自动布局；`shapeType:"edge-anchor"` 只作为画布连线端点例外可连，但仍按装饰对象退出图谱、AI、Markdown、任务和模板语义。
左侧“连接锚点”工具只在画布/导图模式可用：双击空白放置，拖动空白执行框选，普通拖动锚点移动，按住 `Alt` 从锚点或其他可连线节点拖出连线；同一锚点可连接多个不同目标。工具激活时显示全部锚点，并允许框选同时纳入普通节点和当前可见锚点；离开工具后锚点隐藏、不参与命中且退出框选范围。选中相邻连线时只临时显示它的锚点端点，端点本体可直接拖动，但不套用锚点自身的选中反馈。直接选中锚点时显示双环与一次性弹跳，视觉反馈不得修改节点尺寸或连线几何；放置、框选、连线和删除说明统一收在右下角“？”快捷键速查中，不在画布旁常驻文字。删除锚点必须连带删除相邻连线并作为一次历史操作；缩略图和 PNG 不显示锚点本体，PNG 仍保留有效连线。
左侧“重点便签”是非模态拖放入口，不属于 `drawTool`，也没有持续选中态：从图标拖到画布后，在落点中心创建固定 `290 × 200` 的 `textBox / emphasis-card` 并直接进入文字编辑；拖出画布或取消不会写入数据，过程中左栏保持展开。普通点击图标只开关紧邻工具栏的轻量设置窗，提供与图案模式共用的 8 套便签纸外观和暖金纸恢复入口；改的是 `canvas:decorTextPresetDefaults` 中的后续新建外观，不切换顶部模式、不新增节点字段，也不修改已经存在的便签。图案模式原有“重点便签”入口继续保留。
图案模式中，点击某个图案按钮会激活拖拽创建工具，并在未选中实际对象时显示该图案的“预设”面板；此处修改的是后续创建默认值，不写入画布历史。未选中对象且没有激活创建工具时，右栏常驻显示“纯色色块 · 预设”，允许直接修改 `color-block` 的全局新建默认，但不会因此激活画布绘制。
图案库按“默认 / 组合 / 符号 / 学术 / 工程 / 流程 / 数据 / 装饰 / 手绘”分类，初始显示“默认”；默认分类固定只保留虚线框、纯色色块、重点便签、旁注框四个入口。括号标记与信息归入“符号”；学术补充观察，工程补充接口，流程补充起止节点与输入/输出，数据补充数据集与筛选，装饰补充大括号，手绘补充箭头。新增项只覆盖高频且跨场景的空缺，不为凑数补入低频图案。“全部”只汇总已有内容，允许部分分类暂时留空并显示明确空态，不为填满分类引入低价值素材。选中真实装饰对象后，对象属性区要在 DOM 与视觉上移动到右栏最顶部，并在切换所选对象时回到属性区顶部；若选中对象前正从“全部”分类的激活预设进入创建流程，则要记住此前的素材库滚动位置，清除对象选择并回到该预设时恢复这个位置。未选中对象但明确激活某个图案或文字预设时，该预设属性只临时移动到图片/附件说明之后、“盒子 / 分组预设”标题正上方，不得移动到整个面板顶部。激活、切换或取消预设时必须保留当前右栏滚动位置，避免在“全部”分类中浏览到中后段后跳回开头；切到不含该入口的分类或退出创建工具后恢复默认属性位置。符号图案沿用低饱和纸墨配色与可编辑填充/描边，不采用卡通贴纸风格。判断菱形、方向箭头、括号与符号类图案在新建拖拽期间按各自设计比例辅助，避免起手得到扁平或细长的失真轮廓；比例只参与本次创建计算，不写入节点、不形成持续锁定，落地后宽高滑条与尺寸手柄仍分别自由调整。模块框、虚线框、色块、角标框等本就用于圈选范围的框体保持自由长宽；大括号与手绘箭头按纯线型对象处理，不显示无意义的填充控件。新增内置图案必须同时满足高频、跨场景复用与无需固定内容三个条件；不要把公式、图表或单一学科内容硬画成死板预设，宁缺毋滥。删除图案类型时不为旧数据保留专门兼容分支或迁移代码。
- 纯色色块的预设颜色固定按 6 列 × 3 行展示 18 色：浅色纸张色与降低饱和度、提高明度后的砖红、焦橙、赭黄、苔绿、青绿、靛蓝强调色交错分布在三行，不单独形成一排偏深色带；色表明确包含柔和红与杏橙。调整色表时应保持每组六色、三行明度均衡和明显的色相区分，避免重新堆叠多个难以辨认的灰白近似色。
- 图案右栏严格区分“新建预设”和“对象属性”：无装饰对象选中时，普通字段、颜色/文字/分组预设和“重置新建预设”只改浏览器本地的新建默认，不改画布也不写历史；单选或纯装饰多选时，面板读取对象的共同值/“混合”状态，普通字段、预设按钮、右键改色、尺寸手柄和“应用新建预设 / 应用预设颜色”只改选中对象并写画布历史，不得把结果同步回新建默认。清选后面板必须立即恢复此前的新建预设值。
- 装饰对象用 `layer:"back"|"front"` 表示相对正文的“底层 / 顶层”，并用整数 `zOrder` 保存同一显示图层内的叠放顺序；新建、复制、模板落地和导入的装饰对象进入所属显示图层顶部。图案属性面板底部提供“移到底部 / 下移一层 / 上移一层 / 移到顶部”，多选时把所选图案作为一组移动并保持组内顺序。多选图案必须显示真实批量状态，相同属性显示共同值，不同属性显示“混合”，不得退回“纯色色块 · 预设”；拖动期间仍保持原有顶层/底层关系。空白处右键拖出的纯色色块完整继承 `color-block` 预设（包括透明度），不得另写固定透明度。

### 渲染和编辑

- 画布节点、笔记坞、附件阅读、AI、日历和复习的 Markdown 显示都走 `MarkdownMini` 的同一套结构规则；块解析的读取位置必须前进，无法识别或不完整的 `- `、`1)`、未闭合围栏等语法安全降级为普通文字，禁止再次引入可停滞循环。标题保留真实 `h1`–`h6` 语义，文档容器使用完整六级比例，紧凑节点通过 CSS 变量收敛尺寸。原始 HTML 始终转义，图片与远程资源不自动加载；公式和 Mermaid 通过 `renderResult()` 的一次扫描特征按需调度。局部字号/字色/高光/粗体的真实数据是 `textMarks` / `bodyMarks`，`assets/richtext.js` 只在显示与 Markdown 导出边界把它序列化成 `==...==`、`{hl:...}`、`{tc:...}`、`{fs:...}` 与 `**...**`。编辑 DOM 始终是纯文字 + 格式 span，用户不会看到这些定界符；旧画布加载时自动解析为新结构并通过自动保存落盘。
- 表格是画布模式里的独立对象，不新增第四顶栏模式。简洁入口和完整面板入口都采用普通节点式创建流程；完整“画布 · 新建样式”的类型网格中入口只显示“表格”，紧邻“代码”右侧，不再单独占据一整行。单击入口只进入明确选中态，随后双击画布空白处才在落点创建默认 `3 × 3`（含一行表头）的 `kind:"table"`，不会单击即在视口中心落地，也不得自动打开模态工作室；新建节点默认写入 `tableChrome:"hidden"`，所以第一次落地就不显示标题栏，已有表格仍按各自保存状态显示。表头和正文单元格全部留空，不生成“列 1 / Column 1”等占位内容，首行固定按表头语义处理，但缺省视觉与普通正文格一致，不加粗、不加表头底色。表头不可删除，正文行允许全部删除到零行，不得为了维持“至少两行”而偷偷补回空白正文行。画布紧凑态由实际行列决定完整外框，不显示内部横/纵滚动条，不显示工作室使用的 A/B/C 与 H/1/2 坐标轴，也不常驻增删/清空按钮；通用“超长正文节点”滚动规则必须显式排除 `kind:"table"`，否则伸出外框的边缘 `+` 会让外层 `.node-text` 同时产生横纵滚动条。紧凑表格不再使用固定 `620px` 最小宽度：两列及以上缺省每列 96px，单列表格缺省 144px，并通过显式 `colgroup` 和表格总宽度阻止长字符串参与浏览器固有列宽计算；显示态保持单行省略，编辑态仍可查看和修改完整内容。双击列边缘自动适宽的最小结果与当前紧凑缺省宽度一致，不能把短内容列继续压窄后又被“恢复默认尺寸”反向撑开；长内容仍可在 480px 上限内扩展。标题栏显示且标题为空时，悬停或选中后才显示标题占位和右上角工作室箭头；旧左上角拖动按钮不再渲染，整块移动改由表格左侧伸出约 16px 的透明检测带触发。`F` 或右上角箭头显式打开大尺寸工作室。紧凑对象与工作室共用 `RelatumTableGrid`，支持任意矩形选区、行列选区、双击改单元格、增删行列、清空、对齐、复制/粘贴 CSV/TSV、源码往返和画布历史撤销；边缘悬停显示 `+` 快速增行/列，并允许伸出外框而不被裁切。选中紧凑表格后，内部竖分隔线内侧约 8px 的热区拖动对应左列宽度，内部横分隔线上侧约 8px 的热区拖动对应上方行高，最后一列与最后一行也可从外框内侧调整；外侧仍保留整体缩放手柄。列宽限制 72–480px，行高限制 42–240px；双击列分隔线按该列当前渲染内容一次性自动适宽并受同一上限约束，双击行分隔线恢复 42px。尺寸拖动只做实时 DOM 预览并逐帧刷新节点几何，松手后才把展示尺寸与可能同时发生的 Markdown 结构变化合并成一次历史提交；增删或粘贴扩展行列时同步插入/删除尺寸槽位，源码改变维度时保留仍对应的前部尺寸并补齐缺省项。格子选区可以保留在内存中供重新选中表格后继续操作，但画布上的表格节点没有 `.selected` 时必须隐藏绿色选区背景、活动格描边并禁用行列尺寸热区，矩阵外观也遵循同一规则；工作室内的选区始终正常显示。外部紧凑表格在单元格上右键，或聚焦网格后按 `Ctrl+-`，打开只含“删除所选行 / 删除所选列”的轻量菜单；右键未选中单元格会先切换选择，已在矩形选区内则保留多选。标题行删除项禁用，只剩一列时列删除项禁用；`Delete` / `Backspace` 仍只清空内容，不能改成结构删除。上、右、下三条尺寸手柄按 72%–180% 等比缩放整个表格，包括标题、列宽、字号、行高、内边距和操作按钮；左边不再提供缩放，避免与透明拖动带冲突；拖上边时保持下边固定，双击任一保留的缩放边恢复 100%。不得重新引入独立 `width`、`bodyHeight` 或画布态滚动视窗。标准表格的实际背景层必须直接拥有对应圆角并用 `overflow:clip` 裁切内部网格，外层节点背景保持透明，以消除四角白块且不裁掉作为兄弟元素存在的边缘 `+`。单元格只支持单行内联 Markdown（纯文字、粗体、斜体、代码、链接、公式等），不支持多行、列表或嵌套表格。
- `MarkdownTable` 的序列化结果是独立表格 `body` 的唯一真源；解析后的 `header/rows/align` 只存在内存。不要把整个二维模型冗余写进 `.canvas`，否则会形成双真源。普通卡片/便签中的 Markdown 表格仍由 `MarkdownMini` 渲染；双击渲染表格可打开同一工作室，修改时只替换正文里的对应源码片段，“提取为独立表格”要在一次历史记录中移除内嵌源码并新建 `kind:"table"`。
- 独立表格的 F 工作室可设置“显示标题栏”“突出表头”和“默认表格 / 矩阵”画布外观；“突出表头”开启后写入 `tableHeader:"emphasized"`，让首行加粗并使用表头底色，关闭时删除该字段并恢复普通单元格外观，工作室网格需即时预览。点击“矩阵”会在同一次设置提交中自动取消“显示标题栏”，用户之后仍可手动重新打开，切回默认表格也不强制恢复标题栏。矩阵可选圆括号、方括号或行列式竖线。紧凑画布上的矩阵内容使用 18px 基准字号、500 字重和等宽齐线数字特性，并继续跟随 `tableScale` 等比缩放；普通表格仍使用 14.5px 基准字号，工作室网格也不采用矩阵字号。外观只改变紧凑画布渲染，不改变 F 工作室的网格编辑方式，也不改变 `body` 中的 Markdown 真源。隐藏标题栏只隐藏画布上的标题、打开工作室按钮等整行 chrome；左侧约 16px 的拖动检测带仍保留，短竖线提示默认完全隐藏，只在表格悬停、选中或检测带自身悬停时出现。标题栏显示时，标题文字和栏内空白默认用于拖动表格；只有双击标题才进入输入态，第二次按下不得再次启动表格拖动，并保留浏览器双击形成的词语选区，不能进入编辑后立刻把选区折叠到末尾；回车或失焦提交，Esc 撤销本次标题修改。单元格不设置重复的 `title` 提示，避免全局 tooltip 在编辑时遮挡网格。表格节点带 `.dragging` 时，行列边缘的两个“+”必须强制隐藏并禁止命中，避免向右拖动穿过网格时被 `:hover` 误唤出。
- `assets/table-editor.js` 应保持为可复用二维网格交互层，Markdown 语法细节放在 `assets/markdown-table.js`。未来矩阵快速输入可以复用选择、行列、粘贴和悬浮工作室，但应增加矩阵适配器及自己的序列化契约，不要假装矩阵就是 Markdown 表格，也不要为此复制第二套网格 UI。
- 文本框显示态仍逐行调用 `MarkdownMini.renderInline`，但与内容节点共用同一套 `RelatumRichText` 数据模型，不另存可见语法字符串。代码节点保持纯源码，不启用局部富文本。
- 底部纯图标文字属性带在主编辑器中常驻，不再随文本上下文出现/消失；全新用户默认收起。颜色、四档字号、高光、字色、三种对齐、绑定/转导图与清除位于同一个可横向滚动的单行容器；粗体 `B` 入口已移除但实现仍保留，不再使用相互竞争的上浮弹层。没有适用上下文时相应按钮置灰，色块仍可预选颜色。无背景的箭头按钮收起整条属性带，收起后只显示透明向上箭头，并保持在属性带原来的最右端，不跳到屏幕中间；`canvas:textToolbarCollapsed` 在 `localStorage` 中跨画布全局记忆，展开/收起使用短位移、透明度和延迟 `visibility` 过渡，并服从 `prefers-reduced-motion`。有文字选区时字号、高光、字色与清除只修改该选区的 marks；清除按钮会一次移除选区上的所有局部格式，选区外保持不变。无选区时字号/对齐修改当前文本框或正在编辑的节点，纯文本工具上下文则写入之后新建默认。高光与文字颜色共用黄/橙/红/紫/蓝/青/绿/灰八色柔和色栏，并另有一枚带深色边框的“暖白·仅字色”：选中暖白时高光命令禁用，不写入白色高光。点色块只选择并记住当前颜色，不修改内容；再点高光或字色图标才立即应用，高光与字色图标是命令按钮，不得维持 `active` / 作用目标选中态。暖白字色使用富文本值 `white`，按 `#f7f6f2` 显示，并在结构化 marks、旧 `{tc:white|...}` 语法与 Markdown 导出之间往返保留。选区格式后保留原选区与就地编辑态，以便连续叠加多种格式；不因点击字号、高光、字色或清除而提前提交/退出编辑。文本工具提交一个文本框后保持激活，`Esc` 或选择工具才退出连续创建；就地编辑时点击空白的这一次 `pointerdown` 只提交当前文本框，不得复用同一次事件新建对象，下一次点击才创建新文本框。文本工具下单击已有文本框必须优先进入该对象的编辑态，不新建对象，并按该次 `pointerdown` 的视口坐标把折叠光标放到对应文字位置，不得全选内容；再次单击已在编辑的文本框要放行给浏览器移动光标/选择文字。
- 文本框拖动自动对齐由右下角齿轮的 `canvas:textSnapEnabled` 控制，默认关闭；关闭时拖动单个文本框既不显示绿色参考线，也不修改自由拖动落点。显式开启后，会对附近内容节点的左/中/右和上/中/下边线做 9 屏幕像素内软吸附并显示临时参考线，软吸附只负责对齐且不参与关系判断。底栏链接入口只有在选区恰好包含一个文本框与一个非装饰内容节点、且没有连线/箭头选择时才可用：点击会把文本框绑定或改绑到明确选中的节点；若当前已经是这一对则解除跟随。双选状态下拖动文本框只调整文本框自身及相对偏移，不得把目标一起拖走；目标普通拖动、导图排版与导图滑行都必须同步带动文本框，目标因上级折叠而隐藏时文本框也一起隐藏，删除目标则原地解绑。复制时，目标也在选区内就重映射到副本，只复制文本框则保留原目标并刷新相对偏移；模板只在目标同时被收入时重映射，否则解绑。
- “转为导图子节点”与绑定入口使用同一组“一个文本框 + 一个内容节点”明确选择，不再要求两者预先绑定；原文本框保留 id、坐标、纯文字与局部 `textMarks`，清除 `kind:"textBox"`、跟随关系、尺寸和装饰字段，新建所选节点 `parent → child` 的树边并立即走现有导图样式/排版。这是显式类型转换，不让一个对象同时具有“文本框”和“导图节点”两种语义。转换结果默认写入 `hideChrome:true`，只隐藏子节点背景、边框和阴影，文字、透明命中区、选择反馈与树边仍保留；原文本框整体字色转换为不覆盖既有局部字色的全文语义色，八种共享柔和色与暖白字色精确保留，其他有效十六进制色映射到最近的共享色，黑色系沿用普通节点语义正文色；整体字重达到 600 以上时只给尚未局部指定粗体的范围补全文粗体。绝对字号按 `fontSize / (14.5 × 导图节点 scale)` 换算为 `fontScale` 并限制在现有 75%–160% 范围，节点整体 `scale`、宽高和对齐仍由导图预设接管。
- 新建内容节点若未输入文字便结束编辑，持久化默认标题固定为 `Untitled`，与界面语言无关；已有节点不自动改名，空便签仍按既有规则保持为空。
- Mermaid fence 走 `MermaidRenderer` 离线按需渲染；首次真实图表才插入 `vendor/mermaid/mermaid.min.js`。
- 代码节点绕开 Markdown 渲染，标题从代码内容/语言推导。
- 手写层包含笔、荧光笔、箭头、橡皮、压力/倾斜/书法效果。撤销历史包含节点、边、手写。
- 历史栈限制约 50。AI 计划应用、模板实例化等批量操作应保持可整体撤销。

- 表格收尾交互以当前实现为准：紧凑表格右键或 `Ctrl+-` 打开的行列菜单同时提供“上/下插入行、左/右插入列”和原有删除项，不再是只含删除的菜单；表头上方插入行禁用，避免破坏首行表头语义。F 工作室的“尺寸”菜单复用紧凑态字号与内边距测量，支持只展开确实被省略的列、全部按内容适宽、按当前总宽等分所有列以及恢复默认列宽/行高；列宽仍限制在 72–480px，每次批量尺寸变化只提交一条历史。矩阵外观额外显示“转置”，按完整二维数据交换行列、重置对齐与展示尺寸并提交一条历史；普通表格隐藏该入口。以上操作只改 Markdown 真源或 `tableLayout`，不得引入第二份二维数据。

### 附件和批注

- 普通画布图片也由外层视口独立管理，使用与 PDF/Markdown 相同的垂直 `150%`、水平 `125%` 预加载边界、120ms 稳定激活和 8 秒延迟释放；远处节点只保留固定尺寸外壳，不创建带 `src` 的图片元素。图片被选中或定位时必须立即激活；释放时移除旧 `img` 及其 `src`，让浏览器回收解码表面。异步 load/error 回写必须校验节点、资源 URL、元素和 generation；旧 WebView 无 `IntersectionObserver` 时仍立即加载。
- PDF/Markdown 画布附件统一由外层画布视口的 `IntersectionObserver` 管理，预加载边界为垂直 `150%`、水平 `125%`，与画布节点总数无关。节点初建只保留固定外壳、标题和加载占位；进入预加载区稳定 120ms、被选中、被定位或打开阅读器时才加载正文，避免长距离相机滑行沿途激活附件。不支持 `IntersectionObserver` 的旧 WebView 回退为立即加载。
- 附件离开预加载区 8 秒且未选中、未阅读时释放重资源；快速往返必须取消待卸载。Markdown 先提交待保存批注，再移除正文 DOM 与净 HTML 快照，但保留 marks/strokes/boxes 轻量状态；PDF 断开页 observer、取消在途栅格化、清零 Canvas 并销毁节点自己的 PDF.js 文档。删除、撤销快照重建或资源更换还要注销外层 observer 和 generation 票据。
- 画布附件的异步回写必须同时校验节点 ID、资源 URL、当前 body 和 generation。Markdown 只允许合并“同时进行中的同 URL 请求”，Promise 完成后立即从 `markdownInflight` 移除，禁止缓存最终正文，确保外部修改后再次激活能读到新内容。
- PDF 使用离线 PDF.js。画布附件、索引右栏和大阅读器都只保留视野缓冲带内的页面；滚远、关闭、删除、快照重建或资源更换时必须取消在途 canvas/文字层任务、清零位图、断开 observer 并销毁 PDF 文档。大阅读器的会话 token 用于隔离快速关闭/重开；调整附件尺寸后只重栅格化可见页以恢复清晰。
- PDF 读者批注包括文本高亮/下划线、画笔、荧光笔、框选、便签、橡皮、撤销/重做、清页。坐标归一化到虚拟宽度 `PDF_ANNOT_VW = 1000`。
- Markdown 附件的文本高亮按源文件指纹处理；源文本变更时，字符偏移型标注可能失效，手写/框选仍保留。
- 文本读者的节点批注不写进 `.canvas`，写在 `.assets/node-annotations.json`。

### 模板

- 模板库在 `data/templates.json`，所有画布共享。
- 保存模板只保留“纯结构”：可读节点、边、允许的装饰形状。图片、PDF、MD 附件不进入模板。
- 模板实例化会保留模板中的样式字段；AI V2 的样式边界由计划协议和执行器单独控制，二者不要共用一条宽松注入路径。
- 图案模式“组合”分类内置研究链、系统边界、对照实验、论证框架、验证闭环、故障树、研究问题画布、V 型验证、风险四象限、决策树十套只读结构，分别覆盖线性、边界、汇聚、分支、循环、层级树、中心辐射、V 型追踪、二维矩阵和两级决策分叉；只有拓扑或工作流价值明显不同的结构才可继续增加，不得用换词扩充数量。组合可复用真实卡片、连线、纯文本框和少量成熟装饰图案，预览与插入必须读取同一份结构数据，不使用额外图片资源；需要曲线表达的组合连线统一使用“枝桠曲线” `branch`，不使用“平滑曲线” `smooth`。它们不写入模板库，单击插入可见画布中心、拖动可精确落位；系统边界仍只是无成员关系的装饰盒。组合成功落地后自动进入用户原先记忆的画布简洁/完整子模式，并在模式切换清理选择之后重新选中本批全部节点，使卡片可立即整体移动或双击编辑；取消拖放不得切换模式，模式切换不进入撤销历史，整批插入仍只产生一条撤销历史。模板裁剪只保留选区内部的 `groupMemberIds`，实例化时与文字绑定、连线端点一起重映射，重复插入不得互相引用。

### AI 计划接口

`CanvasModule` 暴露的关键方法：

- `init`
- `setMode`
- `setFilePath`
- `commitPendingEdits`
- `getSelectedCardIds`
- `removeArchivedNodes`
- `revealNode`
- `setExternalOverlayOpen`
- `instantiateTemplate`
- `describeCanvas`
- `describeAIContext`
- `describeAIPresentation`
- `applyAIPlan`
- `createMindmapFromOutline`
- `exportImage`
- `applyMindmap`
- `applyMindmapStyle`
- `alignMindmapLevels`
- `setMindmapNodeSizes`
- `getMindmapSizeState`
- `restoreMindmapNodeSizes`
- `equalizeMindmapLevelWidths`
- `repairMindmapOverlaps`
- `getDualSelectionPayload`
- `importDualSelectionPayload`

`describeCanvas` 是给新手引导等调用方判断可读内容变化的轻量快照，不是 AI 协议。AI V2 只通过 `describeAIContext` / `describeAIPresentation` 读取受限上下文，并只通过 `applyAIPlan` 原子执行用户确认后的计划；不要重新引入绕过预览的通用 AI 注入器。

## 7. 起步页和页面模块

### 起步页 `start.js`

- 首页是书本式工作台，不是营销页。
- 顶栏“画布 / 笔记 / 生涯”只切换现有起步页壳中的直属工作区面板；画布工作区 DOM 不卸载，所以当前特殊页、分组、书脊位置和滚动状态必须保留。切换使用同一 `--start-turn-*` 速度变量与低动态降级；笔记和生涯脚本按需加载，画布首屏后只空闲预热笔记运行时。离开笔记前必须等待其保存链，按钮选择器只能命中 `button[data-start-workspace]`，不能把带当前状态的 `body[data-start-workspace]` 误绑为点击入口。
- 学习、树状、速记三页在画布工作区可见且窗口有焦点时，由 `start.js` 共用一个 30 秒前台计时器写入 `/api/start-page-activity`；切页、切到笔记/生涯工作区、失焦、隐藏或 `pagehide` 时立即结算，不设键鼠闲置超时。计时开关默认关闭，只有用户显式开启后才记录；关闭会先结算当前片段再停用，但不再改变绿色统计的显示状态。独立的“显示三页统计数字”开关只控制四张卡片中的绿色附加值，不启停计时或清除既有账本。三页计时写入后不得自动重绘活跃页；已有缓存保持到用户点击右上角“更新”，按钮先等待计时队列至多 3 秒再统一读取最新活跃数据，避免翻页时二次渲染闪烁。活跃页画布镜头的热力图、当天明细和星图仍只表示真实画布；四张统计卡以同字号绿色 `+值` 单独显示三页的月/年时长、统一连续天数、当年使用页面数和累计时长，时长两边各用自己的自然单位。
- 主要页面顺序包括复习、日历、节奏/活跃、速记、树状、学习、专注、最近、收藏、自定义分组和固定在其后的未分组；另有回收站、帮助、主题/背景设置。
- 左侧书脊保留两层游标：黑白实体表示真实当前页，彩色细条与柔光层负责悬停预览；彩色层初载直接落在当前页，悬停时连续改道，离开书脊、焦点离开或滚动后回到当前页并常驻为细条 + 微光轮廓，不得重新改成淡出消失。动态分组重建和窗口缩放必须无飞入地校准，低动态模式立即完成位置与形状切换。
- `recent.json` v3 的文件项有稳定 `id`、`groupId`、`groupRank`，收藏项另有 `favoriteRank`；最近页只展示具有真实 `lastOpenedAt` 的条目并按该字段计算（最多展示 30 项），收藏与分组顺序互不覆盖。旧版 `group` 字段自动迁移，内置页保留 id 不得用作自定义分组 id。
- 最近、收藏、自定义分组与未分组共用画布名称搜索；它由左上角齿轮中的 `canvas:librarySearchEnabled` 开关控制，默认关闭，关闭时清空查询并用同一增量协调器恢复原页面。启用后缺省只筛当前页，可在当前起步页会话内切到全库，查询和范围都不写 `localStorage`、`recent.json` 或 `.canvas`。匹配对标题做 NFKC、忽略大小写并按空白拆成 AND 关键词；当前页保留原顺序，全库按最近打开、未打开置后、标题稳定排序。输入期间按路径复用卡片 DOM，离场/入场与存留补位使用无错峰的短过渡，快速输入取消旧动画，不能退回逐字 `innerHTML` 重建或重播 `recent-enter`；搜索期间禁止部分组内重排，但单张移动、收藏、重命名、回收站和打开仍可用。
- `groupId: ""` 表示“未分组”，不是“最近”。删除自定义分组只把成员移到“未分组”，不删除画布，也不改变收藏状态。
- `/api/favorite-toggle` 是幂等设置接口，请求必须带布尔 `favorite`；`/api/reorder-files` 必须带 `view`，最近页不可手动排序。
- 最近文件会展示存在状态、节点数、大小等；失效文件不主动删除，需要用户处理。画布卡片的右键菜单与键盘右方向键共用“移到回收站”操作；若文件已不存在，该操作只清理最近记录和残留视野状态，不生成不可恢复的空回收站条目。
- `/api/recent` 只返回元数据，不扫描全部画布；存在状态、节点数和大小由 `IntersectionObserver` 对视口附近卡片分批请求 `/api/file-stats`。后端统计按文件身份、大小和时间戳缓存，缓存上限 512 项；文件变化必须自动失效。
- “未分组”标题旁的循环箭头显式调用 `/api/recent-sync`，扫描范围固定为当前 `canvases/*.canvas`。新发现的合法普通文件按文件名追加到未分组且 `lastOpenedAt` 为空；损坏、超限、链接/重解析点跳过。若存在已登记但缺失的受管顶层画布，首个请求只返回不透明 ID 供确认，确认请求重新核验且只删除那批仍缺失的登记；外部路径、现存条目元数据、画布文件、素材和活动账本均不改。
- 正常规模保留玻璃卡片与现有翻页/收藏/FLIP 动画；仅列表超过 40 项时取消逐项错峰入场，超过 80 项时关闭卡片 `backdrop-filter` 并启用 `content-visibility`。
- 分组、收藏、排序都存 `data/recent.json`。
- 当前页通过 `aria-hidden` / `inert` 与 `start:viewchange` 统一管理；退场动画结束后，隐藏页用 `visibility:hidden` + `content-visibility:hidden` 跳过后代绘制。页序固定为复习 → 日历 → 活跃 → 速记 → 树状 → 学习 → 专注 → 最近；学习、活跃、树状、速记、日历、复习和专注模块应在离页/pagehide 时暂停自己的计时器、RAF、observer 或音频，不能让隐藏页继续耗帧。
- 复习页进入时根层保持静止，不得把整页当成完成的矩形贴图横移；日历先短促淡出并轻移，复习页标题、操作区、统计、纸面和纸面内容依次渐入。分层时长跟随起步页翻页速度，`start.js` 的清理延迟必须覆盖最长一层；自由复习和计划复习切到下一张卡片时直接完整展示，不再叠加卡片内部入场动画。
- 默认最近页不把特殊页数据请求放进首屏阻塞链；起步页脚本就绪后，学习、活跃和独立树状页分别在浏览器空闲时预读 `/api/study`、当前年度 `/api/study-activity` 与 `/api/tree-page`，首次进入复用相同缓存或在途 Promise。速记仍在首次进入或执行跨页动作时加载并复用同一个在途 Promise。任何首次加载完成前都不得用空前端状态覆盖服务端数据。

### 学习 `study.js`

- `data/study.json` 固定为 v6，不迁移旧版本；读取旧文件时报不兼容且不写盘。任务结构为 `id/title/color/status/progress/createdAt/updatedAt/completedAt`，可选 `color` 只允许严格 `#rrggbb` 或空串（默认色），旧任务缺省空串；顶层可选 `temporaryTaskIds[]` 只保存现存未完成任务的有序唯一 ID。`status` 只允许 `active/done`；`progress` 含 `current/target/milestones[]`，目标 `0` 表示未设置，否则为 `1..9999`；任务点位置唯一且在目标范围内，用户侧不设小额数量限制，后端保留 50 个异常数据安全上限。
- 进度面板桌面宽屏最大为 1440px，未完成/已完成列使用约 54%/46% 的主次布局与 28px 间距；未完成卡片最小高度 110px，已完成卡片仍为 78px。窗口宽度不超过 940px 时改为上下单列，700px 以下继续使用移动端紧凑卡片。
- 新建只接收标题；学习页的 `+` 创建“未命名”任务且不自动进入编辑，极简清单与进度面板都只有双击任务名文字才能改名。进度卡片的三点按钮打开不参与卡片布局的锚定浮动设置卡，只编辑目标和任务点并提供直接回收；外部点击或 `Esc` 取消草稿，明确保存才提交。`/api/study-task-progress` 只接受 `delta:1|-1`，前端对同一任务串行请求并用响应序号避免快速点击回写旧状态。到达目标后卡片持久显示“目标已达”并提示左侧完成入口，但不自动完成；进度数字与状态标签使用常驻独立 DOM，状态标签只在原位改变透明度且不得裁切英文。左侧完成圆在达标但未完成时由半透明低饱和绿色材质基本铺满，不显示勾；完整材质与四枚斑点常驻在按钮内部伪元素，材质向边框下方外扩 2px，再由按钮自身的圆形 `overflow` 边界裁掉外溢部分，避免两条抗锯齿圆弧贴合时露白；普通态裁切为零，达标时用约 520ms 从圆心原地扩散并淡入，减回未满时向圆心收拢淡出，不能离散增删渐变背景；服务端确认达标时不再额外对圆形播放缩放、外扩环或呼吸。它使用独立于进度条呼吸的单一前台计时器，圆内包含两枚中等和两枚小型的浅柔焦绿斑，每约 3.4 秒只随机挑选其中两枚更新位置，四组坐标分别用约 3.2–4.8 秒连续过渡，形成大小、速度错开的无轨道随机游走而不复位瞬移；后台、离页、清单视图和低动态模式停止更新，真正完成后仍切回既有实心绿色白勾。最后一格填充时底层渐变通过可动画颜色变量在同一个 520ms 过程中由鼠尾草绿连续过渡为略低于镀层亮度的明暖金（当前 `#EFCF72 → #F6E09C`），不离散替换整张渐变；服务端确认首次越过目标后，同属暖金色相但明度更高的半透明镀层、细小碎金高光和高斯光雾用约 1.3 秒从左向右覆盖，语义是为基础金镀上一层光泽而非换色，亮层上下各外扩 0.5px 避免形成边界；条内暖金高光与条外光雾的中心必须随首次揭幕前沿从 `-24%` 移到 `124%`，不能只在后续呼吸类里移动。扫光核心峰值为 1.12，最终持久镀层稳定在 1.05；光雾由峰值 76% 收敛到持久 67%，结束回落更小且动画终点与类清理后的静态值完全一致。首次流动在扫光类完成清理后再衔接；`is-goal-pending` 与 `is-goal-celebrating` 卡片必须从呼吸扫描和呼吸 CSS 选择器中排除，进入待确认、扫光或减回未满时还要主动清除既有呼吸类，防止周期计时器覆盖首次扫光。达标卡片仅在学习进度视图处于前台且卡片可见时，以约 2.4 秒有限 CSS 动画让同一个低色差亮暖金光团从条内光泽和条外高斯光雾中同步由左向右单向穿过，峰值光雾约为 80% 透明度与 12.5px 模糊，条体厚度不闪烁；约每 2.8 秒开始一轮，不折返、不使用 `infinite`，后台、离页、清单视图及低动态模式停止；刷新直接恢复静态最终态且不重播，减回未满立即撤销。
- 极简清单与单位进度面板共用同一份数据；回收、恢复、永久删除、拖拽排序与完成归档都走后端 API。学习归档的 `tasks.json` 标明 `kind:"study"`：活跃页统计，日历过滤。
- “目标树”V4.1 是学习任务之上的阶段解锁路线：`goalTrees[]` 中每棵 `{version:2,id,title,nodes[],links[]}` 的隐式根表示总目标，第一棵树不可删除。节点只有内部 `kind:"branch"`（界面统一称“阶段”）和引用学习任务的 `task`；同一任务每棵树最多出现一次，但可在不同树共享。每个节点恰有一条 `primary:true` 主链接；`contains` 只能由根/阶段发出，`requires` 可由任务完成、任务点或阶段完成触发。非主 `requires` 是附加解锁条件，目标的全部入站依赖均满足才解锁。阶段沿所有主链接递归汇总后代任务，每个任务等权且只计一次；若后代分支通过一条或多条 `requires` 最终等待该阶段自身完成，则在最先命中的节点截断该分支，使“新建后续任务/阶段”不反向进入当前阶段完成度。根仍按整棵树唯一任务等权汇总，普通空阶段为 0% 且未完成；根/阶段进度文字与后端解锁判定共用同一范围，可查看最多 50 项的逐任务明细与完整等权公式。后端拒绝主树/依赖循环、阶段包含关系自锁、失效任务点、语义重复条件、重复任务、悬空引用及超过 32 层/2000 节点/6000 链接的数据。
- 目标树面板使用与画布思维导图一致的左右自由水平排布：包含边是浅灰无箭头曲线，主路线解锁边是深色小箭头，附加依赖是细虚线。拖到根/阶段建立包含，拖到任务/任务点建立完成/任务点依赖；拖动仍冻结布局并携带整棵主路线子树，只在松手时预览、提交和重排。完整模式可新建后续阶段和添加解锁条件；条件面板分主路线/附加条件，附加条件可移除，取消主路线条件会把节点及原子树接回当前侧根目标。未解锁任务在目标树内禁止完成、增减和设置进度，已完成任务仍可恢复，普通学习清单维护共享任务不受路线锁定影响。标题旁 `?` 是四页按需教程；节点不显示“可开始”、“等待…完成”等状态文案或对应悬停提示，未解锁状态仍由锁定外观和禁用控件表达，解锁只播放一次有限反馈；顶部“下一步”优先定位已推进的可执行任务，再按主路线视觉顺序循环。阶段支持鼠标和键盘可用的折叠按钮，根菜单可批量收起已完成阶段或全部展开。切树仍使用可取消 RAF 过渡和 Rail 滑块；相机追随、惯性、冻结落点、根锚点抵消和低动态降级延续 V3 手感。面板无持续背景模糊、无限动画或常驻 `will-change`。
- 空阶段仍渲染与普通阶段同尺寸的禁用折叠按钮，使右侧三个操作槽与卡片高度在无任务时也保持不变；它不写入无意义的折叠状态。
- 同一学习任务的新建后修改、状态切换与单位进度写入在前端共用一条串行队列，避免临时 ID 或待保存目标与进度请求竞态；任务回收站前后端都只保留最近 30 条。完成归档若在写入 `tasks.json` 后未能保存 `data/study.json`，必须撤销本次 marker，避免重复归档和活跃统计重复计数。
- 翻入学习页或从极简清单切到完整进度视图时，收起态的右侧“临时任务”标签跟随整页错峰节奏从右侧有限弹入；离页、展开面板或动画结束时清理入场态，低动态模式不播放位移动画。
- 完整进度视图右侧“临时任务”是未完成任务 ID 的有序引用：浮层作为 `.book-view` 直属层脱离 `.study-embedded` 的滚动、变换和布局，在所有桌面宽度都覆盖显示，开合不得改变主内容边界或横向滚动值；无遮罩且底层任务仍可操作。学习进度页中的裸 `Tab` 始终开合面板，不受普通按钮、输入框或其他控件焦点影响，并在开合后主动释放原控件焦点回到页面；`Shift+Tab`、带修饰键的组合键和阻塞弹层仍保留原键盘行为。鼠标点击标签后立即释放标签焦点；键盘激活标签时因标签会退到面板下，焦点转到面板关闭按钮。关闭按钮与 `Esc` 把焦点还给右侧标签；关闭态面板必须 `inert`。面板展开后右侧标签在面板下淡出并禁止交互，不再移动到面板左侧形成突出标签，收起时随面板退场重新显现。未完成卡片可经三点设置加入，也可拖到屏幕最右 36px 静默停留 120ms 后松手放入；边缘驻留不显示额外文案或大型提示，这一手势必须恢复拖拽前源列表顺序。跨容器落位不得逐帧改写宽高：真实临时卡在交接前保持隐藏，由临时卡样式代理从幽灵卡矩形通过 FLIP 位移和双轴缩放连续收敛到面板最终边界；源内容在前段淡出、目标内容在末段淡入，代理抵达后才同帧切换真实卡。失败或取消清除代理和隐藏态，低动态模式直接交接。临时卡移出先淡出、轻微右移缩小，再用 FLIP 让后续卡片补位；最后一项移出时空状态短暂淡入，保存失败则原位置回滚并播放有限恢复动画。侧栏只允许完成与移出，完成仍写原任务状态并自动消失；小屏无拖拽手柄时依靠三点设置入口。正常模式打开使用约 310ms 的滑入，关闭改用约 420ms 的缓入缓出，标题与列表先柔和淡出，右侧标签在面板接近退场后再显现；低动态模式仅保留 120ms 短淡化。
- 学习任务不关联画布、专注钟或日历；编辑器也不提供画布节点转学习任务入口。历史专注记录的标题仍可被动显示，`data/calendar-pins.json` 保留在磁盘但不再读取或写入。
- 验证运行 `python -m unittest tests.test_study_goal_tree tests.test_study_progress`、`node tests/study-goal-tree-contract.js`、`node tests/study-progress-contract.js`，并执行完整 Python unittest 与受影响的 Node 契约测试。目标树契约覆盖单根多级分支、左右根侧、任务后续链、任务点落槽、循环与重复引用拒绝、节点内进度/完成控件、无侧栏/多树/聚焦/树归档、进度点击不重建整棵路线，以及拖动期间不改树、整棵子树跟手、冻结布局的上下双向插槽、左右换侧、循环拒绝、松手排序、连续相机追随、前后向进度补间与低动态降级。

### 独立树状页 `tree-page.js`

- 树状页是起步页中位于速记与学习之间的全屏特殊页，和学习页“目标树”完全隔离。页面不显示顶部“下一步”；黑色根卡默认在动画百分比右侧显示当前树名，百分比占用按 `100%` 预留并右对齐的固定列，因此数字补间只向左增长、标题起点不移动；标题占用剩余宽度并省略溢出，改名、切树和百分比补间不得互相覆盖。只有树状页的树名允许保存为空：空名时根卡只显示百分比，右侧编号按钮仍以数字保持可选；学习目标树、阶段与任务仍沿用非空规则。齿轮中的“隐藏根节点标题”使用 `canvas:treePageRootTitleHidden:v1` 即时切换，16–36px 标题字号滑条使用 `canvas:treePageRootTitleSize:v1` 即时预览；两者都不写树数据，连续字号输入只允许每帧触发一次节点重测与布局。内部仍原样使用 `.study-route-*` 结构与目标树的双向布局、节点/连线常驻 DOM、节点尺寸缓存与尺寸变化时的二次布局、FLIP、进退场、相机惯性、缩放锚点、适配、窗口补偿及低动态降级。纯数据变化若没有改变节点几何，布局动画直接单帧落位，不能持续整段逐节点/逐边写样式；树模型在同一轮测量布局中只构建一次。主书脊最左侧热区保留跨特殊页滚轮翻页，树内编号栏改由画面右侧悬停唤出且不能被裁切。普通结构拖拽在按下时取得指针捕获，并在抬起、取消、捕获丢失、窗口失焦或页面转入后台时完整清理。翻离树状页时立即停止请求代际、拖动、惯性与 RAF，但节点/连线 DOM 必须保留到起步页根层 `view-leaving` 动画结束后再清空；动画中途翻回应取消延迟清理并复用当前画面，低动态模式才立即清理。
- 运行时以 `study-route.js` 为母版，保留阶段、任务、包含/主路线/附加解锁条件、阻塞状态、进度明细、任务点、完成/恢复、折叠、多树编号栏与滑块抢跑、可取消切树动画、整棵主路线子树拖动、冻结落点、边缘自动平移、确认层、键盘/触屏入口和四页教程。两页受同一个精简目标树设置控制；除独立根节点/API/存储键和本节列出的差异外，不重写其他交互时序。新建任务/阶段、永久删除任务、任务进度 `＋ / −` 与根/阶段/任务外观是窄范围乐观操作：新建时前端预生成正式 ID 并立即插入常驻 DOM，只播放布局动画而不补偿或适配镜头；删除任务不再二次确认，卡片短暂淡出后立即移除并按原兄弟顺序重接主路线子项；进度点击立即更新数值、进度条和根进度；外观点击立即预览颜色/形状、重新测量节点并运行布局让位。连续进度增量与同节点外观选择在待发送队列中合并，服务端按顺序返回权威快照；关闭后快速重开时，旧代成功响应也必须刷新当前缓存与可见树，失败则重新拉取，不能留下只存在于磁盘的“消失操作”。其余命令继续沿用目标树 `busy` 与提交时序。
- 树状页不显示或接受“选择已有任务 / 接入已有任务 / 移出路线”，也不允许 `attach-task` / `detach-task`。新建任务同时创建当前树唯一的任务记录；删除任务为永久删除，删除阶段会级联其主结构子树任务，删除可删除的树会清理该树所有任务，第一棵树沿用目标树规则不可删除。
- 根、阶段和任务右键打开同一个紧凑外观面板：颜色复用 `study-palette.js` 的 12 色与默认色，形状提供圆角、矩形、胶囊、菱形和圆形。外观只参与渲染与节点尺寸测量，不改变阶段/任务语义；任务外观随该树状页任务记录保存，阶段与根外观随树保存。
- 添加菜单中的“新建阶段 / 新建任务 / 新建后续……”都是单击直接创建，不再弹出取名表单；新节点名称为当前界面语言的“未命名 / Untitled”，新任务默认进度为 `0 / 1`，之后仍通过改名和设置进度修改。
- 已设置量化目标的任务在右键菜单中额外显示“取消进度条”；点击后通过现有任务更新命令把进度规范化为 `current:0 / target:0 / milestones:[]`，立即隐藏量化进度控件，保存失败时回滚，不删除任务或树结构。未设置量化目标的任务不显示该入口。
- “设置进度”只校验当前值与目标值是否都是 `0–9999` 的整数；保存时若目标总量小于当前进度，前端自动把当前进度夹到目标值（例如 `6/10 → 4/4`），不再弹出大小关系警告。任务点仍随新目标范围裁剪。
- 树状页不绑定 `Alt + 左键` 的额外交互；按住 Alt 不创建引用线，也不写入独立引用数据。
- 数据修改沿用目标树的服务端命令时序、`busy` 规则及同目录临时文件 + `os.replace` 原子写入。HTTP 命令处理只在加载后和命令落地后各做一次完整规范化，不能在 `load → apply → save` 链中重复四次扫描同一份树数据；除每棵树自身的 2000 节点 / 6000 连接上限外，独立页全部树合计最多 6000 节点 / 18000 连接，避免多棵满载树把整文件请求放大到数十 MiB。独立树状页的聚合进度命令允许安全范围内的非零整数增量，共享学习页 API 仍只接受 `±1`。验证运行 `python -m unittest tests.test_tree_page`、`node tests/tree-page-model-contract.js`、`node tests/tree-page-ui-contract.js` 和 `node tests/start-tree-page-contract.js`，再回归 `python -m unittest tests.test_study_goal_tree` 与 `node tests/study-goal-tree-contract.js`；完整交付还需运行全部 Python unittest、全部 Node 契约和本地页面的深浅主题/窄窗/滚轮/切树动画实测。

### 活跃星图 `study-graph.js`

- 使用 `graph-engine.js` 渲染学习活动图。
- 普通视图按根节点、月份、任务组织；概览视图按年份、月份、任务组织。
- 图谱是只读展示，不负责跳转画布编辑定位。
- 普通/概览分段滑块必须在动态中英翻译完成后按最终按钮尺寸重定位，不能沿用中文宽度裁切英文 `Normal`。
- 起步页空闲时由 `study.js` 预读当前年度 `/api/study-activity` 并预渲染隐藏的活跃页；预热、首次进入与 `awaitReady()` 必须复用同一进行中请求。隐藏星图保持 `active:false`，不得运行 RAF 或主题监听；真正翻入后再校准年份书脊、分段滑块和可见尺寸。预热失败保持静默并由首次进入重试，不预读额外历史年份。
- 起步页空闲时由 `tree-page.js` 预读 `/api/tree-page`，但不在隐藏且无可靠视口尺寸时提前执行树布局；脚本、数据缓存和进行中请求由首次进入直接复用，先用缓存同步绘制，再静默复检最新快照。空闲预热失败不提示，首次进入会重新请求；不得因预热重复发出并行快照请求，也不得把它加进首屏阻塞链。

### 速记 `notes.js`

- 速记墙是独立数据 `data/notes.json`，不是 `.canvas`。
- 支持双击空白建便签、拖拽、堆叠/扇形预览、右键/快捷删除、便签间连线、箭头、搜索、键盘浏览、缩放和平移。普通滚轮在空白、普通便签和叠摞便签上都以鼠标位置为锚点连续缩放，不再平移画面或翻动叠摞；平移保留 `Space + 拖动` 和方向键，空白左键拖动仍专用于“一刀删除”。重复点击左侧“速记”书脊会恢复 `(0,0,1)` 默认镜头。
- 速记墙正文使用现代无衬线自适应排版：短/中/长文本分别约为 `20px/650`、`18px/600`、`16.5px/560`，中文与全角字符、半角字符和换行按视觉长度分档；档位只存在 DOM，不向 `data/notes.json`、后端接口或 `localStorage` 增加字体字段。编辑结束后必须在布局落定后重绘连线，避免卡片高度变化造成端点偏移。此规则只属于速记墙，不影响起步页跨页便签或画布便签。
- 速记页只在右缘中央小签附近的 `48×72px` 热区浮现控制台入口，右缘上方或下方不触发；非模态面板提供20色随机候选、拖拽惯性、叠放展开延迟、总览与视野复位，触屏入口常驻。惯性默认 0.45、展开延迟默认 320ms，两条滑条都在对应位置显示灰色默认值提示线。面板使用高不透明度表面且不运行 `backdrop-filter`，滚轮不得传到底层速记墙；原左上角总齿轮不再重复放速记设置。
- 20色按玫瑰、琥珀、叶绿、水青、蓝、紫和自然中性七组先均衡抽色系、再抽具体颜色；存在多个候选色系时避开上一次色系。候选偏好只影响之后的新建和随机换色，已有便签不批量改写。
- 归档速记会写入学习归档目录下的 `notes.json`。
- 离开速记页或进入 BFCache 时会取消惯性、缩放、方向键 RAF 与悬停展开，并按“先停交互、后落盘”的顺序保存。

### 起步页跨页便签 `start-sticky-notes.js`

- 《速记》以外的起步页支持在非控件区域双击创建便签并立即编辑，普通说明文字也可作为落点；最近/收藏/自定义分组共用 `recent` 页面归属，空状态创建的便签也归入 `recent`。起步页默认禁止浏览器原生文字选区，只有 `input`、`textarea` 和真实 `contenteditable` 编辑区保留文字选择。
- 单击便签选中，双击重新编辑；未编辑时拖动超过 6px 才开始移动，拖动期间只合成当前便签，松手后才保存最终坐标。编辑态不拖动；选中且未编辑时，`C` 随机换色，`R` 随机调整小角度，`Shift+R` 回正，主键区 `Backspace` 删除。
- 便签随所属页面滚动，只渲染当前页面；切页会结束编辑、清除选中并把同一轻量 DOM 层移到新页面。每页最多 60 张、总计最多 240 张、单张纯文本最多 2000 字。
- 数据独立存 `data/start-sticky-notes.json`，不进入 `data/notes.json`、速记归档、画布或学习任务；不支持连线、叠摞、惯性、缩放、跨页拖动和边缘自动滚屏。

### 日历 `calendar.js`

- 日记是每天一个 Markdown 文件，带 frontmatter：`title/date/tags/updatedAt`。
- 日历聚合日记、画布活动、每日任务打卡、学习任务完成与倒数日；不读取 `data/calendar-pins.json`。`/api/calendar` 的 day 返回 `canvasActivity`（当天画布活动：标题/秒数/新建/修改标记，按时长降序）、`daily`（当天每日任务打卡摘要：**只记录已打卡的任务**——按 doneDates 判定，未打卡项不返回、不参与入场动画；`checkedCount`/`totalCount`/`items[{name,checked,totalDays}]`，条目按名称排序）、`studyCompleted`（当天**归档**的学习任务：学习归档记录中 kind=study 且落在该日的条目，按时间升序；不读未归档的 study.json）。月网格圆点与右侧三栏一一对应：`canvas`（当天画布活动：有前台时长或新建/修改）、`daily`（当天打过卡：任一每日任务 doneDates 含该日）、`study`（当天有学习归档：kind=study 记录落在该日），图例三色即画布活动 / 每日打卡 / 学习任务；旧 diary/due/focusTask/completed/focusSessions/archives 桶字段保留但不再渲染。右侧三栏在数据未到时**完全隐藏**（不渲染加载骨架白块），数据到达后整列入场动画揭示；每次翻进日历页（activate）都完整重播错峰入场——页头（含进度条）与月历卡片用 CSS 类，右侧整列（日记 + 三栏卡片错峰/条目上滑）由 `animateDayColumn({kind:'enter'})` 走 WAAPI。**非 stale 重进**走 `replayEntranceMotion`（rAF）；**stale 刷新**（用户在他页改过数据）走 `enterAfterRefresh`——数据渲染与入场动画同帧生效（同步加类、不经过 rAF），避免「新内容先完整显示一帧、再闪回动画起点」；首次进入由 render 的 initial 入场负责、不双播。倒数日卡片在数据未到时也**隐藏**（`hidden = !countdownEnabled || !countdown`，不渲染"创建第一个倒数日"占位按钮），数据到达后由 `syncCountdownCard` 以 reveal 动画淡入，避免「占位 → 重建」闪现。
- 倒数日保存在 `data/countdown.json`，起步页可开关显示。
- 倒数日数据 v2 支持最多 100 个事件，也支持真正的零事件空状态：删除最后一条后后端删除 `data/countdown.json`，GET 返回空的 v2 结构；旧版 `{event,date}` 读取时仍作为第一条事件迁移。事件选择会持久化 `selectedId`，前端不使用 `localStorage` 存事件。
- 日历右上角显示当前倒数摘要或“创建第一个倒数日”入口；单击时钟图标（空状态时点击创建入口）导航到独立 `countdown.html`，返回统一落到 `index.html?view=calendar`，由起步页恢复日历视图。摘要中的事件名和日期/剩余天数区域支持双击就地编辑，Enter 保存、Esc 取消、失焦保存，键盘聚焦后也可用 Enter/F2；编辑时隐藏摘要标签和其余句子，让输入框独占卡片剩余宽度，不能把固定宽输入框塞进原句导致右侧裁切。倒数日页面不依附日历 DOM，不使用全屏 `backdrop-filter`，也不使用原生 Fullscreen API。
- “日历”大标题同一行（`.calendar-title-row`，h1 右侧，随剩余空间拉长至最多 700px）还有一条“倒数日进度条”（复用学习页 `.study-progress-track-shell/track/fill` 结构与金色达成态），右侧是「⋯」按钮，点击展开、再点同一按钮收回（toggle）。锚定设置卡以单选行在“长度”与“开始日期”两种编辑方式间切换，未选行禁用且联动显示推导值，底部始终列出开始日、截止日与长度。用户最后选择的编辑方式保存在本地偏好 `canvas:calendarCountdownProgressMode`，对所有倒数事件生效并跨重启恢复；事件数据仍只保存窗口长度 `lengthDays`（1–9999 天，输入留空保存 = 移除长度），开始日按与截止日的纯日历日期差反推，不增加数据字段。进度 = `(长度 − 剩余天数) / 长度`，钳制 0–100%，标签只显示百分比；剩余 ≤ 0（含“就是今天”）时满条并进入金色达成态，光雾由 JS 每 ~2.8s 有限重播（`.is-overdue.is-breathing` 复用 `studyGoalRestAura/Sheen` keyframes），页面未激活、隐藏或 `prefers-reduced-motion` 时停止。进度条**常驻占位**（只跟随“日历倒数日”开关显隐）：没有事件或未设长度时显示 0% 空轨道、无事件时「⋯」禁用（title 提示先创建），首次数据到达只改变 fill 宽度（520ms 过渡），不改变标题行高度，避免入场动画期间布局跳变；进度条也参与 `.calendar-page-head-enter` 错峰入场。切换选中事件、就地编辑日期、增删改事件后行内更新（保留 DOM 让 fill 的 width 过渡生效）。布局上 `.calendar-head-main` 必须用 `flex: 1 1 auto; min-width: 0` 由 flex 分配宽度，不能靠内容固有宽度反推（进度条轨道 `width: 100%` 在固有宽度递归里被当作 auto，容器会被算窄而把进度条挤到 h1 下方）。`countdown.js` 的 `normalize` 与 `app.py` 的 `_sanitize_countdown_event` 都必须保留合法 `lengthDays`，否则在独立倒数日页保存后会丢失。
- 独立倒数日页使用不透明深色表面，左侧管理事件、右侧显示当前时钟；新建/编辑共用页面内对话框，删除需短时间内二次确认，最后一条允许删除。当前事件标题和日期支持双击就地编辑（键盘聚焦后也可按 Enter/F2），输入框内 Enter 保存、Esc 取消、失焦保存；保存先轻量更新当前标题、日期与左侧条目，再异步落盘，不重建页面。“放大”进入页面内专注视图：顶栏上移退场、左侧事件栏收至零宽、标题与底部提示淡出，四栏数字卡按同一页面布局连续放大；右上角只留低透明度退出按钮，悬停展开文字。页面未在文字输入或编辑状态时，`F` 在普通视图与专注视图之间切换，快捷键退出后不把键盘焦点锁到“放大”按钮；Esc 仍优先退出专注视图。该模式不调用原生 Fullscreen、不重建时钟 DOM、不持久化，使用 `--easing-page` / `--easing-soft` 和有限 transition，低动态模式下静态切换。计时器按真实整秒对齐，用一次性 timeout 调度。翻页内核复用 `daoshu` 参考项目的固定四层结构：静态上下页和旧上/新下叶片从建页起常驻，每次只更新文字并重启 `.go` 类，不创建或删除合成层；旧上叶片按 `280ms ease-in` 折走，新下叶片延迟 `280ms` 后按 `300ms cubic-bezier(0.37,0,0.63,1)` 落下，600ms 后提交静态底页。为严格保持参考效果，单个变化单位允许读取一次自身 `offsetWidth` 重启动画；不复制参考项目的 200ms 轮询、`drop-shadow` 滤镜、毛玻璃或 Electron 外壳。页面隐藏或离开时必须停止计时器，`prefers-reduced-motion` 下直接换值。
- 桌面 EXE 中，倒数日页可把当前事件固定为本次进程的主屏动态桌面背景；按钮按当前绑定显示“设为 / 替换 / 取消”。`wallpaper=1&event=<id>&lang=<language>` 是同一页面的只读渲染模式，只显示标题、日期、状态和四栏翻页时钟，不修改 `selectedId`，每 3 秒从既有 `/api/countdown` 同步固定事件的名称和日期；固定事件删除后自动停止。该专用 WebView 即使被 Chromium 报告为后台文档也必须继续整秒调度和轻量同步，普通倒数日页仍在隐藏时暂停。浏览器模式不显示入口，不新增 HTTP 控制接口或持久化字段。
- 放大/退出按钮使用 `aria-label` 和自身文字，不设置会触发浏览器原生提示的 `title`；退出按钮在悬停与键盘聚焦时都展开文字。倒数页从浏览器前进/后退缓存恢复时，`pageshow` 必须重启并重新对齐计时。

### 复习 `review.js`

- 复习卡片是独立一等数据，保存在 `data/review.db`；后端绝不扫描或改写 `.canvas`。数据库使用 `PRAGMA user_version` 管理 schema 版本，连接按请求短开短关并启用外键；schema 和 API 都不保存画布路径、节点 id 或来源占位字段。
- `review_cards` 保存 `prompt/answer/notes/status/deck_id`、时间戳和 Leitner 调度字段；`review_decks` 保存有序卡组，`review_tags` 与 `review_card_tags` 保存去重标签及多对多关系。`review_settings` 是单例设置行，保存全部/未分类/单卡组复习范围、每轮 10/20/50 张与到期/随机/薄弱顺序；旧的 `require_reveal` 字段只保留为数据库兼容位，当前界面始终允许直接评分。删除卡组不会删卡，关联卡片回到“未分类”；若它正是复习范围则自动回到全部卡组。无卡片引用的标签会自动清理。`review_events` 为每次评分留事件记录和问题快照，删卡时只把事件的 `card_id` 置空，历史统计继续保留。今日复习数从事件表计算，不使用 `localStorage`。编辑器节点模型中不存在 `review` 字段，模板也不需要对复习数据做特判。
- 页头把“自由复习 / 计划复习 / 卡片库”作为三个同级入口，复习卡片与卡片库叠放在固定高度的共享舞台内切换，页头不随内容高度重新居中。计划复习顶部提供复习范围、当前轮次、设置和“？”快速说明，无需查看答案即可评分；支持 `Space` 查看答案、`1/2/3` 评分、`N` 换卡，达到每轮数量后停在“本轮完成”，由用户决定是否再开一轮。自由复习复用同一范围内全部 active 卡片，以无重复洗牌队列无限随机浏览；只保留范围、答案、临时草稿，支持 `Space` / `1` 查看答案和 `N` / `D` 下一张，不读取每轮数量/出题顺序、不写评分事件、不改熟练度或到期日。卡片库默认只显示搜索、四个状态、卡组筛选、新建卡组和编辑，并提供独立“？”说明完整的到期推送、评分间隔、排序、熟练度、暂停/归档/删除及卡组标签语义；复选框与批量移动/改状态/删除只有进入“批量整理”后才出现。卡片编辑器默认只展开问题和答案，标题旁的可输入卡组框支持选择已有卡组、留空保持未分类，或在保存卡片的同一数据库事务中创建新卡组；补充说明、标签和状态仍收在“更多选项”。
- 复习页翻入时根层保持静止，标题、页签、统计、纸面和纸面内容短距离错峰渐入；自由/计划/卡片库切换、批量栏、筛选结果、列表项和卡片/卡组弹窗使用有限过渡并服从 `prefers-reduced-motion`。自由复习的“下一张”、计划复习的换卡和评分后换卡都原位直接更新卡片内容，不播放卡片内部入场动画；换卡按钮不维护专用关键帧或脚本反馈，直接复用“查看答案”按钮同款的悬浮上移与按下回落缩放。列表项的临时入场类仍在动画完成或离页时立即清理，只更新卡组元数据时不重播卡片列表。复习页自身、纸面与卡片列表保留滚轮/触控板滚动，但不绘制原生滑条，避免换卡或翻页位移的中间帧短暂触发滑块闪现。复习纸面和弹窗不使用 `backdrop-filter`，避免翻页时持续模糊合成；勾选卡片只原位更新选择态，不得为一次勾选重建整张列表，搜索输入按短延迟合并重绘。
- 计划复习池在同一自然日重复进入时复用已经渲染的状态，不为页面激活重新写 DOM；跨本地日期后自动重新读取，首次读取完成前不展示静态空状态。评分请求进行中会锁定评分与换卡入口，避免双击或键盘重复触发让同一张卡连续升级。
- 间隔天数：`[0, 1, 3, 7, 16, 35]`。新卡当天到期；“记得”升级盒子，“模糊”原盒且至少隔天，“不会”回到 level 0。
- `/api/review-pool` 只查询设置范围内的 active 卡，按设置顺序返回本轮 10/20/50 张，并同时返回完整待复习数、设置和各卡组待复习数。`/api/review-cards` 返回卡片库、卡组、标签及未分类数量；批量读取卡片标签时按 400 个 card id 分块查询，不能拼出可能超过 SQLite 绑定变量上限的单条 `IN (...)`。
- 问题按纯文本展示；答案和补充说明支持 Markdown、MathJax 与 Mermaid。自测草稿明确为临时输入，不落库。

### 专注 `focus.js`

- 支持番茄钟和正计时，运行状态存在 `localStorage`，刷新后可恢复。
- 专注页有“专注钟 / 每日任务”两种内部视图；已在专注页时重复点击左侧“专”切换。每日任务是约 800px 宽的居中纸白卡片清单，分组使用可折叠标题分区和嵌套引导线，不再使用右侧把手、滑出侧栏或 Tab 开合。专注、暂停、休息和等待收尾均锁定在专注钟，完成收尾或重置后才允许切换；完成每日任务时原位保留，不能清场隐藏或自动收起所在分组。
- `start.js` 在专注页参与外层书页过渡前必须先调用 `CanvasFocus.prepareActivate()` 同步确定 `hidden` / `inert` / `aria-hidden`；页面可见后再由 `activate()` 刷新，离开时由 `deactivate()` 取消过期请求、内部过渡、错峰计时器和拖拽临时态。每日任务有缓存时先显示旧 DOM 再静默刷新，数据签名未变不重建也不重播入场；首载无缓存时使用稳定卡片骨架。所有读取使用请求序号和 `AbortController`，每日任务写操作会使更早的后台读取失效，避免旧快照回写。
- 专注钟与每日任务共享一个固定为 `minmax(0, 1fr)` 的 grid 叠层，根容器不滚动；计时器层可独立滚动，每日任务外层固定不滚动，只由居中约 800px 的 `.focus-daily-scroll` 承担纵向滚动，并隐藏原生滚动条但保留滚轮、触控和键盘滚动。交叉过渡期间较长清单不得撑高计时器层，也不得因滚动条占位改变标题、加号或卡片宽度。内部视图层切换只改变透明度；每日任务的页首、分组和卡片允许使用有限的纵向位移与轻微缩放弹性错峰，但必须以恒等位置收尾，不能影响 grid 尺寸。首次无缓存进入时，页首与随后到达的任务数据共用同一个 entrance generation：骨架只负责退场，禁止再给整个列表叠加第二套揭示动画。完成态不再降低整张卡片透明度，正文弱化通过可过渡的内容层完成，完成/撤销反馈只使用勾选、划线和卡片边缘的一次性动画，不能给任务摘要文字添加闪烁脉冲。
- 专注钟桌面稳态在共享 grid 中使用固定的轻微右下相对偏移，≤900px 恢复无偏移；标题、工作台、控制区与计时环的重新入场只做透明度和环形进度绘制，不使用位移或缩放，避免外层翻页结束后仍发生第二次位置收尾。
- 每日任务全部完成且当天尚未回顾时，隐藏普通“今天 n / n 完成”汇总，在 `.focus-daily-scroll` 之外显示覆盖整个专注内容区的半透明“微光聚星”庆祝层，让起步页背景色仍可透出；左侧书脊保持可用，庆祝不受任务数量、滚动位置或列表裁剪影响。初载或重新进入已完成清单只显示静态态且不得主动聚焦“回顾今日”，避免翻页后无端出现焦点圈；仅当前交互由未完成跨到全部完成时，才先按可见顺序自下而上反向错峰、缓慢淡出任务卡与页首，再衔接光点汇聚、主星回弹、文字和按钮入场，交互庆祝完成前可把键盘焦点交给按钮。`entering` 交接到 `visible` 时底层滚动区必须直接保持隐藏，不得因移除卡片退场动画后再补一次外层淡出而闪现。按钮约 260ms 交叉退场后恢复原清单、原滚动位置及最后完成任务的焦点，并在当天持久化回顾日期。庆祝 phase 固定为 `hidden / entering / visible / leaving`，期间底层清单必须 `inert` 且对辅助技术隐藏；接口确认同一完成态时只更新文案，不能中断 `entering` 或回顾退场，任一撤销清除当天回顾日期并收起覆盖层。所有计时器受 generation 保护，快速反复勾选或请求回滚必须以最新状态为准，低动态模式直接切换静态态；覆盖层与滚动区均不得使用持续模糊或常驻 `will-change`。
- 只可绑定每日任务；专注完成后写入 `data/focus.json`，并按需同步每日任务分钟与完成状态。历史记录中的旧学习任务标题只作静态展示。
- 支持音效、柔和噪音、时长偏好、目标/收尾记录、记录编辑/删除、Zen 模式；柔和噪音音量默认 50%，滑条中点显示灰色默认值提示线。
- 每日任务是独立清单 `data/daily.json`，每天重置勾选状态，但累计天数和分钟保留；v3 起每条任务记录 `doneDates` / `minutesByDate`，用于专注页任务详情中的打卡月历，并可用 `targetDays` 设置基于历史 `totalDays` 的累计打卡目标（`0` 表示未设置，上限 3660 天）。可选 `milestones:[{id,name,days}]` 保存命名小目标，用户侧不设小额数量限制，异常数据安全上限为 50；天数必须唯一且位于 `1..targetDays`，达成态只由 `totalDays >= days` 推导。高级设置先写任务编辑草稿，最后与总目标一起经 `/api/daily-update` 原子保存。任务卡和详情长期进度条以非按钮圆印章显示节点，超过 12/24 个时逐级缩小标记以保持密集进度条可读；悬停/键盘聚焦显示即时说明，桌面点击无操作、触屏轻触只揭示说明；今日分钟目标仍保留在编辑器与详情面板。
- 每日任务只有一套详情入口：卡片不再显示独立“日”按钮或列表内打卡浮层，点击任务名称、键盘激活名称按钮或点击行内非控件区域统一打开居中详情；勾选、里程碑和 `⋯` 不得误开。桌面详情最大约 1080×780px，使用高不透明度表面与固定约 48–58px 高的月历行，统计区只保留连续、累计和最佳三项，不显示今天分钟或累计专注分钟；月份导航、累计目标/里程碑、最近打卡、今日打卡、绑定专注和编辑仍保留。窄屏改为单列滚动，≤640px 接近全屏。详情标题保留单行省略号，但行盒必须给中英文及拉丁字母上下伸部留足空间；Esc 或点击遮罩关闭详情时不强制把焦点还原到任务名称，避免退出后留下突兀焦点框。任务行装饰箭头继续在鼠标悬停或键盘焦点进入时使用绿色强调。
- `pagehide` 会持久化运行态、停 ticker 并暂停 AudioContext；BFCache `pageshow` 会按保存时间补算经过秒数、恢复 ticker/显示和需要继续播放的噪音。

### 回收站 `trash.js`

- 右栏列出 `canvases/回收站/` 下的画布；左栏是恢复目标分组。
- 点击、拖拽、键盘数字键都可恢复到目标分组。
- 一键清空需要确认，并永久删除回收站内容。

## 8. AI 功能现状

- AI 配置存在 `data/ai.json`：`apiKey`、`model`、`baseUrl`。前端只看到是否有 Key 和末尾掩码，不长期保存完整 Key。
- 默认 `baseUrl` 是 `https://api.deepseek.com`，默认模型是 `deepseek-chat`。调用接口是 OpenAI 兼容 `/chat/completions`。
- “聊天”不发送内置 system 提示词，不预设角色、语气、语言或 Markdown 格式；连续对话只发送最近的用户/助手消息，单次请求只发送当前用户消息。五种画布操作仍必须使用 `ai_plan.py` 的严格 V2 计划提示词，不能因聊天无提示词而一并移除。
- 单次请求上下文最多保留 40 条消息。普通聊天输出上限为 `8192` 且不强制深度思考；画布计划使用 `32768` 与高质量思考预算，超长会返回明确错误，不会把截断 JSON 当成可执行计划。
- `call_ai_chat()` 会给高质量任务尝试 `thinking` / `reasoning_effort`，给结构化任务尝试 `response_format`。OpenAI 兼容服务以 400/422 明确拒绝这些可选参数时，只剥离被拒绝的能力组重试一次，并按 `baseUrl + model` 在当前进程缓存；不要把缓存落盘。
- V2 后端入口是 `/api/ai-plan`。请求动作固定为 `create_graph/create_mindmap/extend_branch/supplement/refine`，携带页面内对话、界面语言、画布语义上下文和编辑器表现快照；响应是只读的 `plan.version:2`，接口本身绝不写画布。
- V2 计划只允许创建 `card/index/preview/sticky/code/table`，已有节点只能由 `refine` 更新标题/正文，禁止删节点和改类型。已有对象必须使用请求上下文里的真实 ID；新增节点使用 `n1/n2…` 临时引用。普通计划拒绝自连和重复边；导图计划只用 `card`，并校验单根、无循环、无多父级和无交叉边。
- V2 默认提示模型在用户未指定时生成 6–12 个节点，解析器硬拒绝超过 40 个新增节点。首次回复校验失败会自动要求模型完整修复一次；第二次仍失败就返回明确错误，不降级为可注入内容。
- `CanvasModule.describeAIContext({scope})` 是 V2 的唯一画布语义入口。选区最多 60 个节点、每节点 2000 字；整张画布最多 100 个节点、每节点 600 字；两者总正文最多 60000 字、连线最多 200 条。它只发送 `card/index/preview/sticky/code/table`，排除装饰、附件、任务簿投影、计时器和尺子；上下文含节点位置、是否属于导图、节点/连线内容指纹与截断报告，选区另含严格导图根与父子关系报告。
- `CanvasModule.describeAIPresentation()` 返回当前画布/导图表现快照。普通网络优先使用当前简洁/完整模式的显式新建连线默认，没有显式曲线时固定使用 `branch`（枝桠曲线）；导图优先使用当前显式曲线，否则跟随当前预设，预设缺失回退经典纸张预设的枝桠曲线。
- `CanvasModule.applyAIPlan(plan, options)` 是 V2 的原子执行入口。它按预览勾选过滤操作，默认不勾选连线移除，取消新节点会丢弃依赖边，导图根不可取消、取消父节点会级联取消子树；应用前核对节点标题/正文/类型和连线端点/标签指纹。更新只写原节点标题/正文，未修改字段、样式、批注和默认位置保留；普通网络只布局新增节点，只有显式 `relayoutSelection:true` 才移动目标选区。失败无通知回滚，成功只压入一条历史并触发一次 `onChange`。
- 新建导图通过现有 `createMindmapFromOutline()` 接入唯一 `mindmapRoot`、预设样式、布局、聚焦与导图模式；扩展分支要求实时单选一个有效导图节点，只接入严格新子树、继承父分支样式并仅排版新子树。两条路径都由 AI 外层统一提交一次历史和保存。
- `assets/ai.js` 已迁到 V2 面板：固定展示聊天、生成卡片网络、生成导图、扩展导图分支、基于画布补充、整理精炼六种操作；模式与选区只改变推荐，不自动执行。补充/整理明确选择“选区 / 整张画布”，有选区时默认选区；聊天仍走 `/api/ai-chat`，五种画布动作只走 `/api/ai-plan`。AI 助手在桌面端是距窗口 12px 的悬浮停靠侧栏，默认 520px，允许从左边缘在 440px 到 `min(820px,72vw)` 间拖宽、方向键调节和双击复位；设置与帮助覆盖主工作区而不挤压底部编辑器，≤640px 退化为不可拖宽的全屏侧栏。六种操作使用三列两行常驻分段控件，并与输入框收在一张内嵌的纸白控制坞中；空状态的三条中英文示例以一行三项的黑白“灵感起点”呈现，常见 720px 高窗口必须完整显示。输入区默认三行并在达到 `min(240px,28vh)` 后内部滚动；预览清单不再建立独立纵向滚动区，AI 内必要滚动容器使用无系统箭头的自动显现细滚动条。输入区只保留一个随操作切换的主按钮：聊天时显示发送箭头，画布操作时显示“生成预览”，Enter 执行当前所选操作，Shift+Enter 换行。问号帮助使用“3 步上手 / 六个按钮 / 选区与预览 / 设置与排错”四页操作速查，不保留左侧圆点或横向滚动目录；六个操作卡片的“使用这个”只关闭教程、选中真实操作并聚焦输入框，不填词、不发送也不改画布。后五种画布操作各有两条中英文示例指令，点击示例会选择对应操作、关闭教程并把文字带入输入框，但不发送、不生成预览、不改动画布，且保留当前目标范围。
- V2 预览显示动作、目标、节点/连线数、导图根与层级、最终线型、截断警告和摘要。节点与连线逐项勾选；新增/更新默认勾选，连线移除默认不勾选；取消新节点会同步取消依赖边，导图按子树级联。普通画布的“重新排版所选范围”默认关闭；预览后画布指纹变化时拒绝应用并要求重生成。
- 旧 `/api/ai-compose`、compose 提示词/解析器和 `CanvasModule.injectCanvas` 已删除。`AI笔记创作指南.md` 只保留为外部创作参考，不是运行时提示词或打包资源；不要把这些旧链路接回面板。
- 前端 AI 上下文模式有“连续对话”和“单次请求”，偏好键是 `canvas:ai-context-mode:v1`。聊天历史是页面内存，刷新后重新开始。
- AI V2 不新增用户数据文件、不迁移或清空 `data/ai.json`，也不提升 `.canvas` 文件版本。计划接口只读上下文；只有用户在预览中确认后，前端才按现有保存链写画布。

## 9. 导入、导出、归档

- Markdown 导入/导出的前端按钮当前暂时下线：起步页不展示“导入 MD”，编辑器不展示“导出 MD”。`start.js` / `editor.js` 中的处理以及 `/api/import-markdown` / `/api/export-markdown` 仍保留，等功能重做时复用。当前仍可见的画布导出入口只有 PNG。
- Markdown 导出会生成一组互相双链的节点 `.md` 文件；若画布含笔记坞，还会在结果的 `笔记坞/` 子目录按去重后的笔记标题输出每篇原始 Markdown。响应中的 `nodeCount` / `noteCount` 分别计数，`count` 是两者之和。独立 `table` 节点按可选标题 + `body` 中的规范表格源码导出；装饰、图片、PDF、MD 附件不导出，连到这些被跳过对象的边也会被邻接过滤。
- Markdown 导入只接受文件夹第一层 `.md` 文件；开头连续的 `[[标题]]` 行表示双链。单文件最多 4MiB、总计最多 64MiB、一次最多 2000 个文件；单个连通簇超过 240 个节点时改用确定性网格，避免 O(n²) 力导向长时间占满 CPU。
- PNG 导出由前端 `CanvasModule.exportImage` 生成，尽量包含节点、边、手写、图片、形状和基础背景；编辑辅助底纹与尺子不导出，PDF 节点不完整导出，公式可能降级。导出副本必须移除 `.culled`，并按节点数据补齐视口外未常驻的图片；图片转 data URI 最多四路并发且同 URL 复用同一转换 Promise，避免漏图或瞬时占满内存。
- 编辑器顶栏“归档”只移走当前画布中已划删除线的正文节点及其相邻连线，画布本身保留，并在 `data/画布归档/` 留轻量记录。

## 10. 桌面壳和打包

- 桌面方案是 pywebview + WebView2，不是 Electron。
- `desktop.py` 会先启动本地服务，再打开 `index.html?desktop=1` 或 `editor.html?desktop=1&file=...`。
- Windows 普通桌面启动按 `ROOT` 保持一个主实例：第二次启动不再创建服务和 WebView2，而是通过 `desktop_instance.py` 的本地认证命名管道唤醒已有窗口。传入另一张有效 `.canvas` 时，当前窗口干净才在原窗口切换；当前画布 dirty 时只唤醒并拒绝切换；传入同一画布只唤醒、不刷新。窗口尚未就绪时只保留最后一条有效请求。动态背景子进程及 `--no-browser` / `--port` / `--allow-dir` 服务模式不参与这项主实例限制。
- 主实例状态只短期写在 `%TEMP%/relatum-desktop-<ROOT哈希>.json`，含随机管道和认证材料；正常退出仅删除仍属于自己的状态，异常退出后的陈旧文件由下一主实例覆盖。IPC 只接受窗口激活与已重新验证的 `.canvas` 路径，不得扩成通用控制面。
- Windows 下做了无边框窗口：隐藏原生标题栏、保留系统最小化/最大化动画、DWM 圆角、关闭时检查 dirty。
- `desktop-shell.js` 负责窗口按钮、pywebview ready 队列、dirty 标记和桌面 session 标识。
- 倒数日动态背景仍只发布一个 `Relatum.exe`，但背景 WebView2 必须由该 EXE 的隔离子进程承载，不能再与主窗口共享 WinForms UI 线程。主进程通过本地 Windows 命名管道管理启动、切换、删除通知和停止，并独立持有托盘与数据根互斥锁。子进程向 `Progman` 请求一次桌面壁纸宿主后，必须找到拥有 `SHELLDLL_DefView` 的顶层窗口及其后方、同属 Explorer 且覆盖主屏的专用 `WorkerW`；`SHELLDLL_DefView` / `SysListView32` 会绘制静态壁纸，绝不能作为背景父窗口，也不能按类名选择任意小型 `WorkerW`。挂载成功后才允许主进程返回 `active:true`；不能调用会强制 `Activate()` 的 `window.show()`。它不替换系统静态壁纸，只支持 Windows 主显示器和本次运行，不自启、不持久化。动态背景启用时关闭主窗只隐藏到托盘；托盘“取消桌面背景”会停止子进程并重新显示主窗，“退出 Relatum”仍执行 dirty 确认。子进程启动失败、Explorer 宿主丢失或同一数据根已有背景实例时必须安全停止，不能留下普通悬窗或虚假的启用状态。
- WebView2 用户数据默认在 `%LOCALAPPDATA%\Canvas\WebView2`；启动时给 HTTP 磁盘缓存和媒体缓存分别设置 64MiB / 32MiB 参数上限。这不是整个用户目录或 Code/GPU Cache 的硬总上限，不要为清缓存误删 Cookies、localStorage 等用户状态。
- 窗口状态版本是 `2`，尺寸以逻辑像素原子保存到 `data/window-state.json`。桌面壳安装无边框样式后必须先在普通态落实保存的还原尺寸，再按记忆状态最大化；否则最大化启动后的首次还原会使用样式切换前留下的错误 normal placement。
- 构建脚本输出 `Relatum-release/Relatum.exe`、同级 `Relatum.exe.config` 和 `_internal/`。配置文件通过 .NET Framework `loadFromRemoteSources` 允许加载被 Windows 标记为来自 Web 的随包 pythonnet 程序集；分发时不能漏掉。不要再写旧的 `画布-release`。
- 构建会整体替换 `Relatum-release/`；若目录内已有 `canvases/`、`notes/` 或 `data/`，默认拒绝覆盖，除非显式 `-ForceReplaceUserData`。
- 构建环境参考 `README.md`：Python 3.9-3.12，`pywebview==6.2.1`，`pyinstaller==6.20.0`，`pystray==0.19.5` 提供 Windows 托盘，Pillow 用于应用与托盘图标。

## 11. 验证清单

文档-only 改动：

- 至少重新读取 `AGENTS.md`，确认编码和结构正常。
- 可用 `Select-String` 或 `rg` 检查关键章节是否存在。

Python 改动：

```powershell
python -m py_compile .\app.py .\ai_plan.py .\desktop.py .\desktop_instance.py .\windows_wallpaper.py .\packaging\make_icon.py .\packaging\make_font_subset.py
```

改动 AI 计划协议、提示词、结构修复或 OpenAI 兼容参数降级时，还要运行：

```powershell
python -m unittest .\tests\test_ai_plan.py
node .\tests\ai-canvas-plan-regression.js
node .\tests\ai-canvas-plan-contract.js
node .\tests\ai-panel-v2-contract.js
```

前端 JS 改动：

```powershell
node --check .\assets\canvas.js
node --check .\assets\sticky-palette.js
node --check .\assets\notes.js
node --check .\assets\ai.js
node --check .\assets\ai-canvas-plan.js
node --check .\assets\editor.js
node --check .\assets\i18n.js
node --check .\assets\ruler.js
node --check .\assets\canvas-import.js
node --check .\assets\node-matrix.js
node --check .\assets\canvas-timer.js
node --check .\assets\start.js
node .\tests\sticky-palette-contract.js
python -m unittest .\tests\test_sticky_palette.py
node --check .\assets\start-sticky-notes.js
node --check .\assets\countdown.js
node --check .\assets\review.js
```

改动起步页书脊游标、悬停回位或低动态降级时，还要运行：

```powershell
node .\tests\start-spine-motion-contract.js
```

只检查改过的手写 JS；不要对 `assets/vendor/` 里的压缩库做人工格式化或随意 check。
改动画布前台计时、年度足迹“画布”镜头或画布活动账本时，还要运行：

```powershell
python -m unittest .\tests\test_canvas_activity.py
node .\tests\canvas-activity-contract.js
```

改动学习/树状/速记三页前台计时、绿色附加统计或起步页活动账本时，还要运行：

```powershell
python -m unittest .\tests\test_start_page_activity.py
node .\tests\start-page-activity-contract.js
```

并使用隔离的 `RELATUM_DATA_ROOT` 启动本地服务，实际验证编辑器前台计时、失焦暂停、活动页默认镜头、镜头记忆、热力日详情和画布星图；结束后关闭测试服务，不得读写真实用户账本。

改动简洁画布样式面板的线型入口时，还要运行：

```powershell
node .\tests\clean-style-contract.js
```

改动 Markdown 表格解析、序列化或内嵌表格定位时，还要运行：

```powershell
node .\tests\markdown-table-regression.js
node .\tests\table-compact-contract.js
```

改动尺子几何、交互或导出隔离时，还要运行：

```powershell
node .\tests\ruler-regression.js
node .\tests\ruler-contract.js
```

改动 `.canvas` 内容合并或编辑器文件拖入时，还要运行：

```powershell
node .\tests\canvas-import-regression.js
node .\tests\canvas-import-contract.js
python -m unittest .\tests\test_canvas_import_library.py
```

改动起步页外部画布/文件夹导入时，还要运行：

```powershell
python -m unittest .\tests\test_external_canvas_import.py
node .\tests\start-external-import-contract.js
```

改动起步页画布库扫描、最近/未分组索引时，还要运行：

```powershell
python -m unittest .\tests\test_recent_groups.py
node .\tests\start-recent-sync-contract.js
```

改动“工具 → 节点矩阵”、批量节点创建或矩阵布局时，还要运行：

```powershell
node .\tests\node-matrix-regression.js
node .\tests\node-matrix-contract.js
```

改动“工具 → 倒计时 / 正计时”、计时器选择或计时运行时，还要运行：

```powershell
node .\tests\canvas-timer-regression.js
node .\tests\canvas-timer-contract.js
```

改动“工具 → 笔记坞”、Markdown 层级解析、选区快照或笔记导出时，还要运行：

```powershell
node .\tests\markdown-notebook-regression.js
node .\tests\markdown-notebook-contract.js
node .\tests\markdown-regression.js
node .\tests\markdown-global-contract.js
node .\tests\markdown-fuzz-regression.js
python -m unittest .\tests\test_markdown_notebook_export.py
```

改动起步页顶层工作区、托管笔记库、双链或笔记图片时，还要运行：

```powershell
python -m unittest .\tests\test_notes_library.py
node .\tests\note-workspace-contract.js
node .\tests\note-live-editor-regression.js
node .\tests\markdown-regression.js
node .\tests\markdown-global-contract.js
node .\tests\markdown-fuzz-regression.js
```

可先用 `tests/note-live-editor-harness.html` 做不连接笔记库的纯前端语法/组件冒烟；真实保存链验证必须使用隔离的 `RELATUM_DATA_ROOT`，至少覆盖工作区恢复与切换几何稳定性、时间戳笔记、行内文件夹/重命名、连续“输入一个字符→切下一篇”的节奏测试、外部改写静默刷新与碰撞历史、双链创建与反链跳转、粘贴图片、文件/文件夹三类右键菜单、Explorer 拖入与系统回收站替身；每次笔记点击都必须在同一交互帧显示新选中态，不能等待上一笔保存，缓存命中时正文和聚焦也应同步完成。新建文件夹、新建笔记和冷启动恢复当前笔记都必须展开完整父级并显示选中行；行内改名失焦后紧接的一次树点击不能被吞掉。文件夹收放必须验证折角状态、子树动画中间态、快速反向操作和低动态立即完成，且不得整树重绘。浅色两栏必须与顶栏使用同一背景色，展开目录须有可辨认且对齐折角中心的层级线，顶栏须显示完整路径面包屑，链接栏展开不得改变正文宽度。从“笔记”冷启动后切回“画布”时，书脊黑色游标与彩色跟随层都要在可见布局上重新测量，所有入口中心误差不超过 1px。结束后关闭测试服务，不得读写真实 `notes/`。

`markdown-fuzz-regression.js` 必须通过独立子进程和超时运行，防止解析器死循环把整个测试进程一起挂住；新增块语法时要把空标记、未闭合定界符和读取位置不前进的边界语料一并加入。

改动“工具 → 镜头册”、镜头相机、缩略图或演示锁定时，还要运行：

```powershell
node .\tests\canvas-scenes-regression.js
node .\tests\canvas-scenes-contract.js
```

改动“工具 → 任务簿”、顶级任务投影、工作流保护、计时或专注回看时，还要运行：

```powershell
node .\tests\canvas-taskbook-regression.js
node .\tests\canvas-taskbook-contract.js
python -m unittest .\tests\test_taskbook_focus.py .\tests\test_taskbook_archive.py
```

改动“工具”入口或七个工具的视觉系统时，还要运行：

```powershell
node .\tests\tools-neutral-ui-contract.js
```

改动普通节点宽度或左右尺寸手柄时，还要运行：

```powershell
node .\tests\node-resize-contract.js
```

改动画布图片/附件生命周期、PDF/Markdown 激活逻辑、连线几何缓存、空间索引或空标签策略时，还要运行：

```powershell
node .\tests\canvas-performance-contract.js
python .\tests\generate-performance-fixtures.py <隔离的 Relatum 运行目录>
```

改动编辑器首屏脚本、延迟运行时、手写字体或背景揭幕/缓存时，还要运行：

```powershell
node .\tests\editor-opening-performance-contract.js
```

性能夹具只能写入一次性隔离运行目录，禁止指向仓库真实 `canvases/` 或 `data/`。`?perf=1` 才会暴露 `window.__relatumPerfSnapshot()` 与隐藏的 `#relatum-perf-snapshot`；正常页面不得创建调试全局、采样循环或输出节点。

本地服务冒烟：

```powershell
python .\app.py --no-browser --port 8799
Invoke-WebRequest http://127.0.0.1:8799/api/runtime
```

如果启动了服务，完成后要关闭对应进程。前端/交互改动应打开实际页面验证，尤其是 `index.html`、`editor.html` 和涉及的功能页。

桌面或打包改动：

- 先读 `README.md` 的“构建 Windows 桌面版”章节。
- 只在用户要求或任务确实需要时运行 `build-desktop.ps1`。
- 改动主实例、窗口激活或桌面 IPC 时运行 `python -m unittest .\tests\test_desktop_instance.py .\tests\test_windows_wallpaper.py .\tests\test_runtime_paths.py`，并用同一数据根连续启动多次验证只有一个主窗口；WebView2 的浏览器/GPU/渲染器子进程不算重复主实例。
- 验收 `Relatum-release/Relatum.exe`、同级 `Relatum.exe.config`、`_internal/assets/`，确认没有把 `AI笔记创作指南.md`、`canvases/` 或 `data/` 打进包里。

## 12. 常见坑

- README 可能滞后；本文件和源码优先。
- 旧文档里的 `kind:"text"` 不应作为新节点类型继续扩展。当前语义是迁移/兼容到 `index`。
- 专注页现在确实有柔和噪音选项；不要照旧文档写“没有白噪音/噪音功能”。
- PDF/MD 附件是可连线节点，也会出现在图谱里；但 Markdown 导出会跳过它们。
- `graph-engine.js` 与 `graph-gl.js` 是性能关键路径。WebGL 后端只画几何，中文文字不要塞进 GPU 字体图集。
- MathJax 是首个公式源触发的空闲异步加载。不要让普通文本节点无条件加载或排队公式排版。
- 日历保存日记有草稿和串行保存链；不要用简单 debounce 覆盖已有防竞态设计。
- 学习页迷你画布是 iframe 内嵌编辑器，隐藏顶栏并锁普通模式；不要把完整编辑器偏好写乱。
- 构建脚本、PowerShell 启动脚本尽量保持 ASCII，避免 Windows PowerShell 5.1 编码问题。

## 13. 改功能时如何同步本文

每次新增或改动功能，至少检查：

- 新增入口文件或模块：更新“源码地图”。
- 新增持久化文件、字段、localStorage key：更新“运行时和数据位置”。
- 新增/删除 API：更新“后端路由总览”。
- 改节点、边、附件、模板、AI 计划执行：更新“画布编辑器契约”或“AI 功能现状”。
- 改桌面/构建：更新“桌面壳和打包”。
- 改验证方式：更新“验证清单”。

保持这份文档像地图，不要把具体任务争论、临时猜测、一次性 TODO 塞进来。

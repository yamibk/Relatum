# 笔记扩展、latex辅助输入 1.2 与文件染色

## 使用与边界

“笔记设置 → 扩展”（`extensions`，位于笔记本之后）管理随软件附带的离线扩展。第一项中文卡片标题为“latex辅助输入 1.2”，英文为“LaTeX Input Assistant 1.2”，内部 ID 仍为 `latex-input`，版本元数据 `1.2.0`。总开关默认关闭；自动展开、自动分式、Tab 跳出、矩阵快捷输入、数字下标、选区快捷包裹和括号自动放大各自默认开启，可分别关闭。旧启停及自动展开偏好保留，新增默认值不在启动时回写。列表卡片只提供名称、说明、总开关、“配置”入口及错误重试；点击配置或搜索结果才创建详情，不加载公式运行时。

扩展分别增强笔记编辑器或文件树。第二项“文件染色 / File Colors 1.1”（`file-colors`，版本 `1.1.0`）默认关闭，按需加载独立文件树运行时；详情提供四项外观滑条、效果预览、参数恢复、清空颜色记录及使用说明。具体存储、文件生命周期和验证见 [文件染色](note-file-colors-2026-10-27.md)。不提供安装包、在线市场、自动更新、Obsidian 兼容层，也不迁移 Mermaid、Quiz 等现有功能。所有资源继续归 `notes` 功能；禁用笔记时沿用现有静态资源权限。源码修改无需增加依赖或构建应用；已发布的旧桌面程序仍需下次打包才包含新功能。

## 设置面板

扩展分类使用共享设置外壳的 `layout:'fill'`，保留左侧分类和原关闭、恢复入口。配置在同一个设置弹窗的右侧打开独立详情，顶部“← 扩展”返回列表；没有叠加弹窗。详情有“基础设置 / 片段管理 / 使用说明”三个页签，支持方向键与 Home/End。基础设置逐行显示开关及简短说明；使用说明只显示文字例子，不启动 MathJax。

LaTeX「使用说明」页的细滚动条贴齐设置容器右边缘；仅此页签可见时向右延伸宽窗 32px、720 CSS px 以下 22px，以标题、页签及正文的等宽留白补偿保持内容对齐。片段编辑底部的保存、取消、恢复及状态区域保留相对定位整体下移 6px；仅片段管理可见时，另外借用设置页脚顶部的 12px 留白，将页脚最小高度由 59px 缩为 47px、顶部内边距由 12px 缩为 0，使受限高度下的表单和操作区获得额外 12px 空间，分类恢复入口保留原底部位置。原有字段及滚动行为保留。样式位于 `assets/note-extensions.css`，按用户要求未运行检查、测试、构建或打包。

LaTeX 详情沿用纯黑白灰：输入框、文本域与按钮取消向外扩出的聚焦描边，改用控件内部的轻微边框、底色或内侧反馈，键盘焦点不被滚动区裁切。搜索与添加按钮等高，表单统一 38px 最小高度、8px 圆角；列表触发词与右侧触发词输入框使用 Cascadia Mono / Consolas / Liberation Mono 本机等宽字体、14px 中等字重、轻微字距并禁用连字，使 `@a` 等原始触发组合清晰可辨。名称与模板摘要分开呈现，关闭片段只弱化触发词，不降低整行透明度。基础设置说明、使用示例和空状态同步采用清晰的文字层次；样式限定 LaTeX 详情，深浅主题跟随设置变量，短暂过渡服从系统及笔记低动态。

“匹配方式”复用 `RelatumReviewControls` 的自制下拉，保留原 select 的 `start/suffix/any` 值，以 `change` 更新原会话草稿。选项文字及片段值分别显式刷新、同步；弹层位于同一 dialog 内的独立容器，避开字段滚动裁切并按视口向上或向下展开。首次实际进入片段管理才创建组件；展开前通过可选 `onPopoverOpen()` 完成设置内容位移及原浮层交接，切页、切片段、返回、语言变化和离场收起，销毁释放组件和容器。共享脚本纳入笔记加载链，样式由笔记设置去重加载，资源权限增加 `notes`，关闭 AI 与复习功能时仍可使用，不加载 AI 或公式运行时。

片段管理提供本地搜索和“全部 / 常用 / 希腊字母 / 函数与重音 / 集合与符号 / 矩阵与环境 / 自定义”过滤。宽窗左侧为单选列表，显示触发词、双语名称及省略占位的模板摘要；右侧集中启停、编辑、保存/取消、恢复或删除，列表中不再重复摆放操作按钮。设置外层不滚动，列表和编辑字段分别在并列区域滚动，右侧编辑字段区隐藏滚动条外观，保留滚轮与键盘滚动，左侧列表继续显示细滚动条；编辑操作固定在字段区下方。视口不超过 900 CSS px 时列表与编辑器单列切换，选中后聚焦实际输入框，“← 片段列表”返回；400×720 窗口仍保留保存入口。

页签、筛选、搜索、选择和按片段 ID 保存的草稿只存在本次设置会话内。切片段、切页签、返回扩展列表和切分类保留草稿；取消只丢弃当前草稿，保存成功即时写入既有偏好。真正关闭设置、隐藏/最小化引起关闭，以及分类/全部恢复时清理草稿；关闭动画期间不重排面板，快速反向重开不执行过期关闭收尾。无新增偏好键或常驻计时器、RAF、观察器；下拉复用共享组件，只在展开期间保留临时定位和悬停任务，收起即释放。

全局设置搜索使用纯元数据 `settingsSearch(options,language)` 条目 `{key,name,keywords}`，查询不创建设置正文或加载运行时。共享外壳的可选分类 `searchTargets(query)` 返回目标，`onReveal(target)` 在滚动/聚焦前打开内部页面并返回实际控件：例如“自动展开”进入基础开关，`sq` 进入相应片段。未声明这两个回调的分类继续使用原来的 DOM 搜索。

## 模块与接入

- `assets/note-extensions.js`：注册表、偏好、受控脚本加载、每编辑器的独立扩展 Compartment 和生命周期。
- `assets/note-extensions/catalog.js`：注册记录、偏好规范化、片段名称/分类及纯搜索元数据；设置工厂委托 UI 控制器，运行时代码仍在同目录按需加载。
- `assets/note-extensions-settings.js` 与专用 CSS：通用扩展列表/详情、`createLatexPanel()` 的双栏片段界面、草稿、搜索定位、状态和双语刷新。
- `assets/note-live-editor.js`：只提供配置入口、已有公式边界查询和候选输入交接；每扩展配置位于原 Tab 处理之前。`makeState()` 保留配置槽，切正文创建新的 StateField 状态，不沿用旧占位。
- `assets/note-workspace.js`：注册设置分类、恢复与语言刷新；按实际编辑视图、正文、图谱、浏览结果及工作区状态调用 `setExtensionsActive()`。

新增内置扩展时，在任何编辑器创建之前调用：

```javascript
RelatumNoteExtensions.register({
  id: 'example', version: '1.0.0',
  name: ['示例', 'Example'], description: ['说明', 'Description'],
  keywords: '示例 example', defaultEnabled: false,
  defaultOptions: { automatic: true },
  load: () => RelatumNoteExtensions.loadScript('example', 'note-extensions/example.js'),
  createSettings({ language, read, update }) {
    // 返回 { panel, refresh(), reveal?(key), setActive?(active), reset?(), close?(), destroy?() }。
    // 只创建本地设置 DOM；可用 settingsSearch(options, language) 声明纯搜索条目。
  },
});
```

ID 为稳定的小写字母/数字/短横线名称，必须以字母开头，不可重复。`scope` 默认 `editor`，保持既有 Compartment 接入；`workspace` 扩展通过 `attachWorkspace(id,context)` 接入宿主，编辑器不会创建其配置槽。工作区宿主返回 `instance/refresh()/destroy()`，按总开关、页面/原生可见状态及 `context.isCurrent()` 加载或销毁实例，迟到加载核对身份。`name/description` 使用中英文数组，可选 `displayVersion` 单独指定展示版本。不声明规范化钩子时，选项继续按默认值的原始类型读取；结构化选项可提供 `normalizeOptions(value)`，返回完整、校验过的独立副本。需要搜索的设置词在 `keywords` 声明。设置工厂的 `read()` 返回选项副本，`update(partialOptions)` 合并修改并返回保存是否成功。通用设置页面不操作正文。

对应脚本调用 `registerRuntime(id, factory)`。`factory(context, options)` 返回：

```javascript
{ extension: [/* CodeMirror 扩展 */], suspend() {}, resume() {}, destroy() {} }
```

`context` 提供当前同一份 `CM`、`view`、`isActive()`、`isCurrent()`、`inputPending()`、`acceptsInput()`、`whenSettled()` 和 `mathAt(state, from, to)`。后者返回公式内容的 `from/to`，另含 `outerFrom/outerTo/open/close`，供边界导航使用。不要捆绑第二份 CodeMirror，不要在工厂中重新创建编辑器或自行保存正文。每个工厂只持有自身资源，`suspend/destroy` 必须幂等，取消待执行任务；CodeMirror ViewPlugin 的 `destroy` 负责它自身的监听与状态。

开关/选项变化和可见生命周期按配置版本核对；输入未结束时先暂停扩展任务，待既有交接完成后只应用最新配置。关闭、阅读、离场、隐藏、原生最小化和 pagehide 卸载编辑器配置；返回后按当前偏好恢复。共享加载承诺可以完成，但旧宿主、旧配置或隐藏页面的结果不能挂载。加载失败保留开关和普通编辑，显式重试或再次启用可重试。已加载的 JS 定义保留供复用，不保留旧正文及占位会话。

## 偏好

`canvas:noteExtensions:v1`：

```json
{"version":1,"extensions":{"latex-input":{"enabled":true,"options":{"automatic":true}}}}
```

默认值只驻留内存，启动和搜索不写存储；显式修改才写入。字段损坏按默认值回退，未知扩展记录保留，供升级后恢复。分类恢复和全部笔记设置恢复删除此键；未改现有其他分类恢复边界。开关及文件染色的四项外观参数沿用桌面 `canvas:*` 按模式偏好快照。LaTeX 配置没有后端 API、配置文件或 Markdown 字段；文件颜色独立保存为用户数据，关闭扩展和恢复设置均不清空颜色。文件染色配置中的“清空所有数据”需确认后独立清除颜色记录，保留偏好。

1.1 的 `options` 增加布尔项 `autoFraction/tabout/matrix/subscripts` 以及 `overrides/custom` 两个片段数组。片段记录为 `{id,trigger,replacement,boundary,enabled}`；内置覆盖按稳定的原触发词 ID 保存，自定义 ID 为 `custom-…`。读取和传入运行时的配置相互独立；无效记录丢弃或回退，不执行配置中的代码。

## 公式输入

独立的 `latex-input.js` 保留原 61 个片段，1.2 共提供 104 个内置片段。新增文字与格式、偏导与定积分、连乘、常用集合与关系符号，以及矩阵和对齐环境；触发表及中英文名称由设置详情列出。保留原希腊字母触发和边界；`und` 支持下划线后缀。数字下标覆盖字母、希腊字母及一至两层 `hat/bar/dot/ddot/tilde/vec/underline`，例如 `xvec12 → \vec{x}_{12}`，不处理任意命令参数。`par` 和 `beg` 固定由 Tab 确认，其余服从全局自动开关。

模板解析由 catalog 的纯函数 `parseTemplate(template,start)` 统一提供校验、摘要与运行时数据；`$1`–`$9` 按编号分组，支持 `${1:默认值}` 及重复编号联动，`$0` 是唯一退出点。默认文本可含配平或转义的 TeX 大括号，但不支持嵌套占位或冲突默认值。编号、默认值语法及会话不会写进正文。事务过滤器保持单光标，同步输入、删除、粘贴及嵌套展开；同位置的空占位和相邻联动占位按源顺序跟踪，不互相吞并。候选期间不传播，确认后沿用原交接并合并到该次输入历史，取消不传播；外部替换、撤销、切文档及卸载清理会话。

`pmat/bmat/Bmat/vmat/Vmat/matrix/cases/align/array` 快速建立成对环境，`align` 使用 `aligned`；块公式换行并保留容器前缀，行内使用紧凑形式。普通矩阵直接进入内容，Tab 可立即分列；`array` 先选择默认列格式 `cc`，`beg` 先选择联动的默认环境名 `matrix`，Tab 后进入内容。环境名称和列格式参数内不触发普通展开。

同一已闭合公式内选中内容，输入大写 `U/O/B/C/K/S` 分别添加下花括号、上花括号、下方标注、划消、指定目标划消、根号；标注进入占位。支持多行块公式及引用/Callout，跨公式、受保护区域、候选或多光标保留普通输入。模板与选中文字分别处理，选中文字始终是原始源码。划消沿用已有离线 MathJax 的本地扩展，不引入第二个预览。

助手生成分式、求和、积分或连乘等高表达式时，可为已配对的外层数学括号补 `\left/\right`，与展开共用一次历史。命令参数大括号、已指定尺寸的括号、已知命令的可选参数，以及跨矩阵单元或对齐行的配对不处理。仅扫描宿主已识别的有界公式，沿用结构缓存，无新常驻任务。

只在已闭合的 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 内生效，支持引用和 Callout；沿用普通公式的源码边界及原有行内 4KiB、块公式 32KiB 上限。仅在候选触发词出现时查询当前位置，复用 MarkdownMini 和现有有界块扫描及保护区域；不逐键解析整篇笔记，不加载另一套渲染器。

`sq/sum/int` 要求命令起始边界，幂次支持 `xsr` 等后缀；代码、元数据、Markdown 注释、公式 `%` 注释、转义命令和 `\text*`、`\mbox`、`\operatorname`、`\url/\href`、`\begin/\end` 名称参数不展开。仅普通 `input.type` 才安排一次微任务展开，核对文档状态和身份；粘贴、外部替换、候选输入、撤销和重做不会自动触发。多光标始终保留普通输入。助手生成的完整命令保留本次会话边界，后续字母按需分隔；`@asr/@ax/@a@b` 分别得到 `\alpha^{2}`、`\alpha x`、`\alpha\beta`，不据此拆分手写自定义命令。

Tab 优先展开有效片段或待确认分式，再跳转当前片段占位、处理矩阵单元和公式跳出，最后回落原输入。手动模式支持占位内继续展开嵌套片段；Shift+Tab 返回前一占位，Escape 结束占位会话，普通公式导航仍按分项开关生效。占位随 ChangeSet 映射，嵌套片段退出后继续外层，移出范围、切正文或卸载扩展即清理。展开使用独立历史边界，Undo 恢复触发词，Redo 恢复展开但不重新运行；占位跳转不写正文或保存。

自动分式把 `x/`、`(a+b)/` 转为分式并进入分母，支持命令参数、嵌套括号和上下标；只提取相邻操作数，不跨顶层运算符、空白、换行或矩阵单元。无有效分子保留 `/`，空模板 `//` 保留；关闭自动展开后由 Tab 确认。公式 Tab 跳出支持普通配对括号、命名括号及 `\left…\right`，在内容末尾跳过闭合公式定界符；未配对时回落，Shift+Tab 不新增反向跳出。

矩阵支持 `matrix/pmatrix/bmatrix/Bmatrix/vmatrix/Vmatrix/array/cases/align/aligned/gather`，环境顶层 Tab 插入 `&`，Enter 插入 `\\` 并换行，Shift+Enter 跳到配对的 `\end{…}` 后。引用/Callout 前缀和缩进保留；嵌套括号及参数内优先进行公式导航，不能将单元分隔插入参数。只在这些操作发生时扫描已识别的有界公式，结果最多缓存当前一份编辑状态；递归操作数提取另限 128 层，暂停及销毁释放缓存，无持续循环。

### 片段表单

内置片段可编辑、启停及单项恢复；自定义片段可新增、编辑、启停及删除。右侧表单包含触发词、替换模板、词首/后缀/任意位置匹配；保存成功后即时生效，取消及未保存内容不写偏好，启停仍即时提交。恢复内置触发词若与另一片段冲突，会提示先解决冲突，不删除另一片段。最多 128 条自定义片段，触发词 1–64 字符且不得包含空白、反斜杠或 `$`，模板 1–4096 字符；重复触发词、非法占位或冲突默认值在表单提示。运行时按实际最长触发词有界查找，配置只含文字模板，不支持用户正则或 JavaScript。

1.2 新增选项 `visualSnippets/autoEnlargeBrackets`，其余偏好仍用原 v1 格式。新增默认触发词若与旧自定义或旧内置覆盖重名，旧配置优先，新默认片段仅在有效列表标记 `conflict` 并暂停运行，详情显示原因；派生标记不保存。修改触发词可解除冲突，启动不删除或改写旧配置。保存及恢复仍检查实际占用的触发词。

不包含自定义可执行规则、源码隐藏、彩色括号、逐片段触发模式设置、反向公式跳出或行内浮动预览。

## 上游来源

工作方式与常用触发映射参考 LaTeX Suite README 和默认片段，固定参考提交 `5fdcca013a8daa41cdb7debe12e41a53035298a5`（1.1 于 2026-10-27 再核验）：

- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/README.md
- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/src/default_snippets.js
- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/LICENSE.md

保留上游 MIT 声明于 `assets/note-extensions/LICENSE-latex-suite.txt`。输入引擎、生命周期和设置为 Relatum 独立实现，没有引入 Obsidian API、上游解析器或其他运行时依赖。

## 定向验证

2026-10-29 的 1.2 使用隔离数据通过 `node tests/note-latex-input-regression.js`、`node tests/note-extensions-browser.js`、`node tests/note-settings-browser.js --smoke` 与 `node tests/note-math-preview-browser.js`。纯逻辑覆盖模板校验、默认与镜像占位、相邻占位顺序、升级冲突及旧偏好；真实浏览器覆盖六项输入能力、嵌套及一次撤销、Chromium 原生候选确认/取消、生命周期、已有离线 MathJax 的六种包裹与划消排版、旧用户触发词优先、设置解除冲突、中英文深浅窄窗。未重新打包，未执行微软拼音实际候选窗人工验收。

沿用 `RELATUM_PLAYWRIGHT / RELATUM_PYTHON / RELATUM_EDGE_PATH`，运行 `node tests/note-extensions-browser.js`。真实生产页面和隔离服务覆盖列表/详情、纯元数据搜索及实际控件定位、本地筛选、会话草稿、编辑器身份/正文/滚动保持、宽窄布局，以及原有的输入、片段表单/限额/重载、偏好兼容、加载失败/迟到、候选及生命周期等场景。截图包括简洁列表、真实双栏编辑、基础设置、使用说明及中英文深浅窄窗。共享外壳另用 `node tests/note-settings-browser.js --smoke` 和 `node tests/global-settings-browser.js system library` 定向回归。数据、浏览器配置和报告只写临时目录，结束关闭浏览器和服务；不跑全量或独立性能基准，不重打桌面包。真实微软拼音候选窗仍属桌面人工验收边界。

# 笔记扩展与 latex辅助输入 1.1

## 使用与边界

“笔记设置 → 扩展”（`extensions`，位于笔记本之后）管理随软件附带的离线扩展。第一项中文卡片标题为“latex辅助输入 1.1”，英文为“LaTeX Input Assistant 1.1”，内部 ID 仍为 `latex-input`，版本元数据 `1.1.0`。总开关默认关闭；自动展开、自动分式、Tab 跳出、矩阵快捷输入和数字下标各自默认开启，可分别关闭。旧启停及自动展开偏好保留，新增默认值不在启动时回写。列表卡片只提供名称、说明、总开关、“配置”入口及错误重试；点击配置或搜索结果才创建详情，不加载公式运行时。

仅增强笔记编辑器，不提供安装包、在线市场、自动更新、Obsidian 兼容层，也不迁移 Mermaid、Quiz 等现有功能。所有资源继续归 `notes` 功能；禁用笔记时沿用现有静态资源权限。源码修改无需增加依赖或构建应用；已发布的旧桌面程序仍需下次打包才包含新功能。

## 设置面板

扩展分类使用共享设置外壳的 `layout:'fill'`，保留左侧分类和原关闭、恢复入口。配置在同一个设置弹窗的右侧打开独立详情，顶部“← 扩展”返回列表；没有叠加弹窗。详情有“基础设置 / 片段管理 / 使用说明”三个页签，支持方向键与 Home/End。基础设置逐行显示开关及简短说明；使用说明只显示文字例子，不启动 MathJax。

片段管理提供本地搜索和“全部 / 常用 / 希腊字母 / 函数与重音 / 自定义”过滤。宽窗左侧为单选列表，显示触发词、双语名称及省略占位的模板摘要；右侧集中启停、编辑、保存/取消、恢复或删除，列表中不再重复摆放操作按钮。设置外层不滚动，列表和编辑字段分别在并列区域滚动，右侧编辑字段区隐藏滚动条外观，保留滚轮与键盘滚动，左侧列表继续显示细滚动条；编辑操作固定在字段区下方。视口不超过 900 CSS px 时列表与编辑器单列切换，选中后聚焦实际输入框，“← 片段列表”返回；400×720 窗口仍保留保存入口。

页签、筛选、搜索、选择和按片段 ID 保存的草稿只存在本次设置会话内。切片段、切页签、返回扩展列表和切分类保留草稿；取消只丢弃当前草稿，保存成功即时写入既有偏好。真正关闭设置、隐藏/最小化引起关闭，以及分类/全部恢复时清理草稿；关闭动画期间不重排面板，快速反向重开不执行过期关闭收尾。无新增偏好键、常驻计时器、RAF 或观察器。

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

ID 为稳定的小写字母/数字/短横线名称，必须以字母开头，不可重复。`name/description` 使用中英文数组，可选 `displayVersion` 单独指定展示版本。不声明规范化钩子时，选项继续按默认值的原始类型读取；结构化选项可提供 `normalizeOptions(value)`，返回完整、校验过的独立副本。需要搜索的设置词在 `keywords` 声明。设置工厂的 `read()` 返回选项副本，`update(partialOptions)` 合并修改并返回保存是否成功。通用设置页面不操作正文。

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

默认值只驻留内存，启动和搜索不写存储；显式修改才写入。字段损坏按默认值回退，未知扩展记录保留，供升级后恢复。分类恢复和全部笔记设置恢复删除此键；未改现有其他分类恢复边界。沿用桌面 `canvas:*` 按模式偏好快照，无后端 API、配置文件或 Markdown 字段。

1.1 的 `options` 增加布尔项 `autoFraction/tabout/matrix/subscripts` 以及 `overrides/custom` 两个片段数组。片段记录为 `{id,trigger,replacement,boundary,enabled}`；内置覆盖按稳定的原触发词 ID 保存，自定义 ID 为 `custom-…`。读取和传入运行时的配置相互独立；无效记录丢弃或回退，不执行配置中的代码。

## 公式输入

独立的 `latex-input.js` 保留原 16 个触发，现有 61 个内置片段：平方根、分式、上下标、求和积分、上下大小写希腊字母、常用函数及 `hat/bar/dot/ddot/tilde/vec`。触发表由设置详情列出；保留 `@p → \pi`，增加 `@x/@X → \xi/\Xi`，避免裸 `xi` 提前展开破坏 `xinvs`。支持 `xvec`、`@ahat` 等单变量重音后缀，以及 `x1/x12` 数字下标。片段表直接复用注册记录，`$1`–`$9` 是内存占位，`$0` 是退出点，不写入正文；不支持重复编号、默认占位文字或镜像占位。

只在已闭合的 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 内生效，支持引用和 Callout；沿用普通公式的源码边界及原有行内 4KiB、块公式 32KiB 上限。仅在候选触发词出现时查询当前位置，复用 MarkdownMini 和现有有界块扫描及保护区域；不逐键解析整篇笔记，不加载另一套渲染器。

`sq/sum/int` 要求命令起始边界，幂次支持 `xsr` 等后缀；代码、元数据、Markdown 注释、公式 `%` 注释、转义命令和 `\text*`、`\mbox`、`\operatorname`、`\url/\href`、`\begin/\end` 名称参数不展开。仅普通 `input.type` 才安排一次微任务展开，核对文档状态和身份；粘贴、外部替换、候选输入、撤销和重做不会自动触发。多光标始终保留普通输入。助手生成的完整命令保留本次会话边界，后续字母按需分隔；`@asr/@ax/@a@b` 分别得到 `\alpha^{2}`、`\alpha x`、`\alpha\beta`，不据此拆分手写自定义命令。

Tab 优先展开有效片段或待确认分式，再跳转当前片段占位、处理矩阵单元和公式跳出，最后回落原输入。手动模式支持占位内继续展开嵌套片段；Shift+Tab 返回前一占位，Escape 结束占位会话，普通公式导航仍按分项开关生效。占位随 ChangeSet 映射，嵌套片段退出后继续外层，移出范围、切正文或卸载扩展即清理。展开使用独立历史边界，Undo 恢复触发词，Redo 恢复展开但不重新运行；占位跳转不写正文或保存。

自动分式把 `x/`、`(a+b)/` 转为分式并进入分母，支持命令参数、嵌套括号和上下标；只提取相邻操作数，不跨顶层运算符、空白、换行或矩阵单元。无有效分子保留 `/`，空模板 `//` 保留；关闭自动展开后由 Tab 确认。公式 Tab 跳出支持普通配对括号、命名括号及 `\left…\right`，在内容末尾跳过闭合公式定界符；未配对时回落，Shift+Tab 不新增反向跳出。

矩阵支持 `matrix/pmatrix/bmatrix/Bmatrix/vmatrix/Vmatrix/array/cases/align/aligned/gather`，环境顶层 Tab 插入 `&`，Enter 插入 `\\` 并换行，Shift+Enter 跳到配对的 `\end{…}` 后。引用/Callout 前缀和缩进保留；嵌套括号及参数内优先进行公式导航，不能将单元分隔插入参数。只在这些操作发生时扫描已识别的有界公式，结果最多缓存当前一份编辑状态；递归操作数提取另限 128 层，暂停及销毁释放缓存，无持续循环。

### 片段表单

内置片段可编辑、启停及单项恢复；自定义片段可新增、编辑、启停及删除。右侧表单包含触发词、替换模板、词首/后缀/任意位置匹配；保存成功后即时生效，取消及未保存内容不写偏好，启停仍即时提交。恢复内置触发词若与另一片段冲突，会提示先解决冲突，不删除另一片段。最多 128 条自定义片段，触发词 1–64 字符且不得包含空白、反斜杠或 `$`，模板 1–4096 字符；重复触发词、非法或重复占位在表单提示。运行时按实际最长触发词有界查找，配置只含文字模板，不支持用户正则或 JavaScript。

不包含自定义可执行规则、源码隐藏、选区包裹、括号自动放大、彩色括号或第二套预览。

## 上游来源

工作方式与常用触发映射参考 LaTeX Suite README 和默认片段，固定参考提交 `5fdcca013a8daa41cdb7debe12e41a53035298a5`（1.1 于 2026-10-27 再核验）：

- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/README.md
- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/src/default_snippets.js
- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/LICENSE.md

保留上游 MIT 声明于 `assets/note-extensions/LICENSE-latex-suite.txt`。输入引擎、生命周期和设置为 Relatum 独立实现，没有引入 Obsidian API、上游解析器或其他运行时依赖。

## 定向验证

沿用 `RELATUM_PLAYWRIGHT / RELATUM_PYTHON / RELATUM_EDGE_PATH`，运行 `node tests/note-extensions-browser.js`。真实生产页面和隔离服务覆盖列表/详情、纯元数据搜索及实际控件定位、本地筛选、会话草稿、编辑器身份/正文/滚动保持、宽窄布局，以及原有的输入、片段表单/限额/重载、偏好兼容、加载失败/迟到、候选及生命周期等场景。截图包括简洁列表、真实双栏编辑、基础设置、使用说明及中英文深浅窄窗。共享外壳另用 `node tests/note-settings-browser.js --smoke` 和 `node tests/global-settings-browser.js system library` 定向回归。数据、浏览器配置和报告只写临时目录，结束关闭浏览器和服务；不跑全量或独立性能基准，不重打桌面包。真实微软拼音候选窗仍属桌面人工验收边界。

# 笔记扩展与公式输入助手

## 使用与边界

“笔记设置 → 扩展”（`extensions`，位于笔记本之后）管理随软件附带的离线扩展。第一项“公式输入助手”默认关闭，开启后默认自动展开；可在“设置与使用说明”里关闭自动展开，改为按 Tab 确认。卡片显示版本、说明、开关和加载错误重试。设置详情只在首次展开或相关搜索时创建，不加载公式助手运行时。

仅增强笔记编辑器，不提供安装包、在线市场、自动更新、Obsidian 兼容层，也不迁移 Mermaid、Quiz 等现有功能。所有资源继续归 `notes` 功能；禁用笔记时沿用现有静态资源权限。源码修改无需增加依赖或构建应用；已发布的旧桌面程序仍需下次打包才包含新功能。

## 模块与接入

- `assets/note-extensions.js`：注册表、偏好、受控脚本加载、每编辑器的独立扩展 Compartment 和生命周期。
- `assets/note-extensions/catalog.js`：轻量注册记录与扩展设置工厂；按需运行时代码在同目录各自维护。
- `assets/note-extensions-settings.js` 与专用 CSS：通用卡片、搜索准备、状态和双语刷新。
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
    // 返回 { panel, refresh(), destroy?() }，只创建本地设置 DOM。
  },
});
```

ID 为稳定的小写字母/数字/短横线名称，必须以字母开头，不可重复。`name/description` 使用中英文数组。首版选项使用布尔、字符串或数值等原始值，读入时按默认值类型规范化；需要搜索的设置词在 `keywords` 声明。设置工厂的 `read()` 返回选项副本，`update(partialOptions)` 合并修改。通用设置页面不操作正文。

对应脚本调用 `registerRuntime(id, factory)`。`factory(context, options)` 返回：

```javascript
{ extension: [/* CodeMirror 扩展 */], suspend() {}, resume() {}, destroy() {} }
```

`context` 提供当前同一份 `CM`、`view`、`isActive()`、`isCurrent()`、`inputPending()`、`acceptsInput()`、`whenSettled()` 和 `mathAt(state, from, to)`。不要捆绑第二份 CodeMirror，不要在工厂中重新创建编辑器或自行保存正文。每个工厂只持有自身资源，`suspend/destroy` 必须幂等，取消待执行任务；CodeMirror ViewPlugin 的 `destroy` 负责它自身的监听与状态。

开关/选项变化和可见生命周期按配置版本核对；输入未结束时先暂停扩展任务，待既有交接完成后只应用最新配置。关闭、阅读、离场、隐藏、原生最小化和 pagehide 卸载编辑器配置；返回后按当前偏好恢复。共享加载承诺可以完成，但旧宿主、旧配置或隐藏页面的结果不能挂载。加载失败保留开关和普通编辑，显式重试或再次启用可重试。已加载的 JS 定义保留供复用，不保留旧正文及占位会话。

## 偏好

`canvas:noteExtensions:v1`：

```json
{"version":1,"extensions":{"latex-input":{"enabled":true,"options":{"automatic":true}}}}
```

默认值只驻留内存，启动和搜索不写存储；显式修改才写入。字段损坏按默认值回退，未知扩展记录保留，供升级后恢复。分类恢复和全部笔记设置恢复删除此键；未改现有其他分类恢复边界。沿用桌面 `canvas:*` 按模式偏好快照，无后端 API、配置文件或 Markdown 字段。

## 公式输入

独立的 `latex-input.js` 支持 16 个触发：`sq`、`//`、`sr/cb/invs`、`sum/int`、`@a/@b/@g/@d/@t/@l/@p/@s/@o`。片段表直接复用注册记录，替换模板中的 `$1/$2` 是内存占位，`$0` 是退出点，不写入正文。

只在已闭合的 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 内生效，支持引用和 Callout；沿用普通公式的源码边界及原有行内 4KiB、块公式 32KiB 上限。仅在候选触发词出现时查询当前位置，复用 MarkdownMini 和现有有界块扫描及保护区域；不逐键解析整篇笔记，不加载另一套渲染器。

`sq/sum/int` 要求命令起始边界，幂次支持 `xsr` 等后缀；代码、元数据、Markdown 注释、公式 `%` 注释、转义命令和 `\text*`、`\mbox`、`\operatorname`、`\url/\href` 参数不展开。仅普通 `input.type` 才安排一次微任务展开，核对文档状态和身份；粘贴、外部替换、候选输入、撤销和重做不会自动触发。多光标始终保留普通输入。

Tab 优先跳转当前片段占位，其次手动展开，再回落原输入行为；Shift+Tab 返回前一占位，最后退出，Escape 结束会话。占位随 ChangeSet 映射，嵌套片段退出后继续外层，移出范围、切正文或卸载扩展即清理。展开使用独立历史边界，Undo 恢复触发词，Redo 恢复展开但不重新运行；占位跳转不写正文或保存。

不包含自定义可执行规则、自动分式解析、矩阵、源码隐藏或第二套预览。

## 上游来源

工作方式与常用触发映射参考 LaTeX Suite README，固定参考提交 `5fdcca013a8daa41cdb7debe12e41a53035298a5`（2026-10-26 核验）：

- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/README.md
- https://github.com/artisticat1/obsidian-latex-suite/blob/5fdcca013a8daa41cdb7debe12e41a53035298a5/LICENSE.md

保留上游 MIT 声明于 `assets/note-extensions/LICENSE-latex-suite.txt`。输入引擎、生命周期和设置为 Relatum 独立实现，没有引入 Obsidian API、上游解析器或其他运行时依赖。

## 定向验证

沿用 `RELATUM_PLAYWRIGHT / RELATUM_PYTHON / RELATUM_EDGE_PATH`，运行 `node tests/note-extensions-browser.js`。单个真实生产页面和隔离服务覆盖加载失败/迟到、16 个片段、嵌套占位、历史、保护边界、源码模式、Chromium 原生候选及配置交接、多光标、最小化恢复、阅读交接、真实保存、重载和设置恢复，以及深浅/窄窗截图。数据、浏览器配置和报告都在该脚本创建的临时目录，结束关闭浏览器和服务。此任务不跑全量或独立性能基准，不重打桌面包；真实微软拼音候选窗仍属桌面人工验收边界。

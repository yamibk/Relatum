# 笔记六色高亮

## 使用

`==文字==` 使用默认颜色；开头 `==` 后立即加入 🔴、🟠、🟡、🟢、🔵、🟣，分别使用红、橙、黄、绿、蓝、紫。例如 `==🔴重要==` 渲染后只显示红底的“重要”。兼容复制时附带的 U+FE0F；其他 emoji 原样作为正文，旧 `{hl:red|文字}` 不变。

实时预览、源码及表格单元格普通输入 `==` 后显示七项选色菜单；确认后自动补齐结尾，复用紧邻的已有 `==`，光标留在内部。方向键选色、Enter/Tab 确认、Escape 取消；继续普通输入关闭菜单。当前会话生成的配对支持输入 `==` 跳过结尾、空内容 Backspace 删除整对。粘贴、候选输入、历史与闭合符号不触发菜单。

实时预览中光标进入高亮后显示开头色块；点击切换颜色。源码保留真实 emoji。正文右键“高亮颜色”支持选中文字换色、跨行逐非空行包裹，无选区时修改当前高亮或插入空标记；默认只清颜色。局部换色和取消高亮保留未选部分的原颜色及其他格式，换色单次事务可一次撤销。

## 代码与数据

- `assets/markdown.js`：`MarkdownMini.noteSyntax.highlightColors` 是冻结的七项颜色目录，`highlights(source,offset=0)` 返回 UTF-16 的 `from/to/bodyFrom/bodyTo/color/prefix`；纯扫描的调用方继续使用已有代码、公式、块与转义保护。
- 笔记渲染通过已有 `noteSyntax:true` 解释颜色；`renderLabelResult` 增加相同的可选参数。普通调用不消费 emoji。笔记所属表格、标题、列表、引用、Callout、脚注、链接短文本、Quiz 和引导沿用这条渲染链。
- `assets/note-live-editor.js`：共用装饰、格式范围和选色控制器；`queryCommand/executeCommand('highlight-color:<id>')` 支持七个固定 ID。控制器由表格内部适配器接入单元格 CodeMirror，写入仍走父编辑器历史。
- `assets/styles.css` 和 `assets/note-theme.css`：笔记局部颜色、菜单和圆形色块，深浅与默认/Claude 主题共用；菜单没有持续动画。
- 所有颜色信息保存在原 Markdown，自动配对仅保存在当前编辑现场；没有新偏好、数据库、HTTP API、依赖或运行时出站。

菜单只保留当前文档及选区身份；组合输入、文档/模式/工作区交接、失焦、语言/主题变化、隐藏/最小化及销毁使旧菜单失效。只处理可见行、选区和已有有界保护扫描；没有新增轮询、MutationObserver 或持续 RAF。

## 验证

2026-10-29，使用一次性数据根、Edge 无头浏览器及独立浏览器配置完成：

- `node tests/note-highlight-regression.js`：七项颜色、UTF-16/变体选择符、连续标记、嵌套粗体、各类块、转义/代码/公式/注释、旧语法及非笔记隔离。
- `node tests/note-highlight-browser.js`：真实首页/笔记工作区，输入菜单、自动配对/复用/跳过/删除、键盘和鼠标、部分/多选/跨行及嵌套格式、撤销重做、源码与阅读、表格父历史、原生 Chromium preedit、七类中断后的过期点击、真实磁盘保存/重开、四种主题截图及窄窗边界。
- 现有 `markdown-regression`、`note-live-editor-regression`、`note-input-browser`、`note-table-inline-browser`、`note-context-menu-browser`、`note-theme-regression` 和 `note-theme-browser` 回归。

浏览器脚本沿用 `RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH / RELATUM_PYTHON`，截图和数据均写系统临时目录，结束关闭测试服务/浏览器。不访问真实用户笔记，不重新打包；Chromium preedit 不替代真实微软拼音候选窗和发布包 WebView2 人工验收。

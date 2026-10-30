# 笔记表格紧凑排版与编辑边界 · 2026-10-30

## 行为

- 实时表格采用既有紧凑块投影，上下各 4px 内边距；不再附带两条指向隐藏源码的空白边界行。真实空行、前后正文及文首文末留白按 Markdown 保留，加载时不重写笔记。
- 上方列手柄与下方追加条的高度限制在表格真实外框留白内；保持全列宽/全表宽，符号居中，左右控件不变。正文和真实空行优先命中，手柄仍支持选择、拖动、取消与重排。测试根据实际控件中心取点，不使用固定纵向偏移。
- 表后紧邻段落行首 Backspace 进入末行末格末尾；表前紧邻段落行尾 Delete 进入首格开头。焦点交接不改变正文或增加历史；多余空行先正常删除，非空选区、源码与显式网格删除仍按原行为。原生 `beforeinput` 删除入口共享保护，候选输入期间不强制交接。
- 当前格 Enter 在末行增行时保留当前列；末格 Tab 增行后进入首列。
- 单元格保持原生光标及原生文字选择。父 CodeMirror 的 drawSelection 样式曾把嵌套 `.cm-line` 光标设为透明，而格内没有绘制替代光标；现在只对格内内容层和行恢复 `currentColor !important`，不修改 vendor 或增加绘制循环。

## 剪贴板

网格选区的复制/剪切写入 `text/plain` Markdown，并尽量附带 `text/html` 表格。复用 `MarkdownTable.serialize()`，保留所选格内行内源码、转义竖线和列对齐；局部范围以第一条选中行为 Markdown 首行，加标准分隔行，不追加未选中的原表头。HTML 通过现有安全渲染器另行生成，只取表格，不复制编辑器 DOM、控件或图表运行时。

格内普通选字仍复制原选中文字。剪切只在文本写入成功后修改笔记；HTML 写入失败允许保留 Markdown，文本失败不删除。TSV/Markdown 粘贴继续通过原解析器进入网格，目标已有列的对齐保持原样；复制到空白正文可创建标准 Markdown 表格。

主要实现位于 `assets/note-live-editor.js`、`assets/note-table-editor.js` 和 `assets/styles.css`。不新增公开 API、偏好、存储格式、依赖、观察器或常驻 RAF。

## 验证

使用宿主提供的 Playwright、Edge 和 Python，沿用 `RELATUM_PLAYWRIGHT`、`RELATUM_EDGE_PATH`、`RELATUM_PYTHON`。所有正文和保存数据均为临时合成数据，未访问真实笔记库，未重新打包。

| 检查 | 结果与范围 |
| --- | --- |
| `node tests/note-table-editing-browser.js` | 默认、Claude、Sky、Apple 各浅色宽窗 100% 与深色窄窗 200%，共 8 组；零/一/多条真实空行、文首文末、连续表格、原生光标、边界删除与 beforeinput、额外空行、显式删除和源码隔离、Enter/Tab、真实 Markdown/HTML 剪贴板、局部对齐、粘贴往返、复制失败和候选输入通过；输出截图和 JSON 到临时目录 |
| `node tests/note-table-browser.js` | 表格原输入、候选交接、历史、边缘追加、Markdown 复制、TSV 粘贴、真实隔离库自动保存/重开、模式切换及文件树/标签栏重排通过 |
| `node tests/note-table-interaction-browser.js` | 原生选字、矩形选择、边缘重排、取消、候选交接、真实正文点击/粘贴、深浅/窄窗及 4000 格选区差集通过；无选区和固定选区滚动均零逐格属性写入 |
| `node tests/note-table-alignment-browser.js` / `node tests/note-table-inline-browser.js` | 对齐、格内格式、原生候选、键盘、尺寸、8000 格局部更新与闲置行为通过 |
| `node tests/note-clipboard-browser.js` / `node tests/note-input-browser.js` | 正文/表格剪贴板、纯文本、一次撤销、保存重开及格式快捷键通过 |
| `node tests/note-live-presentation-browser.js` / `node tests/note-scroll-browser.js` | 原块投影、相邻正文命中、公式/图片/Callout、4MiB 正文输入，以及隔离库工作区往返、源码/阅读、非整数布局和低动态滚动稳定通过 |
| 静态回归 | `note-live-editor-regression.js`、`markdown-table-regression.js`、`note-clipboard-regression.js`、`note-workspace-contract.js`、`table-compact-contract.js`、JS 语法与 `git diff --check` 通过；紧凑边界事务测试使用生产表格叶解析器 |

候选检查使用真实 Edge 的 CDP composition/输入通道；已目视检查浅色紧凑排版与深色 Apple 格内原生光标截图。本次未进行 Windows WebView2 中微软拼音真实候选窗人工验收，浏览器结果不代替该项桌面验收。

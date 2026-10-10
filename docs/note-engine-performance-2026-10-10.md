# 笔记工作区引擎性能复核 · 2026-10-10

基线为 `7e235898db6b83055479eac3457fda9809dedd0a`。检查最近的笔记性能提交、实时编辑器块投影、文件树与侧栏动画、表格/图片/画布输入链、保存与外部检查，以及后端目录和双链索引。仅落实两处能通过调用次数和同机对照确认收益的优化。应用依赖、API、持久化格式和用户配置不变；全部测量与保存验收使用临时库或合成正文。

## 修改

1. **光标移动复用块投影。** `assets/note-live-editor.js` 原先在每次选区/焦点更新时新建整个块 ID 索引，并刷新所有已扫描 Callout 及其后代投影。现在块集合未变时复用索引，只比较旧、新活动 Callout 的标题是否进入/退出源码。普通段落或同一 Callout 正文内移动光标保留装饰与原子范围的身份；内容变化、折叠、路径、视口扫描、媒体选择及候选交接继续走原更新流程。
2. **后端扫描复用相对路径和文件状态。** `notes_library.py` 新增内部 `_note_files()`，沿目录前缀构造库内相对路径，复用父级自然排序键与 `DirEntry.stat(follow_symlinks=False)` 返回的签名。增量索引不再先列路径、逐篇转换相对路径、再逐篇读取状态。原 `_note_paths()` 保留给统计和附件清理使用。文件树同样沿前缀形成相对路径。目录进入前的重解析点复查、严格统计错误、原子写入和字节修订检查保持有效，索引不增加正文缓存。

## 同机对照

环境为 Python 3.12.14、Edge 154.0.4258.62、Node 22.21.0。原始样本保存在 `note-engine-performance-2026-10-10.samples.json`。旧源码从上述基线加载，比较时均使用相同临时文件或相同合成正文。

### 光标块投影

独立浏览器页面使用真实 CodeMirror StateField，每个 Callout 包含标题、正文和一条块公式。为了固定规模，用完整语法树补齐已扫描块；先建立完整投影并预热 20 次，再测普通末尾段落内的 80 次光标移动。旧、新页面交替五轮，表格列出各轮中位数的中位数。只包装描述函数计数，没有逐个 `kind` getter 探针。

| Callout 数 / 已扫描块数 | 旧同步选区更新 | 新同步选区更新 | 旧每次描述函数调用 | 新每次描述函数调用 |
| --- | ---: | ---: | ---: | ---: |
| 250 / 500 | 0.7 ms | <0.1 ms | 500 | 0 |
| 1000 / 2000 | 2.7 ms | <0.1 ms | 2000 | 0 |
| 2000 / 4000 | 5.5 ms | 约 0.1 ms | 4000 | 0 |

新版每轮 80 次更新均保留装饰与原子范围身份；旧版为 0 次。正式回归还验证同一 Callout 正文内移动的零重复描述解析与索引身份保留。

这是块投影 StateField 的同步成本，未包含 DOM 布局、绘制、GPU 或整个键盘事件链，不能解读为整页帧率倍数。小文档的绝对收益较小；已扫描大量富块的长文档收益更明显。

### 后端目录和索引

万篇合成笔记分在 100 个文件夹，每篇含一个标签和 12 条 Wiki 链接。两版先建立相同的双链/标签索引，再在同一 Python 进程交替各测七批；不清操作系统文件缓存。每类最终结果完整比较相等，计时不包含结果相等性检查、HTTP 或 JSON 编码。

| 10000 篇稳态操作 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 文件树读取 | 377.7 ms | 127.7 ms |
| 增量文档索引检查 | 861.7 ms | 125.8 ms |
| 双链查询（120000 条链接） | 952.4 ms | 213.7 ms |
| 标签目录查询 | 877.8 ms | 126.7 ms |

一次无变化增量索引检查的 `Path.relative_to()` 从 20000 次降为 0，笔记文件的路径 `Path.stat()` 从 30000 次降为 0。新版仍对目录条目进行一次非跟随链接的状态读取，仍重新枚举库并复查进入的目录；这不是零文件系统访问。当前笔记的主动读取与修订验证保持原链路。

样本也包含 2000 篇的同规模交替对照。两组绝对耗时没有按规模单调变化，因此不据它们推断扩展曲线或其它机器的固定延迟。主要收益由相同规模的前后对比和稳定调用次数确认。

## 其余路径

- 正文缓存预算、预读串行和取消、词数分片、外部检查退避、阅读/公式/内嵌画布生命周期已在最近提交中覆盖，复核未找到需要继续改动的明确收益证据。
- 文件夹与侧栏动画仍保留原行为，真实页面验收覆盖快速反转、低动态、窄窗和深浅主题。没有改动动画样式或新增常驻动画循环。
- 大表格输入仍有 Markdown 序列化和父编辑器更新成本。本轮回归其输入、候选、撤销与保存，未改造输入或保存边界。
- 双链查询仍遍历索引中的链接指向。此次降低目录/路径处理成本，没有据此宣称所有大库查询都已成为常数时间。

## 验证

- Python 专项共 99 项，98 通过、1 项真实符号链接创建因 Windows 权限跳过：`test_notes_library`、`test_note_browser`、`test_note_canvas_browser`、`test_note_canvases`、`test_note_notebooks`、`test_note_trash`、`test_career_report`。新增用例验证一次目录状态复用、自然排序和相对路径、外部删除/修改、不可读目录/条目、严格统计、文件重解析点排除及进入目录前复查。
- `note-callout-resources-browser.js`：55 个单/多选区、标题/正文、跨块和焦点状态与新建编辑器状态的投影比较一致；250/1000/2000 个 Callout 各有 40 次普通/正文光标更新保持投影和索引身份，重复描述解析为 0；嵌套折叠、MathJax 异步收尾与释放、闲置脚本时间回归通过。
- 真实 Edge 的 `note-callout-browser.js`、`note-live-presentation-browser.js`、`note-canvas-browser.js`、`note-table-browser.js`、`note-image-text-browser.js`、`note-image-text-workspace-browser.js`、`note-browser-browser.js`、`note-view-state-browser.js`、`note-sidebar-browser.js` 均通过。包含原生 Chromium 候选确认/取消、块边界、媒体选择、模式切换、撤销、隔离库保存/重开、外部同步、深浅主题/窄窗和动画反转。
- `note-live-editor-regression.js`、`note-workspace-contract.js`、Markdown 笔记本回归/契约、画布引用与标签回归、Markdown 回归/全局契约/独立子进程 fuzz 均通过；修改后的 JS 语法与 `git diff --check` 通过。

未重新打包桌面 EXE，浏览器候选测试不替代 WebView2 内真实微软拼音候选窗的人工验收。未测整机 RAM、显存或完整页面的显示帧率。

复查新增边界可运行：

```powershell
# Python 执行前设置一次性 RELATUM_DATA_ROOT，不使用个人库。
python -B -m unittest tests.test_notes_library tests.test_note_canvas_browser
# 使用测试宿主提供的 RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH / RELATUM_PYTHON：
node tests/note-callout-resources-browser.js
node tests/note-live-presentation-browser.js
node tests/note-view-state-browser.js
node tests/note-sidebar-browser.js
```

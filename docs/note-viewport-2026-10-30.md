# 长篇 Markdown 的视口位置恢复 · 2026-10-30

## 问题与行为

基线 `bdbc3d9` 将同一 `scrollTop` 用于实时预览、源码和阅读，也在新建 CodeMirror 状态后直接恢复像素值。三种排版的总高度不同；虚拟文档在首轮测量前的高度也不同于上次实际浏览后的高度。因此滑条本身能正常拖动，返回的内容仍可能错位。

400KiB 的合成混排文档可稳定复现：实时预览第 94 节切到源码后落到第 88 节附近；同一环境的早期夹具还复现第 90 节切到阅读落到第 81 节，以及第 110 节切走再打开落到第 106 节。旧版专项测试按预期失败。

现在模式切换跟随正在阅读的内容，位置记忆与编辑光标独立。相同正文、模式和布局重开后，专项检查要求所跟踪源码块的屏幕偏移不超过 2 CSS px；块内进度、文首/文末另外保存。光标、反向选区和撤销历史继续由原编辑状态管理。

## 实现与接口

- `assets/note-live-editor.js` 增加编辑器实例的 `captureViewport()`、`restoreViewport(anchor,{isCurrent?})`、`cancelViewportRestore()`。编辑器先使用源码位置挂载正确的虚拟区域，再通过 CodeMirror 原有 `requestMeasure` 分离读写、校准块内进度和屏幕偏移；不锁定滚动，也不修改 vendor。
- 阅读使用同模块的 `captureReadingViewport(host)`、`restoreReadingViewport(host,anchor,{isCurrent?})` 和共享取消入口。读取位置在缓存的块层级中二分定位，不调用整页原生命中查询，不在滚动事件中逐块扫描。恢复期间复用图片加载、MathJax、Mermaid、Quiz/Cards 的原有布局通知；不同阅读会话的通知不修改新正文。
- `MarkdownMini.renderResult` 增加仅笔记阅读启用的可选 `noteSourceMap:true`。生成的 `data-note-block-from/to` 指向换行规范化后的原始 Markdown UTF-16 范围，覆盖段落、标题、列表及嵌套引用、表格及数据行、围栏/缩进代码、公式、前言、脚注与自定义富块。位置在占位转换前确定，并转换回原画布引用位置。普通画布和未启用选项的 Markdown 输出保持原样。
- 原 `canvas:noteViewStates:v1` 条目仍保存 `anchor/head/scrollTop`，增加可选 `viewport:{from,to,ratio,offset,edge?}`；`edge` 为 `start/end`。旧记录、无效锚点及无法建立阅读位置索引的降级内容保留像素回退，没有新 localStorage key、后端接口或正文副本。
- `assets/note-workspace.js` 在切换、保存位置和文档交接时采集锚点，先读当前几何再关闭工具。隐藏启动预读和已离场宿主保留最近有效位置，实际进入正文才恢复，失焦或退出保存不得用隐藏 DOM 的 0 覆盖书签。
- 恢复任务核对文档、模式、可见会话及阅读 DOM 身份。正文滚轮、指针/滑块、触控、键盘、输入和显式跳转取消旧任务；隐藏、原生最小化、离场和 pagehide 释放临时监听与待测量任务。调度仅由真实布局通知触发，没有新增观察器、轮询、常驻 RAF 或应用依赖。

## 同机计时样本

相同 Edge、1440×900、默认笔记主题、独立临时库分别运行旧/新 JS，各一轮。以下为 `--measure` 输出的同步交接时间（毫秒，旧 → 新），包含等待打开接口的打开耗时，不包含后续绘制、异步排版和物理显示器呈现。

| 文档 | 打开 | 进入阅读 | 阅读返回实时预览 |
| --- | ---: | ---: | ---: |
| 400KiB | 76.3 → 82.4 | 145.1 → 159.0 | 1.9 → 3.6 |
| 1MiB | 37.3 → 28.4 | 287.9 → 287.0 | 2.9 → 5.1 |
| 4MiB | 100.0 → 65.9 | 1235.9 → 1226.4 | 9.9 → 11.1 |

这是单轮防退化样本，不据此宣称打开提速或稳定帧率提升。4MiB 阅读仍需要约 1.2 秒完整解析/挂载，本次没有重构为分页阅读。读取视口几何位于关闭工具之前，并复用源码行偏移及块索引，避免为恢复位置额外引入一次大文档强制排版。

原始报告位于临时目录 `relatum-note-viewport-LfUMbW`（旧）和 `relatum-note-viewport-fdUKAe`（新）的 `viewport-report.json`，完整绝对目录由脚本输出。

## 验证与复现

`tests/note-viewport-browser.js` 使用一次性数据根、真实本地 HTTP 服务及 Edge，合成笔记规模为 400KiB、1MiB 和后端现有上限 4MiB。覆盖三种模式往返、首批显示帧、重开、关闭重开、刷新、新浏览器配置、离场重启后的隐藏预读、超长单段落、前言/注释/画布偏移、嵌套与折叠、文首文末、延迟图片和刻意延迟的公式排版、原生滑块、滚轮、过期回调、四主题窄窗，以及稳定后新增 RAF 为 0。资源交接按所跟踪源码块的实际屏幕位置验收，避免将亚像素边界露出的前一段末尾误判为整段跳转。

保留并运行原滑条、工作区滚动、位置记忆、编辑器、Markdown、大纲、Mermaid 工作区和工作区契约回归。位置记忆中的源码/实时往返断言改为相同可见内容和块内进度；原滑条脚本的程序化夹具定位显式结束先前恢复，真实滑块与滚轮仍由原生事件验证。新专项已加入 `tests/run-note-checks.ps1 -Browser`。

最终专项共 62 组场景通过，报告为系统临时目录 `relatum-note-viewport-mdVR6T/viewport-report.json`。普通渲染兼容检查另对照仓库文档的旧/新 Markdown 输出，未开启源码映射的输出保持一致。

使用宿主已有的 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON`、`RELATUM_EDGE_PATH`，不安装应用依赖：

```powershell
node tests/note-viewport-browser.js
node tests/note-scrollbar-browser.js
node tests/note-scroll-browser.js
node tests/note-view-state-browser.js

# 旧 JS 对照；正常验收预期在内容位置断言失败。
$env:RELATUM_NOTE_VIEWPORT_BASELINE='bdbc3d9'
node tests/note-viewport-browser.js --baseline --quick

# 仅记录打开及模式交接的同步时间，不进行内容位置验收。
node tests/note-viewport-browser.js --baseline --measure
node tests/note-viewport-browser.js --measure
```

报告和合成文件均写入系统临时目录，脚本结束打印目录。浏览器隐藏/最小化场景使用生命周期事件模拟，不等同真实桌面 WebView2 或显示器帧率验收。没有重新打包，也未访问真实笔记、画布或用户配置。

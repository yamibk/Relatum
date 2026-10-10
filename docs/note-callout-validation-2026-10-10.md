# 笔记 Callout、纯色块与引导验收

## 范围

笔记实时预览、阅读模式和右栏引导共用 `assets/markdown.js` 的只读 `MarkdownMini.noteBlockCatalog`。调用 `renderResult(source, {noteBlocks:true})` 才启用笔记扩展；普通画布调用保留既有标题、图标和外观。没有新增 HTTP 接口、正文迁移或第三方运行时。

右栏配置继续存放在 `data/note-notebooks.json`，仅扩展 `ui.mode` 的合法值 `guide`。折叠状态只存在当前文档内存会话中，实时/源码/阅读共享，重开按 Markdown 的 `+`/`-` 恢复；折叠不进入正文撤销历史。

## 参考参数

基准是本机 Obsidian 1.11.7 的默认 `app.css` 和用户提供的三张截图。安装文件只读检查，没有修改 Obsidian。验收后按用户要求删除仓库根目录的 `屏幕截图 2026-10-10 113054.png`、`屏幕截图 2026-10-10 113107.png`、`屏幕截图 2026-10-10 113119.png`；不清理剪贴板附件目录。

标准块无左条带、描边或阴影，圆角 4px，内边距 12/12/12/24px。图标是静态 Lucide 子集，18px、1.75px 描边，标题间距 4px，许可见 `THIRD_PARTY_NOTICES.md` 和 `assets/vendor/lucide/LICENSE.txt`。标题字重 600、行高 1.3，正文行高 1.5，正文段落留白按 1em 随笔记字号缩放。实时预览使用真实原生行内边距，不以整块 widget 或固定高度遮罩替换 Callout。

默认标题使用实际输入类型的英文名称，别名不换成标准类型的标题。例如 `important` 显示 Important，但采用 Tip 的图标和配色。自定义标题保留 Markdown 行内格式。

| 分组 | 浅色标题 | 深色标题 | 浅色背景像素实测 |
| --- | --- | --- | --- |
| Note / Info / Todo | #086DDD | #027AFF | #E6F0FB |
| Abstract / Tip / Important | #00BFBC | #53DFDD | #E5F8F8 |
| Success | #08B94E | #44CF6E | #E6F8ED |
| Question / Warning | #EC7500 | #E9973F | #FDF1E5 |
| Failure / Danger / Bug | #E93147 | #FB464C | #FCEAEC |
| Example | #7852EE | #A882FF | #F1EDFD |
| Quote | #9E9E9E | #9E9E9E | #F5F5F5 |

标准背景按主题色 10% 与白色/`#181A19` 混合并向下取整，避免 Chromium `color-mix` 的最后一阶舍入差异。局部使用不透明背景，不改变文字、公式或外层界面。32 色的基础色表保存在语法目录中，浅色为 16%/白色、深色为 22%/`#181A19`，按四舍五入预计算。纯色块 7px 圆角、无图标/默认标题/条带/描边/阴影；只接受普通颜色名，不区分大小写，不扩展纯色块折叠。

## 验证

所有浏览器测试只托管合成文档或启动临时 `RELATUM_DATA_ROOT`，未打开真实用户笔记。使用宿主 Playwright、Edge 和 Python，不添加 npm 构建链。新增像素测试额外设置 `RELATUM_SHARP` 指向宿主 Sharp 模块。

| 入口 | 结果与重点 |
| --- | --- |
| `node tests/markdown-regression.js` | 通过：13 标准类型及全部别名，共 28 名称；32 色；保留普通画布行为；引用公式前后正文和比较符号；代码/注释/前言保护；32KiB 公式上限。 |
| `node tests/markdown-fuzz-regression.js` | 通过：解析进度与复杂组合。 |
| `node tests/markdown-global-contract.js` | 通过：其他 Markdown 入口兼容。 |
| `node tests/note-live-editor-regression.js` | 通过：原生投影、历史、可见范围、长代码块零全文读取。 |
| `node tests/note-callout-browser.js` | 通过：全部类型/别名/颜色；Enter/Space 折叠、源码入口、正文光标回标题、跨模式和重开；单行/多行/括号引用公式；超宽公式滚动；深浅/窄窗/135% 字号/低动态；背景像素逐值匹配，图标 18px、描边 1.75、间距 4px、左内边距 24px。临时目录输出 PNG 和 `validation.json`。 |
| `node tests/note-live-presentation-browser.js` | 通过：原生中文候选流、相邻正文命中、图片/表格/公式/代码、模式与撤销；4MiB 正文输入 p95 约 0.9ms。 |
| `node tests/note-notebooks-browser.js` | 通过：引导首次打开才生成、52 个可复制示例、复制保留正文选区、配置重开、公式示例零 MathJax 请求及原侧栏回归。 |
| `node tests/note-canvas-browser.js` | 通过：内嵌画布及共享/保存/历史回归；画布禁用时引导可用；引导中英文、复制失败、深色窄窗；隐藏预热及源码冷启动零专用请求。 |
| `node tests/note-focus-browser.js` | 通过：专注模式窗口按钮、关闭、拖拽、深浅/中英文/窄窗；页签只在自身滚动区裁切，关闭按钮保持可点击。 |
| `node tests/note-table-browser.js` | 通过：表格、候选、撤销、选区、粘贴与隔离保存。 |
| `node tests/note-image-text-workspace-browser.js` | 通过：图片文字、自动保存、切页、重开与历史。 |
| `node tests/note-workspace-contract.js` | 通过：工作区契约。 |
| `python -m unittest tests.test_notes_library tests.test_note_notebooks tests.test_note_canvases` | 72 项，71 通过、1 跳过；Windows 当前账户无法创建符号链接（WinError 1314），其余路径/配置/原子保存/画布测试通过。 |

验收脚本的两个旧假设已同步修正：离开编辑中的换行正文会隐藏 Markdown 标记并引起真实重排，光标几何应对照重排后的原生文字矩形；720px 窄窗中已关闭的文件树位于屏外，不向负坐标发送拖拽。没有为这两项修改生产交互。

## 覆盖边界

浏览器组合输入流不等于真实 Microsoft 拼音候选窗；桌面专注测试使用受控 pywebview 桥，不会关闭真实桌面窗口。本轮未重新打包 EXE，也未在真实 WebView2/微软拼音候选窗中手动验收。字体及操作系统缩放继续尊重笔记既有设置；背景像素和局部几何对齐不代表整个应用窗口逐像素相同。

## 资源复查

追加的 `node tests/note-callout-resources-browser.js` 只托管合成文档，不使用真实笔记库。使用真实离线 MathJax 检查记录，不以一次堆内存读数判断泄漏。`--baseline` 仅关闭断言，便于在待修源码上取得对照。

- 修正前，每轮渲染两个行内公式、切源码、恢复预览再切文档，12 轮后 MathJax 保留 48 条旧记录。推导块销毁也留下记录。现在行内公式、块公式与推导块销毁时调用局部 `typesetClear`；异步排版在销毁后才完成时再次清理。正常移除、模式切换及人为延迟排版完成的测试均为 0 条残留。
- 修正前，隐藏后代判断和刷新后代标记均遍历所有块与所有 Callout。2000 个 Callout 加 2000 个公式的 5 次选区更新共读取 `kind` 约 8019 万次；改为源码有序的线性端点扫描后约 21 万次。相同宿主的更新中位数由约 227ms 降到约 8ms，250/1000/2000 块分别约 1/4/8ms。测试使用全量已解析的合成 StateField，耗时不含浏览器 DOM 排版，也不代表普通笔记每个按键的总耗时；线性检查次数作为稳定回归断言。
- 嵌套折叠的四种组合与原包含条件对照一致；Callout 外观、块公式、中文候选、撤销及 4MiB 纯正文浏览器回归继续通过。合成空白笔记静置 1.5 秒的脚本执行增量为 0ms。

没有增加常驻定时器、后台任务、全文缓存、索引文件或运行时依赖，也没有改动已优化的预读、正文缓存、外部同步与画布热路径。

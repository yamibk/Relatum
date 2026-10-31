# 笔记 Cards

## 写法与边界

概念卡片：

````markdown
```cards
### [book] 整理学习笔记
用自己的话概括**核心概念**，记录疑问与实例。

---

### [target] 推进工作任务
明确**下一步行动**，记录截止时间与预期成果。
```
````

列表与公式：

````markdown
```cards
### 本周计划
- 阅读并整理一篇资料
- 完成一项重要任务
- 留出时间回顾与复盘

完成进度：$3/5=60\%$。

[参考资料](https://example.com)
```
````

每卡以 `### 标题` 开始，用独立一行 `---` 分隔。至少一张卡，正文可空。
标题前可写一个 `[图标名]`：`zap/shield/chart/cpu/book/target/bulb/layers/clock/code/check/link`。
不写图标不占位，未知名称作为普通标题文字显示。图标为本地静态 Lucide 路径，许可沿用 `assets/vendor/lucide/LICENSE.txt`。

单卡染色（2026-10-31）：

````markdown
```cards
### [book] [!purple] 整理学习笔记
概括**核心概念**，记录疑问与实例。

---

### [!blue] [target] 推进工作任务
明确下一步行动和预期成果。

---

### [check] [!green] 检查完成情况
记录已经完成的事项。

---

### [!rose] 回顾与反思
没有图标也可以单独染色。
```
````

在标题开头写 `[!颜色名]`，图标和颜色顺序均可，各最多识别一个。只消费开头连续的已知标记，遇到未知或重复标记后，其余内容保留为标题文字；只有图标/颜色而没有标题时保留整组源码。旧语法和不写颜色的卡片保持原外观。

颜色直接复用 `MarkdownMini.noteBlockCatalog.colors` 的 37 个名称和深浅配色，不支持自定义 CSS 或十六进制色值：

`blue/sky/steel/denim/indigo/cyan/aqua/turquoise/teal/mint/forest/sage/olive/green/yellow/lemon/amber/orange/apricot/peach/coral/terracotta/cream/beige/brown/red/rose/pink/mauve/lavender/purple/gray/silver/stone/sand/charcoal/white`。

内容支持段落、逐行列表（有序/无序）、强调、行内代码、普通 Markdown 安全链接和行内公式。
图片、表格、嵌入内容、块公式、引用和嵌套卡片不属于第一版；不会挂载这些内容的运行时。
空、未闭合、无标题、无效结构或超出既有富块限制（256KiB 源码、64KiB 单行）时保留代码源码。
原始 HTML/SVG 经过安全行内渲染，仅显示文本，不执行。

## 外观与操作

卡片组跟随正文可用宽度，达到 560 CSS px 时两列，否则一列；同一行等高，奇数末卡不跨列。
卡片为 12px 圆角、16px 内边距、12px 间距和 1px 淡边框，字体、字号、正文/次要文字及链接色沿用四种笔记主题和深浅模式。
无阴影、悬停位移、持续绘制或背景模糊。
染色卡片背景与同名彩色块一致，深浅模式即时切换；标题、正文、图标和链接继续使用主题文字色，图标位置与布局不变。`white` 浅色为白色，深色沿用现有色板的主题表面色。

实时预览单击选择整组，双击或 Enter 展开原始源码，下方保留预览；Esc 收起并保留修改，点击正文退出源码。
链接优先走宿主既有安全打开入口。整组复制/剪切保留真实围栏 Markdown，删除可以一次撤销。
源码模式显示全文，阅读模式展示卡片；“笔记设置 → 引导 → Cards”提供效果、源码、复制、染色示例及全部图标与颜色名称，中英文界面的功能名称均为 Cards。
搜索仍可匹配卡片文字并按真实源码位置定位；命中卡片时展开源码。卡片标题不进入大纲，标签/双链沿用围栏排除规则。

## 接入与数据

- `assets/note-cards.js` 的 `RelatumNoteCards.parse(source)` 返回有效性及卡片模型 `{title,icon,color,body}`，`icon/color` 缺省为空字符串。`render(source)` 返回安全 HTML/公式特征或 null；`attach(root,options)` 管更新、公式排版与销毁。解析复用已加载 MarkdownMini 的只读色板，不依赖编辑器或网络。染色卡片仅从色板生成 `data-note-card-color` 及 `--note-card-bg-light/dark`，不将用户内容写入样式。
- `assets/note-live-editor.js` 暴露 `renderFence/attachCards`，实时、阅读、引导共用。旧 `quizFence/attachQuiz` 继续兼容；普通画布不传笔记围栏回调，仍将 cards 作为代码显示。
- 共享既有围栏三态操作和紧凑投影，卡片有独立 ID 和最多 32 条 `cardsHeights` 数值缓存，切文档清空。几何/公式变化在现有测量阶段结束后使高度图失效，选择变化复用 DOM。
- 候选期间不重解析投影；公式迟到结果核对文档、块、源文和可见身份。销毁清理公式记录及生命周期事件；无新增观察器、轮询或常驻 RAF。
- 模块和样式登记在 notes 权限下，模块随笔记初始化，样式首次有效渲染加载；无公式时不加载 MathJax。无新增后端接口、用户数据文件、配置键或正文迁移。引导只扩展原有主题偏好枚举。

## 隔离验证

专项：`node tests/note-cards-regression.js`、`node tests/note-cards-browser.js`。
浏览器沿用 `RELATUM_PLAYWRIGHT/RELATUM_EDGE_PATH`，只使用临时资产服务器、合成正文和一次性浏览器配置；截图与 validation.json 写到脚本报告的临时目录。

覆盖四主题 × 深浅色 × 宽窄窗 × 两种字号共 32 组布局/编辑检查，每组对照同名彩色块和未染色卡片的文字色；各主题深浅模式另核对全部 37 色。解析回归覆盖两种标记顺序、无图标、旧语法、未知/重复标记、空标题、CRLF 与安全转义。浏览器另验证编辑颜色后预览更新及撤销、中文候选、染色源码复制/剪切、删除撤销、模式切换、搜索定位、空行边界、中英文引导及复制、公式、重开与迟到结果。
`tests/test_note_index.py` 覆盖卡片搜索偏移、保存字节保真与围栏元数据排除；`tests/feature-profile-browser.js notes library` 覆盖真实笔记宿主的卡片加载和禁用笔记时的资源权限。
既有 Mermaid 编辑、Quiz 浏览器、笔记编辑器、Markdown、大纲及功能权限回归继续检查共享路径。
不访问生产笔记库或用户配置，不构建或重新打包。

2026-10-31 染色验证通过：上述 Cards 解析及浏览器专项（32 组布局、四主题深浅模式全部 37 色、中英文引导），`tests/feature-profile-browser.js notes library` 的真实宿主与资源权限，`tests/markdown-regression.js`、`tests/markdown-notebook-regression.js`、`tests/note-workspace-contract.js`，以及 `python -B -m unittest tests.test_note_index` 的 30 项索引检查。资源策略、工作区布局、导航布局三项原有静态回归和 `git diff --check` 通过。截图已检查，全部测试使用隔离数据；未做发布包或实际进程内存测量。

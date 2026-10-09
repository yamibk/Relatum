# 笔记内嵌画布

这是主画布算法的定向移植，独立于 `CanvasModule` 和 CodeMirror 状态。不要导入整个 `canvas.js`、复用其全局实例或嵌套 `editor.html`。

| 模块 | 责任与移植来源 |
| --- | --- |
| `session.js` | 同文件唯一模型、节点/边/相邻边索引、事务快照历史、350ms 串行修订保存。同 owner 重入复用快照；结构变化/历史回放重建索引，文字与位置变化保留索引。持久化使用独立笔记 API。 |
| `geometry.js` | 定向移植 `canvas.js` 的 `sideOfExit`、`bezierBetween`、`smoothD` 及 512 单位边空间网格；凸包缓存、Path2D 命中，超大边界使用保守回退。 |
| `engine.js` | 实例 DOM/Canvas2D、相邻拖动 SVG、批量测量、选区差集、帧合并及最终释放提交。节点/框选在超过 4px 后捕获指针；双击优先节点和连线。拖动复用尺寸与相关边集合，静态层只在边界或真实失效时刷新，连线预览用局部 SVG。参考主画布相机缩放范围、滚轮步长、34ms 缓动与惯性衰减；低动态即时更新。文字输入是本实例原生 textarea。 |
| `runtime.js` | 首次可见加载、引用视角、外框适配、共享文件会话与屏外释放。同尺寸/选中状态不重新配置或重建角柄，同文件引用的说明/尺寸更新保留引擎。引用尺寸属 Markdown，模型/历史属文件，视角属本机；三者不要混写。 |
| `canvas.css` | 实例根下的样式，按需加载，无全局节点规则和持续动画。 |

引擎 `create({host,session,readOnly,viewport,…})` 返回 `activate()`、`suspend()`、`refreshSize()`、`whenInputSettled()`、`destroy()` 和只读诊断 `stats()`。所有监听器/观察器在销毁时解除。宿主只经 `RelatumNoteCanvas.mount/flushAll/releaseNote/remapViews/renameSession` 交接；普通自动保存用 `flushAll({settle:false})`，不得中止仍在编辑的输入或手势。

基础 V2 数据由 `note_canvases.py` 验证。支持以外的数据拒绝编辑，不能过滤后保存。有效引用扫描在 `note_canvas_reference.py` 与 `MarkdownMini`；修改语法应同步前后端并验证代码/注释保护、大小写和路径沙箱。

内部更新通知的 `all/structure` 表示结构变化，`nodes/edges` 表示受影响对象，`positionOnly` 表示仅坐标变化；取消位置事务原位还原坐标，`unchanged` 结束未修改的输入而不交换模型。不要把锁状态或普通输入结束升级成全量同步。正文富块扫描必须保持范围外引用 id，避免光标与正文结构变化销毁投影。

“画布”设置页签由笔记宿主管理，不依赖本模块加载。现有本机节点尺寸唯一生效，其余分组只显示文字占位；不提前写入自定义样式字段。容器透明并保留 1px 常驻细灰边线；边线不占布局、不拦截指针。选择反馈使用中性色，公共图片角柄只在画布根内覆盖颜色。原生文字输入框隐藏滚动条，多行输入继续自动撑高。

验证使用 `tests/test_note_canvases.py`、`tests/test_note_notebooks.py` 与 `tests/note-canvas-browser.js`，均为一次性数据。浏览器覆盖双击命中、正文连续操作保持 DOM/引擎/会话身份、中文候选、保存不中断手势、正文/画布各自历史、改名保留重做、模式、共享/移动/冲突、设置迁移/语言/窄窗/主题、屏外销毁、大画布零位置测量与索引重建、静态层绘制次数及 Launcher 关闭/预热零请求。图片公共角柄另由既有图片文字浏览器回归验证。

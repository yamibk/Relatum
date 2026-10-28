# 笔记内置主题

外观分类顶部提供“默认 / Default”和“Claude”，现有用户默认外观保持原样。
主题覆盖整个笔记工作区及所属浮层，深浅色继续由全局开关控制。
笔记工作区激活时，顶部公共导航和独立专注窗口按钮同步笔记主题；
切到其他工作区恢复原有配色，全局设置保持独立。

## 入口、偏好与扩展

- `assets/note-theme.js` 在 head 读取 `canvas:noteTheme:v1` 并设置 `html[data-note-theme]`。
  缺失/无效值使用 `default`，启动不写默认，不清理无效值。
- `RelatumNoteTheme.list()` 返回冻结的内置主题登记表；`read()` 返回当前 ID。
  `apply(id, {persist=true})` / `reset()` 返回成功布尔值，存储失败不发布状态。
- 真正变化前后分别发布 `relatum:note-theme-beforechange` 与 `relatum:note-theme`，
  detail 为 `{previous,current}`。相同主题不产生事件或布局工作。
- 新主题增加登记项及 `assets/note-theme.css` 中的作用域样式；没有外部主题加载器。
  两个文件及新增字体受 notes 资源权限控制，偏好沿用桌面 `canvas:` 快照。
- 外观分类恢复和全部笔记设置恢复调用主题 reset；全局设置恢复不改变笔记主题。

## 表现与资源边界

Claude 浅色纸面/侧栏/浮层分别为 `#faf9f5`、`#f5f4ed`、`#fff`；
深色分别为 `#262624`、`#1f1f1e`、`#30302e`。强调色 `#d97757`。
设置弹窗的标题、正文、页脚统一使用暖纸底，侧栏和卡片保留独立层级；
菜单、确认及图片文字工具栏使用浮层表面，避免主面板仍为纯白或旧墨绿色。
顶栏品牌、工作区选中块、齿轮、窗口按钮均使用局部主题变量；
关闭按钮保留红色危险反馈，沉浸背景沿用渐隐，不使用背景模糊。
正文链接保持蓝色，危险、成功及用户指定颜色仍沿用自身语义。
文件染色的显式颜色行保留原背景/悬停/选中规则。

正文及文件名标题的英文使用 Source Serif 4，中文沿用微软雅黑与 Noto Sans SC；
界面继续使用原无衬线字体，源码/代码保留等宽，MathJax 保留数学字体。
Mermaid 显式使用原 Open Sans/中文后备栈，使主线程和既有 Worker 测量一致，
更换正文主题不重新生成 SVG。图谱的字体、引擎、镜头和布局不变。

字体采用 Adobe 官方固定提交 `80d3f8894c09c937bebfa9011247d2e1c79fd6f4`
中的两份可变 WOFF2，合计 755088 字节；不修改字体文件。
来源、校验和及 SIL OFL 1.1 许可在 `assets/fonts/source-serif-4-*`。
默认主题不请求新字体，运行时没有 CDN、外部字体或网络依赖。

下拉复用 `RelatumReviewControls`，位于笔记 dialog 内、滚动裁切区外，
沿用键盘、焦点、勾选和有限动画；关闭/离场/隐藏/最小化/语言/低动态切换收起。
主题切换只改变 CSS 与必要测量，不重建编辑器，不改正文或历史；
可见文本位置在切换及字体完成加载后校准，迟到任务核对文档、视图与可见会话。
沉浸背景保留原透明度及几何，不引入模糊、观察器或常驻 RAF。

## 隔离验证

- `node tests/note-theme-regression.js`：偏好规范化、不回写、失败回滚、事件顺序及恢复。
- `node tests/note-theme-browser.js`：临时数据根/浏览器配置，完整与仅笔记两种外壳，
  各 48 组主题×深浅色×背景×窗口×字号组合；下拉键盘/搜索/语言/失败反馈、
  编辑器/正文/选区复用、阅读锚点、重载、恢复、默认字体零请求与闲置零 RAF。
  截图和矩阵报告写入系统临时目录，末尾报告路径；退出关闭测试服务。
- `node tests/note-settings-browser.js`：完整、仅笔记、无图谱、无画布、无 Mermaid、
  无 Quiz、最小七组设置/保存/引导/生命周期回归。
- `node tests/note-workspace-contract.js`、`node tests/desktop-preferences-regression.js`。
- `python -B -m unittest tests.test_feature_profile tests.test_desktop_preferences`：
  主题资源权限、head 初始化顺序和桌面偏好，含跨源恢复主题。

浏览器脚本通过环境变量 `RELATUM_PYTHON`、`RELATUM_PLAYWRIGHT`、
`RELATUM_EDGE_PATH` 使用本地 Python、Playwright 和 Edge，无 npm 构建或安装。
本轮不构建桌面安装包，也不触碰仓库用户数据。

面板与顶栏补齐：已同步专项脚本中的顶栏预期，改为笔记激活时跟随、
其他工作区保留原样；按用户要求仅静态审阅差异，未运行验证或打包。

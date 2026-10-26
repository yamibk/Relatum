# 启动首帧与页面显隐 · 2026-10-26

## 首帧修复与测量口径

使用统计原先是顶栏中的可见静态 DOM，只有 `global-settings.js` 执行后才被移入隐藏的设置内容。延迟该脚本可稳定复现顶栏被统计文案撑开的画面。本次将整块静态内容直接放入隐藏设置源容器；正常加载提示、窗口显示和最大化流程保持原实现，不增加固定等待。

修改前五次隔离空数据 Edge 页面测量，首屏双 RAF 呈现采样为 490、144、146、198、161ms，中位数 161ms。此结果仅作浏览器基线，不能与下列隐藏桌面窗口的 DOM 就绪直接比较，也不能当作完整应用启动耗时。

源码桌面五轮测量使用项目已有 pywebview 环境、WebView2、完整功能默认首页。每次创建新的数据根和 WebView 配置，保留系统文件缓存；隐藏原生窗口以免干扰用户，不经过启动器功能选择弹窗，不重新打包 EXE。进程起点由父进程记录，服务就绪沿用原诊断标记；WebView 就绪取成功的原生初始化回调，首屏就绪取目录处理后首次页面提交的 `canvas-ready` 标记。普通启动没有新诊断定时器。

| 轮次 | 服务就绪 | WebView 就绪 | 首屏 DOM 就绪 | 文档内至首屏就绪 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 482ms | 1161ms | 1684ms | 503ms |
| 2 | 696ms | 1341ms | 1862ms | 494ms |
| 3 | 439ms | 1092ms | 1609ms | 495ms |
| 4 | 426ms | 1063ms | 1583ms | 497ms |
| 5 | 420ms | 1045ms | 1550ms | 489ms |
| 中位数 | 439ms | 1092ms | 1609ms | 495ms |

前三个阶段为从进程启动累计的时间，不应相加。首屏 DOM 就绪范围为 1.55–1.86s，本轮针对性检查没有据此扩大到加载体系重构。隐藏窗口、空数据和源码运行不代表用户真实发布包、磁盘完全冷启动或显示器呈现；本次不宣称整体启动提速。`before_load` 在当前 pywebview 中是桥接注入阶段，晚于部分页面内容，不能冒充 WebView 初始化时间。

## 页面行为与兼容

- 全局设置 → 导航的画布、日常列表共用原工作区勾选/拖动组件。最近、收藏、未分组和所有自定义分组均可隐藏。重排和勾选其他页保持当前页，隐藏当前页回退到第一个可见页；全部取消后主区留白，保留品牌、工作区切换、设置和窗口按钮。
- 重新开启首项立即进入。启动保留原落点，仅在目标隐藏时回退；隐藏页不短暂显示，空白不变成欢迎页或持续加载提示。恢复导航等待两份布局提交，并恢复原导航偏好。
- `canvas:pageOrder:v1`、`daily:pageOrder:v1` 由 `{order}` 扩展为 `{order,hidden}`，沿用桌面偏好快照，没有新增 HTTP API 或用户内容字段。默认不写盘；启动器禁用项保留顺序和显隐，新分组默认显示，目录未就绪/读取失败保留身份，改名保留隐藏状态。
- 旧批量开关已移除。仅当旧开关实际有效（文件管理可用）、新对象没有 hidden 数组时，兼容为五个功能页隐藏；显式保存或恢复才清理旧键。新版 hidden 数组优先，恢复后不会被旧键再次隐藏。
- `RelatumPageLayout.apply()` 返回 `Promise<boolean>`，每工作区串行处理。`configure(workspace, transition)` 登记已加载宿主，宿主准备完成后调用提交回调；失败不提交偏好，控件从已确认值恢复。未加载的宿主只保存轻量偏好，不为设置加载日常业务模块。
- `items(workspace)` 默认返回可见项，设置使用 `includeHidden:true`，候选布局可通过 `value` 参数查询。`isVisible()` 负责导航判定，`canPreload()` 同时检查工作区显隐。原分组右键排序保留隐藏分组槽位及完整后台顺序，失败比较完整布局，防止覆盖新的显隐操作。
- 隐藏页面不激活或预热。指向隐藏页的快捷入口提示开启，不自动切工作区或修改勾选；绑定专注前也检查显隐。运行中的专注计时与已有保存继续。目录元数据仍可供设置发现分组；静态共享脚本不改造成新的按需加载体系。
- 日常沿用 `beforeLeave()`、输入候选和日记保存协议；速记交接等待正文和脏页保存，失败保留现场。画布空白使用内部 `none` 路由，日常空白使用空页面身份，两者不改变顶层工作区身份。

## 验证与复现

所有服务、数据、WebView 配置、截图和原始 JSON 报告位于本次临时目录。浏览器脚本使用现有 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON` 和 `RELATUM_EDGE_PATH`；桌面测量另设置 `RELATUM_NATIVE_PYTHON` 为已准备的 pywebview Python，不安装依赖。

```text
node tests/page-layout-regression.js
node tests/start-navigation-regression.js
node tests/page-navigation-browser.js
node tests/daily-workspace-browser.js
node tests/global-settings-browser.js
node tests/feature-profile-browser.js
node tests/start-navigation-edit-browser.js
node tests/note-sidebar-browser.js
node tests/workspace-layout-regression.js
node tests/desktop-preferences-regression.js
node tests/desktop-window-contract.js
node tests/startup-timing.js <临时目录中的报告.json>
git diff --check
```

新增场景覆盖设置脚本/样式/目录响应延迟期间的首帧、逐页勾选、当前页回退、全隐藏/重开/重载、存储失败回滚、旧偏好收口、分组改名/删除/新增与隐藏槽位保留、隐藏快捷入口与深链消费、中英文/深浅/窄窗/低动态，以及开启预加载时隐藏页无预热、迟到活跃预热不产生未渲染的就绪状态。日常回归另覆盖真实日记保存失败阻止隐藏、专注服务隐藏后继续计时及重载恢复；原输入/改名回归继续检查保存时机及上次分组恢复。完整功能裁剪浏览器覆盖 19 种组合，后端功能配置/桌面偏好 30 项 unittest 通过。

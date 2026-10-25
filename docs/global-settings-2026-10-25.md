# 全局设置与工作区展示

左上角齿轮与笔记设置复用同一个原生 dialog 控制器，分别管理业务偏好。全局设置按外观、工作区、导航、日常、学习与树状、星图、生涯、使用统计、系统分组；日历倒数日归日常。功能裁剪作用于控件和分类，用户隐藏工作区不裁掉其设置。

## 入口与持久化

- `assets/global-settings.js` 迁移现有控件并首次打开时创建弹窗；原控件仍由 `start.js` 或 `start-shell.js` 绑定。公共设置资源不归笔记独占。
- 系统位于使用统计之后，仅提供“启动 RelatumLauncher 时不再弹窗”。复用客户端设置中的文案与桥接，两处入口共享读写、提交期间禁用及失败回滚；仍保存原 `data/launcher-settings.json`，不改功能选择。普通浏览器和不支持启动器的桌面包隐藏空分类，迟到的桥接结果可更新分类。此分类没有恢复按钮，恢复全部也保留启动器设置。针对性验证为 `node tests/global-settings-browser.js system library`，使用隔离数据和模拟桌面桥接。
- `settings-dialog.js` 的可选 `id/labels/motion` 区分实例，旧笔记调用和标题 ID 保持兼容。全局动效不受笔记动画选项影响。
- `theme-toggle.js` 为主题的两个现有入口创建独立遮罩的 20px SVG，浅色显示太阳、深色显示月牙；约 360ms CSS 形变独立于页面即时切色，支持反向接续及低动态，隐藏/最小化/pagehide 结束过渡。主题仍使用原存储和两种外壳的事件，不新增依赖或出站请求。
- `settings-order-list.js` 共用勾选、拖动、键盘、取消及有限反馈；笔记适配器保留原偏好与接口。异步提交期间禁止重复操作，失败重新读取已确认布局，恢复原控件焦点。
- `canvas:workspaceLayout:v1` 为完整 `{order,hidden}`，复用桌面模式偏好快照。启动不写默认，正常化过滤重复/无效 ID，缺失或损坏值使用描述默认。启动器未启用的已知项仍保存原槽位与显隐。

## 工作区契约与扩展

导航分类提供画布与日常两份仅排序列表，复用公共排序组件的 `visibility:false` 与 `setItems(ids,names)`，原工作区和笔记侧栏的勾选行为不变。共享 `start-page-layout.js` 不加载页面运行时，提供 `layout/items/apply/setGroups/routeId/route`；页序以 `{order}` 分别保存于 `canvas:pageOrder:v1`、`daily:pageOrder:v1`，启动不写默认，桌面沿用既有偏好快照。恢复导航同时清除两份顺序并恢复原速度，两种外壳一致；仅日常启用时也可设置速度。

画布的五个功能页、最近、收藏、未分组及 `group:<稳定ID>` 可混排，同一顺序驱动真实 DOM、滚轮和动画方向；操作入口固定在页面之后。重排不切当前页或重建正文。分组改名保留位置，已有自定义页序中的新增分组追加末尾；成功取得完整目录后才清除缺失身份，读取失败和未加载时保留。禁用页面保留偏好槽位，隐藏特殊页继续跳过五个功能页。设置排序只写偏好；原分组右键上下移动继续调用既有分组排序接口，交换页序中的相邻分组槽位，失败不覆盖期间的新排序。

启动器按 `parent` 递归生成连续子树，父项 `availableWhenAny` 同时指定子项的展示顺序。日常依次为每日任务、日历与日记（下含动态桌面背景）、专注、记账；功能 ID、授权和保存选择不变。

1. 在 `assets/feature-catalog.json` 的 `workspaces` 加入 `{id,label:[中文,英文],panel}`，清单顺序是默认顺序。新项默认隐藏；原有四项显式使用 `defaultVisible:true`，日常追加且默认隐藏。
2. 登记对应功能并提供带 `data-start-workspace-panel` 的面板；现有功能授权和服务端资源过滤继续生效。
3. 在 `start-workspace-runtime.js` 的 `lifecycle` 表登记 `load/leave`。加载结果提供可选 `activate()`；离场可异步返回 false 阻止切换。专用资源在自身生命周期中暂停/释放。

首帧、顶栏、搜索列表、键盘、选中滑块、切换方向及失败回退自动使用同一清单，无需复制工作区 ID 列表。`RelatumStartWorkspace.current` 可为 `none`，`layout` 返回副本，`applyLayout(value,{reset,persist})` 与普通 `set` 共用串行交接。

隐藏当前项先完成原有保存；失败不提交布局或存储。成功切至新顺序第一个可见项，全隐藏进入空白。重勾从空白进入首项，普通排序保持当前项。冷启动优先保留上次仍可见项，否则首项；空白不覆盖上次真实 ID。加载失败按可见顺序逐项回退并隔离本轮失败身份，无候选留白，可重试。

空白只显示品牌、全局设置和窗口按钮；背景照片和工作区专属入口隐藏。隐藏笔记/生涯及空白状态不进行相应预热，专注首屏预读也检查画布显隐；已在进行的保存继续结清。

## 验证

使用隔离临时数据、浏览器配置与截图，无发布包或用户库写入：

```text
node tests/workspace-layout-regression.js
node tests/page-layout-regression.js
node tests/page-navigation-browser.js
node tests/theme-toggle-browser.js
node tests/global-settings-browser.js
node tests/note-settings-browser.js --motion
node tests/note-sidebar-browser.js
node tests/feature-profile-browser.js
node tests/note-workspace-contract.js
node tests/start-research-shell-contract.js
node tests/desktop-window-contract.js
node tests/desktop-preferences-regression.js
python -m unittest tests.test_feature_profile tests.test_desktop_preferences
git diff --check
```

浏览器依赖路径使用既有 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON`、`RELATUM_EDGE_PATH`。全局浏览器脚本可按参数选择 `full/notes/research/career/library/mixed/cold`，截图保存在输出的临时目录。

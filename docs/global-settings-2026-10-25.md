# 全局设置与工作区展示

左上角齿轮与笔记设置复用同一个原生 dialog 控制器，分别管理业务偏好。全局设置按外观、工作区、导航、日常、学习与树状、星图、生涯、使用统计、系统分组；日历倒数日归日常。功能裁剪作用于控件和分类，用户隐藏工作区不裁掉其设置。

## 入口与持久化

- `assets/global-settings.js` 迁移现有控件并首次打开时创建弹窗；原控件仍由 `start.js` 或 `start-shell.js` 绑定。公共设置资源不归笔记独占。
- 系统位于使用统计之后，提供后台预加载和日常页面保留时长。支持启动器的桌面包另显示原“启动 RelatumLauncher 时不再弹窗”，仍复用客户端桥接、串行保存及失败回滚，保存在 `data/launcher-settings.json`。普通浏览器同样显示资源设置；桥接迟到只更新启动器行，不重建弹窗。系统分类恢复及全部恢复只重置资源偏好，保留启动器设置。
- `settings-dialog.js` 的可选 `id/labels/motion` 区分实例，旧笔记调用和标题 ID 保持兼容。全局动效不受笔记动画选项影响。
- `theme-toggle.js` 为主题的两个现有入口创建独立遮罩的 20px SVG，浅色显示太阳、深色显示月牙；约 360ms CSS 形变独立于页面即时切色，支持反向接续及低动态，隐藏/最小化/pagehide 结束过渡。主题仍使用原存储和两种外壳的事件，不新增依赖或出站请求。
- `settings-order-list.js` 共用勾选、拖动、键盘、取消及有限反馈；笔记适配器保留原偏好与接口。异步提交期间禁止重复操作，失败重新读取已确认布局，恢复原控件焦点。
- `canvas:workspaceLayout:v1` 为完整 `{order,hidden}`，复用桌面模式偏好快照。启动不写默认，正常化过滤重复/无效 ID，缺失或损坏值使用描述默认。启动器未启用的已知项仍保存原槽位与显隐。

## 工作区契约与扩展

导航分类提供画布与日常两份勾选/排序列表，复用公共排序组件与 `setItems(ids,names)`，原工作区和笔记侧栏的勾选行为不变。共享 `start-page-layout.js` 在 head 中准备首帧显隐，不加载页面运行时；`layout/items/apply/setGroups/routeId/route` 之外提供宿主 `configure()` 和 `isVisible/canPreload`。原 `canvas:pageOrder:v1`、`daily:pageOrder:v1` 扩展为 `{order,hidden}`，启动不写默认，桌面沿用既有偏好快照。异步 `apply()` 串行等待宿主完成输入/保存/页面准备，在提交点写偏好，失败返回 false；恢复导航等待两份布局恢复并恢复原速度，两种外壳一致。显隐和启动测量的完整契约见 [2026-10-26 补充](startup-and-page-visibility-2026-10-26.md)。

画布的五个功能页、最近、收藏、未分组及 `group:<稳定ID>` 均可勾选和混排，同一可见顺序驱动真实 DOM、滚轮和动画方向；重排不切当前页或重建正文。隐藏当前页回退到首个可见页，全隐藏主区留白，设置仍可重新开启。分组改名保留位置和显隐，新分组默认显示，已有自定义页序中的新增分组追加末尾；成功取得完整目录后才清除缺失身份，读取失败和未加载时保留。禁用页面保留顺序和显隐。旧“隐藏特殊页”已合并，缺少新版 hidden 字段时兼容原有效开关，显式提交/恢复后清理旧键。设置排序只写偏好；原分组右键上下移动继续调用既有分组排序接口，只交换可见分组槽位，失败不覆盖期间的新排序。

启动器按 `parent` 递归生成连续子树，父项 `availableWhenAny` 同时指定子项的展示顺序。日常依次为每日任务、日历与日记（下含动态桌面背景）、专注、记账；功能 ID、授权和保存选择不变。

1. 在 `assets/feature-catalog.json` 的 `workspaces` 加入 `{id,label:[中文,英文],panel}`，清单顺序是默认顺序。新项默认隐藏；原有四项显式使用 `defaultVisible:true`，日常追加且默认隐藏。
2. 登记对应功能并提供带 `data-start-workspace-panel` 的面板；现有功能授权和服务端资源过滤继续生效。
3. 在 `start-workspace-runtime.js` 的 `lifecycle` 表登记 `load/leave`。加载结果提供可选 `activate()`；离场可异步返回 false 阻止切换。专用资源在自身生命周期中暂停/释放。

首帧、顶栏、搜索列表、键盘、选中滑块、切换方向及失败回退自动使用同一清单，无需复制工作区 ID 列表。`RelatumStartWorkspace.current` 可为 `none`，`layout` 返回副本，`applyLayout(value,{reset,persist})` 与普通 `set` 共用串行交接。

隐藏当前项先完成原有保存；失败不提交布局或存储。成功切至新顺序第一个可见项，全隐藏进入空白。重勾从空白进入首项，普通排序保持当前项。冷启动优先保留上次仍可见项，否则首项；空白不覆盖上次真实 ID。加载失败按可见顺序逐项回退并隔离本轮失败身份，无候选留白，可重试。

空白只显示品牌、全局设置和窗口按钮；背景照片和工作区专属入口隐藏。隐藏笔记/生涯及空白状态不进行相应预热，专注首屏预读也检查画布显隐；已在进行的保存继续结清。

## 隐藏后的资源保留（2026-10-31 源码评估）

工作区与导航的勾选控制可见性和预加载资格，已加载内容按各模块现有生命周期暂停或释放，目前没有统一的“取消勾选即完整卸载”约定。本节只记录现状和后续建议，不改变资源策略或持久化。

| 对象 | 隐藏/离场时的处理 | 仍保留的主要内容 |
| --- | --- | --- |
| 笔记工作区 | 保存交接，停止外部同步、正文预取和计算，释放图谱引擎；离场完成后清理阅读 DOM | 编辑器、撤销历史、文档/目录缓存及有界图谱场景 |
| 研究工作区 | `start-workspace-runtime.js` 调用 `suspend()`，暂停仿真、计算及交互 | iframe、文档模型和运行时；取消勾选尚不调用 `dispose()` |
| 生涯工作区 | 可见退出期间暂停，实际隐藏后销毁已挂载图表和工具提示 | 报告数据和页面 DOM |
| 整个日常工作区 | `daily-workspace.js` 在工作区隐藏时将保留期视为 0；离场完成后销毁实例、移除页面 DOM 和所属样式 | 轻量页面状态快照及已加载共享脚本；覆盖 session 保留选项 |
| 日常单页 | 当前页先完成保存交接再停用；图片编辑另释放解码图像、清空绘图缓冲 | 单页实例和状态，直到整个日常工作区按策略释放 |
| 画布导航页 | 隐藏项不再发起新预加载；离场由各模块停止活动，星图在交接结束后释放引擎 | 部分页面 DOM、已读数据及编辑状态；隐藏最近/收藏/分组不删除其画布文件 |

预加载资格不等于对所有在途请求的统一取消。已执行的共享脚本和必要业务状态也不会因勾选变化自动卸载。解除引用后的回收时机由浏览器/操作系统决定，任务管理器的进程内存不保证立即下降；本次没有实测整机 RAM 或 GPU 用量。

后续建议按顺序单独设计和验收：日常单页在保存成功、交接完成后销毁实例并保留必要恢复状态；研究工作区在可靠保存完成后销毁 iframe 并支持重新加载；再评估速记/树状等页面的较大缓存、取消在途预加载及迟到结果隔离。笔记完整卸载须先明确撤销历史、选区和阅读位置恢复机制。验收覆盖保存失败不隐藏、快速重勾隔离旧清理任务、后台活动停止及反复开关无实例累积。

## 验证

### 全局系统资源策略（2026-10-28）

`RelatumGlobalSystem` 位于公共首帧脚本 `feature-runtime.js`，不加载笔记运行时。`read()` 返回冻结的规范化偏好，`update(patch)` 和 `reset()` 保存成功后才发布 `relatum:global-system`，失败返回 false；设置控件回滚并提示。新键 `canvas:globalSystem:v1` 沿用桌面窗口模式快照，默认不落盘。

| 字段 | 默认与选项 | 生效 |
| --- | --- | --- |
| `preload` | true；开/关 | 下次启动 |
| `dailyRetention` | immediate；另有 30s、5m、session | 即时 |

有效预加载必须同时满足启动器 `runtime.preload` 和本次启动的用户选择。`relatum:globalSystemBoot:v1` 仅存在会话存储，以既有桌面 `sessionKey:launchId` 区分启动，跨主界面、编辑器和研究 iframe 保持一致；浏览器按标签页会话固定。设置和恢复只改变下次启动的选择，不中断本次任务。启动器禁用时显示原因并禁用控件，不能绕过功能权限。

日常的保留选项为立即释放、30 秒、5 分钟和直到关闭窗口；仅在日常能力可用时出现。说明明确保留内存的代价，以及刷新、独立编辑器导航、关闭窗口和隐藏工作区时会释放。使用原生单选控件，支持方向键、搜索、中英文和宽窄/深浅主题。笔记系统偏好不受影响。

定向验证：`node tests/global-system-regression.js`、`node tests/global-system-browser.js`、`node tests/global-settings-browser.js system library`，配合桌面偏好 JS/Python 回归。新浏览器测试使用临时数据和测试时钟覆盖实际 30 秒/5 分钟到期、缩短期限、整次会话保留、过期任务隔离、输入法交接、数据复核、存储失败及后台零 RAF/零轮询；输出截图和测量报告到临时目录。

一次 Edge 无头、1440×980、低动态、空白隔离库的五次返回测量：立即释放中位数 36.01ms、重建 5 次；保留中位数 29.15ms、重建 0 次。各模式预先打开任务、日历、专注、记账；后续 12 轮往返监听数分别固定为 612、732。离场 GC 后 JS 堆约为 3.97MB、4.04MB，DOM 节点分别为 4996、5915；保留模式承担了额外页面成本。这是自动化等待及 JS 堆计量，不代表物理显示延迟、整机 RAM、GPU 用量或大型真实数据下的提速比例。原始报告由上述测试重新生成，不改发布包。

本次相关浏览器回归（全局全部模式、笔记设置七组合及动效、笔记侧栏、功能裁剪、日常、图片编辑）与桌面偏好/日常数据专项通过。旧 `note-system-browser.js` 仍断言“系统”为笔记最后一类，现有“扩展”分类使其失败；`test_note_ai_can_load_shared_choices_without_review` 仍要求仅笔记不能访问共享下拉资源，与已有扩展加载链冲突。两处均用 Git HEAD 的应用代码复现，未调整无关功能或放宽原断言，不计入通过项。本次未打包，也未替代真实桌面输入法与整机资源验收。

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

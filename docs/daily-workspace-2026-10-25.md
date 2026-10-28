# 日常工作区与独立专注服务

日常从画布首页迁出每日任务、日历、专注和记账。日记、倒数日继续属于日历；学习、复习、树状、速记和活跃仍在画布。数据文件路径保持原样，没有改写个人数据或重新打包发布目录。

## 入口与模块边界

- 清单登记 `daily / 日常 / Daily`，追加且默认隐藏。全局设置提供勾选、排序和恢复；全部子功能关闭时不可用，启动器父项仍可开启子项。
- 能力为 `daily.tasks`、`daily.calendar`、`daily.focus`、`daily.ledger`、`daily.images`，动态桌面为 `daily.calendar.wallpaper`。没有旧功能 ID、旧页面模式或旧偏好的迁移层。
- 首页常驻的 `daily-loader.js` 只负责加载、设置接线、轻提示和必要的专注恢复检测。`daily-workspace.js` 首次进入才加载；五页各有独立 CSS，任务和计时器另有独立 HTML。
- 五个入口默认按每日任务、日历、专注、记账、图片编辑排序；全局设置“导航”可拖动调整及隐藏，用 `daily:pageOrder:v1` 的 `{order,hidden}` 保存，重排保留当前页，未启用子项保留槽位。`daily:page:v1` 恢复有效子页，否则使用新顺序第一项可用页。各页工厂接收 `(root, host)`，提供 `activate/deactivate/destroy`，需要保存交接的页面另提供异步 `beforeLeave`。
- 导航栏使用独立选中滑块和反向文字轨道，共用 `--spine-motion-ms`（默认 447ms）及既有缓动；快速点击从当前显示位置接续，业务选择只在交接成功后提交，失败回到原页。宽窗纵向、窄窗横向，尺寸/语言/恢复/低动态直接校准。导航栏内滚轮累计 24 单位触发一页，200ms 安静后清零，反向立即接续最新目标，到首尾停住；正文滚轮与缩放/横向手势保留原行为。离场、隐藏、最小化与销毁清理动效、滚轮计时器及测量任务，闲置无 RAF。
- 宿主统一负责最新导航身份、页面请求取消、全局监听和有限绘制任务。日记失败返回 false，候选输入尚未完成时保留原编辑现场；快速切换不让旧加载挂载到新页面。
- 工作区内保留已加载视图；离开后先完成外层过渡，再销毁视图、订阅、弹层、监听和闲置数据。保留子页、日历日期、账本月份及滚动等轻量会话状态。快速返回作废旧释放任务。
- `navigate(page, params)` 支持日期和专注记录定位；日历跳活跃通过画布宿主交接，专注历史沿原授权打开来源画布。倒数日返回 `index.html?workspace=daily&view=calendar`。
- 页面便签由共享控制器接收宿主注册；离场取消拖拽并清除旧宿主引用，不需要加载画布首页。

## 资源与可见生命周期

- 未进入日常，不请求五页运行时、模板、样式或业务快照。唯一例外是已有运行/待收尾专注：只恢复专注服务，不加载界面。
- 进入后复用共享空闲调度器，串行预读尚未打开的任务、专注快照，最多各一份；只读数据，不建隐藏 DOM。任务沿原 40 项/60 分组上限，专注明细沿原 2000 条上限。
- 关闭后台预加载时没有这些准备。离场、隐藏和原生最小化取消准备和前台读取；旧响应核对当前身份和缓存版本。账本、日历汇总不参加这条预热链。
- 日历保留原月份、日期和草稿预算；工作区销毁时释放缓存。账本只在打开后获取整本快照，保留 BigInt 精确模型、修订号、乐观写入和失败恢复。
- 作用域取消绘制、有限计时器和全局监听。已经确认的删除及保存继续提交；任务删除等待动画的延迟动作会在离场时提交，不被视觉清理丢弃。
- 外层工作区退场期间暂停内部有限动画，过渡后销毁；快速返回先取消旧冻结再准备当前页。深度专注使用日常宿主全宽，隐藏日常侧栏，Escape 恢复。
- 已执行的 JavaScript 仍可能被浏览器保留；移除视图并不等于卸载脚本或保证归还全部进程内存。

## 专注与存储

- `focus-service.js` 拥有计时、暂停、阶段、目标、成果、恢复及雨声音源；`focus.js` 仅负责界面订阅。切换子页或工作区不打断运行中的计时和声音，隐藏时不逐秒更新 DOM。
- 暂停和等待收尾停 ticker；恢复按实际时间补算。已过期的倒计时转为待收尾，不弹恢复确认；成果保留，打开专注页再处理。pagehide 停止音源并释放 PCM，BFCache 恢复接续状态。
- 保存为 single-flight，专注段使用稳定 id，完整请求保留在待收尾快照中。后端记录按 id 去重；任务分钟请求携带同一 `requestId`，任务私有 `focusMinuteRequests` 最多 2000 项，不返回前端视图，避免不确定回应后的重复累计。
- 继续使用 `data/daily.json`、`focus.json`、`ledger.json`、`countdown.json` 和 `data/diary/*.md`，保留原子写入、备份、修订与路径授权。
- 新界面偏好使用 `daily:`，由桌面偏好快照管理；日历显示/进度模式、任务回顾、账本数字页/显示偏好和专注运行态均使用新命名空间。恢复全局“日常”只处理对应全局偏好，不改内容或运行中的专注。

## 图片编辑（2026-10-28）

- `daily.images` 默认启用，`images` 接在记账之后；沿用导航排序、显隐及启动器功能裁剪。运行时为 `image-markup-core.js / daily-images.js / daily-images.css`，只在实际打开页面后加载，不预热或依赖完整编辑器。
- 单图大工作台：粘贴、拖入及文件选择，PNG/JPEG/WebP/BMP/GIF 首帧，多文件只处理首张。页面名称中英文为“图片编辑 / Image editor”，图片容器使用透明背景和细边界线，沿用深浅主题。默认红色矩形，提供选择、椭圆、箭头、直线、画笔、多行文字、矩形马赛克、裁剪，预设颜色/线宽/字号/马赛克强度；可移动缩放、双击改字、删除标记。适应容器、100%、缩放和空格拖动只改变视图，数据始终使用原图坐标。
- 线宽、字号和马赛克强度复用笔记同款 `RelatumReviewControls`。隐藏原 select 保留 change 接口，实际触发按钮、勾选与键盘选择由共享管理器负责；共享 JS/CSS 由图片页登记权限并按需加载。局部取消外扩黑色焦点框，使用淡背景/内部边界反馈；body 独立弹层避免裁切，关闭、切换、隐藏及最小化均收起，视图销毁 dispose 并移除容器，不重建其他编辑器。
- 轻点判定使用全路径最大屏幕偏移（含合并采样和最终松手坐标），不超过 4 CSS px 时，若命中已有标记，松手选中最上层对象，保留当前工具、丢弃临时绘制，不写历史；明显拖动仍绘制，拖远返回仍按真实拖动处理。空白处保持各工具原行为，缩放手柄、待确认裁剪及空格平移优先。文字工具点空白放置文字，双击旧文字编辑。Backspace 与 Delete 共用删除：先取消预览，只删已提交对象，无对象不写历史、不删原图；文本、候选、下拉与菜单操作不被抢占。
- 独立 `.images-image-frame` 展示层仅跟随图片实际屏幕边界，显示约 12px 的轻微静态阴影和细边缘；跟随缩放、平移、裁剪和视图恢复，深浅主题自动适配，隐藏/删除/释放时收起，不接收指针、不进入图片模型或剪贴板输出，无新增循环。
- 顶部、右键或 Ctrl+C 导出 PNG 到剪贴板，裁剪以原图整数像素输出，保留透明度且排除操作控件。文字使用同一 Canvas 字体、换行及绘制函数，马赛克从原图下采样后用最近邻放大，再叠加其他标记。裁剪应用/取消、恢复原图、文字及样式更改、导入替换、叉叉/菜单删除均纳入撤销；Ctrl+Z、Ctrl+Y/Ctrl+Shift+Z 支持回放。文本输入及候选期间不抢占原生快捷键。
- `host.state.markup` 仅存会话 Blob、几何、至多 100 步历史、样式及镜头。图源最多当前及最近一个旧图，新导入淘汰更早的图源与历史；删除可撤销恢复。工作区离场后释放视图及解码图片，返回从快照重建；刷新/关闭后清空，无图片持久化、新偏好键或新后端接口。原图引用不会被 JSON 复制或逐步栅格化。
- 解码前检查 40 MiB、最多 1 MiB 文件头、16384 单边与 64 Mi 像素，解码后再复核。读取失败保留当前图；读取、解码与剪贴板编码核对生命周期、文档版本及操作身份，旧结果不能覆盖后来操作。前台按帧绘制，隐藏/最小化/离场释放画布、位图、马赛克缓存（8 MiB）、菜单、观察器及全局监听；普通样式更新和闲置不启动常驻循环。
- `tests/image-markup-core-regression.js` 覆盖历史和几何；`tests/daily-images-browser.js` 以真实 Edge、临时服务与权限验证图形调整、文字/合成输入、六类工具、裁剪、透明 PNG、图片格式、拖入/真实剪贴板、尺寸预检、复制拒绝、迟到导入、跨工作区重建与 DPR 2/闲置零 RAF。交互专项覆盖三类自制下拉的中英文、深浅、键盘和焦点；九种工具的 0/3/4px 轻点、重叠命中、保留工具、撤销零写入、超过阈值与拖远返回、两种删除键及输入/下拉隔离；图片阴影跟随镜头、裁剪及恢复，导出逐像素哈希不变。DPR 2 另覆盖约 26%/100%/381% 缩放下的 4px 判定。`--native` 改用现有源码桌面环境，设置 `RELATUM_NATIVE_PYTHON`，不生成发布包；Chromium 合成输入不等同于真实微软拼音候选窗。
- 本次核心、页面布局、日常 Python、图片页 Edge/源码 WebView2、日常工作区、页面导航、全局设置（full/library/cold）、功能裁剪（library/daily-tasks/daily-ledger/daily-images）及五轮隔离源码启动检查通过。图片页额外覆盖编码延迟后删除、六次销毁重建和监听数量不累积。合并运行 `tests.test_feature_profile` 时有一项既有失败：`test_note_ai_can_load_shared_choices_without_review` 仍假设禁用 AI 的笔记不能访问共享下拉；用 HEAD 原始清单复核，同样返回可访问。本次未修改该笔记资源归属或断言，没有重新打包。

## 验证与测量

所有测试使用一次性数据根、浏览器配置和截图，没有读写真实画布、笔记、配置或发布包。

```text
node tests/daily-focus-service.js
node tests/image-markup-core-regression.js
node tests/daily-images-browser.js
node tests/page-layout-regression.js
node tests/page-navigation-browser.js
node tests/daily-workspace-browser.js
node tests/feature-profile-browser.js calendar focus daily-tasks daily-ledger daily-images library
node tests/global-settings-browser.js full library cold mixed
node tests/resource-lifecycle-browser.js --on-demand
node tests/workspace-layout-regression.js
node tests/calendar-countdown-progress-date-regression.js
node tests/ledger-model-regression.js
python -B -m unittest tests.test_daily_workspace tests.test_feature_profile tests.test_daily_goals tests.test_ledger tests.test_diary_index tests.test_calendar_daily_study tests.test_calendar_canvas_activity tests.test_taskbook_focus tests.test_desktop_preferences
```

浏览器测试使用已有 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON` 和 `RELATUM_EDGE_PATH`；Python 导入 `app` 前先将 `RELATUM_DATA_ROOT` 指向一次性目录。

`daily-workspace-performance.js` 从 Git 读取基线资源，在隔离服务上交替测量前后版本，不切换工作目录。默认 5 次独立浏览器配置，1440×900、默认完整能力、空库，加载后等待 3.5 秒并 GC。若设置已有桌面环境的 `RELATUM_DESKTOP_PYTHON`，额外测 3 次隐藏的源码桌面壳，每次使用全新的数据根和 WebView2 用户目录；采样主进程及其 WebView2 子进程的私有提交内存。没有安装依赖、覆盖发布目录或清理 OS 文件缓存。

首轮基线 `e0c297e16b4512a1a432f4e1cbf1cabc15451296`，中位数：

| 指标 | 原版 | 日常拆分后 |
| --- | ---: | ---: |
| 浏览器首页 DOM 元素 | 3374 | 2901 |
| 首页脚本和样式解码字节 | 5,597,074 | 4,926,423 |
| 浏览器 GC 后 JS 堆 | 5.19 MiB | 4.81 MiB |
| 浏览器脚本时间 | 113.1 ms | 83.4 ms |
| 浏览器布局时间 | 60.3 ms | 63.5 ms |
| 隐藏桌面壳私有提交内存 | 363.84 MiB | 356.70 MiB |

首页脚本和样式约减少 655 KiB；隐藏桌面壳约减少 7.14 MiB（约 2%）。这些数字是空库固定等待窗口下的观测，包含已有其他工作区的准备过程，不代表可见窗口帧率、大型用户库或整机物理内存下降比例。布局耗时没有显示改进。

另做 5 轮浏览器首开/返回测量，点击真实导航按钮，采用低动态，等待对应业务读取及两帧绘制。每日任务首开包含首次进入日常；其余三页从日常内部进入。中位数（ms）：

| 页面 | 原版首开 | 日常首开 | 原版返回 | 日常返回 |
| --- | ---: | ---: | ---: | ---: |
| 每日任务 | 202.8 | 89.0 | 83.4 | 24.8 |
| 日历 | 129.8 | 70.8 | 79.2 | 21.1 |
| 专注 | 108.3 | 75.3 | 79.0 | 24.9 |
| 记账 | 100.0 | 43.4 | 87.8 | 24.8 |

这些是自动化端到端等待耗时，页面组织和交接方式也已改变，不能当作纯渲染耗时或物理显示延迟。同批浏览器冷启动的 DOMContentLoaded 中位数为 167.2 → 112.3ms，load 为 206.4 → 416.4ms；load 事件没有变快，不能据资源变少宣称启动全面提速。各轮保留原有其他工作区的准备过程，未清理 OS 文件缓存。

业务回归覆盖实际任务创建/打卡/详情、四页内容、日记失败阻止子页及工作区离场、账目录入、中英文、深浅及窄窗、最新导航、真实动画冻结与快速返回、深度专注、跨页计时和重载恢复。连续 12 次工作区往返后，GC 后监听数仍为 1236，没有累计；一次完整运行的 JS 堆从 6,183,140 到 6,335,272 字节，此单次观察不作为进程内存无增长保证。原始测量值保存在同目录的 samples JSON，截图和完整运行报告由测试输出到临时目录。

相关 Python 专项 89 项通过；全量 discovery 共 574 项、1 项跳过，普通 Python 缺少原生 clr 的 4 项失败/错误另在已有桌面 Python 中重跑原生 6 项并全部通过。功能裁剪、全局设置和资源生命周期浏览器回归通过。`start-spine-motion-browser.js` 四种主题/DPR/低动态行为通过，窗口缩放后的形变校准仍报 2 个未结束动画；同一测试替换为 Git HEAD 的原书脊脚本和样式后复现相同失败，本轮没有更改书脊引擎。

`start-navigation-browser.js`、`start-page-transition-browser.js` 继续保留旧日历/专注书脊拓扑的历史对照逻辑，本轮不将它们算作通过项。当前迁移页面的交接、迟到响应与退场由新浏览器回归覆盖，剩余画布导航另运行 `start-navigation-regression.js` 和 `start-navigation-edit-browser.js`。

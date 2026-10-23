# 笔记 Mermaid / Pele 接入（2026-10-23）

## 用户行为与范围

Launcher 的“笔记工作区”下增加默认勾选的“Mermaid 图表”。稳定 ID 为
`notes.mermaid`，与图谱、内嵌画布平级，不依赖主画布。版本 1 配置缺少此项
时采用默认值，关闭父项保留子项勾选。直接完整启动保持启用。

- 实时预览显示图表，点击或键盘激活后展开原围栏，离开后重新出图。
- 源码模式始终显示代码，不启动图表资源。
- 阅读模式适配正文宽度，保留 LR/TD 等方向；图表缩小时可缩放、平移、复位，
  普通滚轮继续滚动正文。控件支持中英文与键盘。
- 禁用后保留 Markdown，阅读显示普通代码与复制入口。
- 其他区域继续已有 Mermaid.js，本次开关只控制笔记。

Pele 支持 Mermaid 12.1.0 内置图表，使用自己的布局，不能要求与 Mermaid.js
像素一致。颜色来自主题 CSS 变量及作者显式样式；Mermaid 的 `themeVariables`
不等同于 Pele 主题。首版不排版节点内 LaTeX，也不提供外部图像、图表链接、
JavaScript 回调或外部图表插件。

## 源码与离线资源

`assets/vendor/pele/` 收录未经改写的 Pele 1.9.0 全量浏览器包、MIT 许可证和
来源/校验信息。`pele.global.js` 为 706,153 字节（约 0.67 MiB），当前旧 Mermaid
脚本为 3,572,657 字节（约 3.41 MiB）；两者都是未压缩文件大小。
运行与构建不需要 npm 或 CDN。

`assets/note-mermaid.js`、专用 CSS 和 vendor 目录归 `notes.mermaid` 独占。
禁用时服务端拒绝访问；仅笔记会话不再加载旧 Mermaid 适配器。普通正文、
源码模式、未闭合/空围栏和隐藏编辑器预加载不触发 Pele。

原实时预览故障来自 widget 的 `toDOM()`：挂载前同步执行 `isCurrent()`，
因 `isConnected === false` 跳过，之后没有补发。新入口先在挂载后观察真实
可见性，再验证文档及块身份。引用/Callout 围栏保留包含引用前缀的原始源码
范围，另生成去前缀渲染源；不改磁盘正文。

共享 `MarkdownMini.renderResult(source,{mermaid:false})` 可关闭图表容器输出，
默认值保持既有行为，并传递至脚注递归。笔记渲染器不再依赖 `MermaidRenderer`。
新适配器提供 `attach(root,{mode,isCurrent,onLayout,whenSettled?})`，返回
`suspend()`、`resume()`、`destroy()`。`whenSettled` 只用于编辑器的输入法交接。

## 性能、安全和生命周期

每图解析一次，宽度或字体改变时重用模型。多图按约 4ms 批间让出主线程，
不承诺可打断单张同步渲染。颜色通过 CSS 变量更新，无常驻动画循环。
只在宿主祖先上观察属性，不观察 body 子树。

源码上限为 65,536 个 JS 字符，沿用原编辑器的保护；不是 UTF-8 字节数。
Pele 输出限 4,000,000 字符，流程图和 agentflow 边限 5,000。实时预览超限
保持代码；阅读显示源码及限制说明。加载失败可重试，语法错误需编辑源码，
不会自动加载第二套引擎。

`links:false`、`images:false` 在渲染时固定设置。生成 SVG 在插入前再次移除
脚本、foreignObject、媒体、SVG 动画、事件属性、外部 href 和 CSS 资源引用。
错误及源码使用文本节点展示。内部 marker/gradient 的 fragment 引用保留。

切文档、模式、工作区，隐藏、原生最小化及 pagehide 停止任务，释放 Resize/
IntersectionObserver 和缩放行为，保留恢复所需的属性/生命周期监听；销毁
释放全部监听和模型。脚本/资源下载及已开始的同步渲染不可抢占，返回结果
必须再次核对生命周期与源码身份。候选输入期间不绘制或强制测量；结束后
等待原编辑器提交再恢复。Markdown、撤销历史及笔记持久化格式不变。

## 验证与测量

- `node tests/note-mermaid-browser.js`：静态隔离夹具，八类图、中英文、主题、
  编辑/撤销、禁用、错误、重试、引用、超限、输出边界、迟到、候选、原生最小化、
  pagehide、窄窗、DPR 1/2、低动态。截图和 JSON 报告输出临时目录。
- `node tests/feature-profile-browser.js`：真实服务，包含完整、仅笔记、独立启用、
  混合禁用和父项关闭，核对实际绘制和直接资源拒绝。
- `node tests/note-mermaid-desktop.js <独立发布目录>`：使用发布包本身的脚本及
  真实 RelatumLauncher.exe / WebView2，验证开关、键盘展开源码、阅读缩放、
  原生最小化恢复、三种模式、代码回退、资源拒绝及退出后的 Markdown 字节不变。
  矮长图预留 110px 缩放视口，检查全部控件没有被外层裁切。
- `node tests/note-mermaid-performance-browser.js`：三轮交替对照旧 Mermaid，
  同一中文流程图、同一 Edge、相同尺寸及 100 图逐项查看路径。计时包含
  适配器、引擎加载、SVG 插入与布局，限图表承载面，不代表整窗启动时间。
  保存逐轮长任务、CDP Task/Script/Layout 指标、GC 后堆及释放后堆。
  CDP ScriptDuration 不等于全部 Promise 微任务 CPU，以完整耗时和长任务为主。

本机三轮中位数（毫秒，GC 后堆只统计 JS 堆，不代表进程总内存）：

| 场景 | Pele 首屏 / 完成 | 旧 Mermaid 首屏 / 完成 |
| --- | ---: | ---: |
| 冷加载单图 | 55.3 / 56.0 | 255.6 / 256.3 |
| 同页重复打开 | 3.7 / 4.1 | 22.0 / 22.6 |
| 100 图连续查看 | 35.2 / 914.4 | 1825.9 / 2900.6 |

100 图 GC 后 JS 堆中位数约为 4.27 MiB / 6.80 MiB；两套引擎闲置均无新增 RAF。
Pele 样例未观察到超过 50ms 的长任务；旧 Mermaid 冷单图观察到长任务，但其
100 图异步工作被拆成多个任务，因此不能根据长任务为零判断总负载为零。
原始逐轮数据见 [性能样本](note-mermaid-performance-2026-10-23.json)。

已完成的回归包括 45 项功能配置/原生 Launcher/桌面构建单测，以及 Markdown、
实时编辑器、工作区、语义索引、Callout、正文滚动、视图状态、原生输入和关系图谱。
源码启动矩阵包含 17 种组合（工作区笔记和画布速记在旧测试中都名为 notes，
夹具按实际启用工作区区分）。独立发布目录为 `D:\Relatum-mermaid-release-20261023`，
未覆盖其他发布目录或用户数据。

官方所称 100～500 倍来自其特定基准，不作为 Relatum 的验收或宣传结论。
上游依据：[Obsidian 更新说明](https://obsidian.md/changelog/2026-10-22-desktop-v1.15.0/)、
[Pele 兼容性](https://pele.run/compatibility)、[安全接口](https://pele.run/security)。

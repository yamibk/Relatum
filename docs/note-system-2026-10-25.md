# 笔记系统设置

“笔记设置”的最后一类是“系统 / System”。保留纸张、墨色及黑白灰表面，
使用现有设置搜索、分类恢复与全部恢复。搜索细调字段会展开所属 details 并聚焦实际控件。

## 行为与预算

| 预设 | 动画 | 正文预读 | 缓存 | 图谱像素比例 |
| --- | --- | --- | --- | --- |
| 均衡，默认 | 开启，服从系统低动态 | 开启 | 标准 | 100% |
| 节省资源 | 关闭 | 关闭 | 较小 | 75% |
| 切换优先 | 开启，服从系统低动态 | 开启 | 较大 | 100% |

手动调整后按四项实际组合显示预设或“自定义”，不另存预设名称。
图谱清晰度可选 50/75/100%，只改变绘图后备像素，不改变 CSS 布局、文字、镜头和命中坐标。
滑条 input 只更新数值，change 才提交策略，避免拖动期间反复分配绘图缓冲。

| 缓存 | 较小 | 标准 | 较大 |
| --- | --- | --- | --- |
| 正文 | 6 篇 / 4 MiB | 24 篇 / 16 MiB | 48 篇 / 32 MiB |
| 图谱场景 | 6 本 / 4 MiB | 24 本 / 16 MiB | 48 本 / 32 MiB |
| Mermaid 主线程与 Worker 各自 | 8 项 / 2 MiB | 32 项 / 8 MiB | 64 项 / 16 MiB |

计量沿用各缓存原口径，不是 JS 堆或进程 RAM 的硬上限。当前正文、待保存内容、活动图表
与正在显示的图谱场景受到保护，必要时允许超出预算。字体、阅读高度提示和真实文档不归此清理。
降低档位立即淘汰闲置条目，离开活动图表后再次核对预算。

“清理未使用缓存”取消正文预读和图谱后台准备，清理闲置正文、图谱及 Mermaid 结果/模型；
保留当前正文、编辑器及撤销、AI 对话、活动图表 DOM、图谱镜头与阅读高度提示。
预读与 Mermaid 清理均使用版本隔离，旧任务可以按原身份交付当前视图，不能重新填充旧缓存。
关闭正文预读不 abort 与前台打开共用的请求；新开启后仍走原串行、350ms 合并及单篇 512 KiB 规则。

原“预加载图谱”移至系统页，显示为“图谱启动预加载”，仍用
`canvas:noteGraphPreload:v1`，默认关闭、下次主界面启动生效，受原功能与后台预加载总开关约束。
它独立于三种预设；系统分类恢复清除此项，图谱分类恢复只重置间距。

## 接入与数据

- `assets/note-system.js` 由共享工作区加载器先于笔记模块加载，归 notes 所有。
  `RelatumNoteSystem` 提供 read/update/reset/budget、motion 与 createPanel；
  `relatum:note-system` 携带前后偏好及一次性 clear 标志。无定时采样或常驻动画循环。
- `canvas:noteSystem:v1` 保存 animations、prefetch、cache、renderScale，首次读取及无效字段
  仅内存回退；显式修改才保存。恢复删除该键，已有桌面偏好桥自动纳入当前模式的快照。
- motion 将系统低动态与用户动画选择合并，设置、侧栏、菜单、AI、图谱共用；
  CSS 只覆盖笔记界面及所属浮层。切换时结清已有过渡，不重建正文编辑器。
- GraphEngine 新增可选 renderScale 和 setRenderScale(value)，默认 1，夹紧至 .5–1。
  WebGL、Canvas2D 及叠加层共用有效 DPR。其他图谱宿主不传此项，保持原行为。
- Mermaid Worker 的内部 cache 消息同步 items/bytes/clear；新 Worker 启动时下发当前预算。
  不改 Pele vendor、HTTP API、笔记文件、索引数据库或桌面启动参数。

禁用图谱或 Mermaid 后隐藏相应控件/预算说明，不为设置或清理加载其运行时。
此页不提供进程内存配额、线程数量、全局帧率或硬件加速开关，也不影响内嵌画布运行时。

## 验证入口

使用现有 RELATUM_PLAYWRIGHT / RELATUM_PYTHON / RELATUM_EDGE_PATH：

```powershell
node tests/note-system-browser.js
node tests/note-system-worker-regression.js
node tests/graph-instance-cache-regression.js
node tests/desktop-preferences-regression.js
node tests/note-graph-preferences-regression.js
```

浏览器专项使用临时库与合成正文，覆盖完整、仅笔记及最小外壳，中英文、深浅/窄窗、
设置即时应用、搜索展开、恢复与重载、低动态、迟到预读、缓存保护、活动图表/图谱和闲置 RAF。
图谱回归覆盖两种后端的分辨率切换、DPR、镜头、坐标与 CSS 命中。
Worker 回归确定性覆盖跨清理的迟到任务、缓存复用及档位缩减。
截图写入专用临时目录，不执行整机内存基准、桌面打包或真实用户库操作。

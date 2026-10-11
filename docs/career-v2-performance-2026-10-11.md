# 生涯 v2 验收与性能记录

日期：2026-10-11。基于 `1ed5182197817fa85d72df7f64a0c1769730f226`（最新笔记图谱预加载与启动器开关提交）验证当前工作区源码。纸墨、留白、字体层级、长篇阅读及顶栏交接沿用原视觉语言，图表参考 [Lieflat Charts](https://github.com/larashero3-dotcom/lieflat-charts) 的细线、灰阶和数据单位表达，使用本地 SVG、Canvas2D 与共享图谱引擎。

## 数据与实现范围

新账本为 `data/usage-v2.sqlite3`，新冻结报告为 `data/career-report-v2.json`。旧账本和旧快照全应用停用，保留原文件。已有内容参与生成时库存，新历史只来自 v2 采集和成功业务操作。详细语义见 [使用统计 v2 数据说明](usage-v2-data.md)。

生成在独立线程运行，重复请求复用运行中的任务；成功后原子替换，失败保留旧 v2。笔记、画布库登记、研究主文件和学习库存均通过只读入口统计。无法读取的来源单独标注，不恢复、不重写研究文件，不把读取错误当作零。目录拒绝访问不会使其他来源的库存丢失。普通打开、筛选与切换章节仅使用冻结数据。

报告包含六章。笔记关系沿用当前笔记本隔离解析器，展示最多 600 节点、2400 条真实边，完整规模独立保留。图谱使用实例缓存、悬停合帧、有限收敛及 WebGL 回退；普通滚轮继续阅读，Ctrl/Meta 滚轮缩放，方向键、加减键和 0 可操作镜头。密集图表缓存坐标和尺寸，指针命中及提示按帧合并；明细按页展开。

## 测量方法

- Windows，Intel Core i9-13900HX，24 核/32 线程；Node 22.21.0；Python 3.12.14；pywebview 6.2.1。
- 大数据性能使用 Edge 155.0.4283.45；桌面验收使用当前 `desktop.py` 和 WebView2 154.0.4258.62。没有改写已有发布包。
- 所有内容、账本与浏览器配置均放在一次性数据根。大数据组为 5000 篇笔记、500 张主画布、1 个共享内嵌文件、200 个研究页面、10 万条计时输入及 1200 条测试事件。输入数与合并后的数据库时段数分别理解。
- 每组连续三轮：1440×1000 视口，普通组 DPR 1；压力组 DPR 2、CDP CPU 四倍降速。滚动每轮采集 180 帧，覆盖整个报告、图表挂载及释放。交互每轮包括 90 帧真实命中后的拖动和 90 帧悬停，每帧注入三次指针移动。拖动从真实鼠标按下开始，并断言节点确实改变位置。
- P95 按显示帧时间间隔计算，不等同于 JS 单次执行时长或输入延迟。静置探针在动效/物理结束后观察 650ms 内新增 RAF；隐藏测试使用可控 `document.hidden` 注入触发实际生命周期处理，因为无头浏览器切后台页不稳定。
- 图谱实例、Canvas 与监听释放以测试注入探针检查，反复进出五轮后无残留绘制宿主；这些计数不代表精确显存或整进程内存。探针不进入生产脚本。

## 大数据组结果

本次 10 万条输入入库 10,685ms，首次冻结生成 3,174ms，报告 4,825,279 字节。三轮结果保留在 [采样汇总 JSON](career-v2-performance-2026-10-11.json)，其中已移除临时目录路径。

| 场景 | 第 1 轮 P95 / 最大值 | 第 2 轮 P95 / 最大值 | 第 3 轮 P95 / 最大值 | P95 目标 |
|---|---:|---:|---:|---:|
| 普通滚动 | 16.9 / 17.8ms | 16.9 / 83.4ms | 16.9 / 33.7ms | ≤20ms |
| 普通拖动与悬停 | 16.9 / 17.5ms | 16.9 / 17.2ms | 17.0 / 17.4ms | ≤20ms |
| DPR 2 / CPU 四倍滚动 | 33.4 / 66.7ms | 33.3 / 83.3ms | 33.3 / 66.5ms | ≤35ms |
| DPR 2 / CPU 四倍拖动与悬停 | 17.0 / 33.4ms | 17.1 / 17.7ms | 16.9 / 17.1ms | ≤35ms |

四组 P95 均达标。个别滚动帧存在峰值，表中如实保留；结果仅对应本机、该数据形状与上述采样方法。报告静置和图谱收敛后的新增 RAF 均为 0。

## 桌面、边界与回归

隔离 WebView2 完成默认 WebGL 和强制 Canvas2D 两条路径，使用 90 篇笔记、12 张主画布、5 个研究页面、1000 条计时输入。普通滚动 P95 16.9–17.0ms，压力滚动 16.8–16.9ms；交互 16.9–17.1ms。最终 Canvas2D 功能复验包含键盘操作、目录错误处理后的生成、最小化释放与重新生成；`--checks-only` 不采性能，因此在 JSON 中与性能轮次分开记录。这里未宣称大数据 Canvas2D 的帧率。

真实 WebView2 验收发现最小化后 `document.hasFocus()` 可能仍为真。桌面壳现在发送原生最小化/还原通知，采集器暂停，生涯立即释放图谱与 Canvas；最小化期间无新增时段，返回恢复挂载。延迟初始化返回也不会重新启动已关闭采集器。

验证结果：

- Python 全量 `unittest discover`：417 项，通过，1 项因环境无法创建符号链接而跳过。覆盖跨午夜、重叠并集、幂等及回滚、迟到开关、项目改名/移动/删除与恢复、无变化保存、失败生成保留、WAL 读写并行、旧文件读取陷阱和只读库存。
- 采集器 VM 回归：快速切换、iframe 单一所有者、焦点、休眠、原生最小化、开关、失败重试、关闭恢复及迟到初始化；报告数据回归覆盖全部时间筛选、自然年选择、毫秒精度、未采集/部分采集/零记录和调度器重入。
- 浏览器验收：六章、全部筛选、空历史库存、长名称、深浅主题、中英文、430px 窄窗、实际研究 iframe 时间、普通/Ctrl 滚轮、拖动/悬停/键盘、反复进出、隐藏和生成期间切换筛选/主题。新增内容在手动生成前不进入库存；冻结筛选不发起扫描请求。生成前后内容字节哈希一致，报告没有正文或绝对路径。
- 功能裁剪浏览器：完整、仅笔记、仅研究、仅生涯、笔记+生涯、库、复习、日历、活跃、速记、树状、学习、专注及仅编辑器共 14 组通过。
- 资源生命周期浏览器完整及 `--on-demand` 两组通过：未打开图谱零 GPU 分配、关闭后零缓冲残留、星图离页释放、雨声暂停和缓存淘汰，以及运行时加载失败后的重试。桌面窗口契约也通过。
- 最新图谱整合：`graph-engine.js` 仅增加默认不启用的滚轮判断回调；笔记宿主仅补计时目标通知和查询，不改预加载、布局、镜头或标签缓存。共享实例缓存/布局/偏好回归、笔记图谱完整/仅笔记/禁用内嵌画布、WebGL/着色器回退，以及预加载开关、失败重试和 pagehide 回归均通过，未发现与最新提交的冲突。

## 复现入口

配置现有测试宿主变量 `RELATUM_PYTHON`、`RELATUM_PLAYWRIGHT`、`RELATUM_EDGE_PATH`；桌面验收另设 `RELATUM_WEBVIEW_PYTHON` 指向安装 pywebview 的 Python。无需在项目引入 npm 或额外运行依赖。

```text
python -B -m unittest discover -s tests -p "test_*.py"
node tests/usage-tracker-regression.js
node tests/career-report-contract.js
node tests/graph-layout-regression.js
node tests/graph-instance-cache-regression.js
node tests/note-graph-preferences-regression.js
node tests/career-v2-browser.js --large
node tests/career-v2-browser.js --webview2
node tests/career-v2-browser.js --webview2 --fallback
node tests/career-v2-browser.js --webview2 --fallback --checks-only
node tests/feature-profile-browser.js
node tests/note-graph-browser.js
node tests/note-graph-preload-browser.js --regression-only
node tests/resource-lifecycle-browser.js
node tests/resource-lifecycle-browser.js --on-demand
```

浏览器工具自动建立独立数据根。全量 Python 测试也应先把 `RELATUM_DATA_ROOT` 指向新建临时目录。真实内容不用于压力测试；既有发布 EXE 没有替换，当前源码已通过隔离桌面运行验收。

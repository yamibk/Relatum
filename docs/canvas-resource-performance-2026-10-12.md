# 画布资源与连线索引复核 · 2026-10-12

本轮核对近期画布、笔记与共享图谱优化后，只落实两项有明确收益的改动。基线为 `2e93544`，没有新增应用依赖、API、数据格式或偏好，也没有修改用户数据及发布包。

## 改动与边界

- `assets/canvas.js`：512 单位网格不再为超长连线的整个矩形包围盒登记空单元。单条连线最多登记 256 格，超过时只保存一个候选身份；大范围查询超过当前网格预算时直接筛选已有几何。网格预算最多 4096 格，小规模空网格允许最多 16 格查询。两条查询路径均按原始叠放顺序返回，沿用真实曲线边界、Path2D、箭头与 SVG 命中回退。几何更新、删除和整体替换清理对应身份，正常相机移动仍复用路径缓存。
- `assets/graph-engine.js`：已有宿主激活和视口可见条件之外，再检查页面隐藏、桌面壳已有的 `desktopMinimized` 通知及 pagehide/pageshow。暂停连续帧、单次帧与分片预布局，清除悬停和临时手势；重复通知不重复排帧，还原继续同一引擎、镜头与布局，并补偿生长时钟的暂停时间。未激活的宿主不被还原事件唤醒，destroy 解绑新增监听。

最小化期间图谱保留当前引擎和 GPU 资源，收益来自停止后台计算与绘制；关闭、离页仍由原宿主销毁资源。本轮没有改专注钟的计时或声音行为，也没有为普通大画布引入 DOM 回收或新绘制后端。大量节点文字、样式和栅格化仍有成本。

## 真实浏览器对照

Edge `155.0.4283.45`，1440×900。每轮在新的浏览器上下文交替装载基线与当前源码；服务器、文件、配置与保存全部使用一次性数据根。长连线夹具包含 32 个普通文字节点和 16 条斜向直线，终点距起点约 6.5 万画布单位。JS 堆在页面稳定后通过 CDP 请求 GC，再读取 `performance.memory.usedJSHeapSize`。下表 MB 为 10^6 字节，不是整个桌面进程的 RAM。

| 配置 | 基线 JS 堆 | 当前 JS 堆 |
| --- | ---: | ---: |
| DPR 1，正常动画 | 14.650 MB | 6.397 MB |
| DPR 2，深色、低动态 | 14.702 MB | 6.391 MB |
| DPR 1，图谱 Canvas2D 回退 | 14.662 MB | 6.399 MB |

三组的连线索引均从 17,418 个网格桶、267,033 条成员引用，变为 0 个网格桶及 16 个超限候选。16 条几何路径继续缓存；实际移到远处中段，双击仍命中最上层 `e15`。这项内存收益主要适用于长距离或大弯曲线，不能推算为普通画布一律节省相同比例。

同一组真实页面打开编辑器图谱和活跃星图，保持 `document.hidden === false`，发送桌面壳使用的最小化通知，观察 900ms；期间还发出一次升温与重绘请求，验证隐藏状态不能被异步更新唤醒。正常、低动态及 Canvas2D 六组宿主的基线新增绘制为 174–220 次，当前均为 0 次。还原后六组均继续绘制且引擎创建数保持 1，原关闭/离页销毁断言通过。绘制计数由测试包装真实标签同步或 Canvas2D 清屏取得，不代表某种物理显示器帧率。

打开时间受缓存、主题与调度影响：本轮旧/新各有快慢，未据此宣称首屏加速。桌面可见验证模拟已有桥接事件，没有重新打包或用真实 EXE 最小化；实际窗口通知的发送端沿用既有桌面实现。

## 算法压力对照

`canvas-spatial-index-regression.js --benchmark` 在 Node VM 中执行源码里的真实索引/查询函数，使用 16 个跨度 65,536 单位的矩形边界及 30 次大范围查询，旧、新各五批。

| 指标 | 基线 | 当前 |
| --- | ---: | ---: |
| 登记成员引用 | 266,256 | 0；16 个候选 |
| 30 次查询的网格读取 | 1,398,384 | 0 |
| 索引耗时中位数 | 53.3 ms | 0.044 ms |
| 30 次查询耗时中位数 | 266.2 ms | 0.177 ms |

这是算法压力夹具，不含节点 DOM、Canvas 绘制或 GPU 时间；查询范围也大于普通窗口在最小缩放下的可见区。收益判断以有界内存、实际浏览器堆与零后台绘制为主，不把这些耗时当成整体交互提速倍数。

## 验证与复现

- 索引回归：1,800 条随机边界、900 种局部/大范围查询与逐条筛选结果及顺序全等；覆盖负坐标、边界重叠、极长边、远处空查询、无穷/反向边界、网格与超限集合互相迁移及删除。
- 共享引擎回归：原生最小化、页面隐藏、pagehide/pageshow、重复通知、迟到帧与预布局切片、隐藏启动、未激活宿主、8 秒暂停后的生长接续、指针捕获取消及 destroy 后零监听。原实例缓存、预布局、布局参数与树/每日任务回归继续通过。
- 真实画布回归：几何/SVG 命中、命名、弯曲中点、多个节点类型的撤销重做及对象身份、PNG/完整 SVG 导出、图片/Markdown/PDF 按需释放、导图/折叠、任务簿、双屏尺寸与参考选择、翻页与快速反向切换。
- 共享宿主回归：`note-graph-browser.js` 的完整、仅笔记、禁用内嵌画布、Canvas2D 与着色器失败五类配置通过；`note-visibility-browser.js` 的完整、禁用内嵌画布、禁用图谱与 Canvas2D 四类配置通过，包含最小化/还原、迟到响应、未完成布局和草稿保存。`resource-lifecycle-browser.js --on-demand` 的 GPU、音频释放及加载失败重试通过。首次打开契约补齐断言中遗漏的既有 `graph-window.js` 加载步骤后通过。

浏览器依赖只使用测试宿主已有路径；所有读写均为临时数据根。复现对照时显式指定基线，避免提交后将当前 HEAD 当成旧版本：

```powershell
$env:RELATUM_CANVAS_BASELINE_REF = '2e93544'
node tests/canvas-spatial-index-regression.js --benchmark
node tests/graph-visibility-regression.js
# 配置已有 RELATUM_PYTHON / RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH：
node tests/canvas-resource-performance-browser.js --compare --regression
node tests/graph-presolve-regression.js
node tests/graph-instance-cache-regression.js
node tests/graph-layout-regression.js
node tests/canvas-performance-contract.js
node tests/canvas-workspace-layout-regression.js
node tests/canvas-changes-regression.js
node tests/editor-opening-performance-contract.js
node tests/note-graph-browser.js
node tests/note-visibility-browser.js
node tests/resource-lifecycle-browser.js --on-demand
```

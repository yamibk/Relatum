# 笔记内嵌画布卡死修复与复核

基线：`fb28c4d`。仅修改 `assets/note-canvas/engine.js` 的自动撑高搜索，新增隔离验收并同步接手文档。没有修改笔记、画布文件、偏好、API 或存储格式。

## 已确认的卡死

`1148c34`（2026-10-09 23:24:16）的样式升级引入了自动撑高二分搜索。原下界直接使用节点高度，而中点用 `Math.ceil`：

```js
let low=h, high=Math.max(h,6000);
while(high-low>1) {
  const mid=Math.ceil((low+high)/2);
  if(fits(mid,equal?mid:w)) high=mid;
  else low=mid;
}
```

默认圆角矩形的新建尺寸设为 95% 时，高度变成 `45.599999999999994`。空白节点也需要撑高，搜索收敛到 `high=47` 后，中点仍为 47；差值大于 1，循环永远不退出。它同步运行在页面主线程，会卡住界面并持续计算。已有节点的小数高度遇到同样边界也有风险，入口包括读取、编辑、自动撑高和形状/文字设置。

新增浏览器回归在修改生产代码之前复现了该问题。测试专用步数探针超过 32 次测量即报错，取得两条明确诊断：

```text
Auto-height did not converge: {"height":45.599999999999994,"width":152,"size":47,"shape":"rounded-rect"}
```

修复将下界取整向下、上界取整向上，并使用整数中点向下取整；每次循环都缩小区间。只调整测量搜索，不对用户文件中的尺寸做迁移或取整。正常范围内含初始和最终测量实测最多 14 次。

## 验证

`tests/note-canvas-stability-browser.js` 自建临时笔记库，分别验证仅笔记、完整页面和 SVG 命中回退：

- 新建尺寸 50%–300%、步长 5%，全部 51 档，包含原先卡死的 95%。
- 12 种形状的长文字撑高；小数高度 24.2/43.2/45.6/46.01/47.99/48.4/5999.2。
- 极窄三角形、大内边距和 2000 字符，达到高度上限后仍正常结束并可滚动。
- 取消创建保留空文件与零历史；95% 节点提交一条历史，保存后读取临时磁盘确认正文。
- 有节点的画布静置 400ms：新增静态绘制 0 次、节点布局 0 次、没有待执行动画帧。
- 移除测量探针、重载生产引擎后，在已保存画布中再次真实双击、输入并保存第二个节点。

Edge `154.0.4258.62` 的三种浏览器配置通过。当前 `D:\Relatum-release\Relatum.exe` 的真实 WebView2 也在三种配置通过，末尾检查加载的是未插入探针的打包脚本。发布目录原画布脚本与修复前源码一致，已通过同一最小补丁同步修复；前端资源位于 `_internal/assets/`，无需重编译 Python EXE。原用户数据未打开或修改，重启原客户端加载新脚本。

其他通过的回归：

- `node tests/note-canvas-browser.js`：双击、输入、正文投影身份、历史/共享/移动/冲突、禁用与预热、屏外释放；1500 节点/1499 连线拖动零尺寸测量、零索引重建，静态层开始/结束两次绘制。
- `python -B -m unittest tests.test_note_canvases tests.test_note_notebooks`：25 项通过。
- `node tests/note-live-editor-regression.js`、`node tests/markdown-fuzz-regression.js`：通过，后者用独立子进程和超时防止解析死循环。
- `node tests/note-table-browser.js`：通过。
- `node tests/note-image-text-browser.js`、`node tests/note-image-text-workspace-browser.js`：通过。

复查了内嵌画布的相机/惯性帧循环、ResizeObserver、主题观察器、空间网格、共享保存串行链与屏外释放，以及相关笔记富块扫描/词数分片循环。本轮未确认第二处持续空跑或卡死；以上结果不代表全应用所有场景都不存在性能问题，也不是整体帧率或 CPU/RAM 基准。

## 剩余限制

`node tests/note-canvas-style-browser.js` 未完整通过：在默认调色浮层的“再次点击色块应关闭”断言失败（实际仍为 1 个浮层）。失败发生在引擎尚未加载时，与本次撑高补丁无关。未将这项测试算作通过，也未修改其断言或调色器。该现象没有提供持续空跑或卡死证据。

本轮未执行真实微软拼音候选窗验收；没有改动输入法交接。所有测试服务和测试 EXE 在退出时关闭，仅留下临时截图供诊断。

## 复查命令

配置宿主已有的 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON`、`RELATUM_EDGE_PATH` 后：

```powershell
node tests/note-canvas-stability-browser.js
node tests/note-canvas-stability-browser.js D:\Relatum-release
node tests/note-canvas-browser.js
```

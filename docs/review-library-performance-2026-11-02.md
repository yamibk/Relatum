# 复习页局部性能优化（2026-11-02）

## 行为与边界

本次调整复习页前端及共享窗口列表的暂停测量。保留现有布局、评分、自由复习规则、快捷键、接口和 SQLite 数据格式；没有新增依赖或持久化字段。

- 卡片库小列表按 ID 更新存活行；超过 200 张时启用共享列表已有的 `reuseRows`，使用稳定渲染器。相同筛选结果不拆建行，内容变化只替换文字区域，保留复选框、编辑按钮与焦点。200 张阈值往返可复用仍挂载的条目；新出现的可见行才播放原有限入场。
- 自由复习按卡片库数组身份及复习范围，缓存有效卡片数组和 ID Map。统计复用同一集合；洗牌队列改用游标，普通换卡不扫描全库、重建索引或移动整段数组。强制重载/范围/会话重置清理，迟到评分造成的新数组也在下次使用时失效；每轮无重复及相邻轮次不连续重复的原规则保留。
- 卡片库切走、离开画布工作区、文档隐藏、原生最小化及 pagehide 暂停窗口列表，取消待执行筛选并登记刷新需要。隐藏响应只更新模型；返回时合并刷新并保留搜索、筛选、选择和滚动位置。pageshow 接续原列表。共享 `suspend()` 同时断开 ResizeObserver，回调拒绝暂停/销毁后的测量；`resume()` 重新观察存活行，校准隐藏期间的尺寸变化，原锚点、焦点和旧 WebView2 回退保留。
- 同次回归发现，原卡池空闲预加载任务可以在首次加载完成后再发一条 GET，旧 Git 资产同样可复现。预加载在调度与实际回调两处检查 `loaded/loading`，继续沿用原预读协议和权限。

## 对照口径

基线 `d4fc986`，测试从 Git 读取旧 `review.js/windowed-list.js`，不切换工作目录。使用同一个临时服务、独立浏览器上下文和合成卡片，不访问真实卡片、画布、笔记及本机偏好。Windows headless Edge 156.0.4314.58、Node v22.21.0，1360×900 CSS 像素、Asia/Shanghai。20/200/1000/10000 张各三轮，按轮交替旧/新顺序，另记录 Chromium 4 倍 CPU 降速样本；基准不与其他压力测试并行。

“筛选渲染”是 `Ca → Car → Card → Card ` 四次同结果搜索的同步模型筛选及 DOM 更新，排除原有 80ms 输入合并等待。“自由换卡”在预热后连续取 12 次同步调用，包含当前卡片与统计更新，排除网络、用户核对等待与显示器呈现。数值为三轮样本中位数。测试入口与计数器只注入被拦截的测试脚本，产品无调试接口。

| 卡片数 | 筛选渲染旧→新 / ms | 自由换卡旧→新 / ms | 四次搜索拆建条目旧→新 |
| ---: | ---: | ---: | ---: |
| 20 | 0.3 → 0.1 | 0.2 → 0.2 | 80 → 0 |
| 200 | 2.4 → 0.5 | 0.2 → 0.2 | 800 → 0 |
| 1000 | 0.9 → 0.7 | 0.3 → 0.2 | 28 → 0 |
| 10000 | 3.5 → 3.1 | 1.0 → 0.2 | 28 → 0 |

4 倍降速下，200 张筛选渲染为 12.5→1.7ms，万张自由换卡为 5.3→1.1ms。万张搜索仍由全模型筛选主导，降速样本为 11.3→11.5ms，属于基本持平；小卡库的换卡耗时也接近测量噪声，不据此声称普遍帧率提升。

连续 12 次自由换卡的全库筛选次数从 24 次降为 0 次；随机队列耗尽时仍需要按原规则洗牌。千/万卡列表隐藏后发送 20 次 resize，原实现有 4 次几何读取并新建 4 行，新实现两者均为 0。此项检查只针对复习列表，不代表整个宿主没有其他工作。

## 验证与复现

设置已有的 `RELATUM_PLAYWRIGHT`、`RELATUM_PYTHON`、`RELATUM_EDGE_PATH` 后运行：

```powershell
node tests/review-library-performance-browser.js
```

`--quick` 只跑一轮，环境变量 `RELATUM_REVIEW_LIBRARY_BASELINE` 可指定其他 Git 基线。JSON 原始报告、失败截图及合成数据写入脚本输出的系统临时目录，结束关闭测试服务和浏览器。

最终三轮完整报告为 `%TEMP%/relatum-review-library-HTBAk0/report.json`。上述表格来自此报告；复习专项导入数据和截图为 `%TEMP%/relatum-review-import-browser-2BYRPO/`。

已验证新增三轮对照，以及同结果零拆建、旧 WebView2 焦点回退、未挂载行的批量选择、200 张阈值往返、真实编辑弹窗更新、深层滚动/改宽恢复、隐藏迟到响应、待筛选最小化、显隐/pagehide/pageshow、整轮随机与数据/状态/范围失效。独立共享列表夹具覆盖焦点输入框、选区、暂停中 setItems、恢复行高及销毁后 resume。

原评分性能、复习偏好和调度回归通过。偏好/调度测试重新加载时显式恢复 `?view=review`，因为当前导航消费该查询后会回到默认首页；这是测试入口校正，不改变产品的导航记忆。导入测试继续运行前为合成 pagehide 配对 pageshow。导入功能与复习便签使用 `node tests/review-import-browser.js --review-only` 验证：保留解析/映射/编码/XLSX/幂等重试/分组/千和万行预览/生命周期/主题与尺寸的全部检查，只限制附带的跨页便签删除检查为复习页。默认脚本仍有过期的画布日历入口，星图全画布也不再提供原脚本所找的空白命中面；这些其他页面的便签用例不计入本次通过结果。

`node tests/review-import-model.js` 通过；使用一次性 `RELATUM_DATA_ROOT` 运行 `python -B -m unittest tests.test_review_scheduling tests.test_review_import tests.test_review_performance`，25 项通过。

笔记文件树性能/生命周期与笔记视图状态（含双链延迟请求、隐藏取消及返回）回归通过。额外执行 `note-ui-browser.js` 时，在第 169 行的日期筛选弹窗“低动态下关闭后立即 hidden”断言失败；换回 Git 原版共享列表也在同一处失败，属于原有、与本次列表改动无关的 UI 时序问题，未改动笔记日期弹窗。

对应浏览器回归命令：

```powershell
node tests/review-performance-browser.js
node tests/review-preferences-browser.js
node tests/review-scheduling-browser.js
node tests/review-import-browser.js --review-only
node tests/note-tree-performance-browser.js
node tests/note-view-state-browser.js
```

没有重新打包 EXE；上述 Chromium 测量不等同真实显示器帧率或发布版 WebView2 原生验收。

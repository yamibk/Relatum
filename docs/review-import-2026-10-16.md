# 复习卡片批量导入与便签 Delete

## 用户行为

卡片库搜索框旁的“批量导入”提供三步对话框：放入数据、设置与预览、确认导入。复制 Excel/WPS/LibreOffice 等表格选区即可粘贴；也可选择或拖入单个 XLSX、CSV、TSV 文件。每行生成一张现有基础卡片，问题必填、答案可空，初始 active/level 0/今天到期，不覆盖既有卡片及复习进度。

自动识别中英文表头；无明确表头时用前两列对应问题和答案。表头所在行与数据起始行可改，问题、答案、说明可选多列、排序，使用换行或空格分隔并可显示列名。空内容不参与拼接；答案/说明的列间换行使用 Markdown 硬换行，单元格内部原文不改写。非空卡组列优先于统一卡组，标签列与公共标签合并；组织关系只在正式提交时创建。

预览每页最多 50 行，点击源行号查看一张最终卡片。确认页统计新增、重复、错误、空行，错误显示源行号和原因；存在错误时提交按钮明确写“仅导入有效的 N 张”。CSV/TSV 源行号按原文本物理行定位（包含单元格内部换行），XLSX 沿用工作表行号。表头和起始行也使用该源行号。

默认跳过同卡组中问题、答案、说明、标签都相同的卡片，同时检查本次表内重复。正文区分大小写，卡组/标签沿原规则归一化，标签不比较顺序；状态、进度和到期日不参与相等判断。可选择允许重复。成功保留搜索和筛选，被隐藏的新卡片可通过“清除筛选并查看”显示。

边界：每次最多 10000 行、256 列、20MiB 原始文件/UTF-8 粘贴内容、32MiB 请求 JSON。超限报错，不静默截断。单卡沿用问题 12000、答案 50000、说明 100000 字符、卡组 80、标签 32 字符及最多 12 标签的限制。首版不导入进度、旧 XLS、Word 文件或外部媒体，不计算公式。

## 实现与数据

- `assets/review.js` 按需加载导入界面、模型及专属 CSS，并交接卡组、正文渲染器与刷新。启动与普通复习不加载导入器。
- `assets/review-import.js` 管对话框、预检/提交身份、焦点、50 行分页和生命周期。全文列组合放在 Worker；主线程只组合当前页，避免万行预览反复阻塞输入。
- `assets/review-import-model.js` 是无 DOM 的分隔文本、编码、表头和多列组合模型。单元格引号、双引号转义、CRLF/内部换行、空列与前导零保真；自动分隔符候选是 Tab、逗号、分号，也可手选。编码自动按 BOM、严格 UTF-8、GB18030 回退，可手选 UTF-8/GB18030/UTF-16LE/UTF-16BE。
- `assets/review-import-worker.js` 接收解析或组合任务；只在读取 XLSX 时加载本地 `vendor/sheetjs/xlsx.full.min.js`（0.20.3，原版，许可证与 SHA-256 见第三方声明）。默认首个可见工作表，用户可切换；忽略纯格式空单元格，读取格式化显示值（如 `00007`）、日期及已保存公式结果。参与映射的公式无缓存或单元格错误传至后端校验，忽略的错误列不阻止导入。
- 关闭、离页、pagehide 终止解析并释放输入；隐藏或 `desktopMinimized` 停止新的解析/预检。提交阶段锁定重复操作，不通过关闭对话框撤销已经开始的事务。结果丢失后重试使用同一批次和冻结内容。

`app.py` 新增两个本地 JSON 接口，沿 `canvas.review` 的写入授权，在功能禁用时先拒绝。数据库通过 SQLite 协调，不持有用户文件的跨进程/通用写锁。

`POST /api/review-import-preview` 接收 `{rows, duplicateMode}`。每行包含 `sourceRow, prompt, answer, notes, deckName, tags`，原始空行有 `blank:true`，已用公式/错误单元格有 `sourceError`。`duplicateMode` 为 `skip` 或 `keep`。返回 `counts:{new,duplicate,invalid,blank,total}` 和逐行 `{sourceRow,status,error?}`；不会创建卡片、卡组或标签。

`POST /api/review-import` 接收相同行数据，另加 `batchId`（16–80 字符的 ASCII 字母/数字/下划线/连字符）及布尔 `skipInvalid`。服务端重新校验，`BEGIN IMMEDIATE` 下重新去重，缓存卡组/标签身份并批量插入；内容、组织关系与收据同次提交，异常整体回滚。返回 `{ok,created,duplicates,invalid,blank,total}`。重试返回原结果并带 `idempotent:true`；同批次不同内容返回 `409/batch-conflict`。

SQLite `data/review.db` 升至 schema v4，只新增 `review_imports(id,payload_hash,result_json,created_at)`；不迁移或重写卡片、组织、设置及历史。收据保存请求摘要与计数，不另存原表格。预检结果不是写入授权，正式提交始终重新校验。

## 便签键盘行为

`assets/start-sticky-notes.js` 为共用跨页便签同时处理 Delete / Backspace。只有当前选中且非编辑态触发；`isComposing` 或键码 229 直接放行。输入文字时两键仍执行原生文字删除，删除后的动画与原子保存不变。

## 验证入口

- `python -B -m unittest discover -s tests -p test_review_import.py -v`：隔离 SQLite，覆盖预检、相等判定、空/错行、显式确认、重试冲突、事务中途故障、并发、v3 升级及 10000 行单事务。
- `node tests/review-import-model.js`：文本/引号/内部换行、编码、表头、多列、前导零、XLSX 隐藏工作表、公式缓存与忽略列、万行模型。
- `node tests/review-import-browser.js`：一次性服务和浏览器配置，覆盖真实对话框及 API、分页、失败重试、筛选、千/万行、生命周期、中英文深浅窄窗低动态、三个页面便签删除。截图和测试数据只放系统临时目录。
- 继续运行 `test_review_performance.py`、`test_feature_profile.py`、`tests/sticky-palette-contract.js`；按需运行 `tests/canvas-workspace-performance.js` 的原卡片库窗口化验收。

浏览器验收使用测试环境已有 Playwright，按需设置 `RELATUM_PLAYWRIGHT` / `NODE_PATH`、`RELATUM_PYTHON` 与 `RELATUM_EDGE_PATH`，不添加项目依赖。

## 本轮验证结果与边界

2026-10-16，已通过 12 项复习后端/HTTP 测试、解析与 XLSX/编码模型回归、便签前端色库契约，以及真实 Edge 的完整导入浏览器脚本。千行和万行预览均只挂载 50 条表格行，千行真实提交后卡片库继续窗口化；万行数据库写入独立验证单次事务。浏览器覆盖多列顺序/列名、卡组标签、GB18030 错误编码后重试、响应丢失后的幂等重试、最小化/还原、pagehide、深浅主题、窄窗与低动态，并逐页验证复习/日历/足迹便签删除及重载持久化。大词表通过测试夹具向真实文本框注入内容后触发同一 input/Worker/API 流程，小词表使用浏览器原生编辑。

功能清单的 16 项 Python 测试及 `feature-profile-browser.js` 的 14 种完整/精简配置全部通过。另一次隔离运行通过桌面实例、壁纸、运行目录、复习和便签色库合计 42 项 Python 测试。修改的 JS 语法检查、第三方脚本 SHA-256 与 `git diff --check` 均通过。

原生启动器 `test_launcher_native.py` 未全部完成：本次使用的标准库测试 Python 未安装 `pywebview` 与 `clr/pythonnet`，原生窗体用例报缺少模块，直接启动用例进入“桌面窗口组件未安装”的真实消息框并等待。已结束该测试进程，没有为此安装依赖或修改启动器/桌面实现；需在项目的桌面依赖环境补验。没有重新打包 EXE，也没有把合成候选事件当作真实微软拼音候选窗验收。全部浏览器服务、浏览器配置、数据库与表格夹具均使用一次性临时目录，测试服务已关闭。

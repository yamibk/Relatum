# 笔记索引与全文搜索

Markdown 和附件是原始数据。`data/note-index.sqlite3` 是可删除、可重建的本机缓存，与复习、生涯数据库独立；不迁移旧索引，不改写 Markdown、附件或已有偏好。

## 模块与数据

| 模块 | 职责 |
| --- | --- |
| `notes_library.py` | 路径授权、原子文件操作、素材与移动回滚，以及 HTTP 调用的薄入口 |
| `notes_index.py` | SQLite 存储、读取快照、参数化查询、版本、关系解析和空间回收 |
| `notes_sync.py` | 目录登记、持久化待处理任务、后台正文批次、Windows 通知和补偿核对 |
| `note_search.py` | 连续匹配的查询语法、可见文本投影、短字符倒排及 UTF-16 高亮/定位 |

数据库使用 WAL、独立读连接和串行写入。`books` 保存内部 UUID、实际目录身份、目录路径、版本和统计；`entries` 保存目录/文件状态、内容修订及派生文本；`tags/tag_counts` 保存标签关联与隐式父级数量；`refs` 保存双链、画布目标及解析状态；两张 FTS5 表分别保存 trigram 和去重的编码字符/二字符项。`changes` 是有界增量日志，不保存编辑历史。紧凑的覆盖索引用于筛选、计数和相关性排序，确定本页 ID 后才读取摘要及位置映射。

目录名称始终自然排序，笔记支持名称/修改时间/创建时间的正反六种排序。同值按路径稳定排序。目录版本与正文索引版本分开，正文后台解析不会反复作废目录分页。

## 同步与资源生命周期

首次先登记文件状态，再分批读取正文。任务队列最多 8192 个路径，尚未完成的工作保存在 SQLite 的 `needs_sync` 标记中，队列溢出和退出不会漏掉文件。保存后的 UTF-8 内容直接进入优先队列，正文缓冲总预算 8 MiB；保存后留出 250ms 安静期，后台任务在阶段之间让出执行。查询范围可提升对应笔记本/目录的优先级，不能不断替换正在处理的任务。

生产后台在 `notes.graph` 可用时，同次正文读取生成图谱引用，保留图谱、传统双链和内嵌画布各自的语法边界；图谱界面的脚本、标签、Worker、GPU 仍按原生命周期加载和释放。图谱拓扑签名只由节点与关系决定，普通正文修改不重置布局或镜头。生涯报告复用同一索引读取的元数据，不另做全库正文遍历；读取失败保留可用库存并标记统计不完整。

Windows 用 `ReadDirectoryChangesW`，覆盖原子替换、同大小/同修改时间事件和目录操作；普通目录事件核对受影响子树，重命名/溢出使用补偿扫描。失败、启动和重新进入后也补偿；不支持通知时每 30 秒检查状态，正常时为 120 秒。主动刷新可明确补偿核对。扫描或权限错误不会据此删除旧数据。活动心跳每 15 秒、租期 45 秒；隐藏、离场、原生最小化停止解析、重建及维护，保留任务。正常退出将尚未消费的路径写入持久化待处理标记，再释放线程、连接和句柄。

笔记本由路径及实际目录身份共同识别。应用内回收成功后立即将旧 UUID 标记删除，所有查询排除该本，再以每批 128 行清理派生数据。外部删除须由成功核对确认；相同路径的目录重建分配新 UUID，旧任务、旧清理只能操作旧身份。存活笔记的原始引用不改写，解析状态变为缺失，恢复目标后重新解析。数据库启用增量回收，空闲批次合并有限 FTS 页面、回收至多 64 个空闲页并做被动 WAL 检查点。没有在删除交互中整库 VACUUM；生涯历史保留。

## 接口

所有入口归 `notes`；图谱另检查 `notes.graph`，画布浏览另检查 `notes.canvas`。功能禁用在扫描前返回 `403/feature-disabled`。这些查询不持有 Markdown 文件写锁或跨进程全局写锁。

| 入口 | 数据 |
| --- | --- |
| `GET /api/note-index-state` | `phase,total,indexed,pendingDocuments,pending,errors,incomplete,catalogComplete,generation,notebooks` |
| `POST /api/note-index-activity` | `{visible:true/false}`，更新活动租期 |
| `GET /api/notes-tree?view=JSON` | 根、所需目录页和打开文档的祖先；`view={expanded,pins,sort}`；可带 `notebookSettings=1`、`visible=0/1` |
| `GET /api/notes-tree?reconcile=1` | 明确请求的目录补偿核对；日常轮询不使用它 |
| `GET /api/note-children?parent=&offset=0&limit=50&sort=name-asc&generation=…` | 同一读取事务中的条目、总数、目录版本及后续页标记；`folders=1` 供显式全部展开递归读取目录，不加载全部正文条目 |
| `GET /api/note-changes?since=…` | `changes,cursor,generation,hasMore,reset,index`；超过日志预算要求重新取分页快照 |
| `POST /api/note-query` | 最近、标签、全文和有序路径元数据查询；每页上限 50 |

查询示例：

```json
{
  "mode": "search",
  "q": "学习 \"Alpha beta\"",
  "scope": {"kind": "all"},
  "tags": ["学/统计"],
  "modified": {"after": 1788192000000000000},
  "sort": "relevance",
  "limit": 50,
  "cursor": null
}
```

范围为 `all`、`notebook` 或 `folder`；后两者带库内 `path`。默认本的路径是空字符串并排除 `CustomNotebook`。`recent` 模式带本机访问记录 `recent={path:毫秒}`，最多 200 条，与文件修改时间合并排序；`tags` 模式带标签；`paths` 模式供既有组件批量取得有序元数据。修改时间筛选使用纳秒，前闭后开。

响应为 `items,total,hasMore,cursor,generation,index`。条目有路径、文件名标题、修订、修改时间、标签和摘要；全文结果另有 `highlights` 与 `sourceRange`，均为 UTF-16 偏移。标题匹配优先于路径，路径优先于正文，同分按修改时间、路径排序。游标绑定查询与索引版本；版本改变返回 `409/query_changed`，界面重新取结果。目录版本改变也返回同类错误，不拼接不同版本的页。

定位发现文档修订变化时，只针对该路径发送 `expectedRevision` 重新核验并定位原查询。普通查询不读取 Markdown；只有这类明确的修订复核读取受影响文档。图谱元数据及其版本也在同一 SQLite 读取快照内取得。

## 查询语义与界面

连续字符准确匹配；空格分隔的关键词要求全部命中；双引号保留连续短语，引号内用反斜杠转义。输入不作为 SQL 或 FTS 操作符执行。文本按 NFC/casefold 规范化，保留原显示大小写及到原 Markdown 的位置映射。三字以上用 trigram，一/二字用去重字符项；覆盖中文、混合英文、emoji、代码和经过既有验证器确认的图片可见文字。前言、隐藏注释、图片/画布的内部编码和链接属性不作为可见正文。

左侧浏览提供搜索，`Ctrl/Cmd+Shift+F` 打开。150ms 合并输入，Enter 立即提交，候选确认后才查询，新查询中止旧请求。范围和收起的筛选区延续原布局与主题。打开结果沿用保存、候选和画布交接，保留编辑/阅读模式并展开命中所在折叠内容；迟到响应核对文档、操作及可见会话。返回保留关键词、筛选、已加载页、选中项和滚动。目录/结果超过 200 项使用既有可变高度窗口列表，真实输入与焦点行保持挂载；重命名期间延后目录重排。

## 验证与构建

```powershell
python -m unittest tests.test_note_index tests.test_notes_library tests.test_note_browser tests.test_note_graph tests.test_note_notebooks tests.test_note_canvas_browser tests.test_note_canvases tests.test_note_trash tests.test_career_report tests.test_feature_profile
node tests/note-search-browser.js
node tests/note-graph-preload-browser.js --regression-only
python tests/note-index-performance.py --counts 2000 10000 50000 --layouts mixed flat --output report.json
```

完整检查入口为 `tests/run-note-checks.ps1`，浏览器使用宿主的 `RELATUM_PYTHON / RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH`；没有把 Playwright 或新前端依赖加入产品。`RELATUM_NOTE_RELEASE` 指向隔离的新 EXE 包，可运行同一搜索验收。构建脚本先验证打包 Python 的 SQLite ≥3.43、FTS5 trigram、contentless delete 和短字符项。性能实测与测试限制记录在同目录的性能报告中。微软拼音候选窗仍需隔离人工验收，Chromium 原生合成输入不能代替它。

参考：[FTS5](https://sqlite.org/fts5.html)、[WAL](https://sqlite.org/wal.html)、[增量空间回收](https://sqlite.org/pragma.html#pragma_auto_vacuum)、[Windows 目录通知](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)。

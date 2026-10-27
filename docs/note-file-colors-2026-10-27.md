# 文件染色 1.1

## 使用与显示

“笔记设置 → 扩展 → 文件染色 / File Colors 1.1”，稳定 ID `file-colors`、元数据版本 `1.1.0`，默认关闭。启用后，左侧文件树的文件、文件夹右键菜单提供灰、蓝、青、绿、黄、橙、红、紫及“清除颜色”。色板与右侧笔记本共用创建函数、键盘交互和提示抑制。

仅染当前行的图标和背景，名称沿用主题文字色，子项不继承。原有背景正常/悬停/选中浓度在浅色下为 9%/15%/22%，深色为 14%/22%/30%；保留拖放与键盘焦点提示。右侧笔记本及其子树、搜索结果、正文和标签不受影响。

配置提供背景浓度、悬停浓度、选中浓度及图标饱和度四根原生滑条，分别为 0–300%、0–300%、0–300%、0–200%，步长 5%，默认均为 100%（原有效果）。背景强度同时适配深浅主题，最终透明度分别不超过 60%/65%/70%；图标只计算八色色值，不使用 CSS filter 或新合成层。三行本地示例展示普通、悬停和选中效果；关闭扩展也可配置、预览，不加载运行时或查询数据库。

配置面板右侧的 `.note-file-colors-settings` 滚动条在 `assets/note-extensions.css` 中复用扩展面板的简洁样式：6px 宽、细圆角滑块、透明轨道，无上下箭头，颜色跟随深浅主题。Chromium/WebView2 使用自定义滚动条部件，其他引擎保留 thin 回退；滚轮、拖动和键盘行为沿用浏览器，无新增脚本或偏好。本次样式调整按用户要求未运行检查、测试、构建或打包。

拖动只预览宿主 CSS 变量，松手的 change 事件提交一次现有 `canvas:noteExtensions:v1` 中的四项数值。使用 `backgroundStrength/hoverStrength/selectedStrength/iconSaturation`，读取校验有限数值、范围和步长；旧的空 options 按原效果读取，不在启动时回写默认。实际文件配色仍存 SQLite。窗口失焦、指针取消、Escape、切分类、关闭设置或隐藏时取消尚未提交的预览；语言刷新不替换滑条 DOM，设置搜索按元数据定位实际滑条。`恢复配色参数` 只重置四项参数，保留开关与颜色。

`清空所有数据` 使用共享设置外壳的 `confirmAction({id,title,description,acceptLabel,trigger})` 二次确认，明确清除所有笔记本中的文件/文件夹颜色且无法撤销；保留笔记、附件、扩展开关和滑条参数。取消、Escape 或关闭设置不请求清空；提交期间禁用按钮，成功即清除当前行颜色，失败保留原数据并显示错误。仅删除颜色记录，保留数据库及其版本，不在运行中删除数据库文件。

关闭扩展保留参数和颜色，再次开启恢复；恢复扩展分类或全部笔记设置会关闭开关并重置参数，颜色仍保留。隐藏、最小化、离场和 pagehide 销毁当前控制器并取消读取，恢复后按当前偏好重新读取。已提交的保存继续完成，旧控制器不回写新会话；本机颜色写入共用串行队列，清空排在先前选择之后，避免旧会话的待保存颜色补回。

## 数据与接口

- `note_file_colors.py` 独占 `data/note-file-colors.sqlite3`，首次保存非空颜色才创建。它是用户数据，不属于缓存清理范围；版本不识别或数据库损坏时提示错误并保留原文件，不自动丢弃重建。
- `colors` 仅保存主动染色项：NFC/casefold 路径键、实际相对路径、`note/folder` 类型和颜色标识。`meta` 保存单调版本。清除颜色删除记录；同值保存不改版本。SQLite 使用小页缓存、短连接、WAL 与 FULL 同步，不持有全部颜色的后端常驻映射。
- `POST /api/note-file-colors/query` 接收 `{paths:[...]}`，最多 512 项，返回 `{generation,colors:{路径:颜色}}`；未返回的请求路径表示未染色。批量查询不遍历磁盘、读正文或持有 Markdown 全局写锁，也不创建空数据库。
- `POST /api/note-file-colors/set` 接收 `{path,color}`，颜色为八种标识或 `null`，返回 `{path,color,generation}`。路径沿用笔记授权，设置前验证真实普通目录或 Markdown 文件，拒绝库外路径、重解析点及素材目录。
- `POST /api/note-file-colors/clear` 接收 `{}`，事务删除全部颜色并返回 `{generation,cleared}`。空库重复清理不增加版本，也不创建原本不存在的数据库；错误回滚颜色和版本，不遍历或改动笔记。沿用笔记写入权限与变更锁。
- 已有 `/api/note-changes` 仅在 `fileColors=1` 时附带 `fileColorGeneration`；故障使用 `fileColorWarning`，普通调用不读颜色库。新接口继续受 `notes` 权限限制，只服务原本地 HTTP 服务。

## 文件生命周期

`notes_library.py` 在成功的磁盘移动后迁移该路径及子项的颜色，SQLite 迁移本身为事务。结构移动使用既有同步调度锁交接，并让旧扫描失效，避免清理中间路径。真实文件移动失败保留原色；颜色同步失败单独提示，不把已完成的文件操作改报失败。

`notes_sync.py` 沿用已有 Windows 通知、任务队列和扫描周期。同一完整通知批中相邻的 old-name/new-name 才作为可靠改名对，先迁移颜色，再清理旧路径；不猜测文件身份，不跨丢失的批次配对。未配对、跨盘或软件关闭期间的外部改名不保证保色。通知到达前已经确认并清理旧路径时，也不恢复已删除的颜色。

确认删除会按路径及其子路径删除颜色；文件夹名的相似前缀不匹配。关闭染色后仍随原笔记同步清理，隐藏工作区不额外唤醒后台。已有目录扫描复用自身的路径/类型和失败范围，分批核对颜色，不再遍历文件系统；局部扫描只核对该范围。权限失败、扫描中断、迟到通知和未加载的前端目录页均不作为删除依据。独立数据库不依赖索引 ID，所以索引重建不会丢色，也不会阻止后续清理失效项。

## 渲染与内存

`assets/note-extensions/file-colors.js` 只在开关开启且宿主可见时加载，属于 `scope:'workspace'`，不创建 CodeMirror Compartment。它缓存已加载条目的颜色及未染色结果，目录替换/删除时剪除失效键，关闭和离场释放。新目录按 512 项批量查询，滚动直接使用缓存，不逐行请求。

单项保存使用现有路径到行元素的索引，只改 `data-file-color`；颜色变更串行写入，迟到响应不能覆盖更新选择，失败恢复最后已确认颜色。参数修改通过实例的 `updateOptions(options)` 更新宿主上六项透明度及八个图标色值，不重新加载控制器、重建树、修改选区或重新查询颜色。`previewOptions(id,options|null)` 只向工作区宿主提供临时选项，不通知其他设置面板、不写入存储。CSS 在单行上绘制，关闭时移除宿主启用属性和样式变量。继续复用原 DOM、焦点与超过 200 项的窗口列表，不新增观察器、轮询、文件监听线程、RAF 循环或合成层。

## 验证

所有数据、浏览器配置和图片写入临时目录，不读取用户笔记、不重新打包。使用已有 `RELATUM_PYTHON/RELATUM_PLAYWRIGHT/RELATUM_EDGE_PATH` 指定运行环境。

```text
python -B -m unittest tests.test_note_file_colors tests.test_note_index_api tests.test_note_index tests.test_note_trash tests.test_note_notebooks tests.test_notes_library
node tests/note-file-colors-browser.js
node tests/note-extensions-browser.js
node tests/note-notebooks-browser.js
node tests/note-tree-performance-browser.js
node tests/note-workspace-contract.js
```

后端覆盖稀疏存储、重启/索引重建、目录/大小写迁移、失败回滚、通知配对和扫描竞态、外部删除、读取失败、损坏文件保护、千条记录分批清理、清空的原子性/幂等与权限。Windows 环境另通过真实 `ReadDirectoryChangesW` 通知验证目录改名及文件/目录删除，没有增加独立监听。浏览器覆盖滑条默认兼容、元数据搜索、原生拖动预览/松手单次保存、键盘与失焦取消、重载保存、中英文窄窗、无颜色 API 请求及无 SVG filter、控制器/行/编辑器复用、参数恢复、清空确认/取消/失败/跨笔记本清理及保留参数，并继续覆盖色板、深浅主题、生命周期和文件操作。千项和万项为模拟目录，只测前端窗口化与批量接口调度，不代表真实万篇正文索引的用时或进程总内存。报告记录可见行数、单行属性更新、开关前后暖渲染中位数、滚动查询次数与闲置 RAF。

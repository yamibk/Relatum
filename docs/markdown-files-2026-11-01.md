# 外部 Markdown 文件与简洁窗口

Relatum 桌面版可以直接打开磁盘上的 `.md` / `.markdown`，使用原来的实时编辑器，保存回原文件。无需加入笔记库，不扫描所在目录、不创建笔记本或 SQLite 索引，完整笔记工作区保持独立。

## 使用

- 在“笔记设置 → Markdown 文件”打开磁盘文件，或新建一个空白的独立窗口。窗口内 Ctrl+O 打开文件，Ctrl+N 新建，Ctrl+S 保存，Ctrl+Shift+S 另存为。
- 希望双击打开时，先点“注册 / 修复”，再点“打开默认应用设置”，在 Windows 中搜索 `.md` 并选择 Relatum。注册操作不会主动更改默认程序；用户可继续保留 Typora，通过“打开方式”偶尔使用 Relatum。
- 移动便携版后在新位置修复注册。每台电脑单独设置；删除程序前可以取消当前位置的注册。取消注册不替用户选择其他默认程序。
- 最近列表最多 20 项，支持打开、在资源管理器中定位、移除记录和清空。移除记录不会删除磁盘文件。
- 自动保存默认开启，停止输入约 750ms 后保存。新文档第一次保存会询问位置。大纲默认收起，可设为新窗口打开时显示；窗口中的图标随时切换。

## 复用与边界

`assets/markdown-file.html/js/css` 只负责单文件外壳。编辑实例直接调用 `RelatumNoteLiveEditor.create()`，沿用 `note-live-editor.js`、`note-table-editor.js`、`note-outline.js`、扩展注册、公式和 Mermaid 按需运行时，以及现有虚拟 DOM、滚动准备、块尺寸记忆和输入法交接。没有复制或更改编辑器核心。

工具栏为图标按钮，提供中英文提示、可访问名称和快捷键。唯一侧栏为大纲；设置复用原生居中的笔记设置外壳，提供 Markdown 文件管理与外观。主题复用默认 / Claude / Sky / Apple 及原有主题样式，简洁窗口有独立深浅色选择。隐藏、最小化、pagehide 暂停或释放准备、大纲和浮层。

`desktop.py 文件.md` 或 `desktop.py --markdown-file [文件]` 进入 `markdown_desktop.py`；不经过笔记工作区占用锁，可以与完整工作区同时使用。每次打开创建独立进程和窗口，相同文件多次打开也有独立编辑状态，保存时检查修订号。已有 `.canvas` 命令行协议及 `app.py` 服务入口保持原义。

`markdown_files.py` 只处理明确选择的文件。支持 UTF-8 / UTF-8 BOM，保留原 BOM 和主要 LF/CRLF 换行，单文件上限 4MiB。保存沿用同目录唯一临时文件和原子替换，跨 Relatum 进程串行检查磁盘字节修订；磁盘变更、删除、不可写、过大时保留窗口草稿，允许重新载入或另存为，不悄悄覆盖或复活删除文件。关闭先等待输入法/单元格提交和正在进行的保存，再按需选择保存、放弃或取消，并冲刷窗口偏好。

相对图片只读取文档所在文件夹及其子目录内的受支持图片，不跟随链接或重解析点，不开放父目录、绝对路径或任意文件读取。粘贴/拖入图片写入同名 `.assets` 目录，复用已有图片类型、尺寸及静态 SVG 校验。内嵌画布、AI 和图谱不在这个窗口启动。HTTP(S)/mailto 链接交给系统打开，相对 Markdown 链接打开独立文件窗口。

## 设置与本机集成

完整笔记设置在“文件与笔记库”之后新增 `markdown-files` 分类，由 `assets/markdown-files-settings.js/css` 提供，共用简洁窗口中的管理面板。浏览器能查看说明，原生操作禁用；`pywebviewready` 到达后刷新能力。状态按进入分类或主动操作刷新，不持续轮询。

- `data/markdown-files.json`：`version:1`，`autoSave:true`、`outline:false` 和 `recent` 路径列表。不保存正文。分类恢复及全部恢复只重置自动保存和大纲默认值，保留最近记录和 Windows 注册。
- `data/desktop-sessions/markdown-files/preferences.json` 及该会话的 `WebView2/`：简洁窗口独立的外观/扩展偏好与浏览器存储。首次从已有完整会话快照继承笔记偏好，之后不回写完整工作区的快照；`canvas:markdownDark:v1` 保存此窗口外观的深浅选择。
- 桌面桥接 `markdown_files(action,value)`：状态、设置更新、最近记录、新建/打开、注册/取消和系统默认应用入口。文档桥接只操作本窗口的文档，选择新路径须经过原生文件对话框。
- 独立窗口服务只有静态应用资源和随机会话令牌保护的只读图片地址 `/api/markdown-file-asset`；拒绝其他 `/api/` 和全部 POST，没有新增外部命令监听或任意文件读写 HTTP API。
- Windows 仅注册 `HKCU` 下的 `Relatum.Markdown` ProgID、`.md/.markdown` 的 `OpenWithProgids`、`Software/Relatum/MarkdownCapabilities` 和对应 `RegisteredApplications` 值。不写 `UserChoice`，不修改其他应用的注册或扩展默认值。注册记录指向当前绝对程序位置，取消前核对仍属于当前位置。源码运行记录 Pythonw 与 desktop.py，发布版记录 Relatum.exe。

## 验证

`python -B -m unittest tests.test_markdown_files` 使用临时文件和模拟注册表，覆盖字节往返、冲突、删除、失败、上限、新建、图片路径/静态 SVG、最近记录和注册修复/取消的隔离。不会修改真实 Windows 关联。

配置 `RELATUM_PYTHON` 为已有 pywebview 环境、`RELATUM_PLAYWRIGHT`、`RELATUM_EDGE_PATH` 后运行 `node tests/markdown-files-desktop.js`，在临时数据根启动源码桌面入口和真实 WebView2，覆盖编辑器复用、大纲、保存/外部冲突/重新载入、设置、自动保存、源码切换、最小化、图片及令牌边界、公式/Mermaid 按需加载和关闭保护。截图保存在临时目录或 `RELATUM_ARTIFACT_DIR`。

加 `--blank` 验证空文档首次保存与另存为，文件对话框选择结果使用测试替身，仍经过真实桌面桥接和磁盘保存；`RELATUM_MARKDOWN_RELEASE` 可指定独立发布目录，直接测试其中的 Relatum.exe，且不替换其资产。两个入口都不改变真实文件关联。

加 `--workspace` 验证普通完整桌面工作区中的“笔记设置 → Markdown 文件”入口及真实桥接配置保存，初始偏好与用户数据仍全部位于临时根。独立预览 EXE 的单文件和完整工作区两种验证均通过。

笔记设置七种功能配置、主题/大纲/实时编辑器、桌面偏好、功能裁剪和实例协调回归通过；后端及构建辅助检查共 88 项通过。额外运行的旧启动器测试仍因已有 `daily.images` 英文文案缺失而失败，此项不属于本次修改。

独立便携预览包输出到 `D:\Relatum-Markdown-preview-20261101`，保留原 release、用户数据和当前默认打开程序；使用已有锁定环境离线打包并验证实际 EXE。文件关联只有用户在新设置分类主动操作后才登记。

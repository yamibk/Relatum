# 笔记中的 Windows 本机文件链接

笔记工作区与独立 Markdown 窗口支持本机盘符 `file:///` 地址。HTML、PDF、图片和 Office 等普通文件交给系统默认程序；编辑时 Ctrl/Cmd＋单击，工作区阅读模式单击。激活后直接打开，不添加确认框或文件夹授权设置。

## 内容与入口

- 支持裸地址、`<file:///…>`、`[标题](file:///…)`、`[标题](<含空格的地址>)` 和引用式链接。
- 普通粘贴仅在剪贴板带有匹配的单个 HTML 链接标题时生成标题链接；没有标题时保留原地址。纯文本粘贴保留原字符。标题中的 Markdown 标记保持字面含义。
- `assets/markdown.js` 的笔记专用解析与 `pastedLinkMarkdown` 共用识别和标题转换；`assets/note-workspace.js` 保留已有公式粘贴兼容，`assets/markdown-file.js` 同时读取键盘及右键粘贴的 HTML。
- 工作区调用现有 `POST /api/open-external`，请求为 `{kind:'note-file-url',note,target}`，检查笔记功能及来源笔记后返回 `{ok:true}`。独立窗口通过原 `markdown_open_link(target)` 桥接调用同一个文件打开器，无需保存新文档，也不扫描或创建笔记库。
- 没有新增偏好、持久化文件、依赖或正文迁移。

## 文件边界

`app.py` 的 `resolve_note_file_url/open_note_file_url` 仅接受 Windows 本机绝对文件 URL，主机为空或 `localhost`。路径按 UTF-8 解码一次，支持中文、空格、括号及编码后的百分号/井号。查询和片段不参与磁盘路径校验，调用系统处理程序时保留。

拒绝网络共享、远程主机、设备路径/名称、控制字符、损坏编码、备用数据流和尾部点/空格别名。原始路径与解析后的实际目标分别检查既有危险扩展名，实际目标必须是存在的本机普通文件，符号链接或目录联接不能转向网络共享或危险文件。失败使用现有错误提示。

用户激活只授权本次精确文件，不扩展原有画布目录或笔记相对路径权限。代码、注释、前言及公式中的地址保持字面内容；图片继续使用原素材接口和路径边界。

## 验证与结果

测试样例使用通用虚构目录及文档标题，不使用用户配置文件目录。提交或打包前运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-public.ps1`；曾有虚构用户目录样例触发个人绝对路径规则，现已改为中性样例，保留原安全检查规则。测试生成的隔离笔记、截图和 WebView2 缓存位于系统 Temp，未纳入 Git 或打包资产。

- `node tests/note-file-links-regression.js`：多种链接写法、中文/编码/括号/空格、标题转义、图片与字面区域、原有网络及相对链接。
- `python -B -m unittest tests.test_note_file_links`：隔离文件与 OS 调起替身，验证一次解码、目标身份、缺失/目录/危险文件、重定向、来源授权、功能关闭及打开失败。
- `node tests/note-file-links-browser.js`：真实 Edge 剪贴板和修饰键，隔离工作区与独立页面桥接，验证实时/源码/阅读、键盘/右键粘贴、纯文本、撤销和保存重开。
- `node tests/note-file-links-desktop.js --workspace`：源码桌面壳、真实 WebView2、隔离库及 OS 调起替身，验证三类外部文档的实际链接入口。
- `node tests/note-file-links-desktop.js --launch-defaults`：源码独立 Markdown 窗口将临时 HTML、PDF、PNG 提交给系统默认程序；另验证可执行文件拒绝及未创建笔记库。

上述专项已运行通过；共享 Markdown、模糊语法、实时编辑器、剪贴板回归及原笔记库/Markdown 文件/功能权限测试也已通过。Python 组合共 95 项，跳过其中 1 项已有的平台/能力条件测试。

图片兼容浏览器回归、双链/新标签浏览器回归、工程代码 32 种别名、笔记工作区及 notebook 契约通过。额外执行的 `markdown-global-contract.js` 在 `calendar CSS must include h1` 失败；已在内存中用 HEAD 全部原始输入重跑，得到同一断言，属于本轮未修改的既有日历样式契约问题。

原生实际调起专项已执行；随后 computer-use 因无法可靠确定浏览器当前 URL 而停止，目标程序的正文显示未完成界面核验。此结果仅表示原生入口与系统调起请求验证，不代替完整的默认程序显示验收。本轮未重新打包。

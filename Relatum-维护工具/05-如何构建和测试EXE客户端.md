# 如何构建和测试 EXE 客户端

只记住两件事：

> BAT 只负责生成干净的 `Relatum-release`；测试时运行它的复制副本，不运行原始成品。

## 构建

1. 双击 `构建Relatum-release.bat`。
2. 等待窗口显示“构建完成”。如果出现“停止”或“错误”，把完整提示交给 AI。
3. 构建结果位于源码仓库的上一级：`Relatum-release`。

第一次先双击 `准备Relatum构建环境.bat`，需要联网。它会准备独立的固定 Python 和依赖，不需要你安装 Python 或使用 PowerShell。

以后只双击原来的构建 BAT，日常打包不联网。环境不完整时会停止并说明原因；用准备入口修复，或在缓存完整时用 `离线修复Relatum构建环境.bat`。`检查Relatum构建环境.bat` 只检查、不打包；`打开Relatum构建日志.bat` 打开日志文件夹。

所有 BAT 保留在仓库的 `Relatum-维护工具` 文件夹内。简短操作说明见 `打包新手说明.md`。

当前源码不必先 commit 或 push。网页端测试产生的 `data/`、`canvases/` 会继续留在源码目录，不会进入构建成品。

## 测试 EXE

1. 不要直接运行原始 `Relatum-release\Relatum.exe`。
2. 在资源管理器中复制整个 `Relatum-release` 文件夹。
3. 把复制出来的文件夹放到桌面，并改名为 `Relatum-EXE测试副本`。
4. 运行测试副本里的 `Relatum.exe`。
5. 只使用虚构数据测试新建、节点、连线、保存和本次修改的功能，然后关闭客户端。
6. 再次运行同一个测试副本里的 `Relatum.exe`，确认刚才的虚构画布能够重新打开。

测试副本产生 `data/`、`canvases/` 是正常的。它不在 Git 仓库中，不会被自动上传；但不要把这个测试副本当作发布成品。

准备 GitHub Release 时，只处理始终没有运行过的原始 `Relatum-release`。版本号、压缩文件名和 Release 说明由你自己填写。

`构建Relatum-release.bat` 不会压缩 ZIP，也不会执行 Git commit、push 或 GitHub Release 发布。

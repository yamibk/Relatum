# Relatum 维护工具

这个目录保存 Relatum 维护者使用的简短教程和本地辅助工具。

最常用的文件：

- `构建Relatum-release.bat`：把当前网页源码构建为 Windows `Relatum-release` 文件夹。
- `准备Relatum构建环境.bat`：首次使用或修复环境，允许联网。
- `离线修复Relatum构建环境.bat`：只用已有缓存修复环境。
- `检查Relatum构建环境.bat`：只检查环境，不打包。
- `打开Relatum构建日志.bat`：打开日志文件夹。
- `打包新手说明.md`：只需双击的简短操作步骤。
- `清除Relatum浏览器缓存.bat`：只清理桌面客户端可重建的 WebView2 缓存，处理显示异常或旧资源残留。
- `重置Relatum界面偏好.bat`：重置桌面客户端的新手引导、主题、语言和交互偏好，不删除业务数据。
- `05-如何构建和测试EXE客户端.md`：说明如何复制测试副本，避免测试数据污染原始成品。
- `00`–`04`：Git、日常维护、Release 和出错恢复说明。

## 安全边界

- 构建 BAT 不会压缩 ZIP，不会运行 EXE，也不会执行 Git commit、push 或 GitHub Release 发布。
- 缓存清理 BAT 不会删除画布、个人记录、AI 配置或 `localStorage` 界面偏好，也不会强制结束 Relatum。
- 界面偏好重置 BAT 只清除 WebView2 的 `Local Storage` 和临时会话状态，不删除 Cookies 或仓库、发布包中的用户数据。
- BAT 从自身位置寻找仓库，不绑定 Windows 用户名、桌面路径或 Relatum 版本号。
- 网页端产生的 `data/`、`canvases/` 不会被桌面构建脚本复制进成品。
- 运行 EXE 时必须使用 `Relatum-release` 的复制副本；原始成品保持从未运行。
- 公开仓库中的 `Relatum-维护工具` 不包含个人使用的 `上传到GitHub.ps1`。

维护工具可以放在仓库根目录的 `Relatum-维护工具/` 中。它们不参与 Relatum 运行时；只有工具内容或维护流程变化时才需要更新。

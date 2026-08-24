# 数据与隐私边界

Relatum 是本地优先应用。源码仓库与用户数据严格分离。

## 本地生成的数据

应用运行后会在项目或桌面发布包旁创建：

- `canvases/`：画布正文、回收站以及每张画布的 `.assets/` 图片和附件。
- `notes/`：笔记工作区的 Markdown 正文、任意层级文件夹，以及每篇笔记的 `<stem>.assets/images/` 本地图片。
- `data/recent.json`：最近画布和分组，其中可能包含绝对文件路径。
- `data/viewport.json`、`data/window-state.json`：视口和窗口状态。
- `data/study.json`、`data/notes.json`、`data/daily.json`、`data/focus.json`：学习与个人记录。
- `data/diary/`、`data/学习归档/`、`data/画布归档/`：日记和历史归档。
- `data/note-recovery/`：笔记的本地恢复快照，用于外部改写碰撞或主动恢复历史。
- `data/ai.json`：用户配置的 AI 地址、模型与 API Key。
- `data/backgrounds/`：用户导入的背景图片。

这些内容都不属于源码，已在 `.gitignore` 中整体排除。`notes/` 是真实用户正文而非缓存；可用普通备份工具复制。应用内的删除会移入 Windows 系统回收站，在 Explorer 中手工更改文件后则可返回 Relatum 或手动刷新以重新同步。

Windows 桌面版还会在 `%LOCALAPPDATA%\Canvas\WebView2` 保存 WebView2 配置和前端 `localStorage`。
它位于仓库之外，不会被 Git 收集；进行“全新用户”测试时，需要使用隔离的本地配置目录或先备份后清理该目录。

## 网络边界

本地服务默认只监听回环地址。除用户主动配置和调用 AI 接口外，核心画布、笔记、学习与日历功能不需要云端账号。
第三方脚本和字体随项目本地提供，正常使用时无需从 CDN 加载。

## 发布前检查

在 `git add` 或上传压缩包之前运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-public.ps1
```

默认模式检查 Git 会提交的文件，适合日常开发。制作 ZIP 或正式发布前必须检查目录中的全部物理文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-public.ps1 -Physical
```

脚本会检查用户数据目录、常见凭据格式、个人绝对路径、缓存和过大的文件。自动检查不能替代人工复核；提交前仍应查看：

```powershell
git status --short
git diff --cached --name-only
```

如果凭据曾经进入 Git 历史，仅删除当前文件不够：应立即在服务商后台吊销或轮换凭据，并在公开前清理仓库历史。

## GitHub 账号与提交隐私

- 提交前使用 GitHub 提供的 `noreply` 邮箱，不要把个人邮箱写入 Git 的作者或提交者信息。
- 在 GitHub 的邮箱设置中启用“保持邮箱地址私密”和“阻止会暴露个人邮箱的命令行推送”。
- 提交、Issue、Pull Request、Actions 日志、截图和 Release 附件都是公开内容；上传前应去除真实姓名、联系方式、本机路径、账号凭据和私人数据。
- GitHub 公开仓库允许任何人查看和下载。希望接收贡献时，保留 Issue 与 Pull Request 即可，不需要公开个人联系方式。
- 维护账号应启用双重验证或 Passkey，并定期检查登录会话、SSH Key、访问令牌和已授权应用。

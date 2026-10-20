# 构建与 GitHub Release 流程

## 源码更新和 Release 是两件事

| 操作 | 用途 |
| --- | --- |
| commit + push | 更新 GitHub 上的源码和版本历史。 |
| `构建Relatum-release.bat` | 把当前源码构建成 Windows 成品文件夹。 |
| GitHub Release | 由维护者在 GitHub 网页填写版本号、说明并上传成品。 |

## 构建 Windows 成品

第一次先双击 `准备Relatum构建环境.bat`，需要联网。以后打包不联网；故障处理见 `打包新手说明.md`。

双击：

```text
构建Relatum-release.bat
```

成功后会在源码仓库的上一级生成：

```text
Relatum-release\
├─ Relatum.exe
├─ Relatum.exe.config
└─ _internal\
```

BAT 不压缩 ZIP，也不上传 GitHub。版本号、压缩文件名和 Release 说明由维护者自行决定。

## 发布前最低检查

- [ ] 需要正式发布的源码已经 commit 并 push。
- [ ] GitHub Actions 检查通过。
- [ ] `Relatum-release` 包含 EXE、config 和完整 `_internal/`。
- [ ] 成品没有 `data/`、`canvases/`、`.canvas`、`.assets/`、API Key 或私人文件。
- [ ] 已按照 `05-如何构建和测试EXE客户端.md` 在复制副本中完成 EXE 测试。
- [ ] 原始 `Relatum-release` 从未运行，没有产生测试数据。

正式发布时，可以按自己的版本规则把原始 `Relatum-release` 压缩并上传。不要上传桌面的 EXE 测试副本。

如果正式版本有问题，修复源码后发布新的版本号；不要强推、清空仓库或悄悄替换已经公开版本的源码历史。

# Relatum 开源项目维护教程

这套教程按“只懂一点 CMD、会让 AI 修改本地源码”的情况编写。

结论先说：你原来的流程不用推翻。保留“让 AI 修改 → 打包 → 上传 GitHub Release”，只需要在修改和打包之间加入：

1. 检查修改；
2. `commit`（在本机保存一个版本快照）；
3. `push`（把新快照同步到 GitHub）。

以后只使用真正的 Relatum Git 仓库开发。它应包含 `.git`、`app.py`、`assets/` 和 `build-desktop.ps1`。

```text
Relatum\
├─ .git\
├─ app.py
├─ assets\
└─ Relatum-维护工具\
```

仓库可以放在任意磁盘和目录；维护 BAT 会从自身位置自动寻找仓库，因此换电脑后不需要修改绝对路径。

它连接的云端仓库是：

```text
https://github.com/yamibk/Relatum
```

不要再把历史工程、GitHub 下载的 ZIP、`Relatum-release` 发布目录当成日常源码继续修改。

## 推荐阅读顺序

1. [01-Git零基础词典.md](01-Git零基础词典.md)
2. [02-让AI修改代码后的日常流程.md](02-让AI修改代码后的日常流程.md)
3. [03-打包与GitHub-Release流程.md](03-打包与GitHub-Release流程.md)
4. [04-出错恢复与开源维护.md](04-出错恢复与开源维护.md)
5. [05-如何构建和测试EXE客户端.md](05-如何构建和测试EXE客户端.md)

## 你现在只需掌握的五件事

- `git status`：查看现在有没有修改。
- `commit`：把确认正确的源码保存为一个有名字的版本快照。
- `push`：把本地新增的 commit 上传到 GitHub。
- `pull`：GitHub 有新提交时，把它取回本地。
- Release：给普通用户下载的正式版本页面和安装包。

分支合并、rebase、cherry-pick 等高级内容目前都可以不学。遇到它们时，让 AI 先解释当前状态，再给针对性的安全方案。

## 一张图理解完整流程

```text
固定的本地源码目录
        ↓ 让 AI 修改
检查差异、运行测试、检查隐私
        ↓ commit
电脑里的 Git 历史多一个版本
        ↓ push
GitHub main 更新源码
        ↓ 只有稳定版本才打包
Relatum-vX.Y.Z-windows.zip
        ↓
GitHub Release 供用户下载
```

云端不需要清空，也不需要每次重新上传整个项目。Git 会把新增的版本和变化同步过去。

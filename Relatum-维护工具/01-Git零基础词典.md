# Git 零基础词典

## 本地仓库和云端仓库是什么关系

严格来说，现在确实有两个 Git 仓库：

- 本地仓库：电脑里的 `Relatum` 文件夹，以及其中隐藏的 `.git` 历史。
- 远端仓库：GitHub 上的 `yamibk/Relatum`。

但它们不是两个需要人工分别维护的项目，而是同一个项目的本地副本和云端副本。两者通过名为 `origin` 的连接关联。

本地是工作的地方；GitHub 上的 `main` 是公开版本。修改完成后使用 `push` 增量同步，不需要删除云端文件再上传。

## 必须认识的词

| 名词 | 最简单的理解 |
| --- | --- |
| repository / repo / 仓库 | 项目文件，加上 Git 保存的版本历史。 |
| working tree / 工作区 | 你现在能在资源管理器里看到并编辑的文件。 |
| `main` | 当前正式源码路线的名字。你目前只使用这一条路线即可。 |
| `origin` | 本地仓库给 GitHub 远端起的简称。 |
| `git status` | 查看哪些文件被修改、增加或删除。只读，不会改文件。 |
| `git diff` | 查看尚未提交的具体代码变化。只读。 |
| `git add` | 把文件放入“下一次准备保存的清单”。 |
| commit | 在本机保存一个带说明的源码快照。 |
| push | 把本地新增的 commit 上传到 GitHub。未 commit 的修改不会被 push。 |
| pull | 把 GitHub 上的新 commit 下载并接到本地。 |
| branch / 分支 | 一条临时的独立修改路线。大改动或多人并行时才需要。 |
| rollback / 回滚 | 撤销错误的统称，不是一个固定按钮。不同状态有不同安全做法。 |
| tag / 标签 | 给某个 commit 加一个固定版本号，例如 `vX.Y.Z`。 |
| GitHub Release | 以某个 tag 为依据发布说明和 Windows ZIP 的页面。 |
| `.gitignore` | 告诉 Git 哪些本机数据、缓存和构建产物不应上传。 |
| GitHub Actions | GitHub 收到 push 后自动运行的检查；绿色通常表示检查通过。 |

最重要的一句话：

> commit 只保存在自己电脑；push 之后 GitHub 才会更新。

## 现在必须学会

- 分清本地仓库、GitHub 远端和 Release。
- 修改前后会运行 `git status`。
- 明白 commit 和 push 不是一回事。
- 每次上传前确认没有 `data/`、`canvases/`、API Key 或构建产物。
- 公开版本出错后继续提交修复，不要删除整个云端仓库。

## 现在可以暂缓

- 多分支协作和复杂合并。
- `merge`、`rebase`、`cherry-pick`、`stash`。
- 修改或压缩历史提交。
- 自己手工解决冲突。
- Pull Request 的高级管理。

等到出现“大功能要试验”“多个 AI 同时改代码”或“接受外部贡献”时，再学习分支，性价比更高。

## 三个安全的只读命令

先在资源管理器中打开包含 `.git`、`app.py` 和 `assets/` 的仓库根目录，再从该目录打开 CMD。然后可以随时运行：

```cmd
git status -sb
git diff --stat
git log --oneline -10
```

它们只显示状态，不会修改源码。

## 不要自行运行的危险命令

```text
git reset --hard
git clean -fd
git clean -fdx
git push --force
```

也不要删除 `.git` 文件夹。特别是 `git clean -fdx`，可能删除被 Git 忽略的本地 `data` 和 `canvases`。

看不懂状态时，先运行 `git status -sb`，把完整输出交给 AI，并要求它不要使用强制推送或整棵工作区回滚。

# RelatumLauncher 验证

## 功能边界

功能清单位于 `assets/feature-catalog.json`，当前有 16 项。`launcher.py` 使用现有桌面包的 pythonnet/WinForms 显示原生选择窗口；`feature_profile.py` 负责依赖解析、版本校验、选择保存和资源/API 归属。`Relatum.exe` 与 `RelatumLauncher.exe` 共享归档、图标与 `_internal`；启动器在导入主服务和 WebView2 前分派。

选择保存在实际数据根的 `data/launcher-profile.json`，与两份 EXE 旁用于 .NET 的 `.exe.config` 是不同文件。启动器确认后才原子保存选择，再通过命令行交给本次进程。普通主 EXE 使用完整模式，不读取保存的启动器选择；精简主窗口已存在时，完整启动会要求先退出。

客户端设置新增“启动 RelatumLauncher 时不再弹窗”，由原生桥接原子保存到 `data/launcher-settings.json`，可随时取消恢复选择窗口。启用后直接启动上次组合；选择缺失/损坏或仅编辑器的上次画布已失效时恢复选择窗口。启动器标题下方原两行说明已删除。导航滑块按实际启用工作区排列，避免精简模式白字落在白底。

服务端在返回 HTML 前移除禁用页面和脚本，并拒绝其静态资源、独占 API 和直接页面 URL。客户端同时检查工作区恢复、空闲预热、激活器、翻页、快捷键和编辑器入口。功能开关不能替代路径授权；已启用的统计页仍可读取其他功能历史。MathJax、Mermaid 和 PDF 保持原有内容触发规则，没有增加对应开关。

## 自动验证

所有夹具使用临时数据根；真实 `canvases/`、`notes/`、`data/` 不参与测试。

```powershell
python -m unittest tests.test_feature_profile tests.test_launcher_native tests.test_desktop_instance tests.test_windows_wallpaper tests.test_runtime_paths
node tests/feature-profile-browser.js
node tests/launcher-settings-package.js D:\Relatum-release
node tests/launcher-package-memory.js D:\Relatum-release <报告JSON路径> 3
```

前两条需要桌面构建环境的 Python；浏览器脚本使用已有 Playwright（`RELATUM_PLAYWRIGHT`）、Edge（`RELATUM_EDGE_PATH`）与 Python（`RELATUM_PYTHON`）。最后一条直接启动发布包，通过仅用于验证的 WebView2 本地调试端口连接真实页面，测试结束后关闭全部测试实例并删除临时根。

设置 `RELATUM_SERVER_EXE` 为发布包的 `Relatum.exe`，可把同一套浏览器边界验证直接运行在打包服务模式上。完整 Python 测试集应先把 `RELATUM_DATA_ROOT` 指向新的临时目录，再运行 `python -m unittest discover -s tests -p 'test_*.py'`，避免旧夹具的共享统计读取真实历史。

验证覆盖：

- 父项关闭保留子项、取消不保存、确认后保存、损坏配置提示、新功能缺省启用、依赖缺失与循环拒绝。
- 无有效入口、仅编辑器未选文件、无效会话结构拒绝；独立画布管理和编辑器均可启动。
- 四个工作区和七个特殊页面分别单独启用；恢复禁用工作区、隐藏特殊页偏好、页面翻转、跨页事件、脚本请求与直接 URL/API 边界。
- Windows 大小写和路径别名、共享历史读取、启用功能预热、普通单实例和启动器不转交到旧窗口。
- 原生窗口的 16 个选项与依赖状态；两份 EXE 相同字节和图标、两份运行时配置、共用资产及不包含用户数据。
- 真实 WebView2 笔记窗口在刚输入后关闭，等待保存链落盘；直接 EXE 忽略磁盘中故意设置的精简启动器配置。
- 精简导航的中英文标签、宽/窄窗口滑块几何对齐，以及两工作区间切换；免弹窗设置保存/恢复、关闭、损坏回退、仅编辑器路径复用与已有实例拦截。`node tests/launcher-settings-package.js <发布目录>` 验证真实客户端控件保存、启动器直接启动笔记和取消后恢复选择窗口。

MSIX 脚本在复制便携包后删除 `RelatumLauncher.exe` 和 `RelatumLauncher.exe.config`；商店清单仍仅登记 `Relatum.exe`。

此次隔离验证中 291 项 Python 测试通过；初版的 69 个非 vendor JavaScript 文件语法检查及本次改动文件语法检查均通过；资源边界矩阵覆盖 14 种组合。真实便携包的客户端设置保存、免弹窗启动笔记、取消后恢复选择窗口均通过。原生启动器默认启动后保持等待，没有 WebView2 子进程；初版单次启动器私有内存约 62.2 MiB，确认后窗口退出。

## 冷启动内存测量

2026-10-03，在 Windows 11（10.0.26200）和当前本机 WebView2 上测量便携包。每个配置启动 3 次，使用全新数据根和全新 WebView2 用户目录，不打开个人文件；加载稳定后再等待 10 秒，取整个主进程及其 WebView2 子进程树的总量。每次均为 7 个进程。以下为三次中位数，单位 MiB：

| 本次配置 | 私有提交内存 | 相比完整模式 | 工作集总量 |
| --- | ---: | ---: | ---: |
| 直接 Relatum.exe，完整模式 | 378.9 | — | 618.3 |
| 仅画布工作区和画布管理 | 289.3 | 减少 89.6（23.6%） | 524.4 |
| 仅笔记工作区 | 292.4 | 减少 86.5（22.8%） | 532.7 |

私有提交内存更适合比较实际分配；工作集相加包含进程间共享页，不能解释为同等数量的独占物理 RAM。结果说明这些精简组合确实减少加载和分配。WebView2、Python、共用样式和窗口外壳仍有固定开销；文件内容、浏览器版本、后台负载与机器环境会改变结果，不保证每个组合都达到同样降幅。

原始每次测量、进程明细、资源列表和中位数由脚本写入调用者指定的 JSON。重新测量时请使用同一口径，并继续保留启用功能原有预热。

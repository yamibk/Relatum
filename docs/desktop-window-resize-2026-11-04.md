# 桌面窗口缩放与设置合并

Relatum 主窗口使用 Windows 原生拖边缩放，支持四边、四角。最小尺寸为 720×480 逻辑像素，上限按当前显示器工作区计算；移除旧的 1920×1200 固定上限和 32px 扣减。最大化时不启用边缘缩放，保留现有标题栏按钮、移动保护、系统窗口过渡及 DWM 圆角。

## 原生实现与数据

`desktop.py` 保留 DPI 对应的系统缩放边框，将其放在 WebView2 子窗口外侧。单独修改宿主的 `WM_NCHITTEST` 不够：真实鼠标会命中 `Chrome_RenderWidgetHostHWND`，因此必须保留可供系统接收输入的原生区域。本实现不增加网页覆盖层、全局鼠标钩子或逐帧自绘缩放。

WinForms 使用 Sizable 元数据，但原生标题栏仍隐藏。系统还原命令和桥接 ShowWindow 还原均先取得真实还原矩形，再校准普通窗口尺寸，避免 WinForms 按标准标题栏计算尺寸而造成宽高变化。尺寸设置直接使用当前窗口 DPI，不使用 pywebview 启动时缓存的比例。

实际尺寸以 `GetWindowPlacement` 为准，桥接中的尺寸字段只是镜像。拖动结束、DPI/工作区变化通过可取消的单次后台任务合并处理；设置成功和关闭也保存真实还原矩形。原生消息处理不执行 JavaScript 或文件写入，连续拖动期间不反复重断言圆角，闲置没有新增轮询或连续 RAF。退出取消待处理任务，GUI 循环结束后释放原生回调引用。

状态继续使用 v2：完整模式为 `data/window-state.json`，精简模式为 `data/desktop-sessions/<组合>/window-state.json`。尺寸按逻辑像素保存，最大化/最小化不替代普通尺寸，不迁移已有记录。独立 Markdown 文件窗口使用自己的原有原生窗口和状态逻辑。

## 设置与接口

旧客户端设置弹窗及左下角入口已经移除。全局设置“系统”统一提供三个尺寸预设、宽高输入和单一启动器免弹窗开关，两种首页外壳共用控制器。普通浏览器不创建这两个桌面专属控件。窗口尺寸及启动器偏好不参与系统分类恢复和全部恢复。

保留 `CanvasDesktop.getRestoredSize/setRestoredSize` 及 `{width,height,limits}` 返回值。内部 `canvasdesktop:window-size` 事件沿用同样的 detail，完成调整时发布。读取仅在进入系统分类时进行；离开或关闭后拒绝迟到结果。尺寸通知保留未提交输入，应用期间禁用重复提交，失败保留输入并显示错误。最大化时应用尺寸先还原。启动器沿用原生桥接、原子写入 `data/launcher-settings.json`、提交串行及失败回滚，不依赖旧弹窗 DOM。

## 验证

所有验证使用临时数据根、临时 WebView2 配置和源码，不运行或替换已有 `Relatum-release`。

- `python -B -m unittest tests.test_desktop_window tests.test_desktop_instance tests.test_desktop_preferences tests.test_markdown_files`：51 项通过，包含八方向、负坐标、DPI、无固定上限、真实矩形保存、v2 兼容、失败传播及任务取消。
- `node tests/desktop-window-contract.js`、`node tests/desktop-preferences-regression.js`、`node tests/global-system-regression.js`：通过。
- `node tests/global-settings-browser.js system system-notes system-late`：两种首页外壳的桌面设置及桥接迟到通过，覆盖预设/自定义、草稿保留、单次提交、失败、迟到读取、语言、重载、恢复及无启动器宿主；两种外壳的深浅色、宽窄窗截图已检查。另运行 `full notes library`，普通浏览器设置回归通过。
- `node tests/global-system-browser.js`：资源策略、保留时长、失败及闲置生命周期回归通过。
- `node tests/desktop-window-native.js`：真实 WinForms/WebView2 和 Windows 鼠标输入通过。覆盖已有 v2 状态恢复、八方向拖动且设置弹窗保持打开、拖后保存/同步、原生 tracking 与输入共用上下限、闲置不保存、最大化重开、系统命令还原、标题栏最大化/还原、最小化恢复以及普通尺寸重开；宽高均作断言。

测试使用已有 `RELATUM_PYTHON / RELATUM_PLAYWRIGHT / RELATUM_EDGE_PATH`，不引入项目依赖。原生实机覆盖本机 150% DPI；其他 DPI 和负坐标有单元验证，混合 DPI 多屏、显示器拔插及其他 Windows 版本尚未完成实机验收。本轮没有重新打包。

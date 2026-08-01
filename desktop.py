"""画布桌面外壳（pywebview / WebView2）—— 极简版。

设计取舍：
- 用 WebView2 渲染，观感与浏览器（Edge）完全一致，渐变等视觉零差异。
- 无边框，复用前端既有的集成标题栏（desktop-shell.js）。
- 可拖动；按产品约定禁用拖边缩放，尺寸只从起步页设置调整。
- 记住窗口大小 / 位置 / 最大化状态：下次启动恢复到上次的样子。
- 承载既有 app.py 本地服务，画布数据与交互核心完全不变。

不再包含旧版那套 SetCapture 逐帧自绘缩放 / 热区 / 边框涂色 / 最大化逐帧动画。
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import threading
from ctypes import wintypes
from pathlib import Path

import app
from windows_wallpaper import WallpaperController, run_wallpaper_child

try:
    import webview
except ImportError:
    webview = None

# ── Win32 常量（无边框 + 系统窗口过渡 + 圆角所需的最小集） ──
GWL_STYLE = -16
GWLP_WNDPROC = -4
WS_CAPTION = 0x00C00000
WS_SYSMENU = 0x00080000
WS_THICKFRAME = 0x00040000
WS_MAXIMIZEBOX = 0x00010000
WS_MINIMIZEBOX = 0x00020000
WM_NCCALCSIZE = 0x0083
WM_NCHITTEST = 0x0084
WM_WINDOWPOSCHANGED = 0x0047
HTCLIENT = 1
SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SW_SHOWMAXIMIZED = 3
MONITOR_DEFAULTTONEAREST = 2
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE

MIN_WIDTH, MIN_HEIGHT = 720, 480
DEFAULT_WIDTH, DEFAULT_HEIGHT = 1280, 800
MAX_WIDTH, MAX_HEIGHT = 1920, 1200
WINDOW_STATE_VERSION = 2
RESTORED_WINDOW_MARGIN = 32
WEBVIEW2_CLIENT_ID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
WEBVIEW2_DOWNLOAD_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"
WEBVIEW2_DISK_CACHE_BYTES = 64 * 1024 * 1024
WEBVIEW2_MEDIA_CACHE_BYTES = 32 * 1024 * 1024

_WNDPROC = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)(
    ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
)
_native_window_procs: dict[int, object] = {}
_corner_busy = False  # 重入保护：圆角相关的 SetWindowPos 会同步回灌 WM_WINDOWPOSCHANGED


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


class _NCCALCSIZE_PARAMS(ctypes.Structure):
    _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]


def _reassert_corners(hwnd: int) -> None:
    """让圆角常驻：清掉 WinForms 可能设的矩形 Region（会把 DWM 圆角裁成方角），
    再断言 ROUND。仅在【未最大化】时执行——最大化无圆角，且其动画期间频繁重断言
    会引发窗口抖动。重入保护避免被自身触发的 WM_WINDOWPOSCHANGED 回灌。"""
    global _corner_busy
    if _corner_busy:
        return
    try:
        if ctypes.windll.user32.IsZoomed(hwnd):
            return
        _corner_busy = True
        ctypes.windll.user32.SetWindowRgn(hwnd, None, False)
        pref = ctypes.c_int(2)  # ROUND
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ctypes.byref(pref), ctypes.sizeof(pref))
    except Exception:
        pass
    finally:
        _corner_busy = False


def _work_area(hwnd: int) -> wintypes.RECT | None:
    monitor = ctypes.windll.user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    if not ctypes.windll.user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return None
    return info.rcWork

WINDOW_STATE_FILE = app.DATA / "window-state.json"


# ── Win32 帮助函数 ──────────────────────────────────────────────

def _hwnd(window) -> int:
    handle = window.native.Handle
    return int(handle.ToInt64()) if hasattr(handle, "ToInt64") else int(handle)


def _get_window_long(hwnd: int, index: int) -> int:
    user32 = ctypes.windll.user32
    func = user32.GetWindowLongPtrW if ctypes.sizeof(ctypes.c_void_p) == 8 else user32.GetWindowLongW
    func.argtypes = [wintypes.HWND, ctypes.c_int]
    func.restype = ctypes.c_ssize_t
    return int(func(hwnd, index))


def _set_window_long(hwnd: int, index: int, value: int) -> int:
    user32 = ctypes.windll.user32
    func = user32.SetWindowLongPtrW if ctypes.sizeof(ctypes.c_void_p) == 8 else user32.SetWindowLongW
    func.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
    func.restype = ctypes.c_ssize_t
    return int(func(hwnd, index, value))


def _install_frameless(window) -> None:
    """让 WebView 客户区铺满整窗，同时保留系统窗口过渡和放置行为。"""
    if sys.platform != "win32":
        return
    hwnd = _hwnd(window)
    # 关键：保留 WS_CAPTION（标题栏样式）——视觉上被 WM_NCCALCSIZE 吃掉不显示，但 Windows
    # 凭它给窗口放原生最大化/最小化过渡动画。这是无边框窗口找回系统动画的标准手法。
    style = (_get_window_long(hwnd, GWL_STYLE)
             | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX)
    _set_window_long(hwnd, GWL_STYLE, style)
    if hwnd not in _native_window_procs:
        original = _get_window_long(hwnd, GWLP_WNDPROC)
        call_window_proc = ctypes.windll.user32.CallWindowProcW
        call_window_proc.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT,
                                     wintypes.WPARAM, wintypes.LPARAM]
        call_window_proc.restype = ctypes.c_ssize_t

        @_WNDPROC
        def proc(h, msg, wparam, lparam):
            if msg == WM_NCCALCSIZE and wparam:
                # 声明整个矩形为客户区 → 去掉系统非客户区（标题栏/边框），WebView 铺满。
                # 最大化时按显示器工作区裁剪，避免无边框最大化盖住任务栏。
                if ctypes.windll.user32.IsZoomed(int(h)):
                    rect = _work_area(int(h))
                    if rect is not None:
                        params = ctypes.cast(lparam, ctypes.POINTER(_NCCALCSIZE_PARAMS))
                        params.contents.rgrc[0] = rect
                return 0
            if msg == WM_NCHITTEST:
                # 禁用边缘缩放：把本会落在缩放边框上的命中（HTLEFT..HTBOTTOMRIGHT=10..17）
                # 改成客户区，原生拖边缩放彻底失效；最大化/移动/动画不受影响。
                res = call_window_proc(ctypes.c_void_p(original), h, msg, wparam, lparam)
                return HTCLIENT if 10 <= int(res) <= 17 else res
            result = call_window_proc(ctypes.c_void_p(original), h, msg, wparam, lparam)
            if msg == WM_WINDOWPOSCHANGED:
                # 尺寸/位置/层级/状态变化后，重新断言圆角，防止被 WinForms 的矩形 Region 裁方。
                _reassert_corners(int(h))
            return result

        _native_window_procs[hwnd] = proc  # 持有引用，避免被 GC
        _set_window_long(hwnd, GWLP_WNDPROC, ctypes.cast(proc, ctypes.c_void_p).value)
    # 重新应用边框样式
    ctypes.windll.user32.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                                      0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)


def _apply_corners(window, maximized: bool = False) -> None:
    """Windows 11 圆角 + 关闭 DWM 边框绘制；旧系统静默忽略。"""
    global _corner_busy
    if sys.platform != "win32" or _corner_busy:
        return
    try:
        _corner_busy = True
        hwnd = _hwnd(window)
        dwm = ctypes.windll.dwmapi
        pref = ctypes.c_int(1 if maximized else 2)  # 1=DONOTROUND, 2=ROUND
        dwm.DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                  ctypes.byref(pref), ctypes.sizeof(pref))
        none = ctypes.c_uint(DWMWA_COLOR_NONE)
        dwm.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ctypes.byref(none), ctypes.sizeof(none))
        # 仅在【圆角态】推一次 frame 重算 + 重绘，让圆角立即显形（否则 WebView2 合成层会盖住
        # 圆角，要等偶然重绘才变圆）。最大化态推动会与动画/工作区裁剪打架 → 抖动，故跳过。
        if not maximized:
            # SWP: NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|FRAMECHANGED
            ctypes.windll.user32.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                                              0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)
            ctypes.windll.user32.RedrawWindow(hwnd, None, None, 0x0001 | 0x0100)  # INVALIDATE|UPDATENOW
    except Exception:
        pass
    finally:
        _corner_busy = False


def _show_window(window, cmd: int) -> None:
    """走 Windows 原生 ShowWindow，触发系统最小化/最大化/还原的过渡动画。"""
    if sys.platform != "win32" or window is None:
        return
    ctypes.windll.user32.ShowWindow(_hwnd(window), cmd)


def _is_maximized(window) -> bool:
    if sys.platform != "win32" or window is None:
        return False
    return bool(ctypes.windll.user32.IsZoomed(_hwnd(window)))


# ── 窗口状态记忆（大小 / 位置 / 最大化） ────────────────────────

def _window_scale(window) -> float:
    """Return the logical-to-physical scale used by pywebview for this window."""
    if sys.platform != "win32" or window is None:
        return 1.0
    try:
        dpi = int(ctypes.windll.user32.GetDpiForWindow(_hwnd(window)))
        return dpi / 96.0 if dpi > 0 else 1.0
    except Exception:
        return 1.0


def _size_limits(window=None) -> dict:
    max_width, max_height = MAX_WIDTH, MAX_HEIGHT
    if window is not None:
        try:
            area = _work_area(_hwnd(window))
            scale = _window_scale(window)
            if area is not None:
                max_width = min(max_width, int((area.right - area.left) / scale) - RESTORED_WINDOW_MARGIN)
                max_height = min(max_height, int((area.bottom - area.top) / scale) - RESTORED_WINDOW_MARGIN)
        except Exception:
            pass
    return {
        "minWidth": MIN_WIDTH,
        "minHeight": MIN_HEIGHT,
        "maxWidth": max(MIN_WIDTH, max_width),
        "maxHeight": max(MIN_HEIGHT, max_height),
    }


def _clamp_size(width: int, height: int, window=None) -> tuple[int, int]:
    limits = _size_limits(window)
    return (
        max(limits["minWidth"], min(limits["maxWidth"], int(width))),
        max(limits["minHeight"], min(limits["maxHeight"], int(height))),
    )


def _fit_restored_window(window, width: int, height: int) -> tuple[int, int]:
    """按当前显示器约束还原尺寸，并把窗口拉回最近显示器的工作区。"""
    width, height = _clamp_size(width, height, window)
    window.resize(width, height)
    if sys.platform != "win32":
        return width, height
    try:
        hwnd = _hwnd(window)
        area = _work_area(hwnd)
        rect = wintypes.RECT()
        if area is None or not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return width, height
        window_width = rect.right - rect.left
        window_height = rect.bottom - rect.top
        left = max(area.left, min(rect.left, area.right - window_width))
        top = max(area.top, min(rect.top, area.bottom - window_height))
        if left != rect.left or top != rect.top:
            # SWP: NOSIZE|NOZORDER|NOACTIVATE
            ctypes.windll.user32.SetWindowPos(hwnd, None, left, top, 0, 0, 0x0001 | 0x0004 | 0x0010)
    except Exception:
        pass
    return width, height


class _WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT),
        ("ptMinPosition", wintypes.POINT), ("ptMaxPosition", wintypes.POINT),
        ("rcNormalPosition", wintypes.RECT),
    ]


def _read_window_state() -> dict | None:
    try:
        data = json.loads(WINDOW_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("version") != WINDOW_STATE_VERSION:
        return None
    return data


def _save_window_state(
    window, maximized_hint: bool, restored_size: tuple[int, int] | None = None,
) -> None:
    """用 GetWindowPlacement 取"还原后"的矩形，这样即便当前是最大化也记下正常尺寸。"""
    if sys.platform != "win32":
        return
    try:
        hwnd = _hwnd(window)
        wp = _WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(_WINDOWPLACEMENT)
        if not ctypes.windll.user32.GetWindowPlacement(hwnd, ctypes.byref(wp)):
            return
        r = wp.rcNormalPosition
        scale = _window_scale(window)
        width, height = restored_size or (
            int(round((r.right - r.left) / scale)),
            int(round((r.bottom - r.top) / scale)),
        )
        width, height = _clamp_size(width, height, window)
        state = {
            "version": WINDOW_STATE_VERSION,
            "x": int(round(r.left / scale)), "y": int(round(r.top / scale)),
            "width": width,
            "height": height,
            "maximized": bool(maximized_hint or wp.showCmd == SW_SHOWMAXIMIZED),
        }
        WINDOW_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = WINDOW_STATE_FILE.with_name(
            f".{WINDOW_STATE_FILE.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, WINDOW_STATE_FILE)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    except Exception:
        pass


def _apply_webview_cache_limits() -> None:
    """给 Chromium 缓存设置温和上限，不碰登录态、localStorage 或用户数据。"""
    key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
    current = os.environ.get(key, "").strip()
    additions = (
        f"--disk-cache-size={WEBVIEW2_DISK_CACHE_BYTES}",
        f"--media-cache-size={WEBVIEW2_MEDIA_CACHE_BYTES}",
    )
    missing = [arg for arg in additions if arg.split("=", 1)[0] not in current]
    if missing:
        os.environ[key] = " ".join(part for part in (current, *missing) if part)


# ── 前端可调用的窗口能力（契约与既有 desktop-shell.js 一致） ──

class DesktopBridge:
    def __init__(
        self, restored_width: int = DEFAULT_WIDTH, restored_height: int = DEFAULT_HEIGHT,
    ) -> None:
        self._window = None
        self.restored_width = restored_width
        self.restored_height = restored_height
        self.maximized = False
        self.dirty = False
        self.wallpaper: WallpaperController | None = None
        self._lock = threading.Lock()

    def set_dirty(self, value: bool) -> None:
        with self._lock:
            self.dirty = bool(value)

    def minimize(self) -> None:
        # 走原生 ShowWindow，保留最小化到任务栏的过渡动画。
        _show_window(self._window, SW_MINIMIZE)

    def get_window_state(self) -> dict:
        return {"maximized": self.maximized}

    def get_restored_size(self) -> dict:
        width, height = _clamp_size(
            self.restored_width,
            self.restored_height,
            self._window,
        )
        self.restored_width, self.restored_height = width, height
        return {"width": width, "height": height, "limits": _size_limits(self._window)}

    def set_restored_size(self, width: int, height: int) -> dict:
        width, height = _clamp_size(width, height, self._window)
        if self._window is None:
            self.restored_width, self.restored_height = width, height
            return {"width": width, "height": height, "limits": _size_limits()}
        try:
            if _is_maximized(self._window):
                _show_window(self._window, SW_RESTORE)
                self.maximized = False
            # pywebview converts logical pixels to the monitor's physical pixels.
            width, height = _fit_restored_window(self._window, width, height)
            self.restored_width, self.restored_height = width, height
            _apply_corners(self._window, maximized=False)
            _save_window_state(self._window, False, (width, height))
        except Exception:
            pass
        return {"width": width, "height": height, "limits": _size_limits(self._window)}

    def toggle_maximize(self) -> dict:
        if self._window is None:
            return {"maximized": False}
        try:
            target = not self.maximized
            # 原生 ShowWindow 触发系统最大化/还原的过渡动画。
            _show_window(self._window, SW_MAXIMIZE if target else SW_RESTORE)
            self.maximized = _is_maximized(self._window)
            _apply_corners(self._window, maximized=self.maximized)
        except Exception:
            pass
        return {"maximized": self.maximized}

    def close_window(self) -> None:
        if self._window is not None:
            self._window.destroy()

    def get_countdown_wallpaper_state(self) -> dict:
        if self.wallpaper is None:
            return {
                "ok": True, "supported": False, "active": False,
                "eventId": "", "error": "当前桌面运行时不支持动态背景。",
            }
        return self.wallpaper.state()

    def start_countdown_wallpaper(self, event_id: str, language: str = "zh-CN") -> dict:
        if self.wallpaper is None:
            return {
                "ok": False, "supported": False, "active": False,
                "eventId": "", "error": "当前桌面运行时不支持动态背景。",
            }
        wanted = str(event_id or "").strip()
        countdown = app.load_countdown()
        event = next(
            (item for item in countdown.get("events", [])
             if isinstance(item, dict) and str(item.get("id") or "") == wanted),
            None,
        )
        if event is None:
            return {
                **self.wallpaper.state(), "ok": False,
                "error": "找不到要设为桌面背景的倒数事件。",
            }
        return self.wallpaper.start(wanted, str(event.get("event") or ""), language)

    def stop_countdown_wallpaper(self) -> dict:
        if self.wallpaper is None:
            return self.get_countdown_wallpaper_state()
        return self.wallpaper.stop()

    def update_countdown_wallpaper_event(self, event_id: str, title: str) -> None:
        if self.wallpaper is not None:
            self.wallpaper.update_event(event_id, title)

    def countdown_wallpaper_event_missing(self, event_id: str) -> None:
        if self.wallpaper is not None:
            # Destroying the calling WebView inside its bridge invocation can
            # deadlock WinForms.  Defer the teardown to a separate thread.
            threading.Thread(
                target=self.wallpaper.event_missing,
                args=(event_id,),
                name="relatum-wallpaper-missing",
                daemon=True,
            ).start()


def _message_box(text: str, flags: int = 0x40) -> int:
    if sys.platform == "win32":
        return int(ctypes.windll.user32.MessageBoxW(None, text, "Relatum", flags))
    return 1


def _webview2_runtime_available() -> bool:
    """检测 Evergreen WebView2 Runtime；固定运行时可通过环境变量显式指定。"""
    if sys.platform != "win32" or os.environ.get("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"):
        return True
    try:
        import winreg
        paths = (
            rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}",
            rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}",
        )
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for path in paths:
                try:
                    with winreg.OpenKey(root, path) as key:
                        version = str(winreg.QueryValueEx(key, "pv")[0] or "").strip()
                    if version and version != "0.0.0.0":
                        return True
                except OSError:
                    continue
    except Exception:
        return False
    return False


def _open_url(port: int, initial_file: Path | None) -> str:
    import urllib.parse
    base = f"http://127.0.0.1:{port}/"
    if initial_file is None:
        return base + "index.html?desktop=1"
    return base + "editor.html?desktop=1&file=" + urllib.parse.quote(str(initial_file))


def _wallpaper_url(port: int, event_id: str, language: str) -> str:
    import urllib.parse
    return (f"http://127.0.0.1:{port}/countdown.html?wallpaper=1&event="
            + urllib.parse.quote(str(event_id or ""), safe="")
            + "&lang=" + ("en" if language == "en" else "zh-CN"))


def _wallpaper_child_command(pipe_name: str, authkey_hex: str, url: str) -> list[str]:
    args = [
        "--countdown-wallpaper-child",
        "--wallpaper-pipe", pipe_name,
        "--wallpaper-auth", authkey_hex,
        "--wallpaper-url", url,
    ]
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, str(Path(__file__).resolve()), *args]


def _run_wallpaper_child_from_args() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--countdown-wallpaper-child", action="store_true")
    parser.add_argument("--wallpaper-pipe", required=True)
    parser.add_argument("--wallpaper-auth", required=True)
    parser.add_argument("--wallpaper-url", required=True)
    args = parser.parse_args()
    if not args.wallpaper_url.startswith("http://127.0.0.1:"):
        return 2
    return run_wallpaper_child(
        args.wallpaper_pipe, args.wallpaper_auth, args.wallpaper_url,
    )


def main() -> int:
    if "--countdown-wallpaper-child" in sys.argv[1:]:
        return _run_wallpaper_child_from_args()
    # 透传纯服务模式给 app.py（供调试 / 外部调用）。
    if any(arg in {"--no-browser", "--port", "--allow-dir"} for arg in sys.argv[1:]):
        return app.main()

    parser = argparse.ArgumentParser(description="Relatum 桌面客户端")
    parser.add_argument("file", nargs="?", default=None, help="要直接打开的 .canvas 文件路径")
    args = parser.parse_args()

    if webview is None:
        _message_box("桌面窗口组件未安装，无法启动 Relatum。")
        return 1
    if not _webview2_runtime_available():
        _message_box(
            "此电脑尚未安装 Microsoft Edge WebView2 Runtime，Relatum 无法打开。\n\n"
            "请安装 Evergreen WebView2 Runtime 后重试：\n"
            f"{WEBVIEW2_DOWNLOAD_URL}",
            0x30,
        )
        return 1

    app.ensure_dirs()
    initial_file = app.resolve_initial_file(args.file)
    if initial_file is not None:
        app.register_recent(initial_file)

    # 先起本地服务，拿到端口。
    try:
        port = app.find_free_port(app.DEFAULT_PORT)
        server = app.CanvasServer(("127.0.0.1", port), app.Handler)
    except Exception as err:
        _message_box(f"Relatum 启动失败：\n{err}", 0x10)
        return 1
    # selector 会在请求到达时立即唤醒；poll_interval 只影响 shutdown 检查。
    # 沿用标准库的温和间隔，减少桌面窗口空闲时无意义的后台唤醒。
    server_thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.5},
        name="canvas-local-server",
        daemon=True,
    )
    server_thread.start()
    server_stop_lock = threading.Lock()
    server_stopped = False

    def stop_server() -> None:
        nonlocal server_stopped
        with server_stop_lock:
            if server_stopped:
                return
            server_stopped = True
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass
        if server_thread is not threading.current_thread():
            server_thread.join(timeout=1.0)

    # 恢复上次的窗口大小 / 位置。
    saved = _read_window_state() or {}
    width, height = _clamp_size(
        int(saved.get("width") or DEFAULT_WIDTH),
        int(saved.get("height") or DEFAULT_HEIGHT),
    )
    pos = {}
    if isinstance(saved.get("x"), int) and isinstance(saved.get("y"), int):
        pos = {"x": saved["x"], "y": saved["y"]}
    start_maximized = bool(saved.get("maximized"))

    bridge = DesktopBridge(width, height)
    try:
        window = webview.create_window(
            "Relatum",
            url=_open_url(port, initial_file),
            js_api=bridge,
            width=width, height=height,
            min_size=(MIN_WIDTH, MIN_HEIGHT),
            resizable=True, frameless=True, easy_drag=False,
            shadow=True, background_color="#fbfbfa", text_select=True,
            **pos,
        )
    except Exception as err:
        stop_server()
        _message_box(f"桌面窗口创建失败：\n{err}", 0x10)
        return 1
    bridge._window = window
    lifecycle_lock = threading.RLock()
    lifecycle = {"quitting": False}

    def show_main_window() -> None:
        try:
            window.show()
            if sys.platform == "win32":
                hwnd = _hwnd(window)
                if ctypes.windll.user32.IsIconic(hwnd):
                    ctypes.windll.user32.ShowWindow(hwnd, SW_RESTORE)
                ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception:
            pass

    def confirm_discard_changes() -> bool:
        with bridge._lock:
            dirty = bridge.dirty
        if not dirty:
            return True
        result = _message_box(
            "当前画布还有未保存的修改。\n\n确定关闭窗口并放弃这些修改吗？",
            0x131,  # MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2
        )
        return result != 2

    def request_quit_from_tray() -> None:
        with lifecycle_lock:
            if lifecycle["quitting"]:
                return
        with bridge._lock:
            dirty = bridge.dirty
        if dirty:
            show_main_window()
            if not confirm_discard_changes():
                return
        with lifecycle_lock:
            lifecycle["quitting"] = True
        if bridge.wallpaper is not None:
            bridge.wallpaper.stop()
        try:
            window.destroy()
        except Exception:
            stop_server()

    def wallpaper_fatal_error(message: str) -> None:
        show_main_window()
        _message_box(message, 0x30)

    bridge.wallpaper = WallpaperController(
        root=app.ROOT,
        icon_path=app.ASSETS / "app-icon.ico",
        url_builder=lambda event_id, language: _wallpaper_url(port, event_id, language),
        child_command_builder=_wallpaper_child_command,
        show_main=show_main_window,
        request_quit=request_quit_from_tray,
        fatal_error=wallpaper_fatal_error,
    )

    def on_shown() -> None:
        _install_frameless(window)
        if start_maximized:
            _show_window(window, SW_MAXIMIZE)
            bridge.maximized = _is_maximized(window)
        else:
            bridge.restored_width, bridge.restored_height = _fit_restored_window(
                window, bridge.restored_width, bridge.restored_height,
            )
        _apply_corners(window, maximized=bridge.maximized)

    def on_loaded() -> None:
        # 页面加载完成、WebView2 完成首次绘制后再补一次圆角，确保立即显形。
        _apply_corners(window, maximized=bridge.maximized)

    def on_maximized() -> None:
        bridge.maximized = True
        _apply_corners(window, maximized=True)

    def on_restored() -> None:
        bridge.maximized = False
        _apply_corners(window, maximized=False)

    def confirm_close() -> bool | None:
        # 先记住窗口状态，再处理后台隐藏或未保存提示。
        _save_window_state(
            window, bridge.maximized, (bridge.restored_width, bridge.restored_height),
        )
        with lifecycle_lock:
            quitting = lifecycle["quitting"]
        wallpaper_active = bool(bridge.wallpaper and bridge.wallpaper.state().get("active"))
        if wallpaper_active and not quitting:
            # 动态背景仍运行时，关闭主窗只是收进托盘。DOM 和 dirty 状态
            # 都留在内存中，因此不需要也不应该询问是否放弃修改。
            try:
                window.hide()
            except Exception:
                pass
            return False
        if quitting:
            return None
        return None if confirm_discard_changes() else False

    window.events.shown += on_shown
    window.events.loaded += on_loaded
    window.events.maximized += on_maximized
    window.events.restored += on_restored
    window.events.closing += confirm_close
    window.events.closed += stop_server

    try:
        local = os.environ.get("LOCALAPPDATA")
        if app.PACKAGED:
            storage = app.ROOT / "WebView2"
        else:
            storage = (Path(local) / "Canvas" / "WebView2") if local else (app.DATA / "webview")
        storage.mkdir(parents=True, exist_ok=True)
        _apply_webview_cache_limits()
        icon = app.ASSETS / "app-icon.ico"
        webview.start(
            gui="edgechromium", private_mode=False, storage_path=str(storage),
            icon=str(icon) if icon.is_file() else None,
        )
    except Exception as err:
        _message_box(f"桌面窗口打开失败：\n{err}", 0x10)
        return 1
    finally:
        # closed 事件通常已先执行；finally 兜底覆盖启动失败或事件未触发。
        if bridge.wallpaper is not None:
            bridge.wallpaper.stop()
        stop_server()
    return 0


if __name__ == "__main__":
    sys.exit(main())

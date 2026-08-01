"""Windows animated wallpaper hosting for the Relatum desktop client.

The main Relatum process owns the tray icon and lifecycle.  The actual
WebView2 wallpaper runs in a second process launched from the same executable.
Keeping Explorer parenting out of the main WinForms process prevents the
wallpaper host from disturbing the normal Relatum window input loop.
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from ctypes import wintypes
from multiprocessing.connection import Client, Connection, Listener
from pathlib import Path
from typing import Callable

try:
    import pystray
    from PIL import Image
except ImportError:  # Source/browser mode can keep running without tray support.
    pystray = None
    Image = None


GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CHILD = 0x40000000
WS_POPUP = 0x80000000
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_SYSMENU = 0x00080000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_EX_NOACTIVATE = 0x08000000
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
MONITOR_DEFAULTTOPRIMARY = 1
ERROR_ALREADY_EXISTS = 183
HWND_BOTTOM = 1
SMTO_NORMAL = 0
CREATE_NO_WINDOW = 0x08000000
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

_ENUM_WINDOWS_PROC = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)(
    wintypes.BOOL, wintypes.HWND, wintypes.LPARAM,
)


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _window_handle(window) -> int:
    handle = window.native.Handle
    return int(handle.ToInt64()) if hasattr(handle, "ToInt64") else int(handle)


def _show_webview_without_activation(window) -> None:
    """Show a hidden WinForms form without pywebview's forced Activate()."""
    form = getattr(window, "native", None)
    show = getattr(form, "Show", None)
    if form is None or not callable(show):
        raise RuntimeError("动态背景窗口尚未就绪。")

    def show_form():
        form.Show()

    if bool(getattr(form, "InvokeRequired", False)):
        from System import Action
        form.Invoke(Action(show_form))
    else:
        show_form()


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


def _user32():
    """Return user32 with pointer-sized signatures declared for 64-bit Windows."""
    user32 = ctypes.windll.user32
    user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND,
                                     ctypes.c_wchar_p, ctypes.c_wchar_p]
    user32.FindWindowExW.restype = wintypes.HWND
    user32.EnumWindows.argtypes = [_ENUM_WINDOWS_PROC, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT,
                                           wintypes.WPARAM, wintypes.LPARAM,
                                           wintypes.UINT, wintypes.UINT,
                                           ctypes.POINTER(ctypes.c_size_t)]
    user32.SendMessageTimeoutW.restype = wintypes.LPARAM
    user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
    user32.MonitorFromPoint.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MONITORINFO)]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.GetParent.argtypes = [wintypes.HWND]
    user32.GetParent.restype = wintypes.HWND
    user32.SetParent.argtypes = [wintypes.HWND, wintypes.HWND]
    user32.SetParent.restype = wintypes.HWND
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.SetWindowPos.restype = wintypes.BOOL
    return user32


@contextmanager
def _physical_dpi_context():
    previous = None
    if sys.platform == "win32":
        try:
            set_context = ctypes.windll.user32.SetThreadDpiAwarenessContext
            set_context.argtypes = [ctypes.c_void_p]
            set_context.restype = ctypes.c_void_p
            previous = set_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        except Exception:
            previous = None
    try:
        yield
    finally:
        if previous:
            try:
                ctypes.windll.user32.SetThreadDpiAwarenessContext(previous)
            except Exception:
                pass


def _primary_monitor_rect() -> tuple[int, int, int, int] | None:
    if sys.platform != "win32":
        return None
    with _physical_dpi_context():
        user32 = _user32()
        monitor = user32.MonitorFromPoint(wintypes.POINT(0, 0), MONITOR_DEFAULTTOPRIMARY)
        if not monitor:
            return None
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return None
        rect = info.rcMonitor
        return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def _rect_for_window(hwnd: int) -> tuple[int, int, int, int] | None:
    rect = wintypes.RECT()
    if not _user32().GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def _window_process_id(hwnd: int) -> int:
    process_id = wintypes.DWORD()
    _user32().GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    return int(process_id.value)


def _covers_primary_monitor(hwnd: int, monitor: tuple[int, int, int, int]) -> bool:
    rect = _rect_for_window(hwnd)
    if rect is None:
        return False
    left, top, right, bottom = rect
    ml, mt, mr, mb = monitor
    tolerance = 4
    return (left <= ml + tolerance and top <= mt + tolerance
            and right >= mr - tolerance and bottom >= mb - tolerance)


def _find_desktop_host(create: bool = True) -> int:
    """Return Explorer's dedicated wallpaper WorkerW sibling.

    The icon list's ``SHELLDLL_DefView`` is deliberately not a valid target: it
    paints the static wallpaper itself and therefore hides children placed under
    ``SysListView32``.  The usable host is the top-level WorkerW immediately
    following the window that owns ``SHELLDLL_DefView``.
    """
    if sys.platform != "win32":
        return 0
    user32 = _user32()
    progman = int(user32.FindWindowW("Progman", None) or 0)
    monitor = _primary_monitor_rect()
    if not progman or monitor is None:
        return 0

    if create:
        result = ctypes.c_size_t()
        user32.SendMessageTimeoutW(
            progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, ctypes.byref(result),
        )

    found = {"worker": 0}

    @_ENUM_WINDOWS_PROC
    def enum_window(hwnd, _lparam):
        owner = int(hwnd or 0)
        def_view = int(user32.FindWindowExW(owner, None, "SHELLDLL_DefView", None) or 0)
        if not def_view:
            return True
        worker = int(user32.FindWindowExW(None, owner, "WorkerW", None) or 0)
        if (worker and _window_process_id(worker) == _window_process_id(owner)
                and _covers_primary_monitor(worker, monitor)):
            found["worker"] = worker
            return False
        return True

    user32.EnumWindows(enum_window, 0)
    if found["worker"]:
        return found["worker"]

    # Some Explorer layouts create the wallpaper WorkerW as a direct Progman
    # child.  Accept only that exact, full-desktop, same-process fallback.
    worker = int(user32.FindWindowExW(progman, None, "WorkerW", None) or 0)
    if (worker and _window_process_id(worker) == _window_process_id(progman)
            and _covers_primary_monitor(worker, monitor)):
        return worker
    return 0


def _attach_to_desktop(hwnd: int, *, create_host: bool = True) -> tuple[int, tuple[int, int, int, int]]:
    if sys.platform != "win32":
        raise RuntimeError("动态桌面背景仅支持 Windows。")
    with _physical_dpi_context():
        user32 = _user32()
        if not hwnd or not user32.IsWindow(hwnd):
            raise RuntimeError("动态背景窗口尚未就绪。")
        worker = _find_desktop_host(create=create_host)
        if not worker or not user32.IsWindow(worker):
            raise RuntimeError("无法创建 Windows 动态壁纸宿主（WorkerW）。")
        monitor = _primary_monitor_rect()
        parent_rect = _rect_for_window(worker)
        if monitor is None or parent_rect is None:
            raise RuntimeError("无法读取 Windows 桌面宿主尺寸。")

        left, top, right, bottom = monitor
        parent_left, parent_top, _parent_right, _parent_bottom = parent_rect
        x = left - parent_left
        y = top - parent_top
        width = max(1, right - left)
        height = max(1, bottom - top)

        style = _get_window_long(hwnd, GWL_STYLE) | WS_CHILD
        style &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU |
                   WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
        exstyle = _get_window_long(hwnd, GWL_EXSTYLE)
        exstyle = (exstyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)
        exstyle &= ~WS_EX_APPWINDOW
        user32.ShowWindow(hwnd, SW_HIDE)
        _set_window_long(hwnd, GWL_STYLE, style)
        _set_window_long(hwnd, GWL_EXSTYLE, exstyle)

        kernel32 = ctypes.windll.kernel32
        kernel32.SetLastError(0)
        user32.SetParent(hwnd, worker)
        if int(user32.GetParent(hwnd) or 0) != worker:
            code = int(kernel32.GetLastError() or 87)
            raise RuntimeError(f"连接 Windows 动态壁纸宿主失败：{ctypes.WinError(code)}")
        kernel32.SetLastError(0)
        if not user32.SetWindowPos(
            hwnd, HWND_BOTTOM, x, y, width, height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        ):
            code = int(kernel32.GetLastError() or 87)
            raise RuntimeError(f"设置动态背景尺寸失败：{ctypes.WinError(code)}")
        user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
        return worker, monitor


def _send_connection(connection: Connection, lock: threading.Lock, message: dict) -> None:
    with lock:
        connection.send(message)


def _wallpaper_child_environment() -> dict[str, str]:
    """Keep WebView2 debug ports owned by the main process out of the child."""
    environment = os.environ.copy()
    extra = environment.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    if extra:
        filtered = [
            item for item in extra.split()
            if not item.lower().startswith("--remote-debugging-port")
        ]
        if filtered:
            environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(filtered)
        else:
            environment.pop("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", None)
    return environment


class _WallpaperChildBridge:
    def __init__(self, connection: Connection, send_lock: threading.Lock) -> None:
        self.connection = connection
        self.send_lock = send_lock

    def update_countdown_wallpaper_event(self, event_id: str, title: str) -> None:
        try:
            _send_connection(self.connection, self.send_lock, {
                "type": "event", "eventId": str(event_id or ""),
                "title": str(title or "")[:80],
            })
        except Exception:
            pass

    def countdown_wallpaper_event_missing(self, event_id: str) -> None:
        try:
            _send_connection(self.connection, self.send_lock, {
                "type": "missing", "eventId": str(event_id or ""),
            })
        except Exception:
            pass


def run_wallpaper_child(pipe_name: str, authkey_hex: str, url: str) -> int:
    """Run the isolated WebView2 wallpaper process."""
    if sys.platform != "win32":
        return 2
    try:
        import webview
        authkey = bytes.fromhex(authkey_hex)
        connection = Client(pipe_name, family="AF_PIPE", authkey=authkey)
    except Exception:
        return 3

    send_lock = threading.Lock()
    bridge = _WallpaperChildBridge(connection, send_lock)
    stop_event = threading.Event()
    attached = threading.Event()
    state_lock = threading.RLock()
    state = {"window": None, "hwnd": 0, "worker": 0, "monitor": None}

    try:
        window = webview.create_window(
            "Relatum Countdown Wallpaper",
            url=url,
            js_api=bridge,
            width=800,
            height=600,
            resizable=False,
            frameless=True,
            easy_drag=False,
            shadow=False,
            hidden=True,
            focus=False,
            background_color="#0d100f",
            text_select=False,
            zoomable=False,
        )
        state["window"] = window
    except Exception as err:
        try:
            _send_connection(connection, send_lock, {"type": "error", "error": str(err)})
        except Exception:
            pass
        connection.close()
        return 4

    def stop_window() -> None:
        stop_event.set()
        target = state.get("window")
        if target is not None:
            try:
                target.destroy()
            except Exception:
                pass

    def command_loop() -> None:
        try:
            while not stop_event.is_set():
                message = connection.recv()
                if not isinstance(message, dict):
                    continue
                action = message.get("type")
                if action == "stop":
                    stop_window()
                    return
                if action == "load":
                    next_url = str(message.get("url") or "")
                    if next_url.startswith("http://127.0.0.1:"):
                        try:
                            window.load_url(next_url)
                        except Exception:
                            pass
        except (EOFError, OSError):
            stop_window()

    def attach_loaded_window() -> None:
        if attached.is_set() or stop_event.is_set():
            return
        last_error = ""
        for attempt in range(20):
            try:
                hwnd = _window_handle(window)
                worker, monitor = _attach_to_desktop(hwnd, create_host=(attempt == 0))
                _show_webview_without_activation(window)
                worker, monitor = _attach_to_desktop(hwnd, create_host=False)
                with state_lock:
                    state.update(hwnd=hwnd, worker=worker, monitor=monitor)
                attached.set()
                _send_connection(connection, send_lock, {"type": "ready"})
                return
            except Exception as err:
                last_error = str(err)
                time.sleep(0.15)
        try:
            _send_connection(connection, send_lock, {
                "type": "error", "error": last_error or "无法连接 Windows 动态壁纸宿主。",
            })
        except Exception:
            pass
        stop_window()

    def on_loaded() -> None:
        if attached.is_set():
            return
        threading.Thread(
            target=attach_loaded_window, name="relatum-wallpaper-attach", daemon=True,
        ).start()

    def watchdog() -> None:
        failures = 0
        while not stop_event.wait(2.0):
            if not attached.is_set():
                continue
            with state_lock:
                hwnd = int(state.get("hwnd") or 0)
                worker = int(state.get("worker") or 0)
                monitor = state.get("monitor")
            try:
                user32 = _user32()
                current_monitor = _primary_monitor_rect()
                valid = bool(hwnd and worker and user32.IsWindow(hwnd) and user32.IsWindow(worker)
                             and int(user32.GetParent(hwnd) or 0) == worker)
                if not valid or current_monitor != monitor:
                    new_worker, new_monitor = _attach_to_desktop(hwnd, create_host=True)
                    with state_lock:
                        state.update(worker=new_worker, monitor=new_monitor)
                failures = 0
            except Exception:
                failures += 1
                if failures < 5:
                    continue
                try:
                    _send_connection(connection, send_lock, {
                        "type": "fatal",
                        "error": "Windows 桌面宿主已重启，Relatum 无法恢复动态背景。",
                    })
                except Exception:
                    pass
                stop_window()
                return

    window.events.loaded += on_loaded
    threading.Thread(target=command_loop, name="relatum-wallpaper-command", daemon=True).start()
    threading.Thread(target=watchdog, name="relatum-wallpaper-watchdog", daemon=True).start()

    cache_dir = Path(tempfile.mkdtemp(prefix="RelatumWallpaperWebView2-"))
    try:
        webview.start(
            gui="edgechromium", private_mode=True, storage_path=str(cache_dir),
        )
    except Exception as err:
        try:
            _send_connection(connection, send_lock, {"type": "error", "error": str(err)})
        except Exception:
            pass
        return 5
    finally:
        stop_event.set()
        try:
            connection.close()
        except Exception:
            pass
        shutil.rmtree(cache_dir, ignore_errors=True)
    return 0


class WallpaperController:
    """Own the isolated wallpaper process, IPC channel and tray icon."""

    def __init__(
        self,
        *,
        root: Path,
        icon_path: Path,
        url_builder: Callable[[str, str], str],
        child_command_builder: Callable[[str, str, str], list[str]],
        show_main: Callable[[], None],
        request_quit: Callable[[], None],
        fatal_error: Callable[[str], None],
    ) -> None:
        self.root = Path(root)
        self.icon_path = Path(icon_path)
        self.url_builder = url_builder
        self.child_command_builder = child_command_builder
        self.show_main = show_main
        self.request_quit = request_quit
        self.fatal_error = fatal_error
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._connection: Connection | None = None
        self._listener: Listener | None = None
        self._reader_thread: threading.Thread | None = None
        self._mutex = None
        self._tray = None
        self._tray_thread = None
        self._ready: threading.Event | None = None
        self._start_error = ""
        self._starting = False
        self._stopping = False
        self._active = False
        self._event_id = ""
        self._event_title = ""
        self._language = "zh-CN"

    def state(self) -> dict:
        with self._lock:
            supported = sys.platform == "win32" and pystray is not None and Image is not None
            alive = self._process is not None and self._process.poll() is None
            active = bool(self._active and alive)
            return {
                "ok": True,
                "supported": supported,
                "active": active,
                "eventId": self._event_id if active else "",
                "error": "" if supported else "当前桌面运行时缺少动态背景组件。",
            }

    def _mutex_name(self) -> str:
        key = hashlib.sha256(os.fsencode(os.path.normcase(str(self.root.resolve())))).hexdigest()[:24]
        return f"Local\\RelatumWallpaper-{key}"

    def _acquire_mutex(self) -> bool:
        if sys.platform != "win32":
            return False
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.SetLastError(0)
        handle = kernel32.CreateMutexW(None, False, self._mutex_name())
        if not handle:
            return False
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        self._mutex = handle
        return True

    def _release_mutex(self) -> None:
        handle, self._mutex = self._mutex, None
        if handle:
            try:
                ctypes.windll.kernel32.CloseHandle(handle)
            except Exception:
                pass

    def start(self, event_id: str, event_title: str, language: str) -> dict:
        event_id = str(event_id or "").strip()[:120]
        if not event_id:
            return {**self.state(), "ok": False, "error": "请选择一个倒数事件。"}
        next_language = "en" if language == "en" else "zh-CN"
        next_url = self.url_builder(event_id, next_language)
        with self._lock:
            if sys.platform != "win32" or pystray is None or Image is None:
                return {**self.state(), "ok": False, "error": "当前桌面运行时不支持动态背景。"}
            if self._active and self._process is not None and self._process.poll() is None:
                connection = self._connection
                if connection is None:
                    return {**self.state(), "ok": False, "error": "动态背景通信已断开。"}
                try:
                    _send_connection(connection, self._send_lock, {"type": "load", "url": next_url})
                except Exception as err:
                    return {**self.state(), "ok": False, "error": f"切换动态背景失败：{err}"}
                self._event_id = event_id
                self._event_title = str(event_title or "")[:80]
                self._language = next_language
                self._refresh_tray_menu()
                return self.state()
            if self._starting:
                return {**self.state(), "ok": False, "error": "动态背景正在启动，请稍候。"}
            if not self._acquire_mutex():
                return {**self.state(), "ok": False,
                        "error": "另一 Relatum 实例正在使用动态桌面背景。"}
            self._starting = True
            self._stopping = False
            self._event_id = event_id
            self._event_title = str(event_title or "")[:80]
            self._language = next_language
            self._start_error = ""
            self._ready = threading.Event()

        authkey = secrets.token_bytes(24)
        pipe_name = rf"\\.\pipe\RelatumWallpaper-{uuid.uuid4().hex}"
        try:
            listener = Listener(pipe_name, family="AF_PIPE", authkey=authkey)
            command = self.child_command_builder(pipe_name, authkey.hex(), next_url)
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                close_fds=True,
                env=_wallpaper_child_environment(),
            )
            with self._lock:
                self._listener = listener
                self._process = process
            reader = threading.Thread(
                target=self._channel_loop,
                args=(listener,),
                name="relatum-wallpaper-ipc",
                daemon=True,
            )
            self._reader_thread = reader
            reader.start()
        except Exception as err:
            self._fail_start(f"启动动态背景子进程失败：{err}")
            return {**self.state(), "ok": False, "error": self._start_error}

        ready = self._ready
        if ready is None or not ready.wait(timeout=12.0):
            self._fail_start("动态背景窗口启动超时。")
        with self._lock:
            active = self._active
            error = self._start_error or "动态背景启动失败。"
        if not active:
            self._fail_start(error)
            return {**self.state(), "ok": False, "error": error}
        return self.state()

    def _channel_loop(self, listener: Listener) -> None:
        unexpected_error = ""
        try:
            connection = listener.accept()
            with self._lock:
                self._connection = connection
                if self._listener is listener:
                    self._listener = None
            listener.close()
            while True:
                message = connection.recv()
                if not isinstance(message, dict):
                    continue
                message_type = message.get("type")
                if message_type == "ready":
                    try:
                        self._start_tray()
                    except Exception as err:
                        with self._lock:
                            self._start_error = str(err)
                            ready = self._ready
                        if ready:
                            ready.set()
                        try:
                            _send_connection(connection, self._send_lock, {"type": "stop"})
                        except Exception:
                            pass
                        return
                    with self._lock:
                        if self._stopping:
                            return
                        self._active = True
                        self._starting = False
                        ready = self._ready
                    if ready:
                        ready.set()
                elif message_type == "event":
                    self.update_event(str(message.get("eventId") or ""),
                                      str(message.get("title") or ""))
                elif message_type == "missing":
                    threading.Thread(
                        target=self.event_missing,
                        args=(str(message.get("eventId") or ""),),
                        name="relatum-wallpaper-missing",
                        daemon=True,
                    ).start()
                elif message_type in {"error", "fatal"}:
                    unexpected_error = str(message.get("error") or "动态背景子进程异常退出。")
                    with self._lock:
                        self._start_error = unexpected_error
                        ready = self._ready
                    if ready:
                        ready.set()
                    break
        except (EOFError, OSError) as err:
            unexpected_error = str(err)
        finally:
            try:
                listener.close()
            except Exception:
                pass
            with self._lock:
                was_expected = self._stopping
                was_active = self._active
                if self._starting and not self._start_error:
                    self._start_error = unexpected_error or "动态背景子进程未能启动。"
                ready = self._ready
            if ready:
                ready.set()
            if not was_expected and was_active:
                threading.Thread(
                    target=self._handle_unexpected_exit,
                    args=(unexpected_error or "动态背景子进程已退出。",),
                    name="relatum-wallpaper-failure",
                    daemon=True,
                ).start()

    def _handle_unexpected_exit(self, error: str) -> None:
        self.stop()
        self.show_main()
        self.fatal_error(error)

    def _fail_start(self, error: str) -> None:
        with self._lock:
            self._start_error = str(error)
            ready = self._ready
        self.stop(preserve_error=True)
        if ready:
            ready.set()

    def update_event(self, event_id: str, event_title: str) -> None:
        with self._lock:
            if not self._active or self._event_id != str(event_id or ""):
                return
            title = str(event_title or "")[:80]
            if title == self._event_title:
                return
            self._event_title = title
        self._refresh_tray_menu()

    def event_missing(self, event_id: str) -> None:
        with self._lock:
            if not self._active or self._event_id != str(event_id or ""):
                return
        self.stop()
        self.show_main()

    def stop(self, *, preserve_error: bool = False) -> dict:
        with self._lock:
            self._stopping = True
            connection, self._connection = self._connection, None
            listener, self._listener = self._listener, None
            process, self._process = self._process, None
            reader, self._reader_thread = self._reader_thread, None
            self._active = False
            self._starting = False
            self._event_id = ""
            self._event_title = ""
            ready = self._ready
            self._ready = None
            if not preserve_error:
                self._start_error = ""
        self._stop_tray()
        if connection is not None:
            try:
                _send_connection(connection, self._send_lock, {"type": "stop"})
            except Exception:
                pass
        if listener is not None:
            try:
                listener.close()
            except Exception:
                pass
        if process is not None:
            try:
                process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                try:
                    process.terminate()
                    process.wait(timeout=1.5)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=1.0)
        self._release_mutex()
        if ready:
            ready.set()
        with self._lock:
            self._stopping = False
        return self.state()

    def _tray_text(self, zh: str, en: str) -> str:
        return en if self._language == "en" else zh

    def _start_tray(self) -> None:
        if pystray is None or Image is None:
            raise RuntimeError("当前桌面运行时缺少托盘组件。")
        try:
            image = Image.open(self.icon_path).convert("RGBA")
        except Exception as err:
            raise RuntimeError(f"无法加载 Relatum 托盘图标：{err}") from err
        menu = pystray.Menu(
            pystray.MenuItem(
                lambda _item: self._tray_text("打开 Relatum", "Open Relatum"),
                lambda _icon, _item: self.show_main(),
                default=True,
            ),
            pystray.MenuItem(lambda _item: self._event_title or "Relatum", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                lambda _item: self._tray_text("取消桌面背景", "Stop Desktop Wallpaper"),
                lambda _icon, _item: self._tray_stop(),
            ),
            pystray.MenuItem(
                lambda _item: self._tray_text("退出 Relatum", "Exit Relatum"),
                lambda _icon, _item: self.request_quit(),
            ),
        )
        tray = pystray.Icon("Relatum", image, "Relatum", menu)
        with self._lock:
            self._tray = tray
        thread = threading.Thread(target=tray.run, name="relatum-tray", daemon=True)
        self._tray_thread = thread
        thread.start()

    def _refresh_tray_menu(self) -> None:
        with self._lock:
            tray = self._tray
        if tray is not None:
            try:
                tray.update_menu()
            except Exception:
                pass

    def _stop_tray(self) -> None:
        with self._lock:
            tray, self._tray = self._tray, None
        if tray is not None:
            try:
                tray.stop()
            except Exception:
                pass

    def _tray_stop(self) -> None:
        self.stop()
        self.show_main()

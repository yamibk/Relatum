"""Event-driven placement memory for independent Markdown windows only."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import logging
from pathlib import Path
import threading
import time


DEFAULT_SIZE = (1040, 780)
MIN_SIZE = (520, 400)
log = logging.getLogger(__name__)


def read_state(path):
    try:
        with Path(path).open(encoding='utf-8') as stream:
            value = json.loads(stream.read(16384))
        if not isinstance(value, dict) or value.get('version') != 1:
            return None
        if any(type(value.get(key)) is not int for key in ('x', 'y', 'width', 'height', 'updatedNs')):
            return None
        if not (0 < value['width'] <= 32768 and 0 < value['height'] <= 32768
                and abs(value['x']) < 10000000 and abs(value['y']) < 10000000
                and value['updatedNs'] >= 0 and type(value.get('maximized')) is bool):
            return None
        return value
    except (OSError, ValueError, TypeError):
        return None


def fit_placement(saved, work, scale, initial):
    """Return a screen-coordinate physical rectangle, keeping logical size."""
    left, top, right, bottom = work
    available_width, available_height = max(1, right - left), max(1, bottom - top)
    width, height = (saved['width'], saved['height']) if saved else DEFAULT_SIZE
    width = min(available_width, round(max(MIN_SIZE[0], width) * scale))
    height = min(available_height, round(max(MIN_SIZE[1], height) * scale))
    x, y = (saved['x'], saved['y']) if saved else initial[:2]
    return (max(left, min(x, right - width)), max(top, min(y, bottom - height)), width, height)


class _MonitorInfo(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('monitor', wintypes.RECT),
                ('work', wintypes.RECT), ('flags', wintypes.DWORD)]


def _monitor(rect):
    user = ctypes.windll.user32
    query = user.MonitorFromRect
    query.argtypes = [ctypes.POINTER(wintypes.RECT), wintypes.DWORD]
    query.restype = wintypes.HANDLE
    handle = query(ctypes.byref(rect), 2)  # nearest remaining monitor
    info = _MonitorInfo()
    info.cbSize = ctypes.sizeof(info)
    get_info = user.GetMonitorInfoW
    get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MonitorInfo)]
    get_info.restype = wintypes.BOOL
    if not get_info(handle, ctypes.byref(info)):
        raise OSError('Cannot read monitor work area')
    return handle, info


def restore_placement(shell, window, saved):
    """Run in before_show: fit native bounds before the first visible frame."""
    user, hwnd = ctypes.windll.user32, shell._hwnd(window)
    initial = wintypes.RECT()
    if not user.GetWindowRect(hwnd, ctypes.byref(initial)):
        return
    target = (wintypes.RECT(saved['x'], saved['y'], saved['x'] + 1, saved['y'] + 1)
              if saved else initial)
    handle, info = _monitor(target)
    scale = shell._window_scale(window)
    try:
        factor = ctypes.c_int()
        query = ctypes.windll.shcore.GetScaleFactorForMonitor
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_int)]
        query.restype = ctypes.c_long
        if query(handle, ctypes.byref(factor)) == 0 and 50 <= factor.value <= 800:
            scale = factor.value / 100
    except (AttributeError, OSError):
        pass
    work = info.work
    x, y, width, height = fit_placement(saved, (work.left, work.top, work.right, work.bottom),
                                       scale, (initial.left, initial.top))
    # SetWindowPos takes screen coordinates. WINDOWPLACEMENT takes workspace
    # coordinates; capture below converts them explicitly (including top taskbars).
    user.SetWindowPos(hwnd, None, x, y, width, height, 0x0004 | 0x0010)
    if saved and saved['maximized']:
        from System.Windows.Forms import FormWindowState
        window.native.WindowState = FormWindowState.Maximized


def capture_placement(shell, window):
    user, hwnd = ctypes.windll.user32, shell._hwnd(window)
    if user.IsIconic(hwnd):
        return None
    placement = shell._WINDOWPLACEMENT()
    placement.length = ctypes.sizeof(placement)
    if not user.GetWindowPlacement(hwnd, ctypes.byref(placement)):
        return None
    normal = placement.rcNormalPosition
    _, info = _monitor(normal)
    scale = shell._window_scale(window)
    return {'version': 1, 'x': normal.left + info.work.left - info.monitor.left,
            'y': normal.top + info.work.top - info.monitor.top,
            'width': round((normal.right - normal.left) / scale),
            'height': round((normal.bottom - normal.top) / scale),
            'maximized': bool(user.IsZoomed(hwnd))}


class WindowState:
    def __init__(self, path, capture, *, clock=time.time_ns, timer=threading.Timer):
        self.path, self.capture = Path(path), capture
        self.clock, self.timer_factory = clock, timer
        self.lock = threading.RLock()
        self.current = self.pending = self.timer = None
        self.started = self.closed = False
        self.last_stamp = 0

    def start(self):
        with self.lock:
            if self.started:
                return
            self.current = self.capture()
            self.started = True

    def changed(self, *args):
        with self.lock:
            if not self.started or self.closed:
                return
            value = self.capture()
            if value is None or value == self.current:
                return
            self.current = value
            self.last_stamp = max(self.clock(), self.last_stamp + 1)
            self.pending = {**value, 'updatedNs': self.last_stamp}
            if self.timer:
                self.timer.cancel()
            task = self.timer_factory(.4, lambda: self.flush(task))
            self.timer = task
            self.timer.daemon = True
            self.timer.start()

    def flush(self, expected=None):
        from app import _atomic_write_json, _cross_process_mutation_lock
        with self.lock:
            if expected is not None and self.timer is not expected:
                return
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if self.pending is None:
                return
            try:
                with _cross_process_mutation_lock():
                    saved = read_state(self.path)
                    # Compare event times, not close/write order across processes.
                    if not saved or saved['updatedNs'] < self.pending['updatedNs']:
                        self.path.parent.mkdir(parents=True, exist_ok=True)
                        _atomic_write_json(self.path, self.pending)
                self.pending = None
            except OSError:
                log.warning('Cannot save Markdown window placement', exc_info=True)

    def stop(self):
        with self.lock:
            self.closed = True
            self.flush()

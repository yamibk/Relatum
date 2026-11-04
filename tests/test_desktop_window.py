"""Native geometry rules; all persistence uses disposable data."""
import ctypes
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import desktop


class DesktopWindowTests(unittest.TestCase):
    def test_large_monitor_limits_have_no_fixed_cap_or_margin(self):
        window = object()
        with patch.object(desktop, '_hwnd', return_value=1), patch.object(desktop, '_window_scale', return_value=1.5), patch.object(desktop, '_work_area', return_value=desktop.wintypes.RECT(-3840, 0, 0, 2160)):
            self.assertEqual(desktop._size_limits(window), dict(minWidth=720, minHeight=480, maxWidth=2560, maxHeight=1440))
            self.assertEqual(desktop._clamp_size(5000, 3000, window), (2560, 1440))
            self.assertEqual(desktop._clamp_size(10, 20, window), (720, 480))
        self.assertEqual(desktop._clamp_size(2400, 1400), (2400, 1400), 'pre-HWND startup must preserve a large saved size')

    def test_v2_save_reads_native_restore_rect_even_when_maximized(self):
        user = Mock()
        def placement(hwnd, pointer):
            value = pointer._obj
            value.rcNormalPosition = desktop.wintypes.RECT(-3300, 150, -225, 2025)
            value.showCmd = desktop.SW_SHOWMAXIMIZED
            return 1
        user.GetWindowPlacement.side_effect = placement
        with tempfile.TemporaryDirectory(prefix='relatum-window-state-') as folder, patch.object(ctypes, 'windll', SimpleNamespace(user32=user)), patch.object(desktop, '_hwnd', return_value=1), patch.object(desktop, '_window_scale', return_value=1.5), patch.object(desktop, '_size_limits', return_value=dict(minWidth=720, minHeight=480, maxWidth=2560, maxHeight=1440)), patch.object(desktop, 'WINDOW_STATE_FILE', Path(folder) / 'window-state.json'):
            bridge = desktop.DesktopBridge(900, 600)
            bridge._window = Mock()
            result = bridge._sync_window_size(persist=True)
            self.assertEqual((result['width'], result['height']), (2050, 1250))
            saved = desktop._read_window_state()
            self.assertEqual(saved, dict(version=2, x=-2200, y=100, width=2050, height=1250, maximized=True))
            self.assertEqual(len(list(Path(folder).iterdir())), 1)
            self.assertEqual(json.loads(desktop.WINDOW_STATE_FILE.read_text())['version'], 2)

    def test_resize_failure_propagates_and_cannot_publish_requested_size(self):
        bridge = desktop.DesktopBridge(900, 600)
        bridge._window = Mock()
        with patch.object(desktop, '_is_maximized', return_value=False), patch.object(desktop, '_fit_restored_window', side_effect=OSError('resize failed')), patch.object(desktop, '_save_window_state') as save:
            with self.assertRaises(OSError):
                bridge.set_restored_size(1000, 700)
            self.assertEqual((bridge.restored_width, bridge.restored_height), (900, 600))
            save.assert_not_called()

    def test_display_changes_coalesce_and_close_cancels_pending_work(self):
        tasks = []
        class Timer:
            def __init__(self, delay, fn):
                self.fn, self.cancelled = fn, False
                tasks.append(self)
            def start(self):
                pass
            def cancel(self):
                self.cancelled = True
        bridge = desktop.DesktopBridge()
        with patch.object(desktop.threading, 'Timer', Timer), patch.object(bridge, '_sync_window_size') as sync:
            bridge._queue_window_size_sync()
            bridge._queue_window_size_sync()
            self.assertTrue(tasks[0].cancelled)
            tasks[0].fn()
            sync.assert_not_called()
            tasks[1].fn()
            sync.assert_called_once_with(persist=True, notify=True)
            bridge._queue_window_size_sync()
            bridge._close_window_geometry()
            tasks[2].fn()
            self.assertTrue(tasks[2].cancelled)
            self.assertIsNone(bridge._geometry_timer)
            self.assertEqual(sync.call_count, 1)


if __name__ == '__main__':
    unittest.main()

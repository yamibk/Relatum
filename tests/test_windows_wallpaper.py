from __future__ import annotations

import queue
import os
import unittest
from pathlib import Path
from unittest import mock

import windows_wallpaper


class _FakeConnection:
    def __init__(self, messages=None):
        self.messages = queue.Queue()
        for message in messages or []:
            self.messages.put(message)
        self.sent = []
        self.closed = False

    def recv(self):
        item = self.messages.get(timeout=2)
        if isinstance(item, BaseException):
            raise item
        return item

    def send(self, message):
        self.sent.append(message)

    def close(self):
        self.closed = True
        self.messages.put(EOFError())


class _FakeListener:
    def __init__(self, connection):
        self.connection = connection
        self.closed = False

    def accept(self):
        return self.connection

    def close(self):
        self.closed = True


class _FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def terminate(self):
        self.terminated = True
        self.returncode = 1

    def kill(self):
        self.returncode = 1


class _DesktopUser32:
    def __init__(self):
        self.sent_create = 0

    def FindWindowW(self, class_name, _title):
        return 10 if class_name == "Progman" else 0

    def FindWindowExW(self, parent, after, class_name, _title):
        if int(parent or 0) == 10 and class_name == "SHELLDLL_DefView":
            return 20
        if not parent and int(after or 0) == 10 and class_name == "WorkerW":
            return 30
        return 0

    def EnumWindows(self, callback, lparam):
        callback(10, lparam)
        return True

    def SendMessageTimeoutW(self, *_args):
        self.sent_create += 1
        return 1

    def GetWindowRect(self, hwnd, rect_ptr):
        rect = rect_ptr._obj
        rect.left = 0
        rect.top = 0
        rect.right = 1920
        rect.bottom = 1080
        return True

    def GetWindowThreadProcessId(self, _hwnd, process_ptr):
        process_ptr._obj.value = 77
        return 1


class _ValidUser32:
    @staticmethod
    def IsWindow(_hwnd):
        return True


class WallpaperControllerTests(unittest.TestCase):
    def make_controller(self):
        shown = []
        controller = windows_wallpaper.WallpaperController(
            root=Path.cwd(),
            icon_path=Path("missing.ico"),
            url_builder=lambda event_id, language: (
                "http://127.0.0.1:8765/countdown?event=" + event_id + "&lang=" + language
            ),
            child_command_builder=lambda pipe, auth, url: ["Relatum.exe", pipe, auth, url],
            show_main=lambda: shown.append(True),
            request_quit=lambda: None,
            fatal_error=lambda _message: None,
        )
        return controller, shown

    def start_with_channel(self, controller, connection):
        listener = _FakeListener(connection)
        process = _FakeProcess()
        patches = (
            mock.patch.object(windows_wallpaper.sys, "platform", "win32"),
            mock.patch.object(windows_wallpaper, "pystray", object()),
            mock.patch.object(windows_wallpaper, "Image", object()),
            mock.patch.object(controller, "_acquire_mutex", return_value=True),
            mock.patch.object(controller, "_release_mutex"),
            mock.patch.object(controller, "_start_tray"),
            mock.patch.object(controller, "_stop_tray"),
            mock.patch.object(windows_wallpaper, "Listener", return_value=listener),
            mock.patch.object(windows_wallpaper.subprocess, "Popen", return_value=process),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return listener, process

    def test_start_switch_and_stop_are_idempotent(self):
        controller, _shown = self.make_controller()
        connection = _FakeConnection([{"type": "ready"}])
        _listener, process = self.start_with_channel(controller, connection)

        started = controller.start("event-a", "A", "zh-CN")
        self.assertTrue(started["ok"])
        self.assertTrue(started["active"])
        self.assertEqual(started["eventId"], "event-a")

        switched = controller.start("event-b", "B", "en")
        self.assertTrue(switched["active"])
        self.assertEqual(switched["eventId"], "event-b")
        self.assertEqual(connection.sent[-1]["type"], "load")
        self.assertIn("event=event-b", connection.sent[-1]["url"])

        stopped = controller.stop()
        self.assertFalse(stopped["active"])
        self.assertEqual(process.returncode, 0)
        self.assertTrue(connection.closed)
        self.assertFalse(controller.stop()["active"])

    def test_child_attach_error_cleans_up_process(self):
        controller, _shown = self.make_controller()
        connection = _FakeConnection([{"type": "error", "error": "no WorkerW"}])
        _listener, process = self.start_with_channel(controller, connection)

        result = controller.start("event-a", "A", "zh-CN")
        self.assertFalse(result["ok"])
        self.assertFalse(result["active"])
        self.assertIn("no WorkerW", result["error"])
        self.assertEqual(process.returncode, 0)

    def test_strict_workerw_sibling_is_selected(self):
        user32 = _DesktopUser32()
        with mock.patch.object(windows_wallpaper.sys, "platform", "win32"), \
                mock.patch.object(windows_wallpaper, "_user32", return_value=user32), \
                mock.patch.object(windows_wallpaper, "_primary_monitor_rect",
                                  return_value=(0, 0, 1920, 1080)):
            self.assertEqual(windows_wallpaper._find_desktop_host(), 30)
        self.assertEqual(user32.sent_create, 1)

    def test_defview_is_never_accepted_as_wallpaper_host(self):
        user32 = _DesktopUser32()
        original = user32.FindWindowExW

        def no_worker(parent, after, class_name, title):
            if class_name == "WorkerW":
                return 0
            return original(parent, after, class_name, title)

        user32.FindWindowExW = no_worker
        with mock.patch.object(windows_wallpaper.sys, "platform", "win32"), \
                mock.patch.object(windows_wallpaper, "_user32", return_value=user32), \
                mock.patch.object(windows_wallpaper, "_primary_monitor_rect",
                                  return_value=(0, 0, 1920, 1080)):
            self.assertEqual(windows_wallpaper._find_desktop_host(), 0)

    def test_missing_worker_is_reported_before_window_mutation(self):
        with mock.patch.object(windows_wallpaper.sys, "platform", "win32"), \
                mock.patch.object(windows_wallpaper, "_user32", return_value=_ValidUser32()), \
                mock.patch.object(windows_wallpaper, "_find_desktop_host", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "WorkerW"):
                windows_wallpaper._attach_to_desktop(101)

    def test_missing_bound_event_stops_and_restores_main_window(self):
        controller, shown = self.make_controller()
        controller._active = True
        controller._event_id = "event-a"
        controller._process = _FakeProcess()
        with mock.patch.object(controller, "stop") as stop:
            controller.event_missing("another")
            stop.assert_not_called()
            controller.event_missing("event-a")
            stop.assert_called_once()
        self.assertEqual(shown, [True])

    def test_child_environment_drops_main_webview_debug_port(self):
        with mock.patch.dict(os.environ, {
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS":
                "--remote-debugging-port=9332 --disable-features=Example",
        }, clear=False):
            environment = windows_wallpaper._wallpaper_child_environment()
        self.assertNotIn("remote-debugging-port",
                         environment.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ""))
        self.assertIn("--disable-features=Example",
                      environment.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ""))


if __name__ == "__main__":
    unittest.main()

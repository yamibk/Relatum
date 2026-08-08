from __future__ import annotations

import json
import os
import queue
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import desktop
import desktop_instance


class _PipeEndpoint:
    def __init__(self, incoming, outgoing):
        self.incoming = incoming
        self.outgoing = outgoing
        self.closed = False

    def send(self, message):
        self.outgoing.put(message)

    def recv(self):
        item = self.incoming.get(timeout=2)
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self):
        self.closed = True


class _PipeListener:
    def __init__(self, hub, address, authkey):
        self.hub = hub
        self.address = address
        self.authkey = authkey
        self.connections = queue.Queue()
        self.closed = False

    def accept(self):
        item = self.connections.get(timeout=2)
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self):
        if not self.closed:
            self.closed = True
            self.connections.put(OSError("closed"))


class _PipeHub:
    def __init__(self):
        self.listeners = {}

    def listener(self, address, *, family, authkey):
        self.assert_family(family)
        listener = _PipeListener(self, address, authkey)
        self.listeners[address] = listener
        return listener

    def client(self, address, *, family, authkey):
        self.assert_family(family)
        listener = self.listeners.get(address)
        if listener is None or listener.closed or listener.authkey != authkey:
            raise OSError("pipe unavailable")
        client_in = queue.Queue()
        server_in = queue.Queue()
        client = _PipeEndpoint(client_in, server_in)
        server = _PipeEndpoint(server_in, client_in)
        listener.connections.put(server)
        return client

    @staticmethod
    def assert_family(family):
        if family != "AF_PIPE":
            raise AssertionError(family)


class _FakeKernel32:
    def __init__(self):
        self.last_error = 0
        self.next_handle = 100
        self.handles = {}
        self.counts = {}

    def SetLastError(self, value):
        self.last_error = int(value)

    def GetLastError(self):
        return self.last_error

    def CreateMutexW(self, _security, _owner, name):
        self.next_handle += 1
        handle = self.next_handle
        self.last_error = desktop_instance.ERROR_ALREADY_EXISTS if self.counts.get(name) else 0
        self.counts[name] = self.counts.get(name, 0) + 1
        self.handles[handle] = name
        return handle

    def CloseHandle(self, handle):
        name = self.handles.pop(handle, None)
        if name is not None:
            self.counts[name] -= 1
            if self.counts[name] <= 0:
                self.counts.pop(name, None)
        return True


class _FakeUser32:
    def __init__(self):
        self.allowed = []

    def AllowSetForegroundWindow(self, pid):
        self.allowed.append(int(pid))
        return True


class DesktopInstanceCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.temp_path = Path(self.temp.name)
        self.kernel = _FakeKernel32()
        self.user = _FakeUser32()
        self.hub = _PipeHub()
        self.platform_patch = mock.patch.object(desktop_instance.sys, "platform", "win32")
        self.platform_patch.start()
        self.addCleanup(self.platform_patch.stop)

    def coordinator(self, root, handler, **kwargs):
        return desktop_instance.DesktopInstanceCoordinator(
            root,
            handler,
            temp_dir=self.temp_path,
            listener_factory=self.hub.listener,
            client_factory=kwargs.pop("client_factory", self.hub.client),
            kernel32=self.kernel,
            user32=self.user,
            forward_timeout=kwargs.pop("forward_timeout", 0.3),
            retry_interval=kwargs.pop("retry_interval", 0.01),
            **kwargs,
        )

    def test_secondary_forwards_to_primary_and_cleanup_allows_restart(self):
        commands = []
        root = self.temp_path / "runtime"
        primary = self.coordinator(
            root,
            lambda command: commands.append(command) or {"ok": True, "status": "activated"},
        )
        self.addCleanup(primary.close)
        self.assertTrue(primary.acquire_or_forward(None)["primary"])
        self.assertTrue(primary.state_path.is_file())

        secondary = self.coordinator(root, lambda _command: {})
        result = secondary.acquire_or_forward(Path("sample.canvas"))
        self.assertFalse(result["primary"])
        self.assertEqual(result["status"], "activated")
        self.assertEqual(commands[-1], {"type": "activate", "file": "sample.canvas"})
        self.assertEqual(self.user.allowed[-1], os.getpid())

        primary.close()
        self.assertFalse(primary.state_path.exists())
        replacement = self.coordinator(root, lambda _command: {})
        self.addCleanup(replacement.close)
        self.assertTrue(replacement.acquire_or_forward(None)["primary"])

    def test_different_data_roots_have_independent_primaries(self):
        first = self.coordinator(self.temp_path / "a", lambda _command: {})
        second = self.coordinator(self.temp_path / "b", lambda _command: {})
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        self.assertTrue(first.acquire_or_forward(None)["primary"])
        self.assertTrue(second.acquire_or_forward(None)["primary"])
        self.assertNotEqual(first.root_key, second.root_key)

    def test_secondary_retries_while_primary_finishes_starting(self):
        primary = self.coordinator(
            self.temp_path / "runtime",
            lambda _command: {"ok": True, "status": "queued"},
        )
        self.addCleanup(primary.close)
        self.assertTrue(primary.acquire_or_forward(None)["primary"])
        attempts = []

        def flaky_client(*args, **kwargs):
            attempts.append(True)
            if len(attempts) < 3:
                raise OSError("not ready")
            return self.hub.client(*args, **kwargs)

        secondary = self.coordinator(
            self.temp_path / "runtime", lambda _command: {}, client_factory=flaky_client,
        )
        result = secondary.acquire_or_forward(None)
        self.assertFalse(result["primary"])
        self.assertEqual(result["status"], "queued")
        self.assertGreaterEqual(len(attempts), 3)

    def test_invalid_state_times_out_without_starting_duplicate(self):
        root = self.temp_path / "runtime"
        mutex_name = f"Local\\RelatumMain-{desktop_instance.instance_root_key(root)}"
        self.kernel.CreateMutexW(None, False, mutex_name)
        state_path = desktop_instance.instance_state_path(root, self.temp_path)
        state_path.write_text("not json", encoding="utf-8")
        clock = [0.0]

        def monotonic():
            return clock[0]

        def sleep(seconds):
            clock[0] += seconds

        secondary = self.coordinator(
            root, lambda _command: {}, monotonic=monotonic, sleep=sleep,
            forward_timeout=0.05, retry_interval=0.01,
        )
        result = secondary.acquire_or_forward(None)
        self.assertFalse(result["primary"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "unavailable")

    def test_cleanup_does_not_delete_newer_owner_state(self):
        primary = self.coordinator(self.temp_path / "runtime", lambda _command: {})
        self.assertTrue(primary.acquire_or_forward(None)["primary"])
        state = json.loads(primary.state_path.read_text(encoding="utf-8"))
        state["token"] = "new-owner"
        primary.state_path.write_text(json.dumps(state), encoding="utf-8")
        primary.close()
        self.assertTrue(primary.state_path.exists())


class _FakeWindow:
    def __init__(self, url="http://127.0.0.1:8765/index.html?desktop=1"):
        self.url = url
        self.loaded = []

    def get_current_url(self):
        return self.url

    def load_url(self, url):
        self.url = url
        self.loaded.append(url)


class DesktopActivationRouterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.first = self.root / "first.canvas"
        self.second = self.root / "second.canvas"
        self.first.write_text("{}", encoding="utf-8")
        self.second.write_text("{}", encoding="utf-8")

    def attached_router(self, current=None, dirty=False):
        current_url = "http://127.0.0.1:8765/index.html?desktop=1"
        if current is not None:
            current_url = (
                "http://127.0.0.1:8765/editor.html?desktop=1&file="
                + urllib.parse.quote(str(current))
            )
        window = _FakeWindow(current_url)
        bridge = desktop.DesktopBridge()
        bridge.dirty = dirty
        shown = []
        router = desktop.DesktopActivationRouter()
        router.attach(window, bridge, 8765, lambda: shown.append(True))
        router.mark_ready()
        return router, window, bridge, shown

    def test_no_file_only_activates_existing_window(self):
        router, window, _bridge, shown = self.attached_router()
        result = router.handle({"file": ""})
        self.assertEqual(result["status"], "activated")
        self.assertEqual(shown, [True])
        self.assertEqual(window.loaded, [])

    def test_same_dirty_canvas_is_activated_without_reload(self):
        router, window, _bridge, shown = self.attached_router(self.first, dirty=True)
        result = router.handle({"file": str(self.first)})
        self.assertEqual(result["status"], "activated")
        self.assertEqual(shown, [True])
        self.assertEqual(window.loaded, [])

    def test_different_canvas_is_blocked_while_dirty(self):
        router, window, _bridge, shown = self.attached_router(self.first, dirty=True)
        with mock.patch.object(desktop.app, "register_recent") as register:
            result = router.handle({"file": str(self.second)})
        self.assertEqual(result["status"], "blocked-dirty")
        self.assertEqual(shown, [True])
        self.assertEqual(window.loaded, [])
        register.assert_not_called()

    def test_clean_window_opens_requested_canvas(self):
        router, window, _bridge, shown = self.attached_router(self.first, dirty=False)
        with mock.patch.object(desktop.app, "register_recent") as register:
            result = router.handle({"file": str(self.second)})
        self.assertEqual(result["status"], "opened")
        self.assertEqual(shown, [True])
        register.assert_called_once_with(self.second.resolve())
        self.assertEqual(len(window.loaded), 1)
        self.assertIn(urllib.parse.quote(str(self.second.resolve())), window.loaded[0])

    def test_invalid_file_is_rejected(self):
        router, window, _bridge, shown = self.attached_router()
        result = router.handle({"file": str(self.root / "missing.canvas")})
        self.assertEqual(result["status"], "invalid-file")
        self.assertFalse(result["ok"])
        self.assertEqual(shown, [])
        self.assertEqual(window.loaded, [])

    def test_last_startup_command_is_applied_when_window_becomes_ready(self):
        router = desktop.DesktopActivationRouter()
        self.assertEqual(router.handle({"file": str(self.first)})["status"], "queued")
        self.assertEqual(router.handle({"file": str(self.second)})["status"], "queued")
        window = _FakeWindow()
        bridge = desktop.DesktopBridge()
        shown = []
        router.attach(window, bridge, 8765, lambda: shown.append(True))
        with mock.patch.object(desktop.app, "register_recent") as register:
            router.mark_ready()
        register.assert_called_once_with(self.second.resolve())
        self.assertEqual(len(window.loaded), 1)
        self.assertEqual(shown, [True])


class DesktopEntryBypassTests(unittest.TestCase):
    def test_wallpaper_child_bypasses_main_instance_coordinator(self):
        with mock.patch.object(desktop.sys, "argv", ["desktop.py", "--countdown-wallpaper-child"]), \
                mock.patch.object(desktop, "_run_wallpaper_child_from_args", return_value=7), \
                mock.patch.object(desktop, "DesktopInstanceCoordinator") as coordinator:
            self.assertEqual(desktop.main(), 7)
        coordinator.assert_not_called()

    def test_service_mode_bypasses_main_instance_coordinator(self):
        with mock.patch.object(desktop.sys, "argv", ["desktop.py", "--no-browser"]), \
                mock.patch.object(desktop.app, "main", return_value=9), \
                mock.patch.object(desktop, "DesktopInstanceCoordinator") as coordinator:
            self.assertEqual(desktop.main(), 9)
        coordinator.assert_not_called()


if __name__ == "__main__":
    unittest.main()

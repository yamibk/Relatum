"""Windows desktop single-instance coordination for Relatum.

The desktop shell stays single-instance per writable Relatum data root.  A
short-lived secondary process forwards one narrowly-scoped activation command
through an authenticated local named pipe, then exits.  Browser/server debug
mode and the wallpaper child deliberately bypass this module.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import secrets
import sys
import tempfile
import threading
import time
import uuid
from multiprocessing.connection import Client, Listener
from pathlib import Path
from typing import Callable


PROTOCOL_VERSION = 1
ERROR_ALREADY_EXISTS = 183
DEFAULT_FORWARD_TIMEOUT = 4.0
DEFAULT_RETRY_INTERVAL = 0.1


def instance_root_key(root: Path) -> str:
    normalized = os.path.normcase(str(Path(root).resolve()))
    return hashlib.sha256(os.fsencode(normalized)).hexdigest()[:24]


def instance_state_path(root: Path, temp_dir: Path | None = None) -> Path:
    base = Path(temp_dir) if temp_dir is not None else Path(tempfile.gettempdir())
    return base / f"relatum-desktop-{instance_root_key(root)}.json"


class DesktopInstanceCoordinator:
    """Own the primary-instance mutex and authenticated activation pipe."""

    def __init__(
        self,
        root: Path,
        command_handler: Callable[[dict], dict],
        *,
        temp_dir: Path | None = None,
        listener_factory=Listener,
        client_factory=Client,
        kernel32=None,
        user32=None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        forward_timeout: float = DEFAULT_FORWARD_TIMEOUT,
        retry_interval: float = DEFAULT_RETRY_INTERVAL,
    ) -> None:
        self.root = Path(root).resolve()
        self.root_key = instance_root_key(self.root)
        self.command_handler = command_handler
        self.state_path = instance_state_path(self.root, temp_dir)
        self.listener_factory = listener_factory
        self.client_factory = client_factory
        self.kernel32 = kernel32
        self.user32 = user32
        self.monotonic = monotonic
        self.sleep = sleep
        self.forward_timeout = max(0.1, float(forward_timeout))
        self.retry_interval = max(0.01, float(retry_interval))

        self._mutex = None
        self._listener = None
        self._listener_thread: threading.Thread | None = None
        self._pipe_name = ""
        self._authkey = b""
        self._token = ""
        self._stop_event = threading.Event()
        self._close_lock = threading.Lock()
        self._closed = False

    def acquire_or_forward(self, file_path: Path | None) -> dict:
        """Become primary, or forward activation to the existing primary."""
        if sys.platform != "win32":
            return {"primary": True, "ok": True, "status": "unsupported"}

        kernel32 = self.kernel32 or ctypes.windll.kernel32
        self._configure_kernel32(kernel32)
        kernel32.SetLastError(0)
        handle = kernel32.CreateMutexW(
            None, False, f"Local\\RelatumMain-{self.root_key}",
        )
        if not handle:
            raise OSError("无法创建 Relatum 单实例互斥锁")
        already_exists = int(kernel32.GetLastError()) == ERROR_ALREADY_EXISTS
        if already_exists:
            kernel32.CloseHandle(handle)
            command = {
                "type": "activate",
                "file": str(file_path) if file_path is not None else "",
            }
            return {"primary": False, **self._forward(command)}

        self._mutex = handle
        try:
            self._start_listener()
        except Exception:
            self.close()
            raise
        return {"primary": True, "ok": True, "status": "primary"}

    @staticmethod
    def _configure_kernel32(kernel32) -> None:
        signatures = (
            ("CreateMutexW", [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p], ctypes.c_void_p),
            ("CloseHandle", [ctypes.c_void_p], ctypes.c_bool),
            ("SetLastError", [ctypes.c_uint32], None),
            ("GetLastError", [], ctypes.c_uint32),
        )
        for name, argtypes, restype in signatures:
            function = getattr(kernel32, name)
            try:
                function.argtypes = argtypes
                function.restype = restype
            except (AttributeError, TypeError):
                pass

    def _start_listener(self) -> None:
        self._authkey = secrets.token_bytes(32)
        self._token = uuid.uuid4().hex
        self._pipe_name = rf"\\.\pipe\RelatumMain-{self.root_key}-{uuid.uuid4().hex}"
        listener = self.listener_factory(
            self._pipe_name, family="AF_PIPE", authkey=self._authkey,
        )
        self._listener = listener
        self._write_state({
            "version": PROTOCOL_VERSION,
            "rootKey": self.root_key,
            "pid": os.getpid(),
            "pipe": self._pipe_name,
            "auth": self._authkey.hex(),
            "token": self._token,
        })
        thread = threading.Thread(
            target=self._listener_loop,
            args=(listener,),
            name="relatum-desktop-instance-ipc",
            daemon=True,
        )
        self._listener_thread = thread
        thread.start()

    def _write_state(self, state: dict) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_path.with_name(
            f".{self.state_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, self.state_path)
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass

    def _read_state(self) -> dict | None:
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(state, dict):
            return None
        if state.get("version") != PROTOCOL_VERSION or state.get("rootKey") != self.root_key:
            return None
        pipe = state.get("pipe")
        auth = state.get("auth")
        pid = state.get("pid")
        if not isinstance(pipe, str) or not pipe.startswith(r"\\.\pipe\RelatumMain-"):
            return None
        if not isinstance(auth, str) or len(auth) != 64:
            return None
        if not isinstance(pid, int) or pid <= 0:
            return None
        try:
            bytes.fromhex(auth)
        except ValueError:
            return None
        return state

    def _forward(self, command: dict) -> dict:
        deadline = self.monotonic() + self.forward_timeout
        last_error = ""
        while True:
            state = self._read_state()
            if state is not None:
                connection = None
                try:
                    self._allow_primary_foreground(state["pid"])
                    connection = self.client_factory(
                        state["pipe"], family="AF_PIPE", authkey=bytes.fromhex(state["auth"]),
                    )
                    connection.send(command)
                    response = connection.recv()
                    if isinstance(response, dict):
                        return response
                    last_error = "主实例返回了无效响应"
                except (EOFError, OSError, ValueError) as err:
                    last_error = str(err)
                finally:
                    if connection is not None:
                        try:
                            connection.close()
                        except Exception:
                            pass
            if self.monotonic() >= deadline:
                return {
                    "ok": False,
                    "status": "unavailable",
                    "error": last_error or "主实例尚未准备好",
                }
            self.sleep(self.retry_interval)

    def _allow_primary_foreground(self, pid: int) -> None:
        """Transfer the user's foreground-launch permission to the primary."""
        try:
            user32 = self.user32 or ctypes.windll.user32
            function = user32.AllowSetForegroundWindow
            try:
                function.argtypes = [ctypes.c_uint32]
                function.restype = ctypes.c_bool
            except (AttributeError, TypeError):
                pass
            function(int(pid))
        except Exception:
            pass

    def _listener_loop(self, listener) -> None:
        try:
            while not self._stop_event.is_set():
                connection = None
                try:
                    connection = listener.accept()
                    message = connection.recv()
                    if (
                        isinstance(message, dict)
                        and message.get("type") == "shutdown"
                        and secrets.compare_digest(str(message.get("token") or ""), self._token)
                    ):
                        connection.send({"ok": True, "status": "stopping"})
                        break
                    if not isinstance(message, dict) or message.get("type") != "activate":
                        response = {
                            "ok": False, "status": "invalid-command",
                            "error": "不支持的实例命令",
                        }
                    elif not isinstance(message.get("file", ""), str):
                        response = {
                            "ok": False, "status": "invalid-file",
                            "error": "画布路径格式无效",
                        }
                    else:
                        try:
                            response = self.command_handler(message)
                        except Exception as err:
                            response = {
                                "ok": False, "status": "handler-error", "error": str(err),
                            }
                        if not isinstance(response, dict):
                            response = {
                                "ok": False, "status": "invalid-response",
                                "error": "主实例未返回有效结果",
                            }
                    connection.send(response)
                except (EOFError, OSError):
                    if self._stop_event.is_set():
                        break
                finally:
                    if connection is not None:
                        try:
                            connection.close()
                        except Exception:
                            pass
        finally:
            try:
                listener.close()
            except Exception:
                pass

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        self._stop_event.set()
        listener = self._listener
        thread = self._listener_thread
        if listener is not None and self._pipe_name and self._authkey:
            connection = None
            try:
                connection = self.client_factory(
                    self._pipe_name, family="AF_PIPE", authkey=self._authkey,
                )
                connection.send({"type": "shutdown", "token": self._token})
                connection.recv()
            except (EOFError, OSError):
                pass
            finally:
                if connection is not None:
                    try:
                        connection.close()
                    except Exception:
                        pass
        if listener is not None:
            try:
                listener.close()
            except Exception:
                pass
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        self._remove_owned_state()
        handle, self._mutex = self._mutex, None
        if handle:
            try:
                kernel32 = self.kernel32 or ctypes.windll.kernel32
                kernel32.CloseHandle(handle)
            except Exception:
                pass
        self._listener = None
        self._listener_thread = None

    def _remove_owned_state(self) -> None:
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(state, dict) or state.get("token") != self._token:
                return
            self.state_path.unlink(missing_ok=True)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        self.close()

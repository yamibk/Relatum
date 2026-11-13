"""Export a workspace note through an isolated Windows WebView2 print page."""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from notes_library import MAX_NOTE_BYTES, NotesError

logger = logging.getLogger(__name__)


class NotePdfExport:
    def __init__(self, print_url, notes, *, mermaid):
        self._print_url = print_url
        self._notes = notes
        self._mermaid = mermaid
        self._busy = threading.Lock()
        self._closing = threading.Event()

    def close(self):
        self._closing.set()

    def _wait(self, wait, seconds, stage):
        deadline = time.monotonic() + seconds
        while not self._closing.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Note PDF timed out during {stage}")
            if wait(min(remaining, .2)):
                return
        raise InterruptedError("PDF export window closed")

    def _invoke(self, native, action, timeout=10):
        from System import Action

        done = threading.Event()
        abandoned = threading.Event()
        result = error = None

        def run():
            nonlocal result, error
            try:
                if not abandoned.is_set():
                    result = action()
            except Exception as exc:
                error = exc
            finally:
                done.set()

        native.BeginInvoke(Action(run))
        try:
            self._wait(done.wait, timeout, "WinForms dispatch")
        finally:
            abandoned.set()
        if error is not None:
            raise error
        return result

    @staticmethod
    def _dispose(owner, get_window):
        from System import Action

        closed = threading.Event()

        def close():
            try:
                window = get_window()
                if window is not None and not window.native.IsDisposed:
                    window.native.Close()
            except Exception:
                logger.exception("Could not close the note PDF print window")
            finally:
                closed.set()

        try:
            owner.BeginInvoke(Action(close))
        except Exception:
            window = get_window()
            if window is not None and not window.native.IsDisposed:
                # The owner may already be closed while the print window keeps the UI alive.
                window.native.BeginInvoke(Action(close))
            else:
                return
        closed.wait(5)

    def _task_result(self, task, timeout, stage):
        # Run the task on WinForms and wait from the bridge thread.
        self._wait(lambda seconds: task.Wait(max(1, int(seconds * 1000))), timeout, stage)
        return task.Result

    def export(self, owner, path, value, language):
        if self._closing.is_set():
            return {"status": "cancelled"}
        if not self._busy.acquire(blocking=False):
            return {"status": "busy"}
        try:
            if not isinstance(value, str) or len(value.encode("utf-8")) > MAX_NOTE_BYTES:
                return {"status": "error", "code": "size"}
            path = self._notes.normalize_path(path)
            source = self._notes.reveal_target(path)
            if not source.is_file() or source.suffix.lower() != ".md":
                return {"status": "error", "code": "note"}
            language = "en" if language == "en" else "zh-CN"
            return self._export(owner, source, {"path": path, "value": value, "language": language, "mermaid": self._mermaid})
        except (NotesError, UnicodeError):
            return {"status": "error", "code": "note"}
        except InterruptedError:
            return {"status": "cancelled"}
        except Exception as error:
            logger.exception("Note PDF export failed")
            return {"status": "error", "code": "timeout" if isinstance(error, TimeoutError) else "export"}
        finally:
            self._busy.release()

    def _export(self, owner, source, payload):
        import webview

        label = "PDF document (*.pdf)" if payload["language"] == "en" else "PDF 文档 (*.pdf)"
        dialog_deadline = time.monotonic() + 300
        selected = owner.create_file_dialog(webview.SAVE_DIALOG, directory=str(source.parent),
                                            save_filename=source.stem + ".pdf", file_types=(label,))
        if not selected or self._closing.is_set():
            return {"status": "cancelled"}
        if time.monotonic() > dialog_deadline:
            return {"status": "error", "code": "timeout"}
        destination = Path(selected[0])
        if not destination.is_absolute() or destination.suffix.lower() != ".pdf":
            return {"status": "error", "code": "destination"}
        original = _file_identity(destination)

        native = owner.native
        window = None
        temporary = None
        try:
            def create():
                nonlocal window
                window = webview.create_window("Relatum PDF", self._print_url, width=850, height=760,
                                               hidden=True, focus=False)

            self._invoke(native, create, 20)
            self._wait(window.events.loaded.wait, 20, "print page startup")
            result = self._render(window, payload)
            if result.get("ok") is not True:
                code = "image-timeout" if result.get("code") == "image-timeout" else "render"
                return {"status": "error", "code": code}
            fd, name = tempfile.mkstemp(prefix=".relatum-pdf-", suffix=".pdf", dir=destination.parent)
            temporary = Path(name)
            os.close(fd)
            self._print(window, temporary)
            if self._closing.is_set():
                return {"status": "cancelled"}
            if _file_identity(destination) != original:
                return {"status": "error", "code": "destination-changed"}
            os.replace(temporary, destination)
            return {"status": "saved", "warnings": result.get("warnings", 0), "name": destination.name}
        finally:
            try:
                self._dispose(native, lambda: window)
            except Exception:
                logger.exception("Could not close the note PDF print window")
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        logger.exception("Could not remove the temporary note PDF")

    def _render(self, window, payload):
        script = (
            "Promise.resolve().then(() => window.RelatumNotePrint.render(" + json.dumps(payload)
            + ")).then(result => ({ok:true,...result}), error => ({ok:false,code:error?.message}))"
        )
        params = json.dumps({"expression": script, "awaitPromise": True, "returnByValue": True})
        native = window.native.webview
        task = self._invoke(native, lambda: native.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", params))
        response = json.loads(self._task_result(task, 90, "print page rendering"))
        return response.get("result", {}).get("value") or {}

    def _print(self, window, temporary):
        from Microsoft.Web.WebView2.Core import CoreWebView2PrintOrientation

        def start():
            core = window.native.webview.CoreWebView2
            settings = core.Environment.CreatePrintSettings()
            settings.Orientation = CoreWebView2PrintOrientation.Portrait
            settings.PageWidth, settings.PageHeight = 210 / 25.4, 297 / 25.4
            settings.MarginTop = settings.MarginBottom = 16 / 25.4
            settings.MarginLeft = settings.MarginRight = 16 / 25.4
            settings.ShouldPrintHeaderAndFooter = False
            settings.ShouldPrintBackgrounds = True
            return core.PrintToPdfAsync(str(temporary), settings)

        task = self._invoke(window.native, start)
        if not self._task_result(task, 90, "WebView2 printing"):
            raise OSError("WebView2 could not print the note")
        with temporary.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise OSError("WebView2 did not produce a PDF")


def _file_identity(path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns

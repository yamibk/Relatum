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

    def _wait(self, wait, seconds):
        deadline = time.monotonic() + seconds
        while not self._closing.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("PDF export timed out")
            if wait(min(remaining, .2)):
                return
        raise InterruptedError("PDF export window closed")

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
        selected = owner.create_file_dialog(webview.SAVE_DIALOG, directory=str(source.parent),
                                            save_filename=source.stem + ".pdf", file_types=(label,))
        if not selected or self._closing.is_set():
            return {"status": "cancelled"}
        destination = Path(selected[0])
        if not destination.is_absolute() or destination.suffix.lower() != ".pdf":
            return {"status": "error", "code": "destination"}
        original = _file_identity(destination)

        window = webview.create_window("Relatum PDF", self._print_url, width=850, height=760,
                                       hidden=True, focus=False)
        temporary = None
        try:
            self._wait(window.events.loaded.wait, 20)
            rendered = threading.Event()
            result = None

            def receive(value):
                nonlocal result
                result = value
                rendered.set()

            window.evaluate_js(
                "Promise.resolve().then(() => window.RelatumNotePrint.render(" + json.dumps(payload)
                + ")).then(result => ({ok:true,...result}), () => ({ok:false}))", receive
            )
            self._wait(rendered.wait, 90)
            if not isinstance(result, dict) or result.get("ok") is not True:
                return {"status": "error", "code": "render"}
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
                window.destroy()
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    def _print(self, window, temporary):
        from System import Action
        from Microsoft.Web.WebView2.Core import CoreWebView2PrintOrientation

        scheduled = threading.Event()
        task = error = None

        def start():
            nonlocal task, error
            try:
                core = window.native.webview.CoreWebView2
                settings = core.Environment.CreatePrintSettings()
                settings.Orientation = CoreWebView2PrintOrientation.Portrait
                settings.PageWidth, settings.PageHeight = 210 / 25.4, 297 / 25.4
                settings.MarginTop = settings.MarginBottom = 16 / 25.4
                settings.MarginLeft = settings.MarginRight = 16 / 25.4
                settings.ShouldPrintHeaderAndFooter = False
                settings.ShouldPrintBackgrounds = True
                task = core.PrintToPdfAsync(str(temporary), settings)
            except Exception as exc:
                error = exc
            finally:
                scheduled.set()

        window.native.BeginInvoke(Action(start))
        self._wait(scheduled.wait, 10)
        if error is not None:
            raise error
        # Wait on the bridge thread so WebView2 can deliver completion on WinForms.
        self._wait(lambda seconds: task.Wait(max(1, int(seconds * 1000))), 90)
        if not task.Result:
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

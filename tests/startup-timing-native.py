"""Measure the source desktop shell in an isolated, hidden WebView2 window."""
import builtins
import runpy
import sys
from pathlib import Path

project = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project))
original_import = builtins.__import__
window_patched = False


def instrument_import(name, *args, **kwargs):
    global window_patched
    module = original_import(name, *args, **kwargs)
    if name == "webview" and hasattr(module, "create_window") and not window_patched:
        window_patched = True
        create = module.create_window

        def create_hidden_window(*window_args, **window_kwargs):
            from startup_trace import mark
            window_kwargs["hidden"] = True
            window = create(*window_args, **window_kwargs)
            window.events.before_load += lambda: mark("bridge-injection")
            return window

        module.create_window = create_hidden_window
    backend = sys.modules.get("webview.platforms.edgechromium")
    if backend is not None and hasattr(backend, "EdgeChrome"):
        builtins.__import__ = original_import
        on_ready = backend.EdgeChrome.on_webview_ready

        def record_webview_ready(self, sender, event):
            from startup_trace import mark
            if event.IsSuccess:
                mark("webview-ready")
            return on_ready(self, sender, event)

        backend.EdgeChrome.on_webview_ready = record_webview_ready
    return module


builtins.__import__ = instrument_import
runpy.run_path(str(project / "desktop.py"), run_name="__main__")

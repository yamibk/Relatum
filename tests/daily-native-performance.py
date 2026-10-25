"""Hidden source desktop shell for an isolated first-navigation measurement."""
import json
import os
import runpy
import sys
from pathlib import Path

import webview

original_create = webview.create_window


def create_measurement_window(title, url=None, *args, **kwargs):
    # Start blank so the test can install baseline routing before any app assets.
    Path(os.environ["RELATUM_DAILY_START_URL"]).write_text(json.dumps({"url": url}), encoding="utf-8")
    kwargs["hidden"] = True
    return original_create(title, "about:blank", *args, **kwargs)


webview.create_window = create_measurement_window
project = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project))
runpy.run_path(str(project / "desktop.py"), run_name="__main__")

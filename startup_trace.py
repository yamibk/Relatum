"""Opt-in startup measurements; no files or timers in ordinary sessions."""
import json
import os
import threading
import time

_lock = threading.Lock()


def mark(stage: str) -> None:
    target = os.environ.get("RELATUM_STARTUP_TRACE")
    if not target:
        return
    try:
        with _lock, open(target, "a", encoding="utf-8", newline="") as stream:
            stream.write(json.dumps({"stage": stage, "pid": os.getpid(), "timeMs": time.time_ns() / 1_000_000}) + "\n")
    except OSError:
        pass  # Diagnostics must never prevent the app or its save flow starting.

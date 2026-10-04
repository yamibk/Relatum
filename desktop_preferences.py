"""Port-independent desktop UI preferences; never stores document bodies."""
from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from feature_profile import _save_json


def managed_key(key) -> bool:
    return isinstance(key, str) and key.startswith(("canvas:", "research:")) and len(key) <= 256


class DesktopPreferences:
    def __init__(self, root: Path, session_key: str):
        self.path = Path(root) / "data" / "desktop-sessions" / session_key / "preferences.json"
        self.session_key = session_key
        self.launch_id = uuid.uuid4().hex
        self._lock = threading.RLock()
        self._timer = None
        self._dirty = False
        self.values = {}
        self.initialized = session_key != "full"
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("version") == 1 and isinstance(payload.get("values"), dict):
                self.values = self._validate(payload["values"])
                self.initialized = True
        except (OSError, ValueError, AttributeError):
            pass

    @staticmethod
    def _validate(values):
        if not isinstance(values, dict) or len(values) > 2048:
            raise ValueError("本机偏好结构无效")
        result = {}
        for key, value in values.items():
            if not managed_key(key) or (value is not None and (not isinstance(value, str) or len(value) > 512 * 1024)):
                raise ValueError("本机偏好键或值无效")
            result[key] = value
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 4 * 1024 * 1024:
            raise ValueError("本机偏好过大")
        return result

    def bootstrap(self):
        with self._lock:
            context = {"sessionKey": self.session_key, "launchId": self.launch_id, "initialized": self.initialized, "values": dict(self.values)}
        raw = json.dumps(context, ensure_ascii=True).replace("<", "\\u003c")
        return '<script>window.RelatumDesktopPreferencesSeed=' + raw + ';</script><script src="/desktop-preferences.js"></script>'

    def update(self, delta):
        delta = self._validate(delta)
        with self._lock:
            updated = dict(self.values)
            for key, value in delta.items():
                if value is None:
                    updated.pop(key, None)
                else:
                    updated[key] = value
            self._validate(updated)
            if self.initialized and updated == self.values:
                return {"ok": True}
            self.values = updated
            self.initialized = True
            self._dirty = True
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(0.35, self._background_flush)
            self._timer.daemon = True
            self._timer.start()
        return {"ok": True}

    def _background_flush(self):
        try:
            self.flush()
        except OSError:
            # Keep dirty state; explicit close can report and retry the error.
            pass

    def flush(self):
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._dirty:
                _save_json(self.path, {"version": 1, "values": self.values})
                self._dirty = False
        return {"ok": True}

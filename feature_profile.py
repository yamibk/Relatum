"""Declarative session features, launcher preferences and static resource filtering.

The saved launcher preferences never affect an ordinary Relatum launch. Only an
explicit command-line handoff creates a restricted session. No HTTP setter exists.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import uuid
from html.parser import HTMLParser
from pathlib import Path

RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
CATALOG = json.loads((RESOURCE_ROOT / "assets" / "feature-catalog.json").read_text(encoding="utf-8"))
FEATURES = {item["id"]: item for item in CATALOG["features"]}
PROFILE_VERSION = 1
PROFILE_FILENAME = "launcher-profile.json"
LAUNCHER_SETTINGS_FILENAME = "launcher-settings.json"
HANDOFF_ARGUMENT = "--launch-profile"
CANVAS_HOME_IDS = tuple(key for key, item in FEATURES.items() if item.get("home") and item.get("parent") == "canvas")
VOID_TAGS = frozenset("area base br col embed hr img input link meta param source track wbr".split())


class ProfileError(ValueError):
    pass


def validate_catalog(catalog: dict) -> None:
    items = catalog["features"]
    by_id = {item["id"]: item for item in items}
    if len(items) != len(by_id) or catalog.get("version") != 1:
        raise ProfileError("功能清单存在重复 ID 或版本错误")
    visited = set()
    def visit(key, chain):
        if key not in by_id or key in chain:
            raise ProfileError(f"功能清单依赖不存在或形成循环：{key}")
        if key in visited:
            return
        item = by_id[key]
        if not isinstance(item.get("default", True), bool):
            raise ProfileError(f"功能默认值无效：{key}")
        dependencies = item.get("requires", []) + ([item["parent"]] if item.get("parent") else [])
        for dependency in dependencies:
            visit(dependency, chain | {key})
        visited.add(key)
    for key in by_id:
        visit(key, set())


validate_catalog(CATALOG)


class LaunchProfile:
    def __init__(self, choices: dict | None = None, *, restricted: bool = False):
        if choices is not None and not isinstance(choices, dict):
            raise ProfileError("功能选择必须是对象")
        self.restricted = restricted
        self.choices = {}
        for key in FEATURES:
            value = (choices or {}).get(key, FEATURES[key].get("default", True))
            if not isinstance(value, bool):
                raise ProfileError(f"功能 {key} 的选择必须是布尔值")
            self.choices[key] = value

    def enabled(self, key: str) -> bool:
        if key not in FEATURES:
            return False
        parent = FEATURES[key].get("parent")
        return self.choices[key] and (not parent or self.enabled(parent)) and all(self.enabled(dependency) for dependency in FEATURES[key].get("requires", []))

    @property
    def canvas_home(self) -> bool:
        return any(self.enabled(key) for key in CANVAS_HOME_IDS)

    @property
    def has_home(self) -> bool:
        return self.canvas_home or any(self.enabled(key) for key in ("notes", "research", "career"))

    def validate(self) -> None:
        if not self.has_home and not self.enabled("canvas.editor"):
            raise ProfileError("请至少选择一个工作区、页面或画布编辑器")

    def payload(self) -> dict:
        return {"version": PROFILE_VERSION, "features": dict(self.choices)}

    def encode(self) -> str:
        return json.dumps(self.payload(), separators=(",", ":"), ensure_ascii=True)

    @classmethod
    def decode(cls, raw: str, *, restricted: bool = True) -> "LaunchProfile":
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError) as err:
            raise ProfileError("启动器会话配置不是有效 JSON") from err
        if not isinstance(payload, dict) or type(payload.get("version")) is not int or payload.get("version") != PROFILE_VERSION or not isinstance(payload.get("features"), dict):
            raise ProfileError("启动器配置版本或结构不受支持")
        result = cls(payload["features"], restricted=restricted)
        result.validate()
        return result

    def resource_allowed(self, resource: str) -> bool:
        if not self.restricted:
            return True
        name = resource.lstrip("/").lower()
        if name in ("", "index.html") and not self.has_home:
            return False
        owners = CATALOG["sharedScripts"].get(name, [])[:]
        for key, item in FEATURES.items():
            if name in item.get("pages", []) or any(name == src or (src.endswith("/") and name.startswith(src)) for src in item.get("scripts", [])):
                owners.append(key)
        if name in ("trash.html", "trash.js"):
            owners.append("canvas.library")
        return not owners or any(self.enabled(key) for key in owners)

    def api_allowed(self, path: str, *, write: bool = False) -> bool:
        """Exclusive APIs use the catalog; shared historical GETs stay readable."""
        if not self.restricted:
            return True
        kind = "write" if write else "read"
        owners = CATALOG.get("sharedWrites", {}).get(path, [])[:] if write else []
        for key, item in FEATURES.items():
            if path in item.get(kind + "Paths", []) or any(path.startswith(prefix) for prefix in item.get(kind + "Prefixes", [])):
                owners.append(key)
        return not owners or any(self.enabled(key) for key in owners)

    def write_allowed(self, path: str) -> bool:
        return self.api_allowed(path, write=True)

    def bootstrap(self) -> str:
        features = {key: self.enabled(key) for key in FEATURES}
        views = {item["view"]: key for key, item in FEATURES.items() if "view" in item}
        return "<script>window.RelatumFeatures=Object.freeze(" + json.dumps({"restricted": self.restricted, "features": features, "views": views, "canvasHome": self.canvas_home}, ensure_ascii=True) + ");</script>"


FULL_PROFILE = LaunchProfile({key: True for key in FEATURES})


def read_preferences(root: Path) -> tuple[LaunchProfile, str]:
    target = Path(root) / "data" / PROFILE_FILENAME
    if not target.exists():
        return LaunchProfile(), ""
    try:
        return LaunchProfile.decode(target.read_text(encoding="utf-8"), restricted=False), ""
    except (OSError, UnicodeError, ProfileError):
        return LaunchProfile(), "上次启动器配置无法读取，已显示默认选择。确认启动后会保存新选择。"


def saved_canvas(root: Path) -> str:
    try:
        payload = json.loads((Path(root) / "data" / PROFILE_FILENAME).read_text(encoding="utf-8"))
        value = payload.get("canvasFile", "")
        return value if isinstance(value, str) else ""
    except (OSError, ValueError, AttributeError):
        return ""


def read_launcher_settings(root: Path) -> dict:
    defaults = {"version": 1, "skipSelection": False}
    try:
        payload = json.loads((Path(root) / "data" / LAUNCHER_SETTINGS_FILENAME).read_text(encoding="utf-8"))
        if isinstance(payload, dict) and type(payload.get("version")) is int and payload["version"] == 1 and isinstance(payload.get("skipSelection"), bool):
            return {"version": 1, "skipSelection": payload["skipSelection"]}
    except (OSError, ValueError):
        pass
    return defaults


def save_launcher_settings(root: Path, skip_selection: bool) -> dict:
    if not isinstance(skip_selection, bool):
        raise ProfileError("启动器免弹窗设置必须是布尔值")
    payload = {"version": 1, "skipSelection": skip_selection}
    _save_json(Path(root) / "data" / LAUNCHER_SETTINGS_FILENAME, payload)
    return payload


def save_preferences(root: Path, profile: LaunchProfile, file: str = "") -> None:
    profile.validate()
    target = Path(root) / "data" / PROFILE_FILENAME
    payload = profile.payload()
    if file:
        payload["canvasFile"] = str(Path(file).resolve())
    _save_json(target, payload)


def _save_json(target: Path, payload: dict) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".lp-{os.getpid()}-{threading.get_ident()}-{uuid.uuid4().hex[:8]}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


class FeatureHTML(HTMLParser):
    """Omit disabled DOM and script tags while preserving source text verbatim."""
    def __init__(self, profile: LaunchProfile):
        super().__init__(convert_charrefs=False)
        self.profile = profile
        self.output = []
        self.stack = []

    def omit(self, tag: str, attrs: dict) -> bool:
        p = self.profile
        if tag in ("script", "link"):
            src = attrs.get("src") or attrs.get("href") or ""
            if src and not p.resource_allowed(src):
                return True
        explicit = attrs.get("data-feature")
        if explicit and not p.enabled(explicit):
            return True
        action = attrs.get("data-action")
        if action in {"new", "import-canvas-file", "import-canvas-folder", "recent-sync"} and not p.enabled("canvas.library"):
            return True
        if action == "new" and not p.enabled("canvas.editor"):
            return True
        if attrs.get("data-role") in {"ai-toggle", "ai-panel"} and not p.enabled("editor.ai"):
            return True
        if (action == "graph" or attrs.get("data-role") == "graph-overlay") and not p.enabled("editor.graph"):
            return True
        workspace = attrs.get("data-start-workspace") or attrs.get("data-start-workspace-panel")
        if workspace and not (p.canvas_home if workspace == "canvas" else p.enabled(workspace)):
            return True
        role = attrs.get("data-role")
        for key, item in FEATURES.items():
            if (role and item.get("role") == role) or (action and item.get("role") == action):
                if not p.enabled(key):
                    return True
        return False

    def handle_starttag(self, tag, attrs):
        skip = bool(self.stack and self.stack[-1][1]) or self.omit(tag, dict(attrs))
        if not skip:
            self.output.append(self.get_starttag_text())
        if tag not in VOID_TAGS:
            self.stack.append((tag, skip))

    def handle_startendtag(self, tag, attrs):
        if not (self.stack and self.stack[-1][1]) and not self.omit(tag, dict(attrs)):
            self.output.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        if not (self.stack and self.stack[-1][1]):
            self.output.append(f"</{tag}>")
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def emit(self, text):
        if not (self.stack and self.stack[-1][1]):
            self.output.append(text)

    def handle_data(self, data): self.emit(data)
    def handle_comment(self, data): self.emit("<!--" + data + "-->")
    def handle_decl(self, decl): self.emit("<!" + decl + ">")
    def handle_entityref(self, name): self.emit("&" + name + ";")
    def handle_charref(self, name): self.emit("&#" + name + ";")


def render_html(source: str, profile: LaunchProfile, name: str) -> str:
    if profile.restricted:
        parser = FeatureHTML(profile)
        parser.feed(source)
        parser.close()
        source = "".join(parser.output)
        if name == "index.html" and profile.canvas_home:
            source = re.sub(r'<script src="start-shell.js" defer></script>', "", source)
    else:
        source = re.sub(r'<script src="start-shell.js" defer></script>', "", source)
    return source.replace("<head>", "<head>\n" + profile.bootstrap() + '\n<script src="feature-runtime.js"></script>', 1)

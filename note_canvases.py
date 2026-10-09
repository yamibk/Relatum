"""Optional notes canvas persistence. Caller holds notes/cross-process locks.

The main canvas store and editor are deliberately not imported. V2 base node
and edge records remain compatible, and unsupported content is never flattened.
"""
from __future__ import annotations

import copy
import json
import math
import posixpath
import re
import uuid
from datetime import datetime
from pathlib import Path

from note_canvas_reference import CANVAS_DIRECTORY, canvas_target, rewrite
from notes_library import NotesError, _revision, _is_reparse

MAX_CANVAS_BYTES = 16 * 1024 * 1024
SHAPES = {"rect", "rounded-rect", "square", "circle", "ellipse", "diamond", "triangle",
          "hexagon", "parallelogram", "trapezoid", "pill", "cylinder"}
TEXT_ENUMS = {"textAlign": {"left", "center", "right"}, "verticalAlign": {"top", "center", "bottom"}}
TEXT_NUMBERS = {"fontSize": (8, 120), "fontWeight": (100, 900), "lineHeight": (.8, 3)}


def _styles(record, *, edge=False, label=False):
    enums = dict(TEXT_ENUMS) if not edge else {
        "curve": {"straight", "bezier", "smooth", "elbow", "rounded-elbow"},
        "lineStyle": {"solid", "dashed", "dotted"},
        "fromSide": {"auto", "top", "right", "bottom", "left"},
        "toSide": {"auto", "top", "right", "bottom", "left"},
        "arrow": {"none", "end", "one", "both"}}
    numbers = dict(TEXT_NUMBERS) if not edge else {
        "width": (.5, 12), "arrowSize": (4, 40), "cornerRadius": (0, 80),
        "labelPosition": (0, 1), "labelOffsetX": (-6000, 6000), "labelOffsetY": (-6000, 6000)}
    booleans = {"wrap"} if not edge else {"arrowStart", "arrowEnd"}
    colors = {"color"}
    if not edge and not label:
        enums["shape"] = SHAPES
        numbers.update({"radius": (0, 80), "bgOpacity": (0, 1), "borderWidth": (0, 12),
                        "paddingX": (0, 80), "paddingY": (0, 80)})
        booleans.update({"autoHeight", "hideBackground"})
        colors.update({"bgColor", "borderColor"})
    if label:
        numbers.update({"width": (0, 6000), "height": (0, 6000)})
    for key, allowed in enums.items():
        if key == "curve" and record.get(key) is None:
            continue  # The original V2 validator accepted an explicit null curve.
        if key in record and (not isinstance(record[key], str) or record[key] not in allowed):
            raise NotesError("画布样式选项无效", code="unsupported_canvas")
    for key, (low, high) in numbers.items():
        if key in record:
            value = record[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise NotesError("画布样式数值无效", code="invalid_canvas")
    for key in booleans:
        if key in record and not isinstance(record[key], bool):
            raise NotesError("画布样式开关无效", code="invalid_canvas")
    for key in colors:
        if key in record and (not isinstance(record[key], str) or not re.fullmatch(r"(?:|#[0-9a-fA-F]{6})", record[key])):
            raise NotesError("画布样式颜色无效", code="invalid_canvas")
    if edge and "labelStyle" in record:
        if not isinstance(record["labelStyle"], dict):
            raise NotesError("画布标注样式无效", code="invalid_canvas")
        _styles(record["labelStyle"], label=True)


def validate(payload: object) -> dict:
    if not isinstance(payload, dict) or payload.get("version") != 2:
        raise NotesError("不支持的画布格式", code="unsupported_canvas")
    nodes, edges = payload.get("nodes"), payload.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list) or len(nodes) > 20_000 or len(edges) > 60_000:
        raise NotesError("画布节点或连线无效", code="unsupported_canvas")
    ink = payload.get("ink")
    if (ink and (not isinstance(ink, dict) or any(ink.get(key) for key in ("strokes", "arrows")))) or any(payload.get(key) for key in ("ruler", "timers", "taskbook", "scenes", "arrows")):
        raise NotesError("首版不支持该画布中的复杂内容", code="unsupported_canvas")
    ids = set()
    for node in nodes:
        if (not isinstance(node, dict) or node.get("kind") not in (None, "index", "text")
                or any(node.get(key) for key in ("body", "textMarks", "bodyMarks", "file", "taskbookId", "mindmapStyleRole"))
                or not isinstance(node.get("text", ""), str)):
            raise NotesError("首版只支持纯文字节点", code="unsupported_canvas")
        if not isinstance(node.get("id"), str) or not node["id"] or node["id"] in ids:
            raise NotesError("节点 id 无效")
        ids.add(node["id"])
        _styles(node)
        for key in ("x", "y", "width", "height"):
            value = node.get(key, 0 if key in ("x", "y") else 160 if key == "width" else 48)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise NotesError("节点尺寸或坐标无效")
            if key in ("width", "height") and value <= 0:
                raise NotesError("节点尺寸无效")
    edge_ids = set()
    for edge in edges:
        if (not isinstance(edge, dict) or not isinstance(edge.get("id"), str) or not edge["id"]
                or edge["id"] in edge_ids or edge.get("from") not in ids or edge.get("to") not in ids
                or edge.get("from") == edge.get("to") or not isinstance(edge.get("text", ""), str)):
            raise NotesError("连线无效")
        edge_ids.add(edge["id"])
        _styles(edge, edge=True)
        waypoints = edge.get("waypoints", [])
        if not isinstance(waypoints, list) or len(waypoints) > 256:
            raise NotesError("连线拐点无效")
        for point in waypoints:
            if not isinstance(point, dict) or any(isinstance(point.get(k), bool) or not isinstance(point.get(k), (int, float)) or not math.isfinite(point[k]) for k in ("x", "y")):
                raise NotesError("连线拐点无效")
    try:
        json.dumps(payload, allow_nan=False)
    except (ValueError, TypeError, RecursionError) as error:
        raise NotesError("画布数据包含无效数值", code="invalid_canvas") from error
    return copy.deepcopy(payload)


class NoteCanvasStore:
    def __init__(self, notes):
        self.notes = notes

    def _path(self, relative: str) -> Path:
        normalized = self.notes.normalize_path(relative, allow_assets=True)
        parts = normalized.split("/")
        if len(parts) != 2 or parts[0] != CANVAS_DIRECTORY or not parts[1].lower().endswith(".canvas"):
            raise NotesError("只允许 notes/canvases 内的画布", status=403, code="unsafe_path")
        return self.notes._absolute(normalized, allow_assets=True)

    def resolve(self, note: object, source: object) -> str:
        note = self.notes.normalize_path(note)
        self.notes._absolute(note)
        relative = canvas_target(note, source) if isinstance(source, str) else None
        if not relative:
            raise NotesError("画布引用超出资源目录", status=403, code="unsafe_path")
        path = self._path(relative)
        actual = self.notes._case_collision(path.parent, path.name)
        if actual is not None:
            relative = CANVAS_DIRECTORY + "/" + actual.name
            self._path(relative)
        return relative

    def read(self, relative: str) -> dict:
        path = self._path(relative)
        try:
            if path.stat().st_size > MAX_CANVAS_BYTES:
                raise NotesError("画布文件过大", status=413)
            raw = path.read_bytes()
        except FileNotFoundError as error:
            raise NotesError("画布文件不存在", status=404, code="not_found") from error
        try:
            payload = validate(json.loads(raw.decode("utf-8-sig")))
        except (UnicodeError, ValueError, RecursionError) as error:
            raise NotesError("画布文件损坏", code="invalid_canvas") from error
        return {"path": relative, "revision": _revision(raw), "data": payload}

    def create(self, note: object) -> dict:
        note = self.notes.normalize_path(note)
        self.notes.load(note)
        directory = self.notes._absolute(CANVAS_DIRECTORY, allow_assets=True)
        directory.mkdir(exist_ok=True)
        if _is_reparse(directory):
            raise NotesError("画布目录不能是链接", status=403)
        base = "Untitled-" + datetime.now().strftime("%Y-%m-%d")
        name, index = base + ".canvas", 2
        while self.notes._case_collision(directory, name):
            name = f"{base}-{index}.canvas"
            index += 1
        now = datetime.now().replace(microsecond=0).isoformat()
        payload = {"version": 2, "createdAt": now, "updatedAt": now, "nodes": [], "edges": []}
        self.notes.atomic_text(directory / name, json.dumps(payload, ensure_ascii=False, indent=2))
        result = self.read(CANVAS_DIRECTORY + "/" + name)
        result["source"] = posixpath.relpath(result["path"], posixpath.dirname(note) or ".")
        return result

    def save(self, relative: str, data: object, expected: object) -> dict:
        current = self.read(relative)
        if expected != current["revision"]:
            raise NotesError("画布已被其他程序修改，请重新打开后重试", status=409, code="revision_conflict")
        payload = validate(data)
        if payload == current["data"]:
            return {"path": relative, "revision": current["revision"]}
        payload["createdAt"] = current["data"].get("createdAt")
        payload["updatedAt"] = datetime.now().replace(microsecond=0).isoformat()
        encoded = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_CANVAS_BYTES:
            raise NotesError("画布文件过大", status=413)
        self.notes.atomic_text(self._path(relative), encoded)
        return {"path": relative, "revision": _revision(encoded.encode("utf-8"))}

    def rename(self, relative: str, name: object, expected: object) -> dict:
        current = self.read(relative)
        if expected != current["revision"]:
            raise NotesError("画布已被其他程序修改", status=409, code="revision_conflict")
        if not isinstance(name, str) or "/" in name or "\\" in name:
            raise NotesError("画布名称无效")
        name = name.strip()
        if not name or name.casefold() == ".canvas":
            raise NotesError("画布名称不能为空")
        if not name.lower().endswith(".canvas"):
            name += ".canvas"
        destination = CANVAS_DIRECTORY + "/" + name
        source, target = self._path(relative), self._path(destination)
        if destination == relative:
            return {"path": relative, "revision": current["revision"], "rewritten": [], "renamed": {}}
        if self.notes._case_collision(source.parent, name, ignore=source):
            raise NotesError("已有同名画布", status=409, code="exists")
        documents = self.notes._documents()
        updates, backups = {}, {}
        for note, document in documents.items():
            if not document.get("hasCanvasReferences", True):
                continue
            text = self.notes._indexed_text(note, document)
            changed = rewrite(text, note, renamed={relative: destination})
            if text != changed:
                updates[note] = changed
                backups[note] = self.notes._read_note_bytes(self.notes._absolute(note))
                if _revision(backups[note]) != document["revision"]:
                    raise NotesError("重命名期间有笔记被外部修改", status=409, code="revision_conflict")
        # Recheck after preparation; unrelated notes never get rewritten.
        for note, raw in backups.items():
            if self.notes._read_note_bytes(self.notes._absolute(note)) != raw:
                raise NotesError("重命名期间有笔记被外部修改", status=409, code="revision_conflict")
        if self.read(relative)["revision"] != expected:
            raise NotesError("画布已被其他程序修改", status=409, code="revision_conflict")
        moved = False
        written = []
        intermediate = source.with_name(".relatum-case-" + uuid.uuid4().hex)
        try:
            if source.name.casefold() == target.name.casefold():
                source.rename(intermediate)
                try:
                    intermediate.rename(target)
                except Exception:
                    intermediate.rename(source)
                    raise
            else:
                source.rename(target)
            moved = True
            for note, text in updates.items():
                written.append(note)
                self.notes.atomic_text(self.notes._absolute(note), text)
        except Exception:
            for note in reversed(written):
                self.notes.atomic_bytes(self.notes._absolute(note), backups[note])
            if moved:
                if source.name.casefold() == target.name.casefold():
                    target.rename(intermediate)
                    intermediate.rename(source)
                else:
                    target.rename(source)
            raise
        finally:
            self.notes.invalidate()
        return {"path": destination, "revision": current["revision"], "rewritten": list(updates),
                "renamed": {relative: destination},
                "noteRevisions": {note: _revision(text.encode("utf-8")) for note, text in updates.items()}}

"""Experimental research snapshots. No HTTP, computation, or user-path input."""
import copy
import hashlib
import json
import math
import re
import threading
import uuid
from pathlib import Path

MAX_PROJECT_BYTES = 8 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")


class ResearchError(Exception):
    def __init__(self, message, status=400, code="invalid_project"):
        super().__init__(message)
        self.status, self.code = status, code


def valid_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ResearchError("研究项目或对象 ID 无效")
    return value


def encode(project):
    try:
        text = json.dumps(project, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_PROJECT_BYTES:
            raise ResearchError("研究项目超过 8 MiB", 413)
        return text
    except (ValueError, TypeError, RecursionError) as error:
        raise ResearchError("研究项目包含无效数据") from error


def validate_project(project, project_id):
    """Validate the envelope/references without discarding extension payloads."""
    if not isinstance(project, dict) or project.get("format") != "relatum-research":
        raise ResearchError("研究项目格式无效")
    if type(project.get("formatVersion")) is not int or project["formatVersion"] != 1:
        raise ResearchError("不支持此研究项目版本", 400, "unsupported_version")
    if project.get("projectId") != project_id:
        raise ResearchError("研究项目 ID 不匹配")
    if type(project.get("revision")) is not int or not 0 <= project["revision"] < 2**53:
        raise ResearchError("研究修订号无效")
    if not isinstance(project.get("title"), str) or len(project["title"]) > 500:
        raise ResearchError("研究项目标题无效")
    for key in ("objects", "relations", "views", "resources", "pluginRequirements"):
        if not isinstance(project.get(key), list):
            raise ResearchError("研究项目缺少集合：" + key)
    def records(items):
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                raise ResearchError("研究记录必须是对象")
            ident = valid_id(item.get("id"))
            if ident in seen:
                raise ResearchError("研究记录 ID 重复")
            seen.add(ident)
        return seen
    objects = records(project["objects"])
    records(project["relations"])
    relations = {relation["id"]: relation for relation in project["relations"]}
    for relation in project["relations"]:
        if relation.get("type") == "core.association" and relation.get("typeVersion") == 1:
            ends, label = relation.get("ends"), relation.get("label")
            if (not isinstance(ends, list) or len(ends) != 2
                    or any(not isinstance(end, dict) or not isinstance(end.get("objectId"), str)
                           or end["objectId"] not in objects for end in ends)
                    or ends[0]["objectId"] == ends[1]["objectId"]
                    or not isinstance(label, str)
                    or len(label.encode("utf-16-le", errors="surrogatepass")) // 2 > 2000):
                raise ResearchError("普通关系端点或名称无效")
    records(project["views"])
    for obj in project["objects"]:
        if not isinstance(obj.get("type"), str) or type(obj.get("typeVersion")) is not int or not isinstance(obj.get("payload"), dict):
            raise ResearchError("研究对象类型或内容无效")
        if obj["type"] == "core.variable" and obj["typeVersion"] == 1:
            payload = obj["payload"]
            for key in ("label", "symbol", "domain", "unit"):
                if not isinstance(payload.get(key), str) or len(payload[key]) > 2000:
                    raise ResearchError("变量字段无效：" + key)
            if not isinstance(payload.get("shape"), list):
                raise ResearchError("变量形状无效")
        if obj["type"] in ("core.note", "core.formula") and obj["typeVersion"] == 1:
            for key, limit in (("label", 2000), ("source", 100000)):
                value = obj["payload"].get(key)
                # Match JavaScript's UTF-16 length, including astral characters.
                if not isinstance(value, str) or len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > limit:
                    raise ResearchError("草稿字段无效：" + key)
    for view in project["views"]:
        if not isinstance(view.get("type"), str):
            raise ResearchError("研究视图类型无效")
        reps = view.get("representations", [])
        if not isinstance(reps, list):
            raise ResearchError("研究呈现集合无效")
        records(reps)
        for rep in reps:
            if not isinstance(rep.get("objectId"), str) or rep["objectId"] not in objects:
                raise ResearchError("研究呈现引用不存在的对象")
            if view["type"] == "core.canvas":
                for key in ("x", "y"):
                    value = rep.get(key)
                    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1e9:
                        raise ResearchError("研究呈现坐标无效")
        if view["type"] == "core.canvas":
            links = view.get("links", [])
            if not isinstance(links, list):
                raise ResearchError("研究连线集合无效")
            records(links)
            by_id = {rep["id"]: rep for rep in reps}
            for link in links:
                relation_id, source_id, target_id = (link.get(key) for key in ("relationId", "sourceId", "targetId"))
                if any(not isinstance(value, str) for value in (relation_id, source_id, target_id)):
                    raise ResearchError("研究连线引用无效")
                relation = relations.get(relation_id)
                source, target = by_id.get(source_id), by_id.get(target_id)
                if not relation or not source or not target:
                    raise ResearchError("研究连线引用不存在")
                if relation.get("type") == "core.association" and relation.get("typeVersion") == 1:
                    if [source["objectId"], target["objectId"]] != [end["objectId"] for end in relation["ends"]]:
                        raise ResearchError("研究连线与关系端点不一致")
    for relation in project["relations"]:
        if "ends" in relation:
            if not isinstance(relation["ends"], list) or any(
                not isinstance(end, dict) or not isinstance(end.get("objectId"), str)
                or end["objectId"] not in objects for end in relation["ends"]
            ):
                raise ResearchError("研究关系引用无效")
    encode(project)
    return project


class ResearchStore:
    def __init__(self, root: Path, *, atomic_text):
        self.root = Path(root)
        self.atomic_text = atomic_text
        self.lock = threading.RLock()

    def _path(self, project_id):
        path = self.root / valid_id(project_id) / "project.json"
        # Reject symlinks/junctions escaping the managed root, including the root itself.
        base = self.root.parent.resolve()
        expected = base / self.root.name
        if self.root.resolve() != expected or not path.resolve().is_relative_to(expected):
            raise ResearchError("研究目录越过授权范围", 403, "unsafe_path")
        return path

    def _read(self, project_id):
        path = self._path(project_id)
        try:
            if path.stat().st_size > MAX_PROJECT_BYTES:
                raise ResearchError("研究项目超过 8 MiB", 413)
            raw = path.read_bytes()
            project = json.loads(raw)
            validate_project(project, project_id)
            return project, hashlib.sha256(raw).hexdigest()
        except FileNotFoundError as error:
            raise ResearchError("研究项目不存在", 404, "not_found") from error
        except (UnicodeError, ValueError, RecursionError) as error:
            raise ResearchError("研究项目损坏；原文件已保留", 422, "corrupt_project") from error

    def load(self, project_id):
        with self.lock:
            project, fingerprint = self._read(project_id)
            project.pop("_storage", None)
            return {"project": project, "fingerprint": fingerprint}

    def projects(self):
        with self.lock:
            self._path("project-main")
            items = []
            if self.root.exists():
                for folder in sorted(self.root.iterdir()):
                    if folder.is_dir() and ID.fullmatch(folder.name):
                        try:
                            project, _ = self._read(folder.name)
                            items.append({"id": folder.name, "title": project["title"]})
                        except ResearchError as error:
                            items.append({"id": folder.name, "error": str(error)})
            return {"projects": items}

    def create(self):
        with self.lock:
            project_id = "project-main"
            path = self._path(project_id)
            if path.exists():
                return self.load(project_id)
            project = {"format": "relatum-research", "formatVersion": 1,
                       "projectId": project_id, "revision": 0, "title": "研究项目",
                       "objects": [], "relations": [], "resources": [], "pluginRequirements": [],
                       "views": [{"id": "view-main", "type": "core.canvas", "representations": []},
                                 {"id": "view-table", "type": "core.objectTable", "representations": []}]}
            self.atomic_text(path, encode(project))
            return self.load(project_id)

    def save(self, body):
        with self.lock:
            project_id = valid_id(body.get("projectId"))
            request_id = valid_id(body.get("requestId"))
            project = copy.deepcopy(validate_project(body.get("project"), project_id))
            project.pop("_storage", None)
            digest = hashlib.sha256(encode(project).encode("utf-8")).hexdigest()
            current, fingerprint = self._read(project_id)
            if current.get("_storage") == {"requestId": request_id, "digest": digest}:
                return {"revision": current["revision"], "fingerprint": fingerprint}
            if (type(body.get("expectedRevision")) is not int
                    or body["expectedRevision"] != current["revision"]
                    or body.get("expectedFingerprint") != fingerprint):
                recovery = self._path(project_id).parent / ("recovery-" + uuid.uuid4().hex + ".json")
                self.atomic_text(recovery, encode(project))
                raise ResearchError("项目已被其他窗口或外部程序修改；本地草稿已另存恢复副本", 409, "conflict")
            if project["revision"] <= current["revision"]:
                raise ResearchError("新修订必须大于已保存修订")
            project["_storage"] = {"requestId": request_id, "digest": digest}
            self.atomic_text(self._path(project_id), encode(project))
            _, fingerprint = self._read(project_id)
            return {"revision": project["revision"], "fingerprint": fingerprint}

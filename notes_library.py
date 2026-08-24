"""Relatum 托管 Markdown 笔记库。

本模块只处理 ``ROOT/notes`` 内的普通目录、Markdown 与伴生图片目录；
不依赖 HTTP、DOM 或第三方包。所有公开路径都是相对笔记根的 POSIX 路径，
调用方负责在进程内/跨进程锁中执行变更。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import unicodedata
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable


NOTE_SUFFIX = ".md"
MAX_NOTE_BYTES = 4 * 1024 * 1024
MAX_NOTE_IMAGE_BYTES = 40 * 1024 * 1024
MAX_NOTE_IMPORT_BYTES = 512 * 1024 * 1024
MAX_NOTE_IMPORT_FILES = 10_000
NOTE_HISTORY_INTERVAL_SECONDS = 5 * 60
NOTE_HISTORY_RETENTION_SECONDS = 7 * 24 * 60 * 60
NOTE_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def _sniff_image_media_type(content: bytes) -> str | None:
    """只接受可由文件头确认的栅格图片，不信任上传的扩展名/MIME。"""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if content.startswith(b"BM"):
        return "image/bmp"
    if len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    return None

_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}
_INVALID_NAME_CHARS = re.compile(r'[<>:"\\|?*\x00-\x1f]')
_WIKI_RE = re.compile(r"(?<!!)\[\[([^\]\n]+)\]\]")
_IMAGE_RE = re.compile(r"!\[([^\]\n]*)\]\(([^)\n]+)\)")
_FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$")
_INLINE_CODE_RE = re.compile(r"(`+)(.*?)\1")


class NotesError(ValueError):
    """可安全回传给本地前端的笔记错误。"""

    def __init__(self, message: str, *, status: int = 400, code: str = "invalid") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _default_atomic_text(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".relatum-note-{os.getpid()}-{uuid.uuid4().hex[:10]}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _default_atomic_bytes(target: Path, content: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".relatum-note-{os.getpid()}-{uuid.uuid4().hex[:10]}.tmp")
    try:
        tmp.write_bytes(content)
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _is_reparse(path: Path) -> bool:
    try:
        stat = path.lstat()
    except OSError:
        return False
    if path.is_symlink():
        return True
    attrs = int(getattr(stat, "st_file_attributes", 0) or 0)
    return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


def _revision(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def _natural_key(name: str) -> tuple:
    return tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                 for part in re.split(r"(\d+)", name))


def _strip_note_suffix(value: str) -> str:
    return value[:-3] if value.casefold().endswith(NOTE_SUFFIX) else value


def _split_wiki_target(value: str) -> tuple[str, str, str]:
    """返回 ``(路径主体, #/^ 后缀, 别名)``。"""
    target, separator, alias = value.partition("|")
    target = target.strip()
    positions = [index for index in (target.find("#"), target.find("^")) if index >= 0]
    split_at = min(positions) if positions else len(target)
    return target[:split_at].strip(), target[split_at:], alias.strip() if separator else ""


def _wiki_mentions(text: str) -> list[dict]:
    mentions: list[dict] = []
    offset = 0
    fence_marker = ""
    for line_number, line in enumerate(text.splitlines(keepends=True), start=1):
        bare = line.rstrip("\r\n")
        fence = _FENCE_RE.match(bare)
        if fence:
            marker = fence.group(1)
            if not fence_marker:
                fence_marker = marker[0] * len(marker)
            elif marker[0] == fence_marker[0] and len(marker) >= len(fence_marker):
                fence_marker = ""
            offset += len(line)
            continue
        if fence_marker:
            offset += len(line)
            continue
        code_spans = [(match.start(), match.end()) for match in _INLINE_CODE_RE.finditer(bare)]
        for match in _WIKI_RE.finditer(bare):
            if any(start <= match.start() < end for start, end in code_spans):
                continue
            inner = match.group(1)
            base, suffix, alias = _split_wiki_target(inner)
            if not base:
                continue
            mentions.append({
                "start": offset + match.start(),
                "end": offset + match.end(),
                "inner": inner,
                "base": base,
                "suffix": suffix,
                "alias": alias,
                "line": line_number,
                "excerpt": bare.strip()[:240],
            })
        offset += len(line)
    return mentions


class NotesStore:
    def __init__(
        self,
        root: Path,
        *,
        recovery_root: Path | None = None,
        atomic_text: Callable[[Path, str], None] | None = None,
        atomic_bytes: Callable[[Path, bytes], None] | None = None,
    ) -> None:
        self.root = Path(root)
        self.recovery_root = Path(recovery_root) if recovery_root is not None else self.root.parent / "data" / "note-recovery"
        self.atomic_text = atomic_text or _default_atomic_text
        self.atomic_bytes = atomic_bytes or _default_atomic_bytes
        self._document_cache: dict[str, dict] = {}

    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if _is_reparse(self.root):
            raise NotesError("笔记根目录不能是链接或重解析点", status=403, code="unsafe_path")

    def ensure_recovery_root(self) -> None:
        self.recovery_root.mkdir(parents=True, exist_ok=True)
        if _is_reparse(self.recovery_root):
            raise NotesError("恢复历史目录不能是链接或重解析点", status=403, code="unsafe_path")

    def normalize_path(self, raw: object, *, allow_root: bool = False,
                       allow_assets: bool = False) -> str:
        if not isinstance(raw, str):
            raise NotesError("路径格式无效")
        value = unicodedata.normalize("NFC", raw.strip())
        if not value:
            if allow_root:
                return ""
            raise NotesError("缺少笔记路径")
        if "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
            raise NotesError("只允许笔记库内的相对路径", status=403, code="unsafe_path")
        path = PurePosixPath(value)
        parts = path.parts
        if not parts or any(part in ("", ".", "..") for part in parts):
            raise NotesError("路径不能包含空段、. 或 ..", status=403, code="unsafe_path")
        clean: list[str] = []
        for part in parts:
            if part.endswith((" ", ".")) or _INVALID_NAME_CHARS.search(part):
                raise NotesError(f"名称包含 Windows 不支持的字符：{part}")
            stem = part.split(".", 1)[0].casefold()
            if stem in _WINDOWS_RESERVED:
                raise NotesError(f"名称是 Windows 保留名：{part}")
            low = part.casefold()
            if low.startswith(".relatum-") or low == ".trash":
                raise NotesError("该名称由 Relatum 内部保留", status=403, code="unsafe_path")
            if not allow_assets and low.endswith(".assets"):
                raise NotesError("伴生素材目录不能作为普通笔记路径操作", status=403, code="unsafe_path")
            clean.append(part)
        return PurePosixPath(*clean).as_posix()

    def _absolute(self, relative: str, *, allow_root: bool = False,
                  allow_assets: bool = False, require_safe_existing: bool = True) -> Path:
        normalized = self.normalize_path(relative, allow_root=allow_root, allow_assets=allow_assets)
        self.ensure_root()
        candidate = self.root.joinpath(*PurePosixPath(normalized).parts) if normalized else self.root
        current = self.root
        if require_safe_existing and _is_reparse(current):
            raise NotesError("笔记路径包含链接或重解析点", status=403, code="unsafe_path")
        for part in PurePosixPath(normalized).parts:
            current = current / part
            if require_safe_existing and os.path.lexists(current) and _is_reparse(current):
                raise NotesError("笔记路径包含链接或重解析点", status=403, code="unsafe_path")
        try:
            candidate.resolve(strict=False).relative_to(self.root.resolve())
        except (OSError, ValueError) as err:
            raise NotesError("路径超出笔记库", status=403, code="unsafe_path") from err
        return candidate

    @staticmethod
    def _case_collision(parent: Path, name: str, *, ignore: Path | None = None) -> Path | None:
        try:
            entries = list(parent.iterdir())
        except FileNotFoundError:
            return None
        target_key = unicodedata.normalize("NFC", name).casefold()
        for entry in entries:
            if ignore is not None:
                try:
                    if entry.samefile(ignore):
                        continue
                except OSError:
                    if entry == ignore:
                        continue
            if unicodedata.normalize("NFC", entry.name).casefold() == target_key:
                return entry
        return None

    def _read_note_bytes(self, target: Path) -> bytes:
        if not target.is_file() or target.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("笔记不存在", status=404, code="not_found")
        if _is_reparse(target):
            raise NotesError("笔记不能是链接或重解析点", status=403, code="unsafe_path")
        try:
            content = target.read_bytes()
        except OSError as err:
            raise NotesError(f"读取笔记失败：{err}", status=500, code="read_failed") from err
        if len(content) > MAX_NOTE_BYTES:
            raise NotesError("笔记过大（单文件上限 4MB）", status=413, code="too_large")
        return content

    @staticmethod
    def _decode_note(content: bytes) -> str:
        try:
            return content.decode("utf-8-sig")
        except UnicodeDecodeError as err:
            raise NotesError("笔记不是有效的 UTF-8 文本", status=409, code="invalid_encoding") from err

    def _note_paths(self) -> list[Path]:
        self.ensure_root()
        notes: list[Path] = []
        for base, directories, filenames in os.walk(self.root, followlinks=False):
            base_path = Path(base)
            safe_dirs = []
            for name in directories:
                child = base_path / name
                low = name.casefold()
                if low.endswith(".assets") or low.startswith(".relatum-") or low == ".trash":
                    continue
                if _is_reparse(child):
                    continue
                safe_dirs.append(name)
            directories[:] = safe_dirs
            for name in filenames:
                target = base_path / name
                if target.suffix.casefold() == NOTE_SUFFIX and not _is_reparse(target):
                    notes.append(target)
        notes.sort(key=lambda item: tuple(_natural_key(part) for part in item.relative_to(self.root).parts))
        return notes

    def tree(self) -> dict:
        self.ensure_root()

        def visit(folder: Path) -> list[dict]:
            result: list[dict] = []
            try:
                entries = list(folder.iterdir())
            except OSError as err:
                raise NotesError(f"读取笔记目录失败：{err}", status=500, code="read_failed") from err
            entries.sort(key=lambda item: (not item.is_dir(), _natural_key(item.name)))
            for entry in entries:
                low = entry.name.casefold()
                if low.endswith(".assets") or low.startswith(".relatum-") or low == ".trash":
                    continue
                if _is_reparse(entry):
                    continue
                relative = entry.relative_to(self.root).as_posix()
                if entry.is_dir():
                    result.append({
                        "kind": "folder",
                        "name": entry.name,
                        "path": relative,
                        "children": visit(entry),
                    })
                elif entry.is_file() and entry.suffix.casefold() == NOTE_SUFFIX:
                    try:
                        stat = entry.stat()
                    except OSError:
                        continue
                    result.append({
                        "kind": "note",
                        "name": entry.stem,
                        "fileName": entry.name,
                        "path": relative,
                        "modifiedNs": stat.st_mtime_ns,
                        "size": stat.st_size,
                    })
            return result

        entries = visit(self.root)
        return {"version": 1, "entries": entries}

    def _documents(self) -> dict[str, dict]:
        documents: dict[str, dict] = {}
        live_paths: set[str] = set()
        for target in self._note_paths():
            relative = target.relative_to(self.root).as_posix()
            live_paths.add(relative)
            try:
                stat = target.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                cached = self._document_cache.get(relative)
                if cached and cached.get("signature") == signature:
                    documents[relative] = cached
                    continue
                raw = self._read_note_bytes(target)
                text = self._decode_note(raw)
            except (NotesError, OSError):
                # 一个被外部复制进来的损坏/超大文件不应拖垮其它笔记的链接面板。
                continue
            document = {
                "path": relative,
                "raw": raw,
                "text": text,
                "revision": _revision(raw),
                "mentions": _wiki_mentions(text),
                "signature": signature,
            }
            self._document_cache[relative] = document
            documents[relative] = document
        for stale in set(self._document_cache) - live_paths:
            self._document_cache.pop(stale, None)
        return documents

    def _cache_document(self, relative: str, content: bytes) -> None:
        target = self._absolute(relative)
        try:
            stat = target.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            self._document_cache.pop(relative, None)
            return
        text = self._decode_note(content)
        self._document_cache[relative] = {
            "path": relative,
            "raw": content,
            "text": text,
            "revision": _revision(content),
            "mentions": _wiki_mentions(text),
            "signature": signature,
        }

    def invalidate(self) -> None:
        """在文件被系统回收站或外部批量操作移动后清空增量缓存。"""
        self._document_cache.clear()

    @staticmethod
    def _resolver(paths: list[str]) -> tuple[dict[str, str], dict[str, list[str]]]:
        exact: dict[str, str] = {}
        stems: dict[str, list[str]] = {}
        for path in paths:
            without_suffix = _strip_note_suffix(path)
            exact[without_suffix.casefold()] = path
            stem = PurePosixPath(path).stem.casefold()
            stems.setdefault(stem, []).append(path)
        return exact, stems

    @staticmethod
    def _resolve_wiki(base: str, exact: dict[str, str], stems: dict[str, list[str]]) -> tuple[str | None, str]:
        clean = urllib.parse.unquote(base.strip()).replace("\\", "/").strip("/")
        clean = _strip_note_suffix(clean)
        if not clean or clean.startswith(".") or "/../" in f"/{clean}/":
            return None, "invalid"
        exact_target = exact.get(clean.casefold())
        if exact_target:
            return exact_target, "resolved"
        if "/" in clean:
            return None, "missing"
        candidates = stems.get(clean.casefold(), [])
        if len(candidates) == 1:
            return candidates[0], "resolved"
        if len(candidates) > 1:
            return None, "ambiguous"
        return None, "missing"

    def load(self, relative: object) -> dict:
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        raw = self._read_note_bytes(target)
        content = self._decode_note(raw)
        self._cache_document(normalized, raw)
        return {
            "path": normalized,
            "content": content,
            "revision": _revision(raw),
        }

    def links(self, relative: object) -> dict:
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        raw = self._read_note_bytes(target)
        content = self._decode_note(raw)
        documents = self._documents()
        exact, stems = self._resolver(list(documents))
        outgoing: list[dict] = []
        backlinks: list[dict] = []
        seen_outgoing: set[tuple[str, str]] = set()
        current = documents.get(normalized, {
            "mentions": _wiki_mentions(content),
        })
        for mention in current["mentions"]:
            resolved, state = self._resolve_wiki(mention["base"], exact, stems)
            key = (resolved or mention["base"].casefold(), state)
            if key in seen_outgoing:
                continue
            seen_outgoing.add(key)
            outgoing.append({
                "label": mention["alias"] or PurePosixPath(mention["base"]).name,
                "rawTarget": mention["base"],
                "path": resolved or "",
                "state": state,
                "line": mention["line"],
                "excerpt": mention["excerpt"],
            })
        for source_path, document in documents.items():
            if source_path == normalized:
                continue
            for mention in document["mentions"]:
                resolved, state = self._resolve_wiki(mention["base"], exact, stems)
                if state == "resolved" and resolved == normalized:
                    backlinks.append({
                        "path": source_path,
                        "label": PurePosixPath(source_path).stem,
                        "line": mention["line"],
                        "excerpt": mention["excerpt"],
                    })
        backlinks.sort(key=lambda item: (_natural_key(item["path"]), item["line"]))
        return {
            "path": normalized,
            "revision": _revision(raw),
            "outgoing": outgoing,
            "backlinks": backlinks,
        }

    def _history_bucket(self, relative: str) -> Path:
        digest = hashlib.sha256(relative.casefold().encode("utf-8")).hexdigest()[:32]
        return self.recovery_root / digest

    def _history_manifest(self, relative: str, *, create: bool = False) -> tuple[Path, dict]:
        self.ensure_recovery_root()
        bucket = self._history_bucket(relative)
        manifest_path = bucket / "manifest.json"
        if manifest_path.is_file():
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
        else:
            data = {}
        if not isinstance(data, dict) or data.get("version") != 1 or data.get("path") != relative:
            data = {"version": 1, "path": relative, "snapshots": []}
        if not isinstance(data.get("snapshots"), list):
            data["snapshots"] = []
        if create:
            bucket.mkdir(parents=True, exist_ok=True)
            if _is_reparse(bucket):
                raise NotesError("恢复历史目录不能是链接或重解析点", status=403, code="unsafe_path")
        return manifest_path, data

    def _write_history_manifest(self, manifest_path: Path, data: dict) -> None:
        self.atomic_text(manifest_path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def snapshot(self, relative: object, content: bytes | str, *, reason: str = "autosave",
                 force: bool = False) -> dict | None:
        normalized = self.normalize_path(relative)
        raw = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        if len(raw) > MAX_NOTE_BYTES:
            return None
        now = time.time()
        manifest_path, manifest = self._history_manifest(normalized, create=True)
        snapshots = [item for item in manifest["snapshots"] if isinstance(item, dict)]
        cutoff = now - NOTE_HISTORY_RETENTION_SECONDS
        kept: list[dict] = []
        for item in snapshots:
            created = float(item.get("createdEpoch", 0) or 0)
            file_name = str(item.get("file") or "")
            if created >= cutoff and file_name:
                kept.append(item)
            else:
                try:
                    (manifest_path.parent / file_name).unlink(missing_ok=True)
                except OSError:
                    pass
        snapshots = kept
        revision = _revision(raw)
        if snapshots and snapshots[-1].get("revision") == revision:
            manifest["snapshots"] = snapshots
            self._write_history_manifest(manifest_path, manifest)
            return None
        if not force and snapshots:
            last = float(snapshots[-1].get("createdEpoch", 0) or 0)
            if now - last < NOTE_HISTORY_INTERVAL_SECONDS:
                manifest["snapshots"] = snapshots
                self._write_history_manifest(manifest_path, manifest)
                return None
        snapshot_id = f"{int(now * 1000)}-{uuid.uuid4().hex[:8]}"
        file_name = snapshot_id + ".md"
        self.atomic_bytes(manifest_path.parent / file_name, raw)
        item = {
            "id": snapshot_id,
            "file": file_name,
            "createdAt": datetime.fromtimestamp(now, timezone.utc).isoformat().replace("+00:00", "Z"),
            "createdEpoch": now,
            "revision": revision,
            "reason": reason,
            "size": len(raw),
        }
        snapshots.append(item)
        manifest["snapshots"] = snapshots
        self._write_history_manifest(manifest_path, manifest)
        return item

    def history(self, relative: object) -> dict:
        normalized = self.normalize_path(relative)
        self._read_note_bytes(self._absolute(normalized))
        _, manifest = self._history_manifest(normalized)
        items = []
        for item in reversed(manifest.get("snapshots", [])):
            if not isinstance(item, dict):
                continue
            items.append({key: item.get(key) for key in (
                "id", "createdAt", "revision", "reason", "size",
            )})
        return {"path": normalized, "versions": items}

    def history_version(self, relative: object, version_id: object) -> dict:
        normalized = self.normalize_path(relative)
        if not isinstance(version_id, str) or not re.fullmatch(r"[0-9]+-[0-9a-f]{8}", version_id):
            raise NotesError("历史版本标识无效")
        manifest_path, manifest = self._history_manifest(normalized)
        item = next((entry for entry in manifest.get("snapshots", [])
                     if isinstance(entry, dict) and entry.get("id") == version_id), None)
        if not item:
            raise NotesError("历史版本不存在", status=404, code="not_found")
        target = manifest_path.parent / str(item.get("file") or "")
        if not target.is_file() or _is_reparse(target):
            raise NotesError("历史版本不存在", status=404, code="not_found")
        raw = target.read_bytes()
        return {
            "path": normalized,
            "id": version_id,
            "content": self._decode_note(raw),
            "createdAt": item.get("createdAt"),
            "revision": item.get("revision"),
        }

    def restore_history(self, relative: object, version_id: object) -> dict:
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        current = self._read_note_bytes(target)
        version = self.history_version(normalized, version_id)
        self.snapshot(normalized, current, reason="before-restore", force=True)
        content = str(version.get("content") or "")
        encoded = content.encode("utf-8")
        self.atomic_bytes(target, encoded)
        self._cache_document(normalized, encoded)
        return {"path": normalized, "content": content, "revision": _revision(encoded)}

    def relocate_history(self, source: str, destination: str, *, folder: bool) -> None:
        if not self.recovery_root.is_dir():
            return
        prefix = source.rstrip("/") + "/"
        for bucket in list(self.recovery_root.iterdir()):
            manifest_path = bucket / "manifest.json"
            if not bucket.is_dir() or _is_reparse(bucket) or not manifest_path.is_file():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            old_path = manifest.get("path") if isinstance(manifest, dict) else None
            if old_path == source:
                new_path = destination
            elif folder and isinstance(old_path, str) and old_path.startswith(prefix):
                new_path = destination.rstrip("/") + "/" + old_path[len(prefix):]
            else:
                continue
            manifest["path"] = new_path
            new_bucket = self._history_bucket(new_path)
            if new_bucket.exists() and new_bucket != bucket:
                continue
            self._write_history_manifest(manifest_path, manifest)
            if new_bucket != bucket:
                bucket.rename(new_bucket)

    def create(self, parent: object, name: object, kind: object, *, content: object = "",
               create_parents: bool = False) -> dict:
        parent_relative = self.normalize_path(parent, allow_root=True)
        if not isinstance(name, str) or not name.strip():
            raise NotesError("请输入名称")
        clean_name = unicodedata.normalize("NFC", name.strip())
        requested_kind = str(kind or "note")
        if requested_kind not in ("note", "folder"):
            raise NotesError("kind 只能是 note 或 folder")
        if requested_kind == "note" and not clean_name.casefold().endswith(NOTE_SUFFIX):
            clean_name += NOTE_SUFFIX
        relative = PurePosixPath(parent_relative, clean_name).as_posix() if parent_relative else clean_name
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        parent_target = target.parent
        if create_parents:
            # 逐层创建并在每一步复查大小写冲突及重解析点。
            current = self.root
            for part in target.relative_to(self.root).parts[:-1]:
                collision = self._case_collision(current, part)
                if collision and not collision.is_dir():
                    raise NotesError(f"已有同名文件：{collision.name}", status=409, code="exists")
                current = collision or (current / part)
                current.mkdir(exist_ok=True)
                if _is_reparse(current):
                    raise NotesError("路径包含链接或重解析点", status=403, code="unsafe_path")
            parent_target = current
        if not parent_target.is_dir():
            raise NotesError("目标文件夹不存在", status=404, code="parent_missing")
        collision = self._case_collision(parent_target, target.name)
        if collision:
            raise NotesError(f"已有同名项目：{collision.name}", status=409, code="exists")
        if requested_kind == "folder":
            target.mkdir()
        else:
            if target.suffix.casefold() != NOTE_SUFFIX:
                raise NotesError("笔记文件必须使用 .md 后缀")
            text = content if isinstance(content, str) else ""
            if len(text.encode("utf-8")) > MAX_NOTE_BYTES:
                raise NotesError("笔记过大（单文件上限 4MB）", status=413, code="too_large")
            self.atomic_text(target, text)
            self._cache_document(normalized, text.encode("utf-8"))
        return {"path": normalized, "kind": requested_kind}

    def create_timestamp_note(self, parent: object, *, content: object = "",
                              timestamp: datetime | None = None) -> dict:
        parent_relative = self.normalize_path(parent, allow_root=True)
        parent_target = self._absolute(parent_relative, allow_root=True)
        if not parent_target.is_dir():
            raise NotesError("目标文件夹不存在", status=404, code="parent_missing")
        base = (timestamp or datetime.now()).strftime("%Y-%m-%d-%H%M%S")
        name = base + NOTE_SUFFIX
        counter = 2
        while self._case_collision(parent_target, name):
            name = f"{base}-{counter}{NOTE_SUFFIX}"
            counter += 1
        return self.create(parent_relative, name, "note", content=content)

    def create_untitled_folder(self, parent: object, *, base_name: str = "新建文件夹") -> dict:
        parent_relative = self.normalize_path(parent, allow_root=True)
        parent_target = self._absolute(parent_relative, allow_root=True)
        if not parent_target.is_dir():
            raise NotesError("目标文件夹不存在", status=404, code="parent_missing")
        name = base_name
        counter = 2
        while self._case_collision(parent_target, name):
            name = f"{base_name}-{counter}"
            counter += 1
        return self.create(parent_relative, name, "folder")

    def save(self, relative: object, content: object, expected_revision: object) -> dict:
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        if target.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("只能保存 Markdown 笔记")
        if not isinstance(content, str):
            raise NotesError("content 必须是文本")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_NOTE_BYTES:
            raise NotesError("笔记过大（单文件上限 4MB）", status=413, code="too_large")
        if target.exists():
            current = self._read_note_bytes(target)
            current_revision = _revision(current)
            if current == encoded:
                self._cache_document(normalized, current)
                return {"path": normalized, "revision": current_revision}
            external = not isinstance(expected_revision, str) or expected_revision != current_revision
            self.snapshot(
                normalized, current,
                reason="external-overwrite" if external else "autosave",
                force=external,
            )
        elif not target.parent.is_dir():
            raise NotesError("目标文件夹不存在", status=404, code="parent_missing")
        self.atomic_text(target, content)
        self._cache_document(normalized, encoded)
        return {"path": normalized, "revision": _revision(encoded)}

    def _post_move_paths(self, paths: list[str], source: str, destination: str,
                         source_is_folder: bool) -> dict[str, str]:
        mapping: dict[str, str] = {}
        prefix = source.rstrip("/") + "/"
        for path in paths:
            if path == source:
                mapping[path] = destination
            elif source_is_folder and path.startswith(prefix):
                mapping[path] = destination.rstrip("/") + "/" + path[len(prefix):]
            else:
                mapping[path] = path
        return mapping

    def _rewrite_for_move(self, documents: dict[str, dict], mapping: dict[str, str]) -> tuple[dict[str, str], list[str]]:
        old_exact, old_stems = self._resolver(list(documents))
        post_paths = list(mapping.values())
        new_exact, new_stems = self._resolver(post_paths)
        moved_targets = {old: new for old, new in mapping.items() if old != new}
        updates: dict[str, str] = {}
        warnings: list[str] = []

        for old_source, document in documents.items():
            text = document["text"]
            replacements: list[tuple[int, int, str]] = []
            for mention in document["mentions"]:
                old_target, old_state = self._resolve_wiki(mention["base"], old_exact, old_stems)
                if old_state == "ambiguous":
                    warnings.append(f"{old_source}:{mention['line']} 的双链存在重名歧义，未改写")
                    continue
                if old_state != "resolved" or old_target not in moved_targets:
                    continue
                new_target = moved_targets[old_target]
                still_resolved, new_state = self._resolve_wiki(mention["base"], new_exact, new_stems)
                if new_state == "resolved" and still_resolved == new_target:
                    continue
                new_base = _strip_note_suffix(new_target)
                inner = new_base + mention["suffix"]
                if mention["alias"]:
                    inner += "|" + mention["alias"]
                replacements.append((mention["start"], mention["end"], "[[" + inner + "]]"))

            new_source = mapping[old_source]
            if old_source in moved_targets:
                old_stem = PurePosixPath(old_source).stem
                new_stem = PurePosixPath(new_source).stem
                if old_stem != new_stem:
                    for match in _IMAGE_RE.finditer(text):
                        target = match.group(2).strip()
                        old_prefix = old_stem + ".assets/"
                        if target.startswith(old_prefix):
                            start = match.start(2) + len(target) - len(target.lstrip())
                            end = start + len(target)
                            replacements.append((start, end, new_stem + ".assets/" + target[len(old_prefix):]))

            if replacements:
                for start, end, replacement in sorted(replacements, reverse=True):
                    text = text[:start] + replacement + text[end:]
                updates[new_source] = text
        # 同一句歧义只报告一次，避免长文重复刷屏。
        return updates, list(dict.fromkeys(warnings))[:50]

    def move(self, source: object, destination: object) -> dict:
        source_rel = self.normalize_path(source)
        destination_rel = self.normalize_path(destination)
        if source_rel == destination_rel:
            return {"path": destination_rel, "rewritten": 0, "warnings": []}
        source_path = self._absolute(source_rel)
        destination_path = self._absolute(destination_rel)
        if not source_path.exists():
            raise NotesError("要移动的项目不存在", status=404, code="not_found")
        if _is_reparse(source_path):
            raise NotesError("不能移动链接或重解析点", status=403, code="unsafe_path")
        source_is_folder = source_path.is_dir()
        if source_path.is_file() and source_path.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("只能移动笔记或普通文件夹")
        if source_path.is_file() and destination_path.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("笔记目标路径必须使用 .md 后缀")
        if source_is_folder:
            try:
                destination_path.resolve(strict=False).relative_to(source_path.resolve())
            except ValueError:
                pass
            else:
                raise NotesError("不能把文件夹移动到它自身内部")
        if not destination_path.parent.is_dir():
            raise NotesError("目标文件夹不存在", status=404, code="parent_missing")
        collision = self._case_collision(destination_path.parent, destination_path.name, ignore=source_path)
        if collision:
            raise NotesError(f"目标位置已有同名项目：{collision.name}", status=409, code="exists")

        documents = self._documents()
        mapping = self._post_move_paths(list(documents), source_rel, destination_rel, source_is_folder)
        updates, warnings = self._rewrite_for_move(documents, mapping)
        reverse_mapping = {new: old for old, new in mapping.items()}
        stage = self.root / f".relatum-txn-{uuid.uuid4().hex}"
        stage.mkdir()
        backups: list[tuple[Path, str, str]] = []
        moved = False
        companion_moved = False
        source_companion = source_path.with_name(source_path.stem + ".assets") if source_path.is_file() else None
        destination_companion = destination_path.with_name(destination_path.stem + ".assets") if source_path.is_file() else None
        companion_case_only = bool(
            source_companion and destination_companion
            and source_companion.parent == destination_companion.parent
            and source_companion.name.casefold() == destination_companion.name.casefold()
        )
        if source_companion and source_companion.exists():
            if _is_reparse(source_companion):
                raise NotesError("伴生素材目录不能是链接或重解析点", status=403, code="unsafe_path")
            if destination_companion and destination_companion.exists() and not companion_case_only:
                raise NotesError("目标伴生素材目录已存在", status=409, code="exists")
        try:
            for index, post_relative in enumerate(updates):
                pre_relative = reverse_mapping.get(post_relative, post_relative)
                pre_path = self._absolute(pre_relative)
                backup = stage / f"{index}.bak"
                shutil.copyfile(pre_path, backup)
                backups.append((backup, pre_relative, post_relative))
            # 只复检真实参与移动或引用改写的文档；未变化文件不会阻塞拖放。
            affected = set(updates)
            affected.update(path for path, moved_path in mapping.items() if path != moved_path)
            for relative in affected:
                pre_relative = reverse_mapping.get(relative, relative)
                document = documents.get(pre_relative)
                if not document:
                    continue
                current = self._read_note_bytes(self._absolute(pre_relative))
                if _revision(current) != document["revision"]:
                    raise NotesError("移动期间有笔记被外部修改，请重试", status=409, code="move_changed")

            case_only = (source_path.parent == destination_path.parent
                         and source_path.name.casefold() == destination_path.name.casefold())
            if case_only:
                intermediate = source_path.with_name(f".relatum-case-{uuid.uuid4().hex}")
                source_path.rename(intermediate)
                intermediate.rename(destination_path)
            else:
                source_path.rename(destination_path)
            moved = True
            if source_companion and source_companion.exists():
                if companion_case_only:
                    intermediate_assets = source_companion.with_name(f".relatum-case-{uuid.uuid4().hex}")
                    source_companion.rename(intermediate_assets)
                    intermediate_assets.rename(destination_companion)
                else:
                    source_companion.rename(destination_companion)
                companion_moved = True
            for post_relative, text in updates.items():
                self.atomic_text(self._absolute(post_relative), text)
            self.relocate_history(source_rel, destination_rel, folder=source_is_folder)
            self._document_cache.clear()
        except Exception:
            for backup, pre_relative, post_relative in reversed(backups):
                current_relative = post_relative if moved else pre_relative
                try:
                    if backup.exists() and self._absolute(current_relative).exists():
                        self.atomic_bytes(self._absolute(current_relative), backup.read_bytes())
                except Exception:
                    pass
            if companion_moved and destination_companion and destination_companion.exists() and source_companion:
                try:
                    if companion_case_only:
                        intermediate_assets = destination_companion.with_name(f".relatum-case-{uuid.uuid4().hex}")
                        destination_companion.rename(intermediate_assets)
                        intermediate_assets.rename(source_companion)
                    else:
                        destination_companion.rename(source_companion)
                except OSError:
                    pass
            if moved and destination_path.exists() and not source_path.exists():
                try:
                    destination_path.rename(source_path)
                except OSError:
                    pass
            raise
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        return {
            "path": destination_rel,
            "rewritten": len(updates),
            "warnings": warnings,
        }

    def upload_image(self, note: object, name: object, content: bytes, media_type: object = "") -> dict:
        note_rel = self.normalize_path(note)
        note_path = self._absolute(note_rel)
        self._read_note_bytes(note_path)
        if not isinstance(name, str) or not name.strip():
            raise NotesError("缺少图片名称")
        original_name = unicodedata.normalize("NFC", name.strip())
        if Path(original_name).name != original_name:
            raise NotesError("图片名称不能包含路径")
        self.normalize_path(original_name, allow_assets=True)
        suffix = Path(original_name).suffix.casefold()
        expected_type = NOTE_IMAGE_TYPES.get(suffix)
        if not expected_type:
            raise NotesError("只支持 PNG、JPEG、WebP、GIF 或 BMP 图片", status=403, code="unsupported_type")
        if media_type and str(media_type).split(";", 1)[0].strip().casefold() != expected_type:
            raise NotesError("图片类型与扩展名不一致")
        if not content:
            raise NotesError("图片为空")
        if len(content) > MAX_NOTE_IMAGE_BYTES:
            raise NotesError("图片过大（上限 40MB）", status=413, code="too_large")
        if _sniff_image_media_type(content) != expected_type:
            raise NotesError("图片内容与扩展名不一致", status=400, code="invalid_image")
        digest = hashlib.sha256(content).hexdigest()[:12]
        safe_stem = re.sub(r"[^\w\-.\u4e00-\u9fff]+", "-", Path(original_name).stem,
                           flags=re.UNICODE).strip("-.") or "image"
        asset_root = note_path.with_name(note_path.stem + ".assets")
        if asset_root.exists() and _is_reparse(asset_root):
            raise NotesError("伴生素材目录不能是链接或重解析点", status=403, code="unsafe_path")
        images = asset_root / "images"
        images.mkdir(parents=True, exist_ok=True)
        if _is_reparse(images):
            raise NotesError("图片目录不能是链接或重解析点", status=403, code="unsafe_path")
        target = images / f"{safe_stem}-{digest}{suffix}"
        if target.exists():
            if target.read_bytes() != content:
                target = images / f"{safe_stem}-{digest}-{uuid.uuid4().hex[:6]}{suffix}"
        if not target.exists():
            self.atomic_bytes(target, content)
        markdown_path = os.path.relpath(target, note_path.parent).replace("\\", "/")
        return {"path": markdown_path, "name": original_name, "mediaType": expected_type}

    def resolve_image(self, note: object, source: object) -> tuple[Path, str]:
        note_rel = self.normalize_path(note)
        note_path = self._absolute(note_rel)
        self._read_note_bytes(note_path)
        if not isinstance(source, str) or not source.strip():
            raise NotesError("缺少图片路径")
        raw = urllib.parse.unquote(source.strip().split("#", 1)[0])
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", raw) or raw.startswith(("/", "\\")):
            raise NotesError("只允许笔记库内的本地图片", status=403, code="unsafe_path")
        parts = list(PurePosixPath(note_path.parent.relative_to(self.root).as_posix()).parts)
        for part in raw.replace("\\", "/").split("/"):
            if not part or part == ".":
                continue
            if part == "..":
                if not parts:
                    raise NotesError("图片路径越界", status=403, code="unsafe_path")
                parts.pop()
                continue
            parts.append(part)
        combined = "/".join(parts)
        normalized = self.normalize_path(combined, allow_assets=True)
        target = self._absolute(normalized, allow_assets=True)
        media_type = NOTE_IMAGE_TYPES.get(target.suffix.casefold())
        if not media_type:
            raise NotesError("不支持这种图片格式", status=403, code="unsupported_type")
        if not target.is_file():
            raise NotesError("图片不存在", status=404, code="not_found")
        if _is_reparse(target):
            raise NotesError("图片不能是链接或重解析点", status=403, code="unsafe_path")
        if target.stat().st_size > MAX_NOTE_IMAGE_BYTES:
            raise NotesError("图片过大（上限 40MB）", status=413, code="too_large")
        return target, media_type

    def assets_directory(self, note: object) -> Path:
        note_rel = self.normalize_path(note)
        note_path = self._absolute(note_rel)
        self._read_note_bytes(note_path)
        target = note_path.with_name(note_path.stem + ".assets")
        if not target.is_dir():
            raise NotesError("当前笔记还没有伴生素材", status=404, code="not_found")
        if _is_reparse(target):
            raise NotesError("伴生素材目录不能是链接或重解析点", status=403, code="unsafe_path")
        return target

    def reveal_target(self, relative: object) -> Path:
        normalized = self.normalize_path(relative, allow_root=True)
        target = self._absolute(normalized, allow_root=True)
        if not target.exists():
            raise NotesError("笔记或文件夹不存在", status=404, code="not_found")
        if _is_reparse(target):
            raise NotesError("不能显示链接或重解析点", status=403, code="unsafe_path")
        if target.is_file() and target.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("只能显示笔记或普通文件夹", status=403, code="unsupported_type")
        return target

    def trash_targets(self, relative: object) -> tuple[str, list[Path]]:
        normalized = self.normalize_path(relative)
        target = self._absolute(normalized)
        if not target.exists():
            raise NotesError("要移到回收站的项目不存在", status=404, code="not_found")
        if _is_reparse(target):
            raise NotesError("不能处理链接或重解析点", status=403, code="unsafe_path")
        if target.is_file() and target.suffix.casefold() != NOTE_SUFFIX:
            raise NotesError("只能处理 Markdown 笔记或普通文件夹")
        targets = [target]
        if target.is_file():
            companion = target.with_name(target.stem + ".assets")
            if companion.exists():
                if not companion.is_dir() or _is_reparse(companion):
                    raise NotesError("伴生素材目录不安全", status=403, code="unsafe_path")
                targets.append(companion)
        return normalized, targets

    def begin_import(self, destination: object) -> dict:
        destination_rel = self.normalize_path(destination, allow_root=True)
        target = self._absolute(destination_rel, allow_root=True)
        if not target.is_dir() or _is_reparse(target):
            raise NotesError("导入目标文件夹不存在", status=404, code="parent_missing")
        token = uuid.uuid4().hex
        stage = self.root / f".relatum-import-{token}"
        stage.mkdir()
        self.atomic_text(stage / "manifest.json", json.dumps({
            "version": 1,
            "destination": destination_rel,
            "createdEpoch": time.time(),
        }, ensure_ascii=False))
        return {"token": token}

    def _import_stage(self, token: object) -> tuple[Path, dict]:
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
            raise NotesError("导入会话无效", status=404, code="not_found")
        stage = self.root / f".relatum-import-{token}"
        manifest_path = stage / "manifest.json"
        if not stage.is_dir() or _is_reparse(stage) or not manifest_path.is_file():
            raise NotesError("导入会话不存在", status=404, code="not_found")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            raise NotesError("导入会话损坏", status=409, code="invalid_session") from err
        return stage, manifest

    def upload_import_file(self, token: object, relative: object, content: bytes,
                           media_type: object = "") -> dict:
        stage, manifest = self._import_stage(token)
        normalized = self.normalize_path(relative, allow_assets=True)
        if any(part.startswith(".") for part in PurePosixPath(normalized).parts):
            raise NotesError("不能导入隐藏文件")
        suffix = PurePosixPath(normalized).suffix.casefold()
        if suffix == NOTE_SUFFIX:
            if len(content) > MAX_NOTE_BYTES:
                raise NotesError("Markdown 文件过大（上限 4MB）", status=413, code="too_large")
            self._decode_note(content)
        elif suffix in NOTE_IMAGE_TYPES:
            if len(content) > MAX_NOTE_IMAGE_BYTES:
                raise NotesError("图片过大（上限 40MB）", status=413, code="too_large")
            expected = NOTE_IMAGE_TYPES[suffix]
            claimed = str(media_type or "").split(";", 1)[0].strip().casefold()
            if claimed and claimed != expected:
                raise NotesError("图片类型与扩展名不一致")
            if _sniff_image_media_type(content) != expected:
                raise NotesError("图片内容与扩展名不一致", code="invalid_image")
        else:
            raise NotesError("只支持 Markdown 和栅格图片", status=403, code="unsupported_type")
        target = stage.joinpath(*PurePosixPath(normalized).parts)
        if target.exists():
            raise NotesError("导入会话中存在同名文件", status=409, code="exists")
        current_bytes = int(manifest.get("uploadedBytes", 0) or 0)
        current_files = int(manifest.get("uploadedFiles", 0) or 0)
        if current_files >= MAX_NOTE_IMPORT_FILES or current_bytes + len(content) > MAX_NOTE_IMPORT_BYTES:
            raise NotesError("导入内容超出单次范围", status=413, code="import_too_large")
        self.atomic_bytes(target, content)
        manifest["uploadedBytes"] = current_bytes + len(content)
        manifest["uploadedFiles"] = current_files + 1
        self.atomic_text(stage / "manifest.json", json.dumps(manifest, ensure_ascii=False))
        return {"path": normalized}

    def _unique_import_target(self, parent: Path, name: str) -> Path:
        candidate = parent / name
        if not self._case_collision(parent, name):
            return candidate
        path = Path(name)
        counter = 2
        while True:
            candidate_name = f"{path.stem}-{counter}{path.suffix}" if path.suffix else f"{name}-{counter}"
            if not self._case_collision(parent, candidate_name):
                return parent / candidate_name
            counter += 1

    def commit_import(self, token: object) -> dict:
        stage, manifest = self._import_stage(token)
        destination_rel = self.normalize_path(manifest.get("destination", ""), allow_root=True)
        destination = self._absolute(destination_rel, allow_root=True)
        children = [item for item in stage.iterdir() if item.name != "manifest.json"]
        if not children:
            shutil.rmtree(stage, ignore_errors=True)
            return {"items": [], "notes": []}
        moved: list[tuple[Path, Path]] = []
        result: list[str] = []
        try:
            imported_files = 0
            imported_bytes = 0
            for base, directories, filenames in os.walk(stage, followlinks=False):
                base_path = Path(base)
                for directory in directories:
                    if _is_reparse(base_path / directory):
                        raise NotesError("导入范围包含链接或重解析点", status=403, code="unsafe_path")
                for filename in filenames:
                    if filename == "manifest.json" and base_path == stage:
                        continue
                    item = base_path / filename
                    if _is_reparse(item):
                        raise NotesError("导入范围包含链接或重解析点", status=403, code="unsafe_path")
                    imported_files += 1
                    imported_bytes += item.stat().st_size
            if imported_files > MAX_NOTE_IMPORT_FILES or imported_bytes > MAX_NOTE_IMPORT_BYTES:
                raise NotesError("导入内容超出单次范围", status=413, code="import_too_large")
            for child in sorted(children, key=lambda item: _natural_key(item.name)):
                target = self._unique_import_target(destination, child.name)
                child.rename(target)
                moved.append((target, child))
                result.append(target.relative_to(self.root).as_posix())
        except Exception:
            for target, original in reversed(moved):
                try:
                    if target.exists() and not original.exists():
                        target.rename(original)
                except OSError:
                    pass
            raise
        finally:
            if moved:
                shutil.rmtree(stage, ignore_errors=True)
        self._document_cache.clear()
        note_paths: list[str] = []
        for root_path in result:
            target = self._absolute(root_path, allow_assets=True)
            if target.is_file() and target.suffix.casefold() == NOTE_SUFFIX:
                note_paths.append(root_path)
            elif target.is_dir():
                note_paths.extend(item.relative_to(self.root).as_posix()
                                  for item in target.rglob("*.md") if item.is_file() and not _is_reparse(item))
        return {"items": result, "notes": note_paths}

    def abort_import(self, token: object) -> dict:
        stage, _ = self._import_stage(token)
        shutil.rmtree(stage)
        return {"ok": True}

"""画布 — 本地画布工具。

阶段 1a：在静态服务基础上加上 .canvas 文件流转的几个 JSON API
（最近列表 / 新建 / 打开 / 保存 / 系统文件对话框），并支持
`python app.py 路径\\to.canvas` 启动参数（协议 A）。

设计原则：核心服务零依赖（Python 标准库 + 原生 HTML/CSS/JS）。
桌面成品由 desktop.py 提供轻量 WebView 外壳，不改变画布数据与交互核心。
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import http.server
import json
import math
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import unicodedata
import webbrowser
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

from ai_plan import (
    AIPlanError,
    PLAN_ACTIONS,
    build_plan_system,
    build_repair_instruction,
    parse_plan,
)

# 桌面打包版把内置资源放在运行时资源目录。便携版用户数据留在 EXE
# 旁边；具有 MSIX 包身份时改用 %LOCALAPPDATA%\Relatum，避免写只读安装目录。
SOURCE_ROOT = Path(__file__).resolve().parent
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", SOURCE_ROOT))


def _has_package_identity() -> bool:
    """Return whether this process is running with an MSIX package identity."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        length = ctypes.c_uint32(0)
        result = ctypes.windll.kernel32.GetCurrentPackageFullName(
            ctypes.byref(length), None,
        )
        return result == 122  # ERROR_INSUFFICIENT_BUFFER: a package name exists.
    except (AttributeError, OSError):
        return False


def _resolve_user_root(*, packaged: bool | None = None) -> Path:
    """Choose a writable root without changing portable/source-mode behavior."""
    override = os.environ.get("RELATUM_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    is_packaged = _has_package_identity() if packaged is None else packaged
    if is_packaged:
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app_data:
            return Path(local_app_data) / "Relatum"
        return Path.home() / "AppData" / "Local" / "Relatum"
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return SOURCE_ROOT


PACKAGED = _has_package_identity()
ROOT = _resolve_user_root(packaged=PACKAGED)
ASSETS = RESOURCE_ROOT / "assets"
CANVASES = ROOT / "canvases"
TRASH = CANVASES / "回收站"   # 右键删除 = 移到这里（用户自己管理，可恢复）
DATA = ROOT / "data"
RECENT_FILE = DATA / "recent.json"
RECENT_BACKUP_FILE = DATA / "recent.backup.json"
BACKGROUND_PREF_FILE = DATA / "background.json"
BACKGROUND_UPLOAD_DIR = DATA / "backgrounds"
VIEWPORT_STATE_FILE = DATA / "viewport.json"
STUDY_FILE = DATA / "study.json"
STUDY_ARCHIVE_DIR = DATA / "学习归档"
CANVAS_ARCHIVE_DIR = DATA / "画布归档"   # 编辑器顶栏「归档」：移走划线节点 + 这里留轻量记录
NOTES_FILE = DATA / "notes.json"   # 起步页「速记」便签墙（独立数据，不进 .canvas）
START_STICKY_NOTES_FILE = DATA / "start-sticky-notes.json"   # 起步页跨页便签（不含「速记」页）
FOCUS_FILE = DATA / "focus.json"   # 起步页「专注钟」专注记录（自成一体，不进 .canvas；供活跃页专注镜头汇总）
CANVAS_ACTIVITY_FILE = DATA / "canvas-activity.json"   # 画布前台使用时长与创建/修改足迹（不写进 .canvas）
DAILY_FILE = DATA / "daily.json"   # 专注页「每日任务」习惯清单（每天重置勾选，累计天数/分钟；自成一体，不进 .canvas）
DAILY_BACKUP_FILE = DATA / "daily.backup.json"
DIARY_DIR = DATA / "diary"   # 起步页「日历」日记：每天一份 Markdown，与学习/速记数据解耦
COUNTDOWN_FILE = DATA / "countdown.json"   # 日历页轻量倒数日：目标事件 + 目标日期
TEMPLATES_FILE = DATA / "templates.json"   # 「模板」库：常用节点组的可复用快照（全局，所有画布共用，不进 .canvas）
REVIEW_DB_FILE = DATA / "review.db"   # 独立复习卡片、调度状态与复习事件；不扫描、不改写 .canvas

DEFAULT_PORT = 8765
PORT_ATTEMPTS = 20
RECENT_LIMIT = 30
RECENT_SCHEMA = 3
RECENT_RANK_STEP = 1024
RECENT_STATS_BATCH_LIMIT = 200
RUNTIME_SCHEMA = 3

# 额外授权目录（--allow-dir）：这些目录下的 .canvas 视为可 load/save，
# 无需先登记 recent。供可信外部调用方按协议 A 整目录授权用。
# 默认空 = 原行为完全不变。
ALLOWED_EXTRA_DIRS: list[Path] = []

# C2：外部链接——拒绝"用系统默认程序打开"的危险后缀（可执行 / 脚本类）。
# 这是 V1 唯一有真实安全风险的功能：os.startfile 对这些后缀会直接运行程序。
# 用黑名单挡掉它们，其余文档/媒体放行（前端打开本地文件前还会再弹确认框）。
DANGEROUS_EXTS = {
    ".exe", ".com", ".scr", ".pif", ".bat", ".cmd", ".vbs", ".vbe",
    ".js", ".jse", ".ws", ".wsf", ".wsh", ".ps1", ".ps1xml", ".ps2",
    ".psc1", ".psc2", ".psm1", ".msi", ".msp", ".mst", ".reg", ".jar",
    ".hta", ".cpl", ".msc", ".lnk", ".inf", ".scf", ".application",
    ".gadget", ".jnlp", ".py", ".pyw", ".sh",
}
BACKGROUND_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}
MAX_CANVAS_IMAGE_BYTES = 40 * 1024 * 1024
MAX_BACKGROUND_IMAGE_BYTES = 40 * 1024 * 1024

# 附件（PDF / Markdown 文档）——展示在画布上的可缩放附件节点。
# 与图片一样存进画布旁的伴生目录，但按内容哈希去重：同一篇 PDF 反复拖入只存一份。
CANVAS_ATTACHMENT_TYPES = {
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
}
MAX_CANVAS_ATTACHMENT_BYTES = 100 * 1024 * 1024
# JSON uploads use base64, so a 100 MiB attachment needs roughly 134 MiB on the
# wire.  Keep enough headroom for the surrounding canvas metadata, while
# refusing obviously bogus Content-Length values before allocating the body.
MAX_JSON_BODY_BYTES = 160 * 1024 * 1024
LARGE_JSON_BODY_BYTES = 8 * 1024 * 1024
FILE_STREAM_CHUNK_BYTES = 256 * 1024
VIEWPORT_STATE_LIMIT = 500
CANVAS_STATS_CACHE_LIMIT = 512
CANVAS_ACTIVITY_SCHEMA = 1
CANVAS_ACTIVITY_HEARTBEAT_MAX_SEC = 10 * 60
# 画布伴生素材统一可被 /api/canvas-asset 读取的类型（图片 + 附件）。
CANVAS_ASSET_TYPES = {**BACKGROUND_IMAGE_TYPES, **CANVAS_ATTACHMENT_TYPES}

# ThreadingHTTPServer may receive autosave, review, calendar and workspace
# mutations at the same time. Small data-file transactions and canvas/assets
# use separate locks so a large attachment cannot stall unrelated task updates.
DATA_MUTATION_LOCK = threading.RLock()
CANVAS_FILE_MUTATION_LOCK = threading.RLock()
LARGE_JSON_BODY_LOCK = threading.Lock()
CANVAS_STATS_CACHE_LOCK = threading.Lock()
_CANVAS_STATS_CACHE: dict[str, tuple[tuple[int, int, int, int], int | None]] = {}
_CROSS_PROCESS_MUTATION_STATE = threading.local()


@contextmanager
def _cross_process_mutation_lock():
    """Serialize writes from multiple Relatum processes sharing the same ROOT."""
    depth = int(getattr(_CROSS_PROCESS_MUTATION_STATE, "depth", 0) or 0)
    if depth:
        _CROSS_PROCESS_MUTATION_STATE.depth = depth + 1
        try:
            yield
        finally:
            _CROSS_PROCESS_MUTATION_STATE.depth = depth
        return
    if sys.platform != "win32":
        yield
        return

    handle = None
    acquired = False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
        kernel32.ReleaseMutex.restype = ctypes.c_bool
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_bool
        root_key = hashlib.sha256(
            os.fsencode(os.path.normcase(str(ROOT.resolve())))
        ).hexdigest()[:24]
        handle = kernel32.CreateMutexW(None, False, f"Local\\RelatumData-{root_key}")
        if handle:
            wait_result = kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
            acquired = wait_result in (0x00000000, 0x00000080)  # object / abandoned
        _CROSS_PROCESS_MUTATION_STATE.depth = 1
        yield
    finally:
        _CROSS_PROCESS_MUTATION_STATE.depth = 0
        if handle:
            if acquired:
                try:
                    ctypes.windll.kernel32.ReleaseMutex(handle)
                except Exception:
                    pass
            try:
                ctypes.windll.kernel32.CloseHandle(handle)
            except Exception:
                pass


def _serialized_data(func):
    """Run a small persistence transaction under cross-process and local locks."""
    def locked(*args, **kwargs):
        with _cross_process_mutation_lock():
            with DATA_MUTATION_LOCK:
                return func(*args, **kwargs)
    locked.__name__ = getattr(func, "__name__", "locked")
    locked.__doc__ = getattr(func, "__doc__", None)
    return locked


# ─── 目录与最近列表 ──────────────────────────────────────────

def canvas_assets_root(canvas_path: Path) -> Path:
    """返回某张画布的伴生素材目录；路径相对引用始终以此目录为根。"""
    return canvas_path.with_name(f"{canvas_path.stem}.assets")


def _canvas_references(payload: dict) -> tuple[set[str], set[str]]:
    """一次遍历收集画布仍引用的素材路径与正文节点 ID。"""
    active_assets = {"node-annotations.json"}
    active_node_ids: set[str] = set()
    nodes = payload.get("nodes", []) if isinstance(payload, dict) else []
    if not isinstance(nodes, list):
        return active_assets, active_node_ids
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if node_id:
            active_node_ids.add(str(node_id))
        asset = node.get("assetPath")
        if isinstance(asset, str) and asset:
            normalized = asset.replace("\\", "/")
            active_assets.add(normalized)
            active_assets.add(normalized + ".annot.json")
    return active_assets, active_node_ids


def _resolve_canvas_asset(canvas_path: Path, asset_path: str) -> Path:
    """安全解析 `images/foo.png` 形式的画布素材相对路径。"""
    normalized = str(asset_path or "").replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError("素材路径无效")
    root = canvas_assets_root(canvas_path).resolve()
    target = (root / Path(*parts)).resolve()
    try:
        target.relative_to(root)
    except ValueError as err:
        raise ValueError("素材路径越界") from err
    return target


def move_canvas_with_assets(src: Path, dst: Path) -> None:
    """移动 `.canvas` 及同名 `.assets` 伴生目录，确保相对素材路径保持有效。"""
    src_assets = canvas_assets_root(src)
    dst_assets = canvas_assets_root(dst)
    if dst.exists() or dst_assets.exists():
        raise FileExistsError(f"目标已存在：{dst.name}")
    src.rename(dst)
    try:
        if src_assets.exists():
            src_assets.rename(dst_assets)
    except OSError:
        try:
            dst.rename(src)
        except OSError:
            pass
        raise


def move_canvas_to_trash(src: Path) -> Path:
    """将画布及全部伴生数据移入画布回收站，并同步清理索引与视野记录。"""
    TRASH.mkdir(parents=True, exist_ok=True)
    dst = TRASH / src.name
    # 同名冲突：加 -2 / -3 …，不覆盖回收站里已有的
    if dst.exists() or canvas_assets_root(dst).exists():
        stem, suffix = src.stem, src.suffix
        index = 2
        while True:
            candidate = TRASH / f"{stem}-{index}{suffix}"
            if not candidate.exists() and not canvas_assets_root(candidate).exists():
                dst = candidate
                break
            index += 1
    move_canvas_with_assets(src, dst)
    move_viewport_state(src, dst)
    move_canvas_activity_path(src, dst)
    remove_from_recent(src)
    return dst


def ensure_dirs() -> None:
    """首次启动时确保用户数据目录存在。"""
    CANVASES.mkdir(exist_ok=True)
    DATA.mkdir(exist_ok=True)
    cleanup_unused_background_uploads()


def _atomic_temp_path(target: Path) -> Path:
    """Return a short thread/process-unique sibling temp path."""
    digest = hashlib.sha256(os.fsencode(str(target.absolute()))).hexdigest()[:12]
    return target.with_name(f".relatum-{digest}-{os.getpid()}-{threading.get_ident()}.tmp")


def _atomic_write_json(target: Path, data: dict, *, streaming: bool = False) -> None:
    """原子写 JSON；大型内容流式编码，小文件保留一次编码的低延迟路径。"""
    if not streaming:
        try:
            streaming = target.stat().st_size > LARGE_JSON_BODY_BYTES
        except OSError:
            pass
    if not streaming:
        _atomic_write_text(
            target,
            json.dumps(data, ensure_ascii=False, indent=2),
        )
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _atomic_temp_path(target)
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            encoder = json.JSONEncoder(ensure_ascii=False, indent=2)
            fh.writelines(encoder.iterencode(data))
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_write_text(target: Path, text: str) -> None:
    """先写唯一临时文件，再原子替换，供文本/JSON 用户数据使用。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _atomic_temp_path(target)
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_write_bytes(target: Path, content: bytes) -> None:
    """Binary counterpart used for uploaded assets and exported PNG files."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _atomic_temp_path(target)
    try:
        with tmp.open("wb") as fh:
            fh.write(content)
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_copy_file(source: Path, target: Path) -> None:
    """Copy a picked local file without ever exposing a partial destination."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _atomic_temp_path(target)
    try:
        # Managed assets should not inherit a source file's read-only metadata.
        shutil.copyfile(source, tmp)
        os.replace(tmp, target)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _base64_too_large(encoded: str, decoded_limit: int) -> bool:
    """Reject oversized uploads before base64 decoding duplicates them in RAM."""
    encoded_limit = 4 * ((decoded_limit + 2) // 3)
    return len(encoded) > encoded_limit


def _prune_node_annotations(canvas_path: Path, node_ids: set[str]) -> int:
    """从正文节点批注文件里移除指定节点；文件不存在或损坏时保持原样。"""
    if not node_ids:
        return 0
    target = canvas_assets_root(canvas_path) / "node-annotations.json"
    if not target.is_file():
        return 0
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return 0
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, dict):
        return 0
    removed = 0
    for node_id in node_ids:
        if node_id in nodes:
            del nodes[node_id]
            removed += 1
    if removed:
        _atomic_write_json(target, data)
    return removed


def _recent_file_id() -> str:
    return "cf_" + uuid.uuid4().hex


def _recent_group_id() -> str:
    return "g_" + uuid.uuid4().hex


def _clean_recent_rank(value, fallback: int) -> int | float:
    if isinstance(value, bool):
        return fallback
    try:
        rank = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(rank):
        return fallback
    return int(rank) if rank.is_integer() else rank


def _clean_group_name(value) -> str:
    name = unicodedata.normalize("NFC", str(value or "")).strip()
    return "".join(
        ch for ch in name if not unicodedata.category(ch).startswith("C")
    )[:40]


def _normalize_recent(raw) -> tuple[dict, bool]:
    """把历史 recent.json 收敛到 v3 图书馆结构。

    v3 不再用 files[] 的全局位置同时表达多个视图的顺序：自定义分组使用
    groupRank，收藏使用 favoriteRank；最近页由 lastOpenedAt 动态计算。
    """
    source = raw if isinstance(raw, dict) else {}
    groups: list[dict] = []
    group_ids: set[str] = set()
    group_id_aliases: dict[str, str] = {}
    reserved_group_ids = {"", "__favorites__", "__inbox__"}
    raw_groups = source.get("groups") if isinstance(source.get("groups"), list) else []
    for item in raw_groups:
        if not isinstance(item, dict):
            continue
        original_gid = str(item.get("id") or "").strip()
        gid = original_gid
        name = _clean_group_name(item.get("name"))
        if not original_gid or original_gid in group_id_aliases or not name:
            continue
        if gid in reserved_group_ids:
            gid = _recent_group_id()
        group_id_aliases[original_gid] = gid
        group_ids.add(gid)
        groups.append({"id": gid, "name": name})

    files: list[dict] = []
    file_ids: set[str] = set()
    group_rank_counts: dict[str, int] = {}
    favorite_rank_count = 0
    raw_files = source.get("files") if isinstance(source.get("files"), list) else []
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        file_id = str(item.get("id") or "").strip()
        if not file_id or file_id in file_ids:
            file_id = _recent_file_id()
        file_ids.add(file_id)
        legacy_group = item.get("groupId", item.get("group", ""))
        raw_group_id = str(legacy_group or "").strip()
        group_id = group_id_aliases.get(raw_group_id, raw_group_id)
        if group_id not in group_ids:
            group_id = ""
        group_index = group_rank_counts.get(group_id, 0)
        group_rank_counts[group_id] = group_index + 1
        entry = {
            "id": file_id,
            "path": path,
            "title": str(item.get("title") or Path(path).stem or "Untitled"),
            "lastOpenedAt": str(item.get("lastOpenedAt") or ""),
            "groupId": group_id,
            "groupRank": _clean_recent_rank(
                item.get("groupRank"), group_index * RECENT_RANK_STEP,
            ),
        }
        if bool(item.get("favorite")):
            entry["favorite"] = True
            entry["favoriteRank"] = _clean_recent_rank(
                item.get("favoriteRank"), favorite_rank_count * RECENT_RANK_STEP,
            )
            favorite_rank_count += 1
        files.append(entry)

    normalized = {"version": RECENT_SCHEMA, "groups": groups, "files": files}
    return normalized, normalized != source


def _recent_corrupt_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = DATA / f"recent.corrupt-{stamp}.json"
    if target.exists():
        target = DATA / f"recent.corrupt-{stamp}-{uuid.uuid4().hex[:6]}.json"
    return target


def _preserve_corrupt_recent(content: bytes) -> None:
    """隔离损坏的元数据，避免下一次正常操作直接覆盖唯一原件。"""
    target = _recent_corrupt_path()
    try:
        os.replace(RECENT_FILE, target)
        return
    except OSError:
        pass
    try:
        _atomic_write_bytes(target, content)
        RECENT_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _save_recent_unlocked(data: dict, *, backup: bool = True) -> None:
    normalized, _ = _normalize_recent(data)
    if backup and RECENT_FILE.is_file():
        try:
            current = RECENT_FILE.read_bytes()
            json.loads(current.decode("utf-8-sig"))
            _atomic_write_bytes(RECENT_BACKUP_FILE, current)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
    _atomic_write_json(RECENT_FILE, normalized)
    data.clear()
    data.update(normalized)


@_serialized_data
def load_recent() -> dict:
    """读取 v3 图书馆元数据；兼容旧版并自动保留损坏原件。"""
    source = {}
    changed = False
    if RECENT_FILE.is_file():
        content = b""
        try:
            content = RECENT_FILE.read_bytes()
            source = json.loads(content.decode("utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            _preserve_corrupt_recent(content)
            if RECENT_BACKUP_FILE.is_file():
                try:
                    source = json.loads(RECENT_BACKUP_FILE.read_text(encoding="utf-8-sig"))
                    changed = True
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    source = {}
    data, normalized = _normalize_recent(source)
    changed = changed or normalized
    if _repair_portable_recent_paths(data):
        changed = True
    if changed:
        try:
            _save_recent_unlocked(data, backup=RECENT_FILE.is_file())
        except OSError:
            pass
    return data


class CanvasImportLibraryError(ValueError):
    """A user-facing validation failure for the managed canvas import flow."""

    def __init__(self, message: str, *, code: str = "INVALID_IMPORT", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


class ExternalCanvasImportError(ValueError):
    """A safe, user-facing failure while importing external canvas copies."""

    def __init__(self, message: str, *, code: str = "INVALID_IMPORT", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _managed_canvas_import_entry(source_id: object, recent: dict | None = None) -> tuple[dict, Path]:
    """Resolve an opaque recent-file id to a live top-level managed canvas."""
    wanted = str(source_id or "").strip()
    if not wanted:
        raise CanvasImportLibraryError("缺少来源画布 ID", code="MISSING_SOURCE_ID")
    library = recent if isinstance(recent, dict) else load_recent()
    entry = next(
        (
            item for item in library.get("files", [])
            if isinstance(item, dict) and str(item.get("id") or "") == wanted
        ),
        None,
    )
    if entry is None:
        raise CanvasImportLibraryError(
            "来源画布不在 Relatum 画布库中",
            code="SOURCE_NOT_MANAGED",
            status=404,
        )
    raw_path = str(entry.get("path") or "").strip()
    target = Path(raw_path)
    try:
        resolved = target.resolve()
        managed_root = CANVASES.resolve()
    except OSError as err:
        raise CanvasImportLibraryError(
            "无法解析来源画布路径",
            code="SOURCE_UNAVAILABLE",
            status=404,
        ) from err
    if (
        resolved.suffix.lower() != ".canvas"
        or resolved.parent != managed_root
        or not resolved.is_file()
        or is_in_trash(resolved)
    ):
        raise CanvasImportLibraryError(
            "来源画布不是有效的内部画布",
            code="SOURCE_NOT_MANAGED",
            status=404,
        )
    return entry, resolved


def _validate_canvas_import_payload(payload: object) -> dict:
    """Perform the server-side structural preflight before exposing a source."""
    if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list):
        raise CanvasImportLibraryError(
            "来源画布缺少有效的 nodes 数组",
            code="INVALID_SOURCE",
        )
    edges = payload.get("edges", [])
    if edges is not None and not isinstance(edges, list):
        raise CanvasImportLibraryError("来源画布的 edges 格式无效", code="INVALID_SOURCE")
    ink = payload.get("ink", {})
    if ink is not None and not isinstance(ink, dict):
        raise CanvasImportLibraryError("来源画布的 ink 格式无效", code="INVALID_SOURCE")

    node_ids: set[str] = set()
    for index, node in enumerate(payload["nodes"]):
        if not isinstance(node, dict):
            raise CanvasImportLibraryError(
                f"来源画布第 {index + 1} 个节点格式无效",
                code="INVALID_SOURCE",
            )
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            raise CanvasImportLibraryError("来源画布存在缺少 ID 的节点", code="MISSING_NODE_ID")
        if node_id in node_ids:
            raise CanvasImportLibraryError("来源画布存在重复的节点 ID", code="DUPLICATE_NODE_ID")
        node_ids.add(node_id)
        if "assetPath" in node and (
            not isinstance(node.get("assetPath"), str) or not node["assetPath"].strip()
        ):
            raise CanvasImportLibraryError("来源画布存在无效的素材路径", code="INVALID_ASSET_PATH")

    for edge in edges or []:
        if not isinstance(edge, dict):
            raise CanvasImportLibraryError("来源画布存在无效的连线", code="INVALID_SOURCE")
        if edge.get("waypoints") is not None and not isinstance(edge.get("waypoints"), list):
            raise CanvasImportLibraryError("来源画布存在无效的连线折点", code="INVALID_SOURCE")

    ink = ink or {}
    for key in ("strokes", "arrows"):
        if ink.get(key) is not None and not isinstance(ink.get(key), list):
            raise CanvasImportLibraryError(f"来源画布的 {key} 格式无效", code="INVALID_SOURCE")
    for stroke in ink.get("strokes", []) or []:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("points"), list):
            raise CanvasImportLibraryError("来源画布存在无效的手写笔画", code="INVALID_SOURCE")
    for arrow in ink.get("arrows", []) or []:
        if not isinstance(arrow, dict) or arrow.get("start") is None or arrow.get("end") is None:
            raise CanvasImportLibraryError("来源画布存在无效的自由箭头", code="INVALID_SOURCE")
        if arrow.get("waypoints") is not None and not isinstance(arrow.get("waypoints"), list):
            raise CanvasImportLibraryError("来源画布存在无效的箭头折点", code="INVALID_SOURCE")
    return payload


def _read_managed_canvas_import_source(
    source_id: object,
    recent: dict | None = None,
) -> tuple[dict, Path, bytes, dict]:
    entry, source = _managed_canvas_import_entry(source_id, recent)
    try:
        size = source.stat().st_size
    except OSError as err:
        raise CanvasImportLibraryError(
            "无法读取来源画布",
            code="SOURCE_UNAVAILABLE",
            status=404,
        ) from err
    if size > MAX_JSON_BODY_BYTES:
        raise CanvasImportLibraryError(
            "来源画布超过 160 MiB",
            code="SOURCE_TOO_LARGE",
            status=413,
        )
    try:
        content = source.read_bytes()
        payload = json.loads(content.decode("utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise CanvasImportLibraryError(
            "来源画布不是有效的 JSON 文件",
            code="INVALID_JSON",
        ) from err
    return entry, source, content, _validate_canvas_import_payload(payload)


def canvas_import_library_payload(current: object = "") -> dict:
    """Return managed canvas metadata without leaking any absolute path."""
    recent = load_recent()
    groups = [
        {"id": str(group.get("id") or ""), "name": str(group.get("name") or "")}
        for group in recent.get("groups", [])
        if isinstance(group, dict) and group.get("id") and group.get("name")
    ]
    group_ids = {group["id"] for group in groups}
    current_norm = _norm(str(current or "")) if str(current or "").strip() else ""
    current_id = None
    current_group_id = None
    files = []

    if current_norm:
        for raw in recent.get("files", []):
            if not isinstance(raw, dict) or not raw.get("path"):
                continue
            if os.path.normcase(_norm(raw["path"])) != os.path.normcase(current_norm):
                continue
            current_id = str(raw.get("id") or "") or None
            raw_group_id = str(raw.get("groupId") or "")
            current_group_id = raw_group_id if raw_group_id in group_ids else "__inbox__"
            break

    for raw in recent.get("files", []):
        if not isinstance(raw, dict):
            continue
        try:
            entry, source = _managed_canvas_import_entry(raw.get("id"), recent)
        except CanvasImportLibraryError:
            continue
        source_norm = _norm(source)
        group_id = str(entry.get("groupId") or "")
        if group_id not in group_ids:
            group_id = ""
        if current_norm and os.path.normcase(source_norm) == os.path.normcase(current_norm):
            continue
        try:
            size_bytes = source.stat().st_size
        except OSError:
            continue
        item = {
            "id": str(entry.get("id") or ""),
            "title": str(entry.get("title") or source.stem),
            "groupId": group_id,
            "groupRank": entry.get("groupRank", 0),
            "lastOpenedAt": str(entry.get("lastOpenedAt") or ""),
            "sizeBytes": size_bytes,
            "favorite": bool(entry.get("favorite")),
        }
        if item["favorite"]:
            item["favoriteRank"] = entry.get("favoriteRank", 0)
        files.append(item)

    return {
        "groups": groups,
        "files": files,
        "recentLimit": RECENT_LIMIT,
        "currentId": current_id,
        "currentGroupId": current_group_id,
    }


def canvas_import_source_payload(source_id: object) -> dict:
    entry, _, content, payload = _read_managed_canvas_import_source(source_id)
    return {
        "id": str(entry.get("id") or ""),
        "title": str(entry.get("title") or ""),
        "revision": hashlib.sha256(content).hexdigest(),
        "data": payload,
    }


def canvas_dual_open_payload(source_id: object, current: object = "") -> dict:
    """Return one validated snapshot for the local dual-screen reference viewer."""
    entry, source, content, payload = _read_managed_canvas_import_source(source_id)
    raw_current = str(current or "").strip()
    if raw_current:
        try:
            current_path = Path(raw_current).resolve()
        except OSError as err:
            raise CanvasImportLibraryError(
                "当前画布路径无效",
                code="CURRENT_UNAVAILABLE",
                status=400,
            ) from err
        if os.path.normcase(_norm(current_path)) == os.path.normcase(_norm(source)):
            raise CanvasImportLibraryError("不能在双屏中打开当前画布", code="SAME_CANVAS")
    return {
        "id": str(entry.get("id") or ""),
        "title": str(entry.get("title") or source.stem),
        "path": str(source),
        "revision": hashlib.sha256(content).hexdigest(),
        "data": payload,
    }


def _canvas_import_asset_references(payload: dict) -> dict[str, list[str]]:
    references: dict[str, list[str]] = {}
    for node in payload.get("nodes", []):
        if not isinstance(node, dict) or "assetPath" not in node:
            continue
        raw = str(node.get("assetPath") or "")
        normalized = raw.replace("\\", "/")
        references.setdefault(normalized, []).append(raw)
    return references


def copy_canvas_import_assets(
    source_id: object,
    revision: object,
    target_path: object,
    requested_assets: object,
) -> dict:
    """Copy referenced managed assets transactionally and return a path map."""
    wanted_revision = str(revision or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", wanted_revision):
        raise CanvasImportLibraryError("来源修订指纹无效", code="INVALID_REVISION")
    if not isinstance(requested_assets, list):
        raise CanvasImportLibraryError("素材列表格式无效", code="INVALID_ASSET_LIST")

    _, source, content, payload = _read_managed_canvas_import_source(source_id)
    if hashlib.sha256(content).hexdigest() != wanted_revision:
        raise CanvasImportLibraryError(
            "来源画布已发生变化，请重新选择后再导入",
            code="SOURCE_CHANGED",
            status=409,
        )
    raw_target = str(target_path or "").strip()
    target = Path(raw_target)
    if (
        not raw_target
        or target.suffix.lower() != ".canvas"
        or not target.is_file()
        or not is_authorized(target)
    ):
        raise CanvasImportLibraryError(
            "当前目标画布未获授权",
            code="TARGET_UNAUTHORIZED",
            status=403,
        )
    if os.path.normcase(_norm(target)) == os.path.normcase(_norm(source)):
        raise CanvasImportLibraryError("不能把画布导入到自身", code="SAME_CANVAS")

    source_refs = _canvas_import_asset_references(payload)
    requested: list[tuple[str, str]] = []
    seen_requested: set[str] = set()
    for raw in requested_assets:
        if not isinstance(raw, str) or not raw.strip():
            raise CanvasImportLibraryError("素材路径无效", code="INVALID_ASSET_PATH")
        normalized = raw.replace("\\", "/")
        if normalized not in source_refs:
            raise CanvasImportLibraryError(
                "请求包含来源画布未引用的素材",
                code="ASSET_NOT_REFERENCED",
            )
        if normalized not in seen_requested:
            seen_requested.add(normalized)
            requested.append((raw, normalized))

    planned: list[tuple[str, str, Path, Path]] = []
    destination_by_source: dict[str, str] = {}
    reserved_destinations: set[str] = set()
    for raw, normalized in requested:
        try:
            source_asset = _resolve_canvas_asset(source, normalized)
        except ValueError as err:
            raise CanvasImportLibraryError(str(err), code="INVALID_ASSET_PATH") from err
        if not source_asset.is_file():
            raise CanvasImportLibraryError(
                f"来源素材不存在：{normalized}",
                code="ASSET_MISSING",
                status=404,
            )
        if source_asset.suffix.lower() not in CANVAS_ASSET_TYPES:
            raise CanvasImportLibraryError(
                f"不支持复制这种素材：{source_asset.name}",
                code="ASSET_TYPE_UNSUPPORTED",
            )
        source_key = os.path.normcase(_norm(source_asset))
        if source_key in destination_by_source:
            continue
        try:
            preferred = _resolve_canvas_asset(target, normalized)
        except ValueError as err:
            raise CanvasImportLibraryError(str(err), code="INVALID_ASSET_PATH") from err
        destination = preferred
        destination_key = os.path.normcase(_norm(destination))
        if destination.exists() or destination_key in reserved_destinations:
            destination = _unused_path(destination.parent, destination.stem, destination.suffix)
            destination_key = os.path.normcase(_norm(destination))
            while destination_key in reserved_destinations:
                destination = _unused_path(
                    destination.parent,
                    destination.stem + "-copy",
                    destination.suffix,
                )
                destination_key = os.path.normcase(_norm(destination))
        reserved_destinations.add(destination_key)
        relative = destination.relative_to(canvas_assets_root(target).resolve()).as_posix()
        destination_by_source[source_key] = relative
        planned.append((source_key, normalized, source_asset, destination))

    created: list[Path] = []
    target_assets = canvas_assets_root(target).resolve()
    try:
        for _, _, source_asset, destination in planned:
            _atomic_copy_file(source_asset, destination)
            created.append(destination)
    except OSError as err:
        for created_file in reversed(created):
            try:
                created_file.unlink(missing_ok=True)
            except OSError:
                pass
        for created_file in reversed(created):
            parent = created_file.parent
            while parent != target_assets:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        raise CanvasImportLibraryError(
            f"复制素材失败：{err}",
            code="ASSET_COPY_FAILED",
            status=500,
        ) from err

    mapping: dict[str, str] = {}
    for raw in requested_assets:
        if not isinstance(raw, str):
            continue
        normalized = raw.replace("\\", "/")
        source_asset = _resolve_canvas_asset(source, normalized)
        mapping[raw] = destination_by_source[os.path.normcase(_norm(source_asset))]
    return {"mapping": mapping, "assetCount": len(planned)}


@_serialized_data
def save_recent(data: dict) -> None:
    _save_recent_unlocked(data)


def load_background_preference() -> dict:
    """读取整个画布工具共用的背景与辅助底纹偏好。"""
    if not BACKGROUND_PREF_FILE.exists():
        return {"configured": False, "background": None, "guide": None}
    try:
        data = json.loads(BACKGROUND_PREF_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"configured": False, "background": None, "guide": None}
    if not isinstance(data, dict) or "background" not in data:
        return {"configured": False, "background": None, "guide": None}
    guide = data.get("guide")
    if not isinstance(guide, dict) or guide.get("type") not in {
        "ruled", "dots", "grid", "major-grid"
    }:
        guide = None
    else:
        guide = {"type": guide["type"]}
    return {"configured": True, "background": data.get("background"), "guide": guide}


def save_background_preference(background, guide=None) -> None:
    """保存跨画布共用的背景与辅助底纹；None 分别表示纸白或无底纹。"""
    _atomic_write_json(BACKGROUND_PREF_FILE, {
        "version": 2,
        "background": background,
        "guide": guide,
    })


def _managed_background_upload(background) -> Path | None:
    """返回由本应用托管的当前背景路径；外部图片路径不参与自动清理。"""
    if not isinstance(background, dict) or background.get("type") != "image":
        return None
    raw = background.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        candidate = Path(raw).resolve()
        root = BACKGROUND_UPLOAD_DIR.resolve()
    except OSError:
        return None
    return candidate if candidate.parent == root else None


@_serialized_data
def cleanup_unused_background_uploads() -> None:
    """只删除应用托管目录内未被当前偏好引用的旧全局背景。"""
    if not BACKGROUND_UPLOAD_DIR.is_dir():
        return
    keep = _managed_background_upload(load_background_preference().get("background"))
    try:
        targets = list(BACKGROUND_UPLOAD_DIR.iterdir())
    except OSError:
        return
    for target in targets:
        try:
            if target.is_file() and target.resolve() != keep:
                target.unlink()
        except OSError:
            continue


def _norm(p: Path | str) -> str:
    """规范化路径字符串，用于比较。"""
    try:
        return str(Path(p).resolve())
    except OSError:
        return str(p)


def _explorer_select_args(target: Path | str) -> list[str]:
    """构造 Explorer 定位参数；`/select,` 与路径必须分开，避免带空格路径解析失败。"""
    return ["explorer.exe", "/select,", _norm(target)]


def _viewport_key(path: Path | str) -> str:
    """返回便携的视口状态键：内置画布随整包移动仍可恢复视野。"""
    target = Path(_norm(path))
    current_canvases = Path(_norm(CANVASES))
    try:
        relative = target.relative_to(current_canvases)
        return "local:" + relative.as_posix().casefold()
    except ValueError:
        pass
    return "external:" + os.path.normcase(_norm(target))


def _clean_viewport(raw) -> dict | None:
    """校验浏览器提交的视口数值，避免损坏状态或保存异常极值。"""
    if not isinstance(raw, dict):
        return None
    try:
        scale = float(raw.get("scale"))
        center_x = float(raw.get("centerX"))
        center_y = float(raw.get("centerY"))
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (scale, center_x, center_y)):
        return None
    if scale < 0.25 or scale > 4 or abs(center_x) > 10_000_000 or abs(center_y) > 10_000_000:
        return None
    return {
        "scale": round(scale, 6),
        "centerX": round(center_x, 2),
        "centerY": round(center_y, 2),
    }


@_serialized_data
def load_viewport_states() -> dict:
    if not VIEWPORT_STATE_FILE.exists():
        return {"version": 1, "canvases": {}}
    try:
        data = json.loads(VIEWPORT_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "canvases": {}}
    if not isinstance(data, dict) or not isinstance(data.get("canvases"), dict):
        return {"version": 1, "canvases": {}}
    data["version"] = 1
    return data


def load_viewport_state(path: Path | str) -> dict | None:
    return _clean_viewport(load_viewport_states()["canvases"].get(_viewport_key(path)))


@_serialized_data
def save_viewport_state(path: Path | str, viewport: dict) -> None:
    data = load_viewport_states()
    state = dict(viewport)
    state["updatedAt"] = datetime.now().replace(microsecond=0).isoformat()
    data["canvases"][_viewport_key(path)] = state
    if len(data["canvases"]) > VIEWPORT_STATE_LIMIT:
        ordered = sorted(
            data["canvases"],
            key=lambda key: str(data["canvases"][key].get("updatedAt") or ""),
            reverse=True,
        )
        data["canvases"] = {
            key: data["canvases"][key]
            for key in ordered[:VIEWPORT_STATE_LIMIT]
        }
    _atomic_write_json(VIEWPORT_STATE_FILE, data)


@_serialized_data
def move_viewport_state(old_path: Path | str, new_path: Path | str) -> None:
    data = load_viewport_states()
    old_key = _viewport_key(old_path)
    new_key = _viewport_key(new_path)
    if old_key not in data["canvases"] or old_key == new_key:
        return
    data["canvases"][new_key] = data["canvases"].pop(old_key)
    _atomic_write_json(VIEWPORT_STATE_FILE, data)


@_serialized_data
def forget_viewport_state(path: Path | str) -> None:
    data = load_viewport_states()
    if data["canvases"].pop(_viewport_key(path), None) is not None:
        _atomic_write_json(VIEWPORT_STATE_FILE, data)


def _repair_portable_recent_paths(data: dict) -> bool:
    """把随 EXE 搬家的默认画布路径改到当前 EXE 旁边。

    recent.json 历史上保存绝对路径。用户把 `画布.exe`、`data/`、`canvases/`
    整体复制到新目录后，默认画布项会继续指向旧目录。本函数只迁移形如
    `旧目录/canvases/文件.canvas` 且当前 `canvases/` 中确有同名文件的条目；
    外部手动打开的普通 .canvas 路径不改，工作台路径也不改。
    """
    files = data.get("files", [])
    if not isinstance(files, list):
        data["files"] = []
        return True

    changed = False
    repaired: list[dict] = []
    seen: set[str] = set()
    current_root = Path(_norm(CANVASES))

    for entry in files:
        if not isinstance(entry, dict):
            changed = True
            continue
        raw_path = entry.get("path")
        if isinstance(raw_path, str) and raw_path:
            target = Path(raw_path)
            current_path = Path(_norm(target))
            try:
                current_path.relative_to(current_root)
            except ValueError:
                parts = current_path.parts
                if (
                    current_path.suffix.lower() == ".canvas"
                    and current_path.parent.name.lower() == CANVASES.name.lower()
                ):
                    candidate = CANVASES / current_path.name
                    if candidate.is_file():
                        entry = dict(entry)
                        entry["path"] = _norm(candidate)
                        changed = True

        key = _norm(entry.get("path", "")) if entry.get("path") else ""
        if key and key in seen:
            changed = True
            continue
        if key:
            seen.add(key)
        repaired.append(entry)

    if len(repaired) != len(files):
        changed = True
    if changed:
        data["files"] = repaired
    return changed


@_serialized_data
def register_recent(path: Path, title: str | None = None) -> dict:
    """登记画布并刷新打开时间；分组与手动顺序保持不变。"""
    canon = _norm(path)
    if title is None:
        title = Path(canon).stem
    # 批量导入可能在同一秒完成；保留微秒，确保“最近”顺序不会退化为随机 id 排序。
    now = datetime.now().isoformat(timespec="microseconds")
    data = load_recent()
    old = next(
        (f for f in data["files"] if _norm(f.get("path", "")) == canon),
        None,
    )
    if old:
        old["lastOpenedAt"] = now
        old["title"] = title
        save_recent(data)
        return data
    inbox_ranks = [
        f.get("groupRank", 0) for f in data["files"] if not f.get("groupId")
    ]
    data["files"].append({
        "id": _recent_file_id(),
        "path": canon,
        "lastOpenedAt": now,
        "title": title,
        "groupId": "",
        "groupRank": (min(inbox_ranks) if inbox_ranks else 0) - RECENT_RANK_STEP,
    })
    save_recent(data)
    return data


@_serialized_data
def remove_from_recent(path: Path | str) -> dict:
    canon = _norm(path)
    data = load_recent()
    data["files"] = [
        f for f in data.get("files", [])
        if _norm(f.get("path", "")) != canon
    ]
    save_recent(data)
    return data


@_serialized_data
def rename_in_recent(old_path: Path | str, new_path: Path | str) -> None:
    """把 recent 里指向 old_path 的条目改成 new_path（保留 lastOpenedAt，刷新 title）。"""
    old = _norm(old_path)
    new = _norm(new_path)
    data = load_recent()
    for f in data.get("files", []):
        if _norm(f.get("path", "")) == old:
            f["path"] = new
            f["title"] = Path(new).stem
    save_recent(data)


def recent_paths() -> set[str]:
    return {
        _norm(f.get("path", ""))
        for f in load_recent().get("files", [])
        if f.get("path")
    }


def _recent_managed_top_level_path(raw_path: object) -> Path | None:
    """Return a direct managed .canvas path, including one that is now missing."""
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    try:
        target = Path(raw_path).resolve()
        managed_root = CANVASES.resolve()
    except OSError:
        return None
    if target.suffix.lower() != ".canvas" or target.parent != managed_root:
        return None
    return target


def _is_safe_new_managed_canvas(path: Path) -> bool:
    """Validate a previously unindexed top-level canvas without following links."""
    try:
        info = path.lstat()
        attributes = int(getattr(info, "st_file_attributes", 0) or 0)
        if path.is_symlink() or bool(attributes & 0x400) or not path.is_file():
            return False
        if int(info.st_size) > MAX_JSON_BODY_BYTES:
            return False
        with path.open("r", encoding="utf-8-sig") as fh:
            payload = json.load(fh)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(payload, dict) and isinstance(payload.get("nodes"), list)


def _scan_recent_library(data: dict) -> tuple[list[Path], list[dict], int]:
    """Compare the recent index with direct children of the managed canvas root."""
    indexed_paths = {
        os.path.normcase(_norm(item.get("path", "")))
        for item in data.get("files", [])
        if isinstance(item, dict) and item.get("path")
    }
    additions: list[Path] = []
    skipped_invalid = 0
    try:
        entries = sorted(CANVASES.iterdir(), key=lambda item: item.name.casefold())
    except OSError as err:
        raise OSError(f"无法读取画布文件夹：{err}") from err
    for path in entries:
        if path.suffix.lower() != ".canvas":
            continue
        key = os.path.normcase(_norm(path))
        if key in indexed_paths:
            continue
        if not _is_safe_new_managed_canvas(path):
            skipped_invalid += 1
            continue
        additions.append(path.resolve())

    missing: list[dict] = []
    for item in data.get("files", []):
        if not isinstance(item, dict):
            continue
        managed = _recent_managed_top_level_path(item.get("path"))
        if managed is not None and not managed.is_file():
            missing.append(item)
    return additions, missing, skipped_invalid


@_serialized_data
def sync_recent_library(confirm_remove_ids: list[str] | None = None) -> dict:
    """Discover copied canvases and optionally remove confirmed missing entries."""
    data = load_recent()
    additions, missing, skipped_invalid = _scan_recent_library(data)
    missing_by_id = {
        str(item.get("id") or ""): item
        for item in missing
        if str(item.get("id") or "")
    }
    if confirm_remove_ids is None and missing_by_id:
        return {
            "ok": True,
            "needsConfirmation": True,
            "pendingAddedCount": len(additions),
            "pendingRemovedCount": len(missing_by_id),
            "skippedInvalidCount": skipped_invalid,
            "removeIds": list(missing_by_id),
        }

    confirmed = set(confirm_remove_ids or [])
    removed_ids = confirmed.intersection(missing_by_id)
    if removed_ids:
        data["files"] = [
            item for item in data.get("files", [])
            if not isinstance(item, dict) or str(item.get("id") or "") not in removed_ids
        ]

    inbox_ranks = [
        _clean_recent_rank(item.get("groupRank"), 0)
        for item in data.get("files", [])
        if isinstance(item, dict) and not item.get("groupId")
    ]
    next_rank = (max(inbox_ranks) if inbox_ranks else 0) + RECENT_RANK_STEP
    added_paths: list[str] = []
    for path in additions:
        normalized = _norm(path)
        data["files"].append({
            "id": _recent_file_id(),
            "path": normalized,
            "title": path.stem,
            "lastOpenedAt": "",
            "groupId": "",
            "groupRank": next_rank,
        })
        added_paths.append(normalized)
        next_rank += RECENT_RANK_STEP

    if removed_ids or added_paths:
        _save_recent_unlocked(data)
    return {
        "ok": True,
        "needsConfirmation": False,
        "addedCount": len(added_paths),
        "removedCount": len(removed_ids),
        "skippedInvalidCount": skipped_invalid,
        "remainingMissingCount": len(set(missing_by_id) - removed_ids),
        "addedPaths": added_paths,
    }


def canvas_file_stats(path: Path | str) -> dict:
    """读 .canvas 返回 {sizeBytes, nodeCount}；失败时对应字段给 None。
    按文件身份/时间/大小做有界缓存，避免起步页重复刷新时反复解析未改画布。"""
    stats = {"sizeBytes": None, "nodeCount": None}
    p = Path(path)
    key = _norm(p)
    try:
        stat = p.stat()
    except OSError:
        with CANVAS_STATS_CACHE_LOCK:
            _CANVAS_STATS_CACHE.pop(key, None)
        return stats
    signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    with CANVAS_STATS_CACHE_LOCK:
        cached = _CANVAS_STATS_CACHE.pop(key, None)
        if cached is not None and cached[0] == signature:
            _CANVAS_STATS_CACHE[key] = cached
            return {"sizeBytes": stat.st_size, "nodeCount": cached[1]}
    stats["sizeBytes"] = stat.st_size
    try:
        with p.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        nodes = data.get("nodes") if isinstance(data, dict) else None
        if isinstance(nodes, list):
            stats["nodeCount"] = len(nodes)
    except (OSError, ValueError):
        pass
    try:
        current = p.stat()
        current_signature = (
            current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns,
        )
    except OSError:
        return stats
    if current_signature == signature:
        with CANVAS_STATS_CACHE_LOCK:
            _CANVAS_STATS_CACHE[key] = (signature, stats["nodeCount"])
            while len(_CANVAS_STATS_CACHE) > CANVAS_STATS_CACHE_LIMIT:
                _CANVAS_STATS_CACHE.pop(next(iter(_CANVAS_STATS_CACHE)))
    return stats


def recent_file_stats(paths: list) -> list[dict]:
    """只统计当前视口附近的已登记画布，避免首页扫描全部历史条目。"""
    data = load_recent()
    indexed = {
        _norm(item.get("path", "")): item.get("path", "")
        for item in data.get("files", [])
        if item.get("path")
    }
    results: list[dict] = []
    seen: set[str] = set()
    for raw in paths[:RECENT_STATS_BATCH_LIMIT]:
        if not isinstance(raw, str) or not raw.strip():
            continue
        key = _norm(raw)
        if key in seen or key not in indexed:
            continue
        seen.add(key)
        path = indexed[key]
        exists = Path(path).is_file()
        item = {"path": path, "exists": exists}
        if exists:
            item.update(canvas_file_stats(path))
        results.append(item)
    return results


def group_name_of_path(path: Path | str) -> str:
    """返回该路径的画布所在分组名；在“未分组”/未登记 → 返回空串。
    用于重命名同名冲突时提示用户那个重名画布在哪——因为分组只是标签，
    所有 .canvas 物理上都在同一个 canvases/ 目录，跨分组也会重名。"""
    target = _norm(path)
    data = load_recent()
    groups = {g.get("id"): g.get("name") for g in data.get("groups", [])}
    for f in data.get("files", []):
        if _norm(f.get("path", "")) == target:
            return groups.get(f.get("groupId") or "", "")
    return ""


# ─── 分组（阶段 3a）─────────────────────────────────────────

def new_group_id() -> str:
    return _recent_group_id()


def _group_name_taken(data: dict, name: str, *, except_id: str = "") -> bool:
    key = _clean_group_name(name).casefold()
    return any(
        g.get("id") != except_id
        and _clean_group_name(g.get("name")).casefold() == key
        for g in data.get("groups", [])
    )


def _next_group_rank(data: dict, gid: str) -> int | float:
    ranks = [
        f.get("groupRank", 0)
        for f in data.get("files", [])
        if (f.get("groupId") or "") == gid
    ]
    return (max(ranks) if ranks else 0) + RECENT_RANK_STEP


@_serialized_data
def group_create(name: str) -> dict:
    """新建唯一名称分组，返回 {id, name}。"""
    data = load_recent()
    clean_name = _clean_group_name(name)
    if not clean_name:
        raise ValueError("分组名不能为空")
    if _group_name_taken(data, clean_name):
        raise ValueError("已经有同名分组")
    gid = new_group_id()
    data["groups"].append({"id": gid, "name": clean_name})
    save_recent(data)
    return {"id": gid, "name": clean_name}


@_serialized_data
def group_rename(gid: str, name: str) -> bool:
    data = load_recent()
    clean_name = _clean_group_name(name)
    if not clean_name:
        raise ValueError("分组名不能为空")
    if _group_name_taken(data, clean_name, except_id=gid):
        raise ValueError("已经有同名分组")
    hit = False
    for g in data["groups"]:
        if g.get("id") == gid:
            g["name"] = clean_name
            hit = True
    if hit:
        save_recent(data)
    return hit


@_serialized_data
def group_delete(gid: str) -> bool:
    """删分组：组内文件按原顺序进入“未分组”，文件本身不动。"""
    data = load_recent()
    before = len(data["groups"])
    data["groups"] = [g for g in data["groups"] if g.get("id") != gid]
    if len(data["groups"]) == before:
        return False
    moved = sorted(
        (f for f in data["files"] if f.get("groupId") == gid),
        key=lambda f: (f.get("groupRank", 0), f.get("id", "")),
    )
    rank = _next_group_rank(data, "")
    for f in moved:
        f["groupId"] = ""
        f["groupRank"] = rank
        rank += RECENT_RANK_STEP
    save_recent(data)
    return True


@_serialized_data
def file_set_group(path: str, gid: str) -> bool:
    """把画布移到分组 gid（gid 为空 = 未分组），并放到目标组末尾。"""
    canon = _norm(path)
    data = load_recent()
    valid = gid == "" or any(g.get("id") == gid for g in data["groups"])
    if not valid:
        return False
    hit = False
    for f in data["files"]:
        if _norm(f.get("path", "")) == canon:
            if (f.get("groupId") or "") != gid:
                f["groupId"] = gid
                f["groupRank"] = _next_group_rank(data, gid)
            hit = True
    if hit:
        save_recent(data)
    return hit


@_serialized_data
def file_set_favorite(path: str, favorite: bool) -> bool | None:
    """幂等设置收藏状态；新收藏排在收藏页最前。"""
    canon = _norm(path)
    data = load_recent()
    for f in data["files"]:
        if _norm(f.get("path", "")) == canon:
            if favorite:
                f["favorite"] = True
                if "favoriteRank" not in f:
                    ranks = [
                        x.get("favoriteRank", 0)
                        for x in data["files"] if x.get("favorite") and x is not f
                    ]
                    f["favoriteRank"] = (
                        (min(ranks) if ranks else 0) - RECENT_RANK_STEP
                    )
            else:
                f.pop("favorite", None)
                f.pop("favoriteRank", None)
            save_recent(data)
            return favorite
    return None


@_serialized_data
def reorder_files(paths: list[str], view: str) -> None:
    """只重排指定视图的独立 rank，不再扰动收藏与分组之间的顺序。"""
    canon_list = list(dict.fromkeys(_norm(p) for p in paths))
    data = load_recent()
    valid_groups = {g.get("id") for g in data["groups"]}
    if view == "__favorites__":
        rank_field = "favoriteRank"
        members = [f for f in data["files"] if f.get("favorite")]
    elif view == "__inbox__":
        rank_field = "groupRank"
        members = [
            f for f in data["files"] if (f.get("groupId") or "") not in valid_groups
        ]
    elif view in valid_groups:
        rank_field = "groupRank"
        members = [f for f in data["files"] if f.get("groupId") == view]
    else:
        raise ValueError("最近页按打开时间自动排序")
    by_path = {_norm(f.get("path", "")): f for f in members}
    ordered = [by_path[path] for path in canon_list if path in by_path]
    used = {id(f) for f in ordered}
    ordered.extend(sorted(
        (f for f in members if id(f) not in used),
        key=lambda f: (f.get(rank_field, 0), f.get("id", "")),
    ))
    for index, item in enumerate(ordered):
        item[rank_field] = index * RECENT_RANK_STEP
    save_recent(data)


@_serialized_data
def groups_reorder(order: list) -> None:
    """按 order（id 列表）重排 groups；未列出的保持在后面，未知 id 忽略。"""
    data = load_recent()
    by_id = {g.get("id"): g for g in data["groups"]}
    new_list = [by_id[i] for i in order if isinstance(i, str) and i in by_id]
    # 补上 order 里没提到的（容错）
    for g in data["groups"]:
        if g not in new_list:
            new_list.append(g)
    data["groups"] = new_list
    save_recent(data)


# ─── 路径与文件 IO ──────────────────────────────────────────

def is_in_canvases(target: Path) -> bool:
    try:
        target.resolve().relative_to(CANVASES.resolve())
        return True
    except ValueError:
        return False


def is_in_trash(target: Path) -> bool:
    try:
        target.resolve().relative_to(TRASH.resolve())
        return True
    except ValueError:
        return False


def is_authorized(target: Path) -> bool:
    """canvases/ 内无条件允许；其他外部路径需登记。

    这条规则覆盖了"协议 A 由外部工具传入的文件路径"——外部入口会先
    把路径登记进 recent（命令行参数、/api/open、/api/pick 都会），
    然后后续 load/save 才被放行。
    """
    if is_in_canvases(target):
        return True
    for allowed in ALLOWED_EXTRA_DIRS:
        try:
            target.resolve().relative_to(allowed)
            return True
        except ValueError:
            continue
    return _norm(target) in recent_paths()


def is_authorized_canvas_directory(target: Path) -> bool:
    """Whether a directory is an authorized canvas root for relative links."""
    try:
        resolved = target.resolve()
    except OSError:
        return False
    try:
        resolved.relative_to(CANVASES.resolve())
        return True
    except (OSError, ValueError):
        pass
    for allowed in ALLOWED_EXTRA_DIRS:
        try:
            resolved.relative_to(allowed)
            return True
        except ValueError:
            continue
    for canvas in recent_paths():
        try:
            if Path(canvas).resolve().parent == resolved:
                return True
        except OSError:
            continue
    return False


def make_new_canvas_path() -> Path:
    """生成 Untitled-YYYY-MM-DD.canvas；同日重名加 -2、-3..."""
    today = date.today().isoformat()
    base = CANVASES / f"Untitled-{today}.canvas"
    if not base.exists():
        return base
    i = 2
    while True:
        candidate = CANVASES / f"Untitled-{today}-{i}.canvas"
        if not candidate.exists():
            return candidate
        i += 1


def empty_canvas_payload() -> dict:
    now = datetime.now().replace(microsecond=0).isoformat()
    return {
        "version": 2,
        "createdAt": now,
        "updatedAt": now,
        "nodes": [],
        "edges": [],
    }


# ─── 内置学习页：轻量任务板 ─────────────────────────────────

STUDY_STATUSES = {"active", "done"}
STUDY_PROGRESS_MAX = 9999
STUDY_TASK_PAGE_MAX = 99
# Product UI does not impose a small milestone count. Keep a generous hard cap
# so corrupt or hostile payloads cannot create an unbounded amount of UI work.
STUDY_MILESTONES_MAX = 50
STUDY_TRASH_MAX = 30
STUDY_GOAL_TREES_MAX = 100
STUDY_GOAL_TREE_NODES_MAX = 2000
STUDY_GOAL_TREE_LINKS_MAX = 6000
STUDY_GOAL_TREE_DEPTH_MAX = 32
STUDY_GOAL_TREE_TITLE_MAX = 160


def _study_now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def _study_int(value: object, *, maximum: int = STUDY_PROGRESS_MAX) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(maximum, number))


def _study_config_int(value: object, label: str, *, strict: bool) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, bool) or (isinstance(value, float) and not value.is_integer()):
        if strict:
            raise ValueError(f"{label}需要是整数")
        return 0
    try:
        return int(value)
    except (TypeError, ValueError) as err:
        if strict:
            raise ValueError(f"{label}需要是整数") from err
        return 0


def _study_milestones(value: object, target: int, *, strict: bool) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("任务点需要是数组")
        return []
    out = []
    seen = set()
    seen_ids = set()
    for item in value:
        if not isinstance(item, dict):
            if strict:
                raise ValueError("任务点格式不正确")
            continue
        raw_name = str(item.get("name") or "").strip()
        if strict and len(raw_name) > 40:
            raise ValueError("任务点名称最多 40 字")
        name = raw_name[:40]
        at = _study_config_int(item.get("at"), "任务点位置", strict=strict)
        invalid = not name or target <= 0 or at < 1 or at > target or at in seen
        if invalid:
            if strict:
                raise ValueError("任务点必须有名称，并位于目标范围内且位置不能重复")
            continue
        milestone_id = str(item.get("id") or ("sm_" + uuid.uuid4().hex))[:80]
        if milestone_id in seen_ids:
            if strict:
                raise ValueError("任务点标识不能重复")
            milestone_id = "sm_" + uuid.uuid4().hex
        seen.add(at)
        seen_ids.add(milestone_id)
        out.append({
            "id": milestone_id,
            "name": name,
            "at": at,
        })
        if len(out) >= STUDY_MILESTONES_MAX:
            break
    if strict and len(value) > STUDY_MILESTONES_MAX:
        raise ValueError(f"任务点最多 {STUDY_MILESTONES_MAX} 个")
    out.sort(key=lambda item: item["at"])
    return out


def _study_progress(source: object, existing: object = None, *, strict: bool, allow_current: bool) -> dict:
    raw = source if isinstance(source, dict) else {}
    base = existing if isinstance(existing, dict) else {}
    if strict and source is not None and not isinstance(source, dict):
        raise ValueError("进度格式不正确")
    target_raw = raw.get("target", base.get("target", 0))
    target_number = _study_config_int(target_raw, "目标总量", strict=strict)
    if strict and not 0 <= target_number <= STUDY_PROGRESS_MAX:
        raise ValueError(f"目标总量需要在 0–{STUDY_PROGRESS_MAX} 之间")
    target = max(0, min(STUDY_PROGRESS_MAX, target_number))
    current = _study_int(raw.get("current", base.get("current", 0)) if allow_current else base.get("current", 0))
    if strict and target < current:
        raise ValueError("目标总量不能小于当前进度，请先回退进度")
    current = min(current, target) if target > 0 else 0
    milestones_source = raw.get("milestones", base.get("milestones", []))
    return {
        "current": current,
        "target": target,
        "milestones": _study_milestones(milestones_source, target, strict=strict),
    }


def _study_task_page(value: object, *, strict: bool = True) -> int:
    """Normalize a task page while keeping existing version-6 data on page 1."""
    if value is None or value == "":
        return 1
    if isinstance(value, bool):
        if strict:
            raise ValueError(f"任务页码需要是 1–{STUDY_TASK_PAGE_MAX} 之间的整数")
        return 1
    try:
        page = int(value)
    except (TypeError, ValueError):
        if strict:
            raise ValueError(f"任务页码需要是 1–{STUDY_TASK_PAGE_MAX} 之间的整数")
        return 1
    if strict and (not isinstance(value, int) or not 1 <= page <= STUDY_TASK_PAGE_MAX):
        raise ValueError(f"任务页码需要是 1–{STUDY_TASK_PAGE_MAX} 之间的整数")
    return max(1, min(STUDY_TASK_PAGE_MAX, page))


def _study_task_page_notes(value: object, *, strict: bool = True) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        if strict:
            raise ValueError("学习任务页说明格式不正确")
        return {}
    notes: dict[str, str] = {}
    for raw_page, raw_note in value.items():
        try:
            page = int(raw_page)
        except (TypeError, ValueError):
            if strict:
                raise ValueError("学习任务页说明页码不正确")
            continue
        if not 1 <= page <= STUDY_TASK_PAGE_MAX or isinstance(raw_page, bool):
            if strict:
                raise ValueError("学习任务页说明页码不正确")
            continue
        if not isinstance(raw_note, str):
            if strict:
                raise ValueError("学习任务页说明需要是文字")
            continue
        note = raw_note.strip()[:240]
        if note:
            notes[str(page)] = note
    return notes


def _study_task(
    source: dict | None = None, *, existing: dict | None = None,
    touch: bool = True, strict: bool = True,
) -> dict:
    raw = source if isinstance(source, dict) else {}
    base = existing if isinstance(existing, dict) else {}
    now = _study_now()
    status = str(raw.get("status", base.get("status", "active"))).strip()
    if status not in STUDY_STATUSES:
        raise ValueError("任务状态不正确")
    title = str(raw.get("title", base.get("title", "未命名任务"))).strip() or "未命名任务"
    completed_at = str(base.get("completedAt") or raw.get("completedAt") or "").strip()
    if status == "done" and touch and base.get("status") != "done":
        completed_at = now
    elif status != "done":
        completed_at = ""
    return {
        "id": str(base.get("id") or raw.get("id") or uuid.uuid4().hex),
        "title": title[:160],
        "status": status,
        "taskPage": _study_task_page(
            raw.get("taskPage") if "taskPage" in raw else base.get("taskPage"),
            strict=strict,
        ),
        "progress": _study_progress(
            raw.get("progress") if "progress" in raw else None,
            base.get("progress"), strict=strict, allow_current=not touch,
        ),
        "createdAt": str(base.get("createdAt") or raw.get("createdAt") or now),
        "updatedAt": now if touch else str(base.get("updatedAt") or raw.get("updatedAt") or now),
        "completedAt": completed_at,
    }


def _study_goal_id(value: object, prefix: str) -> str:
    raw = str(value or "").strip()
    return raw[:96] if raw else prefix + "_" + uuid.uuid4().hex


def _study_goal_title(value: object, fallback: str) -> str:
    return (str(value or "").strip() or fallback)[:STUDY_GOAL_TREE_TITLE_MAX]


def _study_goal_next_title(trees: list) -> str:
    # 从现有标题里找最大的“目标 N”编号接续，避免删除后重建产生同名树
    numbers: list[int] = []
    for item in trees:
        title = str((item or {}).get("title") or "")
        match = re.match(r"^目标\s*(\d+)$", title)
        if match:
            try:
                numbers.append(int(match.group(1)))
            except ValueError:
                pass
    return "目标 " + str(max(numbers, default=0) + 1)


def _study_goal_order(value: object, fallback: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return max(0, fallback)

# ── 学习目标树 V4：带类型的主路线 + 附加依赖 ─────────────────────
#
# 目标树只保留 V4 links 契约，旧 parentId/taskSlot 模型不参与读写。

def _study_goal_side(value: object) -> str:
    return "left" if str(value or "").strip().lower() == "left" else "right"


def _study_goal_clean_trigger(
    raw: object, source: dict, tasks_by_id: dict[str, dict], *, strict: bool,
) -> dict:
    value = raw if isinstance(raw, dict) else {}
    kind = str(value.get("kind") or "complete")
    if source.get("kind") == "branch":
        if strict and kind != "complete":
            raise ValueError("阶段依赖只能在阶段完成后解锁")
        return {"kind": "complete"}
    if kind == "milestone":
        milestone_id = str(value.get("milestoneId") or "").strip()[:96]
        task = tasks_by_id.get(str(source.get("taskId") or "")) or {}
        milestones = (task.get("progress") or {}).get("milestones", [])
        if milestone_id and any(
            isinstance(item, dict) and str(item.get("id") or "") == milestone_id
            for item in milestones
        ):
            return {"kind": "milestone", "milestoneId": milestone_id}
        if strict:
            raise ValueError("前置任务点不存在")
    elif strict and kind != "complete":
        raise ValueError("依赖触发条件不正确")
    return {"kind": "complete"}


def _study_goal_primary_group(link: dict) -> str:
    source = str(link.get("from") or "")
    return source if source else "root|" + _study_goal_side(link.get("side"))


def _study_goal_normalize_trees(
    value: object, tasks: list[dict], *, strict: bool = False,
) -> list[dict]:
    if not isinstance(value, list):
        if strict:
            raise ValueError("目标树格式不正确")
        return []
    if len(value) > STUDY_GOAL_TREES_MAX:
        raise ValueError("目标树数量已达到安全上限")
    tasks_by_id = {str(task.get("id") or ""): task for task in tasks}
    trees: list[dict] = []
    tree_ids: set[str] = set()
    for tree_index, raw_tree in enumerate(value):
        if not isinstance(raw_tree, dict) or raw_tree.get("version") != 2:
            raise ValueError("目标树版本不兼容")
        tree_id = _study_goal_id(raw_tree.get("id"), "goal")
        if tree_id in tree_ids:
            raise ValueError("目标树标识不能重复")
        tree_ids.add(tree_id)
        raw_nodes = raw_tree.get("nodes")
        raw_links = raw_tree.get("links")
        if not isinstance(raw_nodes, list) or not isinstance(raw_links, list):
            raise ValueError("目标树节点或连接格式不正确")
        if len(raw_nodes) > STUDY_GOAL_TREE_NODES_MAX:
            raise ValueError("目标树节点数量已达到安全上限")
        if len(raw_links) > STUDY_GOAL_TREE_LINKS_MAX:
            raise ValueError("目标树连接数量已达到安全上限")

        nodes: list[dict] = []
        node_ids: set[str] = set()
        owned_tasks: set[str] = set()
        for raw_node in raw_nodes:
            if not isinstance(raw_node, dict):
                raise ValueError("目标树节点格式不正确")
            node_id = _study_goal_id(raw_node.get("id"), "goal_node")
            kind = str(raw_node.get("kind") or "")
            if node_id in node_ids:
                raise ValueError("目标树节点标识不能重复")
            if kind not in {"branch", "task"}:
                raise ValueError("目标树节点类型不正确")
            node_ids.add(node_id)
            node = {"id": node_id, "kind": kind}
            if kind == "branch":
                node["title"] = _study_goal_title(raw_node.get("title"), "未命名阶段")
                color = str(raw_node.get("color") or "").strip()
                if color:
                    if len(color) > 7 or not color.startswith("#"):
                        raise ValueError("阶段颜色不正确")
                    node["color"] = color
            else:
                task_id = str(raw_node.get("taskId") or "").strip()
                if not task_id or task_id not in tasks_by_id or task_id in owned_tasks:
                    raise ValueError("学习任务不存在或已经在这棵目标树中")
                owned_tasks.add(task_id)
                node["taskId"] = task_id
            nodes.append(node)
        by_id = {node["id"]: node for node in nodes}

        links: list[dict] = []
        link_ids: set[str] = set()
        link_signatures: set[tuple] = set()
        for raw_link in raw_links:
            if not isinstance(raw_link, dict):
                raise ValueError("目标树连接格式不正确")
            link_id = _study_goal_id(raw_link.get("id"), "goal_link")
            if link_id in link_ids:
                raise ValueError("目标树连接标识不能重复")
            link_ids.add(link_id)
            source_id = str(raw_link.get("from") or "").strip()[:96] or None
            target_id = str(raw_link.get("to") or "").strip()[:96]
            link_type = str(raw_link.get("type") or "")
            primary = bool(raw_link.get("primary"))
            source = by_id.get(source_id) if source_id else None
            if target_id not in by_id or source_id == target_id or (source_id and source is None):
                raise ValueError("目标树连接引用不存在")
            if link_type not in {"contains", "requires"}:
                raise ValueError("目标树连接类型不正确")
            if link_type == "contains":
                if source is not None and source.get("kind") != "branch":
                    raise ValueError("只有根目标或阶段可以包含节点")
                if not primary:
                    raise ValueError("包含连接必须是主路线")
            elif source is None:
                raise ValueError("依赖连接必须指定来源")
            link = {
                "id": link_id,
                "from": source_id,
                "to": target_id,
                "type": link_type,
                "primary": primary,
            }
            if primary:
                link["order"] = _study_goal_order(raw_link.get("order"))
                if source_id is None:
                    link["side"] = _study_goal_side(raw_link.get("side"))
            if link_type == "requires":
                link["trigger"] = _study_goal_clean_trigger(
                    raw_link.get("trigger"), source, tasks_by_id, strict=True,
                )
            trigger = link.get("trigger") or {}
            signature = (
                source_id, target_id, link_type,
                trigger.get("kind"), trigger.get("milestoneId"),
            ) if link_type == "requires" else (
                source_id, target_id, link_type, primary,
            )
            if signature in link_signatures:
                raise ValueError("目标树连接不能重复")
            link_signatures.add(signature)
            links.append(link)

        primary_by_target: dict[str, dict] = {}
        for link in links:
            if not link["primary"]:
                continue
            if link["to"] in primary_by_target:
                raise ValueError("每个节点只能有一条主路线连接")
            primary_by_target[link["to"]] = link
        if set(primary_by_target) != node_ids:
            raise ValueError("每个目标树节点都必须接入主路线")

        # 主路线必须是一棵有根树，并受统一深度上限保护。
        for node_id in node_ids:
            seen = {node_id}
            cursor = node_id
            depth = 0
            while True:
                source_id = primary_by_target[cursor].get("from")
                if not source_id:
                    break
                depth += 1
                if source_id in seen or depth > STUDY_GOAL_TREE_DEPTH_MAX:
                    raise ValueError("目标树主路线不能形成循环或超过最大层级")
                seen.add(source_id)
                cursor = source_id

        contains_parent = {
            link["to"]: link.get("from")
            for link in links
            if link["primary"] and link["type"] == "contains" and link.get("from")
        }

        def contains_ancestor(ancestor: str, child: str) -> bool:
            seen: set[str] = set()
            cursor = child
            while cursor in contains_parent and cursor not in seen:
                seen.add(cursor)
                cursor = str(contains_parent[cursor])
                if cursor == ancestor:
                    return True
            return False

        dependency_children: dict[str, list[str]] = {}
        for link in links:
            if link["type"] != "requires":
                continue
            source_id = str(link.get("from") or "")
            target_id = link["to"]
            if contains_ancestor(source_id, target_id) or contains_ancestor(target_id, source_id):
                raise ValueError("阶段不能依赖自身包含的内容")
            dependency_children.setdefault(source_id, []).append(target_id)

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit_dependency(node_id: str) -> None:
            if node_id in visiting:
                raise ValueError("目标树依赖不能形成循环")
            if node_id in visited:
                return
            visiting.add(node_id)
            for child_id in dependency_children.get(node_id, []):
                visit_dependency(child_id)
            visiting.remove(node_id)
            visited.add(node_id)

        for node_id in node_ids:
            visit_dependency(node_id)

        primary_groups: dict[str, list[dict]] = {}
        for link in links:
            if link["primary"]:
                primary_groups.setdefault(_study_goal_primary_group(link), []).append(link)
        for siblings in primary_groups.values():
            siblings.sort(key=lambda item: (_study_goal_order(item.get("order")), item["id"]))
            for order, link in enumerate(siblings):
                link["order"] = order

        stamp = str(raw_tree.get("createdAt") or _study_now())[:40]
        trees.append({
            "version": 2,
            "id": tree_id,
            "title": _study_goal_title(raw_tree.get("title"), "未命名目标"),
            "order": _study_goal_order(raw_tree.get("order"), tree_index),
            "nodes": nodes,
            "links": links,
            "createdAt": stamp,
            "updatedAt": str(raw_tree.get("updatedAt") or stamp)[:40],
        })
    trees.sort(key=lambda item: (item["order"], item["createdAt"], item["id"]))
    for order, tree in enumerate(trees):
        tree["order"] = order
    return trees


def _study_goal_new_tree(title: object, order: int = 0) -> dict:
    now = _study_now()
    return {
        "version": 2,
        "id": "goal_" + uuid.uuid4().hex,
        "title": _study_goal_title(title, "未命名目标"),
        "order": _study_goal_order(order),
        "nodes": [],
        "links": [],
        "createdAt": now,
        "updatedAt": now,
    }


def _study_goal_sync_active(data: dict) -> dict:
    trees = data.get("goalTrees")
    if not isinstance(trees, list) or not trees:
        trees = [_study_goal_new_tree("目标 1", 0)]
        data["goalTrees"] = trees
    active_id = str(data.get("activeTreeId") or "").strip()
    active = next((tree for tree in trees if tree.get("id") == active_id), trees[0])
    data["activeTreeId"] = active["id"]
    data.pop("goalTree", None)
    return active


def _study_goal_tree(data: dict, tree_id: object = None) -> dict:
    target = str(tree_id or data.get("activeTreeId") or "").strip()
    for tree in data.get("goalTrees", []):
        if tree.get("id") == target:
            return tree
    raise KeyError("没有找到这棵目标树")


def _study_goal_node(tree: dict, node_id: object) -> dict:
    target = str(node_id or "").strip()
    for node in tree.get("nodes", []):
        if node.get("id") == target:
            return node
    raise KeyError("没有找到这个目标树节点")


def _study_goal_primary_link(tree: dict, node_id: object) -> dict:
    target = str(node_id or "").strip()
    for link in tree.get("links", []):
        if link.get("primary") and link.get("to") == target:
            return link
    raise KeyError("没有找到节点的主路线连接")


def _study_goal_task_owner(data: dict, task_id: object) -> tuple[dict, dict] | None:
    target = str(task_id or "").strip()
    for tree in data.get("goalTrees", []):
        for node in tree.get("nodes", []):
            if node.get("kind") == "task" and node.get("taskId") == target:
                return tree, node
    return None


def _study_goal_link_from_input(
    tree: dict, target_id: str, raw: object, *, link_id: str | None = None,
) -> dict:
    value = raw if isinstance(raw, dict) else {}
    source_id = str(value.get("from") or "").strip()[:96] or None
    source = next((node for node in tree.get("nodes", []) if node.get("id") == source_id), None)
    if source_id and source is None:
        raise KeyError("没有找到主路线来源节点")
    link_type = str(value.get("type") or ("requires" if source and source.get("kind") == "task" else "contains"))
    if source_id is None:
        link_type = "contains"
    link = {
        "id": link_id or "goal_link_" + uuid.uuid4().hex,
        "from": source_id,
        "to": target_id,
        "type": link_type,
        "primary": True,
        "order": _study_goal_order(value.get("order"), 999999),
    }
    if source_id is None:
        link["side"] = _study_goal_side(value.get("side"))
    if link_type == "requires":
        link["trigger"] = dict(value.get("trigger") or {"kind": "complete"})
    return link


def _study_goal_reorder_primary(tree: dict, moving: dict, before_id: object = None) -> None:
    group = _study_goal_primary_group(moving)
    siblings = sorted(
        (
            link for link in tree.get("links", [])
            if link.get("primary") and link["id"] != moving["id"]
            and _study_goal_primary_group(link) == group
        ),
        key=lambda item: (_study_goal_order(item.get("order")), item["id"]),
    )
    before = str(before_id or "")
    index = next((i for i, link in enumerate(siblings) if link.get("to") == before), len(siblings))
    siblings.insert(index, moving)
    for order, link in enumerate(siblings):
        link["order"] = order


def _study_goal_detach_task(
    data: dict, task_id: object, *, tree_id: object = None, remember: bool = False,
) -> dict | None:
    target = str(task_id or "").strip()
    trees = data.get("goalTrees", [])
    if tree_id:
        trees = [tree for tree in trees if tree.get("id") == str(tree_id)]
    removed = None
    for tree in trees:
        node = next((item for item in tree.get("nodes", []) if item.get("kind") == "task" and item.get("taskId") == target), None)
        if not node:
            continue
        incoming = _study_goal_primary_link(tree, node["id"])
        children = [
            link for link in tree.get("links", [])
            if link.get("primary") and link.get("from") == node["id"]
        ]
        for offset, child in enumerate(sorted(children, key=lambda item: item.get("order", 0))):
            child["from"] = incoming.get("from")
            child["type"] = incoming["type"]
            child["order"] = _study_goal_order(incoming.get("order")) + offset
            if incoming["type"] == "requires":
                child["trigger"] = dict(incoming.get("trigger") or {"kind": "complete"})
            else:
                child.pop("trigger", None)
            if incoming.get("from") is None:
                child["side"] = _study_goal_side(incoming.get("side"))
            else:
                child.pop("side", None)
        tree["nodes"] = [item for item in tree.get("nodes", []) if item["id"] != node["id"]]
        child_ids = {link["id"] for link in children}
        tree["links"] = [
            link for link in tree.get("links", [])
            if link["id"] in child_ids or (link.get("from") != node["id"] and link.get("to") != node["id"])
        ]
        tree["updatedAt"] = _study_now()
        removed = {"treeId": tree["id"], "nodeId": node["id"]}
    return removed


def _study_goal_snapshot_tasks(data: dict, tasks: list[dict], *, archived_at: str) -> None:
    for task in tasks:
        _study_goal_detach_task(data, task.get("id"))


def _study_goal_tree_metrics(tree: dict, tasks: list[dict]) -> dict:
    by_task = {str(task.get("id") or ""): task for task in tasks}
    values = []
    for node in tree.get("nodes", []):
        if node.get("kind") != "task":
            continue
        task = by_task.get(str(node.get("taskId") or ""))
        if not task:
            continue
        progress = task.get("progress") if isinstance(task.get("progress"), dict) else {}
        target = _study_int(progress.get("target"))
        current = min(_study_int(progress.get("current")), target) if target else 0
        values.append(1.0 if task.get("status") == "done" else (current / target if target else 0.0))
    return {
        "leafCount": len(values),
        "progress": sum(values) / len(values) if values else 0.0,
        "complete": bool(values) and all(value >= 1 for value in values),
    }


def _study_goal_fresh_study(tasks: list[dict], trash: list[dict]) -> dict:
    tree = _study_goal_new_tree("目标 1", 0)
    return {
        "version": 6,
        "tasks": tasks,
        "trash": trash[:STUDY_TRASH_MAX],
        "temporaryTaskIds": [],
        "taskPageNotes": {},
        "goalTrees": [tree],
        "activeTreeId": tree["id"],
    }


def _study_temporary_task_ids(value: object, tasks: list[dict]) -> list[str]:
    """Normalize the temporary shortlist as ordered references to active tasks."""
    active_ids = {
        str(task.get("id") or "") for task in tasks
        if isinstance(task, dict) and task.get("status") == "active"
    }
    result: list[str] = []
    seen: set[str] = set()
    for item in value if isinstance(value, list) else []:
        task_id = str(item or "").strip()
        if not task_id or task_id in seen or task_id not in active_ids:
            continue
        result.append(task_id)
        seen.add(task_id)
    return result


def load_study() -> dict:
    if not STUDY_FILE.exists():
        return _study_goal_fresh_study([], [])
    try:
        raw = json.loads(STUDY_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ValueError(f"学习数据无法读取：{err}") from err
    if not isinstance(raw, dict) or raw.get("version") != 6:
        raise ValueError("学习数据版本不兼容；请移走旧 study.json 后重新打开")
    tasks = []
    for item in raw.get("tasks", []):
        tasks.append(_study_task(item, existing=item, touch=False, strict=True))
    trash = []
    for item in raw.get("trash", []):
        if not isinstance(item, dict):
            raise ValueError("学习回收站格式不正确")
        trash.append({
            "task": _study_task(item.get("task"), existing=item.get("task"), touch=False, strict=True),
            "deletedAt": str(item.get("deletedAt") or _study_now()),
        })
    trees = _study_goal_normalize_trees(raw.get("goalTrees"), tasks, strict=True)
    if not trees:
        trees = [_study_goal_new_tree("目标 1", 0)]
    active_id = str(raw.get("activeTreeId") or "").strip()
    if not any(tree["id"] == active_id for tree in trees):
        active_id = trees[0]["id"]
    return {
        "version": 6,
        "tasks": tasks,
        "trash": trash[:STUDY_TRASH_MAX],
        "temporaryTaskIds": _study_temporary_task_ids(raw.get("temporaryTaskIds"), tasks),
        "taskPageNotes": _study_task_page_notes(raw.get("taskPageNotes"), strict=True),
        "goalTrees": trees,
        "activeTreeId": active_id,
    }


def save_study(data: dict) -> None:
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("学习任务格式不正确")
    trees = _study_goal_normalize_trees(data.get("goalTrees"), tasks, strict=True)
    if not trees:
        trees = [_study_goal_new_tree("目标 1", 0)]
    data["goalTrees"] = trees
    _study_goal_sync_active(data)
    temporary_task_ids = _study_temporary_task_ids(data.get("temporaryTaskIds"), tasks)
    data["temporaryTaskIds"] = temporary_task_ids
    task_page_notes = _study_task_page_notes(data.get("taskPageNotes"), strict=True)
    data["taskPageNotes"] = task_page_notes
    payload = {
        "version": 6,
        "tasks": tasks,
        "trash": data.get("trash", [])[:STUDY_TRASH_MAX],
        "temporaryTaskIds": temporary_task_ids,
        "taskPageNotes": task_page_notes,
        "goalTrees": trees,
        "activeTreeId": data["activeTreeId"],
    }
    _atomic_write_json(STUDY_FILE, payload)


def change_study_progress(data: dict, task_id: object, delta: object) -> dict:
    """在已持有学习数据写锁时推进一个单位；调用方负责原子写回。"""
    target_id = str(task_id or "").strip()
    if delta not in (-1, 1) or isinstance(delta, bool):
        raise ValueError("delta 只能是 1 或 -1")
    index, old = study_find_task(data, target_id)
    if old.get("status") == "done":
        raise RuntimeError("请先恢复任务，再调整进度")
    progress = dict(old.get("progress") or {})
    target = _study_int(progress.get("target"))
    if target <= 0:
        raise RuntimeError("请先设置目标")
    before = min(_study_int(progress.get("current")), target)
    current = max(0, min(target, before + delta))
    progress["current"] = current
    task = dict(old)
    task["progress"] = progress
    task["updatedAt"] = _study_now()
    crossed = []
    if delta > 0:
        crossed = [
            item["id"] for item in progress.get("milestones", [])
            if before < _study_int(item.get("at")) <= current
        ]
    data["tasks"][index] = task
    return {
        "task": task,
        "crossedMilestoneIds": crossed,
        "targetReached": delta > 0 and before < target and current == target,
    }


# ── 日历倒数日 ──────────────────────────────────────────
def _default_countdown() -> dict:
    return {
        "version": 2,
        "selectedId": "",
        "events": [],
        "event": "",
        "date": "",
    }


def _sanitize_countdown_event(raw: object, fallback: dict, index: int) -> dict | None:
    if not isinstance(raw, dict):
        return None
    event = str(raw.get("event") or "").strip()[:80]
    if not event:
        return None
    try:
        target = date.fromisoformat(str(raw.get("date") or ""))
    except ValueError:
        return None
    event_id = str(raw.get("id") or "").strip()[:64]
    if not event_id:
        event_id = f"event-{index + 1}"
    return {"id": event_id, "event": event, "date": target.isoformat()}


def _sanitize_countdown(raw: object) -> dict:
    fallback = _default_countdown()
    if not isinstance(raw, dict):
        return fallback
    events = []
    used_ids = set()
    if isinstance(raw.get("events"), list):
        for index, item in enumerate(raw["events"][:100]):
            clean = _sanitize_countdown_event(item, fallback, index)
            if not clean:
                continue
            base_id = clean["id"]
            suffix = 2
            while clean["id"] in used_ids:
                clean["id"] = f"{base_id}-{suffix}"
                suffix += 1
            used_ids.add(clean["id"])
            events.append(clean)
    has_event_list = isinstance(raw.get("events"), list)
    if not events and not has_event_list:
        legacy = _sanitize_countdown_event({
            "id": str(raw.get("id") or "legacy"),
            "event": raw.get("event"),
            "date": raw.get("date"),
        }, fallback, 0)
        events = [legacy] if legacy else []
    if not events:
        return fallback
    selected_id = str(raw.get("selectedId") or "")
    selected = next((item for item in events if item["id"] == selected_id), events[0])
    return {
        "version": 2,
        "selectedId": selected["id"],
        "events": events,
        "event": selected["event"],
        "date": selected["date"],
    }


def load_countdown() -> dict:
    if not COUNTDOWN_FILE.exists():
        return _default_countdown()
    try:
        raw = json.loads(COUNTDOWN_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return _default_countdown()
    clean = _sanitize_countdown(raw)
    # v1 → v2 自动升级：如果磁盘数据仍是 v1（无 events 数组或 version < 2），静默写回 v2 格式。
    if not isinstance(raw, dict) or raw.get("version", 0) < 2 or not isinstance(raw.get("events"), list):
        try:
            _atomic_write_json(COUNTDOWN_FILE, clean)
        except OSError:
            pass
    return clean


def save_countdown(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("请求格式不正确")
    raw_events = raw.get("events")
    if not isinstance(raw_events, list):
        raw_events = [{
            "id": raw.get("id") or "legacy",
            "event": raw.get("event"),
            "date": raw.get("date"),
        }]
    if not raw_events:
        try:
            COUNTDOWN_FILE.unlink()
        except FileNotFoundError:
            pass
        return _default_countdown()
    if len(raw_events) > 100:
        raise ValueError("倒数事件最多保存 100 条")
    events = []
    used_ids = set()
    for index, item in enumerate(raw_events):
        clean = _sanitize_countdown_event(item, _default_countdown(), index)
        if not clean:
            raise ValueError("倒数事件名称或日期不正确")
        if clean["id"] in used_ids:
            raise ValueError("倒数事件标识重复")
        used_ids.add(clean["id"])
        events.append(clean)
    selected_id = str(raw.get("selectedId") or "")
    selected = next((item for item in events if item["id"] == selected_id), events[0])
    payload = {
        "version": 2,
        "selectedId": selected["id"],
        "events": events,
        "event": selected["event"],
        "date": selected["date"],
    }
    _atomic_write_json(COUNTDOWN_FILE, payload)
    return payload


# ── 起步页「速记」便签墙 ─────────────────────────────────
# 极简灵感速记：独立存 data/notes.json，与 .canvas / 学习任务完全解耦。
NOTE_COLORS = {
    "pink", "blue", "purple", "green", "yellow", "orange",
    "teal", "sky", "lavender", "coral", "lime", "rose", "mint", "apricot",
    "paper", "stone", "sand", "sage", "indigo", "plum",
}
NOTE_TEXT_MAX = 2000
NOTES_MAX = 400   # 上限保护，避免数据无限膨胀
NOTE_EDGES_MAX = 800   # 连线上限保护
NOTE_ARROWS_MAX = 800   # 右键拖出的箭头上限保护
START_STICKY_SCOPES = {"recent", "study", "cadence", "calendar", "review", "focus"}
START_STICKY_NOTES_MAX = 240
START_STICKY_NOTES_PER_SCOPE_MAX = 60


def _sanitize_note(item: object) -> dict | None:
    """把单张便签规范化成可信结构；非法直接丢弃（返回 None）。"""
    if not isinstance(item, dict):
        return None
    nid = item.get("id")
    if not isinstance(nid, str) or not nid:
        return None
    try:
        x = float(item.get("x", 0))
        y = float(item.get("y", 0))
    except (TypeError, ValueError):
        return None
    color = item.get("color")
    if color not in NOTE_COLORS:
        color = "yellow"
    text = item.get("text")
    if not isinstance(text, str):
        text = ""
    text = text[:NOTE_TEXT_MAX]
    try:
        rotate = float(item.get("rotate", 0))
    except (TypeError, ValueError):
        rotate = 0.0
    rotate = max(-8.0, min(8.0, rotate))
    note = {
        "id": nid,
        "x": round(x, 2),
        "y": round(y, 2),
        "color": color,
        "text": text,
        "rotate": round(rotate, 2),
    }
    stack = item.get("stack")
    if isinstance(stack, str) and stack:
        note["stack"] = stack[:64]
    created = item.get("createdAt")
    if isinstance(created, str) and created:
        note["createdAt"] = created
    return note


def _sanitize_edges(items: object, valid_ids: set[str]) -> list[dict]:
    """规范便签连线：只保留两端都指向现存便签的连线；丢弃自连、悬空、重复（无向去重）。"""
    edges: list[dict] = []
    seen: set[frozenset] = set()
    if not isinstance(items, list):
        return edges
    for item in items:
        if not isinstance(item, dict):
            continue
        eid = item.get("id")
        a = item.get("from")
        b = item.get("to")
        if not (isinstance(eid, str) and eid):
            continue
        if not (isinstance(a, str) and isinstance(b, str)):
            continue
        if a == b or a not in valid_ids or b not in valid_ids:
            continue
        pair = frozenset((a, b))
        if pair in seen:
            continue
        seen.add(pair)
        edges.append({"id": eid, "from": a, "to": b})
        if len(edges) >= NOTE_EDGES_MAX:
            break
    return edges


def _safe_note_coord(value: object) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return round(max(-50000.0, min(50000.0, v)), 2)


def _sanitize_arrows(items: object, valid_ids: set[str]) -> list[dict]:
    """规范速记箭头：端点可以绑定便签，也可以是台面上的自由坐标。"""
    arrows: list[dict] = []
    if not isinstance(items, list):
        return arrows
    for item in items:
        if not isinstance(item, dict):
            continue
        aid = item.get("id")
        if not isinstance(aid, str) or not aid:
            continue
        from_note = item.get("fromNote")
        to_note = item.get("toNote")
        from_note = from_note if isinstance(from_note, str) and from_note in valid_ids else None
        to_note = to_note if isinstance(to_note, str) and to_note in valid_ids else None
        if from_note and to_note and from_note == to_note:
            continue
        arrow = {"id": aid}
        if from_note:
            arrow["fromNote"] = from_note
        else:
            x1 = _safe_note_coord(item.get("x1"))
            y1 = _safe_note_coord(item.get("y1"))
            if x1 is None or y1 is None:
                continue
            arrow["x1"] = x1
            arrow["y1"] = y1
        if to_note:
            arrow["toNote"] = to_note
        else:
            x2 = _safe_note_coord(item.get("x2"))
            y2 = _safe_note_coord(item.get("y2"))
            if x2 is None or y2 is None:
                continue
            arrow["x2"] = x2
            arrow["y2"] = y2
        arrows.append(arrow)
        if len(arrows) >= NOTE_ARROWS_MAX:
            break
    return arrows


def _build_notes_payload(items: object, edge_items: object, arrow_items: object) -> dict:
    notes: list[dict] = []
    for item in items if isinstance(items, list) else []:
        note = _sanitize_note(item)
        if note is not None:
            notes.append(note)
    notes = notes[:NOTES_MAX]
    valid_ids = {n["id"] for n in notes}
    edges = _sanitize_edges(edge_items, valid_ids)
    arrows = _sanitize_arrows(arrow_items, valid_ids)
    return {"version": 1, "notes": notes, "edges": edges, "arrows": arrows}


def load_notes() -> dict:
    try:
        raw = json.loads(NOTES_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"version": 1, "notes": [], "edges": [], "arrows": []}
    if not isinstance(raw, dict):
        return {"version": 1, "notes": [], "edges": [], "arrows": []}
    return _build_notes_payload(raw.get("notes", []), raw.get("edges", []), raw.get("arrows", []))


def save_notes(data: dict) -> dict:
    payload = _build_notes_payload(
        data.get("notes", []) if isinstance(data, dict) else [],
        data.get("edges", []) if isinstance(data, dict) else [],
        data.get("arrows", []) if isinstance(data, dict) else [],
    )
    _atomic_write_json(NOTES_FILE, payload)
    return payload


def _sanitize_start_sticky_note(item: object) -> dict | None:
    """规范起步页跨页便签；它只有页面归属、位置和纯文本，不承接速记墙能力。"""
    if not isinstance(item, dict):
        return None
    note_id = item.get("id")
    scope = item.get("scope")
    if not isinstance(note_id, str) or not note_id or len(note_id) > 96:
        return None
    if scope not in START_STICKY_SCOPES:
        return None
    try:
        x = float(item.get("x", 0))
        y = float(item.get("y", 0))
        rotate = float(item.get("rotate", 0))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(rotate)):
        return None
    text = item.get("text")
    if not isinstance(text, str):
        text = ""
    color = item.get("color")
    if color not in NOTE_COLORS:
        color = "yellow"
    note = {
        "id": note_id,
        "scope": scope,
        "x": round(max(0.0, min(50000.0, x)), 2),
        "y": round(max(0.0, min(50000.0, y)), 2),
        "color": color,
        "text": text[:NOTE_TEXT_MAX],
        "rotate": round(max(-4.0, min(4.0, rotate)), 2),
    }
    created_at = item.get("createdAt")
    if isinstance(created_at, str) and created_at:
        note["createdAt"] = created_at[:64]
    return note


def _build_start_sticky_notes_payload(items: object) -> dict:
    notes: list[dict] = []
    ids: set[str] = set()
    scope_counts = {scope: 0 for scope in START_STICKY_SCOPES}
    for item in items if isinstance(items, list) else []:
        note = _sanitize_start_sticky_note(item)
        if note is None or note["id"] in ids:
            continue
        scope = note["scope"]
        if scope_counts[scope] >= START_STICKY_NOTES_PER_SCOPE_MAX:
            continue
        ids.add(note["id"])
        scope_counts[scope] += 1
        notes.append(note)
        if len(notes) >= START_STICKY_NOTES_MAX:
            break
    return {"version": 1, "notes": notes}


def load_start_sticky_notes() -> dict:
    try:
        raw = json.loads(START_STICKY_NOTES_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"version": 1, "notes": []}
    if not isinstance(raw, dict):
        return {"version": 1, "notes": []}
    return _build_start_sticky_notes_payload(raw.get("notes", []))


def save_start_sticky_notes(data: dict) -> dict:
    payload = _build_start_sticky_notes_payload(
        data.get("notes", []) if isinstance(data, dict) else []
    )
    _atomic_write_json(START_STICKY_NOTES_FILE, payload)
    return payload


# ── 起步页「专注钟」专注记录 ─────────────────────────────
# 自成一体：每完成一段专注落一条记录，独立存 data/focus.json；不进 .canvas。
# 明细供专注页 / 日历 / 学习任务详情回看，days 供活跃页长期统计。
FOCUS_SESSIONS_MAX = 2000   # 上限保护，只保留最近的若干条，避免文件无限膨胀


def _sanitize_focus_session(item: object) -> dict | None:
    """把一条专注记录规范化成可信结构；非法直接丢弃（返回 None）。"""
    if not isinstance(item, dict):
        return None
    sid = item.get("id")
    if not isinstance(sid, str) or not sid:
        return None
    try:
        duration = int(float(item.get("durationSec", 0)))
    except (TypeError, ValueError):
        return None
    if duration <= 0:
        return None
    mode = item.get("mode")
    if mode not in ("pomodoro", "countup"):
        mode = "pomodoro"
    task_id = item.get("taskId")
    task_title = item.get("taskTitle")
    ended_at = item.get("endedAt")
    goal = item.get("goal")
    outcome = item.get("outcome")
    session = {
        "id": sid[:64],
        "mode": mode,
        "durationSec": min(duration, 24 * 3600),
        "taskId": (task_id if isinstance(task_id, str) else "")[:120],
        "taskTitle": (task_title if isinstance(task_title, str) else "")[:200],
        "goal": (goal if isinstance(goal, str) else "").strip()[:500],
        "outcome": (outcome if isinstance(outcome, str) else "").strip()[:1000],
        "endedAt": (ended_at if isinstance(ended_at, str) else "")[:40],
    }
    source = item.get("source")
    if isinstance(source, dict) and source.get("kind") == "taskbook":
        root_id = str(source.get("rootId") or "").strip()[:160]
        canvas_path = str(source.get("canvasPath") or "").strip()[:2048]
        if root_id and canvas_path:
            session["source"] = {
                "kind": "taskbook",
                "rootId": root_id,
                "rootTitle": str(source.get("rootTitle") or "").strip()[:200],
                "canvasPath": canvas_path,
                "nodeId": str(source.get("nodeId") or "").strip()[:160],
            }
    raw_day = item.get("day")
    if isinstance(raw_day, str):
        session["day"] = raw_day[:10]
    session["day"] = _focus_day_key(session)
    return session


def _focus_day_key(session: dict) -> str:
    """取一条专注记录归属的本地自然日；兼容旧版 UTC endedAt。"""
    explicit = str(session.get("day") or "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", explicit):
        try:
            return date.fromisoformat(explicit).isoformat()
        except ValueError:
            pass
    ended = str(session.get("endedAt") or "")
    if ended:
        try:
            parsed = datetime.fromisoformat(ended.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone()
            return parsed.date().isoformat()
        except ValueError:
            pass
    return date.today().isoformat()


def _taskbook_managed_node_ids(canvas: dict) -> set[str]:
    """返回 V2 任务簿成员节点；members 是结构真相，视觉连线不参与判定。"""
    taskbook = canvas.get("taskbook") if isinstance(canvas, dict) else None
    if not isinstance(taskbook, dict) or taskbook.get("version") != 2:
        return set()
    managed: set[str] = set()
    for root in taskbook.get("roots") or []:
        if not isinstance(root, dict):
            continue
        for member in root.get("members") or []:
            if not isinstance(member, dict):
                continue
            node_id = str(member.get("nodeId") or "").strip()
            if node_id:
                managed.add(node_id)
    return managed


def _taskbook_archive_source_summary(canvas: dict, root_id: str) -> dict:
    """校验一个待归档顶级任务，并返回服务端可信的归档摘要。

    归档条件只读取当前磁盘上的原画布；客户端不能自行声明完成数量或用时。
    """
    taskbook = canvas.get("taskbook") if isinstance(canvas, dict) else None
    if not isinstance(taskbook, dict) or taskbook.get("version") != 2:
        raise ValueError("当前画布没有可归档的任务簿")
    roots = taskbook.get("roots")
    if not isinstance(roots, list):
        raise ValueError("任务簿数据损坏")
    matches = [
        root for root in roots
        if isinstance(root, dict) and str(root.get("id") or "").strip() == root_id
    ]
    if len(matches) != 1:
        raise ValueError("没有找到这个顶级任务")
    root = matches[0]

    nodes_by_id: dict[str, dict] = {}
    for node in canvas.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue
        if node_id in nodes_by_id:
            raise ValueError("画布节点标识重复，不能归档")
        nodes_by_id[node_id] = node

    members = root.get("members")
    if not isinstance(members, list):
        members = []
    member_ids: list[str] = []
    parent_by_id: dict[str, str | None] = {}
    for item in members:
        if not isinstance(item, dict):
            raise ValueError("任务树结构损坏")
        node_id = str(item.get("nodeId") or "").strip()
        if not node_id or node_id in parent_by_id or node_id not in nodes_by_id:
            raise ValueError("任务树包含缺失或重复的节点")
        parent_raw = str(item.get("parentNodeId") or "").strip()
        parent_by_id[node_id] = parent_raw or None
        member_ids.append(node_id)
    for node_id, parent_id in parent_by_id.items():
        if parent_id is not None and (parent_id == node_id or parent_id not in parent_by_id):
            raise ValueError("任务树包含无效父级")

    children: dict[str, list[str]] = {node_id: [] for node_id in member_ids}
    for node_id, parent_id in parent_by_id.items():
        if parent_id:
            children[parent_id].append(node_id)
    states: dict[str, int] = {}

    def visit(node_id: str) -> None:
        state = states.get(node_id, 0)
        if state == 1:
            raise ValueError("任务树包含循环")
        if state == 2:
            return
        states[node_id] = 1
        for child_id in children[node_id]:
            visit(child_id)
        states[node_id] = 2

    for node_id in member_ids:
        visit(node_id)

    if member_ids:
        leaf_ids = [node_id for node_id in member_ids if not children[node_id]]
        if not leaf_ids or not all(bool(nodes_by_id[node_id].get("strike")) for node_id in leaf_ids):
            raise ValueError("还有未完成的叶子任务，暂时不能归档")
    else:
        leaf_ids = []
        if not bool(root.get("completed")):
            raise ValueError("顶级任务尚未完成")

    if isinstance(root.get("activeSession"), dict):
        raise ValueError("请先结束正在运行的计时")
    duration_ms = 0
    for session in root.get("sessions") or []:
        if not isinstance(session, dict):
            continue
        try:
            duration_ms += max(0, int(session.get("durationMs") or 0))
        except (TypeError, ValueError):
            continue

    projection_id = str(root.get("canvasNodeId") or "").strip()
    removed_ids = set(member_ids)
    if projection_id:
        removed_ids.add(projection_id)
    return {
        "root": root,
        "title": str(root.get("title") or "").strip() or "未命名任务",
        "leafCount": len(leaf_ids) if member_ids else 1,
        "durationMs": duration_ms,
        "removedNodeIds": removed_ids,
    }


def _validate_taskbook_archive_snapshot(
    canvas: dict,
    root_id: str,
    removed_node_ids: set[str],
    retain_snapshot: bool,
    snapshot_root_node_id: str,
) -> None:
    """确认客户端提交的是归档后的完整画布，而不是任意替换请求。"""
    if not isinstance(canvas, dict) or not isinstance(canvas.get("nodes"), list) \
            or not isinstance(canvas.get("edges"), list):
        raise ValueError("归档后的画布快照无效")
    taskbook = canvas.get("taskbook")
    if isinstance(taskbook, dict):
        if taskbook.get("version") != 2 or not isinstance(taskbook.get("roots"), list):
            raise ValueError("归档后的任务簿数据无效")
        if any(
            isinstance(root, dict) and str(root.get("id") or "").strip() == root_id
            for root in taskbook["roots"]
        ):
            raise ValueError("归档后的快照仍包含原顶级任务")

    nodes_by_id: dict[str, dict] = {}
    for node in canvas["nodes"]:
        if not isinstance(node, dict):
            raise ValueError("归档后的节点数据无效")
        node_id = str(node.get("id") or "").strip()
        if not node_id or node_id in nodes_by_id:
            raise ValueError("归档后的节点标识无效")
        if node_id in removed_node_ids:
            raise ValueError("归档后的快照仍包含原任务节点")
        if str(node.get("taskRootId") or "").strip() == root_id:
            raise ValueError("归档后的快照仍包含任务归属")
        members = node.get("groupMemberIds")
        if isinstance(members, list) and any(str(value or "") in removed_node_ids for value in members):
            raise ValueError("归档后的分组仍引用原任务节点")
        nodes_by_id[node_id] = node

    for edge in canvas["edges"]:
        if not isinstance(edge, dict):
            raise ValueError("归档后的连线数据无效")
        if str(edge.get("from") or "") in removed_node_ids \
                or str(edge.get("to") or "") in removed_node_ids:
            raise ValueError("归档后的连线仍引用原任务节点")
        if str(edge.get("taskRootId") or "").strip() == root_id:
            raise ValueError("归档后的连线仍包含任务归属")

    if retain_snapshot:
        root_copy = nodes_by_id.get(snapshot_root_node_id)
        if not root_copy or root_copy.get("kind") in {"task-root", "taskbook"}:
            raise ValueError("归档完成副本缺少普通根节点")
        if not root_copy.get("strike") and root_copy.get("archiveCover") is not True:
            raise ValueError("归档完成副本未标记为完成")
    elif snapshot_root_node_id:
        raise ValueError("关闭完成副本时不能提交副本根节点")


def _focus_rebuild_days(sessions: list) -> dict:
    """从明细重建每日汇总（仅用于旧文件无 days 时的一次性兜底）。"""
    days: dict = {}
    for session in sessions:
        key = _focus_day_key(session)
        bucket = days.setdefault(key, {"sec": 0, "count": 0})
        bucket["sec"] += int(session.get("durationSec") or 0)
        bucket["count"] += 1
    return days


def load_focus() -> dict:
    """读专注记录：最近明细 + 永不截断的每日汇总和任务汇总。"""
    if not FOCUS_FILE.exists():
        return {"version": 1, "sessions": [], "days": {}, "tasks": {}}
    try:
        raw = json.loads(FOCUS_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"version": 1, "sessions": [], "days": {}, "tasks": {}}
    sessions = []
    if isinstance(raw, dict):
        for item in raw.get("sessions", []):
            session = _sanitize_focus_session(item)
            if session:
                sessions.append(session)
    sessions = sessions[-FOCUS_SESSIONS_MAX:]
    raw_days = raw.get("days") if isinstance(raw, dict) else None
    if isinstance(raw_days, dict):
        days = {}
        for key, val in raw_days.items():
            if not (isinstance(key, str) and len(key) == 10) or not isinstance(val, dict):
                continue
            try:
                days[key] = {"sec": max(0, int(val.get("sec", 0))), "count": max(0, int(val.get("count", 0)))}
            except (TypeError, ValueError):
                continue
    else:
        days = _focus_rebuild_days(sessions)   # 旧文件无 days：从明细兜底重建一次
    raw_tasks = raw.get("tasks") if isinstance(raw, dict) else None
    if isinstance(raw_tasks, dict):
        tasks = {}
        for key, val in raw_tasks.items():
            if not isinstance(key, str) or not key or not isinstance(val, dict):
                continue
            try:
                tasks[key[:120]] = {
                    "sec": max(0, int(val.get("sec", 0))),
                    "count": max(0, int(val.get("count", 0))),
                }
            except (TypeError, ValueError):
                continue
    else:
        tasks = {}
        for session in sessions:
            task_id = str(session.get("taskId") or "")
            if not task_id:
                continue
            bucket = tasks.setdefault(task_id, {"sec": 0, "count": 0})
            bucket["sec"] += int(session.get("durationSec") or 0)
            bucket["count"] += 1
    return {"version": 1, "sessions": sessions, "days": days, "tasks": tasks}


def append_focus_session(item: object) -> dict:
    """追加一条专注记录：明细截断保留最近若干条，每日汇总永久累加；原子写回。"""
    if isinstance(item, dict) and isinstance(item.get("source"), dict) \
            and item["source"].get("kind") == "taskbook":
        data, _added = append_focus_sessions_idempotent([item])
        return data
    session = _sanitize_focus_session(item)
    if not session:
        raise ValueError("无效的专注记录")
    data = load_focus()
    data["sessions"].append(session)
    data["sessions"] = data["sessions"][-FOCUS_SESSIONS_MAX:]
    bucket = data["days"].setdefault(_focus_day_key(session), {"sec": 0, "count": 0})
    bucket["sec"] += session["durationSec"]
    bucket["count"] += 1
    if session.get("taskId"):
        task_bucket = data["tasks"].setdefault(session["taskId"], {"sec": 0, "count": 0})
        task_bucket["sec"] += session["durationSec"]
        task_bucket["count"] += 1
    _atomic_write_json(FOCUS_FILE, data)
    return data


def append_focus_sessions_idempotent(items: object) -> tuple[dict, int]:
    """批量追加专注段；以稳定 id 去重，供任务簿计时段安全重试。"""
    if not isinstance(items, list):
        raise ValueError("无效的专注记录列表")
    data = load_focus()
    known = {str(session.get("id") or "") for session in data["sessions"]}
    added = 0
    for item in items:
        session = _sanitize_focus_session(item)
        if not session:
            raise ValueError("无效的专注记录")
        if session["id"] in known:
            continue
        known.add(session["id"])
        data["sessions"].append(session)
        bucket = data["days"].setdefault(_focus_day_key(session), {"sec": 0, "count": 0})
        bucket["sec"] += session["durationSec"]
        bucket["count"] += 1
        if session.get("taskId"):
            task_bucket = data["tasks"].setdefault(session["taskId"], {"sec": 0, "count": 0})
            task_bucket["sec"] += session["durationSec"]
            task_bucket["count"] += 1
        added += 1
    data["sessions"] = data["sessions"][-FOCUS_SESSIONS_MAX:]
    if added:
        _atomic_write_json(FOCUS_FILE, data)
    return data, added


def rewrite_taskbook_focus_canvas_path(old_path: Path, new_path: Path) -> int:
    """画布重命名或恢复后，更新任务簿专注记录的被动回看路径。"""
    focus = load_focus()
    old_key = os.path.normcase(str(old_path.resolve()))
    changed = 0
    for session in focus.get("sessions", []):
        source = session.get("source")
        if not isinstance(source, dict) or source.get("kind") != "taskbook":
            continue
        raw = str(source.get("canvasPath") or "")
        try:
            matches = os.path.normcase(str(Path(raw).resolve())) == old_key
        except (OSError, ValueError):
            matches = False
        if not matches:
            continue
        source["canvasPath"] = _norm(new_path)
        changed += 1
    if changed:
        _atomic_write_json(FOCUS_FILE, focus)
    return changed


def focus_task_payload(data: dict | None = None) -> tuple[dict, list]:
    """按学习任务汇总专注投入，并返回最近明细。"""
    focus = data if isinstance(data, dict) else load_focus()
    summaries = {
        task_id: {
            "durationSec": int(summary.get("sec") or 0),
            "count": int(summary.get("count") or 0),
        }
        for task_id, summary in focus.get("tasks", {}).items()
    }
    sessions = focus.get("sessions", [])
    recent = list(reversed(sessions[-120:]))
    return summaries, recent


def update_focus_session(item: object) -> dict:
    if not isinstance(item, dict):
        raise ValueError("无效的专注记录")
    session_id = str(item.get("id") or "").strip()
    if not session_id:
        raise ValueError("缺少专注记录 id")
    data = load_focus()
    for index, old in enumerate(data["sessions"]):
        if old.get("id") != session_id:
            continue
        merged = dict(old)
        merged["goal"] = str(item.get("goal", old.get("goal", ""))).strip()[:500]
        merged["outcome"] = str(item.get("outcome", old.get("outcome", ""))).strip()[:1000]
        session = _sanitize_focus_session(merged)
        if not session:
            raise ValueError("无效的专注记录")
        data["sessions"][index] = session
        _atomic_write_json(FOCUS_FILE, data)
        return session
    raise KeyError("找不到这条专注记录")


def delete_focus_session(session_id: object) -> dict:
    target = str(session_id or "").strip()
    if not target:
        raise ValueError("缺少专注记录 id")
    data = load_focus()
    for index, session in enumerate(data["sessions"]):
        if session.get("id") != target:
            continue
        removed = data["sessions"].pop(index)
        day = _focus_day_key(removed)
        bucket = data["days"].get(day)
        if isinstance(bucket, dict):
            bucket["sec"] = max(0, int(bucket.get("sec") or 0) - int(removed.get("durationSec") or 0))
            bucket["count"] = max(0, int(bucket.get("count") or 0) - 1)
            if bucket["sec"] == 0 and bucket["count"] == 0:
                data["days"].pop(day, None)
        task_id = str(removed.get("taskId") or "")
        task_bucket = data["tasks"].get(task_id) if task_id else None
        if isinstance(task_bucket, dict):
            task_bucket["sec"] = max(
                0, int(task_bucket.get("sec") or 0) - int(removed.get("durationSec") or 0)
            )
            task_bucket["count"] = max(0, int(task_bucket.get("count") or 0) - 1)
            if task_bucket["sec"] == 0 and task_bucket["count"] == 0:
                data["tasks"].pop(task_id, None)
        _atomic_write_json(FOCUS_FILE, data)
        return removed
    raise KeyError("找不到这条专注记录")


# ── 专注页「每日任务」习惯清单 ─────────────────────────────
# 自成一体：每天重置勾选，累计完成天数/连续天数/累计专注分钟；不进 .canvas、与学习任务解耦。
# 数据存 data/daily.json：{version, date(每日状态所属自然日), tasks:[...]}。
# v3 起每条任务补 doneDates / minutesByDate，供打卡日历使用；可选 targetDays / milestones 保存长期累计目标；旧汇总字段继续保留。
DAILY_TASKS_MAX = 40           # 上限保护，避免清单无限膨胀
DAILY_NAME_MAX = 80
DAILY_TARGET_MAX = 600
DAILY_HISTORY_MAX = 3660       # 单任务最多保留约 10 年逐日记录
DAILY_GOAL_DAYS_MAX = 3660     # 累计打卡目标上限，与逐日历史的十年保护边界一致
DAILY_MILESTONES_MAX = 50      # 用户侧不设小额限制；仅作为异常数据安全边界
DAILY_MILESTONE_NAME_MAX = 40
DAILY_GROUPS_MAX = 60          # 分组数量上限（与任务上限分开计）
DAILY_GROUP_NAME_MAX = 60
DAILY_DEPTH_MAX = 12           # 分组嵌套层级安全上限（够深，主要防御成环/失控缩进）
DAILY_LOCK = threading.RLock()
_DAILY_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _today_iso() -> str:
    return date.today().isoformat()


def _daily_nat(value: object) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _daily_date_list(value: object) -> list[str]:
    """清洗每日任务的逐日打卡记录：只保留 YYYY-MM-DD，去重后按日期升序。"""
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in value:
        day = str(item or "")
        if not _DAILY_DAY_RE.fullmatch(day) or day in seen:
            continue
        seen.add(day)
        out.append(day)
        if len(out) >= DAILY_HISTORY_MAX:
            break
    out.sort()
    return out


def _daily_minutes_by_date(value: object) -> dict[str, int]:
    """清洗每日任务的逐日分钟记录，用于日历详情，不参与勾选状态推导。"""
    if not isinstance(value, dict):
        return {}
    out: dict[str, int] = {}
    for key, minutes in value.items():
        day = str(key or "")
        if not _DAILY_DAY_RE.fullmatch(day):
            continue
        amount = min(_daily_nat(minutes), 24 * 60)
        if amount:
            out[day] = amount
        if len(out) >= DAILY_HISTORY_MAX:
            break
    return dict(sorted(out.items()))


def _daily_streak_ending(done_dates: list[str], anchor: str) -> int:
    dates = set(_daily_date_list(done_dates))
    if anchor not in dates:
        return 0
    try:
        cur = date.fromisoformat(anchor)
    except ValueError:
        return 0
    streak = 0
    while cur.isoformat() in dates:
        streak += 1
        cur -= timedelta(days=1)
    return streak


def _daily_best_streak(done_dates: list[str]) -> int:
    dates = _daily_date_list(done_dates)
    best = 0
    current_len = 0
    prev: date | None = None
    for day in dates:
        try:
            current = date.fromisoformat(day)
        except ValueError:
            continue
        if prev and (current - prev).days == 1:
            current_len += 1
        else:
            current_len = 1
        best = max(best, current_len)
        prev = current
    return best


def _sanitize_daily_milestones(value: object, target_days: int) -> list[dict]:
    """加载旧数据或损坏数据时尽量保留合法里程碑。"""
    if not isinstance(value, list) or target_days <= 0:
        return []
    result: list[dict] = []
    seen_days: set[int] = set()
    seen_ids: set[str] = set()
    for index, item in enumerate(value):
        if len(result) >= DAILY_MILESTONES_MAX:
            break
        if not isinstance(item, dict):
            continue
        name = (item.get("name") if isinstance(item.get("name"), str) else "").strip()
        days = _daily_nat(item.get("days"))
        if not name or days < 1 or days > target_days or days in seen_days:
            continue
        mid = (item.get("id") if isinstance(item.get("id"), str) else "").strip()[:64]
        if not mid or mid in seen_ids:
            mid = f"dm_{days:x}_{index + 1:x}"
            suffix = 1
            while mid in seen_ids:
                suffix += 1
                mid = f"dm_{days:x}_{index + 1:x}_{suffix:x}"
        seen_days.add(days)
        seen_ids.add(mid)
        result.append({"id": mid, "name": name[:DAILY_MILESTONE_NAME_MAX], "days": days})
    result.sort(key=lambda item: item["days"])
    return result


def _validate_daily_milestones(value: object, target_days: int) -> list[dict]:
    """校验客户端提交的完整数组；任一项有误都拒绝整次原子更新。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("小目标格式不正确")
    if len(value) > DAILY_MILESTONES_MAX:
        raise ValueError(f"小目标最多 {DAILY_MILESTONES_MAX} 个")
    if value and target_days <= 0:
        raise ValueError("请先设置累计目标，再添加小目标")
    result: list[dict] = []
    seen_days: set[int] = set()
    seen_ids: set[str] = set()
    for index, item in enumerate(value):
        label = f"第 {index + 1} 个小目标"
        if not isinstance(item, dict):
            raise ValueError(f"{label}格式不正确")
        raw_name = item.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) else ""
        if not name:
            raise ValueError(f"请填写{label}的名称")
        if len(name) > DAILY_MILESTONE_NAME_MAX:
            raise ValueError(f"{label}名称不能超过 {DAILY_MILESTONE_NAME_MAX} 个字符")
        raw_days = item.get("days")
        if isinstance(raw_days, bool):
            raise ValueError(f"{label}的天数必须是正整数")
        if isinstance(raw_days, int):
            days = raw_days
        elif isinstance(raw_days, str) and re.fullmatch(r"[0-9]+", raw_days.strip()):
            days = int(raw_days.strip())
        else:
            raise ValueError(f"{label}的天数必须是正整数")
        if days < 1:
            raise ValueError(f"{label}的天数必须至少为 1")
        if days > target_days:
            raise ValueError(f"{label}（{days} 天）不能超过累计目标 {target_days} 天")
        if days in seen_days:
            raise ValueError(f"不能在第 {days} 天设置两个小目标")
        raw_id = item.get("id")
        mid = raw_id.strip() if isinstance(raw_id, str) else ""
        if len(mid) > 64:
            raise ValueError(f"{label}标识无效")
        if not mid:
            mid = "dm_" + uuid.uuid4().hex[:16]
        if mid in seen_ids:
            raise ValueError("小目标标识重复")
        seen_days.add(days)
        seen_ids.add(mid)
        result.append({"id": mid, "name": name, "days": days})
    result.sort(key=lambda item: item["days"])
    return result


def _sanitize_daily_task(item: object) -> dict | None:
    """把一条每日任务规范化成可信结构；非法直接丢弃（返回 None）。"""
    if not isinstance(item, dict):
        return None
    tid = item.get("id")
    if not isinstance(tid, str) or not tid:
        return None
    last_done = str(item.get("lastDoneDate") or "")
    if not _DAILY_DAY_RE.fullmatch(last_done):
        last_done = ""
    done_dates = _daily_date_list(item.get("doneDates"))
    if last_done and last_done not in done_dates:
        done_dates.append(last_done)
        done_dates.sort()
    target_days = min(_daily_nat(item.get("targetDays")), DAILY_GOAL_DAYS_MAX)
    task = {
        "id": tid[:64],
        "name": (item.get("name") if isinstance(item.get("name"), str) else "").strip()[:DAILY_NAME_MAX],
        "targetMinutes": min(_daily_nat(item.get("targetMinutes")), DAILY_TARGET_MAX),
        "targetDays": target_days,
        "milestones": _sanitize_daily_milestones(item.get("milestones"), target_days),
        "totalDays": _daily_nat(item.get("totalDays")),
        "streak": _daily_nat(item.get("streak")),
        "bestStreak": _daily_nat(item.get("bestStreak")),
        "totalMinutes": _daily_nat(item.get("totalMinutes")),
        "lastDoneDate": last_done,
        "todayMinutes": _daily_nat(item.get("todayMinutes")),
        "doneDates": done_dates[-DAILY_HISTORY_MAX:],
        "minutesByDate": _daily_minutes_by_date(item.get("minutesByDate")),
        "createdAt": str(item.get("createdAt") or "")[:40],
        "groupId": str(item.get("groupId") or "")[:64],   # 所属分组；"" = 挂在根（未分组）
    }
    undo = item.get("undo")
    if isinstance(undo, dict):
        u_last = str(undo.get("lastDoneDate") or "")
        clean_undo = {
            "lastDoneDate": u_last if _DAILY_DAY_RE.fullmatch(u_last) else "",
            "streak": _daily_nat(undo.get("streak")),
            "totalDays": _daily_nat(undo.get("totalDays")),
        }
        if "bestStreak" in undo:
            clean_undo["bestStreak"] = _daily_nat(undo.get("bestStreak"))
        task["undo"] = clean_undo
    return task


def _sanitize_daily_group(item: object) -> dict | None:
    """把一条分组规范化成可信结构；非法直接丢弃（返回 None）。"""
    if not isinstance(item, dict):
        return None
    gid = item.get("id")
    if not isinstance(gid, str) or not gid:
        return None
    return {
        "id": gid[:64],
        "name": (item.get("name") if isinstance(item.get("name"), str) else "").strip()[:DAILY_GROUP_NAME_MAX],
        "parentId": str(item.get("parentId") or "")[:64],
        "collapsed": bool(item.get("collapsed")),
        "createdAt": str(item.get("createdAt") or "")[:40],
    }


def _daily_group_level(by_id: dict, gid: str) -> int:
    """返回某分组所处层级（根分组=1）。遇到断链/成环会自动停。"""
    level = 0
    seen: set[str] = set()
    cur = gid
    while cur and cur in by_id and cur not in seen:
        seen.add(cur)
        level += 1
        cur = by_id[cur].get("parentId") or ""
    return level


def _daily_is_descendant(by_id: dict, ancestor_id: str, node_id: str) -> bool:
    """node_id 沿 parent 往上是否会走到 ancestor_id（用于建组/移动时禁止成环）。"""
    seen: set[str] = set()
    cur = by_id.get(node_id, {}).get("parentId") or ""
    while cur and cur in by_id and cur not in seen:
        if cur == ancestor_id:
            return True
        seen.add(cur)
        cur = by_id[cur].get("parentId") or ""
    return False


def _daily_fix_refs(data: dict) -> None:
    """修复悬挂/成环引用，保证分组树永远干净：断链回根、自环断开、任务悬挂回根。
    这是「删除闭环、不堆积孤儿」的根上保障——任何残缺引用都会在每次加载时被收敛。"""
    groups = data.get("groups", [])
    by_id = {g["id"]: g for g in groups}
    valid = set(by_id)
    for g in groups:
        if (g.get("parentId") or "") and g["parentId"] not in valid:
            g["parentId"] = ""
    for g in groups:                       # 某分组若成了自己的祖先，断到根
        if _daily_is_descendant(by_id, g["id"], g["id"]):
            g["parentId"] = ""
    for t in data.get("tasks", []):        # 任务指向已不存在的分组 → 回根
        if (t.get("groupId") or "") and t["groupId"] not in valid:
            t["groupId"] = ""


def _daily_rollover(data: dict) -> bool:
    """跨天重置：换日后清掉每条任务的今日痕迹（todayMinutes 归零、撤销快照作废）。
    「今天是否完成」由 lastDoneDate==今天 推导，故换日后自动变未完成，无需单独清。返回是否变化。"""
    today = _today_iso()
    if data.get("date") == today:
        return False
    data["date"] = today
    for task in data.get("tasks", []):
        task["todayMinutes"] = 0
        task.pop("undo", None)   # 昨天的完成已成定局，撤销快照作废
    return True


def _daily_payload_from_raw(raw: object) -> dict:
    """把已解析的每日任务数据收敛为可信结构。"""
    if not isinstance(raw, dict):
        raise ValueError("每日任务数据格式不正确")
    raw_tasks = raw.get("tasks", [])
    raw_groups = raw.get("groups", [])
    if not isinstance(raw_tasks, list) or not isinstance(raw_groups, list):
        raise ValueError("每日任务数据格式不正确")
    tasks = []
    for item in raw_tasks:
        task = _sanitize_daily_task(item)
        if task:
            tasks.append(task)
    groups = []
    for item in raw_groups:
        group = _sanitize_daily_group(item)
        if group:
            groups.append(group)
    raw_date = raw.get("date")
    if not (isinstance(raw_date, str) and _DAILY_DAY_RE.fullmatch(raw_date)):
        raw_date = _today_iso()
    data = {
        "version": 3,
        "date": raw_date,
        "tasks": tasks[:DAILY_TASKS_MAX],
        "groups": groups[:DAILY_GROUPS_MAX],
    }
    _daily_fix_refs(data)
    return data


def _read_daily_file(path: Path) -> tuple[dict, bytes]:
    content = path.read_bytes()
    raw = json.loads(content.decode("utf-8-sig"))
    return _daily_payload_from_raw(raw), content


def _daily_corrupt_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = DAILY_FILE.with_name(f"daily.corrupt-{stamp}.json")
    if target.exists():
        target = DAILY_FILE.with_name(f"daily.corrupt-{stamp}-{uuid.uuid4().hex[:6]}.json")
    return target


def _preserve_corrupt_daily(content: bytes) -> None:
    """隔离损坏的每日任务原件，避免后续正常操作直接覆盖。"""
    target = _daily_corrupt_path()
    try:
        os.replace(DAILY_FILE, target)
        return
    except OSError:
        pass
    try:
        _atomic_write_bytes(target, content)
        DAILY_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _daily_storage_payload(data: dict) -> dict:
    return {
        "version": 3,
        "date": data.get("date") or _today_iso(),
        "tasks": data.get("tasks", [])[:DAILY_TASKS_MAX],
        "groups": data.get("groups", [])[:DAILY_GROUPS_MAX],
    }


def _save_daily_unlocked(data: dict, *, backup: bool = True) -> None:
    payload = _daily_storage_payload(data)
    backup_written = False
    if backup and DAILY_FILE.is_file():
        try:
            _current, current_bytes = _read_daily_file(DAILY_FILE)
            _atomic_write_bytes(DAILY_BACKUP_FILE, current_bytes)
            backup_written = True
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            pass
    _atomic_write_json(DAILY_FILE, payload)
    if not backup_written:
        try:
            _read_daily_file(DAILY_BACKUP_FILE)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            try:
                _atomic_write_json(DAILY_BACKUP_FILE, payload)
            except OSError:
                pass


def load_daily() -> dict:
    """读每日任务清单；损坏时隔离原件并尝试恢复上一份有效快照。"""
    if not DAILY_FILE.exists():
        return {"version": 3, "date": _today_iso(), "tasks": [], "groups": []}
    content = b""
    recovered = False
    try:
        data, content = _read_daily_file(DAILY_FILE)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        _preserve_corrupt_daily(content)
        try:
            data, _backup_content = _read_daily_file(DAILY_BACKUP_FILE)
            recovered = True
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            data = {"version": 3, "date": _today_iso(), "tasks": [], "groups": []}
    rolled_over = _daily_rollover(data)
    if recovered or rolled_over:
        try:
            _save_daily_unlocked(data, backup=not recovered)
        except OSError:
            pass
    return data


def save_daily(data: dict) -> None:
    _save_daily_unlocked(data)


def _daily_find(data: dict, task_id: str) -> dict:
    for task in data.get("tasks", []):
        if task.get("id") == task_id:
            return task
    raise KeyError("找不到这条每日任务")


def _daily_group_find(data: dict, gid: str) -> dict:
    for group in data.get("groups", []):
        if group.get("id") == gid:
            return group
    raise KeyError("找不到这个分组")


def _daily_valid_group_id(data: dict, gid: object) -> str:
    """把传入 groupId 收敛成可信值：空或指向不存在的分组都归 ""（根）。"""
    gid = str(gid or "").strip()[:64]
    if not gid:
        return ""
    return gid if any(g.get("id") == gid for g in data.get("groups", [])) else ""


def daily_public_payload(data: dict | None = None) -> dict:
    """对前端的安全视图：每条任务带派生字段 doneToday（今天是否已完成），不外泄 undo 快照。"""
    daily = data if isinstance(data, dict) else load_daily()
    today = _today_iso()
    out = []
    for task in daily.get("tasks", []):
        out.append({
            "id": task.get("id"),
            "name": task.get("name") or "",
            "targetMinutes": _daily_nat(task.get("targetMinutes")),
            "targetDays": min(_daily_nat(task.get("targetDays")), DAILY_GOAL_DAYS_MAX),
            "milestones": [dict(item) for item in task.get("milestones", [])],
            "totalDays": _daily_nat(task.get("totalDays")),
            "streak": _daily_nat(task.get("streak")),
            "bestStreak": _daily_nat(task.get("bestStreak")),
            "totalMinutes": _daily_nat(task.get("totalMinutes")),
            "todayMinutes": _daily_nat(task.get("todayMinutes")),
            "doneDates": _daily_date_list(task.get("doneDates")),
            "minutesByDate": _daily_minutes_by_date(task.get("minutesByDate")),
            "lastDoneDate": task.get("lastDoneDate") or "",
            "doneToday": task.get("lastDoneDate") == today,
            "groupId": task.get("groupId") or "",
        })
    groups_out = [{
        "id": g.get("id"),
        "name": g.get("name") or "",
        "parentId": g.get("parentId") or "",
        "collapsed": bool(g.get("collapsed")),
    } for g in daily.get("groups", [])]
    return {"version": 3, "date": daily.get("date") or today, "tasks": out, "groups": groups_out}


def daily_create(body: dict) -> dict:
    data = load_daily()
    if len(data["tasks"]) >= DAILY_TASKS_MAX:
        raise ValueError(f"每日任务最多 {DAILY_TASKS_MAX} 条")
    name = str(body.get("name") or "").strip()[:DAILY_NAME_MAX] if isinstance(body, dict) else ""
    if not name:
        raise ValueError("请填写每日任务名称")
    target = min(_daily_nat(body.get("targetMinutes")), DAILY_TARGET_MAX)
    target_days = min(_daily_nat(body.get("targetDays")), DAILY_GOAL_DAYS_MAX)
    milestones = _validate_daily_milestones(body.get("milestones", []), target_days)
    group_id = _daily_valid_group_id(data, body.get("groupId") if isinstance(body, dict) else "")
    task = {
        "id": "dt_" + format(int(datetime.now().timestamp() * 1000), "x") + "_" + uuid.uuid4().hex[:3],
        "name": name,
        "targetMinutes": target,
        "targetDays": target_days,
        "milestones": milestones,
        "totalDays": 0,
        "streak": 0,
        "bestStreak": 0,
        "totalMinutes": 0,
        "lastDoneDate": "",
        "todayMinutes": 0,
        "doneDates": [],
        "minutesByDate": {},
        "createdAt": datetime.now().replace(microsecond=0).isoformat(),
        "groupId": group_id,
    }
    data["tasks"].append(task)
    save_daily(data)
    return daily_public_payload(data)


def daily_update(body: dict) -> dict:
    data = load_daily()
    task = _daily_find(data, str(body.get("id") or "").strip() if isinstance(body, dict) else "")
    next_name = task.get("name") or ""
    if "name" in body:
        name = str(body.get("name") or "").strip()[:DAILY_NAME_MAX]
        if not name:
            raise ValueError("名称不能为空")
        next_name = name
    next_target_minutes = task.get("targetMinutes", 0)
    if "targetMinutes" in body:
        next_target_minutes = min(_daily_nat(body.get("targetMinutes")), DAILY_TARGET_MAX)
    next_target_days = min(_daily_nat(task.get("targetDays")), DAILY_GOAL_DAYS_MAX)
    if "targetDays" in body:
        next_target_days = min(_daily_nat(body.get("targetDays")), DAILY_GOAL_DAYS_MAX)
    milestone_source = body.get("milestones") if "milestones" in body else task.get("milestones", [])
    next_milestones = _validate_daily_milestones(milestone_source, next_target_days)
    task["name"] = next_name
    task["targetMinutes"] = next_target_minutes
    task["targetDays"] = next_target_days
    task["milestones"] = next_milestones
    if "groupId" in body:
        task["groupId"] = _daily_valid_group_id(data, body.get("groupId"))
    save_daily(data)
    return daily_public_payload(data)


def daily_delete(body: dict) -> dict:
    data = load_daily()
    task_id = str(body.get("id") or "").strip() if isinstance(body, dict) else ""
    before = len(data["tasks"])
    data["tasks"] = [t for t in data["tasks"] if t.get("id") != task_id]
    if len(data["tasks"]) == before:
        raise KeyError("找不到这条每日任务")
    save_daily(data)
    return daily_public_payload(data)


def daily_toggle(body: dict) -> dict:
    """勾选 / 取消今天的完成。完成时按「连续天数」规则更新并存一份撤销快照，
    取消时优先用快照精确还原，保证误点可逆。"""
    data = load_daily()
    task = _daily_find(data, str(body.get("id") or "").strip() if isinstance(body, dict) else "")
    want_done = bool(body.get("done")) if isinstance(body, dict) else False
    today = _today_iso()
    dates = _daily_date_list(task.get("doneDates"))
    if task.get("lastDoneDate") == today and today not in dates:
        dates.append(today)
        dates.sort()
    is_done = today in dates
    if want_done and not is_done:
        task["undo"] = {
            "lastDoneDate": task.get("lastDoneDate") or "",
            "streak": _daily_nat(task.get("streak")),
            "bestStreak": _daily_nat(task.get("bestStreak")),
            "totalDays": _daily_nat(task.get("totalDays")),
        }
        dates.append(today)
        dates.sort()
        task["doneDates"] = dates[-DAILY_HISTORY_MAX:]
        task["lastDoneDate"] = today
        task["totalDays"] = max(_daily_nat(task.get("totalDays")) + 1, len(dates))
        task["streak"] = _daily_streak_ending(dates, today)
        task["bestStreak"] = max(_daily_nat(task.get("bestStreak")), task["streak"], _daily_best_streak(dates))
    elif not want_done and is_done:
        undo = task.get("undo")
        dates = [day for day in dates if day != today]
        task["doneDates"] = dates[-DAILY_HISTORY_MAX:]
        if isinstance(undo, dict):
            task["totalDays"] = max(_daily_nat(undo.get("totalDays")), len(dates))
        else:
            task["totalDays"] = max(0, _daily_nat(task.get("totalDays")) - 1)
        if dates:
            task["lastDoneDate"] = dates[-1]
            task["streak"] = _daily_streak_ending(dates, dates[-1])
        elif isinstance(undo, dict):
            task["lastDoneDate"] = undo.get("lastDoneDate") or ""
            task["streak"] = _daily_nat(undo.get("streak"))
        else:
            task["lastDoneDate"] = ""
            task["streak"] = 0
        if isinstance(undo, dict) and "bestStreak" in undo:
            task["bestStreak"] = _daily_nat(undo.get("bestStreak"))
        else:
            task["bestStreak"] = _daily_best_streak(dates)
        task.pop("undo", None)
    save_daily(data)
    return daily_public_payload(data)


def daily_add_minutes(body: dict) -> dict:
    """把一段专注的分钟累计到某条每日任务（今日 + 累计都加）；勾选状态与之解耦。"""
    data = load_daily()
    task = _daily_find(data, str(body.get("id") or "").strip() if isinstance(body, dict) else "")
    minutes = min(_daily_nat(body.get("minutes")), 24 * 60)
    if minutes:
        task["todayMinutes"] = _daily_nat(task.get("todayMinutes")) + minutes
        task["totalMinutes"] = _daily_nat(task.get("totalMinutes")) + minutes
        by_date = _daily_minutes_by_date(task.get("minutesByDate"))
        today = _today_iso()
        by_date[today] = min(24 * 60, by_date.get(today, 0) + minutes)
        task["minutesByDate"] = by_date
        save_daily(data)
    return daily_public_payload(data)


def daily_reorder(body: dict) -> dict:
    """按 ids 重排清单；未列出的容错保留原相对顺序，未知 id 忽略，只重排不改字段。"""
    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list):
        raise ValueError("缺少 ids 数组")
    data = load_daily()
    by_id = {t.get("id"): t for t in data["tasks"]}
    seen = set()
    new_list = []
    for tid in ids:
        if tid in by_id and tid not in seen:
            new_list.append(by_id[tid])
            seen.add(tid)
    for t in data["tasks"]:
        if t.get("id") not in seen:
            new_list.append(t)
    data["tasks"] = new_list
    save_daily(data)
    return daily_public_payload(data)


def daily_group_create(body: dict) -> dict:
    data = load_daily()
    groups = data.setdefault("groups", [])
    if len(groups) >= DAILY_GROUPS_MAX:
        raise ValueError(f"分组最多 {DAILY_GROUPS_MAX} 个")
    name = str(body.get("name") or "").strip()[:DAILY_GROUP_NAME_MAX] if isinstance(body, dict) else ""
    if not name:
        raise ValueError("请填写分组名称")
    parent_id = str(body.get("parentId") or "").strip()[:64] if isinstance(body, dict) else ""
    by_id = {g["id"]: g for g in groups}
    if parent_id and parent_id not in by_id:
        parent_id = ""
    level = (_daily_group_level(by_id, parent_id) + 1) if parent_id else 1
    if level > DAILY_DEPTH_MAX:
        raise ValueError(f"分组最多 {DAILY_DEPTH_MAX} 层")
    group = {
        "id": "dg_" + format(int(datetime.now().timestamp() * 1000), "x") + "_" + uuid.uuid4().hex[:3],
        "name": name,
        "parentId": parent_id,
        "collapsed": False,
        "createdAt": datetime.now().replace(microsecond=0).isoformat(),
    }
    groups.append(group)
    save_daily(data)
    return daily_public_payload(data)


def daily_group_update(body: dict) -> dict:
    data = load_daily()
    group = _daily_group_find(data, str(body.get("id") or "").strip() if isinstance(body, dict) else "")
    if "name" in body:
        name = str(body.get("name") or "").strip()[:DAILY_GROUP_NAME_MAX]
        if not name:
            raise ValueError("分组名不能为空")
        group["name"] = name
    if "collapsed" in body:
        group["collapsed"] = bool(body.get("collapsed"))
    save_daily(data)
    return daily_public_payload(data)


def daily_group_delete(body: dict) -> dict:
    """删除分组：把它的直接子分组和任务上提到它的父级。绝不连带删任务，也不留孤儿。"""
    data = load_daily()
    gid = str(body.get("id") or "").strip() if isinstance(body, dict) else ""
    group = _daily_group_find(data, gid)
    new_parent = group.get("parentId") or ""
    for g in data.get("groups", []):
        if (g.get("parentId") or "") == gid:
            g["parentId"] = new_parent
    for t in data.get("tasks", []):
        if (t.get("groupId") or "") == gid:
            t["groupId"] = new_parent
    data["groups"] = [g for g in data.get("groups", []) if g.get("id") != gid]
    save_daily(data)
    return daily_public_payload(data)


def daily_tree_set(body: dict) -> dict:
    """整树覆盖（拖拽落盘）：前端把所有分组(带 parentId/collapsed)和任务(带 groupId)按目标顺序整体发回。
    校验成环/深度、收敛悬挂、按给定顺序重排、原子落盘；未知 id 忽略，漏报的项保留在末尾。"""
    if not isinstance(body, dict) or not isinstance(body.get("groups"), list) or not isinstance(body.get("tasks"), list):
        raise ValueError("缺少 groups / tasks 数组")
    data = load_daily()
    groups_by_id = {g["id"]: g for g in data.get("groups", [])}
    tasks_by_id = {t["id"]: t for t in data.get("tasks", [])}

    new_groups = []
    seen_g = set()
    for item in body["groups"]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("id") or "")
        group = groups_by_id.get(gid)
        if group is None or gid in seen_g:
            continue
        seen_g.add(gid)
        pid = str(item.get("parentId") or "")
        group["parentId"] = pid if pid in groups_by_id else ""
        if "collapsed" in item:
            group["collapsed"] = bool(item.get("collapsed"))
        new_groups.append(group)
    for group in data.get("groups", []):          # 漏报的分组保留在末尾
        if group["id"] not in seen_g:
            new_groups.append(group)

    by_id = {g["id"]: g for g in new_groups}
    for group in new_groups:                       # 成环 / 超深度直接拒绝（前端已规避，这里兜底）
        if _daily_is_descendant(by_id, group["id"], group["id"]):
            raise ValueError("分组层级出现环，已拒绝")
        if _daily_group_level(by_id, group["id"]) > DAILY_DEPTH_MAX:
            raise ValueError(f"分组最多 {DAILY_DEPTH_MAX} 层")
    data["groups"] = new_groups

    valid_groups = set(by_id)
    new_tasks = []
    seen_t = set()
    for item in body["tasks"]:
        if not isinstance(item, dict):
            continue
        tid = str(item.get("id") or "")
        task = tasks_by_id.get(tid)
        if task is None or tid in seen_t:
            continue
        seen_t.add(tid)
        gid = str(item.get("groupId") or "")
        task["groupId"] = gid if gid in valid_groups else ""
        new_tasks.append(task)
    for task in data.get("tasks", []):             # 漏报的任务保留在末尾
        if task["id"] not in seen_t:
            new_tasks.append(task)
    data["tasks"] = new_tasks

    _daily_fix_refs(data)
    save_daily(data)
    return daily_public_payload(data)


# 纯结构模板：只收正文/文字框和基础装饰；画布专属素材与其他历史图案一律不收。
TEMPLATES_MAX = 300
TEMPLATE_NODES_MAX = 1000
TEMPLATE_EDGES_MAX = 2000
_TEMPLATE_SKIP_KINDS = {"image", "pdf", "md"}
_TEMPLATE_ALLOWED_SHAPE_TYPES = {
    "group-box",
    "color-block",
    "dashed-box",
    "rounded-rect",
    "arrow",
    "diamond",
    "pill",
    "parallelogram",
    "corner-frame",
    "bracket",
    "curly-brace",
    "divider",
    "question",
    "symbol-info",
    "symbol-idea",
    "symbol-check",
    "symbol-cross",
    "symbol-flag",
    "symbol-warning",
    "symbol-clock",
    "symbol-flask",
    "symbol-reference",
    "symbol-quote",
    "symbol-observation",
    "symbol-interface",
    "symbol-database",
    "symbol-dataset",
    "symbol-filter",
    "sketch-rounded-rect",
    "sketch-diamond",
    "sketch-ellipse",
    "sketch-arrow",
}


def _build_templates_payload(templates) -> dict:
    """清洗模板库：保证 {version, templates[]} 结构。每个模板只留可移植的纯结构元素
    （正文/文字框/当前内置图案）+ 两端都在模板内的连线。前端已按此规则裁剪，这里再兜
    一层底，确保 templates.json 永不写入带画布专属素材引用的节点（删除即闭环、无孤儿）。"""
    out = []
    if not isinstance(templates, list):
        templates = []
    for item in templates:
        if not isinstance(item, dict):
            continue
        raw_nodes = item.get("nodes")
        if not isinstance(raw_nodes, list):
            continue
        nodes = []
        node_ids = set()
        for node in raw_nodes:
            if not isinstance(node, dict):
                continue
            kind = str(node.get("kind") or "")
            if kind in _TEMPLATE_SKIP_KINDS:
                continue
            if kind == "shape" and str(node.get("shapeType") or "") not in _TEMPLATE_ALLOWED_SHAPE_TYPES:
                continue
            nid = str(node.get("id") or "")
            if not nid or nid in node_ids:
                continue
            node_ids.add(nid)
            nodes.append(node)
        if not nodes:
            continue                      # 空模板不存
        for node in nodes:
            raw_members = node.get("groupMemberIds")
            if not isinstance(raw_members, list):
                continue
            members = []
            seen_members = set()
            for raw_member in raw_members:
                member_id = str(raw_member or "")
                if member_id in node_ids and member_id not in seen_members:
                    seen_members.add(member_id)
                    members.append(member_id)
            if members:
                node["groupMemberIds"] = members
            else:
                node.pop("groupMemberIds", None)
        edges = []
        raw_edges = item.get("edges")
        if isinstance(raw_edges, list):
            for edge in raw_edges:
                if not isinstance(edge, dict):
                    continue
                if str(edge.get("from") or "") in node_ids and str(edge.get("to") or "") in node_ids:
                    edges.append(edge)
        try:
            w = max(0.0, float(item.get("w") or 0))
            h = max(0.0, float(item.get("h") or 0))
        except (TypeError, ValueError):
            w = h = 0.0
        out.append({
            "id": str(item.get("id") or "") or ("tpl_" + uuid.uuid4().hex[:12]),
            "name": (str(item.get("name") or "").strip() or "未命名模板")[:60],
            "createdAt": str(item.get("createdAt") or ""),
            "w": round(w, 2),
            "h": round(h, 2),
            "nodes": nodes,
            "edges": edges,
        })
    return {"version": 1, "templates": out}


def load_templates() -> dict:
    try:
        raw = json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"version": 1, "templates": []}
    if not isinstance(raw, dict):
        return {"version": 1, "templates": []}
    return _build_templates_payload(raw.get("templates", []))


def save_templates(data: dict) -> dict:
    payload = _build_templates_payload(data.get("templates", []) if isinstance(data, dict) else [])
    _atomic_write_json(TEMPLATES_FILE, payload)
    return payload


def study_canvas_options() -> list[dict]:
    options = []
    for path in CANVASES.glob("*.canvas"):
        if path.is_file():
            options.append({"path": _norm(path), "title": path.stem})
    options.sort(key=lambda item: item["title"].casefold())
    return options


def study_public_payload() -> dict:
    return load_study()


def _empty_canvas_activity() -> dict:
    return {
        "version": CANVAS_ACTIVITY_SCHEMA,
        "backfillVersion": 0,
        "canvases": {},
        "paths": {},
        "days": {},
    }


def _canvas_activity_path_key(path: Path | str) -> str:
    return os.path.normcase(_norm(path))


def _normalize_canvas_activity(raw: object) -> dict:
    source = raw if isinstance(raw, dict) else {}
    payload = _empty_canvas_activity()
    try:
        payload["backfillVersion"] = max(0, int(source.get("backfillVersion") or 0))
    except (TypeError, ValueError):
        pass
    canvases = source.get("canvases")
    if isinstance(canvases, dict):
        for canvas_id, item in canvases.items():
            if not isinstance(item, dict):
                continue
            cid = str(canvas_id or "").strip()
            path = str(item.get("path") or "").strip()
            if not cid or not path:
                continue
            aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
            clean = {
                "path": path,
                "title": str(item.get("title") or Path(path).stem or "Untitled")[:240],
                "aliases": list(dict.fromkeys(
                    str(alias) for alias in aliases if str(alias or "").strip()
                ))[-24:],
                "firstSeenAt": str(item.get("firstSeenAt") or ""),
                "lastSeenAt": str(item.get("lastSeenAt") or ""),
                "backfilled": bool(item.get("backfilled")),
            }
            payload["canvases"][cid] = clean
            payload["paths"][_canvas_activity_path_key(path)] = cid
    days = source.get("days")
    if isinstance(days, dict):
        for day, entries in days.items():
            day_key = str(day or "")
            try:
                date.fromisoformat(day_key)
            except ValueError:
                continue
            if not isinstance(entries, dict):
                continue
            clean_entries = {}
            for canvas_id, item in entries.items():
                cid = str(canvas_id or "").strip()
                if not cid or not isinstance(item, dict):
                    continue
                spans = []
                for span in item.get("spans", []):
                    if not isinstance(span, list) or len(span) != 2:
                        continue
                    try:
                        start = max(0.0, min(86400.0, float(span[0])))
                        end = max(start, min(86400.0, float(span[1])))
                    except (TypeError, ValueError):
                        continue
                    if end > start:
                        spans.append([start, end])
                merged = _merge_canvas_activity_spans(spans)
                clean_entries[cid] = {
                    "spans": merged,
                    "seconds": int(round(sum(end - start for start, end in merged))),
                    "created": bool(item.get("created")),
                    "modified": bool(item.get("modified")),
                    "inferred": bool(item.get("inferred")),
                }
            if clean_entries:
                payload["days"][day_key] = clean_entries
    return payload


def _load_canvas_activity_unlocked() -> dict:
    if not CANVAS_ACTIVITY_FILE.is_file():
        return _empty_canvas_activity()
    try:
        raw = json.loads(CANVAS_ACTIVITY_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return _empty_canvas_activity()
    return _normalize_canvas_activity(raw)


def _save_canvas_activity_unlocked(data: dict) -> None:
    data["version"] = CANVAS_ACTIVITY_SCHEMA
    _atomic_write_json(CANVAS_ACTIVITY_FILE, data)


def _merge_canvas_activity_spans(spans: list[list[float]]) -> list[list[float]]:
    ordered = sorted(
        ([float(span[0]), float(span[1])] for span in spans if span[1] > span[0]),
        key=lambda span: span[0],
    )
    merged: list[list[float]] = []
    for start, end in ordered:
        if merged and start <= merged[-1][1] + 0.25:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [[round(start, 3), round(end, 3)] for start, end in merged]


def _canvas_activity_recent_id(path: Path | str) -> str:
    key = _canvas_activity_path_key(path)
    recent = load_recent()
    for item in recent.get("files", []):
        if _canvas_activity_path_key(item.get("path", "")) == key:
            value = str(item.get("id") or "").strip()
            if value:
                return value
    return uuid.uuid4().hex


def _ensure_canvas_activity_identity(
    data: dict,
    path: Path | str,
    *,
    title: str | None = None,
) -> tuple[str, dict, bool]:
    normalized = _norm(path)
    key = _canvas_activity_path_key(normalized)
    canvas_id = str(data.get("paths", {}).get(key) or "")
    changed = False
    if canvas_id not in data.get("canvases", {}):
        canvas_id = _canvas_activity_recent_id(normalized)
        while canvas_id in data.get("canvases", {}):
            canvas_id = uuid.uuid4().hex
        now = _study_now()
        data.setdefault("canvases", {})[canvas_id] = {
            "path": normalized,
            "title": str(title or Path(normalized).stem or "Untitled")[:240],
            "aliases": [],
            "firstSeenAt": now,
            "lastSeenAt": now,
            "backfilled": False,
        }
        data.setdefault("paths", {})[key] = canvas_id
        changed = True
    meta = data["canvases"][canvas_id]
    if meta.get("path") != normalized:
        previous = str(meta.get("path") or "")
        aliases = list(meta.get("aliases") or [])
        if previous and previous not in aliases:
            aliases.append(previous)
        meta["aliases"] = aliases[-24:]
        meta["path"] = normalized
        if previous:
            data.setdefault("paths", {}).pop(_canvas_activity_path_key(previous), None)
        data.setdefault("paths", {})[key] = canvas_id
        changed = True
    next_title = str(title or Path(normalized).stem or meta.get("title") or "Untitled")[:240]
    if meta.get("title") != next_title:
        meta["title"] = next_title
        changed = True
    meta["lastSeenAt"] = _study_now()
    return canvas_id, meta, changed


def _canvas_activity_day_entry(data: dict, day: str, canvas_id: str) -> dict:
    entries = data.setdefault("days", {}).setdefault(day, {})
    return entries.setdefault(canvas_id, {
        "spans": [], "seconds": 0, "created": False, "modified": False, "inferred": False,
    })


def _canvas_activity_file_times(path: Path, payload: dict | None = None) -> tuple[str, str]:
    content = payload if isinstance(payload, dict) else None
    if content is None:
        try:
            content = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            content = {}
    try:
        stat = path.stat()
    except OSError:
        stat = None
    created = str(content.get("createdAt") or "").strip()
    updated = str(content.get("updatedAt") or "").strip()
    if not created and stat is not None:
        created = datetime.fromtimestamp(getattr(stat, "st_birthtime", stat.st_ctime)).isoformat()
    if not updated and stat is not None:
        updated = datetime.fromtimestamp(stat.st_mtime).isoformat()
    return created, updated


def _canvas_activity_day(value: object) -> str:
    raw = str(value or "").strip()[:10]
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        return ""


def _backfill_canvas_activity_file_unlocked(
    data: dict,
    path: Path,
    *,
    payload: dict | None = None,
) -> tuple[str, bool]:
    canvas_id, meta, changed = _ensure_canvas_activity_identity(data, path, title=path.stem)
    if meta.get("backfilled"):
        return canvas_id, changed
    created_at, updated_at = _canvas_activity_file_times(path, payload)
    created_day = _canvas_activity_day(created_at)
    updated_day = _canvas_activity_day(updated_at)
    if created_day:
        entry = _canvas_activity_day_entry(data, created_day, canvas_id)
        entry["created"] = True
        entry["inferred"] = True
    if updated_day:
        entry = _canvas_activity_day_entry(data, updated_day, canvas_id)
        entry["modified"] = True
        entry["inferred"] = True
    meta["backfilled"] = True
    return canvas_id, True


def _canvas_activity_backfill_all_unlocked(data: dict) -> bool:
    if int(data.get("backfillVersion") or 0) >= CANVAS_ACTIVITY_SCHEMA:
        return False
    candidates: dict[str, Path] = {}
    if CANVASES.exists():
        for path in CANVASES.glob("*.canvas"):
            if path.is_file():
                candidates[_canvas_activity_path_key(path)] = path
    for raw in recent_paths():
        path = Path(raw)
        if path.is_file() and is_authorized(path) and not is_in_trash(path):
            candidates[_canvas_activity_path_key(path)] = path
    for path in candidates.values():
        _backfill_canvas_activity_file_unlocked(data, path)
    data["backfillVersion"] = CANVAS_ACTIVITY_SCHEMA
    return True


@_serialized_data
def canvas_activity_register_path(path: Path, payload: dict | None = None) -> dict:
    data = _load_canvas_activity_unlocked()
    changed = _canvas_activity_backfill_all_unlocked(data)
    canvas_id, file_changed = _backfill_canvas_activity_file_unlocked(data, path, payload=payload)
    changed = changed or file_changed
    if changed:
        _save_canvas_activity_unlocked(data)
    return _canvas_activity_totals(data, canvas_id)


@_serialized_data
def record_canvas_activity_event(
    path: Path,
    event: str,
    *,
    when: str | None = None,
    payload: dict | None = None,
) -> dict:
    data = _load_canvas_activity_unlocked()
    canvas_id, meta, _ = _ensure_canvas_activity_identity(data, path, title=path.stem)
    meta["backfilled"] = True
    day = _canvas_activity_day(when or _study_now())
    entry = _canvas_activity_day_entry(data, day, canvas_id)
    if event == "created":
        entry["created"] = True
    elif event == "modified":
        entry["modified"] = True
    else:
        raise ValueError("未知画布活动类型")
    entry["inferred"] = False
    _save_canvas_activity_unlocked(data)
    return _canvas_activity_totals(data, canvas_id)


@_serialized_data
def move_canvas_activity_path(src: Path | str, dst: Path | str) -> None:
    data = _load_canvas_activity_unlocked()
    source_key = _canvas_activity_path_key(src)
    canvas_id = str(data.get("paths", {}).get(source_key) or "")
    if canvas_id not in data.get("canvases", {}):
        return
    meta = data["canvases"][canvas_id]
    old_path = str(meta.get("path") or _norm(src))
    aliases = list(meta.get("aliases") or [])
    if old_path and old_path not in aliases:
        aliases.append(old_path)
    meta["aliases"] = aliases[-24:]
    meta["path"] = _norm(dst)
    meta["title"] = Path(dst).stem
    meta["lastSeenAt"] = _study_now()
    data.setdefault("paths", {}).pop(source_key, None)
    data["paths"][_canvas_activity_path_key(dst)] = canvas_id
    _save_canvas_activity_unlocked(data)


def _parse_canvas_activity_time(value: object) -> datetime:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("缺少计时起止时间")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as err:
        raise ValueError("计时时间格式不正确") from err
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _split_canvas_activity_interval(start: datetime, end: datetime) -> list[tuple[str, float, float]]:
    parts = []
    cursor = start
    while cursor < end:
        midnight = datetime.combine(cursor.date() + timedelta(days=1), datetime.min.time())
        part_end = min(end, midnight)
        day_start = datetime.combine(cursor.date(), datetime.min.time())
        parts.append((
            cursor.date().isoformat(),
            (cursor - day_start).total_seconds(),
            (part_end - day_start).total_seconds(),
        ))
        cursor = part_end
    return parts


def _canvas_activity_totals(data: dict, canvas_id: str) -> dict:
    today = date.today().isoformat()
    total = 0
    today_total = 0
    for day, entries in data.get("days", {}).items():
        entry = entries.get(canvas_id) if isinstance(entries, dict) else None
        if not isinstance(entry, dict):
            continue
        seconds = max(0, int(entry.get("seconds") or 0))
        total += seconds
        if day == today:
            today_total = seconds
    return {"canvasId": canvas_id, "todaySec": today_total, "totalSec": total}


def _canvas_activity_total_seconds_by_id(data: dict) -> dict[str, int]:
    totals: dict[str, int] = {}
    for entries in data.get("days", {}).values():
        if not isinstance(entries, dict):
            continue
        for canvas_id, entry in entries.items():
            if isinstance(entry, dict):
                totals[canvas_id] = totals.get(canvas_id, 0) + max(0, int(entry.get("seconds") or 0))
    return totals


@_serialized_data
def record_canvas_activity_interval(body: dict) -> dict:
    path = Path(str(body.get("path") or "").strip())
    if not str(path) or not path.is_file():
        raise FileNotFoundError("画布文件不存在")
    if path.suffix.lower() != ".canvas":
        raise ValueError("计时目标不是 .canvas 文件")
    if not is_authorized(path):
        raise PermissionError("画布路径未授权")
    session_id = str(body.get("sessionId") or "").strip()
    if not session_id or len(session_id) > 160:
        raise ValueError("计时会话标识无效")
    start = _parse_canvas_activity_time(body.get("startedAt"))
    end = _parse_canvas_activity_time(body.get("endedAt"))
    duration = (end - start).total_seconds()
    if duration <= 0 or duration > CANVAS_ACTIVITY_HEARTBEAT_MAX_SEC:
        raise ValueError("计时时段长度无效")
    if end > datetime.now() + timedelta(minutes=2):
        raise ValueError("计时时段不能位于未来")
    data = _load_canvas_activity_unlocked()
    canvas_id, meta, _ = _ensure_canvas_activity_identity(data, path, title=path.stem)
    if not meta.get("backfilled"):
        _backfill_canvas_activity_file_unlocked(data, path)
    for day, start_sec, end_sec in _split_canvas_activity_interval(start, end):
        entry = _canvas_activity_day_entry(data, day, canvas_id)
        entry["spans"] = _merge_canvas_activity_spans(
            list(entry.get("spans") or []) + [[start_sec, end_sec]]
        )
        entry["seconds"] = int(round(sum(b - a for a, b in entry["spans"])))
    _save_canvas_activity_unlocked(data)
    return _canvas_activity_totals(data, canvas_id)


@_serialized_data
def canvas_activity_snapshot() -> dict:
    data = _load_canvas_activity_unlocked()
    changed = _canvas_activity_backfill_all_unlocked(data)
    if changed:
        _save_canvas_activity_unlocked(data)
    return data


def _canvas_activity_payload(data: dict, year: int) -> dict:
    prefix = f"{year:04d}-"
    canvases = data.get("canvases", {})
    all_totals = _canvas_activity_total_seconds_by_id(data)

    days_payload: dict[str, dict] = {}
    entry_payload: list[dict] = []
    active_ids: set[str] = set()
    created_count = 0
    month_buckets: dict[str, dict[str, dict]] = {}
    for day in sorted(data.get("days", {})):
        if not day.startswith(prefix):
            continue
        entries = data["days"].get(day)
        if not isinstance(entries, dict):
            continue
        day_sec = 0
        day_created = 0
        day_modified = 0
        day_inferred = False
        day_ids: set[str] = set()
        for canvas_id, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            seconds = max(0, int(entry.get("seconds") or 0))
            created = bool(entry.get("created"))
            modified = bool(entry.get("modified"))
            inferred = bool(entry.get("inferred")) and not seconds
            if not seconds and not created and not modified:
                continue
            meta = canvases.get(canvas_id, {}) if isinstance(canvases.get(canvas_id), dict) else {}
            path = str(meta.get("path") or "")
            title = str(meta.get("title") or (Path(path).stem if path else "Untitled"))
            available = bool(path and Path(path).is_file() and is_authorized(Path(path)) and not is_in_trash(Path(path)))
            item = {
                "id": canvas_id,
                "day": day,
                "title": title,
                "path": path,
                "canvasAvailable": available,
                "durationSec": seconds,
                "totalDurationSec": all_totals.get(canvas_id, 0),
                "created": created,
                "modified": modified,
                "inferred": inferred,
            }
            entry_payload.append(item)
            day_sec += seconds
            day_created += int(created)
            day_modified += int(modified)
            day_inferred = day_inferred or inferred
            day_ids.add(canvas_id)
            active_ids.add(canvas_id)
            created_count += int(created)
            month = day[:7]
            bucket = month_buckets.setdefault(month, {})
            canvas_bucket = bucket.setdefault(canvas_id, {
                "id": canvas_id, "title": title, "durationSec": 0,
                "totalDurationSec": all_totals.get(canvas_id, 0),
                "day": day, "path": path, "canvasAvailable": available, "inferred": False,
            })
            canvas_bucket["durationSec"] += seconds
            canvas_bucket["day"] = max(str(canvas_bucket.get("day") or ""), day)
            canvas_bucket["inferred"] = bool(canvas_bucket.get("inferred")) or inferred
        if day_ids:
            days_payload[day] = {
                "durationSec": day_sec,
                "canvasCount": len(day_ids),
                "createdCount": day_created,
                "modifiedCount": day_modified,
                "inferred": day_inferred and day_sec == 0,
            }

    entry_payload.sort(key=lambda item: (item["day"], item["durationSec"], item["title"]), reverse=True)
    graph_months = []
    for month in sorted(month_buckets):
        items = list(month_buckets[month].values())
        graph_months.append({
            "month": month,
            "total": len(items),
            "durationSec": sum(item["durationSec"] for item in items),
            "named": sorted(items, key=lambda item: (item["durationSec"], item["title"]), reverse=True),
            "unnamed": 0,
        })

    active_days = {day: 1 for day, item in days_payload.items() if item["durationSec"] or item["inferred"] or item["createdCount"] or item["modifiedCount"]}
    today = date.today()
    cursor = today if active_days.get(today.isoformat()) else today - timedelta(days=1)
    streak = 0
    while active_days.get(cursor.isoformat()):
        streak += 1
        cursor -= timedelta(days=1)
    month_key = today.strftime("%Y-%m")
    return {
        "days": days_payload,
        "entries": entry_payload,
        "stats": {
            "monthSec": sum(item["durationSec"] for day, item in days_payload.items() if day.startswith(month_key)),
            "yearSec": sum(item["durationSec"] for item in days_payload.values()),
            "totalSec": sum(all_totals.values()),
            "streak": streak,
            "longestStreak": _study_longest_streak(active_days),
            "activeCanvasCount": len(active_ids),
            "createdCount": created_count,
        },
        "graph": {"kind": "canvas", "months": graph_months},
    }


def _canvas_activity_overview_graph(data: dict) -> dict:
    years = sorted({day[:4] for day in data.get("days", {}) if day[:4].isdigit()}, reverse=True)
    result = []
    for raw_year in years:
        payload = _canvas_activity_payload(data, int(raw_year))
        result.append({
            "year": raw_year,
            "total": payload["stats"]["activeCanvasCount"],
            "durationSec": payload["stats"]["yearSec"],
            "months": payload["graph"]["months"],
        })
    return {"kind": "canvas", "years": result}


def study_activity_records() -> tuple[dict[str, int], list[dict]]:
    """按归档日期汇总学习任务、速记、画布节点和任务簿完成记录。

    任务簿每个 ``taskbook.json`` marker 只形成一条足迹；它携带叶子数和实际
    用时供界面说明，但不会再次并入专注时长统计。
    """
    counts: dict[str, int] = {}
    records: list[dict] = []
    known_recent = recent_paths()

    def linked_canvas_available(linked_path: Path | None) -> bool:
        if linked_path is None or not linked_path.is_file():
            return False
        if is_in_canvases(linked_path):
            return True
        for allowed in ALLOWED_EXTRA_DIRS:
            try:
                linked_path.resolve().relative_to(allowed)
                return True
            except ValueError:
                continue
        return _norm(linked_path) in known_recent

    def tally(task: dict) -> None:
        completed_at = task.get("completedAt")
        day = str(completed_at or "")[:10]
        # completedAt 是 ISO 时间戳（如 2026-05-31T14:12:00），取前 10 位即日期
        if len(day) == 10 and day[4] == "-" and day[7] == "-":
            counts[day] = counts.get(day, 0) + 1
            linked = str(task.get("linkedCanvas") or "").strip()
            linked_path = Path(linked) if linked else None
            try:
                leaf_count = max(0, int(task.get("leafCount") or 0))
            except (TypeError, ValueError):
                leaf_count = 0
            try:
                duration_ms = max(0, int(task.get("durationMs") or 0))
            except (TypeError, ValueError):
                duration_ms = 0
            records.append({
                "title": str(task.get("title") or "未命名任务"),
                "completedAt": str(completed_at or ""),
                "day": day,
                "linkedCanvas": linked,
                "canvasAvailable": linked_canvas_available(linked_path),
                "kind": str(task.get("kind") or ""),
                "leafCount": leaf_count,
                "durationMs": duration_ms,
                "snapshotRootNodeId": str(task.get("snapshotRootNodeId") or ""),
            })

    study_archive_folders = (
        list(STUDY_ARCHIVE_DIR.iterdir()) if STUDY_ARCHIVE_DIR.exists() else []
    )
    if study_archive_folders:
        for folder in study_archive_folders:
            if not folder.is_dir():
                continue
            archive_file = folder / "tasks.json"
            if archive_file.is_file():
                try:
                    payload = json.loads(archive_file.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    payload = None
                if isinstance(payload, dict):
                    for task in payload.get("tasks", []):
                        if isinstance(task, dict):
                            tally({**task, "kind": "study"})
            taskbook_file = folder / "taskbook.json"
            if not taskbook_file.is_file():
                continue
            try:
                taskbook_payload = json.loads(taskbook_file.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(taskbook_payload, dict):
                tally({
                    "title": taskbook_payload.get("title"),
                    "completedAt": taskbook_payload.get("archivedAt"),
                    "linkedCanvas": taskbook_payload.get("canvasPath"),
                    "kind": "taskbook",
                    "leafCount": taskbook_payload.get("leafCount"),
                    "durationMs": taskbook_payload.get("durationMs"),
                    "snapshotRootNodeId": taskbook_payload.get("snapshotRootNodeId"),
                })

    # 画布归档（编辑器顶栏「归档」）也并入同一片足迹：每张归档画布＝做成的一件事，
    # 按 archivedAt 落点、按画布名命名，与任务完成一视同仁、不做区分（用户已拍板）。
    # 画布已进回收站、原路径失效，故 linkedCanvas 留空＝不显示「打开画布」入口。
    if CANVAS_ARCHIVE_DIR.exists():
        for folder in CANVAS_ARCHIVE_DIR.iterdir():
            archive_file = folder / "canvas.json"
            if not (folder.is_dir() and archive_file.is_file()):
                continue
            try:
                payload = json.loads(archive_file.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            archived_at = payload.get("archivedAt") or ""
            node_list = payload.get("nodes")
            if isinstance(node_list, list) and node_list:
                # 每个正文节点＝做成的一件事，用节点标题命名；无标题的按无名聚合。
                for node in node_list:
                    if isinstance(node, dict):
                        title = str(node.get("title") or "").strip()
                    else:
                        title = str(node or "").strip()
                    tally({"title": title, "completedAt": archived_at, "linkedCanvas": ""})
            else:
                # 兼容没有节点明细的旧归档：按 count 补无名条目，保证总数不丢。
                count = payload.get("count")
                for _ in range(count if isinstance(count, int) and count > 0 else 0):
                    tally({"title": "", "completedAt": archived_at, "linkedCanvas": ""})

    # 速记便签墙归档（长按速记图标）：也并入同一片足迹。只有「有名字」的便签才被写进归档夹，
    # 故每条都按 archivedAt 落点、以便签文字命名，与任务/画布完成一视同仁。便签不关联画布。
    if study_archive_folders:
        for folder in study_archive_folders:
            archive_file = folder / "notes.json"
            if not (folder.is_dir() and archive_file.is_file()):
                continue
            try:
                payload = json.loads(archive_file.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            archived_at = payload.get("archivedAt") or ""
            for note in payload.get("notes", []):
                if isinstance(note, dict):
                    title = str(note.get("text") or "").strip()
                else:
                    title = str(note or "").strip()
                tally({"title": title, "completedAt": archived_at, "linkedCanvas": ""})

    records.sort(key=lambda item: item["completedAt"], reverse=True)
    return counts, records


_DIARY_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _calendar_day(value: object, fallback: str | None = None) -> str:
    raw = str(value or fallback or "").strip()
    if not _DIARY_DAY_RE.fullmatch(raw):
        raise ValueError("日期格式不正确")
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError as err:
        raise ValueError("日期格式不正确") from err


def _diary_path(day: str) -> Path:
    return DIARY_DIR / f"{_calendar_day(day)}.md"


def _diary_decode_value(raw: str, fallback):
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return fallback
    return value


def load_diary(day: str) -> dict | None:
    path = _diary_path(day)
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None
    meta: dict = {}
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            for line in text[4:end].splitlines():
                key, separator, raw = line.partition(":")
                if separator:
                    meta[key.strip()] = _diary_decode_value(raw.strip(), raw.strip())
            body = text[end + 5:]
    tags = meta.get("tags")
    if not isinstance(tags, list):
        tags = []
    return {
        "date": day,
        "title": str(meta.get("title") or "")[:160],
        "tags": [str(tag).strip()[:40] for tag in tags if str(tag).strip()][:20],
        "body": body,
        "updatedAt": str(meta.get("updatedAt") or ""),
    }


def save_diary(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("请求格式不正确")
    day = _calendar_day(raw.get("date"))
    title = str(raw.get("title") or "").strip()[:160]
    body = str(raw.get("body") or "")[:200000]
    raw_tags = raw.get("tags")
    if isinstance(raw_tags, str):
        raw_tags = re.split(r"[,，]", raw_tags)
    tags = [str(tag).strip()[:40] for tag in (raw_tags if isinstance(raw_tags, list) else [])
            if str(tag).strip()][:20]
    updated_at = datetime.now().replace(microsecond=0).isoformat()
    frontmatter = (
        "---\n"
        f"title: {json.dumps(title, ensure_ascii=False)}\n"
        f"date: {json.dumps(day)}\n"
        f"tags: {json.dumps(tags, ensure_ascii=False)}\n"
        f"updatedAt: {json.dumps(updated_at)}\n"
        "---\n\n"
    )
    _atomic_write_text(_diary_path(day), frontmatter + body)
    return {"date": day, "title": title, "tags": tags, "body": body, "updatedAt": updated_at}


def delete_diary(day: object) -> None:
    path = _diary_path(_calendar_day(day))
    if path.is_file():
        path.unlink()


def diary_index() -> list[dict]:
    entries: list[dict] = []
    if not DIARY_DIR.exists():
        return entries
    for path in DIARY_DIR.glob("*.md"):
        if not _DIARY_DAY_RE.fullmatch(path.stem):
            continue
        item = load_diary(path.stem)
        if not item:
            continue
        plain = re.sub(r"[#>*_`\[\]()~-]+", " ", item["body"])
        entries.append({
            "date": item["date"],
            "title": item["title"],
            "tags": item["tags"],
            "updatedAt": item["updatedAt"],
            "excerpt": re.sub(r"\s+", " ", plain).strip()[:100],
        })
    entries.sort(key=lambda item: item["date"], reverse=True)
    return entries


def calendar_payload(year_value: object, month_value: object, selected_value: object) -> dict:
    today = date.today()
    try:
        year = int(year_value or today.year)
        month = int(month_value or today.month)
        date(year, month, 1)
    except (TypeError, ValueError) as err:
        raise ValueError("月份格式不正确") from err
    selected = _calendar_day(selected_value, today.isoformat())
    month_prefix = f"{year:04d}-{month:02d}-"
    focus = load_focus()
    _, archive_records = study_activity_records()
    archive_records = [record for record in archive_records if record.get("kind") != "study"]
    diaries = diary_index()
    days: dict[str, dict] = {}

    def bucket(day: str) -> dict:
        return days.setdefault(day, {
            "diary": 0, "due": 0, "focusTask": 0, "completed": 0,
            "focusSessions": 0, "focusSeconds": 0, "archives": 0,
        })

    for item in diaries:
        if item["date"].startswith(month_prefix):
            bucket(item["date"])["diary"] += 1
    for day, summary in focus.get("days", {}).items():
        if day.startswith(month_prefix):
            target = bucket(day)
            target["focusSessions"] = int(summary.get("count") or 0)
            target["focusSeconds"] = int(summary.get("sec") or 0)
    for record in archive_records:
        if record["day"].startswith(month_prefix):
            bucket(record["day"])["archives"] += 1

    selected_sessions = [
        session for session in focus.get("sessions", [])
        if _focus_day_key(session) == selected
    ]
    selected_archives = [
        {"title": record.get("title") or "未命名", "at": record.get("completedAt") or ""}
        for record in archive_records if record["day"] == selected
    ]
    focus_summary = focus.get("days", {}).get(selected, {"sec": 0, "count": 0})
    return {
        "year": year,
        "month": month,
        "today": today.isoformat(),
        "days": days,
        "diaries": diaries,
        "countdown": load_countdown(),
        "day": {
            "date": selected,
            "diary": load_diary(selected),
            "tasks": [],
            "overdue": [],
            "focus": {
                "count": int(focus_summary.get("count") or 0),
                "durationSec": int(focus_summary.get("sec") or 0),
                "sessions": selected_sessions,
            },
            "archives": selected_archives,
        },
    }


def _study_month_graph(records: list[dict]) -> dict:
    """把一组归档记录按完成月折成足迹星图需要的轻量结构。"""
    unnamed_titles = {"", "未命名", "未命名任务"}
    months_map: dict[str, dict] = {}
    for record in records:
        month = record["day"][:7]
        if len(month) != 7:
            continue
        bucket = months_map.setdefault(
            month, {"month": month, "total": 0, "named": [], "unnamed": 0}
        )
        bucket["total"] += 1
        title = str(record.get("title") or "").strip()
        if title in unnamed_titles:
            bucket["unnamed"] += 1
        else:
            bucket["named"].append({"title": title, "day": record["day"]})
    return {"months": [months_map[key] for key in sorted(months_map)]}


def _study_longest_streak(days: dict[str, int]) -> int:
    """返回给定逐日记录里的最长连续活跃天数。"""
    longest = 0
    streak = 0
    previous: date | None = None
    for key in sorted(day for day, count in days.items() if count):
        try:
            current = date.fromisoformat(key)
        except ValueError:
            continue
        streak = streak + 1 if previous and current == previous + timedelta(days=1) else 1
        longest = max(longest, streak)
        previous = current
    return longest


def study_activity_payload(selected_year: str | int | None = None) -> dict:
    days, records = study_activity_records()
    focus_days_all = load_focus()["days"]
    canvas_activity = canvas_activity_snapshot()
    today = date.today()
    archive_years = {
        int(day[:4]) for day in days
        if len(day) >= 4 and day[:4].isdigit()
    }
    focus_years = {
        int(day[:4]) for day in focus_days_all
        if len(day) >= 4 and day[:4].isdigit()
    }
    canvas_years = {
        int(day[:4]) for day in canvas_activity.get("days", {})
        if len(day) >= 4 and day[:4].isdigit()
    }
    years = sorted(archive_years | focus_years | canvas_years | {today.year}, reverse=True)
    try:
        year = int(selected_year) if selected_year is not None else today.year
    except (TypeError, ValueError):
        year = today.year
    if year not in years:
        year = today.year
    year_prefix = f"{year:04d}-"
    year_days = {day: count for day, count in days.items() if day.startswith(year_prefix)}
    year_records = [record for record in records if record["day"].startswith(year_prefix)]
    month_key = today.strftime("%Y-%m")
    month_total = sum(count for day, count in days.items() if day.startswith(month_key))

    # 连续推进：今天有记录则从今天算；否则容许从昨天回望，避免早晨打开时立刻归零。
    cursor = today
    if not days.get(cursor.isoformat()):
        cursor -= timedelta(days=1)
    streak = 0
    while days.get(cursor.isoformat()):
        streak += 1
        cursor -= timedelta(days=1)

    reflection = None
    if year_days:
        reflection_month = max(day[:7] for day in year_days)
        reflection_days = {
            day: count for day, count in year_days.items() if day.startswith(reflection_month)
        }
        weekday_counts = [0] * 7
        for day, count in reflection_days.items():
            try:
                weekday_counts[date.fromisoformat(day).weekday()] += count
            except ValueError:
                continue
        reflection = {
            "month": reflection_month,
            "count": sum(reflection_days.values()),
            "weekday": max(range(7), key=lambda index: weekday_counts[index]),
        }

    # 正常模式只画当前翻到的年份；总览模式在根节点与月份之间再加一层年份。
    graph = _study_month_graph(year_records)
    overview_years: list[dict] = []
    for record in records:
        record_year = record["day"][:4]
        if not record_year.isdigit():
            continue
        if not overview_years or overview_years[-1]["year"] != record_year:
            overview_years.append({"year": record_year, "records": []})
        overview_years[-1]["records"].append(record)
    overview_graph = {"years": []}
    for item in reversed(overview_years):
        month_graph = _study_month_graph(item.pop("records"))
        overview_graph["years"].append({
            "year": item["year"],
            "total": sum(month["total"] for month in month_graph["months"]),
            "months": month_graph["months"],
        })

    # 专注时间层（与归档解耦，直接读 focus.json 的每日汇总）：当年逐日 + 今日/本月/今年/累计。
    focus_year = {day: val for day, val in focus_days_all.items() if day.startswith(year_prefix)}
    canvas_year = _canvas_activity_payload(canvas_activity, year)

    return {
        "year": year,
        "years": years,
        "days": year_days,
        "total": sum(days.values()),
        "archiveFolders": _archive_folder_count(),
        "pageTotal": sum(year_days.values()),
        "stats": {
            "monthTotal": month_total,
            "streak": streak,
            "longestStreak": _study_longest_streak(year_days),
        },
        "reflection": reflection,
        "recent": year_records[:8],
        "entries": year_records,
        "graph": graph,
        "overviewGraph": overview_graph,
        "canvasDays": canvas_year["days"],
        "canvasEntries": canvas_year["entries"],
        "canvasStats": canvas_year["stats"],
        "canvasGraph": canvas_year["graph"],
        "canvasOverviewGraph": _canvas_activity_overview_graph(canvas_activity),
        "focusDays": focus_year,
        "focusStats": {
            "today": focus_days_all.get(today.isoformat(), {}).get("sec", 0),
            "month": sum(v.get("sec", 0) for d, v in focus_days_all.items() if d.startswith(month_key)),
            "year": sum(v.get("sec", 0) for v in focus_year.values()),
            "total": sum(v.get("sec", 0) for v in focus_days_all.values()),
        },
    }


def study_find_task(data: dict, task_id: str) -> tuple[int, dict]:
    for index, task in enumerate(data.get("tasks", [])):
        if task.get("id") == task_id:
            return index, task
    raise KeyError("没有找到这个任务")


def _study_goal_task_progress_value(task: dict | None) -> float:
    if not isinstance(task, dict):
        return 0.0
    if task.get("status") == "done":
        return 1.0
    progress = task.get("progress") if isinstance(task.get("progress"), dict) else {}
    target = _study_int(progress.get("target"))
    current = _study_int(progress.get("current"))
    return min(1.0, current / target) if target else 0.0


def _study_goal_availability(data: dict, tree: dict) -> dict[str, dict]:
    """计算一棵目标树的运行时解锁状态；不修改树或任务数据。"""
    nodes = tree.get("nodes", [])
    links = tree.get("links", [])
    by_id = {str(node.get("id") or ""): node for node in nodes}
    by_task = {str(task.get("id") or ""): task for task in data.get("tasks", [])}
    primary_by_target = {
        str(link.get("to") or ""): link for link in links if link.get("primary")
    }
    contains_children: dict[str, list[str]] = {}
    requirements: dict[str, list[dict]] = {}
    for link in links:
        target_id = str(link.get("to") or "")
        source_id = str(link.get("from") or "")
        if link.get("primary") and link.get("type") == "contains" and source_id:
            contains_children.setdefault(source_id, []).append(target_id)
        if link.get("type") == "requires":
            requirements.setdefault(target_id, []).append(link)

    metrics: dict[str, dict] = {}

    def branch_metrics(node_id: str, active: set[str]) -> dict:
        if node_id in active:
            return {"count": 0, "progress": 0.0, "complete": False}
        active.add(node_id)
        values: list[dict] = []
        for child_id in contains_children.get(node_id, []):
            child = by_id.get(child_id)
            if not child:
                continue
            if child.get("kind") == "task":
                task = by_task.get(str(child.get("taskId") or ""))
                value = {
                    "count": 1,
                    "progress": _study_goal_task_progress_value(task),
                    "complete": bool(task and task.get("status") == "done"),
                }
                metrics[child_id] = value
                values.append(value)
            else:
                values.append(branch_metrics(child_id, active))
        active.remove(node_id)
        count = sum(int(value["count"]) for value in values)
        aggregate = {
            "count": count,
            "progress": (
                sum(float(value["progress"]) * int(value["count"]) for value in values) / count
                if count else 0.0
            ),
            "complete": bool(count and all(value["complete"] for value in values)),
        }
        metrics[node_id] = aggregate
        return aggregate

    for node in nodes:
        node_id = str(node.get("id") or "")
        if node.get("kind") == "branch" and node_id not in metrics:
            branch_metrics(node_id, set())
        elif node.get("kind") == "task" and node_id not in metrics:
            task = by_task.get(str(node.get("taskId") or ""))
            metrics[node_id] = {
                "count": 1,
                "progress": _study_goal_task_progress_value(task),
                "complete": bool(task and task.get("status") == "done"),
            }

    def source_satisfied(link: dict) -> bool:
        source = by_id.get(str(link.get("from") or ""))
        if not source:
            return False
        if source.get("kind") == "branch":
            return bool(metrics.get(str(source.get("id") or ""), {}).get("complete"))
        task = by_task.get(str(source.get("taskId") or ""))
        if not task:
            return False
        if task.get("status") == "done":
            return True
        trigger = link.get("trigger") if isinstance(link.get("trigger"), dict) else {}
        if trigger.get("kind") != "milestone":
            return False
        milestone_id = str(trigger.get("milestoneId") or "")
        current = _study_int((task.get("progress") or {}).get("current"))
        return any(
            str(item.get("id") or "") == milestone_id
            and current >= _study_int(item.get("at"))
            for item in (task.get("progress") or {}).get("milestones", [])
            if isinstance(item, dict)
        )

    availability: dict[str, dict] = {}

    def available_for(node_id: str, active: set[str]) -> dict:
        if node_id in availability:
            return availability[node_id]
        if node_id in active:
            return {"available": False, "linkIds": []}
        active.add(node_id)
        blockers = [
            str(link.get("id") or "")
            for link in requirements.get(node_id, [])
            if not source_satisfied(link)
        ]
        incoming = primary_by_target.get(node_id)
        if incoming and incoming.get("type") == "contains" and incoming.get("from"):
            parent = available_for(str(incoming["from"]), active)
            if not parent["available"]:
                blockers.extend(parent["linkIds"])
        active.remove(node_id)
        state = {"available": not blockers, "linkIds": list(dict.fromkeys(blockers))}
        availability[node_id] = state
        return state

    for node_id in by_id:
        available_for(node_id, set())
    return availability


def _study_goal_assert_task_available(data: dict, tree_id: object, task_id: str) -> None:
    if not tree_id:
        return
    tree = _study_goal_tree(data, tree_id)
    node = next((
        item for item in tree.get("nodes", [])
        if item.get("kind") == "task" and item.get("taskId") == task_id
    ), None)
    if not node:
        raise KeyError("这个任务不在指定目标树中")
    state = _study_goal_availability(data, tree).get(str(node.get("id") or ""), {})
    if not state.get("available"):
        raise RuntimeError("任务尚未满足目标树的解锁条件")


def _study_goal_top_side(tree: dict, node_id: str) -> str:
    primary = {
        str(link.get("to") or ""): link
        for link in tree.get("links", []) if link.get("primary")
    }
    cursor = node_id
    seen: set[str] = set()
    while cursor and cursor not in seen:
        seen.add(cursor)
        link = primary.get(cursor)
        if not link or not link.get("from"):
            return _study_goal_side(link.get("side") if link else None)
        cursor = str(link.get("from") or "")
    return "right"

# V4 command surface. Node placement is always expressed as `primaryLink`;
# secondary prerequisite edges are managed independently.
def apply_study_goal_tree_command(data: dict, body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("请求格式不正确")
    command = str(body.get("command") or "").strip()
    result: dict = {"command": command}
    trees = data.get("goalTrees")
    if not isinstance(trees, list):
        raise ValueError("目标树格式不正确")

    if command == "create-tree":
        if len(trees) >= STUDY_GOAL_TREES_MAX:
            raise ValueError("目标树数量已达到安全上限")
        title = _study_goal_title(body.get("title"), "")
        tree = _study_goal_new_tree(title or _study_goal_next_title(trees), len(trees))
        trees.append(tree)
        data["activeTreeId"] = tree["id"]
        return {**result, "treeId": tree["id"], "nodeId": tree["id"]}

    if command == "switch-tree":
        tree = _study_goal_tree(data, body.get("treeId"))
        data["activeTreeId"] = tree["id"]
        return {**result, "treeId": tree["id"]}

    if command == "delete-tree":
        tree = _study_goal_tree(data, body.get("treeId"))
        index = next(i for i, candidate in enumerate(trees) if candidate["id"] == tree["id"])
        if index == 0:
            raise ValueError("第一棵目标树不能删除")
        removed = trees.pop(index)
        active = trees[min(index, len(trees) - 1)]
        for order, candidate in enumerate(trees):
            candidate["order"] = order
        data["activeTreeId"] = active["id"]
        return {**result, "treeId": active["id"], "removedTreeId": removed["id"]}

    tree = _study_goal_tree(data, body.get("treeId"))

    if command == "rename-root":
        tree["title"] = _study_goal_title(body.get("title"), "我的学习路线")

    elif command == "create-branch":
        node = {
            "id": "goal_node_" + uuid.uuid4().hex,
            "kind": "branch",
            "title": _study_goal_title(body.get("title"), "未命名阶段"),
        }
        color = str(body.get("color") or "").strip()
        if color:
            node["color"] = color
        tree["nodes"].append(node)
        link = _study_goal_link_from_input(tree, node["id"], body.get("primaryLink"))
        tree["links"].append(link)
        _study_goal_reorder_primary(tree, link, (body.get("primaryLink") or {}).get("beforeId") if isinstance(body.get("primaryLink"), dict) else None)
        result.update({"nodeId": node["id"], "linkId": link["id"]})

    elif command in {"create-task", "attach-task"}:
        if command == "create-task":
            source = {"title": body.get("title"), "taskPage": body.get("taskPage")}
            if body.get("target") not in (None, ""):
                source["progress"] = {"target": body.get("target"), "milestones": []}
            task = _study_task(source)
            data.setdefault("tasks", []).append(task)
            task_id = task["id"]
            result["task"] = task
        else:
            task_id = str(body.get("taskId") or "").strip()
            _index, task = study_find_task(data, task_id)
        if any(node.get("kind") == "task" and node.get("taskId") == task_id for node in tree["nodes"]):
            raise ValueError("这个任务已经在这棵目标树中")
        node = {"id": "goal_node_" + uuid.uuid4().hex, "kind": "task", "taskId": task_id}
        tree["nodes"].append(node)
        link = _study_goal_link_from_input(tree, node["id"], body.get("primaryLink"))
        tree["links"].append(link)
        _study_goal_reorder_primary(tree, link, (body.get("primaryLink") or {}).get("beforeId") if isinstance(body.get("primaryLink"), dict) else None)
        result.update({"nodeId": node["id"], "taskId": task_id, "linkId": link["id"]})

    elif command == "update-branch":
        node = _study_goal_node(tree, body.get("nodeId"))
        if node.get("kind") != "branch":
            raise ValueError("只能编辑阶段")
        if "title" in body:
            node["title"] = _study_goal_title(body.get("title"), "未命名阶段")
        if "color" in body:
            color = str(body.get("color") or "").strip()
            if color:
                node["color"] = color
            else:
                node.pop("color", None)

    elif command == "delete-branch":
        node = _study_goal_node(tree, body.get("nodeId"))
        if node.get("kind") != "branch":
            raise ValueError("只能删除阶段")
        primary_children: dict[str, list[str]] = {}
        for link in tree["links"]:
            if link.get("primary") and link.get("from"):
                primary_children.setdefault(str(link["from"]), []).append(link["to"])
        removed: set[str] = set()
        stack = [node["id"]]
        while stack:
            current = stack.pop()
            if current in removed:
                continue
            removed.add(current)
            stack.extend(primary_children.get(current, []))
        tree["nodes"] = [candidate for candidate in tree["nodes"] if candidate["id"] not in removed]
        tree["links"] = [
            link for link in tree["links"]
            if link.get("from") not in removed and link.get("to") not in removed
        ]
        result["removedNodeIds"] = sorted(removed)

    elif command == "detach-task":
        task_id = str(body.get("taskId") or "").strip()
        removed = _study_goal_detach_task(data, task_id, tree_id=tree["id"])
        if not removed:
            raise KeyError("这个任务不在当前目标树中")
        result.update(removed)

    elif command == "move-node":
        node = _study_goal_node(tree, body.get("nodeId"))
        old = _study_goal_primary_link(tree, node["id"])
        tree["links"] = [link for link in tree["links"] if link["id"] != old["id"]]
        moving = _study_goal_link_from_input(
            tree, node["id"], body.get("primaryLink"), link_id=old["id"],
        )
        tree["links"].append(moving)
        before_id = (body.get("primaryLink") or {}).get("beforeId") if isinstance(body.get("primaryLink"), dict) else None
        _study_goal_reorder_primary(tree, moving, before_id)
        result["linkId"] = moving["id"]

    elif command == "add-requirement":
        source_id = str(body.get("fromNodeId") or "").strip()
        target_id = str(body.get("toNodeId") or "").strip()
        source = _study_goal_node(tree, source_id)
        _study_goal_node(tree, target_id)
        tasks_by_id = {str(task.get("id") or ""): task for task in data.get("tasks", [])}
        trigger = _study_goal_clean_trigger(body.get("trigger"), source, tasks_by_id, strict=True)
        trigger_signature = (trigger.get("kind"), trigger.get("milestoneId"))
        if any(
            item.get("type") == "requires"
            and item.get("from") == source_id
            and item.get("to") == target_id
            and (
                (item.get("trigger") or {}).get("kind", "complete"),
                (item.get("trigger") or {}).get("milestoneId"),
            ) == trigger_signature
            for item in tree["links"]
        ):
            raise ValueError("这个解锁条件已经存在")
        link = {
            "id": "goal_link_" + uuid.uuid4().hex,
            "from": source_id,
            "to": target_id,
            "type": "requires",
            "primary": False,
            "trigger": trigger,
        }
        tree["links"].append(link)
        result["linkId"] = link["id"]

    elif command == "remove-requirement":
        link_id = str(body.get("linkId") or "").strip()
        link = next((item for item in tree["links"] if item.get("id") == link_id), None)
        if not link:
            raise KeyError("没有找到这个解锁条件")
        if link.get("primary") or link.get("type") != "requires":
            raise ValueError("主路线依赖只能通过移动节点调整")
        tree["links"] = [item for item in tree["links"] if item["id"] != link_id]
        result["removedLinkId"] = link_id

    elif command == "clear-primary-requirement":
        node = _study_goal_node(tree, body.get("nodeId"))
        old = _study_goal_primary_link(tree, node["id"])
        if old.get("type") != "requires":
            raise ValueError("这个节点没有主路线解锁条件")
        side = _study_goal_top_side(tree, node["id"])
        tree["links"] = [item for item in tree["links"] if item["id"] != old["id"]]
        replacement = {
            "id": old["id"],
            "from": None,
            "to": node["id"],
            "type": "contains",
            "primary": True,
            "order": 999999,
            "side": side,
        }
        tree["links"].append(replacement)
        _study_goal_reorder_primary(tree, replacement, None)
        result.update({"linkId": replacement["id"], "nodeId": node["id"], "side": side})

    else:
        raise ValueError("不支持的目标树操作")

    tree["updatedAt"] = _study_now()
    data["goalTrees"] = _study_goal_normalize_trees(data["goalTrees"], data.get("tasks", []), strict=True)
    _study_goal_sync_active(data)
    return result


def _study_archive_folder(task_count: int) -> Path:
    """返回易读且不覆盖旧归档的目录：日期+任务数量，重名时追加序号。"""
    base_name = f"{date.today().isoformat()}+{task_count}个任务"
    target = STUDY_ARCHIVE_DIR / base_name
    if not target.exists():
        return target
    index = 2
    while True:
        candidate = STUDY_ARCHIVE_DIR / f"{base_name}-{index}"
        if not candidate.exists():
            return candidate
        index += 1


def _taskbook_archive_folder() -> Path:
    """返回一个易读且不覆盖旧记录的任务簿归档目录。"""
    base_name = f"{date.today().isoformat()}+1项任务簿"
    target = STUDY_ARCHIVE_DIR / base_name
    if not target.exists():
        return target
    index = 2
    while True:
        candidate = STUDY_ARCHIVE_DIR / f"{base_name}-{index}"
        if not candidate.exists():
            return candidate
        index += 1


def _find_taskbook_archive(archive_id: str) -> tuple[Path, dict] | None:
    if not STUDY_ARCHIVE_DIR.exists():
        return None
    for folder in STUDY_ARCHIVE_DIR.iterdir():
        marker = folder / "taskbook.json"
        if not (folder.is_dir() and marker.is_file()):
            continue
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload.get("archiveId") == archive_id:
            return folder, payload
    return None


def archive_taskbook_canvas(
    src: Path,
    *,
    root_id: str,
    archive_id: str,
    retain_snapshot: bool,
    snapshot_root_node_id: str,
    transformed_canvas: dict,
) -> dict:
    """幂等归档一个已完成顶级任务。

    调用者须持有“画布锁 → 数据锁”。先落轻量 marker，再原子替换画布；
    画布写入失败时会删除本次 marker，使客户端可以安全重试。
    """
    existing = _find_taskbook_archive(archive_id)
    if existing is not None:
        folder, marker = existing
        try:
            current = json.loads(src.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
            raise OSError(f"读取画布失败：{err}") from err
        taskbook = current.get("taskbook") if isinstance(current, dict) else None
        roots = taskbook.get("roots") if isinstance(taskbook, dict) else []
        if any(
            isinstance(root, dict) and str(root.get("id") or "").strip() == root_id
            for root in (roots if isinstance(roots, list) else [])
        ):
            raise ValueError("归档记录与当前画布状态不一致，请重新打开画布后再试")
        return {**marker, "folder": folder.name, "idempotent": True}

    try:
        source_canvas = json.loads(src.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise OSError(f"读取画布失败：{err}") from err
    if not isinstance(source_canvas, dict):
        raise ValueError("画布数据无效")
    summary = _taskbook_archive_source_summary(source_canvas, root_id)
    _validate_taskbook_archive_snapshot(
        transformed_canvas,
        root_id,
        summary["removedNodeIds"],
        retain_snapshot,
        snapshot_root_node_id,
    )

    archived_at = _study_now()
    next_canvas = dict(transformed_canvas)
    next_canvas["updatedAt"] = archived_at
    next_canvas["savedAt"] = archived_at
    marker = {
        "version": 1,
        "archiveId": archive_id,
        "rootId": root_id,
        "title": summary["title"],
        "archivedAt": archived_at,
        "leafCount": summary["leafCount"],
        "durationMs": summary["durationMs"],
        "canvasPath": _norm(src),
        "snapshotRootNodeId": snapshot_root_node_id if retain_snapshot else "",
        "retainedSnapshot": bool(retain_snapshot),
    }
    folder = _taskbook_archive_folder()
    marker_path = folder / "taskbook.json"
    try:
        folder.mkdir(parents=True, exist_ok=False)
        _atomic_write_json(marker_path, marker)
        _atomic_write_json(src, next_canvas, streaming=True)
    except OSError:
        try:
            marker_path.unlink(missing_ok=True)
            folder.rmdir()
        except OSError:
            pass
        raise
    return {
        **marker,
        "folder": folder.name,
        "idempotent": False,
        "savedAt": archived_at,
        "removedNodeIds": sorted(summary["removedNodeIds"]),
    }


def _canvas_archive_folder(node_count: int) -> Path:
    """返回易读且不覆盖旧归档的目录：日期+节点数量，重名时追加序号。
    与 _study_archive_folder 同套路，只是落在「画布归档」、口径数节点。"""
    base_name = f"{date.today().isoformat()}+{node_count}个节点"
    target = CANVAS_ARCHIVE_DIR / base_name
    if not target.exists():
        return target
    index = 2
    while True:
        candidate = CANVAS_ARCHIVE_DIR / f"{base_name}-{index}"
        if not candidate.exists():
            return candidate
        index += 1


def _notes_archive_folder(note_count: int) -> Path:
    """速记便签墙「归档」目录：和学习/画布归档同套路，落在「学习归档」、口径数有名便签，
    重名时追加序号。文件夹里放 notes.json（marker），与任务归档的 tasks.json 区分。"""
    base_name = f"{date.today().isoformat()}+{note_count}条速记"
    target = STUDY_ARCHIVE_DIR / base_name
    if not target.exists():
        return target
    index = 2
    while True:
        candidate = STUDY_ARCHIVE_DIR / f"{base_name}-{index}"
        if not candidate.exists():
            return candidate
        index += 1


# 独立复习卡片使用 SQLite 保存。卡片内容、调度和复习事件都不再依附画布节点。
# 间隔重复（Leitner 盒子）：level=盒子序号；「记得」升一盒、间隔按下表拉长，「不会」清零今天再练，
# 「模糊」原地但至少隔天。熟练度标签由 level 推导（生→疑→熟），不落库重复保存。
REVIEW_LEVEL_DAYS = [0, 1, 3, 7, 16, 35]
REVIEW_MAX_LEVEL = len(REVIEW_LEVEL_DAYS) - 1
REVIEW_SCHEMA_VERSION = 3
REVIEW_CARD_STATUSES = {"active", "suspended", "archived"}
REVIEW_RATINGS = {"remembered", "vague", "forgot"}
REVIEW_SCOPE_MODES = {"all", "unfiled", "deck"}
REVIEW_SESSION_LIMITS = {10, 20, 50}
REVIEW_ORDER_MODES = {"due", "random", "weak"}
REVIEW_PROMPT_MAX = 12000
REVIEW_ANSWER_MAX = 50000
REVIEW_NOTES_MAX = 100000
REVIEW_DECK_NAME_MAX = 80
REVIEW_TAG_NAME_MAX = 32
REVIEW_TAGS_PER_CARD_MAX = 12
REVIEW_BATCH_MAX = 500


def _review_maturity_for_level(level: int) -> str:
    if level <= 0:
        return "生"
    if level <= 2:
        return "疑"
    return "熟"


def _review_connect() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(REVIEW_DB_FILE), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if version > REVIEW_SCHEMA_VERSION:
        conn.close()
        raise sqlite3.DatabaseError("复习数据库来自更高版本的 Relatum")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS review_decks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_cards (
            id TEXT PRIMARY KEY,
            card_type TEXT NOT NULL DEFAULT 'basic',
            prompt TEXT NOT NULL,
            answer TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'archived')),
            level INTEGER NOT NULL DEFAULT 0,
            due_on TEXT NOT NULL DEFAULT '',
            last_reviewed_at TEXT NOT NULL DEFAULT '',
            review_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deck_id TEXT,
            FOREIGN KEY(deck_id) REFERENCES review_decks(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS review_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id TEXT,
            prompt_snapshot TEXT NOT NULL DEFAULT '',
            rating TEXT NOT NULL,
            reviewed_at TEXT NOT NULL,
            previous_level INTEGER NOT NULL,
            next_level INTEGER NOT NULL,
            next_due_on TEXT NOT NULL,
            FOREIGN KEY(card_id) REFERENCES review_cards(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS review_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            scope_mode TEXT NOT NULL DEFAULT 'all'
                CHECK (scope_mode IN ('all', 'unfiled', 'deck')),
            scope_deck_id TEXT,
            session_limit INTEGER NOT NULL DEFAULT 20
                CHECK (session_limit IN (10, 20, 50)),
            order_mode TEXT NOT NULL DEFAULT 'due'
                CHECK (order_mode IN ('due', 'random', 'weak')),
            require_reveal INTEGER NOT NULL DEFAULT 0
                CHECK (require_reveal IN (0, 1)),
            updated_at TEXT NOT NULL,
            FOREIGN KEY(scope_deck_id) REFERENCES review_decks(id) ON DELETE SET NULL
        );
        """
    )
    card_columns = {
        str(row["name"]) for row in conn.execute("PRAGMA table_info(review_cards)").fetchall()
    }
    if "deck_id" not in card_columns:
        conn.execute(
            "ALTER TABLE review_cards ADD COLUMN deck_id TEXT "
            "REFERENCES review_decks(id) ON DELETE SET NULL"
        )
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS review_card_tags (
            card_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY(card_id, tag_id),
            FOREIGN KEY(card_id) REFERENCES review_cards(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES review_tags(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_review_cards_status_due
            ON review_cards(status, due_on, created_at);
        CREATE INDEX IF NOT EXISTS idx_review_cards_deck
            ON review_cards(deck_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_review_cards_deck_status_due
            ON review_cards(deck_id, status, due_on, created_at);
        CREATE INDEX IF NOT EXISTS idx_review_events_reviewed_at
            ON review_events(reviewed_at);
        CREATE INDEX IF NOT EXISTS idx_review_events_card_id
            ON review_events(card_id, reviewed_at);
        CREATE INDEX IF NOT EXISTS idx_review_card_tags_tag
            ON review_card_tags(tag_id, card_id);
        """
    )
    conn.execute(
        """INSERT OR IGNORE INTO review_settings
           (id, scope_mode, scope_deck_id, session_limit, order_mode, require_reveal, updated_at)
           VALUES (1, 'all', NULL, 20, 'due', 0, ?)""",
        (_study_now(),),
    )
    if version < REVIEW_SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {REVIEW_SCHEMA_VERSION}")
    conn.commit()
    return conn


def _review_text(value: object, *, label: str, limit: int, required: bool = False) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if required and not text:
        raise ValueError(f"{label}不能为空")
    if len(text) > limit:
        raise ValueError(f"{label}过长（最多 {limit} 个字符）")
    return text


def _review_tag_names(value: object) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[,，\n]", str(value or ""))
    names: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = re.sub(r"\s+", " ", str(item or "").strip().lstrip("#")).strip()
        if not name:
            continue
        if len(name) > REVIEW_TAG_NAME_MAX:
            raise ValueError(f"标签过长（最多 {REVIEW_TAG_NAME_MAX} 个字符）")
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
        if len(names) >= REVIEW_TAGS_PER_CARD_MAX:
            break
    return names


def _review_card_ids(value: object) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("缺少卡片 ids 数组")
    ids: list[str] = []
    seen: set[str] = set()
    for item in value:
        card_id = str(item or "").strip()
        if card_id and card_id not in seen:
            seen.add(card_id)
            ids.append(card_id)
        if len(ids) >= REVIEW_BATCH_MAX:
            break
    if not ids:
        raise ValueError("至少选择一张卡片")
    return ids


def _review_deck_id(conn: sqlite3.Connection, value: object) -> str | None:
    deck_id = str(value or "").strip()
    if not deck_id:
        return None
    if conn.execute("SELECT 1 FROM review_decks WHERE id = ?", (deck_id,)).fetchone() is None:
        raise ValueError("卡组不存在")
    return deck_id


def _review_resolve_deck_name(conn: sqlite3.Connection, value: object) -> str | None:
    """按名称复用卡组；不存在时在调用方事务中创建。空名称表示未分类。"""
    raw_name = str(value or "").strip()
    if not raw_name:
        return None
    name = _review_deck_name(raw_name)
    name_key = name.casefold()
    row = conn.execute(
        "SELECT id FROM review_decks WHERE name_key = ?",
        (name_key,),
    ).fetchone()
    if row is not None:
        return str(row["id"])

    deck_id = "rd_" + uuid.uuid4().hex
    order = int(conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM review_decks"
    ).fetchone()[0])
    now = _study_now()
    try:
        conn.execute(
            """INSERT INTO review_decks
               (id, name, name_key, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (deck_id, name, name_key, order, now, now),
        )
    except sqlite3.IntegrityError:
        # 本地服务通常只有一个写入者；这里仍兜住并发创建同名卡组的极短窗口。
        row = conn.execute(
            "SELECT id FROM review_decks WHERE name_key = ?",
            (name_key,),
        ).fetchone()
        if row is None:
            raise
        return str(row["id"])
    return deck_id


def _review_card_row(conn: sqlite3.Connection, card_id: str) -> sqlite3.Row | None:
    return conn.execute(
        """SELECT c.*, d.name AS deck_name
           FROM review_cards c
           LEFT JOIN review_decks d ON d.id = c.deck_id
           WHERE c.id = ?""",
        (card_id,),
    ).fetchone()


def _review_tags_by_card(conn: sqlite3.Connection, card_ids: list[str]) -> dict[str, list[str]]:
    if not card_ids:
        return {}
    result: dict[str, list[str]] = {card_id: [] for card_id in card_ids}
    # SQLite 的绑定变量上限因运行时构建而异。卡片库可能一次返回上千张卡，
    # 分块查询可以避免大 IN (...) 在较低上限的系统上直接失败。
    for offset in range(0, len(card_ids), 400):
        chunk = card_ids[offset:offset + 400]
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""SELECT ct.card_id, t.name
                FROM review_card_tags ct
                JOIN review_tags t ON t.id = ct.tag_id
                WHERE ct.card_id IN ({placeholders})
                ORDER BY t.name_key ASC""",
            chunk,
        ).fetchall()
        for row in rows:
            result.setdefault(str(row["card_id"]), []).append(str(row["name"]))
    return result


def _review_replace_tags(conn: sqlite3.Connection, card_id: str, names: list[str]) -> None:
    conn.execute("DELETE FROM review_card_tags WHERE card_id = ?", (card_id,))
    now = _study_now()
    for name in names:
        key = name.casefold()
        tag = conn.execute("SELECT id FROM review_tags WHERE name_key = ?", (key,)).fetchone()
        if tag is None:
            tag_id = "rt_" + uuid.uuid4().hex
            conn.execute(
                "INSERT INTO review_tags (id, name, name_key, created_at) VALUES (?, ?, ?, ?)",
                (tag_id, name, key, now),
            )
        else:
            tag_id = str(tag["id"])
        conn.execute(
            "INSERT OR IGNORE INTO review_card_tags (card_id, tag_id) VALUES (?, ?)",
            (card_id, tag_id),
        )
    conn.execute(
        "DELETE FROM review_tags WHERE NOT EXISTS "
        "(SELECT 1 FROM review_card_tags ct WHERE ct.tag_id = review_tags.id)"
    )


def _review_card_payload(row: sqlite3.Row, tags: list[str] | None = None) -> dict:
    level = max(0, min(int(row["level"] or 0), REVIEW_MAX_LEVEL))
    return {
        "id": str(row["id"]),
        "type": str(row["card_type"] or "basic"),
        "prompt": str(row["prompt"] or ""),
        "answer": str(row["answer"] or ""),
        "notes": str(row["notes"] or ""),
        "status": str(row["status"] or "active"),
        "level": level,
        "maturity": _review_maturity_for_level(level),
        "due": str(row["due_on"] or ""),
        "lastReviewedAt": str(row["last_reviewed_at"] or ""),
        "reviewCount": int(row["review_count"] or 0),
        "createdAt": str(row["created_at"] or ""),
        "updatedAt": str(row["updated_at"] or ""),
        "deckId": str(row["deck_id"] or ""),
        "deckName": str(row["deck_name"] or ""),
        "tags": list(tags or []),
    }


def _review_decks_and_tags_payload(conn: sqlite3.Connection) -> dict:
    deck_rows = conn.execute(
        """SELECT d.id, d.name, d.sort_order, d.created_at, d.updated_at,
                  COUNT(c.id) AS card_count
           FROM review_decks d
           LEFT JOIN review_cards c ON c.deck_id = d.id
           GROUP BY d.id
           ORDER BY d.sort_order ASC, d.created_at ASC"""
    ).fetchall()
    tag_rows = conn.execute(
        """SELECT t.name, COUNT(ct.card_id) AS card_count
           FROM review_tags t
           JOIN review_card_tags ct ON ct.tag_id = t.id
           GROUP BY t.id
           ORDER BY t.name_key ASC"""
    ).fetchall()
    uncategorized = int(conn.execute(
        "SELECT COUNT(*) FROM review_cards WHERE deck_id IS NULL OR deck_id = ''"
    ).fetchone()[0])
    return {
        "decks": [{
            "id": str(row["id"]),
            "name": str(row["name"]),
            "count": int(row["card_count"] or 0),
            "sortOrder": int(row["sort_order"] or 0),
            "createdAt": str(row["created_at"] or ""),
            "updatedAt": str(row["updated_at"] or ""),
        } for row in deck_rows],
        "tags": [{"name": str(row["name"]), "count": int(row["card_count"] or 0)}
                 for row in tag_rows],
        "uncategorizedCount": uncategorized,
    }


def _review_settings_payload(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT * FROM review_settings WHERE id = 1").fetchone()
    scope_mode = str(row["scope_mode"] or "all") if row else "all"
    scope_deck_id = str(row["scope_deck_id"] or "") if row else ""
    if scope_mode not in REVIEW_SCOPE_MODES:
        scope_mode = "all"
    if scope_mode == "deck":
        exists = scope_deck_id and conn.execute(
            "SELECT 1 FROM review_decks WHERE id = ?", (scope_deck_id,)
        ).fetchone()
        if not exists:
            scope_mode = "all"
            scope_deck_id = ""
    else:
        scope_deck_id = ""
    session_limit = int(row["session_limit"] or 20) if row else 20
    if session_limit not in REVIEW_SESSION_LIMITS:
        session_limit = 20
    order_mode = str(row["order_mode"] or "due") if row else "due"
    if order_mode not in REVIEW_ORDER_MODES:
        order_mode = "due"
    return {
        "scopeMode": scope_mode,
        "scopeDeckId": scope_deck_id,
        "sessionLimit": session_limit,
        "orderMode": order_mode,
        "requireReveal": bool(row["require_reveal"]) if row else False,
    }


def update_review_settings(raw: dict) -> dict:
    scope_mode = str(raw.get("scopeMode") or "all").strip()
    if scope_mode not in REVIEW_SCOPE_MODES:
        raise ValueError("复习范围无效")
    try:
        session_limit = int(raw.get("sessionLimit") or 20)
    except (TypeError, ValueError) as err:
        raise ValueError("每轮卡片数量无效") from err
    if session_limit not in REVIEW_SESSION_LIMITS:
        raise ValueError("每轮卡片数量无效")
    order_mode = str(raw.get("orderMode") or "due").strip()
    if order_mode not in REVIEW_ORDER_MODES:
        raise ValueError("出题顺序无效")
    require_reveal = bool(raw.get("requireReveal", False))
    conn = _review_connect()
    try:
        scope_deck_id = ""
        if scope_mode == "deck":
            scope_deck_id = _review_deck_id(conn, raw.get("scopeDeckId")) or ""
            if not scope_deck_id:
                raise ValueError("请选择卡组")
        with conn:
            conn.execute(
                """UPDATE review_settings
                   SET scope_mode = ?, scope_deck_id = ?, session_limit = ?,
                       order_mode = ?, require_reveal = ?, updated_at = ?
                   WHERE id = 1""",
                (scope_mode, scope_deck_id or None, session_limit, order_mode,
                 1 if require_reveal else 0, _study_now()),
            )
        return _review_settings_payload(conn)
    finally:
        conn.close()


def _review_scope_sql(settings: dict, *, alias: str = "c") -> tuple[str, list[object]]:
    if settings["scopeMode"] == "unfiled":
        return f" AND {alias}.deck_id IS NULL", []
    if settings["scopeMode"] == "deck":
        return f" AND {alias}.deck_id = ?", [settings["scopeDeckId"]]
    return "", []


def _review_scope_options(conn: sqlite3.Connection, today: str) -> list[dict]:
    rows = conn.execute(
        """SELECT d.id, d.name, d.sort_order,
                  SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS active_count,
                  SUM(CASE WHEN c.status = 'active' AND (c.due_on = '' OR c.due_on <= ?)
                           THEN 1 ELSE 0 END) AS due_count
           FROM review_decks d
           LEFT JOIN review_cards c ON c.deck_id = d.id
           GROUP BY d.id
           ORDER BY d.sort_order ASC, d.created_at ASC""",
        (today,),
    ).fetchall()
    total = conn.execute(
        """SELECT COUNT(*) AS active_count,
                  SUM(CASE WHEN due_on = '' OR due_on <= ? THEN 1 ELSE 0 END) AS due_count
           FROM review_cards WHERE status = 'active'""",
        (today,),
    ).fetchone()
    unfiled = conn.execute(
        """SELECT COUNT(*) AS active_count,
                  SUM(CASE WHEN due_on = '' OR due_on <= ? THEN 1 ELSE 0 END) AS due_count
           FROM review_cards WHERE status = 'active' AND deck_id IS NULL""",
        (today,),
    ).fetchone()
    options = [{
        "mode": "all", "deckId": "", "name": "全部卡组",
        "activeCount": int(total["active_count"] or 0),
        "dueCount": int(total["due_count"] or 0),
    }, {
        "mode": "unfiled", "deckId": "", "name": "未分类",
        "activeCount": int(unfiled["active_count"] or 0),
        "dueCount": int(unfiled["due_count"] or 0),
    }]
    options.extend({
        "mode": "deck", "deckId": str(row["id"]), "name": str(row["name"]),
        "activeCount": int(row["active_count"] or 0),
        "dueCount": int(row["due_count"] or 0),
    } for row in rows)
    return options


def review_pool_payload() -> dict:
    """Return active standalone cards without opening any .canvas file."""
    today = date.today().isoformat()
    conn = _review_connect()
    try:
        settings = _review_settings_payload(conn)
        scope_sql, scope_params = _review_scope_sql(settings)
        if settings["orderMode"] == "random":
            order_sql = "CASE WHEN c.due_on = '' OR c.due_on <= ? THEN 0 ELSE 1 END, RANDOM()"
        elif settings["orderMode"] == "weak":
            order_sql = ("CASE WHEN c.due_on = '' OR c.due_on <= ? THEN 0 ELSE 1 END, "
                         "c.level ASC, c.due_on ASC, c.created_at ASC")
        else:
            order_sql = ("CASE WHEN c.due_on = '' OR c.due_on <= ? THEN 0 ELSE 1 END, "
                         "c.due_on ASC, c.created_at ASC")
        rows = conn.execute(
            f"""
            SELECT c.*, d.name AS deck_name
            FROM review_cards c
            LEFT JOIN review_decks d ON d.id = c.deck_id
            WHERE c.status = 'active'{scope_sql}
            ORDER BY {order_sql}
            LIMIT ?
            """,
            [*scope_params, today, settings["sessionLimit"]],
        ).fetchall()
        active_count = int(conn.execute(
            f"SELECT COUNT(*) FROM review_cards c WHERE c.status = 'active'{scope_sql}",
            scope_params,
        ).fetchone()[0])
        due_count = int(conn.execute(
            f"""SELECT COUNT(*) FROM review_cards c
                 WHERE c.status = 'active' AND (c.due_on = '' OR c.due_on <= ?){scope_sql}""",
            [today, *scope_params],
        ).fetchone()[0])
        reviewed_today = int(conn.execute(
            "SELECT COUNT(*) FROM review_events WHERE substr(reviewed_at, 1, 10) = ?",
            (today,),
        ).fetchone()[0])
        tags_by_card = _review_tags_by_card(conn, [str(row["id"]) for row in rows])
        return {
            "version": 3,
            "generatedAt": _study_now(),
            "count": active_count,
            "dueCount": due_count,
            "reviewedToday": reviewed_today,
            "settings": settings,
            "scopes": _review_scope_options(conn, today),
            "cards": [_review_card_payload(row, tags_by_card.get(str(row["id"]), []))
                      for row in rows],
        }
    finally:
        conn.close()


def review_cards_payload() -> dict:
    conn = _review_connect()
    try:
        rows = conn.execute(
            """
            SELECT c.*, d.name AS deck_name
            FROM review_cards c
            LEFT JOIN review_decks d ON d.id = c.deck_id
            ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
                     c.updated_at DESC, c.created_at DESC
            """
        ).fetchall()
        tags_by_card = _review_tags_by_card(conn, [str(row["id"]) for row in rows])
        meta = _review_decks_and_tags_payload(conn)
        return {
            "version": 3,
            "count": len(rows),
            "cards": [_review_card_payload(row, tags_by_card.get(str(row["id"]), []))
                      for row in rows],
            **meta,
        }
    finally:
        conn.close()


def create_review_card(raw: dict) -> dict:
    prompt = _review_text(raw.get("prompt"), label="问题", limit=REVIEW_PROMPT_MAX, required=True)
    answer = _review_text(raw.get("answer"), label="答案", limit=REVIEW_ANSWER_MAX)
    notes = _review_text(raw.get("notes"), label="补充说明", limit=REVIEW_NOTES_MAX)
    status = str(raw.get("status") or "active").strip()
    if status not in REVIEW_CARD_STATUSES:
        raise ValueError("卡片状态无效")
    tags = _review_tag_names(raw.get("tags"))
    now = _study_now()
    card_id = "rc_" + uuid.uuid4().hex
    conn = _review_connect()
    try:
        with conn:
            deck_id = (_review_resolve_deck_name(conn, raw.get("deckName"))
                       if "deckName" in raw
                       else _review_deck_id(conn, raw.get("deckId")))
            conn.execute(
                """
                INSERT INTO review_cards
                    (id, card_type, prompt, answer, notes, status, due_on,
                     created_at, updated_at, deck_id)
                VALUES (?, 'basic', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (card_id, prompt, answer, notes, status, date.today().isoformat(), now, now, deck_id),
            )
            _review_replace_tags(conn, card_id, tags)
        row = _review_card_row(conn, card_id)
        return _review_card_payload(row, tags)
    finally:
        conn.close()


def update_review_card(raw: dict) -> dict:
    card_id = str(raw.get("id") or "").strip()
    if not card_id:
        raise ValueError("缺少卡片 id")
    prompt = _review_text(raw.get("prompt"), label="问题", limit=REVIEW_PROMPT_MAX, required=True)
    answer = _review_text(raw.get("answer"), label="答案", limit=REVIEW_ANSWER_MAX)
    notes = _review_text(raw.get("notes"), label="补充说明", limit=REVIEW_NOTES_MAX)
    status = str(raw.get("status") or "active").strip()
    if status not in REVIEW_CARD_STATUSES:
        raise ValueError("卡片状态无效")
    conn = _review_connect()
    try:
        existing = conn.execute("SELECT * FROM review_cards WHERE id = ?", (card_id,)).fetchone()
        if existing is None:
            raise LookupError("卡片不存在")
        if "tags" in raw:
            tags = _review_tag_names(raw.get("tags"))
        else:
            tags = _review_tags_by_card(conn, [card_id]).get(card_id, [])
        with conn:
            if "deckName" in raw:
                deck_id = _review_resolve_deck_name(conn, raw.get("deckName"))
            else:
                deck_id = _review_deck_id(
                    conn,
                    raw.get("deckId") if "deckId" in raw else existing["deck_id"],
                )
            changed = conn.execute(
                """
                UPDATE review_cards
                SET prompt = ?, answer = ?, notes = ?, status = ?, deck_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (prompt, answer, notes, status, deck_id, _study_now(), card_id),
            ).rowcount
            if not changed:
                # 与按名称新建卡组处于同一事务；卡片并发删除时不要留下空卡组。
                raise LookupError("卡片不存在")
            _review_replace_tags(conn, card_id, tags)
        row = _review_card_row(conn, card_id)
        return _review_card_payload(row, tags)
    finally:
        conn.close()


def delete_review_card(card_id: object) -> None:
    value = str(card_id or "").strip()
    if not value:
        raise ValueError("缺少卡片 id")
    conn = _review_connect()
    try:
        with conn:
            changed = conn.execute("DELETE FROM review_cards WHERE id = ?", (value,)).rowcount
            conn.execute(
                "DELETE FROM review_tags WHERE NOT EXISTS "
                "(SELECT 1 FROM review_card_tags ct WHERE ct.tag_id = review_tags.id)"
            )
        if not changed:
            raise LookupError("卡片不存在")
    finally:
        conn.close()


def _review_deck_name(value: object) -> str:
    return _review_text(
        value,
        label="卡组名称",
        limit=REVIEW_DECK_NAME_MAX,
        required=True,
    )


def _review_deck_payload(row: sqlite3.Row) -> dict:
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "sortOrder": int(row["sort_order"] or 0),
        "createdAt": str(row["created_at"] or ""),
        "updatedAt": str(row["updated_at"] or ""),
    }


def create_review_deck(raw: dict) -> dict:
    name = _review_deck_name(raw.get("name"))
    now = _study_now()
    deck_id = "rd_" + uuid.uuid4().hex
    conn = _review_connect()
    try:
        order = int(conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM review_decks"
        ).fetchone()[0])
        try:
            with conn:
                conn.execute(
                    """INSERT INTO review_decks
                       (id, name, name_key, sort_order, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (deck_id, name, name.casefold(), order, now, now),
                )
        except sqlite3.IntegrityError as err:
            raise ValueError("已存在同名卡组") from err
        row = conn.execute("SELECT * FROM review_decks WHERE id = ?", (deck_id,)).fetchone()
        return _review_deck_payload(row)
    finally:
        conn.close()


def update_review_deck(raw: dict) -> dict:
    deck_id = str(raw.get("id") or "").strip()
    if not deck_id:
        raise ValueError("缺少卡组 id")
    name = _review_deck_name(raw.get("name"))
    conn = _review_connect()
    try:
        try:
            with conn:
                changed = conn.execute(
                    "UPDATE review_decks SET name = ?, name_key = ?, updated_at = ? WHERE id = ?",
                    (name, name.casefold(), _study_now(), deck_id),
                ).rowcount
        except sqlite3.IntegrityError as err:
            raise ValueError("已存在同名卡组") from err
        if not changed:
            raise LookupError("卡组不存在")
        row = conn.execute("SELECT * FROM review_decks WHERE id = ?", (deck_id,)).fetchone()
        return _review_deck_payload(row)
    finally:
        conn.close()


def delete_review_deck(deck_id: object) -> None:
    value = str(deck_id or "").strip()
    if not value:
        raise ValueError("缺少卡组 id")
    conn = _review_connect()
    try:
        with conn:
            conn.execute(
                """UPDATE review_settings
                   SET scope_mode = 'all', scope_deck_id = NULL, updated_at = ?
                   WHERE scope_mode = 'deck' AND scope_deck_id = ?""",
                (_study_now(), value),
            )
            changed = conn.execute("DELETE FROM review_decks WHERE id = ?", (value,)).rowcount
        if not changed:
            raise LookupError("卡组不存在")
    finally:
        conn.close()


def batch_update_review_cards(raw: dict) -> int:
    card_ids = _review_card_ids(raw.get("ids"))
    status_present = "status" in raw and str(raw.get("status") or "").strip() != ""
    status = str(raw.get("status") or "").strip()
    if status_present and status not in REVIEW_CARD_STATUSES:
        raise ValueError("卡片状态无效")
    deck_present = "deckId" in raw
    add_tags = _review_tag_names(raw.get("addTags")) if "addTags" in raw else []
    remove_tags = _review_tag_names(raw.get("removeTags")) if "removeTags" in raw else []
    if not status_present and not deck_present and not add_tags and not remove_tags:
        raise ValueError("没有可应用的批量修改")
    conn = _review_connect()
    try:
        placeholders = ",".join("?" for _ in card_ids)
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                f"SELECT id FROM review_cards WHERE id IN ({placeholders})",
                card_ids,
            ).fetchall()
            if len(existing) != len(card_ids):
                raise LookupError("部分卡片不存在，请刷新卡片库")
            deck_id = _review_deck_id(conn, raw.get("deckId")) if deck_present else None
            sets = ["updated_at = ?"]
            values: list[object] = [_study_now()]
            if status_present:
                sets.append("status = ?")
                values.append(status)
            if deck_present:
                sets.append("deck_id = ?")
                values.append(deck_id)
            conn.execute(
                f"UPDATE review_cards SET {', '.join(sets)} WHERE id IN ({placeholders})",
                [*values, *card_ids],
            )
            if add_tags or remove_tags:
                current = _review_tags_by_card(conn, card_ids)
                remove_keys = {name.casefold() for name in remove_tags}
                for card_id in card_ids:
                    names = [name for name in current.get(card_id, [])
                             if name.casefold() not in remove_keys]
                    known = {name.casefold() for name in names}
                    for name in add_tags:
                        if name.casefold() not in known:
                            names.append(name)
                            known.add(name.casefold())
                    _review_replace_tags(conn, card_id, names[:REVIEW_TAGS_PER_CARD_MAX])
        return len(card_ids)
    finally:
        conn.close()


def batch_delete_review_cards(raw: dict) -> int:
    card_ids = _review_card_ids(raw.get("ids"))
    conn = _review_connect()
    try:
        placeholders = ",".join("?" for _ in card_ids)
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            existing_count = int(conn.execute(
                f"SELECT COUNT(*) FROM review_cards WHERE id IN ({placeholders})",
                card_ids,
            ).fetchone()[0])
            if existing_count != len(card_ids):
                raise LookupError("部分卡片不存在，请刷新卡片库")
            changed = conn.execute(
                f"DELETE FROM review_cards WHERE id IN ({placeholders})",
                card_ids,
            ).rowcount
            conn.execute(
                "DELETE FROM review_tags WHERE NOT EXISTS "
                "(SELECT 1 FROM review_card_tags ct WHERE ct.tag_id = review_tags.id)"
            )
        return changed
    finally:
        conn.close()


def mark_review_card(card_id: object, rating: object) -> dict:
    value = str(card_id or "").strip()
    normalized_rating = str(rating or "").strip()
    if not value:
        raise ValueError("缺少卡片 id")
    if normalized_rating not in REVIEW_RATINGS:
        raise ValueError("复习评分无效")
    conn = _review_connect()
    try:
        with conn:
            row = conn.execute("SELECT * FROM review_cards WHERE id = ?", (value,)).fetchone()
            if row is None:
                raise LookupError("卡片不存在")
            if row["status"] != "active":
                raise ValueError("这张卡片当前未启用")
            previous_level = max(0, min(int(row["level"] or 0), REVIEW_MAX_LEVEL))
            next_level = previous_level
            if normalized_rating == "remembered":
                next_level = min(previous_level + 1, REVIEW_MAX_LEVEL)
                days = REVIEW_LEVEL_DAYS[next_level]
            elif normalized_rating == "vague":
                days = max(1, REVIEW_LEVEL_DAYS[previous_level])
            else:
                next_level = 0
                days = 0
            reviewed_at = _study_now()
            next_due = (date.today() + timedelta(days=days)).isoformat()
            conn.execute(
                """
                UPDATE review_cards
                SET level = ?, due_on = ?, last_reviewed_at = ?, review_count = review_count + 1
                WHERE id = ?
                """,
                (next_level, next_due, reviewed_at, value),
            )
            conn.execute(
                """
                INSERT INTO review_events
                    (card_id, prompt_snapshot, rating, reviewed_at, previous_level, next_level, next_due_on)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (value, str(row["prompt"] or ""), normalized_rating, reviewed_at,
                 previous_level, next_level, next_due),
            )
        updated = _review_card_row(conn, value)
        tags = _review_tags_by_card(conn, [value]).get(value, [])
        return _review_card_payload(updated, tags)
    finally:
        conn.close()


def _archive_folder_count() -> int:
    """活跃页「累计归档」口径：归档 marker 的个数，不是任务件数。
    学习任务、速记和任务簿共用学习归档目录，以不同 JSON marker 区分。"""
    total = 0
    if STUDY_ARCHIVE_DIR.exists():
        # 学习任务与速记共用同一父目录，一次枚举同时检查两个 marker。
        for folder in STUDY_ARCHIVE_DIR.iterdir():
            if not folder.is_dir():
                continue
            total += int((folder / "tasks.json").is_file())
            total += int((folder / "notes.json").is_file())
            total += int((folder / "taskbook.json").is_file())
    if CANVAS_ARCHIVE_DIR.exists():
        total += sum(
            1 for folder in CANVAS_ARCHIVE_DIR.iterdir()
            if folder.is_dir() and (folder / "canvas.json").is_file()
        )
    return total


# ─── Windows 文件对话框（隐藏子进程，桌面版不闪终端）──────

_PICK_CANVAS_FILE_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '打开画布'
$dialog.Filter = '画布文件 (*.canvas)|*.canvas|所有文件 (*.*)|*.*'
$dialog.Multiselect = $false
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.FileName)
    }
} finally {
    $dialog.Dispose()
}
"""

_PICK_IMPORT_CANVAS_FILE_SCRIPT = _PICK_CANVAS_FILE_SCRIPT.replace(
    "$dialog.Title = '打开画布'",
    "$dialog.Title = '导入画布'",
).replace(
    "$dialog.Filter = '画布文件 (*.canvas)|*.canvas|所有文件 (*.*)|*.*'",
    "$dialog.Filter = '画布文件 (*.canvas)|*.canvas'",
)

_PICK_IMPORT_CANVAS_FOLDER_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择包含顶层 .canvas 与同名 .assets 的画布文件夹。'
$dialog.ShowNewFolderButton = $false
$dialog.SelectedPath = [Environment]::GetFolderPath('Desktop')
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
}
"""

_PICK_EXPORT_DIR_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择用来容纳 Markdown 导出包的父目录；确认后会在里面创建新的导出文件夹。'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = [Environment]::GetFolderPath('Desktop')
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
}
"""

_PICK_IMPORT_DIR_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择只包含 Markdown 文件的文件夹；它将被导入为一张新的画布。'
$dialog.ShowNewFolderButton = $false
$dialog.SelectedPath = [Environment]::GetFolderPath('Desktop')
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
}
"""

_PICK_BACKGROUND_IMAGE_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择图片'
$dialog.Filter = '图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp|PNG 图片 (*.png)|*.png|JPEG 图片 (*.jpg;*.jpeg)|*.jpg;*.jpeg|WebP 图片 (*.webp)|*.webp|GIF 图片 (*.gif)|*.gif|BMP 图片 (*.bmp)|*.bmp'
$dialog.Multiselect = $false
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.FileName)
    }
} finally {
    $dialog.Dispose()
}
"""


def _run_picker(script: str, error_message: str) -> str | None:
    """在隐藏的 STA PowerShell 中调 Windows 对话框，避免桌面版弹黑框。"""
    # 桌面 EXE（WebView2）可能遮住对话框——给所有 .ShowDialog() 套一个
    # TopMost 的 owner 窗体，确保对话框弹到最前面而不会藏在主窗口后面。
    script = script.replace(
        "$dialog.ShowDialog()",
        "$dialog.ShowDialog((New-Object System.Windows.Forms.Form"
        " -Property @{TopMost=$true}))",
    )
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-STA",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        raise OSError(error_message) from err
    if result.returncode != 0:
        raise OSError(error_message)
    out = (result.stdout or "").strip()
    return out or None


def pick_canvas_file() -> str | None:
    """弹原生 Windows 文件选择框，返回绝对路径，取消则返回 None。"""
    try:
        return _run_picker(_PICK_CANVAS_FILE_SCRIPT, "无法打开画布文件选择窗口")
    except OSError:
        return None


def pick_canvas_import_file() -> str | None:
    """选择一张将被复制进资料库的外部画布。"""
    return _run_picker(_PICK_IMPORT_CANVAS_FILE_SCRIPT, "无法打开画布导入窗口")


def pick_canvas_import_folder() -> str | None:
    """选择一个将被严格预检的外部画布文件夹。"""
    return _run_picker(_PICK_IMPORT_CANVAS_FOLDER_SCRIPT, "无法打开画布文件夹导入窗口")


def pick_export_dir() -> str | None:
    """弹原生 Windows 文件夹选择框，返回导出父目录；取消则返回 None。"""
    return _run_picker(_PICK_EXPORT_DIR_SCRIPT, "无法打开导出文件夹选择窗口")


def pick_import_dir() -> str | None:
    """弹原生 Windows 文件夹选择框，返回待导入 Markdown 目录；取消则返回 None。"""
    return _run_picker(_PICK_IMPORT_DIR_SCRIPT, "无法打开导入文件夹选择窗口")


def _sanitize_png_name(name: str) -> str:
    """把画布标题清洗成安全的 PNG 文件名（去非法字符、去单引号防 PS 字符串注入）。"""
    name = (name or "画布").strip() or "画布"
    for ch in '<>:"/\\|?*\'':
        name = name.replace(ch, "_")
    name = name.replace("\r", " ").replace("\n", " ")
    if not name.lower().endswith(".png"):
        name += ".png"
    return name[:120]


def pick_save_png(default_name: str) -> str | None:
    """弹原生 Windows「另存为」框选 PNG 保存路径；取消则返回 None。"""
    safe = _sanitize_png_name(default_name)
    script = (
        "Add-Type -AssemblyName System.Windows.Forms\n"
        "[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        "$dialog = New-Object System.Windows.Forms.SaveFileDialog\n"
        "$dialog.Title = '导出画布为 PNG 图片'\n"
        "$dialog.Filter = 'PNG 图片 (*.png)|*.png'\n"
        "$dialog.DefaultExt = 'png'\n"
        "$dialog.AddExtension = $true\n"
        "$dialog.FileName = '" + safe + "'\n"
        "$dialog.InitialDirectory = [Environment]::GetFolderPath('Desktop')\n"
        "try {\n"
        "    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {\n"
        "        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n"
        "        [Console]::Write($dialog.FileName)\n"
        "    }\n"
        "} finally {\n"
        "    $dialog.Dispose()\n"
        "}\n"
    )
    return _run_picker(script, "无法打开 PNG 保存窗口")


def pick_background_image() -> str | None:
    """弹文件选择框，返回用于画布背景的本地位图绝对路径；取消则返回 None。"""
    return _run_picker(_PICK_BACKGROUND_IMAGE_SCRIPT, "无法打开背景图片选择窗口")


def _safe_export_stem(raw: str, fallback: str) -> str:
    """把节点标题/画布名清洗成 Windows 可用的短文件名。"""
    first = next((line.strip() for line in str(raw or "").splitlines() if line.strip()), "")
    if first.startswith("#"):
        first = first.lstrip("#").strip()
    cleaned = "".join("_" if c in '\\/:*?"<>|' else c for c in first)
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    cleaned = " ".join(cleaned.split()).strip(" ._")
    cleaned = cleaned[:60].rstrip(" ._") or fallback
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(1, 10)
    }
    if cleaned.upper() in reserved:
        cleaned += "_"
    return cleaned


def _unused_path(parent: Path, stem: str, suffix: str = "") -> Path:
    candidate = parent / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    index = 2
    while True:
        candidate = parent / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def _unused_canvas_path(parent: Path, stem: str, *, current: Path | None = None) -> Path:
    """给任务关联画布挑一个不覆盖文件、也不覆盖伴生素材目录的名字。"""
    index = 1
    while True:
        suffix = "" if index == 1 else f"-{index}"
        candidate = parent / f"{stem}{suffix}.canvas"
        if current is not None and _norm(candidate) == _norm(current):
            return candidate
        if not candidate.exists() and not canvas_assets_root(candidate).exists():
            return candidate
        index += 1


def _is_link_or_reparse(path: Path) -> bool:
    """Reject links/junctions before copying an explicitly selected import source."""
    try:
        info = path.lstat()
    except OSError as err:
        raise ExternalCanvasImportError(
            f"无法读取导入来源：{path.name}", code="SOURCE_UNAVAILABLE", status=404,
        ) from err
    attributes = int(getattr(info, "st_file_attributes", 0) or 0)
    return path.is_symlink() or bool(attributes & 0x400)


def _external_file_signature(path: Path) -> tuple[int, int]:
    if _is_link_or_reparse(path) or not path.is_file():
        raise ExternalCanvasImportError(
            f"导入来源不是普通文件：{path.name}", code="UNSAFE_SOURCE",
        )
    try:
        info = path.stat()
    except OSError as err:
        raise ExternalCanvasImportError(
            f"无法读取导入来源：{path.name}", code="SOURCE_UNAVAILABLE", status=404,
        ) from err
    return int(info.st_size), int(info.st_mtime_ns)


def _external_tree_signature(root: Path) -> tuple[tuple[str, str, int, int], ...]:
    """Return a stable, non-following tree signature and reject special entries."""
    if _is_link_or_reparse(root) or not root.is_dir():
        raise ExternalCanvasImportError("请选择普通的画布文件夹", code="UNSAFE_SOURCE")
    rows: list[tuple[str, str, int, int]] = []

    def visit(folder: Path) -> None:
        try:
            entries = sorted(folder.iterdir(), key=lambda item: item.name.casefold())
        except OSError as err:
            raise ExternalCanvasImportError(
                f"无法读取文件夹：{folder.name}", code="SOURCE_UNAVAILABLE", status=404,
            ) from err
        for entry in entries:
            relative = entry.relative_to(root).as_posix()
            if _is_link_or_reparse(entry):
                raise ExternalCanvasImportError(
                    f"文件夹包含链接或重解析点：{relative}", code="UNSAFE_SOURCE",
                )
            try:
                info = entry.stat()
            except OSError as err:
                raise ExternalCanvasImportError(
                    f"无法读取：{relative}", code="SOURCE_UNAVAILABLE", status=404,
                ) from err
            if entry.is_dir():
                rows.append((relative, "dir", 0, int(info.st_mtime_ns)))
                visit(entry)
            elif entry.is_file():
                rows.append((relative, "file", int(info.st_size), int(info.st_mtime_ns)))
            else:
                raise ExternalCanvasImportError(
                    f"文件夹包含不支持的条目：{relative}", code="UNSAFE_SOURCE",
                )

    visit(root)
    return tuple(rows)


def _read_external_canvas(source: Path, *, strict: bool) -> tuple[bytes, dict]:
    if source.suffix.lower() != ".canvas":
        raise ExternalCanvasImportError("只能导入 .canvas 画布文件", code="INVALID_EXTENSION")
    size, _ = _external_file_signature(source)
    if size > MAX_JSON_BODY_BYTES:
        raise ExternalCanvasImportError(
            f"画布超过 160 MiB：{source.name}", code="SOURCE_TOO_LARGE", status=413,
        )
    try:
        content = source.read_bytes()
        payload = json.loads(content.decode("utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ExternalCanvasImportError(
            f"不是有效的 .canvas JSON：{source.name}", code="INVALID_JSON",
        ) from err
    if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list):
        raise ExternalCanvasImportError(
            f"画布缺少有效的 nodes 数组：{source.name}", code="INVALID_SOURCE",
        )
    if strict:
        try:
            _validate_canvas_import_payload(payload)
        except CanvasImportLibraryError as err:
            raise ExternalCanvasImportError(
                f"{source.name}：{err}", code=err.code, status=err.status,
            ) from err
    return content, payload


def _resolve_external_asset(root: Path, raw_path: str) -> tuple[str, Path]:
    normalized = str(raw_path or "").replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ExternalCanvasImportError(f"素材路径无效：{normalized}", code="INVALID_ASSET_PATH")
    target = root.joinpath(*parts)
    try:
        target.resolve().relative_to(root.resolve())
    except (OSError, ValueError) as err:
        raise ExternalCanvasImportError(f"素材路径越界：{normalized}", code="INVALID_ASSET_PATH") from err
    return "/".join(parts), target


def _validate_annotation_json(path: Path, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_file():
        raise ExternalCanvasImportError(f"批注文件无效：{label}", code="INVALID_ANNOTATION")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ExternalCanvasImportError(f"批注文件不是有效 JSON：{label}", code="INVALID_ANNOTATION") from err
    if not isinstance(payload, dict):
        raise ExternalCanvasImportError(f"批注文件格式无效：{label}", code="INVALID_ANNOTATION")


def _external_asset_manifest(
    source: Path,
    payload: dict,
    *,
    assets_root: Path | None = None,
    strict: bool,
) -> tuple[list[tuple[Path, str]], int]:
    root = assets_root or canvas_assets_root(source)
    references: list[str] = []
    seen_references: set[str] = set()
    for node in payload.get("nodes", []):
        if not isinstance(node, dict) or not node.get("assetPath"):
            continue
        normalized = str(node["assetPath"]).replace("\\", "/")
        if normalized not in seen_references:
            seen_references.add(normalized)
            references.append(normalized)

    if root.exists() and (_is_link_or_reparse(root) or not root.is_dir()):
        raise ExternalCanvasImportError(
            f"同名素材路径不是安全文件夹：{root.name}", code="UNSAFE_SOURCE",
        )

    planned: list[tuple[Path, str]] = []
    allowed_files: set[str] = set()
    missing = 0
    for raw in references:
        relative, asset = _resolve_external_asset(root, raw)
        if not root.is_dir() or not asset.exists():
            if strict:
                raise ExternalCanvasImportError(f"画布引用的素材不存在：{relative}", code="ASSET_MISSING")
            missing += 1
            continue
        if _is_link_or_reparse(asset) or not asset.is_file():
            raise ExternalCanvasImportError(f"素材不是普通文件：{relative}", code="UNSAFE_SOURCE")
        suffix = asset.suffix.lower()
        if suffix not in CANVAS_ASSET_TYPES:
            raise ExternalCanvasImportError(f"不支持这种素材：{relative}", code="ASSET_TYPE_UNSUPPORTED")
        size, _ = _external_file_signature(asset)
        limit = MAX_CANVAS_IMAGE_BYTES if suffix in BACKGROUND_IMAGE_TYPES else MAX_CANVAS_ATTACHMENT_BYTES
        if size > limit:
            raise ExternalCanvasImportError(f"素材过大：{relative}", code="ASSET_TOO_LARGE", status=413)
        planned.append((asset, relative))
        allowed_files.add(relative.casefold())

        annotation = asset.with_name(asset.name + ".annot.json")
        if annotation.exists():
            annotation_relative = relative + ".annot.json"
            _validate_annotation_json(annotation, annotation_relative)
            planned.append((annotation, annotation_relative))
            allowed_files.add(annotation_relative.casefold())

    node_annotations = root / "node-annotations.json"
    if node_annotations.exists():
        _validate_annotation_json(node_annotations, "node-annotations.json")
        planned.append((node_annotations, "node-annotations.json"))
        allowed_files.add("node-annotations.json")

    if strict and root.is_dir():
        for folder, dir_names, file_names in os.walk(root, followlinks=False):
            folder_path = Path(folder)
            for name in list(dir_names):
                child = folder_path / name
                if _is_link_or_reparse(child):
                    relative = child.relative_to(root).as_posix()
                    raise ExternalCanvasImportError(
                        f"素材目录包含链接或重解析点：{relative}", code="UNSAFE_SOURCE",
                    )
            for name in file_names:
                child = folder_path / name
                relative = child.relative_to(root).as_posix()
                if _is_link_or_reparse(child):
                    raise ExternalCanvasImportError(
                        f"素材目录包含链接或重解析点：{relative}", code="UNSAFE_SOURCE",
                    )
                if relative.casefold() not in allowed_files:
                    raise ExternalCanvasImportError(
                        f"素材目录包含未知或未引用文件：{relative}", code="UNKNOWN_ASSET",
                    )
    return planned, missing


def _prepare_external_canvas(
    source: Path,
    *,
    assets_root: Path | None = None,
    strict: bool,
) -> dict:
    canvas_signature = _external_file_signature(source)
    content, payload = _read_external_canvas(source, strict=strict)
    assets, missing = _external_asset_manifest(
        source, payload, assets_root=assets_root, strict=strict,
    )
    return {
        "source": source,
        "content": content,
        "payload": payload,
        "assets": assets,
        "missingAssetCount": missing,
        "canvasSignature": canvas_signature,
    }


def _scan_external_canvas_folder(folder: Path) -> tuple[list[dict], tuple[tuple[str, str, int, int], ...]]:
    try:
        if folder.resolve() == CANVASES.resolve():
            raise ExternalCanvasImportError("不能导入当前项目自己的 canvases 目录", code="SAME_LIBRARY")
    except OSError as err:
        raise ExternalCanvasImportError("无法解析所选文件夹", code="SOURCE_UNAVAILABLE", status=404) from err
    before = _external_tree_signature(folder)
    try:
        entries = sorted(folder.iterdir(), key=lambda item: item.name.casefold())
    except OSError as err:
        raise ExternalCanvasImportError("无法读取所选文件夹", code="SOURCE_UNAVAILABLE", status=404) from err

    canvases_by_stem: dict[str, Path] = {}
    assets_by_stem: dict[str, Path] = {}
    for entry in entries:
        if entry.name == "回收站":
            raise ExternalCanvasImportError("所选文件夹包含“回收站”，已拒绝整批导入", code="TRASH_PRESENT")
        if _is_link_or_reparse(entry):
            raise ExternalCanvasImportError(f"文件夹包含链接或重解析点：{entry.name}", code="UNSAFE_SOURCE")
        if entry.is_file() and entry.suffix.lower() == ".canvas":
            key = entry.stem.casefold()
            if key in canvases_by_stem:
                raise ExternalCanvasImportError(f"画布名称冲突：{entry.name}", code="DUPLICATE_SOURCE")
            canvases_by_stem[key] = entry
            continue
        if entry.is_dir() and entry.name.lower().endswith(".assets"):
            key = entry.name[:-len(".assets")].casefold()
            if key in assets_by_stem:
                raise ExternalCanvasImportError(f"素材目录名称冲突：{entry.name}", code="DUPLICATE_SOURCE")
            assets_by_stem[key] = entry
            continue
        raise ExternalCanvasImportError(f"文件夹顶层包含未知内容：{entry.name}", code="UNKNOWN_ENTRY")

    if not canvases_by_stem:
        raise ExternalCanvasImportError("所选文件夹顶层没有 .canvas 文件", code="EMPTY_SOURCE")
    orphan_assets = sorted(set(assets_by_stem) - set(canvases_by_stem))
    if orphan_assets:
        orphan = assets_by_stem[orphan_assets[0]].name
        raise ExternalCanvasImportError(f"素材目录没有对应画布：{orphan}", code="ORPHAN_ASSETS")

    plans = [
        _prepare_external_canvas(
            canvases_by_stem[key], assets_root=assets_by_stem.get(key), strict=True,
        )
        for key in sorted(canvases_by_stem)
    ]
    return plans, before


def _unused_canvas_path_reserved(parent: Path, stem: str, reserved: set[str]) -> Path:
    index = 1
    while True:
        suffix = "" if index == 1 else f"-{index}"
        candidate = parent / f"{stem}{suffix}.canvas"
        key = os.path.normcase(_norm(candidate))
        assets_key = os.path.normcase(_norm(canvas_assets_root(candidate)))
        if (
            key not in reserved
            and assets_key not in reserved
            and not candidate.exists()
            and not canvas_assets_root(candidate).exists()
        ):
            reserved.add(key)
            reserved.add(assets_key)
            return candidate
        index += 1


def _restore_optional_file(path: Path, content: bytes | None) -> None:
    if content is None:
        path.unlink(missing_ok=True)
    else:
        _atomic_write_bytes(path, content)


def import_external_canvas_copies(
    sources: list[dict],
    *,
    group: object = "",
    folder_source: Path | None = None,
    folder_signature: tuple[tuple[str, str, int, int], ...] | None = None,
) -> dict:
    """Stage, commit and index one or more validated external canvas copies."""
    if not sources:
        raise ExternalCanvasImportError("没有可导入的画布", code="EMPTY_SOURCE")
    CANVASES.mkdir(parents=True, exist_ok=True)
    stage_root = CANVASES / f".relatum-import-{uuid.uuid4().hex}"
    materialized: list[Path] = []
    try:
        stage_root.mkdir()
        for index, plan in enumerate(sources):
            item_root = stage_root / str(index)
            item_root.mkdir()
            stage_canvas = item_root / "source.canvas"
            _atomic_write_bytes(stage_canvas, plan["content"])
            stage_assets = item_root / "source.assets"
            if plan["assets"]:
                for source_asset, relative in plan["assets"]:
                    before = _external_file_signature(source_asset)
                    destination = stage_assets.joinpath(*relative.split("/"))
                    _atomic_copy_file(source_asset, destination)
                    if _external_file_signature(source_asset) != before:
                        raise ExternalCanvasImportError(
                            f"复制期间来源素材发生变化：{relative}", code="SOURCE_CHANGED", status=409,
                        )
            if _external_file_signature(plan["source"]) != plan["canvasSignature"]:
                raise ExternalCanvasImportError(
                    f"复制期间来源画布发生变化：{plan['source'].name}", code="SOURCE_CHANGED", status=409,
                )
            plan["stageCanvas"] = stage_canvas
            plan["stageAssets"] = stage_assets

        if folder_source is not None and folder_signature is not None:
            if _external_tree_signature(folder_source) != folder_signature:
                raise ExternalCanvasImportError("复制期间所选文件夹发生变化", code="SOURCE_CHANGED", status=409)

        requested_group = str(group or "")
        with _cross_process_mutation_lock():
            with CANVAS_FILE_MUTATION_LOCK:
                with DATA_MUTATION_LOCK:
                    recent = load_recent()
                    valid_groups = {str(item.get("id") or "") for item in recent.get("groups", [])}
                    actual_group = requested_group if requested_group in valid_groups else ""
                    recent_before = RECENT_FILE.read_bytes() if RECENT_FILE.is_file() else None
                    recent_backup_before = RECENT_BACKUP_FILE.read_bytes() if RECENT_BACKUP_FILE.is_file() else None
                    activity_before = CANVAS_ACTIVITY_FILE.read_bytes() if CANVAS_ACTIVITY_FILE.is_file() else None
                    reserved: set[str] = set()
                    for plan in sources:
                        stem = _safe_export_stem(plan["source"].stem, "导入画布")
                        target = _unused_canvas_path_reserved(CANVASES, stem, reserved)
                        plan["target"] = target
                        plan["renamed"] = target.stem != plan["source"].stem

                    try:
                        for plan in sources:
                            target = plan["target"]
                            stage_assets = plan["stageAssets"]
                            materialized.append(target)
                            if stage_assets.is_dir():
                                os.replace(stage_assets, canvas_assets_root(target))
                            os.replace(plan["stageCanvas"], target)
                        items = []
                        for plan in sources:
                            target = plan["target"]
                            register_recent(target, target.stem)
                            if actual_group:
                                file_set_group(_norm(target), actual_group)
                            activity = record_canvas_activity_event(target, "created", payload=plan["payload"])
                            items.append({
                                "path": _norm(target),
                                "title": target.stem,
                                "renamed": bool(plan["renamed"]),
                                "missingAssetCount": int(plan["missingAssetCount"]),
                                "canvasActivity": activity,
                            })
                    except Exception:
                        for target in reversed(materialized):
                            try:
                                target.unlink(missing_ok=True)
                            except OSError:
                                pass
                            try:
                                shutil.rmtree(canvas_assets_root(target), ignore_errors=True)
                            except OSError:
                                pass
                        _restore_optional_file(RECENT_FILE, recent_before)
                        _restore_optional_file(RECENT_BACKUP_FILE, recent_backup_before)
                        _restore_optional_file(CANVAS_ACTIVITY_FILE, activity_before)
                        raise

        return {
            "ok": True,
            "count": len(items),
            "items": items,
            "group": actual_group,
            "assetCount": sum(len(plan["assets"]) for plan in sources),
            "renamedCount": sum(bool(plan["renamed"]) for plan in sources),
            "missingAssetCount": sum(int(plan["missingAssetCount"]) for plan in sources),
        }
    except ExternalCanvasImportError:
        raise
    except OSError as err:
        raise ExternalCanvasImportError(f"导入失败：{err}", code="IMPORT_FAILED", status=500) from err
    finally:
        try:
            if stage_root.resolve().parent == CANVASES.resolve():
                shutil.rmtree(stage_root, ignore_errors=True)
        except OSError:
            pass


def _rename_study_linked_canvas(data: dict, raw_path: str, title: str) -> str:
    """按任务名迁移关联画布，并修复所有共同关联该画布的任务路径。"""
    src = Path(raw_path)
    if not src.is_file():
        return _norm(src)
    if not is_authorized(src):
        raise PermissionError("关联画布路径未授权")
    stem = _safe_export_stem(title, "未命名任务")
    dst = _unused_canvas_path(src.parent, stem, current=src)
    if _norm(dst) == _norm(src):
        return _norm(src)
    move_canvas_with_assets(src, dst)
    rename_in_recent(src, dst)
    move_viewport_state(src, dst)
    old_path = _norm(src)
    new_path = _norm(dst)
    for task in data.get("tasks", []):
        if _norm(task.get("linkedCanvas", "")) == old_path:
            task["linkedCanvas"] = new_path
    for entry in data.get("trash", []):
        task = entry.get("task", {}) if isinstance(entry, dict) else {}
        if _norm(task.get("linkedCanvas", "")) == old_path:
            task["linkedCanvas"] = new_path
    return new_path


_RICH_TEXT_COLORS = {"yellow", "orange", "red", "purple", "blue", "cyan", "green", "gray", "white"}
_RICH_TEXT_HIGHLIGHTS = _RICH_TEXT_COLORS - {"white"}
_RICH_TEXT_SIZES = {"sm", "lg", "xl"}


def _utf16_offset_to_index(text: str, offset: object) -> int:
    """Convert a browser UTF-16 text offset to a Python string index."""
    try:
        target = max(0, int(offset))
    except (TypeError, ValueError):
        target = 0
    used = 0
    for index, char in enumerate(text):
        width = 2 if ord(char) > 0xFFFF else 1
        if used + width > target:
            return index
        used += width
        if used == target:
            return index + 1
    return len(text)


def _serialize_rich_text(text: object, raw_marks: object) -> str:
    """Serialize structured canvas text marks only at the Markdown export boundary."""
    value = str(text or "")
    if not value or not isinstance(raw_marks, list):
        return value
    intervals: list[tuple[int, int, dict]] = []
    for raw in raw_marks:
        if not isinstance(raw, dict):
            continue
        start = _utf16_offset_to_index(value, raw.get("start"))
        end = _utf16_offset_to_index(value, raw.get("end"))
        if end <= start:
            continue
        style: dict[str, object] = {}
        if raw.get("size") in _RICH_TEXT_SIZES:
            style["size"] = raw["size"]
        if raw.get("color") in _RICH_TEXT_COLORS:
            style["color"] = raw["color"]
        if raw.get("highlight") in _RICH_TEXT_HIGHLIGHTS:
            style["highlight"] = raw["highlight"]
        if raw.get("bold") is True:
            style["bold"] = True
        if style:
            intervals.append((start, end, style))
    if not intervals:
        return value

    points = sorted({0, len(value), *(p for item in intervals for p in item[:2])})

    def wrap(piece: str, style: dict) -> str:
        if not piece:
            return piece
        out = piece
        if style.get("bold"):
            out = f"**{out}**"
        if style.get("size"):
            out = f"{{fs:{style['size']}|{out}}}"
        if style.get("color"):
            out = f"{{tc:{style['color']}|{out}}}"
        highlight = style.get("highlight")
        if highlight:
            out = f"=={out}==" if highlight == "yellow" else f"{{hl:{highlight}|{out}}}"
        return out

    output: list[str] = []
    for index in range(len(points) - 1):
        start, end = points[index], points[index + 1]
        if end <= start:
            continue
        style: dict[str, object] = {}
        for mark_start, mark_end, mark_style in intervals:
            if mark_start <= start < mark_end:
                style.update(mark_style)
        piece = value[start:end]
        # A marker must not span line breaks; emit one wrapper per non-empty line.
        output.append("\n".join(wrap(line, style) if line else "" for line in piece.split("\n")))
    return "".join(output)


def export_markdown_bundle(
    canvas_path: Path,
    payload: dict,
    destination: Path,
) -> tuple[Path, int, int, int]:
    """把当前画布导出为一组互相双链的 Markdown；发布前先在临时目录写齐。"""
    if not destination.is_dir():
        raise OSError("选择的目标文件夹不存在")
    nodes = payload.get("nodes")
    edges = payload.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise OSError("画布数据格式不正确")

    day = date.today()
    dated = f"{_safe_export_stem(canvas_path.stem, '画布')}-{day.year % 100}-{day.month}-{day.day}"
    output_dir = _unused_path(destination, dated)
    temp_dir = destination / f".{output_dir.name}.tmp-{os.getpid()}"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)

    node_files: dict[str, str] = {}
    used_names: set[str] = set()
    for index, node in enumerate(nodes, 1):
        if not isinstance(node, dict):
            continue
        if node.get("kind") in {"shape", "image", "pdf", "md", "textBox", "taskbook", "task-root"}:
            continue   # 装饰与附件不进 Markdown 导出（连到附件的边随之被 neighbors 过滤掉）
        node_id = str(node.get("id") or f"node-{index}")
        base = _safe_export_stem(str(node.get("text") or ""), f"未命名节点-{index}")
        stem = base
        duplicate = 2
        while stem.casefold() in used_names:
            stem = f"{base}-{duplicate}"
            duplicate += 1
        used_names.add(stem.casefold())
        node_files[node_id] = stem

    notebook = payload.get("markdownNotebook")
    raw_notes = notebook.get("notes") if isinstance(notebook, dict) else []
    notes = [note for note in raw_notes if isinstance(note, dict)] if isinstance(raw_notes, list) else []
    note_files: list[tuple[str, str]] = []
    used_note_names: set[str] = set()
    for index, note in enumerate(notes, 1):
        base = _safe_export_stem(str(note.get("title") or ""), f"未命名笔记-{index}")
        stem = base
        duplicate = 2
        while stem.casefold() in used_note_names:
            stem = f"{base}-{duplicate}"
            duplicate += 1
        used_note_names.add(stem.casefold())
        note_files.append((stem, str(note.get("markdown") or "")))

    neighbors: dict[str, set[str]] = {node_id: set() for node_id in node_files}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("from") or "")
        tgt = str(edge.get("to") or "")
        if src in neighbors and tgt in neighbors and src != tgt:
            neighbors[src].add(tgt)
            neighbors[tgt].add(src)

    try:
        temp_dir.mkdir(parents=False, exist_ok=False)
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("id") or "")
            if node_id not in node_files:
                continue
            links = [f"[[{node_files[other]}]]" for other in sorted(
                neighbors[node_id], key=lambda other: node_files[other].casefold()
            )]
            if node.get("kind") in {"index", "text", "preview", "card", "sticky", "table"}:
                body = _serialize_rich_text(node.get("body"), node.get("bodyMarks"))
            elif node.get("kind") == "code":
                language = str(node.get("language") or "c").lower()
                if language not in {"c", "python", "matlab"}:
                    language = "c"
                source = str(node.get("body") or "").rstrip()
                body = f"```{language}\n{source}\n```"
            else:
                body = _serialize_rich_text(node.get("text"), node.get("textMarks"))
            pieces = []
            if links:
                pieces.append("\n".join(links))
            if body.strip():
                pieces.append(body.rstrip())
            text = "\n\n".join(pieces)
            if text:
                text += "\n"
            (temp_dir / f"{node_files[node_id]}.md").write_text(text, encoding="utf-8")
        if note_files:
            notebook_dir = temp_dir / "笔记坞"
            notebook_dir.mkdir()
            for stem, markdown in note_files:
                text = markdown.rstrip()
                if text:
                    text += "\n"
                (notebook_dir / f"{stem}.md").write_text(text, encoding="utf-8")
        temp_dir.rename(output_dir)
    except OSError:
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    node_count = len(node_files)
    note_count = len(note_files)
    return output_dir, node_count + note_count, node_count, note_count


class MarkdownImportError(ValueError):
    """导入目录内容不符合 Markdown 画布约定。"""


_WIKI_LINK_LINE = re.compile(r"^\s*\[\[([^\[\]\r\n]+)\]\]\s*$")


def _markdown_body_and_links(text: str) -> tuple[str, list[str]]:
    """解析文档开头连续的 [[标题]] 行，返回正文与链接标题。"""
    lines = text.splitlines(keepends=True)
    index = 0
    links: list[str] = []
    while index < len(lines):
        match = _WIKI_LINK_LINE.fullmatch(lines[index].rstrip("\r\n"))
        if not match:
            break
        target = match.group(1).strip()
        if not target:
            break
        links.append(target)
        index += 1
    if links and index < len(lines) and not lines[index].strip():
        index += 1
    return "".join(lines[index:]), links


# ─── 导入画布的自动排版（力导向有机布局 + 按簇配色，纯标准库） ──────────
# 用 [[双链]] 关系驱动：相互链接的笔记抱团成「簇」，每簇内跑力导向收敛
# （照搬前端关系图谱的斥力+弹簧手感），再做卡片防重叠，最后把各簇打包铺开。
# 全程确定性（圆周初始化、固定迭代次数），同一份笔记每次导入结果一致。

_IMPORT_NODE_W = 280.0          # 卡片排版用的估算尺寸（间距基准，非真实渲染尺寸）
_IMPORT_NODE_H = 160.0
_IMPORT_SPRING_LEN = 360.0      # 连线弹簧静止长度
_IMPORT_GAP_X = 64.0            # 卡片间最小横向留白
_IMPORT_GAP_Y = 56.0           # 卡片间最小纵向留白
_IMPORT_ORIGIN_X = 160
_IMPORT_ORIGIN_Y = 140
_IMPORT_ROW_MAX_W = 2800.0      # 多簇打包时一行的最大宽度，超出换行
_IMPORT_COMP_GAP_X = 200.0      # 簇与簇之间的横向间隔
_IMPORT_COMP_GAP_Y = 200.0      # 行与行之间的纵向间隔
_IMPORT_EDGE_COLOR = "#bcbcbc"  # 柔和中性灰连线
_IMPORT_CLUSTER_COLORS = ["blue", "green", "yellow", "red", "purple"]
_IMPORT_FORCE_LAYOUT_MAX = 240
_IMPORT_FILES_MAX = 2000
_IMPORT_FILE_BYTES_MAX = 4 * 1024 * 1024
_IMPORT_TOTAL_BYTES_MAX = 64 * 1024 * 1024


def _force_layout(ids: list[str], edges_in: list[tuple[str, str]]) -> dict[str, list[float]]:
    """对单个连通簇做 Fruchterman-Reingold 力导向收敛，返回各节点坐标。"""
    n = len(ids)
    if n == 1:
        return {ids[0]: [0.0, 0.0]}
    if n > _IMPORT_FORCE_LAYOUT_MAX:
        # The force solver is O(n² × iterations).  A very large, densely linked
        # Markdown folder used to pin a CPU core for minutes.  Fall back to a
        # deterministic roomy grid; the canvas remains usable and import time is
        # bounded instead of trying to force-layout thousands of cards.
        columns = max(1, int(math.ceil(math.sqrt(n))))
        step_x = _IMPORT_NODE_W + _IMPORT_GAP_X
        step_y = _IMPORT_NODE_H + _IMPORT_GAP_Y
        return {
            node_id: [float((index % columns) * step_x), float((index // columns) * step_y)]
            for index, node_id in enumerate(ids)
        }
    radius = _IMPORT_SPRING_LEN * max(1.0, n / (2.0 * math.pi))
    pos: dict[str, list[float]] = {}
    for i, nid in enumerate(ids):
        ang = 2.0 * math.pi * i / n
        pos[nid] = [math.cos(ang) * radius, math.sin(ang) * radius]
    k = _IMPORT_SPRING_LEN
    iters = 400 if n <= 80 else max(140, int(32000 / n))
    temp = radius
    cool = temp / (iters + 1)
    for _ in range(iters):
        disp = {nid: [0.0, 0.0] for nid in ids}
        for a in range(n):
            ia = ids[a]
            pa = pos[ia]
            for b in range(a + 1, n):
                ib = ids[b]
                pb = pos[ib]
                dx = pa[0] - pb[0]
                dy = pa[1] - pb[1]
                dist = math.hypot(dx, dy) or 0.01
                f = k * k / dist            # 斥力：节点互相推开
                ux = dx / dist
                uy = dy / dist
                da = disp[ia]
                db = disp[ib]
                da[0] += ux * f
                da[1] += uy * f
                db[0] -= ux * f
                db[1] -= uy * f
        for u, v in edges_in:
            pu = pos[u]
            pv = pos[v]
            dx = pu[0] - pv[0]
            dy = pu[1] - pv[1]
            dist = math.hypot(dx, dy) or 0.01
            f = dist * dist / k             # 引力：有连线的相互拉近
            ux = dx / dist
            uy = dy / dist
            du = disp[u]
            dv = disp[v]
            du[0] -= ux * f
            du[1] -= uy * f
            dv[0] += ux * f
            dv[1] += uy * f
        for nid in ids:
            d = disp[nid]
            mag = math.hypot(d[0], d[1]) or 0.01
            lim = min(mag, temp)            # 退火：单步位移随温度收窄
            p = pos[nid]
            p[0] += d[0] / mag * lim
            p[1] += d[1] / mag * lim
        temp = max(temp - cool, 1.0)
    return pos


def _resolve_overlaps(pos: dict[str, list[float]]) -> None:
    """把矩形卡片之间的重叠沿最浅一侧推开（原地修改 pos）。"""
    ids = list(pos)
    n = len(ids)
    if n < 2:
        return
    min_x = _IMPORT_NODE_W + _IMPORT_GAP_X
    min_y = _IMPORT_NODE_H + _IMPORT_GAP_Y
    passes = 160 if n <= 80 else max(60, int(12000 / n))
    for _ in range(passes):
        moved = False
        for a in range(n):
            pa = pos[ids[a]]
            for b in range(a + 1, n):
                pb = pos[ids[b]]
                dx = pb[0] - pa[0]
                dy = pb[1] - pa[1]
                ox = min_x - abs(dx)
                oy = min_y - abs(dy)
                if ox > 0 and oy > 0:
                    moved = True
                    if ox <= oy:
                        s = ox / 2.0 if dx >= 0 else -ox / 2.0
                        pa[0] -= s
                        pb[0] += s
                    else:
                        s = oy / 2.0 if dy >= 0 else -oy / 2.0
                        pa[1] -= s
                        pb[1] += s
        if not moved:
            break


def _layout_import_canvas(nodes: list[dict], edge_pairs: set[tuple[str, str]],
                          assign_colors: bool = True) -> None:
    """给导入节点分配坐标与簇配色（原地修改 nodes）。
    assign_colors=False 时只算坐标、不动 color（AI 生成注入会用，保留模型给的语义配色）。"""
    by_id = {n["id"]: n for n in nodes}
    adj: dict[str, set[str]] = {nid: set() for nid in by_id}
    for a, b in edge_pairs:
        adj[a].add(b)
        adj[b].add(a)

    # 连通分量（按节点原顺序遍历，结果稳定）
    seen: set[str] = set()
    components: list[list[str]] = []
    for node in nodes:
        nid = node["id"]
        if nid in seen:
            continue
        stack = [nid]
        seen.add(nid)
        comp: list[str] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nb in adj[cur]:
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        components.append(comp)

    # 大簇优先、孤立笔记垫后，让主结构在上方
    components.sort(key=lambda c: (len(c) == 1, -len(c)))

    blocks: list[tuple[dict[str, list[float]], float, float, list[str], str | None]] = []
    color_idx = 0
    for comp in components:
        comp_set = set(comp)
        edges_in = [(a, b) for (a, b) in edge_pairs if a in comp_set and b in comp_set]
        pos = _force_layout(comp, edges_in)
        _resolve_overlaps(pos)
        xs = [p[0] for p in pos.values()]
        ys = [p[1] for p in pos.values()]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        rel = {nid: [pos[nid][0] - min_x, pos[nid][1] - min_y] for nid in comp}
        width = (max_x - min_x) + _IMPORT_NODE_W
        height = (max_y - min_y) + _IMPORT_NODE_H
        color: str | None = None
        if assign_colors and len(comp) >= 2:  # 只给「成簇」的笔记上色，孤立笔记保持中性
            color = _IMPORT_CLUSTER_COLORS[color_idx % len(_IMPORT_CLUSTER_COLORS)]
            color_idx += 1
        blocks.append((rel, width, height, comp, color))

    # 货架式打包：各簇从左到右排，超出行宽就换行
    cx = float(_IMPORT_ORIGIN_X)
    cy = float(_IMPORT_ORIGIN_Y)
    row_h = 0.0
    for rel, width, height, comp, color in blocks:
        if cx > _IMPORT_ORIGIN_X and cx + width > _IMPORT_ORIGIN_X + _IMPORT_ROW_MAX_W:
            cx = float(_IMPORT_ORIGIN_X)
            cy += row_h + _IMPORT_COMP_GAP_Y
            row_h = 0.0
        for nid in comp:
            rx, ry = rel[nid]
            node = by_id[nid]
            node["x"] = int(round(cx + rx))
            node["y"] = int(round(cy + ry))
            if color:
                node["color"] = color
        row_h = max(row_h, height)
        cx += width + _IMPORT_COMP_GAP_X


def import_markdown_folder(source: Path) -> tuple[Path, int, int]:
    """将只含 Markdown 的文件夹导入成一张新画布，并登记到「最近」。"""
    if not source.is_dir():
        raise MarkdownImportError("选择的导入文件夹不存在")
    try:
        entries = sorted(source.iterdir(), key=lambda path: path.name.casefold())
    except OSError as err:
        raise OSError(f"无法读取导入文件夹：{err}") from err
    if not entries:
        raise MarkdownImportError("文件夹为空，没有可导入的 Markdown 文件")

    markdown_files: list[Path] = []
    invalid_entries: list[str] = []
    for entry in entries:
        if not entry.is_file() or entry.suffix.lower() != ".md":
            invalid_entries.append(entry.name)
        else:
            markdown_files.append(entry)
    if invalid_entries:
        shown = "、".join(invalid_entries[:3])
        if len(invalid_entries) > 3:
            shown += " 等"
        raise MarkdownImportError(f"只支持文件夹第一层的 .md 文件；请先移除：{shown}")
    if not markdown_files:
        raise MarkdownImportError("文件夹中没有 Markdown 文件")
    if len(markdown_files) > _IMPORT_FILES_MAX:
        raise MarkdownImportError(f"一次最多导入 {_IMPORT_FILES_MAX} 个 Markdown 文件")

    total_bytes = 0
    for path in markdown_files:
        try:
            size = path.stat().st_size
        except OSError as err:
            raise OSError(f"无法读取 Markdown 文件「{path.name}」：{err}") from err
        if size > _IMPORT_FILE_BYTES_MAX:
            raise MarkdownImportError(f"Markdown 文件「{path.name}」超过 4MB")
        total_bytes += size
        if total_bytes > _IMPORT_TOTAL_BYTES_MAX:
            raise MarkdownImportError("待导入 Markdown 文件总大小超过 64MB")

    by_title: dict[str, Path] = {}
    for path in markdown_files:
        key = path.stem.casefold()
        if key in by_title:
            raise MarkdownImportError(f"文件名无法唯一匹配双链：{path.stem}")
        by_title[key] = path

    nodes: list[dict] = []
    link_sets: dict[str, dict[str, str]] = {}
    title_to_id: dict[str, str] = {}
    for index, path in enumerate(markdown_files):
        try:
            source_text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as err:
            raise OSError(f"无法读取 Markdown 文件「{path.name}」：{err}") from err
        body, links = _markdown_body_and_links(source_text)
        node_id = f"n_import_{index + 1}"
        title_to_id[path.stem.casefold()] = node_id
        node = {
            "id": node_id,
            "x": 0,                 # 占位，坐标由 _layout_import_canvas 统一计算
            "y": 0,
            "text": path.stem,
            "kind": "card",
        }
        if body:
            node["body"] = body
        nodes.append(node)
        link_sets[node_id] = {}
        for link in links:
            link_sets[node_id].setdefault(link.casefold(), link)

    edges: list[dict] = []
    edge_pairs: set[tuple[str, str]] = set()
    for node in nodes:
        src = node["id"]
        for key, written_target in link_sets[src].items():
            target_path = by_title.get(key)
            if target_path is None:
                raise MarkdownImportError(
                    f"「{node['text']}.md」链接的「[[{written_target}]]」没有对应 Markdown 文件"
                )
            tgt = title_to_id[key]
            if src == tgt:
                raise MarkdownImportError(f"「{node['text']}.md」不能链接自身")
            pair = tuple(sorted((src, tgt)))
            if pair in edge_pairs:
                continue
            edge_pairs.add(pair)
            edges.append({
                "id": f"e_import_{len(edges) + 1}",
                "from": pair[0],
                "to": pair[1],
                "text": "",
                "curve": "smooth",
                "color": _IMPORT_EDGE_COLOR,
            })

    _layout_import_canvas(nodes, edge_pairs)

    now = datetime.now().replace(microsecond=0).isoformat()
    payload = {
        "version": 2,
        "createdAt": now,
        "updatedAt": now,
        "nodes": nodes,
        "edges": edges,
    }
    title = _safe_export_stem(source.name, "导入画布")
    target = _unused_path(CANVASES, title, ".canvas")
    try:
        _atomic_write_json(target, payload, streaming=True)
    except OSError as err:
        raise OSError(f"创建导入画布失败：{err}") from err
    register_recent(target)
    record_canvas_activity_event(target, "created", payload=payload)
    return target, len(nodes), len(edges)


# ─── AI 助手（阶段 1：对话代理，零依赖 urllib 出站调用） ──────────
# 画布作为客户端去问外部模型（出站），不对外开放 API，不违反"协议 A"。
# 配置（API Key / 模型 / 接口地址）存 data/ai.json，跟其它运行时数据一起，
# 不写进任何 .canvas，也不长期留在前端 localStorage。DeepSeek 兼容 OpenAI 接口。

AI_CONFIG_FILE = DATA / "ai.json"
AI_DEFAULT_BASE_URL = "https://api.deepseek.com"
AI_DEFAULT_MODEL = "deepseek-chat"
AI_REQUEST_TIMEOUT = 600          # 秒；v4-pro 会先思考再答，铺满几十张卡的丰富生成实测可达数分钟，给足免得中途断
AI_MAX_MESSAGES = 40              # 单次请求最多带多少条上下文（始终保留开头 system）
# 输出天花板：v4-pro 实际支持到 384K，但这里是"防截断"不是"油门"——真正决定长度的是提示词。
# 32768 足够任何丰富多卡生成（思考预算也含在内），再高也只是让极端跑飞的情况空等更久，无收益。
AI_MAX_OUTPUT_TOKENS = 32768
AI_CHAT_MAX_OUTPUT_TOKENS = 8192
# DeepSeek 思考模式（v4-pro 默认就开）：显式声明便于稳定与日后切换；reasoning_effort 控制思考强度。
# 思考内容走独立的 reasoning_content 字段、不混进正文；强度越高质量越好但越慢，想更狠可改 "max"。
AI_THINKING_ENABLED = True
AI_REASONING_EFFORT = "high"      # None=用模型默认；可选 "high" / "max"
AI_OPTIONAL_CAPABILITY_CACHE: dict[tuple[str, str], set[str]] = {}
AI_OPTIONAL_CAPABILITY_LOCK = threading.Lock()
AI_OPTIONAL_FIELDS = {"thinking", "reasoning_effort", "response_format"}


def load_ai_config() -> dict:
    """读 data/ai.json；缺失或损坏都回退到内置默认（无 Key）。"""
    base = {"apiKey": "", "model": AI_DEFAULT_MODEL, "baseUrl": AI_DEFAULT_BASE_URL}
    if not AI_CONFIG_FILE.exists():
        return base
    try:
        raw = json.loads(AI_CONFIG_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return base
    if not isinstance(raw, dict):
        return base
    return {
        "apiKey": str(raw.get("apiKey") or "").strip(),
        "model": str(raw.get("model") or AI_DEFAULT_MODEL).strip() or AI_DEFAULT_MODEL,
        "baseUrl": str(raw.get("baseUrl") or AI_DEFAULT_BASE_URL).strip() or AI_DEFAULT_BASE_URL,
    }


def save_ai_config(patch: dict) -> dict:
    """合并写入 data/ai.json；apiKey 未提供时保留旧值（便于只改模型不重填 Key）。返回合并后配置。"""
    current = load_ai_config()
    api_key = patch.get("apiKey", None)
    if api_key is None:
        api_key = current["apiKey"]
    merged = {
        "apiKey": str(api_key or "").strip(),
        "model": str(patch.get("model") or current["model"]).strip() or AI_DEFAULT_MODEL,
        "baseUrl": str(patch.get("baseUrl") or current["baseUrl"]).strip() or AI_DEFAULT_BASE_URL,
    }
    _atomic_write_json(AI_CONFIG_FILE, {"version": 1, **merged})
    return merged


def ai_public_config() -> dict:
    """给前端的安全视图：不回传完整 Key，只报是否已设置 + 末 4 位掩码。"""
    cfg = load_ai_config()
    key = cfg["apiKey"]
    if not key:
        hint = ""
    elif len(key) >= 4:
        hint = "••••" + key[-4:]
    else:
        hint = "已设置"
    return {"hasKey": bool(key), "keyHint": hint, "model": cfg["model"], "baseUrl": cfg["baseUrl"]}


def _ai_unsupported_optional_fields(err: urllib.error.HTTPError, sent_fields: set[str]) -> set[str]:
    """读取一次兼容接口的参数错误，并找出需要在本进程禁用的可选字段。"""
    try:
        raw = err.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        raw = ""
    err._relatum_detail = raw  # type: ignore[attr-defined]
    if err.code not in (400, 422) or not raw:
        return set()
    lowered = raw.lower()
    rejection_words = (
        "unsupported", "not supported", "unknown", "unrecognized",
        "not allowed", "extra inputs", "extra_forbidden", "invalid parameter",
        "unexpected", "not permitted",
    )
    if not any(word in lowered for word in rejection_words):
        return set()
    unsupported = {field for field in sent_fields if field.lower() in lowered}
    # thinking 和 reasoning_effort 是同一组“深度思考”能力；接口若明确拒绝其中一个，
    # 一次兼容重试里应同时剥离二者，避免服务端逐个报未知参数。
    if unsupported.intersection({"thinking", "reasoning_effort"}):
        unsupported.update(sent_fields.intersection({"thinking", "reasoning_effort"}))
    return unsupported


def _ai_request_body(
    messages: list,
    cfg: dict,
    *,
    json_mode: bool,
    thinking: bool,
    max_tokens: int,
    disabled_fields: set[str],
) -> dict:
    body = {
        "model": cfg.get("model") or AI_DEFAULT_MODEL,
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
    }
    if thinking and AI_THINKING_ENABLED and "thinking" not in disabled_fields:
        body["thinking"] = {"type": "enabled"}
    if (
        thinking
        and AI_THINKING_ENABLED
        and AI_REASONING_EFFORT
        and "reasoning_effort" not in disabled_fields
    ):
        body["reasoning_effort"] = AI_REASONING_EFFORT
    if json_mode and "response_format" not in disabled_fields:
        body["response_format"] = {"type": "json_object"}
    return body


def _send_ai_request(url: str, body: dict, cfg: dict, timeout: int) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + (cfg.get("apiKey") or ""))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_ai_chat(
    messages: list,
    cfg: dict,
    timeout: int = AI_REQUEST_TIMEOUT,
    json_mode: bool = False,
    thinking: bool = False,
    max_tokens: int = AI_CHAT_MAX_OUTPUT_TOKENS,
):
    """用标准库 urllib 调用 OpenAI 兼容的 /chat/completions（DeepSeek 兼容）。
    返回 (回复文本, 是否因长度上限被截断)。出错抛异常，由调用方翻译成中文提示。
    - max_tokens：显式给足；不带时各家默认上限偏保守、思考又吃预算，长笔记/多卡片会被悄悄掐断。
    - thinking / reasoning_effort：只用于画布计划等高质量任务，普通聊天不强制开启。
    - json_mode：画布计划等结构化请求使用 response_format=json_object。
    对拒绝上述可选字段的 OpenAI 兼容接口，会剥离服务端明确点名的字段重试一次，
    并在当前进程按接口和模型缓存能力。
    finish_reason == 'length' 说明写到上限被截，回传给上层好提示用户。"""
    base = (cfg.get("baseUrl") or AI_DEFAULT_BASE_URL).rstrip("/")
    url = base + "/chat/completions"
    capability_key = (base.lower(), str(cfg.get("model") or AI_DEFAULT_MODEL))
    with AI_OPTIONAL_CAPABILITY_LOCK:
        disabled = set(AI_OPTIONAL_CAPABILITY_CACHE.get(capability_key, set()))
    body = _ai_request_body(
        messages,
        cfg,
        json_mode=json_mode,
        thinking=thinking,
        max_tokens=max_tokens,
        disabled_fields=disabled,
    )
    sent_optional = AI_OPTIONAL_FIELDS.intersection(body)
    try:
        payload = _send_ai_request(url, body, cfg, timeout)
    except urllib.error.HTTPError as err:
        unsupported = _ai_unsupported_optional_fields(err, sent_optional)
        if not unsupported:
            raise
        with AI_OPTIONAL_CAPABILITY_LOCK:
            cached = AI_OPTIONAL_CAPABILITY_CACHE.setdefault(capability_key, set())
            cached.update(unsupported)
            disabled = set(cached)
        retry_body = _ai_request_body(
            messages,
            cfg,
            json_mode=json_mode,
            thinking=thinking,
            max_tokens=max_tokens,
            disabled_fields=disabled,
        )
        payload = _send_ai_request(url, retry_body, cfg, timeout)
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not choices:
        raise ValueError("AI 没有返回任何内容")
    first = choices[0] if isinstance(choices[0], dict) else {}
    message = first.get("message") if isinstance(first, dict) else None
    content = (message or {}).get("content", "")
    content = content if isinstance(content, str) else str(content)
    truncated = first.get("finish_reason") == "length"
    return content, truncated


# ─── HTTP 处理 ──────────────────────────────────────────────


class RequestBodyError(ValueError):
    """A client request body that can be rejected before API dispatch."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# These routes either do not mutate persisted state or intentionally wait on a
# native picker / external network. Picker-backed mutation routes acquire their
# appropriate lock only after the dialog returns, so an open dialog never stalls
# autosave in another request thread.
POST_WITHOUT_DATA_LOCK = {
    "/api/file-stats",
    "/api/ai-chat",
    "/api/ai-plan",
    "/api/ai-test",
    "/api/pick",
    "/api/import-canvas-file",
    "/api/import-canvas-folder",
    "/api/trash-list",
    "/api/reveal",
    "/api/open-external",
    "/api/open-attachment",
    "/api/export-markdown",
    "/api/export-png",
    "/api/import-markdown",
    "/api/pick-background-image",
    "/api/import-canvas-image",
}

# File lifecycle operations serialize with each other, but not with unrelated
# study/calendar/daily JSON updates. Routes that touch both domains always take
# the canvas lock first to keep one lock order throughout the process.
CANVAS_FILE_POST_ROUTES = {
    "/api/clean-assets",
    "/api/trash-empty",
    "/api/canvas-import-assets",
    "/api/upload-background-image",
    "/api/upload-canvas-image",
    "/api/upload-canvas-attachment",
    "/api/save-canvas-annotation",
    "/api/save-node-annotations",
    "/api/archive-canvas",
}
CANVAS_AND_DATA_POST_ROUTES = {
    "/api/new",
    "/api/recent-sync",
    "/api/save",
    "/api/trash",
    "/api/import-canvas",
    "/api/study-archive-done",
    "/api/taskbook-archive",
    "/api/rename",
    "/api/restore",
}

class Handler(http.server.SimpleHTTPRequestHandler):
    """静态资源 + 几个 JSON API。"""

    # 本地化 PDF.js 等前端资源用到的扩展名，补齐部分旧 Python 缺省的 MIME。
    # （.bcmap / .pfb 走 SimpleHTTPRequestHandler 默认的 octet-stream，二进制读取无碍。）
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ASSETS), **kwargs)

    def log_message(self, format, *args):  # noqa: A002 - stdlib 签名
        msg = format % args
        if "favicon" in msg:
            return
        # PyInstaller --windowed normally exposes sys.stderr as None.  Logging
        # happens inside send_response(), so letting this raise would turn every
        # otherwise valid desktop response into ERR_EMPTY_RESPONSE.
        stream = getattr(sys, "stderr", None)
        if stream is None:
            return
        try:
            stream.write(f"  · {msg}\n")
        except (AttributeError, OSError, ValueError):
            pass

    def log_error(self, format, *args):  # noqa: A002 - stdlib 签名
        # 静默 send_error 的额外噪音（如 favicon 404 会泄出一行
        # "code 404, message File not found"，看着像出错其实无害）。
        # 真正的失败仍会被 log_request 以 "GET xxx 404/500" 记录。
        return

    def end_headers(self):
        # API 走 _send_json 已自带 no-store，这里判重避免重复发头。
        already = any(b"cache-control" in line.lower() for line in self._headers_buffer)
        if not already:
            if getattr(sys, "frozen", False):
                # EXE 模式允许 WebView2 复用缓存，但每次导航都要确认资源是否
                # 更新。这样覆盖升级 release 后不会继续运行旧 JS/CSS。
                self.send_header("Cache-Control", "no-cache")
            else:
                # 开发模式：改了前端立刻见效，不走缓存。
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    # ── JSON 工具 ──
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        raw_length = str(self.headers.get("Content-Length") or "").strip()
        if not raw_length:
            return {}
        if not raw_length.isdigit():
            raise RequestBodyError(400, "Content-Length 无效")
        length = int(raw_length)
        if length <= 0:
            return {}
        if length > MAX_JSON_BODY_BYTES:
            raise RequestBodyError(413, "请求数据过大（上限 160MB）")
        try:
            raw = self.rfile.read(length)
        except (OSError, TimeoutError) as err:
            raise RequestBodyError(400, "请求数据读取失败") from err
        if len(raw) != length:
            raise RequestBodyError(400, "请求数据不完整")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as err:
            raise RequestBodyError(400, "请求不是有效的 JSON") from err
        # 解析前释放原始 bytes；大画布不再同时常驻 bytes、str 和对象树三份。
        del raw
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as err:
            raise RequestBodyError(400, "请求不是有效的 JSON") from err
        del text
        if not isinstance(payload, dict):
            raise RequestBodyError(400, "请求 JSON 顶层必须是对象")
        return payload

    def _send_local_file(
        self,
        target: Path,
        media_type: str,
        error_prefix: str,
        *,
        cache_control: str = "no-store",
    ) -> None:
        """Stream a local asset with single-range support and bounded memory."""
        fh = None
        try:
            fh = target.open("rb")
            stat = os.fstat(fh.fileno())
            size = stat.st_size
        except OSError as err:
            if fh is not None:
                fh.close()
            return self._send_json(500, {"error": f"{error_prefix}：{err}"})

        etag = f'"{stat.st_mtime_ns:x}-{size:x}"'
        range_header = str(self.headers.get("Range") or "").strip()
        if cache_control != "no-store" and not range_header:
            if str(self.headers.get("If-None-Match") or "").strip() == etag:
                fh.close()
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache_control)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        start = 0
        end = max(0, size - 1)
        partial = False
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or (not match.group(1) and not match.group(2)):
                fh.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            try:
                if match.group(1):
                    start = int(match.group(1))
                    end = int(match.group(2)) if match.group(2) else size - 1
                else:
                    suffix = int(match.group(2))
                    if suffix <= 0:
                        raise ValueError
                    start = max(0, size - suffix)
                    end = size - 1
                if start >= size or end < start:
                    raise ValueError
                end = min(end, size - 1)
                partial = True
            except ValueError:
                fh.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        length = (end - start + 1) if size else 0
        try:
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", media_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if cache_control != "no-store":
                self.send_header("ETag", etag)
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", cache_control)
            self.end_headers()
            if length:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(FILE_STREAM_CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionError, OSError):
            # Navigating away or closing a PDF reader may cancel an in-flight
            # range request; it is not a server failure and must not leak a file.
            pass
        finally:
            fh.close()

    # ── 路由 ──
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/runtime":
            return self._send_json(200, {
                "schema": RUNTIME_SCHEMA,
                "root": _norm(ROOT),
                "pid": os.getpid(),
            })
        if parsed.path == "/api/recent":
            return self._api_recent()
        if parsed.path == "/api/ai-config":
            return self._send_json(200, ai_public_config())
        if parsed.path == "/api/study":
            try:
                return self._send_json(200, study_public_payload())
            except ValueError as err:
                return self._send_json(409, {"error": str(err), "incompatible": True})
        if parsed.path == "/api/study-activity":
            q = urllib.parse.parse_qs(parsed.query)
            return self._send_json(200, study_activity_payload(q.get("year", [None])[0]))
        if parsed.path == "/api/review-pool":
            try:
                return self._send_json(200, review_pool_payload())
            except sqlite3.DatabaseError as err:
                return self._send_json(500, {"error": f"读取复习数据库失败：{err}"})
        if parsed.path == "/api/review-cards":
            try:
                return self._send_json(200, review_cards_payload())
            except sqlite3.DatabaseError as err:
                return self._send_json(500, {"error": f"读取复习数据库失败：{err}"})
        if parsed.path == "/api/notes":
            return self._send_json(200, load_notes())
        if parsed.path == "/api/start-sticky-notes":
            return self._send_json(200, load_start_sticky_notes())
        if parsed.path == "/api/focus":
            return self._send_json(200, load_focus())
        if parsed.path == "/api/daily":
            with DAILY_LOCK:
                return self._send_json(200, daily_public_payload())
        if parsed.path == "/api/calendar":
            q = urllib.parse.parse_qs(parsed.query)
            try:
                payload = calendar_payload(
                    q.get("year", [None])[0],
                    q.get("month", [None])[0],
                    q.get("day", [None])[0],
                )
            except ValueError as err:
                return self._send_json(400, {"error": str(err)})
            return self._send_json(200, payload)
        if parsed.path == "/api/countdown":
            return self._send_json(200, load_countdown())
        if parsed.path == "/api/templates":
            return self._send_json(200, load_templates())
        if parsed.path == "/api/canvas-import-library":
            q = urllib.parse.parse_qs(parsed.query)
            try:
                payload = canvas_import_library_payload(q.get("current", [""])[0])
            except OSError as err:
                return self._send_json(500, {"error": f"读取画布库失败：{err}"})
            return self._send_json(200, payload)
        if parsed.path == "/api/canvas-import-source":
            q = urllib.parse.parse_qs(parsed.query)
            try:
                payload = canvas_import_source_payload(q.get("id", [""])[0])
            except CanvasImportLibraryError as err:
                return self._send_json(
                    err.status,
                    {"error": str(err), "code": err.code},
                )
            return self._send_json(200, payload)
        if parsed.path == "/api/canvas-dual-open":
            q = urllib.parse.parse_qs(parsed.query)
            try:
                payload = canvas_dual_open_payload(
                    q.get("id", [""])[0],
                    q.get("current", [""])[0],
                )
            except CanvasImportLibraryError as err:
                return self._send_json(
                    err.status,
                    {"error": str(err), "code": err.code},
                )
            return self._send_json(200, payload)
        if parsed.path == "/api/load":
            q = urllib.parse.parse_qs(parsed.query)
            return self._api_load(q.get("path", [""])[0])
        if parsed.path == "/api/background-image":
            q = urllib.parse.parse_qs(parsed.query)
            return self._api_background_image(q.get("path", [""])[0])
        if parsed.path == "/api/canvas-asset":
            q = urllib.parse.parse_qs(parsed.query)
            return self._api_canvas_asset(q.get("path", [""])[0], q.get("asset", [""])[0])
        if parsed.path == "/api/canvas-annotation":
            q = urllib.parse.parse_qs(parsed.query)
            return self._api_canvas_annotation(q.get("path", [""])[0], q.get("asset", [""])[0])
        if parsed.path == "/api/node-annotations":
            q = urllib.parse.parse_qs(parsed.query)
            return self._api_node_annotations(q.get("path", [""])[0])
        if parsed.path == "/api/background-preference":
            return self._api_background_preference()
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        raw_length = str(self.headers.get("Content-Length") or "").strip()
        large_body = raw_length.isdigit() and int(raw_length) > LARGE_JSON_BODY_BYTES
        self._large_request_body = large_body
        if large_body:
            # Base64 JSON temporarily exists as bytes, decoded text, parsed text
            # and binary content. Admit one large body at a time so concurrent
            # uploads cannot multiply that peak until the process is exhausted.
            with LARGE_JSON_BODY_LOCK:
                return self._handle_POST(path)
        return self._handle_POST(path)

    def _handle_POST(self, path: str):
        try:
            body = self._read_json_body()
        except RequestBodyError as err:
            self.close_connection = True
            return self._send_json(err.status, {"error": str(err)})
        if path in POST_WITHOUT_DATA_LOCK:
            return self._dispatch_POST(path, body)
        with _cross_process_mutation_lock():
            if path in CANVAS_AND_DATA_POST_ROUTES:
                with CANVAS_FILE_MUTATION_LOCK:
                    with DATA_MUTATION_LOCK:
                        return self._dispatch_POST(path, body)
            if path in CANVAS_FILE_POST_ROUTES:
                with CANVAS_FILE_MUTATION_LOCK:
                    return self._dispatch_POST(path, body)
            with DATA_MUTATION_LOCK:
                return self._dispatch_POST(path, body)

    def _dispatch_POST(self, path: str, body: dict):
        if path == "/api/new":
            return self._api_new()
        if path == "/api/recent-sync":
            return self._api_recent_sync(body)
        if path == "/api/study-task-create":
            return self._api_study_task_create(body)
        if path == "/api/study-task-update":
            return self._api_study_task_update(body)
        if path == "/api/study-task-progress":
            return self._api_study_task_progress(body)
        if path == "/api/study-temporary-update":
            return self._api_study_temporary_update(body)
        if path == "/api/study-task-page-note":
            return self._api_study_task_page_note(body)
        if path == "/api/study-task-trash":
            return self._api_study_task_trash(body)
        if path == "/api/study-task-restore":
            return self._api_study_task_restore(body)
        if path == "/api/study-task-delete":
            return self._api_study_task_delete(body)
        if path == "/api/study-trash-empty":
            return self._api_study_trash_empty()
        if path == "/api/study-archive-done":
            return self._api_study_archive_done(body)
        if path == "/api/study-goal-tree-command":
            return self._api_study_goal_tree_command(body)
        if path == "/api/canvas-activity":
            return self._api_canvas_activity(body)
        if path == "/api/archive-canvas":
            return self._api_archive_canvas(body)
        if path == "/api/taskbook-archive":
            return self._api_taskbook_archive(body)
        if path == "/api/study-reorder":
            return self._api_study_reorder(body)
        if path == "/api/review-card-create":
            return self._api_review_card_create(body)
        if path == "/api/review-card-update":
            return self._api_review_card_update(body)
        if path == "/api/review-card-delete":
            return self._api_review_card_delete(body)
        if path == "/api/review-cards-batch":
            return self._api_review_cards_batch(body)
        if path == "/api/review-cards-batch-delete":
            return self._api_review_cards_batch_delete(body)
        if path == "/api/review-deck-create":
            return self._api_review_deck_create(body)
        if path == "/api/review-deck-update":
            return self._api_review_deck_update(body)
        if path == "/api/review-deck-delete":
            return self._api_review_deck_delete(body)
        if path == "/api/review-settings":
            return self._api_review_settings(body)
        if path == "/api/review-mark":
            return self._api_review_mark(body)
        if path == "/api/notes-save":
            return self._api_notes_save(body)
        if path == "/api/start-sticky-notes-save":
            return self._api_start_sticky_notes_save(body)
        if path == "/api/templates-save":
            return self._api_templates_save(body)
        if path == "/api/notes-archive":
            return self._api_notes_archive(body)
        if path == "/api/focus-log":
            return self._api_focus_log(body)
        if path == "/api/focus-session-update":
            return self._api_focus_session_update(body)
        if path == "/api/focus-session-delete":
            return self._api_focus_session_delete(body)
        if path == "/api/daily-create":
            return self._api_daily_mutate(daily_create, body)
        if path == "/api/daily-update":
            return self._api_daily_mutate(daily_update, body)
        if path == "/api/daily-delete":
            return self._api_daily_mutate(daily_delete, body)
        if path == "/api/daily-toggle":
            return self._api_daily_mutate(daily_toggle, body)
        if path == "/api/daily-add-minutes":
            return self._api_daily_mutate(daily_add_minutes, body)
        if path == "/api/daily-reorder":
            return self._api_daily_mutate(daily_reorder, body)
        if path == "/api/daily-group-create":
            return self._api_daily_mutate(daily_group_create, body)
        if path == "/api/daily-group-update":
            return self._api_daily_mutate(daily_group_update, body)
        if path == "/api/daily-group-delete":
            return self._api_daily_mutate(daily_group_delete, body)
        if path == "/api/daily-tree":
            return self._api_daily_mutate(daily_tree_set, body)
        if path == "/api/diary-save":
            try:
                return self._send_json(200, {"diary": save_diary(body)})
            except (ValueError, OSError) as err:
                return self._send_json(400, {"error": str(err)})
        if path == "/api/diary-delete":
            try:
                delete_diary(body.get("date") if isinstance(body, dict) else None)
            except (ValueError, OSError) as err:
                return self._send_json(400, {"error": str(err)})
            return self._send_json(200, {"ok": True})
        if path == "/api/countdown-save":
            try:
                countdown = save_countdown(body)
            except (ValueError, OSError) as err:
                return self._send_json(400, {"error": str(err)})
            return self._send_json(200, {"ok": True, "countdown": countdown})
        if path == "/api/ai-chat":
            return self._api_ai_chat(body)
        if path == "/api/ai-plan":
            return self._api_ai_plan(body)
        if path == "/api/ai-test":
            return self._api_ai_test(body)
        if path == "/api/ai-config":
            return self._api_ai_config(body)
        if path == "/api/open":
            return self._api_open(body)
        if path == "/api/pick":
            return self._api_pick()
        if path == "/api/import-canvas-file":
            return self._api_import_canvas_file(body)
        if path == "/api/import-canvas-folder":
            return self._api_import_canvas_folder(body)
        if path == "/api/save":
            return self._api_save(body)
        if path == "/api/clean-assets":
            return self._api_clean_assets(body)
        if path == "/api/remove":
            return self._api_remove(body)
        if path == "/api/rename":
            return self._api_rename(body)
        if path == "/api/file-stats":
            return self._api_file_stats(body)
        if path == "/api/group-create":
            return self._api_group_create(body)
        if path == "/api/group-rename":
            return self._api_group_rename(body)
        if path == "/api/group-delete":
            return self._api_group_delete(body)
        if path == "/api/file-set-group":
            return self._api_file_set_group(body)
        if path == "/api/favorite-toggle":
            return self._api_favorite_toggle(body)
        if path == "/api/groups-reorder":
            return self._api_groups_reorder(body)
        if path == "/api/reorder-files":
            return self._api_reorder_files(body)
        if path == "/api/trash":
            return self._api_trash(body)
        if path == "/api/trash-list":
            return self._api_trash_list()
        if path == "/api/trash-empty":
            return self._api_trash_empty()
        if path == "/api/restore":
            return self._api_restore(body)
        if path == "/api/reveal":
            return self._api_reveal(body)
        if path == "/api/open-external":
            return self._api_open_external(body)
        if path == "/api/open-attachment":
            return self._api_open_attachment(body)
        if path == "/api/export-markdown":
            return self._api_export_markdown(body)
        if path == "/api/export-png":
            return self._api_export_png(body)
        if path == "/api/import-markdown":
            return self._api_import_markdown()
        if path == "/api/import-canvas":
            return self._api_import_canvas(body)
        if path == "/api/canvas-import-assets":
            return self._api_canvas_import_assets(body)
        if path == "/api/pick-background-image":
            return self._api_pick_background_image()
        if path == "/api/upload-background-image":
            return self._api_upload_background_image(body)
        if path == "/api/import-canvas-image":
            return self._api_import_canvas_image(body)
        if path == "/api/upload-canvas-image":
            return self._api_upload_canvas_image(body)
        if path == "/api/upload-canvas-attachment":
            return self._api_upload_canvas_attachment(body)
        if path == "/api/save-canvas-annotation":
            return self._api_save_canvas_annotation(body)
        if path == "/api/save-node-annotations":
            return self._api_save_node_annotations(body)
        if path == "/api/background-preference":
            return self._api_set_background_preference(body)
        if path == "/api/viewport":
            return self._api_set_viewport(body)
        self._send_json(404, {"error": "未知接口"})

    # ── API 实现 ──
    def _api_recent(self):
        data = load_recent()
        activity = canvas_activity_snapshot()
        totals = _canvas_activity_total_seconds_by_id(activity)
        activity_paths = activity.get("paths", {})
        for item in data.get("files", []):
            if not isinstance(item, dict):
                continue
            canvas_id = str(item.get("id") or "")
            if canvas_id not in totals:
                canvas_id = str(activity_paths.get(_canvas_activity_path_key(item.get("path", ""))) or "")
            item["canvasActivitySec"] = totals.get(canvas_id, 0)
        data["recentLimit"] = RECENT_LIMIT
        self._send_json(200, data)

    def _api_recent_sync(self, body: dict):
        confirm_ids = body.get("confirmRemoveIds") if isinstance(body, dict) else None
        if confirm_ids is not None and (
            not isinstance(confirm_ids, list)
            or not all(isinstance(item, str) for item in confirm_ids)
        ):
            return self._send_json(400, {"error": "confirmRemoveIds 必须是字符串数组"})
        try:
            result = sync_recent_library(confirm_ids)
        except OSError as err:
            return self._send_json(500, {"error": str(err)})
        self._send_json(200, result)

    def _api_file_stats(self, body: dict):
        paths = body.get("paths") if isinstance(body, dict) else None
        if not isinstance(paths, list):
            return self._send_json(400, {"error": "缺少 paths 数组"})
        if len(paths) > RECENT_STATS_BATCH_LIMIT:
            return self._send_json(
                400,
                {"error": f"单次最多统计 {RECENT_STATS_BATCH_LIMIT} 个画布"},
            )
        self._send_json(200, {"files": recent_file_stats(paths)})

    def _api_canvas_activity(self, body: dict):
        try:
            totals = record_canvas_activity_interval(body if isinstance(body, dict) else {})
        except FileNotFoundError as err:
            return self._send_json(404, {"error": str(err)})
        except PermissionError as err:
            return self._send_json(403, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"保存画布时间失败：{err}"})
        self._send_json(200, {"ok": True, **totals})

    def _api_new(self):
        target = make_new_canvas_path()
        payload = empty_canvas_payload()
        try:
            _atomic_write_json(target, payload)
        except OSError as err:
            return self._send_json(500, {"error": f"创建失败：{err}"})
        register_recent(target)
        activity = record_canvas_activity_event(target, "created", payload=payload)
        self._send_json(200, {
            "path": _norm(target),
            "title": target.stem,
            "canvasActivity": activity,
        })

    def _api_import_canvas(self, body: dict):
        """把外部拖入的 .canvas 文件内容复制成 canvases/ 下的新文件，并归到指定分组。

        前端读字节传内容（浏览器/WebView2 拖放都拿不到绝对路径），所以这里只收
        文本内容、自己起名落地，**不会带来源旁边的 .assets 附件**——若画布引用了
        图片/PDF/MD（节点带 assetPath），返回 hasAssets=True 让前端温和提示一句。"""
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        raw = body.pop("content", None)
        if not isinstance(raw, str) or not raw.strip():
            return self._send_json(400, {"error": "画布内容为空"})
        try:
            parsed = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            return self._send_json(400, {"error": "这不是有效的 .canvas 文件（JSON 解析失败）"})
        # 解析后的对象树会继续参与校验和写盘，原始 JSON 字符串已不再需要。
        del raw
        if not isinstance(parsed, dict) or not isinstance(parsed.get("nodes"), list):
            return self._send_json(400, {"error": "这不是有效的 .canvas 文件（缺少 nodes）"})
        raw_name = str(body.get("name") or "").strip()
        if raw_name.lower().endswith(".canvas"):
            raw_name = raw_name[:-len(".canvas")]
        stem = _safe_export_stem(raw_name, "导入画布")
        target = _unused_canvas_path(CANVASES, stem)
        try:
            _atomic_write_json(
                target,
                parsed,
                streaming=bool(getattr(self, "_large_request_body", False)),
            )
        except OSError as err:
            return self._send_json(500, {"error": f"导入失败：{err}"})
        register_recent(target, target.stem)
        activity = record_canvas_activity_event(target, "created", payload=parsed)
        gid = str(body.get("group") or "")
        if gid:
            file_set_group(_norm(target), gid)
        has_assets = any(
            isinstance(n, dict) and n.get("assetPath")
            for n in parsed.get("nodes", [])
        )
        self._send_json(200, {
            "path": _norm(target),
            "title": target.stem,
            "group": gid,
            "hasAssets": has_assets,
            "canvasActivity": activity,
        })

    def _api_canvas_import_assets(self, body: dict):
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        try:
            result = copy_canvas_import_assets(
                body.get("sourceId"),
                body.get("revision"),
                body.get("targetPath"),
                body.get("assets"),
            )
        except CanvasImportLibraryError as err:
            return self._send_json(
                err.status,
                {"error": str(err), "code": err.code},
            )
        return self._send_json(200, {"ok": True, **result})

    # ── AI 助手 ──
    def _api_ai_config(self, body: dict):
        """保存 / 更新 AI 配置（API Key / 模型 / 接口地址），返回不含明文 Key 的安全视图。"""
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        try:
            save_ai_config(body)
        except OSError as err:
            return self._send_json(500, {"error": f"保存 AI 配置失败：{err}"})
        self._send_json(200, ai_public_config())

    def _ai_call(
        self,
        clean: list,
        cfg: dict,
        timeout: int = AI_REQUEST_TIMEOUT,
        json_mode: bool = False,
        thinking: bool = False,
        max_tokens: int = AI_CHAT_MAX_OUTPUT_TOKENS,
    ):
        """调用模型：成功返回 (reply, truncated, None)；失败返回 (None, False, (status, payload))。
        truncated=是否写到长度上限被截断；json_mode=是否请求 JSON；
        thinking 只给画布计划等高质量任务开启，普通聊天不强制深度思考。
        对话与生成两条接口共用，避免错误处理两份各写一遍而走样。"""
        try:
            content, truncated = call_ai_chat(
                clean,
                cfg,
                timeout=timeout,
                json_mode=json_mode,
                thinking=thinking,
                max_tokens=max_tokens,
            )
            return content, truncated, None
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                raw = getattr(err, "_relatum_detail", "") or err.read().decode("utf-8", "replace")
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    detail = ((parsed.get("error") or {}).get("message")) if isinstance(parsed.get("error"), dict) else ""
                detail = detail or raw[:200]
            except Exception:  # noqa: BLE001
                detail = ""
            tip = "（请检查齿轮里的 API Key、模型名是否正确）" if err.code in (401, 403, 404, 422) else ""
            msg = f"AI 服务返回错误 {err.code}{('：' + detail) if detail else ''}{tip}"
            return None, False, (502, {"error": msg})
        except urllib.error.URLError as err:
            return None, False, (502, {"error": f"连接 AI 服务失败：{err.reason}（请检查网络或接口地址）"})
        except (TimeoutError, socket.timeout):
            return None, False, (504, {"error": "AI 请求超时，请稍后重试或缩小画布上下文"})
        except (ValueError, json.JSONDecodeError, KeyError) as err:
            return None, False, (502, {"error": f"AI 返回内容异常：{err}"})
        except Exception as err:  # noqa: BLE001
            return None, False, (500, {"error": f"AI 调用失败：{err}"})

    def _api_ai_chat(self, body: dict):
        """把一段对话转发给已配置的模型，返回回复文本。纯对话，不改任何画布文件。"""
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._send_json(400, {"error": "没有可发送的对话内容"})
        cfg = load_ai_config()
        if not cfg["apiKey"]:
            return self._send_json(400, {"error": "还没有设置 API Key，请点面板右上角的齿轮填写"})
        clean = []
        for item in messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role in ("system", "user", "assistant") and isinstance(content, str) and content.strip():
                clean.append({"role": role, "content": content})
        if not clean:
            return self._send_json(400, {"error": "对话内容无效"})
        # 只保留最近若干条，控制请求体大小。内置聊天前端不发送 system；
        # 此处仍兼容显式调用本地接口的其它客户端。
        if len(clean) > AI_MAX_MESSAGES:
            head = clean[:1] if clean[0]["role"] == "system" else []
            clean = head + clean[len(head) - AI_MAX_MESSAGES:]
        reply, truncated, err = self._ai_call(clean, cfg)
        if err:
            return self._send_json(*err)
        self._send_json(200, {"reply": reply, "truncated": truncated})

    def _api_ai_test(self, body: dict):
        """用一条极短消息验证 API Key / 模型 / 地址是否可用；不写配置、不改画布。"""
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        cfg = load_ai_config()
        if "apiKey" in body:
            cfg["apiKey"] = str(body.get("apiKey") or "").strip()
        if body.get("model"):
            cfg["model"] = str(body.get("model")).strip()
        if body.get("baseUrl"):
            cfg["baseUrl"] = str(body.get("baseUrl")).strip()
        if not cfg["apiKey"]:
            return self._send_json(400, {"error": "还没有设置 API Key，请先填写或保存"})
        probe = [
            {"role": "system", "content": "你是 API 连通性测试助手。只回复 OK。"},
            {"role": "user", "content": "请只回复 OK"},
        ]
        reply, _truncated, err = self._ai_call(probe, cfg, timeout=20)
        if err:
            return self._send_json(*err)
        text = (reply or "").strip()
        self._send_json(200, {"ok": True, "reply": text[:80], "model": cfg["model"], "baseUrl": cfg["baseUrl"]})

    def _api_ai_plan(self, body: dict):
        """生成并校验 V2 画布操作计划；本接口只返回计划，不写任何画布或配置。"""
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确", "code": "PLAN_REQUEST_INVALID"})
        action = str(body.get("action") or "").strip()
        if action not in PLAN_ACTIONS:
            return self._send_json(400, {"error": "不支持的 AI 操作", "code": "PLAN_ACTION_INVALID"})
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._send_json(400, {"error": "没有可发送的对话内容", "code": "PLAN_MESSAGES_INVALID"})
        cfg = load_ai_config()
        if not cfg["apiKey"]:
            return self._send_json(400, {
                "error": "还没有设置 API Key，请点面板右上角的齿轮填写",
                "code": "AI_KEY_MISSING",
            })

        convo = []
        for item in messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                convo.append({"role": role, "content": content})
        if not convo:
            return self._send_json(400, {"error": "对话内容无效", "code": "PLAN_MESSAGES_INVALID"})
        # 为修复回合预留 assistant + user 两条消息。
        if len(convo) > AI_MAX_MESSAGES - 3:
            convo = convo[-(AI_MAX_MESSAGES - 3):]

        canvas_ctx = body.get("canvas") if isinstance(body.get("canvas"), dict) else {}
        editor_ctx = body.get("editor") if isinstance(body.get("editor"), dict) else {}
        language = body.get("language") or editor_ctx.get("language")
        language = "en" if language == "en" else "zh-CN"
        editor_ctx = {**editor_ctx, "language": language}
        try:
            system = build_plan_system(action, language, canvas_ctx, editor_ctx)
        except AIPlanError as plan_err:
            return self._send_json(400, {"error": plan_err.message, **plan_err.as_payload()})

        clean = [{"role": "system", "content": system}] + convo
        reply, truncated, err = self._ai_call(
            clean,
            cfg,
            json_mode=True,
            thinking=True,
            max_tokens=AI_MAX_OUTPUT_TOKENS,
        )
        if err:
            return self._send_json(*err)
        try:
            if truncated:
                raise AIPlanError("PLAN_TRUNCATED", "AI 计划写到输出上限，结构可能不完整")
            plan = parse_plan(reply, action, canvas_ctx, editor_ctx)
        except AIPlanError as first_error:
            repair_clean = clean + [
                {"role": "assistant", "content": reply or ""},
                {"role": "user", "content": build_repair_instruction(first_error)},
            ]
            repaired_reply, repaired_truncated, repair_err = self._ai_call(
                repair_clean,
                cfg,
                json_mode=True,
                thinking=True,
                max_tokens=AI_MAX_OUTPUT_TOKENS,
            )
            if repair_err:
                status, payload = repair_err
                return self._send_json(status, {**payload, "repairAttempted": True})
            try:
                if repaired_truncated:
                    raise AIPlanError("PLAN_TRUNCATED", "修复后的 AI 计划仍被输出上限截断")
                plan = parse_plan(repaired_reply, action, canvas_ctx, editor_ctx)
            except AIPlanError as final_error:
                payload = final_error.as_payload()
                return self._send_json(502, {
                    "error": f"AI 未能生成可安全应用的计划：{final_error.message}",
                    **payload,
                    "repairAttempted": True,
                    "initialError": first_error.code,
                })
            return self._send_json(200, {
                "ok": True,
                "plan": plan,
                "truncated": False,
                "repaired": True,
            })

        self._send_json(200, {
            "ok": True,
            "plan": plan,
            "truncated": False,
            "repaired": False,
        })

    # ── 内置学习页 ──
    def _api_study_task_page_note(self, body: dict):
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        try:
            task_page = _study_task_page(body.get("taskPage"), strict=True)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        note = body.get("note")
        if not isinstance(note, str):
            return self._send_json(400, {"error": "学习任务页说明需要是文字"})
        data = load_study()
        notes = _study_task_page_notes(data.get("taskPageNotes"), strict=True)
        clean = note.strip()[:240]
        if clean:
            notes[str(task_page)] = clean
        else:
            notes.pop(str(task_page), None)
        data["taskPageNotes"] = notes
        try:
            save_study(data)
        except OSError as err:
            return self._send_json(500, {"error": f"保存学习任务页说明失败：{err}"})
        self._send_json(200, {"ok": True, "taskPage": task_page, "note": clean})

    def _api_study_temporary_update(self, body: dict):
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        task_id = str(body.get("id") or "").strip()
        included = body.get("included")
        if not task_id:
            return self._send_json(400, {"error": "缺少 id"})
        if not isinstance(included, bool):
            return self._send_json(400, {"error": "included 必须是布尔值"})

        data = load_study()
        ids = _study_temporary_task_ids(data.get("temporaryTaskIds"), data.get("tasks", []))
        if included:
            try:
                _index, task = study_find_task(data, task_id)
            except KeyError as err:
                return self._send_json(404, {"error": str(err)})
            if task.get("status") != "active":
                return self._send_json(409, {"error": "只有未完成任务可以加入临时任务"})
            if task_id not in ids:
                ids.append(task_id)
        else:
            ids = [item for item in ids if item != task_id]
        data["temporaryTaskIds"] = ids
        try:
            save_study(data)
        except OSError as err:
            return self._send_json(500, {"error": f"保存临时任务失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "temporaryTaskIds": data["temporaryTaskIds"],
        })

    def _api_study_task_create(self, body: dict):
        data = load_study()
        try:
            source = body if isinstance(body, dict) else {}
            task = _study_task({
                "title": source.get("title"),
                "taskPage": source.get("taskPage"),
            })
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        data["tasks"].append(task)
        save_study(data)
        self._send_json(200, {
            "task": task,
            "goalTrees": data.get("goalTrees"),
            "activeTreeId": data.get("activeTreeId"),
        })

    def _api_study_task_update(self, body: dict):
        task_id = (body.get("id") or "").strip()
        if not task_id:
            return self._send_json(400, {"error": "缺少 id"})
        data = load_study()
        try:
            index, old = study_find_task(data, task_id)
            patch = {
                key: body[key] for key in ("title", "status", "progress") if key in body
            }
            route_tree_id = str(body.get("goalTreeId") or "").strip()
            locks_route_action = "progress" in patch or (
                patch.get("status") == "done" and old.get("status") != "done"
            )
            if route_tree_id and locks_route_action:
                _study_goal_assert_task_available(data, route_tree_id, task_id)
            task = _study_task(patch, existing=old)
            if isinstance(body.get("progress"), dict) and "current" in body["progress"]:
                task["progress"] = _study_progress(
                    body["progress"], old.get("progress"), strict=True, allow_current=True
                )
            data["tasks"][index] = task
            save_study(data)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            message = str(err)
            if message == "前置任务点不存在" and isinstance(body.get("progress"), dict):
                message = "任务点仍被目标树引用；请先移除对应的解锁条件"
            return self._send_json(400, {"error": message})
        except RuntimeError as err:
            return self._send_json(409, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"保存学习任务失败：{err}"})
        self._send_json(200, {
            "task": task,
            "goalTrees": data.get("goalTrees"),
            "activeTreeId": data.get("activeTreeId"),
        })

    def _api_study_task_progress(self, body: dict):
        task_id = str(body.get("id") or "").strip() if isinstance(body, dict) else ""
        delta = body.get("delta") if isinstance(body, dict) else None
        route_tree_id = str(body.get("goalTreeId") or "").strip() if isinstance(body, dict) else ""
        data = load_study()
        try:
            _study_goal_assert_task_available(data, route_tree_id, task_id)
            result = change_study_progress(data, task_id, delta)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except RuntimeError as err:
            return self._send_json(409, {"error": str(err)})
        save_study(data)
        result["goalTrees"] = data.get("goalTrees")
        result["activeTreeId"] = data.get("activeTreeId")
        self._send_json(200, result)

    def _api_study_task_trash(self, body: dict):
        task_id = (body.get("id") or "").strip()
        data = load_study()
        try:
            index, task = study_find_task(data, task_id)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        data["tasks"].pop(index)
        entry = {"task": task, "deletedAt": _study_now()}
        _study_goal_detach_task(data, task_id)
        data["trash"].insert(0, entry)
        data["trash"] = data["trash"][:STUDY_TRASH_MAX]
        save_study(data)
        self._send_json(200, {"ok": True, "study": study_public_payload()})

    def _api_study_task_restore(self, body: dict):
        task_id = (body.get("id") or "").strip()
        data = load_study()
        for index, entry in enumerate(data["trash"]):
            task = entry.get("task", {})
            if task.get("id") == task_id:
                data["trash"].pop(index)
                data["tasks"].append(task)
                save_study(data)
                return self._send_json(200, {"task": task, "study": study_public_payload()})
        self._send_json(404, {"error": "回收站里没有这个任务"})

    def _api_study_task_delete(self, body: dict):
        task_id = (body.get("id") or "").strip()
        data = load_study()
        before = len(data["trash"])
        data["trash"] = [
            entry for entry in data["trash"]
            if entry.get("task", {}).get("id") != task_id
        ]
        if len(data["trash"]) == before:
            return self._send_json(404, {"error": "回收站里没有这个任务"})
        save_study(data)
        self._send_json(200, {"ok": True})

    def _api_study_trash_empty(self):
        data = load_study()
        data["trash"] = []
        save_study(data)
        self._send_json(200, {"ok": True})

    def _api_study_archive_done(self, body: dict | None = None):
        data = load_study()
        try:
            task_page = _study_task_page(
                body.get("taskPage") if isinstance(body, dict) else None,
                strict=True,
            )
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        completed = [
            task for task in data["tasks"]
            if task.get("status") == "done" and task.get("taskPage", 1) == task_page
        ]
        if not completed:
            return self._send_json(400, {"error": "已完成这一列还是空的"})
        folder = _study_archive_folder(len(completed))
        archive_file = folder / "tasks.json"
        try:
            _atomic_write_json(archive_file, {
                "version": 2,
                "kind": "study",
                "archivedAt": _study_now(),
                "count": len(completed),
                "tasks": completed,
            })
            completed_ids = {
                str(task.get("id") or "") for task in completed
                if str(task.get("id") or "")
            }
            _study_goal_snapshot_tasks(
                data, completed, archived_at=str(_study_now()),
            )
            data["tasks"] = [task for task in data["tasks"] if task.get("id") not in completed_ids]
            save_study(data)
        except OSError as err:
            # 归档 marker 与 study.json 是两个文件，后一步失败时撤销前一步，
            # 避免任务仍在列表里但活跃页已经把同一任务计入归档。
            try:
                archive_file.unlink(missing_ok=True)
                folder.rmdir()
            except OSError:
                pass
            return self._send_json(500, {"error": f"归档失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "count": len(completed),
            "folder": folder.name,
            "archivedIds": [task.get("id") for task in completed],
            "study": study_public_payload(),
        })

    def _api_study_goal_tree_command(self, body: dict):
        data = load_study()
        try:
            result = apply_study_goal_tree_command(data, body)
            save_study(data)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"保存目标树失败：{err}"})
        self._send_json(200, {
            "ok": True,
            **result,
            "goalTrees": data.get("goalTrees"),
            "activeTreeId": data.get("activeTreeId"),
        })

    def _api_taskbook_archive(self, body: dict):
        """归档一个已完成顶级任务，并用稳定 archiveId 保证重复请求幂等。"""
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求格式不正确"})
        raw_path = str(body.get("path") or "").strip()
        root_id = str(body.get("rootId") or "").strip()
        archive_id = str(body.get("archiveId") or "").strip()
        retain_snapshot = bool(body.get("retainSnapshot"))
        snapshot_root_node_id = str(body.get("snapshotRootNodeId") or "").strip()
        transformed = body.get("data")
        if not raw_path:
            return self._send_json(400, {"error": "缺少 path"})
        if not root_id or len(root_id) > 160:
            return self._send_json(400, {"error": "顶级任务标识无效"})
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,160}", archive_id):
            return self._send_json(400, {"error": "归档标识无效"})
        if not isinstance(transformed, dict):
            return self._send_json(400, {"error": "缺少归档后的画布快照"})
        src = Path(raw_path)
        if not src.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(src):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            result = archive_taskbook_canvas(
                src,
                root_id=root_id,
                archive_id=archive_id,
                retain_snapshot=retain_snapshot,
                snapshot_root_node_id=snapshot_root_node_id,
                transformed_canvas=transformed,
            )
        except ValueError as err:
            return self._send_json(409, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"归档失败：{err}"})
        if not result.get("idempotent"):
            try:
                _prune_node_annotations(src, set(result.get("removedNodeIds") or []))
            except OSError:
                pass
        self._send_json(200, {"ok": True, **result})

    def _api_archive_canvas(self, body: dict):
        """编辑器顶栏「归档」：只归档已划删除线的正文节点。

        归档记录落在 data/画布归档/<日期>+<N>个节点/canvas.json；当前画布保留，
        只移除被归档节点以及所有碰到这些节点的连线。索引/装饰/附件节点不归档。
        归档文件只保留活跃页需要的轻量标题/类型统计，不保存完整节点正文。
        """
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        src = Path(raw)
        if not src.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(src):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            return self._send_json(500, {"error": f"读取画布失败：{err}"})
        # 只统计“完成态”的正文节点：划了删除线，且属于可归档正文类型。
        # 旧 kind:"text" 视作 index；索引、装饰、附件节点都不计入。
        # 同时按文档顺序收集每个计入节点的标题——活跃页把「每个节点」当一件完成的事。
        counts = {k: 0 for k in ("preview", "card", "sticky", "code")}
        archived_nodes = []
        archived_ids = set()
        managed_task_ids = _taskbook_managed_node_ids(data)
        protected_skipped = 0
        for node in (data.get("nodes") or []):
            if not isinstance(node, dict):
                continue
            if not node.get("strike"):       # 没划删除线 → 留在当前画布
                continue
            if str(node.get("id") or "") in managed_task_ids:
                protected_skipped += 1
                continue
            kind = node.get("kind")
            if kind == "text":
                kind = "index"
            if kind in counts:               # 索引不在 counts 里，自然排除
                counts[kind] += 1
                node_id = str(node.get("id") or "")
                if node_id:
                    archived_ids.add(node_id)
                archived_nodes.append({
                    "title": str(node.get("text") or "").strip(),
                    "kind": kind,
                })
        total = sum(counts.values())
        if total <= 0:
            return self._send_json(400, {"error": "没有可归档的划线节点"})

        remaining_nodes = []
        for node in (data.get("nodes") or []):
            if isinstance(node, dict) and str(node.get("id") or "") in archived_ids:
                continue
            remaining_nodes.append(node)

        archived_edges = []
        remaining_edges = []
        for edge in (data.get("edges") or []):
            if not isinstance(edge, dict):
                remaining_edges.append(edge)
                continue
            if str(edge.get("from") or "") in archived_ids or str(edge.get("to") or "") in archived_ids:
                archived_edges.append(dict(edge))
            else:
                remaining_edges.append(edge)

        name = (body.get("name") or "").strip() or src.stem
        folder = _canvas_archive_folder(total)
        archive_file = folder / "canvas.json"
        try:
            _atomic_write_json(archive_file, {
                "version": 1,
                "archivedAt": _study_now(),
                "name": name,
                "count": total,
                "nodeCounts": counts,
                "nodes": archived_nodes,
                "from": _norm(src),
                "mode": "struck-nodes",
            })
            data["nodes"] = remaining_nodes
            data["edges"] = remaining_edges
            data["updatedAt"] = datetime.now().replace(microsecond=0).isoformat()
            _atomic_write_json(src, data)
        except OSError as err:
            return self._send_json(500, {"error": f"归档失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "name": name,
            "count": total,
            "folder": folder.name,
            "removedNodeIds": sorted(archived_ids),
            "removedEdges": len(archived_edges),
            "remainingNodes": len(remaining_nodes),
            "protectedSkipped": protected_skipped,
        })

    def _api_study_reorder(self, body: dict):
        """Reorder one task page without disturbing any other page."""
        ids = body.get("ids")
        if not isinstance(ids, list):
            return self._send_json(400, {"error": "缺少 ids 数组"})
        try:
            task_page = _study_task_page(body.get("taskPage"), strict=True)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        data = load_study()
        tasks = data.get("tasks", [])
        page_tasks = [task for task in tasks if task.get("taskPage", 1) == task_page]
        by_id = {task.get("id"): task for task in page_tasks}
        seen = set()
        ordered_page = []
        for tid in ids:
            if tid in by_id and tid not in seen:
                ordered_page.append(by_id[tid])
                seen.add(tid)
        for task in page_tasks:
            if task.get("id") not in seen:
                ordered_page.append(task)
        page_iter = iter(ordered_page)
        new_list = [
            next(page_iter) if task.get("taskPage", 1) == task_page else task
            for task in tasks
        ]
        data["tasks"] = new_list
        save_study(data)
        self._send_json(200, {"ok": True})

    def _api_review_card_create(self, body: dict):
        try:
            card = create_review_card(body)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"保存复习卡片失败：{err}"})
        self._send_json(200, {"ok": True, "card": card})

    def _api_review_card_update(self, body: dict):
        try:
            card = update_review_card(body)
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"更新复习卡片失败：{err}"})
        self._send_json(200, {"ok": True, "card": card})

    def _api_review_card_delete(self, body: dict):
        try:
            delete_review_card(body.get("id"))
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"删除复习卡片失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_review_cards_batch(self, body: dict):
        try:
            count = batch_update_review_cards(body)
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"批量更新卡片失败：{err}"})
        self._send_json(200, {"ok": True, "count": count})

    def _api_review_cards_batch_delete(self, body: dict):
        try:
            count = batch_delete_review_cards(body)
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"批量删除卡片失败：{err}"})
        self._send_json(200, {"ok": True, "count": count})

    def _api_review_deck_create(self, body: dict):
        try:
            deck = create_review_deck(body)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"创建卡组失败：{err}"})
        self._send_json(200, {"ok": True, "deck": deck})

    def _api_review_deck_update(self, body: dict):
        try:
            deck = update_review_deck(body)
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"更新卡组失败：{err}"})
        self._send_json(200, {"ok": True, "deck": deck})

    def _api_review_deck_delete(self, body: dict):
        try:
            delete_review_deck(body.get("id"))
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"删除卡组失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_review_settings(self, body: dict):
        try:
            settings = update_review_settings(body)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"保存复习设置失败：{err}"})
        self._send_json(200, {"ok": True, "settings": settings})

    def _api_review_mark(self, body: dict):
        try:
            card = mark_review_card(body.get("cardId") or body.get("id"), body.get("rating"))
        except LookupError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except sqlite3.DatabaseError as err:
            return self._send_json(500, {"error": f"记录复习结果失败：{err}"})
        self._send_json(200, {"ok": True, "card": card})

    def _api_focus_log(self, body: dict):
        """落一条专注记录：前端每完成一段专注时调用，追加写入 data/focus.json。"""
        try:
            data = append_focus_session(body)
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"保存失败：{err}"})
        self._send_json(200, {"ok": True, "count": len(data["sessions"])})

    def _api_focus_session_update(self, body: dict):
        try:
            session = update_focus_session(body)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except (ValueError, OSError) as err:
            return self._send_json(400, {"error": str(err)})
        self._send_json(200, {"ok": True, "session": session})

    def _api_focus_session_delete(self, body: dict):
        try:
            removed = delete_focus_session(body.get("id") if isinstance(body, dict) else None)
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except (ValueError, OSError) as err:
            return self._send_json(400, {"error": str(err)})
        self._send_json(200, {"ok": True, "session": removed})

    def _api_daily_mutate(self, fn, body: dict):
        """每日任务的增删改 / 勾选 / 累计分钟 / 重排统一入口：成功都回当前清单的安全视图。"""
        try:
            with DAILY_LOCK:
                payload = fn(body if isinstance(body, dict) else {})
        except KeyError as err:
            return self._send_json(404, {"error": str(err)})
        except ValueError as err:
            return self._send_json(400, {"error": str(err)})
        except OSError as err:
            return self._send_json(500, {"error": f"保存失败：{err}"})
        self._send_json(200, {"ok": True, "daily": payload})

    def _api_notes_save(self, body: dict):
        """整墙覆盖保存便签：前端持有完整列表，整体写回（已在 save_notes 里清洗）。"""
        if not isinstance(body, dict) or not isinstance(body.get("notes"), list):
            return self._send_json(400, {"error": "缺少 notes 数组"})
        try:
            result = save_notes(body)
        except OSError as err:
            return self._send_json(500, {"error": f"保存失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "count": len(result["notes"]),
            "edgeCount": len(result["edges"]),
            "arrowCount": len(result["arrows"]),
        })

    def _api_start_sticky_notes_save(self, body: dict):
        """覆盖保存起步页跨页便签；数据与速记墙、画布和学习任务完全隔离。"""
        if not isinstance(body, dict) or not isinstance(body.get("notes"), list):
            return self._send_json(400, {"error": "缺少 notes 数组"})
        try:
            result = save_start_sticky_notes(body)
        except OSError as err:
            return self._send_json(500, {"error": f"保存失败：{err}"})
        self._send_json(200, {"ok": True, "count": len(result["notes"])})

    def _api_templates_save(self, body: dict):
        """整库覆盖保存模板：前端持有完整列表，整体写回（save_templates 里已清洗）。
        新增 / 删除模板都走这里——删除即从数组里去掉那一项后整体写回，无伴生文件、无孤儿。"""
        if not isinstance(body, dict) or not isinstance(body.get("templates"), list):
            return self._send_json(400, {"error": "缺少 templates 数组"})
        if len(body["templates"]) > TEMPLATES_MAX:
            return self._send_json(400, {"error": f"模板最多保存 {TEMPLATES_MAX} 个"})
        for item in body["templates"]:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("nodes"), list) and len(item["nodes"]) > TEMPLATE_NODES_MAX:
                return self._send_json(400, {
                    "error": f"单个模板最多包含 {TEMPLATE_NODES_MAX} 个元素"
                })
            if isinstance(item.get("edges"), list) and len(item["edges"]) > TEMPLATE_EDGES_MAX:
                return self._send_json(400, {
                    "error": f"单个模板最多包含 {TEMPLATE_EDGES_MAX} 条连线"
                })
        try:
            result = save_templates(body)
        except OSError as err:
            return self._send_json(500, {"error": f"保存失败：{err}"})
        self._send_json(200, {"ok": True, "count": len(result["templates"])})

    def _api_notes_archive(self, body: dict):
        """长按速记图标归档整墙：前端传当前整墙便签，后端把**有名字**的便签写进
        data/学习归档/<日期>+<N>条速记/notes.json（计入活跃统计），无名便签丢弃不归档；
        随后整墙清空（notes.json 写空）。有名便签为 0 时不建文件夹，仅清空墙面。"""
        if not isinstance(body, dict) or not isinstance(body.get("notes"), list):
            return self._send_json(400, {"error": "缺少 notes 数组"})
        named = []
        for item in body["notes"]:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue                      # 无名便签：不归档（下方整墙清空会把它一并清掉）
            named.append({
                "text": text,
                "color": str(item.get("color") or ""),
                "createdAt": str(item.get("createdAt") or ""),
            })
        folder_name = None
        try:
            if named:
                folder = _notes_archive_folder(len(named))
                _atomic_write_json(folder / "notes.json", {
                    "version": 1,
                    "archivedAt": _study_now(),
                    "count": len(named),
                    "notes": named,
                })
                folder_name = folder.name
            save_notes({"notes": [], "edges": [], "arrows": []})         # 整墙清空（有名已归档、无名直接丢弃）
        except OSError as err:
            return self._send_json(500, {"error": f"归档失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "count": len(named),
            "folder": folder_name,
        })

    def _api_open(self, body: dict):
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        target = Path(raw)
        if not target.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        register_recent(target)
        self._send_json(200, {
            "path": _norm(target),
            "title": target.stem,
        })

    def _api_pick(self):
        picked = pick_canvas_file()
        if not picked:
            return self._send_json(200, {"cancelled": True})
        target = Path(picked)
        if not target.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        register_recent(target)
        self._send_json(200, {
            "path": _norm(target),
            "title": target.stem,
        })

    def _api_import_canvas_file(self, body: dict):
        """选择外部 .canvas，复制成 canvases/ 下的受管副本。"""
        try:
            picked = pick_canvas_import_file()
        except OSError as err:
            return self._send_json(500, {"error": f"导入失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        try:
            plan = _prepare_external_canvas(Path(picked), strict=False)
            result = import_external_canvas_copies([plan], group=body.get("group"))
        except ExternalCanvasImportError as err:
            return self._send_json(err.status, {"error": str(err), "code": err.code})
        item = result["items"][0]
        return self._send_json(200, {
            "ok": True,
            "path": item["path"],
            "title": item["title"],
            "group": result["group"],
            "assetsCopied": result["assetCount"] > 0,
            "assetCount": result["assetCount"],
            "missingAssetCount": item["missingAssetCount"],
            "renamed": item["renamed"],
            "canvasActivity": item["canvasActivity"],
        })

    def _api_import_canvas_folder(self, body: dict):
        """严格预检外部画布目录，通过后全有或全无地导入。"""
        try:
            picked = pick_canvas_import_folder()
        except OSError as err:
            return self._send_json(500, {"error": f"导入失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        source_folder = Path(picked)
        try:
            plans, signature = _scan_external_canvas_folder(source_folder)
            result = import_external_canvas_copies(
                plans,
                group=body.get("group"),
                folder_source=source_folder,
                folder_signature=signature,
            )
        except ExternalCanvasImportError as err:
            return self._send_json(err.status, {"error": str(err), "code": err.code})
        return self._send_json(200, result)

    def _api_load(self, raw_path: str):
        if not raw_path:
            return self._send_json(400, {"error": "缺少 path"})
        target = Path(raw_path)
        if not target.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(target):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            data = json.loads(target.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
            return self._send_json(500, {"error": f"读取失败：{err}"})
        # 回收站页允许打开已删除画布查看，但不能因此重新混入“最近”。
        if not is_in_trash(target):
            register_recent(target)
        try:
            activity = canvas_activity_register_path(target, data)
        except OSError:
            activity = {"canvasId": "", "todaySec": 0, "totalSec": 0}
        self._send_json(200, {
            "path": _norm(target),
            "title": target.stem,
            "data": data,
            "viewport": load_viewport_state(target),
            "canvasActivity": activity,
        })

    def _api_save(self, body: dict):
        raw = (body.get("path") or "").strip()
        payload = body.get("data")
        if not raw or not isinstance(payload, dict):
            return self._send_json(400, {"error": "缺少 path 或 data"})
        target = Path(raw)
        if not is_authorized(target):
            return self._send_json(403, {"error": "路径未授权写入"})
        payload["updatedAt"] = datetime.now().replace(microsecond=0).isoformat()
        try:
            _atomic_write_json(
                target,
                payload,
                streaming=bool(getattr(self, "_large_request_body", False)),
            )
        except OSError as err:
            return self._send_json(500, {"error": f"写入失败：{err}"})
        try:
            activity = record_canvas_activity_event(target, "modified", payload=payload)
        except OSError:
            activity = {"canvasId": "", "todaySec": 0, "totalSec": 0}
        orphan_count = 0
        orphan_annotation_count = 0
        try:
            assets_dir = canvas_assets_root(target)
            if assets_dir.exists():
                active_assets, active_node_ids = _canvas_references(payload)
                for p in assets_dir.rglob("*"):
                    if p.is_file():
                        rel_path = p.relative_to(assets_dir).as_posix()
                        if rel_path not in active_assets:
                            orphan_count += 1
                annotation_file = assets_dir / "node-annotations.json"
                if annotation_file.is_file():
                    annotation_data = json.loads(annotation_file.read_text(encoding="utf-8"))
                    annotation_nodes = annotation_data.get("nodes") if isinstance(annotation_data, dict) else None
                    if isinstance(annotation_nodes, dict):
                        orphan_annotation_count = sum(
                            1 for node_id in annotation_nodes if node_id not in active_node_ids
                        )
        except Exception:
            pass

        orphan_count += orphan_annotation_count

        self._send_json(200, {
            "ok": True,
            "path": _norm(target),
            "savedAt": payload["updatedAt"],
            "orphanCount": orphan_count,
            "orphanAnnotationCount": orphan_annotation_count,
            "canvasActivity": activity,
        })

    def _api_clean_assets(self, body: dict):
        """删除当前画布 .assets 内未被任何节点引用的孤儿文件（图片 / 附件 / 其伴生批注）。
        判定口径与 _api_save 的孤儿统计一致；只在该画布 .assets 目录内操作，绝不外溢。
        前端会先 /api/save 落盘，故这里以磁盘上的画布为准。"""
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        target = Path(raw)
        if not is_authorized(target):
            return self._send_json(403, {"error": "路径未授权"})
        assets_dir = canvas_assets_root(target)
        if not assets_dir.exists():
            return self._send_json(200, {"ok": True, "removed": 0, "freed": 0})
        # 仍在使用的资源集合（与 _api_save 同口径：assetPath 及其 .annot.json，外加正文批注主文件）
        try:
            data = json.loads(target.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
            return self._send_json(500, {"error": f"读取画布失败，已取消清理：{err}"})
        active_assets, active_node_ids = _canvas_references(data)
        removed = 0
        freed = 0
        pruned_annotations = 0
        annotation_file = assets_dir / "node-annotations.json"
        if annotation_file.is_file():
            try:
                annotation_data = json.loads(annotation_file.read_text(encoding="utf-8"))
                annotation_nodes = annotation_data.get("nodes") if isinstance(annotation_data, dict) else None
                if isinstance(annotation_nodes, dict):
                    kept_nodes = {
                        node_id: value
                        for node_id, value in annotation_nodes.items()
                        if node_id in active_node_ids
                    }
                    pruned_annotations = len(annotation_nodes) - len(kept_nodes)
                    if pruned_annotations:
                        annotation_data["nodes"] = kept_nodes
                        _atomic_write_json(annotation_file, annotation_data)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                # 批注文件损坏时保持原样，绝不借清理动作扩大数据损失。
                pruned_annotations = 0
        # 先删文件
        for p in assets_dir.rglob("*"):
            if p.is_file():
                rel = p.relative_to(assets_dir).as_posix()
                if rel not in active_assets:
                    try:
                        size = p.stat().st_size
                        p.unlink()
                        removed += 1
                        freed += size
                    except OSError:
                        pass
        # 再把清空后的空子目录收掉（images/ attachments/ 等），从最深层往上删
        for d in sorted([x for x in assets_dir.rglob("*") if x.is_dir()],
                        key=lambda x: len(x.parts), reverse=True):
            try:
                if not any(d.iterdir()):
                    d.rmdir()
            except OSError:
                pass
        return self._send_json(200, {
            "ok": True,
            "removed": removed,
            "freed": freed,
            "prunedAnnotations": pruned_annotations,
        })

    def _api_remove(self, body: dict):
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        remove_from_recent(raw)
        self._send_json(200, {"ok": True})

    def _api_rename(self, body: dict):
        """重命名一个 .canvas 文件（同目录改名）+ 同步 recent。

        new_name 是不含扩展名的纯文件名；后端补 .canvas。
        校验：源文件存在 + 已授权；新名非空、无非法字符、不是 . / ..；
        目标不得已存在（避免覆盖）。重命名在同目录内做，所以目标天然继承源的授权。
        """
        raw = (body.get("path") or "").strip()
        new_name = (body.get("newName") or "").strip()
        if not raw or not new_name:
            return self._send_json(400, {"error": "缺少 path 或 newName"})
        src = Path(raw)
        if not src.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(src):
            return self._send_json(403, {"error": "路径未授权"})
        # 用户在输入框看到的是不含扩展名的名字；容错去掉可能手动带上的 .canvas
        if new_name.lower().endswith(".canvas"):
            new_name = new_name[: -len(".canvas")].strip()
        # 只取文件名本身，挡掉路径分隔与 Windows 非法字符
        if new_name in ("", ".", "..") or any(c in new_name for c in '\\/:*?"<>|'):
            return self._send_json(400, {"error": '文件名不能为空或含 \\ / : * ? " < > |'})
        dst = src.with_name(new_name + ".canvas")
        if _norm(dst) == _norm(src):
            # 名字没变：直接当成功返回，不动磁盘
            return self._send_json(200, {"path": _norm(src), "title": src.stem})
        if dst.exists():
            # 分组只是标签，所有画布都在同一个 canvases/ 目录 → 跨分组也会重名。
            # 给出友好提示：那个重名画布叫什么、在哪个分组。
            grp = group_name_of_path(dst)
            where = f"（在「{grp}」分组里）" if grp else ""
            return self._send_json(
                409,
                {"error": f"已经有一个叫「{new_name}」的画布了{where}，换个名字吧"},
            )
        try:
            move_canvas_with_assets(src, dst)
        except OSError as err:
            return self._send_json(500, {"error": f"重命名失败：{err}"})
        rename_in_recent(src, dst)
        move_viewport_state(src, dst)
        rewrite_taskbook_focus_canvas_path(src, dst)
        move_canvas_activity_path(src, dst)
        self._send_json(200, {"path": _norm(dst), "title": dst.stem})

    # ── 分组（阶段 3a）──
    def _api_group_create(self, body: dict):
        name = (body.get("name") or "").strip()
        if not name:
            return self._send_json(400, {"error": "分组名不能为空"})
        if len(name) > 40:
            return self._send_json(400, {"error": "分组名过长（≤40 字）"})
        try:
            group = group_create(name)
        except ValueError as err:
            return self._send_json(409, {"error": str(err)})
        self._send_json(200, group)

    def _api_group_rename(self, body: dict):
        gid = (body.get("id") or "").strip()
        name = (body.get("name") or "").strip()
        if not gid or not name:
            return self._send_json(400, {"error": "缺少 id 或 name"})
        if len(name) > 40:
            return self._send_json(400, {"error": "分组名过长（≤40 字）"})
        try:
            renamed = group_rename(gid, name)
        except ValueError as err:
            return self._send_json(409, {"error": str(err)})
        if not renamed:
            return self._send_json(404, {"error": "分组不存在"})
        self._send_json(200, {"ok": True, "id": gid, "name": name})

    def _api_group_delete(self, body: dict):
        gid = (body.get("id") or "").strip()
        if not gid:
            return self._send_json(400, {"error": "缺少 id"})
        if not group_delete(gid):
            return self._send_json(404, {"error": "分组不存在"})
        self._send_json(200, {"ok": True})

    def _api_file_set_group(self, body: dict):
        raw = (body.get("path") or "").strip()
        gid = (body.get("group") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        if not file_set_group(raw, gid):
            return self._send_json(404, {"error": "文件不在列表中，或目标分组不存在"})
        self._send_json(200, {"ok": True})

    def _api_favorite_toggle(self, body: dict):
        raw = (body.get("path") or "").strip()
        favorite_value = body.get("favorite")
        if not raw or not isinstance(favorite_value, bool):
            return self._send_json(400, {"error": "缺少 path 或 favorite"})
        favorite = file_set_favorite(raw, favorite_value)
        if favorite is None:
            return self._send_json(404, {"error": "文件不在列表中"})
        self._send_json(200, {"ok": True, "favorite": favorite})

    def _api_groups_reorder(self, body: dict):
        order = body.get("order")
        if not isinstance(order, list):
            return self._send_json(400, {"error": "缺少 order 数组"})
        groups_reorder(order)
        self._send_json(200, {"ok": True})

    def _api_reorder_files(self, body: dict):
        paths = body.get("paths")
        view = body.get("view")
        if (
            not isinstance(paths, list)
            or not all(isinstance(path, str) for path in paths)
            or not isinstance(view, str)
        ):
            return self._send_json(400, {"error": "缺少 paths 数组或 view"})
        try:
            reorder_files(paths, view)
        except ValueError as err:
            return self._send_json(409, {"error": str(err)})
        self._send_json(200, {"ok": True})

    # ── 回收站（右键删除 = 移到 canvases/回收站/）──
    def _api_trash(self, body: dict):
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        src = Path(raw)
        indexed = _norm(src) in recent_paths()
        if not src.is_file():
            # 文件可能已被用户从资源管理器移走或删除。此时没有实体可放进
            # 回收站，但显式执行“移到回收站”仍应清掉失效的最近记录，
            # 否则前端刷新后该卡片会再次出现，造成操作成功的假象。
            if indexed:
                remove_from_recent(src)
                forget_viewport_state(src)
                return self._send_json(200, {"ok": True, "missing": True})
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(src):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            dst = move_canvas_to_trash(src)
        except FileNotFoundError as err:
            # 处理 is_file() 与 rename() 之间文件恰好被外部删除的竞态。
            # 若源文件仍在，说明更可能是伴生资源目录发生竞态，应按失败返回，
            # 不能误删仍然有效的最近记录。
            if indexed and not src.is_file():
                remove_from_recent(src)
                forget_viewport_state(src)
                return self._send_json(200, {"ok": True, "missing": True})
            return self._send_json(500, {"error": f"移到回收站失败：{err}"})
        except OSError as err:
            return self._send_json(500, {"error": f"移到回收站失败：{err}"})
        self._send_json(200, {"ok": True, "trashedTo": _norm(dst)})

    def _api_trash_list(self):
        items = []
        item_count = 0
        entry_count = 0
        if TRASH.exists():
            try:
                entries = list(TRASH.iterdir())
                entry_count = len(entries)
                item_count = sum(
                    1 for p in entries
                    if p.is_file() and p.suffix.lower() == ".canvas"
                )
            except OSError:
                entries = []
                item_count = 0
                entry_count = 0
            for p in entries:
                if p.suffix.lower() != ".canvas":
                    continue
                if not p.is_file():
                    continue
                try:
                    mtime = datetime.fromtimestamp(p.stat().st_mtime)
                    trashed_at = mtime.replace(microsecond=0).isoformat()
                except OSError:
                    trashed_at = None
                items.append({
                    "path": _norm(p),
                    "title": p.stem,
                    "trashedAt": trashed_at,
                    "entryCount": 1 + int(canvas_assets_root(p).exists()),
                })
        items.sort(key=lambda x: x.get("trashedAt") or "", reverse=True)
        self._send_json(200, {
            "files": items,
            "itemCount": item_count,
            "entryCount": entry_count,
        })

    def _api_trash_empty(self):
        """永久清除固定回收站目录中的全部内容；该操作不可恢复。"""
        try:
            TRASH.mkdir(parents=True, exist_ok=True)
            targets = list(TRASH.iterdir())
        except OSError as err:
            return self._send_json(500, {"error": f"读取回收站失败：{err}"})

        deleted = 0
        failures = []
        for target in targets:
            try:
                if target.is_symlink():
                    target.unlink()
                elif getattr(target, "is_junction", lambda: False)():
                    target.rmdir()
                elif target.is_file():
                    target.unlink()
                elif target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
                if target.suffix.lower() == ".canvas":
                    forget_viewport_state(target)
                    deleted += 1
            except OSError as err:
                failures.append(f"{target.name}：{err}")

        if failures:
            return self._send_json(500, {
                "error": "回收站未能完全清空：" + "；".join(failures[:3]),
                "deleted": deleted,
            })
        self._send_json(200, {"ok": True, "deleted": deleted})

    def _api_restore(self, body: dict):
        """把回收站里的文件移回 canvases/，登记 recent，可选归到某分组。"""
        raw = (body.get("path") or "").strip()
        gid = (body.get("group") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        src = Path(raw)
        if not src.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        # 安全：只允许恢复回收站内的文件
        try:
            src.resolve().relative_to(TRASH.resolve())
        except ValueError:
            return self._send_json(403, {"error": "该文件不在回收站内"})
        try:
            CANVASES.mkdir(parents=True, exist_ok=True)
            dst = CANVASES / src.name
            if dst.exists() or canvas_assets_root(dst).exists():
                stem, suffix = src.stem, src.suffix
                i = 2
                while True:
                    cand = CANVASES / f"{stem}-{i}{suffix}"
                    if not cand.exists() and not canvas_assets_root(cand).exists():
                        dst = cand
                        break
                    i += 1
            move_canvas_with_assets(src, dst)
        except OSError as err:
            return self._send_json(500, {"error": f"恢复失败：{err}"})
        move_viewport_state(src, dst)
        rewrite_taskbook_focus_canvas_path(src, dst)
        move_canvas_activity_path(src, dst)
        register_recent(dst)
        if gid:
            file_set_group(_norm(dst), gid)   # 目标组不存在则忽略（留在未分组）
        self._send_json(200, {"path": _norm(dst), "title": dst.stem})

    def _api_reveal(self, body: dict):
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少 path"})
        target = Path(raw)
        if not target.exists():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(target):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            # Windows 资源管理器：定位并选中文件
            subprocess.Popen(
                _explorer_select_args(target),
                close_fds=True,
            )
        except OSError as err:
            return self._send_json(500, {"error": f"调起失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_open_external(self, body: dict):
        """C2：用系统默认程序打开一个网址或本地文件。

        kind='url'  → 只允许 http/https，调 webbrowser.open（浏览器自带防护）。
        kind='file' → 相对路径相对 baseDir（当前 .canvas 目录）解析；
                      规范化后做后缀黑名单 + 存在性检查，再 os.startfile。
        """
        target = (body.get("target") or "").strip()
        kind = (body.get("kind") or "").strip()
        base_dir = (body.get("baseDir") or "").strip()
        if not target:
            return self._send_json(400, {"error": "缺少 target"})

        if kind == "url":
            low = target.lower()
            if not (low.startswith("http://") or low.startswith("https://")):
                return self._send_json(400, {"error": "不是有效网址"})
            try:
                webbrowser.open(target)
            except Exception as err:  # noqa: BLE001
                return self._send_json(500, {"error": f"打开失败：{err}"})
            return self._send_json(200, {"ok": True})

        if kind == "file":
            if not base_dir:
                return self._send_json(403, {"error": "缺少已授权的画布目录"})
            try:
                authorized_base = Path(base_dir).resolve()
                if not is_authorized_canvas_directory(authorized_base):
                    return self._send_json(403, {"error": "画布目录未授权"})
                p = Path(target)
                if not p.is_absolute():
                    p = authorized_base / target
                p = p.resolve()
            except OSError:
                return self._send_json(400, {"error": "路径无效"})
            try:
                p.relative_to(authorized_base)
            except ValueError:
                return self._send_json(403, {"error": "本地链接超出当前画布目录"})
            ext = p.suffix.lower()
            if ext in DANGEROUS_EXTS:
                return self._send_json(
                    403, {"error": f"出于安全，不允许打开可执行 / 脚本文件（{ext}）"}
                )
            if not p.exists():
                return self._send_json(404, {"error": "文件不存在"})
            opener = getattr(os, "startfile", None)
            if opener is None:
                # 非 Windows 兜底（本工具面向 Windows，正常用不到）
                return self._send_json(500, {"error": "当前系统不支持打开外部文件"})
            try:
                opener(str(p))
            except OSError as err:
                return self._send_json(500, {"error": f"打开失败：{err}"})
            return self._send_json(200, {"ok": True})

        return self._send_json(400, {"error": "未知 kind"})

    def _api_open_attachment(self, body: dict):
        """用系统默认程序打开某张画布的附件（PDF / Markdown）。

        路径走 `_resolve_canvas_asset` 沙箱解析（只能落在该画布的 .assets 目录内），
        再做后缀白名单 + 存在性检查，最后 os.startfile。供"在外部编辑器打开 MD 附件"用。
        """
        raw = (body.get("path") or "").strip()
        asset = (body.get("asset") or "").strip()
        if not raw or not asset:
            return self._send_json(400, {"error": "缺少 path / asset"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        try:
            target = _resolve_canvas_asset(canvas_path, asset)
        except ValueError as err:
            return self._send_json(403, {"error": str(err)})
        if target.suffix.lower() not in (".md", ".pdf"):
            return self._send_json(403, {"error": "只允许打开 PDF / Markdown 附件"})
        if not target.is_file():
            return self._send_json(404, {"error": "附件不存在"})
        opener = getattr(os, "startfile", None)
        if opener is None:
            return self._send_json(500, {"error": "当前系统不支持打开外部文件"})
        try:
            opener(str(target))
        except OSError as err:
            return self._send_json(500, {"error": f"打开失败：{err}"})
        return self._send_json(200, {"ok": True})

    def _api_background_image(self, raw_path: str):
        """向编辑器提供用户已选择的本地背景位图。"""
        if not raw_path:
            return self._send_json(400, {"error": "缺少 path"})
        target = Path(raw_path)
        media_type = BACKGROUND_IMAGE_TYPES.get(target.suffix.lower())
        if not media_type:
            return self._send_json(403, {"error": "不支持的背景图片格式"})
        if not target.is_file():
            return self._send_json(404, {"error": "背景图片不存在"})
        try:
            if target.stat().st_size > MAX_BACKGROUND_IMAGE_BYTES:
                return self._send_json(413, {"error": "背景图片太大（上限 40MB）"})
        except OSError as err:
            return self._send_json(500, {"error": f"读取背景图片失败：{err}"})
        # 背景页会在起步页预热、编辑器复用。允许浏览器保存字节，但每次用 ETag
        # 向本地服务确认文件未变化，兼顾外部原图可能被用户替换的情况。
        return self._send_local_file(
            target,
            media_type,
            "读取背景图片失败",
            cache_control="private, no-cache",
        )

    def _api_canvas_asset(self, raw_path: str, asset_path: str):
        """向页面提供某张画布伴生目录内的装饰图片。"""
        if not raw_path or not asset_path:
            return self._send_json(400, {"error": "缺少画布或素材路径"})
        canvas_path = Path(raw_path)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        try:
            target = _resolve_canvas_asset(canvas_path, asset_path)
        except ValueError as err:
            return self._send_json(403, {"error": str(err)})
        media_type = CANVAS_ASSET_TYPES.get(target.suffix.lower())
        if not media_type:
            return self._send_json(403, {"error": "不支持的素材格式"})
        if not target.is_file():
            return self._send_json(404, {"error": "素材不存在"})
        return self._send_local_file(target, media_type, "读取素材失败")

    def _api_background_preference(self):
        """返回独立编辑器和工作台嵌入画布共用的背景外观。"""
        self._send_json(200, load_background_preference())

    def _api_set_background_preference(self, body: dict):
        """更新全局背景与辅助底纹；未提交的字段沿用现有偏好。"""
        if "background" not in body and "guide" not in body:
            return self._send_json(400, {"error": "缺少 background 或 guide"})
        current = load_background_preference()
        background = body.get("background") if "background" in body else current.get("background")
        if background is not None and not isinstance(background, dict):
            return self._send_json(400, {"error": "背景设置格式无效"})
        guide = body.get("guide") if "guide" in body else current.get("guide")
        if guide is not None:
            if not isinstance(guide, dict) or guide.get("type") not in {
                "ruled", "dots", "grid", "major-grid"
            }:
                return self._send_json(400, {"error": "辅助底纹设置格式无效"})
            guide = {"type": guide["type"]}
        try:
            save_background_preference(background, guide)
        except OSError as err:
            return self._send_json(500, {"error": f"保存全局背景失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_set_viewport(self, body: dict):
        """静默保存单张画布上次观看的位置；不修改 .canvas 正文。"""
        raw = (body.get("path") or "").strip()
        viewport = _clean_viewport(body.get("viewport"))
        if not raw or viewport is None:
            return self._send_json(400, {"error": "缺少 path 或视口状态无效"})
        target = Path(raw)
        if not target.is_file():
            return self._send_json(404, {"error": "文件不存在"})
        if not is_authorized(target):
            return self._send_json(403, {"error": "路径未授权"})
        try:
            save_viewport_state(target, viewport)
        except OSError as err:
            return self._send_json(500, {"error": f"保存视口失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_pick_background_image(self):
        """选择一个本地位图，返回绝对路径供全局背景偏好记录。"""
        try:
            picked = pick_background_image()
        except OSError as err:
            return self._send_json(500, {"error": f"选择背景失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        target = Path(picked)
        if target.suffix.lower() not in BACKGROUND_IMAGE_TYPES:
            return self._send_json(400, {"error": "仅支持 PNG、JPEG、WebP、GIF 或 BMP 图片"})
        if not target.is_file():
            return self._send_json(404, {"error": "选择的背景图片不存在"})
        try:
            if target.stat().st_size > MAX_BACKGROUND_IMAGE_BYTES:
                return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})
        except OSError as err:
            return self._send_json(500, {"error": f"读取背景图片失败：{err}"})
        self._send_json(200, {"path": _norm(target), "name": target.name})

    def _api_upload_background_image(self, body: dict):
        """接收浏览器 file input 选中的全局背景图片，写入全局 data/backgrounds 目录。"""
        name = (body.get("name") or "bg").strip()
        data_url = body.pop("data", "") or ""
        if not name or not isinstance(data_url, str):
            return self._send_json(400, {"error": "缺少图片数据"})
        source_name = Path(name).name

        prefix = "data:"
        idx = data_url.find(",")
        if not data_url.startswith(prefix) or idx < 0:
            return self._send_json(400, {"error": "图片数据格式错误"})
        header = data_url[len(prefix):idx]
        b64_data = data_url[idx + 1:]

        media_type = header.split(";")[0].lower()
        ext = ""
        for k, v in BACKGROUND_IMAGE_TYPES.items():
            if v == media_type:
                ext = k
                break
        if not ext:
            if source_name.lower().endswith(tuple(BACKGROUND_IMAGE_TYPES.keys())):
                ext = Path(source_name).suffix.lower()
            else:
                ext = ".png"

        if _base64_too_large(b64_data, MAX_BACKGROUND_IMAGE_BYTES):
            return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})
        # b64_data 是切片副本；解码前释放原始 data URL，避免两份大字符串常驻。
        del data_url
        try:
            content = base64.b64decode(b64_data, validate=True)
        except (binascii.Error, ValueError):
            return self._send_json(400, {"error": "图片数据解析失败"})
        del b64_data
        if not content:
            return self._send_json(400, {"error": "图片为空"})
        if len(content) > MAX_BACKGROUND_IMAGE_BYTES:
            return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})

        bg_dir = BACKGROUND_UPLOAD_DIR
        try:
            bg_dir.mkdir(parents=True, exist_ok=True)
            cleanup_unused_background_uploads()
            stem = _safe_export_stem(Path(source_name).stem, "bg")
            target = _unused_path(bg_dir, stem, ext)
            _atomic_write_bytes(target, content)
        except OSError as err:
            return self._send_json(500, {"error": f"保存背景图片失败：{err}"})

        self._send_json(200, {"ok": True, "path": _norm(target), "name": target.name})

    def _api_import_canvas_image(self, body: dict):
        """选择一张图片并复制进当前画布的伴生素材目录，返回相对素材路径。"""
        raw = (body.get("path") or "").strip()
        if not raw:
            return self._send_json(400, {"error": "缺少当前画布路径"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "当前画布路径未授权"})
        try:
            picked = pick_background_image()
        except OSError as err:
            return self._send_json(500, {"error": f"选择图片失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        source = Path(picked)
        media_type = BACKGROUND_IMAGE_TYPES.get(source.suffix.lower())
        if not media_type or not source.is_file():
            return self._send_json(400, {"error": "请选择 PNG、JPEG、WebP、GIF 或 BMP 图片"})
        try:
            if source.stat().st_size > MAX_CANVAS_IMAGE_BYTES:
                return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})
            with _cross_process_mutation_lock():
                with CANVAS_FILE_MUTATION_LOCK:
                    if not canvas_path.is_file() or not is_authorized(canvas_path):
                        return self._send_json(409, {"error": "选择图片期间画布已被移动或删除，请重新打开后再试"})
                    images_dir = canvas_assets_root(canvas_path) / "images"
                    images_dir.mkdir(parents=True, exist_ok=True)
                    stem = _safe_export_stem(source.stem, "image")
                    target = _unused_path(images_dir, stem, source.suffix.lower())
                    _atomic_copy_file(source, target)
        except OSError as err:
            return self._send_json(500, {"error": f"复制图片素材失败：{err}"})
        relative = target.relative_to(canvas_assets_root(canvas_path)).as_posix()
        self._send_json(200, {"ok": True, "assetPath": relative, "name": target.name})

    def _api_upload_canvas_image(self, body: dict):
        """接收浏览器 file input 选中的图片，写入当前画布的伴生素材目录。"""
        raw = (body.get("path") or "").strip()
        name = (body.get("name") or "image").strip()
        data_url = body.pop("data", "") or ""
        if not raw or not name or not isinstance(data_url, str):
            return self._send_json(400, {"error": "缺少当前画布路径或图片数据"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "当前画布路径未授权"})
        source_name = Path(name).name
        suffix = Path(source_name).suffix.lower()
        media_type = BACKGROUND_IMAGE_TYPES.get(suffix)
        if not media_type:
            return self._send_json(400, {"error": "请选择 PNG、JPEG、WebP、GIF 或 BMP 图片"})
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        if _base64_too_large(encoded, MAX_CANVAS_IMAGE_BYTES):
            return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})
        del data_url
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return self._send_json(400, {"error": "图片数据无效"})
        del encoded
        if not content:
            return self._send_json(400, {"error": "图片为空"})
        if len(content) > MAX_CANVAS_IMAGE_BYTES:
            return self._send_json(413, {"error": "图片太大，请选择 40MB 以内的图片"})
        images_dir = canvas_assets_root(canvas_path) / "images"
        try:
            images_dir.mkdir(parents=True, exist_ok=True)
            stem = _safe_export_stem(Path(source_name).stem, "image")
            target = _unused_path(images_dir, stem, suffix)
            _atomic_write_bytes(target, content)
        except OSError as err:
            return self._send_json(500, {"error": f"保存图片素材失败：{err}"})
        relative = target.relative_to(canvas_assets_root(canvas_path)).as_posix()
        self._send_json(200, {"ok": True, "assetPath": relative, "name": target.name})

    def _api_upload_canvas_attachment(self, body: dict):
        """接收浏览器选中/拖入的 PDF 或 Markdown 附件，按内容哈希去重后写入
        当前画布伴生目录的 attachments/ 下。同一篇文档反复拖入只存一份。"""
        raw = (body.get("path") or "").strip()
        name = (body.get("name") or "附件").strip()
        data_url = body.pop("data", "") or ""
        if not raw or not name or not isinstance(data_url, str):
            return self._send_json(400, {"error": "缺少当前画布路径或附件数据"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "当前画布路径未授权"})
        source_name = Path(name).name
        suffix = Path(source_name).suffix.lower()
        media_type = CANVAS_ATTACHMENT_TYPES.get(suffix)
        if not media_type:
            return self._send_json(400, {"error": "仅支持 PDF 或 Markdown（.md）附件"})
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        if _base64_too_large(encoded, MAX_CANVAS_ATTACHMENT_BYTES):
            return self._send_json(413, {"error": "附件太大，请选择 100MB 以内的文档"})
        del data_url
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return self._send_json(400, {"error": "附件数据无效"})
        del encoded
        if not content:
            return self._send_json(400, {"error": "附件为空"})
        if len(content) > MAX_CANVAS_ATTACHMENT_BYTES:
            return self._send_json(413, {"error": "附件太大，请选择 100MB 以内的文档"})
        # 内容哈希去重：文件名取哈希前 16 位，已存在同内容文件则直接复用，不重复写。
        digest = hashlib.sha256(content).hexdigest()[:16]
        attach_dir = canvas_assets_root(canvas_path) / "attachments"
        target = attach_dir / f"{digest}{'.md' if suffix == '.markdown' else suffix}"
        try:
            attach_dir.mkdir(parents=True, exist_ok=True)
            if not target.is_file():
                _atomic_write_bytes(target, content)
        except OSError as err:
            return self._send_json(500, {"error": f"保存附件失败：{err}"})
        relative = target.relative_to(canvas_assets_root(canvas_path)).as_posix()
        self._send_json(200, {
            "ok": True,
            "assetPath": relative,
            "name": source_name,
        })

    def _api_canvas_annotation(self, raw_path: str, asset_path: str):
        """读取某个 PDF 附件旁的批注伴生文件 `<pdf>.annot.json`；不存在则返回空。"""
        if not raw_path or not asset_path:
            return self._send_json(400, {"error": "缺少画布或附件路径"})
        canvas_path = Path(raw_path)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        try:
            target = _resolve_canvas_asset(canvas_path, asset_path + ".annot.json")
        except ValueError as err:
            return self._send_json(403, {"error": str(err)})
        if not target.is_file():
            return self._send_json(200, {"ok": True, "annotation": None})
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            return self._send_json(500, {"error": f"读取批注失败：{err}"})
        self._send_json(200, {"ok": True, "annotation": data})

    def _api_save_canvas_annotation(self, body: dict):
        """原子写入 PDF 附件旁的批注伴生文件 `<pdf>.annot.json`（批注属于论文，随 PDF 走）。"""
        raw = (body.get("path") or "").strip()
        asset = (body.get("asset") or "").strip()
        payload = body.get("data")
        if not raw or not asset or not isinstance(payload, dict):
            return self._send_json(400, {"error": "缺少 path / asset / data"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        try:
            pdf_target = _resolve_canvas_asset(canvas_path, asset)
            annot_target = _resolve_canvas_asset(canvas_path, asset + ".annot.json")
        except ValueError as err:
            return self._send_json(403, {"error": str(err)})
        if pdf_target.suffix.lower() not in (".pdf", ".md") or not pdf_target.is_file():
            return self._send_json(404, {"error": "附件不存在"})
        try:
            _atomic_write_json(annot_target, payload)
        except OSError as err:
            return self._send_json(500, {"error": f"保存批注失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_node_annotations(self, raw_path: str):
        """读取画布正文节点的阅读批注；批注独立于 `.canvas` 正文与布局。"""
        if not raw_path:
            return self._send_json(400, {"error": "缺少画布路径"})
        canvas_path = Path(raw_path)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        target = canvas_assets_root(canvas_path) / "node-annotations.json"
        if not target.is_file():
            return self._send_json(200, {"ok": True, "annotations": None})
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as err:
            return self._send_json(500, {"error": f"读取节点批注失败：{err}"})
        self._send_json(200, {"ok": True, "annotations": data})

    def _api_save_node_annotations(self, body: dict):
        """原子写入 `<画布名>.assets/node-annotations.json`。"""
        raw = (body.get("path") or "").strip()
        payload = body.get("data")
        if not raw or not isinstance(payload, dict):
            return self._send_json(400, {"error": "缺少 path / data"})
        canvas_path = Path(raw)
        if not canvas_path.is_file() or not is_authorized(canvas_path):
            return self._send_json(403, {"error": "画布路径未授权"})
        target = canvas_assets_root(canvas_path) / "node-annotations.json"
        try:
            _atomic_write_json(target, payload)
        except OSError as err:
            return self._send_json(500, {"error": f"保存节点批注失败：{err}"})
        self._send_json(200, {"ok": True})

    def _api_export_markdown(self, body: dict):
        """把当前编辑中的画布数据导出到用户选择目录下的 Markdown 包裹文件夹。"""
        raw = (body.get("path") or "").strip()
        payload = body.get("data")
        if not raw or not isinstance(payload, dict):
            return self._send_json(400, {"error": "缺少当前画布数据"})
        canvas_path = Path(raw)
        if not canvas_path.is_file():
            return self._send_json(404, {"error": "当前画布文件不存在"})
        if not is_authorized(canvas_path):
            return self._send_json(403, {"error": "当前画布路径未授权"})
        try:
            picked = pick_export_dir()
        except OSError as err:
            return self._send_json(500, {"error": f"导出失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        try:
            output_dir, count, node_count, note_count = export_markdown_bundle(
                canvas_path, payload, Path(picked)
            )
        except OSError as err:
            return self._send_json(500, {"error": f"导出失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "path": _norm(output_dir),
            "count": count,
            "nodeCount": node_count,
            "noteCount": note_count,
        })

    def _api_export_png(self, body: dict):
        """把前端合成好的整张画布 PNG（base64）经原生「另存为」写到用户选的位置。"""
        raw = (body.get("path") or "").strip()
        data_url = body.pop("png", "") or ""
        if not raw or not isinstance(data_url, str) or not data_url:
            return self._send_json(400, {"error": "缺少画布路径或图片数据"})
        canvas_path = Path(raw)
        if not canvas_path.is_file():
            return self._send_json(404, {"error": "当前画布文件不存在"})
        if not is_authorized(canvas_path):
            return self._send_json(403, {"error": "当前画布路径未授权"})
        payload = data_url.split(",", 1)[1] if "," in data_url else data_url
        del data_url
        try:
            png_bytes = base64.b64decode(payload)
        except ValueError:   # binascii.Error 是 ValueError 子类
            return self._send_json(400, {"error": "图片数据无法解析"})
        del payload
        if not png_bytes:
            return self._send_json(400, {"error": "图片数据为空"})
        try:
            picked = pick_save_png(canvas_path.stem + ".png")
        except OSError as err:
            return self._send_json(500, {"error": f"导出失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        target = Path(picked)
        if target.suffix.lower() != ".png":
            target = target.with_suffix(".png")
        try:
            _atomic_write_bytes(target, png_bytes)
        except OSError as err:
            return self._send_json(500, {"error": f"写入 PNG 失败：{err}"})
        self._send_json(200, {"ok": True, "path": _norm(target)})

    def _api_import_markdown(self):
        """选取一组 Markdown 文档，导入为「最近」中的新文本节点画布。"""
        try:
            picked = pick_import_dir()
        except OSError as err:
            return self._send_json(500, {"error": f"导入失败：{err}"})
        if not picked:
            return self._send_json(200, {"cancelled": True})
        try:
            with _cross_process_mutation_lock():
                with CANVAS_FILE_MUTATION_LOCK:
                    with DATA_MUTATION_LOCK:
                        target, node_count, edge_count = import_markdown_folder(Path(picked))
        except MarkdownImportError as err:
            return self._send_json(400, {"error": f"导入失败：{err}"})
        except OSError as err:
            return self._send_json(500, {"error": f"导入失败：{err}"})
        self._send_json(200, {
            "ok": True,
            "path": _norm(target),
            "title": target.stem,
            "nodes": node_count,
            "edges": edge_count,
        })


# ─── 服务启动 ───────────────────────────────────────────────

def find_free_port(start: int, attempts: int = PORT_ATTEMPTS) -> int:
    for offset in range(attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"找不到可用端口（尝试了 {start} 到 {start + attempts - 1}）"
    )


class CanvasServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def banner(url: str) -> None:
    print()
    print("  画布 已启动")
    print(f"  地址  {url}")
    print("  关闭这个窗口即停止服务")
    print()


def resolve_initial_file(raw: str | None) -> Path | None:
    """解析要直接打开的 .canvas 文件（协议 A：命令行位置参数）。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    candidate = Path(raw).resolve()
    if not candidate.is_file():
        print(f"  ⚠ 命令行传入的文件不存在，忽略：{raw}", file=sys.stderr)
        return None
    if candidate.suffix.lower() != ".canvas":
        print(f"  ⚠ 文件不是 .canvas，忽略：{raw}", file=sys.stderr)
        return None
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description="画布 — 本地画布工具")
    parser.add_argument(
        "file", nargs="?", default=None,
        help="要直接打开的 .canvas 文件路径（协议 A）",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="指定监听端口；不指定时用 8765 起、被占自动 +1。"
             "显式指定时只试这一个端口（供外部调用方信任端口）。",
    )
    parser.add_argument(
        "--no-browser", action="store_true",
        help="启动后不自动打开浏览器（供调试 / 外部调用时使用）。",
    )
    parser.add_argument(
        "--allow-dir", action="append", default=[], metavar="PATH",
        help="额外授权目录：其下的 .canvas 可直接 load/save，无需登记 recent。"
             "可重复。供可信外部调用方整目录授权用。",
    )
    args = parser.parse_args()

    for raw_dir in args.allow_dir:
        d = Path(raw_dir).resolve()
        if d.is_dir():
            ALLOWED_EXTRA_DIRS.append(d)
        else:
            print(f"  ⚠ --allow-dir 目录不存在，忽略：{raw_dir}", file=sys.stderr)

    ensure_dirs()
    initial_file = resolve_initial_file(args.file)
    if initial_file is not None:
        register_recent(initial_file)

    try:
        if args.port is not None:
            port = find_free_port(args.port, attempts=1)  # 精确占用，被占即报错
        else:
            port = find_free_port(DEFAULT_PORT)
    except RuntimeError as err:
        print(f"  启动失败：{err}", file=sys.stderr)
        return 1

    base_url = f"http://localhost:{port}/"
    if initial_file is not None:
        open_url = (
            base_url
            + "editor.html?file="
            + urllib.parse.quote(str(initial_file))
        )
    else:
        open_url = base_url
    banner(base_url)

    if not args.no_browser:
        try:
            webbrowser.open(open_url)
        except Exception:
            pass

    try:
        with CanvasServer(("127.0.0.1", port), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Versioned annotations bound to the bytes of a managed note PDF."""

import functools
import hashlib
import json
import math
import os
import re
import stat
import time
from urllib.parse import unquote

from notes_library import MAX_NOTE_PDF_BYTES, NotesError, _is_reparse, _revision


FILENAME = 'annotations.json'
MAX_BYTES = 8 * 1024 * 1024
IDENTITY = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
HASH = re.compile(r'sha256:[0-9a-f]{64}')
COLOR = re.compile(r'#[0-9a-fA-F]{6}')


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def asset_revision(info):
    # Windows can report creation time for path stat and change time for
    # fstat. Only use fields with the same meaning in both calls.
    return _revision(repr(signature(info)[:-1]).encode('ascii'))


def check_asset(info, expected):
    if expected != asset_revision(info):
        raise NotesError('PDF 文件已变化，请重新打开。', status=409, code='pdf_changed')


def fingerprint(target, expected):
    with target.open('rb') as stream:
        info = os.fstat(stream.fileno())
        check_asset(info, expected)
    return _fingerprint(target, signature(info))


@functools.lru_cache(maxsize=64)
def _fingerprint(target, expected):
    with target.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if signature(info) != expected:
            raise NotesError('PDF 文件已变化，请重新打开。', status=409, code='pdf_changed')
        if info.st_size > MAX_NOTE_PDF_BYTES:
            raise NotesError('PDF 超过 100 MiB', status=413, code='too_large')
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(256 * 1024), b''):
            digest.update(chunk)
        if signature(os.fstat(stream.fileno())) != expected:
            raise NotesError('PDF 文件已变化，请重新打开。', status=409, code='pdf_changed')
    return 'sha256:' + digest.hexdigest()


def invalid():
    return NotesError('PDF 批注数据无效', code='invalid_annotation')


def identifier(value):
    return isinstance(value, str) and IDENTITY.fullmatch(value)


def numeric(value, bound=10_000_000):
    return type(value) in (int, float) and -bound <= value <= bound and math.isfinite(value)


def point(value):
    return isinstance(value, list) and len(value) == 2 and all(numeric(part) for part in value)


def quad(value):
    return isinstance(value, list) and len(value) == 4 and all(point(part) for part in value)


def text(value):
    return isinstance(value, str) and len(value) <= 64_000


def validate_record(record):
    if (not isinstance(record, dict) or not identifier(record.get('id'))
            or type(record.get('page')) is not int or not 1 <= record['page'] <= 1_000_000
            or not isinstance(record.get('color'), str) or not COLOR.fullmatch(record['color'])):
        raise invalid()
    kind = record.get('kind')
    fields = {
        'highlight': {'quads', 'text'}, 'underline': {'quads', 'text'},
        'pen': {'points', 'width'}, 'highlighter': {'points', 'width'},
        'box': {'quad'}, 'note': {'point', 'text'},
    }
    if not isinstance(kind, str) or kind not in fields:
        raise invalid()
    optional = {'cardBox'} if kind == 'note' and 'cardBox' in record else set()
    if set(record) != {'id', 'page', 'kind', 'color'} | fields[kind] | optional:
        raise invalid()
    if kind in ('highlight', 'underline'):
        if (not isinstance(record['quads'], list) or not 1 <= len(record['quads']) <= 4096
                or not all(quad(item) for item in record['quads']) or not text(record['text'])):
            raise invalid()
    if kind in ('pen', 'highlighter'):
        points, width = record['points'], record['width']
        if (not numeric(width, 10_000) or width <= 0 or not isinstance(points, list) or not 1 <= len(points) <= 8192
                or not all(isinstance(item, list) and len(item) == 3 and numeric(item[0]) and numeric(item[1])
                           and numeric(item[2], 1) and item[2] >= 0 for item in points)):
            raise invalid()
    if kind == 'box' and not quad(record['quad']):
        raise invalid()
    if kind == 'note' and (not point(record['point']) or not text(record['text'])):
        raise invalid()
    if optional:
        box = record['cardBox']
        if (not isinstance(box, dict) or set(box) != {'width', 'height', 'offsetX', 'offsetY'}
                or any(type(value) is not int or abs(value) > 1_000_000 for value in box.values())
                or not all(1 <= box[key] <= 10_000 for key in ('width', 'height'))):
            raise invalid()
    for value in record.values():
        if isinstance(value, str):
            try:
                value.encode('utf-8')
            except UnicodeError as error:
                raise invalid() from error
    return record


def read(sidecar):
    if _is_reparse(sidecar) or (os.path.lexists(sidecar) and not sidecar.is_file()):
        raise NotesError('PDF 批注路径无效', status=403, code='unsafe_path')
    try:
        with sidecar.open('rb') as stream:
            raw = stream.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return {'revision': None, 'pdfHash': None, 'annotations': [], 'lastWrite': None}
    try:
        if len(raw) > MAX_BYTES:
            raise ValueError('size')
        data = json.loads(raw)
        if (not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1
                or not isinstance(data.get('pdfHash'), str) or not HASH.fullmatch(data['pdfHash'])
                or not isinstance(data.get('annotations'), list)):
            raise ValueError('schema')
        ids = {validate_record(item)['id'] for item in data['annotations']}
        if len(ids) != len(data['annotations']):
            raise ValueError('duplicate')
        last_write = data.get('lastWrite')
        if last_write is not None and (not isinstance(last_write, str) or not HASH.fullmatch(last_write)):
            raise ValueError('write identity')
    except (ValueError, NotesError, RecursionError) as error:
        raise NotesError('无法读取 PDF 批注', status=409, code='annotation_unreadable') from error
    return {'revision': _revision(raw), 'pdfHash': data['pdfHash'], 'annotations': data['annotations'], 'lastWrite': last_write}


def check_binding(snapshot, digest):
    if snapshot['pdfHash'] and snapshot['pdfHash'] != digest:
        raise NotesError('PDF 内容已更换，原有批注已保留。', status=409, code='pdf_changed')


def save(sidecar, snapshot, digest, body, atomic_bytes):
    expected = body.get('revision')
    if 'revision' not in body or (expected is not None and (not isinstance(expected, str) or not HASH.fullmatch(expected))):
        raise invalid()
    upsert, remove = body.get('upsert'), body.get('remove')
    if not isinstance(upsert, list) or not isinstance(remove, list) or not all(identifier(item) for item in remove):
        raise invalid()
    changes = {validate_record(item)['id']: item for item in upsert}
    if len(changes) != len(upsert) or changes.keys() & set(remove):
        raise invalid()
    write = _revision(json.dumps([expected, upsert, remove], ensure_ascii=False,
                                 sort_keys=True, separators=(',', ':')).encode('utf-8'))
    if snapshot['lastWrite'] == write:
        return {'revision': snapshot['revision'], 'pdfHash': digest}
    if snapshot['revision'] != expected:
        raise NotesError('PDF 批注已在其他窗口修改', status=409, code='annotation_conflict')
    annotations = {item['id']: item for item in snapshot['annotations']}
    for key in remove:
        annotations.pop(key, None)
    annotations.update(changes)
    raw = json.dumps({'version': 1, 'pdfHash': digest, 'annotations': list(annotations.values()), 'lastWrite': write},
                     ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise NotesError('PDF 批注超过 8 MiB', status=413, code='too_large')
    # A simultaneous read by another program can briefly block replacement on Windows.
    for delay in (0.02, 0.04, 0.08, None):
        try:
            atomic_bytes(sidecar, raw)
            break
        except PermissionError as error:
            if delay is None or getattr(error, 'winerror', None) not in (5, 32, 33):
                raise
            time.sleep(delay)
    return {'revision': _revision(raw), 'pdfHash': digest}


def unused(store, note, protected):
    root = store._embed_root(note, 'pdf')
    if not root.exists():
        return (), {}
    if not root.is_dir():
        raise NotesError('PDF 素材路径不是目录', code='invalid_pdf')
    candidates = {}
    for folder in root.iterdir():
        if not identifier(folder.name) or folder.name in protected or _is_reparse(folder) or not folder.is_dir():
            continue
        files = list(folder.iterdir())
        pdfs = [file for file in files if file.suffix.casefold() == '.pdf']
        sidecar = folder / FILENAME
        if (len(pdfs) != 1 or any(file not in (pdfs[0], sidecar) for file in files)
                or any(_is_reparse(file) or not stat.S_ISREG(file.lstat().st_mode) for file in files)):
            continue
        try:
            marks = read(sidecar)['annotations']
        except NotesError:
            continue
        signatures = tuple((file.name, signature(file.stat())) for file in [folder, *sorted(files)])
        candidates[folder.name] = (folder, pdfs[0].name, signatures, bool(marks))
    if not candidates:
        return (), {}
    # UUIDs are scoped by attachment for viewing. Cleanup conservatively keeps
    # references anywhere in the library, including paths and unfinished fences.
    revisions = []
    for document in store._note_paths(strict=True):
        raw = store._read_note_bytes(document)
        revisions.append((document, _revision(raw)))
        for key in IDENTITY.findall(unquote(store._decode_note(raw)).lower()):
            candidates.pop(key, None)
    for document, revision in revisions:
        if _revision(store._read_note_bytes(document)) != revision:
            raise NotesError('扫描期间笔记发生修改，请重试', status=409, code='note_changed')
    return tuple(revisions), candidates

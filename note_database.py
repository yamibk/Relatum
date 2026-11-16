"""Per-note SQLite tables and the files they manage inside a companion directory."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
import unicodedata
import uuid
from collections import defaultdict
from contextlib import closing, contextmanager
from datetime import date
from pathlib import Path, PurePosixPath

from notes_library import (MAX_NOTE_IMAGE_BYTES, NOTE_IMAGE_TYPES, NotesError,
                           _check_note_image_content, _is_reparse, _revision)

DATABASE_DIRECTORY = '.relatum-databases'
LEGACY_DATABASE_DIRECTORY = '.relatum-database'
DATABASE_FILENAME = 'database.sqlite3'
PURGE_DIRECTORY = '.files-pending-delete'
DATABASE_DOCUMENT_SUFFIXES = frozenset({
    '.pdf', '.md', '.markdown', '.csv', '.tsv', '.txt', '.doc', '.docx', '.xls', '.xlsx',
    '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp',
})
DATABASE_ATTACHMENT_SUFFIXES = DATABASE_DOCUMENT_SUFFIXES | NOTE_IMAGE_TYPES.keys()
MAX_DATABASE_ATTACHMENT_BYTES = 100 * 1024 * 1024
PAGE_SIZE = 50
CHOICE_TYPES = frozenset({'select', 'multiSelect', 'status'})
CHOICE_TONES = ('blue', 'violet', 'green', 'amber', 'rose', 'neutral', 'brown', 'orange', 'red')
STATUS_TONES = ('neutral', 'blue', 'green', 'amber', 'violet', 'rose')
DEFAULT_STATUS_TONES = {
    '未开始': 'neutral', '进行中': 'blue', '已完成': 'green', '完成': 'green',
    'not started': 'neutral', 'in progress': 'blue', 'done': 'green', 'completed': 'green',
}
COLUMN_TYPES = frozenset({'text', 'number', 'date', 'checkbox', 'attachment'}) | CHOICE_TYPES
MAX_BATCH_ROWS = 200
MAX_OPTIONS = 64
MAX_COLUMNS = 32
MAX_TEXT = 4096
MAX_ATTACHMENT_NAME = 220
_ID = re.compile(r'[0-9a-f]{32}')
_DATABASE_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,47}')
_FENCE = re.compile(r'```database[ \t]+(' + _DATABASE_ID.pattern + r')[ \t]*\r?\n(?:[ \t]*\r?\n)*```[ \t]*(?:\r?\n)?')
_FENCE_CANDIDATE = re.compile(r'^' + _FENCE.pattern, re.MULTILINE)
_SURROGATE = re.compile(r'[\ud800-\udfff]')
_SCHEMA = """
PRAGMA user_version = 3;
CREATE TABLE databases(position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, name TEXT, revision TEXT);
CREATE TABLE committed_purge (committed INTEGER PRIMARY KEY CHECK (committed=1));
CREATE TABLE columns(position INTEGER PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id),
    id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, display_order INTEGER,
    width INTEGER, hidden INTEGER NOT NULL DEFAULT 0, choices TEXT NOT NULL DEFAULT '[]', UNIQUE(database_id,id));
CREATE INDEX columns_by_order ON columns(database_id,COALESCE(display_order,position),position);
CREATE TABLE records(database_id TEXT NOT NULL REFERENCES databases(id), position INTEGER NOT NULL, id TEXT NOT NULL,
    PRIMARY KEY(database_id,position), UNIQUE(database_id,id));
CREATE TABLE attachments(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT UNIQUE NOT NULL,
    source_name TEXT NOT NULL,
    digest TEXT NOT NULL
);
CREATE INDEX attachment_by_digest ON attachments(digest, source_name);
CREATE TABLE cells(
    database_id TEXT NOT NULL, row_id TEXT NOT NULL, column_id TEXT NOT NULL,
    value,
    attachment_id TEXT REFERENCES attachments(id),
    note_path TEXT,
    note_key TEXT,
    PRIMARY KEY(database_id,row_id,column_id),
    FOREIGN KEY(database_id,row_id) REFERENCES records(database_id,id) ON DELETE CASCADE,
    FOREIGN KEY(database_id,column_id) REFERENCES columns(database_id,id) ON DELETE CASCADE
);
CREATE INDEX cells_by_column ON cells(database_id,column_id);
CREATE INDEX cell_attachment ON cells(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX cell_note ON cells(note_key) WHERE note_key IS NOT NULL;
"""


def database_fences(value: str) -> dict[str, int]:
    if not _FENCE_CANDIDATE.search(value):
        return {}
    # The normal note load and ordinary save paths keep the graph parser lazy.
    from note_graph import _block_source

    found = {}

    def examine(start, end):
        match = _FENCE.fullmatch(value, start, end)
        if match:
            identity = match[1]
            found[identity] = found.get(identity, 0) + 1

    _block_source(value, examine)
    return found


def _identity() -> str:
    return uuid.uuid4().hex


def _choice_palette(kind):
    return STATUS_TONES if kind == 'status' else CHOICE_TONES


def _valid_choice_tone(kind, tone):
    return tone in _choice_palette(kind) or (kind != 'status' and tone == 'default')


def _choices_with_tones(kind, choices):
    palette = _choice_palette(kind)
    tones = [choice['tone'] if _valid_choice_tone(kind, choice.get('tone')) else
             DEFAULT_STATUS_TONES.get(_key(choice['name'])) if kind == 'status' else None for choice in choices]
    assigned = {tone for tone in tones if tone}
    result = []
    for index, (choice, tone) in enumerate(zip(choices, tones)):
        if tone is None:
            tone = next((color for color in palette if color not in assigned), palette[index % len(palette)])
            assigned.add(tone)
        result.append({**choice, 'tone': tone})
    return result


def _key(value) -> str:
    return unicodedata.normalize('NFC', str(value)).casefold()


def _id(value) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise NotesError('数据库项目标识无效')
    return value


def _database_id(value) -> str:
    if not isinstance(value, str) or not _DATABASE_ID.fullmatch(value):
        raise NotesError('数据库标识无效')
    return value


def _text(value, limit=MAX_TEXT, *, required=False) -> str:
    if (not isinstance(value, str) or len(value) > limit or '\0' in value
            or _SURROGATE.search(value) or (required and not value.strip())):
        raise NotesError('数据库文本格式或长度无效')
    return value


def _check_path(path: Path, *, directory=False) -> bool:
    if not os.path.lexists(path):
        return False
    if _is_reparse(path) or not (path.is_dir() if directory else path.is_file()):
        raise NotesError('数据库路径不安全', status=403, code='unsafe_path')
    return True


def _missing(*, deleted=False) -> dict:
    return {'exists': False, 'deleted': deleted, 'revision': None, 'columns': [], 'rows': [], 'page': 1,
            'total': 0, 'pageSize': PAGE_SIZE}


def _downloads_directory() -> Path:
    if os.name != 'nt':
        return Path.home() / 'Downloads'
    import ctypes
    from ctypes import wintypes

    guid_type = ctypes.c_ubyte * 16
    folder_id = guid_type.from_buffer_copy(uuid.UUID('374DE290-123F-4565-9164-39C4925E467B').bytes_le)
    get_path = ctypes.windll.shell32.SHGetKnownFolderPath
    get_path.argtypes = (ctypes.POINTER(guid_type), wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(ctypes.c_wchar_p))
    get_path.restype = ctypes.c_long
    free = ctypes.windll.ole32.CoTaskMemFree
    free.argtypes = (ctypes.c_void_p,)
    free.restype = None
    value = ctypes.c_wchar_p()
    try:
        if get_path(ctypes.byref(folder_id), 0, None, ctypes.byref(value)) != 0 or not value.value:
            raise NotesError('找不到系统下载文件夹', status=503, code='downloads_unavailable')
        return Path(value.value)
    finally:
        if value:
            free(ctypes.cast(value, ctypes.c_void_p))


def copy_attachment_to_downloads(source, name: str) -> str:
    directory = _downloads_directory()
    if not directory.is_absolute() or not directory.is_dir():
        raise NotesError('找不到系统下载文件夹', status=503, code='downloads_unavailable')
    filename = Path(name)
    if filename.name != name or name in ('.', '..'):
        raise NotesError('附件名称无效')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix='.relatum-', suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            shutil.copyfileobj(source, output, length=1024 * 1024)
        for number in range(1, 10001):
            if number == 1:
                destination = directory / name
            else:
                suffix = f' ({number}){filename.suffix}'
                stem_limit = max(1, 255 - len(suffix.encode('utf-16-le')) // 2)
                stem = filename.stem.encode('utf-16-le')[:stem_limit * 2].decode('utf-16-le', errors='ignore')
                destination = directory / (stem + suffix)
            try:
                if os.name == 'nt':
                    temporary.rename(destination)
                else:
                    os.link(temporary, destination)
                return destination.name
            except FileExistsError:
                continue
        raise NotesError('下载目录中的同名文件过多', status=409, code='download_collision')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class NoteDatabases:
    """The HTTP layer uses the normal notes mutation locks for these operations."""

    def __init__(self, store):
        self.store = store

    def _note(self, note, *, read_body=False):
        relative = self.store.normalize_path(note)
        path = self.store._absolute(relative)
        if path.suffix.casefold() != '.md' or not path.is_file():
            raise NotesError('笔记不存在', status=404, code='not_found')
        return relative, path, self.store._read_note_bytes(path) if read_body else None

    def _directory(self, note_path: Path) -> Path:
        assets = note_path.with_suffix('.assets')
        _check_path(assets, directory=True)
        directory = assets / DATABASE_DIRECTORY
        if _check_path(directory, directory=True):
            _check_path(directory / 'files', directory=True)
        return directory

    def _database_path(self, note_path: Path) -> Path | None:
        directory = self._directory(note_path)
        if not directory.exists():
            return None
        path = directory / DATABASE_FILENAME
        if not _check_path(path):
            raise NotesError('数据库文件缺失，已保留附件目录', status=409, code='database_incomplete')
        for suffix in ('-journal', '-wal', '-shm'):
            _check_path(path.with_name(path.name + suffix))
        self._recover_purge(path)
        return path

    @contextmanager
    def _connection(self, path: Path, mode='ro'):
        if mode == 'ro' and path.with_name(path.name + '-journal').exists():
            # A crashed writer can leave a hot rollback journal. Opening the
            # existing database writable lets SQLite recover it even on a read.
            mode = 'rw'
        connection = sqlite3.connect(path.absolute().as_uri() + '?mode=' + mode, uri=True, timeout=2)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA trusted_schema=OFF')
            connection.execute('PRAGMA foreign_keys=ON')
            connection.create_function('database_fold', 1, _key, deterministic=True)
            if mode == 'rwc':
                connection.executescript(_SCHEMA)
            elif connection.execute('PRAGMA user_version').fetchone()[0] != 3:
                raise NotesError('数据库格式与当前 Relatum 版本不兼容', status=409, code='database_version')
            with connection:
                yield connection
        finally:
            connection.close()

    def _new_directory(self, note_path: Path) -> tuple[Path, Path]:
        directory = self._directory(note_path)
        directory.parent.mkdir(exist_ok=True)
        stage = directory.parent / (DATABASE_DIRECTORY + '-init-' + _identity())
        stage.mkdir()
        try:
            (stage / 'files').mkdir()
        except OSError:
            stage.rmdir()
            raise
        return directory, stage

    @contextmanager
    def _shared_store(self, note_path):
        existing = self._database_path(note_path)
        if existing is not None:
            with self._connection(existing, 'rw') as connection:
                yield connection, existing.parent
            return
        directory, stage = self._new_directory(note_path)
        try:
            with self._connection(stage / DATABASE_FILENAME, 'rwc') as connection:
                yield connection, stage
            stage.rename(directory)
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    @staticmethod
    def _initialize(connection, database_id, language='zh'):
        number = connection.execute('SELECT COALESCE(MAX(position),0)+1 FROM databases').fetchone()[0]
        name = ('Database ' if language == 'en' else '数据库 ') + str(number)
        cursor = connection.execute('INSERT OR IGNORE INTO databases(position,id,name,revision) VALUES(?,?,?,?)',
                                    (number, database_id, name, _identity()))
        if cursor.rowcount:
            connection.execute('INSERT INTO columns(database_id,id,name,type) VALUES(?,?,?,?)',
                               (database_id, _identity(), 'Name' if language == 'en' else '名称', 'text'))
        return bool(cursor.rowcount)

    def auto_create(self, path, previous, current, language='zh') -> dict:
        markers = database_fences(current)
        if not markers:
            return {}
        old = database_fences(self.store._decode_note(previous)) if b'```database' in previous else {}
        added = [identity for identity in markers if identity not in old]
        if not added:
            return {}
        try:
            with self._shared_store(path) as (connection, directory):
                created = {identity: self._snapshot(connection, directory, identity) for identity in added
                           if self._initialize(connection, identity, language)}
        except (OSError, sqlite3.Error, NotesError):
            return {'databaseCreateFailed': added}
        return {'databasesCreated': created} if created else {}

    @staticmethod
    def _require_revision(connection, database_id, expected) -> str:
        row = connection.execute('SELECT revision FROM databases WHERE id=?', (database_id,)).fetchone()
        if not row or not row['revision'] or expected != row['revision']:
            raise NotesError('数据库已修改，请刷新后重试', status=409, code='revision_conflict')
        return row['revision']

    @staticmethod
    def _touch(connection, database_id):
        revision = _identity()
        connection.execute('UPDATE databases SET revision=? WHERE id=?', (revision, database_id))
        return revision

    def _internal_note(self, relative) -> tuple[str, Path]:
        note, path, _ = self._note(relative)
        return note, path

    def _attachment_path(self, directory: Path, identity: str, name: str) -> Path:
        name = self._attachment_name(name)
        root = directory / 'files'
        path = root / _id(identity) / name
        _check_path(root, directory=True)
        _check_path(path.parent, directory=True)
        return path

    def _file_available(self, directory, identity, name) -> bool:
        try:
            return _check_path(self._attachment_path(directory, identity, name))
        except (OSError, NotesError):
            return False

    def _note_available(self, relative) -> bool:
        try:
            self._internal_note(relative)
            return True
        except (OSError, NotesError):
            return False

    def _project_cell(self, directory, cell, column_type, availability):
        if cell['attachment_id']:
            identity = cell['attachment_id']
            key = ('attachment', identity)
            if key not in availability:
                availability[key] = self._file_available(directory, identity, cell['value'])
            return {'kind': key[0], 'id': identity, 'name': cell['value'], 'exists': availability[key]}
        if cell['note_path']:
            path = cell['note_path']
            key = ('note', path)
            if key not in availability:
                availability[key] = self._note_available(path)
            return {'kind': key[0], 'path': path, 'name': cell['value'], 'exists': availability[key]}
        if column_type == 'multiSelect':
            return json.loads(cell['value'])
        return bool(cell['value']) if column_type == 'checkbox' else cell['value']

    @staticmethod
    def _choice_value(column, value):
        if value is None or value == [] or value == '':
            return None
        choices = {option['id'] for option in json.loads(column['choices'])}
        if column['type'] == 'multiSelect':
            if not isinstance(value, list) or len(value) > MAX_OPTIONS:
                raise NotesError('多选字段需要已有选项')
            ids = list(dict.fromkeys(_id(item) for item in value))
            if not set(ids) <= choices:
                raise NotesError('选项已不存在')
            return json.dumps(ids, separators=(',', ':'))
        identity = _id(value)
        if identity not in choices:
            raise NotesError('选项已不存在')
        return identity

    def _scalar(self, kind, value):
        if value is None or value == '':
            return None
        if kind == 'text':
            return _text(value)
        if kind == 'number':
            if type(value) in (int, float) and -1e308 <= value <= 1e308 and math.isfinite(value):
                if isinstance(value, int) and abs(value) > 9007199254740991:
                    return float(value)
                return value
        elif kind == 'date':
            if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value, re.ASCII):
                try:
                    return date.fromisoformat(value).isoformat()
                except ValueError:
                    pass
        elif kind == 'checkbox' and isinstance(value, bool):
            return int(value)
        raise NotesError('单元格数值与列类型不匹配')

    def _filter(self, column, operator, value):
        if not isinstance(operator, str):
            raise NotesError('数据库筛选操作无效')
        clause = 'SELECT 1 FROM cells AS c WHERE c.database_id=r.database_id AND c.row_id=r.id AND c.column_id=?'
        args = [column['id']]
        kind = column['type']
        if operator == 'empty':
            return f'NOT EXISTS({clause})', args
        if operator == 'notEmpty':
            return f'EXISTS({clause})', args
        if kind in CHOICE_TYPES:
            option = _id(value)
            if operator not in ('equals', 'contains'):
                raise NotesError('选项筛选操作无效')
            if option not in column['choice_ids']:
                return None, []
            if kind == 'multiSelect':
                return f'EXISTS({clause} AND EXISTS(SELECT 1 FROM json_each(c.value) WHERE value=?))', args + [option]
            return f'EXISTS({clause} AND c.value=?)', args + [option]
        if kind in ('text', 'attachment'):
            needle = _key(_text(value, 256))
            expr = 'instr(database_fold(c.value), ?) > 0' if operator == 'contains' else 'database_fold(c.value) = ?'
            if operator not in ('contains', 'equals'):
                raise NotesError('此列类型不支持该筛选操作')
        else:
            if operator == 'contains':
                operator = 'equals'
            comparison = {'equals': '=', 'lt': '<', 'gt': '>'}.get(operator)
            if comparison is None:
                raise NotesError('此列类型不支持该筛选操作')
            needle = self._scalar(kind, value)
            if needle is None:
                raise NotesError('筛选条件缺少数值')
            expr = f'c.value {comparison} ?'
        return f'EXISTS({clause} AND {expr})', args + [needle]

    def _snapshot(self, connection, directory, database_id, query=None, *, include_values=True, last_page=False) -> dict:
        table = connection.execute('SELECT name,revision FROM databases WHERE id=?', (database_id,)).fetchone()
        if not table or not table['revision']:
            return _missing(deleted=table is not None)
        query = {} if query is None else query
        if not isinstance(query, dict):
            raise NotesError('数据库查询格式无效')
        columns = {row['id']: dict(row) for row in connection.execute(
            'SELECT id,name,type,width,hidden,choices FROM columns WHERE database_id=? ORDER BY COALESCE(display_order,position),position', (database_id,))}
        option_labels = {}
        for column in columns.values():
            column['choices'] = json.loads(column['choices'])
            if column['type'] in CHOICE_TYPES:
                column['choices'] = _choices_with_tones(column['type'], column['choices'])
                labels = {option['id']: option['name'] for option in column['choices']}
                option_labels[column['id']] = labels
                column['choice_ids'] = labels

        def searchable(column_id, value):
            options = option_labels.get(column_id)
            if options is None:
                return _key(value)
            ids = json.loads(value) if columns[column_id]['type'] == 'multiSelect' else [value]
            return _key(' '.join(options.get(identity, '') for identity in ids))

        if option_labels:
            connection.create_function('database_cell_text', 2, searchable, deterministic=True)
        conditions = ['r.database_id=?']
        parameters = [database_id]
        search = _text(query.get('search', ''), 256)
        if search:
            expression = 'database_cell_text(c.column_id,c.value)' if option_labels else 'database_fold(c.value)'
            conditions.append(f'EXISTS(SELECT 1 FROM cells AS c WHERE c.database_id=r.database_id AND c.row_id=r.id AND instr({expression}, ?) > 0)')
            parameters.append(_key(search))
        filters = query.get('filters', [])
        if not isinstance(filters, list) or len(filters) > MAX_COLUMNS:
            raise NotesError('数据库筛选格式无效')
        for rule in filters:
            if not isinstance(rule, dict):
                raise NotesError('数据库筛选格式无效')
            column = columns.get(_id(rule.get('column')))
            if column:  # Column may have been removed by a different view or window.
                condition, args = self._filter(column, rule.get('operator', 'contains'), rule.get('value'))
                if condition:
                    conditions.append(condition)
                    parameters.extend(args)
        where = ' WHERE ' + ' AND '.join(conditions)
        total = connection.execute('SELECT count(*) FROM records AS r' + where, parameters).fetchone()[0]
        requested_page = query.get('page', 1)
        if type(requested_page) is not int or requested_page < 1:
            raise NotesError('数据库页码无效')
        last = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
        page = last if last_page else min(requested_page, last)
        join = ''
        sort_args = []
        order = 'r.position'
        sort = query.get('sort')
        if sort is not None:
            if not isinstance(sort, dict) or sort.get('direction') not in ('asc', 'desc'):
                raise NotesError('数据库排序格式无效')
            column = columns.get(_id(sort.get('column')))
            if column:
                direction = 'ASC' if sort.get('direction') == 'asc' else 'DESC'
                value = 'database_fold(s.value)' if column['type'] in ('text', 'attachment') else 's.value'
                if column['type'] in CHOICE_TYPES:
                    value = 'database_cell_text(s.column_id,s.value)'
                join = ' LEFT JOIN cells AS s ON s.database_id=r.database_id AND s.row_id=r.id AND s.column_id=?'
                sort_args.append(column['id'])
                order = f's.value IS NULL, {value} {direction}, r.position'
        records = {row['id']: {'id': row['id'], 'values': {}} for row in connection.execute(
            f'SELECT r.id FROM records AS r{join}{where} ORDER BY {order} LIMIT ? OFFSET ?',
            sort_args + parameters + [PAGE_SIZE, (page - 1) * PAGE_SIZE])}
        if include_values:
            self._fill_records(connection, directory, database_id, columns, records)
        for column in columns.values():
            column['hidden'] = bool(column['hidden'])
            column.pop('choice_ids', None)
        return {'exists': True, 'name': table['name'], 'revision': table['revision'], 'columns': list(columns.values()),
                'rows': list(records.values()), 'page': page, 'total': total, 'pageSize': PAGE_SIZE}

    def _fill_records(self, connection, directory, database_id, columns, records):
        if not records:
            return
        availability = {}
        placeholders = ','.join('?' for _ in records)
        for cell in connection.execute(
                f'SELECT row_id,column_id,value,attachment_id,note_path FROM cells WHERE database_id=? AND row_id IN ({placeholders})',
                [database_id, *records]):
            column_id = cell['column_id']
            if column_id in columns:
                records[cell['row_id']]['values'][column_id] = self._project_cell(
                    directory, cell, columns[column_id]['type'], availability)

    def read(self, note, database_id, query=None) -> dict:
        database_id = _database_id(database_id)
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is None:
            return _missing()
        with self._connection(database) as connection:
            return self._snapshot(connection, database.parent, database_id, query)

    @staticmethod
    def _one(connection, sql, identity, *scope):
        row = connection.execute(sql, (*scope, _id(identity))).fetchone()
        if row is None:
            raise NotesError('数据库项目不存在', status=404, code='not_found')
        return row

    def _set_cell(self, connection, directory, database_id, row, column_id, value, *, restoring=False):
        column = self._one(connection, 'SELECT id,type,choices FROM columns WHERE database_id=? AND id=?', column_id, database_id)
        attachment_id = note_path = note_key = None
        if column['type'] in CHOICE_TYPES:
            value = self._choice_value(column, value)
        elif column['type'] != 'attachment':
            value = self._scalar(column['type'], value)
        elif value is not None:
            if not isinstance(value, dict):
                raise NotesError('附件引用格式无效')
            if value.get('kind') == 'attachment':
                attachment = self._one(connection, 'SELECT id,name FROM attachments WHERE id=?', value.get('id'))
                attachment_id, value = attachment['id'], attachment['name']
                if not restoring and not self._file_available(directory, attachment_id, value):
                    raise NotesError('附件不存在', status=404, code='not_found')
            elif value.get('kind') == 'note':
                if restoring:
                    note_path = self.store.normalize_path(value.get('path'))
                    if not note_path.lower().endswith('.md'):
                        raise NotesError('笔记引用无效')
                    self.store._absolute(note_path)
                else:
                    _, target = self._internal_note(value.get('path'))
                    note_path = target.resolve(strict=True).relative_to(self.store.root.resolve(strict=True)).as_posix()
                note_key = _key(note_path)
                value = PurePosixPath(note_path).name
            else:
                raise NotesError('附件引用类型无效')
        if value is None:
            connection.execute('DELETE FROM cells WHERE database_id=? AND row_id=? AND column_id=?', (database_id, row, column_id))
        else:
            connection.execute('''
                INSERT INTO cells(database_id,row_id,column_id,value,attachment_id,note_path,note_key)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(database_id,row_id,column_id) DO UPDATE SET value=excluded.value,
                    attachment_id=excluded.attachment_id, note_path=excluded.note_path, note_key=excluded.note_key
            ''', (database_id, row, column_id, value, attachment_id, note_path, note_key))

    @staticmethod
    def _old_values(connection, database_id, row):
        values = {}
        for cell in connection.execute('''SELECT cells.*,columns.type FROM cells
                JOIN columns ON columns.database_id=cells.database_id AND columns.id=column_id
                WHERE cells.database_id=? AND row_id=?''', (database_id, row)):
            value = cell['value']
            if cell['attachment_id']:
                value = {'kind': 'attachment', 'id': cell['attachment_id']}
            elif cell['note_path']:
                value = {'kind': 'note', 'path': cell['note_path']}
            elif cell['type'] == 'multiSelect':
                value = json.loads(value)
            elif cell['type'] == 'checkbox':
                value = bool(value)
            values[cell['column_id']] = value
        return values

    def _record_patch(self, connection, directory, database_id, changes, *, restoring=False):
        if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_BATCH_ROWS:
            raise NotesError('一次最多操作 200 行')
        inverse = []
        added = None
        for change in changes:
            if not isinstance(change, dict):
                raise NotesError('记录格式无效')
            kind, row = change.get('kind'), change.get('row')
            if kind == 'insert':
                row = _identity() if row is None else _id(row)
                position = change.get('position')
                if position is not None and (type(position) is not int or not 1 <= position < 2**63):
                    raise NotesError('记录位置无效')
                if position is None:
                    position = connection.execute('SELECT COALESCE(MAX(position),0)+1 FROM records WHERE database_id=?', (database_id,)).fetchone()[0]
                connection.execute('INSERT INTO records(database_id,position,id) VALUES(?,?,?)', (database_id, position, row))
                inverse.append({'kind': 'delete', 'row': row})
                added = row
            else:
                stored = self._one(connection, 'SELECT id,position FROM records WHERE database_id=? AND id=?', row, database_id)
                before = self._old_values(connection, database_id, row)
                if kind == 'delete':
                    connection.execute('DELETE FROM records WHERE database_id=? AND id=?', (database_id, row))
                    inverse.append({'kind': 'insert', 'row': row, 'position': stored['position'], 'values': before})
                    continue
                if kind != 'set':
                    raise NotesError('记录操作无效')
            values = change.get('values', {})
            if not isinstance(values, dict) or len(values) > MAX_COLUMNS:
                raise NotesError('数据库记录格式无效')
            for column, value in values.items():
                self._set_cell(connection, directory, database_id, row, column, value, restoring=restoring)
            if kind == 'set':
                inverse.append({'kind': 'set', 'row': row, 'values': {column: before.get(column) for column in values}})
        return {'inverse': inverse[::-1], 'addedId': added}

    def _change_options(self, connection, database_id, column, action):
        if column['type'] not in CHOICE_TYPES:
            raise NotesError('该字段没有选项')
        supplied = action.get('choices')
        if not isinstance(supplied, list) or len(supplied) > MAX_OPTIONS:
            raise NotesError('最多支持 64 个选项')
        palette = _choice_palette(column['type'])
        previous = _choices_with_tones(column['type'], json.loads(column['choices']))
        existing = {option['id']: option['tone'] for option in previous}
        assigned = set(existing.values())
        names, ids, choices = set(), set(), []
        for option in supplied:
            if not isinstance(option, dict):
                raise NotesError('选项格式无效')
            name = _text(option.get('name'), 120, required=True).strip()
            identity = _id(option['id']) if option.get('id') else _identity()
            if (option.get('id') and identity not in existing) or identity in ids or _key(name) in names:
                raise NotesError('选项重复或已不存在')
            ids.add(identity)
            names.add(_key(name))
            tone = option.get('tone', existing.get(identity))
            if tone is not None and not _valid_choice_tone(column['type'], tone):
                raise NotesError('选项颜色无效')
            if tone is None:
                tone = next((color for color in palette if color not in assigned), palette[len(choices) % len(palette)])
            assigned.add(tone)
            choices.append({'id': identity, 'name': name, 'tone': tone})
        removed = existing.keys() - ids
        if removed:
            cells = connection.execute('SELECT row_id,value FROM cells WHERE database_id=? AND column_id=?', (database_id, column['id'])).fetchall()
            for cell in cells:
                before = json.loads(cell['value']) if column['type'] == 'multiSelect' else [cell['value']]
                after = [identity for identity in before if identity not in removed]
                if len(after) != len(before):
                    if action.get('clearRemoved') is not True:
                        raise NotesError('请确认清除表格中已使用的选项', status=409, code='options_in_use')
                    if after:
                        connection.execute('UPDATE cells SET value=? WHERE database_id=? AND row_id=? AND column_id=?',
                                           (json.dumps(after, separators=(',', ':')), database_id, cell['row_id'], column['id']))
                    else:
                        connection.execute('DELETE FROM cells WHERE database_id=? AND row_id=? AND column_id=?', (database_id, cell['row_id'], column['id']))
        connection.execute('UPDATE columns SET choices=? WHERE database_id=? AND id=?', (json.dumps(choices, ensure_ascii=False), database_id, column['id']))
        return choices

    def _change(self, connection, directory, database_id, action, query):
        kind = action['type']
        if kind == 'renameDatabase':
            name = _text(action.get('name'), 120, required=True).strip()
            connection.execute('UPDATE databases SET name=? WHERE id=?', (name, database_id))
            return {}
        if kind == 'addColumn':
            column_type = action.get('columnType')
            if not isinstance(column_type, str) or column_type not in COLUMN_TYPES:
                raise NotesError('数据库列类型无效')
            if connection.execute('SELECT count(*) FROM columns WHERE database_id=?', (database_id,)).fetchone()[0] >= MAX_COLUMNS:
                raise NotesError('数据库最多支持 32 列')
            identity = _identity()
            connection.execute('''INSERT INTO columns(database_id,id,name,type,display_order)
                SELECT ?,?,?,?,COALESCE(MAX(COALESCE(display_order,position)),0)+1 FROM columns WHERE database_id=?''',
                (database_id, identity, _text(action.get('name'), 120, required=True).strip(), column_type, database_id))
            if column_type == 'status':
                names = ['Not started', 'In progress', 'Done'] if action.get('language') == 'en' else ['未开始', '进行中', '已完成']
                choices = [{'id': _identity(), 'name': name, 'tone': tone} for name, tone in zip(names, STATUS_TONES)]
                connection.execute('UPDATE columns SET choices=? WHERE database_id=? AND id=?', (json.dumps(choices, ensure_ascii=False), database_id, identity))
            return {'addedColumn': identity}
        elif kind == 'renameColumn':
            column = self._one(connection, 'SELECT id FROM columns WHERE database_id=? AND id=?', action.get('column'), database_id)
            connection.execute('UPDATE columns SET name=? WHERE database_id=? AND id=?',
                               (_text(action.get('name'), 120, required=True).strip(), database_id, column['id']))
        elif kind == 'deleteColumn':
            column = self._one(connection, 'SELECT id,hidden FROM columns WHERE database_id=? AND id=?', action.get('column'), database_id)
            if not column['hidden'] and connection.execute('SELECT count(*) FROM columns WHERE database_id=? AND hidden=0', (database_id,)).fetchone()[0] <= 1:
                raise NotesError('数据库至少需要保留一列')
            connection.execute('DELETE FROM columns WHERE database_id=? AND id=?', (database_id, column['id']))
        elif kind in ('columnLayout', 'setChoices', 'createChoiceValue'):
            column = self._one(connection, 'SELECT id,type,hidden,choices FROM columns WHERE database_id=? AND id=?', action.get('column'), database_id)
            if kind == 'setChoices':
                self._change_options(connection, database_id, column, action)
            if kind == 'createChoiceValue':
                if column['type'] not in ('select', 'multiSelect'):
                    raise NotesError('该字段不能在单元格中创建选项')
                row = self._one(connection, 'SELECT id FROM records WHERE database_id=? AND id=?', action.get('row'), database_id)['id']
                choices = [*json.loads(column['choices']), {'name': action.get('name')}]
                created = self._change_options(connection, database_id, column, {'choices': choices})[-1]['id']
                previous = self._old_values(connection, database_id, row).get(column['id'])
                value = [*(previous or []), created] if column['type'] == 'multiSelect' else created
                self._set_cell(connection, directory, database_id, row, column['id'], value)
                return {'inverse': [{'kind': 'set', 'row': row, 'values': {column['id']: previous}}]}
            if 'width' in action and kind == 'columnLayout':
                width = action['width']
                if type(width) is not int or not 96 <= width <= 640:
                    raise NotesError('列宽无效')
                connection.execute('UPDATE columns SET width=? WHERE database_id=? AND id=?', (width, database_id, column['id']))
            if 'hidden' in action and kind == 'columnLayout':
                hidden = action['hidden']
                if type(hidden) is not bool:
                    raise NotesError('列可见性无效')
                if hidden and not column['hidden'] and connection.execute('SELECT count(*) FROM columns WHERE database_id=? AND hidden=0', (database_id,)).fetchone()[0] <= 1:
                    raise NotesError('数据库至少需要保留一列可见')
                connection.execute('UPDATE columns SET hidden=? WHERE database_id=? AND id=?', (hidden, database_id, column['id']))
            if 'order' in action and kind == 'columnLayout':
                order = action['order']
                ids = {item[0] for item in connection.execute('SELECT id FROM columns WHERE database_id=?', (database_id,))}
                if not isinstance(order, list) or len(order) != len(ids) or {_id(value) for value in order} != ids:
                    raise NotesError('字段顺序无效')
                connection.executemany('UPDATE columns SET display_order=? WHERE database_id=? AND id=?',
                                       ((position, database_id, identity) for position, identity in enumerate(order, 1)))
        elif kind == 'addRow':
            return self._record_patch(connection, directory, database_id, [{'kind': 'insert', 'values': action.get('values', {})}])
        elif kind in ('deleteRow', 'setCell'):
            change = {'kind': 'delete' if kind == 'deleteRow' else 'set', 'row': action.get('row')}
            if kind == 'setCell':
                change['values'] = {_id(action.get('column')): action.get('value')}
            return self._record_patch(connection, directory, database_id, [change])
        elif kind == 'applyRecords':
            return self._record_patch(connection, directory, database_id, action.get('changes'), restoring=True)
        elif kind == 'batchCells':
            page = self._snapshot(connection, directory, database_id, query, include_values=False)
            changes = action.get('changes')
            if not isinstance(changes, list):
                raise NotesError('批量单元格格式无效')
            visible = {row['id'] for row in page['rows']}
            columns = {column['id']: column for column in page['columns'] if not column['hidden']}
            query = query or {}
            can_append = not any(query.get(key) for key in ('search', 'filters', 'sort')) and page['page'] * PAGE_SIZE >= page['total']
            patches = []
            for change in changes:
                if not isinstance(change, dict) or not isinstance(change.get('values'), dict):
                    raise NotesError('批量单元格格式无效')
                row = change.get('row')
                if (row is None and not can_append) or (row is not None and _id(row) not in visible):
                    raise NotesError('粘贴范围超出当前页')
                for column, value in change['values'].items():
                    if column not in columns or (columns[column]['type'] == 'attachment' and value is not None):
                        raise NotesError('批量写入包含隐藏字段或附件值')
                patches.append({'kind': 'insert' if row is None else 'set', 'row': row, 'values': change['values']})
            return self._record_patch(connection, directory, database_id, patches)
        else:
            raise NotesError('未知数据库操作')
        return {}

    def _search(self, relative, database, search):
        search = _text(search, 256)
        items = []
        if database is not None:
            with self._connection(database) as connection:
                folded = _key(search)
                for row in connection.execute(
                    'SELECT id,name FROM attachments WHERE instr(database_fold(source_name), ?) > 0 '
                    'OR instr(name_key, ?) > 0 ORDER BY database_fold(source_name),rowid LIMIT 20',
                    (folded, folded),
                ):
                    if self._file_available(database.parent, row['id'], row['name']):
                        items.append({'kind': 'attachment', 'id': row['id'], 'name': row['name'], 'exists': True})
        notes = self.store.query({'mode': 'link-completion', 'sourcePath': relative, 'q': search, 'limit': 20})['items']
        items.extend({'kind': 'note', 'path': row['path'], 'name': PurePosixPath(row['path']).name,
                      'location': row.get('location', ''), 'exists': True} for row in notes[:20])
        return {'items': items}

    def _unused(self, connection, directory):
        candidates = []
        token = hashlib.sha256()
        for row in connection.execute(
            'SELECT id,name FROM attachments AS a WHERE NOT EXISTS(SELECT 1 FROM cells WHERE attachment_id=a.id) '
            'ORDER BY id',
        ):
            path = self._attachment_path(directory, row['id'], row['name'])
            if _check_path(path):
                file = path.stat()
                token.update(repr((row['id'], row['name'], file.st_dev, file.st_ino,
                                   file.st_size, file.st_mtime_ns)).encode('utf-8'))
                candidates.append((row['id'], path))
        return candidates, token.hexdigest()

    @staticmethod
    def _recycle(recycle, paths):
        if not callable(recycle):
            raise NotesError('系统回收站不可用', status=503, code='recycle_unavailable')
        if paths:
            try:
                recycle(paths)
            except OSError as error:
                raise NotesError('无法移到系统回收站', status=500, code='recycle_failed') from error
            if any(os.path.lexists(path) for path in paths):
                raise NotesError('系统回收站未完成操作', status=500, code='recycle_failed')

    @staticmethod
    def _files_inventory(directory):
        if not _check_path(directory, directory=True):
            return []
        files = []
        pending = [directory]
        while pending:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    if entry.is_dir(follow_symlinks=False):
                        _check_path(path, directory=True)
                        pending.append(path)
                    else:
                        _check_path(path)
                        stat = path.stat()
                        files.append((path.relative_to(directory).as_posix(), stat.st_ino, stat.st_size, stat.st_mtime_ns))
        return sorted(files)

    def _recover_purge(self, database):
        stage = database.parent / PURGE_DIRECTORY
        if not _check_path(stage, directory=True):
            return True
        files = database.parent / 'files'
        with self._connection(database) as connection:
            committed = connection.execute('SELECT 1 FROM committed_purge').fetchone()
        if not committed:
            if os.path.lexists(files):
                raise NotesError('无法还原暂存附件目录，请检查磁盘上的附件目录', status=409, code='purge_recovery')
            stage.rename(files)
            return True
        try:
            shutil.rmtree(stage)
            return True
        except OSError:
            return False

    def _catalog(self, connection, directory, content):
        markers = database_fences(self.store._decode_note(content))
        tables = [dict(row) for row in connection.execute('''
            SELECT d.id,d.name,d.revision,
                (SELECT count(*) FROM records WHERE database_id=d.id) AS rowCount,
                (SELECT count(DISTINCT attachment_id) FROM cells WHERE database_id=d.id AND attachment_id IS NOT NULL) AS attachmentCount
            FROM databases AS d WHERE d.revision IS NOT NULL ORDER BY d.position''')]
        for table in tables:
            table['viewCount'] = markers.get(table['id'], 0)
        files = self._files_inventory(directory / 'files')
        registered = [tuple(row) for row in connection.execute('SELECT id,name FROM attachments ORDER BY id')]
        token = hashlib.sha256(repr((_revision(content), tables, files, registered)).encode('utf-8')).hexdigest()
        return {'tables': tables, 'fileCount': len(files), 'registeredCount': len(registered), 'token': token,
                'cleanupPending': (directory / PURGE_DIRECTORY).exists()}

    @staticmethod
    def _delete_tables(connection, identities):
        connection.executemany('DELETE FROM records WHERE database_id=?', ((identity,) for identity in identities))
        connection.executemany('DELETE FROM columns WHERE database_id=?', ((identity,) for identity in identities))
        connection.executemany('UPDATE databases SET name=NULL,revision=NULL WHERE id=?', ((identity,) for identity in identities))

    def _purge(self, database, content, token):
        files = database.parent / 'files'
        stage = database.parent / PURGE_DIRECTORY
        moved = False
        with self._connection(database, 'rw') as connection:
            if os.path.lexists(stage):
                raise NotesError('附件正在等待删除，请关闭占用文件后重试', status=409, code='purge_pending')
            catalog = self._catalog(connection, database.parent, content)
            if catalog['token'] != token:
                raise NotesError('数据库或附件已变化，请重新确认', status=409, code='revision_conflict')
            # A prior deletion may have left a committed marker after removing its stage.
            connection.execute('DELETE FROM committed_purge')
            connection.commit()
            try:
                connection.execute('BEGIN IMMEDIATE')
                if _check_path(files, directory=True):
                    files.rename(stage)
                    moved = True
                identities = [table['id'] for table in catalog['tables']]
                self._delete_tables(connection, identities)
                connection.execute('DELETE FROM attachments')
                connection.execute('INSERT INTO committed_purge VALUES(1)')
                connection.commit()
            except Exception:
                connection.rollback()
                if moved:
                    self._recover_purge(database)
                raise
        return {'deletedIds': identities, 'cleanupPending': not self._recover_purge(database)}

    def action(self, note, database_id, action, query=None, recycle=None) -> dict:
        if not isinstance(action, dict) or not isinstance(action.get('type'), str):
            raise NotesError('数据库操作格式无效')
        if query is not None and not isinstance(query, dict):
            raise NotesError('数据库查询格式无效')
        kind = action['type']
        note_actions = ('list', 'deleteTables', 'purge', 'previewCleanup', 'cleanup')
        if kind not in note_actions:
            database_id = _database_id(database_id)
        relative, path, content = self._note(note, read_body=kind in ('create', 'list', 'purge'))
        database = self._database_path(path)
        if kind == 'searchAttachments':
            return self._search(relative, database, action.get('query', ''))
        if kind == 'create':
            if action.get('expectedNoteRevision') not in (None, _revision(content)):
                raise NotesError('笔记已修改，请刷新后重试', status=409, code='revision_conflict')
            if database_id not in database_fences(self.store._decode_note(content)):
                raise NotesError('请先保存数据库占位', status=409, code='database_marker_missing')
            with self._shared_store(path) as (connection, directory):
                self._initialize(connection, database_id, action.get('language'))
                return self._snapshot(connection, directory, database_id, query)
        if kind == 'list':
            if database is None:
                return {'tables': [], 'fileCount': 0, 'registeredCount': 0, 'token': None}
            with self._connection(database) as connection:
                return self._catalog(connection, database.parent, content)
        if database is None:
            if kind == 'previewCleanup':
                return {'count': 0, 'candidateToken': None}
            raise NotesError('数据库已移除，请刷新后重试', status=409, code='revision_conflict')
        if kind == 'purge':
            return self._purge(database, content, action.get('token'))
        if kind == 'deleteTables':
            selected = action.get('tables')
            if not isinstance(selected, list) or not selected or any(not isinstance(item, dict) for item in selected):
                raise NotesError('需要选择要删除的数据库')
            with self._connection(database, 'rw') as connection:
                connection.execute('BEGIN IMMEDIATE')
                identities = []
                for table in selected:
                    identity = _database_id(table.get('id'))
                    self._require_revision(connection, identity, table.get('revision'))
                    identities.append(identity)
                self._delete_tables(connection, identities)
            return {'deletedIds': identities}
        if kind == 'previewCleanup':
            with self._connection(database) as connection:
                candidates, token = self._unused(connection, database.parent)
                return {'count': len(candidates), 'candidateToken': token}
        with self._connection(database, 'rw') as connection:
            if kind == 'cleanup':
                candidates, token = self._unused(connection, database.parent)
                if token != action.get('candidateToken'):
                    raise NotesError('附件候选已变化，请重新确认', status=409, code='revision_conflict')
                self._recycle(recycle, [target for _, target in candidates])
                connection.executemany('DELETE FROM attachments WHERE id=?', ((identity,) for identity, _ in candidates))
                for _, target in candidates:
                    try:
                        target.parent.rmdir()
                    except OSError:
                        pass
                return {'deletedCount': len(candidates)}
            else:
                self._require_revision(connection, database_id, action.get('revision'))
                extra = self._change(connection, database.parent, database_id, action, query)
                self._touch(connection, database_id)
                last_page = kind == 'addRow' and action.get('focusAdded') is True and not any(
                    (query or {}).get(key) for key in ('search', 'filters', 'sort'))
                row = extra.get('addedId') if kind == 'addRow' else action.get('row') if kind in ('setCell', 'createChoiceValue') and action.get('includeRow') is True else None
                result = self._write_result(connection, database.parent, database_id, query, extra, row,
                                            'addedRow' if kind == 'addRow' else 'updatedRow', last_page=last_page)
        return result

    def _write_result(self, connection, directory, database_id, query, extra, row, record_key, *, last_page=False):
        result = self._snapshot(connection, directory, database_id, query, last_page=last_page)
        if row:
            record = next((item for item in result['rows'] if item['id'] == row), None)
            if record is None:
                record = {'id': row, 'values': {}}
                columns = {column['id']: column for column in result['columns']}
                self._fill_records(connection, directory, database_id, columns, {row: record})
            extra[record_key] = record
        result.update(extra)
        return result

    def _attachment_name(self, raw) -> str:
        name = _text(raw, MAX_ATTACHMENT_NAME, required=True)
        if '/' in name or name != name.strip() or PurePosixPath(name).suffix.casefold() not in DATABASE_ATTACHMENT_SUFFIXES:
            raise NotesError('数据库附件文件名或格式不支持')
        return self.store.normalize_path(name)

    @staticmethod
    def _unique_attachment_name(connection, original):
        file = PurePosixPath(original)
        number = 1
        name = original
        while connection.execute('SELECT 1 FROM attachments WHERE name_key=?', (_key(name),)).fetchone():
            number += 1
            ending = f' ({number}){file.suffix}'
            name = file.stem[:MAX_ATTACHMENT_NAME - len(ending)] + ending
        return name

    @contextmanager
    def _import(self, connection, directory, source_name, content, digest):
        known = connection.execute('SELECT id,name FROM attachments WHERE digest=? AND source_name=?',
                                   (digest, source_name))
        for row in known:
            if self._file_available(directory, row['id'], row['name']):
                yield row['id']
                return
        name = self._unique_attachment_name(connection, source_name)
        identity = _identity()
        target = self._attachment_path(directory, identity, name)
        try:
            self.store.atomic_bytes(target, content)
            connection.execute('INSERT INTO attachments VALUES(?,?,?,?,?)',
                               (identity, name, _key(name), source_name, digest))
            yield identity
        except Exception:
            target.unlink(missing_ok=True)
            try:
                target.parent.rmdir()
            except OSError:
                pass
            raise

    def import_file(self, note, name, content, candidates=None, *, target=None, query=None) -> dict:
        name = self._attachment_name(name)
        if not isinstance(content, bytes):
            raise NotesError('附件内容无效')
        if len(content) > MAX_DATABASE_ATTACHMENT_BYTES:
            raise NotesError('数据库附件最大 100 MiB', status=413, code='too_large')
        image_type = NOTE_IMAGE_TYPES.get(PurePosixPath(name).suffix.casefold())
        if image_type and target is None:
            raise NotesError('请在附件单元格中上传图片')
        if target is not None and (not isinstance(target, dict) or not content):
            raise NotesError('上传目标无效或文件为空')
        if image_type:
            if len(content) > MAX_NOTE_IMAGE_BYTES:
                raise NotesError('图片过大（上限 40MB）', status=413, code='too_large')
            _check_note_image_content(content, image_type)
        digest = hashlib.sha256(content).hexdigest()
        _, path, _ = self._note(note)
        if target is not None:
            return self._import_into_cell(path, name, content, digest, target, query)
        if candidates is None:
            candidates = []
        if not isinstance(candidates, list):
            raise NotesError('附件投放目标无效')
        candidates = [_database_id(identity) for identity in candidates]
        with self._shared_store(path) as (connection, directory):
            active = {row[0] for row in connection.execute('SELECT id FROM databases WHERE revision IS NOT NULL')} if candidates else set()
            with self._import(connection, directory, name, content, digest) as identity:
                selected = next((candidate for candidate in candidates if candidate in active), None)
                connection.commit()
        return {'attachmentId': identity, 'databaseId': selected}

    def _import_into_cell(self, path, name, content, digest, target, query):
        database_id = _database_id(target.get('databaseId'))
        row, column = _id(target.get('row')), _id(target.get('column'))
        database = self._database_path(path)
        if database is None:
            raise NotesError('数据库已移除，请刷新后重试', status=409, code='revision_conflict')
        with self._connection(database, 'rw') as connection:
            connection.execute('BEGIN IMMEDIATE')
            self._require_revision(connection, database_id, target.get('revision'))
            field = self._one(connection, 'SELECT type FROM columns WHERE database_id=? AND id=?', column, database_id)
            if field['type'] != 'attachment':
                raise NotesError('只能上传到附件字段')
            with self._import(connection, database.parent, name, content, digest) as identity:
                extra = self._record_patch(connection, database.parent, database_id, [
                    {'kind': 'set', 'row': row, 'values': {column: {'kind': 'attachment', 'id': identity}}},
                ])
                self._touch(connection, database_id)
                result = self._write_result(connection, database.parent, database_id, query, extra,
                                            row if target.get('includeRow') is True else None, 'updatedRow')
                connection.commit()
                return result

    def resolve_attachment(self, note, identity) -> Path:
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is None:
            raise NotesError('附件不存在', status=404, code='not_found')
        with self._connection(database) as connection:
            row = self._one(connection, 'SELECT id,name FROM attachments WHERE id=?', identity)
        return self._registered_attachment(database.parent, row)

    def _registered_attachment(self, directory, row) -> Path:
        target = self._attachment_path(directory, row['id'], row['name'])
        if not _check_path(target):
            raise NotesError('附件不存在', status=404, code='not_found')
        return target

    def attachment_download_source(self, note, database_id, row, column, expected) -> Path:
        database_id, row, column = _database_id(database_id), _id(row), _id(column)
        if not isinstance(expected, dict):
            raise NotesError('附件引用无效')
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is None:
            raise NotesError('附件不存在', status=404, code='not_found')
        with self._connection(database) as connection:
            link = connection.execute('''SELECT c.attachment_id,c.note_path,a.id,a.name FROM cells AS c
                JOIN columns AS f ON f.database_id=c.database_id AND f.id=c.column_id AND f.type='attachment'
                LEFT JOIN attachments AS a ON a.id=c.attachment_id
                WHERE c.database_id=? AND c.row_id=? AND c.column_id=?''', (database_id, row, column)).fetchone()
        if link and link['attachment_id'] and expected.get('kind') == 'attachment' and expected.get('id') == link['attachment_id']:
            return self._registered_attachment(database.parent, link)
        if link and link['note_path'] and expected.get('kind') == 'note' and expected.get('path') == link['note_path']:
            return self._internal_note(link['note_path'])[1]
        raise NotesError('单元格文件已变化，请重新打开后下载', status=409, code='revision_conflict')

    def _move_databases(self, paths):
        directories = defaultdict(dict)
        for before, after in paths.items():
            companion = (self.store.root / before).with_suffix('.assets')
            directories[companion.parent][companion.name.casefold()] = (companion, before, after)
        for parent, notes in directories.items():
            candidates = notes.values()
            if len(notes) > 1:
                try:
                    with os.scandir(parent) as entries:
                        names = {entry.name.casefold() for entry in entries if entry.name.casefold().endswith('.assets')}
                    candidates = [notes[name] for name in names & notes.keys()]
                except OSError:
                    pass
            for companion, before, after in candidates:
                if os.path.lexists(companion / DATABASE_DIRECTORY):
                    yield before, after

    def prepare_move(self, paths, source, stage, warnings):
        """Back up affected databases inside the same staging area as Markdown rewrites."""
        changes = []
        source_key = _key(source)
        prefix = source_key + '/'
        for before, after in self._move_databases(paths):
            references = []
            try:
                database = self._database_path(self.store._absolute(before))
                if database is None:
                    continue
                with self._connection(database) as connection:
                    references = connection.execute(
                        '''SELECT cells.database_id,row_id,column_id,note_path,revision FROM cells
                        JOIN databases ON databases.id=cells.database_id
                        WHERE note_key=? OR (note_key>=? AND note_key<?)''',
                        (source_key, prefix, source_key + '0'),
                    ).fetchall()
                    if not references:
                        continue
                    backup = stage / ('database-' + str(len(changes)) + '.bak')
                    with closing(sqlite3.connect(backup)) as target:
                        connection.backup(target)
                    revisions = {row['database_id']: row['revision'] for row in references}
                    changes.append((after, backup, references, revisions))
            except (NotesError, OSError, sqlite3.Error):
                if references:
                    raise
                warnings.append(f'无法检查笔记的数据库链接：{before}')
        return changes

    def apply_move(self, changes, source, destination, applied):
        for note, backup, references, revisions in changes:
            database = self._database_path(self.store._absolute(note))
            if database is None:
                raise NotesError('移动期间数据库已变化，请重试', status=409, code='revision_conflict')
            with self._connection(database, 'rw') as connection:
                for database_id, revision in revisions.items():
                    self._require_revision(connection, database_id, revision)
                updates = []
                for row in references:
                    suffix = PurePosixPath(row['note_path']).parts[len(PurePosixPath(source).parts):]
                    path = PurePosixPath(destination, *suffix).as_posix()
                    updates.append((path, _key(path), PurePosixPath(path).name, row['database_id'], row['row_id'], row['column_id']))
                connection.executemany('UPDATE cells SET note_path=?,note_key=?,value=? WHERE database_id=? AND row_id=? AND column_id=?', updates)
                for database_id in revisions:
                    self._touch(connection, database_id)
            applied.append((database, backup))

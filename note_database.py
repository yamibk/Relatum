"""Per-note SQLite tables and the files they manage inside a companion directory."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import unicodedata
import uuid
from collections import defaultdict
from contextlib import closing, contextmanager
from datetime import date
from pathlib import Path, PurePosixPath

from notes_library import NotesError, _is_reparse, _revision

DATABASE_DIRECTORY = '.relatum-database'
DATABASE_FILENAME = 'database.sqlite3'
DATABASE_ATTACHMENT_SUFFIXES = frozenset({
    '.pdf', '.md', '.markdown', '.csv', '.tsv', '.txt', '.doc', '.docx', '.xls', '.xlsx',
    '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp',
})
MAX_DATABASE_ATTACHMENT_BYTES = 100 * 1024 * 1024
PAGE_SIZE = 50
CHOICE_TYPES = frozenset({'select', 'multiSelect', 'status'})
COLUMN_TYPES = frozenset({'text', 'number', 'date', 'checkbox', 'attachment'}) | CHOICE_TYPES
MAX_BATCH_ROWS = 200
MAX_OPTIONS = 64
MAX_COLUMNS = 32
MAX_TEXT = 4096
MAX_ATTACHMENT_NAME = 220
_ID = re.compile(r'[0-9a-f]{32}')
_EMPTY_FENCE = re.compile(r'```database[ \t]*\r?\n(?:[ \t]*\r?\n)*```[ \t]*(?:\r?\n)?')
_FENCE_CANDIDATE = re.compile(r'^```database[ \t]*\r?\n(?:[ \t]*\r?\n)*```[ \t]*\r?$', re.MULTILINE)
_SURROGATE = re.compile(r'[\ud800-\udfff]')
_SCHEMA = """
PRAGMA user_version = 2;
CREATE TABLE metadata(revision TEXT NOT NULL);
CREATE TABLE columns(position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    display_order INTEGER, width INTEGER, hidden INTEGER NOT NULL DEFAULT 0, choices TEXT NOT NULL DEFAULT '[]');
CREATE TABLE records(position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL);
CREATE TABLE attachments(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT UNIQUE NOT NULL,
    source_name TEXT NOT NULL,
    digest TEXT NOT NULL
);
CREATE INDEX attachment_by_digest ON attachments(digest, source_name);
CREATE TABLE cells(
    row_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    value,
    attachment_id TEXT REFERENCES attachments(id),
    note_path TEXT,
    note_key TEXT,
    PRIMARY KEY(row_id, column_id)
);
CREATE INDEX cell_attachment ON cells(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX cell_note ON cells(note_key) WHERE note_key IS NOT NULL;
"""


def has_database_fence(value: str) -> bool:
    if not _FENCE_CANDIDATE.search(value):
        return False
    # The normal note load and ordinary save paths keep the graph parser lazy.
    from note_graph import _block_source

    found = False

    def examine(start, end):
        nonlocal found
        if not found:
            found = bool(_EMPTY_FENCE.fullmatch(value, start, end))

    _block_source(value, examine)
    return found


def _identity() -> str:
    return uuid.uuid4().hex


def _key(value) -> str:
    return unicodedata.normalize('NFC', str(value)).casefold()


def _id(value) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise NotesError('数据库项目标识无效')
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


def _missing() -> dict:
    return {'exists': False, 'revision': None, 'columns': [], 'rows': [], 'page': 1,
            'total': 0, 'pageSize': PAGE_SIZE}


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
            else:
                version = connection.execute('PRAGMA user_version').fetchone()[0]
                if version == 1 and mode == 'ro':
                    connection.close()
                    with self._connection(path, 'rw') as upgraded:
                        yield upgraded
                    return
                if version == 1:
                    with connection:
                        connection.execute('BEGIN IMMEDIATE')
                        if connection.execute('PRAGMA user_version').fetchone()[0] == 1:
                            connection.execute('ALTER TABLE columns ADD COLUMN display_order INTEGER')
                            connection.execute('ALTER TABLE columns ADD COLUMN width INTEGER')
                            connection.execute('ALTER TABLE columns ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
                            connection.execute("ALTER TABLE columns ADD COLUMN choices TEXT NOT NULL DEFAULT '[]'")
                            connection.execute('PRAGMA user_version=2')
                elif version != 2:
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

    def _initialize(self, connection) -> None:
        connection.execute('INSERT INTO metadata VALUES(?)', (_identity(),))
        connection.execute('INSERT INTO columns(id,name,type) VALUES(?,?,?)', (_identity(), '名称', 'text'))

    def ensure_for_saved_note(self, note_path: Path) -> bool:
        if self._database_path(note_path) is not None:
            return False
        directory, stage = self._new_directory(note_path)
        try:
            with self._connection(stage / DATABASE_FILENAME, 'rwc') as connection:
                self._initialize(connection)
            stage.rename(directory)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        return True

    def auto_create(self, path: Path, previous: bytes, current: str) -> bool:
        if '```database' not in current or os.path.lexists(path.with_suffix('.assets') / DATABASE_DIRECTORY):
            return False
        old = self.store._decode_note(previous) if b'```database' in previous else ''
        # Finishing or inserting a fence adds an empty fence candidate. Merely
        # typing around a retained view after deletion must never create a new DB.
        previous_count = sum(1 for _ in _FENCE_CANDIDATE.finditer(old))
        current_count = sum(1 for _ in _FENCE_CANDIDATE.finditer(current))
        return (current_count > previous_count and not has_database_fence(old)
                and has_database_fence(current) and self.ensure_for_saved_note(path))

    @staticmethod
    def _current_revision(connection) -> str:
        row = connection.execute('SELECT revision FROM metadata').fetchone()
        if not row:
            raise sqlite3.DatabaseError('Missing note database metadata')
        return row['revision']

    def _require_revision(self, connection, expected) -> str:
        current = self._current_revision(connection)
        if expected != current:
            raise NotesError('数据库已修改，请刷新后重试', status=409, code='revision_conflict')
        return current

    @staticmethod
    def _touch(connection):
        revision = _identity()
        connection.execute('UPDATE metadata SET revision=?', (revision,))
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
        clause = 'SELECT 1 FROM cells AS c WHERE c.row_id=r.id AND c.column_id=?'
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

    def _snapshot(self, connection, directory, query=None, *, include_values=True, last_page=False) -> dict:
        query = {} if query is None else query
        if not isinstance(query, dict):
            raise NotesError('数据库查询格式无效')
        columns = {row['id']: dict(row) for row in connection.execute(
            'SELECT id,name,type,width,hidden,choices FROM columns ORDER BY COALESCE(display_order,position),position')}
        option_labels = {}
        for column in columns.values():
            column['choices'] = json.loads(column['choices'])
            if column['type'] in CHOICE_TYPES:
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
        conditions = []
        parameters = []
        search = _text(query.get('search', ''), 256)
        if search:
            expression = 'database_cell_text(c.column_id,c.value)' if option_labels else 'database_fold(c.value)'
            conditions.append(f'EXISTS(SELECT 1 FROM cells AS c WHERE c.row_id=r.id AND instr({expression}, ?) > 0)')
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
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
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
                join = ' LEFT JOIN cells AS s ON s.row_id=r.id AND s.column_id=?'
                sort_args.append(column['id'])
                order = f's.value IS NULL, {value} {direction}, r.position'
        records = {row['id']: {'id': row['id'], 'values': {}} for row in connection.execute(
            f'SELECT r.id FROM records AS r{join}{where} ORDER BY {order} LIMIT ? OFFSET ?',
            sort_args + parameters + [PAGE_SIZE, (page - 1) * PAGE_SIZE])}
        if include_values:
            self._fill_records(connection, directory, columns, records)
        for column in columns.values():
            column['hidden'] = bool(column['hidden'])
            column.pop('choice_ids', None)
        return {'exists': True, 'revision': self._current_revision(connection), 'columns': list(columns.values()),
                'rows': list(records.values()), 'page': page, 'total': total, 'pageSize': PAGE_SIZE}

    def _fill_records(self, connection, directory, columns, records):
        if not records:
            return
        availability = {}
        placeholders = ','.join('?' for _ in records)
        for cell in connection.execute(
                f'SELECT row_id,column_id,value,attachment_id,note_path FROM cells WHERE row_id IN ({placeholders})',
                list(records)):
            column_id = cell['column_id']
            if column_id in columns:
                records[cell['row_id']]['values'][column_id] = self._project_cell(
                    directory, cell, columns[column_id]['type'], availability)

    def read(self, note, query=None) -> dict:
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is None:
            return _missing()
        with self._connection(database) as connection:
            return self._snapshot(connection, database.parent, query)

    @staticmethod
    def _one(connection, sql, identity):
        row = connection.execute(sql, (_id(identity),)).fetchone()
        if row is None:
            raise NotesError('数据库项目不存在', status=404, code='not_found')
        return row

    def _set_cell(self, connection, directory, row, column_id, value, *, restoring=False):
        column = self._one(connection, 'SELECT id,type,choices FROM columns WHERE id=?', column_id)
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
            connection.execute('DELETE FROM cells WHERE row_id=? AND column_id=?', (row, column_id))
        else:
            connection.execute('''
                INSERT INTO cells(row_id,column_id,value,attachment_id,note_path,note_key)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(row_id,column_id) DO UPDATE SET value=excluded.value,
                    attachment_id=excluded.attachment_id, note_path=excluded.note_path, note_key=excluded.note_key
            ''', (row, column_id, value, attachment_id, note_path, note_key))

    @staticmethod
    def _old_values(connection, row):
        values = {}
        for cell in connection.execute('SELECT cells.*,columns.type FROM cells JOIN columns ON columns.id=column_id WHERE row_id=?', (row,)):
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

    def _record_patch(self, connection, directory, changes, *, restoring=False):
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
                connection.execute('INSERT INTO records(position,id) VALUES(?,?)', (position, row))
                inverse.append({'kind': 'delete', 'row': row})
                added = row
            else:
                stored = self._one(connection, 'SELECT id,position FROM records WHERE id=?', row)
                before = self._old_values(connection, row)
                if kind == 'delete':
                    connection.execute('DELETE FROM records WHERE id=?', (row,))
                    inverse.append({'kind': 'insert', 'row': row, 'position': stored['position'], 'values': before})
                    continue
                if kind != 'set':
                    raise NotesError('记录操作无效')
            values = change.get('values', {})
            if not isinstance(values, dict) or len(values) > MAX_COLUMNS:
                raise NotesError('数据库记录格式无效')
            for column, value in values.items():
                self._set_cell(connection, directory, row, column, value, restoring=restoring)
            if kind == 'set':
                inverse.append({'kind': 'set', 'row': row, 'values': {column: before.get(column) for column in values}})
        return {'inverse': inverse[::-1], 'addedId': added}

    def _change_options(self, connection, column, action):
        if column['type'] not in CHOICE_TYPES:
            raise NotesError('该字段没有选项')
        supplied = action.get('choices')
        if not isinstance(supplied, list) or len(supplied) > MAX_OPTIONS:
            raise NotesError('最多支持 64 个选项')
        existing = {option['id'] for option in json.loads(column['choices'])}
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
            choices.append({'id': identity, 'name': name})
        removed = existing - ids
        if removed:
            cells = connection.execute('SELECT row_id,value FROM cells WHERE column_id=?', (column['id'],)).fetchall()
            for cell in cells:
                before = json.loads(cell['value']) if column['type'] == 'multiSelect' else [cell['value']]
                after = [identity for identity in before if identity not in removed]
                if len(after) != len(before):
                    if action.get('clearRemoved') is not True:
                        raise NotesError('请确认清除表格中已使用的选项', status=409, code='options_in_use')
                    if after:
                        connection.execute('UPDATE cells SET value=? WHERE row_id=? AND column_id=?',
                                           (json.dumps(after, separators=(',', ':')), cell['row_id'], column['id']))
                    else:
                        connection.execute('DELETE FROM cells WHERE row_id=? AND column_id=?', (cell['row_id'], column['id']))
        connection.execute('UPDATE columns SET choices=? WHERE id=?', (json.dumps(choices, ensure_ascii=False), column['id']))

    def _change(self, connection, directory, action, query):
        kind = action['type']
        if kind == 'addColumn':
            column_type = action.get('columnType')
            if not isinstance(column_type, str) or column_type not in COLUMN_TYPES:
                raise NotesError('数据库列类型无效')
            if connection.execute('SELECT count(*) FROM columns').fetchone()[0] >= MAX_COLUMNS:
                raise NotesError('数据库最多支持 32 列')
            identity = _identity()
            connection.execute('''INSERT INTO columns(id,name,type,display_order)
                SELECT ?,?,?,COALESCE(MAX(COALESCE(display_order,position)),0)+1 FROM columns''',
                (identity, _text(action.get('name'), 120, required=True).strip(), column_type))
            if column_type == 'status':
                names = ['Not started', 'In progress', 'Done'] if action.get('language') == 'en' else ['未开始', '进行中', '已完成']
                choices = [{'id': _identity(), 'name': name} for name in names]
                connection.execute('UPDATE columns SET choices=? WHERE id=?', (json.dumps(choices, ensure_ascii=False), identity))
            return {'addedColumn': identity}
        elif kind == 'renameColumn':
            column = self._one(connection, 'SELECT id FROM columns WHERE id=?', action.get('column'))
            connection.execute('UPDATE columns SET name=? WHERE id=?',
                               (_text(action.get('name'), 120, required=True).strip(), column['id']))
        elif kind == 'deleteColumn':
            column = self._one(connection, 'SELECT id,hidden FROM columns WHERE id=?', action.get('column'))
            if not column['hidden'] and connection.execute('SELECT count(*) FROM columns WHERE hidden=0').fetchone()[0] <= 1:
                raise NotesError('数据库至少需要保留一列')
            connection.execute('DELETE FROM columns WHERE id=?', (column['id'],))
        elif kind in ('columnLayout', 'setChoices'):
            column = self._one(connection, 'SELECT id,type,hidden,choices FROM columns WHERE id=?', action.get('column'))
            if kind == 'setChoices':
                self._change_options(connection, column, action)
            if 'width' in action and kind == 'columnLayout':
                width = action['width']
                if type(width) is not int or not 96 <= width <= 640:
                    raise NotesError('列宽无效')
                connection.execute('UPDATE columns SET width=? WHERE id=?', (width, column['id']))
            if 'hidden' in action and kind == 'columnLayout':
                hidden = action['hidden']
                if type(hidden) is not bool:
                    raise NotesError('列可见性无效')
                if hidden and not column['hidden'] and connection.execute('SELECT count(*) FROM columns WHERE hidden=0').fetchone()[0] <= 1:
                    raise NotesError('数据库至少需要保留一列可见')
                connection.execute('UPDATE columns SET hidden=? WHERE id=?', (hidden, column['id']))
            if 'order' in action and kind == 'columnLayout':
                order = action['order']
                ids = {item[0] for item in connection.execute('SELECT id FROM columns')}
                if not isinstance(order, list) or len(order) != len(ids) or {_id(value) for value in order} != ids:
                    raise NotesError('字段顺序无效')
                connection.executemany('UPDATE columns SET display_order=? WHERE id=?', enumerate(order, 1))
        elif kind == 'addRow':
            return self._record_patch(connection, directory, [{'kind': 'insert', 'values': action.get('values', {})}])
        elif kind in ('deleteRow', 'setCell'):
            change = {'kind': 'delete' if kind == 'deleteRow' else 'set', 'row': action.get('row')}
            if kind == 'setCell':
                change['values'] = {_id(action.get('column')): action.get('value')}
            return self._record_patch(connection, directory, [change])
        elif kind == 'applyRecords':
            return self._record_patch(connection, directory, action.get('changes'), restoring=True)
        elif kind == 'batchCells':
            page = self._snapshot(connection, directory, query, include_values=False)
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
            return self._record_patch(connection, directory, patches)
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
    def _validate_recycle_directory(directory):
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

    def action(self, note, action, query=None, recycle=None) -> dict:
        if not isinstance(action, dict) or not isinstance(action.get('type'), str):
            raise NotesError('数据库操作格式无效')
        if query is not None and not isinstance(query, dict):
            raise NotesError('数据库查询格式无效')
        kind = action['type']
        relative, path, content = self._note(note, read_body=kind in ('create', 'previewCleanup', 'cleanup'))
        database = self._database_path(path)
        if kind == 'searchAttachments':
            return self._search(relative, database, action.get('query', ''))
        if kind == 'create':
            if action.get('expectedNoteRevision') not in (None, _revision(content)):
                raise NotesError('笔记已修改，请刷新后重试', status=409, code='revision_conflict')
            if not has_database_fence(self.store._decode_note(content)):
                raise NotesError('请先保存数据库占位', status=409, code='database_marker_missing')
            self.ensure_for_saved_note(path)
            return self.read(relative, query)
        if database is None:
            if kind == 'previewCleanup':
                return {'count': 0, 'revision': None, 'candidateToken': None}
            raise NotesError('数据库已移除，请刷新后重试', status=409, code='revision_conflict')
        if kind == 'delete':
            with self._connection(database) as connection:
                self._require_revision(connection, action.get('revision'))
            self._validate_recycle_directory(database.parent)
            self._recycle(recycle, [database.parent])
            return _missing()
        if kind in ('previewCleanup', 'cleanup') and not has_database_fence(self.store._decode_note(content)):
            raise NotesError('请先保存数据库占位', status=409, code='database_marker_missing')
        if kind == 'previewCleanup':
            with self._connection(database) as connection:
                candidates, token = self._unused(connection, database.parent)
                return {'count': len(candidates), 'revision': self._current_revision(connection),
                        'candidateToken': token}
        with self._connection(database, 'rw') as connection:
            self._require_revision(connection, action.get('revision'))
            if kind == 'cleanup':
                candidates, token = self._unused(connection, database.parent)
                if token != action.get('candidateToken'):
                    raise NotesError('附件候选已变化，请重新确认', status=409, code='revision_conflict')
                # Validate the display query before any filesystem side effect.
                result = self._snapshot(connection, database.parent, query)
                self._recycle(recycle, [target for _, target in candidates])
                connection.executemany('DELETE FROM attachments WHERE id=?', [(identity,) for identity, _ in candidates])
                result['deletedCount'] = len(candidates)
                result['revision'] = self._touch(connection)
                for _, target in candidates:
                    try:
                        target.parent.rmdir()
                    except OSError:
                        pass
            else:
                extra = self._change(connection, database.parent, action, query)
                self._touch(connection)
                last_page = kind == 'addRow' and action.get('focusAdded') is True and not any(
                    (query or {}).get(key) for key in ('search', 'filters', 'sort'))
                result = self._snapshot(connection, database.parent, query, last_page=last_page)
                row = extra.get('addedId') if kind == 'addRow' else action.get('row') if kind == 'setCell' and action.get('includeRow') is True else None
                if row:
                    record = next((item for item in result['rows'] if item['id'] == row), None)
                    if record is None:
                        record = {'id': row, 'values': {}}
                        columns = {column['id']: column for column in result['columns']}
                        self._fill_records(connection, database.parent, columns, {row: record})
                    extra['addedRow' if kind == 'addRow' else 'updatedRow'] = record
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

    def _import(self, connection, directory, source_name, content, digest, query):
        known = connection.execute('SELECT id,name FROM attachments WHERE digest=? AND source_name=?',
                                   (digest, source_name))
        if any(self._file_available(directory, row['id'], row['name']) for row in known):
            return self._snapshot(connection, directory, query)
        name = self._unique_attachment_name(connection, source_name)
        identity = _identity()
        target = self._attachment_path(directory, identity, name)
        try:
            self.store.atomic_bytes(target, content)
            connection.execute('INSERT INTO attachments VALUES(?,?,?,?,?)',
                               (identity, name, _key(name), source_name, digest))
            self._touch(connection)
            result = self._snapshot(connection, directory, query)
            connection.commit()
        except Exception:
            target.unlink(missing_ok=True)
            try:
                target.parent.rmdir()
            except OSError:
                pass
            raise
        return result

    def import_file(self, note, name, content, query=None) -> dict:
        name = self._attachment_name(name)
        if not isinstance(content, bytes):
            raise NotesError('附件内容无效')
        if len(content) > MAX_DATABASE_ATTACHMENT_BYTES:
            raise NotesError('数据库附件最大 100 MiB', status=413, code='too_large')
        digest = hashlib.sha256(content).hexdigest()
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is not None:
            with self._connection(database, 'rw') as connection:
                return self._import(connection, database.parent, name, content, digest, query)
        directory, stage = self._new_directory(path)
        try:
            with self._connection(stage / DATABASE_FILENAME, 'rwc') as connection:
                self._initialize(connection)
                result = self._import(connection, stage, name, content, digest, query)
            stage.rename(directory)
        finally:
            shutil.rmtree(stage, ignore_errors=True)
        return result

    def resolve_attachment(self, note, identity) -> Path:
        _, path, _ = self._note(note)
        database = self._database_path(path)
        if database is None:
            raise NotesError('附件不存在', status=404, code='not_found')
        with self._connection(database) as connection:
            row = self._one(connection, 'SELECT id,name FROM attachments WHERE id=?', identity)
        target = self._attachment_path(database.parent, row['id'], row['name'])
        if not _check_path(target):
            raise NotesError('附件不存在', status=404, code='not_found')
        return target

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
                        'SELECT row_id,column_id,note_path FROM cells WHERE note_key=? OR (note_key>=? AND note_key<?)',
                        (source_key, prefix, source_key + '0'),
                    ).fetchall()
                    if not references:
                        continue
                    backup = stage / ('database-' + str(len(changes)) + '.bak')
                    with closing(sqlite3.connect(backup)) as target:
                        connection.backup(target)
                    changes.append((after, backup, references, self._current_revision(connection)))
            except (NotesError, OSError, sqlite3.Error):
                if references:
                    raise
                warnings.append(f'无法检查笔记的数据库链接：{before}')
        return changes

    def apply_move(self, changes, source, destination, applied):
        for note, backup, references, revision in changes:
            database = self._database_path(self.store._absolute(note))
            if database is None:
                raise NotesError('移动期间数据库已变化，请重试', status=409, code='revision_conflict')
            with self._connection(database, 'rw') as connection:
                self._require_revision(connection, revision)
                updates = []
                for row in references:
                    suffix = PurePosixPath(row['note_path']).parts[len(PurePosixPath(source).parts):]
                    path = PurePosixPath(destination, *suffix).as_posix()
                    updates.append((path, _key(path), PurePosixPath(path).name, row['row_id'], row['column_id']))
                connection.executemany('UPDATE cells SET note_path=?,note_key=?,value=? WHERE row_id=? AND column_id=?', updates)
                self._touch(connection)
            applied.append((database, backup))

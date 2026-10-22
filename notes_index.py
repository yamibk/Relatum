"""Rebuildable SQLite note catalog. Markdown files remain authoritative.

Only this module owns SQL, FTS and cache maintenance. Reader connections never
take the Markdown mutation lock; a short writer transaction publishes a change.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
import urllib.parse
import zlib
from functools import lru_cache
from contextlib import contextmanager, nullcontext
from pathlib import Path, PurePosixPath

from note_search import normalize, short_grams, terms, match_expression, hit, literal_ranges

VERSION = 7
APPLICATION_ID = 0x524E4931
CHANGE_LIMIT = 8192


def book_root(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if len(parts) >= 2 and parts[0].casefold() == "customnotebook" else ""


@lru_cache(maxsize=8192)
def natural(value):
    import re
    return tuple((1, int(piece)) if piece.isdigit() else (0, normalize(piece))
                 for piece in re.split(r"(\d+)", value))


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class NoteIndex:
    def __init__(self, path, root, *, persistent=True):
        self.path, self.root = Path(path), Path(root)
        self._lock = threading.RLock()
        self._writer = None
        self._closed = False
        self._persistent = persistent
        self._initialized = False

    def _open(self):
        if self._writer is not None:
            return
        with self._lock:
            if self._writer is not None:
                return
            if self._closed:
                raise RuntimeError("笔记索引已关闭")
            from notes_library import _is_reparse
            if _is_reparse(self.path) or _is_reparse(self.path.parent):
                raise RuntimeError('笔记索引不能是链接或重解析点')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self._initialized:
                conn = self._connect()
                conn.create_function('short_grams', 1, short_grams, deterministic=True)
                self._writer = conn
                return
            try:
                conn = self._connect()
                version = conn.execute("PRAGMA user_version").fetchone()[0]
                rebuild = version not in (0, VERSION)
                application = conn.execute('PRAGMA application_id').fetchone()[0]
                if version and application != APPLICATION_ID:
                    rebuild = True
                if version == VERSION and not rebuild:
                    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    rebuild = not {'settings', 'books', 'entries', 'refs', 'tags', 'tag_counts', 'changes', 'text_fts', 'short_fts'} <= tables
                identity = os.path.normcase(str(self.root.resolve()))
                if version == VERSION and not rebuild:
                    owner = conn.execute("SELECT value FROM settings WHERE key='root'").fetchone()
                    rebuild = not owner or owner[0] != identity
                if not rebuild:
                    rebuild = conn.execute("PRAGMA quick_check").fetchone()[0] != 'ok'
            except sqlite3.DatabaseError as error:
                if getattr(error, 'sqlite_errorcode', 0) & 255 not in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
                    if 'conn' in locals():
                        conn.close()
                    raise
                rebuild = True
            if rebuild:
                if 'conn' in locals():
                    conn.close()
                # Only this private, rebuildable cache and its SQLite sidecars.
                for suffix in ("", "-wal", "-shm"):
                    candidate = Path(str(self.path) + suffix)
                    if candidate.exists():
                        candidate.replace(candidate.with_name(candidate.name + ".discarded-" + uuid.uuid4().hex))
                conn = self._connect()
            conn.create_function("short_grams", 1, short_grams, deterministic=True)
            if sqlite3.sqlite_version_info < (3, 43, 0):
                conn.close()
                raise RuntimeError("笔记索引需要 SQLite 3.43 或更新版本及 FTS5")
            conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            conn.execute('PRAGMA application_id=' + str(APPLICATION_ID))
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS books(
                    id TEXT PRIMARY KEY,root TEXT NOT NULL,key TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
                    graph_version INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,
                    indexed INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,source_identity TEXT NOT NULL DEFAULT '');
                CREATE UNIQUE INDEX IF NOT EXISTS books_root ON books(key) WHERE deleted=0;
                CREATE TABLE IF NOT EXISTS entries(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,book TEXT NOT NULL REFERENCES books(id),
                    path TEXT NOT NULL,key TEXT NOT NULL,parent TEXT NOT NULL,kind TEXT NOT NULL,
                    name TEXT NOT NULL,stem_key TEXT NOT NULL,path_stem_key TEXT NOT NULL,
                    modified INTEGER NOT NULL,created INTEGER NOT NULL,size INTEGER NOT NULL,
                    revision TEXT NOT NULL DEFAULT '',metadata TEXT NOT NULL DEFAULT '{}',
                    title TEXT NOT NULL,search_path TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',
                    source_map BLOB,error TEXT NOT NULL DEFAULT '',needs_sync INTEGER NOT NULL DEFAULT 1,UNIQUE(book,key));
                CREATE INDEX IF NOT EXISTS entries_path ON entries(key,book);
                CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent,kind,name,key);
                CREATE INDEX IF NOT EXISTS entries_parent_count ON entries(parent,kind,book);
                CREATE INDEX IF NOT EXISTS entries_parent_name_asc ON entries(parent,kind,name COLLATE NOTE_NATURAL ASC,key);
                CREATE INDEX IF NOT EXISTS entries_parent_name_desc ON entries(parent,kind,name COLLATE NOTE_NATURAL DESC,key);
                CREATE INDEX IF NOT EXISTS entries_parent_modified_asc ON entries(parent,kind,modified ASC,key);
                CREATE INDEX IF NOT EXISTS entries_parent_modified_desc ON entries(parent,kind,modified DESC,key);
                CREATE INDEX IF NOT EXISTS entries_parent_created_asc ON entries(parent,kind,created ASC,key);
                CREATE INDEX IF NOT EXISTS entries_parent_created_desc ON entries(parent,kind,created DESC,key);
                CREATE INDEX IF NOT EXISTS entries_book_modified ON entries(book,kind,modified DESC,key);
                CREATE INDEX IF NOT EXISTS entries_stem ON entries(stem_key,kind,book);
                CREATE INDEX IF NOT EXISTS entries_exact ON entries(path_stem_key,kind,book);
                CREATE INDEX IF NOT EXISTS entries_pending ON entries(revision,kind,book);
                CREATE INDEX IF NOT EXISTS entries_sync ON entries(needs_sync,kind,book);
                CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind,key);
                CREATE INDEX IF NOT EXISTS entries_query ON entries(id,kind,book,title,search_path,modified,key,created,name,revision);
                CREATE TRIGGER IF NOT EXISTS book_entry_insert AFTER INSERT ON entries WHEN NEW.kind='note' BEGIN
                    UPDATE books SET total=total+1,indexed=indexed+(NEW.revision!=''),errors=errors+(NEW.error!='') WHERE id=NEW.book;
                END;
                CREATE TRIGGER IF NOT EXISTS book_entry_delete AFTER DELETE ON entries WHEN OLD.kind='note' BEGIN
                    UPDATE books SET total=total-1,indexed=indexed-(OLD.revision!=''),errors=errors-(OLD.error!='') WHERE id=OLD.book;
                END;
                CREATE TRIGGER IF NOT EXISTS book_entry_update AFTER UPDATE OF revision,error,book ON entries WHEN NEW.kind='note' BEGIN
                    UPDATE books SET total=total-1,indexed=indexed-(OLD.revision!=''),errors=errors-(OLD.error!='') WHERE id=OLD.book;
                    UPDATE books SET total=total+1,indexed=indexed+(NEW.revision!=''),errors=errors+(NEW.error!='') WHERE id=NEW.book;
                END;
                CREATE TABLE IF NOT EXISTS tags(
                    entry INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                    book TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,
                    PRIMARY KEY(entry,key));
                CREATE INDEX IF NOT EXISTS tags_lookup ON tags(key,book,entry);
                CREATE TABLE IF NOT EXISTS tag_counts(
                    book TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,count INTEGER NOT NULL,
                    PRIMARY KEY(book,key));
                CREATE TRIGGER IF NOT EXISTS tags_insert AFTER INSERT ON tags BEGIN
                    INSERT INTO tag_counts VALUES(NEW.book,NEW.key,NEW.label,1)
                        ON CONFLICT(book,key) DO UPDATE SET count=count+1;
                END;
                CREATE TRIGGER IF NOT EXISTS tags_delete AFTER DELETE ON tags BEGIN
                    UPDATE tag_counts SET count=count-1 WHERE book=OLD.book AND key=OLD.key;
                    DELETE FROM tag_counts WHERE book=OLD.book AND key=OLD.key AND count<=0;
                END;
                CREATE TABLE IF NOT EXISTS refs(
                    id INTEGER PRIMARY KEY,entry INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                    consumer TEXT NOT NULL,lookup TEXT NOT NULL,payload TEXT NOT NULL,
                    resolved INTEGER REFERENCES entries(id) ON DELETE SET NULL,
                    state TEXT NOT NULL DEFAULT 'missing');
                CREATE INDEX IF NOT EXISTS refs_entry ON refs(entry,consumer);
                CREATE INDEX IF NOT EXISTS refs_lookup ON refs(consumer,lookup,entry);
                CREATE INDEX IF NOT EXISTS refs_target ON refs(consumer,resolved,entry);
                CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(
                    title,search_path,body,content='entries',content_rowid='id',tokenize='trigram');
                CREATE VIRTUAL TABLE IF NOT EXISTS short_fts USING fts5(
                    title,search_path,body,content='',contentless_delete=1,detail=none,tokenize='ascii');
                CREATE TRIGGER IF NOT EXISTS entry_insert AFTER INSERT ON entries WHEN NEW.kind='note' BEGIN
                    INSERT INTO text_fts(rowid,title,search_path,body) VALUES(NEW.id,NEW.title,NEW.search_path,NEW.body);
                    INSERT INTO short_fts(rowid,title,search_path,body)
                        VALUES(NEW.id,short_grams(NEW.title),short_grams(NEW.search_path),short_grams(NEW.body));
                END;
                CREATE TRIGGER IF NOT EXISTS entry_delete AFTER DELETE ON entries WHEN OLD.kind='note' BEGIN
                    INSERT INTO text_fts(text_fts,rowid,title,search_path,body)
                        VALUES('delete',OLD.id,OLD.title,OLD.search_path,OLD.body);
                    DELETE FROM short_fts WHERE rowid=OLD.id;
                END;
                CREATE TRIGGER IF NOT EXISTS entry_search_update AFTER UPDATE OF title,search_path,body ON entries
                    WHEN NEW.kind='note' AND (NEW.title!=OLD.title OR NEW.search_path!=OLD.search_path OR NEW.body!=OLD.body) BEGIN
                    INSERT INTO text_fts(text_fts,rowid,title,search_path,body)
                        VALUES('delete',OLD.id,OLD.title,OLD.search_path,OLD.body);
                    DELETE FROM short_fts WHERE rowid=OLD.id;
                    INSERT INTO text_fts(rowid,title,search_path,body) VALUES(NEW.id,NEW.title,NEW.search_path,NEW.body);
                    INSERT INTO short_fts(rowid,title,search_path,body)
                        VALUES(NEW.id,short_grams(NEW.title),short_grams(NEW.search_path),short_grams(NEW.body));
                END;
                CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT NOT NULL,removed INTEGER NOT NULL,item TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            """)
            conn.execute("PRAGMA user_version=" + str(VERSION))
            identity = os.path.normcase(str(self.root.resolve()))
            previous = conn.execute("SELECT value FROM settings WHERE key='root'").fetchone()
            if previous and previous[0] != identity:
                conn.close()
                raise RuntimeError("笔记索引属于不同的数据根")
            conn.execute("INSERT OR IGNORE INTO settings VALUES('root',?)", (identity,))
            conn.execute("INSERT OR IGNORE INTO settings VALUES('generation','0')")
            conn.execute("INSERT OR IGNORE INTO settings VALUES('directory_generation','0')")
            conn.commit()
            self._writer = conn
            self._initialized = True

    def _connect(self):
        conn = sqlite3.connect(str(self.path), timeout=5, check_same_thread=False)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA cache_size=-16384")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA temp_store=MEMORY")
            conn.create_collation("NOTE_NATURAL", lambda a, b: (natural(a) > natural(b)) - (natural(a) < natural(b)))
        except BaseException:
            conn.close()
            raise
        return conn

    @contextmanager
    def read(self):
        self._open()
        conn = self._connect()
        conn.execute("BEGIN")
        try:
            yield conn
        finally:
            conn.rollback(); conn.close()
            self._release_writer()

    def _release_writer(self):
        if not self._persistent:
            with self._lock:
                if self._writer is not None and not self._writer.in_transaction:
                    self._writer.close(); self._writer = None

    @contextmanager
    def write(self):
        self._open()
        with self._lock:
            conn = self._writer
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback(); raise
            finally:
                self._release_writer()

    @staticmethod
    def _book(conn, root):
        key = normalize(root)
        row = conn.execute("SELECT id FROM books WHERE key=? AND deleted=0", (key,)).fetchone()
        if row:
            return row[0]
        identity = uuid.uuid4().hex
        conn.execute("INSERT INTO books(id,root,key) VALUES(?,?,?)", (identity, root, key))
        return identity

    def source_identity(self, root):
        with self.read() as conn:
            row = conn.execute('SELECT source_identity FROM books WHERE key=? AND deleted=0', (normalize(root),)).fetchone()
            return row[0] if row else ''

    def identify(self, root, source_identity):
        with self.write() as conn:
            book = self._book(conn, root)
            conn.execute('UPDATE books SET source_identity=? WHERE id=?', (source_identity, book))

    @staticmethod
    def entry(row):
        result = {"kind": row['kind'], "name": row['name'], "path": row['path']}
        if row['kind'] == 'note':
            result.update(fileName=PurePosixPath(row['path']).name, modifiedNs=row['modified'],
                          createdNs=row['created'], size=row['size'], revision=row['revision'])
        else:
            result['children'] = []
        return result

    def _change(self, conn, row=None, path=None, content=False):
        value = self.entry(row) if row else {}
        if content:
            value['contentChanged'] = True
        cursor = conn.execute("INSERT INTO changes(path,removed,item) VALUES(?,?,?)",
                              (row['path'] if row else path, int(row is None), dump(value)))
        conn.execute("UPDATE settings SET value=? WHERE key='generation'", (str(cursor.lastrowid),))
        if not content:
            conn.execute("UPDATE settings SET value=? WHERE key='directory_generation'", (str(cursor.lastrowid),))
        if row:
            conn.execute("UPDATE books SET version=version+1 WHERE id=?", (row['book'],))

    def register(self, records, *, verify=False):
        """Publish directory metadata before parsing bodies; return changed notes."""
        pending = []
        changed_keys = set()
        with self.write() as conn:
            for path, kind, modified, created, size in records:
                root = book_root(path)
                book = self._book(conn, root)
                key = normalize(path)
                previous = conn.execute("SELECT path,modified,size,kind,revision,needs_sync,error FROM entries WHERE book=? AND key=?", (book, key)).fetchone()
                if previous and previous['kind'] != kind:
                    old = previous['path']
                    conn.execute('DELETE FROM entries WHERE book=? AND key=?', (book, key))
                    self._change(conn, path=old)
                    if previous['kind'] == 'note':
                        changed_keys.update((normalize(PurePosixPath(old).stem), normalize(old[:-3])))
                        conn.execute('UPDATE books SET graph_version=graph_version+1 WHERE id=?', (book,))
                    previous = None
                name = PurePosixPath(path).stem if kind == 'note' else PurePosixPath(path).name
                parent = str(PurePosixPath(path).parent)
                parent = '' if parent == '.' else parent
                if previous and previous['modified'] == modified and previous['size'] == size \
                        and previous['path'] == path and previous['kind'] == kind:
                    if kind == 'note' and (previous['needs_sync'] or previous['error'] or verify):
                        if (verify or previous['error']) and not previous['needs_sync']:
                            conn.execute('UPDATE entries SET needs_sync=1 WHERE book=? AND key=?', (book, key))
                        pending.append((path, book))
                    continue
                conn.execute("""INSERT INTO entries(book,path,key,parent,kind,name,stem_key,path_stem_key,
                    modified,created,size,title,search_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(book,key) DO UPDATE SET path=excluded.path,parent=excluded.parent,
                    modified=excluded.modified,created=excluded.created,size=excluded.size,
                    name=excluded.name,title=excluded.title,search_path=excluded.search_path,needs_sync=1""",
                    (book, path, key, normalize(parent), kind, name, normalize(name),
                     normalize(path[:-3] if kind == 'note' else path), modified, created, size,
                     normalize(name), normalize(path)))
                row = conn.execute("SELECT book,path,kind,name,modified,created,size,revision FROM entries WHERE book=? AND key=?", (book, key)).fetchone()
                if previous and previous['path'] != path:
                    self._change(conn, path=previous['path'])
                if kind == 'note' or not previous or previous['path'] != path or previous['kind'] != kind:
                    self._change(conn, row)
                if kind == 'note':
                    pending.append((path, book))
                    if not previous or previous['path'] != path:
                        conn.execute("UPDATE books SET graph_version=graph_version+1 WHERE id=?", (book,))
                        changed_keys.update((normalize(name), normalize(path[:-3])))
            if changed_keys:
                self._resolve(conn, keys=list(changed_keys))
            self._trim(conn)
        return pending

    def _trim(self, conn):
        generation = int(conn.execute("SELECT value FROM settings WHERE key='generation'").fetchone()[0])
        conn.execute("DELETE FROM changes WHERE seq<?", (generation - CHANGE_LIMIT,))

    def document(self, path):
        with self.read() as conn:
            row = conn.execute("SELECT e.path,e.kind,e.revision,e.metadata,e.modified,e.size FROM entries e JOIN books b ON b.id=e.book WHERE e.key=? AND b.deleted=0",
                               (normalize(path),)).fetchone()
            if not row or row['kind'] != 'note' or not row['revision']:
                return None
            result = json.loads(row['metadata'])
            result.update(path=row['path'], revision=row['revision'], signature=(row['modified'], row['size']))
            return result

    def record(self, path, revision, metadata, body, mapping, signature, book=None, valid=None):
        with self.write() as conn:
            if valid is not None and not valid():
                return False
            row = conn.execute("SELECT e.* FROM entries e JOIN books b ON b.id=e.book WHERE e.key=? AND b.deleted=0",
                               (normalize(path),)).fetchone()
            if row is None or row['kind'] != 'note' or book and row['book'] != book:
                return False
            old = json.loads(row['metadata'])
            if revision == row['revision'] and metadata == old:
                conn.execute("UPDATE entries SET modified=?,size=?,error='',needs_sync=0 WHERE id=?", (*signature, row['id']))
                return True
            conn.execute("UPDATE entries SET revision=?,metadata=?,body=?,source_map=?,modified=?,size=?,error='',needs_sync=0 WHERE id=?",
                         (revision, dump(metadata), body, zlib.compress(dump(mapping).encode('utf-8')),
                          *signature, row['id']))
            conn.execute("DELETE FROM tags WHERE entry=?", (row['id'],))
            expanded = {}
            for tag in metadata.get('tags', []):
                keys, labels = tag['key'].split('/'), tag['label'].split('/')
                for depth in range(1, len(keys) + 1):
                    expanded['/'.join(keys[:depth])] = '/'.join(labels[:depth])
            conn.executemany("INSERT INTO tags VALUES(?,?,?,?)",
                             [(row['id'], row['book'], key, label) for key, label in expanded.items()])
            conn.execute("DELETE FROM refs WHERE entry=?", (row['id'],))
            values = []
            for mention in metadata.get('mentions', []):
                target = urllib.parse.unquote(mention['base'].strip()).replace('\\', '/').strip('/')
                if target.lower().endswith('.md'):
                    target = target[:-3]
                if not target or target.startswith('.') or '/../' in '/' + target + '/':
                    target = 'invalid:' + target
                values.append((row['id'], 'wiki', normalize(target), dump(mention)))
            for target in metadata.get('canvasTargets', []):
                values.append((row['id'], 'canvas', normalize(target), dump({'target': target})))
            conn.executemany("INSERT INTO refs(entry,consumer,lookup,payload) VALUES(?,?,?,?)", values)
            self._resolve(conn, entry=row['id'])
            if old.get('graphReferences') != metadata.get('graphReferences'):
                conn.execute("UPDATE books SET graph_version=graph_version+1 WHERE id=?", (row['book'],))
            fresh = conn.execute("SELECT * FROM entries WHERE id=?", (row['id'],)).fetchone()
            self._change(conn, fresh, content=True); self._trim(conn)
            return True

    def verified(self, path, signature, book=None, valid=None):
        with self.write() as conn:
            if valid is not None and not valid():
                return
            conn.execute("UPDATE entries SET modified=?,size=?,error='',needs_sync=0 WHERE key=? AND book IN (SELECT id FROM books WHERE deleted=0)"
                + (' AND book=?' if book else ''), [*signature, normalize(path)] + ([book] if book else []))

    def pending(self, limit=256, scope=None):
        with self.read() as conn:
            where, args = ["b.deleted=0", "e.kind='note'", 'e.needs_sync=1'], []
            if scope is not None:
                if scope == '' or book_root(scope) == scope:
                    where.append('b.key=?'); args.append(normalize(scope))
                else:
                    key = normalize(scope)
                    where.append('(e.key=? OR e.key>=? AND e.key<?)'); args.extend([key, key + '/', key + '/\U0010ffff'])
            return [(row[0], row[1]) for row in conn.execute('SELECT e.path,e.book FROM entries e JOIN books b ON b.id=e.book WHERE '
                + ' AND '.join(where) + ' LIMIT ?', args + [limit])]

    def mark_pending(self, paths):
        keys = [normalize(path) for path in paths]
        for begin in range(0, len(keys), 128):
            group = keys[begin:begin + 128]
            with self.write() as conn:
                conn.execute("UPDATE entries SET needs_sync=1 WHERE kind='note' AND key IN (" + ','.join('?' for _ in group) + ')', group)

    @staticmethod
    def _resolve(conn, entry=None, keys=None):
        suffix, arguments = '', []
        if entry is not None:
            suffix = " AND entry=?"; arguments = [entry]
        elif keys:
            suffix = " AND lookup IN (" + ','.join('?' for _ in keys) + ')'; arguments = list(keys)
        conn.execute("""UPDATE refs SET resolved=COALESCE(
            (SELECT e.id FROM entries e JOIN books b ON b.id=e.book
             WHERE e.kind='note' AND b.deleted=0 AND e.path_stem_key=refs.lookup LIMIT 1),
            (SELECT MIN(e.id) FROM entries e JOIN books b ON b.id=e.book
             WHERE e.kind='note' AND b.deleted=0 AND e.stem_key=refs.lookup HAVING COUNT(*)=1))
            WHERE consumer='wiki'""" + suffix, arguments)
        conn.execute("""UPDATE refs SET state=CASE WHEN resolved IS NOT NULL THEN 'resolved'
            WHEN (SELECT COUNT(*) FROM entries e JOIN books b ON b.id=e.book
                  WHERE b.deleted=0 AND e.kind='note' AND e.stem_key=refs.lookup)>1
            THEN 'ambiguous' WHEN lookup GLOB 'invalid:*' THEN 'invalid' ELSE 'missing' END WHERE consumer='wiki'""" + suffix, arguments)

    def resolve(self, keys=None):
        with self.write() as conn:
            self._resolve(conn, keys=keys)

    def error(self, path, message):
        with self.write() as conn:
            conn.execute("UPDATE entries SET error=?,needs_sync=0 WHERE key=?", (message[:500], normalize(path)))

    def rows(self, scope=None, *, folders=False, directory=False):
        with self.read() as conn:
            if directory and scope:
                key = normalize(scope)
                condition, args = ' AND (e.key=? OR e.key>=? AND e.key<?)', [key, key + '/', key + '/\U0010ffff']
            else:
                condition, args = self.scope(scope)
            return [dict(row) for row in conn.execute("SELECT e.id,e.book,e.path,e.key,e.parent,e.kind,e.name,e.stem_key,e.path_stem_key,e.modified,e.created,e.size,e.revision,e.error FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 "
                    + ("" if folders else "AND e.kind='note' ") + condition, args)]

    @staticmethod
    def scope(scope):
        if scope is None:
            return '', []
        return ' AND b.key=?', [normalize(scope)]

    def documents(self, scope=None, *, snapshot=False):
        # Parsed metadata only: bodies stay on disk and are not retained in RAM.
        with self.read() as conn:
            condition, args = self.scope(scope)
            identity = conn.execute('SELECT id,graph_version FROM books WHERE key=? AND deleted=0', (normalize(scope or ''),)).fetchone() if snapshot else None
            result = {}
            for row in conn.execute("SELECT e.path,e.revision,e.metadata,e.modified,e.size FROM entries e "
                    "JOIN books b ON b.id=e.book WHERE b.deleted=0 AND e.kind='note' AND e.revision!=''" + condition + ' ORDER BY e.path COLLATE NOTE_NATURAL', args):
                value = json.loads(row['metadata'])
                value.update(path=row['path'], revision=row['revision'], signature=(row['modified'], row['size']))
                result[row['path']] = value
            return (result, tuple(identity) if identity else None) if snapshot else result

    def graph_pending(self, scope):
        with self.read() as conn:
            condition, args = self.scope(scope)
            return [(row[0], row[1]) for row in conn.execute("SELECT e.path,e.book FROM entries e JOIN books b ON b.id=e.book "
                "WHERE b.deleted=0 AND e.kind='note' AND e.revision!='' AND json_type(e.metadata,'$.graphReferences') IS NULL" + condition, args)]

    def status(self):
        with self.read() as conn:
            generation = int(conn.execute("SELECT value FROM settings WHERE key='generation'").fetchone()[0])
            counts = conn.execute("SELECT SUM(total),SUM(indexed),SUM(errors) FROM books WHERE deleted=0").fetchone()
            books = [dict(row) for row in conn.execute("SELECT id,root,version,graph_version AS graphVersion FROM books WHERE deleted=0 ORDER BY key")]
            pending = conn.execute("SELECT COUNT(*) FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 AND e.kind='note' AND e.needs_sync=1").fetchone()[0]
            return {'generation': generation, 'total': counts[0] or 0, 'indexed': counts[1] or 0,
                    'errors': counts[2] or 0, 'notebooks': books, 'pendingDocuments': pending}

    def book_version(self, scope):
        with self.read() as conn:
            row = conn.execute("SELECT id,graph_version FROM books WHERE key=? AND deleted=0", (normalize(scope),)).fetchone()
            return tuple(row) if row else None

    def changes(self, since):
        with self.read() as conn:
            generation = int(conn.execute("SELECT value FROM settings WHERE key='generation'").fetchone()[0])
            earliest = conn.execute("SELECT MIN(seq) FROM changes").fetchone()[0] or generation
            reset = since > generation or since and since < earliest - 1
            rows = [] if reset else [dict(row) for row in conn.execute("SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT 1000", (since,))]
            return {'generation': generation, 'reset': bool(reset),
                    'cursor': rows[-1]['seq'] if rows else generation,
                    'hasMore': bool(rows and rows[-1]['seq'] < generation),
                    'changes': [{'path': row['path'], 'removed': bool(row['removed']), 'item': json.loads(row['item'])} for row in rows]}

    def remove(self, path, *, notebook=False):
        key = normalize(path)
        with self.write() as conn:
            if notebook:
                book = conn.execute("SELECT id FROM books WHERE key=? AND deleted=0", (key,)).fetchone()
                if not book:
                    return
                conn.execute("UPDATE books SET deleted=1,version=version+1 WHERE id=?", (book[0],))
                self._change(conn, path=path)
                conn.execute("UPDATE refs SET resolved=NULL,state='missing' WHERE consumer='wiki' AND resolved IN (SELECT id FROM entries WHERE book=?)", (book[0],))
            else:
                rows = conn.execute("SELECT e.* FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 AND (e.key=? OR e.key>=? AND e.key<?)",
                                    (key, key + '/', key + '/\U0010ffff')).fetchall()
                keys = set()
                for row in rows:
                    keys.update((row['stem_key'], row['path_stem_key']))
                    conn.execute("DELETE FROM entries WHERE id=?", (row['id'],)); self._change(conn, path=row['path'])
                    conn.execute("UPDATE books SET graph_version=graph_version+1 WHERE id=?", (row['book'],))
                if keys:
                    self._resolve(conn, keys=list(keys))
            self._trim(conn)

    def remap(self, source, destination):
        key = normalize(source)
        with self.write() as conn:
            root = book_root(source)
            if root == source and root:
                conn.execute('UPDATE books SET root=?,key=?,version=version+1,graph_version=graph_version+1 WHERE key=? AND deleted=0',
                             (destination, normalize(destination), key))
            rows = conn.execute('SELECT e.id,e.book,e.path,e.kind,e.stem_key,e.path_stem_key FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 AND (e.key=? OR e.key>=? AND e.key<?)',
                                (key, key + '/', key + '/\U0010ffff')).fetchall()
            keys = set()
            for row in rows:
                path = destination + row['path'][len(source):]
                name = PurePosixPath(path).stem if row['kind'] == 'note' else PurePosixPath(path).name
                parent = str(PurePosixPath(path).parent)
                book = self._book(conn, book_root(path))
                path_stem = normalize(path[:-3] if row['kind'] == 'note' else path)
                keys.update((row['stem_key'], row['path_stem_key'], normalize(name), path_stem))
                # A directory notification can register the new path between
                # the filesystem rename and this transaction. Keep the original
                # entry identity and its parsed data; discard only the duplicate
                # derived row, redirecting any newly resolved incoming links.
                duplicate = conn.execute('SELECT id,stem_key,path_stem_key FROM entries WHERE book=? AND key=? AND id<>?',
                                         (book, normalize(path), row['id'])).fetchone()
                if duplicate:
                    keys.update((duplicate['stem_key'], duplicate['path_stem_key']))
                    conn.execute('UPDATE refs SET resolved=? WHERE resolved=?', (row['id'], duplicate['id']))
                    conn.execute('DELETE FROM entries WHERE id=?', (duplicate['id'],))
                conn.execute("UPDATE entries SET path=?,key=?,parent=?,name=?,stem_key=?,path_stem_key=?,book=?,title=?,search_path=?,needs_sync=1 WHERE id=?",
                    (path, normalize(path), '' if parent == '.' else normalize(parent), name, normalize(name), path_stem,
                     book, normalize(name), normalize(path), row['id']))
                if book != row['book']:
                    tags = conn.execute('SELECT key,label FROM tags WHERE entry=?', (row['id'],)).fetchall()
                    conn.execute('DELETE FROM tags WHERE entry=?', (row['id'],))
                    conn.executemany('INSERT INTO tags VALUES(?,?,?,?)', [(row['id'], book, tag[0], tag[1]) for tag in tags])
                self._change(conn, path=row['path'])
                fresh = conn.execute('SELECT book,path,kind,name,modified,created,size,revision FROM entries WHERE id=?', (row['id'],)).fetchone()
                self._change(conn, fresh)
                conn.execute('UPDATE books SET graph_version=graph_version+1 WHERE id IN (?,?)', (book, row['book']))
            if keys:
                self._resolve(conn, keys=list(keys))
            self._trim(conn)
            return [row['path'] for row in rows if row['kind'] == 'note']

    def maintenance(self, interrupted=None):
        with self.write() as conn:
            doomed = conn.execute("SELECT e.id,e.stem_key,e.path_stem_key FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=1 LIMIT 128").fetchall()
            removed = []
            for row in doomed:
                if interrupted and interrupted():
                    break
                conn.execute('DELETE FROM entries WHERE id=?', (row[0],)); removed.append(row)
            if removed:
                self._resolve(conn, keys=list({value for row in removed for value in (row[1], row[2])}))
            conn.execute("DELETE FROM books WHERE deleted=1 AND NOT EXISTS(SELECT 1 FROM entries WHERE entries.book=books.id)")
            if not interrupted or not interrupted():
                conn.execute("INSERT INTO text_fts(text_fts,rank) VALUES('merge',16)")
            if not interrupted or not interrupted():
                conn.execute("INSERT INTO short_fts(short_fts,rank) VALUES('merge',16)")
            if not interrupted or not interrupted():
                conn.execute("PRAGMA incremental_vacuum(64)").fetchall()
            free_pages = conn.execute('PRAGMA freelist_count').fetchone()[0]
        with self._lock:
            if self._writer is not None and (not interrupted or not interrupted()):
                self._writer.execute("PRAGMA wal_checkpoint(PASSIVE)")
        return bool(doomed or free_pages)

    def tags(self):
        with self.read() as conn:
            return {'items': [dict(row) for row in conn.execute("SELECT t.key,MIN(t.label) AS label,SUM(t.count) AS count "
                "FROM tag_counts t JOIN books b ON b.id=t.book WHERE b.deleted=0 GROUP BY t.key ORDER BY t.key")]}

    def links(self, path):
        with self.read() as conn:
            row = conn.execute("SELECT e.id,e.path,e.revision FROM entries e JOIN books b ON b.id=e.book WHERE e.key=? AND b.deleted=0", (normalize(path),)).fetchone()
            if not row:
                return None
            outgoing, backlinks, seen = [], [], set()
            for ref in conn.execute("SELECT r.*,e.path AS target FROM refs r LEFT JOIN entries e ON e.id=r.resolved WHERE r.entry=? AND consumer='wiki' ORDER BY r.id", (row['id'],)):
                mention = json.loads(ref['payload']); target = ref['target'] or ''
                identity = (target or normalize(mention['base']), ref['state'])
                if identity in seen:
                    continue
                seen.add(identity)
                outgoing.append({'label': mention['alias'] or PurePosixPath(mention['base']).name,
                    'rawTarget': mention['base'], 'path': target, 'state': ref['state'],
                    'line': mention['line'], 'excerpt': mention['excerpt']})
            for ref in conn.execute("SELECT e.path,r.payload FROM refs r JOIN entries e ON e.id=r.entry JOIN books b ON b.id=e.book "
                    "WHERE consumer='wiki' AND resolved=? AND r.entry!=? AND b.deleted=0 ORDER BY e.path COLLATE NOTE_NATURAL,r.id", (row['id'], row['id'])):
                mention = json.loads(ref['payload'])
                backlinks.append({'path': ref['path'], 'label': PurePosixPath(ref['path']).stem,
                                  'line': mention['line'], 'excerpt': mention['excerpt']})
            return {'path': row['path'], 'revision': row['revision'], 'outgoing': outgoing, 'backlinks': backlinks}

    def canvas_references(self, target=None, *, with_names=False):
        with self.read() as conn:
            sql = "SELECT e.path,r.lookup,r.payload FROM refs r JOIN entries e ON e.id=r.entry JOIN books b ON b.id=e.book WHERE b.deleted=0 AND consumer='canvas'"
            args = []
            if target is not None:
                sql += " AND r.lookup=?"; args = [normalize(target)]
            result, names = {}, {}
            for row in conn.execute(sql, args):
                result.setdefault(row['lookup'], set()).add(row['path'])
                names.setdefault(row['lookup'], json.loads(row['payload'])['target'])
            return (result, names) if with_names else result

    def query(self, body):
        if not isinstance(body, dict):
            raise ValueError('查询格式无效')
        mode = body.get('mode', 'paths' if 'paths' in body else 'tags' if 'tag' in body else 'search')
        if mode not in ('paths', 'tags', 'recent', 'search'):
            raise ValueError('查询类型无效')
        limit, offset = body.get('limit', 50), body.get('offset', 0)
        if type(limit) is not int or not 1 <= limit <= 50 or type(offset) is not int or offset < 0:
            raise ValueError('分页参数无效')
        words = terms(body.get('q', '')) if mode == 'search' else []
        scope = body.get('scope', {'kind': 'all'})
        if not isinstance(scope, dict) or scope.get('kind') not in ('all', 'notebook', 'folder'):
            raise ValueError('查询范围无效')
        where, args = ["b.deleted=0", "e.kind='note'"], []
        if scope['kind'] == 'notebook':
            where.append('b.key=?'); args.append(normalize(scope.get('path', '')))
        elif scope['kind'] == 'folder':
            folder = normalize(scope.get('path', ''))
            if folder:
                prefix = folder + '/'
                where.append('e.key>=? AND e.key<?'); args.extend((prefix, prefix + '\U0010ffff'))
            else:
                where.append("b.key=''")
        if mode == 'paths' or 'paths' in body:
            paths = body.get('paths')
            if not isinstance(paths, list) or len(paths) > 50 or any(not isinstance(p, str) for p in paths):
                raise ValueError('每次最多查询 50 篇笔记')
            where.append('e.key IN (' + ','.join('?' for _ in paths) + ')'); args.extend(map(normalize, paths))
        tags = body.get('tags', [body['tag']] if 'tag' in body else [])
        if not isinstance(tags, list) or len(tags) > 16 or any(not isinstance(t, str) for t in tags):
            raise ValueError('标签筛选无效')
        for tag in tags:
            where.append('e.id IN (SELECT entry FROM tags WHERE key=?)'); args.append(normalize(tag.lstrip('#')))
        modified = body.get('modified', {})
        if not isinstance(modified, dict):
            raise ValueError('修改时间无效')
        for name, operator in (('after', '>='), ('before', '<')):
            if name in modified and modified[name] is not None:
                if type(modified[name]) is not int or not 0 <= modified[name] <= 9223372036854775807:
                    raise ValueError('修改时间无效')
                where.append('e.modified' + operator + '?'); args.append(modified[name])
        long_words, short_words = [w for w in words if len(w) >= 3], [w for w in words if len(w) < 3]
        for table, values, short in (('text_fts', long_words, False), ('short_fts', short_words, True)):
            if values:
                where.append('e.id IN (SELECT rowid FROM ' + table + ' WHERE ' + table + ' MATCH ?)')
                args.append(match_expression(values, short=short))
        sorting = body.get('sort', 'relevance' if words else 'modified-desc')
        if sorting not in ('relevance', 'modified-desc', 'modified-asc', 'name-asc', 'name-desc', 'created-asc', 'created-desc'):
            raise ValueError('排序方式无效')
        fingerprint = hashlib.sha256(json.dumps({k: v for k, v in body.items() if k not in ('cursor', 'offset', 'limit', 'signal')},
            sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:24]
        with self.read() as conn:
            generation = int(conn.execute("SELECT value FROM settings WHERE key='generation'").fetchone()[0])
            cursor = body.get('cursor')
            if cursor:
                try:
                    decoded = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
                    if decoded['query'] != fingerprint or decoded['generation'] != generation:
                        raise ValueError('搜索结果已更新，请重新查询')
                    offset = decoded['offset']
                    if type(offset) is not int or offset < 0:
                        raise ValueError()
                except (ValueError, KeyError, TypeError) as error:
                    raise ValueError('搜索结果已更新，请重新查询') from error
            joins = ' FROM entries e INDEXED BY entries_query JOIN books b ON b.id=e.book '
            order_args = []
            if mode == 'recent':
                recent = body.get('recent', {})
                if not isinstance(recent, dict) or len(recent) > 200:
                    raise ValueError('最近记录无效')
                conn.execute('CREATE TEMP TABLE visits(path TEXT PRIMARY KEY,at REAL)')
                conn.executemany('INSERT INTO visits VALUES(?,?)', [(normalize(p), at) for p, at in recent.items() if isinstance(p, str) and type(at) in (int, float)])
                joins += 'LEFT JOIN visits v ON v.path=e.key '
                order = 'MAX(e.modified/1000000.0,COALESCE(v.at,0)) DESC,e.key'
            elif sorting == 'relevance' and words:
                order = '(' + '+'.join('(CASE WHEN instr(e.title,?)>0 THEN 8 ELSE 0 END + CASE WHEN instr(e.search_path,?)>0 THEN 2 ELSE 0 END)' for _ in words) + ') DESC,e.modified DESC,e.key'
                for word in words:
                    order_args.extend((word, word))
            else:
                field = 'e.name COLLATE NOTE_NATURAL' if sorting.startswith('name') else 'e.created' if sorting.startswith('created') else 'e.modified'
                order = field + (' ASC' if sorting.endswith('asc') else ' DESC') + ',e.key'
            condition = ' WHERE ' + ' AND '.join(where)
            total = conn.execute('SELECT COUNT(*)' + joins + condition, args).fetchone()[0]
            columns = "e.path,e.name,e.modified,e.revision,json_extract(e.metadata,'$.tags') AS tag_data,json_extract(e.metadata,'$.excerpt') AS excerpt"
            if words:
                # MIN skips no NULLs in its scalar form. Missing body terms use
                # a sentinel, then NULLIF recovers the title-only case.
                positions = ','.join('COALESCE(NULLIF(instr(e.body,?),0),2147483647)' for _ in words)
                minimum = ('MIN(' + positions + ')' if len(words) > 1 else positions)
                expression = 'MAX(0,COALESCE(NULLIF(' + minimum + ',2147483647),1)-71)'
                columns += ',e.source_map,' + expression + ' AS snippet_start,substr(e.body,' + expression + '+1,240) AS body'
                select_args = words + words
            else:
                select_args = []
            # Rank compact indexed headers first. Markdown-derived bodies and
            # reference metadata are fetched only for the selected 50 rows.
            selected = 'SELECT e.id' + joins + condition + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?'
            result_joins = ' FROM (' + selected + ') chosen JOIN entries e ON e.id=chosen.id '
            if mode == 'recent':
                result_joins += 'LEFT JOIN visits v ON v.path=e.key '
            rows = conn.execute('SELECT ' + columns + result_joins + ' ORDER BY ' + order,
                                select_args + args + order_args + [limit, offset] + order_args).fetchall()
            items = []
            for row in rows:
                item = {'path': row['path'], 'title': row['name'], 'modifiedNs': row['modified'],
                        'revision': row['revision'], 'tags': json.loads(row['tag_data'] or '[]'), 'excerpt': row['excerpt'] or ''}
                if words:
                    mapping = json.loads(zlib.decompress(row['source_map'])) if row['source_map'] else []
                    item.update(hit(row['body'], words, mapping, row['snippet_start']))
                    item['titleHighlights'] = literal_ranges(item['title'], words)
                    item['pathHighlights'] = literal_ranges(item['path'], words)
                items.append(item)
            if mode == 'paths':
                position = {normalize(path): i for i, path in enumerate(body['paths'])}
                items.sort(key=lambda item: position[normalize(item['path'])])
            has_more = offset + len(items) < total
            next_cursor = base64.urlsafe_b64encode(dump({'generation': generation, 'query': fingerprint,
                'offset': offset + len(items)}).encode()).decode().rstrip('=') if has_more else None
            result = {'items': items, 'total': total, 'hasMore': has_more, 'cursor': next_cursor,
                      'generation': generation}
            if mode == 'recent':
                result['missingRecent'] = [row[0] for row in conn.execute('SELECT v.path FROM visits v WHERE NOT EXISTS('
                    'SELECT 1 FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 AND e.key=v.path)')]
            return result

    def children(self, parent='', *, offset=0, limit=50, sort='name-asc', generation=None, folders_only=False, connection=None):
        with self.read() if connection is None else nullcontext(connection) as conn:
            ordering = {'name-asc': 'e.name COLLATE NOTE_NATURAL ASC', 'name-desc': 'e.name COLLATE NOTE_NATURAL DESC',
                'modified-desc': 'e.modified DESC', 'modified-asc': 'e.modified ASC',
                'created-desc': 'e.created DESC', 'created-asc': 'e.created ASC'}.get(sort)
            if ordering is None or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
                raise ValueError('目录分页或排序无效')
            current_generation = int(conn.execute("SELECT value FROM settings WHERE key='directory_generation'").fetchone()[0])
            if generation is not None and generation != current_generation:
                raise ValueError('目录已更新，请重新查询')
            counts = dict(conn.execute('SELECT e.kind,COUNT(*) FROM entries e INDEXED BY entries_parent_count JOIN books b ON b.id=e.book WHERE b.deleted=0 AND e.parent=? '
                + ("AND e.kind='folder' " if folders_only else '') + 'GROUP BY e.kind', (normalize(parent),)))
            folders = counts.get('folder', 0); count = sum(counts.values())
            rows = []
            columns = 'SELECT e.path,e.kind,e.name,e.modified,e.created,e.size,e.revision FROM entries e JOIN books b ON b.id=e.book WHERE b.deleted=0 AND e.parent=? '
            if offset < folders:
                rows.extend(conn.execute(columns + "AND e.kind='folder' ORDER BY e.name COLLATE NOTE_NATURAL ASC,e.key LIMIT ? OFFSET ?", (normalize(parent), limit, offset)))
            remaining = limit - len(rows)
            if remaining and not folders_only:
                rows.extend(conn.execute(columns + "AND e.kind='note' ORDER BY " + ordering + ',e.key LIMIT ? OFFSET ?', (normalize(parent), remaining, max(0, offset - folders))))
            return {'items': [self.entry(row) for row in rows], 'total': count, 'hasMore': offset + len(rows) < count, 'generation': current_generation}

    def close(self):
        with self._lock:
            if self._writer is not None:
                self._writer.execute('PRAGMA wal_checkpoint(PASSIVE)'); self._writer.close(); self._writer = None
            self._closed = True

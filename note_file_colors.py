"""Durable, sparse file colors. This database is user data, never an index cache."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from note_search import normalize


COLORS = ("gray", "blue", "cyan", "green", "yellow", "orange", "red", "purple")
APPLICATION_ID = 0x52464331


class NoteFileColors:
    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()

    @contextmanager
    def connection(self, *, create=False):
        # Short-lived connections keep this optional feature's page cache bounded
        # and release it completely between operations. Reads never create a file.
        from notes_library import _is_reparse
        with self._lock:
            if _is_reparse(self.path) or _is_reparse(self.path.parent):
                raise OSError("文件颜色数据不能是链接或重解析点")
            try:
                self.path.stat()
            except FileNotFoundError:
                if not create:
                    yield None
                    return
                self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=1)
            try:
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA cache_size=-256")
                conn.execute("PRAGMA synchronous=FULL")
                version = conn.execute("PRAGMA user_version").fetchone()[0]
                application = conn.execute("PRAGMA application_id").fetchone()[0]
                if version == 0 and application == 0:
                    if conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone():
                        raise RuntimeError("无法识别文件颜色数据库")
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.executescript("""BEGIN IMMEDIATE;
                        CREATE TABLE colors(key TEXT PRIMARY KEY, path TEXT NOT NULL,
                            kind TEXT NOT NULL CHECK(kind IN ('note','folder')),
                            color TEXT NOT NULL CHECK(color IN
                                ('gray','blue','cyan','green','yellow','orange','red','purple')));
                        CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                        INSERT INTO meta VALUES('generation',0);
                        PRAGMA application_id=""" + str(APPLICATION_ID) + "; PRAGMA user_version=1; COMMIT;")
                elif version != 1 or application != APPLICATION_ID:
                    raise RuntimeError("无法识别文件颜色数据库版本；已保留原数据")
                with conn:
                    yield conn
            finally:
                conn.close()

    @staticmethod
    def _generation(conn):
        return conn.execute("SELECT value FROM meta WHERE key='generation'").fetchone()[0] if conn else 0

    @staticmethod
    def _changed(conn):
        conn.execute("UPDATE meta SET value=value+1 WHERE key='generation'")

    def generation(self):
        with self.connection() as conn:
            return self._generation(conn)

    def query(self, paths):
        with self.connection() as conn:
            rows = {}
            if conn and paths:
                keys = list(dict.fromkeys(normalize(path) for path in paths))
                rows = dict(conn.execute("SELECT key,color FROM colors WHERE key IN ("
                    + ','.join('?' for _ in keys) + ')', keys))
            return {'generation': self._generation(conn),
                    'colors': {path: rows[normalize(path)] for path in paths if normalize(path) in rows}}

    def set(self, path, kind, color):
        with self.connection(create=color is not None) as conn:
            if conn:
                previous = conn.execute("SELECT path,kind,color FROM colors WHERE key=?", (normalize(path),)).fetchone()
                if color is None:
                    if previous:
                        conn.execute("DELETE FROM colors WHERE key=?", (normalize(path),))
                        self._changed(conn)
                elif not previous or tuple(previous) != (path, kind, color):
                    conn.execute("INSERT INTO colors VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                        "path=excluded.path,kind=excluded.kind,color=excluded.color", (normalize(path), path, kind, color))
                    self._changed(conn)
            return {'path': path, 'color': color, 'generation': self._generation(conn)}

    def remove(self, path):
        key = normalize(path)
        with self.connection() as conn:
            if conn:
                changed = conn.execute("DELETE FROM colors WHERE key=? OR (key>=? AND key<?)",
                    (key, key + '/', key + '/\U0010ffff')).rowcount if key else conn.execute("DELETE FROM colors").rowcount
                if changed:
                    self._changed(conn)

    def clear(self):
        with self.connection() as conn:
            cleared = conn.execute('DELETE FROM colors').rowcount if conn else 0
            if cleared:
                self._changed(conn)
            return {'generation': self._generation(conn), 'cleared': cleared}

    def remap(self, source, destination):
        key = normalize(source)
        depth = len(source.split('/'))
        with self.connection() as conn:
            if not conn:
                return
            rows = conn.execute("SELECT * FROM colors WHERE key=? OR (key>=? AND key<?)",
                                (key, key + '/', key + '/\U0010ffff')).fetchall()
            if not rows:
                return
            conn.executemany("DELETE FROM colors WHERE key=?", [(row['key'],) for row in rows])
            for row in rows:
                suffix = '/'.join(row['path'].split('/')[depth:])
                path = destination + ('/' + suffix if suffix else '')
                conn.execute("INSERT INTO colors VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                    "path=excluded.path,kind=excluded.kind,color=excluded.color",
                    (normalize(path), path, row['kind'], row['color']))
            self._changed(conn)

    def reconcile(self, live, failed, scope=None):
        """Reuse a completed directory walk; no filesystem reads or index IDs."""
        failed = [normalize(path) for path in failed]
        scope = normalize(scope) if scope is not None else None
        with self.connection() as conn:
            if not conn:
                return
            removed = False
            cursor = (conn.execute("SELECT key,kind FROM colors WHERE key>=? AND key<?",
                                   (scope + '/', scope + '/\U0010ffff')) if scope
                      else conn.execute("SELECT key,kind FROM colors"))
            while batch := cursor.fetchmany(512):
                doomed = []
                for row in batch:
                    key = row['key']
                    if scope == '' and (key == 'customnotebook' or key.startswith('customnotebook/')):
                        continue
                    if scope and key != scope and not key.startswith(scope + '/'):
                        continue
                    if key == scope or any(not prefix or key == prefix or key.startswith(prefix + '/')
                                          or prefix.startswith(key + '/') for prefix in failed):
                        continue
                    if live.get(key) != row['kind']:
                        doomed.append((key,))
                if doomed:
                    conn.executemany("DELETE FROM colors WHERE key=?", doomed)
                    removed = True
            if removed:
                self._changed(conn)

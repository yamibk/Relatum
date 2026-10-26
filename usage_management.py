"""Explicit, local-only usage maintenance. Never reads or rewrites note bodies."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager, closing
from pathlib import Path

from notes_library import NotesError
from usage_store import ARCHIVED_NOTES, merged


class ManagementError(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


class UsageManagement:
    def __init__(self, usage, notes, reports, notes_lock):
        self.usage, self.notes, self.reports = usage, notes, reports
        self.notes_lock = notes_lock
        self._lock = threading.RLock()
        self._previews = {}

    def overview(self):
        with self.usage.connection() as conn:
            revision = conn.execute("SELECT value FROM meta WHERE key='archiveRevision'").fetchone()
            return {'notes': conn.execute("SELECT count(*) FROM entities WHERE category='notes'").fetchone()[0],
                    'archived': conn.execute('SELECT count(*) FROM archive_items').fetchone()[0],
                    'archiveRevision': int(revision[0]) if revision else 0}

    @staticmethod
    def _readable_directory(path):
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 1024:
            return False
        with os.scandir(path) as entries:
            next(entries, None)
        return True

    def _missing(self, locator):
        """Prove absence through readable, unlinked parents; unknown is excluded."""
        try:
            parts = self.notes.normalize_path(locator).split('/')
            if not parts[-1].lower().endswith('.md'):
                return False
            current = Path(self.notes.root)
            for part in parts:
                if not self._readable_directory(current):
                    return False
                current = current / part
                try:
                    current.stat(follow_symlinks=False)
                except FileNotFoundError:
                    return True
            return False
        except (OSError, NotesError, ValueError):
            return False

    @staticmethod
    def _records(conn):
        aliases = {}
        for locator, identity in conn.execute("SELECT locator,entity FROM aliases WHERE category='notes'"):
            if not locator.startswith('deleted:'):
                aliases.setdefault(identity, []).append(locator)
        records = []
        for raw in conn.execute("SELECT id,name,locator,deleted FROM entities WHERE category='notes'"):
            row = dict(raw)
            row['aliases'] = sorted(aliases.get(row['id'], []))
            row['paths'] = row['aliases'] if row['deleted'] else [row['locator']]
            row['signature'] = hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            records.append(row)
        return records

    def _eligible(self, row):
        # If an old path was restored/reused, require a fresh preview later.
        # A successful same-path creation removes the old alias. That detached,
        # explicitly deleted identity can no longer be restored by any path.
        if row['paths']:
            return all(self._missing(path) for path in row['paths'])
        try:
            return bool(row['deleted']) and self._readable_directory(Path(self.notes.root))
        except OSError:
            return False

    def preview(self):
        # A preview may race content changes: commit revalidates its identities
        # and paths. Keep exploratory filesystem IO out of the note save lock.
        with self._lock, self.usage.connection() as conn:
            rows = self._records(conn)
            spans, dates = {}, {}
            for identity, day, start, end in conn.execute("SELECT entity,day,start,end FROM spans WHERE category='notes'"):
                spans.setdefault(identity, []).append((start, end))
                dates.setdefault(identity, set()).add(day)
            for identity, day in conn.execute("SELECT entity,day FROM events WHERE category='notes'"):
                dates.setdefault(identity, set()).add(day)
            candidates, signatures = [], {}
            for row in rows:
                if not self._eligible(row):
                    continue
                identity = row['id']
                days = sorted(dates.get(identity, []))
                candidates.append({'id': identity, 'name': row['name'],
                    'kind': 'deleted' if row['deleted'] else 'missing',
                    'seconds': sum(b-a for a,b in merged(spans.get(identity, [])))/1000,
                    'firstDay': days[0] if days else None, 'lastDay': days[-1] if days else None})
                signatures[identity] = row['signature']
            now = time.monotonic()
            self._previews = {key: value for key,value in self._previews.items() if now-value['at'] < 600}
            while len(self._previews) >= 8:
                self._previews.pop(next(iter(self._previews)))
            token = uuid.uuid4().hex
            self._previews[token] = {'at': now, 'signatures': signatures}
            return {'token': token, 'candidates': sorted(candidates, key=lambda r: (r['kind'], r['name'].casefold())),
                    'excluded': len(rows)-len(candidates)}

    def archive(self, token, identities):
        if not isinstance(token, str) or len(token) != 32 or not isinstance(identities, list) or not identities or len(identities) > 100000:
            raise ManagementError('invalid-selection', 400)
        if any(not isinstance(identity, str) or len(identity) != 32 for identity in identities):
            raise ManagementError('invalid-selection', 400)
        identities = sorted(set(identities))
        digest = hashlib.sha256(json.dumps(identities).encode()).hexdigest()
        with self._lock, self.notes_lock, self.usage.connection(write=True) as conn:
            previous = conn.execute('SELECT digest,count,revision FROM archive_requests WHERE id=?', (token,)).fetchone()
            if previous:
                if previous['digest'] != digest:
                    raise ManagementError('invalid-selection', 400)
                return {'count': previous['count'], 'archiveRevision': previous['revision'], 'repeated': True}
            preview = self._previews.get(token)
            if not preview or time.monotonic()-preview['at'] >= 600:
                raise ManagementError('preview-expired')
            records = {row['id']: row for row in self._records(conn)}
            for identity in identities:
                row = records.get(identity)
                if not row or preview['signatures'].get(identity) != row['signature'] or not self._eligible(row):
                    raise ManagementError('candidates-changed')
            now = self.usage.clock()
            for identity in identities:
                row = records[identity]
                for path in set(row['aliases'] + ([] if row['locator'].startswith('deleted:') else [row['locator']])):
                    self.usage.remember_route(conn, path, identity, now)
                conn.execute('INSERT INTO archive_items VALUES(?,?)', (identity, now))
                spans = conn.execute('SELECT day,start,end FROM spans WHERE entity=?', (identity,)).fetchall()
                for day, start, end in spans:
                    conn.execute('INSERT OR IGNORE INTO archive_years VALUES(?,?)', (identity, day[:4]))
                    self.usage._span(conn, day, 'notes', ARCHIVED_NOTES, start, end)
                conn.execute('DELETE FROM spans WHERE entity=?', (identity,))
                events = conn.execute('SELECT day,kind,sum(count),max(at) FROM events WHERE entity=? GROUP BY day,kind', (identity,)).fetchall()
                for day, kind, count, at in events:
                    key = f'{ARCHIVED_NOTES}:{day}:{kind}'
                    conn.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET count=count+excluded.count,at=max(at,excluded.at)',
                                 (key, at, day, 'notes', ARCHIVED_NOTES, kind, count))
                conn.execute('DELETE FROM events WHERE entity=?', (identity,))
                conn.execute('DELETE FROM aliases WHERE entity=?', (identity,))
                conn.execute('DELETE FROM entities WHERE id=?', (identity,))
            revision = self.usage._state(conn)['archiveRevision'] + 1
            conn.execute("INSERT INTO meta VALUES('archiveRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(revision),))
            if self.reports.path.exists() or conn.execute("SELECT 1 FROM meta WHERE key='archiveReportPending'").fetchone():
                conn.execute("INSERT INTO meta VALUES('archiveReportPending',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(revision),))
            conn.execute('INSERT INTO archive_requests VALUES(?,?,?,?)', (token, digest, len(identities), revision))
        return {'count': len(identities), 'archiveRevision': revision, 'repeated': False}

    @contextmanager
    def backup(self):
        with tempfile.TemporaryDirectory(prefix='relatum-usage-backup-') as folder:
            root = Path(folder)
            # SQLite's online API copies committed WAL pages consistently while
            # allowing writers. Pair the report with the copied DB's revision;
            # omit it if maintenance in any service crossed the backup boundary.
            with self.usage.connection() as source, closing(sqlite3.connect(root/'usage-v2.sqlite3')) as target:
                source.backup(target)
                revision_row = target.execute("SELECT value FROM meta WHERE key='archiveRevision'").fetchone()
                revision = int(revision_row[0]) if revision_row else 0
            report = self.reports.read()
            if report.get('exists') and report['report']['history'].get('archiveRevision', 0) == revision:
                (root/'career-report-v2.json').write_text(json.dumps(report['report'], ensure_ascii=False), encoding='utf-8', newline='')
            archive = root/'relatum-usage-backup.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
                output.write(root/'usage-v2.sqlite3', 'usage-v2.sqlite3')
                if (root/'career-report-v2.json').exists():
                    output.write(root/'career-report-v2.json', 'career-report-v2.json')
                output.writestr('README.txt', 'Relatum usage backup (no note bodies).\nClose every Relatum window before restoring.\nBack up current data first. Remove current usage-v2.sqlite3-wal and -shm,\nthen replace data/usage-v2.sqlite3 and data/career-report-v2.json with this backup.\nIf no report is included, remove the current report and generate it again.\nThis replaces all usage history and collection settings.\n')
            yield archive

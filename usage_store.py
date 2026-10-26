"""Version 2 local usage journal. No imports or reads of legacy ledgers.

Locators belong only to the private identity table. Public frozen snapshots
contain opaque ids, display names, counts and relationships, never locators.
"""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from pathlib import Path

CATEGORIES = ("notes", "canvas", "embedded", "research", "study", "tree",
              "quicknotes", "review", "checkin")
WORKSPACES = {"notes": "notes", "embedded": "notes", "research": "research"}
ARCHIVED_NOTES = 'archive:notes'


def merged(spans):
    result = []
    for a, b in sorted(spans):
        if b <= a:
            continue
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def milliseconds(value):
    if isinstance(value, bool):
        raise ValueError("Invalid timestamp")
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError("Invalid timestamp")
    return int(value)


def day_parts(a, b):
    """Split in local civil time, including midnight and DST boundaries."""
    while a < b:
        current = datetime.fromtimestamp(a / 1000)
        midnight = datetime.combine(current.date() + timedelta(days=1), datetime.min.time())
        end = min(b, int(midnight.timestamp() * 1000))
        yield current.date().isoformat(), a, end
        a = end


class UsageStore:
    def __init__(self, path: Path, enabled=None, clock=None):
        self.path = Path(path)
        self.enabled = enabled or (lambda category: True)
        self.clock = clock or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        self._ready = False

    @contextmanager
    def connection(self, *, write=False):
        # After schema initialization, WAL readers must not hold the writer
        # mutex while copying a snapshot for background generation.
        with self._lock if write or not self._ready else nullcontext():
            if not self._ready:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=10)
            conn.row_factory = sqlite3.Row
            try:
                if not self._ready:
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.executescript("""
                        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS entities(
                            id TEXT PRIMARY KEY,category TEXT NOT NULL,locator TEXT NOT NULL,
                            name TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
                            fingerprint TEXT NOT NULL DEFAULT '',UNIQUE(category,locator));
                        CREATE TABLE IF NOT EXISTS aliases(
                            category TEXT NOT NULL,locator TEXT NOT NULL,entity TEXT NOT NULL,
                            PRIMARY KEY(category,locator));
                        CREATE INDEX IF NOT EXISTS aliases_entity ON aliases(entity);
                        CREATE TABLE IF NOT EXISTS policies(
                            category TEXT NOT NULL,at INTEGER NOT NULL,enabled INTEGER NOT NULL,
                            PRIMARY KEY(category,at));
                        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS spans(
                            day TEXT NOT NULL,category TEXT NOT NULL,entity TEXT NOT NULL,
                            start INTEGER NOT NULL,end INTEGER NOT NULL);
                        CREATE INDEX IF NOT EXISTS spans_target ON spans(day,category,entity,start);
                        CREATE INDEX IF NOT EXISTS spans_time ON spans(start,end);
                        CREATE INDEX IF NOT EXISTS spans_entity ON spans(entity,day,start);
                        CREATE TABLE IF NOT EXISTS events(
                            id TEXT PRIMARY KEY,at INTEGER NOT NULL,day TEXT NOT NULL,
                            category TEXT NOT NULL,entity TEXT NOT NULL,kind TEXT NOT NULL,
                            count INTEGER NOT NULL DEFAULT 1);
                        CREATE INDEX IF NOT EXISTS events_date ON events(day,category,entity);
                        CREATE INDEX IF NOT EXISTS events_entity ON events(entity,day,kind);
                        CREATE TABLE IF NOT EXISTS archive_items(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
                        CREATE TABLE IF NOT EXISTS archive_routes(hash TEXT NOT NULL,until INTEGER NOT NULL,
                            identity TEXT NOT NULL,PRIMARY KEY(hash,until,identity));
                        CREATE TABLE IF NOT EXISTS archive_years(identity TEXT NOT NULL,year TEXT NOT NULL,
                            PRIMARY KEY(identity,year));
                        CREATE TABLE IF NOT EXISTS archive_requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,
                            count INTEGER NOT NULL,revision INTEGER NOT NULL);
                    """)
                    now = self.clock()
                    conn.execute("INSERT OR IGNORE INTO meta VALUES('since',?)", (str(now),))
                    since = int(conn.execute("SELECT value FROM meta WHERE key='since'").fetchone()[0])
                    for category in CATEGORIES:
                        conn.execute("INSERT OR IGNORE INTO policies VALUES(?,?,?)",
                                     (category, since, 1))
                    conn.commit()
                    self._ready = True
                if write:
                    conn.execute("BEGIN IMMEDIATE")
                else:
                    conn.execute("BEGIN")
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def _entity(self, conn, category, locator, name):
        row = conn.execute("SELECT id,name FROM entities WHERE category=? AND locator=?",
                           (category, locator)).fetchone()
        if not row:
            alias = conn.execute("SELECT entity FROM aliases WHERE category=? AND locator=?",
                                 (category, locator)).fetchone()
            if alias:
                return alias[0]
            identity = uuid.uuid4().hex
            conn.execute("INSERT INTO entities(id,category,locator,name) VALUES(?,?,?,?)",
                         (identity, category, locator, str(name)[:240]))
            return identity
        if row[1] != name:
            conn.execute("UPDATE entities SET name=? WHERE id=?", (str(name)[:240], row[0]))
        return row[0]

    def identity(self, category, locator, name):
        with self.connection(write=True) as conn:
            return self._entity(conn, category, str(locator), str(name))

    def identities(self, records):
        with self.connection(write=True) as conn:
            return {locator: self._entity(conn, category, locator, name)
                    for category, locator, name in records}

    def baseline(self, category, locator, name, fingerprint):
        with self.connection(write=True) as conn:
            identity = self._entity(conn, category, locator, name)
            conn.execute("UPDATE entities SET fingerprint=? WHERE id=? AND fingerprint=''", (fingerprint, identity))
            return identity

    def needs_baseline(self, category, locator):
        with self.connection() as conn:
            row = conn.execute("SELECT fingerprint FROM entities WHERE category=? AND locator=?", (category, locator)).fetchone()
            return row is None or not row[0]

    def known_locator(self, category, locator):
        with self.connection() as conn:
            return bool(conn.execute("SELECT 1 FROM entities WHERE category=? AND locator=? UNION ALL SELECT 1 FROM aliases WHERE category=? AND locator=? LIMIT 1",
                                     (category, locator, category, locator)).fetchone())

    def public_entities(self):
        with self.connection() as conn:
            return [dict(row) for row in conn.execute("SELECT id,category,name,deleted FROM entities")]

    def entity_totals(self, identity):
        """Editor saves query only this project, never rebuild the full report."""
        with self.connection() as conn:
            rows = conn.execute("SELECT day,start,end FROM spans WHERE entity=? ORDER BY day,start",
                                (identity,)).fetchall()
        by_day = {}
        for row in rows:
            by_day.setdefault(row[0], []).append((row[1], row[2]))
        seconds = {day: sum(b-a for a,b in merged(spans))/1000 for day,spans in by_day.items()}
        today = datetime.fromtimestamp(self.clock()/1000).date().isoformat()
        return {"canvasId": identity, "todaySec": round(seconds.get(today, 0)),
                "totalSec": round(sum(seconds.values()))}

    def move(self, category, old, new, name, *, prefix=False):
        """Remap identity, including a moved note folder; late batches use aliases."""
        with self.connection(write=True) as conn:
            rows = conn.execute("SELECT id,locator FROM entities WHERE category=?", (category,)).fetchall()
            alias = conn.execute("SELECT entity FROM aliases WHERE category=? AND locator=?", (category, old)).fetchone()
            for row in rows:
                source = row[1]
                revived = bool(alias and alias[0] == row[0] and source.startswith('deleted:'))
                if source != old and not revived and not (prefix and source.startswith(old.rstrip('/') + '/')):
                    continue
                target = new if revived else new + source[len(old):]
                conn.execute("INSERT OR REPLACE INTO aliases VALUES(?,?,?)", (category, source, row[0]))
                conn.execute("UPDATE entities SET locator=?,name=?,deleted=0 WHERE id=?",
                             (target, name if source == old or revived else Path(target).name, row[0]))

    def remove(self, category, locator, *, prefix=False):
        with self.connection(write=True) as conn:
            rows = conn.execute("SELECT id,locator FROM entities WHERE category=?", (category,)).fetchall()
            for row in rows:
                if row[1] == locator or (prefix and row[1].startswith(locator.rstrip('/') + '/')):
                    conn.execute("INSERT OR REPLACE INTO aliases VALUES(?,?,?)", (category, row[1], row[0]))
                    conn.execute("UPDATE entities SET deleted=1 WHERE id=?", (row[0],))
                    # Remove the locator from future matching: a new file at this
                    # address has its own identity. Historical rows remain intact.
                    conn.execute("UPDATE entities SET locator=? WHERE id=?", ('deleted:' + row[0], row[0]))

    def state(self):
        with self.connection() as conn:
            return self._state(conn)

    def _state(self, conn):
        rows = conn.execute("SELECT category,at,enabled FROM policies ORDER BY at").fetchall()
        settings = {category: True for category in CATEGORIES}
        for row in rows:
            settings[row[0]] = bool(row[2])
        revision = conn.execute("SELECT value FROM meta WHERE key='archiveRevision'").fetchone()
        return {"version": 2, "since": int(conn.execute("SELECT value FROM meta WHERE key='since'").fetchone()[0]),
                "archiveRevision": int(revision[0]) if revision else 0,
                "settings": settings, "available": {c: bool(self.enabled(c)) for c in CATEGORIES},
                "coverage": [dict(row) for row in rows]}

    def archive_revision(self):
        with self.connection() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key='archiveRevision'").fetchone()
            return int(row[0]) if row else 0

    @staticmethod
    def _route_hash(conn, locator):
        salt = conn.execute("SELECT value FROM meta WHERE key='archiveSalt'").fetchone()
        return hashlib.sha256((salt[0] + '\0' + locator.casefold()).encode('utf-8')).hexdigest() if salt else ''

    def remember_route(self, conn, locator, identity, until):
        conn.execute("INSERT OR IGNORE INTO meta VALUES('archiveSalt',?)", (uuid.uuid4().hex,))
        conn.execute('INSERT OR IGNORE INTO archive_routes VALUES(?,?,?)', (self._route_hash(conn, locator), until, identity))

    @staticmethod
    def _span(conn, day, category, entity, start, end):
        overlaps = conn.execute("SELECT rowid,start,end FROM spans WHERE day=? AND category=? AND entity=? AND end>=? AND start<=?",
                                (day, category, entity, start, end)).fetchall()
        if overlaps:
            start = min(start, min(row[1] for row in overlaps))
            end = max(end, max(row[2] for row in overlaps))
            conn.executemany("DELETE FROM spans WHERE rowid=?", ((row[0],) for row in overlaps))
        conn.execute("INSERT INTO spans VALUES(?,?,?,?,?)", (day, category, entity, start, end))

    def _interval_targets(self, conn, category, locator, name, start, end):
        # Only digests survive archiving. Timestamp boundaries keep an old
        # queued interval separate from a newly created file at the same path.
        routes = conn.execute("SELECT r.until,r.identity,a.id IS NOT NULL FROM archive_routes r "
                              "LEFT JOIN archive_items a ON a.id=r.identity LEFT JOIN entities e ON e.id=r.identity "
                              "WHERE r.hash=? AND r.until>? AND (a.id IS NOT NULL OR e.id IS NOT NULL) ORDER BY r.until",
                              (self._route_hash(conn, locator), start)).fetchall() if category == 'notes' and locator else []
        cursor = start
        for until, identity, archived in routes:
            stop = min(end, until)
            if stop > cursor:
                yield ARCHIVED_NOTES if archived else identity, identity if archived else None, cursor, stop
                cursor = stop
            if cursor >= end:
                return
        if cursor < end:
            yield self._entity(conn, category, locator, name) if locator else '', None, cursor, end

    @staticmethod
    def _allowed(conn, category, start, end):
        rows = conn.execute("SELECT at,enabled FROM policies WHERE category=? AND at<=? ORDER BY at",
                            (category, end)).fetchall()
        enabled = False
        cursor = start
        result = []
        for at, value in rows:
            if at <= start:
                enabled = bool(value)
                continue
            if enabled and at > cursor:
                result.append((cursor, min(at, end)))
            cursor = at
            enabled = bool(value)
        if enabled and end > cursor:
            result.append((cursor, end))
        return result

    def batch(self, payload):
        intervals = payload.get("intervals", [])
        changes = payload.get("settings", [])
        if not isinstance(intervals, list) or len(intervals) > 512 or not isinstance(changes, list) or len(changes) > 128:
            raise ValueError("Usage batch too large")
        now = self.clock()
        clean = []
        for item in intervals:
            if not isinstance(item, dict):
                raise ValueError("Invalid usage interval")
            category = item.get("category")
            identifier = str(item.get("id", ""))
            start, end = milliseconds(item.get("start")), milliseconds(item.get("end"))
            if category not in CATEGORIES or not 1 <= len(identifier) <= 160:
                raise ValueError("Invalid usage category or id")
            if end <= start or end - start > 45000 or end > now + 120000:
                raise ValueError("Invalid usage interval")
            locator, name = str(item.get("locator", "")), str(item.get("name", ""))[:240]
            if len(locator) > 4096:
                raise ValueError("Invalid usage target")
            digest = hashlib.sha256(json.dumps([category, locator, start, end], ensure_ascii=False).encode()).hexdigest()
            clean.append((identifier, digest, category, locator, name, start, end))
        with self.connection(write=True) as conn:
            since = int(conn.execute("SELECT value FROM meta WHERE key='since'").fetchone()[0])
            changed = {}
            for item in changes:
                if not isinstance(item, dict):
                    raise ValueError("Invalid usage setting")
                category, at, enabled = item.get("category"), milliseconds(item.get("at")), item.get("enabled")
                if category not in CATEGORIES or not isinstance(enabled, bool) or at < since or at > now + 120000:
                    raise ValueError("Invalid usage setting")
                conn.execute("INSERT INTO policies VALUES(?,?,?) ON CONFLICT(category,at) DO UPDATE SET enabled=excluded.enabled",
                             (category, at, int(enabled)))
                changed[category] = min(at, changed.get(category, at))
            # Another foreground window may submit a switch after an already
            # received interval. Its effective time still bounds that history.
            for category, at in changed.items():
                rows = conn.execute("SELECT rowid,day,entity,start,end FROM spans WHERE category=? AND end>?", (category, at)).fetchall()
                for row in rows:
                    allowed = self._allowed(conn, category, row['start'], row['end'])
                    if allowed == [(row['start'], row['end'])]:
                        continue
                    conn.execute("DELETE FROM spans WHERE rowid=?", (row['rowid'],))
                    conn.executemany("INSERT INTO spans VALUES(?,?,?,?,?)", ((row['day'], category, row['entity'], a, b) for a,b in allowed))
            accepted = 0
            for identifier, digest, category, locator, name, start, end in clean:
                previous = conn.execute("SELECT digest FROM receipts WHERE id=?", (identifier,)).fetchone()
                if previous:
                    if previous[0] != digest:
                        raise ValueError("Usage id reused with different content")
                    continue
                conn.execute("INSERT INTO receipts VALUES(?,?)", (identifier, digest))
                # A queue captured by an enabled workspace may be retried by
                # a later, trimmed launch. Its original policy still applies.
                for a, b in self._allowed(conn, category, max(start, since), end):
                    for entity, archived, x, y in self._interval_targets(conn, category, locator, name, a, b):
                        for day, left, right in day_parts(x, y):
                            self._span(conn, day, category, entity, left, right)
                            if archived:
                                conn.execute("INSERT OR IGNORE INTO archive_years VALUES(?,?)", (archived, day[:4]))
                accepted += 1
            return {"accepted": accepted, **self._state(conn)}

    def event(self, category, locator, name, kind, *, fingerprint=None, event_id=None, count=1):
        if category not in CATEGORIES or not self.enabled(category):
            return
        now = self.clock()
        with self.connection(write=True) as conn:
            if kind == 'created' and locator:
                if category == 'notes':
                    alias = conn.execute('SELECT entity FROM aliases WHERE category=? AND locator=?', (category, str(locator))).fetchone()
                    if alias:
                        # Keep only a salted temporal route when creation takes
                        # ownership of a previously used address.
                        self.remember_route(conn, str(locator), alias[0], now)
                conn.execute("DELETE FROM aliases WHERE category=? AND locator=?", (category, str(locator)))
            entity = self._entity(conn, category, str(locator), str(name)) if locator else ''
            if fingerprint is not None and entity:
                old = conn.execute("SELECT fingerprint FROM entities WHERE id=?", (entity,)).fetchone()[0]
                if old == fingerprint:
                    return
                conn.execute("UPDATE entities SET fingerprint=? WHERE id=?", (fingerprint, entity))
            if not self._allowed(conn, category, now, now + 1):
                return
            conn.execute("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?)",
                         (event_id or uuid.uuid4().hex, now, datetime.fromtimestamp(now / 1000).date().isoformat(),
                          category, entity, kind, max(1, int(count))))

    def snapshot(self, cutoff=None, *, private=False):
        cutoff = self.clock() if cutoff is None else cutoff
        with self.connection() as conn:
            state = self._state(conn)
            # Set only by the isolated acceptance-data generator.
            if conn.execute("SELECT 1 FROM meta WHERE key='demo' AND value='1'").fetchone():
                state['demo'] = True
            entities = [dict(row) for row in conn.execute("SELECT * FROM entities")]
            spans = [dict(row) for row in conn.execute("SELECT * FROM spans WHERE start<? ORDER BY day,start", (cutoff,))]
            events = [dict(row) for row in conn.execute("SELECT * FROM events WHERE at<=? ORDER BY at", (cutoff,))]
            archived = {'count': conn.execute('SELECT count(*) FROM archive_items').fetchone()[0],
                        'yearProjects': dict(conn.execute('SELECT year,count(*) FROM archive_years GROUP BY year'))}
        days, targets, hours = {}, {}, {}
        for span in spans:
            day = span['day']
            a, b = span['start'], min(span['end'], cutoff)
            record = days.setdefault(day, {"date": day, "spans": [], "categories": {}, "workspaces": {}})
            record['spans'].append((a, b))
            record['categories'].setdefault(span['category'], []).append((a, b))
            workspace = WORKSPACES.get(span['category'], 'canvas')
            record['workspaces'].setdefault(workspace, []).append((a, b))
            if span['entity']:
                targets.setdefault((day, span['entity'], span['category']), []).append((a, b))
        for day, record in days.items():
            union = merged(record.pop('spans'))
            record['seconds'] = sum(b - a for a, b in union) / 1000
            for key in ('categories', 'workspaces'):
                record[key] = {k: sum(b - a for a, b in merged(v)) / 1000 for k, v in record[key].items()}
            for a, b in union:
                while a < b:
                    stamp = datetime.fromtimestamp(a / 1000)
                    boundary = int((stamp.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)).timestamp() * 1000)
                    stop = min(b, boundary)
                    hours[(day, stamp.hour)] = hours.get((day, stamp.hour), 0) + (stop - a) / 1000
                    a = stop
        if not private:
            entities = [{k: row[k] for k in ('id', 'category', 'name', 'deleted')} for row in entities]
            events = [{k: row[k] for k in ('id', 'day', 'category', 'entity', 'kind', 'count')} for row in events]
        return {**state, "archivedNotes": archived, "cutoff": cutoff, "days": sorted(days.values(), key=lambda d: d['date']),
                "entities": entities, "events": events,
                "entityDays": [{"date": d, "id": i, "category": c, "seconds": sum(b-a for a,b in merged(v))/1000}
                               for (d,i,c),v in targets.items()],
                "hours": [{"date": d, "hour": h, "seconds": v} for (d,h),v in hours.items()]}

    def canvas_projection(self):
        snapshot = self.snapshot(private=True)
        entities = {e['id']: e for e in snapshot['entities'] if e['category'] == 'canvas'}
        days = {}
        for row in snapshot['entityDays']:
            if row['id'] in entities:
                days.setdefault(row['date'], {})[row['id']] = {"seconds": row['seconds'], "inferred": False}
        for row in snapshot['events']:
            if row['entity'] in entities and row['kind'] in ('created', 'modified'):
                days.setdefault(row['day'], {}).setdefault(row['entity'], {"seconds": 0})[row['kind']] = True
        return {"version": 2, "days": days, "unionDays": {r['date']: r['categories'].get('canvas', 0) for r in snapshot['days']},
                "canvases": {i: {"path": e['locator'] if not e['deleted'] else '', "title": e['name']} for i,e in entities.items()},
                "paths": {e['locator']: i for i,e in entities.items() if not e['deleted']}}

    def page_projection(self):
        snapshot = self.snapshot()
        # Notes and research have their own workspace. Embedded canvas time is
        # a subdivision of notes, so it is never added to the workspace total.
        names = {"study": "study", "tree": "tree", "quicknotes": "notes", "notes": "notebook", "research": "research", "review": "review", "checkin": "checkin"}
        return {"version": 2, "days": {r['date']: {names[k]: {"seconds": v} for k,v in r['categories'].items() if k in names} for r in snapshot['days']}}

    def totals(self, year):
        snapshot = self.snapshot()
        today = datetime.fromtimestamp(self.clock()/1000).date()
        values = {r['date']: r['seconds'] for r in snapshot['days'] if r['seconds'] > 0}
        selected = {d: v for d,v in values.items() if d.startswith(str(year) + '-')}
        current, longest, previous = 0, 0, None
        for day in selected:
            parsed = datetime.fromisoformat(day).date()
            current = current + 1 if previous and parsed == previous + timedelta(days=1) else 1
            longest, previous = max(longest, current), parsed
        cursor = today if today.isoformat() in values else today - timedelta(days=1)
        streak = 0
        while cursor.isoformat() in values:
            streak += 1
            cursor -= timedelta(days=1)
        return {'totalSec': sum(values.values()), 'yearSec': sum(selected.values()),
                'monthSec': sum(v for d,v in values.items() if d.startswith(today.strftime('%Y-%m'))),
                'streak': streak, 'longestStreak': longest, 'activeDays': len(selected),
                'activeProjects': len({r['id'] for r in snapshot['entityDays'] if r['id'] != ARCHIVED_NOTES and r['date'].startswith(str(year)+'-')})
                                  + snapshot['archivedNotes']['yearProjects'].get(str(year), 0)}

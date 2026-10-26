"""Read-only content inventories and asynchronous frozen report generation."""
from __future__ import annotations

import json
import os
import stat
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from contextlib import closing
from pathlib import Path

from note_canvas_reference import references as canvas_references, canvas_target
from notes_library import MAX_NOTE_BYTES, note_visible_text, note_word_count


def read_json(path):
    try:
        metadata = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 1024:
        raise OSError('Linked source is not read')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def status(count, skipped):
    return 'partial' if skipped and count else 'unavailable' if skipped else 'available' if count else 'empty'


def scan_notes(root):
    """No ensure_root, no index writes, no symlinks/reparse traversal."""
    paths, skipped = [], 0
    def visit(folder, prefix=''):
        nonlocal skipped
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    name = entry.name.casefold()
                    if name in ('.trash', 'canvases') or name.endswith('.assets') or name.startswith('.relatum-'):
                        continue
                    try:
                        meta = entry.stat(follow_symlinks=False)
                        if stat.S_ISLNK(meta.st_mode) or getattr(meta, 'st_file_attributes', 0) & 1024:
                            skipped += 1
                        elif stat.S_ISDIR(meta.st_mode):
                            visit(Path(entry.path), prefix + entry.name + '/')
                        elif name.endswith('.md') and stat.S_ISREG(meta.st_mode):
                            paths.append((Path(entry.path), prefix + entry.name, meta))
                    except OSError:
                        skipped += 1
        except OSError:
            skipped += 1
    try:
        metadata = root.stat(follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 1024:
            raise OSError('Linked or invalid source directory')
        visit(root)
    except FileNotFoundError:
        pass
    except OSError:
        skipped += 1
    return sorted(paths, key=lambda item: item[1].casefold()), skipped


def scan_canvases(root):
    """Flat managed inventory with explicit directory read failures."""
    paths, skipped = [], 0
    try:
        metadata = root.stat(follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 1024:
            raise OSError('Linked or invalid source directory')
        with os.scandir(root) as entries:
            for entry in entries:
                if not entry.name.casefold().endswith('.canvas'):
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                    if not stat.S_ISREG(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 1024:
                        raise OSError('Linked or invalid canvas')
                    paths.append(Path(entry.path))
                except OSError:
                    skipped += 1
    except FileNotFoundError:
        pass
    except OSError:
        skipped += 1
    return sorted(paths, key=lambda path: path.name.casefold()), skipped


def note_inventory(root, usage, notes_store=None):
    from note_graph import graph_edges, references as graph_references
    records, documents, refs = [], {}, {}
    books = {}
    skipped = 0
    if Path(root).exists():
        from notes_library import NotesStore, NotesError
        owned = notes_store is None
        store = notes_store or NotesStore(root)
        try:
            store._prepare_index()
            if store.sync.background:
                try:
                    store.sync.complete(timeout=120)
                except NotesError:
                    skipped += 1
            for notebook in store.index.status()['notebooks']:
                try:
                    store.sync.complete(notebook['root'], graph=True, timeout=120)
                except NotesError:
                    skipped += 1
            snapshot = store.index.documents()
            skipped += store.index.status()['errors'] + int(store.sync.status()['incomplete'])
            for relative, metadata in snapshot.items():
                parts = relative.split('/')
                book = '/'.join(parts[:2]) if len(parts) > 2 and parts[0].casefold() == 'customnotebook' else ''
                words = metadata.get('words', 0)
                records.append({'locator': relative, 'name': Path(relative).name, 'words': words,
                    'characters': metadata.get('characters', 0), 'book': book})
                documents[relative] = {'graphReferences': metadata.get('graphReferences', [])}
                books.setdefault(book, {'name': parts[1] if book else 'notes', 'count': 0, 'words': 0})
                books[book]['count'] += 1; books[book]['words'] += words
                for target in metadata.get('canvasTargets', []):
                    refs.setdefault(target.casefold(), set()).add(relative)
        except (OSError, NotesError, sqlite3.Error, RuntimeError):
            skipped = max(1, skipped)
        finally:
            if owned:
                store.close()
    identities = usage.identities([('notes', row['locator'], row['name']) for row in records])
    edges = []
    for book in books:
        scoped = {p: doc for p, doc in documents.items() if (p.startswith(book + '/') if book else p.split('/')[0].casefold() != 'customnotebook')}
        edges.extend(graph_edges(scoped, book))
    degree = dict.fromkeys(documents, 0)
    for edge in edges:
        degree[edge['from']] += 1
        degree[edge['to']] += 1
    # Degree first, deterministic lexical tie-break; all edges are real and
    # book-scoped. Inventory counts remain full, only the interactive view caps.
    ranked = sorted(records, key=lambda r: (-degree[r['locator']], r['locator'].casefold()))[:600]
    chosen = {r['locator'] for r in ranked}
    graph = {'totalNodes': len(records), 'totalEdges': len(edges),
             'nodes': [{'id': identities[r['locator']], 'title': r['name'], 'words': r['words'], 'degree': degree[r['locator']]} for r in ranked],
             'edges': [{'from': identities[e['from']], 'to': identities[e['to']]} for e in edges if e['from'] in chosen and e['to'] in chosen][:2400]}
    lengths = [0] * 6
    for row in records:
        i = next((i for i, limit in enumerate((100, 500, 1000, 2000, 5000)) if row['words'] < limit), 5)
        lengths[i] += 1
    unavailable = not records and skipped
    return {'count': None if unavailable else len(records), 'skipped': skipped, 'status': status(len(records), skipped),
            'wordCount': None if unavailable else sum(r['words'] for r in records), 'characterCount': None if unavailable else sum(r['characters'] for r in records),
            'books': list(books.values()), 'lengths': lengths, 'linkCount': None if unavailable else len(edges),
            'orphanCount': None if unavailable else sum(v == 0 for v in degree.values()), 'network': graph,
            'items': [{'id': identities[r['locator']], **{k: r[k] for k in ('name', 'words', 'characters')}} for r in records]}, refs


def canvas_inventory(paths, category, usage, references=None):
    items, skipped, kinds = [], 0, {}
    candidates = list(paths)
    ids = usage.identities([(category, locator, path.name) for path, locator in candidates])
    for path, locator in candidates:
        try:
            raw = read_json(path)
            if not isinstance(raw, dict) or not isinstance(raw.get('nodes'), list) or not isinstance(raw.get('edges'), list):
                raise ValueError('Invalid canvas')
            counts = {}
            for node in raw['nodes']:
                if not isinstance(node, dict):
                    raise ValueError('Invalid node')
                kind = str(node.get('kind') or 'text')
                counts[kind] = counts.get(kind, 0) + 1
            for kind, count in counts.items():
                kinds[kind] = kinds.get(kind, 0) + count
            items.append({'id': ids[locator], 'name': path.name, 'nodes': len(raw['nodes']),
                          'edges': len(raw['edges']), 'kinds': counts,
                          'references': len((references or {}).get(locator.casefold(), set()))})
        except (OSError, UnicodeError, ValueError):
            skipped += 1
    found = {locator.casefold() for _, locator in candidates}
    unavailable = not items and skipped
    return {'count': None if unavailable else len(items), 'nodes': None if unavailable else sum(i['nodes'] for i in items), 'edges': None if unavailable else sum(i['edges'] for i in items),
            'items': items, 'kinds': kinds, 'skipped': skipped, 'status': status(len(items), skipped),
            'references': None if unavailable else sum(i['references'] for i in items),
            'missingReferences': None if unavailable else sum(len(v) for k,v in (references or {}).items() if k not in found)}


def research_inventory(path, usage):
    try:
        raw = read_json(path)
        if raw is None:
            return {'status': 'empty', 'skipped': 0, 'count': 0, 'items': [], 'network': {'nodes': [], 'edges': []}}
        if not isinstance(raw, dict) or raw.get('researchVersion') != 3 or not isinstance(raw.get('pages'), list) or not isinstance(raw.get('subcircuits'), list):
            raise ValueError('Unreadable research document')
        definitions = raw['subcircuits']
        nodes, links, items, components, wires, relations = [], [], [], 0, 0, 0
        ids = usage.identities([('research', str(p['id']), str(p.get('title') or p['id'])) for p in raw['pages']])
        definition_ids = set()
        for definition in definitions:
            identifier = 'definition:' + str(definition['id'])
            definition_ids.add(str(definition['id']))
            nodes.append({'id': identifier, 'title': str(definition.get('title') or definition.get('name') or definition['id']), 'kind': 'definition'})
        def reuse(owner, instances):
            for node in instances:
                config = node.get('config') or {}
                target = str(config.get('definitionId') or '')
                if target in definition_ids:
                    links.append({'from': owner, 'to': 'definition:' + target})
        for page in raw['pages']:
            ns, es = page['nodes'], page['edges']
            if not isinstance(ns, list) or not isinstance(es, list):
                raise ValueError('Invalid research page')
            w = sum(e.get('kind') == 'wire' for e in es)
            r = sum(e.get('kind') == 'relation' for e in es)
            components += len(ns)
            wires += w
            relations += r
            identity = ids[str(page['id'])]
            name = str(page.get('title') or page['id'])
            nodes.append({'id': identity, 'title': name, 'kind': 'page'})
            items.append({'id': identity, 'name': name, 'nodes': len(ns), 'wires': w, 'relations': r})
            reuse(identity, ns)
        for definition in definitions:
            for revision in definition.get('revisions', []):
                reuse('definition:' + str(definition['id']), revision.get('nodes', []))
        pairs = sorted({(e['from'], e['to']) for e in links})
        degree = dict.fromkeys((n['id'] for n in nodes), 0)
        for a,b in pairs:
            degree[a] += 1; degree[b] += 1
        nodes = sorted(({**n, 'degree':degree[n['id']]} for n in nodes), key=lambda n:(-n['degree'],n['id']))
        chosen = {n['id'] for n in nodes[:600]}
        return {'status': status(len(items), 0), 'skipped': 0, 'count': len(items), 'components': components,
                'wires': wires, 'relations': relations, 'definitions': len(definitions), 'items': items,
                'network': {'nodes': nodes[:600], 'edges': [{'from': a, 'to': b} for a,b in pairs if a in chosen and b in chosen][:2400],
                            'totalNodes': len(nodes), 'totalEdges': len(pairs)}}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # Never quarantine/recover/rewrite: missing or invalid is a coverage
        # error, and cannot be displayed as a successful zero inventory.
        return {'status': 'unavailable', 'skipped': 1, 'count': None, 'items': [], 'network': {'nodes': [], 'edges': []}}


def learning_inventory(data):
    result = {'sources': [], 'items': []}
    for category, filename in (('study', 'study.json'), ('tree', 'tree-page.json'),
                               ('quicknotes', 'notes.json'), ('checkin', 'daily.json')):
        try:
            raw = read_json(data / filename)
            if raw is not None and not isinstance(raw, dict):
                raise ValueError('Invalid structure')
            raw = raw or {}
            tasks = raw.get('tasks', [])
            trees = raw.get('goalTrees', [])
            count = len(raw.get('notes', [])) if category == 'quicknotes' else len(tasks)
            result['items'].append({'name': category, 'count': count, 'trees': len(trees),
                                    'nodes': sum(len(t.get('nodes', [])) for t in trees)})
            result['sources'].append({'id': category, 'status': status(count + len(trees), 0), 'skipped': 0})
        except (OSError, ValueError, TypeError, AttributeError):
            result['sources'].append({'id': category, 'status': 'unavailable', 'skipped': 1})
    review = data / 'review.db'
    try:
        count = 0
        if review.exists():
            with closing(sqlite3.connect(review.resolve().as_uri()+'?mode=ro',uri=True)) as conn:
                count = conn.execute('SELECT count(*) FROM review_cards').fetchone()[0]
        result['items'].append({'name':'review', 'count':count, 'nodes':0, 'trees':0})
        result['sources'].append({'id':'review', 'status':status(count,0), 'skipped':0})
    except (OSError, sqlite3.Error):
        result['sources'].append({'id':'review', 'status':'unavailable', 'skipped':1})
    return result


class CareerReports:
    def __init__(self, path, usage, *, notes, data, canvas_candidates, atomic_json, notes_store=None):
        self.path, self.usage = Path(path), usage
        self.notes, self.data = Path(notes), Path(data)
        self.candidates, self.atomic_json = canvas_candidates, atomic_json
        self.notes_store = notes_store
        self._lock = threading.Lock()
        self._jobs = {}
        self._running = None

    def read(self):
        try:
            raw = read_json(self.path)
            revision = self.usage.archive_revision()
            raw_history = raw.get('history') if isinstance(raw, dict) else None
            report_revision = raw_history.get('archiveRevision', 0) if isinstance(raw_history, dict) else 0
            if (revision or report_revision) and report_revision != revision:
                with self.usage.connection() as conn:
                    pending = bool(conn.execute("SELECT 1 FROM meta WHERE key='archiveReportPending'").fetchone())
                with self._lock:
                    job = dict(self._jobs[self._running]) if self._running else None
                return {'version': 2, 'exists': False, 'report': None, 'job': job,
                        'error': '归档完成，生涯报告待重新生成' if pending else None,
                        'code': 'archive-report-pending' if pending else None}
            if isinstance(raw, dict) and raw.get('version') == 2:
                history, inventory = raw.get('history'), raw.get('inventory')
                if (not isinstance(history, dict) or not isinstance(inventory, dict)
                    or not isinstance(raw.get('generatedAt'), str) or not isinstance(raw.get('sources'), list)
                    or not all(isinstance(history.get(key), list) for key in ('days','entityDays','events','hours','entities','coverage'))
                    or not all(isinstance(inventory.get(key), dict) for key in ('notes','canvas','embedded','research','learning'))
                    or not isinstance(history.get('since'), (int,float)) or not isinstance(history.get('cutoff'), (int,float))):
                    raise ValueError('Invalid v2 snapshot')
                return {'version': 2, 'exists': True, 'report': raw}
        except (OSError, ValueError, sqlite3.Error):
            return {'version': 2, 'exists': False, 'error': '新报告无法读取，请重新生成'}
        return {'version': 2, 'exists': False, 'report': None}

    def after_archive(self):
        # The persisted revision makes stale reports unreadable even if the
        # process exits between the SQLite commit and report cleanup.
        with self.usage.connection(write=True) as conn:
            pending = conn.execute("SELECT 1 FROM meta WHERE key='archiveReportPending'").fetchone()
            if self.path.exists():
                try:
                    raw = read_json(self.path)
                    history = raw.get('history') if isinstance(raw, dict) else None
                    if not isinstance(history, dict) or history.get('archiveRevision', 0) != self.usage._state(conn)['archiveRevision']:
                        self.path.unlink()
                except (OSError, ValueError):
                    pass  # Revision validation still prevents stale reads.
        return self.generate() if pending else None

    def job(self, identity):
        with self._lock:
            job = self._jobs.get(identity)
            if not job:
                raise KeyError('Generation job not found')
            return dict(job)

    def generate(self):
        with self._lock:
            if self._running:
                return dict(self._jobs[self._running])
            identity = uuid.uuid4().hex
            job = {'id': identity, 'status': 'running', 'progress': 0, 'stage': 'usage'}
            self._jobs[identity] = job
            self._running = identity
            # Retain bounded recent status, not report data or document bodies.
            for key in list(self._jobs)[:-8]:
                self._jobs.pop(key, None)
        threading.Thread(target=self._run, args=(identity,), daemon=True, name='career-report-v2').start()
        return dict(job)

    def _progress(self, identity, progress, stage):
        with self._lock:
            self._jobs[identity].update(progress=progress, stage=stage)

    def build(self, progress=lambda value, stage: None):
        cutoff = self.usage.clock()
        history = self.usage.snapshot(cutoff, note_usage=True)
        progress(10, 'notes')
        notes, refs = note_inventory(self.notes, self.usage, self.notes_store)
        progress(45, 'canvas')
        candidates = self.candidates()
        paths = candidates['paths'] if isinstance(candidates, dict) else candidates
        main = canvas_inventory([(p, os.path.normcase(str(p.resolve()))) for p in paths], 'canvas', self.usage)
        if isinstance(candidates, dict) and candidates.get('skipped'):
            main['skipped'] += candidates['skipped']
            main['status'] = status(len(main['items']), main['skipped'])
            if not main['items']:
                main.update(count=None, nodes=None, edges=None)
        embedded_paths, embedded_skipped = scan_canvases(self.notes / 'canvases')
        embedded = canvas_inventory([(p, 'canvases/' + p.name) for p in embedded_paths], 'embedded', self.usage, refs)
        if embedded_skipped:
            embedded['skipped'] += embedded_skipped
            embedded['status'] = status(len(embedded['items']), embedded['skipped'])
            if not embedded['items']:
                embedded.update(count=None, nodes=None, edges=None, references=None, missingReferences=None)
        progress(65, 'research')
        research = research_inventory(self.data / 'research-workspace' / 'workspace.json', self.usage)
        progress(80, 'learning')
        learning = learning_inventory(self.data)
        progress(90, 'snapshot')
        # Inventories add stable identities without adding time or past events.
        current_entities = self.usage.public_entities()
        history['entities'] = current_entities
        return {'version': 2, 'generatedAt': datetime.fromtimestamp(cutoff / 1000).isoformat(),
                'history': history, 'inventory': {'notes': notes, 'canvas': main, 'embedded': embedded,
                'research': research, 'learning': learning},
                'sources': [{'id': k, 'status': v['status'], 'skipped': v['skipped']}
                            for k,v in (('notes',notes),('canvas',main),('embedded',embedded),('research',research))] + learning['sources']}

    def _run(self, identity):
        started = time.perf_counter()
        try:
            for attempt in range(3):
                report = self.build(lambda value, stage: self._progress(identity, value, stage))
                # A write transaction also coordinates separate local services;
                # no content scans run while holding this publication barrier.
                with self.usage.connection(write=True) as conn:
                    if report['history'].get('archiveRevision', 0) != self.usage._state(conn)['archiveRevision']:
                        continue
                    self.atomic_json(self.path, report)
                    conn.execute("DELETE FROM meta WHERE key='archiveReportPending'")
                    break
            else:
                raise RuntimeError('Usage archive changed during generation')
            with self._lock:
                self._jobs[identity].update(status='complete', progress=100, stage='complete',
                                           elapsedMs=round((time.perf_counter()-started)*1000))
        except Exception as error:
            try:
                with self.usage.connection() as conn:
                    archived = bool(conn.execute("SELECT 1 FROM meta WHERE key='archiveReportPending'").fetchone())
            except (OSError, sqlite3.Error):
                archived = False
            with self._lock:
                self._jobs[identity].update(status='error',
                    code='archive-report-pending' if archived else 'generation-failed',
                    error=f'归档完成，生涯报告生成失败（{type(error).__name__}），请重新生成' if archived else f'生成失败（{type(error).__name__}），原报告已保留')
        finally:
            with self._lock:
                self._running = None

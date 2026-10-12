"""Reproducible real-file note index benchmark (standard library only).

python tests/note-index-performance.py --counts 2000 10000 50000 --output report.json
Use --layouts mixed flat for distributed notebooks and one large notebook.
All files/databases live in a new TemporaryDirectory; user data is never used.
"""
import argparse
import ctypes
import json
import math
import os
import platform
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notes_library import NotesStore


def measure(action, repeats=40):
    samples = []
    action()
    for _ in range(repeats):
        start = time.perf_counter(); action()
        samples.append((time.perf_counter() - start) * 1000)
    ordered = sorted(samples)
    return {'p50_ms': round(statistics.median(samples), 3),
            'p95_ms': round(ordered[math.ceil(len(ordered) * .95) - 1], 3),
            'max_ms': round(max(samples), 3), 'samples': len(samples)}


def memory():
    if os.name != 'nt':
        import resource
        return {'peak_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)}
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
            *[(name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
                'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]]
    process = ctypes.windll.kernel32.GetCurrentProcess
    process.restype = wintypes.HANDLE
    get = ctypes.windll.psapi.GetProcessMemoryInfo
    get.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    value = Counters(); value.cb = ctypes.sizeof(value)
    if not get(process(), ctypes.byref(value), value.cb):
        return {}
    return {'working_mib': round(value.WorkingSetSize / 1048576, 1),
            'peak_mib': round(value.PeakWorkingSetSize / 1048576, 1)}


def wait(store, timeout=900):
    before = time.perf_counter(); report_at = 0
    while time.perf_counter() - before < timeout:
        store.sync.activity(True)
        state = store.index_status()
        if state['phase'] == 'ready' and not store.sync._scan_requested:
            return (time.perf_counter() - before) * 1000
        if time.perf_counter() - before > report_at:
            print(json.dumps({'phase': state['phase'], 'indexed': state['indexed'], 'total': state['total']}, ensure_ascii=False), flush=True)
            report_at += 15
        time.sleep(.05)
    raise RuntimeError('index timeout: ' + str(store.index_status()) + str(getattr(store.sync, '_last_error', '')))


def run(count, layout):
    with tempfile.TemporaryDirectory(prefix=f'relatum-note-index-{layout}-{count}-') as temporary:
        root = Path(temporary); notes = root / 'notes'; notes.mkdir()
        paths = []
        for i in range(count):
            parent = '' if layout == 'flat' or i % 2 == 0 else f'CustomNotebook/Book{i % 5}/Folder{i % 20}'
            path = (parent + '/' if parent else '') + f'N{i:05}.md'
            target = notes / path; target.parent.mkdir(parents=True, exist_ok=True)
            refs = '\n'.join(f'[[N{(i + j + 1) % count:05}]]' for j in range(8))
            text = f'# 笔记 {i} Notebook\n\n连续字符检索，学习知识与关系。Hello world, Alpha beta.\n#学习/统计 #group{i % 20}\n\n```python\ndef calculate_{i}(x):\n    return x + 1\n```\n\n' + refs + '\n\n' + ('段落测试，包含中文、English 与 emoji 😀。\n' * 10)
            if i % 1000 == 0:
                text += '长文档专项 ' + ('知识与计算 performance ' * 5000)
            target.write_text(text, encoding='utf-8', newline='')
            paths.append(path)
        (notes / 'Save.md').write_text('save baseline\n' * 80, encoding='utf-8', newline='')
        store = NotesStore(notes, index_path=root / 'data' / 'note-index.sqlite3', background_index=True)
        store.index.status()  # separate SQLite schema/capability setup from timing
        save_revision = store.load('Save.md')['revision']
        save_counter = 0
        def save():
            nonlocal save_revision, save_counter
            save_counter += 1
            result = store.save('Save.md', f'save {save_counter}\n' + 'save baseline\n' * 80, save_revision)
            save_revision = result['revision']
        baseline = measure(save, 60)
        reads = 0
        read_note = store._read_note_bytes
        def counted(path):
            nonlocal reads
            reads += 1; return read_note(path)
        store._read_note_bytes = counted
        start = time.perf_counter()
        store.sync.activity(True)
        while not store.sync._scanned:
            time.sleep(.02)
        catalog_ms = (time.perf_counter() - start) * 1000
        during_build = measure(save, 60)
        wait(store)
        first_ms = (time.perf_counter() - start) * 1000
        built_reads = reads
        store.sync.activity(False)
        benchmark = {}
        with mock.patch('os.scandir', side_effect=AssertionError('query performed directory scan')), \
             mock.patch.object(store, '_read_note_bytes', side_effect=AssertionError('query reread Markdown')):
            benchmark['directory'] = measure(lambda: store.children('', sort='name-asc'))
            benchmark['directory_modified'] = measure(lambda: store.children('', sort='modified-desc'))
            benchmark['tags'] = measure(store.tags)
            benchmark['backlinks'] = measure(lambda: store.links(paths[0]))
            benchmark['regular_rare'] = measure(lambda: store.query({'q': f'calculate_{count // 2}'}))
            benchmark['regular_common'] = measure(lambda: store.query({'q': '"Hello world"'}))
            benchmark['one_character'] = measure(lambda: store.query({'q': '学'}))
            benchmark['two_characters'] = measure(lambda: store.query({'q': '学习'}))
            benchmark['filtered'] = measure(lambda: store.query({'q': '知识', 'tags': ['group1'], 'scope': {'kind': 'all'}}))
        footprint = sum(Path(str(store.index.path) + suffix).stat().st_size for suffix in ('', '-wal', '-shm') if Path(str(store.index.path) + suffix).exists())
        memory_built = memory()
        store.close()
        store = NotesStore(notes, index_path=root / 'data' / 'note-index.sqlite3', background_index=True)
        reads = 0; read_note = store._read_note_bytes
        store._read_note_bytes = counted
        restart_ms = wait(store)
        restart_reads = reads
        assert restart_reads == 0, 'unchanged restart reread Markdown'
        state = store.index.status(); assert state['indexed'] == count + 1
        cleanup_book = 'CustomNotebook/CleanupLoad'
        store.sync.activity(False)
        (notes / cleanup_book).mkdir(parents=True)
        for i in range(1024):
            (notes / cleanup_book / f'Cleanup-{i}.md').write_text('cleanup content #temporary\n' * 40, encoding='utf-8', newline='')
        store.sync.request_scan(); store.sync.activity(True); wait(store, 120)
        import shutil
        cleanup_target = (notes / cleanup_book).resolve()
        cleanup_target.relative_to(notes.resolve())
        shutil.rmtree(cleanup_target)
        deleting = time.perf_counter(); store.removed(cleanup_book)
        logical_delete_ms = (time.perf_counter() - deleting) * 1000
        during_cleanup = measure(save, 60)
        # Ten deletion/recreation cycles share a path but never an identity.
        book = 'CustomNotebook/DeleteCycle'; identities = set()
        cleanup_start = time.perf_counter()
        for cycle in range(10):
            store.sync.activity(False)
            store.create('CustomNotebook', 'DeleteCycle', 'folder', create_parents=True)
            for i in range(20):
                store.create(book, f'D{i}', 'note', content='disposable #cycle')
            store.sync.activity(True); wait(store, 60)
            identity = store.index.book_version(book)[0]; assert identity not in identities
            identities.add(identity)
            cycle_target = (notes / book).resolve(); cycle_target.relative_to(notes.resolve())
            shutil.rmtree(cycle_target); store.removed(book)
            assert store.index.query({'q': 'disposable'})['total'] == 0
        store.sync.activity(False)
        # Stop the worker before deterministic final GC measurements.
        store.sync._stop.set()
        with store.sync._condition:
            store.sync._condition.notify_all()
        store.sync._worker.join(5)
        if store.sync._watcher:
            store.sync._watcher.join(5)
        while store.index.maintenance():
            pass
        gc_ms = (time.perf_counter() - cleanup_start) * 1000
        with store.index.read() as conn:
            free_pages = conn.execute('PRAGMA freelist_count').fetchone()[0]
            integrity = conn.execute('PRAGMA quick_check').fetchone()[0]
        store.close()
        targets = {'directory': 50, 'directory_modified': 50, 'tags': 50, 'backlinks': 50,
                   'regular_rare': 150, 'regular_common': 150, 'one_character': 300, 'two_characters': 300, 'filtered': 150}
        result = {'count': count, 'layout': layout, 'catalog_ms': round(catalog_ms, 2),
            'first_build_ms': round(first_ms, 2), 'body_reads_first_build': built_reads,
            'restart_ms': round(restart_ms, 2), 'body_reads_restart': restart_reads,
            'query_filesystem_scans': 0, 'query_body_reads': 0, 'queries': benchmark,
            'save_baseline': baseline, 'save_during_build': during_build,
            'save_p95_increase_percent': round((during_build['p95_ms'] / baseline['p95_ms'] - 1) * 100, 1),
            'save_during_cleanup': during_cleanup,
            'cleanup_save_p95_increase_percent': round((during_cleanup['p95_ms'] / baseline['p95_ms'] - 1) * 100, 1),
            'logical_delete_1024_ms': round(logical_delete_ms, 3),
            'index_and_wal_mib': round(footprint / 1048576, 2), 'memory': memory_built,
            'delete_recreate_cycles': 10, 'cleanup_and_cycles_ms': round(gc_ms, 2), 'free_pages': free_pages,
            'integrity': integrity, 'latency_targets_met': all(benchmark[k]['p95_ms'] <= value for k, value in targets.items()),
            'save_targets_met': max(during_build['p95_ms'], during_cleanup['p95_ms']) <= baseline['p95_ms'] * 1.2}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--counts', type=int, nargs='+', default=[2000, 10000, 50000])
    parser.add_argument('--layouts', nargs='+', choices=['mixed', 'flat'], default=['mixed'])
    parser.add_argument('--output', type=Path, required=True)
    options = parser.parse_args()
    report = {'platform': platform.platform(), 'python': sys.version, 'sqlite': sqlite3.sqlite_version,
              'method': 'real UTF-8 Markdown, 8 wiki links/note, code, tags, emoji, 1/1000 long documents; 40 warm samples; p95 nearest rank; 60 real atomic saves', 'runs': []}
    for layout in options.layouts:
        for count in options.counts:
            report['runs'].append(run(count, layout))
            options.output.parent.mkdir(parents=True, exist_ok=True)
            options.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

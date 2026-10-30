"""Real disposable Markdown libraries; link latency and concurrent atomic saves."""
import argparse
import json
import math
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notes_library import NotesStore


def measure(action, repeats=30):
    action()
    values = []
    for _ in range(repeats):
        start = time.perf_counter()
        action()
        values.append((time.perf_counter() - start) * 1000)
    return {'p50_ms': round(statistics.median(values), 3),
            'p95_ms': round(sorted(values)[math.ceil(len(values) * .95) - 1], 3), 'samples': repeats}


def run(count):
    with tempfile.TemporaryDirectory(prefix='relatum-link-performance-') as directory:
        root = Path(directory)
        notes = root / 'notes'
        paths = []
        for number in range(count):
            folder = notes / ('Folder' + str(number % 8) if number % 2 else 'CustomNotebook/Book' + str(number % 5))
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / f'学习{number:05}.md'
            target.write_text('Commonneedle 知识正文。\n#学习/主题\n', encoding='utf-8', newline='')
            paths.append(target.relative_to(notes).as_posix())
        (notes / 'Source.md').write_text('save baseline\n' * 20, encoding='utf-8', newline='')
        store = NotesStore(notes, index_path=root / 'index.sqlite3', background_index=True)
        try:
            start = time.perf_counter()
            store.sync.activity(True)
            store.sync.complete(timeout=600)
            store.sync.activity(False)
            state = store.sync.status()
            assert state['indexed'] == count + 1, state
            build_seconds = round(time.perf_counter() - start, 2)
            recent = {path: number + 1 for number, path in enumerate(paths[:200])}
            def query(q='', **options):
                return store.query({'mode': 'link-completion', 'q': q, 'sourcePath': 'Source.md', 'recent': recent, **options})
            with mock.patch('os.scandir', side_effect=AssertionError('hot query directory traversal')), \
                    mock.patch.object(store, '_read_note_bytes', side_effect=AssertionError('hot query Markdown reread')):
                timings = {name: measure(action) for name, action in {
                    'empty': lambda: query(), 'one_character': lambda: query('学'), 'two_characters': lambda: query('学习'),
                    'exact': lambda: query('学习00001'), 'body_common': lambda: query('Commonneedle', includeBody=True),
                    'selected_recheck': lambda: query('学习', selectedPath=paths[0]),
                }.items()}
            revision = store.load('Source.md')['revision']
            serial = 0
            def save():
                nonlocal revision, serial
                serial += 1
                revision = store.save('Source.md', f'save {serial}\n' + 'baseline\n' * 20, revision)['revision']
            baseline = measure(save)
            stop = threading.Event()
            failures = []
            def worker():
                try:
                    while not stop.is_set():
                        query('学习')
                except Exception as error:
                    failures.append(str(error))
            thread = threading.Thread(target=worker)
            thread.start()
            try:
                concurrent = measure(save)
            finally:
                stop.set(); thread.join(timeout=10)
            assert not thread.is_alive() and not failures, failures
            return {'count': count, 'build_seconds': build_seconds, 'queries': timings, 'save_baseline': baseline,
                    'save_during_queries': concurrent, 'hot_directory_scans': 0, 'hot_markdown_reads': 0}
        finally:
            store.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--counts', nargs='+', type=int, default=[10000, 50000])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    results = []
    for count in args.counts:
        if count < 200:
            parser.error('counts must be at least 200')
        results.append(run(count))
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    if args.output:
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')

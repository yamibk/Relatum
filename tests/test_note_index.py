"""SQLite cache, literal search and filesystem lifecycle contracts.

Every database/Markdown file belongs to a disposable directory. Warm production
queries are checked with filesystem reads disabled, not only with timings.
"""
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from note_search import projection, hit, normalize, terms
from notes_index import NoteIndex
from notes_library import NotesStore, NotesError, _image_text_comment


class NoteIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'notes'
        self.database = Path(self.temp.name) / 'data' / 'note-index.sqlite3'
        self.store = NotesStore(self.root, index_path=self.database)
        self.addCleanup(lambda: self.store.close())
        self.store.ensure_root()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8', newline='')
        return target

    def query(self, q='', **options):
        return self.store.query(dict(mode='search', q=q, **options))

    def test_literal_short_long_and_phrases(self):
        self.write('TitleAlpha.md', '# Hello 世界 😀\nAlpha beta\n```py\ndef calculate(x): return x + 1\n```\n#学习/统计 #AI')
        self.write('Other.md', 'alpha\nbeta 世界人\n#学习/概率')
        self.assertEqual(self.query('世')['total'], 2)
        self.assertEqual(self.query('世界')['total'], 2)
        self.assertEqual(self.query('世界人')['total'], 1)
        self.assertEqual(self.query('ALPHA beta')['total'], 2)
        self.assertEqual(self.query('"Alpha beta"')['total'], 1)
        self.assertEqual(self.query('"return x"')['total'], 1)
        self.assertEqual(self.query('😀')['total'], 1)
        self.assertEqual(self.query('alpha 世界', tags=['AI', '学习'])['total'], 1)
        self.assertEqual(self.query('alpha')['items'][0]['path'], 'TitleAlpha.md', 'title has priority over body')
        for invalid in ('"incomplete', '"escape\\'):
            with self.assertRaises(NotesError):
                self.query(invalid)
        self.assertEqual(self.query('" OR 1=1 -- "')['total'], 0)

    def test_projection_excludes_hidden_payloads_and_keeps_code(self):
        overlay = _image_text_comment([dict(id='label', text='可见图上文字 ABC', x=.5, y=.5, size='md', color='black')])
        source = '---\nprivate: SECRET_FRONTMATTER\n---\n<!--SECRET_COMMENT-->\n%%SECRET_PERCENT%%\n![图](image.png)' + overlay + '\n`<!--CODE_VISIBLE-->`\n```html\n<!--FENCE_VISIBLE-->\n```\n![data](data:image/png;base64,SECRET_DATA)\n'
        self.write('Image.md', source)
        for word in ('SECRET_FRONTMATTER', 'SECRET_COMMENT', 'SECRET_PERCENT', 'SECRET_DATA', 'relatum:image-text'):
            self.assertEqual(self.query(word)['total'], 0, word)
        for word in ('CODE_VISIBLE', 'FENCE_VISIBLE', '可见图上文字', 'abc'):
            self.assertEqual(self.query(word)['total'], 1, word)
        item = self.query('可见图上文字')['items'][0]
        self.assertIn('可见图上文字', item['excerpt'])
        self.assertLess(item['sourceRange'][0], source.index('![图]') + 1)

    def test_source_offsets_and_display_case_survive_normalization(self):
        source = '# Heading 😀\nA cafe\u0301 and Straße **世界**!\n'
        body, mapping = projection(source)
        for word, expected in [('café', 'cafe\u0301'), ('STRASSE', 'Straße'), ('😀', '😀'), ('世界', '世界')]:
            result = hit(body, terms(word), mapping)
            start, end = result['sourceRange']
            selected = source.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')
            self.assertEqual(selected, expected)
            self.assertIn('Heading', result['excerpt'])
            ranges = [result['excerpt'].encode('utf-16-le')[a * 2:b * 2].decode('utf-16-le') for a, b in result['highlights']]
            self.assertIn(expected, ranges)

    def test_scope_dates_tags_and_cursor_generation(self):
        for i in range(68):
            self.write(f'Folder/N{i:03}.md', 'same token #学/测')
        self.write('CustomNotebook/One/A.md', 'same token #学')
        self.write('Outside.md', 'same token')
        first = self.query('same', scope={'kind': 'folder', 'path': 'Folder'}, tags=['学'])
        self.assertEqual(first['total'], 68)
        self.assertEqual(len(first['items']), 50)
        second = self.query('same', scope={'kind': 'folder', 'path': 'Folder'}, tags=['学'], cursor=first['cursor'])
        self.assertEqual(len(second['items']), 18)
        self.assertFalse(set(x['path'] for x in first['items']) & set(x['path'] for x in second['items']))
        self.assertEqual(self.query('same', scope={'kind': 'notebook', 'path': ''})['total'], 69)
        self.assertEqual(self.query('same')['total'], 70)
        self.assertEqual(self.query('same', modified={'after': time.time_ns() + 10 ** 12})['total'], 0)
        self.write('Folder/New.md', 'same token')
        with self.assertRaises(NotesError) as caught:
            self.query('same', scope={'kind': 'folder', 'path': 'Folder'}, tags=['学'], cursor=first['cursor'])
        self.assertEqual(caught.exception.code, 'query_changed')
        with self.assertRaises(NotesError):
            self.store.children('Folder', limit=51)

    def test_directory_six_orders_are_paged_and_stable(self):
        for i in range(65):
            file = self.write(f'N{i}.md', 'body')
            os.utime(file, (1000 + i, 1000 + i))
        (self.root / 'ZFolder').mkdir()
        self.store.sync.scan()
        self.assertEqual(self.store.children('', sort='name-asc')['items'][1]['path'], 'N0.md')
        for sort in ('name-asc', 'name-desc', 'modified-asc', 'modified-desc', 'created-asc', 'created-desc'):
            rows = self.store.children('', sort=sort)
            more = self.store.children('', offset=50, sort=sort)
            self.assertEqual(rows['items'][0]['kind'], 'folder')
            self.assertEqual(rows['total'], 66)
            self.assertEqual(len({r['path'] for r in rows['items'] + more['items']}), 66)

    def test_restart_reuses_content_and_hot_queries_do_not_touch_files(self):
        self.write('A.md', 'needle [[B]] #tag')
        self.write('B.md', 'needle')
        self.store.sync.complete(graph=True)
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database, background_index=True)
        self.store.sync.activity(True)
        with mock.patch.object(self.store, '_read_note_bytes', wraps=self.store._read_note_bytes) as reads:
            self.store.sync.complete(timeout=10)
            self.assertEqual(reads.call_count, 0, 'restart only checks unchanged file states')
        self.store.sync.activity(False)
        with mock.patch('os.scandir', side_effect=AssertionError('warm filesystem traversal')), \
             mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('warm body read')):
            self.assertEqual(self.query('needle')['total'], 2)
            self.assertEqual(self.store.tags()['items'][0]['key'], 'tag')
            self.assertEqual(self.store.links('B.md')['backlinks'][0]['path'], 'A.md')
            self.assertEqual(self.store.children()['total'], 2)

    def test_same_file_state_notification_verifies_bytes(self):
        file = self.write('A.md', 'before')
        self.store.sync.complete()
        old = file.stat()
        file.write_text('after!', encoding='utf-8', newline='')
        os.utime(file, ns=(old.st_atime_ns, old.st_mtime_ns))
        self.store.sync.enqueue('A.md')
        self.store.sync.drain()
        self.assertEqual(self.store.index.query({'q': 'after!'})['total'], 1)
        self.assertEqual(self.store.index.query({'q': 'before'})['total'], 0)

    def test_directory_notification_reads_only_affected_subtree(self):
        self.write('Existing.md', 'old')
        self.store.sync.complete()
        self.write('Added/Inside.md', 'new')
        scan = os.scandir
        visited = []
        def tracked(folder):
            visited.append(Path(folder)); return scan(folder)
        with mock.patch('os.scandir', side_effect=tracked):
            self.store.sync.enqueue('Added', notification=True); self.store.sync.drain()
        self.assertEqual(visited, [self.root / 'Added'])
        self.assertEqual(self.store.index.query({'q': 'new'})['total'], 1)

    def test_external_case_rename_and_entry_kind_replacement(self):
        file = self.write('lower.md', 'body #tag')
        self.store.sync.complete()
        generation = self.store.index.status()['generation']
        intermediate = file.with_name('temporary.md'); file.rename(intermediate)
        intermediate.rename(file.with_name('LOWER.md'))
        self.store.sync.scan(drain=True)
        changes = self.store.index.changes(generation)['changes']
        self.assertTrue(any(item['path'] == 'lower.md' and item['removed'] for item in changes))
        self.assertEqual(self.store.children()['items'][0]['path'], 'LOWER.md')
        (self.root / 'LOWER.md').unlink(); (self.root / 'LOWER.md').mkdir()
        self.write('LOWER.md/Child.md', 'child')
        self.store.sync.scan(drain=True)
        self.assertEqual(self.store.children()['items'][0]['kind'], 'folder')
        self.assertEqual(self.store.index.tags()['items'], [])

    def test_failed_scan_preserves_data_and_external_delete_requires_success(self):
        self.write('Folder/A.md', '#tag needle')
        self.store.sync.complete()
        scan = os.scandir
        with mock.patch('os.scandir', side_effect=lambda folder: (_ for _ in ()).throw(PermissionError('locked')) if Path(folder) == self.root / 'Folder' else scan(folder)):
            self.store.sync.scan()
            self.assertTrue(self.store.sync.status()['incomplete'])
            self.assertEqual(self.store.index.query({'q': 'needle'})['total'], 1)
        (self.root / 'Folder/A.md').unlink()
        self.store.sync.scan()
        self.assertEqual(self.store.index.query({'q': 'needle'})['total'], 0)

    def test_removed_unreadable_note_clears_partial_status(self):
        file = self.write('Bad.md', 'before')
        self.store.sync.complete()
        file.write_bytes(b'\xff')
        self.store.sync.scan(drain=True)
        self.assertEqual(self.store.sync.status()['phase'], 'partial')
        file.unlink(); self.store.sync.enqueue('Bad.md'); self.store.sync.drain()
        self.assertEqual(self.store.sync.status()['phase'], 'ready')

    def test_notebook_identity_delete_cleanup_and_recreate(self):
        book = 'CustomNotebook/Book'
        self.write(book + '/Target.md', 'unique #oldtag')
        self.write('Consumer.md', '[[CustomNotebook/Book/Target]]')
        self.store.sync.complete()
        identity = self.store.index.book_version(book)[0]
        self.assertEqual(self.store.links('Consumer.md')['outgoing'][0]['state'], 'resolved')
        self.store.sync.enqueue(book + '/Target.md', book=identity)
        stale = self.store.sync._pending.pop(book + '/Target.md')
        shutil.rmtree(self.root / book)
        self.store.removed(book)
        self.assertEqual(self.store.index.query({'q': 'unique'})['total'], 0)
        self.assertEqual(self.store.index.tags()['items'], [])
        self.assertEqual(self.store.index.links('Consumer.md')['outgoing'][0]['state'], 'missing')
        self.write(book + '/Target.md', 'reborn #newtag')
        self.store.sync.scan()
        replacement = self.store.index.book_version(book)[0]
        self.assertNotEqual(replacement, identity)
        self.store.sync._process(book + '/Target.md', stale)
        self.store.sync.drain()
        while self.store.index.maintenance():
            pass
        self.assertEqual(self.query('reborn')['total'], 1)
        self.assertEqual(self.store.index.book_version(book)[0], replacement)
        with self.store.index.read() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM entries WHERE book=?', (identity,)).fetchone()[0], 0)
            self.assertEqual(conn.execute('PRAGMA auto_vacuum').fetchone()[0], 2)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_interrupted_build_resumes_from_sqlite_pending_work(self):
        for i in range(12):
            self.write(f'A{i}.md', 'needle')
        self.store.sync.scan()
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database)
        self.assertEqual(self.store.index.status()['pendingDocuments'], 12)
        self.store.sync._pending.clear()
        self.store.sync.drain()
        self.assertEqual(self.store.index.status()['indexed'], 12)
        self.assertEqual(self.store.index.status()['pendingDocuments'], 0)

    def test_notification_pending_at_exit_survives_unchanged_file_state(self):
        file = self.write('A.md', 'before')
        self.store.sync.complete()
        original = file.stat()
        file.write_text('after!', encoding='utf-8', newline='')
        os.utime(file, ns=(original.st_atime_ns, original.st_mtime_ns))
        self.store.sync.enqueue('A.md', notification=True)
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database)
        self.store.sync.complete()
        self.assertEqual(self.store.index.query({'q': 'after!'})['total'], 1)

    def test_tree_entries_and_generation_share_one_snapshot(self):
        self.write('Old.md', 'old')
        self.store.sync.complete()
        before = self.store.index.status()['generation']
        children = self.store.index.children
        created = False
        def interleaved(*args, **options):
            nonlocal created
            if not created:
                created = True
                self.write('New.md', 'new')
                self.store._publish_path('New.md')
            return children(*args, **options)
        with mock.patch.object(self.store.index, 'children', side_effect=interleaved):
            tree = self.store.tree({})
        self.assertEqual(tree['generation'], before)
        self.assertEqual([r['path'] for r in tree['entries']], ['Old.md'])
        self.assertIn('New.md', [r['path'] for r in self.store.index.changes(tree['generation'])['changes']])

    def test_directory_cursor_detects_only_directory_changes(self):
        self.write('A.md', 'a')
        self.store.sync.complete()
        generation = self.store.children()['generation']
        self.store.index.record('A.md', 'derived-test', {'tags': [], 'excerpt': 'a'}, 'a', {'source': [[0,1,0,1]], 'display': []},
                                ((self.root / 'A.md').stat().st_mtime_ns, 1))
        self.assertEqual(self.store.index.children(generation=generation)['generation'], generation)
        self.write('B.md', 'b'); self.store.sync.scan()
        with self.assertRaises(ValueError):
            self.store.index.children(generation=generation)

    def test_read_only_warm_graph_uses_shared_body_parse(self):
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database, background_index=True)
        self.write('A.md', '[[B]]'); self.write('B.md', 'body')
        self.store.sync.activity(True); self.store.sync.complete(timeout=10)
        with mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('graph body reread')):
            self.assertEqual(len(self.store.graph('')['edges']), 1)

    def test_corrupt_index_is_rebuilt_without_changing_markdown(self):
        self.write('A.md', 'authority')
        self.store.close()
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self.database.write_bytes(b'not a database')
        self.store = NotesStore(self.root, index_path=self.database)
        self.assertEqual(self.query('authority')['total'], 1)
        self.assertEqual((self.root / 'A.md').read_text(encoding='utf-8'), 'authority')

    def test_missing_fts_table_rebuilds_private_cache(self):
        self.write('A.md', 'authority')
        self.store.sync.complete()
        with self.store.index.write() as conn:
            conn.execute('DROP TABLE short_fts')
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database)
        self.assertEqual(self.query('au')['total'], 1)

    def test_external_replacement_at_same_notebook_path_gets_new_identity(self):
        book = 'CustomNotebook/Book'
        self.write(book + '/A.md', 'old')
        self.store.sync.complete()
        old = self.store.index.book_version(book)[0]
        shutil.rmtree(self.root / book)
        self.write(book + '/A.md', 'new')
        self.store.sync.complete()
        self.assertNotEqual(self.store.index.book_version(book)[0], old)
        self.assertEqual(self.query('old')['total'], 0)
        self.assertEqual(self.query('new')['total'], 1)

    def test_reader_snapshot_does_not_wait_for_writer(self):
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database, background_index=True)
        self.write('A.md', 'needle')
        self.store.sync.activity(True)
        self.store.sync.complete(timeout=10)
        self.store.sync.activity(False)
        entered, release = threading.Event(), threading.Event()
        def write():
            with self.store.index.write() as conn:
                conn.execute("UPDATE settings SET value=value WHERE key='generation'")
                entered.set(); release.wait(3)
        thread = threading.Thread(target=write)
        thread.start(); self.assertTrue(entered.wait(3))
        try:
            before = time.perf_counter()
            self.assertEqual(self.store.index.query({'q': 'needle'})['total'], 1)
            self.assertLess(time.perf_counter() - before, .5, 'WAL readers must not acquire the writer mutex')
        finally:
            release.set(); thread.join(3)

    def test_index_maintenance_yields_to_foreground_without_losing_cleanup(self):
        book = 'CustomNotebook/Clean'
        for i in range(12):
            self.write(book + f'/N{i}.md', 'body #temporary')
        self.store.sync.complete()
        old = self.store.index.book_version(book)[0]
        self.store.removed(book)
        self.assertTrue(self.store.index.maintenance(lambda: True))
        with self.store.index.read() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM entries WHERE book=?', (old,)).fetchone()[0], 13)
        while self.store.index.maintenance():
            pass
        with self.store.index.read() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM entries WHERE book=?', (old,)).fetchone()[0], 0)

    def test_graph_signature_ignores_non_topology_edits(self):
        self.write('A.md', '[[B]] initial')
        self.write('B.md', 'body')
        graph = self.store.graph('')
        loaded = self.store.load('A.md')
        self.store.save('A.md', '[[B]] changed prose', loaded['revision'])
        self.assertEqual(self.store.graph('')['signature'], graph['signature'])

    def test_move_reuses_unchanged_content_and_transfers_tag_ownership(self):
        self.write('CustomNotebook/Source/A.md', 'unchanged #学/测')
        (self.root / 'CustomNotebook/Target').mkdir()
        self.store.sync.complete()
        from notes_library import note_metadata
        with mock.patch('notes_library.note_metadata', wraps=note_metadata) as parsed:
            self.store.move('CustomNotebook/Source/A.md', 'CustomNotebook/Target/A.md')
            self.store.sync.drain()
            self.assertEqual(parsed.call_count, 0, 'a path change must not parse unchanged body metadata')
        self.store.removed('CustomNotebook/Source')
        self.assertEqual(self.store.index.tags()['items'][0]['count'], 1)
        target = self.store.index.book_version('CustomNotebook/Target')[0]
        with self.store.index.read() as conn:
            self.assertEqual(conn.execute('SELECT DISTINCT book FROM tags').fetchone()[0], target)

    def test_pause_defers_new_body_parsing_and_close_releases_threads(self):
        self.store.close()
        self.store = NotesStore(self.root, index_path=self.database, background_index=True)
        self.write('A.md', 'before')
        self.store.sync.activity(True); self.store.sync.complete(timeout=10)
        self.store.sync.activity(False)
        self.write('A.md', 'after')
        self.store.sync.enqueue('A.md', priority=True)
        time.sleep(.1)
        self.assertEqual(self.store.index.query({'q': 'before'})['total'], 1)
        self.store.sync.activity(True); self.store.sync.complete(timeout=10)
        self.assertEqual(self.store.index.query({'q': 'after'})['total'], 1)
        self.store.close()
        self.assertFalse(self.store.sync._worker.is_alive())
        if self.store.sync._watcher:
            self.assertFalse(self.store.sync._watcher.is_alive())


if __name__ == '__main__':
    unittest.main()

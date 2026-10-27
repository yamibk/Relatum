"""Durable color metadata and existing filesystem lifecycle, on disposable notes."""
import sqlite3
import os
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from notes_library import NotesStore, NotesError


class FileColorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'notes'
        self.root.mkdir()
        (self.root / 'Folder').mkdir()
        (self.root / 'Folder' / 'A.md').write_text('original\n', encoding='utf-8')
        (self.root / 'B.md').write_text('other\n', encoding='utf-8')
        self.store = NotesStore(self.root)
        self.addCleanup(lambda: self.store.close())

    def colors(self, *paths):
        return self.store.query_file_colors(list(paths))['colors']

    def test_sparse_lazy_storage_and_query_without_filesystem_scan(self):
        self.assertEqual(self.colors('B.md'), {})
        self.store.sync.scan()
        self.assertFalse(self.store.file_colors.path.exists())
        self.store.set_file_color('Folder', 'blue')
        first = self.store.set_file_color('Folder/A.md', 'red')
        with mock.patch('os.scandir', side_effect=AssertionError('color read walked files')), \
             mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('body read')):
            self.assertEqual(self.colors('Folder', 'Folder/A.md', 'B.md'), {'Folder': 'blue', 'Folder/A.md': 'red'})
        self.assertEqual(self.store.set_file_color('Folder/A.md', 'red')['generation'], first['generation'])
        self.store.set_file_color('Folder/A.md', None)
        with self.store.file_colors.connection() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM colors').fetchone()[0], 1)
        self.assertEqual((self.root / 'Folder/A.md').read_text(encoding='utf-8'), 'original\n')

    def test_clear_all_removes_only_colors_and_is_lazy_and_idempotent(self):
        self.assertEqual(self.store.clear_file_colors(), {'generation': 0, 'cleared': 0})
        self.assertFalse(self.store.file_colors.path.exists())
        self.store.set_file_color('Folder', 'blue')
        self.store.set_file_color('Folder/A.md', 'red')
        before = self.store.set_file_color('B.md', 'green')['generation']
        with mock.patch('os.scandir', side_effect=AssertionError('clear walked notes')):
            result = self.store.clear_file_colors()
        self.assertEqual(result, {'generation': before + 1, 'cleared': 3})
        self.assertEqual(self.colors('Folder', 'Folder/A.md', 'B.md'), {})
        self.assertEqual(self.store.clear_file_colors(), {'generation': before + 1, 'cleared': 0})
        self.assertEqual((self.root / 'Folder/A.md').read_text(encoding='utf-8'), 'original\n')
        self.assertTrue(self.store.file_colors.path.exists())

    def test_failed_clear_rolls_back_records_and_generation(self):
        self.store.set_file_color('Folder', 'blue')
        before = self.store.set_file_color('B.md', 'red')['generation']
        with self.store.file_colors.connection() as conn:
            conn.execute("CREATE TRIGGER fail_clear BEFORE DELETE ON colors WHEN OLD.path='B.md' "
                         "BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.clear_file_colors()
        self.assertEqual(self.colors('Folder', 'B.md'), {'Folder': 'blue', 'B.md': 'red'})
        self.assertEqual(self.store.file_colors.generation(), before)

    def test_path_type_and_palette_validation(self):
        for value in ('../escape.md', 'Folder/../../escape.md', 'C:/escape.md', 'Folder.assets/X.md'):
            with self.subTest(path=value), self.assertRaises(NotesError):
                self.store.set_file_color(value, 'blue')
        for value in ('#ff0000', {}, True):
            with self.assertRaises(NotesError):
                self.store.set_file_color('B.md', value)
        with self.assertRaises(NotesError):
            self.store.query_file_colors(['B.md'] * 513)
        with self.assertRaises(NotesError):
            self.store.set_file_color('Missing.md', 'blue')
        (self.root / 'other.txt').write_text('text')
        with self.assertRaises(NotesError):
            self.store.set_file_color('other.txt', 'blue')
        self.assertFalse(self.store.file_colors.path.exists())

    def test_restart_and_rebuilt_index_keep_colors_and_reconcile_missing_rows(self):
        self.store.set_file_color('Folder/A.md', 'purple')
        self.store.sync.scan()
        self.store.close()
        # Exercise the index's actual version mismatch/rebuild path.
        with closing(sqlite3.connect(self.store.index.path)) as conn:
            conn.execute('PRAGMA user_version=999')
        (self.root / 'Folder/A.md').unlink()
        self.store = NotesStore(self.root)
        self.assertEqual(self.colors('Folder/A.md'), {'Folder/A.md': 'purple'})
        self.store.sync.scan()
        self.assertEqual(self.colors('Folder/A.md'), {})
        self.assertTrue(self.store.file_colors.path.exists())

    def test_internal_move_subtree_case_rename_and_failed_move(self):
        self.store.set_file_color('Folder', 'green')
        self.store.set_file_color('Folder/A.md', 'yellow')
        self.store.move('Folder', 'Moved')
        self.assertEqual(self.colors('Folder', 'Moved', 'Moved/A.md'), {'Moved': 'green', 'Moved/A.md': 'yellow'})
        self.store.move('Moved/A.md', 'Moved/a.md')
        self.assertEqual(self.colors('Moved/a.md'), {'Moved/a.md': 'yellow'})
        with self.assertRaises(NotesError):
            self.store.move('Moved/a.md', 'B.md')
        self.assertEqual(self.colors('Moved/a.md'), {'Moved/a.md': 'yellow'})

    def test_external_paired_folder_rename_precedes_old_path_retirement(self):
        self.store.set_file_color('Folder', 'green')
        self.store.set_file_color('Folder/A.md', 'cyan')
        self.store.sync.scan()
        (self.root / 'Folder').rename(self.root / 'External')
        self.store.sync.notifications([(4, 'Folder'), (5, 'External')])
        self.store.sync.scan()
        self.assertEqual(self.colors('Folder', 'External', 'External/A.md'), {'External': 'green', 'External/A.md': 'cyan'})
        (self.root / 'External/A.md').unlink()
        self.store.sync.notifications([(2, 'External/A.md')])
        self.store.sync.drain()
        self.assertEqual(self.colors('External', 'External/A.md'), {'External': 'green'})
        (self.root / 'External').rmdir()
        self.store.sync.scan()
        self.assertEqual(self.colors('External'), {})

    def test_unmatched_rename_does_not_guess_or_color_a_recreated_file(self):
        self.store.set_file_color('B.md', 'blue')
        self.store.sync.scan()
        (self.root / 'B.md').rename(self.root / 'Other.md')
        self.store.sync.notifications([(4, 'B.md')])
        self.store.sync.notifications([(5, 'Other.md')])
        self.store.sync.scan()
        self.assertEqual(self.colors('B.md', 'Other.md'), {})
        (self.root / 'B.md').write_text('new')
        self.store.sync.scan()
        self.assertEqual(self.colors('B.md'), {})

    def test_scan_failure_and_interruption_never_prune_colors(self):
        self.store.set_file_color('Folder/A.md', 'orange')
        scandir = __import__('os').scandir
        with mock.patch('os.scandir', side_effect=lambda path: (_ for _ in ()).throw(PermissionError('locked'))
                        if Path(path) == self.root / 'Folder' else scandir(path)):
            self.store.sync.scan()
        self.assertEqual(self.colors('Folder/A.md'), {'Folder/A.md': 'orange'})
        with mock.patch.object(self.store.sync, '_walk', side_effect=InterruptedError('paused')):
            with self.assertRaises(InterruptedError):
                self.store.sync.scan()
        self.assertEqual(self.colors('Folder/A.md'), {'Folder/A.md': 'orange'})

    def test_color_failure_does_not_fail_committed_move_or_delete(self):
        self.store.set_file_color('B.md', 'blue')
        with mock.patch.object(self.store.file_colors, 'remap', side_effect=sqlite3.OperationalError('locked')):
            result = self.store.move('B.md', 'New.md')
        self.assertEqual(result['path'], 'New.md')
        self.assertTrue(result['warnings'])
        self.assertTrue((self.root / 'New.md').exists())
        (self.root / 'New.md').unlink()
        with mock.patch.object(self.store.file_colors, 'remove', side_effect=sqlite3.OperationalError('locked')):
            self.store.removed('New.md')
        self.assertTrue(self.store.file_color_warning)

    def test_corrupt_color_database_is_never_discarded_or_recreated(self):
        self.store.file_colors.path.parent.mkdir()
        original = b'not a database: preserve user metadata'
        self.store.file_colors.path.write_bytes(original)
        with self.assertRaises(sqlite3.DatabaseError):
            self.colors('B.md')
        self.assertEqual(self.store.file_colors.path.read_bytes(), original)
        self.store.sync.scan()
        self.assertTrue(self.store.file_color_warning)
        self.assertEqual(self.store.file_colors.path.read_bytes(), original)

    def test_partial_default_book_scan_preserves_other_notebooks(self):
        book = self.root / 'CustomNotebook' / 'Book'
        book.mkdir(parents=True)
        (book / 'N.md').write_text('book')
        self.store.set_file_color('CustomNotebook/Book/N.md', 'blue')
        self.store.sync.scan('')
        self.assertEqual(self.colors('CustomNotebook/Book/N.md'), {'CustomNotebook/Book/N.md': 'blue'})

    def test_reconcile_is_batched_and_reuses_walk_results(self):
        colors = self.store.file_colors
        with colors.connection(create=True) as conn:
            conn.executemany('INSERT INTO colors VALUES(?,?,?,?)',
                [(f'gone/{i}.md', f'Gone/{i}.md', 'note', 'blue') for i in range(1200)])
        with mock.patch('os.scandir', side_effect=AssertionError('metadata reconciliation walked disk')):
            colors.reconcile({}, set())
        with colors.connection() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM colors').fetchone()[0], 0)

    def test_notification_during_walk_retries_without_pruning_new_path(self):
        self.store.set_file_color('B.md', 'blue')
        self.store.sync.scan()
        walk = self.store.sync._walk
        def moving_walk(scope):
            result = walk(scope)
            (self.root / 'B.md').rename(self.root / 'External.md')
            self.store.sync.notifications([(4, 'B.md'), (5, 'External.md')])
            return result
        with mock.patch.object(self.store.sync, '_walk', side_effect=moving_walk):
            self.store.sync.scan()
        self.assertEqual(self.colors('B.md'), {'B.md': 'blue'})
        self.store.sync.scan()
        self.assertEqual(self.colors('B.md', 'External.md'), {'External.md': 'blue'})

    def test_color_remap_failure_is_transactional(self):
        self.store.set_file_color('Folder', 'green')
        self.store.set_file_color('Folder/A.md', 'blue')
        with self.store.file_colors.connection() as conn:
            conn.execute("CREATE TRIGGER fail_move BEFORE INSERT ON colors WHEN NEW.path='New/A.md' "
                         "BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.file_colors.remap('Folder', 'New')
        self.assertEqual(self.colors('Folder', 'Folder/A.md', 'New'), {'Folder': 'green', 'Folder/A.md': 'blue'})

    def test_notification_after_walk_before_registration_keeps_retry_requested(self):
        self.store.set_file_color('B.md', 'blue')
        self.store.sync.scan()
        source_identity = self.store.index.source_identity
        moved = False
        def changing_identity(root):
            nonlocal moved
            if not moved:
                moved = True
                (self.root / 'B.md').rename(self.root / 'External.md')
                self.store.sync.notifications([(4, 'B.md'), (5, 'External.md')])
            return source_identity(root)
        with mock.patch.object(self.store.index, 'source_identity', side_effect=changing_identity):
            self.store.sync.scan()
        self.assertTrue(self.store.sync._scan_requested)
        self.store.sync.scan()
        self.assertEqual(self.colors('B.md', 'External.md'), {'External.md': 'blue'})

    def test_missing_job_without_index_row_applies_paired_rename_first(self):
        self.store.set_file_color('B.md', 'blue')
        (self.root / 'B.md').rename(self.root / 'External.md')
        self.store.sync.notifications([(4, 'B.md'), (5, 'External.md')])
        self.store.sync._process('B.md', (None, self.store.sync._serial, self.store.sync._epoch))
        self.assertEqual(self.colors('B.md', 'External.md'), {'External.md': 'blue'})

    @unittest.skipUnless(os.name == 'nt', 'Windows directory notifications')
    def test_native_windows_rename_and_delete_use_existing_watcher(self):
        self.store.set_file_color('Folder', 'green')
        self.store.set_file_color('Folder/A.md', 'blue')
        self.store.sync.start()
        def wait_for(check):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if check():
                    return
                time.sleep(.02)
            self.fail('existing directory watcher did not publish the change')
        wait_for(lambda: self.store.sync._watch_supported and self.store.sync._scanned)
        (self.root / 'Folder').rename(self.root / 'Native')
        wait_for(lambda: self.colors('Native', 'Native/A.md') == {'Native': 'green', 'Native/A.md': 'blue'})
        (self.root / 'Native/A.md').unlink()
        wait_for(lambda: self.colors('Native', 'Native/A.md') == {'Native': 'green'})
        (self.root / 'Native').rmdir()
        wait_for(lambda: not self.colors('Native'))


if __name__ == '__main__':
    unittest.main()

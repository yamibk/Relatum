"""Read-only canvas discovery, always with a disposable note library."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from feature_profile import LaunchProfile
from note_canvases import NoteCanvasStore
from notes_library import NotesStore, NotesError


class NoteCanvasBrowserTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.notes = NotesStore(Path(temporary.name) / 'notes')
        self.notes.ensure_root()
        self.store = NoteCanvasStore(self.notes)

    def note(self, path, text):
        target = self.notes.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        self.notes.atomic_text(target, text)

    def canvas(self, name, text='not even JSON'):
        target = self.notes.root / 'canvases' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
        return target

    def test_unique_notes_case_encoding_and_missing(self):
        self.canvas('共享.CANVAS')
        self.canvas('Unused.canvas')
        self.note('A.md', '![x](canvases/%E5%85%B1%E4%BA%AB.CANVAS)\n![x](canvases/共享.canvas)\n![lost](canvases/lost.canvas)')
        self.note('Book/B.md', '![x](../CANVASES/共享.canvas)')
        items = {item['path']: item for item in self.store.list()['items']}
        self.assertEqual(items['canvases/共享.CANVAS']['referenceCount'], 2)
        self.assertFalse(items['canvases/lost.canvas']['exists'])
        self.assertEqual(self.store.list('unused')['items'][0]['name'], 'Unused')
        self.assertEqual(self.store.list('missing')['total'], 1)
        self.assertEqual([item['path'] for item in self.store.references('canvases/共享.canvas')['items']], ['A.md', 'Book/B.md'])

    def test_protected_and_inline_syntax_not_counted(self):
        self.canvas('x.canvas')
        self.note('A.md', '---\n![x](canvases/x.canvas)\n---\n\n'
                  '```md\n![x](canvases/x.canvas)\n```\n'
                  '<!--\n![x](canvases/x.canvas)\n-->\n'
                  '[x](canvases/x.canvas)\ninline ![x](canvases/x.canvas)\n'
                  '![outside](../../canvases/x.canvas)\n')
        self.assertEqual(self.store.list()['items'][0]['referenceCount'], 0)

    def test_incremental_index_and_no_canvas_content_reads(self):
        self.canvas('x.canvas')
        self.note('A.md', '![x](canvases/x.canvas)')
        self.note('B.md', 'plain')
        self.store.list()
        with mock.patch.object(self.notes, '_read_note_bytes', wraps=self.notes._read_note_bytes) as reads:
            with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('unexpected body read')):
                self.store.list()
                self.store.references('canvases/x.canvas')
            self.assertEqual(reads.call_count, 0)
            self.note('B.md', '![x](canvases/x.canvas)\nchanged')
            self.assertEqual(self.store.list()['items'][0]['referenceCount'], 2)
            self.assertEqual(reads.call_count, 1)
        self.assertTrue(all('text' not in doc and 'raw' not in doc for doc in self.notes._document_cache.values()))

    def test_save_move_delete_and_rename(self):
        self.note('A.md', 'body')
        created = self.store.create('A.md')
        self.assertEqual(self.store.list('unused')['total'], 1)
        loaded = self.notes.load('A.md')
        self.notes.save('A.md', f'![x]({created["path"]})', loaded['revision'])
        self.notes.create('', 'Book', 'folder')
        self.notes.move('A.md', 'Book/A.md')
        self.assertEqual(self.store.references(created['path'])['items'][0]['path'], 'Book/A.md')
        renamed = self.store.rename(created['path'], 'Renamed', created['revision'])
        self.assertEqual(self.store.list()['items'][0]['path'], renamed['path'])
        (self.notes.root / 'Book/A.md').unlink()
        self.assertEqual(self.store.list('unused')['total'], 1)

    def test_external_file_changes_and_signature(self):
        self.canvas('x.canvas')
        self.note('A.md', '![x](canvases/x.canvas)')
        first = self.store.list()['signature']
        self.assertEqual(first, self.store.list()['signature'])
        self.note('B.md', '![x](canvases/x.canvas)')
        self.assertNotEqual(first, self.store.list()['signature'])
        (self.notes.root / 'canvases/x.canvas').unlink()
        self.assertEqual(self.store.list('missing')['total'], 1)
        self.canvas('x.canvas')
        self.assertEqual(self.store.list('missing')['total'], 0)

    def test_no_creation_and_natural_pagination(self):
        self.assertEqual(self.store.list()['total'], 0)
        self.assertFalse((self.notes.root / 'canvases').exists())
        for index in range(1, 57):
            self.canvas(f'C{index}.canvas')
        first, second = self.store.list(), self.store.list(offset=50)
        self.assertEqual([item['name'] for item in first['items'][:3]], ['C1', 'C2', 'C3'])
        self.assertEqual(len(first['items']), 50)
        self.assertTrue(first['hasMore'])
        self.assertEqual(second['items'][0]['name'], 'C51')
        self.assertFalse(second['hasMore'])
        for index in range(56):
            self.note(f'N{index}.md', '![x](canvases/C1.canvas)')
        self.assertEqual(self.store.references('canvases/C1.canvas')['total'], 56)
        self.assertEqual(len(self.store.references('canvases/C1.canvas', 50)['items']), 6)

    def test_incomplete_never_reports_unused(self):
        self.canvas('x.canvas')
        (self.notes.root / 'bad.md').write_bytes(b'\xff')
        for query in (lambda: self.store.list('unused'), lambda: self.store.references('canvases/x.canvas')):
            with self.assertRaises(NotesError) as caught:
                query()
            self.assertEqual(caught.exception.code, 'statistics_incomplete')
        (self.notes.root / 'bad.md').unlink()
        self.assertEqual(self.store.list('unused')['total'], 1)
        def unreadable_tree(root, **options):
            options['onerror'](PermissionError('cannot read directory'))
            return iter(())
        with mock.patch('notes_library.os.walk', side_effect=unreadable_tree):
            with self.assertRaises(NotesError) as caught:
                self.store.list('unused')
            self.assertEqual(caught.exception.code, 'statistics_incomplete')

    def test_validation_security_and_feature_gate(self):
        for query in (lambda: self.store.list('bad'), lambda: self.store.list(offset=True),
                      lambda: self.store.list(limit=51), lambda: self.store.references('../x.canvas'),
                      lambda: self.store.references('canvases/sub/x.canvas')):
            with self.assertRaises(NotesError):
                query()
        enabled = LaunchProfile({'notes': True, 'notes.canvas': True, 'canvas': False}, restricted=True)
        disabled = LaunchProfile({'notes': True, 'notes.canvas': False}, restricted=True)
        for route in ('/api/notes-canvas/list', '/api/notes-canvas/references'):
            self.assertTrue(enabled.api_allowed(route, write=False))
            self.assertFalse(disabled.api_allowed(route, write=False))
        self.canvas('x.canvas')
        with mock.patch('notes_library._is_reparse', side_effect=lambda path: path.name == 'canvases'):
            with self.assertRaises(NotesError):
                self.store.list()
        with mock.patch('note_canvases._is_reparse', return_value=True):
            self.assertEqual(self.store.list()['total'], 0)


if __name__ == '__main__':
    unittest.main()

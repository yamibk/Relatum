"""Embedded canvas transactions; every file lives in a disposable root."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from notes_library import NotesStore, NotesError
from note_canvases import NoteCanvasStore, validate
from note_canvas_reference import rewrite, references
from feature_profile import LaunchProfile


class NoteCanvasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'notes'
        self.notes = NotesStore(self.root)
        self.notes.create('', 'A', 'note', content='before\n')
        self.canvases = NoteCanvasStore(self.notes)

    def tearDown(self):
        self.temp.cleanup()

    def note(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        self.notes.atomic_text(target, value)
        self.notes.invalidate()

    def test_lazy_directory_creation_and_reservation(self):
        self.assertFalse((self.root / 'canvases').exists())
        self.notes.tree()
        self.assertFalse((self.root / 'canvases').exists())
        first = self.canvases.create('A.md')
        second = self.canvases.create('A.md')
        self.assertNotEqual(first['path'], second['path'])
        self.assertEqual(self.notes.tree()['entries'][0]['path'], 'A.md')
        for action in (lambda: self.notes.create('', 'canvases', 'folder'),
                       lambda: self.notes.move('A.md', 'canvases/A.md'),
                       lambda: self.notes.normalize_path('canvases')):
            with self.assertRaises(NotesError):
                action()

    def test_shared_revision_save_conflict_and_unsupported_data(self):
        created = self.canvases.create('A.md')
        data = copy.deepcopy(created['data'])
        data['nodes'] = [{'id': 'n', 'kind': 'index', 'x': -100, 'y': -60, 'text': '中文\n多行', 'width': 160, 'height': 48}]
        saved = self.canvases.save(created['path'], data, created['revision'])
        self.assertNotEqual(created['revision'], saved['revision'])
        with self.assertRaises(NotesError) as error:
            self.canvases.save(created['path'], data, created['revision'])
        self.assertEqual(error.exception.status, 409)
        data['nodes'][0]['kind'] = 'code'
        with self.assertRaises(NotesError):
            self.canvases.save(created['path'], data, saved['revision'])
        data['nodes'][0]['kind'] = 'index'
        data['nodes'][0]['x'] = float('nan')
        with self.assertRaises(NotesError):
            validate(data)

    def test_global_rename_preserves_dimensions_caption_and_examples(self):
        created = self.canvases.create('A.md')
        name = Path(created['path']).name
        valid = f'![{name}|640x360]({created["path"]})'
        examples = '\n\n```md\n' + valid + '\n```\n\n<!--\n' + valid + '\n-->\n\ninline ' + valid + '\n\n    ' + valid + '\n'
        self.note('A.md', valid + examples)
        self.note('Book/B.md', f'![自定义说明|320x180](../{created["path"]} "title")\r\n')
        result = self.canvases.rename(created['path'], '新 图(1)', created['revision'])
        self.assertEqual(set(result['rewritten']), {'A.md', 'Book/B.md'})
        self.assertTrue((self.root / result['path']).is_file())
        current = self.notes.load('A.md')['content']
        self.assertIn('![新 图(1).canvas|640x360]', current)
        self.assertTrue(current.endswith(examples))
        sub = self.notes.load('Book/B.md')['content']
        self.assertIn('![自定义说明|320x180](../canvases/', sub)
        self.assertTrue(sub.endswith(' "title")\r\n'))
        result2 = self.canvases.rename(result['path'], 'Second', result['revision'])
        self.assertIn('Second.canvas|640x360', self.notes.load('A.md')['content'])
        self.assertEqual(result2['path'], 'canvases/Second.canvas')

    def test_rename_rolls_back_all_written_notes_and_file(self):
        created = self.canvases.create('A.md')
        value = f'![shared|640x360]({created["path"]})\n'
        self.note('A.md', value)
        self.note('B.md', value)
        writer = self.notes.atomic_text
        def fail_second(target, content):
            if Path(target).name == 'B.md':
                raise OSError('injected write failure')
            writer(target, content)
        with patch.object(self.notes, 'atomic_text', side_effect=fail_second), self.assertRaises(OSError):
            self.canvases.rename(created['path'], 'Rename', created['revision'])
        self.assertTrue((self.root / created['path']).is_file())
        self.assertFalse((self.root / 'canvases/Rename.canvas').exists())
        self.assertEqual(self.notes.load('A.md')['content'], value)
        self.assertEqual(self.notes.load('B.md')['content'], value)

    def test_paths_and_note_move(self):
        created = self.canvases.create('A.md')
        for source in ('../../canvases/A.canvas', '/canvases/A.canvas', 'https://host/A.canvas', 'canvases/../A.canvas', 'canvases/%2e%2e/A.canvas'):
            with self.assertRaises(NotesError):
                self.canvases.resolve('A.md', source)
        self.note('A.md', f'![shared|640x360]({created["path"]})\n')
        self.notes.create('', 'Book', 'folder')
        self.notes.move('A.md', 'Book/A.md')
        moved = self.notes.load('Book/A.md')['content']
        self.assertIn('](../canvases/', moved)
        self.assertEqual(self.canvases.resolve('Book/A.md', '../' + created['path'].upper()), created['path'])
        with self.assertRaises(NotesError):
            self.canvases.rename(created['path'], '', created['revision'])

    def test_launcher_independence_and_exclusive_api(self):
        enabled = LaunchProfile({'canvas': False, 'notes': True, 'notes.canvas': True}, restricted=True)
        disabled = LaunchProfile({'notes.canvas': False}, restricted=True)
        for path in ('note-canvas/runtime.js', 'note-canvas/canvas.css'):
            self.assertTrue(enabled.resource_allowed(path))
            self.assertFalse(disabled.resource_allowed(path))
        for path in ('/api/notes-canvas/read', '/api/notes-canvas/create', '/api/notes-canvas/save', '/api/notes-canvas/rename'):
            self.assertTrue(enabled.api_allowed(path, write=path != '/api/notes-canvas/read'))
            self.assertFalse(disabled.api_allowed(path, write=path != '/api/notes-canvas/read'))

    def test_protected_grammar_and_case_rename(self):
        text = '---\n' + '![x](canvases/x.canvas)\n---\n\n![X.canvas|640x360](canvases/X.canvas)\n'
        self.assertEqual(len(references(text)), 1)
        self.assertIn('Y.canvas|640x360', rewrite(text, 'A.md', renamed={'canvases/x.canvas': 'canvases/Y.canvas'}))

    def test_shared_reference_cases(self):
        cases = json.loads(Path(__file__).with_name('note-canvas-reference-cases.json').read_text(encoding='utf-8'))
        for sample in cases:
            with self.subTest(source=sample['source']):
                self.assertEqual(len(references(sample['source'])), sample['count'])
                self.assertEqual(rewrite(sample['source'], sample['note'], renamed=sample['renamed'], new_note=sample.get('newNote')), sample['expected'])


if __name__ == '__main__':
    unittest.main()

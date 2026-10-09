"""Embedded canvas transactions; every file lives in a disposable root."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from notes_library import NotesStore, NotesError
from note_canvases import NoteCanvasStore, validate, SHAPES
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

    def test_styles_round_trip_all_shapes_and_paths(self):
        created = self.canvases.create('A.md')
        data = copy.deepcopy(created['data'])
        data['customMetadata'] = {'keep': True}
        data['nodes'] = [dict(id=f'n{i}', kind='index', x=i * 200, y=0, width=160, height=160,
                              text='纯文字', shape=shape, bgColor='#aabbcc', bgOpacity=.35,
                              hideBackground=False, borderColor='#112233', borderWidth=2.5,
                              paddingX=12, paddingY=8, radius=16, autoHeight=False,
                              fontSize=22, color='#445566', fontWeight=650, lineHeight=1.6,
                              wrap=True, textAlign='center', verticalAlign='bottom')
                         for i, shape in enumerate(sorted(SHAPES))]
        data['edges'] = [dict(id=f'e{i}', **{'from': 'n0', 'to': f'n{i+1}'}, text='标注',
                              curve=curve, lineStyle='dotted', color='#778899', width=3,
                              arrowStart=True, arrowEnd=False, arrowSize=20, cornerRadius=22,
                              fromSide='bottom', toSide='left', labelPosition=.7,
                              labelOffsetX=-40, labelOffsetY=30, waypoints=[{'x': 50, 'y': 80, 'customPoint': 'keep'}],
                              labelStyle={'fontSize': 18, 'color': '', 'fontWeight': 400,
                                          'wrap': False, 'textAlign': 'right', 'verticalAlign': 'center',
                                          'lineHeight': 1.5, 'width': 120, 'height': 60})
                         for i, curve in enumerate(('straight', 'bezier', 'smooth', 'elbow', 'rounded-elbow'))]
        saved = self.canvases.save(created['path'], data, created['revision'])
        loaded = self.canvases.read(created['path'])
        self.assertEqual(loaded['revision'], saved['revision'])
        self.assertEqual(loaded['data']['nodes'], data['nodes'])
        self.assertEqual(loaded['data']['edges'], data['edges'])
        self.assertEqual(loaded['data']['customMetadata'], {'keep': True})
        renamed = self.canvases.rename(created['path'], 'Styled', saved['revision'])
        self.assertEqual(self.canvases.read(renamed['path'])['data']['edges'], data['edges'])

    def test_invalid_styles_are_rejected_without_overwriting(self):
        created = self.canvases.create('A.md')
        data = copy.deepcopy(created['data'])
        data['nodes'] = [{'id': 'a', 'x': 0, 'y': 0}, {'id': 'b', 'x': 200, 'y': 0}]
        data['edges'] = [{'id': 'e', 'from': 'a', 'to': 'b'}]
        self.canvases.save(created['path'], data, created['revision'])
        current = self.canvases.read(created['path'])
        original = (self.root / created['path']).read_bytes()
        cases = [('nodes', 'shape', 'script'), ('nodes', 'bgColor', 'url(https://example.test)'),
                 ('nodes', 'bgOpacity', 2), ('nodes', 'autoHeight', 1), ('nodes', 'fontSize', float('nan')),
                 ('nodes', 'fontWeight', True), ('nodes', 'wrap', 'yes'), ('nodes', 'verticalAlign', 'outside'),
                 ('edges', 'curve', 'organic'), ('edges', 'width', 0), ('edges', 'arrowStart', 1),
                 ('edges', 'fromSide', 'unknown'), ('edges', 'labelPosition', -1),
                 ('edges', 'labelStyle', {'color': 'red'}), ('edges', 'labelStyle', []),
                 ('edges', 'labelStyle', {'height': float('inf')})]
        for collection, key, value in cases:
            with self.subTest(collection=collection, key=key, value=value):
                invalid = copy.deepcopy(data)
                invalid[collection][0][key] = value
                with self.assertRaises(NotesError):
                    self.canvases.save(created['path'], invalid, current['revision'])
                self.assertEqual((self.root / created['path']).read_bytes(), original)

    def test_old_files_are_not_rewritten_or_populated_on_read(self):
        created = self.canvases.create('A.md')
        legacy = {'version': 2, 'nodes': [{'id': 'n', 'kind': 'index', 'x': 0, 'y': 0, 'text': '旧内容'},
                                        {'id': 'b', 'x': 200, 'y': 0, 'text': '旧内容二'}],
                  'edges': [{'id': 'e', 'from': 'n', 'to': 'b', 'curve': None}], 'custom': ['keep', 2]}
        self.notes.atomic_text(self.root / created['path'], json.dumps(legacy, ensure_ascii=False))
        original = (self.root / created['path']).read_bytes()
        loaded = self.canvases.read(created['path'])
        self.assertEqual(loaded['data'], legacy)
        self.assertEqual((self.root / created['path']).read_bytes(), original)
        self.canvases.save(created['path'], loaded['data'], loaded['revision'])
        self.assertEqual((self.root / created['path']).read_bytes(), original)

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
        for path in ('note-canvas/runtime.js', 'note-canvas/canvas.css', 'note-canvas-style.js'):
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

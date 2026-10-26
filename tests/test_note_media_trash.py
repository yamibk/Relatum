"""Media recycling on disposable notes; never touch the real Windows Recycle Bin."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from feature_profile import LaunchProfile
from note_canvases import NoteCanvasStore
from notes_library import NotesStore, NotesError


class NoteMediaTrashTests(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory(prefix='relatum-media-trash-'))
        self.root = Path(self.temp) / 'notes'
        self.root.mkdir()
        self.notes = NotesStore(self.root)
        self.bin = Path(self.temp) / 'recycled'
        self.bin.mkdir()
        self.calls = []

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)
        return target

    def recycle(self, targets):
        self.calls.append(list(targets))
        for target in targets:
            shutil.move(target, self.bin / target.name)

    def trash(self, target='image.png', **options):
        return self.notes.trash_media('A.md', self.notes.load('A.md')['revision'], target,
                                      self.recycle, kind='image', **options)

    def test_all_image_aliases_and_metadata_only_in_current_note(self):
        self.write('image.png', b'image')
        self.write('keep.png', b'image')
        source = ('---\nexample: "![x](image.png)"\n---\n\n'
                  '😀 before ![one](image.png) after\n\n![[image.png|80]]\n\n'
                  '![two](./image.png) <!--relatum:image-text:v1:eyJpdGVtcyI6W119-->\n\n'
                  '`![example](image.png)`\n\n```md\n![example](image.png)\n```\n\n'
                  '<!-- ![example](image.png) -->\n%% ![[image.png]] %%\n\n'
                  '    ![example](image.png)\n\n![keep](keep.png)\n')
        self.write('A.md', source)
        other = self.write('B.md', source)
        stamp = other.stat().st_mtime_ns
        result = self.trash()
        expected = source.replace('![one](image.png)', '').replace('![[image.png|80]]', '').replace(
            '![two](./image.png) <!--relatum:image-text:v1:eyJpdGVtcyI6W119-->', '')
        self.assertEqual(result['content'], expected)
        self.assertEqual(self.notes.load('A.md')['content'], expected)
        self.assertEqual(other.read_text(encoding='utf-8'), source)
        self.assertEqual(other.stat().st_mtime_ns, stamp)
        self.assertFalse((self.root / 'image.png').exists())
        self.assertTrue((self.root / 'keep.png').exists())
        # Returned changes index the editor's UTF-16 document, not Python characters.
        encoded = source.encode('utf-16-le')
        for change in reversed(result['changes']):
            encoded = encoded[:change['from'] * 2] + encoded[change['to'] * 2:]
        self.assertEqual(encoded.decode('utf-16-le'), expected)

    def test_wiki_fallback_and_original_crlf(self):
        self.write('assets/中文 (2).png', b'image')
        self.write('A.md', '😀\r\n![[中文 (2).png]]\r\n![x](assets/中文%20\\(2\\).png)\r\n')
        result = self.trash('中文 (2).png', syntax='wiki')
        self.assertEqual((self.root / 'A.md').read_bytes(), '😀\r\n\r\n\r\n'.encode())
        self.assertEqual(len(result['changes']), 2)
        self.assertEqual(result['changes'][0]['from'], 3)

    def test_canvas_companion_and_duplicate_references(self):
        canvas = self.write('canvases/test.canvas', json.dumps({'version': 2, 'nodes': [], 'edges': []}))
        self.write('canvases/test.assets/attachment.txt', 'attachment')
        embed = '![test|640x360](canvases/test.canvas)'
        source = embed + '\n\n' + embed + '\n\n`' + embed + '`\n\n![invalid](../../outside.canvas)\n'
        self.write('A.md', source)
        self.write('B.md', embed)
        revision = NoteCanvasStore(self.notes).read('canvases/test.canvas')['revision']
        result = self.notes.trash_media('A.md', self.notes.load('A.md')['revision'], 'canvases/test.canvas',
            self.recycle, kind='canvas', canvas_revision=revision)
        self.assertEqual(result['content'], '\n\n\n\n`' + embed + '`\n\n![invalid](../../outside.canvas)\n')
        self.assertEqual(self.calls, [[canvas, canvas.with_suffix('.assets')]])
        self.assertEqual((self.root / 'B.md').read_text(), embed)

    def test_revision_path_and_stale_selection_never_recycle(self):
        self.write('image.png', b'image')
        self.write('A.md', '![x](image.png)')
        with self.assertRaises(NotesError):
            self.notes.trash_media('A.md', 'stale', 'image.png', self.recycle, kind='image')
        for target in ('../outside.png', 'https://example.com/a.png', 'A.md', 'missing.png'):
            with self.subTest(target=target), self.assertRaises(NotesError):
                self.trash(target)
        self.write('A.md', '`![x](image.png)`')
        with self.assertRaises(NotesError):
            self.trash()
        self.assertEqual(self.calls, [])

    def test_save_failure_and_recycle_failure_preserve_original_bytes(self):
        self.write('image.png', b'image')
        note = self.write('A.md', b'\xef\xbb\xbf![x](image.png)\r\n')
        original = note.read_bytes()
        with mock.patch.object(self.notes, 'atomic_text', side_effect=OSError('save failed')):
            with self.assertRaises(OSError):
                self.trash()
        self.assertEqual(self.calls, [])
        with mock.patch.object(self, 'recycle', side_effect=OSError('recycle failed')):
            with self.assertRaises(OSError):
                self.trash()
        self.assertEqual(note.read_bytes(), original)
        self.assertTrue((self.root / 'image.png').exists())

    def test_canvas_revision_and_unsafe_companion(self):
        self.write('A.md', '![x](canvases/test.canvas)')
        self.write('canvases/test.canvas', '{"version":2,"nodes":[],"edges":[]}')
        args = ('A.md', self.notes.load('A.md')['revision'], 'canvases/test.canvas', self.recycle)
        with self.assertRaises(NotesError):
            self.notes.trash_media(*args, kind='canvas', canvas_revision='stale')
        revision = NoteCanvasStore(self.notes).read('canvases/test.canvas')['revision']
        self.write('canvases/test.assets', 'not a directory')
        with self.assertRaises(NotesError):
            self.notes.trash_media(*args, kind='canvas', canvas_revision=revision)
        self.assertEqual(self.calls, [])
        disabled = LaunchProfile({'notes.canvas': False}, restricted=True)
        self.assertFalse(disabled.api_allowed('/api/notes-canvas/trash', write=True))


if __name__ == '__main__':
    unittest.main()

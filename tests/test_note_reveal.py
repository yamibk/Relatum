"""Explorer reveal HTTP requests, using disposable notes and a mocked launcher."""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class NoteRevealTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.import_root = tempfile.TemporaryDirectory(prefix='relatum-reveal-import-')
        cls.addClassCleanup(cls.import_root.cleanup)
        with mock.patch.dict(os.environ, {'RELATUM_DATA_ROOT': cls.import_root.name}):
            cls.app = importlib.import_module('app')

    def setUp(self):
        from tests.usage_v2_test_support import IsolatedUsage
        self.fixture = self.enterContext(IsolatedUsage())
        self.launch = self.enterContext(mock.patch.object(self.app.subprocess, 'Popen'))
        self.note = self.fixture.notes / '子目录' / '含 空格.md'
        self.note.parent.mkdir()
        self.note.write_text('![photo](photo.png)', encoding='utf-8')
        self.image = self.note.parent / '素材 图片.png'
        self.image.write_bytes(b'local image fixture')

    def reveal(self, **kwargs):
        return self.fixture.request('/api/note-reveal', kwargs)

    def test_existing_root_note_and_notebook_requests(self):
        notebook = self.fixture.notes / 'CustomNotebook' / '数学 笔记'
        notebook.mkdir(parents=True)
        for relative, target in (('', self.fixture.notes), ('子目录/含 空格.md', self.note),
                                 ('CustomNotebook/数学 笔记', notebook)):
            with self.subTest(path=relative):
                self.assertEqual(self.reveal(path=relative), (200, {'ok': True}))
                args = ['explorer.exe', '/select,', str(target.resolve())] if target.is_file() else ['explorer.exe', str(target.resolve())]
                self.launch.assert_called_once_with(args, close_fds=True)
                self.launch.reset_mock()

    def test_markdown_and_wiki_resolve_the_actual_image(self):
        for target, syntax in (('素材%20图片.png', 'markdown'), ('素材 图片.png', 'wiki'),
                               ('子目录/素材 图片.png', 'wiki')):
            with self.subTest(target=target, syntax=syntax):
                self.assertEqual(self.reveal(kind='image', path='子目录/含 空格.md', target=target,
                                             imageSyntax=syntax), (200, {'ok': True}))
                self.launch.assert_called_once_with(['explorer.exe', '/select,', str(self.image.resolve())], close_fds=True)
                self.launch.reset_mock()

    def test_invalid_targets_never_launch_explorer(self):
        cases = [('missing.png', 'markdown', 404), ('../../outside.png', 'markdown', 403),
                 ('https://example.com/photo.png', 'markdown', 403), ('file:///C:/photo.png', 'markdown', 403),
                 ('script.exe', 'markdown', 403), ('素材 图片.png', 'bad', 400), ('', 'markdown', 400)]
        for target, syntax, expected in cases:
            with self.subTest(target=target):
                self.assertEqual(self.reveal(kind='image', path='子目录/含 空格.md', target=target,
                                             imageSyntax=syntax)[0], expected)
        self.assertEqual(self.reveal(kind='unknown', path='')[0], 400)
        self.assertEqual(self.reveal(kind='image', path='missing.md', target='素材 图片.png')[0], 404)
        self.launch.assert_not_called()

    def test_ambiguous_wiki_image_never_launches_explorer(self):
        for folder in ('one', 'two'):
            directory = self.fixture.notes / folder
            directory.mkdir()
            (directory / 'duplicate.png').write_bytes(b'image')
        code, body = self.reveal(kind='image', path='子目录/含 空格.md', target='duplicate.png', imageSyntax='wiki')
        self.assertEqual((code, body['code']), (409, 'ambiguous_image'))
        self.launch.assert_not_called()

    def test_reparse_image_never_launches_explorer(self):
        from notes_library import _is_reparse
        with mock.patch('notes_library._is_reparse', side_effect=lambda path: Path(path) == self.image or _is_reparse(path)):
            self.assertEqual(self.reveal(kind='image', path='子目录/含 空格.md', target='素材 图片.png')[0], 403)
        self.launch.assert_not_called()

    def test_launch_failure_is_reported(self):
        self.launch.side_effect = OSError('Explorer unavailable')
        code, body = self.reveal(kind='image', path='子目录/含 空格.md', target='素材 图片.png')
        self.assertEqual(code, 500)
        self.assertIn('Explorer unavailable', body['error'])


if __name__ == '__main__':
    unittest.main()

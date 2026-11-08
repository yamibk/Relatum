"""Exact local-file link opening; all files and OS calls are isolated."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import app
from feature_profile import FEATURES, LaunchProfile
from notes_library import NotesError
from tests.usage_v2_test_support import IsolatedUsage


class NoteFileUrlValidationTests(unittest.TestCase):
    def test_rejects_nonlocal_device_alias_and_encoded_paths_before_opening(self):
        for target in (None, {}, 12, 'https://example.test/a', 'file://server/share/a.html',
                       'file://user@localhost/C:/a.html', 'file://localhost:1/C:/a.html',
                       'file:///relative/a.html', 'file:////server/share/a.html',
                       'file:///C:/a.html\n', 'file:///C:/a%00.html', 'file:///C:/bad%ZZ.html',
                       'file:///C:/bad%FF.html', 'file:///C:/a.html:payload.exe',
                       'file:///C:/a.exe.', 'file:///C:/a.exe%20', 'file:///C:/CON.txt',
                       'file:///C:/LPT1/a.html', 'file:///C:/%5c%5cserver/a.html',
                       'file:///C:/a%3Ab.html', 'file:///?/C:/a.html'):
            with self.subTest(target=target), mock.patch.object(app.os, 'startfile', create=True) as opener:
                with self.assertRaises(NotesError):
                    app.open_note_file_url(target)
                opener.assert_not_called()


@unittest.skipUnless(os.name == 'nt', 'Windows local file URLs')
class NoteFileUrlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relatum-file-url-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_documents_once_decoded_and_default_application(self):
        for name in ('示例文档.html', '中文 空格(v1)#100%.pdf', 'literal%20percent.png', 'doc.docx'):
            file = self.root / name
            file.write_bytes(b'document')
            for target in (file.as_uri(), file.as_uri().replace('file:///', 'file://localhost/')):
                with self.subTest(name=name, target=target), mock.patch.object(app.os, 'startfile') as opener:
                    app.open_note_file_url(target)
                    opener.assert_called_once_with(str(file.resolve()))
        with mock.patch.object(app.os, 'startfile') as opener:
            app.open_note_file_url(file.as_uri() + '?view=1#section')
            opener.assert_called_once_with(file.as_uri() + '?view=1#section')

    def test_missing_directories_dangerous_files_and_redirected_targets(self):
        for target in (self.root.as_uri(), (self.root / 'missing.html').as_uri()):
            with self.assertRaises(NotesError) as error:
                app.resolve_note_file_url(target)
            self.assertEqual(error.exception.status, 404)
        for suffix in app.DANGEROUS_EXTS:
            with self.subTest(suffix=suffix), self.assertRaises(NotesError) as error:
                app.resolve_note_file_url((self.root / ('blocked' + suffix.upper())).as_uri())
            self.assertEqual(error.exception.status, 403)
        document = self.root / 'visible.txt'
        document.write_text('x', encoding='utf-8')
        for actual in (self.root / 'actual.exe', Path(r'\\server\share\actual.txt')):
            with mock.patch.object(Path, 'resolve', return_value=actual), self.assertRaises(NotesError) as error:
                app.resolve_note_file_url(document.as_uri())
            self.assertEqual(error.exception.status, 403)

    def test_http_source_scope_feature_gate_and_open_failure(self):
        with IsolatedUsage() as fixture:
            (fixture.notes / 'Source.md').write_text('source', encoding='utf-8')
            target = self.root / 'outside vault.html'
            target.write_text('safe test document', encoding='utf-8')
            body = {'kind': 'note-file-url', 'note': 'Source.md', 'target': target.as_uri()}
            with mock.patch.object(app.os, 'startfile') as opener:
                self.assertEqual(fixture.request('/api/open-external', body)[0], 200)
                opener.assert_called_once_with(str(target.resolve()))
                for source in ('Missing.md', '../outside.md', str(target)):
                    opener.reset_mock()
                    self.assertIn(fixture.request('/api/open-external', {**body, 'note': source})[0], (403, 404))
                    opener.assert_not_called()
                self.assertEqual(fixture.request('/api/open-external', {**body, 'kind': 'note-file'})[0], 403)
                self.assertEqual(fixture.request('/api/open-external', {**body, 'target': {}})[0], 400)
                opener.reset_mock()
                self.assertEqual(fixture.request('/api/open-external', {**body, 'target': target.as_uri() + '\n'})[0], 400)
                opener.assert_not_called()
            with mock.patch.object(app.os, 'startfile', side_effect=OSError('fixture failure')):
                self.assertEqual(fixture.request('/api/open-external', body)[0], 500)
            fixture.server.launch_profile = LaunchProfile({key: key == 'canvas' for key in FEATURES}, restricted=True)
            with mock.patch.object(app.os, 'startfile') as opener:
                code, response = fixture.request('/api/open-external', body)
                self.assertEqual((code, response['code']), (403, 'feature-disabled'))
                opener.assert_not_called()

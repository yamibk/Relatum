"""Image transfers must not prevent note/asset moves; all files are disposable."""
import base64
import importlib
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

from notes_library import NotesStore


class NoteAssetStreamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.import_root = tempfile.TemporaryDirectory(prefix='relatum-asset-import-')
        cls.addClassCleanup(cls.import_root.cleanup)
        with mock.patch.dict(os.environ, {'RELATUM_DATA_ROOT': cls.import_root.name}):
            cls.app = importlib.import_module('app')

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='relatum-asset-stream-')))
        self.store = NotesStore(self.root / 'notes')
        self.addCleanup(self.store.close)
        self.store.create('中文 目录', '含图 笔记', 'note', create_parents=True)
        self.note = '中文 目录/含图 笔记.md'
        # More than two stream chunks, with a valid small PNG header.
        self.image = base64.b64decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        ) + bytes(range(256)) * 2048
        uploaded = self.store.upload_image(self.note, '图片.png', self.image, 'image/png')
        self.source = uploaded['path']
        self.store.save(self.note, f'![图片]({self.source})', self.store.load(self.note)['revision'])
        self.enterContext(mock.patch.multiple(
            self.app, ROOT=self.root, NOTES_STORE=self.store, _usage_remap=mock.Mock(),
        ))
        self.server = self.app.CanvasServer(('127.0.0.1', 0), self.app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def asset_url(self, note, source):
        return self.url + '/api/note-asset?' + urllib.parse.urlencode({'note': note, 'src': source})

    def move(self, source, destination):
        request = urllib.request.Request(
            self.url + '/api/note-move',
            data=json.dumps({'path': source, 'destination': destination}).encode(),
            headers={'Content-Type': 'application/json'},
        )
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def stream_during_move(self, source, destination, moved_note, *, byte_range=None,
                           after_read=False, expected_error=None):
        opened, release = threading.Event(), threading.Event()
        asset_url = self.asset_url(self.note, self.source)
        asset_path = urllib.parse.urlsplit(asset_url).path + '?' + urllib.parse.urlsplit(asset_url).query
        original = self.app.Handler.end_headers

        def pause_transfer(handler):
            original(handler)
            if not after_read and handler.path == asset_path:
                opened.set()
                release.wait(timeout=10)

        original_read = self.app._NoteAssetStream.read
        target, _ = self.store.resolve_image(self.note, self.source)

        def pause_read(stream, size):
            chunk = original_read(stream, size)
            if after_read and stream.path == target and not opened.is_set():
                opened.set()
                release.wait(timeout=10)
            return chunk

        headers = {'Range': byte_range} if byte_range else {}
        with mock.patch.object(self.app.Handler, 'end_headers', pause_transfer), \
                mock.patch.object(self.app._NoteAssetStream, 'read', pause_read):
            request = urllib.request.Request(asset_url, headers=headers)
            with urllib.request.urlopen(request, timeout=5) as response:
                try:
                    self.assertTrue(opened.wait(timeout=5), 'image stream was not opened')
                    status, result = self.move(source, destination)
                    self.assertEqual(status, 500 if expected_error else 200, result)
                    if expected_error:
                        self.assertIn(expected_error, result['error'])
                    else:
                        self.assertEqual(result['path'], destination)
                finally:
                    release.set()
                expected = self.image[17:300018] if byte_range else self.image
                self.assertEqual(response.status, 206 if byte_range else 200)
                self.assertEqual(response.read(), expected, 'the original transfer must finish after the move')

        content = self.store.load(moved_note)['content']
        new_source = content.split('](', 1)[1].rsplit(')', 1)[0]
        with urllib.request.urlopen(self.asset_url(moved_note, new_source), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), self.image, 'the rewritten image must load from the new path')
        self.assertFalse((self.store.root / (destination if expected_error else source)).exists())

    def test_note_rename_while_image_response_is_open(self):
        self.stream_during_move(self.note, '中文 目录/新 笔记.md', '中文 目录/新 笔记.md')

    def test_folder_move_while_image_range_response_is_open(self):
        self.stream_during_move(
            '中文 目录', '目标 目录', '目标 目录/含图 笔记.md', byte_range='bytes=17-300017',
        )

    @unittest.skipUnless(os.name == 'nt', 'Windows directory sharing')
    def test_note_rename_after_first_image_chunk(self):
        self.stream_during_move(
            self.note, '中文 目录/读到一半.md', '中文 目录/读到一半.md', after_read=True,
        )

    @unittest.skipUnless(os.name == 'nt', 'Windows directory sharing')
    def test_snapshot_failure_preserves_note_and_in_progress_image(self):
        def fail_copy(source, destination, length):
            destination.write(source.read(31))
            raise OSError('fixture snapshot failure')

        with mock.patch.object(self.app.shutil, 'copyfileobj', side_effect=fail_copy):
            self.stream_during_move(
                self.note, '中文 目录/不应存在.md', self.note,
                after_read=True, expected_error='fixture snapshot failure',
            )

    @unittest.skipUnless(os.name == 'nt', 'Windows directory sharing')
    def test_external_reader_still_causes_safe_rollback(self):
        target, _ = self.store.resolve_image(self.note, self.source)
        with target.open('rb'):
            self.stream_during_move(
                self.note, '中文 目录/不应存在.md', self.note, expected_error='WinError 5',
            )

    @unittest.skipUnless(os.name == 'nt', 'Windows directory sharing')
    def test_unrelated_reader_is_not_copied(self):
        self.store.create('', 'Other', 'note')
        target, _ = self.store.resolve_image(self.note, self.source)
        with self.app.NOTES_MUTATION_LOCK:
            stream = self.app._open_note_asset(target)
        try:
            with mock.patch.object(self.app.tempfile, 'TemporaryFile') as snapshot:
                status, result = self.move('Other.md', 'Renamed.md')
                self.assertEqual(status, 200, result)
                snapshot.assert_not_called()
        finally:
            stream.close()

    def test_cancelled_response_releases_image(self):
        target, media_type = self.store.resolve_image(self.note, self.source)
        with self.app.NOTES_MUTATION_LOCK:
            stream = self.app._open_note_asset(target)
        self.addCleanup(stream.close)
        handler = object.__new__(self.app.Handler)
        handler.headers = {}
        handler.send_response = mock.Mock()
        handler.send_header = mock.Mock()
        handler.end_headers = mock.Mock()
        handler.wfile = mock.Mock()
        handler.wfile.write.side_effect = BrokenPipeError('fixture cancelled transfer')
        handler._send_local_file(target, media_type, 'fixture image', opened_file=stream)
        self.assertNotIn(stream, self.app._NOTE_ASSET_STREAMS)
        closed = stream.file.closed if isinstance(stream, self.app._NoteAssetStream) else stream.closed
        self.assertTrue(closed)

    def test_cache_and_invalid_range_release_image(self):
        url = self.asset_url(self.note, self.source)
        with mock.patch.object(self.app.tempfile, 'TemporaryFile') as snapshot:
            with urllib.request.urlopen(url, timeout=5) as response:
                self.assertEqual(response.read(), self.image)
                etag = response.headers['ETag']
            snapshot.assert_not_called()
        for headers, expected in (({'If-None-Match': etag}, 304), ({'Range': 'bytes=9999999-'}, 416)):
            with self.subTest(headers=headers):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=5)
                with caught.exception as response:
                    self.assertEqual(response.status, expected)
                    self.assertEqual(response.read(), b'')
        status, result = self.move(self.note, '中文 目录/已释放.md')
        self.assertEqual(status, 200, result)


if __name__ == '__main__':
    unittest.main()

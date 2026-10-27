"""HTTP feature boundaries and lock-free note query integration."""
import http.client
import json
import unittest
from unittest import mock

import app
from feature_profile import LaunchProfile, FEATURES
from notes_library import NotesStore
from tests.usage_v2_test_support import IsolatedUsage


class NoteIndexApiTests(unittest.TestCase):
    def setUp(self):
        self.context = IsolatedUsage()
        self.fixture = self.context.__enter__()
        self.store = NotesStore(self.fixture.notes, index_path=self.fixture.data / 'note-index.sqlite3', background_index=True)
        self.replace = mock.patch.object(app, 'NOTES_STORE', self.store)
        self.replace.start()
        for i in range(65):
            (self.fixture.notes / f'N{i:03}.md').write_text('body needle #tag [[N000]]', encoding='utf-8')
        self.store.sync.activity(True); self.store.sync.complete(timeout=10)
        self.store.sync.activity(False)

    def tearDown(self):
        self.store.close(); self.replace.stop(); self.context.__exit__(None, None, None)

    def test_queries_and_pagination_do_not_acquire_file_write_locks(self):
        with mock.patch.object(app, '_cross_process_mutation_lock', side_effect=AssertionError('global write lock')), \
             mock.patch.object(app, 'NOTES_MUTATION_LOCK', side_effect=AssertionError('Markdown lock')), \
             mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('body reread')), \
             mock.patch('os.scandir', side_effect=AssertionError('query traversal')):
            code, first = self.fixture.request('/api/note-query', {'q': 'needle'})
            self.assertEqual(code, 200); self.assertEqual(first['total'], 65)
            code, second = self.fixture.request('/api/note-query', {'q': 'needle', 'cursor': first['cursor']})
            self.assertEqual(code, 200); self.assertEqual(len(second['items']), 15)
            for route in ('/api/note-index-state', '/api/note-changes?since=0', '/api/note-children', '/api/note-tags', '/api/note-links?path=N000.md'):
                self.assertEqual(self.fixture.request(route)[0], 200, route)

    def test_disabled_notes_reject_every_index_entry_before_starting(self):
        self.fixture.server.launch_profile = LaunchProfile({key: key == 'canvas' or key == 'canvas.library' for key in FEATURES}, restricted=True)
        with mock.patch.object(self.store.sync, 'start', side_effect=AssertionError('disabled index started')), \
             mock.patch.object(self.store.sync, 'scan', side_effect=AssertionError('disabled scan')):
            for route in ('/api/notes-tree', '/api/note-index-state', '/api/note-changes', '/api/note-children', '/api/note-tags', '/api/note-graph'):
                code, body = self.fixture.request(route)
                self.assertEqual((code, body['code']), (403, 'feature-disabled'), route)
            for route, payload in (('/api/note-query', {'q': 'needle'}), ('/api/note-index-activity', {'visible': True})):
                # Rejection must happen before reading a body. Send headers
                # alone; a pre-sent unread body can cause a Windows TCP reset.
                client = http.client.HTTPConnection('127.0.0.1', self.fixture.server.server_address[1], timeout=3)
                try:
                    client.putrequest('POST', route)
                    client.putheader('Content-Type', 'application/json')
                    client.putheader('Content-Length', str(len(json.dumps(payload).encode())))
                    client.endheaders(); response = client.getresponse()
                    self.assertEqual((response.status, json.load(response)['code']), (403, 'feature-disabled'))
                finally:
                    client.close()

    def test_bad_parameters_and_changed_generation_return_structured_errors(self):
        self.assertEqual(self.fixture.request('/api/note-children?offset=bad')[0], 400)
        self.assertEqual(self.fixture.request('/api/note-query', {'q': '"unfinished'})[0], 400)
        first = self.fixture.request('/api/note-query', {'q': 'needle'})[1]
        self.store.create('', 'New', 'note', content='needle')
        code, body = self.fixture.request('/api/note-query', {'q': 'needle', 'cursor': first['cursor']})
        self.assertEqual((code, body['code']), (409, 'query_changed'))
        self.assertEqual(self.fixture.request('/api/note-query', {'q': 'needle', 'paths': ['../escape.md']})[0], 403)

    def test_file_color_api_is_batched_durable_and_feature_guarded(self):
        query, save = '/api/note-file-colors/query', '/api/note-file-colors/set'
        code, first = self.fixture.request(save, {'path': 'N000.md', 'color': 'blue'})
        self.assertEqual(code, 200)
        with mock.patch.object(app, '_cross_process_mutation_lock', side_effect=AssertionError('color query write lock')):
            code, result = self.fixture.request(query, {'paths': ['N000.md', 'N001.md']})
        self.assertEqual((code, result['colors']), (200, {'N000.md': 'blue'}))
        delta = self.fixture.request('/api/note-changes?since=0&fileColors=1')[1]
        self.assertEqual(delta['fileColorGeneration'], first['generation'])
        self.assertNotIn('fileColorGeneration', self.fixture.request('/api/note-changes?since=0')[1])
        self.assertEqual(self.fixture.request(query, {'paths': ['N000.md'] * 513})[0], 400)
        self.assertEqual(self.fixture.request(save, {'path': '../escape.md', 'color': 'red'})[0], 403)
        self.assertEqual(self.fixture.request(save, {'path': 'N000.md'})[0], 400)
        code, cleared = self.fixture.request('/api/note-file-colors/clear', {})
        self.assertEqual((code, cleared['cleared']), (200, 1))
        self.assertGreater(cleared['generation'], first['generation'])
        self.assertEqual(self.fixture.request(query, {'paths': ['N000.md']})[1]['colors'], {})
        self.fixture.server.launch_profile = LaunchProfile({key: key == 'canvas' for key in FEATURES}, restricted=True)
        self.assertEqual(self.fixture.request(query, {'paths': []})[0], 403)
        self.assertEqual(self.fixture.request(save, {'path': 'N000.md', 'color': None})[0], 403)
        self.assertEqual(self.fixture.request('/api/note-file-colors/clear', {})[0], 403)


if __name__ == '__main__':
    unittest.main()

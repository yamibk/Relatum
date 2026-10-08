import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from note_metadata import note_metadata
from notes_library import NotesStore, NotesError


class NoteBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = NotesStore(Path(self.temp.name) / 'notes')
        self.store.ensure_root()

    def test_shared_tag_cases(self):
        fixtures = json.loads(Path(__file__).with_name('note-tag-cases.json').read_text(encoding='utf-8'))
        for fixture in fixtures:
            with self.subTest(source=fixture['source']):
                self.assertEqual([tag['key'] for tag in note_metadata(fixture['source'])['tags']], fixture['tags'])

    def test_links_do_not_start_full_metadata_scan(self):
        for name in ('A', 'B'):
            (self.store.root / (name + '.md')).write_text('#标签', encoding='utf-8')
        with mock.patch('notes_library.note_metadata', wraps=note_metadata) as metadata:
            self.store.links('A.md')
            self.assertEqual(metadata.call_count, 0)
            self.store.tags()
            self.assertEqual(metadata.call_count, 2)
            self.store.tags()
            self.store.query({'tag': '标签'})
            self.assertEqual(metadata.call_count, 2)
            (self.store.root / 'B.md').write_text('#新标签', encoding='utf-8')
            self.store.links('A.md')
            self.assertEqual(metadata.call_count, 3)
            self.store.tags()
            self.assertEqual(metadata.call_count, 3, 'changed metadata must share the link index read after activation')

    def test_catalog_query_and_incremental_cache(self):
        self.store.create('', 'A', 'note', content='---\ntags: [学习/概率, AI]\n---\n正文 #学习 #ai')
        self.store.create('', 'B', 'note', content='#学习/概率 #学习/统计\n第二篇')
        counts = {item['key']: item['count'] for item in self.store.tags()['items']}
        self.assertEqual(counts, {'ai': 1, '学习': 2, '学习/概率': 2, '学习/统计': 1})
        with mock.patch.object(self.store, '_read_note_bytes', wraps=self.store._read_note_bytes) as reads:
            self.assertEqual(self.store.query({'tag': '学习', 'offset': 0, 'limit': 1})['total'], 2)
            self.store.tags()
            self.assertEqual(reads.call_count, 0)
        ordered = self.store.query({'paths': ['B.md', 'A.md', 'B.md']})['items']
        self.assertEqual([row['path'] for row in ordered], ['B.md', 'A.md'])
        self.assertLessEqual(len(ordered[0]['excerpt']), 240)
        note = self.store.load('A.md')
        self.store.save('A.md', '#其他', note['revision'])
        self.assertEqual(self.store.query({'tag': '学习'})['total'], 1)
        self.assertTrue(all('text' not in doc and 'raw' not in doc for doc in self.store._document_cache.values()))

    def test_query_validation(self):
        for query in ({}, {'paths': [], 'tag': 'tag'}, {'paths': ['../bad.md']}, {'paths': ['a.md'] * 51}, {'tag': '123'}, {'tag': 'tag', 'offset': True}, {'tag': 'tag', 'limit': 51}):
            with self.subTest(query=query), self.assertRaises(NotesError):
                self.store.query(query)

    def test_external_changes_move_and_removal(self):
        self.store.create('', 'External', 'note', content='#旧标签\n摘要')
        self.assertEqual(self.store.query({'tag': '旧标签'})['total'], 1)
        target = self.store.root / 'External.md'
        target.write_text('#新标签\n外部修改\n> [!note]\n> 正文\n| 值 |\n| --- |\n| 内容 |', encoding='utf-8')
        row = self.store.query({'tag': '新标签'})['items'][0]
        self.assertNotIn('[!note]', row['excerpt'])
        self.assertNotIn('|', row['excerpt'])
        self.assertEqual(self.store.query({'tag': '旧标签'})['total'], 0)
        self.store.move('External.md', 'Moved.md')
        self.assertEqual(self.store.query({'tag': '新标签'})['items'][0]['path'], 'Moved.md')
        (self.store.root / 'Moved.md').unlink()
        self.assertEqual(self.store.tags()['items'], [])
        self.assertEqual(self.store.query({'paths': ['External.md', 'Moved.md']})['items'], [])

    def test_wiki_resolution_and_cleanup(self):
        self.store.create('', 'Owner', 'note')
        self.store.create('', 'sub', 'folder')
        self.store.create('sub', 'Consumer', 'note')
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        asset = self.store.upload_image('Owner.md', 'image.png', png)
        name = Path(asset['path']).name
        resolved, _ = self.store.resolve_image('sub/Consumer.md', name, syntax='wiki')
        self.assertEqual(resolved.relative_to(self.store.root).as_posix(), asset['path'])
        self.assertEqual(self.store.resolve_image('sub/Consumer.md', asset['path'], syntax='wiki')[0], resolved)
        with self.assertRaises(NotesError):
            self.store.resolve_image('sub/Consumer.md', name)
        consumer = self.store.load('sub/Consumer.md')
        self.store.save(consumer['path'], f'![[{name}]]', consumer['revision'])
        owner = self.store.load('Owner.md')
        self.assertEqual(self.store.cleanup_unused_images(owner['path'], owner['revision'])['deletedCount'], 0)
        duplicate = self.store.root / 'duplicate' / name
        duplicate.parent.mkdir()
        duplicate.write_bytes(png)
        with self.assertRaises(NotesError) as error:
            self.store.resolve_image('sub/Consumer.md', name, syntax='wiki')
        self.assertEqual(error.exception.code, 'ambiguous_image')
        self.assertEqual(self.store.cleanup_unused_images(owner['path'], owner['revision'])['deletedCount'], 0)
        for source in ('../../outside.png', 'http://example.com/x.png', 'C:/outside.png'):
            with self.assertRaises(NotesError):
                self.store.resolve_image('sub/Consumer.md', source, syntax='wiki')


if __name__ == '__main__':
    unittest.main()

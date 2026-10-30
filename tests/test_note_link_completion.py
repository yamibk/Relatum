"""Link candidates, resolver-compatible insertion and zero file-I/O hot queries."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from notes_library import NotesStore, NotesError


class NoteLinkCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'notes'
        self.store = NotesStore(self.root, index_path=Path(self.temp.name) / 'index.sqlite3', background_index=True)
        self.store.ensure_root()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.store.close)
        self.write('Source.md', 'current')

    def write(self, path, text='正文'):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')

    def ready(self):
        self.store.sync.activity(True)
        self.store.sync.request_scan()
        self.store.sync.complete(timeout=20)
        self.store.sync.activity(False)

    def query(self, q='', **options):
        return self.store.query({'mode': 'link-completion', 'sourcePath': 'Source.md', 'q': q, **options})

    def test_literal_metadata_body_and_unicode(self):
        self.write('学习世界😀.md', 'ordinary')
        self.write('实验/RC笔记.md', '时间常数 学习')
        self.write('Café.md', 'other')
        self.write('Quoted.md', 'quoted"name')
        self.ready()
        for word in ('学', '学习', '世界😀', '世界 😀'):
            self.assertEqual([row['path'] for row in self.query(word)['items']], ['学习世界😀.md'])
        self.assertEqual(self.query('时间常数')['items'], [])
        hit = self.query('时间常数', includeBody=True)['items'][0]
        self.assertEqual((hit['path'], hit['match']), ('实验/RC笔记.md', 'body'))
        self.assertIn('时间常数', hit['excerpt'])
        self.assertEqual(self.query('实验 RC')['items'][0]['match'], 'path')
        self.assertEqual(self.query('cafe\u0301')['items'][0]['title'], 'Café')
        self.assertEqual(self.query('quoted"', includeBody=True)['items'][0]['title'], 'Quoted')
        self.assertEqual(self.query('" OR 1=1 --')['items'], [])

    def test_global_ambiguity_root_precedence_and_scopes(self):
        for path in ('同名.md', 'A/同名.md', 'CustomNotebook/One/同名.md', 'A/Unique.md', 'A/Repeat.md', 'B/Repeat.md', 'A/Deep/Other.md'):
            self.write(path)
        self.ready()
        rows = {row['path']: row for row in self.query('同名')['items']}
        self.assertEqual(rows['同名.md']['insertTarget'], '同名')
        self.assertEqual(rows['A/同名.md']['insertTarget'], 'A/同名')
        self.assertEqual(rows['A/同名.md']['location'], 'A')
        scoped = self.query('同名', scope={'kind': 'notebook', 'path': 'CustomNotebook/One'})['items']
        self.assertEqual(scoped[0]['insertTarget'], 'CustomNotebook/One/同名')
        self.assertEqual(self.query('Unique')['items'][0]['insertTarget'], 'Unique')
        self.assertEqual(self.query('Repeat', scope={'kind': 'folder', 'path': 'A'})['items'][0]['insertTarget'], 'A/Repeat')
        rows = self.query(scope={'kind': 'notebook', 'path': ''})['items']
        self.assertFalse(any(row['path'].startswith('CustomNotebook/') for row in rows))
        self.assertNotIn('Source.md', [row['path'] for row in rows])
        self.assertIn('A/Deep/Other.md', [row['path'] for row in self.query(scope={'kind': 'folder', 'path': 'A'})['items']])

    def test_sorting_recent_is_visit_time_and_body_stays_last(self):
        for path, text in [('Alpha.md', 'plain'), ('Alpha longer.md', 'plain'), ('Contains Alpha.md', 'plain'), ('Folder Alpha/Other.md', 'plain'), ('Body.md', 'Alpha')]:
            self.write(path, text)
        self.ready()
        recent = {'Body.md': 900, 'Alpha.md': 200, 'Alpha longer.md': 100}
        self.assertEqual([row['path'] for row in self.query(recent=recent)['items']][:3], ['Body.md', 'Alpha.md', 'Alpha longer.md'])
        expected = ['Alpha.md', 'Alpha longer.md', 'Contains Alpha.md', 'Folder Alpha/Other.md', 'Body.md']
        self.assertEqual([row['path'] for row in self.query('Alpha', includeBody=True, recent=recent)['items']], expected)
        for sorting in ('recent', 'modified', 'name'):
            self.assertEqual(self.query('Alpha', includeBody=True, sort=sorting, recent=recent)['items'][-1]['path'], 'Body.md')
        self.assertEqual(self.query('Alpha', sort='recent', recent=recent)['items'][0]['path'], 'Alpha.md')

    def test_recheck_deletion_limit_and_hot_queries(self):
        for i in range(65):
            self.write(f'N{i:03}.md', 'common')
        self.ready()
        with mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('body reread')), \
                mock.patch('os.scandir', side_effect=AssertionError('directory traversal')):
            result = self.query('N')
            self.assertEqual(len(result['items']), 50)
            self.assertTrue(result['hasMore'])
            self.assertEqual(len(self.query('common', includeBody=True)['items']), 50)
            self.assertEqual(self.query('N', selectedPath='N064.md')['items'][0]['path'], 'N064.md')
        (self.root / 'N064.md').unlink()
        self.store.removed('N064.md')
        self.assertEqual(self.query('N', selectedPath='N064.md')['items'], [])

    def test_bad_paths_options_and_existing_search_unchanged(self):
        self.write('A.md', 'bodyneedle')
        self.ready()
        self.assertEqual(self.store.query({'q': 'bodyneedle'})['items'][0]['path'], 'A.md')
        with self.assertRaises(NotesError):
            self.store.query({'q': '"unfinished'})
        for options in ({'sourcePath': '../outside.md'}, {'selectedPath': '../outside.md'}, {'sort': 'unknown'}, {'includeBody': 1}, {'recent': {'A.md': float('nan')}}):
            with self.subTest(options=options), self.assertRaises(NotesError):
                self.query(**options)

    def test_inserted_reserved_characters_follow_the_existing_resolver(self):
        paths = ['A#section.md', 'A^caret.md', '100%pure.md', 'percent%23name.md', '[brackets].md']
        for path in paths:
            self.write(path)
        self.ready()
        rows = {item['path']: item for item in self.query()['items']}
        source = '\n'.join('[[' + rows[path]['insertTarget'] + ']]' for path in paths)
        revision = self.store.load('Source.md')['revision']
        self.store.save('Source.md', source, revision)
        self.store.sync.complete(timeout=20)
        self.store.sync.activity(False)
        self.assertEqual({link['path'] for link in self.store.links('Source.md')['outgoing']}, set(paths))


if __name__ == '__main__':
    unittest.main()

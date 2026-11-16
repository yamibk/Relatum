"""Real isolated SQLite and note/companion transactions for database blocks."""

import base64
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

from note_database import DATABASE_DIRECTORY, has_database_fence
from notes_library import NotesError, NotesStore


FENCE = '```database\n```\n'


class NoteDatabaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.store = NotesStore(self.home / 'notes')
        self.addCleanup(self.store.close)
        self.store.create('', 'Source.md', 'note')
        self.database = self.store.database
        self.latest = self.database.read('Source.md')
        self.directory = self.store.root / 'Source.assets' / DATABASE_DIRECTORY

    def save(self, text=FENCE):
        result = self.store.save('Source.md', text, '')
        self.latest = self.database.read('Source.md')
        return result

    def action(self, kind, query=None, **fields):
        self.latest = self.database.action(
            'Source.md', {'type': kind, 'revision': self.latest.get('revision'), **fields}, query,
            recycle=self.recycle,
        )
        return self.latest

    def recycle(self, targets):
        root = self.home / 'recycled'
        root.mkdir(exist_ok=True)
        for index, target in enumerate(targets, start=len(list(root.iterdir()))):
            shutil.move(target, root / str(index))

    def candidates(self, text=''):
        return self.database.action('Source.md', {'type': 'searchAttachments', 'query': text})['items']

    def test_upgrade_layout_options_and_atomic_record_history(self):
        self.save()
        title = self.latest['columns'][0]['id']
        original = self.action('addRow', values={title: 'Original'})['rows'][0]['id']
        database = self.directory / 'database.sqlite3'
        with closing(sqlite3.connect(database)) as connection:
            with connection:
                for column in ('display_order', 'width', 'hidden', 'choices'):
                    connection.execute(f'ALTER TABLE columns DROP COLUMN {column}')
                connection.execute('PRAGMA user_version=1')
        self.latest = self.database.read('Source.md')
        self.assertEqual(self.latest['rows'][0]['id'], original)
        self.assertEqual(self.latest['rows'][0]['values'][title], 'Original')
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 2)
        state = self.action('addColumn', columnType='status', name='状态')['columns'][1]
        tags = self.action('addColumn', columnType='multiSelect', name='标签')['columns'][2]
        tags = self.action('setChoices', column=tags['id'], choices=[{'name': '重点'}])['columns'][2]
        done = state['choices'][2]['id']
        key = tags['choices'][0]['id']
        self.action('columnLayout', column=state['id'], width=228, order=[state['id'], title, tags['id']])
        self.action('columnLayout', column=title, hidden=True)
        self.assertEqual([column['id'] for column in self.latest['columns']], [state['id'], title, tags['id']])
        self.assertEqual(self.latest['columns'][0]['width'], 228)
        self.assertTrue(self.latest['columns'][1]['hidden'])
        before = self.latest['revision']
        with self.assertRaises(NotesError):
            self.action('batchCells', changes=[
                {'row': original, 'values': {state['id']: done}},
                {'row': None, 'values': {tags['id']: ['0' * 32]}},
            ])
        self.assertEqual(self.database.read('Source.md')['revision'], before)
        batch = self.action('batchCells', changes=[
            {'row': original, 'values': {state['id']: done}},
            {'row': None, 'values': {tags['id']: [key]}},
        ])
        self.assertEqual(batch['total'], 2)
        self.assertEqual(self.database.read('Source.md', {'search': '已完成'})['total'], 1)
        filters = [{'column': tags['id'], 'value': key, 'operator': 'contains'}]
        self.assertEqual(self.database.read('Source.md', {'filters': filters})['total'], 1)
        with self.assertRaises(NotesError):
            self.action('batchCells', query={'filters': filters}, changes=[{'row': None, 'values': {tags['id']: [key]}}])
        undo = self.action('applyRecords', changes=batch['inverse'])
        self.assertEqual(undo['total'], 1)
        self.assertNotIn(state['id'], undo['rows'][0]['values'])
        redo = self.action('applyRecords', changes=undo['inverse'])
        self.assertEqual([row['id'] for row in redo['rows']], [row['id'] for row in batch['rows']])
        self.action('setChoices', column=tags['id'], choices=[{'id': key, 'name': '要点'}])
        self.assertEqual(self.database.read('Source.md', {'search': '要点'})['total'], 1)
        with self.assertRaises(NotesError) as err:
            self.action('setChoices', column=tags['id'], choices=[])
        self.assertEqual(err.exception.code, 'options_in_use')
        after = self.action('setChoices', query={'filters': filters}, column=tags['id'], choices=[], clearRemoved=True)
        self.assertEqual(after['total'], 2, 'a deleted option stops contributing a filter')
        self.assertNotIn(tags['id'], after['rows'][1]['values'])

    def test_hidden_new_row_returns_projected_attachment_and_checkbox(self):
        self.save()
        self.action('addColumn', columnType='attachment', name='附件')
        self.action('addColumn', columnType='checkbox', name='完成')
        self.latest = self.database.import_file('Source.md', '参考.pdf', b'%PDF-1.7')
        attachment = next(item for item in self.candidates('参考.pdf') if item['kind'] == 'attachment')
        _, file, check = [column['id'] for column in self.latest['columns']]
        query = {'search': 'not visible'}
        added = self.action('addRow', query=query)
        self.assertEqual(added['rows'], [])
        row = added['addedRow']['id']
        changed = self.action('setCell', query=query, row=row, column=file,
                              value={'kind': 'attachment', 'id': attachment['id']}, includeRow=True)
        self.assertEqual(changed['rows'], [])
        self.assertEqual(changed['updatedRow']['values'][file], attachment)
        changed = self.action('setCell', query=query, row=row, column=check, value=True, includeRow=True)
        self.assertIs(changed['updatedRow']['values'][check], True)

    def test_fence_requires_visible_top_level_closed_empty_block(self):
        for text in (
            FENCE,
            FENCE.replace('\n', '\r\n'),
            '```database \t\n\t\n``` \t',
            'a\n\n' + FENCE + '\nb',
            '---\ntags: []\n---\n' + FENCE,
        ):
            with self.subTest(text=text):
                self.assertTrue(has_database_fence(text))
        for text in (
            '```database', '```database\nxxx\n```', '```database\n```%',
            '```\n' + FENCE + '```\n', '~~~~\n' + FENCE + '~~~~\n',
            ''.join('> ' + line for line in FENCE.splitlines(keepends=True)),
            '- item\n' + ''.join('  ' + line for line in FENCE.splitlines(keepends=True)),
            '<!--\n' + FENCE + '-->\n', '---\n' + FENCE + '---\n',
        ):
            with self.subTest(text=text):
                self.assertFalse(has_database_fence(text))

    def test_save_and_explicit_recreate_after_delete(self):
        self.assertFalse(self.latest['exists'])
        self.assertFalse(self.directory.exists())
        self.assertTrue(self.save(FENCE * 2)['databaseCreated'])
        old = self.latest['revision']
        self.action('addRow')
        ordinary = self.store.root / 'Source.assets' / 'keep.png'
        ordinary.write_bytes(b'ordinary')
        first_revision = self.latest['revision']
        with self.assertRaises(NotesError) as failed:
            self.database.action('Source.md', {'type': 'delete', 'revision': first_revision},
                                 recycle=mock.Mock(side_effect=OSError('blocked')))
        self.assertEqual(failed.exception.code, 'recycle_failed')
        self.assertEqual(self.database.read('Source.md')['revision'], first_revision)
        self.assertFalse(self.action('delete')['exists'])
        self.assertEqual((self.store.root / 'Source.md').read_text(encoding='utf-8'), FENCE * 2)
        self.assertTrue(ordinary.exists())
        self.assertNotIn('databaseCreated', self.save(FENCE * 2 + '\nedit'))
        self.assertFalse(self.latest['exists'])
        self.action('create')
        self.assertEqual(self.latest['total'], 0)
        self.assertNotIn(self.latest['revision'], (first_revision, old))
        self.save('ordinary')
        self.assertTrue(self.latest['exists'])

    def test_queries_typed_cells_paging_and_revision_conflict(self):
        self.save()
        name = self.latest['columns'][0]['id']
        for kind in ('number', 'date', 'checkbox', 'attachment'):
            self.action('addColumn', name=kind, columnType=kind)
        number, day, done, _ = [column['id'] for column in self.latest['columns'][1:]]
        for index in range(52):
            self.action('addRow', values={name: f'Row {index}', number: index, day: '2026-11-16', done: index % 2 == 0})
        result = self.database.read('Source.md', {'page': 2})
        self.assertEqual(result['total'], 52)
        self.assertEqual(result['rows'][0]['values'][number], 50)
        result = self.database.read('Source.md', {
            'search': 'ROW', 'sort': {'column': number, 'direction': 'desc'},
            'filters': [{'column': done, 'operator': 'equals', 'value': True},
                        {'column': number, 'operator': 'gt', 'value': 48}],
        })
        self.assertEqual([row['values'] for row in result['rows']],
                         [{name: 'Row 50', number: 50, day: '2026-11-16', done: True}])
        row = result['rows'][0]['id']
        old = self.latest['revision']
        self.action('setCell', row=row, column=day, value='2026-12-01')
        with self.assertRaises(NotesError) as stale:
            self.database.action('Source.md', {'type': 'deleteRow', 'row': row, 'revision': old})
        self.assertEqual(stale.exception.code, 'revision_conflict')
        with self.assertRaises(NotesError):
            self.action('setCell', row=row, column=number, value='bad')
        self.action('renameColumn', column=number, name='Count')
        self.action('deleteColumn', column=day)
        self.action('deleteRow', row=row)
        self.assertEqual(self.latest['total'], 51)

    def test_import_cleanup_revalidates_and_protects_other_pages(self):
        with self.assertRaises(NotesError):
            self.database.import_file('Source.md', '../bad.pdf', b'fake')
        with self.assertRaises(NotesError):
            self.database.import_file('Source.md', 'thing.cmd', b'fake')
        self.assertFalse(self.directory.exists())
        self.latest = self.database.import_file('Source.md', '手册.pdf', b'first')
        stamp = self.latest['revision']
        self.assertEqual(self.database.import_file('Source.md', '手册.pdf', b'first')['revision'], stamp)
        self.latest = self.database.import_file('Source.md', '手册.pdf', b'second')
        candidates = self.candidates('手册.pdf')
        self.assertEqual([file['name'] for file in candidates], ['手册.pdf', '手册 (2).pdf'])
        paths = {self.database.resolve_attachment('Source.md', file['id']).read_bytes(): file['id']
                 for file in candidates}
        self.assertEqual(set(paths), {b'first', b'second'})
        self.save()
        self.action('addColumn', name='Files', columnType='attachment')
        attachment_col = self.latest['columns'][1]['id']
        for _ in range(50):
            self.action('addRow')
        self.action('addRow', {'page': 2}, values={attachment_col: {'kind': 'attachment', 'id': paths[b'first']}})
        expected = self.latest['rows'][0]['values'][attachment_col]
        self.assertEqual(expected, {'kind': 'attachment', 'name': '手册.pdf', 'exists': True, 'id': paths[b'first']})
        cleanup = self.database.action('Source.md', {'type': 'previewCleanup'})
        self.assertEqual(cleanup['count'], 1)
        unused = self.database.resolve_attachment('Source.md', paths[b'second'])
        unused.write_bytes(b'changed after preview')
        with self.assertRaises(NotesError) as stale:
            self.action('cleanup', candidateToken=cleanup['candidateToken'])
        self.assertEqual(stale.exception.code, 'revision_conflict')
        self.assertTrue(unused.exists())
        cleanup = self.database.action('Source.md', {'type': 'previewCleanup'})
        self.action('cleanup', candidateToken=cleanup['candidateToken'])
        self.assertEqual(self.latest['deletedCount'], 1)
        self.assertFalse(unused.exists())
        referenced = self.database.resolve_attachment('Source.md', paths[b'first'])
        referenced.unlink()
        missing = self.database.read('Source.md', {'page': 2})['rows'][0]['values'][attachment_col]
        self.assertEqual(missing, {**expected, 'exists': False})

    def test_relative_note_links_move_rollback_and_companion_moves(self):
        self.save()
        self.store.create('', 'Target.md', 'note')
        self.store.create('', 'Folder', 'folder')
        self.action('addColumn', name='Files', columnType='attachment')
        attachment_col = self.latest['columns'][1]['id']
        candidate = self.candidates('Target')[0]
        self.assertEqual(candidate['kind'], 'note')
        self.action('addRow', values={attachment_col: {'kind': 'note', 'path': candidate['path']}})
        revision = self.latest['revision']
        with mock.patch.object(self.store.index, 'remap', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.store.move('Target.md', 'Folder/New.md')
        after_rollback = self.database.read('Source.md')
        self.assertEqual(after_rollback['revision'], revision)
        self.assertEqual(after_rollback['rows'][0]['values'][attachment_col]['path'], 'Target.md')
        self.store.move('Target.md', 'Folder/New.md')
        self.assertEqual(self.database.read('Source.md')['rows'][0]['values'][attachment_col], {
            'kind': 'note', 'path': 'Folder/New.md', 'name': 'New.md', 'exists': True,
        })
        self.database.import_file('Source.md', 'sample.pdf', b'content')
        attachment = self.candidates('sample')[0]['id']
        self.store.move('Source.md', 'Folder/Moved.md')
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.database.resolve_attachment('Folder/Moved.md', attachment).read_bytes(), b'content')
        (self.store.root / 'Folder' / 'New.md').unlink()
        self.assertFalse(self.database.read('Folder/Moved.md')['rows'][0]['values'][attachment_col]['exists'])

    def test_image_cleanup_skips_database_subtree(self):
        result = self.save()
        preserved = self.directory / 'files' / 'preserved.png'
        self.assertTrue(preserved.parent.is_dir())
        preserved.write_bytes(b'preserved')
        unused = self.directory.parent / 'unused.png'
        unused.write_bytes(b'unused')
        count = self.store.cleanup_unused_images('Source.md', result['revision'])
        self.assertEqual(count['deletedCount'], 1)
        self.assertTrue(preserved.exists())
        self.assertFalse(unused.exists())


class NoteDatabaseHttpTests(unittest.TestCase):
    def test_query_action_import_external_open_and_disabled_profile(self):
        import app
        from feature_profile import FEATURES, LaunchProfile
        from tests.usage_v2_test_support import IsolatedUsage

        with IsolatedUsage() as fixture:
            note = 'Source.md'
            (fixture.notes / note).write_text(FENCE, encoding='utf-8')
            action = '/api/note-database/action'
            upload = '/api/note-database/attachment/import'
            snapshot = '/api/note-database?' + urlencode({'path': note})
            opener_route = '/api/open-external'
            payload = {'kind': 'note-database-attachment', 'note': note}
            self.assertEqual(fixture.request(snapshot)[1]['exists'], False)
            self.assertEqual(fixture.request(snapshot + '&query=%7B')[0], 400)
            self.assertEqual(fixture.request(action, {'path': note, 'action': []})[0], 400)
            self.assertEqual(fixture.request(upload, {'path': note, 'name': 'test.pdf', 'data': '$!$'})[0], 400)
            self.assertEqual(fixture.request(snapshot)[1]['exists'], False)
            status, created = fixture.request(action, {'path': note, 'action': {'type': 'create'}})
            self.assertEqual((status, created['total']), (200, 0))
            status, imported = fixture.request(upload, {
                'path': note, 'name': '含 空格.pdf', 'data': base64.b64encode(b'example').decode('ascii'),
            })
            self.assertEqual((status, imported['total']), (200, 0))
            status, candidates = fixture.request(action, {'path': note, 'action': {'type': 'searchAttachments', 'query': '.pdf'}})
            self.assertEqual(status, 200)
            payload['target'] = candidates['items'][0]['id']
            authority = app.NOTES_STORE.database.resolve_attachment(note, payload['target'])
            with mock.patch.object(app.os, 'startfile', create=True) as opener:
                self.assertEqual(fixture.request(opener_route, {**payload, 'target': '../../a.pdf'})[0], 400)
                opener.assert_not_called()
                self.assertEqual(fixture.request(opener_route, payload)[0], 200)
                opener.assert_called_once_with(str(authority))
                authority.unlink()
                self.assertEqual(fixture.request(opener_route, payload)[0], 404)
            fixture.server.launch_profile = LaunchProfile({key: key == 'canvas' for key in FEATURES}, restricted=True)
            for route in (snapshot, action, upload):
                self.assertEqual(fixture.request(route)[0], 403, route)
            with mock.patch.object(app.os, 'startfile', create=True) as opener:
                self.assertEqual(fixture.request(opener_route, payload)[0], 403)
                opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()

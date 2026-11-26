"""Real isolated SQLite and note/companion transactions for database blocks."""

import base64
import io
import json
import shutil
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from note_database import DATABASE_DIRECTORY, PURGE_DIRECTORY, copy_attachment_to_downloads, database_fences
from notes_library import NotesError, NotesStore


TABLE = 'source'
FENCE = '```database source\n```\n'
SECOND_FENCE = '```database second\n```\n'


class NoteDatabaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.store = NotesStore(self.home / 'notes')
        self.addCleanup(self.store.close)
        self.store.create('', 'Source.md', 'note')
        self.database = self.store.database
        self.latest = self.read()
        self.directory = self.store.root / 'Source.assets' / DATABASE_DIRECTORY

    def save(self, text=FENCE):
        result = self.store.save('Source.md', text, '')
        self.latest = self.read()
        return result

    def read(self, query=None, identity=TABLE, path='Source.md'):
        return self.database.read(path, identity, query)

    def action(self, kind, query=None, **fields):
        self.latest = self.database.action(
            'Source.md', TABLE, {'type': kind, 'revision': self.latest.get('revision'), **fields}, query,
            recycle=self.recycle,
        )
        return self.latest

    def recycle(self, targets):
        root = self.home / 'recycled'
        root.mkdir(exist_ok=True)
        for index, target in enumerate(targets, start=len(list(root.iterdir()))):
            shutil.move(target, root / str(index))

    def candidates(self, text=''):
        return self.database.action('Source.md', TABLE, {'type': 'searchAttachments', 'query': text})['items']

    def test_layout_options_and_atomic_record_history(self):
        self.save()
        title = self.latest['columns'][0]['id']
        original = self.action('addRow', values={title: 'Original'})['rows'][0]['id']
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
        self.assertEqual(self.read()['revision'], before)
        batch = self.action('batchCells', changes=[
            {'row': original, 'values': {state['id']: done}},
            {'row': None, 'values': {tags['id']: [key]}},
        ])
        self.assertEqual(batch['total'], 2)
        self.assertEqual(self.read({'search': '已完成'})['total'], 1)
        filters = [{'column': tags['id'], 'value': key, 'operator': 'contains'}]
        self.assertEqual(self.read({'filters': filters})['total'], 1)
        with self.assertRaises(NotesError):
            self.action('batchCells', query={'filters': filters}, changes=[{'row': None, 'values': {tags['id']: [key]}}])
        undo = self.action('applyRecords', changes=batch['inverse'])
        self.assertEqual(undo['total'], 1)
        self.assertNotIn(state['id'], undo['rows'][0]['values'])
        redo = self.action('applyRecords', changes=undo['inverse'])
        self.assertEqual([row['id'] for row in redo['rows']], [row['id'] for row in batch['rows']])
        self.action('setChoices', column=tags['id'], choices=[{'id': key, 'name': '要点'}])
        self.assertEqual(self.read({'search': '要点'})['total'], 1)
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
        self.database.import_file('Source.md', '参考.pdf', b'%PDF-1.7')
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

    def test_legacy_choices_receive_colors_without_rewriting_and_keep_them_after_edit(self):
        self.save()
        status = self.action('addColumn', columnType='status', name='状态')['columns'][1]
        legacy = [{key: value for key, value in choice.items() if key != 'tone'} for choice in status['choices']]
        legacy = [legacy[1], legacy[2], legacy[0]]
        file = self.directory / 'database.sqlite3'
        with closing(sqlite3.connect(file)) as connection:
            with connection:
                connection.execute('UPDATE columns SET choices=? WHERE id=?',
                                   (json.dumps(legacy, ensure_ascii=False), status['id']))
        self.latest = self.read()
        self.assertEqual([choice['tone'] for choice in self.latest['columns'][1]['choices']], ['blue', 'green', 'neutral'])
        with closing(sqlite3.connect(file)) as connection:
            stored = connection.execute('SELECT choices FROM columns WHERE id=?', (status['id'],)).fetchone()[0]
        self.assertEqual(json.loads(stored), legacy)
        renamed = [{'id': legacy[1]['id'], 'name': '结项'}, legacy[2], {'name': '等反馈'}]
        status = self.action('setChoices', column=status['id'], choices=renamed)['columns'][1]
        self.assertEqual([choice['tone'] for choice in status['choices']], ['green', 'neutral', 'amber'])

    def test_fence_requires_visible_top_level_closed_empty_block(self):
        for text in (
            FENCE,
            FENCE.replace('\n', '\r\n'),
            '```database source \t\n\t\n``` \t',
            'a\n\n' + FENCE + '\nb',
            '---\ntags: []\n---\n' + FENCE,
        ):
            with self.subTest(text=text):
                self.assertTrue(database_fences(text))
        for text in (
            '```database', '```database\n```', '```database source\nxxx\n```', '```database source\n```%',
            '```\n' + FENCE + '```\n', '~~~~\n' + FENCE + '~~~~\n',
            ''.join('> ' + line for line in FENCE.splitlines(keepends=True)),
            '- item\n' + ''.join('  ' + line for line in FENCE.splitlines(keepends=True)),
            '<!--\n' + FENCE + '-->\n', '---\n' + FENCE + '---\n',
        ):
            with self.subTest(text=text):
                self.assertFalse(database_fences(text))

    def test_isolated_tables_and_permanent_deletion(self):
        self.assertFalse(self.latest['exists'])
        self.assertFalse(self.directory.exists())
        self.assertEqual(set(self.save(FENCE * 2 + SECOND_FENCE)['databasesCreated']), {TABLE, 'second'})
        second = self.read(identity='second')
        selected = self.action('addRow')
        first_row = selected['rows'][0]['id']
        with self.assertRaises(NotesError):
            self.database.action('Source.md', 'second', {'type': 'deleteRow', 'row': first_row, 'revision': second['revision']})
        self.assertEqual(self.read(identity='second'), second)
        ordinary = self.store.root / 'Source.assets' / 'keep.png'
        ordinary.write_bytes(b'ordinary')
        attach = self.database.import_file('Source.md', 'shared.pdf', b'file', ['missing', 'second'])
        self.assertEqual(attach['databaseId'], 'second')
        tables = [{'id': TABLE, 'revision': selected['revision']}, {'id': 'second', 'revision': 'old'}]
        with self.assertRaises(NotesError):
            self.action('deleteTables', tables=tables)
        self.assertTrue(self.read()['exists'])
        self.assertEqual(self.action('deleteTables', tables=tables[:1])['deletedIds'], [TABLE])
        self.assertTrue(self.read()['deleted'])
        self.assertEqual((self.store.root / 'Source.md').read_text(encoding='utf-8'), FENCE * 2 + SECOND_FENCE)
        self.assertTrue(ordinary.exists())
        self.assertEqual(self.database.resolve_attachment('Source.md', attach['attachmentId']).read_bytes(), b'file')
        self.save('ordinary')
        self.assertNotIn('databasesCreated', self.save(FENCE))
        self.assertTrue(self.action('create')['deleted'])
        catalog = self.action('list')
        self.assertEqual([(row['id'], row['viewCount']) for row in catalog['tables']], [('second', 0)])
        self.assertEqual(catalog['fileCount'], 1)
        self.assertEqual(self.action('purge', token=catalog['token'])['deletedIds'], ['second'])
        self.assertFalse((self.directory / 'files').exists())
        self.assertTrue(self.read(identity='second')['deleted'])
        self.assertTrue(ordinary.exists())

    def test_purge_revalidates_files_and_recovers_both_commit_states(self):
        self.save()
        imported = self.database.import_file('Source.md', 'file.pdf', b'before')
        attachment = self.database.resolve_attachment('Source.md', imported['attachmentId'])
        sidecar = attachment.with_name('annotations.json')
        sidecar.write_bytes(b'original annotations')
        files, stage = self.directory / 'files', self.directory / PURGE_DIRECTORY
        catalog = self.action('list')
        attachment.write_bytes(b'after confirmation')
        with self.assertRaises(NotesError) as stale:
            self.action('purge', token=catalog['token'])
        self.assertEqual(stale.exception.code, 'revision_conflict')
        catalog = self.action('list')
        self.assertEqual(catalog['fileCount'], 1)
        sidecar.write_bytes(b'annotation changed after confirmation')
        with self.assertRaises(NotesError) as stale:
            self.action('purge', token=catalog['token'])
        self.assertEqual(stale.exception.code, 'revision_conflict')
        catalog = self.action('list')
        rename = Path.rename
        def locked(path, target):
            if path == files:
                raise PermissionError('attachment is locked')
            return rename(path, target)
        with mock.patch.object(Path, 'rename', locked), self.assertRaises(PermissionError):
            self.action('purge', token=catalog['token'])
        self.assertTrue(self.read()['exists'])
        with mock.patch.object(self.database, '_delete_tables', side_effect=sqlite3.OperationalError('injected')):
            with self.assertRaises(sqlite3.OperationalError):
                self.action('purge', token=catalog['token'])
        self.assertTrue(attachment.exists())
        files.rename(stage)
        self.assertTrue(self.read()['exists'])
        self.assertTrue(attachment.exists(), 'uncommitted staging is restored')
        self.assertEqual(sidecar.read_bytes(), b'annotation changed after confirmation')
        with mock.patch.object(shutil, 'rmtree', side_effect=PermissionError('locked after commit')):
            self.assertTrue(self.action('purge', token=catalog['token'])['cleanupPending'])
            self.assertTrue(self.read()['deleted'])
        self.assertTrue(stage.exists())
        self.assertTrue(self.read()['deleted'])
        self.assertFalse(stage.exists(), 'committed staging is removed on the next access')
        self.assertFalse(sidecar.exists())

    def test_creation_failure_can_retry_only_a_saved_fence(self):
        with mock.patch.object(self.database, '_initialize', side_effect=OSError('disk is full')):
            result = self.save()
        self.assertEqual(result['databaseCreateFailed'], [TABLE])
        self.assertFalse(self.read()['exists'])
        self.assertEqual(self.store.load('Source.md')['content'], FENCE)
        with self.assertRaises(NotesError):
            self.database.action('Source.md', 'other', {'type': 'create'})
        self.assertTrue(self.action('create')['exists'])

    def test_choice_creation_color_and_deletion_are_scoped_to_the_column(self):
        self.save()
        column = self.action('addColumn', columnType='multiSelect', name='Tags')['columns'][1]['id']
        first = self.action('addRow')['addedRow']['id']
        option_a = self.action('createChoiceValue', column=column, row=first, name='甲')['columns'][1]['choices'][0]
        with self.assertRaises(NotesError):
            self.action('createChoiceValue', column=column, row=first, name='  甲 ')
        page = self.action('createChoiceValue', column=column, row=first, name='乙')
        option_b = page['columns'][1]['choices'][1]
        self.assertEqual(page['rows'][0]['values'][column], [option_a['id'], option_b['id']])
        self.assertNotEqual(option_a['tone'], option_b['tone'])
        for _ in range(49):
            self.action('addRow')
        self.action('addRow', {'page': 2}, values={column: [option_a['id'], option_b['id']]})
        after = self.action('setChoices', {'page': 2}, column=column, clearRemoved=True,
                            choices=[{**option_b, 'name': '新版', 'tone': 'rose'}])
        self.assertEqual(after['columns'][1]['choices'], [{**option_b, 'name': '新版', 'tone': 'rose'}])
        self.assertEqual(after['rows'][0]['values'][column], [option_b['id']])
        self.assertEqual(self.read()['rows'][0]['values'][column], [option_b['id']])
        for tone in ('default', 'brown', 'orange', 'red'):
            page = self.action('setChoices', column=column, choices=[{**option_b, 'name': '新版', 'tone': tone}])
            self.assertEqual(page['columns'][1]['choices'][0]['tone'], tone)
            self.assertEqual(self.read()['rows'][0]['values'][column], [option_b['id']])
        with self.assertRaises(NotesError):
            self.action('setChoices', column=column, choices=[{**option_b, 'tone': 'unknown'}])

    def test_shared_file_cleanup_counts_detached_tables(self):
        self.save(FENCE + SECOND_FENCE)
        asset = self.database.import_file('Source.md', 'shared.pdf', b'pdf')['attachmentId']
        for table in (TABLE, 'second'):
            page = self.read(identity=table)
            page = self.database.action('Source.md', table, {'type': 'addColumn', 'revision': page['revision'],
                                                              'name': 'PDF', 'columnType': 'attachment'})
            self.database.action('Source.md', table, {'type': 'addRow', 'revision': page['revision'], 'values': {
                page['addedColumn']: {'kind': 'attachment', 'id': asset}}})
        self.save(FENCE)
        table = self.latest
        self.action('deleteTables', tables=[{'id': TABLE, 'revision': table['revision']}])
        self.assertEqual(self.action('previewCleanup')['count'], 0)
        self.assertTrue(self.database.resolve_attachment('Source.md', asset).is_file())

    def test_queries_typed_cells_paging_and_revision_conflict(self):
        self.save()
        name = self.latest['columns'][0]['id']
        for kind in ('number', 'date', 'checkbox', 'attachment'):
            self.action('addColumn', name=kind, columnType=kind)
        number, day, done, _ = [column['id'] for column in self.latest['columns'][1:]]
        for index in range(52):
            self.action('addRow', values={name: f'Row {index}', number: index, day: '2026-11-16', done: index % 2 == 0})
        result = self.read({'page': 2})
        self.assertEqual(result['total'], 52)
        self.assertEqual(result['rows'][0]['values'][number], 50)
        result = self.read({
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
            self.database.action('Source.md', TABLE, {'type': 'deleteRow', 'row': row, 'revision': old})
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
        first = self.database.import_file('Source.md', '手册.pdf', b'first')
        self.assertEqual(self.database.import_file('Source.md', '手册.pdf', b'first'), first)
        self.database.import_file('Source.md', '手册.pdf', b'second')
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
        cleanup = self.action('previewCleanup')
        self.assertEqual(cleanup['count'], 1)
        unused = self.database.resolve_attachment('Source.md', paths[b'second'])
        unused.write_bytes(b'changed after preview')
        with self.assertRaises(NotesError) as stale:
            self.action('cleanup', candidateToken=cleanup['candidateToken'])
        self.assertEqual(stale.exception.code, 'revision_conflict')
        self.assertTrue(unused.exists())
        cleanup = self.action('previewCleanup')
        self.action('cleanup', candidateToken=cleanup['candidateToken'])
        self.assertEqual(self.latest['deletedCount'], 1)
        self.assertFalse(unused.exists())
        referenced = self.database.resolve_attachment('Source.md', paths[b'first'])
        referenced.unlink()
        missing = self.read({'page': 2})['rows'][0]['values'][attachment_col]
        self.assertEqual(missing, {**expected, 'exists': False})

    def test_cleanup_groups_pdf_and_annotations_and_rechecks_protected_tabs(self):
        import note_pdf_annotations as pdf

        self.save()
        identity = self.database.import_file('Source.md', 'Shared.pdf', b'%PDF-1.7\n%%EOF')['attachmentId']
        target = self.database.resolve_attachment('Source.md', identity)
        sidecar = target.with_name(pdf.FILENAME)
        digest = pdf.fingerprint(target, pdf.asset_revision(target.stat()))
        mark = {'id': str(uuid.uuid4()), 'page': 1, 'kind': 'note', 'color': '#f4b740',
                'point': [10, 20], 'text': 'Read together'}
        preview = self.action('previewCleanup')
        self.assertEqual(preview['count'], 1)
        self.assertEqual(self.action('previewCleanup', protectedIds=[identity])['count'], 0)
        with self.assertRaisesRegex(NotesError, '附件候选已变化'):
            self.action('cleanup', candidateToken=preview['candidateToken'], protectedIds=[identity])
        pdf.save(sidecar, pdf.read(sidecar), digest, {'revision': None, 'upsert': [mark], 'remove': []},
                 self.store.atomic_bytes)
        self.assertEqual(self.action('list')['fileCount'], 1)
        with self.assertRaisesRegex(NotesError, '附件候选已变化'):
            self.action('cleanup', candidateToken=preview['candidateToken'])
        extra = target.with_name('unmanaged.txt')
        extra.touch()
        self.assertEqual(self.action('previewCleanup')['count'], 0)
        extra.unlink()
        preview = self.action('previewCleanup')
        self.assertEqual(self.action('cleanup', candidateToken=preview['candidateToken'])['deletedCount'], 1)
        self.assertFalse(target.parent.exists())
        group = self.home / 'recycled' / '0'
        self.assertEqual((group / target.name).read_bytes(), b'%PDF-1.7\n%%EOF')
        self.assertEqual(pdf.read(group / pdf.FILENAME)['annotations'], [mark])

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
        after_rollback = self.read()
        self.assertEqual(after_rollback['revision'], revision)
        self.assertEqual(after_rollback['rows'][0]['values'][attachment_col]['path'], 'Target.md')
        self.store.move('Target.md', 'Folder/New.md')
        self.assertEqual(self.read()['rows'][0]['values'][attachment_col], {
            'kind': 'note', 'path': 'Folder/New.md', 'name': 'New.md', 'exists': True,
        })
        self.database.import_file('Source.md', 'sample.pdf', b'content')
        attachment = self.candidates('sample')[0]['id']
        self.store.move('Source.md', 'Folder/Moved.md')
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.database.resolve_attachment('Folder/Moved.md', attachment).read_bytes(), b'content')
        (self.store.root / 'Folder' / 'New.md').unlink()
        self.assertFalse(self.read(path='Folder/Moved.md')['rows'][0]['values'][attachment_col]['exists'])

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

    def test_picker_import_keeps_cell_and_shared_store_consistent(self):
        self.save()
        column = self.action('addColumn', name='Files', columnType='attachment')['addedColumn']
        row = self.action('addRow')['addedId']
        target = {'databaseId': TABLE, 'row': row, 'column': column, 'revision': self.latest['revision'], 'includeRow': True}
        pdf = self.database.import_file('Source.md', 'first.pdf', b'%PDF-1.7', target=target, query={'search': 'no matches'})
        old = pdf['updatedRow']['values'][column]
        self.assertEqual(old['name'], 'first.pdf')
        self.assertEqual(pdf['rows'], [])
        with self.assertRaises(NotesError) as stale:
            self.database.import_file('Source.md', 'obsolete.pdf', b'%PDF-1.7', target=target)
        self.assertEqual(stale.exception.code, 'revision_conflict')
        target['revision'] = pdf['revision']
        with self.assertRaises(NotesError):
            self.database.import_file('Source.md', 'invalid.png', b'not an image', target=target)
        with mock.patch.object(self.database, '_write_result', side_effect=OSError('cannot project')):
            with self.assertRaises(OSError):
                self.database.import_file('Source.md', 'rolled-back.pdf', b'%PDF-1.7', target=target)
        self.assertEqual(self.read()['rows'][0]['values'][column], old)
        self.assertEqual([item['name'] for item in self.candidates('.pdf')], ['first.pdf'])
        self.assertEqual(len(list((self.directory / 'files').iterdir())), 1)
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
        changed = self.database.import_file('Source.md', 'picture.svg', svg, target=target)
        current = changed['rows'][0]['values'][column]
        self.assertEqual(self.database.resolve_attachment('Source.md', current['id']).read_bytes(), svg)
        self.assertEqual(self.database.resolve_attachment('Source.md', old['id']).read_bytes(), b'%PDF-1.7')
        self.assertEqual(changed['inverse'][0]['values'][column], {'kind': 'attachment', 'id': old['id']})
        self.assertEqual(self.database.attachment_download_source('Source.md', TABLE, row, column, current).name, 'picture.svg')
        with self.assertRaises(NotesError) as changed_link:
            self.database.attachment_download_source('Source.md', TABLE, row, column, old)
        self.assertEqual(changed_link.exception.code, 'revision_conflict')
        self.database.resolve_attachment('Source.md', current['id']).unlink()
        with self.assertRaises(NotesError) as missing:
            self.database.attachment_download_source('Source.md', TABLE, row, column, current)
        self.assertEqual(missing.exception.status, 404)

    def test_download_copy_never_overwrites_and_cleans_up_failed_copy(self):
        downloads = self.home / 'Redirected Downloads'
        downloads.mkdir()
        (downloads / '同名.pdf').write_bytes(b'original')
        with mock.patch('note_database._downloads_directory', return_value=downloads):
            self.assertEqual(copy_attachment_to_downloads(io.BytesIO(b'copy'), '同名.pdf'), '同名 (2).pdf')
            with mock.patch('note_database.shutil.copyfileobj', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    copy_attachment_to_downloads(io.BytesIO(b'unused'), 'new.pdf')
        self.assertEqual({p.name: p.read_bytes() for p in downloads.iterdir()}, {'同名.pdf': b'original', '同名 (2).pdf': b'copy'})

    def chart(self, chart=None, query=None, identity=TABLE):
        return self.database.read_chart('Source.md', identity, query, chart)

    def add_chart_records(self, rows):
        return self.action('batchCells', query={'page': self.latest['total'] + 1},
                           changes=[{'row': None, 'values': values} for values in rows])

    def test_chart_view_is_lazy_transactional_and_moves_with_the_database(self):
        self.save(FENCE + '\n' + SECOND_FENCE)
        day = self.action('addColumn', name='日期', columnType='date')['addedColumn']
        filename = self.directory / 'database.sqlite3'
        default = {'mode': 'data', 'chart': None, 'valid': False, 'style': {}, 'styleRevision': None}
        spec = self.latest['chartOptions']['suggested']
        self.assertEqual(spec, {'type': 'line', 'groupBy': day, 'metric': {'op': 'count'}, 'bucket': 'day'})
        before = filename.read_bytes()
        self.assertEqual(self.read()['chartView'], default)
        self.assertEqual(self.action('setChartView', mode='data')['chartView'], default)
        with self.assertRaises(NotesError):
            self.action('setChartView', mode='chart')
        with mock.patch.object(self.database, '_snapshot', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.action('setChartView', mode='chart', chart=spec)
        self.assertEqual(filename.read_bytes(), before)
        previous_revision = self.latest['revision']
        saved = self.action('setChartView', mode='chart', chart=spec)
        self.assertNotEqual(saved['revision'], previous_revision)
        self.assertEqual(saved['chartView'], {**default, 'mode': 'chart', 'chart': spec, 'valid': True})
        with self.assertRaises(NotesError) as stale:
            self.database.action('Source.md', TABLE, {'type': 'setChartView', 'mode': 'data', 'revision': previous_revision})
        self.assertEqual(stale.exception.code, 'revision_conflict')
        self.assertEqual(self.read(identity='second')['chartView'], default)
        self.assertEqual(self.action('setChartView', mode='chart')['revision'], saved['revision'])
        self.action('renameColumn', column=day, name='完成日期')
        self.assertEqual(self.latest['chartView'], saved['chartView'])
        self.assertEqual(next(field['name'] for field in self.latest['chartOptions']['fields'] if field['id'] == day), '完成日期')
        data_view = self.action('setChartView', mode='data')['chartView']
        self.assertEqual(data_view, {**default, 'chart': spec, 'valid': True})
        self.assertEqual(self.action('setChartView', mode='chart')['chartView'], saved['chartView'])
        self.store.create('', 'Folder', 'folder')
        self.store.move('Source.md', 'Folder/Moved.md')
        self.assertEqual(self.read(path='Folder/Moved.md')['chartView'], saved['chartView'])

    def test_invalid_saved_chart_remains_repairable_and_is_removed_with_table(self):
        self.save()
        day = self.action('addColumn', name='Date', columnType='date')['addedColumn']
        spec = self.latest['chartOptions']['suggested']
        self.action('setChartView', mode='chart', chart=spec)
        self.action('deleteColumn', column=day)
        self.assertEqual(self.read()['chartView'], {'mode': 'chart', 'chart': spec, 'valid': False, 'style': {}, 'styleRevision': None})
        self.action('setChartView', mode='data')
        with self.assertRaises(NotesError) as invalid:
            self.action('setChartView', mode='chart')
        self.assertEqual(invalid.exception.code, 'invalid_chart')
        self.action('deleteTables', tables=[{'id': TABLE, 'revision': self.latest['revision']}])
        self.assertTrue(self.read()['deleted'])
        with closing(sqlite3.connect(self.directory / 'database.sqlite3')) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone(), (3,))
            self.assertEqual(connection.execute('SELECT count(*) FROM chart_views').fetchone(), (0,))

    def test_chart_appearance_uses_independent_revision_and_stable_category_keys(self):
        self.save()
        title = self.latest['columns'][0]['id']
        done = self.action('addColumn', name='Done', columnType='checkbox')['addedColumn']
        self.add_chart_records([{title: 'A'}, {title: 'B', done: True}])
        spec = {'type': 'doughnut', 'groupBy': title, 'metric': {'op': 'count'}}
        self.action('setChartView', mode='chart', chart=spec)
        revision = self.latest['revision']
        original = self.chart(spec)
        key = original['groups'][1]['colorKey']
        self.assertRegex(key, r'^[a-f0-9]{64}$')
        self.assertEqual(self.chart(spec, {'search': 'B'})['groups'][0]['colorKey'], key)
        for chart_type in ('column', 'bar'):
            self.assertEqual(self.chart({**spec, 'type': chart_type})['groups'][1]['colorKey'], key)
        style = {'palette': 'earth', 'primary': 'iris', 'categories': {key: 'coral'}}
        normalized = {**style, 'palette': 'deep'}
        with mock.patch.object(self.database, '_snapshot', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.action('setChartAppearance', styleRevision=None, style=style)
        self.assertEqual(self.read()['chartView']['style'], {})
        saved = self.action('setChartAppearance', styleRevision=None, style=style)
        self.assertEqual(saved['revision'], revision)
        appearance_revision = saved['chartView']['styleRevision']
        self.assertEqual(saved['chartView']['style'], normalized)
        self.assertEqual(self.chart(spec), original)
        with self.assertRaises(NotesError) as conflict:
            self.action('setChartAppearance', styleRevision=None, style={})
        self.assertEqual(conflict.exception.code, 'chart_style_conflict')
        for invalid in ({'palette': 'unknown'}, {'primary': '#024a77'}, {'categories': {'A': 'coral'}}):
            with self.assertRaises(NotesError) as error:
                self.action('setChartAppearance', styleRevision=appearance_revision, style=invalid)
            self.assertEqual(error.exception.code, 'invalid_chart_style')
        repeated = self.action('setChartAppearance', styleRevision=appearance_revision, style=style)
        self.assertEqual(repeated['chartView']['styleRevision'], appearance_revision)
        self.action('setChartView', mode='data')
        self.action('setChartView', mode='chart')
        self.assertEqual(self.read()['chartView']['style'], normalized)
        self.action('setChartView', mode='chart', chart={**spec, 'type': 'column'})
        self.assertEqual(self.read()['chartView']['style'], normalized)
        changed = self.action('setChartView', mode='chart', chart={**spec, 'groupBy': done})['chartView']
        self.assertEqual(changed['style'], {'palette': 'deep', 'primary': 'iris'})
        self.assertNotEqual(changed['styleRevision'], appearance_revision)

        date = self.action('addColumn', name='Date', columnType='date')['addedColumn']
        self.add_chart_records([{date: '2026-11-01'}, {date: '2026-11-02'}])
        daily = {**spec, 'type': 'column', 'groupBy': date, 'bucket': 'day'}
        view = self.action('setChartView', mode='chart', chart=daily)['chartView']
        daily_key = self.chart(daily)['groups'][0]['colorKey']
        style = {'palette': 'vivid', 'primary': 'leaf-medium', 'categories': {daily_key: 'sky-light'}}
        self.action('setChartAppearance', styleRevision=view['styleRevision'], style=style)
        self.assertEqual(self.read()['chartView']['style'], style)
        monthly = self.action('setChartView', mode='chart', chart={**daily, 'bucket': 'month'})['chartView']
        self.assertEqual(monthly['style'], {'palette': 'vivid', 'primary': 'leaf-medium'})

    def test_chart_default_and_full_filtered_date_buckets(self):
        self.assertFalse(self.chart()['exists'])
        self.save()
        day = self.action('addColumn', name='日期', columnType='date')['addedColumn']
        state = self.action('addColumn', name='状态', columnType='status')['columns'][-1]
        done = state['choices'][-1]['id']
        dates = ['2026-11-17', '2026-11-17', '2026-11-18', '2026-11-15', '2026-11-16', '2026-11-17']
        self.add_chart_records([{day: value, state['id']: done} for value in dates])
        spec = self.chart()['chart']
        self.assertEqual(spec, {'type': 'line', 'groupBy': day, 'bucket': 'day', 'metric': {'op': 'count'}})
        self.assertEqual([(point['key'], point['value']) for point in self.chart()['groups']],
                         list(zip(sorted(set(dates)), [1, 1, 3, 1])))
        self.add_chart_records([{day: '2026-11-17', state['id']: done}] * 60 + [
            {day: '2026-11-01', state['id']: done}, {day: '2026-12-01', state['id']: done},
            {day: '2026-12-01', state['id']: state['choices'][0]['id']}, {state['id']: done},
        ])
        query = {'search': state['choices'][-1]['name'], 'page': 2, 'sort': {'column': day, 'direction': 'desc'},
                 'filters': [{'column': state['id'], 'operator': 'equals', 'value': done}]}
        self.assertEqual(len(self.read(query)['rows']), 19)
        database_file = self.directory / 'database.sqlite3'
        before = database_file.read_bytes()
        weeks = self.chart({**spec, 'bucket': 'week'}, query)
        months = self.chart({**spec, 'bucket': 'month'}, query)
        self.assertEqual([(point['key'], point['value']) for point in weeks['groups']],
                         [('2026-10-26', 1), ('2026-11-09', 1), ('2026-11-16', 65), ('2026-11-30', 1)])
        self.assertEqual([(point['key'], point['value']) for point in months['groups']],
                         [('2026-11-01', 67), ('2026-12-01', 1)])
        self.assertEqual(months['revision'], self.latest['revision'])
        self.assertEqual(database_file.read_bytes(), before)
        self.assertEqual(self.chart(spec, {'search': 'no match'})['groups'], [])
        self.action('deleteColumn', column=day)
        with self.assertRaises(NotesError) as missing_column:
            self.chart(spec)
        self.assertEqual(missing_column.exception.code, 'invalid_chart')
        self.action('deleteTables', tables=[{'id': TABLE, 'revision': self.latest['revision']}])
        self.assertTrue(self.chart()['deleted'])

    def test_chart_metrics_unset_checkbox_and_overlapping_tags(self):
        self.save()
        label = self.latest['columns'][0]['id']
        number = self.action('addColumn', name='Amount', columnType='number')['addedColumn']
        check = self.action('addColumn', name='Done', columnType='checkbox')['addedColumn']
        tags = self.action('addColumn', name='Topics', columnType='multiSelect')['addedColumn']
        choices = self.action('setChoices', column=tags, choices=[{'name': 'B'}, {'name': 'A'}])['columns'][-1]['choices']
        b, a = (choice['id'] for choice in choices)
        self.add_chart_records([
            {label: 'A', number: -2, check: True, tags: [b, a, b]},
            {label: 'A', number: 2, check: False, tags: [a]},
            {label: 'B', number: 3, check: True},
            {label: 'C'},
        ])
        for op, values in [('sum', [0, 3, None]), ('avg', [0, 3, None]),
                           ('min', [-2, 3, None]), ('max', [2, 3, None])]:
            with self.subTest(op=op):
                chart = {'type': 'column', 'groupBy': label, 'metric': {'op': op, 'column': number}}
                self.assertEqual([point['value'] for point in self.chart(chart)['groups']], values)
        groups = self.chart({'type': 'doughnut', 'groupBy': check})['groups']
        self.assertEqual([(point['key'], point['value']) for point in groups], [('0', 2), ('1', 2)])
        chart = {'type': 'bar', 'groupBy': tags}
        groups = self.chart(chart)['groups']
        self.assertEqual([(point['key'], point['label'], point['value']) for point in groups], [(b, 'B', 1), (a, 'A', 2)])
        for invalid in ({**chart, 'type': 'doughnut'}, {**chart, 'metric': {'op': 'min', 'column': number}}):
            with self.assertRaises(NotesError) as error:
                self.chart(invalid)
            self.assertEqual(error.exception.code, 'invalid_chart')
        with self.assertRaises(NotesError) as negative:
            self.chart({'type': 'doughnut', 'groupBy': label, 'metric': {'op': 'min', 'column': number}})
        self.assertEqual(negative.exception.code, 'chart_metric_domain')

    def test_chart_numeric_extremes_and_limits(self):
        self.save()
        label = self.latest['columns'][0]['id']
        number = self.action('addColumn', name='Amount', columnType='number')['addedColumn']
        self.add_chart_records([{label: 'A', number: 1e308}] * 2)
        spec = {'type': 'bar', 'groupBy': label, 'metric': {'op': 'avg', 'column': number}}
        self.assertEqual(self.chart(spec)['groups'][0]['value'], 1e308)
        spec['metric']['op'] = 'sum'
        with self.assertRaises(NotesError) as overflow:
            self.chart(spec)
        self.assertEqual(overflow.exception.code, 'chart_numeric_range')
        self.add_chart_records([{label: 'A', number: -1e308}, {label: 'A', number: -1e308},
                                {label: 'A', number: 5e-324}])
        self.assertEqual(self.chart(spec)['groups'][0]['value'], 5e-324)
        for start in range(0, 500, 200):
            self.add_chart_records([{label: str(index)} for index in range(start, min(500, start + 200))])
        for chart_type in ('doughnut', 'bar'):
            with self.assertRaises(NotesError) as too_many:
                self.chart({'type': chart_type, 'groupBy': label})
            self.assertEqual((too_many.exception.status, too_many.exception.code), (422, 'chart_group_limit'))
        with mock.patch('note_database_chart.QUERY_BUDGET_SECONDS', 0):
            with self.assertRaises(NotesError) as timed_out:
                self.chart()
        self.assertEqual((timed_out.exception.status, timed_out.exception.code), (503, 'chart_timeout'))
        self.assertEqual(self.read()['total'], 505)


    def test_named_chart_views_migrate_legacy_style_and_keep_independent_filters(self):
        self.save()
        title = self.latest['columns'][0]['id']
        self.add_chart_records([{title: 'Keep'}, {title: 'Other'}, {title: 'Keep'}])
        spec = {'type': 'column', 'groupBy': title, 'metric': {'op': 'count'}}
        self.action('setChartView', mode='chart', chart=spec)
        with closing(sqlite3.connect(self.directory / 'database.sqlite3')) as connection:
            connection.execute('UPDATE chart_views SET chart=?', (json.dumps({**spec, 'style': {'primary': 'coral'},
                                                                              'styleRevision': 'a' * 32}),))
            connection.commit()
        self.assertEqual(self.read()['chartCards'][0]['style'], {'primary': 'coral'})
        self.assertEqual(self.read()['chartOrientation'], 'vertical')
        self.assertFalse(self.read()['chartHideTitles'])
        added = self.latest = self.database.action('Source.md', TABLE, {
            'type': 'setChartCard', 'operation': 'add', 'revision': self.latest['revision'],
            'name': 'Only kept', 'chart': spec, 'query': {'search': 'Keep'},
        })
        identity = added['changedChartId']
        duplicate = self.action('setChartCard', operation='duplicate', chartId=identity, name='Copy')
        copy_id = duplicate['changedChartId']
        self.action('setChartAppearance', chartId=copy_id, styleRevision=None, style={'primary': 'mint'})
        layout = [{'id': copy_id, 'hidden': True}, {'id': identity, 'hidden': False}, {'id': 'default', 'hidden': False}]
        with self.assertRaises(NotesError):
            self.action('setChartCard', operation='arrange', orientation='unknown', layout=layout)
        with self.assertRaises(NotesError):
            self.action('setChartCard', operation='arrange', hideTitles='true', layout=layout)
        self.action('setChartCard', operation='arrange', showData=True, orientation='horizontal', hideTitles=True, layout=layout)
        self.assertTrue(self.read()['chartShowData'])
        self.assertEqual(self.read()['chartOrientation'], 'horizontal')
        self.action('setChartCard', operation='arrange', layout=layout)
        self.action('setChartView', mode='data')
        self.action('setChartView', mode='chart')
        self.assertEqual(self.read()['chartOrientation'], 'horizontal')
        self.assertTrue(self.read()['chartHideTitles'])
        self.assertEqual([(c['name'], c['style'].get('primary'), c['hidden']) for c in self.read()['chartCards']],
                         [('Copy', 'mint', True), ('Only kept', None, False), ('', 'coral', False)])
        before = next(c for c in self.latest['chartCards'] if c['id'] == identity)
        with self.assertRaises(NotesError):
            self.action('setChartCard', operation='rename', chartId=identity, name='   ')
        renamed = self.action('setChartCard', operation='rename', chartId=identity, name=' Kept detail ')
        self.assertEqual(renamed['changedChartId'], identity)
        self.assertEqual(next(c for c in renamed['chartCards'] if c['id'] == identity), {**before, 'name': 'Kept detail'})
        self.assertTrue(renamed['chartHideTitles'])
        self.assertEqual(self.action('setChartCard', operation='rename', chartId=identity, name='Kept detail')['revision'],
                         renamed['revision'])
        read_chart = lambda **kwargs: self.database.read_chart('Source.md', TABLE, chart_id=identity, **kwargs)
        self.assertEqual([p['value'] for p in read_chart()['groups']], [2])
        self.assertEqual(read_chart(query={'search': 'Other'})['groups'], [])
        detail = read_chart(detail={'key': 'Keep'})
        self.assertEqual(detail['total'], 2)
        self.assertEqual([r['values'][title] for r in detail['rows']], ['Keep', 'Keep'])
        for card_id in (identity, copy_id, 'default'):
            self.action('setChartCard', operation='delete', chartId=card_id)
        self.assertEqual(self.read()['chartView']['mode'], 'data')
        self.assertEqual(self.read()['chartCards'], [])
        self.assertEqual(self.read()['chartOrientation'], 'horizontal')
        self.assertEqual(self.read()['total'], 3)
        with closing(sqlite3.connect(self.directory / 'database.sqlite3')) as connection:
            connection.execute('UPDATE chart_views SET chart=?', (json.dumps({'cards': [], 'orientation': 'unknown'}),))
            connection.commit()
        self.assertEqual(self.read()['chartOrientation'], 'vertical')

    def test_chart_series_checked_rate_distribution_and_numeric_display(self):
        self.save()
        title = self.latest['columns'][0]['id']
        day = self.action('addColumn', columnType='date', name='Date')['addedColumn']
        amount = self.action('addColumn', columnType='number', name='Actual')['addedColumn']
        plan = self.action('addColumn', columnType='number', name='Plan')['addedColumn']
        done = self.action('addColumn', columnType='checkbox', name='Done')['addedColumn']
        self.add_chart_records([
            {title: 'A', day: '2026-11-02', amount: -10, plan: 20, done: True},
            {title: 'B', day: '2026-11-03', amount: 0, plan: 10},
            {title: 'A', day: '2026-11-09', amount: 10, done: False},
            {title: 'B', day: '2026-11-10', plan: 30, done: True},
        ])
        self.action('setNumberFormat', column=amount, format={'unit': 'min', 'decimals': 0, 'percent': False})
        self.assertEqual(next(c['numberFormat'] for c in self.read()['columns'] if c['id'] == amount),
                         {'unit': 'min', 'decimals': 0})
        weekly = {'type': 'column', 'groupBy': day, 'bucket': 'week'}
        split = self.chart({**weekly, 'seriesBy': title, 'stack': True})
        self.assertEqual([g['key'] for g in split['groups']], ['2026-11-02', '2026-11-09'])
        self.assertEqual([s['values'] for s in split['series']],
                         [{'2026-11-02': 1, '2026-11-09': 1}] * 2)
        comparison = {**weekly, 'metric': {'op': 'sum', 'column': amount}, 'compare': plan}
        with self.assertRaises(NotesError):
            self.chart(comparison)
        self.action('setNumberFormat', column=plan, format={'unit': 'min'})
        self.assertEqual([s['values']['2026-11-09'] for s in self.chart(comparison)['series']], [10, 30])
        metric = {'type': 'number', 'metric': {'op': 'checkedRate', 'column': done}}
        self.assertEqual(self.chart(metric)['groups'][0]['value'], 0.5)
        self.assertEqual(self.chart({'type': 'number'}, {'search': 'missing'})['groups'][0]['value'], 0)
        histogram = {'type': 'histogram', 'groupBy': amount, 'bins': 4}
        self.assertEqual([p['value'] for p in self.chart(histogram)['groups']], [1, 0, 1, 1])
        scatter = {'type': 'scatter', 'groupBy': amount, 'metric': {'op': 'value', 'column': plan}}
        points = self.chart(scatter)['groups']
        self.assertEqual([(p['x'], p['value']) for p in points], [(-10, 20), (0, 10)])
        card_id = self.action('setChartCard', operation='add', chart=scatter)['changedChartId']
        detail = self.database.read_chart('Source.md', TABLE, chart_id=card_id, detail={'key': points[0]['key']})
        self.assertEqual(detail['total'], 1)
        self.assertEqual(detail['rows'][0]['values'][title], 'A')


class NoteDatabaseHttpTests(unittest.TestCase):
    def test_pdf_attachment_routes_check_source_version_and_note_authority(self):
        import app
        from feature_profile import FEATURES, LaunchProfile
        from tests.usage_v2_test_support import IsolatedUsage

        with IsolatedUsage() as fixture:
            note = 'Source.md'
            (fixture.notes / note).write_text(FENCE, encoding='utf-8')
            (fixture.notes / 'Other.md').touch()
            database = app.NOTES_STORE.database
            raw = b'%PDF-1.7\nexample\n%%EOF'
            identity = database.import_file(note, 'Lecture.PDF', raw)['attachmentId']
            broken = database.import_file(note, 'Broken.pdf', b'plain text')['attachmentId']
            text = database.import_file(note, 'Example.txt', raw)['attachmentId']
            endpoint = '/api/note-pdf'
            query = {'note': note, 'id': identity, 'source': 'database'}
            url = lambda route, params: route + '?' + urlencode(params)
            status, meta = fixture.request(url(endpoint, query))
            self.assertEqual((status, meta['name']), (200, 'Lecture.PDF'))
            versioned = {**query, 'assetRevision': meta['assetRevision']}
            request = Request(fixture.url + url(endpoint + '/file', versioned), headers={'Range': 'bytes=3-9'})
            with urlopen(request, timeout=10) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'], f'bytes 3-9/{len(raw)}')
                self.assertEqual(response.read(), raw[3:10])
            for params, expected in [
                ({'id': broken}, (400, 'invalid_pdf')),
                ({'id': text}, (400, 'invalid_pdf')),
                ({'note': 'Other.md'}, (404, 'not_found')),
                ({'source': ''}, (400, 'invalid_pdf_source')),
                ({'source': 'other'}, (400, 'invalid_pdf_source')),
                ({'source': 'embed'}, (400, 'invalid_pdf')),
            ]:
                status, result = fixture.request(url(endpoint, {**query, **params}))
                self.assertEqual((status, result['code']), expected)
            annotations = endpoint + '/annotations'
            status, snapshot = fixture.request(url(annotations, {**versioned, 'edit': 1}))
            self.assertEqual(status, 200)
            mark = {'id': str(uuid.uuid4()), 'page': 1, 'kind': 'note', 'color': '#f4b740',
                    'point': [50, 50], 'text': 'Annotation'}
            payload = {**versioned, 'revision': snapshot['revision'], 'pdfHash': snapshot['pdfHash'],
                       'upsert': [mark], 'remove': []}
            self.assertEqual(fixture.request(annotations, {**payload, 'note': 'Other.md'})[0], 404)
            self.assertEqual(fixture.request(annotations, payload)[0], 200)
            target = database.resolve_attachment(note, identity)
            self.assertEqual(target.read_bytes(), raw)
            sidecar = target.with_name('annotations.json')
            self.assertEqual(json.loads(sidecar.read_bytes())['annotations'], [mark])
            target.write_bytes(raw + b'changed')
            self.assertEqual(fixture.request(url(endpoint + '/file', versioned))[1]['code'], 'pdf_changed')
            self.assertEqual(fixture.request(annotations, payload)[1]['code'], 'pdf_changed')
            target.unlink()
            self.assertEqual(fixture.request(url(endpoint, query))[0], 404)
            self.assertTrue(sidecar.exists())
            fixture.server.launch_profile = LaunchProfile({key: key == 'canvas' for key in FEATURES}, restricted=True)
            for route in (endpoint, endpoint + '/file', annotations):
                self.assertEqual(fixture.request(url(route, versioned))[0], 403)

    def test_chart_route_is_read_only_and_notes_owned(self):
        from feature_profile import FEATURES, LaunchProfile
        from tests.usage_v2_test_support import IsolatedUsage

        with IsolatedUsage() as fixture:
            note = 'Source.md'
            (fixture.notes / note).write_text(FENCE, encoding='utf-8')
            endpoint = '/api/note-database/chart'
            payload = {'path': note, 'databaseId': TABLE}
            self.assertFalse(fixture.request(endpoint, payload)[1]['exists'])
            self.assertFalse((fixture.notes / 'Source.assets').exists())
            status, snapshot = fixture.request('/api/note-database/action', {**payload, 'action': {'type': 'create'}})
            self.assertEqual(status, 200)
            status, model = fixture.request(endpoint, payload)
            self.assertEqual((status, model['revision'], model['groups']), (200, snapshot['revision'], []))
            self.assertEqual(model['chart']['groupBy'], snapshot['columns'][0]['id'])
            self.assertEqual(fixture.request(endpoint, {**payload, 'path': '../Source.md'})[0], 403)
            self.assertEqual(fixture.request(endpoint, {**payload, 'chart': []})[1]['code'], 'invalid_chart')
            self.assertEqual(fixture.request(endpoint, {**payload, 'chart': 'x' * (64 * 1024)})[0], 413)
            for enabled in ('notes', 'canvas'):
                profile = LaunchProfile({key: key == enabled for key in FEATURES}, restricted=True)
                fixture.server.launch_profile = profile
                self.assertEqual(fixture.request(endpoint, payload)[0], 200 if enabled == 'notes' else 403)
                for resource in ('note-database-chart.js', 'note-chart-palette.js', 'vendor/echarts/echarts.min.js'):
                    self.assertEqual(profile.resource_allowed(resource), enabled == 'notes')

    def test_query_action_import_external_open_and_disabled_profile(self):
        import app
        from feature_profile import FEATURES, LaunchProfile
        from tests.usage_v2_test_support import IsolatedUsage

        with IsolatedUsage() as fixture:
            note = 'Source.md'
            (fixture.notes / note).write_text(FENCE, encoding='utf-8')
            action = '/api/note-database/action'
            upload = '/api/note-database/attachment/import'
            download = '/api/note-database/attachment/download'
            snapshot = '/api/note-database?' + urlencode({'path': note, 'databaseId': TABLE})
            opener_route = '/api/open-external'
            payload = {'kind': 'note-database-attachment', 'note': note}
            self.assertEqual(fixture.request(snapshot)[1]['exists'], False)
            self.assertEqual(fixture.request(snapshot + '&query=%7B')[0], 400)
            self.assertEqual(fixture.request(action, {'path': note, 'action': []})[0], 400)
            self.assertEqual(fixture.request(upload, {'path': note, 'name': 'test.pdf', 'data': '$!$'})[0], 400)
            self.assertEqual(fixture.request(snapshot)[1]['exists'], False)
            status, created = fixture.request(action, {'path': note, 'databaseId': TABLE, 'action': {'type': 'create'}})
            self.assertEqual((status, created['total']), (200, 0))
            def modify(page, kind, **fields):
                response, result = fixture.request(action, {'path': note, 'databaseId': TABLE,
                    'action': {'type': kind, 'revision': page['revision'], **fields}})
                self.assertEqual(response, 200)
                return result
            raw_markdown = b'# Linked note\r\n'
            (fixture.notes / 'Linked.md').write_bytes(raw_markdown)
            with_column = modify(created, 'addColumn', name='File', columnType='attachment')
            column = with_column['addedColumn']
            with_row = modify(with_column, 'addRow', values={column: {'kind': 'note', 'path': 'Linked.md'}})
            cell = {'path': note, 'databaseId': TABLE, 'row': with_row['addedId'], 'column': column,
                    'value': {'kind': 'note', 'path': 'Linked.md'}}
            with tempfile.TemporaryDirectory() as folder, mock.patch('note_database._downloads_directory', return_value=Path(folder)):
                self.assertEqual(fixture.request(download, cell), (200, {'name': 'Linked.md'}))
                self.assertEqual((Path(folder) / 'Linked.md').read_bytes(), raw_markdown)
                self.assertEqual(fixture.request(download, {**cell, 'value': {'kind': 'note', 'path': note}})[0], 409)
            status, imported = fixture.request(upload, {
                'path': note, 'name': '含 空格.pdf', 'data': base64.b64encode(b'example').decode('ascii'),
            })
            self.assertEqual(status, 200)
            self.assertIsNone(imported['databaseId'])
            status, candidates = fixture.request(action, {'path': note, 'databaseId': TABLE, 'action': {'type': 'searchAttachments', 'query': '.pdf'}})
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
            for route in (snapshot, action, upload, download):
                self.assertEqual(fixture.request(route)[0], 403, route)
            with mock.patch.object(app.os, 'startfile', create=True) as opener:
                self.assertEqual(fixture.request(opener_route, payload)[0], 403)
                opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()

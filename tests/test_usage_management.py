import json
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from unittest import mock

from career_report import CareerReports
from notes_library import NotesStore
from usage_store import ARCHIVED_NOTES, UsageStore
from usage_management import ManagementError, UsageManagement
from tests.usage_v2_test_support import IsolatedUsage


class UsageManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relatum-usage-management-')
        self.root = Path(self.temp.name)
        self.notes = self.root/'notes'
        self.notes.mkdir()
        self.now = int(datetime(2025, 12, 31, 23, 59, 40).timestamp()*1000)
        self.start = self.now
        self.store = UsageStore(self.root/'data'/'usage-v2.sqlite3', clock=lambda: self.now)
        self.store.state()
        self.library = NotesStore(self.notes)
        self.reports = CareerReports(self.root/'data'/'career-report-v2.json', self.store,
            notes=self.notes, data=self.root/'data', canvas_candidates=lambda: [], notes_store=self.library,
            atomic_json=lambda path, data: path.write_text(json.dumps(data), encoding='utf-8'))
        self.manager = UsageManagement(self.store, self.library, self.reports, threading.RLock())

    def tearDown(self):
        self.library.close()
        self.temp.cleanup()

    def interval(self, name, offset=0, length=40000, identifier=None, category='notes'):
        row = {'id': identifier or f'{name}:{offset}:{length}', 'category': category, 'locator': name,
               'name': name, 'start': self.start+offset, 'end': self.start+offset+length}
        self.now = max(self.now, row['end']+1)
        self.store.batch({'intervals': [row]})
        return row

    def deleted(self, name):
        self.store.event('notes', name, name, 'created', fingerprint='secret-body-fingerprint')
        self.store.remove('notes', name)

    def archive(self, ids=None):
        preview = self.manager.preview()
        selected = ids or [row['id'] for row in preview['candidates']]
        return self.manager.archive(preview['token'], selected)

    def wait(self, job):
        for _ in range(200):
            value = self.reports.job(job['id'])
            if value['status'] != 'running':
                return value
            time.sleep(.01)
        self.fail('Report did not finish')

    def test_preserves_unions_hours_events_year_counts_and_content(self):
        (self.notes/'Live.md').write_text('unchanged content', encoding='utf-8')
        (self.notes/'Live.assets').mkdir()
        (self.notes/'Live.assets'/'image.png').write_bytes(b'unchanged attachment')
        self.interval('Secret-A.md')
        self.interval('Secret-B.md', 10000)
        self.interval('Live.md', 5000)
        self.interval('canvases/embed.canvas', 10000, category='embedded')
        self.interval('', 60000, 10000)  # Workspace browsing is not a note's usage.
        self.deleted('Secret-A.md'); self.deleted('Secret-B.md')
        before = self.store.snapshot(note_usage=True)
        totals = {year: self.store.totals(year) for year in (2025, 2026)}
        files = {str(p): p.read_bytes() for p in self.notes.rglob('*') if p.is_file()}
        result = self.archive()
        after = self.store.snapshot(note_usage=True)
        self.assertEqual(result['count'], 2)
        self.assertEqual(after['days'], before['days'])
        self.assertEqual(after['hours'], before['hours'])
        event_counts = lambda snapshot: Counter({key: sum(e['count'] for e in snapshot['events'] if (e['day'],e['category'],e['kind']) == key)
            for key in {(e['day'],e['category'],e['kind']) for e in snapshot['events']}})
        self.assertEqual(event_counts(after), event_counts(before))
        for year in totals:
            self.assertEqual(self.store.totals(year), totals[year])
        self.assertEqual(after['archivedNotes']['count'], 2)
        self.assertEqual(sum(row['total'] for row in before['noteUsageDays']), 50)
        self.assertEqual(sum(row['archived'] for row in after['noteUsageDays']), 50)
        self.assertEqual(sum(row['unarchived'] for row in after['noteUsageDays']), 40)
        self.assertEqual(sum(row['total'] for row in after['noteUsageDays']), 50)
        self.assertEqual(after['noteUsageDays'], [
            {'date': '2025-12-31', 'archived': 20, 'unarchived': 15, 'total': 20},
            {'date': '2026-01-01', 'archived': 30, 'unarchived': 25, 'total': 30}])
        self.assertTrue(any(row['id'] == ARCHIVED_NOTES for row in after['entityDays']))
        self.assertNotIn('Secret-', json.dumps(after))
        with self.store.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM aliases').fetchone()[0], 0)
            self.assertNotIn('Secret-', json.dumps([tuple(row) for row in conn.execute('SELECT * FROM archive_routes')]))
            self.assertNotIn('secret-body-fingerprint', json.dumps([dict(row) for row in conn.execute('SELECT * FROM entities')]))
        self.assertEqual(files, {str(p): p.read_bytes() for p in self.notes.rglob('*') if p.is_file()})

    def test_external_move_missing_is_distinct_from_confirmed_deletion(self):
        self.interval('External.md'); self.interval('Deleted.md'); self.deleted('Deleted.md')
        (self.notes/'Moved.md').write_text('external moved content', encoding='utf-8')
        preview = self.manager.preview()
        kinds = {row['name']: row['kind'] for row in preview['candidates']}
        self.assertEqual(kinds, {'External.md': 'missing', 'Deleted.md': 'deleted'})
        selected = [row['id'] for row in preview['candidates'] if row['kind'] == 'deleted']
        self.manager.archive(preview['token'], selected)
        self.assertTrue(any(row['name'] == 'External.md' for row in self.store.public_entities()))

    def test_restoration_rename_and_preview_identity_changes_abort_entire_transaction(self):
        for name in ('A.md', 'B.md'):
            self.interval(name); self.deleted(name)
        preview = self.manager.preview()
        (self.notes/'B.md').write_text('restored', encoding='utf-8')
        with self.assertRaisesRegex(ManagementError, 'candidates-changed'):
            self.manager.archive(preview['token'], [row['id'] for row in preview['candidates']])
        self.assertEqual(self.manager.overview()['archived'], 0)
        self.assertEqual([row['name'] for row in self.manager.preview()['candidates']], ['A.md'])
        (self.notes/'B.md').unlink()
        self.store.move('notes', 'deleted:unknown', 'unused.md', 'unused')
        preview = self.manager.preview()
        self.store.move('notes', 'B.md', 'Renamed.md', 'Renamed.md')
        with self.assertRaises(ManagementError):
            self.manager.archive(preview['token'], [row['id'] for row in preview['candidates']])

    def test_unreadable_linked_or_absent_library_is_not_missing(self):
        self.interval('Unknown.md')
        with mock.patch('usage_management.os.scandir', side_effect=PermissionError('unreadable')):
            self.assertEqual(self.manager.preview()['candidates'], [])
        with mock.patch('usage_management.os.scandir', side_effect=FileNotFoundError('unavailable')):
            self.assertEqual(self.manager.preview()['candidates'], [])
        self.notes.rmdir()
        self.assertEqual(self.manager.preview()['candidates'], [])
        self.notes.mkdir()

    def test_same_path_creation_detaches_old_identity_without_archiving_live_file(self):
        self.interval('Reused.md'); self.deleted('Reused.md')
        old_id = self.store.public_entities()[0]['id']
        (self.notes/'Reused.md').write_text('new note', encoding='utf-8')
        self.now += 10000
        self.store.event('notes', 'Reused.md', 'Reused.md', 'created', fingerprint='new')
        self.interval('Reused.md', 1000, 500, identifier='old-before-archive')
        preview = self.manager.preview()
        self.assertEqual([row['id'] for row in preview['candidates']], [old_id])
        self.manager.archive(preview['token'], [old_id])
        self.interval('Reused.md', 2000, 500, identifier='old-after-archive')
        self.assertEqual(len(self.store.public_entities()), 1)
        snapshot = self.store.snapshot()
        self.assertEqual(sum(row['seconds'] for row in snapshot['entityDays'] if row['id'] != ARCHIVED_NOTES), 0)
        self.assertEqual((self.notes/'Reused.md').read_text(encoding='utf-8'), 'new note')

    def test_repeat_commit_expiration_and_new_candidates_do_not_expand_selection(self):
        self.interval('A.md'); self.deleted('A.md')
        preview = self.manager.preview()
        self.interval('B.md'); self.deleted('B.md')
        ids = [row['id'] for row in preview['candidates']]
        first = self.manager.archive(preview['token'], ids)
        repeated = self.manager.archive(preview['token'], ids)
        self.assertEqual(repeated['count'], first['count'])
        self.assertTrue(repeated['repeated'])
        self.assertEqual(self.manager.overview()['archived'], 1)
        with self.assertRaises(ManagementError):
            self.manager.archive(preview['token'], ['x'*32])
        new = self.manager.preview(); self.manager._previews[new['token']]['at'] -= 601
        with self.assertRaisesRegex(ManagementError, 'preview-expired'):
            self.manager.archive(new['token'], [row['id'] for row in new['candidates']])

    def test_late_retry_stays_anonymous_and_recreated_path_is_new_identity(self):
        original = self.interval('Secret.md', length=10000)
        self.deleted('Secret.md'); self.now += 50000
        self.archive()
        self.interval('Secret.md', offset=10000, length=5000, identifier='late')
        self.store.batch({'intervals': [original]})
        self.assertFalse(self.store.public_entities())
        self.assertEqual(sum(row['seconds'] for row in self.store.snapshot()['entityDays']), 15)
        self.store.event('notes', 'Secret.md', 'New.md', 'created', fingerprint='new')
        offset = self.now-self.start+1000
        self.interval('Secret.md', offset, 1000, identifier='new')
        self.interval('Secret.md', 15000, 1000, identifier='late-after-new')
        snapshot = self.store.snapshot()
        self.assertEqual(len(snapshot['entities']), 1)
        self.assertEqual(sum(row['seconds'] for row in snapshot['entityDays'] if row['id'] == ARCHIVED_NOTES), 16)
        self.assertEqual(sum(row['seconds'] for row in snapshot['entityDays'] if row['id'] != ARCHIVED_NOTES), 1)

    def test_backup_reads_wal_and_contains_only_usage_and_report(self):
        self.interval('Private.md')
        raw = self.reports.build(); self.reports.atomic_json(self.reports.path, raw)
        with self.manager.backup() as path:
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), {'usage-v2.sqlite3', 'career-report-v2.json', 'README.txt'})
                archive.extract('usage-v2.sqlite3', self.root/'restore')
            restored = UsageStore(self.root/'restore'/'usage-v2.sqlite3', clock=lambda: self.now)
            self.assertEqual(restored.totals(2026), self.store.totals(2026))
            with restored.connection() as conn:
                self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertFalse(path.exists())

    def test_backup_excludes_a_report_published_at_a_different_archive_revision(self):
        self.interval('A.md')
        raw = self.reports.build(); raw['history']['archiveRevision'] = 9
        with mock.patch.object(self.reports, 'read', return_value={'exists': True, 'report': raw}):
            with self.manager.backup() as path, zipfile.ZipFile(path) as archive:
                self.assertNotIn('career-report-v2.json', archive.namelist())

    def test_post_archive_report_schema_errors_are_not_exposed(self):
        self.interval('A.md'); self.deleted('A.md'); self.archive()
        self.reports.path.write_text('{"version":2,"history":null}', encoding='utf-8')
        self.assertFalse(self.reports.read()['exists'])
        job = self.reports.after_archive()
        if job:
            self.wait(job)

    def test_stale_report_invalidated_failed_generation_and_retry(self):
        self.interval('Secret.md'); self.deleted('Secret.md')
        old = self.reports.build(); self.reports.atomic_json(self.reports.path, old)
        self.archive()
        self.assertFalse(self.reports.read()['exists'])
        with mock.patch.object(self.reports, 'build', side_effect=OSError('failure')):
            job = self.reports.after_archive()
            failed = self.wait(job)
            self.assertEqual(failed['status'], 'error')
            self.assertEqual(failed['code'], 'archive-report-pending')
        self.assertFalse(self.reports.path.exists())
        self.assertEqual(self.reports.read()['code'], 'archive-report-pending')
        self.reports.atomic_json(self.reports.path, old)  # a stale writer/restart cannot expose old names
        self.assertFalse(self.reports.read()['exists'])
        self.assertEqual(self.wait(self.reports.generate())['status'], 'complete')
        new = self.reports.read()
        self.assertTrue(new['exists']); self.assertNotIn('Secret.md', json.dumps(new))

    def test_inflight_generation_rebuilds_instead_of_publishing_old_details(self):
        self.interval('Secret.md'); self.deleted('Secret.md')
        ready, release = threading.Event(), threading.Event()
        build = self.reports.build
        calls = []
        def delayed(progress=lambda *args: None):
            result = build(progress); calls.append(result)
            if len(calls) == 1:
                ready.set(); release.wait(3)
            return result
        with mock.patch.object(self.reports, 'build', side_effect=delayed):
            job = self.reports.generate()
            self.assertTrue(ready.wait(3))
            self.archive(); release.set()
            self.assertEqual(self.wait(job)['status'], 'complete')
        self.assertEqual(len(calls), 2)
        self.assertNotIn('Secret.md', json.dumps(self.reports.read()))


class UsageManagementHTTPTests(unittest.TestCase):
    def test_routes_archive_idempotency_and_native_backup_picker_cancel_save(self):
        import app
        with IsolatedUsage() as fixture:
            (fixture.notes/'Live.md').write_text('original', encoding='utf-8')
            fixture.store.event('notes', 'Old.md', 'Old.md', 'created')
            fixture.store.remove('notes', 'Old.md')
            code, preview = fixture.request('/api/usage/archive-preview', {})
            self.assertEqual(code, 200)
            payload = {'token': preview['token'], 'ids': [row['id'] for row in preview['candidates']]}
            self.assertEqual(fixture.request('/api/usage/archive-notes', payload)[0], 200)
            self.assertTrue(fixture.request('/api/usage/archive-notes', payload)[1]['repeated'])
            self.assertEqual(fixture.request('/api/usage/management')[1]['archived'], 1)
            with mock.patch.object(app, 'pick_usage_backup', return_value=None):
                self.assertTrue(fixture.request('/api/usage/backup', {})[1]['cancelled'])
            target = fixture.root/'picked.zip'
            with mock.patch.object(app, 'pick_usage_backup', return_value=str(target)):
                self.assertTrue(fixture.request('/api/usage/backup', {})[1]['ok'])
            with zipfile.ZipFile(target) as archive:
                self.assertIn('usage-v2.sqlite3', archive.namelist())
            with urllib.request.urlopen(fixture.url+'/api/usage/backup') as response:
                self.assertIn('attachment;', response.headers['Content-Disposition'])
                self.assertTrue(response.read().startswith(b'PK'))
            self.assertEqual((fixture.notes/'Live.md').read_text(encoding='utf-8'), 'original')


if __name__ == '__main__':
    unittest.main()

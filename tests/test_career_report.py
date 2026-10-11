"""V2 frozen report boundary; no v1 snapshots or historical content backfill."""
import json
import unittest
from unittest import mock

import app
from tests.usage_v2_test_support import IsolatedUsage


class CareerReportTests(unittest.TestCase):
    def setUp(self):self.context=IsolatedUsage();self.fixture=self.context.__enter__()
    def tearDown(self):self.context.__exit__(None,None,None)

    def test_missing_report_never_scans_inventory_or_legacy_snapshot(self):
        old=self.fixture.data/'career-report.json';old.write_text('{"version":1}',encoding='utf8')
        with mock.patch('career_report.note_inventory',side_effect=AssertionError('read must not scan')):
            status,result=self.fixture.request('/api/career/report')
        self.assertEqual(status,200);self.assertFalse(result['exists'])
        self.assertEqual(result['version'],2);self.assertEqual(old.read_bytes(),b'{"version":1}')

    def test_invalid_new_snapshot_offers_regeneration_without_overwriting(self):
        path=self.fixture.data/'career-report-v2.json';path.write_bytes(b'{"version":2}')
        status,result=self.fixture.request('/api/career/report')
        self.assertEqual(status,200);self.assertFalse(result['exists']);self.assertTrue(result['error'])
        self.assertEqual(path.read_bytes(),b'{"version":2}')

    def test_current_inventory_and_empty_new_history_are_separate(self):
        notes=self.fixture.notes
        (notes/'A.md').write_text('hello [[B]]',encoding='utf8')
        (notes/'B.md').write_text('word',encoding='utf8')
        (self.fixture.canvases/'Canvas.canvas').write_text(json.dumps({'nodes':[],'edges':[],'createdAt':'2000-01-01'}),encoding='utf8')
        before={p:p.read_bytes() for p in (*notes.glob('*.md'),*self.fixture.canvases.glob('*.canvas'))}
        report=app.career_reports().build()
        self.assertEqual(report['inventory']['notes']['count'],2);self.assertEqual(report['inventory']['notes']['linkCount'],1)
        self.assertEqual(report['inventory']['canvas']['count'],1)
        self.assertFalse(report['history']['days']);self.assertFalse(report['history']['events'])
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_failed_source_is_unavailable_and_never_restored(self):
        folder=self.fixture.data/'research-workspace';folder.mkdir()
        primary=folder/'workspace.json';primary.write_bytes(b'{broken')
        (folder/'workspace.backup.json').write_bytes(b'{"researchVersion":3}')
        report=app.career_reports().build()
        self.assertIsNone(report['inventory']['research']['count'])
        self.assertEqual(report['inventory']['research']['status'],'unavailable')
        self.assertEqual(primary.read_bytes(),b'{broken')
        self.assertFalse(list(folder.glob('*.corrupt*')))

    def test_library_inventory_never_uses_repairing_loaders(self):
        recent=self.fixture.data/'recent.json'
        recent.write_bytes(b'{broken recent')
        before=recent.read_bytes()
        (self.fixture.canvases/'Current.canvas').write_text('{"nodes":[],"edges":[]}',encoding='utf8')
        with mock.patch.object(app,'load_recent',side_effect=AssertionError('repairing loader')):
            report=app.career_reports().build()
        self.assertEqual(report['inventory']['canvas']['count'],1)
        self.assertEqual(report['inventory']['canvas']['status'],'partial')
        self.assertEqual(recent.read_bytes(),before)
        self.assertFalse(list(self.fixture.data.glob('*.corrupt*')))

    def test_embedded_directory_failure_does_not_discard_other_sources(self):
        import career_report
        folder=self.fixture.notes/'canvases';folder.mkdir()
        (self.fixture.notes/'Current.md').write_text('current inventory',encoding='utf8')
        scan=career_report.os.scandir
        def blocked(path):
            if path==folder:raise PermissionError('Fixture directory is unreadable')
            return scan(path)
        with mock.patch('career_report.os.scandir',side_effect=blocked):
            report=app.career_reports().build()
        self.assertEqual(report['inventory']['notes']['count'],1)
        self.assertEqual(report['inventory']['embedded']['status'],'unavailable')
        self.assertIsNone(report['inventory']['embedded']['references'])
        self.assertIsNone(report['inventory']['embedded']['count'])
        self.assertEqual(report['inventory']['embedded']['skipped'],1)

    def test_new_snapshot_is_frozen_until_manual_generation(self):
        report=app.career_reports().build();app._atomic_write_json(app.CAREER_REPORT_FILE,report)
        (self.fixture.notes/'Late.md').write_text('new content',encoding='utf8')
        result=self.fixture.request('/api/career/report')[1]
        self.assertEqual(result['report']['inventory']['notes']['count'],0)
        self.assertEqual(app.career_reports().build()['inventory']['notes']['count'],1)

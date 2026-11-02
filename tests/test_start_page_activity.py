"""Workspace projections, policies and validation for the unified collector."""
import unittest

import app
from tests.usage_v2_test_support import IsolatedUsage


class StartPageActivityTests(unittest.TestCase):
    def setUp(self):self.context=IsolatedUsage();self.fixture=self.context.__enter__()
    def tearDown(self):self.context.__exit__(None,None,None)

    def test_notes_research_and_subdivisions_share_real_time_union(self):
        at=self.fixture.store.clock()
        rows=[{'id':category,'category':category,'locator':'','start':at,'end':at+1000} for category in ('notes','embedded','research','study')]
        self.assertEqual(self.fixture.request('/api/usage/batch',{'intervals':rows})[0],200)
        snapshot=app.start_page_activity_snapshot()
        pages=next(iter(snapshot['days'].values()))
        self.assertEqual(set(pages),{'notebook','research','study'})
        self.assertEqual(self.fixture.store.snapshot(at+1000)['days'][0]['seconds'],1)

    def test_invalid_payload_rolls_back_and_excluded_features_refused(self):
        for body in ({'intervals':[None]},{'settings':[None]},{'intervals':[{'id':'x','category':'focus','start':0,'end':1}]}):
            self.assertIn(self.fixture.request('/api/usage/batch',body)[0],(400,403))
        self.assertFalse(self.fixture.store.snapshot()['days'])

    def test_embedded_http_batch_retries_and_deleted_tail(self):
        at = self.fixture.store.clock()
        folder = self.fixture.notes / 'canvases'
        folder.mkdir()
        path = folder / '共享画布.canvas'
        path.write_bytes(b'{"nodes":[],"edges":[]}')
        rows = [{'id': category, 'category': category, 'locator': locator,
                 'start': at, 'end': at + 1000}
                for category, locator in (('notes', 'Example.md'), ('embedded', 'canvases/共享画布.canvas'))]
        self.assertEqual(self.fixture.request('/api/usage/batch', {'intervals': rows})[1]['accepted'], 2)
        self.assertEqual(self.fixture.request('/api/usage/batch', {'intervals': rows})[1]['accepted'], 0)
        self.assertEqual(path.read_bytes(), b'{"nodes":[],"edges":[]}')
        path.unlink()
        tail = {**rows[1], 'id': 'deleted-tail', 'start': at + 1000, 'end': at + 2000}
        self.assertEqual(self.fixture.request('/api/usage/batch', {'intervals': [tail]})[0], 200)
        history = self.fixture.store.snapshot(at + 2000)
        self.assertEqual(history['days'][0]['seconds'], 2)
        self.assertEqual(history['days'][0]['categories']['embedded'], 2)
        self.assertFalse(path.exists(), 'A historical locator must not recreate content')

    def test_embedded_http_path_boundaries_roll_back_mixed_batches(self):
        at = self.fixture.store.clock()
        valid = {'id': 'valid-note', 'category': 'notes', 'locator': 'Example.md', 'start': at, 'end': at + 1000}
        for locator in ('../canvases/a.canvas', 'canvases/../a.canvas', 'canvases/nested/a.canvas',
                        'canvases/a.md', 'canvases/a.assets', 'canvases/CON.canvas',
                        'Canvases/a.canvas', 'C:/canvases/a.canvas', r'canvases\a.canvas'):
            with self.subTest(locator=locator):
                invalid = {**valid, 'id': 'bad-embedded', 'category': 'embedded', 'locator': locator}
                self.assertEqual(self.fixture.request('/api/usage/batch', {'intervals': [valid, invalid]})[0], 400)
                self.assertFalse(self.fixture.store.snapshot()['days'])
        note = {**valid, 'locator': 'canvases/a.canvas'}
        self.assertEqual(self.fixture.request('/api/usage/batch', {'intervals': [note]})[0], 400)

    def test_settings_off_preserves_history_and_legacy_route_retired(self):
        old=self.fixture.data/'start-page-activity.json';old.write_bytes(b'{broken')
        self.assertEqual(self.fixture.request('/api/start-page-activity',{})[0],410)
        at=self.fixture.store.clock()
        body={'settings':[{'category':'research','at':at,'enabled':False}]}
        status,state=self.fixture.request('/api/usage/batch',body)
        self.assertEqual(status,200);self.assertFalse(state['settings']['research'])
        self.assertEqual(old.read_bytes(),b'{broken')

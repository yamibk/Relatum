"""Main-editor projections and operations now use only the v2 journal."""
import json
import unittest
import sqlite3
from unittest import mock
from urllib.parse import quote

import app
from tests.usage_v2_test_support import IsolatedUsage


class CanvasActivityTests(unittest.TestCase):
    def setUp(self):self.context=IsolatedUsage();self.fixture=self.context.__enter__()
    def tearDown(self):self.context.__exit__(None,None,None)

    def test_old_created_dates_do_not_backfill_and_unchanged_save_is_noop(self):
        path=self.fixture.canvases/'Old.canvas'
        raw={'version':2,'createdAt':'2000-01-01','updatedAt':'2001-01-01','nodes':[],'edges':[]}
        path.write_text(json.dumps(raw),encoding='utf8')
        self.fixture.request('/api/load?path='+quote(str(path)))
        self.assertFalse(self.fixture.store.snapshot()['events'])
        status,_=self.fixture.request('/api/save',{'path':str(path),'data':raw})
        self.assertEqual(status,200);self.assertFalse(self.fixture.store.snapshot()['events'])
        changed={**raw,'nodes':[{'id':'a','kind':'card','text':'new','x':0,'y':0}]}
        self.assertEqual(self.fixture.request('/api/save',{'path':str(path),'data':changed})[0],200)
        self.fixture.request('/api/save',{'path':str(path),'data':changed})
        self.assertEqual(len(self.fixture.store.snapshot()['events']),1)

    def test_new_rename_trash_restore_identity_and_time(self):
        status,result=self.fixture.request('/api/new',{})
        self.assertEqual(status,200);path=result['path']
        entity=self.fixture.store.snapshot()['events'][0]['entity']
        now=self.fixture.store.clock()
        self.fixture.store.batch({'intervals':[{'id':'tail','category':'canvas','locator':app._canvas_activity_path_key(path),'name':'new','start':now,'end':now+1000}]})
        status,renamed=self.fixture.request('/api/rename',{'path':path,'newName':'Renamed'})
        self.assertEqual(status,200);path=renamed['path']
        self.assertEqual(self.fixture.store.identity('canvas',app._canvas_activity_path_key(path),'Renamed'),entity)
        status,trashed=self.fixture.request('/api/trash',{'path':path})
        self.assertEqual(status,200)
        self.assertTrue(next(e for e in self.fixture.store.public_entities() if e['id']==entity)['deleted'])
        status,restored=self.fixture.request('/api/restore',{'path':trashed['trashedTo']})
        self.assertEqual(status,200)
        self.assertEqual(self.fixture.store.identity('canvas',app._canvas_activity_path_key(restored['path']),'Renamed'),entity)
        self.assertFalse(next(e for e in self.fixture.store.public_entities() if e['id']==entity)['deleted'])

    def test_retired_collection_route_cannot_read_broken_ledger(self):
        legacy=self.fixture.data/'canvas-activity.json';legacy.write_bytes(b'{broken')
        self.assertEqual(self.fixture.request('/api/canvas-activity',{})[0],410)
        self.assertEqual(legacy.read_bytes(),b'{broken')
        self.assertEqual(app.canvas_activity_snapshot()['version'],2)

    def test_statistics_failure_does_not_break_content_operations(self):
        with mock.patch.object(self.fixture.store,'state',side_effect=sqlite3.DatabaseError('broken')):
            app.initialize_usage()
            self.assertEqual(self.fixture.request('/api/usage/state')[0],503)
        with mock.patch.object(self.fixture.store,'event',side_effect=sqlite3.DatabaseError('broken')), mock.patch.object(self.fixture.store,'entity_totals',side_effect=sqlite3.DatabaseError('broken')):
            status,result=self.fixture.request('/api/new',{})
            self.assertEqual(status,200)
            self.assertTrue(result['canvasActivity']['unavailable'])
            self.assertTrue(app.Path(result['path']).is_file())
        with mock.patch.object(self.fixture.store,'canvas_projection',side_effect=sqlite3.DatabaseError('broken')):
            status,result=self.fixture.request('/api/recent')
            self.assertEqual(status,200);self.assertTrue(result['usageUnavailable'])
            self.assertIsNone(result['files'][0]['canvasActivitySec'])

    def test_external_rename_keeps_authorized_pending_tail(self):
        external=self.fixture.root/'external';external.mkdir();path=external/'A.canvas'
        path.write_text('{"nodes":[],"edges":[]}',encoding='utf8');app.register_recent(path)
        self.assertEqual(self.fixture.request('/api/load?path='+quote(str(path)))[0],200)
        identity=self.fixture.store.identity('canvas',app._canvas_activity_path_key(path),'A')
        self.assertEqual(self.fixture.request('/api/rename',{'path':str(path),'newName':'B'})[0],200)
        self.assertFalse(app.is_authorized(path))
        now=self.fixture.store.clock()
        status,_=self.fixture.request('/api/usage/batch',{'intervals':[{'id':'late-external-tail','category':'canvas','locator':str(path),'start':now,'end':now+1000}]})
        self.assertEqual(status,200)
        self.assertEqual(self.fixture.store.entity_totals(identity)['totalSec'],1)

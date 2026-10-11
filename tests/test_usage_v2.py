import json
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from usage_store import UsageStore
from career_report import CareerReports, note_inventory, research_inventory


class UsageV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = int(datetime(2026, 10, 10, 23, 59, 40).timestamp()*1000)
        self.start = self.now
        self.store = UsageStore(self.root/'data'/'usage-v2.sqlite3', clock=lambda: self.now)
        self.store.state()

    def tearDown(self):
        self.temp.cleanup()

    def test_demo_marker_is_explicit_and_survives_report_regeneration(self):
        self.assertNotIn('demo', self.store.snapshot())
        with self.store.connection(write=True) as conn:
            conn.execute("INSERT INTO meta VALUES('demo','1')")
        self.assertTrue(self.store.snapshot()['demo'])

    def interval(self, category, offset, duration=30000, locator='', identity=None):
        return {'id': identity or f'{category}:{offset}:{locator}', 'category': category,
                'locator': locator, 'name': 'Display name', 'start': self.start+offset,
                'end': self.start+offset+duration}

    def post(self, *rows, settings=None):
        self.now = max(self.now, max((row['end'] for row in rows), default=self.now))
        return self.store.batch({'intervals': list(rows), 'settings': settings or []})

    def test_midnight_and_overlap_union(self):
        self.post(self.interval('notes',0,40000,'a.md'), self.interval('embedded',10000,30000,'canvases/x.canvas'),self.interval('canvas',15000,30000,'main.canvas'))
        snapshot=self.store.snapshot()
        self.assertEqual([d['seconds'] for d in snapshot['days']],[20,25])
        self.assertEqual(sum(h['seconds'] for h in snapshot['hours']),45)
        self.assertEqual(self.store.totals(2026)['totalSec'],45)
        self.assertEqual(sum(r['seconds'] for r in snapshot['entityDays'] if r['category']=='embedded'),30)

    def test_receipts_idempotent_and_transaction_rollback(self):
        row=self.interval('notes',0,30000,'a.md','same')
        self.post(row); self.post(row)
        self.assertEqual(self.store.totals(2026)['totalSec'],30)
        changed={**row,'end':row['end']-1}
        with self.assertRaises(ValueError): self.post(self.interval('tree',0,10000),changed)
        self.assertNotIn('tree',self.store.snapshot()['days'][0]['categories'])

    def test_contiguous_heartbeats_merge(self):
        self.post(self.interval('notes',0,10000,'a.md'),self.interval('notes',10000,10000,'a.md'))
        with self.store.connection() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM spans').fetchone()[0],1)

    def test_project_totals_do_not_scan_other_history(self):
        self.post(self.interval('canvas',0,40000,'a.canvas'),self.interval('canvas',10000,30000,'a.canvas'),
                  self.interval('notes',0,30000,'a.md'))
        identity = self.store.identity('canvas','a.canvas','a')
        with mock.patch.object(self.store,'snapshot',side_effect=AssertionError('full snapshot')):
            self.assertEqual(self.store.entity_totals(identity),{'canvasId':identity,'todaySec':20,'totalSec':40})

    def test_snapshot_reader_does_not_hold_writer_mutex(self):
        completed=threading.Event();row=self.interval('notes',0,1000,'a.md');self.now=row['end']
        def write():self.store.batch({'intervals':[row]});completed.set()
        with self.store.connection() as reader:
            self.assertEqual(reader.execute('SELECT count(*) FROM spans').fetchone()[0],0)
            thread=threading.Thread(target=write);thread.start();wrote=completed.wait(2)
            self.assertEqual(reader.execute('SELECT count(*) FROM spans').fetchone()[0],0)
        thread.join(2);self.assertTrue(wrote,'WAL reader blocked the writer')
        self.assertEqual(self.store.totals(2026)['totalSec'],1)

    def test_disabled_edits_update_noop_baseline(self):
        self.store.event('notes','a.md','a','created',fingerprint='one')
        self.store.batch({'settings':[{'category':'notes','at':self.now,'enabled':False}]})
        self.store.event('notes','a.md','a','modified',fingerprint='two')
        self.now += 1000
        self.store.batch({'settings':[{'category':'notes','at':self.now,'enabled':True}]})
        self.store.event('notes','a.md','a','modified',fingerprint='two')
        self.assertEqual(len(self.store.snapshot()['events']),1)

    def test_policy_clips_intervals_and_preserves_history(self):
        self.now=self.start+40000
        settings=[{'category':'notes','at':self.start+10000,'enabled':False},{'category':'notes','at':self.start+30000,'enabled':True}]
        self.post(self.interval('notes',0,40000,'a.md'),settings=settings)
        self.assertEqual(self.store.totals(2026)['totalSec'],20)
        self.assertEqual(len(self.store.state()['coverage']),11)

    def test_sleep_gap_and_invalid_input_refused(self):
        with self.assertRaises(ValueError):self.post(self.interval('research',0,600000))
        with self.assertRaises(ValueError):self.post(self.interval('focus',0))
        with self.assertRaises(ValueError):self.post(self.interval('diary',0))
        with self.assertRaises(ValueError):self.store.batch({'intervals':[{'id':'x','category':'notes','start':float('nan'),'end':0}]})
        with self.assertRaises(ValueError):self.store.batch({'settings':[None]})

    def test_late_switch_and_newly_available_features(self):
        self.post(self.interval('notes',0,40000,'a.md'))
        self.store.batch({'settings':[{'category':'notes','at':self.start+10000,'enabled':False}]})
        self.assertEqual(self.store.totals(2026)['totalSec'],10)
        second=UsageStore(self.root/'other.sqlite3',enabled=lambda category:category=='notes',clock=lambda:self.now)
        self.assertTrue(second.state()['settings']['research'])
        self.assertFalse(second.state()['available']['research'])
        second.batch({'intervals':[{'id':'retry-after-trim','category':'research','start':self.now,'end':self.now+1000}]})
        self.assertEqual(second.snapshot(self.now+1000)['days'][0]['categories']['research'],1)

    def test_rename_move_delete_late_retry_and_recreated_identity(self):
        self.post(self.interval('notes',0,10000,'a.md'))
        before=self.store.snapshot()['entities'][0]['id']
        self.store.move('notes','a.md','folder/b.md','b.md')
        self.post(self.interval('notes',10000,10000,'a.md'))
        self.store.remove('notes','folder/b.md')
        self.post(self.interval('notes',20000,10000,'folder/b.md'))
        snapshot=self.store.snapshot()
        self.assertEqual(len(snapshot['entities']),1)
        self.assertEqual(snapshot['entities'][0]['id'],before)
        self.assertTrue(snapshot['entities'][0]['deleted'])
        self.store.event('notes','folder/b.md','new.md','created',fingerprint='new')
        self.assertEqual(len(self.store.snapshot()['entities']),2)

    def test_events_noops_and_stable_operation_id(self):
        self.store.event('notes','a.md','a','created',fingerprint='one')
        self.store.event('notes','a.md','a','modified',fingerprint='one')
        self.store.event('notes','a.md','a','modified',fingerprint='two')
        self.store.event('review','1','review','reviewed',event_id='operation')
        self.store.event('review','1','review','reviewed',event_id='operation')
        self.assertEqual(len(self.store.snapshot()['events']),3)

    def test_public_snapshot_no_paths(self):
        self.post(self.interval('canvas',0,30000,str(self.root/'private.canvas')))
        encoded=json.dumps(self.store.snapshot())
        self.assertNotIn(str(self.root).replace('\\','\\\\'),encoded)
        self.assertNotIn('locator',encoded)

    def test_note_parser_scope_markdown_and_shared_references(self):
        notes=self.root/'notes'; notes.mkdir()
        (notes/'A.md').write_text('[B](B.md)\n![shared.canvas|640x360](canvases/shared.canvas)\n```\n[[C]]\n```',encoding='utf-8')
        (notes/'B.md').write_text('[[A]]\n![shared.canvas|640x360](canvases/shared.canvas)',encoding='utf-8')
        (notes/'C.md').write_text('outside',encoding='utf-8')
        custom=notes/'CustomNotebook'/'Other';custom.mkdir(parents=True)
        (custom/'A.md').write_text('[cross](../../A.md)',encoding='utf-8')
        inventory,refs=note_inventory(notes,self.store)
        self.assertEqual(inventory['count'],4)
        self.assertEqual(inventory['linkCount'],1)
        self.assertEqual(len(refs['canvases/shared.canvas']),2)
        self.assertNotIn('outside',json.dumps(inventory))

    def test_research_statistics_never_recover_or_write(self):
        root=self.root/'data'/'research-workspace';root.mkdir(parents=True)
        source=root/'workspace.json';source.write_bytes(b'{broken')
        before={p.name:p.read_bytes() for p in root.iterdir()}
        result=research_inventory(source,self.store)
        self.assertEqual(result['status'],'unavailable');self.assertIsNone(result['count'])
        self.assertEqual(before,{p.name:p.read_bytes() for p in root.iterdir()})

    def reports(self, writer=None):
        def atomic(path, content): path.write_text(json.dumps(content),encoding='utf-8')
        return CareerReports(self.root/'data'/'career-report-v2.json',self.store,notes=self.root/'notes',data=self.root/'data',canvas_candidates=lambda:[],atomic_json=writer or atomic)

    def test_legacy_files_forbidden_and_current_sources_unchanged(self):
        data=self.root/'data'
        for name in ('canvas-activity.json','start-page-activity.json','career-report.json','focus.json'):(data/name).write_bytes(b'{invalid legacy')
        notes=self.root/'notes';notes.mkdir();(notes/'A.md').write_text('hello world',encoding='utf-8')
        before={p:p.read_bytes() for p in self.root.rglob('*') if p.is_file() and p.suffix in ('.json','.md')}
        read=Path.read_text
        def guarded(path,*a,**k):
            if path.name in ('canvas-activity.json','start-page-activity.json','career-report.json','focus.json'):raise AssertionError('Legacy source read')
            return read(path,*a,**k)
        with mock.patch.object(Path,'read_text',guarded): report=self.reports().build()
        self.assertEqual(report['inventory']['notes']['count'],1)
        self.assertFalse(report['history']['days'])
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_async_job_reuse_and_failed_generation_keeps_snapshot(self):
        import threading
        entered=threading.Event();release=threading.Event()
        def fail(path,content):entered.set();release.wait(2);raise OSError('disk full')
        reports=self.reports(fail);reports.path.write_text('{"version":2,"marker":"keep"}',encoding='utf-8')
        before=reports.path.read_bytes();job=reports.generate();self.assertTrue(entered.wait(2))
        self.assertEqual(reports.generate()['id'],job['id']);release.set()
        for _ in range(100):
            if reports.job(job['id'])['status']!='running':break
            time.sleep(.01)
        self.assertEqual(reports.job(job['id'])['status'],'error')
        self.assertEqual(reports.path.read_bytes(),before)


if __name__=='__main__':unittest.main()

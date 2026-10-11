"""Isolated HTTP/operation fixtures; never point a test at user content."""
import json
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import app
from notes_library import NotesStore


class IsolatedUsage:
    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relatum-usage-v2-')
        self.root = Path(self.temp.name)
        self.data, self.notes, self.canvases = (self.root/n for n in ('data','notes','canvases'))
        for folder in (self.data,self.notes,self.canvases): folder.mkdir()
        overrides = {'ROOT':self.root,'DATA':self.data,'NOTES':self.notes,'CANVASES':self.canvases,
                     'TRASH':self.canvases/'回收站','NOTES_STORE':NotesStore(self.notes)}
        for key, filename in (('RECENT_FILE','recent.json'),('RECENT_BACKUP_FILE','recent.backup.json'),
            ('STUDY_FILE','study.json'),('TREE_PAGE_FILE','tree-page.json'),('NOTES_FILE','notes.json'),
            ('DAILY_FILE','daily.json'),('FOCUS_FILE','focus.json'),('REVIEW_DB_FILE','review.db'),
            ('CAREER_REPORT_FILE','career-report-v2.json'),('USAGE_FILE','usage-v2.sqlite3')):
            overrides[key] = self.data/filename
        overrides['RESEARCH_WORKSPACE_DIR'] = self.data/'research-workspace'
        self.patches=[mock.patch.object(app,k,v) for k,v in overrides.items()]
        for patch in self.patches:patch.start()
        self.store=app.usage_store();self.store.state()
        self.server=app.CanvasServer(('127.0.0.1',0),app.Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_address[1])
        return self

    def request(self, route, body=None):
        request=urllib.request.Request(self.url+route,data=json.dumps(body).encode() if body is not None else None,
                                       headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=10) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as error:return error.code,json.load(error)

    def __exit__(self, *args):
        self.server.shutdown();self.server.server_close();self.thread.join()
        for patch in reversed(self.patches):patch.stop()
        self.temp.cleanup()

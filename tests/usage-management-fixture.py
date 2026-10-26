"""Small synthetic library for the usage management browser regression."""
import hashlib
import json
import os
import time
from pathlib import Path

from career_report import CareerReports
from notes_library import NotesStore
from usage_store import UsageStore

root = Path(os.environ['RELATUM_DATA_ROOT']).resolve()
if root == Path(__file__).resolve().parents[1] or any(root.iterdir()):
    raise RuntimeError('Use a new, empty temporary data root')
notes = root/'notes'; notes.mkdir()
(notes/'Live.md').write_text('# Live\n\nOriginal synthetic note.\n', encoding='utf-8')
(notes/'Live.assets').mkdir(); (notes/'Live.assets'/'sample.bin').write_bytes(b'original attachment')
now = int(time.time()*1000)-3600000
store = UsageStore(root/'data'/'usage-v2.sqlite3', clock=lambda: now)
store.state()
for i in range(85):
    name = f'Deleted-{i:03}.md'
    store.event('notes', name, name, 'created', fingerprint=f'fixture-{i}')
    store.batch({'intervals': [{'id': name, 'category': 'notes', 'locator': name, 'name': name, 'start': now, 'end': now+1000}]})
    store.remove('notes', name)
    now += 2000
for i in range(2):
    name = f'External-{i}.md'
    store.batch({'intervals': [{'id': name, 'category': 'notes', 'locator': name, 'name': name, 'start': now, 'end': now+1000}]})
    now += 2000
store.batch({'settings': [{'category': 'notes', 'at': now, 'enabled': False}]})
library = NotesStore(notes)
reports = CareerReports(root/'data'/'career-report-v2.json', store, notes=notes, data=root/'data',
    canvas_candidates=lambda: [], notes_store=library,
    atomic_json=lambda path, raw: path.write_text(json.dumps(raw), encoding='utf-8'))
reports.atomic_json(reports.path, reports.build()); library.close()
files = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in notes.rglob('*') if path.is_file()}
print(json.dumps({'files': files, 'seconds': 87, 'deleted': 85}))

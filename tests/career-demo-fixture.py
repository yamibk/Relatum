"""Create a persistent, isolated dataset for manual Career acceptance.

Set RELATUM_DATA_ROOT to a new, empty directory. No real content is copied.
"""
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from note_canvases import validate as validate_embedded
from research_store import empty_research_document, normalize_research_document


def write(path, value):
    app._atomic_write_json(path, value)


def research_node(identifier, kind, config=None):
    return {'id': identifier, 'type': kind, 'label': identifier, 'x': 0, 'y': 0,
            'width': 176, 'height': 72, 'config': config or {}, 'statePolicy': 'reset'}


def fingerprint():
    return {str(p.relative_to(app.ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for directory in (app.NOTES, app.CANVASES, app.RESEARCH_WORKSPACE_DIR)
            for p in directory.rglob('*') if p.is_file()}


def main():
    if not os.environ.get('RELATUM_DATA_ROOT') or app.ROOT == app.SOURCE_ROOT:
        raise SystemExit('Use a new, isolated RELATUM_DATA_ROOT')
    if app.ROOT.exists() and any(app.ROOT.iterdir()):
        raise SystemExit('The acceptance directory must be empty; nothing was changed')
    app.ensure_dirs()
    names = []
    books = [('知识库', 96, 0), ('CustomNotebook/项目研究', 48, 1),
             ('CustomNotebook/阅读摘录', 36, 2), ('CustomNotebook/零散想法', 20, 3)]
    for book, count, group in books:
        directory = app.NOTES / book
        directory.mkdir(parents=True, exist_ok=True)
        local = [f'{("长期项目：从问题拆解到知识整理的完整过程" if i == 0 else "笔记")}-{i+1:03d}.md' for i in range(count)]
        for i, name in enumerate(local):
            # Strongly skewed lengths, a dense cluster, loose chains and isolates.
            length = [8, 35, 90, 180, 360, 1200][(i + group) % 6]
            if i == 0:
                length = 2400
            body = f'# {Path(name).stem}\n\n' + '整理问题、记录观察，再核对结果。\n' * length
            targets = ([j for j in range(18) if j != i and (j+i) % 3 == 0]
                       if group == 0 and i < 18 else [(i+1) % count] if i % 4 else [])
            body += '\n'.join(f'[[{Path(local[j]).stem}]]' for j in targets)
            if i % 7 == 0:
                body += f'\n[相关笔记]({quote(local[(i+5)%count])})\n'
            if i % 9 == 0:
                body += f'\n![关系示意.canvas|640x360]({"../" if "/" not in book else "../../"}canvases/内嵌-{i%5+1}.canvas)\n'
            (directory / name).write_text(body, encoding='utf-8', newline='')
            names.append(f'{book}/{name}')
    embedded = app.NOTES / 'canvases'
    embedded.mkdir(exist_ok=True)
    for i in range(1, 6):
        payload = app.empty_canvas_payload()
        payload['nodes'] = [{'id': f'n{j}', 'kind': 'text', 'text': f'思路 {j+1}',
                             'x': j % 5 * 210, 'y': j // 5 * 110, 'width': 160, 'height': 64}
                            for j in range(i * 6)]
        payload['edges'] = [{'id': f'e{j}', 'from': f'n{j}', 'to': f'n{j+1}'} for j in range(i*6-1)]
        write(embedded / f'内嵌-{i}.canvas', validate_embedded(payload))
    canvases = []
    for i in range(32):
        name = f'画布-{i+1:02d}.canvas'
        payload = app.empty_canvas_payload()
        count = [2, 5, 12, 28, 60, 120][i % 6]
        payload['nodes'] = [{'id': f'n{j}', 'kind': ('index', 'card', 'sticky', 'code')[j % 4],
                             'text': f'验收节点 {j+1}', 'x': j % 8 * 240, 'y': j // 8 * 130,
                             'width': 200, 'height': 90} for j in range(count)]
        payload['edges'] = [{'id': f'e{j}', 'from': f'n{j}', 'to': f'n{j+1}'} for j in range(count-1)]
        write(app.CANVASES / name, payload)
        canvases.append(name)
    research = empty_research_document()
    definitions = []
    for i in range(6):
        nodes = [research_node('op', 'math', {'operation': 'add'})]
        if i:
            nodes.append(research_node('reuse', 'subcircuit', {'definitionId': f'def-{i-1}', 'revision': 1}))
        definitions.append({'id': f'def-{i}', 'name': f'子电路 {i+1}', 'latestRevision': 1,
                            'revisions': [{'revision': 1, 'ports': [], 'nodes': nodes, 'edges': []}]})
    research['subcircuits'] = definitions
    research['pages'] = []
    for i in range(16):
        nodes = [research_node(f'c{j}', 'constant', {'value': {'type': 'number', 'value': j}})
                 for j in range(1 + (i % 5) * 4)]
        nodes.append(research_node('monitor', 'monitor'))
        for j in range(1 + i % 3):
            nodes.append(research_node(f'reuse{j}', 'subcircuit', {'definitionId': f'def-{(i+j)%6}', 'revision': 1}))
        edges = [{'id': 'wire', 'kind': 'wire', 'from': {'nodeId': 'c0', 'portId': 'out'},
                  'to': {'nodeId': 'monitor', 'portId': 'in'}},
                 {'id': 'relation', 'kind': 'relation', 'fromNodeId': 'c0', 'toNodeId': 'monitor'}]
        research['pages'].append({'id': f'research-page-{i}', 'title': f'研究页面 {i+1}',
                                 'nodes': nodes, 'edges': edges, 'view': {'x': 0, 'y': 0, 'scale': 1}, 'simulation': {'speed': 1}})
    research['activePageId'] = 'research-page-0'
    app.RESEARCH_WORKSPACE_DIR.mkdir(exist_ok=True)
    write(app.RESEARCH_WORKSPACE_DIR / 'workspace.json', normalize_research_document(research))

    study = app.load_study()
    study['tasks'] = [app._study_task({'title': f'学习任务 {i+1}'}) for i in range(24)]
    app.save_study(study)
    tree = app.load_tree_page()
    for i in range(12):
        app.apply_tree_page_command(tree, {'command': 'create-task', 'treeId': tree['activeTreeId'],
                                          'title': f'树状任务 {i+1}', 'primaryLink': {'from': None, 'type': 'contains', 'side': 'right'}})
    app.save_tree_page(tree)
    quick = app.load_notes()
    quick['notes'] = [{'id': f'demo-quick-{i}', 'text': f'待整理的想法 {i+1}', 'x': i%4*260,
                       'y': i//4*180, 'color': 'yellow'} for i in range(18)]
    app.save_notes(quick)
    for name in ('阅读', '复习', '整理笔记', '研究'):
        app.daily_create({'name': name, 'targetMinutes': 25})

    now = int(datetime.now().timestamp() * 1000)
    first = datetime.combine(datetime.now().date() - timedelta(days=364), datetime.min.time())
    start = int(first.timestamp() * 1000)
    store = app.usage_store()
    store.clock = lambda: start
    store.state()
    store.clock = lambda: now
    with store.connection(write=True) as conn:
        conn.execute("INSERT INTO meta VALUES('demo','1')")
    rows, inputs, events = [], 0, 0

    def session(category, locator, name, at, seconds):
        nonlocal rows, inputs
        finish = min(at + int(seconds * 1000), now)
        while at < finish:
            end = min(at + 30000, finish)
            rows.append({'id': f'demo-{inputs}', 'category': category, 'locator': locator,
                         'name': name, 'start': at, 'end': end})
            inputs += 1
            at = end
            if len(rows) == 512:
                store.batch({'intervals': rows})
                rows = []

    for day in range(364):
        # Several complete gaps plus isolated quiet days between strong peaks.
        if 42 <= day <= 55 or 139 <= day <= 157 or 241 <= day <= 252 or day % 17 == 0:
            continue
        wave = (1 + math.sin(day / 11)) * .5
        minutes = (8 + 150 * wave ** 2 + (65 if day % 29 < 4 else 0)) * (0.4 if day % 7 >= 5 else 1)
        at = int((first + timedelta(days=day, hours=(8, 10, 14, 19, 23)[day % 5], minutes=45)).timestamp()*1000)
        ni = (day * 7) % len(names)
        session('notes', names[ni], Path(names[ni]).stem, at, minutes * 60)
        if day % 3 == 0:
            session('embedded', f'canvases/内嵌-{day%5+1}.canvas', f'内嵌-{day%5+1}', at+120000, min(minutes*20, 1200))
        ci = (day * 3) % len(canvases)
        locator = os.path.normcase(str((app.CANVASES / canvases[ci]).resolve()))
        session('canvas', locator, Path(canvases[ci]).stem, at+int(minutes*60000)+300000, (3+45*(1-wave)**2)*60)
        if day % 4 != 0:
            session('research', f'research-page-{day%16}', f'研究页面 {day%16+1}', at+5*3600000, (2+30*wave)*60)
        category = ('study', 'tree', 'quicknotes', 'review')[day % 4]
        session(category, '', '', at+7*3600000, (1+12*wave)*60)
        for category, kind, count in [('checkin', 'checkin', 1), ('review', 'reviewed', 1+day%18),
                                      ('study', 'archived', 1+day%3), ('notes', 'modified', 1)]:
            if kind == 'archived' and day % 9:
                continue
            when = min(at, now)
            store.clock = lambda when=when: when
            store.event(category, names[ni] if category == 'notes' else '',
                        Path(names[ni]).stem if category == 'notes' else category,
                        kind, count=count, event_id=f'demo-event-{events}')
            events += 1
        store.clock = lambda: now
    if rows:
        store.batch({'intervals': rows})
    # Include a real collection-off interval, separate from empty collected days.
    store.batch({'settings': [{'category': 'research', 'enabled': False, 'at': start+140*86400000},
                               {'category': 'research', 'enabled': True, 'at': start+156*86400000}]})
    before = fingerprint()
    report = app.career_reports().build()
    assert before == fingerprint(), 'Generation changed content'
    assert report['history']['demo'] is True
    assert report['inventory']['notes']['count'] == 200
    assert report['inventory']['embedded']['count'] == 5
    assert report['inventory']['embedded']['missingReferences'] == 0
    assert report['inventory']['research']['definitions'] == 6
    assert all(s['status'] in ('available', 'empty') for s in report['sources'])
    encoded = json.dumps(report, ensure_ascii=False)
    assert str(app.ROOT) not in encoded and 'locator' not in encoded
    write(app.DATA / 'career-report-v2.json', report)
    write(app.DATA / 'desktop-sessions' / 'full' / 'preferences.json',
          {'version': 1, 'values': {'canvas:startWorkspace:v1': 'career', 'canvas:toolbarLanguage': 'zh-CN'}})
    manifest = {'demo': True, 'root': str(app.ROOT), 'notes': 200, 'canvases': 32, 'embedded': 5,
                'research': 16, 'inputs': inputs, 'events': events, 'days': len(report['history']['days']),
                'since': first.isoformat(), 'generatedAt': report['generatedAt'], 'content': before}
    write(app.ROOT / 'demo-manifest.json', manifest)
    print(json.dumps({k: v for k, v in manifest.items() if k != 'content'}, ensure_ascii=False))


if __name__ == '__main__':
    main()

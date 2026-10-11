"""Disposable acceptance fixture; refuses to use the repository's data root."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app
from research_store import empty_research_document


def fingerprint(root):
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in (root/'notes',root/'canvases',root/'data'/'research-workspace') if folder.exists()
            for p in folder.rglob('*') if p.is_file()}


def main():
    if not os.environ.get('RELATUM_DATA_ROOT') or app.ROOT == app.SOURCE_ROOT:
        raise SystemExit('An isolated RELATUM_DATA_ROOT is required')
    app.ensure_dirs()
    root=app.ROOT
    large='--large' in sys.argv
    note_count,canvas_count,page_count,input_count=(5000,500,200,100000) if large else (90,12,5,1000)
    def note_name(i):
        return f'Note {i:04d}.md' if i else 'Note 0000 — 一篇用于检查长名称、精确提示与窄窗布局的笔记 Long title with spaces and unicode.md'
    for i in range(note_count):
        text=('# 知识 '+str(i)+'\n\n笔记与关系 knowledge and relationships.\n'*(100 if not i else 12)+
              f'[[{Path(note_name((i+1)%note_count)).stem}]]\n[Related]({quote(note_name((i+7)%note_count))})\n'+
              ('![shared.canvas|640x360](canvases/shared.canvas)\n' if i%10==0 else ''))
        (app.NOTES/note_name(i)).write_text(text,encoding='utf-8',newline='')
    embedded=app.NOTES/'canvases';embedded.mkdir(exist_ok=True)
    base=app.empty_canvas_payload();base['nodes']=[{'id':f'n{i}','kind':'card','x':i*30,'y':i%5*40,'w':160,'h':80,'text':'A thought'} for i in range(25)]
    base['edges']=[{'id':f'e{i}','from':f'n{i}','to':f'n{i+1}'} for i in range(24)]
    (embedded/'shared.canvas').write_text(json.dumps(base),encoding='utf-8')
    for i in range(canvas_count):(app.CANVASES/f'Canvas {i:03d}.canvas').write_text(json.dumps(base),encoding='utf-8')
    research=empty_research_document();template=research['pages'][0]
    research['pages']=[{**template,'id':f'research-page-{i}','title':f'Research page {i}'} for i in range(page_count)];research['activePageId']='research-page-0'
    app.RESEARCH_WORKSPACE_DIR.mkdir(exist_ok=True)
    (app.RESEARCH_WORKSPACE_DIR/'workspace.json').write_text(json.dumps(research),encoding='utf-8')
    for name in ('canvas-activity.json','start-page-activity.json','career-report.json'):(app.DATA/name).write_bytes(b'{broken legacy')
    now=int(time.time()*1000);start=now-30*86400000
    store=app.usage_store();store.clock=lambda:start;store.state();store.clock=lambda:now
    rows=[];began=time.perf_counter()
    for i in range(input_count):
        category=('notes','canvas','research','study','tree','quicknotes','review','embedded')[i%8]
        locator=note_name(i%note_count) if category=='notes' else os.path.normcase(str((app.CANVASES/f'Canvas {i%canvas_count:03d}.canvas').resolve())) if category=='canvas' else f'research-page-{i%page_count}' if category=='research' else 'canvases/shared.canvas' if category=='embedded' else ''
        rows.append({'id':f'fixture-{i}','category':category,'locator':locator,'name':Path(locator).name if locator else category,'start':start+1000+i*20000,'end':start+31000+i*20000})
        if len(rows)==512:store.batch({'intervals':rows});rows=[]
    if rows:store.batch({'intervals':rows})
    usage_ms=round((time.perf_counter()-began)*1000)
    for i in range(1200 if large else 80):
        category=('notes','canvas','study','review','checkin')[i%5]
        locator=note_name(i%note_count) if category=='notes' else os.path.normcase(str((app.CANVASES/f'Canvas {i%canvas_count:03d}.canvas').resolve())) if category=='canvas' else ''
        at=start+(i%30)*86400000+i*317;store.clock=lambda:at
        store.event(category,locator,Path(locator).name if locator else category,
                    ('created','modified','archived','reviewed','checkin')[i%5],event_id=f'fixture-event-{i}')
    store.clock=lambda:now
    before=fingerprint(root);began=time.perf_counter();report=app.career_reports().build();generation_ms=round((time.perf_counter()-began)*1000)
    assert before==fingerprint(root),'Source content changed during generation'
    app._atomic_write_json(app.DATA/'career-report-v2.json',report)
    encoded=json.dumps(report,ensure_ascii=False)
    assert 'locator' not in encoded and str(root) not in encoded
    assert report['inventory']['notes']['count']==note_count
    assert report['inventory']['canvas']['count']==canvas_count
    assert report['inventory']['research']['count']==page_count
    assert len(report['inventory']['notes']['network']['nodes'])<=600
    (root/'fixture-manifest.json').write_text(json.dumps({'content':before,'usageMs':usage_ms,'generationMs':generation_ms}),encoding='utf-8')
    print(json.dumps({'root':str(root),'notes':note_count,'canvases':canvas_count,'research':page_count,'inputs':input_count,'usageMs':usage_ms,'generationMs':generation_ms,'reportBytes':(app.DATA/'career-report-v2.json').stat().st_size}))


if __name__=='__main__':main()

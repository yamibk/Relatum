'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const html = `<!doctype html><html><head><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}</style></head><body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="editor"></div></div></main><script src="markdown-table.js"></script><script src="markdown.js"></script><script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script><script src="note-media-frame.js"></script><script src="note-live-editor.js"></script><script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('editor'),{value:'plain text',notePath:'resources.md'});</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
    const file = path.resolve(repo, '.' + pathname);
    if (!pathname.startsWith('/assets/') || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    let content = fs.readFileSync(file);
    if (pathname === '/assets/note-live-editor.js') content = content.toString().replace('window.RelatumNoteLiveEditor = { create, renderMarkdown };', 'window.RelatumNoteLiveEditor = { create, renderMarkdown }; window.__calloutResourceTest = {createBlockField, scanBlockSpecs, focusEffect, calloutFoldEffect};');
    res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.RELATUM_EDGE_PATH ? {executablePath:process.env.RELATUM_EDGE_PATH} : {})});
    const page = await browser.newPage({viewport:{width:1000,height:800}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => window.editor);
    const cold = await page.evaluate(() => !!window.MathJax?.startup?.document);
    assert.equal(cold, false, 'plain notes do not load MathJax');
    const retained = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      await page.evaluate(cycle => editor.setDocument({value:'> [!note]\n> Inline $x_'+cycle+'^2$ and $y_'+cycle+'^2$.\n\nend',notePath:'cycle-'+cycle+'.md'}),cycle);
      await page.waitForFunction(() => document.querySelectorAll('.note-live-inline-math mjx-container').length === 2);
      await page.evaluate(() => editor.setSourceMode(true)); await settle();
      retained.push(await page.evaluate(() => Array.from(MathJax.startup.document.math).filter(item => !item.start.node?.isConnected).length));
      await page.evaluate(() => editor.setSourceMode(false));
      await page.waitForFunction(() => document.querySelectorAll('.note-live-inline-math mjx-container').length === 2);
      await page.evaluate(() => editor.setDocument({value:'plain text',notePath:'plain.md'})); await settle();
    }
    const mathAfterRemoval = await page.evaluate(() => Array.from(MathJax.startup.document.math).length);
    const richRemoval = [];
    for (const [kind,source] of [['display','$$x^2$$\n\nend'],['derive','```derive\nx^2 || explanation\n```\n\nend']]) {
      await page.evaluate(source=>editor.setDocument({value:source,notePath:'rich.md'}),source);
      await page.waitForFunction(()=>document.querySelector('.note-live-rich-block mjx-container'));
      await page.evaluate(()=>editor.setDocument({value:'plain text',notePath:'plain.md'})); await settle();
      richRemoval.push({kind,records:await page.evaluate(()=>Array.from(MathJax.startup.document.math).length)});
    }
    const delayedRemoval = [];
    for (const [kind,source] of [['inline','Inline $z^2$.\n\nend'],['display','$$z^2$$\n\nend'],['derive','```derive\nz^2\n```\n\nend']]) {
      await page.evaluate(source=>{
        const original=MathJax.typesetPromise;
        MathJax.typesetPromise=nodes=>new Promise((resolve,reject)=>{
          window.__releaseMath=()=>{MathJax.typesetPromise=original;return original.call(MathJax,nodes).then(resolve,reject);};
        });
        editor.setDocument({value:source,notePath:'delayed.md'});
      },source);
      await page.waitForFunction(()=>typeof window.__releaseMath==='function');
      await page.evaluate(async()=>{
        editor.setDocument({value:'plain text',notePath:'plain.md'});
        await __releaseMath(); delete window.__releaseMath;
      }); await settle();
      delayedRemoval.push({kind,records:await page.evaluate(()=>Array.from(MathJax.startup.document.math).length)});
    }
    await page.evaluate(()=>{
      window.__ordinaryMathClears=0;
      window.__originalMathClear=MathJax.typesetClear;
      MathJax.typesetClear=(...args)=>{__ordinaryMathClears++;return __originalMathClear.apply(MathJax,args);};
      editor.setDocument({value:'---\n\nordinary text',notePath:'ordinary.md'});
    }); await settle();
    await page.evaluate(()=>editor.setDocument({value:'plain text',notePath:'plain.md'})); await settle();
    const ordinaryMathClears=await page.evaluate(()=>{MathJax.typesetClear=__originalMathClear;delete window.__originalMathClear;return __ordinaryMathClears;});
    const projection = await page.evaluate(() => {
      const {EditorState,markdown,markdownLanguage} = RelatumCodeMirror;
      const {createBlockField,scanBlockSpecs,focusEffect,calloutFoldEffect} = __calloutResourceTest;
      const report = [];
      const nested='> [!note]+ Outer\n> $$x^2$$\n>\n> > [!tip]- Inner\n> > $$y^2$$\n>\n> $$z^2$$\n\n> [!blue]\n> $$w^2$$\n\nend';
      const nestedCoordinator={folds:new Map(),records:[]};
      const nestedField=createBlockField(()=> 'nested.md',{},nestedCoordinator,{pending:()=>false});
      let nestedState=EditorState.create({doc:nested,selection:{anchor:nested.length},extensions:[markdown({base:markdownLanguage}),nestedField]});
      const callouts=nestedState.field(nestedField).specs.filter(spec=>spec.kind==='callout' && MarkdownMini.noteBlock(spec.type,spec.title,spec.suffix).foldable);
      if (callouts.length!==2) throw new Error('nested fixture must contain two foldable native Callouts');
      for (let mask=0;mask<4;mask++) {
        nestedState=nestedState.update({effects:callouts.map((spec,i)=>calloutFoldEffect.of({id:spec.id,collapsed:!!(mask & (1<<i))}))}).state;
        const value=nestedState.field(nestedField),actual=[];
        const expected=value.specs.filter(spec=>spec.kind!=='callout' && !value.specs.some(parent=>parent.kind==='callout' && parent.from<spec.from && parent.to>=spec.to && nestedCoordinator.folds.get(parent.id))).map(spec=>spec.id).sort();
        value.decorations.between(0,nested.length,(from,to,decoration)=>{if(decoration.spec.widget) actual.push(decoration.spec.blockId);});
        if (JSON.stringify(actual.sort())!==JSON.stringify(expected)) throw new Error('nested projection mismatch for fold mask '+mask);
      }
      for (const count of [250,1000,2000]) {
        const source = Array.from({length:count},(_,i)=>'> [!tip]+ Block '+i+'\n> body\n> $$x^2$$').join('\n\n');
        const coordinator = {folds:new Map(),records:[]};
        const field = createBlockField(()=> 'stress.md',{},coordinator,{pending:()=>false});
        let state = EditorState.create({doc:source,extensions:[markdown({base:markdownLanguage}),field]});
        const value = state.field(field);
        // Use a fully parsed synthetic field so every sample has the same
        // known block count, independent of the editor's incremental parser.
        value.specs = scanBlockSpecs(state,0,source.length,[],markdownLanguage.parser.parse(source));
        value.byId = new Map(value.specs.map(spec=>[spec.id,spec]));
        let checks = 0;
        value.specs.forEach(spec=>{const kind=spec.kind;Object.defineProperty(spec,'kind',{get(){checks++;return kind;}});});
        const times = [];
        for (let i=0;i<5;i++) {
          const start=performance.now();
          state=state.update({selection:{anchor:source.length-i},effects:focusEffect.of(true)}).state;
          times.push(performance.now()-start);
        }
        report.push({count,specs:value.specs.length,checks,medianMs:times.sort((a,b)=>a-b)[2]});
      }
      return report;
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
    const before = await metrics();
    await page.waitForTimeout(1500);
    const after = await metrics();
    await cdp.detach();
    const report = {baseline,retained,mathAfterRemoval,richRemoval,delayedRemoval,ordinaryMathClears,projection,idleScriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,heapBytes:after.JSHeapUsedSize,errors};
    console.log(JSON.stringify(report));
    if (!baseline) {
      assert.equal(mathAfterRemoval,0,'removed inline formulae leave no MathJax records');
      assert(retained.every(count=>count===0),'source mode clears detached inline formulae');
      [...richRemoval,...delayedRemoval].forEach(sample=>assert.equal(sample.records,0,JSON.stringify(sample)));
      assert.equal(ordinaryMathClears,0,'ordinary blocks do not enter MathJax cleanup');
      projection.forEach(sample=>assert(sample.checks<sample.specs*100,JSON.stringify(sample)));
    }
    assert.deepEqual(errors,[]);
  } finally { if (browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});

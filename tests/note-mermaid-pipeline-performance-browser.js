'use strict';
// Alternating baseline/current assets, including each version's engine and worker.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.RELATUM_MERMAID_PIPELINE_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-pipeline-'));
fs.mkdirSync(output, { recursive: true });
const reference = process.env.RELATUM_NOTE_MERMAID_BASELINE_REF || '85106e9';
const rounds = Number(process.env.RELATUM_MERMAID_PIPELINE_ROUNDS) || 3;
const baseline = new Map(['note-mermaid.js', 'note-mermaid-worker.js', 'note-mermaid.css', 'vendor/pele/pele.global.js', 'styles.css', 'markdown.js']
  .map(name => [name, execFileSync('git', ['show', reference + ':assets/' + name], { cwd: repo, maxBuffer: 4 * 1024 * 1024, windowsHide: true })]));
const single = '```mermaid\nflowchart LR\nA[中文开始]-->B{有效?}\nB-->|是|C[完成]\nB-->|否|D[重试]\n```';
const hundred = Array.from({ length: 100 }, (_, i) => '## 图表' + i + '\n\n' + single + '\n\n正文').join('\n\n');
const hundredDistinct = Array.from({ length: 100 }, (_, i) => '## 图表' + i + '\n\n'
  + single.replace('中文开始', '中文开始 ' + i) + '\n\n正文').join('\n\n');
const scenarios = ['cold-single', 'warm-reopen', 'long-100', 'distinct-100', 'dense-500'];
const dense = '```mermaid\nflowchart LR\n' + Array.from({ length: 500 }, (_, i) =>
  Array.from({ length: Math.min(8, 499 - i) }, (_, k) => `A${i}-->A${i + k + 1}`).join('\n')).join('\n') + '\n```';
const probe = `\n{ const original = pele; pele = {...original,
 parse(...args){if(typeof document==='undefined')self.postMessage({probe:'parse'});else window.metrics.parses++;return original.parse(...args)},
 render(...args){if(typeof document==='undefined')self.postMessage({probe:'render'});else window.metrics.renders++;return original.render(...args)} }; }`;
const html = mode => `<!doctype html><meta charset="utf-8"><base href="/${mode}/assets/"><link rel="stylesheet" href="styles.css">
<style>body{display:block;margin:0;font-family:"Relatum Open Sans","Microsoft YaHei","Microsoft YaHei UI","Segoe UI","Noto Sans SC",Helvetica,Arial,sans-serif;--note-font-mono:"Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",monospace}#host{width:900px;max-width:95vw;margin:32px auto 0;height:calc(100vh - 36px);overflow:auto}.node-text{width:100%;font-family:inherit}#typing{position:fixed;top:0;left:20px;width:150px;height:22px}</style>
<input id="typing" aria-label="Input latency probe"><div id="host"><article class="node-text" id="content"></article></div>
<script>window.metrics={parses:0,renders:0,frames:0,created:0,terminated:0,tasks:[],phases:[]};
window.phase=name=>metrics.phases.push({name,t:performance.now()-window.started});
new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){if(node.nodeType!==1)continue;const svg=node.matches('.note-mermaid-stage > svg')?node:node.querySelector('.note-mermaid-stage > svg');if(svg){svg.getBoundingClientRect();window.lastSvgAt=performance.now()-started;window.firstSvgAt??=lastSvgAt}}}).observe(content,{childList:true,subtree:true});
new PerformanceObserver(list=>metrics.tasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
const frame=requestAnimationFrame;window.requestAnimationFrame=cb=>{metrics.frames++;return frame.call(window,cb)};
const Native=Worker;window.Worker=class extends Native{constructor(...args){super(...args);metrics.created++;phase('worker-created');this.addEventListener('message',e=>{if(e.data.ready)phase('worker-ready');if(e.data.probe==='fonts')phase('worker-fonts');if(e.data.probe==='parse'){metrics.parses++;phase('parse')}if(e.data.probe==='render'){metrics.renders++;phase('render')}})}terminate(){metrics.terminated++;return super.terminate()}};
</script><script src="markdown.js"></script><script src="note-mermaid.js"></script>
<script>window.show=source=>{window.controller?.destroy();content.innerHTML=MarkdownMini.render(source);host.scrollTop=0;window.started=performance.now();window.firstSvgAt=undefined;window.lastSvgAt=undefined;metrics.phases=[];window.startCounts={parses:metrics.parses,renders:metrics.renders};window.controller=RelatumNoteMermaid.attach(content,{mode:'live',isCurrent:()=>true})};</script>`;

async function workerHeap(browser, page) {
  const worker = page.workers().find(item => item.url().includes('note-mermaid-worker.js'));
  if (!worker) return 0;
  const root = await browser.newBrowserCDPSession(); let sessionId, next = 1;
  try {
    const target = (await root.send('Target.getTargets')).targetInfos.find(item => item.type === 'worker' && item.url === worker.url());
    if (!target) return null;
    ({ sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
    const send = (method) => new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { root.off('Target.receivedMessageFromTarget', handler); reject(new Error('Worker heap probe timed out')); }, 3000);
      const handler = event => {
        if (event.sessionId !== sessionId) return;
        const response = JSON.parse(event.message); if (response.id !== id) return;
        clearTimeout(timer); root.off('Target.receivedMessageFromTarget', handler);
        response.error ? reject(new Error(response.error.message)) : resolve(response.result);
      };
      root.on('Target.receivedMessageFromTarget', handler);
      root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(reject);
    });
    await send('HeapProfiler.collectGarbage'); return (await send('Runtime.getHeapUsage')).usedSize;
  } finally { if (sessionId) await root.send('Target.detachFromTarget', { sessionId }).catch(() => {}); await root.detach(); }
}

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html(url.searchParams.get('mode'))); return; }
    const baselineRequest = url.pathname.startsWith('/baseline/');
    const pathname = url.pathname.replace(/^\/(?:baseline|current)\//, '/');
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    const file = path.resolve(repo, '.' + pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    let data = baselineRequest && baseline.get(pathname.slice('/assets/'.length)) || fs.readFileSync(file);
    if (file.endsWith('pele.global.js')) data = data.toString('utf8') + probe;
    if (file.endsWith('note-mermaid.js')) data = data.toString('utf8').replace('  window.RelatumNoteMermaid =',
      '  window.cacheProbe=()=>({items:cache.size,bytes:cacheBytes});\n  window.RelatumNoteMermaid =')
      .replace('await prepareFonts(fontFamily +', "phase('fonts-start'); await prepareFonts(fontFamily +")
      .replace('const now = Date.now();', "phase('fonts-ready'); const now = Date.now();")
      .replace('const sanitized = await safeSvg', "phase('sanitize-start'); const sanitized = await safeSvg")
      .replace('await options.whenSettled?.(); if (!valid() || requestedRevision', "phase('sanitize-end'); await options.whenSettled?.(); if (!valid() || requestedRevision");
    if (file.endsWith('note-mermaid-worker.js')) data = data.toString('utf8').replace('await prepareFonts(options);', "await prepareFonts(options); self.postMessage({probe:'fonts'});");
    res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const records = [], errors = [];
  try {
    for (let round = 0; round < rounds; round++) for (const mode of round % 2 ? ['baseline', 'current'] : ['current', 'baseline']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      await page.goto('http://127.0.0.1:' + server.address().port + '/?mode=' + mode);
      for (const scenario of scenarios) {
        const source = scenario === 'long-100' ? hundred : scenario === 'distinct-100' ? hundredDistinct : scenario === 'dense-500' ? dense : single;
        await page.locator('#typing').focus();
        const before = await cdp.send('Performance.getMetrics');
        await page.evaluate(source => window.show(source), source);
        let inputDone = false;
        const input = (async () => {
          const delays = [];
          while (!inputDone || delays.length < 8) {
            const start = performance.now(); await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: 'a' });
            delays.push(performance.now() - start); await pause(10);
          }
          return delays;
        })();
        let firstViewportMs, completedMs;
        try {
          await page.locator('#content .mermaid-diagram svg').first().waitFor();
          firstViewportMs = await page.evaluate(() => firstSvgAt);
          if (scenario === 'long-100' || scenario === 'distinct-100') for (let index = 0; index < 100; index++) {
            const block = page.locator('#content .mermaid-diagram').nth(index);
            await block.evaluate(el => el.scrollIntoView({ block: 'center' })); await block.locator('svg').waitFor();
          }
          completedMs = await page.evaluate(() => lastSvgAt);
        } finally { inputDone = true; await input; }
        const inputLatencyMs = await input;
        const after = await cdp.send('Performance.getMetrics'); await cdp.send('HeapProfiler.collectGarbage');
        const heaps = await cdp.send('Performance.getMetrics');
        const get = (metrics, name) => metrics.metrics.find(item => item.name === name)?.value;
        const result = await page.evaluate(() => ({ parses: metrics.parses - startCounts.parses, renders: metrics.renders - startCounts.renders,
          longTasks: metrics.tasks.filter(item => item.start >= started), nodes: document.querySelectorAll('*').length,
          cache: window.cacheProbe?.(), phases: metrics.phases,
          fontFamily: getComputedStyle(content.querySelector('.note-mermaid')).fontFamily,
          fontFamilyMono: getComputedStyle(content.querySelector('.note-mermaid')).getPropertyValue('--note-font-mono').trim() }));
        if (mode === 'current') { assert(result.cache.items <= 32 && result.cache.bytes <= 8 * 1024 * 1024); if (scenario === 'warm-reopen') assert.equal(result.renders, 0); }
        const row = { round, mode, scenario, firstViewportMs, completedMs, inputLatencyMs,
          taskMs: (get(after, 'TaskDuration') - get(before, 'TaskDuration')) * 1000,
          scriptMs: (get(after, 'ScriptDuration') - get(before, 'ScriptDuration')) * 1000,
          layoutMs: (get(after, 'LayoutDuration') - get(before, 'LayoutDuration')) * 1000,
          mainHeapBytesAfterGC: get(heaps, 'JSHeapUsedSize'), workerHeapBytesAfterGC: await workerHeap(browser, page), ...result };
        records.push(row); console.log(JSON.stringify({ round, mode, scenario, completedMs, parses: row.parses, renders: row.renders,
          longestTaskMs: Math.max(0, ...row.longTasks.map(item => item.duration)) }));
      }
      await pause(150); const frames = await page.evaluate(() => metrics.frames); await pause(300);
      assert.equal(await page.evaluate(() => metrics.frames), frames, 'idle has no animation loop');
      await page.evaluate(() => { controller.destroy(); content.replaceChildren(); }); await pause(50);
      assert.equal(page.workers().filter(item => item.url().includes('note-mermaid-worker.js')).length, 0, 'last owner releases its worker');
      await cdp.send('HeapProfiler.collectGarbage');
      records.at(-1).releasedMainHeapBytesAfterGC = (await cdp.send('Performance.getMetrics')).metrics.find(item => item.name === 'JSHeapUsedSize').value;
      await context.close();
    }
    assert.deepEqual(errors, []);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
    const summary = [];
    for (const mode of ['baseline', 'current']) for (const scenario of scenarios) {
      const rows = records.filter(row => row.mode === mode && row.scenario === scenario);
      summary.push({ mode, scenario, firstViewportMs: median(rows.map(row => row.firstViewportMs)), completedMs: median(rows.map(row => row.completedMs)),
        inputP95Ms: p95(rows.flatMap(row => row.inputLatencyMs)), inputMaxMs: Math.max(...rows.flatMap(row => row.inputLatencyMs)),
        inputSamples: rows.reduce((sum, row) => sum + row.inputLatencyMs.length, 0),
        longestTaskMs: Math.max(0, ...rows.flatMap(row => row.longTasks.map(item => item.duration))),
        mainHeapBytesAfterGC: median(rows.map(row => row.mainHeapBytesAfterGC)), workerHeapBytesAfterGC: median(rows.map(row => row.workerHeapBytesAfterGC)),
        parses: median(rows.map(row => row.parses)), renders: median(rows.map(row => row.renders)) });
    }
    const report = { reference, rounds, method: 'Alternating complete baseline/current adapter, worker, engine and CSS assets with actual note font stacks; CDP input continues throughout rendering with at least 8 events per scenario. 100 repeated and 100 distinct flowcharts; dense DAG has 500 nodes and 3964 edges. Includes parsing, SVG sanitation/insertion and layout. Main/worker GC heaps are JS heaps, not process/GPU memory.', summary, records, errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, summary }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

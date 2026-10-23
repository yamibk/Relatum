'use strict';
// Same fixtures, Edge process and view path for Pele and the existing Mermaid adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
const output = process.env.RELATUM_MERMAID_PERFORMANCE || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-mermaid-performance-'));
fs.mkdirSync(output, { recursive: true });
const single = '```mermaid\nflowchart LR\n A[中文开始] --> B{数据有效?}\n B -->|是| C[完成]\n B -->|否| D[重试]\n```';
const long = Array.from({ length: 100 }, (_, index) => '## 图表 ' + index + '\n\n' + single + '\n\n普通正文。').join('\n\n');
const html = engine => `<!doctype html><html><meta charset="utf-8"><base href="/assets/"><link rel="stylesheet" href="styles.css">
<style>body{margin:0}#host{width:900px;max-width:95vw;margin:auto;height:95vh;overflow:auto}.node-text{width:100%}</style>
<body><div id="host"><article class="node-text" id="content"></article></div><script>
window.tasks=[];new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
window.frames=0;const frame=requestAnimationFrame;window.requestAnimationFrame=callback=>{window.frames++;return frame.call(window,callback)};
</script><script src="markdown.js"></script><script src="${engine === 'pele' ? 'note-mermaid.js' : 'mermaid-renderer.js'}"></script><script>
window.show=source=>{window.controller?.destroy();content.innerHTML=MarkdownMini.render(source);host.scrollTop=0;window.started=performance.now();
 ${engine === 'pele' ? "window.controller=RelatumNoteMermaid.attach(content,{mode:'live',isCurrent:()=>true});" : 'MermaidRenderer.renderAll(content);'} };
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html(url.searchParams.get('engine'))); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  const records = [], errors = [];
  try {
    for (let round = 0; round < 3; round++) {
      for (const engine of round % 2 ? ['mermaid', 'pele'] : ['pele', 'mermaid']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        const session = await context.newCDPSession(page); await session.send('Performance.enable');
        const coldStart = performance.now();
        await page.goto('http://127.0.0.1:' + server.address().port + '/?engine=' + engine);
        for (const scenario of ['cold-single', 'warm-reopen', 'long-100']) {
          const source = scenario === 'long-100' ? long : single;
          const before = await session.send('Performance.getMetrics');
          await page.evaluate(source => { window.tasks = []; window.show(source); }, source);
          await page.locator('#content .mermaid-diagram svg').first().waitFor();
          const firstViewportMs = await page.evaluate(() => performance.now() - window.started);
          if (scenario === 'long-100') {
            for (let index = 0; index < 100; index++) {
              const block = page.locator('#content .mermaid-diagram').nth(index);
              await block.evaluate(el => el.scrollIntoView({ block: 'center' }));
              await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
              await block.locator('svg').first().waitFor();
            }
          }
          const completedMs = await page.evaluate(() => performance.now() - window.started);
          const after = await session.send('Performance.getMetrics');
          await session.send('HeapProfiler.collectGarbage');
          const memory = await session.send('Performance.getMetrics');
          const get = (metrics, name) => metrics.metrics.find(metric => metric.name === name)?.value;
          const payload = await page.evaluate(() => ({ longTasks: tasks.filter(task => task.start >= window.started), nodes: document.querySelectorAll('*').length }));
          records.push({ round, engine, scenario, firstViewportMs, completedMs,
            ...(scenario === 'cold-single' ? { navigationToDiagramMs: performance.now() - coldStart } : {}),
            scriptMs: (get(after, 'ScriptDuration') - get(before, 'ScriptDuration')) * 1000,
            taskMs: (get(after, 'TaskDuration') - get(before, 'TaskDuration')) * 1000,
            layoutMs: (get(after, 'LayoutDuration') - get(before, 'LayoutDuration')) * 1000,
            heapBytesAfterGC: get(memory, 'JSHeapUsedSize'), ...payload });
        }
        await page.waitForTimeout(200); const startFrames = await page.evaluate(() => frames);
        await page.waitForTimeout(400); assert.equal(await page.evaluate(() => frames), startFrames, engine + ': idle has no animation loop');
        await page.evaluate(() => { window.controller?.destroy(); content.replaceChildren(); });
        await session.send('HeapProfiler.collectGarbage');
        records.at(-1).releasedHeapBytesAfterGC = (await session.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = [];
    for (const engine of ['pele', 'mermaid']) for (const scenario of ['cold-single', 'warm-reopen', 'long-100']) {
      const rows = records.filter(row => row.engine === engine && row.scenario === scenario);
      summary.push({ engine, scenario, firstViewportMs: median(rows.map(row => row.firstViewportMs)),
        completedMs: median(rows.map(row => row.completedMs)), scriptMs: median(rows.map(row => row.scriptMs)),
        taskMs: median(rows.map(row => row.taskMs)), layoutMs: median(rows.map(row => row.layoutMs)), heapBytesAfterGC: median(rows.map(row => row.heapBytesAfterGC)),
        longTaskCount: median(rows.map(row => row.longTasks.length)), longTaskMaxMs: Math.max(0, ...rows.flatMap(row => row.longTasks.map(task => task.duration))) });
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ method: '3 alternating rounds, identical Chinese flowchart, 100 sequential viewport visits, adapter + SVG insertion + layout; diagram surface only, not full desktop startup', records, summary }, null, 2));
    console.log(JSON.stringify({ output, summary }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Pixel-geometry equivalence uses the real pinned engine in both realms.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/vendor/pele/pele.global.js"></script>'); return; }
    const file = path.resolve(repo, '.' + url.pathname);
    if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    let data = fs.readFileSync(file);
    if (file.endsWith('note-mermaid-worker.js')) data = data.toString('utf8')
      .replace("importScripts('vendor/pele/pele.global.js');", `importScripts('vendor/pele/pele.global.js');
        let parses=0,renders=0;const original=pele;pele={...original,parse(...a){parses++;return original.parse(...a)},render(...a){renders++;return original.render(...a)}};`)
      .replace('remember(source, entry);', "remember(source, entry); self.postMessage({probe:true,parses,renders,items:cache.size,bytes});");
    res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
  try {
    const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(async () => {
      const families = [getComputedStyle(document.body).fontFamily, '"Relatum Open Sans", "Noto Sans SC", sans-serif'];
      for (const family of ['Relatum Open Sans', 'Noto Sans SC']) for (const style of ['normal 400', 'normal 700', 'italic 400', 'italic 700']) {
        await document.fonts.load(style + ' 16px "' + family + '"', 'Aa汉字');
      }
      await document.fonts.ready; pele.forgetTextWidths();
      const samples = [
        'flowchart LR\n A[中文 **开始**]-->B{有效?}\n B-->|是|C[Done *italic*]\n B-->|否|D[Retry]',
        'sequenceDiagram\n participant A as 学生\n participant B as 老师\n A->>B: 请问 hello\n B-->>A: 回答',
        'classDiagram\n class Student {\n +String name\n +study()\n }\n Student --> Course',
        'stateDiagram-v2\n [*] --> Ready\n Ready --> Running: 开始\n Running --> [*]',
        'erDiagram\n STUDENT ||--o{ COURSE : studies\n STUDENT {\n string name\n }',
        'gantt\n title 学习进度\n dateFormat YYYY-MM-DD\n section 第一阶段\n 练习 :a1, 2026-10-01, 3d',
        'pie showData\n title 每日时间分配\n "学习":8\n "睡眠":8\n "娱乐":3\n "运动":2\n "其他":3',
        'mindmap\n root((学习))\n  数学\n  编程',
      ];
      const worker = new Worker('/assets/note-mermaid-worker.js');
      let next = 0, probe;
      const pending = new Map();
      worker.addEventListener('message', event => {
        const data = event.data;
        if (data.probe) { probe = data; return; }
        if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
      });
      const send = (source, options, layoutKey, fontRevision = 0) => new Promise(resolve => {
        const id = ++next; pending.set(id, resolve);
        worker.postMessage({ id, documentId: 'fixture', blockId: 'block-' + id, version: id, source, options, layoutKey, fontRevision });
      });
      let cases = 0;
      try {
        for (const fontFamily of families) for (const maxWidth of [330, 790]) for (const fontSize of [16, 21.6]) for (const source of samples) {
          const options = { fontFamily, fontFamilyMono: 'Consolas, monospace', maxWidth, fontSize, now: 1792713600000 };
          const expected = pele.render(pele.parse(source, { limit: 65536, maxEdges: 5000 }), { ...options, limit: 65536,
            outputLimit: 4000000, maxEdges: 5000, autoDirection: false, responsive: true, links: false, images: false, idPrefix: 'relatum-note-pele-template' });
          const actual = await send(source, options, JSON.stringify(options));
          if (actual.error || actual.result.svg !== expected.svg) {
            let at = 0; while (at < expected.svg.length && actual.result?.svg[at] === expected.svg[at]) at++;
            throw new Error('Worker geometry differs: ' + JSON.stringify({ options, source, error: actual.error, at,
              expected: expected.svg.slice(Math.max(0, at - 30), at + 180), actual: actual.result?.svg.slice(Math.max(0, at - 30), at + 180),
              width: [expected.width, actual.result?.width], height: [expected.height, actual.result?.height] }));
          }
          cases++;
        }
        const options = { fontFamily: families[0], fontFamilyMono: 'monospace', maxWidth: 790, fontSize: 16, now: 1792713600000 };
        const source = 'flowchart TD\nA[缓存]-->B';
        await send(source, options, 'a'); const first = { ...probe };
        await send(source, options, 'a'); const hit = { ...probe };
        if (hit.parses !== first.parses || hit.renders !== first.renders) throw new Error('Unchanged layout was recomputed');
        await send(source, { ...options, maxWidth: 330 }, 'b');
        if (probe.parses !== first.parses || probe.renders !== first.renders + 1) throw new Error('Resize did not reuse the parsed model');
        await send(source, options, 'c', 1);
        if (probe.parses !== first.parses || probe.renders !== first.renders + 2) throw new Error('Font change did not invalidate layout only');
        for (let index = 0; index < 45; index++) await send('flowchart TD\n A[独立图表' + index + ']-->B', options, 'evict-' + index);
        if (probe.items !== 32 || probe.bytes > 8 * 1024 * 1024) throw new Error('Worker cache exceeds its budget');
        const invalid = await send('flowchart TD\n A[', options, 'invalid');
        if (invalid.error?.code !== 'syntax') throw new Error('Worker did not return a plain syntax error');
        const limit = await send('flowchart TD\n' + 'A'.repeat(65537), options, 'limit');
        if (limit.error?.code !== 'limit') throw new Error('Worker did not preserve source limits');
        return { cases, cache: probe, sourceLimits: true, errorProtocol: true };
      } finally { worker.terminate(); }
    });
    assert.equal(result.cases, 64); console.log('Mermaid worker geometry/cache: ok; ' + JSON.stringify(result));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Renderer-only DOM/layout comparison. No note files or runtime dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), performanceRun = process.argv.includes('--performance');
const baseline = process.env.RELATUM_CANVAS_LAYOUT_BASELINE || 'fafc085';
const previous = execFileSync('git', ['show', baseline + ':assets/note-canvas/engine.js'], { cwd: repo, encoding: 'utf8', windowsHide: true });
const assets = new Set(['styles.css', 'note-canvas/canvas.css', 'note-canvas-style.js', 'note-canvas/geometry.js', 'note-canvas/engine.js']);
const html = variant => '<!doctype html><html><head><link rel="stylesheet" href="/assets/styles.css"><link rel="stylesheet" href="/assets/note-canvas/canvas.css"></head><body class="start-page"><div id="host" class="note-canvas-frame" style="width:640px;height:360px"></div><script src="/assets/note-canvas-style.js"></script><script src="/assets/note-canvas/geometry.js"></script><script src="/' + variant + '/engine.js"></script></body></html>';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html(url.searchParams.get('variant') || 'current')); }
  else if (url.pathname === '/baseline/engine.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(previous); }
  else {
    const asset = url.pathname === '/current/engine.js' ? 'note-canvas/engine.js' : url.pathname.slice('/assets/'.length);
    if (!assets.has(asset)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(fs.readFileSync(path.join(repo, 'assets', asset)));
  }
});

async function sample(browser, variant, count, shapes) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/?variant=' + variant);
    await page.waitForFunction(() => window.RelatumNoteCanvasEngine);
    const result = await page.evaluate(async ({ count, shapes }) => {
      await document.fonts.ready;
      const catalog = RelatumNoteCanvasStyle.shapes.map(shape => shape[0]);
      const nodes = Array.from({ length: count }, (_, i) => ({ id: 'n' + i, kind: 'index', x: i % 50 * 200, y: Math.floor(i / 50) * 110,
        width: shapes ? 157.3 : 160, height: shapes ? 48.6 : 48, text: shapes && i % 2 ? '长文字 mixed text '.repeat(14) : '节点 ' + i,
        ...(shapes ? { shape: catalog[Math.floor(i / 2) % catalog.length], fontSize: 17, radius: 9.5 } : {}) }));
      const edges = Array.from({ length: count - 1 }, (_, i) => ({ id: 'e' + i, from: 'n' + i, to: 'n' + (i + 1), curve: 'straight', text: '' }));
      const session = { data: { nodes, edges }, nodes: new Map(nodes.map(node => [node.id, node])),
        edges: new Map(edges.map(edge => [edge.id, { edge }])), adjacent: new Map(nodes.map(node => [node.id, new Set()])), listeners: new Set(), owner: null };
      edges.forEach(edge => { session.adjacent.get(edge.from).add(edge.id); session.adjacent.get(edge.to).add(edge.id); });
      let sets = 0, unchanged = 0;
      const setter = SVGElement.prototype.setAttribute;
      SVGElement.prototype.setAttribute = function (name, value) {
        if (name === 'd' || name === 'viewBox') { sets++; if (this.getAttribute(name) === String(value)) unchanged++; }
        return setter.call(this, name, value);
      };
      const start = performance.now();
      const engine = RelatumNoteCanvasEngine.create({ host: document.querySelector('#host'), session, readOnly: true });
      const createMs = performance.now() - start;
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await frames();
      const snapshot = () => [...document.querySelectorAll('[data-canvas-node]')].map(node => ({
        width: node.offsetWidth, height: node.offsetHeight, text: node.querySelector('.note-canvas-text').textContent,
        viewBox: node.querySelector('svg').getAttribute('viewBox'), path: node.querySelector('.note-canvas-fill').getAttribute('d'),
        cap: node.querySelector('.note-canvas-cylinder-cap')?.getAttribute('d') || '',
      }));
      const geometry = shapes ? snapshot() : null, stats = engine.stats();
      if (shapes) {
        nodes[1].text = '缩短'; nodes[3].width += 73; nodes[3].radius += 8;
        for (const listener of session.listeners) listener({ nodes: ['n1', 'n3'], nodeGeometry: true });
        await frames();
      }
      const updated = shapes ? snapshot() : null;
      SVGElement.prototype.setAttribute = setter; engine.destroy();
      return { count, createMs, sets, unchanged, stats, geometry, updated, destroyed: engine.stats().destroyed, listeners: session.listeners.size };
    }, { count, shapes });
    assert.deepEqual(errors, [], 'no renderer errors');
    assert.equal(result.stats.nodes, count); assert.equal(result.stats.edges, count - 1);
    assert(result.destroyed); assert.equal(result.listeners, 0, 'destroy releases the session subscription');
    return result;
  } finally { await page.close(); }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const before = await sample(browser, 'baseline', 24, true), after = await sample(browser, 'current', 24, true);
    assert.deepEqual(after.geometry, before.geometry, 'all 12 shapes keep fractional dimensions, auto height and outlines');
    assert.deepEqual(after.updated, before.updated, 'text shortening, width and radius changes still update geometry');
    const rows = [];
    for (const count of performanceRun ? [500, 1500] : [1500]) {
      for (let round = 0; round < (performanceRun ? 3 : 1); round++) {
        for (const variant of performanceRun ? round % 2 ? ['current', 'baseline'] : ['baseline', 'current'] : ['current']) {
          const result = await sample(browser, variant, count, false);
          if (variant === 'current') assert.equal(result.unchanged, 0, 'unchanged SVG geometry is never written');
          rows.push({ variant, round, count, createMs: result.createMs, sets: result.sets, unchanged: result.unchanged });
          console.log(JSON.stringify(rows.at(-1)));
        }
      }
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const comparison = performanceRun ? [500, 1500].map(count => {
      const before = median(rows.filter(row => row.count === count && row.variant === 'baseline').map(row => row.createMs));
      const after = median(rows.filter(row => row.count === count && row.variant === 'current').map(row => row.createMs));
      return { count, before, after, improvement: 1 - after / before };
    }) : [];
    const report = { baseline, browser: browser.version(), geometry: '12 shapes and updates identical', rows, comparison };
    if (process.env.RELATUM_CANVAS_LAYOUT_REPORT) fs.writeFileSync(process.env.RELATUM_CANVAS_LAYOUT_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: 'note canvas layout: ok', comparison }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });

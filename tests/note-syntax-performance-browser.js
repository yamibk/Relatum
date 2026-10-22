'use strict';
// Static assets and synthetic documents only. Timings and instrumented work
// counts are separate runs; reports belong to the caller or a temporary folder.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), baselineRef = process.env.RELATUM_NOTE_SYNTAX_BASELINE || 'c22006b';
const output = process.env.RELATUM_NOTE_SYNTAX_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-syntax-'));
fs.mkdirSync(output, { recursive: true });
const changed = ['markdown.js', 'note-live-editor.js'];
const baseline = new Map(changed.map(name => [name, execFileSync('git', ['show', baselineRef + ':assets/' + name], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })]));
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-live-editor.js'];
const html = variant => '<!doctype html><meta charset="utf-8"><base href="/' + variant + '/assets/">'
  + '<link rel="stylesheet" href="styles.css"><style>body{margin:0}.note-document-pane{height:100vh;display:flex;flex-direction:column}.note-document-body{--note-inline-title-space:24px}</style>'
  + '<body class="start-page" data-start-theme="light"><main class="note-document-pane"><div class="note-document-body"><div class="note-live-editor-host" id="host"></div></div></main>'
  + scripts.map(name => '<script src="' + name + '"></script>').join('')
  + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"sample.md"});</script>';
function fixture(size, kind) {
  // Four MiB also covers long lines, keeping the old quadratic traversal's
  // node count bounded. The 1 MiB fixture reproduces the dense-paragraph stall.
  const width = size === 4 * 1024 * 1024 ? 4000 : 72;
  const head = kind === 'toc' ? '[TOC]\n\n# Heading title\n\n' : '';
  const text = kind === 'math-reference' ? 'Paragraph [reference][r] with $a+b$ and $c+d$ formulas. ' : 'Ordinary paragraph with words and spaces to read. ';
  const line = text + 'letters and spaces '.repeat(Math.ceil(Math.max(0, width - text.length) / 19)).slice(0, Math.max(0, width - text.length)) + '\n\n';
  return head + line.repeat(Math.ceil(size / line.length)).slice(0, size) + (kind === 'math-reference' ? '\n[r]: https://example.com\n\n[^n]: Footnote\n\nReference [^n].\n' : '');
}
const median = values => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), parts = decodeURIComponent(url.pathname).split('/');
    const variant = parts[1];
    if (parts.length === 2 && ['baseline', 'current'].includes(variant)) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(variant)); return; }
    const name = parts.slice(3).join('/'), file = path.resolve(repo, 'assets', name);
    if (parts[2] !== 'assets' || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
    res.end(variant === 'baseline' && baseline.has(name) ? baseline.get(name) : fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const report = { baselineRef, output, samples: [], summary: [], errors: [] };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    for (let round = 0; round < 3; round++) {
      for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.on('pageerror', error => report.errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant);
        await page.evaluate(() => document.fonts.ready);
        for (const size of [4096, 128 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
          for (const kind of ['plain', 'toc', 'math-reference']) {
            const value = fixture(size, kind);
            const setupMs = await page.evaluate(value => { const t = performance.now(); editor.setDocument({ value, notePath: 'sample.md', anchor: 12, head: 12 }); return performance.now() - t; }, value);
            await page.waitForTimeout(100);
            const result = await page.evaluate(({ kind, size }) => {
              const count = kind !== 'plain' && size >= 128 * 1024 ? 3 : 30;
              const input = kind === 'math-reference' ? '#' : 'x', from = kind === 'toc' ? 12 : 8;
              const samples = [];
              for (let i = 0; i < count; i++) {
                const t = performance.now();
                editor.view.dispatch({ changes: { from, insert: input }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
                samples.push(performance.now() - t);
              }
              samples.sort((a, b) => a - b);
              return { samples, medianMs: samples[Math.floor(count / 2)], maxMs: samples.at(-1), ...(count >= 20 ? { p95Ms: samples[Math.ceil(count * .95) - 1] } : {}) };
            }, { kind, size });
            assert.equal(await page.evaluate(() => editor.view.state.doc.length), value.length + result.samples.length);
            report.samples.push({ round, variant, size, kind, setupMs, ...result });
          }
        }
        // Ordinary scroll/selection and warm document switching keep their
        // full UI cost, including CodeMirror's DOM updates.
        const interaction = await page.evaluate(() => {
          const value = '# Start\n\n' + 'body **bold** and `code`\n\n'.repeat(3000), times = { selection: [], switch: [], scroll: [] };
          editor.setDocument({ value, notePath: 'warm.md' });
          for (let i = 0; i < 30; i++) {
            let t = performance.now(); editor.view.dispatch({ selection: { anchor: 15 + i } }); times.selection.push(performance.now() - t);
            t = performance.now(); editor.view.scrollDOM.scrollTop = i * 30; void editor.view.scrollDOM.scrollTop; times.scroll.push(performance.now() - t);
            t = performance.now(); editor.setDocument({ value, notePath: 'warm.md' }); times.switch.push(performance.now() - t);
          }
          return times;
        });
        report.samples.push({ round, variant, interaction });
        await page.close();
        console.log(JSON.stringify({ round, variant, completed: true }));
      }
    }
    for (const size of [4096, 128 * 1024, 1024 * 1024, 4 * 1024 * 1024]) for (const kind of ['plain', 'toc', 'math-reference']) {
      const select = variant => report.samples.filter(item => item.variant === variant && item.size === size && item.kind === kind);
      const before = median(select('baseline').map(item => item.medianMs)), after = median(select('current').map(item => item.medianMs));
      const loadBefore = median(select('baseline').map(item => item.setupMs)), loadAfter = median(select('current').map(item => item.setupMs));
      const bottleneck = size >= 128 * 1024 && kind !== 'plain';
      assert(after <= (bottleneck ? Math.max(2, before * .5) : Math.max(before * 1.1, before + 2)), kind + ' ' + size + ': ' + before + ' -> ' + after);
      if (kind === 'plain') {
        const oldP95 = median(select('baseline').map(item => item.p95Ms)), newP95 = median(select('current').map(item => item.p95Ms));
        assert(newP95 <= Math.max(oldP95 * 1.1, oldP95 + 2), 'ordinary input p95');
      }
      report.summary.push({ size, kind, beforeMs: before, afterMs: after, improvementPercent: before ? (1 - after / before) * 100 : null, loadBeforeMs: loadBefore, loadAfterMs: loadAfter });
    }
    for (const kind of ['selection', 'scroll', 'switch']) {
      const value = variant => median(report.samples.filter(item => item.variant === variant && item.interaction).map(item => median(item.interaction[kind])));
      const before = value('baseline'), after = value('current');
      assert(after <= Math.max(before * 1.1, before + 2), kind + ' regression');
      report.summary.push({ kind, beforeMs: before, afterMs: after });
    }
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, summary: report.summary }));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

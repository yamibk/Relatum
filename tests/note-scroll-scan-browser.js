'use strict';

// Actual production scanner, static assets and synthetic Markdown only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), rounds = process.argv.includes('--quick') ? 1 : 3;
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-scroll-scan-'));
const baselineRef = process.env.RELATUM_NOTE_SCAN_BASELINE || 'f071551';
const sources = { baseline: execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }), current: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') };
const instrument = source => source.replace('  function refreshVisibleBlockSpecs(previous, state, ranges) {', `
  function refreshVisibleBlockSpecs(...args) {
    const started = performance.now(), result = measuredRefresh(...args);
    if (window.__scans) __scans.push({ key: JSON.stringify(args[2]), known: args[0].length, ms: performance.now() - started });
    return result;
  }
  function measuredRefresh(previous, state, ranges) {`);
const html = variant => `<!doctype html><meta charset="utf-8"><base href="/${variant}/assets/">
<link rel="stylesheet" href="styles.css"><style>body{display:block;margin:0;font-family:system-ui;--text:#222;--bg:#fff}
.note-live-editor-host{width:960px;height:800px;margin:auto}</style><body class="start-page">
<div class="note-live-editor-host" id="host"></div><script src="markdown.js"></script><script src="markdown-table.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-live-editor.js"></script><script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('host'),{value:'',notePath:'synthetic.md'});</script>`;
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname, variant = name.split('/')[1];
  if (/^\/(baseline|current)\/$/.test(name)) { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name.replace(/^\/(baseline|current)/, '')));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(file.endsWith('note-live-editor.js') ? instrument(sources[variant]) : fs.readFileSync(file));
});
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  let browser;
  const report = { baselineRef, rounds, cases: [], errors: [] };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    for (let round = 0; round < rounds; round++) for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/');
      await page.waitForFunction(() => window.editor);
      const result = await page.evaluate(async () => {
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const sections = Array.from({ length: 6000 }, (_, index) => '## Section ' + index + '\n\nParagraph ' + index + ': '
          + 'Long paragraph with ordinary words and wrapping. '.repeat(10) + '\n\n| A | B |\n|---|---|\n| cell | content |\n\n');
        const value = sections.join(''); editor.setDocument({ value, notePath: 'synthetic.md' }); await pause(800);
        // Model a long note that has already been browsed at several positions.
        for (let index = 0; index < 30; index++) {
          editor.revealPosition(value.indexOf('## Section ' + Math.floor(index * 5999 / 29) + '\n')); await pause(60);
        }
        editor.revealPosition(value.indexOf('Paragraph 3000:')); await pause(1500);
        editor.cancelViewportRestore();
        const view = editor.view, area = view.scrollDOM;
        area.scrollTop += 40; await pause(300); window.__scans = [];
        for (let index = 0; index < 30; index++) { area.scrollTop += 1; await pause(65); }
        const scans = __scans; window.__scans = null;
        const unchanged = editor.snapshot().value === value;
        // Same viewport after an edit must still discover a newly inserted grid.
        const at = value.indexOf('Paragraph 3000:');
        view.dispatch({ changes: { from: at, insert: '| New | Grid |\n|---|---|\n| UniqueCell | visible |\n\n' }, userEvent: 'input.paste' });
        await pause(400);
        const editedTable = [...view.contentDOM.querySelectorAll('table')].some(table => table.textContent.includes('UniqueCell'));
        RelatumCodeMirror.undo(view); await pause(250);
        const undone = editor.snapshot().value === value;
        editor.setDocument({ value: '# Other\n\n| X | Y |\n|---|---|\n| ShortSentinel | ok |', notePath: 'other.md' }); await pause(250);
        const switched = [...view.contentDOM.querySelectorAll('table')].some(table => table.textContent.includes('ShortSentinel'));
        return { chars: value.length, scans, count: scans.length, unique: new Set(scans.map(item => item.key)).size,
          scanMs: scans.reduce((sum, item) => sum + item.ms, 0), known: Math.max(0, ...scans.map(item => item.known)),
          unchanged, editedTable, undone, switched, error: document.getElementById('host').dataset.livePreviewError || null };
      });
      assert(result.unchanged && result.editedTable && result.undone && result.switched, 'scan caching preserves content, editing, undo and document switching');
      assert.equal(result.error, null);
      if (variant === 'baseline') assert(result.count > 20 && result.known > 1000, 'the baseline exercises repeated scanning of a browsed long note');
      report.cases.push({ round, variant, ...result });
      console.log(JSON.stringify({ round, variant, count: result.count, unique: result.unique, scanMs: result.scanMs, known: result.known }));
      await page.close();
    }
    const baseline = report.cases.filter(item => item.variant === 'baseline'), current = report.cases.filter(item => item.variant === 'current');
    report.summary = { baselineCount: median(baseline.map(item => item.count)), currentCount: median(current.map(item => item.count)),
      baselineScanMs: median(baseline.map(item => item.scanMs)), currentScanMs: median(current.map(item => item.scanMs)) };
    assert(report.summary.currentCount <= report.summary.baselineCount * .3, 'small scrolling avoids at least 70% of repeated scans');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

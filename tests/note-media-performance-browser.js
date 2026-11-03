'use strict';

// Compare production code with HEAD using static assets and disposable notes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), rounds = process.argv.includes('--quick') ? 1 : 3;
const baselineRef = process.env.RELATUM_MEDIA_BASELINE_REF || 'b42d45f';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-media-perf-'));
const sources = {
  baseline: execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  current: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8'),
};
const instrument = source => source.replace('  function layoutFingerprint(source) {',
  '  function layoutFingerprint(source) { if (window.__metrics) __metrics.hashChars += source.length;')
  .replace('  window.RelatumNoteLiveSyntax = {',
    '  window.__mediaProbe = { scanBlockSpecs, createBlockLayoutMemory, layoutFingerprint, blockLayoutEffect };\n  window.RelatumNoteLiveSyntax = {');
const scripts = ['markdown-table.js', 'markdown.js', 'vendor/codemirror/relatum-codemirror.min.js', 'note-table-editor.js', 'note-media-frame.js', 'note-media.js', 'note-live-editor.js'];
const html = variant => '<!doctype html><meta charset="utf-8"><base href="/' + variant + '/assets/">'
  + '<link rel="stylesheet" href="styles.css"><style>body{margin:0;display:block}.note-live-editor-host{width:960px;height:850px;margin:auto}</style>'
  + '<body class="start-page" data-start-theme="light"><div id="host" class="note-live-editor-host"></div>'
  + scripts.map(name => '<script src="' + name + '"></script>').join('')
  + '<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById("host"),{value:"",notePath:"perf.md",imageUrl:()=>"/image.svg"});</script>';
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname, variant = name.split('/')[1];
  if (name === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#987b6e"/></svg>'); }
  if (!sources[variant]) return res.writeHead(404).end();
  if (name === '/' + variant + '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name.replace(/^\/(baseline|current)/, '')));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(file.endsWith('note-live-editor.js') ? instrument(sources[variant]) : fs.readFileSync(file));
});
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const report = { baselineRef, rounds, cases: [], errors: [] }; let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    for (let round = 0; round < rounds; round++) for (const chars of [2000, 200000]) for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      page.on('pageerror', error => report.errors.push(error.stack));
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/');
      await page.waitForFunction(() => window.editor);
      const result = await page.evaluate(async chars => {
        const CM = RelatumCodeMirror, probe = __mediaProbe;
        const pause = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const text = Array.from({ length: Math.ceil(chars / 500) }, (_, i) => 'line ' + i + ' ' + 'plain description '.repeat(28)).join('\n');
        const source = 'before\n\n> [!media]\n> ![image|200](image.svg)\n>\n' + text.split('\n').map(row => '> ' + row).join('\n') + '\n\nafter';
        editor.setDocument({ value: source, notePath: 'perf.md' });
        await pause(); await pause();
        const md = MarkdownMini, parse = md.parseMediaBlock;
        let parses = 0; md.parseMediaBlock = function(...args) { parses++; return parse.apply(this, args); };
        try {
          const view = editor.view, specs = probe.scanBlockSpecs(view.state, 0, source.length);
          parses = 0;
          const scanStart = performance.now();
          let next;
          for (let i = 0; i < 30; i++) next = probe.scanBlockSpecs(view.state, 0, source.length, specs);
          const scans = { parses, ms: performance.now() - scanStart };
          if (JSON.stringify(next) !== JSON.stringify(specs)) throw Error('Unchanged scans differ');
          const memory = probe.createBlockLayoutMemory(), spec = specs.find(spec => spec.kind === 'media');
          window.__metrics = { hashChars: 0 };
          const hashStart = performance.now();
          let key;
          for (let i = 0; i < 100; i++) key = memory.key(spec, 'perf.md', 'wide');
          const hashes = { ...__metrics, ms: performance.now() - hashStart };
          window.__metrics = null;
          const expected = (source, context, path, signature) => probe.layoutFingerprint(path) + ':' + probe.layoutFingerprint(signature) + ':media:' + probe.layoutFingerprint(source) + ':' + probe.layoutFingerprint(context || '');
          if (key !== expected(spec.source, spec.calloutContext, 'perf.md', 'wide')) throw Error('Cache key changed');
          if (memory.key({ ...spec, source: spec.source + ' edit' }, 'perf.md', 'wide') === key) throw Error('Content key did not change');
          if (memory.key(spec, 'other.md', 'wide') === key || memory.key(spec, 'perf.md', 'narrow') === key) throw Error('Layout key did not change');
          memory.clear();
          if (memory.key(spec, 'perf.md', 'wide') !== key) throw Error('Clear changed key semantics');
          const root = document.querySelector('.note-media'), surface = root.__noteMedia;
          surface.open(); await pause(); await pause();
          const input = surface.input, dispatch = view.dispatch; let layouts = 0;
          view.dispatch = function(...args) { for (const arg of args) for (const effect of arg.effects ? Array.isArray(arg.effects) ? arg.effects : [arg.effects] : []) if (effect.is(probe.blockLayoutEffect)) layouts++; return dispatch.apply(this, args); };
          parses = 0; window.__metrics = { hashChars: 0 };
          const inputStart = performance.now();
          for (let i = 0; i < 20; i++) {
            input.dispatch({ changes: { from: 10, insert: 'a' }, selection: CM.EditorSelection.cursor(11), userEvent: 'input.type' });
            await pause();
          }
          const inputs = { parses, layouts, ...__metrics, ms: performance.now() - inputStart };
          window.__metrics = null; view.dispatch = dispatch;
          if (!editor.snapshot().value.includes('a'.repeat(20))) throw Error('Input was lost');
          let undoCount = 0;
          while (editor.snapshot().value !== source && undoCount < 20) { surface.history(false); undoCount++; }
          await pause();
          if (editor.snapshot().value !== source) throw Error('Undo changed source');
          for (let i = 0; i < undoCount; i++) surface.history(true);
          await pause();
          if (!editor.snapshot().value.includes('a'.repeat(20))) throw Error('Redo lost source');
          editor.destroy();
          return { chars: source.length, scans, hashes, inputs };
        } finally { md.parseMediaBlock = parse; window.__metrics = null; }
      }, chars);
      report.cases.push({ round, variant, ...result });
      console.log(JSON.stringify({ round, variant, ...result })); await page.close();
    }
    report.summary = [2000, 200000].map((size, index) => {
      const cases = report.cases.filter(item => (item.chars > 100000 ? 1 : 0) === index);
      const pick = (variant, group, metric) => median(cases.filter(item => item.variant === variant).map(item => item[group][metric]));
      return { size, baseline: { parse: pick('baseline', 'scans', 'parses'), hashChars: pick('baseline', 'hashes', 'hashChars'), layouts: pick('baseline', 'inputs', 'layouts') },
        current: { parse: pick('current', 'scans', 'parses'), hashChars: pick('current', 'hashes', 'hashChars'), layouts: pick('current', 'inputs', 'layouts') } };
    });
    for (const sample of report.summary) {
      assert.equal(sample.current.parse, 0, 'unchanged scans reuse the media model');
      assert(sample.current.hashChars < sample.baseline.hashChars * .02, 'repeated keys avoid at least 98% of source hashing');
      assert(sample.current.layouts <= sample.baseline.layouts * .6, 'input uses one shared layout invalidation path');
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve)); console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

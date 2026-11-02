'use strict';

// Static assets and synthetic Markdown only; no note library or app service.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), quick = process.argv.includes('--quick'), rounds = quick ? 1 : 3;
const baselineRef = process.env.RELATUM_NOTE_HEADING_BASELINE || '5037fa0';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-heading-'));
const sources = {
  baseline: execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  current: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8'),
};
const needles = { baseline: 'code.from < offset + range.to', current: 'inlineCode[middle].to <= from' };
for (const variant of Object.keys(sources)) assert(sources[variant].includes(needles[variant]), variant + ' probe is available');
const html = (variant, count) => `<!doctype html><meta charset="utf-8"><base href="/${variant}/assets/">
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="markdown-table.js"></script>
<script src="markdown.js"></script><script src="note-live-editor.js${count ? '?count=1' : ''}"></script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), variant = url.pathname.split('/')[1];
  if (!sources[variant]) { res.writeHead(404).end(); return; }
  if (url.pathname === '/' + variant + '/') {
    res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant, url.searchParams.has('count')));
  }
  const file = path.resolve(repo, '.' + decodeURIComponent(url.pathname.replace(/^\/(baseline|current)/, '')));
  if (!file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  let content = file.endsWith('note-live-editor.js') ? sources[variant] : fs.readFileSync(file);
  if (file.endsWith('note-live-editor.js') && url.searchParams.has('count')) content = content.replace(needles[variant], variant === 'baseline'
    ? '(window.__codeProbes++, code.from) < offset + range.to' : '(window.__codeProbes++, inlineCode[middle].to) <= from');
  res.end(content);
});
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const paragraph = (index, mixed) => 'Paragraph ' + index + ' `code` and ' + (mixed ? '$x%%y$ and $a <!-- b --> c$.' : '$x+y$ and ordinary words.') + '\n\n';
const fixture = (count, mixed = true) => '# First\n\n' + Array.from({ length: count }, (_, index) => paragraph(index, mixed)).join('') + '## Last';
function semanticCases() {
  const code = '`', fence = code.repeat(3);
  const pieces = ['ordinary text', code + '$x%%y$' + code, '$x%%y$', '$a <!-- b --> c$',
    code + 'literal %% <!-- $x$ -->' + code, '%% hidden\n# Hidden\n%%', '<!-- hidden\n# Hidden\n-->',
    code + 'multi\n$x%%y$\nline' + code, '# Visible $x%%y$ ' + code + 'code' + code,
    '## Visible $a <!-- b --> c$ ' + code + 'literal' + code, '# ' + code + '$x%%y$' + code,
    '$' + code + 'x%%y' + code + '$', code + 'left $x' + code + ' %% comment\n# Hidden\n%%',
    '> # Quote\n> ' + code + '$x%%y$' + code, '- item\n  # Nested',
    '| A | B |\n|---|---|\n| ' + code + '$x%%y$' + code + ' | $z$ |',
    fence + 'md\n# Code\n$x%%y$\n' + fence, '$$\n# Formula\n$$', '\\[\n# Formula\n\\]',
    'Title ' + code + 'code' + code + '\n---', '# **Bold** [[Target|Alias]]', '<!-- unclosed', '%% unclosed'];
  const cases = pieces.map(source => ({ source: '# Start\n\n' + source + '\n\n## End' }));
  // Deterministic mixtures exercise ordered, adjacent and multiline spans.
  let seed = 317;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let i = 0; i < 160; i++) {
    let source = i % 4 === 0 ? '---\ntitle: "`%%`"\n---\n\n' : '';
    for (let n = 0; n < 12; n++) source += pieces[random(pieces.length)] + (random(2) ? '\n\n' : '\n');
    cases.push({ source: source + '\n\n## Last', fragment: i % 3 === 0 });
  }
  cases.push({ source: fixture(1000) });
  return cases;
}
(async () => {
  const report = { baselineRef, rounds, semantics: 0, probes: [], samples: [], summary: [], errors: [] };
  let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const open = async (variant, count = false) => {
      const page = await browser.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/' + (count ? '?count=1' : ''));
      await page.waitForFunction(() => window.RelatumNoteLiveSyntax); return page;
    };
    const cases = semanticCases(), snapshots = {};
    for (const variant of ['baseline', 'current']) {
      const page = await open(variant);
      snapshots[variant] = await page.evaluate(cases => cases.map(({ source, fragment }) => {
        const blocks = [], headings = RelatumNoteLiveSyntax.noteHeadingsFromString(source, { blocks, fragment });
        return { blocks, headings };
      }), cases);
      await page.close();
    }
    assert.deepEqual(snapshots.current, snapshots.baseline, 'heading labels, offsets and protected blocks match the baseline');
    report.semantics = cases.length;
    for (const count of [1000, 4000, 8000]) for (const variant of ['baseline', 'current']) {
      const page = await open(variant, true);
      const probes = await page.evaluate(source => {
        window.__codeProbes = 0;
        const headings = RelatumNoteLiveSyntax.noteHeadingsFromString(source);
        return { visits: __codeProbes, labels: headings.map(item => item.label) };
      }, fixture(count));
      assert.deepEqual(probes.labels, ['First', 'Last']);
      report.probes.push({ variant, count, visits: probes.visits }); await page.close();
    }
    for (const count of [1000, 4000, 8000]) {
      const visits = variant => report.probes.find(item => item.variant === variant && item.count === count).visits;
      assert(visits('current') < visits('baseline') * .03, 'code overlap checks avoid a full list scan');
      assert(visits('current') <= count * 2 * (Math.ceil(Math.log2(count)) + 1), 'each formula uses logarithmic lookup');
    }
    const sizes = quick ? [4000] : [1000, 4000, 8000];
    const benchmarks = sizes.map(count => ({ count, mixed: true })).concat({ count: 8000, mixed: false });
    for (let round = 0; round < rounds; round++) for (const { count, mixed } of benchmarks) {
      for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const page = await open(variant);
        await page.evaluate(source => { for (let i = 0; i < 3; i++) RelatumNoteLiveSyntax.noteHeadingsFromString(source); }, fixture(200));
        const source = fixture(count, mixed);
        const sample = await page.evaluate(source => {
          const start = performance.now(), headings = RelatumNoteLiveSyntax.noteHeadingsFromString(source);
          return { ms: performance.now() - start, labels: headings.map(item => item.label) };
        }, source);
        assert.deepEqual(sample.labels, ['First', 'Last']);
        report.samples.push({ round, variant, count, mixed, chars: source.length, ms: sample.ms });
        console.log(JSON.stringify(report.samples[report.samples.length - 1])); await page.close();
      }
    }
    for (const { count, mixed } of benchmarks) {
      const time = variant => median(report.samples.filter(item => item.variant === variant && item.count === count && item.mixed === mixed).map(item => item.ms));
      const summary = { count, mixed, baselineMs: time('baseline'), currentMs: time('current') };
      report.summary.push(summary);
      if (mixed && count >= 4000) assert(summary.currentMs < summary.baselineMs * .7, 'mixed long-note heading scanning measurably improves');
      if (!mixed) assert(summary.currentMs <= Math.max(summary.baselineMs * 1.2, summary.baselineMs + 3), 'ordinary code text does not materially regress');
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

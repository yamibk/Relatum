'use strict';

// Static assets and synthetic notes only. No application server or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), quick = process.argv.includes('--quick'), rounds = quick ? 1 : 3;
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-inline-candidates-'));
const baselineRef = process.env.RELATUM_NOTE_INLINE_BASELINE || 'e5d3a28';
const sources = { baseline: execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }), current: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') };
const signature = '  function createInlineDecorations(view, blockField, notePath, options, mathCache = createMathHighlightCache()) {';
const baselineInline = sources.baseline.slice(sources.baseline.indexOf(signature), sources.baseline.indexOf('  function atomicDecorationSubset('))
  .replace('function createInlineDecorations(', 'function baselineInlineDecorations(');
assert(baselineInline.startsWith('  function baselineInlineDecorations('), 'baseline inline renderer is available');
function instrument(source) {
  assert(source.includes(signature));
  return source.replace(signature, `  function createInlineDecorations(...args) {
    const start = performance.now(), result = measuredInlineDecorations(...args);
    if (window.__inlineStats) __inlineStats.push({ ms: performance.now() - start,
      known: args[0].state.field(args[1]).specs.length, segments: args[0].visibleRanges.length });
    return result;
  }
  function measuredInlineDecorations(view, blockField, notePath, options, mathCache = createMathHighlightCache()) {`)
    .replace('  function atomicDecorationSubset(', baselineInline + '\n  function atomicDecorationSubset(')
    .replace('window.RelatumNoteLiveEditor = { create, renderMarkdown, typesetMath };',
      'window.RelatumNoteLiveEditor = { create, renderMarkdown, typesetMath }; window.__inlineTest = {createInlineDecorations, baselineInlineDecorations, createBlockField, focusEffect, calloutFoldEffect};');
}
const html = variant => `<!doctype html><meta charset="utf-8"><base href="/${variant}/assets/">
<link rel="stylesheet" href="styles.css"><style>body{display:block;margin:0;font-family:system-ui;--text:#222;--bg:#fff}
.note-live-editor-host{width:960px;height:800px;margin:auto}</style><body class="start-page" data-start-theme="light">
<div id="host" class="note-live-editor-host"></div><script src="markdown.js"></script><script src="markdown-table.js"></script>
<script src="vendor/codemirror/relatum-codemirror.min.js"></script><script src="note-table-editor.js"></script>
<script src="note-media-frame.js"></script><script src="note-live-editor.js"></script>
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('host'),{value:'',notePath:'synthetic.md'});</script>`;
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname, variant = name.split('/')[1];
  if (/^\/(baseline|current)\/$/.test(name)) { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name.replace(/^\/(baseline|current)/, '')));
  if (!sources[variant] || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(file.endsWith('note-live-editor.js') ? instrument(sources[variant]) : fs.readFileSync(file));
});
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function semantics(page) {
  return page.evaluate(() => {
    const { EditorState, EditorSelection, markdown, markdownLanguage } = RelatumCodeMirror;
    const { createInlineDecorations, baselineInlineDecorations, createBlockField, focusEffect, calloutFoldEffect } = __inlineTest;
    const source = ['# Title', '', '> [!blue]+ Outer', '> visible body **bold**', '> > [!tip]- Inner', '> > folded body',
      '> > $$x^2$$', '>', '> $$', '> \\frac{a}{b}', '> +c', '> $$', '> ![alt](image.png)', '> tail', '',
      '| A | B |', '|---|---|', '| value | table |', '', '![](other.png)', '', '$$', 'x+y', 'z^2', '$$', '',
      '> [!note] Named', '> ```js', '> const x = 1;', '> ```', '> tail', '', '> ordinary quote', '',
      '- **list** and $z$ and [link](target.md)', '', 'end'].join('\n');
    const coordinator = { folds: new Map(), records: [] }, options = { coordinator };
    const field = createBlockField(() => 'semantic.md', options, coordinator, { pending: () => false });
    let state = EditorState.create({ doc: source, extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage }), field] });
    const snapshot = decorations => {
      const ranges = [];
      decorations.between(0, source.length, (from, to, value) => {
        const { widget, ...spec } = value.spec;
        const primitive = widget ? Object.fromEntries(Object.entries(widget).filter(([key, item]) =>
          key !== 'coordinator' && (item === null || ['string', 'number', 'boolean'].includes(typeof item)))) : null;
        ranges.push([from, to, spec, widget?.constructor.name, primitive, widget?.spec?.source]);
      });
      return JSON.stringify(ranges);
    };
    const positions = [0, source.indexOf('Outer'), source.indexOf('visible body'), source.indexOf('Inner'), source.indexOf('folded body'),
      source.indexOf('\\frac'), source.indexOf('> tail'), source.indexOf('| A'), source.indexOf('value'), source.indexOf('other.png'),
      source.indexOf('x+y'), source.indexOf('z^2'), source.indexOf('Named'), source.indexOf('ordinary quote'), source.length];
    let comparisons = 0, splitRanges = 0;
    const compare = visibleRanges => {
      const view = { state, visibleRanges, hasFocus: state.field(field).focused, composing: false };
      const actual = snapshot(createInlineDecorations(view, field, () => 'semantic.md', options));
      const expected = snapshot(baselineInlineDecorations(view, field, () => 'semantic.md', options));
      if (actual !== expected) throw new Error('Inline decorations changed at ' + JSON.stringify({ visibleRanges, selection: state.selection.toJSON() }));
      comparisons++; if (visibleRanges.length > 1) splitRanges++;
    };
    for (const focused of [false, true]) for (const position of positions) for (const head of [position, source.length]) {
      state = state.update({ selection: { anchor: position, head }, effects: focusEffect.of(focused) }).state;
      compare([{ from: 0, to: source.length }]);
      for (const at of positions) compare([{ from: at, to: at }]);
      compare(positions.slice(1, -1).map(at => ({ from: at, to: at })));
    }
    const callouts = state.field(field).specs.filter(spec => spec.kind === 'callout');
    for (const spec of callouts) for (const collapsed of [true, false]) {
      state = state.update({ effects: calloutFoldEffect.of({ id: spec.id, collapsed }) }).state;
      compare(positions.map(at => ({ from: at, to: at })));
    }
    state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(positions[2]), EditorSelection.cursor(positions[10])]) }).state;
    compare(positions.map(at => ({ from: at, to: at })));
    return { comparisons, splitRanges, blocks: state.field(field).specs.length, callouts: callouts.length };
  });
}
async function benchmark(page, bytes) {
  return page.evaluate(async bytes => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const percentile = values => values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length * .95)] : null;
    let value = '', count = 0;
    while (value.length < bytes) {
      value += '## Section ' + count + '\n\nParagraph ' + count + ': ' + 'Long paragraph with ordinary words and wrapping. '.repeat(10)
        + '\n\n| A | B |\n|---|---|\n| cell | content |\n\n'; count++;
    }
    value = value.slice(0, bytes);
    editor.setDocument({ value, notePath: 'synthetic.md' }); await pause(800);
    const at = value.indexOf('Paragraph ' + Math.floor(count / 2) + ':') + 15;
    const view = editor.view;
    const measure = async phase => {
      editor.revealPosition(at); await pause(1100); editor.cancelViewportRestore(); view.focus();
      for (let index = 0; index < 12; index++) view.dispatch({ selection: { anchor: at + index % 10 } });
      await pause(200);
      const result = { phase };
      for (const action of ['caret', 'input', 'scroll']) {
        window.__inlineStats = []; const transactions = [];
        for (let index = 0; index < (action === 'scroll' ? 30 : 60); index++) {
          const start = performance.now();
          if (action === 'caret') view.dispatch({ selection: { anchor: at + index % 20 } });
          else if (action === 'input') view.dispatch({ changes: { from: at, to: at + (index % 2), insert: index % 2 ? '' : 'x' },
            selection: { anchor: at }, userEvent: 'input.type' });
          else view.scrollDOM.scrollTop += index < 15 ? 3 : -3;
          if (action !== 'scroll') transactions.push(performance.now() - start);
          await pause(action === 'scroll' ? 32 : 12);
        }
        const stats = __inlineStats; window.__inlineStats = null;
        result[action] = { stats, transactions, inlineP95: percentile(stats.map(item => item.ms)), transactionP95: percentile(transactions),
          known: Math.max(0, ...stats.map(item => item.known)), segments: Math.max(0, ...stats.map(item => item.segments)) };
      }
      if (editor.snapshot().value !== value) throw new Error('Benchmark changed Markdown');
      return result;
    };
    const before = await measure('first');
    for (let index = 0; index < 30; index++) {
      editor.revealPosition(value.indexOf('## Section ' + Math.floor(index * (count - 2) / 29) + '\n')); await pause(65);
    }
    await pause(500);
    const after = await measure('browsed');
    return { chars: value.length, before, after, nodes: view.contentDOM.querySelectorAll('*').length };
  }, bytes);
}
(async () => {
  let browser;
  const report = { baselineRef, rounds, semantics: null, cases: [], errors: [] };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.RELATUM_EDGE_PATH ? { executablePath: process.env.RELATUM_EDGE_PATH } : {}) });
    const open = async variant => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto('http://127.0.0.1:' + server.address().port + '/' + variant + '/');
      await page.waitForFunction(() => window.editor); return page;
    };
    const semanticPage = await open('current'); report.semantics = await semantics(semanticPage); await semanticPage.close();
    console.log('Decoration comparison: ' + JSON.stringify(report.semantics));
    for (let round = 0; round < rounds; round++) for (const bytes of quick ? [400 * 1024] : [400 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
      for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const page = await open(variant), result = await benchmark(page, bytes);
        report.cases.push({ round, variant, bytes, ...result });
        console.log(JSON.stringify({ round, variant, bytes, first: result.before.caret.inlineP95, browsed: result.after.caret.inlineP95,
          input: result.after.input.transactionP95, known: result.after.caret.known, nodes: result.nodes }));
        await page.close();
      }
    }
    report.summary = [];
    for (const bytes of [...new Set(report.cases.map(item => item.bytes))]) {
      const group = variant => report.cases.filter(item => item.bytes === bytes && item.variant === variant);
      const baseline = group('baseline'), current = group('current');
      const summary = { bytes, baselineInlineP95: median(baseline.map(item => item.after.caret.inlineP95)),
        currentInlineP95: median(current.map(item => item.after.caret.inlineP95)),
        baselineInputP95: median(baseline.map(item => item.after.input.transactionP95)),
        currentInputP95: median(current.map(item => item.after.input.transactionP95)) };
      report.summary.push(summary);
      assert(summary.currentInlineP95 <= summary.baselineInlineP95 * .7, 'browsed-note inline P95 improves by at least 30%');
      assert(summary.currentInputP95 <= Math.max(summary.baselineInputP95 * 1.2, summary.baselineInputP95 + .5), 'input transactions do not materially regress');
      assert(current.every(item => item.nodes < 1000), 'the editor retains virtual DOM');
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

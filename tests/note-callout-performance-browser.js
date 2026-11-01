'use strict';

// Static assets, synthetic Markdown and disposable browser contexts only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), quick = process.argv.includes('--quick'), rounds = quick ? 1 : 3;
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-note-callout-performance-'));
const baselineRef = process.env.RELATUM_NOTE_CALLOUT_BASELINE || '30ff695';
const sources = { baseline: execFileSync('git', ['show', baselineRef + ':assets/note-live-editor.js'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }), current: fs.readFileSync(path.join(repo, 'assets/note-live-editor.js'), 'utf8') };
function extract(from, to) {
  const start = sources.baseline.indexOf(from), end = sources.baseline.indexOf(to, start);
  assert(start >= 0 && end > start, 'baseline probe is available: ' + from);
  return sources.baseline.slice(start, end);
}
const baselineModel = extract('  const calloutTrees =', '  // Each native line paints')
  .replaceAll('calloutTree', 'baselineCalloutTree').replaceAll('calloutLayout', 'baselineCalloutLayout')
  .replaceAll('calloutCollapsed', 'baselineCalloutCollapsed');
const baselineFold = extract('  function calloutCollapsed(', '  function bindLiveFold(').replace('function calloutCollapsed(', 'function baselineCalloutCollapsed(');
const baselineInline = extract('  function createInlineDecorations(', '  function atomicDecorationSubset(')
  .replace('function createInlineDecorations(', 'function baselineInlineDecorations(').replaceAll('calloutLayout(', 'baselineCalloutLayout(');
function instrument(source) {
  return source.replace('  function createInlineDecorations(view, blockField, notePath, options, mathCache = createMathHighlightCache()) {',
    `  function createInlineDecorations(...args) {
      const start = performance.now(), result = measuredInlineDecorations(...args);
      if (window.__calloutTimes) __calloutTimes.push(performance.now() - start);
      return result;
    }
    function measuredInlineDecorations(view, blockField, notePath, options, mathCache = createMathHighlightCache()) {`)
    .replace('  function atomicDecorationSubset(', baselineModel + baselineFold + baselineInline + '\n  function atomicDecorationSubset(')
    .replace('window.RelatumNoteLiveEditor = { create, renderMarkdown, typesetMath };',
      'window.RelatumNoteLiveEditor = { create, renderMarkdown, typesetMath }; window.__calloutTest = {createInlineDecorations, baselineInlineDecorations, createBlockField, focusEffect, calloutFoldEffect};');
}
const html = variant => `<!doctype html><meta charset="utf-8"><base href="/${variant}/assets/">
<link rel="stylesheet" href="styles.css"><style>body{display:block;margin:0;font-family:system-ui;--text:#222;--bg:#fff}
.note-live-editor-host{width:960px;height:800px;margin:auto}</style><body class="start-page" data-start-theme="light">
<div id="host" class="note-live-editor-host"></div>${['markdown.js', 'markdown-table.js', 'vendor/codemirror/relatum-codemirror.min.js',
  'note-table-editor.js', 'note-media-frame.js', 'note-live-editor.js'].map(name => '<script src="' + name + '"></script>').join('')}
<script>window.editor=RelatumNoteLiveEditor.create(document.getElementById('host'),{value:'',notePath:'synthetic.md'});</script>`;
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname, variant = name.split('/')[1];
  if (/^\/(baseline|current)\/$/.test(name)) { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html(variant)); }
  const file = path.resolve(repo, '.' + decodeURIComponent(name.replace(/^\/(baseline|current)/, '')));
  if (!sources[variant] || !file.startsWith(path.join(repo, 'assets') + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(file.endsWith('note-live-editor.js') ? instrument(sources[variant]) : fs.readFileSync(file));
});
async function semantics(page) {
  return page.evaluate(() => {
    const { EditorState, EditorSelection, markdown, markdownLanguage } = RelatumCodeMirror;
    const { createInlineDecorations, baselineInlineDecorations, createBlockField, focusEffect, calloutFoldEffect } = __calloutTest;
    const source = ['# Title', '', '> [!blue]', '> outer body', '> > [!tip]- Inner', '> > hidden body', '> tail', '',
      '> [!white]', '> white body **bold**', '', '> [!unknown]+ Custom title', '> Body $x$ with `code`', '> > [!cyan]', '> > child', '',
      '| A | B |', '|---|---|', '| cell | value |', '', '> [!note]', '> $$', '> x+y', '> $$', '> ![](image.png)', '', 'after'].join('\n');
    const coordinator = { folds: new Map(), records: [] }, options = { coordinator };
    const field = createBlockField(() => 'semantic.md', options, coordinator, { pending: () => false });
    let state = EditorState.create({ doc: source, extensions: [EditorState.allowMultipleSelections.of(true), markdown({ base: markdownLanguage }), field] });
    const positions = [0, ...['blue', 'outer body', 'Inner', 'hidden body', 'tail', 'white', 'white body', 'Custom title', 'Body $', 'cyan', 'child', '| A', 'x+y', 'image.png', 'after'].map(text => source.indexOf(text)), source.length];
    const snapshot = set => {
      const records = [];
      set.between(0, state.doc.length, (from, to, value) => {
        const { widget, ...spec } = value.spec;
        const primitive = widget ? Object.fromEntries(Object.entries(widget).filter(([key, item]) => key !== 'coordinator'
          && (item === null || ['string', 'number', 'boolean'].includes(typeof item)))) : null;
        records.push([from, to, spec, widget?.constructor.name, primitive, widget?.spec?.source]);
      });
      return JSON.stringify(records);
    };
    let comparisons = 0;
    const compare = (visibleRanges, composing = false) => {
      const view = { state, visibleRanges, hasFocus: state.field(field).focused, composing };
      if (snapshot(createInlineDecorations(view, field, () => 'semantic.md', options))
          !== snapshot(baselineInlineDecorations(view, field, () => 'semantic.md', options))) throw new Error('Callout projection changed at ' + JSON.stringify({ visibleRanges, selection: state.selection.toJSON(), composing }));
      comparisons++;
    };
    for (const focused of [false, true]) for (const composing of [false, true]) for (const position of positions) {
      state = state.update({ selection: { anchor: position }, effects: focusEffect.of(focused) }).state;
      compare([{ from: 0, to: state.doc.length }], composing);
      compare(positions.map(at => ({ from: at, to: at })), composing);
      for (const at of positions) compare([{ from: at, to: at }], composing);
    }
    for (const spec of state.field(field).specs.filter(spec => spec.kind === 'callout')) for (const collapsed of [true, false]) {
      state = state.update({ effects: calloutFoldEffect.of({ id: spec.id, collapsed }) }).state;
      compare([{ from: 0, to: state.doc.length }]);
    }
    state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(positions[2]), EditorSelection.range(positions[5], positions[9])]) }).state;
    compare(positions.map(at => ({ from: at, to: at })));
    for (const [before, after] of [['blue', 'warning'], ['Custom title', '改过的标题'], ['[!tip]-', '[!tip]+'], ['outer body', '编辑后的正文']]) {
      const at = state.doc.toString().indexOf(before);
      state = state.update({ changes: { from: at, to: at + before.length, insert: after } }).state;
      compare([{ from: 0, to: state.doc.length }]);
    }
    return { comparisons };
  });
}
async function benchmark(page, bytes, kind) {
  return page.evaluate(async ({ bytes, kind }) => {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const p95 = values => values.length ? values.slice().sort((a, b) => a - b)[Math.floor(values.length * .95)] : null;
    let value = '', count = 0;
    while (value.length < bytes) {
      value += '## Section ' + count + '\n\nParagraph ' + count + ': ' + 'Long paragraph with ordinary words and wrapping. '.repeat(10) + '\n\n';
      value += kind === 'table' ? '| A | B |\n|---|---|\n| cell | content |\n\n' : count % 3 === 0
        ? '> [!note] Title\n> Body **bold**.\n\n' : count % 3 === 1 ? '> [!blue]\n> Color body.\n\n'
          : '> [!warning]+ Outer\n> Body.\n> > [!tip]- Inner\n> > Folded body.\n> Tail.\n\n';
      count++;
    }
    value = value.slice(0, bytes);
    editor.setDocument({ value, notePath: 'synthetic.md' }); await pause(800);
    const at = value.indexOf('Paragraph ' + Math.floor(count / 2) + ':') + 15, view = editor.view;
    const measure = async phase => {
      editor.revealPosition(at); await pause(1000); editor.cancelViewportRestore(); view.focus();
      for (let i = 0; i < 12; i++) view.dispatch({ selection: { anchor: at + i % 10 } });
      await pause(200);
      const result = { phase };
      for (const action of ['caret', 'input', 'scroll']) {
        window.__calloutTimes = []; const transactions = [];
        for (let i = 0; i < (action === 'scroll' ? 30 : 60); i++) {
          const start = performance.now();
          if (action === 'caret') view.dispatch({ selection: { anchor: at + i % 20 } });
          else if (action === 'input') view.dispatch({ changes: { from: at, to: at + i % 2, insert: i % 2 ? '' : 'x' }, selection: { anchor: at }, userEvent: 'input.type' });
          else view.scrollDOM.scrollTop += i < 15 ? 3 : -3;
          if (action !== 'scroll') transactions.push(performance.now() - start);
          await pause(action === 'scroll' ? 32 : 12);
        }
        const samples = __calloutTimes; window.__calloutTimes = null;
        result[action] = { samples, transactions, inlineP95: p95(samples), transactionP95: p95(transactions) };
      }
      const original = MarkdownMini.noteBlock; let calls = 0;
      MarkdownMini.noteBlock = (...args) => { calls++; return original(...args); };
      try { for (let i = 0; i < 20; i++) view.dispatch({ selection: { anchor: at + i % 10 } }); }
      finally { MarkdownMini.noteBlock = original; }
      result.headerBuilds = calls;
      if (editor.snapshot().value !== value) throw new Error('Benchmark changed Markdown');
      return result;
    };
    const before = await measure('first');
    for (let i = 0; i < 30; i++) { editor.revealPosition(value.indexOf('## Section ' + Math.floor(i * (count - 2) / 29) + '\n')); await pause(65); }
    await pause(500);
    const after = await measure('browsed');
    return { chars: value.length, before, after, nodes: view.contentDOM.querySelectorAll('*').length };
  }, { bytes, kind });
}
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  let browser;
  const report = { baselineRef, rounds, semantics: null, cases: [], summary: [], errors: [] };
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
    const cases = (quick ? [400 * 1024] : [400 * 1024, 1024 * 1024, 4 * 1024 * 1024]).map(bytes => ({ bytes, kind: 'callout' }));
    if (!quick) cases.push({ bytes: 4 * 1024 * 1024, kind: 'table' });
    for (let round = 0; round < rounds; round++) for (const { bytes, kind } of cases) {
      for (const variant of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const page = await open(variant), result = await benchmark(page, bytes, kind);
        report.cases.push({ round, variant, bytes, kind, ...result });
        console.log(JSON.stringify({ round, variant, bytes, kind, inline: result.after.input.inlineP95, input: result.after.input.transactionP95, builds: result.after.headerBuilds, nodes: result.nodes }));
        await page.close();
      }
    }
    for (const { bytes, kind } of cases) {
      const group = variant => report.cases.filter(item => item.variant === variant && item.bytes === bytes && item.kind === kind);
      const baseline = group('baseline'), current = group('current');
      const summary = { bytes, kind, baselineInlineP95: median(baseline.map(item => item.after.input.inlineP95)), currentInlineP95: median(current.map(item => item.after.input.inlineP95)),
        baselineInputP95: median(baseline.map(item => item.after.input.transactionP95)), currentInputP95: median(current.map(item => item.after.input.transactionP95)),
        baselineHeaderBuilds: median(baseline.map(item => item.after.headerBuilds)), currentHeaderBuilds: median(current.map(item => item.after.headerBuilds)) };
      report.summary.push(summary);
      if (kind === 'callout') assert(summary.currentHeaderBuilds < summary.baselineHeaderBuilds * .05, 'caret movement avoids rebuilding screen-external header presentation');
      assert(summary.currentInputP95 <= Math.max(summary.baselineInputP95 * 1.2, summary.baselineInputP95 + 1), 'input transactions do not materially regress');
      assert(current.every(item => item.nodes < 1200), 'the editor retains virtual DOM');
    }
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
